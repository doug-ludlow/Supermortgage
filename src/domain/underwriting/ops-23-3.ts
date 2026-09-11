/**
 * §23.3 — The credit decision: comprehensive risk assessment (B3-1-01), conditional approval, condition clearing
 * (PTD/PTF), clear-to-close and the rep-and-warrant relief ledger. Pure rule functions, one per rule / T-id; the bus
 * tools in src/app/tools/section23-3.ts call them. Spec: spec/sections/23-…/23-3-the-credit-decision-….md.
 *
 * Events appended here (every one carries `applicationId`, so the 23.3 timers arm under origination context):
 *   decision.issued{kind=conditional_approval}        — 21.6's recommendDisposition (the decisions row; never re-implemented)
 *   credit_decision.recorded{kind, valid_until, inputs_hash}   [arms SM_UW_DECISION_VALIDITY on `valid_until`]
 *   condition.cleared{condition_id, standard_ref, age_check}   [satisfies SM_UW_CONDITION_CLEAR_SLA_1BD]
 *   condition.reopened{reason} · condition.waived{reason}      (waivers: `underwriting_reviewer`, SM-added conditions only)
 *   ptd.cleared{blocking_codes=[]}                              [satisfies SM_UW_PTD_CLEARED_GATE]
 *   clear_to_close.issued{checklist_id, passed=true}            [satisfies SM_UW_CTC_GATE]
 *   ptf.cleared                                                 [satisfies SM_UW_PTF_CLEARED_GATE]
 *   decision.reopened{cause} · decision.superseded · rep_warrant_relief.evaluated{stage, components}
 *   adverse_decision.prepared / adverse_decision.reviewed / adverse_decision.handed_off (→ 21.6 recommendDisposition + reviewDecision)
 *
 * Reused, never re-implemented: 23.2's conditions, investigations, ctcBlockers and restructure expiry; 21.6's decision
 * file, reason validation (§1002.9(b)(2)) and counteroffer clock; 22.2's credit-report expiry; 22.3's Close by Date gate
 * and close-by reassessment; 22.5's DTI arithmetic; 23.1's P&I; 23.4's QM gate through evaluateGate.
 */
import { createHash } from "node:crypto";
import type { EventStore, DomainEvent, Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { businessDaysBetween, addBusinessDays, creditor, type Calendar } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { AGENT, openCondition, ctcBlockers, expireRestructure, assertBorrowerSafe, type Condition, type Investigation23, type RestructureProposal, type PolicyOutcome, type RequiresRole, type ConditionStage } from "./ops-23-2.ts";
import { recommendDisposition, reviewDecision, recordConditionalApproval, assertReasonText, counterofferClock, type DecisionFile, type DecisionFactor, type DecisionRow, type CounterofferTerms } from "../application/ops-21-6.ts";
import { closeByGate, reassessCloseBy } from "../verification/ops-22-3.ts";
import { dtiDisplayPct } from "../verification/ops-22-5.ts";

export const RULE_SETS_23_3 = { "fnma.selling": "2026-09-02", "regb": "2013 (as amended July 21, 2026)", "fnma.du": "12.1", "regz.qm": "regz.qm.general.2021", "jurisdiction": "state-matrix-2026-09" } as const;
export const DECISION_VALIDITY_CAP_DAYS = 90;
export const CREDIT_DOC_AGE_MONTHS = 4;                       // B1-1-03
export const REOPEN_REVIEWER_WINDOW_BD = 3;                    // reopened decision < 3 business_days_creditor before closing → underwriting_reviewer, same business day
export const CTC_SLA_MINUTES = 60;                             // "issues CTC the moment it passes" — T4 bound
export const PAYMENT_HISTORY_RELIEF_PAYMENTS = 36;             // A2-3.2-02
export const RETENTION_CLASSES = ["regb_25m", "fnma_loan_file_life_plus_4y"] as const;

export class DecisionRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, why: string) { super(`23.3 refused [${code}]: ${why}`); this.name = "DecisionRefused"; this.code = code; this.citation = citation; }
}
const need = (ok: boolean, why: string): void => { if (!ok) throw new RangeError(why); };
const nonEmpty = (v: unknown, name: string): void => need(typeof v === "string" && v.length > 0, `${name} is required`);
const emit = (events: EventStore, application_id: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor): DomainEvent =>
  events.append({ type, applicationId: application_id, aggregate: { kind: "application", id: application_id }, actor, occurredAt: at, payload: { application_id, ...payload } });
const isReviewer = (a: Actor): boolean => a.kind === "human" && a.role === "underwriting_reviewer";
const minDate = (...ds: (PlainDate | null)[]): PlainDate => { const xs = ds.filter((d): d is PlainDate => d !== null); need(xs.length > 0, "at least one date"); return xs.reduce((a, b) => (b < a ? b : a)); };

// ============================================================ data model (spec "Data model")
export type DecisionStatus = "active" | "superseded" | "reopened" | "withdrawn";
export type RegBNoticeKind = "approval" | "counteroffer" | "adverse_action" | "noia" | "none";
export type ReviewerAction = "approved" | "modified" | "rejected" | null;
export interface RiskAssessment {
  readonly credit: { readonly score_model: string; readonly representative_score: number | null; readonly history_summary: string };
  readonly capacity: { readonly dti_bps: number; readonly dti_display_pct: string; readonly residual_income_cents: Cents; readonly income_sources: readonly string[] };
  readonly capital: { readonly funds_to_close_cents: Cents; readonly reserves_months: number };
  readonly collateral: { readonly ltv_x100: number; readonly cltv_x100: number; readonly hcltv_x100: number; readonly valuation_method: string; readonly cu_score: number | null };
  readonly layering: readonly string[]; readonly du_risk_factors: readonly string[]; readonly cash_flow_assessment: string | null;
  readonly lender_duties_confirmed: readonly string[];
}
export interface CreditDecision {
  readonly decision_id: string; readonly application_id: string; readonly kind: "conditional_approval" | "approval"; readonly du_submission_id: string | null; readonly interpretation_id: string | null;
  readonly risk_assessment: RiskAssessment; readonly inputs_hash: string; readonly evidence_document_ids: readonly string[]; readonly rule_set_versions: typeof RULE_SETS_23_3; readonly model_version: string; readonly prompt_version: string;
  readonly rationale: string; readonly confidence: number; readonly conditions_snapshot: readonly { condition_id: string; template_code: string; stage: ConditionStage; text: string }[];
  readonly reviewer_id: string | null; readonly reviewer_action: ReviewerAction; readonly reviewer_at: string | null; readonly decided_at: string; readonly decided_by: string;
  readonly valid_until: PlainDate; readonly validity_component: string; readonly status: DecisionStatus; readonly regb_notice_kind: RegBNoticeKind; readonly notice_id: string | null;
  readonly ctc_at: string | null; readonly ctc_checklist_id: string | null; readonly ptf_cleared_at: string | null; readonly reopen_cause: string | null;
}
export type ClearedByKind = "agent" | "underwriting_reviewer" | "qc_officer" | "funding_approver";
export interface AgeCheck { readonly document_id: string; readonly kind: string; readonly document_date: PlainDate | null; readonly expires_on: PlainDate | null; readonly note_date: PlainDate; readonly pass: boolean; readonly rule: "B1_1_03_AGE" | "B1_1_03_W2_MOST_RECENT_YEAR" | "not_a_credit_document"; }
export interface ConditionClearance {
  readonly clearance_id: string; readonly condition_id: string; readonly application_id: string; readonly cleared_by_kind: ClearedByKind; readonly cleared_by_id: string; readonly standard_ref: string;
  readonly evidence_document_ids: readonly string[]; readonly evidence_verification_ids: readonly string[]; readonly age_check: readonly AgeCheck[]; readonly cleared_at: string; readonly notes: string | null; readonly qc_sample_flag: boolean;
  readonly reversed_at: string | null; readonly reversal_reason: string | null;
}
export type CtcItemStatus = "pass" | "fail" | "waived" | "n/a";
export const CTC_ITEM_CODES = ["CTC_DU_FINAL_MATCH", "CTC_PTD_ALL_CLEARED", "CTC_NO_OPEN_INVESTIGATION", "CTC_CREDIT_VALID", "CTC_DU_CLOSE_BY", "CTC_ASSETS_CASH_TO_CLOSE", "CTC_VALUATION", "CTC_PROPERTY_PROJECT", "CTC_TITLE", "CTC_INSURANCE_FLOOD", "CTC_MI", "CTC_COMPLIANCE", "CTC_EDUCATION", "CTC_LOCK", "CTC_IDENTITY_OFAC", "CTC_QC_PREFUNDING", "CTC_MLO_APPROVALS", "CTC_REGB_TIMING", "CTC_DECISION_VALID"] as const;
export type CtcItemCode = (typeof CTC_ITEM_CODES)[number];
export const CTC_OWNERS: Record<CtcItemCode, string> = { CTC_DU_FINAL_MATCH: "23.1", CTC_PTD_ALL_CLEARED: "23.3", CTC_NO_OPEN_INVESTIGATION: "22.6/23.2", CTC_CREDIT_VALID: "22.2", CTC_DU_CLOSE_BY: "22.3", CTC_ASSETS_CASH_TO_CLOSE: "22.4/25.2", CTC_VALUATION: "24.1/24.2", CTC_PROPERTY_PROJECT: "24.3", CTC_TITLE: "24.4", CTC_INSURANCE_FLOOD: "24.5", CTC_MI: "24.6", CTC_COMPLIANCE: "23.4/25.1", CTC_EDUCATION: "23.2", CTC_LOCK: "21.4", CTC_IDENTITY_OFAC: "22.6", CTC_QC_PREFUNDING: "28.1", CTC_MLO_APPROVALS: "21.1/21.4", CTC_REGB_TIMING: "21.6", CTC_DECISION_VALID: "23.3" };
/** `CTC_REGB_TIMING` is informational ("never blocks"); `CTC_QC_PREFUNDING` surfaces 28.1's FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE as the checklist item `SM_QC_PREFUNDING_HOLD`. */
export const CTC_INFORMATIONAL: readonly CtcItemCode[] = ["CTC_REGB_TIMING"];
export const SM_QC_PREFUNDING_HOLD = "SM_QC_PREFUNDING_HOLD";
export interface CtcItem { readonly code: CtcItemCode; readonly owner_process: string; readonly status: CtcItemStatus; readonly evidence_ref: string | null; readonly item_alias: string | null; readonly blocking: boolean; }
export interface CtcChecklist { readonly checklist_id: string; readonly application_id: string; readonly decision_id: string; readonly evaluated_at: string; readonly items: readonly CtcItem[]; readonly passed: boolean; readonly blocking_codes: readonly string[]; readonly waived_by: string | null; }
export type ReliefComponent = "limited_waiver_du" | "income_validated" | "employment_validated" | "assets_validated" | "undisclosed_debt" | "income_calculator" | "value_acceptance" | "cu_score_2_5" | "payment_history_36";
export type ReliefStatus = "eligible" | "at_risk" | "lost" | "confirmed_by_fnma" | "not_applicable";
export interface ReliefEntry {
  readonly relief_id: string; readonly application_id: string; readonly loan_id: string | null; readonly component: ReliefComponent; readonly basis_ref: string; readonly conditions_met: boolean; readonly close_by_date: PlainDate | null; readonly credit_expiration_date: PlainDate | null;
  readonly status: ReliefStatus; readonly target_date: PlainDate | null; readonly evaluated_at: string; readonly confirmed_at: string | null; readonly notes: string;
}

