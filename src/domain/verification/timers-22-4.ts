/**
 * §22.4 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 22.4 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 * Every 22.4 gate is condition-shaped (a not-before gate over the asset facts), so each is evaluator-backed
 * (evaluators-22-4.ts → ops-22-4.ts assetGateResult); the events named here are appended by ops-22-4.ts through
 * src/app/tools/section22-4.ts, by 22.1 (`document.classified`), 25.2 (`disclosure.cd.prepared`) and 23.1 (`du.findings.received`).
 * Referenced rows — `FNMA_B1_1_03_CREDIT_DOCS_4M` (22.1), `FNMA_B3_2_10_DU_FINAL_MATCH_GATE` (23.1), `FNMA_B3_2_02_DU_CLOSE_BY_GATE`
 * (22.3) — are their owners'; 22.4 reuses 22.1's assertGateOpen and never recomputes document freshness.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_22_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // R1: per depository asset used — the most recent monthly statement's period_end ≥ initial application date − 45 calendar days (quarterly − 90), with the
  // required count (purchase 2 consecutive / refinance 1) or a DU asset validation message. Anchored to the INITIAL application date; never re-based.
  o("FNMA_B3_4_4_02_ASSET_STMT_45D_GATE", { trigger: "`document.classified{doc_class=bank_statement}` / `verification.received{kind=assets}`", evaluator: "22.4.assetStatement45d", anchorField: "application_date",
    why: "§22.4 timer table: 'not_before_gate per depository asset used', trigger '`document.classified{bank_statement}` / `verification.received{assets}`', anchor '`applications.application_date` (initial loan application date; refinance fixture Mon Oct 5, 2026; purchase Mon Oct 19, 2026)', offset 'most recent monthly statement `period_end ≥ application_date − 45 calendar_days` (quarterly: − 90 `calendar_days`); refinance floor Fri Aug 21, 2026 (quarterly Tue Jul 7); purchase floor Fri Sept 4, 2026 (quarterly Tue Jul 21)', satisfied by 'statement(s) meeting the floor with the required count (purchase 2 consecutive monthly / refinance 1), or a DU asset validation message' (B3-4.4-02)." });
  // R3 (purchase only): every large deposit whose funds are needed is sourced (or DU-waived), or the account's usable_cents is reduced by the unsourced portion with sufficient = true.
  o("FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE", { trigger: "`asset.deposit.flagged_large`", evaluator: "22.4.largeDeposit", satisfied: "`asset.deposit.sourced`",
    why: "§22.4 timer table: 'not_before_gate (purchase only)', trigger '`asset.deposit.flagged_large`', offset 'every large deposit whose funds are needed is `sourced`/`partially_sourced` with the unsourced remainder ≤ threshold, or `waived_du_validated`; otherwise `usable_cents` reduced', satisfied by '`asset.deposit.sourced` or reduction applied with `sufficient = true`' (B3-4.2-02: 'Verified funds must be reduced by the amount (or portion) of the undocumented large deposit')." });
  // R5: transfer evidence per B3-4.3-04 before or at settlement; ops-22-4 verifyGiftTransfer emits `gift.transfer.verified` only over a complete letter.
  o("FNMA_B3_4_3_04_GIFT_TRANSFER_GATE", { trigger: "`gift.letter.received`", evaluator: "22.4.giftTransfer", satisfied: "`gift.transfer.verified`",
    why: "§22.4 timer table: trigger '`gift.letter.received`', anchor '`closing.scheduled`', offset 'transfer evidence per B3-4.3-04 before or at settlement (official check/wire to the closing agent recorded on the settlement statement)', satisfied by '`gift.transfer.verified`'; breach 'blocks `funding.authorized` (26.3) — sev 2'." });
  // Departing residence: the settlement statement must be received "before, or simultaneously with" the subject settlement (`asset.verified{verification_method=settlement_statement}`).
  o("FNMA_B3_4_3_10_SALE_PROCEEDS_GATE", { trigger: "`asset.declared{asset_type=proceeds_real_estate_sale}`", evaluator: "22.4.saleProceeds", satisfied: "`asset.verified{verification_method=settlement_statement}`",
    why: "§22.4 timer table: trigger '`asset.declared{proceeds_real_estate_sale}`', anchor '`closings.scheduled_at`', offset 'settlement statement of the departing residence received \"before, or simultaneously with\" the subject settlement', satisfied by '`asset.verified{settlement_statement}`'; breach 'blocks `funding.authorized`; fallback: bridge loan/other verified funds or reschedule' (B3-4.3-10)." });
  // R7: Σ financing concessions ≤ band % × min(price, appraised value); excess → sales concession with price/LTV/MI recomputed; `ipc.limit.ok` on the current contract/valuation.
  o("FNMA_B3_4_1_02_IPC_LIMIT_GATE", { trigger: "`ipc.recorded`", evaluator: "22.4.ipcLimit", satisfied: "`ipc.limit.ok`",
    why: "§22.4 timer table: trigger '`ipc.recorded`, `purchase_contracts` change, `valuation.received`', offset 'Σ financing concessions ≤ band% × min(price, appraised value); excess reclassified to sales concession with price/LTV/MI recomputed (rule R7)', satisfied by '`ipc.limit.ok` on the current contract/valuation'; breach 'sev 2 → 21.5 changed circumstance (revised LE), 24.6 MI re-quote, 23.1 resubmission; undisclosed IPC → 22.6' (B3-4.1-02)." });
  // R9 (LCOR only): cash_to_borrower ≤ max(1 % × loan_amount, $2,000); cured by a principal curtailment or a loan-amount reduction, re-tested on every `funds_to_close.computed`.
  o("FNMA_B2_1_3_02_LCOR_CASHBACK_GATE", { trigger: "`funds_to_close.computed{transaction=lcor}`", evaluator: "22.4.lcorCashBack", satisfied: "`funds_to_close.computed{cash_back_ok=true}`",
    why: "§22.4 timer table: 'not_before_gate (LCOR only)', trigger 'every `funds_to_close.computed`', offset '`cash_to_borrower_cents ≤ max(1% × loan_amount, $2,000)` (rule R9)', satisfied by '`cash_back_ok = true` (via curtailment or loan-amount reduction)'; breach 'blocks `issueCD`/`consummate`; sev 2; 23.1 resubmission when the loan amount changes' (B2-1.3-02, 10/08/2025)." });
  // R8: the latest worksheet reconciled to the CD to the cent, sufficient, all funds verified/usable, reserves ≥ required.
  o("SM_CASH_TO_CLOSE_RECONCILED_GATE", { trigger: "`disclosure.cd.prepared`", evaluator: "22.4.cashToCloseReconciled", satisfied: "`funds_to_close.reconciled`",
    why: "§22.4 timer table: trigger '`disclosure.cd.prepared{version}` and `closing.scheduled`', offset 'latest worksheet `reconciled_to_cd = true`, `sufficient = true`, all funds `verified`/`usable`, reserves ≥ required (23.1's 90% rule only governs resubmission)', satisfied by '`funds_to_close.reconciled`'; breach 'blocks `consummate` and 26.3 `funding.authorized`; feeds 23.3 `CTC_ASSETS_CASH_TO_CLOSE` — sev 2' (Reg Z §1026.38(i))." });
  // R6: verified usable reserves ≥ the final findings' requirement and rule R6; below 90 % → 23.1 B3_2_10_RESERVES_90PCT resubmission, insufficient → 23.2 restructure.
  o("SM_RESERVES_VERIFIED_GATE", { trigger: "`du.findings.received`", evaluator: "22.4.reservesVerified", satisfied: "`reserves.computed{sufficient=true}`",
    why: "§22.4 timer table: trigger '`du.findings.received` (final)', offset '`verified_usable_reserves_cents ≥ reserves_required_cents` of the final findings and of rule R6', satisfied by '`reserves.computed{sufficient}`'; breach '23.1 `B3_2_10_RESERVES_90PCT` resubmission when < 90%; 23.2 restructure when insufficient' (B3-4.1-01; B3-2-10)." });
}
