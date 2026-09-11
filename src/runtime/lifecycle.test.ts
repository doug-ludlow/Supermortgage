/**
 * One loan for life, measured against Postgres: a synthetic borrower's application is opened (21.1), funded through the
 * 30.2 hand-off into ONE servicing `loans` row, serviced on that same id (timers, the sweep, a 2.1 payment on the bus,
 * a 16.1/16.2 payoff), and refinanced by a new application that points back at the loan. Every money assertion is a
 * bigint of cents or the spec's own "$1,234.56" figure. Skips without a database (REQUIRE_DB=1 makes that a failure).
 *
 * Phases share one application / loan and run in file order. Each phase's clock is set explicitly (FixedClock.set).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect, reachable, type Db } from "../infra/db/client.ts";
import { loadOverriddenRegistry } from "../domain/timer-overrides.ts";
import { FixedClock, type DomainEvent } from "../kernel/events/index.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";
import { allocate } from "../domain/cashiering/allocation.ts";
import { cashStateAtBoarding } from "../domain/orig-boarding/ops-30-2.ts";
import { Runtime } from "./app.ts";
import { createApiServer, listen } from "./server.ts";
import { createLogger } from "./log.ts";

const DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgresql://sm:sm@localhost/supermortgage_test";
const up = await reachable(DB_URL);
if (!up && process.env["REQUIRE_DB"]) throw new Error(`REQUIRE_DB set but ${DB_URL} is not reachable`);
const skip = up ? false : `no Postgres at ${DB_URL}`;
const TOKEN = "t-" + randomUUID();

let db: Db; let runtime: Runtime; let base = ""; let close: () => Promise<void> = async () => undefined;
let partnerPartyId = "";
const custodial = { clearing: "", pi: "", ti: "" };
const clock = new FixedClock("2026-10-05T17:41:00.000Z");   // Mon Oct 5, 2026 10:41 MST — the 21.1 fixture interview

// the state the phases hand each other: one application, one loan for life
let appId = ""; let loanId = ""; let statementLeadTimerId = "";
let payoff = { quote_id: "", total_cents: 0n, interest_cents: 0n };
// entity ids are platform-wide (entity_records pkey = kind, id, version): key this run's rows by the loan
const PAY_ID = () => `PAY-${loanId.slice(0, 8)}`; const QUOTE_ID = () => `pq-${loanId.slice(0, 8)}`; const REQUEST_ID = () => `pr-${loanId.slice(0, 8)}`;

test.before(async () => {
  if (skip) return;
  execFileSync(fileURLToPath(new URL("../../db/migrate.sh", import.meta.url)), { env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  db = connect(DB_URL);
  runtime = new Runtime({ db, registry: loadOverriddenRegistry(), clock });
  const server = createApiServer({ runtime, apiToken: TOKEN, logger: createLogger("json", () => undefined) });
  base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
  close = () => new Promise((resolve) => server.close(() => db.end().then(() => resolve())));
  const partner = await db.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, servicer_number, mers_org_id) VALUES ('servicer', $1, $2, '1000123') RETURNING id`, [`Partner Bank ${randomUUID().slice(0, 8)}`, "123456789"]);
  partnerPartyId = partner[0]!.id;
  // the servicing custodial accounts cashiering and payoff post to (1.1 seeds them for a transfer; an origination partner gets them at onboarding)
  for (const kind of ["clearing", "pi", "ti"] as const) {
    const c = await db.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, $2, 'A/A') RETURNING id`, [partnerPartyId, kind]);
    custodial[kind] = c[0]!.id;
  }
});
test.after(async () => { if (!skip) await close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const INTAKE = { kind: "agent", id: "intake" } as const;
const FUNDING = { kind: "agent", id: "funding" } as const;
const CASHIERING = { kind: "agent", id: "cashiering" } as const;
const PAYOFF = { kind: "agent", id: "payoff-release" } as const;
const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ c: string }>(sql, params))[0]!.c);
/** Balance of one loan account from the persisted lines (debit +, credit −). */
const loanBalance = async (account: string): Promise<bigint> => BigInt((await db.query<{ s: string }>(`SELECT coalesce(sum(amount_cents), 0)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 AND account = $2`, [loanId, account]))[0]!.s);
const loanAcct = (account: string) => ({ scope: "loan" as const, loanId, account: account as "principal" });
const cust = (id: string, account: string) => ({ scope: "custodial" as const, custodialAccountId: id, account: account as "clearing_cash" });

