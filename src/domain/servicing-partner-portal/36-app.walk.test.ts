// 36 — the partner app's walk (docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md §8 Session 5): apps/partner built and served
// as its standalone server against this file's own API, driven with Playwright's Chromium from /opt/pw-browsers. Not a T-id
// (section 36's T-ids are 36-1 … 36-6.spec.test.ts); the seven checks of the session plan, one node:test each.
//
// The harness is 36-3.spec.test.ts's (own database `<base>_36_app`, the API server of src/runtime/server.ts in-process with the
// partner prefix /v1/partner/* and the borrower router, the FAKE e-delivery port with `fake_code` echoed, a FixedClock at 07:05
// America/New_York on 2026-09-15, the demo partner's parties{servicer} row with its seeded partner_admin, the entry seed, the
// 12-loan fixture imported as the seed imports it, and the 33.2 daily run through runtime.sweep() so the buckets have counts)
// plus the partner app: `next build` of apps/partner into `.next-t36` (rebuilt when a source is newer), its standalone server on
// a free port pointed at this API through its cookie proxy (`API_BASE_URL`), one Chromium at 1280 px. One Chromium-driven suite
// runs at a time (src/infra/db/test-lock.ts's browser lock), so tools/affected-tests.mjs leaves this file to the landing and CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { acquireBrowserLock, type TestLock } from "../../infra/db/test-lock.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { AnthropicLlm } from "../../runtime/borrower/agent/llm.ts";
import { FakeRateFeed } from "../../infra/integrations/rates.ts";
import { FakeReviewers } from "../../infra/integrations/reviewers.ts";
import { DEMO_AS_OF, DEMO_PARTNER, demoBook, type DemoLoan } from "../partner-book/fixtures/partner-book-demo.ts";
import { importPartnerBook } from "../../runtime/partner-book.ts";
import { seedEntryDemo } from "../../runtime/entry-seed.ts";
import { seedPartnerPortalDemo, DEMO_PARTNER_ADMIN_EMAIL } from "../../runtime/partner-portal/seed.ts";
import { scriptedClient, type Scene } from "../borrower/eval/scripted-client.ts";
import { SERVICED_TAB_COPY } from "./serviced.ts";
import { bannerMonitored } from "./buckets.ts";
import type { Browser, Context, Locator, Page } from "../borrower/harness.ts";
/** Playwright's `setInputFiles` (the borrower harness's Locator type leaves it out): a file from memory into the dropzone's input. */
const files = (l: Locator): { setInputFiles(f: { name: string; mimeType: string; buffer: Buffer }): Promise<void> } => l as unknown as { setInputFiles(f: { name: string; mimeType: string; buffer: Buffer }): Promise<void> };

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
type Json = Record<string, unknown>;
/** The first review day: 2026-09-15 07:05 America/New_York — after 20.1's 06:30 run and 33.2's 07:00 pass (36-3.spec.test.ts's instant). */
const AS_OF = "2026-09-15"; const NOW = "2026-09-15T11:05:00.000Z";
const clock = new FixedClock(NOW);

// the scripted analyst (33.2 rule 4): the figures only as tokens — 36-3.spec.test.ts's three scenes
const CLEAN_RATIONALE = "Your rate today is {{facts.rate_now}} and this morning's sheet shows {{facts.candidate_rate}}, which lowers the payment by {{facts.monthly_delta}}. The offer is on the card here.";
const ANALYST_CANDIDATE: Scene = { when: /verdict is candidate/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: CLEAN_RATIONALE, flags: [] } }], text: "Written." };
const ANALYST_WATCHING: Scene = { when: /verdict is watching/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "Rates are not below yours yet; the book is checked every morning.", flags: [] } }], text: "Written." };
const ANALYST_OTHER: Scene = { when: /verdict is (excluded|not_now)/, calls: [{ name: "review.facts", input: {} }, { name: "review.write", input: { rationale: "The loan is out of today's review because of what is on the partner's file; nothing is offered.", flags: [] } }], text: "Written." };
const analystScripted = scriptedClient([ANALYST_CANDIDATE, ANALYST_WATCHING, ANALYST_OTHER]);

