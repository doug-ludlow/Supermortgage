import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as d } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import {
  larCode, caseKind, confirmDueAt, lateDays, exceptionResolutionDue, resaleRestrictionGate, deedRecordDue, insuranceCancellationDue, advanceReimbursable, ptrInterest, thirdPartySale, failedSaleDepositDue, rescissionClocks, refoFeesReimbursable,
  validateLine, finalDueAt, unearnedPremiumCredit, claimTotals, postPaymentRefund, recoveryRepayment, psaClocks, achExpected, irtClocks, denialTriage, attachmentContainsSsn, type ClaimLine, type ClaimContext,
  filer, miClaimClocks, shadowClaim, nodExcludedInterest, curtailmentRisk, docRequestDue, eobVariance, proceedsRemitDue, supplementalUploadDue, unpaidEscalationOn, insurerMismatchCorrectionDue,
  expectedRecovery, matchReimbursement, outstanding, unrecoveredEscalationDue, mbsRemovalGate, saRecoveryLar, duplicateCreditNoticeDue, type Advance,
} from "./index.ts";

const ET = "America/New_York";

test("15.1-T1/T2 confirmation clock: Oct 6 09:10 → Thu Oct 7 17:00 ET; Nov 24 17:30 → Fri Nov 26 (Thanksgiving skipped)", () => {
  const a = confirmDueAt(zonedEpochMs(d("2027-10-06"), "09:10", ET));
  assert.equal(a.date, d("2027-10-07")); assert.deepEqual([wallClock(a.ms, ET).hour, wallClock(a.ms, ET).minute], [17, 0]);
  assert.equal(confirmDueAt(zonedEpochMs(d("2027-11-24"), "17:30", ET)).date, d("2027-11-26"));
  assert.equal(larCode("fnma", true), "72"); assert.equal(larCode("fnma", false), "70"); assert.equal(larCode("third_party", true), "71");
  assert.equal(caseKind("third_party"), "tps_cases");
});

test("15.1-T3/T4/T8/T9/T11 late days, exception SLA (Columbus Day), deed next day, insurance by day 14, resale gate", () => {
  assert.equal(lateDays(d("2027-10-07"), d("2027-10-08")), 1);
  assert.equal(lateDays(d("2027-10-07"), d("2027-10-07")), 0);
  // Spec 15.1-T4 says Oct 12 "3 BD; Oct 11 holiday" — Oct 8, 12, 13 are the three fannie_et BD, so the engine gives Oct 13 (audit note).
  assert.equal(exceptionResolutionDue(d("2027-10-07")), d("2027-10-13"));
  assert.deepEqual(deedRecordDue(d("2027-10-05"), "servicer"), { due: d("2027-10-06"), task: "record_deed" });
  assert.equal(insuranceCancellationDue(d("2027-10-05")), d("2027-10-19"));
  assert.equal(advanceReimbursable(d("2027-10-25"), d("2027-10-05")), false);
  assert.deepEqual(resaleRestrictionGate("clt", false), { blocked: true, escalate: "attorney" });
  assert.deepEqual(resaleRestrictionGate(null, false), { blocked: false, escalate: null });
});

test("15.1-T5/T6 TPS arithmetic: interest $13,699.87 + $163.78 → indebtedness $262,952.26; recovery $7,047.74; settle by Oct 13; $280k bid → surplus $5,827.80", () => {
  const int = ptrInterest(cents("249088.61"), "6.00", d("2026-11-01"), d("2027-10-05"));
  assert.deepEqual([int.months_full, int.stub_days, int.cents], [11, 4, cents("13863.65")]);
  const r = thirdPartySale({ upb_cents: cents("249088.61"), ptr_pct: "6.00", lpi_due: d("2026-11-01"), liquidation_date: d("2027-10-05"), settlement_date: d("2027-10-05"), gross_proceeds_cents: cents("270000"), unrecovered_advances_cents: cents("11219.94") });
  assert.equal(r.fnma_total_indebtedness_cents, cents("262952.26"));
  assert.equal(r.amount_due_fnma_cents, cents("262952.26"));
  assert.equal(r.servicer_recovery_cents, cents("7047.74")); assert.equal(r.surplus_cents, 0n); assert.equal(r.claim_571_advances_cents, cents("4172.20"));
  assert.equal(r.settle_by, d("2027-10-13")); assert.equal(r.instruct_by, d("2027-10-12"));
  const big = thirdPartySale({ upb_cents: cents("249088.61"), ptr_pct: "6.00", lpi_due: d("2026-11-01"), liquidation_date: d("2027-10-05"), settlement_date: d("2027-10-05"), gross_proceeds_cents: cents("280000"), unrecovered_advances_cents: cents("11219.94") });
  assert.equal(big.servicer_recovery_cents, cents("11219.94")); assert.equal(big.surplus_cents, cents("5827.80")); assert.equal(big.claim_571_advances_cents, 0n);
});

