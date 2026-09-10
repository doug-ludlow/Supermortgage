/**
 * §17 transfers out gate evaluators. Every key here must be named by an `evaluator:` override
 * in this section's timers.ts (src/app/app.test.ts proves both directions); the
 * aggregate map in src/app/evaluators.ts spreads this object.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const SECTION_17_EVALUATORS: Record<string, Evaluator> = {
};
export const kit = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
