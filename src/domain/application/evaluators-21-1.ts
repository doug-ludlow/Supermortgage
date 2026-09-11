/**
 * §21.1 gate evaluators, keyed "21.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-21-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are `gateFacts(app)` from ops-21-1.ts: `{ mlo_of_record_id, mlo_nmls_status, mlo_licensed_states, property_state,
 * mlo_review_state, trid_received_at, borrowers: [{ id, scif_presented_at, demographics_collected, joint_intent_affirmed_at, added_at }] }`.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { mloOfRecordGate, scifPresentGate, demographicsAskedGate, jointIntentGate } from "./ops-21-1.ts";

export const EVALUATORS_21_1: Record<string, Evaluator> = {
  /** SAFE_1008_103_MLO_OF_RECORD_GATE (12 CFR 1008.103; §1026.36(g)): MLO of record assigned, NMLS active and licensed for the property state, stage-application review approved. */
  "21.1.mloOfRecordGate": (f) => mloOfRecordGate(f),
  /** SM_O21_SCIF_PRESENT_GATE (LL-2022-03; B2-2-06): Form 1103 presented to every borrower. */
  "21.1.scifPresentGate": (f) => scifPresentGate(f),
  /** SM_O21_DEMOGRAPHICS_ASKED_GATE (Reg C App. B instruction 1): every borrower asked (answered or declined). */
  "21.1.demographicsAskedGate": (f) => demographicsAskedGate(f),
  /** SM_O21_JOINT_INTENT_GATE (§1002.7(d); comment 7(d)(1)-3): every joint applicant affirmed by a distinct artifact before the credit pull. */
  "21.1.jointIntentGate": (f) => jointIntentGate(f),
};