test("a. the application opens over HTTP (refi_trigger, limited cash-out, primary; borrowers A and B; the Phoenix property) and `application.started` is keyed by the application only", { skip }, async () => {
  const r = await call("POST", "/v1/applications", { actor: INTAKE, application: {
    partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", intake_channel: "voice", interview_language: "en-US",
    borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower", citizenship_status: "us_citizen", language_preference: "en" }, { legal_name: "Blake Borrower", borrower_role: "co_borrower" }],
    property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const app = r.body["application"] as Record<string, unknown>;
  appId = app["id"] as string;
  assert.equal(app["status"], "started"); assert.equal(app["loan_id"], null); assert.equal(app["prior_loan_id"], null);
  const ev = r.body["event"] as Record<string, unknown>;
  assert.equal(ev["type"], "application.started"); assert.equal(ev["applicationId"], appId); assert.equal(ev["loanId"], undefined);
  const rows = await db.query<{ loan_id: string | null }>(`SELECT loan_id FROM loan_events WHERE application_id = $1`, [appId]);
  assert.ok(rows.length >= 1); assert.ok(rows.every((x) => x.loan_id === null), "no loan exists before funding");
});

test("b. POST /v1/applications/{id}/fund at 2026-11-12T18:40Z boards the loan: both ids linked and on every hand-off event, OB-001…OB-022 pass, the opening set balances (principal 56,000,000 / escrow 206,250 / prepaid interest 178,543), SM_ORIG_BOARD_T1BD satisfied, a second call is a no-op", { skip }, async () => {
  clock.set("2026-11-12T18:40:00.000Z");   // 11:40 MST Thu Nov 12, 2026 — 26.3's loan.funded
  // 30.2-T2 at the seam: a CD P&I of $3,402.63 against the note's $3,402.62 fails OB-003 (money field) → boarding refused (409), nothing persisted
  const refused = await call("POST", `/v1/applications/${appId}/fund`, { actor: FUNDING, snapshot: { final_cd: { document_id: "DOC-CD", pi_cents: "340263", monthly_escrow_cents: "68750", initial_escrow_deposit_cents: "206250", prepaid_interest_cents: "178543", prepaid_interest_days: 19, compliance_tests_passed: true } } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body).slice(0, 500));
  assert.equal(refused.body["error"], "refused"); assert.equal(refused.body["code"], "BOARDING_HARD_FAILURE"); assert.match(String(refused.body["reason"]), /OB-003/);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 0);
  assert.equal((await db.query<{ loan_id: string | null }>(`SELECT loan_id FROM applications WHERE id = $1`, [appId]))[0]!.loan_id, null);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'loan.funded'`, [appId]), 0);
  assert.equal((await call("POST", `/v1/applications/${randomUUID()}/fund`, { actor: FUNDING })).status, 404);
  const r = await call("POST", `/v1/applications/${appId}/fund`, { actor: FUNDING });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 2000));
  loanId = r.body["loan_id"] as string;
  assert.equal(r.body["duplicate"], false); assert.equal(r.body["status"], "boarded_with_warnings");   // the worked example's open OW-* rows (OW-002 borrower B, OW-006, OW-008, OW-009)
  assert.match(String(r.body["servicing_loan_number"]), /^\d{10}$/);
  // the seam: loans.origination_application_id ↔ applications.loan_id; no Fannie Mae number until purchase (30.1)
  const loan = (await db.query<{ origination_application_id: string | null; fnma_loan_number: string | null; status: string; servicer_loan_number: string; boarded_at: string | null; partner_party_id: string }>(`SELECT origination_application_id, fnma_loan_number, status, servicer_loan_number, boarded_at, partner_party_id FROM loans WHERE id = $1`, [loanId]))[0]!;
  assert.equal(loan.origination_application_id, appId); assert.equal(loan.fnma_loan_number, null); assert.equal(loan.status, "active"); assert.equal(loan.servicer_loan_number, r.body["servicing_loan_number"]); assert.ok(loan.boarded_at); assert.equal(loan.partner_party_id, partnerPartyId);
  const app = (await db.query<{ loan_id: string | null; status: string }>(`SELECT loan_id, status FROM applications WHERE id = $1`, [appId]))[0]!;
  assert.equal(app.loan_id, loanId); assert.equal(app.status, "funded");
  // borrowers and the property are linked from the application rows, not copied loose
  assert.equal(await n(`SELECT count(*)::text AS c FROM application_borrowers ab JOIN loan_borrowers lb ON lb.borrower_id = ab.borrower_id AND lb.loan_id = $2 WHERE ab.application_id = $1`, [appId, loanId]), 2);
  assert.equal(await n(`SELECT count(*)::text AS c FROM application_properties ap JOIN loans l ON l.property_id = ap.property_id WHERE ap.application_id = $1 AND l.id = $2`, [appId, loanId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_terms WHERE loan_id = $1 AND source = 'boarding' AND pi_cents = 340262 AND escrow_payment_cents = 68750 AND note_rate_bps = 61250`, [loanId]), 1);
  // every 30.2 event after the funding event carries BOTH ids
  const log = await db.query<{ type: string; loan_id: string | null; application_id: string | null }>(`SELECT type, loan_id, application_id FROM loan_events WHERE application_id = $1 ORDER BY sequence`, [appId]);
  const fundedAt = log.findIndex((e) => e.type === "loan.funded");
  assert.ok(fundedAt > 0, "loan.funded is on the application's log");
  // (the kernel's own `timer.*` rows for instances armed by `loan.funded` itself — SM_ORIG_BOARD_T1BD, 25.4's letter clocks, … — stay keyed to the application subject
  //  the trigger had, before the loan row existed; every domain row and every timer row armed by a hand-off event carries both)
  for (const e of log.slice(fundedAt + 1)) {
    assert.equal(e.application_id, appId, `${e.type} carries the application id`);
    if (e.type.startsWith("timer.")) continue;
    assert.equal(e.loan_id, loanId, `${e.type} carries the loan id`);
  }
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'timer.armed' AND payload->>'code' = 'SM_ORIG_FIRST_STATEMENT_LEAD_15' AND loan_id = $2`, [appId, loanId]), 1);
  for (const t of ["loan.staged", "loan.validated", "loan.boarded", "ledger.opening_posted", "consents.boarded", "documents.indexed", "timers.seeded", "statement.cycle.opened"]) assert.ok(log.some((e) => e.type === t), `${t} emitted`);
  assert.equal(log.filter((e) => e.type === "notice.sent").length >= 2, true, "a first-payment letter per borrower");
  // OB-001…OB-022 all pass; persisted keyed by the application
  const ob = (r.body["validations"] as { code: string; result: string; severity: string }[]).filter((v) => v.code.startsWith("OB-"));
  assert.equal(ob.length, 22); assert.deepEqual(ob.filter((v) => v.result !== "pass").map((v) => v.code), []);
  assert.equal(await n(`SELECT count(*)::text AS c FROM boarding_validations WHERE application_id = $1 AND rule_code LIKE 'OB-%' AND result = 'pass'`, [appId]), 22);
  // 30.2-T3 figures on the persisted ledger: one balanced opening set
  const ledger = await call("GET", `/v1/loans/${loanId}/ledger`);
  const sets = ledger.body["entry_sets"] as { id: string; lines: { account: string; amount_cents?: string; amountCents?: string }[] }[];
  assert.equal(sets.length, 1); assert.equal(sets[0]!.id, r.body["opening_entry_set_id"]);
  assert.equal(await loanBalance("principal"), 56_000_000n);
  assert.equal(-(await loanBalance("escrow")), 206_250n);            // $2,062.50 = 30.3 required start $687.50 + cushion $1,375.00
  assert.equal(-(await loanBalance("prepaid_interest")), 178_543n);  // $1,785.43 = 19 × $93.97
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id = $1 GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [sets[0]!.id]), 0);
  // SM_ORIG_BOARD_T1BD: armed by loan.funded (application subject), satisfied by loan.boarded the same day (due Fri Nov 13)
  const t1bd = await db.query<{ status: string; due_date: string; anchor_date: string }>(`SELECT status, due_date::text, anchor_date::text FROM timers WHERE code = 'SM_ORIG_BOARD_T1BD' AND application_id = $1`, [appId]);
  assert.equal(t1bd.length, 1); assert.equal(t1bd[0]!.status, "satisfied"); assert.equal(t1bd[0]!.anchor_date, "2026-11-12"); assert.equal(t1bd[0]!.due_date, "2026-11-13");
  // 30.2-T13: the same funding delivered twice — the second is ignored with a receipt; one loans row, one ledger set, no second letter
  const lettersBefore = await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'notice.sent'`, [loanId]);
  const again = await call("POST", `/v1/applications/${appId}/fund`, { actor: FUNDING });
  assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 500));
  assert.equal(again.body["duplicate"], true); assert.equal(again.body["loan_id"], loanId); assert.equal(again.body["servicing_loan_number"], r.body["servicing_loan_number"]);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 1);
  assert.equal(await n(`SELECT count(DISTINCT set_id)::text AS c FROM ledger_lines WHERE loan_id = $1`, [loanId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'notice.sent'`, [loanId]), lettersBefore);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'loan.funded.duplicate_ignored' AND loan_id = $2`, [appId, loanId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE application_id = $1 AND type = 'loan.funded'`, [appId]), 1);
  // the application's record over HTTP now shows the loan it became
  const rec = await call("GET", `/v1/applications/${appId}`);
  assert.equal((rec.body["application"] as { loan_id: string }).loan_id, loanId);
});

test("c. servicing takes over on the same loan id: the origination hand-off timers (30.4's SM_TAX_SERVICE_ACTIVATE_2BD, 30.2's SM_ORIG_FIRST_STATEMENT_LEAD_15 due 2026-12-17) list under the loan, and the sweep on 2026-12-18 breaches the statement lead with an escalation on the loan", { skip }, async () => {
  const timers = (await call("GET", `/v1/loans/${loanId}/timers`)).body["timers"] as { id: string; code: string; status: string; dueDate?: string; loanId?: string; applicationId?: string }[];
  const codes = new Set(timers.map((t) => t.code));
  for (const c of ["SM_TAX_SERVICE_ACTIVATE_2BD", "SM_FLOOD_LOL_SERVICING_LINK_2BD", "SM_ORIG_FIRST_STATEMENT_LEAD_15", "SM_ORIG_ACTIVE_BEFORE_FIRST_DUE_GATE", "SM_ORIG_WARNING_CLEAR_10BD"]) assert.ok(codes.has(c), `${c} armed on the loan (have ${[...codes].join(", ")})`);
  const lead = timers.find((t) => t.code === "SM_ORIG_FIRST_STATEMENT_LEAD_15")!;
  assert.equal(lead.status, "armed"); assert.equal(lead.dueDate, "2026-12-17"); assert.equal(lead.loanId, loanId); assert.equal(lead.applicationId, appId);
  statementLeadTimerId = lead.id;
  // 30.2 opens 7.1's first statement cycle (`statement.cycle.opened{first_cycle=true}`) but does not send the statement — 7.1's `statement.sent` is what satisfies the lead; on Dec 18 it has not happened, so the clock breaches
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'statement.sent'`, [loanId]), 0);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'statement.cycle.opened' AND payload->>'first_cycle' = 'true' AND payload->>'cycle_due_date' = '2027-01-01' AND payload->>'amount_due_cents' = '409012'`, [loanId]), 1);
  clock.set("2026-12-18T15:00:00.000Z");
  const sweep = await call("POST", "/v1/sweep");
  assert.equal(sweep.status, 200);
  const breaches = sweep.body["breaches"] as { loan_id: string | null; code: string; timer_id: string; escalate_to: string[] }[];
  const mine = breaches.filter((b) => b.loan_id === loanId);
  assert.ok(mine.some((b) => b.code === "SM_ORIG_FIRST_STATEMENT_LEAD_15" && b.timer_id === statementLeadTimerId), JSON.stringify(mine));
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM timers WHERE id = $1`, [statementLeadTimerId]))[0]!.status, "breached");
  // the sweep's escalations reference the loan (one per breach, to the registry's escalation role)
  for (const b of mine) assert.equal(await n(`SELECT count(*)::text AS c FROM escalations WHERE loan_id = $1 AND sla_timer_id = $2`, [loanId, b.timer_id]), 1, `escalation for ${b.code}`);
  assert.ok(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'timer.breached' AND payload->>'code' = 'SM_ORIG_FIRST_STATEMENT_LEAD_15'`, [loanId]) === 1);
});

test("d. the Jan 1, 2027 installment ($3,402.62 P&I + $687.50 escrow = $4,090.12) received Wed Dec 30 posts through the 2.1 bus (payments.read/write, then ledger.post via payment.post from the allocation engine's plan): principal after payment 55,945,571 cents ($559,455.71)", { skip }, async () => {
  clock.set("2026-12-30T17:00:00.000Z");
  // 2.1: the receipt is written first (received_on is the immutable fact), the allocation engine produces the plan from the boarded cash state
  const written = await runtime.execute({ process: "2.1", name: "payments.read/write", loanId, actor: CASHIERING, input: { op: "write", id: PAY_ID(), loan_id: loanId,
    data: { payment_id: PAY_ID(), loan_id: loanId, amount_cents: 409_012n, received_on: "2026-12-30", credited_as_of: "2026-12-30", channel: "lockbox", designation: "contractual", status: "posted", identification_confidence: 0.99, conforming: true } } });
  assert.ok(written.events.some((e) => e.type === "payment.written" && e.loanId === loanId));
  const state = cashStateAtBoarding({ loan_id: loanId, note_date: D("2026-11-06"), note_rate_pct: "6.125", amount_cents: 56_000_000n, pi_cents: 340_262n, escrow_payment_cents: 68_750n, first_payment_date: D("2027-01-01"), late_charge_pct: "5.00", late_charge_grace_days: 15, escrowed: true });
  const plan = allocate(state, { payment_id: PAY_ID(), amount_cents: 409_012n, received_on: D("2026-12-30"), credited_as_of: D("2026-12-30"), designation: "contractual" });
  assert.ok(plan.outcome === "applied" || plan.outcome === "prepaid", plan.outcome);
  const inst = plan.installments[0]!;
  // F-1-09 30/360 split for the first installment: interest $2,858.33 (560,000 × 6.125% ÷ 12), principal $544.29, escrow $687.50; UPB after payment 1 $559,455.71 (30.2 worked figures)
  assert.equal(inst.due_date, "2027-01-01"); assert.equal(inst.interest_cents, 285_833n); assert.equal(inst.principal_cents, 54_429n); assert.equal(inst.escrow_cents, 68_750n); assert.equal(inst.upb_after_cents, 55_945_571n); assert.equal(plan.to_suspense_cents, 0n);
  const post = (description: string, lines: { account: ReturnType<typeof loanAcct> | ReturnType<typeof cust>; amountCents: bigint; ruleRef: string }[]) =>
    runtime.execute({ process: "2.1", name: "ledger.post", loanId, actor: CASHIERING, input: { loan_id: loanId, via: "payment.post", entry_set: { effectiveDate: "2026-12-30", description, lines } } });
  // 2.1 rule 8 sets, as CashieringService.postEntries posts them: receipt, allocation, cash split
  const r1 = await post(`receipt ${PAY_ID()}`, [{ account: cust(custodial.clearing, "clearing_cash"), amountCents: 409_012n, ruleRef: "2.1:r8:receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -409_012n, ruleRef: "2.1:r8:receipt" }]);
  assert.equal(r1.events.some((e) => e.type === "command.executed"), true);
  await post(`allocation ${PAY_ID()}`, [{ account: loanAcct("suspense_unapplied"), amountCents: 409_012n, ruleRef: "2.1:r8:allocation" }, { account: loanAcct("interest_due"), amountCents: -inst.interest_cents, ruleRef: "2.1:r8:allocation:interest" },
    { account: loanAcct("principal"), amountCents: -inst.principal_cents, ruleRef: "2.1:r8:allocation:principal" }, { account: loanAcct("escrow"), amountCents: -inst.escrow_cents, ruleRef: "2.1:r8:allocation:escrow" }]);
  await post(`cash split ${PAY_ID()}`, [{ account: cust(custodial.pi, "custodial_pi_cash"), amountCents: inst.interest_cents + inst.principal_cents, ruleRef: "2.1:r8:cash_split:pi" }, { account: cust(custodial.ti, "custodial_ti_cash"), amountCents: inst.escrow_cents, ruleRef: "2.1:r8:cash_split:escrow" }, { account: cust(custodial.clearing, "clearing_cash"), amountCents: -409_012n, ruleRef: "2.1:r8:cash_split" }]);
  assert.equal(await loanBalance("principal"), 55_945_571n);                 // $559,455.71
  assert.equal(await loanBalance("suspense_unapplied"), 0n);
  assert.equal(-(await loanBalance("escrow")), 206_250n + 68_750n);          // $2,750.00 escrow balance after the first deposit
  assert.equal(-(await loanBalance("interest_due")), 285_833n);              // interest collected (no accrual was posted at boarding — 30.2 opens principal/escrow/prepaid interest only)
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1) GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [loanId]), 0);
  const sets = (await call("GET", `/v1/loans/${loanId}/ledger`)).body["entry_sets"] as unknown[];
  assert.equal(sets.length, 3);   // the loan's record lists the sets with a loan-scoped line: opening + receipt + allocation (the cash split moves custodial/corporate cash only)
  assert.equal(await n(`SELECT count(DISTINCT s.id)::text AS c FROM ledger_entry_sets s WHERE s.description LIKE '%' || $1`, [PAY_ID()]), 3);
});

test("e. payoff on the same loan through 16.1/16.2: computePayoffQuote, matchPayoffFunds (record + clear), postPayoff → `loan.paid_in_full` on the loan, every loan account at zero but escrow (refund pending)", { skip }, async () => {
  clock.set("2027-01-20T16:00:00.000Z");   // Wed Jan 20, 2027: the written payoff request
  const quote = await runtime.execute({ process: "16.1", name: "computePayoffQuote", loanId, actor: PAYOFF, input: { loan_id: loanId, quote_id: QUOTE_ID(), request_id: REQUEST_ID(), channel: "email", received_on: "2027-01-20", requester_type: "borrower",
    upb_cents: 55_945_571n, rate_pct: "6.125", lpi_due: "2027-01-01", good_through: "2027-01-29", state: "AZ", ledger_snapshot_id: "ledger-life-1" } });
  const q = quote.output as { total_cents: bigint; interest_cents: bigint; per_diem_cents: bigint; hash: string; request_id: string };
  assert.equal(q.request_id, REQUEST_ID()); assert.ok(quote.events.some((e) => e.type === "payoff.quote.computed" && e.loanId === loanId));
  // the calculator's figure: UPB $559,455.71 plus interest at 6.125% from the Jan 1 LPI through Jan 29 (16.1's accrual; the fixture states no fees); the engine's per diem on this UPB is $93.88
  assert.equal(q.per_diem_cents, 9_388n);
  assert.equal(q.total_cents, 55_945_571n + q.interest_cents);
  assert.ok(q.interest_cents > 0n && q.interest_cents <= 9_388n * 31n, `interest ${q.interest_cents}`);
  payoff = { quote_id: QUOTE_ID(), total_cents: q.total_cents, interest_cents: q.interest_cents };

  clock.set("2027-01-29T16:00:00.000Z");   // Fri Jan 29, 2027 11:00 ET: the wire arrives on the good-through date
  // 2.1 receipt of the wire (Dr clearing / Cr suspense) — the 16.2 application set draws on suspense_unapplied
  await runtime.execute({ process: "2.1", name: "ledger.post", loanId, actor: CASHIERING, input: { loan_id: loanId, via: "payment.post", entry_set: { effectiveDate: "2027-01-29", description: "receipt payoff wire", lines: [
    { account: cust(custodial.clearing, "clearing_cash"), amountCents: payoff.total_cents, ruleRef: "2.1:r8:receipt" }, { account: loanAcct("suspense_unapplied"), amountCents: -payoff.total_cents, ruleRef: "2.1:r8:receipt" }] } } });
  const matched = await runtime.execute({ process: "16.2", name: "matchPayoffFunds", loanId, actor: PAYOFF, input: { loan_id: loanId, amount_cents: payoff.total_cents, method: "wire", received_at: "2027-01-29T16:00:00.000Z", bank_reference: payoff.quote_id, remittance_type: "AA" } });
  const m = matched.output as { funds_id: string; status: string; matched: { quote_id: string } | null; payoff_date: string };
  assert.equal(m.status, "cleared"); assert.equal(m.matched?.quote_id, payoff.quote_id); assert.equal(m.payoff_date, "2027-01-29");
  assert.ok(matched.events.some((e) => e.type === "payoff.funds.received" && e.loanId === loanId)); assert.ok(matched.events.some((e) => e.type === "payoff.funds.cleared" && e.loanId === loanId));
  // the escrow balance rides on the buckets as a refund pending (16.2 rule 2: escrow is refunded separately, never netted)
  const escrowBalance = -(await loanBalance("escrow"));
  const posted = await runtime.execute({ process: "16.2", name: "postPayoff", loanId, actor: PAYOFF, input: { loan_id: loanId, funds_id: m.funds_id, amount_cents: payoff.total_cents, payoff_date: "2027-01-29", remittance_type: "AA", escrowed: true,
    buckets: { accrued_interest: payoff.interest_cents, principal: 55_945_571n, escrow_balance: escrowBalance }, custodial_pi_id: custodial.pi, custodial_ti_id: custodial.ti, custodial_clearing_id: custodial.clearing } });
  const p = posted.output as { settlement_id: string; zero: boolean; applied_cents: bigint; ledger_set_ids: string[] };
  assert.equal(p.zero, true); assert.equal(p.applied_cents, payoff.total_cents);
  const pif = posted.events.find((e) => e.type === "loan.paid_in_full") as DomainEvent | undefined;
  assert.ok(pif, "loan.paid_in_full emitted"); assert.equal(pif.loanId, loanId); assert.equal(pif.payload["payoff_date"], "2027-01-29"); assert.equal(pif.payload["settlement_id"], p.settlement_id);
  assert.ok(posted.events.some((e) => e.type === "payoff.applied" && e.loanId === loanId));
  assert.equal(await n(`SELECT count(*)::text AS c FROM loan_events WHERE loan_id = $1 AND type = 'loan.paid_in_full'`, [loanId]), 1);
  // 16.2 rule 3: every loan account posts to zero; the escrow balance stays as the refund pending (3.x's escrow refund clock); the sets balance
  assert.equal(await loanBalance("principal"), 0n); assert.equal(await loanBalance("suspense_unapplied"), 0n);
  assert.equal(-(await loanBalance("escrow")), escrowBalance);
  assert.equal(await n(`SELECT count(*)::text AS c FROM (SELECT set_id FROM ledger_lines WHERE set_id IN (SELECT set_id FROM ledger_lines WHERE loan_id = $1) GROUP BY set_id HAVING sum(amount_cents) <> 0) x`, [loanId]), 0);
  // what 16.2 actually sets: `payoff_settlements.status = paid_in_full` (rule 3) and `loan.paid_in_full` on the log. Nothing in 16.2 (or the runtime) projects that event onto `loans.status`
  // (`paid_off` in the loan_status enum) — the row still reads `active`; the status flip belongs to the consumer of `loan.paid_in_full` (16.3's release task / 5.x investor reporting), not to the payoff posting.
  const settlement = await runtime.entities.current("payoff_settlements", p.settlement_id);
  assert.equal(settlement?.data["status"], "paid_in_full"); assert.equal(settlement?.data["loan_id"], loanId);
  assert.equal((await db.query<{ status: string }>(`SELECT status FROM loans WHERE id = $1`, [loanId]))[0]!.status, "active");
});

test("f. the refinance loop: a new application with prior_loan_id = the loan references it, shows it over HTTP, has no loan of its own — and exactly ONE loans row ever carries the original application id", { skip }, async () => {
  clock.set("2027-01-30T17:00:00.000Z");
  const r = await call("POST", "/v1/applications", { actor: INTAKE, application: {
    partner_party_id: partnerPartyId, channel: "refi_trigger", transaction_type: "limited_cash_out", occupancy: "primary", prior_loan_id: loanId,
    borrowers: [{ legal_name: "Alex Borrower", borrower_role: "borrower" }, { legal_name: "Blake Borrower", borrower_role: "co_borrower" }],
    property: { address_line1: "100 N Central Ave", city: "Phoenix", state: "AZ", postal_code: "85004", county: "Maricopa", property_type: "sfr", units: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const app2 = r.body["application"] as { id: string; prior_loan_id: string | null; loan_id: string | null };
  assert.equal(app2.prior_loan_id, loanId); assert.equal(app2.loan_id, null); assert.notEqual(app2.id, appId);
  assert.equal((r.body["event"] as { payload: { prior_loan_id: string } }).payload.prior_loan_id, loanId);
  const rec = await call("GET", `/v1/applications/${app2.id}`);
  assert.equal(rec.status, 200);
  assert.equal((rec.body["application"] as { prior_loan_id: string }).prior_loan_id, loanId); assert.equal((rec.body["application"] as { loan_id: string | null }).loan_id, null);
  assert.equal((await db.query<{ prior_loan_id: string }>(`SELECT prior_loan_id FROM applications WHERE id = $1`, [app2.id]))[0]!.prior_loan_id, loanId);
  // one loan for life: the original application boarded exactly one servicing row, and nothing re-boards it (purchase, payoff, refinance all key the same id)
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [appId]), 1);
  assert.equal(await n(`SELECT count(*)::text AS c FROM loans WHERE origination_application_id = $1`, [app2.id]), 0);
  assert.equal(await n(`SELECT count(DISTINCT loan_id)::text AS c FROM loan_events WHERE application_id = $1 AND loan_id IS NOT NULL`, [appId]), 1);
});
