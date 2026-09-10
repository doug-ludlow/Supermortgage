// 5.4 Stop Delinquency Advance handling
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-4-stop-delinquency-advance-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { scheduleForward } from "./remittance.ts";
import { matchReimbursements, regularOptionSixMonths, sdaStatusVariance, form496Line12, FORM_496_LINE_12_EXPLANATION, sdaPayoffRemittance, servicingFeeComponent } from "./ops.ts";

// 5.4-T1 — implemented in src/domain/investor/investor.test.ts
// 5.4-T2 — implemented in src/domain/investor/investor.test.ts
// 5.4-T3 — implemented in src/domain/investor/investor.test.ts
test("5.4-T4: Given a completed payment deferral on an SDA loan, then all `advances` rows move to `reimbursed_by_fnma` within two cycles or an IRR package is escalated.", () => {
  const advances = [{ period: "2026-11", amount_cents: 147600n, status: "outstanding" as const }, { period: "2026-12", amount_cents: 147610n, status: "outstanding" as const }, { period: "2027-01", amount_cents: 147619n, status: "outstanding" as const }, { period: "2027-02", amount_cents: 147629n, status: "outstanding" as const }];
  const ok = matchReimbursements({ advances, credits: [590458n], cycles_elapsed: 1 });
  assert.equal(ok.all_reimbursed, true); assert.ok(ok.advances.every((a) => a.status === "reimbursed_by_fnma")); assert.equal(ok.unmatched_credit_cents, 0n); assert.equal(ok.escalation, null);
  const partial = matchReimbursements({ advances, credits: [295210n], cycles_elapsed: 2 });
  assert.equal(partial.all_reimbursed, false); assert.equal(partial.escalation, "irr_package"); assert.equal(partial.advances.filter((a) => a.status === "reimbursed_by_fnma").length, 2);
  assert.equal(matchReimbursements({ advances, credits: [], cycles_elapsed: 1 }).escalation, null);
});
test("5.4-T5: Given a regular servicing option S/S loan six consecutive months delinquent, then no SDA is predicted, advances continue, and the deselection decision task is created on CD11 and due CD15.", () => {
  const r = regularOptionSixMonths({ lpi: D("2026-10-01"), period_end: D("2027-04-30"), type: "SS", option: "regular" });
  assert.equal(r.months_delinquent, 6); assert.equal(r.sda, "not_applicable"); assert.equal(r.advances_continue, true); assert.equal(r.reclass_selection_expected, true);
  assert.deepEqual(r.deselection_task, { created_on: "2027-05-11", due_on: "2027-05-15" });
  assert.equal(regularOptionSixMonths({ lpi: D("2026-10-01"), period_end: D("2027-04-30"), type: "SS", option: "special" }).sda, "predicted");
});
test("5.4-T6: Given Fannie Mae's report shows Stop Advance for a loan we predicted as three months delinquent, then a sev-2 variance opens comparing LPI dates and the 5.1 reporting history.", () => {
  const history = [{ period: "2026-11", lpi: D("2026-10-01"), status: "accepted" }, { period: "2026-12", lpi: D("2026-10-01"), status: "accepted" }, { period: "2027-01", lpi: D("2026-10-01"), status: "accepted" }];
  const v = sdaStatusVariance({ predicted: "not_applicable", predicted_months: 3, fnma_status: "stop_advance", our_lpi: D("2026-10-01"), fnma_lpi: D("2026-09-01"), reporting_history: history });
  assert.equal(v.variance!.severity, "sev2"); assert.equal(v.variance!.kind, "sda_status_mismatch"); assert.equal(v.variance!.our_lpi, "2026-10-01"); assert.equal(v.variance!.fnma_lpi, "2026-09-01");
  assert.equal(v.variance!.reporting_history.length, 3); assert.equal(v.authoritative, "fnma");
  assert.equal(sdaStatusVariance({ predicted: "active", predicted_months: 4, fnma_status: "stop_advance", our_lpi: D("2026-10-01"), fnma_lpi: D("2026-10-01"), reporting_history: history }).variance, null);
});
test("5.4-T7: Given month-end Form 496 preparation, then Section II line 12 equals \u03a3 Fannie Mae-reported outstanding P&I receivables for SDA loans with the standard explanation.", () => {
  const line = form496Line12([{ loan_id: "L1", sda_status: "active", fm_pi_receivable_reported_cents: 147638n }, { loan_id: "L2", sda_status: "active", fm_pi_receivable_reported_cents: 147648n }, { loan_id: "L3", sda_status: "not_applicable", fm_pi_receivable_reported_cents: 100n }]);
  assert.equal(line.amount_cents, 295286n); assert.deepEqual(line.loans, ["L1", "L2"]); assert.equal(line.explanation, FORM_496_LINE_12_EXPLANATION); assert.equal(line.source, "remittance_detail_pi");
});
test("5.4-T8: Given a payoff of an SDA loan, then the payoff remittance includes Fannie Mae's outstanding P&I receivable and the servicer's advances are recovered from the payoff proceeds/borrower per the payoff calculator.", () => {
  const p = sdaPayoffRemittance({ payoff_upb_cents: 24885767n, payoff_interest_cents: 124429n, fm_pi_receivable_cents: 295286n, servicer_advances_outstanding_cents: 590458n, proceeds_cents: 24885767n + 124429n + 295286n + 590458n });
  assert.equal(p.remittance_cents, 24885767n + 124429n + 295286n); assert.equal(p.includes_fm_receivable, true);
  assert.equal(p.servicer_recovery_cents, 590458n); assert.equal(p.recovery_source, "payoff_proceeds"); assert.equal(p.shortfall_cents, 0n);
  const short = sdaPayoffRemittance({ payoff_upb_cents: 24885767n, payoff_interest_cents: 124429n, fm_pi_receivable_cents: 295286n, servicer_advances_outstanding_cents: 590458n, proceeds_cents: 24885767n + 124429n + 295286n });
  assert.equal(short.recovery_source, "borrower_balance"); assert.equal(short.shortfall_cents, 590458n);
});

test("5.4 worked examples 3–4: Stop Advance month P&I $1,476.38 then $1,476.48, two contractual payments $3,160.34, servicing-fee component $51.90", () => {
  const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 6);
  assert.equal(s[4]!.prior_scheduled_upb_cents, 24908861n); assert.equal(s[4]!.fnma_interest_cents, 124544n); assert.equal(s[4]!.fnma_principal_cents, 23094n); assert.equal(s[4]!.fnma_interest_cents + s[4]!.fnma_principal_cents, 147638n);
  assert.equal(s[5]!.prior_scheduled_upb_cents, 24885767n); assert.equal(s[5]!.fnma_interest_cents + s[5]!.fnma_principal_cents, 147648n);
  assert.equal(147638n + 147648n, 295286n); assert.equal(158017n * 2n, 316034n);
  assert.equal(servicingFeeComponent(24908861n, "6.500", "6.000", "0.250"), 5190n);
});
