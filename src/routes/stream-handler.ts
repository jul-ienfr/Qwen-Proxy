import type { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { StreamingToolParser } from '../tools/parser.js';
import { QwenStreamParser } from '../utils/qwen-stream-parser.js';
import { getIncrementalDelta, parseQwenErrorPayload } from './sse-parser.js';
import { looksLikeUnwrappedToolCall, parseUnwrappedToolCalls } from './tool-handler.js';
import { removeStream } from '../core/stream-registry.js';
import { updateSessionParent } from '../services/qwen.js';
import { createDirectStreamProxy, extractFast, extractJsonString } from '../services/direct-stream-proxy.js';
import { config } from '../core/config.js';
import { escapeJsonStringFast } from '../utils/fast-escape.js';

export interface StreamHandlerContext {
  stream: ReadableStream;
  completionId: string;
  model: string;
  uiSessionId: string;
  hasTools: boolean;
  tools: any[];
  finalPrompt: string;
  streamOptions?: { include_usage?: boolean };
  sessionId?: string;
  onStreamDone?: () => void;
}

/**
 * Fast streaming response handler — zero-copy SSE passthrough.
 * Bypasses the full JSON.parse → transform → JSON.stringify pipeline.
 * Expected improvement: 10-50x per chunk.
 */
function handleFastStreamingResponse(c: Context, ctx: StreamHandlerContext): any {
  console.log(`[FastStream] Using fast path for ${ctx.completionId} (model: ${ctx.model})`);
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  if (ctx.sessionId) {
    c.header('X-QwenProxy-Session-Id', ctx.sessionId);
  }

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatInterval: any;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    try {
      await streamWriter.write(': heartbeat\n\n');
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch { clearInterval(heartbeatInterval); }
      }, 15000);
      if (heartbeatInterval.unref) heartbeatInterval.unref();

      const proxyStream = createDirectStreamProxy(ctx.stream as any, {
        completionId: ctx.completionId,
        model: ctx.model,
        hasTools: ctx.hasTools,
        uiSessionId: ctx.uiSessionId,
      }, {
        onChunk: async (text: string) => {
          try {
            // Send usage BEFORE [DONE] to respect OpenAI SSE protocol ordering
            if (text.includes('[DONE]')) {
              const usageChunk = JSON.stringify({
                id: ctx.completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: ctx.model,
                choices: [],
                usage,
              });
              await streamWriter.write(`data: ${usageChunk}\n\n`);
            }
            await streamWriter.write(text);
          } catch { /* stream closed */ }
        },
        onDone: () => {},
        onError: (err) => {
          console.warn(`[FastStream] Proxy error:`, err.message);
        },
        onUsage: (promptTokens, completionTokens) => {
          usage.prompt_tokens = promptTokens;
          usage.completion_tokens = completionTokens;
          usage.total_tokens = promptTokens + completionTokens;
        },
      });

      // Pipe the proxy stream — data is written via onChunk callback
      const reader = proxyStream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
      ctx.onStreamDone?.();
    }
  });
}

/**
 * Raw passthrough — forward Qwen SSE bytes directly with zero transformation.
 * For clients that accept native Qwen format (langchain, custom clients).
 * Bypasses all JSON.parse, template rewriting, and delta extraction.
 */
function handleRawPassthrough(c: Context, ctx: StreamHandlerContext): any {
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  if (ctx.sessionId) {
    c.header('X-QwenProxy-Session-Id', ctx.sessionId);
  }

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatInterval: any;
    try {
      await streamWriter.write(': heartbeat\n\n');
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch { clearInterval(heartbeatInterval); }
      }, 15000);
      if (heartbeatInterval.unref) heartbeatInterval.unref();

      // Direct pipe: upstream bytes → client with minimal processing
      const reader = ctx.stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Forward raw bytes as-is (just decode for hono writer)
        await streamWriter.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
      ctx.onStreamDone?.();
    }
  });
}

