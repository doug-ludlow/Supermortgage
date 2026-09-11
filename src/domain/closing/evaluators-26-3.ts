/**
 * §26.3 gate evaluators, keyed "26.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-26-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   26.3.firstPaymentTwoMonthsGate — FNMA_B2_1_5_FIRST_PAYMENT_2M (source C2-2-01): `first_payment_date ≤ add_months(disbursement_date, 2)`
 *                                    (calendar months, day-of-month clamped). Facts: disbursement_date, first_payment_date (the fundings row).
 *   26.3.wetFundsAtTableGate       — SM_O73_WET_FUNDS_AT_TABLE_GATE: wet state — the pre-signing subset passed, the wire (value date =
 *                                    closing date) accepted (IMAD) before signing start. Facts: funding_type, pre_signing_subset_passed,
 *                                    wire_accepted_at, wire_value_date, closing_date, signing_start_at.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { firstPaymentTwoMonthsGate, wetFundsAtTableGate, type FundingType } from "./ops-26-3.ts";

const date = (f: Record<string, unknown>, k: string): PlainDate | null => (typeof f[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f[k] as string) ? (f[k] as PlainDate) : null);
const iso = (f: Record<string, unknown>, k: string): string | null => (typeof f[k] === "string" && (f[k] as string) ? (f[k] as string) : null);

export const EVALUATORS_26_3: Record<string, Evaluator> = {
  "26.3.firstPaymentTwoMonthsGate": (f) => {
    const g = firstPaymentTwoMonthsGate({ first_payment_date: date(f, "first_payment_date"), disbursement_date: date(f, "disbursement_date") ?? date(f, "scheduled_funding_date") });
    return g.open ? ok : no(g.reason ?? "FNMA_B2_1_5_FIRST_PAYMENT_2M closed");
  },
  "26.3.wetFundsAtTableGate": (f) => {
    const ft = s(f, "funding_type");
    const g = wetFundsAtTableGate({ funding_type: ft === "wet" || ft === "dry" ? (ft as FundingType) : null, pre_signing_subset_passed: b(f, "pre_signing_subset_passed"), wire_accepted_at: iso(f, "wire_accepted_at"), wire_value_date: date(f, "wire_value_date"), closing_date: date(f, "closing_date"), signing_start_at: iso(f, "signing_start_at") });
    return g.open ? ok : no(g.reason ?? "SM_O73_WET_FUNDS_AT_TABLE_GATE closed");
  },
};
export const kit_26_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
