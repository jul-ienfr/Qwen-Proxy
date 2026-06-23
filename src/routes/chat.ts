import type { Context } from 'hono';
import crypto from 'crypto';
import { createQwenStream, RetryableQwenStreamError } from '../services/qwen.js';
import type { OpenAIRequest } from '../utils/types.js';
import { getModelContextWindow } from '../core/model-registry.js'
import { truncateMessages, estimateTokenCount } from '../utils/context-truncation.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';
import { registerStream, removeStream, getStream } from '../core/stream-registry.js';
import { metrics } from '../core/metrics.js'
import { modelMapper } from '../core/model-mapper.js'
import { requestLogger, RequestTimer } from '../core/request-logger.js'
import { getDebugLogger } from '../core/debug-logger.js'
import {
  getForcedToolName,
  getRecentToolNames,
  selectCandidateTools,
  buildCompactToolManifest,
  buildToolCallContract,
} from './tool-handler.js';
import { handleStreamingResponse, handleNonStreamingResponse } from './stream-handler.js';
import { resolveSession, buildSessionContext, updateSessionState as updateSessionStateShared, releaseSessionFlight as releaseSessionFlightShared } from './request-executor.js';
import { getPredictionCacheKey, cacheStreamingResponse, getCachedStreamingChunks, createReplayStream } from '../cache/prediction-cache.js';
import { cache } from '../cache/memory-cache.js';

function getCacheKey(prompt: string, model: string, thinking: boolean, thinkingEffort: string): string {
  return `${model}:${thinking}:${thinkingEffort}:${prompt}`.slice(0, 64);
}

export { getIncrementalDelta } from './sse-parser.js';
export type { DeltaResult } from './sse-parser.js';

