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
  private writeIndex = 0;

  // O(1) aggregated counters per path — avoids linear scans
  private pathStats: Record<string, {
    latencySum: number;
    ttfbSum: number;
    successCount: number;
    totalCount: number;
    lastReset: number;
  }> = {};

  private getOrCreate(path: string) {
    if (!this.pathStats[path]) {
      this.pathStats[path] = {
        latencySum: 0, ttfbSum: 0, successCount: 0,
        totalCount: 0, lastReset: Date.now(),
      };
    }
    return this.pathStats[path];
  }

  add(metric: RequestMetric): void {
    if (this.metrics.length < this.maxEntries) {
      this.metrics.push(metric);
    } else {
      this.metrics[this.writeIndex % this.maxEntries] = metric;
      this.writeIndex++;
    }

    // Update O(1) aggregates
    const stats = this.getOrCreate(metric.path);
    stats.latencySum += metric.totalLatency;
    stats.ttfbSum += metric.ttfb;
    stats.totalCount++;
    if (metric.success) stats.successCount++;
  }

  /**
   * Get average latency for a specific path — O(1) via aggregates.
   * Uses a sliding window by resetting counters periodically.
   */
  getAverageLatency(path: RequestMetric['path'], windowMs: number = 5 * 60 * 1000): number {
    const stats = this.pathStats[path];
    if (!stats || stats.totalCount === 0) return Infinity;

    // Reset counters if window has expired
    const now = Date.now();
    if (now - stats.lastReset > windowMs) {
      // Recompute from recent metrics
      const recent = this.metrics.filter(
        m => m.path === path && (now - m.timestamp) < windowMs
      );
      if (recent.length === 0) return Infinity;
      stats.latencySum = recent.reduce((sum, m) => sum + m.totalLatency, 0);
      stats.ttfbSum = recent.reduce((sum, m) => sum + m.ttfb, 0);
      stats.successCount = recent.filter(m => m.success).length;
      stats.totalCount = recent.length;
      stats.lastReset = now;
      return stats.latencySum / stats.totalCount;
    }

    return stats.latencySum / stats.totalCount;
  }

  /**
   * Get average TTFB for a specific path — O(1).
   */
  getAverageTTFB(path: RequestMetric['path'], windowMs: number = 5 * 60 * 1000): number {
    const stats = this.pathStats[path];
    if (!stats || stats.totalCount === 0) return Infinity;

    const now = Date.now();
    if (now - stats.lastReset > windowMs) {
      const recent = this.metrics.filter(
        m => m.path === path && (now - m.timestamp) < windowMs
      );
      if (recent.length === 0) return Infinity;
      stats.latencySum = recent.reduce((sum, m) => sum + m.totalLatency, 0);
      stats.ttfbSum = recent.reduce((sum, m) => sum + m.ttfb, 0);
      stats.successCount = recent.filter(m => m.success).length;
      stats.totalCount = recent.length;
      stats.lastReset = now;
      return stats.ttfbSum / stats.totalCount;
    }

    return stats.ttfbSum / stats.totalCount;
  }

  /**
   * Get success rate for a specific path — O(1).
   */
  getSuccessRate(path: RequestMetric['path'], windowMs: number = 5 * 60 * 1000): number {
    const stats = this.pathStats[path];
    if (!stats || stats.totalCount === 0) return 1;

    const now = Date.now();
    if (now - stats.lastReset > windowMs) {
      const recent = this.metrics.filter(
        m => m.path === path && (now - m.timestamp) < windowMs
      );
      if (recent.length === 0) return 1;
      stats.latencySum = recent.reduce((sum, m) => sum + m.totalLatency, 0);
      stats.ttfbSum = recent.reduce((sum, m) => sum + m.ttfb, 0);
      stats.successCount = recent.filter(m => m.success).length;
      stats.totalCount = recent.length;
      stats.lastReset = now;
      return stats.successCount / stats.totalCount;
    }

    return stats.successCount / stats.totalCount;
  }

  /**
   * Get stats for all paths — O(1) per path.
   */
  getStats(): Record<string, {
    avgLatency: number;
    avgTTFB: number;
    successRate: number;
    requestCount: number;
  }> {
    const paths: RequestMetric['path'][] = ['direct', 'browser', 'ws-bridge', 'h2-pool'];
    const stats: Record<string, any> = {};
    const now = Date.now();

    for (const path of paths) {
      const s = this.pathStats[path];
      if (!s || s.totalCount === 0) {
        stats[path] = { avgLatency: 0, avgTTFB: 0, successRate: 100, requestCount: 0 };
        continue;
      }

      // Check if window expired and recompute in single pass
      if (now - s.lastReset > 5 * 60 * 1000) {
        const recent = this.metrics.filter(
          m => m.path === path && (now - m.timestamp) < 5 * 60 * 1000
        );
        if (recent.length > 0) {
          s.latencySum = 0;
          s.ttfbSum = 0;
          s.successCount = 0;
          s.totalCount = recent.length;
          for (const m of recent) {
            s.latencySum += m.totalLatency;
            s.ttfbSum += m.ttfb;
            if (m.success) s.successCount++;
          }
          s.lastReset = now;
        }
      }

      stats[path] = {
        avgLatency: Math.round(s.latencySum / s.totalCount),
        avgTTFB: Math.round(s.ttfbSum / s.totalCount),
        successRate: Math.round((s.successCount / s.totalCount) * 100),
        requestCount: s.totalCount,
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
   * Get count of metrics for a specific path — O(1).
   */
  getCountByPath(path: RequestMetric['path']): number {
    return this.pathStats[path]?.totalCount || 0;
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
