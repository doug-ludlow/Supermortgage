// 12.5 Repayment plan
// spec/sections/12-loss-mitigation/12-5-repayment-plan.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { repaymentBrpGate, repaymentExtension, lateChargeTreatment, repaymentFailureSolicitation, caLateFeeBar, repaymentReporting, capRetest, arrears } from "./ops.ts";
import { repaymentTerms, repaymentPlan } from "./plans.ts";

// 12.5-T1 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.5-T2: (BRP gate) loan 95 days delinquent \u2192 plan creation refused until the BRP is complete; 85 days + 6-month term \u2192 allowed on QRPC.", () => {
  const refused = repaymentBrpGate({ days_delinquent: 95, term_months: 6, brp_complete: false, qrpc: true }); assert.equal(refused.allowed, false); assert.match(refused.refusal!, /complete BRP/);
  assert.equal(repaymentBrpGate({ days_delinquent: 95, term_months: 6, brp_complete: true, qrpc: true }).allowed, true);
  const ok = repaymentBrpGate({ days_delinquent: 85, term_months: 6, brp_complete: false, qrpc: true }); assert.equal(ok.allowed, true); assert.equal(ok.basis, "qrpc");
});
test("12.5-T3: (>12 months) 14-month request \u2192 F-1-16 package generated; plan stays `extension_pending` until approval id recorded.", () => {
  assert.deepEqual(repaymentExtension({ term_months: 14 }), { package: "F-1-16", status: "extension_pending" });
  assert.deepEqual(repaymentExtension({ term_months: 14, fnma_approval_id: "FNMA-EX-1" }), { package: "F-1-16", status: "approved" });
  assert.deepEqual(repaymentExtension({ term_months: 8 }), { package: null, status: "not_required" });
});
test("12.5-T4: (late charges) charges during the plan are suppressed; at completion they are written off with reason; on failure in month 5, charges accrue from month 5 only.", () => {
  const active = lateChargeTreatment({ plan_months: 8, outcome: "active", late_charge_cents: 6_300n }); assert.deepEqual(active.suppressed_months, [1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(active.accrued_cents, 0n);
  const done = lateChargeTreatment({ plan_months: 8, outcome: "completed", late_charge_cents: 6_300n }); assert.equal(done.written_off_cents, 50_400n); assert.equal(done.write_off_reason, "D2-3.2-02");
  const failed = lateChargeTreatment({ plan_months: 8, outcome: "failed", failed_month: 5, late_charge_cents: 6_300n }); assert.deepEqual(failed.suppressed_months, [1, 2, 3, 4]); assert.equal(failed.accrue_from_month, 5); assert.equal(failed.accrued_cents, 25_200n); assert.equal(failed.written_off_cents, 0n);
});
test("12.5-T5: (failure clock) payment missed at 2026-11-30 month-end, no QRPC, 4 months delinquent \u2192 deferral solicitation sent by 2026-12-15; if deferral-ineligible \u2192 Flex Mod solicitation by 2026-12-15.", () => {
  assert.deepEqual(repaymentFailureSolicitation({ missed_month_end: D("2026-11-30"), qrpc: false, months_delinquent: 4, deferral_eligible: true }), { solicitation: "payment_deferral", notice: "NTC_FNMA_D23204_SOLICIT_POST_REPAY", by: "2026-12-15" });
  assert.deepEqual(repaymentFailureSolicitation({ missed_month_end: D("2026-11-30"), qrpc: false, months_delinquent: 4, deferral_eligible: false }), { solicitation: "flex_mod", notice: "NTC_FNMA_D23206_SOLICIT_STREAMLINED", by: "2026-12-15" });
  assert.equal(repaymentFailureSolicitation({ missed_month_end: D("2026-11-30"), qrpc: true, months_delinquent: 4, deferral_eligible: true }).solicitation, null);
});
// 12.5-T6 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.5-T7: (CA) late fee assessment refused from the evaluation start date, not only from plan start.", () => {
  const r = caLateFeeBar({ state: "CA", evaluation_start: D("2026-10-01"), plan_start: D("2026-11-01"), assessment_on: D("2026-10-16") });
  assert.equal(r.allowed, false); assert.equal(r.barred_from, "2026-10-01"); assert.match(r.refusal!, /2924\.11\(d\)/);
  assert.equal(caLateFeeBar({ state: "CA", evaluation_start: D("2026-10-01"), plan_start: D("2026-11-01"), assessment_on: D("2026-09-16") }).allowed, true);
  assert.equal(caLateFeeBar({ state: "TX", evaluation_start: D("2026-10-01"), plan_start: D("2026-11-01"), assessment_on: D("2026-10-16") }).allowed, true);
});
test("12.5-T8: (reporting) status 12 with effective date reported at BD2; completion date reported in the completion month; $500 incentive claimed when the start delinquency was \u226560 days.", () => {
  const r = repaymentReporting({ start_on: D("2026-11-01"), completed_on: D("2027-06-28"), start_days_delinquent: 90 });
  assert.equal(r.status_code, "12"); assert.equal(r.effective_date, "2026-11-01"); assert.equal(r.report_by, "2026-12-02"); assert.equal(r.completion_report_month, "2027-06-01"); assert.equal(r.incentive_cents, 50_000n); assert.equal(r.incentive_claim_cycle, "2027-07-01");
  assert.equal(repaymentReporting({ start_on: D("2026-11-01"), completed_on: D("2027-06-28"), start_days_delinquent: 45 }).incentive_cents, 0n);
});
test("12.5-T9: (recast) escrow analysis raises PITI to $2,250 in month 3 \u2192 total $3,053.25 = 135.7% (still under cap) \u2192 no recast; a rise to $2,050 P&I-only edge case handled by the cap re-test.", () => {
  const r = capRetest({ installment_cents: 80_325n, new_contractual_cents: 225_000n, plan_months: 8 });
  assert.equal(r.total_cents, 305_325n); assert.equal(r.pct_of_contractual, "135.70"); assert.equal(r.within_cap, true); assert.equal(r.recast, null);
  const edge = capRetest({ installment_cents: 80_325n, new_contractual_cents: 205_000n, plan_months: 8 }); assert.equal(edge.total_cents, 285_325n); assert.equal(edge.within_cap, true);
  const breach = capRetest({ installment_cents: 107_100n, new_contractual_cents: 205_000n, plan_months: 6 }); assert.equal(breach.within_cap, false); assert.deepEqual(breach.recast, { months: 7 });
});

