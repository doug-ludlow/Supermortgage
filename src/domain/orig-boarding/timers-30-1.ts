/**
 * §30.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 30.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it; 27.2's `SM_WH_INTERIM_FUNDER_RELEASE_2BD` and
 * `FNMA_C2_2_05_PPA_REQUEST_30` are referenced, not redefined (their events are emitted / consumed by ops-30-1.ts).
 * Wired by src/domain/timer-overrides.ts. The events named here are appended by src/domain/orig-boarding/ops-30-1.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_30_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Rule 1: the Fannie Mae loan number is entered "immediately" (C2-2-05) — same day 17:00 ET, anchored on the advice date 27.2's event carries.
  o("SM_FNMA_LOAN_NUMBER_RECORD_T0", { offset: "0, 17:00 ET", anchorField: "advice_date", satisfied: "`loan.investor_updated{investor=fnma}`",
    why: "§30.1 timer table: '0 business_days_fannie_et (same day, 17:00 ET)' from the Purchase Advice availability date; satisfied by `loan.investor_updated` with `fnma_loan_number` (purchaseUpdate writes investor='fnma' with the number)." });
  // Rule 5: the registry's offset is prose; TT96 user guide: LARs "in the same month that the loans are acquired" → 20:00 ET on the last Fannie Mae business day of the purchase month.
  // The BD1 prior-period limit for a purchase on the month's last business day (IRM 2-01) is computed by ops-30-1.ts firstLarClocks (the grammar has no "established on BD1" branch).
  o("FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2", { offset: "last business day of the same month, 20:00 ET (business_days_fannie_et)", anchorField: "purchase_date",
    why: "§30.1 timer table: '20:00 ET on the last business_days_fannie_et day of the purchase month — TT96 user guide: Servicers are required to report LARs in the same month that the loans are acquired' (re-verified 2026-09-11; BD2 17:00/15:00 ET are period close / bulk cut-off, not this deadline)." });
  // Rule 7: LL-2026-05 "for every category with a balance" — ackEscrowSetup marks the ack that completes the loan's category set (1.1's `every_category=true` pattern).
  // Trigger stays `loan.purchased` (one code, one trigger); the registry clock is the purchase-day target (next Fannie Mae BD 03:00 ET); the visibility-based recorded deadline and its basis are on the Setup event and the decision record (open question 5).
  o("LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1", { satisfied: "`investor_events.acked{type=EscrowSetup, every_category=true}`", anchorField: "purchase_date",
    why: "§30.1 timer table: '`investor_events.acked{type=EscrowSetup}` for every category with a balance'; anchor 'the later of purchase_date and fnma_established_at' — the purchase day is the target (open question 5), the visibility-based deadline is recorded by escrowSetupPlan; non-escrowed / flag-off loans cancel the row (onLoanPurchased)." });
  // Rule 8: F-1-03 — the transfer counts when the T&I / P&I bank feed shows the credit (matchBankFeed emits the event with bank_matched=true).
  o("FNMA_F1_03_TI_DEPOSIT_PROCEEDS_1BD", { satisfied: "`custodial.prepurchase_funds.transferred{kind∈{ti_escrow_balance, ti_buydown_funds}, bank_matched=true}`",
    why: "§30.1 timer table: '`custodial.prepurchase_funds.transferred{kind∈ti_*}` matched on the T&I bank feed' — the two T&I kinds spelled out for the pattern grammar." });
  o("FNMA_F1_03_PI_DEPOSIT_PROCEEDS_1BD", { satisfied: "`custodial.prepurchase_funds.transferred{kind=pi_prepurchase_collections, bank_matched=true}`",
    why: "§30.1 timer table: '`custodial.prepurchase_funds.transferred{kind=pi_prepurchase_collections}`' on `proceeds.received` with pi_prepurchase_collections > 0 — a loan without pre-purchase P&I cancels the row (onProceedsReceived)." });
}
