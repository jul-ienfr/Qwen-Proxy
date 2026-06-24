import { test } from 'node:test';
import assert from 'node:assert';
import type { Page, Locator, FrameLocator } from 'playwright-core';
import {
  solveBaxiaCaptcha,
  startCaptchaWatcher,
  getCaptchaStats,
  configureSolver,
  getSolverConfig,
  checkPageHealth,
  captchaSolver,
} from '../services/captcha-solver.js';

test('solveBaxiaCaptcha: returns false immediately if iframe is not visible', async () => {
  const mockLocator = {
    first: () => mockLocator,
    isVisible: async () => false,
  } as unknown as Locator;

  const mockPage = {
    locator: () => mockLocator,
  } as unknown as Page;

  const result = await solveBaxiaCaptcha(mockPage);
  assert.strictEqual(result, false);
});

test('solveBaxiaCaptcha: handles successful solve workflow', async () => {
  const mouseMoveCalls: any[] = [];
  let mouseDownCalls = 0;
  let mouseUpCalls = 0;
  let isVisibleCalls = 0;

  const mockIframeLocator = {
    first: () => mockIframeLocator,
    isVisible: async () => {
      isVisibleCalls++;
      // First check (to see if it exists): returns true
      // After solve check: returns false (captcha solved, iframe gone)
      return isVisibleCalls === 1;
    },
  } as unknown as Locator;

  const mockSlider = {
    waitFor: async () => {},
    boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 40 }),
  } as unknown as Locator;

  const mockTrack = {
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 40 }),
  } as unknown as Locator;

  const mockOkElement = {
    isVisible: async () => false,
  } as unknown as Locator;

  const mockFrameLocator = {
    locator: (selector: string) => {
      if (selector.includes('nc_1_n1z') || selector.includes('btn_slide')) {
        return mockSlider;
      }
      if (selector.includes('nc_1_n1t') || selector.includes('nc_scale')) {
        return mockTrack;
      }
      if (selector.includes('btn_ok') || selector.includes('nc_ok')) {
        return mockOkElement;
      }
      throw new Error(`Unexpected selector inside frame: ${selector}`);
    },
  } as unknown as FrameLocator;

  const mockPage = {
    locator: (selector: string) => {
      if (selector.includes('iframe')) {
        return mockIframeLocator;
      }
      throw new Error(`Unexpected page selector: ${selector}`);
    },
    frameLocator: (selector: string) => {
      if (selector.includes('iframe')) {
        return mockFrameLocator;
      }
      throw new Error(`Unexpected frame locator: ${selector}`);
    },
    mouse: {
      move: async (x: number, y: number) => {
        mouseMoveCalls.push({ x, y });
      },
      down: async () => {
        mouseDownCalls++;
      },
      up: async () => {
        mouseUpCalls++;
      },
    },
  } as unknown as Page;

  const result = await solveBaxiaCaptcha(mockPage);
  assert.strictEqual(result, true);
  assert.strictEqual(mouseDownCalls, 1);
  assert.strictEqual(mouseUpCalls, 1);
  assert.ok(mouseMoveCalls.length > 0);
});

test('startCaptchaWatcher: starts loop and stops on call', async () => {
  let isVisibleCalled = false;
  const mockLocator = {
    first: () => mockLocator,
    isVisible: async () => {
      isVisibleCalled = true;
      return false;
    },
  } as unknown as Locator;

  const mockPage = {
    isClosed: () => false,
    locator: () => mockLocator,
  } as unknown as Page;

  const watcher = startCaptchaWatcher(mockPage, 5000);
  // Wait a short duration to let the loop execute at least once
  await new Promise(resolve => setTimeout(resolve, 100));
  watcher.stop();
  await watcher.promise;

  assert.strictEqual(isVisibleCalled, true);
});

