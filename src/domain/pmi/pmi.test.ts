/**
 * §10 calculator and worked-figure tests (schedules, thresholds, clocks). The spec's T-numbered acceptance tests
 * live in the 10-<n>.spec.test.ts files, one node:test per T-id named exactly as the spec.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as d, addMonths } from "../../kernel/calendar/date.ts";
import { cents, ratePercent } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { applyFifo, type AppliedInstallment } from "../boarding/delinquency.ts";
import {
  buildSchedule, scheduledDateForPct, armResetVersion, midpoint, scheduledUpb,
  originalValue, ltvBps, bpsToPercent, evaluationUpb, currentValueThresholdBps, seasoningMonths, paymentHistory, valueCheck, valuationValidUntil, decisionDue, evaluateCancellation, setOriginalValueAllowed, smduLiabilityRelief,
  rule78Applies, isCurrent, notCurrentGrounds, becameCurrentOn, automaticTermination, finalizationClocks, pendingTriggerDate, lpmiOptionsNoticeDue, legacyBoardingTermination,
  annualDisclosureApplies, disclosureTemplate, disclosurePlan, disclosureChannel,
  unearnedEstimate, refundClocks, reconcileInsurerRefund, refundLegs, refundApplicationAllowed, lookbackShortfall, returnedAchCheckDue,
  denialDue, ltvDenialContent, historyRenewalDate, valuationDenialWindows, disputeRoute, humanReviewDue, denialSendAllowed,
} from "./index.ts";

const RATE = ratePercent("6.5");
const OV = cents("400000");
const SCHED = buildSchedule({ upb_cents: cents("380000"), annual_rate: RATE, term_months: 360, first_due: d("2024-05-01") });
const PITI = cents("2401.86");

/** Installments from 2024-05-01 paid on the given dates (default on time). */
function ledger(count: number, paid: Record<string, string | null> = {}, through: string = "2099-01-01"): readonly AppliedInstallment[] {
  const inst = Array.from({ length: count }, (_, i) => ({ due_date: addMonths(d("2024-05-01"), i), amount_cents: PITI }));
  const pays = inst.flatMap((i) => {
    if (i.due_date > d(through)) return [];
    const p = paid[i.due_date];
    if (p === null) return [];
    return [{ received_on: p ? d(p) : i.due_date, amount_cents: PITI }];
  });
  return applyFifo(inst, pays).installments;
}

test("10.1 worked schedule: P&I 2,401.86; 80% at payment 124 (2034-08-01, $319,500.09); 78% at 135 (2035-07-01, $311,913.25); payment 180 $275,724.30", () => {
  assert.equal(SCHED.pi_cents, PITI);
  const p80 = scheduledDateForPct(SCHED, OV, 80)!, p78 = scheduledDateForPct(SCHED, OV, 78)!;
  assert.deepEqual([p80.n, p80.due_date, p80.upb_after_cents], [124, d("2034-08-01"), cents("319500.09")]);
  assert.deepEqual([p78.n, p78.due_date, p78.upb_after_cents], [135, d("2035-07-01"), cents("311913.25")]);
  assert.equal(SCHED.rows[179]!.upb_after_cents, cents("275724.30"));
  assert.equal(scheduledUpb(SCHED, d("2034-08-15")), cents("319500.09"));
});

test("10.1 calculators: 2027-07-10 request with UPB $335,548.68 → 8388 bps, LTV_ABOVE_THRESHOLD, denial due 2027-08-09", () => {
  assert.equal(originalValue({ sales_price_cents: OV, appraised_value_cents: cents("410000"), is_refinance: false, state: "TX" }), OV);
  assert.equal(originalValue({ sales_price_cents: OV, appraised_value_cents: cents("410000"), is_refinance: false, state: "NY" }), cents("410000"));
  assert.equal(ltvBps(cents("335548.68"), OV), 8388);
  assert.equal(bpsToPercent(8388), "83.88");
  const r = evaluateCancellation({
    received_on: d("2027-07-10"), decision_on: d("2027-07-13"), evidence_satisfied_on: null, path: "original_value", property_class: "1u_principal_or_second", hpa_covered: true,
    original_value_cents: OV, valuation_cents: null, valuation_delivered_on: null, evaluation_upb_cents: cents("335548.68"), threshold_reached_on: null,
    installments: ledger(40, {}, "2027-07-01"), avm_cents: null, consummation: d("2024-03-15"),
  });
  assert.equal(r.result, "ineligible"); assert.deepEqual(r.reasons, ["LTV_ABOVE_THRESHOLD"]); assert.equal(r.ltv_bps, 8388); assert.equal(r.decision_due, d("2027-08-09"));
});

