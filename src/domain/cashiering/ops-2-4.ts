/**
 * §2.4 process-owned operations — the event-emitting layer for the parts of
 * "Additional principal / unscheduled payments" that the Allocation Engine
 * (allocation.ts: ordering, NIB order, delinquent redirect, payoff route) and
 * ops.ts (Form 181 re-amortization) do not cover:
 *
 *   rule 5 / FNMA_C1201_REAPPLY_ELIGIBILITY_GATE — reapplication of prior
 *   principal prepayments to cure a delinquency (Servicing Guide C-1.2-01).
 *   `curtailment.reapplication.requested` arms the gate; the four C-1.2-01
 *   conditions are evaluated here (evaluator `2.4.reapplyEligible`, the same
 *   condition list); the decision record is the gate's satisfier; a refusal
 *   points to the 12.x workout path; an approval books the
 *   `curtailment_reapplications` row, emits `curtailment.reapplied` and the
 *   5.1 correction events (each reapplied curtailment is reversed and
 *   re-reported — a curtailment is never reported as a negative later).
 *
 * Money stays bigint cents; dates are PlainDate; nothing here edits a row.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { cashCfg, type LoanCashState } from "./types.ts";
import { reapplicationGate } from "./curtailment.ts";

export const CASHIERING_OPS_2_4_ACTOR: Actor = { kind: "agent", id: "cashiering" };

/**
 * C-1.2-01 reapplication conditions, in the Guide's order (spec data model
 * `curtailment_reapplications.eligibility{…}`): portfolio or non-MBS participation
 * loan; the reapplication "does not result in the mortgage loan balance being
 * higher than it would have been had the original amortization schedule … been
 * followed"; no mortgage-assistance-fund program money; the borrower agrees to
 * supplement so the whole delinquency is cured.
 */
export const REAPPLY_CONDITIONS = ["portfolio_or_nonmbs_participation", "balance_not_higher_than_schedule", "no_maf_funds", "borrower_supplement_agreed"] as const;
export type ReapplyCondition = (typeof REAPPLY_CONDITIONS)[number];
export type ReapplyEligibility = Readonly<Record<ReapplyCondition, boolean>>;

export interface ReapplicationRequest {
  readonly requested_on: PlainDate;
  /** `payment.curtailment.applied` ids of the prior curtailments the borrower asks to reapply. */
  readonly original_curtailment_event_ids: readonly string[];
  readonly prior_curtailments_cents: Cents;
  /** Balance "had the original amortization schedule been followed" (the amortization engine's scheduled UPB as of `requested_on`). */
  readonly scheduled_balance_cents: Cents;
  /** Unpaid installments (P&I + escrow) as of `requested_on`. */
  readonly delinquency_cents: Cents;
  /** Mortgage-assistance-fund program money received (HAF etc.) — declared by the case. */
  readonly maf_funds_received: boolean;
  /** The borrower agrees to supplement so the whole delinquency is cured (else combine with a workout per D2-3). */
  readonly borrower_supplement_agreed: boolean;
}

export type ReapplicationResult =
  | { readonly ok: true; readonly reapplication_id: string; readonly decision_id: string; readonly amount_reapplied_cents: Cents; readonly eligibility: ReapplyEligibility }
  | { readonly ok: false; readonly reapplication_id: string; readonly decision_id: string; readonly reason: string; readonly failed: readonly ReapplyCondition[]; readonly suggest: "12.x_workout"; readonly eligibility: ReapplyEligibility };

const min = (...xs: readonly Cents[]): Cents => xs.reduce((a, b) => (b < a ? b : a));

/** 2.4 rule 5: reapplied amount = min(prior curtailments, scheduled balance − current balance, delinquency amount), never negative. */
export function reapplyAmount(priorCurtailments: Cents, scheduledBalance: Cents, currentBalance: Cents, delinquency: Cents): Cents {
  const room = scheduledBalance - currentBalance;
  const a = min(priorCurtailments, room, delinquency);
  return a > 0n ? a : 0n;
}

/** The four C-1.2-01 conditions, derived from the loan and the request (never from the caller's own claim where the platform holds the fact). */
export function reapplyEligibilityFor(state: LoanCashState, req: ReapplicationRequest): ReapplyEligibility {
  const amount = reapplyAmount(req.prior_curtailments_cents, req.scheduled_balance_cents, state.upb_cents, req.delinquency_cents);
  return {
    portfolio_or_nonmbs_participation: !cashCfg(state).mbs,
    balance_not_higher_than_schedule: amount > 0n && state.upb_cents + amount <= req.scheduled_balance_cents,
    no_maf_funds: !req.maf_funds_received,
    borrower_supplement_agreed: req.borrower_supplement_agreed,
  };
}

export const failedConditions = (e: ReapplyEligibility): ReapplyCondition[] => REAPPLY_CONDITIONS.filter((k) => !e[k]);

