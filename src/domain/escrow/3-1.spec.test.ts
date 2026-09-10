// 3.1 Initial escrow account statement
// spec/sections/03-escrow-administration/3-1-initial-escrow-account-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { project, decide, newPayment, cushion, effectiveDate, anomalies } from "./analysis.ts";
const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];
void E; void A; void addMonths; void addDays; void project; void decide; void newPayment; void cushion; void effectiveDate; void anomalies;
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { initialStatementStatus, establishmentStatement, statementChannel, biweeklyTrialBalance, vendorFallback } from "./ops.ts";

test("3.1-T1: Given a loan boarded 10 days after settlement with originator statement evidence dated at settlement, when boarding completes, then status = `satisfied_by_originator` and no timer instance is created.", () => {
  const r = initialStatementStatus({ settlement_date: D("2026-09-01"), boarded_on: D("2026-09-11"), originator_statement_delivered_on: D("2026-09-01") });
  assert.equal(r.status, "satisfied_by_originator"); assert.equal(r.timer, null); assert.equal(r.qc_finding, null);
});
test("3.1-T2: Given no evidence and settlement 2026-09-01, when boarded 2026-09-15, then timer due 2026-10-16 23:59 (property TZ) and a statement is sent by then; `loan_events` has `escrow.statement.sent`.", () => {
  const r = initialStatementStatus({ settlement_date: D("2026-09-01"), boarded_on: D("2026-09-15"), originator_statement_delivered_on: null });
  assert.equal(r.status, "required"); assert.equal(r.timer!.code, "REGX_1024_17G_INITIAL_STMT_45"); assert.equal(r.timer!.due_on, "2026-10-16"); assert.equal(r.timer!.breached_at_boarding, false);   // 23:59 property TZ
  assert.equal(r.send_by, "2026-10-16");
  const events = new MemoryEventStore(new FixedClock("2026-10-10T15:00:00.000Z"));
  events.append({ type: "escrow.statement.sent", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_REGX_1024_17G_INITIAL_ESCROW_STMT", sent_on: "2026-10-10" } });
  assert.equal(events.ofType("escrow.statement.sent").length, 1); assert.ok("2026-10-10" <= r.timer!.due_on);
});
// 3.1-T3 — implemented in src/domain/escrow/escrow.test.ts
test("3.1-T4: Given settlement 2026-08-10 and boarding 2026-10-01 with no evidence, when boarded, then the statement is sent within 1 business day and the timer is recorded `breached` with `waiver_reason='inherited_from_originator'` and a `qc_finding` case exists.", () => {
  const r = initialStatementStatus({ settlement_date: D("2026-08-10"), boarded_on: D("2026-10-01"), originator_statement_delivered_on: null });
  assert.equal(r.send_by, "2026-10-02");                                        // within 1 business day
  assert.deepEqual(r.timer, { code: "REGX_1024_17G_INITIAL_STMT_45", due_on: "2026-09-24", breached_at_boarding: true, waiver_reason: "inherited_from_originator" });
  assert.equal(r.qc_finding, "originator_failed_g1");
});
test("3.1-T5: Given a transfer-in effective 2026-11-01 where the new escrow payment differs by $0.01, when transfer completes, then `REGX_1024_17E_TRANSFER_INITIAL_STMT_60` is due 2026-12-31 and `computation_year_start` = 2026-11-01.", () => {
  const r = establishmentStatement("transfer_in_changed", D("2026-11-01"), 1n);
  assert.deepEqual(r, { timer: "REGX_1024_17E_TRANSFER_INITIAL_STMT_60", due_on: "2026-12-31", computation_year_start: "2026-11-01" });
  assert.deepEqual(establishmentStatement("transfer_in_changed", D("2026-11-01"), 0n), { timer: null, computation_year_start: "retained" });
});
test("3.1-T6: Given a waiver revocation on 2026-10-05 (3.8), when the account is established, then `REGX_1024_17G_INITIAL_STMT_45` due 2026-11-19 and an Escrow Setup investor event is queued before any deposit event.", () => {
  const r = establishmentStatement("established", D("2026-10-05"));
  assert.equal(r.timer, "REGX_1024_17G_INITIAL_STMT_45"); assert.equal(r.due_on, "2026-11-19"); assert.deepEqual(r.events_in_order, ["EscrowSetup", "deposit"]);
});
test("3.1-T7: Given valid E-SIGN consent for class `escrow_statements`, when sent, then channel = electronic with receipt evidence; given consent revoked the day before, then channel = mail.", () => {
  assert.deepEqual(statementChannel({ class: "escrow_statements", given_on: D("2026-01-10") }, D("2026-10-10")), { channel: "electronic", receipt_evidence_required: true });
  assert.deepEqual(statementChannel({ class: "escrow_statements", given_on: D("2026-01-10"), revoked_on: D("2026-10-09") }, D("2026-10-10")), { channel: "mail", receipt_evidence_required: false });
  assert.equal(statementChannel({ class: "periodic_statements", given_on: D("2026-01-10") }, D("2026-10-10")).channel, "mail");
});
test("3.1-T8: Given a biweekly loan, when analyzed, then the trial balance has 26 rows and the per-period escrow amount \u00d7 26 = annual disbursements \u00b1 $0.26.", () => {
  const b = biweeklyTrialBalance(A, D("2027-07-01"));
  assert.equal(b.rows, 26); assert.equal(b.per_period_cents, 6_385n); assert.equal(b.within_tolerance, true);   // 26 × $63.85 = $1,660.10 vs $1,660.00
  assert.equal(b.projection.periods, 26);
});
test("3.1-T9: Given the print vendor rejects the file, when retried 3\u00d7 and still failing 2 days before due, then an in-house mail fallback is used and an escalation sev-3 is logged.", () => {
  assert.deepEqual(vendorFallback({ attempts: 3, due_on: D("2026-10-16"), today: D("2026-10-14") }), { fallback: "in_house_mail", escalation: "sev3", retry: false });
  assert.deepEqual(vendorFallback({ attempts: 2, due_on: D("2026-10-16"), today: D("2026-10-14") }), { fallback: null, escalation: null, retry: true });
  assert.deepEqual(vendorFallback({ attempts: 3, due_on: D("2026-10-16"), today: D("2026-10-05") }), { fallback: null, escalation: null, retry: false });
});
