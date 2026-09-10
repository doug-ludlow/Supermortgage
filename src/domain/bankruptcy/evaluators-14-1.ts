/**
 * §14.1 gate evaluators, keyed "14.1.<name>". Every key must be named by an
 * `evaluator:` override in timers-14-1.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { reliefOrderGate } from "./ops-14-1.ts";

export const EVALUATORS_14_1: Record<string, Evaluator> = {
  /** FRBP_4001A3_ORDER_STAY_14 (not_before_gate): a foreclosure act is allowed only once the relief order's 14-day stay (9006 forward) has run, unless the order waives it — asserted by `assertGateOpen` (Fed. R. Bankr. P. 4001(a)(3)). */
  "14.1.reliefOrderStayLapsed": (f) => {
    const entered = s(f, "relief_order_entered_on"); const today = s(f, "today");
    if (!entered) return no("no relief order entered — the automatic stay is in effect and foreclosure_blocked=true (11 U.S.C. §362(a))");
    if (!today) return no("today is required to evaluate the Rule 4001(a)(3) stay of the relief order");
    const g = reliefOrderGate({ entered_on: entered as PlainDate, waived_stay: b(f, "order_waives_14_day_stay"), today: today as PlainDate });
    return g.foreclosure_blocked ? no(`relief order entered ${entered} is stayed through ${g.stayed_through}; foreclosure_blocked=true until ${g.opens_on} (Fed. R. Bankr. P. 4001(a)(3))`) : ok;
  },
};
export const kit_14_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
