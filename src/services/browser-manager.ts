import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';
import { launch } from 'cloakbrowser';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { QwenAccount } from '../core/accounts.js';
import { addAccount, listAccounts } from '../core/accounts.js';
import { config } from '../core/config.js';
import { getDebugLogger } from '../core/debug-logger.js';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

// Auto-detect system locale, timezone, and language
function getSystemLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale || 'fr-FR';
  } catch {
    return 'fr-FR';
  }
}

function getSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
  } catch {
    return 'Europe/Paris';
  }
}

function getSystemLanguages(): string[] {
  try {
    const locale = getSystemLocale();
    const lang = locale.split('-')[0];
    return [locale, lang, 'en-US', 'en'];
  } catch {
    return ['fr-FR', 'fr', 'en-US', 'en'];
  }
}

export interface AccountHeaderCache {
  currentHeaders: Record<string, string>;
  cachedQwenHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null;
  lastHeadersTime: number;
  refreshInProgress: boolean;
}

export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
export const CHROME_CLIENT_HINTS = '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="99"';
export const BROWSER_VIEWPORT = { width: 1366, height: 768 };
export const BROWSER_LOCALE = process.env.BROWSER_LOCALE || getSystemLocale();
export const BROWSER_TIMEZONE = process.env.BROWSER_TIMEZONE || getSystemTimezone();
export const BROWSER_LANGUAGES = getSystemLanguages();

function getBrowserLaunchArgs(): string[] {
  // CloakBrowser handles most stealth args via its own stealthArgs (enabled by default).
  // Only pass minimal operational args here.
  return Array.from(new Set([
    '--no-first-run',
    '--no-default-browser-check',
  ]));
}

export function sharedContextOptions(): BrowserContextOptions {
  // CloakBrowser handles locale, timezone, user-agent, and client hints at the C++ binary level.
  // Only set context-level options here.
  return {
    viewport: BROWSER_VIEWPORT,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    ignoreHTTPSErrors: true,
    bypassCSP: true, // Allow WebSocket connections from injected scripts
    extraHTTPHeaders: {
      ...config.browser.headers,
    },
  };
}

export const HEADERS_TTL = 5 * 60 * 1000;
export const COOKIE_CACHE_TTL = 5 * 60 * 1000;
export const REFRESH_THRESHOLD = 0.7;
export const GUEST_HEADERS_TTL = 30 * 60 * 1000;

export function getProfilesDir(): string {
  return path.resolve(config.browser.userDataDir);
}
// Backward-compatible constant (reads once at startup)
export const PROFILES_DIR = getProfilesDir();

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const accountContexts = new Map<string, BrowserContext>();
export const accountPages = new Map<string, Page>();
export const accountHeaderCaches = new Map<string, AccountHeaderCache>();
export const cachedUserAgents = new Map<string, string>();
export const cookieCaches = new Map<string, { cookie: string, timestamp: number }>();

let browser: Browser | null = null;
let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let guestContext: BrowserContext | null = null;
let guestPage: Page | null = null;
let guestHeadersCache: { headers: Record<string, string>, timestamp: number } | null = null;

export function getBrowser(): Browser | null { return browser; }
export function setBrowser(b: Browser | null) { browser = b; }
export function getContext(): BrowserContext | null { return context; }
export function setContext(c: BrowserContext | null) { context = c; }
export function getActivePage(): Page | null { return activePage; }
export function setActivePage(p: Page | null) { activePage = p; }
export function getGuestContext(): BrowserContext | null { return guestContext; }
export function setGuestContext(c: BrowserContext | null) { guestContext = c; }
export function getGuestPage(): Page | null { return guestPage; }
export function setGuestPage(p: Page | null) { guestPage = p; }
export function getGuestHeadersCache(): { headers: Record<string, string>, timestamp: number } | null { return guestHeadersCache; }
export function setGuestHeadersCache(c: { headers: Record<string, string>, timestamp: number } | null) { guestHeadersCache = c; }

