/**
 * §2.4 gate evaluators, keyed "2.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-2-4.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { REAPPLY_CONDITIONS } from "./ops-2-4.ts";

export const EVALUATORS_2_4: Record<string, Evaluator> = {
  // FNMA_C1201_REAPPLY_ELIGIBILITY_GATE — the four C-1.2-01 conditions as the spec's data model spells them
  // (`curtailment_reapplications.eligibility{portfolio_or_nonmbs_participation, balance_not_higher_than_schedule, no_maf_funds,
  // borrower_supplement_agreed}`); ops-2-4.ts derives them from the loan and the request and emits them on
  // `curtailment.reapplication.requested`, so the gate reads the platform's facts, not the caller's claim.
  "2.4.reapplyEligible": (f) => every(f, REAPPLY_CONDITIONS, "C-1.2-01 reapplication conditions"),
  // FNMA_C1201_DELINQUENT_CURE_FIRST_GATE — "any additional principal payments identified as such must first be applied toward
  // curing the delinquency": no principal reduction while any installment is still unpaid (facts from the allocation plan).
  "2.4.dueInstallmentsFirst": (f) => (c(f, "curtailment_cents") > 0n && c(f, "unpaid_installments_cents") > 0n ? no(`curtailment ${c(f, "curtailment_cents")}¢ with ${c(f, "unpaid_installments_cents")}¢ of installments still unpaid — funds must satisfy due installments first (C-1.2-01)`) : ok),
};
export const kit_2_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