// ============================================================ guardrail: protected-class data never reaches the assessment
const DEMOGRAPHIC_KEYS = /^(race|ethnicity|sex|gender|age|date_of_birth|dob|marital_status|national_origin|religion|applicant_demographics|hmda_demographics|public_assistance|disability)$/i;
/** Walks the object graph: any field derived from `applicant_demographics` (restricted_fl) refuses the run. */
export function assertNoDemographics(o: unknown, path = "input"): void {
  if (Array.isArray(o)) { o.forEach((x, n) => assertNoDemographics(x, `${path}[${n}]`)); return; }
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (DEMOGRAPHIC_KEYS.test(k)) throw new DecisionRefused("PROTECTED_CLASS_DATA_IN_ASSESSMENT", "23.3 guardrails: never use protected-class data or proxies in the assessment (demographics live in `applicant_demographics` with access logging and are not readable by the agent)", `${path}.${k} is a protected-class field`);
    assertNoDemographics(v, `${path}.${k}`);
  }
}

// ============================================================ rule 1 — the decision is the lender's, informed by DU (B3-1-01 / B3-2-01)
export interface RiskInput {
  readonly credit: { score_model: string; representative_score: number | null; history_summary: string; derogatory_not_evaluated_by_du?: readonly string[] };
  readonly capacity: { dti_bps: number; residual_income_cents: Cents; income_sources: readonly string[]; income_reconciled_to_22_3: boolean };
  readonly capital: { funds_to_close_cents: Cents; reserves_months: number; assets_reconciled_to_22_4: boolean };
  readonly collateral: { ltv_x100: number; cltv_x100: number; hcltv_x100: number; valuation_method: string; cu_score: number | null };
  readonly du_risk_factors: readonly string[]; readonly cash_flow_assessment?: string | null;
  readonly eligibility_outside_du_confirmed: boolean; readonly legal_compliance_confirmed: boolean;
}
export const LENDER_DUTIES_B3_1_01 = ["evaluate_delinquency_risk", "review_credit_report_beyond_du", "assess_collateral_adequacy", "determine_fnma_eligibility", "determine_appropriate_to_deliver", "document_assessment"] as const;
/** Layering is recorded (DTI > 45 % with reserves < 2 months and a 97 % LTV) but never overrides an Approve/Eligible (23.3-Q1: no overlays by default). */
export function assessRisk(i: RiskInput): RiskAssessment {
  assertNoDemographics(i);
  need(Number.isFinite(i.capacity.dti_bps) && i.capacity.dti_bps >= 0, "capacity.dti_bps is required");
  need(i.capacity.income_reconciled_to_22_3, "B3-1-01: income must be reconciled to 22.3's verified figures before the assessment");
  need(i.capital.assets_reconciled_to_22_4, "B3-1-01: assets must be reconciled to 22.4's verified figures before the assessment");
  need(i.eligibility_outside_du_confirmed, "B3-2-01: Fannie Mae eligibility outside DU's scope (project, title, insurance, legal) must be confirmed");
  need(i.legal_compliance_confirmed, "B3-2-01: 'DU does not evaluate a loan's compliance with federal and state laws' — 23.4/25.1 results are required");
  const layering: string[] = [];
  if (i.capacity.dti_bps > 4500) layering.push("DTI_OVER_45");
  if (i.capital.reserves_months < 2) layering.push("RESERVES_UNDER_2M");
  if (i.collateral.ltv_x100 >= 9700) layering.push("LTV_97");
  if (layering.length === 3) layering.push("LAYERED_DTI45_RESERVES2M_LTV97");
  for (const d of i.credit.derogatory_not_evaluated_by_du ?? []) layering.push(`CREDIT_REPORT_ITEM_NOT_IN_DU:${d}`);
  return { credit: { score_model: i.credit.score_model, representative_score: i.credit.representative_score, history_summary: i.credit.history_summary },
    capacity: { dti_bps: i.capacity.dti_bps, dti_display_pct: dtiDisplayPct(i.capacity.dti_bps), residual_income_cents: i.capacity.residual_income_cents, income_sources: [...i.capacity.income_sources] },
    capital: { funds_to_close_cents: i.capital.funds_to_close_cents, reserves_months: i.capital.reserves_months }, collateral: { ...i.collateral }, layering, du_risk_factors: [...i.du_risk_factors], cash_flow_assessment: i.cash_flow_assessment ?? null, lender_duties_confirmed: [...LENDER_DUTIES_B3_1_01] };
}
/** `inputs_hash` = sha256 over the ULAD snapshot hash, the verification ids and the findings hash (LL-2026-04 record). */
export function inputsHash(i: { ulad_snapshot_hash: string; verification_ids: readonly string[]; findings_hash: string }): string {
  nonEmpty(i.ulad_snapshot_hash, "ulad_snapshot_hash"); nonEmpty(i.findings_hash, "findings_hash");
  return createHash("sha256").update(JSON.stringify({ u: i.ulad_snapshot_hash, v: [...i.verification_ids].sort(), f: i.findings_hash })).digest("hex");
}

