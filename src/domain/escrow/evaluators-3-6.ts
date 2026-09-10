/**
 * §3.6 gate evaluators, keyed "3.6.<name>". Every key must be named by an `evaluator:` override in
 * timers-3-6.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there. The facts are built by
 * src/domain/escrow/ops-3-6.ts (planGateFacts / advanceAwaitingAnalysis) from the loan's events and asserted by
 * src/app/tools/section3-6.ts (createRepaymentPlan) and approveAnalysis (assertAnalysisApprovalGates36).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_3_6: Record<string, Evaluator> = {
  // REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE — §1024.17(f)(1)(ii): analysis required before seeking repayment of a servicer advance not caused by borrower default.
  "3.6.interimAnalysisBeforeDemand": (f) => (b(f, "analysis_done") ? ok : no("a deficiency from a servicer advance may not be demanded before the interim analysis (§1024.17(f)(1)(ii))")),
  // FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE — B-1-01: 60 months "unless the borrower decides to pay" a lump sum or a shorter period "of not less than 12 months" (evidenced election).
  "3.6.workoutSpread60": (f) => (n(f, "plan_months") === 60 || (n(f, "plan_months") >= 12 && b(f, "borrower_election_evidenced")) ? ok : no("workout shortage spread is 60 months unless a ≥12-month borrower election is evidenced")),
  // REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE — (f)(3)(i)/(ii): a spread is "over at least a 12-month period"; under one month's payment the servicer may instead require repayment "within 30 days" (one installment) or allow the shortage (no plan).
  "3.6.shortageMinSpread": (f) => (n(f, "plan_months") >= 12 || (c(f, "shortage_cents") < c(f, "one_month_escrow_cents") && n(f, "plan_months") <= 1) ? ok : no("a shortage spread is at least 12 months (§1024.17(f)(3)); under one month only allow (0) or the 30-day option (1) may be shorter")),
  // REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE — (f)(4): "2 or more equal monthly payments".
  "3.6.deficiencyMinInstallments": (f) => atLeast(n(f, "plan_months"), 2, "deficiency repayment installments (§1024.17(f)(4))"),
};
export const kit_3_6 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
