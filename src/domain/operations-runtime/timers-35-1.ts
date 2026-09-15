/**
 * §35.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.1's recurring clocks (SM_PROJECTION_LAG_DAILY, SM_SWEEP_HEARTBEAT_DAILY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.1
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_PROJECTION_LAG_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.1 timer table row `SM_PROJECTION_LAG_DAILY`: recurring on `projection.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `projection.run_completed`, breach 'sev 3 → `ops_analyst` (no verify run today; the day's gaps and mismatches are unreviewed)' — 'Trigger & frequency: On every `POST /v1/loans/{id}/tools/{process}/{name}` and `/v1/applications/{id}/tools/…` command; on every sweep (Cloud Scheduler, once a minute); the verify run daily at 06:00 America/New_York'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 2: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_SWEEP_HEARTBEAT_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.1 timer table row `SM_SWEEP_HEARTBEAT_DAILY`: recurring on `sweep.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `sweep.run_completed`, breach 'sev 2 → `ops_analyst` (no sweep completed in a calendar day: the scheduler, the job or the lease is broken)' — 'Trigger & frequency: On every `POST /v1/loans/{id}/tools/{process}/{name}` and `/v1/applications/{id}/tools/…` command; on every sweep (Cloud Scheduler, once a minute); the verify run daily at 06:00 America/New_York'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
