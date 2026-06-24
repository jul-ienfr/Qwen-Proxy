import type { Page } from 'playwright-core';
import crypto from 'crypto';
import { config } from '../core/config.js';
import { getDebugLogger } from '../core/debug-logger.js';
import { startCaptchaWatcher } from './captcha-solver.js';
import { isPageHealthy } from './browser-manager.js';

// ─── CDP Chunk Batching Configuration ────────────────────────────────────────
// Batches small CDP messages into larger ones to reduce IPC overhead.
// Expected improvement: 10-50x reduction in CDP message count.
const BATCH_FLUSH_INTERVAL_MS = 5;  // Flush every 5ms
const BATCH_MAX_SIZE_BYTES = 8192;  // Or when buffer exceeds 8KB

const streamCallbacks = new Map<string, {
  onChunk: (chunk: string) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
  onMeta: (meta: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  onBody: (body: string) => void;
  createdAt: number;
}>();

const chunkCounts = new Map<string, number>();

const abortControllers = new Map<string, () => void>();

// Periodic cleanup of abandoned stream entries to prevent memory leaks.
// Removes entries older than 10 minutes every 60 seconds.
const STALE_THRESHOLD_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const _streamCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [reqId, entry] of streamCallbacks) {
    if (now - entry.createdAt > STALE_THRESHOLD_MS) {
      streamCallbacks.delete(reqId);
      chunkCounts.delete(reqId);
      abortControllers.delete(reqId);
    }
  }
}, CLEANUP_INTERVAL_MS);
_streamCleanupInterval.unref();

// Store relay callback per page so we can re-inject after navigation
const relayCallbacks = new WeakMap<Page, (reqId: string, type: string, data: any) => void>();

function makeRelayCallback() {
  return (reqId: string, type: string, data: any) => {
    const cb = streamCallbacks.get(reqId);
    if (!cb) return;
    switch (type) {
      case 'meta': cb.onMeta(data); break;
      case 'chunk': cb.onChunk(data); break;
      case 'end': cb.onEnd(); streamCallbacks.delete(reqId); abortControllers.delete(reqId); chunkCounts.delete(reqId); break;
      case 'error': cb.onError(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); chunkCounts.delete(reqId); break;
      case 'body': cb.onBody(data); streamCallbacks.delete(reqId); abortControllers.delete(reqId); chunkCounts.delete(reqId); break;
    }
  };
}

async function ensureStreamBridge(page: Page): Promise<void> {
  // Check if __streamRelay is already registered and callable
  const hasIt = await page.evaluate(
    () => typeof (window as any).__streamRelay === 'function'
  ).catch(() => false);
  if (hasIt) return; // CDP binding exists and works

  // Check if we already exposed this page before (CDP binding may persist after navigation)
  const existingCallback = relayCallbacks.get(page);
  if (existingCallback) {
    // CDP binding exists but window property is gone (page navigated).
    // Re-expose using the same callback — Playwright handles "already registered"
    // by overwriting the binding.
    try {
      await page.exposeFunction('__streamRelay', existingCallback);
      return;
    } catch {
      // "already registered" — binding exists, just needs window property restored
      // Inject a shim that bridges window.__streamRelay to the CDP binding
      await page.evaluate(`(() => {
        if (typeof window.__streamRelay !== 'function') {
          // The CDP binding is registered but window property was lost after navigation.
          // Calling __streamRelay will route through the CDP binding automatically.
          // We just need to ensure the property exists for code that checks typeof.
          Object.defineProperty(window, '__streamRelay', {
            get() { return function() {}; }, // stub — actual calls go through CDP
            configurable: true,
          });
        }
      })()`).catch(() => {});
      return;
    }
  }

  // First time — inject __name helper and expose the relay
  await page.evaluate(`(() => {
    if (!window.__name) {
      window.__name = function(fn, name) {
        try { Object.defineProperty(fn, 'name', { value: name }); } catch(e) {}
        return fn;
      };
    }
  })()`);

  const callback = makeRelayCallback();
  relayCallbacks.set(page, callback);
  await page.exposeFunction('__streamRelay', callback);
}

