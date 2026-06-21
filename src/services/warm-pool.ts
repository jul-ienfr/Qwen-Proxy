import { getBasicHeaders, getPageForAccount, browserFetch } from './playwright.js';
import { markAccountRateLimited } from '../core/account-manager.js';
import { config } from '../core/config.js';
import { QwenUpstreamError } from './error-handler.js';
import { CHROME_CLIENT_HINTS } from './browser-manager.js';
import crypto from 'crypto';

const CACHED_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface WarmPoolEntry {
  chatId: string;
  headers: Record<string, string>;
  accountId: string;
  timestamp: number;
}

const warmPool: Map<string, WarmPoolEntry[]> = new Map();

const inFlightWarmChats = new Set<string>();

const refillPromises: Map<string, Promise<void>> = new Map();

const WARM_POOL_SIZE = parseInt(process.env.WARM_POOL_SIZE || '10', 10);
const WARM_POOL_TTL_MS = 10 * 60 * 1000;
const WARM_POOL_LOW_WATER = parseInt(process.env.WARM_POOL_LOW_WATER || '3', 10);
const HEADERS_TTL_MS = 4 * 60 * 1000; // Headers valid for 4 min (browser TTL is 5 min)
const WARM_POOL_PARALLEL = parseInt(process.env.WARM_POOL_PARALLEL || '3', 10); // Parallel chat creation
const WARM_POOL_DELAY_MS = parseInt(process.env.WARM_POOL_DELAY_MS || '500', 10); // Delay between creations

function cleanupStalePool(accountId: string) {
  const pool = warmPool.get(accountId);
  if (!pool) return;
  const now = Date.now();
  const filtered = pool.filter(e => now - e.timestamp <= WARM_POOL_TTL_MS);
  if (filtered.length !== pool.length) warmPool.set(accountId, filtered);
}

function warmChatKey(accountId: string, chatId: string) {
  return `${accountId}:${chatId}`;
}

function markWarmChatInFlight(accountId: string, chatId: string) {
  inFlightWarmChats.add(warmChatKey(accountId, chatId));
}

export function releaseWarmChat(accountId: string, chatId: string) {
  inFlightWarmChats.delete(warmChatKey(accountId, chatId));
}

function isWarmChatInFlight(accountId: string, chatId: string) {
  return inFlightWarmChats.has(warmChatKey(accountId, chatId));
}