test("15.1-T7/T10 failed sale deposit by Oct 27; rescission template Oct 17, reactivation +24h, counsel Oct 22; servicer-caused re-foreclosure fees not reimbursable", () => {
  assert.equal(failedSaleDepositDue(d("2027-10-20")), d("2027-10-27"));
  const c = rescissionClocks(d("2027-10-12"), zonedEpochMs(d("2027-10-20"), "10:00", ET));
  assert.equal(c.template_due, d("2027-10-17"));
  assert.equal(wallClock(c.reactivate_by_ms!, ET).date, d("2027-10-21")); assert.equal(c.counsel_by, d("2027-10-22"));
  assert.equal(refoFeesReimbursable("servicer"), false);
});

// ---- 15.2 -------------------------------------------------------------------------

const CTX: ClaimContext = { event_date: d("2027-10-05"), state: "TX", attorney_fee_exhibit_cents: cents("2300"), servicing_option: "special", preservation_cap_cents: cents("1000") };
const L15: ClaimLine[] = [
  { kind: "taxes", unit_cents: cents("4820"), quantity: 1, paid_on: d("2027-01-31"), invoice: true },
  { kind: "hazard", unit_cents: cents("1450"), quantity: 1, paid_on: d("2027-03-15"), invoice: true },
  { kind: "mi_premium", unit_cents: cents("124.54"), quantity: 11, paid_on: d("2027-10-01"), invoice: true },
  { kind: "inspection", unit_cents: cents("30"), quantity: 9, paid_on: d("2027-09-30"), invoice: true, inspection_type: "exterior" },
  { kind: "preservation", unit_cents: cents("445"), quantity: 1, paid_on: d("2027-08-01"), invoice: true },
  { kind: "attorney_fee", unit_cents: cents("2300"), quantity: 1, paid_on: d("2027-10-06"), invoice: true, milestone_pct: 100 },
  { kind: "attorney_cost", unit_cents: cents("565"), quantity: 1, paid_on: d("2027-10-06"), invoice: true },
  { kind: "technology", unit_cents: cents("25"), quantity: 1, paid_on: d("2027-10-06"), invoice: true },
  { kind: "einvoice", unit_cents: cents("5"), quantity: 1, paid_on: d("2027-10-06"), invoice: true },
];

test("15.2-T1 fixture L15: gross $11,249.94, credit $659.45, net $10,590.49, final due Nov 4, 2027; every line valid", () => {
  const v = L15.map((l) => validateLine(l, CTX));
  assert.ok(v.every((x) => x.ok), JSON.stringify(v.filter((x) => !x.ok).map((x) => x.messages)));
  const credit = unearnedPremiumCredit(cents("1450"), d("2027-03-20"), d("2028-03-20"), d("2027-10-05"));
  assert.equal(credit, cents("659.45"));
  const t = claimTotals(v, [credit]);
  assert.equal(t.gross_cents, cents("11249.94")); assert.equal(t.net_cents, cents("10590.49"));
  const due = finalDueAt({ event_date: d("2027-10-05"), mi_insured: true, disposition_date: null, kind: "reo" });
  assert.equal(due.final_due, d("2027-11-04")); assert.equal(due.internal_target, d("2027-10-25"));
});

