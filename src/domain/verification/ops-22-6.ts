/**
 * §22.6 operating rules — identity (IAL2), SSN/ITIN resolution and SSA validation, legal presence, OFAC party
 * screening against a pinned SLS list version, FCRA §605A(h) fraud-alert contact, §1022.82 address discrepancies,
 * the 16 CFR 681 Red Flags log, the fraud-tool clear gate, the occupancy risk score, undisclosed-REO discovery,
 * non-arm's-length assessment (B2-1.3-01), the fraud investigation clock, and the SAR / self-report / OFAC packages
 * the `fraud-risk` agent prepares for the humans who file (28.4). One small function per rule; the vendors are ports
 * (identity vendor, SSA CBSV, OFAC screener, fraud tool, MERS) with fakes at the bottom for tests and the bus.
 *
 * Events (every one carries `applicationId` and payload.application_id so origination timers arm — engine.ts
 * isOriginationContext; the timer each one arms/satisfies is in brackets):
 *   identity.verified{borrower_id, level, valid_until, reverify_at_closing, all_borrowers_verified}   [satisfies SM_IDENTITY_IAL2_GATE when all_borrowers_verified]
 *   identity.inconclusive{borrower_id, method, retry_due}                                              [arms SM_IDENTITY_RETRY_2BD]
 *   identity.second_method.resulted{borrower_id, method, outcome}                                    [satisfies SM_IDENTITY_RETRY_2BD]
 *   identity.failed{borrower_id, reason}                                                              → investigation candidate
 *   ssn.discrepancy.detected{borrower_id, indicator}                                                  [arms FNMA_B2_2_01_SSN_VALIDATION_GATE]
 *   ssn.validated{borrower_id, method, resolution, sfc_162_required, fee_cents}                        [satisfies it]  ·  ssn.validation.failed{borrower_id, eligible=false}
 *   legal_presence.assessed{borrower_id, status_declared, assessment, expires_before_note_date}       [arms FNMA_B2_2_02_LEGAL_PRESENCE_GATE]
 *   legal_presence.established{borrower_id}                                                          [satisfies it]
 *   party.screened{party_id, role, result, list_version, all_parties_clear}                           [satisfies OFAC_SDN_SCREEN_GATE when all_parties_clear]
 *   ofac.potential_match{party_id, candidates}  ·  ofac.false_positive.resolved{identifiers_compared}
 *   ofac.match.confirmed{party_id, disposition, rejected|blocked, retention_class}                     + 28.4's ofac.transaction.rejected / ofac.property.blocked and fraud.hold.placed
 *   fraud_alert.contact.completed{borrower_id, alert_kind, method, outcome}                            [satisfies FCRA_605A_H_ALERT_CONTACT_GATE]  ·  fraud_alert.contact.attempted{attempt_no, unreachable_deadline}
 *   address_discrepancy.detected{borrower_id, fields}                                                 [arms REGV_1022_82_ADDRESS_DISCREPANCY_GATE]  ·  address_discrepancy.resolved{confirmed_address, furnish_at_boarding}  [satisfies it]
 *   red_flag.detected{event_id, category, red_flag_code, detected_at, response_due_on}                 [arms RED_FLAGS_681_RESPONSE_1BD]  ·  red_flag.responded{response, response_hours, within_sla}  [satisfies it]
 *   fraud_tool.report.received{report_id, high_open}  ·  fraud_tool.alert.dispositioned{alert_id, disposition}  ·  fraud_tool.cleared{report_id}   [satisfies SM_FRAUD_TOOL_CLEAR_GATE]
 *   occupancy.assessed{conclusion, risk_score}  ·  reo.discrepancy.detected{undisclosed_count}  ·  reo.discrepancy.resolved{status, pitia_cents, financed_property_count, reserves_add_on_cents}
 *   occupancy_reo.cleared{occupancy_conclusion, reo_status}                                            [satisfies SM_OCCUPANCY_REO_GATE]
 *   non_arms_length.assessed{relationship, relationship_kind, eligible, value_acceptance_blocked}      [arms FNMA_B2_1_3_01_NON_ARMS_LENGTH_GATE when relationship ≠ none]  ·  non_arms_length.eligible{}  [satisfies it]
 *   investigation.opened{investigation_id, case_id, opened_at, due_on}                                 [arms SM_FRAUD_INVESTIGATION_10BD]  ·  investigation.evidence.gathered
 *   investigation.concluded{conclusion, sar_candidate, sar_detection_date}                             [satisfies it; arms SM_SAR_PACKAGE_5BD when sar_candidate=true]
 *   fraud.suspicious.determined{initial_detection_at, subject_identified}                             [28.4's BSA_1029_320_SAR_30 trigger — the hand-off]
 *   fnma.fraud.reasonable_basis{reasonable_basis_at}                                                  [28.4's FNMA_A3_4_03_FRAUD_SELF_REPORT_30 trigger]
 *   sar.candidate.prepared{candidate_id, filing_due_on, outer_limit_on, sent_to=bsa_officer}           [satisfies SM_SAR_PACKAGE_5BD]
 *   fnma.self_report.candidate.prepared{elements}  ·  ofac.report.package.prepared{kind, due_on}       (→ 28.4)
 *   fraud.hold.placed{reason, blocks}  ·  fraud.hold.released{released_by}  ·  screening.finalized{status}
 *   28.4's return path (consumed, never emitted here): `sar.filed`, `fnma.fraud.report.submitted`, `ofac.report.submitted{kind}` close the loop.
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack, creditor, federal, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { GateResult } from "../../app/evaluator-kit.ts";
import { otherFinancedPctBps } from "./ops-22-4.ts";
import { FNMA_SELF_REPORT_ELEMENTS } from "../qc-audit/ops-18-5.ts";

export const RULE_SET_VERSION = "22.6/2026-09-10";
const AGENT: Actor = { kind: "agent", id: "fraud-risk" };
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const civil = (iso: string, cal: Calendar = creditor): PlainDate => wallClock(Date.parse(iso), cal.timeZone).date;
const emit = (events: EventStore, application_id: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor): DomainEvent =>
  events.append({ type, applicationId: application_id, aggregate: { kind: "application", id: application_id }, actor, occurredAt: at, payload: { application_id, ...payload } });

export class ScreeningRefused extends Error { readonly code: string; readonly citation: string; constructor(code: string, citation: string, message: string) { super(message); this.name = "ScreeningRefused"; this.code = code; this.citation = citation; } }
export class FraudHoldBlocked extends Error { readonly code = "FRAUD_HOLD"; readonly command: string; constructor(command: string, reason: string) { super(`${command} is blocked by fraud_hold (${reason})`); this.name = "FraudHoldBlocked"; this.command = command; } }

// ============================================================ R1 — identity level (IAL2; SM_IDENTITY_IAL2_GATE / SM_IDENTITY_RETRY_2BD)
export type IdentityLevel = "ial1_data_match" | "ial2_remote_doc_biometric" | "ial2_supervised_remote" | "in_person_notary";
export type IdentityMethod = "remote_doc_biometric" | "supervised_remote" | "in_person_notary";
export type CheckResult = "pass" | "fail" | "inconclusive";
export type IdDocumentType = "drivers_license" | "state_id" | "passport" | "passport_card" | "permanent_resident_card" | "ead" | "military_id" | "other";
export interface IdentitySessionResult {
  readonly session_id: string; readonly vendor: string; readonly document_authentication_result: CheckResult; readonly liveness_result: CheckResult;
  readonly face_match_score: number | null; readonly face_match_threshold: number; readonly id_document_type: IdDocumentType; readonly id_document_issuer: string; readonly id_document_expires_on: PlainDate | null;
  /** name / DOB / address vs the application and the credit header (R1 data match). */
  readonly data_match: Readonly<Record<string, boolean>>;
}
export interface IdentityVendorPort { verify(req: { borrower_id: string; method: IdentityMethod; consent_id: string | null }): Promise<IdentitySessionResult>; }
export const IDENTITY_LEVEL_BY_METHOD: Readonly<Record<IdentityMethod, IdentityLevel>> = { remote_doc_biometric: "ial2_remote_doc_biometric", supervised_remote: "ial2_supervised_remote", in_person_notary: "in_person_notary" };
export const IAL2_LEVELS: readonly IdentityLevel[] = ["ial2_remote_doc_biometric", "ial2_supervised_remote", "in_person_notary"];
export const IDENTITY_RETRY_BUSINESS_DAYS = 2;
export interface IdentityVerification {
  readonly verification_id: string; readonly application_id: string; readonly borrower_id: string; readonly kind: "identity"; readonly method: IdentityMethod; readonly identity_level: IdentityLevel | null;
  readonly outcome: "verified" | "inconclusive" | "failed"; readonly reason: string | null; readonly session_id: string; readonly vendor: string; readonly id_document_type: IdDocumentType; readonly id_document_expires_on: PlainDate | null;
  readonly document_authentication_result: CheckResult; readonly liveness_result: CheckResult; readonly face_match_score: number | null; readonly data_match: Readonly<Record<string, boolean>>;
  readonly screened_on: PlainDate; readonly valid_until: PlainDate | null; readonly reverify_at_closing: boolean; readonly retry_due: PlainDate | null; readonly retention_class: "fnma_loan_file_life_plus_4y";
}
/** R1: document authenticated, liveness passed, face match ≥ threshold, data match on every field; an expired ID is never accepted; an ID expiring before the note date is re-verified at closing (26.2). */
export function classifyIdentityResult(r: IdentitySessionResult, screened_on: PlainDate, scheduled_note_date: PlainDate | null): { outcome: IdentityVerification["outcome"]; reason: string | null; reverify_at_closing: boolean } {
  if (r.id_document_expires_on !== null && r.id_document_expires_on < screened_on) return { outcome: "failed", reason: `ID expired ${r.id_document_expires_on} (expired IDs are not accepted)`, reverify_at_closing: false };
  const checks: CheckResult[] = [r.document_authentication_result, r.liveness_result];
  const mismatched = Object.entries(r.data_match).filter(([, ok]) => !ok).map(([k]) => k);
  if (checks.includes("fail") || mismatched.length) return { outcome: "failed", reason: checks.includes("fail") ? "document authentication or liveness failed" : `data mismatch on ${mismatched.join(", ")}`, reverify_at_closing: false };
  const faceOk = r.face_match_score !== null && r.face_match_score >= r.face_match_threshold;
  if (checks.includes("inconclusive") || r.face_match_score === null) return { outcome: "inconclusive", reason: "document/liveness/face-match session inconclusive", reverify_at_closing: false };
  if (!faceOk) return { outcome: "failed", reason: `face match ${r.face_match_score} below the vendor threshold ${r.face_match_threshold}`, reverify_at_closing: false };
  const reverify = r.id_document_expires_on !== null && scheduled_note_date !== null && r.id_document_expires_on < scheduled_note_date;
  return { outcome: "verified", reason: null, reverify_at_closing: reverify };
}
export function identityRetryDue(inconclusive_on: PlainDate, cal: Calendar = creditor): PlainDate { return addBusinessDays(inconclusive_on, IDENTITY_RETRY_BUSINESS_DAYS, cal); }
export interface RecordIdentityInput { readonly application_id: string; readonly borrower_id: string; readonly method: IdentityMethod; readonly result: IdentitySessionResult; readonly at: string; readonly scheduled_note_date: PlainDate | null; readonly borrower_ids: readonly string[]; readonly verified_borrower_ids: readonly string[]; }
/** A vendor session result recorded: `identity.verified` / `identity.inconclusive` (arms the 2-business-day retry) / `identity.failed`; a second-method session also emits `identity.second_method.resulted`. */
export function recordIdentityResult(events: EventStore, i: RecordIdentityInput, actor: Actor = AGENT): { verification: IdentityVerification; events: DomainEvent[]; all_borrowers_verified: boolean; gate: GateResult } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_id, "borrower_id"); nonEmpty(i.result.session_id, "session_id");
  const screened_on = civil(i.at); const c = classifyIdentityResult(i.result, screened_on, i.scheduled_note_date);
  const level = c.outcome === "verified" ? IDENTITY_LEVEL_BY_METHOD[i.method] : null;
  const retry_due = c.outcome === "inconclusive" ? identityRetryDue(screened_on) : null;
  const verified = new Set(i.verified_borrower_ids); if (c.outcome === "verified") verified.add(i.borrower_id);
  const all = i.borrower_ids.length > 0 && i.borrower_ids.every((b) => verified.has(b));
  const verification: IdentityVerification = { verification_id: randomUUID(), application_id: i.application_id, borrower_id: i.borrower_id, kind: "identity", method: i.method, identity_level: level, outcome: c.outcome, reason: c.reason, session_id: i.result.session_id, vendor: i.result.vendor,
    id_document_type: i.result.id_document_type, id_document_expires_on: i.result.id_document_expires_on, document_authentication_result: i.result.document_authentication_result, liveness_result: i.result.liveness_result, face_match_score: i.result.face_match_score, data_match: i.result.data_match,
    screened_on, valid_until: c.outcome === "verified" ? (i.scheduled_note_date ?? i.result.id_document_expires_on) : null, reverify_at_closing: c.reverify_at_closing, retry_due, retention_class: "fnma_loan_file_life_plus_4y" };
  const out: DomainEvent[] = [];
  const base = { borrower_id: i.borrower_id, method: i.method, session_id: i.result.session_id, vendor: i.result.vendor };
  if (c.outcome === "verified") out.push(emit(events, i.application_id, "identity.verified", { ...base, level, valid_until: verification.valid_until, reverify_at_closing: c.reverify_at_closing, all_borrowers_verified: all }, i.at, actor));
  else if (c.outcome === "inconclusive") out.push(emit(events, i.application_id, "identity.inconclusive", { ...base, retry_due, next: i.method === "remote_doc_biometric" ? "supervised_remote" : "in_person_notary" }, i.at, actor));
  else out.push(emit(events, i.application_id, "identity.failed", { ...base, reason: c.reason, next: "investigation" }, i.at, actor));
  if (i.method !== "remote_doc_biometric") out.push(emit(events, i.application_id, "identity.second_method.resulted", { ...base, outcome: c.outcome, level }, i.at, actor));
  return { verification, events: out, all_borrowers_verified: all, gate: identityIal2Gate({ borrower_ids: i.borrower_ids, levels: Object.fromEntries([...verified].map((b) => [b, b === i.borrower_id ? level : "ial2_remote_doc_biometric"])) }) };
}
/** SM_IDENTITY_IAL2_GATE: every borrower at an IAL2 level (or better) — `submitDu` waits for at least a supervised remote pass; `consummate` also needs `valid_until ≥ note date`. */
export function identityIal2Gate(f: Record<string, unknown>): GateResult {
  const ids = Array.isArray(f.borrower_ids) ? (f.borrower_ids as string[]) : [];
  const levels = (f.levels ?? {}) as Record<string, string | null | undefined>;
  if (!ids.length) return { open: false, reason: "no borrowers on the application" };
  const missing = ids.filter((b) => !IAL2_LEVELS.includes((levels[b] ?? "") as IdentityLevel));
  if (missing.length) return { open: false, reason: `identity not at IAL2 for ${missing.join(", ")} (blocks submitDu)` };
  if (typeof f.scheduled_note_date === "string" && f.valid_until && typeof f.valid_until === "object") {
    const stale = ids.filter((b) => { const v = (f.valid_until as Record<string, string | null>)[b]; return !v || v < (f.scheduled_note_date as string); });
    if (stale.length) return { open: false, reason: `identity must be re-confirmed before consummate for ${stale.join(", ")} (valid_until < note date)` };
  }
  return { open: true };
}

