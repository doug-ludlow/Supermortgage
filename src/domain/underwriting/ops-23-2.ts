/**
 * §23.2 — DU findings interpretation, recommendation policy and conditions generation (HomeReady/AMI, homebuyer
 * education, value-acceptance offers, MI messages, red flags). Pure rule functions, one per rule / T-id; the bus tools
 * in src/app/tools/section23-2.ts call them. Spec: spec/sections/23-…/23-2-du-findings-interpretation-….md.
 *
 * Events appended here (every one carries `applicationId` so the 23.2 timers arm under origination context):
 *   du.findings.interpreted{submission_id, recommendation, policy_outcome, conditions_opened, conditions_materialized,
 *                           value_acceptance_offer, sfc_required, mi_coverage_pct}      [satisfies SM_DU_CONDITIONS_SLA_4H]
 *   condition.opened{condition_id, template_code, stage, category, source, du_message_id}  (23.3 consumes)
 *   condition.superseded{condition_id, submission_id, clear_evidence_document_ids}          (evidence retained)
 *   investigation.opened{kind=du_red_flag, red_flag, blocks_ctc}                            (22.6 consumes)
 *   mi.requirement.set{mi_coverage_pct, standard_coverage_pct, condition_id}                (24.6 consumes)
 *   value_acceptance.offer.received{offer, is_final, sfc_801_permitted}                     (24.1 consumes)
 *   homeready.candidate.flagged{source=du_message}, homeready.evaluated{eligible, limit}
 *   homeownership_education.required{basis, closing_date}                                  [arms FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE]
 *   homeownership_education.certificate.received{completed_on, course_type}                [arms FNMA_B5_6_01_COUNSELING_CREDIT_12M]
 *   homeownership_education.verified{borrower_id, counseling_within_12m, sfc_184}          [satisfies both]
 *   restructure.proposed{kind, regb_treatment, expected_dti_bps}, restructure.accepted, restructure.expired
 *   du.recommendation.changed{cause=du_policy, du_release}
 *
 * Reused, never re-implemented: levelPayment / ratePercent (src/kernel/money), dtiBps / dtiDisplayPct and the DU 50 %
 * cap (22.5), BASELINE_LIMITS_2026 / HIGH_COST_CEILING / SFC / ltvX100 (20.4), DU_RELEASES and the 23.1 findings types.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, DomainEvent, Actor } from "../../kernel/events/index.ts";
import { plainDate as D, addMonths, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, type Calendar } from "../../kernel/calendar/business.ts";
import { levelPayment, ratePercent, centsToDecimal, type Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import { dtiBps, dtiDisplayPct, DU_MAX_DTI_BPS } from "../verification/ops-22-5.ts";
import { BASELINE_LIMITS_2026, HIGH_COST_CEILING_1_UNIT_2026, SFC as SFC_20_4, ltvX100 } from "../leads-pricing/ops-20-4.ts";
import { DU_RELEASES, type Recommendation, type DuMessage, type ValidationResult, type PolicyGeneration } from "./ops-23-1.ts";

export const AGENT: Actor = { kind: "agent", id: "underwriter" };
export const RULE_SETS_23_2 = { "fnma.selling": "2026-09-02", "fnma.du": "12.1", "fnma.llpa": "2026-09-09", "fnma.limits": "2026", "fnma.eligibility_matrix": "2026-08-05", "du_message_rules": "2026-09-25" } as const;
export const CURRENT_DU_RELEASE = "2026-09-25";
export const HOMEREADY_AMI_LIMIT_PCT = "80.00";
export const CONDITIONS_SLA_HOURS = 4;
export const EDUCATION_ESCALATION_BUSINESS_DAYS = 3;
export const COUNSELING_CREDIT_MONTHS = 12;
export const SFC_ALWAYS = "127";

export class InterpretationRefused extends Error {
  readonly code: string; readonly citation: string;
  constructor(code: string, citation: string, why: string) { super(`23.2 refused [${code}]: ${why}`); this.name = "InterpretationRefused"; this.code = code; this.citation = citation; }
}
const need = (ok: boolean, why: string): void => { if (!ok) throw new RangeError(why); };
const nonEmpty = (v: unknown, name: string): void => need(typeof v === "string" && v.length > 0, `${name} is required`);
const emit = (events: EventStore, application_id: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor): DomainEvent =>
  events.append({ type, applicationId: application_id, actor, occurredAt: at, payload: { application_id, ...payload } });

// ============================================================ data model (spec "Data model")
export type ConditionSource = "du" | "underwriter" | "qc" | "compliance" | "closing";
export type ConditionStage = "ptd" | "ptf" | "post_closing";
export type ConditionStatus = "open" | "waiting_borrower" | "waiting_third_party" | "satisfied_pending_review" | "cleared" | "waived" | "superseded" | "reopened";
export type ConditionCategory = "income" | "employment" | "assets" | "credit" | "liabilities" | "property" | "project" | "title" | "insurance" | "mi" | "occupancy" | "identity" | "program" | "compliance" | "closing" | "funding";
export type RequiresRole = "underwriting_reviewer" | "qc_officer" | "funding_approver";
export interface Condition {
  readonly condition_id: string; readonly application_id: string; readonly borrower_id: string | null; readonly source: ConditionSource; readonly stage: ConditionStage; readonly status: ConditionStatus;
  readonly template_code: string; readonly du_message_id: string | null; readonly du_submission_id: string | null;
  /** SM-rendered, borrower-safe needs-list wording (rule "Borrower-facing wording"); DU wording lives in `internal_text` only. */
  readonly text: string; readonly internal_text: string; readonly category: ConditionCategory; readonly evidence_kinds: readonly string[]; readonly auto_clear_rule: string | null; readonly requires_role: RequiresRole | null;
  readonly opened_at: string; readonly due_at: string | null; readonly cleared_at: string | null; readonly cleared_by: string | null; readonly clear_evidence_document_ids: readonly string[];
  readonly superseded_by_condition_id: string | null; readonly superseded_by_submission_id: string | null; readonly qc_sampled: boolean; readonly borrower_visible: boolean;
}
export type MessageSection = "summary" | "rep_warrant_relief" | "priority_action" | "verification" | "eligibility" | "potential_red_flag" | "observation" | "validation" | "mi" | "value_acceptance" | "homeready" | "cu" | "sfc";
export type RuleAction = "open_condition" | "open_investigation" | "record_only" | "structural_ineligible" | "offer" | "mi_requirement" | "sfc_required" | "sfc_optional";
export type Severity = "critical" | "standard" | "info";
export type RestructureKind = "loan_amount" | "term" | "product" | "occupancy_correction" | "liability_payoff" | "asset_addition" | "mi_option" | "remove_homeready" | "add_homeready" | "co_borrower_change";
export interface DuMessageRule {
  readonly message_id: string; readonly du_release: string; readonly section: MessageSection; readonly action: RuleAction;
  readonly condition_template_code: string | null; readonly stage: ConditionStage | null; readonly category: ConditionCategory; readonly evidence_kinds: readonly string[]; readonly auto_clear_rule: string | null;
  readonly severity: Severity; readonly effective_from: PlainDate; readonly effective_to: PlainDate | null;
  /** Borrower-safe needs-list wording for open_condition rows (never DU wording, never the message id). */
  readonly borrower_text: string | null;
  /** Structural reason code + lever for eligibility messages; SFC code for sfc rows; red-flag name for PRF rows. */
  readonly reason_code?: string; readonly lever?: RestructureKind; readonly sfc?: string; readonly red_flag?: RedFlag; readonly requires_role?: RequiresRole;
}
export type RedFlag = "frozen_credit" | "casefile_id_reuse" | "excessive_resubmissions" | "occupancy_modified";
export type PolicyOutcome = "proceed" | "restructure_required" | "decline_candidate" | "out_of_policy_manual" | "error";
export type ValueAcceptanceOffer = "none" | "value_acceptance" | "value_acceptance_pd";
export interface DuFindingsInterpretation {
  readonly interpretation_id: string; readonly application_id: string; readonly submission_id: string; readonly submission_number: number; readonly is_final: boolean;
  readonly recommendation: Recommendation; readonly policy_generation: PolicyGeneration; readonly du_release: string; readonly policy_outcome: PolicyOutcome;
  readonly structural_reasons: readonly StructuralReason[]; readonly conditions_opened: number; readonly ptd_conditions_opened: number; readonly investigations_opened: number; readonly unmapped_messages: number;
  readonly mi_coverage_pct: string | null; readonly mi_standard_coverage_pct: string | null; readonly mi_min_coverage_option: boolean;
  readonly value_acceptance_offer: ValueAcceptanceOffer; readonly value_acceptance_offer_at: string | null; readonly sfc_801_permitted: boolean;
  readonly homeready_message: boolean; readonly sfc_required: readonly string[]; readonly close_by_date: PlainDate | null; readonly credit_expiration_date: PlainDate | null;
  readonly relief_components: { readonly income: boolean; readonly employment: boolean; readonly assets: boolean; readonly undisclosed_debt: boolean };
  readonly decline_candidate: boolean; readonly manual_underwriting_offered: false; readonly lawful_paths: readonly ("proceed" | "borrower_accepted_restructure" | "regb_counteroffer" | "regb_denial" | "retry_23_1")[];
  readonly recommendation_drift: RecommendationDrift | null; readonly interpreted_at: string; readonly agent_decision_id: string | null;
}
export interface StructuralReason { readonly message_id: string; readonly reason_code: string; readonly lever: RestructureKind | null; readonly text: string; }
export interface Investigation23 { readonly investigation_id: string; readonly application_id: string; readonly kind: "du_red_flag"; readonly red_flag: RedFlag; readonly message_id: string; readonly submission_id: string; readonly status: "open" | "closed"; readonly rationale: string | null; readonly borrower_visible: false; readonly opened_at: string; readonly closed_at: string | null; }
export interface TriageItem { readonly triage_id: string; readonly application_id: string; readonly submission_id: string; readonly message_id: string; readonly du_release: string; readonly du_text: string; readonly condition_id: string; readonly status: "queued" | "mapped" | "cleared"; readonly queued_at: string; }
export interface HomeReadyEvaluation23 {
  readonly evaluation_id: string; readonly application_id: string; readonly property_fips: string; readonly ami_source: "du_message" | "ami_api" | "web_tool"; readonly ami_annual_cents: Cents; readonly limit_pct: string;
  readonly income_limit_annual_cents: Cents; readonly qualifying_income_annual_cents: Cents; readonly eligible: boolean; readonly ami_dataset_version: string; readonly api_response_document_id: string | null; readonly evaluated_at: string;
}
export type RequirementBasis = "homeready_all_ftb" | "ltv_over_95_all_ftb" | "du_no_tradelines" | "none";
export type ProviderType = "homeview" | "hud_approved_agency" | "nis_aligned_provider";
export interface EducationRecord {
  readonly record_id: string; readonly application_id: string; readonly borrower_id: string; readonly requirement_basis: RequirementBasis; readonly provider_name: string | null; readonly provider_type: ProviderType | null;
  readonly course_type: "education" | "counseling" | null; readonly certificate_document_id: string | null; readonly completed_on: PlainDate | null; readonly verified_at: string | null; readonly counseling_within_12m: boolean;
  readonly status: "required_open" | "received" | "verified" | "not_required";
}
export type RegBTreatment = "borrower_initiated" | "counteroffer" | "none";
export interface RestructureProposal {
  readonly proposal_id: string; readonly application_id: string; readonly trigger_submission_id: string | null; readonly kind: RestructureKind; readonly from: Record<string, unknown>; readonly to: Record<string, unknown>;
  readonly expected_recommendation: Recommendation; readonly expected_dti_bps: number | null; readonly expected_dti_display: string | null; readonly arithmetic: Record<string, unknown>; readonly regb_treatment: RegBTreatment;
  readonly changed_circumstance_id: string | null; readonly status: "proposed" | "accepted" | "rejected" | "expired"; readonly proposed_at: string; readonly decided_at: string | null; readonly reviewer_id: string | null; readonly initiated_by: "sm" | "borrower";
}
export interface RecommendationDrift { readonly cause: "du_policy" | "data_change"; readonly from: Recommendation; readonly to: Recommendation; readonly du_release: string; readonly du_release_date: PlainDate; readonly policy_generation: PolicyGeneration; }

