/**
 * §28.3 gate evaluators, keyed "28.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-28-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts: noticeAvailabilityWindow over `{ made_available_on, available_until, last_attested_on, as_of }` (ops-28-3.ts).
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { noticeAvailabilityWindow } from "./ops-28-3.ts";

export const EVALUATORS_28_3: Record<string, Evaluator> = {
  /** HMDA_1003_5D_NOTICE_AVAILABILITY (12 CFR 1003.5(d)): the (b)(2) notice for five years / the (c) notice for three years, attested annually by the office manager. */
  "28.3.noticeAvailabilityWindow": (f) => { const r = noticeAvailabilityWindow(f); return r.reason !== undefined ? { open: r.open, reason: r.reason } : { open: r.open }; },
};