// ============================================================ rule 2 — conditional approval and validity
export interface ValidityInput { readonly issued_on: PlainDate; readonly credit_expires_at: PlainDate; readonly lock_expires_at: PlainDate | null; readonly valuation_expires_at: PlainDate | null; readonly du_close_by_date: PlainDate | null; }
/** `valid_until = min(credit expiration (22.2), lock expiration (21.4; null if floating), valuation expiry (24.1), DU close-by date (22.3), 90 days from issuance)` (23.3-Q5). */
export function validUntil(i: ValidityInput): { valid_until: PlainDate; component: string } {
  const cap = addDays(i.issued_on, DECISION_VALIDITY_CAP_DAYS);
  const cands: [string, PlainDate | null][] = [["credit_expiration", i.credit_expires_at], ["lock_expiration", i.lock_expires_at], ["valuation_expiry", i.valuation_expires_at], ["du_close_by", i.du_close_by_date], ["90_day_cap", cap]];
  const valid_until = minDate(...cands.map(([, d]) => d));
  return { valid_until, component: cands.find(([, d]) => d === valid_until)![0] };
}
export interface ApprovalGuardInput { readonly policy_outcome: PolicyOutcome; readonly qm_facts: Record<string, unknown>; readonly is_hoepa: boolean | null; readonly is_state_high_cost: boolean | null; readonly open_red_flag_investigations: number; }
/** Issued only when `policy_outcome = proceed`, 23.4's preliminary determination is `qm` and not high-cost (evaluateGate 23.4.qmDeterminationGate), and no open red-flag investigation exists. */
export function conditionalApprovalGuard(i: ApprovalGuardInput): { open: boolean; blocking_codes: readonly string[]; reason: string | null } {
  const codes: string[] = [];
  if (i.policy_outcome !== "proceed") codes.push(`POLICY_OUTCOME_${i.policy_outcome.toUpperCase()}`);
  const qm = evaluateGate("23.4.qmDeterminationGate", { ...i.qm_facts, command: "issueCD" });
  if (!qm.open) codes.push("QM_PRELIMINARY_NOT_QM");
  if (i.is_hoepa !== false || i.is_state_high_cost === true) codes.push("HIGH_COST_PRELIMINARY");
  if (i.open_red_flag_investigations > 0) codes.push("CTC_NO_OPEN_INVESTIGATION");
  return { open: codes.length === 0, blocking_codes: codes, reason: codes.length ? `conditional approval blocked: ${codes.join(", ")}${qm.open ? "" : ` — ${qm.reason ?? ""}`}` : null };
}
const LIVE_STATUSES: readonly Condition["status"][] = ["open", "waiting_borrower", "waiting_third_party", "satisfied_pending_review", "reopened"];
export const liveConditions = (cs: readonly Condition[]): Condition[] => cs.filter((c) => LIVE_STATUSES.includes(c.status));
export interface IssueApprovalInput {
  readonly decision_id: string; readonly file: DecisionFile; readonly guard: ApprovalGuardInput; readonly validity: Omit<ValidityInput, "issued_on">; readonly risk_assessment: RiskAssessment; readonly inputs: Parameters<typeof inputsHash>[0];
  readonly du_submission_id: string | null; readonly interpretation_id: string | null; readonly conditions: readonly Condition[]; readonly evidence_document_ids: readonly string[]; readonly rationale: string; readonly confidence: number;
  readonly model_version: string; readonly prompt_version: string; readonly at: string; readonly issued_on: PlainDate;
}
/** The conditional approval: 21.6's `decision.issued{kind=conditional_approval}` (the decisions row) + 23.3's record with the risk assessment, inputs hash, validity and the borrower-facing conditions snapshot. */
export function issueConditionalApproval(events: EventStore, escalations: EscalationService, i: IssueApprovalInput, actor: Actor = AGENT): { decision: CreditDecision; file: DecisionFile; row: DecisionRow; events: DomainEvent[] } {
  nonEmpty(i.decision_id, "decision_id"); nonEmpty(i.rationale, "rationale"); need(i.confidence >= 0 && i.confidence <= 1, "confidence must be in [0, 1]");
  const g = conditionalApprovalGuard(i.guard);
  if (!g.open) throw new DecisionRefused("CONDITIONAL_APPROVAL_GUARD", "23.3 rule 2 / state machine: `conditionally_approved` requires `policy_outcome = proceed`, a 23.4 preliminary `qm` / `not_high_cost` result and no open red-flag investigation", g.reason ?? "closed");
  assertNoDemographics(i.risk_assessment);
  const v = validUntil({ ...i.validity, issued_on: i.issued_on });
  const visible = liveConditions(i.conditions).filter((c) => c.borrower_visible);
  for (const c of visible) assertBorrowerSafe(c.text, c.du_message_id ? [c.du_message_id] : []);
  const r = recommendDisposition(events, escalations, i.file, { decision_id: i.decision_id, factors: [], du_recommendation: "approve_eligible", at: i.at, data_sufficient: true });
  if (r.kind !== "conditional_approval" && r.kind !== "approval") throw new DecisionRefused("NOT_AN_APPROVAL", "23.3: the agent issues approvals alone; every adverse kind goes through prepareAdverseDecision and the underwriting_reviewer", `21.6 derived ${r.kind}`);
  const file = recordConditionalApproval(r.file, { approved_on: i.issued_on, expires_on: v.valid_until, open_conditions: visible.map((c) => ({ condition_id: c.condition_id, description: c.text, kind: "creditworthiness" as const })) });
  const decision: CreditDecision = { decision_id: i.decision_id, application_id: i.file.application_id, kind: r.kind, du_submission_id: i.du_submission_id, interpretation_id: i.interpretation_id, risk_assessment: i.risk_assessment, inputs_hash: inputsHash(i.inputs), evidence_document_ids: [...i.evidence_document_ids],
    rule_set_versions: RULE_SETS_23_3, model_version: i.model_version, prompt_version: i.prompt_version, rationale: i.rationale, confidence: i.confidence, conditions_snapshot: visible.map((c) => ({ condition_id: c.condition_id, template_code: c.template_code, stage: c.stage, text: c.text })),
    reviewer_id: null, reviewer_action: null, reviewer_at: null, decided_at: i.at, decided_by: `${actor.kind}:${actor.id}`, valid_until: v.valid_until, validity_component: v.component, status: "active", regb_notice_kind: "approval", notice_id: null, ctc_at: null, ctc_checklist_id: null, ptf_cleared_at: null, reopen_cause: null };
  const recorded = emit(events, i.file.application_id, "credit_decision.recorded", { decision_id: decision.decision_id, kind: decision.kind, valid_until: decision.valid_until, validity_component: v.component, inputs_hash: decision.inputs_hash, conditions_count: visible.length, regb_notice_kind: "approval", rule_set_versions: RULE_SETS_23_3, model_version: i.model_version, prompt_version: i.prompt_version, retention_class: RETENTION_CLASSES }, i.at, actor);
  return { decision, file, row: r.decision, events: [r.event, recorded] };
}
export interface LetterInput { readonly creditor_name: string; readonly creditor_nmlsr_id: string; readonly creditor_address: string; readonly mlo_name: string; readonly mlo_nmlsr_id: string; readonly applicant_name: string; readonly property_address: string; readonly terms: { loan_amount_cents: Cents; note_rate_pct: string; term_months: number; product: string }; readonly notice_date: PlainDate; }
/** `NTC_REGB_1002_9_APPROVAL` payload — the express approval notification (§1002.9(a)(1)(i)) in the partner's name; conditions in borrower-facing wording only. */
export function approvalLetterPayload(d: CreditDecision, i: LetterInput): Record<string, unknown> {
  for (const k of ["creditor_name", "creditor_nmlsr_id", "creditor_address", "mlo_name", "mlo_nmlsr_id", "applicant_name"] as const) nonEmpty(i[k], k);
  const conditions = d.conditions_snapshot.map((c) => c.text); for (const t of conditions) assertBorrowerSafe(t, []);
  return { creditor_name: i.creditor_name, creditor_nmlsr_id: i.creditor_nmlsr_id, creditor_address: i.creditor_address, mlo_name: i.mlo_name, mlo_nmlsr_id: i.mlo_nmlsr_id, applicant_name: i.applicant_name, application_id: d.application_id, property_address: i.property_address, notice_date: i.notice_date,
    terms: { loan_amount_cents: i.terms.loan_amount_cents, note_rate_pct: i.terms.note_rate_pct, term_months: i.terms.term_months, product: i.terms.product }, conditions, conditions_count: conditions.length, valid_until: d.valid_until, decision_id: d.decision_id, retention_class: "regb_25m" };
}

