/**
 * §6.2 timer overrides (process-owned; the §6 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 6.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events named here are the ones src/domain/custodial/ops-6-2.ts emits.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_6_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Anchor column "bank credit date" is the `credited_on` the statement parser puts on `custodial.interest.credited`
  // (ops-6-2 ingestTiStatementLine), not the day the line was ingested; "17:00 local" resolves to the servicer's
  // Eastern time (worked example: 2026-09-30 + 30 days = 2026-10-30T17:00 local; 6.2-T2/T4).
  o("FNMA_A4102_TI_INTEREST_DISBURSE_30", { anchorField: "credited_on", offset: "30 calendar_days, 17:00 ET", why: "§6.2 timer table: trigger `custodial.interest.credited`, anchor = bank credit date (`credited_on`), 30 calendar_days 17:00 local (servicer local = ET); satisfied by `custodial.interest.disbursed` (all of the credit moved out — proven from the ledger's interest-pending balance, ops-6-2)." });
  // Anchor column "receipt date" is `received_on` on 1.6's `transfer_in.purchase_proceeds.received`; the "(T&I)"
  // qualifier on the satisfying event is the `account_kind=ti` condition the column grammar drops — a P&I deposit
  // confirmation must not satisfy the boarding escrow deposit row (F-1-03: escrow balances and buydown funds
  // deposited within one business day after receiving purchase proceeds).
  o("FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD", { anchorField: "received_on", satisfied: "`custodial.deposit.confirmed{account_kind=ti}`", why: "§6.2 timer table: trigger `transfer_in.purchase_proceeds.received` / `transfer_in.funds.received` (1.6), anchor = receipt date (`received_on`), 1 business_days_servicer; satisfied by `custodial.deposit.confirmed` (T&I) → `{account_kind=ti}`; breach `officer`, high." });
}