test("10.1 calculators: 2029-07-10 request: UPB $319,950.95 → 7998 bps, clean history, AVM $455,000 → eligible effective 2029-07-10, code 51", () => {
  const led = ledger(70, { "2029-06-01": "2029-06-14" }, "2029-07-01");
  const r = evaluateCancellation({
    received_on: d("2029-07-10"), decision_on: d("2029-07-15"), evidence_satisfied_on: null, path: "original_value", property_class: "1u_principal_or_second", hpa_covered: true,
    original_value_cents: OV, valuation_cents: null, valuation_delivered_on: null, evaluation_upb_cents: cents("319950.95"), threshold_reached_on: d("2029-07-01"),
    installments: led, avm_cents: cents("455000"), consummation: d("2024-03-15"),
  });
  assert.equal(r.result, "eligible"); assert.equal(r.ltv_bps, 7998); assert.equal(r.effective_on, d("2029-07-10")); assert.equal(r.lar89_action_code, "51");
  assert.equal(r.decision_due, d("2029-08-09"));
});

test("10.1 calculators: 30-day late (2028-10-01 paid 2028-11-05) in window B → PAYMENT_HISTORY_30_12M; disaster-attributable → excluded", () => {
  const led = ledger(70, { "2028-10-01": "2028-11-05", "2028-11-01": "2028-11-05" }, "2029-07-01");   // both paid 11-05 (FIFO: Oct satisfied 35 days late)
  const h = paymentHistory(led, d("2029-07-10"));
  assert.equal(h.reason, "PAYMENT_HISTORY_30_12M"); assert.equal(h.offending[0]!.days_late, 35); assert.equal(h.late30_12m, 1);
  assert.ok(paymentHistory(led, d("2029-07-10"), new Set([d("2028-10-01")])).ok);
  // 60-day late in window A only
  const led2 = ledger(70, { "2027-10-01": "2027-12-05", "2027-11-01": "2027-12-05", "2027-12-01": "2027-12-05" }, "2029-07-01");
  assert.equal(paymentHistory(led2, d("2029-07-10")).reason, "PAYMENT_HISTORY_60_24M");
  assert.ok(paymentHistory(ledger(70, { "2027-10-01": "2027-11-15", "2027-11-01": "2027-11-15" }, "2029-07-01"), d("2029-07-10")).ok);   // 45-day late in window A is fine
});

test("10.1 calculators: value check, 2-unit 70% threshold, valuation validity", () => {
  const vc = valueCheck(cents("395000"), OV, 1);
  assert.equal(vc.status, "value_check_needed");
  assert.equal(vc.status === "value_check_needed" && vc.options[0]!.fee_cents, 19_000n);
  assert.equal(valueCheck(cents("412000"), OV, 1).status, "value_not_declined");
  const r = evaluateCancellation({
    received_on: d("2029-07-10"), decision_on: d("2029-07-15"), evidence_satisfied_on: null, path: "original_value", property_class: "2_4u_principal", hpa_covered: false,
    original_value_cents: OV, valuation_cents: null, valuation_delivered_on: null, evaluation_upb_cents: cents("288000"), threshold_reached_on: null,
    installments: ledger(70, {}, "2029-07-01"), avm_cents: cents("455000"), consummation: d("2024-03-15"),
  });
  assert.equal(r.result, "ineligible"); assert.equal(r.threshold_bps, 7000); assert.equal(r.ltv_bps, 7200);
  assert.equal(valuationValidUntil(d("2026-09-03")), d("2027-01-01"));
});

