import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { config } from './config.js'

export interface DebugStateData {
  enabled: boolean
  updatedAt: number
}

class DebugState extends EventEmitter {
  private enabled: boolean
  private updatedAt: number
  private persistPath: string | null

  constructor() {
    super()
    this.persistPath = config.debug.persist
      ? path.resolve(process.cwd(), 'data', 'debug-state.json')
      : null
    this.updatedAt = Date.now()

    // Load persisted state or use env default
    if (this.persistPath && fs.existsSync(this.persistPath)) {
      try {
        const raw = fs.readFileSync(this.persistPath, 'utf-8')
        const data: DebugStateData = JSON.parse(raw)
        this.enabled = data.enabled
        this.updatedAt = data.updatedAt || Date.now()
        console.log(`[DebugState] Loaded persisted state: enabled=${this.enabled}`)
      } catch {
        this.enabled = config.debug.initialMode
      }
    } else {
      this.enabled = config.debug.initialMode
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(value: boolean): void {
    if (this.enabled === value) return
    this.enabled = value
    this.updatedAt = Date.now()
    this.persist()
    this.emit('change', { enabled: this.enabled, updatedAt: this.updatedAt })
    console.log(`[DebugState] Debug mode ${this.enabled ? 'ENABLED' : 'DISABLED'}`)
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled)
    return this.enabled
  }

  toJSON(): DebugStateData {
    return {
      enabled: this.enabled,
      updatedAt: this.updatedAt,
    }
  }

  private persist(): void {
    if (!this.persistPath) return
    try {
      const dir = path.dirname(this.persistPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(this.toJSON(), null, 2))
    } catch (err) {
      console.error('[DebugState] Failed to persist state:', err)
    }
  }
}

let instance: DebugState | null = null

export function initDebugState(): DebugState {
  if (!instance) {
    instance = new DebugState()
  }
  return instance
}

export function getDebugState(): DebugState {
  if (!instance) {
    instance = new DebugState()
  }
  return instance
}
