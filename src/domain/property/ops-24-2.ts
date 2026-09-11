/**
 * §24.2 Appraisal receipt, UCDP/Collateral Underwriter review, reconsideration of value, appraisal quality/bias
 * controls, Reg B delivery and HPML appraisal rules — pure rule functions the `valuation` agent runs (one small
 * function per rule / T-id) plus the event recorders that arm and close the 24.2 timers.
 *
 * Seams (reused, never re-implemented):
 *   24.1 (in flight) emits `valuation.received` / `valuation.assigned`; this file consumes `valuation.received` (R1) and
 *        emits `valuation.revision.received` for every later version.
 *   23.4 (src/domain/underwriting/ops-23-4.ts) owns `hpml_determinations` and `compliance.hpml.determined{is_hpml,
 *        appraisal_rules_apply}`; its hpmlAppraisalCopyGate is REUSED for REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD.
 *   25.1 owns the `regz.hpml` rule set (2026 appraisal exemption threshold $34,200) — read through ruleSet().
 *   Notice Registry (src/notices) renders NTC_REGB_1002_14_VALUATION_COPY / NTC_FNMA_B4_1_3_12_ROV_DISCLOSURE /
 *        NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY / NTC_REGB_1002_14_COPY_NOT_CONSUMMATED (src/notices/authored/section24-2.ts).
 *   UCDP is a port (`UcdpPort`, wired as runtime service "ucdp") with FakeUcdp — the SSR / Doc File ID behaviour it
 *        models is [PARTIALLY VERIFIED] Fannie Mae material (UCDP Overview Sept 2025; Messaging Guide June 2026).
 *
 * Business-day unit: `business_days_creditor` for §1002.14 and §1026.35(c)(6) (spec "Unit decision"). Counting: copy
 * day D → earliest consummation = D + 3 business days (copy Tue Nov 3 → Fri Nov 6). Mailed copies: provided three
 * business days after mailing or on evidenced receipt, whichever earlier (comment 14(a)(1)-4).
 *
 * Events (every one carries `applicationId`, so the 24.2 timers arm under origination context — engine.ts isOriginationContext):
 *   valuation.revision.received{version_no}                 valuation.ucdp.submitted{gse, both_gses, doc_file_id}
 *   valuation.ucdp.result.received{gse, status, result_at}   valuation.cu.scored{cu_score, enhanced_review_required, scored_at}
 *   valuation.review.completed{review_status, completion_at} valuation.review.enhanced.recorded{comparable_reanalysis}
 *   valuation.correction.requested                           valuation.bias.flagged / valuation.discrimination.referred
 *   valuation.copy.delivered{version, is_final_version, hpml} valuation.copy.waiver.requested / valuation.copy.waived
 *   valuation.not_consummated.determined{determination_at, hpml_appraisal_rules_apply}
 *   rov.requested{requested_at} rov.screened rov.forwarded{sent_to_appraiser_at} rov.response.received rov.closed{outcome}
 *   hpml.second_appraisal.required                           valuation.value_used.set{value_used_cents, value_basis}
 */
import { Decimal } from "../../kernel/money/decimal.ts";
import { type Cents, centsToDecimal } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween, plainDate, min as minDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { ruleSet, type HpmlRuleSet } from "../compliance-disclosures/ops-25-1.ts";
import { hpmlAppraisalCopyGate, type QmType, type GateOutcome } from "../underwriting/ops-23-4.ts";

export const AGENT_24_2: Actor = { kind: "agent", id: "valuation" };
export const RULE_SETS_24_2 = { regb: "regb.2013", regz_hpml: "regz.hpml", fnma_selling: "fnma.selling.2026-09-02", fnma_uad: "fnma.uad.3.6", appraisal_language: "rule_sets.fnma.appraisal_language.2025-06" } as const;
const need = (cond: unknown, msg: string): void => { if (!cond) throw new RangeError(msg); };
const isDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** The civil date of an instant on the creditor's calendar clock (America/New_York, as the timer engine anchors — 17:59 MST Tue Nov 3 is still Nov 3); a bare date passes through. */
export const dateOf = (iso: string): PlainDate => (/^\d{4}-\d{2}-\d{2}T/.test(iso) ? wallClock(Date.parse(iso), creditor.timeZone).date : plainDate(iso.slice(0, 10)));
const r4 = (d: Decimal): number => Number(d.toFixed(4, "HALF_UP"));

// ============================================================ data model (appraisals, ucdp_submissions, valuations, rov_requests)
export type UcdpStatus = "not_submitted" | "pending" | "successful" | "not_successful";
export type ReviewStatus = "pending" | "ucdp_pending" | "ucdp_successful" | "ucdp_not_successful" | "override_requested" | "in_review" | "accepted" | "correction_requested" | "field_review_ordered" | "second_appraisal_ordered" | "rejected";
export type Gse = "fnma" | "fhlmc";
export type AppraisalForm = "1004" | "1004_desktop" | "1004_hybrid" | "1004C" | "1025" | "1073" | "1073_hybrid" | "2090" | "urar_uad36";
export type ValueBasis = "appraised" | "purchase_price" | "lower_of_two";
export type CopyReceiptEvidence = "esign_confirmed" | "portal_viewed" | "mailbox_rule" | "in_person";
export interface CuFlags { readonly overvaluation: boolean; readonly undervaluation: boolean; readonly property_eligibility_policy: boolean; readonly appraisal_quality: boolean; }
export const NO_CU_FLAGS: CuFlags = { overvaluation: false, undervaluation: false, property_eligibility_policy: false, appraisal_quality: false };
export type BiasSeverity = "none" | "low" | "medium" | "high";
export interface BiasScanResult { readonly terms_hit: readonly string[]; readonly demographic_references: readonly string[]; readonly severity: BiasSeverity; readonly factual_support: readonly string[]; readonly rule_set: string; }
export interface AppraisalVersion {
  readonly appraisal_id: string; readonly application_id: string; readonly valuation_order_id: string | null; readonly version_no: number; readonly is_final_version: boolean;
  readonly received_at: string; readonly completion_at: string | null; readonly effective_date: PlainDate; readonly appraiser_party_id: string; readonly form: AppraisalForm; readonly uad_version: "2.6" | "3.6";
  readonly appraised_value_cents: Cents; readonly condition_rating: string | null; readonly quality_rating: string | null;
  readonly ucdp_status: UcdpStatus; readonly doc_file_id: string | null; readonly cu_score: number | null; readonly cu_flags: CuFlags; readonly hard_stops: readonly UcdpFinding[];
  readonly review_status: ReviewStatus; readonly bias_scan_result: BiasScanResult | null; readonly value_used_cents: Cents | null; readonly value_basis: ValueBasis | null;
  readonly rw_relief_property_value: boolean; readonly hpml_second_appraisal: boolean; readonly copy_required_by: PlainDate | null; readonly copy_delivered_at: string | null; readonly copy_receipt_evidence: CopyReceiptEvidence | null;
}
export type ValuationKind = "appraisal" | "appraisal_revision" | "appraisal_update" | "completion_report" | "avm_report" | "bpo" | "staff_value_document" | "field_review";
export interface ValuationRow { readonly valuation_id: string; readonly application_id: string; readonly kind: ValuationKind; readonly source_document_id: string; readonly developed_at: PlainDate; readonly delivered_at: string | null; readonly notice_id: string | null; readonly excluded_reason: string | null; }

