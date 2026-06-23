import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CircuitBreaker, CircuitState, getCircuitBreaker } from '../core/circuit-breaker.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 5,
      resetTimeoutMs: 50,
      successThreshold: 3,
      monitorIntervalMs: 10,
    });
  });

  it('starts in CLOSED state', () => {
    assert.strictEqual(breaker.getState(), CircuitState.CLOSED);
  });

  it('opens after failure threshold', async () => {
    const failFn = async () => { throw new Error('fail'); };

    for (let i = 0; i < 5; i++) {
      try { await breaker.call(failFn); } catch { /* expected */ }
    }

    assert.strictEqual(breaker.getState(), CircuitState.OPEN);
  });

  it('rejects when OPEN', async () => {
    const failFn = async () => { throw new Error('fail'); };

    for (let i = 0; i < 5; i++) {
      try { await breaker.call(failFn); } catch { /* expected */ }
    }

    assert.strictEqual(breaker.getState(), CircuitState.OPEN);

    await assert.rejects(
      () => breaker.call(async () => 'ok'),
      (err: Error) => {
        assert.ok(err.message.includes('OPEN'));
        return true;
      }
    );
  });

  it('transitions to HALF_OPEN after timeout', async () => {
    const failFn = async () => { throw new Error('fail'); };

    for (let i = 0; i < 5; i++) {
      try { await breaker.call(failFn); } catch { /* expected */ }
    }

    assert.strictEqual(breaker.getState(), CircuitState.OPEN);

    // Wait for resetTimeoutMs to elapse
    await sleep(80);

    // Next call should transition to HALF_OPEN and execute the function
    const result = await breaker.call(async () => 'half-open-ok');
    assert.strictEqual(result, 'half-open-ok');
  });

  it('closes from HALF_OPEN after success threshold', async () => {
    const failFn = async () => { throw new Error('fail'); };
    const okFn = async () => 'ok';

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      try { await breaker.call(failFn); } catch { /* expected */ }
    }
    assert.strictEqual(breaker.getState(), CircuitState.OPEN);

    // Wait for resetTimeoutMs to transition to HALF_OPEN
    await sleep(80);

    // Succeed successThreshold times to close
    for (let i = 0; i < 3; i++) {
      await breaker.call(okFn);
    }

    assert.strictEqual(breaker.getState(), CircuitState.CLOSED);
  });

  it('returns to OPEN on half-open failure', async () => {
    const failFn = async () => { throw new Error('fail'); };

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      try { await breaker.call(failFn); } catch { /* expected */ }
    }
    assert.strictEqual(breaker.getState(), CircuitState.OPEN);

    // Wait for resetTimeoutMs to transition to HALF_OPEN
    await sleep(80);

    // One failure from HALF_OPEN should go back to OPEN
    try { await breaker.call(failFn); } catch { /* expected */ }

    assert.strictEqual(breaker.getState(), CircuitState.OPEN);
  });

  it('reset works', () => {
    const failFn = async () => { throw new Error('fail'); };

    // Force open by failing threshold times synchronously enough
    breaker.reset();

    // Force the breaker open manually for testing
    // We can use reset to verify it returns to CLOSED
    assert.strictEqual(breaker.getState(), CircuitState.CLOSED);

    // Open it
    const openBreaker = new CircuitBreaker('reset-test', {
      failureThreshold: 2,
      resetTimeoutMs: 60000,
      successThreshold: 3,
    });

    const doFail = async () => { throw new Error('fail'); };

    // Need to open it first
    openBreaker['state'] = CircuitState.OPEN;
    openBreaker['failureCount'] = 5;
    openBreaker['lastFailureTime'] = Date.now();

    assert.strictEqual(openBreaker.getState(), CircuitState.OPEN);

    openBreaker.reset();

    assert.strictEqual(openBreaker.getState(), CircuitState.CLOSED);
    const stats = openBreaker.getStats();
    assert.strictEqual(stats.failureCount, 0);
    assert.strictEqual(stats.successCount, 0);
    assert.strictEqual(stats.lastFailureTime, 0);
  });

  it('getCircuitBreaker returns singleton', () => {
    const a = getCircuitBreaker('singleton-test');
    const b = getCircuitBreaker('singleton-test');
    assert.strictEqual(a, b);
  });

  it('getCircuitBreaker creates different instances for different names', () => {
    const a = getCircuitBreaker('name-a');
    const b = getCircuitBreaker('name-b');
    assert.notStrictEqual(a, b);
  });

  it('resets failure count on success in CLOSED state', async () => {
    let shouldFail = true;
    const conditionalFn = async () => {
      if (shouldFail) throw new Error('conditional fail');
      return 'ok';
    };

    // Fail 3 times (below threshold of 5)
    for (let i = 0; i < 3; i++) {
      try { await breaker.call(conditionalFn); } catch { /* expected */ }
    }
    assert.strictEqual(breaker.getState(), CircuitState.CLOSED);

    // Succeed once - this should reset failureCount
    shouldFail = false;
    await breaker.call(conditionalFn);

    // Fail 3 more times - should still be CLOSED because count was reset
    shouldFail = true;
    for (let i = 0; i < 3; i++) {
      try { await breaker.call(conditionalFn); } catch { /* expected */ }
    }
    assert.strictEqual(breaker.getState(), CircuitState.CLOSED);
  });

  it('getStats returns current state information', async () => {
    const stats = breaker.getStats();
    assert.strictEqual(stats.state, CircuitState.CLOSED);
    assert.strictEqual(stats.failureCount, 0);
    assert.strictEqual(stats.successCount, 0);
    assert.strictEqual(stats.lastFailureTime, 0);

    const failFn = async () => { throw new Error('fail'); };
    try { await breaker.call(failFn); } catch { /* expected */ }

    const statsAfter = breaker.getStats();
    assert.strictEqual(statsAfter.failureCount, 1);
    assert.ok(statsAfter.lastFailureTime > 0);
  });

  it('throws original error on failure', async () => {
    const customError = new Error('custom error');
    const failFn = async () => { throw customError; };

    await assert.rejects(
      () => breaker.call(failFn),
      (err: Error) => {
        assert.strictEqual(err.message, 'custom error');
        return true;
      }
    );
  });
});
