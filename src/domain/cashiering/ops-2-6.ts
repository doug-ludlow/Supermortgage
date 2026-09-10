/**
 * §2.6 process-owned operations over ./ops.ts (CashieringOps) and ./trial.ts — the conversion hand-off between
 * cashiering and 12.8 and the trial late-charge overlay the `fees.suspend/waive` tool drives:
 *
 *   - `suspendLateCharge` (rule 3): a late charge assessed under the note during the trial is carried as
 *     `accrued_suspended{trial_pending_waiver}` — not billed, never collected from trial funds — until conversion
 *     waives it (`late_charges.all_waived{reason=trial_conversion}`) or failure releases it (D2-3.2-06).
 *   - `computeCapitalization` (rule 5, F-1-27 step 1): the modification capitalization computation as 12.8 runs
 *     it on cashiering's figures — the residual already applied to arrears, then unpaid interest, escrow advances,
 *     servicing advances and any prior NIB; late charges are excluded outright ("Late charges may not be
 *     capitalized and must be waived if the borrower satisfies all conditions of the Trial Period Plan"). It emits
 *     `lossmit.modification.capitalization_computed` — the trigger of `FNMA_F127_LC_NOT_CAPITALIZED_GATE`, whose
 *     evaluator (`2.6.lateChargesExcludedFromCapitalization`) reads `late_charges_in_capitalization_cents` — and an
 *     attempt to roll late charges in is refused (breach action "refused").
 *   - `completeTrial` (rule 5): trial completion (residual to arrears, interest first, then escrow advances; excess
 *     curtails) followed by the capitalization computed on what is left.
 *   - `bookModification` (T4): 12.8's booking command as this process asserts it — residual gate closed
 *     (`FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0`), capitalization computed without late charges
 *     (`FNMA_F127_LC_NOT_CAPITALIZED_GATE`), every late charge on the loan waived
 *     (`FNMA_D23206_LC_WAIVE_ON_CONVERSION_0`); "a booking attempt with an unwaived late charge is refused".
 *
 * Money is bigint cents; dates are PlainDate; nothing here edits a row — state changes are events.
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { CashieringOps, CASHIERING_OPS_ACTOR, type OpsDeps } from "./ops.ts";
import { bookingGate, trialCompletion as pureTrialCompletion, type TrialOverlay } from "./trial.ts";
import type { LoanCashState, Fee } from "./types.ts";

type Payload = Record<string, unknown>;
const str = (c: Cents): string => c.toString();
export const TRIAL_SUPPRESSION = "trial_pending_waiver" as const;
const F127 = "Servicing Guide F-1-27 (08/13/2025): late charges may not be capitalized and must be waived if the borrower satisfies all conditions of the Trial Period Plan";

/** Inputs to the capitalization computation — the arrears left after the trial residual (rule 5) plus advances (F-1-27 step 1). */
export interface CapitalizationInput {
  readonly interest_cents: Cents;
  readonly escrow_advances_cents: Cents;
  readonly servicing_advances_cents?: Cents;
  /** Non-interest-bearing balance from a prior modification/deferral rolled into the new gross UPB (F-1-27 step 1). */
  readonly prior_nib_cents?: Cents;
  /** An attempt to roll late charges into the capitalized amount — refused (F-1-27). */
  readonly late_charges_cents?: Cents;
}
export interface CapitalizationComputed {
  readonly case_id: string;
  readonly effective_date: PlainDate;
  readonly capitalization_date: PlainDate;
  readonly capitalized_interest_cents: Cents;
  readonly capitalized_escrow_advances_cents: Cents;
  readonly capitalized_servicing_advances_cents: Cents;
  readonly prior_nib_cents: Cents;
  readonly capitalized_total_cents: Cents;
  /** Always 0n — the F-1-27 gate's fact. */
  readonly late_charges_in_capitalization_cents: Cents;
  /** Open late charges on the loan (assessed + accrued_suspended) that the computation left out — waived at conversion. */
  readonly late_charges_excluded_cents: Cents;
}

