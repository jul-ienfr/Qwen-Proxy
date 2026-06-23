/**
 * Smart Proxy Pool - 4-level priority proxy management
 * Adapted from upstream Qwen-Proxy
 *
 * Priority levels:
 *   1. Available + unoccupied (least used)
 *   2. Untested
 *   3. Failed (retry eligible)
 *   4. Available + shared (least occupied)
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { config } from '../core/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks4';

export interface ProxyEntry {
  url: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  status: 'available' | 'failed' | 'untested';
  failCount: number;
  lastFailTime: number;
  lastSuccessTime: number;
  totalRequests: number;
  activeRequests: number;
  lastChecked: number;
}

export interface ProxyPoolStats {
  total: number;
  available: number;
  failed: number;
  untested: number;
  activeRequests: number;
  totalRequests: number;
}

// ─── URL Validation ───────────────────────────────────────────────────────────

const PROXY_URL_RE = /^(https?|socks4|socks5):\/\/([^:]+:[^@]+@)?[^:]+:\d+$/i;

function parseProxyUrl(url: string): { protocol: ProxyProtocol; host: string; port: number } | null {
  try {
    const normalized = url.trim().toLowerCase();
    const match = normalized.match(PROXY_URL_RE);
    if (!match) return null;

    const protocol = match[1] as ProxyProtocol;
    const withoutAuth = normalized.replace(/\/\/[^@]+@/, '//');
    const urlObj = new URL(withoutAuth);

    return {
      protocol,
      host: urlObj.hostname,
      port: urlObj.port ? parseInt(urlObj.port) : (protocol === 'socks5' || protocol === 'socks4' ? 1080 : 80),
    };
  } catch {
    return null;
  }
}

// ─── ProxyPool Class ──────────────────────────────────────────────────────────

export class ProxyPool extends EventEmitter {
  private proxies: Map<string, ProxyEntry> = new Map();
  private maxRetries: number;
  private cooldownMs = 5 * 60 * 1000; // 5 minutes
  private persistPath: string;

  constructor() {
    super();
    this.maxRetries = parseInt(process.env.PROXY_MAX_RETRIES || '3');
    this.persistPath = path.resolve(process.cwd(), 'config', 'proxy-pool.json');

    // Load from env
    this.loadFromEnv();

    // Load persisted state
    this.loadPersistedState();

    console.log(`[ProxyPool] Initialized with ${this.proxies.size} proxy(ies)`);
  }

  /**
   * Load proxies from PROXIES and PROXY_URL env vars
   */
  private loadFromEnv(): void {
    const proxiesEnv = process.env.PROXIES || process.env.PROXY_URL || '';
    if (!proxiesEnv) return;

    const urls = proxiesEnv
      .split(',')
      .map(u => u.trim())
      .filter(Boolean);

    const deduped = [...new Set(urls)];

    for (const url of deduped) {
      const parsed = parseProxyUrl(url);
      if (parsed) {
        const key = `${parsed.host}:${parsed.port}`;
        if (!this.proxies.has(key)) {
          this.proxies.set(key, {
            url,
            protocol: parsed.protocol,
            host: parsed.host,
            port: parsed.port,
            status: 'untested',
            failCount: 0,
            lastFailTime: 0,
            lastSuccessTime: 0,
            totalRequests: 0,
            activeRequests: 0,
            lastChecked: 0,
          });
        }
      } else {
        console.warn(`[ProxyPool] Invalid proxy URL: ${url}`);
      }
    }
  }

  /**
   * Get the best available proxy based on 4-level priority
   */
  getProxy(): ProxyEntry | null {
    const available = Array.from(this.proxies.values())
      .filter(p => p.status !== 'failed' || this.isCooldownExpired(p));

    if (available.length === 0) return null;

    // Sort by priority:
    // 1. Available + unoccupied (activeRequests === 0)
    // 2. Untested
    // 3. Failed but cooldown expired (retry eligible)
    // 4. Available + shared (least occupied)
    available.sort((a, b) => {
      const aPriority = this.getPriority(a);
      const bPriority = this.getPriority(b);
      if (aPriority !== bPriority) return aPriority - bPriority;

      // Within same priority, prefer least occupied
      return a.activeRequests - b.activeRequests;
    });

    return available[0];
  }

  private getPriority(proxy: ProxyEntry): number {
    if (proxy.status === 'available' && proxy.activeRequests === 0) return 1;
    if (proxy.status === 'untested') return 2;
    if (proxy.status === 'failed' && this.isCooldownExpired(proxy)) return 3;
    if (proxy.status === 'available') return 4;
    return 5; // failed, not cooldown expired
  }

  private isCooldownExpired(proxy: ProxyEntry): boolean {
    return Date.now() - proxy.lastFailTime >= this.cooldownMs;
  }

  /**
   * Mark proxy as in-use
   */
  acquire(proxy: ProxyEntry): void {
    proxy.activeRequests++;
    proxy.totalRequests++;
    this.saveState();
  }

  /**
   * Mark proxy as released (success)
   */
  release(proxy: ProxyEntry): void {
    proxy.activeRequests = Math.max(0, proxy.activeRequests - 1);
    proxy.status = 'available';
    proxy.lastSuccessTime = Date.now();
    proxy.lastChecked = Date.now();
    this.saveState();
  }

  /**
   * Mark proxy as failed
   */
  markFailed(proxy: ProxyEntry, error?: Error): void {
    proxy.activeRequests = Math.max(0, proxy.activeRequests - 1);
    proxy.failCount++;
    proxy.lastFailTime = Date.now();
    proxy.lastChecked = Date.now();

    if (proxy.failCount >= this.maxRetries) {
      proxy.status = 'failed';
      console.warn(`[ProxyPool] Proxy ${proxy.host}:${proxy.port} marked as failed after ${proxy.failCount} failures`);
    }

    this.saveState();
    this.emit('proxy:failed', { proxy: proxy.url, error: error?.message });
  }

  /**
   * Add a new proxy
   */
  addProxy(url: string): { success: boolean; error?: string; proxy?: ProxyEntry } {
    const parsed = parseProxyUrl(url);
    if (!parsed) {
      return { success: false, error: 'Invalid proxy URL format' };
    }

    const key = `${parsed.host}:${parsed.port}`;
    if (this.proxies.has(key)) {
      return { success: false, error: 'Proxy already exists' };
    }

    const entry: ProxyEntry = {
      url,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      status: 'untested',
      failCount: 0,
      lastFailTime: 0,
      lastSuccessTime: 0,
      totalRequests: 0,
      activeRequests: 0,
      lastChecked: 0,
    };

    this.proxies.set(key, entry);
    this.saveState();

    console.log(`[ProxyPool] Added proxy: ${url}`);
    this.emit('proxy:added', { proxy: url });

    return { success: true, proxy: entry };
  }

  /**
   * Remove a proxy
   */
  removeProxy(host: string, port: number): { success: boolean; error?: string } {
    const key = `${host}:${port}`;
    const proxy = this.proxies.get(key);

    if (!proxy) {
      return { success: false, error: 'Proxy not found' };
    }

    if (proxy.activeRequests > 0) {
      return { success: false, error: 'Cannot remove proxy with active requests' };
    }

    this.proxies.delete(key);
    this.saveState();

    console.log(`[ProxyPool] Removed proxy: ${host}:${port}`);
    this.emit('proxy:removed', { proxy: proxy.url });

    return { success: true };
  }

  /**
   * Get all proxies
   */
  getAll(): ProxyEntry[] {
    return Array.from(this.proxies.values());
  }

  /**
   * Get pool stats
   */
  getStats(): ProxyPoolStats {
    const all = Array.from(this.proxies.values());
    return {
      total: all.length,
      available: all.filter(p => p.status === 'available').length,
      failed: all.filter(p => p.status === 'failed').length,
      untested: all.filter(p => p.status === 'untested').length,
      activeRequests: all.reduce((sum, p) => sum + p.activeRequests, 0),
      totalRequests: all.reduce((sum, p) => sum + p.totalRequests, 0),
    };
  }

  /**
   * Reset failed proxies (manual reset)
   */
  resetFailed(): number {
    let count = 0;
    for (const proxy of this.proxies.values()) {
      if (proxy.status === 'failed') {
        proxy.status = 'untested';
        proxy.failCount = 0;
        count++;
      }
    }
    this.saveState();
    return count;
  }

  /**
   * Build fetch options with proxy support
   */
  buildFetchOptions(proxy: ProxyEntry, options: RequestInit = {}): RequestInit {
    // For SOCKS5 proxies, we need a proxy agent
    if (proxy.protocol === 'socks5' || proxy.protocol === 'socks4') {
      // Note: SOCKS support requires additional dependencies
      // For now, return basic options
      console.warn(`[ProxyPool] SOCKS proxy support requires additional setup: ${proxy.url}`);
      return options;
    }

    // For HTTP/HTTPS proxies, set the proxy URL
    return {
      ...options,
      // Node.js fetch doesn't natively support proxies
      // We'd need to use a proxy agent here
      // For now, store the proxy info for downstream use
      headers: {
        ...options.headers,
        'x-proxy-url': proxy.url,
      },
    };
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private saveState(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = Object.fromEntries(this.proxies);
      const tmpPath = this.persistPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      fs.renameSync(tmpPath, this.persistPath);
    } catch (err: any) {
      console.error(`[ProxyPool] Failed to save state: ${err.message}`);
    }
  }

  private loadPersistedState(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8');
        const state = JSON.parse(raw);

        for (const [key, entry] of Object.entries(state)) {
          const proxy = entry as ProxyEntry;
          if (!this.proxies.has(key)) {
            this.proxies.set(key, proxy);
          } else {
            // Merge persisted state with env-loaded entry
            const existing = this.proxies.get(key)!;
            existing.totalRequests = proxy.totalRequests || 0;
            existing.lastSuccessTime = proxy.lastSuccessTime || 0;
            existing.status = proxy.status === 'failed' ? 'failed' : existing.status;
          }
        }

        console.log(`[ProxyPool] Loaded persisted state for ${this.proxies.size} proxy(ies)`);
      }
    } catch (err: any) {
      console.error(`[ProxyPool] Failed to load persisted state: ${err.message}`);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let instance: ProxyPool | null = null;

export function getProxyPool(): ProxyPool {
  if (!instance) {
    instance = new ProxyPool();
  }
  return instance;
}

export function initProxyPool(): ProxyPool {
  if (!instance) {
    instance = new ProxyPool();
  }
  return instance;
}
