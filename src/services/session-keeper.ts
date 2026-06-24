import type { Page } from 'playwright-core';
import { accountPages, getPageForAccount, sleep } from './browser-manager.js';
import { humanMouseMove, humanScroll, humanDelay } from './human-behavior.js';
import { config } from '../core/config.js';
import { isMouseLocked } from './mouse-lock.js';
import { isAccountLaneId } from '../core/account-lanes.js';

const KEEP_ALIVE_INTERVAL_MS = 2 * 60 * 1000; // Reduced from 3min — more frequent presence
const NAVIGATION_INTERVAL_MS = 8 * 60 * 1000;

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
const lastNavigation = new Map<string, number>();

async function performKeepAlive(accountId: string, page: Page): Promise<void> {
  if (page.isClosed()) return;

  try {
    const viewport = page.viewportSize();
    if (!viewport) return;

    // 3-5 random mouse movements (increased from 2-3)
    const points = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < points; i++) {
      const fromX = Math.floor(Math.random() * viewport.width);
      const fromY = Math.floor(Math.random() * viewport.height);
      const toX = Math.floor(Math.random() * viewport.width);
      const toY = Math.floor(Math.random() * viewport.height);
      await humanMouseMove(page, fromX, fromY, toX, toY, { overshoot: 0 });
      await sleep(humanDelay(200, 600));
    }

    // Scroll with 60% probability (increased from 40%)
    if (Math.random() < 0.6) {
      await humanScroll(page);
    }

    // Keyboard activity — press random keys to simulate typing presence
    if (Math.random() < 0.3) {
      const keys = ['ArrowDown', 'ArrowUp', 'End', 'Home'];
      const key = keys[Math.floor(Math.random() * keys.length)];
      await page.keyboard.press(key).catch(() => {});
      await sleep(humanDelay(100, 300));
    }

    // Focus/blur events to simulate tab switching
    if (Math.random() < 0.2) {
      await page.evaluate(() => {
        try {
          window.dispatchEvent(new Event('blur'));
          setTimeout(() => window.dispatchEvent(new Event('focus')), 200 + Math.random() * 500);
        } catch { /* ignore */ }
      }).catch(() => {});
      await sleep(humanDelay(300, 800));
    }

    const now = Date.now();
    const lastNav = lastNavigation.get(accountId) || 0;

    if (now - lastNav > NAVIGATION_INTERVAL_MS) {
      const currentUrl = page.url();
      if (!currentUrl.includes('chat.qwen.ai')) {
        await page.goto('https://chat.qwen.ai/c/new-chat', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
      } else {
        await page.evaluate(() => {
          try {
            const el = document.querySelector('[data-testid="sidebar"], .sidebar, nav, aside');
            if (el) {
              el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
            }
          } catch { /* ignore */ }
        });
      }
      lastNavigation.set(accountId, now);
    }
  } catch (err: any) {
    if (!err.message?.includes('Target closed') && !err.message?.includes('Page is closed')) {
      console.warn(`[SessionKeeper] Keep-alive failed for ${accountId}:`, err.message);
    }
  }
}

export function startSessionKeeper(): void {
  if (!config.session?.enabled) {
    console.log('[SessionKeeper] Disabled (session not enabled)');
    return;
  }

  if (running) return;
  running = true;

  intervalId = setInterval(async () => {
    if (!running) return;

    if (isMouseLocked()) {
      return;
    }

    for (const [accountId, page] of accountPages.entries()) {
      if (!running) return;
      if (isMouseLocked()) {
        return;
      }
      // Skip lane pages (only keep alive the primary page per account)
      if (isAccountLaneId(accountId)) continue;
      if (page.isClosed()) continue;
      await performKeepAlive(accountId, page);
      await sleep(humanDelay(1000, 3000));
    }

    if (isMouseLocked()) {
      return;
    }

    const defaultPage = getPageForAccount();
    if (defaultPage && !defaultPage.isClosed()) {
      await performKeepAlive('_default', defaultPage);
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  if (intervalId?.unref) intervalId.unref();
  console.log('[SessionKeeper] Started — keep-alive every ~3min, navigation every ~8min');
}

export function stopSessionKeeper(): void {
  running = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  lastNavigation.clear();
  console.log('[SessionKeeper] Stopped');
}
