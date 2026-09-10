/**
 * §9.1 gate evaluators, keyed "9.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-9-1.ts (or this section's timers.ts) and vice versa (src/app/app.test.ts checks both). Spread last by
 * src/app/evaluators.ts, so a key here supersedes an inline definition there.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_9_1: Record<string, Evaluator> = {};
export const kit_9_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
