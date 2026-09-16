/**
 * §23.1 DU casefile creation, submission, resubmission tolerances (B3-2-10 as executable logic), versioning and the
 * casefile lifecycle — the `underwriter` agent's DU rules as small pure functions over the `fnma-du` port
 * (src/infra/integrations/du.ts: the 23.7 rule 9 contract, the schema-validating FAKE and the outage fake; a real
 * Direct Integration adapter would live beside them).
 *
 * UNVERIFIED (as the spec marks it): the DU Direct Integration transport/auth, the casefile create/submit
 * choreography, credit-provider codes and the Return File Type value list live in login-gated Fannie Mae material
 * (DU Spec / FAQ, "[PARTIALLY VERIFIED]"). The port's contract (23.7 rule 9) takes the emitted bytes and their hash
 * and answers with DU's own casefile identifier; the FAKE returns the spec's fixture findings (`fixtureFindings`,
 * `fakeValidationResults`, `fakeDuMessages` below — 32.18 rule 5's validation service) over the request it was sent.
 *
 * Reused, never re-implemented: 22.2's `assertDuSubmittable`, `b3210ToleranceCheck`, `dtiTenths`, `expiresAt` and its
 * credit-report expiry gate; 22.1's document gates (`assertGateOpen`); 22.3's `closeByGate`; 21.1's SCIF gate via
 * `evaluateGate("21.1.scifPresentGate")`; 20.4's LLPA LTV columns and MI bands.
 *
 * Events (subject = application; every payload carries `application_id` so src/kernel/timers/engine.ts arms the 23.1
 * clocks — see timers-23-1.ts):
 *   du.casefile.created{casefile_id, created_at, policy_generation, archive_540_due_at}          [arms FNMA_B3_2_01_DU_ARCHIVE_540]
 *   du.credit.associated{casefile_id, score_model, borrowers[]}
 *   du.submitted{submission_number, casefile_id, submission_type, reason, request_hash, du_release_applied, du_casefile_id}
 *                                                                        [satisfies FNMA_B3_2_01_DU_ARCHIVE_270 (any DU update resets it)]
 *   du.casefile_id.recorded{du_casefile_id, submission_number}   (23.7 rule 9: applications.du_casefile_id written once, from the first ack)
 *   du.casefile_id.conflict{du_casefile_id_on_file, du_casefile_id_acked, escalation_id}   (a later ack names a different one: DU_CASEFILE_ID_CONFLICT → fnma_portal_operator)
 *   du.findings.received{submission_number, recommendation, messages, validation_results, value_acceptance_offer, mi_requirement,
 *                        findings_hash, last_updated_at}                 [arms FNMA_B3_2_01_DU_ARCHIVE_270; 23.2/23.3/24.1/24.6/22.4 consume]
 *   du.submission.errored{submission_number, error_code, attempt}
 *   du.resubmission.required{rule_codes, result, reason}  ·  du.resubmission.waived{rule_codes, arithmetic}
 *   du.final_submission.recorded{submission_number, recommendation, closed_loan_snapshot_hash}   [satisfies FNMA_B3_2_10_DU_FINAL_MATCH_GATE]
 *   du.casefile.archive_warning{archive_due_at}  ·  du.casefile.archived{informational}  ·  du.casefile.superseded{by_casefile_id, reason}
 *   du.version.cutover_applied{from, to, policy_generation}
 *   du.identity_change.detected{borrower_id, field, fraud_signal_to: "22.6"}   (the 22.6 red flag; DU job aid "Associating a Credit Report")
 *   du.impact_memo.published{memo_date, spec_available_on, return_file_retirement_date, source: "origination"}
 *                                                                        [arms FNMA_DU_IMPACT_MEMO_SUPPORT_120, FNMA_DU_RETURN_FILE_16_17_RETIRE]
 *   du.adapter.release_tagged{spec_version, tag}                          [satisfies FNMA_DU_IMPACT_MEMO_SUPPORT_120]
 *   du.return_file_format.confirmed{formats}                              [satisfies FNMA_DU_RETURN_FILE_16_17_RETIRE]
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { type PlainDate, plainDate as D, addDays, daysBetween, min as minDate } from "../../kernel/calendar/date.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { Decimal, divRound, levelPayment, ratePercent, type Cents } from "../../kernel/money/index.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { evaluateGate, type GateResult } from "../../app/evaluators.ts";
import type { EscalationInput, Escalation } from "../../app/escalations.ts";
import { assertDuSubmittable, b3210ToleranceCheck, dtiTenths, assertGateOpen as assertCreditGateOpen, CreditRefused, type CreditReport, type ScoreModel, type ToleranceCheck } from "../verification/ops-22-2.ts";
import { assertGateOpen as assertDocumentGateOpen, type ReliedDocument } from "../verification/ops-22-1.ts";
import { closeByGate } from "../verification/ops-22-3.ts";
import { LTV_BANDS, MIN_MI_LTV_BANDS } from "../leads-pricing/ops-20-4.ts";
import type { Queryable } from "../../infra/db/client.ts";
import { DuTransportError, type DuPort, type DuSubmitAck, type DuSubmitRequest } from "../../infra/integrations/du.ts";
import { assembleDuDocument, emptyGraph, withDeal, type DuDeal, type DuDocument, type DuGap, type DuGraph, type DuValue } from "./du/emit.ts";
import { emitDuPreflight, preflightGate, runDuPreflight, type PreflightResult } from "./du/preflight.ts";

export type { ScoreModel };
export const AGENT: Actor = { kind: "agent", id: "underwriter" };
export const RULE_SET_VERSION = "fnma.selling.2026-09-02";
export const DU_RULE_SET_VERSION = "fnma.du.12.1";
export const DU_VERSION = "12.1";
export const LLPA_MATRIX_VERSION = "09.09.2026";
export const RETENTION_CLASS = "fnma_loan_file_life_plus_4y";
export const ET = "America/New_York";
export const civilDateEt = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;

export class DuRefused extends Error {
  readonly error_code: string; readonly citation: string; readonly next: string | null;
  constructor(error_code: string, citation: string, message: string, next: string | null = null) { super(message); this.name = "DuRefused"; this.error_code = error_code; this.citation = citation; this.next = next; }
}
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = AGENT): DomainEvent =>
  events.append({ type, applicationId, aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, ...payload } });
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Canonical JSON (sorted keys; bigint → decimal string) so two identical snapshots hash identically — the closed-loan snapshot hash and the findings hash (rule 5). The request hash is not this: it is the SHA-256 of the emitted document's bytes (23.6 rule 6). */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => typeof x === "bigint" ? x.toString() : Array.isArray(x) ? x.map(norm) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(norm(v));
}

// ============================================================ vocabulary (data model)
export type PolicyGeneration = "pre_2026_06_27" | "2026_06_27" | "2026_09_26";
export type CasefileStatus = "draft" | "credit_associated" | "submitted" | "findings_received" | "resubmission_required" | "final" | "delivered" | "error" | "archive_warning" | "archived" | "superseded";
export type SupersedeReason = "archived" | "borrower_identity_change" | "casefile_error";
export type SubmissionType = "credit_only" | "credit_and_underwriting" | "underwriting_only";
export type SubmissionReason = "initial" | "data_change" | "tolerance_breach" | "credit_refresh" | "validation_report_update" | "error_retry" | "final_closed_loan_match" | "delivery_correction" | "post_closing_correction";
export type SubmissionStatus = "queued" | "sent" | "acked" | "findings_received" | "error" | "superseded";
export type Recommendation = "approve_eligible" | "approve_ineligible" | "refer_with_caution" | "out_of_scope" | "error";
export type ReturnFileType = "json_v2" | "pdf_standard" | "16" | "17" | "res" | "text" | "xml";
export type LoanPurpose = "purchase" | "limited_cash_out_refinance" | "cash_out_refinance";
export type CheckField = "note_rate" | "dti" | "income" | "liabilities" | "assets" | "reserves" | "loan_amount" | "ltv" | "cltv" | "occupancy" | "product" | "amortization" | "loan_term" | "property_type" | "loan_purpose" | "sales_price" | "appraised_value" | "borrower_identity" | "credit_report" | "validation_report" | "mi_coverage" | "llpa_band" | "eligibility_flag";
export type RuleCode = "B3_2_10_RATE_DECREASE" | "B3_2_10_RATE_DECREASE_BUYDOWN" | "B3_2_10_DTI_45_OR_3PT" | "B3_2_10_DTI_OVER_50" | "B3_2_10_INCOME_LIMITED" | "B3_2_10_REFI_AMOUNT_500_1PCT" | "B3_2_10_REFI_AMOUNT_MINUS_5PCT" | "B3_2_10_PURCHASE_AMOUNT" | "B3_2_10_RESERVES_90PCT" | "B3_2_10_FUNDS_TO_CLOSE" | "B3_2_10_CLOSED_LOAN_FIELD" | "B3_2_10_LCOR_CASH_BACK" | "B3_2_01_CREDIT_EXPIRED" | "B3_2_02_VALIDATION_UPDATE" | "DU_JOBAID_IDENTITY_CHANGE";
export type CheckResult = "within_tolerance" | "resubmission_required" | "new_casefile_required" | "ineligible_change";
export const CLOSED_LOAN_FIELDS = ["occupancy", "product", "amortization", "loan_term", "property_type", "loan_purpose", "sales_price", "appraised_value"] as const;
export type ClosedLoanField = (typeof CLOSED_LOAN_FIELDS)[number];

export interface BorrowerIdentity { readonly borrower_id: string; readonly last_name: string; readonly suffix: string | null; readonly ssn_last4: string; }
/** The whole-file ULAD snapshot every DU request carries (DU Spec is a whole-file submission). */
export interface UladSnapshot {
  readonly application_id: string; readonly loan_purpose: LoanPurpose; readonly occupancy: string; readonly product: string; readonly amortization: string; readonly loan_term: number; readonly property_type: string;
  readonly sales_price_cents: Cents | null; readonly appraised_value_cents: Cents; readonly loan_amount_cents: Cents; readonly subordinate_liens_cents?: Cents; readonly heloc_limit_cents?: Cents;
  readonly note_rate_pct: string; readonly qualifying_income_cents: Cents; readonly total_obligations_cents: Cents; readonly borrowers: readonly BorrowerIdentity[];
  /** HomeReady and other income-limited products (B3-2-10 "loans subject to income limits"). */
  readonly income_limited_product?: boolean;
  /** The rate decrease results from a permanent buydown (B3-2-10: must be resubmitted). */
  readonly permanent_buydown?: boolean;
  /** DELTA-37: the cash-out refinance's primary purpose (21.1 `cash_out_purpose`, MISMO RefinancePrimaryPurposeBase) — written only when the determination is CashOut. */
  readonly cash_out_purpose?: string | null;
  /** Eligibility Matrix maximum LTV for the transaction (20.4/23.2 supply it). */
  readonly max_ltv_pct?: string;
  readonly verified_reserves_cents?: Cents | null;
}
export interface CreditAssociation { readonly borrower_id: string; readonly mode: "order_new" | "reissue"; readonly credit_agency_code: string; readonly reference_number: string; readonly report_type: "joint" | "individual"; readonly credit_report_id: string; readonly score_model: ScoreModel; readonly expires_at: PlainDate; }
export interface DuCasefile {
  readonly casefile_id: string; readonly application_id: string; readonly du_version: string; readonly seller_number: string; readonly system_id_ref: string; readonly tsp_product_ref: string;
  readonly created_at: string; readonly created_on: PlainDate; readonly last_updated_at: string; readonly last_updated_on: PlainDate; readonly policy_generation: PolicyGeneration;
  readonly archive_270_due_at: PlainDate; readonly archive_540_due_at: PlainDate; readonly archive_due_at: PlainDate; readonly archive_warning_at: PlainDate; readonly status: CasefileStatus;
  readonly credit_association: readonly CreditAssociation[]; readonly score_model: ScoreModel | null; readonly validation_opt_in: boolean; readonly final_submission_id: string | null;
  readonly superseded_by_casefile_id: string | null; readonly supersede_reason: SupersedeReason | null; readonly submission_count: number; readonly red_flag_excessive_resubmissions: boolean; readonly archive_warning_sent: boolean;
}
export interface DuMessage { readonly id: string; readonly category: string; readonly text: string; readonly borrower_id?: string | null; }
export interface ValidationResult { readonly component: "income" | "employment" | "assets"; readonly borrower_id: string; readonly outcome: "validated" | "not_validated" | "unable_to_validate"; readonly close_by_date?: PlainDate | null; readonly report_reference_id?: string | null; }
export interface DuFindings {
  readonly casefile_id: string; readonly submission_number: number; readonly recommendation: Recommendation; readonly messages: readonly DuMessage[]; readonly risk_factors: Record<string, unknown>;
  readonly validation_results: readonly ValidationResult[]; readonly value_acceptance_offer: { offered: boolean; property_value_cents?: Cents } | null; readonly mi_requirement: { required: boolean; coverage_pct: string | null } | null;
  readonly dti_du: string; readonly ltv_du: string; readonly cltv_du: string; readonly hcltv_du: string; readonly reserves_required_cents: Cents; readonly total_funds_to_verify_cents: Cents; readonly qualifying_rate: string; readonly note_rate: string; readonly loan_amount_cents: Cents;
  /** The eight closed-loan fields as DU evaluated them (echoed from the request) — hashed into `findings_hash`. */
  readonly evaluated: ClosedLoanData; readonly findings_json: string; readonly findings_pdf_ref: string | null; readonly received_at: string; readonly du_version: string;
}
export interface DuSubmission {
  readonly submission_id: string; readonly casefile_id: string; readonly application_id: string; readonly submission_number: number; readonly submission_type: SubmissionType; readonly reason: SubmissionReason;
  readonly request_document_id: string; readonly request_hash: string; readonly du_version: string; readonly du_release_applied: string; readonly return_file_types: readonly ReturnFileType[];
  readonly findings_document_id: string | null; readonly findings_json_document_id: string | null; readonly findings_pdf_document_id: string | null; readonly submitted_at: string; readonly acked_at: string | null; readonly findings_received_at: string | null;
  readonly status: SubmissionStatus; readonly error_code: string | null; readonly error_message: string | null; readonly recommendation: Recommendation | null; readonly messages: readonly DuMessage[]; readonly risk_factors: Record<string, unknown>;
  readonly validation_results: readonly ValidationResult[]; readonly value_acceptance_offer: DuFindings["value_acceptance_offer"]; readonly mi_requirement: DuFindings["mi_requirement"]; readonly dti_du: string | null; readonly ltv_du: string | null; readonly cltv_du: string | null; readonly hcltv_du: string | null;
  readonly reserves_required_cents: Cents | null; readonly total_funds_to_verify_cents: Cents | null; readonly qualifying_rate: string | null; readonly note_rate: string; readonly loan_amount_cents: Cents; readonly is_final: boolean; readonly closed_loan_snapshot_hash: string | null; readonly findings_hash: string | null;
  readonly snapshot: UladSnapshot; readonly rationale: string | null; readonly submitted_via: "di_channel" | "du_ui_fallback"; readonly agent_run_id: string | null;
  /** The DU validation service report references the request carried (32.18 rule 3: the asset report on the casefile). */
  readonly validation_report_refs?: DuRequest["validation_report_refs"];
  /** DU's own casefile identifier from this submission's ack (23.7 rule 9) — null until acked; the key `fetchFindings` takes. */
  readonly du_casefile_id: string | null;
}
export interface DuResubmissionCheck {
  readonly id: string; readonly application_id: string; readonly casefile_id: string; readonly baseline_submission_id: string; readonly trigger_event: string; readonly field: CheckField; readonly old_value: unknown; readonly new_value: unknown;
  readonly rule_code: RuleCode; readonly result: CheckResult; readonly arithmetic: Record<string, unknown>; readonly evaluated_at: string; readonly resubmission_id: string | null; readonly agent_decision_id: string | null; readonly citation: string;
}

