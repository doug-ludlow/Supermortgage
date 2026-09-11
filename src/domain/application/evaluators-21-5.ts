/**
 * §21.5 gate evaluators, keyed "21.5.<name>". Every key must be named by an `evaluator:` override in
 * timers-21-5.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { revisedLeFourDayGate } from "./ops-21-5.ts";

export const EVALUATORS_21_5: Record<string, Evaluator> = {
  /** REGZ_1026_19E4_REVISED_LE_4SBD_GATE (not_before_gate on `consummate`): the consumer must receive any revised LE not later than four specific business days before consummation (§1026.19(e)(4)(ii)); receipt = actual evidence or the three-specific-business-day presumption. Facts: `requested_on`, `effective_receipt_date` (of the latest revised LE; absent = no revised LE outstanding), `revised_le_version`. */
  "21.5.revisedLeFourDayGate": (f) => {
    const g = revisedLeFourDayGate({ requested_on: s(f, "requested_on"), effective_receipt_date: f.effective_receipt_date ? s(f, "effective_receipt_date") : null, revised_le_version: f.revised_le_version ?? null });
    return g.open ? ok : no(g.reason ?? "REGZ_1026_19E4_REVISED_LE_4SBD_GATE closed");
  },
};
export const kit_21_5 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
