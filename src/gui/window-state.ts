/**
 * Persistance de la taille/position de la fenêtre dashboard.
 * Stocké dans data/gui-state.json (pattern identique à config/runtime-config.json).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface WindowState {
  width: number
  height: number
  x: number | null
  y: number | null
}

const DEFAULT_STATE: WindowState = {
  width: 1200,
  height: 800,
  x: null,
  y: null,
}

const STATE_DIR = path.resolve(process.cwd(), 'data')
const STATE_FILE = path.join(STATE_DIR, 'gui-state.json')

export function loadWindowState(): WindowState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_STATE.width,
        height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_STATE.height,
        x: typeof parsed.x === 'number' ? parsed.x : null,
        y: typeof parsed.y === 'number' ? parsed.y : null,
      }
    }
  } catch {
    // Fallback sur les valeurs par défaut
  }
  return { ...DEFAULT_STATE }
}

export function saveWindowState(state: WindowState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true })
    }
    const tmpPath = STATE_FILE + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2))
    fs.renameSync(tmpPath, STATE_FILE)
  } catch (err) {
    console.warn(`[GUI] Failed to save window state: ${err instanceof Error ? err.message : err}`)
  }
}
