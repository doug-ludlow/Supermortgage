/**
 * §3.4 Cushion enforcement — the cushion module's loan_events.
 *
 * Spec "Inputs and triggers": "Every `escrow.analysis.computing` event (3.2) — the cushion module is called inside the
 * engine" — `beginAnalysisComputation` appends that event when runEscrowAnalysis starts a projection; it arms the two
 * not-before gates (REGX_1024_17C5_CUSHION_CAP_GATE, REGX_1024_17C6_PREACCRUAL_GATE) and 3.6's workout spread gate.
 * Spec "Outputs and artifacts": "`loan_events`: `escrow.cushion.validated`, `escrow.cushion.cap_failed` (with reason)"
 * — `recordCushionCheck` appends the validated event every time the module runs (it carries the data-model fields
 * `cap_check_passed` / `preaccrual_check_passed` the gates are satisfied by) and, on a failure, the cap_failed event
 * with its reason. Both run inside the engine (runEscrowAnalysis) and the boarding validator (validateCushion —
 * ESC_INHERITED_CUSHION_CHECK_10BD). Wired from src/app/tools/section03.ts.
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Projection } from "./analysis.ts";

export const ESCROW_ANALYSIS_COMPUTING = "escrow.analysis.computing";
export const ESCROW_CUSHION_VALIDATED = "escrow.cushion.validated";
export const ESCROW_CUSHION_CAP_FAILED = "escrow.cushion.cap_failed";

/** 3.4 state machine: `computing` → `computed` only if both checks pass; otherwise → `anomaly_review` with a hard block. */
export type CushionCheckReason = "cushion_cap_failed" | "preaccrual_check_failed";

export interface ComputingInput {
  readonly loan_id: string; readonly analysis_id: string; readonly analysis_type: string; readonly as_of: PlainDate; readonly year_start: PlainDate;
  /** 3.6: a workout analysis is the `escrow.analysis.computing{reason=workout}` trigger of FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE. */
  readonly workout?: boolean; readonly actor: Actor;
}
/** The engine's "computing" state entry — the input event of the cushion module (3.4) and the gates it arms. */
export function beginAnalysisComputation(events: EventStore, i: ComputingInput): DomainEvent {
  if (!i.analysis_id) throw new RangeError("analysis_id is required to start an analysis computation");
  return events.append({ type: ESCROW_ANALYSIS_COMPUTING, loanId: i.loan_id, actor: i.actor, payload: { analysis_id: i.analysis_id, analysis_type: i.analysis_type, reason: i.workout ? "workout" : i.analysis_type, as_of: i.as_of, year_start: i.year_start } });
}

export interface CushionCheck {
  readonly loan_id: string;
  /** The analysis the check belongs to; null for the boarding validator's stand-alone check (ESC_INHERITED_CUSHION_CHECK_10BD). */
  readonly analysis_id: string | null;
  readonly source: "engine" | "boarding_validator";
  readonly cushion_months: number; readonly cushion_cents: Cents; readonly cushion_cap_source: Projection["cushion_source"]; readonly cushion_cap_cents: Cents;
  /** min(target_balance[p]) after Step 3 — the (d)(2)(ii) aggregate check; null when only the cushion arithmetic ran. */
  readonly lowest_target_cents: Cents | null;
  readonly cap_check_passed: boolean;
  /** null when no projection was run (nothing to check the disbursement dates against). */
  readonly preaccrual_check_passed: boolean | null;
  readonly actor: Actor;
}
export interface CushionCheckRecord { readonly reasons: CushionCheckReason[]; readonly validated: DomainEvent; readonly cap_failed: DomainEvent | null; readonly passed: boolean; }

/** Rules 2–5: the reasons a cushion check fails (the 3.2 R10 anomaly triggers runEscrowAnalysis adds). */
export function cushionCheckReasons(c: Pick<CushionCheck, "cap_check_passed" | "preaccrual_check_passed">): CushionCheckReason[] {
  const out: CushionCheckReason[] = [];
  if (!c.cap_check_passed) out.push("cushion_cap_failed");
  if (c.preaccrual_check_passed === false) out.push("preaccrual_check_failed");
  return out;
}

/** The cushion module's result as loan_events: `escrow.cushion.validated` (always — it carries the check fields) and `escrow.cushion.cap_failed` with the reason when a check fails. */
export function recordCushionCheck(events: EventStore, c: CushionCheck): CushionCheckRecord {
  if (!c.loan_id) throw new RangeError("loan_id is required to record a cushion check");
  if (c.cushion_cents < 0n || c.cushion_cap_cents < 0n) throw new RangeError("cushion figures cannot be negative");
  const reasons = cushionCheckReasons(c);
  const fields = { analysis_id: c.analysis_id, source: c.source, cushion_months: c.cushion_months, cushion_cents: String(c.cushion_cents), cushion_cap_source: c.cushion_cap_source, cushion_cap_cents: String(c.cushion_cap_cents),
    lowest_target_cents: c.lowest_target_cents === null ? null : String(c.lowest_target_cents), cap_check_passed: c.cap_check_passed, preaccrual_check_passed: c.preaccrual_check_passed };
  const validated = events.append({ type: ESCROW_CUSHION_VALIDATED, loanId: c.loan_id, actor: c.actor, payload: fields });
  const capFailed = reasons.length ? events.append({ type: ESCROW_CUSHION_CAP_FAILED, loanId: c.loan_id, actor: c.actor, causationId: validated.id, payload: { ...fields, reason: reasons.join("+"), reasons } }) : null;
  return { reasons, validated, cap_failed: capFailed, passed: reasons.length === 0 };
}

/** The projection's cushion fields as a check record input (rule 3: the aggregate low point is the min target after Step 3). */
export function checkFromProjection(p: Projection, f: { loan_id: string; analysis_id: string | null; source: CushionCheck["source"]; cushion_months: number; actor: Actor }): CushionCheck {
  const lowest = p.targets.length ? p.targets.reduce((a, b) => (b < a ? b : a)) : null;
  return { loan_id: f.loan_id, analysis_id: f.analysis_id, source: f.source, cushion_months: f.cushion_months, cushion_cents: p.cushion_cents, cushion_cap_source: p.cushion_source, cushion_cap_cents: p.cap_cents,
    lowest_target_cents: lowest, cap_check_passed: p.cap_ok, preaccrual_check_passed: p.preaccrual_ok, actor: f.actor };
}
