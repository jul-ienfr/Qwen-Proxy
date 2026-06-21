/**
 * Rate Limiter - Rate limiting middleware
 */

import type { Context, Next } from 'hono';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Time window in milliseconds */
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
  count: number;
  resetAt: number;
}

// ─── RateLimiter Class ───────────────────────────────────────────────────────

export class RateLimiter {
  private stores: Map<string, RateLimitStore> = new Map();
  private config: RateLimitConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      windowMs: config.windowMs || 60000, // 1 minute default
      maxRequests: config.maxRequests || 100,
      message: config.message || 'Rate limit exceeded',
      keyGenerator: config.keyGenerator || this.defaultKeyGenerator,
      skipPaths: config.skipPaths || ['/health', '/metrics'],
      skipMethods: config.skipMethods || ['GET'],
    };

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.windowMs);
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

      let store = this.stores.get(key);

      // Create new store or reset if window expired
      if (!store || now > store.resetAt) {
        store = {
          count: 1,
          resetAt: now + this.config.windowMs,
        };
        this.stores.set(key, store);

        // Add rate limit headers
        c.header('X-RateLimit-Limit', String(this.config.maxRequests));
        c.header('X-RateLimit-Remaining', String(this.config.maxRequests - 1));
        c.header('X-RateLimit-Reset', String(Math.ceil(store.resetAt / 1000)));

        return next();
      }

      // Check if rate limit exceeded
      if (store.count >= this.config.maxRequests) {
        const retryAfterMs = store.resetAt - now;
        c.header('X-RateLimit-Limit', String(this.config.maxRequests));
        c.header('X-RateLimit-Remaining', '0');
        c.header('X-RateLimit-Reset', String(Math.ceil(store.resetAt / 1000)));
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

      // Increment count
      store.count++;

      // Add rate limit headers
      c.header('X-RateLimit-Limit', String(this.config.maxRequests));
      c.header('X-RateLimit-Remaining', String(this.config.maxRequests - store.count));
      c.header('X-RateLimit-Reset', String(Math.ceil(store.resetAt / 1000)));

      return next();
    };
  }

  /**
   * Clean up expired stores
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, store] of this.stores) {
      if (now > store.resetAt) {
        this.stores.delete(key);
      }
    }
  }

  /**
   * Stop cleanup interval
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
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