test("15.2-T2/T3/T4/T5 uninsured REO waits for disposition; TX fee over exhibit; post-sale hazard; judicial milestone 90%", () => {
  const u = finalDueAt({ event_date: d("2027-10-05"), mi_insured: false, disposition_date: null, kind: "reo" });
  assert.equal(u.final_due, null); assert.equal(u.policy_due, d("2027-12-04"));
  const over = validateLine({ kind: "attorney_fee", unit_cents: cents("2500"), quantity: 1, paid_on: d("2027-10-06"), invoice: true }, CTX);
  assert.ok(!over.ok && over.messages[0]!.startsWith("attorney_fee_over_exhibit")); assert.equal(over.cap_cents, cents("2300"));
  assert.ok(validateLine({ kind: "attorney_fee", unit_cents: cents("2500"), quantity: 1, paid_on: d("2027-10-06"), invoice: true, approval_id: "X1" }, CTX).ok);
  assert.deepEqual(validateLine({ kind: "hazard", unit_cents: cents("1450"), quantity: 1, paid_on: d("2027-10-25"), invoice: true }, CTX).messages, ["post_sale_nonreimbursable"]);
  const j = validateLine({ kind: "attorney_fee", unit_cents: cents("2700"), quantity: 1, paid_on: d("2027-10-06"), invoice: true, milestone_pct: 90 }, { ...CTX, state: "FL", attorney_fee_exhibit_cents: cents("3000") });
  assert.equal(j.cap_cents, cents("2700")); assert.ok(j.ok);
  assert.deepEqual(validateLine({ kind: "delinquency_pi", unit_cents: cents("1476"), quantity: 1, paid_on: d("2027-01-18"), invoice: true }, CTX).messages, ["pi_advances_not_claimable"]);   // 15.4-T10
  assert.ok(validateLine({ kind: "taxes", unit_cents: 100n, quantity: 1, paid_on: d("2027-01-31"), invoice: true }, { ...CTX, servicing_option: "regular_mbs" }).messages.includes("ineligible_regular_servicing"));
});

test("15.2-T6/T7/T8/T9/T10/T13 clocks, triage, PII screen", () => {
  assert.deepEqual(psaClocks(d("2027-11-10")), { internal_due: d("2027-11-20"), response_due: d("2028-01-09") });
  assert.equal(irtClocks(d("2027-11-24"), d("2027-12-01")).reply_due, d("2027-12-08"));
  assert.equal(denialTriage("late_claim_fnma_outage"), "dispute_with_outage_evidence");
  const a = achExpected(d("2027-11-19"));
  assert.equal(a.expected, d("2027-11-24")); assert.equal(a.escalate_after, d("2027-11-29"));
  assert.deepEqual(recoveryRepayment(d("2028-01-15"), "borrower_reinstatement"), { code: "353", due: d("2028-03-15") });
  assert.deepEqual(postPaymentRefund("mi", d("2027-12-03")), { code: "336", due: d("2028-01-02") });
  assert.ok(attachmentContainsSsn("SSN 123-45-6789")); assert.equal(attachmentContainsSsn("loan 1234567890"), false);
  assert.equal(finalDueAt({ event_date: d("2027-09-30"), mi_insured: false, disposition_date: null, kind: "workout" }).final_due, d("2027-11-29"));   // 15.2-T12
});

// ---- 15.3 -------------------------------------------------------------------------

test("15.3-T1 Radian MICP: deadline Dec 4, docs Nov 19, target Oct 20; shadow claim $272,720.51 → benefit $68,180.13", () => {
  assert.equal(filer({ micp_participant: true, micp_effective: d("2021-10-18"), liquidation_date: d("2027-10-05") }), "fnma_micp");
  const c = miClaimClocks(d("2027-10-05"), d("2027-10-05"));
  assert.equal(c.claim_filing_deadline, d("2027-12-04")); assert.equal(c.micp_docs_due, d("2027-11-19")); assert.equal(c.internal_target, d("2027-10-20")); assert.equal(c.direct_file_due, d("2027-11-04"));
  const s = shadowClaim({ upb_cents: cents("249088.61"), note_rate_pct: "6.25", interest_paid_to: d("2026-11-01"), anchor: d("2027-10-05"), default_date: d("2026-12-01"),
    taxes_cents: cents("4820"), hazard_cents: cents("1450"), hazard_refund_cents: cents("659.45"), hoa_cents: 0n, preservation_inspection_cents: cents("715"), attorney_fees_costs_cents: cents("2865"), credits_cents: 0n, coverage_pct: "25" });
  assert.equal(s.interest_cents, cents("14441.35")); assert.equal(s.attorney_cap_cents, cents("7472.66"));
  assert.equal(s.claim_amount_cents, cents("272720.51")); assert.equal(s.benefit_cents, cents("68180.13"));
  const tps = shadowClaim({ upb_cents: cents("249088.61"), note_rate_pct: "6.25", interest_paid_to: d("2026-11-01"), anchor: d("2027-10-05"), default_date: d("2026-12-01"),
    taxes_cents: cents("4820"), hazard_cents: cents("1450"), hazard_refund_cents: cents("659.45"), hoa_cents: 0n, preservation_inspection_cents: cents("715"), attorney_fees_costs_cents: cents("2865"), credits_cents: 0n, coverage_pct: "25", net_proceeds_cents: cents("270000") });
  assert.equal(tps.benefit_cents, cents("2720.51"));
});

