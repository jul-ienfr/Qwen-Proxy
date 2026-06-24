import type { Page } from 'playwright-core';
import { humanDrag, humanDragFast, humanDelay } from './human-behavior.js';
import { acquireMouseLock, releaseMouseLock } from './mouse-lock.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const BAXIA_IFRAME_SELECTOR = 'iframe#baxia-dialog-content, iframe[src*="_____tmd_____/punish"]';

// ── Adaptive timing — learns from success/failure history ─────────────────
interface SolveRecord {
  success: boolean;
  duration: number;
  attempts: number;
  timestamp: number;
  steps?: { detection?: number; drag?: number; verify?: number; settle?: number };
}
const solveHistory: SolveRecord[] = [];
const MAX_HISTORY = 20;

function getAdaptiveDelay(base: number, variance: number): number {
  // Look at recent history to adjust delays
  const recent = solveHistory.slice(-5);
  if (recent.length < 2) return humanDelay(base, base + variance);

  const successRate = recent.filter(r => r.success).length / recent.length;
  const avgDuration = recent.reduce((s, r) => s + r.duration, 0) / recent.length;

  // If success rate is high (>80%), we can be more aggressive (shorter delays)
  if (successRate > 0.8) {
    const factor = 0.7; // 30% shorter delays
    return humanDelay(Math.round(base * factor), Math.round((base + variance) * factor));
  }
  // If success rate is low (<50%), be more cautious (longer delays)
  if (successRate < 0.5) {
    const factor = 1.4; // 40% longer delays
    return humanDelay(Math.round(base * factor), Math.round((base + variance) * factor));
  }
  return humanDelay(base, base + variance);
}

function recordSolve(success: boolean, duration: number, attempts: number, steps?: SolveRecord['steps']): void {
  solveHistory.push({ success, duration, attempts, timestamp: Date.now(), steps });
  if (solveHistory.length > MAX_HISTORY) solveHistory.shift();
}

// ── Captcha stats — exposed via getCaptchaStats() ─────────────────────────
export interface CaptchaStats {
  totalAttempts: number;
  totalSolved: number;
  totalFailed: number;
  successRate: number;
  avgDuration: number;
  avgAttempts: number;
  avgSteps: { detection: number; drag: number; verify: number; settle: number };
  recentHistory: SolveRecord[];
  adaptiveState: { successRate5: number; factor: string };
}

export function getCaptchaStats(): CaptchaStats {
  const total = solveHistory.length;
  const solved = solveHistory.filter(r => r.success).length;
  const failed = total - solved;
  const avgDuration = total > 0 ? Math.round(solveHistory.reduce((s, r) => s + r.duration, 0) / total) : 0;
  const avgAttempts = total > 0 ? +(solveHistory.reduce((s, r) => s + r.attempts, 0) / total).toFixed(1) : 0;

  // Per-step averages from successful solves
  const solvedRecords = solveHistory.filter(r => r.success && r.steps);
  const avgSteps = solvedRecords.length > 0 ? {
    detection: Math.round(solvedRecords.reduce((s, r) => s + (r.steps?.detection || 0), 0) / solvedRecords.length),
    drag: Math.round(solvedRecords.reduce((s, r) => s + (r.steps?.drag || 0), 0) / solvedRecords.length),
    verify: Math.round(solvedRecords.reduce((s, r) => s + (r.steps?.verify || 0), 0) / solvedRecords.length),
    settle: Math.round(solvedRecords.reduce((s, r) => s + (r.steps?.settle || 0), 0) / solvedRecords.length),
  } : { detection: 0, drag: 0, verify: 0, settle: 0 };

  const recent = solveHistory.slice(-5);
  const successRate5 = recent.length > 0 ? recent.filter(r => r.success).length / recent.length : 1;
  let factor = 'normal';
  if (successRate5 > 0.8) factor = 'aggressive (-30%)';
  else if (successRate5 < 0.5) factor = 'cautious (+40%)';

  return {
    totalAttempts: total,
    totalSolved: solved,
    totalFailed: failed,
    successRate: total > 0 ? +(solved / total * 100).toFixed(1) : 100,
    avgDuration,
    avgAttempts,
    avgSteps,
    recentHistory: solveHistory.slice(-10),
    adaptiveState: { successRate5: +(successRate5 * 100).toFixed(1), factor },
  };
}

// ── Solver configuration ──────────────────────────────────────────────────
export interface SolverConfig {
  maxAttempts: number;
  sliderTimeout: number;
  adaptiveTiming: boolean;
}

