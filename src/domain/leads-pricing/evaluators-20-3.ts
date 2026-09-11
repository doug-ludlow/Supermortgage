/**
 * §20.3 gate evaluators, keyed "20.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-20-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 * Facts (ops-20-3.ts builds them from the lead): aiDisclosureGate over `{ai, disclosure_delivered, substantive?}`;
 * authBeforeDisclosureGate over `{assurance_level, data_class ∈ on_file|own_entered}`; softPullPurposeGate over
 * `{authorization_kind, assurance_level, consumer_initiated, end_user}`; noPrequalDeclineGate over `{application_received}`;
 * esignBeforeLeGate over `{applicants[], consents[{party_id, kind, scope[], status}]}`.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { aiDisclosureGate, authBeforeDisclosureGate, softPullPurposeGate, noPrequalDeclineGate, esignBeforeLeGate } from "./ops-20-3.ts";

export const EVALUATORS_20_3: Record<string, Evaluator> = {
  /** SM_AI_INTERACTION_DISCLOSURE_GATE (rule 1): no substantive exchange on an AI channel before NTC_SM_AI_INTERACTION_DISCLOSURE is delivered and logged. */
  "20.3.aiDisclosureGate": (f) => aiDisclosureGate(f),
  /** SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE (rule 2): on-file loan/servicing data at L2 or above; a prospect's own entered data at L1. */
  "20.3.authBeforeDisclosureGate": (f) => authBeforeDisclosureGate(f),
  /** FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE (15 U.S.C. 1681b(a)(3)(A)): a consumer-captured soft_prequal authorization, ≥ L1, consumer-initiated, end_user=partner. */
  "20.3.softPullPurposeGate": (f) => softPullPurposeGate(f),
  /** REGB_1002_2F_NO_PREQUAL_DECLINE_GATE (comment 2(f)-3): a decline is communicated only once `application.received` exists (21.6 governs). */
  "20.3.noPrequalDeclineGate": (f) => noPrequalDeclineGate(f),
  /** SM_ESIGN_BEFORE_LE_GATE (policy over 7.4's ESIGN_7001C_CONSENT_GATE): every applicant's active esign consent covers origination_disclosures before 21.2 e-delivers the LE. */
  "20.3.esignBeforeLeGate": (f) => esignBeforeLeGate(f),
};
