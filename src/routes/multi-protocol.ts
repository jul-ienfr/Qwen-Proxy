/**
 * Multi-Protocol Routes - Handles Anthropic and Gemini API endpoints
 */

import type { Context } from 'hono';
import crypto from 'crypto';
import { adapterRegistry } from '../adapters/index.js';
import type { NormalizedRequest, ProtocolAdapter, NormalizedResponse } from '../adapters/types.js';
import { modelMapper } from '../core/model-mapper.js';
import { createQwenStream, RetryableQwenStreamError } from '../services/qwen.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';
import { registerStream, removeStream } from '../core/stream-registry.js';
import { metrics } from '../core/metrics.js';
import { requestLogger } from '../core/request-logger.js';
import { getDebugLogger } from '../core/debug-logger.js';
import { getSessionManager, buildMessageFingerprints, extractTextContent, getMessageFingerprint } from '../core/session-manager.js';

// ─── Anthropic Endpoint ──────────────────────────────────────────────────────

export async function anthropicMessages(c: Context) {
  const startTime = Date.now();
  const adapter = adapterRegistry.get('anthropic')!;
  let activeSession: import('../core/session-manager.js').ChatSession | null = null;

  const releaseSessionFlight = () => {
    if (activeSession) {
      getSessionManager().releaseFlight(activeSession.sessionId);
      activeSession = null;
    }
  };

  try {
    const raw = await c.req.json();
    const path = c.req.path;

    // Normalize request
    const normalized = adapter.normalizeRequest(raw, path);

    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('REQUEST', 'multi-protocol.ts', `Incoming Anthropic request: ${normalized.model}`, {
        model: normalized.model,
        stream: normalized.stream,
        messageCount: normalized.messages?.length,
        thinking: normalized.thinking,
        protocol: 'anthropic',
      });
    }

    // Resolve model mapping
    modelMapper.checkForReload();
    const mappingResult = modelMapper.resolve(normalized.model, {
      tools: normalized.tools,
      thinking: normalized.thinking,
      effort: normalized.thinking_effort,
    });
    normalized.model = mappingResult.targetModel;

    if (dbg.isEnabled()) {
      dbg.log('MAPPING', 'multi-protocol.ts', `Anthropic model mapped: ${normalized.model}`, {
        originalModel: normalized.model,
        targetModel: mappingResult.targetModel,
        matchedBy: mappingResult.matchedBy,
      });
    }

    // Create stream
    const completionId = `msg_${Date.now()}_${crypto.randomBytes(12).toString('hex')}`;
    let stream: ReadableStream | undefined;
    let uiSessionId = '';

    // ─── Session Detection (Anthropic) ──────────────────────────────────
    const sessionMgr = getSessionManager();
    const sessionHeader = c.req.header('x-qwenproxy-session-id');
    let deltaStartIndex = 0;

    if (sessionHeader) {
      try {
        activeSession = await sessionMgr.getOrCreate({
          sessionId: sessionHeader,
          model: normalized.model,
        });
        if (!sessionMgr.acquireFlight(activeSession.sessionId)) {
          return c.json({ type: 'error', error: { type: 'api_error', message: `Session ${sessionHeader} is busy` } }, 429 as any);
        }
        deltaStartIndex = activeSession.messageCount;
      } catch (err: any) {
        console.error(`[Anthropic] Failed to get/create session ${sessionHeader}:`, err.message);
      }
    } else if (normalized.messages?.length > 0) {
      const match = sessionMgr.matchByMessages(normalized.messages, normalized.model);
      if (match) {
        activeSession = match.session;
        deltaStartIndex = match.newMessageStartIndex;
        if (!sessionMgr.acquireFlight(activeSession.sessionId)) {
          return c.json({ type: 'error', error: { type: 'api_error', message: `Session ${activeSession.sessionId} is busy` } }, 429 as any);
        }
      }
    }

    // Build prompt from normalized messages (delta only if session active)
    const messagesForPrompt = activeSession
      ? normalized.messages.slice(deltaStartIndex)
      : normalized.messages;
    const tempNormalized = activeSession ? { ...normalized, messages: messagesForPrompt } : normalized;
    const finalPrompt = buildPromptFromMessages(tempNormalized);

    // Build session context for createQwenStream
    const sessionContext = activeSession ? {
      chatId: activeSession.chatId,
      parentId: activeSession.parentId,
      headers: await sessionMgr.refreshHeadersIfNeeded(activeSession),
      accountId: activeSession.accountId,
    } : undefined;

    // Try accounts
    const isGuestModeOnly = process.env.QWEN_GUEST_MODE_ONLY?.toLowerCase() === 'true';
    let lastError: any = null;

    if (isGuestModeOnly) {
      try {
        const result = await createQwenStream(
          finalPrompt,
          normalized.thinking ?? true,
          normalized.model,
          null,
          'guest',
          undefined,
          undefined,
          normalized.thinking_effort || 'Thinking',
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
        lastError = err;
      }
    } else {
      let account = getNextAccount();
      const triedAccountIds = new Set<string>();

      while (account) {
        if (triedAccountIds.has(account.id)) {
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }
        triedAccountIds.add(account.id);

        const cooldownInfo = getAccountCooldownInfo(account.id);
        if (cooldownInfo) {
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }

        try {
          const result = await createQwenStream(
            finalPrompt,
            normalized.thinking ?? true,
            normalized.model,
            null,
            account.id === 'global' ? undefined : account.id,
            undefined,
            undefined,
            normalized.thinking_effort || 'Thinking',
            sessionContext,
          );
          stream = result.stream;
          uiSessionId = result.uiSessionId;
          registerStream(completionId, {
            abortController: result.controller,
            accountId: result.accountId,
            uiSessionId: result.uiSessionId,
            targetResponseId: '',
            headers: result.headers,
          });
          break;
        } catch (err: any) {
          if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
            markAccountRateLimited(account.id, 24 * 60 * 60 * 1000, 'RateLimited');
          }
          lastError = err;
          account = getNextAvailableAccount(triedAccountIds);
        }
      }
    }

    if (!stream) {
      releaseSessionFlight();
      throw lastError || new Error('All accounts failed');
    }

    // ─── Update session state after successful stream creation ──────────
    if (activeSession && normalized.messages?.length) {
      const newMsgCount = normalized.messages.length;
      const fps = buildMessageFingerprints(normalized.messages, deltaStartIndex, newMsgCount);
      const existingFps = new Map<number, string>();
      for (let i = 0; i < deltaStartIndex; i++) {
        const msg = normalized.messages[i];
        const text = extractTextContent(msg.content);
        existingFps.set(i, getMessageFingerprint(msg.role, text));
      }
      for (const [k, v] of fps) existingFps.set(k, v);
      sessionMgr.updateMessageState(activeSession.sessionId, newMsgCount, existingFps);
    }

    // Add session header to response
    if (activeSession) {
      c.header('X-QwenProxy-Session-Id', activeSession.sessionId);
    }

    // Handle streaming vs non-streaming
    if (normalized.stream) {
      const response = await handleAnthropicStream(c, stream, adapter, normalized.model, completionId, startTime, normalized);
      releaseSessionFlight();
      return response;
    } else {
      const response = await handleAnthropicNonStream(c, stream, adapter, normalized.model, completionId, startTime, normalized);
      releaseSessionFlight();
      return response;
    }
  } catch (err: any) {
    releaseSessionFlight();
    const endTime = Date.now();
    requestLogger.log({
      originalModel: 'anthropic',
      mappedModel: 'unknown',
      protocol: 'anthropic',
      endpoint: '/v1/messages',
      clientIp: c.req.header('x-forwarded-for') || 'unknown',
      userAgent: c.req.header('user-agent') || 'unknown',
      thinking: false,
      hasTools: false,
      streamMode: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      startTime,
      endTime,
      success: false,
      statusCode: err.upstreamStatus || 500,
      errorMessage: err.message,
      accountId: 'unknown',
    });

    return c.json({
      type: 'error',
      error: { type: 'api_error', message: err.message },
    }, (err.upstreamStatus || 500) as any);
  }
}

