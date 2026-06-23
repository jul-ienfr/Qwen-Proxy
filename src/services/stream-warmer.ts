import { config } from '../core/config.js';

const WARM_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const HEADER_REFRESH_MARGIN_MS = 60 * 1000; // Refresh headers 1 min before they expire (TTL is 5 min)
const HEADERS_TTL_MS = 5 * 60 * 1000;

let warmerTimer: ReturnType<typeof setInterval> | null = null;
let lastHeaderRefresh: Map<string, number> = new Map();

function log(msg: string) {
  console.log(`[StreamWarmer] ${msg}`);
}

function logWarn(msg: string) {
  console.warn(`[StreamWarmer] ${msg}`);
}

/**
 * Make a lightweight request to Qwen to keep TLS connections and session cookies warm.
 * This is a no-op GET to the models endpoint — minimal bandwidth, keeps the connection alive.
 */
async function pingConnections(accountIds: string[]): Promise<void> {
  for (const accountId of accountIds) {
    try {
      const { getBasicHeaders, getPageForAccount, browserFetch } = await import('./playwright.js');
      const acctId = accountId === '_default' ? undefined : accountId;

      const page = getPageForAccount(acctId);
      if (page && !page.isClosed() && page.url().includes('chat.qwen.ai')) {
        // Lightweight ping via browser fetch (uses existing session)
        await browserFetch(page, 'https://chat.qwen.ai/api/models', {
          method: 'GET',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            'source': 'web',
          },
          timeoutMs: config.timeouts.http,
        }).catch(() => { /* ignore ping failures */ });
      } else {
        // Fallback: direct fetch with basic headers
        const { cookie, userAgent, bxV, bxUa, bxUmidtoken } = await getBasicHeaders(acctId);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.timeouts.http);
        await fetch('https://chat.qwen.ai/api/models', {
          method: 'GET',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'cookie': cookie,
            'referer': 'https://chat.qwen.ai/',
            'user-agent': userAgent,
            'bx-v': bxV,
            'bx-ua': bxUa || '',
            'bx-umidtoken': bxUmidtoken || '',
            'timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            'source': 'web',
          },
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
      }
    } catch {
      // Connection ping failures are non-critical
    }
  }
}

/**
 * Refresh headers for accounts that are approaching their TTL expiry.
 * Prevents stale headers from being served on the next real request.
 */
async function refreshStaleHeaders(accountIds: string[]): Promise<void> {
  const { getQwenHeaders } = await import('./header-interceptor.js');
  const { getAccountCooldownInfo } = await import('../core/account-manager.js');

  for (const accountId of accountIds) {
    const acctId = accountId === '_default' ? undefined : accountId;
    const cooldown = getAccountCooldownInfo(accountId);
    if (cooldown?.onCooldown) continue;

    const lastRefresh = lastHeaderRefresh.get(accountId) || 0;
    const timeSinceRefresh = Date.now() - lastRefresh;

    // Only refresh if headers are older than (TTL - margin)
    if (timeSinceRefresh < HEADERS_TTL_MS - HEADER_REFRESH_MARGIN_MS && lastRefresh > 0) {
      continue;
    }

    try {
      await getQwenHeaders(true, acctId);
      lastHeaderRefresh.set(accountId, Date.now());
      log(`Refreshed headers for account ${accountId}`);
    } catch (err: any) {
      logWarn(`Header refresh failed for ${accountId}: ${err.message}`);
    }
  }
}

/**
 * Pre-create chat sessions to keep the warm pool topped up.
 * Delegates to warmAllPools which handles pool refill logic internally.
 */
async function preCreateSessions(accountIds: string[]): Promise<void> {
  try {
    const { warmAllPools } = await import('./warm-pool.js');
    await warmAllPools(accountIds);
    log(`Pre-created warm pool sessions for ${accountIds.length} account(s)`);
  } catch (err: any) {
    logWarn(`Warm pool pre-creation failed: ${err.message}`);
  }
}

/**
 * Single warm-up tick: ping connections, refresh stale headers, top up warm pool.
 */
async function warmTick(accountIds: string[]): Promise<void> {
  // Run all three tasks concurrently — each handles its own errors
  await Promise.allSettled([
    pingConnections(accountIds),
    refreshStaleHeaders(accountIds),
    preCreateSessions(accountIds),
  ]);
}

/**
 * Start the stream warmer. Schedules a periodic warm-up cycle across all accounts.
 * All errors are caught internally — pre-warming failures never crash the server.
 */
export function startStreamWarmer(): void {
  if (warmerTimer) {
    log('Already running, ignoring duplicate start');
    return;
  }

  const runTick = async () => {
    try {
      const { loadAccounts } = await import('../core/accounts.js');
      const accounts = loadAccounts();
      if (accounts.length === 0) {
        log('No accounts configured, skipping warm-up cycle');
        return;
      }

      const accountIds = accounts.map(a => a.id);
      log(`Running warm-up cycle for ${accountIds.length} account(s)...`);
      await warmTick(accountIds);
      log('Warm-up cycle completed');
    } catch (err: any) {
      logWarn(`Warm-up cycle error: ${err.message}`);
    }
  };

  // Run the first tick after a short delay (let server finish starting)
  setTimeout(() => {
    runTick().catch(() => {});
  }, 30_000);

  warmerTimer = setInterval(() => {
    runTick().catch(() => {});
  }, WARM_INTERVAL_MS);

  log(`Started (interval: ${WARM_INTERVAL_MS / 1000}s, initial delay: 30s)`);
}

/**
 * Stop the stream warmer (for graceful shutdown).
 */
export function stopStreamWarmer(): void {
  if (warmerTimer) {
    clearInterval(warmerTimer);
    warmerTimer = null;
    log('Stopped');
  }
}
