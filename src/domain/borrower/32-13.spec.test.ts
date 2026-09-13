// 32.13 Cross-cutting: acceptance harness, copy library rules, side-quest catalogue
// spec/sections/32-borrower-experience/32-13-cross-cutting-acceptance-harness-copy-library-rules-side-que.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// The harness (13 §1–§2): one runtime over HTTP — the Journey fixture (20.x → 21.x → 25.x → 26.x → 30.x → 2.x → 16.x) with
// every 32.x flow (src/runtime/borrower/flows) reacting to the committed events — read the way the shell reads it (the
// borrower API: me, record, thread, cards, commands, deep links, documents), plus the shell itself: the built Next.js app
// (apps/borrower, `.next-t13`, rebuilt here when its sources are newer) pointed at this test's API through its proxy and
// driven with Playwright's Chromium from /opt/pw-browsers at 1280 and 390 px (T-X-08, T-X-10, T-X-11, T-X-12, T-X-15).
// The copy rules (T-X-13, T-X-14) are string assertions over copy-library.md. Tests run in journey order, not T-id order.
// Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { DEEP_LINK_DAYS } from "../../infra/db/borrower-ui.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST, MLO } from "../../runtime/borrower/fixtures/journey.ts";
import { deliverLeByConsent } from "../../runtime/borrower/flows/3-entry.ts";
import { TERMINAL_ALLOWED_COMMANDS } from "../../runtime/borrower/flows/13-cross-cutting.ts";
import { ALLOWED_TIMER_CODES, FLOW_TIMER_LABELS } from "../../runtime/borrower/record.ts";
import { SHAPES, ALL_ALLOWED_FIELDS, FORBIDDEN_FIELDS } from "../../runtime/borrower/serialize.ts";
import { DEFAULT_AFFIRMATIVES } from "../../runtime/borrower/commands.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const INTAKE = { kind: "agent" as const, id: "intake" }; const UNDERWRITER = { kind: "agent" as const, id: "underwriter" }; const DISCLOSURE = { kind: "agent" as const, id: "disclosure" }; const BORROWER_COMMS = { kind: "agent" as const, id: "borrower-comms" };
const REVIEWER = { kind: "human" as const, id: "u-uwr-1", role: "underwriting_reviewer" }; const HUMAN_AGENT = { kind: "human" as const, id: "u-agent-sam", role: "human_agent" };
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APP_DIR = `${ROOT}apps/borrower/`; const DIST = ".next-t13"; const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const COPY_MD = `${ROOT}spec/sections/32-borrower-experience/copy-library.md`;

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]);
  partnerPartyId = partner[0]!.id;
});
test.after(async () => { if (!skip) { await stopShell(); await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers over the borrower API and the flows (the 32.4 harness)
type Reply = { status: number; body: Record<string, unknown> };
type Json = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
async function signIn(destination: string, channel: "email" | "sms" = "email"): Promise<{ token: string; party_id: string; session_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel, destination });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id, session_id: (ver.body["session"] as { session_id: string }).session_id };
}
const settle = () => router.flows!.settle();
const tick = (now: string) => { clock.set(now); return router.flows!.tick(now); };
const record = async (email: string, subject: string, token?: string): Promise<Json> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, token ?? (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string, token?: string): Promise<{ messages: Json[]; body: Json }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, token ?? (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return { messages: r.body["messages"] as Json[], body: r.body }; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; command_ref: string | null; created_at: string; resolved_at: string | null; subject_application_id: string | null; subject_loan_id: string | null }
const cardsOf = async (partyId: string, where = ""): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at, subject_application_id, subject_loan_id FROM card_instances WHERE party_id = $1 ${where} ORDER BY created_at, card_instance_id`, [partyId]); };
const events = (appId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: Json; loan_id: string | null }>(`SELECT type, occurred_at, payload, loan_id FROM loan_events WHERE application_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [appId, type ?? null]);
const loanEvents = (loanId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: Json }>(`SELECT type, occurred_at, payload FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const entity = async (kind: string, id: string): Promise<Json | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const messagesOf = (partyId: string) => db.query<{ message_id: string; at: string; sender: string; channel: string; body_text: string | null; card_instance_id: string | null }>(`SELECT m.message_id, m.at, m.sender, m.channel, m.body_text, m.card_instance_id FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE c.party_id = $1 ORDER BY m.at, m.created_at, m.message_id`, [partyId]);
/** One application on the shared runtime: its own journey (prior loan, lead, borrowers with e-mails), both borrowers signed in, the 21.1 interview done. */
interface App { j: Journey; A: string; B: string; partyA: string; partyB: string }
const APPS_THIS_RUN: string[] = [];   // the database persists across runs: the table-wide invariants are scoped to this run's applications
async function openApp(): Promise<App> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await settle(); APPS_THIS_RUN.push(j.appId);
  return { j, A, B, partyA, partyB };
}
/** Cards through 32.1's `send_card` as the intake agent (the flows' own seam), with the props the components render. */
async function sendCard(app: App, partyId: string, kind: string, copy_key: string, props: Json, command_ref: string | null = null): Promise<string> {
  const r = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: app.j.appId, actor: INTAKE, run: { runId: "test:32.13", modelVersion: "harness", promptVersion: "32.13" },
    input: { party_id: partyId, kind, copy_key, props: { ...props, flow_key: `t13:${kind}:${randomUUID().slice(0, 8)}`, flow: "32.13-harness" }, command_ref, subject: { application_id: app.j.appId }, created_by: "agent:intake", rationale: `32.13 harness ${kind}` } });
  await settle(); return (r.output as { card_instance_id: string }).card_instance_id;
}
/** The wire's cents strings → bigint cents, as the API server revives request bodies (src/runtime/server.ts). */
function reviveCents(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveCents);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, k.endsWith("_cents") && (typeof x === "string" || typeof x === "number") && x !== "" ? BigInt(x) : reviveCents(x)]));
  return v;
}
/** Every key of a JSON value, depth-first (the leak checks walk the live responses). */
function keysOf(v: unknown, into = new Set<string>(), path = ""): Set<string> {
  if (Array.isArray(v)) { for (const x of v) keysOf(x, into, path); return into; }
  if (v && typeof v === "object") { for (const [k, x] of Object.entries(v as Json)) { into.add(k); keysOf(x, into, `${path}.${k}`); } }
  return into;
}
/** Every (path, key, value) leaf of a JSON value. */
function leavesOf(v: unknown, path = "", out: { path: string; key: string; value: unknown }[] = []): { path: string; key: string; value: unknown }[] {
  if (Array.isArray(v)) { v.forEach((x, i) => leavesOf(x, `${path}[${i}]`, out)); return out; }
  if (v && typeof v === "object") { for (const [k, x] of Object.entries(v as Json)) { if (x && typeof x === "object") leavesOf(x, `${path}.${k}`, out); else out.push({ path: `${path}.${k}`, key: k, value: x }); } }
  return out;
}

// ---------------------------------------------------------------- the copy library as text (13 §5: string assertions over copy-library.md)
interface CopyEntry { key: string; kind: string; text: string; quoted: boolean; extras: string[]; line: number }
function copyEntries(file = COPY_MD): CopyEntry[] {
  const DASH = " — "; const out: CopyEntry[] = [];
  const split = (s: string): string[] => { const parts: string[] = []; let cur = ""; let inQ = false; for (let i = 0; i < s.length; i++) { const ch = s[i]!; if (ch === '"') inQ = !inQ; if (!inQ && s.startsWith(DASH, i)) { parts.push(cur); cur = ""; i += DASH.length - 1; continue; } cur += ch; } parts.push(cur); return parts; };
  readFileSync(file, "utf8").split("\n").forEach((raw, i) => {
    const m = /^- `([^`]+)`(.*)$/.exec(raw); if (!m) return;
    const rest = m[2]!.trim(); const segs = split(rest.startsWith("—") ? rest.slice(1).trim() : rest); const kind = (segs.shift() ?? "").trim();
    let text = ""; let quoted = false; const extras: string[] = [];
    for (const seg0 of segs) { const seg = seg0.trim(); if (!text && /^"/.test(seg)) { text = seg.replace(/^"/, "").replace(/"\.?$/, ""); quoted = true; continue; } if (/^\*[^*].*\*\.?$/.test(seg)) continue; extras.push(seg); }
    out.push({ key: m[1]!, kind, text, quoted, extras, line: i + 1 });
  });
  return out;
}
const EXTRA_STRINGS = /^(why|helper|footer|fallback|line|footnote|what_to_expect|intro|prompt|label|statement|receipt|reply|sms|email):\s*"(.*)"\.?$/;
/** Every borrower-facing string of an entry: the quoted text and the quoted extras (`body:` blocks are templates the notice text fills). */
function stringsOf(e: CopyEntry): { what: string; s: string }[] {
  const out: { what: string; s: string }[] = []; if (e.quoted && e.text) out.push({ what: "text", s: e.text });
  for (const x of e.extras) { const mm = EXTRA_STRINGS.exec(x); if (mm) out.push({ what: mm[1]!, s: mm[2]! }); }
  return out;
}
/** Flesch–Kincaid grade = 0.39 (words/sentences) + 11.8 (syllables/words) − 15.59. Tokens count as one short word; a dash or a middle dot ends a clause. */
function syllablesOfWord(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, ""); if (!w) return 0; if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const m = w.match(/[aeiouy]{1,2}/g); return Math.max(1, m ? m.length : 1);
}
const syllables = (word: string): number => (/^\d/.test(word.replace(/^[$%]/, "")) ? 1 : word.split(/[-–]/).filter(Boolean).reduce((n, p) => n + syllablesOfWord(p), 0) || 1);
export function fleschKincaid(text: string): { grade: number; words: number; sentences: number; syllables: number } {
  const t = text.replace(/\{\{[^}]+\}\}/g, "May").replace(/\*([^*]+)\*/g, "$1").replace(/•+/g, "");
  const parts = t.split(/[.!?;:]+(?:\s|$)|\s+—\s+|\s+·\s+/).map((s) => s.trim()).filter((s) => /[A-Za-z0-9]/.test(s));
  const sentences = Math.max(1, parts.length);
  const words = t.replace(/[-–/]/g, " ").split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9'$%-]/g, "")).filter((w) => /[A-Za-z0-9]/.test(w));
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const grade = 0.39 * (words.length / sentences) + 11.8 * (syl / Math.max(1, words.length)) - 15.59;
  return { grade: Math.round(grade * 10) / 10, words: words.length, sentences, syllables: syl };
}

