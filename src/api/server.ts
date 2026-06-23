import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { config, configManager } from '../core/config.js'
import { metrics } from '../core/metrics.js'
import { cache } from '../cache/memory-cache.js'
import { Watchdog } from '../core/watchdog.js'
import { app as modelsApp } from './models.js'
import { chatCompletions, chatCompletionsStop } from '../routes/chat.js'
import { uploadFile } from '../routes/upload.js'
import { app as configApp } from '../routes/config.js'
import { app as historyApp } from '../routes/history.js'
import { requestLogger } from '../core/request-logger.js'
import { requestStore } from '../core/request-store.js'
import { getAllCircuitBreakerStats } from '../core/circuit-breaker.js'
import { anthropicMessages, geminiGenerateContent } from '../routes/multi-protocol.js'
import { imageGenerations, imageEdits } from '../routes/images.js'
import { videoGenerations } from '../routes/videos.js'
import { proxyAdminApp } from '../routes/proxy-admin.js'
import { app as debugApp } from '../routes/debug.js'
import { app as serverConfigApp } from '../routes/server-config.js'
import { sessionsApp } from '../routes/sessions.js'
import { accountsApp } from '../routes/accounts.js'
import { initDebugState, getDebugState } from '../core/debug-state.js'
import { getDebugLogger } from '../core/debug-logger.js'
import { registerConfigHandlers } from '../core/config-handlers.js'
import { RateLimiter } from '../middleware/rate-limiter.js'
import { loadAccounts } from '../core/accounts.js'
import { getAccountCooldownInfo } from '../core/account-manager.js'
import { getBrowser } from '../services/browser-manager.js'
import { getPredictionCacheStats } from '../cache/prediction-cache.js'
import { getWarmPoolStats } from '../services/warm-pool.js'
import { getSessionManager } from '../core/session-manager.js'

const app = new Hono()

let watchdog: Watchdog
let server: any

app.use('/v1/*', async (c, next) => {
  metrics.increment('requests.total')
  const start = Date.now()
  await next()
  const duration = Date.now() - start
  metrics.histogram('latency.request', duration)
  c.header('X-Response-Time', `${duration}ms`)
})

app.use('/v1/*', async (c, next) => {
  const apiKey = process.env.API_KEY || config.apiKey
  if (apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401)
    }
    const token = auth.slice(7)
    const tokenBuf = Buffer.from(token)
    const keyBuf = Buffer.from(apiKey)
    if (tokenBuf.length !== keyBuf.length || !crypto.timingSafeEqual(tokenBuf, keyBuf)) {
      return c.json({ error: 'Invalid API key' }, 401)
    }
  }
  await next()
})

// Rate limiting for API endpoints (100 requests per minute per IP)
const apiRateLimiter = new RateLimiter({
  windowMs: 60000,
  maxRequests: 100,
  message: 'Too many API requests, please try again later',
  keyGenerator: (c) => c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
  skipPaths: ['/health', '/metrics'],
})
app.use('/v1/*', apiRateLimiter.middleware())

app.route('', modelsApp)

// OpenAI endpoints
app.post('/v1/chat/completions', chatCompletions)
app.post('/v1/chat/completions/stop', chatCompletionsStop)
app.post('/v1/upload', uploadFile)

// Image generation endpoints
app.post('/v1/images/generations', imageGenerations)
app.post('/v1/images/edits', imageEdits)

// Video generation endpoint
app.post('/v1/videos', videoGenerations)

// Anthropic endpoints
app.post('/v1/messages', anthropicMessages)
app.post('/anthropic/v1/messages', anthropicMessages)

// Gemini endpoints
app.post('/v1beta/models/:model/generateContent', geminiGenerateContent)
app.post('/v1beta/models/:model/streamGenerateContent', geminiGenerateContent)
app.post('/v1/models/:model/generateContent', geminiGenerateContent)
app.post('/v1/models/:model/streamGenerateContent', geminiGenerateContent)

// Config & History
app.route('', configApp)
app.route('', historyApp)

// Proxy admin (under /v1 for auth middleware coverage)
app.route('/v1', proxyAdminApp)

// Debug mode
app.route('', debugApp)

// Sessions management
app.route('', sessionsApp)

// Server config (hot-reloadable)
app.route('', serverConfigApp)

// Account cooldown management
app.route('/v1', accountsApp)