// ============================================================ R1 — policy generation, release keys, archival clocks (B3-2-01; DU 12.1 release notes)
export const POLICY_GENERATION_2026_06_27 = D("2026-06-27");
export const POLICY_GENERATION_2026_09_26 = D("2026-09-26");
/** Creation-keyed rules only: June 27, 2026 minimum-credit-risk standards; Sept 26, 2026 DU validation-service changes. */
export function policyGeneration(created_on: PlainDate): PolicyGeneration {
  if (created_on >= POLICY_GENERATION_2026_09_26) return "2026_09_26";
  if (created_on >= addDays(POLICY_GENERATION_2026_06_27, 1)) return "2026_06_27";   // "2026-06-28 ≤ created_at < 2026-09-26" (rule 1)
  return "pre_2026_06_27";
}
/** DU 12.1 release evenings — every non-creation-keyed change applies to casefiles "submitted or resubmitted on or after the evening of" the date. */
export const DU_RELEASES: readonly { readonly key: string; readonly evening_of: PlainDate; readonly note: string }[] = [
  { key: "2026_03_21", evening_of: D("2026-03-21"), note: "DU 12.1 implemented; 11.1 resubmissions closed" },
  { key: "2026_06_26", evening_of: D("2026-06-26"), note: "June update (non-credit-risk changes submission-keyed)" },
  { key: "2026_09_09", evening_of: D("2026-09-09"), note: "VantageScore 4.0 update (LL-2026-06; SFC 067)" },
  { key: "2026_09_25", evening_of: D("2026-09-25"), note: "September update: CU-driven Ineligible, Lava Zone, 11/25/7 messages" },
];
export const RELEASE_EVENING_HOUR_ET = 18;
/** The latest release evening ≤ `submitted_at` (a same-day submission before 18:00 ET is still on the prior release). */
export function duReleaseApplied(submitted_at: string): string {
  const w = wallClock(Date.parse(submitted_at), ET);
  let key = "pre_12_1";
  for (const r of DU_RELEASES) if (w.date > r.evening_of || (w.date === r.evening_of && w.hour >= RELEASE_EVENING_HOUR_ET)) key = r.key;
  return key;
}
export const ARCHIVE_270_DAYS = 270, ARCHIVE_540_DAYS = 540, ARCHIVE_WARNING_LEAD_DAYS = 30;
export interface ArchivalClocks { readonly archive_270_due_at: PlainDate; readonly archive_540_due_at: PlainDate; readonly archive_due_at: PlainDate; readonly archive_warning_at: PlainDate; }
/** B3-2-01: archived at the earlier of last update + 270 days or creation + 540 days (660 for single-closing C-to-P — not built); warning at T−30 (day 240 on the 270 clock). */
export function archivalClocks(created_on: PlainDate, last_updated_on: PlainDate): ArchivalClocks {
  const archive_270_due_at = addDays(last_updated_on, ARCHIVE_270_DAYS), archive_540_due_at = addDays(created_on, ARCHIVE_540_DAYS);
  const archive_due_at = minDate(archive_270_due_at, archive_540_due_at);
  return { archive_270_due_at, archive_540_due_at, archive_due_at, archive_warning_at: addDays(archive_due_at, -ARCHIVE_WARNING_LEAD_DAYS) };
}

// ============================================================ R1 — casefile creation
export interface CreateCasefileInput { readonly application_id: string; readonly seller_number: string; readonly system_id_ref: string; readonly tsp_product_ref: string; readonly score_model: ScoreModel | null; readonly validation_opt_in?: boolean; readonly created_at: string; readonly casefile_id?: string; readonly supersedes?: DuCasefile | null; readonly supersede_reason?: SupersedeReason; }
export function createCasefile(events: EventStore, i: CreateCasefileInput, actor: Actor = AGENT): { casefile: DuCasefile; superseded: DuCasefile | null; events: DomainEvent[] } {
  nonEmpty(i.application_id, "application_id");
  if (!/^\d{9}$/.test(i.seller_number)) throw new RangeError("seller_number is the partner's 9-digit Fannie Mae seller number");
  if (i.supersedes && i.supersedes.application_id !== i.application_id) throw new DuRefused("CASEFILE_ID_REUSE", "B3-2-11 potential casefile ID reuse; edge case 'Casefile ID reuse'", "a casefile is never re-used for a different application");
  const created_on = civilDateEt(i.created_at);
  const clocks = archivalClocks(created_on, created_on);
  const casefile: DuCasefile = { casefile_id: i.casefile_id ?? randomUUID(), application_id: i.application_id, du_version: DU_VERSION, seller_number: i.seller_number, system_id_ref: i.system_id_ref, tsp_product_ref: i.tsp_product_ref, created_at: i.created_at, created_on, last_updated_at: i.created_at, last_updated_on: created_on,
    policy_generation: policyGeneration(created_on), ...clocks, status: "draft", credit_association: [], score_model: i.score_model, validation_opt_in: i.validation_opt_in ?? true, final_submission_id: null, superseded_by_casefile_id: null, supersede_reason: null, submission_count: 0, red_flag_excessive_resubmissions: false, archive_warning_sent: false };
  const out: DomainEvent[] = [emit(events, i.application_id, "du.casefile.created", { casefile_id: casefile.casefile_id, created_at: i.created_at, created_on, policy_generation: casefile.policy_generation, du_version: DU_VERSION, archive_540_due_at: casefile.archive_540_due_at, archive_270_due_at: casefile.archive_270_due_at, seller_number: i.seller_number, supersedes_casefile_id: i.supersedes?.casefile_id ?? null }, i.created_at, actor)];
  let superseded: DuCasefile | null = null;
  if (i.supersedes) {
    superseded = { ...i.supersedes, status: "superseded", superseded_by_casefile_id: casefile.casefile_id, supersede_reason: i.supersede_reason ?? "casefile_error" };
    out.push(emit(events, i.application_id, "du.casefile.superseded", { casefile_id: i.supersedes.casefile_id, by_casefile_id: casefile.casefile_id, reason: superseded.supersede_reason, subject_to: "policies in effect for the current version of DU (B3-2-01)", rerun: ["23.2", "23.3"] }, i.created_at, actor));
  }
  return { casefile, superseded, events: out };
}

// ============================================================ R2 — credit association (DU job aid; Sept 9, 2026 release notes; 22.2 R11)
export interface AssociateInput { readonly reports: readonly CreditReport[]; readonly borrowers: readonly BorrowerIdentity[]; readonly app_score_model: ScoreModel | null; readonly at: string; }
/** One report reference per borrower (reissue by provider code + reference number); every report on one score model equal to `applications.score_model`. */
export function associateCredit(events: EventStore, casefile: DuCasefile, i: AssociateInput, actor: Actor = AGENT): { casefile: DuCasefile; event: DomainEvent } {
  const models = new Set(i.reports.map((r) => r.score_model));
  if (models.size > 1) {
    emit(events, casefile.application_id, "du.submission.errored", { casefile_id: casefile.casefile_id, submission_number: null, error_code: "SCORE_MODEL_MIXED", attempt: 0, models: [...models], next: "22.2 re-orders every borrower under applications.score_model" }, i.at, actor);
    throw new DuRefused("SCORE_MODEL_MIXED", "DU 12.1 VantageScore 4.0 Update (Sept 9, 2026): 'you cannot mix credit score models across borrowers on the same loan'; LL-2026-06", `reports carry ${[...models].join(" and ")}: one model for all borrowers`, "22.2 re-order");
  }
  for (const r of i.reports) {
    try { assertDuSubmittable(r, i.app_score_model); } catch (e) { if (e instanceof CreditRefused) throw new DuRefused(e.code, e.citation, e.message, "22.2"); throw e; }
    if (r.score_model !== i.app_score_model) throw new DuRefused("SCORE_MODEL_MIXED", "22.2 R11 / LL-2026-06: the same credit score model must be used for all borrowers", `report ${r.report_id} is ${r.score_model}, applications.score_model is ${String(i.app_score_model)}`, "22.2 re-order");
  }
  const assoc: CreditAssociation[] = [];
  for (const b of i.borrowers) {
    const r = i.reports.find((x) => x.borrower_ids.includes(b.borrower_id));
    if (!r) throw new DuRefused("REPORT_MISSING_FOR_BORROWER", "DU job aid: 'A credit report must be available in DU for every borrower and co-borrower on a loan casefile'; guardrail 'never submit without a report for every borrower'", `borrower ${b.borrower_id} has no usable credit report`, "22.2");
    if (!r.du_credit_provider_code || !r.credit_reference_number) throw new DuRefused("REISSUE_REFERENCE_MISSING", "DU job aid: reissue needs the credit agency's DU code and the reference number", `report ${r.report_id} carries no DU provider code / reference number`, "22.2 order-new through DU");
    assoc.push({ borrower_id: b.borrower_id, mode: "reissue", credit_agency_code: r.du_credit_provider_code, reference_number: r.credit_reference_number, report_type: r.borrower_ids.length > 1 ? "joint" : "individual", credit_report_id: r.report_id, score_model: r.score_model, expires_at: r.expires_at });
  }
  const next: DuCasefile = { ...casefile, credit_association: assoc, score_model: i.app_score_model, status: "credit_associated" };
  const event = emit(events, casefile.application_id, "du.credit.associated", { casefile_id: casefile.casefile_id, score_model: i.app_score_model, borrowers: assoc.map((a) => ({ borrower_id: a.borrower_id, mode: a.mode, credit_agency_code: a.credit_agency_code, report_type: a.report_type, credit_report_id: a.credit_report_id, arcrole: a.report_type === "joint" ? "SharesJointCreditReportWith" : null })) }, i.at, actor);
  return { casefile: next, event };
}
/** Identity change after association (last name, suffix or SSN): a new association is mandatory, the prior submission is superseded, 22.6 gets the red flag. */
export function detectIdentityChange(before: readonly BorrowerIdentity[], after: readonly BorrowerIdentity[]): { borrower_id: string; field: "last_name" | "suffix" | "ssn"; old_value: string | null; new_value: string | null }[] {
  const out: { borrower_id: string; field: "last_name" | "suffix" | "ssn"; old_value: string | null; new_value: string | null }[] = [];
  for (const b of before) {
    const a = after.find((x) => x.borrower_id === b.borrower_id); if (!a) continue;
    if (a.last_name !== b.last_name) out.push({ borrower_id: b.borrower_id, field: "last_name", old_value: b.last_name, new_value: a.last_name });
    if ((a.suffix ?? null) !== (b.suffix ?? null)) out.push({ borrower_id: b.borrower_id, field: "suffix", old_value: b.suffix ?? null, new_value: a.suffix ?? null });
    if (a.ssn_last4 !== b.ssn_last4) out.push({ borrower_id: b.borrower_id, field: "ssn", old_value: `***-**-${b.ssn_last4}`, new_value: `***-**-${a.ssn_last4}` });
  }
  return out;
}
export function recordIdentityChange(events: EventStore, casefile: DuCasefile, prior: DuSubmission | null, change: ReturnType<typeof detectIdentityChange>[number], at: string, actor: Actor = AGENT): { casefile: DuCasefile; prior: DuSubmission | null; check: DuResubmissionCheck; events: DomainEvent[] } {
  const check: DuResubmissionCheck = { id: randomUUID(), application_id: casefile.application_id, casefile_id: casefile.casefile_id, baseline_submission_id: prior?.submission_id ?? "", trigger_event: "borrower.identity.corrected", field: "borrower_identity", old_value: change.old_value, new_value: change.new_value,
    rule_code: "DU_JOBAID_IDENTITY_CHANGE", result: "resubmission_required", arithmetic: { borrower_id: change.borrower_id, field: change.field, new_credit_association_required: true }, evaluated_at: at, resubmission_id: null, agent_decision_id: null, citation: "DU job aid 'Associating a Credit Report': changes to last name, suffix or SSN require a new credit report association" };
  const out: DomainEvent[] = [
    emit(events, casefile.application_id, "du.identity_change.detected", { casefile_id: casefile.casefile_id, borrower_id: change.borrower_id, field: change.field, rule_code: check.rule_code, fraud_signal_to: "22.6", red_flag: "identity_change_after_credit_association", superseded_submission_id: prior?.submission_id ?? null }, at, actor),
    emit(events, casefile.application_id, "du.resubmission.required", { casefile_id: casefile.casefile_id, rule_codes: [check.rule_code], result: check.result, reason: "credit_refresh", new_credit_association_required: true, trigger_event: check.trigger_event }, at, actor),
  ];
  return { casefile: { ...casefile, credit_association: casefile.credit_association.filter((a) => a.borrower_id !== change.borrower_id), status: "draft" }, prior: prior ? { ...prior, status: "superseded" } : null, check, events: out };
}

// ============================================================ R3 — request building, Return File Types (Sept 25, 2026 impact memo), request hash
export const RETURN_FILE_16_17_RETIRE_ON = D("2026-11-30");
export const RETIRED_RETURN_FILE_TYPES: readonly ReturnFileType[] = ["16", "17"];
export const DURABLE_RETURN_FILE_TYPES: readonly ReturnFileType[] = ["json_v2", "pdf_standard"];
export const DEFAULT_RETURN_FILE_TYPES: readonly ReturnFileType[] = ["json_v2", "pdf_standard"];
/** FNMA_DU_RETURN_FILE_16_17_RETIRE: requests carrying types 16 (Enhanced HTML) / 17 (PDF) are blocked from Dec 1, 2026. */
export function returnFileTypeGate(f: Record<string, unknown>): GateResult {
  const built = typeof f.built_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.built_on) ? (f.built_on as PlainDate) : null;
  if (!built) return { open: false, reason: "built_on (the request build date) is required" };
  const types = Array.isArray(f.return_file_types) ? (f.return_file_types as string[]) : [];
  const retired = types.filter((t) => (RETIRED_RETURN_FILE_TYPES as readonly string[]).includes(t));
  if (retired.length && built > RETURN_FILE_16_17_RETIRE_ON) return { open: false, reason: `FNMA_DU_RETURN_FILE_16_17_RETIRE: Return File Type(s) ${retired.join(", ")} retired Nov 30, 2026 (DU 12.1 September Update impact memo) — request built ${built} refused before transmission; use json_v2 / pdf_standard` };
  if (!types.length) return { open: false, reason: "no return_file_types requested" };
  return { open: true };
}
/** What 23.1 carries of the emitted document (23.6): the hash, the counts, and the DU Map gaps recorded under `conditionality: "report"`. JSON-safe — the bytes are `xml_document`. */
export interface DuRequestDocument { readonly sha256: string; readonly container_count: number; readonly relationship_count: number; readonly borrower_count: number; readonly disputed_arcs_skipped: number; readonly required_missing: number; readonly gaps: readonly DuGap[]; }
export interface DuRequest { readonly casefile_id: string; readonly application_id: string; readonly submission_type: SubmissionType; readonly reason: SubmissionReason; readonly built_at: string; readonly built_on: PlainDate; readonly return_file_types: readonly ReturnFileType[]; readonly snapshot: UladSnapshot; readonly credit_association: readonly CreditAssociation[]; readonly automated_underwriting_case_identifier: string | null; readonly validation_report_refs: readonly { supplier_type: string; identifier: string; report_type: string }[]; readonly mismo_version: "3.4-B324";
  /** SHA-256 (hex) of `xml_document`'s UTF-8 bytes exactly as transmitted (23.6 rule 6). */
  readonly request_hash: string;
  /** The DU Specification document: MISMO 3.4 Build 324 XML with the DU and ULAD extensions (23.6). */
  readonly xml_document: string;
  /** The `documents` row the runtime persists the bytes under (du_submissions.request_document_id). */
  readonly document_id: string;
  readonly document: DuRequestDocument; }
