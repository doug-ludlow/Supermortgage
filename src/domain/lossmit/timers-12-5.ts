/**
 * §12.5 timer overrides (process-owned; the §12 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 12.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events named here are appended by src/domain/lossmit/ops-12-5.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_12_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_D23202_REPAY_PAYMENT_EOM", { trigger: "`workout_plan_schedule.row_due{plan_kind=repayment}`", anchorField: "due_date", satisfied: "`workout_plan.payment.received{plan_kind=repayment, covers_expected_total=true}`",
    why: "§12.5 timer table: 'schedule row | due date | last day of month 23:59 servicer-local | received ≥ expected_total | workout_plan.payment.missed' — ops-12-5.ts `rowDue` appends `workout_plan_schedule.row_due{due_date, expected_total_cents}` on the row's due date (one clock per row) and `recordPlanPayment` appends `workout_plan.payment.received{covers_expected_total}` when the oldest unpaid row's receipts reach expected_total (rule 8); `monthEndSweep` appends the breach action `workout_plan.payment.missed`." });
  o("FNMA_F121_STATUS_12_BD2", { anchorField: "month_end",
    why: "§12.5 timer table: 'month-end with active plan | BD2 | 2 business_days_fannie_et | investor event accepted (5.x)' — ops-12-5.ts `monthEndSweep` appends `period.month_end{workout_plan_active=true, plan_kind=repayment, month_end}` for a loan with an active repayment plan, so BD2 counts from the month end itself rather than the sweep's run date; `ingestInvestorAck` appends `investor.event.accepted{status_code=12}` from the Fannie Mae acknowledgement (F-1-21)." });
  o("FNMA_F202_REPAY_INCENTIVE_CLAIM", { satisfied: "`investor.event.accepted{kind=incentive, workout=repayment_plan}`",
    why: "§12.5 timer table: '`investor_events{incentive}`' — ops-12-5.ts `claimIncentive` submits the $500 F-2-02 claim (`investor.incentive.claimed`) in the month after completion and `ingestInvestorAck` appends `investor.event.accepted{kind=incentive, workout=repayment_plan}` when Fannie Mae accepts it." });
}
