// 35.2 Documents and artifacts: the object store, the PDF writer, stored-byte integrity, legal holds, e-sign envelopes, the borrower viewer and print/mail manifests
// spec/sections/35-operations-runtime/35-2-documents-and-artifacts.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, type Db, type Queryable } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { PgLoanRepository, type Fixture } from "../../infra/db/loans.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock, type Actor } from "../../kernel/events/index.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { Runtime, fakePorts, type ExecuteResponse } from "../../runtime/app.ts";
import { CommandRefused } from "../../app/commands.ts";
import type { ToolInput } from "../../app/tools.ts";
import { PgFakeBlobStore } from "../../infra/blobs/pg-fake-blob-store.ts";
import type { FakePrintMail } from "../../infra/integrations/delivery.ts";
import { FakePrintMail as FakePrintMailImpl, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { MemoryEventStore } from "../../kernel/events/index.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { NoticeService } from "../../notices/service.ts";
import { render, money } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { publishSection10 } from "../pmi/spec-harness.ts";
import { textLayer, GlyphUnsupported, writerStats } from "../../infra/files/pdf.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter } from "../../runtime/borrower/routes.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { acquireBrowserLock, type TestLock } from "../../infra/db/test-lock.ts";
import { renderNoticePdf, blocksFromPlacements, payloadHash } from "./documents/render.ts";
import { MemoryArtifactSink } from "../../runtime/documents/notice-sink.ts";
import { LEGEND_1, LEGEND_2, SM_FILER } from "./documents/irs-1098.ts";
import { monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import type { Recipient } from "../../notices/channel.ts";
import { FIGURE_KEYS } from "../payoff/ops-16-1.ts";

// ───────── the harness: this file's own database, one runtime over it, the FAKE object store (document_blobs), the FAKE ports
const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const T0 = "2026-09-17T05:00:00.000Z";                                   // worked example A's clock (01:00 EDT, Sept 17)
const clock = new FixedClock(T0);
const RECORDS: Actor = { kind: "agent", id: "security-records" };
const COMPLIANCE: Actor = { kind: "human", id: "u-comp-1", role: "compliance" };
const OFFICER: Actor = { kind: "human", id: "u-off-1", role: "officer" };
const ANALYST: Actor = { kind: "human", id: "u-ops-1", role: "ops_analyst" };
let db: Db; let runtime: Runtime; let blobs: PgFakeBlobStore; let printMail: FakePrintMail | undefined;
// the HTTP seam (T9, T10, T16): the API server over the runtime — the borrower router (session-bound signed URLs), the console (the staff view) and the public verify portal
const TOKEN = "ops-" + randomUUID();
const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /"status":[45]|error/.test(line)) process.stderr.write(line + "\n"); });
let base = ""; let closeServer: () => Promise<void> = async () => undefined;
type Reply = { status: number; body: Record<string, unknown>; headers: Headers };
async function api(method: string, path: string, body?: unknown, token?: string, extraHeaders: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...extraHeaders }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: r.headers };
}
/** An L1 session through the FAKE code path (borrower.test.ts precedent); the party then owns `loanId` through a `borrowers` row carrying the partner's supplement (33.1 rule 6), which is what the L2 step matches. */
async function signInL2(email: string, f: { tin_last4: string; dob: string; loanId: string }): Promise<{ token: string; party_id: string; session_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email }); assert.equal(req.status, 200, JSON.stringify(req.body)); assert.equal(req.body["delivery"], "FAKE");
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }); assert.equal(ver.status, 200, JSON.stringify(ver.body));
  const partyId = (ver.body["party"] as { party_id: string }).party_id; const sessionId = (ver.body["session"] as { session_id: string }).session_id; const token = ver.body["token"] as string;
  const b = await one<{ id: string }>(`INSERT INTO borrowers (legal_name, tin_last4, date_of_birth, party_id) VALUES ($1, $2, $3::date, $4) RETURNING id`, [`Borrower ${email.split("@")[0]}`, f.tin_last4, f.dob, partyId]);
  await db.query(`INSERT INTO loan_borrowers (loan_id, borrower_id, role, is_primary) VALUES ($1, $2, 'borrower', true)`, [f.loanId, b.id]);
  const l2 = await api("POST", "/v1/borrower/auth/l2", { ssn_last4: f.tin_last4, date_of_birth: f.dob }, token); assert.equal(l2.status, 200, JSON.stringify(l2.body)); assert.equal(l2.body["level"], "L2");
  return { token, party_id: partyId, session_id: sessionId };
}
/** A second L1 session of the same party (a stolen URL is mis-signed for it). */
async function signInAgain(email: string): Promise<string> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] }); assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return ver.body["token"] as string;
}
let n = 0;
const uniq = (): string => `${Date.now() % 1_000_000}${(n++).toString().padStart(3, "0")}`.padStart(10, "0");
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const one = async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> => { const r = (await db.query<R>(sql, params))[0]; if (!r) throw new Error(`no row: ${sql}`); return r; };
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(`SELECT count(*)::text AS c ${sql}`, params))[0]!.c);
/** A 35.2 tool through the bus on the runtime: {} = a global command, {loanId} / {applicationId} = the subject's (its clocks are hydrated there). */
const run = (name: string, input: ToolInput, actor: Actor = RECORDS, scope: { loanId?: string; applicationId?: string } = {}): Promise<ExecuteResponse> =>
  runtime.execute({ process: "35.2", name, loanId: scope.loanId ?? "", ...(scope.applicationId ? { applicationId: scope.applicationId } : {}), actor, input });
