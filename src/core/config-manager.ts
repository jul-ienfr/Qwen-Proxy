/**
 * ConfigManager - Hot-reloadable configuration for QwenProxy
 *
 * Manages a mutable config object that can be updated at runtime.
 * Persists overrides to config/runtime-config.json.
 * Emits events when config values change.
 */

import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'

// ─── Config Type ─────────────────────────────────────────────────────────────

export interface AppConfig {
  server: {
    port: number
    host: string
  }
  browser: {
    headless: boolean
    type: string
    userDataDir: string
    userAgent: string
    args: string[]
    launchTimeout: number
    healthCheckInterval: number
    headers: Record<string, string>
    logConsole: boolean
  }
  timeouts: {
    navigation: number
    page: number
    http: number
    headers: number
    chat: number
    streamIdle: number
  }
  cache: {
    defaultTTL: number
    responseTTL: number
  }
  metrics: {
    interval: number
  }
  watchdog: {
    checkInterval: number
    consecutiveFailuresThreshold: number
    ram: {
      warningThreshold: number
      criticalThreshold: number
    }
    streams: {
      warningThreshold: number
      criticalThreshold: number
    }
  }
  apiKey: string
  directFetch: boolean
  fastStreamProxy: boolean
  tlsPoolSize: number
  tlsH2Enabled: boolean
  useWsBridge: boolean
  qwen: {
    baseUrl: string
    httpEndpoint: string
    apiKey: string
  }
  mapping: {
    configFile: string
    disableAutoMapping: boolean
  }
  logging: {
    enabled: boolean
    dbPath: string
    retentionDays: number
  }
  redis: {
    url: string
    token: string
    mode: string
  }
  debug: {
    initialMode: boolean
    bufferSize: number
    persist: boolean
  }
  session: {
    enabled: boolean
    ttlMs: number
    maxSessions: number
    autoDetect: boolean
    headerRefreshMs: number
  }
  rateLimit: {
    windowMs: number
    maxRequests: number
  }
  circuitBreaker: {
    failureThreshold: number
    resetTimeoutMs: number
    successThreshold: number
  }
  accounts: {
    singleAccountMode: boolean
    singleAccountId: string
    singleAccountEmail: string
    lanes: number
  }
}

// ─── Metadata Types ──────────────────────────────────────────────────────────

export interface FieldMetadata {
  category: string
  hotReloadable: boolean
  requiresRestart: boolean
  description: string
}

export interface ConfigChangeEvent {
  path: string
  oldValue: any
  newValue: any
  requiresRestart: boolean
}

// ─── Config Metadata ─────────────────────────────────────────────────────────