export async function chatCompletions(c: Context) {
  const startTime = Date.now();
  const timer = new RequestTimer();
  let body: OpenAIRequest;
  let bodyAny: any;
  const dbg = getDebugLogger();
  let activeSession: import('../core/session-manager.js').ChatSession | null = null;

  const releaseMySession = () => {
    releaseSessionFlightShared(activeSession);
    activeSession = null;
  };

  try {
    body = await c.req.json();
    bodyAny = body as any;
    const isStream = body.stream ?? false;

    if (dbg.isEnabled()) {
      dbg.log('REQUEST', 'chat.ts', `Incoming chat completion: ${body.model}`, {
        model: body.model,
        stream: isStream,
        messageCount: body.messages?.length,
        thinking: bodyAny.thinking,
        thinkingEffort: bodyAny.thinking_effort,
        hasTools: Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0,
      });
    }

    // ─── Session Detection ───────────────────────────────────────────────
    const messages = body.messages || [];
    const modelId = body.model.replace('-no-thinking', '');
    modelMapper.checkForReload();
    const mappingResult = modelMapper.resolve(modelId, {
      tools: bodyAny.tools,
      thinking: bodyAny.thinking,
      effort: bodyAny.thinking_effort,
    });
    const resolvedModel = mappingResult.targetModel;

    const sessionResult = await resolveSession({
      sessionHeader: c.req.header('x-qwenproxy-session-id'),
      messages,
      model: resolvedModel,
      busyResponse: (sessionId) => ({
        body: { error: { message: `Session ${sessionId} is busy (another request in progress)` } },
        status: 429,
      }),
    });

    activeSession = sessionResult.activeSession;
    let deltaStartIndex = sessionResult.deltaStartIndex;

    if (!sessionResult.resolved) {
      return c.json(sessionResult.busyResponse.body, sessionResult.busyResponse.status as any);
    }
    timer.mark('sessionReady');

    let prompt = '';
    let systemPrompt = '';
    const pendingMultimodal: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>> = [];

    // In session mode, only process messages from deltaStartIndex onwards
    // (Qwen retains the full context server-side)
    const loopStart = activeSession ? deltaStartIndex : 0;
    for (let i = loopStart; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const multimodalParts: Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }> = [];
        
        for (const p of msg.content as any[]) {
          if (p.type === "text" && p.text) {
            textParts.push(p.text);
          } else if (
            (p.type === "image_url" && p.image_url?.url) ||
            (p.type === "video_url" && p.video_url?.url) ||
            (p.type === "audio_url" && p.audio_url?.url) ||
            (p.type === "file_url" && p.file_url?.url)
          ) {
            multimodalParts.push(p);
          }
        }
        
        contentStr = textParts.join("\n");
        if (multimodalParts.length > 0) {
          pendingMultimodal.push(multimodalParts);
        }
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPrompt += (contentStr || '') + '\n\n';
      } else if (msg.role === 'user') {
        prompt += `User: ${contentStr || ''}\n\n`;
      } else if (msg.role === 'assistant') {
        let assistantContent = contentStr || '';
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) {
          assistantContent = `<think>\n${reasoning}\n</think>\n${assistantContent}`;
        }
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
           for (const tc of msg.tool_calls) {
             const args = tc.function?.arguments;
             let parsedArgs: any = {};
             if (typeof args === 'string') {
               try { parsedArgs = JSON.parse(args); } catch { parsedArgs = {}; }
             } else if (args && typeof args === 'object') {
               parsedArgs = args;
             }
             const payload = { name: tc.function?.name, arguments: parsedArgs };
             const toolCallStr = `\n<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
             assistantContent = assistantContent ? assistantContent + toolCallStr : toolCallStr.trim();
           }
        }
        prompt += `Assistant: ${assistantContent.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let toolName = msg.name;
        if (!toolName && msg.tool_call_id) {
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j];
            if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
              const call = prevMsg.tool_calls.find(tc => tc.id === msg.tool_call_id);
              if (call) {
                toolName = call.function?.name;
                break;
              }
            }
          }
        }
        prompt += `Tool Response (${toolName || 'tool'}): ${contentStr || ''}\n\n`;
      }
    }

    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      const forcedToolName = getForcedToolName(bodyAny.tool_choice);
      const parallelToolCalls = bodyAny.parallel_tool_calls !== false;

      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });

      // Use compact tool manifest + contract (existing infrastructure)
      const toolManifest = buildCompactToolManifest(formattedTools, forcedToolName);
      const toolContract = buildToolCallContract(formattedTools, forcedToolName, parallelToolCalls);

      systemPrompt += `\n\n${toolManifest}\n\n${toolContract}\n\n`;
      
      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    // modelId, mappingResult, resolvedModel already declared above

    if (dbg.isEnabled()) {
      dbg.log('MAPPING', 'chat.ts', `Model resolved: ${modelId} → ${resolvedModel}`, {
        originalModel: modelId,
        targetModel: resolvedModel,
        matchedBy: mappingResult.matchedBy,
        routeId: mappingResult.routeId,
      });
    }
    const modelContextWindow = getModelContextWindow(resolvedModel)
    const estimatedTokens = estimateTokenCount(systemPrompt + prompt, resolvedModel);
    const hasTools = Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0;
    const forcedToolName = getForcedToolName(bodyAny.tool_choice);
    const parallelToolCalls = bodyAny.parallel_tool_calls !== false;
    const toolContextText = `${systemPrompt}\n${prompt}`;
    const recentToolNames = hasTools ? getRecentToolNames(messages) : new Set<string>();
    const candidateTools = hasTools ? selectCandidateTools(bodyAny.tools, toolContextText, forcedToolName, recentToolNames) : [];
    
    let finalPrompt: string;
    // Skip truncation when session is active (delta messages are small, Qwen retains full context)
    if (!activeSession && estimatedTokens > modelContextWindow - 1000) {
      const truncated = truncateMessages(messages, modelContextWindow, systemPrompt, resolvedModel);
      const truncatedBody = truncated.map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role}: ${m.content}`).join('\n\n');
      finalPrompt = systemPrompt ? `${systemPrompt}\n\n${truncatedBody}` : truncatedBody;
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    if (hasTools) {
      const compactManifest = buildCompactToolManifest(candidateTools, forcedToolName);
      const toolContract = buildToolCallContract(candidateTools, forcedToolName, parallelToolCalls);
      finalPrompt += `\n\n${toolContract}`;
      if (compactManifest) finalPrompt += `\n\n${compactManifest}`;
    }

    const isThinkingModel = bodyAny.thinking !== undefined
      ? !!bodyAny.thinking
      : !resolvedModel.includes('no-thinking');

    const thinkingMode = bodyAny.thinking_effort || 'Thinking';

    const isGuestModeOnly = process.env.QWEN_GUEST_MODE_ONLY?.toLowerCase() === 'true';
    let stream: ReadableStream | undefined;
    let uiSessionId = '';
    const completionId = 'chatcmpl-' + crypto.randomUUID();

    // Build session context for createQwenStream (null if no active session)
    const sessionContext = await buildSessionContext(activeSession);
    let lastError: any = null;

    // Check response cache for non-streaming requests
    if (!isStream) {
      const cacheKey = getCacheKey(finalPrompt, resolvedModel, isThinkingModel, thinkingMode);
      const cached = await cache.get(cacheKey as any);
      if (cached) {
        metrics.increment('cache.hit');
        if (dbg.isEnabled()) {
          dbg.log('CACHE', 'chat.ts', 'Cache HIT for non-streaming request', { cacheKey });
        }
        return c.json(cached);
      }
      if (dbg.isEnabled()) {
        dbg.log('CACHE', 'chat.ts', 'Cache MISS for non-streaming request', { cacheKey });
      }
    }

    // ─── Prediction Cache for Streaming Requests ────────────────────────────
    // Use FNV-1a hash to check if we have a cached streaming response
    let predictionCacheKey = '';
    let predictionCacheHit = false;
    if (isStream && !hasTools) {
      predictionCacheKey = getPredictionCacheKey(finalPrompt, resolvedModel, isThinkingModel);
      const cachedChunks = getCachedStreamingChunks(predictionCacheKey);
      if (cachedChunks) {
        metrics.increment('prediction_cache.hit');
        if (dbg.isEnabled()) {
          dbg.log('CACHE', 'chat.ts', 'Prediction cache HIT — replaying cached stream', {
            predictionCacheKey,
            chunkCount: cachedChunks.length,
          });
        }
        // Set stream to replay stream; the rest of the code flows normally
        stream = createReplayStream(cachedChunks);
        predictionCacheHit = true;
      } else {
        metrics.increment('prediction_cache.miss');
        if (dbg.isEnabled()) {
          dbg.log('CACHE', 'chat.ts', 'Prediction cache MISS for streaming request', { predictionCacheKey });
        }
      }
    }

    // Skip upstream request if prediction cache already provided a replay stream
    if (!stream) {
    timer.mark('streamStart');
    if (isGuestModeOnly) {
      console.log('[Chat] Guest mode only enabled. Bypassing account rotation.');
      try {
        const result = await createQwenStream(
          finalPrompt,
          isThinkingModel,
          resolvedModel,
          null,
          'guest',
          undefined,
          pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
          thinkingMode,
          sessionContext,
        );
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        registerStream(completionId, {
          abortController: result.controller,
          accountId: 'guest',
          uiSessionId: result.uiSessionId,
          targetResponseId: '',
          headers: result.headers,
        });
      } catch (err: any) {
        console.error('[Chat] Guest mode failed:', err.message);
        throw err;
      }
    } else {
      // ─── Parallel Account Racing ──────────────────────────────────────
      // Collect up to 3 available accounts (not on cooldown)
      const candidateAccounts: Array<{ id: string; email: string }> = [];
      const checkedIds = new Set<string>();
      let nextAccount = getNextAccount();

      while (nextAccount && candidateAccounts.length < 3) {
        if (!checkedIds.has(nextAccount.id)) {
          checkedIds.add(nextAccount.id);
          const cooldownInfo = getAccountCooldownInfo(nextAccount.id);
          if (!cooldownInfo || nextAccount.id === 'global') {
            candidateAccounts.push({ id: nextAccount.id, email: nextAccount.email });
          } else {
            console.log(`[Chat] Skipping account ${nextAccount.email} (${nextAccount.id}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
          }
        }
        nextAccount = getNextAvailableAccount(checkedIds);
      }

      // Try one account with sequential retries (3 attempts with exponential backoff)
      async function tryAccountWithRetries(accountId: string, accountEmail: string) {
        let retries = 3;
        let retryDelay = 500;

        console.log(`[Chat] Routing request to account: ${accountEmail} (${accountId})`);
        if (dbg.isEnabled()) {
          dbg.log('ACCOUNT', 'chat.ts', `Routing to account: ${accountEmail}`, { accountId });
        }

        while (retries > 0) {
          try {
            const result = await createQwenStream(
              finalPrompt,
              isThinkingModel,
              resolvedModel,
              null,
              accountId === 'global' ? undefined : accountId,
              undefined,
              pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
              thinkingMode,
              sessionContext,
            );
            return result;
          } catch (err: any) {
            retries--;

            if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
              const hourHint = err.message?.match(/Wait about (\d+) hour/);
              const hours = hourHint ? parseInt(hourHint[1]) : 24;
              const cooldownMs = hours * 60 * 60 * 1000;
              markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
              console.warn(`[Chat] Account ${accountEmail} (${accountId}) rate-limited. Entering cooldown for ${hours} hours.`);
              throw err;
            }

            if (retries === 0) {
              if (err.upstreamStatus && err.upstreamStatus >= 500) {
                markAccountRateLimited(accountId, undefined, 'ServerError');
                console.warn(`[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`);
              }
              throw err;
            }

            let useDelay = retryDelay;
            if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
              useDelay = err.retryAfterMs;
            }
            const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
            if (!isRetryable) {
              throw err;
            }
            console.warn(`[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, useDelay));
            retryDelay = Math.min(retryDelay * 2, 5000);
          }
        }
        throw new Error(`All retries exhausted for account ${accountEmail} (${accountId})`);
      }

      // Race all candidate accounts in parallel
      if (candidateAccounts.length > 0) {
        const accountPromises = candidateAccounts.map(acc => tryAccountWithRetries(acc.id, acc.email));
        try {
          const result = await Promise.any(accountPromises);
          stream = result.stream;
          uiSessionId = result.uiSessionId;
          const streamCreationMs = Date.now() - startTime;
          console.log(`[Chat] Stream created in ${streamCreationMs}ms via parallel account racing (${candidateAccounts.length} accounts)`);
          if (dbg.isEnabled()) {
            dbg.log('STREAM', 'chat.ts', `Stream created in ${streamCreationMs}ms via parallel racing`, {
              accountsAttempted: candidateAccounts.map(a => a.email),
              streamCreationMs,
              uiSessionId: result.uiSessionId,
            });
          }
          registerStream(completionId, {
            abortController: result.controller,
            accountId: result.accountId,
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
          });
        } catch (aggregateErr: any) {
          // All accounts failed — record errors for fallback logic
          if (aggregateErr instanceof AggregateError) {
            for (const err of aggregateErr.errors) {
              console.error(`[Chat] Parallel account attempt failed:`, err.message);
              lastError = err;
            }
          } else {
            console.error(`[Chat] All parallel account attempts failed:`, aggregateErr.message);
            lastError = aggregateErr;
          }
        }
      }
    }

    if (!stream) {
      removeStream(completionId);
      const accounts = loadAccounts();
      const allOnCooldown = accounts.length === 0 || accounts.every(a => getAccountCooldownInfo(a.id) !== null);

      if (allOnCooldown) {
        // When no accounts are configured, try the default browser session first
        if (accounts.length === 0) {
          console.log('[Chat] No accounts configured. Trying default browser session...');
          try {
            const result = await createQwenStream(
              finalPrompt,
              isThinkingModel,
              resolvedModel,
              null,
              undefined,
              undefined,
              pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
              thinkingMode,
              sessionContext,
            );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: result.accountId || 'global',
              uiSessionId: result.uiSessionId,
              targetResponseId: '',
              headers: result.headers,
            });
          } catch (defaultErr: any) {
            console.warn('[Chat] Default session failed:', defaultErr.message);
            lastError = defaultErr;
          }
        }

        // Fall back to guest mode if default session didn't work
        if (!stream) {
          console.warn(`[Chat] Falling back to GUEST mode.`);
          try {
            const result = await createQwenStream(
              finalPrompt,
              isThinkingModel,
              resolvedModel,
              null,
              'guest',
              undefined,
              pendingMultimodal.length > 0 ? pendingMultimodal : undefined,
              thinkingMode,
              sessionContext,
            );
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            registerStream(completionId, {
              abortController: result.controller,
              accountId: 'guest',
              uiSessionId: result.uiSessionId,
              targetResponseId: '',
              headers: result.headers,
            });
          } catch (guestErr: any) {
            console.error('[Chat] Guest mode also failed:', guestErr.message);
            throw lastError || new Error('All accounts and guest mode failed');
          }
        }
      } else {
        throw lastError || new Error('All accounts failed');
      }
    } // end if (!stream) — skip upstream when prediction cache hit
    }
    timer.mark('streamReady');

    // ─── Prepare session state update (deferred until stream completes) ──
    const doUpdateSessionState = () => {
      if (activeSession && stream) {
        updateSessionStateShared(activeSession, messages, deltaStartIndex);
      }
    };

    if (!isStream) {
      const response = await handleNonStreamingResponse(c, stream!, completionId, resolvedModel, uiSessionId, hasTools, bodyAny.tools || []);
      // Update session state after stream fully consumed (non-streaming)
      doUpdateSessionState();
      // Cache non-streaming responses
      try {
        const cacheKey = getCacheKey(finalPrompt, resolvedModel, isThinkingModel, thinkingMode);
        const bodyClone = response.clone();
        const json = await bodyClone.json();
        await cache.set(cacheKey as any, json, 300);
      } catch { /* ignore cache errors */ }
      // Log successful request
      const endTime = Date.now();
      requestLogger.log({
        originalModel: body.model,
        mappedModel: resolvedModel,
        protocol: 'openai',
        endpoint: '/v1/chat/completions',
        clientIp: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
        userAgent: c.req.header('user-agent') || 'unknown',
        thinking: bodyAny.thinking || false,
        thinkingEffort: bodyAny.thinking_effort,
        hasTools: Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0,
        toolNames: bodyAny.tools?.map((t: any) => t.function?.name || t.name),
        streamMode: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        startTime,
        endTime,
        success: true,
        accountId: 'unknown',
        matchedBy: mappingResult.matchedBy,
        routeId: mappingResult.routeId,
        accountSelectionMs: timer.elapsed('sessionReady'),
        streamCreationMs: timer.elapsed('streamReady') - timer.elapsed('streamStart'),
        ttfbMs: undefined,
        cacheHit: false,
      });
      // Add session ID to response header
      if (activeSession) {
        c.header('X-QwenProxy-Session-Id', activeSession.sessionId);
        releaseMySession();
      }
      return response;
    }

    // Log streaming request (will be completed when stream ends)
    requestLogger.log({
      originalModel: body.model,
      mappedModel: resolvedModel,
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      clientIp: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
      userAgent: c.req.header('user-agent') || 'unknown',
      thinking: bodyAny.thinking || false,
      thinkingEffort: bodyAny.thinking_effort,
      hasTools: Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0,
      toolNames: bodyAny.tools?.map((t: any) => t.function?.name || t.name),
      streamMode: true,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      startTime,
      endTime: Date.now(),
      success: true,
      accountId: 'unknown',
      matchedBy: mappingResult.matchedBy,
      routeId: mappingResult.routeId,
      accountSelectionMs: timer.elapsed('sessionReady'),
      streamCreationMs: timer.elapsed('streamReady') - timer.elapsed('streamStart'),
      ttfbMs: undefined,
      cacheHit: predictionCacheHit,
    });
    let streamForHandler = stream!;
    if (predictionCacheKey && stream && !getCachedStreamingChunks(predictionCacheKey)) {
      // This is a cache miss — wrap the upstream stream to capture SSE chunks
      const originalReader = stream.getReader();
      const decoder = new TextDecoder();
      const capturedChunks: string[] = [];
      let captureCompleted = false;

      streamForHandler = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await originalReader.read();
            if (done) {
              // Stream finished — cache the captured chunks (only complete responses)
              if (capturedChunks.length > 0 && predictionCacheKey) {
                cacheStreamingResponse(predictionCacheKey, capturedChunks);
                metrics.increment('prediction_cache.stored');
                if (dbg.isEnabled()) {
                  dbg.log('CACHE', 'chat.ts', 'Stored streaming response in prediction cache', {
                    predictionCacheKey,
                    chunkCount: capturedChunks.length,
                  });
                }
              }
              captureCompleted = true;
              controller.close();
              return;
            }
            // Capture the raw bytes as string for caching
            capturedChunks.push(decoder.decode(value, { stream: true }));
            // Forward to consumer
            controller.enqueue(value);
          } catch (err) {
            // On error, don't cache partial responses
            try { controller.close(); } catch {}
          }
        },
        cancel() {
          originalReader.cancel();
        }
      });
    }

    return handleStreamingResponse(c, {
      stream: streamForHandler,
      completionId,
      model: resolvedModel,
      uiSessionId,
      hasTools,
      tools: bodyAny.tools || [],
      finalPrompt,
      streamOptions: body.stream_options,
      sessionId: activeSession?.sessionId,
      onStreamDone: () => {
        doUpdateSessionState();
        releaseMySession();
      },
    });
  } catch (err: any) {
    // Log failed request
    const endTime = Date.now();
    requestLogger.log({
      originalModel: bodyAny?.model || 'unknown',
      mappedModel: bodyAny?.model || 'unknown',
      protocol: 'openai',
      endpoint: '/v1/chat/completions',
      clientIp: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
      userAgent: c.req.header('user-agent') || 'unknown',
      thinking: bodyAny?.thinking || false,
      thinkingEffort: bodyAny?.thinking_effort,
      hasTools: Array.isArray(bodyAny?.tools) && bodyAny.tools.length > 0,
      toolNames: bodyAny?.tools?.map((t: any) => t.function?.name || t.name),
      streamMode: bodyAny?.stream || false,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      startTime,
      endTime,
      success: false,
      statusCode: err.upstreamStatus || 500,
      errorCode: err.upstreamCode,
      errorMessage: err.message,
      accountId: 'unknown',
      accountSelectionMs: timer.elapsed('sessionReady'),
      streamCreationMs: timer.elapsed('streamReady') - timer.elapsed('streamStart'),
      ttfbMs: undefined,
      cacheHit: false,
    });
    console.error('Error in chatCompletions:', err)
    if (dbg.isEnabled()) {
      dbg.log('ERROR', 'chat.ts', `Chat completion failed: ${err.message}`, {
        model: bodyAny?.model,
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 5).join('\n'),
        upstreamStatus: err.upstreamStatus,
        upstreamCode: err.upstreamCode,
      });
    }
    const status = err.upstreamStatus || 500
    if (status >= 500) {
      metrics.increment('requests.errors')
    }
    releaseMySession();
    return c.json({ error: { message: err.message } }, status)
  }
}

export async function chatCompletionsStop(c: Context) {
  try {
    const body = await c.req.json();
    const { chat_id, response_id } = body;

    if (!chat_id || !response_id) {
      return c.json({ error: 'chat_id and response_id are required' }, 400);
    }

    const stream = getStream(chat_id);
    if (!stream) {
      return c.json({ error: 'Stream not found' }, 404);
    }

    if (stream.targetResponseId && stream.targetResponseId !== response_id) {
      return c.json({ error: 'response_id mismatch' }, 400);
    }

    const stopResponse = await fetch(`https://chat.qwen.ai/api/v2/chat/completions/stop?chat_id=${chat_id}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Content-Type': 'application/json',
        'Cookie': stream.headers.cookie,
        'Origin': 'https://chat.qwen.ai',
        'Referer': `https://chat.qwen.ai/c/${chat_id}`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': stream.headers['user-agent'],
        'X-Request-Id': crypto.randomUUID(),
        'bx-ua': stream.headers['bx-ua'],
        'bx-umidtoken': stream.headers['bx-umidtoken'],
        'bx-v': stream.headers['bx-v'],
      },
      body: JSON.stringify({ chat_id, response_id }),
    });

    if (!stopResponse.ok) {
      const errorText = await stopResponse.text();
      console.error(`[Stop] Failed to stop generation for chat_id=${chat_id}: ${stopResponse.status} ${errorText}`);
      return c.json({ error: 'Failed to stop generation' }, stopResponse.status as any);
    }

    stream.abortController.abort();
    removeStream(chat_id);

    console.log(`[Stop] Generation stopped for chat_id=${chat_id}`);
    return c.json({ success: true });
  } catch (err: any) {
    console.error('Error in chatCompletionsStop:', err);
    return c.json({ error: err.message }, 500);
  }
}