const refused = (p: Promise<unknown>, code: string): Promise<void> => assert.rejects(p, (e: unknown) => { assert.ok(e instanceof CommandRefused, `expected CommandRefused ${code}, got ${(e as Error).message}`); assert.equal(e.code, code, e.message); return true; });
const rejectsSql = (p: Promise<unknown>, re: RegExp): Promise<void> => assert.rejects(p, (e: unknown) => { assert.match((e as Error).message, re); return true; });
async function loanFixture(): Promise<Fixture> {
  return new PgLoanRepository(db).createFixture({ fnmaLoanNumber: uniq(), servicerLoanNumber: `SM-${randomUUID()}`, instrumentDate: D("2021-07-15"), originalUpbCents: 25_000_000n, originalTermMonths: 360, firstPaymentDate: D("2026-10-01"), maturityDate: D("2056-09-01") });
}
/** A small but real PDF-shaped artifact for the store tests (the writer's own PDFs are T1's subject). */
const PDF_BYTES = (tag: string): Buffer => Buffer.from(`%PDF-1.4\n% 35.2 fixture ${tag}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, "latin1");
const storeInput = (tag: string, extra: Record<string, unknown> = {}): ToolInput => ({ kind: "upload", bytes_base64: PDF_BYTES(tag).toString("base64"), mime_type: "application/pdf", retention_class: "life_of_loan_plus_4y", metadata: { filename: `${tag}.pdf` }, ...extra });

// ───────── worked example A (7.1's own figures — 35.2 rule 12: reproduced to the cent, never recomputed) ─────────
const PI = 233_429n;                       // $2,334.29 P&I
const ESCROW = 61_250n;                    // $612.50
const MONTHLY = PI + ESCROW;               // $2,946.79
const LATE_CHARGE = (PI * 5n + 50n) / 100n; // 5% of P&I = 116.7145 → $116.71 (half-up)
const AMOUNT_DUE = MONTHLY + MONTHLY + LATE_CHARGE; // the Sept 1 payment unreceived: $6,010.29 on the Oct 1 statement
/** Worked example A's payload: the 1.2.0 statement sample's shape with the example's figures. */
const PAYLOAD_A: Record<string, unknown> = {
  statement_date: "2026-09-17", due_date: "2026-10-01", amount_due_cents: AMOUNT_DUE, computed_amount_due_cents: AMOUNT_DUE, late_fee_after_date: "2026-10-16", late_fee_cents: LATE_CHARGE,
  principal_cents: 41_750n, interest_cents: 191_679n, escrow_cents: ESCROW, fees_since_last_cents: LATE_CHARGE, past_due_cents: MONTHLY, late_charges_due_cents: LATE_CHARGE,
  pi_cents: PI, monthly_payment_cents: MONTHLY, past_due_count: 1,
  payments_since_last: { total_cents: 0n, principal_cents: 0n, interest_cents: 0n, escrow_cents: 0n, fees_cents: 0n, suspense_cents: 0n },
  ytd: { total_cents: 2_357_432n, principal_cents: 334_000n, interest_cents: 1_533_432n, escrow_cents: 490_000n, fees_cents: 0n, suspense_held_cents: 0n }, ytd_ledger_total_cents: 2_357_432n,
  transactions: [{ date: "2026-09-17", description: "Late fee", amount_cents: LATE_CHARGE }], late_fee_debits: 1,
  servicer_phone: "(800) 555-0100", servicer_address: "PO Box 1, Testville TX 75001", exclusive_address: "PO Box 2, Testville TX 75001", account_last4: "4321", upb_cents: 40_000_000n, rate_pct: "5.750", next_rate_change_date: "2031-10-01", prepay_penalty: false,
  counselor_url: "consumerfinance.gov/find-a-housing-counselor", hud_phone: "(800) 569-4287", regx_days_delinquent: 16, borrower_name: "Bea Borrower", reminder_panel: false, delinquency: null,
};
const BEA = (): Recipient => ({ partyId: randomUUID(), name: "Bea Borrower", mailingAddress: "1 Test St, Testville TX 75001" });
const STMT = "NTC_REGZ_41_STMT_STD";
const registryWithAuthored = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const activeStatementVersion = () => { const v = registryWithAuthored().activeVersion(STMT, D("2026-09-17")); assert.ok(v, "the statement template has a counsel-approved version in effect on 2026-09-17"); return v; };
/** How many times `needle` occurs in `hay`. */
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

test.before(async () => {
  if (skip) return;
  db = connect(DB_URL);
  blobs = new PgFakeBlobStore(db);
  const ports = fakePorts(); printMail = ports.printMail as FakePrintMail;
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock, ports, blobs });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  closeServer = () => new Promise((resolve) => server.close(() => resolve()));
});
test.after(async () => { if (!skip) { await stopShell(); await closeServer(); await browserLock?.release(); await db.end(); } });

// ───────── the borrower app for T16: the built Next.js shell on runtime B's API, driven with Playwright (the 32-13 precedent) ─────────
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APP_DIR = `${ROOT}apps/borrower/`; const DIST = ".next-t13"; const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
interface Locator { getAttribute(name: string): Promise<string | null>; innerText(): Promise<string>; waitFor(o?: { state?: string; timeout?: number }): Promise<void>; count(): Promise<number>; }
interface Page { on(event: string, fn: (x: { text(): string; message?: string }) => void): void; goto(url: string, o?: { waitUntil?: string; timeout?: number }): Promise<unknown>; locator(sel: string): Locator; getByTestId(id: string): Locator; close(): Promise<void>; }
interface Context { addCookies(c: object[]): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }
interface Browser { newContext(o: object): Promise<Context>; close(): Promise<void> }
let appProc: ChildProcess | null = null; let appBase = ""; let browser: Browser | null = null; let appLog = ""; let browserLock: TestLock | undefined;
/** The shell can be driven only where the app's dependencies and Chromium are installed; elsewhere T16's page assertion is the reduced, source-level one (logged as such). */
const shellAvailable = (): boolean => existsSync(`${APP_DIR}node_modules/playwright`) && existsSync(`${APP_DIR}node_modules/.bin/next`) && existsSync(CHROME);
function newestSource(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) { if (name === "node_modules" || name.startsWith(".next") || name === "tests" || name === "playwright-report" || name === "test-results") continue; const p = `${dir}/${name}`; const st = statSync(p); if (st.isDirectory()) newest = Math.max(newest, newestSource(p)); else if (/\.(ts|tsx|css|json|mjs|mts)$/.test(name)) newest = Math.max(newest, st.mtimeMs); }
  return newest;
}
function ensureBuild(): void {
  const buildId = `${APP_DIR}${DIST}/BUILD_ID`;
  if (!existsSync(buildId) || statSync(buildId).mtimeMs < newestSource(APP_DIR.replace(/\/$/, ""))) {
    const r = spawnSync("npx", ["next", "build"], { cwd: APP_DIR, env: { ...process.env, NEXT_DIST_DIR: DIST, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "pipe", timeout: 300_000, encoding: "utf8" });
    assert.equal(r.status, 0, `next build failed:\n${r.stdout}\n${r.stderr}`);
  }
  cpSync(`${APP_DIR}${DIST}/static`, `${APP_DIR}${DIST}/standalone/${DIST}/static`, { recursive: true });
}
async function shell(apiBase: string): Promise<string> {
  if (appBase) return appBase;
  ensureBuild();
  const port = 3400 + Math.floor(Math.random() * 400);
  appProc = spawn(process.execPath, [`${APP_DIR}${DIST}/standalone/server.js`], { cwd: `${APP_DIR}${DIST}/standalone`, env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", API_BASE_URL: apiBase, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  appProc.stdout?.on("data", (d: Buffer) => { appLog += d.toString(); }); appProc.stderr?.on("data", (d: Buffer) => { appLog += d.toString(); });
  appBase = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) { try { const r = await fetch(`${appBase}/app`, { redirect: "manual" }); if (r.status < 500) return appBase; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`the borrower app did not start on ${appBase}:\n${appLog.slice(-2000)}`);
}
async function stopShell(): Promise<void> { await browser?.close().catch(() => undefined); browser = null; appProc?.kill(); appProc = null; }
async function pageFor(apiBase: string, token: string, path: string): Promise<{ page: Page; ctx: Context }> {
  await shell(apiBase);
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/pw-browsers";
  if (!browser) { const pw = createRequire(import.meta.url)(`${APP_DIR}node_modules/playwright`) as { chromium: { launch(o: object): Promise<Browser> } }; browser = await pw.chromium.launch({ headless: true, executablePath: CHROME }); }
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  await ctx.addCookies([{ name: "sm_borrower_session", value: token, domain: "127.0.0.1", path: "/app", httpOnly: true, secure: false, sameSite: "Strict" }]);
  const page = await ctx.newPage();
  await page.goto(`${appBase}${path}`, { waitUntil: "load", timeout: 60_000 });
  return { page, ctx };
}
void ANALYST; void spawnSync;

test("35.2-T1: Given the `NTC_REGZ_41_STMT_STD` template at its counsel-approved version and worked example A's payload, when `documents.render` runs twice with the clock at 2026-09-17T05:00:00Z, then the two PDFs are byte-identical with one `sha256`, the file begins `%PDF-1.4`, every page's content stream carries a text layer from which the rendered `text` is recovered in reading order, and changing one payload field (the late charge) changes the hash.", {}, async () => {
  const v = activeStatementVersion();
  assert.equal(v.version, "1.2.0"); assert.equal(v.plainLanguageStatus, "counsel_approved");
  assert.equal(PI, 233_429n); assert.equal(ESCROW, 61_250n); assert.equal(MONTHLY, 294_679n); assert.equal(LATE_CHARGE, 11_671n); assert.equal(AMOUNT_DUE, 601_029n);
  const p1 = renderNoticePdf(v, PAYLOAD_A, { now: T0 }); const p2 = renderNoticePdf(v, PAYLOAD_A, { now: T0 });
  assert.ok(p1.bytes.equals(p2.bytes), "byte-identical"); assert.equal(p1.sha256, p2.sha256); assert.equal(p1.sha256, sha256(p1.bytes));
  assert.equal(p1.bytes.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  const tl = textLayer(p1.bytes);
  assert.equal(tl.pages.length, p1.page_count); assert.ok(p1.page_count >= 2, "the statement's transactions and counselor blocks are on page 2");
  for (const page of tl.pages) assert.ok(page.length > 0, "every page's content stream carries a text layer");
  assert.equal(tl.text, p1.text, "the rendered text is recovered in reading order (block order, line order)");
  const model = render(v.source, PAYLOAD_A);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  assert.deepEqual(Object.fromEntries(tl.blocks.map((b) => [b.id, norm(b.text)])), Object.fromEntries(model.blocks.map((b) => [b.id, norm(b.text)])), "the text layer is the block model's text, block for block (never the writer's own reconstruction)");
  const order = tl.blocks.map((b) => b.id);
  assert.deepEqual(order.slice(0, 3), ["amount_due", "late_fee", "explanation"], "reading order follows the block model");
  assert.equal(p1.payload_hash, payloadHash(PAYLOAD_A));
  const changed = renderNoticePdf(v, { ...PAYLOAD_A, late_charges_due_cents: 11_672n }, { now: T0 });
  assert.notEqual(changed.sha256, p1.sha256, "changing one payload field (the late charge) changes the hash");
});
test("35.2-T2: Given worked example A rendered through the command path, then a `documents` row exists with `mime_type = application/pdf`, `kind = rendered_notice`, `sha256` and `byte_size` equal to the bytes, `page_count ≥ 1`, `retention_class = life_of_loan_plus_4y`, `payload_hash` equal to the canonical payload hash, `notices.document_id` equals that row, exactly one `notice_checklist_results` row exists for the notice across render-then-send, and the text layer contains `$2,334.29`, `$612.50`, `$2,946.79`, `$116.71` and `$6,010.29` each exactly once in the amount-due box.", { skip }, async () => {
  const f = await loanFixture();
  const r = await run("documents.render", { template_code: STMT, payload: PAYLOAD_A, recipients: [BEA()], send: true }, RECORDS, { loanId: f.loanId });
  const out = r.output as { document_id: string; notice_id: string; status: string; sha256: string; page_count: number; template_version: string };
  assert.equal(out.status, "sent"); assert.equal(out.template_version, "1.2.0");
  const id = out.document_id; assert.ok(id, "the render produced a document id");
  const row = await one<{ mime_type: string; kind: string; sha256: string; byte_size: bigint; page_count: number; retention_class: string; payload_hash: string; storage_status: string; template_code: string; template_version: string; text_layer: boolean; loan_id: string; created_at: string }>(
    `SELECT mime_type, kind, sha256, byte_size, page_count, retention_class::text AS retention_class, payload_hash, storage_status, template_code, template_version, text_layer, loan_id, created_at FROM documents WHERE id = $1`, [id]);
  const bytes = (await blobs.get(id))!.bytes;
  assert.equal(row.mime_type, "application/pdf"); assert.equal(row.kind, "rendered_notice"); assert.equal(row.sha256, sha256(bytes)); assert.equal(Number(row.byte_size), bytes.length); assert.equal(row.sha256, out.sha256);
  assert.ok(row.page_count! >= 1); assert.equal(row.retention_class, "life_of_loan_plus_4y"); assert.equal(row.payload_hash, payloadHash(PAYLOAD_A)); assert.equal(row.storage_status, "stored");
  assert.equal(row.template_code, STMT); assert.equal(row.template_version, "1.2.0"); assert.equal(row.text_layer, true); assert.equal(row.loan_id, f.loanId); assert.equal(row.created_at, T0);
  const notice = await one<{ document_id: string | null; status: string; template_version: string }>(`SELECT document_id, status, template_version FROM notices WHERE id = $1`, [out.notice_id]);
  assert.equal(notice.document_id, id, "notices.document_id names the row"); assert.equal(notice.status, "sent");
  assert.equal(await count(`FROM notice_checklist_results WHERE notice_id = $1`, [out.notice_id]), 1, "exactly one checklist row across render-then-send");
  assert.equal(await count(`FROM notice_deliveries WHERE notice_id = $1 AND rendered_document_id = $2`, [out.notice_id, id]), 1, "the mail delivery carries the rendered document");
  assert.ok(r.events.some((e) => e.type === "document.rendered" && e.payload["document_id"] === id) && r.events.some((e) => e.type === "document.stored" && e.payload["document_id"] === id) && r.events.some((e) => e.type === "notice.sent"), "rendered, stored and sent on one log");
  const tl = textLayer(bytes);
  const box = tl.blocks.find((b) => b.id === "amount_due"); assert.ok(box, "the amount-due box is a block of the text layer");
  for (const s of ["$2,334.29", "$612.50", "$2,946.79", "$116.71", "$6,010.29"]) assert.equal(occurrences(box.text, s), 1, `${s} exactly once in the amount-due box: ${box.text}`);
  assert.equal(money(PI), "$2,334.29"); assert.equal(money(ESCROW), "$612.50"); assert.equal(money(MONTHLY), "$2,946.79"); assert.equal(money(LATE_CHARGE), "$116.71"); assert.equal(money(AMOUNT_DUE), "$6,010.29");
  // the same payload rendered again at the same clock is the same row (edge case: a retry is one document)
  const again = await run("documents.render", { template_code: STMT, payload: PAYLOAD_A, recipients: [BEA()] }, RECORDS, { loanId: f.loanId });
  assert.equal((again.output as { document_id: string; existing: boolean }).document_id, id); assert.equal((again.output as { existing: boolean }).existing, true);
  assert.equal((again.output as { sha256: string }).sha256, out.sha256, "documents.render twice at one clock: byte-identical (one sha256)"); assert.equal((await one<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1`, [id])).sha256, out.sha256);
  assert.equal(await count(`FROM documents WHERE template_code = $1 AND payload_hash = $2 AND loan_id = $3`, [STMT, payloadHash(PAYLOAD_A), f.loanId]), 1);
});
test("35.2-T3: Given 10.4's annual PMI disclosure for an MN property, when it renders, then the writer's placements report every body block at ≥ 12 pt and page 1, 10.4's checklist passes from those placements alone (no browser is started), and given the same template with a 10 pt body the checklist fails `layout` and the notice is `held`.", {}, async () => {
  const reg = publishSection10(buildRegistry());
  const mn = reg.activeVersion("NTC_HPA_4903A3_ANNUAL_MN", D("2027-02-20")); assert.ok(mn, "10.4's MN annual disclosure is published");
  const pdf = renderNoticePdf(mn, mn.samplePayload, { now: "2027-02-20T12:00:00.000Z" });
  for (const id of ["body", "mn_statutory", "contact"]) { const p = pdf.placements.find((x) => x.block_id === id); assert.ok(p, `placement for ${id}`); assert.ok(p.pt >= 12, `${id} at ${p.pt} pt`); assert.equal(p.page, 1); }
  const rendered = render(mn.source, mn.samplePayload);
  const fromPlacements = evaluateChecklist(mn, mn.samplePayload, { ...rendered, blocks: blocksFromPlacements(pdf.placements, rendered.blocks) });
  assert.equal(fromPlacements.passed, true, "10.4's checklist passes from the placements alone (no browser)"); assert.ok(fromPlacements.results.some((r) => r.rule_id === "mn-12pt" && r.passed));
  // the same template with a 10 pt body: the checklist fails `layout` and the notice is held. The version is drafted and published with an empty check on purpose —
  // 7.1's "a failing block rule cannot be published" would otherwise refuse it — so the held path can be exercised.
  const ten = mn.source.replace(/(\{\{#block "body"[^}]*pt=)12/, "$110");
  assert.notEqual(ten, mn.source, "the body block's pt attribute was rewritten");
  reg.draft({ templateCode: mn.templateCode, version: "1.0.0-t3-10pt", effectiveFrom: D("2027-01-01"), source: ten, contentRules: mn.contentRules, layoutRules: mn.layoutRules, samplePayload: mn.samplePayload, ruleSet: mn.ruleSet, ...(mn.sampleFormBasis ? { sampleFormBasis: mn.sampleFormBasis } : {}) });
  reg.publish(mn.templateCode, "1.0.0-t3-10pt", "test", "2027-01-01T00:00:00.000Z", () => []);
  const events = new MemoryEventStore(new FixedClock("2027-02-20T12:00:00.000Z"));
  const sink = new MemoryArtifactSink(new FixedClock("2027-02-20T12:00:00.000Z"));
  const svc = new NoticeService({ registry: reg, events, clock: new FixedClock("2027-02-20T12:00:00.000Z"), printMail: new FakePrintMailImpl(), edelivery: new FakeEdelivery(), artifacts: sink });
  const n = svc.render({ templateCode: mn.templateCode, loanId: "L-T3", recipients: [BEA()], payload: mn.samplePayload, asOf: D("2027-02-20") });
  assert.equal(n.templateVersion, "1.0.0-t3-10pt"); assert.equal(n.status, "held"); assert.match(n.heldReason ?? "", /mn-12pt/);
  assert.ok(n.checklist.blocking.some((b) => b.rule_id === "mn-12pt" && !b.passed), "the layout rule failed from the writer's placement of a 10 pt body");
  const held = sink.results.get(n.renderedDocumentId!); assert.ok(held); assert.equal(held.placements.find((p) => p.block_id === "body")!.pt, 10);
  assert.ok(events.all().some((e) => e.type === "notice.held"));
});
test("35.2-T4: Given the FAKE blob store in outage, when `documents.store` runs, then the `documents` row is written with `storage_uri = worm_pending:<id>` and `storage_status = staged`, a `document_blobs` row holds the bytes, `document.staged` is logged and `SM_DOC_WORM_DRAIN_1D` is armed; when the outage clears and the drain runs, then `storage_uri` becomes `fake-blob://<id>#1`, `storage_status = stored`, `stored_generation = 1`, `document.stored` satisfies the clock; a second attempt to change `storage_uri` is refused by the trigger (`URI_SWAP_ONCE`) and a store whose re-read hash differs never swaps.", { skip }, async () => {
  const f = await loanFixture();
  // the object store is down: the row is staged with its bytes beside it, the clock arms
  blobs.outage = true;
  const r = await run("documents.store", storeInput("t4-a"), RECORDS, { loanId: f.loanId });
  const out = r.output as { document_id: string; sha256: string; storage_status: string };
  const id = out.document_id;
  const row = await one<{ storage_uri: string; storage_status: string; sha256: string; byte_size: bigint; stored_generation: string | null }>(`SELECT storage_uri, storage_status, sha256, byte_size, stored_generation FROM documents WHERE id = $1`, [id]);
  assert.equal(row.storage_uri, `worm_pending:${id}`); assert.equal(row.storage_status, "staged"); assert.equal(row.stored_generation, null);
  assert.equal(row.sha256, sha256(PDF_BYTES("t4-a"))); assert.equal(Number(row.byte_size), PDF_BYTES("t4-a").length);
  const blob = await one<{ content: Buffer; staged_at: string; drained_at: string | null }>(`SELECT content, staged_at, drained_at FROM document_blobs WHERE document_id = $1`, [id]);
  assert.ok(Buffer.from(blob.content).equals(PDF_BYTES("t4-a")), "document_blobs holds the bytes"); assert.equal(blob.staged_at, T0); assert.equal(blob.drained_at, null);
  const staged = r.events.find((e) => e.type === "document.staged"); assert.ok(staged, "document.staged is logged");
  assert.equal(staged.payload["document_id"], id); assert.equal(staged.payload["staged_at"], T0); assert.equal(staged.loanId, f.loanId);
  assert.ok(!r.events.some((e) => e.type === "document.stored"), "nothing stored while the store is down");
  const t = r.timers.find((x) => x.code === "SM_DOC_WORM_DRAIN_1D"); assert.ok(t, "SM_DOC_WORM_DRAIN_1D is armed");
  assert.equal(t.status, "armed"); assert.deepEqual(t.subject, { kind: "loan", id: f.loanId }); assert.equal(t.anchorDate, "2026-09-17"); assert.equal(t.dueDate, "2026-09-18");
  // the outage clears and the drain runs: put, re-read, compare, the one swap, document.stored satisfies the clock
  blobs.outage = false;
  const r2 = await run("documents.store", { op: "drain" }, RECORDS, { loanId: f.loanId });
  const drained = r2.output as { drained: number; failed: number };
  assert.equal(drained.drained, 1); assert.equal(drained.failed, 0);
  const row2 = await one<{ storage_uri: string; storage_status: string; stored_generation: string | null; sha256: string }>(`SELECT storage_uri, storage_status, stored_generation, sha256 FROM documents WHERE id = $1`, [id]);
  assert.equal(row2.storage_uri, `fake-blob://${id}#1`); assert.equal(row2.storage_status, "stored"); assert.equal(row2.stored_generation, "1"); assert.equal(row2.sha256, row.sha256, "the hash is the bytes: unchanged by the swap");
  const blob2 = await one<{ drained_at: string | null; drain_generation: string | null }>(`SELECT drained_at, drain_generation FROM document_blobs WHERE document_id = $1`, [id]);
  assert.equal(blob2.drained_at, T0); assert.equal(blob2.drain_generation, "1");
  const stored = r2.events.find((e) => e.type === "document.stored"); assert.ok(stored, "document.stored is logged by the drain");
  assert.equal(stored.payload["document_id"], id); assert.equal(stored.payload["storage_uri"], `fake-blob://${id}#1`); assert.equal(stored.payload["stored_generation"], "1");
  assert.ok(blobs.log.some((l) => l.op === "put" && l.document_id === id) && blobs.log.some((l) => l.op === "get" && l.document_id === id), "the drain put the object and re-read it");
  const timer = await one<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [t.id]); assert.equal(timer.status, "satisfied");
  // a second attempt to change storage_uri is refused by the trigger
  await rejectsSql(db.query(`UPDATE documents SET storage_uri = $2, stored_generation = '2' WHERE id = $1`, [id, `fake-blob://${id}#2`]), /URI_SWAP_ONCE/);
  await rejectsSql(db.query(`UPDATE documents SET storage_uri = $2 WHERE id = $1`, [id, `worm_pending:${id}`]), /URI_SWAP_ONCE/);
  // a store whose re-read hash differs never swaps: the attempt is counted, the staged copy stays the served copy
  blobs.outage = true;
  const id2 = ((await run("documents.store", storeInput("t4-b"), RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  blobs.outage = false; blobs.corruptOnPut(id2);
  const r3 = await run("documents.store", { op: "drain" }, RECORDS, { loanId: f.loanId });
  assert.equal((r3.output as { failed: number }).failed, 1);
  const row3 = await one<{ storage_uri: string; storage_status: string; stored_generation: string | null }>(`SELECT storage_uri, storage_status, stored_generation FROM documents WHERE id = $1`, [id2]);
  assert.equal(row3.storage_status, "staged"); assert.equal(row3.storage_uri, `worm_pending:${id2}`); assert.equal(row3.stored_generation, null);
  const blob3 = await one<{ drain_attempts: number; last_drain_error: string | null; drained_at: string | null }>(`SELECT drain_attempts, last_drain_error, drained_at FROM document_blobs WHERE document_id = $1`, [id2]);
  assert.equal(blob3.drain_attempts, 1); assert.equal(blob3.last_drain_error, "HASH_MISMATCH_ON_PUT"); assert.equal(blob3.drained_at, null);
  assert.ok(r3.events.some((e) => e.type === "document.drain.failed" && e.payload["document_id"] === id2 && e.payload["attempts"] === 1), "the failed attempt is logged");
  assert.ok(!r3.events.some((e) => e.type === "document.stored" && e.payload["document_id"] === id2), "no document.stored for the row whose re-read differed");
  // the next drain retries under a new generation and stores it
  const r4 = await run("documents.store", { op: "drain" }, RECORDS, { loanId: f.loanId });
  assert.equal((r4.output as { drained: number }).drained, 1);
  assert.equal((await one<{ storage_uri: string }>(`SELECT storage_uri FROM documents WHERE id = $1`, [id2])).storage_uri, `fake-blob://${id2}#2`, "retries with a new object name");
});
test("35.2-T5: Given a stored `documents` row, then a raw `UPDATE` of `sha256`, `byte_size`, `kind`, `mime_type`, `retention_class` or `created_at` is refused by `documents_column_restricted`, a `DELETE` is refused, an `UPDATE` of `legal_hold` without `sm.document_hold` set to the row id is refused, and the migration adding the trigger leaves every §1–34 test that inserts `documents` rows green.", { skip }, async () => {
  const f = await loanFixture();
  const id = ((await run("documents.store", storeInput("t5"), RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  assert.equal((await one<{ storage_status: string }>(`SELECT storage_status FROM documents WHERE id = $1`, [id])).storage_status, "stored");
  // the write-once columns
  for (const set of [`sha256 = repeat('0', 64)`, `byte_size = 1`, `kind = 'something_else'`, `mime_type = 'text/plain'`, `retention_class = 'corporate_7y'`, `created_at = now()`, `metadata = '{"x":1}'::jsonb`, `doc_class = 'paystub'`, `payload_hash = repeat('a', 64)`])
    await rejectsSql(db.query(`UPDATE documents SET ${set} WHERE id = $1`, [id]), /documents_column_restricted/);
  await rejectsSql(db.query(`DELETE FROM documents WHERE id = $1`, [id]), /documents_column_restricted/);
  // legal_hold only under the command's setting, and only with the hold log's row
  await rejectsSql(db.query(`UPDATE documents SET legal_hold = true WHERE id = $1`, [id]), /documents_column_restricted: legal_hold changes only inside documents.hold/);
  await rejectsSql(db.tx(async (q) => { await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]); await q.query(`UPDATE documents SET legal_hold = true WHERE id = $1`, [id]); }), /needs an open document_holds\{placed\} row/);
  await db.tx(async (q) => {
    await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]);
    await q.query(`INSERT INTO document_holds (document_id, action, reason, matter_ref, actor_kind, actor_id) VALUES ($1, 'placed', 't5', 'M-T5', 'agent', 'security-records')`, [id]);
    await q.query(`UPDATE documents SET legal_hold = true WHERE id = $1`, [id]);
  });
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true);
  await rejectsSql(db.tx(async (q) => { await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]); await q.query(`UPDATE documents SET legal_hold = false WHERE id = $1`, [id]); }), /needs a human document_holds\{released\} row/);
  // the integrity and disposal columns are the unit's and the run's
  await rejectsSql(db.query(`UPDATE documents SET verify_status = 'verified', last_verified_at = now() WHERE id = $1`, [id]), /sm.integrity_run/);
  await rejectsSql(db.query(`UPDATE documents SET storage_status = 'disposed', disposed_at = now(), disposal_run_id = $2 WHERE id = $1`, [id, randomUUID()]), /disposal only by the attested 19.1 run/);
  // the migration leaves every §1–34 INSERT site green: the shapes of src/runtime/book-ops/report.ts, src/runtime/controls/evidence.ts, src/app/tools/section32-2.ts, section20-3.ts and src/domain/underwriting/du/persist.ts, verbatim in their columns
  const app = await runtime.createApplication({ partner_party_id: f.partnerPartyId, channel: "organic", transaction_type: "limited_cash_out", occupancy: "primary", borrowers: [{ legal_name: "Tee Five" }] }, { kind: "system", id: "test" });
  const shapes: [string, unknown[]][] = [
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, 'partner_book_daily_report', $2, 12, 'report://x', 'application/json', 'corporate_7y', '{}', now())`, [randomUUID(), sha256("a")]],
    [`INSERT INTO documents (id, loan_id, application_id, kind, sha256, byte_size, storage_uri, mime_type, retention_class, metadata, created_at) VALUES ($1, $2, NULL, 'evidence_pack', $3, 12, 'evidence://packs/x', 'application/json', 'corporate_7y', '{}', now())`, [randomUUID(), f.loanId, sha256("b")]],
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, doc_class, source_channel, sender_identity, received_at, subject_borrower_id, page_count, metadata) VALUES ($1, 'origination_document', $2, 3, 'fake-blob://x', 'application/pdf', $3, NULL, 'borrower_upload', '{}', now(), NULL, 0, '{}')`, [randomUUID(), sha256("c"), app.application.id]],
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, retention_class, metadata) VALUES ($1, 'rendered_notice', $2, 3, 'store://documents/x', 'text/html', $3, 'regb_25m', '{}')`, [randomUUID(), sha256("d"), app.application.id]],
    [`INSERT INTO documents (id, kind, sha256, byte_size, storage_uri, mime_type, application_id, retention_class, metadata) VALUES ($1, 'du_request', $2, 3, 'du://x', 'application/xml', $3, 'fnma_loan_file_life_plus_4y', '{}')`, [randomUUID(), sha256("e"), app.application.id]],
  ];
  for (const [sql, params] of shapes) {
    await db.query(sql, params);
    const inserted = await one<{ storage_status: string; verify_status: string }>(`SELECT storage_status, verify_status FROM documents WHERE id = $1`, [params[0]]);
    assert.equal(inserted.storage_status, "staged"); assert.equal(inserted.verify_status, "unverified");
  }
});
test("35.2-T6: Given `documents.hold{place}` by the agent with a `matter_ref`, then `legal_hold = true`, a `document_holds{placed}` row and the FAKE store's hold reference exist and `document.hold.placed` is logged; `documents.dispose` on it is refused `HOLD_ACTIVE`; `documents.hold{release}` by the agent is refused `HOLD_RELEASE_HUMAN_ONLY`; by a human `compliance` actor with a reason it writes the `released` row before the flag clears and `document.hold.released` is logged.", { skip }, async () => {
  const f = await loanFixture();
  const id = ((await run("documents.store", storeInput("t6"), RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  // the agent places a hold with a matter reference
  const placed = await run("documents.hold", { op: "place", document_id: id, reason: "subpoena", matter_ref: "MATTER-1" }, RECORDS, { loanId: f.loanId });
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true);
  const hold = await one<{ action: string; matter_ref: string; actor_kind: string; actor_id: string; blob_hold_ref: string | null; reason: string }>(`SELECT action, matter_ref, actor_kind, actor_id, blob_hold_ref, reason FROM document_holds WHERE document_id = $1 ORDER BY seq`, [id]);
  assert.equal(hold.action, "placed"); assert.equal(hold.matter_ref, "MATTER-1"); assert.equal(hold.actor_kind, "agent"); assert.equal(hold.actor_id, "security-records"); assert.equal(hold.reason, "subpoena");
  assert.match(hold.blob_hold_ref ?? "", /^FAKE:hold:\d+$/, "the FAKE store's hold reference"); assert.equal(blobs.heldObjects().get(id), hold.blob_hold_ref, "the object store honours the hold");
  const ev = placed.events.find((e) => e.type === "document.hold.placed"); assert.ok(ev, "document.hold.placed is logged");
  assert.equal(ev.payload["document_id"], id); assert.equal(ev.payload["reason"], "subpoena"); assert.equal(ev.payload["matter_ref"], "MATTER-1"); assert.equal(ev.payload["by"], "agent:security-records");
  // a held document is never disposed
  await refused(run("documents.dispose", { document_id: id, disposal_run_id: randomUUID() }, OFFICER, { loanId: f.loanId }), "HOLD_ACTIVE");
  // the agent may never release; a human compliance actor with a reason may
  await refused(run("documents.hold", { op: "release", document_id: id, reason: "done" }, RECORDS, { loanId: f.loanId }), "HOLD_RELEASE_HUMAN_ONLY");
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true, "the refusal wrote nothing");
  const released = await run("documents.hold", { op: "release", document_id: id, reason: "matter closed" }, COMPLIANCE, { loanId: f.loanId });
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, false);
  const rows = await db.query<{ action: string; actor_kind: string; actor_role: string | null; reason: string }>(`SELECT action, actor_kind, actor_role, reason FROM document_holds WHERE document_id = $1 ORDER BY seq`, [id]);
  assert.deepEqual(rows.map((r) => [r.action, r.actor_kind, r.actor_role]), [["placed", "agent", null], ["released", "human", "compliance"]]); assert.equal(rows[1]!.reason, "matter closed");
  assert.equal(blobs.heldObjects().has(id), false, "the object store's hold is lifted");
  const rel = released.events.find((e) => e.type === "document.hold.released"); assert.ok(rel, "document.hold.released is logged");
  assert.equal(rel.payload["document_id"], id); assert.equal(rel.payload["reason"], "matter closed"); assert.equal(rel.payload["by"], "human:u-comp-1(compliance)");
  // the released row is written before the flag clears: with the hold placed again, a flip without a released row is refused by the trigger even under the command's setting
  await run("documents.hold", { op: "place", document_id: id, reason: "litigation", matter_ref: "MATTER-2" }, RECORDS, { loanId: f.loanId });
  await rejectsSql(db.tx(async (q) => { await q.query(`SELECT set_config('sm.document_hold', $1, true)`, [id]); await q.query(`UPDATE documents SET legal_hold = false WHERE id = $1`, [id]); }), /needs a human document_holds\{released\} row/);
  // a release for a document under a second, open matter is refused naming the other matter
  await run("documents.hold", { op: "place", document_id: id, reason: "subpoena", matter_ref: "MATTER-3" }, RECORDS, { loanId: f.loanId });
  await refused(run("documents.hold", { op: "release", document_id: id, reason: "one down" }, COMPLIANCE, { loanId: f.loanId }), "HOLD_STILL_REQUIRED");
  const partial = await run("documents.hold", { op: "release", document_id: id, reason: "one down", matter_ref: "MATTER-2" }, COMPLIANCE, { loanId: f.loanId });
  assert.deepEqual((partial.output as { open_matters: string[]; legal_hold: boolean }).open_matters, ["MATTER-3"]); assert.equal((partial.output as { legal_hold: boolean }).legal_hold, true);
  assert.equal((await one<{ legal_hold: boolean }>(`SELECT legal_hold FROM documents WHERE id = $1`, [id])).legal_hold, true, "still held for MATTER-3");
});
test("35.2-T7: Given three notices of one batch decided `mail`, when `mail.batch` runs, then one outbound `mail_manifests` row with `piece_count = 3` and a hashed manifest document exists, each `mail_manifest_pieces` row carries the piece's `document_id`, `sha256`, `page_count`, `sheets = ceil(page_count ÷ 2)`, mail class and address snapshot, one `integration_messages` row addresses the `print-mail` adapter with the batch id as idempotency key, and `SM_MAIL_MANIFEST_2BD` is armed; when the FAKE vendor's proof-of-mailing manifest is ingested, then `notice_deliveries.mailed_at`, `imb` and `mail_manifest_id` are set for all three (and `manifest_id` is the `notice_batches` id, 0009's FK), the inbound manifest is `reconciled`, `mail.manifest.ingested` satisfies the clock and `mail.piece.mailed` is logged three times.", { todo: true });
test("35.2-T8: Given a Spanish-language notice whose payload contains `ñ`, `á`, `¿` and `—`, when it renders, then the text layer round-trips those characters exactly; given a payload containing a character outside WinAnsi (`≥`), then the render is refused `GLYPH_UNSUPPORTED` naming the character and the block and no row is written.", {}, async () => {
  const v = activeStatementVersion();
  const ES = "Señor Peña — ¿está al día? Sí, año. Recibimos su pago; ¡gracias!";
  const pdf = renderNoticePdf(v, { ...PAYLOAD_A, suspense_instructions: ES }, { now: T0 });
  const tl = textLayer(pdf.bytes);
  for (const ch of ["ñ", "á", "¿", "—", "¡"]) assert.ok(tl.text.includes(ch), `${ch} round-trips`);
  assert.equal(tl.blocks.find((b) => b.id === "suspense")!.text, ES, "the text layer round-trips the Spanish text exactly");
  assert.throws(() => renderNoticePdf(v, { ...PAYLOAD_A, suspense_instructions: "Saldo ≥ 12" }, { now: T0 }), (e: unknown) => e instanceof GlyphUnsupported && e.code === "GLYPH_UNSUPPORTED" && e.char === "≥" && e.block_id === "suspense" && /"≥"/.test(e.message) && /block suspense/.test(e.message));
  // through the command path: the render is refused and no row is written
  if (!skip) {
    const f = await loanFixture();
    const docs0 = await count(`FROM documents`); const notices0 = await count(`FROM notices`); const events0 = await count(`FROM loan_events WHERE loan_id = $1`, [f.loanId]); const blobs0 = await count(`FROM document_blobs`);
    await refused(run("documents.render", { template_code: STMT, payload: { ...PAYLOAD_A, suspense_instructions: "Saldo ≥ 12" }, recipients: [BEA()] }, RECORDS, { loanId: f.loanId }), "GLYPH_UNSUPPORTED");
    assert.equal(await count(`FROM documents`), docs0); assert.equal(await count(`FROM notices`), notices0); assert.equal(await count(`FROM loan_events WHERE loan_id = $1`, [f.loanId]), events0); assert.equal(await count(`FROM document_blobs`), blobs0);
  }
});
test("35.2-T9: Given a borrower session at L2 whose party owns a stored statement, when the app requests `GET /v1/borrower/documents/{id}` and then the signed `…/content` URL, then the response is the stored bytes with `Content-Type: application/pdf`, `Cache-Control: private, no-store`, a hash equal to `documents.sha256`, a `document_access_log{purpose=borrower_view}` row and a `ui_events{document_opened}` row; a session of another party receives 404; an expired or altered signature receives 401; a `staged` document is served from `document_blobs` with `served_from = staged_blob`.", { skip }, async () => {
  clock.set(T0);
  const f = await loanFixture(); const emailA = `avery-${uniq()}@example.test`;
  const a = await signInL2(emailA, { tin_last4: "6789", dob: "1985-06-15", loanId: f.loanId });
  const id = ((await run("documents.render", { template_code: STMT, payload: PAYLOAD_A, recipients: [BEA()] }, RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  const row = await one<{ sha256: string; storage_status: string }>(`SELECT sha256, storage_status FROM documents WHERE id = $1`, [id]); assert.equal(row.storage_status, "stored");
  // the link: signed for this session, five minutes, with the row's hash and the bytes' own text layer
  const link = await api("GET", `/v1/borrower/documents/${id}`, undefined, a.token);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const url = link.body["url"] as string; assert.match(url, /^\/v1\/borrower\/documents\/[0-9a-f-]+\/content\?exp=\d+&sig=/);
  assert.equal(link.body["sha256"], row.sha256); assert.ok(String(link.body["text_layer"]).includes("$6,010.29"), "the text layer rides with the link"); assert.equal(link.body["template_version"], "1.2.0");
  // the bytes: the stored ones, hashed on the way out
  const res = await fetch(base + url, { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "application/pdf"); assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.ok((res.headers.get("content-disposition") ?? "").startsWith("inline")); assert.equal(res.headers.get("x-document-sha256"), row.sha256);
  const bytes = Buffer.from(await res.arrayBuffer()); assert.equal(sha256(bytes), row.sha256, "a hash equal to documents.sha256"); assert.ok(bytes.equals((await blobs.get(id))!.bytes));
  const log = await db.query<{ sha256_served: string; served_from: string; party_id: string; session_id: string; byte_size_served: bigint }>(`SELECT sha256_served, served_from, party_id, session_id, byte_size_served FROM document_access_log WHERE document_id = $1 AND purpose = 'borrower_view'`, [id]);
  assert.equal(log.length, 1); assert.equal(log[0]!.sha256_served, row.sha256); assert.equal(log[0]!.served_from, "object_store"); assert.equal(log[0]!.party_id, a.party_id); assert.equal(log[0]!.session_id, a.session_id); assert.equal(Number(log[0]!.byte_size_served), bytes.length);
  const opened = (await new PgBorrowerUiRepository(db).uiEvents(a.party_id, "document_opened")).filter((e) => e.payload["document_id"] === id);
  assert.ok(opened.some((e) => e.payload["route"] === "content" && e.session_id === a.session_id), "ui_events{document_opened} for the serve");
  assert.equal((await db.query(`SELECT 1 FROM loan_events WHERE loan_id = $1 AND type = 'document.opened' AND payload->>'document_id' = $2 AND payload->>'purpose' = 'borrower_view'`, [f.loanId, id])).length, 1, "document.opened on the loan's log, committed with the access row");
  // another party: 404 on the link and on the content URL (ownership before the signature) — the same answer an unknown id gets; never a 403 that confirms the document exists
  const g = await loanFixture(); const b = await signInL2(`blake-${uniq()}@example.test`, { tin_last4: "1111", dob: "1979-01-02", loanId: g.loanId });
  const other = await api("GET", `/v1/borrower/documents/${id}`, undefined, b.token); assert.equal(other.status, 404); assert.equal(other.body["code"], "NOT_YOUR_DOCUMENT");
  const otherContent = await api("GET", url, undefined, b.token); assert.equal(otherContent.status, 404); assert.equal(otherContent.body["code"], "NOT_YOUR_DOCUMENT");
  assert.equal((await api("GET", `/v1/borrower/documents/${randomUUID()}`, undefined, b.token)).status, 404);
  // an expired URL, an altered signature, a stolen URL on another session of the same party: 401
  const expired = await api("GET", url.replace(/exp=\d+/, "exp=1"), undefined, a.token); assert.equal(expired.status, 401); assert.equal(expired.body["code"], "DEEP_LINK_EXPIRED");
  const altered = await api("GET", url.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "A" ? "B" : "A"}`), undefined, a.token); assert.equal(altered.status, 401); assert.equal(altered.body["code"], "URL_SIGNATURE");
  const stolen = await api("GET", url, undefined, await signInAgain(emailA)); assert.equal(stolen.status, 401); assert.equal(stolen.body["code"], "URL_SIGNATURE");
  assert.equal(await count(`FROM document_access_log WHERE document_id = $1`, [id]), 1, "a refused request serves nothing and logs no access");
  // a staged document (the store was down when it was written) is served from document_blobs
  blobs.outage = true;
  const staged = ((await run("documents.store", storeInput("t9-staged", { kind: "rendered_notice" }), RECORDS, { loanId: f.loanId })).output as { document_id: string; storage_status: string });
  blobs.outage = false; assert.equal(staged.storage_status, "staged");
  const link2 = await api("GET", `/v1/borrower/documents/${staged.document_id}`, undefined, a.token); assert.equal(link2.status, 200, JSON.stringify(link2.body));
  const res2 = await fetch(base + (link2.body["url"] as string), { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(res2.status, 200); assert.equal(res2.headers.get("x-served-from"), "staged_blob"); assert.ok(Buffer.from(await res2.arrayBuffer()).equals(PDF_BYTES("t9-staged")));
  assert.equal((await one<{ served_from: string }>(`SELECT served_from FROM document_access_log WHERE document_id = $1 AND purpose = 'borrower_view'`, [staged.document_id])).served_from, "staged_blob");
  // the staff view through the console: the same bytes, a staff_view row naming the staff user
  const staff = await fetch(`${base}/ops/api/documents/${id}/content`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor-id": "u-ops-1", "x-actor-role": "ops_analyst" } });
  const sb = (await staff.json()) as Record<string, unknown>; assert.equal(staff.status, 200, JSON.stringify(sb));
  assert.equal(sb["sha256"], row.sha256); assert.equal(sha256(Buffer.from(String(sb["bytes_base64"]), "base64")), row.sha256); assert.ok(String(sb["text_layer"]).includes("$6,010.29"));
  assert.equal((await one<{ staff_user_id: string | null }>(`SELECT staff_user_id FROM document_access_log WHERE document_id = $1 AND purpose = 'staff_view'`, [id])).staff_user_id, "u-ops-1");
  assert.equal((await fetch(`${base}/ops/api/documents/${id}/content`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor-id": "u-aud-1", "x-actor-role": "auditor" } })).status, 403, "a role documents.open does not admit");
});
test("35.2-T10: Given 16.1 renders `NTC_REGZ_36C3_PAYOFF_STMT` for the fixture loan, then the PDF's text layer contains the 12-character verification token and the wire fraud warning, `payoff_statements.delivered_to[].evidence_document_id` names the `documents` row, and `GET /verify/{token}` answers the statement hash equal to that row's `sha256`, its good-through date and total, and writes `document_access_log{purpose=verify_portal}`.", { skip }, async () => {
  clock.set(T0);
  const f = await loanFixture();
  const PAYOFF: Actor = { kind: "agent", id: "payoff-release" };
  const run16 = (name: string, input: ToolInput): Promise<ExecuteResponse> => runtime.execute({ process: "16.1", name, loanId: f.loanId, actor: PAYOFF, input });
  const quoteId = `pq-${uniq()}`; const statementId = `ps-${uniq()}`;
  // 16.1's worked example A on the fixture loan: the quote, the minted token, the accuracy gate, the statement — 16.1's own steps (16-1.spec.test.ts issue())
  const q = (await run16("computePayoffQuote", { loan_id: f.loanId, quote_id: quoteId, request_id: `pr-${uniq()}`, channel: "email", received_on: "2026-09-14", requester_type: "borrower", upb_cents: 24_831_055n, rate_pct: "6.500", lpi_due: "2026-09-01", good_through: "2026-10-15", late_charges_cents: 8_217n, recording_fee_cents: 3_400n, state: "OH", ledger_snapshot_id: "ledger-hwm-88121" })).output as { hash: string; total_cents: bigint };
  const tok = (await run16("mintVerificationToken", { loan_id: f.loanId, statement_hash: q.hash, wire_instruction_version_id: "wire-v4" })).output as { token: string };
  assert.match(tok.token, /^[A-HJ-NP-Z2-9]{12}$/, "the 12-character token from 16.1's alphabet");
  await run16("assertAccuracyGate", { loan_id: f.loanId, quote_id: quoteId, ledger_clean: true, rate_segments_final: true });
  await run16("renderStatement", { loan_id: f.loanId, quote_id: quoteId, statement_id: statementId, wire_instruction_version_id: "wire-v4", active_wire_instruction_version_id: "wire-v4", verification_token: tok.token });
  const display = Object.fromEntries(Object.entries(registryWithAuthored().activeVersion("NTC_REGZ_36C3_PAYOFF_STMT", D("2026-09-17"))!.samplePayload).filter(([k]) => !(FIGURE_KEYS as readonly string[]).includes(k)));   // 16-1.spec.test.ts DISPLAY(): the figures come from the rows
  const sent = await run16("sendNotice", { loan_id: f.loanId, template_code: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: statementId, recipients: [{ party_id: BEA().partyId, channel: "mail", address: "1 Test St, Testville OH 43001" }], payload: display });
  const so = sent.output as { notice_id: string; checklist_passed: boolean }; assert.ok(so.notice_id, "the statement went out as a notice");
  // the statement row names its rendered documents row as the delivery evidence
  const stmt = decodeEntityData((await one<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'payoff_statements' AND id = $1`, [statementId])).data);
  const delivered = stmt["delivered_to"] as { evidence_document_id: string | null; channel: string }[]; assert.equal(delivered.length, 1);
  const docId = delivered[0]!.evidence_document_id; assert.ok(docId, "delivered_to[].evidence_document_id names the documents row");
  const doc = await one<{ sha256: string; template_code: string; kind: string; storage_status: string }>(`SELECT sha256, template_code, kind, storage_status FROM documents WHERE id = $1`, [docId]);
  assert.equal(doc.template_code, "NTC_REGZ_36C3_PAYOFF_STMT"); assert.equal(doc.kind, "rendered_notice"); assert.equal(doc.storage_status, "stored");
  assert.equal((await one<{ document_id: string | null }>(`SELECT document_id FROM notices WHERE id = $1`, [so.notice_id])).document_id, docId);
  // the text layer: the token and the wire-fraud warning, on the page
  const text = textLayer((await blobs.get(docId))!.bytes).text.replace(/\s+/g, " ");
  assert.ok(text.includes(`Verification token ${tok.token}`), `the token is printed: ${text.slice(0, 200)}`);
  assert.match(text, /never change wire instructions by e-?mail/i, "the wire fraud warning");
  assert.equal(String(stmt["total_cents"]), String(q.total_cents)); assert.equal(String(stmt["good_through"]), "2026-10-15");
  // the public portal: the statement's hash (the row's — the served bytes re-hashed), the good-through date and the total; never a name or an address
  const v = await fetch(`${base}/verify/${tok.token}`); const vb = (await v.json()) as Record<string, unknown>;
  assert.equal(v.status, 200, JSON.stringify(vb));
  assert.equal(vb["verified"], true); assert.equal(vb["statement_sha256"], doc.sha256); assert.equal(vb["document_id"], docId); assert.equal(vb["statement_id"], statementId);
  assert.equal(String(vb["good_through"]), String(stmt["good_through"])); assert.equal(String(vb["total_cents"]), String(stmt["total_cents"])); assert.equal(vb["wire_instruction_version_id"], "wire-v4");
  for (const k of Object.keys(vb)) assert.ok(!/name|address|account|tin|ssn|email|phone/i.test(k), `the portal answers no identity: ${k}`);
  assert.equal(await count(`FROM document_access_log WHERE document_id = $1 AND purpose = 'verify_portal'`, [docId]), 1);
  assert.equal((await fetch(`${base}/verify/ZZZZZZZZZZZZ`)).status, 404); assert.equal((await fetch(`${base}/verify/not-a-token`)).status, 404);
});
test("35.2-T11: Given the FAKE store is told to alter one stored object's bytes, when the daily integrity unit completes, then a `document_integrity_runs` row counts it, a `document_integrity_findings{mismatch}` row carries the expected and actual hashes, `documents.verify_status = mismatch`, `document.integrity.mismatch` is logged, a sev 1 escalation to `ciso` exists, `documents.dispose` on it is refused (19.1-T12), the run never re-rendered anything (the writer is not invoked), and `document.integrity.run_completed` satisfies today's `SM_DOC_INTEGRITY_DAILY` and re-arms it for tomorrow at 02:30 ET.", { skip }, async () => {
  const f = await loanFixture();
  const id = ((await run("documents.store", storeInput("t11"), RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  // day one, 02:30 America/New_York: every stored object re-read and hashed; the clock armed on the global subject
  clock.set("2026-09-17T06:30:00.000Z");
  const r1 = await run("documents.verify", { op: "run" });
  const o1 = r1.output as { run_id: string; as_of_date: string; scope: string; mismatches: number; missing: number; documents_checked: number; verified: number; report_document_id: string };
  assert.equal(o1.as_of_date, "2026-09-17"); assert.equal(o1.scope, "full"); assert.equal(o1.mismatches, 0); assert.equal(o1.missing, 0); assert.ok(o1.documents_checked >= 1); assert.equal(o1.verified, o1.documents_checked);
  const t1 = r1.timers.find((t) => t.code === "SM_DOC_INTEGRITY_DAILY"); assert.ok(t1, "SM_DOC_INTEGRITY_DAILY is armed by the completion"); assert.equal(t1.status, "armed"); assert.equal(t1.subject.kind, "global"); assert.equal(t1.anchorDate, "2026-09-17");
  assert.equal((await one<{ verify_status: string }>(`SELECT verify_status FROM documents WHERE id = $1`, [id])).verify_status, "verified");
  // the store alters the object; day two's run finds it
  await blobs.corrupt(id);
  const altered = (await blobs.get(id))!.bytes; assert.notEqual(sha256(altered), sha256(PDF_BYTES("t11")));
  clock.set("2026-09-18T06:30:00.000Z");
  const before = writerStats().renders;
  const r2 = await run("documents.verify", { op: "run" });
  assert.equal(writerStats().renders, before, "the run never re-rendered anything: the writer was not invoked");
  const o2 = r2.output as typeof o1;
  assert.equal(o2.as_of_date, "2026-09-18"); assert.equal(o2.mismatches, 1); assert.ok(o2.documents_checked >= 1);
  const runRow = await one<{ scope: string; documents_checked: number; mismatches: number; report_document_id: string | null; finished_at: string }>(`SELECT scope, documents_checked, mismatches, report_document_id, finished_at FROM document_integrity_runs WHERE id = $1`, [o2.run_id]);
  assert.equal(runRow.scope, "full"); assert.equal(runRow.mismatches, 1); assert.equal(runRow.documents_checked, o2.documents_checked); assert.ok(runRow.report_document_id);
  const report = await one<{ mime_type: string; kind: string; retention_class: string }>(`SELECT mime_type, kind, retention_class::text AS retention_class FROM documents WHERE id = $1`, [runRow.report_document_id]);
  assert.equal(report.mime_type, "application/x-ndjson"); assert.equal(report.kind, "integrity_report"); assert.equal(report.retention_class, "corporate_7y");
  const finding = await one<{ finding: string; expected_sha256: string; actual_sha256: string; stored_generation: string; escalation_id: string | null; staged_copy_exists: boolean }>(`SELECT finding, expected_sha256, actual_sha256, stored_generation, escalation_id, staged_copy_exists FROM document_integrity_findings WHERE run_id = $1 AND document_id = $2`, [o2.run_id, id]);
  assert.equal(finding.finding, "mismatch"); assert.equal(finding.expected_sha256, sha256(PDF_BYTES("t11"))); assert.equal(finding.actual_sha256, sha256(altered)); assert.equal(finding.stored_generation, "1"); assert.ok(finding.escalation_id); assert.equal(finding.staged_copy_exists, true);
  const d = await one<{ verify_status: string; last_verified_at: string; storage_status: string }>(`SELECT verify_status, last_verified_at, storage_status FROM documents WHERE id = $1`, [id]);
  assert.equal(d.verify_status, "mismatch"); assert.equal(d.last_verified_at, "2026-09-18T06:30:00.000Z"); assert.equal(d.storage_status, "stored");
  const ev = r2.events.find((e) => e.type === "document.integrity.mismatch" && e.payload["document_id"] === id); assert.ok(ev, "document.integrity.mismatch is logged");
  assert.equal(ev.payload["expected_sha256"], finding.expected_sha256); assert.equal(ev.payload["actual_sha256"], finding.actual_sha256); assert.equal(ev.payload["escalation_id"], finding.escalation_id); assert.equal(ev.loanId, f.loanId);
  const esc = await one<{ kind: string; owner_role: string; status: string; severity: string }>(`SELECT kind, owner_role, status, severity FROM escalations WHERE id = $1`, [finding.escalation_id]);
  assert.equal(esc.kind, "sev1"); assert.equal(esc.owner_role, "ciso"); assert.equal(esc.status, "open");
  // 19.1-T12: disposal of a mismatched object is refused before anything else is asked
  await refused(run("documents.dispose", { document_id: id, disposal_run_id: randomUUID() }, OFFICER, { loanId: f.loanId }), "WORM_INTEGRITY_FAILED_SEV1");
  // the report lists the finding; the run's completion satisfies today's clock and re-arms it for tomorrow 02:30 ET
  const ndjson = (await blobs.get(runRow.report_document_id!))!.bytes.toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(ndjson[0]!["run_id"], o2.run_id); assert.ok(ndjson.slice(1).some((l) => l["document_id"] === id && l["finding"] === "mismatch"));
  assert.ok(r2.events.some((e) => e.type === "document.integrity.run_completed" && e.payload["run_id"] === o2.run_id && e.payload["mismatches"] === 1));
  const timers = await db.query<{ status: string; anchor_date: string; due_at: string | null; subject_kind: string }>(`SELECT status, anchor_date::text AS anchor_date, due_at, subject_kind FROM timers WHERE code = 'SM_DOC_INTEGRITY_DAILY' ORDER BY armed_at`);
  assert.deepEqual(timers.map((t) => [t.status, t.anchor_date, t.subject_kind]), [["satisfied", "2026-09-17", "global"], ["armed", "2026-09-18", "global"]]);
  assert.equal(Date.parse(timers[1]!.due_at!), zonedEpochMs(D("2026-09-19"), "02:30", "America/New_York"), "tomorrow at 02:30 America/New_York");
  // a later run never returns the object to verified
  clock.set("2026-09-19T06:30:00.000Z"); blobs.restore(id);
  await run("documents.verify", { op: "run" });
  assert.equal((await one<{ verify_status: string }>(`SELECT verify_status FROM documents WHERE id = $1`, [id])).verify_status, "mismatch", "a mismatch never returns to verified by a later run");
  clock.set(T0);
});
test("35.2-T12: Given worked example B's `tax_forms_1098` row, when `documents.render{document_kind=irs_1098_copy_b}` runs, then the PDF's text layer shows `$5,743.99` in Box 1 and `$400,000.00` in Box 2, the payer TIN as `XXX-XX-1234`, the recipient/lender TIN in full and no other full TIN, the tax year, form number and form name together in one area, a direct-access telephone number, the two Pub. 1179 §4.4.1 legends, and the row's `box1_cents = 574399` and `box2_cents = 40000000` are what the page reproduces; the monthly interest figures `$1,916.67`, `$1,914.67` and `$1,912.65` are the 2.1 allocations the box sums.", { skip }, async () => {
  // worked example B: 2.1's allocation, rounded half-up to the cent once per month
  const rate = ratePercent("5.750");
  const oct = monthlyInterest(40_000_000n, rate); assert.equal(oct, 191_667n);                       // 400,000.00 × 5.750% ÷ 12 = 1,916.6667 → $1,916.67
  const upbNov = 40_000_000n - (PI - oct); assert.equal(upbNov, 39_958_238n);                        // principal 417.62
  const nov = monthlyInterest(upbNov, rate); assert.equal(nov, 191_467n);                             // 399,582.38 × 5.750% ÷ 12 = 1,914.6656 → $1,914.67
  const upbDec = upbNov - (PI - nov); assert.equal(upbDec, 39_916_276n);                              // principal 419.62
  const dec = monthlyInterest(upbDec, rate); assert.equal(dec, 191_265n);                             // 399,162.76 × 5.750% ÷ 12 = 1,912.6549 → $1,912.65
  const box1 = oct + nov + dec; assert.equal(box1, 574_399n); const box2 = 40_000_000n;
  assert.equal(money(box1), "$5,743.99"); assert.equal(money(box2), "$400,000.00"); assert.equal(money(oct), "$1,916.67"); assert.equal(money(nov), "$1,914.67"); assert.equal(money(dec), "$1,912.65"); assert.equal(money(123_456n), "$1,234.56");
  const f = await loanFixture();
  const party = await one<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('borrower', 'Bea Borrower') RETURNING id`);
  const form = await one<{ id: string }>(`INSERT INTO tax_forms_1098 (loan_id, tax_year, payer_party_id, boxes) VALUES ($1, 2026, $2, $3::jsonb) RETURNING id`, [f.loanId, party.id, JSON.stringify({ box1_cents: box1.toString(), box2_cents: box2.toString(), box3_origination_date: "2026-09-15" })]);
  const r = await run("documents.render", { document_kind: "irs_1098_copy_b", tax_form_1098_id: form.id, payer: { name: "Bea Borrower", address: "1 Test St, Testville TX 75001", tin_last4: "1234" }, direct_access_phone: "(800) 555-0199", account_last4: "4321" }, RECORDS, { loanId: f.loanId });
  const out = r.output as { document_id: string; box1_cents: string; box2_cents: string; sha256: string; placements: { block_id: string; page: number }[] };
  assert.equal(out.box1_cents, "574399"); assert.equal(out.box2_cents, "40000000");
  const row = await one<{ box1: string; box2: string }>(`SELECT boxes->>'box1_cents' AS box1, boxes->>'box2_cents' AS box2 FROM tax_forms_1098 WHERE id = $1`, [form.id]);
  assert.equal(row.box1, "574399"); assert.equal(row.box2, "40000000");
  const bytes = (await blobs.get(out.document_id))!.bytes; const tl = textLayer(bytes); const text = tl.text;
  assert.ok(tl.blocks.find((b) => b.id === "box1")!.text.endsWith("$5,743.99"), "Box 1 shows $5,743.99"); assert.ok(tl.blocks.find((b) => b.id === "box2")!.text.endsWith("$400,000.00"), "Box 2 shows $400,000.00");
  assert.ok(text.includes("PAYER'S/BORROWER'S TIN: XXX-XX-1234"), "the payer TIN truncated to its last four");
  assert.ok(text.includes(`RECIPIENT'S/LENDER'S TIN: ${SM_FILER.tin}`), "the recipient/lender TIN in full");
  assert.equal(text.match(/\b\d{3}-\d{2}-\d{4}\b/g), null, "no full SSN-shaped TIN anywhere"); assert.deepEqual(text.match(/\b\d{2}-\d{7}\b/g), [SM_FILER.tin], "the filer's EIN is the only full TIN");
  const header = tl.blocks.find((b) => b.id === "header")!; assert.equal(header.text, "2026 Form 1098 Mortgage Interest Statement"); assert.equal(header.page, 1);
  assert.ok(text.includes("Call (800) 555-0199 to reach an individual who can answer them"), "a direct-access telephone number");
  assert.equal(tl.blocks.find((b) => b.id === "legend_1")!.text, LEGEND_1, "Pub. 1179 §4.4.1 legend (1) verbatim"); assert.equal(tl.blocks.find((b) => b.id === "legend_2")!.text, LEGEND_2, "Pub. 1179 §4.4.1 legend (2) verbatim");
  assert.equal(LEGEND_1, "The information in boxes 1 through 9 and 11 is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if the IRS determines that an underpayment of tax results because you overstated a deduction for the mortgage interest or for these points, reported in boxes 1 and 6; or because you did not report the refund of interest (box 4); or because you claimed a nondeductible item.");
  assert.equal(LEGEND_2, "*Caution: The amount shown may not be fully deductible by you. Limits based on the loan amount and the cost and value of the secured property may apply. Also, you may only deduct interest to the extent it was incurred by you, actually paid by you, and not reimbursed by another person.");
  assert.ok(text.includes("Instructions for Payer/Borrower"), "the instructions to the recipient"); assert.ok(tl.blocks.some((b) => b.id === "instructions_7" && /Box 2\. Shows the outstanding principal on the mortgage as of January 1/.test(b.text)), "the box-by-box instructions as on the official Copy B");
  const doc = await one<{ kind: string; retention_class: string; template_code: string; sha256: string; storage_status: string }>(`SELECT kind, retention_class::text AS retention_class, template_code, sha256, storage_status FROM documents WHERE id = $1`, [out.document_id]);
  assert.equal(doc.kind, "irs_1098_copy_b"); assert.equal(doc.retention_class, "tax_4y"); assert.equal(doc.template_code, "IRS_1098_COPY_B"); assert.equal(doc.sha256, sha256(bytes)); assert.equal(doc.storage_status, "stored");
});
test("35.2-T13: Given a borrower with an active E-SIGN consent covering `disclosure_ack` and a rendered CD, when `esign.envelope.create` and `esign.envelope.send` run, then the envelope is `sent`, `esign.envelope.sent` is logged and `SM_ESIGN_ENVELOPE_EXPIRY_30` is armed on `sent_at`; when the FAKE signer signs every required field through an L2 session, then `esign_signature_events` holds `viewed`, `authenticated`, `consent_affirmed`, one `field_signed` per field and `completed`, each with `auth_method`, `ip`, `user_agent` and a valid hash chain, a signed `documents` row exists with `supersedes_document_id` = the unsigned row and a different `sha256`, `esign_envelope_documents.signed_document_id` is set once, `evidence_document_id` names an audit-trail PDF whose text lists every event, and `esign.envelope.completed` satisfies the clock.", { todo: true });
test("35.2-T14: Given a party with no active E-SIGN consent, when `esign.envelope.send` runs, then it is refused `NO_ENVELOPE_WITHOUT_CONSENT` and nothing is written; given a sent envelope whose signer emits `consent.esign.withdrawn`, then the envelope is `voided` with the reason and an audit-trail PDF; given a sent envelope untouched for 30 calendar days, then the breach voids it as `expired`, logs `esign.envelope.expired` and opens an `ops_analyst` escalation; a `completed` envelope refuses `esign.envelope.void`.", { todo: true });
test("35.2-T15: Given 26.2's FAKE RON session completes worked example 1 of 26.2, when the platform's audit trail arrives, then `documents.store` writes it with `retention_class = fnma_enote_signing_life_plus_7y`, `signing_sessions.audit_trail_document_id` names the row and `audit_trail_hash` equals its `sha256`, the signed closing documents are rows with `closing_documents.signed_document_id` set, and 26.2's `SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE` evaluator opens on that hash.", { todo: true });
test("35.2-T16: Given a document rendered and stored on runtime A, when runtime B (a second `Runtime` over the same database, its own process) serves `…/content` and runs `documents.verify` on it, then the bytes and hash are the stored ones — the FAKE object store is `document_blobs`, not process memory — and the borrower's `/doc/{id}` page renders the PDF with its text layer from that response.", { skip }, async () => {
  clock.set(T0);
  const f = await loanFixture();
  const a = await signInL2(`t16-${uniq()}@example.test`, { tin_last4: "2222", dob: "1990-02-02", loanId: f.loanId });
  const id = ((await run("documents.render", { template_code: STMT, payload: PAYLOAD_A, recipients: [BEA()] }, RECORDS, { loanId: f.loanId })).output as { document_id: string }).document_id;
  const row = await one<{ sha256: string }>(`SELECT sha256 FROM documents WHERE id = $1`, [id]);
  // runtime B: its own pool, its own object-store port, its own server — the same database and the same session table
  const dbB = connect(DB_URL); const blobsB = new PgFakeBlobStore(dbB);
  const runtimeB = new Runtime({ db: dbB, registry: loadOverriddenRegistry(), clock, ports: fakePorts(), blobs: blobsB });
  const serverB = createApiServer({ runtime: runtimeB, apiToken: TOKEN, logger, console: false, borrowerRouter: createBorrowerRouter({ runtime: runtimeB, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret", blobs: blobsB }) });
  const baseB = `http://127.0.0.1:${await listen(serverB, 0, "127.0.0.1")}`;
  try {
    assert.equal(blobsB.log.length, 0, "runtime B's store holds nothing in memory");
    const link = await fetch(`${baseB}/v1/borrower/documents/${id}`, { headers: { authorization: `Bearer ${a.token}` } }); const lb = (await link.json()) as Record<string, unknown>;
    assert.equal(link.status, 200, JSON.stringify(lb)); assert.equal(lb["sha256"], row.sha256);
    const res = await fetch(baseB + String(lb["url"]), { headers: { authorization: `Bearer ${a.token}` } }); assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(sha256(bytes), row.sha256); assert.equal(res.headers.get("x-document-sha256"), row.sha256);
    assert.ok(bytes.equals((await blobs.get(id))!.bytes), "runtime B serves the bytes runtime A stored: the FAKE object store is document_blobs, not process memory");
    assert.equal(lb["text_layer"], textLayer(bytes).text, "the link's text layer is the bytes' own");
    assert.ok(String(lb["text_layer"]).includes("$6,010.29") && String(lb["text_layer"]).includes("Amount due"));
    const v = await runtimeB.execute({ process: "35.2", name: "documents.verify", loanId: f.loanId, actor: RECORDS, input: { op: "one", document_id: id } });
    const vo = v.output as { status: string; expected_sha256: string; actual_sha256: string };
    assert.equal(vo.status, "verified"); assert.equal(vo.expected_sha256, row.sha256); assert.equal(vo.actual_sha256, row.sha256);
    assert.equal((await one<{ verify_status: string }>(`SELECT verify_status FROM documents WHERE id = $1`, [id])).verify_status, "verified");
    assert.equal(await count(`FROM document_access_log WHERE document_id = $1 AND purpose = 'borrower_view'`, [id]), 1, "B's serve is logged in the shared table");
    // the borrower's /doc/{id} page on the built shell over runtime B's API: the PDF through the signed URL, the text layer from the link's response
    const pageSrc = readFileSync(`${APP_DIR}app/doc/[id]/page.tsx`, "utf8"); const viewerSrc = readFileSync(`${APP_DIR}components/viewer/DocumentViewer.tsx`, "utf8");
    assert.ok(pageSrc.includes("DocumentViewer")); assert.ok(viewerSrc.includes('data-testid="doc-text-layer"') && viewerSrc.includes("/v1/borrower/documents/") && viewerSrc.includes("<object") && viewerSrc.includes("text_layer") && viewerSrc.includes("document.unavailable"));
    if (shellAvailable()) {
      browserLock ??= await acquireBrowserLock(DB_URL);
      const { page, ctx } = await pageFor(baseB, a.token, `/app/doc/${id}`);
      try {
        const obj = page.locator("object[type='application/pdf']"); await obj.waitFor({ state: "attached", timeout: 30_000 });
        assert.match((await obj.getAttribute("data")) ?? "", new RegExp(`^/app/api/v1/borrower/documents/${id}/content\\?exp=\\d+&sig=`), "the PDF is loaded through the proxy at the signed URL");
        const text = await page.getByTestId("doc-text-layer").innerText();
        assert.ok(text.includes("$6,010.29") && text.includes("Amount due"), `the text layer renders from the link's response: ${text.slice(0, 120)}`);
      } finally { await ctx.close(); }
    } else {
      process.stderr.write("35.2-T16: reduced page assertion — the borrower app's dependencies or Chromium are not installed here; the source-level checks ran, the Playwright drive did not\n");
    }
  } finally { await new Promise((r) => serverB.close(() => r(undefined))); await dbB.end(); }
});
test("35.2-T17: Given the FAKE print vendor in outage for two consecutive sweeps with a batch submitted, when `mail.fallback` runs, then a `mail_manifests{vendor=in_house}` row exists with one merged PDF per mail class whose page count is the sum of the pieces' plus one cover sheet each, `mail.batch.submitted{vendor=in_house}` is logged, an `ops_analyst` escalation names the batch, and the analyst's `mail.manifest.ingest` with `mailed_on` per piece writes `notice_deliveries.mailed_at` and satisfies `SM_MAIL_MANIFEST_2BD`.", { todo: true });
test("35.2-T18: Given every 35.2 tool run over the fixture, then no ledger line and no money column changed (a contract test compares the ledger and every `*_cents` column before and after), `documents.dispose` without a 19.1 disposal run carrying an `officer` attestation is refused `DISPOSE_NEEDS_OFFICER_ATTESTATION`, an agent actor calling `esign.envelope.sign` is refused `NO_AGENT_SIGNS`, every state-changing tool left an `agent_decisions` row with `rule_set_version = docs.v1` and no decision row contains a TIN, an address or rendered text.", { todo: true });
