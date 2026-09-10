/** §14.1–14.4 acceptance tests (fixture BK-13-A). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import * as C from "./case.ts"; import * as N from "./notices.ts"; import * as S from "./statement.ts"; import * as R from "./credit.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";

test("14.1-T3/T4/T7/T8/T9/T11: clocks, POC $14,241.94 / $326,882.35, plan cure $237.37, trustee vouchers, post-petition 60-day MFR, prior filings", () => {
  const ck = C.clocks(D("2026-09-08")); assert.deepEqual([ck.referral, ck.prior_filing_check, ck.poc_bar, ck.poc_supplement, ck.poc_package_target], ["2026-09-22", "2026-09-22", "2026-11-17", "2027-01-06", "2026-10-13"]);
  assert.equal(C.conversionPocBar(D("2027-02-03")), "2027-04-14");
  const upb33 = balanceAfter(cents("325000"), "6.500", 360, 33); assert.equal(upb33, cents("314415.22"));
  const unpaid = C.unpaidSplits(upb33, "6.500", cents("2054.22"), D("2026-05-01"), D("2026-09-08"), cents("102.71"), 15);
  assert.equal(unpaid.length, 5); assert.deepEqual([unpaid[0]!.interest_cents, unpaid[0]!.principal_cents], [cents("1703.08"), cents("351.14")]); assert.equal(unpaid[4]!.late_charge_cents, 0n); assert.equal(unpaid[3]!.late_charge_cents, cents("102.71"));
  const poc = C.proofOfClaim({ ib_upb_cents: upb33, nib_cents: 0n, unpaid, other_prepetition_fees_cents: cents("40"), escrow_balance_at_petition_cents: -cents("3920"), funds_on_hand_cents: cents("400"), pi_cents: cents("2054.22"), escrow_monthly_cents: cents("645") });
  assert.deepEqual([poc.part3.principal_due_cents, poc.part3.interest_due_cents, poc.part3.prepetition_fees_due_cents, poc.part3.escrow_deficiency_cents, poc.part3.total_prepetition_arrearage_cents], [cents("1774.81"), cents("8496.29"), cents("450.84"), cents("3920"), cents("14241.94")]);
  assert.equal(poc.part2_total_debt_cents, cents("326882.35")); assert.equal(poc.part4_monthly_cents, cents("2699.22")); assert.equal(poc.part5_starts, "2026-05-01");
  assert.deepEqual(C.planCureInstallment(cents("14241.94")), { installment_cents: cents("237.37"), last_installment_cents: cents("237.11") });
  const l: C.Ledgers = { prepetition_arrearage_cents: cents("14241.94"), postpetition: [{ due: D("2026-10-01"), amount_cents: cents("2699.22"), paid_cents: 0n }, { due: D("2026-11-01"), amount_cents: cents("2806.72"), paid_cents: 0n }, { due: D("2026-12-01"), amount_cents: cents("2806.72"), paid_cents: 0n }], postpetition_suspense_cents: 0n };
  const v1 = C.applyVoucher(l, { amount_cents: cents("5398.44"), designation: "post-petition", conduit_district: true }); assert.deepEqual(v1.short, [{ due: "2026-11-01", short_cents: 10_750n }]); assert.equal(l.postpetition[0]!.paid_cents, cents("2699.22"));
  const v2 = C.applyVoucher(l, { amount_cents: cents("3151.59"), designation: "unlabelled", conduit_district: true }); assert.equal(v2.applied_arrearage_cents, cents("237.37")); assert.equal(l.prepetition_arrearage_cents, cents("14004.57")); assert.equal(v2.short.length, 0);
  assert.equal(C.postpetitionDelinquencyDays({ ...l, postpetition: [{ due: D("2027-01-01"), amount_cents: 1n, paid_cents: 0n }, { due: D("2027-02-01"), amount_cents: 1n, paid_cents: 0n }] }, D("2027-02-02")), 32); assert.equal(C.mfrReferralDue(D("2027-02-02")), "2027-02-16");
  assert.deepEqual(C.referralDecision("13", 130, false), { type: "full", form20: false, convert_to_full_when_60: false }); assert.equal(C.referralDecision("13", 20, false).type, "poc_only"); assert.equal(C.referralDecision("11", 0, false).form20, true);
  assert.equal(C.priorFilingClass(1, false), "one_prior_dismissed_1y"); assert.equal(C.priorFilingClass(0, true), "abusive_suspected");
  assert.equal(C.stayGates("in_effect").foreclosure_blocked, true); assert.equal(C.stayGates("not_in_effect_362c4", false).foreclosure_blocked, true); assert.equal(C.stayGates("not_in_effect_362c4", true).foreclosure_blocked, false); assert.equal(C.stayGates("ended_discharge").contact_route, "informational_only");
});

test("14.2-T1/T2/T3/T4/T6/T7/T8/T11: 9006 deadline 10-09, target, late → 12-01, fee batching, preclusion 2027-04-19, challenge 2028-01-18, responses", () => {
  assert.deepEqual(N.paymentChangeDeadline(D("2026-11-01")), { deadline: "2026-10-09", target: "2026-09-25" });
  assert.deepEqual(N.timeliness(D("2026-11-01"), D("2026-09-30"), true), { timely: true, effective_date_applied: "2026-11-01", days_notice: 32 });
  assert.deepEqual(N.timeliness(D("2026-11-01"), D("2026-10-15"), true).effective_date_applied, "2026-12-01"); assert.equal(N.timeliness(D("2026-11-01"), D("2026-10-15"), false).effective_date_applied, "2026-11-01");
  const items: N.FeeItem[] = [{ incurred_on: D("2026-10-20"), cents: cents("1225"), line: "5", recoverable: true, status: "incurred" }, { incurred_on: D("2026-10-20"), cents: cents("325"), line: "5", recoverable: true, status: "incurred" }, { incurred_on: D("2026-11-05"), cents: cents("20"), line: "7", recoverable: true, status: "incurred" }, { incurred_on: D("2026-12-05"), cents: cents("20"), line: "7", recoverable: true, status: "incurred" }];
  const b = N.feeBatchDecision(items, D("2027-01-15")); assert.equal(b.file_now, true); assert.equal(b.aggregate_cents, cents("1590")); assert.equal(b.preclusion_first, "2027-04-19");
  const small = N.feeBatchDecision([{ incurred_on: D("2026-10-20"), cents: cents("60"), line: "7", recoverable: true, status: "incurred" }], D("2027-01-10")); assert.equal(small.file_now, false); assert.equal(N.feeBatchDecision([{ incurred_on: D("2026-10-20"), cents: cents("60"), line: "7", recoverable: true, status: "incurred" }], D("2027-01-18")).reason, "oldest item day 90");
  assert.equal(N.challengeDeadline(D("2027-01-15")), "2028-01-18");
  const stale: N.FeeItem[] = [{ incurred_on: D("2026-10-20"), cents: cents("20"), line: "7", recoverable: true, status: "incurred" }]; assert.equal(N.precludeUnnoticed(stale, D("2027-04-20")).length, 1); assert.equal(stale[0]!.status, "precluded_not_noticed");
  assert.equal(N.responseDue(D("2028-03-03"), false), "2028-03-31"); assert.equal(N.responseDue(D("2028-03-03"), true), "2028-04-03"); assert.equal(N.responseDue(D("2031-06-20"), false), "2031-07-18"); assert.equal(N.responseDue(D("2031-06-20"), true), "2031-07-21");
  const eoc = N.endOfCaseResponse({ arrearage_cents: 0n, postpetition_unpaid: [], unpaid_noticed_fees_cents: 0n, upb_cents: cents("288625.18"), next_due: D("2031-07-01"), next_amount_cents: cents("2054.22") }); assert.deepEqual([eoc.arrearage, eoc.current, eoc.g4_window_starts], ["paid_in_full", true, false]);
  assert.equal(N.endOfCaseResponse({ arrearage_cents: 0n, postpetition_unpaid: [{ due: D("2031-06-01"), cents: 1n }], unpaid_noticed_fees_cents: 0n, upb_cents: 1n, next_due: D("2031-07-01"), next_amount_cents: 1n }).first_unpaid_due, "2031-06-01");
  assert.equal(N.inScope({ chapter: "13", principal_residence: null, treatment: "cure_and_maintain", relief_order_effective: false }), true); assert.equal(N.inScope({ chapter: "7", principal_residence: true, treatment: "cure_and_maintain", relief_order_effective: false }), false); assert.equal(N.inScope({ chapter: "13", principal_residence: true, treatment: "surrender", relief_order_effective: false }), false);
  assert.equal(N.armFilingDue(D("2026-12-01"), D("2027-02-01")), "2026-12-08");
});

test("14.3-T1/T2/T4/T8: single-statement skip, Feb-1-2027 content $8,420.16 / $5,613.44 / $1,306.72 / >45, cease exemption, addressing", () => {
  assert.equal(S.singleStatementSkip(D("2026-09-08"), D("2026-09-16"), false), "skip_this_cycle"); assert.equal(S.singleStatementSkip(D("2026-09-20"), D("2026-09-16"), true), "send_unmodified_skip_next");
  const c = S.ch13Content({ statement_date: D("2027-01-17"), postpetition_installment_cents: cents("2806.72"), postpetition_unpaid: [{ due: D("2026-12-01"), cents: cents("2806.72") }, { due: D("2027-01-01"), cents: cents("2806.72") }], allowed_noticed_fees_unpaid_cents: 0n, suspense_cents: cents("1500"), prepetition_arrearage_cents: cents("14241.94"), trustee_pays_postpetition: false });
  assert.deepEqual([c.amount_due_cents, c.past_due_postpetition_cents, c.shortfall_text_cents, c.over_45_sentence, c.late_fee_line, c.delinquency_box], [cents("8420.16"), cents("5613.44"), cents("1306.72"), true, false, false]);
  const base = { debtor_or_discharged: true, chapter: "13" as const, court_order_cease: false, plan_surrenders: false, ch7_soi_surrender_no_payment: false, cease_request: false, later_request_for_statements: false, reaffirmed_final: false, dismissed_no_discharge: false };
  assert.equal(S.mode(base), "modified_ch12_13"); assert.equal(S.mode({ ...base, cease_request: true }), "exempt_cease_request"); assert.equal(S.mode({ ...base, cease_request: true, later_request_for_statements: true }), "modified_ch12_13"); assert.equal(S.mode({ ...base, chapter: "7" }), "modified_ch7_11"); assert.equal(S.mode({ ...base, dismissed_no_discharge: true }), "standard");
  assert.deepEqual(S.addressing({ fdcpa_covered: true, attorney_of_record: true, counsel_consents_debtor_copy: false }), ["counsel"]); assert.deepEqual(S.addressing({ fdcpa_covered: true, attorney_of_record: true, counsel_consents_debtor_copy: true }), ["counsel", "debtor"]);
});

test("14.4-T1/T2/T3/T4/T5/T6/T7: petition snapshot (82, 000013496, 05012026, 000314415), CII by phase, reaffirmation window, corrections 2 BD", () => {
  const snap = R.petitionSnapshot({ chapter: "13", days_delinquent_at_petition: 130, monthly_payment_cents: cents("2699.22"), installments_past_due: 5, upb_cents: cents("314415.22"), dofd: D("2026-05-01") });
  assert.deepEqual(snap, { cii: "D", account_status: "82", amount_past_due: "000013496", dofd: "05012026", current_balance: "000314415", scheduled_payment: "000002699" });
  assert.equal(R.accountStatus(152), "83"); assert.equal(R.accountStatus(30), "71");
  assert.equal(R.cii("13", "discharged", false).cii, "Q"); assert.equal(R.cii("7", "discharged", true).cii, "E"); assert.equal(R.cii("7", "discharged", true).zero_balances, true); assert.equal(R.cii("13", "discharged", true).cii, "H");
  assert.equal(R.cii("13", "dismissed", false).cii, "L"); assert.equal(R.cii("13", "withdrawn", false).cii, "P"); assert.equal(R.cii("7", "reaffirmed", false).cii, "R"); assert.equal(R.cii("7", "rescinded", false).cii, "V");
  assert.equal(R.reaffirmationFinal(D("2026-11-20"), D("2026-12-15")), "2027-02-13"); assert.equal(R.correctionDue(D("2026-10-20")), "2026-10-22");
});
