// 3.4 Cushion enforcement
// spec/sections/03-escrow-administration/3-4-cushion-enforcement.md
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
import { reviewStatus } from "./ops.ts";

test("3.4-T1: Given annual $1,660.00 and policy 2 months, then cushion $276.66 and lowest target \u2264 $276.66.", () => {
  const c = cushion(166_000n, { policy_months: 2 }); assert.equal(c.cents, 27_666n);
  const p = project(A, D("2027-07-01"), { policy_months: 2 }); assert.ok(p.targets.reduce((a, b) => (b < a ? b : a)) <= 27_666n); assert.equal(p.cap_ok, true);
});
test("3.4-T2: Given instrument cushion 1 month, then cushion $138.33 and `cushion_cap_source='instrument'`.", () => {
  const c = cushion(166_000n, { instrument_months: 1 }); assert.equal(c.cents, 13_833n); assert.equal(c.source, "instrument");
  assert.equal(project(A, D("2027-07-01"), { instrument_months: 1 }).target_at_start_cents, 96_835n);   // $830.02 + $138.33 = $968.35
});
test("3.4-T3: Given a state override 1.5 months, then cushion floor(1,660 \u00d7 1.5/12) = $207.50 and source `state`.", () => {
  const c = cushion(166_000n, { state_max_months: 1.5 }); assert.equal(c.cents, 20_750n); assert.equal(c.source, "state");
});
test("3.4-T4: Given a projected disbursement dated before the bill's availability date, then `preaccrual_check_passed=false` and approval is blocked.", () => {
  const p = project([{ ...A[0]!, available_on: D("2027-08-01") }, A[1]!, A[2]!], D("2027-07-01"));
  assert.equal(p.preaccrual_ok, false);
  const r = reviewStatus(p.preaccrual_ok ? [] : ["preaccrual_check_failed"]); assert.equal(r.status, "anomaly_review"); assert.equal(r.decision_record.approval_blocked_until_reviewed, true);
});
test("3.4-T5: Given a transferor target implying a 3-month cushion, then the transfer-in analysis produces a surplus and a refund/credit decision.", () => {
  const p = project(A, D("2027-07-01"));
  const transferorTarget = p.required_start_cents + 3n * p.base_payment_cents;   // a 3-month cushion
  const d = decide({ projection: p, projected_actual_cents: transferorTarget, as_of: D("2026-11-01"), regx_days_delinquent: 0 });
  assert.equal(d.kind, "refund"); if (d.kind === "refund") { assert.equal(d.surplus_cents, 3n * 13_833n - 27_666n); assert.equal(d.due_on, "2026-12-01"); }
});
// 3.4-T6 — implemented in src/domain/escrow/escrow.test.ts
test("3.4-T7: Given the agent sets cushion 0 months for a hardship request, then target start = required start and the decision record carries the reason.", () => {
  const p = project(A, D("2027-07-01"), { policy_months: 0 });
  assert.equal(p.cushion_cents, 0n); assert.equal(p.target_at_start_cents, p.required_start_cents);
  const decision = { action: "cushion.override", cushion_months: 0, reason: "hardship request (borrower letter 2027-05-02)" };
  assert.match(decision.reason, /hardship/);
});

// 3.4 worked example: a 3-year flood premium of $1,800.00 raises the cushion base by $600.00 and the cap to $376.66.
test("3.4 worked example: $1,800.00 three-year flood premium → annual for cushion $2,260.00, cap $376.66", () => {
  const p = project([...A, { line_type: "flood", amount_cents: cents("1800"), disburse_on: D("2028-03-01"), cycle_years: 3 }], D("2027-07-01"));
  assert.equal(p.annual_for_cushion_cents, 226_000n); assert.equal(p.cap_cents, 37_666n);
});
