/**
 * §14.2 gate evaluators, keyed "14.2.<name>". Every key must be named by an
 * `evaluator:` override in timers-14-2.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_14_2: Record<string, Evaluator> = {
};
export const kit_14_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
