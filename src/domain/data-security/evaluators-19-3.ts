/**
 * §19.3 gate evaluators, keyed "19.3.<name>". Every key must be named by an
 * `evaluator:` override in timers-19-3.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_19_3: Record<string, Evaluator> = {
};
export const kit_19_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