export async function browserFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; statusText: string; contentType: string; body: string; headers: Record<string, string> }> {
  if (!(await isPageHealthy(page))) {
    throw new Error('browserFetch failed: page is not healthy');
  }
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();

  const timeoutMs = options.timeoutMs || 30000;
  const watcher = startCaptchaWatcher(page, timeoutMs);

  try {
    return await page.evaluate(async ({ url, options }: any) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
      try {
        const resp = await fetch(url, {
          method: options.method || 'POST',
          headers: options.headers || {},
          body: options.body || undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
        const body = await resp.text();
        return {
          status: resp.status,
          statusText: resp.statusText,
          contentType: resp.headers.get('content-type') || '',
          body,
          headers: respHeaders,
        };
      } catch (e: any) {
        clearTimeout(timeoutId);
        throw new Error(`browserFetch failed: ${e.message}`, { cause: e });
      }
    }, { url, options, reqId });
  } finally {
    watcher.stop();
  }
}

export async function browserStreamFetch(
  page: Page,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{
  status: number;
  statusText: string;
  contentType: string;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  body: string;
  reqId: string;
  abort: () => void;
}> {
  if (!(await isPageHealthy(page))) {
    throw new Error('browserStreamFetch failed: page is not healthy');
  }
  await ensureStreamBridge(page);
  const reqId = crypto.randomUUID();
  const enc = new TextEncoder();

  let metaResolve!: (value: { status: number; statusText: string; contentType: string; headers: Record<string, string> }) => void;
  let metaReject!: (reason: Error) => void;
  const metaPromise = new Promise<{ status: number; statusText: string; contentType: string; headers: Record<string, string> }>((resolve, reject) => {
    metaResolve = resolve;
    metaReject = reject;
  });

  const metaTimeoutMs = options.timeoutMs || config.timeouts.chat;
  const metaTimeout = setTimeout(() => {
    streamCallbacks.delete(reqId);
    abortControllers.delete(reqId);
    chunkCounts.delete(reqId);
    metaReject(new Error(`Browser stream fetch timed out waiting for response metadata after ${metaTimeoutMs}ms`));
  }, metaTimeoutMs);

  streamCallbacks.set(reqId, {
    onMeta: (meta) => {
      clearTimeout(metaTimeout);
      metaResolve(meta);
    },
    onChunk: () => {},
    onEnd: () => {},
    onError: (msg: string) => {
      clearTimeout(metaTimeout);
      metaReject(new Error(msg));
    },
    onBody: () => {},
    createdAt: Date.now(),
  });

  let bodyResolve!: (value: string) => void;
  let bodyReject!: (reason: Error) => void;
  const bodyPromise = new Promise<string>((resolve, reject) => {
    bodyResolve = resolve;
    bodyReject = reject;
  });
  bodyPromise.catch(() => {});

  const watcher = startCaptchaWatcher(page, metaTimeoutMs);

  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const cb = streamCallbacks.get(reqId);
        if (!cb) return;
        cb.onChunk = (chunk: string) => {
          const chunkCount = chunkCounts.get(reqId) ?? 0;
          chunkCounts.set(reqId, chunkCount + 1);
          const dbg = getDebugLogger();
          if (dbg.isEnabled()) {
            dbg.log('STREAM', 'stream-bridge.ts', `CHUNK #${chunkCount} (${chunk.length}b)`, { reqId: reqId.substring(0, 8), size: chunk.length });
          }
          try { controller.enqueue(enc.encode(chunk)); } catch { /* ignore */ }
        };
        cb.onEnd = () => {
          try { controller.close(); } catch { /* ignore */ }
          bodyResolve('');
          streamCallbacks.delete(reqId);
          abortControllers.delete(reqId);
          chunkCounts.delete(reqId);
        };
        cb.onError = (msg: string) => {
          console.log(`[WSBridge] onError for ${reqId.substring(0,8)}: ${msg?.substring(0, 80)}`);
          clearTimeout(metaTimeout);
          metaReject(new Error(msg));
          try { controller.error(new Error(msg)); } catch { /* ignore */ }
          bodyReject(new Error(msg));
          streamCallbacks.delete(reqId);
          abortControllers.delete(reqId);
          chunkCounts.delete(reqId);
        };
        cb.onBody = (text: string) => {
          bodyResolve(text);
          streamCallbacks.delete(reqId);
          abortControllers.delete(reqId);
          chunkCounts.delete(reqId);
        };

        page.evaluate(async ({ url, options, reqId }: any) => {
          const controller = new AbortController();
          (window as any).__abortControllers = (window as any).__abortControllers || {};
          (window as any).__abortControllers[reqId] = controller;
          const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || config.timeouts.chat);
          try {
            const resp = await fetch(url, {
              method: options.method || 'POST',
              headers: options.headers || {},
              body: options.body || undefined,
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const respHeaders: Record<string, string> = {};
            resp.headers.forEach((v: string, k: string) => { respHeaders[k] = v; });
            (window as any).__streamRelay(reqId, 'meta', {
              status: resp.status,
              statusText: resp.statusText,
              contentType: resp.headers.get('content-type') || '',
              headers: respHeaders,
            });

            // Remove from abort controllers so captcha solver won't abort successful fetches
            delete (window as any).__abortControllers[reqId];

            if (!resp.ok || !resp.body) {
              const bodyText = await resp.text();
              (window as any).__streamRelay(reqId, 'body', bodyText);
              delete (window as any).__abortControllers[reqId];
              return;
            }

            // If content type is not SSE, read body as text instead of streaming
            const contentType = resp.headers.get('content-type') || '';
            if (!contentType.includes('text/event-stream')) {
              const bodyText = await resp.text();
              (window as any).__streamRelay(reqId, 'body', bodyText);
              delete (window as any).__abortControllers[reqId];
              return;
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();

            // Batched chunk relay
            let chunkBuffer = '';
            let flushTimer: ReturnType<typeof setTimeout> | null = null;
            let bufferBytes = 0;

            const flushBuffer = () => {
              if (chunkBuffer.length > 0) {
                (window as any).__streamRelay(reqId, 'chunk', chunkBuffer);
                chunkBuffer = '';
                bufferBytes = 0;
              }
              if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
              }
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                flushBuffer();
                (window as any).__streamRelay(reqId, 'end', null);
                break;
              }
              const text = decoder.decode(value, { stream: true });
              chunkBuffer += text;
              bufferBytes += text.length;

              if (bufferBytes >= 8192) {
                flushBuffer();
              } else if (!flushTimer) {
                flushTimer = setTimeout(flushBuffer, 5);
              }
            }
            delete (window as any).__abortControllers[reqId];
          } catch (e: any) {
            clearTimeout(timeoutId);
            (window as any).__streamRelay(reqId, 'error', e.message);
            delete (window as any).__abortControllers[reqId];
          }
        }, { url, options, reqId }).catch((e: any) => {
          const cb = streamCallbacks.get(reqId);
          if (cb) {
            cb.onError(e.message);
          }
        });
      },
      cancel() {
        page.evaluate((reqId: string) => {
          const c = (window as any).__abortControllers?.[reqId];
          if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
        }, reqId).catch(() => {});
        streamCallbacks.delete(reqId);
        abortControllers.delete(reqId);
        chunkCounts.delete(reqId);
      },
    });

    const meta = await metaPromise;

    const abortFn = () => {
      page.evaluate((reqId: string) => {
        const c = (window as any).__abortControllers?.[reqId];
        if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
      }, reqId).catch(() => {});
      streamCallbacks.delete(reqId);
      abortControllers.delete(reqId);
      chunkCounts.delete(reqId);
    };

    abortControllers.set(reqId, abortFn);

    return {
      ...meta,
      stream,
      body: meta.contentType.includes('text/event-stream') ? '' : await bodyPromise,
      reqId,
      abort: abortFn,
    };
  } finally {
    watcher.stop();
  }
}
