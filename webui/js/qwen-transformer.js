/**
 * Qwen → OpenAI SSE Transformer (Client-Side)
 *
 * Transforms Qwen's proprietary SSE format to OpenAI-compatible format
 * directly in the browser, eliminating server-side conversion overhead.
 *
 * Expected improvement: 50-200ms saved per response.
 *
 * Usage:
 *   const transformer = new QwenToOpenAITransformer(completionId, model);
 *   const openaiStream = transformer.transform(qwenResponse.body);
 */

class QwenToOpenAITransformer {
  constructor(completionId, model) {
    this.completionId = completionId;
    this.model = model;
    this.createdTimestamp = Math.floor(Date.now() / 1000);
    this.lastFullContent = '';
    this.contentLength = 0;
    this.contentSuffix = '';
    this.currentThoughtIndex = 0;
    this.targetResponseId = null;
    this.targetResponseIdSet = false;
  }

  /**
   * Transform a Qwen SSE stream to OpenAI format.
   * @param {ReadableStream} qwenStream - Raw Qwen SSE stream
   * @returns {ReadableStream} - OpenAI-format SSE stream
   */
  transform(qwenStream) {
    const self = this;
    const encoder = new TextEncoder();

    return new ReadableStream({
      async start(controller) {
        // Send initial role chunk
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            id: self.completionId,
            object: 'chat.completion.chunk',
            created: self.createdTimestamp,
            model: self.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }]
          })}\n\n`
        ));

        const reader = qwenStream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let bufferOffset = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            while (bufferOffset < buffer.length) {
              const newlineIdx = buffer.indexOf('\n', bufferOffset);
              if (newlineIdx === -1) break;

              const line = buffer.slice(bufferOffset, newlineIdx);
              bufferOffset = newlineIdx + 1;

              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;

              const dataStr = trimmed.slice(6);
              if (dataStr === '[DONE]') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }

              try {
                const chunk = JSON.parse(dataStr);

                // Handle response.created
                if (chunk['response.created']?.response_id) {
                  if (!self.targetResponseId) {
                    self.targetResponseId = chunk['response.created'].response_id;
                    self.targetResponseIdSet = true;
                  }
                } else if (chunk.response_id && !self.targetResponseIdSet) {
                  self.targetResponseId = chunk.response_id;
                  self.targetResponseIdSet = true;
                }

                // Handle delta content
                if (chunk.choices?.[0]?.delta) {
                  const delta = chunk.choices[0].delta;
                  const isTarget = !self.targetResponseIdSet || chunk.response_id === self.targetResponseId;

                  if (isTarget) {
                    if (delta.phase === 'thinking_summary' && delta.extra?.summary_thought?.content) {
                      const thoughts = delta.extra.summary_thought.content;
                      if (thoughts.length > self.currentThoughtIndex) {
                        const newThoughts = thoughts.slice(self.currentThoughtIndex).join('\n');
                        self.currentThoughtIndex = thoughts.length;

                        controller.enqueue(encoder.encode(
                          `data: ${JSON.stringify({
                            id: self.completionId,
                            object: 'chat.completion.chunk',
                            created: self.createdTimestamp,
                            model: self.model,
                            choices: [{ index: 0, delta: { reasoning_content: newThoughts }, logprobs: null, finish_reason: null }]
                          })}\n\n`
                        ));
                      }
                    } else if (delta.phase === 'answer' && delta.content !== undefined) {
                      const newContent = delta.content || '';
                      let deltaStr = '';

                      if (!self.lastFullContent) {
                        deltaStr = newContent;
                        self.lastFullContent = newContent;
                        self.contentLength = newContent.length;
                        self.contentSuffix = newContent.slice(-64);
                      } else if (newContent.length > self.contentLength && self.contentLength > 0) {
                        deltaStr = newContent.slice(self.contentLength);
                        self.lastFullContent = newContent;
                        self.contentLength = newContent.length;
                        self.contentSuffix = newContent.slice(-64);
                      } else if (newContent !== self.lastFullContent) {
                        deltaStr = newContent;
                        self.lastFullContent = newContent;
                        self.contentLength = newContent.length;
                        self.contentSuffix = newContent.slice(-64);
                      }

                      if (deltaStr && deltaStr !== 'FINISHED') {
                        controller.enqueue(encoder.encode(
                          `data: ${JSON.stringify({
                            id: self.completionId,
                            object: 'chat.completion.chunk',
                            created: self.createdTimestamp,
                            model: self.model,
                            choices: [{ index: 0, delta: { content: deltaStr }, logprobs: null, finish_reason: null }]
                          })}\n\n`
                        ));
                      }
                    }
                  }
                }

                // Handle usage
                if (chunk.usage) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({
                      id: self.completionId,
                      object: 'chat.completion.chunk',
                      created: self.createdTimestamp,
                      model: self.model,
                      choices: [],
                      usage: chunk.usage
                    })}\n\n`
                  ));
                }
              } catch {
                // Skip malformed chunks
              }
            }

            if (bufferOffset > 0) {
              buffer = buffer.slice(bufferOffset);
              bufferOffset = 0;
            }
          }

          controller.close();
        } catch (err) {
          controller.error(err);
        }
      }
    });
  }
}

// Export
window.QwenToOpenAITransformer = QwenToOpenAITransformer;
