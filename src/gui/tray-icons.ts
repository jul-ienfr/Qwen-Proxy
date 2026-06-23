/**
 * Icônes pour le system tray via OpenTray.
 * Utilise des fichiers PNG au lieu de pixels RGBA bruts
 * pour éviter le crash du daemon OpenTray 0.6.0.
 */

import path from 'path'

interface TrayIconFile {
  type: 'file'
  path: string
}

const ASSETS_DIR = path.resolve(process.cwd(), 'assets')

/** Icône verte = serveur actif */
export function getRunningIcon(): TrayIconFile {
  return { type: 'file', path: path.join(ASSETS_DIR, 'tray-running.png') }
}

/** Icône orange = serveur arrêté */
export function getStoppedIcon(): TrayIconFile {
  return { type: 'file', path: path.join(ASSETS_DIR, 'tray-stopped.png') }
}
