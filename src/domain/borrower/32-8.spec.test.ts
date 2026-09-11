// 32.8 Servicing: loan home, payments, autopay, statements, escrow
// spec/sections/32-borrower-experience/32-8-servicing-loan-home-payments-autopay-statements-escrow.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
//
// Every T-id drives the real runtime over HTTP on ONE boarded loan (the journey fixture through 26.x funding and 30.2
// boarding: $560,000 at 6.125%, P&I $3,402.62 + escrow $687.50 = $4,090.12 due the 1st from Jan 1, 2027) with the
// borrower flows of src/runtime/borrower/flows/8-servicing-payments.ts reacting to the committed events of 2.x, 3.x,
// 7.1 and 7.4, then reads the borrower API (record, thread, cards) and the tables. The tests run in the loan's own
// chronology (T2 Dec 2026 → T3 Jan 2027 → T5 → T10 → T9 → T1 Oct 2027 → T7 → T8 → T6 → T4 Jan 2028 → T11), never the
// spec's numbering. What the borrower SEES of these facts is asserted on the real components in
// apps/borrower/tests/cards/flow-8-servicing-payments.test.tsx. Skips without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { decodeEntityData } from "../../infra/db/entities.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { Runtime } from "../../runtime/app.ts";
import { createApiServer, listen } from "../../runtime/server.ts";
import { createLogger } from "../../runtime/log.ts";
import { createBorrowerRouter, type BorrowerRouter } from "../../runtime/borrower/routes.ts";
import { Journey, MST } from "../../runtime/borrower/fixtures/journey.ts";
import { sendPeriodicStatement, furnishForm1098, servicingParties, recipientsOf, loanCashState, SERVICER_CONTACT } from "../../runtime/servicing.ts";
import { SERVICING_ESIGN_SCOPES, AUTODRAFT_DISCLOSURE_VERSION } from "../../runtime/borrower/flows/8-servicing-payments.ts";
import { esignVerificationToken } from "../../app/tools/section32-2.ts";
import { authorizationDefects, variableAmountNoticeStatus, type Authorization, type Enrollment } from "../cashiering/autodraft.ts";
import { graceEndFor } from "../cashiering/latecharges.ts";
import { project, type ProjectedItem } from "../escrow/analysis.ts";
import { assembleAtrEvidence, type AporTableRow, type FeeItem23, type LockRow, type ProductTerms, type ConsiderVerifyFactor } from "../underwriting/ops-23-4.ts";
import type { FakeEdelivery } from "../../infra/integrations/delivery.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const ESCROW = { kind: "agent" as const, id: "escrow" }; const CASHIERING = { kind: "agent" as const, id: "cashiering" }; const COMPLIANCE = { kind: "agent" as const, id: "compliance-tester" };
/** The loan's own figures (the journey's note and CD; nothing here is computed by the test). */
const PI = 340_262n, ESCROW_PMT = 68_750n, INSTALLMENT = PI + ESCROW_PMT;   // $3,402.62 + $687.50 = $4,090.12
const LATE_CHARGE = 17_013n;   // 5% of P&I, HALF_UP (2.7: $170.13)

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let router: BorrowerRouter; let base = ""; let close: () => Promise<void> = async () => undefined; let partnerPartyId = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const logger = createLogger("json", (line) => { if (process.env["FLOW_DEBUG"] && /flow|ERROR/.test(line)) process.stderr.write(line + "\n"); });
  router = createBorrowerRouter({ runtime, logger, environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger, console: false, borrowerRouter: router });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`]);
  partnerPartyId = partner[0]!.id;
});
test.after(async () => { if (!skip) { await settle(); await close(); await journeyLock?.release(); } });

// ---------------------------------------------------------------- helpers over the borrower API and the flows
type Reply = { status: number; body: Record<string, unknown> };
type P = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
/** An OTP sign-in: the session's `last_l1_at` is now (the fresh L1 code money commands need — 32.1 §5). */
async function signIn(email: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
const fresh = async (email: string): Promise<string> => (await signIn(email)).token;
const settle = () => router.flows!.settle();
const tick = async (now: string) => { clock.set(now); await router.flows!.tick(now); await settle(); };
const record = async (email: string, subject: string): Promise<P> => { await settle(); const r = await api("GET", `/v1/borrower/record?subject=${subject}`, undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const thread = async (email: string): Promise<P[]> => { await settle(); const r = await api("GET", "/v1/borrower/thread?limit=500", undefined, (await signIn(email)).token); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300)); return r.body["messages"] as P[]; };
const message = (token: string, text: string, loanId: string) => api("POST", "/v1/borrower/messages", { text, subject: { loan_id: loanId } }, token);
const command = (token: string, name: string, body: P) => api("POST", `/v1/borrower/commands/${name}`, body, token);
const resolve = (token: string, cardId: string, body: P) => api("POST", `/v1/borrower/cards/${cardId}/resolve`, body, token);
interface CardRow { card_instance_id: string; party_id: string; kind: string; status: string; copy_key: string; props: P; evidence: P | null; command_ref: string | null; created_at: string; resolved_at: string | null; subject_loan_id: string | null }
const cardsOf = async (loanId: string, partyId?: string): Promise<CardRow[]> => { await settle(); return db.query<CardRow & P>(`SELECT card_instance_id, party_id, kind, status, copy_key, props, evidence, command_ref, created_at, resolved_at, subject_loan_id FROM card_instances WHERE subject_loan_id = $1 AND ($2::uuid IS NULL OR party_id = $2) ORDER BY created_at, card_instance_id`, [loanId, partyId ?? null]); };
const byFlowKey = (cards: CardRow[], key: string): CardRow | undefined => cards.find((c) => c.props["flow_key"] === key);
const events = (loanId: string, type?: string) => db.query<{ type: string; occurred_at: string; payload: P }>(`SELECT type, occurred_at, payload FROM loan_events WHERE loan_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY sequence`, [loanId, type ?? null]);
const appEvents = (appId: string, type: string) => db.query<{ type: string; payload: P }>(`SELECT type, payload FROM loan_events WHERE application_id = $1 AND type = $2 ORDER BY sequence`, [appId, type]);
const timer = async (loanId: string, code: string) => (await db.query<{ status: string; due_at: string | null; due_date: string | null }>(`SELECT status::text AS status, due_at, due_date::text AS due_date FROM timers WHERE loan_id = $1 AND code = $2 ORDER BY armed_at DESC LIMIT 1`, [loanId, code]))[0];
const entity = async (kind: string, id: string): Promise<P | null> => { const rows = await db.query<{ data: unknown }>(`SELECT data FROM entity_current WHERE kind = $1 AND id = $2`, [kind, id]); return rows[0] ? decodeEntityData(rows[0].data) : null; };
const entities = async (kind: string, loanId: string): Promise<{ id: string; data: P }[]> => { const rows = await db.query<{ id: string; data: unknown }>(`SELECT id, data FROM entity_current WHERE kind = $1 AND loan_id = $2 ORDER BY created_at`, [kind, loanId]); return rows.map((r) => ({ id: r.id, data: decodeEntityData(r.data) })); };
const status = (rec: P) => rec["status"] as { badge: string; one_liner: string; one_liner_tokens?: Record<string, string | string[]> };
const exec = (process: string, name: string, loanId: string, actor: { kind: "agent"; id: string }, input: P, applicationId?: string) => runtime.execute({ process, name, loanId, ...(applicationId ? { applicationId } : {}), actor, input });
/** One boarded loan on the shared runtime: the whole origination journey (both borrowers signed in), funded Nov 12, 2026 and boarded from the record (30.2). */
async function boardLoan(): Promise<{ j: Journey; A: string; B: string; partyA: string; partyB: string; loanId: string }> {
  const R = randomUUID().slice(0, 8); const A = `alex-${R}@example.test`; const B = `blake-${R}@example.test`;
  const j = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: A, coBorrowerEmail: B, partnerPartyId });
  await j.seedBook(); await j.openApplication();
  const partyA = (await signIn(A)).party_id; const partyB = (await signIn(B)).party_id;
  await j.interview(); await j.quoteAndLe(); await j.recordIntent(); await j.quoteForLock(); await j.requestLock(); await j.executeLockAndCommit(); await j.verifyDecideAndClear(); await j.clearToClose();
  await j.scheduleClosing(); await j.closingDisclosure(); await j.closeAndSign(); await j.fund();
  const loanId = await j.board(); await settle();
  return { j, A, B, partyA, partyB, loanId };
}
/** The escrow lines the loan's CD projected ($8,250.00 a year = $687.50 a month): county tax, hazard insurance, mortgage insurance. */
const escrowItems = (yearStart: PlainDate): ProjectedItem[] => [
  { line_type: "county_tax", amount_cents: 480_000n, disburse_on: addMonths(yearStart, 9) },
  { line_type: "hazard_insurance", amount_cents: 186_000n, disburse_on: addMonths(yearStart, 1) },
  { line_type: "mortgage_insurance", amount_cents: 159_000n, disburse_on: addMonths(yearStart, 5) },
];
/** 3.2 runEscrowAnalysis + approveAnalysis on the loan with the engine's own target (project()) and the stated actual balance. */
async function analysis(loanId: string, o: { id: string; type: "annual" | "interim"; year_start: PlainDate; as_of: PlainDate; actual_vs_target: bigint }): Promise<{ decision: P; target: bigint; approved: P }> {
  const items = escrowItems(o.year_start); const target = project(items, o.year_start).target_at_start_cents;
  const run = await exec("3.1", "runEscrowAnalysis", loanId, ESCROW, { analysis_id: o.id, analysis_type: o.type, year_start: o.year_start, as_of: o.as_of, items, projected_actual_cents: (target + o.actual_vs_target).toString(), old_payment_cents: ESCROW_PMT.toString(), regx_days_delinquent: 0 });
  const decision = (run.output as { decision: P }).decision;
  const approved = await exec("3.1", "approveAnalysis", loanId, ESCROW, { analysis_id: o.id, reviewed: true });
  await settle();
  return { decision, target, approved: approved.output as P };
}
const CONTACT = { servicer_phone: SERVICER_CONTACT.servicer_phone, exclusive_address: SERVICER_CONTACT.exclusive_address };

// ═══════════════════════════════════ the loan (one journey, boarded once; every T-id continues its chronology)
const main: { j?: Journey; A: string; B: string; partyA: string; partyB: string; loanId: string; enrollmentId: string; suspenseItemId: string; shortageAnalysisId: string } = { A: "", B: "", partyA: "", partyB: "", loanId: "", enrollmentId: "", suspenseItemId: "", shortageAnalysisId: "" };

test("32.8-T2: Given a `PaymentCard` submitted without a fresh L1 code in the last 10 minutes, then the API refuses and the card requests the code.", { skip }, async () => {
  Object.assign(main, await boardLoan()); const { A, partyA, loanId } = main;
  assert.ok((await events(loanId, "loan.boarded")).length === 1, "boarded once");
  // Tue Dec 15, 2026 10:00 MST: Alex signs in (a fresh L1 code) and asks for a payment card — the flow answers with the PaymentCard for the first installment (Jan 1, 2027)
  clock.set(MST("2026-12-15", "10:00")); const tok = await fresh(A);
  const m = await message(tok, "I would like to make a payment on my loan.", loanId); assert.equal(m.status, 200, JSON.stringify(m.body).slice(0, 400));
  assert.equal((m.body["reply"] as P)["copy_key"], "payment.card_offered");
  const card = byFlowKey(await cardsOf(loanId, partyA), "pay:manual:2026-12-15")!; assert.ok(card, "PaymentCard `payment.due`"); assert.equal(card.kind, "PaymentCard"); assert.equal(card.copy_key, "payment.due"); assert.equal(card.command_ref, "payment.makeOneTime"); assert.equal(card.status, "pending");
  assert.equal(card.props["amount_default_cents"], INSTALLMENT.toString()); assert.equal(card.props["installment_due_date"], "2027-01-01"); assert.equal(card.props["fresh_l1_required"], true); assert.equal(card.props["mode"], "one_time"); assert.equal(card.props["add_account"], true);
  const dates = card.props["date_options"] as string[]; assert.equal(dates[0], "2026-12-15"); assert.equal(dates.at(-1), "2027-01-01", "date options run to the due date (no engine grace end yet)"); assert.deepEqual((card.props["copy_tokens"] as P), { money: "$4,090.12", date: "2027-01-01" });
  // 10:11 MST: the same session, 11 minutes after the code — the API refuses the resolve (32.1 §5) with the code the card renders as the ask for a fresh code; nothing was written
  clock.set(MST("2026-12-15", "10:11"));
  const r = await resolve(tok, card.card_instance_id, { option_id: "one_time", evidence: { amount_cents: INSTALLMENT.toString(), date: "2026-12-15", account_id: "new", include_late_charge: false, submitted_at: clock.now() }, args: { amount_cents: INSTALLMENT.toString(), date: "2026-12-15", account: { last4: "9876", type: "checking", routing: "021000021" } } });
  assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body["code"], "FRESH_L1_REQUIRED"); assert.equal(r.body["copy_key"], "auth.fresh_code");
  assert.equal((await cardsOf(loanId, partyA)).find((c) => c.card_instance_id === card.card_instance_id)!.status, "pending", "the card still asks — now for the code");
  assert.equal((await events(loanId, "payment.received")).length, 0, "no payment row without the fresh code");
  // a fresh code within 10 minutes is what the card asks for: the same session re-verified would pass the gate (the payment itself is T3's)
  const again = await fresh(A); const probe = await api("GET", "/v1/borrower/me", undefined, again); assert.equal(probe.status, 200);
});

test("32.8-T3: Given a payment of $1,000 against a $2,400 installment, then the Thread shows *held*, the remaining $1,400 and the 30-day rule; `suspense_items.open` exists; a request for refund resolves to `refunded`.", { skip }, async () => {
  const { A, partyA, partyB, loanId } = main;
  // Fri Jan 1, 2027 00:30 MST: the 2.7 run reaches the first due date → `installment.due_date_reached{grace_end_on}` (Sat Jan 16 rolls past Mon Jan 18 — a servicer holiday — to Tue Jan 19, 2.7 decision 2) → a PaymentCard per borrower with the engine's dates
  await tick(MST("2027-01-01", "00:30"));
  const due = (await events(loanId, "installment.due_date_reached")).at(-1)!; assert.equal(due.payload["installment_due_date"], "2027-01-01"); assert.equal(due.payload["grace_end_on"], "2027-01-19");
  const cardA = byFlowKey(await cardsOf(loanId, partyA), "pay:2027-01-01")!; assert.ok(cardA, "PaymentCard on the due date"); assert.ok(byFlowKey(await cardsOf(loanId, partyB), "pay:2027-01-01"), "…for each borrower");
  assert.equal((cardA.props["date_options"] as string[]).at(-1), "2027-01-19", "date options end at 2.7's grace end, never later"); assert.equal(cardA.props["grace_end_on"], "2027-01-19");
  // Tue Jan 5 10:00: Alex pays $1,000 from a new account (fresh code) — the loan's installment is $4,090.12, so $3,090.12 remains (the spec's $2,400 / $1,400 is its own worked figure; the loan states its own)
  clock.set(MST("2027-01-05", "10:00")); const tok = await fresh(A);
  const paid = await resolve(tok, cardA.card_instance_id, { option_id: "one_time", evidence: { amount_cents: "100000", date: "2027-01-05", account_id: "new", include_late_charge: false, submitted_at: clock.now() }, args: { amount_cents: "100000", date: "2027-01-05", account: { last4: "9876", type: "checking", routing: "021000021" } } });
  assert.equal(paid.status, 201, JSON.stringify(paid.body).slice(0, 500));
  const received = (await events(loanId, "payment.received")).at(-1)!; assert.equal(received.payload["amount_cents"], "100000"); assert.equal(received.payload["channel"], "portal");
  const paymentId = String(received.payload["payment_id"]);
  assert.equal(byFlowKey(await cardsOf(loanId, partyA), `payment.received:${paymentId}`)?.copy_key, "payment.received", "the Thread shows *received* immediately");
  // Wed Jan 6 00:30: the posting run — the allocation engine finds no full installment (n = 0) → 2.2 rule 3 holds the partial (`suspense_items.open`), the 30-day clock is the engine's
  await tick(MST("2027-01-06", "00:30"));
  const created = (await events(loanId, "suspense.item.created")).at(-1)!; assert.equal(created.payload["partial_payment"], true); assert.equal(created.payload["amount_cents"], "100000");
  const itemId = String(created.payload["suspense_item_id"]); main.suspenseItemId = itemId;
  const item = (await entity("suspense_items", itemId))!; assert.equal(item["status"], "open"); assert.equal(item["reason_code"], "partial_payment"); assert.equal(item["balance_needed_cents"], (INSTALLMENT - 100_000n).toString()); assert.equal(item["installment_due_date"], "2027-01-01");
  assert.equal((await entity("payments", paymentId))!["status"], "held");
  const t = await timer(loanId, "FNMA_C1102_PARTIAL_BALANCE_30"); assert.ok(t, "the 30-day rule is 2.2's timer"); assert.equal(t.status, "armed");
  const held = byFlowKey(await cardsOf(loanId, partyA), `payment.held:${itemId}`)!; assert.ok(held, "StatusCard `payment.held`"); assert.equal(held.kind, "StatusCard"); assert.equal(held.copy_key, "payment.held");
  assert.deepEqual(held.props["copy_tokens"], { money: ["$1,000.00", "$3,090.12"] }); assert.equal(held.props["remaining_cents"], "309012"); assert.equal(held.props["rule"], "C-1.1-02 (30 days)"); assert.equal(held.props["next_event_at"], t.due_at, "the return date is `timers.due_at`, never computed here");
  const th = await thread(A); assert.ok(th.some((x) => x["card_instance_id"] === held.card_instance_id), "the held line is in Alex's Thread");
  // Alex asks for the money back → the flow's ChoiceCard; tapping it opens the request (case.open) and 2.2 returns the funds: `suspense_items.refunded`
  clock.set(MST("2027-01-08", "09:00")); const tok2 = await fresh(A);
  const ask = await message(tok2, "Please refund the partial payment you are holding.", loanId); assert.equal(ask.status, 200, JSON.stringify(ask.body).slice(0, 300)); assert.equal((ask.body["reply"] as P)["copy_key"], "payment.refund.offered");
  const choice = byFlowKey(await cardsOf(loanId, partyA), `refund:${itemId}`)!; assert.ok(choice, "ChoiceCard `payment.refund.choice`"); assert.equal(choice.kind, "ChoiceCard"); assert.equal(choice.command_ref, "case.open");
  assert.deepEqual((choice.props["options"] as P[]).map((o) => o["label"]), ["Return my $1,000.00", "Keep holding it"]);
  const refund = await resolve(tok2, choice.card_instance_id, { option_id: "refund", evidence: { option_id: "refund", tapped_at: clock.now() } }); assert.equal(refund.status, 201, JSON.stringify(refund.body).slice(0, 500));
  await settle();
  const closed = (await events(loanId, "suspense.item.closed")).find((e) => e.payload["suspense_item_id"] === itemId)!; assert.ok(closed, "2.2 closed the item"); assert.equal(closed.payload["outcome"], "refunded");
  assert.equal((await entity("suspense_items", itemId))!["status"], "refunded"); assert.equal((await entity("payments", paymentId))!["status"], "refunded");
  const refunded = (await events(loanId, "payment.refunded")).at(-1)!; assert.equal(refunded.payload["amount_cents"], "100000"); assert.equal(refunded.payload["requested_by"], "borrower");
  assert.equal(byFlowKey(await cardsOf(loanId, partyA), `payment.refunded:${itemId}`)?.copy_key, "payment.refunded");
  assert.equal((await cardsOf(loanId, partyA)).find((c) => c.card_instance_id === choice.card_instance_id)!.status, "resolved");
  const facts = await loanCashState(runtime, loanId, D("2027-01-08")); assert.equal(facts.balances.suspense_unapplied, 0n, "the receipt is reversed out of suspense"); assert.equal(facts.state.installments.find((x) => x.due_date === "2027-01-01")!.status, "due");
});

test("32.8-T5: Given an autopay `ConsentCard`, then it contains every 2.x rule-1 element and the optional statement; `authorized` is never set from voice.", { skip }, async () => {
  const { A, partyA, loanId } = main;
  // Mon Jan 11, 2027: Alex enrolls (fresh code; every Reg E / Nacha element displayed) → `autodraft.enrollment.requested` → the flow's ConsentCard with the 2.3 authorization the engine will verify
  clock.set(MST("2027-01-11", "10:00")); const tok = await fresh(A);
  const enroll = await command(tok, "autodraft.enroll", { amount_rule: "contractual", draft_day: 1, include_fees: false, account: { last4: "9876", type: "checking", routing: "021000021" }, elements_displayed: true, subject: { loan_id: loanId } });
  assert.equal(enroll.status, 200, JSON.stringify(enroll.body).slice(0, 500));
  const enrollmentId = String((enroll.body["result"] as P)["enrollment_id"]); main.enrollmentId = enrollmentId;
  assert.equal((await entity("autodraft_enrollments", enrollmentId))!["status"], "requested");
  const card = byFlowKey(await cardsOf(loanId, partyA), `autodraft.authorize:${enrollmentId}`)!; assert.ok(card, "ConsentCard{autodraft_authorization}"); assert.equal(card.kind, "ConsentCard"); assert.equal(card.copy_key, "consent.autodraft.title"); assert.equal(card.command_ref, "consent.capture"); assert.equal(card.party_id, partyA);
  assert.equal(card.props["consent_kind"], "autodraft_authorization"); assert.equal(card.props["affirmation_method"], "checkbox_with_text"); assert.equal(card.props["requires_typed_name"], true); assert.equal(card.props["optional"], true); assert.equal(card.props["prechecked"], false); assert.equal(card.props["optional_statement_copy_key"], "consent.autodraft.optional"); assert.equal(card.props["disclosure_version_id"], AUTODRAFT_DISCLOSURE_VERSION);
  // every 2.x rule-1 element (32.7's element copy keys) and the optional statement are on the card
  const elements = card.props["elements"] as { id: string; label_key: string; value: string }[];
  assert.deepEqual(elements.map((e) => e.id), ["borrower", "loan", "account", "amount", "amount_variable", "timing", "first_debit", "company", "revoke", "date", "esign", "optional"]);
  for (const e of elements) assert.match(e.label_key, /^consent\.autodraft\.(element\.|optional$)/);
  assert.equal(elements.find((e) => e.id === "company")!.value, "SUPERMORTGAGE"); assert.equal(elements.find((e) => e.id === "amount")!.value, "$4,090.12 (your full monthly payment)"); assert.equal(elements.find((e) => e.id === "first_debit")!.value, "2027-02-01"); assert.equal(elements.find((e) => e.id === "timing")!.value, "monthly on the 1st");
  const authorization = card.props["authorization"] as Authorization; assert.deepEqual(authorizationDefects(authorization), [], "2.3's checklist finds no missing element"); assert.equal(authorization.company_name, "SUPERMORTGAGE"); assert.equal(authorization.optional_statement, true); assert.equal(authorization.revocation_instructions, true); assert.equal(authorization.variable_amount_statement, true);
  // a spoken yes never authorizes: the API refuses the voice resolve (01 §3.5) and the enrollment stays `requested`
  const voice = await resolve(tok, card.card_instance_id, { option_id: "affirm", channel: "voice", evidence: { transcript_ref: "call-1" } }); assert.equal(voice.status, 409); assert.equal(voice.body["code"], "CARD_VOICE_CONSENT");
  await settle(); assert.equal((await events(loanId, "autodraft.enrollment.authorized")).length, 0); assert.equal((await entity("autodraft_enrollments", enrollmentId))!["status"], "requested");
  // the checkbox + typed name in the app → consent.capture{autodraft_authorization} → `consent.granted{kind=autopay}` → 2.3 authorize (the elements verified) → validate (FAKE instant API) → `active`
  clock.set(MST("2027-01-11", "10:05"));
  const ok = await resolve(tok, card.card_instance_id, { option_id: "affirm", evidence: { consent_kind: "autodraft_authorization", disclosure_version_id: AUTODRAFT_DISCLOSURE_VERSION, method: "checkbox_with_text", text_hash: "sha256:autodraft-v1", affirmed_at: clock.now(), typed_name: "Alex Borrower" } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body).slice(0, 500));
  await settle();
  const granted = (await appEvents(main.j!.appId, "consent.granted")).find((e) => e.payload["kind"] === "autopay" && e.payload["card_instance_id"] === card.card_instance_id)!; assert.ok(granted, "consent.granted{kind=autopay} keyed to the card");
  const authorized = (await events(loanId, "autodraft.enrollment.authorized")).at(-1)!; assert.ok(authorized, "2.3 rule 1: authorized"); assert.equal(authorized.payload["enrollment_id"], enrollmentId);
  const e = (await entity("autodraft_enrollments", enrollmentId))!; assert.equal(e["status"], "active"); assert.equal(e["next_draft_on"], "2027-02-01"); assert.equal(e["account_last4"], "9876"); assert.equal(e["validation_status"], "validated");
  const active = byFlowKey(await cardsOf(loanId, partyA), `autopay.active:${enrollmentId}`)!; assert.ok(active, "StatusCard `autopay.active`"); assert.deepEqual(active.props["copy_tokens"], { money: "$4,090.12", date: "2027-02-01", last4: "9876" });
  assert.ok((await events(loanId, "notice.rendered")).some((x) => x.payload["template"] === "AUTODRAFT-CONFIRM-v1"), "the authorization copy (AUTODRAFT-CONFIRM-v1) is rendered for delivery within 1 BD");
  const rec = await record(A, loanId); const loan = rec["loan"] as P; assert.equal((loan["autodraft"] as P)["status"], "active"); assert.equal((loan["autodraft"] as P)["next_draft_on"], "2027-02-01");
});

test("32.8-T10: Given an HPML loan consummated Nov 6, 2026, then `escrow.requestWaiver` before Nov 6, 2031 is refused with the escrow-period copy (23.4-T5).", { skip }, async () => {
  const j = main.j!; const { A, partyA, loanId } = main;
  // 23.4's CD-stage determination on this application with the 23.4-T5 figures: APR 7.550% vs APOR 6.020% → is_hpml, escrow_min_cancel_date 2031-11-06 (consummation Fri Nov 6, 2026)
  const ev = (kind: string, id: string, source_process: string) => ({ kind, id, source_process });
  const considerVerify: ConsiderVerifyFactor[] = assembleAtrEvidence({
    income: { monthly_cents: 1_450_000n, evidence: [ev("paystub", "DOC-PAY-1", "22.3"), ev("w2", "DOC-W2-2025", "22.3"), ev("du_validation_income_report", "DUV-INC-1", "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-01 ≡ SG-2026-09-02/B3-3.2-01" },
    employment: { status: "employed_w2", evidence: [ev("vvoe", "VVOE-1", "22.3")], standard_ref: "SG-2020-06-03/B3-3.1-04 ≡ SG-2026-09-02/B3-3.1-04" },
    payment: { pi_cents: PI, basis: "note_rate_fully_amortizing", evidence: [ev("cd_projected_payments", "CD-1", "25.2")] },
    simultaneous_loans: { monthly_cents: 0n, evidence: [ev("credit_report", "CR-2026-10-05-1", "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
    mortgage_obligations: { monthly_cents: ESCROW_PMT, evidence: [ev("escrow_analysis", "EA-1", "30.3"), ev("hoi_declaration", "HOI-1", "24.5")], standard_ref: "SG-2020-06-03/B3-6-03" },
    debts: { monthly_cents: 142_000n, alimony_child_support_cents: 0n, evidence: [ev("credit_report", "CR-2026-10-05-1", "22.5")], standard_ref: "SG-2020-06-03/B3-6-05" },
    dti: { pct: "38.00", evidence: [ev("dti_worksheet", "DTI-1", "22.5")], standard_ref: "SG-2020-06-03/B3-6-02" },
    credit_history: { report_id: "CR-2026-10-05-1", pulled_at: D("2026-10-05"), standard_ref: "SG-2020-06-03/B3-5.1-01" },
  });
  const apor = (week: string): AporTableRow => ({ table_id: `T-${week}`, published_on: D(week), effective_week: D(week), type: "fixed", rows: { "30": "6.020", "15": "5.400" }, source_url: "https://ffiec.cfpb.gov/tools/rate-spread", fetched_at: `${week}T13:05:00.000Z`, hash: `sha256:${week}` });
  const lock: LockRow = { lock_id: j.lockId || "LK-REFI-1", kind: "initial", locked_at: "2026-10-07T15:10:00.000Z", rate_pct: "6.125", product: "fixed", term_years: 30 };
  const product: ProductTerms = { term_months: 360, amortization: "fully_amortizing", substantially_equal_payments: true, arm: null };
  const fees: FeeItem23[] = [
    { fee_item_id: "F-ORIG", service_code: "origination", description: "Origination fee", amount_cents: 199_500n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender", retained_by_creditor: true },
    { fee_item_id: "F-PPI", service_code: "interest_prepaid", description: "Prepaid interest Nov 12–30", amount_cents: 178_543n, paid_to: "Partner Lender", paid_to_kind: "creditor", payee: "Partner Lender" },
    { fee_item_id: "F-CR", service_code: "credit_report", description: "Credit report", amount_cents: 7_500n, paid_to: "Xactus LLC", paid_to_kind: "third_party", payee: "Xactus LLC" },
    { fee_item_id: "F-TITLE", service_code: "settlement_fee", description: "Title / settlement services", amount_cents: 180_000n, paid_to: "Desert Title Agency", paid_to_kind: "third_party", payee: "Desert Title Agency", affiliate: false, reasonable: true },
    { fee_item_id: "F-REC", service_code: "recording", description: "Recording fee", amount_cents: 9_500n, paid_to: "Maricopa County Recorder", paid_to_kind: "public_official", payee: "Maricopa County Recorder" },
  ];
  clock.set(MST("2027-01-12", "09:00"));
  const stage = await runtime.execute({ process: "23.4", name: "runQmTests", loanId, applicationId: j.appId, actor: COMPLIANCE, input: { op: "stage", stage: "cd", as_of: "2026-11-02", apr: "7.550", apr_calculation_id: `APR-${j.R}-CD-1`, loan_amount_cents: "56000000", locks: [lock], apor_tables: [apor("2026-10-05"), apor("2026-10-19"), apor("2026-11-02")], fee_items: fees.map((f) => ({ ...f, amount_cents: f.amount_cents.toString() })), product, consider_verify: considerVerify, lien: "first", principal_dwelling: true, state: "AZ", county: "Maricopa", consummation_date: "2026-11-06", escrow_established_before_consummation: true, computed_from_final_cd: true } });
  const hpml = stage.events.find((e) => e.type === "compliance.hpml.determined")!; assert.ok(hpml, "23.4 emits compliance.hpml.determined"); assert.equal(hpml.payload["is_hpml"], true);
  await settle();
  // Alex asks to close the escrow account → the flow's ChoiceCard names the gate and the loan's HPML facts (never a decision of its own)
  const tok = await fresh(A);
  const ask = await message(tok, "Can I close my escrow account and pay the taxes myself?", loanId); assert.equal(ask.status, 200, JSON.stringify(ask.body).slice(0, 300)); assert.equal((ask.body["reply"] as P)["copy_key"], "escrow.waiver.offered");
  const choice = (await cardsOf(loanId, partyA)).filter((c) => c.copy_key === "escrow.waiver.choice").at(-1)!; assert.ok(choice, "ChoiceCard `escrow.waiver.choice`"); assert.equal(choice.command_ref, "escrow.requestWaiver"); assert.equal(choice.props["gate"], "REGZ_1026_35B1_HPML_ESCROW_GATE"); assert.equal(choice.props["hpml"], true); assert.equal(choice.props["consummation_date"], "2026-11-06");
  // Tue Jan 12, 2027 is before Nov 6, 2031: escrow.requestWaiver is refused by the 23.4 gate with the escrow-period copy; nothing is written
  const r = await resolve(tok, choice.card_instance_id, { option_id: "request", evidence: { option_id: "request", tapped_at: clock.now() } });
  assert.ok(r.status === 403 || r.status === 409, `refused: ${r.status} ${JSON.stringify(r.body)}`); assert.equal(r.body["gate"], "REGZ_1026_35B1_HPML_ESCROW_GATE"); assert.equal(r.body["copy_key"], "escrow.waiver.hpml_period");
  assert.equal((await events(loanId, "escrow.waiver.requested")).length, 0, "no request row before the floor"); assert.equal((await events(loanId, "escrow.waiver.decided")).length, 0);
  assert.equal((await cardsOf(loanId, partyA)).find((c) => c.card_instance_id === choice.card_instance_id)!.status, "pending");
  // the same request dated Nov 6, 2031 passes the HPML gate (the 3.8 engine then decides on LTV and the rest: 23.4-T5)
  clock.set(MST("2031-11-06", "09:00")); const later = await fresh(A);
  const ok = await resolve(later, choice.card_instance_id, { option_id: "request", evidence: { option_id: "request", tapped_at: clock.now() } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body).slice(0, 500)); assert.equal((await events(loanId, "escrow.waiver.requested")).length, 1);
  clock.set(MST("2027-01-12", "09:30"));
});

test("32.8-T9: Given a surplus of $75 on a current loan, then a refund is scheduled and `NTC_SM_ESCROW_SURPLUS_REFUND` renders; given $40, then `credited_to_payments`.", { skip }, async () => {
  const { A, partyA, loanId } = main;
  // Mon Mar 15, 2027: an interim analysis finds the account $75.00 above the engine's target on a current loan → decision refund, due within 30 days (§1024.17(f)(2)(i))
  clock.set(MST("2027-03-15", "09:00"));
  const a75 = await analysis(loanId, { id: `EA-${loanId.slice(0, 8)}-0315`, type: "interim", year_start: D("2027-04-01"), as_of: D("2027-03-15"), actual_vs_target: 7_500n });
  assert.equal(a75.decision["kind"], "refund"); assert.equal(String(a75.decision["surplus_cents"]), "7500"); assert.equal(a75.decision["due_on"], "2027-04-14");
  const approved = (await events(loanId, "escrow.analysis.approved")).at(-1)!; assert.equal(approved.payload["decision"], "refund"); assert.equal(approved.payload["surplus_cents"], "7500"); assert.equal(approved.payload["borrower_current"], true);
  const t = await timer(loanId, "REGX_1024_17F2_SURPLUS_REFUND_30"); assert.ok(t, "the 30-day refund clock is 3.5's timer"); assert.equal(t.status, "armed"); assert.equal(t.due_date, "2027-04-14");
  // 3.5 issues the engine's refund (never an agent's figure) and the print/mail insert NTC_SM_ESCROW_SURPLUS_REFUND renders with the check
  const issued = await exec("3.5", "issueRefund", loanId, ESCROW, { kind: "surplus_refund", amount_cents: "7500", due_on: "2027-04-14", payee_kind: "borrower", method: "check", analysis_id: `EA-${loanId.slice(0, 8)}-0315` });
  const dis = issued.events.find((e) => e.type === "disbursement.issued")!; assert.equal(dis.payload["kind"], "surplus_refund"); assert.equal(dis.payload["amount_cents"], "7500"); assert.equal(dis.payload["payee_kind"], "borrower");
  const parties = await servicingParties(runtime, loanId);
  const notice = await exec("3.1", "sendNotice", loanId, ESCROW, { template_code: "NTC_SM_ESCROW_SURPLUS_REFUND", recipients: recipientsOf(parties), payload: { refund_cents: "7500", analysis_date: "2027-03-15", analysis_ref: `EA-${loanId.slice(0, 8)}-0315`, escrow_payment_cents: ESCROW_PMT.toString(), days_after_analysis: 0, ...CONTACT } });
  const rendered = notice.events.find((e) => e.type === "notice.rendered" && e.payload["template"] === "NTC_SM_ESCROW_SURPLUS_REFUND")!; assert.ok(rendered, "NTC_SM_ESCROW_SURPLUS_REFUND renders"); assert.ok(notice.events.some((e) => e.type === "notice.sent" && e.payload["template"] === "NTC_SM_ESCROW_SURPLUS_REFUND"));
  await settle();
  const surplus = byFlowKey(await cardsOf(loanId, partyA), `escrow.refund:EA-${loanId.slice(0, 8)}-0315`)!; assert.ok(surplus, "StatusCard `escrow.surplus`"); assert.deepEqual(surplus.props["copy_tokens"], { money: "$75.00" }); assert.equal(surplus.props["next_event_at"], t.due_at, "the refund-by date is the timer's");
  assert.ok((await cardsOf(loanId, partyA)).some((c) => c.copy_key === "escrow.surplus.notice" && c.kind === "NoticeCard" && c.props["notice_code"] === "NTC_SM_ESCROW_SURPLUS_REFUND"), "the insert is a NoticeCard");
  assert.equal((await entity("escrow_analyses", `EA-${loanId.slice(0, 8)}-0315`))!["status"], "approved");
  // a second interim analysis $40.00 above target: under $50 → credited to the coming payments (`credited_to_payments`), no refund
  clock.set(MST("2027-05-17", "09:00"));
  const a40 = await analysis(loanId, { id: `EA-${loanId.slice(0, 8)}-0517`, type: "interim", year_start: D("2027-06-01"), as_of: D("2027-05-17"), actual_vs_target: 4_000n });
  assert.equal(a40.decision["kind"], "credit"); assert.equal(String(a40.decision["surplus_cents"]), "4000"); assert.equal(String(a40.decision["credit_monthly_cents"]), "333");
  const approved40 = (await events(loanId, "escrow.analysis.approved")).at(-1)!; assert.equal(approved40.payload["decision"], "credit"); assert.equal(approved40.payload["surplus_cents"], "4000");
  const credit = byFlowKey(await cardsOf(loanId, partyA), `escrow.credit:EA-${loanId.slice(0, 8)}-0517`)!; assert.ok(credit, "StatusCard `escrow.surplus_credit`"); assert.equal(credit.props["outcome"], "credited_to_payments"); assert.deepEqual(credit.props["copy_tokens"], { money: "$40.00", monthly: "$3.33" });
  assert.equal((await events(loanId, "disbursement.issued")).filter((e) => e.payload["kind"] === "surplus_refund").length, 1, "no refund for the $40 surplus");
});

test("32.8-T1: Given due Oct 1 with 15-day grace, then the badge is \"Payment due\" Oct 1–15 with the grace end shown, \"Past due\" from Oct 16 with the assessed late charge, and \"Current\" on posting.", { skip }, async () => {
  const j = main.j!; const { A, partyA, loanId, enrollmentId } = main;
  // Jan–Sep 2027 satisfied: January by lockbox (Tue Jan 12, inside the grace), Feb–Sep by the autopay debit settled on the 1st (2.3) and posted by the 00:30 run (2.1)
  const jan = await j.postInstallment("2027-01-01", "2027-01-12"); assert.equal(jan.outcome, "applied"); assert.deepEqual(jan.installments, ["2027-01-01"]);
  for (const m of ["2027-02-01", "2027-03-01", "2027-04-01", "2027-05-01", "2027-06-01", "2027-07-01", "2027-08-01", "2027-09-01"]) {
    clock.set(`${m}T07:00:00.000Z`);
    await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "settle", id: enrollmentId, loan_id: loanId, amount_cents: INSTALLMENT.toString(), settlement_date: m, installment_due_date: m, next_draft_on: addMonths(D(m), 1) });
    await tick(`${m}T07:30:00.000Z`);
    const posted = (await events(loanId, "payment.posted")).at(-1)!; assert.deepEqual(posted.payload["installments"], [m], `the ${m} debit posts through the engine`);
  }
  assert.equal((await cardsOf(loanId, partyA)).filter((c) => c.kind === "PaymentCard" && c.status === "pending").length, 0, "nothing to ask while every installment is satisfied");
  // Fri Oct 1, 2027 00:30: the 2.7 run reaches the due date; the 15-day grace ends Sat Oct 16 → rolled to Mon Oct 18 (2.7 decision 2) — the badge shows the engine's grace end, never a computed one
  await tick(MST("2027-10-01", "00:30"));
  const reached = (await events(loanId, "installment.due_date_reached")).at(-1)!; assert.equal(reached.payload["installment_due_date"], "2027-10-01"); assert.equal(reached.payload["grace_end_on"], "2027-10-18");
  const facts = await loanCashState(runtime, loanId, D("2027-10-01")); assert.equal(graceEndFor(facts.state, D("2027-10-01")), "2027-10-18");
  let rec = await record(A, loanId); assert.equal(status(rec).badge, "Payment due"); assert.equal(status(rec).one_liner, "account.payment_due"); assert.deepEqual(status(rec).one_liner_tokens, { date: "2027-10-01", grace_end: "2027-10-18" });
  const pay = byFlowKey(await cardsOf(loanId, partyA), "pay:2027-10-01")!; assert.ok(pay, "PaymentCard on the due date"); assert.equal((pay.props["date_options"] as string[]).at(-1), "2027-10-18");
  await tick(MST("2027-10-15", "00:30")); rec = await record(A, loanId); assert.equal(status(rec).badge, "Payment due", "Oct 15: still inside the grace");
  await tick(MST("2027-10-18", "00:30")); rec = await record(A, loanId); assert.equal(status(rec).badge, "Payment due", "Oct 18: the rolled grace end");
  assert.equal((await events(loanId, "fee.assessed")).length, 0);
  // Tue Oct 19 00:30: the day after the grace end the 2.7 assessment runs → `fee.assessed{late_charge}` $170.13 (5% of P&I) → "Past due" with the assessed charge; the PaymentCard now carries the late-charge option
  await tick(MST("2027-10-19", "00:30"));
  const fee = (await events(loanId, "fee.assessed")).find((e) => e.payload["late_charge"] === true)!; assert.ok(fee, "late charge assessed"); assert.equal(fee.payload["amount_cents"], LATE_CHARGE.toString()); assert.equal(fee.payload["installment_due_date"], "2027-10-01"); assert.equal(fee.payload["assessed_on"], "2027-10-19"); assert.equal(fee.payload["state"], "assessed");
  rec = await record(A, loanId); assert.equal(status(rec).badge, "Past due"); assert.equal(status(rec).one_liner, "account.past_due"); assert.deepEqual(status(rec).one_liner_tokens, { money: "$170.13", date: "2027-10-19" });
  const cards = await cardsOf(loanId, partyA);
  assert.equal(byFlowKey(cards, `late_charge:${String(fee.payload["fee_id"])}`)?.copy_key, "late_charge.assessed");
  assert.equal(cards.find((c) => c.card_instance_id === pay.card_instance_id)!.status, "superseded", "a newer card for the same ask");
  const payLc = byFlowKey(cards, "pay:2027-10-01:lc")!; assert.ok(payLc); assert.deepEqual(payLc.props["include_late_charge_option"], { late_charge_cents: LATE_CHARGE.toString() });
  // Wed Oct 20: the installment posts (lockbox) → "Current" — the next payment and the autopay draft from the enrollment row
  const oct = await j.postInstallment("2027-10-01", "2027-10-20"); assert.equal(oct.outcome, "applied");
  rec = await record(A, loanId); assert.equal(status(rec).badge, "Current"); assert.equal(status(rec).one_liner, "account.current_autopay"); assert.deepEqual(status(rec).one_liner_tokens, { money: "$4,090.12", date: ["2027-11-01", "2027-10-01"] });
  assert.equal((await cardsOf(loanId, partyA)).find((c) => c.card_instance_id === payLc.card_instance_id)!.status, "resolved", "the ask closes on payment.posted");
  assert.ok((await cardsOf(loanId, partyA)).some((c) => c.copy_key === "payment.posted" && (c.props["installments"] as string[])[0] === "2027-10-01"), "the collapsed receipt");
});

test("32.8-T7: Given a hard bounce on the statement availability e-mail, then a paper statement is mailed the same day, consent is `suspect`, and a re-verification card appears.", { skip }, async () => {
  const { A, partyA, loanId, enrollmentId } = main;
  // Nov 1, 2027 settled and posted; then Alex turns e-delivery on for the servicing classes (checkbox + typed name, then 7.4's demonstration test) → consents.status active
  clock.set("2027-11-01T07:00:00.000Z");
  await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "settle", id: enrollmentId, loan_id: loanId, amount_cents: INSTALLMENT.toString(), settlement_date: "2027-11-01", installment_due_date: "2027-11-01", next_draft_on: "2027-12-01" });
  await tick("2027-11-01T07:30:00.000Z");
  clock.set(MST("2027-11-10", "10:00")); const tok = await fresh(A);
  const cap = await command(tok, "consent.capture", { kind: "esign", method: "checkbox_with_text", scope: [...SERVICING_ESIGN_SCOPES], disclosure_version_id: "NTC_ESIGN_7001C_DISCLOSURE", purpose: "informational", text_hash: "sha256:esign-7001c", subject: { loan_id: loanId } });
  assert.equal(cap.status, 200, JSON.stringify(cap.body).slice(0, 400)); const consentId = String((cap.body["result"] as P)["consent_id"]);
  const ver = await command(tok, "consent.capture", { op: "verify", consent_id: consentId, token: esignVerificationToken(consentId), scope: [...SERVICING_ESIGN_SCOPES], subject: { loan_id: loanId } }); assert.equal(ver.status, 200, JSON.stringify(ver.body).slice(0, 400));
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [consentId]))[0]!.status, "active");
  const before = await servicingParties(runtime, loanId); const alex = before.find((p) => p.party_id === partyA)!; assert.equal(alex.esign?.status, "active"); assert.ok(alex.esign!.classes.includes("periodic_statements")); assert.ok(alex.email);
  // Sat Nov 20 09:00 MST: the December cycle. The FAKE mailer hard-bounces Alex's availability e-mail (NTC_REGZ_41_STMT_AVAIL_EMAIL) → 7.4 rule 8: the paper statement is mailed the same day, the consent is `suspect`
  (runtime.ports.edelivery as FakeEdelivery).bouncing.add(alex.email!);
  const now = MST("2027-11-20", "09:00"); clock.set(now);
  const run = await sendPeriodicStatement(runtime, loanId, { cycle_due_date: D("2027-12-01"), statement_date: D("2027-11-20"), now });
  (runtime.ports.edelivery as FakeEdelivery).bouncing.delete(alex.email!);
  assert.ok(run.availability_notice_id, "the availability e-mail went out"); assert.deepEqual(run.bounced_party_ids, [partyA]); assert.equal(run.channel, "mail"); assert.equal(run.mailed_at, now, "mailed the same day");
  const types = run.events.map((e) => e.type);
  assert.ok(types.includes("notice.bounced"), "notice.bounced"); assert.ok(types.includes("consent.esign.suspect")); assert.ok(types.includes("statement.fallback_mailed")); assert.ok(types.includes("statement.sent"));
  const suspect = run.events.find((e) => e.type === "consent.esign.suspect")!; assert.equal(suspect.payload["party_id"], partyA); assert.equal(suspect.payload["consent_id"], consentId); assert.equal(suspect.payload["reason"], "hard_bounce"); assert.equal(suspect.payload["mail_until_reverified"], true);
  const sent = run.events.find((e) => e.type === "statement.sent")!; assert.equal(sent.payload["channel"], "mail"); assert.equal(sent.payload["mailed_at"], now); assert.equal(sent.payload["cycle_due_date"], "2027-12-01");
  const fallback = run.events.find((e) => e.type === "statement.fallback_mailed")!; assert.equal(fallback.payload["same_day"], true); assert.equal(fallback.payload["consent_status"], "suspect");
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM consents WHERE id = $1`, [consentId]))[0]!.status, "suspect", "consents.status = suspect");
  await settle();
  // Alex's Thread: the statement reads *Mailed* (no receipt action) and the re-verification ConsentCard is offered; the Record's document row is mailed
  const cards = await cardsOf(loanId, partyA);
  const mailed = byFlowKey(cards, `statement:${run.notice_id}`)!; assert.ok(mailed, "StatusCard `statement.mailed`"); assert.equal(mailed.copy_key, "statement.mailed"); assert.equal(mailed.props["bounced"], true); assert.equal(mailed.props["mailed_at"], now); assert.deepEqual(mailed.props["copy_tokens"], { month: "December 2027", date: "2027-11-20" });
  const re = cards.filter((c) => c.copy_key === "consent.esign.reverify").at(-1)!; assert.ok(re, "ConsentCard `consent.esign.reverify`"); assert.equal(re.kind, "ConsentCard"); assert.equal(re.status, "pending"); assert.equal(re.command_ref, "consent.capture"); assert.equal(re.props["reason"], "hard_bounce"); assert.equal(re.props["suspect_consent_id"], consentId); assert.equal(re.props["paper_until_active"], true); assert.deepEqual(re.props["scope"], [...SERVICING_ESIGN_SCOPES]);
  assert.equal((await cardsOf(loanId, main.partyB)).filter((c) => c.copy_key === "consent.esign.reverify").length, 0, "only the bounced party is asked to re-verify");
  const rec = await record(A, loanId); const doc = (rec["documents"] as P[]).find((d) => d["notice_id"] === run.notice_id)!; assert.ok(doc, "the statement is in Documents"); assert.equal(doc["status"], "mailed"); assert.match(String(doc["channel"]), /^mail/); assert.ok(doc["mailed_at"]);
  assert.ok((rec["needed_from_you"] as P[]).some((n) => n["card_instance_id"] === re.card_instance_id), "re-verification is needed from Alex");
});