// ---------------------------------------------------------------- the shell: the built Next.js app on this test's API, driven with Playwright
interface Locator { getByTestId(id: string): Locator; fill(value: string): Promise<void>; allInnerTexts(): Promise<string[]>; evaluateAll<T>(fn: (els: unknown[]) => T): Promise<T>; count(): Promise<number>; first(): Locator; nth(i: number): Locator; click(o?: object): Promise<void>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>; textContent(): Promise<string | null>; isVisible(): Promise<boolean>; waitFor(o?: { state?: string; timeout?: number }): Promise<void>; getAttribute(n: string): Promise<string | null>; locator(sel: string, o?: { hasText?: string | RegExp }): Locator; all(): Promise<Locator[]>; innerText(): Promise<string> }
interface Page { on(event: string, fn: (x: { text(): string; message?: string }) => void): void; goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>; reload(o?: { waitUntil?: string }): Promise<unknown>; locator(sel: string, o?: { hasText?: string | RegExp }): Locator; getByTestId(id: string): Locator; evaluate<T>(fn: string): Promise<T>; viewportSize(): { width: number; height: number } | null; waitForTimeout(ms: number): Promise<void>; content(): Promise<string>; close(): Promise<void>; waitForSelector(sel: string, o?: { timeout?: number; state?: string }): Promise<unknown> }
interface Context { addCookies(c: object[]): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }
interface Browser { newContext(o: object): Promise<Context>; close(): Promise<void> }
let appProc: ChildProcess | null = null; let appBase = ""; let browser: Browser | null = null; let appLog = "";
function newestSource(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) { if (name === "node_modules" || name.startsWith(".next") || name === "tests" || name === "playwright-report" || name === "test-results") continue; const p = `${dir}/${name}`; const st = statSync(p); if (st.isDirectory()) newest = Math.max(newest, newestSource(p)); else if (/\.(ts|tsx|css|json|mjs|mts)$/.test(name)) newest = Math.max(newest, st.mtimeMs); }
  return newest;
}
/** The standalone build in `.next-t13` (an env-driven distDir so it never collides with the app's own `.next`), rebuilt when a source is newer. */
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
  appProc = spawn(process.execPath, [`${APP_DIR}${DIST}/standalone/server.js`], { cwd: `${APP_DIR}${DIST}/standalone`, env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", API_BASE_URL: base, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
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
  if (token) await ctx.addCookies([{ name: "sm_borrower_session", value: token, domain: "127.0.0.1", path: "/app", httpOnly: true, secure: false, sameSite: "Strict" }]);
  const page = await ctx.newPage(); const logs: string[] = [];
  page.on("console", (m) => logs.push(`console: ${m.text()}`)); page.on("pageerror", (e) => logs.push(`pageerror: ${e.message ?? String(e)}`));
  (page as Page & { logs: string[] }).logs = logs;
  await page.goto(`${appBase}${path}`, { waitUntil: "load", timeout: 60_000 });   // never networkidle: the SSE stream stays open
  return { page, ctx };
}
/** 32.16 §2.2: a card's home is its rail row; expanding it (client state) renders the existing component. The current ask is open by default; the other
 * pending cards wait behind "n more after this" and the reference sections start collapsed (32.16-T11), so the row is revealed first: the line, then its section. */
async function expandRail(page: Page, cardId: string): Promise<void> {
  const sel = `[data-rail-card="${cardId}"]`;
  const later = page.getByTestId("needs-later").first();
  if ((await page.locator(sel).count()) === 0 && (await later.count()) && (await later.getAttribute("aria-expanded")) === "false") await later.click();
  const row = page.locator(sel).first(); await row.waitFor({ state: "attached", timeout: 30_000 });
  const sections = row.locator("xpath=ancestor::section[@data-record-section]");   // outermost first: "Your record", then the card's own section
  for (let k = 0; k < (await sections.count()); k++) { const sec = sections.nth(k); if ((await sec.getAttribute("data-open")) === "false") await sec.locator("> h2 > button").click(); }
  if (!(await row.isVisible()) && (await later.count()) && (await later.getAttribute("aria-expanded")) === "false") await later.click();
  await row.waitFor({ state: "visible", timeout: 30_000 });
  if ((await row.getAttribute("data-expanded")) !== "true") await row.locator("> button").click();
}
async function inViewport(page: Page, testId: string): Promise<boolean> {
  const box = await page.getByTestId(testId).boundingBox(); const vp = page.viewportSize()!;
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
}
/** The shell's thread rendered from this test's API: the shell region, then the conversation with at least one message. */
async function openShell(token: string, width: number): Promise<{ page: Page; ctx: Context }> {
  const p = await pageFor(token, width);
  await p.page.waitForSelector('[data-testid="shell"]', { timeout: 30_000 });
  try { await p.page.waitForSelector('[data-testid="thread"] .sm-msg', { timeout: 30_000 }); }
  catch (e) { const notice = await p.page.locator(".sm-error").allInnerTexts().catch(() => [] as string[]); const failed = await p.page.locator('[data-testid="card-error"]').evaluateAll((els: unknown[]) => (els as { getAttribute(n: string): string | null }[]).map((e) => `${e.getAttribute("data-card-kind")}: ${e.getAttribute("data-error")}`)).catch(() => [] as string[]); (p.page as Page & { logs?: string[] }).logs?.push(`card errors=${JSON.stringify(failed)}`); throw new Error(`the shell rendered no thread: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}; notice=${JSON.stringify(notice)}; page logs=${JSON.stringify((p.page as Page & { logs?: string[] }).logs?.slice(-10))}; app log=${appLog.slice(-1500)}`); }
  return p;
}

// ---------------------------------------------------------------- the main journey (App J) and the snapshots T2 measures
let J: App; let W: App; let leadInteraction = ""; let deepLinkToken = ""; let deepLinkCard = ""; let deepLinkCreatedAt = "";
interface Snapshot { label: string; subject: { application_id: string | null; loan_id: string | null }; record: Json; timers: { code: string; status: string; due_at: string | null }[]; published: Record<string, string | null> }
const SNAPSHOTS: Snapshot[] = [];
async function snapshot(label: string, subjectId = J.j.appId): Promise<Json> {
  const r = await record(J.A, subjectId);
  const subject = r["subject"] as { application_id: string | null; loan_id: string | null };
  const timers = await db.query<{ code: string; status: string; due_at: string | null }>(`SELECT code, status::text AS status, due_at FROM timers WHERE ($1::uuid IS NOT NULL AND application_id = $1) OR ($2::uuid IS NOT NULL AND loan_id = $2)`, [subject.application_id, subject.loan_id]);
  const ev = subject.application_id ? await events(subject.application_id) : [];
  const waiting = ev.filter((e) => e.type === "disclosure.cd.waiting_period.computed").at(-1); const resc = ev.filter((e) => e.type === "rescission.period.started").at(-1);
  const closing = subject.application_id ? await entity("closings", `${subject.application_id}:closing`) : null;
  const closingAny = closing ?? (subject.application_id ? (await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'closings' AND (id = $1 OR id LIKE $1 || '%') ORDER BY updated_at DESC LIMIT 1`, [subject.application_id])).map((x) => decodeEntityData(x.data))[0] ?? null : null);
  SNAPSHOTS.push({ label, subject, record: r, timers: timers.map((t) => ({ ...t, due_at: t.due_at ? new Date(t.due_at).toISOString() : null })), published: { REGZ_1026_19F1_CD_3SBD_GATE: typeof waiting?.payload["earliest_consummation_date"] === "string" ? `${String(waiting.payload["earliest_consummation_date"])}T12:00:00.000Z` : null, REGZ_1026_23_RESCISSION_3SBD_GATE: typeof resc?.payload["expires_at"] === "string" ? String(resc.payload["expires_at"]) : null, "closings.scheduled_at": typeof closingAny?.["scheduled_at"] === "string" ? String(closingAny["scheduled_at"]) : null } });
  return r;
}
/** The party's pending E-SIGN ConsentCard (32.3 sends it on `application.received`), affirmed by tap and demonstrated through 20.3 (the 32.4-T1 path) — the row turns active on `consent.esign.active` (32.13). */
async function consentEsign(app: App, email: string, partyId: string, typedName: string): Promise<string> {
  const card = (await cardsOf(partyId, `AND kind = 'ConsentCard' AND status = 'pending'`)).find((c) => c.copy_key === "consent.esign.title" || c.props["consent_kind"] === "esign");
  assert.ok(card, `an E-SIGN ConsentCard is pending for ${email}`);
  const tok = (await signIn(email)).token;
  const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { evidence: { affirmation_method: "checkbox_with_text", typed_name: typedName, checkbox: true, disclosure_version_shown: card.props["disclosure_version_id"] } }, tok);
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 600));
  const consentId = String((r.body["result"] as Json)["consent_id"]);
  const row = (await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [consentId]))[0];
  assert.equal(row?.status, "pending_verification", "a typed yes is pending until the demonstration test (7.4 rule 2)");
  const at = clock.now();
  await app.j.tool({ app: app.j.appId }, "20.3", "captureConsent", { lead_id: app.j.appId, kind: "esign", op: "demonstrate", consent_id: consentId, link_opened_at: at, token_entered_at: at, token_ok: true });
  await settle();
  const active = (await db.query<{ status: string; scope: string[] }>(`SELECT status, scope FROM consents WHERE id = $1`, [consentId]))[0];
  assert.equal(active?.status, "active", "consent.esign.active turns the 7.4 row active (32.13 flow)"); assert.ok(active!.scope.includes("disclosures"));
  return consentId;
}
/** T-X-04 as an invariant over the whole table: every DocumentCard with a `disclosure_id` delivered electronically has an active esign consent for its party, scoped to the class, captured no later than `delivered_at`. */
async function assertConsentPrecedesEdelivery(): Promise<number> {
  const rows = await db.query<{ card_instance_id: string; party_id: string; props: Json }>(`SELECT card_instance_id, party_id, props FROM card_instances WHERE kind = 'DocumentCard' AND props->>'disclosure_id' IS NOT NULL AND subject_application_id = ANY($1::uuid[])`, [APPS_THIS_RUN]);
  let checked = 0;
  for (const c of rows) {
    const channel = String(c.props["channel"] ?? "esign_portal"); const delivered = c.props["delivered_at"];
    if (channel === "mail" || typeof delivered !== "string") continue;   // a mailed copy stands on its mailing evidence; only an electronic delivery needs the consent
    const cls = String(c.props["esign_scope_required"] ?? "disclosures").replace(/^origination_/, "");
    const ok = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE kind = 'esign' AND status = 'active' AND party_id = $1 AND $2 = ANY(scope) AND captured_at <= $3`, [c.party_id, cls, delivered]);
    assert.ok(Number(ok[0]?.n ?? 0) > 0, `DocumentCard ${c.card_instance_id} (${String(c.props["disclosure_id"])}, ${channel}) for party ${c.party_id}: no active esign consent scoped to ${cls} at ${delivered}`);
    checked++;
  }
  return checked;
}
/** T-X-16's read-only check on one subject: the commands that must refuse, the three that must run, the document that must still download, the cards that no longer resolve. */
async function assertReadOnly(email: string, subject: { application_id?: string; loan_id?: string }, refused: string[], label: string): Promise<void> {
  const s = await signIn(email); const tok = s.token; const sub = { application_id: subject.application_id ?? null, loan_id: subject.loan_id ?? null };
  for (const name of refused) {
    const r = await api("POST", `/v1/borrower/commands/${name}`, { subject: sub, kind: "general_inquiry", text: "x", amount_cents: "100", vendor: "truv_income", borrower_id: "B1" }, tok);
    assert.equal(r.status, 409, `${label}: ${name} must be refused: ${JSON.stringify(r.body)}`); assert.equal(r.body["code"], "SUBJECT_TERMINAL"); assert.equal(r.body["copy_key"], "error.read_only"); assert.deepEqual(Object.keys(r.body).sort(), ["code", "copy_key"], "the refusal carries {code, copy_key} and nothing else");
  }
  assert.ok(TERMINAL_ALLOWED_COMMANDS.has("human.request") && TERMINAL_ALLOWED_COMMANDS.has("case.open") && TERMINAL_ALLOWED_COMMANDS.has("party.updateContact"));
  const human = await api("POST", "/v1/borrower/commands/human.request", { subject: sub, reason: "question about my closed file" }, tok); assert.equal(human.status, 200, `${label}: human.request runs: ${JSON.stringify(human.body)}`);
  const contact = await api("POST", "/v1/borrower/commands/party.updateContact", { subject: sub, phone: `+1602555${String(1000 + Math.floor(Math.random() * 8999))}` }, tok); assert.equal(contact.status, 200, `${label}: party.updateContact runs: ${JSON.stringify(contact.body)}`);
  if (subject.loan_id) { const c = await api("POST", "/v1/borrower/commands/case.open", { subject: sub, kind: "general_inquiry", text: "Please send my final statement." }, tok); assert.equal(c.status, 200, `${label}: case.open runs: ${JSON.stringify(c.body)}`); }
  const rec = await record(email, subject.loan_id ?? subject.application_id!, tok);
  const docs = rec["documents"] as { document_id: string }[];
  for (const d of docs.slice(0, 5)) { const dl = await api("GET", `/v1/borrower/documents/${d.document_id}`, undefined, tok); assert.notEqual(dl.body["code"], "SUBJECT_TERMINAL", `${label}: document download is never refused by the read-only rule`); if (/^[0-9a-f-]{36}$/.test(String(d.document_id))) assert.ok(dl.status === 200 || dl.body["code"] === "DOCUMENT_NOT_VISIBLE" || dl.body["code"] === "DOCUMENT_CONTENT_UNAVAILABLE", `${label}: the document still downloads: ${JSON.stringify(dl.body)}`); }
  const pending = (await cardsOf(s.party_id, `AND status = 'pending'`)).filter((c) => (subject.application_id && c.subject_application_id === subject.application_id) || (subject.loan_id && c.subject_loan_id === subject.loan_id));
  for (const c of pending) { if (!c.command_ref || TERMINAL_ALLOWED_COMMANDS.has(c.command_ref)) continue; const r = await api("POST", `/v1/borrower/cards/${c.card_instance_id}/resolve`, { option_id: "affirm", evidence: { checkbox: true, typed_name: "x" } }, tok); assert.ok(r.status >= 400 && r.status < 500, `${label}: a pending ${c.kind} (${c.command_ref}) no longer commits: ${JSON.stringify(r.body)}`); assert.equal(typeof r.body["copy_key"], "string"); assert.equal((await cardsOf(s.party_id, `AND card_instance_id = '${c.card_instance_id}'`))[0]!.status, "pending", `${label}: the ${c.kind} did not move`); }
}

// ═══════════════════════════════════ the copy rules (13 §5): pure string assertions, first
test("32.13-T13: Reading level — Given every string in 12 outside notice templates, then its Flesch-Kincaid grade ≤ 8.", async () => {
  const entries = copyEntries(); assert.ok(entries.length > 300, `the copy library parsed (${entries.length} keys)`);
  // the worked example of the formula: a short plain sentence reads below grade 4; a long Latinate one above 12
  assert.ok(fleschKincaid("We sent your Loan Estimate today. Confirm you got it.").grade < 4);
  assert.ok(fleschKincaid("Notwithstanding the aforementioned considerations, the institution's determination regarding eligibility remains contingent upon supplementary documentation.").grade > 12);
  // outside notice templates: `body:` blocks are the template text the notice fills (12 header: notices keep their template text); `token` fragments are inserted into a host
  // sentence and are measured there; the Colorado pre-use line carries the statute's own elements; a string under eight words is a label, not prose
  const EXEMPT_KEYS = new Set(["entry.disclosure.co_admt"]);
  const over: string[] = []; let tested = 0;
  for (const e of entries) {
    if (e.kind === "token" || EXEMPT_KEYS.has(e.key)) continue;
    for (const { what, s } of stringsOf(e)) { const r = fleschKincaid(s); if (r.words < 8) continue; tested++; if (r.grade > 8) over.push(`${e.key} (${what}, line ${e.line}): grade ${r.grade} — ${s.slice(0, 100)}`); }
  }
  assert.ok(tested > 200, `enough prose measured (${tested})`);
  assert.deepEqual(over, [], `every string reads at grade 8 or below:\n${over.join("\n")}`);
  // the app's generated copy is the same library (gen-copy): every key here is there
  const generated = readFileSync(`${APP_DIR}lib/copy/generated.ts`, "utf8");
  for (const e of entries.slice(0, 50)) assert.ok(generated.includes(`"${e.key}"`), `${e.key} is in apps/borrower/lib/copy/generated.ts (npm run gen:copy)`);
});

test("32.13-T14: Forbidden words — Given every string in 12, then none of the forbidden words appears outside its allowed keys.", async () => {
  const entries = copyEntries();
  // 13 §5 / 12: the forbidden words and where each is allowed
  const RULES: { word: string; re: RegExp; allowed: RegExp | null }[] = [
    { word: "guarantee", re: /guarantee/i, allowed: null },
    { word: "pre-approved", re: /pre-?approved/i, allowed: /^preapproval\./ },
    { word: "you don't qualify", re: /you don['’]t qualify/i, allowed: null },
    { word: "denied", re: /\bdenied\b/i, allowed: /^(decision\.|notice\.)/ },
    { word: "skip a payment", re: /skip a payment/i, allowed: null },
    { word: "Fannie Mae", re: /fannie mae/i, allowed: /^(boarding\.fannie_letter|notice\.|ntc_)/i },
  ];
  const hits: string[] = []; let strings = 0;
  for (const e of entries) {
    const all = [...stringsOf(e).map((x) => x.s), ...e.extras.filter((x) => /^body:/.test(x)).map((x) => x.replace(/^body:\s*/, ""))];
    for (const s of all) { strings++; for (const r of RULES) if (r.re.test(s) && !(r.allowed && r.allowed.test(e.key))) hits.push(`${e.key} (line ${e.line}): "${r.word}" — ${s.slice(0, 90)}`); }
  }
  assert.ok(strings > 300, `strings checked (${strings})`);
  assert.deepEqual(hits, [], `no forbidden word outside its allowed keys:\n${hits.join("\n")}`);
  // the allowed keys exist and do use their word (the rule is about placement, not absence)
  assert.ok(entries.some((e) => /^boarding\.fannie_letter/.test(e.key) && /fannie mae/i.test(e.text)), "boarding.fannie_letter names Fannie Mae");
  // the seam's own lines (src/runtime/borrower/copy-keys.ts) are authored in the library
  const seam = readFileSync(`${ROOT}src/runtime/borrower/copy-keys.ts`, "utf8"); const keys = new Set(entries.map((e) => e.key));
  const referenced = [...seam.matchAll(/"((?:gate|auth|deeplink|documents|error|thread|identity)\.[a-z_.]+)"/g)].map((m) => m[1]!);
  const missing = [...new Set(referenced)].filter((k) => !keys.has(k));
  assert.deepEqual(missing, [], `every copy key the API names is authored: ${missing.join(", ")}`);
});

// ═══════════════════════════════════ the main journey (App J): consent → LE → chat rules → deep links → the degraded vendor → scoping
test("32.13-T4: Consent precedes e-delivery — Given any `DocumentCard` with `disclosure_id`, then a `consents{kind=esign, status=active}` row scoped to the disclosure class exists for that party at `delivered_at`.", { skip }, async () => {
  J = await openApp(); await snapshot("interview");
  // before any consent: no DocumentCard carries a disclosure_id for either party
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM card_instances WHERE kind = 'DocumentCard' AND subject_application_id = $1 AND props->>'disclosure_id' IS NOT NULL`, [J.j.appId]))[0]!.n, "0");
  // each party affirms E-SIGN by tap and demonstrates access (7.4 rule 2) — the 0009 row is `active` only then
  const cA = await consentEsign(J, J.A, J.partyA, "Alex Borrower"); const cB = await consentEsign(J, J.B, J.partyB, "Blake Borrower");
  // the LE goes out by the parties' consents (32.3's deliverLeByConsent chooses esign_portal only when every party's row is active at the delivery instant)
  await J.j.quoteOnly();
  const render = reviveCents((J.j as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER());   // the fixture is wire-shaped (cents as strings); in process the 21.2 bridge takes bigint cents
  clock.set(MST("2026-10-05", "16:10"));
  const le = await deliverLeByConsent(runtime, J.j.appId, { render: render as never, mlo: { review_id: `MR-LE-${J.j.R}`, nmlsr_id: "987654" }, at: MST("2026-10-05", "16:10") });
  assert.equal(le.channel, "esign_portal"); assert.deepEqual(le.consent_ids.sort(), [cA, cB].sort());
  await settle();
  const leCards = await db.query<{ card_instance_id: string; party_id: string; props: Json }>(`SELECT card_instance_id, party_id, props FROM card_instances WHERE kind = 'DocumentCard' AND subject_application_id = $1 AND props->>'disclosure_id' IS NOT NULL`, [J.j.appId]);
  assert.equal(leCards.length, 2, "one LE DocumentCard per party"); assert.deepEqual(leCards.map((c) => c.party_id).sort(), [J.partyA, J.partyB].sort());
  for (const c of leCards) { assert.equal(c.props["channel"], "esign_portal"); assert.equal(typeof c.props["delivered_at"], "string"); assert.equal(c.props["esign_scope_required"], "disclosures");
    const consent = (await db.query<{ status: string; captured_at: string; scope: string[] }>(`SELECT status, captured_at, scope FROM consents WHERE kind = 'esign' AND party_id = $1 ORDER BY captured_at DESC LIMIT 1`, [c.party_id]))[0]!;
    assert.equal(consent.status, "active"); assert.ok(Date.parse(consent.captured_at) <= Date.parse(String(c.props["delivered_at"])), "the consent was captured no later than delivered_at"); assert.ok(consent.scope.includes("disclosures"), "scoped to the disclosure class"); }
  assert.ok((await assertConsentPrecedesEdelivery()) >= 2);
  // the Record's Documents row is the same disclosure, and each party confirms receipt on their card (the LE's own acknowledgment, 21.2)
  for (const [email, party] of [[J.A, J.partyA], [J.B, J.partyB]] as const) {
    const card = leCards.find((c) => c.party_id === party)!; const tok = (await signIn(email)).token;
    const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { option_id: "acknowledge", evidence: { opened_at: clock.now(), scrolled_to_end: true } }, tok);
    assert.ok(r.status === 201 || (r.status === 200 && r.body["idempotent"] === true), JSON.stringify(r.body).slice(0, 500));   // 200: the e-signature at delivery already counted as the receipt (21.2) and the flow filed the card
  }
  await settle();
  const rec = await snapshot("le_received");
  const docs = rec["documents"] as Json[];
  assert.ok(docs.some((d) => d["disclosure_id"] === leCards[0]!.props["disclosure_id"] && d["channel"] !== "mail"), "the LE is a Documents row delivered electronically");
  assert.ok((await events(J.j.appId, "disclosure.le.received")).length >= 1, "receipt confirmed through the cards");
});

test("32.13-T7: Voice never consents — Given any `ConsentCard`, when a voice session affirms, then the card stays `pending` and the invitation link is sent.", { skip }, async () => {
  // B's remaining ConsentCards (TCPA, the credit authorization) are pending; a voice session opens (the disclosure is spoken first) and B says yes
  const seeded = await sendCard(J, J.partyB, "ConsentCard", "consent.esign.title", { consent_kind: "esign", disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", scope: ["disclosures", "notices"], affirmation_method: "checkbox_with_text", title: "", body_text: "", footer_text: "", requires_typed_name: true, verification_state: "none", affirmatives: ["yes to e-delivery"], command_args: { kind: "esign", method: "checkbox_with_text", scope: ["disclosures", "notices"] } }, "consent.capture");
  const pending = (await cardsOf(J.partyB, `AND kind = 'ConsentCard' AND status = 'pending'`));
  assert.ok(pending.length >= 1, "a ConsentCard is pending for B"); assert.ok(pending.some((c) => c.card_instance_id === seeded));
  const card = pending.find((c) => c.card_instance_id === seeded)!; const tok = (await signIn(J.B)).token;
  const voice = await api("POST", "/v1/borrower/voice/session", { application_id: J.j.appId }, tok); assert.equal(voice.status, 200, JSON.stringify(voice.body)); assert.equal(voice.body["vendor"], "FAKE");
  const before = (await events(J.j.appId)).length;
  // a spoken yes in the thread: the reply is the invitation link, never a consent
  const said = await api("POST", "/v1/borrower/messages", { text: "yes to e-delivery", channel: "voice" }, tok);
  assert.equal(said.status, 200, JSON.stringify(said.body)); assert.equal(said.body["command_executed"], false);
  const reply = said.body["reply"] as Json; assert.ok(reply["deep_link"], "the invitation link is sent"); assert.equal(reply["copy_key"], "consent.esign.title", "the spoken yes gets the E-SIGN invitation, never a consent"); assert.equal(reply["card_instance_id"], seeded); assert.match(String(reply["body_text"]), /\/d\//);
  // a spoken tap on the card itself is refused the same way
  for (const c of pending) { const tap = await api("POST", `/v1/borrower/cards/${c.card_instance_id}/resolve`, { channel: "voice", option_id: "affirm", evidence: { consent_kind: c.props["consent_kind"], method: "spoken", affirmed_at: clock.now() } }, tok);
    assert.equal(tap.status, 409, JSON.stringify(tap.body)); assert.equal(tap.body["code"], "CARD_VOICE_CONSENT"); assert.equal(typeof tap.body["copy_key"], "string"); }
  await settle();
  assert.equal((await cardsOf(J.partyB, `AND card_instance_id = '${card.card_instance_id}'`))[0]!.status, "pending", "the card stays pending");
  for (const c of pending) assert.equal((await cardsOf(J.partyB, `AND card_instance_id = '${c.card_instance_id}'`))[0]!.status, "pending");
  assert.equal((await events(J.j.appId)).length, before, "nothing committed");
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE party_id = $1 AND captured_via = 'voice'`, [J.partyB]))[0]!.n, "0");
});

