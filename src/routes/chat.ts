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
import { requestLogger } from '../core/request-logger.js'
import { getDebugLogger } from '../core/debug-logger.js'
import {
  getForcedToolName,
  getRecentToolNames,
  selectCandidateTools,
  buildCompactToolManifest,
  buildToolCallContract,
} from './tool-handler.js';
import { handleStreamingResponse, handleNonStreamingResponse } from './stream-handler.js';
import { getSessionManager, buildMessageFingerprints, extractTextContent, getMessageFingerprint } from '../core/session-manager.js';

// Response cache for non-streaming requests
const responseCache = new Map<string, { data: any; expiresAt: number }>();
const RESPONSE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const RESPONSE_CACHE_MAX = 200;

function getCacheKey(prompt: string, model: string, thinking: boolean, thinkingEffort: string): string {
  return crypto.createHash('sha256').update(`${model}:${thinking}:${thinkingEffort}:${prompt}`).digest('hex').slice(0, 32);
}

function getCachedResponse(key: string): any | null {
  const entry = responseCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) responseCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedResponse(key: string, data: any): void {
  if (responseCache.size >= RESPONSE_CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest) responseCache.delete(oldest);
  }
  responseCache.set(key, { data, expiresAt: Date.now() + RESPONSE_CACHE_TTL });
}

export { getIncrementalDelta } from './sse-parser.js';
export type { DeltaResult } from './sse-parser.js';