// ============================================================ rule 2 — message catalog (representative rows; the full catalog is configuration in `du_message_rules`)
const F = D("2026-09-25");
const rule = (message_id: string, section: MessageSection, action: RuleAction, o: Partial<Omit<DuMessageRule, "message_id" | "section" | "action">> & { category: ConditionCategory }): DuMessageRule => ({
  message_id, du_release: CURRENT_DU_RELEASE, section, action, condition_template_code: o.condition_template_code ?? null, stage: o.stage ?? null, category: o.category, evidence_kinds: o.evidence_kinds ?? [], auto_clear_rule: o.auto_clear_rule ?? null,
  severity: o.severity ?? "standard", effective_from: o.effective_from ?? F, effective_to: o.effective_to ?? null, borrower_text: o.borrower_text ?? null,
  ...(o.reason_code !== undefined ? { reason_code: o.reason_code } : {}), ...(o.lever !== undefined ? { lever: o.lever } : {}), ...(o.sfc !== undefined ? { sfc: o.sfc } : {}), ...(o.red_flag !== undefined ? { red_flag: o.red_flag } : {}), ...(o.requires_role !== undefined ? { requires_role: o.requires_role } : {}),
});
const cond = (message_id: string, template: string, category: ConditionCategory, evidence_kinds: readonly string[], borrower_text: string, o: { stage?: ConditionStage; auto_clear_rule?: string; severity?: Severity; section?: MessageSection } = {}): DuMessageRule =>
  rule(message_id, o.section ?? "verification", "open_condition", { condition_template_code: template, stage: o.stage ?? "ptd", category, evidence_kinds, borrower_text, ...(o.auto_clear_rule ? { auto_clear_rule: o.auto_clear_rule } : {}), ...(o.severity ? { severity: o.severity } : {}) });
/** The DU 12.1 Sept 25, 2026 catalog as loaded for the fixtures. Borrower text names the lender (the partner), never DU. */
export const DU_MESSAGE_RULES_2026_09_25: readonly DuMessageRule[] = [
  // verification — income / employment (B3-2-04 minimum documentation; validated components auto-clear via relief_components)
  cond("V1001", "COND_DU_VERIFY_INCOME_BASE", "income", ["paystub", "w2"], "Your lender needs your most recent pay stub covering 30 days and your W-2 for the most recent year.", { auto_clear_rule: "B3-3.2-01/DU:paystub_30d_w2_1y" }),
  cond("V1002", "COND_DU_VERIFY_INCOME_BONUS", "income", ["w2", "form_1005_voe"], "Your lender needs two years of W-2s or a written verification of employment showing your bonus history.", { auto_clear_rule: "B3-3.1-03/DU:bonus_2y" }),
  cond("V1003", "COND_DU_VERIFY_EMPLOYMENT_VOE", "employment", ["form_1005_voe", "vvoe_record"], "Your lender will confirm your current employment with your employer before closing.", { auto_clear_rule: "B3-3.1-04/DU:vvoe_10bd" }),
  cond("V1004", "COND_DU_VERIFY_ASSETS", "assets", ["bank_statement", "brokerage_statement", "form_1006_vod"], "Your lender needs your two most recent statements for each account used for closing funds."),
  cond("V1005", "COND_DU_VERIFY_RESERVES", "assets", ["bank_statement", "retirement_statement"], "Your lender needs statements showing the savings you will keep after closing."),
  cond("V1006", "COND_DU_LIABILITY_MORTGAGE_HISTORY", "liabilities", ["mortgage_statement", "payment_history"], "Your lender needs your current mortgage statement showing the last 12 months of payments."),
  cond("V1007", "COND_DU_CREDIT_INQUIRY_LETTER", "credit", ["letter_of_explanation"], "Your lender needs a short signed explanation of the recent credit inquiries on your report."),
  cond("V1008", "COND_DU_PROPERTY_HAZARD_INSURANCE", "insurance", ["hoi_declaration"], "Your lender needs the declarations page of your homeowners insurance policy."),
  cond("V1009", "COND_DU_TITLE_COMMITMENT", "title", ["title_commitment"], "Your lender is obtaining the title commitment for the property."),
  cond("V1010", "COND_DU_PAYOFF_EXISTING_LIEN", "liabilities", ["payoff_statement"], "Your lender needs the payoff statement for the mortgage being paid off."),
  cond("V1011", "COND_DU_OCCUPANCY", "occupancy", ["occupancy_evidence", "utility_bill", "drivers_license"], "Your lender needs a document showing the property address as your primary residence."),
  cond("V1012", "COND_DU_IDENTITY_VERIFICATION", "identity", ["government_id"], "Your lender needs a copy of your government-issued photo identification."),
  cond("V1013", "COND_DU_TAX_TRANSCRIPT", "income", ["tax_transcript", "form_4506_c"], "Your lender needs a signed IRS Form 4506-C so it can obtain your tax transcripts."),
  cond("V1014", "COND_DU_FLOOD_DETERMINATION", "property", ["flood_determination"], "Your lender is obtaining the flood zone determination for the property."),
  cond("V1016", "COND_DU_LIABILITY_PAYOFF_AT_CLOSING", "liabilities", ["payoff_statement", "cd_payoff_line"], "The account your lender discussed with you will be paid at closing; the payoff will appear on your Closing Disclosure.", { stage: "ptf" }),
  cond("V1017", "COND_DU_LIABILITY_UNDISCLOSED", "liabilities", ["credit_supplement", "account_statement"], "Your lender needs the most recent statement for the account it recently identified on your credit report."),
  // eligibility — structural (restructure loop; no condition)
  rule("E5001", "eligibility", "structural_ineligible", { category: "program", reason_code: "LOAN_AMOUNT_OVER_COUNTY_LIMIT", lever: "loan_amount", severity: "critical" }),
  rule("E5002", "eligibility", "structural_ineligible", { category: "program", reason_code: "LTV_OVER_ELIGIBILITY_MATRIX", lever: "loan_amount", severity: "critical" }),
  rule("E5003", "eligibility", "structural_ineligible", { category: "program", reason_code: "HOMEREADY_INCOME_OVER_AMI_LIMIT", lever: "remove_homeready", severity: "critical" }),
  rule("E5004", "eligibility", "structural_ineligible", { category: "program", reason_code: "B3_6_02_DTI_OVER_50", lever: "loan_amount", severity: "critical" }),
  rule("E5005", "eligibility", "structural_ineligible", { category: "program", reason_code: "CASH_OUT_SECOND_HOME_OVER_75", lever: "loan_amount", severity: "critical" }),
  // CU eligibility (Sept 25, 2026)
  rule("C6001", "cu", "structural_ineligible", { category: "property", condition_template_code: "COND_DU_CU_INELIGIBLE", stage: "ptd", evidence_kinds: ["appraisal_report", "repair_completion"], reason_code: "CU_C6_CONDITION_RATING", lever: "product", severity: "critical", borrower_text: "Your lender needs an updated appraisal before the loan can proceed." }),
  rule("C6002", "cu", "structural_ineligible", { category: "property", condition_template_code: "COND_DU_CU_INELIGIBLE", stage: "ptd", evidence_kinds: ["appraisal_report"], reason_code: "CU_APPRAISER_NO_LONGER_ACCEPTED", lever: "product", severity: "critical", borrower_text: "Your lender needs an updated appraisal before the loan can proceed." }),
  cond("C6003", "COND_DU_LAVA_ZONE_CONFIRM", "property", ["hazard_insurance_evidence", "lava_zone_confirmation"], "Your lender is confirming the property's lava-zone insurance coverage.", { section: "cu" }),
  // MI / value acceptance / HomeReady / education
  rule("M2000", "mi", "mi_requirement", { category: "mi" }),
  rule("M2001", "mi", "mi_requirement", { category: "mi", condition_template_code: "COND_DU_MI_CERT", stage: "ptd", evidence_kinds: ["mi_certificate"], borrower_text: "Your lender is obtaining the mortgage insurance certificate for your loan." }),
  rule("A3001", "value_acceptance", "offer", { category: "property", reason_code: "VALUE_ACCEPTANCE" }),
  rule("A3002", "value_acceptance", "offer", { category: "property", condition_template_code: "COND_DU_VA_PD_SUBMITTED", stage: "ptf", evidence_kinds: ["property_data_api_id"], reason_code: "VALUE_ACCEPTANCE_PD", borrower_text: "A property data collection will be scheduled for your home." }),
  rule("H7001", "homeready", "offer", { category: "program", reason_code: "HOMEREADY_INCOME_WITHIN_AMI" }),
  cond("H7002", "COND_FNMA_B2_2_06_EDUCATION", "program", ["education_certificate"], "At least one borrower must complete a homeownership education course before closing; your lender will accept a HomeView or HUD-approved provider certificate.", { section: "homeready", auto_clear_rule: "23.2.education_verified" }),
  // validation service (Day 1 Certainty) — record only; relief flags to 23.3/29.3
  rule("D8001", "validation", "record_only", { category: "income" }), rule("D8002", "validation", "record_only", { category: "employment" }), rule("D8003", "validation", "record_only", { category: "assets" }),
  // potential red flags (7.22.24 matrix) — investigation, never a borrower-facing condition
  rule("R9001", "potential_red_flag", "open_investigation", { category: "credit", red_flag: "frozen_credit", severity: "critical" }),
  rule("R9002", "potential_red_flag", "open_investigation", { category: "identity", red_flag: "casefile_id_reuse", severity: "critical" }),
  rule("R9003", "potential_red_flag", "open_investigation", { category: "identity", red_flag: "excessive_resubmissions", severity: "critical" }),
  rule("R9004", "potential_red_flag", "open_investigation", { category: "occupancy", red_flag: "occupancy_modified", severity: "critical" }),
  // observations — no action
  rule("O4001", "observation", "record_only", { category: "compliance", severity: "info" }), rule("O4002", "observation", "record_only", { category: "compliance", severity: "info" }),
  rule("O4003", "observation", "record_only", { category: "compliance", severity: "critical", reason_code: "REFINOW_OUT_OF_SCOPE" }),
  // SFC messages — post-closing delivery conditions (29.3 ULDD); never borrower-facing
  rule("S0127", "sfc", "sfc_required", { category: "compliance", sfc: "127" }), rule("S0007", "sfc", "sfc_required", { category: "compliance", sfc: "007" }), rule("S0900", "sfc", "sfc_required", { category: "compliance", sfc: "900" }),
  rule("S0808", "sfc", "sfc_required", { category: "compliance", sfc: "808" }), rule("S0067", "sfc", "sfc_required", { category: "compliance", sfc: "067" }), rule("S0184", "sfc", "sfc_optional", { category: "compliance", sfc: "184" }),
];
export const UNMAPPED_TEMPLATE = "COND_DU_UNMAPPED_MESSAGE";
export const UNMAPPED_BORROWER_TEXT = "Your lender is reviewing an item on your application and will let you know if anything is needed from you.";
export const SFC_CONDITION_PREFIX = "COND_DELIVERY_SFC_";