test("10.1 current-value worked example: seasoning 29 months → 75%; BPO $500,000 → 74.10% eligible code 52; $490,000 → 75.62% denial due 2026-10-03", () => {
  assert.equal(seasoningMonths(d("2024-03-15"), d("2026-08-20")), 29);
  assert.equal(currentValueThresholdBps("1u_principal_or_second", 29, false), 7500);
  assert.equal(currentValueThresholdBps("1u_principal_or_second", 60, false), 8000);
  assert.equal(currentValueThresholdBps("2_4u_principal", 24, false), 7000);
  const base = {
    received_on: d("2026-08-20"), decision_on: d("2026-09-05"), evidence_satisfied_on: d("2026-08-24"), path: "current_value" as const, property_class: "1u_principal_or_second" as const, hpa_covered: true,
    original_value_cents: OV, valuation_delivered_on: d("2026-09-03"), evaluation_upb_cents: cents("370522.40"), threshold_reached_on: null,
    installments: ledger(30, {}, "2026-08-01"), avm_cents: null, consummation: d("2024-03-15"),
  };
  const ok = evaluateCancellation({ ...base, valuation_cents: cents("500000") });
  assert.equal(ok.result, "eligible"); assert.equal(bpsToPercent(ok.ltv_bps), "74.10"); assert.equal(ok.lar89_action_code, "52"); assert.equal(ok.effective_on, d("2026-09-03"));
  const no = evaluateCancellation({ ...base, valuation_cents: cents("490000") });
  // 370,522.40 / 490,000 = 75.6168% → floored to 7561 bps per R3; the spec's "75.62%" rounds (audit note).
  assert.equal(no.result, "ineligible"); assert.equal(bpsToPercent(no.ltv_bps), "75.61"); assert.deepEqual(no.reasons, ["LTV_ABOVE_THRESHOLD_CURRENT"]);
  assert.equal(denialDue({ received_on: d("2026-08-20"), evidence_satisfied_on: d("2026-09-03"), scheduled_termination_on: null, state: "TX" }), d("2026-10-03"));
});

test("10.1 calculators: curtailment effective date; original-value evidence; SMDU override", () => {
  const r = evaluateCancellation({
    received_on: d("2029-07-10"), decision_on: d("2029-07-20"), evidence_satisfied_on: null, path: "original_value", property_class: "1u_principal_or_second", hpa_covered: true,
    original_value_cents: OV, valuation_cents: null, valuation_delivered_on: null, evaluation_upb_cents: cents("319600"), threshold_reached_on: d("2029-07-15"),
    installments: ledger(70, {}, "2029-07-01"), avm_cents: cents("455000"), consummation: d("2024-03-15"),
  });
  assert.equal(r.effective_on, d("2029-07-15"));
  assert.equal(setOriginalValueAllowed(null), false);
  assert.equal(smduLiabilityRelief(["late30_12m"]), false);
  assert.equal(decisionDue(d("2026-08-27"), d("2026-09-25")), d("2026-10-25"));   // evidence re-anchor
});

// ---- 10.2 / 10.3 -----------------------------------------------------------------

test("10.2 worked scenarios A/B/C at scheduled_78_date 2035-07-01 (and the midpoint-only property)", () => {
  const n = 140;
  const a = automaticTermination(ledger(n, { "2035-06-01": "2035-06-12" }, "2035-07-01"), d("2035-07-01"));
  assert.equal(a.status, "terminated");
  if (a.status === "terminated") {
    assert.deepEqual(a.clocks.lar89, { code: "53", action_date: "070135" });
    assert.equal(a.clocks.notice_due, d("2035-07-31")); assert.equal(a.clocks.refund_due, d("2035-08-15")); assert.equal(a.clocks.insurer_notice_due, d("2035-07-03"));
  }
  const b = automaticTermination(ledger(n, { "2035-06-01": "2035-07-08", "2035-07-01": "2035-07-20" }, "2035-07-01"), d("2035-07-01"));
  assert.equal(b.status, "deferred_not_current");
  if (b.status === "deferred_not_current") {
    assert.deepEqual(b.grounds, [d("2035-06-01")]); assert.equal(b.not_current_notice_due, d("2035-07-31"));
    assert.equal(b.cure_on, d("2035-07-20")); assert.equal(b.cure_effective, d("2035-08-01")); assert.equal(b.clocks!.lar89.action_date, "080135");
  }
  const c = automaticTermination(ledger(n, { "2035-06-01": "2035-07-08", "2035-07-01": "2035-08-03" }, "2035-08-01"), d("2035-07-01"));
  assert.equal(c.status === "deferred_not_current" && c.cure_effective, d("2035-09-01"));
  assert.equal(automaticTermination(ledger(n), d("2035-07-01"), false).status, "not_applicable_midpoint_only");   // midpoint-only property
});

