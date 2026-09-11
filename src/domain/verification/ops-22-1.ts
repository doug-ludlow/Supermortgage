/**
 * §22.1 operating rules — document intake, classification, extraction, the integrity battery, the two freshness
 * engines (B1-1-03 four-month rule at the note date; B3-3.2-01 paystub floor at the initial application date; the
 * B1-1-03 tax-year table), the borrower needs-list loop and the retention-class transitions. Pure functions over the
 * application aggregate's documents; every state change is an appended event keyed by `applicationId` (the origination
 * context src/kernel/timers/engine.ts arms 22.1's clocks on). Nothing here alters a document — only derived data is
 * created (AI-design guardrail) — and nothing contacts a borrower except through the Notice Registry (22.1 outputs).
 *
 * Events (timer subject = the application):
 *   document.received{document_id, request_id|null, received_at, source_channel, sha256}      arms SM_NEEDS_LIST_REVIEW_1BD; satisfies SM_NEEDS_LIST_BORROWER_RESPONSE_5 when request_id is set
 *   document.quarantined{document_id, reason, prompt}                                          e-mail sender authentication failed / non-applicant subject (T11)
 *   document.classified{document_id, doc_class, doc_family, is_credit_document, confidence}    arms FNMA_B3_3_2_01_PAYSTUB_30D_GATE (paystub) and FNMA_B1_1_03_TAX_YEAR_GATE (tax family)
 *   document.extracted{document_id, doc_class, document_date, expires_at, freshness_status, scheduled_note_date}   arms FNMA_B1_1_03_CREDIT_DOCS_4M and SM_DOC_EXPIRY_WARN_14
 *   document.integrity.flagged | .cleared | .failed{document_id, checks, aggregate}             failed → underwriting_reviewer escalation + 22.6 fraud-case candidate
 *   document.superseded{document_id, supersedes_document_id}                                    satisfies SM_DOC_EXPIRY_WARN_14 (replacement received)
 *   document.expiring{document_id, expires_at, scheduled_note_date} / document.expired{…}
 *   document_request.opened{request_id, requested_at, due_at, borrower_id, doc_class, qualifier, reason_code, reason_text}   arms SM_NEEDS_LIST_BORROWER_RESPONSE_5
 *   document_request.reminded{request_id, reminder_no, sent_on} / .satisfied{request_id, document_id} / .waived{request_id, waived_by, reference} / .expired{request_id, reason}
 *   needs_list.queued{batch_id, request_ids, reason} / needs_list.sent{batch_id, notice_id, request_ids}
 *   condition.clear.proposed{condition_id, request_id, document_id}                             23.3 accepts or refuses
 *   document.retention.assigned{document_id, retention_classes, anchor, purge_eligible_on}
 */
import { type PlainDate, addDays, addMonths, daysBetween, parts, plainDate as D, ymd } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor, type Calendar } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";

export const AGENT: Actor = { kind: "agent", id: "verification" };
export const RULE_SET_VERSION = "fnma.selling.2026-09-02";
/** Creditor time zone of the refinance fixture (Phoenix; MST all year). */
export const CREDITOR_TZ = "America/Phoenix";

// ============================================================ reference data: document_classes
export type DocFamily = "identity" | "income_employment" | "tax" | "assets" | "liabilities" | "property_purchase" | "insurance" | "hoa_project" | "trust_entity" | "letters" | "credit" | "valuation" | "title" | "closing" | "other";
export type FreshnessBasis = "b1_1_03_4m" | "b3_3_2_01_paystub_30d" | "b1_1_03_tax_year_table" | "b4_1_2_04_appraisal" | "du_validation_vendor_age" | "none";
export type FreshnessStatus = "fresh" | "expiring" | "expired" | "n_a";
export type IntegrityStatus = "pending" | "passed" | "flagged" | "failed" | "not_applicable";
export type SourceChannel = "borrower_upload" | "borrower_email" | "borrower_mail_scan" | "vendor_delivery" | "agent_generated" | "partner_upload" | "fnma_delivery";
export type RetentionClass = "regb_25m" | "regz_atr_3y" | "fnma_loan_file_life_plus_4y" | "esign_consent_life" | "bsa_sar_5y" | "irs_ives_2y" | "ssa_89_5y";
export type DocumentState = "received" | "classifying" | "classified" | "unclassified" | "extracting" | "extracted" | "integrity_checking" | "accepted" | "flagged" | "failed" | "linked" | "superseded" | "expired" | "retained" | "quarantined";
export type RequestStatus = "open" | "reminded" | "received" | "under_review" | "satisfied" | "waived" | "expired" | "cancelled";

export interface DocumentClass { readonly code: string; readonly family: DocFamily; readonly default_freshness_basis: FreshnessBasis; readonly default_retention_class: RetentionClass; readonly extraction_schema_version: string; readonly is_credit_document: boolean; }
const cls = (family: DocFamily, basis: FreshnessBasis, credit: boolean, codes: readonly string[], schema = "2026-09"): DocumentClass[] =>
  codes.map((code) => ({ code, family, default_freshness_basis: basis, default_retention_class: "regb_25m", extraction_schema_version: schema, is_credit_document: credit }));
/** Data-model "Initial codes" (open question 3: W-2/1099/returns are governed by the one-/two-year and tax-year rules, not the four-month rule). */
export const DOCUMENT_CLASSES: readonly DocumentClass[] = [
  ...cls("identity", "none", false, ["drivers_license", "passport", "state_id", "ssn_card", "permanent_resident_card", "ead", "itin_letter"]),
  ...cls("income_employment", "b3_3_2_01_paystub_30d", true, ["paystub"]),
  ...cls("income_employment", "b1_1_03_tax_year_table", true, ["w2", "form_1099"]),
  ...cls("income_employment", "b1_1_03_4m", true, ["form_1005_voe", "employment_offer", "military_les", "ssa_award_letter", "pension_award_letter", "disability_award_letter", "leave_confirmation"]),
  ...cls("income_employment", "du_validation_vendor_age", true, ["vvoe_record"]),
  ...cls("income_employment", "none", false, ["divorce_decree", "support_order"]),
  ...cls("tax", "b1_1_03_tax_year_table", true, ["form_1040", "schedule_c", "schedule_e", "schedule_k1", "form_1065", "form_1120", "form_1120s", "irs_return_transcript", "irs_wage_income_transcript"]),
  ...cls("tax", "none", false, ["form_4506c", "form_8821", "form_4868"]),
  ...cls("assets", "b1_1_03_4m", true, ["bank_statement", "brokerage_statement", "retirement_statement", "form_1006_vod", "gift_transfer_evidence", "emd_evidence", "asset_sale_evidence"]),
  ...cls("assets", "du_validation_vendor_age", true, ["voa_report"]),
  ...cls("assets", "none", false, ["gift_letter"]),
  ...cls("liabilities", "b1_1_03_4m", true, ["mortgage_statement", "heloc_statement", "student_loan_statement", "payoff_statement", "irs_installment_agreement"]),
  ...cls("property_purchase", "none", false, ["purchase_contract", "contract_addendum", "lease_agreement", "form_1007", "form_1025"]),
  ...cls("insurance", "none", false, ["homeowners_policy", "flood_policy", "condo_master_policy", "ho6_policy"]),
  ...cls("hoa_project", "none", false, ["hoa_questionnaire", "hoa_budget", "hoa_dues_statement", "project_docs"]),
  ...cls("trust_entity", "none", false, ["trust_agreement", "trust_certification"]),
  ...cls("letters", "b1_1_03_4m", true, ["explanation_letter", "inquiry_explanation", "occupancy_letter"]),
  ...cls("credit", "b1_1_03_4m", true, ["credit_report", "credit_refresh_report"]),
  ...cls("valuation", "b4_1_2_04_appraisal", false, ["appraisal_report", "form_1004d_update", "desktop_appraisal", "pdc_report"]),
  ...cls("title", "none", false, ["title_commitment", "title_policy"]),
  ...cls("closing", "none", false, ["closing_disclosure", "note", "security_instrument"]),
  ...cls("other", "none", false, ["unclassified", "fnma_loan_purchase_letter"]),   // the borrower's forwarded Fannie Mae loan purchase letter (30.4 HO-009 / 25.4 §1026.39 evidence; 32.7 T13)
];
const BY_CODE = new Map(DOCUMENT_CLASSES.map((c) => [c.code, c]));
export function documentClass(code: string): DocumentClass {
  const c = BY_CODE.get(code);
  if (!c) throw new RangeError(`doc_class ${JSON.stringify(code)} is not a document_classes code`);
  return c;
}
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const cents = (v: unknown): bigint => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** Civil date of an ISO instant in the creditor's zone (a Saturday upload in Phoenix is a Saturday receipt). */
export const civilDate = (iso: string, tz = CREDITOR_TZ): PlainDate => wallClock(Date.parse(iso), tz).date;
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
/** The spec's date style in borrower-facing request text: "Sept 5, 2026". */
export function shortDate(d: PlainDate): string { const p = parts(d); return `${MONTHS_SHORT[p.m - 1]} ${p.d}, ${p.y}`; }

// ============================================================ records
export interface DocumentRecord {
  document_id: string; application_id: string; doc_class: string; doc_subclass: string | null; classification_confidence: number | null; classifier_version: string | null; classification_passes: number;
  source_channel: SourceChannel; sender_identity: Record<string, unknown>; received_at: string; document_date: PlainDate | null; period_start: PlainDate | null; period_end: PlainDate | null;
  issuer_name: string | null; subject_borrower_id: string | null; sha256: string; page_count: number; integrity_status: IntegrityStatus; freshness_basis: FreshnessBasis; freshness_status: FreshnessStatus; expires_at: PlainDate | null;
  supersedes_document_id: string | null; retention_classes: RetentionClass[]; retention_anchor: PlainDate | null; purge_eligible_on: PlainDate | null; pii_flags: string[]; legal_hold: boolean; status: DocumentState; request_ids: string[]; fields: Record<string, unknown> | null;
  /** The document is the only evidence of a qualifying fact (R5 aggregation: one warn → flagged). */
  sole_evidence: boolean;
}
export interface Extraction { readonly extraction_id: string; readonly document_id: string; readonly schema_version: string; readonly fields: Record<string, unknown>; readonly field_confidence: Record<string, number>; readonly extractor_version: string; readonly ocr_engine: string | null; readonly human_verified: boolean; readonly created_at: string; }
export type CheckType = "pdf_metadata" | "font_layout" | "arithmetic" | "running_balance" | "template_match" | "even_dollar" | "cross_document" | "vendor_fraud_score" | "sender_authentication" | "source_verification";
export type CheckResult = "pass" | "warn" | "fail" | "n_a";
export interface IntegrityCheck { readonly check_type: CheckType; readonly result: CheckResult; readonly score: number | null; readonly details: Record<string, unknown>; readonly vendor: string | null; readonly rule_set_version: string; }
export interface DocumentRequest {
  request_id: string; application_id: string; condition_id: string | null; borrower_id: string; doc_class: string; qualifier: Record<string, unknown>; reason_code: string; reason_text: string;
  requested_at: string; due_at: PlainDate; reminder_dates: PlainDate[]; noia_evaluation_on: PlainDate; status: RequestStatus; satisfied_by_document_id: string | null; waived_by: string | null; waiver_reference: string | null;
  reminder_count: number; reminders_sent_on: PlainDate[]; channel_used: string[]; notice_ids: string[]; received_document_id: string | null; verifying_document: boolean;
}

const append = (events: EventStore, type: string, applicationId: string, payload: Record<string, unknown>, actor: Actor = AGENT, occurredAt?: string): DomainEvent =>
  events.append({ type, applicationId, actor, payload: { application_id: applicationId, source: "origination", ...payload }, ...(occurredAt ? { occurredAt } : {}) });