test("32.8-T8: Given a shortage of $600, then the `ChoiceCard` shows +$50/month or $600 now; choosing spread creates a 12-installment plan and no lump-sum insert is rendered afterwards.", { skip }, async () => {
  const { A, partyA, partyB, loanId } = main;
  // Thu Nov 25, 2027: the annual analysis for the 2028 computation year finds the account $600.00 below the engine's target → shortage, 12 months, $50.00 a month (§1024.17(f)(3))
  clock.set(MST("2027-11-25", "09:00")); const id = `EA-${loanId.slice(0, 8)}-2028`; main.shortageAnalysisId = id;
  const a = await analysis(loanId, { id, type: "annual", year_start: D("2028-01-01"), as_of: D("2027-11-25"), actual_vs_target: -60_000n });
  assert.equal(a.decision["kind"], "shortage"); assert.equal(String(a.decision["shortage_cents"]), "60000"); assert.equal(a.decision["months"], 12); assert.equal(String(a.decision["installment_cents"]), "5000"); assert.equal(a.decision["lump_sum_option_offered"], true);
  const approved = (await events(loanId, "escrow.analysis.approved")).at(-1)!; assert.equal(approved.payload["analysis_id"], id); assert.equal(approved.payload["decision"], "shortage");
  assert.equal((await cardsOf(loanId, partyA)).filter((c) => c.copy_key === "escrow.shortage.choice").length, 0, "no choice before the statement is sent (3.3)");
  // 3.3 sends the annual statement (item (i): the new payment $4,140.12 of which $737.50 to escrow, effective Jan 1, 2028) → `escrow.statement.sent{stated_payment}` → the NoticeCard and the shortage ChoiceCard
  const parties = await servicingParties(runtime, loanId);
  const payload = { new_payment_cents: (INSTALLMENT + 5_000n).toString(), new_escrow_portion_cents: (ESCROW_PMT + 5_000n).toString(), prior_payment_cents: INSTALLMENT.toString(), prior_escrow_portion_cents: ESCROW_PMT.toString(), deposits_total_cents: "756250", out_total_cents: "825000",
    disbursements_by_line: [{ line: "County tax", amount_cents: "480000" }, { line: "Hazard insurance", amount_cents: "186000" }, { line: "Mortgage insurance", amount_cents: "159000" }], ending_balance_cents: (a.target - 60_000n).toString(), interest_credited_cents: "0",
    year_start: "2027-01-01", year_end: "2027-12-31", history: [{ month: "Jan 2027", deposits_cents: "68750", disbursements_cents: "0", balance_cents: "275000" }, { month: "Dec 2027", deposits_cents: "68750", disbursements_cents: "0", balance_cents: (a.target - 60_000n).toString(), assumed: true }],
    decision_text: "Your account has a shortage of $600.00.", plan_text: "$50.00 per month for 12 months beginning 01/01/2028.", shortage_at_least_one_month: false, bankruptcy_open: false, legend: null, low_point_not_reached: false, low_point_explanation: [],
    prior_projection_date: "2026-11-12", projection: [{ month: "Jan 2028", target_cents: a.target.toString() }], state_supplement_required: false, days_after_year_end: 0, new_payment_effective_on: "2028-01-01", ...CONTACT };
  const stmt = await exec("3.3", "sendNotice", loanId, ESCROW, { template_code: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", recipients: recipientsOf(parties), payload, due_on: "2028-01-30" });
  const sentEv = stmt.events.find((e) => e.type === "escrow.statement.sent")!; assert.ok(sentEv, "escrow.statement.sent"); assert.equal(sentEv.payload["statement_type"], "annual"); assert.equal(sentEv.payload["stated_payment_cents"], (INSTALLMENT + 5_000n).toString()); assert.equal(sentEv.payload["stated_payment_effective_on"], "2028-01-01"); assert.equal(sentEv.payload["shortage_explained"], true);
  await settle();
  const cards = await cardsOf(loanId, partyA);
  assert.ok(cards.some((c) => c.copy_key === "escrow.statement" && c.kind === "NoticeCard" && c.props["notice_code"] === "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"), "NoticeCard for the statement");
  const choice = byFlowKey(cards, `escrow.shortage:${id}`)!; assert.ok(choice, "ChoiceCard `escrow.shortage.choice`"); assert.equal(choice.kind, "ChoiceCard"); assert.equal(choice.command_ref, "escrow.electShortage"); assert.equal(choice.status, "pending");
  assert.deepEqual((choice.props["options"] as P[]).map((o) => o["label"]), ["Spread over 12 months (+$50.00/mo)", "Pay $600.00 now"]);
  assert.equal(choice.props["shortage_cents"], "60000"); assert.equal(choice.props["installment_cents"], "5000"); assert.equal(choice.props["months"], 12); assert.equal(choice.props["lump_sum_insert"], "NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT"); assert.equal(choice.props["fresh_l1_required"], true);
  const choiceB = byFlowKey(await cardsOf(loanId, partyB), `escrow.shortage:${id}`)!; assert.ok(choiceB, "Blake sees the same ask");
  // Alex chooses to spread it (fresh code) → escrow.electShortage{spread_12} → 3.6: the election and a 12-installment plan from Jan 1, 2028; the `loan_terms` version raises the escrow portion by $50.00
  clock.set(MST("2027-11-26", "10:00")); const tok = await fresh(A);
  const r = await resolve(tok, choice.card_instance_id, { option_id: "spread_12", evidence: { option_id: "spread_12", tapped_at: clock.now() } }); assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 600));
  const out = ((r.body["result"] ?? (r.body["card"] as P | undefined)?.["evidence"]) as P | undefined) ?? {};
  const result = (out["command_output"] as P | undefined) ?? out; assert.equal(result["option"], "spread_12"); assert.equal(result["plan_months"], 12); assert.equal(result["installment_cents"], "5000"); assert.equal(result["lump_sum_insert"], "not_rendered");
  await settle();
  const created = (await events(loanId, "escrow.repayment_plan.created")).at(-1)!; assert.equal(created.payload["analysis_id"], id); assert.equal(created.payload["kind"], "shortage"); assert.equal(created.payload["months"], 12); assert.equal(created.payload["installment_cents"], "5000"); assert.equal(created.payload["total_cents"], "60000"); assert.equal(created.payload["start_due_date"], "2028-01-01"); assert.equal(created.payload["end_due_date"], "2028-12-01");
  const plan = (await entity("escrow_repayment_plans", String(created.payload["plan_id"])))!; assert.equal(plan["status"], "active"); assert.equal(plan["months"], 12);
  const terms = (await entity("loan_terms", loanId))!; assert.equal(String(terms["escrow_payment_cents"]), (ESCROW_PMT + 5_000n).toString()); assert.equal(terms["escrow_payment_effective_from"], "2028-01-01");
  assert.equal((await events(loanId, "escrow.election.recorded")).at(-1)!.payload["kind"], "shorter_period");
  assert.ok(!(await events(loanId, "notice.rendered")).some((e) => e.payload["template"] === "NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT"), "no lump-sum insert is rendered after the spread election");
  const after = await cardsOf(loanId, partyA);
  assert.equal(after.find((c) => c.card_instance_id === choice.card_instance_id)!.status, "resolved"); assert.equal((await cardsOf(loanId, partyB)).find((c) => c.card_instance_id === choiceB.card_instance_id)!.status, "cancelled", "the co-borrower's ask is withdrawn");
  const planCard = byFlowKey(after, `escrow.plan:${String(created.payload["plan_id"])}`)!; assert.ok(planCard, "StatusCard `escrow.plan.created`"); assert.deepEqual(planCard.props["copy_tokens"], { n: "12", money: "$50.00", date: "2028-01-01" }); assert.equal(planCard.props["lump_sum_insert"], "not_rendered");
  const facts = await loanCashState(runtime, loanId, D("2028-01-01")); assert.equal(facts.state.installments.find((x) => x.due_date === "2028-01-01")!.escrow_cents, ESCROW_PMT + 5_000n); assert.equal(facts.state.installments.find((x) => x.due_date === "2027-12-01")!.escrow_cents, ESCROW_PMT);
});

