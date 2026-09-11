/**
 * §30.3 gate evaluators, keyed "30.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-30-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * The facts are the ones ops-30-3.ts derives from the engine's own records (initialAnalysisGateFacts,
 * cdConsistencyMismatches, the origination waiver request, creditAgreementGateFacts) — never a caller's attestation.
 */
import { ok, no, b, s, arr, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_30_3: Record<string, Evaluator> = {
  /** REGX_1024_17C2_INITIAL_ANALYSIS_GATE: an approved initial/origination analysis with every line's basis, cushion within the 1/6 cap and no pre-accrual. */
  "30.3.initialAnalysisApproved": (f) => {
    if (!b(f, "approved")) return no("no approved escrow_analyses{initial, origination} for the application (§1024.17(c)(2))");
    if (!b(f, "all_lines_have_basis")) return no("a line has no estimate_basis (§1024.17(c)(7))");
    if (!b(f, "cap_check_passed")) return no("cushion exceeds one-sixth of annual disbursements (§1024.17(c)(5); 3.4 REGX_1024_17C5_CUSHION_CAP_GATE)");
    if (!b(f, "preaccrual_check_passed")) return no("pre-accrual in the projection (§1024.17(c)(6); 3.4)");
    return ok;
  },
  /** REGZ_1026_38L7_CD_ESCROW_CONSISTENCY_GATE: the CD draft's (g)(3)/(l)(7) figures equal the analysis to the cent. */
  "30.3.cdEscrowConsistency": (f) => {
    const mismatches = arr<string>(f, "mismatches");
    if (mismatches.length) return no(`CD escrow figures differ from the analysis: ${mismatches.join("; ")} (§1026.38(g)(3), (l)(7))`);
    return b(f, "consistent") ? ok : no("CD escrow consistency not established for this CD version");
  },
  /** FNMA_B2_1_5_04_REFI_TAX_FINANCING_GATE: a refinance financing real-estate taxes in the loan amount cannot waive escrow. */
  "30.3.refiTaxFinancing": (f) => (s(f, "transaction_type") === "refinance" && b(f, "taxes_financed_in_loan") ? no("REFI_FINANCING_TAXES: an escrow account is required on a refinance financing real-estate taxes (Selling Guide B2-1.5-04)") : ok),
  /** REGX_1024_34B_SAME_SERVICER_CREDIT_AGREEMENT_GATE: `consents{kind=escrow_credit_to_new_loan}` captured on/before the new loan's settlement date. */
  "30.3.creditAgreementPresent": (f) => {
    if (!b(f, "consent_present")) return no("no escrow_credit_to_new_loan agreement: refund under §1024.34(b)(1) (3.5)");
    if (!b(f, "captured_by_settlement")) return no(`agreement captured ${s(f, "captured_at")} after the new loan's settlement ${s(f, "settlement_date")} (§1024.34(b)(2))`);
    return ok;
  },
};