test("32.13-T5: Cards commit, chat doesn't — Given a borrower message whose text matches a pending card's affirmative (e.g., \"yes proceed\", \"lock it\", \"I agree\"), then no command executes and the reply contains the deep link.", { skip }, async () => {
  // a pending card whose affirmatives the three phrases match (the defaults cover them all; the card also lists its own)
  for (const p of ["yes proceed", "lock it", "i agree"]) assert.ok(DEFAULT_AFFIRMATIVES.includes(p), `${p} is a default affirmative`);
  const cardId = await sendCard(J, J.partyA, "ChoiceCard", "intent.title", { title: "Ready to proceed?", options: [{ id: "proceed", label: "Yes, proceed", is_primary: true }, { id: "lock", label: "Lock it" }], command: "intent.record", command_args_by_option: { proceed: { statement_text: "I want to proceed" }, lock: { statement_text: "lock" } }, affirmatives: ["I agree"] }, "intent.record");
  const tok = (await signIn(J.A)).token;
  for (const text of ["yes proceed", "lock it", "I agree"]) {
    const before = (await events(J.j.appId)).length; const cardsBefore = JSON.stringify((await cardsOf(J.partyA)).map((c) => [c.card_instance_id, c.status]));
    const r = await api("POST", "/v1/borrower/messages", { text }, tok);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    assert.equal(r.body["command_executed"], false, `"${text}" executes nothing`); assert.equal(r.body["command"], null);
    const reply = r.body["reply"] as Json; const link = reply["deep_link"] as Json | null;
    assert.ok(link && typeof link["token"] === "string", "the reply carries the deep link"); assert.match(String(reply["body_text"]), new RegExp(`/d/${String(link!["token"])}`)); assert.equal(reply["copy_key"], "thread.card_affirmative_deep_link");
    const matched = String(reply["card_instance_id"]); const pendingIds = (await cardsOf(J.partyA, `AND status = 'pending'`)).map((c) => c.card_instance_id);
    assert.ok(pendingIds.includes(matched), "the link points at a pending card of the party"); assert.equal((link!["path"] as string | undefined) ?? `/d/${String(link!["token"])}`, `/d/${String(link!["token"])}`);
    await settle();
    assert.equal((await events(J.j.appId)).length, before, "no event committed"); assert.equal(JSON.stringify((await cardsOf(J.partyA)).map((c) => [c.card_instance_id, c.status])), cardsBefore, "no card moved");
    if (!deepLinkToken) { deepLinkToken = String(link!["token"]); deepLinkCard = matched; deepLinkCreatedAt = clock.now(); }
  }
  assert.equal((await events(J.j.appId, "intent.to_proceed.received")).length, 0, "intent is never recorded from chat (01 §6.4)");
  // the same card resolved by tap does commit: intent through the card, evidence on the card, the receipt line in the thread
  const tap = await api("POST", `/v1/borrower/cards/${cardId}/resolve`, { option_id: "proceed", evidence: { tapped: true } }, tok);
  assert.equal(tap.status, 201, JSON.stringify(tap.body).slice(0, 600)); await settle();
  assert.ok((await events(J.j.appId, "intent.to_proceed.received")).length >= 1, "the tap committed intent");
});