/** Lookup by (message_id, du_release) — the release is part of the key (11 new / 25 modified / 7 retired messages on Sept 25, 2026). */
export function findRule(rules: readonly DuMessageRule[], message_id: string, du_release: string, on?: PlainDate): DuMessageRule | null {
  return rules.find((r) => r.message_id === message_id && r.du_release === du_release && (!on || (r.effective_from <= on && (r.effective_to === null || on <= r.effective_to)))) ?? null;
}
export interface MappedMessage { readonly message: DuMessage; readonly rule: DuMessageRule | null; readonly action: RuleAction | "unmapped"; readonly section: MessageSection | "unknown"; }
/** Rule 2: every message is looked up by id and release; unknown ids are never dropped (action `unmapped` → triage + generic PTD condition). */
export function mapMessages(messages: readonly DuMessage[], rules: readonly DuMessageRule[], du_release: string): MappedMessage[] {
  nonEmpty(du_release, "du_release");
  return messages.map((message) => { const r = findRule(rules, message.id, du_release); return { message, rule: r, action: r ? r.action : "unmapped", section: r ? r.section : "unknown" }; });
}

// ============================================================ borrower-facing wording (rule "Borrower-facing wording"; guardrail "never present DU output to the borrower")
const DU_WORDS = /\bDU\b|Desktop Underwriter|Fannie Mae findings|underwriting findings|Approve\/(Eligible|Ineligible)|Refer with Caution/i;
/** True when the text carries no DU message id, no DU vocabulary and no findings wording. */
export function borrowerSafe(text: string, messageIds: readonly string[]): boolean {
  if (DU_WORDS.test(text)) return false;
  return !messageIds.some((id) => id.length > 0 && text.includes(id));
}
export function assertBorrowerSafe(text: string, messageIds: readonly string[]): void {
  if (!borrowerSafe(text, messageIds)) throw new InterpretationRefused("DU_OUTPUT_TO_BORROWER", "23.2 guardrails: never present DU output to the borrower (Fannie Mae-confidential; the creditor is the partner)", `borrower-facing text must not carry a DU message id or DU wording: "${text}"`);
}

// ============================================================ conditions
export interface OpenConditionInput {
  readonly application_id: string; readonly submission_id: string | null; readonly template_code: string; readonly category: ConditionCategory; readonly stage: ConditionStage; readonly text: string; readonly internal_text: string;
  readonly borrower_id?: string | null; readonly du_message_id?: string | null; readonly evidence_kinds?: readonly string[]; readonly auto_clear_rule?: string | null; readonly requires_role?: RequiresRole | null; readonly source?: ConditionSource;
  readonly opened_at: string; readonly due_at?: string | null; readonly borrower_visible?: boolean; readonly message_ids?: readonly string[];
}
/** One condition row (`open`) + `condition.opened` (23.3 consumes). The borrower text is checked against every DU id the findings carry. */
export function openCondition(events: EventStore, i: OpenConditionInput, actor: Actor = AGENT): { condition: Condition; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.template_code, "template_code"); nonEmpty(i.opened_at, "opened_at");
  const visible = i.borrower_visible ?? i.stage !== "post_closing";
  if (visible) assertBorrowerSafe(i.text, [...(i.message_ids ?? []), ...(i.du_message_id ? [i.du_message_id] : [])]);
  const condition: Condition = {
    condition_id: `cond:${i.submission_id ?? "uw"}:${i.template_code}:${i.du_message_id ?? "-"}:${i.borrower_id ?? "all"}`, application_id: i.application_id, borrower_id: i.borrower_id ?? null, source: i.source ?? "du", stage: i.stage, status: "open",
    template_code: i.template_code, du_message_id: i.du_message_id ?? null, du_submission_id: i.submission_id, text: i.text, internal_text: i.internal_text, category: i.category, evidence_kinds: [...(i.evidence_kinds ?? [])], auto_clear_rule: i.auto_clear_rule ?? null, requires_role: i.requires_role ?? null,
    opened_at: i.opened_at, due_at: i.due_at ?? null, cleared_at: null, cleared_by: null, clear_evidence_document_ids: [], superseded_by_condition_id: null, superseded_by_submission_id: null, qc_sampled: false, borrower_visible: visible,
  };
  const event = emit(events, i.application_id, "condition.opened", { condition_id: condition.condition_id, template_code: condition.template_code, stage: condition.stage, category: condition.category, source: condition.source, status: "open", du_message_id: condition.du_message_id, du_submission_id: condition.du_submission_id, borrower_id: condition.borrower_id, requires_role: condition.requires_role, borrower_visible: visible, evidence_kinds: condition.evidence_kinds, auto_clear_rule: condition.auto_clear_rule }, i.opened_at, actor);
  return { condition, event };
}
const LIVE: readonly ConditionStatus[] = ["open", "waiting_borrower", "waiting_third_party", "satisfied_pending_review", "reopened"];
/** Edge case "message present on submission n, absent on n+1": supersede the live DU conditions whose message disappeared; evidence already attached is retained; cleared conditions are untouched. */
export function supersedeDroppedConditions(events: EventStore, prior: readonly Condition[], current_message_ids: ReadonlySet<string>, c: { submission_id: string; at: string }, actor: Actor = AGENT): { superseded: Condition[]; unchanged: Condition[]; events: DomainEvent[] } {
  const superseded: Condition[] = [], unchanged: Condition[] = [], out: DomainEvent[] = [];
  for (const p of prior) {
    const drop = p.source === "du" && p.du_message_id !== null && !current_message_ids.has(p.du_message_id) && LIVE.includes(p.status);
    if (!drop) { unchanged.push(p); continue; }
    const s: Condition = { ...p, status: "superseded", superseded_by_submission_id: c.submission_id, clear_evidence_document_ids: [...p.clear_evidence_document_ids] };
    superseded.push(s);
    out.push(emit(events, p.application_id, "condition.superseded", { condition_id: p.condition_id, template_code: p.template_code, du_message_id: p.du_message_id, submission_id: c.submission_id, prior_status: p.status, clear_evidence_document_ids: s.clear_evidence_document_ids, evidence_retained: true }, c.at, actor));
  }
  return { superseded, unchanged, events: out };
}
/** T2: an unmapped-message condition is cleared or mapped only by `underwriting_reviewer` (spec: "cleared by `underwriting_reviewer`"). */
export function clearUnmappedCondition(cond: Condition, by: Actor, resolution: { mapped_to?: string; reason: string }, at: string): Condition {
  need(cond.template_code === UNMAPPED_TEMPLATE, `${cond.condition_id} is not an unmapped-message condition`);
  if (by.kind !== "human" || by.role !== "underwriting_reviewer") throw new InterpretationRefused("UNMAPPED_CLEAR_NEEDS_REVIEWER", "23.2 T2: CTC is blocked until the message is mapped or cleared by `underwriting_reviewer`", `only underwriting_reviewer may clear ${UNMAPPED_TEMPLATE} (actor ${by.kind}:${by.id})`);
  nonEmpty(resolution.reason, "reason");
  return { ...cond, status: "cleared", cleared_at: at, cleared_by: by.id, internal_text: resolution.mapped_to ? `${cond.internal_text} → mapped to ${resolution.mapped_to}` : cond.internal_text };
}
export interface CtcBlock { readonly open: boolean; readonly blocking_codes: readonly string[]; readonly reasons: readonly string[]; }
/** What 23.2 contributes to 23.3's CTC checklist: no live unmapped message, no open red-flag investigation (closed only with rationale), no live PTD condition. */
export function ctcBlockers(conditions: readonly Condition[], investigations: readonly Investigation23[]): CtcBlock {
  const codes: string[] = [], reasons: string[] = [];
  const unmapped = conditions.filter((c) => c.template_code === UNMAPPED_TEMPLATE && LIVE.includes(c.status));
  if (unmapped.length) { codes.push("CTC_UNMAPPED_DU_MESSAGE"); reasons.push(`${unmapped.length} DU message(s) await mapping or underwriting_reviewer clearance: ${unmapped.map((c) => c.du_message_id).join(", ")}`); }
  const openInv = investigations.filter((v) => v.status !== "closed" || !v.rationale);
  if (openInv.length) { codes.push("CTC_NO_OPEN_INVESTIGATION"); reasons.push(`${openInv.length} du_red_flag investigation(s) not closed with rationale: ${openInv.map((v) => v.red_flag).join(", ")}`); }
  const ptd = conditions.filter((c) => c.stage === "ptd" && c.template_code !== UNMAPPED_TEMPLATE && LIVE.includes(c.status));
  if (ptd.length) { codes.push("CTC_PTD_CONDITIONS_OPEN"); reasons.push(`${ptd.length} PTD condition(s) open`); }
  return { open: codes.length === 0, blocking_codes: codes, reasons };
}

