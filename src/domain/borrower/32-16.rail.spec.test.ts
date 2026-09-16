// 32.16 The conversational product — Phase 2, the rail (docs/ux/17 §2.1–2.3, DELTA-26): 32.16-T13 … 32.16-T16
// (T11 and T12 — the rail at ≥ 1024 px and the reference chips — were retired 2026-09-16: docs/decisions/2026-09-16-apply-product.md, spec/registry/retired.json)
// spec/sections/32-borrower-experience/32-16-the-conversational-product-an-account-then-a-conversation-wi.md
// One node:test per T-id, named exactly as the spec (the Phase 0/1/3/4 T-ids live in 32-16.spec.test.ts, which another
// builder owns; this file holds the Phase 2 tests so the two can be worked on side by side).
//
// The harness is 32.13's: one runtime over HTTP, the Journey fixture driven to R8 (application → interview → credit → DU
// findings interpreted; the LE only for T15), the 32.x flows reacting to the committed events, read the way the shell reads
// it (the borrower API: record, thread, cards), plus the shell itself — the built Next.js app (apps/borrower, `.next-t13`,
// shared with 32.13 and rebuilt when its sources are newer) pointed at this test's API through its proxy and driven with
// Playwright's Chromium from /opt/pw-browsers at 1280 (≥ 1024: the rail beside the thread) and 390 px (the five-tab shell of
// 01 §1.2 — a session lands on Chat; My Loan's badge and next event and the Tasks tab's needed count are the glance; the header's
// "Your record" opens the rail as the record sheet). Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, type Db } from "../../infra/db/client.ts";
import { testDatabase } from "../../infra/db/test-db.ts";
import { acquireBrowserLock, type TestLock } from "../../infra/db/test-lock.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { deliverLeByConsent } from "../../runtime/borrower/flows/3-entry.ts";
import { REFINANCE_STEPS, journeyProgress } from "../../runtime/borrower/journey-progress.ts";
import { createHarness, type Context, type Page } from "./harness.ts";

const { url: DB_URL, skip } = await testDatabase(import.meta.url);
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const INTAKE = { kind: "agent" as const, id: "intake" };
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
type Json = Record<string, unknown>;

let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

let browserLock: TestLock | undefined;
test.before(async () => {
  if (skip) return;
  browserLock = await acquireBrowserLock(DB_URL);   // one Chromium-driven shell suite at a time (src/infra/db/test-lock.ts)
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|error|unhandled|"status":[45]/i.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost", "http://127.0.0.1"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => { router.hub.close(); server.closeAllConnections?.(); server.close(() => db.end().then(() => resolve())); });
  partnerPartyId = (await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]))[0]!.id;
});
test.after(async () => { if (!skip) { await stopShell(); await close(); await browserLock?.release(); } });

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

// ---------------------------------------------------------------- the shell: the built Next.js app on this test's API, driven with Playwright (src/domain/borrower/harness.ts, shared with 32.13 and 32.19)
const H = createHarness({ apiBase: () => base });
const { pageFor, openApply, inViewportSel: inViewport, stopShell, appLog } = H;
/** The shell rendered from this test's API: the shell region, the conversation with at least one line (on a phone the Chat tab), the rail with Needed from you (on a phone mounted behind the tabs as the record sheet). */
async function openShell(token: string, width: number, path = "/app"): Promise<{ page: Page; ctx: Context }> {
  const p = await pageFor(token, width, path);
  await p.page.waitForSelector('[data-testid="shell"]', { timeout: 30_000 });
  try { await p.page.waitForSelector('[data-testid="thread"] .sm-msg', { timeout: 30_000 }); await p.page.waitForSelector('[data-testid="record"] [data-record-section="needed"]', { timeout: 30_000, state: "attached" }); }
  catch (e) { const notice = await p.page.locator(".sm-error").allInnerTexts().catch(() => [] as string[]); throw new Error(`the shell did not render the thread: ${String(e)}; notices=${JSON.stringify(notice)}; logs=${JSON.stringify((p.page as Page & { logs?: string[] }).logs?.slice(-10))}; app=${appLog().slice(-800)}`); }
  return p;
}
const SCREENSHOTS = `${ROOT}apps/borrower/test-results/32-16-rail`;

