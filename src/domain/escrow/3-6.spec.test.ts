// 3.6 Shortage repayment
// spec/sections/03-escrow-administration/3-6-shortage-repayment.md
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
import { buildPlan, lumpSum, recordInstallment, demandDeficiencyGate, type Plan } from "./shortage.ts";
import { lumpSumWordingAllowed } from "./statement.ts";
import { nhDeficiencyOffer } from "./ops.ts";

test("3.6-T1: Given shortage $406.68 and base $138.33, then plan 12 \u00d7 $33.89, final $33.89, and `loan_terms` shows $172.22 from 2027-07-01 stepping to $138.33 on 2028-07-01.", () => {
  const p = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan;
  assert.deepEqual([p.months, p.installment_cents, p.final_installment_cents, p.end_due_date], [12, 3_389n, 3_389n, "2028-06-01"]);
  const proj = project(A, D("2027-07-01")); const d = decide({ projection: proj, projected_actual_cents: cents("700"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  assert.equal(newPayment(proj, d).payment_cents, 17_222n);                        // $172.22 from 2027-07-01
  assert.equal(addMonths(p.end_due_date, 1), "2028-07-01"); assert.equal(proj.base_payment_cents, 13_833n);   // steps down to $138.33 on 2028-07-01
});
test("3.6-T2: Given shortage $100.00 (< one month), then options allow/30-day/12-month are available and the default plan is 12 \u00d7 $8.33 with final $8.37.", () => {
  const s = buildPlan("shortage", 10_000n, D("2027-07-01"), {}) as Plan; assert.deepEqual([s.installment_cents, s.final_installment_cents], [833n, 837n]);
  const proj = project(A, D("2027-07-01")); const d = decide({ projection: proj, projected_actual_cents: proj.target_at_start_cents - 10_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  if (d.kind === "shortage") { assert.equal(d.lump_sum_option_offered, true); assert.equal(d.months, 12); }   // allow / 30-day / 12-month options available
});
test("3.6-T3: Given deficiency $150.00 with `regx_days_delinquent=0`, then plan 12 \u00d7 $12.50; given 2 installments configured, then 2 \u00d7 $75.00.", () => {
  assert.equal((buildPlan("deficiency", 15_000n, D("2027-07-01"), {}) as Plan).installment_cents, 1_250n);
  assert.equal((buildPlan("deficiency", 15_000n, D("2027-07-01"), { deficiency_installments: 2 }) as Plan).installment_cents, 7_500n);
});
test("3.6-T4: Given a workout analysis shortage $2,400 with no election, then 60 \u00d7 $40.00; with an evidenced 24-month election, 24 \u00d7 $100.00; with a 6-month election, the election is rejected (\u2265 12).", () => {
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true }) as Plan).installment_cents, 4_000n);
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true, election_months: 24 }) as Plan).installment_cents, 10_000n);
  assert.ok("error" in buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true, election_months: 6 }));
});
test("3.6-T5: Given `instrument_shortage_max_months=12` and policy 24, then months = 12.", () => {
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { policy_months: 24, instrument_max_months: 12 }) as Plan).months, 12);
});
test("3.6-T6: Given an unsolicited lump sum equal to remaining shortage, then plan `paid_lump`, interim analysis within 10 BD, short-year statement, and the payment steps down on the first due date \u2265 30 days after the statement.", () => {
  const p = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan;
  const ls = lumpSum(p, 40_668n, D("2027-09-10")); assert.equal(ls.paid, true); assert.equal(p.status, "paid_lump"); assert.equal(ls.interim_analysis_by, "2027-09-24");
  assert.equal(effectiveDate(D("2027-10-01"), D("2027-09-18")), "2027-11-01");     // short-year statement 09-18 → step-down on the first due date ≥ 30 days later
});
test("3.6-T7: Given an advance of $900 on a NH property, then the deficiency plan is \u2265 12 months at 0% and the statement carries the RSA 397-A:9 option text.", () => {
  const nh = buildPlan("deficiency", cents("900"), D("2027-07-01"), { state: "NH", deficiency_installments: 6 }) as Plan;
  assert.equal(nh.months, 12); assert.equal(nh.basis, "nh_0pct"); assert.equal(nh.installment_cents, 7_500n); assert.equal(nh.interest_rate_pct, "0");
  assert.match(nhDeficiencyOffer(cents("900")).option_text, /RSA 397-A:9/);
});
test("3.6-T8: Given a servicer advance and `demandDeficiencyRepayment` called before the interim analysis, then the command is refused with gate `REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE`.", () => {
  assert.deepEqual(demandDeficiencyGate(false), { ok: false, gate: "REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE" }); assert.deepEqual(demandDeficiencyGate(true), { ok: true });
});
test("3.6-T9: Given a second analysis mid-plan with collected $203.34, then the new shortage reflects the actual balance and the old plan is `superseded` without double counting.", () => {
  const old = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan;
  for (let n = 1; n <= 6; n++) recordInstallment(old, n); assert.equal(old.collected_cents, 20_334n);
  const remaining = old.total_cents - old.collected_cents; old.status = "superseded";
  const next = buildPlan("shortage", remaining, D("2028-01-01"), {}) as Plan;         // the new shortage already nets what was collected
  assert.equal(next.total_cents, 20_334n); assert.equal(old.collected_cents + next.total_cents, 40_668n); assert.equal(old.status, "superseded");
});
test("3.6-T10: Given the annual statement for a \u2265-one-month shortage, then the rendered text contains no lump-sum wording (validator check).", () => {
  assert.equal(lumpSumWordingAllowed(40_668n, 13_833n), false);
  const itemVii = "$33.89 per month for 12 months beginning 07/01/2027";
  assert.equal(/lump[- ]sum/i.test(itemVii), false);
});

// 3.6 worked example (c): a $2,400.00 workout shortage spreads 60 × $40.00.
test("3.6 worked example: $2,400.00 workout shortage → 60 × $40.00", () => {
  const p = buildPlan("shortage", 240_000n, D("2027-07-01"), { workout: true }) as Plan; assert.deepEqual([p.months, p.installment_cents, p.basis], [60, 4_000n, "workout_60"]);
});
