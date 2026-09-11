/**
 * §24.5 gate evaluators, keyed "24.5.<name>". Every key must be named by an `evaluator:` override in
 * timers-24-5.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are the plain records the tools in src/app/tools/section24-5.ts assemble from the entity store
 * (`flood_determinations`, `insurance_policies`, `insurance_deficiencies` rows) — see the ops functions' parameter types.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import { floodNoticeGate, floodCoverageGate, hazardEvidenceGate, projectInsuranceGate, lolEnrolledGate } from "./ops-24-5.ts";

const sn = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const dn = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export const EVALUATORS_24_5: Record<string, Evaluator> = {
  /** FDPA_4104A_FLOOD_NOTICE_GATE (42 U.S.C. 4104a; Interagency Q&A): consummation ≥ effective notice receipt + 10 calendar days, or the recorded short-period path. */
  "24.5.floodNoticeGate": (f) => { const r = floodNoticeGate({ in_sfha: f.in_sfha === true, consummation_date: dn(f.consummation_date), effective_receipt_date: dn(f.effective_receipt_date ?? f.notice_effective_receipt_date), short_period_reason: sn(f.short_period_reason ?? f.notice_short_period_reason), acknowledged_on: dn(f.acknowledged_on ?? f.notice_acknowledged_at), ...(f.acknowledged_before_signing !== undefined ? { acknowledged_before_signing: f.acknowledged_before_signing === true } : {}), purchase_contract_signed_after_determination_without_notice: f.purchase_contract_signed_after_determination_without_notice === true }); return r.open ? { open: true } : { open: false, reason: r.reason ?? "closed" }; },
  /** FNMA_B7_3_06_FLOOD_COVERAGE_GATE (B7-3-06; 44 CFR 61.11): `flood.coverage.verified` on an SFHA loan. */
  "24.5.floodCoverageGate": (f) => floodCoverageGate({ in_sfha: f.in_sfha === true, flood_status: sn(f.flood_status), flood_coverage_verified: f.flood_coverage_verified === true, open_flood_deficiencies: arr(f.open_flood_deficiencies) }),
  /** FNMA_B7_3_02_HAZARD_EVIDENCE_GATE (B7-3-02/-07): hazard verified under fnma.insurance.2026-08, effective ≤ disbursement, premium paid / in force. */
  "24.5.hazardEvidenceGate": (f) => hazardEvidenceGate({ hazard_status: sn(f.hazard_status), effective_date: dn(f.effective_date), disbursement_date: dn(f.disbursement_date), transaction_type: sn(f.transaction_type), premium_paid_at_closing: f.premium_paid_at_closing === true, premium_on_cd: f.premium_on_cd === true, ...(f.policy_in_force !== undefined ? { policy_in_force: f.policy_in_force === true } : {}), rule_set: sn(f.rule_set) }),
  /** FNMA_B7_3_03_PROJECT_INSURANCE_GATE (B7-3-03/-04; B7-4-01/-02): `project.insurance.verified` on condo / co-op / attached PUD units. */
  "24.5.projectInsuranceGate": (f) => projectInsuranceGate({ project_type: sn(f.project_type), project_insurance_verified: f.project_insurance_verified === true, open_project_deficiencies: arr(f.open_project_deficiencies) }),
  /** FDPA_4012A_LOL_ENROLLED_GATE (42 U.S.C. 4012a(b)(3)): LOL purchased and the vendor contract linked to the loan id at boarding. */
  "24.5.lolEnrolledGate": (f) => lolEnrolledGate({ lol_purchased: f.lol_purchased === true, lol_contract_linked: f.lol_contract_linked === true, loan_id: sn(f.loan_id), ...(f.determination_present !== undefined ? { determination_present: f.determination_present === true } : {}) }),
};