// ============================================================ rule 3 — clearing standards (B1-1-03 age; DU documentation level; who may clear)
export interface EvidenceDoc { readonly document_id: string; readonly kind: string; readonly document_date: PlainDate | null; readonly tax_year?: number | null; readonly classified_at: string; readonly is_credit_document?: boolean; readonly verification_id?: string | null; }
const W2_KINDS = /^(w2|w_2|form_1099|tax_return|form_1040)$/;
/** B1-1-03: credit documents no more than four months old on the note date; a W-2 / 1099 / return counts by tax year ("the most recent year"). */
export function ageCheck(doc: EvidenceDoc, note_date: PlainDate): AgeCheck {
  if (doc.is_credit_document === false) return { document_id: doc.document_id, kind: doc.kind, document_date: doc.document_date, expires_on: null, note_date, pass: true, rule: "not_a_credit_document" };
  if (W2_KINDS.test(doc.kind)) { const y = Number(note_date.slice(0, 4)); const ok = typeof doc.tax_year === "number" && doc.tax_year >= y - 1; return { document_id: doc.document_id, kind: doc.kind, document_date: doc.document_date, expires_on: null, note_date, pass: ok, rule: "B1_1_03_W2_MOST_RECENT_YEAR" }; }
  need(doc.document_date !== null, `${doc.document_id}: document_date is required for the B1-1-03 age test`);
  const expires_on = addMonths(doc.document_date!, CREDIT_DOC_AGE_MONTHS);
  return { document_id: doc.document_id, kind: doc.kind, document_date: doc.document_date, expires_on, note_date, pass: expires_on >= note_date, rule: "B1_1_03_AGE" };
}
export type ClearanceOutcome = "cleared" | "satisfied_pending_review" | "insufficient";
export interface ClearanceContext { readonly note_date: PlainDate; readonly du_used?: { qualifying_income_cents?: Cents; funds_to_verify_cents?: Cents; reserves_required_cents?: Cents } | null; readonly verified?: { income_cents?: Cents; assets_cents?: Cents; reserves_cents?: Cents } | null; readonly validated?: { component: "income" | "employment" | "assets"; close_by_date: PlainDate | null } | null; }
export interface ClearanceEvaluation { readonly condition_id: string; readonly outcome: ClearanceOutcome; readonly standard_ref: string; readonly age_check: readonly AgeCheck[]; readonly reasons: readonly string[]; readonly evidence_document_ids: readonly string[]; readonly evidence_verification_ids: readonly string[]; readonly requires_role: RequiresRole | null; }
/** (a) evidence kinds per the template; (b) B1-1-03 freshness at the projected note date; (c) amounts ≥ DU's; (d) validated components inside the close-by date; (e) `requires_role`. "A more comprehensive level of documentation is always acceptable" (B3-2-04). */
export function evaluateClearance(cond: Condition, evidence: readonly EvidenceDoc[], ctx: ClearanceContext): ClearanceEvaluation {
  need(/^\d{4}-\d{2}-\d{2}$/.test(ctx.note_date), "note_date (projected) is required");
  const reasons: string[] = [];
  const kinds = new Set(evidence.map((e) => e.kind));
  const missing = cond.evidence_kinds.filter((k) => !kinds.has(k));
  const standard_ref = cond.auto_clear_rule ?? `${cond.category}/DU:${cond.evidence_kinds.join("+") || "none"}`;
  if (!evidence.length || (cond.evidence_kinds.length > 0 && missing.length === cond.evidence_kinds.length)) return { condition_id: cond.condition_id, outcome: "insufficient", standard_ref, age_check: [], reasons: [`EVIDENCE_MISSING:${missing.join(",") || "any"}`], evidence_document_ids: evidence.map((e) => e.document_id), evidence_verification_ids: [], requires_role: cond.requires_role };
  if (missing.length) reasons.push(`EVIDENCE_KIND_MISSING:${missing.join(",")}`);
  const age_check = evidence.map((e) => ageCheck(e, ctx.note_date));
  if (age_check.some((a) => !a.pass)) reasons.push("B1_1_03_AGE");
  const du = ctx.du_used ?? null, ver = ctx.verified ?? null;
  if (du?.qualifying_income_cents !== undefined && ver?.income_cents !== undefined && ver.income_cents < du.qualifying_income_cents) reasons.push("INCOME_BELOW_DU_QUALIFYING");
  if (du?.funds_to_verify_cents !== undefined && ver?.assets_cents !== undefined && ver.assets_cents < du.funds_to_verify_cents) reasons.push("ASSETS_BELOW_TOTAL_FUNDS_TO_VERIFY");
  if (du?.reserves_required_cents !== undefined && ver?.reserves_cents !== undefined && ver.reserves_cents * 100n < du.reserves_required_cents * 90n) reasons.push("RESERVES_BELOW_90PCT");
  if (ctx.validated && ctx.validated.close_by_date && !closeByGate(ctx.validated.close_by_date, ctx.note_date).open) reasons.push("DU_CLOSE_BY_PASSED");
  if (cond.requires_role) reasons.push(`REQUIRES_ROLE:${cond.requires_role}`);
  return { condition_id: cond.condition_id, outcome: reasons.length ? "satisfied_pending_review" : "cleared", standard_ref, age_check, reasons, evidence_document_ids: evidence.map((e) => e.document_id), evidence_verification_ids: evidence.map((e) => e.verification_id ?? null).filter((v): v is string => v !== null), requires_role: cond.requires_role };
}
export interface ClearInput { readonly at: string; readonly closing_date?: PlainDate | null; readonly notes?: string | null; readonly qc_sample_flag?: boolean; readonly calendar?: Calendar; }
const clearedByKind = (a: Actor): ClearedByKind => (a.kind === "agent" ? "agent" : a.role === "underwriting_reviewer" ? "underwriting_reviewer" : a.role === "qc_officer" ? "qc_officer" : a.role === "funding_approver" ? "funding_approver" : "agent");
/** Who may clear: the agent for auto-clear (a)–(d); `underwriting_reviewer` for `requires_role`, pending-review and reopened-then-cleared inside 3 BD of closing; `qc_officer` never (independence); `funding_approver` only funding-stage items. */
export function clearCondition(events: EventStore, cond: Condition, ev: ClearanceEvaluation, i: ClearInput, actor: Actor = AGENT): { condition: Condition; clearance: ConditionClearance; event: DomainEvent } {
  need(ev.condition_id === cond.condition_id, "evaluation belongs to another condition");
  need(LIVE_STATUSES.includes(cond.status), `${cond.condition_id} is ${cond.status}`);
  const by = clearedByKind(actor);
  if (by === "qc_officer") throw new DecisionRefused("QC_OFFICER_CANNOT_CLEAR", "23.3 rule 3: `qc_officer` never clears production conditions (independence, D1-2-01) but can reopen", `${actor.id} may reopen, not clear`);
  if (by === "funding_approver" && !(cond.stage === "ptf" && cond.category === "funding")) throw new DecisionRefused("FUNDING_APPROVER_FUNDING_ITEMS_ONLY", "23.3 rule 3: `funding_approver` clears only funding-stage items (26.3)", `${cond.condition_id} is ${cond.stage}/${cond.category}`);
  if (ev.outcome === "insufficient") throw new DecisionRefused("CLEAR_WITHOUT_EVIDENCE_AT_DU_LEVEL", "23.3 guardrails: never clear a DU verification condition without evidence meeting DU's documentation level (B3-2-04)", ev.reasons.join(", "));
  const nearClosing = i.closing_date ? businessDaysBetween(D(i.at.slice(0, 10)), i.closing_date, i.calendar ?? creditor) < REOPEN_REVIEWER_WINDOW_BD : false;
  const needsReviewer = ev.outcome === "satisfied_pending_review" || cond.requires_role === "underwriting_reviewer" || (cond.status === "reopened" && nearClosing);
  if (needsReviewer && by !== "underwriting_reviewer") throw new DecisionRefused("CLEAR_NEEDS_UNDERWRITING_REVIEWER", "23.3 rule 3: `underwriting_reviewer` clears conditions marked `requires_role`, any pending-review item and reopened-then-cleared conditions inside 3 BD of closing", `${cond.condition_id}: ${ev.reasons.join(", ") || cond.status}`);
  if (needsReviewer) nonEmpty(i.notes, "notes (the reviewer's recorded basis)");
  if (cond.requires_role === "qc_officer" || cond.requires_role === "funding_approver") need(by === cond.requires_role, `${cond.condition_id} requires ${cond.requires_role}`);
  const clearance: ConditionClearance = { clearance_id: `clr:${cond.condition_id}:${i.at}`, condition_id: cond.condition_id, application_id: cond.application_id, cleared_by_kind: by, cleared_by_id: actor.id, standard_ref: ev.standard_ref, evidence_document_ids: [...ev.evidence_document_ids], evidence_verification_ids: [...ev.evidence_verification_ids], age_check: [...ev.age_check], cleared_at: i.at, notes: i.notes ?? null, qc_sample_flag: i.qc_sample_flag ?? cond.qc_sampled, reversed_at: null, reversal_reason: null };
  const condition: Condition = { ...cond, status: "cleared", cleared_at: i.at, cleared_by: actor.id, clear_evidence_document_ids: [...ev.evidence_document_ids] };
  const event = emit(events, cond.application_id, "condition.cleared", { condition_id: cond.condition_id, template_code: cond.template_code, stage: cond.stage, category: cond.category, source: cond.source, clearance_id: clearance.clearance_id, cleared_by_kind: by, cleared_by: actor.id, standard_ref: ev.standard_ref, evidence_document_ids: clearance.evidence_document_ids, evidence_verification_ids: clearance.evidence_verification_ids, age_check: clearance.age_check, du_message_id: cond.du_message_id, reason: i.notes ?? "auto_clear_rule" }, i.at, actor);
  return { condition, clearance, event };
}
/** Contradictory information, a document expired under B1-1-03 before the note date, or a DU resubmission that changed the requirement: `cleared` → `reopened` (any role incl. `qc_officer`). */
export function reopenCondition(events: EventStore, cond: Condition, i: { reason: string; at: string }, actor: Actor = AGENT): { condition: Condition; event: DomainEvent } {
  nonEmpty(i.reason, "reason"); need(cond.status === "cleared" || cond.status === "waived", `${cond.condition_id} is ${cond.status}, not cleared`);
  const condition: Condition = { ...cond, status: "reopened", cleared_at: null, cleared_by: null };
  return { condition, event: emit(events, cond.application_id, "condition.reopened", { condition_id: cond.condition_id, template_code: cond.template_code, stage: cond.stage, reason: i.reason, reopened_by: `${actor.kind}:${actor.id}`, prior_status: cond.status }, i.at, actor) };
}
const ELIGIBILITY_CATEGORIES: readonly Condition["category"][] = ["program", "compliance", "project", "property"];
/** Waivers: only `underwriting_reviewer`; never a DU verification message (A2-2-04 requires resolution) or a Fannie Mae eligibility item; only SM-added conditions, with a recorded reason. */
export function waiveCondition(events: EventStore, cond: Condition, i: { reason: string; at: string }, actor: Actor): { condition: Condition; event: DomainEvent } {
  if (cond.source === "du" || cond.du_message_id !== null) throw new DecisionRefused("WAIVER_NOT_PERMITTED_DU_MESSAGE", "23.3 condition lifecycle / A2-2-04: all Verification Messages / Approval Conditions must be satisfactorily resolved — a DU verification message is never waived", `${cond.condition_id} (${cond.template_code}) is a DU message condition`);
  if (ELIGIBILITY_CATEGORIES.includes(cond.category) || /ELIGIB/i.test(cond.template_code)) throw new DecisionRefused("WAIVER_NOT_PERMITTED_ELIGIBILITY", "23.3 guardrails: never waive a Fannie Mae eligibility item", `${cond.condition_id} is an eligibility item (${cond.category})`);
  if (!isReviewer(actor)) throw new DecisionRefused("WAIVER_NEEDS_UNDERWRITING_REVIEWER", "23.3 automation class (b): condition waivers require `underwriting_reviewer`", `actor ${actor.kind}:${actor.id}`);
  nonEmpty(i.reason, "reason"); need(cond.status === "open" || cond.status === "satisfied_pending_review" || cond.status === "reopened" || cond.status === "waiting_borrower" || cond.status === "waiting_third_party", `${cond.condition_id} is ${cond.status}`);
  const condition: Condition = { ...cond, status: "waived", cleared_at: i.at, cleared_by: actor.id };
  return { condition, event: emit(events, cond.application_id, "condition.waived", { condition_id: cond.condition_id, template_code: cond.template_code, stage: cond.stage, source: cond.source, reason: i.reason, waived_by: actor.id, waived_by_role: "underwriting_reviewer" }, i.at, actor) };
}

