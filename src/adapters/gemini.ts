/**
 * Gemini Protocol Adapter
 * Converts between Google Gemini API and OpenAI format
 */

import type {
  ProtocolAdapter,
  NormalizedRequest,
  NormalizedMessage,
  NormalizedResponse,
  StreamChunk,
  NormalizedUsage,
} from './types.js';

export class GeminiAdapter implements ProtocolAdapter {
  name = 'gemini';

  /**
   * Detect if request is Gemini format
   */
  detect(path: string, headers: Record<string, string>): boolean {
    // Match /v1beta/models/* or /v1/models/*
    if (path.includes('/models/') && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
      return true;
    }
    return false;
  }

  /**
   * Extract model name from Gemini path
   * e.g., /v1beta/models/gemini-1.5-pro:generateContent → gemini-1.5-pro
   */
  private extractModelFromPath(path: string): string {
    const match = path.match(/\/models\/([^/:]+)/);
    return match ? match[1] : '';
  }

  /**
   * Check if request is streaming
   */
  private isStreaming(path: string): boolean {
    return path.includes(':streamGenerateContent');
  }

  /**
   * Normalize Gemini request to internal format
   */
  normalizeRequest(raw: any, path: string): NormalizedRequest {
    const model = raw.model || this.extractModelFromPath(path);
    const stream = this.isStreaming(path) || (raw.stream ?? false);
    const messages: NormalizedMessage[] = [];

    // Handle system instruction
    if (raw.systemInstruction) {
      const systemContent = typeof raw.systemInstruction === 'string'
        ? raw.systemInstruction
        : raw.systemInstruction.parts?.map((p: any) => p.text || '').join('\n') || '';
      if (systemContent) {
        messages.push({ role: 'system', content: systemContent });
      }
    }

    // Convert contents
    if (Array.isArray(raw.contents)) {
      for (const content of raw.contents) {
        const role = content.role === 'model' ? 'assistant' : 'user';
        const parts = content.parts || [];

        let textContent = '';
        const multimodalParts: any[] = [];

        for (const part of parts) {
          if (part.text) {
            textContent += part.text;
          } else if (part.inlineData) {
            // Inline base64 data
            multimodalParts.push({
              type: 'image_url',
              image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
            });
          } else if (part.functionCall) {
            // Function call from model
            messages.push({
              role: 'assistant',
              content: textContent || '',
              tool_calls: [{
                id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args || {}),
                },
              }],
            });
            textContent = '';
          } else if (part.functionResponse) {
            // Function response from user
            messages.push({
              role: 'tool',
              content: JSON.stringify(part.functionResponse.response || {}),
              tool_call_id: `call_${Date.now()}`,
            });
          }
        }

        if (textContent || multimodalParts.length > 0) {
          const content = multimodalParts.length > 0
            ? [{ type: 'text', text: textContent }, ...multimodalParts]
            : textContent;
          messages.push({ role: role as any, content });
        }
      }
    }

    // Convert tools
    const tools = raw.tools?.flatMap((toolGroup: any) =>
      toolGroup.functionDeclarations?.map((fn: any) => ({
        type: 'function' as const,
        function: {
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || {},
        },
      })) || []
    );

    // Handle thinking config
    let thinking = false;
    let thinkingEffort: 'low' | 'medium' | 'high' | undefined;
    if (raw.generationConfig?.thinkingConfig) {
      thinking = true;
      if (raw.generationConfig.thinkingConfig.includeThoughts) {
        thinkingEffort = 'high';
      }
    }

    return {
      model,
      originalModel: model,
      messages,
      stream,
      tools: tools?.length > 0 ? tools : undefined,
      temperature: raw.generationConfig?.temperature,
      max_tokens: raw.generationConfig?.maxOutputTokens,
      top_p: raw.generationConfig?.topP,
      stop: raw.generationConfig?.stopSequences,
      thinking,
      thinking_effort: thinkingEffort,
      metadata: {
        safetySettings: raw.safetySettings,
        generationConfig: raw.generationConfig,
      },
    };
  }

  /**
   * Format normalized response back to Gemini format
   */
  formatResponse(normalized: NormalizedResponse, raw: any): any {
    const choice = normalized.choices[0];
    if (!choice) {
      return {
        error: { code: 500, message: 'No response generated', status: 'INTERNAL' },
      };
    }

    const parts: any[] = [];

    // Add thinking if present
    if ((choice.message as any).thinking) {
      parts.push({
        thought: true,
        text: (choice.message as any).thinking,
      });
    }

    // Add text content
    if (choice.message.content) {
      parts.push({ text: choice.message.content });
    }

    // Add function calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || '{}'),
          },
        });
      }
    }

    return {
      candidates: [{
        content: {
          role: 'model',
          parts,
        },
        finishReason: this.mapFinishReason(choice.finish_reason),
        index: 0,
      }],
      usageMetadata: normalized.usage ? {
        promptTokenCount: normalized.usage.prompt_tokens,
        candidatesTokenCount: normalized.usage.completion_tokens,
        totalTokenCount: normalized.usage.total_tokens,
      } : undefined,
    };
  }

  /**
   * Format stream chunk for Gemini format
   */
  formatStreamChunk(chunk: StreamChunk): any {
    const choice = chunk.choices[0];
    if (!choice) return null;

    const parts: any[] = [];

    if (choice.delta.content) {
      parts.push({ text: choice.delta.content });
    }

    if ((choice.delta as any).thinking) {
      parts.push({
        thought: true,
        text: (choice.delta as any).thinking,
      });
    }

    if (choice.delta.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (tc.function?.name) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
            },
          });
        }
      }
    }

    return {
      candidates: [{
        content: {
          role: 'model',
          parts,
        },
        finishReason: choice.finish_reason ? this.mapFinishReason(choice.finish_reason) : undefined,
        index: 0,
      }],
      usageMetadata: chunk.usage ? {
        promptTokenCount: chunk.usage.prompt_tokens,
        candidatesTokenCount: chunk.usage.completion_tokens,
        totalTokenCount: chunk.usage.total_tokens,
      } : undefined,
    };
  }

  /**
   * Format stream start event
   */
  formatStreamStart(model: string): any {
    return {
      candidates: [{
        content: { role: 'model', parts: [] },
        index: 0,
      }],
    };
  }

  /**
   * Format stream end event
   */
  formatStreamEnd(usage?: NormalizedUsage): any {
    return {
      candidates: [{
        content: { role: 'model', parts: [] },
        finishReason: 'STOP',
        index: 0,
      }],
      usageMetadata: usage ? {
        promptTokenCount: usage.prompt_tokens,
        candidatesTokenCount: usage.completion_tokens,
        totalTokenCount: usage.total_tokens,
      } : undefined,
    };
  }

  /**
   * Map OpenAI finish reason to Gemini finish reason
   */
  private mapFinishReason(reason: string | null): string {
    switch (reason) {
      case 'stop': return 'STOP';
      case 'length': return 'MAX_TOKENS';
      case 'tool_calls': return 'OTHER';
      default: return 'STOP';
    }
  }
}
