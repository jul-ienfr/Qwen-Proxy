/**
 * Config Watcher - Hot-reload configuration files
 * Inspired by OpenCode-Proxy's maybe_reload_custom_routes()
 */

import fs from 'fs';
import path from 'path';

interface WatcherEntry {
  filePath: string;
  lastModified: number;
  callback: () => void;
  interval: NodeJS.Timeout | null;
}

export class ConfigWatcher {
  private watchers: Map<string, WatcherEntry> = new Map();
  private checkIntervalMs: number;

  constructor(checkIntervalMs: number = 5000) {
    this.checkIntervalMs = checkIntervalMs;
  }

  /**
   * Start watching a file for changes
   */
  watch(filePath: string, callback: () => void): void {
    const absolutePath = path.resolve(filePath);

    // Stop existing watcher for this path
    if (this.watchers.has(absolutePath)) {
      this.unwatch(absolutePath);
    }

    // Get initial modification time
    let lastModified = 0;
    try {
      if (fs.existsSync(absolutePath)) {
        lastModified = fs.statSync(absolutePath).mtimeMs;
      }
    } catch {
      // File doesn't exist yet, that's OK
    }

    // Create interval to check for changes
    const interval = setInterval(() => {
      this.checkFile(absolutePath);
    }, this.checkIntervalMs);

    this.watchers.set(absolutePath, {
      filePath: absolutePath,
      lastModified,
      callback,
      interval,
    });

    console.log(`[ConfigWatcher] Watching ${absolutePath} for changes`);
  }

  /**
   * Stop watching a specific file
   */
  unwatch(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    const entry = this.watchers.get(absolutePath);

    if (entry) {
      if (entry.interval) {
        clearInterval(entry.interval);
      }
      this.watchers.delete(absolutePath);
      console.log(`[ConfigWatcher] Stopped watching ${absolutePath}`);
    }
  }

  /**
   * Stop all watchers
   */
  stopAll(): void {
    for (const [filePath, entry] of this.watchers) {
      if (entry.interval) {
        clearInterval(entry.interval);
      }
    }
    this.watchers.clear();
    console.log('[ConfigWatcher] All watchers stopped');
  }

  /**
   * Check if a file has been modified
   */
  private checkFile(absolutePath: string): void {
    const entry = this.watchers.get(absolutePath);
    if (!entry) return;

    try {
      if (!fs.existsSync(absolutePath)) {
        // File deleted - might be recreated later
        return;
      }

      const currentMtime = fs.statSync(absolutePath).mtimeMs;
      if (currentMtime > entry.lastModified) {
        console.log(`[ConfigWatcher] Changes detected in ${absolutePath}`);
        entry.lastModified = currentMtime;
        entry.callback();
      }
    } catch (err: any) {
      console.error(`[ConfigWatcher] Error checking ${absolutePath}: ${err.message}`);
    }
  }

  /**
   * Get list of watched files
   */
  getWatchedFiles(): string[] {
    return Array.from(this.watchers.keys());
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const configWatcher = new ConfigWatcher();
