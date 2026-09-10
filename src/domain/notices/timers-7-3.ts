/**
 * §7.3 timer overrides (process-owned; the §7 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 7.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every event named here is appended by ops-7-3.ts (the (d)-notice process) or by
 * ops-7-2.ts (the ARM schedule); the conditions are exact string compares on payload fields
 * (src/kernel/events/match.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_7_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("REGZ_1026_20D_INITIAL_NOTICE_210", { satisfied: "`arm.initial_notice.*{satisfies_timer=true}`",
    why: "§7.3 timer table: satisfied by '`notice.sent` (`NTC_REGZ_20D_ARM_INITIAL`) or `arm.initial_notice.transferor_evidenced`' — two alternatives the one-pattern grammar cannot carry, so the row closes on the spec's own `arm.initial_notice.*` loan-event family (7.3 outputs: `…sent/originator_duty/transferor_evidenced/late`) restricted to the members ops-7-3 marks `satisfies_timer=true`: `arm.initial_notice.sent` (appended by `sendInitialNotice` only after the Notice Registry's `notice.sent{template=NTC_REGZ_20D_ARM_INITIAL}`, its causation), `arm.initial_notice.transferor_evidenced` (appended by `determineInitialNoticeStatus` only with the transferor's attached document — the agent guardrail), and the not-due determinations `arm.initial_notice.originator_duty` (the (d) disclosure was provided at consummation, (d)(2), evidenced by `documents.kind = arm_initial_disclosure_consummation`) and `arm.initial_notice.exempt_short_term` ((d)(1)(ii)). `window_opened`, `file_check_opened`, `render_requested`, `status_determined` and `late` never carry the field and never close the clock." });
  o("SM_ARM_INITIAL_FILE_CHECK_T0", { trigger: "`arm.initial_notice.file_check_opened{within_300_days=true}`", anchorField: "boarded_on",
    why: "§7.3 timer table: trigger '`loan.boarded` (ARM within 300 days of first new payment due)', anchor 'boarding date', +5 `business_days_servicer`, satisfied by `arm.initial_notice.status_determined` (sev-2). The boarding service's `loan.boarded` carries no product or first-change fields, so the parenthetical could never be a payload condition on it; ops-7-3 `openInitialFileCheck` is the 7.3 handler for `loan.boarded` (spec inputs: '`loan.boarded` inside/after the window → immediate assessment'): it reads the boarded `loan_terms`/`arm_schedule` (7.2), returns without an event for a non-ARM loan, and appends `arm.initial_notice.file_check_opened{boarded_on, first_new_payment_due, days_to_first_new_payment, within_300_days}` with the boarding date as the anchor — only an ARM within 300 days arms the 5-business-day status-determination clock (edge 'Plan 4926 loans transferred in month 32–36 … 1.7 checklist forces status determination within 5 business days'). `determineInitialNoticeStatus` appends the satisfying `arm.initial_notice.status_determined{status}`." });
}