// ============================================================ R2 — SSN/ITIN (B2-2-01; FNMA_B2_2_01_SSN_VALIDATION_GATE)
export type SsnIndicator = "du_ssn_message" | "loan_delivery_edit" | "credit_header_variance" | "issued_before_dob" | "not_issued" | "deceased";
export type SsnValidationMethod = "not_required" | "cbsv_web_service" | "cbsv_online" | "ecbsv" | "ssa_89_paper";
export type SsnStatus = "unchecked" | "consistent" | "discrepancy_open" | "resolved_internally" | "ssa_validation_ordered" | "validated" | "not_validated";
/** SSA CBSV: "$5,000" enrollment, "$2.25 per verification request" (00b-orig N3). */
export const CBSV_FEE_CENTS = 225n;
export const CBSV_ENROLLMENT_CENTS = 500_000n;
export const CBSV_ONLINE_MAX_PER_SUBMISSION = 10;
export interface CbsvResponse { readonly request_id: string; readonly match: boolean; readonly death_indicator: boolean; }
export interface CbsvPort { verify(req: { borrower_id: string; name: string; date_of_birth: PlainDate; ssn_hash: string; ssa_89_document_id: string }): Promise<CbsvResponse>; }
export interface SsnRecord { readonly application_id: string; readonly borrower_id: string; readonly status: SsnStatus; readonly indicators: readonly SsnIndicator[]; readonly ssn_validation_method: SsnValidationMethod | null; readonly ssn_match: boolean | null; readonly ssn_death_indicator: boolean | null; readonly ssn_discrepancy_open: boolean; readonly sfc_162_required: boolean; readonly eligible: boolean; readonly evidence_document_ids: readonly string[]; readonly fee_cents: bigint; }
/** R2: a DU/Loan Delivery SSN message, a credit-header variance, an issued-before-DOB / not-issued indicator or a deceased indicator opens the discrepancy (arms the gate). */
export function detectSsnDiscrepancy(events: EventStore, i: { application_id: string; borrower_id: string; indicator: SsnIndicator; detail?: Record<string, unknown>; at: string }, actor: Actor = AGENT): { record: SsnRecord; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_id, "borrower_id");
  const record: SsnRecord = { application_id: i.application_id, borrower_id: i.borrower_id, status: "discrepancy_open", indicators: [i.indicator], ssn_validation_method: null, ssn_match: null, ssn_death_indicator: null, ssn_discrepancy_open: true, sfc_162_required: false, eligible: true, evidence_document_ids: [], fee_cents: 0n };
  const event = emit(events, i.application_id, "ssn.discrepancy.detected", { borrower_id: i.borrower_id, indicator: i.indicator, detail: i.detail ?? {}, resolution_ladder: ["documentary", "ssa_validation", "ineligible"] }, i.at, actor);
  return { record, event };
}
/** Ladder step (1): SSN card / W-2 / 1099 / transcript name match resolves the inconsistency internally (`ssn.validated{method=not_required}`); otherwise the SSA path is next. */
export function resolveSsnDocumentarily(events: EventStore, rec: SsnRecord, i: { documents: readonly { document_id: string; doc_class: string; name_matches: boolean }[]; at: string }, actor: Actor = AGENT): { record: SsnRecord; event: DomainEvent | null; next: "none" | "ssa_validation" } {
  if (rec.status !== "discrepancy_open") throw new RangeError(`SSN status is ${rec.status}, not discrepancy_open`);
  const ok = i.documents.length > 0 && i.documents.every((d) => d.name_matches);
  if (!ok) return { record: rec, event: null, next: "ssa_validation" };
  const record: SsnRecord = { ...rec, status: "resolved_internally", ssn_validation_method: "not_required", ssn_discrepancy_open: false, evidence_document_ids: i.documents.map((d) => d.document_id) };
  const event = emit(events, rec.application_id, "ssn.validated", { borrower_id: rec.borrower_id, method: "not_required", resolution: "resolved_internally", sfc_162_required: false, evidence_document_ids: record.evidence_document_ids, fee_cents: "0" }, i.at, actor);
  return { record, event, next: "none" };
}
/** Ladder step (2): SSA validation — the signed SSA-89 must be in SM's possession first; a match with no death indicator validates (SFC 162 when the DU/LD/credit discrepancy persists); no match → ineligible → 21.6 with `underwriting_reviewer`. */
export function recordCbsvResult(events: EventStore, rec: SsnRecord, i: { method: Exclude<SsnValidationMethod, "not_required">; ssa_89_document_id: string; response: CbsvResponse; discrepancy_persists: boolean; at: string }, actor: Actor = AGENT): { record: SsnRecord; event: DomainEvent; eligible: boolean; escalation: { kind: "underwriting_reviewer"; reason: string } | null } {
  nonEmpty(i.ssa_89_document_id, "ssa_89_document_id (the signed Form SSA-89 must be in SM's possession before a CBSV request)");
  if (rec.status !== "discrepancy_open" && rec.status !== "ssa_validation_ordered") throw new RangeError(`SSN status is ${rec.status}: SSA validation is the step after documents cannot resolve the inconsistency`);
  const validated = i.response.match && !i.response.death_indicator;
  const evidence = [...rec.evidence_document_ids, i.ssa_89_document_id];
  if (validated) {
    const record: SsnRecord = { ...rec, status: "validated", ssn_validation_method: i.method, ssn_match: true, ssn_death_indicator: false, ssn_discrepancy_open: i.discrepancy_persists, sfc_162_required: i.discrepancy_persists, eligible: true, evidence_document_ids: evidence, fee_cents: rec.fee_cents + CBSV_FEE_CENTS };
    const event = emit(events, rec.application_id, "ssn.validated", { borrower_id: rec.borrower_id, method: i.method, resolution: "ssa_validated", request_id: i.response.request_id, sfc_162_required: i.discrepancy_persists, delivery_sfc: i.discrepancy_persists ? 162 : null, evidence_document_ids: evidence, fee_cents: String(CBSV_FEE_CENTS), retention_class: "ssa_89_5y" }, i.at, actor);
    return { record, event, eligible: true, escalation: null };
  }
  const record: SsnRecord = { ...rec, status: "not_validated", ssn_validation_method: i.method, ssn_match: i.response.match, ssn_death_indicator: i.response.death_indicator, ssn_discrepancy_open: true, sfc_162_required: false, eligible: false, evidence_document_ids: evidence, fee_cents: rec.fee_cents + CBSV_FEE_CENTS };
  const reason = i.response.death_indicator ? "SSA death indicator on the SSN" : "the SSA could not validate the SSN (B2-2-01: not eligible for sale to Fannie Mae)";
  const event = emit(events, rec.application_id, "ssn.validation.failed", { borrower_id: rec.borrower_id, method: i.method, request_id: i.response.request_id, death_indicator: i.response.death_indicator, eligible: false, route: "21.6 decline with underwriting_reviewer approval", reason, fee_cents: String(CBSV_FEE_CENTS) }, i.at, actor);
  return { record, event, eligible: false, escalation: { kind: "underwriting_reviewer", reason } };
}
/** FNMA_B2_2_01_SSN_VALIDATION_GATE: open iff no discrepancy, resolved internally, or validated by the SSA. */
export function ssnValidationGate(f: Record<string, unknown>): GateResult {
  const s = String(f.ssn_status ?? "unchecked");
  if (s === "consistent" || s === "resolved_internally" || s === "validated") return { open: true };
  if (s === "not_validated") return { open: false, reason: "SSN not validated by the SSA — ineligible (B2-2-01); 21.6" };
  return { open: false, reason: `SSN ${s}: resolve with documents or SSA validation before issueCD / submitDelivery` };
}

// ============================================================ R3 — legal presence (B2-2-02; Reg B §1002.6(b)(7); FNMA_B2_2_02_LEGAL_PRESENCE_GATE)
export type StatusDeclared = "us_citizen" | "lawful_permanent_resident" | "non_permanent_resident" | "other";
export type EvidenceKind = "passport_us" | "birth_certificate_not_required" | "permanent_resident_card" | "ead" | "visa_with_i94" | "i797_approval" | "other";
export type LegalPresenceAssessment = "legally_present" | "not_established" | "ineligible";
export const REGB_6B7_RATIONALE = "Immigration status considered only to ascertain the creditor's rights and remedies regarding repayment (Reg B §1002.6(b)(7); comment 6(b)(7)-1) — never as a proxy for national origin.";
export interface LegalPresenceInput { readonly application_id: string; readonly borrower_id: string; readonly status_declared: StatusDeclared; readonly evidence_kind: EvidenceKind; readonly evidence_document_id: string | null; readonly evidence_expires_on: PlainDate | null; readonly scheduled_note_date: PlainDate; readonly renewal_receipt_present: boolean; readonly policy: { readonly pending_renewal_accepted: boolean }; readonly at: string; }
export interface LegalPresenceRecord extends Omit<LegalPresenceInput, "policy" | "at"> { readonly record_id: string; readonly expires_before_note_date: boolean; readonly assessment: LegalPresenceAssessment; readonly regb_6b7_rationale: string; readonly assessed_at: string; }
export function assessLegalPresence(events: EventStore, i: LegalPresenceInput, actor: Actor = AGENT): { record: LegalPresenceRecord; events: DomainEvent[]; condition: { kind: "ptd_legal_presence"; text: string } | null; gate: GateResult } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_id, "borrower_id");
  const needsEvidence = i.status_declared !== "us_citizen";
  const expires_before = i.evidence_expires_on !== null && i.evidence_expires_on < i.scheduled_note_date;
  let assessment: LegalPresenceAssessment;
  if (!needsEvidence) assessment = "legally_present";
  else if (i.status_declared === "other") assessment = "ineligible";
  else if (!i.evidence_document_id) assessment = "not_established";
  else if (!expires_before) assessment = "legally_present";
  else assessment = i.renewal_receipt_present && i.policy.pending_renewal_accepted ? "legally_present" : "not_established";
  const record: LegalPresenceRecord = { record_id: randomUUID(), application_id: i.application_id, borrower_id: i.borrower_id, status_declared: i.status_declared, evidence_kind: i.evidence_kind, evidence_document_id: i.evidence_document_id, evidence_expires_on: i.evidence_expires_on, scheduled_note_date: i.scheduled_note_date, renewal_receipt_present: i.renewal_receipt_present, expires_before_note_date: expires_before, assessment, regb_6b7_rationale: REGB_6B7_RATIONALE, assessed_at: i.at };
  const out: DomainEvent[] = [emit(events, i.application_id, "legal_presence.assessed", { borrower_id: i.borrower_id, status_declared: i.status_declared, evidence_kind: i.evidence_kind, evidence_expires_on: i.evidence_expires_on, scheduled_note_date: i.scheduled_note_date, expires_before_note_date: expires_before, assessment, regb_6b7_rationale: REGB_6B7_RATIONALE }, i.at, actor)];
  if (assessment === "legally_present") out.push(emit(events, i.application_id, "legal_presence.established", { borrower_id: i.borrower_id, status_declared: i.status_declared, evidence_expires_on: i.evidence_expires_on }, i.at, actor));
  const condition = assessment === "legally_present" ? null : { kind: "ptd_legal_presence" as const, text: expires_before ? `Unexpired evidence of legal presence at the note date ${i.scheduled_note_date} (evidence expired ${i.evidence_expires_on}${i.renewal_receipt_present ? "; a pending renewal receipt is not accepted under partner policy" : ""}) — never proceed on an expired document` : "Evidence of legal presence (permanent resident card, EAD, or visa with I-94/I-797) in the file" };
  return { record, events: out, condition, gate: legalPresenceGate({ assessment }) };
}
/** FNMA_B2_2_02_LEGAL_PRESENCE_GATE: `legal_presence_records.assessment = legally_present`; otherwise blocks `consummate` (21.6 with `underwriting_reviewer` when not established). */
export function legalPresenceGate(f: Record<string, unknown>): GateResult {
  const a = String(f.assessment ?? "");
  return a === "legally_present" ? { open: true } : { open: false, reason: a === "ineligible" ? "borrower not eligible (B2-2-02)" : "legal presence not established — evidence unexpired at the note date or renewal/extension evidence required (blocks consummate)" };
}