const CONFIG_METADATA: Record<string, FieldMetadata> = {
  // Server
  'server.port': { category: 'server', hotReloadable: false, requiresRestart: true, description: 'Port du serveur HTTP' },
  'server.host': { category: 'server', hotReloadable: false, requiresRestart: true, description: 'Hôte du serveur' },

  // Browser
  'browser.headless': { category: 'browser', hotReloadable: true, requiresRestart: false, description: 'Mode headless du navigateur' },
  'browser.type': { category: 'browser', hotReloadable: true, requiresRestart: false, description: 'Type de navigateur (chromium/firefox/webkit/chrome/edge)' },
  'browser.userDataDir': { category: 'browser', hotReloadable: true, requiresRestart: false, description: 'Répertoire des profils navigateur' },
  'browser.userAgent': { category: 'browser', hotReloadable: true, requiresRestart: false, description: 'User-Agent du navigateur' },
  'browser.logConsole': { category: 'browser', hotReloadable: true, requiresRestart: false, description: 'Logger la console navigateur' },

  // Timeouts
  'timeouts.navigation': { category: 'timeouts', hotReloadable: true, requiresRestart: false, description: 'Timeout de navigation (ms)' },
  'timeouts.page': { category: 'timeouts', hotReloadable: true, requiresRestart: false, description: 'Timeout de page (ms)' },
  'timeouts.http': { category: 'timeouts', hotReloadable: true, requiresRestart: false, description: 'Timeout HTTP (ms)' },
  'timeouts.headers': { category: 'timeouts', hotReloadable: true, requiresRestart: false, description: 'Timeout headers (ms)' },
  'timeouts.chat': { category: 'timeouts', hotReloadable: true, requiresRestart: false, description: 'Timeout chat (ms)' },
  'timeouts.streamIdle': { category: 'timeouts', hotReloadable: true, requiresRestart: false, description: 'Timeout idle stream (ms)' },

  // Cache
  'cache.defaultTTL': { category: 'cache', hotReloadable: true, requiresRestart: false, description: 'TTL par défaut du cache (secondes)' },
  'cache.responseTTL': { category: 'cache', hotReloadable: true, requiresRestart: false, description: 'TTL des réponses cache (secondes)' },

  // Metrics
  'metrics.interval': { category: 'metrics', hotReloadable: true, requiresRestart: false, description: 'Intervalle de collecte métriques (ms)' },

  // Watchdog
  'watchdog.checkInterval': { category: 'watchdog', hotReloadable: true, requiresRestart: false, description: 'Intervalle de vérification watchdog (ms)' },
  'watchdog.consecutiveFailuresThreshold': { category: 'watchdog', hotReloadable: true, requiresRestart: false, description: 'Seuil d\'échecs consécutifs' },
  'watchdog.ram.warningThreshold': { category: 'watchdog', hotReloadable: true, requiresRestart: false, description: 'Seuil warning RAM (%)' },
  'watchdog.ram.criticalThreshold': { category: 'watchdog', hotReloadable: true, requiresRestart: false, description: 'Seuil critique RAM (%)' },
  'watchdog.streams.warningThreshold': { category: 'watchdog', hotReloadable: true, requiresRestart: false, description: 'Seuil warning streams' },
  'watchdog.streams.criticalThreshold': { category: 'watchdog', hotReloadable: true, requiresRestart: false, description: 'Seuil critique streams' },

  // Qwen
  'qwen.baseUrl': { category: 'qwen', hotReloadable: true, requiresRestart: false, description: 'URL de base Qwen' },
  'qwen.httpEndpoint': { category: 'qwen', hotReloadable: true, requiresRestart: false, description: 'Endpoint HTTP Qwen' },
  'qwen.apiKey': { category: 'qwen', hotReloadable: true, requiresRestart: false, description: 'Clé API Qwen' },

  // Direct Fetch
  'directFetch': { category: 'general', hotReloadable: true, requiresRestart: false, description: 'Utiliser fetch direct Node.js (true) ou navigateur (false)' },
  'fastStreamProxy': { category: 'performance', hotReloadable: true, requiresRestart: false, description: 'Activer le proxy SSE zero-copy (gain 10-50x par chunk)' },
  'tlsPoolSize': { category: 'performance', hotReloadable: true, requiresRestart: false, description: 'Taille du pool de connexions TLS pré-établies' },
  'tlsH2Enabled': { category: 'performance', hotReloadable: true, requiresRestart: true, description: 'Activer HTTP/2 pour les connexions TLS (désactiver si le serveur ne le supporte pas)' },
  'useWsBridge': { category: 'performance', hotReloadable: true, requiresRestart: false, description: 'Utiliser le WebSocket in-page au lieu du CDP bridge (gain 50-200x)' },

  // API Key
  'apiKey': { category: 'general', hotReloadable: true, requiresRestart: false, description: 'Clé API pour authentifier les requêtes' },

  // Mapping
  'mapping.configFile': { category: 'mapping', hotReloadable: false, requiresRestart: true, description: 'Fichier de configuration du mapping' },
  'mapping.disableAutoMapping': { category: 'mapping', hotReloadable: true, requiresRestart: false, description: 'Désactiver l\'auto-mapping' },

  // Logging
  'logging.enabled': { category: 'logging', hotReloadable: true, requiresRestart: false, description: 'Activer le logging des requêtes' },
  'logging.dbPath': { category: 'logging', hotReloadable: false, requiresRestart: true, description: 'Chemin de la base SQLite' },
  'logging.retentionDays': { category: 'logging', hotReloadable: false, requiresRestart: true, description: 'Rétention des logs (jours)' },

  // Redis
  'redis.url': { category: 'redis', hotReloadable: false, requiresRestart: true, description: 'URL Redis' },
  'redis.token': { category: 'redis', hotReloadable: false, requiresRestart: true, description: 'Token Redis' },

  // Debug
  'debug.initialMode': { category: 'debug', hotReloadable: true, requiresRestart: false, description: 'Mode debug initial' },
  'debug.bufferSize': { category: 'debug', hotReloadable: true, requiresRestart: false, description: 'Taille du buffer debug' },
  'debug.persist': { category: 'debug', hotReloadable: true, requiresRestart: false, description: 'Persister l\'état debug' },

  // Session
  'session.enabled': { category: 'session', hotReloadable: true, requiresRestart: false, description: 'Activer la gestion des sessions multi-tours' },
  'session.ttlMs': { category: 'session', hotReloadable: true, requiresRestart: false, description: 'TTL des sessions en millisecondes' },
  'session.maxSessions': { category: 'session', hotReloadable: true, requiresRestart: false, description: 'Nombre maximum de sessions concurrentes' },
  'session.autoDetect': { category: 'session', hotReloadable: true, requiresRestart: false, description: 'Auto-détecter les sessions par comparaison de messages' },
  'session.headerRefreshMs': { category: 'session', hotReloadable: true, requiresRestart: false, description: 'Délai avant refresh des headers (ms)' },

  // Rate Limiting
  'rateLimit.windowMs': { category: 'rateLimit', hotReloadable: true, requiresRestart: false, description: 'Fenêtre glissante de rate limiting (ms)' },
  'rateLimit.maxRequests': { category: 'rateLimit', hotReloadable: true, requiresRestart: false, description: 'Nombre max de requêtes par fenêtre glissante' },

  // Circuit Breaker
  'circuitBreaker.failureThreshold': { category: 'circuitBreaker', hotReloadable: true, requiresRestart: false, description: 'Seuil d\'échecs avant ouverture du circuit' },
  'circuitBreaker.resetTimeoutMs': { category: 'circuitBreaker', hotReloadable: true, requiresRestart: false, description: 'Timeout avant tentative half-open (ms)' },
  'circuitBreaker.successThreshold': { category: 'circuitBreaker', hotReloadable: true, requiresRestart: false, description: 'Seuil de succès pour fermer le circuit' },
}