function getClientHintsHeaders(): Record<string, string> {
  return {
    'sec-ch-ua': CHROME_CLIENT_HINTS,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
}

async function getBasicQwenHeaders(accountId?: string): Promise<Record<string, string>> {
  const { cookie, userAgent, bxV, bxUa, bxUmidtoken } = await getBasicHeaders(accountId);
  return {
    cookie,
    'user-agent': userAgent,
    'bx-v': bxV,
    'bx-ua': bxUa || '',
    'bx-umidtoken': bxUmidtoken || '',
  };
}

async function createRealQwenChat(header: Record<string, string>, accountId?: string): Promise<string> {
  const page = getPageForAccount(accountId);
  const body = JSON.stringify({
    title: 'Nova Conversa',
    models: ['qwen3.7-plus'],
    chat_mode: 'normal',
    chat_type: 't2t',
    timestamp: Date.now(),
    project_id: '',
  });

  const pageUrl = page?.url() || '';
  const isOnQwenOrigin = pageUrl.includes('chat.qwen.ai');

  if (page && !page.isClosed() && isOnQwenOrigin) {
    try {
      const result = await browserFetch(page, 'https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-request-id': crypto.randomUUID(),
          'timezone': CACHED_TIMEZONE,
        },
        body,
        timeoutMs: config.timeouts.http,
      });

      if (result.status === 429) {
        throw new QwenUpstreamError('Qwen upstream error: RateLimited: Too many requests.', 'RateLimited', 429);
      }
      if (!result.status || result.status >= 400) {
        throw new Error(`Failed to create chat: ${result.status} - ${result.body}`);
      }
      const json = JSON.parse(result.body);
      if (json && json.success === false) {
        const code = json.data?.code || json.code || 'UpstreamError';
        const details = json.data?.details || json.message || 'Qwen returned an error';
        const wait = json.data?.num !== undefined ? ` Wait about ${json.data.num} hour(s) before trying again.` : '';
        let status = 502;
        if (code === 'RateLimited') status = 429;
        throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
      }
      const chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
      if (!chatId) throw new Error(`Unexpected chat response: ${JSON.stringify(json).slice(0, 200)}`);
      return chatId;
    } catch (err: any) {
      if (err instanceof QwenUpstreamError) throw err;
      console.warn('[WarmPool] browserFetch failed for chat creation, falling back to Node.js fetch:', err.message);
    }
  }

  const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      cookie: header['cookie'],
      origin: 'https://chat.qwen.ai',
      referer: 'https://chat.qwen.ai/c/new-chat',
      'user-agent': header['user-agent'],
      'x-request-id': crypto.randomUUID(),
      'bx-v': header['bx-v'],
      'bx-ua': header['bx-ua'] || '',
      'bx-umidtoken': header['bx-umidtoken'] || '',
      ...getClientHintsHeaders(),
    },
    body,
    signal: AbortSignal.timeout(config.timeouts.http),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (response.status === 429) {
      throw new QwenUpstreamError('Qwen upstream error: RateLimited: Too many requests.', 'RateLimited', 429);
    }
    throw new Error(`Failed to create chat: ${response.status} - ${errText}`);
  }
  const json = await response.json();
  if (json && json.success === false) {
    const code = json.data?.code || json.code || 'UpstreamError';
    const details = json.data?.details || json.message || 'Qwen returned an error';
    const wait = json.data?.num !== undefined ? ` Wait about ${json.data.num} hour(s) before trying again.` : '';
    let status = 502;
    if (code === 'RateLimited') status = 429;
    throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
  }
  const chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
  if (!chatId) throw new Error(`Unexpected chat response: ${JSON.stringify(json).slice(0, 200)}`);
  return chatId;
}

async function fetchUnusedChats(headers: Record<string, string>, accountId?: string): Promise<string[]> {
  const page = getPageForAccount(accountId);
  const url = 'https://chat.qwen.ai/api/v2/chats/?page=1&exclude_project=true';
  const reqHeaders: Record<string, string> = {
    'accept': 'application/json, text/plain, */*',
    'x-request-id': crypto.randomUUID(),
    'timezone': CACHED_TIMEZONE,
    'source': 'web',
  };

  let body = '';
  if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
    try {
      const result = await browserFetch(page, url, {
        method: 'GET',
        headers: reqHeaders,
        timeoutMs: config.timeouts.http,
      });
      if (result.status && result.status < 400) {
        body = result.body;
      }
    } catch (err: any) {
      console.warn('[WarmPool] browserFetch failed for chat list, falling back:', err.message);
    }
  }

  if (!body) {
    const response = await fetch(url, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'cookie': headers['cookie'],
        'referer': 'https://chat.qwen.ai/',
        'user-agent': headers['user-agent'],
        'x-request-id': crypto.randomUUID(),
        'bx-v': headers['bx-v'],
        'bx-ua': headers['bx-ua'] || '',
        'bx-umidtoken': headers['bx-umidtoken'] || '',
        'timezone': CACHED_TIMEZONE,
        'source': 'web',
        ...getClientHintsHeaders(),
      },
      signal: AbortSignal.timeout(config.timeouts.http),
    });
    if (!response.ok) return [];
    body = await response.text();
  }

  try {
    const json = JSON.parse(body);
    if (!json.success || !Array.isArray(json.data)) return [];
    const unused: string[] = [];
    for (const chat of json.data) {
      if (chat.title === 'Nova Conversa' && chat.created_at === chat.updated_at) {
        unused.push(chat.id);
      }
    }
    return unused;
  } catch {
    return [];
  }
}

