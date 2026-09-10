/**
 * §3.5 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Registry row: trigger `loan.paid_in_full`, anchor "payoff posting date", 5 business_days_servicer, satisfied by "release of
  // in-flight tax/insurance disbursements or their cancellation". The 16.2 `loan.paid_in_full` payload carries the posting date
  // as `payoff_date`; the settlement fact is `escrow.final_disbursements.settled`, appended by settleFinalDisbursements
  // (ops-3-5.ts) from the 3.5 issueRefund tool once every in-flight item is released or cancelled (rule 1).
  // Registry row: anchor "payoff posting date" (the `payoff_date` the 16.1/16.2 `loan.paid_in_full` payloads carry), not the
  // clock date of the arming event: T4 "payoff posted Thu 2027-02-11 → due 2027-03-12" holds whenever the posting is recorded.
  o("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", { anchorField: "payoff_date",
    why: "§3.5 timer table: `loan.paid_in_full` → 'payoff posting date' + 20 business_days_federal (T4: Thu 2027-02-11 → Fri 2027-03-12, Presidents' Day excluded); the posting date is the payload's `payoff_date`." });
  o("ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD", { anchorField: "payoff_date", satisfied: "`escrow.final_disbursements.settled`",
    why: "§3.5 timer table: `loan.paid_in_full` → payoff posting date (`payoff_date` on the 16.2 payload) + 5 business_days_servicer; satisfied by 'release of in-flight tax/insurance disbursements or their cancellation' — `escrow.final_disbursements.settled` from settleFinalDisbursements; breach: 'refund waits for settlement of in-flight items but never beyond the 20-BD deadline'." });
}
