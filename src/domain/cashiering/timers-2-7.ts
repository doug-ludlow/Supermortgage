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
}
