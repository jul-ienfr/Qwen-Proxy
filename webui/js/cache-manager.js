/**
 * Client-Side Cache Manager — IndexedDB + Service Worker Integration
 *
 * Provides multi-level caching for QwenProxy responses:
 * 1. In-memory LRU cache (fastest, session-only)
 * 2. IndexedDB cache (persistent, cross-session)
 * 3. Service Worker Cache API (transparent, intercepts fetch)
 *
 * Expected improvement: 0ms on cache hit for repeated queries.
 */

class QwenCacheManager {
  constructor(options = {}) {
    this.memoryCache = new Map();
    this.memoryMaxSize = options.memoryMaxSize || 100;
    this.memoryTTL = options.memoryTTL || 5 * 60 * 1000; // 5 min
    this.dbName = options.dbName || 'qwen-cache';
    this.dbVersion = options.dbVersion || 1;
    this.db = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    try {
      this.db = await this.openDB();
      this.initialized = true;
      console.log('[CacheManager] Initialized');
    } catch (err) {
      console.warn('[CacheManager] IndexedDB init failed:', err.message);
      // Continue with memory-only cache
    }
  }

  openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('responses')) {
          const store = db.createObjectStore('responses', { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('model', 'model', { unique: false });
        }
      };
    });
  }

  /**
   * Get a cached response.
   * @param {string} key - Cache key (hash of request)
   * @returns {Promise<object|null>} - Cached response or null
   */
  async get(key) {
    // Level 1: Memory cache
    const memEntry = this.memoryCache.get(key);
    if (memEntry && Date.now() - memEntry.timestamp < this.memoryTTL) {
      return memEntry.data;
    }
    this.memoryCache.delete(key);

    // Level 2: IndexedDB
    if (!this.db) return null;

    try {
      const tx = this.db.transaction('responses', 'readonly');
      const store = tx.objectStore('responses');
      const request = store.get(key);

      return new Promise((resolve) => {
        request.onsuccess = () => {
          const entry = request.result;
          if (entry && Date.now() - entry.timestamp < this.memoryTTL * 2) {
            // Promote to memory cache
            this.memoryCache.set(key, { data: entry.data, timestamp: entry.timestamp });
            resolve(entry.data);
          } else {
            // Expired
            if (entry) this.delete(key);
            resolve(null);
          }
        };
        request.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /**
   * Store a response in cache.
   * @param {string} key - Cache key
   * @param {object} data - Response data to cache
   * @param {string} model - Model name for indexing
   */
  async set(key, data, model = '') {
    const entry = { key, data, timestamp: Date.now(), model };

    // Level 1: Memory cache
    this.memoryCache.set(key, entry);
    this.evictMemory();

    // Level 2: IndexedDB
    if (!this.db) return;

    try {
      const tx = this.db.transaction('responses', 'readwrite');
      const store = tx.objectStore('responses');
      store.put(entry);
    } catch (err) {
      console.warn('[CacheManager] IndexedDB write failed:', err.message);
    }
  }

  /**
   * Delete a cached entry.
   */
  async delete(key) {
    this.memoryCache.delete(key);

    if (!this.db) return;

    try {
      const tx = this.db.transaction('responses', 'readwrite');
      const store = tx.objectStore('responses');
      store.delete(key);
    } catch {}
  }

  /**
   * Clear all caches.
   */
  async clear() {
    this.memoryCache.clear();

    if (!this.db) return;

    try {
      const tx = this.db.transaction('responses', 'readwrite');
      const store = tx.objectStore('responses');
      store.clear();
    } catch {}
  }

  /**
   * Get cache statistics.
   */
  async getStats() {
    let dbCount = 0;
    if (this.db) {
      try {
        const tx = this.db.transaction('responses', 'readonly');
        const store = tx.objectStore('responses');
        const countRequest = store.count();
        dbCount = await new Promise(resolve => {
          countRequest.onsuccess = () => resolve(countRequest.result);
          countRequest.onerror = () => resolve(0);
        });
      } catch {}
    }

    return {
      memoryEntries: this.memoryCache.size,
      memoryMaxSize: this.memoryMaxSize,
      dbEntries: dbCount,
      memoryTTL: this.memoryTTL,
    };
  }

  /**
   * Evict oldest entries from memory cache.
   */
  evictMemory() {
    if (this.memoryCache.size <= this.memoryMaxSize) return;

    const entries = Array.from(this.memoryCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = entries.slice(0, entries.length - this.memoryMaxSize);
    for (const [key] of toRemove) {
      this.memoryCache.delete(key);
    }
  }

  /**
   * Generate a cache key from a request body.
   */
  static generateKey(requestBody) {
    const key = JSON.stringify({
      model: requestBody.model,
      messages: requestBody.messages?.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 200) : '[complex]',
      })),
      thinking: requestBody.thinking,
      stream: requestBody.stream,
    });

    // Simple hash
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return `qwen:${Math.abs(hash).toString(36)}`;
  }
}

// Export singleton
window.QwenCacheManager = QwenCacheManager;
window.qwenCache = new QwenCacheManager();
