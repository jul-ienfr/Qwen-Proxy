/**
 * Raw Stream Route — Returns Qwen SSE format without conversion
 *
 * For clients that want to do their own SSE conversion (browser-direct mode).
 * Bypasses the server-side Qwen→OpenAI format conversion entirely.
 *
 * Add `X-Qwen-Response-Format: raw` header to any chat completions request
 * to get the raw Qwen SSE stream.
 */

import type { Context } from 'hono';

/**
 * Check if the client requested raw Qwen format.
 */
export function isRawFormatRequest(c: Context): boolean {
  return c.req.header('X-Qwen-Response-Format') === 'raw';
}

/**
 * Wrap a stream to skip OpenAI format conversion.
 * The stream is passed through as-is from Qwen.
 */
export function passthroughRawStream(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return stream;
}