test("32.8-T6: Given an escrow analysis raising the payment on Jan 1, then `AUTODRAFT-AMOUNT-CHANGE-v1` is sent ≥ 10 days before the Jan draft unless the escrow statement stated the exact amount and date.", { skip }, async () => {
  const { A, partyA, loanId, enrollmentId } = main;
  const NEXT = INSTALLMENT + 5_000n;   // $4,140.12 from Jan 1, 2028 (T8's plan)
  // Dec 1, 2027: the last debit at $4,090.12 settles and posts — the enrollment's `last_debit_cents`
  clock.set("2027-12-01T07:00:00.000Z");
  await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "settle", id: enrollmentId, loan_id: loanId, amount_cents: INSTALLMENT.toString(), settlement_date: "2027-12-01", installment_due_date: "2027-12-01", next_draft_on: "2028-01-01" });
  await tick("2027-12-01T07:30:00.000Z");
  const e0 = (await entity("autodraft_enrollments", enrollmentId))!; assert.equal(e0["last_debit_cents"], INSTALLMENT.toString()); assert.equal(e0["next_draft_on"], "2028-01-01");
  const parties = await servicingParties(runtime, loanId); const stmtEv = (await events(loanId, "escrow.statement.sent")).at(-1)!;
  // (a) the annual statement stated the exact amount and the Jan 1 date on Nov 25 (≥ 10 days before): 2.3 rule 5 is satisfied by the statement — no dedicated notice
  clock.set(MST("2027-12-10", "09:00"));
  const a = await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "amount_change_check", id: enrollmentId, loan_id: loanId, next_amount_cents: NEXT.toString(), debit_on: "2028-01-01", today: "2027-12-10", prior_amount_cents: INSTALLMENT.toString(), reason: "your escrow payment changed after the annual escrow analysis", recipients: recipientsOf(parties),
    statement: { template: String(stmtEv.payload["template"]), sent_on: String(stmtEv.payload["sent_on"]), amount_cents: String(stmtEv.payload["stated_payment_cents"]), debit_on: String(stmtEv.payload["stated_payment_effective_on"]) } });
  const oa = a.output as P; assert.equal(oa["ok"], true); assert.equal(oa["satisfied_by"], "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"); assert.equal(oa["sent"], false);
  assert.equal(a.events.filter((x) => x.type === "notice.rendered" && x.payload["template"] === "AUTODRAFT-AMOUNT-CHANGE-v1").length, 0);
  const e1 = (await entity("autodraft_enrollments", enrollmentId))!; const notices = e1["notices"] as P[]; assert.ok(notices.some((n) => n["template"] === "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT" && n["amount_cents"] === NEXT.toString() && n["debit_on"] === "2028-01-01"));
  // (b) a changed debit no statement stated (the Feb 1 draft): the dedicated notice AUTODRAFT-AMOUNT-CHANGE-v1 is rendered and sent ≥ 10 days before (`on_time`), REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10
  const b = await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "amount_change_check", id: enrollmentId, loan_id: loanId, next_amount_cents: NEXT.toString(), debit_on: "2028-02-01", today: "2027-12-10", prior_amount_cents: INSTALLMENT.toString(), reason: "your escrow payment changed after the annual escrow analysis", recipients: recipientsOf(parties) });
  const ob = b.output as P; assert.equal(ob["ok"], false); assert.equal(ob["sent"], true); assert.equal(ob["on_time"], true); assert.equal(ob["action"], "send_dedicated_notice"); assert.equal(ob["deadline"], "2028-01-22");
  assert.ok(b.events.some((x) => x.type === "notice.rendered" && x.payload["template"] === "AUTODRAFT-AMOUNT-CHANGE-v1"), "AUTODRAFT-AMOUNT-CHANGE-v1 rendered");
  const ns = b.events.find((x) => x.type === "notice.sent" && x.payload["kind"] === "variable_amount_10d")!; assert.ok(ns, "2.3's variable-amount notice fact"); assert.equal(ns.payload["debit_on"], "2028-02-01"); assert.equal(ns.payload["amount_cents"], NEXT.toString()); assert.equal(ns.payload["on_time"], true);
  await settle();
  const card = byFlowKey(await cardsOf(loanId, partyA), `autopay.amount_change:${enrollmentId}:2028-02-01`)!; assert.ok(card, "NoticeCard `autopay.amount_change`"); assert.equal(card.props["notice_code"], "AUTODRAFT-AMOUNT-CHANGE-v1"); assert.deepEqual(card.props["copy_tokens"], { money: "$4,140.12", date: "2028-02-01" }); assert.equal(card.props["on_time"], true);
  // the engine's rule, stated on the enrollment row: a $4,140.12 Jan 1 debit is covered by the statement; a Feb 1 debit by the dedicated notice; a March debit by neither
  const e2 = (await entity("autodraft_enrollments", enrollmentId))!; const enr = { ...e2, last_debit_cents: INSTALLMENT, notices: (e2["notices"] as P[]).map((n) => ({ template: String(n["template"]), sent_on: D(String(n["sent_on"])), amount_cents: BigInt(String(n["amount_cents"])), debit_on: D(String(n["debit_on"])) })) } as unknown as Enrollment;
  assert.deepEqual(variableAmountNoticeStatus(enr, NEXT, D("2028-01-01"), D("2027-12-20")), { ok: true, satisfied_by: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT" });
  assert.deepEqual(variableAmountNoticeStatus(enr, NEXT, D("2028-02-01"), D("2027-12-20")), { ok: true, satisfied_by: "AUTODRAFT-AMOUNT-CHANGE-v1" });
  assert.equal(variableAmountNoticeStatus(enr, NEXT, D("2028-03-01"), D("2027-12-20")).ok, false);
  // Mon Dec 20 00:30: the daily sweep's own check for the Jan 1 draft reads the same statement → nothing more is sent; the December pass also offers the `irs_estatement` consent (T11)
  await tick(MST("2027-12-20", "00:30"));
  assert.equal((await events(loanId, "notice.rendered")).filter((x) => x.payload["template"] === "AUTODRAFT-AMOUNT-CHANGE-v1").length, 1, "one dedicated notice in all");
  assert.equal((await events(loanId, "autodraft.entry.held")).length, 0);
});