const defaultSolverConfig: SolverConfig = {
  maxAttempts: 3,
  sliderTimeout: 3000,
  adaptiveTiming: true,
};

let solverConfig = { ...defaultSolverConfig };

export function configureSolver(overrides: Partial<SolverConfig>): void {
  Object.assign(solverConfig, overrides);
  console.log('[Captcha] Solver config updated:', solverConfig);
}

export function getSolverConfig(): SolverConfig {
  return { ...solverConfig };
}

// ── Page health check ─────────────────────────────────────────────────────
export interface PageHealth {
  healthy: boolean;
  url: string;
  responsive: boolean;
  hasCaptcha: boolean;
  timestamp: number;
}

export async function checkPageHealth(page: Page): Promise<PageHealth> {
  const result: PageHealth = { healthy: false, url: '', responsive: false, hasCaptcha: false, timestamp: Date.now() };
  try {
    if (page.isClosed()) return result;
    result.url = page.url();
    // Check responsiveness with a quick evaluate
    const start = Date.now();
    await page.evaluate(() => true).catch(() => false);
    result.responsive = Date.now() - start < 2000;
    // Check for captcha
    result.hasCaptcha = await page.locator(BAXIA_IFRAME_SELECTOR).first().isVisible().catch(() => false);
    result.healthy = result.responsive && !result.hasCaptcha;
  } catch { /* page may be closed */ }
  return result;
}

/**
 * Waits for an iframe matching the selector to (re)appear on the page.
 * Uses MutationObserver for near-instant detection, with a poll fallback.
 */
async function waitForIframeRefresh(page: Page, selector: string, timeoutMs: number): Promise<void> {
  // Fast path: MutationObserver callback resolves instantly when iframe appears
  const observerPromise = page.evaluate((sel: string) => {
    return new Promise<void>((resolve) => {
      // Check if iframe already exists
      if (document.querySelector(sel)) { resolve(); return; }
      const observer = new MutationObserver(() => {
        if (document.querySelector(sel)) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      // Safety timeout inside the page context
      setTimeout(() => { observer.disconnect(); resolve(); }, 5000);
    });
  }, selector).catch(() => {});

  // Race: observer resolves instantly OR we timeout
  let resolved = false;
  const result = await Promise.race([
    observerPromise.then(() => { resolved = true; }),
    sleep(timeoutMs).then(() => {}),
  ]);

  // If observer didn't catch it, do a single poll as fallback
  if (!resolved) {
    await sleep(150); // tiny grace period
  }
}

// ── Simple EventEmitter (no external dependency) ──────────────────────────
type Listener = (...args: any[]) => void;

class CaptchaEventEmitter {
  private listeners = new Map<string, Listener[]>();

  on(event: string, fn: Listener): void {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
  }

  off(event: string, fn: Listener): void {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter(l => l !== fn));
  }

  emit(event: string, ...args: any[]): void {
    const list = this.listeners.get(event);
    if (list) for (const fn of list) fn(...args);
  }
}

/** Singleton event bus for captcha detection/resolution notifications. */
export const captchaSolver = new CaptchaEventEmitter();

// ── waitForSolved helper ──────────────────────────────────────────────────
/**
 * Returns a promise that resolves when a captcha is solved on any page,
 * or rejects after timeoutMs. Uses the captchaSolver event bus.
 */
export function waitForSolved(timeoutMs: number = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const onSolved = () => {
      if (!resolved) { resolved = true; cleanup(); resolve(true); }
    };
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; cleanup(); resolve(false); }
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      captchaSolver.off('captcha:solved', onSolved);
    };
    captchaSolver.on('captcha:solved', onSolved);
  });
}

/**
 * Solves the Baxia slidein captcha inside an iframe on the page.
 * Uses adaptive timing + exponential backoff + auto-recovery on failure.
 */