// ============================================================ investigations (potential red flags → 22.6)
export function openRedFlagInvestigation(events: EventStore, i: { application_id: string; submission_id: string; message_id: string; red_flag: RedFlag; du_text: string; at: string }, actor: Actor = AGENT): { investigation: Investigation23; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.message_id, "message_id");
  const investigation: Investigation23 = { investigation_id: `inv:${i.submission_id}:${i.message_id}`, application_id: i.application_id, kind: "du_red_flag", red_flag: i.red_flag, message_id: i.message_id, submission_id: i.submission_id, status: "open", rationale: null, borrower_visible: false, opened_at: i.at, closed_at: null };
  const hypothesis = i.red_flag === "occupancy_modified" ? "occupancy_misrepresentation" : i.red_flag === "frozen_credit" ? "identity_theft" : i.red_flag === "casefile_id_reuse" ? "straw_buyer" : "income_fabrication";
  const event = emit(events, i.application_id, "investigation.opened", { investigation_id: investigation.investigation_id, kind: "du_red_flag", case_type: "fraud", red_flag: i.red_flag, du_message_id: i.message_id, submission_id: i.submission_id, triggers: [`du_red_flag:${i.red_flag}`], hypotheses: [hypothesis], blocks_ctc: true, borrower_visible: false, consumers: ["22.6", "28.1"], opened_at: i.at }, i.at, actor);
  return { investigation, event };
}
/** T8: CTC stays blocked until the investigation closes *with rationale*. */
export function closeInvestigation(events: EventStore, inv: Investigation23, rationale: string, at: string, actor: Actor): { investigation: Investigation23; event: DomainEvent } {
  need(typeof rationale === "string" && rationale.trim().length > 0, "an investigation closes only with a written rationale");
  const investigation: Investigation23 = { ...inv, status: "closed", rationale, closed_at: at };
  const event = emit(events, inv.application_id, "investigation.closed", { investigation_id: inv.investigation_id, kind: "du_red_flag", rationale, closed_at: at }, at, actor);
  return { investigation, event };
}

// ============================================================ rule 3 — MI coverage (B7-1-02)
export type MiProduct = "standard" | "homeready";
export interface MiCoverage { readonly required_pct: string | null; readonly standard_pct: string | null; readonly minimum_option_pct: string | null; readonly band: string | null; }
/** B7-1-02 table: standard (> 20y / ARM) 12/25/30/35, ≤ 20y 6/12/25/35; HomeReady 12/25/25/25 (≤ 20y 6/12/25/25); minimum-coverage option 6/12/16/18. */
export function miCoverage(ltv_x100: number, product: MiProduct, term_months: number, arm = false): MiCoverage {
  if (ltv_x100 <= 8000) return { required_pct: null, standard_pct: null, minimum_option_pct: null, band: null };
  const long = arm || term_months > 240;
  const band = ltv_x100 <= 8500 ? 0 : ltv_x100 <= 9000 ? 1 : ltv_x100 <= 9500 ? 2 : 3;
  if (ltv_x100 > 9700) throw new RangeError(`LTV ${ltv_x100 / 100}% exceeds the 97% maximum (Eligibility Matrix)`);
  const std = (long ? [12, 25, 30, 35] : [6, 12, 25, 35])[band]!, hr = (long ? [12, 25, 25, 25] : [6, 12, 25, 25])[band]!, min = [6, 12, 16, 18][band]!;
  const pct = (n: number) => `${n}.00`;
  return { required_pct: pct(product === "homeready" ? hr : std), standard_pct: pct(std), minimum_option_pct: pct(min), band: ["80.01–85.00%", "85.01–90.00%", "90.01–95.00%", "95.01–97.00%"][band]! };
}

// ============================================================ rule 4 — value acceptance (B4-1.4-10): only the final submission's offer is exercisable
export function valueAcceptanceOffer(offer: { offered: boolean; property_value_cents?: Cents; kind?: "value_acceptance" | "value_acceptance_pd" } | null): ValueAcceptanceOffer {
  if (!offer || !offer.offered) return "none";
  return offer.kind === "value_acceptance_pd" ? "value_acceptance_pd" : "value_acceptance";
}
/** The offer used for delivery is the one on the final-match submission; an earlier offer that disappears cannot be exercised (SFC 801 not permitted). */
export function deliveryOffer(interpretations: readonly Pick<DuFindingsInterpretation, "is_final" | "value_acceptance_offer" | "submission_number">[]): { offer: ValueAcceptanceOffer; sfc_801_permitted: boolean; from_submission: number | null } {
  const final = [...interpretations].filter((x) => x.is_final).sort((a, b) => b.submission_number - a.submission_number)[0] ?? null;
  if (!final) return { offer: "none", sfc_801_permitted: false, from_submission: null };
  return { offer: final.value_acceptance_offer, sfc_801_permitted: final.value_acceptance_offer !== "none", from_submission: final.submission_number };
}

// ============================================================ rule 9 — SFC assembly
export interface SfcFacts { readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out"; readonly score_model: "classic_fico" | "vantagescore_4" | null; readonly homeready: boolean; readonly counseling_credit: boolean; readonly value_acceptance_exercised: boolean; readonly va_pd_exercised: boolean; readonly high_balance: boolean; readonly community_seconds: boolean; readonly temporary_buydown: boolean; readonly inter_vivos_trust: boolean; readonly texas_50a6: boolean; }
export function sfcAssembly(f: SfcFacts): string[] {
  const s = new Set<string>([SFC_ALWAYS]);
  if (f.score_model === "vantagescore_4") s.add(SFC_20_4.vantagescore_4);
  if (f.homeready) s.add(SFC_20_4.homeready);
  if (f.counseling_credit) s.add("184");
  if (f.value_acceptance_exercised) s.add("801"); if (f.va_pd_exercised) s.add("774");
  if (f.high_balance) s.add(SFC_20_4.high_balance);
  if (f.community_seconds) s.add("118"); if (f.temporary_buydown) s.add("009"); if (f.inter_vivos_trust) s.add("168"); if (f.texas_50a6) s.add("304");
  if (f.transaction_type === "limited_cash_out") s.add(SFC_20_4.lcor);
  return [...s].sort();
}

// ============================================================ rule 5 — loan limits (LL-2025-04; 20.4's constants)
export function loanLimitCheck(loan_amount_cents: Cents, units: 1 | 2 | 3 | 4, county_limit_cents: Cents | null): { baseline_limit_cents: Cents; county_limit_cents: Cents; ceiling_cents: Cents; high_balance: boolean; over_limit: boolean; over_ceiling: boolean } {
  const baseline = BASELINE_LIMITS_2026[units]; const county = county_limit_cents ?? baseline;
  const ceiling = units === 1 ? HIGH_COST_CEILING_1_UNIT_2026 : (county > baseline ? county : baseline);
  return { baseline_limit_cents: baseline, county_limit_cents: county, ceiling_cents: ceiling, high_balance: loan_amount_cents > baseline && loan_amount_cents <= county, over_limit: loan_amount_cents > county, over_ceiling: loan_amount_cents > ceiling };
}

// ============================================================ rule 2 (HomeReady evaluation, B5-6-01)
export interface HomeReadyInput { readonly application_id: string; readonly property_fips: string; readonly ami_source: "du_message" | "ami_api" | "web_tool" | string; readonly ami_annual_cents: Cents; readonly qualifying_monthly_income_cents: readonly Cents[]; readonly ami_dataset_version: string; readonly api_response_document_id?: string | null; readonly evaluated_at: string; }
/** income = Σ(monthly qualifying income of all note signers) × 12; limit = floor(AMI × 80 / 100); eligible = income ≤ limit. Never a non-Fannie-Mae AMI. */
export function evaluateHomeReady(i: HomeReadyInput): HomeReadyEvaluation23 {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.property_fips, "property_fips"); nonEmpty(i.ami_dataset_version, "ami_dataset_version");
  if (!["du_message", "ami_api", "web_tool"].includes(i.ami_source)) throw new InterpretationRefused("NON_FNMA_AMI", "B5-6-01: lenders \"may not rely on other published versions\" of AMI; 23.2 guardrail: never rely on non-Fannie Mae AMI data", `ami_source ${i.ami_source} is not DU's message, the AMI Lookup and HomeReady Evaluation API or the web tool`);
  need(i.ami_annual_cents > 0n, "ami_annual_cents must be positive"); need(i.qualifying_monthly_income_cents.length > 0, "at least one note signer's qualifying income is required");
  const qualifying_income_annual_cents = i.qualifying_monthly_income_cents.reduce((a, b) => a + b, 0n) * 12n;
  const income_limit_annual_cents = (i.ami_annual_cents * 80n) / 100n;   // floor
  return { evaluation_id: `hr:${i.application_id}:${i.evaluated_at}`, application_id: i.application_id, property_fips: i.property_fips, ami_source: i.ami_source as HomeReadyEvaluation23["ami_source"], ami_annual_cents: i.ami_annual_cents, limit_pct: HOMEREADY_AMI_LIMIT_PCT,
    income_limit_annual_cents, qualifying_income_annual_cents, eligible: qualifying_income_annual_cents <= income_limit_annual_cents, ami_dataset_version: i.ami_dataset_version, api_response_document_id: i.api_response_document_id ?? null, evaluated_at: i.evaluated_at };
}
export function recordHomeReadyEvaluation(events: EventStore, e: HomeReadyEvaluation23, actor: Actor = AGENT): DomainEvent {
  return emit(events, e.application_id, "homeready.evaluated", { evaluation_id: e.evaluation_id, eligible: e.eligible, ami_source: e.ami_source, ami_annual_cents: e.ami_annual_cents.toString(), income_limit_annual_cents: e.income_limit_annual_cents.toString(), qualifying_income_annual_cents: e.qualifying_income_annual_cents.toString(), ami_dataset_version: e.ami_dataset_version, sfc: e.eligible ? [SFC_20_4.homeready] : [] }, e.evaluated_at, actor);
}

