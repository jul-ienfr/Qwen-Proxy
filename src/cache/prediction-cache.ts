/**
 * Prediction Cache — caches streaming SSE responses for repeated prompts.
 *
 * Uses FNV-1a (32-bit) for fast key hashing instead of SHA-256.
 * Stores up to 500 entries with a 10-minute TTL.
 * On cache hit, replays cached chunks with realistic timing delays.
 */

import { metrics } from '../core/metrics.js';
import { getDebugLogger } from '../core/debug-logger.js';

// ─── FNV-1a 32-bit Hash ────────────────────────────────────────────────────

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/**
 * Compute FNV-1a 32-bit hash of a string. Returns an 8-char hex string.
 * Much faster than BigInt-based 64-bit or SHA-256.
 */
export function fnv1aHash(str: string): string {
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  // Convert to unsigned 32-bit then to hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─── Prediction Cache Store ──────────────────────────────────────────────────

interface PredictionCacheEntry {
  chunks: string[];
  expiresAt: number;
  totalSize: number;
}

const predictionCache = new Map<string, PredictionCacheEntry>();
const PREDICTION_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PREDICTION_CACHE_MAX = 500;

// Periodic cleanup every 60 seconds
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of predictionCache.entries()) {
    if (entry.expiresAt <= now) {
      predictionCache.delete(key);
    }
  }
}, 60000);

// Allow the process to exit even if the interval is still running
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute a prediction cache key from the prompt, model, and thinking flag.
 * Uses FNV-1a instead of SHA-256 for speed.
 */
export function getPredictionCacheKey(prompt: string, model: string, thinking: boolean): string {
  const input = `${model}:${thinking ? '1' : '0'}:${prompt}`;
  return fnv1aHash(input);
}

/**
 * Cache an array of raw SSE chunks for a streaming response.
 * Chunks are stored as they were read from the upstream ReadableStream
 * (raw Uint8Array content decoded to UTF-8 strings).
 */
export function cacheStreamingResponse(key: string, chunks: string[]): void {
  if (chunks.length === 0) return;

  // Calculate total size for memory tracking
  let totalSize = 0;
  for (const chunk of chunks) {
    totalSize += chunk.length;
  }

  // Evict oldest entries if at capacity (LRU: Map preserves insertion order)
  while (predictionCache.size >= PREDICTION_CACHE_MAX) {
    const oldest = predictionCache.keys().next().value;
    if (oldest) {
      const evicted = predictionCache.get(oldest);
      if (evicted) {
        metrics.increment('prediction_cache.evicted');
      }
      predictionCache.delete(oldest);
    } else {
      break;
    }
  }

  predictionCache.set(key, {
    chunks,
    expiresAt: Date.now() + PREDICTION_CACHE_TTL_MS,
    totalSize,
  });

  metrics.increment('prediction_cache.set');
  metrics.histogram('prediction_cache.chunk_count', chunks.length);
  metrics.histogram('prediction_cache.total_size', totalSize);

  const dbg = getDebugLogger();
  if (dbg.isEnabled()) {
    dbg.log('CACHE', 'prediction-cache', `SET: cached ${chunks.length} chunks (${totalSize} bytes)`, {
      key,
      chunkCount: chunks.length,
      totalSize,
      ttlMs: PREDICTION_CACHE_TTL_MS,
    });
  }
}

/**
 * Retrieve cached streaming chunks for a given key.
 * Returns null on cache miss or expired entry.
 * Promotes the entry to most-recently-used on hit.
 */
export function getCachedStreamingChunks(key: string): string[] | null {
  const entry = predictionCache.get(key);

  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) {
      predictionCache.delete(key);
    }
    metrics.increment('prediction_cache.miss');

    const dbg = getDebugLogger();
    if (dbg.isEnabled()) {
      dbg.log('CACHE', 'prediction-cache', `MISS: ${key}`, { key });
    }
    return null;
  }

  // LRU: delete and re-insert to move to end of Map iteration order
  predictionCache.delete(key);
  predictionCache.set(key, entry);

  metrics.increment('prediction_cache.hit');

  const dbg = getDebugLogger();
  if (dbg.isEnabled()) {
    dbg.log('CACHE', 'prediction-cache', `HIT: ${key} (${entry.chunks.length} chunks)`, {
      key,
      chunkCount: entry.chunks.length,
      totalSize: entry.totalSize,
    });
  }

  return entry.chunks;
}

/**
 * Get cache statistics for monitoring.
 */
export function getPredictionCacheStats(): {
  entries: number;
  totalSizeBytes: number;
  maxEntries: number;
  ttlMs: number;
} {
  let totalSize = 0;
  for (const entry of predictionCache.values()) {
    totalSize += entry.totalSize;
  }
  return {
    entries: predictionCache.size,
    totalSizeBytes: totalSize,
    maxEntries: PREDICTION_CACHE_MAX,
    ttlMs: PREDICTION_CACHE_TTL_MS,
  };
}

/**
 * Flush the prediction cache (all or by pattern).
 */
export function flushPredictionCache(pattern?: string): number {
  if (!pattern) {
    const count = predictionCache.size;
    predictionCache.clear();
    return count;
  }
  let count = 0;
  for (const key of predictionCache.keys()) {
    if (key.includes(pattern)) {
      predictionCache.delete(key);
      count++;
    }
  }
  return count;
}

/**
 * Create a ReadableStream that replays cached chunks with realistic timing delays.
 * The delays simulate natural streaming behavior to avoid instant delivery.
 */
export function createReplayStream(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  const encoder = new TextEncoder();

  // Calculate total content length to determine per-chunk delay
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  // Scale delay based on content size: ~2-30ms per chunk, longer for bigger responses
  // This gives a natural streaming feel without being annoyingly slow
  const baseDelay = Math.max(2, Math.min(30, totalLength / 200));

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }

      // Add realistic inter-chunk delay (skip delay for very first chunk)
      if (index > 0) {
        await new Promise<void>(r => setTimeout(r, baseDelay));
      }

      controller.enqueue(encoder.encode(chunks[index]));
      index++;
    },
  });
}
