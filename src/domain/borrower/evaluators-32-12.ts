/**
 * §32.12 gate evaluators, keyed "32.12.<name>". Every key must be named by an `evaluator:` override in
 * timers-32-12.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_32_12: Record<string, Evaluator> = {};
export const kit_32_12 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