app.get('/health', async (c) => {
  const accounts = loadAccounts()
  const browser = getBrowser()

  const checks = {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    browser: {
      connected: browser?.isConnected() || false,
    },
    accounts: {
      total: accounts.length,
      active: accounts.filter(a => !getAccountCooldownInfo(a.id)).length,
      onCooldown: accounts.filter(a => getAccountCooldownInfo(a.id)).length,
    },
    cache: await cache?.getStats(),
    cacheMemory: (() => {
      try {
        const predStats = getPredictionCacheStats();
        return {
          predictionCache: {
            entries: predStats.entries,
            totalSizeMB: Math.round(predStats.totalSizeBytes / 1024 / 1024 * 100) / 100,
            maxEntries: predStats.maxEntries,
            ttlMinutes: Math.round(predStats.ttlMs / 60000),
          },
        };
      } catch {
        return { predictionCache: null };
      }
    })(),
    logging: {
      enabled: requestLogger.isEnabled(),
      bufferSize: requestLogger.getBufferSize(),
    },
    circuitBreakers: getAllCircuitBreakerStats(),
    tlsPool: await (async () => {
      try {
        const { getPoolStats } = await import('../services/tls-pool.js')
        return getPoolStats()
      } catch { return { total: 0, alive: 0, totalRequests: 0 } }
    })(),
    warmPool: (() => {
      try {
        return getWarmPoolStats();
      } catch {
        return {};
      }
    })(),
    proxyPool: await (async () => {
      try {
        const { getProxyPool } = await import('../services/proxy-pool.js')
        return getProxyPool().getStats()
      } catch { return { total: 0, available: 0, failed: 0, untested: 0 } }
    })(),
    wsBridge: await (async () => {
      try {
        const { getWSBridgeStats } = await import('../services/stream-ws-bridge.js')
        return getWSBridgeStats()
      } catch { return { serverRunning: false, port: 0, activeConnections: 0 } }
    })(),
    sessions: (() => {
      try {
        const sessionMgr = getSessionManager();
        return sessionMgr.getStats();
      } catch {
        return { active: 0, sessions: [] };
      }
    })(),
    signaling: await (async () => {
      try {
        const { getSignalingStats } = await import('../api/ws-server.js')
        return getSignalingStats()
      } catch { return { connectedClients: 0, authenticatedClients: 0, activeChats: 0 } }
    })(),
    debug: {
      enabled: getDebugState().isEnabled(),
      bufferUsed: getDebugLogger().getStats().total,
    },
    timestamp: Date.now(),
  }

  const status = checks.browser.connected ? 'healthy' : 'degraded'
  return c.json({ status, ...checks }, status === 'healthy' ? 200 : 503)
})

app.get('/metrics', (c) => {
  return c.text(metrics.formatPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  })
})

// ─── Performance Monitoring Endpoint ────────────────────────────────────────
app.get('/v1/performance', async (c) => {
  const { getPerformanceStats, getCurrentPath } = await import('../services/performance-monitor.js')
  const { getPoolStats } = await import('../services/tls-pool.js')

  let wsBridge: any = { status: 'unknown', port: 0, activeConnections: 0 }
  let signaling: any = { connectedClients: 0, authenticatedClients: 0, activeChats: 0 }
  try {
    const { getSignalingStats } = await import('../api/ws-server.js')
    const sigStats = getSignalingStats()
    signaling = sigStats
    wsBridge = {
      status: config.useWsBridge ? 'active' : 'disabled',
      port: config.server.port,
      activeConnections: sigStats.connectedClients || 0,
    }
  } catch { /* ws-server not initialized */ }

  return c.json({
    pathSelection: getCurrentPath(),
    pathStats: getPerformanceStats(),
    tlsPool: getPoolStats(),
    wsBridge,
    signaling,
    config: {
      fastStreamProxy: config.fastStreamProxy,
      useWsBridge: config.useWsBridge,
      directFetch: config.directFetch,
      tlsPoolSize: config.tlsPoolSize,
    },
    timestamp: Date.now(),
  })
})

// ─── Config Toggle API ──────────────────────────────────────────────────────
const CONFIG_HOT_RELOAD: Record<string, boolean> = {
  fastStreamProxy: true,
  directFetch: true,
  useWsBridge: true,
  'browser.headless': true,
};