test("32.13-T11: Deep links — Given an SMS deep link opened without a session, then L1 is required before any loan data renders; the token resolves to the card and expires at 7 days.", { skip }, async () => {
  assert.ok(deepLinkToken, "T5 produced a deep link");
  // without a session: 401 with {code, copy_key} and nothing else — no loan data
  const anon = await api("GET", `/v1/borrower/deeplink/${deepLinkToken}`);
  assert.equal(anon.status, 401); assert.equal(anon.body["code"], "AUTH_REQUIRED"); assert.deepEqual(Object.keys(anon.body).sort(), ["code", "copy_key"]); assert.equal(anon.body["copy_key"], "auth.sign_in");
  // the link page itself renders no loan data before L1: a code field, no card, no address, no amount
  const { page, ctx } = await pageFor(null, 390, `/app/d/${deepLinkToken}`);
  await page.waitForSelector("#otp", { timeout: 30_000 });
  assert.equal(await page.locator("article[data-card-kind]").count(), 0, "no card renders before L1");
  const html = await page.content(); assert.ok(!html.includes("Central Ave") && !/\$\d/.test(html.replace(/<script[\s\S]*?<\/script>/g, "")), "no address or amount before L1");
  await ctx.close();
  // L1 (a code) — the token resolves to the card and the party
  const s = await signIn(J.A);
  const ok = await api("GET", `/v1/borrower/deeplink/${deepLinkToken}`, undefined, s.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal((ok.body["target"] as Json)["card_instance_id"], deepLinkCard); assert.deepEqual(Object.keys(ok.body).sort(), ["expires_at", "target", "token"]);
  const row = (await db.query<{ created_at: string; expires_at: string; party_id: string }>(`SELECT created_at, expires_at, party_id FROM deep_links WHERE token = $1`, [deepLinkToken]))[0]!;
  assert.equal(row.party_id, J.partyA); assert.equal(DEEP_LINK_DAYS, 7);
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), 7 * 24 * 3600 * 1000, "expires 7 days after creation"); assert.equal(new Date(row.expires_at).toISOString(), ok.body["expires_at"]);
  // another party's session never resolves it
  const other = await api("GET", `/v1/borrower/deeplink/${deepLinkToken}`, undefined, (await signIn(J.B)).token); assert.equal(other.status, 403); assert.equal(other.body["code"], "PARTY_SCOPE");
  // at 7 days it is gone: a link minted 7 days and a minute before now (the same repository, the same 7-day rule) answers 410 and nothing else
  const old = await router.ui.createDeepLink({ party_id: J.partyA, target: { card_instance_id: deepLinkCard }, now: new Date(Date.parse(clock.now()) - (DEEP_LINK_DAYS * 24 * 3600 * 1000 + 60_000)).toISOString() });
  assert.ok(Date.parse(old.expires_at) < Date.parse(clock.now()));
  const gone = await api("GET", `/v1/borrower/deeplink/${old.token}`, undefined, s.token);
  assert.equal(gone.status, 410, JSON.stringify(gone.body)); assert.equal(gone.body["code"], "DEEP_LINK_EXPIRED"); assert.equal(gone.body["copy_key"], "deeplink.expired"); assert.deepEqual(Object.keys(gone.body).sort(), ["code", "copy_key"]);
  assert.equal((await api("GET", `/v1/borrower/deeplink/${deepLinkToken}`, undefined, s.token)).status, 200, "the fresh link still resolves");
  const unknown = await api("GET", `/v1/borrower/deeplink/nope-${randomUUID().slice(0, 8)}`, undefined, s.token); assert.equal(unknown.status, 404); assert.equal(unknown.body["code"], "DEEP_LINK_UNKNOWN");
});