// ============================================================ R9 retention
/** At intake every application document carries the Reg B minimum (§1002.12(b)(1)). */
export const RETENTION_AT_INTAKE: RetentionClass = "regb_25m";
export const REGB_RETENTION_MONTHS = 25;
/** Denied/withdrawn: `regb_25m` runs from the notification date (21.6 event) — purge eligible 25 months later unless `legal_hold`. */
export function withdrawalRetention(notified_on: PlainDate): { retention_class: RetentionClass; anchor: PlainDate; purge_eligible_on: PlainDate } {
  return { retention_class: "regb_25m", anchor: notified_on, purge_eligible_on: addMonths(notified_on, REGB_RETENTION_MONTHS) };
}
/** `loan.funded`: the whole file becomes `fnma_loan_file_life_plus_4y` (A2-4.1-02); the ATR evidence set additionally `regz_atr_3y` (§1026.25(c)(3), 23.4). */
export function applyFundingRetention(events: EventStore, docs: readonly DocumentRecord[], f: { application_id: string; funded_on: PlainDate; atr_evidence_document_ids: readonly string[]; esign_consent_document_ids?: readonly string[] }, actor: Actor = AGENT): DocumentRecord[] {
  const atr = new Set(f.atr_evidence_document_ids), esign = new Set(f.esign_consent_document_ids ?? []);
  return docs.map((d) => {
    const classes = new Set<RetentionClass>(d.retention_classes); classes.add("fnma_loan_file_life_plus_4y");
    if (atr.has(d.document_id)) classes.add("regz_atr_3y");
    if (esign.has(d.document_id)) classes.add("esign_consent_life");
    const next: DocumentRecord = { ...d, retention_classes: [...classes], retention_anchor: f.funded_on, purge_eligible_on: null, status: d.status === "failed" || d.status === "superseded" || d.status === "expired" ? d.status : "retained" };
    append(events, "document.retention.assigned", f.application_id, { document_id: d.document_id, retention_classes: next.retention_classes, anchor: f.funded_on, purge_eligible_on: null, trigger: "loan.funded" }, actor);
    return next;
  });
}
/** `decision.issued{denial|withdrawal}` / 21.6 notification: retention from the notification date; open requests expire. */
export function applyWithdrawalRetention(events: EventStore, docs: readonly DocumentRecord[], f: { application_id: string; notified_on: PlainDate }, actor: Actor = AGENT): DocumentRecord[] {
  const r = withdrawalRetention(f.notified_on);
  return docs.map((d) => {
    const next: DocumentRecord = { ...d, retention_classes: [...new Set<RetentionClass>([...d.retention_classes, r.retention_class])], retention_anchor: r.anchor, purge_eligible_on: d.legal_hold ? null : r.purge_eligible_on };
    append(events, "document.retention.assigned", f.application_id, { document_id: d.document_id, retention_classes: next.retention_classes, anchor: r.anchor, purge_eligible_on: next.purge_eligible_on, trigger: "decision.issued", legal_hold: d.legal_hold }, actor);
    return next;
  });
}

// ============================================================ intake (ingestDocument)
export interface EmailAuthentication { readonly spf: "pass" | "fail" | "none"; readonly dkim: "pass" | "fail" | "none"; readonly dmarc_aligned: boolean; readonly sender_verified: boolean; }
/** R5 `sender_authentication`: SPF/DKIM/DMARC alignment with the borrower's verified address or a contracted vendor domain; otherwise quarantine and redirect to the portal (open question 4). */
export function senderAuthenticationCheck(a: EmailAuthentication | null): IntegrityCheck {
  if (!a) return { check_type: "sender_authentication", result: "n_a", score: null, details: { reason: "not an e-mail intake" }, vendor: null, rule_set_version: RULE_SET_VERSION };
  const ok = a.spf === "pass" && a.dkim === "pass" && a.dmarc_aligned && a.sender_verified;
  return { check_type: "sender_authentication", result: ok ? "pass" : "fail", score: null, details: { spf: a.spf, dkim: a.dkim, dmarc_aligned: a.dmarc_aligned, sender_verified: a.sender_verified }, vendor: null, rule_set_version: RULE_SET_VERSION };
}
export interface IngestInput {
  readonly document_id: string; readonly application_id: string; readonly source_channel: SourceChannel; readonly sender_identity?: Record<string, unknown>; readonly received_at: string; readonly sha256: string; readonly page_count?: number;
  readonly declared_class?: string | null; readonly subject_borrower_id?: string | null; readonly applicant_borrower_ids?: readonly string[]; readonly request_id?: string | null; readonly email_authentication?: EmailAuthentication | null; readonly pii_flags?: readonly string[];
  /** A prior document with the same hash on the application: linked, never re-processed (edge cases). */
  readonly existing?: readonly DocumentRecord[];
}
export interface IngestResult { readonly doc: DocumentRecord; readonly event: DomainEvent; readonly quarantined: boolean; readonly quarantine_reason: string | null; readonly portal_upload_prompt: boolean; readonly duplicate_of: string | null; readonly checks: IntegrityCheck[]; }
/**
 * `document.received` for a borrower/vendor/partner intake: retention `regb_25m` at intake; e-mail attachments must pass sender
 * authentication (T11: failed DMARC → `integrity_status = failed`, `sender_authentication = fail`, no request satisfied, portal prompt);
 * a document for a person who is not an applicant is quarantined (guardrail); a duplicate hash is linked, not re-processed.
 */
export function ingestDocument(events: EventStore, i: IngestInput, actor: Actor = AGENT): IngestResult {
  nonEmpty(i.document_id, "document_id"); nonEmpty(i.application_id, "application_id"); nonEmpty(i.sha256, "sha256"); nonEmpty(i.received_at, "received_at");
  const dup = (i.existing ?? []).find((d) => d.sha256 === i.sha256 && d.application_id === i.application_id) ?? null;
  const base: DocumentRecord = {
    document_id: i.document_id, application_id: i.application_id, doc_class: i.declared_class ?? "unclassified", doc_subclass: null, classification_confidence: null, classifier_version: null, classification_passes: 0,
    source_channel: i.source_channel, sender_identity: i.sender_identity ?? {}, received_at: i.received_at, document_date: null, period_start: null, period_end: null, issuer_name: null, subject_borrower_id: i.subject_borrower_id ?? null,
    sha256: i.sha256, page_count: i.page_count ?? 0, integrity_status: "pending", freshness_basis: "none", freshness_status: "n_a", expires_at: null, supersedes_document_id: null, retention_classes: [RETENTION_AT_INTAKE], retention_anchor: civilDate(i.received_at), purge_eligible_on: null,
    pii_flags: [...(i.pii_flags ?? [])], legal_hold: false, status: "received", request_ids: i.request_id ? [i.request_id] : [], fields: null, sole_evidence: false,
  };
  const checks: IntegrityCheck[] = [];
  let reason: string | null = null;
  if (i.source_channel === "borrower_email") { const c = senderAuthenticationCheck(i.email_authentication ?? null); checks.push(c); if (c.result === "fail") reason = "sender_authentication"; }
  if (!reason && i.subject_borrower_id && i.applicant_borrower_ids && !i.applicant_borrower_ids.includes(i.subject_borrower_id)) reason = "non_applicant";
  if (reason) {
    const doc: DocumentRecord = { ...base, integrity_status: "failed", status: "quarantined", request_ids: [] };
    const event = append(events, "document.quarantined", i.application_id, { document_id: doc.document_id, reason, sender_authentication: reason === "sender_authentication" ? "fail" : "n_a", prompt: reason === "sender_authentication" ? "portal_upload" : "privacy_incident_check_31_3", request_id: null, delete_after_days: reason === "non_applicant" ? 30 : null }, actor, i.received_at);
    return { doc, event, quarantined: true, quarantine_reason: reason, portal_upload_prompt: reason === "sender_authentication", duplicate_of: null, checks };
  }
  const doc: DocumentRecord = dup ? { ...base, doc_class: dup.doc_class, status: "linked", request_ids: [...new Set([...dup.request_ids, ...base.request_ids])] } : base;
  const event = append(events, "document.received", i.application_id, { document_id: doc.document_id, request_id: i.request_id ?? null, received_at: i.received_at, source_channel: i.source_channel, sha256: i.sha256, duplicate_of: dup?.document_id ?? null, declared_class: i.declared_class ?? null }, actor, i.received_at);
  return { doc, event, quarantined: false, quarantine_reason: null, portal_upload_prompt: false, duplicate_of: dup?.document_id ?? null, checks };
}

// ============================================================ classification
export const CLASSIFIER_CONFIDENCE_FLOOR = 0.85;
export interface ClassifyInput { readonly doc_class: string; readonly confidence: number; readonly classifier_version: string; readonly doc_subclass?: string | null; readonly ocr_dpi?: number; readonly borrower_declared?: boolean; }
/** `document.classified{doc_class, doc_family}`: below the per-class floor the document is `unclassified`; a second pass runs at 400 dpi; still unclassified after the borrower's answer → `human_agent` queue. */
export function classifyDocument(events: EventStore, doc: DocumentRecord, c: ClassifyInput, actor: Actor = AGENT, at = doc.received_at): { doc: DocumentRecord; event: DomainEvent; next_step: "extract" | "second_pass_400dpi" | "ask_borrower" | "human_agent" } {
  const klass = documentClass(c.doc_class);
  const passes = doc.classification_passes + 1;
  const confident = c.borrower_declared === true || (c.confidence >= CLASSIFIER_CONFIDENCE_FLOOR && klass.code !== "unclassified");
  const next: DocumentRecord = { ...doc, doc_class: confident ? klass.code : "unclassified", doc_subclass: c.doc_subclass ?? null, classification_confidence: c.confidence, classifier_version: c.classifier_version, classification_passes: passes,
    freshness_basis: confident ? klass.default_freshness_basis : "none", status: confident ? "classified" : "unclassified" };
  const next_step = confident ? "extract" : passes === 1 ? "second_pass_400dpi" : passes === 2 ? "ask_borrower" : "human_agent";
  const event = append(events, "document.classified", doc.application_id, { document_id: doc.document_id, doc_class: next.doc_class, doc_family: confident ? klass.family : "other", is_credit_document: confident && klass.is_credit_document, confidence: c.confidence, classifier_version: c.classifier_version, pass: passes, status: next.status, next_step, borrower_declared: c.borrower_declared === true }, actor, at);
  return { doc: next, event, next_step };
}

// ============================================================ R1 document date · R2 freshness
/** R1: the date the document bears, by class (open question 2: statements use the closing date `period_end`). */
export function documentDate(doc_class: string, f: Record<string, unknown>): PlainDate | null {
  const d = (k: string): PlainDate | null => (isDate(f[k]) ? D(String(f[k])) : null);
  switch (documentClass(doc_class).family) {
    case "income_employment":
      if (doc_class === "paystub") return d("pay_date") ?? d("pay_period_end");
      if (doc_class === "w2" || doc_class === "form_1099") { const y = Number(f.tax_year); return Number.isInteger(y) ? ymd(y, 12, 31) : null; }
      if (doc_class === "form_1005_voe") return d("verifier_signed_on");
      if (doc_class === "vvoe_record") return d("report_generated_on") ?? d("verified_on");
      return d("signed_on") ?? d("issued_on") ?? d("document_date");
    case "assets":
      if (doc_class === "form_1006_vod") return d("verifier_signed_on");
      if (doc_class === "voa_report") return d("report_generated_on");
      if (doc_class === "gift_letter") return d("signed_on");
      return d("period_end") ?? d("statement_date");
    case "liabilities": return d("period_end") ?? d("statement_date");
    case "tax": { const y = Number(f.tax_year); return Number.isInteger(y) ? ymd(y, 12, 31) : d("document_date"); }
    case "letters": return d("signed_on");
    case "credit": return d("report_date");
    case "valuation": return d("effective_date");
    default: return null;   // identity (22.6 expiry rules), purchase contract, insurance, HOA, trust, title, closing: n/a
  }
}
export const CREDIT_DOC_AGE_MONTHS = 4;
export const DOC_EXPIRY_WARN_DAYS = 14;
export interface Freshness { readonly basis: FreshnessBasis; readonly document_date: PlainDate | null; readonly expires_at: PlainDate | null; readonly note_date: PlainDate | null; readonly status: FreshnessStatus; readonly warn_on: PlainDate | null; }
/**
 * R2 (B1-1-03): `expires_at = add_months(document_date, 4)` (end-of-month clamp; open question 1) and `fresh iff expires_at ≥ scheduled_note_date`.
 * `expiring` = fresh but within the 14-day warning window as of `as_of`. Classes with a `none` / appraisal / DU basis are `n_a` (24.1 owns appraisal age).
 */
