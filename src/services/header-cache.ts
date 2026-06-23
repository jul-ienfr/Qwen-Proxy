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

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
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
export function loadCachedHeaders(accountId: string): CachedHeaders | null {
  try {
    const cachePath = getCachePath(accountId);
    if (!fs.existsSync(cachePath)) return null;

    const raw = fs.readFileSync(cachePath, 'utf-8');
    const cache: HeaderCacheFile = JSON.parse(raw);

    const entry = cache.entries[accountId];
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;

    // Fresh cache
    if (age <= CACHE_MAX_AGE_MS) {
      const dbg = getDebugLogger();
      if (dbg.isEnabled()) {
        dbg.log('CACHE', 'header-cache.ts', `[HeaderCache] Loaded cached headers for ${accountId} (${Math.round(age / 1000)}s old)`, { accountId, age: Math.round(age / 1000) });
      }
      return entry;
    }

    // Stale but within fallback window — use as-is rather than block
    if (age <= CACHE_FALLBACK_MAX_AGE_MS) {
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
export function saveCachedHeaders(accountId: string, headers: {
  cookie: string;
  userAgent: string;
  bxV: string;
  bxUa: string;
  bxUmidtoken: string;
}): void {
  try {
    ensureCacheDir();

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
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
    fs.renameSync(tmpPath, cachePath);

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
export function areHeadersValid(accountId: string): boolean {
  const cached = loadCachedHeaders(accountId);
  return cached !== null;
}

/**
 * Get cache stats.
 */
export function getHeaderCacheStats(): {
  cachedAccounts: number;
  oldestAge: number;
  newestAge: number;
} {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('-headers.json'));

    let oldest = Infinity;
    let newest = 0;

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8');
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