test("32.13-T12: Degraded vendor — Given Truv returns an error, then the `ConnectCard` shows `failed` with the upload fallback and no error code is shown to the borrower.", { skip }, async () => {
  const cardId = await sendCard(J, J.partyA, "ConnectCard", "income.connect.purpose", { vendor: "truv_income", vendor_fake: "FAKE", purpose_text: "", what_we_get: [], fallback: { label: "Send paystubs instead" }, state: "not_started", command_args: { vendor: "truv_income", borrower_id: "B1", fee_paid_by: "sm" } }, "verification.connect");
  const tok = (await signIn(J.A)).token;
  const go = await api("POST", `/v1/borrower/cards/${cardId}/resolve`, { option_id: "connect", evidence: { vendor: "truv_income", started_at: clock.now() } }, tok);
  assert.equal(go.status, 201, JSON.stringify(go.body).slice(0, 600));
  const session = await api("POST", "/v1/borrower/connect/truv_income/session", { card_instance_id: cardId }, tok);
  assert.equal(session.status, 200, JSON.stringify(session.body)); assert.equal(session.body["delivery"], "FAKE");
  const vsid = String(session.body["vendor_session_id"]);
  // the FAKE vendor fails the report with a vendor code the borrower must never see
  const hook = await api("POST", "/v1/webhooks/truv", { type: "voie.report.failed", data: { vendor_session_id: vsid, error: { code: "TRUV_ERR_ITEM_LOGIN_REQUIRED", message: "provider outage 502" } } }, undefined, { "x-truv-signature": "FAKE" });
  assert.equal(hook.status, 200, JSON.stringify(hook.body)); assert.equal(hook.body["outcome"], "failed"); await settle();
  const card = (await cardsOf(J.partyA, `AND card_instance_id = '${cardId}'`))[0]!;
  assert.equal(card.props["state"], "failed"); assert.equal(card.props["fallback_offered"], true);
  assert.equal((card.evidence as Json)["outcome"], "failed"); assert.equal((card.evidence as Json)["fallback"], "upload");
  const everything = JSON.stringify({ card, thread: (await thread(J.A, tok)).body, record: await record(J.A, J.j.appId, tok) });
  assert.ok(!/TRUV_ERR|ITEM_LOGIN_REQUIRED|provider outage/.test(everything), "no vendor error code or message reaches the borrower");
  // the way forward: the thread says so and an UploadCard for the same purpose is pending
  const msgs = await messagesOf(J.partyA); assert.ok(msgs.some((m) => m.body_text === "{{copy:connect.failed.fallback}}" && m.card_instance_id === cardId), "the fallback line");
  const upload = (await cardsOf(J.partyA, `AND kind = 'UploadCard' AND status = 'pending'`)).find((c) => c.props["fallback_for_card_instance_id"] === cardId);
  assert.ok(upload, "an UploadCard is the fallback"); assert.equal(upload.copy_key, "income.upload.fallback"); assert.equal(upload.command_ref, "document.upload");
  // in the shell: the ConnectCard reads failed with the documents path, the code nowhere on the page
  const { page, ctx } = await openShell(tok, 1280);
  await expandRail(page, cardId); await expandRail(page, upload.card_instance_id);
  const article = page.locator(`article[data-card-id="${cardId}"]`).first(); await article.waitFor({ timeout: 30_000 });
  const text = await article.innerText(); assert.match(text, /Couldn't connect|documents instead/i); assert.ok(!/TRUV_ERR|ITEM_LOGIN_REQUIRED|provider outage/.test(await page.content()), "no vendor code on the page");
  assert.ok((await page.locator(`article[data-card-id="${upload.card_instance_id}"]`).count()) >= 1, "the UploadCard renders");
  assert.equal(await page.locator('[data-testid="card-error"]').count(), 0, "every card renders");
  await ctx.close();
});

test("32.13-T6: Party scoping — Given a co-borrower session, then the Record shows the other party's first name and `progress` booleans only; `applicant_demographics`, income and liabilities of the other party never appear.", { skip }, async () => {
  const tokB = (await signIn(J.B)).token; const rec = await record(J.B, J.j.appId, tokB); const th = await thread(J.B, tokB);
  const people = rec["people"] as Json[]; const alex = people.find((p) => p["party_id"] === J.partyA); const me = people.find((p) => p["party_id"] === J.partyB);
  assert.ok(alex && me, "both borrowers are listed");
  assert.equal(alex["display_name"], "Alex", "the other party: first name only"); assert.equal(alex["is_you"], false); assert.equal(me["display_name"], "Blake Borrower"); assert.equal(me["is_you"], true);
  assert.deepEqual(Object.keys(alex).sort(), ["display_name", "is_you", "party_id", "progress", "role", "waiting"], "first name, role and progress booleans — nothing else");
  const progress = alex["progress"] as Json; assert.deepEqual(Object.keys(progress).sort(), ["confirmations_ok", "consents_ok", "signed"]); for (const v of Object.values(progress)) assert.equal(typeof v, "boolean");
  // nothing of the other party's file: no demographic, income, liability or identity field anywhere in B's Record or Thread
  const leak = ["ethnicity", "race", "sex", "applicant_demographics", "income", "monthly_income_cents", "liabilities", "liability", "ssn", "tin", "tin_last4", "date_of_birth", "credit_score", "applicable_score", "assets"];
  const keys = keysOf({ rec, th: th.body }); for (const k of leak) assert.ok(!keys.has(k), `${k} never appears in a co-borrower's responses`);
  assert.ok(!JSON.stringify(rec).includes("Alex Borrower"), "the other party's full legal name is not on the Record");
  // B's cards are B's alone; A's cards never appear in B's thread
  for (const m of th.messages) { const c = m["card"] as Json | null; if (c) assert.ok((await cardsOf(J.partyB, `AND card_instance_id = '${String(c["card_instance_id"])}'`)).length === 1, "every card in B's thread is B's"); }
  const aRec = await record(J.A, J.j.appId); const blake = (aRec["people"] as Json[]).find((p) => p["party_id"] === J.partyB)!; assert.equal(blake["display_name"], "Blake");
});

test("32.13-T3: Serializer allow-list — Given every `/v1/borrower/*` response schema, then no field name from `du_findings_interpretations`, `risk_assessment`, `credit_reports.*` (except score-notice fields), `compliance_test_runs`, `qc_*`, `fraud_*`, `applicant_demographics` appears.", { skip }, async () => {
  // every response the router sends names a shape, and every shape is an allow-list (nothing opaque but the card props/evidence and command results)
  // every module of the borrower API that sends a response (routes.ts and, since 32.14 DELTA-11, lead-routes.ts — POST /v1/borrower/lead); `funnel` is the console's /api/funnel shape (32.14 T18), serialized through the same allow-list
  const routes = readdirSync(`${ROOT}src/runtime/borrower`).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => readFileSync(`${ROOT}src/runtime/borrower/${f}`, "utf8")).filter((src) => /\bsend\(res, /.test(src)).join("\n");
  const sent = [...new Set([...routes.matchAll(/send\(res, [^,]+, "([a-z_]+)"/g)].map((m) => m[1]!))];
  assert.ok(sent.length >= 15, `the route set (${sent.length} shapes)`); for (const s of sent) assert.ok(s in SHAPES, `route response "${s}" is a serializer shape`);
  for (const name of Object.keys(SHAPES)) assert.ok(sent.includes(name) || ["session", "level", "funnel"].includes(name) || /^(voice|connect|identity|passkey|document|deep|otp|history|stream|error)/.test(name), `shape ${name} is sent by a route`);
  for (const f of FORBIDDEN_FIELDS) assert.ok(!ALL_ALLOWED_FIELDS.has(f), `${f} is never an allowed field`);
  // the restricted tables' own column names (beyond the generic ones ordinary tables share) never appear in any shape — the schema grep over the current route set
  const RESTRICTED = `table_name IN ('du_findings_interpretations', 'risk_assessment', 'credit_reports', 'compliance_test_runs', 'applicant_demographics') OR table_name LIKE 'qc_%' OR table_name LIKE 'fraud_%' OR table_name LIKE 'credit_report_%'`;
  const restricted = await db.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema IN ('public', 'restricted_fl') AND (${RESTRICTED})`);
  assert.ok(restricted.length > 50, "the restricted tables exist");
  const generic = new Set((await db.query<{ column_name: string }>(`SELECT DISTINCT column_name FROM information_schema.columns WHERE table_schema = 'public' AND NOT (${RESTRICTED})`)).map((r) => r.column_name));
  const SCORE_NOTICE = new Set(["score", "score_model", "range_min", "range_max", "key_factors", "date"]);   // the score-notice fields a decision notice may carry (FCRA §615(h)); none is a shape field today
  const leaks = restricted.filter((c) => !generic.has(c.column_name) && !SCORE_NOTICE.has(c.column_name) && ALL_ALLOWED_FIELDS.has(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`);
  assert.deepEqual(leaks, []);
  const specific = new Set(restricted.filter((c) => !generic.has(c.column_name)).map((c) => c.column_name));
  // and the live responses of the journey — me, record, thread, history, a card — carry none of those names either (props included)
  const tok = (await signIn(J.A)).token;
  const live: Json = {};
  for (const p of ["/v1/borrower/me", `/v1/borrower/record?subject=${J.j.appId}`, "/v1/borrower/thread?limit=500"]) { const r = await api("GET", p, undefined, tok); assert.equal(r.status, 200, p); live[p] = r.body; }
  const keys = keysOf(live);
  for (const f of FORBIDDEN_FIELDS) assert.ok(!keys.has(f), `${f} on the wire`);
  for (const k of keys) assert.ok(!specific.has(k), `${k} (a restricted table's column) on the wire`);
});

// ═══════════════════════════════════ every channel's first words, then the journey to a serviced loan
test("32.13-T1: Disclosure first — Given any new session on app, voice or SMS, then `lead.disclosure.delivered` precedes any other assistant content (32.3-T1 generalized to servicing sessions: `consent.ai_disclosure.acknowledged` per session).", { skip }, async () => {
  const PHONE = `+1602555${String(1000 + Math.floor(Math.random() * 8999))}${String(Math.floor(Math.random() * 10))}`.slice(0, 12);
  const sessionsChecked: string[] = [];
  /** Open one session on a channel and check its first assistant content and its two events. */
  const check = async (label: string, open: () => Promise<{ token: string; session_id: string; at: string; channel: "app" | "sms" | "voice" }>): Promise<void> => {
    const disclosedBefore = (await events(J.j.appId, "lead.disclosure.delivered")).length; const ackBefore = (await events(J.j.appId, "consent.ai_disclosure.acknowledged")).length;
    const beforeIds = new Set((await messagesOf(J.partyA)).map((m) => m.message_id));
    const s = await open(); await settle();
    const msgs = (await messagesOf(J.partyA)).filter((m) => !beforeIds.has(m.message_id) && m.sender !== "borrower");
    assert.ok(msgs.length >= 1, `${label}: the session produced assistant content`);
    assert.equal(msgs[0]!.body_text, "{{copy:entry.disclosure.first}}", `${label}: the disclosure is the first assistant content`); assert.equal(msgs[0]!.channel, s.channel, `${label}: on the session's channel`);
    assert.equal((await events(J.j.appId, "lead.disclosure.delivered")).length, disclosedBefore + 1, `${label}: lead.disclosure.delivered once for the session`);
    assert.equal((await events(J.j.appId, "consent.ai_disclosure.acknowledged")).length, ackBefore + 1, `${label}: consent.ai_disclosure.acknowledged once for the session`);
    const disclosed = (await events(J.j.appId, "lead.disclosure.delivered")).at(-1)!; const ack = (await events(J.j.appId, "consent.ai_disclosure.acknowledged")).at(-1)!;
    assert.ok(Date.parse(disclosed.occurred_at) <= Date.parse(msgs[0]!.at) + 1000 && Date.parse(ack.occurred_at) >= Date.parse(disclosed.occurred_at) - 1000);
    // the thread as the shell reads it: the first message of the session carries the automation marker (01 §7.1)
    const th = await thread(J.A, s.token); const first = th.messages.find((m) => m["message_id"] === msgs[0]!.message_id)!; assert.ok(first, `${label}: the disclosure is in the thread the shell reads`);
    assert.equal(first["automation_marker"], true, `${label}: automation marker on the first assistant message`);
    sessionsChecked.push(label);
  };
  const tokA = (await signIn(J.A)).token;
  // the phone the SMS sessions use (a fresh-L1 contact update — the party's own)
  const phone = await api("POST", "/v1/borrower/commands/party.updateContact", { phone: PHONE }, tokA); assert.equal(phone.status, 200, JSON.stringify(phone.body));
  // origination: app (a code by e-mail), SMS (a code by text), voice (the in-app call)
  await check("origination/app", async () => { const at = clock.now(); const s = await signIn(J.A); return { ...s, at, channel: "app" }; });
  await check("origination/sms", async () => { const at = clock.now(); const s = await signIn(PHONE, "sms"); assert.equal(s.party_id, J.partyA, "the code to the party's own phone opens the party's session"); return { ...s, at, channel: "sms" }; });
  const voiceA = await signIn(J.A); await settle();   // the call is placed from a signed-in party; the voice session is its own session (E1)
  await check("origination/voice", async () => { const at = clock.now(); const v = await api("POST", "/v1/borrower/voice/session", { application_id: J.j.appId }, voiceA.token); assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal((v.body["first_message"] as Json)["body_text"], "{{copy:entry.disclosure.first}}", "voice reads the disclosure first"); return { ...voiceA, at, channel: "voice" }; });
  // the journey to a serviced loan: lock, verification, decision, clear to close, closing, funding, boarding (the flows react to every step)
  await J.j.quoteForLock(); await J.j.requestLock(); await J.j.executeLockAndCommit(); await settle(); await snapshot("locked");
  await J.j.verifyDecideAndClear(); await J.j.clearToClose(); await settle(); await snapshot("clear_to_close");
  await J.j.scheduleClosing(); await J.j.closingDisclosure(); await J.j.closeAndSign(); await settle(); await snapshot("signed");
  await J.j.fund(); await settle(); J.j.loanId = await J.j.board(); await settle(); await snapshot("boarded"); await snapshot("loan", J.j.loanId);
  assert.ok(J.j.loanId, "a serviced loan");
  assert.ok((await assertConsentPrecedesEdelivery()) >= 2, "T-X-04 holds for every electronically delivered disclosure of the journey");
  // servicing sessions: the same three channels, the same first words, one acknowledgment per session
  const before = (await signIn(J.A)); const meR = await api("GET", "/v1/borrower/me", undefined, before.token); assert.ok((meR.body["subjects"] as Json[]).some((s) => s["loan_id"] === J.j.loanId), "the party's subjects include the serviced loan");
  await check("servicing/app", async () => { const at = clock.now(); const s = await signIn(J.A); return { ...s, at, channel: "app" }; });
  await check("servicing/sms", async () => { const at = clock.now(); const s = await signIn(PHONE, "sms"); return { ...s, at, channel: "sms" }; });
  const voiceB = await signIn(J.A); await settle();
  await check("servicing/voice", async () => { const at = clock.now(); const v = await api("POST", "/v1/borrower/voice/session", {}, voiceB.token); assert.equal(v.status, 200, JSON.stringify(v.body)); return { ...voiceB, at, channel: "voice" }; });
  assert.deepEqual(sessionsChecked, ["origination/app", "origination/sms", "origination/voice", "servicing/app", "servicing/sms", "servicing/voice"]);
  // every session of the party has its own acknowledgment: one per session_id in the API's own log, none shared
  const sessions = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE party_id = $1`, [J.partyA]);
  assert.ok(Number(sessions[0]!.n) >= 6);
  assert.ok((await events(J.j.appId, "consent.ai_disclosure.acknowledged")).length >= Number(sessions[0]!.n) - 2, "an acknowledgment per session (the two sign-ins of openApp included)");
});

test("32.13-T9: Money and rates — Given any rendered amount, then it is produced from cents via `Intl.NumberFormat` and any rate from a decimal string; no float arithmetic in the client.", { skip }, async () => {
  // the client: the money lint (scripts/lint-money.mts) and the formatter's contract
  const lint = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/lint-money.mts"], { cwd: APP_DIR, encoding: "utf8", timeout: 120_000 });
  assert.equal(lint.status, 0, `money lint:\n${lint.stdout}\n${lint.stderr}`);
  const fmt = readFileSync(`${APP_DIR}lib/format/index.ts`, "utf8");
  assert.ok(fmt.includes("Intl.NumberFormat"), "amounts format through Intl.NumberFormat"); assert.ok(!/parseFloat\(|toFixed\(|\bNumber\((value|cents|rate|amount)/.test(fmt), "no float parse or float formatting in the formatter"); assert.ok(/BigInt\(/.test(fmt), "cents are bigint");
  assert.ok(!/toFixed\(/.test(readFileSync(`${APP_DIR}lib/api/adapt.ts`, "utf8")), "the shell's adapter never formats a number");
  // the wire: every cents field is a decimal string of cents (or null), every rate a decimal string — never a JSON number, before and after funding
  const tok = (await signIn(J.A)).token;
  const l2 = await api("POST", "/v1/borrower/auth/l2", { ssn_last4: "6789", date_of_birth: "1985-06-15" }, tok); assert.equal(l2.status, 200, JSON.stringify(l2.body));   // 01 §5: personal terms render from L2
  const pre = await record(J.A, J.j.appId, tok); assert.ok(pre["numbers"], "the pre-funding numbers render at L2");
  const bodies = [pre, await record(J.A, J.j.loanId, tok), (await thread(J.A, tok)).body, ...SNAPSHOTS.map((s) => s.record)];
  let cents = 0; let rates = 0;
  for (const b of bodies) for (const leaf of leavesOf(b)) {
    if (/\.props\.|\.evidence\./.test(leaf.path)) continue;   // a card's opaque props may carry a display string a flow rendered (copy tokens); the shell prints them, never computes from them
    if (/_cents$/.test(leaf.key)) { cents++; assert.ok(leaf.value === null || (typeof leaf.value === "string" && /^-?\d+$/.test(leaf.value)), `${leaf.path} is cents as a decimal string: ${JSON.stringify(leaf.value)}`); }
    if (/(^|_)(rate|apr)(_pct)?$/.test(leaf.key) && !/status|source|note$/.test(leaf.key)) { rates++; assert.ok(leaf.value === null || (typeof leaf.value === "string" && /^-?\d+(\.\d+)?$/.test(leaf.value)), `${leaf.path} is a rate as a decimal string: ${JSON.stringify(leaf.value)}`); }
    assert.ok(!(typeof leaf.value === "number" && /cents|amount|rate|apr|balance|upb|payment|savings/.test(leaf.key)), `${leaf.path} is never a float on the wire`);
  }
  assert.ok(cents >= 5 && rates >= 1, `amounts and rates were rendered (${cents} cents fields, ${rates} rate fields)`);
  const post = await record(J.A, J.j.loanId, tok); const numbers = post["numbers"] as Json;
  assert.match(String(numbers["upb_cents"]), /^\d+$/); assert.match(String(numbers["note_rate"]), /^\d+\.\d+$/);
});

test("32.13-T2: No invented dates — Given any Dates row rendered, then its `timer_code` is in the 32.2 §4 allow-list and `due_at` equals `timers.due_at`.", { skip }, async () => {
  assert.ok(SNAPSHOTS.length >= 6, `snapshots across the journey (${SNAPSHOTS.map((s) => s.label).join(", ")})`);
  // the flows' own extra rows are registry timers, never invented codes
  const registry = new Set((JSON.parse(readFileSync(`${ROOT}spec/registry/timers.json`, "utf8")) as { code: string }[]).map((r) => r.code));
  const unregistered = [...FLOW_TIMER_LABELS.keys()].filter((code) => !registry.has(code));   // a label registered for a code the registry lacks can never arm (the engine arms registry codes only) — it must never render
  assert.equal(ALLOWED_TIMER_CODES.size, 42, "the 02 §4 allow-list: 42 codes");
  let rows = 0;
  for (const s of SNAPSHOTS) {
    const dates = s.record["dates"] as { timer_code: string; due_at: string; label: string; calendar: string; status: string }[];
    const next = s.record["next"] as { timer_code: string; due_at: string } | null;
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i - 1]!.due_at <= dates[i]!.due_at, `${s.label}: Dates rows are in due order`);
    for (const d of [...dates, ...(next ? [next] : [])]) {
      rows++;
      const code = d.timer_code;
      assert.ok(ALLOWED_TIMER_CODES.has(code) || code === "closings.scheduled_at", `${s.label}: ${code} is in the 32.2 §4 allow-list (02 §4 names closings.scheduled_at beside the codes)`);
      assert.ok(!unregistered.includes(code), `${s.label}: ${code} is a registry timer, never a flow's own label`);
      const armed = s.timers.filter((t) => t.code === code && (t.status === "armed" || t.status === "breached") && t.due_at);
      if (armed.length) assert.ok(armed.some((t) => t.due_at === new Date(d.due_at).toISOString()), `${s.label}: ${code} due_at ${d.due_at} equals timers.due_at (${armed.map((t) => t.due_at).join(", ")})`);
      else { const published = s.published[code]; assert.ok(published !== undefined && published !== null, `${s.label}: ${code} has no timers.due_at — only a condition-shaped gate whose date the owning process published (25.2 earliest_consummation_date, 25.3 expires_at, closings.scheduled_at) renders without one`); assert.equal(new Date(d.due_at).toISOString(), new Date(published).toISOString(), `${s.label}: ${code} renders the published date verbatim`); }
      if ("calendar" in d) { const row = d as unknown as { label: string; calendar: string }; assert.ok(row.label.length > 0 && row.calendar.length > 0); assert.ok(!/^per 32\./.test(row.label), "the label is the borrower's, never the registry's reference row"); }
    }
  }
  assert.ok(rows >= 8, `Dates rows measured (${rows})`);
  // the UI never computes a regulatory date: the shell's Dates/Next sections print `due_at` and nothing derived from it
  const sections = readFileSync(`${APP_DIR}components/record/sections.tsx`, "utf8");
  assert.ok(!/addDays|setDate\(|\+ *\d+ *\* *24|businessDay/.test(sections), "no date arithmetic in the Record sections");
});

