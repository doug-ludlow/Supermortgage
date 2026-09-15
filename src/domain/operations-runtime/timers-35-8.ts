/**
 * §35.8 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.8 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.8's recurring clocks (SM_WORK_LOG_RECON_DAILY) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.8
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_8(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_WORK_LOG_RECON_DAILY", { anchorField: "as_of_date", subject: "global",
    why: "§35.8 timer table row `SM_WORK_LOG_RECON_DAILY`: recurring on `work.log.recon.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `work.log.recon.run_completed`, breach 'sev 3 → `compliance` (no reconciliation of the action log today, or the last run found orphans or a stale screen version)' — 'Trigger & frequency: On demand by a staff session (34.1) holding the screen's role (35.7); per loan or application; the queue refreshes every sweep from the console's five item kinds plus 35.3's dead units and 35.6's held steps; the action-log reconciliation runs once a calendar day'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