export function computeFreshness(i: { doc_class: string; document_date: PlainDate | null; scheduled_note_date: PlainDate | null; as_of?: PlainDate | null }): Freshness {
  const k = documentClass(i.doc_class);
  const basis = k.default_freshness_basis;
  if (basis === "none" || basis === "b4_1_2_04_appraisal" || basis === "du_validation_vendor_age" || basis === "b1_1_03_tax_year_table" || !i.document_date) return { basis, document_date: i.document_date, expires_at: null, note_date: i.scheduled_note_date, status: "n_a", warn_on: null };
  const expires_at = addMonths(i.document_date, CREDIT_DOC_AGE_MONTHS);
  const warn_on = addDays(expires_at, -DOC_EXPIRY_WARN_DAYS);
  let status: FreshnessStatus = "fresh";
  if (i.scheduled_note_date && expires_at < i.scheduled_note_date) status = "expired";
  else if (i.as_of && i.as_of >= warn_on) status = "expiring";
  return { basis, document_date: i.document_date, expires_at, note_date: i.scheduled_note_date, status, warn_on };
}

export interface ExtractInput { readonly extraction_id: string; readonly fields: Record<string, unknown>; readonly schema_version?: string; readonly extractor_version: string; readonly ocr_engine?: string | null; readonly field_confidence?: Record<string, number>; readonly human_verified?: boolean; readonly created_at: string; }
/** `document.extracted`: the per-class fields, R1 document date and R2 freshness against the current scheduled note date (the event carries `expires_at` for SM_DOC_EXPIRY_WARN_14 and `scheduled_note_date` for the 4M gate). */
export function extractFields(events: EventStore, doc: DocumentRecord, x: ExtractInput, ctx: { scheduled_note_date: PlainDate | null; application_date?: PlainDate | null; as_of?: PlainDate | null }, actor: Actor = AGENT): { doc: DocumentRecord; extraction: Extraction; freshness: Freshness; event: DomainEvent } {
  if (doc.doc_class === "unclassified") throw new RangeError(`document ${doc.document_id} is unclassified; classify before extracting`);
  const f = x.fields;
  const document_date = documentDate(doc.doc_class, f);
  const freshness = computeFreshness({ doc_class: doc.doc_class, document_date, scheduled_note_date: ctx.scheduled_note_date, as_of: ctx.as_of ?? null });
  const extraction: Extraction = { extraction_id: x.extraction_id, document_id: doc.document_id, schema_version: x.schema_version ?? documentClass(doc.doc_class).extraction_schema_version, fields: f, field_confidence: x.field_confidence ?? {}, extractor_version: x.extractor_version, ocr_engine: x.ocr_engine ?? null, human_verified: x.human_verified === true, created_at: x.created_at };
  const next: DocumentRecord = { ...doc, document_date, period_start: isDate(f.period_start) ? D(String(f.period_start)) : isDate(f.pay_period_start) ? D(String(f.pay_period_start)) : null, period_end: isDate(f.period_end) ? D(String(f.period_end)) : isDate(f.pay_period_end) ? D(String(f.pay_period_end)) : null,
    issuer_name: typeof f.employer_name === "string" ? f.employer_name : typeof f.institution === "string" ? f.institution : null, subject_borrower_id: doc.subject_borrower_id ?? (typeof f.subject_borrower_id === "string" ? f.subject_borrower_id : null),
    freshness_basis: freshness.basis, freshness_status: freshness.status, expires_at: freshness.expires_at, fields: f, status: "extracted" };
  const event = append(events, "document.extracted", doc.application_id, { document_id: doc.document_id, doc_class: doc.doc_class, extraction_id: x.extraction_id, document_date, period_end: next.period_end, expires_at: freshness.expires_at, freshness_basis: freshness.basis, freshness_status: freshness.status,
    scheduled_note_date: ctx.scheduled_note_date, application_date: ctx.application_date ?? null, is_credit_document: documentClass(doc.doc_class).is_credit_document, extractor_version: x.extractor_version, subject_borrower_id: next.subject_borrower_id }, actor, x.created_at);
  return { doc: next, extraction, freshness, event };
}

// ============================================================ gates: FNMA_B1_1_03_CREDIT_DOCS_4M · FNMA_B3_3_2_01_PAYSTUB_30D_GATE · FNMA_B1_1_03_TAX_YEAR_GATE
export type DocumentGateCode = "FNMA_B1_1_03_CREDIT_DOCS_4M" | "FNMA_B3_3_2_01_PAYSTUB_30D_GATE" | "FNMA_B1_1_03_TAX_YEAR_GATE";
export interface GateResult { readonly open: boolean; readonly reason?: string; }
export class DocumentGateClosed extends Error {
  readonly code: DocumentGateCode; readonly applicationId: string; readonly reason: string; readonly citation: string;
  constructor(code: DocumentGateCode, applicationId: string, reason: string) { super(`${code} closed for ${applicationId}: ${reason}`); this.name = "DocumentGateClosed"; this.code = code; this.applicationId = applicationId; this.reason = reason; this.citation = GATE_CITATION[code]; }
}
export const GATE_CITATION: Record<DocumentGateCode, string> = {
  FNMA_B1_1_03_CREDIT_DOCS_4M: "Selling Guide B1-1-03: credit documents must be no more than four months old on the note date; the most recent consecutive document is tested",
  FNMA_B3_3_2_01_PAYSTUB_30D_GATE: "Selling Guide B3-3.2-01: the most recent paystub is dated no earlier than 30 days prior to the initial loan application date and includes all year-to-date earnings",
  FNMA_B1_1_03_TAX_YEAR_GATE: "Selling Guide B1-1-03: allowable age of federal income tax returns (application date × disbursement date table)",
};

export interface ReliedDocument { readonly document_id: string; readonly doc_class: string; readonly document_date: PlainDate | null; readonly subject_borrower_id?: string | null; readonly account_last4?: string | null; readonly is_credit_document?: boolean; }
export interface CreditDocsGate { readonly open: boolean; readonly scheduled_note_date: PlainDate; readonly threshold_date: PlainDate; readonly tested: { document_id: string; doc_class: string; document_date: PlainDate; expires_at: PlainDate; status: FreshnessStatus }[]; readonly expired: string[]; readonly not_tested_superseded: string[]; readonly reason?: string; }
/**
 * FNMA_B1_1_03_CREDIT_DOCS_4M: open iff `expires_at ≥ scheduled_note_date` for every credit document a decision relies on. "Consecutive documents"
 * rule: within a (borrower, class, account) series only the most recent document's date is tested (T2: August tested, July's expiry irrelevant).
 * A note date of Nov 6, 2026 makes Jul 6, 2026 the threshold (add_months(Jul 6, 4) = Nov 6 ≥ Nov 6).
 */
export function creditDocsGate(i: { relied_documents: readonly ReliedDocument[]; scheduled_note_date: PlainDate }): CreditDocsGate {
  const note = i.scheduled_note_date;
  const threshold_date = addMonths(note, -CREDIT_DOC_AGE_MONTHS);
  const series = new Map<string, ReliedDocument[]>();
  for (const d of i.relied_documents) {
    const k = documentClass(d.doc_class);
    const credit = d.is_credit_document ?? k.is_credit_document;
    if (!credit || k.default_freshness_basis !== "b1_1_03_4m" && k.default_freshness_basis !== "b3_3_2_01_paystub_30d") continue;
    if (!d.document_date) continue;
    const key = `${d.subject_borrower_id ?? "*"}|${d.doc_class}|${d.account_last4 ?? "*"}`;
    const g = series.get(key) ?? []; g.push(d); series.set(key, g);
  }
  const tested: CreditDocsGate["tested"] = []; const expired: string[] = []; const not_tested_superseded: string[] = [];
  for (const g of series.values()) {
    const sorted = [...g].sort((a, b) => (a.document_date! < b.document_date! ? 1 : a.document_date! > b.document_date! ? -1 : 0));
    const most = sorted[0]!;
    for (const older of sorted.slice(1)) not_tested_superseded.push(older.document_id);
    const fr = computeFreshness({ doc_class: most.doc_class, document_date: most.document_date, scheduled_note_date: note });
    tested.push({ document_id: most.document_id, doc_class: most.doc_class, document_date: most.document_date!, expires_at: fr.expires_at!, status: fr.status });
    if (fr.status === "expired") expired.push(most.document_id);
  }
  const open = expired.length === 0;
  return { open, scheduled_note_date: note, threshold_date, tested, expired, not_tested_superseded, ...(open ? {} : { reason: `expired against note date ${note}: ${tested.filter((t) => t.status === "expired").map((t) => `${t.doc_class} ${t.document_id} dated ${t.document_date} expired ${t.expires_at}`).join("; ")}` }) };
}

export const PAYSTUB_FLOOR_DAYS = 30;
/** R3: `application_date − 30 calendar_days`, computed from the INITIAL application date and never re-based on amendment (T4). Refinance fixture Oct 5 → Sat Sept 5, 2026; purchase Oct 19 → Sat Sept 19, 2026. */
export function paystubFloor(initial_application_date: PlainDate): PlainDate { return addDays(initial_application_date, -PAYSTUB_FLOOR_DAYS); }
/** The floor is a property of the initial application date: an amendment (`amended_on`) is recorded but ignored. */
export function paystubFloorForApplication(a: { initial_application_date: PlainDate; amended_on?: PlainDate | null }): { floor: PlainDate; rebased: false; amended_on: PlainDate | null } {
  return { floor: paystubFloor(a.initial_application_date), rebased: false, amended_on: a.amended_on ?? null };
}
export interface PaystubEvidence { readonly document_id: string; readonly pay_date: PlainDate | null; readonly gross_ytd_cents: bigint | null; readonly employer_name: string | null; readonly borrower_id?: string | null; }
export interface PaystubGate { readonly open: boolean; readonly floor: PlainDate; readonly qualifying_document_id: string | null; readonly rejected: { document_id: string; why: string }[]; readonly reason?: string; readonly request_text: string; }
/** "most recent paystub (dated on/after Sept 5, 2026) with year-to-date earnings" — the request text when the floor is not met. */
export function paystubRequestText(floor: PlainDate): string { return `most recent paystub (dated on/after ${shortDate(floor)}) with year-to-date earnings`; }
/** R3: `paystub_ok iff document_date ≥ floor AND gross_ytd_cents present AND employer_name present`; any one qualifying paystub opens the gate; older ones are history. */
export function paystubGate(i: { initial_application_date: PlainDate; paystubs: readonly PaystubEvidence[] }): PaystubGate {
  const floor = paystubFloor(i.initial_application_date);
  const rejected: PaystubGate["rejected"] = []; let qualifying: string | null = null;
  for (const p of [...i.paystubs].sort((a, b) => ((a.pay_date ?? "") < (b.pay_date ?? "") ? 1 : -1))) {
    if (!p.pay_date) { rejected.push({ document_id: p.document_id, why: "no pay date" }); continue; }
    if (p.pay_date < floor) { rejected.push({ document_id: p.document_id, why: `pay date ${p.pay_date} is before the floor ${floor} (initial application date − 30 days)` }); continue; }
    if (p.gross_ytd_cents === null || p.gross_ytd_cents === undefined) { rejected.push({ document_id: p.document_id, why: "no year-to-date earnings" }); continue; }
    if (!p.employer_name) { rejected.push({ document_id: p.document_id, why: "employer not identified" }); continue; }
    if (!qualifying) qualifying = p.document_id;
  }
  const open = qualifying !== null;
  return { open, floor, qualifying_document_id: qualifying, rejected, request_text: paystubRequestText(floor), ...(open ? {} : { reason: `no paystub dated on/after ${floor} with year-to-date earnings${rejected.length ? ` (${rejected.map((r) => r.why).join("; ")})` : ""}` }) };
}