export function getAccountHeaderCache(accountId: string): AccountHeaderCache {
  let cache = accountHeaderCaches.get(accountId);
  if (!cache) {
    cache = {
      currentHeaders: {},
      cachedQwenHeaders: null,
      lastHeadersTime: 0,
      refreshInProgress: false,
    };
    accountHeaderCaches.set(accountId, cache);
  }
  return cache;
}

export function storageStatePath(accountId: string): string {
  return path.join(PROFILES_DIR, `${accountId}_state.json`);
}

export function loadStorageState(accountId: string): string | undefined {
  const p = storageStatePath(accountId);
  if (!fs.existsSync(p)) return undefined;

  // Validate cookies are not all expired
  try {
    const state = JSON.parse(fs.readFileSync(p, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const hasValidCookies = state.cookies?.some((c: any) => !c.expires || c.expires > now);
    if (!hasValidCookies) {
      console.log(`[Playwright] storageState for ${accountId} has expired cookies, will re-login`);
      return undefined;
    }
  } catch {
    // If we can't parse, let Playwright try and fail gracefully
  }

  return p;
}

export async function saveStorageState(ctx: BrowserContext, accountId: string): Promise<void> {
  try {
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
    await ctx.storageState({ path: storageStatePath(accountId) });
  } catch (err: any) {
    console.warn(`[Playwright] Failed to save storageState for ${accountId}: ${err.message}`);
  }
}

/**
 * Check if a page is healthy and usable for browser fetch/stream.
 * Returns true if the page is responsive and on the correct domain.
 */
export async function isPageHealthy(page: Page | null): Promise<boolean> {
  if (!page || page.isClosed()) return false;
  const url = page.url();
  if (!url.includes('chat.qwen.ai')) return false;
  // Verify CDP connection is alive
  try {
    await page.evaluate('1+1', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function clearPageRuntimeState(page: Page | null): Promise<void> {
  if (!page || page.isClosed()) return;

  try {
    await page.context().clearCookies();
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear cookies during profile reset: ${err.message}`);
  }

  try {
    await page.context().clearPermissions();
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear permissions during profile reset: ${err.message}`);
  }

  try {
    await page.evaluate(() => {
      try { window.localStorage.clear(); } catch { /* ignore */ }
      try { window.sessionStorage.clear(); } catch { /* ignore */ }
    });
  } catch (err: any) {
    console.warn(`[Playwright] Failed to clear page storage during profile reset: ${err.message}`);
  }
}

export async function getOrLaunchBrowser(_browserType: BrowserType = 'chromium'): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  console.log(`[CloakBrowser] Launching shared browser...`);
  const dbg = getDebugLogger();
  if (dbg.isEnabled()) {
    dbg.log('BROWSER', 'browser-manager.ts', 'Launching shared browser', {
      browserType: _browserType,
      headless: config.browser.headless,
    });
  }

  browser = await launch({
    headless: config.browser.headless,
    locale: BROWSER_LOCALE,
    timezone: BROWSER_TIMEZONE,
    humanize: true,
    args: getBrowserLaunchArgs(),
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const uiMutexes = new Map<string, Mutex>();
export function getUiMutex(accountId: string): Mutex {
  let m = uiMutexes.get(accountId);
  if (!m) {
    m = new Mutex();
    uiMutexes.set(accountId, m);
  }
  return m;
}

export async function hasValidAuthCookie(page: Page | null): Promise<boolean> {
  if (!page) return false;
  try {
    const cookies = await page.context().cookies();
    return cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
  } catch {
    return false;
  }
}

async function checkValidSession(): Promise<boolean> {
  if (!activePage) return false;
  try {
    const hasAuth = await hasValidAuthCookie(activePage);
    if (!hasAuth) return false;
    await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
    const isLogged = !activePage.url().includes('auth') && !activePage.url().includes('login');
    return isLogged;
  } catch {
    return false;
  }
}

async function loginToQwenWithContext(acctContext: BrowserContext, acctPage: Page, email: string, password: string): Promise<boolean> {
  await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  const result = await acctPage.evaluate(async ({ email, password, timezone }) => {
    try {
      const response = await fetch("https://chat.qwen.ai/api/v2/auths/signin", {
        method: "POST",
        headers: {
          "accept": "application/json, text/plain, */*",
          "content-type": "application/json",
          "source": "web",
          "timezone": timezone,
          "x-request-id": crypto.randomUUID()
        },
        body: JSON.stringify({ email, password, login_type: "email" })
      });
      const data = await response.json();
      return { ok: response.ok, data };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }, { email, password: hashedPassword, timezone: BROWSER_TIMEZONE });

  if (result.ok) {
    await acctPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded' });
    const isLogged = !(acctPage.url().includes('auth') || acctPage.url().includes('login'));
    if (isLogged) {
      console.log(`[Playwright] Login confirmed for ${email}.`);
      return true;
    }
  }

  console.error(`[Playwright] Login failed for ${email}:`, result.data || result.error);
  return false;
}

export async function loginToQwen(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');
  console.log(`[Playwright] Attempting API login for ${email}...`);
  return loginToQwenWithContext(activePage.context(), activePage, email, password);
}

async function loginToQwenUI(email: string, password: string): Promise<boolean> {
  if (!activePage) throw new Error('Playwright not initialized');

  console.log('[Playwright] Attempting UI login...');
  await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
  await sleep(2000);

  if (!activePage.url().includes('/auth')) {
    console.log('[Playwright] Already logged in');
    return true;
  }

  try {
    await activePage.waitForSelector('input[type="email"], input[placeholder*="Email"]', { timeout: config.timeouts.page });
  } catch {
    if (activePage.url().includes('/auth')) throw new Error('Email input not found');
    console.log('[Playwright] Already logged in');
    return true;
  }

  console.log('[Playwright] UI: Filling email...');
  await activePage.fill('input[type="email"], input[placeholder*="Email"]', email);
  await activePage.keyboard.press('Enter');
  await sleep(1000);

  await activePage.waitForSelector('input[type="password"]', { timeout: config.timeouts.page });
  console.log('[Playwright] UI: Filling password...');
  await activePage.fill('input[type="password"]', password);
  await activePage.keyboard.press('Enter');

  await sleep(2000);

  const isLogged = !activePage.url().includes('auth') && !activePage.url().includes('login');
  if (isLogged) {
    console.log('[Playwright] UI login OK');
    return true;
  }

  console.log('[Playwright] UI login failed');
  return false;
}

async function attemptAutoLogin(): Promise<void> {
  const email = process.env.QWEN_EMAIL;
  const password = process.env.QWEN_PASSWORD;
  if (!email || !password) return;
  console.log('[Playwright] Attempting auto-login with credentials from .env...');
  try {
    const success = await loginToQwen(email, password);
    if (success) {
      console.log('[Playwright] Auto-login successful.');
      return;
    }
    console.warn('[Playwright] API login failed, trying UI fallback...');
    const uiSuccess = await loginToQwenUI(email, password);
    if (uiSuccess) {
      console.log('[Playwright] UI login fallback successful.');
    } else {
      console.warn('[Playwright] Both API and UI login failed. Manual login may be required.');
    }
  } catch (err: any) {
    console.error('[Playwright] Auto-login error:', err.message);
  }
}

export async function resetBrowserProfile(cacheKey: string, accountId?: string): Promise<void> {
  const release = await getUiMutex(cacheKey).acquire();
  try {
    const profileId = accountId === 'guest' ? '_guest' : (accountId || '_default');
    const profilePath = path.join(PROFILES_DIR, profileId);

    try {
      if (accountId === 'guest') {
        await clearPageRuntimeState(guestPage);
        if (guestContext) {
          await guestContext.close();
          guestContext = null;
        }
        guestPage = null;
      } else if (accountId) {
        const acctPage = accountPages.get(accountId) ?? null;
        await clearPageRuntimeState(acctPage);
        const acctContext = accountContexts.get(accountId);
        if (acctContext) {
          await acctContext.close();
          accountContexts.delete(accountId);
        }
        accountPages.delete(accountId);
      } else {
        await clearPageRuntimeState(activePage);
        if (context) {
          await context.close();
          context = null;
        }
        activePage = null;
      }

      if (browser?.isConnected()) {
        await browser.close();
        browser = null;
      }

      accountHeaderCaches.delete(cacheKey);
      cookieCaches.delete(cacheKey);
      cachedUserAgents.delete(cacheKey);
      accountContexts.clear();
      accountPages.clear();
      context = null;
      activePage = null;
      guestContext = null;
      guestPage = null;
      guestHeadersCache = null;
      fs.rmSync(profilePath, { recursive: true, force: true });
      fs.rmSync(storageStatePath(profileId), { force: true });

      console.warn(`[Playwright] Cleared browser profile for ${cacheKey}: ${profilePath}`);
    } catch (err: any) {
      console.warn(`[Playwright] Failed to clear browser profile for ${cacheKey}: ${err.message}`);
    }
  } finally {
    release();
  }
}

export async function initPlaywright(_headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const sharedBrowser = await getOrLaunchBrowser(browserType);
  console.log(`[Playwright] Creating default context on shared browser...`);

  const storageState = loadStorageState('_default');
  context = await sharedBrowser.newContext({
    ...sharedContextOptions(),
    ...(storageState ? { storageState } : {}),
  });

  activePage = await context.newPage();

  // Navigate to Qwen when not headless so user can see the browser
  if (!_headless) {
    console.log('[Playwright] Opening Qwen in browser...');
    try {
      await activePage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
      console.log('[Playwright] Qwen opened successfully');
    } catch (err: any) {
      console.error('[Playwright] Failed to open Qwen:', err.message);
    }
  }

  const hasCredentials = !!(process.env.QWEN_EMAIL && process.env.QWEN_PASSWORD);

  // Skip automatic session checks when browser is visible — let user log in manually
  if (_headless) {
    const hasValidSession = await checkValidSession();

    if (!hasValidSession && !hasCredentials) {
      console.warn('[Playwright] No valid session AND no credentials in .env. Manual login will be required.');
    }

    if (!hasValidSession) {
      await attemptAutoLogin();
    }
  } else {
    console.log('[Playwright] Browser is visible — log in manually on the Qwen website.');
    console.log('[Playwright] Once logged in, the server will capture your session automatically.');
  }

  if (await hasValidAuthCookie(activePage)) {
    await saveStorageState(context, '_default');

    // Auto-register the default session as an account if not already registered
    try {
      const existingAccounts = listAccounts();
      if (existingAccounts.length === 0) {
        const email = process.env.QWEN_EMAIL;
        if (email) {
          try {
            addAccount(email, '', '_default');
            console.log(`[Playwright] Auto-registered account: ${email}`);
          } catch (err: any) {
            if (err.message?.includes('already exists')) {
              console.log(`[Playwright] Account ${email} already registered.`);
            } else {
              console.warn(`[Playwright] Failed to auto-register account: ${err.message}`);
            }
          }
        } else {
          console.log('[Playwright] No accounts configured and QWEN_EMAIL not set.');
          console.log('[Playwright] Set QWEN_EMAIL in .env or run: npx tsx src/login.ts');
        }
      }
    } catch (err: any) {
      console.warn(`[Playwright] Auto-registration check failed: ${err.message}`);
    }
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  for (const cache of accountHeaderCaches.values()) {
    cache.refreshInProgress = false;
  }
  if (context) {
    if (await hasValidAuthCookie(activePage)) {
      await saveStorageState(context, '_default');
    }
    await context.close();
    context = null;
    activePage = null;
  }
  if (guestContext) {
    if (await hasValidAuthCookie(guestPage)) {
      await saveStorageState(guestContext, '_guest');
    }
    await guestContext.close();
    guestContext = null;
    guestPage = null;
  }
  for (const acctId of accountContexts.keys()) {
    await closePlaywrightForAccount(acctId);
  }
  if (browser?.isConnected()) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

export async function initPlaywrightForAccount(account: QwenAccount, _headless = true, browserType: BrowserType = 'chromium') {
  const release = await getUiMutex(account.id).acquire();
  try {
    const sharedBrowser = await getOrLaunchBrowser(browserType);

    console.log(`[Playwright] Creating context for account ${account.email} on shared browser...`);

    const storageState = loadStorageState(account.id);
    const acctContext = await sharedBrowser.newContext({
      ...sharedContextOptions(),
      ...(storageState ? { storageState } : {}),
    });

    const acctPage = await acctContext.newPage();
    accountContexts.set(account.id, acctContext);
    accountPages.set(account.id, acctPage);

    const hasAuth = await hasValidAuthCookie(acctPage);

    if (!hasAuth && account.email && account.password) {
      await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
    }

    try {
      await acctPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
      const url = acctPage.url();
      if (url.includes('auth') || url.includes('login')) {
        if (account.email && account.password) {
          console.log(`[Playwright] Session expired for ${account.email}, re-logging in...`);
          await loginToQwenWithContext(acctContext, acctPage, account.email, account.password);
          await acctPage.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: config.timeouts.navigation });
        } else {
          console.warn(`[Playwright] Session expired for account ${account.id} but no credentials available for re-login.`);
        }
      } else {
        console.log(`[Playwright] Session validated for ${account.email}.`);
      }
    } catch (err: any) {
      console.warn(`[Playwright] Failed to validate session for ${account.email}: ${err.message}`);
    }

    if (await hasValidAuthCookie(acctPage)) {
      await saveStorageState(acctContext, account.id);
    }
  } finally {
    release();
  }
}

export async function launchManualLoginAccount(accountId: string, _browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const manualBrowser = await launch({
    headless: false,
    locale: BROWSER_LOCALE,
    timezone: BROWSER_TIMEZONE,
    humanize: true,
    args: getBrowserLaunchArgs(),
  });

  const storageState = loadStorageState(accountId);
  const acctContext = await manualBrowser.newContext({
    ...sharedContextOptions(),
    ...(storageState ? { storageState } : {}),
  });

  const acctPage = await acctContext.newPage();
  await acctPage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });

  return { context: acctContext, page: acctPage };
}

export async function extractAccountInfoFromContext(page: Page): Promise<{ email: string | null, hasSession: boolean }> {
  const cookies = await page.context().cookies();
  const hasSession = cookies.some(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));

  let email: string | null = null;
  if (hasSession) {
    try {
      email = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="user-email"], .user-email, [class*="email"]');
        return el?.textContent?.trim() || null;
      });
    } catch { /* ignore */ }
  }

  return { email, hasSession };
}

export async function closePlaywrightForAccount(accountId: string) {
  const acctContext = accountContexts.get(accountId);
  const acctPage = accountPages.get(accountId);
  if (acctContext) {
    if (await hasValidAuthCookie(acctPage || null)) {
      await saveStorageState(acctContext, accountId);
    }
    await acctContext.close();
    accountContexts.delete(accountId);
    accountPages.delete(accountId);
  }
}

export function getPageForAccount(accountId?: string): Page | null {
  if (accountId === 'guest') return guestPage;
  if (accountId && accountId !== '_default') return accountPages.get(accountId) || null;
  return activePage;
}