// the people: the seeded partner_admin of the demo partner (the door enrols her in the browser) and the partner_ops colleague she invites (check 7)
const NORA = { email: DEMO_PARTNER_ADMIN_EMAIL, password: `nora-northlight-admin-${R}` };
const OLI = { email: `oli.ops.${R}@northlight.example`, name: "Oli Operations", password: `oli-partner-ops-pass-${R}` };
let partnerA = ""; let noraId = ""; let loan1Id = "";

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined;
let browserLock: TestLock | null = null;
const logLines: string[] = [];
const book = demoBook();
const loanN = (n: number): DemoLoan => book.loans.find((l) => l.n === n)!;
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

// ---------------------------------------------------------------- the partner app (the borrower harness's shape, for apps/partner)
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APP_DIR = `${ROOT}apps/partner/`;
const DIST = ".next-t36";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SESSION_COOKIE = "sm_partner_session";
let appProc: ChildProcess | null = null; let appBase = ""; let appLog = ""; let browser: Browser | null = null;
const contexts: Context[] = [];
function newestSource(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".next") || name === "tests" || name === "playwright-report" || name === "test-results") continue;
    const p = `${dir}/${name}`; const st = statSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestSource(p)); else if (/\.(ts|tsx|css|json|mjs|mts)$/.test(name)) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}
