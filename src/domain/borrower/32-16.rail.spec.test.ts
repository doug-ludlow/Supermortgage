// 32.16 The conversational product — Phase 2, the rail (docs/ux/17 §2.1–2.3, DELTA-26): 32.16-T11 … 32.16-T16
// spec/sections/32-borrower-experience/32-16-the-conversational-product-an-account-then-a-conversation-wi.md
// One node:test per T-id, named exactly as the spec (the Phase 0/1/3/4 T-ids live in 32-16.spec.test.ts, which another
// builder owns; this file holds the Phase 2 tests so the two can be worked on side by side).
//
// The harness is 32.13's: one runtime over HTTP, the Journey fixture driven to R8 (application → interview → credit → DU
// findings interpreted; the LE only for T15), the 32.x flows reacting to the committed events, read the way the shell reads
// it (the borrower API: record, thread, cards), plus the shell itself — the built Next.js app (apps/borrower, `.next-t13`,
// shared with 32.13 and rebuilt when its sources are newer) pointed at this test's API through its proxy and driven with
// Playwright's Chromium from /opt/pw-browsers at 1280 (≥ 1024: the rail beside the thread) and 390 px (the status strip and
// the bottom sheet). Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { deliverLeByConsent } from "../../runtime/borrower/flows/3-entry.ts";
import { REFINANCE_STEPS, journeyProgress } from "../../runtime/borrower/journey-progress.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const INTAKE = { kind: "agent" as const, id: "intake" };
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APP_DIR = `${ROOT}apps/borrower/`; const DIST = ".next-t13"; const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
type Json = Record<string, unknown>;

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
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]))[0]!.id;
});
test.after(async () => { if (!skip) { await stopShell(); await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- the borrower API and the flows (32.13's helpers)
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
}
async function signIn(destination: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
const settle = () => router.flows!.settle();
const record = async (token: string, subject: string): Promise<Json> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (token: string): Promise<{ messages: Json[]; pinned_card: Json | null }> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body as { messages: Json[]; pinned_card: Json | null }; };
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: Json; evidence: Json | null; command_ref: string | null; created_at: string; resolved_at: string | null; subject_application_id: string | null; subject_loan_id: string | null }
const cardsOf = async (partyId: string, where = ""): Promise<CardRow[]> => { await settle(); return db.query<CardRow & Record<string, unknown>>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at, subject_application_id, subject_loan_id FROM card_instances WHERE party_id = $1 ${where} ORDER BY created_at`, [partyId]); };
interface App { j: Journey; A: string; B: string; partyA: string; partyB: string }
/** One application on the shared runtime: its own journey (prior loan, lead, borrowers with e-mails), both borrowers signed in, the 21.1 interview done. */
async function openApp(): Promise<App> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await settle();
  return { j, A, B, partyA, partyB };
}
/** Cards through 32.1's `send_card` as the intake agent (the flows' own seam), with the props the components render. */
async function sendCard(app: App, partyId: string, kind: string, copy_key: string, props: Json, command_ref: string | null = null): Promise<string> {
  const r = await runtime.execute({ process: "32.1", name: "send_card", loanId: "", applicationId: app.j.appId, actor: INTAKE, run: { runId: "test:32.16", modelVersion: "harness", promptVersion: "32.16" },
    input: { party_id: partyId, kind, copy_key, props: { ...props, flow_key: `t16:${kind}:${randomUUID().slice(0, 8)}`, flow: "32.16-harness" }, command_ref, subject: { application_id: app.j.appId }, created_by: "agent:intake", rationale: `32.16 harness ${kind}` } });
  await settle(); return (r.output as { card_instance_id: string }).card_instance_id;
}
/** The party's pending E-SIGN ConsentCard, affirmed by tap and demonstrated through 20.3 (the 32.4-T1 path) — the row turns active on `consent.esign.active`. */
async function consentEsign(app: App, email: string, partyId: string, typedName: string): Promise<string> {
  const card = (await cardsOf(partyId, `AND kind = 'ConsentCard' AND status = 'pending'`)).find((c) => c.copy_key === "consent.esign.title" || c.props["consent_kind"] === "esign");
  assert.ok(card, `an E-SIGN ConsentCard is pending for ${email}`);
  const tok = (await signIn(email)).token;
  const r = await api("POST", `/v1/borrower/cards/${card.card_instance_id}/resolve`, { evidence: { affirmation_method: "checkbox_with_text", typed_name: typedName, checkbox: true, disclosure_version_shown: card.props["disclosure_version_id"] } }, tok);
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 600));
  const consentId = String((r.body["result"] as Json)["consent_id"]);
  const at = clock.now();
  await app.j.tool({ app: app.j.appId }, "20.3", "captureConsent", { lead_id: app.j.appId, kind: "esign", op: "demonstrate", consent_id: consentId, link_opened_at: at, token_entered_at: at, token_ok: true });
  await settle();
  return consentId;
}
/** The wire's cents strings → bigint cents, as the API server revives request bodies (src/runtime/server.ts). */
function reviveCents(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveCents);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, k.endsWith("_cents") && (typeof x === "string" || typeof x === "number") && x !== "" ? BigInt(x) : reviveCents(x)]));
  return v;
}

// ---------------------------------------------------------------- the shell: the built Next.js app on this test's API, driven with Playwright
interface Locator { getByTestId(id: string): Locator; getByRole(role: string, o?: { name?: string | RegExp }): Locator; locator(sel: string, o?: { hasText?: string | RegExp }): Locator; allInnerTexts(): Promise<string[]>; evaluateAll<T>(fn: (els: unknown[]) => T): Promise<T>; count(): Promise<number>; first(): Locator; nth(i: number): Locator; click(o?: object): Promise<void>; fill(v: string): Promise<void>; check(): Promise<void>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>; textContent(): Promise<string | null>; innerText(): Promise<string>; isVisible(): Promise<boolean>; getAttribute(name: string): Promise<string | null>; waitFor(o?: { timeout?: number; state?: string }): Promise<void> }
interface Page { on(event: string, fn: (x: { text(): string; message?: string }) => void): void; goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>; reload(o?: { waitUntil?: string }): Promise<unknown>; locator(sel: string, o?: { hasText?: string | RegExp }): Locator; getByTestId(id: string): Locator; getByRole(role: string, o?: { name?: string | RegExp }): Locator; evaluate<T>(fn: string): Promise<T>; viewportSize(): { width: number; height: number } | null; waitForSelector(sel: string, o?: { timeout?: number; state?: string }): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; content(): Promise<string>; close(): Promise<void>; screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown> }
interface Context { addCookies(c: object[]): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }
interface Browser { newContext(o: object): Promise<Context>; close(): Promise<void> }
let appProc: ChildProcess | null = null; let appBase = ""; let browser: Browser | null = null; let appLog = "";
function newestSource(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) { if (name === "node_modules" || name.startsWith(".next") || name === "tests" || name === "playwright-report" || name === "test-results") continue; const p = `${dir}/${name}`; const st = statSync(p); if (st.isDirectory()) newest = Math.max(newest, newestSource(p)); else if (/\.(ts|tsx|css|json|mjs|mts)$/.test(name)) newest = Math.max(newest, st.mtimeMs); }
  return newest;
}
/** The standalone build in `.next-t13` (an env-driven distDir so it never collides with the app's own `.next`), rebuilt when a source is newer — shared with 32.13's harness. */
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
async function inViewport(page: Page, sel: string): Promise<boolean> {
  const box = await page.locator(sel).first().boundingBox(); const vp = page.viewportSize()!;
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
}
/** The shell rendered from this test's API: the shell region, the conversation with at least one line, the rail with Needed from you. */
async function openShell(token: string, width: number, path = "/app"): Promise<{ page: Page; ctx: Context }> {
  const p = await pageFor(token, width, path);
  await p.page.waitForSelector('[data-testid="shell"]', { timeout: 30_000 });
  try { await p.page.waitForSelector('[data-testid="thread"] .sm-msg', { timeout: 30_000 }); await p.page.waitForSelector('[data-testid="record"] [data-record-section="needed"]', { timeout: 30_000, state: "attached" }); }
  catch (e) { const notice = await p.page.locator(".sm-error").allInnerTexts().catch(() => [] as string[]); throw new Error(`the shell did not render the thread: ${String(e)}; notices=${JSON.stringify(notice)}; logs=${JSON.stringify((p.page as Page & { logs?: string[] }).logs?.slice(-10))}; app=${appLog.slice(-800)}`); }
  return p;
}
const railRow = (page: Page, cardId: string): Locator => page.locator(`[data-testid="record"] [data-rail-card="${cardId}"]`).first();
async function expandRail(page: Page, cardId: string): Promise<void> { const row = railRow(page, cardId); await row.waitFor({ timeout: 30_000, state: "attached" }); if ((await row.getAttribute("data-expanded")) !== "true") await row.locator("> button").click(); }
const SCREENSHOTS = `${ROOT}apps/borrower/test-results/32-16-rail`;

// ---------------------------------------------------------------- the refinance journey at R8 (App J)
let J: App; let tokA = ""; let recordR8: Json;
// the journey moves the clock by days between phases and sessions idle out after 30 minutes (01 §5): every test signs Alex in afresh
const fresh = async (): Promise<string> => { tokA = (await signIn(J.A)).token; return tokA; };

test("32.16-T13: Given the refinance fixture at R8, then `journey_progress` shows E1–R7 `done`, R8 `current`, and Progress renders \"7 of 12\".", { skip }, async () => {
  // the journey fixture to R8: the application (E1–E6 are the door: the lead, the disclosure, the goal, the identified and verified borrowers, the consents), the 21.1 interview (R1–R7, the six-item moment → application.trid_received), credit for both (R2), DU findings received and interpreted (R8 — no decision yet)
  J = await openApp();
  await J.j.quoteOnly();   // 20.4's quote and the credit-report fee handling (22.2 R1: no hard pull before the six items and the fee are recorded) — no LE yet
  await J.j.orderCredit(MST("2026-10-05", "10:52"));
  await J.j.duSubmitAndInterpret({ findings_at: MST("2026-10-06", "14:00"), interpreted_at: MST("2026-10-06", "14:12") });
  await settle();
  const events = await db.query<{ type: string }>(`SELECT type FROM loan_events WHERE application_id = $1 ORDER BY sequence`, [J.j.appId]);
  const types = new Set(events.map((e) => e.type));
  assert.ok(types.has("application.trid_received") && types.has("credit.report.received") && types.has("du.findings.received"), `the spine at R8: ${[...types].join(",")}`);
  assert.ok(!types.has("decision.issued") && !types.has("disclosure.le.delivered"), "R8 has not ended: no decision, no LE yet");
  // the projection (src/runtime/borrower/journey-progress.ts): the twelve refinance steps of docs/ux/03 §2, derived from the spine and the cards, never stored
  tokA = (await signIn(J.A)).token;
  recordR8 = await record(tokA, J.j.appId);
  const jp = recordR8["journey_progress"] as { steps: { id: string; label_copy_key: string; state: string; at: string | null }[]; done: number; total: number };
  assert.ok(jp, "journey_progress on the record");
  assert.deepEqual(jp.steps.map((s) => s.id), REFINANCE_STEPS.map((s) => s.id), "R1–R12 in order");
  assert.deepEqual(jp.steps.filter((s) => s.state === "done").map((s) => s.id), ["R1", "R2", "R3", "R4", "R5", "R6", "R7"], "E1–R7 done (the entry steps precede the subject; R1–R7 are the counted ones)");
  assert.deepEqual(jp.steps.filter((s) => s.state === "current").map((s) => s.id), ["R8"], "R8 current");
  assert.deepEqual(jp.steps.filter((s) => s.state === "upcoming").map((s) => s.id), ["R9", "R10", "R11", "R12"]);
  assert.equal(jp.done, 7); assert.equal(jp.total, 12);
  for (const s of jp.steps) { assert.ok(s.label_copy_key.startsWith("journey.refi."), s.label_copy_key); if (s.state !== "done") assert.equal(s.at, null); }
  assert.ok(jp.steps.find((s) => s.id === "R7")!.at, "a done step carries its evidence time (application.trid_received)");
  assert.ok(jp.steps.find((s) => s.id === "R2")!.at, "credit.report.received");
  // the same derivation over the raw spine and cards (pure), so the record reader and the tests agree on the rule
  const cards = await cardsOf(J.partyA);
  const pure = journeyProgress({ stage: "origination", transaction_type: "limited_cash_out", events: (await db.query<{ type: string; occurred_at: string; payload: Json }>(`SELECT type, occurred_at, payload FROM loan_events WHERE application_id = $1 ORDER BY sequence`, [J.j.appId])), cards });
  assert.deepEqual(pure!.steps.map((s) => [s.id, s.state]), jp.steps.map((s) => [s.id, s.state]));
  // a serviced loan has no journey to show; a purchase application walks P1–P9, C1–C7
  assert.equal(journeyProgress({ stage: "servicing", transaction_type: null, events: [], cards: [] }), null);
  assert.equal(journeyProgress({ stage: "origination", transaction_type: "purchase", events: [], cards: [] })!.total, 16);
  // Progress renders "7 of 12" on the rail, R8 marked current, the earlier steps done
  const { page, ctx } = await openShell(tokA, 1280);
  const progress = page.locator('[data-testid="record"] [data-record-section="progress"]');
  assert.equal((await progress.getByTestId("progress-count").innerText()).trim(), "7 of 12");
  assert.equal(await progress.locator('[data-step-id][data-state="done"]').count(), 7);
  assert.equal(await progress.locator('[data-step-id="R8"][data-state="current"]').count(), 1);
  assert.equal(await progress.locator('[data-step-id][data-state="upcoming"]').count(), 4);
  await page.screenshot({ path: `${SCREENSHOTS}/t13-progress-1280.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});

test("32.16-T11: Given the shell at ≥ 1024 px, then no card component renders inside the thread; every pending card renders under Needed from you, current ask first, and expanding one shows its component.", { skip }, async () => {
  assert.ok(J, "T13 drove the journey to R8"); await fresh();
  // two more asks the flows would raise on the way (the harness sends them through 32.1's send_card, as 32.13 does): a home ConfirmCard and an income ConnectCard
  const home = await sendCard(J, J.partyA, "ConfirmCard", "refi.home.confirm", { title: "Confirm your home", fields: [{ path: "property_address", label: "Address", value: "100 N Central Ave, Phoenix, AZ 85004", source: "public_records" }], commits_to: "application_properties" });
  const truv = await sendCard(J, J.partyA, "ConnectCard", "income.connect.purpose", { vendor: "truv_income", purpose_text: "Connect your payroll", what_we_get: ["employer", "pay"], fallback: { label: "Type it in" }, state: "not_started" }, "verification.connect");
  const rec = await record(tokA, J.j.appId);
  const t = await thread(tokA);
  const pending = (await cardsOf(J.partyA, `AND status = 'pending'`)).filter((c) => !c.subject_application_id || c.subject_application_id === J.j.appId);
  assert.ok(pending.length >= 2, `pending cards at R8: ${pending.map((c) => `${c.kind}:${c.copy_key}`).join(", ")}`);
  const { page, ctx } = await openShell(tokA, 1280);
  // ≥ 1024: the rail sits beside the thread; no card component anywhere in the thread — cards there are one-line reference chips
  assert.ok((await page.getByTestId("record").boundingBox())!.x > 600, "the rail beside the thread at 1280");
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0, "no card component inside the thread");
  assert.ok((await page.locator('[data-testid="thread"] [data-testid="reference-chip"]').count()) >= 1, "the thread references its cards with chips");
  assert.equal(await page.locator('[data-testid="thread"] .sm-msg-meta').count(), 0, "no sender/badge/timestamp row on the lines");
  assert.equal(await page.locator('[data-testid="thread"] [data-copy-key="entry.disclosure.first"]').count(), 0, "the disclosure row is the footer, not a line in the log");
  assert.ok(await page.getByTestId("footer-disclosure").isVisible(), "the disclosure footer");
  assert.equal(await page.getByTestId("talk-to-person").count(), 0, "no Talk to a person control (32.16 §1 principle 8)");
  // every pending card renders under Needed from you (informational kinds have their own sections: a status card under What we're doing, a person under People, a notice under Documents)
  const needed = page.locator('[data-testid="record"] [data-record-section="needed"]');
  const rows = await needed.locator("[data-rail-card]").evaluateAll((els: unknown[]) => (els as { getAttribute(n: string): string | null }[]).map((e) => ({ id: e.getAttribute("data-rail-card"), expanded: e.getAttribute("data-expanded"), current: e.getAttribute("data-current-ask"), kind: e.getAttribute("data-card-kind") })));
  const INFORMATIONAL = new Set(["StatusCard", "NoticeCard", "PersonCard", "InviteCard"]);
  for (const c of pending) {
    if (INFORMATIONAL.has(c.kind)) { assert.equal(await page.locator(`[data-testid="record"] [data-rail-card="${c.card_instance_id}"]`).count(), 1, `${c.kind} ${c.copy_key} has its row on the rail`); continue; }
    assert.ok(rows.some((r) => r.id === c.card_instance_id), `${c.kind} ${c.copy_key} under Needed from you`);
  }
  assert.ok(rows.some((r) => r.id === home) && rows.some((r) => r.id === truv));
  // current ask first: the record's first needed item (the API's order — due first, then oldest), expanded by default; the others collapsed to one line
  const first = ((rec["needed_from_you"] as Json[])[0]?.["card_instance_id"] as string | undefined) ?? (t.pinned_card?.["card_instance_id"] as string | undefined);
  assert.ok(first, "the API names the current ask");
  assert.equal(rows[0]!.id, first, `current ask first: ${JSON.stringify(rows)}`);
  assert.equal(rows[0]!.current, "true"); assert.equal(rows[0]!.expanded, "true");
  assert.equal(await needed.locator(`[data-rail-card="${first}"] article[data-card-id="${first}"]`).count(), 1, "the current ask shows its component");
  const collapsed = rows.find((r) => r.expanded !== "true");
  assert.ok(collapsed, "the other asks are one line each");
  assert.equal(await needed.locator(`[data-rail-card="${collapsed.id}"] article`).count(), 0);
  // expanding one shows its existing component (the same `article[data-card-kind]` the 01 §3 library renders), resolvable in place
  await needed.locator(`[data-rail-card="${collapsed.id}"] > button`).click();
  const article = needed.locator(`[data-rail-card="${collapsed.id}"] article[data-card-kind="${collapsed.kind}"]`);
  await article.waitFor({ timeout: 15_000 });
  assert.equal(await article.getAttribute("data-card-id"), collapsed.id);
  assert.ok((await article.locator("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])").count()) >= 1, "the component is operable in place");
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0, "still no card in the thread");
  assert.equal(await page.locator('[data-testid="card-error"]').count(), 0, "every card renders");
  await page.screenshot({ path: `${SCREENSHOTS}/t11-rail-1280.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});

test("32.16-T12: Given a reference chip, when clicked, then the rail focuses and expands that `card_instance_id`; resolving it there updates the chip to its receipt.", { skip }, async () => {
  assert.ok(J, "T13 drove the journey to R8"); await fresh();
  // a regulated choice the assistant puts on the rail (a §2.3 evidence case): the reference in the thread is the message that carries the card
  const cardId = await sendCard(J, J.partyA, "ChoiceCard", "refi.product.choice", { title: "Which loan?", options: [{ id: "frm30", label: "30-year fixed", is_primary: true }, { id: "frm15", label: "15-year fixed" }], command: "application.setProduct", command_args_by_option: { frm30: { product: "FRM30" }, frm15: { product: "FRM15" } } });
  const t = await thread(tokA);
  assert.ok(t.messages.some((m) => m["card_instance_id"] === cardId), "the thread carries the card's message");
  const { page, ctx } = await openShell(tokA, 1280);
  const chip = page.locator(`[data-testid="thread"] [data-testid="reference-chip"][data-card-id="${cardId}"]`);
  await chip.waitFor({ timeout: 15_000 });
  assert.match(await chip.innerText(), /Which loan\? →/, "the chip is the card's one-line reference");
  // collapsed on the rail until the chip is tapped (it is not the current ask: an older card is)
  const row = railRow(page, cardId);
  assert.equal(await row.getAttribute("data-expanded"), "false", "collapsed before the tap");
  await chip.click();
  await page.waitForSelector(`[data-rail-card="${cardId}"][data-expanded="true"] article[data-card-id="${cardId}"]`, { timeout: 15_000 });
  await page.waitForTimeout(600);   // the smooth scroll into view
  assert.ok(await inViewport(page, `[data-rail-card="${cardId}"] article[data-card-id="${cardId}"]`), "the rail focused the card (in the viewport, expanded)");
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0, "the tap opens the card on the rail, never in the thread");
  // resolving it there — a tap on the rail, the API's resolveCard — updates the chip to the receipt
  await page.locator(`[data-rail-card="${cardId}"] article`).getByRole("button", { name: "15-year fixed" }).click();
  await page.waitForSelector(`[data-testid="thread"] [data-testid="chip-receipt"][data-card-id="${cardId}"]`, { timeout: 15_000 });
  const receipt = page.locator(`[data-testid="thread"] [data-testid="chip-receipt"][data-card-id="${cardId}"]`);
  assert.match(await receipt.innerText(), /Which loan\? — 15-year fixed/, "the receipt line: the card's title and the choice");
  assert.equal(await page.locator(`[data-testid="thread"] [data-testid="reference-chip"][data-card-id="${cardId}"]`).count(), 0);
  await settle();
  const row2 = (await cardsOf(J.partyA, `AND card_instance_id = '${cardId}'`))[0]!;
  assert.equal(row2.status, "resolved"); assert.equal((row2.evidence as Json)["option_id"], "frm15", "resolved through resolveCard with the tapped option");
  assert.equal(await page.locator(`[data-testid="record"] [data-record-section="needed"] [data-rail-card="${cardId}"]`).count(), 0, "a resolved card leaves Needed from you");
  await page.screenshot({ path: `${SCREENSHOTS}/t12-receipt-1280.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});

test("32.16-T14: Given `credit_reports.frozen_repositories` non-empty, then the rail shows a caution row with the lift-instructions card, and no toast or modal exists in the DOM.", { skip }, async () => {
  assert.ok(J, "T13 drove the journey to R8");
  // 22.2's freeze workflow on the report: `frozen_repositories` non-empty → credit.freeze.detected with the borrower notice (the platform's fact). The borrower-facing lift
  // instructions are the `credit.freeze.lift` StatusCard 32.14's flow sends on a frozen soft pull; no origination flow raises it from the 22.2 detection yet, so the harness
  // sends the same card through 32.1's send_card (the flows' own seam) and the shell is measured on what it does with it: a caution row, never a toast, never a modal.
  await fresh();
  const report = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'credit_reports' AND id = $1`, [J.j.creditReportId]);
  assert.ok(report[0], `the credit report entity (${J.j.creditReportId})`);
  const frozenBefore = ((report[0]!.data as Json)["frozen_repositories"] as unknown[] | undefined) ?? [];
  const liftCard = await sendCard(J, J.partyA, "StatusCard", "credit.freeze.lift", { state_label: "", detail: "" });
  const rec = await record(tokA, J.j.appId);
  assert.ok(Array.isArray(rec["needed_from_you"]));
  const { page, ctx } = await openShell(tokA, 1280);
  const row = page.locator(`[data-testid="record"] [data-record-section="needed"] [data-rail-card="${liftCard}"]`);
  await row.waitFor({ timeout: 15_000, state: "attached" });
  assert.equal(await row.getAttribute("data-tone"), "caution", "a caution row under Needed from you");
  await row.locator("> button").click();
  const article = row.locator(`article[data-card-id="${liftCard}"]`); await article.waitFor({ timeout: 15_000 });
  assert.match(await article.innerText(), /credit file is frozen|Lift the freeze/i, "the lift-instructions card (copy `credit.freeze.lift`)");
  // never a toast, never a modal: nothing with a dialog role, nothing modal, nothing announced as a live status beyond the cards' own polite region
  assert.equal(await page.locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .sm-toast, [data-testid="toast"]').count(), 0, "no toast or modal in the DOM");
  assert.equal(await page.locator('[role="alert"]:not(#__next-route-announcer__)').count(), 0, "no alert bar either (Next's route announcer is the one role=alert on every page)");
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0);
  assert.ok(frozenBefore.length >= 0);
  await page.screenshot({ path: `${SCREENSHOTS}/t14-caution-1280.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});

test("32.16-T15: Given a `DocumentCard{LE}` under Documents, when expanded, then the viewer and \"Confirm receipt\" render and confirming writes `receipt_evidence = esign_confirmed` (32.3 32.3-T22 unchanged).", { skip }, async () => {
  assert.ok(J, "T13 drove the journey to R8");
  // both parties' E-SIGN active (32.3 E6 by tap + the demonstration), the quote, the LE by the parties' consents (32.3's deliverLeByConsent → esign_portal) — the LE DocumentCard{requires_ack} per party
  await consentEsign(J, J.A, J.partyA, "Alex Borrower"); await consentEsign(J, J.B, J.partyB, "Blake Borrower");
  await J.j.quoteOnly();
  const render = reviveCents((J.j as unknown as { LE_RENDER(): Record<string, unknown> }).LE_RENDER());
  clock.set(MST("2026-10-06", "16:10"));
  const le = await deliverLeByConsent(runtime, J.j.appId, { render: render as never, mlo: { review_id: `MR-LE-${J.j.R}`, nmlsr_id: "987654" }, at: MST("2026-10-06", "16:10") });
  assert.equal(le.channel, "esign_portal");
  await settle();
  const leCard = (await cardsOf(J.partyA, `AND kind = 'DocumentCard'`)).find((c) => typeof c.props["disclosure_id"] === "string" && String(c.props["notice_code"] ?? "").includes("LE"));
  assert.ok(leCard, "the LE DocumentCard for Alex");
  assert.equal(leCard.props["requires_ack"], true);
  const tok = (await signIn(J.A)).token; tokA = tok;
  const rec = await record(tok, J.j.appId);
  const docRow = (rec["documents"] as Json[]).find((d) => d["disclosure_id"] === leCard.props["disclosure_id"] || d["card_instance_id"] === leCard.card_instance_id);
  assert.ok(docRow, `the Documents row for the LE: ${JSON.stringify((rec["documents"] as Json[]).map((d) => [d["title"], d["status"]]))}`);
  const { page, ctx } = await openShell(tok, 1280);
  const documents = page.locator('[data-testid="record"] [data-record-section="documents"]');
  const row = documents.locator(`[data-rail-card="${leCard.card_instance_id}"]`);
  await row.waitFor({ timeout: 15_000, state: "attached" });
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0, "the LE is a document on the rail, not a card in the thread");
  if (leCard.status === "pending") {
    await row.locator("> button").click();
    const article = row.locator(`article[data-card-id="${leCard.card_instance_id}"]`); await article.waitFor({ timeout: 15_000 });
    assert.equal(await article.getByTestId("document-viewer").count(), 1, "the viewer");
    const confirm = article.getByRole("button", { name: "Confirm receipt" });
    assert.equal(await confirm.count(), 1, "Confirm receipt");
    await confirm.click();
    await page.waitForSelector(`[data-rail-card="${leCard.card_instance_id}"] article[data-status="resolved"], [data-testid="thread"] [data-testid="chip-receipt"][data-card-id="${leCard.card_instance_id}"]`, { timeout: 15_000 });
  }
  await settle();
  const after = (await cardsOf(J.partyA, `AND card_instance_id = '${leCard.card_instance_id}'`))[0]!;
  assert.equal(after.status, "resolved");
  assert.equal((after.evidence as Json)["receipt_evidence"], "esign_confirmed", `receipt_evidence = esign_confirmed (32.3-T22 unchanged): ${JSON.stringify(after.evidence)}`);
  assert.ok((await db.query<{ type: string }>(`SELECT type FROM loan_events WHERE application_id = $1 AND type = 'disclosure.le.received'`, [J.j.appId])).length >= 1, "disclosure.le.received on the spine");
  await page.screenshot({ path: `${SCREENSHOTS}/t15-documents-1280.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});

test("32.16-T16: Given a phone width, then the status strip shows the badge, next event and needed count, and the sheet shows the same rail sections.", { skip }, async () => {
  assert.ok(J, "T13 drove the journey to R8"); await fresh();
  const rec = await record(tokA, J.j.appId);
  const wide = await openShell(tokA, 1280);
  const sectionsWide = await wide.page.locator('[data-testid="record"] [data-record-section]').evaluateAll((els: unknown[]) => (els as { getAttribute(n: string): string | null }[]).map((e) => e.getAttribute("data-record-section")));
  await wide.ctx.close();
  const { page, ctx } = await openShell(tokA, 390);
  // the status strip: badge, next event, the needed-from-you count — the record's own values, never counted here
  const strip = page.getByTestId("status-strip"); assert.ok(await strip.isVisible(), "the status strip at 390");
  assert.equal((await strip.getByTestId("status-badge").innerText()).trim().replace(/^[^\w]+/, ""), String((rec["status"] as Json)["badge"]));
  const nextText = (await strip.getByTestId("strip-next").innerText()).trim(); const next = rec["next"] as Json | null;
  if (next) assert.ok(nextText.includes(String(next["label"])), `next event on the strip: ${nextText}`); else assert.equal(nextText, "Nothing scheduled");
  assert.match((await strip.getByTestId("strip-count").innerText()).trim(), new RegExp(`^${(rec["needed_from_you"] as unknown[]).length} `), "the needed-from-you count on the strip");
  assert.equal(await page.getByTestId("talk-to-person").count(), 0);
  assert.ok(await inViewport(page, '[data-testid="action-bar"]'), "the input bar in the viewport");
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0, "no card in the thread on a phone either — the sheet is the rail");
  assert.ok(await page.evaluate<boolean>("document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390"), "the page never scrolls sideways");
  // the sheet: the same rail sections, in the same order, as beside the thread at 1280
  await strip.click(); await page.waitForSelector('[data-testid="record"][data-open="true"]', { timeout: 15_000 });
  const sectionsSheet = await page.locator('[data-testid="record"][data-open="true"] [data-record-section]').evaluateAll((els: unknown[]) => (els as { getAttribute(n: string): string | null }[]).map((e) => e.getAttribute("data-record-section")));
  assert.deepEqual(sectionsSheet, sectionsWide, "the sheet carries the same sections");
  for (const id of ["status", "progress", "needed", "documents"]) assert.ok(sectionsSheet.includes(id), `${id} on the sheet`);
  assert.ok(await page.locator('[data-testid="record"] [data-record-section="needed"]').isVisible());
  assert.equal((await page.locator('[data-testid="record"] [data-record-section="progress"] [data-testid="progress-count"]').innerText()).trim(), `${(rec["journey_progress"] as Json)["done"]} of ${(rec["journey_progress"] as Json)["total"]}`);
  // a reference chip opens the sheet at that card (32.16 §2.1: below 768 the rail is the bottom sheet and the chip opens it)
  await page.getByRole("button", { name: "Close your record" }).click();
  await page.waitForSelector('[data-testid="record"][data-open="true"]', { timeout: 15_000, state: "detached" });   // closed = display:none, never "visible"
  const chip = page.locator('[data-testid="thread"] [data-testid="reference-chip"]').first();
  const chipCard = await chip.getAttribute("data-card-id");
  await chip.click();
  await page.waitForSelector(`[data-testid="record"][data-open="true"] [data-rail-card="${chipCard}"][data-expanded="true"]`, { timeout: 15_000 });
  await page.screenshot({ path: `${SCREENSHOTS}/t16-sheet-390.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});