test("10.2 calculators: ARM reset at payment 61 to 7.50% → 78% moves from 2034-07-01 to 2035-09-01", () => {
  const arm = buildSchedule({ upb_cents: cents("380000"), annual_rate: ratePercent("5.5"), term_months: 360, first_due: d("2024-05-01") });
  assert.equal(arm.pi_cents, cents("2157.60"));
  assert.equal(scheduledDateForPct(arm, OV, 78)!.due_date, d("2034-07-01"));
  assert.equal(arm.rows[59]!.upb_after_cents, cents("351350.17"));
  const reset = armResetVersion(arm, 61, ratePercent("7.5"), 300);
  assert.equal(reset.pi_cents, cents("2596.45"));
  assert.deepEqual([reset.kind, scheduledDateForPct(reset, OV, 78)!.n, scheduledDateForPct(reset, OV, 78)!.due_date], ["arm_reset", 137, d("2035-09-01")]);
});

test("10.2/10.3 calculators: Flex Mod: 78% at payment 218 (2047-03-01); midpoint termination 2049-02-01", () => {
  const mod = buildSchedule({ upb_cents: cents("320000"), annual_rate: RATE, term_months: 480, first_due: d("2029-02-01"), forborne_principal_cents: cents("50000") }, "modification");
  assert.equal(mod.pi_cents, cents("1873.46"));
  assert.deepEqual([scheduledDateForPct(mod, OV, 78)!.n, scheduledDateForPct(mod, OV, 78)!.due_date], [218, d("2047-03-01")]);
  const m = midpoint(d("2029-02-01"), 480);
  assert.equal(m.midpoint_termination_date, d("2049-02-01"));
  assert.equal(pendingTriggerDate(d("2047-03-01"), m.midpoint_termination_date, true), d("2047-03-01"));
});

test("10.3 calculators: IO 10/20: 78% at payment 192 (2040-04-01) is after midpoint → trigger 2039-05-01; 15-year → 2031-11-01", () => {
  const io = buildSchedule({ upb_cents: cents("380000"), annual_rate: RATE, term_months: 240, io_months: 120, first_due: d("2024-05-01") });
  assert.equal(io.pi_cents, cents("2833.18"));
  assert.equal(scheduledDateForPct(io, OV, 78)!.due_date, d("2040-04-01"));
  const m = midpoint(d("2024-05-01"), 360);
  assert.deepEqual(m, { amortization_start: d("2024-04-01"), midpoint_date: d("2039-04-01"), midpoint_termination_date: d("2039-05-01") });
  assert.equal(pendingTriggerDate(d("2040-04-01"), m.midpoint_termination_date, true), d("2039-05-01"));
  assert.equal(midpoint(d("2024-05-01"), 180).midpoint_termination_date, d("2031-11-01"));
  assert.equal(midpoint(d("2024-05-01"), 181).midpoint_termination_date, d("2031-12-01"));   // odd term: floor + 15 days → following month
});

