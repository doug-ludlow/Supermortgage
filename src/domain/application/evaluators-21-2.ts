/**
 * §21.2 gate evaluators, keyed "21.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-21-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { le7sbdGate } from "./ops-21-2.ts";

export const EVALUATORS_21_2: Record<string, Evaluator> = {
  /** REGZ_1026_19E1III_LE_7SBD_GATE (not_before_gate): consummation / CD scheduling only on or after the seventh specific business day following delivery or mailing of the initial LE (§1026.19(e)(1)(iii)(B); comment 19(e)(1)(iii)-2), or from the day a written, dated, signed bona fide personal financial emergency statement is recorded (§1026.19(e)(1)(v)). Facts: `earliest_consummation_date`, `requested_on`, `waiver_recorded_on`. */
  "21.2.le7sbdGateOpen": (f) => {
    const g = le7sbdGate({ earliest_consummation_date: s(f, "earliest_consummation_date") as PlainDate, requested_on: s(f, "requested_on") as PlainDate, waiver_recorded_on: f.waiver_recorded_on ? (s(f, "waiver_recorded_on") as PlainDate) : null });
    return g.open ? ok : no(g.reason ?? "REGZ_1026_19E1III_LE_7SBD_GATE closed");
  },
};
export const kit_21_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