export class CapitalizationRefused extends Error {
  readonly code = "FNMA_F127_LC_NOT_CAPITALIZED_GATE";
  readonly reason: string;
  constructor(reason: string) { super(`capitalization refused [FNMA_F127_LC_NOT_CAPITALIZED_GATE]: ${reason}`); this.name = "CapitalizationRefused"; this.reason = reason; }
}
export type BookingRefusalCode = "TRIAL_NOT_COMPLETE" | "TRIAL_FAILED" | "RESIDUAL_GATE_OPEN" | "CAPITALIZATION_NOT_COMPUTED" | "LATE_CHARGE_IN_CAPITALIZATION" | "LATE_CHARGE_UNWAIVED";
export class BookingRefused extends Error {
  readonly code: BookingRefusalCode; readonly reason: string;
  constructor(code: BookingRefusalCode, reason: string) { super(`modification booking refused [${code}]: ${reason}`); this.name = "BookingRefused"; this.code = code; this.reason = reason; }
}

const openLateCharges = (state: LoanCashState): Fee[] => (state.fees ?? []).filter((f) => f.fee_type === "late_charge" && (f.state === "assessed" || f.state === "accrued_suspended"));
const sumOpen = (fees: readonly Fee[]): Cents => fees.reduce((s, f) => s + (f.amount_cents - f.collected_cents), 0n);

export class TrialCashieringOps {
  /** The section-level operations (receipts, month-end, completion, conversion waiver) this layer builds on. */
  readonly ops: CashieringOps;
  private readonly events: EventStore;
  private readonly clock: { now(): string };
  private readonly actor: Actor;
  private readonly capitalizations = new Map<string, CapitalizationComputed>();

  constructor(deps: OpsDeps) { this.ops = new CashieringOps(deps); this.events = deps.events; this.clock = deps.clock; this.actor = deps.actor ?? CASHIERING_OPS_ACTOR; }

  private emit(type: string, loanId: string, payload: Payload, aggregate?: { kind: string; id: string }): DomainEvent {
    return this.events.append({ type, loanId, ...(aggregate ? { aggregate } : {}), actor: this.actor, payload });
  }

  /** Rule 3: an assessed late charge is moved into the trial overlay — `accrued_suspended{trial_pending_waiver}` — off the receivable, never billed or taken from trial funds. */
  suspendLateCharge(state: LoanCashState, feeId: string, on: PlainDate, caseId?: string): Fee {
    const fee = (state.fees ?? []).find((f) => f.id === feeId);
    if (!fee) throw new RangeError(`fee ${feeId} not found on ${state.loan_id}`);
    if (fee.fee_type !== "late_charge") throw new RangeError(`fee ${feeId} is a ${fee.fee_type}; only late charges are suspended for a pending modification (rule 3)`);
    if (fee.state === "accrued_suspended" && fee.suppression === TRIAL_SUPPRESSION) return fee;   // idempotent
    if (fee.state !== "assessed") throw new RangeError(`fee ${feeId} is ${fee.state}; only an assessed late charge can be suspended`);
    state.late_charges_due_cents -= fee.amount_cents - fee.collected_cents;   // not billed, not reported as due
    fee.state = "accrued_suspended"; fee.suppression = TRIAL_SUPPRESSION;
    this.emit("fee.suspended", state.loan_id, { fee_id: fee.id, fee_type: fee.fee_type, installment_due_date: fee.installment_due_date, amount_cents: str(fee.amount_cents), suppression: TRIAL_SUPPRESSION, case_id: caseId ?? null, on, late_charges_due_cents: str(state.late_charges_due_cents), cite: "Servicing Guide D2-3.2-06 (authorized to assess during the Trial Period Plan; waived on conversion); F-1-27" }, { kind: "fee", id: fee.id });
    return fee;
  }

