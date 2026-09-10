/**
 * §18.4 gate evaluators, keyed "18.4.<name>". Every key must be named by an
 * `evaluator:` override in timers-18-4.ts and vice versa (src/app/app.test.ts checks both).
 *
 * No 18.4 timer row is condition-shaped: every row keeps a clock (90/75/60/30 calendar days,
 * 5 BD fannie_et, 1 BD, −60/−180 calendar days) or an `until` gate, and each is satisfied by an
 * evidenced event that src/domain/qc-audit/ops-18-4.ts emits (see timers-18-4.ts). The gates the
 * spec's guardrails describe — an unresolved consistency check or an inadequate/expiring policy
 * blocking `officer_review`, the agent never taking `officer_review → submitted` — are asserted by
 * the commands that would cross them (officerReviewGate, insuranceExpiryCheck, filingSubmit), not
 * by a timer evaluator, so this map is intentionally empty.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_18_4: Record<string, Evaluator> = {
};
export const kit_18_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
