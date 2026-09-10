/**
 * §18.7 gate evaluators, keyed "18.7.<name>". Every key must be named by an
 * `evaluator:` override in timers-18-7.ts and vice versa (src/app/app.test.ts checks both).
 *
 * No 18.7 timer row is condition-shaped: every row keeps a clock (30/60/90 calendar days,
 * BD5, 1 BD, 5 BD, quarterly) and is satisfied by an event the process emits (see
 * timers-18-7.ts / ops-18-7.ts ELIG_EVENTS). The one evaluator-backed row,
 * FNMA_A4101_SERVICE_ONE_LOAN_DEC31 → `18.7.servicesAtLeastOneFannieMaeLoan`, is registered
 * in src/app/evaluators.ts, so this map is intentionally empty (a second definition would
 * only shadow it in the spread).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_18_7: Record<string, Evaluator> = {
};
export const kit_18_7 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