test("12.5 worked figures: PITI $2,100.00; 3 × $2,100.00 = $6,300.00 + 2 × $63.00 = $126.00 (4% of P&I $1,580.17 = $63.21) → $6,426.00; 6 months $3,171.00 (not allowed); 8 months $2,903.25; 12 months $535.50 + $2,100.00 = $2,635.50", () => {
  const a = arrears({ piti_cents: 210000n, unpaid_installments: 3, late_charge_cents: 6300n, late_charges: 2 }); assert.equal(a.installments_cents, 630000n); assert.equal(a.late_charges_cents, 12600n); assert.equal(a.total_cents, 642600n);
  assert.equal((158017n * 4n + 50n) / 100n, 6321n);
  const six = repaymentTerms(642600n, 210000n, 6); assert.equal(six.total_monthly_cents, 317100n); assert.equal(six.allowed, false);
  const eight = repaymentTerms(642600n, 210000n, 8); assert.equal(eight.total_monthly_cents, 290325n); assert.equal(eight.allowed, true);
  const twelve = repaymentTerms(642600n, 210000n, 12); assert.equal(twelve.installment_cents, 53550n); assert.equal(twelve.total_monthly_cents, 263550n);
  const cap = repaymentPlan(642600n, 210000n, 250000n); assert.equal(cap.eligible, false);
});
