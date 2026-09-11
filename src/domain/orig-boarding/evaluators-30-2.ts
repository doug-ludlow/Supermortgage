/**
 * §30.2 gate evaluators, keyed "30.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-30-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, s, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { firstPaymentWindow } from "./ops-30-2.ts";

const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

export const EVALUATORS_30_2: Record<string, Evaluator> = {
  /** FNMA_B2_1_5_FIRST_PAYMENT_2M as OB-006 (C2-2-01): disbursement + 1 day ≤ first_payment_date ≤ disbursement + 2 months (calendar months, day clamped). Facts: `disbursement_date`, `first_payment_date`. */
};