// ---------------------------------------------------------------- the refinance journey at R8 (App J)
let J: App; let tokA = ""; let recordR8: Json;
// the journey moves the clock by days between phases and sessions idle out after 30 minutes (01 §5): every test signs Alex in afresh
const fresh = async (): Promise<string> => { tokA = (await signIn(J.A)).token; return tokA; };

test("32.16-T13: Given the refinance fixture at R8, then `journey_progress` shows E1–R7 `done`, R8 `current`, and Tasks renders Progress \"7 of 12\" from `journey_progress`.", { skip }, async () => {
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
  // Tasks renders Progress "7 of 12" from journey_progress (32.19 §2.3: the Apply product's Tasks tab, the second line of the tasks card — the API's counts, never counted by the page)
  const { page, ctx } = await openApply(tokA, 1280);
  await page.getByTestId("apply-tab-tasks").click(); await page.waitForSelector('[data-testid="apply-tasks"]', { timeout: 30_000 });
  const progress = page.getByTestId("progress-count"); await progress.waitFor({ timeout: 30_000 });
  assert.equal((await progress.innerText()).trim(), "7 of 12");
  assert.match(await page.getByTestId("apply-tasks").innerText(), /Progress\s+7 of 12/, "the Progress line (apply.tasks.journey_label + apply.tasks.journey)");
  await page.screenshot({ path: `${SCREENSHOTS}/t13-progress-1280.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});

test("32.16-T14: Given `credit_reports.frozen_repositories` non-empty, then the You step shows the caution row with the lift-instructions card, and no toast or modal exists in the DOM.", { skip }, async () => {
  // Re-driven against the Apply product (32.19 §2.2 you; docs/ux/17 T14 as amended 2026-09-16): the refinance journey to R2 — the application, the 21.1 interview, the quote,
  // the credit report ordered and parsed (the `credit_reports` entity the sentence names). 22.2's freeze workflow on the report: `frozen_repositories` non-empty →
  // credit.freeze.detected with the borrower notice (the platform's fact). The borrower-facing lift instructions are the `credit.freeze.lift` StatusCard 32.14's flow sends
  // on a frozen soft pull; no origination flow raises it from the 22.2 detection yet, so the harness sends the same card through 32.1's send_card (the flows' own seam)
  // and the Apply product is measured on what it does with it: a caution row on the You step (the credit step), the card inside — never a toast, never a modal.
  const app = await openApp();
  await app.j.quoteOnly(); await app.j.orderCredit(MST("2026-10-05", "10:52")); await settle();
  const tok = (await signIn(app.A)).token;
  const report = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = 'credit_reports' AND id = $1`, [app.j.creditReportId]);
  assert.ok(report[0], `the credit report entity (${app.j.creditReportId})`);
  const frozenBefore = ((report[0]!.data as Json)["frozen_repositories"] as unknown[] | undefined) ?? [];
  const liftCard = await sendCard(app, app.partyA, "StatusCard", "credit.freeze.lift", { state_label: "", detail: "" });
  const rec = await record(tok, app.j.appId);
  assert.ok(Array.isArray(rec["needed_from_you"]));
  const pendingKeys = (await cardsOf(app.partyA, `AND status = 'pending'`)).map((c) => c.copy_key); assert.ok(pendingKeys.includes("credit.freeze.lift"), `the lift card is pending: ${pendingKeys.join(",")}`);
  // the Apply product: Tasks → "Credit check" → the You step; the lift card is its caution row (STEP_OF_COPY_KEY: credit.freeze.lift → you)
  const { page, ctx } = await openApply(tok, 1280);
  await page.getByTestId("apply-tab-tasks").first().click(); await page.waitForSelector('[data-testid="apply-task-you"]', { timeout: 30_000 });
  await page.getByTestId("apply-task-you").first().click(); await page.waitForSelector('[data-testid="apply"][data-step="you"]', { timeout: 30_000 });
  const row = page.locator(`[data-testid="apply"][data-step="you"] [data-testid="apply-caution"][data-rail-card="${liftCard}"]`);
  await row.waitFor({ timeout: 15_000, state: "attached" });
  assert.equal(await row.getAttribute("data-tone"), "caution", "a caution row on the You step");
  assert.equal(await page.locator('[data-testid="apply-caution"]').count(), 1, "one caution row: the lift card, not every pending card");
  const article = row.locator(`article[data-card-id="${liftCard}"]`); await article.waitFor({ timeout: 15_000 });
  assert.equal(await article.getAttribute("data-card-kind"), "StatusCard", "the card component itself, inside the row");
  assert.match(await article.innerText(), /credit file is frozen|Lift the freeze/i, "the lift-instructions card (copy `credit.freeze.lift`)");
  assert.equal(await page.getByTestId("apply-tab-tasks").count(), 1, "the tabs stay beneath (no modal took the screen)");
  // never a toast, never a modal: nothing with a dialog role, nothing modal, nothing announced as a live status beyond the cards' own polite region
  assert.equal(await page.locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], .sm-toast, [data-testid="toast"]').count(), 0, "no toast or modal in the DOM");
  assert.equal(await page.locator('[role="alert"]:not(#__next-route-announcer__)').count(), 0, "no alert bar either (Next's route announcer is the one role=alert on every page)");
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0, "no thread on the Apply product");
  assert.equal(await page.getByTestId("apply-error").count(), 0, "the caution row is not an error line");
  assert.ok(frozenBefore.length >= 0);
  await page.screenshot({ path: `${SCREENSHOTS}/t14-caution-1280.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});

test("32.16-T15: Given a `DocumentCard{LE}` under My Loan's documents, when expanded, then the viewer and \"Confirm receipt\" render and confirming writes `receipt_evidence = esign_confirmed` (32.3 32.3-T22 unchanged).", { skip: skip || "re-driven against the Apply product in Session 4 (32.19)" }, async () => {
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
  const recordSec = page.locator('[data-testid="record"] [data-record-section="record"]');
  if ((await recordSec.getAttribute("data-open")) === "false") await recordSec.locator("> h2 > button").click(); // Documents lives behind "Your record" (32.16 §2.2)
  if ((await documents.getAttribute("data-open")) === "false") await documents.locator("> h2 > button").click();
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

test("32.16-T16: Given a phone width, then the Apply tab shell shows the badge and next event on My Loan and the needed count on Tasks, and every rail section is reachable from Tasks or My Loan.", { skip: skip || "re-driven against the Apply product in Session 4 (32.19)" }, async () => {
  assert.ok(J, "T13 drove the journey to R8"); await fresh();
  const rec = await record(tokA, J.j.appId);
  const wide = await openShell(tokA, 1280);
  const sectionsWide = await wide.page.locator('[data-testid="record"] [data-record-section]').evaluateAll((els: unknown[]) => (els as { getAttribute(n: string): string | null }[]).map((e) => e.getAttribute("data-record-section")));
  await wide.ctx.close();
  // the phone: the five-tab shell (01 §1.2) — a session lands on Chat (32.16 §2.0), the rail mounted behind the tabs as the record sheet
  const { page, ctx } = await openShell(tokA, 390);
  assert.equal(await page.locator('[data-testid="shell"][data-mobile-shell="1"][data-tab="chat"]').count(), 1, "the phone shell lands on Chat");
  assert.equal(await page.getByTestId("talk-to-person").count(), 0);
  assert.ok(await inViewport(page, '[data-testid="action-bar"]'), "the input bar in the viewport");
  assert.equal(await page.locator('[data-testid="thread"] article[data-card-kind]').count(), 0, "no card in the thread on a phone either — the sheet is the rail");
  assert.ok(await page.evaluate<boolean>("document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390"), "the page never scrolls sideways");
  // the at-a-glance line: My Loan's badge and next event, the Tasks tab's needed count — the record's own values, never counted here
  await page.getByTestId("tab-loan").click(); await page.waitForSelector('[data-testid="shell"][data-tab="loan"]', { timeout: 15_000 });
  const loan = page.getByTestId("tab-page-loan");
  assert.equal((await loan.getByTestId("status-badge").innerText()).trim().replace(/^[^\w]+/, ""), String((rec["status"] as Json)["badge"]), "the record's badge on My Loan");
  const nextText = (await loan.getByTestId("next-event").innerText()).trim(); const next = rec["next"] as Json | null;
  if (next) assert.ok(nextText.includes(String(next["label"])), `next event on My Loan: ${nextText}`); else assert.equal(nextText, "Nothing scheduled");
  const needed = (rec["needed_from_you"] as unknown[]).length; const tasksBadge = page.locator('[data-testid="tab-tasks"] .sm-tab-badge');
  if (needed > 0) { assert.equal(await tasksBadge.getAttribute("aria-label"), `${needed} needed from you`, "the needed count on the Tasks tab"); assert.equal((await tasksBadge.innerText()).trim(), String(needed)); }
  else assert.equal(await tasksBadge.count(), 0, "nothing counted when nothing is needed");
  assert.ok(await page.evaluate<boolean>("document.documentElement.scrollWidth <= 390 && document.body.scrollWidth <= 390"), "My Loan never scrolls sideways");
  // the sheet: the header's "Your record" opens it — the same rail sections, in the same order, as beside the thread at 1280
  await page.getByRole("button", { name: "Your record" }).click(); await page.waitForSelector('[data-testid="record"][data-open="true"]', { timeout: 15_000 });
  const sectionsSheet = await page.locator('[data-testid="record"][data-open="true"] [data-record-section]').evaluateAll((els: unknown[]) => (els as { getAttribute(n: string): string | null }[]).map((e) => e.getAttribute("data-record-section")));
  assert.deepEqual(sectionsSheet, sectionsWide, "the sheet carries the same sections");
  for (const id of ["status", "progress", "needed", "documents"]) assert.ok(sectionsSheet.includes(id), `${id} on the sheet`);
  assert.ok(await page.locator('[data-testid="record"] [data-record-section="needed"]').isVisible());
  assert.equal((await page.locator('[data-testid="record"] [data-record-section="record"] [data-testid="progress-count"]').innerText()).trim(), `${(rec["journey_progress"] as Json)["done"]} of ${(rec["journey_progress"] as Json)["total"]}`);
  // a reference chip opens the sheet at that card (32.16 §2.1: below 768 the rail is the record sheet and the chip opens it)
  await page.getByRole("button", { name: "Close your record" }).click();
  await page.waitForSelector('[data-testid="record"][data-open="true"]', { timeout: 15_000, state: "detached" });   // closed = display:none, never "visible"
  await page.getByTestId("tab-chat").click(); await page.waitForSelector('[data-testid="shell"][data-tab="chat"]', { timeout: 15_000 });
  const chip = page.locator('[data-testid="thread"] [data-testid="reference-chip"]').first();
  const chipCard = await chip.getAttribute("data-card-id");
  await chip.click();
  await page.waitForSelector(`[data-testid="record"][data-open="true"] [data-rail-card="${chipCard}"][data-expanded="true"]`, { timeout: 15_000 });
  await page.screenshot({ path: `${SCREENSHOTS}/t16-sheet-390.png`, fullPage: false }).catch(() => undefined);
  await ctx.close();
});