test("10.3 calculators: 2-unit loan: midpoint 2036-03-01 → termination 2036-04-01; leap-year February test; late March paid 04-09 → 2036-05-01", () => {
  const m = midpoint(d("2021-04-01"), 360);
  assert.equal(m.midpoint_termination_date, d("2036-04-01"));
  assert.equal(rule78Applies({ consummation: d("2021-03-10"), units: 2, occupancy_at_origination: "principal" }), false);
  const inst = Array.from({ length: 200 }, (_, i) => ({ due_date: addMonths(d("2021-04-01"), i), amount_cents: PITI }));
  const mk = (paid: Record<string, string>) => applyFifo(inst, inst.filter((i) => i.due_date <= d("2036-04-01")).map((i) => ({ received_on: paid[i.due_date] ? d(paid[i.due_date]!) : i.due_date, amount_cents: PITI }))).installments;
  const ok = mk({ "2036-02-01": "2036-03-05", "2036-03-01": "2036-03-28" });
  assert.ok(!isCurrent(ok, d("2036-04-01")) === false);
  const r = automaticTermination(ok, d("2036-04-01"));
  assert.equal(r.status === "terminated" && r.clocks.lar89.action_date, "040136");
  assert.equal(r.status === "terminated" && r.clocks.refund_due, d("2036-05-16"));
  const late = mk({ "2036-02-01": "2036-03-05", "2036-03-01": "2036-04-09" });
  assert.deepEqual(notCurrentGrounds(late, d("2036-04-01")), [d("2036-03-01")]);
  const r2 = automaticTermination(late, d("2036-04-01"));
  assert.equal(r2.status === "deferred_not_current" && r2.cure_effective, d("2036-05-01"));
  assert.equal(becameCurrentOn(late, d("2036-04-01")), d("2036-04-09"));
});

test("10.2/10.3 calculators: LPMI options notice; legacy boarding termination", () => {
  assert.equal(lpmiOptionsNoticeDue(d("2035-07-01")), d("2035-07-31"));
  assert.deepEqual(legacyBoardingTermination(d("2014-01-01"), d("2026-10-01"), true, true), { terminate_on: d("2026-10-01"), escalate_officer: true, sentinel_exception: "self-identified HPA exception (prior servicer period)", restitution_review: true });
  assert.equal(legacyBoardingTermination(d("2030-01-01"), d("2026-10-01"), true, true), null);
  assert.equal(finalizationClocks(d("2031-08-01"), "51").escrow_interim_analysis_due, d("2031-08-15"));
});

// ---- 10.4 -----------------------------------------------------------------------

test("10.4 calculators: disclosure cadence: last sent 2026-03-15, escrow statement 2027-02-20 → attached, next due 2028-02-20; null last-sent → boarding + 60", () => {
  const p = disclosurePlan({ last_sent: d("2026-03-15"), boarded_on: d("2026-10-01"), escrow_statement_on: d("2027-02-20"), form_1098_on: d("2027-01-25") });
  assert.deepEqual(p, { next_due: d("2027-03-15"), send_on: d("2027-02-20"), included_with: "escrow_statement" });
  assert.equal(disclosurePlan({ last_sent: d("2027-02-20"), boarded_on: d("2026-10-01"), escrow_statement_on: null, form_1098_on: null }).next_due, d("2028-02-20"));
  const standalone = disclosurePlan({ last_sent: d("2026-03-15"), boarded_on: d("2026-10-01"), escrow_statement_on: d("2027-04-05"), form_1098_on: null });
  assert.deepEqual([standalone.included_with, standalone.send_on], ["standalone", d("2027-02-28")]);
  assert.equal(disclosurePlan({ last_sent: null, boarded_on: d("2026-10-01"), escrow_statement_on: null, form_1098_on: null }).send_on, d("2026-11-30"));
  assert.equal(annualDisclosureApplies("lpmi", "active"), false);
  assert.equal(disclosureTemplate(d("1998-11-15")), "annual_b_legacy");
  assert.equal(disclosureChannel(false), "mail");
});

// ---- 10.5 -----------------------------------------------------------------------

test("10.5 calculators: annual plan E=2031-08-01: estimate $1,411.73; insurer transfer due 09-03; borrower refund due 09-15", () => {
  assert.equal(unearnedEstimate({ kind: "annual", premium_cents: cents("2280"), anniversary_start: d("2031-03-15") }, d("2031-08-01")), cents("1411.73"));
  const c = refundClocks(d("2031-08-01"), d("2031-08-04"));
  assert.equal(c.insurer_transfer_due, d("2031-09-03")); assert.equal(c.borrower_refund_due, d("2031-09-15")); assert.equal(c.insurer_notice_due, d("2031-08-05"));
  assert.deepEqual(reconcileInsurerRefund(cents("1411.73"), cents("1411.73"), false), { status: "matched", pay_borrower_cents: cents("1411.73"), variance_cents: 0n });
});

