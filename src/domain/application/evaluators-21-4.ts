/**
 * §21.4 gate evaluators, keyed "21.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-21-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

/**
 * REGZ_1026_19E2_INTENT_FEE_GATE (rule 1): `gate_open = (today_creditor_tz ≥ le_effective_receipt_date) ∧ (∃ intent_records.valid)`;
 * the credit-report exemption (§1026.19(e)(2)(i)(B)) opens for `fee_kind='credit_report'` only up to the vendor's invoice.
 * Facts: le_effective_receipt_date (PlainDate | null), checked_on (PlainDate, creditor tz), intent_valid (boolean),
 * intent_withdrawn (boolean), fee_kind, amount_cents, vendor_invoice_cents. The reason strings are the `fee_gate_checks.result` codes.
 */
export const EVALUATORS_21_4: Record<string, Evaluator> = {
  "21.4.intentFeeGate": (f) => {
    if (s(f, "fee_kind") === "credit_report") {
      const invoice = c(f, "vendor_invoice_cents"), amount = c(f, "amount_cents");
      if (invoice <= 0n) return no("closed_no_receipt: credit-report exemption needs the vendor's invoiced cost");
      return amount <= invoice ? ok : no(`exempt_credit_report: capped at the vendor invoice ${invoice} cents (charge ${amount})`);
    }
    const receipt = f.le_effective_receipt_date, today = s(f, "checked_on");
    if (typeof receipt !== "string" || !receipt || (today && today < receipt)) return no("closed_no_receipt: the Loan Estimate has not been received (§1026.19(e)(2)(i)(A))");
    if (!b(f, "intent_valid") || b(f, "intent_withdrawn")) return no("closed_no_intent: no documented intent to proceed after receipt (§1026.19(e)(2)(i)(A))");
    return ok;
  },
};
export const kit_21_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