// ============================================================ rule 4 — PTD / PTF and the gates
export interface QcHold { readonly hold_id: string; readonly kind: "prefunding"; readonly applied_at: string; readonly released_at: string | null; }
export interface StageStatus { readonly cleared: boolean; readonly blocking_codes: readonly string[]; readonly reasons: readonly string[]; }
/** `ptd_cleared`: every PTD condition cleared/waived/superseded, no open red-flag investigation (closed only with rationale), no open prefunding hold. */
export function ptdStatus(conditions: readonly Condition[], investigations: readonly Investigation23[], holds: readonly QcHold[] = []): StageStatus {
  const b = ctcBlockers(conditions, investigations);
  const codes = [...b.blocking_codes], reasons = [...b.reasons];
  const open = holds.filter((h) => h.kind === "prefunding" && h.released_at === null);
  if (open.length) { codes.push("CTC_QC_PREFUNDING"); reasons.push(`${open.length} prefunding QC hold(s) open (28.1 qc.hold.applied without qc.hold.released)`); }
  return { cleared: codes.length === 0, blocking_codes: codes, reasons };
}
export function recordPtdCleared(events: EventStore, application_id: string, s: StageStatus, at: string, actor: Actor = AGENT): DomainEvent {
  if (!s.cleared) throw new DecisionRefused("PTD_NOT_CLEARED", "23.3 state machine: `ptd_cleared` requires all PTD conditions cleared, no open investigations, no QC hold", s.blocking_codes.join(", "));
  return emit(events, application_id, "ptd.cleared", { blocking_codes: [], stage: "ptd", gate: "SM_UW_PTD_CLEARED_GATE" }, at, actor);
}
export interface GateResult { readonly open: boolean; readonly blocking_codes: readonly string[]; readonly reason: string | null; }
/** SM_UW_PTD_CLEARED_GATE (blocks `issueCD`, `generateClosingDocs`): `ptd.cleared` and 23.1's FNMA_B3_2_10_DU_FINAL_MATCH_GATE open. */
export function ptdClearedGate(f: { ptd_cleared: boolean; blocking_codes: readonly string[]; final_match_gate_open: boolean; command?: string }): GateResult {
  const codes = f.ptd_cleared ? [] : f.blocking_codes.length ? [...f.blocking_codes] : ["CTC_PTD_ALL_CLEARED"];
  if (!f.final_match_gate_open) codes.push("CTC_DU_FINAL_MATCH");
  return { open: codes.length === 0, blocking_codes: codes, reason: codes.length ? `SM_UW_PTD_CLEARED_GATE blocks ${f.command ?? "issueCD"}: ${codes.join(", ")}` : null };
}
export const PTF_REQUIREMENTS = ["vvoe_within_10bd", "credit_refresh_gate_open", "insurance_effective_on_or_before_disbursement", "executed_documents_reviewed", "property_data_submitted_before_note_date", "rescission_expired_or_na", "funding_conditions_cleared"] as const;
export type PtfRequirement = (typeof PTF_REQUIREMENTS)[number];
/** PTF: VVOE ≤ 10 BD before the note date (22.3), pre-closing credit refresh (22.2), insurance effective on/before disbursement (24.5), executed closing documents review, VA+PD before the note date (24.1), rescission expiry (25.3), funding conditions (26.3). */
export function ptfStatus(conditions: readonly Condition[], facts: Partial<Record<PtfRequirement, boolean>>): StageStatus {
  const codes: string[] = [], reasons: string[] = [];
  const live = liveConditions(conditions).filter((c) => c.stage === "ptf");
  if (live.length) { codes.push("PTF_CONDITIONS_OPEN"); reasons.push(`${live.length} PTF condition(s) open: ${live.map((c) => c.template_code).join(", ")}`); }
  for (const r of PTF_REQUIREMENTS) if (facts[r] !== true) { codes.push(`PTF_${r.toUpperCase()}`); reasons.push(`${r} not satisfied`); }
  return { cleared: codes.length === 0, blocking_codes: codes, reasons };
}
export function recordPtfCleared(events: EventStore, d: CreditDecision, s: StageStatus, at: string, actor: Actor = AGENT): { decision: CreditDecision; event: DomainEvent } {
  if (!s.cleared) throw new DecisionRefused("PTF_NOT_CLEARED", "23.3 state machine: `ptf_cleared` requires every PTF condition cleared", s.blocking_codes.join(", "));
  need(d.ctc_at !== null, "ptf_cleared follows clear_to_close");
  return { decision: { ...d, ptf_cleared_at: at }, event: emit(events, d.application_id, "ptf.cleared", { decision_id: d.decision_id, stage: "ptf", gate: "SM_UW_PTF_CLEARED_GATE", hand_off: "26.3 funding.authorized" }, at, actor) };
}
/** SM_UW_PTF_CLEARED_GATE (blocks `authorizeFunding`): `ptf.cleared`; `funding_approver` cannot release. */
export function ptfClearedGate(f: { ptf_cleared: boolean; blocking_codes?: readonly string[]; command?: string }): GateResult {
  const codes = f.ptf_cleared ? [] : f.blocking_codes?.length ? [...f.blocking_codes] : ["PTF_NOT_CLEARED"];
  return { open: codes.length === 0, blocking_codes: codes, reason: codes.length ? `SM_UW_PTF_CLEARED_GATE blocks ${f.command ?? "authorizeFunding"}: ${codes.join(", ")} — funding_approver cannot release` : null };
}

// ============================================================ rule 5 — clear-to-close checklist
export type PrefundingReviewStatus = "open" | "defect_open" | "closed_no_defect" | "closed_defect_corrected" | "unable_to_complete";
/** 28.1's FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE as 23.3 asserts it: open iff no prefunding review was opened or `qc_reviews.status ∈ {closed{no_defect, defect_corrected}, unable_to_complete}`. */
export function prefundingQcGate(f: { review_status: PrefundingReviewStatus | null; command?: string }): GateResult {
  const s = f.review_status;
  const open = s === null || s === "closed_no_defect" || s === "closed_defect_corrected" || s === "unable_to_complete";
  return { open, blocking_codes: open ? [] : [SM_QC_PREFUNDING_HOLD], reason: open ? null : `FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE blocks ${f.command ?? "clear_to_close"}: prefunding QC review ${s} — "corrections… prior to loan closing" (D1-2-01)` };
}
/** The review status the 28.1 events on the application imply (`qc.review.opened{kind=prefunding}` … `qc.review.closed{outcome}`). */
export function prefundingReviewStatus(events: readonly DomainEvent[]): PrefundingReviewStatus | null {
  let status: PrefundingReviewStatus | null = null;
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "qc.review.opened" && p.kind === "prefunding") status = "open";
    else if (e.type === "qc.review.closed" && status !== null) status = p.outcome === "unable_to_complete" ? "unable_to_complete" : p.defects_open === true ? "defect_open" : p.outcome === "defect_corrected" ? "closed_defect_corrected" : "closed_no_defect";
    else if (e.type === "qc.hold.applied" && p.kind === "prefunding") status = "defect_open";
    else if (e.type === "qc.hold.released" && status === "defect_open") status = "closed_defect_corrected";
  }
  return status;
}
export type CtcFacts = Partial<Record<CtcItemCode, { status: CtcItemStatus; evidence_ref?: string | null }>>;
export interface CtcInput { readonly application_id: string; readonly decision_id: string; readonly evaluated_at: string; readonly facts: CtcFacts; readonly prefunding_review_status?: PrefundingReviewStatus | null; readonly waived_by?: Actor | null; readonly checklist_id?: string; }
/** CTC is issued when every item is `pass` or `n/a`; `waived` items require `underwriting_reviewer`; an unevaluated item fails; `CTC_REGB_TIMING` never blocks. */
export function runCtcChecklist(i: CtcInput): CtcChecklist {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.decision_id, "decision_id"); nonEmpty(i.evaluated_at, "evaluated_at");
  const reviewerWaiver = i.waived_by ? isReviewer(i.waived_by) : false;
  const items: CtcItem[] = CTC_ITEM_CODES.map((code) => {
    let f = i.facts[code] ?? null;
    if (code === "CTC_QC_PREFUNDING" && i.prefunding_review_status !== undefined) { const g = prefundingQcGate({ review_status: i.prefunding_review_status }); f = { status: g.open ? "pass" : "fail", evidence_ref: `${SM_QC_PREFUNDING_HOLD}:${i.prefunding_review_status ?? "no_review"}` }; }
    const status: CtcItemStatus = f ? f.status : "fail";
    const blocking = !CTC_INFORMATIONAL.includes(code) && !(status === "pass" || status === "n/a" || (status === "waived" && reviewerWaiver));
    return { code, owner_process: CTC_OWNERS[code], status, evidence_ref: f?.evidence_ref ?? (f ? null : "not_evaluated"), item_alias: code === "CTC_QC_PREFUNDING" ? SM_QC_PREFUNDING_HOLD : null, blocking };
  });
  const blocking_codes = items.filter((x) => x.blocking).map((x) => x.code);
  return { checklist_id: i.checklist_id ?? `ctc:${i.application_id}:${i.evaluated_at}`, application_id: i.application_id, decision_id: i.decision_id, evaluated_at: i.evaluated_at, items, passed: blocking_codes.length === 0, blocking_codes, waived_by: reviewerWaiver ? i.waived_by!.id : null };
}
/** Guardrail: never issue CTC with a failing checklist item; the decision must be `active` (a reopened decision is re-issued first). */
export function issueClearToClose(events: EventStore, d: CreditDecision, c: CtcChecklist, at: string, actor: Actor = AGENT): { decision: CreditDecision; event: DomainEvent } {
  need(c.decision_id === d.decision_id, "checklist belongs to another decision");
  if (!c.passed) throw new DecisionRefused("CTC_CHECKLIST_FAILING", "23.3 guardrails: never issue CTC with a failing checklist item", `blocking: ${c.blocking_codes.join(", ")}`);
  if (d.status !== "active") throw new DecisionRefused("DECISION_NOT_ACTIVE", "23.3 state machine: a reopened / superseded decision returns to `underwriting_pending` and is re-issued before CTC", `decision ${d.decision_id} is ${d.status}`);
  const decision: CreditDecision = { ...d, ctc_at: at, ctc_checklist_id: c.checklist_id };
  return { decision, event: emit(events, d.application_id, "clear_to_close.issued", { decision_id: d.decision_id, checklist_id: c.checklist_id, passed: true, ctc_at: at, evaluated_at: c.evaluated_at, items: c.items.map((x) => ({ code: x.code, status: x.status })), gate: "SM_UW_CTC_GATE", hand_offs: ["26.1 generateClosingDocs", "26.3 authorizeFunding after ptf.cleared"] }, at, actor) };
}
/** Minutes from the last blocking evidence to CTC issuance — "issues CTC the moment it passes" (T4: ≤ 60 minutes). */
export const ctcLatencyMinutes = (evidence_at: string, ctc_at: string): number => Math.round((Date.parse(ctc_at) - Date.parse(evidence_at)) / 60_000);
/** SM_UW_CTC_GATE (blocks `consummate`, `closing.scheduled` confirmation): `clear_to_close.issued` with `ctc_checklists.passed` on an `active` decision. */
export function ctcGate(f: { ctc_issued: boolean; checklist_passed: boolean; decision_status: DecisionStatus | string; command?: string }): GateResult {
  const codes: string[] = [];
  if (!f.ctc_issued) codes.push("CTC_NOT_ISSUED");
  if (!f.checklist_passed) codes.push("CTC_CHECKLIST_FAILING");
  if (f.decision_status !== "active") codes.push(`DECISION_${String(f.decision_status).toUpperCase()}`);
  return { open: codes.length === 0, blocking_codes: codes, reason: codes.length ? `SM_UW_CTC_GATE blocks ${f.command ?? "consummate"}: ${codes.join(", ")} — re-issue the decision and CTC` : null };
}