export type TaxTableRow = 1 | 2 | 3 | 4 | 5;
export interface TaxYearRequirement {
  readonly row: TaxTableRow; readonly application_window: "oct15_apr14" | "apr15_oct14"; readonly most_recent_year: number; readonly required_years: number[]; readonly acceptable_years: number[];
  readonly most_recent_required: boolean; readonly extension_permitted: boolean;
  /** What the file must hold when the most recent year is not obtained: null (required), the signed 4506-C, or the Form 4868 path. */
  readonly fallback: "none" | "form_4506c_signed" | "form_4868_path"; readonly fallback_elements: string[]; readonly partially_verified: boolean;
}
const inWindow = (d: PlainDate, from: [number, number], to: [number, number]): boolean => { const p = parts(d); const md = p.m * 100 + p.d; const a = from[0] * 100 + from[1], b = to[0] * 100 + to[1]; return a <= b ? md >= a && md <= b : md >= a || md <= b; };
/** "The 'most recent year's' tax return is the last return scheduled to have been filed": from April 15 the prior calendar year; before it, the year before that. */
export function mostRecentTaxYear(on: PlainDate): number { const p = parts(on); return inWindow(on, [4, 15], [12, 31]) ? p.y - 1 : p.y - 2; }
export const FORM_4868_PATH_ELEMENTS = ["form_4868_or_electronic_payment_confirmation", "tax_liability_comparison", "irs_no_transcript_response_to_4506c"];
/** R4: the B1-1-03 table keyed on application date × disbursement date (row 4 = row 3 per open question 7; PARTIALLY VERIFIED merged cell). */
export function taxYearRequirement(application_date: PlainDate, scheduled_disbursement_date: PlainDate): TaxYearRequirement {
  const appA = inWindow(application_date, [10, 15], [4, 14]);
  const most_recent_year = mostRecentTaxYear(application_date);
  const prior = most_recent_year - 1;
  const ay = parts(application_date).y, dy = parts(scheduled_disbursement_date).y;
  let row: TaxTableRow;
  if (appA) {
    if (inWindow(scheduled_disbursement_date, [10, 15], [4, 14])) row = 1;
    else if (inWindow(scheduled_disbursement_date, [4, 15], [6, 30])) row = 2;
    else row = 3;                                   // Jul 1–Oct 14 (a later disbursement re-bases the most recent year — conservative: row 3 path)
  } else {
    row = dy > ay && inWindow(scheduled_disbursement_date, [1, 1], [4, 14]) ? 5 : 4;   // row 4: Apr 15–Dec 31 same year (merged cell = row 3)
  }
  const required = row === 1 || row === 5;
  const base = { row, application_window: appA ? "oct15_apr14" as const : "apr15_oct14" as const, most_recent_year, partially_verified: row === 4 };
  if (required) return { ...base, required_years: [most_recent_year], acceptable_years: [most_recent_year], most_recent_required: true, extension_permitted: false, fallback: "none", fallback_elements: [] };
  if (row === 2) return { ...base, required_years: [], acceptable_years: [most_recent_year, prior], most_recent_required: false, extension_permitted: false, fallback: "form_4506c_signed", fallback_elements: ["form_4506c_signed"] };
  return { ...base, required_years: [], acceptable_years: [most_recent_year, prior], most_recent_required: false, extension_permitted: true, fallback: "form_4868_path", fallback_elements: [...FORM_4868_PATH_ELEMENTS] };
}
export interface TaxReturnEvidence { readonly tax_year: number; readonly kind: "form_1040" | "irs_return_transcript" | "business_return"; }
export interface TaxYearFacts { readonly application_date: PlainDate; readonly scheduled_disbursement_date: PlainDate; readonly returns: readonly TaxReturnEvidence[]; readonly extension_evidence?: boolean; readonly tax_liability_comparison_recorded?: boolean; readonly irs_no_transcript_response_recorded?: boolean; readonly form_4506c_signed?: boolean; }
/** FNMA_B1_1_03_TAX_YEAR_GATE: the required year's return, or the transcript / Form 4868 path documented. */
export function taxYearGate(f: TaxYearFacts): GateResult & { requirement: TaxYearRequirement; year_relied_on: number | null; path: "most_recent" | "form_4506c" | "form_4868_path" | null } {
  const req = taxYearRequirement(f.application_date, f.scheduled_disbursement_date);
  const years = new Set(f.returns.map((r) => r.tax_year));
  if (years.has(req.most_recent_year)) return { open: true, requirement: req, year_relied_on: req.most_recent_year, path: "most_recent" };
  const prior = req.most_recent_year - 1;
  if (req.most_recent_required) return { open: false, reason: `the ${req.most_recent_year} return is required (B1-1-03 row ${req.row}); the use of a Tax Extension (IRS Form 4868) is not permitted${years.has(prior) ? ` — the ${prior} return does not substitute` : ""}`, requirement: req, year_relied_on: null, path: null };
  if (!years.has(prior)) return { open: false, reason: `neither the ${req.most_recent_year} nor the ${prior} return is in the file`, requirement: req, year_relied_on: null, path: null };
  if (req.fallback === "form_4506c_signed") return f.form_4506c_signed ? { open: true, requirement: req, year_relied_on: prior, path: "form_4506c" } : { open: false, reason: `the ${prior} return is acceptable only with a completed and signed IRS Form 4506-C in the file (row 2)`, requirement: req, year_relied_on: null, path: null };
  const missing = [f.extension_evidence ? null : "Form 4868 (or electronic-payment confirmation)", f.tax_liability_comparison_recorded ? null : "total tax liability comparison", f.irs_no_transcript_response_recorded ? null : "IRS no-transcript response to Form 4506-C"].filter((x): x is string => x !== null);
  return missing.length ? { open: false, reason: `the ${prior} return is acceptable only with the Form 4868 path (row ${req.row}); missing: ${missing.join(", ")}`, requirement: req, year_relied_on: null, path: null } : { open: true, requirement: req, year_relied_on: prior, path: "form_4868_path" };
}

/** Gate evaluation over facts (the evaluator map in evaluators-22-1.ts calls these; tools call assertGateOpen). */
export function gateResult(code: DocumentGateCode, facts: Record<string, unknown>): GateResult {
  switch (code) {
    case "FNMA_B1_1_03_CREDIT_DOCS_4M": {
      const note = facts.scheduled_note_date; if (!isDate(note)) return { open: false, reason: "scheduled_note_date is required (closings.scheduled_at date)" };
      const g = creditDocsGate({ relied_documents: (facts.relied_documents as ReliedDocument[] | undefined) ?? [], scheduled_note_date: D(note) });
      return g.open ? { open: true } : { open: false, reason: g.reason! };
    }
    case "FNMA_B3_3_2_01_PAYSTUB_30D_GATE": {
      const app = facts.initial_application_date ?? facts.application_date; if (!isDate(app)) return { open: false, reason: "initial application_date is required" };
      const g = paystubGate({ initial_application_date: D(app), paystubs: (facts.paystubs as PaystubEvidence[] | undefined) ?? [] });
      return g.open ? { open: true } : { open: false, reason: g.reason! };
    }
    case "FNMA_B1_1_03_TAX_YEAR_GATE": {
      const app = facts.application_date, dis = facts.scheduled_disbursement_date;
      if (!isDate(app) || !isDate(dis)) return { open: false, reason: "application_date and scheduled_disbursement_date are required" };
      const g = taxYearGate({ application_date: D(app), scheduled_disbursement_date: D(dis), returns: (facts.returns as TaxReturnEvidence[] | undefined) ?? [], extension_evidence: facts.extension_evidence === true, tax_liability_comparison_recorded: facts.tax_liability_comparison_recorded === true, irs_no_transcript_response_recorded: facts.irs_no_transcript_response_recorded === true, form_4506c_signed: facts.form_4506c_signed === true });
      return g.open ? { open: true } : { open: false, reason: g.reason! };
    }
  }
}
/** `assertGateOpen(applicationId, code)` before issueCD (25.2), submitDuFinal (23.1), consummate (25.3/§26) and before 22.3 finalizes income: refuses a decision that relies on an expired document. */
export function assertGateOpen(applicationId: string, code: DocumentGateCode, facts: Record<string, unknown>): void {
  nonEmpty(applicationId, "applicationId");
  const r = gateResult(code, facts);
  if (!r.open) throw new DocumentGateClosed(code, applicationId, r.reason ?? "closed");
}

// ============================================================ R5 integrity battery
export const MEDICARE_RATE_BPS = 145n;          // 1.45 % (26 U.S.C. 3101(b))
export const SOCIAL_SECURITY_RATE_BPS = 620n;   // 6.2 % (26 U.S.C. 3101(a)); wage base is a loaded parameter
export const WITHHOLDING_TOLERANCE_FLOOR_CENTS = 500n;
const check = (check_type: CheckType, result: CheckResult, details: Record<string, unknown>, vendor: string | null = null, score: number | null = null): IntegrityCheck => ({ check_type, result, score, details, vendor, rule_set_version: RULE_SET_VERSION });
/** Half-up bigint rounding of `value × bps / 10000`. */
export const bps = (value: bigint, rate: bigint): bigint => (value * rate + 5000n) / 10000n;
/** `|expected − actual| ≤ max(500 cents, 0.5 % × expected)` — 0.5 % of 163,125 = 815.625 → 816. */
export function withholdingTolerance(expected: bigint): bigint { return maxBig(WITHHOLDING_TOLERANCE_FLOOR_CENTS, (expected * 5n + 500n) / 1000n); }
export interface PaystubArithmetic { readonly gross_current_cents?: bigint | null; readonly earnings_lines_cents?: readonly bigint[] | undefined; readonly deductions_cents?: readonly bigint[] | undefined; readonly net_current_cents?: bigint | null; readonly gross_ytd_cents: bigint | null; readonly medicare_withholding_ytd_cents?: bigint | null; readonly ss_withholding_ytd_cents?: bigint | null; readonly ssa_wage_base_cents?: bigint | null; readonly prior_gross_ytd_cents?: bigint | null; }
/**
 * R5 `arithmetic` (paystub): gross = Σ earnings; net = gross − Σ deductions; YTD monotonic vs the prior paystub; Medicare ≈ 1.45 % × gross YTD and Social
 * Security ≈ 6.2 % × min(gross YTD, wage base), each within `max(500, 0.5 % × expected)`. Worked example: 18 × $6,250.00 = $112,500.00 YTD → expected Medicare
 * $1,631.25, tolerance 816 cents; $1,500.00 deviates 13,125 → `warn` ("Withholding not calculated correctly").
 */
