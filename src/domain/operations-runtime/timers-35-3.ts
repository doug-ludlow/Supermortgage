/**
 * §35.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.3's recurring clocks (SM_CYCLE_PLANNER_DAILY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY), with the hour in the override
 * ("+1 calendar_days, 23:59 ET" — the day's last minute, since the planner runs every minute and the clock asks only that
 * some pass completed today). The deadline rows parse and arm from the registry as written: SM_CYCLE_RUN_STALLED_1D on the
 * `cycle_run` aggregate of `cycle.run.opened` (src/domain/operations-runtime/cycles/planner.ts; satisfied by
 * `cycle.run.completed`, cycles/receipt.ts), SM_JOB_DEAD_2H on the `job` aggregate of `job.unit.dead` (cycles/executor.ts;
 * satisfied by `job.unit.resolved`, cycles/service.ts). Two rules the override grammar cannot express live in code, cited:
 * the stall clock is cancelled on `cycle.run.cancelled` ("state machine: a cancelled run has nothing left to complete" —
 * cycles/service.ts pauseCycle cancels the armed instance on the same unit of work), and SM_JOB_DEAD_2H's breach role is
 * the registry row's `escalation_role` (cycles/breach.ts enrichBreach reads the row: "the evaluator reads the row").
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 2: "+1 calendar_days" from `opened_at` — the day grammar would place the due instant at 23:59 ET of the next civil day, but the row's anchor is the opening INSTANT ("Key deadlines: A planned run completes within 1 calendar day of opening"; T12: a run opened 2026-10-01 12:00 ET breaches at the 2026-10-02 12:01 ET sweep), so the offset is the engine's minutes grammar from the trigger's instant (src/kernel/timers/engine.ts computeDue: `unit === "minutes"` → anchorMs + n × 60 000): 1 439 minutes — the clock is due at the calendar day's last sweep minute, so the first sweep minute outside the day breaches it.
  o("SM_CYCLE_RUN_STALLED_1D", { offset: "+1439 minutes",
    why: "§35.3 timer table row `SM_CYCLE_RUN_STALLED_1D`: deadline on `cycle.run.opened`, anchor `opened_at`, offset '+1 calendar_days', satisfied by `cycle.run.completed`, breach 'sev 2 → `ops_analyst` (a planned run has not completed in a calendar day: a dead unit, a blocked dependency or a stopped executor — the escalation payload names `cycle_code`, `period_key`, `units_done`/`units_total`)' — 'Key deadlines: A planned run completes within 1 calendar day of opening'; T12: 'Given a run opened at 2026-10-01 12:00 ET … when the sweep runs at 2026-10-02 12:01 ET, then `SM_CYCLE_RUN_STALLED_1D` breaches'. One calendar day from the opening instant is 1 440 sweep minutes; the clock is due at the last of them (1 439 minutes, the engine's minutes grammar) so the first sweep minute outside the day — T12's 12:01 ET for a 12:00 ET opening — breaches it (the day grammar would defer the due instant to 23:59 ET of the next day, past T12's breach). The escalation payload is enriched from `cycle_runs` by the paged breach pass (cycles/breach.ts enrichBreach)." });
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_CYCLE_PLANNER_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 23:59 ET", subject: "global",
    why: "§35.3 timer table row `SM_CYCLE_PLANNER_DAILY`: recurring on `cycles.plan.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `cycles.plan.run_completed`, breach 'sev 2 → `ops_analyst` (no planner pass completed today: the sweep runs but plans nothing — 35.1's heartbeat cannot see this)' — 'Trigger & frequency: Every sweep (Cloud Scheduler, once a minute, under 35.1's lease) and every demo-clock step (`POST /v1/demo/advance`, inline); per registered cycle: daily, monthly, annual, per billing cycle or per event, as its registry row states'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