// ============================================================ UCDP port (fake — [PARTIALLY VERIFIED] Fannie Mae material)
export type UcdpSeverity = "fatal" | "overridable" | "warning";
export interface UcdpFinding { readonly code: string; readonly severity: UcdpSeverity; readonly message: string; readonly overridable: boolean; }
export interface UcdpSsr { readonly gse: Gse; readonly status: "successful" | "not_successful"; readonly doc_file_id: string; readonly findings: readonly UcdpFinding[]; readonly cu_score: number | null; readonly cu_flags: CuFlags; readonly result_at: string; readonly api_correlation_id: string; }
export interface UcdpSubmission { readonly appraisal_id: string; readonly version_no: number; readonly gse: Gse; readonly doc_file_id: string | null; readonly submitted_at: string; readonly package_hash: string; }
export interface UcdpPort {
  /** Direct Integration submit; idempotent by (appraisal_id, version_no, gse); a resubmission keeps the Doc File ID (UCDP Overview: "One Doc File ID is assigned per loan"). */
  submit(s: UcdpSubmission): Promise<{ doc_file_id: string; api_correlation_id: string }> | { doc_file_id: string; api_correlation_id: string };
  /** Appraisal Findings Summary API: status, findings (severity-ordered Fatal, Overridable, Warning), CU score/flags. */
  findings(appraisal_id: string, version_no: number, gse: Gse): Promise<UcdpSsr | null> | UcdpSsr | null;
}
/** In-memory UCDP for tests and the sandbox: scripted SSRs per (appraisal_id, version_no, gse); Doc File IDs are per application and survive resubmission; another lender's Doc File ID is never reused (transfers). */
export class FakeUcdp implements UcdpPort {
  readonly submissions: (UcdpSubmission & { doc_file_id: string; api_correlation_id: string })[] = [];
  private readonly docFileIds = new Map<string, string>();
  private readonly scripted = new Map<string, Omit<UcdpSsr, "gse" | "doc_file_id" | "api_correlation_id">>();
  private seq = 0;
  private readonly docFileIdOf: (appraisal_id: string) => string;
  constructor(docFileIdOf: (appraisal_id: string) => string = () => "1200000123456") { this.docFileIdOf = docFileIdOf; }
  script(appraisal_id: string, version_no: number, gse: Gse, ssr: Omit<UcdpSsr, "gse" | "doc_file_id" | "api_correlation_id">): void { this.scripted.set(`${appraisal_id}:${version_no}:${gse}`, ssr); }
  submit(s: UcdpSubmission): { doc_file_id: string; api_correlation_id: string } {
    const existing = this.submissions.find((x) => x.appraisal_id === s.appraisal_id && x.version_no === s.version_no && x.gse === s.gse);
    if (existing) return { doc_file_id: existing.doc_file_id, api_correlation_id: existing.api_correlation_id };
    const doc_file_id = this.docFileIds.get(s.appraisal_id) ?? s.doc_file_id ?? this.docFileIdOf(s.appraisal_id);
    this.docFileIds.set(s.appraisal_id, doc_file_id);
    const rec = { ...s, doc_file_id, api_correlation_id: `ucdp-${++this.seq}` };
    this.submissions.push(rec);
    return { doc_file_id, api_correlation_id: rec.api_correlation_id };
  }
  findings(appraisal_id: string, version_no: number, gse: Gse): UcdpSsr | null {
    const sub = this.submissions.find((x) => x.appraisal_id === appraisal_id && x.version_no === version_no && x.gse === gse);
    if (!sub) return null;
    const s = this.scripted.get(`${appraisal_id}:${version_no}:${gse}`) ?? { status: "successful" as const, findings: [], cu_score: gse === "fnma" ? 1.9 : null, cu_flags: NO_CU_FLAGS, result_at: sub.submitted_at };
    return { gse, doc_file_id: sub.doc_file_id, api_correlation_id: sub.api_correlation_id, ...s, findings: sortFindings(s.findings) };
  }
}
const SEVERITY_ORDER: Record<UcdpSeverity, number> = { fatal: 0, overridable: 1, warning: 2 };
/** SSR findings "sorted by severity in the following order: Fatal, Overridable, Warning" (Messaging Guide). */
export const sortFindings = (f: readonly UcdpFinding[]): UcdpFinding[] => [...f].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

// ============================================================ R1 — receipt and pre-check
export interface ReportPackage { readonly appraisal_id: string; readonly application_id: string; readonly version_no: number; readonly uad_version: "2.6" | "3.6"; readonly has_xml: boolean; readonly has_pdf: boolean; readonly has_images: boolean; readonly lender_client_party_id: string; readonly partner_party_id: string; readonly appraiser_party_id: string; readonly ordered_appraiser_party_id: string; readonly appraiser_license_active: boolean; readonly effective_date: PlainDate; readonly ordered_form: AppraisalForm; readonly form: AppraisalForm; readonly received_at: string; }
export interface PreCheck { readonly ok: boolean; readonly failures: readonly string[]; readonly uad_2_6_fatal: boolean; }
export const UAD_26_FATAL_FROM: PlainDate = plainDate("2026-11-02");
/** Verify the package (UAD 3.6 ZIP with XML, PDF, images; or UAD 2.6 before Nov 2, 2026 — FNM0391), lender/client = partner, appraiser = order and license record, effective date and form match. */
export function preCheckReport(p: ReportPackage): PreCheck {
  const f: string[] = [];
  const received_on = dateOf(p.received_at);
  const uad_2_6_fatal = p.uad_version === "2.6" && received_on >= UAD_26_FATAL_FROM;
  if (uad_2_6_fatal) f.push("UAD 2.6 is fatal for submissions on/after 2026-11-02 (FNM0391)");
  if (p.uad_version === "3.6" && !(p.has_xml && p.has_pdf && p.has_images)) f.push("UAD 3.6 package needs XML, PDF and images");
  if (p.uad_version === "2.6" && !(p.has_xml && p.has_pdf)) f.push("UAD 2.6 package needs XML and PDF");
  if (p.lender_client_party_id !== p.partner_party_id) f.push("lender/client is not the partner");
  if (p.appraiser_party_id !== p.ordered_appraiser_party_id) f.push("appraiser does not match the order (24.1)");
  if (!p.appraiser_license_active) f.push("appraiser license record inactive (24.1)");
  if (p.form !== p.ordered_form) f.push(`form ${p.form} ≠ ordered ${p.ordered_form}`);
  if (p.effective_date > received_on) f.push("effective date after receipt");
  return { ok: f.length === 0, failures: f, uad_2_6_fatal };
}
/** SM_UCDP_SUBMIT_SLA_1BD: submit to both GSEs within 1 business day of receipt. */
export const ucdpSubmitDue = (received_on: PlainDate): PlainDate => addBusinessDays(received_on, 1, creditor);
/** SM_APPRAISAL_REVIEW_SLA_2BD: review within 2 business days of the UCDP result. */
export const reviewDue = (result_on: PlainDate): PlainDate => addBusinessDays(result_on, 2, creditor);