test("10.5 calculators: monthly estimate $114; advance at E+40; dispute pays higher at day 40; LPMI legs; look-back shortfall; offset refused; R03", () => {
  assert.equal(unearnedEstimate({ kind: "monthly", premium_cents: cents("190"), coverage_month_start: d("2031-08-01") }, d("2031-08-13")), cents("114"));
  const c = refundClocks(d("2031-08-13"), d("2031-08-14"));
  assert.equal(c.advance_if_unfunded_by, d("2031-09-22")); assert.equal(c.borrower_refund_due, d("2031-09-27"));
  const dsp = reconcileInsurerRefund(cents("1411.73"), cents("1380"), true);
  assert.equal(dsp.status, "disputed"); assert.equal(dsp.pay_borrower_cents, cents("1411.73")); assert.equal(dsp.variance_cents, -cents("31.73"));
  assert.deepEqual(refundLegs("lpmi"), ["corporate_income"]);
  assert.equal(lookbackShortfall(d("2031-08-01"), d("2031-09-20"), 45, Decimal.ratio(228000n, 365n)), cents("31.23"));   // 5 days × 624.66
  assert.equal(refundApplicationAllowed("late_charges", null, d("2031-08-13")), false);
  assert.ok(refundApplicationAllowed("late_charges", d("2031-08-20"), d("2031-08-13")));
  assert.equal(returnedAchCheckDue(d("2031-08-15")), d("2031-08-22"));
  assert.equal(unearnedEstimate({ kind: "single", premium_cents: cents("7600"), refund_pct: "0.35" }, d("2031-08-13")), cents("2660"));
});

// ---- 10.6 -----------------------------------------------------------------------

test("10.6 calculators: denial content and due dates", () => {
  assert.equal(denialDue({ received_on: d("2027-07-10"), evidence_satisfied_on: null, scheduled_termination_on: null, state: "TX" }), d("2027-08-09"));
  const c = ltvDenialContent({ evaluation_upb_cents: cents("335548.68"), value_cents: OV, ltv_bps: 8388, threshold_bps: 8000, scheduled_80_date: d("2034-08-01") });
  assert.deepEqual([c.evaluation_upb, c.value, c.ltv_percent, c.threshold_percent, c.balance_needed], ["$335,548.68", "$400,000.00", "83.88%", "80.00%", "$320,000.00"]);
  assert.equal(historyRenewalDate(d("2028-11-05")), d("2029-11-06"));
  assert.deepEqual(valuationDenialWindows(d("2026-09-03")), { appeal_by: d("2026-11-02"), valid_until: d("2027-01-01") });
  assert.equal(ltvDenialContent({ evaluation_upb_cents: cents("370522.40"), value_cents: cents("490000"), ltv_bps: 7562, threshold_bps: 7500, scheduled_80_date: null }).balance_needed, "$367,500.00");
  assert.equal(denialDue({ received_on: null, evidence_satisfied_on: null, scheduled_termination_on: d("2035-07-01"), state: "TX" }), d("2035-07-31"));   // automatic prong
  assert.equal(denialDue({ received_on: d("2026-09-01"), evidence_satisfied_on: d("2026-09-20"), scheduled_termination_on: null, state: "MN" }), d("2026-10-01"));   // MN prong
});

test("10.6 calculators: dispute routing, human review, evaluation link", () => {
  assert.deepEqual(disputeRoute({ asserts_error: true, valuation_disagreement: false, requests_human: false }), ["noe"]);
  assert.equal(humanReviewDue(d("2027-07-20")), d("2027-08-03"));
  assert.equal(denialSendAllowed(null), false);
  assert.equal(evaluationUpb({ upb_cents: 100n, deferred_principal_cents: 10n, forborne_principal_cents: 5n }), 115n);
});
