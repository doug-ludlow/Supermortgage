/**
 * §35.4 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.4 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * All four rows parse as written (`+1 business_days_fannie_et, 17:00 ET`, `+2 …`, `+5 …`, `+3 business_days_federal,
 * 17:00 ET`) and arm from their payload anchors (`period_end`, `started_at` — a timestamp anchors on its ET civil date,
 * `tax_year_end`). The two rows whose trigger is a global-subject event take the cited `subject: "global"` override on the
 * timers-33-2.ts precedent; the other two arm on the period aggregate the triggering event carries
 * (`{kind: close_period, id: <servicer_number>:<period>}` for `close.period.opened`; the step's own
 * `<servicer_number>:<period>:<step>` for `close.step.started`, so one step's completion satisfies its own clock only —
 * the spec's open question 7, decided 2026-09-16, since the engine satisfies every armed instance of a code on a subject).
 *
 * Emitters (src/domain/operations-runtime/close-35-4/): sweep.ts `ledger.month.ended{period_key, period_end}` (the fallback
 * until 35.3's planner emits it), open.ts `close.period.opened` / `close.tax_year.planned{tax_year, tax_year_end}`, plan.ts
 * `close.step.started{started_at}` / `close.step.completed`, attest.ts `close.period.attested`, taxyear.ts `close.tax_year.closed`.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("SM_CLOSE_PERIOD_OPEN_BD1", { subject: "global",
    why: "§35.4 timer table row `SM_CLOSE_PERIOD_OPEN_BD1`: deadline on `ledger.month.ended`, anchor `period_end`, offset '+1 business_days_fannie_et, 17:00 ET', satisfied by `close.period.opened`, breach 'sev 2 → `ops_analyst` (the month ended and no close period exists: the planner did not run or `close.open` failed)'. Timers note: '`ledger.month.ended` and `close.tax_year.planned` are global-subject events (no loan, no application): both rows take a cited `subject: \"global\"` override in `src/domain/operations-runtime/timers-35-4.ts` on the `timers-33-2.ts` precedent (`SM_PARTNER_BOOK_REVIEW_DAILY`, src/domain/partner-book/timers-33-2.ts:17-19)'." });
  o("SM_TAX_YEAR_CLOSE_3BD", { subject: "global",
    why: "§35.4 timer table row `SM_TAX_YEAR_CLOSE_3BD`: deadline on `close.tax_year.planned`, anchor `tax_year_end`, offset '+3 business_days_federal, 17:00 ET', satisfied by `close.tax_year.closed`, breach 'sev 1 → `officer` (no `tax_year.closed` per reportable loan by the third federal business day of January: 7.1's 31 January furnish clock cannot arm and the penalty log opens)'. Timers note: '`close.tax_year.planned{tax_year, tax_year_end: YYYY-12-31}` is emitted by the planner when it plans the December period's `tax_year_close` step (the day the December period opens), so the clock counts from 31 December regardless of when the planner first sees January' — a global-subject event, the cited `subject: \"global\"` override." });
}
