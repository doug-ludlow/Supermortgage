/**
 * §22.2 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 22.2 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 * The events named here are appended by src/domain/verification/ops-22-2.ts (through src/app/tools/section22-2.ts):
 * `credit.report.received{report_date, expires_at}` (placeOrder), `credit.report.superseded` (supersedeReport),
 * `credit.freeze.detected{borrower_notified_at}` / `credit.freeze.lifted` (detectFreezes / liftFreeze),
 * `credit.dispute.detected{investigation_required, du_findings_received_at}` / `credit.dispute.resolved`
 * (mapDuCreditMessages / resolveDispute), `credit.udm.heartbeat` (recordUdmHeartbeat), `credit.refresh.received{alerts_open}`
 * (receiveRefresh). `REGB_1002_9_DECISION_30` is 20.3's/21.6's row (referenced: 22.2 flags DU-ineligible findings early so
 * 21.6 can act inside the 30 days; never re-anchored here); `FNMA_B3_2_10_*` (23.1) and `REGZ_1026_19E2_INTENT_FEE_GATE`
 * (21.4; the credit-report fee exception is asserted through 21.4's evaluateFeeGate) are referenced, never redefined.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_22_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // R3 / T4: an expiry gate, not a clock — `expires_at = add_months(report_date, 4)`, open iff expires_at ≥ scheduled_note_date; the re-pull that supersedes the report retires its gate instance.
  o("FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M", { trigger: "`credit.report.received`", evaluator: "22.2.creditReportExpiry4m", anchorField: "report_date", satisfied: "`credit.report.superseded`",
    why: "§22.2 timer table: 'not_before_gate (expiry gate)', trigger '`credit.report.received` and every `closing.scheduled`', anchor `report_date`, offset '`expires_at = add_months(report_date, 4)`; gate open iff `expires_at ≥ scheduled_note_date`', satisfied by '`assertGateOpen` before `submitDuFinal` (23.1), `issueCD` (25.2), `consummate`', breach 'sev 2 → new tri-merge ordered (same `score_model`), DU resubmission (23.1), pricing re-check (20.4)' (B1-1-03: 'Credit documents must be no more than four months old on the note date'). evaluators-22-2.ts `22.2.creditReportExpiry4m`; ops-22-2 assertGateOpen; T4: report Oct 5, 2026 → expires Feb 5, 2027 < note date Feb 8, 2027 → closed." });
  // R3 / T4: the warning anchors on the report's own expires_at (payload of credit.report.received) and is retired by the re-pull (`credit.report.superseded`); closing before expires_at cancels it (scheduleRepull → gate_open).
  o("SM_CREDIT_EXPIRY_WARN_21", { anchorField: "expires_at", satisfied: "`credit.report.superseded`",
    why: "§22.2 timer table: 'deadline (warning)', trigger `credit.report.received`, anchor `expires_at`, '−21 `calendar_days`', satisfied by 'closing confirmed before `expires_at`, or re-pull complete', breach 'sev 3 → agent schedules the re-pull to land ≥ 10 `calendar_days` before the scheduled note date' — placeOrder puts `expires_at` on `credit.report.received`; supersedeReport emits `credit.report.superseded` (re-pull complete); T4: expires Feb 5, 2027 → fires Jan 15, 2027; re-pull by Jan 29, 2027." });
  // R9: a daily recurring row satisfied (and re-armed) by the vendor's heartbeat; the tool cancels it at closing.consummated; a missed heartbeat breaches → the soft refresh substitutes.
  o("SM_UDM_MONITOR_ACTIVE", { offset: "daily", anchorField: "report_date", satisfied: "`credit.udm.heartbeat`",
    why: "§22.2 timer table: 'recurring (daily poll if no webhook)', trigger `credit.report.received`, anchor `report_date`, offset 'daily until `closing.consummated`', satisfied by 'vendor heartbeat', breach 'sev 3 → refresh soft pull substitutes on the day of CD issuance and the day before consummation' — recordUdmHeartbeat emits `credit.udm.heartbeat{vendor}`; triageUdmAlert op=stop cancels the instances on `closing.consummated`." });
  // R9 / T9: a condition-shaped gate over the refresh date and the alert statuses; a clean refresh (alerts_open=0) satisfies the instance.
  o("SM_CREDIT_REFRESH_PRECLOSE_GATE", { evaluator: "22.2.refreshPrecloseGate", anchorField: "scheduled_consummation_date", satisfied: "`credit.refresh.received{alerts_open=0}`",
    why: "§22.2 timer table: 'not_before_gate' on `disclosure.cd.delivered`, anchor `scheduled_consummation_date`, offset 'a `soft_refresh` (or UDM clean snapshot) dated ≤ 3 `business_days_creditor` before consummation with all alerts `resolved`', satisfied by '`assertGateOpen` before `consummate` (25.3/26.1 closing package release)', breach 'sev 2 → agent orders the refresh; unresolved `verified_new_debt` → 22.5 recalculation and 23.1 resubmission before signing' — evaluators-22-2.ts `22.2.refreshPrecloseGate`; receiveRefresh emits `credit.refresh.received{alerts_open}`; T9: consummation Fri Nov 6, 2026 → refresh dated ≥ Tue Nov 3 opens, Mon Nov 2 does not (22.5 shares the gate by reference)." });
  // R4 / T2–T3: anchored on the borrower notification stamped on the detection event; the borrower's lift confirmation satisfies it (the re-pull follows inside the lift window).
  o("SM_CREDIT_FREEZE_FOLLOWUP_2", { anchorField: "borrower_notified_at", satisfied: "`credit.freeze.lifted`",
    why: "§22.2 timer table: 'deadline (policy)', trigger `credit.freeze.detected`, anchor `borrower_notified_at`, '+2 `calendar_days`, then every 3 days', satisfied by `credit.freeze.lifted`, breach 'after 10 days → 21.6 incompleteness evaluation (NOIA lists \"lift the security freeze at {bureau}\")' — detectFreezes emits `credit.freeze.detected{borrower_id, repositories, frozen_count, blocks_du, borrower_notified_at}`; liftFreeze emits `credit.freeze.lifted{lift_window_start, lift_window_end}`; declineLift routes to 21.6 (Q5: +2 days, then every 3, NOIA at +10)." });
  // R6: only a DU disputed-tradeline message that requires investigation (non-medical) arms the clock; it anchors on the DU findings timestamp the mapping carries, and the documented determination satisfies it.
  o("SM_CREDIT_DISPUTE_RESOLUTION_5", { trigger: "`credit.dispute.detected{investigation_required=true}`", anchorField: "du_findings_received_at", satisfied: "`credit.dispute.resolved`",
    why: "§22.2 timer table: 'deadline', trigger '`credit.dispute.detected` with DU message requiring investigation', anchor `du.findings.received`, '+5 `calendar_days`', satisfied by '`credit.dispute.resolved` with documentation', breach 'sev 3 → needs-list reminder (22.1); unresolved at CD → CD blocked' — mapDuCreditMessages emits `credit.dispute.detected{investigation_required, du_findings_received_at}` (medical-debt disputes carry investigation_required=false: B3-5.3-09 'lenders are not required to investigate disputed medical tradelines'); resolveDispute requires documentation_ids and emits `credit.dispute.resolved{determination}`." });
}
