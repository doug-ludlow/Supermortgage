/** Acceptance tests for §2.2–§2.7 (T-numbers from the spec). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryEventStore, FixedClock } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { plainDate as D, addMonths } from "../../kernel/calendar/date.ts";
import { servicer } from "../../kernel/calendar/business.ts";
import { CashieringService } from "./service.ts";
import { allocate } from "./allocation.ts";
import { decidePartial, openSuspenseItem, sweepReturns, reclassifyStaleHalves, type SuspenseItem } from "./partials.ts";
import { authorizationDefects, validateDraftDay, settlementDateFor, variableAmountNoticeStatus, handleReturn, revocationEffect, newEnrollment, enrollmentMachine, unauthorizedReturnRateAlert, type Authorization } from "./autodraft.ts";
import { reamortize, reapplicationGate, nextInstallmentSplit } from "./curtailment.ts";
import { biweeklyInterest, designatedPrincipalFromAddenda, newArrangement, arrangementMachine, returnClockSuspended } from "./biweekly.ts";
import { newTrial, trialReceipt, trialMonthEnd, trialCompletion, bookingGate } from "./trial.ts";
import { assessLateCharge, recordFee, waiveLateCharge, waiveAll, releaseSuspended, reverseOnRedate, nsfFee, lateFeeDisclosure, lateChargeAmount } from "./latecharges.ts";
import type { LoanCashState } from "./types.ts";

const AGENT = { kind: "agent" as const, id: "cashiering" };
const OFFICER = { kind: "human" as const, id: "u1", role: "officer" };

function L1(o: Partial<LoanCashState> = {}, firstDue = D("2026-09-01"), n = 4): LoanCashState {
  const installments = Array.from({ length: n }, (_, i) => ({ due_date: addMonths(firstDue, i), pi_cents: 158_017n, escrow_cents: 61_240n, status: "due" as const }));
  return { loan_id: "L-1", instrument_date: D("2021-07-15"), lien: "first", escrowed: true, note_rate_pct: "6.500", remittance_type: "A/A", upb_cents: 24_977_400n, lpi_date: D("2026-08-01"), installments,
    late_charges_due_cents: 0n, nsf_fees_due_cents: 0n, other_fees_due_cents: 0n, suspense_unapplied_cents: 0n, holds: [], trial_active: false, plan_active: false, partial_count_12m: 0, opted_out_of_50_rule: false, late_charge_pct: "5", late_charge_grace_days: 15, fees: [], overlays: [], ...o };
}
function harness(nowIso: string, loan: LoanCashState) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const store = new Map<string, LoanCashState>([[loan.loan_id, loan]]);
  const svc = new CashieringService({ events, ledger, clock, loans: { get: (id) => store.get(id), put: (s) => store.set(s.loan_id, s) }, custodial: { clearing: "C-CLR", pi: "C-PI", ti: "C-TI" } });
  const pay = (amount: bigint, on: string, extra: Record<string, unknown> = {}) => {
    const p = svc.receive({ channel: "portal_onetime", instrument: "ach", amount_cents: amount, received_at: `${on}T14:00:00.000Z`, loan_id: loan.loan_id, source_item_id: `${on}-${amount}`, ...extra }).payment;
    svc.identify(p.id, loan.loan_id); return svc.post(p.id);
  };
  return { clock, events, ledger, svc, pay, state: () => store.get(loan.loan_id)! };
}

// ───────── 2.2 ─────────
test("2.2-T1/T2 example C: 200,000¢ with a written commitment is held to 2026-10-10; 19,257¢ on 09-24 completes the payment credited 09-24; the 09-17 late charge remains", () => {
  const { pay, state, ledger } = harness("2026-09-10T14:00:00.000Z", L1());
  const r = pay(200_000n, "2026-09-10");
  assert.equal(r.plan.outcome, "unapplied");
  const d = decidePartial({ state: state(), days_delinquent: 9, commitment: { kind: "coupon_note", stated_date: D("2026-09-25") }, received_on: D("2026-09-10"), amount_cents: 200_000n, payment_id: r.payment.id, rail: "check" });
  assert.equal(d.kind, "hold"); if (d.kind === "hold") assert.equal(d.due_on, "2026-10-10");
  const item = openSuspenseItem({ state: state(), days_delinquent: 9, received_on: D("2026-09-10"), amount_cents: 200_000n, payment_id: r.payment.id, rail: "check" }, d);
  assert.equal(item.partial_commitment_due_on, "2026-10-10");
  assert.equal(ledger.balance({ scope: "custodial", custodialAccountId: "C-TI", account: "custodial_ti_unapplied_cash" }), 0n); // portal ACH lands direct in custodial P&I; office/lockbox items park in T&I unapplied
  // 2.7 assesses on 09-17 (full Monthly Payment not received by 09-16)
  const a = assessLateCharge({ state: state(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "assessed"); if (a.outcome === "assessed") { assert.equal(a.fee.amount_cents, 7_901n); assert.equal(a.grace_end_on, "2026-09-16"); recordFee(state(), a.fee); }
  const r2 = pay(19_257n, "2026-09-24");
  assert.equal(r2.plan.outcome, "applied");
  assert.deepEqual([r2.plan.installments[0]!.interest_cents, r2.plan.installments[0]!.principal_cents, r2.plan.installments[0]!.escrow_cents], [135_294n, 22_723n, 61_240n]);
  assert.equal(state().installments[0]!.credited_as_of, "2026-09-24");
  assert.equal(state().suspense_unapplied_cents, 0n);
  assert.equal(state().late_charges_due_cents, 7_901n);              // not deducted from a PITI payment
});

test("2.2-T3 example D: 215,000¢ with counter 2 → escrow 56,983¢, counter 3, no late charge; a fourth short payment is an ordinary partial", () => {
  const { pay, state } = harness("2026-09-08T14:00:00.000Z", L1({ partial_count_12m: 2 }));
  const r = pay(215_000n, "2026-09-08");
  assert.equal(r.plan.outcome, "applied_with_50_rule");
  assert.equal(r.plan.installments[0]!.escrow_cents, 56_983n);
  assert.equal(state().partial_count_12m, 3);
  assert.equal(assessLateCharge({ state: state(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 158_017n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  const r2 = pay(215_000n, "2026-10-05");
  assert.equal(r2.plan.outcome, "unapplied");
});

test("2.2-T4: non-escrowed loan short by 3,000¢ → $50 rule unavailable, four-condition path", () => {
  const plan = allocate(L1({ escrowed: false }), { payment_id: "x", amount_cents: 219_257n - 3_000n, received_on: D("2026-09-08"), credited_as_of: D("2026-09-08"), designation: "unspecified" });
  assert.equal(plan.outcome, "unapplied");
  assert.ok(plan.rule_path.includes("2.2:partial→suspense"));
});

test("2.2-T5/T6: nsf history at 45 days delinquent → hold_policy_override citing 'authorized to return'; referred + fc_risk → foreclosure_hold with a 2-BD decision", () => {
  const base = { received_on: D("2026-10-15"), amount_cents: 100_000n, payment_id: "p", rail: "ach_credit" as const, commitment: { kind: "contact_intent" as const } };
  const d5 = decidePartial({ ...base, state: L1({ nsf_count_12m: 1 }), days_delinquent: 45 });
  assert.equal(d5.kind, "hold_policy_override"); assert.match(d5.cite, /authorized to return/);
  const d6 = decidePartial({ ...base, state: L1({ fc_referred: true, partial_payment_fc_risk: true }), days_delinquent: 130 });
  assert.equal(d6.kind, "foreclosure_hold"); if (d6.kind === "foreclosure_hold") assert.equal(d6.decision_due_bd, 2);
  assert.equal(decidePartial({ ...base, commitment: null, state: L1(), days_delinquent: 10 }).kind, "contact_pending");
});

test("2.2-T7: the day-31 sweep returns lapsed partials by the original rail; the installment stays unpaid", () => {
  const items: SuspenseItem[] = [openSuspenseItem({ state: L1(), days_delinquent: 9, received_on: D("2026-09-10"), amount_cents: 200_000n, payment_id: "p", rail: "check" }, { kind: "hold", due_on: D("2026-10-10"), rule_path: "x", cite: "c" })];
  assert.equal(sweepReturns(items, D("2026-10-10"), () => 219_257n, () => 200_000n).length, 0);
  const returned = sweepReturns(items, D("2026-10-11"), () => 219_257n, () => 200_000n);
  assert.equal(returned.length, 1); assert.equal(returned[0]!.status, "returned"); assert.equal(returned[0]!.return_rail, "check");
});

test("2.2-T8: P falling from 219,257¢ to 99,000¢ makes 100,000¢ of unapplied funds a full payment credited on the activation date", () => {
  const s = L1({ suspense_unapplied_cents: 100_000n });
  s.installments = s.installments.map((i) => ({ ...i, pi_cents: 70_000n, escrow_cents: 29_000n }));
  const plan = allocate(s, { payment_id: "reeval", amount_cents: 0n, received_on: D("2026-11-01"), credited_as_of: D("2026-11-01"), designation: "contractual" });
  assert.equal(plan.outcome, "applied"); assert.equal(plan.installments[0]!.due_date, "2026-09-01"); assert.equal(plan.next.suspense_unapplied_cents, 1_000n);
});

test("2.2-T9: a PITI payment with $79.01 outstanding applies in full, diverts nothing, and no new charge accrues", () => {
  const { pay, state } = harness("2026-10-01T14:00:00.000Z", L1({ late_charges_due_cents: 7_901n }));
  state().installments[0]!.status = "satisfied";
  const r = pay(219_257n, "2026-10-01");
  assert.equal(r.plan.installments[0]!.due_date, "2026-10-01"); assert.equal(r.plan.late_charge_cents, 0n); assert.equal(state().late_charges_due_cents, 7_901n);
  assert.equal(assessLateCharge({ state: state(), installment_due_date: D("2026-10-01"), received_toward_basis_cents: 158_017n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
});

// ───────── 2.3 ─────────
const AUTH: Authorization = { borrower_name: "B", loan_number_masked: "******1234", routing: "021000021", account_last4: "9876", account_type: "checking", amount_rule: "full_periodic_payment", variable_amount_statement: true, frequency: "monthly", first_debit_on: D("2026-10-01"), authorized_on: D("2026-09-20"), company_name: "SUPERMORTGAGE", revocation_instructions: true, optional_statement: true, esign_consent: true, sec: "WEB" };

test("2.3-T1: WEB authorization checklist passes; no debit until validated", () => {
  assert.deepEqual(authorizationDefects(AUTH), []);
  assert.deepEqual(authorizationDefects({ ...AUTH, optional_statement: false, company_name: "SM" }), ["company_name", "optional_statement (Reg E 1005.10(e)(1))"]);
  assert.ok(authorizationDefects({ ...AUTH, sec: "TEL" }).includes("recording_ref"));
  const e = newEnrollment("L-1", AUTH, 1, 10_000n);
  assert.equal(enrollmentMachine.attempt("requested", "authorize", AGENT, {}).ok, true);
  const ok = enrollmentMachine.attempt("validating", "validation_result", AGENT, { validated: true }); assert.ok(ok.ok && ok.to === "active");
  const bad = enrollmentMachine.attempt("validating", "validation_result", AGENT, { validated: false }); assert.ok(bad.ok && bad.to === "requested");
  assert.equal(e.validation_status, "pending");
});

test("2.3-T2: draft day 20 is rejected (grace end = 16th); settlement rolls to keep inside the gate", () => {
  const v = validateDraftDay(20, 1, 15); assert.equal(v.ok, false); if (!v.ok) assert.equal(v.latest_day, 16);
  assert.equal(validateDraftDay(16, 1, 15).ok, true);
  assert.equal(settlementDateFor(D("2026-10-01"), 1, 15, servicer), "2026-10-01");      // Thursday
  assert.equal(settlementDateFor(D("2026-11-01"), 1, 15, servicer), "2026-11-02");      // Sunday → next banking day (still ≤ 16th)
  assert.equal(settlementDateFor(D("2026-08-01"), 16, 15, servicer), "2026-08-14");     // Aug 16, 2026 is Sunday; 17th would breach → preceding Friday
});

test("2.3-T3: a changed amount needs the 10-day notice; the annual statement stating amount and date satisfies it", () => {
  const e = newEnrollment("L-1", AUTH, 1, 10_000n); e.last_debit_cents = 229_257n;
  const miss = variableAmountNoticeStatus(e, 232_933n, D("2027-01-01"), D("2026-12-23"));
  assert.equal(miss.ok, false); if (!miss.ok) { assert.equal(miss.deadline, "2026-12-22"); assert.equal(miss.action, "hold_entry_escalate"); }
  e.notices.push({ template: "ESCROW-ANNUAL-v1", sent_on: D("2026-12-12"), amount_cents: 232_933n, debit_on: D("2027-01-01") });
  const hit = variableAmountNoticeStatus(e, 232_933n, D("2027-01-01"), D("2026-12-23")); assert.ok(hit.ok && hit.satisfied_by === "ESCROW-ANNUAL-v1");
});

test("2.3-T4: revocation after the file is transmitted → same-day PPD refund + officer notice; before → entry stopped", () => {
  assert.deepEqual(revocationEffect(D("2026-09-29"), D("2026-09-28"), D("2026-10-01")), { stop_entry: false, refund_same_day: true, officer_notice: true });
  assert.deepEqual(revocationEffect(D("2026-09-27"), D("2026-09-28"), D("2026-10-01")), { stop_entry: true, refund_same_day: false, officer_notice: false });
});

test("2.3-T5/T6/T7: R01 → reverse, fee, notice, one retry; third in 180 days refused; R10 cancels + fraud case; R11 within 60 days corrects, day 61 refuses", () => {
  const retryOn = (d: string) => D(d.slice(0, 8) + String(Number(d.slice(8)) + 5).padStart(2, "0"));
  const e = newEnrollment("L-1", AUTH, 1);
  const r1 = handleReturn(e, "R01", D("2027-02-03"), { authorization_valid: true, retryOn });
  assert.deepEqual([r1.reverse_payment, r1.assess_nsf_fee, r1.notice, r1.retry_on], [true, true, "AUTODRAFT-RETURN-v1", "2027-02-08"]);
  e.returns_on_current_installment = 0; handleReturn(e, "R01", D("2027-04-03"), { authorization_valid: true, retryOn });
  e.returns_on_current_installment = 0; const r3 = handleReturn(e, "R01", D("2027-06-03"), { authorization_valid: true, retryOn });
  assert.equal(r3.retry_on, null); assert.match(r3.refused!, /two reinitiations/);
  const e2 = newEnrollment("L-1", AUTH, 1); e2.returns_on_current_installment = 1;
  assert.equal(handleReturn(e2, "R01", D("2027-02-10"), { authorization_valid: true, retryOn }).enrollment_action, "suspended_returns");
  const r10 = handleReturn(newEnrollment("L-1", AUTH, 1), "R10", D("2027-02-03"), { authorization_valid: true, retryOn });
  assert.deepEqual([r10.enrollment_action, r10.retry_on, r10.open_fraud_case], ["revoked", null, true]);
  assert.equal(handleReturn(newEnrollment("L-1", AUTH, 1), "R11", D("2027-03-01"), { authorization_valid: true, defect_ours: true, original_entry_on: D("2027-01-05"), retryOn }).enrollment_action, "correct_and_reinitiate");
  assert.match(handleReturn(newEnrollment("L-1", AUTH, 1), "R11", D("2027-03-07"), { authorization_valid: true, defect_ours: true, original_entry_on: D("2027-01-05"), retryOn }).refused!, /60 days/);
  assert.equal(unauthorizedReturnRateAlert(6, 1000), true); assert.equal(unauthorizedReturnRateAlert(4, 1000), false);   // 2.3-T8
});

// ───────── 2.4 ─────────
test("2.4-T1/T2 example F: 319,257¢ with $1,000 principal → installment first, curtailment second, UPB 24,854,677¢; October split 134,630 / 23,387", () => {
  const { pay, state, events } = harness("2026-09-03T14:00:00.000Z", L1());
  const r = pay(319_257n, "2026-09-03", { curtailment_cents: 100_000n });
  assert.equal(r.plan.installments.length, 1); assert.equal(r.plan.curtailment_cents, 100_000n);
  assert.equal(state().upb_cents, 24_854_677n); assert.equal(state().lpi_date, "2026-09-01");
  assert.deepEqual(events.ofType("investor_events.created").map((e) => e.payload.type), ["payment.contractual", "payment.curtailment"]);
  assert.deepEqual(nextInstallmentSplit(state(), 158_017n), { interest_cents: 134_630n, principal_cents: 23_387n });
});

test("2.4-T3/T4: NIB order — amount ≥ IB UPB reduces NIB first; smaller amounts hit IB UPB", () => {
  const s = L1({ upb_cents: 1_500_000n, deferred_principal_cents: 2_000_000n, installments: [] });
  const big = allocate(s, { payment_id: "c", amount_cents: 1_600_000n, received_on: D("2026-09-03"), credited_as_of: D("2026-09-03"), designation: "curtailment" });
  assert.equal(big.next.deferred_principal_cents, 400_000n); assert.equal(big.next.upb_cents, 1_500_000n); assert.equal(big.curtailment_nib_cents, 1_600_000n);
  const small = allocate(s, { payment_id: "c", amount_cents: 100_000n, received_on: D("2026-09-03"), credited_as_of: D("2026-09-03"), designation: "curtailment" });
  assert.equal(small.next.upb_cents, 1_400_000n); assert.equal(small.next.deferred_principal_cents, 2_000_000n);
});

test("2.4-T5: 'principal only' 300,000¢ on a loan two installments behind cures one, holds the rest, no principal reduction, CURTAIL-REDIRECT sent", () => {
  const { pay, state, events } = harness("2026-10-20T14:00:00.000Z", L1());
  const r = pay(300_000n, "2026-10-20", { borrower_instruction_text: "principal only" });
  assert.equal(r.plan.installments.length, 1); assert.equal(r.plan.curtailment_cents, 0n); assert.equal(r.plan.redirected_curtailment, true);
  assert.equal(state().suspense_unapplied_cents, 300_000n - 219_257n); assert.equal(state().upb_cents, 24_977_400n - 22_723n);
  assert.equal(events.ofType("notice.queued")[0]!.payload.template, "CURTAIL-REDIRECT-v1");
});

test("2.4-T6/T7/T10: MBS reapplication refused; re-amortization computes new P&I, effective ≥30 days out, not a modification; full-payoff designation routes to 16.x", () => {
  const g = reapplicationGate(L1({ mbs_pool: true })); assert.equal(g.ok, false); if (!g.ok) assert.equal(g.suggest, "12.x_workout");
  const re = reamortize(L1({ upb_cents: 24_854_677n }), 300, D("2026-10-20"));
  assert.equal(re.effective_on, "2026-12-01"); assert.equal(re.counts_as_modification, false); assert.equal(re.form, "181");
  assert.equal(re.new_pi_cents, 167_821n);   // $248,546.77 @ 6.5% over 300 months → $1,678.21
  const plan = allocate(L1(), { payment_id: "po", amount_cents: 25_000_000n, received_on: D("2026-09-03"), credited_as_of: D("2026-09-03"), designation: "payoff" });
  assert.equal(plan.outcome, "payoff_routed"); assert.equal(plan.curtailment_cents, 0n);
});

// ───────── 2.5 ─────────
test("2.5-T1/T2/T3: prepaid contractor remittance; halves accumulate with 1¢ residual; PRIN addenda curtails after the installment", () => {
  const cur = L1(); cur.installments[0]!.status = "satisfied";
  const h = harness("2026-09-28T14:00:00.000Z", cur);
  const r = h.pay(219_257n, "2026-09-28"); assert.equal(r.plan.outcome, "prepaid"); assert.equal(h.state().installments[1]!.credited_as_of, "2026-09-28");
  const cur2 = L1(); cur2.installments[0]!.status = "satisfied";
  const h2 = harness("2026-09-14T14:00:00.000Z", cur2);
  assert.equal(h2.pay(109_629n, "2026-09-14").plan.outcome, "unapplied");
  const r2 = h2.pay(109_629n, "2026-09-28"); assert.equal(r2.plan.outcome, "prepaid"); assert.equal(h2.state().suspense_unapplied_cents, 1n);
  assert.equal(designatedPrincipalFromAddenda("PRIN 219257"), 219_257n);
  const cur3 = L1({}, D("2027-04-01"), 1); cur3.upb_cents = 24_800_000n;
  const h3 = harness("2027-03-28T14:00:00.000Z", cur3);
  const r3 = h3.pay(438_514n, "2027-03-28", { curtailment_cents: designatedPrincipalFromAddenda("PRIN 219257") });
  assert.equal(r3.plan.installments.length, 1); assert.equal(r3.plan.curtailment_cents, 219_257n);
  assert.deepEqual(h3.events.ofType("investor_events.created").map((e) => e.payload.type), ["payment.prepaid", "payment.curtailment"]);
});

test("2.5-T5/T6: a stale half converts to partial_payment after 45 days; true biweekly interest is 14 days on the UPB", () => {
  const items: SuspenseItem[] = [{ id: "i", loan_id: "L-1", payment_id: "p", amount_cents: 109_629n, received_on: D("2026-09-14"), reason_code: "biweekly_accumulation", status: "open", partial_commitment_due_on: null, rule_path: "" }];
  assert.equal(reclassifyStaleHalves(items, D("2026-10-29")).length, 0);
  assert.equal(reclassifyStaleHalves(items, D("2026-10-30")).length, 1); assert.equal(items[0]!.reason_code, "partial_payment"); assert.equal(items[0]!.partial_commitment_due_on, "2026-11-29");
  assert.equal(biweeklyInterest(24_977_400n, "6.500"), 62_272n);       // 24,977,400 × 0.065 × 14 / 365 = 62,272.42
  const a = newArrangement("L-1", "1234567890");
  assert.equal(arrangementMachine.attempt(a.status, "verify", AGENT, { matched: false }).ok, false);
  assert.equal(arrangementMachine.attempt(a.status, "verify", AGENT, { matched: true }).ok, true);
  assert.equal(returnClockSuspended({ ...a, status: "active" }, 20), true); assert.equal(returnClockSuspended({ ...a, status: "active" }, 31), false);
});

// ───────── 2.6 ─────────
test("2.6-T1/T2/T4 example J: trial receipts held, contractual installments applied on accumulation, residual 149,186¢ reduces capitalization, booking refused until late charges waived", () => {
  const s = L1({ lpi_date: D("2026-06-01"), trial_active: true }, D("2026-07-01"), 6);
  for (const d of ["2026-07-17", "2026-08-17", "2026-09-17"]) recordFee(s, { id: d, fee_type: "late_charge", installment_due_date: D(d.slice(0, 8) + "01"), amount_cents: 7_901n, state: "assessed", assessed_on: D(d), collected_cents: 0n });
  const trial = newTrial("SMDU-1", "L-1", [{ due_on: D("2026-10-01"), amount_cents: 195_900n }, { due_on: D("2026-11-01"), amount_cents: 195_900n }, { due_on: D("2026-12-01"), amount_cents: 195_900n }]);
  let r = trialReceipt(trial, s, 195_900n, D("2026-10-01"));
  assert.equal(r.trial_month!.status, "satisfied"); assert.equal(r.contractual, null); assert.equal(trial.held_cents, 195_900n); assert.equal(trial.smdu_submissions.length, 1);
  r = trialReceipt(trial, r.state, 195_900n, D("2026-11-02"));
  assert.equal(r.contractual!.installments[0]!.due_date, "2026-07-01"); assert.equal(r.contractual!.installments[0]!.interest_cents, 135_294n); assert.equal(r.state.installments[0]!.credited_as_of, "2026-11-02");
  assert.equal(trial.held_cents, 172_543n); assert.equal(r.state.upb_cents, 24_954_677n); assert.equal(r.state.trial_active, true);
  r = trialReceipt(trial, r.state, 195_900n, D("2026-12-01"));
  assert.equal(r.contractual!.installments[0]!.due_date, "2026-08-01"); assert.equal(r.contractual!.installments[0]!.interest_cents, 135_171n); assert.equal(trial.held_cents, 149_186n); assert.equal(r.state.upb_cents, 24_931_831n);
  assert.deepEqual(trialMonthEnd(trial, D("2026-12-31")), { missed: null, failed: false });
  const done = trialCompletion(trial, { interest_cents: 540_188n, escrow_advances_cents: 0n });
  assert.equal(done.residual_cents, 149_186n); assert.equal(done.capitalized_interest_cents, 391_002n); assert.equal(done.curtailment_cents, 0n);
  const gate = bookingGate(r.state); assert.equal(gate.ok, false);
  assert.equal(waiveAll(r.state, "trial_conversion", AGENT), 23_703n);
  assert.equal(bookingGate(r.state).ok, true);
});

test("2.6-T3/T8: an unpaid trial month at month-end fails the trial and releases suspended charges; a 219,257¢ receipt satisfies the month and applies an installment", () => {
  const trial = newTrial("SMDU-2", "L-1", [{ due_on: D("2026-10-01"), amount_cents: 195_900n }, { due_on: D("2026-11-01"), amount_cents: 195_900n }, { due_on: D("2026-12-01"), amount_cents: 195_900n }]);
  const s = L1({ trial_active: true, overlays: [{ kind: "trial_pending_waiver", from: D("2026-09-10") }] }, D("2026-07-01"), 6);
  const a = assessLateCharge({ state: s, installment_due_date: D("2026-10-01"), received_toward_basis_cents: 0n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "accrued_suspended"); if (a.outcome === "accrued_suspended") recordFee(s, a.fee);
  assert.equal(s.late_charges_due_cents, 0n);
  trialReceipt(trial, s, 195_900n, D("2026-10-01")); trialReceipt(trial, s, 195_900n, D("2026-11-02"));
  const me = trialMonthEnd(trial, D("2026-12-31")); assert.equal(me.failed, true); assert.equal(trial.status, "trial_failed");
  assert.equal(releaseSuspended(s, "trial_pending_waiver").length, 1); assert.equal(s.late_charges_due_cents, 7_901n);
  const t8 = newTrial("SMDU-3", "L-1", [{ due_on: D("2026-10-01"), amount_cents: 195_900n }]);
  const r = trialReceipt(t8, L1({ trial_active: true }, D("2026-07-01"), 6), 219_257n, D("2026-10-01"));
  assert.equal(r.trial_month!.status, "satisfied"); assert.equal(r.contractual!.installments.length, 1); assert.equal(t8.held_cents, 0n);
});

// ───────── 2.7 ─────────
test("2.7-T1/T3 examples K and M: 7,901¢ assessed once on 09-17; an on-time October payment is not charged (no pyramiding); disclosure fields", () => {
  const s = L1();
  const a = assessLateCharge({ state: s, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(a.outcome, "assessed"); if (a.outcome === "assessed") { assert.equal(a.fee.amount_cents, 7_901n); assert.equal(a.fee.grace_end_on, "2026-09-16"); recordFee(s, a.fee); }
  assert.equal(assessLateCharge({ state: s, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-18"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  assert.equal(assessLateCharge({ state: s, installment_due_date: D("2026-10-01"), received_toward_basis_cents: 158_017n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  assert.deepEqual(lateFeeDisclosure(s, D("2026-10-01")), { late_fee_amount_if_unpaid: 7_901n, late_fee_date: D("2026-10-17") });
  assert.equal(lateChargeAmount(158_017n, "5", 5_000n), 5_000n);
});

test("2.7-T2: the posting backlog gate defers assessment", () => {
  assert.equal(assessLateCharge({ state: L1(), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 1 }).outcome, "deferred_backlog");
});

test("2.7-T4/T5/T6 examples L, N, O: transfer shield, forbearance default date, SCRA", () => {
  assert.equal(assessLateCharge({ state: L1({ transfer_shield_until: D("2026-10-30") }), installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  const fb = L1({ overlays: [{ kind: "forbearance_active", from: D("2026-10-01"), to: D("2026-12-31"), defaulted_on: D("2026-11-20") }] }, D("2026-10-01"), 3);
  assert.equal(assessLateCharge({ state: fb, installment_due_date: D("2026-10-01"), received_toward_basis_cents: 0n, run_on: D("2026-10-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  assert.equal(assessLateCharge({ state: fb, installment_due_date: D("2026-11-01"), received_toward_basis_cents: 0n, run_on: D("2026-11-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
  assert.equal(assessLateCharge({ state: fb, installment_due_date: D("2026-12-01"), received_toward_basis_cents: 0n, run_on: D("2026-12-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "assessed");
  const scra = L1({ overlays: [{ kind: "scra_reduced_rate", from: D("2026-10-15") }] }, D("2026-11-01"), 2);
  assert.equal(assessLateCharge({ state: scra, installment_due_date: D("2026-11-01"), received_toward_basis_cents: 0n, run_on: D("2026-11-17"), unposted_receipts_on_or_before_grace: 0 }).outcome, "not_assessed");
});

test("2.7-T7/T8/T11/T12: plan completion waives accrued charges; Chapter 13 charges accrue suspended with incurred dates; second courtesy waiver needs officer; re-dating reverses", () => {
  const plan = L1({ overlays: [{ kind: "repayment_plan_pending_waiver", from: D("2026-09-01") }] });
  const a = assessLateCharge({ state: plan, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  if (a.outcome === "accrued_suspended") recordFee(plan, a.fee);
  assert.equal(waiveAll(plan, "workout_completion", AGENT), 7_901n); assert.equal(plan.fees![0]!.state, "waived");
  const bk = L1({ overlays: [{ kind: "bankruptcy_active", from: D("2026-08-20") }] });
  const b = assessLateCharge({ state: bk, installment_due_date: D("2026-09-01"), received_toward_basis_cents: 0n, run_on: D("2026-09-17"), unposted_receipts_on_or_before_grace: 0 });
  assert.equal(b.outcome, "accrued_suspended"); if (b.outcome === "accrued_suspended") { assert.equal(b.fee.suppression, "bankruptcy_active"); assert.equal(b.fee.assessed_on, "2026-09-17"); recordFee(bk, b.fee); }
  assert.equal(bk.late_charges_due_cents, 0n);
  const c = L1(); recordFee(c, { id: "f1", fee_type: "late_charge", installment_due_date: D("2026-09-01"), amount_cents: 7_901n, state: "assessed", assessed_on: D("2026-09-17"), collected_cents: 0n }); recordFee(c, { id: "f2", fee_type: "late_charge", installment_due_date: D("2026-10-01"), amount_cents: 7_901n, state: "assessed", assessed_on: D("2026-10-17"), collected_cents: 0n });
  assert.equal(waiveLateCharge(c, "f1", "courtesy", AGENT).ok, true);
  const second = waiveLateCharge(c, "f2", "courtesy", AGENT); assert.equal(second.ok, false); if (!second.ok) assert.equal(second.code, "NEEDS_OFFICER");
  assert.equal(waiveLateCharge(c, "f2", "courtesy", OFFICER).ok, true);
  const rd = L1(); recordFee(rd, { id: "f3", fee_type: "late_charge", installment_due_date: D("2026-09-01"), amount_cents: 7_901n, state: "collected", assessed_on: D("2026-09-17"), collected_cents: 7_901n });
  const rev = reverseOnRedate(rd, D("2026-09-01"), D("2026-09-01"));
  assert.equal(rev.reversed!.state, "reversed"); assert.equal(rev.refund_cents, 7_901n); assert.equal(rev.credit_reporting_correction, true);
});

test("2.7-T10: NSF fee 2,500¢ where allowed with a $30 cap, capped by a lower cap, none where disallowed or for our error", () => {
  const s = L1();
  assert.equal(nsfFee(s, { allowed: true, cap_cents: 3_000n }, { our_error: false, returned_on: D("2027-02-03") })!.amount_cents, 2_500n);
  assert.equal(nsfFee(s, { allowed: true, cap_cents: 1_500n }, { our_error: false, returned_on: D("2027-02-03") })!.amount_cents, 1_500n);
  assert.equal(nsfFee(s, { allowed: false, cap_cents: null }, { our_error: false, returned_on: D("2027-02-03") }), null);
  assert.equal(nsfFee(s, { allowed: true, cap_cents: null }, { our_error: true, returned_on: D("2027-02-03") }), null);
  assert.equal(nsfFee(L1({ overlays: [{ kind: "bankruptcy_active", from: D("2027-01-01") }] }), { allowed: true, cap_cents: null }, { our_error: false, returned_on: D("2027-02-03") }), null);
});

test("2.5 rule 5 / F-1-09 (AUDIT-REPORT item 5): a true biweekly note accrues 14 days' interest on the UPB as of the LPI date per installment; a monthly note keeps 30 days", () => {
  const bi = L1({ escrowed: false, note_frequency: "biweekly" }); const expected = biweeklyInterest(bi.upb_cents, bi.note_rate_pct);
  const plan = allocate(bi, { payment_id: "bw", amount_cents: 219_257n, received_on: D("2026-09-08"), credited_as_of: D("2026-09-08"), designation: "contractual" });
  assert.ok(plan.installments.length >= 1); assert.equal(plan.installments[0]!.interest_cents, expected);
  const mo = L1({ escrowed: false }); const monthly = allocate(mo, { payment_id: "mo", amount_cents: 219_257n, received_on: D("2026-09-08"), credited_as_of: D("2026-09-08"), designation: "contractual" });
  assert.notEqual(monthly.installments[0]!.interest_cents, expected); assert.ok(monthly.installments[0]!.interest_cents > expected);
});
