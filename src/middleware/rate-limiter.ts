/**
 * Rate Limiter - Sliding window log algorithm with hot-reload support
 *
 * Uses a per-key array of timestamps instead of a fixed-window counter,
 * eliminating the 2x burst at window boundaries.
 */

import type { Context, Next } from 'hono';
import { getConfigManager, type ConfigChangeEvent } from '../core/config-manager.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Time window in milliseconds (sliding) */
  windowMs: number;
  /** Maximum requests per window */
  maxRequests: number;
  /** Custom error message */
  message?: string;
  /** Key generator function */
  keyGenerator?: (c: Context) => string;
  /** Skip certain paths */
  skipPaths?: string[];
  /** Skip certain methods */
  skipMethods?: string[];
}

interface RateLimitStore {
  /** Array of request timestamps within the sliding window */
  timestamps: number[];
}

// ─── RateLimiter Class ───────────────────────────────────────────────────────

export class RateLimiter {
  private stores: Map<string, RateLimitStore> = new Map();
  private config: RateLimitConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private configUnsubscribe: (() => void) | null = null;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      windowMs: config.windowMs || 60000, // 1 minute default
      maxRequests: config.maxRequests || 100,
      message: config.message || 'Rate limit exceeded',
      keyGenerator: config.keyGenerator || this.defaultKeyGenerator,
      skipPaths: config.skipPaths || ['/health', '/metrics'],
      skipMethods: config.skipMethods || ['GET'],
    };

    // Start cleanup interval (evict fully expired keys every windowMs)
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.windowMs);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    // Subscribe to config changes for hot-reload
    this.configUnsubscribe = this.subscribeToConfigChanges();
  }

  /**
   * Default key generator - uses API key or IP
   */
  private defaultKeyGenerator(c: Context): string {
    const apiKey = c.req.header('x-api-key') || c.req.header('authorization');
    if (apiKey) {
      return `apikey:${apiKey}`;
    }

    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      return `ip:${forwarded.split(',')[0].trim()}`;
    }

    const realIp = c.req.header('x-real-ip');
    if (realIp) {
      return `ip:${realIp}`;
    }

    return 'ip:unknown';
  }

  /**
   * Subscribe to ConfigManager changes for hot-reloadable rate limit settings.
   */
  private subscribeToConfigChanges(): () => void {
    const mgr = getConfigManager();
    const handler = (event: ConfigChangeEvent) => {
      if (event.path === 'rateLimit.windowMs' || event.path === 'rateLimit.maxRequests') {
        const newWindowMs = mgr.get('rateLimit.windowMs') as number | undefined;
        const newMaxRequests = mgr.get('rateLimit.maxRequests') as number | undefined;
        this.updateConfig({
          windowMs: newWindowMs !== undefined ? newWindowMs : undefined,
          maxRequests: newMaxRequests !== undefined ? newMaxRequests : undefined,
        });
      }
    };
    mgr.on('config:change', handler);
    return () => { mgr.off('config:change', handler); };
  }

  /**
   * Hot-reload config. Resets all stores on change.
   */
  updateConfig(newConfig: { windowMs?: number; maxRequests?: number }): void {
    if (newConfig.windowMs !== undefined) this.config.windowMs = newConfig.windowMs;
    if (newConfig.maxRequests !== undefined) this.config.maxRequests = newConfig.maxRequests;
    this.stores.clear(); // Reset all stores on config change
  }

  /**
   * Create Hono middleware
   */
  middleware() {
    return async (c: Context, next: Next) => {
      // Skip certain paths
      const path = c.req.path;
      if (this.config.skipPaths?.some(p => path.startsWith(p))) {
        return next();
      }

      // Skip certain methods
      const method = c.req.method;
      if (this.config.skipMethods?.includes(method)) {
        return next();
      }

      const key = this.config.keyGenerator!(c);
      const now = Date.now();
      const windowStart = now - this.config.windowMs;

      // Get or create store
      let store = this.stores.get(key);
      if (!store) {
        store = { timestamps: [] };
        this.stores.set(key, store);
      }

      // Remove expired timestamps (sliding window: keep only entries within window)
      store.timestamps = store.timestamps.filter(t => t > windowStart);

      // Check if rate limit exceeded
      if (store.timestamps.length >= this.config.maxRequests) {
        const oldestInWindow = store.timestamps[0];
        const retryAfterMs = oldestInWindow + this.config.windowMs - now;

        c.header('X-RateLimit-Limit', String(this.config.maxRequests));
        c.header('X-RateLimit-Remaining', '0');
        c.header('X-RateLimit-Reset', String(Math.ceil((now + retryAfterMs) / 1000)));
        c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));

        return c.json(
          {
            error: {
              code: 'RATE_LIMITED',
              message: this.config.message,
              retryAfterMs,
            },
          },
          429
        );
      }

      // Record this request timestamp
      store.timestamps.push(now);

      // Calculate remaining based on current window count
      const remaining = this.config.maxRequests - store.timestamps.length;

      c.header('X-RateLimit-Limit', String(this.config.maxRequests));
      c.header('X-RateLimit-Remaining', String(remaining));
      // Reset header: when the oldest entry in the current window expires
      const oldest = store.timestamps[0];
      c.header('X-RateLimit-Reset', String(Math.ceil((oldest + this.config.windowMs) / 1000)));

      return next();
    };
  }

  /**
   * Clean up keys where all timestamps have expired
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    for (const [key, store] of this.stores) {
      store.timestamps = store.timestamps.filter(t => t > windowStart);
      if (store.timestamps.length === 0) {
        this.stores.delete(key);
      }
    }
  }

  /**
   * Stop cleanup interval and unsubscribe from config events
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.configUnsubscribe) {
      this.configUnsubscribe();
      this.configUnsubscribe = null;
    }
  }

  /**
   * Get current store for a key (for testing)
   */
  getStore(key: string): RateLimitStore | undefined {
    return this.stores.get(key);
  }

  /**
   * Clear all stores
   */
  clear(): void {
    this.stores.clear();
  }
}

// ─── Factory Functions ───────────────────────────────────────────────────────

/**
 * Create a rate limiter for API endpoints
 */
export function createApiRateLimiter(config?: Partial<RateLimitConfig>): RateLimiter {
  return new RateLimiter({
    windowMs: 60000, // 1 minute
    maxRequests: 100,
    ...config,
  });
}

/**
 * Create a strict rate limiter for sensitive endpoints
 */
export function createStrictRateLimiter(config?: Partial<RateLimitConfig>): RateLimiter {
  return new RateLimiter({
    windowMs: 60000, // 1 minute
    maxRequests: 10,
    message: 'Too many requests to sensitive endpoint',
    ...config,
  });
}