export function arithmeticCheck(p: PaystubArithmetic): IntegrityCheck {
  const findings: string[] = []; const details: Record<string, unknown> = {};
  if (p.earnings_lines_cents && p.gross_current_cents !== undefined && p.gross_current_cents !== null) { const sum = p.earnings_lines_cents.reduce((a, b) => a + b, 0n); details.gross_current_expected_cents = String(sum); if (sum !== p.gross_current_cents) findings.push(`gross_current ${p.gross_current_cents} ≠ Σ earnings ${sum}`); }
  if (p.deductions_cents && p.gross_current_cents !== undefined && p.gross_current_cents !== null && p.net_current_cents !== undefined && p.net_current_cents !== null) { const net = p.gross_current_cents - p.deductions_cents.reduce((a, b) => a + b, 0n); details.net_current_expected_cents = String(net); if (net !== p.net_current_cents) findings.push(`net_current ${p.net_current_cents} ≠ gross − deductions ${net}`); }
  if (p.prior_gross_ytd_cents !== undefined && p.prior_gross_ytd_cents !== null && p.gross_ytd_cents !== null && p.gross_ytd_cents < p.prior_gross_ytd_cents) findings.push(`gross_ytd ${p.gross_ytd_cents} below the prior paystub's ${p.prior_gross_ytd_cents}`);
  if (p.gross_ytd_cents !== null) {
    if (p.medicare_withholding_ytd_cents !== undefined && p.medicare_withholding_ytd_cents !== null) {
      const expected = bps(p.gross_ytd_cents, MEDICARE_RATE_BPS), tol = withholdingTolerance(expected), dev = abs(expected - p.medicare_withholding_ytd_cents);
      Object.assign(details, { medicare_expected_cents: String(expected), medicare_actual_cents: String(p.medicare_withholding_ytd_cents), medicare_deviation_cents: String(dev), medicare_tolerance_cents: String(tol) });
      if (dev > tol) findings.push(`Withholding not calculated correctly: Medicare YTD ${p.medicare_withholding_ytd_cents} vs expected ${expected} (deviation ${dev} > tolerance ${tol})`);
    }
    if (p.ss_withholding_ytd_cents !== undefined && p.ss_withholding_ytd_cents !== null && p.ssa_wage_base_cents) {
      const base = p.gross_ytd_cents < p.ssa_wage_base_cents ? p.gross_ytd_cents : p.ssa_wage_base_cents;
      const expected = bps(base, SOCIAL_SECURITY_RATE_BPS), tol = withholdingTolerance(expected), dev = abs(expected - p.ss_withholding_ytd_cents);
      Object.assign(details, { ss_expected_cents: String(expected), ss_actual_cents: String(p.ss_withholding_ytd_cents), ss_deviation_cents: String(dev), ss_tolerance_cents: String(tol) });
      if (dev > tol) findings.push(`Withholding not calculated correctly: Social Security YTD ${p.ss_withholding_ytd_cents} vs expected ${expected} (deviation ${dev} > tolerance ${tol})`);
    }
  }
  return check("arithmetic", findings.length ? "warn" : "pass", { ...details, findings });
}
/** R5 `even_dollar`: a YTD gross or ending balance that is a whole hundred dollars is a Fannie Mae red flag → `warn`, never `fail` alone. */
export function evenDollarCheck(amounts: Record<string, bigint | null | undefined>): IntegrityCheck {
  const even = Object.entries(amounts).filter(([, v]) => typeof v === "bigint" && v !== 0n && v % 10_000n === 0n).map(([k]) => k);
  return check("even_dollar", even.length ? "warn" : "pass", { even_dollar_fields: even });
}
export interface StatementTransaction { readonly date: PlainDate; readonly description: string; readonly amount_cents: bigint; readonly running_balance_cents: bigint | null; }
export interface StatementArithmetic { readonly opening_balance_cents: bigint; readonly ending_balance_cents: bigint; readonly transactions: readonly StatementTransaction[]; readonly monthly_qualifying_income_cents?: bigint | null; }
/** R5 `running_balance`: every `prev + amount = running` and `opening + Σ = ending`; a mismatch is a `fail` candidate (fabricated statements rarely reconcile). Deposits ≥ 50 % of monthly qualifying income are tagged for 22.4. */
export function runningBalanceCheck(s: StatementArithmetic): IntegrityCheck {
  const mismatches: string[] = []; let prev = s.opening_balance_cents; let sum = 0n; const large_deposits: { date: PlainDate; amount_cents: string; description: string }[] = [];
  s.transactions.forEach((t, n) => {
    sum += t.amount_cents; const expected = prev + t.amount_cents;
    if (t.running_balance_cents !== null && t.running_balance_cents !== expected) mismatches.push(`line ${n + 1} (${t.date}): running ${t.running_balance_cents} ≠ ${prev} + ${t.amount_cents}`);
    prev = t.running_balance_cents ?? expected;
    if (t.amount_cents > 0n && s.monthly_qualifying_income_cents && t.amount_cents * 2n >= s.monthly_qualifying_income_cents) large_deposits.push({ date: t.date, amount_cents: String(t.amount_cents), description: t.description });
  });
  const computedEnding = s.opening_balance_cents + sum;
  if (computedEnding !== s.ending_balance_cents) mismatches.push(`opening ${s.opening_balance_cents} + Σ ${sum} = ${computedEnding} ≠ ending ${s.ending_balance_cents}`);
  return check("running_balance", mismatches.length ? "fail" : "pass", { mismatches, computed_ending_cents: String(computedEnding), large_deposits_for_22_4: large_deposits });
}
export interface PdfMetadata { readonly producer?: string | null; readonly creator?: string | null; readonly creation_date?: string | null; readonly mod_date?: string | null; readonly xmp_history_consistent?: boolean; readonly flattened_layers?: boolean; readonly text_layer_over_raster_edit?: boolean; }
export const KNOWN_EDITOR_PRODUCERS = ["photoshop", "gimp", "acrobat pro", "pdf editor", "pdfelement", "foxit", "nitro", "sejda", "template", "canva", "word"];
/** R5 `pdf_metadata`: editor producers, ModDate > CreationDate + 24 h on a bank/payroll document, inconsistent XMP history, flattened layers → `warn`; text-layer edits over an original raster → `fail` candidate. */
export function pdfMetadataCheck(m: PdfMetadata | null, bankOrPayroll: boolean): IntegrityCheck {
  if (!m) return check("pdf_metadata", "n_a", { reason: "not a PDF" });
  const findings: string[] = [];
  const prod = `${m.producer ?? ""} ${m.creator ?? ""}`.toLowerCase();
  const editor = KNOWN_EDITOR_PRODUCERS.find((e) => prod.includes(e)); if (editor) findings.push(`producer/creator on the known-editor list (${editor})`);
  if (bankOrPayroll && m.creation_date && m.mod_date && Date.parse(m.mod_date) - Date.parse(m.creation_date) > 24 * 3_600_000) findings.push("ModDate later than CreationDate by more than 24 hours");
  if (m.xmp_history_consistent === false) findings.push("missing or inconsistent XMP history");
  if (m.flattened_layers) findings.push("flattened layers");
  if (m.text_layer_over_raster_edit) return check("pdf_metadata", "fail", { findings: [...findings, "text-layer edits over an original raster"] });
  return check("pdf_metadata", findings.length ? "warn" : "pass", { findings });
}
/** R5 `cross_document`: employer name/address, borrower name / SSN last-4, account last-4 and addresses across documents → mismatch `warn` + a targeted request. */
export function crossDocumentCheck(pairs: readonly { field: string; this_document: string | null; other_document: string | null; other_document_id: string }[]): IntegrityCheck {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const mismatches = pairs.filter((p) => p.this_document && p.other_document && norm(p.this_document) !== norm(p.other_document)).map((p) => ({ field: p.field, this_document: p.this_document, other_document: p.other_document, other_document_id: p.other_document_id }));
  return check("cross_document", mismatches.length ? "warn" : "pass", { mismatches, request_reason: mismatches.length ? "Documentation reflects different employment source" : null });
}
/** R5 `vendor_fraud_score`: the contracted forensics vendor's band mapped to pass/warn/fail (open question 5); an outage is `n_a` and caps an income/asset document at `flagged`. */
export function vendorFraudScoreCheck(r: { vendor: string; band: "low" | "medium" | "high" | "unavailable"; score?: number | null }): IntegrityCheck {
  const result: CheckResult = r.band === "unavailable" ? "n_a" : r.band === "high" ? "fail" : r.band === "medium" ? "warn" : "pass";
  return check("vendor_fraud_score", result, { band: r.band, outage: r.band === "unavailable" }, r.vendor, r.score ?? null);
}
/** R5 `source_verification`: the same facts arrived from the source (DU validation report, Form 1006 from the institution, IVES transcript, CBSV, vendor VOE) — source evidence always outranks borrower paper. */
export function sourceVerificationCheck(source: { kind: "du_validation_report" | "form_1006_direct" | "ives_transcript" | "cbsv" | "vendor_voe" | "voa_report"; reference: string } | null): IntegrityCheck {
  return source ? check("source_verification", "pass", { kind: source.kind, reference: source.reference }) : check("source_verification", "n_a", { reason: "borrower-supplied; no source-obtained evidence for the same fact" });
}
/** Aggregation: any `fail` → failed; ≥ 2 `warn`, or one `warn` on an income/asset document that is the sole evidence of a qualifying fact → flagged; vendor outage on an income/asset document without source verification → flagged; otherwise passed. */
export function aggregateIntegrity(checks: readonly IntegrityCheck[], ctx: { income_or_asset: boolean; sole_evidence: boolean }): IntegrityStatus {
  if (checks.some((c) => c.result === "fail")) return "failed";
  const warns = checks.filter((c) => c.result === "warn").length;
  if (warns >= 2) return "flagged";
  if (warns === 1 && ctx.income_or_asset && ctx.sole_evidence) return "flagged";
  const vendorOut = checks.some((c) => c.check_type === "vendor_fraud_score" && c.result === "n_a");
  const sourced = checks.some((c) => c.check_type === "source_verification" && c.result === "pass");
  if (vendorOut && ctx.income_or_asset && !sourced) return "flagged";
  return "passed";
}
export interface BatteryInput {
  readonly pdf_metadata?: PdfMetadata | null; readonly bank_or_payroll?: boolean; readonly cross_document?: Parameters<typeof crossDocumentCheck>[0]; readonly vendor?: Parameters<typeof vendorFraudScoreCheck>[0] | null;
  readonly source?: Parameters<typeof sourceVerificationCheck>[0]; readonly email_authentication?: EmailAuthentication | null; readonly ssa_wage_base_cents?: bigint | null; readonly prior_gross_ytd_cents?: bigint | null; readonly monthly_qualifying_income_cents?: bigint | null; readonly template_match?: "match" | "mismatch" | "no_template" | null; readonly font_layout_anomalies?: readonly string[];
}
export interface BatteryResult {
  readonly doc: DocumentRecord; readonly checks: IntegrityCheck[]; readonly integrity_status: IntegrityStatus; readonly event: DomainEvent;
  /** `failed`: sev-2 `underwriting_reviewer` escalation with a 1 business_days_creditor SLA and a fraud-case candidate for 22.6. */
  readonly escalation: { kind: "underwriting_reviewer"; severity: "sev-2"; sla: { n: 1; unit: "business_days_creditor"; due: PlainDate }; fraud_case_candidate: boolean } | null;
  /** `flagged` income/asset document: a source-obtained VOE / DU validation report is requested before 22.3/22.4 may use the fact. */
  readonly follow_up_request: { doc_class: string; reason_code: string; reason_text: string } | null;
}
const bigOrNull = (v: unknown): bigint | null => (v === undefined || v === null || v === "" ? null : cents(v));
const bigList = (v: unknown): bigint[] | undefined => (Array.isArray(v) ? v.map(cents) : undefined);
/** The whole battery over an extracted document; appends `document.integrity.{cleared|flagged|failed}` and returns the follow-ups the agent must open. */
export function runIntegrityBattery(events: EventStore, doc: DocumentRecord, b: BatteryInput = {}, actor: Actor = AGENT, at?: string, cal: Calendar = creditor): BatteryResult {
  const f = doc.fields ?? {}; const k = documentClass(doc.doc_class);
  const incomeOrAsset = k.family === "income_employment" || k.family === "assets" || k.family === "tax";
  const checks: IntegrityCheck[] = [];
  checks.push(pdfMetadataCheck(b.pdf_metadata ?? null, b.bank_or_payroll ?? incomeOrAsset));
  checks.push(check("font_layout", b.font_layout_anomalies?.length ? "warn" : "pass", { anomalies: b.font_layout_anomalies ?? [] }));
  if (doc.doc_class === "paystub") checks.push(arithmeticCheck({ gross_current_cents: bigOrNull(f.gross_current_cents), earnings_lines_cents: bigList(f.earnings_lines_cents), deductions_cents: bigList(f.deductions_cents), net_current_cents: bigOrNull(f.net_current_cents), gross_ytd_cents: bigOrNull(f.gross_ytd_cents),
    medicare_withholding_ytd_cents: bigOrNull(f.medicare_withholding_ytd_cents), ss_withholding_ytd_cents: bigOrNull(f.ss_withholding_ytd_cents), ssa_wage_base_cents: b.ssa_wage_base_cents ?? null, prior_gross_ytd_cents: b.prior_gross_ytd_cents ?? null }));
  if (k.family === "assets" && Array.isArray(f.transactions)) checks.push(runningBalanceCheck({ opening_balance_cents: cents(f.opening_balance_cents), ending_balance_cents: cents(f.ending_balance_cents), monthly_qualifying_income_cents: b.monthly_qualifying_income_cents ?? null,
    transactions: (f.transactions as Record<string, unknown>[]).map((t) => ({ date: D(String(t.date)), description: String(t.description ?? ""), amount_cents: cents(t.amount_cents), running_balance_cents: bigOrNull(t.running_balance_cents) })) }));
  if (b.template_match) checks.push(check("template_match", b.template_match === "mismatch" ? "warn" : b.template_match === "match" ? "pass" : "n_a", { template_match: b.template_match }));
  checks.push(evenDollarCheck({ gross_ytd_cents: bigOrNull(f.gross_ytd_cents), ending_balance_cents: bigOrNull(f.ending_balance_cents) }));
  if (b.cross_document) checks.push(crossDocumentCheck(b.cross_document));
  if (b.vendor) checks.push(vendorFraudScoreCheck(b.vendor));
  if (doc.source_channel === "borrower_email") checks.push(senderAuthenticationCheck(b.email_authentication ?? null));
  checks.push(sourceVerificationCheck(b.source ?? null));
  if (k.family === "assets" && f.banner_url_present === false) checks.push(check("template_match", "warn", { finding: "screenshot/photo without banner or URL — B1-1-03 note / B3-4.2-01 source identification", request: "institution PDF or VOA report" }));
  const integrity_status = aggregateIntegrity(checks, { income_or_asset: incomeOrAsset, sole_evidence: doc.sole_evidence });
  const status: DocumentState = integrity_status === "failed" ? "failed" : integrity_status === "flagged" ? "flagged" : "accepted";
  const next: DocumentRecord = { ...doc, integrity_status, status };
  const when = at ?? doc.received_at;
  const summary = checks.map((c) => ({ check_type: c.check_type, result: c.result }));
  const escalation: BatteryResult["escalation"] = integrity_status === "failed" ? { kind: "underwriting_reviewer", severity: "sev-2", sla: { n: 1, unit: "business_days_creditor", due: addBusinessDays(civilDate(when), 1, cal) }, fraud_case_candidate: true } : null;
  const follow_up_request: BatteryResult["follow_up_request"] = integrity_status === "flagged" && incomeOrAsset
    ? (k.family === "assets" ? { doc_class: "voa_report", reason_code: "sm_integrity_source_verification", reason_text: "a source-obtained asset verification report (DU validation service or Form 1006 sent directly by the institution) before the asset is used" }
      : { doc_class: "form_1005_voe", reason_code: "sm_integrity_source_verification", reason_text: "a source-obtained verification of employment (Form 1005 from the employer or the DU validation report) before the income is used" })
    : null;
  const type = integrity_status === "failed" ? "document.integrity.failed" : integrity_status === "flagged" ? "document.integrity.flagged" : "document.integrity.cleared";
  const event = append(events, type, doc.application_id, { document_id: doc.document_id, doc_class: doc.doc_class, integrity_status, checks: summary, findings: checks.flatMap((c) => (Array.isArray(c.details.findings) ? (c.details.findings as string[]) : Array.isArray(c.details.mismatches) ? (c.details.mismatches as unknown[]).map(String) : [])),
    ...(escalation ? { escalation_role: escalation.kind, severity: escalation.severity, sla_due: escalation.sla.due, fraud_case_candidate: true, hand_off: "22.6" } : {}), ...(follow_up_request ? { follow_up_request } : {}) }, actor, when);
  return { doc: next, checks, integrity_status, event, escalation, follow_up_request };
}
/** `flagged` → `accepted` only with a written decision naming the resolving evidence; `failed` is never accepted (guardrail). */
export function clearFlaggedDocument(events: EventStore, doc: DocumentRecord, d: { rationale: string; resolving_evidence_document_ids: readonly string[]; decision_id: string }, actor: Actor = AGENT, at?: string): DocumentRecord {
  if (doc.integrity_status === "failed") throw new RangeError(`document ${doc.document_id} is failed: the agent may never accept a failed document (22.6 owns the review)`);
  if (doc.integrity_status !== "flagged") return doc;
  nonEmpty(d.rationale, "rationale"); if (!d.resolving_evidence_document_ids.length) throw new RangeError("resolving evidence is required to clear a flagged document");
  append(events, "document.integrity.cleared", doc.application_id, { document_id: doc.document_id, doc_class: doc.doc_class, integrity_status: "passed", decision_id: d.decision_id, resolving_evidence_document_ids: [...d.resolving_evidence_document_ids], rationale: d.rationale }, actor, at);
  return { ...doc, integrity_status: "passed", status: "accepted" };
}