// ─── ConfigManager Class ─────────────────────────────────────────────────────

export class ConfigManager extends EventEmitter {
  private _config: AppConfig
  private _defaults: AppConfig
  private _overrides: Record<string, any> = {}
  private persistPath: string

  constructor() {
    super()
    this.persistPath = path.resolve(process.cwd(), 'config', 'runtime-config.json')

    // Build config from env vars
    this._defaults = this.buildConfigFromEnv()
    this._config = JSON.parse(JSON.stringify(this._defaults))

    // Load persisted overrides
    this.loadOverrides()
  }

  get config(): AppConfig {
    return this._config
  }

  get configDefaults(): AppConfig {
    return this._defaults
  }

  /**
   * Get the raw env-var-derived config (before overrides)
   */
  private buildConfigFromEnv(): AppConfig {
    const envSchema = z.object({
      PORT: z.string().default('3000'),
      HOST: z.string().default('0.0.0.0'),
      HEADLESS: z.string().default('true'),
      BROWSER: z.enum(['chromium', 'firefox', 'webkit', 'chrome', 'edge']).default('chromium'),
      USER_DATA_DIR: z.string().default('./qwen_profiles'),
      USER_AGENT: z.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'),
      LOG_CONSOLE: z.string().default('false'),
      NAVIGATION_TIMEOUT: z.string().default('90000'),
      PAGE_TIMEOUT: z.string().default('60000'),
      HTTP_TIMEOUT: z.string().default('45000'),
      HEADERS_TIMEOUT: z.string().default('90000'),
      CHAT_TIMEOUT: z.string().default('120000'),
      STREAM_IDLE_TIMEOUT: z.string().default('180000'),
      CACHE_TTL: z.string().default('3600'),
      RESPONSE_TTL: z.string().default('1800'),
      METRICS_INTERVAL: z.string().default('10000'),
      WATCHDOG_INTERVAL: z.string().default('5000'),
      WATCHDOG_FAILURES: z.string().default('3'),
      RAM_WARNING: z.string().default('80'),
      RAM_CRITICAL: z.string().default('95'),
      WS_WARNING: z.string().default('50'),
      WS_CRITICAL: z.string().default('100'),
      QWEN_BASE_URL: z.string().default('https://chat.qwen.ai'),
      QWEN_HTTP_ENDPOINT: z.string().default('https://api.qwen.ai/v1/chat'),
      QWEN_API_KEY: z.string().default(''),
      API_KEY: z.string().default(''),
      DIRECT_FETCH: z.string().default('true'),
      FAST_STREAM_PROXY: z.string().default('true'),
      TLS_POOL_SIZE: z.string().default('5'),
      TLS_H2_ENABLED: z.string().default('true'),
      USE_WS_BRIDGE: z.string().default('false'),
      USE_HTTP3: z.string().default('false'),
      WARM_POOL_SIZE: z.string().default('10'),
      WARM_POOL_LOW_WATER: z.string().default('3'),
      WARM_POOL_PARALLEL: z.string().default('3'),
      WARM_POOL_DELAY_MS: z.string().default('500'),
      MODEL_MAPPING_FILE: z.string().default('./config/model-mapping.json'),
      DISABLE_AUTO_MAPPING: z.string().default('false'),
      REQUEST_LOG_ENABLED: z.string().default('true'),
      REQUEST_LOG_DB: z.string().default('./data/requests.db'),
      REQUEST_LOG_RETENTION_DAYS: z.string().default('30'),
      REDIS_URL: z.string().default(''),
      REDIS_TOKEN: z.string().default(''),
      DEBUG_MODE: z.string().default('false'),
      DEBUG_BUFFER_SIZE: z.string().default('5000'),
      DEBUG_PERSIST: z.string().default('false'),
      SESSION_ENABLED: z.string().default('true'),
      SESSION_TTL: z.string().default('1800000'),
      SESSION_MAX: z.string().default('200'),
      SESSION_AUTO_DETECT: z.string().default('true'),
      SESSION_HEADER_REFRESH: z.string().default('210000'),
      RATE_LIMIT_WINDOW: z.string().default('60000'),
      RATE_LIMIT_MAX: z.string().default('100'),
      CB_FAILURE_THRESHOLD: z.string().default('5'),
      CB_RESET_TIMEOUT: z.string().default('60000'),
      CB_SUCCESS_THRESHOLD: z.string().default('3'),
    })

    const env = envSchema.parse(process.env)

    return {
      server: {
        port: parseInt(env.PORT),
        host: env.HOST,
      },
      browser: {
        headless: env.HEADLESS !== 'false',
        type: env.BROWSER,
        userDataDir: env.USER_DATA_DIR,
        userAgent: env.USER_AGENT,
        args: [],
        launchTimeout: 30000,
        healthCheckInterval: 30000,
        headers: {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
        logConsole: env.LOG_CONSOLE === 'true',
      },
      timeouts: {
        navigation: parseInt(env.NAVIGATION_TIMEOUT),
        page: parseInt(env.PAGE_TIMEOUT),
        http: parseInt(env.HTTP_TIMEOUT),
        headers: parseInt(env.HEADERS_TIMEOUT),
        chat: parseInt(env.CHAT_TIMEOUT),
        streamIdle: parseInt(env.STREAM_IDLE_TIMEOUT),
      },
      cache: {
        defaultTTL: parseInt(env.CACHE_TTL),
        responseTTL: parseInt(env.RESPONSE_TTL),
      },
      metrics: {
        interval: parseInt(env.METRICS_INTERVAL),
      },
      watchdog: {
        checkInterval: parseInt(env.WATCHDOG_INTERVAL),
        consecutiveFailuresThreshold: parseInt(env.WATCHDOG_FAILURES),
        ram: {
          warningThreshold: parseInt(env.RAM_WARNING),
          criticalThreshold: parseInt(env.RAM_CRITICAL),
        },
        streams: {
          warningThreshold: parseInt(env.WS_WARNING),
          criticalThreshold: parseInt(env.WS_CRITICAL),
        },
      },
      apiKey: env.API_KEY,
      directFetch: env.DIRECT_FETCH === 'true',
      fastStreamProxy: env.FAST_STREAM_PROXY === 'true',
      tlsPoolSize: parseInt(env.TLS_POOL_SIZE),
      tlsH2Enabled: env.TLS_H2_ENABLED !== 'false',
      useWsBridge: env.USE_WS_BRIDGE === 'true',
      qwen: {
        baseUrl: env.QWEN_BASE_URL,
        httpEndpoint: env.QWEN_HTTP_ENDPOINT,
        apiKey: env.QWEN_API_KEY,
      },
      mapping: {
        configFile: env.MODEL_MAPPING_FILE,
        disableAutoMapping: env.DISABLE_AUTO_MAPPING === 'true',
      },
      logging: {
        enabled: env.REQUEST_LOG_ENABLED === 'true',
        dbPath: env.REQUEST_LOG_DB,
        retentionDays: parseInt(env.REQUEST_LOG_RETENTION_DAYS),
      },
      redis: {
        url: env.REDIS_URL,
        token: env.REDIS_TOKEN,
        mode: env.REDIS_URL ? (env.REDIS_TOKEN ? 'upstash' : 'redis') : 'none',
      },
      debug: {
        initialMode: env.DEBUG_MODE === 'true',
        bufferSize: parseInt(env.DEBUG_BUFFER_SIZE),
        persist: env.DEBUG_PERSIST === 'true',
      },
      session: {
        enabled: env.SESSION_ENABLED === 'true',
        ttlMs: parseInt(env.SESSION_TTL),
        maxSessions: parseInt(env.SESSION_MAX),
        autoDetect: env.SESSION_AUTO_DETECT === 'true',
        headerRefreshMs: parseInt(env.SESSION_HEADER_REFRESH),
      },
      rateLimit: {
        windowMs: parseInt(env.RATE_LIMIT_WINDOW),
        maxRequests: parseInt(env.RATE_LIMIT_MAX),
      },
      circuitBreaker: {
        failureThreshold: parseInt(env.CB_FAILURE_THRESHOLD),
        resetTimeoutMs: parseInt(env.CB_RESET_TIMEOUT),
        successThreshold: parseInt(env.CB_SUCCESS_THRESHOLD),
      },
      accounts: {
        singleAccountMode: false,
        singleAccountId: '',
        singleAccountEmail: '',
        lanes: 1,
      },
    }
  }

  /**
   * Get value at a dot-notation path
   */
  get(path: string): any {
    const parts = path.split('.')
    let obj: any = this._config
    for (const part of parts) {
      if (obj === null || obj === undefined) return undefined
      obj = obj[part]
    }
    return obj
  }

  /**
   * Get default value at a dot-notation path
   */
  getDefault(path: string): any {
    const parts = path.split('.')
    let obj: any = this._defaults
    for (const part of parts) {
      if (obj === null || obj === undefined) return undefined
      obj = obj[part]
    }
    return obj
  }

  /**
   * Set value at a dot-notation path (mutates in place)
   */
  private set(path: string, value: any): void {
    const parts = path.split('.')
    let obj: any = this._config
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] === undefined) obj[parts[i]] = {}
      obj = obj[parts[i]]
    }
    obj[parts[parts.length - 1]] = value
  }

  /**
   * Update a config value with validation
   */
  updateConfig(path: string, value: any): { success: boolean; error?: string; oldValue?: any; newValue?: any } {
    const meta = CONFIG_METADATA[path]
    if (!meta) {
      return { success: false, error: `Unknown config path: ${path}` }
    }

    // Validate type
    const validation = this.validateValue(path, value)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }

    const oldValue = this.get(path)

    // Apply change
    this.set(path, value)
    this._overrides[path] = value

    // Persist
    this.saveOverrides()

    // Emit event
    this.emit('config:change', {
      path,
      oldValue,
      newValue: value,
      requiresRestart: meta.requiresRestart,
    } as ConfigChangeEvent)

    console.log(`[ConfigManager] ${path}: ${JSON.stringify(oldValue)} → ${JSON.stringify(value)}${meta.requiresRestart ? ' (requires restart)' : ''}`)

    return { success: true, oldValue, newValue: value }
  }

  /**
   * Batch update multiple config values
   */
  batchUpdate(updates: Array<{ path: string; value: any }>): { success: boolean; error?: string; changes?: Array<{ path: string; oldValue: any; newValue: any }> } {
    // Validate all first
    for (const { path, value } of updates) {
      if (!CONFIG_METADATA[path]) {
        return { success: false, error: `Unknown config path: ${path}` }
      }
      const validation = this.validateValue(path, value)
      if (!validation.success) {
        return { success: false, error: `Invalid value for ${path}: ${validation.error}` }
      }
    }

    // Apply all
    const changes: Array<{ path: string; oldValue: any; newValue: any }> = []
    for (const { path, value } of updates) {
      const oldValue = this.get(path)
      this.set(path, value)
      this._overrides[path] = value
      changes.push({ path, oldValue, newValue: value })

      const meta = CONFIG_METADATA[path]
      this.emit('config:change', {
        path,
        oldValue,
        newValue: value,
        requiresRestart: meta?.requiresRestart || false,
      } as ConfigChangeEvent)
    }

    this.saveOverrides()
    return { success: true, changes }
  }

  /**
   * Reset a config path (or all) to defaults
   */
  resetConfig(path?: string): { success: boolean; error?: string } {
    if (path) {
      if (!CONFIG_METADATA[path]) {
        return { success: false, error: `Unknown config path: ${path}` }
      }
      const defaultValue = this.getDefault(path)
      const oldValue = this.get(path)
      this.set(path, defaultValue)
      delete this._overrides[path]

      this.emit('config:change', {
        path,
        oldValue,
        newValue: defaultValue,
        requiresRestart: CONFIG_METADATA[path]?.requiresRestart || false,
      } as ConfigChangeEvent)
    } else {
      // Reset all
      this._config = JSON.parse(JSON.stringify(this._defaults))
      this._overrides = {}
    }

    this.saveOverrides()
    return { success: true }
  }

  /**
   * Get config metadata for all fields
   */
  getConfigMetadata(): Record<string, FieldMetadata> {
    return CONFIG_METADATA
  }

  /**
   * Get config with masked secrets
   */
  getSanitizedConfig(): any {
    const config = JSON.parse(JSON.stringify(this._config))
    if (config.apiKey) config.apiKey = maskSecret(config.apiKey)
    if (config.qwen?.apiKey) config.qwen.apiKey = maskSecret(config.qwen.apiKey)
    if (config.redis?.token) config.redis.token = maskSecret(config.redis.token)
    return config
  }

  /**
   * Get full config info with metadata
   */
  getFullConfigInfo(): { config: any; metadata: Record<string, FieldMetadata & { currentValue: any; defaultValue: any; isOverridden: boolean }> } {
    const config = this.getSanitizedConfig()
    const metadata: Record<string, any> = {}

    for (const [path, meta] of Object.entries(CONFIG_METADATA)) {
      metadata[path] = {
        ...meta,
        currentValue: this.get(path),
        defaultValue: this.getDefault(path),
        isOverridden: path in this._overrides,
      }
    }

    return { config, metadata }
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  private validateValue(path: string, value: any): { success: boolean; error?: string } {
    try {
      // Type validation based on the expected type
      const defaultValue = this.getDefault(path)

      if (typeof defaultValue === 'number') {
        if (typeof value !== 'number' || isNaN(value)) {
          return { success: false, error: `Expected number, got ${typeof value}` }
        }
        if (value < 0) {
          return { success: false, error: `Value must be non-negative` }
        }
      } else if (typeof defaultValue === 'boolean') {
        if (typeof value !== 'boolean') {
          return { success: false, error: `Expected boolean, got ${typeof value}` }
        }
      } else if (typeof defaultValue === 'string') {
        if (typeof value !== 'string') {
          return { success: false, error: `Expected string, got ${typeof value}` }
        }
      }

      // Specific validations
      if (path === 'browser.type') {
        const valid = ['chromium', 'firefox', 'webkit', 'chrome', 'edge']
        if (!valid.includes(value)) {
          return { success: false, error: `Must be one of: ${valid.join(', ')}` }
        }
      }

      if (path.endsWith('Timeout') || path.endsWith('Interval')) {
        if (value < 1000) {
          return { success: false, error: `Value must be at least 1000ms` }
        }
      }

      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private loadOverrides(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf-8')
        const overrides = JSON.parse(raw)

        // Apply each override
        for (const [path, value] of Object.entries(overrides)) {
          if (CONFIG_METADATA[path]) {
            this.set(path, value)
            this._overrides[path] = value
          }
        }
        console.log(`[ConfigManager] Loaded ${Object.keys(this._overrides).length} override(s) from ${this.persistPath}`)
      }
    } catch (err: any) {
      console.error(`[ConfigManager] Failed to load overrides: ${err.message}`)
    }
  }

  private saveOverrides(): void {
    try {
      const dir = path.dirname(this.persistPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // Atomic write
      const tmpPath = this.persistPath + '.tmp'
      fs.writeFileSync(tmpPath, JSON.stringify(this._overrides, null, 2))
      fs.renameSync(tmpPath, this.persistPath)
    } catch (err: any) {
      console.error(`[ConfigManager] Failed to save overrides: ${err.message}`)
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let instance: ConfigManager | null = null

export function getConfigManager(): ConfigManager {
  if (!instance) {
    instance = new ConfigManager()
  }
  return instance
}