test("32.8-T4: Given `ach.return.received{R01}`, then `AUTODRAFT-RETURN-v1` renders, one retry is scheduled in 3–5 banking days, and a second R01 moves the enrollment to `suspended_returns` with a re-activation `ChoiceCard`.", { skip }, async () => {
  const { A, partyA, loanId, enrollmentId } = main;
  const NEXT = INSTALLMENT + 5_000n; const parties = await servicingParties(runtime, loanId);
  // Sat Jan 1, 2028: the $4,140.12 draft settles and posts; Tue Jan 4 the bank returns it R01 (NSF)
  clock.set("2028-01-01T07:00:00.000Z");
  const s1 = await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "settle", id: enrollmentId, loan_id: loanId, amount_cents: NEXT.toString(), settlement_date: "2028-01-01", installment_due_date: "2028-01-01", next_draft_on: "2028-02-01" });
  const pay1 = String((s1.output as P)["payment_id"]);
  await tick("2028-01-01T07:30:00.000Z");
  assert.equal((await entity("payments", pay1))!["status"], "posted"); assert.equal((await loanCashState(runtime, loanId, D("2028-01-02"))).state.installments.find((x) => x.due_date === "2028-01-01")!.status, "satisfied");
  clock.set(MST("2028-01-04", "09:00"));
  const r1 = await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "return", id: enrollmentId, loan_id: loanId, code: "R01", returned_on: "2028-01-04", original_entry_on: "2028-01-01", payment_id: pay1, amount_cents: NEXT.toString(), installment_due_date: "2028-01-01", trace: `${enrollmentId}:2028-01-01`, recipients: recipientsOf(parties) });
  const o1 = r1.output as { disposition: P; notice_template: string; notice_id: string | null; notice_status: string | null; status: string };
  const ret = r1.events.find((e) => e.type === "ach.return.received")!; assert.ok(ret, "ach.return.received{R01}"); assert.equal(ret.payload["reason_code"], "R01"); assert.equal(ret.payload["R01"], true); assert.equal(ret.payload["original_settlement_date"], "2028-01-01");
  assert.equal(o1.notice_template, "AUTODRAFT-RETURN-v1"); assert.ok(r1.events.some((e) => e.type === "notice.rendered" && e.payload["template"] === "AUTODRAFT-RETURN-v1"), "AUTODRAFT-RETURN-v1 renders"); assert.ok(o1.notice_id);
  // one retry, 3 banking days out (Tue Jan 4 → Fri Jan 7 on the federal calendar) — inside the 3–5 banking-day window
  const retry = r1.events.find((e) => e.type === "ach.entry.reinitiation_scheduled")!; assert.ok(retry, "one reinitiation scheduled"); assert.equal(retry.payload["retry_on"], "2028-01-07"); assert.equal(retry.payload["company_entry_description"], "RETRY PYMT");
  assert.equal(addBusinessDays(D("2028-01-04"), 3, federal), "2028-01-07"); assert.equal(o1.disposition["retry_banking_days"], 3); assert.ok(Number(o1.disposition["retry_banking_days"]) >= 3 && Number(o1.disposition["retry_banking_days"]) <= 5);
  assert.equal(o1.status, "active", "the enrollment stays active after one return");
  const reversed = r1.events.find((e) => e.type === "payment.reversed")!; assert.equal(reversed.payload["payment_id"], pay1); assert.equal(reversed.payload["return_code"], "R01");
  assert.equal((await entity("payments", pay1))!["status"], "reversed"); assert.equal((await loanCashState(runtime, loanId, D("2028-01-05"))).state.installments.find((x) => x.due_date === "2028-01-01")!.status, "due", "the installment is due again");
  await settle();
  const noticeCard = byFlowKey(await cardsOf(loanId, partyA), `payment.returned:${o1.notice_id}`)!; assert.ok(noticeCard, "NoticeCard `payment.returned`"); assert.equal(noticeCard.copy_key, "payment.returned"); assert.deepEqual(noticeCard.props["copy_tokens"], { date: ["2028-01-01", "2028-01-07"] }); assert.equal(noticeCard.props["retry_on"], "2028-01-07"); assert.equal(noticeCard.props["return_code"], "R01");
  // Fri Jan 7: the retry settles and posts; Mon Jan 10 it comes back R01 again → `suspended_returns` (2.x rule 7), no further retry, the re-activation ChoiceCard and a PaymentCard for another account
  clock.set("2028-01-07T07:00:00.000Z");
  const s2 = await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "settle", id: enrollmentId, loan_id: loanId, amount_cents: NEXT.toString(), settlement_date: "2028-01-07", installment_due_date: "2028-01-01", payment_id: `ACH-${loanId.slice(0, 8)}-2028-01-07`, trace: `${enrollmentId}:2028-01-07` });
  const pay2 = String((s2.output as P)["payment_id"]); await tick("2028-01-07T07:30:00.000Z"); assert.equal((await entity("payments", pay2))!["status"], "posted");
  clock.set(MST("2028-01-10", "09:00"));
  const r2 = await exec("2.3", "autodraft.read/write", loanId, CASHIERING, { op: "return", id: enrollmentId, loan_id: loanId, code: "R01", returned_on: "2028-01-10", original_entry_on: "2028-01-07", payment_id: pay2, amount_cents: NEXT.toString(), installment_due_date: "2028-01-01", trace: `${enrollmentId}:2028-01-07`, recipients: recipientsOf(parties) });
  const o2 = r2.output as { disposition: P; notice_id: string | null; status: string };
  assert.equal(o2.status, "suspended_returns"); assert.equal(o2.disposition["enrollment_action"], "suspended_returns"); assert.equal(o2.disposition["retry_on"], null);
  const changed = r2.events.find((e) => e.type === "autodraft.status.changed")!; assert.equal(changed.payload["status"], "suspended_returns"); assert.equal(changed.payload["return_code"], "R01");
  assert.equal(r2.events.filter((e) => e.type === "ach.entry.reinitiation_scheduled").length, 0, "no second retry");
  const e = (await entity("autodraft_enrollments", enrollmentId))!; assert.equal(e["status"], "suspended_returns"); assert.equal(e["returns_on_current_installment"], 2);
  await settle();
  const cards = await cardsOf(loanId, partyA);
  const choice = byFlowKey(cards, `autopay.suspended:${enrollmentId}`)!; assert.ok(choice, "re-activation ChoiceCard"); assert.equal(choice.kind, "ChoiceCard"); assert.equal(choice.copy_key, "autopay.suspended.choice"); assert.equal(choice.command_ref, "autodraft.change"); assert.equal(choice.status, "pending");
  assert.deepEqual((choice.props["options"] as P[]).map((o) => o["id"]), ["reactivate", "pay_another_way"]); assert.equal((choice.props["options"] as P[])[0]!["label"], "Use account ····9876 again");
  const another = byFlowKey(cards, `pay:another_way:${enrollmentId}`)!; assert.ok(another, "PaymentCard with a different account"); assert.equal(another.copy_key, "payment.another_way"); assert.equal(another.props["add_account"], true); assert.equal(another.props["installment_due_date"], "2028-01-01");
  assert.equal(byFlowKey(cards, `payment.returned:${o2.notice_id}`)?.copy_key, "payment.returned.final", "the second return's NoticeCard says autopay is paused");
  const rec = await record(A, loanId); assert.equal(((rec["loan"] as P)["autodraft"] as P)["status"], "suspended_returns");
});