export function handleStreamingResponse(c: Context, ctx: StreamHandlerContext): any {
  // ─── RAW PASSTHROUGH: Zero transformation ───────────────────────────────
  // When client sends X-QwenProxy-Format: raw, forward Qwen SSE bytes directly
  // with zero transformation overhead. For clients that accept native Qwen format.
  const rawFormat = c.req.header('X-QwenProxy-Format');
  if (rawFormat === 'raw') {
    return handleRawPassthrough(c, ctx);
  }

  // ─── FAST PATH: Zero-Copy Stream Proxy ──────────────────────────────────
  // When fastStreamProxy is enabled AND no tools are needed, use the
  // direct stream proxy for 10-50x faster chunk processing.
  // Falls back to standard path if fast path encounters errors.
  if (config.fastStreamProxy && !ctx.hasTools) {
    try {
      return handleFastStreamingResponse(c, ctx);
    } catch (err: any) {
      console.warn(`[FastStream] Fast path failed, falling back to standard:`, err.message);
      // Fall through to standard path
    }
  }

  // ─── STANDARD PATH: Full parse pipeline ─────────────────────────────────
  const socket = (c.env as any)?.incoming?.socket || (c.req.raw as any).socket;
  if (socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('Connection', 'keep-alive');
  c.header('X-Accel-Buffering', 'no');
  if (ctx.sessionId) {
    c.header('X-QwenProxy-Session-Id', ctx.sessionId);
  }

  return honoStream(c, async (streamWriter: any) => {
    let heartbeatInterval: any;
    try {
      await streamWriter.write(': heartbeat\n\n');
      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch { clearInterval(heartbeatInterval);
        }
      }, 15000);
      if (heartbeatInterval.unref) heartbeatInterval.unref();

      const writeEvent = (data: any) => {
        streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      const createdTimestamp = Math.floor(Date.now() / 1000);

      const fastWriteContent = (content: string) => {
        const escaped = escapeJsonStringFast(content);
        streamWriter.write(`data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":"${ctx.model}","choices":[{"index":0,"delta":{"content":"${escaped}"},"logprobs":null,"finish_reason":null}]}\n\n`);
      };

      const fastWriteReasoning = (content: string) => {
        const escaped = escapeJsonStringFast(content);
        streamWriter.write(`data: {"id":"${ctx.completionId}","object":"chat.completion.chunk","created":${createdTimestamp},"model":"${ctx.model}","choices":[{"index":0,"delta":{"reasoning_content":"${escaped}"},"logprobs":null,"finish_reason":null}]}\n\n`);
      };

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      const reader = ctx.stream.getReader();
      const decoder = new TextDecoder();
      let _reasoningBuffer = '';
      let lastFullContent = '';
      let contentLength = 0;
      let contentSuffix = '';
      let targetResponseId: string | null = null;
      let targetResponseIdSet = false;
      let currentThoughtIndex = 0;
      const toolParser = ctx.hasTools ? new StreamingToolParser(ctx.tools) : null;
      let completionTokens = 0;
      let promptTokens = Math.ceil(ctx.finalPrompt.length / 3.5);

      // Chunked string buffer — avoids O(n²) from repeated concatenation
      const bufChunks: string[] = [];
      let bufTotalLen = 0;
      let bufConsumed = 0;

      function appendToBuf(decoded: string): void {
        bufChunks.push(decoded);
        bufTotalLen += decoded.length;
      }

      function extractLineFromBuf(): string | null {
        for (let ci = 0; ci < bufChunks.length; ci++) {
          const nlIdx = bufChunks[ci].indexOf('\n');
          if (nlIdx !== -1) {
            let line = '';
            for (let j = 0; j < ci; j++) line += bufChunks[j];
            if (nlIdx > 0) line += bufChunks[ci].substring(0, nlIdx);
            const consumedLen = line.length + 1;
            bufConsumed += consumedLen;
            bufChunks.splice(0, ci);
            // Compact buffer: keep only remaining chunks
            if (bufChunks.length > 50) {
              bufChunks.splice(0, Math.floor(bufChunks.length / 2));
            }
            if (bufChunks.length > 0) bufChunks[0] = bufChunks[0].substring(nlIdx + 1);
            bufTotalLen -= consumedLen;
            if (bufTotalLen < 0) bufTotalLen = 0;
            return line;
          }
        }
        return null;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const decoded = decoder.decode(value, { stream: true });
        appendToBuf(decoded);

        let line: string | null;
        while ((line = extractLineFromBuf()) !== null) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            // Don't send [DONE] here — it will be sent after finish_reason/usage
            continue;
          }

          try {
            // Fast path: extract content without JSON.parse for common case
            const fast = extractFast(dataStr);

            // Handle response_id
            if (fast.responseId && !targetResponseIdSet) {
              targetResponseId = fast.responseId;
              targetResponseIdSet = true;
              updateSessionParent(ctx.uiSessionId, fast.responseId);
            }

            // Handle usage
            if (fast.usage) {
              if (fast.usage.output) completionTokens = fast.usage.output;
              if (fast.usage.input) promptTokens = fast.usage.input;
            }

            let vStr = '';
            let foundStr = false;
            let isThinkingChunk = false;

            // Fast path for answer content (no JSON.parse)
            if (fast.content !== null) {
              if (!targetResponseIdSet) {
                // Extract response_id from data if not yet set
                const ridIdx = dataStr.indexOf('"response_id":"');
                if (ridIdx !== -1) {
                  const rid = extractJsonString(dataStr, ridIdx + 15);
                  if (rid) {
                    targetResponseId = rid;
                    targetResponseIdSet = true;
                  }
                }
              }

              // Content chunks are always for the current target in Qwen streams
              const result = getIncrementalDelta(lastFullContent, fast.content, contentLength, contentSuffix);
              vStr = result.delta;
              if (vStr) {
                lastFullContent = result.matchedContent;
                contentLength = result.contentLength;
                contentSuffix = result.contentSuffix;
                foundStr = true;
              }
            } else if (fast.thinking !== null) {
              // Fast path for thinking — need full parse for array structure
              const chunk = JSON.parse(dataStr);
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.extra?.summary_thought?.content) {
                isThinkingChunk = true;
                const thoughts = delta.extra.summary_thought.content;
                if (thoughts.length > currentThoughtIndex) {
                  vStr = thoughts.slice(currentThoughtIndex).join('\n');
                  currentThoughtIndex = thoughts.length;
                  foundStr = true;
                }
              }
            } else if (fast.needsFullParse) {
              // Fallback to full JSON.parse for complex chunks
              const chunk = JSON.parse(dataStr);

              if (chunk['response.created'] && chunk['response.created'].response_id) {
                if (!targetResponseId) {
                  targetResponseId = chunk['response.created'].response_id;
                  targetResponseIdSet = true;
                }
                updateSessionParent(ctx.uiSessionId, chunk['response.created'].response_id);
              } else if (chunk.response_id && !targetResponseIdSet) {
                targetResponseId = chunk.response_id;
                targetResponseIdSet = true;
                updateSessionParent(ctx.uiSessionId, chunk.response_id);
              }

              if (chunk.usage) {
                if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
                if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
              }

              if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta &&
                  (!targetResponseIdSet || chunk.response_id === targetResponseId)) {
                const delta = chunk.choices[0].delta;
                if (delta.phase === 'thinking_summary') {
                  isThinkingChunk = true;
                  if (delta.extra?.summary_thought?.content) {
                    const thoughts = delta.extra.summary_thought.content;
                    if (thoughts.length > currentThoughtIndex) {
                      vStr = thoughts.slice(currentThoughtIndex).join('\n');
                      currentThoughtIndex = thoughts.length;
                      foundStr = true;
                    }
                  }
                } else if (delta.phase === 'answer') {
                  if (delta.content !== undefined) {
                    const result = getIncrementalDelta(lastFullContent, delta.content, contentLength, contentSuffix);
                    vStr = result.delta;
                    if (vStr) {
                      lastFullContent = result.matchedContent;
                      contentLength = result.contentLength;
                      contentSuffix = result.contentSuffix;
                      foundStr = true;
                    }
                  }
                }
              }
            }

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;
              if (isThinkingChunk) {
                _reasoningBuffer += vStr;
                fastWriteReasoning(vStr);
              } else {
                if (ctx.hasTools && toolParser) {
                  const { text, toolCalls } = toolParser.feed(vStr);
                  if (text) {
                    if (looksLikeUnwrappedToolCall(text)) {
                      const unwrappedToolCalls = parseUnwrappedToolCalls(text);
                      const baseIndex = toolParser.getEmittedToolCallCount();
                      for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
                        const tc = unwrappedToolCalls[idx];
                        streamWriter.write(`data: ${JSON.stringify({
                          id: ctx.completionId,
                          object: 'chat.completion.chunk',
                          created: createdTimestamp,
                          model: ctx.model,
                          choices: [makeChoice({
                            tool_calls: [{
                              index: baseIndex + idx,
                              id: tc.id,
                              type: 'function',
                              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                            }]
                          })]
                        })}\n\n`);
                      }
                    } else {
                      fastWriteContent(text);
                    }
                  }
                  for (const tc of toolCalls) {
                    streamWriter.write(`data: ${JSON.stringify({
                      id: ctx.completionId,
                      object: 'chat.completion.chunk',
                      created: createdTimestamp,
                      model: ctx.model,
                      choices: [makeChoice({
                        tool_calls: [{
                          index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc),
                          id: tc.id,
                          type: 'function',
                          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                        }]
                      })]
                    })}\n\n`);
                  }
                } else {
                  if (vStr) fastWriteContent(vStr);
                }
              }
            }
          } catch (e) {
            if (dataStr.length > 10) {
              console.warn(`[Chat] SSE parse error for chunk (${dataStr.length} chars):`, (e as Error).message);
            }
          }
        }
      }

      // Get remaining buffer content for error checking
      const remainingBuffer = bufChunks.join('');
      const upstreamError = parseQwenErrorPayload(remainingBuffer);
      if (upstreamError) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({ content: upstreamError.message })]
        });
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [makeChoice({}, 'stop')]
        });
        streamWriter.write('data: [DONE]\n\n');
        return;
      }

      if (toolParser) {
        const flushResult = toolParser.flush();
        if (flushResult.text) {
          if (ctx.hasTools && looksLikeUnwrappedToolCall(flushResult.text)) {
            const unwrappedToolCalls = parseUnwrappedToolCalls(flushResult.text);
            const baseIndex = toolParser.getEmittedToolCallCount();
            for (let idx = 0; idx < unwrappedToolCalls.length; idx++) {
              const tc = unwrappedToolCalls[idx];
              writeEvent({
                id: ctx.completionId,
                object: 'chat.completion.chunk',
                created: createdTimestamp,
                model: ctx.model,
                choices: [makeChoice({
                  tool_calls: [{
                    index: baseIndex + idx,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                  }]
                })]
              });
            }
          } else {
            writeEvent({
              id: ctx.completionId,
              object: 'chat.completion.chunk',
              created: createdTimestamp,
              model: ctx.model,
              choices: [makeChoice({ content: flushResult.text })]
            });
          }
        }
        for (const tc of flushResult.toolCalls) {
          const idx = toolParser.getEmittedToolCallCount() - flushResult.toolCalls.length + flushResult.toolCalls.indexOf(tc);
          writeEvent({
            id: ctx.completionId,
            object: 'chat.completion.chunk',
            created: createdTimestamp,
            model: ctx.model,
            choices: [makeChoice({
              tool_calls: [{
                index: idx,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
              }]
            })]
          });
        }
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 0 }
      };

      const finalFinishReason = toolParser && toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

      writeEvent({
        id: ctx.completionId,
        object: 'chat.completion.chunk',
        created: createdTimestamp,
        model: ctx.model,
        choices: [makeChoice({}, finalFinishReason)],
        ...(ctx.streamOptions?.include_usage ? {} : { usage })
      });

      if (ctx.streamOptions?.include_usage) {
        writeEvent({
          id: ctx.completionId,
          object: 'chat.completion.chunk',
          created: createdTimestamp,
          model: ctx.model,
          choices: [],
          usage
        });
      }
      streamWriter.write('data: [DONE]\n\n');
    } finally {
      clearInterval(heartbeatInterval);
      removeStream(ctx.completionId);
      ctx.onStreamDone?.();
    }
  });
}

