/**
 * DashboardWindow : fenêtre native pour le dashboard via OpenTray WebView.
 * Utilise @opentray/ext-webview pour créer une fenêtre WebView2 (Edge) sur Windows.
 */

import { exec } from 'node:child_process'
import type { TrayHandle } from 'opentray'
import { WebviewExt, type WebviewWindowHandle } from '@opentray/ext-webview'
import { loadWindowState, saveWindowState, type WindowState } from './window-state.js'

export class DashboardWindow {
  private window: WebviewWindowHandle | null = null
  private tray: TrayHandle | null = null
  private windowState: WindowState
  private dashboardUrl: string

  constructor(tray: TrayHandle, port: number) {
    this.tray = tray
    this.dashboardUrl = `http://localhost:${port}/index.html`
    this.windowState = loadWindowState()
  }

  async open(): Promise<void> {
    if (this.window) {
      // La fenêtre existe déjà, la focaliser
      try {
        await this.window.show()
      } catch {
        // La fenêtre a été fermée, en recréer une
        this.window = null
        await this.openNew()
      }
      return
    }
    await this.openNew()
  }

  private async openNew(): Promise<void> {
    try {
      // Étendre le tray avec la capacité webview via TrayHandle.extend()
      const extendedTray = this.tray!.extend(WebviewExt)

      this.window = extendedTray.createWebviewWindow({
        url: this.dashboardUrl,
        width: this.windowState.width,
        height: this.windowState.height,
        title: 'QwenProxy Dashboard',
        nativeWindowApi: true,
        bindWindowGlobals: true,
      })

      console.log(`[GUI] Dashboard window opened: ${this.dashboardUrl}`)
    } catch (err) {
      console.error(`[GUI] Failed to open webview window: ${err instanceof Error ? err.message : err}`)
      console.log('[GUI] Falling back to default browser...')
      this.fallbackToBrowser()
    }
  }

  private fallbackToBrowser(): void {
    const platform = process.platform
    const cmd = platform === 'win32'
      ? `start "" "${this.dashboardUrl}"`
      : platform === 'darwin'
        ? `open "${this.dashboardUrl}"`
        : `xdg-open "${this.dashboardUrl}"`
    exec(cmd, (err) => {
      if (err) {
        console.error(`[GUI] Failed to open browser: ${err.message}`)
        console.log(`[GUI] Open manually: ${this.dashboardUrl}`)
      } else {
        console.log('[GUI] Dashboard opened in default browser (webview unavailable)')
      }
    })
  }

  async close(): Promise<void> {
    if (this.window) {
      try {
        await this.window.hide()
      } catch {
        // Ignorer les erreurs de fermeture
      }
      this.window = null
    }
    // Sauvegarder l'état de la fenêtre
    saveWindowState(this.windowState)
  }

  isOpen(): boolean {
    return this.window !== null
  }

  getUrl(): string {
    return this.dashboardUrl
  }
}