export interface BuildRequestInput { readonly submission_type: SubmissionType; readonly reason: SubmissionReason; readonly built_at: string; readonly snapshot: UladSnapshot; readonly return_file_types?: readonly ReturnFileType[]; readonly validation_report_refs?: DuRequest["validation_report_refs"]; readonly prior_submission_number?: number | null;
  /** The 23.5 graph projected for the document (du/emit.ts `loadGraph` in the runtime; a fixture in tests). The snapshot's deal facts are laid over it (`dealFromSnapshot`); with no graph the document is the deal alone. */
  readonly graph?: DuGraph;
  /** 23.6 rule 4 at emission: `refuse` (default) throws DU_REQUIRED_MISSING; `report` records the gaps on `document.gaps` for 23.7's gate (src/app/tools/section23-1.ts says why the runtime passes it). */
  readonly conditionality?: "refuse" | "report";
  /** The documents row id to persist under; minted when absent. */
  readonly document_id?: string; }

// The snapshot's deal facts as the document's subject LOAN and COLLATERAL (23.6 Inputs: "the subject loan's terms,
// the collateral" are 23.1's, not a 23.5 row's). Every mapping is a table over the vocabulary 20.4 / 23.1 use; a value
// outside it leaves the data point ABSENT — never guessed — and rule 4 names the XPath (refused, or reported for 23.7).
const LOAN_PURPOSE_DU: Readonly<Record<LoanPurpose, { readonly purpose: string; readonly cash_out: string | null }>> = { purchase: { purpose: "Purchase", cash_out: null }, limited_cash_out_refinance: { purpose: "Refinance", cash_out: "LimitedCashOut" }, cash_out_refinance: { purpose: "Refinance", cash_out: "CashOut" } };
/** 20.4 `Occupancy` (primary | second_home | investment) and the snapshot spellings the fixtures and 32.x journeys use for the same three. */
const OCCUPANCY_DU: Readonly<Record<string, string>> = { primary: "PrimaryResidence", principal_residence: "PrimaryResidence", principal: "PrimaryResidence", owner_occupied: "PrimaryResidence", second_home: "SecondHome", investment: "Investment" };
/** 20.4 `PropertyType` (sfr | pud | condo | coop | manufactured_home) plus the snapshot spellings; the unit count is the type's for a one-unit type and stated by name for 2–4 units. */
const UNITS_DU: Readonly<Record<string, number>> = { sfr: 1, sfr_detached: 1, sfr_attached: 1, pud: 1, condo: 1, coop: 1, manufactured_home: 1, manufactured: 1, townhouse: 1, "2_unit": 2, "3_unit": 3, "4_unit": 4 };
/** 20.4 `Amortization`: fixed, or a 5/6, 7/6, 10/6 ARM — all fully amortizing (no interest-only, balloon or negative-amortization product is priced). */
const AMORTIZATION_DU = (a: string): string | null => (a === "fixed" ? "Fixed" : /^arm(_|$)/.test(a) ? "AdjustableRate" : null);
/** ORIGINATION_SYSTEMS/ORIGINATION_SYSTEM (conditional on the subject loan): the LOS is this platform; the vendor identifier is the partner-org System ID Fannie Mae assigned SM's TSP product (`du_casefiles.system_id_ref`). */
export const LOAN_ORIGINATION_SYSTEM = { name: "Supermortgage", version: String((createRequire(import.meta.url)("../../../package.json") as { version: string }).version) } as const;
export function dealFromSnapshot(s: UladSnapshot, system_id_ref: string): DuDeal {
  const purpose = LOAN_PURPOSE_DU[s.loan_purpose];
  const amortization = AMORTIZATION_DU(s.amortization);
  const loan: Record<string, DuValue | null> = {
    "AMORTIZATION/AMORTIZATION_RULE/AmortizationType": amortization,
    "AMORTIZATION/AMORTIZATION_RULE/LoanAmortizationPeriodCount": Number.isInteger(s.loan_term) && s.loan_term > 0 ? s.loan_term : null,
    "AMORTIZATION/AMORTIZATION_RULE/LoanAmortizationPeriodType": Number.isInteger(s.loan_term) && s.loan_term > 0 ? "Month" : null,
    // Every product 20.4 prices amortizes fully (its Amortization type) and carries no temporary buydown, prepayment penalty or
    // construction phase (no such row on any rate sheet; `permanent_buydown` is the snapshot's only buydown and is a rate fact,
    // not a subsidy) — so the five LOAN_DETAIL indicators are the product's, derived, not defaulted.
    "LOAN_DETAIL/BalloonIndicator": amortization === null ? null : false,
    "LOAN_DETAIL/BorrowerCount": s.borrowers.length,
    "LOAN_DETAIL/BuydownTemporarySubsidyFundingIndicator": amortization === null ? null : false,
    "LOAN_DETAIL/ConstructionLoanIndicator": false,
    "LOAN_DETAIL/InterestOnlyIndicator": amortization === null ? null : false,
    "LOAN_DETAIL/NegativeAmortizationIndicator": amortization === null ? null : false,
    "LOAN_DETAIL/PrepaymentPenaltyIndicator": amortization === null ? null : false,
    "ORIGINATION_SYSTEMS/ORIGINATION_SYSTEM/LoanOriginationSystemName": LOAN_ORIGINATION_SYSTEM.name,
    "ORIGINATION_SYSTEMS/ORIGINATION_SYSTEM/LoanOriginationSystemVendorIdentifier": system_id_ref || null,
    "ORIGINATION_SYSTEMS/ORIGINATION_SYSTEM/LoanOriginationSystemVersionIdentifier": LOAN_ORIGINATION_SYSTEM.version,
    "REFINANCE/RefinanceCashOutDeterminationType": purpose?.cash_out ?? null,
    // conditional on RefinanceCashOutDeterminationType = CashOut (DU Spec conditionality; DI-C03/DI-C09 carry DebtConsolidation): the borrower's answer from 21.1's record, ABSENT when not given — the assembly then names the XPath as a gap (32.18 rule 7 re-sends the amount card)
    "REFINANCE/RefinancePrimaryPurposeType": purpose?.cash_out === "CashOut" ? (s.cash_out_purpose ?? null) : null,
    "TERMS_OF_LOAN/BaseLoanAmount": s.loan_amount_cents,
    // 23.1's casefile is the partner's first-lien conventional loan sold to Fannie Mae (loans.lien defaults to first; subordinate
    // financing reaches the snapshot as `subordinate_liens_cents` / `heloc_limit_cents`, somebody else's lien).
    "TERMS_OF_LOAN/LienPriorityType": "FirstLien",
    "TERMS_OF_LOAN/LoanPurposeType": purpose?.purpose ?? null,
    "TERMS_OF_LOAN/MortgageType": "Conventional",
    "TERMS_OF_LOAN/NoteRatePercent": /^\d+(\.\d{1,4})?$/.test(s.note_rate_pct) ? s.note_rate_pct : null,
  };
  const S = "DEAL_SETS/DEAL_SET/DEALS/DEAL/COLLATERALS/COLLATERAL/SUBJECT_PROPERTY";
  const message: Record<string, DuValue | null> = {
    [`${S}/PROPERTY_DETAIL/FinancedUnitCount`]: UNITS_DU[s.property_type] ?? null,
    [`${S}/PROPERTY_DETAIL/PropertyUsageType`]: OCCUPANCY_DU[s.occupancy] ?? null,
    [`${S}/PROPERTY_VALUATIONS/PROPERTY_VALUATION/PROPERTY_VALUATION_DETAIL/PropertyValuationAmount`]: s.appraised_value_cents,
    [`${S}/SALES_CONTRACTS/SALES_CONTRACT/SALES_CONTRACT_DETAIL/SalesContractAmount`]: s.loan_purpose === "purchase" ? s.sales_price_cents : null,
  };
  const present = (o: Record<string, DuValue | null>): Record<string, DuValue> => Object.fromEntries(Object.entries(o).filter((e): e is [string, DuValue] => e[1] !== null));
  return { loan: present(loan), message: present(message) };
}

/**
 * The DU Spec request: the DU Specification document (23.6) assembled from the 23.5 graph with the snapshot's deal
 * facts laid over it, `request_hash` = SHA-256 of its bytes. A refusal (DU_ENUM_NOT_SUPPORTED, DU_REQUIRED_MISSING,
 * DU_LENGTH, DU_CHILD_NOT_IN_ORDER …) is a `DuEmitError` naming the XPath, and no request exists.
 */
export function buildDuRequest(casefile: DuCasefile, i: BuildRequestInput): DuRequest {
  return buildDuRequestWithDocument(casefile, i).request;
}
/** `buildDuRequest` with the assembled `DuDocument` beside the request — the bus tool persists the bytes (du/persist.ts) without assembling twice. */
export function buildDuRequestWithDocument(casefile: DuCasefile, i: BuildRequestInput): { request: DuRequest; document: DuDocument } {
  const built_on = civilDateEt(i.built_at);
  const return_file_types = i.return_file_types ?? DEFAULT_RETURN_FILE_TYPES;
  const g = returnFileTypeGate({ built_on, return_file_types });
  if (!g.open) throw new DuRefused("FNMA_DU_RETURN_FILE_16_17_RETIRE", "DU 12.1 September Update Integration Impact Memo (July 29, 2026): Return File Types 16 and 17 retired November 30, 2026", g.reason ?? "closed");
  if (i.submission_type !== "credit_only" && casefile.credit_association.length === 0) throw new DuRefused("CREDIT_NOT_ASSOCIATED", "guardrail: never submit without a report for every borrower", "associate every borrower's credit report before an underwriting submission");
  const missing = i.snapshot.borrowers.filter((b) => i.submission_type !== "credit_only" && !casefile.credit_association.some((a) => a.borrower_id === b.borrower_id)).map((b) => b.borrower_id);
  if (missing.length) throw new DuRefused("REPORT_MISSING_FOR_BORROWER", "DU job aid: a credit report must be available in DU for every borrower", `no association for borrower(s) ${missing.join(", ")}`, "22.2");
  const submission_number = (i.prior_submission_number ?? 0) + 1;
  const graph = withDeal(i.graph ?? emptyGraph(casefile.application_id), dealFromSnapshot(i.snapshot, casefile.system_id_ref));
  const doc = assembleDuDocument(graph, { casefile_id: casefile.casefile_id, seller_number: casefile.seller_number, system_id_ref: casefile.system_id_ref }, { submission_number, submission_type: i.submission_type }, { conditionality: i.conditionality ?? "refuse" });
  const xml_document = new TextDecoder().decode(doc.bytes);
  return { document: doc, request: { casefile_id: casefile.casefile_id, application_id: casefile.application_id, submission_type: i.submission_type, reason: i.reason, built_at: i.built_at, built_on, return_file_types, snapshot: i.snapshot, credit_association: casefile.credit_association,
    // Rule 8 (23.6): DU's own identifier on a resubmission, never ours.
    automated_underwriting_case_identifier: submission_number > 1 ? graph.du_casefile_id : null, validation_report_refs: i.validation_report_refs ?? [], mismo_version: "3.4-B324", request_hash: doc.sha256, xml_document, document_id: i.document_id ?? randomUUID(),
    document: { sha256: doc.sha256, container_count: doc.stats.container_count, relationship_count: doc.stats.relationship_count, borrower_count: doc.stats.borrower_count, disputed_arcs_skipped: doc.stats.disputed_arcs_skipped, required_missing: doc.gaps.length, gaps: doc.gaps } } };
}