export function handleNonStreamingResponse(
  c: Context,
  stream: ReadableStream,
  completionId: string,
  model: string,
  uiSessionId: string,
  hasTools: boolean,
  tools: any[],
): any {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const toolCallsOut: any[] = [];
    let buffer = '';

    const qwenParser = new QwenStreamParser(uiSessionId, {
      tools: hasTools ? tools : [],
      onThinking: () => {},
      onToolCall: (tc) => {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        });
      },
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;
        qwenParser.parseLine(dataStr);
      }
    }

    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      removeStream(completionId);
      return c.json({ error: { message: upstreamError.message } }, upstreamError.status as any);
    }

    const { text: remainingText, toolCalls: remainingToolCalls } = qwenParser.flush();
    const parserState = qwenParser.state;
    let finalContent = parserState.lastFullContent;
    if (remainingText) finalContent += remainingText;
    for (const tc of remainingToolCalls) {
      toolCallsOut.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
      });
    }

    if (hasTools && toolCallsOut.length === 0) {
      for (const tc of parseUnwrappedToolCalls(finalContent)) {
        toolCallsOut.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        });
      }
      if (toolCallsOut.length > 0) finalContent = '';
    }

    const usage = {
      prompt_tokens: parserState.promptTokens,
      completion_tokens: parserState.completionTokens,
      total_tokens: parserState.promptTokens + parserState.completionTokens,
      prompt_tokens_details: { cached_tokens: 0 }
    };
    const message: any = { role: 'assistant', content: toolCallsOut.length ? null : finalContent };
    if (parserState.reasoningBuffer) message.reasoning_content = parserState.reasoningBuffer;
    if (toolCallsOut.length) toolCallsOut.forEach((tc, idx) => tc.index = idx);
    if (toolCallsOut.length) message.tool_calls = toolCallsOut;

    removeStream(completionId);
    return c.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message,
        logprobs: null,
        finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop'
      }],
      usage
    });
  })();
}
