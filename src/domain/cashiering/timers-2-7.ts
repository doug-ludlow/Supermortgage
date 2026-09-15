/**
 * §2.7 timer overrides (process-owned; the §2 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 2.7 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Every trigger and satisfier named here is appended to the event store by src/domain/cashiering/ops-2-7.ts
 * (LateChargeOps) or ./ops.ts (CashieringOps.runAssessment / waive) through the 2.7 tools in
 * src/app/tools/section02.ts — never by a bare literal. Conditions are exact string compares on payload fields
 * (src/kernel/events/match.ts).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_2_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The 1-CD assessment clock closes on a decision, not on a backlog deferral: the run records `deferred_backlog` when receipts
  // dated ≤ grace end are unposted (rule 3(ix)) and the clock stays open until the true `credited_as_of` dates decide it.
  o("SM_LATE_CHARGE_ASSESS_1CD", { anchorField: "grace_end_on", satisfied: "`late_charge.assessment.decided{outcome∈{assessed, accrued_suspended, not_assessed}}`",
    why: "§2.7 timer table: satisfied by '`fee.assessed` or `not_assessed` decision', breach 'sev-3; must complete before CD20' — ops.runAssessment records one `late_charge.assessment.decided{outcome}` per run; a `deferred_backlog` outcome is the posting-backlog gate deferring the decision (rule 3(ix)), not the decision, so it does not close the clock." });
  // The forbearance gate anchors on the plan start carried by the 12.x hand-off (LateChargeOps.forbearanceOpened).
  o("FNMA_D23201_FORBEARANCE_NO_ACCRUAL_GATE", { anchorField: "plan_start", evaluator: "2.7.forbearanceNoAccrual",
    why: "§2.7 timer table: trigger '`case.forbearance.opened`', anchor 'plan start', offset 'through plan end (or default date)', breach '`mode=no_accrual`; accrual resumes from the plan default date' — the hand-off event carries `plan_start`; the evaluator reads `forbearance_active`/`defaulted_on`/`installment_due_date` (D2-3.2-01)." });
  // The repayment-plan waiver is due the day the plan completes and is satisfied by the waivers of the charges accrued during the plan.
  o("FNMA_D23202_REPAYMENT_WAIVE_ON_COMPLETION_0", { anchorField: "completed_on", satisfied: "`fee.waived{reason=workout_completion}`",
    why: "§2.7 timer table: trigger '`case.repayment.completed`', anchor 'completion', offset 'same day', satisfied by '`fee.waived` for charges accrued during the plan' — LateChargeOps.repaymentCompleted emits `case.repayment.completed{completed_on}` and waives each plan-period charge with reason `workout_completion` (D2-3.2-02: 'waive late charges accrued during the repayment plan period'); a courtesy or SCRA waiver of some other charge does not close it." });
  // The deferral-completion waiver: 12.6/12.7 spell the completion `smdu.case.submitted{workout, submitted_on}` (D2-3.2-04: a payment deferral
  // is completed when the case is submitted in Fannie Mae's servicing solutions system; the section12 `smdu.case.submit` tool emits it) — the
  // registry row's `smdu.case.completed{case_type=deferral}` is that event; it is satisfied by LateChargeOps.deferralCompleted's sweep
  // (`late_charges.all_waived{reason=deferral_completion}` — every late charge and returned-payment/stop-payment fee on the loan), not by a
  // single `fee.waived`, because the Guide waives them all.
  o("FNMA_D23204_LC_WAIVE_ON_DEFERRAL_COMPLETION_0", { trigger: "`smdu.case.submitted{workout∈{payment_deferral, disaster_payment_deferral}}`", anchorField: "submitted_on", offset: "same day", satisfied: "`late_charges.all_waived{reason=deferral_completion}`",
    why: "§2.7 timer table: trigger '`smdu.case.completed{case_type=deferral}` (12.6 payment deferral, D2-3.2-04; 12.7 disaster payment deferral, D2-3.2-05)', anchor 'completion date', offset 'same day', satisfied by 'all `late_charge` fees (and returned-payment/stop-payment fees) on the loan `waived{reason=deferral_completion}`', breach '12.6/12.7 completion asserts this gate; sev-2' — D2-3.2-04/-05: 'The servicer must waive all late charges, penalties, stop payment fees, or similar charges upon completing a payment deferral.'" });
}
