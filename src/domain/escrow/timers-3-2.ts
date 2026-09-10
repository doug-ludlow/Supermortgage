/**
 * §3.2 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Row: `lossmit.trial_plan.offer_prepared` → offer date + 0 calendar days (must precede `lossmit.trial_plan.offered`); satisfied by
  // `escrow.analysis.completed` (workout). The column grammar drops "(workout)" — carried as the `analysis_type` qualifier 3.1's
  // runEscrowAnalysis puts on every completion, so an annual/interim completion never discharges the workout gate — and the anchor is
  // the `offer_date` the ingested hand-off (ops-3-2.ts ingestTrialPlanOfferPrepared) carries, not the day the hand-off arrived.
  o("FNMA_B101_WORKOUT_ANALYSIS_BEFORE_TRIAL", { anchorField: "offer_date", satisfied: "`escrow.analysis.completed{analysis_type=workout}`",
    why: "§3.2 timer table: `lossmit.trial_plan.offer_prepared` → offer date, 0 calendar_days (must precede `lossmit.trial_plan.offered`); satisfied by `escrow.analysis.completed` (workout) — D2-3.2-06: perform an escrow analysis prior to offering a Trial Period Plan; breach blocks the trial offer command (sev-2)." });
}
