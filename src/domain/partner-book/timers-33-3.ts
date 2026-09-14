/**
 * §33.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 33.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Emitter: src/runtime/partner-book-readiness.ts readinessRun appends `partner_book.readiness.run_completed{run_id, as_of_date,
 * checked, ready, not_ready, origination: true}` (global) once per day; `partner_book.readiness.checked{loan_id, party_id,
 * application_id, as_of_date, ready, missing, origination: true}` per loan and `partner_book.refinance.opened` arm nothing.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_33_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: the daily readiness check is a recurring clock — the day's clock on the global subject, re-armed by each completion (the same pattern as 33.2's SM_PARTNER_BOOK_REVIEW_DAILY, ./timers-33-2.ts, and 20.1's SM_REFI_TRIGGER_DAILY).
  o("SM_PARTNER_BOOK_READINESS_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 07:15 ET", subject: "global",
    why: "§33.3 timer table: recurring on `partner_book.readiness.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `partner_book.readiness.run_completed`, breach 'sev 3 → `compliance-sentinel` (readiness was not checked today)' — 'Trigger & frequency: Daily at 07:15 America/New_York for every candidate and every open refinance application from a monitored loan'; 'Key deadlines: A readiness row per candidate by 07:30 ET'. The receipt is one global event per day (src/runtime/partner-book-readiness.ts readinessRun, `run_id = readiness-<as_of>`, idempotent per day), so the clock is the platform DAY's, not a loan's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next day's completion and re-armed for the day after at 07:15 ET (anchor as_of_date + 1 calendar day, 07:15 America/New_York); the sweep runs the pass at/after 07:15 ET, right after 33.2's review and before its breach pass, so a day whose readiness ran never breaches." });
}
