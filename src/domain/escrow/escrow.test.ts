/** §3.1–3.9 acceptance tests (Appendix E replay and the spec's annual example). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import * as ESC from "./analysis.ts";
import { cents } from "../../kernel/money/cents.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { project, decide, newPayment, cushion, effectiveDate, anomalies, settlementDepositCeiling } from "./analysis.ts";
import { exemption as stmtExemption, annualDeadline, shortYearDeadline, postExemptionDeadline, lowPointExplanation, lumpSumWordingAllowed } from "./statement.ts";
import { refundDecision, payoffRefundDue, needsDualApproval } from "./refund.ts";
import { buildPlan, lumpSum, demandDeficiencyGate, type Plan } from "./shortage.ts";
import { schedule, fundsCheck, installmentChoice, hazardDecision, ilTaxPaidNoticeDue } from "./disbursement.ts";
import { evaluateWaiver, revocation } from "./waiver.ts";
import * as I from "./interest.ts";
import { eventDeadlineMs } from "../investor/period.ts";

const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];

test("Appendix E replay — base $130, cushion $260, start $1,040, December target $260 (golden; the T-ids live in 3-1/3-2.spec.test.ts)", () => {
  const p = project(E, D("2026-07-01"));
  assert.equal(p.base_payment_cents, 13_000n); assert.equal(p.required_start_cents, 78_000n); assert.equal(p.cushion_cents, 26_000n); assert.equal(p.target_at_start_cents, 104_000n);
  assert.deepEqual(p.step1.map(Number), [-37000, -24000, -47000, -34000, -21000, -78000, -65000, -52000, -39000, -26000, -13000, 0]);
  assert.equal(p.targets[5], 26_000n); assert.equal(p.cap_ok, true); assert.equal(settlementDepositCeiling(p), 104_000n);
});

test("annual example — base $138.33, target $1,106.68, shortage $406.68 → $33.89, payment $172.22; surplus and deficiency variants (golden)", () => {
  const p = project(A, D("2027-07-01"));
  assert.equal(p.base_payment_cents, 13_833n); assert.equal(p.step1[5], -83_002n); assert.equal(p.step1[11], -4n); assert.equal(p.required_start_cents, 83_002n); assert.equal(p.cushion_cents, 27_666n); assert.equal(p.target_at_start_cents, 110_668n);
  const d = decide({ projection: p, projected_actual_cents: cents("700"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  assert.equal(d.kind, "shortage"); if (d.kind === "shortage") { assert.equal(d.shortage_cents, 40_668n); assert.equal(d.months, 12); assert.equal(d.installment_cents, 3_389n); assert.equal(d.final_installment_cents, 3_389n); assert.equal(d.lump_sum_option_offered, false); }
  assert.equal(newPayment(p, d).payment_cents, 17_222n); assert.equal(effectiveDate(D("2027-07-01"), D("2027-05-20")), "2027-07-01"); assert.equal(effectiveDate(D("2027-07-01"), D("2027-06-10")), "2027-08-01");
  const s = decide({ projection: p, projected_actual_cents: cents("1250"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  assert.deepEqual(s, { kind: "refund", surplus_cents: 14_332n, due_on: "2027-06-15" }); assert.equal(newPayment(p, s).payment_cents, 13_833n);
  // The spec's $1,080.00 variant ("surplus $26.68") is a $26.68 *shortage* against the $1,106.68 target (see the 3.2 spec test for T4).
  // The surplus branch it describes requires $1,133.36 — used here; flagged for the audit.
  const c = decide({ projection: p, projected_actual_cents: cents("1133.36"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  assert.deepEqual(c, { kind: "credit", surplus_cents: 2_668n, credit_monthly_cents: 222n, first_month_extra_cents: 4n }); assert.equal(newPayment(p, c).payment_cents, 13_611n); assert.equal(newPayment(p, c).first_month_cents, 13_607n);
  const def = decide({ projection: p, projected_actual_cents: -cents("150"), as_of: D("2027-05-16"), regx_days_delinquent: 0 });
  if (def.kind === "shortage") { assert.deepEqual([def.deficiency_cents, def.deficiency_installment_cents, def.shortage_cents, def.installment_cents, def.final_installment_cents], [15_000n, 1_250n, 110_668n, 9_222n, 9_226n]); }
  assert.equal(newPayment(p, def).payment_cents, 24_305n); assert.equal(newPayment(p, def).final_month_cents, 24_309n);
});

test("decision edges, delinquency retention, workout spread, cushion sources, multi-year low point (golden)", () => {
  const p = project(A, D("2027-07-01"));
  const exact = decide({ projection: p, projected_actual_cents: p.target_at_start_cents - 13_833n, as_of: D("2027-05-16"), regx_days_delinquent: 0 }); if (exact.kind === "shortage") assert.equal(exact.lump_sum_option_offered, false);
  const small = decide({ projection: p, projected_actual_cents: p.target_at_start_cents - 10_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 }); if (small.kind === "shortage") assert.equal(small.lump_sum_option_offered, true);
  assert.equal(decide({ projection: p, projected_actual_cents: p.target_at_start_cents + 5_000n, as_of: D("2027-05-16"), regx_days_delinquent: 0 }).kind, "refund");
  assert.equal(decide({ projection: p, projected_actual_cents: p.target_at_start_cents + 30_000n, as_of: D("2027-05-16"), regx_days_delinquent: 31 }).kind, "retain");
  assert.equal(decide({ projection: p, projected_actual_cents: p.target_at_start_cents + 30_000n, as_of: D("2027-05-16"), regx_days_delinquent: 30 }).kind, "refund");
  const w = decide({ projection: p, projected_actual_cents: 0n, as_of: D("2027-05-16"), regx_days_delinquent: 90, workout: true }); if (w.kind === "shortage") assert.equal(w.months, 60);
  const we = decide({ projection: p, projected_actual_cents: 0n, as_of: D("2027-05-16"), regx_days_delinquent: 90, workout: true, borrower_election_months: 24 }); if (we.kind === "shortage") assert.equal(we.months, 24);
  assert.deepEqual([cushion(166_000n, {}).cents, cushion(166_000n, { instrument_months: 1 }).cents, cushion(166_000n, { instrument_months: 1 }).source, cushion(166_000n, { state_max_months: 1.5 }).cents, cushion(166_000n, { state_max_months: 1.5 }).source], [27_666n, 13_833n, "instrument", 20_750n, "state"]);
  const pi = project(A, D("2027-07-01"), { instrument_months: 1 }); assert.equal(pi.target_at_start_cents, 83_002n + 13_833n);
  // a 3-year premium due in year 2 contributes $50/month every year; the low-point flag is set in the years the bill does not fall.
  const floodYr2 = project([...A, { line_type: "flood", amount_cents: cents("1800"), disburse_on: D("2028-03-01"), cycle_years: 3 }], D("2027-07-01"));
  assert.equal(floodYr2.annual_cents, 166_000n + 60_000n); assert.equal(floodYr2.cap_cents, 37_666n); assert.equal(floodYr2.multi_year_low_point_flag, false);
  const floodYr1 = project([...A, { line_type: "flood", amount_cents: cents("1800"), disburse_on: D("2029-03-01"), cycle_years: 3 }], D("2027-07-01"));
  assert.equal(floodYr1.multi_year_low_point_flag, true);
  assert.equal(project([{ ...A[0]!, available_on: D("2027-08-01") }], D("2027-07-01")).preaccrual_ok, false);
  assert.ok(anomalies(13_000n, 24_305n, w).includes("payment_change_gt_25pct"));
  const bw = project(A, D("2027-07-01"), {}, { biweekly: true }); assert.equal(bw.periods, 26); const diff = bw.base_payment_cents * 26n - bw.annual_cents; assert.ok(diff >= -26n && diff <= 26n);
});

test("3.3: exemption, deadlines, low-point explanation, lump-sum wording", () => {
  assert.equal(stmtExemption({ regx_days_delinquent: 45, foreclosure_first_legal_filed: false, bankruptcy_open: false }), "delinquent_30");
  assert.equal(stmtExemption({ regx_days_delinquent: 0, foreclosure_first_legal_filed: false, bankruptcy_open: true }), null);
  assert.deepEqual(annualDeadline(D("2027-06-30")), { due_on: "2027-07-30", send_target_on: "2027-07-23" });
  assert.equal(shortYearDeadline("transfer", D("2027-03-01")), "2027-04-30"); assert.equal(shortYearDeadline("payoff", D("2027-02-10")), "2027-04-11"); assert.equal(postExemptionDeadline(D("2027-09-10")), "2027-12-09");
  const ex = lowPointExplanation([{ month: D("2026-07-01"), line_type: "County tax", projected_cents: 50_000n, actual_cents: 52_000n }, { month: D("2026-12-01"), line_type: "County tax", projected_cents: 70_000n, actual_cents: 76_000n }, { month: D("2027-03-01"), line_type: "supplemental tax", projected_cents: null, actual_cents: 26_000n }], 18_000n, 26_000n);
  assert.equal(ex.length, 4); assert.match(ex[3]!, /low balance \$180.00 vs \$260.00/);
  assert.equal(lumpSumWordingAllowed(40_668n, 13_833n), false);
});

test("3.5: refund thresholds, 20-federal-business-day payoff refund (Presidents' Day / Christmas-observed / MLK)", () => {
  assert.equal(refundDecision(5_000n, 0, D("2027-05-16")).action, "refund"); assert.equal(refundDecision(4_999n, 0, D("2027-05-16")).action, "credit"); assert.equal(refundDecision(30_000n, 31, D("2027-05-16")).action, "retain");
  assert.equal(refundDecision(14_332n, 0, D("2027-05-16")).due_on, "2027-06-15");
  assert.equal(payoffRefundDue(D("2027-02-11")), "2027-03-12");
  assert.equal(payoffRefundDue(D("2027-12-24")), "2028-01-25");
  assert.equal(needsDualApproval(cents("30000")), true);
});

test("3.6: plans — 12 × $33.89; $100 → $8.33/$8.37; deficiency 12 × $12.50 or 2 × $75; workout 60 × $40 / election 24 × $100 / 6 rejected; instrument cap; NH; lump sum; gate", () => {
  const p = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan; assert.deepEqual([p.months, p.installment_cents, p.final_installment_cents, p.end_due_date], [12, 3_389n, 3_389n, "2028-06-01"]);
  const s = buildPlan("shortage", 10_000n, D("2027-07-01"), {}) as Plan; assert.deepEqual([s.installment_cents, s.final_installment_cents], [833n, 837n]);
  assert.equal((buildPlan("deficiency", 15_000n, D("2027-07-01"), {}) as Plan).installment_cents, 1_250n); assert.equal((buildPlan("deficiency", 15_000n, D("2027-07-01"), { deficiency_installments: 2 }) as Plan).installment_cents, 7_500n);
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true }) as Plan).installment_cents, 4_000n);
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true, election_months: 24 }) as Plan).installment_cents, 10_000n);
  assert.ok("error" in buildPlan("shortage", cents("2400"), D("2027-07-01"), { workout: true, election_months: 6 }));
  assert.equal((buildPlan("shortage", cents("2400"), D("2027-07-01"), { policy_months: 24, instrument_max_months: 12 }) as Plan).months, 12);
  const nh = buildPlan("deficiency", cents("900"), D("2027-07-01"), { state: "NH", deficiency_installments: 6 }) as Plan; assert.equal(nh.months, 12); assert.equal(nh.basis, "nh_0pct"); assert.equal(nh.installment_cents, 7_500n);
  const ls = lumpSum(p, 40_668n, D("2027-09-10")); assert.equal(ls.paid, true); assert.equal(p.status, "paid_lump"); assert.equal(ls.interim_analysis_by, "2027-09-24");
  assert.equal(demandDeficiencyGate(false).ok, false);
});

test("3.7: scheduling with discount capture, advances, installment choice, hazard overlay, event deadline, IL notice", () => {
  const bill = { amount_cents: cents("760"), due_on: D("2027-12-10"), received_on: D("2027-11-01"), discount: { pct: "2", by: D("2027-11-30") } };
  const s = schedule(bill, "tax_service_bulk", cents("810"), 0n); assert.deepEqual([s.release_on, s.amount_cents, s.discount_captured], ["2027-11-26", 74_480n, true]);   // 10 BD before 12/10
  const s2 = schedule(bill, "tax_service_bulk", cents("500"), 0n); assert.equal(s2.discount_captured, false); assert.equal(s2.amount_cents, 76_000n); assert.equal(s2.release_on, "2027-11-26");
  assert.equal(schedule(bill, "check", cents("500"), 0n).release_on, "2027-12-01"); assert.equal(schedule(bill, "wire", cents("500"), 0n).release_on, "2027-12-09");   // 7 BD / 1 BD leads
  assert.deepEqual(fundsCheck(cents("760"), cents("500"), 0n), { release: true, advance_cents: 26_000n, escrow_after_cents: -26_000n });
  assert.equal(installmentChoice({ annual_discount_pct: null, installment_fee: false }, true), "installments"); assert.equal(installmentChoice({ annual_discount_pct: "3", installment_fee: false }, true), "annual"); assert.equal(installmentChoice({ annual_discount_pct: "3", installment_fee: false }, true, "installments"), "installments");
  assert.deepEqual(hazardDecision(45, null, false), { pay: true, inability_to_disburse: false, lpi_gate_open: false }); assert.deepEqual(hazardDecision(45, "underwriting", false), { pay: false, inability_to_disburse: true, lpi_gate_open: true }); assert.equal(hazardDecision(45, "non_payment", false).pay, true);
  const ET = "America/New_York"; assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-07-15"), "18:00", ET))), toIso(zonedEpochMs(D("2027-07-16"), "03:00", ET))); assert.equal(toIso(eventDeadlineMs(zonedEpochMs(D("2027-07-16"), "10:00", ET))), toIso(zonedEpochMs(D("2027-07-19"), "03:00", ET)));
  // The spec's Illinois example hand-counts 2027-08-06; excluding both Juneteenth (obs. Fri 6/18) and Independence Day (obs. Mon 7/5) gives 8/09 (see 3-7.spec.test.ts).
  assert.equal(ilTaxPaidNoticeDue(D("2027-06-03")), "2027-08-09");
});

test("3.8: HPML denial at exactly 80%, approval at $239,900, delinquency reasons, partial waivers, revocation", () => {
  const base = { requested_on: D("2027-03-02"), original_appraised_value_cents: cents("310000"), hpml: true, consummation_date: D("2021-06-15"), original_property_value_cents: cents("300000"), regx_days_delinquent: 0, late_30_in_12m: 0, late_60_in_24m: 0, prior_modification: false, prior_waiver_missed_payments: false, monthly_mi_line: false, flood_escrow_mandatory: false, instrument_permits: true, next_due_dates: [D("2027-04-01"), D("2027-05-01")] };
  const den = evaluateWaiver({ ...base, upb_cents: cents("240000") }); assert.equal(den.decision, "denied"); assert.deepEqual(den.reasons, ["HPML_LTV_GE_80_ORIG_VALUE"]);
  const ok = evaluateWaiver({ ...base, upb_cents: cents("239900") }); assert.equal(ok.decision, "approved"); assert.equal(ok.effective_on, "2027-04-01");
  assert.deepEqual(evaluateWaiver({ ...base, upb_cents: cents("239900"), late_30_in_12m: 1 }).reasons, ["DELINQ_12M"]); assert.deepEqual(evaluateWaiver({ ...base, upb_cents: cents("239900"), late_60_in_24m: 1 }).reasons, ["DELINQ_60D_24M"]);
  const part = evaluateWaiver({ ...base, upb_cents: cents("239900"), monthly_mi_line: true }); assert.equal(part.decision, "partial"); assert.deepEqual(part.lines_kept, ["mi"]);
  assert.equal(evaluateWaiver({ ...base, upb_cents: cents("239900"), flood_escrow_mandatory: true }).lines_kept[0], "flood");
  const rv = revocation(D("2027-12-11"), cents("2400"), cents("120")); assert.deepEqual([rv.opening_balance_cents, rv.initial_statement_due_on, rv.deficiency_cents], [-252_000n, "2028-01-25", 252_000n]);
});

test("3.9: NY $6.22, CT floor 1.5% → $13.50 and $3.70 proration, MN $30, WI bands, exemptions, 1099 threshold, negative balances", () => {
  assert.equal(I.accrue(123_456n, I.resolveRate({ state: "NY", origination_date: D("2020-01-01") }), 92), 622n);
  assert.equal(I.resolveRate({ state: "CT", origination_date: D("2020-01-01") }, { index_pct: "0.49" }), "1.5");
  assert.equal(I.accrue(90_000n, "1.5", 365), 1_350n); assert.equal(I.accrue(90_000n, "1.5", 100), 370n);
  assert.equal(I.accrueMn([100_000n, 100_000n, 100_000n]), 3_000n); assert.equal(I.exemption({ state: "MN", origination_date: D("2020-01-01"), origination_ltv_pct: "85" }), "ltv_gt_80");
  assert.deepEqual([I.resolveRate({ state: "WI", origination_date: D("1990-06-01") }), I.resolveRate({ state: "WI", origination_date: D("2016-05-01") }), I.exemption({ state: "WI", origination_date: D("2019-03-01") })], ["5.25", "0.17", "origination_band_none"]);
  assert.equal(I.exemption({ state: "RI", origination_date: D("2020-01-01"), pmi_active: true }), "pmi_active"); assert.equal(I.exemption({ state: "VT", origination_date: D("2020-01-01"), escrow_imposed_for_default: true }), "escrow_imposed_for_default");
  assert.equal(I.maTaxShare(100_000n, { state: "MA", origination_date: D("2020-01-01"), tax_annual_cents: 300_000n, total_annual_cents: 420_000n }), 71_429n);
  assert.equal(I.needs1099Int(2_488n), true); assert.equal(I.needs1099Int(840n), false); assert.equal(I.accrue(-5_000n, "2", 20), 0n);
});

test("3.2 R1 line projection (AUDIT-REPORT item 4): known bill wins; prior year × CPI only for tax lines; insurance stays prior year; comparable for new construction; MI drops after termination; stale prior-year estimate → R10 anomaly; disbursement on the discount date when captured, else the penalty-avoidance date", () => {
  const yearStart = D("2027-07-01");
  const lines: ESC.EscrowLineInput[] = [
    { line_type: "tax_county", frequency: "semiannual", estimate_basis: "prior_year_cpi", prior_year_annual_cents: 128_000n, prior_disbursed_on: [D("2026-11-10"), D("2027-04-10")] },
    { line_type: "hazard", frequency: "annual", estimate_basis: "prior_year_cpi", prior_year_annual_cents: 90_000n, prior_disbursed_on: [D("2026-09-15")], prior_year_confirmed_on: D("2024-09-15") },
    { line_type: "tax_school", frequency: "annual", estimate_basis: "known_bill", prior_year_annual_cents: 38_000n, prior_disbursed_on: [D("2026-10-01")], known_bills: [{ amount_cents: 40_000n, due_on: D("2027-10-01"), penalty_on: D("2027-10-31"), discount: { by: D("2027-09-30"), amount_cents: 800n }, available_on: D("2027-09-01") }] },
    { line_type: "tax_city", frequency: "annual", estimate_basis: "comparable", prior_year_annual_cents: 0n, comparable_annual_cents: 52_000n, prior_disbursed_on: [] },
    { line_type: "mi_borrower_paid", frequency: "monthly", estimate_basis: "contract", prior_year_annual_cents: 0n, contract_annual_cents: 96_000n, terminates_on: D("2027-10-01"), prior_disbursed_on: Array.from({ length: 12 }, (_, k) => addMonths(D("2026-07-01"), k)) },
  ] as ESC.EscrowLineInput[];
  const r = ESC.projectLines(lines, yearStart, { cpi_change_pct: "3.2" });
  const basis = Object.fromEntries(r.bases.map((b) => [b.line_type, [b.basis_used, b.annual_cents]]));
  assert.deepEqual(basis.tax_county, ["prior_year_cpi", 132_096n]);       // 1,280.00 × 1.032 = 1,320.96
  assert.deepEqual(basis.hazard, ["prior_year", 90_000n]);                // insurers quote renewals: no CPI on insurance lines
  assert.deepEqual(basis.tax_school, ["known_bill", 40_000n]); assert.deepEqual(basis.tax_city, ["comparable", 52_000n]); assert.deepEqual(basis.mi_borrower_paid, ["contract", 96_000n]);
  assert.ok(r.anomalies.includes("hazard:estimate_basis_prior_year_gt_2y"));
  const school = r.items.find((i) => i.line_type === "tax_school")!; assert.equal(school.disburse_on, "2027-09-30"); assert.equal(school.available_on, "2027-09-01");
  const county = r.items.filter((i) => i.line_type === "tax_county"); assert.deepEqual(county.map((i) => i.disburse_on), ["2027-11-10", "2028-04-10"]); assert.equal(county[0]!.amount_cents + county[1]!.amount_cents, 132_096n);
  const mi = r.items.filter((i) => i.line_type === "mi_borrower_paid"); assert.equal(mi.length, 3); assert.ok(mi.every((i) => i.disburse_on < "2027-10-01"));
  assert.equal(ESC.lineDisbursementDates({ ...lines[2]!, known_bills: [{ amount_cents: 40_000n, due_on: D("2027-10-01"), penalty_on: D("2027-10-31") }] }, yearStart, {})[0]!.on, "2027-10-31");
  const p = ESC.project(r.items, yearStart); assert.ok(p.base_payment_cents > 0n); assert.equal(p.annual_cents, r.items.reduce((s, i) => s + i.amount_cents, 0n));
});
