/**
 * §7.2 timer overrides (process-owned; the §7 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 7.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events named here are appended by src/domain/notices/ops-7-2.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_7_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- the (c) notice clocks arm on the schedule row of the kind they govern (data model `arm_schedule.notice_kind`) ----
  o("REGZ_1026_20C_ADJ_NOTICE_NOT_BEFORE_120", { trigger: "`arm.schedule.row_created{notice_kind∈{c_60_120, c_25_120}}`",
    why: "§7.2 timer table: `arm_schedule` row → not before `first_new_payment_due` − 120 (§1026.20(c)(2): 'no more than 120 days' applies to the 60–120 and the 25–120 rows); a `c_first_25` row ('as soon as practicable, but not less than 25 days') and an exempt `fnma_only` row ((c)(1)(ii)) have no not-before gate. ops-7-2.buildSchedule sets `notice_kind`; scheduleNextChange emits the row." });
  o("REGZ_1026_20C_ADJ_NOTICE_60", { trigger: "`arm.schedule.row_created{notice_kind=c_60_120}`",
    why: "§7.2 timer table: `arm_schedule` row → '`notice.sent` (`NTC_REGZ_20C_ARM_ADJ`)' by `first_new_payment_due` − 60 (§1026.20(c)(2)) — only on a standard 60–120 row: a frequent adjuster / pre-2015 short look-back carries the 25-day row `REGZ_1026_20C_FREQ_ADJ_NOTICE_25` instead ('at least 25, but no more than 120, days … for ARMs with uniformly scheduled interest rate adjustments occurring every 60 days or more frequently'), so the −60 sev-1 must not arm on it." });
  o("REGZ_1026_20C_FREQ_ADJ_NOTICE_25", { trigger: "`arm.schedule.row_created{notice_kind=c_25_120}`",
    why: "§7.2 timer table: 'deadline (loans with ≤60-day adjustments or pre-2015 <45-day look-back)' → the (c) notice by −25 (§1026.20(c)(2)); the schedule row's `notice_kind = c_25_120` is that classification (7.2-T6: 1-month adjuster → 2026-11-06 for a 2026-12-01 payment)." });
  o("REGZ_1026_20C_FIRST_ADJ_ESTIMATE_25", { trigger: "`arm.schedule.row_created{notice_kind=c_first_25}`",
    why: "§7.2 timer table: `loan.boarded` → the (c) notice by `first_new_payment_due` − 25 'for the first adjustment to an ARM if it occurs within 60 days of consummation and the new interest rate disclosed at consummation pursuant to § 1026.20(d) was an estimate' (§1026.20(c)(2)(iii)). 1.1's `loan.boarded` carries no ARM terms and no `first_new_payment_due`; the schedule row 7.2 builds from it (spec input 1: '`loan.boarded` with `loan_terms.product = ARM` → build `arm_schedule`') carries the anchor and the classification `c_first_25`, so the deadline arms on that row — never on a fixed-rate boarding." });
  // ---- anchors the column grammar could not read from prose ----
  o("FNMA_IRM_LAR83_RATE_CHANGE_BD5", { anchorField: "calculation_date", satisfied: "`investor_events.accepted{event_type=rate_payment_change}`",
    why: "§7.2 timer table: `arm.adjustment.calculated` → anchor 'index/calculation date' (+5 `business_days_fannie_et`, 20:00 ET; 7.2-T7: verified 2026-09-17 → due 2026-09-24 20:00 ET), satisfied by the accepted investor event. 5.1 spells Fannie Mae's acknowledgment `investor_events.accepted` (src/domain/investor/timers.ts; ops-10-2.ingestLar89Feedback) with `event_type` — rule 7's `rate_payment_change`; ops-7-2.ingestLar83Feedback appends it from the LSDU feedback." });
  o("FNMA_C2_1_02_BUYDOWN_STEP_NOTICE_90", { anchorField: "step_date",
    why: "§7.2 timer table: `buydown.step.scheduled` → anchor 'payment change date' − 90 calendar days (C-2.1-02: 'notification detailing the pending interest rate increase … 90 days prior to the payment change'); the step event's `step_date` is that date (7.2-T9: step 2027-01-01 → send by 2026-10-03)." });
  o("FNMA_C2_2_01_ARM_INQUIRY_INTERIM_20", { anchorField: "received_on", satisfied: "`arm.inquiry.responded{response∈{resolved, interim_notice}}`",
    why: "§7.2 timer table: `arm.error.suspected` (borrower inquiry) → anchor 'receipt date' + 20 calendar days, satisfied by '`arm.correction.resolved` or `NTC_ARM_INQUIRY_INTERIM_20` sent' (C-2.2-01: 'send an interim response if a borrower inquiry cannot be resolved within 20 days'). The grammar carries one pattern, so the process records the C-2.2-01 response act once as `arm.inquiry.responded` with the path in `response`: ops-7-2.resolveArmInquiry appends the spec's `arm.correction.resolved` and `{response=resolved}`; sendInterimResponse sends the interim notice through the registry and appends `{response=interim_notice}`." });
  o("FNMA_C2_2_01_ARM_ERROR_CORRECT_60", { anchorField: "confirmed_on", satisfied: "`arm.correction.completed{records_corrected=true, borrower_notified=true, irr_discussed=true}`",
    why: "§7.2 timer table: `arm.error.confirmed` → anchor 'confirmation date' + 60 calendar days, satisfied by '`arm.correction.completed` (records corrected, borrower notified, IRR discussion logged)' (C-2.2-01: 'make arrangements within 60 days to correct the error(s) in its and Fannie Mae's records', 'notify the borrower about the effect of the correction', not report 'until it has discussed the specifics … with its Fannie Mae Investor Reporting Representative'); ops-7-2.completeCorrection appends the event only with all three flags true (7.2-T10)." });
  o("FNMA_F1_01_CONVERSION_NOTICE_25", { anchorField: "new_payment_effective_date",
    why: "§7.2 timer table: `arm.conversion.elected` → anchor 'new payment effective date' − 25 calendar days (F-1-01 conversion timetable: 'twenty-five days before the effective date of the new payment'); ops-7-2.electConversion appends the election with that date." });
}
