/**
 * §25.2 gate evaluators, keyed "25.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-25-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   25.2.cd3sbdGateOpen     — REGZ_1026_19F1_CD_3SBD_GATE (not_before_gate): `consummate` only on/after the third specific
 *                             business day following the LATEST required consumer's effective receipt of the CD
 *                             (§1026.19(f)(1)(ii)(A); §1026.2(a)(6) second sentence; §1026.17(d)), or from an officer-accepted
 *                             consumer waiver (§1026.19(f)(1)(iv)). Facts: `earliest_consummation_date`, `requested_on`,
 *                             `waiver_accepted_on`, `receipts_complete`.
 *   25.2.ucdAcceptedGateOpen — FNMA_UCD_ACCEPTED_GATE (not_before_gate): `submitDelivery` only with a UCD accepted (or
 *                             accepted with warnings) with zero critical-edit failures whose embedded CD PDF is the final
 *                             (most recent) CD version. Facts: `final_cd_disclosure_id`, `submissions[]`.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { cd3sbdGate, ucdAcceptedGate, type UcdGateFacts } from "./ops-25-2.ts";

export const EVALUATORS_25_2: Record<string, Evaluator> = {
  "25.2.cd3sbdGateOpen": (f) => {
    const g = cd3sbdGate({ earliest_consummation_date: f.earliest_consummation_date ? (s(f, "earliest_consummation_date") as PlainDate) : null, requested_on: s(f, "requested_on") as PlainDate, waiver_accepted_on: f.waiver_accepted_on ? (s(f, "waiver_accepted_on") as PlainDate) : null, ...(typeof f.receipts_complete === "boolean" ? { receipts_complete: f.receipts_complete } : {}) });
    return g.open ? ok : no(g.reason ?? "REGZ_1026_19F1_CD_3SBD_GATE closed");
  },
  "25.2.ucdAcceptedGateOpen": (f) => {
    const g = ucdAcceptedGate({ final_cd_disclosure_id: f.final_cd_disclosure_id ? s(f, "final_cd_disclosure_id") : null, submissions: arr<NonNullable<UcdGateFacts["submissions"]>[number]>(f, "submissions"), loan_delivered: b(f, "loan_delivered") });
    return g.open ? ok : no(g.reason ?? "FNMA_UCD_ACCEPTED_GATE closed");
  },
};
export const kit_25_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
