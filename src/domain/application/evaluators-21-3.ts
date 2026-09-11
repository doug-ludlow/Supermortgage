/**
 * §21.3 gate evaluators, keyed "21.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-21-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { armDisclosureGate, scoreNoticeGate, afbaReferralGate, stateAcknowledgmentGate } from "./ops-21-3.ts";

const stateGate = (state: string, rule_code: string): Evaluator => (f) => {
  const g = stateAcknowledgmentGate({ state, rule_code, property_state: f.property_state ? s(f, "property_state") : null, acknowledged_at: f.acknowledged_at ? s(f, "acknowledged_at") : null });
  return g.open ? ok : no(g.reason ?? `${rule_code} closed`);
};

export const EVALUATORS_21_3: Record<string, Evaluator> = {
  /** REGZ_1026_19B_ARM_DISCLOSURE_GATE (not_before_gate): from the first expression of interest in a variable-rate program, no ARM application form, non-refundable fee or ARM Loan Estimate until the CHARM booklet and the plan's program disclosure are delivered or placed in the mail (§1026.19(b), (c)). Facts: `arm_interest_recorded`, `charm_out_at`, `program_out_at`, `fnma_plan_number`. */
  "21.3.armDisclosureGate": (f) => { const g = armDisclosureGate({ arm_interest_recorded: b(f, "arm_interest_recorded"), charm_out_at: f.charm_out_at ? s(f, "charm_out_at") : null, program_out_at: f.program_out_at ? s(f, "program_out_at") : null, fnma_plan_number: f.fnma_plan_number ? s(f, "fnma_plan_number") : null }); return g.open ? ok : no(g.reason ?? "REGZ_1026_19B_ARM_DISCLOSURE_GATE closed"); },
  /** REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE (not_before_gate): consummation / CD scheduling only when every borrower with a score has a delivered or mailed §609(g)+H-3 notice (§1022.74(d)(3)). Facts: `scored_borrowers[]`, `covered_borrowers[]`. */
  "21.3.scoreNoticeGate": (f) => { const g = scoreNoticeGate({ scored_borrowers: arr<string>(f, "scored_borrowers"), covered_borrowers: arr<string>(f, "covered_borrowers") }); return g.open ? ok : no(g.reason ?? "REGV_1022_74D_SCORE_NOTICE_CONSUMMATION_GATE closed"); },
  /** REGX_1024_15_AFBA_REFERRAL_GATE (not_before_gate): a referral to an affiliated provider only after the Appendix D statement went out no later than the referral (or the application, for a required attorney/CRA/appraiser) (§1024.15(b)(1)). Facts: `afba_required`, `disclosure_out_at`, `referred_at`, `required_provider`, `application_received_at`. */
  "21.3.afbaReferralGate": (f) => { const g = afbaReferralGate({ afba_required: b(f, "afba_required"), disclosure_out_at: f.disclosure_out_at ? s(f, "disclosure_out_at") : null, referred_at: s(f, "referred_at"), required_provider: b(f, "required_provider"), application_received_at: f.application_received_at ? s(f, "application_received_at") : null }); return g.open ? ok : no(g.reason ?? "REGX_1024_15_AFBA_REFERRAL_GATE closed"); },
  /** NY_3NYCRR_38_3_PREAPP_DISCLOSURE_GATE: no application taken and no application/credit-report/appraisal fee until the pre-application disclosure is acknowledged (e-signature, confirm button or signed copy). Facts: `property_state`, `acknowledged_at`. */
  "21.3.nyPreappDisclosureGate": stateGate("NY", "NY_3NYCRR_38_3"),
  /** NJ_3_1_16_3_FEE_DISCLOSURE_GATE: no fee (incl. credit report and third-party reimbursements) until the application disclosure is acknowledged in writing. Facts: `property_state`, `acknowledged_at`. */
  "21.3.njFeeDisclosureGate": stateGate("NJ", "NJ_3_1_16_3"),
  /** AZ_ARS_6_946C_FEE_AGREEMENT_GATE: no fee before consummation until the written fee agreement is signed by the borrower(s) and the partner. Facts: `property_state`, `acknowledged_at`. */
  "21.3.azFeeAgreementGate": stateGate("AZ", "AZ_ARS_6_946C"),
  /** FL_69B_124_013_ANTI_COERCION_AT_APPLICATION: no formal application and no fee until the anti-coercion statement is delivered and the borrower-signed copy is retained (R. 69B-124.002). Facts: `property_state`, `acknowledged_at`. */
  "21.3.flAntiCoercionGate": stateGate("FL", "FL_69B_124_013"),
};
export const kit_21_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