app.put('/v1/config/:key', async (c) => {
  const key = c.req.param('key');
  if (!(key in CONFIG_HOT_RELOAD)) {
    return c.json({ error: `Unknown or non-hot-reloadable config key: ${key}`, available: Object.keys(CONFIG_HOT_RELOAD) }, 400);
  }
  try {
    const body = await c.req.json();
    const value = body.value;
    if (typeof value !== 'boolean') {
      return c.json({ error: 'Value must be a boolean' }, 400);
    }
    const oldValue = configManager.get(key);
    configManager.updateConfig(key, value);
    console.log(`[Config] ${key}: ${oldValue} → ${value}`);
    return c.json({ key, oldValue, newValue: value, hotReloaded: CONFIG_HOT_RELOAD[key], persisted: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

app.get('/v1/config', (c) => {
  return c.json({
    fastStreamProxy: config.fastStreamProxy,
    directFetch: config.directFetch,
    useWsBridge: config.useWsBridge,
    tlsPoolSize: config.tlsPoolSize,
    'browser.headless': config.browser.headless,
  });
});

app.onError((err, c) => {
  metrics.increment('requests.errors')
  console.error('API Error:', err)
  return c.json({ error: err.message }, 500)
})

// ─── Static Files (WebUI) ────────────────────────────────────────────────────

// Prefer built React app (webui/dist/), fall back to legacy vanilla JS (webui/)
const WEBUI_DIST = path.resolve(process.cwd(), 'webui', 'dist');
const WEBUI_LEGACY = path.resolve(process.cwd(), 'webui');
const WEBUI_DIR = fs.existsSync(WEBUI_DIST) ? WEBUI_DIST : WEBUI_LEGACY;

// Check if webui directory exists
const webuiExists = fs.existsSync(WEBUI_DIR);

// Helper to serve static files
async function serveWebuiFile(c: any, filePath: string): Promise<Response | null> {
  const fullPath = path.join(WEBUI_DIR, filePath);
  try {
    const content = await fs.promises.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    return new Response(content, {
      headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' },
    });
  } catch {
    return null;
  }
}

if (webuiExists) {
  // Serve React build assets (webui/dist/assets/*)
  app.get('/assets/:file', async (c) => {
    return await serveWebuiFile(c, `assets/${c.req.param('file')}`) || c.json({ error: 'Not found' }, 404);
  });
  // Serve legacy CSS files
  app.get('/css/:file', async (c) => {
    return await serveWebuiFile(c, `css/${c.req.param('file')}`) || c.json({ error: 'Not found' }, 404);
  });
  // Serve legacy JS files
  app.get('/js/:file', async (c) => {
    return await serveWebuiFile(c, `js/${c.req.param('file')}`) || c.json({ error: 'Not found' }, 404);
  });
  // Serve favicon
  app.get('/favicon.ico', async (c) => {
    return await serveWebuiFile(c, 'favicon.ico') || new Response(null, { status: 204 });
  });
}

// Dashboard at root (only if no API path matched)
app.get('/', async (c) => {
  if (webuiExists) {
    const indexPath = path.join(WEBUI_DIR, 'index.html');
    try {
      const html = await fs.promises.readFile(indexPath, 'utf-8');
      return c.html(html);
    } catch {
      // index.html doesn't exist, fall through to JSON response
    }
  }
  return c.json({ message: 'QwenProxy API', version: '1.8.0' });
})

app.notFound(async (c) => {
  // Try to serve index.html for SPA routing (but not for API paths)
  const reqPath = new URL(c.req.url).pathname;
  if (webuiExists && !reqPath.startsWith('/v1/') && !reqPath.startsWith('/api/') && !reqPath.startsWith('/anthropic/') && !reqPath.startsWith('/v1beta/') && reqPath !== '/health' && reqPath !== '/metrics') {
    const indexPath = path.join(WEBUI_DIR, 'index.html');
    try {
      const html = await fs.promises.readFile(indexPath, 'utf-8');
      return c.html(html);
    } catch {
      // index.html doesn't exist, fall through to 404
    }
  }
  return c.json({ error: 'Not found' }, 404)
})

export async function startServer(onReady?: (port: number) => void): Promise<void> {
  // Initialize debug state (loads persisted state or env default)
  initDebugState()

  // Register config change handlers
  registerConfigHandlers()

  await cache.connect()

  const accounts = loadAccounts()

  const { initPlaywright, initPlaywrightForAccount } = await import('../services/playwright.js')
  const { getProfilesDir } = await import('../services/browser-manager.js')

  await initPlaywright(config.browser.headless, config.browser.type as any)
  
  if (accounts.length > 0) {
    const { getAccountCredentials } = await import('../core/accounts.js')
    // Skip accounts already handled by initPlaywright (default session)
    const accountsToInit = accounts.filter(a => a.id !== '_default')
    if (accountsToInit.length > 0) {
      console.log(`[Server] Pre-warming ${accountsToInit.length} configured account(s) sequentially...`)
      // Sequential init with random stagger (prevents thundering herd)
      for (const account of accountsToInit) {
        const creds = getAccountCredentials(account.id)
        if (!creds) continue
        const staggerMs = 500 + Math.floor(Math.random() * 1500);
        await new Promise(r => setTimeout(r, staggerMs));
        await initPlaywrightForAccount(creds, config.browser.headless, config.browser.type as any).catch((err: any) => {
          console.error(`[Server] Failed to initialize account ${account.email}:`, err.message)
        })
      }
    }
    console.log('[Server] Pre-fetching headers for all accounts in background...')
    const { warmAllPools } = await import('../services/qwen.js')
    warmAllPools(accounts.map(a => a.id)).catch(() => {})

    // Start periodic stream pre-warming (connections, headers, warm pool)
    try {
      const { startStreamWarmer } = await import('../services/stream-warmer.js')
      startStreamWarmer()
      console.log('[Server] Stream warmer started')
    } catch (err: any) {
      console.warn('[Server] Stream warmer init failed:', err.message)
    }

    // Start session keep-alive (prevents captcha after inactivity)
    try {
      const { startSessionKeeper } = await import('../services/session-keeper.js')
      startSessionKeeper()
    } catch (err: any) {
      console.warn('[Server] Session keeper init failed:', err.message)
    }
  }

  watchdog = new Watchdog()
  watchdog.start()

  // Initialize TLS connection pool for HTTP/2 multiplexing
  try {
    const { initTLSPool } = await import('../services/tls-pool.js')
    await initTLSPool()
    console.log('[Server] TLS connection pool initialized')
  } catch (err: any) {
    console.warn('[Server] TLS pool init failed (using standard fetch):', err.message)
  }

  metrics.startCollection()

  // Initialize proxy pool
  try {
    const { initProxyPool } = await import('../services/proxy-pool.js')
    initProxyPool()
  } catch (err: any) {
    console.warn('[Server] Proxy pool init failed:', err.message)
  }

  server = serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, async (info) => {
    console.log(`Server listening on http://${info.address}:${info.port}`)

    // Notify GUI (or other listeners) that the server is ready
    onReady?.(info.port)

    // Initialize WebSocket signaling server for Browser-Direct mode
    try {
      const wsServer = await import('../api/ws-server.js')
      wsServer.initSignalingServer(server)
      console.log('[Server] WebSocket signaling server initialized')
    } catch (err: any) {
      console.warn('[Server] WebSocket signaling init failed:', err.message)
    }
  })

  const shutdown = async (signal: string) => {
    console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`)

    // Safety: force-exit after 10s if cleanup hangs
    const forceExitTimer = setTimeout(() => {
      console.error('[Shutdown] Cleanup timed out after 10s, force exiting')
      process.exit(1)
    }, 10_000)
    forceExitTimer.unref()

    try {
      // Stop stream warmer before anything else (prevents background requests during shutdown)
      try {
        const { stopStreamWarmer } = await import('../services/stream-warmer.js')
        stopStreamWarmer()
      } catch { /* ignore */ }
      // Stop session keep-alive
      try {
        const { stopSessionKeeper } = await import('../services/session-keeper.js')
        stopSessionKeeper()
      } catch { /* ignore */ }
      watchdog.stop()
      metrics.stopCollection()
      requestLogger.stop()
      await cache.close()
      // Shutdown TLS pool gracefully
      try {
        const { shutdownTLSPool } = await import('../services/tls-pool.js')
        await shutdownTLSPool()
      } catch { /* ignore */ }
      // Shutdown WebSocket bridge
      try {
        const { shutdownWSBridge } = await import('../services/stream-ws-bridge.js')
        shutdownWSBridge()
      } catch { /* ignore */ }
      // Shutdown WebSocket signaling server
      try {
        const { shutdownSignalingServer } = await import('../api/ws-server.js')
        shutdownSignalingServer()
      } catch { /* ignore */ }
      // Close Playwright (browser + contexts)
      try {
        const { closePlaywright } = await import('../services/playwright.js')
        await closePlaywright()
      } catch (err) {
        console.error('[Shutdown] Error closing Playwright:', err)
      }
    } finally {
      clearTimeout(forceExitTimer)
      // Force-kill Chrome if closePlaywright missed anything
      try {
        const { forceKillOrphans } = await import('../services/browser-manager.js')
        forceKillOrphans()
      } catch { /* ignore */ }
      const { closeDatabase } = await import('../core/database.js')
      closeDatabase()
      requestStore.close()
      server?.close()
      process.exit(0)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

export { app }