// ============================================================ the fnma-du port: src/infra/integrations/du.ts (23.7 rule 9); the spec's fixture findings live here
/** 23.7 rule 9: what `submitCasefile` hands the port — the emitted bytes, their hash, the casefile's credentials (and, for the FAKE, the request they came from). */
export function duSubmitRequest(casefile: Pick<DuCasefile, "casefile_id" | "seller_number" | "system_id_ref">, request: DuRequest, submission_number: number): DuSubmitRequest {
  return { document_bytes: new TextEncoder().encode(request.xml_document), sha256: request.request_hash, casefile_id: casefile.casefile_id, submission_number, seller_number: casefile.seller_number, system_id_ref: casefile.system_id_ref, source: request };
}
export interface ClosedLoanData { readonly occupancy: string; readonly product: string; readonly amortization: string; readonly loan_term: number; readonly property_type: string; readonly loan_purpose: string; readonly sales_price_cents: Cents | null; readonly appraised_value_cents: Cents; readonly note_rate_pct: string; readonly loan_amount_cents: Cents; }
export const closedLoanData = (s: UladSnapshot | ClosedLoanData): ClosedLoanData => ({ occupancy: s.occupancy, product: s.product, amortization: s.amortization, loan_term: s.loan_term, property_type: s.property_type, loan_purpose: s.loan_purpose, sales_price_cents: s.sales_price_cents, appraised_value_cents: s.appraised_value_cents, note_rate_pct: s.note_rate_pct, loan_amount_cents: s.loan_amount_cents });
/** Rule 5 / gate: the closed-loan snapshot hash — the eight B3-2-10 fields plus note rate, loan amount, term and product (CD-final values). */
export const closedLoanSnapshotHash = (s: UladSnapshot | ClosedLoanData): string => sha256(canonical(closedLoanData(s)));
/** What the FAKE DU knows about an asset verification report it is asked to validate against (32.18 rule 5): the payroll deposit stream the FAKE Plaid registered under the report reference. */
export interface FakeAssetReportFacts { readonly payroll_deposits?: { readonly employer: string; readonly monthly_cents: string | bigint; readonly months: number } | undefined; readonly report_days?: number | undefined }
/** 32.18 rule 5 — the FAKE DU validation service: an asset reference validates assets for every borrower; a 365-day reference with at least two months of payroll deposits validates employment; income is validated when the snapshot's qualifying income is within 10% of the report's monthly deposits, else not_validated. A 30/60-day reference validates assets only; no reference, no results. The real DU replaces this arithmetic with its own matching. */
export function fakeValidationResults(req: DuRequest, lookup: (identifier: string) => FakeAssetReportFacts | undefined, received_at: string): ValidationResult[] {
  const refs = req.validation_report_refs.filter((r) => /^asset/i.test(r.report_type) || /assetreport|asset_report/i.test(r.supplier_type));
  if (!refs.length) return [];
  const out: ValidationResult[] = [];
  const closeBy = civilDateEt(new Date(Date.parse(received_at) + 120 * 86_400_000).toISOString());
  for (const b of req.snapshot.borrowers) {
    out.push({ component: "assets", borrower_id: b.borrower_id, outcome: "validated", report_reference_id: refs[0]!.identifier });
    const twelve = refs.find((r) => /365/.test(r.report_type) || (lookup(r.identifier)?.report_days ?? 0) >= 365); if (!twelve) continue;
    const facts = lookup(twelve.identifier); const deposits = facts?.payroll_deposits;
    if (!deposits || deposits.months < 2) continue;
    out.push({ component: "employment", borrower_id: b.borrower_id, outcome: "validated", close_by_date: closeBy, report_reference_id: twelve.identifier });
    const monthly = BigInt(deposits.monthly_cents); const stated = req.snapshot.qualifying_income_cents;
    const within = monthly > 0n && (stated > monthly ? stated - monthly : monthly - stated) * 10n <= monthly;
    out.push({ component: "income", borrower_id: b.borrower_id, outcome: within ? "validated" : "not_validated", close_by_date: closeBy, report_reference_id: twelve.identifier });
  }
  return out;
}
/** 32.18 rule 5 — the FAKE DU's verification messages as DU 12.1 issues them (the fixtures' catalog: V1001 income, V1003 employment, V1004 assets, V1006/V1010 the refinanced lien, V1008 hazard, V1009 title, V1012 identity, V1014 flood): a component the validation service validated gets no documentation message, as the real findings omit it. */
export function fakeDuMessages(req: DuRequest, validation: readonly ValidationResult[]): DuMessage[] {
  const validated = (component: ValidationResult["component"], borrower_id: string): boolean => validation.some((v) => v.component === component && v.borrower_id === borrower_id && v.outcome === "validated");
  const out: DuMessage[] = [];
  for (const b of req.snapshot.borrowers) {
    if (!validated("income", b.borrower_id)) out.push({ id: "V1001", category: "verification", text: "Verify base income with the most recent paystub (30 days) and W-2 (1 year)", borrower_id: b.borrower_id });
    if (!validated("employment", b.borrower_id)) out.push({ id: "V1003", category: "verification", text: "Verbal verification of employment within 10 business days of the note date", borrower_id: b.borrower_id });
    if (!validated("assets", b.borrower_id) && req.snapshot.loan_purpose === "purchase") out.push({ id: "V1004", category: "verification", text: "Verify the funds for closing with the two most recent statements for each account", borrower_id: b.borrower_id });
  }
  if (req.snapshot.loan_purpose !== "purchase") { out.push({ id: "V1006", category: "verification", text: "Verify 12-month mortgage payment history on the existing lien" }); out.push({ id: "V1010", category: "verification", text: "Obtain the payoff statement for the existing first mortgage" }); }
  out.push({ id: "V1008", category: "verification", text: "Obtain evidence of hazard insurance coverage" }, { id: "V1009", category: "verification", text: "Obtain the title commitment" }, { id: "V1012", category: "verification", text: "Verify the borrowers' identity" }, { id: "V1014", category: "verification", text: "Obtain the flood zone determination" });
  return out;
}
/** The spec's fixture findings (the FAKE port's answer — src/infra/integrations/du.ts): Approve/Eligible with a value-acceptance offer; DTI/LTV computed from the echoed request; recommendation overridable per test. */
export function fixtureFindings(req: DuRequest, submission_number: number, received_at: string, recommendation: Recommendation = "approve_eligible", extra: Partial<DuFindings> = {}): DuFindings {
  const s = req.snapshot;
  const dti = dtiBps(s.total_obligations_cents, s.qualifying_income_cents);
  const ltv = ltvPct(s.loan_amount_cents, s.appraised_value_cents), cltv = ltvPct(s.loan_amount_cents + (s.subordinate_liens_cents ?? 0n), s.appraised_value_cents), hcltv = ltvPct(s.loan_amount_cents + (s.heloc_limit_cents ?? s.subordinate_liens_cents ?? 0n), s.appraised_value_cents);
  const base: DuFindings = { casefile_id: req.casefile_id, submission_number, recommendation, messages: [{ id: "DU-1", category: "verification", text: `Verify ${s.borrowers.length} borrower(s) income and assets per the findings.` }, ...(submission_number > 1 ? [{ id: "DU-LIAB", category: "verification", text: "Liabilities updated on resubmission — verify the new obligation." }] : [])],
    risk_factors: { dti: dtiDisplay(dti), ltv: ltv.toFixed(2) }, validation_results: [], value_acceptance_offer: { offered: true, property_value_cents: s.appraised_value_cents }, mi_requirement: ltv.cmp(Decimal.parse("80")) > 0 ? { required: true, coverage_pct: null } : { required: false, coverage_pct: null },
    dti_du: dtiDisplay(dti), ltv_du: ltv.toFixed(4), cltv_du: cltv.toFixed(4), hcltv_du: hcltv.toFixed(4), reserves_required_cents: 0n, total_funds_to_verify_cents: 0n, qualifying_rate: s.note_rate_pct, note_rate: s.note_rate_pct, loan_amount_cents: s.loan_amount_cents,
    evaluated: closedLoanData(s), findings_json: "", findings_pdf_ref: `pdf:${req.casefile_id}:${submission_number}`, received_at, du_version: DU_VERSION };
  const f = { ...base, ...extra };
  return { ...f, findings_json: canonical({ ...f, findings_json: undefined }) };
}
export const findingsHash = (f: DuFindings): string => sha256(canonical(closedLoanData({ ...f.evaluated })));

// ============================================================ R3/R6 — submission (guards, idempotency, resubmission cap, DI retry/outage)
export const RESUBMISSION_RATIONALE_AFTER = 10, RESUBMISSION_REVIEW_AFTER = 15;
export const DI_BACKOFF_MINUTES: readonly number[] = [2, 4, 8, 16];   // exponential: 4 attempts over 30 minutes
export const DI_OUTAGE_AFTER_MINUTES = DI_BACKOFF_MINUTES.reduce((a, b) => a + b, 0);
export interface SubmitInput {
  readonly request: DuRequest; readonly at: string; readonly prior: readonly DuSubmission[]; readonly projected_note_date: PlainDate | null;
  /** 21.1 SCIF gate facts (`borrowers[].scif_presented_at`) — DU submission delivers SCIF data. */
  readonly scif_facts: Record<string, unknown>;
  /** 22.1 relied documents for the credit-documents gate before the final submission. */
  readonly relied_documents?: readonly ReliedDocument[];
  readonly rationale?: string | null; readonly reviewer_approval_ref?: string | null; readonly agent_run_id?: string | null;
  readonly escalations?: { open(input: EscalationInput, by: Actor): Escalation } | null;
  /** 23.7: the preflight result for this request's document, when the caller holds it; otherwise the gate is read off the bus (`preflightGate`), and with no emission there the checks run here (`assertPreflightGateOpen`). */
  readonly preflight?: PreflightResult | null;
  /** 23.7 rule 9: where `applications.du_casefile_id` is read before transmit and written from the ack (`recordDuCasefileId`); without one, the prior submissions' acks stand in for the column. */
  readonly db?: DuCasefileIdStore | null;
}
/**
 * 23.7 rule 9's column, as the runtime hands it to `submitCasefile`: `read` is the pool (the SELECT before anything is
 * transmitted), `defer` queues the UPDATE into the command's transaction (src/runtime/app.ts `deferWrite`), so the
 * column commits with `du.submitted` and `du.casefile_id.recorded` — or not at all, if the command fails after the ack.
 */
export interface DuCasefileIdStore { readonly read: Queryable; readonly defer: (fn: (q: Queryable) => Promise<void>) => void; }
export interface SubmitResult { readonly submission: DuSubmission; readonly casefile: DuCasefile; readonly events: DomainEvent[]; readonly outage: { escalation: Escalation | null; attempts: number; declared_at: string } | null; readonly cutover: DomainEvent | null;
  /** 23.7 rule 9: what the ack's `du_casefile_id` did to `applications.du_casefile_id` (null on the outage and rejection paths — no ack). */
  readonly du_casefile: DuCasefileIdRecord | null;
  /** 23.7 rule 9 / 23.1 error path: DU refused the document (HTTP 400-class) — the submission row is `error`/`DU_REJECTED`, nothing was transmitted, no retry (null otherwise). */
  readonly rejected: { status: number; message: string } | null; }
const addMinutes = (iso: string, m: number): string => new Date(Date.parse(iso) + m * 60_000).toISOString();
/** Guards (state machine): SCIF presented; credit associated for every borrower; report not expired at the projected note date (or reason credit_refresh); duplicate hash suppressed; resubmission cap; final submission passes 22.1's credit-docs gate. */
export function assertSubmittable(casefile: DuCasefile, i: SubmitInput): void {
  const r = i.request;
  if (casefile.status === "archived" || casefile.status === "superseded") throw new DuRefused("CASEFILE_CLOSED", "B3-2-01: an archived casefile cannot be resubmitted — create a new one", `casefile ${casefile.casefile_id} is ${casefile.status}`);
  const scif = evaluateGate("21.1.scifPresentGate", i.scif_facts);
  if (!scif.open) throw new DuRefused("SM_O21_SCIF_PRESENT_GATE", "21.1 SM_O21_SCIF_PRESENT_GATE: SCIF data are delivered through DU", scif.reason ?? "closed");
  if (r.submission_type !== "credit_only") {
    if (casefile.credit_association.length === 0 || r.snapshot.borrowers.some((b) => !casefile.credit_association.some((a) => a.borrower_id === b.borrower_id))) throw new DuRefused("CREDIT_NOT_ASSOCIATED", "state machine: `submitted` requires `credit_associated` for all borrowers", "every borrower needs an associated credit report");
    if (r.reason !== "credit_refresh" && i.projected_note_date) for (const a of casefile.credit_association) assertCreditGateOpen("FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M", { expires_at: a.expires_at, scheduled_note_date: i.projected_note_date });
  }
  const last = i.prior.filter((p) => p.status !== "superseded").at(-1);
  if (last && last.request_hash === r.request_hash && r.reason !== "error_retry" && r.reason !== "final_closed_loan_match") throw new DuRefused("DUPLICATE_REQUEST_SUPPRESSED", "23.1 rule 3: two identical hashes in a row are suppressed unless reason ∈ {error_retry, final_closed_loan_match}", `request hash ${r.request_hash.slice(0, 12)}… equals submission ${last.submission_number}`);
  const n = casefile.submission_count;
  if (n >= RESUBMISSION_REVIEW_AFTER && !i.reviewer_approval_ref) throw new DuRefused("RESUBMISSION_CAP_REVIEW", "23.1 rule 6 / B3-2-11 excessive resubmissions: after the 15th submission `underwriting_reviewer` review is required", `submission ${n + 1} needs reviewer_approval_ref`, "underwriting_reviewer");
  if (n >= RESUBMISSION_RATIONALE_AFTER && !i.rationale) throw new DuRefused("RESUBMISSION_RATIONALE_REQUIRED", "23.1 rule 6: after the 10th submission the agent attaches a rationale for each further submission", `submission ${n + 1} needs a rationale`);
  if (r.reason === "final_closed_loan_match" && i.projected_note_date && i.relied_documents) assertDocumentGateOpen(casefile.application_id, "FNMA_B1_1_03_CREDIT_DOCS_4M", { relied_documents: i.relied_documents, scheduled_note_date: i.projected_note_date });
}
/**
 * 23.7 `SM_DU_PREFLIGHT_GATE` (not_before_gate; armed on `du.document.emitted`, satisfied by `du.preflight.passed`): a
 * refused document is refused here with the preflight code and the XPath, and `du.submitted` is never emitted for it
 * (23.7-T10); an emitted document nobody preflighted is held too (`SM_DU_PREFLIGHT_GATE`). A request no emission on
 * this bus preceded armed no gate and nobody ran the checks — the spec's trigger row is "on every submission", before
 * any bytes reach the port, and no bypass exists — so they run here, over the bytes that would go on the wire, with
 * the result on the bus (`du.preflight.passed` / `du.preflight.refused`, `inline: true`; no du_documents row exists to
 * persist it against). `du_casefile_id_on_file` is `applications.du_casefile_id` as read before transmit (rule 7).
 * There is no `officer` waiver: every refusal is a document DU would reject.
 */
