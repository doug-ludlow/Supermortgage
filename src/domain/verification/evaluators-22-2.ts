/**
 * §22.2 gate evaluators, keyed "22.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-22-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * The predicates live in ops-22-2.ts (creditReportExpiryGate, refreshPrecloseGate); the facts are the report's
 * `expires_at` (or `report_date`) with the `scheduled_note_date`, and the refresh's date/type with the alert statuses
 * against the `scheduled_consummation_date`.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { creditReportExpiryGate, refreshPrecloseGate } from "./ops-22-2.ts";

export const EVALUATORS_22_2: Record<string, Evaluator> = {
  /** FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M (B1-1-03): `expires_at = add_months(report_date, 4)`; open iff `expires_at ≥ scheduled_note_date`. */
  "22.2.creditReportExpiry4m": (f) => creditReportExpiryGate(f),
  /** SM_CREDIT_REFRESH_PRECLOSE_GATE (policy; B3-6-01): a soft_refresh / UDM snapshot dated ≤ 3 business_days_creditor before consummation with every alert resolved. */
  "22.2.refreshPrecloseGate": (f) => refreshPrecloseGate(f),
};
export const kit_22_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