// ============================================================ R2 — UCDP/CU outcome routing
export type UcdpRoute = "correction_requested" | "override_requested" | "successful";
export interface UcdpRouting { readonly route: UcdpRoute; readonly fnma: UcdpSsr | null; readonly fhlmc: UcdpSsr | null; readonly ucdp_status: UcdpStatus; readonly doc_file_id: string | null; readonly correctable_stops: readonly UcdpFinding[]; readonly overridable_stops: readonly UcdpFinding[]; readonly non_overridable_stops: readonly UcdpFinding[]; readonly reason: string; }
/** Fannie Mae's SSR governs delivery to Fannie Mae; Freddie Mac "Not Successful" while Fannie Mae is Successful is recorded, no override needed for this execution (edge case). */
export function routeUcdpResult(ssrs: readonly UcdpSsr[]): UcdpRouting {
  const fnma = ssrs.find((s) => s.gse === "fnma") ?? null, fhlmc = ssrs.find((s) => s.gse === "fhlmc") ?? null;
  if (!fnma) return { route: "correction_requested", fnma, fhlmc, ucdp_status: "pending", doc_file_id: fhlmc?.doc_file_id ?? null, correctable_stops: [], overridable_stops: [], non_overridable_stops: [], reason: "Fannie Mae SSR not yet received" };
  const stops = fnma.findings.filter((x) => x.severity !== "warning");
  const overridable = stops.filter((x) => x.overridable), nonOverridable = stops.filter((x) => !x.overridable);
  if (fnma.status === "successful") return { route: "successful", fnma, fhlmc, ucdp_status: "successful", doc_file_id: fnma.doc_file_id, correctable_stops: [], overridable_stops: [], non_overridable_stops: [], reason: `Fannie Mae Successful (Doc File ID ${fnma.doc_file_id})${fhlmc && fhlmc.status !== "successful" ? "; Freddie Mac Not Successful recorded, no override needed for Fannie Mae delivery" : ""}` };
  // Not Successful: non-overridable (correctable) stops go back to the appraiser; policy stops needing an override → fnma_portal_operator (UI-only).
  const route: UcdpRoute = nonOverridable.length ? "correction_requested" : "override_requested";
  return { route, fnma, fhlmc, ucdp_status: "not_successful", doc_file_id: fnma.doc_file_id, correctable_stops: nonOverridable, overridable_stops: overridable, non_overridable_stops: nonOverridable, reason: route === "correction_requested" ? `Not Successful: ${nonOverridable.length} stop(s) need a corrected report from the appraiser` : `Not Successful: ${overridable.length} manually overridable stop(s) need a fnma_portal_operator override with a reason code (UI-only)` };
}
export interface OverridePackage { readonly finding_code: string; readonly reason_code: string; readonly justification: string; readonly requested_by: string; readonly ui_only: true; readonly approved_at: null; }
/** The AI-prepared override request the operator submits in the UCDP UI ("Manually Overridable" stops need a reason code); never approved by the agent. */
export function prepareOverride(f: UcdpFinding, i: { reason_code: string; evidence: string; requested_by?: string }): OverridePackage {
  need(f.overridable && f.severity === "overridable", `${f.code} is not a manually overridable hard stop — a corrected report or a new appraisal is required`);
  need(i.reason_code.trim() !== "" && i.evidence.trim() !== "", "override needs a reason code and a justification");
  return { finding_code: f.code, reason_code: i.reason_code, justification: `${f.message} — ${i.evidence}`, requested_by: i.requested_by ?? AGENT_24_2.id, ui_only: true, approved_at: null };
}
export type CuReviewTier = "standard" | "targeted" | "enhanced" | "manual_equivalent";
/** CU ≤ 2.5 and no flags → standard; 2.6–3.9 or any flag → targeted; ≥ 4.0 or Overvaluation → enhanced; 999 → manual-equivalent. */
export function cuReviewTier(cu_score: number | null, flags: CuFlags): { tier: CuReviewTier; enhanced_review_required: boolean; flagged: string[] } {
  const flagged = (Object.keys(flags) as (keyof CuFlags)[]).filter((k) => flags[k]);
  if (cu_score === null || cu_score === 999) return { tier: "manual_equivalent", enhanced_review_required: false, flagged };
  if (cu_score >= 4.0 || flags.overvaluation) return { tier: "enhanced", enhanced_review_required: true, flagged };
  if (cu_score > 2.5 || flagged.length) return { tier: "targeted", enhanced_review_required: false, flagged };
  return { tier: "standard", enhanced_review_required: false, flagged };
}
export const CU_SCORED_FORMS: readonly AppraisalForm[] = ["1004", "1073", "urar_uad36"];
/** A2-2-06: relief needs CU ≤ 2.5 and a Successful submission of a CU-analysed form (1004 / 1073 / UAD 3.6 URAR equivalent). */
export const rwReliefPropertyValue = (i: { cu_score: number | null; ucdp_status: UcdpStatus; form: AppraisalForm }): boolean => i.cu_score !== null && i.cu_score !== 999 && i.cu_score <= 2.5 && i.ucdp_status === "successful" && CU_SCORED_FORMS.includes(i.form);
export const cuHighRiskReviewDue = (scored_on: PlainDate): PlainDate => addBusinessDays(scored_on, 1, creditor);
export interface EnhancedReviewRecord { readonly appraisal_id: string; readonly cu_score: number; readonly cu_flags: CuFlags; readonly comparable_reanalysis: readonly { comp_id: string; distance_miles: number; sale_date: PlainDate; adjusted_price_cents: Cents; supported: boolean; note: string }[]; readonly field_review_recommended: boolean; readonly second_appraisal_recommended: boolean; readonly rw_relief_property_value: false; readonly recorded_at: string; }
export function enhancedReview(i: { appraisal_id: string; cu_score: number; cu_flags: CuFlags; comparables: readonly { comp_id: string; distance_miles: number; sale_date: PlainDate; adjusted_price_cents: Cents; supported: boolean; note?: string }[]; recorded_at: string }): EnhancedReviewRecord {
  need(i.comparables.length >= 3, "enhanced review re-analyses at least the three closed comparable sales (B4-1.3-08)");
  const unsupported = i.comparables.filter((c) => !c.supported);
  return { appraisal_id: i.appraisal_id, cu_score: i.cu_score, cu_flags: i.cu_flags, comparable_reanalysis: i.comparables.map((c) => ({ ...c, note: c.note ?? (c.supported ? "market-supported" : "adjustment not supported by paired sales") })),
    field_review_recommended: unsupported.length > 0, second_appraisal_recommended: false, rw_relief_property_value: false, recorded_at: i.recorded_at };
}

