/**
 * §1.5 timer overrides (process-owned; the §1 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 1.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events named here are appended by src/domain/transfers/ops-1-5.ts and
 * inbound.ts through the 1.5 tools in src/app/tools/section01.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_1_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Anchors the column writes as prose: each is the `notice_date` / `received_on` / `period_end` the emitting event carries
  // (src/kernel/timers/engine.ts defaultAnchorResolver reads `payload[anchorField]`, falling back to the event's own ET date).
  o("MERS_PROC_TOS_CONFIRM_7", { anchor: "`notice_date`", anchorField: "notice_date",
    why: "§1.5 timer table: anchor 'pending notice date', offset +7 calendar_days [UNVERIFIED] — `mers.tos.pending_received` carries the notice's civil date as `notice_date` (ops-1-5.ts recordTosPendingNotices; 1.5-T2 'confirmation timers (7 days) are created per MIN'; worked example 2: pending notice Sept. 29 → confirmation due Oct. 6)." });
  o("MERS_RULE7_VIOLATION_RESPONSE_30", { anchor: "`notice_date`", anchorField: "notice_date",
    why: "§1.5 timer table: anchor 'notice date' — `mers.violation_notice.received` carries it as `notice_date` (inbound.ts violationNoticeReceived; 1.5-T7 notice Nov. 10, 2026 → due Dec. 10, 2026; Rule 7 §1(b) '30 days to provide a response and to remediate the Violation')." });
  o("MERS_RULE7_LOCKOUT_WARNING_30", { anchor: "`notice_date`", anchorField: "notice_date",
    why: "§1.5 timer table: anchor 'notice date' — `mers.lockout_warning.received` carries it as `notice_date` (ops-1-5.ts lockoutWarningReceived; Rule 7 §1(e) 30-day Lockout Warning Period); satisfied by 'remediation + penalties paid' = `mers.lockout.remediated{penalties_paid=true}` (section override)." });
  // The registry's bare `receipt` anchor parses as a payload field nothing carries; the extract's receipt date is `received_on` on both
  // the trigger and the satisfaction, so the recurring re-arm measures the next month from the extract received, not from the run.
  o("MERS_QA_MRE_RECON_MONTHLY", { anchor: "`received_on`", anchorField: "received_on",
    why: "§1.5 timer table: anchor 'receipt' of `mers.mre.received`, offset 'monthly (quarterly below 1,000 MINs) [PARTIALLY VERIFIED]' — the timer keeps the monthly row; `mers.mre.received`/`mers.recon.completed` carry `received_on` (ops-1-5.ts mreReceived / reconcileExtract), and the extract's `cadence` field records the quarterly relief below 1,000 MINs (Rule 2 §4 'adequate quality assurance program')." });
  // "Dec. 31 each year, offset 0": the platform's year-end close (`period.year_end{period_end}`, 18.7/19.1) is the calendar trigger, so the
  // instance it arms is the *next* reporting year's, due its Dec. 31 (period_end + 12 months); the submission carries the `period_end` of the
  // year reported, so the recurring re-arm lands on the following Dec. 31 too. "(both Org IDs)" is the `both_org_ids=true` the submission asserts.
  o("MERS_ANNUAL_REPORT_1231", { anchor: "`period_end`", anchorField: "period_end", offset: "+12 months", satisfied: "`mers.annual_report.submitted{both_org_ids=true}`",
    why: "§1.5 timer table: recurring, trigger 'calendar', anchor 'Dec. 31 each year', offset 0, satisfied by '`mers.annual_report.submitted` (both Org IDs)' [PARTIALLY VERIFIED] — armed by the year-end close for the following Dec. 31; ops-1-5.ts submitAnnualReport validates both Org IDs (partner + Supermortgage 1009999), the `officer` signature (1.5 escalations) and the third-party review at ≥ 1,000 active MINs (research/00b N1)." });
}
