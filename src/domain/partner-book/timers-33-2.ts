/**
 * §33.2 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 33.2 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Emitter: src/runtime/partner-book-review.ts partnerBookReviewRun appends `partner_book.review.run_completed{run_id,
 * program_id, as_of_date, reviewed, candidates, watching, not_now, excluded, analyst_turns, analyst_skipped, origination: true}`
 * (global — the program aggregate) once per program per day; `partner_book.review.written{loan_id, party_id, as_of_date,
 * verdict, opportunity_id, origination: true}` per loan arms nothing. Referenced, never redefined: 20.1's
 * `SM_REFI_OFFER_SLA_2BD` (offer.deliver's touch satisfies it) and `SM_REFI_OPPORTUNITY_EXPIRY_30` (offer.expire runs on its breach).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_33_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: the daily review is a recurring clock — the day's clock on the global subject, re-armed by each completion (the same pattern as 20.1's SM_REFI_TRIGGER_DAILY, src/domain/leads-pricing/timers-20-1.ts).
  o("SM_PARTNER_BOOK_REVIEW_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 07:00 ET", subject: "global",
    why: "§33.2 timer table: recurring on `partner_book.review.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `partner_book.review.run_completed`, breach 'sev 3 → `compliance-sentinel` (the book was not reviewed today)' — 'Trigger & frequency: Daily at 07:00 America/New_York after 20.1's 06:30 run, over every monitored loan'; 'Key deadlines: The review by 07:30 ET each day'; 'Edge cases: No sheet in force → 20.1's run is skipped and so is the review; the clock breaches at 07:00 tomorrow'. The receipt is one global event per program per day (src/runtime/partner-book-review.ts partnerBookReviewRun, `run_id = review-<as_of>-<program>`, idempotent per day), so the clock is the platform DAY's, not a loan's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next day's completion and re-armed for the day after at 07:00 ET (anchor as_of_date + 1 calendar day, 07:00 America/New_York); the sweep runs the review at/after 07:00 ET before its breach pass, so a day whose review completed never breaches." });
}