test("15.3-T3/T4/T5/T6/T7/T8/T9/T10/T11 MN redemption anchors, NOD exclusion, risk, doc request, EOB variance, remit, supplemental", () => {
  const mn = miClaimClocks(d("2027-10-05"), d("2028-04-05"));
  assert.equal(mn.direct_file_due, d("2028-05-05")); assert.equal(mn.claim_filing_deadline, d("2027-12-04")); assert.equal(mn.micp_docs_due, d("2027-11-19"));
  const nod = nodExcludedInterest(cents("249088.61"), "6.25", d("2027-01-25"), d("2027-01-30"));
  assert.deepEqual([nod.days, nod.cents, nod.attribution], [5, cents("213.26"), "servicer_caused"]);
  const r = curtailmentRisk({ nod_late_days: 0, fcl_days_used: 340, fcl_days_allowable: 300, allowable_delays: 25, interest_months: 11, property_condition_flags: 0, premium_gap: false, docs_ready: true });
  assert.equal(r.projected_excess_days, 15); assert.ok(r.score >= 0.6 && r.diligence_task);
  assert.equal(docRequestDue(d("2027-11-08"), d("2027-11-15")), d("2027-11-15"));
  const v = eobVariance(cents("68180.13"), cents("67000"));
  assert.equal(v.variance_cents, cents("1180.13")); assert.ok(v.analyze);
  assert.equal(unpaidEscalationOn(d("2027-12-10")), d("2028-02-08"));
  assert.equal(proceedsRemitDue(d("2028-01-05")), d("2028-01-07"));
  // Spec 15.3-T10 says Dec 20; counting 10 fannie_et BD back from Jan 3, 2028 (Christmas observed Fri Dec 24) lands on Dec 16 (audit note).
  assert.equal(supplementalUploadDue(d("2028-01-03")), d("2027-12-16"));
  assert.equal(insurerMismatchCorrectionDue(d("2027-10-07")), d("2027-10-08"));
  assert.equal(filer({ micp_participant: false, micp_effective: null, liquidation_date: d("2027-10-05") }), "servicer_direct");
});

// ---- 15.4 -------------------------------------------------------------------------

const ADV: Advance[] = [
  { id: "a1", activity_period: "2027-01", amount_cents: cents("1476.00"), status: "outstanding" },
  { id: "a2", activity_period: "2027-02", amount_cents: cents("1476.10"), status: "outstanding" },
  { id: "a3", activity_period: "2027-03", amount_cents: cents("1476.19"), status: "outstanding" },
  { id: "a4", activity_period: "2027-04", amount_cents: cents("1476.29"), status: "outstanding" },
];

test("15.4-T1/T2/T3/T4 expectation Dec 17, 2027; FIFO match $5,904.58; $4,428.29 → variance 147,629¢; deferral Mar 12 → Mar 18", () => {
  assert.equal(outstanding(ADV), cents("5904.58"));
  const e = expectedRecovery("liquidation_lar", d("2027-10-06"));
  assert.deepEqual(e.cycles, [d("2027-11-18"), d("2027-12-17")]); assert.equal(e.expected_by, d("2027-12-17"));
  const m = matchReimbursement(ADV, cents("5904.58"));
  assert.deepEqual(m.matched, ["a1", "a2", "a3", "a4"]); assert.equal(m.status, "matched");
  const v = matchReimbursement(ADV, cents("4428.29"));
  assert.equal(v.status, "variance"); assert.equal(v.variance_cents, 147_629n); assert.deepEqual(v.matched, ["a1", "a2", "a3"]);
  // Registry: SM_DELADV_UNRECOVERED_60 = exit event + 60 calendar days → Dec 5, 2027; the spec prose's "Feb 4, 2028" is inconsistent (audit note).
  assert.equal(unrecoveredEscalationDue(d("2027-10-06")), d("2027-12-05"));
  assert.equal(expectedRecovery("deferral", d("2027-03-12")).expected_by, d("2027-03-18"));
  assert.equal(expectedRecovery("payoff", d("2027-03-12")).expected_by, null);
});

test("15.4-T6/T7/T11 S/A LAR 96 −$3,736.32; regular MBS gate; duplicate credit notice", () => {
  assert.deepEqual(saRecoveryLar(cents("1245.44"), 3), { lar: "96", interest_cents: -cents("3736.32") });
  assert.deepEqual(mbsRemovalGate("regular_mbs", false), { blocked: true, escalate: "officer" });
  assert.equal(matchReimbursement(ADV.map((a) => ({ ...a, status: "reimbursed_by_fnma" as const })), cents("5904.58")).status, "duplicate");
  assert.equal(duplicateCreditNoticeDue(d("2027-12-20")), d("2027-12-22"));
});