export async function chatCompletions(c: Context) {
  const startTime = Date.now();
  let body: OpenAIRequest;
  let bodyAny: any;
  const dbg = getDebugLogger();
  let activeSession: import('../core/session-manager.js').ChatSession | null = null;

  const releaseSessionFlight = () => {
    if (activeSession) {
      getSessionManager().releaseFlight(activeSession.sessionId);
      activeSession = null;
    }
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
    const sessionMgr = getSessionManager();
    const sessionHeader = c.req.header('x-qwenproxy-session-id');
    let deltaStartIndex = 0; // Index where new messages start

    const messages = body.messages || [];
    const modelId = body.model.replace('-no-thinking', '');
    modelMapper.checkForReload();
    const mappingResult = modelMapper.resolve(modelId, {
      tools: bodyAny.tools,
      thinking: bodyAny.thinking,
      effort: bodyAny.thinking_effort,
    });
    const resolvedModel = mappingResult.targetModel;

    if (sessionHeader) {
      // Explicit session ID from header
      try {
        activeSession = await sessionMgr.getOrCreate({
          sessionId: sessionHeader,
          model: resolvedModel,
        });

        // Anti-concurrence: reject if session is busy
        if (!sessionMgr.acquireFlight(activeSession.sessionId)) {
          return c.json({ error: { message: `Session ${sessionHeader} is busy (another request in progress)` } }, 429);
        }

        deltaStartIndex = activeSession.messageCount;
      } catch (err: any) {
        console.error(`[Chat] Failed to get/create session ${sessionHeader}:`, err.message);
        // Fall through to non-session behavior
      }
    } else if (messages.length > 0) {
      // Auto-detect: try to match messages to existing session
      const match = sessionMgr.matchByMessages(messages, resolvedModel);
      if (match) {
        activeSession = match.session;
        deltaStartIndex = match.newMessageStartIndex;

        if (!sessionMgr.acquireFlight(activeSession.sessionId)) {
          return c.json({ error: { message: `Session ${activeSession.sessionId} is busy` } }, 429);
        }
      }
    }

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
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT (MANDATORY)\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in <tool_call> tags:\n\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nEXAMPLE OF MULTIPLE TOOL CALLS:\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file1.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "file2.txt"}}\n</tool_call>\n\nCRITICAL RULES:\n1. ONLY use the tags above for tool calling. NEVER output raw JSON without tags.\n2. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n3. Do NOT output any other text (explanations, chat, etc.) after your <tool_call> blocks. Wait for the user to provide the tool response.\n4. The JSON inside the tags MUST be valid and include ALL required braces and the "arguments" field.\n5. If you need to use a tool, do it IMMEDIATELY without preamble.\n6. NEVER invent, guess, or hallucinate tool names. You MUST ONLY use the exact tool names provided in the 'TOOLS AVAILABLE' list above. Calling an unlisted tool will result in a hard execution error.\n\n`;
      
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
    const sessionContext = activeSession ? {
      chatId: activeSession.chatId,
      parentId: activeSession.parentId,
      headers: await sessionMgr.refreshHeadersIfNeeded(activeSession),
      accountId: activeSession.accountId,
    } : undefined;
    let lastError: any = null;

    // Check response cache for non-streaming requests
    if (!isStream) {
      const cacheKey = getCacheKey(finalPrompt, resolvedModel, isThinkingModel, thinkingMode);
      const cached = getCachedResponse(cacheKey);
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
      let account = getNextAccount();
      const triedAccountIds = new Set<string>();

      while (account) {
        const accountId = account.id;
        const accountEmail = account.email;

        if (triedAccountIds.has(accountId)) {
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }
        triedAccountIds.add(accountId);

        const cooldownInfo = getAccountCooldownInfo(accountId);
        if (cooldownInfo && accountId !== 'global') {
          console.log(`[Chat] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }

        console.log(`[Chat] Routing request to account: ${accountEmail} (${accountId})`);

        if (dbg.isEnabled()) {
          dbg.log('ACCOUNT', 'chat.ts', `Routing to account: ${accountEmail}`, { accountId });
        }

        let retries = 3;
        let retryDelay = 500;
        let success = false;

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
            stream = result.stream;
            uiSessionId = result.uiSessionId;
            const streamCreationMs = Date.now() - startTime;
            console.log(`[Chat] Stream created in ${streamCreationMs}ms for account ${accountEmail}`);

            if (dbg.isEnabled()) {
              dbg.log('STREAM', 'chat.ts', `Stream created in ${streamCreationMs}ms`, {
                accountId,
                accountEmail,
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
            success = true;
            break;
          } catch (err: any) {
            retries--;

            if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
              const hourHint = err.message?.match(/Wait about (\d+) hour/);
              const hours = hourHint ? parseInt(hourHint[1]) : 24;
              const cooldownMs = hours * 60 * 60 * 1000;
              markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
              console.warn(`[Chat] Account ${accountEmail} (${accountId}) rate-limited. Entering cooldown for ${hours} hours.`);
              lastError = err;
              break;
            }

            if (retries === 0) {
              if (err.upstreamStatus && err.upstreamStatus >= 500) {
                markAccountRateLimited(accountId, undefined, 'ServerError');
                console.warn(`[Chat] Account ${accountEmail} (${accountId}) returned server error. Marked for cooldown.`);
              }
              lastError = err;
              break;
            }

            let useDelay = retryDelay;
            if (err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined) {
              useDelay = err.retryAfterMs;
            }
            const isRetryable = err instanceof RetryableQwenStreamError || err.message?.includes('in progress') || err.message?.includes('Bad_Request');
            if (!isRetryable) {
              lastError = err;
              break;
            }
            console.warn(`[Chat] Qwen request failed for ${accountEmail}, retrying in ${useDelay}ms... (${retries} left)`);
            await new Promise(r => setTimeout(r, useDelay));
            retryDelay = Math.min(retryDelay * 2, 5000);
          }
        }

        if (success) {
          break;
        }

        account = getNextAvailableAccount(triedAccountIds);
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
    }

    // ─── Prepare session state update (deferred until stream completes) ──
    const updateSessionState = () => {
      if (activeSession && stream) {
        const newMsgCount = messages.length;
        const fps = buildMessageFingerprints(messages, deltaStartIndex, newMsgCount);
        const existingFps = new Map<number, string>();
        for (let i = 0; i < deltaStartIndex; i++) {
          const msg = messages[i];
          const text = extractTextContent(msg.content);
          existingFps.set(i, getMessageFingerprint(msg.role, text));
        }
        for (const [k, v] of fps) existingFps.set(k, v);
        sessionMgr.updateMessageState(activeSession.sessionId, newMsgCount, existingFps);
      }
    };

    if (!isStream) {
      const response = await handleNonStreamingResponse(c, stream!, completionId, resolvedModel, uiSessionId, hasTools, bodyAny.tools || []);
      // Update session state after stream fully consumed (non-streaming)
      updateSessionState();
      // Cache non-streaming responses
      try {
        const cacheKey = getCacheKey(finalPrompt, resolvedModel, isThinkingModel, thinkingMode);
        const bodyClone = response.clone();
        const json = await bodyClone.json();
        setCachedResponse(cacheKey, json);
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
      });
      // Add session ID to response header
      if (activeSession) {
        c.header('X-QwenProxy-Session-Id', activeSession.sessionId);
        releaseSessionFlight();
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
    });

    return handleStreamingResponse(c, {
      stream: stream!,
      completionId,
      model: resolvedModel,
      uiSessionId,
      hasTools,
      tools: bodyAny.tools || [],
      finalPrompt,
      streamOptions: body.stream_options,
      sessionId: activeSession?.sessionId,
      onStreamDone: () => {
        updateSessionState();
        releaseSessionFlight();
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
    releaseSessionFlight();
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
