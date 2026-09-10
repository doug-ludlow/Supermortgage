/**
 * §15 REO, claims and advances gate evaluators. Every key here must be named by an `evaluator:` override
 * in this section's timers.ts (src/app/app.test.ts proves both directions); the
 * aggregate map in src/app/evaluators.ts spreads this object.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

import { EVALUATORS_15_1 } from "./evaluators-15-1.ts";
import { EVALUATORS_15_2 } from "./evaluators-15-2.ts";
import { EVALUATORS_15_3 } from "./evaluators-15-3.ts";
import { EVALUATORS_15_4 } from "./evaluators-15-4.ts";

export const SECTION_15_EVALUATORS: Record<string, Evaluator> = {
  ...EVALUATORS_15_1, ...EVALUATORS_15_2, ...EVALUATORS_15_3, ...EVALUATORS_15_4,
};
export const kit = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
