import type { Page } from 'playwright-core';
import { humanDrag, humanDelay } from './human-behavior.js';
import { acquireMouseLock, releaseMouseLock } from './mouse-lock.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Solves the Baxia slidein captcha inside an iframe on the page.
 */
export async function solveBaxiaCaptcha(page: Page): Promise<boolean> {
  const iframeSelector = 'iframe#baxia-dialog-content, iframe[src*="_____tmd_____/punish"]';
  const iframeLocator = page.locator(iframeSelector).first();

  if (!(await iframeLocator.isVisible().catch(() => false))) {
    return false;
  }

  console.log('[Captcha] Baxia captcha iframe detected. Attempting to solve...');

  // Acquire exclusive mouse lock for the entire captcha-solving attempt
  const lockAcquired = acquireMouseLock('captcha-solver');
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const frame = page.frameLocator(iframeSelector);
        const slider = frame.locator('#nc_1_n1z, .btn_slide');

        // Wait for the slider element to be visible inside the frame
        await slider.waitFor({ state: 'visible', timeout: 5000 });

        const sliderBox = await slider.boundingBox();
        if (!sliderBox) {
          console.warn(`[Captcha] Attempt ${attempt}: Slider bounding box not found.`);
          await sleep(1000);
          continue;
        }

        const track = frame.locator('#nc_1_n1t, .nc_scale');
        const trackBox = await track.boundingBox();
        const dragDistance = trackBox ? (trackBox.width - sliderBox.width) : 260;

        const startX = sliderBox.x + sliderBox.width / 2;
        const startY = sliderBox.y + sliderBox.height / 2;

        console.log(`[Captcha] Attempt ${attempt}: Dragging slider from x=${startX}, y=${startY} by ${dragDistance}px`);

        // Use human-like drag instead of native mouse drag
        await humanDrag(
          page,
          startX,
          startY,
          startX + dragDistance,
          startY,
        );

        // Wait a moment for the page to register success and close the dialog
        await sleep(humanDelay(1500, 3000));

        // Verify if the captcha is solved: the iframe should be hidden/gone, or we see a success element
        const isGone = !(await iframeLocator.isVisible().catch(() => false));
        if (isGone) {
          console.log('[Captcha] Baxia captcha solved successfully (iframe closed).');
          return true;
        }

        const okElement = frame.locator('.btn_ok, .nc_ok, div#nc-loading-circle');
        const isOkVisible = await okElement.isVisible().catch(() => false);
        if (isOkVisible) {
          console.log('[Captcha] Baxia captcha solved successfully (OK state detected).');
          await sleep(humanDelay(1000, 2000)); // Wait for transition
          return true;
        }

        console.warn(`[Captcha] Attempt ${attempt} did not solve the captcha. Retrying...`);
        await sleep(humanDelay(800, 1500));
      } catch (err: any) {
        console.error(`[Captcha] Error during attempt ${attempt}:`, err.message);
        await sleep(humanDelay(800, 1500));
      }
    }
  } finally {
    if (lockAcquired) releaseMouseLock('captcha-solver');
  }

  console.error('[Captcha] Failed to solve Baxia captcha after 3 attempts.');
  return false;
}

/**
 * Starts a background loop to watch for and solve Baxia captchas on the page.
 * Returns an object with a stop() method and a captchaSolved flag.
 */
export function startCaptchaWatcher(page: Page, timeoutMs: number) {
  let finished = false;
  let captchaSolvedCount = 0;
  const promise = (async () => {
    const start = Date.now();
    while (!finished && (Date.now() - start < timeoutMs)) {
      try {
        if (page.isClosed()) break;
        const iframeSelector = 'iframe#baxia-dialog-content, iframe[src*="_____tmd_____/punish"]';
        const hasCaptcha = await page.locator(iframeSelector).first().isVisible().catch(() => false);
        if (hasCaptcha) {
          console.log('[Captcha] Baxia captcha detected on page. Solving...');
          const solved = await solveBaxiaCaptcha(page);
          if (solved) {
            captchaSolvedCount++;
            console.log(`[Captcha] Captcha solved (${captchaSolvedCount} total). Waiting for page to settle...`);
            await sleep(2000); // Wait for page to settle after captcha
          }
        }
      } catch {
        // ignore
      }
      await sleep(1000);
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
