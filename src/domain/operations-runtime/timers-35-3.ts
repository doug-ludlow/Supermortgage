/**
 * §35.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.3's recurring clocks (SM_CYCLE_PLANNER_DAILY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.3
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_CYCLE_PLANNER_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.3 timer table row `SM_CYCLE_PLANNER_DAILY`: recurring on `cycles.plan.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `cycles.plan.run_completed`, breach 'sev 2 → `ops_analyst` (no planner pass completed today: the sweep runs but plans nothing — 35.1's heartbeat cannot see this)' — 'Trigger & frequency: Every sweep (Cloud Scheduler, once a minute, under 35.1's lease) and every demo-clock step (`POST /v1/demo/advance`, inline); per registered cycle: daily, monthly, annual, per billing cycle or per event, as its registry row states'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