// ============================================================ R8 superseding
/** A new document of the same class for the same subject and period supersedes the prior; the superseded one stays in the file but can no longer satisfy a request. */
export function supersede(events: EventStore, docs: readonly DocumentRecord[], fresh: DocumentRecord, actor: Actor = AGENT, at?: string): { docs: DocumentRecord[]; superseded: string[] } {
  const superseded: string[] = [];
  const out = docs.map((d) => {
    if (d.document_id === fresh.document_id || d.doc_class !== fresh.doc_class || d.status === "superseded" || d.status === "quarantined") return d;
    if ((d.subject_borrower_id ?? null) !== (fresh.subject_borrower_id ?? null)) return d;
    const samePeriod = d.period_end && fresh.period_end ? d.period_end === fresh.period_end && d.period_start === fresh.period_start : d.document_date !== null && d.document_date === fresh.document_date;
    if (!samePeriod && !(d.issuer_name && d.issuer_name === fresh.issuer_name && d.period_end && fresh.period_end && d.period_end < fresh.period_end && documentClass(d.doc_class).family === "assets" && (d.fields?.account_last4 ?? null) === (fresh.fields?.account_last4 ?? null))) return d;
    superseded.push(d.document_id);
    append(events, "document.superseded", fresh.application_id, { document_id: d.document_id, superseded_by_document_id: fresh.document_id, supersedes_document_id: d.document_id, doc_class: d.doc_class, period_end: d.period_end, replacement_period_end: fresh.period_end }, actor, at);
    return { ...d, status: "superseded" as DocumentState };
  });
  return { docs: out, superseded };
}

// ============================================================ R6/R7 needs list
export const BORROWER_RESPONSE_DAYS = 5;
export const REMINDER_OFFSETS_DAYS = [2, 4] as const;
export const NOIA_EVALUATION_DAYS = 10;
export const MAIL_TIME_EXTENSION_DAYS = 5;
export interface RequestSchedule { readonly requested_on: PlainDate; readonly due_at: PlainDate; readonly reminder_dates: PlainDate[]; readonly noia_evaluation_on: PlainDate; }
/** R7: +5 calendar days (Columbus Day is irrelevant: `calendar_days`), reminders at +2 and +4, Reg B incompleteness evaluated at +10 (21.6 decides). */
export function requestSchedule(requested_at: string, tz = CREDITOR_TZ): RequestSchedule {
  const on = civilDate(requested_at, tz);
  return { requested_on: on, due_at: addDays(on, BORROWER_RESPONSE_DAYS), reminder_dates: REMINDER_OFFSETS_DAYS.map((n) => addDays(on, n)), noia_evaluation_on: addDays(on, NOIA_EVALUATION_DAYS) };
}
/** SM_NEEDS_LIST_REVIEW_1BD: +1 `business_days_creditor` from the receipt's civil date (a Saturday receipt with Columbus Day Monday → Tuesday). */
export function reviewDue(received_at: string, cal: Calendar = creditor, tz = CREDITOR_TZ): PlainDate { return addBusinessDays(civilDate(received_at, tz), 1, cal); }
export const dedupeKey = (r: { borrower_id: string; doc_class: string; qualifier: Record<string, unknown> }): string => `${r.borrower_id}|${r.doc_class}|${JSON.stringify(Object.fromEntries(Object.entries(r.qualifier).sort()))}`;
/** Reason codes the needs list accepts: a DU message id, an underwriter/QC/compliance condition code, or an SM rule. A request is never free-typed. */
export const SM_REASON_CODES = ["sm_intake", "sm_freshness", "sm_integrity_source_verification", "sm_paystub_floor", "sm_tax_year", "sm_cross_document", "sm_source_identification", "sm_translation", "sm_password"] as const;
export const isLinkedReason = (r: { reason_code: string; condition_id: string | null }): boolean => r.condition_id !== null || (SM_REASON_CODES as readonly string[]).includes(r.reason_code) || /^DU[-_ ]?\d+/i.test(r.reason_code) || /^(UW|QC|COMP|CLOSING)[-_]/i.test(r.reason_code);
/** Verifying documents (TRID FAQ): everything except the intake questionnaire answers themselves — a needs-list item for one may not be sent before the LE is delivered. */
export const isVerifyingDocument = (doc_class: string): boolean => documentClass(doc_class).family !== "other";
export interface OpenRequestInput { readonly request_id: string; readonly application_id: string; readonly borrower_id: string; readonly doc_class: string; readonly qualifier?: Record<string, unknown>; readonly reason_code: string; readonly reason_text: string; readonly condition_id?: string | null; readonly requested_at: string; readonly existing?: readonly DocumentRequest[]; readonly tz?: string; }
/** `document_request.opened` (arms SM_NEEDS_LIST_BORROWER_RESPONSE_5 on `requested_at`); de-duplicated on (borrower_id, doc_class, qualifier) — an open twin is returned, not re-opened. */
export function openRequest(events: EventStore, i: OpenRequestInput, actor: Actor = AGENT): { request: DocumentRequest; opened: boolean; event: DomainEvent | null } {
  nonEmpty(i.request_id, "request_id"); nonEmpty(i.application_id, "application_id"); nonEmpty(i.borrower_id, "borrower_id"); nonEmpty(i.reason_code, "reason_code"); nonEmpty(i.reason_text, "reason_text");
  const k = documentClass(i.doc_class);
  const qualifier = i.qualifier ?? {};
  const condition_id = i.condition_id ?? null;
  if (!isLinkedReason({ reason_code: i.reason_code, condition_id })) throw new RangeError(`request reason ${JSON.stringify(i.reason_code)} is not a condition, an intake rule or a freshness rule (never a free-typed item)`);
  const key = dedupeKey({ borrower_id: i.borrower_id, doc_class: k.code, qualifier });
  const twin = (i.existing ?? []).find((r) => r.application_id === i.application_id && ["open", "reminded", "received", "under_review"].includes(r.status) && dedupeKey(r) === key);
  if (twin) return { request: twin, opened: false, event: null };
  const s = requestSchedule(i.requested_at, i.tz);
  const request: DocumentRequest = { request_id: i.request_id, application_id: i.application_id, condition_id, borrower_id: i.borrower_id, doc_class: k.code, qualifier, reason_code: i.reason_code, reason_text: i.reason_text, requested_at: i.requested_at, due_at: s.due_at, reminder_dates: s.reminder_dates, noia_evaluation_on: s.noia_evaluation_on,
    status: "open", satisfied_by_document_id: null, waived_by: null, waiver_reference: null, reminder_count: 0, reminders_sent_on: [], channel_used: [], notice_ids: [], received_document_id: null, verifying_document: isVerifyingDocument(k.code) };
  const event = append(events, "document_request.opened", i.application_id, { request_id: request.request_id, requested_at: i.requested_at, due_at: s.due_at, reminder_dates: s.reminder_dates, borrower_id: i.borrower_id, doc_class: k.code, qualifier, reason_code: i.reason_code, reason_text: i.reason_text, condition_id, verifying_document: request.verifying_document }, actor, i.requested_at);
  return { request, opened: true, event };
}
/** Reminders at +2 and +4 that fall on or before `as_of` and before any receipt (`document_request.reminded`); the third unanswered reminder offers `human_agent` contact. */
export function sendReminders(events: EventStore, r: DocumentRequest, as_of: PlainDate, actor: Actor = AGENT): { request: DocumentRequest; sent: PlainDate[]; offer_human_agent: boolean } {
  if (!["open", "reminded"].includes(r.status)) return { request: r, sent: [], offer_human_agent: false };
  const sent: PlainDate[] = [];
  let next = r;
  for (const d of r.reminder_dates) {
    if (d > as_of || next.reminders_sent_on.includes(d)) continue;
    next = { ...next, status: "reminded", reminder_count: next.reminder_count + 1, reminders_sent_on: [...next.reminders_sent_on, d] };
    append(events, "document_request.reminded", r.application_id, { request_id: r.request_id, reminder_no: next.reminder_count, sent_on: d, due_at: r.due_at, template: "NTC_SM_NEEDS_LIST_REMINDER" }, actor);
    sent.push(d);
  }
  return { request: next, sent, offer_human_agent: next.reminder_count >= 3 };
}
/** matchToRequests: an intake links to the open requests for its borrower + class (+ qualifier when the request names one); the linked requests move to `received`. */
export function matchToRequests(doc: DocumentRecord, requests: readonly DocumentRequest[]): { matched: DocumentRequest[]; requests: DocumentRequest[] } {
  const matched: DocumentRequest[] = [];
  const out = requests.map((r) => {
    if (r.application_id !== doc.application_id || !["open", "reminded"].includes(r.status)) return r;
    if (doc.subject_borrower_id && r.borrower_id !== doc.subject_borrower_id) return r;
    // An upload made against a request links to it before classification (the review checks the class); otherwise class + qualifier decide.
    if (doc.request_ids.length) { if (!doc.request_ids.includes(r.request_id)) return r; }
    else {
      if (r.doc_class !== doc.doc_class) return r;
      const q = r.qualifier; const f = doc.fields ?? {};
      if (typeof q.employer === "string" && typeof f.employer_name === "string" && q.employer.toLowerCase() !== f.employer_name.toLowerCase()) return r;
      if (typeof q.account_last4 === "string" && typeof f.account_last4 === "string" && q.account_last4 !== f.account_last4) return r;
    }
    const next: DocumentRequest = { ...r, status: "received", received_document_id: doc.document_id };
    matched.push(next); return next;
  });
  return { matched, requests: out };
}
export interface ReviewOutcome { readonly request: DocumentRequest; readonly satisfied: boolean; readonly reason: string | null; readonly event: DomainEvent | null; readonly condition_clear_proposal: { condition_id: string; request_id: string; document_id: string } | null; }
/**
 * Review of a received request (satisfies SM_NEEDS_LIST_REVIEW_1BD): a request cannot be satisfied by a document whose `integrity_status ≠ passed`,
 * whose freshness is `expired` against the scheduled note date, whose subject is not the borrower, or that is superseded; otherwise
 * `document_request.satisfied` and a `condition.clear.proposed` for 23.3 when the request is linked to a condition. A failing document re-opens the request with the reason.
 */
