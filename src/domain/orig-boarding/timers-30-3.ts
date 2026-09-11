/**
 * §30.3 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 30.3 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Only the six codes 30.3 owns are touched. The reference rows in 30.3's timer table stay with their owners and are
 * satisfied by the events ops-30-3.ts emits: REGX_1024_17G_INITIAL_STMT_45 (3.1: `escrow.initial_statement.required
 * {reason=settlement}` → `escrow.statement.sent{statement_type=initial}` on day 0), REGX_1024_17C5_CUSHION_CAP_GATE
 * (3.4: `escrow.cushion.validated{cap_check_passed}`), FNMA_B101_MI_MONTHLY_ESCROW_GATE (3.8: `escrow.waiver.evaluating
 * {borrower_paid_mi_monthly=true}` → `escrow.waiver.decided`), REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD (3.5:
 * `escrow.credit_to_new_loan.posted`), REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45 (3.2: `escrow.account.established`),
 * SM_O64_INITIAL_ESCROW_STMT_AT_SETTLEMENT (25.4: `escrow.statement.rendered` + `escrow.statement.sent{channel=
 * closing_package}`), REGZ_1026_35B1_HPML_ESCROW_GATE / REGZ_1026_35_HPML_ESCROW_5Y (23.4: `escrow.initial_analysis
 * .approved{hpml=true}`; `hpml_escrow_min_cancel_date` on `escrow.account.established`), LL_2026_05_ESCROW_SETUP_
 * ORIG_PURCHASE_BD1 (30.1: `escrow.setup_event.queued{sequence=1}` with the T&I balance).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_30_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table: trigger "`disclosure.cd.prepared{version}` (25.2; escrowed loan)"; offset "an `approved` `escrow_analyses{initial, origination}` with every line's `estimate_basis` set, cushion ≤ cap (3.4), no pre-accrual (3.4)" — a condition, so an evaluator over the engine's record (ops-30-3 initialAnalysisGateFacts); satisfied by `escrow.initial_analysis.approved` (approveInitialAnalysis).
  o("REGX_1024_17C2_INITIAL_ANALYSIS_GATE", { trigger: "`disclosure.cd.prepared`", evaluator: "30.3.initialAnalysisApproved", satisfied: "`escrow.initial_analysis.approved`",
    why: "§30.3 timer table: `disclosure.cd.prepared{version}` (25.2; escrowed loan) → not before an `approved` `escrow_analyses{initial, origination}` with every line's `estimate_basis` set, cushion ≤ cap (3.4), no pre-accrual (3.4); satisfied by `escrow.initial_analysis.approved`; breach: `issueCD` refused (25.2) and `establishEscrowAccount` refused at funding." });
  // Timer table: every initial or corrected CD draft; the offset is the (g)(3)/(l)(7) equality set — ops-30-3 cdConsistencyMismatches; satisfied by `escrow.cd_consistency.passed` (checkCdConsistency).
  o("REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE", { trigger: "`disclosure.cd.prepared`", evaluator: "30.3.cdEscrowConsistency", satisfied: "`escrow.cd_consistency.passed`",
    why: "§30.3 timer table: `disclosure.cd.prepared{version}` (25.2 — every initial or corrected CD draft) → CD (g)(3) total = `target_at_start_cents`; (g)(3) lines = `single_item_lines` and aggregate adjustment; (l)(7) monthly = `base_payment_cents`; escrowed costs year 1 = 12 × monthly; initial escrow payment = (g)(3) total; projected-payments escrow column = monthly; satisfied by `escrow.cd_consistency.passed`; breach: `issueCD` refused; 25.1 compliance test `ESCROW_CD_MATCH` fails." });
  // Timer table: `loan.funded` → funding date + 0 (same day); satisfied by "analysis version at funding = `frozen` version, or a superseding analysis approved with a corrected CD/initial statement plan" — establishEscrowAccount records which as `escrow.initial_analysis.refreshed_at_funding{result}`; the funding date is 26.3's `disbursement_date` on the payload.
  o("SM_ESCROW_REFRESH_AT_FUNDING_T0", { anchorField: "disbursement_date", satisfied: "`escrow.initial_analysis.refreshed_at_funding{result∈{frozen_confirmed, superseded}}`",
    why: "§30.3 timer table: `loan.funded` → funding date (26.3's `loan.funded{disbursement_date}`) + 0 (same day); satisfied by 'analysis version at funding = `frozen` version, or a superseding analysis approved with a corrected CD/initial statement plan' — one resolution fact naming which branch held; breach: sev-3 → `escrow` agent." });
  // Timer table: `escrow.waiver.requested` on a refinance where taxes are paid from loan proceeds; satisfied "—"/breach "waiver refused (`REFI_FINANCING_TAXES`)" — a gate over the request facts (30.3.refiTaxFinancing) that closes on the decision the engine records (recordOriginationWaiver: denied with REFI_FINANCING_TAXES). The origination request carries `origin=origination` (3.8's servicing intake is `origin=borrower_request`).
  o("FNMA_B2_1_5_04_REFI_TAX_FINANCING_GATE", { trigger: "`escrow.waiver.requested{origin=origination}`", evaluator: "30.3.refiTaxFinancing", satisfied: "`escrow.waiver.decided`",
    why: "§30.3 timer table: `escrow.waiver.requested` on a refinance where delinquent/current real-estate taxes are paid from loan proceeds → waiver refused (`REFI_FINANCING_TAXES`; Selling Guide B2-1.5-04 'Lenders cannot waive an escrow account for certain refinance transactions'); the gate closes on `escrow.waiver.decided`." });
  // Timer table: `escrow.waiver.requested` → request date + 3 business_days_creditor; satisfied by `escrow.waiver.decided`. The origination row arms on the origination intake only and anchors on its `requested_on`.
  o("SM_ESCROW_WAIVER_DECISION_ORIG_3BD", { trigger: "`escrow.waiver.requested{origin=origination}`", anchorField: "requested_on",
    why: "§30.3 timer table: `escrow.waiver.requested` → request date (`requested_on`) + 3 `business_days_creditor`; satisfied by `escrow.waiver.decided`; breach: sev-3; must precede the LE revision it drives (21.5)." });
  // Timer table: `payoff.funds.received` (16.2) on the prior loan; offset "`consents{kind=escrow_credit_to_new_loan, captured_at ≤ new settlement date}` present" — an evaluator over the consent (ops-30-3 creditAgreementGateFacts); satisfied by 3.5's `escrow.credit_to_new_loan.posted` (postCreditTransfer).
  o("REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE", { trigger: "`payoff.funds.received`", evaluator: "30.3.creditAgreementPresent", satisfied: "`escrow.credit_to_new_loan.posted`",
    why: "§30.3 timer table: `payoff.funds.received` (16.2) on the prior loan with a same-servicer new loan → not before `consents{kind=escrow_credit_to_new_loan, captured_at ≤ new settlement date}` present (§1024.34(b)(2); comment 34(b)(2)-2); satisfied by `escrow.credit_to_new_loan.posted` (3.5); breach: no credit; 3.5's `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` runs (refund)." });
}