export interface Ops24Deps { readonly events: EventStore; readonly clock: { now(): string }; readonly actor?: Actor; }

export class CashieringOps24 {
  private readonly events: EventStore;
  private readonly clock: { now(): string };
  private readonly actor: Actor;
  constructor(deps: Ops24Deps) { this.events = deps.events; this.clock = deps.clock; this.actor = deps.actor ?? CASHIERING_OPS_2_4_ACTOR; }

  private emit(type: string, loanId: string, payload: Record<string, unknown>, aggregate?: { kind: string; id: string }): DomainEvent {
    return this.events.append({ type, loanId, ...(aggregate ? { aggregate } : {}), actor: this.actor, payload });
  }

  /**
   * C-1.2-01 reapplication of prior prepayments to cure a delinquency (2.4 rule 5).
   * Emits `curtailment.reapplication.requested` (arms FNMA_C1201_REAPPLY_ELIGIBILITY_GATE), the `agent.decision`
   * record with the four eligibility tests, then either `curtailment.reapplication.refused{suggest=12.x_workout}` or
   * `curtailment_reapplications.created` + `curtailment.reapplied` + one 5.1 `payment.reversal` correction per
   * reapplied curtailment (each is reversed and re-reported; never a negative in a later period).
   */
  requestReapplication(state: LoanCashState, req: ReapplicationRequest): ReapplicationResult {
    if (req.prior_curtailments_cents <= 0n || req.original_curtailment_event_ids.length === 0) throw new RangeError("reapplication needs at least one prior curtailment");
    const id = randomUUID(); const aggregate = { kind: "curtailment_reapplication", id };
    const eligibility = reapplyEligibilityFor(state, req);
    const amount = reapplyAmount(req.prior_curtailments_cents, req.scheduled_balance_cents, state.upb_cents, req.delinquency_cents);
    this.emit("curtailment.reapplication.requested", state.loan_id, { reapplication_id: id, requested_on: req.requested_on, original_curtailment_event_ids: [...req.original_curtailment_event_ids], prior_curtailments_cents: req.prior_curtailments_cents.toString(), scheduled_balance_cents: req.scheduled_balance_cents.toString(), current_balance_cents: state.upb_cents.toString(), delinquency_cents: req.delinquency_cents.toString(), amount_requested_cents: amount.toString(), mbs_pool: cashCfg(state).mbs, remittance_type: state.remittance_type, ...eligibility }, aggregate);
    const failed = failedConditions(eligibility);
    const pure = reapplicationGate(state);   // the MBS rule as a pure gate (curtailment.ts) — must agree with the derived condition
    const refused = failed.length > 0 || !pure.ok;
    const decision_id = randomUUID();
    const reason = refused ? (pure.ok ? `C-1.2-01 reapplication conditions not met: ${failed.join(", ")}` : pure.reason) : "all four C-1.2-01 reapplication conditions true";
    this.emit("agent.decision", state.loan_id, { decision_id, agent: "cashiering", action: "reapplication_evaluated", gate: "FNMA_C1201_REAPPLY_ELIGIBILITY_GATE", reapplication_id: id, eligibility, failed, outcome: refused ? "refused" : "approved", ...(refused ? { suggest: "12.x_workout" } : { amount_reapplied_cents: amount.toString() }), cite: "Servicing Guide C-1.2-01 (Processing Additional Principal Payments)", rationale: reason }, aggregate);
    if (refused) {
      this.emit("curtailment.reapplication.refused", state.loan_id, { reapplication_id: id, decision_id, reason, failed, suggest: "12.x_workout", cite: "Servicing Guide C-1.2-01; D2-3 workout" }, aggregate);
      return { ok: false, reapplication_id: id, decision_id, reason, failed, suggest: "12.x_workout", eligibility };
    }
    const investor_event_ids = req.original_curtailment_event_ids.map((orig) => this.emit("investor_events.created", state.loan_id, { type: "payment.reversal", family: "payment", mode: "event", reverses_event_id: orig, reason: "curtailment_reapplied", effective_date: req.requested_on, processed_at: this.clock.now() }, aggregate).id);
    this.emit("curtailment_reapplications.created", state.loan_id, { reapplication_id: id, original_curtailment_event_ids: [...req.original_curtailment_event_ids], amount_reapplied_cents: amount.toString(), eligibility, decision_id, investor_event_ids, requested_on: req.requested_on }, aggregate);
    this.emit("curtailment.reapplied", state.loan_id, { reapplication_id: id, decision_id, amount_reapplied_cents: amount.toString(), applied_to: "delinquency", original_curtailment_event_ids: [...req.original_curtailment_event_ids], investor_event_ids, correction: "reversal_plus_rereport" }, aggregate);
    return { ok: true, reapplication_id: id, decision_id, amount_reapplied_cents: amount, eligibility };
  }
}