// ============================================================ homeownership education (B2-2-06) and the counseling credit (B5-6-01, SFC 184)
export interface EducationFacts { readonly purchase: boolean; readonly homeready: boolean; readonly all_occupying_first_time: boolean; readonly all_borrowers_first_time: boolean; readonly ltv_x100: number; readonly du_no_tradelines: boolean; }
/** The three enumerated cases; anything else → `none` (edge case: a non-first-time co-borrower added flips the basis to none). */
export function educationBasis(f: EducationFacts): RequirementBasis {
  if (!f.purchase) return "none";
  if (f.homeready && f.all_occupying_first_time) return "homeready_all_ftb";
  if (f.ltv_x100 > 9500 && f.all_borrowers_first_time) return "ltv_over_95_all_ftb";
  if (f.du_no_tradelines) return "du_no_tradelines";
  return "none";
}
export function requireEducation(events: EventStore, i: { application_id: string; borrower_ids: readonly string[]; basis: RequirementBasis; closing_date: PlainDate | null; at: string }, actor: Actor = AGENT): { records: EducationRecord[]; event: DomainEvent | null } {
  nonEmpty(i.application_id, "application_id");
  const status = i.basis === "none" ? "not_required" : "required_open";
  const records: EducationRecord[] = i.borrower_ids.map((borrower_id) => ({ record_id: `edu:${i.application_id}:${borrower_id}`, application_id: i.application_id, borrower_id, requirement_basis: i.basis, provider_name: null, provider_type: null, course_type: null, certificate_document_id: null, completed_on: null, verified_at: null, counseling_within_12m: false, status }));
  if (i.basis === "none") return { records, event: null };
  const event = emit(events, i.application_id, "homeownership_education.required", { basis: i.basis, borrower_ids: [...i.borrower_ids], closing_date: i.closing_date, condition_template: "COND_FNMA_B2_2_06_EDUCATION", gate: "FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE" }, i.at, actor);
  return { records, event };
}
export const EDUCATION_PROVIDER_ALLOWLIST: readonly { name: string; type: ProviderType }[] = [{ name: "Fannie Mae HomeView", type: "homeview" }, { name: "HomeView", type: "homeview" }];
/** Certificate intake (22.1 classifier `education_certificate`): status `received`; arms FNMA_B5_6_01_COUNSELING_CREDIT_12M on `completed_on` when it is HUD counseling. */
export function receiveEducationCertificate(events: EventStore, r: EducationRecord, c: { certificate_document_id: string; provider_name: string; provider_type: ProviderType; course_type: "education" | "counseling"; completed_on: PlainDate; at: string }, actor: Actor = AGENT): { record: EducationRecord; event: DomainEvent } {
  nonEmpty(c.certificate_document_id, "certificate_document_id"); nonEmpty(c.provider_name, "provider_name");
  const record: EducationRecord = { ...r, provider_name: c.provider_name, provider_type: c.provider_type, course_type: c.course_type, certificate_document_id: c.certificate_document_id, completed_on: c.completed_on, status: r.status === "verified" ? "verified" : "received" };
  const event = emit(events, r.application_id, "homeownership_education.certificate.received", { record_id: r.record_id, borrower_id: r.borrower_id, certificate_document_id: c.certificate_document_id, provider_name: c.provider_name, provider_type: c.provider_type, course_type: c.course_type, completed_on: c.completed_on }, c.at, actor);
  return { record, event };
}
export interface CounselingCredit { readonly satisfied: boolean; readonly window_opens: PlainDate; readonly completed_on: PlainDate; readonly closing_date: PlainDate; readonly sfc_184: boolean; }
/** FNMA_B5_6_01_COUNSELING_CREDIT_12M: completed_on ≥ closing − 12 calendar months → SFC 184 + DU Housing Counseling data; otherwise the credit is not applied. */
export function counselingCredit12m(completed_on: PlainDate, closing_date: PlainDate): CounselingCredit {
  const window_opens = addMonths(closing_date, -COUNSELING_CREDIT_MONTHS);
  const satisfied = completed_on >= window_opens && completed_on <= closing_date;
  return { satisfied, window_opens, completed_on, closing_date, sfc_184: satisfied };
}
export interface VerifyCertificateInput { readonly certificate_document_id: string | null; readonly borrower_name: string; readonly name_on_certificate: string; readonly closing_date: PlainDate; readonly verified_at: string; readonly provider_allowlist?: readonly { name: string; type: ProviderType }[]; readonly lender_affiliates?: readonly string[]; }
export interface CertificateChecks { readonly certificate_on_file: boolean; readonly provider_accepted: boolean; readonly provider_independent: boolean; readonly name_match: boolean; readonly completed_before_closing: boolean; readonly counseling_within_12m: boolean; }
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** Provider on the lists (HomeView always; HUD/NIS providers by allow-list), borrower name match, completion before closing, counseling ≤ 12 months for SFC 184. Never verified without the certificate document. */
export function verifyEducationCertificate(events: EventStore, r: EducationRecord, i: VerifyCertificateInput, actor: Actor = AGENT): { record: EducationRecord; checks: CertificateChecks; event: DomainEvent | null; escalate: "underwriting_reviewer" | null } {
  if (!i.certificate_document_id || !r.certificate_document_id) throw new InterpretationRefused("EDUCATION_VERIFIED_WITHOUT_CERTIFICATE", "B2-2-06: the lender \"must retain a copy of the certificate of course completion in the loan file\"; 23.2 guardrail: never mark education verified without the certificate document", `record ${r.record_id} has no certificate document`);
  need(r.completed_on !== null && r.provider_name !== null && r.provider_type !== null && r.course_type !== null, `record ${r.record_id} has not received a certificate (status ${r.status})`);
  const list = i.provider_allowlist ?? EDUCATION_PROVIDER_ALLOWLIST;
  const provider_independent = !(i.lender_affiliates ?? []).some((a) => norm(a) === norm(r.provider_name!));
  const provider_accepted = provider_independent && (r.provider_type === "homeview" || list.some((p) => norm(p.name) === norm(r.provider_name!) && p.type === r.provider_type));
  const name_match = norm(i.borrower_name) === norm(i.name_on_certificate);
  const completed_before_closing = r.completed_on! <= i.closing_date;
  const counseling_within_12m = r.course_type === "counseling" && counselingCredit12m(r.completed_on!, i.closing_date).satisfied;
  const checks: CertificateChecks = { certificate_on_file: true, provider_accepted, provider_independent, name_match, completed_before_closing, counseling_within_12m };
  if (!provider_accepted || !name_match || !completed_before_closing) return { record: { ...r, status: "received", counseling_within_12m }, checks, event: null, escalate: provider_independent && !provider_accepted ? "underwriting_reviewer" : null };
  const record: EducationRecord = { ...r, status: "verified", verified_at: i.verified_at, counseling_within_12m };
  const event = emit(events, r.application_id, "homeownership_education.verified", { record_id: r.record_id, borrower_id: r.borrower_id, basis: r.requirement_basis, provider_name: r.provider_name, provider_type: r.provider_type, course_type: r.course_type, completed_on: r.completed_on, certificate_document_id: r.certificate_document_id, counseling_within_12m, sfc_184: counseling_within_12m, verified_at: i.verified_at, checks }, i.verified_at, actor);
  return { record, checks, event, escalate: null };
}
export interface EducationGateResult { readonly open: boolean; readonly reason: string | null; readonly blocking_codes: readonly string[]; readonly escalate: "underwriting_reviewer" | null; readonly business_days_to_closing: number | null; }
/** FNMA_B2_2_06_HOMEOWNERSHIP_ED_GATE (blocks `clear_to_close` / `consummate`): at least one borrower `verified`; escalate when closing is < 3 creditor business days away. */
export function homeownershipEducationGate(i: { basis: RequirementBasis; records: readonly EducationRecord[]; closing_date: PlainDate | null; as_of: PlainDate }, cal: Calendar = creditor): EducationGateResult {
  if (i.basis === "none") return { open: true, reason: null, blocking_codes: [], escalate: null, business_days_to_closing: null };
  if (i.records.some((r) => r.status === "verified")) return { open: true, reason: null, blocking_codes: [], escalate: null, business_days_to_closing: null };
  let bd: number | null = null;
  if (i.closing_date) { bd = 0; let d = i.as_of; while (d < i.closing_date && bd < 60) { d = addBusinessDays(d, 1, cal); bd++; } }
  const escalate = bd !== null && bd < EDUCATION_ESCALATION_BUSINESS_DAYS ? "underwriting_reviewer" : null;
  const received = i.records.some((r) => r.status === "received");
  return { open: false, reason: `B2-2-06: homeownership education (${i.basis}) must be verified prior to loan closing — ${received ? "certificate received, verification pending" : "no certificate on file"}${bd !== null ? `; closing in ${bd} business day(s)` : ""}`, blocking_codes: ["CTC_EDUCATION_NOT_VERIFIED"], escalate, business_days_to_closing: bd };
}

