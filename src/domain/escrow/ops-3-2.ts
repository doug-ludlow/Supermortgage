/**
 * §3.2 process operations — the workout-analysis hand-off from loss mitigation (Fannie Mae D2-3.2-06: the servicer
 * must "perform an escrow analysis prior to offering a Trial Period Plan"; B-1-01: the workout analysis spreads a
 * shortage over 60 months).
 *
 * The §12 case (SMDU / the lossmit-underwriter agent) prepares a Trial Period Plan offer; that prepared offer is the
 * inbound record this process ingests as `lossmit.trial_plan.offer_prepared{offer_id, offer_date, program}` — the
 * trigger of `FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL` (anchor: offer date; 0 calendar days; satisfied by
 * `escrow.analysis.completed{analysis_type=workout}` — the fact 3.1's runEscrowAnalysis emits for a workout run).
 * Until that analysis exists the trial offer command is blocked (breach action: "blocks the trial offer command;
 * sev-2"): `recordTrialPlanOffered` refuses, and `lossmit.trial_plan.offered` is only ever appended after it.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";

export const WORKOUT_ANALYSIS_TIMER = "FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL" as const;
/** Workout programs whose trial offer (D2-3.2-06) or approval (B-1-01 deferral / modification) needs the workout analysis first. */
export type WorkoutProgram = "flex_modification" | "payment_deferral" | "disaster_payment_deferral" | "trial_period_plan" | "other_modification";
const PROGRAMS: ReadonlySet<string> = new Set<WorkoutProgram>(["flex_modification", "payment_deferral", "disaster_payment_deferral", "trial_period_plan", "other_modification"]);
const isDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** The §12 hand-off record: a Trial Period Plan offer prepared (not yet offered) by the loss-mitigation case. */
export interface TrialPlanOfferPreparedRecord {
  readonly loan_id: string;
  /** The §12 offer / SMDU case identifier — the idempotency key of the hand-off. */
  readonly offer_id: string;
  readonly program: WorkoutProgram;
  /** The date the offer is to go out (the timer's anchor: the analysis must exist on or before it). */
  readonly offer_date: PlainDate;
  /** The trial payment the offer will carry before the escrow portion is set by the workout analysis (null when not yet priced). */
  readonly trial_payment_cents?: Cents | null;
  readonly source?: "smdu" | "lossmit_case" | "ops_console";
}

/**
 * Ingest the prepared trial-plan offer: validates the record (offer id, program, ISO offer date, non-negative payment)
 * and appends `lossmit.trial_plan.offer_prepared` — the fact FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL is armed by, with
 * `offer_date` as its anchor. A second hand-off for the same offer id on the loan is refused (append-only, idempotent).
 */
export function ingestTrialPlanOfferPrepared(events: EventStore, rec: TrialPlanOfferPreparedRecord, actor: Actor): { event: DomainEvent; timer: typeof WORKOUT_ANALYSIS_TIMER; analysis_due_on: PlainDate; analysis_type: "workout" } {
  if (!rec.loan_id) throw new RangeError("loan_id is required");
  if (!rec.offer_id) throw new RangeError("offer_id is required: the §12 offer / SMDU case the trial plan belongs to");
  if (!PROGRAMS.has(rec.program)) throw new RangeError(`program ${String(rec.program)} is not a workout program (${[...PROGRAMS].join(", ")})`);
  if (!isDate(rec.offer_date)) throw new RangeError("offer_date must be the ISO date the trial plan offer goes out");
  if (rec.trial_payment_cents !== undefined && rec.trial_payment_cents !== null && rec.trial_payment_cents < 0n) throw new RangeError("trial_payment_cents cannot be negative");
  if (offerPrepared(events, rec.loan_id, rec.offer_id)) throw new RangeError(`trial plan offer ${rec.offer_id} on ${rec.loan_id} is already prepared`);
  const event = events.append({ type: "lossmit.trial_plan.offer_prepared", loanId: rec.loan_id, actor, payload: { offer_id: rec.offer_id, program: rec.program, offer_date: rec.offer_date, trial_payment_cents: rec.trial_payment_cents === undefined || rec.trial_payment_cents === null ? null : String(rec.trial_payment_cents), source: rec.source ?? "lossmit_case", analysis_type: "workout" } });
  return { event, timer: WORKOUT_ANALYSIS_TIMER, analysis_due_on: rec.offer_date, analysis_type: "workout" };
}

const offerPrepared = (events: EventStore, loanId: string, offerId: string): DomainEvent | undefined =>
  events.byLoan(loanId).filter((e) => e.type === "lossmit.trial_plan.offer_prepared" && e.payload.offer_id === offerId).at(-1);

/**
 * The gate the trial offer command consults (FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL breach action): the workout
 * `escrow.analysis.completed` recorded on the loan after the offer was prepared, or the reason the offer is blocked.
 */
export function workoutAnalysisBeforeTrialOffer(events: EventStore, loanId: string, offerId: string): { allowed: boolean; timer: typeof WORKOUT_ANALYSIS_TIMER; analysis: DomainEvent | null; reason: string | null; severity: 2 } {
  const prepared = offerPrepared(events, loanId, offerId);
  if (!prepared) return { allowed: false, timer: WORKOUT_ANALYSIS_TIMER, analysis: null, reason: `no prepared trial plan offer ${offerId} on ${loanId}: ingest the §12 hand-off first`, severity: 2 };
  const analysis = events.byLoan(loanId).filter((e) => e.type === "escrow.analysis.completed" && e.payload.analysis_type === "workout" && e.sequence > prepared.sequence).at(-1) ?? null;
  return analysis
    ? { allowed: true, timer: WORKOUT_ANALYSIS_TIMER, analysis, reason: null, severity: 2 }
    : { allowed: false, timer: WORKOUT_ANALYSIS_TIMER, analysis: null, reason: `trial plan offer ${offerId} is blocked: no workout escrow analysis since the offer was prepared (D2-3.2-06: analyze the escrow account before offering a Trial Period Plan; ${WORKOUT_ANALYSIS_TIMER})`, severity: 2 };
}

/**
 * The trial offer command's escrow side: refused while the workout analysis is missing (the timer's breach action), else
 * `lossmit.trial_plan.offered{offer_id, offered_on, analysis_id}` — the event the row's offset says the analysis must precede.
 */
export function recordTrialPlanOffered(events: EventStore, rec: { loan_id: string; offer_id: string; offered_on: PlainDate }, actor: Actor): { event: DomainEvent; analysis_id: string } {
  if (!isDate(rec.offered_on)) throw new RangeError("offered_on must be an ISO date");
  const gate = workoutAnalysisBeforeTrialOffer(events, rec.loan_id, rec.offer_id);
  if (!gate.allowed || !gate.analysis) throw new RangeError(gate.reason ?? "trial plan offer blocked");
  const prepared = offerPrepared(events, rec.loan_id, rec.offer_id)!;
  if (rec.offered_on < String(prepared.payload.offer_date)) throw new RangeError(`offered_on ${rec.offered_on} precedes the prepared offer date ${String(prepared.payload.offer_date)}`);
  const analysisId = String(gate.analysis.payload.analysis_id ?? "");
  const event = events.append({ type: "lossmit.trial_plan.offered", loanId: rec.loan_id, actor, causationId: gate.analysis.id, payload: { offer_id: rec.offer_id, offered_on: rec.offered_on, analysis_id: analysisId, program: prepared.payload.program ?? null } });
  return { event, analysis_id: analysisId };
}
