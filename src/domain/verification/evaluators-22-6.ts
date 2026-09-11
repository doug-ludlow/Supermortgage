/**
 * §22.6 gate evaluators, keyed "22.6.<name>". Every key must be named by an `evaluator:` override in
 * timers-22-6.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * The predicates live in ops-22-6.ts; the facts are the store's screening rows: identity levels per borrower, the SSN
 * status, the legal-presence assessment, party results with list versions, the alerted/contacted borrowers, the
 * address-discrepancy resolutions, the fraud-tool report, the occupancy conclusion with the REO status, and the
 * non-arm's-length eligibility.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { addressDiscrepancyGate, fraudAlertContactGate, fraudToolClearGate, identityIal2Gate, legalPresenceGate, nonArmsLengthGate, occupancyReoGate, ofacScreenGate, ssnValidationGate } from "./ops-22-6.ts";

export const EVALUATORS_22_6: Record<string, Evaluator> = {
  /** SM_IDENTITY_IAL2_GATE (R1): every borrower at ial2_remote_doc_biometric or better; valid_until ≥ note date before consummate. */
  "22.6.identityIal2Gate": (f) => identityIal2Gate(f),
  /** FNMA_B2_2_01_SSN_VALIDATION_GATE (B2-2-01): consistent, resolved internally, or validated by the SSA. */
  "22.6.ssnValidationGate": (f) => ssnValidationGate(f),
  /** FNMA_B2_2_02_LEGAL_PRESENCE_GATE (B2-2-02): assessment = legally_present. */
  "22.6.legalPresenceGate": (f) => legalPresenceGate(f),
  /** OFAC_SDN_SCREEN_GATE (31 CFR 501): every party clear / false-positive-resolved against the latest list version, re-screened ≤ 1 business_days_creditor before consummation. */
  "22.6.ofacScreenGate": (f) => ofacScreenGate(f),
  /** FCRA_605A_H_ALERT_CONTACT_GATE (15 U.S.C. 1681c-1(h)): contact completed for every alerted borrower. */
  "22.6.fraudAlertContactGate": (f) => fraudAlertContactGate(f),
  /** REGV_1022_82_ADDRESS_DISCREPANCY_GATE (12 CFR 1022.82): reasonable belief formed for every discrepant borrower. */
  "22.6.addressDiscrepancyGate": (f) => addressDiscrepancyGate(f),
  /** SM_FRAUD_TOOL_CLEAR_GATE: report run, high alerts dispositioned, refreshed ≤ 10 business_days_creditor before consummation. */
  "22.6.fraudToolClearGate": (f) => fraudToolClearGate(f),
  /** SM_OCCUPANCY_REO_GATE (R7/R8): occupancy consistent (or explanation resolved) and REO clear / resolved. */
  "22.6.occupancyReoGate": (f) => occupancyReoGate(f),
  /** FNMA_B2_1_3_01_NON_ARMS_LENGTH_GATE (B2-1.3-01): eligible = true. */
  "22.6.nonArmsLengthGate": (f) => nonArmsLengthGate(f),
};
export const kit_22_6 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
