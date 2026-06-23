import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { RateLimiter, createApiRateLimiter, createStrictRateLimiter } from '../middleware/rate-limiter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Sleep for `ms` milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Build a minimal mock Hono context */
function makeMockContext(opts: {
  method?: string;
  path?: string;
  apiKey?: string;
  skipJson?: boolean;
} = {}) {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/chat';
  const apiKey = opts.apiKey ?? 'test-api-key';

  let headers: Record<string, string> = {};
  let statusCode = 200;
  let responseBody: any = null;

  const ctx = {
    req: {
      method,
      path,
      header: (name: string) => {
        if (name === 'x-api-key') return apiKey;
        return undefined;
      },
    },
    header: (name: string, value: string): void => { headers[name] = value; },
    json: (body: any, status: number) => {
      responseBody = body;
      statusCode = status;
      if (opts.skipJson) return undefined as any;
      return new Response(JSON.stringify(body), { status });
    },
  } as any;

  // Attach getters for inspection
  Object.defineProperty(ctx, '_headers', { get: () => headers });
  Object.defineProperty(ctx, '_status', { get: () => statusCode });
  Object.defineProperty(ctx, '_body', { get: () => responseBody });

  return ctx;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RateLimiter - Store logic', () => {
  let limiter: InstanceType<typeof RateLimiter>;

  afterEach(() => {
    if (limiter) limiter.stop();
  });

  it('allows requests under the limit', () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 5 });
    const store = limiter.getStore('test-key');
    // No store yet before any request is recorded
    assert.strictEqual(store, undefined);
  });

  it('clear() removes all stores', () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 100 });
    limiter.clear();
    assert.strictEqual(limiter.getStore('any-key'), undefined);
  });

  it('updateConfig resets all stores', () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 100 });
    limiter.updateConfig({ maxRequests: 50 });
    assert.strictEqual(limiter.getStore('any-key'), undefined);
  });

  it('stop clears cleanup interval without throwing', () => {
    limiter = new RateLimiter({ windowMs: 1000, maxRequests: 10 });
    limiter.stop();
    // Calling stop twice should not throw
    limiter.stop();
    limiter = null!; // prevent double-stop in afterEach
  });
});

describe('RateLimiter - Sliding window middleware', () => {
  let limiter: InstanceType<typeof RateLimiter>;

  afterEach(() => {
    if (limiter) limiter.stop();
  });

  it('allows requests under the limit and rejects over', async () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 3 });
    const mw = limiter.middleware();

    // Requests 1-3 should pass
    for (let i = 0; i < 3; i++) {
      const ctx = makeMockContext();
      await mw(ctx, async () => { /* next */ });
      assert.notStrictEqual(ctx._status, 429, `Request ${i + 1} should be allowed`);
      assert.strictEqual(ctx._headers['X-RateLimit-Limit'], '3');
      assert.strictEqual(parseInt(ctx._headers['X-RateLimit-Remaining']), 3 - i - 1);
    }

    // Request 4 should be rejected
    const ctx4 = makeMockContext();
    const result4 = await mw(ctx4, async () => { throw new Error('should not reach next'); });
    assert.strictEqual(ctx4._status, 429);
    assert.strictEqual(ctx4._body.error.code, 'RATE_LIMITED');
    assert.strictEqual(ctx4._headers['X-RateLimit-Remaining'], '0');
    assert.ok(parseInt(ctx4._headers['Retry-After']) >= 1, 'Retry-After should be at least 1');
  });

  it('sliding window: request allowed after oldest entry expires', async () => {
    limiter = new RateLimiter({ windowMs: 100, maxRequests: 2 });
    const mw = limiter.middleware();

    // Requests 1-2 allowed
    const ctx1 = makeMockContext();
    const ctx2 = makeMockContext();
    await mw(ctx1, async () => {});
    await mw(ctx2, async () => {});

    // Request 3 rejected (over limit)
    const ctx3 = makeMockContext();
    await mw(ctx3, async () => {});
    assert.strictEqual(ctx3._status, 429, 'Third request should be rate limited');

    // Wait for window to slide past first request
    await sleep(110);

    // Request 4 should now be allowed (oldest entry expired)
    const ctx4 = makeMockContext();
    await mw(ctx4, async () => {});
    assert.notStrictEqual(ctx4._body?.error?.code, 'RATE_LIMITED', 'Request after window slide should be allowed');
    assert.strictEqual(ctx4._headers['X-RateLimit-Limit'], '2');
  });

  it('different keys have independent windows', async () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 2 });
    const mw = limiter.middleware();

    // Exhaust limit for key A
    const ctxA1 = makeMockContext({ apiKey: 'key-a' });
    const ctxA2 = makeMockContext({ apiKey: 'key-a' });
    await mw(ctxA1, async () => { /* ok */ });
    await mw(ctxA2, async () => { /* ok */ });

    // Key A is now at limit
    const ctxA3 = makeMockContext({ apiKey: 'key-a' });
    await mw(ctxA3, async () => {});
    assert.strictEqual(ctxA3._status, 429, 'Key A should be rate limited');

    // Key B should still be allowed
    const ctxB1 = makeMockContext({ apiKey: 'key-b' });
    await mw(ctxB1, async () => { /* ok */ });
    assert.strictEqual(ctxB1._status, 200, 'Key B should not be rate limited');
    assert.strictEqual(ctxB1._body?.error?.code, undefined);
  });
});

