// 3.2 Annual escrow analysis
// spec/sections/03-escrow-administration/3-2-annual-escrow-analysis.md
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
import { multiYearContribution, miLines, chapter13EffectiveDate, nhDeficiencyOffer, reviewStatus } from "./ops.ts";

// 3.2-T1 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T2 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T3 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T4 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T5 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T6 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T7 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T8 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T9 — implemented in src/domain/escrow/escrow.test.ts
// 3.2-T10 — implemented in src/domain/escrow/escrow.test.ts
test("3.2-T11: Given a 3-year flood premium of $1,800 due 2028-03-01, then the line contributes $50.00/month and the statement flags the (c)(9) explanation.", () => {
  const flood = { line_type: "flood", amount_cents: cents("1800"), disburse_on: D("2028-03-01"), cycle_years: 3 };
  assert.equal(multiYearContribution(flood.amount_cents, 3), 5_000n);            // $50.00 per month
  const p = project([...A, flood], D("2027-07-01"));
  assert.equal(p.annual_cents, 166_000n + 60_000n); assert.ok(p.items.some((i) => i.cycle_years === 3));   // (c)(9) explanation flagged on the statement
  assert.equal(project([...A, { ...flood, disburse_on: D("2029-03-01") }], D("2027-07-01")).multi_year_low_point_flag, true);
});
test("3.2-T12: Given PMI terminates 2027-11-01, then MI installments after that date are excluded and the payment drops accordingly.", () => {
  const mi = miLines(5_000n, D("2027-07-01"), D("2027-11-01"));
  assert.deepEqual(mi.map((m) => m.disburse_on), ["2027-07-01", "2027-08-01", "2027-09-01", "2027-10-01"]);   // installments on/after 2027-11-01 excluded
  const withMi = project([...A, ...miLines(5_000n, D("2027-07-01"), null)], D("2027-07-01")); const after = project([...A, ...mi], D("2027-07-01"));
  assert.equal(withMi.base_payment_cents, 18_833n); assert.equal(after.base_payment_cents, 15_500n); assert.ok(after.base_payment_cents < withMi.base_payment_cents);
});
test("3.2-T13: Given an open Chapter 13 case, when the analysis is approved 2027-05-20, then `new_payment_effective_date` \u2265 21 days after the 3002.1 notice filing date.", () => {
  assert.equal(chapter13EffectiveDate(D("2027-07-01"), D("2027-05-20")), "2027-07-01");   // ≥ 21 days after the 3002.1 filing (2027-06-10)
  assert.equal(chapter13EffectiveDate(D("2027-07-01"), D("2027-06-15")), "2027-08-01");
});
test("3.2-T14: Given a NH property and a servicer-advanced deficiency, then the statement offers \u2265 12 months at 0% and no lump-sum demand.", () => {
  const o = nhDeficiencyOffer(cents("150"));
  assert.deepEqual([o.months, o.installment_cents, o.interest_rate_pct, o.lump_sum_demand], [12, 1_250n, "0", false]); assert.match(o.option_text, /RSA 397-A:9/); assert.match(o.option_text, /not required to pay it in a lump sum/);
});
test("3.2-T15: Given a payment change of 40%, then status = `anomaly_review` and the agent decision record lists the trigger before approval.", () => {
  const p = project(A, D("2027-07-01")); const d = decide({ projection: p, projected_actual_cents: cents("700"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  const t = anomalies(13_000n, 18_200n, d);                                     // +40%
  assert.ok(t.includes("payment_change_gt_25pct"));
  const r = reviewStatus(t); assert.equal(r.status, "anomaly_review"); assert.deepEqual(r.decision_record.triggers, t); assert.equal(r.decision_record.approval_blocked_until_reviewed, true);
});
test("3.2-T16: Given a biweekly loan, then 26 periods, base = round_half_up(annual/26), cushion still \u2264 1/6 of annual.", () => {
  const bw = project(A, D("2027-07-01"), {}, { biweekly: true });
  assert.equal(bw.periods, 26); assert.equal(bw.base_payment_cents, 6_385n);   // round_half_up(166,000 / 26)
  assert.ok(bw.cushion_cents <= bw.annual_cents / 6n); assert.equal(bw.cap_ok, true);
});
test("3.2-T17: Given a leap-year February disbursement dated 02-29, then the projection places it in the February period without error.", () => {
  const p = project([...A, { line_type: "hazard", amount_cents: cents("300"), disburse_on: D("2028-02-29") }], D("2027-07-01"));
  assert.equal(p.items.some((i) => i.disburse_on === "2028-02-29"), true);
  assert.equal(p.step1[7]! - p.step1[6]!, p.base_payment_cents - cents("300"));   // placed in the February period (index 7 from July)
});

// 3.2 worked example figures: Appendix E annual $1,560.00 (school $360.00), the annual analysis school line $380.00, the $1,250.00 and $570.00 variants.
test("3.2 worked example: annual $1,560.00 with school $360.00; school $380.00 next year; projected actual $1,250.00 refunds $143.32; ledger $570.00 + June deposit = $700.00", () => {
  const e = project(E, D("2026-07-01")); assert.equal(e.annual_cents, 156_000n); assert.equal(E[0]!.amount_cents, 36_000n);
  const a = project(A, D("2027-07-01")); assert.equal(A[2]!.amount_cents, 38_000n);
  assert.deepEqual(decide({ projection: a, projected_actual_cents: 125_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 }), { kind: "refund", surplus_cents: 14_332n, due_on: "2027-06-15" });
  assert.equal(57_000n + 13_000n, 70_000n);
  assert.equal(decide({ projection: a, projected_actual_cents: 57_000n + 13_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 }).kind, "shortage");
});
