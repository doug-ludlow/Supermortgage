/**
 * §14 bankruptcy gate evaluators. Every key here must be named by an `evaluator:` override
 * in this section's timers.ts (src/app/app.test.ts proves both directions); the
 * aggregate map in src/app/evaluators.ts spreads this object.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

import { EVALUATORS_14_1 } from "./evaluators-14-1.ts";
import { EVALUATORS_14_2 } from "./evaluators-14-2.ts";
import { EVALUATORS_14_3 } from "./evaluators-14-3.ts";
import { EVALUATORS_14_4 } from "./evaluators-14-4.ts";

export const SECTION_14_EVALUATORS: Record<string, Evaluator> = {
  ...EVALUATORS_14_1, ...EVALUATORS_14_2, ...EVALUATORS_14_3, ...EVALUATORS_14_4,
};
export const kit = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
