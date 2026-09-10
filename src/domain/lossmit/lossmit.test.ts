/** §12.1–12.9 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import * as AP from "./application.ts"; import * as EV from "./evaluation.ts"; import * as PL from "./plans.ts"; import * as DF from "./deferral.ts"; import * as FM from "./flexmod.ts"; import * as LQ from "./liquidation.ts";

test("12.1-T1/T2/T3/T5/T6/T7: ack due (Labor Day, Thanksgiving), reasonable date caps and floor, 45-day test, duplicative", () => {
  assert.equal(AP.ackDue(D("2026-09-10")).due_on, "2026-09-17"); assert.equal(AP.ackDue(D("2026-11-20")).due_on, "2026-11-30");
  const rd = AP.reasonableDate({ ack_sent_on: D("2026-09-15"), earliest_unpaid_due: D("2026-08-01"), sale_on: D("2027-01-15"), oldest_doc_date: D("2026-08-20") }); assert.equal(rd.date, "2026-10-15"); assert.equal(rd.milestone_conflict, false);
  assert.equal(AP.reasonableDate({ ack_sent_on: D("2026-09-15"), earliest_unpaid_due: D("2026-08-01"), sale_on: D("2026-11-20"), oldest_doc_date: null }).date, "2026-10-13");
  const fl = AP.reasonableDate({ ack_sent_on: D("2026-10-08"), earliest_unpaid_due: D("2026-08-01"), sale_on: D("2026-11-20"), oldest_doc_date: null }); assert.equal(fl.date, "2026-10-15"); assert.equal(fl.milestone_conflict, true);
  assert.deepEqual(AP.fortyFiveDayTest(D("2026-09-10"), D("2026-10-20")), { b2_applies: false, d2205_notice_due: "2026-09-17" }); assert.equal(AP.fortyFiveDayTest(D("2026-09-10"), D("2027-01-15")).b2_applies, true);
  assert.equal(AP.duplicative({ prior_complete_by_us: true, prior_fully_processed: true, current_since_prior: false }), true); assert.equal(AP.duplicative({ prior_complete_by_us: true, prior_fully_processed: true, current_since_prior: true }), false);
  assert.equal(AP.classify({ has_evaluative_info: false, confidence: 0.7 }), "application"); assert.equal(AP.classify({ has_evaluative_info: false, confidence: 0.95 }), "rfa_only");
  assert.deepEqual(AP.completeness([{ item: "710", source: "borrower", status: "received" }, { item: "bank_statements", source: "borrower", status: "missing" }, { item: "bpo", source: "third_party", status: "missing" }]).missing, ["bank_statements"]);
});

test("12.2-T1/T2/T4/T7/T9 and 12.3-T1/T5/T6/T7/T9: tiers, deadlines, ranking reason, appeals", () => {
  assert.equal(EV.tier(D("2026-10-07"), null), "ge_90"); assert.equal(EV.tier(D("2026-11-01"), D("2027-01-15")), "lt_90"); assert.equal(EV.tier(D("2026-12-20"), D("2027-01-15")), "le_37");
  const d = EV.evaluationDeadlines(D("2026-10-07"), D("2026-11-02"), "ge_90"); assert.deepEqual([d.decision_due, d.accept_by, d.appeal_rights, d.deemed_rejected_on], ["2026-11-06", "2026-11-16", true, "2026-11-21"]);
  assert.equal(EV.evaluationDeadlines(D("2026-10-07"), D("2026-11-02"), "ge_90", "NY").accept_by, "2026-12-02"); assert.equal(EV.evaluationDeadlines(D("2026-11-01"), D("2026-11-20"), "lt_90").accept_by, "2026-11-27");
  assert.equal(EV.fnmaNoticeCheck(D("2026-10-30"), D("2026-11-02")), true);
  assert.equal(EV.rankingReasonAllowed("payment_deferral", "flex_mod"), true); assert.equal(EV.rankingReasonAllowed("flex_mod", "payment_deferral"), false);
  assert.equal(EV.hierarchyWalk({ can_reinstate: false, hardship_temporary_unresolved: false, can_afford_repayment: false, deferral_eligible: true, flexmod_eligible: true }).offered, "payment_deferral");
  assert.equal(EV.appealEligible("ge_90", true, true), true); assert.equal(EV.appealEligible("lt_90", true, true), false); assert.equal(EV.appealEligible("lt_90", false, true), true);
  assert.equal(EV.appealWindow(D("2026-11-02")), "2026-11-16"); assert.equal(EV.appealWindow(D("2026-11-02"), "CA"), "2026-12-02"); assert.equal(EV.appealWindow(D("2026-11-02"), "NY", D("2026-11-03")), "2026-11-17");
  assert.deepEqual(EV.appealDeadlines(D("2026-11-12"), D("2026-12-08")), { decision_due: "2026-12-12", accept_by: "2026-12-22" }); assert.equal(EV.appealDeadlines(D("2026-10-28"), undefined, D("2026-11-01")).decision_due, "2026-12-01");
  assert.equal(EV.tppFirstDue(D("2026-12-08")), "2027-01-01"); assert.equal(EV.tppFirstDue(D("2026-12-16")), "2027-02-01"); assert.equal(EV.tppFirstDue(D("2026-12-15")), "2027-01-01");
  assert.deepEqual(EV.caHolds(D("2026-11-02"), D("2026-12-08")), { no_nod_before: "2026-12-03", after_appeal_denial_before: "2026-12-23" });
  assert.equal(EV.independent("rev-1", ["rev-1", "rev-2"]), false);
});

test("12.4-T1/T2/T3/T8: forbearance 3+3+3 caps, one-month fourth term, short-term boundary, MBS maturity", () => {
  const t1 = PL.forbearanceTerm({ requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2 }); assert.equal(t1.months, 3); assert.deepEqual(PL.forbearanceTermDates(D("2026-10-01"), 3), { start: "2026-10-01", end: "2026-12-31" });
  assert.equal(PL.forbearanceTerm({ requested_months: 3, cumulative_months: 3, months_delinquent_at_start: 5 }).months, 3); assert.equal(PL.forbearanceTerm({ requested_months: 3, cumulative_months: 6, months_delinquent_at_start: 8 }).months, 3);
  const t4 = PL.forbearanceTerm({ requested_months: 3, cumulative_months: 9, months_delinquent_at_start: 11 }); assert.equal(t4.months, 1); assert.ok(t4.capped_by.includes("delinquency_12")); assert.equal(t4.exception_required, true);
  assert.equal(PL.forbearanceTerm({ requested_months: 2, cumulative_months: 9, months_delinquent_at_start: 11 }).exception_required, true);
  assert.equal(PL.regxShortTermForbearance(6), true); assert.equal(PL.regxShortTermForbearance(9), false);
  assert.equal(PL.forbearanceTerm({ requested_months: 3, cumulative_months: 0, months_delinquent_at_start: 2, mbs_months_to_maturity: 1 }).months, 1);
  assert.equal(PL.preExpiryOutreachStart(D("2026-12-31")), "2026-12-01");
});

test("12.5-T1/T6: repayment plan 6 months rejected (151.0%), 8 accepted (138.25%), capacity → ineligible; Reg X short-term", () => {
  const six = PL.repaymentTerms(cents("6426"), cents("2100"), 6); assert.equal(six.installment_cents, 107_100n); assert.equal(six.pct_of_contractual, "151.00"); assert.equal(six.allowed, false);
  const eight = PL.repaymentTerms(cents("6426"), cents("2100"), 8); assert.equal(eight.installment_cents, 80_325n); assert.equal(eight.total_monthly_cents, cents("2903.25")); assert.equal(eight.pct_of_contractual, "138.25"); assert.equal(eight.allowed, true);
  assert.equal(eight.installment_cents * 7n + eight.final_installment_cents, cents("6426"));
  const plan = PL.repaymentPlan(cents("6426"), cents("2100")); assert.ok(plan.eligible && plan.terms.months === 7 || (plan.eligible && plan.terms.months <= 8));
  const cap = PL.repaymentPlan(cents("6426"), cents("2100"), cents("2500")); assert.equal(cap.eligible, false); if (!cap.eligible) assert.equal(cap.next, "payment_deferral");
  const st = PL.repaymentPlan(cents("6300"), cents("2100"), cents("5000")); if (st.eligible) assert.equal(st.regx_short_term, true);
});

test("12.6-T1/T2/T3/T5 and 12.7-T2/T4/T8: deferral screen, NIB $7,370.68 and $16,521.53, new payment $2,131.17, processing month", () => {
  const ok = DF.screen({ months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 0, months_to_maturity: 348 }); assert.deepEqual(ok, { eligible: true, contractual_payment_required: false, months_deferred: 4 });
  assert.equal(DF.screen({ months_delinquent: 1, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 0, months_to_maturity: 348 }).eligible, false); assert.equal(DF.screen({ months_delinquent: 7, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 0, months_to_maturity: 348 }).eligible, false);
  const six = DF.screen({ months_delinquent: 6, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 0, months_to_maturity: 348 }); assert.ok(six.eligible && six.contractual_payment_required);
  assert.equal(DF.screen({ months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), prior_deferral_effective: D("2025-11-01"), cumulative_deferred_months: 4, months_to_maturity: 348 }).eligible, false);
  assert.equal(DF.screen({ months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), prior_deferral_effective: D("2025-11-01"), prior_deferral_was_disaster: true, cumulative_deferred_months: 0, months_to_maturity: 348 }).eligible, true);
  const capped = DF.screen({ months_delinquent: 4, origination_date: D("2021-10-01"), evaluation_date: D("2026-09-20"), cumulative_deferred_months: 9, months_to_maturity: 348 }); assert.ok(capped.eligible && capped.contractual_payment_required && capped.months_deferred === 3);
  assert.equal(DF.nib(cents("1580.17"), 4, cents("1050"), 0n), cents("7370.68")); assert.deepEqual(DF.newPayment(cents("1580.17"), cents("520"), cents("1860")), { shortage_monthly_cents: 3_100n, payment_cents: cents("2131.17") });
  const tl = DF.timeline(D("2026-09-20"), D("2026-09-22")); assert.equal(tl.processing_month, true); assert.equal(tl.entry_deadline, "2026-10-31"); assert.equal(tl.effective, "2026-11-01");
  const tl2 = DF.timeline(D("2026-09-10")); assert.deepEqual([tl2.processing_month, tl2.entry_deadline, tl2.lar_deadline, tl2.effective], [false, "2026-09-30", "2026-09-29", "2026-10-01"]);
  assert.equal(DF.screen({ months_delinquent: 9, origination_date: D("2021-10-01"), evaluation_date: D("2026-12-20"), cumulative_deferred_months: 0, months_to_maturity: 300, disaster: { delinquency_months_at_disaster: 0, same_event_deferred_before: false } }).eligible, true);
  assert.equal((DF.screen({ months_delinquent: 3, origination_date: D("2021-10-01"), evaluation_date: D("2026-12-20"), cumulative_deferred_months: 0, months_to_maturity: 300, disaster: { delinquency_months_at_disaster: 2, same_event_deferred_before: false } }) as { next: string }).next, "fnma_prior_approval");
  assert.equal(DF.nib(cents("1580.17"), 9, cents("2300"), 0n), cents("16521.53")); assert.equal(DF.newPayment(cents("1580.17"), cents("520"), cents("2400")).shortage_monthly_cents, 4_000n);
});

test("12.8-T1/T2/T3/T4/T5: Flex Mod waterfall worked example, cap (c), P&I rule, trial timing and month-end test", () => {
  assert.equal(FM.balanceAfter(cents("250000"), "6.500", 360, 51), cents("236765.47"));
  assert.equal(FM.accruedInterest(cents("236765.47"), "6.500", 8), cents("10259.84"));
  const w = FM.waterfall({ ib_upb_cents: cents("236765.47"), accrued_interest_cents: cents("10259.84"), escrow_advances_cents: cents("4200"), servicing_advances_cents: cents("180"), prior_nib_cents: 0n, value_cents: cents("290000"), contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 309, pre_mod_pi_cents: cents("1580.17"), mir_pct: "6.625", delinquent_31_plus: true });
  assert.deepEqual([w.gross_upb_cents, w.mtmltv, w.rate_pct, w.term_months, w.target_pi_cents], [cents("251405.31"), "86.69", "6.500", 480, cents("1264.13")]);
  assert.equal(w.forborne_cents, cents("35483.32")); assert.equal(w.ib_upb_cents, cents("215921.99")); assert.equal(w.pi_cents, cents("1264.13")); assert.equal(w.reduction_pct, "20.0004"); assert.equal(w.post_mod_ib_mtmltv, "74.46"); assert.equal(w.eligible, true);
  assert.equal(w.forbearance_caps!.b, cents("106405.31")); assert.equal(w.forbearance_caps!.c, cents("75421.59"));
  assert.ok(w.trace.some((t) => t.includes("step4 term→480 pi=147187")));
  const w2 = FM.waterfall({ ib_upb_cents: cents("236765.47"), accrued_interest_cents: cents("10259.84"), escrow_advances_cents: cents("4200"), servicing_advances_cents: cents("180"), prior_nib_cents: 0n, value_cents: cents("200000"), contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 309, pre_mod_pi_cents: cents("1580.17"), mir_pct: "6.625", delinquent_31_plus: true });
  assert.equal(w2.mtmltv, "125.70"); assert.equal(w2.forbearance_caps!.b, cents("151405.31")); assert.equal(w2.forborne_cents, cents("35483.32"));
  const arm = FM.waterfall({ ib_upb_cents: cents("236765.47"), accrued_interest_cents: cents("10259.84"), escrow_advances_cents: cents("4200"), servicing_advances_cents: cents("180"), prior_nib_cents: 0n, value_cents: cents("290000"), contract_rate_pct: "7.250", is_arm_not_final: true, remaining_term_months: 309, pre_mod_pi_cents: cents("1580.17"), mir_pct: "6.625", delinquent_31_plus: true });
  assert.equal(arm.rate_pct, "6.625");
  assert.equal(FM.trialCount(true), 3); assert.equal(FM.trialCount(false), 4);
  const ts = FM.trialSchedule(D("2026-09-11"), 3, cents("520"), cents("31"), cents("1264.13")); assert.deepEqual(ts.due_dates, ["2026-10-01", "2026-11-01", "2026-12-01"]); assert.equal(ts.trial_payment_cents, cents("1815.13")); assert.deepEqual([ts.effective, ts.capitalization_date, ts.incentive_deadline], ["2027-01-01", "2026-12-01", "2027-02-28"]);
  assert.equal(FM.trialSchedule(D("2026-09-16"), 3, 0n, 0n, 0n).due_dates[0], "2026-11-01");
  assert.equal(FM.trialMonthMet(D("2026-11-30"), D("2026-11-01"), cents("1815.13"), cents("1815.13")), true); assert.equal(FM.trialMonthMet(D("2026-12-01"), D("2026-11-01"), cents("1815.13"), cents("1815.13")), false);
  assert.equal(FM.solicitationAllowed(D("2026-11-25"), D("2026-11-02"), false), false); assert.equal(FM.solicitationAllowed(null, D("2026-11-02"), false), true);
});

test("12.9-T2/T4/T5/T7/T8/T11: contribution $8,400, negotiation, listing rule, clocks, deed timing, incentive tiers", () => {
  assert.deepEqual(LQ.contribution(cents("18400"), cents("2100"), cents("41000")), { required: true, request_cents: cents("8400") }); assert.equal(LQ.contribution(cents("1500"), cents("100"), cents("41000")).required, false);
  assert.equal(LQ.negotiated(cents("8400"), cents("5000")), "accepted"); assert.equal(LQ.negotiated(cents("8400"), cents("4000")), "fnma_referral"); assert.equal(LQ.relocation(true, 0n), 0n); assert.equal(LQ.relocation(false, cents("1000")), cents("6500"));
  assert.equal(LQ.listingRuleMet(4), false); assert.equal(LQ.listingRuleMet(5), true);
  assert.deepEqual(LQ.shortSaleClocks(D("2026-10-05"), D("2026-11-04")), { ack_by: "2026-10-13", decision_by: "2026-11-04", close_by: "2027-01-03" });
  assert.deepEqual(LQ.dilClocks(D("2026-10-15")), { documents_by: "2026-12-14", extended_by: "2027-01-13" });
  assert.equal(LQ.deedTiming(D("2026-11-05"), D("2026-12-01")), "fnma_prior_approval"); assert.equal(LQ.deedTiming(D("2026-10-30"), D("2026-12-01")), "allowed");
  assert.deepEqual([LQ.incentive(200), LQ.incentive(250), LQ.incentive(320)], [cents("2500"), cents("1500"), cents("750")]);
  assert.equal(LQ.leaseOption("12_month", true, true), false); assert.equal(LQ.leaseOption("3_month", true, true), true);
  assert.equal(LQ.netProceeds(cents("300000"), { commission: cents("18000"), prorations: 0n, transfer_taxes: 0n, title_settlement: 0n, seller_attorney: 0n, hoa_past_due: 0n, subordinate_liens: cents("6000"), relocation: 0n }).commission_ok, true);
});

test("12.8 F-1-27 step 3 partial increment lands on the MIR floor; step 4 extends one month at a time and stops at the first term meeting the target (AUDIT-REPORT item 2)", () => {
  // Step 3: contract 6.700% ARM (not final), MIR 6.625% — a full 12.5 bp step would undershoot the floor, so the partial increment lands on 6.625% exactly.
  const arm = FM.waterfall({ ib_upb_cents: cents("236765.47"), accrued_interest_cents: cents("10259.84"), escrow_advances_cents: cents("4200"), servicing_advances_cents: cents("180"), prior_nib_cents: 0n, value_cents: cents("290000"), contract_rate_pct: "6.700", is_arm_not_final: true, remaining_term_months: 309, pre_mod_pi_cents: cents("1580.17"), mir_pct: "6.625", delinquent_31_plus: true });
  assert.equal(arm.rate_pct, "6.625"); assert.ok(arm.trace.some((t) => t.startsWith("step3 partial→floor 6.625")));
  // Step 4: a small arrearage on a long remaining term — the target is reachable before 480 months, so the term stops at the first month that meets it.
  const small = FM.waterfall({ ib_upb_cents: cents("200000"), accrued_interest_cents: cents("2166.67"), escrow_advances_cents: 0n, servicing_advances_cents: 0n, prior_nib_cents: 0n, value_cents: cents("290000"), contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 300, pre_mod_pi_cents: cents("1580.17"), mir_pct: "6.625", delinquent_31_plus: true });
  assert.ok(small.term_months > 300 && small.term_months < 480, `term ${small.term_months}`); assert.ok(small.pi_cents <= small.target_pi_cents); assert.equal(small.forborne_cents, 0n);
  const piAt = (n: number) => levelPayment(small.gross_upb_cents, ratePercent("6.500"), n);
  assert.ok(piAt(small.term_months - 1) > small.target_pi_cents, "the month before is still above target"); assert.ok(piAt(small.term_months) <= small.target_pi_cents);
  assert.ok(small.trace.some((t) => t === `step4 term→${small.term_months} pi=${small.pi_cents}`));
  // The worked example still exhausts the term at 480 and forbears $35,483.32.
  const w = FM.waterfall({ ib_upb_cents: cents("236765.47"), accrued_interest_cents: cents("10259.84"), escrow_advances_cents: cents("4200"), servicing_advances_cents: cents("180"), prior_nib_cents: 0n, value_cents: cents("290000"), contract_rate_pct: "6.500", is_arm_not_final: false, remaining_term_months: 309, pre_mod_pi_cents: cents("1580.17"), mir_pct: "6.625", delinquent_31_plus: true });
  assert.equal(w.term_months, 480); assert.equal(w.forborne_cents, cents("35483.32"));
});