// ============================================================ reopened decisions (state machine; worked example 2)
export type ReopenCause = "contradictory_information" | "worse_du_recommendation" | "valid_until_expired" | "compliance_test_failed" | "prefunding_qc_defect" | "ineligible_change";
export interface ReopenInput { readonly cause: ReopenCause; readonly at: string; readonly today: PlainDate; readonly consummation_date: PlainDate | null; readonly detail?: Record<string, unknown>; readonly calendar?: Calendar; }
/** `decision.reopened`; inside 3 `business_days_creditor` of consummation the `underwriting_reviewer` escalation carries a same-business-day SLA, otherwise 1 BD. */
export function reopenDecision(events: EventStore, escalations: EscalationService, d: CreditDecision, i: ReopenInput, actor: Actor = AGENT): { decision: CreditDecision; escalation: Escalation; sla: "same_business_day" | "1_business_day"; sla_due_on: PlainDate; event: DomainEvent } {
  need(d.status === "active", `decision ${d.decision_id} is ${d.status}`);
  const cal = i.calendar ?? creditor;
  const bdToClosing = i.consummation_date ? businessDaysBetween(i.today, i.consummation_date, cal) : null;
  const near = bdToClosing !== null && bdToClosing < REOPEN_REVIEWER_WINDOW_BD;
  const sla = near ? "same_business_day" : "1_business_day"; const sla_due_on = near ? i.today : addBusinessDays(i.today, 1, cal);
  const escalation = escalations.open({ kind: "underwriting_reviewer", applicationId: d.application_id, severity: near ? "sev2" : "sev3", payload: { decision_id: d.decision_id, cause: i.cause, sla, sla_due_on, consummation_date: i.consummation_date, business_days_to_closing: bdToClosing, detail: i.detail ?? {}, gate: "SM_UW_CTC_GATE", options: ["cure (PTF condition with evidence; recompute)", "move the closing", "reviewer-approved denial via 21.6"] } }, actor);
  const decision: CreditDecision = { ...d, status: "reopened", reopen_cause: i.cause, ctc_at: null, ctc_checklist_id: null };
  const event = emit(events, d.application_id, "decision.reopened", { decision_id: d.decision_id, cause: i.cause, reopened_on: i.today, consummation_date: i.consummation_date, business_days_to_closing: bdToClosing, reviewer_required: true, sla, sla_due_on, escalation_id: escalation.id, ctc_revoked: d.ctc_at !== null, detail: i.detail ?? {}, next_state: "underwriting_pending" }, i.at, actor);
  return { decision, escalation, sla, sla_due_on, event };
}
/** A re-issued decision supersedes the reopened one (`decision.superseded`); the new record is issued through issueConditionalApproval. */
export function supersedeDecision(events: EventStore, d: CreditDecision, by_decision_id: string, at: string, actor: Actor = AGENT): { decision: CreditDecision; event: DomainEvent } {
  nonEmpty(by_decision_id, "by_decision_id");
  return { decision: { ...d, status: "superseded" }, event: emit(events, d.application_id, "decision.superseded", { decision_id: d.decision_id, superseded_by: by_decision_id, prior_status: d.status }, at, actor) };
}
/** SM_UW_DECISION_VALIDITY breach: `valid_until` passed without consummation → reopen with the expired component named. */
export function validityExpired(d: CreditDecision, today: PlainDate): { expired: boolean; component: string } { return { expired: today > d.valid_until, component: d.validity_component }; }

