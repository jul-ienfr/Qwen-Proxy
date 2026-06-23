/**
 * Multi-Protocol Routes - Handles Anthropic and Gemini API endpoints
 */

import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import crypto from 'crypto';
import { adapterRegistry } from '../adapters/index.js';
import type { NormalizedRequest, ProtocolAdapter, NormalizedResponse } from '../adapters/types.js';
import { modelMapper } from '../core/model-mapper.js';
import { createQwenStream, RetryableQwenStreamError } from '../services/qwen.js';
import { getNextAccount, getNextAvailableAccount, markAccountRateLimited, getAccountCooldownInfo } from '../core/account-manager.js';
import { loadAccounts } from '../core/accounts.js';
import { registerStream, removeStream } from '../core/stream-registry.js';
import { metrics } from '../core/metrics.js';
import { requestLogger, RequestTimer } from '../core/request-logger.js';
import { getDebugLogger } from '../core/debug-logger.js';
import { StreamingToolParser } from '../tools/parser.js';
import { obfuscateToolName, deobfuscateToolName } from '../tools/obfuscation.js';
import { resolveSession, buildSessionContext, updateSessionState, releaseSessionFlight } from './request-executor.js';

// ─── Anthropic Endpoint ──────────────────────────────────────────────────────

export async function anthropicMessages(c: Context) {
  const startTime = Date.now();
  const timer = new RequestTimer();
  const adapter = adapterRegistry.get('anthropic')!;
  let activeSession: import('../core/session-manager.js').ChatSession | null = null;

  const releaseMyFlight = () => {
    releaseSessionFlight(activeSession);
    activeSession = null;
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
    const sessionResult = await resolveSession({
      sessionHeader: c.req.header('x-qwenproxy-session-id'),
      messages: normalized.messages || [],
      model: normalized.model,
      busyResponse: (sessionId) => ({
        body: { type: 'error', error: { type: 'api_error', message: `Session ${sessionId} is busy` } },
        status: 429,
      }),
    });

    activeSession = sessionResult.activeSession;
    let deltaStartIndex = sessionResult.deltaStartIndex;

    if (!sessionResult.resolved) {
      return c.json(sessionResult.busyResponse.body, sessionResult.busyResponse.status as any);
    }

    // Build prompt from normalized messages (delta only if session active)
    const messagesForPrompt = activeSession
      ? normalized.messages.slice(deltaStartIndex)
      : normalized.messages;
    const tempNormalized = activeSession ? { ...normalized, messages: messagesForPrompt } : normalized;
    const finalPrompt = buildPromptFromMessages(tempNormalized);

    // Build session context for createQwenStream
    const sessionContext = await buildSessionContext(activeSession);
    timer.mark('sessionReady');

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
      releaseMyFlight();
      throw lastError || new Error('All accounts failed');
    }

    // ─── Update session state after successful stream creation ──────────
    if (activeSession && normalized.messages?.length) {
      updateSessionState(activeSession, normalized.messages, deltaStartIndex);
    }

    // Add session header to response
    if (activeSession) {
      c.header('X-QwenProxy-Session-Id', activeSession.sessionId);
    }

    timer.mark('streamReady');
    const streamCreationMs = timer.elapsed('sessionReady');

    // Handle streaming vs non-streaming
    if (normalized.stream) {
      const response = await handleAnthropicStream(c, stream, adapter, normalized.model, completionId, startTime, normalized, timer, streamCreationMs);
      releaseMyFlight();
      return response;
    } else {
      const response = await handleAnthropicNonStream(c, stream, adapter, normalized.model, completionId, startTime, normalized, timer, streamCreationMs);
      releaseMyFlight();
      return response;
    }
  } catch (err: any) {
    releaseMyFlight();
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
      streamCreationMs: timer.elapsed('sessionReady'),
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
  normalized: NormalizedRequest,
  timer: RequestTimer,
  streamCreationMs: number
) {
  const hasTools = normalized.tools && normalized.tools.length > 0;
  const toolParser = hasTools ? new StreamingToolParser(normalized.tools as any) : null;
  let blockIndex = 1;

  const encoder = new TextEncoder();
  return honoStream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    // Send heartbeat to prevent timeout
    await streamWriter.write(': heartbeat\n\n');
    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keep-alive\n\n'); } catch { /* heartbeat write failed, will be cleared by outer cleanup */ }
    }, 15000);

    const startEvent = adapter.formatStreamStart(model);
    await streamWriter.write(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`);

    const reader = stream.getReader();
    try {
      let buffer = '';
      const decoder = new TextDecoder();
      let chunkCount = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) { console.log(`[Anthropic-DEBUG] Stream ended after ${chunkCount} chunks`); break; }
        chunkCount++;
        if (chunkCount <= 3) console.log(`[Anthropic-DEBUG] Chunk #${chunkCount} (${value.length} bytes): ${decoder.decode(value).substring(0, 200)}`);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta;
            if (delta?.phase === 'thinking_summary' && delta.extra?.summary_thought?.content) {
              const thoughts = delta.extra.summary_thought.content;
              if (thoughts.length > 0) {
                const tc = { ...chunk, choices: [{ ...choice, delta: { ...delta, thinking: thoughts.join('\n'), reasoning_content: thoughts.join('\n') } }] };
                const fmt = adapter.formatStreamChunk(tc);
                if (fmt && Array.isArray(fmt)) for (const e of fmt) await streamWriter.write(`event: ${e.type || 'content_block_delta'}\ndata: ${JSON.stringify(e)}\n\n`);
              }
            } else if (toolParser && delta?.content) {
              const r = toolParser.feed(delta.content);
              if (r.text) await streamWriter.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } })}\n\n`);
              for (const tc of r.toolCalls) {
                const idx = blockIndex++;
                const deobfuscatedName = deobfuscateToolName(tc.name);
                await streamWriter.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id, name: deobfuscatedName } })}\n\n`);
                await streamWriter.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.arguments) } })}\n\n`);
                await streamWriter.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
              }
            } else {
              // Convert Qwen phase format to OpenAI format for the adapter
              let convertedChunk = chunk;
              if (delta?.phase === 'answer' && delta.content !== undefined) {
                convertedChunk = {
                  ...chunk,
                  choices: [{ ...choice, delta: { content: delta.content } }],
                };
              } else if (delta?.content !== undefined && !delta.phase) {
                // Already OpenAI format — pass through
              }
              const fmt = adapter.formatStreamChunk(convertedChunk);
              if (fmt && Array.isArray(fmt)) for (const e of fmt) await streamWriter.write(`event: ${e.type || 'content_block_delta'}\ndata: ${JSON.stringify(e)}\n\n`);
            }
          } catch {}
        }
      }
      if (toolParser) {
        const f = toolParser.flush();
        for (const tc of f.toolCalls) {
          const idx = blockIndex++;
          const deobfuscatedName = deobfuscateToolName(tc.name);
          await streamWriter.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id, name: deobfuscatedName } })}\n\n`);
          await streamWriter.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.arguments) } })}\n\n`);
          await streamWriter.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
        }
        if (f.text) await streamWriter.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: f.text } })}\n\n`);
      }
    } catch (err) { console.error('[Anthropic] Stream error:', err); }
    clearInterval(heartbeat);

    // Determine stop_reason based on whether tool calls were emitted
    const hasToolCalls = blockIndex > 1;
    const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';

    // Emit message_delta with stop_reason (required by Claude Code)
    await streamWriter.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    })}\n\n`);

    // Emit message_stop
    await streamWriter.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    requestLogger.log({ originalModel: normalized.originalModel, mappedModel: model, protocol: 'anthropic', endpoint: '/v1/messages', clientIp: c.req.header('x-forwarded-for') || 'unknown', userAgent: c.req.header('user-agent') || 'unknown', thinking: normalized.thinking || false, hasTools: (normalized.tools?.length ?? 0) > 0, streamMode: true, inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0, startTime, endTime: Date.now(), streamCreationMs, success: true, statusCode: 200, accountId: 'unknown' });
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
  normalized: NormalizedRequest,
  timer: RequestTimer,
  streamCreationMs: number
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

  // Parse tool calls from content if tools are present (with deobfuscation)
  let toolCalls: any[] = [];
  let textContent = fullContent;
  if (normalized.tools && normalized.tools.length > 0 && fullContent.includes('<tool_call>')) {
    const tp = new StreamingToolParser(normalized.tools as any);
    const r = tp.feed(fullContent);
    const f = tp.flush();
    toolCalls = [...r.toolCalls, ...f.toolCalls].map(tc => ({
      ...tc,
      name: deobfuscateToolName(tc.name),
    }));
    textContent = r.text + f.text;
    console.log(`[Anthropic] Non-stream: parsed ${toolCalls.length} tool calls from ${fullContent.length} chars`);
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
        content: textContent,
        ...(thinkingContent ? { thinking: thinkingContent } : {}),
        ...(toolCalls.length > 0 ? {
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_use' : 'stop',
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
    streamCreationMs,
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

  // Add tools to system prompt if present (with obfuscation)
  if (normalized.tools && normalized.tools.length > 0) {
    const toolsJson = JSON.stringify(normalized.tools.map(t => ({
      name: obfuscateToolName(t.function.name),
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
  const timer = new RequestTimer();
  const adapter = adapterRegistry.get('gemini')!;
  let activeSession: import('../core/session-manager.js').ChatSession | null = null;

  const releaseMyFlight = () => {
    releaseSessionFlight(activeSession);
    activeSession = null;
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
    const sessionResult = await resolveSession({
      sessionHeader: c.req.header('x-qwenproxy-session-id'),
      messages: normalized.messages || [],
      model: normalized.model,
      busyResponse: (sessionId) => ({
        body: { error: { code: 429, message: `Session ${sessionId} is busy`, status: 'RESOURCE_EXHAUSTED' } },
        status: 429,
      }),
    });

    activeSession = sessionResult.activeSession;
    let deltaStartIndex = sessionResult.deltaStartIndex;

    if (!sessionResult.resolved) {
      return c.json(sessionResult.busyResponse.body, sessionResult.busyResponse.status as any);
    }

    // Build prompt from delta messages only if session active
    const messagesForPrompt = activeSession
      ? normalized.messages.slice(deltaStartIndex)
      : normalized.messages;
    const tempNormalized = activeSession ? { ...normalized, messages: messagesForPrompt } : normalized;
    const finalPrompt = buildPromptFromMessages(tempNormalized);

    // Build session context for createQwenStream
    const sessionContext = await buildSessionContext(activeSession);
    timer.mark('sessionReady');

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
      releaseMyFlight();
      throw lastError || new Error('All accounts failed');
    }

    // ─── Update session state after successful stream creation ──────────
    if (activeSession && normalized.messages?.length) {
      updateSessionState(activeSession, normalized.messages, deltaStartIndex);
    }

    // Add session header to response
    if (activeSession) {
      c.header('X-QwenProxy-Session-Id', activeSession.sessionId);
    }

    timer.mark('streamReady');
    const streamCreationMs = timer.elapsed('sessionReady');

    // Handle streaming vs non-streaming
    if (normalized.stream) {
      const response = await handleGeminiStream(c, stream, adapter, normalized.model, startTime, normalized, timer, streamCreationMs);
      releaseMyFlight();
      return response;
    } else {
      const response = await handleGeminiNonStream(c, stream, adapter, normalized.model, startTime, normalized, timer, streamCreationMs);
      releaseMyFlight();
      return response;
    }
  } catch (err: any) {
    releaseMyFlight();
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
      streamCreationMs: timer.elapsed('sessionReady'),
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
  normalized: NormalizedRequest,
  timer: RequestTimer,
  streamCreationMs: number
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
    streamCreationMs,
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
  normalized: NormalizedRequest,
  timer: RequestTimer,
  streamCreationMs: number
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
    streamCreationMs,
    success: true,
    accountId: 'unknown',
    matchedBy: 'mapping',
  });

  return c.json(response);
}