// ============================================================ R3 — review checklist, language scan, acceptance
export const PROHIBITED_TERMS: readonly string[] = ["pride of ownership", "no pride of ownership", "poor neighborhood", "good neighborhood", "crime", "high crime", "crime-ridden", "desirable neighborhood", "desirable location", "undesirable neighborhood", "undesirable location"];
export const PROTECTED_CHARACTERISTICS: readonly string[] = ["race", "color", "religion", "sex", "disability", "national origin", "familial status", "ethnic", "ethnicity", "hispanic", "asian", "black", "white", "immigrant", "church", "mosque", "synagogue", "temple"];
/** B4-1.1-04 prohibited-language scan: an unsupported subjective term is `high`; a term with cited factual support (e.g. "crime" inside a quoted police report) is `low` and routed to reasoned review; any protected-characteristic reference to occupants or neighbourhood composition is `high`. */
export function scanLanguage(narrative: string, factual_support: readonly string[] = []): BiasScanResult {
  const text = narrative.toLowerCase();
  const hit = (t: string) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  const terms = PROHIBITED_TERMS.filter(hit);
  // "no pride of ownership" contains "pride of ownership"; "undesirable neighborhood" is not a "desirable neighborhood" hit
  const terms_hit = terms.filter((t) => !terms.some((u) => u !== t && u.includes(t)));
  const demographic_references = PROTECTED_CHARACTERISTICS.filter(hit);
  const supported = terms_hit.filter((t) => factual_support.some((s) => s.toLowerCase().includes(t)));
  const unsupported = terms_hit.filter((t) => !supported.includes(t));
  const severity: BiasSeverity = demographic_references.length || unsupported.length ? "high" : supported.length ? "low" : "none";
  return { terms_hit, demographic_references, severity, factual_support: supported, rule_set: RULE_SETS_24_2.appraisal_language };
}
/** Template-locked correction request to the appraiser: restricted to the hit text and "factual re-description"; no values, targets or comparables (AIR). */
export function correctionRequestText(scan: BiasScanResult, stops: readonly UcdpFinding[] = []): string {
  const items = [...scan.terms_hit.map((t) => `Term "${t}" — please describe the property and market area in factual, unbiased and specific terms (B4-1.1-02).`), ...scan.demographic_references.map((d) => `Reference to "${d}" — remove any reference to protected characteristics of occupants or neighbourhood composition (B4-1.1-04).`), ...stops.map((s) => `UCDP ${s.code}: ${s.message}`)];
  need(items.length > 0, "nothing to correct");
  return `Correction request (template NTC-internal CR-24.2 v1). The lender requests a corrected report addressing the following items. This request contains no opinion of value.\n${items.map((x, n) => `${n + 1}. ${x}`).join("\n")}`;
}
export interface ChecklistInput { readonly closed_comparables: number; readonly adjustments_explained: boolean; readonly market_conditions_consistent: boolean; readonly gla_sqft: number; readonly application_gla_sqft: number | null; readonly units: number; readonly application_units: number; readonly condition_rating: string; readonly quality_rating: string; readonly subject_to: boolean; readonly narrative: string; readonly factual_support?: readonly string[]; readonly fnma_ssr: UcdpSsr | null; readonly cu_score: number | null; readonly cu_flags: CuFlags; readonly form: AppraisalForm; }
export interface ChecklistResult { readonly value_support: { pass: boolean; findings: string[] }; readonly property_data: { pass: boolean; findings: string[]; route_24_3: boolean }; readonly bias_scan: BiasScanResult; readonly cu: ReturnType<typeof cuReviewTier>; readonly review_status: ReviewStatus; readonly rw_relief_property_value: boolean; readonly correction_required: boolean; readonly fair_lending_record_required: boolean; }
export function applyReviewChecklist(i: ChecklistInput): ChecklistResult {
  const vs: string[] = [];
  if (i.closed_comparables < 3) vs.push("fewer than the three closed sales required (B4-1.3-08)");
  if (!i.adjustments_explained) vs.push("adjustments not explained");
  if (!i.market_conditions_consistent) vs.push("market-conditions addendum inconsistent");
  const pd: string[] = [];
  if (i.application_gla_sqft !== null && Math.abs(i.gla_sqft - i.application_gla_sqft) > 0.1 * i.application_gla_sqft) pd.push("GLA differs > 10% from application_properties");
  if (i.units !== i.application_units) pd.push("unit count differs from application_properties");
  const route_24_3 = ["C5", "C6"].includes(i.condition_rating) || i.quality_rating === "Q6" || i.subject_to;
  const bias_scan = scanLanguage(i.narrative, i.factual_support ?? []);
  const cu = cuReviewTier(i.cu_score, i.cu_flags);
  const ucdp_status: UcdpStatus = i.fnma_ssr ? (i.fnma_ssr.status === "successful" ? "successful" : "not_successful") : "pending";
  const correction_required = bias_scan.severity === "high" || bias_scan.severity === "medium" || vs.length > 0;
  const review_status: ReviewStatus = ucdp_status !== "successful" ? (ucdp_status === "pending" ? "ucdp_pending" : "ucdp_not_successful") : correction_required ? "correction_requested" : "accepted";
  return { value_support: { pass: vs.length === 0, findings: vs }, property_data: { pass: pd.length === 0, findings: pd, route_24_3 }, bias_scan, cu, review_status,
    rw_relief_property_value: review_status === "accepted" && rwReliefPropertyValue({ cu_score: i.cu_score, ucdp_status, form: i.form }) && !cu.enhanced_review_required, correction_required, fair_lending_record_required: bias_scan.severity !== "none" };
}
/** Reg B "completion": the last version received, or reviewed and accepted with corrections — whichever later (comment 14(a)(1)-4). */
export function completionAt(received_at: string, accepted_at: string | null): string | null { return accepted_at === null ? null : accepted_at > received_at ? accepted_at : received_at; }
/** Acceptance sets value_used: appraised for refinances; lower_of_two(appraised, purchase price) for purchases — never above the appraised value. */
export function valueUsed(i: { transaction_type: "purchase" | "refinance"; appraised_value_cents: Cents; purchase_price_cents?: Cents | null }): { value_used_cents: Cents; value_basis: ValueBasis } {
  need(i.appraised_value_cents > 0n, "appraised value required");
  if (i.transaction_type === "refinance" || i.purchase_price_cents === undefined || i.purchase_price_cents === null) return { value_used_cents: i.appraised_value_cents, value_basis: "appraised" };
  return i.purchase_price_cents < i.appraised_value_cents ? { value_used_cents: i.purchase_price_cents, value_basis: "lower_of_two" } : { value_used_cents: i.appraised_value_cents, value_basis: "appraised" };
}
/** LTV as a 4-decimal ratio (worked example: 56,000,000 / 80,000,000 = 0.7000 → 70.00 %). */
export function ltv(loan_amount_cents: Cents, value_used_cents: Cents): { ratio: number; pct_display: string } {
  need(value_used_cents > 0n, "value_used_cents required");
  const d = centsToDecimal(loan_amount_cents).div(centsToDecimal(value_used_cents));
  return { ratio: r4(d), pct_display: `${d.mul(Decimal.fromInt(100)).toFixed(2, "HALF_UP")}%` };
}

