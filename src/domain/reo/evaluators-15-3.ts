/**
 * §15.3 gate evaluators, keyed "15.3.<name>". Every key must be named by an
 * `evaluator:` override in timers-15-3.ts or the section's timers.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { addMonths, plainDate } from "../../kernel/calendar/date.ts";

/** "YYYY-MM" of a PlainDate/ISO string, or "" when absent. */
const month = (v: string): string => v.slice(0, 7);

export const EVALUATORS_15_3: Record<string, Evaluator> = {
  /**
   * SM_MI_PREMIUM_PAID_THROUGH_GATE (not_before_gate, scheduled sale): `mi_policies.premium_paid_through ≥ liquidation month`.
   * F-1-05 / Section 10: MI renewal premiums are kept paid through the month of the liquidation event; a lapse before
   * the sale is a coverage risk — the sale package is flagged and the premium advanced (Section 10).
   */
  "15.3.premiumPaidThroughLiquidationMonth": (f) => {
    const paidThrough = s(f, "premium_paid_through");
    const liquidation = s(f, "liquidation_date") || s(f, "scheduled_sale_date") || s(f, "sale_at");
    if (!paidThrough) return no("mi_policies.premium_paid_through is unknown — confirm the policy is in force before the sale package (F-1-05)");
    if (!liquidation) return no("no scheduled sale / liquidation date to compare premium_paid_through against");
    return month(paidThrough) >= month(liquidation) ? ok : no(`MI premium paid through ${month(paidThrough)} is before the liquidation month ${month(liquidation)} — flag the sale package and advance the premium (Section 10; F-1-05)`);
  },
  /**
   * MI_MP_INTEREST_CAP_36M (not_after, "Satisfied by —"): interest and advances are covered for no more than 36 months from the default
   * date (master policy; rule 4 "capped at 36 months from the default date"). The registry anchors the watch on the first unpaid due date
   * + 36 months — the first uninsured installment; interest claimed through a date before it is inside the cap. Asserted by domain code
   * (computeShadowClaim on the claim's interest-to date, scoreCurtailmentRisk on the accrual as of the run), never event-satisfied:
   * past the cap every further month is an uninsured loss (T12: paid-to Nov 1, 2026, default Dec 1, 2026 → cap Nov 1, 2029; not-after Dec 1, 2029).
   */
  "15.3.interestWithinCap": (f) => {
    const first = s(f, "first_unpaid_due_date") || s(f, "default_date");
    const to = s(f, "interest_to") || s(f, "as_of");
    const cap = n(f, "cap_months") || 36;
    if (!first) return no("first_unpaid_due_date (the default date) is unknown — the 36-month cap cannot be placed (MI_MP_INTEREST_CAP_36M)");
    if (!to) return no("no interest_to / as_of date to test against the 36-month cap");
    const notAfter = addMonths(plainDate(first), cap);
    return plainDate(to) < notAfter ? ok : no(`interest to ${to} reaches the ${cap}-month cap from the default date ${first} (first uninsured installment ${notAfter}) — interest and advances beyond it are an uninsured loss (master policy; MI_MP_INTEREST_CAP_36M)`);
  },
};
export const kit_15_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
