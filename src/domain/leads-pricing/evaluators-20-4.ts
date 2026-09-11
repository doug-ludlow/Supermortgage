/**
 * §20.4 gate evaluators, keyed "20.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-20-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts come from the quote / render context (ops-20-4.ts): `{ now, valid_until, status }`, `{ now, pe_wl_quote_expires_at }`,
 * `{ expected_purchase_ready_date, tables }`, `{ blocks, title }`.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { quoteValidityGate, peWlQuoteIdWindow, llpaTableVersionGate, quoteDisclaimerGate } from "./ops-20-4.ts";

export const EVALUATORS_20_4: Record<string, Evaluator> = {
  /** SM_QUOTE_VALIDITY_GATE (rule 6): open while now ≤ valid_until = min(rate_sheets.expires_at, quoted_at + 24 h). */
  "20.4.quoteValidityGate": (f) => quoteValidityGate(f),
  /** FNMA_PEWL_QUOTE_ID_WINDOW: the Loan Pricing API quote id is usable until the expiry the response carries. */
  "20.4.peWlQuoteIdWindow": (f) => peWlQuoteIdWindow(f),
  /** SM_LLPA_TABLE_VERSION_GATE (rule 2; T7): a matrix version covers the expected Purchase Ready date (a future version flags matrix_change_exposure). */
  "20.4.llpaTableVersionGate": (f) => llpaTableVersionGate(f),
  /** REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE (rule 7; T4): the statement on top of page 1 in ≥ 12-pt and no H-24/H-25 resemblance. */
  "20.4.quoteDisclaimerGate": (f) => quoteDisclaimerGate(f),
};