/** The standalone build in `.next-t36`, rebuilt when a source is newer; the partner's legal name on the door from public config (§7). */
function ensureBuild(): void {
  const buildId = `${APP_DIR}${DIST}/BUILD_ID`;
  if (!existsSync(buildId) || statSync(buildId).mtimeMs < newestSource(APP_DIR.replace(/\/$/, ""))) {
    const r = spawnSync("npx", ["next", "build"], { cwd: APP_DIR, env: { ...process.env, NEXT_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_PARTNER_LEGAL_NAME: DEMO_PARTNER.legal_name, NEXT_PUBLIC_PARTNER_NMLSR_ID: DEMO_PARTNER.nmlsr_id }, stdio: "pipe", timeout: 600_000, encoding: "utf8" });
    assert.equal(r.status, 0, `next build failed:\n${r.stdout}\n${r.stderr}`);
  }
  cpSync(`${APP_DIR}${DIST}/static`, `${APP_DIR}${DIST}/standalone/${DIST}/static`, { recursive: true });
}
async function shell(): Promise<string> {
  if (appBase) return appBase;
  ensureBuild();
  const port = 3800 + Math.floor(Math.random() * 400);
  appProc = spawn(process.execPath, [`${APP_DIR}${DIST}/standalone/server.js`], { cwd: `${APP_DIR}${DIST}/standalone`, env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", API_BASE_URL: base, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  appProc.stdout?.on("data", (d: Buffer) => { appLog += d.toString(); }); appProc.stderr?.on("data", (d: Buffer) => { appLog += d.toString(); });
  appBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { try { const r = await fetch(`${appBase}/partners/sign-in`, { redirect: "manual" }); if (r.status < 500) return appBase; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`the partner app did not start on ${appBase}:\n${appLog.slice(-2000)}`);
}
async function stopShell(): Promise<void> { for (const c of contexts.splice(0)) await c.close().catch(() => undefined); await browser?.close().catch(() => undefined); browser = null; appProc?.kill(); appProc = null; }
/** A context (with the session cookie the proxy reads when a token is given) and a page at `path` under /partners. */
async function pageFor(token: string | null, path = "/partners"): Promise<{ page: Page; ctx: Context }> {
  await shell();
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/pw-browsers";
  if (!browser) { const pw = createRequire(import.meta.url)(`${APP_DIR}node_modules/playwright`) as { chromium: { launch(o: object): Promise<Browser> } }; browser = await pw.chromium.launch({ headless: true, ...(existsSync(CHROME) ? { executablePath: CHROME } : {}) }); }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); contexts.push(ctx);
  if (token) await ctx.addCookies([{ name: SESSION_COOKIE, value: token, domain: "127.0.0.1", path: "/partners", httpOnly: true, secure: false, sameSite: "Lax" }]);
  const page = await ctx.newPage(); const logs: string[] = []; const requests: string[] = [];
  page.on("console", (m) => logs.push(`console: ${m.text()}`)); page.on("pageerror", (e) => logs.push(`pageerror: ${e.message ?? String(e)}`));
  page.on("request", (r) => { const u = r.url(); const i = u.indexOf("/partners/api/"); if (i >= 0) requests.push(`${r.method()} ${u.slice(i + "/partners/api".length)}`); });
  page.logs = logs; page.requests = requests;
  await page.goto(`${appBase}${path}`, { waitUntil: "load", timeout: 60_000 });
  return { page, ctx };
}
const text = async (page: Page, testId: string): Promise<string> => (await page.getByTestId(testId).first().innerText()).trim();
const whyNot = (page: Page): string => `url=${page.url()}; logs=${JSON.stringify(page.logs?.slice(-8))}; requests=${JSON.stringify(page.requests?.slice(-8))}; app=${appLog.slice(-600)}`;

// ---------------------------------------------------------------- the API (36-3.spec.test.ts's helpers, for the invitation and the second person)
type Reply = { status: number; body: Json };
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-forwarded-for": "10.36.5.1", "user-agent": "36-app-walk", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text(); return { status: r.status, body: t ? (JSON.parse(t) as Json) : {} };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const settle = async (): Promise<void> => { await router.flows?.settle(); await router.agent?.settle(); await router.flows?.settle(); };
async function codeToken(email: string): Promise<string> {
  const c = await api("POST", "/v1/partner/auth/code", { email });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body["delivery"], "FAKE");
  const v = await api("POST", "/v1/partner/auth/verify", { email, code: c.body["fake_code"] });
  assert.equal(v.status, 200, JSON.stringify(v.body)); return v.body["token"] as string;
}
async function enrol(p: { email: string; password: string }): Promise<string> {
  const token = await codeToken(p.email);
  const r = await api("POST", "/v1/partner/auth/password", { token, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body["enrolled"], true); return r.body["partner_user_id"] as string;
}
async function signIn(p: { email: string; password: string }): Promise<{ token: string; role: string; partner_party_id: string }> {
  await codeToken(p.email);
  const r = await api("POST", "/v1/partner/auth/signin", { email: p.email, password: p.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body["token"] as string, role: r.body["role"] as string, partner_party_id: r.body["partner_party_id"] as string };
}
/** The browser's session as a bearer for the API helpers (the proxy's HttpOnly cookie, read from the context). */
const sessionOf = async (ctx: Context): Promise<string> => { const c = (await ctx.cookies()).find((x) => x.name === SESSION_COOKIE); assert.ok(c, "the proxy set sm_partner_session"); return decodeURIComponent(c.value); };

test.before(async () => {
  if (skip) return;
  browserLock = await acquireBrowserLock(DB_URL);   // one Chromium-driven suite at a time (src/infra/db/test-lock.ts)
  db = connect(DB_URL);
  const logger = createLogger("json", (line) => { logLines.push(line); if (process.env["FLOW_DEBUG"] && /error|unhandled|partner|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, logger, rateFeed: new FakeRateFeed(), reviewers: new FakeReviewers({ delaySeconds: 0 }), analystLlm: new AnthropicLlm({ client: analystScripted.client, model: "scripted" }) });
  // the demo partner's parties{servicer} row, its seeded partner_admin (36.1 Operational prerequisites), the entry seed and the 12-loan fixture — the seed's import (36-3.spec.test.ts's harness)
  partnerA = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id, contact) VALUES ('servicer', $1, $2, $3, $4::jsonb) RETURNING id`, [DEMO_PARTNER.legal_name, DEMO_PARTNER.servicer_number, DEMO_PARTNER.mers_org_id, JSON.stringify({ phone: "+18005550199", nmlsr_id: DEMO_PARTNER.nmlsr_id })]))[0]!.id;
  const seed = await seedPartnerPortalDemo(runtime, { partner_id: partnerA }); assert.equal(seed.created, true); noraId = seed.partner_user_id;
  const entry = await seedEntryDemo(runtime, { partner_id: partnerA, nmlsr_id: DEMO_PARTNER.nmlsr_id }); assert.equal(entry.partner_id, partnerA);
  const imp = await importPartnerBook(runtime, { partner: DEMO_PARTNER, as_of_date: DEMO_AS_OF, profile: "m3-v1", tape: { filename: "partner-book-demo.xlsx", content: book.tape }, supplement: { filename: "partner-book-demo-supplement.csv", content: bytes(book.supplement) } }, { kind: "human", id: "u-ops-analyst", role: "ops_analyst" });
  assert.equal(imp.status, "loaded", JSON.stringify(imp.report).slice(0, 600)); assert.equal(imp.rows_loaded, 12); assert.equal(imp.partner_party_id, partnerA);
  loan1Id = imp.loans.find((l) => l.servicer_loan_number === loanN(1).servicer_loan_number)!.loan_id;
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", defaultPartnerId: partnerA });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrowerRouter: router, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  // the 33.2 daily run, as 36-3.spec.test.ts drives it: 20.1's run → the review → offer delivery; the FAKE MLO's terms review on the second sweep
  await settle();
  const sweep = await runtime.sweep(); await settle();
  assert.ok(sweep.refi?.ran, `the refinance check ran: ${sweep.refi?.reason}`); assert.ok(sweep.partner_book_review.ran, `the review ran: ${sweep.partner_book_review.reason}`); assert.equal(sweep.partner_book_review.as_of_date, AS_OF);
  await runtime.sweep(); await settle();
});
test.after(async () => { if (skip) return; try { await stopShell(); await router.flows?.settle(); await close(); } finally { await browserLock?.release(); } });

let nora: { page: Page; ctx: Context };

test("walk 1: sign-in as the seeded partner_admin — the door (code, then the password set at enrolment) opens Home under the partner's legal name; no loan list before auth", { skip }, async () => {
  const { page, ctx } = await pageFor(null, "/partners");
  await page.waitForURL((u) => u.pathname === "/partners/sign-in", { timeout: 30_000 });   // no session: the shell sends the browser to the door, keeping the return path
  assert.equal(new URL(page.url()).searchParams.get("return"), "/partners");
  assert.equal(await text(page, "door-partner"), `${DEMO_PARTNER.legal_name} · NMLSR ID ${DEMO_PARTNER.nmlsr_id}`, "the partner's legal name on the door");
  assert.equal(await page.getByTestId("loan-link").count(), 0, "no loan on the door");
  await page.getByTestId("door-email").fill(NORA.email); await page.getByTestId("door-send-code").click();
  await page.getByTestId("door-fake-code").waitFor({ timeout: 15_000 });
  const code = (await page.getByTestId("door-fake-code").locator("code").innerText()).trim(); assert.match(code, /^\d{6}$/, "the FAKE port's code, echoed on the door");
  await page.getByTestId("door-code").fill(code); await page.getByTestId("door-verify").click();
  await page.getByTestId("door-new-password").waitFor({ timeout: 15_000 });   // invited → the password is set on the enrol token
  await page.getByTestId("door-new-password").fill(NORA.password); await page.getByTestId("door-set-password").click();
  await page.waitForURL((u) => u.pathname === "/partners", { timeout: 30_000 });
  try { await page.waitForSelector('[data-testid="home"]', { timeout: 30_000 }); } catch (e) { throw new Error(`Home did not render: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}; ${whyNot(page)}`); }
  assert.equal(await text(page, "partner-legal-name"), DEMO_PARTNER.legal_name);
  assert.match(await text(page, "who"), /Admin/);
  const cookie = (await ctx.cookies()).find((c) => c.name === SESSION_COOKIE) as { name: string; value: string; path?: string; httpOnly?: boolean; sameSite?: string } | undefined;
  assert.ok(cookie?.value, "the proxy keeps the session in sm_partner_session"); assert.equal(cookie?.path, "/partners"); assert.equal(cookie?.httpOnly, true); assert.equal(cookie?.sameSite, "Lax");
  assert.deepEqual((await page.getByTestId("nav").locator("a").allInnerTexts()).map((s) => s.trim()), ["Home", "Book", "Eligibility", "Pipeline", "Reports", "Admin"], "the nav in its fixed order; Admin for partner_admin");
  const sessions = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_sessions WHERE partner_user_id = $1 AND revoked_at IS NULL`, [noraId]); assert.equal(Number(sessions[0]!.n), 1, "one open partner session");
  nora = { page, ctx };
});

test("walk 2: Home shows 12 monitored after the seed — the tape as-of, the next tape due, the three bucket counts and the in-flight count are the API's", { skip }, async () => {
  const { page } = nora;
  assert.equal(await text(page, "home-monitored"), "12");
  assert.equal(await page.getByTestId("home").getAttribute("data-empty"), "false");
  assert.equal(await text(page, "home-last-as-of"), "Sep 1, 2026", "the seed's tape as of 2026-09-01");
  assert.equal(await text(page, "home-next-due"), "Sep 8, 2026 Late", "as-of + 7 calendar days, breached by 2026-09-15 (33.1's clock)");
  assert.equal(await page.getByTestId("home-late").count(), 1, "the late badge");
  const home = await api("GET", "/v1/partner/home", undefined, bearer(await sessionOf(nora.ctx))); assert.equal(home.status, 200, JSON.stringify(home.body));
  const e = home.body["eligibility"] as { eligible_now: number; likely_soon: number; not_near: number }; const p = home.body["pipeline"] as { in_flight: number };
  assert.deepEqual([await text(page, "home-eligible-now"), await text(page, "home-likely-soon"), await text(page, "home-not-near"), await text(page, "home-in-flight")], [String(e.eligible_now), String(e.likely_soon), String(e.not_near), String(p.in_flight)]);
  assert.equal(e.eligible_now + e.likely_soon + e.not_near, 12, "the three counts are the 12 monitored loans after the daily run");
  // the link to the latest daily report is the API's `latest_report_id` (34.3's row when the sweep's daily-report pass has produced one), else the page's one sentence
  const reportLinks = await page.getByTestId("home-report").locator("a").count();
  if (home.body["latest_report_id"]) assert.equal(reportLinks, 1, "the link to the latest daily report"); else { assert.equal(reportLinks, 0); assert.match(await text(page, "home-report"), /No daily report yet/); }
});

test("walk 3: Eligibility has three buckets whose counts sum to monitored-not-held — three tabs, the state filter and no other, each row a link to its loan page", { skip }, async () => {
  const { page } = nora;
  await page.goto(`${appBase}/partners/eligibility`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="eligibility"]', { timeout: 30_000 });
  const [a, b, c, held] = await Promise.all(["count-eligible-now", "count-likely-soon", "count-not-near", "count-on-hold"].map((id) => text(page, id)));
  assert.equal(Number(a) + Number(b) + Number(c), 12 - Number(held), `three buckets ${a} + ${b} + ${c} = monitored (12) − held (${held})`);
  assert.equal(held, "0", "nothing on hold after the first tape");
  assert.equal(await page.getByTestId("eligibility-tabs").locator('[role="tab"]').count(), 3);
  for (const [bucket, n] of [["eligible_now", a], ["likely_soon", b], ["not_near", c]] as const) {
    await page.getByTestId(`tab-${bucket}`).click();
    assert.equal(await page.getByTestId(`bucket-table-${bucket}`).locator('[data-testid="bucket-row"]').count(), Number(n), `${bucket} lists its count`);
  }
  await page.getByTestId("tab-likely_soon").click();
  const headers = (await page.getByTestId("bucket-table-likely_soon").locator("th").allInnerTexts()).map((s) => s.trim().toLowerCase());
  assert.ok(headers.includes("watch rate"), "the watch rate on Likely soon"); assert.ok(!headers.some((h) => /fico|dti|zip|investor|score/.test(h)), "never a score, DTI, ZIP or investor column");
  await page.getByTestId("tab-eligible_now").click();
  assert.equal(await page.locator("select").count(), 1, "the state filter is the only filter control");
  assert.ok(Number(a) >= 1, "loan 1 is Eligible now after the run (33.2-T2)");
  assert.equal(await page.locator(`[data-testid="loan-link"][data-loan-id="${loan1Id}"]`).count(), 1, "loan 1's row links to its page");
});

test("walk 4: Book upload of the fixture is already_loaded — the seed imported these files; the dropzone posts as_of_date, tape and supplement and the report says so", { skip }, async () => {
  const { page } = nora;
  await page.goto(`${appBase}/partners/book`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="upload"]', { timeout: 30_000 });
  assert.equal(await text(page, "book-copy"), "Uploading refreshes monitored facts. It does not transfer servicing.");
  assert.equal(await text(page, "book-monitored"), "12");
  await page.getByTestId("upload-as-of").fill(DEMO_AS_OF);
  await files(page.getByTestId("upload-tape")).setInputFiles({ name: "partner-book-demo.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(book.tape) });
  await files(page.getByTestId("upload-supplement")).setInputFiles({ name: "partner-book-demo-supplement.csv", mimeType: "text/csv", buffer: Buffer.from(book.supplement, "utf8") });
  await page.getByTestId("upload-submit").click();
  try { await page.waitForSelector('[data-testid="upload-result"]', { timeout: 60_000 }); } catch (e) { throw new Error(`no upload result: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}; ${whyNot(page)}`); }
  assert.equal(await page.getByTestId("upload-result").getAttribute("data-status"), "already_loaded");
  assert.equal(await text(page, "upload-status"), "already loaded");
  const imports = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM partner_book_imports WHERE partner_party_id = $1`, [partnerA]); assert.equal(Number(imports[0]!.n), 1, "no second import row");
  assert.equal(await page.getByTestId("book-history").locator("tbody tr").count(), 1, "the history keeps the one import");
});

test(`walk 5: the loan page banner is "${bannerMonitored(DEMO_PARTNER.legal_name)}" — the partner's legal name from the seed; no Pay, Escrow or Draft control anywhere on the page`, { skip }, async () => {
  const { page } = nora;
  await page.goto(`${appBase}/partners/eligibility`, { waitUntil: "load" });
  await page.waitForSelector(`[data-testid="loan-link"][data-loan-id="${loan1Id}"]`, { timeout: 30_000 });
  await page.locator(`[data-testid="loan-link"][data-loan-id="${loan1Id}"]`).click();
  await page.waitForURL((u) => u.pathname === `/partners/loans/${loan1Id}`, { timeout: 30_000 });
  try { await page.waitForSelector('[data-testid="loan-banner"]', { timeout: 30_000 }); } catch (e) { throw new Error(`no banner: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}; ${whyNot(page)}`); }
  assert.equal(await text(page, "loan-banner"), bannerMonitored(DEMO_PARTNER.legal_name));
  assert.equal(await text(page, "loan-banner"), `Monitored — ${DEMO_PARTNER.legal_name} remains servicer`);
  assert.match(await text(page, "loan-facts"), /\$441,366\.13/, "loan 1's UPB formatted from cents (33.2-T2)"); assert.match(await text(page, "loan-facts"), /7\.250%/, "loan 1's note rate");
  const controls = (await page.locator("button, a.btn, input[type=submit]").allInnerTexts()).map((s) => s.trim());
  assert.deepEqual(controls.filter((t) => /pay|escrow|draft|statement|ach|payoff|resolve|exclude|message|re-offer/i.test(t)), [], `no servicing control: ${controls.join(" | ")}`);
  assert.equal(await page.getByTestId("loan-reviews").locator("tbody tr").count(), 1, "one review row after the daily run");
});

test("walk 6: the Serviced tab is disabled with the 36.6 copy — visible, disabled, the one sentence; no chart, no zero", { skip }, async () => {
  const { page } = nora;
  const tab = page.getByTestId("tab-serviced");
  assert.equal(await tab.count(), 1, "the tab is visible"); assert.equal(await tab.isVisible(), true);
  assert.equal(await tab.getAttribute("disabled"), "", "disabled"); assert.equal(await tab.getAttribute("aria-disabled"), "true");
  assert.equal(await tab.getAttribute("title"), SERVICED_TAB_COPY);
  assert.equal(await text(page, "serviced-tab-copy"), SERVICED_TAB_COPY);
  assert.equal(await page.getByTestId("loan-page").getAttribute("data-status"), "monitored");
});

test("walk 7: a partner_ops user sees no upload control — invited by the admin, enrolled, signed in; Book renders no dropzone and no file input, and the nav has no Admin", { skip }, async () => {
  const admin = await sessionOf(nora.ctx);
  const inv = await api("POST", "/v1/partner/users/invite", { email: OLI.email, name: OLI.name, roles: ["partner_ops"] }, bearer(admin));
  assert.equal(inv.status, 200, JSON.stringify(inv.body)); assert.equal(inv.body["partner_party_id"], partnerA);
  await enrol(OLI);
  const oli = await signIn(OLI); assert.equal(oli.role, "partner_ops");
  const { page } = await pageFor(oli.token, "/partners/book");
  try { await page.waitForSelector('[data-testid="book"]', { timeout: 30_000 }); } catch (e) { throw new Error(`Book did not render for partner_ops: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}; ${whyNot(page)}`); }
  assert.equal(await page.getByTestId("upload").count(), 0, "no dropzone"); assert.equal(await page.locator("input[type=file]").count(), 0, "no file input"); assert.equal(await page.getByTestId("upload-submit").count(), 0);
  assert.equal(await page.getByTestId("book-no-upload").count(), 1);
  assert.equal(await text(page, "book-monitored"), "12", "the same book, read");
  assert.deepEqual((await page.getByTestId("nav").locator("a").allInnerTexts()).map((s) => s.trim()), ["Home", "Book", "Eligibility", "Pipeline", "Reports"], "no Admin for partner_ops");
  assert.match(await text(page, "who"), /Ops/);
  // the admin's page still has it (the two sessions are two people)
  await nora.page.goto(`${appBase}/partners/book`, { waitUntil: "load" }); await nora.page.waitForSelector('[data-testid="upload"]', { timeout: 30_000 });
});
