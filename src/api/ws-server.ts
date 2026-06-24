/**
 * WebSocket Signaling Server — Browser-Direct Mode
 *
 * Separates the control plane (Node.js) from the data plane (browser).
 * The browser connects directly to Qwen's API, bypassing Node.js entirely
 * for the data path.
 *
 * Architecture:
 *   Browser ←——— WebSocket Signaling ———→ Node.js (auth, headers, accounts)
 *   Browser ←———————————————————————————→ Qwen API (HTTPS direct, zero Node.js)
 *
 * Protocol:
 *   Server → Client:
 *     { type: 'auth:success', accountId, expiresAt }
 *     { type: 'headers:update', headers: { cookie, bxV, bxUa, bxUmidtoken } }
 *     { type: 'chat:ready', chatId, headers }
 *     { type: 'chat:expired', chatId }
 *     { type: 'error', code, message }
 *
 *   Client → Server:
 *     { type: 'auth', apiKey }
 *     { type: 'chat:request', model }
 *     { type: 'chat:done', chatId }
 *     { type: 'heartbeat' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import crypto from 'crypto';
import { config } from '../core/config.js';
import { getQwenHeaders } from '../services/playwright.js';
import { getWarmedChat, releaseWarmChat } from '../services/warm-pool.js';
import { getNextAccount } from '../core/account-manager.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClientState {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  accountId: string | null;
  headers: Record<string, string> | null;
  headerExpiry: number;
  activeChats: Set<string>;
  lastHeartbeat: number;
}

interface SignalingMessage {
  type: string;
  [key: string]: any;
}

// ─── Server ──────────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
const clients = new Map<string, ClientState>();

// Header refresh interval (headers expire after ~5 min, refresh at 4 min)
const HEADER_REFRESH_MS = 4 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 60 * 1000;

/**
 * Initialize the WebSocket signaling server.
 * Attach to the existing HTTP server.
 */
export function initSignalingServer(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws/signaling' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = crypto.randomUUID();
    const client: ClientState = {
      id: clientId,
      ws,
      authenticated: false,
      accountId: null,
      headers: null,
      headerExpiry: 0,
      activeChats: new Set(),
      lastHeartbeat: Date.now(),
    };

    clients.set(clientId, client);
    console.log(`[WSSignaling] Client connected: ${clientId}`);

    ws.on('message', (data: Buffer) => {
      try {
        const msg: SignalingMessage = JSON.parse(data.toString());
        handleMessage(client, msg);
      } catch (err: any) {
        sendError(client, 'PARSE_ERROR', `Invalid message: ${err.message}`);
      }
    });

    ws.on('close', () => {
      console.log(`[WSSignaling] Client disconnected: ${clientId}`);
      // Release any leased chats
      for (const chatId of client.activeChats) {
        releaseWarmChat(client.accountId || '', chatId);
      }
      clients.delete(clientId);
    });

    ws.on('error', (err) => {
      console.error(`[WSSignaling] Client error: ${clientId}:`, err.message);
    });

    // Send welcome
    send(client, { type: 'welcome', clientId, version: '1.0' });
  });

  // Start header refresh cycle
  startHeaderRefreshCycle();

  console.log('[WSSignaling] WebSocket signaling server initialized on /ws/signaling');
}

// ─── Message Handlers ────────────────────────────────────────────────────────

async function handleMessage(client: ClientState, msg: SignalingMessage): Promise<void> {
  switch (msg.type) {
    case 'auth':
      await handleAuth(client, msg);
      break;
    case 'chat:request':
      await handleChatRequest(client, msg);
      break;
    case 'chat:done':
      handleChatDone(client, msg);
      break;
    case 'heartbeat':
      client.lastHeartbeat = Date.now();
      send(client, { type: 'heartbeat:ack', timestamp: Date.now() });
      break;
    default:
      sendError(client, 'UNKNOWN_TYPE', `Unknown message type: ${msg.type}`);
  }
}

async function handleAuth(client: ClientState, msg: SignalingMessage): Promise<void> {
  const apiKey = msg.apiKey || process.env.API_KEY || config.apiKey;

  // Validate API key
  if (apiKey) {
    const tokenBuf = Buffer.from(msg.apiKey || '');
    const keyBuf = Buffer.from(apiKey);
    if (tokenBuf.length !== keyBuf.length || !crypto.timingSafeEqual(tokenBuf, keyBuf)) {
      sendError(client, 'AUTH_FAILED', 'Invalid API key');
      return;
    }
  }

  // Select an account
  const account = getNextAccount();
  if (!account) {
    sendError(client, 'NO_ACCOUNTS', 'No accounts available');
    return;
  }

  client.authenticated = true;
  client.accountId = account.id;

  // Get initial headers
  try {
    const { headers } = await getQwenHeaders(false, account.id);
    client.headers = headers;
    client.headerExpiry = Date.now() + HEADER_REFRESH_MS;

    send(client, {
      type: 'auth:success',
      accountId: account.id,
      expiresAt: client.headerExpiry,
      headers: {
        cookie: headers['cookie'] || '',
        bxV: headers['bx-v'] || '',
        bxUa: headers['bx-ua'] || '',
        bxUmidtoken: headers['bx-umidtoken'] || '',
        userAgent: headers['user-agent'] || '',
      },
    });

    console.log(`[WSSignaling] Client ${client.id} authenticated with account ${account.id}`);
  } catch (err: any) {
    sendError(client, 'AUTH_ERROR', `Failed to get headers: ${err.message}`);
  }
}