export function reviewRequest(events: EventStore, r: DocumentRequest, doc: DocumentRecord, ctx: { scheduled_note_date: PlainDate | null; initial_application_date?: PlainDate | null; at: string }, actor: Actor = AGENT): ReviewOutcome {
  const reasons: string[] = [];
  if (doc.doc_class !== r.doc_class) reasons.push(`document class ${doc.doc_class} does not satisfy a ${r.doc_class} request`);
  if (doc.integrity_status !== "passed") reasons.push(`integrity_status ${doc.integrity_status} (must be passed)`);
  if (doc.status === "superseded") reasons.push("superseded by a newer document of the same class and period");
  if (doc.subject_borrower_id && doc.subject_borrower_id !== r.borrower_id) reasons.push("extracted subject does not match the borrower");
  const fr = computeFreshness({ doc_class: doc.doc_class, document_date: doc.document_date, scheduled_note_date: ctx.scheduled_note_date });
  if (fr.status === "expired") reasons.push(`freshness expired against the scheduled note date ${ctx.scheduled_note_date} (expires ${fr.expires_at})`);
  if (doc.doc_class === "paystub" && ctx.initial_application_date) { const g = paystubGate({ initial_application_date: ctx.initial_application_date, paystubs: [{ document_id: doc.document_id, pay_date: doc.document_date, gross_ytd_cents: bigOrNull(doc.fields?.gross_ytd_cents), employer_name: doc.issuer_name }] }); if (!g.open) reasons.push(g.reason!); }
  if (reasons.length) {
    const reason = reasons.join("; ");
    const next: DocumentRequest = { ...r, status: "open", received_document_id: null, reason_text: `${r.reason_text} — the document received does not meet the standard: ${reason}` };
    const event = append(events, "document_request.opened", r.application_id, { request_id: r.request_id, requested_at: ctx.at, due_at: requestSchedule(ctx.at).due_at, borrower_id: r.borrower_id, doc_class: r.doc_class, qualifier: r.qualifier, reason_code: r.reason_code, reason_text: next.reason_text, condition_id: r.condition_id, reopened: true, rejected_document_id: doc.document_id, verifying_document: r.verifying_document }, actor, ctx.at);
    return { request: next, satisfied: false, reason, event, condition_clear_proposal: null };
  }
  const next: DocumentRequest = { ...r, status: "satisfied", satisfied_by_document_id: doc.document_id, received_document_id: doc.document_id };
  const event = append(events, "document_request.satisfied", r.application_id, { request_id: r.request_id, document_id: doc.document_id, doc_class: doc.doc_class, condition_id: r.condition_id, satisfied_at: ctx.at }, actor, ctx.at);
  const condition_clear_proposal = r.condition_id ? { condition_id: r.condition_id, request_id: r.request_id, document_id: doc.document_id } : null;
  if (condition_clear_proposal) append(events, "condition.clear.proposed", r.application_id, { ...condition_clear_proposal, evidence_document_ids: [doc.document_id], proposed_by: actor.id }, actor, ctx.at);
  return { request: next, satisfied: true, reason: null, event, condition_clear_proposal };
}
/** DU validation `validated` for a component waives the paper requests for that borrower/component (`waived_by = du_validation`, the submission number recorded) — the only waiver path besides an owning-process rule. */
export const DU_COMPONENT_CLASSES: Record<"employment" | "income" | "assets", readonly string[]> = { employment: ["form_1005_voe", "paystub", "vvoe_record"], income: ["paystub", "w2", "form_1005_voe"], assets: ["bank_statement", "brokerage_statement", "retirement_statement", "form_1006_vod"] };
export function waiveByDuValidation(events: EventStore, requests: readonly DocumentRequest[], v: { application_id: string; borrower_id: string; component: keyof typeof DU_COMPONENT_CLASSES; outcome: "validated" | "not_validated" | "unable_to_validate"; submission_number: string; employer?: string | null; at: string }, actor: Actor = AGENT): { requests: DocumentRequest[]; waived: DocumentRequest[] } {
  nonEmpty(v.submission_number, "submission_number");
  if (v.outcome !== "validated") return { requests: [...requests], waived: [] };
  const classes = DU_COMPONENT_CLASSES[v.component]; const waived: DocumentRequest[] = [];
  const out = requests.map((r) => {
    if (r.application_id !== v.application_id || r.borrower_id !== v.borrower_id || !classes.includes(r.doc_class) || !["open", "reminded", "received", "under_review"].includes(r.status)) return r;
    if (v.employer && typeof r.qualifier.employer === "string" && r.qualifier.employer.toLowerCase() !== v.employer.toLowerCase()) return r;
    const next: DocumentRequest = { ...r, status: "waived", waived_by: "du_validation", waiver_reference: v.submission_number };
    append(events, "document_request.waived", v.application_id, { request_id: r.request_id, waived_by: "du_validation", reference: v.submission_number, du_submission_number: v.submission_number, component: v.component, doc_class: r.doc_class, borrower_id: r.borrower_id }, actor, v.at);
    waived.push(next); return next;
  });
  return { requests: out, waived };
}
/** A waiver by the owning process's rule (22.3/22.4/23.3) or a DU validation outcome; anything else is refused. */
export function waiveRequest(events: EventStore, r: DocumentRequest, w: { waived_by: "du_validation" | "owning_process_rule"; reference: string; rule: string; at: string }, actor: Actor = AGENT): DocumentRequest {
  nonEmpty(w.reference, "reference"); nonEmpty(w.rule, "rule");
  if (w.waived_by !== "du_validation" && w.waived_by !== "owning_process_rule") throw new RangeError("a Fannie Mae documentation requirement is waived only through a DU validation outcome or an owning-process rule");
  const next: DocumentRequest = { ...r, status: "waived", waived_by: w.waived_by, waiver_reference: w.reference };
  append(events, "document_request.waived", r.application_id, { request_id: r.request_id, waived_by: w.waived_by, reference: w.reference, rule: w.rule, doc_class: r.doc_class, borrower_id: r.borrower_id }, actor, w.at);
  return next;
}
/** Application denied/withdrawn (or a condition withdrawn): open requests expire / cancel. */
export function expireRequests(events: EventStore, requests: readonly DocumentRequest[], e: { application_id: string; reason: "denied" | "withdrawn" | "condition_withdrawn"; at: string; condition_id?: string | null }, actor: Actor = AGENT): DocumentRequest[] {
  return requests.map((r) => {
    if (r.application_id !== e.application_id || !["open", "reminded", "received", "under_review"].includes(r.status)) return r;
    if (e.reason === "condition_withdrawn" && r.condition_id !== (e.condition_id ?? null)) return r;
    const status: RequestStatus = e.reason === "condition_withdrawn" ? "cancelled" : "expired";
    append(events, `document_request.${status}`, e.application_id, { request_id: r.request_id, reason: e.reason, doc_class: r.doc_class }, actor, e.at);
    return { ...r, status };
  });
}