// ============================================================ R4 — OFAC party screening (31 CFR 501; OFAC_SDN_SCREEN_GATE)
export type PartyRole = "borrower" | "co_borrower" | "non_borrowing_spouse" | "seller" | "buyer_agent" | "listing_agent" | "builder_developer" | "settlement_agent" | "title_company" | "appraiser" | "pdc_collector" | "gift_donor" | "employer" | "subordinate_lender" | "dpa_provider" | "poa_agent" | "trustee" | "other";
export type ScreeningList = "ofac_sdn" | "ofac_consolidated" | "gsa_sam" | "hud_ldp" | "fhfa_scp";
export type ScreeningResult = "clear" | "potential_match" | "match_resolved_false" | "match_true";
export interface ListVersion { readonly list: ScreeningList; readonly version: string; readonly published_on: PlainDate; }
export interface PartyIdentity { readonly party_id: string; readonly party_role: PartyRole; readonly name: string; readonly date_of_birth?: PlainDate | null; readonly nationality?: string | null; readonly id_numbers?: readonly string[]; readonly entity?: boolean; }
export interface OfacCandidate { readonly list: ScreeningList; readonly sdn_name: string; readonly program: string; readonly date_of_birth: string | null; readonly nationality: string | null; readonly id_numbers: readonly string[]; readonly score: number; }
export interface OfacScreenerPort { screen(party: PartyIdentity, lists: readonly ListVersion[]): Promise<{ candidates: OfacCandidate[] }>; }
export interface PartyScreening { readonly screening_id: string; readonly application_id: string; readonly party_id: string; readonly party_role: PartyRole; readonly lists_checked: readonly ScreeningList[]; readonly list_versions: Readonly<Record<string, string>>; readonly result: ScreeningResult; readonly candidates: readonly OfacCandidate[]; readonly resolution: Record<string, unknown> | null; readonly screened_at: string; readonly screened_on: PlainDate; readonly list_stale: boolean; readonly rescreen_due_at: string | null; readonly retention_class: "ofac_records_10y"; }
export const OFAC_LIST_MAX_AGE_BUSINESS_DAYS_FEDERAL = 1;
export const OFAC_FINAL_RESCREEN_BUSINESS_DAYS_CREDITOR = 1;
export const OFAC_RECORDS_YEARS = 10;
/** The list must have been published ≤ 1 business_days_federal before the screen. */
export function listStale(published_on: PlainDate, screened_on: PlainDate, cal: Calendar = federal): boolean { return addBusinessDays(published_on, OFAC_LIST_MAX_AGE_BUSINESS_DAYS_FEDERAL, cal) < screened_on; }
export interface RecordScreeningInput { readonly application_id: string; readonly party: PartyIdentity; readonly lists: readonly ListVersion[]; readonly candidates: readonly OfacCandidate[]; readonly at: string; readonly other_party_results: Readonly<Record<string, ScreeningResult>>; }
/** A screen against the pinned list versions: `party.screened{result, list_version, all_parties_clear}` and, on candidates, `ofac.potential_match` (resolved by ≥ 2 non-name identifiers — resolveOfacMatch). */
export function recordPartyScreening(events: EventStore, i: RecordScreeningInput, actor: Actor = AGENT): { screening: PartyScreening; events: DomainEvent[]; all_parties_clear: boolean } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.party.party_id, "party_id"); nonEmpty(i.party.name, "party name");
  if (!i.lists.some((l) => l.list === "ofac_sdn")) throw new RangeError("the SDN list version is required for every screen (31 CFR 501; R4)");
  const screened_on = civil(i.at, federal);
  const result: ScreeningResult = i.candidates.length ? "potential_match" : "clear";
  const list_versions = Object.fromEntries(i.lists.map((l) => [l.list, l.version]));
  const stale = i.lists.some((l) => listStale(l.published_on, screened_on));
  const results = { ...i.other_party_results, [i.party.party_id]: result };
  const all = Object.values(results).every((r) => r === "clear" || r === "match_resolved_false");
  const screening: PartyScreening = { screening_id: randomUUID(), application_id: i.application_id, party_id: i.party.party_id, party_role: i.party.party_role, lists_checked: i.lists.map((l) => l.list), list_versions, result, candidates: i.candidates, resolution: null, screened_at: i.at, screened_on, list_stale: stale, rescreen_due_at: null, retention_class: "ofac_records_10y" };
  const out: DomainEvent[] = [emit(events, i.application_id, "party.screened", { screening_id: screening.screening_id, party_id: i.party.party_id, role: i.party.party_role, result, list_version: list_versions.ofac_sdn, list_versions, list_stale: stale, all_parties_clear: all, retention_class: "ofac_records_10y" }, i.at, actor)];
  if (result === "potential_match") out.push(emit(events, i.application_id, "ofac.potential_match", { screening_id: screening.screening_id, party_id: i.party.party_id, role: i.party.party_role, candidates: i.candidates.map((c) => ({ list: c.list, sdn_name: c.sdn_name, program: c.program, score: c.score })), resolution_required: "compare at least two non-name identifiers (DOB, nationality, address, ID numbers)" }, i.at, actor));
  return { screening, events: out, all_parties_clear: all };
}
export interface IdentifierComparison { readonly identifier: "date_of_birth" | "nationality" | "address" | "passport_number" | "national_id" | "entity_registration"; readonly party_value: string; readonly sdn_value: string; readonly matches: boolean; }
export type OfacAction = "rejected" | "blocked";
export interface ResolveOfacInput { readonly disposition: "false_positive" | "true_match"; readonly identifiers_compared: readonly IdentifierComparison[]; readonly action?: OfacAction; readonly blocked_property?: { description: string; value_cents: bigint; held_by: string } | null; readonly at: string; readonly memo_document_id?: string | null; }
/** 28.4's §501.603/.604 clocks: the report is due 10 business_days_federal after the block / rejection (ORS). */
export function ofacReportDue(on: PlainDate, cal: Calendar = federal): PlainDate { return addBusinessDays(on, 10, cal); }
export function ofacRecordsRetainedUntil(on: PlainDate): PlainDate { return plainDate(`${Number(on.slice(0, 4)) + OFAC_RECORDS_YEARS}${on.slice(4)}`); }
/** Borrower-facing statement on a rejected transaction: the transaction cannot proceed — no screening result, no SAR content (ECOA reasons come from 21.6's approved list). */
export const OFAC_BORROWER_STATEMENT = "We are unable to proceed with this transaction.";
/**
 * A potential match resolved: false positive with both identifiers recorded (`ofac.false_positive.resolved`), or a true
 * match — transaction rejected (no funds accepted) or property already held blocked — `ofac.match.confirmed{rejected|blocked}`,
 * 28.4's trigger event, `fraud.hold.placed`; records carry `retention_class = ofac_records_10y`.
 */
export function resolveOfacMatch(events: EventStore, s: PartyScreening, i: ResolveOfacInput, actor: Actor = AGENT): { screening: PartyScreening; events: DomainEvent[]; report_due_on: PlainDate | null; report_kind: "rejected_transaction" | "blocked_initial" | null; hold: FraudHold | null; borrower_statement: string | null } {
  if (s.result !== "potential_match") throw new RangeError(`screening ${s.screening_id} is ${s.result}, not potential_match`);
  const nonName = i.identifiers_compared.filter((c) => c.identifier !== ("name" as string));
  if (nonName.length < 2) throw new ScreeningRefused("OFAC_RESOLUTION_NEEDS_TWO_IDENTIFIERS", "22.6 R4: potential matches are resolved by comparing at least two non-name identifiers", `only ${nonName.length} non-name identifier(s) compared`);
  const on = civil(i.at, federal);
  if (i.disposition === "false_positive") {
    if (nonName.some((c) => c.matches)) throw new ScreeningRefused("OFAC_FALSE_POSITIVE_NEEDS_DIFFERING_IDENTIFIERS", "22.6 edge cases: a weak-identifier match that cannot be resolved is treated as a match (conservative)", "every compared identifier must differ to resolve as a false positive");
    const screening: PartyScreening = { ...s, result: "match_resolved_false", resolution: { disposition: "false_positive_resolved", identifiers_compared: i.identifiers_compared, memo_document_id: i.memo_document_id ?? null, resolved_at: i.at } };
    const ev = emit(events, s.application_id, "ofac.false_positive.resolved", { screening_id: s.screening_id, party_id: s.party_id, role: s.party_role, result: "false_positive_resolved", identifiers_compared: i.identifiers_compared, list_version: s.list_versions.ofac_sdn, retention_class: "ofac_records_10y" }, i.at, actor);
    return { screening, events: [ev], report_due_on: null, report_kind: null, hold: null, borrower_statement: null };
  }
  const action: OfacAction = i.action ?? (i.blocked_property ? "blocked" : "rejected");
  const screening: PartyScreening = { ...s, result: "match_true", resolution: { disposition: action === "blocked" ? "true_match_blocked" : "true_match_rejected", identifiers_compared: i.identifiers_compared, blocked_property: i.blocked_property ?? null, resolved_at: i.at, records_retained_until: ofacRecordsRetainedUntil(on) } };
  const out: DomainEvent[] = [];
  out.push(emit(events, s.application_id, "ofac.match.confirmed", { screening_id: s.screening_id, party_id: s.party_id, role: s.party_role, disposition: action, rejected: action === "rejected", blocked: action === "blocked", identifiers_compared: i.identifiers_compared, list_version: s.list_versions.ofac_sdn, retention_class: "ofac_records_10y", records_retained_until: ofacRecordsRetainedUntil(on), hand_off: "28.4" }, i.at, actor));
  const report_kind = action === "rejected" ? "rejected_transaction" : "blocked_initial";
  if (action === "rejected") out.push(emit(events, s.application_id, "ofac.transaction.rejected", { screening_id: s.screening_id, party_id: s.party_id, rejection_date: on, rejected_on: on, report_due_on: ofacReportDue(on), retention_class: "ofac_records_10y" }, i.at, actor));
  else out.push(emit(events, s.application_id, "ofac.property.blocked", { screening_id: s.screening_id, party_id: s.party_id, blocked_on: on, blocked_date: on, property: i.blocked_property ? { ...i.blocked_property, value_cents: String(i.blocked_property.value_cents) } : null, report_due_on: ofacReportDue(on), retention_class: "ofac_records_10y" }, i.at, actor));
  const hold = placeHold(events, { application_id: s.application_id, reason: "ofac_match_true", case_id: null, at: i.at, detail: { party_id: s.party_id, action } }, actor);
  out.push(hold.event);
  return { screening, events: out, report_due_on: ofacReportDue(on), report_kind, hold: hold.hold, borrower_statement: OFAC_BORROWER_STATEMENT };
}
/** A new SLS list version published after the last screen requires a re-screen before the next checkpoint (pre-consummation, funding.authorized). */
export function rescreenRequired(i: { last_screen_on: PlainDate; last_list_published_on: PlainDate; latest_list_published_on: PlainDate; checkpoint: "pre_consummation" | "funding" | "party_change"; checkpoint_on: PlainDate }): { required: boolean; reason: string; rescreen_by: PlainDate } {
  const cal = creditor;
  const rescreen_by = i.checkpoint === "party_change" ? i.checkpoint_on : rollBack(addBusinessDays(i.checkpoint_on, -OFAC_FINAL_RESCREEN_BUSINESS_DAYS_CREDITOR, cal), cal);
  if (i.checkpoint === "party_change") return { required: true, reason: "party added or changed", rescreen_by };
  if (i.latest_list_published_on > i.last_list_published_on) return { required: true, reason: `SLS list version published ${i.latest_list_published_on} after the ${i.last_screen_on} screen`, rescreen_by };
  const window_start = addBusinessDays(i.checkpoint_on, -OFAC_FINAL_RESCREEN_BUSINESS_DAYS_CREDITOR, cal);
  if (i.checkpoint === "pre_consummation" && i.last_screen_on < window_start) return { required: true, reason: `final re-screen must be ≤ ${OFAC_FINAL_RESCREEN_BUSINESS_DAYS_CREDITOR} business_days_creditor before consummation (${window_start} or later)`, rescreen_by };
  return { required: false, reason: "screen current against the latest list version", rescreen_by };
}
/** OFAC_SDN_SCREEN_GATE: every party clear / false-positive-resolved against the latest list version; at a checkpoint, screened within 1 business_days_creditor before consummation. */
export function ofacScreenGate(f: Record<string, unknown>): GateResult {
  const results = (f.party_results ?? {}) as Record<string, string>; const ids = Object.keys(results);
  if (!ids.length) return { open: false, reason: "no party screened" };
  const bad = ids.filter((p) => results[p] !== "clear" && results[p] !== "match_resolved_false");
  if (bad.length) return { open: false, reason: `party ${bad.join(", ")} is ${bad.map((p) => results[p]).join("/")}` };
  if (typeof f.latest_list_published_on === "string" && typeof f.last_list_published_on === "string" && f.latest_list_published_on > f.last_list_published_on) return { open: false, reason: `re-screen required: list version published ${f.latest_list_published_on} after the screen's ${f.last_list_published_on} version` };
  if (typeof f.checkpoint_on === "string" && typeof f.last_screen_on === "string") {
    const r = rescreenRequired({ last_screen_on: plainDate(f.last_screen_on), last_list_published_on: plainDate(String(f.last_list_published_on ?? f.last_screen_on)), latest_list_published_on: plainDate(String(f.latest_list_published_on ?? f.last_list_published_on ?? f.last_screen_on)), checkpoint: (f.checkpoint as "pre_consummation" | "funding" | undefined) ?? "pre_consummation", checkpoint_on: plainDate(f.checkpoint_on) });
    if (r.required) return { open: false, reason: r.reason };
  }
  return { open: true };
}