// ── Helper: create a mock page that always solves captcha successfully ────
function createSuccessfulMockPage(): Page {
  let isVisibleCalls = 0;

  const mockIframeLocator = {
    first: () => mockIframeLocator,
    isVisible: async () => {
      isVisibleCalls++;
      return isVisibleCalls === 1;
    },
  } as unknown as Locator;

  const mockSlider = {
    waitFor: async () => {},
    boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 40 }),
  } as unknown as Locator;

  const mockTrack = {
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 40 }),
  } as unknown as Locator;

  const mockOkElement = {
    isVisible: async () => false,
  } as unknown as Locator;

  const mockFrameLocator = {
    locator: (selector: string) => {
      if (selector.includes('nc_1_n1z') || selector.includes('btn_slide') || selector.includes('slider') || selector.includes('slide')) {
        return mockSlider;
      }
      if (selector.includes('nc_1_n1t') || selector.includes('nc_scale') || selector.includes('track') || selector.includes('scale')) {
        return mockTrack;
      }
      if (selector.includes('btn_ok') || selector.includes('nc_ok') || selector.includes('nc-loading-circle') || selector.includes('success')) {
        return mockOkElement;
      }
      throw new Error(`Unexpected selector inside frame: ${selector}`);
    },
  } as unknown as FrameLocator;

  return {
    locator: (selector: string) => {
      if (selector.includes('iframe')) return mockIframeLocator;
      throw new Error(`Unexpected page selector: ${selector}`);
    },
    frameLocator: (selector: string) => {
      if (selector.includes('iframe')) return mockFrameLocator;
      throw new Error(`Unexpected frame locator: ${selector}`);
    },
    mouse: {
      move: async () => {},
      down: async () => {},
      up: async () => {},
    },
  } as unknown as Page;
}

// ── 1. Adaptive timing — verify history influences stats ──────────────────
test('adaptive timing: recordSolve via successful solves populates stats and adaptive state', async () => {
  // Run multiple successful solves to populate solveHistory
  for (let i = 0; i < 5; i++) {
    const page = createSuccessfulMockPage();
    const result = await solveBaxiaCaptcha(page);
    assert.strictEqual(result, true, `Solve ${i + 1} should succeed`);
  }

  const stats = getCaptchaStats();
  assert.ok(stats.totalSolved >= 5, `totalSolved should be >= 5, got ${stats.totalSolved}`);
  assert.ok(stats.avgDuration > 0, 'avgDuration should be positive');
  assert.ok(stats.avgAttempts > 0, 'avgAttempts should be positive');

  // With all successes, adaptive state factor should be aggressive
  assert.strictEqual(stats.adaptiveState.factor, 'aggressive (-30%)',
    'High success rate should produce aggressive adaptive factor');
  assert.ok(stats.adaptiveState.successRate5 > 80,
    `successRate5 should be > 80%, got ${stats.adaptiveState.successRate5}`);
});

// ── 2. getCaptchaStats — verify returned structure ────────────────────────
test('getCaptchaStats: returns expected structure fields', () => {
  const stats = getCaptchaStats();

  // Verify all expected top-level fields exist
  assert.strictEqual(typeof stats.totalAttempts, 'number');
  assert.strictEqual(typeof stats.totalSolved, 'number');
  assert.strictEqual(typeof stats.totalFailed, 'number');
  assert.strictEqual(typeof stats.successRate, 'number');
  assert.strictEqual(typeof stats.avgDuration, 'number');
  assert.strictEqual(typeof stats.avgAttempts, 'number');
  assert.ok(Array.isArray(stats.recentHistory));
  assert.strictEqual(typeof stats.adaptiveState, 'object');

  // Verify avgSteps structure
  assert.strictEqual(typeof stats.avgSteps.detection, 'number');
  assert.strictEqual(typeof stats.avgSteps.drag, 'number');
  assert.strictEqual(typeof stats.avgSteps.verify, 'number');
  assert.strictEqual(typeof stats.avgSteps.settle, 'number');

  // Verify adaptiveState structure
  assert.strictEqual(typeof stats.adaptiveState.successRate5, 'number');
  assert.strictEqual(typeof stats.adaptiveState.factor, 'string');

  // Verify invariants
  assert.ok(stats.totalAttempts >= stats.totalSolved, 'totalAttempts >= totalSolved');
  assert.ok(stats.totalAttempts >= stats.totalFailed, 'totalAttempts >= totalFailed');
  assert.ok(stats.successRate >= 0 && stats.successRate <= 100, 'successRate in [0, 100]');
});

// ── 3. configureSolver / getSolverConfig — update and retrieve config ─────
test('configureSolver: updates config returned by getSolverConfig', () => {
  // Read defaults first
  const initial = getSolverConfig();
  assert.strictEqual(initial.maxAttempts, 3);
  assert.strictEqual(initial.sliderTimeout, 3000);
  assert.strictEqual(initial.adaptiveTiming, true);

  // Override values
  configureSolver({ maxAttempts: 5, sliderTimeout: 7000 });

  const updated = getSolverConfig();
  assert.strictEqual(updated.maxAttempts, 5, 'maxAttempts should be updated to 5');
  assert.strictEqual(updated.sliderTimeout, 7000, 'sliderTimeout should be updated to 7000');
  assert.strictEqual(updated.adaptiveTiming, true, 'adaptiveTiming should remain unchanged');

  // getSolverConfig returns a copy, not a reference
  updated.maxAttempts = 999;
  const freshConfig = getSolverConfig();
  assert.strictEqual(freshConfig.maxAttempts, 5, 'Modifying returned config should not affect internal state');

  // Restore defaults
  configureSolver({ maxAttempts: 3, sliderTimeout: 3000, adaptiveTiming: true });
});