// ─── Anthropic Stream Handler ────────────────────────────────────────────────

async function handleAnthropicStream(
  c: Context,
  stream: ReadableStream,
  adapter: ProtocolAdapter,
  model: string,
  completionId: string,
  startTime: number,
  normalized: NormalizedRequest
) {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  c.header('x-request-id', completionId);

  const encoder = new TextEncoder();
  const reader = stream.getReader();

  const response = new ReadableStream({
    async start(controller) {
      // Send message_start
      const startEvent = adapter.formatStreamStart(model);
      controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`));

      try {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += new TextDecoder().decode(value);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') break;

              try {
                const chunk = JSON.parse(data);

                // Map Qwen's thinking_summary format to the format expected by adapters
                // Qwen sends: { phase: 'thinking_summary', extra: { summary_thought: { content: [...] } } }
                // Adapters expect: { delta: { thinking: '...' } } or { delta: { reasoning_content: '...' } }
                if (chunk.choices?.[0]?.delta?.phase === 'thinking_summary') {
                  const delta = chunk.choices[0].delta;
                  if (delta.extra?.summary_thought?.content) {
                    const thoughts = delta.extra.summary_thought.content;
                    if (thoughts.length > 0) {
                      // Create a new chunk with thinking mapped to the standard format
                      const thinkingChunk = {
                        ...chunk,
                        choices: [{
                          ...chunk.choices[0],
                          delta: {
                            ...delta,
                            thinking: thoughts.join('\n'),
                            // Also set reasoning_content for OpenAI-compatible clients
                            reasoning_content: thoughts.join('\n'),
                          }
                        }]
                      };
                      const formatted = adapter.formatStreamChunk(thinkingChunk);
                      if (formatted && Array.isArray(formatted)) {
                        for (const event of formatted) {
                          const eventType = event.type || 'content_block_delta';
                          controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`));
                        }
                      }
                    }
                  }
                } else {
                  // Pass through to adapter as-is for non-thinking chunks
                  const formatted = adapter.formatStreamChunk(chunk);
                  if (formatted && Array.isArray(formatted)) {
                    for (const event of formatted) {
                      const eventType = event.type || 'content_block_delta';
                      controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`));
                    }
                  }
                }
              } catch {}
            }
          }
        }
      } catch (err) {
        console.error('[Anthropic] Stream error:', err);
      }

      // Send message_stop
      const endEvent = adapter.formatStreamEnd();
      controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify(endEvent)}\n\n`));

      // Log request
      const endTime = Date.now();
      requestLogger.log({
        originalModel: normalized.originalModel,
        mappedModel: model,
        protocol: 'anthropic',
        endpoint: '/v1/messages',
        clientIp: 'unknown',
        userAgent: 'unknown',
        thinking: normalized.thinking || false,
        hasTools: (normalized.tools?.length ?? 0) > 0,
        streamMode: true,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        totalTokens: 0,
        startTime,
        endTime,
          success: true,
        accountId: 'unknown',
        matchedBy: 'mapping',
      });

      controller.close();
    },
  });

  return new Response(response, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ─── Anthropic Non-Stream Handler ────────────────────────────────────────────

async function handleAnthropicNonStream(
  c: Context,
  stream: ReadableStream,
  adapter: ProtocolAdapter,
  model: string,
  completionId: string,
  startTime: number,
  normalized: NormalizedRequest
) {
  // Collect full response from stream
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let thinkingContent = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;

            if (delta?.content) {
              fullContent += delta.content;
            }

            // Handle Qwen's thinking_summary format
            if (delta?.phase === 'thinking_summary' && delta?.extra?.summary_thought?.content) {
              const thoughts = delta.extra.summary_thought.content;
              thinkingContent += thoughts.join('\n');
            }

            // Handle direct thinking format (if already mapped)
            if (delta?.thinking) {
              thinkingContent += delta.thinking;
            }

            // Handle reasoning_content format (OpenAI-style)
            if (delta?.reasoning_content) {
              thinkingContent += delta.reasoning_content;
            }
          } catch {}
        }
      }
    }
  } catch (err: any) {
    console.error('[Anthropic] Stream read error:', err?.message);
  }

  // Build normalized response
  const normalizedResponse: NormalizedResponse = {
    id: completionId,
    object: 'message',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: fullContent,
        // Include thinking content if present
        ...(thinkingContent ? { thinking: thinkingContent } : {}),
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  // Format response
  const response = adapter.formatResponse(normalizedResponse, { model });

  // Log request
  const endTime = Date.now();
  requestLogger.log({
    originalModel: normalized.originalModel,
    mappedModel: model,
    protocol: 'anthropic',
    endpoint: '/v1/messages',
    clientIp: 'unknown',
    userAgent: 'unknown',
    thinking: normalized.thinking || false,
    hasTools: (normalized.tools?.length ?? 0) > 0,
    streamMode: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    startTime,
    endTime,
    success: true,
    accountId: 'unknown',
    matchedBy: 'mapping',
  });

  return c.json(response);
}

