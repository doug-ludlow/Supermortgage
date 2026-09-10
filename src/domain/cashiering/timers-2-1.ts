/**
 * §2.1 timer overrides (process-owned; the §2 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 2.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_2_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The registry's anchor column is the prose "lockbox receipt date" (unparseable as a field). The lockbox intake
  // (ops-2-1.ts) puts the agent's receipt date — the bank's as-of date from the daily file — on the batch event as
  // `lockbox_receipt_date`, so a file that arrives late still runs both clocks from the day the agent received the
  // items (Edge cases: "lockbox file late → received_on from the bank's receipt log once delivered; timers keep running").
  o("FNMA_C1101_LOCKBOX_CLEARING_1BD", { anchorField: "lockbox_receipt_date",
    why: "§2.1 timer table: `lockbox.batch.received` → anchor 'lockbox receipt date' + 1 `business_days_servicer` to the collection clearing account (C-1.1-01: 'no later than the 1st business day after they are received by the lockbox agent'); satisfied by `custodial_deposits.clearing_deposited_at` (ops.recordDepositEvidence)." });
  o("FNMA_C1101_LOCKBOX_CUSTODIAL_2BD", { anchorField: "lockbox_receipt_date",
    why: "§2.1 timer table: `lockbox.batch.received` → anchor 'lockbox receipt date' + 2 `business_days_servicer` to the applicable custodial account (C-1.1-01: 'no later than the 2nd business day after the servicer's lockbox agent receives them'); satisfied by `custodial_deposits.custodial_deposited_at`; breach sev-1 (Guide breach; partner notified)." });
}
