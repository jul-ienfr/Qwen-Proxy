/**
 * TrayManager : gestion de l'icône system tray via OpenTray.
 * Gère le menu contextuel, le double-clic, et les changements d'état.
 */

import { createClient, type SpaceHandle, type TrayHandle } from 'opentray'
import { connectLocalBroker, type LocalBrokerClient } from 'opentray/node'
import { getRunningIcon, getStoppedIcon } from './tray-icons.js'
import { config, configManager } from '../core/config.js'

export interface TrayManagerOptions {
  port: number
  onOpenDashboard: () => void
  onStartServer: () => void
  onStopServer: () => void
  onToggleBrowser: () => void
  onQuit: () => void
}

// Menu item IDs (doivent être des nombres uniques)
const MENU_OPEN = 1
const MENU_STOP = 3
const MENU_START = 4
const MENU_QUIT = 5
const MENU_TOGGLE_BROWSER = 6

export class TrayManager {
  private tray: TrayHandle | null = null
  private space: SpaceHandle | null = null
  private broker: LocalBrokerClient | null = null
  private options: TrayManagerOptions
  private serverRunning = false
  private removeEventListeners: (() => void)[] = []
  private nextRequestId = 0

  constructor(options: TrayManagerOptions) {
    this.options = options
  }

  /** Expose le TrayHandle pour que DashboardWindow puisse l'étendre avec WebviewExt */
  getTrayHandle(): TrayHandle | null {
    return this.tray
  }

  private generateRequestId(): string {
    this.nextRequestId++
    return `qwenproxy-tray-${this.nextRequestId}`
  }

  async start(): Promise<void> {
    try {
      // Connexion au broker OpenTray (démarre le daemon si nécessaire)
      this.broker = await connectLocalBroker({ autoStart: true })

      // Créer un espace et le tray
      const client = createClient(this.broker)
      this.space = await client.createSpace({
        id: 'qwenproxy',
        title: 'QwenProxy',
        default: true,
      })

      this.tray = await this.space.createTray({
        trayId: 'qwenproxy',
        title: 'QwenProxy',
        tooltip: { title: 'QwenProxy', description: 'Proxy en cours de démarrage...' },
        icon: getStoppedIcon(),
        menu: this.buildMenu(false),
      })

      // Écouter les événements du broker (stocker le cleanup)
      const removeListener = this.broker.onEvent((frame) => {
        if (frame.type === 'event') {
          const event = frame.event
          if (event.type === 'menuClick') {
            this.handleMenuClick(event.itemId)
          } else if (event.type === 'trayDoubleClick') {
            this.options.onOpenDashboard()
          }
        }
      })
      this.removeEventListeners.push(removeListener)

      console.log('[GUI] System tray icon created')
    } catch (err) {
      console.error(`[GUI] Failed to create tray: ${err instanceof Error ? err.message : err}`)
      throw err
    }
  }

  private buildMenu(running: boolean) {
    const browserVisible = !config.browser.headless
    return {
      items: [
        { type: 'item' as const, id: MENU_OPEN, title: '📊 Ouvrir Dashboard', primaryEvent: true },
        { type: 'separator' as const },
        {
          type: 'item' as const,
          id: running ? MENU_STOP : MENU_START,
          title: running ? '⏸️  Arrêter le serveur' : '▶️  Démarrer le serveur',
        },
        {
          type: 'item' as const,
          id: MENU_TOGGLE_BROWSER,
          title: browserVisible ? '🖥️  Masquer le navigateur' : '👁️  Afficher le navigateur',
        },
        { type: 'separator' as const },
        { type: 'item' as const, id: MENU_QUIT, title: '❌ Quitter' },
      ],
    }
  }

  private handleMenuClick(itemId: number): void {
    switch (itemId) {
      case MENU_OPEN:
        this.options.onOpenDashboard()
        break
      case MENU_STOP:
        this.options.onStopServer()
        break
      case MENU_START:
        this.options.onStartServer()
        break
      case MENU_TOGGLE_BROWSER:
        this.options.onToggleBrowser()
        break
      case MENU_QUIT:
        this.options.onQuit()
        break
    }
  }

  /** Met à jour l'icône et le menu selon l'état du serveur */
  async updateServerState(running: boolean): Promise<void> {
    this.serverRunning = running

    if (!this.broker || !this.tray || !this.space) return

    try {
      const icon = running ? getRunningIcon() : getStoppedIcon()
      const spaceId = this.space.space.spaceId
      const trayId = this.tray.trayId

      // Mettre à jour l'icône via le transport
      await this.broker.request({
        type: 'set-tray-icon',
        requestId: this.generateRequestId(),
        spaceId,
        trayId,
        icon,
      })

      // Mettre à jour le menu
      await this.broker.request({
        type: 'set-tray-menu',
        requestId: this.generateRequestId(),
        spaceId,
        trayId,
        menu: this.buildMenu(running),
      })

      // Mettre à jour le tooltip
      await this.broker.request({
        type: 'set-tray-tooltip',
        requestId: this.generateRequestId(),
        spaceId,
        trayId,
        tooltip: {
          title: 'QwenProxy',
          description: running ? 'Serveur actif — Clic-droit pour les options' : 'Serveur arrêté',
        },
      })
    } catch (err) {
      console.warn(`[GUI] Failed to update tray state: ${err instanceof Error ? err.message : err}`)
    }
  }

  async destroy(): Promise<void> {
    try {
      // Nettoyer les listeners
      for (const remove of this.removeEventListeners) {
        remove()
      }
      this.removeEventListeners = []

      if (this.tray) {
        await this.tray.destroy()
        this.tray = null
      }
      if (this.broker) {
        await this.broker.close()
        this.broker = null
      }
    } catch (err) {
      console.warn(`[GUI] Error destroying tray: ${err instanceof Error ? err.message : err}`)
    }
  }
}