export function assertPreflightGateOpen(events: EventStore, casefile: DuCasefile, i: SubmitInput, du_casefile_id_on_file: string | null, actor: Actor = AGENT): { state: "handed" | "passed" | "inline"; result: PreflightResult | null } {
  const r = i.request;
  const refuse = (f: NonNullable<PreflightResult["refusal"]>): never => { throw new DuRefused(f.code, `23.7 SM_DU_PREFLIGHT_GATE — ${f.rule}`, `preflight refused the document at ${f.xpath}: ${f.detail}`, "23.2"); };
  if (i.preflight) {
    if (i.preflight.passed) return { state: "handed", result: i.preflight };
    return refuse(i.preflight.refusal!);
  }
  const g = preflightGate(events, { document_id: r.document_id, sha256: r.request_hash });
  if (g.open) return { state: "passed", result: null };
  if (g.state !== "not_armed") throw new DuRefused(g.code ?? "SM_DU_PREFLIGHT_GATE", `23.7 SM_DU_PREFLIGHT_GATE — ${g.rule ?? "hold; du.submitted cannot be emitted for the document"}`, g.reason, g.state === "refused" ? "23.2" : "23.7");
  const submission_number = casefile.submission_count + 1;
  const result = runDuPreflight(r.xml_document, { du_casefile_id: du_casefile_id_on_file }, casefile, { submission_number, submission_type: r.submission_type });
  emitDuPreflight(events, { application_id: casefile.application_id, du_document_id: r.document_id, document_id: r.document_id, sha256: r.request_hash, casefile_id: casefile.casefile_id, submission_number, result, ran_at: i.at, actor, inline: true });
  if (result.passed) return { state: "inline", result };
  return refuse(result.refusal!);
}
export async function submitCasefile(events: EventStore, port: DuPort, casefile: DuCasefile, i: SubmitInput, actor: Actor = AGENT): Promise<SubmitResult> {
  assertSubmittable(casefile, i);
  // 23.7 rule 9: the column is read before anything is transmitted — an application that is not a row is refused here, never after DU has
  // acked (an ack is never dropped) — and feeds rule 7 (the identifier on the wire on a resubmission). Without a database the prior acks play it.
  const on_file = i.db ? await readDuCasefileIdColumn(i.db.read, casefile.application_id) : (i.prior.find((p) => p.du_casefile_id)?.du_casefile_id ?? null);
  assertPreflightGateOpen(events, casefile, i, on_file, actor);
  const r = i.request;
  const submission_number = casefile.submission_count + 1;
  const du_release_applied = duReleaseApplied(i.at);
  const base: DuSubmission = { submission_id: randomUUID(), casefile_id: casefile.casefile_id, application_id: casefile.application_id, submission_number, submission_type: r.submission_type, reason: r.reason, request_document_id: r.document_id, request_hash: r.request_hash, du_version: DU_VERSION, du_release_applied,
    return_file_types: r.return_file_types, findings_document_id: null, findings_json_document_id: null, findings_pdf_document_id: null, submitted_at: i.at, acked_at: null, findings_received_at: null, status: "queued", error_code: null, error_message: null, recommendation: null, messages: [], risk_factors: {}, validation_results: [], value_acceptance_offer: null, mi_requirement: null,
    dti_du: null, ltv_du: null, cltv_du: null, hcltv_du: null, reserves_required_cents: null, total_funds_to_verify_cents: null, qualifying_rate: null, note_rate: r.snapshot.note_rate_pct, loan_amount_cents: r.snapshot.loan_amount_cents, is_final: false, closed_loan_snapshot_hash: r.reason === "final_closed_loan_match" ? closedLoanSnapshotHash(r.snapshot) : null, findings_hash: null,
    snapshot: r.snapshot, rationale: i.rationale ?? null, submitted_via: "di_channel", agent_run_id: i.agent_run_id ?? null, validation_report_refs: r.validation_report_refs, du_casefile_id: null };
  const out: DomainEvent[] = [];
  let attempt = 0, elapsed = 0, ack: DuSubmitAck | null = null;
  while (attempt < DI_BACKOFF_MINUTES.length && !ack) {
    attempt++;
    const attempted_at = addMinutes(i.at, elapsed);
    try { ack = await port.submit(duSubmitRequest(casefile, r, submission_number)); }
    catch (e) {
      if (!(e instanceof DuTransportError)) throw e;
      if (e.status >= 400 && e.status < 500) {
        // DU refused what it was sent (the FAKE: xmllint against the chain, 23.7-T8) — a rejection, not the channel: no retry, no
        // transmission, 23.1's error path. Like the outage branch this RETURNS rather than throws, so the command that carries it
        // commits: the du_submissions row moves to `error` with `error_code = DU_REJECTED` "without a transmission" (23.7 Data model)
        // and `du.submission.errored` reaches loan_events (a handler that throws persists nothing — src/infra/db/unit-of-work.ts).
        // 23.7's preflight exists so this is never seen for a reason the corpus already knows; a new one is added to preflight in the
        // same commit as its triage (23.7 Edge cases).
        out.push(emit(events, casefile.application_id, "du.submission.errored", { casefile_id: casefile.casefile_id, submission_number, error_code: "DU_REJECTED", status: e.status, error_message: e.message, attempt, attempted_at, request_hash: r.request_hash, request_document_id: base.request_document_id, retry_in_minutes: null, transmitted: false,
          citation: "23.7 rule 9 / 23.1 error path: DU refused the document (HTTP 400-class); the error code is added to preflight with its triage", next: "23.7" }, attempted_at, actor));
        const submission: DuSubmission = { ...base, status: "error", error_code: "DU_REJECTED", error_message: e.message };
        return { submission, casefile: { ...casefile, status: "error", submission_count: submission_number, red_flag_excessive_resubmissions: submission_number > RESUBMISSION_RATIONALE_AFTER }, events: out, outage: null, cutover: null, du_casefile: null, rejected: { status: e.status, message: e.message } };
      }
      const wait = DI_BACKOFF_MINUTES[attempt - 1]!; elapsed += wait;
      out.push(emit(events, casefile.application_id, "du.submission.errored", { casefile_id: casefile.casefile_id, submission_number, error_code: "DI_TRANSPORT", error_message: e.message, attempt, attempted_at, retry_in_minutes: attempt < DI_BACKOFF_MINUTES.length ? wait : null }, attempted_at, actor));
    }
  }
  const prevRelease = i.prior.filter((p) => p.status !== "superseded").at(-1)?.du_release_applied ?? null;
  if (!ack) {
    const declared_at = addMinutes(i.at, DI_OUTAGE_AFTER_MINUTES);
    const submission: DuSubmission = { ...base, status: "queued", error_code: "DI_TRANSPORT_OUTAGE", error_message: `${attempt} attempts over ${DI_OUTAGE_AFTER_MINUTES} minutes failed` };
    const escalation = i.escalations ? i.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: casefile.application_id, severity: "sev2", payload: { reason: "DU Direct Integration outage — upload the SM-generated request through the DU web UI (accessdodu.fanniemae.com); no scraping/RPA", casefile_id: casefile.casefile_id, submission_number, request_document_id: base.request_document_id, request_hash: r.request_hash, request_file: r.xml_document, return_file_types: r.return_file_types, attempts: attempt, outage_declared_at: declared_at } }, actor) : null;
    out.push(emit(events, casefile.application_id, "du.submission.errored", { casefile_id: casefile.casefile_id, submission_number, error_code: "DI_TRANSPORT_OUTAGE", attempt, escalation_id: escalation?.id ?? null, owner_role: "fnma_portal_operator", request_document_id: base.request_document_id }, declared_at, actor));
    return { submission, casefile: { ...casefile, status: "error", submission_count: submission_number, red_flag_excessive_resubmissions: submission_number > RESUBMISSION_RATIONALE_AFTER }, events: out, outage: { escalation, attempts: attempt, declared_at }, cutover: null, du_casefile: null, rejected: null };
  }
  const submission: DuSubmission = { ...base, status: "acked", acked_at: ack.acked_at, du_casefile_id: ack.du_casefile_id };
  const last_updated_on = civilDateEt(i.at);
  const next: DuCasefile = { ...casefile, status: "submitted", submission_count: submission_number, last_updated_at: i.at, last_updated_on, ...archivalClocks(casefile.created_on, last_updated_on), red_flag_excessive_resubmissions: submission_number > RESUBMISSION_RATIONALE_AFTER };
  out.push(emit(events, casefile.application_id, "du.submitted", { casefile_id: casefile.casefile_id, submission_number, submission_type: r.submission_type, reason: r.reason, request_hash: r.request_hash, request_document_id: base.request_document_id, du_version: DU_VERSION, du_release_applied, policy_generation: casefile.policy_generation, return_file_types: r.return_file_types, last_updated_at: i.at, is_final_candidate: r.reason === "final_closed_loan_match", du_casefile_id: ack.du_casefile_id, acked_at: ack.acked_at }, i.at, actor));
  // 23.7 rule 9: DU's identifier is written once, from the first ack; a later ack naming a different one is a conflict for fnma_portal_operator, never an overwrite.
  const du_casefile = await recordDuCasefileId(i.db ?? null, events, casefile, { submission_number, du_casefile_id: ack.du_casefile_id, at: ack.acked_at, known: on_file, escalations: i.escalations ?? null }, actor);
  out.push(...du_casefile.events);
  const cutover = prevRelease && prevRelease !== du_release_applied ? emit(events, casefile.application_id, "du.version.cutover_applied", { casefile_id: casefile.casefile_id, submission_number, from: prevRelease, to: du_release_applied, policy_generation: casefile.policy_generation, creation_keyed_unchanged: ["du_validation_service.fixed_base_income_minimums", "du_validation_service.close_by_business_days"], submission_keyed_applied: ["cu_driven_ineligible", "lava_zone_messages", "message_catalog_11_25_7"] }, i.at, actor) : null;
  if (cutover) out.push(cutover);
  return { submission, casefile: next, events: out, outage: null, cutover, du_casefile, rejected: null };
}

// ============================================================ 23.7 rule 9 — DU's casefile identifier, written once
export const DU_CASEFILE_ID_WRITE_ONCE = "DU_CASEFILE_ID_WRITE_ONCE";
export interface RecordDuCasefileIdInput {
  readonly submission_number: number;
  /** What the ack carried. */
  readonly du_casefile_id: string;
  readonly at: string;
  /** `applications.du_casefile_id` as read before transmit (`readDuCasefileIdColumn`) — or, with no database, the prior submissions' acks. The outcome is decided from it alone; the trigger is the backstop at commit. */
  readonly known?: string | null;
  readonly escalations?: { open(input: EscalationInput, by: Actor): Escalation } | null;
}
export interface DuCasefileIdRecord {
  /** `written`: the column was null and the ack's id is queued for the command's commit; `unchanged`: it already held the same id (the trigger's same-value no-op); `conflict`: it holds a different one (what the trigger would refuse as DU_CASEFILE_ID_WRITE_ONCE) — escalated, never written. */
  readonly outcome: "written" | "unchanged" | "conflict";
  /** What `applications.du_casefile_id` holds after the call. */
  readonly on_file: string;
  readonly acked: string;
  readonly escalation: Escalation | null;
  readonly events: DomainEvent[];
}
/** `applications.du_casefile_id` as it stands — read on the pool before anything is transmitted (23.7 rule 9). An application that is not a row is refused before the port is touched, never after an ack. */
export async function readDuCasefileIdColumn(q: Queryable, application_id: string): Promise<string | null> {
  const rows = await q.query<{ du_casefile_id: string | null }>(`SELECT du_casefile_id FROM applications WHERE id = $1`, [application_id]);
  if (!rows.length) throw new DuRefused("APPLICATION_ROW_MISSING", "23.7 rule 9: applications.du_casefile_id is written from the first ack — the application is a row before anything is transmitted", `no applications row ${application_id}; nothing was transmitted`, "21.1");
  return rows[0]!.du_casefile_id;
}
/**
 * The findings ingest's write of `applications.du_casefile_id` from the first ack (23.7 rule 9; 23.5's column). The
 * outcome is decided from the column as read before transmit (`known` — `readDuCasefileIdColumn`, or the prior acks in
 * the unit harness): null → `written`, the UPDATE deferred into the command's transaction (`store.defer`) so it commits
 * with `du.submitted` and `du.casefile_id.recorded` or not at all; the same id → `unchanged`, nothing written; a
 * different id → `conflict`, `escalation{fnma_portal_operator, DU_CASEFILE_ID_CONFLICT}`, nothing written (23.7-T9).
 * db/migrations/0127_du_graph.sql's write-once trigger stays the backstop: if the column changed between the read and
 * the commit it raises DU_CASEFILE_ID_WRITE_ONCE and the whole command rolls back. Every outcome but `unchanged` is an event.
 */
export async function recordDuCasefileId(store: DuCasefileIdStore | null, events: EventStore, casefile: Pick<DuCasefile, "casefile_id" | "application_id">, i: RecordDuCasefileIdInput, actor: Actor = AGENT): Promise<DuCasefileIdRecord> {
  if (!/^\d{1,30}$/.test(i.du_casefile_id)) throw new RangeError(`du_casefile_id ${JSON.stringify(i.du_casefile_id)} is not DU's AutomatedUnderwritingCaseIdentifier (digits, at most 30)`);
  const before: string | null = i.known ?? null;
  const conflict = before !== null && before !== i.du_casefile_id;
  const out: DomainEvent[] = [];
  if (conflict) {
    const payload = { code: "DU_CASEFILE_ID_CONFLICT", reason: "DU_CASEFILE_ID_CONFLICT: a later acknowledgement named a DU casefile identifier different from the one on file; applications.du_casefile_id is write-once (23.7 rule 9) — confirm with Fannie Mae which casefile this application is on", casefile_id: casefile.casefile_id, submission_number: i.submission_number, du_casefile_id_on_file: before, du_casefile_id_acked: i.du_casefile_id, column: "applications.du_casefile_id", overwritten: false };
    const escalation = i.escalations ? i.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: casefile.application_id, severity: "sev2", payload }, actor) : null;
    out.push(emit(events, casefile.application_id, "du.casefile_id.conflict", { ...payload, escalation_id: escalation?.id ?? null, owner_role: "fnma_portal_operator" }, i.at, actor));
    return { outcome: "conflict", on_file: before!, acked: i.du_casefile_id, escalation, events: out };
  }
  if (before === null) {
    const application_id = casefile.application_id, du_casefile_id = i.du_casefile_id;
    if (store) store.defer(async (q) => { await q.query(`UPDATE applications SET du_casefile_id = $2 WHERE id = $1`, [application_id, du_casefile_id]); });
    out.push(emit(events, casefile.application_id, "du.casefile_id.recorded", { casefile_id: casefile.casefile_id, submission_number: i.submission_number, du_casefile_id, column: "applications.du_casefile_id", write_once: true, persisted: Boolean(store) }, i.at, actor));
    return { outcome: "written", on_file: i.du_casefile_id, acked: i.du_casefile_id, escalation: null, events: out };
  }
  return { outcome: "unchanged", on_file: before, acked: i.du_casefile_id, escalation: null, events: out };
}
/** DU findings (JSON v2 + PDF) parsed into the submission row; the `du.findings.received` payload is what 23.2/23.3/24.1/24.6/22.4 consume. */
export function receiveFindings(events: EventStore, casefile: DuCasefile, submission: DuSubmission, f: DuFindings, actor: Actor = AGENT, via: DuSubmission["submitted_via"] = submission.submitted_via): { submission: DuSubmission; casefile: DuCasefile; event: DomainEvent } {
  if (f.casefile_id !== casefile.casefile_id) throw new RangeError(`findings for casefile ${f.casefile_id} do not belong to ${casefile.casefile_id}`);
  if (f.submission_number !== submission.submission_number) throw new RangeError(`findings for submission ${f.submission_number} do not match queued submission ${submission.submission_number}`);
  const hash = findingsHash(f);
  const next: DuSubmission = { ...submission, status: "findings_received", findings_received_at: f.received_at, acked_at: submission.acked_at ?? f.received_at, error_code: null, error_message: null, recommendation: f.recommendation, messages: f.messages, risk_factors: f.risk_factors, validation_results: f.validation_results, value_acceptance_offer: f.value_acceptance_offer, mi_requirement: f.mi_requirement,
    dti_du: f.dti_du, ltv_du: f.ltv_du, cltv_du: f.cltv_du, hcltv_du: f.hcltv_du, reserves_required_cents: f.reserves_required_cents, total_funds_to_verify_cents: f.total_funds_to_verify_cents, qualifying_rate: f.qualifying_rate, findings_hash: hash,
    findings_json_document_id: `doc:du-findings-json:${casefile.casefile_id}:${submission.submission_number}`, findings_pdf_document_id: f.findings_pdf_ref ? `doc:du-findings-pdf:${casefile.casefile_id}:${submission.submission_number}` : null, findings_document_id: `doc:du-findings-json:${casefile.casefile_id}:${submission.submission_number}`, submitted_via: via };
  const last_updated_on = civilDateEt(f.received_at);
  const cf: DuCasefile = { ...casefile, status: f.recommendation === "error" ? "error" : "findings_received", last_updated_at: f.received_at, last_updated_on, ...archivalClocks(casefile.created_on, last_updated_on) };
  const event = emit(events, casefile.application_id, "du.findings.received", { casefile_id: casefile.casefile_id, submission_number: submission.submission_number, recommendation: f.recommendation, messages: f.messages, validation_results: f.validation_results, value_acceptance_offer: f.value_acceptance_offer, mi_requirement: f.mi_requirement, risk_factors: f.risk_factors,
    dti_du: f.dti_du, ltv_du: f.ltv_du, reserves_required_cents: String(f.reserves_required_cents), findings_hash: hash, request_hash: submission.request_hash, is_final_candidate: submission.reason === "final_closed_loan_match", last_updated_at: f.received_at, du_release_applied: submission.du_release_applied, policy_generation: casefile.policy_generation, submitted_via: via, retention_class: RETENTION_CLASS, borrower_deliverable: false }, f.received_at, actor);
  return { submission: next, casefile: cf, event };
}
/** DI outage fallback: the operator-uploaded findings are matched to the queued `du_submissions` row by casefile ID. */
export function ingestOperatorFindings(events: EventStore, casefile: DuCasefile, submissions: readonly DuSubmission[], f: DuFindings, operator: Actor): ReturnType<typeof receiveFindings> {
  if (operator.kind !== "human" || operator.role !== "fnma_portal_operator") throw new RangeError("operator-uploaded findings are ingested by fnma_portal_operator");
  const queued = submissions.find((s) => s.casefile_id === f.casefile_id && s.status === "queued");
  if (!queued) throw new DuRefused("NO_QUEUED_SUBMISSION", "23.1 integrations: a duplicate response is matched by casefile ID", `no queued du_submissions row on casefile ${f.casefile_id}`);
  return receiveFindings(events, casefile, queued, { ...f, submission_number: queued.submission_number }, operator, "du_ui_fallback");
}

