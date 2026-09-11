/**
 * §28.4 gate evaluators, keyed "28.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-28-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *   28.4.ofacClearBeforeFundingGate  SM_OFAC_CLEAR_BEFORE_FUNDING_GATE — every party/payee screened within 1 calendar day, none potential/confirmed
 * (BSA_1029_320C_SAR_RETENTION_5Y / OFAC_501_601_RETENTION_10Y are 31.3's evaluator-backed disposal gates — evaluators-31-3.ts;
 * 28.4 only emits their anchor events and keeps the same arithmetic in ops-28-4.ts sarRetentionGate / ofacRetentionGate.)
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { ofacClearBeforeFundingGate } from "./ops-28-4.ts";

export const EVALUATORS_28_4: Record<string, Evaluator> = {
  "28.4.ofacClearBeforeFundingGate": (f) => ofacClearBeforeFundingGate(f),
};
export const kit_28_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