// ============================================================ R5 — FCRA §605A(h) fraud-alert contact (FCRA_605A_H_ALERT_CONTACT_GATE)
export type AlertKind = "initial" | "active_duty" | "extended";
export type ContactMethod = "ai_voice" | "telephone_human" | "in_person" | "mail" | "email";
export interface FraudAlertFact { readonly borrower_id: string; readonly kind: AlertKind; readonly contact_phone: string | null; readonly designated_method: ContactMethod | null; readonly credit_header_phones?: readonly string[]; }
export interface ContactAttempt { readonly method: ContactMethod; readonly number_called: string | null; readonly outcome: "confirmed" | "unreachable" | "denied"; readonly automation_disclosed?: boolean; readonly identity_verified?: boolean; readonly signed_statement_returned?: boolean; }
export const ALERT_CONTACT_MAX_ATTEMPTS = 3;
export const ALERT_CONTACT_WINDOW_BUSINESS_DAYS = 5;
/** §1681c-1(h): initial/active-duty — contact the specified number (or reasonable steps: identity verified + callback to a credit-header number); extended — only in person or by the consumer's designated method (mail needs the returned signed statement). */
export function contactSatisfiesGate(alert: FraudAlertFact, c: ContactAttempt): { satisfies: boolean; reason: string } {
  if (c.outcome !== "confirmed") return { satisfies: false, reason: `outcome ${c.outcome}` };
  if (alert.kind === "extended") {
    const designated = alert.designated_method;
    if (c.method === "in_person") return { satisfies: true, reason: "extended alert: contact in person" };
    if (designated && c.method === designated) {
      if (designated === "mail" && !c.signed_statement_returned) return { satisfies: false, reason: "extended alert by mail: the consumer's signed statement must be returned" };
      return { satisfies: true, reason: `extended alert: contact by the designated method (${designated})` };
    }
    return { satisfies: false, reason: `extended alert: ${c.method} is not the consumer's designated method (${designated ?? "unspecified"}) — §1681c-1(h)(2)(B)` };
  }
  const phoneMethods: ContactMethod[] = ["ai_voice", "telephone_human"];
  if (c.method === "ai_voice" && c.automation_disclosed === false) return { satisfies: false, reason: "AI-voice contact requires the automation disclosure" };
  if (alert.contact_phone && phoneMethods.includes(c.method) && c.number_called === alert.contact_phone) return { satisfies: true, reason: "contact at the number the consumer specified (§1681c-1(h)(1)(B)(ii))" };
  if (c.identity_verified && phoneMethods.includes(c.method) && c.number_called && (alert.credit_header_phones ?? []).includes(c.number_called)) return { satisfies: true, reason: "reasonable steps: identity verified and callback to a credit-header number" };
  if (c.method === "in_person" && c.identity_verified) return { satisfies: true, reason: "reasonable steps: in-person identity verification" };
  return { satisfies: false, reason: alert.contact_phone ? `the specified number ${alert.contact_phone} was not the one contacted` : "no reasonable-belief step documented" };
}
/** The 5-business-day window counts from and including the first attempt day (R5 fixture: Oct 6, 7, 8, 9, 13 — Columbus Day Oct 12 excluded — "unreachable through Tue Oct 13"). */
export function unreachableDeadline(first_attempt_on: PlainDate, cal: Calendar = creditor): PlainDate { return addBusinessDays(first_attempt_on, ALERT_CONTACT_WINDOW_BUSINESS_DAYS - 1, cal); }
export function recordFraudAlertContact(events: EventStore, i: { application_id: string; alert: FraudAlertFact; contact: ContactAttempt; at: string; attempt_no: number; first_attempt_on?: PlainDate | null }, actor: Actor = AGENT): { satisfies: boolean; reason: string; event: DomainEvent; route_to_21_6: boolean; unreachable_deadline: PlainDate } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.alert.borrower_id, "borrower_id");
  const r = contactSatisfiesGate(i.alert, i.contact);
  const first = i.first_attempt_on ?? civil(i.at); const deadline = unreachableDeadline(first);
  const base = { borrower_id: i.alert.borrower_id, alert_kind: i.alert.kind, method: i.contact.method, number_called: i.contact.number_called, outcome: i.contact.outcome, attempt_no: i.attempt_no, reason: r.reason, contacted_at: i.at };
  if (r.satisfies) return { satisfies: true, reason: r.reason, event: emit(events, i.application_id, "fraud_alert.contact.completed", { ...base, gate: "FCRA_605A_H_ALERT_CONTACT_GATE", satisfies_gate: true }, i.at, actor), route_to_21_6: false, unreachable_deadline: deadline };
  const exhausted = i.attempt_no >= ALERT_CONTACT_MAX_ATTEMPTS || civil(i.at) > deadline;
  return { satisfies: false, reason: r.reason, event: emit(events, i.application_id, "fraud_alert.contact.attempted", { ...base, satisfies_gate: false, unreachable_deadline: deadline, route_to_21_6: exhausted }, i.at, actor), route_to_21_6: exhausted, unreachable_deadline: deadline };
}
/** FCRA_605A_H_ALERT_CONTACT_GATE: blocks `decision.issued{approval}` and `submitDu` until the contact duty is met for every alerted borrower. */
export function fraudAlertContactGate(f: Record<string, unknown>): GateResult {
  const alerted = Array.isArray(f.alerted_borrower_ids) ? (f.alerted_borrower_ids as string[]) : [];
  const done = new Set(Array.isArray(f.contact_completed_borrower_ids) ? (f.contact_completed_borrower_ids as string[]) : []);
  const open = alerted.filter((b) => !done.has(b));
  return open.length ? { open: false, reason: `§605A(h) contact not completed for ${open.join(", ")} (blocks decision.issued{approval} and submitDu)` } : { open: true };
}

// ============================================================ §1022.82 — address discrepancy (REGV_1022_82_ADDRESS_DISCREPANCY_GATE)
export type AddressSourceKind = "drivers_license" | "utility_statement" | "cip_records" | "internal_records" | "third_party_source" | "consumer_confirmation";
export interface AddressSource { readonly kind: AddressSourceKind; readonly address: string; readonly document_id: string | null; }
const normAddr = (s: string): string => s.trim().toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ");
/** §1022.82(c)(2): reasonable belief from CIP-type records, internal records, third-party sources or the consumer; the confirmed address is queued for furnishing at boarding (§1022.82(d)(3); 30.4). */
export function resolveAddressDiscrepancy(events: EventStore, i: { application_id: string; borrower_id: string; application_address: string; sources: readonly AddressSource[]; at: string }, actor: Actor = AGENT): { confirmed_address: string; matched_sources: AddressSourceKind[]; event: DomainEvent; furnishing: { furnish_to: "cra"; when: "boarding_30_4"; address: string } } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_id, "borrower_id"); nonEmpty(i.application_address, "application_address");
  const matched = i.sources.filter((s) => normAddr(s.address) === normAddr(i.application_address)).map((s) => s.kind);
  if (!matched.length) throw new ScreeningRefused("ADDRESS_DISCREPANCY_UNRESOLVED", "12 CFR 1022.82(c)(2)", "no (c)(2) source matches the application address — reasonable belief not formed");
  const event = emit(events, i.application_id, "address_discrepancy.resolved", { borrower_id: i.borrower_id, confirmed_address: i.application_address, method: "1022.82(c)(2)", matched_sources: matched, evidence_document_ids: i.sources.map((s) => s.document_id).filter(Boolean), furnish_at_boarding: true, furnish_to: "cra", furnish_when: "30.4 boarding (the reporting period in which the relationship is established)" }, i.at, actor);
  return { confirmed_address: i.application_address, matched_sources: matched, event, furnishing: { furnish_to: "cra", when: "boarding_30_4", address: i.application_address } };
}
export function addressDiscrepancyGate(f: Record<string, unknown>): GateResult {
  const open = (Array.isArray(f.discrepant_borrower_ids) ? (f.discrepant_borrower_ids as string[]) : []).filter((b) => !(Array.isArray(f.resolved_borrower_ids) ? (f.resolved_borrower_ids as string[]) : []).includes(b));
  return open.length ? { open: false, reason: `address discrepancy unresolved for ${open.join(", ")} (blocks decision.issued{approval})` } : { open: true };
}

// ============================================================ R6 — Red Flags program (16 CFR 681; RED_FLAGS_681_RESPONSE_1BD)
export type RedFlagCategory = "cra_alert" | "address_discrepancy" | "suspicious_document" | "suspicious_pii" | "unusual_activity" | "notice_from_victim_or_le" | "vendor_alert" | "agent_observation";
export type RedFlagResponse = "monitor" | "verify_identity" | "contact_consumer" | "decline_to_proceed" | "close_case_false_positive" | "escalate" | "notify_law_enforcement" | "no_action";
export const RED_FLAG_RESPONSE_BUSINESS_DAYS = 1;
/** ITPP Appendix A-style catalog (R6). */
export const RED_FLAG_CATALOG: Readonly<Record<string, { category: RedFlagCategory; description: string }>> = {
  RF_CRA_FRAUD_ALERT: { category: "cra_alert", description: "fraud or active-duty alert on the consumer report" }, RF_CRA_FREEZE: { category: "cra_alert", description: "credit freeze" }, RF_CRA_ADDRESS_DISCREPANCY: { category: "address_discrepancy", description: "notice of address discrepancy" }, RF_CRA_INQUIRY_VELOCITY: { category: "cra_alert", description: "unusual inquiry velocity" },
  RF_DOC_INTEGRITY_FAILED: { category: "suspicious_document", description: "document integrity failure (22.1)" }, RF_DOC_ALTERED_ID: { category: "suspicious_document", description: "altered or forged identification" }, RF_DOC_PHOTO_INCONSISTENT: { category: "suspicious_document", description: "photograph inconsistent with the applicant" },
  RF_PII_SSN_NOT_ISSUED: { category: "suspicious_pii", description: "SSN not issued / issued before DOB / deceased" }, RF_PII_ADDRESS_MAIL_DROP: { category: "suspicious_pii", description: "address is a mail drop, prison or commercial address" }, RF_PII_SSN_SHARED: { category: "suspicious_pii", description: "SSN shared across applications in SM's book" },
  RF_ACT_DATA_CHANGE_POST_DU: { category: "unusual_activity", description: "application data changed after DU" }, RF_ACT_MULTIPLE_APPLICATIONS: { category: "unusual_activity", description: "multiple applications with the same property/parties" }, RF_ACT_TRANSCRIPT_DISCREPANCY: { category: "unusual_activity", description: "IRS transcript figures differ from the returns (22.3)" },
  RF_NOTICE_VICTIM_OR_LE: { category: "notice_from_victim_or_le", description: "notice from a victim, law enforcement or a CRA" }, RF_NOTICE_WATCHLIST: { category: "notice_from_victim_or_le", description: "identity on SM's internal watchlist" }, RF_VENDOR_ALERT: { category: "vendor_alert", description: "fraud-tool alert" }, RF_AGENT_OBSERVATION: { category: "agent_observation", description: "agent observation" },
};
export interface RedFlagRow { readonly event_id: string; readonly application_id: string; readonly category: RedFlagCategory; readonly red_flag_code: string; readonly detected_at: string; readonly detected_on: PlainDate; readonly detected_by: string; readonly response_due_on: PlainDate; readonly response: RedFlagResponse | null; readonly responded_at: string | null; readonly response_hours: number | null; readonly sla_breached: boolean; readonly resolution: Record<string, unknown> | null; readonly case_id: string | null; readonly detail: Record<string, unknown>; }
export function redFlagResponseDue(detected_at: string, cal: Calendar = creditor): PlainDate { return addBusinessDays(civil(detected_at, cal), RED_FLAG_RESPONSE_BUSINESS_DAYS, cal); }
/** Each detection is a `red_flag_events` row and `red_flag.detected` (anchor `detected_at`; response within 1 business_days_creditor). */
export function logRedFlag(events: EventStore, i: { application_id: string; red_flag_code: string; detected_at: string; detected_by: string; detail?: Record<string, unknown>; category?: RedFlagCategory }, actor: Actor = AGENT): { row: RedFlagRow; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.red_flag_code, "red_flag_code"); nonEmpty(i.detected_at, "detected_at");
  const cat = RED_FLAG_CATALOG[i.red_flag_code]?.category ?? i.category;
  if (!cat) throw new RangeError(`red_flag_code ${i.red_flag_code} is not in the program catalog and no category was given`);
  const row: RedFlagRow = { event_id: randomUUID(), application_id: i.application_id, category: cat, red_flag_code: i.red_flag_code, detected_at: i.detected_at, detected_on: civil(i.detected_at), detected_by: i.detected_by, response_due_on: redFlagResponseDue(i.detected_at), response: null, responded_at: null, response_hours: null, sla_breached: false, resolution: null, case_id: null, detail: i.detail ?? {} };
  const event = emit(events, i.application_id, "red_flag.detected", { event_id: row.event_id, category: cat, red_flag_code: i.red_flag_code, detected_at: i.detected_at, detected_by: i.detected_by, response_due_on: row.response_due_on, detail: row.detail }, i.detected_at, actor);
  return { row, event };
}
export function respondRedFlag(events: EventStore, row: RedFlagRow, i: { response: RedFlagResponse; responded_at: string; resolution?: Record<string, unknown>; case_id?: string | null }, actor: Actor = AGENT): { row: RedFlagRow; event: DomainEvent; within_sla: boolean } {
  if (row.responded_at) throw new RangeError(`red flag ${row.event_id} already responded ${row.responded_at}`);
  const hours = Math.round(((Date.parse(i.responded_at) - Date.parse(row.detected_at)) / 3_600_000) * 100) / 100;
  if (hours < 0) throw new RangeError("responded_at is before detected_at");
  const within = civil(i.responded_at) <= row.response_due_on;
  const next: RedFlagRow = { ...row, response: i.response, responded_at: i.responded_at, response_hours: hours, sla_breached: !within, resolution: i.resolution ?? null, case_id: i.case_id ?? row.case_id };
  const event = emit(events, row.application_id, "red_flag.responded", { event_id: row.event_id, category: row.category, red_flag_code: row.red_flag_code, response: i.response, responded_at: i.responded_at, response_hours: hours, within_sla: within, case_id: next.case_id }, i.responded_at, actor);
  return { row: next, event, within_sla: within };
}
/** The annual ITPP report to the partner's board: every event with its response time; breaches and open items called out. */
export function itppAnnualReport(rows: readonly RedFlagRow[], period: { from: PlainDate; to: PlainDate }, as_of: string): { period: { from: PlainDate; to: PlainDate }; events: { event_id: string; category: RedFlagCategory; red_flag_code: string; detected_at: string; response: RedFlagResponse | null; responded_at: string | null; response_hours: number | null; sla_breached: boolean }[]; by_category: Record<string, number>; breaches: number; open: number } {
  const inPeriod = rows.filter((r) => r.detected_on >= period.from && r.detected_on <= period.to);
  const events = inPeriod.map((r) => { const breached = r.sla_breached || (!r.responded_at && civil(as_of) > r.response_due_on); return { event_id: r.event_id, category: r.category, red_flag_code: r.red_flag_code, detected_at: r.detected_at, response: r.response, responded_at: r.responded_at, response_hours: r.response_hours, sla_breached: breached }; });
  const by_category: Record<string, number> = {}; for (const e of events) by_category[e.category] = (by_category[e.category] ?? 0) + 1;
  return { period, events, by_category, breaches: events.filter((e) => e.sla_breached).length, open: events.filter((e) => !e.responded_at).length };
}
/** Upstream signals (22.1 integrity, 22.2 alerts/mismatches, 22.3 transcript discrepancies, 22.4/22.5 hand-offs) become Red Flags rows; an address mismatch also opens the §1022.82 gate (`address_discrepancy.detected`); a failed document is an investigation candidate. */
export function intakeUpstreamSignal(events: EventStore, e: DomainEvent, actor: Actor = AGENT): { red_flag: { row: RedFlagRow; event: DomainEvent } | null; address_discrepancy: DomainEvent | null; investigation_candidate: boolean } {
  const p = e.payload as Record<string, unknown>; const app = e.applicationId ?? (typeof p.application_id === "string" ? p.application_id : "");
  if (!app) throw new RangeError("upstream event carries no application id");
  const by = `${e.actor.kind}:${e.actor.id}`;
  const map: Record<string, string> = { "credit.fraud_alert.detected": "RF_CRA_FRAUD_ALERT", "credit.identity_mismatch.detected": "RF_CRA_ADDRESS_DISCREPANCY", "document.integrity.failed": "RF_DOC_INTEGRITY_FAILED", "document.integrity.flagged": "RF_DOC_INTEGRITY_FAILED", "transcript.discrepancy.detected": "RF_ACT_TRANSCRIPT_DISCREPANCY", "fraud.case.candidate": "RF_AGENT_OBSERVATION", "asset.deposit.unsourced": "RF_ACT_DATA_CHANGE_POST_DU", "gift.donor.interested_party_suspected": "RF_AGENT_OBSERVATION", "ipc.undisclosed.suspected": "RF_AGENT_OBSERVATION", "liability.discovered": "RF_ACT_DATA_CHANGE_POST_DU" };
  const code = map[e.type]; if (!code) return { red_flag: null, address_discrepancy: null, investigation_candidate: false };
  const fields = Array.isArray(p.fields) ? (p.fields as string[]) : [];
  if (e.type === "credit.identity_mismatch.detected" && !fields.includes("address")) return { red_flag: logRedFlag(events, { application_id: app, red_flag_code: "RF_PII_SSN_NOT_ISSUED", category: "suspicious_pii", detected_at: e.occurredAt, detected_by: by, detail: { source_event: e.type, fields } }, actor), address_discrepancy: null, investigation_candidate: false };
  const red_flag = logRedFlag(events, { application_id: app, red_flag_code: code, detected_at: e.occurredAt, detected_by: by, detail: { source_event: e.type, source_event_id: e.id, ...(typeof p.document_id === "string" ? { document_id: p.document_id } : {}), ...(typeof p.borrower_id === "string" ? { borrower_id: p.borrower_id } : {}) } }, actor);
  const address_discrepancy = e.type === "credit.identity_mismatch.detected" ? emit(events, app, "address_discrepancy.detected", { borrower_id: p.borrower_id ?? null, report_id: p.report_id ?? null, fields, red_flag_event_id: red_flag.row.event_id }, e.occurredAt, actor) : null;
  const investigation_candidate = e.type === "document.integrity.failed" || p.fraud_case_candidate === true || e.type === "fraud.case.candidate";
  return { red_flag, address_discrepancy, investigation_candidate };
}