  /**
   * F-1-27 step 1 on cashiering's figures: capitalize unpaid interest, escrow advances, servicing advances and any prior NIB
   * — late charges excluded. Emits `lossmit.modification.capitalization_computed` (arms `FNMA_F127_LC_NOT_CAPITALIZED_GATE`;
   * `late_charges_in_capitalization_cents` is the evaluator's fact). Late charges in the input → refused, nothing computed.
   */
  computeCapitalization(trial: TrialOverlay, state: LoanCashState, input: CapitalizationInput, effectiveOn: PlainDate): CapitalizationComputed {
    const open = openLateCharges(state);
    const excluded = sumOpen(open);
    const lcIn = input.late_charges_cents ?? 0n;
    const base = { case_id: trial.case_id, effective_date: effectiveOn, capitalization_date: addDays(effectiveOn, -1), cite: F127 };
    if (lcIn > 0n) {
      const reason = `capitalized amount would include ${str(lcIn)}¢ of late charges; late charges are waived at conversion (${str(excluded)}¢ open on the loan), never capitalized`;
      this.emit("lossmit.modification.capitalization.refused", trial.loan_id, { ...base, late_charges_in_capitalization_cents: str(lcIn), late_charges_excluded_cents: str(excluded), reason }, { kind: "modification", id: trial.case_id });
      throw new CapitalizationRefused(reason);
    }
    for (const [k, v] of Object.entries({ interest_cents: input.interest_cents, escrow_advances_cents: input.escrow_advances_cents, servicing_advances_cents: input.servicing_advances_cents ?? 0n, prior_nib_cents: input.prior_nib_cents ?? 0n })) if (v < 0n) throw new RangeError(`${k} must be ≥ 0 (got ${str(v)})`);
    const servicing = input.servicing_advances_cents ?? 0n; const nib = input.prior_nib_cents ?? 0n;
    const out: CapitalizationComputed = { case_id: trial.case_id, effective_date: effectiveOn, capitalization_date: addDays(effectiveOn, -1), capitalized_interest_cents: input.interest_cents, capitalized_escrow_advances_cents: input.escrow_advances_cents, capitalized_servicing_advances_cents: servicing, prior_nib_cents: nib, capitalized_total_cents: input.interest_cents + input.escrow_advances_cents + servicing + nib, late_charges_in_capitalization_cents: 0n, late_charges_excluded_cents: excluded };
    this.capitalizations.set(trial.case_id, out);
    this.emit("lossmit.modification.capitalization_computed", trial.loan_id, { ...base, loan_id: trial.loan_id, capitalized_interest_cents: str(out.capitalized_interest_cents), capitalized_escrow_advances_cents: str(out.capitalized_escrow_advances_cents), capitalized_servicing_advances_cents: str(servicing), prior_nib_cents: str(nib), capitalized_total_cents: str(out.capitalized_total_cents), late_charges_in_capitalization_cents: "0", late_charges_excluded_cents: str(excluded), late_charge_fee_ids: open.map((f) => f.id), residual_applied_cents: str(trial.applied_cents) }, { kind: "modification", id: trial.case_id });
    return out;
  }
  capitalizationFor(caseId: string): CapitalizationComputed | undefined { return this.capitalizations.get(caseId); }

  /** Rule 5 end to end: the residual (Σ held − Σ applied) reduces the arrears (interest first, then escrow advances; excess curtails), then the capitalization is computed on the remainder. */
  completeTrial(trial: TrialOverlay, state: LoanCashState, arrears: { interest_cents: Cents; escrow_advances_cents: Cents; servicing_advances_cents?: Cents; prior_nib_cents?: Cents }, effectiveOn: PlainDate): { residual: ReturnType<typeof pureTrialCompletion>; capitalization: CapitalizationComputed } {
    const residual = this.ops.trialCompletion(trial, { interest_cents: arrears.interest_cents, escrow_advances_cents: arrears.escrow_advances_cents }, effectiveOn);
    const capitalization = this.computeCapitalization(trial, state, { interest_cents: residual.capitalized_interest_cents, escrow_advances_cents: residual.capitalized_escrow_cents, ...(arrears.servicing_advances_cents !== undefined ? { servicing_advances_cents: arrears.servicing_advances_cents } : {}), ...(arrears.prior_nib_cents !== undefined ? { prior_nib_cents: arrears.prior_nib_cents } : {}) }, effectiveOn);
    return { residual, capitalization };
  }

