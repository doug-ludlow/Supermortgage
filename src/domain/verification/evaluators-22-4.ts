/**
 * §22.4 gate evaluators, keyed "22.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-22-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * The predicates are ops-22-4.ts assetGateResult() over the facts the tools assemble from the application's assets:
 *   22.4.assetStatement45d      { transaction, initial_application_date | application_date, statements: StatementEvidence[], du_validated }   B3-4.4-02 45/90-day floor with the required count
 *   22.4.largeDeposit           { transaction, deposits: DepositResult[], sufficient }                                                        B3-4.2-02 large deposits sourced or the reduction applied with sufficient funds
 *   22.4.giftTransfer           { gifts: [{ gift_id, status }] }                                                                               B3-4.3-04 transfer evidence (transfer_verified / complete)
 *   22.4.saleProceeds           { subject_closing_date, sale_settlement_date, settlement_statement_document_id }                              B3-4.3-10 settlement statement before or simultaneously with the subject settlement
 *   22.4.ipcLimit               { ok } | { sales_price_cents, appraised_value_cents, loan_amount_cents, subordinate_cents, occupancy, items }  B3-4.1-02 band test
 *   22.4.lcorCashBack           { transaction, cash_back_ok } | { loan_amount_cents, payoffs_cents, total_closing_costs_cents, credits_cents, principal_curtailment_cents }   B2-1.3-02 cap
 *   22.4.cashToCloseReconciled  { worksheet | reconciled_to_cd, sufficient, cash_back_ok, all_assets_usable, reserves_ok }                    §1026.38(i) worksheet = CD to the cent
 *   22.4.reservesVerified       { verified_cents | verified_usable_reserves_cents, required_cents | reserves_required_cents }                  B3-4.1-01 / DU findings
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { assetGateResult, type AssetGateCode } from "./ops-22-4.ts";

const via = (code: AssetGateCode): Evaluator => (f) => { const r = assetGateResult(code, f); return r.open ? ok : no(r.reason ?? "closed"); };

export const EVALUATORS_22_4: Record<string, Evaluator> = {
  "22.4.assetStatement45d": via("FNMA_B3_4_4_02_ASSET_STMT_45D_GATE"),
  "22.4.largeDeposit": via("FNMA_B3_4_2_02_LARGE_DEPOSIT_GATE"),
  "22.4.giftTransfer": via("FNMA_B3_4_3_04_GIFT_TRANSFER_GATE"),
  "22.4.saleProceeds": via("FNMA_B3_4_3_10_SALE_PROCEEDS_GATE"),
  "22.4.ipcLimit": via("FNMA_B3_4_1_02_IPC_LIMIT_GATE"),
  "22.4.lcorCashBack": via("FNMA_B2_1_3_02_LCOR_CASHBACK_GATE"),
  "22.4.cashToCloseReconciled": via("SM_CASH_TO_CLOSE_RECONCILED_GATE"),
  "22.4.reservesVerified": via("SM_RESERVES_VERIFIED_GATE"),
};
export const kit_22_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