// ============================================================ R4 — B3-2-10 as executable logic (one small function per tolerance)
export const DU_MAX_DTI_BPS = 5000, B3_2_10_DTI_LINE_BPS = 4500, B3_2_10_DTI_INCREASE_BPS = 300;
/** DTI in basis points (two decimals): round_half_up(obligations × 10000 / income) on cents — 501,000 / 1,200,000 → 4175 (41.75 %). */
export function dtiBps(obligations_cents: Cents, qualifying_income_cents: Cents): number {
  if (qualifying_income_cents <= 0n) throw new RangeError("qualifying_income_cents must be positive");
  if (obligations_cents < 0n) throw new RangeError("obligations_cents must be ≥ 0");
  return Number(divRound(obligations_cents * 10_000n, qualifying_income_cents, "HALF_UP"));
}
export const dtiDisplay = (bps: number): string => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
export interface DtiTest { readonly rule_code: "B3_2_10_DTI_45_OR_3PT" | "B3_2_10_DTI_OVER_50"; readonly result: CheckResult; readonly dti_before_bps: number; readonly dti_after_bps: number; readonly delta_bps: number; readonly dti_before: string; readonly dti_after: string; readonly delta: string;
  /** B3-2-10 "now exceed 45%": the recalculated DTI crosses 45 (dti_B ≤ 45.00 and dti_C > 45.00); a DTI already above 45 does not re-trigger. */
  readonly exceeds_45: boolean;
  /** "increase by 3 percentage points or more (if the recalculated DTI ratio is 50% or less)". */
  readonly increase_3_points: boolean; readonly already_over_45: boolean; readonly over_50: boolean; readonly check_22_2: ToleranceCheck; readonly citation: string; }
/** Rate increases, credit-report payment/balance discrepancies, additional debts and verified income lower than the application: resubmit if the DTI crosses 45.00 (dti_B ≤ 45.00 < dti_C) or rises ≥ 3.00 points with dti_C ≤ 50.00 — the Guide's own rows: 35 → 40 Yes, 44 → 46 Yes, 46 → 48 No, 46 → 50 Yes; > 50.00 is ineligible (B3-6-02) → 23.2 restructuring. 22.2's tenths check is recorded alongside (its mirror reads "exceed" as a level, so it can differ on a DTI already above 45). */
export function dtiTest(before: { obligations_cents: Cents; income_cents: Cents }, after: { obligations_cents: Cents; income_cents: Cents }): DtiTest {
  const b = dtiBps(before.obligations_cents, before.income_cents), a = dtiBps(after.obligations_cents, after.income_cents), delta = a - b;
  const already_over_45 = b > B3_2_10_DTI_LINE_BPS, over_50 = a > DU_MAX_DTI_BPS;
  const exceeds_45 = !already_over_45 && a > B3_2_10_DTI_LINE_BPS, increase_3_points = delta >= B3_2_10_DTI_INCREASE_BPS && !over_50;
  const check_22_2 = b3210ToleranceCheck(dtiTenths(before.obligations_cents, before.income_cents), dtiTenths(after.obligations_cents, after.income_cents));
  const result: CheckResult = over_50 ? "ineligible_change" : exceeds_45 || increase_3_points ? "resubmission_required" : "within_tolerance";
  return { rule_code: over_50 ? "B3_2_10_DTI_OVER_50" : "B3_2_10_DTI_45_OR_3PT", result, dti_before_bps: b, dti_after_bps: a, delta_bps: delta, dti_before: dtiDisplay(b), dti_after: dtiDisplay(a), delta: `${delta < 0 ? "-" : ""}${dtiDisplay(Math.abs(delta))}`, exceeds_45, increase_3_points, already_over_45, over_50, check_22_2,
    citation: over_50 ? "B3-6-02: 'the maximum allowable DTI ratio is 50%' for DU loan casefiles" : "B3-2-10: resubmit when the recalculated DTI ratio will 'now exceed 45%, or increase by 3 percentage points or more (if the recalculated DTI ratio is 50% or less)' — 35 → 40 Yes; 44 → 46 Yes; 46 → 48 No; 46 → 50 Yes" };
}
export interface RateTest { readonly rule_code: "B3_2_10_RATE_DECREASE" | "B3_2_10_RATE_DECREASE_BUYDOWN" | null; readonly result: CheckResult | null; readonly direction: "decrease" | "increase" | "unchanged"; readonly rate_before: string; readonly rate_after: string; readonly evaluate_dti: boolean; readonly citation: string; }
/** Rate decrease: no resubmission unless from a permanent buydown; an increase is a trigger only through the DTI test (rule 5 resubmits before closing anyway). */
export function rateTest(rate_before_pct: string, rate_after_pct: string, permanent_buydown = false): RateTest {
  const c = Decimal.parse(rate_after_pct).cmp(Decimal.parse(rate_before_pct));
  if (c < 0) return permanent_buydown
    ? { rule_code: "B3_2_10_RATE_DECREASE_BUYDOWN", result: "resubmission_required", direction: "decrease", rate_before: rate_before_pct, rate_after: rate_after_pct, evaluate_dti: false, citation: "B3-2-10: a decrease resulting from a permanent buydown — 'Loan casefile must be resubmitted to DU'" }
    : { rule_code: "B3_2_10_RATE_DECREASE", result: "within_tolerance", direction: "decrease", rate_before: rate_before_pct, rate_after: rate_after_pct, evaluate_dti: false, citation: "B3-2-10: interest-rate decreases — 'No resubmission required'" };
  if (c > 0) return { rule_code: null, result: null, direction: "increase", rate_before: rate_before_pct, rate_after: rate_after_pct, evaluate_dti: true, citation: "B3-2-10: an interest-rate increase is tested through the recalculated DTI (45 % / 3 points)" };
  return { rule_code: null, result: null, direction: "unchanged", rate_before: rate_before_pct, rate_after: rate_after_pct, evaluate_dti: false, citation: "no rate change" };
}
/** LTV as a Decimal percent (four decimals kept: 560,500 / 800,000 → 70.0625). */
export const ltvPct = (loan_amount_cents: Cents, value_cents: Cents): Decimal => { if (value_cents <= 0n) throw new RangeError("value_cents must be positive"); return Decimal.ratio(loan_amount_cents * 100n, value_cents, "HALF_UP"); };
const LTV_BAND_UPPER_BPS = [3000, 6000, 7000, 7500, 8000, 8500, 9000, 9500] as const;
/** The LLPA Matrix (09.09.2026) LTV column (nine bands, 20.4 `LTV_BANDS`) for an exact LTV — 70.0625 % is in 70.01–75.00 %. */
export function llpaLtvBand(ltv: Decimal): (typeof LTV_BANDS)[number] {
  const bps = ltv.mul(Decimal.fromInt(100));   // exact hundredths of a percent, unrounded
  for (let i = 0; i < LTV_BAND_UPPER_BPS.length; i++) if (bps.cmp(Decimal.fromInt(LTV_BAND_UPPER_BPS[i]!)) <= 0) return LTV_BANDS[i]!;
  return LTV_BANDS[8]!;
}
const MI_BAND_UPPER_BPS = [8500, 9000, 9500, 9700] as const;
/** B7-1-02 coverage bands (20.4 `MIN_MI_LTV_BANDS`): null at or below 80 %. */
export function miCoverageBand(ltv: Decimal): (typeof MIN_MI_LTV_BANDS)[number] | null {
  const bps = ltv.mul(Decimal.fromInt(100));
  if (bps.cmp(Decimal.fromInt(8000)) <= 0) return null;
  for (let i = 0; i < MI_BAND_UPPER_BPS.length; i++) if (bps.cmp(Decimal.fromInt(MI_BAND_UPPER_BPS[i]!)) <= 0) return MIN_MI_LTV_BANDS[i]!;
  return MIN_MI_LTV_BANDS[3]!;
}
export const REFI_INCREASE_CAP_CENTS = 50_000n, REFI_INCREASE_PCT = 1n, REFI_DECREASE_PCT = 5n;
export interface RefiAmountTolerance { readonly max_increase_cents: Cents; readonly max_decrease_cents: Cents; readonly ceiling_cents: Cents; readonly floor_cents: Cents; readonly one_pct_cents: Cents; }
/** "may increase $500 or up to 1% of the loan amount, whichever is less" and "may decrease 5% of the loan amount". */
export function refiAmountTolerance(baseline_cents: Cents): RefiAmountTolerance {
  const one_pct_cents = baseline_cents * REFI_INCREASE_PCT / 100n;
  const max_increase_cents = one_pct_cents < REFI_INCREASE_CAP_CENTS ? one_pct_cents : REFI_INCREASE_CAP_CENTS, max_decrease_cents = baseline_cents * REFI_DECREASE_PCT / 100n;
  return { max_increase_cents, max_decrease_cents, ceiling_cents: baseline_cents + max_increase_cents, floor_cents: baseline_cents - max_decrease_cents, one_pct_cents };
}
export interface LoanAmountTest {
  readonly rule_code: "B3_2_10_REFI_AMOUNT_500_1PCT" | "B3_2_10_REFI_AMOUNT_MINUS_5PCT" | "B3_2_10_PURCHASE_AMOUNT" | null; readonly result: CheckResult; readonly amount_test: "pass" | "fail" | "n_a"; readonly condition_failed: "mi_coverage" | "llpa_band" | "eligibility" | null;
  readonly amount_before_cents: Cents; readonly amount_after_cents: Cents; readonly tolerance: RefiAmountTolerance | null; readonly ltv_before: string; readonly ltv_after: string; readonly llpa_band_before: string; readonly llpa_band_after: string; readonly mi_band_before: string | null; readonly mi_band_after: string | null; readonly eligibility_flag: boolean; readonly citation: string;
}
/** Refinance: inside the $500-or-1 % / −5 % band AND no MI-coverage, LLPA-column or eligibility change; purchase: any change resubmits. LCOR cash-back (B2-1.3-02) is never excused here. */
export function loanAmountTest(before: Pick<UladSnapshot, "loan_purpose" | "loan_amount_cents" | "appraised_value_cents" | "max_ltv_pct">, after: Pick<UladSnapshot, "loan_amount_cents" | "appraised_value_cents" | "max_ltv_pct">): LoanAmountTest {
  const lb = ltvPct(before.loan_amount_cents, before.appraised_value_cents), la = ltvPct(after.loan_amount_cents, after.appraised_value_cents);
  const base = { amount_before_cents: before.loan_amount_cents, amount_after_cents: after.loan_amount_cents, ltv_before: lb.toFixed(4), ltv_after: la.toFixed(4), llpa_band_before: llpaLtvBand(lb), llpa_band_after: llpaLtvBand(la), mi_band_before: miCoverageBand(lb), mi_band_after: miCoverageBand(la) };
  const maxLtv = after.max_ltv_pct ?? before.max_ltv_pct ?? null;
  const eligibility_flag = maxLtv !== null && la.cmp(Decimal.parse(maxLtv)) > 0 && lb.cmp(Decimal.parse(maxLtv)) <= 0;
  if (before.loan_amount_cents === after.loan_amount_cents) return { ...base, rule_code: null, result: "within_tolerance", amount_test: "n_a", condition_failed: null, tolerance: null, eligibility_flag: false, citation: "no loan-amount change" };
  if (before.loan_purpose === "purchase") return { ...base, rule_code: "B3_2_10_PURCHASE_AMOUNT", result: "resubmission_required", amount_test: "fail", condition_failed: null, tolerance: null, eligibility_flag, citation: "B3-2-10 states no loan-amount tolerance for purchase transactions — any change is a resubmission trigger" };
  const tolerance = refiAmountTolerance(before.loan_amount_cents);
  const increase = after.loan_amount_cents > before.loan_amount_cents;
  if (after.loan_amount_cents > tolerance.ceiling_cents) return { ...base, rule_code: "B3_2_10_REFI_AMOUNT_500_1PCT", result: "resubmission_required", amount_test: "fail", condition_failed: null, tolerance, eligibility_flag, citation: "B3-2-10: 'The loan amount may increase $500 or up to 1% of the loan amount, whichever is less'" };
  if (after.loan_amount_cents < tolerance.floor_cents) return { ...base, rule_code: "B3_2_10_REFI_AMOUNT_MINUS_5PCT", result: "resubmission_required", amount_test: "fail", condition_failed: null, tolerance, eligibility_flag, citation: "B3-2-10: the loan amount 'may decrease 5% of the loan amount'" };
  const condition_failed = base.mi_band_before !== base.mi_band_after ? "mi_coverage" : base.llpa_band_before !== base.llpa_band_after ? "llpa_band" : eligibility_flag ? "eligibility" : null;
  const rule_code = increase ? "B3_2_10_REFI_AMOUNT_500_1PCT" : "B3_2_10_REFI_AMOUNT_MINUS_5PCT";
  if (condition_failed) return { ...base, rule_code, result: "resubmission_required", amount_test: "pass", condition_failed, tolerance, eligibility_flag, citation: `B3-2-10: the tolerance applies only 'provided the new LTV/CLTV does not result in changes to mortgage insurance coverage, loan-level price adjustments, or loan eligibility' — ${condition_failed === "llpa_band" ? `LLPA column ${base.llpa_band_before} → ${base.llpa_band_after} (LLPA Matrix ${LLPA_MATRIX_VERSION})` : condition_failed === "mi_coverage" ? `MI coverage band ${String(base.mi_band_before)} → ${String(base.mi_band_after)} (B7-1-02)` : `LTV ${la.toFixed(4)} exceeds the Eligibility Matrix maximum ${String(maxLtv)}`}` };
  return { ...base, rule_code, result: "within_tolerance", amount_test: "pass", condition_failed: null, tolerance, eligibility_flag: false, citation: "B3-2-10 refinance loan-amount tolerance met; no MI / LLPA / eligibility change" };
}
export const RESERVES_TOLERANCE_PCT = 90n;
export interface ReservesTest { readonly rule_code: "B3_2_10_RESERVES_90PCT"; readonly result: CheckResult; readonly reserves_required_cents: Cents; readonly reserves_verified_cents: Cents; readonly threshold_cents: Cents; readonly verified_pct: string; readonly citation: string; }
/** Resubmit when verified reserves < floor(required × 90 / 100) — 90.00 % exactly is within tolerance. */
export function reservesTest(reserves_required_cents: Cents, reserves_verified_cents: Cents): ReservesTest {
  if (reserves_required_cents < 0n || reserves_verified_cents < 0n) throw new RangeError("reserves must be ≥ 0");
  const threshold_cents = reserves_required_cents * RESERVES_TOLERANCE_PCT / 100n;
  const verified_pct = reserves_required_cents === 0n ? "100.00" : Decimal.ratio(reserves_verified_cents * 100n, reserves_required_cents, "HALF_UP").toFixed(2);
  return { rule_code: "B3_2_10_RESERVES_90PCT", result: reserves_verified_cents < threshold_cents ? "resubmission_required" : "within_tolerance", reserves_required_cents, reserves_verified_cents, threshold_cents, verified_pct, citation: "B3-2-10: no resubmission when documented reserves equal 'at least 90% of the Reserves Required to be Verified'" };
}
export interface FundsToCloseTest { readonly rule_code: "B3_2_10_FUNDS_TO_CLOSE" | null; readonly result: CheckResult; readonly du_funds_required_cents: Cents; readonly actual_funds_required_cents: Cents; readonly documented_liquid_assets_cents: Cents; readonly shortfall_cents: Cents; readonly citation: string; }
/** B3-2-10 "Assets — Funds Required to Close": when the actual funds required exceed DU's figure, within tolerance only when documented liquid assets cover the actual amount (B3-2-02: "the lender must document liquid assets to cover the additional amount"); otherwise resubmit. */
export function fundsToCloseTest(du_funds_required_cents: Cents, actual_funds_required_cents: Cents, documented_liquid_assets_cents: Cents): FundsToCloseTest {
  if (du_funds_required_cents < 0n || actual_funds_required_cents < 0n || documented_liquid_assets_cents < 0n) throw new RangeError("funds to close and liquid assets must be ≥ 0");
  const base = { du_funds_required_cents, actual_funds_required_cents, documented_liquid_assets_cents };
  if (actual_funds_required_cents <= du_funds_required_cents) return { ...base, rule_code: null, result: "within_tolerance", shortfall_cents: 0n, citation: "B3-2-10: the actual funds required to close do not exceed DU's 'Funds Required to Close'" };
  const shortfall_cents = documented_liquid_assets_cents >= actual_funds_required_cents ? 0n : actual_funds_required_cents - documented_liquid_assets_cents;
  return shortfall_cents === 0n
    ? { ...base, rule_code: null, result: "within_tolerance", shortfall_cents, citation: "B3-2-10 / B3-2-02: actual funds required exceed DU's 'Funds Required to Close' but 'the lender has documented sufficient liquid assets to cover the actual amount of assets required to close the transaction, no resubmission required'" }
    : { ...base, rule_code: "B3_2_10_FUNDS_TO_CLOSE", result: "resubmission_required", shortfall_cents, citation: "B3-2-10: actual funds required exceed DU's 'Funds Required to Close' and documented liquid assets do not cover the actual amount — 'loan casefile must be resubmitted to DU' (B3-2-02: 'the lender must document liquid assets to cover the additional amount')" };
}
export interface IncomeLimitedTest { readonly rule_code: "B3_2_10_INCOME_LIMITED" | null; readonly result: CheckResult | null; readonly income_before_cents: Cents; readonly income_after_cents: Cents; readonly ami_retest: "23.2" | null; readonly evaluate_dti: boolean; readonly citation: string; }
/** Income-limited products (HomeReady): resubmit when verified income is greater than the application indicates; a decrease is governed by the DTI test and 23.2 re-runs the AMI test. */
export function incomeLimitedTest(income_before_cents: Cents, income_after_cents: Cents, income_limited_product: boolean): IncomeLimitedTest {
  if (!income_limited_product || income_after_cents === income_before_cents) return { rule_code: null, result: null, income_before_cents, income_after_cents, ami_retest: null, evaluate_dti: income_after_cents !== income_before_cents, citation: income_limited_product ? "no income change" : "not an income-limited product — income changes are tested through DTI" };
  if (income_after_cents > income_before_cents) return { rule_code: "B3_2_10_INCOME_LIMITED", result: "resubmission_required", income_before_cents, income_after_cents, ami_retest: "23.2", evaluate_dti: true, citation: "B3-2-10: verified income for loans subject to income limits — 'Income is greater than the loan application indicates' → 'Loan casefile must be resubmitted to DU'" };
  return { rule_code: null, result: null, income_before_cents, income_after_cents, ami_retest: "23.2", evaluate_dti: true, citation: "B3-2-10: a lower verified income is caught by the DTI test; 23.2 re-runs the HomeReady AMI test on the verified figure" };
}
export interface ClosedLoanFieldsTest { readonly rule_code: "B3_2_10_CLOSED_LOAN_FIELD" | null; readonly result: CheckResult; readonly differences: { field: ClosedLoanField; before: unknown; after: unknown }[]; readonly citation: string; }
/** The unconditional rule: any difference in the eight named fields between the final submission and the closed loan resubmits regardless of tolerance. */
export function closedLoanFieldsTest(final_submission: UladSnapshot | ClosedLoanData, closed: UladSnapshot | ClosedLoanData): ClosedLoanFieldsTest {
  const a = closedLoanData(final_submission), b = closedLoanData(closed);
  const key = (f: ClosedLoanField): keyof ClosedLoanData => (f === "sales_price" ? "sales_price_cents" : f === "appraised_value" ? "appraised_value_cents" : f);
  const differences = CLOSED_LOAN_FIELDS.filter((f) => a[key(f)] !== b[key(f)]).map((f) => ({ field: f, before: a[key(f)], after: b[key(f)] }));
  return { rule_code: differences.length ? "B3_2_10_CLOSED_LOAN_FIELD" : null, result: differences.length ? "resubmission_required" : "within_tolerance", differences, citation: "B3-2-10: 'The data submitted to DU must reflect the loan as it was closed, including occupancy type, product type, amortization, loan term, property type, loan purpose, sales price, and appraised value'" };
}
export interface CreditExpiryTest { readonly rule_code: "B3_2_01_CREDIT_EXPIRED" | null; readonly result: CheckResult; readonly expires_at: PlainDate; readonly projected_note_date: PlainDate; readonly new_report_required: boolean; readonly citation: string; }
/** A report expiring before the projected note date needs a new report before any resubmission (reason `credit_refresh`). */
export function creditExpiryTest(expires_at: PlainDate, projected_note_date: PlainDate): CreditExpiryTest {
  const expired = expires_at < projected_note_date;
  return { rule_code: expired ? "B3_2_01_CREDIT_EXPIRED" : null, result: expired ? "resubmission_required" : "within_tolerance", expires_at, projected_note_date, new_report_required: expired, citation: "B3-2-01: 'If the credit report expired prior to the note date and the loan casefile is being resubmitted to DU, a new credit report must be requested'" };
}

