/**
 * Configuration - Uses ConfigManager for hot-reloadable config
 *
 * The `config` export is the same object reference throughout the lifecycle.
 * Properties are mutated in place, so all existing imports work dynamically.
 *
 * IMPORTANT: Uses getConfigManager() singleton to ensure all modules share
 * the same ConfigManager instance (avoids dual-singleton split).
 */

import { getConfigManager } from './config-manager.js'

const manager = getConfigManager()

/** The mutable config object — all existing imports read from this */
export const config = manager.config

/** The ConfigManager instance for updates, events, and metadata */
export { manager as configManager }

/** Default values from env vars */
export const configDefaults = manager.configDefaults

export type Config = typeof config
