/**
 * §35.12 gate evaluators, keyed "35.12.<name>". Every key must be named by an `evaluator:` override in
 * timers-35-12.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { goLiveNotBefore } from "./posture-35-12/go-live-gate.ts";

export const EVALUATORS_35_12: Record<string, Evaluator> = {
  /** SM_PROD_GO_LIVE_ATTEST_GATE (not_before_gate): the attestation is possible only on or after `opened_on` + 28 calendar days (rule 9: 28 consecutive days; rule 10: GL-00 only after the gate's day). Facts: `opened_on`, `planned_end_on` (an extension's later day), `as_of_date` (the ET date of the attempt). */
  "35.12.goLiveGate": (f) => {
    const opened = s(f, "opened_on"); const asOf = s(f, "as_of_date"); const planned = f["planned_end_on"] ? s(f, "planned_end_on") : "";
    if (!opened || !asOf) return no("SM_PROD_GO_LIVE_ATTEST_GATE: opened_on and as_of_date are required");
    const notBefore = planned || goLiveNotBefore(opened);   // an `extended` row moves the day (rule 9)
    return asOf >= notBefore ? ok : no(`GO_LIVE_GATE{not_before: ${notBefore}}`);
  },
};
export const kit_35_12 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
