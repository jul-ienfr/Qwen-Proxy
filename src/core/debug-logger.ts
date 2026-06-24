import crypto from 'crypto'
import { config } from './config.js'
import { getDebugState } from './debug-state.js'

export type DebugCategory =
  | 'REQUEST'
  | 'RESPONSE'
  | 'TIMING'
  | 'BROWSER'
  | 'CACHE'
  | 'MAPPING'
  | 'ERROR'
  | 'INTERNAL'
  | 'ACCOUNT'
  | 'STREAM'
  | 'SESSION'

export interface DebugLogEntry {
  id: string
  timestamp: number
  category: DebugCategory
  component: string
  message: string
  metadata?: Record<string, unknown>
}

export interface DebugLogQuery {
  category?: string
  component?: string
  search?: string
  limit?: number
  offset?: number
  since?: number
}

export interface DebugLogResult {
  entries: DebugLogEntry[]
  total: number
  hasMore: boolean
  stats: {
    enabled: boolean
    bufferUsed: number
    maxSize: number
  }
}

class DebugLogger {
  private buffer: DebugLogEntry[] = []
  private maxSize: number
  private enabled: boolean = false
  private evictThreshold: number // Trigger eviction at 2x to amortize cost

  constructor() {
    this.maxSize = config.debug.bufferSize
    this.evictThreshold = this.maxSize * 2
    const state = getDebugState()
    this.enabled = state.isEnabled()

    // React to state changes instantly
    state.on('change', ({ enabled }: { enabled: boolean }) => {
      this.enabled = enabled
    })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  log(
    category: DebugCategory,
    component: string,
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.enabled) return

    const entry: DebugLogEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      category,
      component,
      message,
      metadata,
    }

    this.buffer.push(entry)

    // Batch eviction: let buffer grow to 2x, then truncate by reassignment (O(1) amortized)
    if (this.buffer.length > this.evictThreshold) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxSize)
    }
  }

  getEntries(query: DebugLogQuery = {}): DebugLogResult {
    const {
      category,
      component,
      search,
      limit = 100,
      offset = 0,
      since,
    } = query

    let filtered = this.buffer

    if (category) {
      filtered = filtered.filter(e => e.category === category)
    }
    if (component) {
      filtered = filtered.filter(e => e.component === component)
    }
    if (since) {
      filtered = filtered.filter(e => e.timestamp >= since)
    }
    if (search) {
      const lower = search.toLowerCase()
      filtered = filtered.filter(e =>
        e.message.toLowerCase().includes(lower) ||
        e.component.toLowerCase().includes(lower) ||
        (e.metadata && JSON.stringify(e.metadata).toLowerCase().includes(lower))
      )
    }

    const total = filtered.length
    const entries = filtered.slice(offset, offset + limit)

    return {
      entries,
      total,
      hasMore: offset + limit < total,
      stats: {
        enabled: this.enabled,
        bufferUsed: this.buffer.length,
        maxSize: this.maxSize,
      },
    }
  }

  clear(): number {
    const count = this.buffer.length
    this.buffer = []
    return count
  }

  setBufferSize(size: number): void {
    this.maxSize = Math.max(100, size)
    this.evictThreshold = this.maxSize * 2
    // Evict excess entries immediately
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxSize)
    }
  }

  getStats(): { total: number; enabled: boolean; maxSize: number } {
    return {
      total: this.buffer.length,
      enabled: this.enabled,
      maxSize: this.maxSize,
    }
  }
}

let instance: DebugLogger | null = null

export function getDebugLogger(): DebugLogger {
  if (!instance) {
    instance = new DebugLogger()
  }
  return instance
}
