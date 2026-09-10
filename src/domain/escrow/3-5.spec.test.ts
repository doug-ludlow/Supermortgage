// 3.5 Surplus refund
// spec/sections/03-escrow-administration/3-5-surplus-refund.md
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
import { refundDecision, payoffRefundDue, needsDualApproval } from "./refund.ts";
import { scheduleRefund, issueRefund, approveRefund, ledgerBalanced, returnedRefund, staleRefund, creditToNewLoan, retainedSurplus, EscrowEventLedger } from "./ops.ts";
const OFFICER_A = { kind: "human" as const, id: "u-officer-a", role: "officer" }; const OFFICER_B = { kind: "human" as const, id: "u-officer-b", role: "officer" };

test("3.5-T1: Given surplus $143.32, current borrower, as_of 2027-05-16, then timer due 2027-06-15 and a check is issued with ledger entries balanced.", () => {
  const d = refundDecision(14_332n, 0, D("2027-05-16")); assert.deepEqual(d, { action: "refund", due_on: "2027-06-15" });
  const r = issueRefund(scheduleRefund("L-1", 14_332n, d.due_on!), D("2027-05-22"), "100234");
  assert.equal(r.status, "issued"); assert.deepEqual(r.ledger, [{ dr: "loan.escrow", cr: "custodial_ti_cash", amount_cents: 14_332n }]); assert.equal(ledgerBalanced(r), true);
});
test("3.5-T2: Given surplus exactly $50.00, then refund is mandatory; given $49.99, then credit path.", () => {
  assert.equal(refundDecision(5_000n, 0, D("2027-05-16")).action, "refund"); assert.equal(refundDecision(4_999n, 0, D("2027-05-16")).action, "credit");
});
test("3.5-T3: Given `regx_days_delinquent=31` at analysis, then status `retained`, no timer; on reinstatement an interim analysis re-decides.", () => {
  assert.deepEqual(retainedSurplus(30_000n, 31, null), { status: "retained", timer: null, interim_analysis_on: null });
  assert.deepEqual(retainedSurplus(30_000n, 47, D("2027-08-03")), { status: "decided", timer: { due_on: "2027-09-03" }, interim_analysis_on: "2027-08-04" });
});
test("3.5-T4: Given payoff posted Thu 2027-02-11, then due date = 2027-03-12 (Presidents' Day excluded).", () => {
  assert.equal(payoffRefundDue(D("2027-02-11")), "2027-03-12");
});
test("3.5-T5: Given payoff posted Fri 2027-12-24 (Christmas observed 12/24? \u2014 federal holiday 12/25 falls on Saturday, observed Fri 12/24), then day count starts Mon 12/27 and excludes 2028-01-17 (MLK); due date computed by the calendar service equals the hand-count.", () => {
  assert.equal(payoffRefundDue(D("2027-12-24")), "2028-01-25");                     // count starts Mon 12/27, excludes MLK 2028-01-17
});
test("3.5-T6: Given borrower oral consent (recorded call) to credit $612.40 to a new same-servicer loan settling 2027-03-01, then no check is issued and the inter-loan ledger transfer posts on settlement.", () => {
  const r = scheduleRefund("L-1", cents("612.40"), D("2027-03-12"));
  const c = creditToNewLoan(r, { recorded_call_id: "call-77", given_on: D("2027-02-15") }, { id: "L-2", settles_on: D("2027-03-01") });
  assert.deepEqual(c, { check_issued: false, posts_on: "2027-03-01", ledger: { dr: "L-1.escrow", cr: "L-2.escrow", amount_cents: 61_240n } }); assert.equal(r.status, "credited_to_new_loan");
  assert.throws(() => creditToNewLoan(scheduleRefund("L-1", 1n, D("2027-03-12")), { recorded_call_id: "c", given_on: D("2027-03-05") }, { id: "L-3", settles_on: D("2027-03-01") }), /on\/after the consent date/);
});
test("3.5-T7: Given a check returned undeliverable on day 25, then address verification and reissue occur before day 30 or the breach is logged with evidence of attempts.", () => {
  const ok = issueRefund(scheduleRefund("L-1", 14_332n, D("2027-06-15")), D("2027-05-22"), "1");
  const a = returnedRefund(ok, D("2027-06-10"), D("2027-06-12"), D("2027-06-14"));       // day 25 → verified → reissued before day 30
  assert.equal(a.status, "reissued"); assert.equal(a.breach_logged, false); assert.deepEqual(a.evidence.map((e) => e.kind), ["check", "returned", "address_verified", "reissued"]);
  const late = returnedRefund(issueRefund(scheduleRefund("L-1", 14_332n, D("2027-06-15")), D("2027-05-22"), "2"), D("2027-06-10"), D("2027-06-12"), null);
  assert.equal(late.breach_logged, true); assert.equal(late.evidence.length, 3);
});
test("3.5-T8: Given a check uncashed at 180 days, then outreach notice is sent and the state escheat timer starts.", () => {
  const r = issueRefund(scheduleRefund("L-1", 14_332n, D("2027-06-15")), D("2027-05-22"), "3");
  assert.equal(staleRefund(r, D("2027-11-17"), 3).outreach_notice, false);
  const s = staleRefund(r, D("2027-11-18"), 3);
  assert.deepEqual(s, { status: "outreach", outreach_notice: true, escheat_starts_on: "2027-11-18", escheat_due_on: "2030-11-18" });
});
test("3.5-T9: Given refund $30,000 (large overfunded account), then `officer` dual approval is required before issuance and the 30-day timer still governs.", () => {
  assert.equal(needsDualApproval(cents("30000")), true);
  const r = scheduleRefund("L-1", cents("30000"), D("2027-06-15"));
  assert.throws(() => issueRefund(r, D("2027-05-22"), "9"), /dual approval/);
  approveRefund(r, OFFICER_A); assert.throws(() => approveRefund(r, OFFICER_A), /same officer/); approveRefund(r, OFFICER_B);
  assert.equal(issueRefund(r, D("2027-05-22"), "9").status, "issued"); assert.equal(r.due_on, "2027-06-15");
});
test("3.5-T10: Given a Fannie Mae escrow disbursement event rejected for balance mismatch, then the event is corrected and resubmitted before 3:00 a.m. ET next BD (3.7).", () => {
  const led = new EscrowEventLedger(110_668n);
  const e = led.emit("Loan Taxes and Insurance refund", -14_332n, D("2027-05-22")); e.status = "rejected";
  const fixed = led.correct(e.sequence, { balance_cents: 96_336n }, D("2027-05-24"));
  assert.equal(e.status, "corrected"); assert.equal(fixed.sequence, e.sequence); assert.equal(fixed.corrects, e.sequence); assert.equal(fixed.status, "queued");
  assert.equal(fixed.deadline_at, "2027-05-25");                                   // before 03:00 ET next Fannie Mae BD (3.7)
});
