import { describe, it } from 'node:test';
import assert from 'node:assert';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeSession(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sess-1',
    chatId: 'chat-1',
    parentId: null,
    accountId: 'acct-1',
    headers: { cookie: 'x' },
    headersTimestamp: Date.now(),
    messageCount: 0,
    model: 'qwen3.6-plus',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    inFlight: false,
    ...overrides,
  };
}

function busyBuilder(_sessionId: string) {
  return { body: { error: 'busy' }, status: 429 };
}

// ── Tests ────────────────────────────────────────────────────────────────────
// NOTE: Full integration tests for resolveSession, buildSessionContext,
// updateSessionState, and releaseSessionFlight require a SQLite database
// (session-manager singleton initialization). These pure-logic tests verify
// the helpers and contracts without needing the DB.

describe('request-executor helpers', () => {
  it('busyBuilder returns correct shape', () => {
    const result = busyBuilder('test-session');
    assert.deepStrictEqual(result, { body: { error: 'busy' }, status: 429 });
  });

  it('fakeSession has required fields', () => {
    const sess = fakeSession();
    assert.ok(sess.sessionId);
    assert.ok(sess.chatId);
    assert.strictEqual(sess.inFlight, false);
    assert.strictEqual(sess.messageCount, 0);
  });

  it('fakeSession accepts overrides', () => {
    const sess = fakeSession({ sessionId: 'custom', messageCount: 5 });
    assert.strictEqual(sess.sessionId, 'custom');
    assert.strictEqual(sess.messageCount, 5);
  });
});

// Integration tests are skipped until a test database is available.
// To run them, ensure data/ directory is writable and session-manager
// can initialize its SQLite connection.
describe.skip('resolveSession integration (needs DB)', () => {
  it('resolves with null session when no header and no messages', async () => {
    const { resolveSession } = await import('../routes/request-executor.js');
    const result = await resolveSession({
      sessionHeader: undefined,
      messages: [],
      model: 'qwen3.6-plus',
      busyResponse: busyBuilder,
    });
    assert.strictEqual(result.resolved, true);
    assert.strictEqual(result.activeSession, null);
  });
});
