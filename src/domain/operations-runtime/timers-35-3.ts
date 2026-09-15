/**
 * §35.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Emitters (src/domain/operations-runtime/service.ts, literals in cycles.ts EVT): `cycles.plan.run_completed{as_of_date, …,
 * origination: true}` on the global subject once per completed planner pass (trigger and satisfying event of the recurring
 * SM_CYCLE_PLANNER_DAILY); `cycle.run.opened{run_id, …, opened_at, origination: true}` on the `cycle_run` aggregate with
 * `occurredAt = opened_at` (arms SM_CYCLE_RUN_STALLED_1D per run) and `cycle.run.completed` on the same aggregate from the
 * receipt election's global unit of work (a global command hydrates `timers.openGlobal()`, unit-of-work.ts:86-87, so the
 * run's clock is satisfied there); `job.unit.dead{…, dead_at, origination: true}` on the `job` aggregate with `occurredAt =
 * dead_at` (arms SM_JOB_DEAD_2H) and `job.unit.resolved{job_id, by, disposition}` from the requeue / abandon command. Every
 * arming event carries `origination: true` because a §35 def is an origination-side def to the engine (process ≥ 20,
 * src/kernel/timers/engine.ts isOriginationDef) — the 33.2 precedent (src/runtime/partner-book-review.ts).
 *
 * SM_JOB_DEAD_2H's breach column names "the registry row's `escalation_role`": the token parses as the literal
 * `escalation_role`, so the breach pass resolves the role from `jobs → cycle_registry.escalation_role` rather than from the
 * column; the row itself (`+2 hours`, `job.unit.dead` → `job.unit.resolved`) arms and satisfies as written and takes no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

/** The stall clock is cancelled, never satisfied, when its run is cancelled (`cancelRun` → `engine.cancel(inst.id, CANCEL_STALL_ON.why)`; the early-intervention/timers.ts and pmi/ops-10-4.ts precedents). */
export const CANCEL_STALL_ON = { code: "SM_CYCLE_RUN_STALLED_1D", on: "cycle.run.cancelled", why: "state machine: a cancelled run has nothing left to complete" } as const;

export function applySatisfiedOverrides_35_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 3: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent); the hour is the day's last minute.
  o("SM_CYCLE_PLANNER_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 23:59 ET", subject: "global",
    why: "§35.3 timer table row `SM_CYCLE_PLANNER_DAILY`: recurring on `cycles.plan.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `cycles.plan.run_completed`, breach 'sev 2 → `ops_analyst` (no planner pass completed today: the sweep runs but plans nothing — 35.1's heartbeat cannot see this)'. Timers paragraph: '`SM_CYCLE_PLANNER_DAILY` is a recurring global clock and takes a cited `subject: \"global\"` override in `src/domain/operations-runtime/timers-35-3.ts` on the `timers-33-2.ts` precedent (src/domain/partner-book/timers-33-2.ts:17-19; the engine keeps one armed instance per global recurring code, src/kernel/timers/engine.ts:180-181), with the hour in the override (`+1 calendar_days, 23:59 ET` — the day's last minute, since the planner runs every minute and the clock asks only that some pass completed today)'. The receipt is one global event per environment-day (src/domain/operations-runtime/service.ts, the `cycles.plan` command's own batch), not a loan's or an application's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + 1 calendar day, 23:59 America/New_York)." });
  // Timer table row 1: the per-run stall clock — 24 hours from `opened_at`, on the `cycle_run` aggregate; the row's '+1 calendar_days' would be 23:59 ET of the next civil day (engine.ts computeDue atOrEod), which none of the three passages means.
  o("SM_CYCLE_RUN_STALLED_1D", { offset: "+24 hours",
    why: "§35.3 timer table row `SM_CYCLE_RUN_STALLED_1D`: deadline on `cycle.run.opened`, anchor `opened_at`, offset '+1 calendar_days', satisfied by `cycle.run.completed`, breach 'sev 2 → `ops_analyst` (a planned run has not completed in a calendar day: a dead unit, a blocked dependency or a stopped executor — the escalation payload names `cycle_code`, `period_key`, `units_done`/`units_total`)'. Three passages fix the offset at 24 hours from the opening instant rather than the end of the next civil day: 'Key deadlines: A planned run completes within 1 calendar day of opening'; worked example B: 'the run stays `running`; `SM_CYCLE_RUN_STALLED_1D` is due 2026-10-02 00:05:10 ET' for a run whose attempt 1 was at 00:05:10 ET; 35.3-T12: 'Given a run opened at 2026-10-01 12:00 ET … when the sweep runs at 2026-10-02 12:01 ET, then `SM_CYCLE_RUN_STALLED_1D` breaches'. `+24 hours` parses to {step, 24, hours} (src/kernel/timers/offset.ts UNIT_ALIASES) and computeDue for hours is the trigger's occurredAt + 24 h (engine.ts:84-88), so the emitter appends `cycle.run.opened` with `occurredAt = opened_at`. Timers paragraph: '`SM_CYCLE_RUN_STALLED_1D` is armed per run on the `cycle_run` aggregate (the batch-level pattern of unit-of-work.ts:86-87: a global command hydrates `timers.openGlobal()`, so the receipt's global command satisfies it); the same override file cancels it on `cycle.run.cancelled` with the citation \"state machine: a cancelled run has nothing left to complete\"' (CANCEL_STALL_ON, read by service.ts cancelRun)." });
}
