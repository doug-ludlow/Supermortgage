/**
 * §18.6 gate evaluators, keyed "18.6.<name>". Every key must be named by an
 * `evaluator:` override in timers-18-6.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_18_6: Record<string, Evaluator> = {
};
export const kit_18_6 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
