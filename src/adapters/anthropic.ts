/**
 * Anthropic Protocol Adapter
 * Converts between Anthropic Messages API and OpenAI format
 */

import type {
  ProtocolAdapter,
  NormalizedRequest,
  NormalizedMessage,
  NormalizedResponse,
  NormalizedChoice,
  StreamChunk,
  StreamChoice,
  NormalizedUsage,
  NormalizedToolCall,
} from './types.js';

// Reverse mapping: Qwen model names → Claude model names for responses
const REVERSE_MODEL_MAP: Record<string, string> = {
  'qwen3.7-max': 'claude-opus-4-8',
  'qwen3.7-plus': 'claude-sonnet-4-6',
  'qwen-turbo': 'claude-haiku-4-5',
  'qwen-plus': 'claude-sonnet-4-6',
  'qwen-max': 'claude-opus-4-8',
};

function reverseModelName(model: string): string {
  return REVERSE_MODEL_MAP[model] || model;
}

export class AnthropicAdapter implements ProtocolAdapter {
  name = 'anthropic';

  /**
   * Detect if request is Anthropic format
   */
  detect(path: string, headers: Record<string, string>): boolean {
    // Match /v1/messages or /anthropic/v1/messages
    if (path.includes('/v1/messages') && !path.includes('/chat/completions')) {
      return true;
    }
    // Match x-api-key header (Anthropic uses this)
    if (headers['x-api-key'] && !path.includes('/chat/completions')) {
      return true;
    }
    return false;
  }

  /**
   * Normalize Anthropic request to internal format
   */
  normalizeRequest(raw: any, path: string): NormalizedRequest {
    const messages: NormalizedMessage[] = [];

    // Handle system prompt (Anthropic puts it as a top-level field)
    if (raw.system) {
      const systemContent = typeof raw.system === 'string'
        ? raw.system
        : Array.isArray(raw.system)
          ? raw.system.map((s: any) => s.text || '').join('\n')
          : '';
      if (systemContent) {
        messages.push({ role: 'system', content: systemContent });
      }
    }

    // Convert messages
    if (Array.isArray(raw.messages)) {
      for (const msg of raw.messages) {
        const normalized = this.normalizeMessage(msg);
        if (normalized) messages.push(normalized);
      }
    }

    // Convert tools
    const tools = raw.tools?.map((t: any) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || {},
      },
    }));

    // Determine thinking mode
    let thinking = false;
    let thinkingEffort: 'low' | 'medium' | 'high' | undefined;
    if (raw.thinking) {
      thinking = true;
      if (raw.thinking.type === 'enabled') {
        thinkingEffort = 'high';
      }
    }

    return {
      model: raw.model || 'claude-3-sonnet-20240229',
      originalModel: raw.model || 'claude-3-sonnet-20240229',
      messages,
      stream: raw.stream ?? false,
      tools,
      tool_choice: raw.tool_choice,
      temperature: raw.temperature,
      max_tokens: raw.max_tokens,
      top_p: raw.top_p,
      stop_sequences: raw.stop_sequences,
      thinking,
      thinking_effort: thinkingEffort,
      metadata: {
        anthropicVersion: raw.version,
        metadata: raw.metadata,
      },
    };
  }

  /**
   * Normalize a single Anthropic message
   */
  private normalizeMessage(msg: any): NormalizedMessage | null {
    const role = msg.role;

    if (role === 'user' || role === 'assistant') {
      // Handle content blocks (Anthropic uses content blocks)
      if (Array.isArray(msg.content)) {
        const parts: any[] = [];
        let textContent = '';

        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text;
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            const source = block.source;
            if (source?.type === 'base64') {
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${source.media_type};base64,${source.data}` },
              });
            } else if (source?.type === 'url') {
              parts.push({
                type: 'image_url',
                image_url: { url: source.url },
              });
            }
          } else if (block.type === 'thinking') {
            // Store thinking content for assistant messages
            return {
              role: 'assistant',
              content: textContent || '',
              // @ts-ignore - thinking is an extension
              thinking: block.thinking,
            };
          } else if (block.type === 'tool_use') {
            // Tool call from assistant
            return {
              role: 'assistant',
              content: textContent || '',
              tool_calls: [{
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input || {}),
                },
              }],
            };
          } else if (block.type === 'tool_result') {
            // Tool result from user
            const resultContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => c.text || '').join('')
                : JSON.stringify(block.content);

            return {
              role: 'tool',
              content: resultContent,
              tool_call_id: block.tool_use_id,
            };
          }
        }

        if (parts.length === 1 && parts[0].type === 'text') {
          return { role, content: textContent };
        }
        return { role, content: parts.length > 0 ? parts : textContent };
      }

      // Simple string content
      return { role, content: msg.content || '' };
    }

    return null;
  }

  /**
   * Format normalized response back to Anthropic format
   */
  formatResponse(normalized: NormalizedResponse, raw: any): any {
    const choice = normalized.choices[0];
    if (!choice) {
      return {
        type: 'error',
        error: { type: 'api_error', message: 'No response generated' },
      };
    }

    const content: any[] = [];

    // Add thinking block if present
    if ((choice.message as any).thinking) {
      content.push({
        type: 'thinking',
        thinking: (choice.message as any).thinking,
      });
    }

    // Add text content
    if (choice.message.content) {
      content.push({
        type: 'text',
        text: choice.message.content,
      });
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        });
      }
    }

    return {
      id: normalized.id,
      type: 'message',
      role: 'assistant',
      content: content.length > 0 ? content : [{ type: 'text', text: '' }],
      model: reverseModelName(raw.model || normalized.model),
      stop_reason: this.mapFinishReason(choice.finish_reason),
      usage: normalized.usage ? {
        input_tokens: normalized.usage.prompt_tokens,
        output_tokens: normalized.usage.completion_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      } : undefined,
    };
  }

  /**
   * Format stream chunk for Anthropic format
   */
  formatStreamChunk(chunk: StreamChunk): any {
    const choice = chunk.choices[0];
    if (!choice) return null;

    const events: any[] = [];

    // Content block delta
    if (choice.delta.content) {
      events.push({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: choice.delta.content,
        },
      });
    }

    // Thinking delta
    if ((choice.delta as any).thinking) {
      events.push({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: (choice.delta as any).thinking,
        },
      });
    }

    // Tool call delta
    if (choice.delta.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (tc.id) {
          events.push({
            type: 'content_block_start',
            index: tc.index + 1,
            content_block: {
              type: 'tool_use',
              id: tc.id,
              name: tc.function?.name || '',
            },
          });
        }
        if (tc.function?.arguments) {
          events.push({
            type: 'content_block_delta',
            index: tc.index + 1,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          });
        }
      }
    }

    // Stop reason
    if (choice.finish_reason) {
      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: this.mapFinishReason(choice.finish_reason),
        },
        usage: chunk.usage ? {
          output_tokens: chunk.usage.completion_tokens,
        } : undefined,
      });
    }

    return events;
  }

  /**
   * Format stream start event
   */
  formatStreamStart(model: string): any {
    return {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: reverseModelName(model),
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }

  /**
   * Format stream end event
   */
  formatStreamEnd(usage?: NormalizedUsage): any {
    return {
      type: 'message_stop',
    };
  }

  /**
   * Map OpenAI finish reason to Anthropic stop reason
   */
  private mapFinishReason(reason: string | null): string {
    switch (reason) {
      case 'stop': return 'end_turn';
      case 'length': return 'max_tokens';
      case 'tool_calls': return 'tool_use';
      default: return 'end_turn';
    }
  }
}