// ─── Helper: Build prompt from messages ──────────────────────────────────────

function buildPromptFromMessages(normalized: NormalizedRequest): string {
  let prompt = '';
  let systemPrompt = '';

  for (const msg of normalized.messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (msg.role === 'system') {
      systemPrompt += content + '\n\n';
    } else if (msg.role === 'user') {
      prompt += `User: ${content}\n\n`;
    } else if (msg.role === 'assistant') {
      let assistantContent = content;
      if ((msg as any).thinking) {
        assistantContent = `<think>\n${(msg as any).thinking}\n</think>\n${assistantContent}`;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          assistantContent += `\n<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: JSON.parse(tc.function.arguments) })}\n</tool_call>`;
        }
      }
      prompt += `Assistant: ${assistantContent}\n\n`;
    } else if (msg.role === 'tool') {
      prompt += `Tool Response (${msg.name || 'tool'}): ${content}\n\n`;
    }
  }

  // Add tools to system prompt if present
  if (normalized.tools && normalized.tools.length > 0) {
    const toolsJson = JSON.stringify(normalized.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })), null, 2);

    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\n# TOOL CALLING FORMAT\nTo use a tool, output: <tool_call>\n{"name": "tool_name", "arguments": {...}}\n</tool_call>\n`;
  }

  return systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
}

