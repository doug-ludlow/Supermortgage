/**
 * The browser harness the 32.x shell suites share (hoisted from 32-13.spec.test.ts:164-233 and 32-16.rail.spec.test.ts:113-160):
 * the built Next.js app (apps/borrower, `.next-t13` — an env-driven distDir so it never collides with the app's own `.next`,
 * rebuilt when a source is newer), started as its standalone server on a free port and pointed at the calling test's API
 * through its proxy (`API_BASE_URL`), driven with Playwright's Chromium from /opt/pw-browsers at 1280 and 390 px.
 *
 *   const H = createHarness({ apiBase: () => base });
 *   const { pageFor, openApply, inViewport, stopShell } = H;
 *
 * `pageFor(token, width, path)` opens a context (a phone context under 768 px) with the borrower session cookie the proxy
 * reads (`sm_borrower_session`) when a token is given; `openApply` waits for the Apply product's root (`[data-testid="apply"]`,
 * 32.19). `inViewport(page, testId)` is 32.13's (a test id); `inViewportSel(page, selector)` the rail suite's. One
 * Chromium-driven suite runs at a time (src/infra/db/test-lock.ts's browser lock — the suites take it, not this file).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Locator {
  getByTestId(id: string): Locator;
  getByRole(role: string, o?: { name?: string | RegExp }): Locator;
  getByLabel(text: string | RegExp, o?: { exact?: boolean }): Locator;
  locator(sel: string, o?: { hasText?: string | RegExp }): Locator;
  fill(value: string): Promise<void>;
  selectOption(value: string | { label?: string; value?: string }): Promise<string[]>;
  check(): Promise<void>;
  press(key: string): Promise<void>;
  allInnerTexts(): Promise<string[]>;
  evaluateAll<T>(fn: (els: unknown[]) => T): Promise<T>;
  count(): Promise<number>;
  first(): Locator;
  nth(i: number): Locator;
  all(): Promise<Locator[]>;
  click(o?: object): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  isVisible(): Promise<boolean>;
  waitFor(o?: { state?: string; timeout?: number }): Promise<void>;
  getAttribute(n: string): Promise<string | null>;
  inputValue(): Promise<string>;
}
/** A request the page made (Playwright's `Request`): the method, the URL and the JSON body when one was posted. */
export interface PageRequest { method(): string; url(): string; postData(): string | null }
export interface Page {
  on(event: "request", fn: (r: PageRequest) => void): void;
  on(event: string, fn: (x: { text(): string; message?: string }) => void): void;
  goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(o?: { waitUntil?: string }): Promise<unknown>;
  locator(sel: string, o?: { hasText?: string | RegExp }): Locator;
  getByTestId(id: string): Locator;
  getByRole(role: string, o?: { name?: string | RegExp }): Locator;
  getByLabel(text: string | RegExp, o?: { exact?: boolean }): Locator;
  evaluate<T>(fn: string): Promise<T>;
  viewportSize(): { width: number; height: number } | null;
  waitForSelector(sel: string, o?: { timeout?: number; state?: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  url(): string;
  /** The console lines and page errors the harness collected (`pageFor` attaches the listeners). */
  logs?: string[];
  /** 32.19: every API request the page made through its proxy (`/app/api/…`), as `METHOD path body` — what the page posted, and what it never posted. */
  requests?: string[];
}
export interface Context { addCookies(c: object[]): Promise<void>; cookies(): Promise<{ name: string; value: string }[]>; addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }
export interface Browser { newContext(o: object): Promise<Context>; close(): Promise<void> }

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const APP_DIR = `${ROOT}apps/borrower/`;
export const DIST = ".next-t13";
export const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export const SESSION_COOKIE = "sm_borrower_session";

export interface HarnessOptions {
  /** The test's API base (`http://127.0.0.1:port`), read when the app starts. */
  apiBase: () => string;
}
export interface Harness {
  ensureBuild(): void;
  shell(): Promise<string>;
  stopShell(): Promise<void>;
  pageFor(token: string | null, width: number, path?: string): Promise<{ page: Page; ctx: Context }>;
  /** 32.19: the Apply product on this test's API — `[data-testid="apply"]` rendered (the door for no token, the tab and step for a session). */
  openApply(token: string | null, width: number, path?: string): Promise<{ page: Page; ctx: Context }>;
  inViewport(page: Page, testId: string): Promise<boolean>;
  inViewportSel(page: Page, sel: string): Promise<boolean>;
  appLog(): string;
  appBase(): string;
}

function newestSource(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".next") || name === "tests" || name === "playwright-report" || name === "test-results") continue;
    const p = `${dir}/${name}`; const st = statSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestSource(p)); else if (/\.(ts|tsx|css|json|mjs|mts)$/.test(name)) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