// ============================================================ Fraud tool (SM_FRAUD_TOOL_CLEAR_GATE)
export type AlertSeverity = "high" | "medium" | "low";
export type AlertDisposition = "cleared_with_evidence" | "false_positive" | "escalated_to_investigation" | "confirmed";
export interface FraudToolAlert { readonly alert_id: string; readonly category: string; readonly severity: AlertSeverity; readonly description: string; readonly disposition?: AlertDisposition | null; readonly evidence_document_ids?: readonly string[]; }
export interface FraudReport { readonly report_id: string; readonly vendor: string; readonly score: number | null; readonly alerts: readonly FraudToolAlert[]; readonly run_at: string; }
export interface FraudToolPort { run(req: { application_id: string; parties: readonly PartyIdentity[]; refresh: boolean }): Promise<Omit<FraudReport, "run_at">>; }
export const FRAUD_TOOL_REFRESH_BUSINESS_DAYS_CREDITOR = 10;
export const highOpen = (alerts: readonly FraudToolAlert[]): number => alerts.filter((a) => a.severity === "high" && (!a.disposition || a.disposition === "escalated_to_investigation" || a.disposition === "confirmed")).length;
export function recordFraudReport(events: EventStore, i: { application_id: string; report: FraudReport; scheduled_consummation_date: PlainDate | null }, actor: Actor = AGENT): { report: FraudReport; events: DomainEvent[]; high_open: number; investigation_required: boolean } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.report.report_id, "report_id");
  const open = highOpen(i.report.alerts);
  const out = [emit(events, i.application_id, "fraud_tool.report.received", { report_id: i.report.report_id, vendor: i.report.vendor, score: i.report.score, alerts: i.report.alerts.length, high_open: open, valid_until: i.scheduled_consummation_date, retention_class: "fnma_loan_file_life_plus_4y" }, i.report.run_at, actor)];
  if (open === 0) out.push(emit(events, i.application_id, "fraud_tool.cleared", { report_id: i.report.report_id, high_open: 0, screening_clear: true }, i.report.run_at, actor));
  return { report: i.report, events: out, high_open: open, investigation_required: false };
}
/** Every high-severity alert is dispositioned with evidence; `confirmed` / `escalated_to_investigation` opens an investigation and keeps the gate closed; the last cleared high alert emits `fraud_tool.cleared`. */
export function dispositionFraudAlert(events: EventStore, report: FraudReport, i: { alert_id: string; disposition: AlertDisposition; evidence_document_ids: readonly string[]; rationale: string; at: string }, actor: Actor = AGENT): { report: FraudReport; events: DomainEvent[]; high_open: number; investigation_required: boolean } {
  const a = report.alerts.find((x) => x.alert_id === i.alert_id); if (!a) throw new RangeError(`alert ${i.alert_id} is not on report ${report.report_id}`);
  if (a.severity === "high" && (i.disposition === "cleared_with_evidence" || i.disposition === "false_positive") && !i.evidence_document_ids.length) throw new ScreeningRefused("HIGH_ALERT_NEEDS_EVIDENCE", "22.6 SM_FRAUD_TOOL_CLEAR_GATE: every high-severity alert dispositioned", "a high-severity alert is cleared only with evidence");
  nonEmpty(i.rationale, "rationale");
  const alerts = report.alerts.map((x) => (x.alert_id === i.alert_id ? { ...x, disposition: i.disposition, evidence_document_ids: i.evidence_document_ids } : x));
  const next: FraudReport = { ...report, alerts }; const open = highOpen(alerts);
  const app = (events.ofType("fraud_tool.report.received").find((e) => (e.payload as { report_id: string }).report_id === report.report_id)?.applicationId) ?? "";
  const out = [emit(events, app, "fraud_tool.alert.dispositioned", { report_id: report.report_id, alert_id: i.alert_id, severity: a.severity, disposition: i.disposition, evidence_document_ids: i.evidence_document_ids, rationale: i.rationale, high_open: open }, i.at, actor)];
  const investigation_required = i.disposition === "confirmed" || i.disposition === "escalated_to_investigation";
  if (open === 0 && !investigation_required) out.push(emit(events, app, "fraud_tool.cleared", { report_id: report.report_id, high_open: 0, screening_clear: true }, i.at, actor));
  return { report: next, events: out, high_open: open, investigation_required };
}
/** SM_FRAUD_TOOL_CLEAR_GATE: a report for every borrower/party, every high alert dispositioned, refreshed ≤ 10 business_days_creditor before consummation. */
export function fraudToolClearGate(f: Record<string, unknown>): GateResult {
  if (!f.report_id) return { open: false, reason: "no fraud-tool report run (blocks CTC)" };
  const open = Number(f.high_open ?? 0); if (open > 0) return { open: false, reason: `${open} high-severity alert(s) not dispositioned (blocks CTC)` };
  if (typeof f.scheduled_consummation_date === "string" && typeof f.run_on === "string") {
    const earliest = addBusinessDays(plainDate(f.scheduled_consummation_date), -FRAUD_TOOL_REFRESH_BUSINESS_DAYS_CREDITOR, creditor);
    if (plainDate(f.run_on) < earliest) return { open: false, reason: `fraud-tool refresh dated ${f.run_on} is more than ${FRAUD_TOOL_REFRESH_BUSINESS_DAYS_CREDITOR} business_days_creditor before consummation ${f.scheduled_consummation_date}` };
  }
  return { open: true };
}

// ============================================================ R7 — occupancy risk score (SM_OCCUPANCY_REO_GATE)
export interface OccupancySignals { readonly distance_subject_employer_km?: number | null; readonly residence_retained_no_rental_history_rent_needed?: boolean; readonly purchase_smaller_or_cheaper_than_current?: boolean; readonly other_rentals_owned?: number; readonly rent_free_letter?: boolean; readonly du_occupancy_modified_from_investor?: boolean; readonly insurance_landlord_policy?: boolean; readonly mailing_address_differs_after_closing?: boolean; readonly reverse_occupancy_pattern?: boolean; readonly contradiction?: string | null; readonly [k: string]: unknown; }
export const OCCUPANCY_WEIGHTS = { distance_over_100km: 3, residence_retained_rent_needed: 3, smaller_or_cheaper: 2, two_or_more_other_rentals: 2, rent_free_letter: 2, du_occupancy_modified: 3, landlord_policy: 3, mailing_address_differs: 2, reverse_occupancy_pattern: 3 } as const;
export const OCCUPANCY_NEEDS_EXPLANATION_SCORE = 5;
export const OCCUPANCY_INCONSISTENT_SCORE = 8;
export type OccupancyConclusion = "consistent" | "needs_explanation" | "inconsistent";
/** Guardrail: race/ethnicity/national origin/religion/language preference and `applicant_demographics` fields are never model inputs. */
export const FORBIDDEN_MODEL_INPUTS: readonly RegExp[] = [/applicant_demographics/i, /\b(race|ethnicity|national_origin|religion|sex|gender|age|language_preference|marital_status|disability)\b/i];
export function assertNoDemographicInputs(keys: readonly string[]): void { const bad = keys.filter((k) => FORBIDDEN_MODEL_INPUTS.some((p) => p.test(k))); if (bad.length) throw new ScreeningRefused("NO_DEMOGRAPHIC_INPUTS", "22.6 guardrail; Reg B §1002.6(b)", `refused: ${bad.join(", ")} may not be model inputs`); }
export function scoreOccupancy(s: OccupancySignals): { score: number; contributions: { signal: keyof typeof OCCUPANCY_WEIGHTS; points: number }[]; conclusion: OccupancyConclusion; contradiction: string | null } {
  assertNoDemographicInputs(Object.keys(s));
  const c: { signal: keyof typeof OCCUPANCY_WEIGHTS; points: number }[] = [];
  if ((s.distance_subject_employer_km ?? 0) > 100) c.push({ signal: "distance_over_100km", points: OCCUPANCY_WEIGHTS.distance_over_100km });
  if (s.residence_retained_no_rental_history_rent_needed) c.push({ signal: "residence_retained_rent_needed", points: OCCUPANCY_WEIGHTS.residence_retained_rent_needed });
  if (s.purchase_smaller_or_cheaper_than_current) c.push({ signal: "smaller_or_cheaper", points: OCCUPANCY_WEIGHTS.smaller_or_cheaper });
  if ((s.other_rentals_owned ?? 0) >= 2) c.push({ signal: "two_or_more_other_rentals", points: OCCUPANCY_WEIGHTS.two_or_more_other_rentals });
  if (s.rent_free_letter) c.push({ signal: "rent_free_letter", points: OCCUPANCY_WEIGHTS.rent_free_letter });
  if (s.du_occupancy_modified_from_investor) c.push({ signal: "du_occupancy_modified", points: OCCUPANCY_WEIGHTS.du_occupancy_modified });
  if (s.insurance_landlord_policy) c.push({ signal: "landlord_policy", points: OCCUPANCY_WEIGHTS.landlord_policy });
  if (s.mailing_address_differs_after_closing) c.push({ signal: "mailing_address_differs", points: OCCUPANCY_WEIGHTS.mailing_address_differs });
  if (s.reverse_occupancy_pattern) c.push({ signal: "reverse_occupancy_pattern", points: OCCUPANCY_WEIGHTS.reverse_occupancy_pattern });
  const score = c.reduce((a, x) => a + x.points, 0);
  const contradiction = s.contradiction ?? null;
  const conclusion: OccupancyConclusion = contradiction || score >= OCCUPANCY_INCONSISTENT_SCORE ? "inconsistent" : score >= OCCUPANCY_NEEDS_EXPLANATION_SCORE ? "needs_explanation" : "consistent";
  return { score, contributions: c, conclusion, contradiction };
}
export interface OccupancyAssessment { readonly assessment_id: string; readonly application_id: string; readonly declared_occupancy: "primary" | "second_home" | "investment"; readonly signals: OccupancySignals; readonly risk_score: number; readonly conclusion: OccupancyConclusion; readonly explanation_document_id: string | null; readonly assessed_at: string; }
export function assessOccupancy(events: EventStore, i: { application_id: string; declared_occupancy: OccupancyAssessment["declared_occupancy"]; signals: OccupancySignals; at: string; explanation_document_id?: string | null }, actor: Actor = AGENT): { assessment: OccupancyAssessment; event: DomainEvent; next: "none" | "borrower_statement_and_corroboration" | "open_investigation"; rent_excluded_until_b3_3_8: boolean } {
  nonEmpty(i.application_id, "application_id");
  const s = scoreOccupancy(i.signals);
  const assessment: OccupancyAssessment = { assessment_id: randomUUID(), application_id: i.application_id, declared_occupancy: i.declared_occupancy, signals: i.signals, risk_score: s.score, conclusion: s.conclusion, explanation_document_id: i.explanation_document_id ?? null, assessed_at: i.at };
  const next = s.conclusion === "inconsistent" ? "open_investigation" : s.conclusion === "needs_explanation" ? "borrower_statement_and_corroboration" : "none";
  const event = emit(events, i.application_id, "occupancy.assessed", { assessment_id: assessment.assessment_id, declared_occupancy: i.declared_occupancy, risk_score: s.score, contributions: s.contributions, conclusion: s.conclusion, contradiction: s.contradiction, next, blocks_ctc: s.conclusion !== "consistent", decline_reason_if_unexplained: s.conclusion === "inconsistent" ? DECLINE_REASON_UNVERIFIABLE : null }, i.at, actor);
  return { assessment, event, next, rent_excluded_until_b3_3_8: i.signals.residence_retained_no_rental_history_rent_needed === true };
}