export async function solveBaxiaCaptcha(page: Page): Promise<boolean> {
  const iframeSelector = BAXIA_IFRAME_SELECTOR;
  const iframeLocator = page.locator(iframeSelector).first();

  if (!(await iframeLocator.isVisible().catch(() => false))) {
    return false;
  }

  console.log('[Captcha] Baxia captcha iframe detected. Attempting to solve...');
  captchaSolver.emit('captcha:detected');
  const solveStart = Date.now();
  const steps: SolveRecord['steps'] = {};

  // Acquire exclusive mouse lock for the entire captcha-solving attempt
  const lockAcquired = acquireMouseLock('captcha-solver');
  try {
    for (let attempt = 1; attempt <= solverConfig.maxAttempts; attempt++) {
      try {
        const frame = page.frameLocator(iframeSelector);
        const slider = frame.locator('#nc_1_n1z, .btn_slide, .slider, [class*="slide"]');

        // Wait for the slider element to be visible inside the frame
        const detectStart = Date.now();
        await slider.waitFor({ state: 'visible', timeout: solverConfig.sliderTimeout });
        steps.detection = (steps.detection || 0) + (Date.now() - detectStart);

        const sliderBox = await slider.boundingBox();
        if (!sliderBox) {
          console.warn(`[Captcha] Attempt ${attempt}: Slider bounding box not found.`);
          await sleep(250);
          continue;
        }

        const track = frame.locator('#nc_1_n1t, .nc_scale, .track, [class*="track"], [class*="scale"]');
        const trackBox = await track.boundingBox();
        // Calculate drag distance: use track width minus slider width, with fallback
        const dragDistance = trackBox
          ? Math.max(trackBox.width - sliderBox.width, 100) // Ensure minimum 100px drag
          : 260;

        const startX = sliderBox.x + sliderBox.width / 2;
        const startY = sliderBox.y + sliderBox.height / 2;

        console.log(`[Captcha] Attempt ${attempt}: Dragging slider from x=${startX}, y=${startY} by ${dragDistance}px`);

        // Use fast drag on first attempt, full human drag on retries
        const dragStart = Date.now();
        if (attempt === 1) {
          await humanDragFast(page, startX, startY, startX + dragDistance, startY);
        } else {
          await humanDrag(page, startX, startY, startX + dragDistance, startY);
        }
        steps.drag = (steps.drag || 0) + (Date.now() - dragStart);

        // Wait for the page to register success — adaptive or fixed delay
        const delayFn = solverConfig.adaptiveTiming ? getAdaptiveDelay : humanDelay;
        const postDragDelay = attempt === 1 ? delayFn(350, 450) : delayFn(300, 300);
        await sleep(postDragDelay);

        // Verify solve: check iframe gone + OK element in parallel for speed
        const verifyStart = Date.now();
        const [isGone, isOkVisible] = await Promise.all([
          iframeLocator.isVisible().catch(() => false).then(v => !v),
          frame.locator('.btn_ok, .nc_ok, div#nc-loading-circle, [class*="success"]').isVisible().catch(() => false),
        ]);
        steps.verify = (steps.verify || 0) + (Date.now() - verifyStart);
        if (isGone || isOkVisible) {
          console.log(`[Captcha] Baxia captcha solved successfully (${isGone ? 'iframe closed' : 'OK state detected'}).`);
          if (!isGone) await sleep(getAdaptiveDelay(200, 200)); // Wait for transition only if OK state
          steps.settle = (steps.settle || 0) + 200;
          const duration = Date.now() - solveStart;
          recordSolve(true, duration, attempt, steps);
          captchaSolver.emit('captcha:solved');
          return true;
        }

        console.warn(`[Captcha] Attempt ${attempt} did not solve the captcha. Retrying...`);
        // Exponential backoff between attempts: 200ms, 400ms, 800ms...
        const backoffMs = Math.min(200 * Math.pow(2, attempt - 1), 2000);
        await sleep(backoffMs);
        // Wait for iframe to refresh using MutationObserver (near-instant)
        await waitForIframeRefresh(page, iframeSelector, 1500);
      } catch (err: any) {
        console.error(`[Captcha] Error during attempt ${attempt}:`, err.message);
        const backoffMs = Math.min(300 * Math.pow(2, attempt - 1), 2000);
        await sleep(backoffMs);
      }
    }

    // ── Auto-recovery: all attempts failed → navigate to fresh chat and retry once ──
    console.log('[Captcha] All attempts failed. Trying auto-recovery: navigate to fresh chat...');
    try {
      const currentUrl = page.url();
      if (currentUrl.includes('chat.qwen.ai')) {
        // Navigate to a new chat to reset the captcha state
        await page.goto('https://chat.qwen.ai/c/new-chat', {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        }).catch(() => {});
        await sleep(2000); // Wait for page to load

        // Check if captcha appeared on the fresh page
        const hasCaptchaAgain = await iframeLocator.isVisible().catch(() => false);
        if (hasCaptchaAgain) {
          console.log('[Captcha] Auto-recovery: captcha still present after navigation. One final attempt...');
          const frame = page.frameLocator(iframeSelector);
          const slider = frame.locator('#nc_1_n1z, .btn_slide, .slider, [class*="slide"]');
          const sliderBox = await slider.boundingBox();
          if (sliderBox) {
            const track = frame.locator('#nc_1_n1t, .nc_scale, .track, [class*="track"], [class*="scale"]');
            const trackBox = await track.boundingBox();
            const dragDistance = trackBox ? Math.max(trackBox.width - sliderBox.width, 100) : 260;
            const startX = sliderBox.x + sliderBox.width / 2;
            const startY = sliderBox.y + sliderBox.height / 2;
            await humanDrag(page, startX, startY, startX + dragDistance, startY);
            await sleep(800);
            const solved = !(await iframeLocator.isVisible().catch(() => false));
            if (solved) {
              console.log('[Captcha] Auto-recovery: captcha solved after fresh chat navigation!');
              const duration = Date.now() - solveStart;
              recordSolve(true, duration, solverConfig.maxAttempts + 1);
              captchaSolver.emit('captcha:solved');
              return true;
            }
          }
        } else {
          // No captcha on fresh page — success!
          console.log('[Captcha] Auto-recovery: no captcha on fresh page. Session restored.');
          const duration = Date.now() - solveStart;
          recordSolve(true, duration, solverConfig.maxAttempts);
          captchaSolver.emit('captcha:solved');
          return true;
        }
      }
    } catch (recoveryErr: any) {
      console.error('[Captcha] Auto-recovery failed:', recoveryErr.message);
    }
  } finally {
    if (lockAcquired) releaseMouseLock('captcha-solver');
  }

  const duration = Date.now() - solveStart;
  recordSolve(false, duration, solverConfig.maxAttempts + 1);
  console.error(`[Captcha] Failed to solve Baxia captcha after all attempts + recovery (${duration}ms).`);
  return false;
}