async function refillPoolForAccount(accountId: string) {
  let pool = warmPool.get(accountId);
  if (!pool) { pool = []; warmPool.set(accountId, pool); }
  cleanupStalePool(accountId);
  const need = Math.max(0, WARM_POOL_SIZE - pool.length);
  if (need === 0) return;

  let headers: Record<string, string>;
  try {
    const acctId = accountId === 'global' ? undefined : accountId;
    headers = await getBasicQwenHeaders(acctId);
  } catch (err) {
    console.error(`[WarmPool] header fetch failed for ${accountId}:`, (err as Error).message);
    return;
  }

  const acctId = accountId === 'global' ? undefined : accountId;
  const existingIds = new Set(pool.map(e => e.chatId));

  let reused = 0;
  try {
    const unusedChats = await fetchUnusedChats(headers, acctId);
    for (const chatId of unusedChats) {
      if (reused >= need) break;
      if (existingIds.has(chatId)) continue;
      if (isWarmChatInFlight(accountId, chatId)) continue;
      pool.push({ chatId, headers, accountId, timestamp: Date.now() });
      existingIds.add(chatId);
      reused++;
    }
    if (reused > 0) {
      console.log(`[WarmPool] Reused ${reused} existing unused chats for ${accountId}`);
    }
  } catch (err: any) {
    console.warn(`[WarmPool] Failed to fetch unused chats for ${accountId}:`, err.message);
  }

  const stillNeed = Math.max(0, need - reused);
  if (stillNeed === 0) return;

  // Parallel chat creation with controlled concurrency
  // Creates WARM_POOL_PARALLEL chats at a time, with delay between batches
  const batchSize = Math.min(stillNeed, WARM_POOL_PARALLEL);
  let created = 0;

  for (let batch = 0; batch < stillNeed; batch += batchSize) {
    const currentBatch = Math.min(batchSize, stillNeed - batch);
    const promises: Promise<void>[] = [];

    for (let i = 0; i < currentBatch; i++) {
      promises.push(
        (async () => {
          try {
            const chatId = await createRealQwenChat(headers, acctId);
            pool.push({ chatId, headers, accountId, timestamp: Date.now() });
            created++;
          } catch (err: any) {
            if (err instanceof QwenUpstreamError) {
              if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
                const hourHint = err.message?.match(/Wait about (\d+) hour/);
                const cooldownMs = hourHint ? parseInt(hourHint[1]) * 60 * 60 * 1000 : undefined;
                markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
                console.warn(`[WarmPool] Account ${accountId} rate-limited during chat creation. Marked for cooldown.`);
                return;
              }
            }
            console.error(`[WarmPool] chat creation failed for ${accountId}:`, (err as Error).message);
          }
        })()
      );
    }

    await Promise.all(promises);

    // Delay between batches to avoid rate limiting
    if (batch + batchSize < stillNeed) {
      await sleep(WARM_POOL_DELAY_MS + Math.floor(Math.random() * WARM_POOL_DELAY_MS));
    }
  }

  if (created > 0) {
    console.log(`[WarmPool] Created ${created} chats for ${accountId} (parallel: ${WARM_POOL_PARALLEL})`);
  }
}

export async function getWarmedChat(accountId?: string) {
  const key = accountId || 'global';
  let pool = warmPool.get(key);
  if (!pool) { pool = []; warmPool.set(key, pool); }
  cleanupStalePool(key);

  if (pool.length < WARM_POOL_LOW_WATER && !refillPromises.has(key)) {
    refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
  }

  if (pool.length === 0) {
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) {
    await new Promise(r => setTimeout(r, 200));
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) throw new Error(`Warm pool empty after retry for ${key}`);

  // Skip entries with stale headers (headers expire after ~5 min)
  const now = Date.now();
  while (pool.length > 0 && (now - pool[0].timestamp) > HEADERS_TTL_MS) {
    console.warn(`[WarmPool] Discarding stale chat for ${key} (age: ${Math.round((now - pool[0].timestamp) / 1000)}s)`);
    pool.shift();
  }
  if (pool.length === 0) {
    // Refill with fresh headers
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) throw new Error(`Warm pool empty after discarding stale entries for ${key}`);

  const entry = pool.shift()!;
  markWarmChatInFlight(key, entry.chatId);
  return entry;
}

export async function warmAllPools(accountIds: string[]) {
  for (const id of accountIds) refillPoolForAccount(id).catch(() => {});
}
