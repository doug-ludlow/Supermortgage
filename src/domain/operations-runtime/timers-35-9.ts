/**
 * §35.9 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.9 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.9's recurring clocks (SM_DEFAULT_CASE_DAILY, SM_BREACH_ACTION_RECON_DAILY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.9
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_9(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_DEFAULT_CASE_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.9 timer table row `SM_DEFAULT_CASE_DAILY`: recurring on `default_case.daily.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `default_case.daily.run_completed`, breach 'sev 2 → `officer` (no default run completed today: cases did not move, milestones were not checked, claims were not swept — the 35.3 planner's receipt is missing)' — 'Trigger & frequency: On every 11.x–15.x event (`timer.breached` included); the `default_case_daily` cycle (35.3, unit_scope loan) over every loan with an open delinquency window or case, planned for 05:30 America/New_York; the docket sync and the claims sweep as units of the same cycle; on every act on 35.8's `foreclosure_case`, `bankruptcy_case` and `lossmit_decision` screens'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 2: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_BREACH_ACTION_RECON_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.9 timer table row `SM_BREACH_ACTION_RECON_DAILY`: recurring on `breach_action.recon.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `breach_action.recon.run_completed`, breach 'sev 2 → `compliance` (no reconciliation today, or the last one found a breach of the day without its action row or an action whose outcome is failed)' — 'Trigger & frequency: On every 11.x–15.x event (`timer.breached` included); the `default_case_daily` cycle (35.3, unit_scope loan) over every loan with an open delinquency window or case, planned for 05:30 America/New_York; the docket sync and the claims sweep as units of the same cycle; on every act on 35.8's `foreclosure_case`, `bankruptcy_case` and `lossmit_decision` screens'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