describe('RateLimiter - Skip paths and methods', () => {
  let limiter: InstanceType<typeof RateLimiter>;

  afterEach(() => {
    if (limiter) limiter.stop();
  });

  it('skips rate limiting for configured paths', async () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1, skipPaths: ['/health'] });
    const mw = limiter.middleware();

    // /health should always pass (skipped)
    for (let i = 0; i < 5; i++) {
      const ctx = makeMockContext({ path: '/health' });
      await mw(ctx, async () => { /* passed */ });
      assert.notStrictEqual(ctx._status, 429, `/health request ${i + 1} should be skipped`);
    }
  });

  it('skips rate limiting for configured methods', async () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 1, skipMethods: ['GET'] });
    const mw = limiter.middleware();

    // GET should always pass (skipped)
    for (let i = 0; i < 5; i++) {
      const ctx = makeMockContext({ method: 'GET' });
      await mw(ctx, async () => { /* passed */ });
      assert.notStrictEqual(ctx._status, 429, `GET request ${i + 1} should be skipped`);
    }

    // POST should be rate limited after 1 request
    const ctx1 = makeMockContext({ method: 'POST' });
    await mw(ctx1, async () => { /* passed */ });

    const ctx2 = makeMockContext({ method: 'POST' });
    await mw(ctx2, async () => { throw new Error('blocked'); });
    assert.strictEqual(ctx2._status, 429, 'POST should be rate limited');
  });
});

describe('RateLimiter - updateConfig hot-reload', () => {
  let limiter: InstanceType<typeof RateLimiter>;

  afterEach(() => {
    if (limiter) limiter.stop();
  });

  it('updateConfig changes maxRequests and clears stores', () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 100 });
    limiter.updateConfig({ maxRequests: 10 });
    assert.strictEqual(limiter.getStore('key'), undefined, 'Store should be cleared after config update');
  });

  it('updateConfig changes windowMs and clears stores', () => {
    limiter = new RateLimiter({ windowMs: 60000, maxRequests: 100 });
    limiter.updateConfig({ windowMs: 5000 });
    assert.strictEqual(limiter.getStore('key'), undefined, 'Store should be cleared after window change');
  });
});

describe('RateLimiter - Factory functions', () => {
  it('createApiRateLimiter returns a working limiter', () => {
    const limiter = createApiRateLimiter();
    assert.ok(limiter);
    assert.strictEqual(limiter.getStore('test'), undefined);
    limiter.stop();
  });

  it('createStrictRateLimiter returns a working limiter', () => {
    const limiter = createStrictRateLimiter();
    assert.ok(limiter);
    assert.strictEqual(limiter.getStore('test'), undefined);
    limiter.stop();
  });
});
