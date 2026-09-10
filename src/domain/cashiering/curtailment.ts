/**
 * §2.4 Additional principal — re-amortization (Form 181) and the MBS
 * reapplication gate. Curtailment application itself (ordering, NIB rule,
 * delinquent redirect) is inside the Allocation Engine.
 */
import { levelPayment, ratePercent, monthlyInterest } from "../../kernel/money/cents.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, parts, ymd, addMonths } from "../../kernel/calendar/date.ts";
import { cashCfg, type LoanCashState } from "./types.ts";
import { allocate } from "./allocation.ts";

export interface Reamortization { readonly upb_cents: Cents; readonly note_rate_pct: string; readonly remaining_term_months: number; readonly new_pi_cents: Cents; readonly executed_on: PlainDate; readonly effective_on: PlainDate; readonly form: "181"; readonly counts_as_modification: false; }

/** 2.4 rule 6: new P&I = round_half_up(UPB × r / (1 − (1+r)^−n)); effective with the first installment due ≥ 30 days after execution [policy]. */
export function reamortize(state: LoanCashState, remainingTermMonths: number, executedOn: PlainDate): Reamortization {
  const new_pi_cents = levelPayment(state.upb_cents, ratePercent(state.note_rate_pct), remainingTermMonths);
  const earliest = addDays(executedOn, 30);
  const { y, m } = parts(earliest);
  let eff = ymd(y, m, 1); if (eff < earliest) eff = addMonths(eff, 1);
  return { upb_cents: state.upb_cents, note_rate_pct: state.note_rate_pct, remaining_term_months: remainingTermMonths, new_pi_cents, executed_on: executedOn, effective_on: eff, form: "181", counts_as_modification: false };
}

/** 2.4 worked example H: a designated curtailment received separately on a current loan, applied through the Allocation Engine (F-1-09: curtailment first). */
export function applyCurtailment(state: LoanCashState, amountCents: Cents, on: PlainDate): { state: LoanCashState; curtailment_cents: Cents; upb_after_cents: Cents } {
  const plan = allocate(state, { payment_id: `curtailment:${on}`, amount_cents: amountCents, received_on: on, credited_as_of: on, designation: "curtailment" });
  return { state: plan.next, curtailment_cents: plan.curtailment_cents, upb_after_cents: plan.next.upb_cents };
}

/** 2.4 rule 6: the re-amortized P&I takes effect for every installment due on/after `effective_on` as a new `loan_terms` version. */
export function activateReamortizedTerms(state: LoanCashState, re: Reamortization): { state: LoanCashState; loan_terms_version: number } {
  const version = cashCfg(state).termsVersion + 1;
  const next: LoanCashState = { ...state, loan_terms_version: version, installments: state.installments.map((i) => (i.due_date >= re.effective_on && i.status === "due" ? { ...i, pi_cents: re.new_pi_cents } : { ...i })) };
  return { state: next, loan_terms_version: version };
}

/** 2.4 rule 5 gate: MBS loans cannot reapply prepayments to cure delinquency → 12.x workout. */
export function reapplicationGate(state: LoanCashState): { ok: true } | { ok: false; reason: string; suggest: "12.x_workout" } {
  return cashCfg(state).mbs ? { ok: false, reason: "MBS loans are ineligible for reapplication of prepayments (portfolio/non-MBS participation only)", suggest: "12.x_workout" } : { ok: true };
}

/** The next installment's split on the current (post-curtailment) UPB — 2.4 example F. */
export function nextInstallmentSplit(state: LoanCashState, piCents: Cents): { interest_cents: Cents; principal_cents: Cents } {
  const interest = monthlyInterest(state.upb_cents, ratePercent(state.note_rate_pct));
  return { interest_cents: interest, principal_cents: piCents - interest };
}
