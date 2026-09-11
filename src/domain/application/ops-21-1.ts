/**
 * §21.1 Conversational URLA/1003 intake — the pure rules of the `intake` agent over the `applications` aggregate
 * (migration 0057: applications, application_borrowers, restricted_fl.applicant_demographics). One small function per
 * rule / T-id; every function validates, mutates a copy of the intake record and appends its event with
 * `applicationId` (the timer engine arms origination rows only on origination context — src/kernel/timers/engine.ts).
 *
 * Events (subject = the application):
 *   application.received{application_id, application_date, hmda_application_date, transaction_type, occupancy}   [Reg B request; arms the three gates + 21.6's clock]
 *   application.six_item.captured{item, source, submitted_at}
 *   application.trid_received{application_id, trid_received_at, trid_application_date}   [once; 21.2's REGZ_1026_19E1_LE_3BD arms on it; SM_O21_INTAKE_ABANDON_30 stops]
 *   application.borrower.added{borrower_id, role, joint_intent_required}   [arms SM_O21_JOINT_INTENT_GATE for a co-borrower]
 *   application.joint_intent.affirmed{borrower_id, method, evidence_id, all_borrowers}
 *   application.demographics.collected{borrower_id, collection_method, declined_ethnicity, declined_race, declined_sex, all_borrowers}
 *   application.scif.presented{borrower_id, language_edition, presented_at, all_borrowers} · application.scif.completed{borrower_id}
 *   application.initial_1003.signed{borrower_id, document_id, all_borrowers} · application.arm_interest.recorded{fnma_plan_number, channel} (21.3 defines)
 *   application.mlo_of_record.assigned{mlo_of_record_id, nmlsr_id, state} · application.mlo_of_record.reassigned{previous_mlo_of_record_id, mlo_of_record_id, nmlsr_id, reason}
 *   application.mlo_of_record.status_changed{nmlsr_id, status, gate_open}   [31.1's nightly NMLS feed]
 *   escalation.opened{role=mlo_of_record, stage, state, escalation_id, opened_at}   [arms SM_O21_MLO_REVIEW_SLA_1BD; 31.1's SM_LICENSE_STATE_GATE trigger]
 *   application.mlo.approved{stage} | application.mlo.returned{stage}   [satisfy SM_O21_MLO_REVIEW_SLA_1BD; `approved{stage=application}` opens SAFE_1008_103_MLO_OF_RECORD_GATE]
 *   application.abandoned{last_activity_at, abandon_at, purge, retain_until} · application.intake_complete
 *   interview.ai_disclosure.given{utterance_id} · interview.human_agent.requested · interview.utterance.blocked{classification, gate, fallback}
 *   interview.prohibited_inquiry.detected{findings, prompt_version} · prompt.version.quarantined{prompt_version} · safe_activity.logged{classification, presented_under_mlo_id, flag_mode}
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, addMonths, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { type Cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";

export const INTAKE_AGENT: Actor = { kind: "agent", id: "intake" };
export const RULE_SET_VERSION_21_1 = "urla.intake.2026.v1";
export const URLA_FORM_VERSION = "1/2021";
export const ULAD_VERSION = "MISMO 3.4 B324";
export const SCIF_FORM_VERSION = "5/2022";
export const SCIF_TEMPLATE = "NTC_FNMA_1103_SCIF";
export const AI_DISCLOSURE_TEMPLATE = "NTC_SM_AI_INTERACTION_DISCLOSURE";
export const ESIGN_CONSENT_TEMPLATE = "NTC_SM_ESIGN_CONSENT";
export const SAFE_GATE = "SAFE_1008_103_MLO_OF_RECORD_GATE";
/** Feature flag `origination.ai_mlo_intake` (feature_flags, 0057): default "assisted". */
export const AI_INTAKE_MODES = ["assisted", "supervised_present", "autonomous"] as const;
export type AiIntakeMode = (typeof AI_INTAKE_MODES)[number];
export const DEFAULT_AI_INTAKE_MODE: AiIntakeMode = "assisted";
/** Rule 1: an inactive file is abandoned 30 calendar days after the last borrower activity, only before `trid_received`. */
export const INTAKE_ABANDON_DAYS = 30;
/** Reg B §1002.12(b)(1): 25 months from the notice / application for a received application. */
export const REGB_RETENTION_MONTHS = 25;
/** §1002.7(d)(4) community-property states where a non-borrowing spouse signs the security instrument, never the note. */
export const COMMUNITY_PROPERTY_STATES: readonly string[] = ["AZ", "CA", "ID", "LA", "NV", "NM", "TX", "WA", "WI"];

