/** §13.1–13.9 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import * as G from "./gates.ts"; import * as R from "./referral.ts"; import * as T from "./timeframes.ts"; import * as F from "./firms.ts"; import * as L from "./litigation.ts"; import * as S from "./scra.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";

test("13.1-T1/T2/T3/T3a/T3b/T4/T5: 120-day gate, anchor movement, non-PR ladder, occupancy default, pre-filing gate", () => {
  assert.equal(G.gate120(D("2026-05-01"), D("2026-01-01"), true).state, "closed"); assert.equal(G.gate120(D("2026-05-02"), D("2026-01-01"), true).state, "open"); assert.equal(G.gate120(D("2026-05-02"), D("2026-01-01"), true).opens_on, "2026-05-02");
  assert.equal(G.gate120(D("2026-06-30"), D("2026-03-01"), true).state, "open"); assert.equal(G.gate120(D("2026-06-29"), D("2026-03-01"), true).state, "closed");
  const moved = G.gate120(D("2026-05-03"), D("2026-02-01"), true); assert.equal(moved.state, "closed"); assert.equal(moved.days, 91); assert.equal(moved.opens_on, "2026-06-02");
  assert.equal(G.gate120(D("2026-04-10"), D("2026-01-01"), false).state, "not_applicable"); assert.equal(G.gate120(D("2026-04-10"), D("2026-01-01"), null).state, "closed");
  assert.equal(G.nonPrDeadline(D("2026-01-01")), "2026-05-01");
  assert.deepEqual(G.ladderSuspension({ kind: "complete_brp", on: D("2026-04-30") }), { rung: "a_eval_30", resume_on: "2026-05-30" }); assert.deepEqual(G.ladderSuspension({ kind: "retention_offer", on: D("2026-05-11") }), { rung: "b_offer_14", resume_on: "2026-05-25" });
  assert.equal(G.ladderSuspension({ kind: "accepted_with_first_payment_due", on: D("2026-05-20"), first_payment_due: D("2027-02-01") })!.resume_on, "2027-02-28"); assert.equal(G.ladderSuspension({ kind: "first_payment_received", on: D("2027-02-10") })!.resume_on, "on_breach");
  assert.equal(G.ladderSuspension({ kind: "inquiry", on: D("2026-04-30") }), null); assert.equal(G.ladderSuspension({ kind: "incomplete_brp", on: D("2026-04-30") }), null);
  assert.equal(G.preFilingAppGate({ complete_app_before_first_notice: true, exit: null, duplicative_41i: false }), "closed"); assert.equal(G.preFilingAppGate({ complete_app_before_first_notice: true, exit: "ineligible_no_appeal", duplicative_41i: false }), "open"); assert.equal(G.preFilingAppGate({ complete_app_before_first_notice: true, exit: null, duplicative_41i: true }), "open");
});

test("13.2-T1/T3/T5/T8 and certification window: tiers at receipt, holds, Oct 19–27", () => {
  const t1 = G.tierAtReceipt(D("2026-09-25"), D("2026-11-03")); assert.equal(t1.regx, "g_37_to_89"); assert.equal(t1.days_before_sale, 39); assert.equal(t1.acceptance_days, 7); assert.equal(t1.appeal, false);
  const t3 = G.tierAtReceipt(D("2026-09-28"), D("2026-11-03")); assert.equal(t3.regx, "none"); assert.equal(t3.fnma, "fnma_15_to_37");
  assert.equal(G.tierAtReceipt(D("2026-09-01"), null).regx, "g_full_90");
  assert.equal(G.stepAllowed("judgment_motion", ["hold_evaluation"]), false); assert.equal(G.stepAllowed("service_of_process", ["hold_evaluation"]), true); assert.equal(G.stepAllowed("first_notice", ["hold_performing"]), false); assert.equal(G.stepAllowed("first_notice", ["hold_evaluation"]), true);
  assert.deepEqual(G.certificationWindow(D("2026-11-03")), { opens: "2026-10-19", closes: "2026-10-27" });
});

test("13.3-T5/T6/T7 and 13.4-T1: bid $281,509.46, reserve cases, surplus $8,490.54, review windows, gates", () => {
  const ti = R.totalIndebtedness({ upb_cents: cents("250000"), note_rate_pct: "6.50", lpi_due: D("2025-09-01"), sale_on: D("2026-11-03"), escrow_advances_cents: cents("6842.17"), corporate_advances_cents: cents("1975"), attorney_fees_cents: cents("2150"), costs_cents: cents("1487.50") });
  assert.equal(ti.days, 428); assert.equal(ti.interest_cents, cents("19054.79")); assert.equal(ti.total_cents, cents("281509.46"));
  assert.deepEqual(R.bid(ti.total_cents, cents("310000")), { opening_bid_cents: cents("281509.46"), max_bid_cents: cents("281509.46"), basis: "indebtedness" }); assert.equal(R.bid(ti.total_cents, cents("270000")).max_bid_cents, cents("270000")); assert.equal(R.bid(ti.total_cents, cents("310000"), true).opening_bid_cents, 10_000n);
  assert.equal(R.thirdPartySale(cents("290000"), ti.total_cents).surplus_cents, cents("8490.54"));
  assert.equal(R.reinstatementQuote({ delinquent_pi_cents: cents("8520.66"), late_charges_cents: cents("284.02"), escrow_advances_cents: cents("3105.40"), corporate_advances_cents: cents("60"), attorney_fees_cents: cents("1000"), costs_cents: cents("612") }), cents("13582.08"));
  const npr = R.reviewWindow(D("2026-03-01"), false); assert.deepEqual([npr.opens, npr.referral_on, npr.rule], ["2026-06-14", "2026-06-29", "refer_by"]); const pr = R.reviewWindow(D("2026-03-01"), true); assert.deepEqual([pr.opens, pr.referral_on], ["2026-06-15", "2026-06-30"]);
  assert.equal(R.reviewValid(D("2026-06-10"), npr), false); assert.equal(R.reviewValid(D("2026-06-20"), npr), true);
  const gates: R.Gates = { regx_120: true, regx_prefiling: true, no_first_filing_41k2: true, fnma_121: true, bk_stay: false, scra: false, dmdc_age_days: 31, disaster_approval: true, litigation_hold: false, environmental_hold: false, mn_dual_track: false, title_hold: false, package_ready: true };
  assert.deepEqual(R.referralEligible("refer", gates).blocked_by, ["SCRA_DMDC_STALE_30"]); assert.equal(R.referralEligible("refer", { ...gates, dmdc_age_days: 10 }).ok, true); assert.equal(R.referralEligible("hold_scra", { ...gates, dmdc_age_days: 10, scra: true }).ok, false);
  assert.equal(R.reviewOutcome({ items_all_pass: true, pr_prohibition_failing: false, disaster_impacted: true, nonpr_complete_brp: false, scra_active: false, bk_hit: false }), "hold_disaster_approval"); assert.equal(R.reviewOutcome({ items_all_pass: true, pr_prohibition_failing: false, disaster_impacted: false, nonpr_complete_brp: true, scra_active: false, bk_hit: false }), "postpone_e3204");
  assert.equal(R.firmAckDue(D("2026-06-30")), "2026-07-02");
});

test("13.5-T1/T2/T3: F-2-03 examples $3,461.64 and $0; NJ 993 days, credited 165, excess 18, exposure $840.82; NYC 2,190", () => {
  assert.equal(T.exposure({ lpi_due: D("2023-02-01"), sale_on: D("2025-10-14"), allowable: T.allowableDays("FL"), delays: [], upb_cents: cents("100000"), ptr_pct: "4.75" }).actual_days, 986);
  const ex1 = T.exposure({ lpi_due: D("2023-02-01"), sale_on: D("2025-10-14"), allowable: T.allowableDays("FL"), delays: [], upb_cents: cents("100000"), ptr_pct: "4.75" }); assert.equal(ex1.excess_days, 266); assert.equal(ex1.exposure_cents, cents("3461.64"));
  const ex2 = T.exposure({ lpi_due: D("2024-10-01"), sale_on: D("2025-12-02"), allowable: T.allowableDays("CO"), delays: [{ category: "contested", from: D("2025-03-01"), to: D("2025-03-31"), reported_timely: true }], upb_cents: cents("200000"), ptr_pct: "5.25" }); assert.equal(ex2.exposure_cents, 0n); assert.equal(ex2.status, "closed_within");
  const nj = T.exposure({ lpi_due: D("2024-05-01"), sale_on: D("2027-01-19"), allowable: T.allowableDays("NJ"), delays: [{ category: "bk13", from: D("2025-09-03"), to: D("2026-01-21"), reported_timely: true }, { category: "contested", from: D("2026-03-02"), to: D("2026-04-11"), reported_timely: true }], upb_cents: cents("310000"), ptr_pct: "5.50" });
  assert.deepEqual([nj.actual_days, nj.credited_days, nj.excess_days, nj.exposure_cents, nj.status], [993, 165, 18, cents("840.82"), "closed_over"]);
  assert.equal(T.creditedDays({ category: "bk13", from: D("2025-09-03"), to: D("2026-01-21"), reported_timely: false }).at_risk, true);
  assert.equal(T.allowableDays("NY", "Kings"), 2190); assert.equal(T.allowableDays("NY", "Westchester"), 1740); assert.equal(T.atRisk(700, 810, 165), true);
});

test("13.6-T1/T2/T3/T4/T6/T9: E&O tiers, Form 200 15 Fannie BD, invoice review ($450 / $450.75 / courier rejected), escalation 2 BD, transfer gate, tech fee cap", () => {
  assert.equal(F.eoTierOk(1, cents("1000000"), cents("2000000")), false); assert.equal(F.eoTierOk(1, cents("1000000"), cents("3000000")), true);
  assert.equal(F.form200Expectation(D("2026-09-10")), "2026-10-01");
  const inv = F.reviewInvoice({ method: "non_judicial", milestone: "first_legal", allowable_cents: cents("2250"), previously_paid_cents: cents("1462.50"), costs: [{ kind: "recording", cents: cents("38"), receipt: true }, { kind: "publication", cents: cents("412.75"), receipt: true }, { kind: "courier", cents: cents("22"), receipt: true }] });
  assert.equal(inv.fee_approved_cents, cents("450")); assert.equal(inv.costs_approved_cents, cents("450.75")); assert.equal(inv.rejected[0]!.kind, "courier");
  assert.equal(F.feeEarned("judicial", "service_complete", cents("2250")), cents("1575")); assert.equal(F.reviewInvoice({ method: "judicial", milestone: "sale_held", allowable_cents: cents("2250"), previously_paid_cents: 0n, costs: [], tech_fee_cents: cents("30") }).rejected[0]!.cents, cents("5"));
  assert.equal(F.escalationDue(D("2026-09-14")), "2026-09-16"); assert.equal(F.transferNoticeGate(30), true); assert.equal(F.transferNoticeGate(29), false); assert.equal(F.suspensionEffective(D("2026-09-14")), "2026-09-21");
  assert.equal(F.draEventLate(D("2026-09-14"), null, D("2026-09-17")), true); assert.equal(F.draEventLate(D("2026-09-14"), D("2026-09-15"), D("2026-09-17")), false);
});

test("13.7-T1/T2/T3/T4/T10: classification, Form 20 by Monday, holds, environmental, lead paint, low-confidence routine", () => {
  assert.deepEqual(L.classify({ damages_against_fnma: false, attacks_validity_priority_enforceability: true, enumerated_risk: false, damages_claim: false, confidence: 0.9 }), { classification: "non_routine", category: 2 });
  assert.equal(L.form20Due(D("2026-09-10")), "2026-09-14"); assert.equal(L.litigationHold({ category: 2, seeks_injunction: false, damages_only: false }), true); assert.equal(L.litigationHold({ category: 1, seeks_injunction: false, damages_only: true }), false);
  assert.equal(L.exceptionTrigger("standing", "answer"), false); assert.equal(L.exceptionTrigger("standing", "summary_judgment_motion"), true);
  assert.equal(L.environmental("suspected", D("2026-09-10")).confirm_by, "2026-09-20"); const c = L.environmental("confirmed", D("2026-09-10")); assert.equal(c.gate_closed, true); assert.equal(c.report_by, "2026-09-14");
  assert.equal(L.leadPaintNoticeDue(D("2026-06-30")), "2026-07-30"); assert.equal(L.classify({ damages_against_fnma: false, attacks_validity_priority_enforceability: false, enumerated_risk: false, damages_claim: true, confidence: 0.7 }).classification, "attorney_confirmation_required");
});

test("13.8-T2/T4/T11 and 13.9-T1/T2/T3/T4/T11: protection tail (calendar year, leap-crossing, Feb 29 clamp), DMDC freshness, subsidy recalculation $1,528.30 / $1,741.73 / $1,810.42 / $304.80 / $60.96", () => {
  assert.equal(S.protectionEndsOn(D("2027-02-28")), "2028-02-28"); assert.equal(S.fcGateClosed(D("2028-02-28"), D("2027-02-28"), false), true); assert.equal(S.fcGateClosed(D("2028-03-01"), D("2027-02-28"), false), false);
  assert.equal(S.protectionEndsOn(D("2027-06-01")), "2028-06-01"); assert.equal(S.fcGateClosed(D("2028-06-01"), D("2027-06-01"), false), true); assert.equal(S.fcGateClosed(D("2028-06-02"), D("2027-06-01"), false), false);
  assert.equal(S.protectionEndsOn(D("2028-02-29")), "2029-02-28");
  assert.equal(S.dmdcFresh(D("2026-05-30"), D("2026-06-30")), false); assert.equal(S.dmdcFresh(D("2026-06-01"), D("2026-06-30")), true);
  assert.equal(S.capEffectivePaymentDue(D("2026-03-15")), "2026-04-01"); assert.equal(S.capEffectivePaymentDue(D("2026-03-01")), "2026-04-01");
  const upb24 = balanceAfter(cents("300000"), "7.25", 360, 24); assert.equal(upb24, cents("293975.18"));
  const r = S.recalculate({ upb_cents: upb24, note_rate_pct: "7.25", pi_cents: cents("2046.53"), first_capped_due: D("2026-04-01"), first_n: 25, paid_at_note_rate_count: 5, remaining_term_after: 331 });
  assert.deepEqual([r.rows[0]!.interest_note_cents, r.rows[0]!.interest_capped_cents, r.rows[0]!.forgiven_cents, r.rows[0]!.principal_cents], [cents("1776.10"), cents("1469.88"), cents("306.22"), cents("270.43")]);
  assert.equal(r.rows[4]!.upb_before_cents, cents("292883.62")); assert.equal(r.forgiven_total_cents, cents("1528.30")); assert.equal(r.upb_after_cents, cents("292606.60"));
  assert.equal(r.next_payment_subsidy_cents, cents("1741.73")); assert.equal(r.next_payment_standard_cents, cents("1810.42")); assert.equal(r.fnma_differential_cents, cents("304.80")); assert.equal(S.servicingFee(r.upb_after_cents, "0.25"), cents("60.96"));
  assert.equal(S.armCappedRate("5.50"), "5.50"); assert.equal(S.armCappedRate("7.00"), "6.000");
  assert.equal(S.capEndsOn(D("2027-02-28")), "2028-02-28"); assert.equal(S.restorationInstallment(D("2028-02-28")), "2028-03-01"); assert.equal(S.capEndsOn(D("2027-06-01")), "2028-06-01");
  assert.equal(S.requestWithinStatute(D("2027-02-28"), D("2027-09-16")).statutory, false); assert.equal(S.requestWithinStatute(D("2027-02-28"), D("2027-09-16")).honored, true);
});