// ============================================================ rule 6 — denials and counteroffers (prepared by the agent, decided by the reviewer, notified by 21.6)
export interface AdverseReason { readonly code: string; readonly text: string; readonly principal: boolean; readonly source_fact: string; readonly threshold?: string | null; readonly observed?: string | null; }
export interface AdverseDecisionRecord {
  readonly decision_id: string; readonly application_id: string; readonly kind: "denial" | "counteroffer"; readonly reasons: readonly AdverseReason[]; readonly factors: readonly DecisionFactor[]; readonly counteroffer_terms: CounterofferTerms | null; readonly du_recommendation: "approve_eligible" | "approve_ineligible" | "refer_with_caution" | "out_of_scope" | "error" | null;
  readonly inputs_hash: string; readonly rule_set_versions: typeof RULE_SETS_23_3; readonly model_version: string; readonly prompt_version: string; readonly rationale: string; readonly confidence: number; readonly prepared_at: string;
  readonly reviewer_id: string | null; readonly reviewer_action: ReviewerAction; readonly reviewer_at: string | null; readonly reviewer_notes: string | null; readonly regb_handoff_at: string | null; readonly escalation_id: string | null;
}
const SOURCE_FACT_RE = /^[\w.\-/:=#@ ]+$/;
/** §1002.9(b)(2)-grade reasons from the underlying facts — 21.6's prohibited patterns refuse "DU", "Refer with Caution", score cutoffs and "internal standards"; every reason cites its `source_fact`. */
export function prepareAdverseDecision(events: EventStore, escalations: EscalationService, i: Omit<AdverseDecisionRecord, "factors" | "rule_set_versions" | "prepared_at" | "reviewer_id" | "reviewer_action" | "reviewer_at" | "reviewer_notes" | "regb_handoff_at" | "escalation_id"> & { at: string; sla_due_on: PlainDate }, actor: Actor = AGENT): { record: AdverseDecisionRecord; escalation: Escalation; event: DomainEvent } {
  nonEmpty(i.decision_id, "decision_id"); nonEmpty(i.application_id, "application_id"); need(i.reasons.length > 0, "at least one specific reason (§1002.9(b)(2))");
  if (i.kind === "counteroffer") need(i.counteroffer_terms !== null, "a counteroffer carries the offered terms");
  for (const r of i.reasons) {
    nonEmpty(r.text, "reason text"); nonEmpty(r.code, "reason code");
    if (!r.source_fact || !SOURCE_FACT_RE.test(r.source_fact)) throw new DecisionRefused("REASON_WITHOUT_SOURCE_FACT", "23.3 AI design: `reasons[].source_fact` cites the underlying fact for every reason", `reason "${r.text}" has no source_fact`);
    try { assertReasonText(r.text); } catch (e) { throw new DecisionRefused("REASON_TEXT_NOT_PERMISSIBLE", "23.3 guardrails / §1002.9(b)(2): never state DU, a score cutoff or \"internal standards\" as a reason", (e as Error).message); }
  }
  assertNoDemographics(i.reasons);
  const factors: DecisionFactor[] = i.reasons.map((r) => ({ rule_id: r.code, description: r.text, threshold: r.threshold ?? null, observed: r.observed ?? null, applicant_ids: [], evidence_document_ids: [], failed: true, reason_code: r.code, source: "rules" as const }));
  const escalation = escalations.open({ kind: "underwriting_reviewer", applicationId: i.application_id, severity: "sev3", payload: { decision_id: i.decision_id, kind: i.kind, reasons: i.reasons.map((r) => r.text), sla_due_on: i.sla_due_on, sla: "1 business_days_creditor", counteroffer_terms: i.counteroffer_terms } }, actor);
  const record: AdverseDecisionRecord = { ...i, factors, rule_set_versions: RULE_SETS_23_3, prepared_at: i.at, reviewer_id: null, reviewer_action: null, reviewer_at: null, reviewer_notes: null, regb_handoff_at: null, escalation_id: escalation.id };
  const event = emit(events, i.application_id, "adverse_decision.prepared", { decision_id: i.decision_id, kind: i.kind, reasons: i.reasons.map((r) => ({ code: r.code, principal: r.principal, source_fact: r.source_fact })), reviewer_required: true, escalation_id: escalation.id, sla_due_on: i.sla_due_on, regb_invoked: false }, i.at, actor);
  return { record, escalation, event };
}
/** The reviewer approves, modifies or rejects; reasons are frozen after approval (guardrail "never alter the reasons after reviewer approval"). */
export function reviewAdverseDecision(events: EventStore, escalations: EscalationService, rec: AdverseDecisionRecord, i: { action: Exclude<ReviewerAction, null>; reviewer: Actor; at: string; notes?: string | null; reasons?: readonly AdverseReason[] }): { record: AdverseDecisionRecord; event: DomainEvent } {
  if (!isReviewer(i.reviewer)) throw new DecisionRefused("ADVERSE_NEEDS_UNDERWRITING_REVIEWER", "23.3 guardrails: never issue a denial, counteroffer or NOIA without `underwriting_reviewer`", `actor ${i.reviewer.kind}:${i.reviewer.id}`);
  if (rec.reviewer_action === "approved") throw new DecisionRefused("REASONS_FROZEN_AFTER_APPROVAL", "23.3 guardrails: never alter the reasons after reviewer approval", `decision ${rec.decision_id} was approved at ${rec.reviewer_at}`);
  if (i.reasons && i.action !== "modified") throw new DecisionRefused("REASONS_CHANGE_NEEDS_MODIFIED", "23.3 rule 6: the reviewer approves, modifies or rejects — changed reasons are a `modified` action", "pass action=modified with the new reasons");
  const reasons = i.reasons ?? rec.reasons; for (const r of reasons) assertReasonText(r.text);
  if (rec.escalation_id) escalations.complete(rec.escalation_id, i.reviewer);
  const factors: DecisionFactor[] = reasons.map((r) => ({ rule_id: r.code, description: r.text, threshold: r.threshold ?? null, observed: r.observed ?? null, applicant_ids: [], evidence_document_ids: [], failed: true, reason_code: r.code, source: "rules" as const }));
  const record: AdverseDecisionRecord = { ...rec, reasons, factors, reviewer_id: i.reviewer.id, reviewer_action: i.action === "modified" ? "approved" : i.action, reviewer_at: i.at, reviewer_notes: i.notes ?? (i.action === "modified" ? "modified by reviewer" : null) };
  return { record, event: emit(events, rec.application_id, "adverse_decision.reviewed", { decision_id: rec.decision_id, kind: rec.kind, action: i.action, reviewer_id: i.reviewer.id, reasons_changed: i.reasons !== undefined }, i.at, i.reviewer) };
}
/** Only after `reviewer_action = approved` is 21.6 invoked: recommendDisposition (the decisions row + `decision.recommended`) and reviewDecision by the same named reviewer; 21.6 then renders the notice, records adverse_actions and HMDA. */
export function handOffToRegB(events: EventStore, escalations: EscalationService, file: DecisionFile, rec: AdverseDecisionRecord, at: string, actor: Actor = AGENT): { file: DecisionFile; decision: DecisionRow; record: AdverseDecisionRecord; events: DomainEvent[] } {
  if (rec.reviewer_action !== "approved") throw new DecisionRefused("ADVERSE_NEEDS_REVIEWER_APPROVAL", "23.3-T6: 21.6 is not invoked until `reviewer_action = approved`", `decision ${rec.decision_id} reviewer_action=${String(rec.reviewer_action)}`);
  const r = recommendDisposition(events, escalations, file, { decision_id: rec.decision_id, factors: rec.factors, du_recommendation: rec.du_recommendation, data_verified_and_resubmitted: true, counteroffer_terms: rec.counteroffer_terms, at, basis_component: "rules" });
  const reviewer: Actor = { kind: "human", id: rec.reviewer_id!, role: "underwriting_reviewer" };
  const v = reviewDecision(events, escalations, r.file, { decision_id: rec.decision_id, outcome: "approved", reviewer, at, notes: rec.reviewer_notes });
  const handed = emit(events, file.application_id, "adverse_decision.handed_off", { decision_id: rec.decision_id, kind: rec.kind, reviewer_id: rec.reviewer_id, to: "21.6", reasons: rec.reasons.map((x) => x.code) }, at, actor);
  return { file: v.file, decision: v.decision, record: { ...rec, regb_handoff_at: at }, events: [r.event, v.event, handed] };
}
/** T7 / worked example 3: a counteroffer neither accepted nor used expires under 21.6's REGB_1002_9_COUNTEROFFER_90 (sent + 90 days); the combined C-4 notice needs no second adverse-action notice (comment 9(a)(1)-6). */
export function counterofferExpiry(i: { sent_on: PlainDate; combined_notice: boolean }): { expires_on: PlainDate; second_notice_required: boolean; timer: "REGB_1002_9_COUNTEROFFER_90" } {
  const c = counterofferClock(i.sent_on, null);
  return { expires_on: c.adverse_notice_due_on, second_notice_required: !i.combined_notice, timer: "REGB_1002_9_COUNTEROFFER_90" };
}
/** 23.2's proposal row flips to `expired` when the 90-day clock runs out. */
export function expireCounterofferProposal(events: EventStore, p: RestructureProposal, at: string, actor: Actor = AGENT): { proposal: RestructureProposal; event: DomainEvent } { return expireRestructure(events, p, at, actor); }

// ============================================================ rule 7 — rep-and-warrant relief ledger (A2-2-04, A2-2-06, A2-3.2-02, SEL-2025-09)
export interface ReliefFacts {
  readonly recommendation: "approve_eligible" | "approve_ineligible" | "refer_with_caution" | "out_of_scope" | "error"; readonly all_messages_resolved: boolean; readonly sfc_127: boolean; readonly data_accurate: boolean;
  readonly validated: { readonly income?: { close_by_date: PlainDate | null } | null; readonly employment?: { close_by_date: PlainDate } | null; readonly assets?: { close_by_date: PlainDate | null } | null };
  readonly undisclosed_debt_message: boolean; readonly credit_expiration_date: PlainDate | null;
  readonly income_calculator: { report_in_file: boolean; qualifying_income_cents: Cents; tool_income_cents: Cents } | null;
  readonly value_acceptance: { offer_on_final_submission: boolean; offer_date: PlainDate; sfc: "801" | "774" | null } | null; readonly cu_score: number | null; readonly units: 1 | 2 | 3 | 4;
}
export interface ReliefContext { readonly application_id: string; readonly stage: "ctc" | "funding"; readonly closing_date: PlainDate | null; readonly as_of: PlainDate; readonly evaluated_at: string; }
const VALUE_ACCEPTANCE_OFFER_MONTHS = 4;
/** Per component: eligible while the closing is on/before the relief's date; `at_risk` when a scheduled closing moves past it; `lost` once the date passes (or the loan closed after it) without a new validation. */
export function reliefStatus(conditions_met: boolean, relief_date: PlainDate | null, c: ReliefContext): ReliefStatus {
  if (!conditions_met) return "lost";
  if (!relief_date) return "eligible";
  if (c.closing_date && c.closing_date > relief_date) return c.as_of >= c.closing_date || c.as_of > relief_date ? "lost" : "at_risk";
  return c.as_of > relief_date && !c.closing_date ? "lost" : "eligible";
}
export function evaluateReliefLedger(f: ReliefFacts, c: ReliefContext): ReliefEntry[] {
  nonEmpty(c.application_id, "application_id");
  const row = (component: ReliefComponent, basis_ref: string, applies: boolean, conditions_met: boolean, relief_date: PlainDate | null, notes: string, o: { close_by?: PlainDate | null; credit_exp?: PlainDate | null } = {}): ReliefEntry => ({
    relief_id: `rwr:${c.application_id}:${component}`, application_id: c.application_id, loan_id: null, component, basis_ref, conditions_met: applies && conditions_met, close_by_date: o.close_by ?? null, credit_expiration_date: o.credit_exp ?? null,
    status: applies ? reliefStatus(conditions_met, relief_date, c) : "not_applicable", target_date: null, evaluated_at: c.evaluated_at, confirmed_at: null, notes });
  const lw = f.recommendation === "approve_eligible" && f.all_messages_resolved && f.sfc_127 && f.data_accurate;
  const out: ReliefEntry[] = [row("limited_waiver_du", "A2-2-04 limited waiver", true, lw, null, lw ? "Approve/Eligible; all verification messages resolved; SFC 127; data complete, accurate and not fraudulent" : "excluded: Approve/Ineligible, Refer with Caution, unresolved messages or inaccurate data")];
  for (const [component, basis, v] of [["income_validated", "A2-2-04 Day 1 Certainty — income", f.validated.income], ["employment_validated", "A2-2-04 Day 1 Certainty — employment", f.validated.employment], ["assets_validated", "A2-2-04 Day 1 Certainty — assets", f.validated.assets]] as const)
    out.push(row(component, basis, !!v, !!v, v?.close_by_date ?? null, v ? `DU message: validated; loan must close by ${v.close_by_date ?? "n/a"}` : "not validated by DU", { close_by: v?.close_by_date ?? null }));
  out.push(row("undisclosed_debt", "SEL-2025-09 undisclosed non-mortgage debt", f.undisclosed_debt_message, f.undisclosed_debt_message && f.all_messages_resolved, f.credit_expiration_date, "excludes mortgage-related debt (HELOCs, second liens); close by the credit report expiration date", { credit_exp: f.credit_expiration_date }));
  const ic = f.income_calculator;
  out.push(row("income_calculator", "A2-2-04 Income Calculator", ic !== null, ic !== null && ic.report_in_file && ic.qualifying_income_cents <= ic.tool_income_cents, null, ic ? (ic.qualifying_income_cents <= ic.tool_income_cents ? "findings report in file; qualifying income ≤ tool amount" : "qualifying income exceeds the tool amount — relief lost") : "not used"));
  const va = f.value_acceptance;
  out.push(row("value_acceptance", "A2-2-06 value acceptance", va !== null, va !== null && va.offer_on_final_submission && va.sfc !== null, va ? addMonths(va.offer_date, VALUE_ACCEPTANCE_OFFER_MONTHS) : null, va ? `offer ${va.offer_date} on the final submission; SFC ${va.sfc ?? "missing"}; offer age ≤ 4 months at the note date` : "no offer exercised"));
  out.push(row("cu_score_2_5", "A2-2-06 CU risk score ≤ 2.5", va === null && f.cu_score !== null, f.cu_score !== null && f.cu_score <= 2.5 && f.units === 1, null, f.cu_score !== null ? `CU ${f.cu_score} on a ${f.units}-unit property` : "no appraisal / CU score"));
  return out;
}
export function recordReliefLedger(events: EventStore, entries: readonly ReliefEntry[], c: ReliefContext, actor: Actor = AGENT): DomainEvent {
  return emit(events, c.application_id, "rep_warrant_relief.evaluated", { stage: c.stage, closing_date: c.closing_date, as_of: c.as_of, components: entries.map((e) => ({ component: e.component, status: e.status, close_by_date: e.close_by_date, credit_expiration_date: e.credit_expiration_date, basis_ref: e.basis_ref })), consumers: ["29.3", "29.4", "28.2"] }, c.evaluated_at, actor);
}
export const VVOE_PTF_TEMPLATE = "COND_SM_VVOE_PTF";
/** T9: the closing slipped past the employment Close by Date without a new validation → `lost`, 22.3's close-by reassessment (cure options; `rep_warrant_relief.updated`) and a PTF VVOE condition. */
export function loseEmploymentRelief(events: EventStore, entry: ReliefEntry, i: { borrower_id: string; report_reference_id: string; scheduled_note_date: PlainDate; at: string; calendar?: Calendar }, actor: Actor = AGENT): { entry: ReliefEntry; condition: Condition; events: DomainEvent[] } {
  need(entry.component === "employment_validated" && entry.close_by_date !== null, "an employment_validated entry with a close_by_date");
  const r = reassessCloseBy(events, { application_id: entry.application_id, borrower_id: i.borrower_id, close_by_date: entry.close_by_date!, scheduled_note_date: i.scheduled_note_date, report_reference_id: i.report_reference_id, ...(i.calendar ? { calendar: i.calendar } : {}) }, actor);
  need(r.breached, `scheduled note date ${i.scheduled_note_date} is within the Close by Date ${entry.close_by_date}`);
  const c = openCondition(events, { application_id: entry.application_id, submission_id: null, template_code: VVOE_PTF_TEMPLATE, category: "employment", stage: "ptf", source: "underwriter", borrower_id: i.borrower_id, evidence_kinds: ["vvoe_record"], auto_clear_rule: "B3-3.1-04/DU:vvoe_10bd",
    text: "Your lender will confirm your current employment with your employer within the ten business days before closing.", internal_text: `VVOE within 10 business days before the note date ${i.scheduled_note_date} (window ${r.vvoe_window?.window_start ?? "?"} – ${i.scheduled_note_date}); employment validation relief lost (close by ${entry.close_by_date})`, opened_at: i.at, borrower_visible: true }, actor);
  const lost: ReliefEntry = { ...entry, status: "lost", evaluated_at: i.at, notes: `${entry.notes}; closing ${i.scheduled_note_date} after the Close by Date without a new validation — relief lost; PTF VVOE condition ${c.condition.condition_id}` };
  return { entry: lost, condition: c.condition, events: [...r.events, c.event] };
}
/** T11: at purchase the 36-payment component opens (A2-3.2-02): target = the 36th monthly payment due date; `eligible` pending Fannie Mae's relief report (28.2/30.4). */
export function openPaymentHistoryRelief(events: EventStore, i: { application_id: string; loan_id: string; purchase_date: PlainDate; first_payment_due: PlainDate; at: string }, actor: Actor = AGENT): { entry: ReliefEntry; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.loan_id, "loan_id"); need(i.first_payment_due > i.purchase_date, "first payment due follows the purchase date");
  const target_date = addMonths(i.first_payment_due, PAYMENT_HISTORY_RELIEF_PAYMENTS - 1);
  const entry: ReliefEntry = { relief_id: `rwr:${i.application_id}:payment_history_36`, application_id: i.application_id, loan_id: i.loan_id, component: "payment_history_36", basis_ref: "A2-3.2-02", conditions_met: true, close_by_date: null, credit_expiration_date: null, status: "eligible", target_date, evaluated_at: i.at, confirmed_at: null,
    notes: `first 36 monthly payments due following the loan acquisition date ${i.purchase_date} (first due ${i.first_payment_due}, 36th due ${target_date}); no more than two 30-day and no 60-day delinquencies; confirmed only by Fannie Mae's relief report (28.2/30.4)` };
  const event = emit(events, i.application_id, "rep_warrant_relief.evaluated", { stage: "purchase", loan_id: i.loan_id, components: [{ component: "payment_history_36", status: "eligible", target_date, purchase_date: i.purchase_date, first_payment_due: i.first_payment_due }], consumers: ["28.2", "30.4"] }, i.at, actor);
  return { entry, event };
}

