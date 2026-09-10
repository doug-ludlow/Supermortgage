/**
 * §2.6 Payment during modification pending (trial period) — the cashiering
 * overlay: cumulative monthly trial receipts, held funds, contractual
 * application when Σ held ≥ pre-mod PITI, month-end sweep, completion
 * residual, and late-charge suspension/waiver.
 */
import { type PlainDate, parts, endOfMonth } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { allocate, type AllocationPlan } from "./allocation.ts";
import type { LoanCashState } from "./types.ts";

export interface TrialMonth { readonly due_on: PlainDate; readonly amount_cents: Cents; received_cents: Cents; status: "pending" | "satisfied" | "missed"; }
export interface TrialOverlay {
  readonly case_id: string; readonly loan_id: string; months: TrialMonth[]; status: "trial_active" | "trial_completed" | "modification_effective" | "trial_failed";
  held_cents: Cents; applied_cents: Cents; smdu_submissions: { on: PlainDate; amount_cents: Cents; trial_number: number; via: "b2b" | "human_portal_task" }[];
}

export function newTrial(caseId: string, loanId: string, months: { due_on: PlainDate; amount_cents: Cents }[]): TrialOverlay {
  return { case_id: caseId, loan_id: loanId, months: months.map((m) => ({ ...m, received_cents: 0n, status: "pending" })), status: "trial_active", held_cents: 0n, applied_cents: 0n, smdu_submissions: [] };
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