async function handleChatRequest(client: ClientState, msg: SignalingMessage): Promise<void> {
  if (!client.authenticated || !client.accountId) {
    sendError(client, 'NOT_AUTHENTICATED', 'Not authenticated');
    return;
  }

  const model = msg.model || 'qwen-plus';

  try {
    // Get a warmed chat session from the pool
    const warmedChat = await getWarmedChat(client.accountId);

    client.activeChats.add(warmedChat.chatId);

    send(client, {
      type: 'chat:ready',
      chatId: warmedChat.chatId,
      model,
      headers: {
        cookie: warmedChat.headers['cookie'] || client.headers?.['cookie'] || '',
        bxV: warmedChat.headers['bx-v'] || client.headers?.['bx-v'] || '',
        bxUa: warmedChat.headers['bx-ua'] || client.headers?.['bx-ua'] || '',
        bxUmidtoken: warmedChat.headers['bx-umidtoken'] || client.headers?.['bx-umidtoken'] || '',
        userAgent: warmedChat.headers['user-agent'] || client.headers?.['user-agent'] || '',
      },
      qwenEndpoint: 'https://chat.qwen.ai/api/v2/chat/completions',
    });

    console.log(`[WSSignaling] Chat ready for client ${client.id}: ${warmedChat.chatId}`);
  } catch (err: any) {
    sendError(client, 'CHAT_ERROR', `Failed to create chat: ${err.message}`);
  }
}

function handleChatDone(client: ClientState, msg: SignalingMessage): void {
  const chatId = msg.chatId;
  if (chatId && client.activeChats.has(chatId)) {
    client.activeChats.delete(chatId);
    releaseWarmChat(client.accountId || '', chatId);
    console.log(`[WSSignaling] Chat released for client ${client.id}: ${chatId}`);
  }
}

// ─── Header Refresh Cycle ────────────────────────────────────────────────────

let headerRefreshTimer: ReturnType<typeof setInterval> | null = null;

function startHeaderRefreshCycle(): void {
  headerRefreshTimer = setInterval(async () => {
    const now = Date.now();

    for (const [, client] of clients) {
      if (!client.authenticated || !client.accountId) continue;

      // Check if headers are about to expire
      if (client.headerExpiry - now < 60000) { // Less than 1 min left
        try {
          const { headers } = await getQwenHeaders(false, client.accountId);
          client.headers = headers;
          client.headerExpiry = now + HEADER_REFRESH_MS;

          send(client, {
            type: 'headers:update',
            headers: {
              cookie: headers['cookie'] || '',
              bxV: headers['bx-v'] || '',
              bxUa: headers['bx-ua'] || '',
              bxUmidtoken: headers['bx-umidtoken'] || '',
              userAgent: headers['user-agent'] || '',
            },
            expiresAt: client.headerExpiry,
          });

          console.log(`[WSSignaling] Headers refreshed for client ${client.id}`);
        } catch (err: any) {
          console.error(`[WSSignaling] Header refresh failed for ${client.id}:`, err.message);
        }
      }
    }
  }, 30000); // Check every 30s
  if (headerRefreshTimer.unref) headerRefreshTimer.unref();
}

// ─── Heartbeat Check ─────────────────────────────────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function stopWsTimers(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (headerRefreshTimer) { clearInterval(headerRefreshTimer); headerRefreshTimer = null; }
}

heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (now - client.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[WSSignaling] Client ${id} timed out (no heartbeat)`);
      // Release any warm chats held by this client before closing
      for (const chatId of client.activeChats) {
        releaseWarmChat(client.accountId || '', chatId);
      }
      client.ws.close();
      clients.delete(id);
    }
  }
}, 30000);
if (heartbeatTimer.unref) heartbeatTimer.unref();

// ─── Utilities ───────────────────────────────────────────────────────────────

function send(client: ClientState, msg: SignalingMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

function sendError(client: ClientState, code: string, message: string): void {
  send(client, { type: 'error', code, message });
}

/**
 * Get stats about the signaling server.
 */
export function getSignalingStats(): {
  connectedClients: number;
  authenticatedClients: number;
  activeChats: number;
} {
  let authenticated = 0;
  let activeChats = 0;

  for (const client of clients.values()) {
    if (client.authenticated) authenticated++;
    activeChats += client.activeChats.size;
  }

  return {
    connectedClients: clients.size,
    authenticatedClients: authenticated,
    activeChats,
  };
}

/**
 * Shutdown the signaling server.
 */
export function shutdownSignalingServer(): void {
  for (const client of clients.values()) {
    client.ws.close();
  }
  clients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
}