// ============================================================ R4 — Reg B copy engine (§1002.14; business_days_creditor)
export interface CopyPlan { readonly completion_on: PlainDate; readonly copy_due_prompt: PlainDate; readonly copy_due_gate: PlainDate | null; readonly copy_required_by: PlainDate; readonly earliest_consummation_if_copied_today: PlainDate; }
export function copyPlan(i: { completion_at: string; consummation_on?: PlainDate | null }): CopyPlan {
  const completion_on = dateOf(i.completion_at);
  const copy_due_prompt = addDays(completion_on, 7);
  const copy_due_gate = i.consummation_on ? addBusinessDays(i.consummation_on, -3, creditor) : null;
  return { completion_on, copy_due_prompt, copy_due_gate, copy_required_by: copy_due_gate ? minDate(copy_due_prompt, copy_due_gate) : copy_due_prompt, earliest_consummation_if_copied_today: addBusinessDays(completion_on, 3, creditor) };
}
export type CopyChannel = "electronic" | "in_person" | "mail";
/** When the copy counts as provided: electronic/in-person on the copy day; mailed three business days after mailing or on evidenced actual receipt, whichever earlier (comment 14(a)(1)-4). */
export function providedOn(i: { copied_on: PlainDate; channel: CopyChannel; actual_receipt_on?: PlainDate | null }): PlainDate {
  if (i.channel !== "mail") return i.copied_on;
  const mailbox = addBusinessDays(i.copied_on, 3, creditor);
  return i.actual_receipt_on && i.actual_receipt_on < mailbox ? i.actual_receipt_on : mailbox;
}
/** Copy day D → earliest consummation = D + 3 business_days_creditor (copy Tue Nov 3 → Fri Nov 6; Wed Nov 4 → Mon Nov 9). */
export const earliestConsummation = (provided_on: PlainDate): PlainDate => addBusinessDays(provided_on, 3, creditor);
export interface RegBCopyGateFacts { readonly consummation_on: PlainDate; readonly latest_version_provided_on: PlainDate | null; readonly waiver_obtained_on?: PlainDate | null; readonly copy_at_or_before_consummation?: boolean; }
export interface RegBCopyGateResult extends GateOutcome { readonly earliest_consummation: PlainDate | null; readonly proposed_consummation_on: PlainDate | null; readonly waiver_valid: boolean; }
/** REGB_1002_14_APPRAISAL_COPY_3BD_GATE (not_before gate on `consummate`): the latest version provided ≥ 3 business days before consummation, or a valid waiver (obtained ≥ 3 BD before) plus a copy at/before consummation. */
export function regBCopyGate(f: RegBCopyGateFacts): RegBCopyGateResult {
  const waiver_valid = f.waiver_obtained_on ? waiverDecision({ obtained_on: f.waiver_obtained_on, consummation_on: f.consummation_on }).accepted : false;
  if (waiver_valid) {
    const ok = f.copy_at_or_before_consummation === true || (f.latest_version_provided_on !== null && f.latest_version_provided_on <= f.consummation_on);
    return { open: ok, blocking_codes: ok ? [] : ["REGB_COPY_NOT_AT_OR_BEFORE_CONSUMMATION"], reason: ok ? null : "REGB_1002_14_APPRAISAL_COPY_3BD_GATE: timing waived, but copies are still due at or before consummation (§1002.14(a)(1))", earliest_consummation: null, proposed_consummation_on: null, waiver_valid };
  }
  if (f.latest_version_provided_on === null) return { open: false, blocking_codes: ["REGB_COPY_NOT_PROVIDED"], reason: "REGB_1002_14_APPRAISAL_COPY_3BD_GATE: the latest appraisal version has not been provided to the applicant", earliest_consummation: null, proposed_consummation_on: null, waiver_valid };
  const earliest = earliestConsummation(f.latest_version_provided_on);
  const open = earliest <= f.consummation_on;
  return { open, blocking_codes: open ? [] : ["REGB_COPY_LT_3BD"], reason: open ? null : `REGB_1002_14_APPRAISAL_COPY_3BD_GATE: copy provided ${f.latest_version_provided_on} → earliest consummation ${earliest} (3 business_days_creditor; §1002.14(a)(1)), scheduled ${f.consummation_on}`, earliest_consummation: earliest, proposed_consummation_on: open ? null : earliest, waiver_valid };
}
/** REGB_1002_14_WAIVER_3BD_GATE: the affirmative statement must itself be obtained no later than three business days prior to consummation; copies then due at or before consummation. */
export function waiverDecision(i: { obtained_on: PlainDate; consummation_on: PlainDate }): { accepted: boolean; latest_obtained_on: PlainDate; copies_due_at_or_before: PlainDate; reason: string } {
  const latest_obtained_on = addBusinessDays(i.consummation_on, -3, creditor);
  const accepted = i.obtained_on <= latest_obtained_on;
  return { accepted, latest_obtained_on, copies_due_at_or_before: i.consummation_on, reason: accepted ? `waiver obtained ${i.obtained_on} ≤ ${latest_obtained_on} (3 business_days_creditor before ${i.consummation_on}); copies still due at or before consummation` : `REGB_1002_14_WAIVER_3BD_GATE: waiver obtained ${i.obtained_on} after ${latest_obtained_on} — refused (§1002.14(a)(1) "no later than three business days prior to consummation"); the copy gate governs` };
}
export interface CopyPackage { readonly cover_template: "NTC_REGB_1002_14_VALUATION_COPY" | "NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY"; readonly valuations: readonly ValuationRow[]; readonly includes_rov_disclosure: boolean; readonly channel: CopyChannel; readonly recipients_all_applicants: true; readonly excluded: readonly ValuationRow[]; }
/** Package = cover (+ HPML variant) + every undelivered valuation + the ROV disclosure with the first version; all applicants; electronic only under an E-SIGN consent covering disclosures. */
export function buildCopyPackage(i: { valuations: readonly ValuationRow[]; hpml_appraisal_rules_apply: boolean; first_version: boolean; esign_consent_covers_disclosures: boolean }): CopyPackage {
  const undelivered = i.valuations.filter((v) => v.delivered_at === null && v.excluded_reason === null);
  need(undelivered.length > 0, "no undelivered valuation to copy");
  return { cover_template: i.hpml_appraisal_rules_apply ? "NTC_REGZ_1026_35C_HPML_APPRAISAL_COPY" : "NTC_REGB_1002_14_VALUATION_COPY", valuations: undelivered, includes_rov_disclosure: i.first_version, channel: i.esign_consent_covers_disclosures ? "electronic" : "mail", recipients_all_applicants: true, excluded: i.valuations.filter((v) => v.excluded_reason !== null) };
}
/** Comment 14(b)(3)-1/-3: AVM reports, BPOs and staff value documents are valuations; internal restatements and government assessed values are not; DU value-acceptance messages carry no estimate (open question 4). */
export function classifyValuation(kind: ValuationKind | "du_value_acceptance_message" | "internal_restatement" | "government_assessed_value"): { is_valuation: boolean; excluded_reason: string | null } {
  if (kind === "du_value_acceptance_message") return { is_valuation: false, excluded_reason: "no value estimate developed (open question 4)" };
  if (kind === "internal_restatement") return { is_valuation: false, excluded_reason: "comment 14(b)(3)-3: internal document merely restating the estimate" };
  if (kind === "government_assessed_value") return { is_valuation: false, excluded_reason: "comment 14(b)(3)-3: governmental agency statement of appraised value" };
  return { is_valuation: true, excluded_reason: null };
}

// ============================================================ R6 — reconsideration of value (B4-1.3-12)
export interface RovComparable { readonly address: string; readonly sale_price_cents: Cents; readonly sale_date: PlainDate; readonly source: string; }
export interface RovRequestInput { readonly rov_id: string; readonly appraisal_id: string; readonly application_id: string; readonly requested_by: "borrower" | "lender"; readonly requested_at: string; readonly borrower_names: readonly string[]; readonly property_address: string; readonly appraisal_effective_date: PlainDate; readonly appraiser_name: string; readonly disputed_areas: readonly string[]; readonly comparables: readonly RovComparable[]; }
export type RovScreenResult = "complete" | "incomplete" | "duplicate_rejected" | "post_closing_rejected";
export interface RovScreen { readonly screen_result: RovScreenResult; readonly reasons: readonly string[]; readonly sme_required: boolean; readonly appraiser_contact_allowed: boolean; readonly screen_due_on: PlainDate; readonly rejection_reason: string | null; }
export const ROV_MAX_COMPARABLES = 5;
export function screenRov(i: { request: RovRequestInput; prior_borrower_rovs_for_appraisal: number; consummated: boolean }): RovScreen {
  const r = i.request; const reasons: string[] = [];
  const screen_due_on = addBusinessDays(dateOf(r.requested_at), 2, creditor);
  if (r.requested_by === "borrower" && i.consummated) return { screen_result: "post_closing_rejected", reasons: ["B4-1.3-12: after a loan has closed, an ROV request is no longer allowed to be submitted by the borrower"], sme_required: false, appraiser_contact_allowed: false, screen_due_on, rejection_reason: "The loan has closed; a borrower reconsideration of value can no longer be submitted (Fannie Mae B4-1.3-12). You may raise a complaint through the complaint path." };
  if (r.requested_by === "borrower" && i.prior_borrower_rovs_for_appraisal > 0) return { screen_result: "duplicate_rejected", reasons: ["B4-1.3-12: only one borrower-initiated ROV is permitted per appraisal"], sme_required: false, appraiser_contact_allowed: false, screen_due_on, rejection_reason: "A borrower-initiated reconsideration of value has already been submitted for this appraisal; only one is permitted per appraisal (Fannie Mae B4-1.3-12). A lender-initiated ROV remains possible." };
  if (!r.borrower_names.length) reasons.push("borrower name(s) missing");
  if (!r.property_address) reasons.push("property address missing");
  if (!isDate(r.appraisal_effective_date)) reasons.push("effective date of the appraisal missing");
  if (!r.appraiser_name) reasons.push("appraiser name missing");
  if (!r.disputed_areas.length) reasons.push("identification of unsupported, inaccurate or deficient areas missing");
  if (r.comparables.length > ROV_MAX_COMPARABLES) reasons.push(`comparables exceed ${ROV_MAX_COMPARABLES} — ask the borrower to choose; do not forward more than five`);
  for (const c of r.comparables) if (!c.source) reasons.push(`comparable ${c.address} has no source`);
  const complete = reasons.length === 0;
  return { screen_result: complete ? "complete" : "incomplete", reasons, sme_required: complete, appraiser_contact_allowed: false, screen_due_on, rejection_reason: null };
}
export interface RovAnalysis { readonly comparable_relevance: readonly { address: string; relevant: boolean; note: string }[]; readonly data_conflicts: readonly string[]; readonly error_checks: readonly string[]; readonly recommendation: "forward" | "forward_partial" | "decline"; readonly rationale: string; }
/** The AI-prepared analysis for the designated SME (`underwriting_reviewer`): comparable relevance, data conflicts, error checks; the SME decides forward/decline — never the agent alone. */
export function prepareRovAnalysis(i: { request: RovRequestInput; subject_gla_sqft: number; subject_sale_dates_within_months?: number; appraisal_comparables: readonly { address: string }[] }): RovAnalysis {
  const rel = i.request.comparables.map((c) => { const dup = i.appraisal_comparables.some((a) => a.address.toLowerCase() === c.address.toLowerCase()); const stale = daysBetween(c.sale_date, i.request.appraisal_effective_date) > 365; return { address: c.address, relevant: !dup && !stale, note: dup ? "already used by the appraiser" : stale ? "sale more than 12 months before the effective date" : `sourced from ${c.source}` }; });
  const relevant = rel.filter((r) => r.relevant).length;
  const recommendation: RovAnalysis["recommendation"] = relevant === rel.length && relevant > 0 ? "forward" : relevant > 0 ? "forward_partial" : "decline";
  return { comparable_relevance: rel, data_conflicts: i.request.disputed_areas.map((d) => `disputed: ${d}`), error_checks: ["GLA adjustment arithmetic re-run", "sale dates and sources verified against MLS"], recommendation, rationale: `${relevant}/${rel.length} borrower comparables relevant; disputed areas: ${i.request.disputed_areas.join("; ") || "none"}` };
}
/** Standardized appraiser communication (template-locked): the ROV fields only — no value language, targets or comparables beyond the request's ≤ 5. */
export function rovCommunication(r: RovRequestInput, turn_time_due_on: PlainDate): string {
  need(r.comparables.length <= ROV_MAX_COMPARABLES, "no more than five comparables may be forwarded");
  return `Reconsideration of value request (template ROV-24.2 v1). Borrower(s): ${r.borrower_names.join(", ")}. Property: ${r.property_address}. Appraisal effective date: ${r.appraisal_effective_date}. Appraiser: ${r.appraiser_name}. Date of request: ${dateOf(r.requested_at)}.\nAreas identified as unsupported, inaccurate or deficient: ${r.disputed_areas.join("; ")}.\nAdditional data / comparables (${r.comparables.length}): ${r.comparables.map((c) => `${c.address} (sold ${c.sale_date}; source ${c.source})`).join("; ")}.\nPlease provide a revised appraisal report that includes commentary on your conclusions regardless of the outcome, within the turn-time expectation of five business days (due ${turn_time_due_on}). This communication contains no opinion of value.`;
}
/** FNMA_B4_1_3_12_ROV_TURNTIME_5BD: sent_to_appraiser + 5 business_days_creditor (Wed Oct 21 → Wed Oct 28: Oct 22, 23, 26, 27, 28). */
export const rovTurnTimeDue = (sent_on: PlainDate): PlainDate => addBusinessDays(sent_on, 5, creditor);
export type RovOutcome = "value_increased" | "value_decreased" | "no_change" | "withdrawn" | "declined";
export function rovOutcome(i: { original_value_cents: Cents; revised_value_cents: Cents | null; declined?: boolean; withdrawn?: boolean }): RovOutcome {
  if (i.withdrawn) return "withdrawn"; if (i.declined || i.revised_value_cents === null) return "declined";
  return i.revised_value_cents > i.original_value_cents ? "value_increased" : i.revised_value_cents < i.original_value_cents ? "value_decreased" : "no_change";
}
/** FNMA_B4_1_3_12_ROV_CLOSING_GATE: no borrower ROV after consummation. */
export function rovClosingGate(f: { consummated: boolean; requested_by: "borrower" | "lender" }): GateOutcome {
  const closed = f.consummated && f.requested_by === "borrower";
  return { open: !closed, blocking_codes: closed ? ["ROV_AFTER_CONSUMMATION"] : [], reason: closed ? "FNMA_B4_1_3_12_ROV_CLOSING_GATE: after a loan has closed, an ROV request is no longer allowed to be submitted by the borrower (B4-1.3-12)" : null };
}

