/**
 * §1.7 gate evaluators, keyed "1.7.<name>". Every key must be named by an `evaluator:` override in
 * timers-1-7.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_1_7: Record<string, Evaluator> = {
  // FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M — `assertGateOpen` on a forbearance extension of an inherited plan. Servicing Guide
  // D2-3.2-01 (04/08/2026), which carries the LL-2026-01 rule: the plan "must not be extended beyond a date that would exceed a
  // cumulative term of 12 months as measured from the start date of the initial forbearance plan, or result in the mortgage loan
  // becoming greater than 12 months delinquent" — two independent limbs (12.4's FNMA_LL202601_FORB_CUMULATIVE_12M and
  // FNMA_LL202601_FORB_DELQ_12M). Facts: cumulative_months + requested_months (limb 1); projected_months_delinquent_at_term_end,
  // or months_delinquent_at_start + requested_months (limb 2) — a missing limb-2 fact closes the gate (the projection is measured,
  // never assumed). fnma_exception_approved=true (Fannie Mae's written approval of the Forbearance Exception Request Template) opens it.
  "1.7.forbearanceCumulativeWithin12Months": (f) => {
    if (b(f, "fnma_exception_approved")) return ok;
    const cumulative = n(f, "cumulative_months"), requested = n(f, "requested_months");
    if (!Number.isFinite(cumulative + requested)) return no("cumulative_months and requested_months are required (D2-3.2-01 cumulative limb)");
    if (cumulative + requested > 12) return no(`cumulative forbearance ${cumulative} + ${requested} > 12 months from the initial plan start without Fannie Mae exception approval (Servicing Guide D2-3.2-01; LL-2026-01)`);
    const projected = f["projected_months_delinquent_at_term_end"] !== undefined && f["projected_months_delinquent_at_term_end"] !== null ? n(f, "projected_months_delinquent_at_term_end")
      : f["months_delinquent_at_start"] !== undefined && f["months_delinquent_at_start"] !== null ? n(f, "months_delinquent_at_start") + requested : NaN;
    if (!Number.isFinite(projected)) return no("projected delinquency at term end unknown: months_delinquent_at_start (or projected_months_delinquent_at_term_end) is required for the D2-3.2-01 'greater than 12 months delinquent' limb");
    return projected <= 12 ? ok : no(`extension would leave the loan ${projected} months delinquent at term end — greater than 12 months delinquent without Fannie Mae exception approval (Servicing Guide D2-3.2-01; LL-2026-01)`);
  },
};
export const kit_1_7 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
