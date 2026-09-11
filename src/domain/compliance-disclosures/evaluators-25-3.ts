/**
 * §25.3 gate evaluators, keyed "25.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-25-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   25.3.rescissionGateOpen — REGZ_1026_23_RESCISSION_3SBD_GATE: `disburse` allowed only when `now > expires_at` and
 *                             `reasonably_satisfied_at` is set, or the period is `waived` with an officer-accepted
 *                             `rescission_waivers` row (§1026.23(c), (e)). Facts: status, expires_at, now,
 *                             reasonably_satisfied_at, waiver_id (the rescission_periods row).
 *   25.3.noticeAtSigningOpen — SM_O63_NOTICE_AT_SIGNING_GATE: every consumer entitled to rescind has two paper copies
 *                             (or ≥ 1 electronic copy under a valid E-SIGN consent), the material disclosures and a
 *                             receipt capture in the signing package (§1026.23(b)(1); §1026.17(d)). Facts: consumers[].
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { rescissionGate, noticeAtSigningCheck, type RescissionStatus, type SigningConsumerFacts } from "./ops-25-3.ts";

export const EVALUATORS_25_3: Record<string, Evaluator> = {
  "25.3.rescissionGateOpen": (f) => {
    const status = s(f, "status") as RescissionStatus | "";
    if (!status) return no("REGZ_1026_23_RESCISSION_3SBD_GATE: no rescission_periods row — run determineRescindability / computeRescissionPeriod first");
    const now = s(f, "now"); if (!now) return no("REGZ_1026_23_RESCISSION_3SBD_GATE: `now` is required to compare against expires_at");
    const g = rescissionGate({ status, expires_at: (f.expires_at as string | null | undefined) ?? null, reasonably_satisfied_at: (f.reasonably_satisfied_at as string | null | undefined) ?? null, waiver_id: (f.waiver_id as string | null | undefined) ?? null, now });
    return g.open ? ok : no(`REGZ_1026_23_RESCISSION_3SBD_GATE: ${g.reason}`);
  },
  "25.3.noticeAtSigningOpen": (f) => {
    const consumers = arr<SigningConsumerFacts>(f, "consumers");
    if (!consumers.length) return no("SM_O63_NOTICE_AT_SIGNING_GATE: no consumers listed for the signing package (every person with an ownership interest in the principal dwelling)");
    const g = noticeAtSigningCheck(consumers);
    return g.open ? ok : no(g.reason ?? "SM_O63_NOTICE_AT_SIGNING_GATE closed");
  },
};
export const kit_25_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