// ============================================================ R7 — HPML appraisal rules (§1026.35(c))
export interface FlipTest { readonly days: number; readonly pct: number; readonly pct_display: string; readonly increase_cents: Cents; readonly second_appraisal_required: boolean; readonly basis: string; readonly exemption_code: string | null; }
/** (c)(4)(i): second appraisal when seller acquired ≤ 90 days before the contract and price > acquisition by > 10 %, or 91–180 days and > 20 % — unless a (c)(4)(vii) exemption is documented. */
export function flipTest(i: { contract_date: PlainDate; seller_acquisition_date: PlainDate; contract_price_cents: Cents; seller_acquisition_price_cents: Cents; exemption_code?: string | null }): FlipTest {
  need(i.seller_acquisition_price_cents > 0n, "seller acquisition price required");
  const days = daysBetween(i.seller_acquisition_date, i.contract_date);
  const increase_cents = i.contract_price_cents - i.seller_acquisition_price_cents;
  const pctD = centsToDecimal(increase_cents).div(centsToDecimal(i.seller_acquisition_price_cents));
  const pct = r4(pctD);
  const exemption_code = i.exemption_code ?? null;
  const trip = (days <= 90 && pct > 0.10) || (days >= 91 && days <= 180 && pct > 0.20);
  const basis = days <= 90 ? `days = ${days} (≤ 90), pct = ${pct} ${pct > 0.10 ? ">" : "≤"} 0.10` : days <= 180 ? `days = ${days} (91–180), pct = ${pct} ${pct > 0.20 ? ">" : "≤"} 0.20` : `days = ${days} (> 180): flip rule does not apply`;
  return { days, pct, pct_display: `${pctD.mul(Decimal.fromInt(100)).toFixed(2, "HALF_UP")}%`, increase_cents, second_appraisal_required: trip && exemption_code === null, basis: exemption_code ? `${basis}; (c)(4)(vii) exemption ${exemption_code} documented` : basis, exemption_code };
}
/** `hpml_appraisal_rules_apply = is_hpml ∧ ¬qm ∧ loan_amount > $34,200 (2026) ∧ ¬ other (c)(2) exemption` — same rule 23.4 records on hpml_determinations. */
export function hpmlAppraisalRulesApply(i: { is_hpml: boolean | null; qm_type: QmType | null; loan_amount_cents: Cents; as_of: PlainDate; other_c2_exemption?: string | null }): { apply: boolean; threshold_cents: Cents; reason: string } {
  const threshold_cents = ruleSet<HpmlRuleSet>(RULE_SETS_24_2.regz_hpml, i.as_of).content.appraisal_exemption_cents;
  if (i.is_hpml !== true) return { apply: false, threshold_cents, reason: "not an HPML" };
  if (i.qm_type !== "not_qm") return { apply: false, threshold_cents, reason: `§1026.35(c)(2)(i): qualified mortgage (${i.qm_type ?? "undetermined"}) — exempt; only Reg B governs` };
  if (i.loan_amount_cents <= threshold_cents) return { apply: false, threshold_cents, reason: `§1026.35(c)(2)(ii): loan amount at or below the ${threshold_cents} cent threshold` };
  if (i.other_c2_exemption) return { apply: false, threshold_cents, reason: `§1026.35(c)(2) exemption ${i.other_c2_exemption}` };
  return { apply: true, threshold_cents, reason: "non-QM HPML above the exemption threshold: interior-visit appraisal, flip test, copies ≥ 3 business days before consummation with no waiver" };
}
/** §1026.35(c)(6)(ii)(A): every written appraisal (incl. the second) ≥ 3 business_days_creditor before consummation (Wed Nov 18 → Fri Nov 13: Nov 17, 16, 13). */
export const hpmlCopyDueOn = (consummation_on: PlainDate): PlainDate => addBusinessDays(consummation_on, -3, creditor);
export { hpmlAppraisalCopyGate };
export interface HpmlTests { readonly apply: ReturnType<typeof hpmlAppraisalRulesApply>; readonly interior_visit_required: boolean; readonly assignment_type_ok: boolean; readonly flip: FlipTest | null; readonly second_appraisal_required: boolean; readonly second_appraiser_must_differ: boolean; readonly borrower_chargeable_appraisals: 0 | 1; readonly copies_due_on: PlainDate | null; readonly waiver_allowed: false; readonly timers: readonly string[]; }
export function runHpmlTests(i: { is_hpml: boolean | null; qm_type: QmType | null; loan_amount_cents: Cents; as_of: PlainDate; assignment_type: "traditional" | "desktop" | "hybrid" | "pdc_only" | "appraisal_update" | "completion_report" | "second_appraisal_hpml" | "field_review"; interior_visit: boolean; consummation_on?: PlainDate | null; flip?: Parameters<typeof flipTest>[0] | null; other_c2_exemption?: string | null }): HpmlTests {
  const apply = hpmlAppraisalRulesApply({ is_hpml: i.is_hpml, qm_type: i.qm_type, loan_amount_cents: i.loan_amount_cents, as_of: i.as_of, other_c2_exemption: i.other_c2_exemption ?? null });
  if (!apply.apply) return { apply, interior_visit_required: false, assignment_type_ok: true, flip: null, second_appraisal_required: false, second_appraiser_must_differ: false, borrower_chargeable_appraisals: 1, copies_due_on: null, waiver_allowed: false, timers: ["REGB_1002_14_APPRAISAL_COPY_PROMPT_7", "REGB_1002_14_APPRAISAL_COPY_3BD_GATE", "REGB_1002_14_WAIVER_3BD_GATE"] };
  const flip = i.flip ? flipTest(i.flip) : null;
  const second = flip?.second_appraisal_required === true;
  return { apply, interior_visit_required: true, assignment_type_ok: i.assignment_type === "traditional" && i.interior_visit, flip, second_appraisal_required: second, second_appraiser_must_differ: second, borrower_chargeable_appraisals: 1, copies_due_on: i.consummation_on ? hpmlCopyDueOn(i.consummation_on) : null, waiver_allowed: false,
    timers: ["REGB_1002_14_APPRAISAL_COPY_PROMPT_7", "REGB_1002_14_APPRAISAL_COPY_3BD_GATE", "REGB_1002_14_WAIVER_3BD_GATE", "REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD", "REGZ_1026_35C_HPML_COPY_NOT_CONSUMMATED_30"] };
}
/** (c)(4)(iv): "the creditor may charge the consumer for only one of the appraisals" — the `fee_items` guard; (c)(4)(iii) different appraiser. */
export function secondAppraisalPlan(i: { first_appraiser_party_id: string; second_appraiser_party_id: string | null; appraisal_fee_items: readonly { fee_item_id: string; paid_by: "borrower" | "creditor" | "seller"; appraisal_no: 1 | 2 }[] }): { different_appraiser: boolean; borrower_paid_count: number; refused_fee_item_ids: string[]; ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const different_appraiser = i.second_appraiser_party_id !== null && i.second_appraiser_party_id !== i.first_appraiser_party_id;
  if (!different_appraiser) reasons.push("§1026.35(c)(4)(iii): the two appraisals may not be performed by the same appraiser");
  const borrowerPaid = i.appraisal_fee_items.filter((f) => f.paid_by === "borrower");
  const refused_fee_item_ids = borrowerPaid.slice(1).map((f) => f.fee_item_id);
  if (refused_fee_item_ids.length) reasons.push("§1026.35(c)(4)(vi): the consumer may be charged for only one of the appraisals");
  return { different_appraiser, borrower_paid_count: borrowerPaid.length, refused_fee_item_ids, ok: reasons.length === 0, reasons };
}