// ============================================================ R8 — undisclosed REO
export type ReoSource = "credit_mortgage_tradelines" | "mers_lookup" | "public_records_vendor" | "tax_assessor" | "prior_application_data" | "servicing_book" | "du_message";
export interface ReoFinding { readonly source: ReoSource; readonly description: string; readonly upb_cents?: bigint | null; readonly min?: string | null; readonly vested_name?: string | null; readonly opened_year?: number | null; readonly on_reo_schedule: boolean; }
export type ReoStatus = "clear" | "discrepancy_open" | "resolved_added_to_reo" | "resolved_not_borrower";
export interface ReoCheck { readonly check_id: string; readonly application_id: string; readonly borrower_id: string; readonly sources: readonly ReoSource[]; readonly findings: readonly ReoFinding[]; readonly undisclosed_count: number; readonly status: ReoStatus; readonly evidence_document_ids: readonly string[]; readonly checked_at: string; readonly resolved_at: string | null; }
export interface MersPort { minSearch(req: { borrower_name: string; ssn_hash: string }): Promise<{ min: string; property: string; vested_name: string }[]>; }
export function discoverReo(events: EventStore, i: { application_id: string; borrower_id: string; findings: readonly ReoFinding[]; at: string }, actor: Actor = AGENT): { check: ReoCheck; event: DomainEvent | null } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_id, "borrower_id");
  const undisclosed = i.findings.filter((f) => !f.on_reo_schedule);
  const check: ReoCheck = { check_id: randomUUID(), application_id: i.application_id, borrower_id: i.borrower_id, sources: [...new Set(i.findings.map((f) => f.source))], findings: i.findings, undisclosed_count: undisclosed.length, status: undisclosed.length ? "discrepancy_open" : "clear", evidence_document_ids: [], checked_at: i.at, resolved_at: null };
  const event = undisclosed.length ? emit(events, i.application_id, "reo.discrepancy.detected", { check_id: check.check_id, borrower_id: i.borrower_id, undisclosed_count: undisclosed.length, findings: undisclosed.map((f) => ({ source: f.source, description: f.description, upb_cents: f.upb_cents === null || f.upb_cents === undefined ? null : String(f.upb_cents), min: f.min ?? null, vested_name: f.vested_name ?? null })), next: "borrower explanation and documents" }, i.at, actor) : null;
  return { check, event };
}
export interface PitiaComponents { readonly pi_cents: bigint; readonly taxes_cents: bigint; readonly insurance_cents: bigint; readonly hoa_cents?: bigint; }
export const pitiaCents = (c: PitiaComponents): bigint => c.pi_cents + c.taxes_cents + c.insurance_cents + (c.hoa_cents ?? 0n);
export interface ResolveReoInput { readonly resolution: "added_to_reo" | "not_borrower"; readonly evidence_document_ids: readonly string[]; readonly property?: { address: string; upb_cents: bigint; pitia: PitiaComponents; rental: boolean } | null; readonly financed_property_count_before: number; readonly at: string; readonly repeat_pattern?: boolean; }
/** Added to the REO schedule → 22.5 adds the PITIA, 23.2 recounts financed properties, 22.4 adds the B3-4.1-01 percentage of the other UPB to reserves, 23.1 resubmits; documented as not the borrower's (deed shows a same-name relative) → contingent-liability rules. */
export function resolveReoDiscrepancy(events: EventStore, check: ReoCheck, i: ResolveReoInput, actor: Actor = AGENT): { check: ReoCheck; event: DomainEvent; handoffs: Record<string, unknown>; misstatement: "unintentional" | "pattern_repeats" | null } {
  if (check.status !== "discrepancy_open") throw new RangeError(`REO check ${check.check_id} is ${check.status}, not discrepancy_open`);
  if (!i.evidence_document_ids.length) throw new ScreeningRefused("REO_RESOLUTION_NEEDS_EVIDENCE", "22.6 R8", "borrower explanation and documents (deed, statement, lease) are required");
  if (i.resolution === "added_to_reo") {
    if (!i.property) throw new RangeError("property (address, upb_cents, pitia) is required to add it to the REO schedule");
    const pitia = pitiaCents(i.property.pitia); const count = i.financed_property_count_before + 1; const bps = otherFinancedPctBps(count); const reserves_add_on = (i.property.upb_cents * BigInt(bps)) / 10_000n;
    const handoffs = { "22.5": { liability_type: "mortgage", qualifying_payment_cents: pitia, payment_basis: "mortgage_pitia", rental_income_rule: i.property.rental ? "B3-3.8 (grandfathered structure for applications before the effective date)" : null }, "23.2": { financed_property_count: count }, "22.4": { other_financed_upb_cents: i.property.upb_cents, pct_bps: bps, reserves_add_on_cents: reserves_add_on }, "23.1": { du_resubmission_required: true } };
    const next: ReoCheck = { ...check, status: "resolved_added_to_reo", evidence_document_ids: i.evidence_document_ids, resolved_at: i.at };
    const event = emit(events, check.application_id, "reo.discrepancy.resolved", { check_id: check.check_id, borrower_id: check.borrower_id, status: "resolved_added_to_reo", property: i.property.address, upb_cents: String(i.property.upb_cents), pitia_cents: String(pitia), financed_property_count: count, reserves_pct_bps: bps, reserves_add_on_cents: String(reserves_add_on), du_resubmission_required: true, evidence_document_ids: i.evidence_document_ids, misstatement: i.repeat_pattern ? "pattern_repeats" : "unintentional" }, i.at, actor);
    return { check: next, event, handoffs, misstatement: i.repeat_pattern ? "pattern_repeats" : "unintentional" };
  }
  const next: ReoCheck = { ...check, status: "resolved_not_borrower", evidence_document_ids: i.evidence_document_ids, resolved_at: i.at };
  const event = emit(events, check.application_id, "reo.discrepancy.resolved", { check_id: check.check_id, borrower_id: check.borrower_id, status: "resolved_not_borrower", evidence_document_ids: i.evidence_document_ids, contingent_liability_review: "22.5 (co-signed obligations)", du_resubmission_required: false }, i.at, actor);
  return { check: next, event, handoffs: { "22.5": { contingent_liability_review: true } }, misstatement: null };
}
/** SM_OCCUPANCY_REO_GATE: `occupancy_assessments.conclusion = consistent` (or needs_explanation resolved) and `reo_discovery_checks.status ∈ {clear, resolved_*}`; `occupancy_reo.cleared` when both hold. */
export function occupancyReoGate(f: Record<string, unknown>): GateResult {
  const occ = String(f.occupancy_conclusion ?? ""); const reo = String(f.reo_status ?? "clear");
  const occOk = occ === "consistent" || (occ === "needs_explanation" && f.explanation_resolved === true);
  if (!occOk) return { open: false, reason: `occupancy ${occ || "not assessed"} (blocks CTC)` };
  if (!(reo === "clear" || reo.startsWith("resolved_"))) return { open: false, reason: `REO ${reo} (blocks CTC)` };
  return { open: true };
}
export function reconcileOccupancyReo(events: EventStore, i: { application_id: string; occupancy_conclusion: OccupancyConclusion | null; explanation_resolved?: boolean; reo_status: ReoStatus | null; at: string }, actor: Actor = AGENT): { gate: GateResult; event: DomainEvent | null } {
  const gate = occupancyReoGate({ occupancy_conclusion: i.occupancy_conclusion, explanation_resolved: i.explanation_resolved ?? false, reo_status: i.reo_status ?? "clear" });
  return { gate, event: gate.open ? emit(events, i.application_id, "occupancy_reo.cleared", { occupancy_conclusion: i.occupancy_conclusion, reo_status: i.reo_status ?? "clear" }, i.at, actor) : null };
}

// ============================================================ R9 — non-arm's-length (B2-1.3-01; FNMA_B2_1_3_01_NON_ARMS_LENGTH_GATE)
export type RelationshipKind = "none" | "family" | "employer_employee" | "business_affiliation" | "agent_is_party" | "builder_relationship" | "landlord_tenant" | "other";
export interface NonArmsLengthInput { readonly application_id: string; readonly relationship_kind: RelationshipKind; readonly property_new_construction: boolean; readonly occupancy: "primary" | "second_home" | "investment"; readonly gift_of_equity_cents?: bigint; readonly purchase_price_cents?: bigint | null; readonly true_occupancy_primary_evidence?: boolean; readonly at: string; }
export interface NonArmsLengthAssessment { readonly assessment_id: string; readonly application_id: string; readonly relationship_kind: RelationshipKind; readonly property_new_construction: boolean; readonly occupancy: NonArmsLengthInput["occupancy"]; readonly eligible: boolean; readonly value_acceptance_blocked: boolean; readonly gift_of_equity_cents: bigint; readonly documentation_required: readonly string[]; readonly disposition: "proceed" | "restructure_with_primary_evidence" | "decline_via_21_6"; readonly assessed_at: string; }
export function assessNonArmsLength(events: EventStore, i: NonArmsLengthInput, actor: Actor = AGENT): { assessment: NonArmsLengthAssessment; events: DomainEvent[]; handoffs: Record<string, unknown> } {
  nonEmpty(i.application_id, "application_id");
  const gift = i.gift_of_equity_cents ?? 0n; if (gift < 0n) throw new RangeError("gift_of_equity_cents must be ≥ 0");
  const related = i.relationship_kind !== "none";
  const eligible = !related || !i.property_new_construction || i.occupancy === "primary";
  const value_acceptance_blocked = related && gift > 0n;
  const documentation_required = related ? ["relationship disclosure", ...(gift > 0n ? ["gift of equity letter (B3-4.3-05)", "traditional appraisal (value acceptance ineligible — B4-1.4-10)"] : []), ...(i.property_new_construction ? ["builder/employer relationship statement"] : []), "title vesting history"] : [];
  const disposition = eligible ? "proceed" : i.true_occupancy_primary_evidence ? "restructure_with_primary_evidence" : "decline_via_21_6";
  const assessment: NonArmsLengthAssessment = { assessment_id: randomUUID(), application_id: i.application_id, relationship_kind: i.relationship_kind, property_new_construction: i.property_new_construction, occupancy: i.occupancy, eligible, value_acceptance_blocked, gift_of_equity_cents: gift, documentation_required, disposition, assessed_at: i.at };
  const out = [emit(events, i.application_id, "non_arms_length.assessed", { assessment_id: assessment.assessment_id, relationship: i.relationship_kind, relationship_kind: i.relationship_kind, property_new_construction: i.property_new_construction, occupancy: i.occupancy, eligible, value_acceptance_blocked, gift_of_equity_cents: String(gift), disposition, rule: eligible ? null : "B2-1.3-01: newly constructed property with a builder/developer/seller relationship — principal residence only; never re-cast occupancy to fit" }, i.at, actor)];
  if (eligible) out.push(emit(events, i.application_id, "non_arms_length.eligible", { assessment_id: assessment.assessment_id, relationship_kind: i.relationship_kind, value_acceptance_blocked }, i.at, actor));
  const handoffs = { ...(value_acceptance_blocked ? { "24.1": { order_appraisal: true, value_acceptance_blocked: true }, "22.4": { ipc_test_excludes_gift_of_equity_cents: gift } } : {}), ...(eligible ? {} : { "21.6": { disposition, reason: DECLINE_REASON_UNVERIFIABLE } }) };
  return { assessment, events: out, handoffs };
}
export function nonArmsLengthGate(f: Record<string, unknown>): GateResult { return f.eligible === true ? { open: true } : { open: false, reason: "non-arm's-length transaction ineligible (B2-1.3-01) — restructure only with evidence of a primary residence, else decline via 21.6" }; }

