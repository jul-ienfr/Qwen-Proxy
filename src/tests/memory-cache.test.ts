import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryCache } from '../cache/memory-cache.js'

// Use CacheKey type prefix format
const K = {
  auth: (s: string) => `auth:${s}` as const,
  session: (s: string) => `session:${s}` as const,
  prompt: (s: string) => `prompt:${s}` as const,
  response: (s: string) => `response:${s}` as const,
  rate: (s: string) => `rate:${s}` as const,
  models: (s: string) => `models:${s}` as const,
}

describe('MemoryCache', () => {
  let cache: MemoryCache

  beforeEach(() => {
    cache = new MemoryCache({ prefix: 'test:', defaultTTL: 5000, maxEntries: 100 })
  })

  afterEach(async () => {
    await cache.close()
  })

  // ─── Basic get/set ──────────────────────────────────────────────────────────

  it('set and get a value', async () => {
    await cache.set(K.auth('key1'), { hello: 'world' })
    const result = await cache.get<{ hello: string }>(K.auth('key1'))
    assert.deepStrictEqual(result, { hello: 'world' })
  })

  it('returns null for missing key', async () => {
    const result = await cache.get(K.auth('nonexistent'))
    assert.equal(result, null)
  })

  it('returns null for expired key', async () => {
    const shortCache = new MemoryCache({ prefix: 'test:', defaultTTL: 100 })
    try {
      await shortCache.set(K.auth('key1'), 'value1')
      assert.ok(await shortCache.get(K.auth('key1')), 'should exist before expiry')
      // Force-expire by backdating the entry
      const store = (shortCache as any).store
      const entry = store.get('test:auth:key1')
      if (entry) entry.expiresAt = Date.now() - 1
      const result = await shortCache.get(K.auth('key1'))
      assert.equal(result, null)
    } finally {
      await shortCache.close()
    }
  })

  // ─── TTL ────────────────────────────────────────────────────────────────────

  it('respects per-key TTL override', async () => {
    await cache.set(K.auth('short'), 'gone', 100)
    await cache.set(K.auth('long'), 'alive', 10000)
    // Force-expire the short entry
    const store = (cache as any).store
    const shortEntry = store.get('test:auth:short')
    if (shortEntry) shortEntry.expiresAt = Date.now() - 1
    assert.equal(await cache.get(K.auth('short')), null)
    assert.equal(await cache.get(K.auth('long')), 'alive')
  })

  // ─── LRU eviction ───────────────────────────────────────────────────────────

  it('evicts oldest entries when maxEntries exceeded', async () => {
    const smallCache = new MemoryCache({ prefix: 'test:', defaultTTL: 10000, maxEntries: 3 })
    try {
      await smallCache.set(K.auth('a'), 1)
      await smallCache.set(K.auth('b'), 2)
      await smallCache.set(K.auth('c'), 3)
      await smallCache.set(K.auth('d'), 4)

      assert.equal(await smallCache.get(K.auth('a')), null)
      assert.equal(await smallCache.get(K.auth('b')), 2)
      assert.equal(await smallCache.get(K.auth('c')), 3)
      assert.equal(await smallCache.get(K.auth('d')), 4)
    } finally {
      await smallCache.close()
    }
  })

  // ─── setWithNX ──────────────────────────────────────────────────────────────

  it('setWithNX sets only if not exists', async () => {
    const set1 = await cache.setWithNX(K.auth('key1'), 'value1')
    assert.equal(set1, true)
    const set2 = await cache.setWithNX(K.auth('key1'), 'value2')
    assert.equal(set2, false)
    assert.equal(await cache.get(K.auth('key1')), 'value1')
  })

  // ─── increment ──────────────────────────────────────────────────────────────

  it('increment creates and increments', async () => {
    await cache.increment(K.rate('counter'))
    await cache.increment(K.rate('counter'))
    await cache.increment(K.rate('counter'))
    assert.equal(await cache.get(K.rate('counter')), 3)
  })

  it('increment with delta', async () => {
    await cache.set(K.rate('counter'), 10)
    await cache.increment(K.rate('counter'), 5)
    assert.equal(await cache.get(K.rate('counter')), 15)
  })

  // ─── delete ─────────────────────────────────────────────────────────────────

  it('delete removes key', async () => {
    await cache.set(K.auth('key1'), 'value1')
    assert.equal(await cache.get(K.auth('key1')), 'value1')
    await cache.delete(K.auth('key1'))
    assert.equal(await cache.get(K.auth('key1')), null)
  })

  // ─── flush ──────────────────────────────────────────────────────────────────

  it('flush all clears cache', async () => {
    await cache.set(K.auth('a'), 1)
    await cache.set(K.auth('b'), 2)
    await cache.flush()
    assert.equal(await cache.get(K.auth('a')), null)
    assert.equal(await cache.get(K.auth('b')), null)
  })

  it('flush with pattern only clears matching', async () => {
    await cache.set(K.session('user1'), 'alice')
    await cache.set(K.session('user2'), 'bob')
    await cache.set(K.auth('sess1'), 'sess1')
    await cache.flush('session:*')
    assert.equal(await cache.get(K.session('user1')), null)
    assert.equal(await cache.get(K.session('user2')), null)
    assert.equal(await cache.get(K.auth('sess1')), 'sess1')
  })

  // ─── scan ───────────────────────────────────────────────────────────────────

  it('scan returns matching keys', async () => {
    await cache.set(K.session('user1'), 'alice')
    await cache.set(K.session('user2'), 'bob')
    await cache.set(K.auth('sess1'), 'sess1')
    const keys = await cache.scan('session:*')
    assert.ok(keys.length >= 2)
    assert.ok(keys.some(k => k.includes('user1')))
    assert.ok(keys.some(k => k.includes('user2')))
  })

  // ─── stats ──────────────────────────────────────────────────────────────────

  it('getStats returns correct info', async () => {
    await cache.set(K.auth('a'), 'hello')
    const stats = await cache.getStats()
    assert.equal(stats.connected, true)
    assert.ok(stats.keysCount! >= 1)
  })

  // ─── cleanup ────────────────────────────────────────────────────────────────

  it('expired entries return null', async () => {
    const shortCache = new MemoryCache({ prefix: 'test:', defaultTTL: 100, maxEntries: 1000 })
    try {
      await shortCache.set(K.auth('k1'), 'v1')
      assert.ok(await shortCache.get(K.auth('k1')), 'should exist before expiry')
      // Force-expire
      const store = (shortCache as any).store
      const entry = store.get('test:auth:k1')
      if (entry) entry.expiresAt = Date.now() - 1
      assert.equal(await shortCache.get(K.auth('k1')), null)
    } finally {
      await shortCache.close()
    }
  })
})
