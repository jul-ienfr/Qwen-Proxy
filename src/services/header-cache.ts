/**
 * Header Disk Cache — Persist anti-bot headers across restarts
 *
 * Saves bx-ua, bx-umidtoken, bx-v, cookies to disk.
 * On startup, loads cached headers and validates they're still fresh.
 * Eliminates the 10-30s cold start header interception when headers are valid.
 *
 * Expected improvement: 10-30s saved on cold start.
 */

import fs from 'fs';
import path from 'path';
import { getDebugLogger } from '../core/debug-logger.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'header-cache');
const CACHE_FILE = 'headers.json';
const CACHE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes (headers expire at ~15 min in practice)
const CACHE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000; // 30 min fallback — use stale headers rather than block

// ─── Adaptive TTL — learns per-account header lifetime ──────────────────────
interface AccountLifetime {
  observedLifetimes: number[]; // ms between save and next save (or failure)
  lastSaveTime: number;
  failures: number;
}
const lifetimeTracker = new Map<string, AccountLifetime>();
const MAX_LIFETIME_SAMPLES = 10;

/**
 * Record that headers were saved at this time. Called after successful interception.
 */
export function recordHeaderSave(accountId: string): void {
  const now = Date.now();
  const existing = lifetimeTracker.get(accountId);
  if (existing && existing.lastSaveTime > 0) {
    const lifetime = now - existing.lastSaveTime;
    if (lifetime > 60_000) { // Only record lifetimes > 1 min (skip rapid re-saves)
      existing.observedLifetimes.push(lifetime);
      if (existing.observedLifetimes.length > MAX_LIFETIME_SAMPLES) {
        existing.observedLifetimes.shift();
      }
    }
  }
  if (!existing) {
    lifetimeTracker.set(accountId, { observedLifetimes: [], lastSaveTime: now, failures: 0 });
  } else {
    existing.lastSaveTime = now;
    existing.failures = 0;
  }
}

/**
 * Record a header validation failure (e.g., 401 response).
 */
export function recordHeaderFailure(accountId: string): void {
  const existing = lifetimeTracker.get(accountId);
  if (existing) existing.failures++;
  else lifetimeTracker.set(accountId, { observedLifetimes: [], lastSaveTime: 0, failures: 1 });
}

/**
 * Get adaptive TTL for an account based on observed lifetime history.
 * Returns { maxAge, refreshAt, fallbackAge } in ms.
 */