// ═══════════════════════════════════ the shell on this API: a person, mobile parity
test("32.13-T8: Talk to a person — Given any screen, then a control emitting `human.request` is visible without scrolling; after `human.transfer.completed`, a `PersonCard{human_agent}` exists.", { skip }, async () => {
  const s = await signIn(J.A);
  const requested = async () => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM loan_events WHERE type = 'human.transfer.requested' AND (application_id = $1 OR loan_id = $2)`, [J.j.appId, J.j.loanId]))[0]!.n);
  const requestedBefore = await requested();
  // 32.16 §1 principle 8 (docs/ux/17, amended): there is NO "Talk to a person" control while no person exists — the borrower asks in words and
  // the same `human.request` command runs from the input bar (commands.ts: "human" → human.request → human.transfer.requested)
  const { page, ctx } = await openShell(s.token, 1280);
  assert.equal(await page.getByTestId("talk-to-person").count(), 0, "no Talk to a person control (32.16 §1 principle 8)");
  assert.ok(await inViewport(page, "action-bar"), "the input bar is in the viewport at 1280");
  await page.getByTestId("action-bar").locator("input[type=text], input:not([type])").first().fill("human"); await page.getByTestId("send").click(); await page.waitForTimeout(1500); await settle();
  assert.equal(await requested(), requestedBefore + 1, "the word emits human.request → human.transfer.requested");
  assert.ok(await inViewport(page, "action-bar"), "still in the viewport after the thread grew");
  // the person joins: 20.3's warm transfer on the session's interaction, then the delta op `human_joined` → human.transfer.completed
  const lead = await entity("leads", J.j.appId); const interactions = (lead?.["interactions"] as { interaction_id: string }[] | undefined) ?? [];
  leadInteraction = interactions.at(-1)!.interaction_id; assert.ok(leadInteraction, "the session opened a 20.3 interaction");
  const transfer = await J.j.tool({ app: J.j.appId }, "20.3", "deliverDisclosure", { op: "transfer_to_human", lead_id: J.j.appId, interaction_id: leadInteraction, reason: "consumer_request" });
  const joined = await J.j.tool({ app: J.j.appId }, "20.3", "deliverDisclosure", { op: "human_joined", lead_id: J.j.appId, interaction_id: leadInteraction, human_agent_id: HUMAN_AGENT.id, human_agent_name: "Sam", escalation_id: transfer.output["escalation_id"] }, HUMAN_AGENT);
  assert.ok(joined.events.some((e) => e.type === "human.transfer.completed"), JSON.stringify(joined.events.map((e) => e.type)));
  const completed = (await events(J.j.appId, "human.transfer.completed")).at(-1)!; assert.equal(completed.payload["human_agent_name"], "Sam"); assert.equal(completed.payload["interaction_id"], leadInteraction);
  await settle();
  const person = (await cardsOf(J.partyA, `AND kind = 'PersonCard'`)).filter((c) => c.props["role"] === "human_agent" && c.props["name"] === "Sam");
  assert.equal(person.length, 1, "PersonCard{human_agent} for the person who joined"); assert.equal(person[0]!.copy_key, "person.human_agent"); assert.equal(person[0]!.status, "resolved", "no action: filed as read");
  assert.equal((await cardsOf(J.partyB, `AND kind = 'PersonCard'`)).filter((c) => c.props["role"] === "human_agent" && c.props["name"] === "Sam").length, 1, "the co-borrower sees the same person");
  await page.reload({ waitUntil: "load" }); await page.waitForSelector('[data-testid="thread"] .sm-msg', { timeout: 30_000 });
  // 32.16 §2.2: the person's card lives under People on the rail (expanded on click); the thread carries its reference
  await expandRail(page, person[0]!.card_instance_id);
  const card = page.locator('article[data-card-kind="PersonCard"]', { hasText: "Sam" }); assert.ok((await card.count()) >= 1, "the PersonCard for the person who joined renders in the shell (beside 32.5's pending-name card)");
  assert.match(await card.first().innerText(), /A person on your loan/);
  assert.equal(await page.getByTestId("talk-to-person").count(), 0);
  await ctx.close();
  // 390: no control either; the input bar in the viewport, with the status strip
  const m = await openShell(s.token, 390);
  assert.equal(await m.page.getByTestId("talk-to-person").count(), 0, "no Talk to a person control at 390");
  assert.ok(await inViewport(m.page, "action-bar"), "the input bar is in the viewport at 390");
  assert.ok(await m.page.getByTestId("status-strip").isVisible());
  await m.ctx.close();
  // the serviced loan: 11.3's contact log records the transfer to a person (the platform's `human_transferred`) — the same PersonCard on the loan
  const logged = await J.j.tool({ loan: J.j.loanId }, "11.3", "contact.log", { loan_id: J.j.loanId, mode: "human_voice", direction: "inbound", outcome: "human_transferred", party_id: J.partyA }, BORROWER_COMMS);
  assert.ok(logged.events.some((e) => e.type === "contact.logged")); await settle();
  assert.ok((await cardsOf(J.partyA, `AND kind = 'PersonCard'`)).some((c) => c.props["role"] === "human_agent" && c.subject_loan_id === J.j.loanId), "PersonCard{human_agent} on the serviced loan");
});

test("32.13-T10: Mobile parity — Given every card kind at 390 px, then it is operable and the status strip shows badge, next event and the needed-from-you count.", { skip }, async () => {
  // every 01 §3 card kind, seeded for the co-borrower through 32.1 with the props the components render (the vitest fixtures of apps/borrower/tests/cards)
  const KINDS: [string, string, Json, string | null][] = [
    ["StatusCard", "status.title", { state_label: "Application received Oct 20, 2026", next_event_label: "Your Loan Estimate arrives by", next_event_at: "2026-10-23T23:59:59-07:00" }, null],
    ["ChoiceCard", "entry.goal.question", { title: "Loan type", options: [{ id: "fixed_30", label: "30-year fixed", is_primary: true }, { id: "arm", label: "Adjustable" }], command: "application.setGoal", command_args_by_option: { fixed_30: {}, arm: {} } }, "application.setGoal"],
    ["ConfirmCard", "profile.title", { title: "Your home — right?", fields: [{ path: "application_properties.estimated_value", label: "Estimated value", value: "$712,000.00", source: "avm" }], commits_to: "application_properties.estimated_value" }, "application.confirmField"],
    ["ConnectCard", "income.connect.purpose", { vendor: "truv_income", vendor_fake: "FAKE", purpose_text: "Connect your payroll", what_we_get: ["employer"], fallback: { label: "Send paystubs instead" }, state: "not_started" }, "verification.connect"],
    ["ConsentCard", "consent.esign.title", { consent_kind: "esign", disclosure_version_id: "cdv-esign-3", scope: ["origination_disclosures"], affirmation_method: "checkbox_with_text", title: "Get your documents electronically", body_text: "E-SIGN statement…", footer_text: "Saying yes in chat or on a call doesn't count — check the box and type your name.", requires_typed_name: true, verification_state: "none" }, "consent.capture"],
    ["DocumentCard", "le.delivered", { document_id: randomUUID(), disclosure_id: `disc-${randomUUID().slice(0, 8)}`, notice_code: "NTC_REGZ_1026_37_LE", title: "Your Loan Estimate", why_you_see_this: "Confirming receipt starts the timeline.", requires_ack: true, esign_scope_required: "origination_disclosures", channel: "mail", mailed_at: clock.now() }, "disclosure.acknowledgeReceipt"],   // a mailed copy: stands on its mailing evidence (T-X-04 needs no consent for it)
    ["ComparisonCard", "lock.compare", { title: "Lock or float", columns: [{ id: "lock", title: "Lock now", rows: [{ label: "Rate", value: "6.125%" }, { label: "Payment", value: "$3,402.62" }] }, { id: "float", title: "Keep floating", rows: [{ label: "Rate", value: "6.250%" }, { label: "Payment", value: "$3,448.10" }] }], recommended_id: "lock", command: "lock.request", command_args_by_option: { lock: {}, float: {} }, secondary_option: { id: "float", label: "Keep floating" } }, "lock.request"],
    ["ChecklistCard", "needs.title", { title: "Conditions", items: [{ id: "c1", label: "Two pay stubs", status: "open", owner: "you" }, { id: "c2", label: "Title commitment", status: "done", owner: "us" }] }, null],
    ["UploadCard", "income.upload.fallback", { document_class: "paystub", accepted_examples: ["pay stub", "W-2"], why: "We need your income documents.", freshness_hint: "last 30 days" }, "document.upload"],
    ["ExplanationCard", "credit.inquiry.explain", { subject: "Inquiry from a credit union on Sep 3", prompt: "Did it result in a new account?", min_length: 10 }, "explanation.submit"],
    ["ScheduleCard", "closing.schedule.title", { purpose: "ron_session", title: "Pick your signing time", slots: [{ id: "s1", starts_at: "2026-11-06T10:00:00-07:00", ends_at: "2026-11-06T10:30:00-07:00" }, { id: "s2", starts_at: "2026-11-06T14:00:00-07:00", ends_at: "2026-11-06T14:30:00-07:00" }] }, "closing.selectSlot"],
    ["PaymentCard", "payment.title", { mode: "one_time", amount_default_cents: "318234", amount_editable: true, date_options: ["2026-12-11", "2026-12-16"], accounts: [{ id: "a1", last4: "4417", label: "Checking" }], add_account: true }, "payment.makeOneTime"],
    ["InviteCard", "invite.title", { party_role: "co_borrower", title: "Add a co-borrower", contact_fields: ["first_name", "email"] }, "application.inviteParty"],
    ["HandoffCard", "closing.handoff.ron", { destination: "ron_platform", what_to_expect: "About 15–20 minutes with a notary.", return_state: "Signed" }, null],
    ["OfferCard", "offer.title", { refi_opportunity_id: randomUUID(), current_rate: "7.000", offered_rate: "6.125", apr: "6.201", new_pi_payment_cents: "340262", monthly_savings_cents: "37630", costs_to_borrower_cents: "0", lender_legal_name: "Partner Bank", mlo_name: "Jordan Rivera", mlo_nmlsr_id: "987654", expires_at: "2027-03-01T00:00:00-07:00", not_a_commitment_text: "This is not a commitment to lend;", rates_change_daily_text: "rates change daily." }, "offer.respond"],
    ["NoticeCard", "decision.noia", { notice_code: "NTC_REGB_1002_9_NOIA", title: "What's missing", rendered_document_id: randomUUID(), plain_language: "We need the items in this notice by Nov 3, 2026.", template_version: "v2", channel: "mail", mailed_at: "2026-10-22T00:00:00-07:00" }, null],
    ["PersonCard", "team.assigned", { role: "continuity_of_contact_team", name: "Team Saguaro", reach: "(602) 555-0142" }, null],
    ["ProfileCard", "profile.title", { title: "A few things only you can tell us.", fields: [{ path: "citizenship", label: "Citizenship", required: true, options: [{ id: "us", label: "U.S. citizen" }, { id: "pr", label: "Permanent resident" }] }, { path: "dependents", label: "Dependents", required: true, input: "number" }] }, "application.confirmField"],
    ["DemographicsCard", "demographics.title", { collection_method: "internet", statement_text: "The prescribed statement.", ethnicity: [{ id: "hispanic", label: "Hispanic or Latino" }, { id: "not_hispanic", label: "Not Hispanic or Latino" }], race: [{ id: "asian", label: "Asian" }, { id: "white", label: "White" }], sex: [{ id: "female", label: "Female" }, { id: "male", label: "Male" }], available: true }, "application.answerDemographics"],
  ];
  const ids = new Map<string, string>();
  for (const [kind, copyKey, props, ref] of KINDS) ids.set(kind, await sendCard(J, J.partyB, kind, copyKey, props, ref));
  assert.equal(ids.size, 19, "every 01 §3 card kind");
  const s = await signIn(J.B); const rec = await record(J.B, J.j.appId, s.token);
  const { page, ctx } = await openShell(s.token, 390);
  // the status strip: badge, next event, the needed-from-you count — the record's own numbers
  const strip = page.getByTestId("status-strip"); assert.ok(await strip.isVisible(), "the status strip at 390");
  assert.equal((await strip.getByTestId("status-badge").innerText()).trim().replace(/^[^\w]+/, ""), String((rec["status"] as Json)["badge"]));
  const nextText = (await strip.getByTestId("strip-next").innerText()).trim(); const next = rec["next"] as Json | null;
  if (next) assert.ok(nextText.includes(String(next["label"])), `next event on the strip: ${nextText}`); else assert.equal(nextText, "Nothing scheduled");
  assert.match((await strip.getByTestId("strip-count").innerText()).trim(), new RegExp(`^${(rec["needed_from_you"] as unknown[]).length} `), "the needed-from-you count on the strip");
  // every card rendered (the 32.13 boundary would name any that could not), no horizontal scroll anywhere; every card kind inside 390 px and operable: its control is enabled (or the card is informational and visible)
  assert.deepEqual(await page.locator('[data-testid="card-error"]').evaluateAll((els: unknown[]) => (els as { getAttribute(n: string): string | null }[]).map((e) => `${e.getAttribute("data-card-kind")}: ${e.getAttribute("data-error")}`)), [], "every card renders");
  assert.ok(await page.evaluate<boolean>("document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390"), "the page never scrolls sideways");
  const INFORMATIONAL = new Set(["StatusCard", "NoticeCard", "PersonCard", "HandoffCard", "ChecklistCard"]);
  // 32.16 §2.2: on a phone the bottom sheet is the rail — every card kind has a row there; expanding it renders the component
  await strip.click(); await page.waitForSelector('[data-testid="record"][data-open="true"]', { timeout: 15_000 });
  for (const [kind] of KINDS) await expandRail(page, ids.get(kind)!);
  for (const [kind] of KINDS) {
    const article = page.locator(`article[data-card-id="${ids.get(kind)!}"]`).first();
    assert.ok((await page.locator(`article[data-card-id="${ids.get(kind)!}"]`).count()) >= 1, `${kind} renders`); await article.waitFor({ timeout: 15_000 });
    const box = await article.boundingBox(); assert.ok(box && box.x >= 0 && box.width > 0 && box.x + box.width <= 390 + 1, `${kind} fits 390 px (${JSON.stringify(box)})`);
    const controls = await article.locator("button:not([disabled]), a[href], input:not([disabled]):not([type=file]), select:not([disabled]), textarea:not([disabled])").count();
    if (!INFORMATIONAL.has(kind)) assert.ok(controls >= 1, `${kind} is operable at 390 (an enabled control)`);
    else assert.ok(await article.isVisible(), `${kind} is visible`);
    if (!INFORMATIONAL.has(kind)) { const ctl = article.locator("button:not([disabled]), a[href], input:not([disabled]):not([type=file]), select:not([disabled]), textarea:not([disabled])").first(); const cb = await ctl.boundingBox(); assert.ok(cb && cb.x >= 0 && cb.x + cb.width <= 390 + 1 && cb.height >= 16, `${kind}'s control is reachable (${JSON.stringify(cb)})`); }
  }
  // the sheet (opened above by the strip) carries the rail's sections
  assert.ok(await page.locator('[data-testid="record"] [data-record-section="status"]').isVisible());
  await ctx.close();
});

