/**
 * §35.11 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 35.11 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * 35.11's recurring clocks (SM_OPS_REPORT_DAILY, SM_HOSTED_PROBE_WEEKLY) are global: each is armed by a per-day (or per-run)
 * completion receipt on the global subject, not by a loan or application aggregate, so each takes the cited `subject: "global"`
 * override on the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY). The deadline rows arm on the
 * exception aggregate (`ops_exception:<id>`, src/domain/operations-runtime/stewardship.ts) and need no subject override.
 * SM_OPS_ADAPTER_DOWN_1H and SM_OPS_CYCLE_MISSED_2H are hour offsets — the grammar's `hours` unit (src/kernel/timers/offset.ts)
 * evaluated on the anchor instant. The registry notes call the `kind = adapter_down` filter and the `consecutive_misses ≥ 2`
 * severity step "evaluators": an `evaluator:` offset has no due instant and never breaches (engine.ts computeDue), so the filter
 * is the trigger's own condition (the event-pattern grammar, src/kernel/events/match.ts) and the severity step is the breach
 * pass's enricher for this code (stewardship.ts BREACH_ENRICHERS, applied by src/runtime/app.ts when it opens the escalation).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_11(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the platform day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_OPS_REPORT_DAILY", { anchorField: "produced_on", offset: "+1 calendar_days, 00:15 ET", subject: "global",
    why: "§35.11 timer table row `SM_OPS_REPORT_DAILY`: recurring on `ops.report.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `ops.report.run_completed`, breach 'sev 3 → `compliance` (no ops report for the environment-day: the sweep is not running the steward, or the report failed every firing)'. Registry notes: '`+1 calendar_days, 00:15 ET`'. Rule 5: 'The first run of a day happens on the first sweep at or after 00:15 ET (the previous day's report, so the day's last sweep is in it)' — the report of day D is produced on D+1 at/after 00:15 ET, so a clock anchored on `as_of_date` (D) would be due at D+1 00:15, the instant it is produced, and breach in the same sweep. The receipt therefore carries `produced_on` (the ET date the report ran, stored beside `as_of_date` — an additive column, listed as an erratum in the build report) and the clock anchors on it: armed on the global subject (subject: \"global\") by the day's first completion, due the next day at 00:15 ET, satisfied by that day's completion (the steward pass runs before the breach pass) and re-armed for the day after — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 5: a recurring global clock — the hosted probe's week, re-armed by each run (timers-33-2.ts precedent).
  o("SM_HOSTED_PROBE_WEEKLY", { anchorField: "as_of_date", offset: "+7 calendar_days, 06:00 ET", subject: "global",
    why: "§35.11 timer table row `SM_HOSTED_PROBE_WEEKLY`: recurring on `audit.hosted.run_completed`, anchor `as_of_date`, offset '+7 calendar_days', satisfied by `audit.hosted.run_completed`, breach 'sev 3 → `qc_officer` (the hosted column is older than a week; the audit reports \"hosted: not measured\" until the probe runs again)'. Registry notes: '`+7 calendar_days, 06:00 ET`' — 'Trigger & frequency: … the hosted probe in CI on every push and against the deployed environment weekly'. The receipt is one global event per run, not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first run, satisfied by the next run within seven days and re-armed for the week after (anchor as_of_date + 7 calendar days, 06:00 ET) — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 3: the deadline arms only for an adapter classified down — the row's filter, as the trigger's condition.
  o("SM_OPS_ADAPTER_DOWN_1H", { trigger: "`ops.exception.classified{kind = adapter_down}`",
    why: "§35.11 timer table row `SM_OPS_ADAPTER_DOWN_1H`: deadline on `ops.exception.classified`, anchor `classified_at`, offset '+1 hours', satisfied by `ops.exception.resolved`, breach 'sev 2 → `ops_analyst` (an adapter classified down has had no successful send in an hour; the escalation names the adapter and the dead count — evaluator filters `kind = adapter_down`, see the override note)'. Registry notes: 'the same file adds the `evaluator` for the `kind = adapter_down` filter'. An `evaluator:` offset has no due instant (src/kernel/timers/engine.ts computeDue → {evaluator}) and could never breach into the sev 2 escalation T5 asserts, so the filter is expressed as the trigger pattern's condition (src/kernel/events/match.ts: `type{field = value}`): the clock arms on `ops.exception.classified{kind: adapter_down}` only — a transient, poison or needs_person classification arms nothing — with the hour offset on the anchor instant; the adapter and D15 are put on the breach escalation by the breach pass's enricher for this code (stewardship.ts BREACH_ENRICHERS)." });
}