// ============================================================ ULAD enumerations (rule: every field validated as it goes)
export const ULAD_ENUMS = {
  borrower_role: ["borrower", "co_borrower", "non_occupant_co_borrower", "non_borrowing_spouse", "trustee"],
  marital_status: ["married", "unmarried", "separated"],                                              // §1002.5(d)(1)
  citizenship_status: ["us_citizen", "permanent_resident", "non_permanent_resident"],                // URLA 1a
  language_preference: ["english", "chinese", "korean", "spanish", "tagalog", "vietnamese", "other", "not_answered"],   // Form 1103
  intake_channel: ["voice", "chat", "web", "human_agent"],
  collection_method: ["telephone", "internet", "mail", "in_person", "video"],
  transaction_type: ["purchase", "limited_cash_out", "cash_out"],
  occupancy: ["primary", "second_home", "investment"],
  property_type: ["sfr", "condo", "pud", "2_4_unit", "manufactured"],
  joint_intent_method: ["esign_initials", "web_checkbox", "voice_attestation_recorded"],
  education_format: ["attended_workshop_in_person", "completed_web_based_workshop"],
  counseling_format: ["face_to_face", "telephone", "internet", "hybrid"],
  six_item_source: ["borrower_stated", "borrower_confirmed_prefill"],
} as const;
export type UladField = keyof typeof ULAD_ENUMS;
/** Validate one captured value against its ULAD/URLA enumeration; unknown fields are free text (validated by shape elsewhere). */
export function validateUlad(field: string, value: unknown): { valid: boolean; field: string; allowed: readonly string[] | null; reason: string | null } {
  const allowed = (ULAD_ENUMS as Record<string, readonly string[]>)[field] ?? null;
  if (!allowed) return { valid: true, field, allowed: null, reason: null };
  return allowed.includes(String(value)) ? { valid: true, field, allowed, reason: null } : { valid: false, field, allowed, reason: `${field} ${JSON.stringify(value)} is not one of ${allowed.join("/")} (${ULAD_VERSION})` };
}
const enumOrThrow = (field: UladField, value: unknown): string => { const v = validateUlad(field, value); if (!v.valid) throw new RangeError(v.reason!); return String(value); };
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isoInstant = (v: unknown, what: string): string => { const s = nonEmpty(v, what); if (Number.isNaN(Date.parse(s))) throw new RangeError(`${what} ${JSON.stringify(v)} is not an ISO instant`); return s; };
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// ============================================================ the intake record (applications + application_borrowers + demographics)
export type SixItemKey = "name" | "income" | "ssn" | "property_address" | "property_value_estimate" | "loan_amount_sought";
export const SIX_ITEMS: readonly SixItemKey[] = ["name", "income", "ssn", "property_address", "property_value_estimate", "loan_amount_sought"];
export type SixItemSource = "borrower_stated" | "borrower_confirmed_prefill" | "prefill_unconfirmed";
/** `applications.six_items` entry: a prefilled item carries `source='prefill_unconfirmed'` and `submitted_at=null` until the borrower confirms it (open question 2). */
export interface SixItem { readonly submitted_at: string | null; readonly source: SixItemSource | null; readonly value_hash: string | null; }
export const EMPTY_ITEM: SixItem = { submitted_at: null, source: null, value_hash: null };
export type CollectionMethod = (typeof ULAD_ENUMS.collection_method)[number];
/** restricted_fl.applicant_demographics row (never inferred; the two 0057 CHECK constraints are mirrored in `demographicsRow`). */
export interface DemographicsRow {
  readonly collection_method: CollectionMethod;
  /** 0057 `collection_channel` (in_person | telephone | internet | mail): `video` is not in person (open question 3) and lands as `internet`. */
  readonly collection_channel: "in_person" | "telephone" | "internet" | "mail";
  readonly ethnicity: readonly string[] | null; readonly race: readonly string[] | null; readonly sex: string | null;
  readonly declined_ethnicity: boolean; readonly declined_race: boolean; readonly declined_sex: boolean;
  readonly visual_observation_used: boolean; readonly collected_at: string;
  /** 28.3 reads: more than one race selected → FIG race codes 1–5 each reported (up to five), never collapsed. */
  readonly multiple_races_selected: boolean; readonly multiple_ethnicities_selected: boolean;
  /** FIG code 3 "Information not provided by applicant in mail, internet, or telephone application" applies per field when declined and not in person. */
  readonly hmda_not_provided_code_applies: boolean;
}
export interface ScifForm { readonly form_version: string; readonly language_edition: string; readonly presented_at: string; readonly completed_at: string | null; readonly rendered_document_id: string | null; readonly retention_class: "fnma_loan_file_life_plus_4y"; }
export interface EducationAnswer { readonly completed: boolean; readonly format: string | null; readonly agency_hud_id: string | null; readonly agency_name: string | null; readonly completed_on: PlainDate | null; }
export interface IntakeBorrower {
  readonly id: string; readonly legal_name: string; readonly borrower_role: (typeof ULAD_ENUMS.borrower_role)[number];
  readonly marital_status: (typeof ULAD_ENUMS.marital_status)[number] | null; readonly unmarried_addendum_required: boolean;
  readonly citizenship_status: (typeof ULAD_ENUMS.citizenship_status)[number] | null; readonly legal_presence_evidence_document_id: string | null; readonly legal_presence_expires_on: PlainDate | null;
  /** §1002.7(d)(4): a non-borrowing spouse signs the security instrument only — no credit data are requested. */
  readonly credit_requested: boolean; readonly added_at: string;
  readonly joint_intent_affirmed_at: string | null; readonly joint_intent_method: (typeof ULAD_ENUMS.joint_intent_method)[number] | null; readonly joint_intent_evidence_id: string | null;
  /** Section 6 accuracy attestation artifact — always distinct from the joint-intent artifact (comment 7(d)(1)-3). */
  readonly accuracy_attestation_id: string | null;
  readonly language_preference: (typeof ULAD_ENUMS.language_preference)[number] | null; readonly language_preference_other: string | null;
  readonly homeownership_education: EducationAnswer | null; readonly housing_counseling: EducationAnswer | null;
  readonly scif: ScifForm | null; readonly demographics: DemographicsRow | null;
  readonly initial_1003_signed_at: string | null; readonly initial_1003_document_id: string | null;
}
export type IntakeStatus = "started" | "received" | "trid_received" | "intake_complete" | "human_agent_active" | "mlo_returned" | "abandoned";
export type MloReviewState = "unassigned" | "pending" | "approved" | "returned";
export interface SafeActivityEntry { readonly at: string; readonly utterance_id: string; readonly classification: SafeClassification; readonly presented_under_mlo_id: string | null; readonly flag_mode: AiIntakeMode; readonly allowed: boolean; }
export interface InterviewSession { readonly session_id: string; readonly channel: (typeof ULAD_ENUMS.intake_channel)[number]; readonly started_at: string; readonly ended_at: string | null; readonly ai_disclosure_given_at: string | null; readonly transcript_document_id: string | null; readonly model_version: string; readonly prompt_version: string; readonly human_agent_requested_at: string | null; readonly human_agent_id: string | null; }
export interface MloReview { readonly escalation_id: string; readonly application_id: string; readonly mlo_of_record_id: string; readonly stage: "application" | "le_terms" | "lock" | "relock" | "other"; readonly package_document_id: string | null; readonly decision: "approved" | "returned" | "reassigned" | null; readonly opened_at: string; readonly decided_at: string | null; readonly notes: string | null; }
export interface IntakeApplication {
  readonly id: string; readonly status: IntakeStatus; readonly partner_name: string; readonly partner_nmlsr_id: string | null;
  readonly intake_channel: (typeof ULAD_ENUMS.intake_channel)[number]; readonly interview_language: string;
  /** The creditor's (partner's) time zone: `application_date` / `trid_application_date` are its civil dates (21.2: "creditor time zone"). */
  readonly creditor_time_zone: string; readonly property_state: string | null; readonly property_address: string | null;
  readonly transaction_type: (typeof ULAD_ENUMS.transaction_type)[number] | null; readonly occupancy: (typeof ULAD_ENUMS.occupancy)[number] | null;
  readonly ai_intake_mode: AiIntakeMode; readonly ai_disclosure_utterance_id: string | null;
  readonly application_received_at: string | null; readonly application_date: PlainDate | null; readonly hmda_application_date: PlainDate | null;
  readonly trid_received_at: string | null; readonly trid_application_date: PlainDate | null;
  readonly six_items: Record<SixItemKey, SixItem>; readonly loan_amount_sought_cents: Cents | null; readonly property_value_estimate_cents: Cents | null; readonly income_monthly_cents: Cents | null;
  readonly borrowers: readonly IntakeBorrower[];
  readonly mlo_of_record_id: string | null; readonly mlo_name: string | null; readonly mlo_nmlsr_id: string | null; readonly mlo_nmls_status: "active" | "inactive" | null; readonly mlo_licensed_states: readonly string[]; readonly mlo_assignment_at: string | null; readonly mlo_review_state: MloReviewState;
  readonly mlo_reviews: readonly MloReview[]; readonly safe_activity_log: readonly SafeActivityEntry[]; readonly interview_sessions: readonly InterviewSession[];
  readonly initial_1003_document_id: string | null; readonly initial_1003_signed_at: string | null; readonly initial_1003_data_hash: string | null;
  readonly urla_form_version: string; readonly ulad_version: string;
  readonly last_activity_at: string; readonly abandon_at: PlainDate; readonly retention_class: "pre_application_purge" | "regb_25m";
  readonly arm_interest_recorded: boolean;
}
export interface NewIntakeInput {
  readonly id: string; readonly partner_name: string; readonly partner_nmlsr_id?: string | null; readonly intake_channel: string; readonly started_at: string;
  readonly creditor_time_zone?: string; readonly interview_language?: string; readonly property_state?: string | null; readonly property_address?: string | null;
  readonly transaction_type?: string | null; readonly occupancy?: string | null; readonly ai_intake_mode?: string | null; readonly borrowers?: readonly { id: string; legal_name: string; borrower_role?: string; marital_status?: string | null }[];
}
export function newBorrower(b: { id: string; legal_name: string; borrower_role?: string; marital_status?: string | null; citizenship_status?: string | null; added_at: string }): IntakeBorrower {
  const role = enumOrThrow("borrower_role", b.borrower_role ?? "borrower") as IntakeBorrower["borrower_role"];
  const marital = b.marital_status == null ? null : (enumOrThrow("marital_status", b.marital_status) as IntakeBorrower["marital_status"]);
  return { id: nonEmpty(b.id, "borrower id"), legal_name: nonEmpty(b.legal_name, "legal_name"), borrower_role: role, marital_status: marital, unmarried_addendum_required: marital === "unmarried", citizenship_status: b.citizenship_status == null ? null : (enumOrThrow("citizenship_status", b.citizenship_status) as IntakeBorrower["citizenship_status"]),
    legal_presence_evidence_document_id: null, legal_presence_expires_on: null, credit_requested: role !== "non_borrowing_spouse", added_at: b.added_at, joint_intent_affirmed_at: null, joint_intent_method: null, joint_intent_evidence_id: null, accuracy_attestation_id: null,
    language_preference: null, language_preference_other: null, homeownership_education: null, housing_counseling: null, scif: null, demographics: null, initial_1003_signed_at: null, initial_1003_document_id: null };
}
/** A `started` application (the runtime's createApplication row) as the intake record; `ai_intake_mode` snapshots the feature flag (default "assisted"). */
export function newIntakeApplication(i: NewIntakeInput): IntakeApplication {
  const started_at = isoInstant(i.started_at, "started_at"); const tz = i.creditor_time_zone ?? "America/New_York";
  const mode = (i.ai_intake_mode ?? DEFAULT_AI_INTAKE_MODE) as AiIntakeMode; if (!AI_INTAKE_MODES.includes(mode)) throw new RangeError(`ai_intake_mode ${mode} is not one of ${AI_INTAKE_MODES.join("/")}`);
  return { id: nonEmpty(i.id, "application id"), status: "started", partner_name: nonEmpty(i.partner_name, "partner_name"), partner_nmlsr_id: i.partner_nmlsr_id ?? null, intake_channel: enumOrThrow("intake_channel", i.intake_channel) as IntakeApplication["intake_channel"], interview_language: i.interview_language ?? "en-US",
    creditor_time_zone: tz, property_state: i.property_state ?? null, property_address: i.property_address ?? null, transaction_type: i.transaction_type == null ? null : (enumOrThrow("transaction_type", i.transaction_type) as IntakeApplication["transaction_type"]), occupancy: i.occupancy == null ? null : (enumOrThrow("occupancy", i.occupancy) as IntakeApplication["occupancy"]),
    ai_intake_mode: mode, ai_disclosure_utterance_id: null, application_received_at: null, application_date: null, hmda_application_date: null, trid_received_at: null, trid_application_date: null,
    six_items: { name: EMPTY_ITEM, income: EMPTY_ITEM, ssn: EMPTY_ITEM, property_address: EMPTY_ITEM, property_value_estimate: EMPTY_ITEM, loan_amount_sought: EMPTY_ITEM }, loan_amount_sought_cents: null, property_value_estimate_cents: null, income_monthly_cents: null,
    borrowers: (i.borrowers ?? []).map((b) => newBorrower({ ...b, added_at: started_at })), mlo_of_record_id: null, mlo_name: null, mlo_nmlsr_id: null, mlo_nmls_status: null, mlo_licensed_states: [], mlo_assignment_at: null, mlo_review_state: "unassigned",
    mlo_reviews: [], safe_activity_log: [], interview_sessions: [], initial_1003_document_id: null, initial_1003_signed_at: null, initial_1003_data_hash: null, urla_form_version: URLA_FORM_VERSION, ulad_version: ULAD_VERSION,
    last_activity_at: started_at, abandon_at: addDays(civilDate(started_at, tz), INTAKE_ABANDON_DAYS), retention_class: "pre_application_purge", arm_interest_recorded: false };
}
export const civilDate = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
const borrowerOf = (app: IntakeApplication, id: string): IntakeBorrower => { const b = app.borrowers.find((x) => x.id === id); if (!b) throw new RangeError(`no borrower ${id} on application ${app.id}`); return b; };
const withBorrower = (app: IntakeApplication, id: string, patch: Partial<IntakeBorrower>): IntakeApplication => ({ ...app, borrowers: app.borrowers.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
/** Borrowers the form's obligations attach to (a non-borrowing spouse is never asked for credit, SCIF or demographic information). */
export const creditBorrowers = (app: IntakeApplication): readonly IntakeBorrower[] => app.borrowers.filter((b) => b.credit_requested);
const emit = (events: EventStore, app: IntakeApplication, type: string, payload: Record<string, unknown>, at: string, actor: Actor = INTAKE_AGENT): DomainEvent =>
  events.append({ type, applicationId: app.id, aggregate: { kind: "application", id: app.id }, actor, occurredAt: at, payload: { application_id: app.id, ...payload } });
/** Borrower activity resets the abandon clock (rule: "+30 calendar_days (reset on activity; stops at trid_received)"). */
const touched = (app: IntakeApplication, at: string): IntakeApplication => (app.trid_received_at ? { ...app, last_activity_at: at } : { ...app, last_activity_at: at, abandon_at: addDays(civilDate(at, app.creditor_time_zone), INTAKE_ABANDON_DAYS) });

// ============================================================ interview session, AI disclosure, human hand-off
export function startInterview(events: EventStore, app: IntakeApplication, s: { session_id: string; channel?: string; started_at: string; model_version: string; prompt_version: string }): { app: IntakeApplication; session: InterviewSession; event: DomainEvent } {
  const started_at = isoInstant(s.started_at, "started_at"); nonEmpty(s.model_version, "model_version"); nonEmpty(s.prompt_version, "prompt_version");
  if (app.interview_sessions.some((x) => x.session_id === s.session_id)) throw new RangeError(`interview session ${s.session_id} already exists`);
  const session: InterviewSession = { session_id: nonEmpty(s.session_id, "session_id"), channel: enumOrThrow("intake_channel", s.channel ?? app.intake_channel) as InterviewSession["channel"], started_at, ended_at: null, ai_disclosure_given_at: null, transcript_document_id: null, model_version: s.model_version, prompt_version: s.prompt_version, human_agent_requested_at: null, human_agent_id: null };
  const next = touched({ ...app, interview_sessions: [...app.interview_sessions, session] }, started_at);
  return { app: next, session, event: emit(events, next, "interview.session.started", { session_id: session.session_id, channel: session.channel, model_version: session.model_version, prompt_version: session.prompt_version, ai_intake_mode: app.ai_intake_mode }, started_at) };
}
/** Baseline addendum §8 item 10: the AI discloses automation at the start of every voice/chat interaction (20.3's NTC_SM_AI_INTERACTION_DISCLOSURE; the evidence is the utterance id / screen acknowledgement). */
export function discloseAi(events: EventStore, app: IntakeApplication, d: { session_id: string; utterance_id: string; at: string; state?: string | null }): { app: IntakeApplication; event: DomainEvent } {
  const at = isoInstant(d.at, "at"); nonEmpty(d.utterance_id, "utterance_id");
  const session = app.interview_sessions.find((x) => x.session_id === d.session_id); if (!session) throw new RangeError(`no interview session ${d.session_id}`);
  const next: IntakeApplication = { ...app, ai_disclosure_utterance_id: app.ai_disclosure_utterance_id ?? d.utterance_id, interview_sessions: app.interview_sessions.map((x) => (x.session_id === d.session_id ? { ...x, ai_disclosure_given_at: x.ai_disclosure_given_at ?? at } : x)) };
  return { app: next, event: emit(events, next, "interview.ai_disclosure.given", { session_id: d.session_id, utterance_id: d.utterance_id, template: AI_DISCLOSURE_TEMPLATE, state: d.state ?? app.property_state ?? null }, at) };
}
/** Guardrail "never continue if the borrower asks for a human": the session flips to `human_agent_active`, data captured so far is preserved. */
export function requestHumanAgent(events: EventStore, app: IntakeApplication, r: { session_id: string; at: string; reason?: string }): { app: IntakeApplication; event: DomainEvent } {
  const at = isoInstant(r.at, "at"); if (!app.interview_sessions.some((x) => x.session_id === r.session_id)) throw new RangeError(`no interview session ${r.session_id}`);
  const next: IntakeApplication = { ...app, status: app.status === "started" || app.status === "received" || app.status === "trid_received" ? "human_agent_active" : app.status, interview_sessions: app.interview_sessions.map((x) => (x.session_id === r.session_id ? { ...x, human_agent_requested_at: at } : x)) };
  return { app: next, event: emit(events, next, "interview.human_agent.requested", { session_id: r.session_id, reason: r.reason ?? "borrower_request" }, at) };
}
/** Voice recognition ambiguity: three consecutive failed captures of the same field → `human_agent` (AI agent design escalations). */
export const CAPTURE_FAILURES_TO_HUMAN = 3;
export function captureFailureRoute(consecutiveFailures: number): { escalate: "human_agent" | null } { return { escalate: consecutiveFailures >= CAPTURE_FAILURES_TO_HUMAN ? "human_agent" : null }; }

// ============================================================ rule 1: three application dates
/** Reg B application (`received`): the borrower requests credit for a stated transaction type and occupancy; property or "to be determined". Also the HMDA application date (open question 6). */
export function receiveApplication(events: EventStore, app: IntakeApplication, r: { at: string; transaction_type: string; occupancy: string; property_state?: string | null; property_address?: string | null; identity_verified?: boolean; esign_consent_active?: boolean; e_delivery?: boolean }): { app: IntakeApplication; event: DomainEvent | null; application_date: PlainDate } {
  const at = isoInstant(r.at, "at");
  if (app.application_received_at) return { app, event: null, application_date: app.application_date! };
  if (r.identity_verified === false) throw new RangeError("`received` requires identity verification (state-machine guard)");
  if (r.e_delivery && r.esign_consent_active === false) throw new RangeError("`received` by e-delivery requires an active consents.esign (state-machine guard)");
  const application_date = civilDate(at, app.creditor_time_zone);
  const next = touched({ ...app, status: app.status === "started" ? "received" : app.status, transaction_type: enumOrThrow("transaction_type", r.transaction_type) as IntakeApplication["transaction_type"], occupancy: enumOrThrow("occupancy", r.occupancy) as IntakeApplication["occupancy"],
    property_state: r.property_state ?? app.property_state, property_address: r.property_address ?? app.property_address, application_received_at: at, application_date, hmda_application_date: application_date, retention_class: "regb_25m" }, at);
  return { app: next, application_date, event: emit(events, next, "application.received", { application_date, hmda_application_date: application_date, application_received_at: at, transaction_type: next.transaction_type, occupancy: next.occupancy, property_state: next.property_state, source: "origination" }, at) };
}

// ============================================================ rule 2: six-item detection (TRID application)
export interface CaptureInput { readonly item: SixItemKey; readonly value: string | Cents; readonly at: string; readonly borrower_id?: string; readonly source?: "borrower_stated" | "borrower_confirmed_prefill"; }
const itemValue = (item: SixItemKey, value: string | Cents): { hash: string; cents: Cents | null } => {
  if (item === "income" || item === "property_value_estimate" || item === "loan_amount_sought") {
    const cents = typeof value === "bigint" ? value : BigInt(String(value).replace(/[^0-9-]/g, "") || "0");
    if (cents <= 0n) throw new RangeError(`${item} must be a positive amount in cents`);
    return { hash: sha256(`${item}:${cents}`), cents };
  }
  const s = nonEmpty(typeof value === "bigint" ? String(value) : value, item);
  if (item === "property_address" && /^\s*(tbd|to be determined|n\/?a)\s*$/i.test(s)) throw new RangeError("property_address 'TBD' does not satisfy the TRID item (rule 2) — the file stays `received`, not `trid_received`");
  if (item === "ssn" && !/^\d{3}-?\d{2}-?\d{4}$/.test(s)) throw new RangeError("ssn must be nine digits (read back and confirmed on voice)");
  return { hash: sha256(`${item}:${s}`), cents: null };
};
const withItem = (app: IntakeApplication, item: SixItemKey, entry: SixItem, cents: Cents | null): IntakeApplication => ({ ...app, six_items: { ...app.six_items, [item]: entry },
  ...(item === "loan_amount_sought" ? { loan_amount_sought_cents: cents } : item === "property_value_estimate" ? { property_value_estimate_cents: cents } : item === "income" ? { income_monthly_cents: cents } : {}) });
/** A borrower-stated item: `submitted_at` = the utterance time, `source=borrower_stated` (an AVM SM holds is never the borrower's value estimate). */
export function captureSixItem(events: EventStore, app: IntakeApplication, c: CaptureInput): { app: IntakeApplication; event: DomainEvent; trid: ReturnType<typeof detectSixItems> } {
  if (!SIX_ITEMS.includes(c.item)) throw new RangeError(`item ${String(c.item)} is not one of ${SIX_ITEMS.join("/")}`);
  const at = isoInstant(c.at, "at"); const { hash, cents } = itemValue(c.item, c.value); const source = c.source ?? "borrower_stated";
  if (source === "borrower_confirmed_prefill") throw new RangeError("a prefill is submitted only through confirmPrefill (borrower's explicit item-level confirmation)");
  if (c.item === "property_address" && typeof c.value === "string") { const m = /\b([A-Z]{2})\b\s*\d{5}(?:-\d{4})?\s*$/.exec(c.value); app = { ...app, property_address: c.value, property_state: m?.[1] ?? app.property_state }; }
  const next = touched(withItem(app, c.item, { submitted_at: at, source, value_hash: hash }, cents), at);
  const event = emit(events, next, "application.six_item.captured", { item: c.item, source, submitted_at: at, borrower_id: c.borrower_id ?? null }, at);
  const trid = detectSixItems(events, next, at);
  return { app: trid.app, event, trid };
}
/** Refinance-trigger prefill (20.1): a suggestion, not a submission — `submitted_at` stays null until the borrower confirms it. */
export function offerPrefill(app: IntakeApplication, item: SixItemKey, value: string | Cents, o: { readonly on_file_value_hash?: string | null } = {}): IntakeApplication {
  if (!SIX_ITEMS.includes(item)) throw new RangeError(`item ${String(item)} is not one of ${SIX_ITEMS.join("/")}`);
  // 32.11 §3 (a serviced borrower's compressed application): an item already on the prior application's file is offered by that file's own value hash — the value is neither re-typed nor re-stated in clear (the SSN); the borrower still confirms it item by item (rule 1)
  const { hash } = o.on_file_value_hash ? { hash: nonEmpty(o.on_file_value_hash, "on_file_value_hash") } : itemValue(item, value);
  if (item === "property_address" && typeof value === "string") { const m = /\b([A-Z]{2})\b\s*\d{5}(?:-\d{4})?\s*$/.exec(value); app = { ...app, property_address: value, property_state: m?.[1] ?? app.property_state }; }
  return withItem(app, item, { submitted_at: null, source: "prefill_unconfirmed", value_hash: hash }, null);
}
/** The borrower's explicit confirmation of a prefilled item: only now is it "submitted" (`source=borrower_confirmed_prefill`, open question 2). */
export function confirmPrefill(events: EventStore, app: IntakeApplication, c: { item: SixItemKey; at: string; value?: string | Cents; borrower_id?: string }): { app: IntakeApplication; event: DomainEvent; trid: ReturnType<typeof detectSixItems> } {
  const at = isoInstant(c.at, "at"); const cur = app.six_items[c.item]; if (!cur) throw new RangeError(`item ${String(c.item)} is not one of ${SIX_ITEMS.join("/")}`);
  if (cur.source !== "prefill_unconfirmed" && c.value === undefined) throw new RangeError(`${c.item} has no prefill to confirm`);
  const v = c.value !== undefined ? itemValue(c.item, c.value) : { hash: cur.value_hash!, cents: null };
  const next = touched(withItem(app, c.item, { submitted_at: at, source: "borrower_confirmed_prefill", value_hash: v.hash }, v.cents), at);
  const event = emit(events, next, "application.six_item.captured", { item: c.item, source: "borrower_confirmed_prefill", submitted_at: at, borrower_id: c.borrower_id ?? null }, at);
  const trid = detectSixItems(events, next, at);
  return { app: trid.app, event, trid };
}
/** Six items: every item `submitted_at` set with `source ∈ {borrower_stated, borrower_confirmed_prefill}` → `trid_received_at` = max(submitted_at), emitted once. */
export function detectSixItems(events: EventStore, app: IntakeApplication, at: string): { app: IntakeApplication; complete: boolean; missing: SixItemKey[]; emitted: boolean; trid_received_at: string | null; trid_application_date: PlainDate | null; event: DomainEvent | null } {
  const missing = SIX_ITEMS.filter((k) => { const e = app.six_items[k]; return !e.submitted_at || !(ULAD_ENUMS.six_item_source as readonly string[]).includes(e.source ?? ""); });
  if (missing.length) return { app, complete: false, missing, emitted: false, trid_received_at: app.trid_received_at, trid_application_date: app.trid_application_date, event: null };
  if (app.trid_received_at) return { app, complete: true, missing: [], emitted: false, trid_received_at: app.trid_received_at, trid_application_date: app.trid_application_date, event: null };
  if (!app.application_received_at) throw new RangeError("six items cannot complete before the Reg B application is `received` (state machine: started → received → trid_received)");
  const trid_received_at = SIX_ITEMS.map((k) => app.six_items[k].submitted_at!).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  const trid_application_date = civilDate(trid_received_at, app.creditor_time_zone);
  const next: IntakeApplication = { ...app, status: app.status === "received" || app.status === "started" ? "trid_received" : app.status, trid_received_at, trid_application_date, last_activity_at: at };
  const event = emit(events, next, "application.trid_received", { trid_received_at, trid_application_date, application_date: next.application_date, items: Object.fromEntries(SIX_ITEMS.map((k) => [k, next.six_items[k].source])) }, at);
  return { app: next, complete: true, missing: [], emitted: true, trid_received_at, trid_application_date, event };
}
/** 21.2's Loan Estimate clock as 21.1 states it: `trid_application_date` + 3 `business_days_creditor` (Tue 6, Wed 7, Thu 8 for the Oct 5 fixture). */
export const leDueDate = (tridApplicationDate: PlainDate): PlainDate => addBusinessDays(tridApplicationDate, 3, creditor);
/** The offset-with-timezone form of an instant ("2026-10-05T10:41 MST" → "2026-10-05T10:41:00-07:00"). */
export function localIso(iso: string, tz: string): string {
  const ms = Date.parse(iso); const w = wallClock(ms, tz); const local = Date.UTC(...(w.date.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number], w.hour, w.minute, w.second);
  const off = Math.round((local - ms) / 60_000); const sign = off < 0 ? "-" : "+"; const a = Math.abs(off);
  return `${w.date}T${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:${String(w.second).padStart(2, "0")}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// ============================================================ borrowers, joint intent (§1002.7(d)), non-borrowing spouse
/** A second borrower is added only for joint credit; `joint_intent_required` marks the co-borrowers whose affirmation SM_O21_JOINT_INTENT_GATE waits on. */
export function addBorrower(events: EventStore, app: IntakeApplication, b: { id: string; legal_name: string; borrower_role?: string; marital_status?: string | null; citizenship_status?: string | null; at: string; legal_presence_evidence_document_id?: string | null; legal_presence_expires_on?: string | null }): { app: IntakeApplication; borrower: IntakeBorrower; event: DomainEvent } {
  const at = isoInstant(b.at, "at"); if (app.borrowers.some((x) => x.id === b.id)) throw new RangeError(`borrower ${b.id} already on application ${app.id}`);
  let borrower = newBorrower({ ...b, added_at: at });
  if (borrower.citizenship_status === "non_permanent_resident") { if (!b.legal_presence_evidence_document_id) throw new RangeError("a non_permanent_resident needs legal_presence_evidence_document_id (B2-2-02 rep and warrant of legal presence)"); borrower = { ...borrower, legal_presence_evidence_document_id: b.legal_presence_evidence_document_id, legal_presence_expires_on: b.legal_presence_expires_on ? plainDate(b.legal_presence_expires_on) : null }; }
  const joint_intent_required = borrower.credit_requested && creditBorrowers(app).length >= 1;
  const next = touched({ ...app, borrowers: [...app.borrowers, borrower] }, at);
  return { app: next, borrower, event: emit(events, next, "application.borrower.added", { borrower_id: borrower.id, role: borrower.borrower_role, joint_intent_required, credit_requested: borrower.credit_requested, borrower_count: next.borrowers.length }, at) };
}
/** §1002.7(d)(4): an Arizona (community-property) married applicant applying individually — the spouse is recorded for the security instrument only; never asked for credit information. */
export function nonBorrowingSpouse(events: EventStore, app: IntakeApplication, s: { applicant_id: string; spouse_id: string; spouse_name: string; at: string }): { app: IntakeApplication; spouse: IntakeBorrower | null; required: boolean; event: DomainEvent | null } {
  const applicant = borrowerOf(app, s.applicant_id);
  const required = applicant.marital_status === "married" && !!app.property_state && COMMUNITY_PROPERTY_STATES.includes(app.property_state) && !app.borrowers.some((b) => b.credit_requested && b.id !== applicant.id);
  if (!required) return { app, spouse: null, required, event: null };
  const r = addBorrower(events, app, { id: s.spouse_id, legal_name: s.spouse_name, borrower_role: "non_borrowing_spouse", marital_status: "married", at: s.at });
  return { app: r.app, spouse: r.borrower, required, event: r.event };
}
/** Comment 7(d)(1)-3: intent evidenced at application by a method distinct from the accuracy affirmation; captured before any credit report is ordered for that borrower. */
export function affirmJointIntent(events: EventStore, app: IntakeApplication, a: { borrower_id: string; method: string; evidence_id: string; at: string }): { app: IntakeApplication; event: DomainEvent; all_borrowers: boolean } {
  const at = isoInstant(a.at, "at"); const b = borrowerOf(app, a.borrower_id); nonEmpty(a.evidence_id, "evidence_id");
  if (!b.credit_requested) throw new RangeError(`${b.borrower_role} ${b.id} is not a joint applicant (§1002.7(d)(4): security-instrument signer only)`);
  if (b.accuracy_attestation_id && b.accuracy_attestation_id === a.evidence_id) throw new RangeError("joint-intent evidence must be an artifact distinct from the accuracy attestation (comment 7(d)(1)-3)");
  const method = enumOrThrow("joint_intent_method", a.method) as IntakeBorrower["joint_intent_method"];
  const next = touched(withBorrower(app, b.id, { joint_intent_affirmed_at: at, joint_intent_method: method, joint_intent_evidence_id: a.evidence_id }), at);
  const all_borrowers = creditBorrowers(next).every((x) => !!x.joint_intent_affirmed_at);
  return { app: next, all_borrowers, event: emit(events, next, "application.joint_intent.affirmed", { borrower_id: b.id, method, evidence_id: a.evidence_id, affirmed_at: at, all_borrowers }, at) };
}

// ============================================================ rule 3: demographic collection (Reg C App. B; Reg B §1002.13)
export interface DemographicsInput { readonly collection_method: string; readonly ethnicity?: readonly string[] | null; readonly race?: readonly string[] | null; readonly sex?: string | null; readonly declined_ethnicity?: boolean; readonly declined_race?: boolean; readonly declined_sex?: boolean; readonly visual_observation_used?: boolean; readonly collected_at: string; readonly inferred_from?: string | null; }
/** App. B instruction 2 statement, read/shown before the questions (verbatim). */
export const APPENDIX_B_STATEMENT = "Federal law requires this information to be collected in order to protect consumers and to monitor compliance with Federal statutes that prohibit discrimination.";
/** The restricted row with 0057's constraints mirrored: declined ⇒ no values; visual observation only in person; never inferred. */
export function demographicsRow(d: DemographicsInput): DemographicsRow {
  const method = enumOrThrow("collection_method", d.collection_method) as CollectionMethod;
  if (d.inferred_from) throw new RangeError(`demographic data are never inferred (from ${d.inferred_from}): only the applicant's own answers (App. B instruction 1; guardrail)`);
  const collected_at = isoInstant(d.collected_at, "collected_at");
  const declined_ethnicity = d.declined_ethnicity === true, declined_race = d.declined_race === true, declined_sex = d.declined_sex === true;
  const ethnicity = d.ethnicity && d.ethnicity.length ? [...d.ethnicity] : null, race = d.race && d.race.length ? [...d.race] : null, sex = d.sex || null;
  if (declined_ethnicity && ethnicity) throw new RangeError("applicant_demographics_declined_ethnicity: ethnicity must be null when declined_ethnicity (0057 CHECK)");
  if (declined_race && race) throw new RangeError("applicant_demographics_declined_race: race must be null when declined_race (0057 CHECK)");
  if (declined_sex && sex) throw new RangeError("sex must be null when declined_sex");
  const visual = d.visual_observation_used === true;
  if (visual && method !== "in_person") throw new RangeError(`applicant_demographics_no_observation_remote: visual observation/surname collection is lawful only for in-person applications (App. B instruction 10); collection_method=${method} (0057 CHECK)`);
  const collection_channel: DemographicsRow["collection_channel"] = method === "video" ? "internet" : method;
  return { collection_method: method, collection_channel, ethnicity, race, sex, declined_ethnicity, declined_race, declined_sex, visual_observation_used: visual, collected_at,
    multiple_races_selected: (race?.length ?? 0) > 1, multiple_ethnicities_selected: (ethnicity?.length ?? 0) > 1, hmda_not_provided_code_applies: method !== "in_person" && (declined_ethnicity || declined_race || declined_sex) };
}
export function askDemographics(events: EventStore, app: IntakeApplication, borrower_id: string, d: DemographicsInput): { app: IntakeApplication; row: DemographicsRow; event: DomainEvent; all_borrowers: boolean } {
  const b = borrowerOf(app, borrower_id); if (!b.credit_requested) throw new RangeError(`${b.borrower_role} ${b.id} is not an applicant: no demographic request`);
  if (b.demographics) throw new RangeError(`applicant_demographics row for ${b.id} is append-only (already collected ${b.demographics.collected_at})`);
  const row = demographicsRow(d); const next = touched(withBorrower(app, b.id, { demographics: row }), row.collected_at);
  const all_borrowers = creditBorrowers(next).every((x) => !!x.demographics);
  return { app: next, row, all_borrowers, event: emit(events, next, "application.demographics.collected", { borrower_id: b.id, collection_method: row.collection_method, declined_ethnicity: row.declined_ethnicity, declined_race: row.declined_race, declined_sex: row.declined_sex, visual_observation_used: row.visual_observation_used, multiple_races_selected: row.multiple_races_selected, all_borrowers }, row.collected_at) };
}
/** Prohibited inquiries (§1002.5): the interview never asks these; `compliance-sentinel` scans transcripts for them (T10). */
export const PROHIBITED_INQUIRIES: readonly { code: string; citation: string; pattern: RegExp }[] = [
  { code: "childbearing", citation: "§1002.5(d)(3)", pattern: /\b(child[- ]?bearing|plan(?:ning|s)? (?:to|on) (?:hav|start)\w* (?:a )?(?:child|children|family|baby|kids)|pregnan|birth control|family planning|more children|have kids)\b/i },
  { code: "religion", citation: "§1002.5(b)", pattern: /\b(religio|church|faith|denomination)\w*/i },
  { code: "national_origin", citation: "§1002.5(b)", pattern: /\b(national origin|where (?:are|were) you (?:born|from)|ancestry|country of birth)\b/i },
  { code: "race_color_outside_monitoring", citation: "§1002.5(b), (d)(3)", pattern: /\b(what (?:is|'s) your (?:race|color|ethnicity)|are you (?:black|white|asian|hispanic|latino))\b/i },
  { code: "sex_outside_monitoring", citation: "§1002.5(b)", pattern: /\b(are you (?:a )?(?:man|woman|male|female)|what (?:is|'s) your (?:sex|gender))\b/i },
];
export interface TranscriptUtterance { readonly utterance_id: string; readonly speaker: "agent" | "borrower" | "human_agent"; readonly text: string; readonly at?: string; readonly monitoring_section?: boolean; }
export interface TranscriptScan { readonly findings: { utterance_id: string; code: string; citation: string; excerpt: string }[]; readonly severity: 1 | null; readonly quarantine_prompt_version: string | null; }
/** `compliance-sentinel` scan: an agent utterance matching a prohibited inquiry (outside the Section 8 monitoring questions) is a sev-1 finding and quarantines the prompt version that produced it. */
export function scanTranscript(utterances: readonly TranscriptUtterance[], prompt_version: string): TranscriptScan {
  const findings: TranscriptScan["findings"] = [];
  for (const u of utterances) { if (u.speaker !== "agent" || u.monitoring_section) continue; for (const p of PROHIBITED_INQUIRIES) { const m = p.pattern.exec(u.text); if (m) findings.push({ utterance_id: u.utterance_id, code: p.code, citation: p.citation, excerpt: m[0] }); } }
  return { findings, severity: findings.length ? 1 : null, quarantine_prompt_version: findings.length ? prompt_version : null };
}
export function reportProhibitedInquiry(events: EventStore, escalations: EscalationService, app: IntakeApplication, scan: TranscriptScan, session_id: string, at: string): { escalation: Escalation | null; events: DomainEvent[] } {
  if (!scan.findings.length) return { escalation: null, events: [] };
  const session = app.interview_sessions.find((s) => s.session_id === session_id);
  const detected = emit(events, app, "interview.prohibited_inquiry.detected", { session_id, findings: scan.findings, prompt_version: scan.quarantine_prompt_version, model_version: session?.model_version ?? null, severity: 1 }, at, { kind: "agent", id: "compliance-sentinel" });
  const escalation = escalations.open({ kind: "sev1", ownerRole: "compliance", applicationId: app.id, severity: "1", payload: { reason: "prohibited_inquiry", citation: scan.findings.map((f) => f.citation).join("; "), findings: scan.findings, session_id, prompt_version: scan.quarantine_prompt_version } }, { kind: "agent", id: "compliance-sentinel" });
  const quarantined = emit(events, app, "prompt.version.quarantined", { prompt_version: scan.quarantine_prompt_version, reason: "prohibited_inquiry", escalation_id: escalation.id, agent: "intake" }, at, { kind: "agent", id: "compliance-sentinel" });
  return { escalation, events: [detected, quarantined] };
}

// ============================================================ rule 6: Form 1103 SCIF (presented to every borrower; optional to answer)
export const SCIF_LANGUAGE_EDITIONS = ["english", "spanish", "chinese_traditional", "vietnamese", "korean", "tagalog"] as const;
export interface ScifAnswers { readonly language_preference?: string | null; readonly language_preference_other?: string | null; readonly homeownership_education?: EducationAnswer | null; readonly housing_counseling?: EducationAnswer | null; }
export function presentScif(events: EventStore, app: IntakeApplication, borrower_id: string, p: { language_edition?: string; presented_at: string; rendered_document_id?: string | null; answers?: ScifAnswers | null; completed_at?: string | null }): { app: IntakeApplication; scif: ScifForm; events: DomainEvent[]; all_borrowers: boolean } {
  const b = borrowerOf(app, borrower_id); if (!b.credit_requested) throw new RangeError(`${b.borrower_role} ${b.id} is not an applicant: no SCIF`);
  const presented_at = isoInstant(p.presented_at, "presented_at"); const edition = p.language_edition ?? "english";
  if (!(SCIF_LANGUAGE_EDITIONS as readonly string[]).includes(edition)) throw new RangeError(`language_edition ${edition} is not one of ${SCIF_LANGUAGE_EDITIONS.join("/")} (Form 1103: English + five translations)`);
  const answers = p.answers ?? null; const completed_at = answers && Object.values(answers).some((v) => v != null) ? (p.completed_at ?? presented_at) : null;
  const language = answers?.language_preference == null ? "not_answered" : (enumOrThrow("language_preference", answers.language_preference) as IntakeBorrower["language_preference"]);
  const scif: ScifForm = { form_version: SCIF_FORM_VERSION, language_edition: edition, presented_at: b.scif?.presented_at ?? presented_at, completed_at, rendered_document_id: p.rendered_document_id ?? b.scif?.rendered_document_id ?? null, retention_class: "fnma_loan_file_life_plus_4y" };
  const next = touched(withBorrower(app, b.id, { scif, language_preference: language, language_preference_other: answers?.language_preference_other ?? null, homeownership_education: answers?.homeownership_education ?? b.homeownership_education, housing_counseling: answers?.housing_counseling ?? b.housing_counseling }), presented_at);
  const all_borrowers = creditBorrowers(next).every((x) => !!x.scif?.presented_at);
  const out = [emit(events, next, "application.scif.presented", { borrower_id: b.id, form_version: SCIF_FORM_VERSION, language_edition: edition, presented_at: scif.presented_at, template: SCIF_TEMPLATE, all_borrowers }, presented_at)];
  if (completed_at) out.push(emit(events, next, "application.scif.completed", { borrower_id: b.id, completed_at, language_preference: language, education_completed: answers?.homeownership_education?.completed ?? false, counseling_completed: answers?.housing_counseling?.completed ?? false }, completed_at));
  return { app: next, scif, events: out, all_borrowers };
}
/** B2-2-06 education requirement (seeds 22.1's needs list) and 20.4's SFC 184 counseling-credit test: counseling (not education) completed within the 12 months before closing. */
export function educationAndCounseling(i: { purchase: boolean; homeready: boolean; all_first_time_buyers: boolean; ltv_over_95: boolean; no_tradeline_du: boolean; education: EducationAnswer | null; counseling: EducationAnswer | null; closing_on: PlainDate }): { education_required: boolean; education_satisfied: boolean; sfc_184_counseling_credit: boolean; counseling_window_start: PlainDate } {
  const education_required = i.purchase && (i.no_tradeline_du || (i.homeready && i.all_first_time_buyers) || (i.ltv_over_95 && i.all_first_time_buyers));
  const education_satisfied = !education_required || (!!i.education?.completed && !!i.education.completed_on && i.education.completed_on <= i.closing_on);
  const counseling_window_start = addMonths(i.closing_on, -12);
  const sfc_184_counseling_credit = i.homeready && !!i.counseling?.completed && !!i.counseling.completed_on && i.counseling.completed_on >= counseling_window_start && i.counseling.completed_on <= i.closing_on;
  return { education_required, education_satisfied, sfc_184_counseling_credit, counseling_window_start };
}

// ============================================================ rule 7/8: MLO of record, review escalation, SLA, NMLS status, AI-intake mode
export interface MloRosterEntry { readonly mlo_id: string; readonly name: string; readonly nmlsr_id: string; readonly licensed_states: readonly string[]; readonly nmls_status: "active" | "inactive"; readonly open_queue: number; }
/** Rule 7: the partner's licensed MLO for the property state with the lowest open queue; NMLS status active per the nightly feed. */
export function selectMlo(roster: readonly MloRosterEntry[], state: string, exclude: readonly string[] = []): MloRosterEntry {
  const eligible = roster.filter((m) => m.nmls_status === "active" && m.licensed_states.includes(state) && !exclude.includes(m.mlo_id)).sort((a, b) => a.open_queue - b.open_queue || a.mlo_id.localeCompare(b.mlo_id));
  if (!eligible.length) throw new RangeError(`no active MLO of record licensed in ${state} on the partner's roster (31.1)`);
  return eligible[0]!;
}
export function assignMlo(events: EventStore, app: IntakeApplication, a: { roster: readonly MloRosterEntry[]; at: string }): { app: IntakeApplication; mlo: MloRosterEntry; event: DomainEvent } {
  const at = isoInstant(a.at, "at"); if (!app.property_state) throw new RangeError("the property state is needed to pick a licensed MLO of record");
  if (app.mlo_of_record_id) throw new RangeError(`MLO of record ${app.mlo_of_record_id} already assigned (reassign through reassignMlo)`);
  const mlo = selectMlo(a.roster, app.property_state);
  const next: IntakeApplication = { ...app, mlo_of_record_id: mlo.mlo_id, mlo_name: mlo.name, mlo_nmlsr_id: mlo.nmlsr_id, mlo_nmls_status: mlo.nmls_status, mlo_licensed_states: [...mlo.licensed_states], mlo_assignment_at: at, mlo_review_state: "pending" };
  return { app: next, mlo, event: emit(events, next, "application.mlo_of_record.assigned", { mlo_of_record_id: mlo.mlo_id, nmlsr_id: mlo.nmlsr_id, mlo_name: mlo.name, state: app.property_state, nmls_status: mlo.nmls_status, assigned_at: at }, at) };
}
/** Stage-`application` review package → `mlo_of_record` escalation; `escalation.opened{role=mlo_of_record, stage=application}` arms SM_O21_MLO_REVIEW_SLA_1BD (+1 business_days_creditor from opened_at). */
export function openMloReview(events: EventStore, escalations: EscalationService, app: IntakeApplication, r: { stage?: MloReview["stage"]; opened_at: string; package_document_id?: string | null }): { app: IntakeApplication; review: MloReview; escalation: Escalation; event: DomainEvent; sla_due: PlainDate } {
  const opened_at = isoInstant(r.opened_at, "opened_at"); if (!app.mlo_of_record_id) throw new RangeError("assign the MLO of record before opening the review escalation");
  const stage = r.stage ?? "application";
  const escalation = escalations.open({ kind: "mlo_of_record", applicationId: app.id, payload: { stage, mlo_of_record_id: app.mlo_of_record_id, nmlsr_id: app.mlo_nmlsr_id, state: app.property_state, package_document_id: r.package_document_id ?? null, package: ["initial_1003", "safe_activity_log", "pricing_scenario_shown", "open_questions"] } }, INTAKE_AGENT);
  const review: MloReview = { escalation_id: escalation.id, application_id: app.id, mlo_of_record_id: app.mlo_of_record_id, stage, package_document_id: r.package_document_id ?? null, decision: null, opened_at, decided_at: null, notes: null };
  const next: IntakeApplication = { ...app, mlo_review_state: "pending", mlo_reviews: [...app.mlo_reviews, review] };
  const event = emit(events, next, "escalation.opened", { escalation_id: escalation.id, role: "mlo_of_record", stage, state: app.property_state, opened_at, mlo_of_record_id: app.mlo_of_record_id, nmlsr_id: app.mlo_nmlsr_id }, opened_at);
  return { app: next, review, escalation, event, sla_due: addBusinessDays(civilDate(opened_at, "America/New_York"), 1, creditor) };
}
/** The MLO of record's decision on the package (a human act — `mlo_of_record` only): approved opens the SAFE gate for the stage; returned re-opens the interview (`mlo_returned`). */
export function decideMloReview(events: EventStore, app: IntakeApplication, d: { escalation_id: string; decision: "approved" | "returned"; decided_at: string; by: Actor; notes?: string | null }): { app: IntakeApplication; review: MloReview; event: DomainEvent } {
  const decided_at = isoInstant(d.decided_at, "decided_at"); const review = app.mlo_reviews.find((x) => x.escalation_id === d.escalation_id); if (!review) throw new RangeError(`no mlo_reviews row for escalation ${d.escalation_id}`);
  if (review.decision) throw new RangeError(`review ${d.escalation_id} already decided (${review.decision})`);
  if (!(d.by.kind === "human" && d.by.role === "mlo_of_record")) throw new RangeError(`the stage-${review.stage} review is decided by the mlo_of_record, not ${d.by.kind}:${d.by.id}`);
  if (d.decision !== "approved" && d.decision !== "returned") throw new RangeError("decision must be approved or returned");
  const decided: MloReview = { ...review, decision: d.decision, decided_at, notes: d.notes ?? null };
  const next: IntakeApplication = { ...app, mlo_review_state: review.stage === "application" ? d.decision : app.mlo_review_state, status: d.decision === "returned" && review.stage === "application" ? "mlo_returned" : app.status, mlo_reviews: app.mlo_reviews.map((x) => (x.escalation_id === d.escalation_id ? decided : x)) };
  return { app: next, review: decided, event: emit(events, next, d.decision === "approved" ? "application.mlo.approved" : "application.mlo.returned", { escalation_id: d.escalation_id, stage: review.stage, mlo_of_record_id: review.mlo_of_record_id, nmlsr_id: app.mlo_nmlsr_id, decided_at, notes: d.notes ?? null }, decided_at, d.by) };
}
/** Reassignment (SLA breach, or NMLS status loss): the new NMLSR ID is logged before any LE renders; the old review is closed `reassigned` and a fresh stage review opens for the new MLO. */
export function reassignMlo(events: EventStore, escalations: EscalationService, app: IntakeApplication, r: { roster: readonly MloRosterEntry[]; at: string; reason: "sla_breach" | "nmls_inactive" | "other"; stage?: MloReview["stage"] }): { app: IntakeApplication; mlo: MloRosterEntry; previous: string | null; events: DomainEvent[]; review: MloReview; escalation: Escalation } {
  const at = isoInstant(r.at, "at"); if (!app.property_state) throw new RangeError("the property state is needed to pick a licensed MLO of record");
  const previous = app.mlo_of_record_id; const mlo = selectMlo(r.roster, app.property_state, previous ? [previous] : []);
  const closed = app.mlo_reviews.map((x) => (x.decision === null ? { ...x, decision: "reassigned" as const, decided_at: at, notes: r.reason } : x));
  let next: IntakeApplication = { ...app, mlo_of_record_id: mlo.mlo_id, mlo_name: mlo.name, mlo_nmlsr_id: mlo.nmlsr_id, mlo_nmls_status: mlo.nmls_status, mlo_licensed_states: [...mlo.licensed_states], mlo_assignment_at: at, mlo_review_state: "pending", mlo_reviews: closed };
  const reassigned = emit(events, next, "application.mlo_of_record.reassigned", { previous_mlo_of_record_id: previous, mlo_of_record_id: mlo.mlo_id, nmlsr_id: mlo.nmlsr_id, mlo_name: mlo.name, reason: r.reason, state: app.property_state, reassigned_at: at }, at);
  const review = openMloReview(events, escalations, next, { stage: r.stage ?? "application", opened_at: at }); next = review.app;
  return { app: next, mlo, previous, events: [reassigned, review.event], review: review.review, escalation: review.escalation };
}
/** SM_O21_MLO_REVIEW_SLA_1BD breach: sev 2, reassign to the next licensed MLO for the state (sev 1 to the partner officer at +2 is the engine's next breach). */
export function handleMloSlaBreach(events: EventStore, escalations: EscalationService, app: IntakeApplication, b: { roster: readonly MloRosterEntry[]; at: string; timer_id: string }): { app: IntakeApplication; sev2: Escalation; reassigned: ReturnType<typeof reassignMlo> } {
  const sev2 = escalations.open({ kind: "sev2", ownerRole: "officer", applicationId: app.id, severity: "2", slaTimerId: b.timer_id, payload: { timer_code: "SM_O21_MLO_REVIEW_SLA_1BD", stage: "application", mlo_of_record_id: app.mlo_of_record_id, action: "reassign to the next licensed MLO for the state" } }, { kind: "system", id: "sweep" });
  const reassigned = reassignMlo(events, escalations, app, { roster: b.roster, at: b.at, reason: "sla_breach" });
  return { app: reassigned.app, sev2, reassigned };
}
/** 31.1's nightly NMLS Consumer Access feed: a status change on the MLO of record closes the SAFE gate (LE/lock blocked until reassignment). */
export function loadNmlsFeed(events: EventStore, app: IntakeApplication, feed: readonly { nmlsr_id: string; status: "active" | "inactive"; licensed_states?: readonly string[] }[], at: string): { app: IntakeApplication; changed: boolean; gate_open: boolean; event: DomainEvent | null } {
  isoInstant(at, "at"); const row = feed.find((f) => f.nmlsr_id === app.mlo_nmlsr_id);
  if (!row || !app.mlo_of_record_id || (row.status === app.mlo_nmls_status && (!row.licensed_states || row.licensed_states.join() === app.mlo_licensed_states.join()))) return { app, changed: false, gate_open: mloOfRecordGate(gateFacts(app)).open, event: null };
  const next: IntakeApplication = { ...app, mlo_nmls_status: row.status, mlo_licensed_states: row.licensed_states ? [...row.licensed_states] : app.mlo_licensed_states };
  const gate_open = mloOfRecordGate(gateFacts(next)).open;
  return { app: next, changed: true, gate_open, event: emit(events, next, "application.mlo_of_record.status_changed", { mlo_of_record_id: next.mlo_of_record_id, nmlsr_id: next.mlo_nmlsr_id, status: row.status, gate_open, gate: SAFE_GATE, blocks: gate_open ? [] : ["issueLE", "executeLock", "particular_terms_presented"] }, at, { kind: "external", id: "nmls-feed" }) };
}

// ------------------------------------------------------------ gate facts and evaluators (registered in evaluators-21-1.ts)
export interface GateResult { readonly open: boolean; readonly reason?: string; }
export const gateOpen: GateResult = { open: true };
const closed = (reason: string): GateResult => ({ open: false, reason });
/** Facts the four 21.1 gates evaluate — built from the intake record (the evaluators are pure over these). */
export function gateFacts(app: IntakeApplication): Record<string, unknown> {
  return { mlo_of_record_id: app.mlo_of_record_id, mlo_nmls_status: app.mlo_nmls_status, mlo_licensed_states: [...app.mlo_licensed_states], property_state: app.property_state, mlo_review_state: app.mlo_review_state, ai_intake_mode: app.ai_intake_mode, trid_received_at: app.trid_received_at,
    borrowers: creditBorrowers(app).map((b) => ({ id: b.id, scif_presented_at: b.scif?.presented_at ?? null, demographics_collected: !!b.demographics, joint_intent_affirmed_at: b.joint_intent_affirmed_at, added_at: b.added_at })) };
}
type BorrowerFact = { id: string; scif_presented_at?: string | null; demographics_collected?: boolean; joint_intent_affirmed_at?: string | null; added_at?: string | null };
const borrowerFacts = (f: Record<string, unknown>): BorrowerFact[] => (Array.isArray(f.borrowers) ? (f.borrowers as BorrowerFact[]) : []);
/** SAFE_1008_103_MLO_OF_RECORD_GATE: open when `mlo_of_record_id` set, NMLS status active for the property state, and `mlo_review_state='approved'` for stage `application`. */
export function mloOfRecordGate(f: Record<string, unknown>): GateResult {
  if (!f.mlo_of_record_id) return closed("no MLO of record assigned (12 CFR 1008.103; §1026.36(g))");
  if (f.mlo_nmls_status !== "active") return closed(`MLO of record NMLS status is ${String(f.mlo_nmls_status ?? "unknown")}, not active`);
  const states = Array.isArray(f.mlo_licensed_states) ? (f.mlo_licensed_states as string[]) : [];
  if (!f.property_state || !states.includes(String(f.property_state))) return closed(`MLO of record is not licensed in ${String(f.property_state ?? "the property state")}`);
  if (f.mlo_review_state !== "approved") return closed(`stage-application review is ${String(f.mlo_review_state ?? "unassigned")}, not approved`);
  return gateOpen;
}
/** SM_O21_SCIF_PRESENT_GATE: `scif_forms.presented_at` exists for every borrower (answers may all be blank). */
export function scifPresentGate(f: Record<string, unknown>): GateResult {
  const bs = borrowerFacts(f); if (!bs.length) return closed("no borrowers on the application");
  const missing = bs.filter((b) => !b.scif_presented_at).map((b) => b.id);
  return missing.length ? closed(`Form 1103 SCIF not presented to borrower(s) ${missing.join(", ")} (LL-2022-03; B2-2-06) — du.submit blocked`) : gateOpen;
}
/** SM_O21_DEMOGRAPHICS_ASKED_GATE: every borrower has an `applicant_demographics` row (answered or declined). */
export function demographicsAskedGate(f: Record<string, unknown>): GateResult {
  const bs = borrowerFacts(f); if (!bs.length) return closed("no borrowers on the application");
  const missing = bs.filter((b) => !b.demographics_collected).map((b) => b.id);
  return missing.length ? closed(`demographic information not requested from borrower(s) ${missing.join(", ")} (Reg C App. B instruction 1) — intake_complete blocked`) : gateOpen;
}
/** SM_O21_JOINT_INTENT_GATE: every borrower has `joint_intent_affirmed_at` ≤ `trid_received_at`; a borrower added after the six items affirms on her own timestamp (edge case "co-borrower unavailable at the first interview" — `trid_received` is not re-anchored), so only her affirmation's existence is tested. */
export function jointIntentGate(f: Record<string, unknown>): GateResult {
  const bs = borrowerFacts(f); if (!bs.length) return closed("no borrowers on the application");
  const trid = typeof f.trid_received_at === "string" ? Date.parse(f.trid_received_at) : null;
  for (const b of bs) {
    if (!b.joint_intent_affirmed_at) return closed(`borrower ${b.id} has not affirmed joint intent (§1002.7(d); comment 7(d)(1)-3) — credit pull and DU submission blocked`);
    const addedAfterTrid = trid !== null && !!b.added_at && Date.parse(b.added_at) > trid;
    if (trid !== null && !addedAfterTrid && Date.parse(b.joint_intent_affirmed_at) > trid) return closed(`borrower ${b.id} affirmed joint intent ${b.joint_intent_affirmed_at} after trid_received_at ${String(f.trid_received_at)}`);
  }
  return gateOpen;
}

// ------------------------------------------------------------ rule 8: SAFE Act activity classification under the flag mode
export type SafeClassification = "general_explanation" | "process_description" | "data_capture" | "particular_terms_presented" | "negotiation" | "underwriting_communication";
export const SAFE_CLASSIFICATIONS: readonly SafeClassification[] = ["general_explanation", "process_description", "data_capture", "particular_terms_presented", "negotiation", "underwriting_communication"];
/** App. A (b)(2) activities the AI may perform in every mode; the rest need the MLO of record (assisted: attributed; supervised_present: pre-approved scenario; autonomous: written legal position). */
export const AI_PERMITTED_ALWAYS: readonly SafeClassification[] = ["general_explanation", "process_description", "data_capture"];
export interface UtterancePermission { readonly allowed: boolean; readonly classification: SafeClassification; readonly fallback: SafeClassification | null; readonly gate: string | null; readonly reason: string | null; readonly attribution: { mlo_name: string; nmlsr_id: string; text: string } | null; }
export function utterancePermission(app: IntakeApplication, classification: SafeClassification, o: { written_legal_position?: boolean; scenario_approved_by_mlo?: boolean } = {}): UtterancePermission {
  if (!SAFE_CLASSIFICATIONS.includes(classification)) throw new RangeError(`classification ${String(classification)} is not one of ${SAFE_CLASSIFICATIONS.join("/")}`);
  const base = { classification, gate: null, reason: null, attribution: null, fallback: null };
  if (classification === "underwriting_communication") return { ...base, allowed: false, fallback: "process_description", reason: "never tell a borrower they do or do not qualify (App. A (b)(2)(iv) is 23.x's; eligibility statements before DU are prohibited)" };
  if (AI_PERMITTED_ALWAYS.includes(classification)) return { ...base, allowed: true };
  if (app.ai_intake_mode === "autonomous" && !o.written_legal_position) return { ...base, allowed: false, fallback: "general_explanation", gate: SAFE_GATE, reason: "`autonomous` mode is prohibited unless 31.1 records a written legal position for the state" };
  const gate = mloOfRecordGate(gateFacts(app));
  if (!gate.open) return { ...base, allowed: false, fallback: "general_explanation", gate: SAFE_GATE, reason: `${SAFE_GATE} closed: ${gate.reason}` };
  if (app.ai_intake_mode === "supervised_present" && !o.scenario_approved_by_mlo) return { ...base, allowed: false, fallback: "general_explanation", gate: SAFE_GATE, reason: "`supervised_present`: no particular terms until the MLO approves the pricing scenario for this borrower" };
  return { ...base, allowed: true, attribution: { mlo_name: app.mlo_name!, nmlsr_id: app.mlo_nmlsr_id!, text: `Estimates prepared for ${app.mlo_name}, NMLS #${app.mlo_nmlsr_id}, who will review your Loan Estimate.` } };
}
/** `safe_activity_log` row per utterance/screen: the evidence that the AI stayed inside App. A (b)(2) or acted under the MLO of record; a blocked particular-terms utterance is logged as the fallback. */
export function logSafeActivity(events: EventStore, app: IntakeApplication, l: { utterance_id: string; classification: SafeClassification; at: string; written_legal_position?: boolean; scenario_approved_by_mlo?: boolean }): { app: IntakeApplication; permission: UtterancePermission; entry: SafeActivityEntry; event: DomainEvent } {
  const at = isoInstant(l.at, "at"); nonEmpty(l.utterance_id, "utterance_id");
  const permission = utterancePermission(app, l.classification, l);
  const logged: SafeClassification = permission.allowed ? l.classification : permission.fallback ?? "general_explanation";
  const entry: SafeActivityEntry = { at, utterance_id: l.utterance_id, classification: logged, presented_under_mlo_id: permission.allowed && !AI_PERMITTED_ALWAYS.includes(logged) ? app.mlo_of_record_id : null, flag_mode: app.ai_intake_mode, allowed: permission.allowed };
  const next: IntakeApplication = { ...app, safe_activity_log: [...app.safe_activity_log, entry] };
  const event = permission.allowed
    ? emit(events, next, "safe_activity.logged", { utterance_id: l.utterance_id, classification: logged, presented_under_mlo_id: entry.presented_under_mlo_id, nmlsr_id: entry.presented_under_mlo_id ? app.mlo_nmlsr_id : null, flag_mode: app.ai_intake_mode, attribution: permission.attribution?.text ?? null }, at)
    : emit(events, next, "interview.utterance.blocked", { utterance_id: l.utterance_id, classification: l.classification, gate: permission.gate, fallback: logged, reason: permission.reason, flag_mode: app.ai_intake_mode }, at);
  return { app: next, permission, entry, event };
}
/** The indicative quote of worked example 1: level P&I on $560,000 at 6.125 % / 360 = $3,402.62 (rounded half-up from 3,402.619; the brief's $3,402.63 is off by one cent). */
export function indicativeQuotePayment(amountCents: Cents, ratePct: string, termMonths: number): { pi_cents: Cents; rate_pct: string; term_months: number } {
  if (amountCents <= 0n) throw new RangeError("loan amount must be positive");
  return { pi_cents: levelPayment(amountCents, ratePercent(ratePct), termMonths), rate_pct: ratePct, term_months: termMonths };
}
/** 21.3's `application.arm_interest.recorded{fnma_plan_number, channel}` — emitted here the first time a borrower expresses interest in a variable-rate program. */
export function recordArmInterest(events: EventStore, app: IntakeApplication, a: { fnma_plan_number: string; at: string }): { app: IntakeApplication; event: DomainEvent | null } {
  const at = isoInstant(a.at, "at"); nonEmpty(a.fnma_plan_number, "fnma_plan_number");
  if (app.arm_interest_recorded) return { app, event: null };
  const next: IntakeApplication = { ...app, arm_interest_recorded: true };
  return { app: next, event: emit(events, next, "application.arm_interest.recorded", { fnma_plan_number: a.fnma_plan_number, channel: app.intake_channel }, at) };
}

// ============================================================ initial 1003 (1/2021) render + e-sign, intake_complete
export interface Form1003Render { readonly urla_form_version: string; readonly ulad_version: string; readonly document_id: string; readonly data_hash: string;
  readonly borrowers: { id: string; legal_name: string; borrower_role: string; form: "borrower_information" | "additional_borrower"; unmarried_addendum: boolean; citizenship_status: string | null; section_8_demographics: "collected" | "declined" | "not_asked"; credit_requested: boolean }[];
  readonly non_borrowing_spouses: { id: string; legal_name: string; instrument: "security_instrument_only"; note_signer: false; credit_data_requested: false }[];
  readonly section_9_loan_originator: { organization: string; organization_nmlsr_id: string | null; originator_name: string; originator_nmlsr_id: string }; readonly section_4_loan: { transaction_type: string | null; occupancy: string | null; property_address: string | null; loan_amount_sought_cents: Cents | null; property_value_estimate_cents: Cents | null }; }
/** Renders the initial 1003 (1/2021): Section 9 carries the MLO of record's name and NMLSR ID (§1026.36(g)); a non-borrowing spouse appears only for the security instrument. */
export function renderForm1003(app: IntakeApplication): Form1003Render {
  if (!app.mlo_of_record_id || !app.mlo_nmlsr_id || !app.mlo_name) throw new RangeError("Section 9 needs the MLO of record's name and NMLSR ID before the 1003 renders (§1026.36(g); rule 7)");
  const applicants = creditBorrowers(app); if (!applicants.length) throw new RangeError("no applicant on the 1003");
  const borrowers = applicants.map((b, i) => ({ id: b.id, legal_name: b.legal_name, borrower_role: b.borrower_role, form: i === 0 ? "borrower_information" as const : "additional_borrower" as const, unmarried_addendum: b.unmarried_addendum_required, citizenship_status: b.citizenship_status, section_8_demographics: b.demographics ? (b.demographics.declined_ethnicity && b.demographics.declined_race && b.demographics.declined_sex ? "declined" as const : "collected" as const) : "not_asked" as const, credit_requested: true as const }));
  const non_borrowing_spouses = app.borrowers.filter((b) => b.borrower_role === "non_borrowing_spouse").map((b) => ({ id: b.id, legal_name: b.legal_name, instrument: "security_instrument_only" as const, note_signer: false as const, credit_data_requested: false as const }));
  const section_9_loan_originator = { organization: app.partner_name, organization_nmlsr_id: app.partner_nmlsr_id, originator_name: app.mlo_name, originator_nmlsr_id: app.mlo_nmlsr_id };
  const section_4_loan = { transaction_type: app.transaction_type, occupancy: app.occupancy, property_address: app.property_address, loan_amount_sought_cents: app.loan_amount_sought_cents, property_value_estimate_cents: app.property_value_estimate_cents };
  const data_hash = sha256(JSON.stringify({ urla: URLA_FORM_VERSION, ulad: ULAD_VERSION, borrowers, non_borrowing_spouses, section_9_loan_originator, section_4_loan: { ...section_4_loan, loan_amount_sought_cents: String(section_4_loan.loan_amount_sought_cents), property_value_estimate_cents: String(section_4_loan.property_value_estimate_cents) }, six_items: app.six_items }));
  return { urla_form_version: URLA_FORM_VERSION, ulad_version: ULAD_VERSION, document_id: `doc-1003-${app.id}-${data_hash.slice(0, 12)}`, data_hash, borrowers, non_borrowing_spouses, section_9_loan_originator, section_4_loan };
}
export interface EsignConsentFact { readonly status: "active" | "withdrawn" | "pending" | "none"; readonly classes: readonly string[]; }
/** E-SIGN 7001(c): the 20.3 consent must be active and scoped to the application document class before the first electronic signature. */
export function esignScopeCovers(consent: EsignConsentFact | null | undefined): { ok: boolean; reason: string | null } {
  if (!consent || consent.status !== "active") return { ok: false, reason: "no active consents.esign (20.3 captures it; NTC_SM_ESIGN_CONSENT re-presented for application_documents)" };
  return consent.classes.some((c) => c === "application_documents" || c === "origination_disclosures" || c === "origination_esign_signatures") ? { ok: true, reason: null } : { ok: false, reason: `consents.esign scope ${consent.classes.join(",")} does not cover application_documents` };
}
/** The borrower personally e-signs the initial 1003 (B1-1-01: the initial 1003 is personally signed, never by POA); the accuracy attestation artifact is Section 6's. */
export function requestESign(events: EventStore, app: IntakeApplication, s: { borrower_id: string; document_id: string; data_hash: string; signed_at: string; consent: EsignConsentFact | null; accuracy_attestation_id: string; audit: { ip?: string; authentication_result?: string } }): { app: IntakeApplication; event: DomainEvent; all_borrowers: boolean } {
  const signed_at = isoInstant(s.signed_at, "signed_at"); const b = borrowerOf(app, s.borrower_id); nonEmpty(s.document_id, "document_id"); nonEmpty(s.data_hash, "data_hash"); nonEmpty(s.accuracy_attestation_id, "accuracy_attestation_id");
  if (!b.credit_requested) throw new RangeError(`${b.borrower_role} ${b.id} does not sign the 1003 (security instrument only)`);
  const scope = esignScopeCovers(s.consent); if (!scope.ok) throw new RangeError(scope.reason!);
  if (b.joint_intent_evidence_id && b.joint_intent_evidence_id === s.accuracy_attestation_id) throw new RangeError("the accuracy attestation must be an artifact distinct from the joint-intent affirmation (comment 7(d)(1)-3)");
  const next0 = withBorrower(app, b.id, { initial_1003_signed_at: signed_at, initial_1003_document_id: s.document_id, accuracy_attestation_id: s.accuracy_attestation_id });
  const all_borrowers = creditBorrowers(next0).every((x) => !!x.initial_1003_signed_at);
  const next = touched({ ...next0, initial_1003_document_id: s.document_id, initial_1003_data_hash: s.data_hash, initial_1003_signed_at: all_borrowers ? signed_at : next0.initial_1003_signed_at }, signed_at);
  return { app: next, all_borrowers, event: emit(events, next, "application.initial_1003.signed", { borrower_id: b.id, document_id: s.document_id, data_hash: s.data_hash, signed_at, accuracy_attestation_id: s.accuracy_attestation_id, all_borrowers, audit: { ip: s.audit.ip ?? null, authentication_result: s.audit.authentication_result ?? null, consent_result: "active" } }, signed_at) };
}
/** `intake_complete` guards: initial 1003 signed by every borrower, SCIF presented, demographics asked, joint intent evidenced, MLO assigned and stage-application review approved. */
export function intakeComplete(events: EventStore, app: IntakeApplication, at: string): { app: IntakeApplication; ok: boolean; blocking: string[]; event: DomainEvent | null } {
  isoInstant(at, "at"); const f = gateFacts(app); const blocking: string[] = [];
  if (!app.trid_received_at) blocking.push("trid_received");
  if (!creditBorrowers(app).every((b) => !!b.initial_1003_signed_at)) blocking.push("initial_1003_signed");
  for (const [code, g] of [["SM_O21_SCIF_PRESENT_GATE", scifPresentGate(f)], ["SM_O21_DEMOGRAPHICS_ASKED_GATE", demographicsAskedGate(f)], ["SM_O21_JOINT_INTENT_GATE", creditBorrowers(app).length > 1 ? jointIntentGate(f) : gateOpen], [SAFE_GATE, mloOfRecordGate(f)]] as const) if (!g.open) blocking.push(`${code}: ${g.reason}`);
  if (blocking.length) return { app, ok: false, blocking, event: null };
  const next: IntakeApplication = { ...app, status: "intake_complete" };
  return { app: next, ok: true, blocking, event: emit(events, next, "application.intake_complete", { trid_received_at: app.trid_received_at, mlo_of_record_id: app.mlo_of_record_id, nmlsr_id: app.mlo_nmlsr_id, borrowers: creditBorrowers(app).map((b) => b.id) }, at) };
}

// ============================================================ SM_O21_INTAKE_ABANDON_30 sweep and retention
/** The abandon rule: no borrower activity for 30 calendar days before `trid_received`. Never `received` → purged (pre-application retention rule); `received` → retained 25 months (Reg B §1002.12(b)). */
export function abandonDecision(app: IntakeApplication, asOf: PlainDate): { abandon: boolean; abandon_at: PlainDate; purge: boolean; retain_until: PlainDate | null; reason: string } {
  const abandon_at = addDays(civilDate(app.last_activity_at, app.creditor_time_zone), INTAKE_ABANDON_DAYS);
  if (app.trid_received_at) return { abandon: false, abandon_at, purge: false, retain_until: addMonths(app.application_date!, REGB_RETENTION_MONTHS), reason: "after trid_received an inactive file is 21.6's withdrawn/incomplete path, never silently abandoned" };
  if (app.status === "abandoned" || app.status === "intake_complete") return { abandon: false, abandon_at, purge: false, retain_until: null, reason: `status ${app.status}` };
  if (asOf < abandon_at) return { abandon: false, abandon_at, purge: false, retain_until: null, reason: `last activity ${app.last_activity_at}; abandons ${abandon_at}` };
  const received = !!app.application_received_at;
  return { abandon: true, abandon_at, purge: !received, retain_until: received ? addMonths(app.application_date!, REGB_RETENTION_MONTHS) : null, reason: received ? "received: retained 25 months (regb_25m)" : "never received: purged per the pre-application retention rule" };
}
export function abandonSweep(events: EventStore, app: IntakeApplication, asOf: PlainDate, at: string): { app: IntakeApplication; decision: ReturnType<typeof abandonDecision>; event: DomainEvent | null } {
  const decision = abandonDecision(app, asOf); if (!decision.abandon) return { app, decision, event: null };
  const next: IntakeApplication = { ...app, status: "abandoned", retention_class: decision.purge ? "pre_application_purge" : "regb_25m" };
  return { app: next, decision, event: emit(events, next, "application.abandoned", { last_activity_at: app.last_activity_at, abandon_at: decision.abandon_at, swept_on: asOf, purge: decision.purge, retain_until: decision.retain_until, retention_class: next.retention_class, was_received: !!app.application_received_at }, at, { kind: "system", id: "sweep" }) };
}

/** The agent's decision record (`agent_decisions`) as the AI agent design lists it. */
export function decisionRecord(app: IntakeApplication, o: { model_version: string; prompt_version: string; rationale: string; confidence?: number }): Record<string, unknown> {
  return { application_id: app.id, session_ids: app.interview_sessions.map((s) => s.session_id), six_items: app.six_items, application_received_at: app.application_received_at, trid_received_at: app.trid_received_at,
    demographics_collection_method: creditBorrowers(app).map((b) => b.demographics?.collection_method ?? null), declines: creditBorrowers(app).map((b) => ({ borrower_id: b.id, ethnicity: b.demographics?.declined_ethnicity ?? null, race: b.demographics?.declined_race ?? null, sex: b.demographics?.declined_sex ?? null })),
    joint_intent_evidence_ids: creditBorrowers(app).map((b) => b.joint_intent_evidence_id), scif_presented: creditBorrowers(app).every((b) => !!b.scif), citizenship_evidence: creditBorrowers(app).map((b) => b.legal_presence_evidence_document_id), mlo_of_record_id: app.mlo_of_record_id, ai_intake_mode: app.ai_intake_mode,
    safe_activity_summary: Object.fromEntries(SAFE_CLASSIFICATIONS.map((c) => [c, app.safe_activity_log.filter((e) => e.classification === c).length])), model_version: o.model_version, prompt_version: o.prompt_version, rationale: o.rationale, confidence: o.confidence ?? null, rule_set_version: RULE_SET_VERSION_21_1 };
}
