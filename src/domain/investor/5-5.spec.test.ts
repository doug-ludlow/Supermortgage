// 5.5 Guaranty fee relief
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-5-guaranty-fee-relief.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { ET, gfeeBillLine, gfeeDraft, gfeeReliefPrediction, gfeeRecovery, gfeeBillVariance } from "./ops.ts";

test("5.5-T1: Given the example loan current in October 2026, then the November bill line is $52.08 (check figure equal) and the draft is funded by Thu Nov 5, 2026 16:00 ET for the Fri Nov 6 draft (Nov 7 is a Saturday).", () => {
  assert.equal(gfeeBillLine(25000000n, "0.250"), 5208n);
  const d = gfeeDraft(D("2026-11-01"));
  assert.equal(d.draft_on, "2026-11-06");                                                              // Nov 7 is a Saturday → preceding BD
  assert.equal(toIso(d.funding_gate_ms), toIso(zonedEpochMs(D("2026-11-05"), "16:00", ET)));
});
test("5.5-T2: Given the loan four consecutive months delinquent at Mar 31, 2027, then `gfee_relief_status.predicted` is set, the bill after Fannie Mae's status shows zero, and the engine asserts `sda_status` is also active (special servicing).", () => {
  const r = gfeeReliefPrediction({ lpi: D("2026-11-01"), period_end: D("2027-03-31"), type: "SS", option: "special", sda_status: "predicted", bill_line_cents: 5208n });
  assert.equal(r.months_delinquent, 4); assert.equal(r.gfee_relief_status, "predicted"); assert.equal(r.bill_expected_cents, 0n); assert.equal(r.consistent, true); assert.match(r.assertion, /sda_status/);
  const diverged = gfeeReliefPrediction({ lpi: D("2026-11-01"), period_end: D("2027-03-31"), type: "SS", option: "special", sda_status: "not_applicable", bill_line_cents: 5208n });
  assert.equal(diverged.consistent, false); assert.equal(diverged.alert, true);
});
test("5.5-T3: Given two contractual payments during relief, then the next bill drafts two months of g-fee ($52.08 + $52.04) applied first to `outstanding_fnma_gfee`, and subsequent bills show servicer retention credits until $208.05 of servicer g-fee advances are recovered.", () => {
  const first = gfeeRecovery({ outstanding_fnma_gfee_cents: 10412n, servicer_gfee_advances_cents: 20805n, payment_gfees_cents: [5208n, 5204n] });
  assert.equal(first.bill_draft_cents, 10412n); assert.equal(first.servicer_retention_cents, 0n); assert.equal(first.remaining_fnma_cents, 0n);
  assert.deepEqual(first.lines.map((l) => l.to_fnma_cents), [5208n, 5204n]);
  const later = gfeeRecovery({ outstanding_fnma_gfee_cents: first.remaining_fnma_cents, servicer_gfee_advances_cents: first.remaining_servicer_advances_cents, payment_gfees_cents: [5199n, 5194n, 5189n, 5185n, 5180n] });
  assert.equal(later.bill_draft_cents, 0n); assert.equal(later.servicer_retention_cents, 20805n); assert.equal(later.remaining_servicer_advances_cents, 0n);
  assert.equal(later.lines[4]!.retained_cents, 20805n - (5199n + 5194n + 5189n + 5185n));
});
test("5.5-T4: Given a bill total $48,210.44 vs computed $47,600.10 (variance $610.34 > $500), then an `officer` escalation opens with the per-loan variance list.", () => {
  const v = gfeeBillVariance({ bill_total_cents: 4821044n, computed_total_cents: 4760010n, per_loan: [{ loan_id: "L1", bill_cents: 66242n, computed_cents: 5208n }, { loan_id: "L2", bill_cents: 5204n, computed_cents: 5204n }] });
  assert.equal(v.variance_cents, 61034n); assert.equal(v.threshold_cents, 50000n); assert.equal(v.escalation, "officer");
  assert.deepEqual(v.per_loan_variances, [{ loan_id: "L1", variance_cents: 61034n }]);
  assert.equal(gfeeBillVariance({ bill_total_cents: 4760020n, computed_total_cents: 4760010n, per_loan: [] }).escalation, null);
});
test("5.5-T5: Given a regular servicing option MBS loan five months delinquent, then g-fee relief is active while P&I advances continue (documented expected divergence, no alert).", () => {
  const r = gfeeReliefPrediction({ lpi: D("2026-10-01"), period_end: D("2027-03-31"), type: "SS", option: "regular", sda_status: "not_applicable", bill_line_cents: 5208n });
  assert.equal(r.months_delinquent, 5); assert.equal(r.gfee_relief_status, "predicted"); assert.equal(r.expected_divergence, true); assert.equal(r.alert, false); assert.equal(r.consistent, true);
  assert.match(r.assertion, /advances continue/);
});
test("5.5-T6: Given the g-fee draft date Jan 7, 2027 (Thursday), then funding gate = Wed Jan 6 16:00 ET; for Feb 7, 2027 (Sunday) the draft date is Fri Feb 5 and the gate Thu Feb 4.", () => {
  const jan = gfeeDraft(D("2027-01-01")); assert.equal(jan.draft_on, "2027-01-07"); assert.equal(toIso(jan.funding_gate_ms), toIso(zonedEpochMs(D("2027-01-06"), "16:00", ET)));
  const feb = gfeeDraft(D("2027-02-01")); assert.equal(feb.draft_on, "2027-02-05"); assert.equal(toIso(feb.funding_gate_ms), toIso(zonedEpochMs(D("2027-02-04"), "16:00", ET)));
});