// ============================================================ R10 — investigation, SAR and self-report anchors (SM_FRAUD_INVESTIGATION_10BD, SM_SAR_PACKAGE_5BD → 28.4)
export type InvestigationStatus = "opened" | "evidence_gathering" | "concluded" | "handed_off" | "closed";
export type Conclusion = "no_basis" | "insufficient" | "reasonable_basis_misrepresentation" | "reasonable_basis_fraud" | "identity_theft_confirmed";
export type LoanDisposition = "proceed" | "proceed_with_conditions" | "decline_via_o2_6" | "withdraw_by_borrower" | "cancel";
export type SarCategory = "funds_from_illegal_activity" | "evade_bsa_requirements" | "no_apparent_lawful_purpose" | "facilitate_criminal_activity";
export const INVESTIGATION_BUSINESS_DAYS = 10;
export const SAR_PACKAGE_BUSINESS_DAYS = 5;
export const SAR_FILING_DAYS = 30;
export const SAR_NO_SUBJECT_OUTER_LIMIT_DAYS = 60;
export const SAR_THRESHOLD_CENTS = 500_000n;
export const FNMA_SELF_REPORT_DAYS = 30;
export const SAR_ACCESS_ROLES: readonly string[] = ["bsa_officer", "officer", "qc_officer"];
export const REASONABLE_BASIS_CONCLUSIONS: readonly Conclusion[] = ["reasonable_basis_misrepresentation", "reasonable_basis_fraud", "identity_theft_confirmed"];
/** 21.6's approved list — the borrower-facing reasons after a fraud investigation; never a SAR reference. */
export const DECLINE_REASON_UNVERIFIABLE = "information provided cannot be verified";
export const DECLINE_REASON_INCOME_UNVERIFIABLE = "income cannot be verified";
export const HYPOTHESES: readonly string[] = ["identity_theft", "straw_buyer", "occupancy_misrepresentation", "income_fabrication", "asset_fabrication", "undisclosed_ipc_or_silent_second", "appraisal_collusion", "elder_or_affinity_fraud", "money_laundering_emd_gift_payoff"];
export interface Investigation { readonly investigation_id: string; readonly case_id: string; readonly application_id: string; readonly opened_at: string; readonly opened_on: PlainDate; readonly due_on: PlainDate; readonly triggers: readonly string[]; readonly hypotheses: readonly { hypothesis: string; status: "open" | "supported" | "refuted"; note: string | null }[]; readonly evidence_document_ids: readonly string[]; readonly status: InvestigationStatus; readonly conclusion: Conclusion | null; readonly concluded_at: string | null; readonly sar_candidate: boolean; readonly sar_detection_date: PlainDate | null; readonly fnma_self_report_candidate: boolean; readonly ofac_event: boolean; readonly loan_disposition: LoanDisposition | null; readonly amount_cents: bigint | null; readonly subject_identified: boolean | null; readonly sar_category: SarCategory | null; readonly prepared_package_document_id: string | null; readonly reviewer_id: string | null; readonly hold: boolean; }
export function investigationDue(opened_on: PlainDate, cal: Calendar = creditor): PlainDate { return addBusinessDays(opened_on, INVESTIGATION_BUSINESS_DAYS, cal); }
export function openInvestigation(events: EventStore, i: { application_id: string; triggers: readonly string[]; hypotheses: readonly string[]; at: string; case_id?: string | null; place_hold?: boolean; ofac_event?: boolean }, actor: Actor = AGENT): { investigation: Investigation; events: DomainEvent[]; hold: FraudHold | null } {
  nonEmpty(i.application_id, "application_id");
  if (!i.triggers.length) throw new RangeError("an investigation opens on at least one trigger (red flag, integrity check, alert)");
  if (!i.hypotheses.length) throw new RangeError("written hypotheses are required");
  const opened_on = civil(i.at); const case_id = i.case_id ?? randomUUID();
  const investigation: Investigation = { investigation_id: randomUUID(), case_id, application_id: i.application_id, opened_at: i.at, opened_on, due_on: investigationDue(opened_on), triggers: i.triggers, hypotheses: i.hypotheses.map((h) => ({ hypothesis: h, status: "open", note: null })), evidence_document_ids: [], status: "opened", conclusion: null, concluded_at: null, sar_candidate: false, sar_detection_date: null, fnma_self_report_candidate: false, ofac_event: i.ofac_event ?? false, loan_disposition: null, amount_cents: null, subject_identified: null, sar_category: null, prepared_package_document_id: null, reviewer_id: null, hold: i.place_hold ?? true };
  const out = [emit(events, i.application_id, "investigation.opened", { investigation_id: investigation.investigation_id, case_id, case_type: "fraud", opened_at: i.at, opened_on, due_on: investigation.due_on, triggers: i.triggers, hypotheses: i.hypotheses, blocks_ctc: true }, i.at, actor)];
  let hold: FraudHold | null = null;
  if (investigation.hold) { const h = placeHold(events, { application_id: i.application_id, reason: "investigation_open", case_id, at: i.at, detail: { investigation_id: investigation.investigation_id } }, actor); hold = h.hold; out.push(h.event); }
  return { investigation, events: out, hold };
}
export function gatherEvidence(events: EventStore, inv: Investigation, i: { evidence_document_ids: readonly string[]; hypothesis_updates?: readonly { hypothesis: string; status: "open" | "supported" | "refuted"; note: string }[]; channel: "documented_verification_channel" | "borrower_via_app" | "third_party_direct"; at: string }, actor: Actor = AGENT): { investigation: Investigation; event: DomainEvent } {
  if (inv.status !== "opened" && inv.status !== "evidence_gathering") throw new RangeError(`investigation ${inv.investigation_id} is ${inv.status}`);
  if (i.channel === "third_party_direct") throw new ScreeningRefused("NO_UNDOCUMENTED_THIRD_PARTY_CONTACT", "22.6 guardrail: never contacts third parties (employers, sellers, donors) outside documented verification channels", "third parties are contacted only through documented verification channels (22.3 VOE, 22.4 donor letter, 24.4 title)");
  const updates = new Map((i.hypothesis_updates ?? []).map((u) => [u.hypothesis, u]));
  const hypotheses = inv.hypotheses.map((h) => { const u = updates.get(h.hypothesis); return u ? { hypothesis: h.hypothesis, status: u.status, note: u.note } : h; });
  const investigation: Investigation = { ...inv, status: "evidence_gathering", evidence_document_ids: [...new Set([...inv.evidence_document_ids, ...i.evidence_document_ids])], hypotheses };
  const event = emit(events, inv.application_id, "investigation.evidence.gathered", { investigation_id: inv.investigation_id, evidence_document_ids: i.evidence_document_ids, channel: i.channel, hypotheses }, i.at, actor);
  return { investigation, event };
}
/** 31 CFR 1029.320(b)(3): ≤ 30 calendar days after initial detection; +30 when no subject is identified, "in no case" beyond 60. The policy file-by date is the last creditor business day on or before the due date. */
export function sarDeadlines(detection: PlainDate, subject_identified: boolean, cal: Calendar = creditor): { filing_due_on: PlainDate; outer_limit_on: PlainDate; policy_file_by: PlainDate } {
  const filing_due_on = addDays(detection, SAR_FILING_DAYS); const outer_limit_on = addDays(detection, SAR_NO_SUBJECT_OUTER_LIMIT_DAYS);
  return { filing_due_on: subject_identified ? filing_due_on : outer_limit_on, outer_limit_on, policy_file_by: rollBack(subject_identified ? filing_due_on : outer_limit_on, cal) };
}
export function selfReportDue(reasonable_basis_on: PlainDate): PlainDate { return addDays(reasonable_basis_on, FNMA_SELF_REPORT_DAYS); }
export interface ConcludeInput { readonly conclusion: Conclusion; readonly at: string; readonly subject_identified: boolean; readonly amount_cents: bigint; readonly sar_category?: SarCategory | null; readonly loan_disposition: LoanDisposition; readonly fnma_delivered_or_committed?: boolean; readonly rationale: string; readonly reviewer_id?: string | null; }
/**
 * Concluded within the 10-business-day box: `sar_detection_date = concluded_at` when `sar_candidate` (policy Q2 — the review's
 * conclusion is the "initial detection"); the SAR is required when ≥ $5,000 and a §1029.320(a)(2) category applies. Hands 28.4
 * its triggers (`fraud.suspicious.determined{initial_detection_at}`, `fnma.fraud.reasonable_basis{reasonable_basis_at}` — Q6:
 * self-report attempted fraud on undelivered loans when a SAR is prepared).
 */
export function concludeInvestigation(events: EventStore, inv: Investigation, i: ConcludeInput, actor: Actor = AGENT): { investigation: Investigation; events: DomainEvent[]; deadlines: { package_due_on: PlainDate; sar: ReturnType<typeof sarDeadlines>; self_report_due_on: PlainDate } | null; decline_reasons: string[]; escalation: { kind: "underwriting_reviewer"; reason: string } | null } {
  if (inv.status === "concluded" || inv.status === "handed_off" || inv.status === "closed") throw new RangeError(`investigation ${inv.investigation_id} already ${inv.status}`);
  nonEmpty(i.rationale, "rationale"); if (i.amount_cents < 0n) throw new RangeError("amount_cents must be ≥ 0");
  const concluded_on = civil(i.at);
  const reasonable = REASONABLE_BASIS_CONCLUSIONS.includes(i.conclusion);
  const sar_candidate = reasonable && i.amount_cents >= SAR_THRESHOLD_CENTS && !!i.sar_category;
  const sar_detection_date = sar_candidate ? concluded_on : null;
  const fnma_self_report_candidate = reasonable && ((i.fnma_delivered_or_committed ?? false) || sar_candidate);
  const investigation: Investigation = { ...inv, status: "concluded", conclusion: i.conclusion, concluded_at: i.at, sar_candidate, sar_detection_date, fnma_self_report_candidate, loan_disposition: i.loan_disposition, amount_cents: i.amount_cents, subject_identified: i.subject_identified, sar_category: i.sar_category ?? null, reviewer_id: i.reviewer_id ?? null };
  const decline_reasons = i.loan_disposition === "decline_via_o2_6" ? [DECLINE_REASON_UNVERIFIABLE, ...(i.conclusion === "reasonable_basis_misrepresentation" ? [DECLINE_REASON_INCOME_UNVERIFIABLE] : [])] : [];
  for (const r of decline_reasons) assertNoSarTerms(r);
  const out = [emit(events, inv.application_id, "investigation.concluded", { investigation_id: inv.investigation_id, case_id: inv.case_id, conclusion: i.conclusion, concluded_at: i.at, concluded_on, within_sla: concluded_on <= inv.due_on, sar_candidate, sar_detection_date, fnma_self_report_candidate, loan_disposition: i.loan_disposition, subject_identified: i.subject_identified, amount_cents: String(i.amount_cents), decline_reasons, reviewer_required: i.loan_disposition === "decline_via_o2_6" ? "underwriting_reviewer" : null, watchlist: reasonable ? "identity placed on SM's internal watchlist (red_flag_events{category=notice_from_victim_or_le})" : null }, i.at, actor)];
  let deadlines: { package_due_on: PlainDate; sar: ReturnType<typeof sarDeadlines>; self_report_due_on: PlainDate } | null = null;
  if (sar_candidate && sar_detection_date) {
    const sar = sarDeadlines(sar_detection_date, i.subject_identified);
    deadlines = { package_due_on: addBusinessDays(sar_detection_date, SAR_PACKAGE_BUSINESS_DAYS, creditor), sar, self_report_due_on: selfReportDue(concluded_on) };
    out.push(emit(events, inv.application_id, "fraud.suspicious.determined", { investigation_id: inv.investigation_id, case_id: inv.case_id, initial_detection_at: sar_detection_date, subject_identified: i.subject_identified, amount_cents: String(i.amount_cents), category: i.sar_category, filing_due_on: sar.filing_due_on, outer_limit_on: sar.outer_limit_on, owner: "28.4" }, i.at, actor));
  }
  if (fnma_self_report_candidate) out.push(emit(events, inv.application_id, "fnma.fraud.reasonable_basis", { investigation_id: inv.investigation_id, case_id: inv.case_id, reasonable_basis_at: concluded_on, conclusion: i.conclusion, delivered_or_committed: i.fnma_delivered_or_committed ?? false, q6_basis: sar_candidate ? "attempted fraud on an undelivered application with a SAR prepared" : "delivered/committed loan", self_report_due_on: selfReportDue(concluded_on), owner: "28.4" }, i.at, actor));
  const escalation = i.loan_disposition === "decline_via_o2_6" ? { kind: "underwriting_reviewer" as const, reason: `fraud investigation conclusion ${i.conclusion} drives a decline: 21.6 with reasons ${decline_reasons.join(" / ")}` } : null;
  return { investigation, events: out, deadlines, decline_reasons, escalation };
}
export interface SarCandidate { readonly candidate_id: string; readonly investigation_id: string; readonly application_id: string; readonly detection_date: PlainDate; readonly subject_identified: boolean; readonly amount_cents: bigint; readonly category: SarCategory; readonly filing_due_on: PlainDate; readonly outer_limit_on: PlainDate; readonly narrative_draft_document_id: string; readonly exhibit_document_ids: readonly string[]; readonly status: "prepared" | "sent_to_bsa_officer" | "filed" | "declined_by_bsa_officer"; readonly sent_at: string | null; readonly access_roles: readonly string[]; readonly retention_class: "bsa_sar_5y"; }
/** The package for the partner's `bsa_officer` (never filed here): `sar.candidate.prepared` inside SM_SAR_PACKAGE_5BD, an escalation to `bsa_officer`; 28.4's 30-day clock is already running from the conclusion. */
export function prepareSarPackage(events: EventStore, inv: Investigation, i: { narrative_draft_document_id: string; exhibit_document_ids: readonly string[]; narrative_text?: string; at: string }, actor: Actor = AGENT): { candidate: SarCandidate; investigation: Investigation; event: DomainEvent; escalation: { kind: "bsa_officer"; severity: "sev-2"; payload: Record<string, unknown> }; on_time: boolean } {
  if (!inv.sar_candidate || !inv.sar_detection_date || !inv.sar_category || inv.amount_cents === null || inv.subject_identified === null) throw new ScreeningRefused("NOT_A_SAR_CANDIDATE", "22.6 R10", `investigation ${inv.investigation_id} concluded ${inv.conclusion ?? "(open)"} without a SAR basis`);
  nonEmpty(i.narrative_draft_document_id, "narrative_draft_document_id");
  const sar = sarDeadlines(inv.sar_detection_date, inv.subject_identified);
  const candidate: SarCandidate = { candidate_id: randomUUID(), investigation_id: inv.investigation_id, application_id: inv.application_id, detection_date: inv.sar_detection_date, subject_identified: inv.subject_identified, amount_cents: inv.amount_cents, category: inv.sar_category, filing_due_on: sar.filing_due_on, outer_limit_on: sar.outer_limit_on, narrative_draft_document_id: i.narrative_draft_document_id, exhibit_document_ids: i.exhibit_document_ids, status: "sent_to_bsa_officer", sent_at: i.at, access_roles: SAR_ACCESS_ROLES, retention_class: "bsa_sar_5y" };
  const package_due_on = addBusinessDays(inv.sar_detection_date, SAR_PACKAGE_BUSINESS_DAYS, creditor); const on_time = civil(i.at) <= package_due_on;
  const event = emit(events, inv.application_id, "sar.candidate.prepared", { candidate_id: candidate.candidate_id, investigation_id: inv.investigation_id, case_id: inv.case_id, detection_date: inv.sar_detection_date, subject_identified: inv.subject_identified, amount_cents: String(inv.amount_cents), category: inv.sar_category, filing_due_on: sar.filing_due_on, outer_limit_on: sar.outer_limit_on, policy_file_by: sar.policy_file_by, package_due_on, on_time, sent_to: "bsa_officer", access_roles: SAR_ACCESS_ROLES, retention_class: "bsa_sar_5y", confidential: true }, i.at, actor);
  return { candidate, investigation: { ...inv, status: "handed_off", prepared_package_document_id: i.narrative_draft_document_id }, event, escalation: { kind: "bsa_officer", severity: "sev-2", payload: { candidate_id: candidate.candidate_id, investigation_id: inv.investigation_id, filing_due_on: sar.filing_due_on, outer_limit_on: sar.outer_limit_on, sla: "SM_SAR_PACKAGE_5BD → 28.4 BSA_1029_320_SAR_30" } }, on_time };
}
export function prepareSelfReportPackage(events: EventStore, inv: Investigation, i: { content: Partial<Record<(typeof FNMA_SELF_REPORT_ELEMENTS)[number], unknown>>; package_document_id: string; at: string }, actor: Actor = AGENT): { event: DomainEvent; missing_elements: string[]; due_on: PlainDate; escalation: { kind: "officer"; payload: Record<string, unknown> } } {
  if (!inv.fnma_self_report_candidate || !inv.concluded_at) throw new ScreeningRefused("NOT_A_SELF_REPORT_CANDIDATE", "A3-4-03; 22.6 Q6", `investigation ${inv.investigation_id} has no reasonable-basis conclusion for a Fannie Mae self-report`);
  nonEmpty(i.package_document_id, "package_document_id");
  const missing = FNMA_SELF_REPORT_ELEMENTS.filter((k) => i.content[k] === undefined || i.content[k] === null || i.content[k] === "");
  const due_on = selfReportDue(civil(inv.concluded_at));
  const event = emit(events, inv.application_id, "fnma.self_report.candidate.prepared", { investigation_id: inv.investigation_id, case_id: inv.case_id, reasonable_basis_at: civil(inv.concluded_at), self_report_due_on: due_on, elements: FNMA_SELF_REPORT_ELEMENTS, missing_elements: missing, package_document_id: i.package_document_id, channel: "Loan Quality Connect (portal-only; officer / fnma_portal_operator)", sent_to: "officer" }, i.at, actor);
  return { event, missing_elements: [...missing], due_on, escalation: { kind: "officer", payload: { investigation_id: inv.investigation_id, self_report_due_on: due_on, missing_elements: missing } } };
}
export type OfacReportKind = "rejected_transaction" | "blocked_initial" | "unblocking" | "annual_blocked";
export const OFAC_REPORT_ELEMENTS: readonly string[] = ["filer_identity", "transaction_description", "parties", "blocked_or_rejected_person", "property_description_location_value", "date", "actions_taken", "legal_authority"];
export function prepareOfacReport(events: EventStore, i: { application_id: string; screening_id: string; kind: OfacReportKind; event_on: PlainDate; content: Partial<Record<string, unknown>>; package_document_id: string; at: string }, actor: Actor = AGENT): { event: DomainEvent; due_on: PlainDate; missing_elements: string[]; escalation: { kind: "bsa_officer"; payload: Record<string, unknown> } } {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.screening_id, "screening_id"); nonEmpty(i.package_document_id, "package_document_id");
  const due_on = i.kind === "annual_blocked" ? plainDate(`${i.event_on.slice(0, 4)}-09-30`) : ofacReportDue(i.event_on);
  const missing = OFAC_REPORT_ELEMENTS.filter((k) => i.content[k] === undefined || i.content[k] === null || i.content[k] === "");
  const event = emit(events, i.application_id, "ofac.report.package.prepared", { screening_id: i.screening_id, kind: i.kind, event_on: i.event_on, due_on, channel: "OFAC Reporting System (ORS) — filed by the bsa_officer (28.4)", elements: OFAC_REPORT_ELEMENTS, missing_elements: missing, package_document_id: i.package_document_id, retention_class: "ofac_records_10y", sent_to: "bsa_officer" }, i.at, actor);
  return { event, due_on, missing_elements: [...missing], escalation: { kind: "bsa_officer", payload: { screening_id: i.screening_id, kind: i.kind, due_on } } };
}
/** 28.4's return path closes the loop: `sar.filed`, `fnma.fraud.report.submitted`, `ofac.report.submitted{kind}` (28.4's names — never emitted here). */
export const RETURN_PATH_EVENTS: readonly string[] = ["sar.filed", "fnma.fraud.report.submitted", "ofac.report.submitted"];
export function closeInvestigationLoop(events: EventStore, inv: Investigation, e: DomainEvent, actor: Actor = AGENT): { investigation: Investigation; event: DomainEvent | null } {
  if (!RETURN_PATH_EVENTS.includes(e.type)) return { investigation: inv, event: null };
  if (e.actor.kind !== "human") throw new ScreeningRefused("FILING_IS_A_HUMAN_ACT", "22.6 guardrail: never files a SAR, OFAC report or Fannie Mae self-report (humans do — 28.4)", `${e.type} must be recorded by the filing human, not ${e.actor.kind}:${e.actor.id}`);
  const investigation: Investigation = { ...inv, status: "closed" };
  const event = emit(events, inv.application_id, "investigation.loop_closed", { investigation_id: inv.investigation_id, case_id: inv.case_id, closed_by_event: e.type, closed_by: `${e.actor.kind}:${e.actor.id}${e.actor.role ? ` (${e.actor.role})` : ""}` }, e.occurredAt, actor);
  return { investigation, event };
}

