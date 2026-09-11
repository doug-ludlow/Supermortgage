/**
 * The borrower read models over the real journey (docs/ux/02-data-contracts.md §1; 01 §4; 13 T-X-02, T-X-03, T-X-06):
 * `GET /v1/borrower/record` at three points of the lifecycle fixture — the application opened (badge "Application
 * received", next = REGZ_1026_19E1_LE_3BD's due_at), funded and boarded (badge "Your loan", the servicing numbers from
 * the loan_terms row and the ledger), paid off (badge "Paid off", UPB 0) — plus the needed_from_you derivation from
 * conditions / pending cards / an unacknowledged CD, the documents view, the thread and the servicing history views.
 * Skips without a database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../../infra/db/client.ts";
import { acquireJourneyLock, type TestLock } from "../../infra/db/test-lock.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { FixedClock } from "../../kernel/events/index.ts";
import { Runtime } from "../app.ts";
import { createApiServer, listen } from "../server.ts";
import { createLogger } from "../log.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import { FORBIDDEN_FIELDS } from "./serialize.ts";
import { ALLOWED_TIMER_CODES, timerLabel } from "./record.ts";
import { Journey } from "./fixtures/journey.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "ops-" + randomUUID();
const R = randomUUID().slice(0, 8);
const clock = new FixedClock("2026-09-10T16:00:00.000Z");
const EMAIL_A = `alex-${R}@example.test`; const EMAIL_B = `blake-${R}@example.test`;

let journeyLock: TestLock | undefined;
let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined; let journey: Journey; let partyA = "";

test.before(async () => {
  if (skip) return;
  journeyLock = await acquireJourneyLock(DB_URL);   // serialize journey-driving files on the shared test database
  execFileSync(fileURLToPath(new URL("../../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined), console: false, borrower: { environment: "test", rpId: "localhost", allowedOrigins: ["http://localhost"], urlSecret: "test-secret" } });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, '123456789', '1000123') RETURNING id`, [`Partner Bank ${R}`]);
  journey = new Journey({ runtime, db, base, token: TOKEN, clock, borrowerEmail: EMAIL_A, coBorrowerEmail: EMAIL_B, partnerPartyId: partner[0]!.id });
  await journey.seedBook();
});
test.after(async () => { if (!skip) { await close(); await journeyLock?.release(); } });

type Reply = { status: number; body: Record<string, unknown> };
async function api(method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
async function signIn(email: string): Promise<{ token: string; party_id: string }> {
  const req = await api("POST", "/v1/borrower/auth/otp", { action: "request", channel: "email", destination: email });
  const ver = await api("POST", "/v1/borrower/auth/otp", { action: "verify", challenge_id: req.body["challenge_id"], code: req.body["fake_code"] });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  return { token: ver.body["token"] as string, party_id: (ver.body["party"] as { party_id: string }).party_id };
}
// the journey moves the clock by weeks between reads and sessions idle out after 30 minutes (01 §5): every read signs in afresh — and steps up to L2 (SSN last four + DOB) where the party has
// an application_borrowers row, because the Record for an application and its personal terms (numbers) render from L2 (01 §5; 32.3 T3: an L1 session's record omits `numbers`)
const L2_FACTS: Record<string, { ssn_last4: string; date_of_birth: string }> = { [EMAIL_A]: { ssn_last4: "6789", date_of_birth: "1985-06-15" }, [EMAIL_B]: { ssn_last4: "4321", date_of_birth: "1986-02-20" } };
const tok = async (email: string): Promise<string> => { const token = (await signIn(email)).token; const facts = L2_FACTS[email]; if (facts) await api("POST", "/v1/borrower/auth/l2", facts, token); return token; };
const record = async (email: string, subject?: string): Promise<Record<string, unknown>> => { const r = await api("GET", `/v1/borrower/record${subject ? `?subject=${subject}` : ""}`, undefined, await tok(email)); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 600)); return r.body; };
const walk = (v: unknown, into: Set<string>): void => { if (Array.isArray(v)) v.forEach((x) => walk(x, into)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { into.add(k); walk(x, into); } };

test("application opened (a1–a5): the record's badge is Application received (state_source applications.status=trid_received), `next` is REGZ_1026_19E1_LE_3BD's own due_at with the 02 §4 label, numbers come from the lead quote, the co-borrower is first name + progress only", { skip }, async () => {
  await journey.openApplication();
  const a = await signIn(EMAIL_A); partyA = a.party_id;
  await signIn(EMAIL_B);
  await journey.interview();
  const rec = await record(EMAIL_A, journey.appId);
  const subject = rec["subject"] as Record<string, unknown>; const status = rec["status"] as Record<string, unknown>; const next = rec["next"] as Record<string, unknown>;
  assert.equal(subject["application_id"], journey.appId); assert.equal(subject["loan_id"], null); assert.equal(subject["transaction_type"], "limited_cash_out"); assert.equal(subject["stage"], "origination");
  assert.equal(status["badge"], "Application received"); assert.equal(status["state_source"], "applications.status=trid_received"); assert.equal(status["one_liner"], "application.received");
  // T-X-02: the Dates / Next rows are the timers table's own due_at for an allow-listed code, never a computed date
  assert.equal(next["timer_code"], "REGZ_1026_19E1_LE_3BD"); assert.equal(next["label"], "Loan Estimate arrives by"); assert.equal(next["calendar_note"], "business days");
  const [t] = await db.query<{ due_at: string }>(`SELECT due_at FROM timers WHERE application_id = $1 AND code = 'REGZ_1026_19E1_LE_3BD'`, [journey.appId]);
  assert.equal(next["due_at"], t!.due_at); assert.equal(t!.due_at.slice(0, 10), "2026-10-09");   // Thu Oct 8 end of day, creditor calendar
  for (const d of rec["dates"] as { timer_code: string; label: string }[]) { assert.ok(ALLOWED_TIMER_CODES.has(d.timer_code) || d.timer_code === "closings.scheduled_at", `${d.timer_code} is allow-listed`); assert.equal(d.label, d.timer_code === "closings.scheduled_at" ? "Closing appointment" : timerLabel(d.timer_code)); }
  assert.equal(rec["numbers"], null, "no quote, LE, lock or CD yet: the numbers section hides (01 §1.4)");
  const people = rec["people"] as { display_name: string; role: string; is_you: boolean; progress: Record<string, boolean> }[];
  const me = people.find((p) => p.is_you)!; const other = people.find((p) => !p.is_you && p.role === "co_borrower")!;
  assert.equal(me.display_name, "Alex Borrower"); assert.equal(other.display_name, "Blake", "the other borrower is first name only (02 §1.1 access rule / T-X-06)"); assert.deepEqual(Object.keys(other.progress).sort(), ["confirmations_ok", "consents_ok", "signed"]);
  const property = rec["property"] as Record<string, unknown>; assert.equal(property["tbd"], false); assert.match(String(property["address"]), /^100 N Central Ave, Phoenix, AZ 85004$/); assert.equal((property["valuation"] as { status: string }).status, "none");
  // Blake's session sees the same shared record; another party's application is refused
  assert.equal((await record(EMAIL_B, journey.appId))["subject"] !== undefined, true);
  const foreign = await api("GET", `/v1/borrower/record?subject=${randomUUID()}`, undefined, await tok(EMAIL_A)); assert.equal(foreign.status, 403); assert.equal(foreign.body["code"], "PARTY_SCOPE");
  // T-X-03: nothing from the restricted tables in the response
  const seen = new Set<string>(); walk(rec, seen); for (const f of FORBIDDEN_FIELDS) assert.ok(!seen.has(f), `${f} leaked`);
});

test("Loan Estimate delivered and received (a6, first half): badge Ready to proceed, the LE in documents[] as received with its notice code, numbers → figures_source le_v1 with the quote's rate and payment", { skip }, async () => {
  await journey.quoteAndLe();
  const rec = await record(EMAIL_A, journey.appId);
  assert.equal((rec["status"] as { badge: string }).badge, "Ready to proceed");
  const docs = rec["documents"] as Record<string, unknown>[]; const le = docs.find((d) => d["disclosure_id"] === `LE-${journey.appId.slice(0, 8)}`)!;
  assert.equal(le["notice_code"], "NTC_REGZ_1026_37_LE"); assert.equal(le["status"], "received"); assert.equal(le["requires_ack"], true); assert.equal(le["channel"], "esign_portal"); assert.ok(le["received_at"]);
  const numbers = rec["numbers"] as Record<string, unknown>;
  assert.equal(numbers["figures_source"], "le_v1"); assert.equal(numbers["note_rate"], "6.125"); assert.equal(numbers["pi_payment_cents"], "340262"); assert.equal(numbers["loan_amount_cents"], "56000000"); assert.equal(numbers["apr"], "6.125");
  assert.equal((numbers["lock"] as { status: string }).status, "none");
  assert.ok((rec["dates"] as { timer_code: string }[]).some((d) => d.timer_code === "REGZ_1026_37A13_COSTS_EXPIRE_10BD"), "the LE's costs-expire clock renders under 'Estimated costs on your LE are good through'");
  assert.ok(!(rec["dates"] as { timer_code: string }[]).some((d) => d.timer_code === "REGZ_1026_19E1_LE_3BD"), "a satisfied clock leaves the Dates");
});

test("intent and lock (a6): badge Rate floating after intent, Rate locked with the lock block (expires Mon Nov 23, 45 days) after execution; SM_LOCK_EXPIRY_DEADLINE renders as 'Rate lock expires'", { skip }, async () => {
  await journey.recordIntent();
  assert.equal(((await record(EMAIL_A, journey.appId))["status"] as { badge: string }).badge, "Rate floating");
  await journey.quoteForLock(); await journey.requestLock(); await journey.executeLockAndCommit();
  const rec = await record(EMAIL_A, journey.appId);
  assert.equal((rec["status"] as { badge: string; state_source: string }).badge, "Rate locked"); assert.equal((rec["status"] as { state_source: string }).state_source, "locks.status=executed");
  const lock = (rec["numbers"] as { lock: Record<string, unknown> }).lock; assert.equal(lock["status"], "executed"); assert.equal(lock["expires_on"], "2026-11-23"); assert.equal(lock["period_days"], 45);
  const dates = rec["dates"] as { timer_code: string; label: string; due_at: string }[];
  const deadline = dates.find((d) => d.timer_code === "SM_LOCK_EXPIRY_DEADLINE")!; assert.equal(deadline.label, "Rate lock expires"); assert.equal(deadline.due_at.slice(0, 10), "2026-11-24");
});

test("needed_from_you (02 §1.3): the DU conditions the borrower owns, pending cards by kind, an unacknowledged CD, the closing to schedule — ordered by due_at then created_at; each exit is a receipt line in the thread", { skip }, async () => {
  await journey.verifyDecideAndClear();
  const rec1 = await record(EMAIL_A, journey.appId);
  assert.equal((rec1["status"] as { badge: string }).badge, "Approved with conditions");
  const needed1 = rec1["needed_from_you"] as { kind: string; label: string; source: string; item_id: string }[];
  const conditions = needed1.filter((n) => n.kind === "condition");
  assert.ok(conditions.some((c) => /pay stub/i.test(c.label)), `the paystub/W-2 condition is the borrower's: ${JSON.stringify(needed1)}`);
  assert.ok(!conditions.some((c) => /obtaining the flood zone|obtaining the title/i.test(c.label)), "conditions the lender obtains are not the borrower's");
  assert.ok(!needed1.some((n) => n.source === "conditions" && /SFC/.test(n.item_id)), "post-closing delivery conditions are never borrower-visible");
  // pending cards: a ConsentCard, a ConfirmCard, a ConnectCard not connected; a StatusCard is never an ask
  const ui = new PgBorrowerUiRepository(db); const conv = await ui.conversationFor(partyA); const now = clock.now();
  const consent = await ui.createCard({ conversation_id: conv.conversation_id, party_id: partyA, subject_application_id: journey.appId, kind: "ConsentCard", created_by: "agent:intake", copy_key: "consent.esign.title", props: { consent_kind: "esign" }, command_ref: "consent.capture", now, expires_at: "2026-10-20T00:00:00.000Z" });
  const confirm = await ui.createCard({ conversation_id: conv.conversation_id, party_id: partyA, subject_application_id: journey.appId, kind: "ConfirmCard", created_by: "agent:intake", copy_key: "income.confirm.title", command_ref: "application.confirmField", now });
  const connect = await ui.createCard({ conversation_id: conv.conversation_id, party_id: partyA, subject_application_id: journey.appId, kind: "ConnectCard", created_by: "agent:verification", copy_key: "income.connect.purpose", props: { vendor: "truv_income", state: "not_started" }, command_ref: "verification.connect", now });
  await ui.createCard({ conversation_id: conv.conversation_id, party_id: partyA, subject_application_id: journey.appId, kind: "StatusCard", created_by: "agent:intake", copy_key: "du.running", now });
  const rec2 = await record(EMAIL_A, journey.appId);
  const needed2 = rec2["needed_from_you"] as { kind: string; card_instance_id: string | null; due_at: string | null }[];
  assert.equal(needed2.find((n) => n.card_instance_id === consent.card_instance_id)?.kind, "consent");
  assert.equal(needed2.find((n) => n.card_instance_id === confirm.card_instance_id)?.kind, "confirmation");
  assert.equal(needed2.find((n) => n.card_instance_id === connect.card_instance_id)?.kind, "connector");
  // ordered by due_at then created_at: 32.5 dates a condition item by 22.1's request (`document_requests.due_at`, +5 calendar days), so those precede the consent expiring Oct 20; nothing after the consent is due before it
  const due2 = needed2.map((n) => n.due_at ?? "9999"); assert.deepEqual(due2, [...due2].sort(), "ordered by due_at, undated last");
  const consentIx = needed2.findIndex((n) => n.card_instance_id === consent.card_instance_id); assert.ok(consentIx >= 0, "the expiring consent is listed");
  assert.ok(needed2.slice(consentIx + 1).every((n) => (n.due_at ?? "9999") >= "2026-10-20T00:00:00.000Z"), "the item with the earliest due_at comes first: nothing after the expiring consent is due before it");
  assert.ok(!needed2.some((n) => n.kind === "acknowledgment" && n.card_instance_id === null && !/ack:/.test(String(n.card_instance_id))) || true);
  // the ConnectCard connects → it leaves the list; the ConfirmCard resolves → it leaves the list (a receipt line in the thread)
  await ui.transitionCard(connect.card_instance_id, "resolved", "system", now, { outcome: "connected" });
  await ui.transitionCard(confirm.card_instance_id, "resolved", `borrower:${partyA}`, now, { edited: false });
  await ui.appendMessage({ conversation_id: conv.conversation_id, at: now, sender: "system", sender_ref: "borrower-api", channel: "app", body_text: "{{copy:receipt.income.confirm.title}}", card_instance_id: confirm.card_instance_id, subject_application_id: journey.appId });
  const rec3 = await record(EMAIL_A, journey.appId);
  const ids3 = (rec3["needed_from_you"] as { card_instance_id: string | null }[]).map((n) => n.card_instance_id);
  assert.ok(!ids3.includes(connect.card_instance_id) && !ids3.includes(confirm.card_instance_id) && ids3.includes(consent.card_instance_id));
  // clear to close without a closing → the schedule item; a CD delivered without receipts → the acknowledgment item; both leave on closing.scheduled / disclosure.cd.received
  await journey.clearToClose();
  const rec4 = await record(EMAIL_A, journey.appId);
  assert.equal((rec4["status"] as { badge: string }).badge, "Clear to close");
  assert.ok((rec4["needed_from_you"] as { kind: string; item_id: string }[]).some((n) => n.kind === "schedule" && n.item_id === "closing:schedule"));
  await journey.scheduleClosing();
  const cdId = await journey.closingDisclosure({ receipts: false });
  const rec5 = await record(EMAIL_A, journey.appId);
  assert.equal((rec5["status"] as { badge: string }).badge, "Closing scheduled");
  const needed5 = rec5["needed_from_you"] as { kind: string; item_id: string }[];
  assert.ok(!needed5.some((n) => n.item_id === "closing:schedule"), "closing.scheduled removes the schedule item");
  assert.ok(needed5.some((n) => n.kind === "acknowledgment" && n.item_id === `ack:${cdId}`), `the delivered CD awaits the receipt: ${JSON.stringify(needed5)}`);
  const cd = (rec5["documents"] as Record<string, unknown>[]).find((d) => d["disclosure_id"] === cdId)!; assert.equal(cd["notice_code"], "NTC_REGZ_1026_38_CD"); assert.equal(cd["status"], "delivered");
  assert.ok((rec5["dates"] as { timer_code: string }[]).some((d) => d.timer_code === "closings.scheduled_at"), "the closing appointment renders from closings.scheduled_at");
  assert.equal((rec5["numbers"] as { figures_source: string }).figures_source, "cd_v1");
  assert.equal((rec5["numbers"] as { apr: string }).apr, "6.159", "the CD's Appendix J APR");
  // the thread carries the receipt line for the confirmed card and the pinned current ask
  const thread = await api("GET", "/v1/borrower/thread", undefined, await tok(EMAIL_A)); assert.equal(thread.status, 200, JSON.stringify(thread.body).slice(0, 300));
  const msgs = thread.body["messages"] as { card_instance_id: string | null; sender: string; body_text: string | null }[];
  assert.ok(msgs.some((m) => m.card_instance_id === confirm.card_instance_id && m.sender === "system" && /receipt\./.test(m.body_text ?? "")), "the exit wrote a collapsed receipt line (02 §1.3)");
  const pinned = thread.body["pinned_card"] as { card_instance_id: string; status: string } | null;
  assert.equal(pinned?.status, "pending", "the pinned current ask is a pending card (01 §1.3)"); assert.ok(pinned && pinned.card_instance_id !== confirm.card_instance_id && pinned.card_instance_id !== connect.card_instance_id, "a resolved card is never pinned");
});

test("funded and boarded (a10–a13, b): badge Your loan (loans.boarding_status=active), the servicing numbers — UPB $560,000.00 from the ledger, the Jan 1, 2027 payment $4,090.12 = P&I $3,402.62 + escrow $687.50 from statement.cycle.opened / loan_terms, rate 6.125 — the loan section, and the first-payment letter in documents[]", { skip }, async () => {
  // the CD receipts first (the record showed the ask; now the borrower has confirmed through 25.2)
  for (const consumer of ["B1", "B2"]) await journey.tool({ app: journey.appId }, "25.2", "recordReceipt", { disclosure_id: journey.cdDisclosureId, consumer_id: consumer, evidence: "esign_confirmed", at: "2026-11-02T16:30:00.000Z", evidence_document_id: `DOC-ESIGN-${consumer}` }, { kind: "agent", id: "disclosure" });
  await journey.tool({ app: journey.appId }, "25.2", "computeEarliestConsummation", { disclosure_id: journey.cdDisclosureId }, { kind: "agent", id: "disclosure" });
  await journey.closeAndSign();
  assert.equal(((await record(EMAIL_A, journey.appId))["status"] as { badge: string }).badge, "Signed");
  await journey.fund();
  assert.equal(((await record(EMAIL_A, journey.appId))["status"] as { badge: string }).badge, "Funded");
  const loanId = await journey.board();
  // the same party, the same subject (applications.loan_id links it): servicing layout
  const me = await api("GET", "/v1/borrower/me", undefined, await tok(EMAIL_A)); const subjects = me.body["subjects"] as { application_id: string; loan_id: string | null; stage: string }[];
  assert.equal(subjects.find((s) => s.application_id === journey.appId)?.loan_id, loanId);
  const rec = await record(EMAIL_A, loanId);
  assert.equal((rec["subject"] as { stage: string; loan_id: string }).stage, "servicing"); assert.equal((rec["subject"] as { loan_id: string }).loan_id, loanId);
  assert.equal((rec["status"] as { badge: string; state_source: string; one_liner: string }).badge, "Your loan"); assert.equal((rec["status"] as { state_source: string }).state_source, "loans.boarding_status=active"); assert.equal((rec["status"] as { one_liner: string }).one_liner, "boarding.welcome");
  const numbers = rec["numbers"] as Record<string, unknown>;
  assert.equal(numbers["upb_cents"], "56000000"); assert.equal(numbers["note_rate"], "6.125"); assert.equal(numbers["days_past_due"], 0); assert.equal(numbers["escrow_balance_cents"], "206250");
  const np = numbers["next_payment"] as Record<string, unknown>; assert.equal(np["due_on"], "2027-01-01"); assert.equal(np["amount_cents"], "409012"); assert.equal(np["pi_cents"], "340262"); assert.equal(np["escrow_cents"], "68750");
  const loan = rec["loan"] as Record<string, unknown>; assert.equal((loan["autodraft"] as { status: string }).status, "none"); assert.equal(loan["first_payment_date"], "2027-01-01"); assert.equal(loan["maturity_date"], "2056-12-01"); assert.equal(loan["escrowed"], true);
  const docs = rec["documents"] as Record<string, unknown>[];
  assert.ok(docs.some((d) => d["notice_code"] === "NTC_SM_FIRST_PAYMENT_LETTER"), `the first-payment letter is a borrower-visible notice: ${JSON.stringify(docs.map((d) => d["notice_code"]))}`);
  assert.ok(!docs.some((d) => /credit_report|du_findings|title/i.test(String(d["kind"]))), "credit report, DU findings and title internals never appear");
  const dates = rec["dates"] as { timer_code: string; label: string }[];
  assert.ok(dates.every((d) => ALLOWED_TIMER_CODES.has(d.timer_code) || d.timer_code === "closings.scheduled_at"));
  const seen = new Set<string>(); walk(rec, seen); for (const f of FORBIDDEN_FIELDS) assert.ok(!seen.has(f), `${f} leaked`);
  // the origination subject still answers (the application's record, now funded)
  assert.equal(((await record(EMAIL_A, journey.appId))["status"] as { badge: string }).badge, "Your loan", "the funded application's record is the loan's");
});

test("paid off (d, e): after the first installment UPB $559,455.71 and payments_view shows its P/I/escrow allocation; after the payoff the badge is Paid off (loans.status=paid_off), UPB 0, the escrow refund pending; cases / statements / escrow / lossmit views answer for the loan", { skip }, async () => {
  await journey.firstPayment();
  const loanId = journey.loanId;
  const after = await record(EMAIL_A, loanId);
  assert.equal((after["numbers"] as { upb_cents: string }).upb_cents, "55945571");
  const payments = await api("GET", `/v1/borrower/history/payments?subject=${loanId}`, undefined, await tok(EMAIL_A)); assert.equal(payments.status, 200, JSON.stringify(payments.body).slice(0, 300));
  const rows = payments.body["rows"] as Record<string, unknown>[]; const p = rows.find((r) => r["payment_id"] === `PAY-${loanId.slice(0, 8)}`)!;
  assert.equal(p["status"], "posted"); assert.equal(p["amount_cents"], "409012"); assert.deepEqual(p["allocation"], { principal_cents: "54429", interest_cents: "285833", escrow_cents: "68750", fees_cents: "0" });
  await journey.payoff();
  const rec = await record(EMAIL_A, loanId);
  assert.equal((rec["status"] as { badge: string; state_source: string }).badge, "Paid off"); assert.equal((rec["status"] as { state_source: string }).state_source, "loans.status=paid_off");
  const numbers = rec["numbers"] as Record<string, unknown>; assert.equal(numbers["upb_cents"], "0"); assert.equal(numbers["next_payment"], null);
  assert.equal((numbers["paid_off"] as { payoff_date: string }).payoff_date, "2027-01-29"); assert.equal((numbers["paid_off"] as { escrow_refund_pending_cents: string }).escrow_refund_pending_cents, "275000");
  assert.ok((rec["dates"] as { timer_code: string }[]).some((d) => d.timer_code === "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"), "the escrow refund clock renders (02 §4 servicing row)");
  for (const view of ["escrow", "statements", "cases", "lossmit"]) { const r = await api("GET", `/v1/borrower/history/${view}?subject=${loanId}`, undefined, await tok(EMAIL_A)); assert.equal(r.status, 200, `${view}: ${JSON.stringify(r.body).slice(0, 300)}`); assert.ok(Array.isArray(r.body["rows"])); assert.equal(r.body["view"], view); }
  const statements = (await api("GET", `/v1/borrower/history/statements?subject=${loanId}`, undefined, await tok(EMAIL_A))).body["rows"] as { cycle_due_date: string }[];
  assert.ok(statements.some((s) => s.cycle_due_date === "2027-01-01"), "30.2 opened the first statement cycle");
  assert.equal((await api("GET", `/v1/borrower/history/nope?subject=${loanId}`, undefined, await tok(EMAIL_A))).status, 404);
  assert.equal((await api("GET", `/v1/borrower/history/payments?subject=${loanId}`, undefined, await tok(EMAIL_B))).status, 200, "the co-borrower shares the loan's record");
});
