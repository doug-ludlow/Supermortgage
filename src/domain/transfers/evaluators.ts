/**
 * §17 transfers out gate evaluators. Every key here must be named by an `evaluator:` override
 * in this section's timers.ts (src/app/app.test.ts proves both directions); the
 * aggregate map in src/app/evaluators.ts spreads this object.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

import { EVALUATORS_17_1 } from "./evaluators-17-1.ts";
import { EVALUATORS_17_2 } from "./evaluators-17-2.ts";
import { EVALUATORS_17_3 } from "./evaluators-17-3.ts";
import { EVALUATORS_17_4 } from "./evaluators-17-4.ts";

export const SECTION_17_EVALUATORS: Record<string, Evaluator> = {
  ...EVALUATORS_17_1, ...EVALUATORS_17_2, ...EVALUATORS_17_3, ...EVALUATORS_17_4,
};
export const kit = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
