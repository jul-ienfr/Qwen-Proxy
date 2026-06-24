import { metrics } from './metrics.js'

const STREAM_TTL_MS = 10 * 60 * 1000; // 10 min — auto-cleanup stale streams
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every 60s

const activeStreams = new Map<string, {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
  createdAt: number;
}>();

// Periodic cleanup of stale streams
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [key, entry] of activeStreams) {
    if (entry.createdAt < cutoff) {
      entry.abortController.abort(); // Signal cleanup
      activeStreams.delete(key);
    }
  }
  metrics.gauge('streams.active', activeStreams.size);
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer?.unref) cleanupTimer.unref();

export function registerStream(key: string, entry: {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
}): void {
  activeStreams.set(key, { ...entry, createdAt: Date.now() })
  metrics.gauge('streams.active', activeStreams.size)
}

export function getStream(key: string): ReturnType<typeof activeStreams.get> {
  return activeStreams.get(key)
}

export function removeStream(key: string): void {
  activeStreams.delete(key)
  metrics.gauge('streams.active', activeStreams.size)
}

export function abortStream(key: string): boolean {
  const entry = activeStreams.get(key)
  if (entry) {
    entry.abortController.abort()
    activeStreams.delete(key)
    metrics.gauge('streams.active', activeStreams.size)
    return true
  }
  return false
}

export function getAllStreams(): Map<string, ReturnType<typeof activeStreams.get> & { createdAt?: number }> {
  return new Map(activeStreams)
}
