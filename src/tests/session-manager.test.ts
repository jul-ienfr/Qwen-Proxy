import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getMessageFingerprint, buildMessageFingerprints, extractTextContent } from '../core/session-manager.js'

// ─── extractTextContent ──────────────────────────────────────────────────────

describe('extractTextContent', () => {
  it('extracts from string content', () => {
    assert.equal(extractTextContent('hello'), 'hello')
  })

  it('extracts from array of text parts', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]
    assert.equal(extractTextContent(content), 'hello\nworld')
  })

  it('filters out non-text parts from array', () => {
    const content = [
      { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
      { type: 'text', text: 'describe this' },
    ]
    assert.equal(extractTextContent(content), 'describe this')
  })

  it('returns empty string for null content', () => {
    assert.equal(extractTextContent(null), '')
  })

  it('returns empty string for undefined content', () => {
    assert.equal(extractTextContent(undefined), '')
  })

  it('serializes object content', () => {
    const content = { key: 'value' }
    assert.equal(extractTextContent(content), JSON.stringify(content))
  })

  it('returns empty string for empty array', () => {
    assert.equal(extractTextContent([]), '')
  })
})

// ─── getMessageFingerprint ───────────────────────────────────────────────────

describe('getMessageFingerprint', () => {
  it('returns consistent fingerprints for same input', () => {
    const fp1 = getMessageFingerprint('user', 'hello world')
    const fp2 = getMessageFingerprint('user', 'hello world')
    assert.equal(fp1, fp2)
  })

  it('returns different fingerprints for different content', () => {
    const fp1 = getMessageFingerprint('user', 'hello')
    const fp2 = getMessageFingerprint('user', 'world')
    assert.notEqual(fp1, fp2)
  })

  it('returns different fingerprints for different roles', () => {
    const fp1 = getMessageFingerprint('user', 'hello')
    const fp2 = getMessageFingerprint('assistant', 'hello')
    assert.notEqual(fp1, fp2)
  })

  it('format is role:length:hash', () => {
    const fp = getMessageFingerprint('user', 'test')
    const parts = fp.split(':')
    assert.equal(parts.length, 3)
    assert.equal(parts[0], 'user')
    assert.equal(parts[1], '4')
    assert.equal(parts[2].length, 16) // MD5 truncated to 16 hex chars
  })

  it('handles empty content', () => {
    const fp = getMessageFingerprint('user', '')
    const parts = fp.split(':')
    assert.equal(parts[1], '0')
  })
})

// ─── buildMessageFingerprints ────────────────────────────────────────────────

describe('buildMessageFingerprints', () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'how are you?' },
  ]

  it('builds fingerprints for a range', () => {
    const fps = buildMessageFingerprints(messages, 0, 2)
    assert.equal(fps.size, 2)
    assert.ok(fps.has(0))
    assert.ok(fps.has(1))
    assert.ok(!fps.has(2))
  })

  it('builds fingerprints matching getMessageFingerprint', () => {
    const fps = buildMessageFingerprints(messages, 0, 1)
    const expected = getMessageFingerprint('user', 'hello')
    assert.equal(fps.get(0), expected)
  })

  it('handles partial range', () => {
    const fps = buildMessageFingerprints(messages, 1, 3)
    assert.equal(fps.size, 2)
    assert.ok(!fps.has(0))
    assert.ok(fps.has(1))
    assert.ok(fps.has(2))
  })

  it('returns empty map for empty range', () => {
    const fps = buildMessageFingerprints(messages, 2, 2)
    assert.equal(fps.size, 0)
  })

  it('handles array content in messages', () => {
    const arrMsgs = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'http://x.com/img.png' } }] },
    ]
    const fps = buildMessageFingerprints(arrMsgs, 0, 1)
    assert.equal(fps.size, 1)
    const expected = getMessageFingerprint('user', 'hello')
    assert.equal(fps.get(0), expected)
  })
})