// ============================================================ R4 — evaluateResubmission over baseline B and candidate C
export interface ResubmissionInput { readonly baseline: DuSubmission; readonly candidate: UladSnapshot; readonly trigger_event: string; readonly at: string; readonly reserves_required_cents?: Cents | null; readonly verified_reserves_cents?: Cents | null;
  /** B3-2-10 "Assets — Funds Required to Close" (rule 4 `assets`): DU's figure, the actual amount required, and the liquid assets documented (22.4). */
  readonly du_funds_required_to_close_cents?: Cents | null; readonly actual_funds_required_to_close_cents?: Cents | null; readonly documented_liquid_assets_cents?: Cents | null; readonly credit_report_updated?: boolean; readonly validation_report_updated?: boolean; readonly credit_expires_at?: PlainDate | null; readonly projected_note_date?: PlainDate | null; readonly agent_decision_id?: string | null; }
export interface ResubmissionEvaluation { readonly checks: readonly DuResubmissionCheck[]; readonly result: CheckResult; readonly rule_codes: readonly RuleCode[]; readonly reason: SubmissionReason | null; readonly submission_blocked: boolean; readonly restructure_hand_off: "23.2" | null; readonly ami_retest: "23.2" | null; readonly arithmetic: Record<string, unknown>; readonly event: DomainEvent; readonly casefile_status: CasefileStatus; }
const ORDER: Record<CheckResult, number> = { within_tolerance: 0, resubmission_required: 1, new_casefile_required: 2, ineligible_change: 3 };
/** Every B3-2-10 test over the diff; the worst result governs. `resubmission_required` → `du.resubmission.required`; `within_tolerance` → `du.resubmission.waived` (audit trail); `ineligible_change` → 23.2's restructuring loop, no submission until the structure changes. */
export function evaluateResubmission(events: EventStore, casefile: DuCasefile, i: ResubmissionInput, actor: Actor = AGENT): ResubmissionEvaluation {
  const B = i.baseline.snapshot, C = i.candidate;
  if (B.application_id !== C.application_id) throw new RangeError("baseline and candidate belong to different applications");
  const checks: DuResubmissionCheck[] = [];
  const row = (field: CheckField, rule_code: RuleCode, result: CheckResult, old_value: unknown, new_value: unknown, arithmetic: Record<string, unknown>, citation: string): void => {
    checks.push({ id: randomUUID(), application_id: casefile.application_id, casefile_id: casefile.casefile_id, baseline_submission_id: i.baseline.submission_id, trigger_event: i.trigger_event, field, old_value, new_value, rule_code, result, arithmetic, evaluated_at: i.at, resubmission_id: null, agent_decision_id: i.agent_decision_id ?? null, citation });
  };
  const arithmetic: Record<string, unknown> = {};
  // note rate
  const rate = rateTest(B.note_rate_pct, C.note_rate_pct, C.permanent_buydown ?? false);
  if (rate.rule_code && rate.result) row("note_rate", rate.rule_code, rate.result, B.note_rate_pct, C.note_rate_pct, { direction: rate.direction }, rate.citation);
  // income-limited products
  const inc = incomeLimitedTest(B.qualifying_income_cents, C.qualifying_income_cents, C.income_limited_product ?? B.income_limited_product ?? false);
  if (inc.rule_code && inc.result) row("income", inc.rule_code, inc.result, B.qualifying_income_cents, C.qualifying_income_cents, { ami_retest: inc.ami_retest }, inc.citation);
  // DTI (rate increase, credit-report discrepancies / additional debts, verified income lower than the application — never assets: those are the funds-to-close and reserves rows)
  const obligationsChanged = B.total_obligations_cents !== C.total_obligations_cents, incomeChanged = B.qualifying_income_cents !== C.qualifying_income_cents;
  if (rate.evaluate_dti || obligationsChanged || incomeChanged) {
    const d = dtiTest({ obligations_cents: B.total_obligations_cents, income_cents: B.qualifying_income_cents }, { obligations_cents: C.total_obligations_cents, income_cents: C.qualifying_income_cents });
    Object.assign(arithmetic, { dti_before: d.dti_before, dti_after: d.dti_after, dti_delta: d.delta, obligations_before_cents: String(B.total_obligations_cents), obligations_after_cents: String(C.total_obligations_cents) });
    row(obligationsChanged ? "liabilities" : incomeChanged ? "income" : "dti", d.rule_code, d.result, d.dti_before, d.dti_after, { dti_before: d.dti_before, dti_after: d.dti_after, delta: d.delta, exceeds_45: d.exceeds_45, increase_3_points: d.increase_3_points, over_50: d.over_50, check_22_2: d.check_22_2.result }, d.citation);
  }
  // loan amount (refinance tolerance with the MI / LLPA / eligibility proviso; purchase: none)
  if (B.loan_amount_cents !== C.loan_amount_cents) {
    const t = loanAmountTest(B, C);
    Object.assign(arithmetic, { amount_before: String(B.loan_amount_cents), amount_after: String(C.loan_amount_cents), ltv_before: t.ltv_before, ltv_after: t.ltv_after });
    row("loan_amount", t.rule_code!, t.result, B.loan_amount_cents, C.loan_amount_cents, { amount_test: t.amount_test, condition_failed: t.condition_failed, max_increase_cents: t.tolerance ? String(t.tolerance.max_increase_cents) : null, max_decrease_cents: t.tolerance ? String(t.tolerance.max_decrease_cents) : null, ltv_before: t.ltv_before, ltv_after: t.ltv_after, llpa_band_before: t.llpa_band_before, llpa_band_after: t.llpa_band_after, mi_band_before: t.mi_band_before, mi_band_after: t.mi_band_after, eligibility_flag: t.eligibility_flag }, t.citation);
    if (t.condition_failed === "llpa_band") row("llpa_band", t.rule_code!, "resubmission_required", t.llpa_band_before, t.llpa_band_after, { matrix: LLPA_MATRIX_VERSION }, t.citation);
    if (t.condition_failed === "mi_coverage") row("mi_coverage", t.rule_code!, "resubmission_required", t.mi_band_before, t.mi_band_after, { table: "B7-1-02" }, t.citation);
    if (t.condition_failed === "eligibility") row("eligibility_flag", t.rule_code!, "resubmission_required", t.ltv_before, t.ltv_after, { max_ltv_pct: C.max_ltv_pct ?? B.max_ltv_pct ?? null }, t.citation);
  }
  // reserves
  if (i.reserves_required_cents !== undefined && i.reserves_required_cents !== null && i.verified_reserves_cents !== undefined && i.verified_reserves_cents !== null) {
    const r = reservesTest(i.reserves_required_cents, i.verified_reserves_cents);
    Object.assign(arithmetic, { reserves_required: String(r.reserves_required_cents), reserves_verified: String(r.reserves_verified_cents) });
    row("reserves", r.rule_code, r.result, r.reserves_required_cents, r.reserves_verified_cents, { threshold_cents: String(r.threshold_cents), verified_pct: r.verified_pct }, r.citation);
  }
  // assets — funds required to close (B3-2-10 / B3-2-02)
  if (i.du_funds_required_to_close_cents != null && i.actual_funds_required_to_close_cents != null && i.documented_liquid_assets_cents != null) {
    const f = fundsToCloseTest(i.du_funds_required_to_close_cents, i.actual_funds_required_to_close_cents, i.documented_liquid_assets_cents);
    Object.assign(arithmetic, { du_funds_required_to_close: String(f.du_funds_required_cents), actual_funds_required_to_close: String(f.actual_funds_required_cents), documented_liquid_assets: String(f.documented_liquid_assets_cents) });
    if (f.actual_funds_required_cents > f.du_funds_required_cents) row("assets", f.rule_code ?? "B3_2_10_FUNDS_TO_CLOSE", f.result, f.du_funds_required_cents, f.actual_funds_required_cents, { documented_liquid_assets_cents: String(f.documented_liquid_assets_cents), shortfall_cents: String(f.shortfall_cents) }, f.citation);
  }
  // closed-loan fields (unconditional)
  const cl = closedLoanFieldsTest(B, C);
  if (cl.rule_code) row(cl.differences[0]!.field, cl.rule_code, cl.result, cl.differences.map((d) => ({ [d.field]: d.before })), cl.differences.map((d) => ({ [d.field]: d.after })), { fields: cl.differences.map((d) => d.field) }, cl.citation);
  // credit report / validation report
  if (i.credit_expires_at && i.projected_note_date) { const ce = creditExpiryTest(i.credit_expires_at, i.projected_note_date); if (ce.rule_code) row("credit_report", ce.rule_code, ce.result, ce.expires_at, ce.projected_note_date, { new_report_required: true }, ce.citation); }
  if (i.credit_report_updated) row("credit_report", "B3_2_01_CREDIT_EXPIRED", "resubmission_required", "prior report", "refreshed report", { reason: "credit_refresh" }, "23.1 rule 4: a refreshed report always triggers resubmission (reason credit_refresh)");
  if (i.validation_report_updated) row("validation_report", "B3_2_02_VALIDATION_UPDATE", "resubmission_required", "prior report", "updated report", { relief: "A2-2-04 requires the post-update validated message" }, "B3-2-02: 'If the lender obtains an updated verification report, the lender must resubmit the loan to DU'");
  const result: CheckResult = checks.reduce<CheckResult>((w, c) => (ORDER[c.result] > ORDER[w] ? c.result : w), "within_tolerance");
  const rule_codes = [...new Set(checks.filter((c) => c.result !== "within_tolerance").map((c) => c.rule_code))];
  const reason: SubmissionReason | null = result === "within_tolerance" ? null : i.credit_report_updated || rule_codes.includes("B3_2_01_CREDIT_EXPIRED") ? "credit_refresh" : i.validation_report_updated ? "validation_report_update" : "tolerance_breach";
  const restructure = result === "ineligible_change";
  const ami_retest = inc.ami_retest;
  const payload = { casefile_id: casefile.casefile_id, baseline_submission_number: i.baseline.submission_number, trigger_event: i.trigger_event, result, rule_codes, reason, arithmetic, check_ids: checks.map((c) => c.id), submission_blocked: restructure, restructure_hand_off: restructure ? "23.2" : null, ami_retest, final_submission_will_carry_change: true };
  const event = result === "within_tolerance" ? emit(events, casefile.application_id, "du.resubmission.waived", { ...payload, waived_rule_codes: [...new Set(checks.map((c) => c.rule_code))] }, i.at, actor) : emit(events, casefile.application_id, "du.resubmission.required", payload, i.at, actor);
  return { checks, result, rule_codes, reason, submission_blocked: restructure, restructure_hand_off: restructure ? "23.2" : null, ami_retest, arithmetic, event, casefile_status: result === "within_tolerance" ? casefile.status : "resubmission_required" };
}

