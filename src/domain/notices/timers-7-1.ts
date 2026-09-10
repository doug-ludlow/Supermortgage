/**
 * §7.1 timer overrides (process-owned; the §7 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 7.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Conventions the grammar forces (src/kernel/events/match.ts holds ONE dotted pattern per column; conditions are exact
 * string compares on payload fields): an " A or B " satisfier becomes one resolution event the pipeline
 * (ops-7-1.ts StatementCycleService) appends in both branches alongside the spec's own events; an anchor named in
 * prose ("charge-off date", "return date", "statement_due_by of that cycle", "Oct 15 following year") becomes the
 * payload field the emitting code path carries.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_7_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("REGZ_1026_41B_STATEMENT_PROMPT_4", { satisfied: "`statement.cycle.closed{outcome∈{sent, exempt}}`",
    why: "§7.1 timer table: satisfied by '`statement.sent` (mailed_at, availability email sent, or portal post + notification) for the cycle; or `statement.cycle.exempt` with valid (e)(5)/(e)(6)/(g) reason' — one resolution event the pipeline appends in both branches: StatementCycleService.statementSent → `statement.cycle.closed{outcome=sent}` with the spec's `statement.sent`, and recordExempt → `statement.cycle.closed{outcome=exempt}` with `statement.cycle.exempt`, only after the evidence guardrail ('a cycle cannot be marked exempt without a linked evidence document'; returned mail and FDCPA cease never qualify). A bare `statement.sent` left every exempt cycle to breach sev-2." });
  o("REGZ_1026_41E6_CHARGEOFF_NOTICE_30", { anchorField: "charged_off_on",
    why: "§7.1 timer table: `loan.charged_off` → anchor 'charge-off date', +30 calendar_days (§1026.41(e)(6)(i)(B): 'within 30 days of charge-off'); StatementCycleService.recordChargeOff carries the approval's date as `charged_off_on` (7.1-T7: approved Nov 3 → notice by Dec 3). Satisfied by `notice.sent{template=NTC_REGZ_41E6_CHARGEOFF_SUSPENSION}` (section override; NoticeService.send)." });
  o("REGZ_1026_41E3IV_COUPON_DELQ_NOTICE", { trigger: "`delinquency.crossed_45{coupon_book=true}`", anchorField: "statement_due_by",
    why: "§7.1 timer table: kind 'deadline (feature `statements.coupon_books`, default off)', trigger `delinquency.crossed_45`, anchor 'statement_due_by of that cycle', +4 calendar_days, satisfied by `NTC_REGZ_41E3IV_COUPON_DELQ_NOTICE` sent (§1026.41(e)(3)(iv): the (d)(8) information 'in writing, for any billing cycle during which the consumer is more than 45 days delinquent'). Arms only for a coupon-book borrower with the feature on — StatementCycleService.recordDelinquencyCrossing carries `coupon_book` and the cycle's `statement_due_by`; every other loan gets the (d)(8) box on the statement itself (rule 4)." });
  o("FNMA_D2_2_03_PAYMENT_REMINDER_20", { satisfied: "`payment.reminder.sent{via∈{statement_panel, standalone_notice}}`",
    why: "§7.1 timer table: satisfied by '`statement.sent` with `reminder_panel=true` dated ≤ 20th, or `NTC_FNMA_D2_2_03_PAYMENT_REMINDER` sent; cancelled by `payment.applied` (full periodic payment) or `forbearance.active`' (D2-2-03, 08/13/2025). One resolution event for the two alternatives: StatementCycleService.statementSent appends `payment.reminder.sent{via=statement_panel}` with a panelled statement (rule 10; 7.1-T8), sendStandaloneReminder appends `{via=standalone_notice}` after the standalone notice (held statement); `on_time` records the ≤ 20th test. Cancellation: StatementCycleService.subscribe cancels the open instance on `payment.applied{full_periodic_payment=true}` / `forbearance.active` (TimerEngine.cancel)." });
  o("IRS_6050H_1098_FILE_0331", { satisfied: "`tax_form.1098.filed{irs_accepted=true}`",
    why: "§7.1 timer table: satisfied by '`tax_form.1098.filed` + IRS acceptance' (IRC §6050H; e-file by Mar 31, 10-or-more mandate) — StatementCycleService.record1098Filed ingests the IRIS/FIRE acceptance file and carries `irs_accepted` with the receipt id; a rejected transmittal never closes the timer (corrections are resubmitted)." });
  o("IRS_1098_EFURNISH_ACCESS_1015", { trigger: "`tax_form.1098.furnished{channel=electronic}`", anchorField: "tax_year_end",
    why: "§7.1 timer table: trigger '`tax_form.1098.furnished` (electronic)', anchor 'Oct 15 following year' — the year following the TAX year (Treas. Reg. §1.6050H-2 / Pub. 1179: continued access 'through October 15 of the following year'; 7.1-T13: tax year 2026, furnished Jan 2027 → accessible through Oct 15, 2027). The row therefore anchors on the furnished event's `tax_year_end` (2026-12-31 → 2027-10-15) rather than the furnish date, which would put the gate a year late (2028-10-15). Paper furnishing never arms it. Satisfied by the daily portal check `tax_form.1098.access_verified{available=true}` (section override; StatementCycleService.verify1098Access)." });
  o("SM_STATEMENT_RETURNED_MAIL_5", { anchorField: "returned_at",
    why: "§7.1 timer table: `notice.returned` → anchor 'return date', +5 business_days_servicer, satisfied by `address.research.completed` (policy; state machine 'returned → address_research → re_sent'). NoticeService.recordReturned carries the vendor's `returned_at`; StatementCycleService.completeAddressResearch records the outcome — statements continue to the address of record meanwhile (guardrail: 'the agent cannot suppress a statement for returned mail')." });
}