// ─── Gemini Endpoint ─────────────────────────────────────────────────────────

export async function geminiGenerateContent(c: Context) {
  const startTime = Date.now();
  const adapter = adapterRegistry.get('gemini')!;
  let activeSession: import('../core/session-manager.js').ChatSession | null = null;

  const releaseSessionFlight = () => {
    if (activeSession) {
      getSessionManager().releaseFlight(activeSession.sessionId);
      activeSession = null;
    }
  };

  try {
    const raw = await c.req.json();
    const path = c.req.path;

    // Normalize request
    const normalized = adapter.normalizeRequest(raw, path);

    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('REQUEST', 'multi-protocol.ts', `Incoming Gemini request: ${normalized.model}`, {
        model: normalized.model,
        stream: normalized.stream,
        messageCount: normalized.messages?.length,
        thinking: normalized.thinking,
        protocol: 'gemini',
      });
    }

    // Resolve model mapping
    modelMapper.checkForReload();
    const mappingResult = modelMapper.resolve(normalized.model, {
      tools: normalized.tools,
      thinking: normalized.thinking,
      effort: normalized.thinking_effort,
    });
    normalized.model = mappingResult.targetModel;

    if (dbg.isEnabled()) {
      dbg.log('MAPPING', 'multi-protocol.ts', `Gemini model mapped: ${normalized.model}`, {
        originalModel: normalized.model,
        targetModel: mappingResult.targetModel,
        matchedBy: mappingResult.matchedBy,
      });
    }

    // Build prompt
    const completionId = `gemini_${Date.now()}`;
    let stream: ReadableStream | undefined;

    // ─── Session Detection (Gemini) ────────────────────────────────────
    const sessionMgr = getSessionManager();
    const sessionHeader = c.req.header('x-qwenproxy-session-id');
    let deltaStartIndex = 0;

    if (sessionHeader) {
      try {
        activeSession = await sessionMgr.getOrCreate({
          sessionId: sessionHeader,
          model: normalized.model,
        });
        if (!sessionMgr.acquireFlight(activeSession.sessionId)) {
          return c.json({ error: { code: 429, message: `Session ${sessionHeader} is busy`, status: 'RESOURCE_EXHAUSTED' } }, 429);
        }
        deltaStartIndex = activeSession.messageCount;
      } catch (err: any) {
        console.error(`[Gemini] Failed to get/create session ${sessionHeader}:`, err.message);
      }
    } else if (normalized.messages?.length > 0) {
      const match = sessionMgr.matchByMessages(normalized.messages, normalized.model);
      if (match) {
        activeSession = match.session;
        deltaStartIndex = match.newMessageStartIndex;
        if (!sessionMgr.acquireFlight(activeSession.sessionId)) {
          return c.json({ error: { code: 429, message: `Session ${activeSession.sessionId} is busy`, status: 'RESOURCE_EXHAUSTED' } }, 429);
        }
      }
    }

    // Build prompt from delta messages only if session active
    const messagesForPrompt = activeSession
      ? normalized.messages.slice(deltaStartIndex)
      : normalized.messages;
    const tempNormalized = activeSession ? { ...normalized, messages: messagesForPrompt } : normalized;
    const finalPrompt = buildPromptFromMessages(tempNormalized);

    // Build session context for createQwenStream
    const sessionContext = activeSession ? {
      chatId: activeSession.chatId,
      parentId: activeSession.parentId,
      headers: await sessionMgr.refreshHeadersIfNeeded(activeSession),
      accountId: activeSession.accountId,
    } : undefined;

    // Try guest mode
    const isGuestModeOnly = process.env.QWEN_GUEST_MODE_ONLY?.toLowerCase() === 'true';
    let lastError: any = null;

    if (isGuestModeOnly) {
      try {
        const result = await createQwenStream(
          finalPrompt,
          normalized.thinking ?? true,
          normalized.model,
          null,
          'guest',
          undefined,
          undefined,
          normalized.thinking_effort || 'Thinking',
          sessionContext,
        );
        stream = result.stream;
      } catch (err: any) {
        lastError = err;
      }
    } else {
      let account = getNextAccount();
      const triedAccountIds = new Set<string>();

      while (account) {
        if (triedAccountIds.has(account.id)) {
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }
        triedAccountIds.add(account.id);

        const cooldownInfo = getAccountCooldownInfo(account.id);
        if (cooldownInfo) {
          account = getNextAvailableAccount(triedAccountIds);
          continue;
        }

        try {
          const result = await createQwenStream(
            finalPrompt,
            normalized.thinking ?? true,
            normalized.model,
            null,
            account.id === 'global' ? undefined : account.id,
            undefined,
            undefined,
            normalized.thinking_effort || 'Thinking',
            sessionContext,
          );
          stream = result.stream;
          break;
        } catch (err: any) {
          if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
            markAccountRateLimited(account.id, 24 * 60 * 60 * 1000, 'RateLimited');
          }
          lastError = err;
          account = getNextAvailableAccount(triedAccountIds);
        }
      }
    }

    if (!stream) {
      releaseSessionFlight();
      throw lastError || new Error('All accounts failed');
    }

    // ─── Update session state after successful stream creation ──────────
    if (activeSession && normalized.messages?.length) {
      const newMsgCount = normalized.messages.length;
      const fps = buildMessageFingerprints(normalized.messages, deltaStartIndex, newMsgCount);
      const existingFps = new Map<number, string>();
      for (let i = 0; i < deltaStartIndex; i++) {
        const msg = normalized.messages[i];
        const text = extractTextContent(msg.content);
        existingFps.set(i, getMessageFingerprint(msg.role, text));
      }
      for (const [k, v] of fps) existingFps.set(k, v);
      sessionMgr.updateMessageState(activeSession.sessionId, newMsgCount, existingFps);
    }

    // Add session header to response
    if (activeSession) {
      c.header('X-QwenProxy-Session-Id', activeSession.sessionId);
    }

    // Handle streaming vs non-streaming
    if (normalized.stream) {
      const response = await handleGeminiStream(c, stream, adapter, normalized.model, startTime, normalized);
      releaseSessionFlight();
      return response;
    } else {
      const response = await handleGeminiNonStream(c, stream, adapter, normalized.model, startTime, normalized);
      releaseSessionFlight();
      return response;
    }
  } catch (err: any) {
    releaseSessionFlight();
    const endTime = Date.now();
    requestLogger.log({
      originalModel: 'gemini',
      mappedModel: 'unknown',
      protocol: 'gemini',
      endpoint: c.req.path,
      clientIp: c.req.header('x-forwarded-for') || 'unknown',
      userAgent: c.req.header('user-agent') || 'unknown',
      thinking: false,
      hasTools: false,
      streamMode: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      startTime,
      endTime,
      success: false,
      statusCode: err.upstreamStatus || 500,
      errorMessage: err.message,
      accountId: 'unknown',
    });

    return c.json({
      error: { code: 500, message: err.message, status: 'INTERNAL' },
    }, 500);
  }
}