export function createHarness(opts: HarnessOptions): Harness {
  let appProc: ChildProcess | null = null; let appBase = ""; let browser: Browser | null = null; let appLog = "";
  /** The standalone build in `.next-t13`, rebuilt when a source is newer. */
  function ensureBuild(): void {
    const buildId = `${APP_DIR}${DIST}/BUILD_ID`;
    if (!existsSync(buildId) || statSync(buildId).mtimeMs < newestSource(APP_DIR.replace(/\/$/, ""))) {
      const r = spawnSync("npx", ["next", "build"], { cwd: APP_DIR, env: { ...process.env, NEXT_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "pipe", timeout: 300_000, encoding: "utf8" });
      assert.equal(r.status, 0, `next build failed:\n${r.stdout}\n${r.stderr}`);
    }
    cpSync(`${APP_DIR}${DIST}/static`, `${APP_DIR}${DIST}/standalone/${DIST}/static`, { recursive: true });
  }
  async function shell(): Promise<string> {
    if (appBase) return appBase;
    ensureBuild();
    const port = 3400 + Math.floor(Math.random() * 400);
    appProc = spawn(process.execPath, [`${APP_DIR}${DIST}/standalone/server.js`], { cwd: `${APP_DIR}${DIST}/standalone`, env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", API_BASE_URL: opts.apiBase(), NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
    appProc.stdout?.on("data", (d: Buffer) => { appLog += d.toString(); }); appProc.stderr?.on("data", (d: Buffer) => { appLog += d.toString(); });
    appBase = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { try { const r = await fetch(`${appBase}/app`, { redirect: "manual" }); if (r.status < 500) return appBase; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
    throw new Error(`the borrower app did not start on ${appBase}:\n${appLog.slice(-2000)}`);
  }
  async function stopShell(): Promise<void> { await browser?.close().catch(() => undefined); browser = null; appProc?.kill(); appProc = null; }
  async function pageFor(token: string | null, width: number, path = "/app"): Promise<{ page: Page; ctx: Context }> {
    await shell();
    process.env["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/pw-browsers";
    if (!browser) { const pw = createRequire(import.meta.url)(`${APP_DIR}node_modules/playwright`) as { chromium: { launch(o: object): Promise<Browser> } }; browser = await pw.chromium.launch({ headless: true, ...(existsSync(CHROME) ? { executablePath: CHROME } : {}) }); }
    const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 800 }, ...(width < 768 ? { isMobile: true, hasTouch: true } : {}) });
    if (token) await ctx.addCookies([{ name: SESSION_COOKIE, value: token, domain: "127.0.0.1", path: "/app", httpOnly: true, secure: false, sameSite: "Strict" }]);
    const page = await ctx.newPage(); const logs: string[] = []; const requests: string[] = [];
    page.on("console", (m) => logs.push(`console: ${m.text()}`)); page.on("pageerror", (e) => logs.push(`pageerror: ${e.message ?? String(e)}`));
    page.on("request", (r: PageRequest) => { const u = r.url(); const i = u.indexOf("/app/api/"); if (i >= 0) requests.push(`${r.method()} ${u.slice(i + "/app/api".length)} ${r.postData() ?? ""}`.trimEnd()); });
    page.logs = logs; page.requests = requests;
    await page.goto(`${appBase}${path}`, { waitUntil: "load", timeout: 60_000 });   // never networkidle: the SSE stream stays open
    return { page, ctx };
  }
  async function openApply(token: string | null, width: number, path = "/app"): Promise<{ page: Page; ctx: Context }> {
    const p = await pageFor(token, width, path);
    try { await p.page.waitForSelector(token ? '[data-testid="apply"][data-tab]' : '[data-testid="apply"][data-door]', { timeout: 30_000 }); }
    catch (e) { throw new Error(`the Apply product did not render: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}; logs=${JSON.stringify(p.page.logs?.slice(-10))}; app=${appLog.slice(-800)}`); }
    return p;
  }
  async function inViewportSel(page: Page, sel: string): Promise<boolean> {
    const box = await page.locator(sel).first().boundingBox(); const vp = page.viewportSize()!;
    return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
  }
  const inViewport = (page: Page, testId: string): Promise<boolean> => inViewportSel(page, `[data-testid="${testId}"]`);
  return { ensureBuild, shell, stopShell, pageFor, openApply, inViewport, inViewportSel, appLog: () => appLog, appBase: () => appBase };
}
