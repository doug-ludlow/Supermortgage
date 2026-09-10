/**
 * §18 QC, audit and attestations gate evaluators. Every key here must be named by an `evaluator:` override
 * in this section's timers.ts (src/app/app.test.ts proves both directions); the
 * aggregate map in src/app/evaluators.ts spreads this object.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

import { EVALUATORS_18_1 } from "./evaluators-18-1.ts";
import { EVALUATORS_18_2 } from "./evaluators-18-2.ts";
import { EVALUATORS_18_3 } from "./evaluators-18-3.ts";
import { EVALUATORS_18_4 } from "./evaluators-18-4.ts";
import { EVALUATORS_18_5 } from "./evaluators-18-5.ts";
import { EVALUATORS_18_6 } from "./evaluators-18-6.ts";
import { EVALUATORS_18_7 } from "./evaluators-18-7.ts";

export const SECTION_18_EVALUATORS: Record<string, Evaluator> = {
  ...EVALUATORS_18_1, ...EVALUATORS_18_2, ...EVALUATORS_18_3, ...EVALUATORS_18_4, ...EVALUATORS_18_5, ...EVALUATORS_18_6, ...EVALUATORS_18_7,
};
export const kit = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
