import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildCompletionPayload } from '../services/stream-creator.js';

const TIMEOUT_PER_MB = 30000;

function makeArgs(overrides: Partial<Parameters<typeof buildCompletionPayload>[0]> = {}) {
  return {
    chatId: 'test-chat-id',
    modelId: 'qwen3.7-plus',
    enableThinking: false,
    thinkingMode: undefined,
    prompt: 'Hello, world!',
    parentId: null,
    files: [],
    accountId: undefined,
    ...overrides,
  };
}

describe('buildCompletionPayload', () => {
  it('returns valid JSON payload', () => {
    const result = buildCompletionPayload(makeArgs());
    assert.ok(typeof result.payloadJson === 'string');

    const parsed = JSON.parse(result.payloadJson);
    assert.ok(parsed);
    assert.strictEqual(parsed.stream, true);
    assert.strictEqual(parsed.version, '2.1');
    assert.strictEqual(parsed.incremental_output, true);
  });

  it('sets correct chat_mode for guest', () => {
    const result = buildCompletionPayload(makeArgs({ accountId: 'guest' }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.chat_mode, 'guest');
  });

  it('sets correct chat_mode for normal when accountId is undefined', () => {
    const result = buildCompletionPayload(makeArgs({ accountId: undefined }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.chat_mode, 'normal');
  });

  it('sets correct chat_mode for normal when accountId is a regular value', () => {
    const result = buildCompletionPayload(makeArgs({ accountId: 'user-123' }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.chat_mode, 'normal');
  });

  it('computes correct timeoutMs based on payload size', () => {
    const result = buildCompletionPayload(makeArgs({ prompt: 'Short prompt' }));
    const payloadMB = result.payloadSize / (1024 * 1024);
    const expectedTimeout = Math.ceil(payloadMB * TIMEOUT_PER_MB);

    // timeoutMs should be base chat timeout + per-MB scaling
    assert.ok(result.timeoutMs > 0, 'timeoutMs should be positive');
    assert.ok(result.timeoutMs >= expectedTimeout, 'timeoutMs should account for payload size');
  });

  it('strips -no-thinking suffix from modelId', () => {
    const result = buildCompletionPayload(makeArgs({ modelId: 'qwen3.7-plus-no-thinking' }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.model, 'qwen3.7-plus');
  });

  it('uses modelId as-is when no -no-thinking suffix', () => {
    const result = buildCompletionPayload(makeArgs({ modelId: 'qwen3.7-plus' }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.model, 'qwen3.7-plus');
  });

  it('includes thinking config when enableThinking is true', () => {
    const result = buildCompletionPayload(makeArgs({ enableThinking: true }));
    const parsed = JSON.parse(result.payloadJson);
    const featureConfig = parsed.messages[0].feature_config;
    assert.strictEqual(featureConfig.thinking_enabled, true);
  });

  it('includes thinking config when enableThinking is false', () => {
    const result = buildCompletionPayload(makeArgs({ enableThinking: false }));
    const parsed = JSON.parse(result.payloadJson);
    const featureConfig = parsed.messages[0].feature_config;
    assert.strictEqual(featureConfig.thinking_enabled, false);
  });

  it('sets thinking_mode from args', () => {
    const result = buildCompletionPayload(makeArgs({
      enableThinking: true,
      thinkingMode: 'thinking_budget',
    }));
    const parsed = JSON.parse(result.payloadJson);
    const featureConfig = parsed.messages[0].feature_config;
    assert.strictEqual(featureConfig.thinking_mode, 'thinking_budget');
  });

  it('defaults thinking_mode to Thinking when not provided', () => {
    const result = buildCompletionPayload(makeArgs({ enableThinking: true }));
    const parsed = JSON.parse(result.payloadJson);
    const featureConfig = parsed.messages[0].feature_config;
    assert.strictEqual(featureConfig.thinking_mode, 'Thinking');
  });

  it('sets the prompt as message content', () => {
    const result = buildCompletionPayload(makeArgs({ prompt: 'Test prompt here' }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.messages[0].content, 'Test prompt here');
  });

  it('sets parentId on the payload and message', () => {
    const result = buildCompletionPayload(makeArgs({ parentId: 'parent-abc' }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.parent_id, 'parent-abc');
    assert.strictEqual(parsed.messages[0].parentId, 'parent-abc');
    assert.strictEqual(parsed.messages[0].parent_id, 'parent-abc');
  });

  it('sets chat_id on the payload', () => {
    const result = buildCompletionPayload(makeArgs({ chatId: 'chat-xyz' }));
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.chat_id, 'chat-xyz');
  });

  it('sets role to user', () => {
    const result = buildCompletionPayload(makeArgs());
    const parsed = JSON.parse(result.payloadJson);
    assert.strictEqual(parsed.messages[0].role, 'user');
  });

  it('payloadSize matches Buffer.byteLength of payloadJson', () => {
    const result = buildCompletionPayload(makeArgs());
    const expected = Buffer.byteLength(result.payloadJson);
    assert.strictEqual(result.payloadSize, expected);
  });

  it('timestamp is a reasonable unix epoch', () => {
    const result = buildCompletionPayload(makeArgs());
    const parsed = JSON.parse(result.payloadJson);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(parsed.timestamp >= nowSec - 5, 'timestamp should be near current time');
    assert.ok(parsed.timestamp <= nowSec + 5, 'timestamp should be near current time');
  });

  it('message has a UUID fid', () => {
    const result = buildCompletionPayload(makeArgs());
    const parsed = JSON.parse(result.payloadJson);
    assert.ok(typeof parsed.messages[0].fid === 'string');
    assert.ok(parsed.messages[0].fid.length > 0);
  });

  it('includes files in message when provided', () => {
    const files = [
      { type: 'image', file: {}, id: 'f1', url: 'http://example.com/img.png', name: 'img.png' },
    ];
    const result = buildCompletionPayload(makeArgs({ files }));
    const parsed = JSON.parse(result.payloadJson);
    assert.deepStrictEqual(parsed.messages[0].files, files);
  });
});
