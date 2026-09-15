/**
 * §35.5 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.5 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.5's recurring clocks (SM_CASHIERING_DAILY_RECEIPT_1D, SM_LOCKBOX_FILE_EXPECTED_1BD, SM_ACH_FILE_BUILD_1BD) are global: each is armed by a per-day (or per-run) completion receipt on
 * the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"` override
 * on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows of 35.5
 * parse and arm from the registry as written and need no override.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_CASHIERING_DAILY_RECEIPT_1D", { anchorField: "as_of_date", subject: "global",
    why: "§35.5 timer table row `SM_CASHIERING_DAILY_RECEIPT_1D`: recurring on `cashiering.daily.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `cashiering.daily.run_completed`, breach 'sev 2 → `officer` (no whole-book cashiering run completed for a calendar day; 35.4's `eod_cutoff` cannot receipt)' — 'Trigger & frequency: Per loan at `loan.boarded` (both paths) and at every `loan_terms.activated`; daily for the whole book (the `cashiering_daily` cycle of 35.3); daily on the lockbox file, the ACH file build and the NACHA return file'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 2: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_LOCKBOX_FILE_EXPECTED_1BD", { anchorField: "receipt_date", subject: "global",
    why: "§35.5 timer table row `SM_LOCKBOX_FILE_EXPECTED_1BD`: recurring on `lockbox.batch.received`, anchor `receipt_date`, offset '+1 business_days_servicer', satisfied by `lockbox.batch.received`, breach 'sev 2 → `officer` (no remittance file by 10:00 local on a servicer business day: SFTP, PGP or the bank — items may be waiting uncredited)' — 'Trigger & frequency: Per loan at `loan.boarded` (both paths) and at every `loan_terms.activated`; daily for the whole book (the `cashiering_daily` cycle of 35.3); daily on the lockbox file, the ACH file build and the NACHA return file'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor receipt_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 3: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_ACH_FILE_BUILD_1BD", { anchorField: "as_of_date", subject: "global",
    why: "§35.5 timer table row `SM_ACH_FILE_BUILD_1BD`: recurring on `ach.file.built`, anchor `as_of_date`, offset '+1 business_days_federal', satisfied by `ach.file.built`, breach 'sev 2 → `officer` (no ACH file built by 14:00 ET on a banking day: tomorrow's drafts will miss their settlement date and C-1.1-03's penalty-free window)' — 'Trigger & frequency: Per loan at `loan.boarded` (both paths) and at every `loan_terms.activated`; daily for the whole book (the `cashiering_daily` cycle of 35.3); daily on the lockbox file, the ACH file build and the NACHA return file'. The receipt is one global event per environment-day (or per run for the 90-day drill), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next completion and re-armed for the one after (anchor as_of_date + the row's offset) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
}
