/** §6.1–6.5 acceptance tests. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { cents } from "../../kernel/money/cents.ts";
import { evaluateDepositoryEligibility, accountPlan, depositGate, ineligibilityNoticeDueMs, lockboxCustodialDeadline, disposeInterest, statutoryEscrowInterest, interestDispositionDueMs, formMachine } from "./accounts.ts";
import { form496SS, reconcile, form496A, form496Deadline, ssFundsAvailableMs, attestationWindow, matchBankLine, draftVariance, shortageFunding, isStaleCheck, lossDraftAgedMonths, attestationVariance, autoClears } from "./reconciliation.ts";
import { identify, escheat, writeOffAllowed, researchDeadlines, jaroWinkler } from "./suspense.ts";

const ET = "America/New_York"; const at = (d: string, t: string) => toIso(zonedEpochMs(D(d), t, ET));

test("6.1-T1/T2/T3: account plan and depository eligibility", () => {
  const plan = accountPlan([{ remittance_type: "A/A", pool_class: "portfolio_mrs" }, { remittance_type: "S/A", pool_class: "portfolio_mrs" }, { remittance_type: "S/S", pool_class: "mbs" }, { remittance_type: "S/S", pool_class: "portfolio_mrs" }, { remittance_type: "A/A", pool_class: "mbs" }]);
  assert.equal(plan.filter((p) => p.kind === "pi").length, 4); assert.equal(plan.filter((p) => p.kind === "ti").length, 1);
  assert.equal(plan.filter((p) => p.is_drafting_account && p.remittance_type === "S/S").length, 1);
  const small = { name: "X", insured: true, well_capitalized: true, total_assets_cents: 1_200_000_000_000n, ratings: { idc: 120, kbra: "C" } };
  assert.equal(evaluateDepositoryEligibility(small, "S/S").eligible, false); assert.equal(evaluateDepositoryEligibility(small, "A/A").eligible, true);
  assert.equal(evaluateDepositoryEligibility({ name: "Y", insured: true, well_capitalized: true, total_assets_cents: 4_000_000_000_000n, ratings: { sp_st: "A-3" } }, "S/S").eligible, true);
  assert.equal(evaluateDepositoryEligibility({ ...small, insured: false }, "A/A").eligible, false);
});

test("6.1-T4/T5/T6/T8: form gate, 3-BD notice, lockbox deposit deadline, declined signatures", () => {
  const g = depositGate({ status: "pending_signatures", kind: "1013" }); assert.equal(g.ok, false); if (!g.ok) assert.equal(g.gate, "FNMA_F103_FORM1013_IN_EFFECT_GATE");
  const g2 = depositGate({ status: "in_effect", kind: "1014", remittance_types: ["A/A", "S/A"] }, "S/S"); assert.equal(g2.ok, false);   // 6.2-T1
  assert.equal(depositGate({ status: "in_effect", kind: "1014", remittance_types: ["A/A", "S/A", "S/S"] }, "S/S").ok, true);
  assert.equal(toIso(ineligibilityNoticeDueMs(D("2026-10-15"))), at("2026-10-20", "17:00"));
  assert.equal(lockboxCustodialDeadline(D("2026-11-06")), "2026-11-10");
  const d = formMachine.attempt("pending_signatures", "declined", { kind: "external", id: "docusign" }, {}); assert.ok(d.ok && d.to === "signatures_declined");
  assert.equal(formMachine.attempt("pending_signatures", "signed", { kind: "agent", id: "x" }, {}).ok, false);
});

test("6.2-T2/T3/T5: interest disposition and NY statutory credit", () => {
  assert.deepEqual(disposeInterest(123_456n, 4_500n, 98_765n), { to_borrowers_cents: 98_765n, to_fees_cents: 4_500n, to_corporate_cents: 20_191n, corporate_funds_shortfall_cents: 0n });
  assert.deepEqual(disposeInterest(123_456n, 4_500n, 130_000n).corporate_funds_shortfall_cents, 11_044n);
  assert.equal(statutoryEscrowInterest(481_233n, "2", 30), 791n);
  assert.equal(toIso(interestDispositionDueMs(D("2026-09-30"))), at("2026-10-30", "17:00"));
});

test("6.3-T1/T2/T9: Form 496 S/S worked example, deadlines, funds-available gate", () => {
  const { L12 } = form496SS({ L3_prepaid_net: 812_040n, L4_curtailments: 4_500_000n, L5_interest_fundings: 0n, L7_payoff_fixed_net: 321_015n, L8_delinquent_net: -2_258_000n, L9_fnma_receivable: 123_300_000n, L10_variances: 0n, L11_other: 0n });
  assert.equal(L12, 126_675_055n);
  const r = reconcile({ bank_closing_ledger_cents: 125_430_055n, deposits_in_transit_cents: 1_245_000n, disbursements_in_transit_cents: 0n, adjustments_cents: 0n }, 126_675_055n, L12);
  assert.equal(r.balanced, true); assert.equal(r.difference_cents, 0n);
  const dl = form496Deadline(D("2026-09-30")); assert.equal(dl.due_on, "2026-11-13"); assert.equal(dl.warning_on, "2026-10-30"); assert.equal(toIso(dl.due_at_ms), at("2026-11-13", "17:00"));
  assert.equal(form496Deadline(D("2027-01-31")).due_on, "2027-03-17"); assert.equal(form496Deadline(D("2027-02-28")).due_on, "2027-04-14");
  assert.equal(toIso(ssFundsAvailableMs(D("2026-07-01"))), at("2026-07-17", "00:01"));
});

test("6.3-T4/T6/T7/T8: matching tiers, draft variance, auto-clear, shortage tiers", () => {
  const ledger = [{ id: "a", amount_cents: 125_000n, date: D("2026-10-07") }, { id: "b1", amount_cents: 50_000n, date: D("2026-10-07"), batch_id: "LBX1" }, { id: "b2", amount_cents: 70_000n, date: D("2026-10-07"), batch_id: "LBX1" }, { id: "c", amount_cents: 999n, date: D("2026-10-07"), reference: "WIRE-1" }];
  assert.deepEqual(matchBankLine({ id: "x", amount_cents: 999n, value_date: D("2026-10-09"), reference: "WIRE-1" }, ledger).tier, "reference");
  assert.deepEqual(matchBankLine({ id: "x", amount_cents: 125_000n, value_date: D("2026-10-08") }, ledger).tier, "amount_date_1to1");
  assert.deepEqual(matchBankLine({ id: "x", amount_cents: 120_000n, value_date: D("2026-10-08") }, ledger), { tier: "amount_date_many_to_1", ledger_ids: ["b1", "b2"] });
  assert.equal(matchBankLine({ id: "x", amount_cents: 1_250n, value_date: D("2026-10-08"), type_code: "165", memo: "J SMITH" }, ledger).tier, "unmatched");
  const dv = draftVariance(4_821_033n, 4_841_033n, [{ loan: "1234567890", amount_cents: 20_000n, reason: "LAR correction, interest" }]);
  assert.equal(dv.variance_cents, 20_000n); assert.equal(dv.items[0]!.loan, "1234567890"); assert.equal(dv.residual_to_shortage_surplus_cents, 0n);
  assert.equal(autoClears("deposit_in_transit", D("2026-10-05"), D("2026-10-07")), true); assert.equal(autoClears("deposit_in_transit", D("2026-10-05"), D("2026-10-08")), false);
  const sf = shortageFunding(1_800_000n, D("2026-10-12")); assert.equal(sf.tier, "officer_1bd"); assert.equal(sf.due_on, "2026-10-14"); assert.equal(toIso(sf.due_at_ms), at("2026-10-14", "17:00"));
  assert.equal(shortageFunding(90_000n, D("2026-10-12")).tier, "agent_auto"); assert.equal(shortageFunding(90_000n, D("2026-10-12"), true).tier, "officer_partner_fraud");
});

test("6.4-T1/T2/T3/T4/T5/T6: Form 496A worked example, unfunded advances, aged loss drafts, stale checks, attestation", () => {
  const f = form496A({ P: 861_200_411n, N: 3_895_012n, A: 3_895_012n, LD: 0n, U: 0n, BD: 1_230_000n, I: 20_191n, O: 0n });
  assert.deepEqual([f.L1, f.L2, f.L5, f.L6, f.L7], [857_305_399n, 3_895_012n, 1_230_000n, 20_191n, 862_450_602n]);
  const r = reconcile({ bank_closing_ledger_cents: 880_894_690n, deposits_in_transit_cents: 3_120_000n, disbursements_in_transit_cents: 21_564_088n, adjustments_cents: 0n }, 862_450_602n, f.L7); assert.equal(r.balanced, true);
  assert.equal(form496A({ P: 0n, N: 3_895_012n, A: 3_000_000n, LD: 0n, U: 0n, BD: 0n, I: 0n, O: 0n }).advance_unfunded_cents, 895_012n);
  assert.equal(lossDraftAgedMonths(D("2026-02-14"), D("2026-09-30")), 7);
  assert.equal(isStaleCheck(D("2026-03-01"), D("2026-08-28")), true); assert.equal(isStaleCheck(D("2026-03-01"), D("2026-08-27")), false);
  const av = attestationVariance(857_305_399n, 857_180_399n, "one rejected $1,250.00 deposit event"); assert.equal(av.answer, "No"); assert.equal(av.gate_open, true); assert.equal(av.variance_cents, 125_000n);
  const w = attestationWindow(D("2026-09-30")); assert.equal(w.opens_on, "2026-10-05"); assert.equal(w.closes_on, "2026-11-03"); assert.equal(toIso(w.closes_at_ms), at("2026-11-03", "17:00")); assert.equal(w.draft_warning_on, "2026-10-29");
});

test("6.5-T4/T5/T7/T10: identification scores, research/return deadlines, escheat, write-off limit", () => {
  const cands = [{ loan_id: "4471", borrower_names: ["John Smith"], ach_last4: "8831", periodic_payment_cents: 125_000n }, { loan_id: "9001", borrower_names: ["Jane Smith"], periodic_payment_cents: 99_000n }, { loan_id: "9002", borrower_names: ["J Smithers"], periodic_payment_cents: 140_000n }];
  const r = identify({ amount_cents: 125_000n, memo: "J SMITH", payer_name: "J SMITH", ach_last4: "8831" }, cands);
  assert.equal(r.decision, "auto_apply"); assert.equal(r.loan_id, "4471");
  const two = identify({ amount_cents: 99_000n, payer_name: "J Smith" }, [{ loan_id: "a", borrower_names: ["J Smith"], periodic_payment_cents: 99_000n, ach_last4: "1111" }, { loan_id: "b", borrower_names: ["J Smith"], periodic_payment_cents: 99_000n }]);
  assert.notEqual(two.decision, "auto_apply");
  assert.ok(jaroWinkler("J SMITH", "John Smith") > 0.7);
  assert.deepEqual(researchDeadlines(D("2026-10-07")), { research_by: "2026-11-06", return_by: "2026-12-06" });
  const e = escheat(D("2026-03-01"), "TX");
  assert.deepEqual([e.presumed_abandoned_on, e.cycle, e.report_due_on, e.due_diligence_window, e.officer_verification_on], ["2029-03-01", "FY2029", "2029-11-01", ["2029-05-05", "2029-09-02"], "2029-09-15"]);
  assert.equal(writeOffAllowed(725n, false), false); assert.equal(writeOffAllowed(725n, true), true); assert.equal(writeOffAllowed(cents("4.99"), false), true);
});