// ============================================================ R8 — not consummated (§1002.14(a)(1); §1026.35(c)(6)(ii)(B))
export const notConsummatedCopyDue = (determination_on: PlainDate): PlainDate => addDays(determination_on, 30);
export function notConsummatedPackage(i: { determination_at: string; valuations: readonly ValuationRow[]; hpml_appraisal_rules_apply: boolean }): { copy_required_by: PlainDate; scheduled_on: PlainDate; valuations: readonly ValuationRow[]; includes_avm: boolean; timers: string[] } {
  const on = dateOf(i.determination_at);
  const copy_required_by = notConsummatedCopyDue(on);
  const scheduled_on = addBusinessDays(copy_required_by, -1, creditor);   // Sun Nov 29 → scheduled Fri Nov 27
  const undelivered = i.valuations.filter((v) => v.delivered_at === null && v.excluded_reason === null);
  return { copy_required_by, scheduled_on, valuations: undelivered, includes_avm: undelivered.some((v) => v.kind === "avm_report"), timers: ["REGB_1002_14_COPY_NOT_CONSUMMATED_30", ...(i.hpml_appraisal_rules_apply ? ["REGZ_1026_35C_HPML_COPY_NOT_CONSUMMATED_30"] : [])] };
}

// ============================================================ decision record
export interface DecisionRecord24_2 { readonly appraisal_id: string; readonly version_no: number; readonly ucdp_results: readonly UcdpSsr[]; readonly cu_score: number | null; readonly cu_flags: CuFlags; readonly checklist_results: readonly string[]; readonly bias_scan: BiasScanResult | null; readonly value_used_cents: Cents | null; readonly value_basis: ValueBasis | null; readonly copy_plan: { due_prompt: PlainDate; due_gate: PlainDate | null; channel: CopyChannel } | null; readonly hpml_tests: HpmlTests | null; readonly rov: { screen: RovScreen; analysis: RovAnalysis | null; sme_decision: "forward" | "decline" | "forward_partial" | null } | null; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly rationale: string; readonly confidence: number; }
export function decisionRecord24_2(i: Omit<DecisionRecord24_2, "rule_set_version"> & { rule_set_version?: string }): DecisionRecord24_2 {
  need(i.rationale.trim() !== "", "rationale required");
  return { ...i, rule_set_version: i.rule_set_version ?? `${RULE_SETS_24_2.regb}+${RULE_SETS_24_2.regz_hpml}+${RULE_SETS_24_2.fnma_selling}+${RULE_SETS_24_2.fnma_uad}`, confidence: Math.max(0, Math.min(1, i.confidence)) };
}

