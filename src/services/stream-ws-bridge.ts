/**
 * WebSocket In-Page Stream Bridge — Zero-CDP Data Transfer
 *
 * Replaces the CDP-based __streamRelay with an in-page WebSocket server.
 * Data flows directly from Chromium's fetch to the WebSocket without
 * crossing the CDP protocol boundary per chunk.
 *
 * Architecture:
 *   Chromium page fetch() → WebSocket (in-page) → Node.js WebSocket client
 *
 * Expected improvement: 50-200x over standard CDP bridge for streaming.
 * CDP is only used for control messages (start/stop/error).
 */

import type { Page } from 'playwright-core';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../core/config.js';
import { getDebugLogger } from '../core/debug-logger.js';
import { startCaptchaWatcher } from './captcha-solver.js';

// ─── WebSocket Server Singleton ──────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let wssPort = 0;

/**
 * Initialize the in-page WebSocket server on a random port.
 * Only called once per process.
 */
async function ensureWSS(): Promise<number> {
  if (wss) return wssPort;

  return new Promise<number>((resolve) => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });

    wss.on('error', (err) => {
      console.error('[WSBridge] WebSocket server error:', err.message);
    });

    wss.on('listening', () => {
      wssPort = (wss!.address() as any)?.port || 0;
      console.log(`[WSBridge] WebSocket server listening on port ${wssPort}`);
      resolve(wssPort);
    });
  });
}

/**
 * Shutdown the WebSocket server.
 */
export function shutdownWSBridge(): void {
  if (wss) {
    wss.close();
    wss = null;
    wssPort = 0;
    console.log('[WSBridge] Shutdown complete');
  }
}

/**
 * Get WebSocket bridge stats.
 */
export function getWSBridgeStats(): {
  serverRunning: boolean;
  port: number;
  activeConnections: number;
} {
  return {
    serverRunning: wss !== null,
    port: wssPort,
    activeConnections: activeConnections.size,
  };
}

// ─── Active Connections ──────────────────────────────────────────────────────

const MAX_ACTIVE_CONNECTIONS = 100;
const CONNECTION_STALE_MS = 5 * 60 * 1000; // 5 minutes

function cleanupStaleConnections(): void {
  const now = Date.now();
  for (const [key, conn] of activeConnections.entries()) {
    if (now - conn.createdAt > CONNECTION_STALE_MS) {
      activeConnections.delete(key);
    }
  }
}

const activeConnections = new Map<string, {
  ws: WebSocket;
  metaResolve: (meta: any) => void;
  metaReject: (err: Error) => void;
  chunkCallback: (chunk: string) => void;
  endCallback: () => void;
  errorCallback: (msg: string) => void;
  bodyCallback: (body: string) => void;
  createdAt: number;
}>();

// ─── Browser-Side WebSocket Client Injection ─────────────────────────────────

const WS_CLIENT_SCRIPT = (port: number, reqId: string) => `
(function() {
  const ws = new WebSocket('ws://127.0.0.1:${port}');
  window.__wsConnections = window.__wsConnections || {};
  window.__wsConnections['${reqId}'] = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'ready', reqId: '${reqId}' }));
  };

  ws.onclose = () => {
    delete window.__wsConnections['${reqId}'];
  };

  ws.onerror = () => {
    delete window.__wsConnections['${reqId}'];
  };
})();
`;

// ─── Stream Fetch via WebSocket ──────────────────────────────────────────────

