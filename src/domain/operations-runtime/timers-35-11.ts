/**
 * §35.11 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.11 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.11's recurring clocks (SM_OPS_REPORT_DAILY, SM_HOSTED_PROBE_WEEKLY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.11
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_11(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_OPS_REPORT_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.11 timer table row `SM_OPS_REPORT_DAILY`: recurring on `ops.report.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `ops.report.run_completed`, breach 'sev 3 → `compliance` (no ops report for the environment-day: the sweep is not running the steward, or the report failed every firing)' — 'Trigger & frequency: Every sweep (the steward's pass after 35.3's planner and before 35.1's `sweep.run_completed`); the daily ops report once per environment-day; the hosted probe in CI on every push and against the deployed environment weekly; the persisted count after the §35 journeys on `supermortgage_test`'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 2: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_HOSTED_PROBE_WEEKLY", { anchorField: "as_of_date", subject: "global",
    why: "§35.11 timer table row `SM_HOSTED_PROBE_WEEKLY`: recurring on `audit.hosted.run_completed`, anchor `as_of_date`, offset '+7 calendar_days', satisfied by `audit.hosted.run_completed`, breach 'sev 3 → `qc_officer` (the hosted column is older than a week; the audit reports \"hosted: not measured\" until the probe runs again)' — 'Trigger & frequency: Every sweep (the steward's pass after 35.3's planner and before 35.1's `sweep.run_completed`); the daily ops report once per environment-day; the hosted probe in CI on every push and against the deployed environment weekly; the persisted count after the §35 journeys on `supermortgage_test`'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