// ═══════════════════════════════════ the end of every road: read-only, then nothing needed
test("32.13-T16: Read-only after terminal — Given `denied | withdrawn | closed_incomplete | rescinded | paid_in_full → closed | transferred_out`, then no command except `case.open`, `human.request`, document download and contact update succeeds.", { skip }, async () => {
  const APP_REFUSED = ["intent.record", "document.upload", "application.confirmField", "lock.request", "consent.capture"]; const LOAN_REFUSED = ["payment.makeOneTime", "refi.request", "escrow.requestWaiver", "lossmit.requestAssistance", "document.upload"];
  const decisionFile = (A: string, B: string) => ({ partner_name: "Partner Bank", partner_address: "100 Partner Plaza, Phoenix, AZ 85004", creditor_time_zone: "America/Phoenix", application_date: "2026-10-05", property_state: "AZ",
    applicants: [{ id: "B1", name: "Alex Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: A, esign_consent: true, primary: true }, { id: "B2", name: "Blake Borrower", mailing_address: "100 N Central Ave, Phoenix AZ 85004", email: B, esign_consent: true, primary: false }],
    lock_id: null, original_terms: { loan_amount_cents: "56000000", note_rate: "6.125", product_code: "FNMA30", ltv: "70.0" } });
  // withdrawn — the borrower's express statement, disposed by 21.6 (`decision.issued{kind: withdrawal}`); then the Record is read-only
  W = await openApp();
  clock.set(MST("2026-10-12", "09:00"));
  const wd = await W.j.tool({ app: W.j.appId }, "21.6", "writeDecision", { ...decisionFile(W.A, W.B), op: "withdrawal", withdrawal_id: `WD-${W.j.R}`, statement_text: "I withdraw my application", channel: "portal", received_at: clock.now() }, UNDERWRITER);
  assert.ok(wd.events.some((e) => e.type === "application.withdrawn"), JSON.stringify(wd.events.map((e) => e.type))); await settle();
  assert.ok((await events(W.j.appId, "decision.issued")).some((e) => e.payload["kind"] === "withdrawal"), "21.6 disposed the file");
  await assertReadOnly(W.A, { application_id: W.j.appId }, APP_REFUSED, "withdrawn");
  assert.equal((await record(W.A, W.j.appId))["read_only"], true);
  // denied — 21.6's decision, reviewer, adverse action notice
  const D = await openApp(); const DEC = `D-${D.j.R}`;
  clock.set(MST("2026-10-23", "09:40"));
  await D.j.tool({ app: D.j.appId }, "21.6", "recommendDisposition", { ...decisionFile(D.A, D.B), decision_id: DEC, factors: [{ rule_id: "dti_max_50", description: "Debt-to-income ratio above the program maximum", threshold: "50.0", observed: "51.3", applicant_ids: ["B1"], evidence_document_ids: ["doc-paystub-1020"], failed: true, source: "rules" }], du_recommendation: "refer_with_caution", data_verified_and_resubmitted: true }, UNDERWRITER);
  clock.set(MST("2026-10-26", "11:05")); await D.j.tool({ app: D.j.appId }, "21.6", "openReviewerEscalation", { op: "decide", decision_id: DEC, outcome: "approved" }, REVIEWER);
  const SCORES = { borrower_id: "B1", score_model: "classic_fico", date: "2026-10-05", range: { min: 300, max: 850 }, applicable_score: 712, scores: [{ repository: "efx", bureau: "Equifax", score: 705, model_version: "Equifax Beacon 5.0", key_factors: ["Serious delinquency"], inquiries_key_factor: false }, { repository: "exp", bureau: "Experian", score: 712, model_version: "Experian/Fair Isaac Risk Model V2", key_factors: ["Serious delinquency"], inquiries_key_factor: false }, { repository: "tu", bureau: "TransUnion", score: 720, model_version: "TransUnion FICO Risk Score, Classic 04", key_factors: ["Serious delinquency"], inquiries_key_factor: false }] };
  const SCORES_B2 = { ...SCORES, borrower_id: "B2", applicable_score: 720 };
  const rn = await D.j.tool({ app: D.j.appId }, "21.6", "renderNotice", { decision_id: DEC, score_payloads: [SCORES, SCORES_B2], notice_date: "2026-10-26" }, UNDERWRITER);
  clock.set(MST("2026-10-26", "11:30")); const sent = await D.j.tool({ app: D.j.appId }, "21.6", "deliverNotice", { decision_id: DEC, notice_ids: rn.output["notice_ids"], score_payloads: [SCORES, SCORES_B2] }, UNDERWRITER);
  assert.ok(sent.events.some((e) => e.type === "decision.issued" && (e.payload as Json)["kind"] === "denial"), JSON.stringify(sent.events.map((e) => e.type))); await settle();
  await assertReadOnly(D.A, { application_id: D.j.appId }, APP_REFUSED, "denied");
  const dRec = await record(D.A, D.j.appId); assert.equal(dRec["read_only"], true); assert.ok((dRec["documents"] as Json[]).length >= 1, "the decision letter stays downloadable");
  // closed incomplete — 21.6's NOIA, the designated period runs out
  const N = await openApp(); const DN = `D-N-${N.j.R}`; const NOIA = `NOIA-${N.j.R}`;
  const items = [{ item: "tax_returns_2025", description: "Signed 2025 federal tax returns (all schedules)" }, { item: "ytd_pl", description: "Year-to-date profit and loss statement" }];
  clock.set(MST("2026-10-26", "07:00"));
  await N.j.tool({ app: N.j.appId }, "21.6", "recommendDisposition", { ...decisionFile(N.A, N.B), decision_id: DN, factors: [], noia_recommendation: { missing: [{ request_id: "R-1", doc_class: "tax_returns_2025", reason_text: items[0]!.description }, { request_id: "R-2", doc_class: "ytd_pl", reason_text: items[1]!.description }], hand_off: "21.6", response_period_days: 14 } }, UNDERWRITER);
  clock.set(MST("2026-10-27", "07:00")); await N.j.tool({ app: N.j.appId }, "21.6", "openReviewerEscalation", { op: "decide", decision_id: DN, outcome: "approved" }, REVIEWER);
  const noia = await N.j.tool({ app: N.j.appId }, "21.6", "renderNotice", { decision_id: DN, noia_id: NOIA, items_needed: items, designated_period_days: 14, oral_request_at: "2026-10-23T15:00:00.000Z", notice_date: "2026-10-27" }, UNDERWRITER);
  clock.set(MST("2026-10-27", "08:00")); await N.j.tool({ app: N.j.appId }, "21.6", "deliverNotice", { op: "noia", decision_id: DN, noia_id: NOIA, notice_ids: noia.output["notice_ids"], items_needed: items, designated_period_days: 14, oral_request_at: "2026-10-23T15:00:00.000Z" }, UNDERWRITER);
  clock.set("2026-11-11T14:00:00.000Z"); const closed = await N.j.tool({ app: N.j.appId }, "21.6", "writeDecision", { op: "close_incomplete", noia_id: NOIA }, UNDERWRITER);
  assert.ok(closed.events.some((e) => e.type === "application.closed_incomplete"), JSON.stringify(closed.events.map((e) => e.type))); await settle();
  await assertReadOnly(N.A, { application_id: N.j.appId }, APP_REFUSED, "closed_incomplete");
  // rescinded — 25.3's period and an exercise inside it
  const Rz = await openApp();
  const CONSUMERS = [{ consumer_id: "C-B", role: "borrower", ownership_interest: true, occupancy: "primary" }, { consumer_id: "C-S", role: "non_borrower_owner", ownership_interest: true, occupancy: "primary", ownership_basis: "spouse on title" }];
  clock.set("2026-11-06T17:35:00.000Z");
  await Rz.j.tool({ app: Rz.j.appId }, "25.3", "determineRescindability", { application_id: Rz.j.appId, transaction_type: "limited_cash_out", consumers: CONSUMERS, partner_id: "partner-1", existing_loan: { original_creditor_id: "L-OTHER-2021", upb_cents: "54820000", earned_unpaid_finance_charge_cents: "210055", refinancing_costs_cents: "795000" }, amount_financed_cents: "55615005" }, DISCLOSURE);
  const period = await Rz.j.tool({ app: Rz.j.appId }, "25.3", "computeRescissionPeriod", { application_id: Rz.j.appId, consummation_at: "2026-11-06T17:30:00.000Z", time_zone: "America/Phoenix", notice_deliveries: CONSUMERS.map((c) => ({ consumer_id: c.consumer_id, delivered_at: "2026-11-06T17:30:00.000Z", channel: "in_person", copies: 2, evidence_document_id: `DOC-RON-${c.consumer_id}` })), material_disclosures: CONSUMERS.map((c) => ({ consumer_id: c.consumer_id, cd_version: 1, effective_receipt_date: "2026-11-02", accurate: true })), material_disclosures_accurate: true }, DISCLOSURE);
  assert.ok(period.events.some((e) => e.type === "rescission.period.started"));
  clock.set("2026-11-09T18:00:00.000Z");
  const ex = await Rz.j.tool({ app: Rz.j.appId }, "25.3", "sweepInboundForRescission", { application_id: Rz.j.appId, op: "record_exercise", exercise_id: `X-${Rz.j.R}`, consumer_id: "C-B", method: "email", received_at: "2026-11-09T18:00:00.000Z", document_id: `DOC-RESCIND-${Rz.j.R}`, written: true }, DISCLOSURE);
  assert.ok(ex.events.some((e) => e.type === "rescission.exercised"), JSON.stringify(ex.events.map((e) => e.type))); await settle();
  await assertReadOnly(Rz.A, { application_id: Rz.j.appId }, APP_REFUSED, "rescinded");
  assert.equal((await record(Rz.A, Rz.j.appId))["read_only"], true);
  // paid in full → closed: the main journey's loan is purchased, paid, then paid off (2.x → 16.x)
  await J.j.deliverAndPurchase(); await J.j.firstPayment(); await settle(); await snapshot("paying", J.j.loanId);
  await J.j.payoff(); await settle();
  assert.ok((await loanEvents(J.j.loanId, "loan.paid_in_full")).length >= 1);
  assert.equal((await db.query<{ status: string }>(`SELECT status::text AS status FROM loans WHERE id = $1`, [J.j.loanId]))[0]!.status, "paid_off");
  assert.equal((await cardsOf(J.partyA, `AND status = 'pending'`)).length + (await cardsOf(J.partyB, `AND status = 'pending'`)).length, 0, "nothing pending once the loan is paid in full (32.13 flow)");
  await assertReadOnly(J.A, { loan_id: J.j.loanId }, LOAN_REFUSED, "paid_in_full"); await assertReadOnly(J.A, { application_id: J.j.appId }, APP_REFUSED, "paid_in_full (the application it came from)");
  const paid = await snapshot("paid_off", J.j.loanId); assert.equal((paid["status"] as Json)["badge"], "Paid off");
  // transferred out — nothing in 1–31 sets loans.status = transferred_out (17.1's cutover is batch-level; docs/ux/BACKEND-DELTAS.md §6): the harness sets the column the guard reads
  await db.query(`UPDATE loans SET status = 'transferred_out' WHERE id = $1`, [J.j.loanId]);
  await assertReadOnly(J.A, { loan_id: J.j.loanId }, LOAN_REFUSED, "transferred_out"); await assertReadOnly(J.A, { application_id: J.j.appId }, APP_REFUSED, "transferred_out (the application it came from)");
  const gone = await record(J.A, J.j.loanId); assert.ok(["Closed", "Paid off"].includes(String((gone["status"] as Json)["badge"])), JSON.stringify(gone["status"]));
});

test("32.13-T15: Nothing-needed — Given zero `owner=you` items, then the nothing-needed state renders and no reminder is sent.", { skip }, async () => {
  // the withdrawn application of T16: read-only, so nothing is owed by the borrower — zero owner=you items; the paid-off loan's Record is measured the same way
  assert.ok(W, "T16 opened the withdrawn application");
  const s = await signIn(W.A); const rec = await record(W.A, W.j.appId, s.token);
  assert.deepEqual(rec["needed_from_you"], [], "zero owner=you items"); const summary = rec["needed_summary"] as Json; assert.equal(summary["count"], 0); assert.equal(summary["nothing_needed"], true); assert.equal(summary["copy_key"], "needs.none");
  assert.equal(rec["read_only"], true, "the Record is read-only (32.13 T16): nothing is needed from the borrower");
  // no reminder: two daily passes of every flow send nothing to the party — no message, no card
  const msgs = (await messagesOf(W.partyA)).length; const cards = (await cardsOf(W.partyA)).length; const now = clock.now();
  await tick(new Date(Date.parse(now) + 24 * 3600 * 1000).toISOString()); await tick(new Date(Date.parse(now) + 48 * 3600 * 1000).toISOString());
  clock.set(now);   // back to the session's own day (a session idles out across the two passes)
  assert.equal((await messagesOf(W.partyA)).length, msgs, "no reminder line"); assert.equal((await cardsOf(W.partyA)).length, cards, "no reminder card");
  assert.deepEqual((await record(W.A, W.j.appId, s.token))["needed_from_you"], []);
  // the shell renders the nothing-needed state from the copy library, and the strip counts zero
  const needsNone = copyEntries().find((e) => e.key === "needs.none"); assert.ok(needsNone?.text, "needs.none is authored");
  const { page, ctx } = await openShell(s.token, 1280);
  const none = page.getByTestId("needs-none"); await none.waitFor({ timeout: 30_000 });
  assert.equal((await none.innerText()).trim(), needsNone.text.trim());
  assert.equal(await page.locator('[data-testid="waiting-on-you"]').count(), 0, "no waiting-on-you line (32.16 §2.1)"); assert.equal(await page.locator('[data-testid="record"] [data-record-section="needed"] [data-rail-card]').count(), 0, "no row under Needed from you");
  await ctx.close();
  const m = await openShell(s.token, 390); assert.match((await m.page.getByTestId("strip-count").innerText()).trim(), /^0 /); await m.ctx.close();
});