// ============================================================ events (every one carries applicationId)
export interface EventCtx { readonly application_id: string; readonly loan_id?: string | null; readonly actor?: Actor; readonly at?: string; }
const keys = (c: EventCtx) => ({ applicationId: c.application_id, ...(c.loan_id ? { loanId: c.loan_id } : {}), actor: c.actor ?? AGENT_24_2, ...(c.at ? { occurredAt: c.at } : {}) });
const base = (c: EventCtx, appraisal_id: string | null) => ({ application_id: c.application_id, ...(appraisal_id ? { appraisal_id } : {}), source: "origination" });
export function recordRevisionReceived(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; received_at: string; doc_file_id: string | null }): DomainEvent {
  return events.append({ type: "valuation.revision.received", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, received_at: i.received_at, doc_file_id: i.doc_file_id } });
}
export function recordUcdpSubmitted(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; gses: readonly Gse[]; doc_file_id: string; submitted_at: string }): DomainEvent {
  return events.append({ type: "valuation.ucdp.submitted", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, gses: [...i.gses], both_gses: i.gses.includes("fnma") && i.gses.includes("fhlmc"), doc_file_id: i.doc_file_id, submitted_at: i.submitted_at } });
}
export function recordUcdpResult(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; ssr: UcdpSsr }): DomainEvent {
  return events.append({ type: "valuation.ucdp.result.received", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, gse: i.ssr.gse, status: i.ssr.status, doc_file_id: i.ssr.doc_file_id, result_at: i.ssr.result_at, findings: i.ssr.findings.map((f) => f.code) } });
}
export function recordCuScored(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; cu_score: number | null; cu_flags: CuFlags; scored_at: string }): DomainEvent {
  const tier = cuReviewTier(i.cu_score, i.cu_flags);
  return events.append({ type: "valuation.cu.scored", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, cu_score: i.cu_score, cu_flags: i.cu_flags, review_tier: tier.tier, enhanced_review_required: tier.enhanced_review_required, scored_at: i.scored_at } });
}
export function recordEnhancedReview(events: EventStore, c: EventCtx, r: EnhancedReviewRecord): DomainEvent {
  return events.append({ type: "valuation.review.enhanced.recorded", ...keys(c), payload: { ...base(c, r.appraisal_id), cu_score: r.cu_score, comparable_reanalysis: r.comparable_reanalysis.length, field_review_recommended: r.field_review_recommended, rw_relief_property_value: false, recorded_at: r.recorded_at } });
}
export function recordReviewCompleted(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; review_status: ReviewStatus; completion_at: string | null; is_final_version: boolean; ucdp_status: UcdpStatus; doc_file_id: string | null; rw_relief_property_value: boolean }): DomainEvent {
  return events.append({ type: "valuation.review.completed", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, review_status: i.review_status, completion_at: i.completion_at, is_final_version: i.is_final_version, ucdp_status: i.ucdp_status, doc_file_id: i.doc_file_id, rw_relief_property_value: i.rw_relief_property_value } });
}
export function recordCorrectionRequested(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; text: string; reason: "bias_language" | "ucdp_stop" | "value_support" }): DomainEvent {
  return events.append({ type: "valuation.correction.requested", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, reason: i.reason, template: "CR-24.2 v1", text_hash_len: i.text.length } });
}
export function recordBiasFlagged(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; scan: BiasScanResult }): DomainEvent {
  return events.append({ type: "valuation.bias.flagged", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, severity: i.scan.severity, terms_hit: [...i.scan.terms_hit], demographic_references: [...i.scan.demographic_references], fair_lending_record: true, rule_set: i.scan.rule_set } });
}
export function recordDiscriminationReferred(events: EventStore, c: EventCtx, i: { appraisal_id: string; referred_by: Actor; agency: string; escalation_id: string }): DomainEvent {
  return events.append({ type: "valuation.discrimination.referred", ...keys(c), payload: { ...base(c, i.appraisal_id), referred_by: `${i.referred_by.kind}:${i.referred_by.id}`, agency: i.agency, escalation_id: i.escalation_id, air_referral_24_1: true } });
}
export function recordValueUsedSet(events: EventStore, c: EventCtx, i: { appraisal_id: string; version_no: number; value_used_cents: Cents; value_basis: ValueBasis; appraised_value_cents: Cents }): DomainEvent {
  need(i.value_used_cents <= i.appraised_value_cents, "value_used_cents may never exceed the appraised value");
  return events.append({ type: "valuation.value_used.set", ...keys(c), payload: { ...base(c, i.appraisal_id), version_no: i.version_no, value_used_cents: i.value_used_cents.toString(), value_basis: i.value_basis, appraised_value_cents: i.appraised_value_cents.toString() } });
}
export function recordCopyDelivered(events: EventStore, c: EventCtx, i: { appraisal_id: string | null; version: number; is_final_version: boolean; hpml: boolean; channel: CopyChannel; delivered_at: string; provided_on: PlainDate; receipt_evidence: CopyReceiptEvidence | null; notice_id: string | null; valuation_ids: readonly string[]; not_consummated?: boolean }): DomainEvent {
  return events.append({ type: "valuation.copy.delivered", ...keys(c), payload: { ...base(c, i.appraisal_id), version: i.version, is_final_version: i.is_final_version, hpml: i.hpml, channel: i.channel, delivered_at: i.delivered_at, provided_on: i.provided_on, receipt_evidence: i.receipt_evidence, notice_id: i.notice_id, valuation_ids: [...i.valuation_ids], not_consummated: i.not_consummated === true } });
}
export function recordWaiverRequested(events: EventStore, c: EventCtx, i: { appraisal_id: string; statement_channel: "oral_recorded" | "written" | "electronic"; obtained_at: string; consummation_on: PlainDate }): DomainEvent {
  return events.append({ type: "valuation.copy.waiver.requested", ...keys(c), payload: { ...base(c, i.appraisal_id), statement_channel: i.statement_channel, obtained_at: i.obtained_at, consummation_at_when_obtained: i.consummation_on } });
}
export function recordCopyWaived(events: EventStore, c: EventCtx, i: { appraisal_id: string; consent_id: string; obtained_at: string; consummation_on: PlainDate; copies_due_at_or_before: PlainDate }): DomainEvent {
  return events.append({ type: "valuation.copy.waived", ...keys(c), payload: { ...base(c, i.appraisal_id), consent_id: i.consent_id, consent_kind: "regb_1002_14_timing_waiver", obtained_at: i.obtained_at, consummation_at_when_obtained: i.consummation_on, copies_due_at_or_before: i.copies_due_at_or_before } });
}
export function recordNotConsummated(events: EventStore, c: EventCtx, i: { cause: "application.withdrawn" | "decision.issued" | "application.closed_incomplete" | "funding.cancelled"; decision_kind?: "denial" | "approved_not_accepted" | null; determination_at: string; hpml_appraisal_rules_apply: boolean; copy_required_by: PlainDate }): DomainEvent {
  return events.append({ type: "valuation.not_consummated.determined", ...keys(c), payload: { ...base(c, null), cause: i.cause, decision_kind: i.decision_kind ?? null, determination_at: i.determination_at, hpml_appraisal_rules_apply: i.hpml_appraisal_rules_apply, copy_required_by: i.copy_required_by } });
}
export function recordRovRequested(events: EventStore, c: EventCtx, r: RovRequestInput): DomainEvent {
  return events.append({ type: "rov.requested", ...keys(c), payload: { ...base(c, r.appraisal_id), rov_id: r.rov_id, requested_by: r.requested_by, requested_at: r.requested_at, comparables: r.comparables.length } });
}
export function recordRovScreened(events: EventStore, c: EventCtx, i: { rov_id: string; appraisal_id: string; screen: RovScreen; screened_at: string; sme_escalation_id: string | null }): DomainEvent {
  return events.append({ type: "rov.screened", ...keys(c), payload: { ...base(c, i.appraisal_id), rov_id: i.rov_id, screen_result: i.screen.screen_result, reasons: [...i.screen.reasons], sme_escalation_id: i.sme_escalation_id, appraiser_contact_allowed: i.screen.appraiser_contact_allowed, screened_at: i.screened_at } });
}
export function recordRovForwarded(events: EventStore, c: EventCtx, i: { rov_id: string; appraisal_id: string; sme_decision: "forward" | "forward_partial"; sme_reviewer: string; sent_to_appraiser_at: string; turn_time_due_at: PlainDate }): DomainEvent {
  return events.append({ type: "rov.forwarded", ...keys(c), payload: { ...base(c, i.appraisal_id), rov_id: i.rov_id, sme_decision: i.sme_decision, sme_reviewer: i.sme_reviewer, sent_to_appraiser_at: i.sent_to_appraiser_at, turn_time_due_at: i.turn_time_due_at, template: "ROV-24.2 v1" } });
}
export function recordRovResponse(events: EventStore, c: EventCtx, i: { rov_id: string; appraisal_id: string; revised_appraisal_id: string; response_received_at: string }): DomainEvent {
  return events.append({ type: "rov.response.received", ...keys(c), payload: { ...base(c, i.appraisal_id), rov_id: i.rov_id, revised_appraisal_id: i.revised_appraisal_id, response_received_at: i.response_received_at } });
}
export function recordRovClosed(events: EventStore, c: EventCtx, i: { rov_id: string; appraisal_id: string; outcome: RovOutcome; outcome_document_id: string | null; closed_at: string }): DomainEvent {
  return events.append({ type: "rov.closed", ...keys(c), payload: { ...base(c, i.appraisal_id), rov_id: i.rov_id, outcome: i.outcome, outcome_document_id: i.outcome_document_id, retained_in_loan_file: true, closed_at: i.closed_at } });
}
export function recordSecondAppraisalRequired(events: EventStore, c: EventCtx, i: { appraisal_id: string; flip: FlipTest; consummation_on: PlainDate | null }): DomainEvent {
  return events.append({ type: "hpml.second_appraisal.required", ...keys(c), payload: { ...base(c, i.appraisal_id), days: i.flip.days, pct: i.flip.pct, different_appraiser: true, borrower_chargeable_appraisals: 1, copies_due_on: i.consummation_on ? hpmlCopyDueOn(i.consummation_on) : null, order_process: "24.1", assignment_type: "second_appraisal_hpml" } });
}
