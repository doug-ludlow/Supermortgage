/**
 * §35.12 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, subject?, why })` per 35.12 registry row whose subject or offset the column grammar cannot state;
 * `why` quotes the spec. A code the servicing spec (sections 1–19) owns is never overridden here — reference it
 * (19.2's NYDFS_500_16D_BACKUP_RESTORE_TEST_365 is satisfied by the drill's `backup_restore_test.passed`, emitted by
 * src/domain/operations-runtime/posture-35-12/drills.ts on 19.2's own aggregate). Wired by src/domain/timer-overrides.ts.
 *
 * The three recurring rows (SM_PROD_POSTURE_DAILY, SM_PROD_RESTORE_DRILL_90D, SM_PROD_PARALLEL_RUN_DAILY) are the platform's clocks,
 * not a loan's: each is armed on the global subject by the first receipt, satisfied by the next and re-armed for the day (05:30 /
 * 21:00 America/New_York) or the quarter after — the src/domain/partner-book/timers-33-2.ts precedent (SM_PARTNER_BOOK_REVIEW_DAILY).
 * The two deadline rows (SM_PROD_POSTURE_DRIFT_1BD, SM_NONPROD_REAL_DATA_PURGE_1BD) parse and arm from the registry as written; their
 * subject is the trigger event's aggregate — `posture_finding:<finding_id>` (posture.drift.detected / .resolved) and
 * `data_scan:<scan_id>` (posture.real_data.detected / .purged) — because the events are global (no loan), so the payload key is
 * the subject (35.7's SM_ROLE_QUEUE_UNSTAFFED_1BD precedent; open question 6 answered). SM_PROD_GO_LIVE_ATTEST_GATE is a
 * not_before_gate: the registry's `+28 calendar_days` would give the instance a due instant the sweep's breach pass escalates on,
 * where the spec's breach column says "hold: go_live.attest answers GO_LIVE_GATE{not_before} until the day" — so it takes the
 * evaluator `35.12.goLiveGate` (evaluators-35-12.ts) on the 21.x gate precedent, armed on the global subject by
 * `parallel_run.opened{opened_on}` and satisfied by `go_live.attested`; an `extended` row and an abandoned close cancel the
 * open instance (posture-35-12/parallel-run.ts) so the gate is never satisfiable by a stale run.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_35_12(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: a recurring global clock — the environment day's, re-armed by each completion (timers-33-2.ts precedent).
  o("SM_PROD_POSTURE_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 05:30 ET", subject: "global",
    why: "§35.12 timer table row `SM_PROD_POSTURE_DAILY`: recurring on `posture.check.run_completed`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `posture.check.run_completed`, breach 'sev 2 → `ciso` (no posture run today: the environment is unmeasured)' — 'Trigger & frequency: … the posture check daily at 05:30 America/New_York as a 35.3 cycle (`posture.check`, global scope) and on every manifest'. The receipt is one global event per environment-day (posture-35-12/check.ts emits it once per (environment, as_of_date); a later run the same day emits `posture.check.run_repeated`), not a loan's or an application's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first completion, satisfied by the next day's completion and re-armed for the day after at 05:30 America/New_York (anchor as_of_date + 1 calendar day, 05:30 ET — T5: 'armed on the global subject for 2026-11-17 05:30 America/New_York') — the timers-33-2.ts precedent for a recurring global clock (SM_PARTNER_BOOK_REVIEW_DAILY)." });
  // Timer table row 3: a recurring global clock — the quarter's, re-armed by each passed drill.
  o("SM_PROD_RESTORE_DRILL_90D", { anchorField: "completed_at", subject: "global",
    why: "§35.12 timer table row `SM_PROD_RESTORE_DRILL_90D`: recurring on `backup.restore_drill.passed`, anchor `completed_at`, offset '+90 calendar_days', satisfied by `backup.restore_drill.passed`, breach 'sev 1 → `ciso` (the quarterly restore was not proven; 19.2's annual clock still runs)' — 'Trigger & frequency: … the restore drill every 90 calendar days'. The receipt is one global event per passed drill (posture-35-12/drills.ts), not a loan's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first passed drill, satisfied by the next and re-armed for 90 calendar days after its `completed_at` (the timestamp anchors on its Eastern civil date — T7: completed 2026-11-16T15:37:20Z → re-armed for 2027-02-14); a failed drill satisfies nothing (rule 5) — the timers-33-2.ts precedent for a recurring global clock." });
  // Timer table row 5: a recurring global clock — the parallel-run day's, re-armed by each reconciliation (21:00 ET).
  o("SM_PROD_PARALLEL_RUN_DAILY", { anchorField: "as_of_date", offset: "+1 calendar_days, 21:00 ET", subject: "global",
    why: "§35.12 timer table row `SM_PROD_PARALLEL_RUN_DAILY`: recurring on `parallel_run.day.reconciled`, anchor `as_of_date`, offset '+1 calendar_days', satisfied by `parallel_run.day.reconciled`, breach 'sev 2 → `officer` (a parallel-run day was not reconciled; the clean-week count resets)' — 'Trigger & frequency: … the parallel-run reconciliation daily at 21:00 America/New_York for 28 consecutive days'. The receipt is one global event per reconciled day (posture-35-12/parallel-run.ts), not a loan's, so the clock is the platform's: armed on the global subject (subject: \"global\") by the first reconciliation, satisfied by the next day's and re-armed for the day after at 21:00 America/New_York (anchor as_of_date + 1 calendar day, 21:00 ET — T12: 'armed on the global subject for 2026-11-17 21:00 America/New_York'; a late file reconciles the day it names, edge cases) — the timers-33-2.ts precedent for a recurring global clock." });
  // Timer table row 6: the not-before gate of the go-live — evaluator-backed on the 21.x gate precedent (no due instant to breach; the hold is the tool's refusal).
  o("SM_PROD_GO_LIVE_ATTEST_GATE", { anchorField: "opened_on", evaluator: "35.12.goLiveGate", subject: "global",
    why: "§35.12 timer table row `SM_PROD_GO_LIVE_ATTEST_GATE`: not_before_gate on `parallel_run.opened`, anchor `opened_on`, offset '+28 calendar_days', satisfied by `go_live.attested`, breach 'hold: `go_live.attest` answers `GO_LIVE_GATE{not_before}` until the day; escalate `compliance` if attested by any other path' — rule 9/10: 'nothing goes live before the 28th day and the two-person attestation'. The gate holds, it does not breach: a `+28 calendar_days` step would give the instance a due instant the sweep's breach pass turns into an escalation on day 29, so the row is evaluator-backed (evaluators-35-12.ts `35.12.goLiveGate`: open when the ET date ≥ opened_on + 28 calendar days — T10: opened 2026-11-02 → not before 2026-11-30) and armed on the global subject (subject: \"global\") by `parallel_run.opened`, satisfied by `go_live.attested` (posture-35-12/go-live.ts), re-anchored by an `extended` row and cancelled by an abandoned close (parallel-run.ts) so a stale run never satisfies it." });
}
