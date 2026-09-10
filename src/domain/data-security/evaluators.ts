/**
 * §19 records, security, vendors and fair lending gate evaluators. Every key here must be named by an `evaluator:` override
 * in this section's timers.ts (src/app/app.test.ts proves both directions); the
 * aggregate map in src/app/evaluators.ts spreads this object.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

import { EVALUATORS_19_1 } from "./evaluators-19-1.ts";
import { EVALUATORS_19_2 } from "./evaluators-19-2.ts";
import { EVALUATORS_19_3 } from "./evaluators-19-3.ts";
import { EVALUATORS_19_4 } from "./evaluators-19-4.ts";

export const SECTION_19_EVALUATORS: Record<string, Evaluator> = {
  ...EVALUATORS_19_1, ...EVALUATORS_19_2, ...EVALUATORS_19_3, ...EVALUATORS_19_4,
};
export const kit = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