// ============================================================ rule 7 — restructuring arithmetic (levelPayment, dtiBps reused)
export interface StructureFinancials {
  readonly monthly_income_cents: Cents; readonly loan_amount_cents: Cents; readonly value_cents: Cents; readonly purchase_price_cents: Cents | null; readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out";
  readonly note_rate_pct: string; readonly term_months: number; readonly taxes_monthly_cents: Cents; readonly insurance_monthly_cents: Cents; readonly other_debts_monthly_cents: Cents; readonly mi_annual_rate_pct: string | null; readonly product: MiProduct;
  readonly units?: 1 | 2 | 3 | 4; readonly county_limit_cents?: Cents | null;
}
export interface Pitia { readonly loan_amount_cents: Cents; readonly ltv_x100: number; readonly ltv_display: string; readonly pi_cents: Cents; readonly mi_cents: Cents; readonly mi_coverage_pct: string | null; readonly taxes_cents: Cents; readonly insurance_cents: Cents; readonly debts_cents: Cents; readonly obligations_cents: Cents; readonly dti_bps: number; readonly dti_display: string; readonly over_du_cap: boolean; }
const pctDisplay = (x100: number): string => `${Math.floor(x100 / 100)}.${String(x100 % 100).padStart(2, "0")}`;
/** Monthly MI premium: loan × annual rate / 12, half-up (illustrative $137.33 at $412,000 × 0.40 %); none at LTV ≤ 80 %. */
export function monthlyMi(loan_amount_cents: Cents, ltv_x100: number, mi_annual_rate_pct: string | null): Cents {
  if (ltv_x100 <= 8000 || !mi_annual_rate_pct) return 0n;
  return centsToDecimal(loan_amount_cents).mul(Decimal.parse(mi_annual_rate_pct)).div(Decimal.fromInt(100)).div(Decimal.fromInt(12)).toCents("HALF_UP");
}
/** P&I + MI + taxes + insurance + debts over income → DTI (22.5's rounding); the DU cap is 22.5's DU_MAX_DTI_BPS. */
export function pitiaFor(f: StructureFinancials, loan_amount_cents: Cents = f.loan_amount_cents): Pitia {
  need(loan_amount_cents > 0n, "loan_amount_cents must be positive");
  const ltv = ltvX100(loan_amount_cents, f.value_cents, f.purchase_price_cents, f.transaction_type);
  const pi_cents = levelPayment(loan_amount_cents, ratePercent(f.note_rate_pct), f.term_months);
  const mi_cents = monthlyMi(loan_amount_cents, ltv, f.mi_annual_rate_pct);
  const obligations_cents = pi_cents + mi_cents + f.taxes_monthly_cents + f.insurance_monthly_cents + f.other_debts_monthly_cents;
  const bps = dtiBps(obligations_cents, f.monthly_income_cents);
  return { loan_amount_cents, ltv_x100: ltv, ltv_display: pctDisplay(ltv), pi_cents, mi_cents, mi_coverage_pct: miCoverage(ltv, f.product, f.term_months).required_pct, taxes_cents: f.taxes_monthly_cents, insurance_cents: f.insurance_monthly_cents, debts_cents: f.other_debts_monthly_cents, obligations_cents, dti_bps: bps, dti_display: dtiDisplayPct(bps), over_du_cap: bps > DU_MAX_DTI_BPS };
}
const TEN_K = 1_000_000n;
const floor10k = (c: Cents): Cents => (c / TEN_K) * TEN_K;
/** Loan-amount lever candidates: the MI-band boundaries below the current LTV (85 % → lower coverage band, 80 % → no MI), rounded down to $10,000; plus the county limit when over it. */
export function loanAmountCandidates(f: StructureFinancials, limits: ReturnType<typeof loanLimitCheck> | null): Cents[] {
  const denom = f.transaction_type === "purchase" && f.purchase_price_cents !== null && f.purchase_price_cents < f.value_cents ? f.purchase_price_cents : f.value_cents;
  const out: Cents[] = [];
  if (limits && limits.over_limit) out.push(limits.county_limit_cents);
  for (const pct of [85n, 80n]) { const c = floor10k((denom * pct) / 100n); if (c < f.loan_amount_cents && !out.includes(c)) out.push(c); }
  return out;
}
export interface Lever { readonly kind: RestructureKind; readonly to: Record<string, unknown>; readonly pitia: Pitia; readonly expected_recommendation: Recommendation; readonly within_policy: boolean; readonly note: string; }
export interface RestructureComputation { readonly current: Pitia; readonly levers: readonly Lever[]; readonly recommended: Lever | null; readonly decline_candidate: boolean; readonly manual_underwriting_offered: false; }
/** Enumerate lawful levers with full arithmetic before any resubmission; never occupancy or income changes (guardrail). */
export function computeRestructure(f: StructureFinancials, o: { structural_reasons?: readonly StructuralReason[]; recommendation?: Recommendation } = {}): RestructureComputation {
  const limits = loanLimitCheck(f.loan_amount_cents, f.units ?? 1, f.county_limit_cents ?? null);
  const current = pitiaFor(f);
  const levers: Lever[] = [];
  const ok = (p: Pitia, l: ReturnType<typeof loanLimitCheck>) => !p.over_du_cap && !l.over_limit && p.ltv_x100 <= 9700;
  // (1) the lever a structural (eligibility) message names comes first — remove HomeReady when the AMI limit is the reason
  if (f.product === "homeready" && (o.structural_reasons ?? []).some((r) => r.lever === "remove_homeready")) {
    const p = pitiaFor({ ...f, product: "standard" }); const within = ok(p, limits);
    levers.push({ kind: "remove_homeready", to: { product: "standard_conventional", term_months: f.term_months, ltv_display: p.ltv_display, mi_coverage_pct: p.mi_coverage_pct }, pitia: p, expected_recommendation: within ? "approve_eligible" : "approve_ineligible", within_policy: within, note: `resubmit as standard conventional: MI coverage ${p.mi_coverage_pct ?? "none"}, P&I unchanged, DTI ${p.dti_display}%` });
  }
  // (2) loan amount: the county limit when over it, then the MI-band boundaries (85 %, 80 %) rounded down to $10,000
  for (const amt of loanAmountCandidates(f, limits)) {
    const p = pitiaFor(f, amt); const l = loanLimitCheck(amt, f.units ?? 1, f.county_limit_cents ?? null); const within = ok(p, l);
    levers.push({ kind: "loan_amount", to: { loan_amount_cents: amt.toString(), ltv_display: p.ltv_display, mi_coverage_pct: p.mi_coverage_pct }, pitia: p, expected_recommendation: within ? "approve_eligible" : "approve_ineligible", within_policy: within,
      note: `reduce the loan to ${(Number(amt) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} (LTV ${p.ltv_display}%${p.mi_cents === 0n ? ", no MI" : ""}): DTI ${p.dti_display}%${within ? "" : " — still over"}` });
  }
  // (3) liability payoff at or before closing (22.5) when the DU cap is the driver
  if (f.other_debts_monthly_cents > 0n && current.over_du_cap) {
    const p = pitiaFor({ ...f, other_debts_monthly_cents: 0n }); const within = ok(p, limits);
    levers.push({ kind: "liability_payoff", to: { other_debts_monthly_cents: "0", paid_at_or_before_closing: true }, pitia: p, expected_recommendation: within ? "approve_eligible" : "approve_ineligible", within_policy: within, note: `pay off the monthly debts (${(Number(f.other_debts_monthly_cents) / 100).toFixed(2)}) at or before closing (22.5): DTI ${p.dti_display}%` });
  }
  const recommended = levers.find((l) => l.within_policy) ?? null;
  return { current, levers, recommended, decline_candidate: (o.recommendation ?? "approve_ineligible") !== "approve_eligible", manual_underwriting_offered: false };
}
/** Q3 default: an SM-initiated proposal of terms different from those applied for is a Reg B counteroffer; borrower-initiated changes are not. */
export const regbTreatment = (initiated_by: "sm" | "borrower"): RegBTreatment => (initiated_by === "sm" ? "counteroffer" : "borrower_initiated");
const FORBIDDEN_LEVERS: readonly string[] = ["occupancy_change", "income_change", "stated_income", "stated_occupancy"];
export function proposeRestructure(events: EventStore, i: { application_id: string; trigger_submission_id: string | null; lever: Lever; from: Record<string, unknown>; initiated_by: "sm" | "borrower"; at: string; changed_circumstance_id?: string | null }, actor: Actor = AGENT): { proposal: RestructureProposal; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id");
  if (FORBIDDEN_LEVERS.includes(i.lever.kind) || i.lever.to.occupancy !== undefined || i.lever.to.monthly_income_cents !== undefined) throw new InterpretationRefused("RESTRUCTURE_CHANGES_OCCUPANCY_OR_INCOME", "23.2 guardrails: never propose a restructure that changes the borrower's stated occupancy or income", `lever ${i.lever.kind} would change occupancy or income`);
  const regb_treatment = regbTreatment(i.initiated_by);
  const proposal: RestructureProposal = { proposal_id: `rp:${i.application_id}:${i.lever.kind}:${i.at}`, application_id: i.application_id, trigger_submission_id: i.trigger_submission_id, kind: i.lever.kind, from: i.from, to: i.lever.to, expected_recommendation: i.lever.expected_recommendation, expected_dti_bps: i.lever.pitia.dti_bps, expected_dti_display: i.lever.pitia.dti_display,
    arithmetic: { pi_cents: i.lever.pitia.pi_cents.toString(), mi_cents: i.lever.pitia.mi_cents.toString(), taxes_cents: i.lever.pitia.taxes_cents.toString(), insurance_cents: i.lever.pitia.insurance_cents.toString(), debts_cents: i.lever.pitia.debts_cents.toString(), obligations_cents: i.lever.pitia.obligations_cents.toString(), ltv_display: i.lever.pitia.ltv_display, note: i.lever.note },
    regb_treatment, changed_circumstance_id: i.changed_circumstance_id ?? null, status: "proposed", proposed_at: i.at, decided_at: null, reviewer_id: null, initiated_by: i.initiated_by };
  const event = emit(events, i.application_id, "restructure.proposed", { proposal_id: proposal.proposal_id, kind: proposal.kind, source_process: "23.2", trigger_submission_id: i.trigger_submission_id, from: i.from, to: proposal.to, expected_recommendation: proposal.expected_recommendation, expected_dti_bps: proposal.expected_dti_bps, expected_dti_display: proposal.expected_dti_display, regb_treatment, requires_reviewer_before_borrower_contact: regb_treatment === "counteroffer", reviewer_role: regb_treatment === "counteroffer" ? "underwriting_reviewer" : null, consumers: ["21.5", "20.4", "23.1", ...(regb_treatment === "counteroffer" ? ["21.6", "23.3"] : [])] }, i.at, actor);
  return { proposal, event };
}
/** Borrower acceptance → 21.5 changed circumstance (loan amount / term / product are always changed-circumstance events) and 20.4 repricing before 23.1 resubmits; a counteroffer was communicated only after `underwriting_reviewer` approval. */
export function acceptRestructure(events: EventStore, p: RestructureProposal, i: { at: string; reviewer_id: string | null; changed_circumstance_id: string }, actor: Actor = AGENT): { proposal: RestructureProposal; event: DomainEvent } {
  need(p.status === "proposed", `proposal ${p.proposal_id} is ${p.status}`);
  if (p.regb_treatment === "counteroffer" && !i.reviewer_id) throw new InterpretationRefused("COUNTEROFFER_NEEDS_REVIEWER", "23.2 guardrails: never send a counteroffer or denial without `underwriting_reviewer`", `counteroffer ${p.proposal_id} has no reviewer approval`);
  const proposal: RestructureProposal = { ...p, status: "accepted", decided_at: i.at, reviewer_id: i.reviewer_id, changed_circumstance_id: i.changed_circumstance_id };
  const event = emit(events, p.application_id, "restructure.accepted", { proposal_id: p.proposal_id, kind: p.kind, to: p.to, regb_treatment: p.regb_treatment, changed_circumstance_id: i.changed_circumstance_id, reason: p.regb_treatment === "counteroffer" ? "counteroffer_accepted" : "borrower_request", consumers: ["21.5", "20.4", "23.1"] }, i.at, actor);
  return { proposal, event };
}
/** 21.6's REGB_1002_9_COUNTEROFFER_90 expiry → the proposal is marked expired (edge case "Counteroffer not accepted within 90 days"). */
export function expireRestructure(events: EventStore, p: RestructureProposal, at: string, actor: Actor = AGENT): { proposal: RestructureProposal; event: DomainEvent } {
  need(p.status === "proposed", `proposal ${p.proposal_id} is ${p.status}`);
  const proposal: RestructureProposal = { ...p, status: "expired", decided_at: at };
  return { proposal, event: emit(events, p.application_id, "restructure.expired", { proposal_id: p.proposal_id, kind: p.kind, regb_treatment: p.regb_treatment, cause: "REGB_1002_9_COUNTEROFFER_90" }, at, actor) };
}