export function getAdaptiveTTL(accountId: string): { maxAge: number; refreshAt: number; fallbackAge: number } {
  const tracker = lifetimeTracker.get(accountId);
  if (!tracker || tracker.observedLifetimes.length < 3) {
    // Not enough data — use defaults
    return { maxAge: CACHE_MAX_AGE_MS, refreshAt: CACHE_MAX_AGE_MS * 0.7, fallbackAge: CACHE_FALLBACK_MAX_AGE_MS };
  }

  // Use the 25th percentile of observed lifetimes as the safe TTL
  const sorted = [...tracker.observedLifetimes].sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];

  // Clamp between 3 min and 15 min
  const adaptiveMaxAge = Math.max(3 * 60_000, Math.min(15 * 60_000, p25));
  const adaptiveRefreshAt = Math.max(2 * 60_000, p50 * 0.8); // Refresh at 80% of median lifetime

  // If many failures, be more conservative
  const failurePenalty = Math.min(tracker.failures * 0.1, 0.3); // Up to 30% reduction
  const finalMaxAge = Math.round(adaptiveMaxAge * (1 - failurePenalty));

  return {
    maxAge: finalMaxAge,
    refreshAt: Math.round(adaptiveRefreshAt),
    fallbackAge: Math.min(finalMaxAge * 3, CACHE_FALLBACK_MAX_AGE_MS),
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface CachedHeaders {
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
  timestamp: number;
  accountId: string;
}

interface HeaderCacheFile {
  version: number;
  entries: Record<string, CachedHeaders>;
}

// ─── Read/Write ──────────────────────────────────────────────────────────────

async function ensureCacheDir(): Promise<void> {
  try {
    await fs.promises.access(CACHE_DIR);
  } catch {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  }
}

function getCachePath(accountId: string): string {
  const safeId = accountId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safeId}-${CACHE_FILE}`);
}

/**
 * Load cached headers from disk for an account.
 * Returns null if cache is missing or expired beyond fallback threshold.
 */
export async function loadCachedHeaders(accountId: string): Promise<CachedHeaders | null> {
  try {
    const cachePath = getCachePath(accountId);
    let raw: string;
    try {
      raw = await fs.promises.readFile(cachePath, 'utf-8');
    } catch {
      return null; // File doesn't exist or can't be read
    }

    const cache: HeaderCacheFile = JSON.parse(raw);

    const entry = cache.entries[accountId];
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    const ttl = getAdaptiveTTL(accountId);

    // Fresh cache
    if (age <= ttl.maxAge) {
      const dbg = getDebugLogger();
      if (dbg.isEnabled()) {
        dbg.log('CACHE', 'header-cache.ts', `[HeaderCache] Loaded cached headers for ${accountId} (${Math.round(age / 1000)}s old)`, { accountId, age: Math.round(age / 1000) });
      }
      return entry;
    }

    // Stale but within fallback window — use as-is rather than block
    if (age <= ttl.fallbackAge) {
      const dbg = getDebugLogger();
      if (dbg.isEnabled()) {
        dbg.log('CACHE', 'header-cache.ts', `[HeaderCache] Using stale cached headers for ${accountId} (${Math.round(age / 1000)}s old, fallback mode)`, { accountId, age: Math.round(age / 1000) });
      }
      return entry;
    }

    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('CACHE', 'header-cache.ts', `[HeaderCache] Cache expired for ${accountId} (${Math.round(age / 1000)}s old)`, { accountId, age: Math.round(age / 1000) });
    }
    return null;
  } catch (err: any) {
    console.warn(`[HeaderCache] Failed to load cache for ${accountId}:`, err.message);
    return null;
  }
}

/**
 * Save headers to disk for an account.
 */
export async function saveCachedHeaders(accountId: string, headers: {
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
}): Promise<void> {
  try {
    await ensureCacheDir();

    const entry: CachedHeaders = {
      ...headers,
      timestamp: Date.now(),
      accountId,
    };

    const cache: HeaderCacheFile = {
      version: 1,
      entries: { [accountId]: entry },
    };

    const cachePath = getCachePath(accountId);
    const tmpPath = cachePath + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(cache, null, 2));
    await fs.promises.rename(tmpPath, cachePath);

    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('CACHE', 'header-cache.ts', `[HeaderCache] Saved headers for ${accountId}`, { accountId });
    }
  } catch (err: any) {
    console.warn(`[HeaderCache] Failed to save cache for ${accountId}:`, err.message);
  }
}

/**
 * Check if cached headers are still valid (not expired).
 */
export async function areHeadersValid(accountId: string): Promise<boolean> {
  const cached = await loadCachedHeaders(accountId);
  return cached !== null;
}

/**
 * Get cache stats.
 */
export async function getHeaderCacheStats(): Promise<{
  cachedAccounts: number;
  oldestAge: number;
  newestAge: number;
}> {
  try {
    await ensureCacheDir();
    const files = (await fs.promises.readdir(CACHE_DIR)).filter(f => f.endsWith('-headers.json'));

    let oldest = Infinity;
    let newest = 0;

    for (const file of files) {
      try {
        const raw = await fs.promises.readFile(path.join(CACHE_DIR, file), 'utf-8');
        const cache: HeaderCacheFile = JSON.parse(raw);
        for (const entry of Object.values(cache.entries)) {
          const age = Date.now() - entry.timestamp;
          if (age < oldest) oldest = age;
          if (age > newest) newest = age;
        }
      } catch {}
    }

    return {
      cachedAccounts: files.length,
      oldestAge: oldest === Infinity ? 0 : Math.round(oldest / 1000),
      newestAge: Math.round(newest / 1000),
    };
  } catch {
    return { cachedAccounts: 0, oldestAge: 0, newestAge: 0 };
  }
}
