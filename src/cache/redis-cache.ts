/**
 * Redis Cache - Support standard Redis and Upstash REST
 * For serverless deployments (Vercel, Netlify, etc.)
 */

import { config } from '../core/config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RedisCacheConfig {
  url?: string;
  token?: string;
  mode: 'none' | 'redis' | 'upstash';
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  hitRate: number;
}

// ─── Upstash REST Client ─────────────────────────────────────────────────────

class UpstashClient {
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  private async request(command: string[], method: string = 'POST'): Promise<any> {
    const res = await fetch(`${this.url}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });

    if (!res.ok) {
      throw new Error(`Upstash error: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  async get(key: string): Promise<string | null> {
    const result = await this.request(['GET', key]);
    return result.result;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.request(['SETEX', key, String(ttlSeconds), value]);
    } else {
      await this.request(['SET', key, value]);
    }
  }

  async del(key: string): Promise<void> {
    await this.request(['DEL', key]);
  }

  async keys(pattern: string): Promise<string[]> {
    const result = await this.request(['KEYS', pattern]);
    return result.result || [];
  }

  async incr(key: string): Promise<number> {
    const result = await this.request(['INCR', key]);
    return result.result;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.request(['EXPIRE', key, String(seconds)]);
  }

  async ttl(key: string): Promise<number> {
    const result = await this.request(['TTL', key]);
    return result.result;
  }

  async hget(hash: string, field: string): Promise<string | null> {
    const result = await this.request(['HGET', hash, field]);
    return result.result;
  }

  async hset(hash: string, field: string, value: string): Promise<void> {
    await this.request(['HSET', hash, field, value]);
  }

  async hdel(hash: string, field: string): Promise<void> {
    await this.request(['HDEL', hash, field]);
  }

  async hgetall(hash: string): Promise<Record<string, string>> {
    const result = await this.request(['HGETALL', hash]);
    return result.result || {};
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.request(['PING']);
      return result.result === 'PONG';
    } catch {
      return false;
    }
  }
}

// ─── In-Memory Fallback ──────────────────────────────────────────────────────

class MemoryClient {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private hashStore = new Map<string, Map<string, string>>();

  private isExpired(entry: { value: string; expiresAt?: number }): boolean {
    return entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry)) {
      if (entry) this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(this.store.keys()).filter(k => regex.test(k));
  }

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    const val = entry ? parseInt(entry.value) + 1 : 1;
    this.store.set(key, { value: String(val) });
    return val;
  }

  async expire(key: string, seconds: number): Promise<void> {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() + seconds * 1000;
    }
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || !entry.expiresAt) return -1;
    return Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
  }

  async hget(hash: string, field: string): Promise<string | null> {
    return this.hashStore.get(hash)?.get(field) ?? null;
  }

  async hset(hash: string, field: string, value: string): Promise<void> {
    if (!this.hashStore.has(hash)) {
      this.hashStore.set(hash, new Map());
    }
    this.hashStore.get(hash)!.set(field, value);
  }

  async hdel(hash: string, field: string): Promise<void> {
    this.hashStore.get(hash)?.delete(field);
  }

  async hgetall(hash: string): Promise<Record<string, string>> {
    const map = this.hashStore.get(hash);
    if (!map) return {};
    return Object.fromEntries(map);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  getSize(): number {
    return this.store.size;
  }
}

// ─── Redis Cache ─────────────────────────────────────────────────────────────

export class RedisCache {
  private client: UpstashClient | MemoryClient;
  private mode: 'none' | 'redis' | 'upstash';
  private stats: CacheStats = { hits: 0, misses: 0, sets: 0, deletes: 0, hitRate: 0 };

  constructor() {
    const cacheConfig = config.redis || {};
    this.mode = (cacheConfig.mode as 'none' | 'redis' | 'upstash') || 'none';

    if (this.mode === 'upstash' && cacheConfig.url && cacheConfig.token) {
      this.client = new UpstashClient(cacheConfig.url, cacheConfig.token);
      console.log('[RedisCache] Using Upstash REST client');
    } else if (this.mode === 'redis' && cacheConfig.url) {
      // For standard Redis, we use Upstash client as well (compatible protocol)
      this.client = new UpstashClient(cacheConfig.url, cacheConfig.token || '');
      console.log('[RedisCache] Using Redis client');
    } else {
      this.client = new MemoryClient();
      this.mode = 'none';
      console.log('[RedisCache] Using in-memory fallback');
    }
  }

  async get<T = any>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      if (value === null) {
        this.stats.misses++;
        this.updateHitRate();
        return null;
      }
      this.stats.hits++;
      this.updateHitRate();
      return JSON.parse(value) as T;
    } catch (err: any) {
      console.error(`[RedisCache] Get error: ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.client.set(key, serialized, ttlSeconds);
      this.stats.sets++;
    } catch (err: any) {
      console.error(`[RedisCache] Set error: ${err.message}`);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
      this.stats.deletes++;
    } catch (err: any) {
      console.error(`[RedisCache] Del error: ${err.message}`);
    }
  }

  async incr(key: string): Promise<number> {
    try {
      return await this.client.incr(key);
    } catch (err: any) {
      console.error(`[RedisCache] Incr error: ${err.message}`);
      return 0;
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    try {
      await this.client.expire(key, seconds);
    } catch (err: any) {
      console.error(`[RedisCache] Expire error: ${err.message}`);
    }
  }

  async hget(hash: string, field: string): Promise<string | null> {
    try {
      return await this.client.hget(hash, field);
    } catch (err: any) {
      console.error(`[RedisCache] Hget error: ${err.message}`);
      return null;
    }
  }

  async hset(hash: string, field: string, value: string): Promise<void> {
    try {
      await this.client.hset(hash, field, value);
    } catch (err: any) {
      console.error(`[RedisCache] Hset error: ${err.message}`);
    }
  }

  async hgetall(hash: string): Promise<Record<string, string>> {
    try {
      return await this.client.hgetall(hash);
    } catch (err: any) {
      console.error(`[RedisCache] Hgetall error: ${err.message}`);
      return {};
    }
  }

  async ping(): Promise<boolean> {
    try {
      return await this.client.ping();
    } catch {
      return false;
    }
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  getMode(): string {
    return this.mode;
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}

// ─── Auto-detect Redis credentials ───────────────────────────────────────────

export function detectRedisConfig(): RedisCacheConfig {
  // Priority: env vars > Vercel Marketplace > Upstash console
  const url = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.REDIS_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url) {
    if (token || url.includes('upstash.io')) {
      return { url, token, mode: 'upstash' };
    }
    return { url, mode: 'redis' };
  }

  return { mode: 'none' };
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const redisCache = new RedisCache();
