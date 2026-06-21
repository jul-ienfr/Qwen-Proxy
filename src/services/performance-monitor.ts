/**
 * Performance Monitor — Real-time latency tracking and auto-path selection
 *
 * Tracks per-request metrics: TTFB, throughput, total latency.
 * Compares direct vs proxy path performance in real-time.
 * Auto-switches to the fastest path based on measured performance.
 *
 * Expected improvement: 10-30% via intelligent path selection.
 */

// ─── Metrics Storage ─────────────────────────────────────────────────────────

interface RequestMetric {
  path: 'direct' | 'browser' | 'ws-bridge' | 'h2-pool';
  ttfb: number;          // Time to first byte (ms)
  totalLatency: number;  // Total request time (ms)
  throughput: number;    // Bytes per second
  chunkCount: number;
  timestamp: number;
  success: boolean;
  accountId?: string;
}

class PerformanceStore {
  private metrics: RequestMetric[] = [];
  private maxEntries = 10000;

  add(metric: RequestMetric): void {
    this.metrics.push(metric);
    if (this.metrics.length > this.maxEntries) {
      this.metrics = this.metrics.slice(-this.maxEntries);
    }
  }

  /**
   * Get average latency for a specific path over the last N minutes.
   */
  getAverageLatency(path: RequestMetric['path'], windowMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    const recent = this.metrics.filter(
      m => m.path === path && m.success && (now - m.timestamp) < windowMs
    );
    if (recent.length === 0) return Infinity;
    return recent.reduce((sum, m) => sum + m.totalLatency, 0) / recent.length;
  }

  /**
   * Get average TTFB for a specific path.
   */
  getAverageTTFB(path: RequestMetric['path'], windowMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    const recent = this.metrics.filter(
      m => m.path === path && m.success && (now - m.timestamp) < windowMs
    );
    if (recent.length === 0) return Infinity;
    return recent.reduce((sum, m) => sum + m.ttfb, 0) / recent.length;
  }

  /**
   * Get success rate for a specific path.
   */
  getSuccessRate(path: RequestMetric['path'], windowMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    const recent = this.metrics.filter(
      m => m.path === path && (now - m.timestamp) < windowMs
    );
    if (recent.length === 0) return 1;
    const successes = recent.filter(m => m.success).length;
    return successes / recent.length;
  }

  /**
   * Get stats for all paths.
   */
  getStats(): Record<string, {
    avgLatency: number;
    avgTTFB: number;
    successRate: number;
    requestCount: number;
  }> {
    const paths: RequestMetric['path'][] = ['direct', 'browser', 'ws-bridge', 'h2-pool'];
    const stats: Record<string, any> = {};

    for (const path of paths) {
      stats[path] = {
        avgLatency: Math.round(this.getAverageLatency(path)),
        avgTTFB: Math.round(this.getAverageTTFB(path)),
        successRate: Math.round(this.getSuccessRate(path) * 100),
        requestCount: this.metrics.filter(m => m.path === path).length,
      };
    }

    return stats;
  }

  /**
   * Get recent metrics for the dashboard.
   */
  getRecentMetrics(limit: number = 100): RequestMetric[] {
    return this.metrics.slice(-limit);
  }

  /**
   * Get count of metrics for a specific path.
   */
  getCountByPath(path: RequestMetric['path']): number {
    return this.metrics.filter(m => m.path === path).length;
  }
}

// ─── Path Selector ───────────────────────────────────────────────────────────

class PathSelector {
  private currentPath: RequestMetric['path'] = 'direct';
  private lastSwitch = 0;
  private switchCooldownMs = 30000; // Don't switch more often than every 30s

  /**
   * Select the best path based on current performance metrics.
   * Uses a simple scoring algorithm:
   *   score = (1 / avgLatency) * successRate
   */
  selectBestPath(store: PerformanceStore): RequestMetric['path'] {
    const now = Date.now();
    if (now - this.lastSwitch < this.switchCooldownMs) {
      return this.currentPath;
    }

    const paths: RequestMetric['path'][] = ['direct', 'h2-pool', 'browser', 'ws-bridge'];
    let bestPath = 'direct' as RequestMetric['path'];
    let bestScore = 0;

    for (const path of paths) {
      const avgLatency = store.getAverageLatency(path);
      const successRate = store.getSuccessRate(path);
      const requestCount = store.getCountByPath(path);

      // Need at least 5 requests to make a decision
      if (requestCount < 5) continue;

      // Score: higher is better
      const score = (1 / Math.max(avgLatency, 1)) * successRate;

      if (score > bestScore) {
        bestScore = score;
        bestPath = path;
      }
    }

    if (bestPath !== this.currentPath) {
      console.log(`[PerfMonitor] Switching path: ${this.currentPath} → ${bestPath} (score: ${bestScore.toFixed(3)})`);
      this.currentPath = bestPath;
      this.lastSwitch = now;
    }

    return this.currentPath;
  }

  getCurrentPath(): RequestMetric['path'] {
    return this.currentPath;
  }
}

// ─── Timer Utility ───────────────────────────────────────────────────────────

export class RequestTimer {
  private startTime: number;
  private firstByteTime: number = 0;
  private chunkCount = 0;
  private totalBytes = 0;

  constructor() {
    this.startTime = Date.now();
  }

  onFirstByte(): void {
    if (this.firstByteTime === 0) {
      this.firstByteTime = Date.now();
    }
  }

  onChunk(bytes: number): void {
    this.chunkCount++;
    this.totalBytes += bytes;
  }

  finish(success: boolean, path: RequestMetric['path'], accountId?: string): RequestMetric {
    const totalLatency = Date.now() - this.startTime;
    const ttfb = this.firstByteTime > 0 ? this.firstByteTime - this.startTime : totalLatency;
    const throughput = this.totalBytes / (totalLatency / 1000); // bytes/sec

    return {
      path,
      ttfb,
      totalLatency,
      throughput,
      chunkCount: this.chunkCount,
      timestamp: Date.now(),
      success,
      accountId,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

const store = new PerformanceStore();
const selector = new PathSelector();

export function recordMetric(metric: RequestMetric): void {
  store.add(metric);
}

export function getPerformanceStats() {
  return store.getStats();
}

export function getRecentMetrics(limit?: number) {
  return store.getRecentMetrics(limit);
}

export function selectBestPath(): RequestMetric['path'] {
  return selector.selectBestPath(store);
}

export function getCurrentPath(): RequestMetric['path'] {
  return selector.getCurrentPath();
}

export function createTimer(): RequestTimer {
  return new RequestTimer();
}
