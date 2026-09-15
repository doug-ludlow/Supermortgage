/**
 * §2.6 Payment during modification pending (trial period) — the cashiering
 * overlay: cumulative monthly trial receipts, held funds, contractual
 * application when Σ held ≥ pre-mod PITI, month-end sweep, completion
 * residual, and late-charge suspension/waiver.
 */
import { type PlainDate, parts, endOfMonth, startOfMonth, addMonths } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { allocate, type AllocationPlan } from "./allocation.ts";
import type { LoanCashState } from "./types.ts";

export interface TrialMonth { readonly due_on: PlainDate; readonly amount_cents: Cents; received_cents: Cents; status: "pending" | "satisfied" | "missed"; }
export interface TrialOverlay {
  readonly case_id: string; readonly loan_id: string; months: TrialMonth[]; status: "trial_active" | "trial_completed" | "modification_effective" | "trial_failed";
  held_cents: Cents; applied_cents: Cents; smdu_submissions: { on: PlainDate; amount_cents: Cents; trial_number: number; via: "b2b" | "human_portal_task" }[];
  /** Dates on which held trial funds were applied as a contractual installment (rule 2) — IRM 4-03's LAR sequencing reads them (rule 7). */
  contractual_applications: PlainDate[];
}

export function newTrial(caseId: string, loanId: string, months: { due_on: PlainDate; amount_cents: Cents }[]): TrialOverlay {
  return { case_id: caseId, loan_id: loanId, months: months.map((m) => ({ ...m, received_cents: 0n, status: "pending" })), status: "trial_active", held_cents: 0n, applied_cents: 0n, smdu_submissions: [], contractual_applications: [] };
}

function monthOf(d: PlainDate): string { return d.slice(0, 7); }

export interface TrialReceiptResult { readonly trial_month: TrialMonth | null; readonly satisfied_now: boolean; readonly contractual: AllocationPlan | null; readonly state: LoanCashState; }

/** 2.6 rule 2: credit the receipt to the current trial month; hold; apply one contractual installment when Σ held ≥ contractual PITI. */
export function trialReceipt(trial: TrialOverlay, state: LoanCashState, amount: Cents, receivedOn: PlainDate, smduAvailable = true): TrialReceiptResult {
  const tm = trial.months.find((m) => monthOf(m.due_on) === monthOf(receivedOn) && m.status !== "missed") ?? trial.months.find((m) => m.status === "pending") ?? null;
  let satisfiedNow = false;
  if (tm) {
    const was = tm.status; tm.received_cents += amount;
    if (tm.status === "pending" && tm.received_cents >= tm.amount_cents) { tm.status = "satisfied"; satisfiedNow = was !== "satisfied"; }
    trial.smdu_submissions.push({ on: receivedOn, amount_cents: amount, trial_number: trial.months.indexOf(tm) + 1, via: smduAvailable ? "b2b" : "human_portal_task" });
  }
  trial.held_cents += amount;
  let contractual: AllocationPlan | null = null; let next = state;
  const oldest = state.installments.filter((i) => i.status === "due").sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
  if (oldest && trial.held_cents >= oldest.pi_cents + oldest.escrow_cents) {
    const P = oldest.pi_cents + oldest.escrow_cents;
    // Apply exactly one installment from held funds; the remainder stays held (not in loan suspense).
    const plan = allocate({ ...state, suspense_unapplied_cents: 0n, trial_active: false }, { payment_id: `trial:${trial.case_id}:${receivedOn}`, amount_cents: P, received_on: receivedOn, credited_as_of: receivedOn, designation: "contractual", bypass_overlays: true });
    contractual = plan; next = { ...plan.next, trial_active: true, suspense_unapplied_cents: state.suspense_unapplied_cents };
    trial.held_cents -= P; trial.applied_cents += P;
    (trial.contractual_applications ??= []).push(receivedOn);
  }
  return { trial_month: tm, satisfied_now: satisfiedNow, contractual, state: next };
}