  /** Same-day conversion waiver (`lossmit.modification.effective` → every late charge waived, `late_charges.all_waived{reason=trial_conversion}`). */
  modificationEffective(trial: TrialOverlay, state: LoanCashState, effectiveOn: PlainDate): Cents { return this.ops.modificationEffective(trial, state, effectiveOn); }

  /**
   * 12.8's booking command as 2.6 asserts it: refused while the trial is incomplete/failed, the residual has not been applied,
   * the capitalization has not been computed (or included late charges), or any late charge on the loan is unwaived.
   */
  bookModification(trial: TrialOverlay, state: LoanCashState, effectiveOn: PlainDate): DomainEvent {
    const refuse = (code: BookingRefusalCode, reason: string): never => {
      this.emit("lossmit.modification.booking.refused", trial.loan_id, { case_id: trial.case_id, effective_date: effectiveOn, code, reason, cite: "§2.6 timer table (booking refused; 12.8's booking command asserts the residual and waiver gates); Servicing Guide D2-3.2-06; F-1-27" }, { kind: "modification", id: trial.case_id });
      throw new BookingRefused(code, reason);
    };
    if (trial.status === "trial_failed") refuse("TRIAL_FAILED", "the Trial Period Plan failed; no permanent modification (D2-3.2-06)");
    if (trial.months.some((m) => m.status !== "satisfied")) refuse("TRIAL_NOT_COMPLETE", `${trial.months.filter((m) => m.status !== "satisfied").length} trial month(s) not yet satisfied`);
    if (trial.status === "trial_active") refuse("RESIDUAL_GATE_OPEN", "FNMA_C1102_TRIAL_RESIDUAL_BEFORE_EFFECTIVE_0: the trial residual has not been applied to capitalizable arrears (trial.residual.applied)");
    const cap = this.capitalizations.get(trial.case_id);
    if (!cap) refuse("CAPITALIZATION_NOT_COMPUTED", "FNMA_F127_LC_NOT_CAPITALIZED_GATE: no capitalization computation on record for the case");
    if (cap!.late_charges_in_capitalization_cents !== 0n) refuse("LATE_CHARGE_IN_CAPITALIZATION", "FNMA_F127_LC_NOT_CAPITALIZED_GATE: the capitalized amount includes late charges");
    const g = bookingGate(state);
    if (!g.ok) refuse("LATE_CHARGE_UNWAIVED", `FNMA_D23206_LC_WAIVE_ON_CONVERSION_0: ${g.reason}`);
    const waived = (state.fees ?? []).filter((f) => f.fee_type === "late_charge" && f.state === "waived" && f.waived_reason === "trial_conversion").reduce((s, f) => s + (f.amount_cents - f.collected_cents), 0n);
    return this.emit("lossmit.modification.booked", trial.loan_id, { case_id: trial.case_id, loan_id: trial.loan_id, effective_date: effectiveOn, capitalization_date: cap!.capitalization_date, capitalized_total_cents: str(cap!.capitalized_total_cents), capitalized_interest_cents: str(cap!.capitalized_interest_cents), late_charges_in_capitalization_cents: "0", late_charges_waived_cents: str(waived), residual_applied_cents: str(trial.applied_cents), booked_at: this.clock.now(), cite: "Servicing Guide F-1-27; D2-3.2-06; C-1.1-02" }, { kind: "modification", id: trial.case_id });
  }
}