// ============================================================ R11 — SAR confidentiality; holds; screening state; decision record
export const SAR_TERM_PATTERNS: readonly RegExp[] = [/\bSAR\b/, /\bSARs\b/, /suspicious[- ]activity report/i, /\bFinCEN\b/i, /\bBSA\b/, /bank secrecy act/i, /sar_candidates?/i, /\bsars\b/];
export function scrubSarTerms(text: string): { clean: boolean; findings: string[] } { const findings = SAR_TERM_PATTERNS.map((p) => p.exec(text)?.[0] ?? null).filter((m): m is string => m !== null); return { clean: !findings.length, findings }; }
/** Every borrower-facing channel (portal, notices, AI voice, adverse-action reasons, servicing notes) is scrubbed before 21.6 renders. */
export function assertNoSarTerms(text: string): void { const r = scrubSarTerms(text); if (!r.clean) throw new ScreeningRefused("SAR_CONFIDENTIALITY", "31 CFR 1029.320(d); 22.6 R11", `borrower-facing text references ${r.findings.join(", ")} — rejected before rendering`); }
export function sarAccessAllowed(role: string | null | undefined, actor: Actor): boolean { return actor.kind === "agent" ? actor.id === "fraud-risk" : !!role && SAR_ACCESS_ROLES.includes(role); }

export const HOLD_BLOCKED_COMMANDS = ["submitDu", "issueCD", "consummate", "funding.authorized"] as const;
export type HoldBlockedCommand = (typeof HOLD_BLOCKED_COMMANDS)[number];
export type HoldReason = "ofac_match_true" | "investigation_open" | "occupancy_inconsistent" | "fraud_tool_high_alert" | "identity_failed";
export interface FraudHold { readonly application_id: string; readonly fraud_hold: true; readonly reason: HoldReason; readonly case_id: string | null; readonly placed_at: string; readonly blocks: readonly HoldBlockedCommand[]; readonly release_requires: "concluded_investigation" | "bsa_officer"; }
export function placeHold(events: EventStore, i: { application_id: string; reason: HoldReason; case_id: string | null; at: string; detail?: Record<string, unknown> }, actor: Actor = AGENT): { hold: FraudHold; event: DomainEvent } {
  nonEmpty(i.application_id, "application_id");
  const hold: FraudHold = { application_id: i.application_id, fraud_hold: true, reason: i.reason, case_id: i.case_id, placed_at: i.at, blocks: HOLD_BLOCKED_COMMANDS, release_requires: i.reason === "ofac_match_true" ? "bsa_officer" : "concluded_investigation" };
  const event = emit(events, i.application_id, "fraud.hold.placed", { reason: i.reason, case_id: i.case_id, blocks: HOLD_BLOCKED_COMMANDS, release_requires: hold.release_requires, ...(i.detail ?? {}) }, i.at, actor);
  return { hold, event };
}
/** Any command on the blocked list refuses while the hold is on; the agent never bypasses it. */
export function assertNoFraudHold(hold: { fraud_hold: boolean; reason?: string | null } | null | undefined, command: string): void {
  if (hold?.fraud_hold && (HOLD_BLOCKED_COMMANDS as readonly string[]).includes(command)) throw new FraudHoldBlocked(command, hold.reason ?? "fraud_hold");
}
export function releaseHold(events: EventStore, hold: FraudHold, i: { investigation: Pick<Investigation, "investigation_id" | "status" | "conclusion"> | null; actor: Actor; at: string; rationale: string }): { event: DomainEvent; released: true } {
  nonEmpty(i.rationale, "rationale");
  if (hold.release_requires === "bsa_officer") { if (!(i.actor.kind === "human" && i.actor.role === "bsa_officer")) throw new ScreeningRefused("OFAC_HOLD_RELEASE_BSA_OFFICER", "22.6 state machine: released by the bsa_officer for OFAC matches", "an OFAC hold is released only by the bsa_officer"); }
  else if (!i.investigation || i.investigation.status === "opened" || i.investigation.status === "evidence_gathering" || !i.investigation.conclusion) throw new ScreeningRefused("HOLD_RELEASE_NEEDS_CONCLUDED_INVESTIGATION", "22.6 AI design: releases holds only on a concluded investigation", "the hold stays until investigation.concluded");
  const event = emit(events, hold.application_id, "fraud.hold.released", { reason: hold.reason, case_id: hold.case_id, released_by: `${i.actor.kind}:${i.actor.id}${i.actor.role ? ` (${i.actor.role})` : ""}`, investigation_id: i.investigation?.investigation_id ?? null, conclusion: i.investigation?.conclusion ?? null, rationale: i.rationale }, i.at, i.actor);
  return { event, released: true };
}
export type ScreeningStatus = "screening_open" | "screening_clear" | "rescreen_due" | "screening_final";
/** Application-level state: screening_clear when every gate is open; rescreen_due on a party change or the pre-closing checkpoint; screening_final at consummation. */
export function screeningStatus(f: { identity: GateResult; ssn: GateResult; legal_presence: GateResult; ofac: GateResult; fraud_tool: GateResult; occupancy_reo: GateResult; non_arms_length: GateResult; rescreen_due?: boolean; consummated?: boolean }): { status: ScreeningStatus; closed: string[] } {
  const closed = Object.entries(f).filter(([k, v]) => typeof v === "object" && v !== null && "open" in v && !(v as GateResult).open).map(([k, v]) => `${k}: ${(v as GateResult).reason ?? "closed"}`);
  if (closed.length) return { status: "screening_open", closed };
  if (f.consummated) return { status: "screening_final", closed: [] };
  return { status: f.rescreen_due ? "rescreen_due" : "screening_clear", closed: [] };
}
export function finalizeScreening(events: EventStore, i: { application_id: string; status: ScreeningStatus; at: string }, actor: Actor = AGENT): DomainEvent { return emit(events, i.application_id, "screening.finalized", { status: i.status }, i.at, actor); }
export interface FraudRiskDecision { readonly application_id: string; readonly subject: { kind: string; id: string }; readonly screening_results: Record<string, unknown>; readonly identity_scores: Record<string, unknown>; readonly ssn_resolution_path: string | null; readonly legal_presence_rationale: string; readonly occupancy: { signals: unknown; score: number | null } | null; readonly reo_findings: unknown; readonly non_arms_length: unknown; readonly red_flags: unknown; readonly investigation: unknown; readonly sar_candidate_rationale: string | null; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly rationale: string; readonly confidence: number; }
export function decisionRecord(i: Omit<FraudRiskDecision, "rule_set_version" | "legal_presence_rationale"> & { legal_presence_rationale?: string }): FraudRiskDecision {
  nonEmpty(i.application_id, "application_id"); nonEmpty(i.rationale, "rationale"); nonEmpty(i.model_version, "model_version"); nonEmpty(i.prompt_version, "prompt_version");
  if (!(i.confidence >= 0 && i.confidence <= 1)) throw new RangeError("confidence must be within [0, 1]");
  if (i.sar_candidate_rationale) assertNoSarTerms(JSON.stringify(i.screening_results));
  assertNoDemographicInputs(Object.keys(i.screening_results));
  return { ...i, legal_presence_rationale: i.legal_presence_rationale ?? REGB_6B7_RATIONALE, rule_set_version: RULE_SET_VERSION };
}

// ============================================================ Fakes (tests and the bus without vendor contracts)
export class FakeIdentityVendor implements IdentityVendorPort {
  readonly sessions: { borrower_id: string; method: IdentityMethod }[] = [];
  private readonly results: Record<string, IdentitySessionResult | ((method: IdentityMethod) => IdentitySessionResult)>;
  constructor(results: Record<string, IdentitySessionResult | ((method: IdentityMethod) => IdentitySessionResult)>) { this.results = results; }
  async verify(req: { borrower_id: string; method: IdentityMethod }): Promise<IdentitySessionResult> { this.sessions.push({ borrower_id: req.borrower_id, method: req.method }); const r = this.results[req.borrower_id]; if (!r) throw new RangeError(`no identity session scripted for ${req.borrower_id}`); return typeof r === "function" ? r(req.method) : r; }
}
export const identityPass = (session_id: string, o: Partial<IdentitySessionResult> = {}): IdentitySessionResult => ({ session_id, vendor: "identity-vendor", document_authentication_result: "pass", liveness_result: "pass", face_match_score: 0.97, face_match_threshold: 0.9, id_document_type: "drivers_license", id_document_issuer: "OH", id_document_expires_on: plainDate("2029-06-30"), data_match: { name: true, dob: true, address: true }, ...o });
export const identityInconclusive = (session_id: string, o: Partial<IdentitySessionResult> = {}): IdentitySessionResult => ({ ...identityPass(session_id), liveness_result: "inconclusive", face_match_score: null, ...o });
export class FakeCbsv implements CbsvPort {
  readonly requests: { borrower_id: string; ssa_89_document_id: string }[] = [];
  private readonly responses: Record<string, Omit<CbsvResponse, "request_id">>;
  constructor(responses: Record<string, Omit<CbsvResponse, "request_id">> = {}) { this.responses = responses; }
  async verify(req: { borrower_id: string; ssa_89_document_id: string }): Promise<CbsvResponse> { this.requests.push({ borrower_id: req.borrower_id, ssa_89_document_id: req.ssa_89_document_id }); const r = this.responses[req.borrower_id] ?? { match: true, death_indicator: false }; return { request_id: `CBSV-${this.requests.length}`, ...r }; }
}
export class FakeOfacScreener implements OfacScreenerPort {
  readonly screens: { party_id: string; versions: string[] }[] = [];
  private readonly hits: Record<string, OfacCandidate[]>;
  constructor(hits: Record<string, OfacCandidate[]> = {}) { this.hits = hits; }
  async screen(party: PartyIdentity, lists: readonly ListVersion[]): Promise<{ candidates: OfacCandidate[] }> { this.screens.push({ party_id: party.party_id, versions: lists.map((l) => l.version) }); return { candidates: this.hits[party.party_id] ?? [] }; }
}
export class FakeFraudTool implements FraudToolPort {
  readonly runs: { application_id: string; refresh: boolean }[] = [];
  private readonly alerts: readonly FraudToolAlert[]; private readonly score: number | null;
  constructor(alerts: readonly FraudToolAlert[] = [], score: number | null = 12) { this.alerts = alerts; this.score = score; }
  async run(req: { application_id: string; refresh: boolean }): Promise<Omit<FraudReport, "run_at">> { this.runs.push({ application_id: req.application_id, refresh: req.refresh }); return { report_id: `DRIVE-${req.application_id}-${this.runs.length}`, vendor: "DataVerify DRIVE", score: this.score, alerts: this.alerts }; }
}
export class FakeMers implements MersPort {
  private readonly results: { min: string; property: string; vested_name: string }[];
  constructor(results: { min: string; property: string; vested_name: string }[] = []) { this.results = results; }
  async minSearch(): Promise<{ min: string; property: string; vested_name: string }[]> { return this.results; }
}