/** 2.6 month-end sweep: an unsatisfied trial month at 23:59 on its month end is missed → trial failed. */
export function trialMonthEnd(trial: TrialOverlay, monthEnd: PlainDate): { missed: TrialMonth | null; failed: boolean } {
  const tm = trial.months.find((m) => endOfMonth(m.due_on) === monthEnd);
  if (!tm || tm.status !== "pending") return { missed: null, failed: false };
  tm.status = "missed"; trial.status = "trial_failed";
  return { missed: tm, failed: true };
}

/**
 * 2.6 rule 5 / F-1-27: the modification's effective date. Default: "the first day of the month following the Trial Period Plan".
 * Under the servicer's written equal-treatment cut-off-date policy (F-1-27: "the date by which the final Trial Period Plan payment
 * must be submitted", which must fall after the final trial payment's due date) the modification "becomes effective on the first
 * day of the second month following the final Trial Period Plan payment", and the month in between is the "processing month":
 * "the borrower will not be required to make an additional Trial Period Plan payment" in it — there is no schedule row for it, so
 * `FNMA_D23206_TRIAL_PAYMENT_EOM` (armed per row) never evaluates it and `trialMonthEnd` finds nothing to miss.
 */
export interface EffectiveDatePolicy { readonly cut_off_on: PlainDate; readonly policy_ref: string; }
export function modificationEffectiveDate(trial: TrialOverlay, policy: EffectiveDatePolicy | null = null): { effective_on: PlainDate; processing_month: string | null; basis: string } {
  const last = trial.months[trial.months.length - 1];
  if (!last) throw new RangeError("modificationEffectiveDate: the trial has no schedule rows");
  const firstOfNext = addMonths(startOfMonth(last.due_on), 1);
  if (!policy) return { effective_on: firstOfNext, processing_month: null, basis: "F-1-27: effective on the first day of the month following the Trial Period Plan" };
  if (policy.cut_off_on <= last.due_on) throw new RangeError(`modificationEffectiveDate: the cut-off date ${policy.cut_off_on} must fall after the final trial payment's due date ${last.due_on} (F-1-27)`);
  return { effective_on: addMonths(startOfMonth(last.due_on), 2), processing_month: monthOf(firstOfNext), basis: `F-1-27 (written cut-off-date policy ${policy.policy_ref}, cut-off ${policy.cut_off_on}): effective on the first day of the second month following the final Trial Period Plan payment; no trial payment is due in the processing month ${monthOf(firstOfNext)}` };
}
/** True when `d` falls in the payment-free processing month between the final trial month and the effective date (F-1-27). */
export function isProcessingMonth(trial: TrialOverlay, effectiveOn: PlainDate, d: PlainDate): boolean {
  const last = trial.months[trial.months.length - 1];
  if (!last) return false;
  const firstOfNext = addMonths(startOfMonth(last.due_on), 1);
  return monthOf(d) === monthOf(firstOfNext) && monthOf(effectiveOn) > monthOf(firstOfNext);
}

/**
 * 2.6 rule 7 / IRM 4-03: "If, in the final month of the trial period, the sum of unapplied trial period payments is equal to or
 * greater than a full contractual payment on the underlying mortgage loan, and the mortgage loan modification is closed in the
 * same month, the servicer must report the contractual payment before the post-modification balances can be reported. This will
 * require two LARs and two reporting cycles to complete." Otherwise one post-modification LAR.
 */
export interface LarSequence { readonly lars: 1 | 2; readonly cycles: 1 | 2; readonly contractual_lar_cycle: string | null; readonly post_modification_lar_cycle: string; readonly cite: string; }
export function larSequenceAtClosing(trial: TrialOverlay, closedOn: PlainDate): LarSequence {
  const last = trial.months[trial.months.length - 1];
  if (!last) throw new RangeError("larSequenceAtClosing: the trial has no schedule rows");
  const finalMonth = monthOf(last.due_on);
  const contractualInFinalMonth = (trial.contractual_applications ?? []).some((d) => monthOf(d) === finalMonth);
  const cite = "IRM 4-03: contractual payment reported before the post-modification balances — two LARs and two reporting cycles";
  if (contractualInFinalMonth && monthOf(closedOn) === finalMonth) return { lars: 2, cycles: 2, contractual_lar_cycle: finalMonth, post_modification_lar_cycle: monthOf(addMonths(startOfMonth(last.due_on), 1)), cite };
  return { lars: 1, cycles: 1, contractual_lar_cycle: contractualInFinalMonth ? finalMonth : null, post_modification_lar_cycle: monthOf(closedOn), cite: "IRM 4-03: one post-modification LAR (no final-month contractual application closed in the same month)" };
}