// ── 4. checkPageHealth — mock page and verify structure ───────────────────
test('checkPageHealth: returns expected structure for a responsive page with no captcha', async () => {
  let evaluateCalled = false;
  let locatorCalled = false;

  const mockPage = {
    isClosed: () => false,
    url: () => 'https://chat.qwen.ai/test',
    evaluate: async (fn: any) => {
      evaluateCalled = true;
      return fn();
    },
    locator: (selector: string) => {
      locatorCalled = true;
      return {
        first: () => ({
          isVisible: async () => false,
        }),
      };
    },
  } as unknown as Page;

  const health = await checkPageHealth(mockPage);

  assert.strictEqual(typeof health.healthy, 'boolean');
  assert.strictEqual(typeof health.url, 'string');
  assert.strictEqual(typeof health.responsive, 'boolean');
  assert.strictEqual(typeof health.hasCaptcha, 'boolean');
  assert.strictEqual(typeof health.timestamp, 'number');
  assert.ok(health.timestamp > 0, 'timestamp should be positive');

  assert.strictEqual(health.healthy, true, 'page should be healthy');
  assert.strictEqual(health.url, 'https://chat.qwen.ai/test');
  assert.strictEqual(health.responsive, true, 'page should be responsive');
  assert.strictEqual(health.hasCaptcha, false, 'no captcha should be detected');
  assert.strictEqual(evaluateCalled, true, 'page.evaluate should have been called');
  assert.strictEqual(locatorCalled, true, 'page.locator should have been called');
});

test('checkPageHealth: returns unhealthy for closed page', async () => {
  const mockPage = {
    isClosed: () => true,
  } as unknown as Page;

  const health = await checkPageHealth(mockPage);

  assert.strictEqual(health.healthy, false);
  assert.strictEqual(health.url, '');
  assert.strictEqual(health.responsive, false);
  assert.strictEqual(health.hasCaptcha, false);
});

test('checkPageHealth: returns unhealthy when captcha is present', async () => {
  const mockPage = {
    isClosed: () => false,
    url: () => 'https://chat.qwen.ai/chat',
    evaluate: async () => true,
    locator: () => ({
      first: () => ({
        isVisible: async () => true,
      }),
    }),
  } as unknown as Page;

  const health = await checkPageHealth(mockPage);

  assert.strictEqual(health.hasCaptcha, true, 'captcha should be detected');
  assert.strictEqual(health.healthy, false, 'page should be unhealthy when captcha present');
  assert.strictEqual(health.responsive, true, 'page should still be responsive');
});

// ── 5. EventEmitter — captchaSolver event bus ─────────────────────────────
test('captchaSolver EventEmitter: emit triggers registered listeners', () => {
  const receivedEvents: string[] = [];
  const receivedArgs: any[][] = [];

  const listener1 = (arg?: any) => {
    receivedEvents.push('event1');
    if (arg !== undefined) receivedArgs.push([arg]);
  };
  const listener2 = (arg?: any) => {
    receivedEvents.push('event2');
    if (arg !== undefined) receivedArgs.push([arg]);
  };

  captchaSolver.on('captcha:solved', listener1);
  captchaSolver.on('captcha:solved', listener2);

  captchaSolver.emit('captcha:solved');
  assert.deepStrictEqual(receivedEvents, ['event1', 'event2'],
    'Both listeners should be called');

  // Test off: remove one listener and emit again
  receivedEvents.length = 0;
  captchaSolver.off('captcha:solved', listener1);
  captchaSolver.emit('captcha:solved');
  assert.deepStrictEqual(receivedEvents, ['event2'],
    'Only listener2 should be called after off()');

  // Test emit with args
  receivedArgs.length = 0;
  captchaSolver.emit('captcha:solved', 'test-arg');
  assert.deepStrictEqual(receivedArgs, [['test-arg']],
    'Listener should receive the emitted argument');

  // Cleanup
  captchaSolver.off('captcha:solved', listener2);
});

test('captchaSolver EventEmitter: emit with no listeners does not throw', () => {
  assert.doesNotThrow(() => {
    captchaSolver.emit('captcha:nonexistent-event', 'data');
  });
});
