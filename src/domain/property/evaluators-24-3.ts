/**
 * §24.3 gate evaluators, keyed "24.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-24-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are the plain records the tools in src/app/tools/section24-3.ts assemble from the entity store
 * (`project_reviews`, `property_eligibility_reviews`, `mh_verifications` rows) — see the ops functions' parameter types.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
const sn = (v: unknown): string | null => (typeof v === "string" ? v : null);
import { cpmCertValidGate, projectDocsAgeGate, inspectionLookbackGate, reserveStudyAgeGate, safetyRepairBeforeSaleGate, completionBeforeDeliveryGate, mhLabelVerificationGate, type InspectionReport } from "./ops-24-3.ts";

export const EVALUATORS_24_3: Record<string, Evaluator> = {
  /** FNMA_B4_2_1_01_CPM_CERT_VALID_GATE (B4-2.1-01/-03): CPM certification unexpired at the note date; status ≠ Unavailable. */
  "24.3.cpmCertValidGate": (f) => cpmCertValidGate({ cpm_status: sn(f.cpm_status), cpm_cert_expires_on: sn(f.cpm_cert_expires_on), note_date: sn(f.note_date), ...(f.cpm_required !== undefined ? { cpm_required: f.cpm_required === true } : {}) }),
  /** SM_PROJECT_DOCS_AGE_120 (24.3-Q1 policy): questionnaire / budget ≤ 120 calendar days old at review. */
  "24.3.projectDocsAgeGate": (f) => projectDocsAgeGate({ docs_as_of: sn(f.docs_as_of), reviewed_on: sn(f.reviewed_on), ...(typeof f.max_days === "number" ? { max_days: f.max_days } : {}) }),
  /** FNMA_B4_2_1_03_INSPECTION_LOOKBACK_3Y (B4-2.1-03): every in-window inspection report reviewed. */
  "24.3.inspectionLookbackGate": (f) => inspectionLookbackGate({ inspection_reports: Array.isArray(f.inspection_reports) ? (f.inspection_reports as InspectionReport[]) : [], reviewed_on: sn(f.reviewed_on) }),
  /** FNMA_B4_2_2_01_RESERVE_STUDY_AGE_3Y (B4-2.2-01; FAQs): study ≤ 3 years old; baseline method prohibited for apps ≥ 2026-08-03. */
  "24.3.reserveStudyAgeGate": (f) => reserveStudyAgeGate({ study_date: sn(f.study_date), reviewed_on: sn(f.reviewed_on), method: sn(f.method), application_date: sn(f.application_date) }),
  /** FNMA_B4_1_3_06_SAFETY_REPAIR_BEFORE_SALE_GATE (B4-1.3-05/-06): every safety-related repair completed with accepted evidence. */
  "24.3.safetyRepairBeforeSaleGate": (f) => safetyRepairBeforeSaleGate({ repairs: Array.isArray(f.repairs) ? (f.repairs as { item: string; safety_related: boolean; completed?: boolean; evidence_accepted?: boolean }[]) : [] }),
  /** FNMA_B4_1_2_05_COMPLETION_BEFORE_DELIVERY_GATE (B4-1.2-05): completion evidence for every "subject to" item outside the postponed-improvement path. */
  "24.3.completionBeforeDeliveryGate": (f) => completionBeforeDeliveryGate({ subject_to: f.subject_to === true, repairs: Array.isArray(f.repairs) ? (f.repairs as { item: string; path: string; completed?: boolean; evidence_accepted?: boolean }[]) : [], completion_evidence_accepted: f.completion_evidence_accepted === true }),
  /** SM_MH_LABEL_VERIFICATION_GATE (B5-2-02): HUD label / data plate or verification letter, plus real-property evidence. */
  "24.3.mhLabelVerificationGate": (f) => mhLabelVerificationGate({ hud_label_numbers: Array.isArray(f.hud_label_numbers) ? (f.hud_label_numbers as string[]) : [], data_plate_document_id: sn(f.data_plate_document_id), label_verification_letter_document_id: sn(f.label_verification_letter_document_id), real_property_evidence_document_id: sn(f.real_property_evidence_document_id), mh_result: sn(f.mh_result) }),
};
