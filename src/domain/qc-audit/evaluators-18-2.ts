/**
 * §18.2 gate evaluators, keyed "18.2.<name>". Every key must be named by an
 * `evaluator:` override in timers-18-2.ts and vice versa (src/app/app.test.ts checks both).
 * The officer-review window is not an evaluator: its deadline half is a real due date (computed anchor `approve_by`,
 * see timers-18-2.ts) and its not-before half is asserted at the approval (ops-18-2 officerApproval / packageReviewWindow).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { litigationHoldReleased } from "./ops-18-2.ts";

const date = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? (v as PlainDate) : null);

export const EVALUATORS_18_2: Record<string, Evaluator> = {
  /** `SM_EXAM_LITIGATION_HOLD`: purge of a scoped record may proceed only once counsel has recorded the release. */
  "18.2.litigationHoldReleased": (f) => {
    const r = litigationHoldReleased({ released_by_counsel_on: date(f.released_by_counsel_on), released_by_role: typeof f.released_by_role === "string" ? f.released_by_role : null });
    return r.open ? ok : no(r.reason ?? "SM_EXAM_LITIGATION_HOLD closed");
  },
};
export const kit_18_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