// ============================================================ rule 1 — recommendation policy; rule 8 — drift
const RANK: Record<Recommendation, number> = { approve_eligible: 0, approve_ineligible: 1, refer_with_caution: 2, out_of_scope: 3, error: 4 };
export function policyOutcome(rec: Recommendation, restructure_feasible: boolean): PolicyOutcome {
  switch (rec) {
    case "approve_eligible": return "proceed";
    case "approve_ineligible": case "refer_with_caution": return restructure_feasible ? "restructure_required" : "decline_candidate";
    case "out_of_scope": return "out_of_policy_manual";
    case "error": return "error";
  }
}
export const lawfulPaths = (outcome: PolicyOutcome): DuFindingsInterpretation["lawful_paths"] =>
  outcome === "proceed" ? ["proceed"] : outcome === "error" ? ["retry_23_1"] : outcome === "restructure_required" ? ["borrower_accepted_restructure", "regb_counteroffer", "regb_denial"] : ["regb_counteroffer", "regb_denial"];
/** The DU release a casefile's policy generation cites (creation-keyed generations: pre-June 27 → March 21; June 27 → June 26; Sept 26 → Sept 25). */
export function releaseForGeneration(g: PolicyGeneration): { key: string; evening_of: PlainDate } {
  const key = g === "pre_2026_06_27" ? "2026_03_21" : g === "2026_06_27" ? "2026_06_26" : "2026_09_25";
  const r = DU_RELEASES.find((x) => x.key === key)!; return { key: r.key, evening_of: r.evening_of };
}
export interface DriftInput { readonly prior: { recommendation: Recommendation; request_hash: string } | null; readonly current: { recommendation: Recommendation; request_hash: string }; readonly policy_generation: PolicyGeneration; }
/** A worse recommendation with no data change (same request hash) is DU policy drift: cite the release. */
export function recommendationDrift(i: DriftInput): RecommendationDrift | null {
  if (!i.prior || i.prior.recommendation === i.current.recommendation) return null;
  if (RANK[i.current.recommendation] <= RANK[i.prior.recommendation]) return null;
  const cause: RecommendationDrift["cause"] = i.prior.request_hash === i.current.request_hash ? "du_policy" : "data_change";
  const rel = releaseForGeneration(i.policy_generation);
  return { cause, from: i.prior.recommendation, to: i.current.recommendation, du_release: rel.key, du_release_date: rel.evening_of, policy_generation: i.policy_generation };
}

// ============================================================ the interpretation (one per submission)
export interface ApplicationFacts {
  readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out"; readonly product: MiProduct; readonly term_months: number; readonly arm?: boolean; readonly ltv_x100: number; readonly loan_amount_cents: Cents; readonly units: 1 | 2 | 3 | 4; readonly county_limit_cents: Cents | null;
  readonly score_model: "classic_fico" | "vantagescore_4" | null; readonly borrower_ids: readonly string[]; readonly all_occupying_first_time: boolean; readonly all_borrowers_first_time: boolean; readonly du_no_tradelines: boolean; readonly closing_date: PlainDate | null; readonly credit_expiration_date?: PlainDate | null;
  readonly community_seconds?: boolean; readonly temporary_buydown?: boolean; readonly inter_vivos_trust?: boolean; readonly texas_50a6?: boolean; readonly value_acceptance_exercised?: boolean; readonly va_pd_exercised?: boolean; readonly counseling_credit?: boolean;
}
export interface InterpretInput {
  readonly application_id: string; readonly submission_id: string; readonly submission_number: number; readonly is_final: boolean; readonly recommendation: Recommendation; readonly messages: readonly DuMessage[]; readonly validation_results: readonly ValidationResult[];
  readonly value_acceptance_offer: { offered: boolean; property_value_cents?: Cents; kind?: "value_acceptance" | "value_acceptance_pd" } | null; readonly mi_requirement: { required: boolean; coverage_pct: string | null } | null;
  readonly du_release: string; readonly policy_generation: PolicyGeneration; readonly request_hash: string; readonly findings_received_at: string; readonly interpreted_at: string;
  readonly facts: ApplicationFacts; readonly rules?: readonly DuMessageRule[]; readonly prior_conditions?: readonly Condition[]; readonly prior?: { recommendation: Recommendation; request_hash: string } | null; readonly financials?: StructureFinancials | null; readonly agent_decision_id?: string | null;
}
export interface InterpretResult {
  readonly interpretation: DuFindingsInterpretation; readonly mapped: readonly MappedMessage[]; readonly conditions: Condition[]; readonly superseded: Condition[]; readonly investigations: Investigation23[]; readonly triage: TriageItem[]; readonly education: EducationRecord[]; readonly restructure: RestructureComputation | null; readonly proposals: RestructureProposal[]; readonly events: DomainEvent[];
}
/** Rules 1–9 over one `du.findings.received` payload: map every message, open/supersede conditions, open red-flag investigations, set MI / value acceptance / SFCs / education, compute restructures, emit `du.findings.interpreted` last (SM_DU_CONDITIONS_SLA_4H). */
export function interpretFindings(events: EventStore, i: InterpretInput, actor: Actor = AGENT): InterpretResult {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.submission_id, "submission_id"); nonEmpty(i.du_release, "du_release"); nonEmpty(i.interpreted_at, "interpreted_at");
  const at = i.interpreted_at; const rules = i.rules ?? DU_MESSAGE_RULES_2026_09_25; const out: DomainEvent[] = [];
  const mapped = mapMessages(i.messages, rules, i.du_release); const ids = i.messages.map((m) => m.id);
  const conditions: Condition[] = [], investigations: Investigation23[] = [], triage: TriageItem[] = [], structural: StructuralReason[] = [];
  let homeready_message = false, mi_condition_opened = false;
  const open = (o: Omit<OpenConditionInput, "application_id" | "submission_id" | "opened_at" | "message_ids">) => { const r = openCondition(events, { ...o, application_id: i.application_id, submission_id: i.submission_id, opened_at: at, message_ids: ids }, actor); conditions.push(r.condition); out.push(r.event); return r.condition; };
  const fromRule = (m: DuMessage, r: DuMessageRule) => open({ template_code: r.condition_template_code!, category: r.category, stage: r.stage ?? "ptd", text: r.borrower_text ?? UNMAPPED_BORROWER_TEXT, internal_text: `${m.id}: ${m.text}`, borrower_id: m.borrower_id ?? null, du_message_id: m.id, evidence_kinds: r.evidence_kinds, auto_clear_rule: r.auto_clear_rule, ...(r.requires_role ? { requires_role: r.requires_role } : {}) });
  for (const mm of mapped) {
    const m = mm.message, r = mm.rule;
    if (!r) {   // never dropped: triage + generic PTD condition (rule 2)
      const c = open({ template_code: UNMAPPED_TEMPLATE, category: "compliance", stage: "ptd", text: UNMAPPED_BORROWER_TEXT, internal_text: `${m.id} (${i.du_release}, unmapped): ${m.text}`, borrower_id: m.borrower_id ?? null, du_message_id: m.id, requires_role: "underwriting_reviewer" });
      triage.push({ triage_id: `triage:${i.submission_id}:${m.id}`, application_id: i.application_id, submission_id: i.submission_id, message_id: m.id, du_release: i.du_release, du_text: m.text, condition_id: c.condition_id, status: "queued", queued_at: at });
      out.push(emit(events, i.application_id, "du.message.unmapped", { message_id: m.id, du_release: i.du_release, condition_id: c.condition_id, queue: "du_message_triage", reviewer_role: "underwriting_reviewer" }, at, actor));
      continue;
    }
    switch (r.action) {
      case "open_condition": fromRule(m, r); break;
      case "open_investigation": { const v = openRedFlagInvestigation(events, { application_id: i.application_id, submission_id: i.submission_id, message_id: m.id, red_flag: r.red_flag ?? "occupancy_modified", du_text: m.text, at }, actor); investigations.push(v.investigation); out.push(v.event); break; }
      case "structural_ineligible": structural.push({ message_id: m.id, reason_code: r.reason_code ?? "STRUCTURAL", lever: r.lever ?? null, text: m.text }); if (r.condition_template_code) fromRule(m, r); break;
      case "mi_requirement": if (i.mi_requirement?.required && r.condition_template_code && !mi_condition_opened) { fromRule(m, r); mi_condition_opened = true; } break;
      case "offer": if (r.section === "homeready") homeready_message = true; else if (r.reason_code === "VALUE_ACCEPTANCE_PD" && i.value_acceptance_offer?.offered && r.condition_template_code) fromRule(m, r); break;
      case "sfc_required": case "sfc_optional": case "record_only": break;
    }
  }
  if (i.mi_requirement?.required && !mi_condition_opened) { const r = findRule(rules, "M2001", i.du_release); if (r) fromRule({ id: "M2001", category: "mi", text: `MI coverage ${i.mi_requirement.coverage_pct}% required` }, r); mi_condition_opened = true; }
  // rule 3 — MI: DU's stated coverage vs the B7-1-02 table for the band
  const table = miCoverage(i.facts.ltv_x100, i.facts.product, i.facts.term_months, i.facts.arm ?? false);
  const mi_coverage_pct = i.mi_requirement?.required ? (i.mi_requirement.coverage_pct ?? table.required_pct) : null;
  const miCond = conditions.find((c) => c.template_code === "COND_DU_MI_CERT") ?? null;
  out.push(emit(events, i.application_id, "mi.requirement.set", { submission_id: i.submission_id, mi_required: mi_coverage_pct !== null, mi_coverage_pct, standard_coverage_pct: table.standard_pct, minimum_option_pct: table.minimum_option_pct, product: i.facts.product, band: table.band, condition_id: miCond?.condition_id ?? null, consumers: ["24.6", "20.4"] }, at, actor));
  // rule 4 — value acceptance: only the final submission's offer is exercisable
  const offer = valueAcceptanceOffer(i.value_acceptance_offer);
  out.push(emit(events, i.application_id, "value_acceptance.offer.received", { submission_id: i.submission_id, submission_number: i.submission_number, offer, is_final: i.is_final, sfc_801_permitted: i.is_final && offer !== "none", property_value_cents: i.value_acceptance_offer?.property_value_cents?.toString() ?? null, offer_at: offer === "none" ? null : i.findings_received_at, consumers: ["24.1"] }, at, actor));
  // HomeReady flag / education requirement
  if (homeready_message && i.facts.product !== "homeready") out.push(emit(events, i.application_id, "homeready.candidate.flagged", { source: "du_message", submission_id: i.submission_id }, at, actor));
  const basis = educationBasis({ purchase: i.facts.transaction_type === "purchase", homeready: i.facts.product === "homeready", all_occupying_first_time: i.facts.all_occupying_first_time, all_borrowers_first_time: i.facts.all_borrowers_first_time, ltv_x100: i.facts.ltv_x100, du_no_tradelines: i.facts.du_no_tradelines });
  const edu = requireEducation(events, { application_id: i.application_id, borrower_ids: i.facts.borrower_ids, basis, closing_date: i.facts.closing_date, at }, actor); if (edu.event) out.push(edu.event);
  if (basis !== "none" && !conditions.some((c) => c.template_code === "COND_FNMA_B2_2_06_EDUCATION")) { const r = findRule(rules, "H7002", i.du_release); if (r) fromRule({ id: "H7002", category: "homeready", text: "Homeownership education required" }, r); }
  // rule 5 / 9 — high balance and SFCs (post-closing delivery conditions)
  const limits = loanLimitCheck(i.facts.loan_amount_cents, i.facts.units, i.facts.county_limit_cents);
  const sfc_required = sfcAssembly({ transaction_type: i.facts.transaction_type, score_model: i.facts.score_model, homeready: i.facts.product === "homeready", counseling_credit: i.facts.counseling_credit ?? false, value_acceptance_exercised: i.facts.value_acceptance_exercised ?? false, va_pd_exercised: i.facts.va_pd_exercised ?? false, high_balance: limits.high_balance, community_seconds: i.facts.community_seconds ?? false, temporary_buydown: i.facts.temporary_buydown ?? false, inter_vivos_trust: i.facts.inter_vivos_trust ?? false, texas_50a6: i.facts.texas_50a6 ?? false });
  for (const code of sfc_required) open({ template_code: `${SFC_CONDITION_PREFIX}${code}`, category: "compliance", stage: "post_closing", text: "", internal_text: `ULDD SFC ${code} (29.3)`, borrower_visible: false, evidence_kinds: ["uldd_sfc"] });
  // rule 8 — drift; rule 1 — policy outcome; rule 7 — restructure
  const drift = recommendationDrift({ prior: i.prior ?? null, current: { recommendation: i.recommendation, request_hash: i.request_hash }, policy_generation: i.policy_generation });
  if (drift) out.push(emit(events, i.application_id, "du.recommendation.changed", { submission_id: i.submission_id, cause: drift.cause, from: drift.from, to: drift.to, du_release: drift.du_release, du_release_date: drift.du_release_date, policy_generation: drift.policy_generation, outcome: "restructure_required" }, at, actor));
  const restructure = i.financials && (i.recommendation === "approve_ineligible" || i.recommendation === "refer_with_caution") ? computeRestructure(i.financials, { structural_reasons: structural, recommendation: i.recommendation }) : null;
  const feasible = restructure ? restructure.recommended !== null : structural.some((s) => s.lever !== null) || i.recommendation === "approve_ineligible" || i.recommendation === "refer_with_caution";
  const policy_outcome = policyOutcome(i.recommendation, feasible);
  const proposals: RestructureProposal[] = [];
  if (restructure?.recommended) { const p = proposeRestructure(events, { application_id: i.application_id, trigger_submission_id: i.submission_id, lever: restructure.recommended, from: { loan_amount_cents: i.financials!.loan_amount_cents.toString(), product: i.financials!.product, dti_display: restructure.current.dti_display }, initiated_by: "sm", at }, actor); proposals.push(p.proposal); out.push(p.event); }
  // supersession of conditions whose message disappeared (rule "message present on n, absent on n+1")
  const sup = supersedeDroppedConditions(events, i.prior_conditions ?? [], new Set(ids), { submission_id: i.submission_id, at }, actor); out.push(...sup.events);
  const relief = { income: i.validation_results.some((v) => v.component === "income" && v.outcome === "validated"), employment: i.validation_results.some((v) => v.component === "employment" && v.outcome === "validated"), assets: i.validation_results.some((v) => v.component === "assets" && v.outcome === "validated"), undisclosed_debt: false };
  const close_by = i.validation_results.find((v) => v.component === "employment" && v.outcome === "validated" && v.close_by_date)?.close_by_date ?? null;
  const interpretation: DuFindingsInterpretation = {
    interpretation_id: `interp:${i.submission_id}`, application_id: i.application_id, submission_id: i.submission_id, submission_number: i.submission_number, is_final: i.is_final, recommendation: i.recommendation, policy_generation: i.policy_generation, du_release: i.du_release, policy_outcome,
    structural_reasons: structural, conditions_opened: conditions.length, ptd_conditions_opened: conditions.filter((c) => c.stage === "ptd").length, investigations_opened: investigations.length, unmapped_messages: triage.length,
    mi_coverage_pct, mi_standard_coverage_pct: table.standard_pct, mi_min_coverage_option: false, value_acceptance_offer: offer, value_acceptance_offer_at: offer === "none" ? null : i.findings_received_at, sfc_801_permitted: i.is_final && offer !== "none",
    homeready_message, sfc_required, close_by_date: close_by, credit_expiration_date: i.facts.credit_expiration_date ?? null, relief_components: relief,
    decline_candidate: restructure?.decline_candidate ?? (i.recommendation !== "approve_eligible" && i.recommendation !== "error"), manual_underwriting_offered: false, lawful_paths: lawfulPaths(policy_outcome), recommendation_drift: drift, interpreted_at: at, agent_decision_id: i.agent_decision_id ?? null,
  };
  out.push(emit(events, i.application_id, "du.findings.interpreted", { interpretation_id: interpretation.interpretation_id, submission_id: i.submission_id, submission_number: i.submission_number, is_final: i.is_final, recommendation: i.recommendation, policy_outcome, conditions_opened: conditions.length, ptd_conditions_opened: interpretation.ptd_conditions_opened, conditions_materialized: true, investigations_opened: investigations.length, unmapped_messages: triage.length,
    value_acceptance_offer: offer, sfc_required, mi_coverage_pct, structural_reasons: structural.map((s) => s.reason_code), decline_candidate: interpretation.decline_candidate, manual_underwriting_offered: false, close_by_date: close_by, relief_components: relief, findings_received_at: i.findings_received_at, sla: "SM_DU_CONDITIONS_SLA_4H", consumers: ["23.3", "24.1", "24.6", "29.3"] }, at, actor));
  return { interpretation, mapped, conditions, superseded: sup.superseded, investigations, triage, education: edu.records, restructure, proposals, events: out };
}