// ─── Gemini Stream Handler ───────────────────────────────────────────────────

async function handleGeminiStream(
  c: Context,
  stream: ReadableStream,
  adapter: ProtocolAdapter,
  model: string,
  startTime: number,
  normalized: NormalizedRequest
) {
  c.header('Content-Type', 'application/json');

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: any[] = [];
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const formatted = adapter.formatStreamChunk(chunk);
            if (formatted) chunks.push(formatted);
          } catch {}
        }
      }
    }
  } catch {}

  // Return all chunks as JSON array (Gemini streaming returns array)
  const endTime = Date.now();
  requestLogger.log({
    originalModel: normalized.originalModel,
    mappedModel: model,
    protocol: 'gemini',
    endpoint: c.req.path,
    clientIp: 'unknown',
    userAgent: 'unknown',
    thinking: normalized.thinking || false,
    hasTools: (normalized.tools?.length ?? 0) > 0,
    streamMode: true,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    startTime,
    endTime,
    success: true,
    accountId: 'unknown',
    matchedBy: 'mapping',
  });

  return c.json(chunks);
}

// ─── Gemini Non-Stream Handler ───────────────────────────────────────────────

async function handleGeminiNonStream(
  c: Context,
  stream: ReadableStream,
  adapter: ProtocolAdapter,
  model: string,
  startTime: number,
  normalized: NormalizedRequest
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) {
              fullContent += choice.delta.content;
            }
          } catch {}
        }
      }
    }
  } catch {}

  const normalizedResponse: NormalizedResponse = {
    id: `gemini_${Date.now()}`,
    object: 'gemini_response',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: fullContent },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  const response = adapter.formatResponse(normalizedResponse, { model });

  const endTime = Date.now();
  requestLogger.log({
    originalModel: normalized.originalModel,
    mappedModel: model,
    protocol: 'gemini',
    endpoint: c.req.path,
    clientIp: 'unknown',
    userAgent: 'unknown',
    thinking: normalized.thinking || false,
    hasTools: (normalized.tools?.length ?? 0) > 0,
    streamMode: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    startTime,
    endTime,
    success: true,
    accountId: 'unknown',
    matchedBy: 'mapping',
  });

  return c.json(response);
}