/** 2.6 rule 5: residual = Σ held − Σ applied reduces capitalizable arrears (interest first, then escrow advances); excess curtails. */
export function trialCompletion(trial: TrialOverlay, arrears: { interest_cents: Cents; escrow_advances_cents: Cents }): { residual_cents: Cents; applied_to_interest_cents: Cents; applied_to_escrow_advances_cents: Cents; curtailment_cents: Cents; capitalized_interest_cents: Cents; capitalized_escrow_cents: Cents } {
  if (trial.months.some((m) => m.status !== "satisfied")) throw new Error("trial not complete");
  trial.status = "trial_completed";
  const residual = trial.held_cents;
  const toInt = residual < arrears.interest_cents ? residual : arrears.interest_cents;
  const left1 = residual - toInt;
  const toEsc = left1 < arrears.escrow_advances_cents ? left1 : arrears.escrow_advances_cents;
  const curt = left1 - toEsc;
  trial.held_cents = 0n;
  return { residual_cents: residual, applied_to_interest_cents: toInt, applied_to_escrow_advances_cents: toEsc, curtailment_cents: curt, capitalized_interest_cents: arrears.interest_cents - toInt, capitalized_escrow_cents: arrears.escrow_advances_cents - toEsc };
}

/** 2.6-T4: booking is refused while any late charge on the loan is unwaived. */
export function bookingGate(state: LoanCashState): { ok: true } | { ok: false; reason: string } {
  const open = (state.fees ?? []).filter((f) => f.fee_type === "late_charge" && (f.state === "assessed" || f.state === "accrued_suspended"));
  return open.length ? { ok: false, reason: `${open.length} late charge(s) must be waived (fee.waived{reason=trial_conversion}) before booking` } : { ok: true };
}

export function trialMonthFor(trial: TrialOverlay, d: PlainDate): TrialMonth | undefined { const { y, m } = parts(d); return trial.months.find((t) => t.due_on.startsWith(`${y}-${String(m).padStart(2, "0")}`)); }

/** 2.6 edge case / T7: a returned trial item reduces the month's `received_cents`; the borrower is contacted the same day so replacement funds can arrive before month-end. */
export function trialReturn(trial: TrialOverlay, amount: Cents, returnedOn: PlainDate): { trial_month: TrialMonth | null; contact_borrower_on: PlainDate; month_short_cents: Cents } {
  const tm = trial.months.find((m) => monthOf(m.due_on) === monthOf(returnedOn)) ?? null;
  if (tm) { tm.received_cents -= amount; if (tm.received_cents < tm.amount_cents && tm.status === "satisfied") tm.status = "pending"; }
  trial.held_cents -= amount;
  return { trial_month: tm, contact_borrower_on: returnedOn, month_short_cents: tm ? (tm.amount_cents > tm.received_cents ? tm.amount_cents - tm.received_cents : 0n) : 0n };
}
/** 2.6-T5: held trial funds are disclosed on the periodic statement with instructions (§1026.41(d)(3)/(d)(5)). */
export function trialStatementDisclosure(trial: TrialOverlay): { suspense_held_cents: Cents; suspense_instructions: string } {
  const next = trial.months.find((m) => m.status === "pending");
  const need = next ? next.amount_cents - next.received_cents : 0n;
  return { suspense_held_cents: trial.held_cents, suspense_instructions: `We are holding ${trial.held_cents} cents received under your trial period plan. ${need > 0n ? `We need ${need} cents more to satisfy the trial payment due ${next!.due_on}.` : "Your current trial payment is satisfied."} Funds are applied when the trial completes or a full contractual payment accumulates.` };
}
