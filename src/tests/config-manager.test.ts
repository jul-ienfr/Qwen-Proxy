import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { getConfigManager } from '../core/config-manager.js'

describe('ConfigManager', () => {
  const mgr = getConfigManager()

  // ─── get/set ────────────────────────────────────────────────────────────────

  it('get returns value at dot-notation path', () => {
    const result = mgr.get('server.port')
    assert.equal(typeof result, 'number')
    assert.ok(result > 0)
  })

  it('get returns undefined for unknown path', () => {
    const result = mgr.get('nonexistent.path.here')
    assert.equal(result, undefined)
  })

  it('get returns nested object', () => {
    const result = mgr.get('browser')
    assert.ok(result)
    assert.ok(typeof result === 'object')
  })

  // ─── defaults ───────────────────────────────────────────────────────────────

  it('getDefault returns default value', () => {
    const result = mgr.getDefault('server.port')
    assert.equal(typeof result, 'number')
  })

  // ─── updateConfig ───────────────────────────────────────────────────────────

  it('updateConfig accepts valid boolean', () => {
    const oldValue = mgr.get('browser.headless')
    const result = mgr.updateConfig('browser.headless', !oldValue)
    assert.equal(result.success, true)
    assert.equal(mgr.get('browser.headless'), !oldValue)
    // Restore
    mgr.updateConfig('browser.headless', oldValue)
  })

  it('updateConfig rejects unknown path', () => {
    const result = mgr.updateConfig('unknown.path', 'value')
    assert.equal(result.success, false)
    assert.ok(result.error?.includes('Unknown config path'))
  })

  it('updateConfig rejects wrong type', () => {
    const result = mgr.updateConfig('browser.headless', 'not-a-boolean')
    assert.equal(result.success, false)
    assert.ok(result.error?.includes('Expected boolean'))
  })

  it('updateConfig rejects negative number', () => {
    const result = mgr.updateConfig('server.port', -1)
    assert.equal(result.success, false)
    assert.ok(result.error?.includes('non-negative'))
  })

  // ─── events ─────────────────────────────────────────────────────────────────

  it('emits config:change on updateConfig', (_, done) => {
    const oldValue = mgr.get('browser.headless')
    mgr.once('config:change', (event: any) => {
      assert.equal(event.path, 'browser.headless')
      assert.equal(event.newValue, !oldValue)
      // Restore
      mgr.updateConfig('browser.headless', oldValue)
      done()
    })
    mgr.updateConfig('browser.headless', !oldValue)
  })

  // ─── getSanitizedConfig ─────────────────────────────────────────────────────

  it('getSanitizedConfig masks secrets', () => {
    const sanitized = mgr.getSanitizedConfig()
    // apiKey should be masked (if set)
    if (sanitized.apiKey) {
      assert.ok(sanitized.apiKey.startsWith('****'))
    }
  })

  // ─── validation ─────────────────────────────────────────────────────────────

  it('validates browser.type enum', () => {
    const result = mgr.updateConfig('browser.type', 'invalid-browser')
    assert.equal(result.success, false)
    assert.ok(result.error?.includes('Must be one of'))
  })

  it('accepts valid browser.type', () => {
    const oldType = mgr.get('browser.type')
    const result = mgr.updateConfig('browser.type', 'chromium')
    assert.equal(result.success, true)
    mgr.updateConfig('browser.type', oldType)
  })
})