// ============================================================ R5 — the final closed-loan-match submission and its gate
/** FNMA_B3_2_10_DU_FINAL_MATCH_GATE: open iff a final submission's closed-loan snapshot hash equals the current closing-data hash and the recommendation is approve_eligible. */
export function finalMatchGate(f: Record<string, unknown>): GateResult {
  const current = typeof f.current_closing_hash === "string" ? f.current_closing_hash : null;
  if (!current) return { open: false, reason: "FNMA_B3_2_10_DU_FINAL_MATCH_GATE: current closing-data hash (25.2 CD-final / 29.3 ULDD data) is required" };
  if (f.is_final !== true) return { open: false, reason: "FNMA_B3_2_10_DU_FINAL_MATCH_GATE: no du_submissions row with is_final=true — resubmit with reason final_closed_loan_match" };
  if (f.closed_loan_snapshot_hash !== current) return { open: false, reason: `FNMA_B3_2_10_DU_FINAL_MATCH_GATE: final findings hash ${String(f.closed_loan_snapshot_hash ?? "").slice(0, 12)}… ≠ closing-data hash ${current.slice(0, 12)}… — the data submitted to DU must reflect the loan as it was closed (B3-2-10)` };
  if (f.recommendation !== "approve_eligible") return { open: false, reason: `FNMA_B3_2_10_DU_FINAL_MATCH_GATE: final recommendation is ${String(f.recommendation ?? "none")}, not approve_eligible` };
  return { open: true };
}
export const finalMatchFacts = (s: DuSubmission | null, closing: UladSnapshot | ClosedLoanData): Record<string, unknown> => ({ is_final: s?.is_final ?? false, closed_loan_snapshot_hash: s?.findings_hash ?? null, recommendation: s?.recommendation ?? null, current_closing_hash: closedLoanSnapshotHash(closing) });
export interface FinalMatchAssertion { readonly gate: GateResult; readonly command: "generateClosingDocs" | "issueCD" | "submitDelivery"; readonly resubmit: { reason: "final_closed_loan_match"; snapshot: UladSnapshot; differences: ClosedLoanFieldsTest["differences"] } | null; readonly event: DomainEvent | null; }
/** Before closing documents / delivery: block when the last findings do not match the closing data; queue the final_closed_loan_match resubmission. */
export function assertFinalSubmissionMatches(events: EventStore, casefile: DuCasefile, last: DuSubmission | null, closing: UladSnapshot, command: FinalMatchAssertion["command"], at: string, actor: Actor = AGENT): FinalMatchAssertion {
  const gate = finalMatchGate(finalMatchFacts(last, closing));
  if (gate.open) return { gate, command, resubmit: null, event: null };
  const differences = last ? closedLoanFieldsTest(last.snapshot, closing).differences : [];
  const event = emit(events, casefile.application_id, "du.resubmission.required", { casefile_id: casefile.casefile_id, baseline_submission_number: last?.submission_number ?? null, trigger_event: command === "submitDelivery" ? "delivery.uldd.built" : "closing.document_set.opened", result: "resubmission_required", rule_codes: differences.length ? ["B3_2_10_CLOSED_LOAN_FIELD"] : [], reason: "final_closed_loan_match", blocks: command, gate: "FNMA_B3_2_10_DU_FINAL_MATCH_GATE", gate_reason: gate.reason ?? null, differences, arithmetic: {} }, at, actor);
  return { gate, command, resubmit: { reason: "final_closed_loan_match", snapshot: closing, differences }, event };
}
/** After the final-match findings arrive: mark `is_final` when the hash matches; an adverse recommendation reopens 23.3's decision via `underwriting_reviewer`. */
export function recordFinalSubmission(events: EventStore, casefile: DuCasefile, s: DuSubmission, closing: UladSnapshot, at: string, actor: Actor = AGENT): { submission: DuSubmission; casefile: DuCasefile; gate: GateResult; event: DomainEvent; escalate: "underwriting_reviewer" | null } {
  if (s.status !== "findings_received" || !s.findings_hash) throw new DuRefused("FINDINGS_NOT_ON_FILE", "edge case 'DI channel outage at the final-match step': the gate stays closed until findings are on file", `submission ${s.submission_number} has no findings`);
  const current = closedLoanSnapshotHash(closing);
  const matches = s.findings_hash === current;
  const submission: DuSubmission = { ...s, is_final: matches, closed_loan_snapshot_hash: current };
  const gate = finalMatchGate(finalMatchFacts(submission, closing));
  const adverse = s.recommendation !== "approve_eligible";
  const event = emit(events, casefile.application_id, "du.final_submission.recorded", { casefile_id: casefile.casefile_id, submission_number: s.submission_number, is_final: matches, recommendation: s.recommendation, closed_loan_snapshot_hash: current, findings_hash: s.findings_hash, gate_open: gate.open, adverse_change: adverse, decision_reopen: adverse ? "23.3 decision.reopened" : null, findings_pdf_document_id: s.findings_pdf_document_id, permanent_loan_file: true, citation: "B3-2-04: the final DU Underwriting Findings report is maintained in the permanent loan file" }, at, actor);
  return { submission, casefile: { ...casefile, status: gate.open ? "final" : casefile.status, final_submission_id: gate.open ? s.submission_id : casefile.final_submission_id }, gate, event, escalate: adverse ? "underwriting_reviewer" : null };
}

// ============================================================ R1 — archival watch (nightly; B3-2-01 270/540)
export interface ArchivalAction { readonly action: "none" | "warning" | "archived"; readonly casefile: DuCasefile; readonly event: DomainEvent | null; readonly informational: boolean; readonly next: "open_new_casefile" | null; readonly day: number; }
/** Day 240: warning; day 270 (or 540): archived — informational when the loan was already purchased, else a new casefile under current policies (sev 2 to the agent, no human). */
export function archivalWatch(events: EventStore, casefile: DuCasefile, today: PlainDate, facts: { loan_purchased: boolean; delivered?: boolean }, actor: Actor = AGENT): ArchivalAction {
  const at = `${today}T05:00:00.000Z`;
  const day = daysBetween(casefile.last_updated_on, today);
  if (casefile.status === "archived" || casefile.status === "superseded") return { action: "none", casefile, event: null, informational: false, next: null, day };
  if (today >= casefile.archive_due_at) {
    const informational = facts.loan_purchased || facts.delivered === true || casefile.status === "delivered";
    const event = emit(events, casefile.application_id, "du.casefile.archived", { casefile_id: casefile.casefile_id, archive_due_at: casefile.archive_due_at, archived_on: today, clock: casefile.archive_270_due_at <= casefile.archive_540_due_at ? "270_last_update" : "540_creation", informational, next: informational ? null : "open_new_casefile", severity: informational ? null : "sev2", owner: informational ? null : "underwriter" }, at, actor);
    return { action: "archived", casefile: { ...casefile, status: "archived" }, event, informational, next: informational ? null : "open_new_casefile", day };
  }
  if (today >= casefile.archive_warning_at && !casefile.archive_warning_sent) {
    const event = emit(events, casefile.application_id, "du.casefile.archive_warning", { casefile_id: casefile.casefile_id, archive_due_at: casefile.archive_due_at, warning_on: today, day, non_blocking: true, loan_purchased: facts.loan_purchased }, at, actor);
    return { action: "warning", casefile: { ...casefile, status: "archive_warning", archive_warning_sent: true }, event, informational: facts.loan_purchased, next: null, day };
  }
  return { action: "none", casefile, event: null, informational: false, next: null, day };
}

// ============================================================ platform clocks — impact memo support (120 days) and Return File Type retirement
export const IMPACT_MEMO_SUPPORT_DAYS = 120;
export interface ImpactMemoInput { readonly memo_id: string; readonly memo_date: PlainDate; readonly spec_available_on?: PlainDate | null; readonly spec_version: string; readonly return_file_types_retired?: { types: readonly ReturnFileType[]; retire_on: PlainDate } | null; readonly at: string; }
/** `du.impact_memo.published` — anchors FNMA_DU_IMPACT_MEMO_SUPPORT_120 on the spec-availability date (the memo distributes the spec, so the dates coincide unless the spec ships later). */
export function recordImpactMemo(events: EventStore, i: ImpactMemoInput, actor: Actor = AGENT): { event: DomainEvent; support_due: PlainDate } {
  const spec_available_on = i.spec_available_on ?? i.memo_date;
  const support_due = addDays(spec_available_on, IMPACT_MEMO_SUPPORT_DAYS);
  const event = events.append({ type: "du.impact_memo.published", aggregate: { kind: "platform", id: "fnma-du" }, actor, occurredAt: i.at, payload: { source: "origination", memo_id: i.memo_id, memo_date: i.memo_date, spec_available_on, spec_version: i.spec_version, support_due, return_file_retirement_date: i.return_file_types_retired?.retire_on ?? null, return_file_types_retired: i.return_file_types_retired?.types ?? [], breach: "compliance-sentinel sev 1 (DU submissions could be rejected)" } });
  return { event, support_due };
}
export function tagAdapterRelease(events: EventStore, i: { spec_version: string; tag: string; at: string }, actor: Actor = AGENT): DomainEvent {
  return events.append({ type: "du.adapter.release_tagged", aggregate: { kind: "platform", id: "fnma-du" }, actor, occurredAt: i.at, payload: { source: "origination", spec_version: i.spec_version, tag: i.tag, integration: "integrations/fnma-du" } });
}
export function confirmReturnFileFormat(events: EventStore, i: { formats: readonly ReturnFileType[]; environment: "production" | "integration"; at: string }, actor: Actor = AGENT): DomainEvent {
  const bad = i.formats.filter((f) => !(DURABLE_RETURN_FILE_TYPES as readonly string[]).includes(f));
  if (bad.length) throw new DuRefused("FNMA_DU_RETURN_FILE_16_17_RETIRE", "DU 12.1 September Update: enhanced HTML/PDF retired Nov 30, 2026; RES/TEXT/XML retire Oct 27, 2028", `formats ${bad.join(", ")} are not durable machine formats (json_v2 / pdf_standard)`);
  return events.append({ type: "du.return_file_format.confirmed", aggregate: { kind: "platform", id: "fnma-du" }, actor, occurredAt: i.at, payload: { source: "origination", formats: i.formats, environment: i.environment, confirmed_on: civilDateEt(i.at) } });
}

// ============================================================ 22.3's close-by gate (reference) and P&I for the worked examples
/** 22.3 owns FNMA_B3_2_02_DU_CLOSE_BY_GATE; 23.1 only reads the close-by date out of the employment validation message. */
export function closeByFromFindings(f: Pick<DuFindings, "validation_results">, scheduled_note_date: PlainDate): { close_by_date: PlainDate | null; gate: { open: boolean; reason: string | null } } {
  const emp = f.validation_results.find((v) => v.component === "employment" && v.outcome === "validated" && v.close_by_date);
  return emp?.close_by_date ? { close_by_date: emp.close_by_date, gate: closeByGate(emp.close_by_date, scheduled_note_date) } : { close_by_date: null, gate: { open: true, reason: null } };
}
/** P&I (half-up) for the worked examples: $560,000 × 6.125 % / 360 → $3,402.62 ($3,402.619 unrounded; the fixture's $3,402.63 is 26.1's round-up convention). */
export const piCents = (loan_amount_cents: Cents, note_rate_pct: string, term_months: number): Cents => levelPayment(loan_amount_cents, ratePercent(note_rate_pct), term_months);
export function piUnrounded(loan_amount_cents: Cents, note_rate_pct: string, term_months: number): Decimal {
  const r = ratePercent(note_rate_pct).div(Decimal.fromInt(12)); const growth = Decimal.ONE.add(r).pow(term_months);
  return Decimal.ratio(loan_amount_cents, 100n).mul(r).mul(growth).div(growth.sub(Decimal.ONE));
}

// ============================================================ decision record (agent_decisions; LL-2026-04)
export interface DuDecisionRecord { readonly application_id: string; readonly casefile_id: string; readonly submission_number: number | null; readonly reason: string; readonly diff: readonly unknown[]; readonly rule_codes: readonly string[]; readonly arithmetic: Record<string, unknown>; readonly policy_generation: PolicyGeneration; readonly du_version: string; readonly du_release_applied: string | null; readonly request_hash: string | null; readonly findings_hash: string | null; readonly recommendation_before: Recommendation | null; readonly recommendation_after: Recommendation | null; readonly rationale: string; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly confidence: number; }
export function decisionRecord(casefile: DuCasefile, d: { submission?: DuSubmission | null; previous?: DuSubmission | null; evaluation?: ResubmissionEvaluation | null; reason: string; rationale: string; model_version: string; prompt_version: string; confidence: number }): DuDecisionRecord {
  return { application_id: casefile.application_id, casefile_id: casefile.casefile_id, submission_number: d.submission?.submission_number ?? null, reason: d.reason, diff: d.evaluation?.checks.map((c) => ({ field: c.field, old: c.old_value, new: c.new_value })) ?? [], rule_codes: d.evaluation?.rule_codes ?? [], arithmetic: d.evaluation?.arithmetic ?? {},
    policy_generation: casefile.policy_generation, du_version: DU_VERSION, du_release_applied: d.submission?.du_release_applied ?? null, request_hash: d.submission?.request_hash ?? null, findings_hash: d.submission?.findings_hash ?? null, recommendation_before: d.previous?.recommendation ?? null, recommendation_after: d.submission?.recommendation ?? null,
    rationale: d.rationale, rule_set_version: `${RULE_SET_VERSION}; ${DU_RULE_SET_VERSION}@${casefile.policy_generation}`, model_version: d.model_version, prompt_version: d.prompt_version, confidence: d.confidence };
}
