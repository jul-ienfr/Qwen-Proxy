/**
 * GuiManager : coordonne le tray et la fenêtre dashboard.
 * Point d'entrée principal pour le mode GUI.
 */

import { TrayManager } from './tray.js'
import { DashboardWindow } from './window.js'
import { config, configManager } from '../core/config.js'

export class GuiManager {
  private tray: TrayManager | null = null
  private window: DashboardWindow | null = null
  private initializing = false
  private port: number
  private serverRunning = false

  constructor(port: number) {
    this.port = port
  }

  async start(): Promise<void> {
    this.tray = new TrayManager({
      port: this.port,
      onOpenDashboard: () => this.openDashboard(),
      onStartServer: () => {
        console.log('[GUI] Start server requested (server is always running in GUI mode)')
      },
      onStopServer: () => {
        console.log('[GUI] Stop server requested — use Ctrl+C or Quit to stop')
      },
      onToggleBrowser: () => {
        const newHeadless = !config.browser.headless
        console.log(`[GUI] Toggling browser visibility: headless ${config.browser.headless} → ${newHeadless}`)
        configManager.updateConfig('browser.headless', newHeadless)
        // Tray refresh is handled by the config:change listener below
      },
      onQuit: () => {
        console.log('[GUI] Quit requested')
        this.shutdown().then(() => process.exit(0)).catch(() => process.exit(1))
      },
    })

    await this.tray.start()

    // Listen for browser.headless changes to refresh tray menu
    configManager.on('config:change', (event) => {
      if (event.path === 'browser.headless') {
        this.tray?.updateServerState(this.serverRunning)
      }
    })
  }

  async openDashboard(): Promise<void> {
    if (this.window) {
      await this.window.open()
      return
    }

    // Garde contre les initialisations concurrentes (double-clic rapide)
    if (this.initializing) return
    this.initializing = true

    try {
      const win = await this.createWindow()
      if (win) {
        this.window = win
        await this.window.open()
      }
    } finally {
      this.initializing = false
    }
  }

  private async createWindow(): Promise<DashboardWindow | null> {
    try {
      const trayHandle = this.tray?.getTrayHandle()
      if (!trayHandle) {
        console.error('[GUI] No tray handle available for webview')
        console.log(`[GUI] Open dashboard manually: http://localhost:${this.port}`)
        return null
      }

      return new DashboardWindow(trayHandle, this.port)
    } catch (err) {
      console.error(`[GUI] Failed to init webview: ${err instanceof Error ? err.message : err}`)
      console.log(`[GUI] Open dashboard manually: http://localhost:${this.port}`)
      return null
    }
  }

  async updateServerState(running: boolean): Promise<void> {
    this.serverRunning = running
    await this.tray?.updateServerState(running)
  }

  async shutdown(): Promise<void> {
    await this.window?.close()
    await this.tray?.destroy()
  }
}

/**
 * Point d'entrée pour le mode GUI.
 * Démarre le serveur HTTP puis initialise le GUI.
 */
export async function startServerWithGui(): Promise<void> {
  const { startServer } = await import('../api/server.js')
  const { config } = await import('../core/config.js')

  const port = config.server.port
  const gui = new GuiManager(port)

  // Démarrer le GUI avant le serveur pour que le tray soit prêt
  await gui.start()
  console.log(`[GUI] Tray icon ready — dashboard will open at http://localhost:${port}`)

  // Enregistrer le GUI pour le nettoyage lors de l'arrêt du serveur
  registerGuiCleanup(gui)

  // Démarrer le serveur avec callback de readiness
  await startServer((readyPort: number) => {
    console.log(`[GUI] Server ready on port ${readyPort}`)
    gui.updateServerState(true)
    // Ouvrir le dashboard après un court délai pour laisser le serveur s'initialiser
    setTimeout(() => {
      gui.openDashboard().catch((err) => {
        console.error(`[GUI] Failed to open dashboard: ${err.message}`)
      })
    }, 1000)
  })
}

/**
 * Enregistre le nettoyage du GUI sur les signaux d'arrêt du serveur.
 * Intercepte SIGINT/SIGTERM pour détruire le tray avant la fermeture.
 */
function registerGuiCleanup(gui: GuiManager): void {
  // Intercepter SIGINT/SIGTERM pour nettoyer le GUI avant la fermeture
  // Le handler de server.ts gère déjà l'arrêt du serveur
  process.on('SIGINT', () => {
    gui.shutdown().catch(() => {})
  })

  process.on('SIGTERM', () => {
    gui.shutdown().catch(() => {})
  })
}