// ============================================================ decision record (AI agent design)
export interface DecisionRecord23_2 { readonly submission_id: string; readonly recommendation: Recommendation; readonly policy_generation: PolicyGeneration; readonly messages: readonly { id: string; section: string; action: string; condition_id: string | null; investigation_id: string | null }[]; readonly structural_reasons: readonly string[]; readonly homeready: Record<string, unknown> | null; readonly education: { basis: RequirementBasis; status: string } | null; readonly mi: { required_pct: string | null; selected_pct: string | null }; readonly value_acceptance: { offer: ValueAcceptanceOffer; exercisable_until: PlainDate | null }; readonly sfc: readonly string[]; readonly restructure_proposals: readonly string[]; readonly regb_treatment: RegBTreatment; readonly rationale: string; readonly model_version: string; readonly prompt_version: string; readonly rule_set_versions: typeof RULE_SETS_23_2; }
/** Reasons are specific (§1002.9(b)(2)); DU findings are a reason source, never the reason text. */
export function decisionRecord23_2(r: InterpretResult, o: { homeready?: HomeReadyEvaluation23 | null; model_version: string; prompt_version: string; rationale: string; note_date?: PlainDate | null }): DecisionRecord23_2 {
  if (DU_WORDS.test(o.rationale)) throw new InterpretationRefused("REASON_TEXT_NAMES_DU", "§1002.9(b)(2) / 00a-fed §3.1: DU findings are a reason source, never the reason text", "rationale must state the specific reason, not the DU recommendation");
  const byMsg = new Map(r.conditions.filter((c) => c.du_message_id).map((c) => [c.du_message_id!, c.condition_id])); const byInv = new Map(r.investigations.map((v) => [v.message_id, v.investigation_id]));
  const edu = r.education[0] ?? null;
  return { submission_id: r.interpretation.submission_id, recommendation: r.interpretation.recommendation, policy_generation: r.interpretation.policy_generation, messages: r.mapped.map((m) => ({ id: m.message.id, section: m.section, action: m.action, condition_id: byMsg.get(m.message.id) ?? null, investigation_id: byInv.get(m.message.id) ?? null })),
    structural_reasons: r.interpretation.structural_reasons.map((s) => s.reason_code), homeready: o.homeready ? { ami: o.homeready.ami_annual_cents.toString(), limit: o.homeready.income_limit_annual_cents.toString(), income: o.homeready.qualifying_income_annual_cents.toString(), eligible: o.homeready.eligible, source: o.homeready.ami_source } : null,
    education: edu ? { basis: edu.requirement_basis, status: edu.status } : null, mi: { required_pct: r.interpretation.mi_coverage_pct, selected_pct: r.interpretation.mi_coverage_pct }, value_acceptance: { offer: r.interpretation.value_acceptance_offer, exercisable_until: r.interpretation.value_acceptance_offer_at ? addMonths(D(r.interpretation.value_acceptance_offer_at.slice(0, 10)), 4) : null },
    sfc: r.interpretation.sfc_required, restructure_proposals: r.proposals.map((p) => p.proposal_id), regb_treatment: r.proposals[0]?.regb_treatment ?? "none", rationale: o.rationale, model_version: o.model_version, prompt_version: o.prompt_version, rule_set_versions: RULE_SETS_23_2 };
}
export const newId = (): string => randomUUID();
