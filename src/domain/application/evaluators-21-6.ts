/**
 * §21.6 gate evaluators, keyed "21.6.<name>". Every key must be named by an `evaluator:` override in
 * timers-21-6.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts: coPreuseNoticeGate over `{ property_state, consumer_state, interaction_on, preuse_notice_delivered, effective_from? }`;
 * coRecordsRetentionElapsed over `{ decided_on, as_of, legal_hold? }` (ops-21-6.ts).
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { coPreuseNoticeGate, coRecordsRetentionElapsed } from "./ops-21-6.ts";

export const EVALUATORS_21_6: Record<string, Evaluator> = {
  /** CO_SB26_189_1704_PREUSE_NOTICE_GATE (C.R.S. 6-1-1704): the pre-use notice precedes any ADMT-influenced output for a Colorado consumer on/after 2027-01-01. */
  "21.6.coPreuseNoticeGate": (f) => coPreuseNoticeGate(f),
  /** CO_SB26_189_1703_RECORDS_3Y (C.R.S. 6-1-1703): disposal opens three years after the consequential decision, never under a legal hold. */
  "21.6.coRecordsRetentionElapsed": (f) => coRecordsRetentionElapsed(f),
};
