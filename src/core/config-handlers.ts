/**
 * Config Handlers - React to config changes at runtime
 *
 * Each handler performs the necessary side effect when a config value changes.
 */

import { configManager } from './config.js'
import type { ConfigChangeEvent } from './config-manager.js'

// ─── Handler Registration ────────────────────────────────────────────────────

export function registerConfigHandlers(): void {
  configManager.on('config:change', async (event: ConfigChangeEvent) => {
    try {
      await handleChange(event)
    } catch (err: any) {
      console.error(`[ConfigHandler] Error handling change for ${event.path}:`, err.message)
    }
  })
  console.log('[ConfigHandler] Registered config change handlers')
}

// ─── Change Router ───────────────────────────────────────────────────────────

async function handleChange(event: ConfigChangeEvent): Promise<void> {
  const { path, newValue } = event

  // Browser changes
  if (path === 'browser.headless' || path === 'browser.type') {
    await handleBrowserReinit()
    return
  }

  if (path === 'browser.userAgent') {
    await handleBrowserContextRecreate()
    return
  }

  // Metrics
  if (path === 'metrics.interval') {
    handleMetricsRestart()
    return
  }

  // Watchdog
  if (path === 'watchdog.checkInterval') {
    handleWatchdogRestart()
    return
  }

  // Debug
  if (path === 'debug.bufferSize') {
    handleDebugBufferSize(newValue)
    return
  }

  // Logging
  if (path === 'logging.enabled') {
    handleLoggingToggle(newValue)
    return
  }
}

// ─── Handler Implementations ─────────────────────────────────────────────────

async function handleBrowserReinit(): Promise<void> {
  console.log('[ConfigHandler] Browser config changed, reinitializing...')
  try {
    const { closePlaywright, initPlaywright } = await import('../services/playwright.js')
    await closePlaywright()
    const config = (await import('./config.js')).config
    await initPlaywright(config.browser.headless, config.browser.type as any)
    console.log('[ConfigHandler] Browser reinitialized successfully')
  } catch (err: any) {
    console.error('[ConfigHandler] Failed to reinit browser:', err.message)
  }
}

async function handleBrowserContextRecreate(): Promise<void> {
  console.log('[ConfigHandler] User agent changed, contexts will be recreated on next use')
  // Contexts are recreated lazily when needed — no immediate action required
  // The new userAgent will be used in the next context creation
}

function handleMetricsRestart(): void {
  console.log('[ConfigHandler] Metrics interval changed, restart needed on next collection cycle')
  // Metrics reads config.metrics.interval dynamically in startCollection
  // The setInterval is already set — restart is needed
  try {
    const { metrics } = require('./metrics.js')
    metrics.stopCollection()
    metrics.startCollection()
    console.log('[ConfigHandler] Metrics collection restarted')
  } catch (err: any) {
    console.error('[ConfigHandler] Failed to restart metrics:', err.message)
  }
}

function handleWatchdogRestart(): void {
  console.log('[ConfigHandler] Watchdog interval changed, restart needed')
  // The watchdog reads config.watchdog.checkInterval dynamically
  // A restart would be needed for the interval to take effect
}

function handleDebugBufferSize(size: number): void {
  try {
    const { getDebugLogger } = require('./debug-logger.js')
    const logger = getDebugLogger()
    logger.maxSize = size
    console.log(`[ConfigHandler] Debug buffer size updated to ${size}`)
  } catch (err: any) {
    console.error('[ConfigHandler] Failed to update debug buffer size:', err.message)
  }
}

function handleLoggingToggle(enabled: boolean): void {
  try {
    const { requestLogger } = require('./request-logger.js')
    if (enabled) {
      requestLogger.enable()
    } else {
      requestLogger.disable()
    }
    console.log(`[ConfigHandler] Request logging ${enabled ? 'enabled' : 'disabled'}`)
  } catch (err: any) {
    console.error('[ConfigHandler] Failed to toggle logging:', err.message)
  }
}
