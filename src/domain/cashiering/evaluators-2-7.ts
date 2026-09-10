/**
 * §2.7 gate evaluators, keyed "2.7.<name>". Every key must be named by an `evaluator:` override in
 * timers-2-7.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_2_7: Record<string, Evaluator> = {
  /**
   * REGZ_1026_36C2_NO_PYRAMID_GATE — "no late charge if the installment's periodic payment was credited by grace end and the only
   * shortfall is prior fees" (§1026.36(c)(2)). The gate is closed (assessment refused) when both facts are true, and it is
   * also closed while the credited-funds fact is unknown: an omitted fact never opens a legal gate (the fee commands derive
   * both from the loan state — section02.ts lcFacts — so a caller with the state never has to assert them by hand).
   */
  "2.7.noPyramiding": (f) => {
    if (typeof f.periodic_payment_credited_by_grace_end !== "boolean") return no("unknown whether the periodic payment was credited by grace end (pass facts.periodic_payment_credited_by_grace_end/only_shortfall_is_prior_fees or the loan state)");
    return b(f, "periodic_payment_credited_by_grace_end") && b(f, "only_shortfall_is_prior_fees") ? no("§1026.36(c)(2): payment credited in full by grace end; shortfall is prior fees only") : ok;
  },
  /** FNMA_D23201_FORBEARANCE_NO_ACCRUAL_GATE — no accrual while the plan is active; after a plan default, installments due on/after the default date accrue (D2-3.2-01). */
  "2.7.forbearanceNoAccrual": (f) => {
    if (!b(f, "forbearance_active")) return ok;
    const defaulted = s(f, "defaulted_on"), due = s(f, "installment_due_date");
    return defaulted !== "" && due !== "" && due >= defaulted ? ok : no(`forbearance plan active: no late-charge accrual (D2-3.2-01)${defaulted ? `; accrual resumes for installments due on/after ${defaulted}` : ""}`);
  },
};
export const kit_2_7 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