// ============================================================ decision record (LL-2026-04; Colorado SB 26-189 records; §1002.12 retention)
export interface DecisionRecord23_3 {
  readonly decision_id: string; readonly application_id: string; readonly kind: string; readonly inputs_hash: string; readonly du: { casefile_id: string | null; submission_number: number | null; recommendation: string | null; policy_generation: string | null; findings_hash: string | null };
  readonly evidence: readonly { document_id: string; kind: string; age_check: AgeCheck | null }[]; readonly risk_assessment: RiskAssessment | null; readonly reasons: readonly { code: string; text: string; principal: boolean; source_fact: string }[];
  readonly rule_set_versions: typeof RULE_SETS_23_3; readonly model_version: string; readonly prompt_version: string; readonly confidence: number; readonly reviewer: { id: string | null; action: ReviewerAction; at: string | null; notes: string | null }; readonly outcome: string; readonly notice_id: string | null; readonly rationale: string; readonly retention_class: readonly string[];
}
export function decisionRecord23_3(d: CreditDecision | AdverseDecisionRecord, o: { du: DecisionRecord23_3["du"]; evidence?: readonly { document_id: string; kind: string; age_check?: AgeCheck | null }[]; notice_id?: string | null }): DecisionRecord23_3 {
  const adverse = "reasons" in d;
  const rec: DecisionRecord23_3 = { decision_id: d.decision_id, application_id: d.application_id, kind: d.kind, inputs_hash: d.inputs_hash, du: o.du, evidence: (o.evidence ?? []).map((e) => ({ document_id: e.document_id, kind: e.kind, age_check: e.age_check ?? null })),
    risk_assessment: adverse ? null : (d as CreditDecision).risk_assessment, reasons: adverse ? (d as AdverseDecisionRecord).reasons.map((r) => ({ code: r.code, text: r.text, principal: r.principal, source_fact: r.source_fact })) : [], rule_set_versions: d.rule_set_versions, model_version: d.model_version, prompt_version: d.prompt_version, confidence: d.confidence,
    reviewer: { id: d.reviewer_id, action: d.reviewer_action, at: d.reviewer_at, notes: adverse ? (d as AdverseDecisionRecord).reviewer_notes : null }, outcome: adverse ? (d.reviewer_action === "approved" ? d.kind : `${d.kind}_pending_reviewer`) : (d as CreditDecision).status, notice_id: o.notice_id ?? (adverse ? null : (d as CreditDecision).notice_id), rationale: d.rationale, retention_class: [...RETENTION_CLASSES] };
  assertNoDemographics(rec);
  return rec;
}