export async function browserStreamFetchWS(
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
  const port = await ensureWSS();
  const reqId = crypto.randomUUID();
  const enc = new TextEncoder();

  // Enforce max-size guard on activeConnections
  if (activeConnections.size >= MAX_ACTIVE_CONNECTIONS) {
    cleanupStaleConnections();
  }

  // Set up WebSocket connection handler
  const metaPromise = new Promise<{
    status: number;
    statusText: string;
    contentType: string;
    headers: Record<string, string>;
  }>((resolve, reject) => {
    const timeoutMs = options.timeoutMs || config.timeouts.chat;
    const timeout = setTimeout(() => {
      activeConnections.delete(reqId);
      reject(new Error(`WSBridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (ws: WebSocket) => {
      const messageHandler = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.reqId !== reqId) return;

          switch (msg.type) {
            case 'meta':
              clearTimeout(timeout);
              ws.removeListener('message', messageHandler);
              resolve({
                status: msg.status,
                statusText: msg.statusText,
                contentType: msg.contentType,
                headers: msg.headers,
              });
              break;
            case 'error':
              clearTimeout(timeout);
              ws.removeListener('message', messageHandler);
              reject(new Error(msg.message));
              break;
          }
        } catch (err) {
          const dbg = getDebugLogger();
          if (dbg.isEnabled()) {
            dbg.log('STREAM', 'stream-ws-bridge.ts', 'Caught error', { error: (err as Error).message });
          }
        }
      };

      ws.on('message', messageHandler);
    };

    if (wss) {
      wss.on('connection', handler);
      // Clean up listener if timeout fires
      setTimeout(() => {
        wss?.removeListener('connection', handler);
      }, options.timeoutMs || config.timeouts.chat);
    }
  });

  // Inject WebSocket client into the page
  await page.evaluate(({ port, reqId }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    (window as any).__wsConnections = (window as any).__wsConnections || {};
    (window as any).__wsConnections[reqId] = ws;
  }, { port, reqId });

  // Wait for WebSocket to connect
  await new Promise(r => setTimeout(r, 50));

  // Start the fetch in the browser, piping to WebSocket
  const watcher = startCaptchaWatcher(page, options.timeoutMs || config.timeouts.chat);

  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Set up WebSocket message handler for streaming data
        const messageHandler = (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.reqId !== reqId) return;

            switch (msg.type) {
              case 'chunk':
                try {
                  controller.enqueue(enc.encode(msg.data));
                } catch { /* ignore */ }
                break;
              case 'end':
                try { controller.close(); } catch { /* ignore */ }
                wss?.removeListener('message', messageHandler);
                activeConnections.delete(reqId);
                break;
              case 'error':
                try { controller.error(new Error(msg.message)); } catch { /* ignore */ }
                wss?.removeListener('message', messageHandler);
                activeConnections.delete(reqId);
                break;
            }
          } catch (err) {
            const dbg = getDebugLogger();
            if (dbg.isEnabled()) {
              dbg.log('STREAM', 'stream-ws-bridge.ts', 'Caught error', { error: (err as Error).message });
            }
          }
        };

        if (wss) {
          wss.on('message', messageHandler);
        }

        // Execute fetch in browser, relay to WebSocket
        page.evaluate(async ({ url, options, reqId, port }: any) => {
          const controller = new AbortController();
          (window as any).__abortControllers = (window as any).__abortControllers || {};
          (window as any).__abortControllers[reqId] = controller;
          const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 120000);

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

            // Send meta via WebSocket
            const ws = (window as any).__wsConnections?.[reqId];
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({
                type: 'meta',
                reqId,
                status: resp.status,
                statusText: resp.statusText,
                contentType: resp.headers.get('content-type') || '',
                headers: respHeaders,
              }));

              if (!resp.ok || !resp.body) {
                const bodyText = await resp.text();
                ws.send(JSON.stringify({ type: 'body', reqId, data: bodyText }));
                delete (window as any).__abortControllers[reqId];
                return;
              }

              // Stream response body directly to WebSocket
              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  ws.send(JSON.stringify({ type: 'end', reqId }));
                  break;
                }
                const text = decoder.decode(value, { stream: true });
                ws.send(JSON.stringify({ type: 'chunk', reqId, data: text }));
              }
              delete (window as any).__abortControllers[reqId];
            }
          } catch (e: any) {
            clearTimeout(timeoutId);
            const ws = (window as any).__wsConnections?.[reqId];
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'error', reqId, message: e.message }));
            }
            delete (window as any).__abortControllers[reqId];
          }
        }, { url, options, reqId, port }).catch(() => {});
      },
      cancel() {
        page.evaluate((reqId: string) => {
          const c = (window as any).__abortControllers?.[reqId];
          if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
          const ws = (window as any).__wsConnections?.[reqId];
          if (ws) { ws.close(); delete (window as any).__wsConnections[reqId]; }
        }, reqId).catch(() => {});
        activeConnections.delete(reqId);
      },
    });

    const meta = await metaPromise;

    return {
      ...meta,
      stream,
      body: meta.contentType.includes('text/event-stream') ? '' : '',
      reqId,
      abort: () => {
        page.evaluate((reqId: string) => {
          const c = (window as any).__abortControllers?.[reqId];
          if (c) { c.abort(); delete (window as any).__abortControllers[reqId]; }
          const ws = (window as any).__wsConnections?.[reqId];
          if (ws) { ws.close(); delete (window as any).__wsConnections[reqId]; }
        }, reqId).catch(() => {});
        activeConnections.delete(reqId);
      },
    };
  } finally {
    watcher.stop();
  }
}
