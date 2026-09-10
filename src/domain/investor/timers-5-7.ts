/**
 * §5.7 timer overrides (process-owned; the §5 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 5.7 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events named here are appended by src/domain/investor/ops-5-7.ts through the
 * src/app/tools/section5-7.ts tools; src/kernel/events/match.ts compares conditioned payload fields as strings.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_5_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_F121_DQ_REPORT_BD2", { satisfied: "`delinquency_reports.submitted{ack is not null}`",
    why: "§5.7 timer table: satisfied by '`delinquency_reports.submitted` with ack' — `submitAmnFile` (ops-5-7 `transmitAmnFile`) appends the event only with the B2B acknowledgement (or the AMN upload confirmation) as `ack`; a transmission without an ack is not a submission (F-1-21)." });
  o("FNMA_F121_DQ_CORRECT_CD10", { satisfied: "`delinquency_reports.corrections_accepted{ack is not null}`",
    why: "§5.7 timer table: 'corrections transmitted and accepted' by CD10 17:00 ET — `submitAmnFile{op=corrections}` (ops-5-7 `transmitCorrections`) appends `.corrections_accepted` carrying the correction file's `ack` (rule 8: critical exceptions corrected and retransmitted by CD10)." });
  o("FNMA_F121_DQ_FINAL_CD11", { satisfied: "`delinquency_reports.final_reconciled{status=final}`",
    why: "§5.7 state machine: `final` = 'CD11 final report reconciled, zero critical exceptions'; `parseExceptionReport{op=final}` (ops-5-7 `reconcileFinal`) appends `.final_reconciled{status}` from `reconcileFinalReport` — only `status=final` (zero critical, no mismatched line) satisfies; anything else opens the `fnma_portal_operator` pull." });
  o("FNMA_LL202605_DQ_EVENT_NEXTBD_0300", { anchorField: "processed_at",
    why: "§5.7 timer table: anchor `processed_at` — `submitDqEvent{op=record_action}` (ops-5-7 `recordDelinquencyAction`) appends `delinquency.action.processed{processed_at}` (ISO) when a §11–§14 action is processed; 'the same day … no later than 3:00 a.m. ET on the next business day' (LL-2026-05)." });
  o("FNMA_LL202605_DQ_PMT_REMINDER_CD23", { trigger: "`delinquency_report_lines.snapshot{periods_delinquent=1}`", satisfied: "`delinquency_events.accepted{servicer_action_type=Payment Reminder Notice}`",
    why: "§5.7 timer table: trigger '1 period delinquent' is a per-loan fact of the month-end snapshot (`buildDqSnapshot` appends one `delinquency_report_lines.snapshot{periods_delinquent}` per loan in the population, `fnma_delinquency_status` LPI-based), not a field of the period-level `period.month_end`; satisfied by 'Payment Reminder Notice event accepted' — the Servicing Platform response (`submitDqEvent{op=response}`, ops-5-7 `ingestEventResponse`) carries the Servicer Action Type as LL-2026-05 spells it, 'Payment Reminder Notice'; 'expected by CD23 at 1 period delinquent' (notification only)." });
  o("SM_DQ_SMDU_DRA_CONSISTENCY_BD1", { satisfied: "`delinquency_reports.consistency_checked{errors=0}`",
    why: "§5.7 rule 7 / timer table: 'AMN codes consistent with SMDU (workouts) and DRA/P360 (sale/REO) statuses' — `checkConsistency{op=file}` (ops-5-7 `fileConsistency`) appends `.consistency_checked{errors}` over the whole file before submission; only a clean file (`errors=0`) satisfies, blocked lines escalate sev-2 before BD2." });
}