test("32.8-T11: Given no `irs_estatement` consent, then the 1098 shows *Mailed* and the December `ConsentCard` was offered.", { skip }, async () => {
  const { A, partyA, partyB, loanId } = main;
  // the December pass (T6's Dec 20 tick) offered the `irs_estatement` ConsentCard to both borrowers — neither has the separate consent (7.4 rule 11: the E-SIGN consent alone never covers the 1098)
  assert.equal((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM consents WHERE party_id = ANY($1::uuid[]) AND kind = 'irs_estatement'`, [[partyA, partyB]]))[0]!.n, "0");
  for (const party of [partyA, partyB]) {
    const offered = byFlowKey(await cardsOf(loanId, party), "irs_estatement:2027")!; assert.ok(offered, "December ConsentCard{irs_estatement}"); assert.equal(offered.kind, "ConsentCard"); assert.equal(offered.copy_key, "consent.irs_estatement.title"); assert.equal(offered.status, "pending"); assert.equal(offered.command_ref, "consent.capture");
    assert.equal(offered.props["consent_kind"], "irs_estatement"); assert.equal(offered.props["disclosure_version_id"], "NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE"); assert.equal(offered.props["affirmation_method"], "checkbox_with_text"); assert.equal(offered.props["tax_year"], 2027); assert.ok(String(offered.created_at).startsWith("2027-12"), "offered in December");
  }
  // Thu Jan 20, 2028: 7.1-A furnishes the 2027 Form 1098 — IRS_1098_ECONSENT_GATE closed → paper (FAKE print/mail, same day), by January 31
  const now = MST("2028-01-20", "09:00"); clock.set(now);
  const f = await furnishForm1098(runtime, loanId, { tax_year: 2027, furnished_on: D("2028-01-20"), now });
  assert.equal(f.channel, "paper"); assert.equal(f.gate_open, false); assert.ok(BigInt(f.box1_cents) > 0n, "box 1: the year's interest from the ledger"); assert.equal(BigInt(f.box2_cents), 56_000_000n, "box 2: the principal balance at Jan 1, 2027 (the first installment posted Jan 12)");
  const requested = (await events(loanId, "tax_form.1098.furnish_requested")).at(-1)!; assert.equal(requested.payload["gate"], "IRS_1098_ECONSENT_GATE"); assert.equal(requested.payload["gate_open"], false); assert.equal(requested.payload["furnish_channel"], "paper"); assert.equal(requested.payload["furnish_by"], "2028-01-31");
  const furnished = (await events(loanId, "tax_form.1098.furnished")).at(-1)!; assert.equal(furnished.payload["channel"], "paper"); assert.equal(furnished.payload["tax_year"], 2027); assert.equal(furnished.payload["furnished_on"], "2028-01-20");
  await settle();
  const card = byFlowKey(await cardsOf(loanId, partyA), "1098:2027")!; assert.ok(card, "NoticeCard `year_end.1098`"); assert.equal(card.kind, "NoticeCard"); assert.equal(card.props["notice_code"], "NTC_IRS_1098"); assert.equal(card.props["channel"], "mail"); assert.ok(card.props["mailed_at"]); assert.deepEqual(card.props["copy_tokens"], { year: "2027", date: "2028-01-20" });
  const rec = await record(A, loanId); const ye = (rec["loan"] as P)["year_end"] as P; assert.equal(ye["form_1098_status"], "mailed"); assert.equal(ye["tax_year"], 2027); assert.equal(ye["furnished_on"], "2028-01-20"); assert.equal(ye["channel"], "paper");
  assert.ok((rec["documents"] as P[]).some((d) => d["notice_code"] === "NTC_IRS_1098" && d["status"] === "mailed"), "Documents lists the mailed 1098");
});