/**
 * Starts a background watcher for Baxia captchas on the page.
 *
 * Primary: uses page.waitForFunction() to detect iframe entirely inside
 * page context (MutationObserver + 200ms poll) — zero per-check IPC.
 * Fallback: locator-based polling (300ms) for environments without
 * waitForFunction (e.g. mocked pages in tests).
 *
 * Returns a watcher handle with stop(), wasSolved(), getSolvedCount().
 */
export function startCaptchaWatcher(page: Page, timeoutMs: number) {
  let finished = false;
  let captchaSolvedCount = 0;
  const useWaitForFunction = typeof (page as any).waitForFunction === 'function';

  // Promise that resolves when the watcher loop finishes
  const promise = (async () => {
    if (useWaitForFunction) {
      // Fast path: waitForFunction runs entirely in page context
      const selector = BAXIA_IFRAME_SELECTOR.split(',')[0].trim();
      while (!finished && !page.isClosed()) {
        try {
          await (page as any).waitForFunction(
            `!!document.querySelector('${selector.replace(/'/g, "\\'")}')`,
            { timeout: Math.min(timeoutMs, 30000), polling: 200 },
          ).catch(() => null);

          if (finished || page.isClosed()) break;

          console.log('[Captcha] Baxia captcha detected on page. Solving...');
          captchaSolver.emit('captcha:detected');
          const solved = await solveBaxiaCaptcha(page);
          if (solved) {
            captchaSolvedCount++;
            console.log(`[Captcha] Captcha solved (${captchaSolvedCount} total). Waiting for page to settle...`);
            await sleep(500);
          }
        } catch { /* ignore — timeout or page closed */ }
      }
    } else {
      // Fallback: locator-based polling for mocked pages / tests
      const start = Date.now();
      while (!finished && (Date.now() - start < timeoutMs)) {
        try {
          if (page.isClosed()) break;
          const hasCaptcha = await page.locator(BAXIA_IFRAME_SELECTOR).first().isVisible().catch(() => false);
          if (hasCaptcha) {
            console.log('[Captcha] Baxia captcha detected on page. Solving...');
            captchaSolver.emit('captcha:detected');
            const solved = await solveBaxiaCaptcha(page);
            if (solved) {
              captchaSolvedCount++;
              console.log(`[Captcha] Captcha solved (${captchaSolvedCount} total). Waiting for page to settle...`);
              await sleep(500);
            }
          }
        } catch { /* ignore */ }
        await sleep(300);
      }
    }
  })();

  return {
    stop: () => {
      finished = true;
    },
    wasSolved: () => captchaSolvedCount > 0,
    getSolvedCount: () => captchaSolvedCount,
    promise
  };
}