// ------------------------------------------------------------ deriveNeedsList: intake matrix + DU message map
export interface NeedsListItem { readonly borrower_id: string; readonly doc_class: string; readonly qualifier?: Record<string, unknown>; readonly reason_code: string; readonly reason_text: string; readonly condition_id?: string | null; }
/** (a) intake rules by income/asset type (22.3/22.4 documentation matrices, document-level part); refinance asset period is one month (B3-4.2-01), purchase two. */
export function intakeNeeds(a: { borrower_id: string; income_types: readonly string[]; asset_accounts: readonly { account_last4: string; institution: string }[]; transaction: "purchase" | "refinance"; employer?: string | null; initial_application_date: PlainDate; gift?: boolean }): NeedsListItem[] {
  const items: NeedsListItem[] = [];
  const floor = paystubFloor(a.initial_application_date);
  if (a.income_types.includes("base") || a.income_types.includes("overtime") || a.income_types.includes("bonus") || a.income_types.includes("commission")) {
    items.push({ borrower_id: a.borrower_id, doc_class: "paystub", qualifier: { employer: a.employer ?? null, ytd: true }, reason_code: "sm_intake", reason_text: paystubRequestText(floor) });
    items.push({ borrower_id: a.borrower_id, doc_class: "w2", qualifier: { employer: a.employer ?? null, years: 2 }, reason_code: "sm_intake", reason_text: "W-2 forms for the most recent two years (B3-3.2-01)" });
  }
  if (a.income_types.includes("self_employed") || a.income_types.includes("rental")) items.push({ borrower_id: a.borrower_id, doc_class: "form_1040", qualifier: { years: 2 }, reason_code: "sm_intake", reason_text: "signed federal tax returns with all schedules for the most recent two years" });
  if (a.income_types.includes("social_security")) items.push({ borrower_id: a.borrower_id, doc_class: "ssa_award_letter", reason_code: "sm_intake", reason_text: "current Social Security award letter" });
  const months = a.transaction === "purchase" ? 2 : 1;
  for (const acct of a.asset_accounts) items.push({ borrower_id: a.borrower_id, doc_class: "bank_statement", qualifier: { account_last4: acct.account_last4, months }, reason_code: "sm_intake", reason_text: `most recent ${months === 1 ? "one-month" : "two-month"} statement${months > 1 ? "s" : ""} for ${acct.institution} account ending ${acct.account_last4} showing all pages, the account holder and the ending balance` });
  if (a.gift) items.push({ borrower_id: a.borrower_id, doc_class: "gift_letter", reason_code: "sm_intake", reason_text: "gift letter signed by the donor stating no repayment is expected, with evidence of the transfer" });
  return items;
}
/** (b) DU verification messages mapped by message id to doc_class + qualifier (23.2 opens the condition; this is the document translation). */
export const DU_MESSAGE_MAP: Record<string, { doc_class: string; reason_text: string; qualifier?: Record<string, unknown> }> = {
  "DU-1001": { doc_class: "paystub", reason_text: "most recent paystub with year-to-date earnings" },
  "DU-1002": { doc_class: "w2", reason_text: "W-2 forms for the most recent year", qualifier: { years: 1 } },
  "DU-1005": { doc_class: "form_1005_voe", reason_text: "written verification of employment (Form 1005) sent directly by the employer" },
  "DU-2001": { doc_class: "bank_statement", reason_text: "most recent bank statement(s) covering the required period" },
  "DU-2010": { doc_class: "gift_letter", reason_text: "gift letter and evidence of the gift transfer" },
  "DU-2020": { doc_class: "explanation_letter", reason_text: "explanation of the large deposit with its source documentation" },
  "DU-3001": { doc_class: "form_1040", reason_text: "signed federal tax returns for the required years" },
  "DU-4001": { doc_class: "explanation_letter", reason_text: "letter of explanation for the recent credit inquiries" },
};
export function duConditionNeeds(c: { borrower_id: string; condition_id: string; du_message_id: string; qualifier?: Record<string, unknown> }): NeedsListItem {
  const m = DU_MESSAGE_MAP[c.du_message_id];
  if (!m) throw new RangeError(`DU message ${c.du_message_id} has no document mapping; the condition stays with 23.2`);
  return { borrower_id: c.borrower_id, doc_class: m.doc_class, qualifier: { ...(m.qualifier ?? {}), ...(c.qualifier ?? {}) }, reason_code: c.du_message_id, reason_text: m.reason_text, condition_id: c.condition_id };
}
export interface NeedsListBatch { readonly batch_id: string; readonly application_id: string; readonly request_ids: string[]; readonly status: "queued" | "released" | "sent"; readonly queued_reason: string | null; readonly notice_id: string | null; readonly created_at: string; readonly released_at: string | null; }
/**
 * R6: the consolidated notice is sent once per batch (never one e-mail per item) and never before the LE has been delivered when an item is a
 * verifying document (TRID FAQ; 21.2 gate): the batch is `queued` and released by `disclosure.le.delivered` (T10). Waived/satisfied requests are never listed.
 */
export function needsListBatch(events: EventStore, b: { batch_id: string; application_id: string; requests: readonly DocumentRequest[]; le_delivered: boolean; at: string }, actor: Actor = AGENT): NeedsListBatch {
  const listed = b.requests.filter((r) => r.application_id === b.application_id && ["open", "reminded"].includes(r.status));
  const verifying = listed.some((r) => r.verifying_document);
  const queued = verifying && !b.le_delivered;
  const batch: NeedsListBatch = { batch_id: b.batch_id, application_id: b.application_id, request_ids: listed.map((r) => r.request_id), status: queued ? "queued" : "released", queued_reason: queued ? "loan_estimate_not_delivered" : null, notice_id: null, created_at: b.at, released_at: queued ? null : b.at };
  append(events, queued ? "needs_list.queued" : "needs_list.released", b.application_id, { batch_id: b.batch_id, request_ids: batch.request_ids, reason: batch.queued_reason, gate: "disclosure.le.delivered" }, actor, b.at);
  return batch;
}
/** `disclosure.le.delivered` releases every queued batch of the application. */
export function releaseQueuedBatches(events: EventStore, batches: readonly NeedsListBatch[], le: { application_id: string; delivered_at: string }, actor: Actor = AGENT): NeedsListBatch[] {
  return batches.map((b) => {
    if (b.application_id !== le.application_id || b.status !== "queued") return b;
    append(events, "needs_list.released", le.application_id, { batch_id: b.batch_id, request_ids: b.request_ids, released_by: "disclosure.le.delivered", released_at: le.delivered_at }, actor, le.delivered_at);
    return { ...b, status: "released" as const, queued_reason: null, released_at: le.delivered_at };
  });
}
/** Record the sent notice on the batch and its requests (`needs_list.sent{notice_id}`); a queued batch is refused. */
export function markNeedsListSent(events: EventStore, b: NeedsListBatch, requests: readonly DocumentRequest[], s: { notice_id: string; channels: readonly string[]; at: string }, actor: Actor = AGENT): { batch: NeedsListBatch; requests: DocumentRequest[] } {
  if (b.status === "queued") throw new RangeError(`needs-list batch ${b.batch_id} is queued until the Loan Estimate is delivered (TRID FAQ: no verifying documents before the LE)`);
  append(events, "needs_list.sent", b.application_id, { batch_id: b.batch_id, notice_id: s.notice_id, request_ids: b.request_ids, channels: [...s.channels], template: "NTC_SM_NEEDS_LIST" }, actor, s.at);
  return { batch: { ...b, status: "sent", notice_id: s.notice_id }, requests: requests.map((r) => (b.request_ids.includes(r.request_id) ? { ...r, notice_ids: [...r.notice_ids, s.notice_id], channel_used: [...new Set([...r.channel_used, ...s.channels])] } : r)) };
}
export interface NeedsListParty { readonly borrower_names: readonly string[]; readonly partner_name: string; readonly mlo_name: string; readonly mlo_nmlsr_id: string; readonly upload_url: string; readonly human_contact: string; readonly notice_date: PlainDate; }
/** Payload for NTC_SM_NEEDS_LIST / NTC_SM_NEEDS_LIST_REMINDER: one plain-language line per open item with its due date; waived and satisfied items never appear (T9). */
export function needsListPayload(requests: readonly DocumentRequest[], party: NeedsListParty, opts: { reminder_no?: number } = {}): Record<string, unknown> {
  const items = requests.filter((r) => ["open", "reminded"].includes(r.status)).map((r) => ({ doc_class: r.doc_class, reason: r.reason_text, due_at: r.due_at, request_id: r.request_id }));
  const due = items.map((i) => i.due_at).sort()[0] ?? party.notice_date;
  return { ...party, items, item_count: items.length, due_at: due, reminder_no: opts.reminder_no ?? 0, automated: true };
}
/** Reg B interaction (R7): at +10 with nothing received the agent hands 21.6 a NOIA recommendation with the missing items; 21.6's clock is never extended here. */
export function noiaRecommendation(requests: readonly DocumentRequest[], as_of: PlainDate): { recommend: boolean; missing: { request_id: string; doc_class: string; reason_text: string }[]; hand_off: "21.6"; response_period_days: number } {
  const missing = requests.filter((r) => ["open", "reminded"].includes(r.status) && r.noia_evaluation_on <= as_of).map((r) => ({ request_id: r.request_id, doc_class: r.doc_class, reason_text: r.reason_text }));
  return { recommend: missing.length > 0, missing, hand_off: "21.6", response_period_days: 14 };
}

// ============================================================ nightly freshness sweep
/** Every open application re-evaluated against the scheduled note date: `document.expiring` 14 days ahead (a replacement request when the note date is past the expiry), `document.expired` when already expired. */
export function freshnessSweep(events: EventStore, docs: readonly DocumentRecord[], s: { application_id: string; scheduled_note_date: PlainDate; as_of: PlainDate }, actor: Actor = AGENT): { docs: DocumentRecord[]; expiring: string[]; expired: string[]; replacement_requests: NeedsListItem[] } {
  const expiring: string[] = []; const expired: string[] = []; const replacement_requests: NeedsListItem[] = [];
  const out = docs.map((d) => {
    if (d.application_id !== s.application_id || d.status === "superseded" || d.status === "quarantined" || d.status === "failed" || !d.document_date) return d;
    const fr = computeFreshness({ doc_class: d.doc_class, document_date: d.document_date, scheduled_note_date: s.scheduled_note_date, as_of: s.as_of });
    if (fr.status === "n_a" || fr.status === d.freshness_status && fr.expires_at === d.expires_at) return { ...d, freshness_status: fr.status, expires_at: fr.expires_at };
    if (fr.status === "expired") { expired.push(d.document_id); append(events, "document.expired", s.application_id, { document_id: d.document_id, doc_class: d.doc_class, expires_at: fr.expires_at, scheduled_note_date: s.scheduled_note_date }, actor); }
    else if (fr.status === "expiring") { expiring.push(d.document_id); append(events, "document.expiring", s.application_id, { document_id: d.document_id, doc_class: d.doc_class, expires_at: fr.expires_at, scheduled_note_date: s.scheduled_note_date, warn_on: fr.warn_on }, actor); }
    if ((fr.status === "expired" || fr.status === "expiring") && d.subject_borrower_id) replacement_requests.push({ borrower_id: d.subject_borrower_id, doc_class: d.doc_class, qualifier: { ...(typeof d.fields?.account_last4 === "string" ? { account_last4: d.fields.account_last4 } : {}), replaces_document_id: d.document_id }, reason_code: "sm_freshness", reason_text: `a more recent ${d.doc_class.replace(/_/g, " ")} — the one dated ${shortDate(d.document_date)} will be more than four months old on the scheduled note date ${shortDate(s.scheduled_note_date)} (Selling Guide B1-1-03)` });
    return { ...d, freshness_status: fr.status, expires_at: fr.expires_at, ...(fr.status === "expired" ? { status: "expired" as DocumentState } : {}) };
  });
  return { docs: out, expiring, expired, replacement_requests };
}

// ============================================================ decision record
/** `agent_decisions` payload shape the spec names: `{document_id | request_id, inputs, classification, integrity, freshness, action, rationale, confidence, escalation_id?}`. */
export function decisionRecord(d: { document_id?: string | null; request_id?: string | null; inputs: Record<string, unknown>; classification?: { class: string; confidence: number | null } | null; integrity?: { checks: readonly { check_type: string; result: string }[]; aggregate: IntegrityStatus } | null; freshness?: Freshness | null; action: string; rationale: string; confidence: number | null; escalation_id?: string | null; model_version: string; prompt_version: string }): Record<string, unknown> {
  nonEmpty(d.action, "action"); nonEmpty(d.rationale, "rationale");
  return { document_id: d.document_id ?? null, request_id: d.request_id ?? null, inputs: { ...d.inputs, rule_set_version: RULE_SET_VERSION }, classification: d.classification ?? null, integrity: d.integrity ?? null, freshness: d.freshness ?? null, action: d.action, rationale: d.rationale, confidence: d.confidence, escalation_id: d.escalation_id ?? null, rule_set_version: RULE_SET_VERSION, model_version: d.model_version, prompt_version: d.prompt_version };
}
/** Unclassified after two passes → the borrower is asked in the portal; still unclassified after the answer → `human_agent`. */
export function unclassifiedFollowUp(passes: number, borrower_answered: boolean): "second_pass_400dpi" | "ask_borrower" | "human_agent" {
  if (passes < 2) return "second_pass_400dpi";
  return borrower_answered ? "human_agent" : "ask_borrower";
}
/** The scheduled note date from the latest `closing.scheduled` (or reschedule) event of the application. */
export function scheduledNoteDate(events: EventStore, applicationId: string): PlainDate | null {
  const es = events.all().filter((e) => e.applicationId === applicationId && (e.type === "closing.scheduled" || e.type === "closing.rescheduled"));
  const last = es.at(-1); if (!last) return null;
  const p = last.payload as Record<string, unknown>;
  const v = p.scheduled_note_date ?? p.note_date ?? p.scheduled_at;
  return typeof v === "string" ? (isDate(v) ? D(v) : civilDate(v)) : null;
}
/** Reg B: `daysBetween` re-exported for the tools' SLA arithmetic. */
export { daysBetween };
