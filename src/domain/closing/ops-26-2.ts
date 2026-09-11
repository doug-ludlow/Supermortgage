/**
 * §26.2 eClosing execution (RON, IPEN, hybrid, wet), eNote signing, eVault custody, MERS eRegistry registration, eRecording
 * and paper-note handling — the pure rules of the `closer` runtime (the `title-closing` agent, defined in 26.1) over
 * `closings` / `signing_sessions` / `enotes` / `mers_transactions` / `recordings` / `custody_records` /
 * `eclosing_eligibility` / `jurisdiction_rules.ron` (migration 0094). One small function per rule / T-id; every emitter
 * appends its event with `applicationId` so the origination timers arm (src/kernel/timers/engine.ts isOriginationContext).
 *
 * Events (subject = the application):
 *   closing.scheduled{closing_id, scheduled_at, closing_type, settlement_agent_party_id, notary_party_id, transaction_type, is_hpml, escrow_required, appraisal_rules_apply, escrow_min_cancel_date, scheduled_note_date, enote}
 *                                                                                  [arms SM_O71_DOCS_TO_AGENT_1BD (26.1), SM_O72_ESIGN_CONSENT_CLOSING_GATE, SM_O72_RON_STATE_AUTH_GATE, SM_O72_AGENT_ECLOSING_ELIGIBLE_GATE, 25.2/25.4/23.3/23.4/22.x/24.x gates]
 *   closing.eligibility.checked{check∈{ron_state_auth, agent_eclosing}, result}    [satisfies SM_O72_RON_STATE_AUTH_GATE / SM_O72_AGENT_ECLOSING_ELIGIBLE_GATE]
 *   closing.consent.verified{consent_id, scope}                                     [satisfies SM_O72_ESIGN_CONSENT_CLOSING_GATE]
 *   closing.session.created · closing.identity.proofed · closing.session.started · closing.session.failed{reason} · closing.rescheduled
 *   closing.document.signed{closing_document_id, kind, signed_at, signature_method}
 *   closing.consummated{consummation_at, consummation_on, consummation_date_local, note_date, anchor_date, tx_50a6, is_hpml, note_form, enote_indicator, …}
 *                                                                                  [arms SM_O72_POST_SIGNING_REVIEW_4H, SM_O72_PAPER_NOTE_HANDOFF_1BD{note_form=paper}, 26.4 MOM clocks; satisfies 26.1 TX gates, 21.4 lock, 24.x validity rows]
 *   enote.signed · enote.tamper_sealed{registration_anchor_date, registration_due_at}   [arms MERS_PROC_ENOTE_REGISTER_1BD, SM_O72_ENOTE_SAME_DAY_REGISTER, SM_O72_ENOTE_LOCATION_GATE]
 *   enote.authoritative_copy.validated{hash_match}                                  [hash_match=true satisfies SM_O72_ENOTE_LOCATION_GATE]
 *   enote.registered{controller, location, delegatee, controller_org_id, registered_at}   [satisfies MERS_PROC_ENOTE_REGISTER_1BD / SM_O72_ENOTE_SAME_DAY_REGISTER; arms SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE; 27.1 / 30.2 OB-015 consume]
 *   enote.registration.rejected{error_codes} · enote.secured_party.set{secured_party_org_id}   [satisfies SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE] · enote.registration.reversed
 *   closing.notarial_act.completed{closing_document_id, act_type, last, recording_anchor, anchor_date}   [last=true arms SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE; recording_anchor=true arms SM_O72_ERECORD_SUBMIT_1BD]
 *   closing.audit_trail.received{audit_trail_hash}                                 [satisfies SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE]
 *   closing.execution_review.passed / .failed{defects}                             [passed satisfies SM_O72_POST_SIGNING_REVIEW_4H]
 *   recording.submitted{channel, submitted_at} · recording.rejected{rejected_on, rejection_reason} · recording.resubmission.accepted
 *   recording.paper_fallback{fallback_date, tracking_ref} · recording.county_receipt.confirmed · recording.confirmed{channel, recorded_at, instrument_number, gap_days}
 *   custody.paper_note.shipped{tracking_ref, shipped_at} · custody.paper_note.received (26.4 consumes)
 * Consumed (never re-emitted): `closing.documents.released` / `closing.instructions.acknowledged` (26.1 — the signing gate),
 * `loan.funded` (26.3/30.2 — the wet-state recording anchor), `enote.edelivered` (29.4), `warehouse.advance.requested` (27.1).
 */
import { createHash } from "node:crypto";
import { type PlainDate, addDays, plainDate, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, creditor } from "../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { hpmlClosingPayload, type HpmlRow } from "../underwriting/ops-23-4.ts";
import { ctcGate } from "../underwriting/ops-23-3.ts";
import { le7sbdGate, type GateFacts as LeGateFacts } from "../application/ops-21-2.ts";
import { cd3sbdGate, type Cd3sbdGateFacts } from "../compliance-disclosures/ops-25-2.ts";
import { noticeAtSigningCheck, type SigningConsumerFacts } from "../compliance-disclosures/ops-25-3.ts";
import { assertNoFraudHold } from "../verification/ops-22-6.ts";
import { CLOSER, txClosingLocationOk, type ClosingType, type TxClosingLocation } from "./ops-26-1.ts";

export { CLOSER };
export const RULE_SET_VERSION_26_2 = "fnma.selling.2026-09-02+mers.eregistry.16.25+mers.proc.26.1+fnma.emortgage_tech.3.2+mismo.ron.v2_draft+pria.erecording.2.4.2+esign.7001c";
export const NOTICE_CLOSING_APPOINTMENT = "NTC_SM_CLOSING_APPOINTMENT";
export const RETENTION_ENOTE_SIGNING = "fnma_enote_signing_life_plus_7y";
export const SM_ORG_ID = "1009999";
export const SMART_DOC_VERSION = "1.0.2-cat1";
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const D = plainDate;

// ============================================================ jurisdiction rules (RON matrix)
/** A2-4.1-03 list as displayed 2026-09-10: 48 states + DC; Georgia and Mississippi absent (PARTIALLY VERIFIED — re-read before enabling a state). */
export const FNMA_RON_STATES: readonly string[] = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"];
export type IdentityMethod = "credential_analysis_kba" | "personal_knowledge" | "credible_witness" | "in_person_id";
export interface KbaParams { readonly min_questions: number; readonly seconds: number; readonly pass_pct: number; readonly retake_within_hours: number; readonly new_question_pct: number; }
/** 1 TAC §87.70: ≥ 5 questions, 2 minutes, ≥ 80 %, one retake within 24 hours replacing ≥ 60 % of the questions; other states default to the same until verified. */
export const TX_KBA_PARAMS: KbaParams = { min_questions: 5, seconds: 120, pass_pct: 80, retake_within_hours: 24, new_question_pct: 60 };
export interface JurisdictionRonRule {
  readonly ron_authorized: boolean; readonly ron_statute_cite: string | null; readonly fnma_listed: boolean; readonly out_of_state_ron_accepted: boolean; readonly notary_in_state_required: boolean;
  readonly identity_proofing_methods: readonly IdentityMethod[]; readonly kba_params: KbaParams; readonly recording_retention_years: number | null; readonly journal_required: boolean;
  readonly witness_count: number; readonly witness_statute_cite: string | null; readonly remote_witness_allowed: boolean; readonly verified: boolean;
}
const rule = (o: Partial<JurisdictionRonRule> & { fnma_listed: boolean }): JurisdictionRonRule => ({ ron_authorized: o.fnma_listed, ron_statute_cite: null, out_of_state_ron_accepted: false, notary_in_state_required: true, identity_proofing_methods: ["credential_analysis_kba", "personal_knowledge", "credible_witness"], kba_params: TX_KBA_PARAMS, recording_retention_years: null, journal_required: true, witness_count: 0, witness_statute_cite: null, remote_witness_allowed: false, verified: false, ...o });
export const RON_RULES: Record<string, JurisdictionRonRule> = {
  AZ: rule({ fnma_listed: true, ron_statute_cite: "A.R.S. §41-263", recording_retention_years: 5, verified: true }),
  OH: rule({ fnma_listed: true, ron_statute_cite: "Ohio R.C. 147.64–147.65", recording_retention_years: 10, verified: true }),
  TX: rule({ fnma_listed: true, ron_statute_cite: "Tex. Gov't Code §406.108; 1 TAC §87.70", recording_retention_years: 5, verified: true }),
  NY: rule({ fnma_listed: true, ron_statute_cite: "N.Y. Exec. Law §135-c", recording_retention_years: 10, witness_count: 1, verified: true }),
  CA: rule({ fnma_listed: true, ron_statute_cite: "Cal. SB 696 (phased through 2030)", out_of_state_ron_accepted: true, notary_in_state_required: false }),
  CT: rule({ fnma_listed: true, witness_count: 2, witness_statute_cite: "Conn. Gen. Stat. §47-5(a)" }),
  FL: rule({ fnma_listed: true, witness_count: 2, witness_statute_cite: "Fla. Stat. §695.26(1)(c)", remote_witness_allowed: true }),
  LA: rule({ fnma_listed: true, witness_count: 2, witness_statute_cite: "La. Civ. Code art. 1833" }),
  SC: rule({ fnma_listed: true, witness_count: 2, witness_statute_cite: "S.C. Code §30-5-30" }),
  GA: rule({ fnma_listed: false, ron_authorized: false, witness_count: 1 }),
  MS: rule({ fnma_listed: false, ron_authorized: false }),
};
export const ronRule = (state: string): JurisdictionRonRule => RON_RULES[state] ?? rule({ fnma_listed: FNMA_RON_STATES.includes(state) });

// ============================================================ closing-type decision (SM_O72_RON_STATE_AUTH_GATE / SM_O72_AGENT_ECLOSING_ELIGIBLE_GATE)
export interface EclosingEligibility { readonly settlement_agent_party_id: string; readonly county_fips?: string | null; readonly ron_capable: boolean; readonly ipen_capable: boolean; readonly erecording_submitter: boolean; readonly platforms: readonly string[]; readonly remote_witness_service: boolean; readonly verified_at: string | null; readonly verified_by?: string | null; }
export interface CounselConfirmation { readonly opinion_id: string; readonly issued_on: PlainDate; readonly counsel: string; readonly conclusion: "expressly_permits"; }
export interface ClosingTypeSigner { readonly party_id: string; readonly esign_consented: boolean; readonly identity_proofing_possible: boolean; readonly physical_location_state?: string | null; readonly credible_witness_required?: boolean; readonly credible_witness_remote?: boolean; }
export interface ClosingTypeInput {
  readonly state: string; readonly county_fips?: string | null; readonly tx_50a6: boolean; readonly enote_eligible: boolean; readonly proposed_closing_type: ClosingType;
  readonly borrower_election: ClosingType | null; readonly signers: readonly ClosingTypeSigner[];
  readonly county_accepts_ron_instruments: boolean; readonly title_no_ron_exception: boolean; readonly agent: EclosingEligibility | null; readonly ron_provider_available: boolean;
  readonly notary: { readonly commission_state: string; readonly physical_location_state: string } | null; readonly counsel_confirmation: CounselConfirmation | null;
  readonly in_person_enotarization_valid: boolean; readonly consent_withdrawn?: boolean; readonly session_failure?: boolean; readonly rule?: JurisdictionRonRule;
}
export type RonRefusal = "product_excluded" | "state_not_on_fnma_list" | "state_not_ron_authorized" | "county_recorder_rejects_ron" | "title_ron_exception" | "agent_not_ron_capable" | "ron_provider_unavailable" | "signer_no_esign_consent" | "identity_proofing_unavailable" | "credible_witness_not_remote" | "witness_not_remote" | "notary_out_of_state" | "signer_out_of_state";
export interface RonEligibility { readonly eligible: boolean; readonly refusals: readonly RonRefusal[]; readonly counsel_confirmed: boolean; readonly rule: JurisdictionRonRule; }
/** RON state-authorization gate: Fannie Mae's list (or a counsel "expressly permits" opinion), county recorder, title underwriter, agent/provider, consent and identity proofing, notary in the state of the act, never TX 50(a)(6). */
export function ronStateAuthCheck(i: ClosingTypeInput): RonEligibility {
  const r = i.rule ?? ronRule(i.state); const refusals: RonRefusal[] = []; const counsel_confirmed = i.counsel_confirmation?.conclusion === "expressly_permits";
  if (i.tx_50a6) refusals.push("product_excluded");
  if (!r.fnma_listed && !counsel_confirmed) refusals.push("state_not_on_fnma_list");
  if (r.fnma_listed && !r.ron_authorized && !counsel_confirmed) refusals.push("state_not_ron_authorized");
  if (!i.county_accepts_ron_instruments) refusals.push("county_recorder_rejects_ron");
  if (!i.title_no_ron_exception) refusals.push("title_ron_exception");
  if (!i.agent?.ron_capable) refusals.push("agent_not_ron_capable");
  if (!i.ron_provider_available) refusals.push("ron_provider_unavailable");
  if (i.signers.some((s) => !s.esign_consented)) refusals.push("signer_no_esign_consent");
  if (i.signers.some((s) => !s.identity_proofing_possible)) refusals.push("identity_proofing_unavailable");
  if (i.signers.some((s) => s.credible_witness_required && !s.credible_witness_remote)) refusals.push("credible_witness_not_remote");
  if (r.witness_count > 0 && !(r.remote_witness_allowed && i.agent?.remote_witness_service)) refusals.push("witness_not_remote");
  if (i.notary && r.notary_in_state_required && (i.notary.commission_state !== i.state || i.notary.physical_location_state !== i.state)) refusals.push("notary_out_of_state");
  if (i.signers.some((s) => s.physical_location_state && s.physical_location_state !== i.state) && !r.out_of_state_ron_accepted && r.notary_in_state_required && i.state === "NY") refusals.push("signer_out_of_state");
  return { eligible: refusals.length === 0, refusals, counsel_confirmed, rule: r };
}
export const TX_PERMITTED_OFFICES: readonly TxClosingLocation[] = ["lender_office", "attorney_office", "title_company"];
export interface ClosingTypeDecision { readonly closing_type: ClosingType; readonly note_form: "enote" | "paper"; readonly reasons: readonly string[]; readonly ron: RonEligibility; readonly location_required: readonly TxClosingLocation[] | null; readonly enote_indicator: boolean; readonly remote_notarization_indicator: boolean; readonly paper_option_offered: true; }
/** Business rule "Closing-type decision": ron → ipen → hybrid → wet; the note is always single-method (eNote fully electronic or paper fully wet); a paper option is always offered. */
export function decideClosingType(i: ClosingTypeInput): ClosingTypeDecision {
  const ron = ronStateAuthCheck(i); const reasons: string[] = []; const location_required = i.tx_50a6 ? TX_PERMITTED_OFFICES : null;
  const out = (closing_type: ClosingType, note_form: "enote" | "paper"): ClosingTypeDecision => ({ closing_type, note_form, reasons, ron, location_required, enote_indicator: note_form === "enote", remote_notarization_indicator: closing_type === "ron", paper_option_offered: true });
  if (i.tx_50a6) { reasons.push("product_excluded:tx_50a6 — A2-4.1-03: Texas 50(a)(6) loans are not eligible to be signed electronically; §50(a)(6)(N): permanent office of the lender, an attorney or a title company"); return out("wet", "paper"); }
  if (i.borrower_election === "wet") { reasons.push("borrower_election:wet — A2-4.1-03: under no circumstances may a borrower be required to use electronic records"); return out("wet", "paper"); }
  if (i.consent_withdrawn) { reasons.push("consent_withdrawn — E-SIGN §101(c)(1)(B)(i): paper path; the package is re-issued on paper (26.1)"); return out("wet", "paper"); }
  if (i.session_failure) { reasons.push("session_failure — wet/IPEN reschedule within the lock and CD validity"); return out(i.agent?.ipen_capable && i.in_person_enotarization_valid ? "ipen" : "wet", i.enote_eligible && i.agent?.ipen_capable ? "enote" : "paper"); }
  const everyoneConsents = i.signers.length > 0 && i.signers.every((s) => s.esign_consented);
  if (ron.eligible && i.borrower_election !== "ipen" && i.borrower_election !== "hybrid") { reasons.push(`ron_eligible:${i.state} — ${ron.rule.ron_statute_cite ?? "Fannie Mae RON list"}${ron.counsel_confirmed ? " (counsel-confirmed)" : ""}`); return out("ron", i.enote_eligible ? "enote" : "paper"); }
  reasons.push(...ron.refusals.map((r) => `ron_refused:${r}`));
  if (everyoneConsents && i.in_person_enotarization_valid && i.agent?.ipen_capable && i.borrower_election !== "hybrid") { reasons.push("ipen — in-person electronic notarization valid and the agent is IPEN-capable"); return out("ipen", i.enote_eligible ? "enote" : "paper"); }
  if (everyoneConsents && (i.enote_eligible || i.proposed_closing_type === "hybrid")) { reasons.push(i.enote_eligible ? "hybrid — eNote with the paper security instrument wet-signed and notarized in person" : "hybrid — paper note (eNote excluded) with eSigned ancillaries"); return out("hybrid", i.enote_eligible ? "enote" : "paper"); }
  reasons.push("wet — no electronic path"); return out("wet", "paper");
}
/** SM_O72_AGENT_ECLOSING_ELIGIBLE_GATE: an `eclosing_eligibility` row for the settlement agent/county matching the closing type; otherwise the closing type is downgraded. */
export function agentEclosingEligible(rows: readonly EclosingEligibility[], settlement_agent_party_id: string, county_fips: string | null, closing_type: ClosingType): { eligible: boolean; reason: string | null; downgrade_to: ClosingType | null } {
  if (closing_type === "wet") return { eligible: true, reason: null, downgrade_to: null };
  const row = rows.find((r) => r.settlement_agent_party_id === settlement_agent_party_id && (!r.county_fips || !county_fips || r.county_fips === county_fips));
  if (!row) return { eligible: false, reason: `no eclosing_eligibility row for ${settlement_agent_party_id}${county_fips ? ` / ${county_fips}` : ""}`, downgrade_to: "wet" };
  if (closing_type === "ron" && !row.ron_capable) return { eligible: false, reason: "settlement agent is not ron_capable", downgrade_to: row.ipen_capable ? "ipen" : "wet" };
  if (closing_type === "ipen" && !row.ipen_capable) return { eligible: false, reason: "settlement agent is not ipen_capable", downgrade_to: "wet" };
  if (closing_type === "hybrid" && !row.ipen_capable && !row.ron_capable && !row.platforms.length) return { eligible: false, reason: "settlement agent has no eClosing platform", downgrade_to: "wet" };
  return { eligible: true, reason: null, downgrade_to: null };
}

// ============================================================ E-SIGN consent (SM_O72_ESIGN_CONSENT_CLOSING_GATE)
export interface ClosingEsignConsent { readonly consent_id: string; readonly kind: "esign"; readonly scope: readonly string[]; readonly granted_at: string; readonly withdrawn_at: string | null; readonly hw_sw_statement_version: string | null; readonly access_demonstrated: boolean; readonly paper_option_disclosed: boolean; }
/** E-SIGN §101(c)(1): affirmative, unwithdrawn consent scoped to the closing package with the hardware/software demonstration and the paper option on record. */
export function esignConsentCheck(c: ClosingEsignConsent | null, closing_type: ClosingType, now: string): { open: boolean; reason: string | null } {
  if (closing_type === "wet") return { open: true, reason: null };
  if (!c) return { open: false, reason: "no consents{kind=esign} record — offer the wet path" };
  if (c.withdrawn_at && c.withdrawn_at <= now) return { open: false, reason: `consent ${c.consent_id} withdrawn ${c.withdrawn_at}` };
  if (!c.scope.includes("closing_package") && !c.scope.includes("all")) return { open: false, reason: `consent ${c.consent_id} does not cover the closing package (scope ${c.scope.join(",")})` };
  if (!c.access_demonstrated || !c.hw_sw_statement_version) return { open: false, reason: "E-SIGN §101(c)(1)(C): hardware/software statement and access demonstration not on record" };
  if (!c.paper_option_disclosed) return { open: false, reason: "E-SIGN §101(c)(1)(B)(i): the paper option was not disclosed" };
  return { open: true, reason: null };
}

// ============================================================ pre-session checks (gates from other processes)
export interface PreSessionFacts {
  readonly closing_type: ClosingType; readonly requested_on: PlainDate; readonly consent: ClosingEsignConsent | null; readonly ctc: { ctc_issued: boolean; checklist_passed: boolean; decision_status: string };
  readonly le: LeGateFacts; readonly cd: Cd3sbdGateFacts; readonly signing_package: readonly SigningConsumerFacts[]; readonly rescindable: boolean; readonly fraud_hold: { fraud_hold: boolean; reason?: string | null } | null;
  readonly compliance_consummate_gate_open: boolean; readonly instructions_acknowledged: boolean; readonly tx_50a6: boolean; readonly documents_released: boolean; readonly vvoe_within_10bd: boolean; readonly mi_commitment_valid: boolean; readonly lock_valid_through_closing: boolean;
  readonly privacy_notice_gate_open: boolean; readonly state_notice_gate_open: boolean; readonly appraisal_copy_gate_open: boolean;
}
export interface PreSessionResult { readonly passed: boolean; readonly blocking: readonly string[]; readonly checked: readonly string[]; }
/** Inputs & triggers: every upstream gate a session needs open — 23.3 CTC, 21.2 LE 7-SBD, 25.2 CD 3-SBD, 25.3 signing package, 22.6 fraud hold, 25.1, 25.4, 24.2, 26.1 release/acknowledgment, 22.3 VVOE, 24.6 MI, 21.4 lock — and the E-SIGN consent. */
export function runPreSessionChecks(f: PreSessionFacts, now: string): PreSessionResult {
  const blocking: string[] = []; const checked: string[] = [];
  const g = (code: string, open: boolean, why?: string) => { checked.push(code); if (!open) blocking.push(`${code}${why ? `: ${why}` : ""}`); };
  const ctc = ctcGate({ ...f.ctc, command: "openSigningSession" }); g("SM_UW_CTC_GATE", ctc.open, ctc.reason ?? undefined);
  const le = le7sbdGate({ ...f.le, requested_on: f.le.requested_on ?? f.requested_on }); g("REGZ_1026_19E1III_LE_7SBD_GATE", le.open, le.reason);
  const cd = cd3sbdGate({ ...f.cd, requested_on: f.cd.requested_on ?? f.requested_on }); g("REGZ_1026_19F1_CD_3SBD_GATE", cd.open, cd.reason);
  if (f.rescindable) { try { const sp = noticeAtSigningCheck(f.signing_package); g("SM_O63_NOTICE_AT_SIGNING_GATE", sp.open, sp.reason); } catch (e) { g("SM_O63_NOTICE_AT_SIGNING_GATE", false, (e as Error).message); } }
  try { assertNoFraudHold(f.fraud_hold, "consummate"); g("SM_FRAUD_HOLD", true); } catch (e) { g("SM_FRAUD_HOLD", false, (e as Error).message); }
  g("SM_O61_COMPLIANCE_PASS_CONSUMMATE_GATE", f.compliance_consummate_gate_open);
  g("GLBA_1016_4_INITIAL_PRIVACY_GATE", f.privacy_notice_gate_open); g("SM_O64_CLOSING_PACKAGE_NOTICES_GATE", f.state_notice_gate_open); g("REGB_1002_14_APPRAISAL_COPY_3BD_GATE", f.appraisal_copy_gate_open);
  g("SM_O71_DOCS_RELEASED", f.documents_released, "closing.documents.released (26.1) not received");
  g("SM_O71_INSTRUCTIONS_ACK_GATE", !f.tx_50a6 || f.instructions_acknowledged, "TX 50(a)(6): closing instructions not acknowledged");
  g("FNMA_B3_3_1_04_VVOE_10BD", f.vvoe_within_10bd); g("SM_MI_COMMITMENT_EXPIRY_GATE", f.mi_commitment_valid); g("SM_LOCK_VALIDITY", f.lock_valid_through_closing);
  const c = esignConsentCheck(f.consent, f.closing_type, now); g("SM_O72_ESIGN_CONSENT_CLOSING_GATE", c.open, c.reason ?? undefined);
  return { passed: blocking.length === 0, blocking, checked };
}

// ============================================================ identity proofing (proofIdentity)
export interface KbaAttempt { readonly questions: number; readonly correct: number; readonly seconds: number; readonly at: string; readonly notary_party_id: string; readonly new_question_pct?: number; }
export interface KbaEvaluation { readonly result: "pass" | "retake_allowed" | "failed_identity"; readonly attempts: number; readonly reasons: readonly string[]; readonly retake_blocked_until: string | null; readonly retake_deadline: string | null; }
/** Texas 1 TAC §87.70 (default elsewhere): ≥5 questions in 2 minutes at ≥80 %; one retake within 24 hours with ≥60 % new questions; a second failure fails identity and blocks a retake with the same notary for 24 hours. */
export function evaluateKba(attempts: readonly KbaAttempt[], p: KbaParams = TX_KBA_PARAMS): KbaEvaluation {
  const reasons: string[] = []; if (!attempts.length) return { result: "retake_allowed", attempts: 0, reasons: ["no KBA attempt yet"], retake_blocked_until: null, retake_deadline: null };
  const passes = (a: KbaAttempt): string | null => a.questions < p.min_questions ? `fewer than ${p.min_questions} questions` : a.seconds > p.seconds ? `answered in ${a.seconds}s > ${p.seconds}s` : (a.correct * 100) / a.questions < p.pass_pct ? `${a.correct}/${a.questions} < ${p.pass_pct}%` : null;
  const first = attempts[0]!; const r1 = passes(first);
  if (!r1) return { result: "pass", attempts: 1, reasons: [], retake_blocked_until: null, retake_deadline: null };
  reasons.push(`attempt 1: ${r1}`);
  const deadline = toIso(Date.parse(first.at) + p.retake_within_hours * 3_600_000);
  if (attempts.length === 1) return { result: "retake_allowed", attempts: 1, reasons, retake_blocked_until: null, retake_deadline: deadline };
  const second = attempts[1]!;
  if (second.at > deadline) reasons.push(`attempt 2 after the ${p.retake_within_hours}-hour retake window`);
  if ((second.new_question_pct ?? 0) < p.new_question_pct) reasons.push(`retake replaced ${second.new_question_pct ?? 0}% < ${p.new_question_pct}% of the questions`);
  const r2 = passes(second);
  if (!r2 && reasons.length === 1) return { result: "pass", attempts: 2, reasons: [], retake_blocked_until: null, retake_deadline: null };
  if (r2) reasons.push(`attempt 2: ${r2}`);
  return { result: "failed_identity", attempts: attempts.length, reasons, retake_blocked_until: toIso(Date.parse(second.at) + p.retake_within_hours * 3_600_000), retake_deadline: null };
}
export interface IdentityProofingRecord { readonly party_id: string; readonly method: IdentityMethod; readonly credential_type: string | null; readonly credential_analysis_result: "pass" | "fail" | null; readonly kba: { questions: number; correct: number; attempts: number; seconds: number } | null; readonly vendor: string | null; readonly evidence_document_id: string | null; readonly result: "proofed" | "retake_offered" | "failed"; readonly proofed_at: string | null; }

// ============================================================ closings / sessions / eNotes (entity shapes; migration 0094)
export type ExecutionStatus = "scheduled" | "package_released" | "pre_session_checks_passed" | "session_in_progress" | "signed" | "notarized" | "sealed" | "execution_reviewed" | "awaiting_funding" | "funded" | "recorded" | "complete" | "session_failed" | "rescheduled" | "converted_to_paper_path" | "voided";
export interface Closing {
  readonly closing_id: string; readonly application_id: string; readonly scheduled_at: string; readonly time_zone: string; readonly scheduled_note_date: PlainDate; readonly closing_type: ClosingType; readonly note_form: "enote" | "paper";
  readonly state: string; readonly county_fips: string | null; readonly transaction_type: "purchase" | "limited_cash_out" | "cash_out" | "refinance"; readonly tx_50a6: boolean; readonly rescindable: boolean; readonly dry_state: boolean;
  readonly settlement_agent_party_id: string; readonly notary_party_id: string | null; readonly ron_provider_party_id: string | null; readonly location_type: TxClosingLocation | "settlement_agent_office" | "remote" | "homestead" | "other" | null;
  readonly is_hpml: boolean; readonly escrow_required: boolean; readonly appraisal_rules_apply: boolean; readonly escrow_min_cancel_date: PlainDate | null;
  readonly document_set_id: string | null; readonly documents_released_at: string | null; readonly instructions_acknowledged_at: string | null;
  readonly enote_indicator: boolean; readonly remote_notarization_indicator: boolean; readonly witness_manifest: readonly { party_id: string; role: "witness"; document_id: string }[];
  readonly pre_session_checks_passed_at: string | null; readonly signing_start_at: string | null; readonly signing_end_at: string | null; readonly consummation_at: string | null; readonly consummation_on: PlainDate | null; readonly note_date: PlainDate | null;
  readonly execution_review_passed_at: string | null; readonly execution_defects: readonly ExecutionDefect[]; readonly execution_status: ExecutionStatus; readonly session_ids: readonly string[]; readonly audit_trail_document_ids: readonly string[];
}
export type SessionMode = "ron" | "ipen" | "esign_only" | "wet_witnessed";
export type SessionStatus = "created" | "consent_captured" | "identity_proofed" | "in_session" | "documents_signed" | "notarial_acts_complete" | "tamper_sealed" | "audit_trail_received" | "completed" | "failed" | "abandoned";
export type SessionFailure = "identity" | "credential_analysis" | "connectivity" | "notary_unavailable" | "consent_withdrawn" | "signer_no_show" | "document_defect" | "platform_outage";
export interface SignedDocument { readonly closing_document_id: string; readonly kind: string; readonly signed_at: string; readonly signature_method: "wet" | "esign" | "esign_ron" | "esign_ipen"; readonly signer_party_id: string; }
export interface NotarialAct { readonly closing_document_id: string; readonly act_type: "acknowledgment" | "jurat"; readonly completed_at: string; readonly certificate_indicates_communication_technology: boolean; readonly recordable: boolean; }
export interface SigningSession {
  readonly session_id: string; readonly closing_id: string; readonly application_id: string; readonly platform_session_ref: string | null; readonly mode: SessionMode; readonly signer_party_ids: readonly string[];
  readonly notary_party_id: string | null; readonly notary_commission_state: string | null; readonly notary_commission_number: string | null; readonly notary_physical_location_state: string | null; readonly signer_physical_location: Record<string, { state: string; country: string }>;
  readonly consent_record_id: string | null; readonly identity_proofing: readonly IdentityProofingRecord[]; readonly recording_ref: string | null; readonly recording_custodian: "ron_provider" | "notary_repository" | "sm" | null; readonly recording_retention_years: number | null; readonly journal_ref: string | null;
  readonly audit_trail_document_id: string | null; readonly audit_trail_hash: string | null; readonly audit_trail_received_at: string | null; readonly documents_signed: readonly SignedDocument[]; readonly notarial_acts: readonly NotarialAct[];
  readonly started_at: string | null; readonly ended_at: string | null; readonly status: SessionStatus; readonly failure_reason: SessionFailure | null; readonly retake_blocked_until: string | null; readonly retake_blocked_notary_party_id: string | null; readonly reschedule_proposal: readonly ClosingType[]; readonly retention_class: typeof RETENTION_ENOTE_SIGNING;
}
export type ENoteStatus = "created" | "signed" | "tamper_sealed" | "registered" | "secured_party_set" | "edelivered" | "control_transferred" | "reversed" | "converted_to_paper";
export interface ENote {
  readonly enote_id: string; readonly application_id: string; readonly closing_id: string; readonly closing_document_id: string; readonly min: string; readonly smart_doc_version: typeof SMART_DOC_VERSION;
  readonly controller_org_id: string; readonly location_org_id: string; readonly delegatee_org_id: string; readonly servicing_agent_org_id: string; readonly controller: "PARTNER" | "FNMA" | "SM"; readonly location: "SM" | "VENDOR" | "FNMA";
  readonly signing_completed_at: string | null; readonly tamper_sealed_at: string | null; readonly tamper_seal_hash: string | null; readonly tamper_seal_hash_alg: "SHA-256"; readonly authoritative_copy_ref: string | null; readonly authoritative_copy_validated_at: string | null;
  readonly registration_due_at: string | null; readonly registration_anchor_date: PlainDate | null; readonly eregistry_registration_txn_id: string | null; readonly registration_status: "pending" | "registered" | "rejected" | "reversed"; readonly registered_at: string | null;
  readonly secured_party_org_id: string | null; readonly secured_party_set_at: string | null; readonly edelivered_to_fnma_at: string | null; readonly transfer_control_location_at: string | null; readonly status: ENoteStatus;
}
export interface MersTransaction { readonly id: string; readonly application_id: string; readonly min: string; readonly txn_type: "eregistry_registration" | "eregistry_registration_reversal" | "eregistry_change_data_secured_party" | "eregistry_change_data_secured_party_release" | "eregistry_inquiry"; readonly request_signed_hash: string; readonly submitted_at: string; readonly ack_at: string | null; readonly result: "accepted" | "rejected" | null; readonly error_codes: readonly string[]; readonly channel: "xml"; }

// ============================================================ eRegistry / RON platform ports (vendor APIs UNVERIFIED — fakes are the contract)
export interface RegistrationRequest { readonly min: string; readonly controller_org_id: string; readonly location_org_id: string; readonly delegatee_org_id: string; readonly servicing_agent_org_id: string; readonly tamper_seal_hash: string; readonly smart_doc_version: string; readonly signature: string | null; }
export interface ERegistryAck { readonly txn_id: string; readonly accepted: boolean; readonly ack_at: string; readonly error_codes: readonly string[]; }
export interface ERegistryRecord { readonly min: string; readonly controller_org_id: string; readonly location_org_id: string; readonly delegatee_org_id: string; readonly secured_party_org_id: string | null; readonly tamper_seal_hash: string; readonly status: "active" | "reversed"; }
export interface ERegistryPort26 {
  register(req: RegistrationRequest, now: string): Promise<ERegistryAck>;
  changeDataSecuredParty(min: string, secured_party_org_id: string, signature: string | null, now: string): Promise<ERegistryAck>;
  reverseRegistration(min: string, reason: string, signature: string | null, now: string): Promise<ERegistryAck>;
  inquiry(min: string): Promise<ERegistryRecord | null>;
}
/** MERS eRegistry Rel. 16.25: unsigned XML is rejected; one Authoritative Copy per MIN; Change Data (Secured Party) only on a registered eNote. */
export class FakeERegistry26 implements ERegistryPort26 {
  readonly records = new Map<string, ERegistryRecord>();
  readonly requests: { kind: string; min: string; at: string; accepted: boolean }[] = [];
  rejectNext: string[] | null = null;
  private ack(kind: string, min: string, now: string, errors: string[]): ERegistryAck { this.requests.push({ kind, min, at: now, accepted: errors.length === 0 }); return { txn_id: `EREG-${this.requests.length}`, accepted: errors.length === 0, ack_at: toIso(Date.parse(now) + 2 * 60_000), error_codes: errors }; }
  async register(req: RegistrationRequest, now: string): Promise<ERegistryAck> {
    const errors: string[] = []; if (this.rejectNext) { errors.push(...this.rejectNext); this.rejectNext = null; }
    if (!req.signature) errors.push("E0001_UNSIGNED_REQUEST"); if (!/^\d{18}$/.test(req.min)) errors.push("E0102_MIN_FORMAT"); if (this.records.get(req.min)?.status === "active") errors.push("E0201_ALREADY_REGISTERED");
    if (!errors.length) this.records.set(req.min, { min: req.min, controller_org_id: req.controller_org_id, location_org_id: req.location_org_id, delegatee_org_id: req.delegatee_org_id, secured_party_org_id: null, tamper_seal_hash: req.tamper_seal_hash, status: "active" });
    return this.ack("registration", req.min, now, errors);
  }
  async changeDataSecuredParty(min: string, sp: string, signature: string | null, now: string): Promise<ERegistryAck> {
    const errors: string[] = []; const r = this.records.get(min); if (!signature) errors.push("E0001_UNSIGNED_REQUEST"); if (!r || r.status !== "active") errors.push("E0301_NOT_REGISTERED");
    if (!errors.length && r) this.records.set(min, { ...r, secured_party_org_id: sp }); return this.ack("change_data_secured_party", min, now, errors);
  }
  async reverseRegistration(min: string, _reason: string, signature: string | null, now: string): Promise<ERegistryAck> {
    const errors: string[] = []; const r = this.records.get(min); if (!signature) errors.push("E0001_UNSIGNED_REQUEST"); if (!r || r.status !== "active") errors.push("E0301_NOT_REGISTERED");
    if (!errors.length && r) this.records.set(min, { ...r, status: "reversed", secured_party_org_id: null }); return this.ack("registration_reversal", min, now, errors);
  }
  async inquiry(min: string): Promise<ERegistryRecord | null> { return this.records.get(min) ?? null; }
}
export interface RonPlatformPort { createSession(i: { closing_id: string; mode: SessionMode; signer_party_ids: readonly string[]; notary_party_id: string | null; scheduled_at: string }, now: string): Promise<{ platform_session_ref: string; join_url: string }>; }
export class FakeRonPlatform implements RonPlatformPort {
  readonly sessions: { ref: string; closing_id: string; mode: SessionMode; at: string }[] = [];
  async createSession(i: { closing_id: string; mode: SessionMode; signer_party_ids: readonly string[]; notary_party_id: string | null; scheduled_at: string }, now: string): Promise<{ platform_session_ref: string; join_url: string }> {
    const ref = `RON-${i.closing_id}-${this.sessions.length + 1}`; this.sessions.push({ ref, closing_id: i.closing_id, mode: i.mode, at: now }); return { platform_session_ref: ref, join_url: `https://eclose.example/s/${ref}` };
  }
}
/** Every XML Request carries a tamper-evident digital signature (SHA-256 over the canonical request under SM's signing key id). */
export const signRequest = (req: Record<string, unknown>, key_id = "SM-EREG-KEY-1"): string => sha256(`${key_id}:${JSON.stringify(req, Object.keys(req).sort())}`);

// ============================================================ clocks (MERS 1-BD; eRecording; cure; fallback; paper-note handoff)
const localDate = (iso: string, tz: string): PlainDate => wallClock(Date.parse(iso), tz).date;
export interface RegistrationDue { readonly anchor_date: PlainDate; readonly due_date: PlainDate; readonly due_at: string; readonly target_at: string; }
/** MERS_PROC_ENOTE_REGISTER_1BD: anchor = local date of the earlier of signing completion and the final tamper seal; +1 `business_days_federal`, end of that day 23:59 ET (MERS defines no unit — the federal calendar is the conservative reading); SM target: +2 hours. */
export function registrationDueAt(tamper_sealed_at: string, signing_completed_at: string | null, time_zone = "America/New_York"): RegistrationDue {
  const earlier = signing_completed_at && signing_completed_at < tamper_sealed_at ? signing_completed_at : tamper_sealed_at;
  const anchor_date = localDate(earlier, time_zone); const due_date = addBusinessDays(anchor_date, 1, federal);
  return { anchor_date, due_date, due_at: toIso(zonedEpochMs(due_date, "23:59", "America/New_York")), target_at: toIso(Date.parse(tamper_sealed_at) + 2 * 3_600_000) };
}
export const registrationOnTime = (registered_at: string, due: RegistrationDue): boolean => Date.parse(registered_at) <= Date.parse(due.due_at);
/** SM_O72_ERECORD_SUBMIT_1BD: +1 `business_days_creditor` from the anchor (dry state / refinance: the security instrument's notarial act — decision 26.2-Q3; wet state / purchase: `loan.funded`). */
export const erecordSubmitDue = (anchor: PlainDate): PlainDate => addBusinessDays(anchor, 1, creditor);
export const recordingAnchorKind = (c: Pick<Closing, "dry_state" | "transaction_type">): "notarial_act" | "loan_funded" => (c.dry_state || c.transaction_type !== "purchase" ? "notarial_act" : "loan_funded");
/** SM_O72_RECORDING_REJECT_CURE_2BD: +2 `business_days_creditor` from the rejection (Veterans Day is not a creditor business day). */
export const recordingRejectCureDue = (rejected_on: PlainDate): PlainDate => addBusinessDays(rejected_on, 2, creditor);
/** SM_O72_PAPER_FALLBACK_5BD: +5 `business_days_creditor` to confirm county receipt. */
export const paperFallbackDue = (fallback_date: PlainDate): PlainDate => addBusinessDays(fallback_date, 5, creditor);
/** SM_O72_PAPER_NOTE_HANDOFF_1BD: the settlement agent ships the original note by tracked overnight courier within +1 `business_days_creditor` of the signing date. */
export const paperNoteHandoffDue = (signing_date: PlainDate): PlainDate => addBusinessDays(signing_date, 1, creditor);
/** SM_O72_POST_SIGNING_REVIEW_4H: +4 hours, business hours (next creditor business morning 09:00 ET for evening sessions). */
export function postSigningReviewDue(consummation_at: string): string { const ms = Date.parse(consummation_at) + 4 * 3_600_000; const w = wallClock(ms, "America/New_York"); const d = creditor.isBusinessDay(w.date) && w.hour < 18 ? null : addBusinessDays(w.date, creditor.isBusinessDay(w.date) ? 1 : 0, creditor); return d ? toIso(zonedEpochMs(d, "09:00", "America/New_York")) : toIso(ms); }
/** Recording gap arithmetic: `gap_days = recorded_at.date − date_of_policy` (Schedule A); > 0 → Covered Risk 14 applies, no exception added. */
export const recordingGapDays = (recorded_at: string, date_of_policy: PlainDate, tz = "America/New_York"): number => daysBetween(date_of_policy, localDate(recorded_at, tz));

// ============================================================ consummation and the note date
export interface SignatureEvent { readonly closing_document_id: string; readonly kind: string; readonly signed_at: string; readonly signer_party_id: string; readonly required: boolean; readonly signature_method: SignedDocument["signature_method"]; }
export interface ConsummationResult { readonly consummation_at: string | null; readonly consummation_on: PlainDate | null; readonly note_date: PlainDate; readonly note_fully_signed: boolean; readonly redraw_required: boolean; readonly redraw_reason: "date_change" | null; readonly ancillaries_after_midnight: readonly string[]; }
/** `consummation_at` = timestamp of the final required note/eNote signature (25.3 anchors on the local date); note date printed = the scheduled signing date; a note signed after local midnight needs a re-draw (26.1), ancillaries after midnight do not. */
export function consummationFromSignatures(signatures: readonly SignatureEvent[], scheduled_note_date: PlainDate, time_zone: string, required_note_signers: readonly string[]): ConsummationResult {
  const note = signatures.filter((s) => (s.kind === "enote" || s.kind === "note") && required_note_signers.includes(s.signer_party_id));
  const fully = required_note_signers.every((p) => note.some((s) => s.signer_party_id === p));
  const last = note.map((s) => s.signed_at).sort().at(-1) ?? null;
  const consummation_on = last ? localDate(last, time_zone) : null;
  const redraw = !!consummation_on && consummation_on !== scheduled_note_date;
  const ancillaries_after_midnight = signatures.filter((s) => s.kind !== "enote" && s.kind !== "note" && localDate(s.signed_at, time_zone) > scheduled_note_date).map((s) => s.closing_document_id);
  return { consummation_at: fully ? last : null, consummation_on: fully ? consummation_on : null, note_date: scheduled_note_date, note_fully_signed: fully, redraw_required: fully && redraw, redraw_reason: fully && redraw ? "date_change" : null, ancillaries_after_midnight };
}

// ============================================================ Authoritative Copy / Secured Party / audit trail gates
/** SM_O72_ENOTE_LOCATION_GATE: the Authoritative Copy is in the Location eVault and its hash equals the platform's tamper seal (validated against the eRegistry hash once registered). */
export function enoteLocationGate(f: { tamper_seal_hash: string | null; evault_copy_hash: string | null; evault_status?: "intact" | "tampered" | "missing" | null }): { open: boolean; reason: string | null; hash_match: boolean } {
  if (!f.tamper_seal_hash) return { open: false, reason: "no tamper seal yet", hash_match: false };
  if (!f.evault_copy_hash || f.evault_status === "missing") return { open: false, reason: "Authoritative Copy not present in the Location eVault", hash_match: false };
  if (f.evault_status === "tampered") return { open: false, reason: "eVault copy failed integrity verification", hash_match: false };
  const hash_match = f.evault_copy_hash === f.tamper_seal_hash;
  return { open: hash_match, reason: hash_match ? null : `eVault copy hash ${f.evault_copy_hash.slice(0, 12)}… ≠ platform seal hash ${f.tamper_seal_hash.slice(0, 12)}… — registration request not sent`, hash_match };
}
export class LocationGateClosed extends RangeError { readonly code = "SM_O72_ENOTE_LOCATION_GATE_CLOSED"; constructor(reason: string) { super(`registerENote refused: ${reason}`); this.name = "LocationGateClosed"; } }
/** SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE (27.1 references before funding an advance on an eNote loan). */
export function securedPartyGate(f: { note_form: "enote" | "paper"; secured_party_org_id: string | null; secured_party_set_at?: string | null; registration_status?: string | null }): { open: boolean; reason: "secured_party_missing" | "enote_not_registered" | null } {
  if (f.note_form !== "enote") return { open: true, reason: null };
  if (f.registration_status && f.registration_status !== "registered") return { open: false, reason: "enote_not_registered" };
  return f.secured_party_org_id && f.secured_party_org_id === SM_ORG_ID ? { open: true, reason: null } : { open: false, reason: "secured_party_missing" };
}
export class AdvanceRefused extends RangeError { readonly code: "secured_party_missing" | "enote_not_registered"; constructor(code: "secured_party_missing" | "enote_not_registered") { super(`warehouse.advance refused for the eNote loan: ${code} — Change Data naming SM as Secured Party must be accepted first`); this.name = "AdvanceRefused"; this.code = code; } }
export function assertSecuredPartyBeforeAdvance(e: Pick<ENote, "secured_party_org_id" | "registration_status"> | null, note_form: "enote" | "paper"): void {
  const g = securedPartyGate({ note_form, secured_party_org_id: e?.secured_party_org_id ?? null, registration_status: e?.registration_status ?? (note_form === "enote" ? "pending" : null) });
  if (!g.open) throw new AdvanceRefused(g.reason!);
}
/** SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE: tamper-sealed audit trail received and hash-verified, recording reference and retention custodian recorded. */
export function auditTrailGate(f: { closing_type: ClosingType; audit_trail_received_at: string | null; audit_trail_hash: string | null; platform_hash: string | null; recording_ref: string | null; recording_custodian: string | null }): { open: boolean; reason: string | null } {
  if (f.closing_type === "wet") return { open: true, reason: null };
  if (!f.audit_trail_received_at) return { open: false, reason: "closing.audit_trail.received not on file — funding.authorize refused" };
  if (!f.audit_trail_hash || (f.platform_hash && f.platform_hash !== f.audit_trail_hash)) return { open: false, reason: "audit trail hash does not match the platform's" };
  if (f.closing_type === "ron" && (!f.recording_ref || !f.recording_custodian)) return { open: false, reason: "RON recording reference / retention custodian not recorded" };
  return { open: true, reason: null };
}
export class FundingBlocked extends RangeError { readonly code = "SM_O72_AUDIT_TRAIL_BEFORE_FUNDING_GATE_CLOSED"; readonly command: string; constructor(command: string, reason: string) { super(`${command} refused: ${reason}`); this.name = "FundingBlocked"; this.command = command; } }
export function assertAuditTrailOnFile(s: Pick<SigningSession, "mode" | "audit_trail_received_at" | "audit_trail_hash" | "recording_ref" | "recording_custodian"> | null, closing_type: ClosingType, command = "funding.authorize"): void {
  const g = auditTrailGate({ closing_type, audit_trail_received_at: s?.audit_trail_received_at ?? null, audit_trail_hash: s?.audit_trail_hash ?? null, platform_hash: null, recording_ref: s?.recording_ref ?? null, recording_custodian: s?.recording_custodian ?? null });
  if (!g.open) throw new FundingBlocked(command, g.reason!);
}

// ============================================================ execution review (reviewExecution)
export type DefectCode = "instrument_altered" | "signature_missing" | "name_variance" | "notarial_certificate_incomplete" | "witness_count_short" | "poa_form" | "min_missing" | "rescission_notice_unsigned" | "cd_acknowledgment_missing" | "tx_receipt_missing" | "enote_hash_mismatch" | "audit_trail_hash_mismatch" | "recording_format";
export interface ExecutionDefect { readonly code: DefectCode; readonly closing_document_id: string; readonly detail: string; readonly blocking: boolean; readonly cure: "redraw" | "name_affidavit" | "re_execute" | "re_notarize" | "reformat" | "obtain"; }
export interface ExecutedDocument { readonly closing_document_id: string; readonly kind: string; readonly form: "paper" | "electronic"; readonly required_signers: readonly { party_id: string; typed_name: string; capacity: string }[]; readonly signatures: readonly { party_id: string; signed_name: string; attributable: boolean; dated: boolean }[]; readonly notarized: boolean; readonly notarial_certificate?: { venue: boolean; date: boolean; notary_name: boolean; commission_expiry: boolean; seal: boolean; ron_statement: boolean | null } | null; readonly witness_count_required: number; readonly witnesses: number; readonly handwritten_changes: readonly { field: string; description: string }[]; readonly recordable: boolean; readonly min_present: boolean; readonly cover_sheet: boolean; readonly poa_signature_form_ok?: boolean | null; readonly smart_doc_hash?: string | null; readonly eregistry_hash?: string | null; }
export interface ExecutionReview { readonly passed: boolean; readonly defects: readonly ExecutionDefect[]; readonly funding_blocked: boolean; readonly redraw: { reason: "qc_defect_found"; documents: readonly string[] } | null; readonly name_affidavits: readonly string[]; }
const normName = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");
export function reviewExecution(docs: readonly ExecutedDocument[], audit: { audit_trail_hash: string | null; platform_hash: string | null } | null = null): ExecutionReview {
  const defects: ExecutionDefect[] = [];
  for (const d of docs) {
    if (d.handwritten_changes.length) defects.push({ code: "instrument_altered", closing_document_id: d.closing_document_id, detail: `handwritten change to ${d.handwritten_changes.map((h) => h.field).join(", ")} on a ${d.form} ${d.kind}`, blocking: true, cure: "redraw" });
    for (const s of d.required_signers) {
      const sig = d.signatures.find((x) => x.party_id === s.party_id);
      if (!sig || !sig.attributable || !sig.dated) defects.push({ code: "signature_missing", closing_document_id: d.closing_document_id, detail: `${s.typed_name} (${s.capacity}) signature missing, undated or not attributable`, blocking: true, cure: "re_execute" });
      else if (normName(sig.signed_name) !== normName(s.typed_name)) defects.push({ code: "name_variance", closing_document_id: d.closing_document_id, detail: `signed "${sig.signed_name}" vs typed "${s.typed_name}" (B8-3-03 variance → name affidavit)`, blocking: false, cure: "name_affidavit" });
    }
    if (d.notarized) { const c = d.notarial_certificate; if (!c || !c.venue || !c.date || !c.notary_name || !c.commission_expiry || !c.seal || c.ron_statement === false) defects.push({ code: "notarial_certificate_incomplete", closing_document_id: d.closing_document_id, detail: "venue/date/notary name/commission expiry/seal/RON statement", blocking: true, cure: "re_notarize" }); }
    if (d.witnesses < d.witness_count_required) defects.push({ code: "witness_count_short", closing_document_id: d.closing_document_id, detail: `${d.witnesses} of ${d.witness_count_required} witnesses`, blocking: true, cure: "re_execute" });
    if (d.poa_signature_form_ok === false) defects.push({ code: "poa_form", closing_document_id: d.closing_document_id, detail: "POA signature not in the form 'by X, attorney-in-fact' or POA copy missing", blocking: true, cure: "re_execute" });
    if (d.recordable && !d.min_present) defects.push({ code: "min_missing", closing_document_id: d.closing_document_id, detail: "MIN not on the recordable page set", blocking: true, cure: "redraw" });
    if (d.recordable && !d.cover_sheet) defects.push({ code: "recording_format", closing_document_id: d.closing_document_id, detail: "county cover sheet / margins", blocking: false, cure: "reformat" });
    if (d.kind === "rescission_notice_h8" && d.signatures.some((s) => !s.dated)) defects.push({ code: "rescission_notice_unsigned", closing_document_id: d.closing_document_id, detail: "H-8 receipt not signed and dated", blocking: true, cure: "obtain" });
    if (d.kind === "enote" && d.smart_doc_hash && d.eregistry_hash && d.smart_doc_hash !== d.eregistry_hash) defects.push({ code: "enote_hash_mismatch", closing_document_id: d.closing_document_id, detail: "SMART Doc hash ≠ eRegistry hash", blocking: true, cure: "redraw" });
  }
  if (audit?.audit_trail_hash && audit.platform_hash && audit.audit_trail_hash !== audit.platform_hash) defects.push({ code: "audit_trail_hash_mismatch", closing_document_id: "*", detail: "audit trail hash ≠ platform hash", blocking: true, cure: "obtain" });
  const blocking = defects.filter((d) => d.blocking); const redrawDocs = defects.filter((d) => d.cure === "redraw").map((d) => d.closing_document_id);
  return { passed: blocking.length === 0, defects, funding_blocked: blocking.length > 0, redraw: redrawDocs.length ? { reason: "qc_defect_found", documents: [...new Set(redrawDocs)] } : null, name_affidavits: defects.filter((d) => d.code === "name_variance").map((d) => d.closing_document_id) };
}

// ============================================================ delivery data (ULDD) and the electronic loan file
export interface DeliveryIndicators { readonly enote_indicator: boolean; readonly remote_notarization_indicator: boolean; readonly min: string | null; readonly eregistry_status: ENote["registration_status"] | null; readonly recording: { instrument_number: string; recorded_at: string } | null; }
export function deliveryIndicators(c: Pick<Closing, "note_form" | "closing_type">, e: Pick<ENote, "min" | "registration_status"> | null, sessions: readonly Pick<SigningSession, "mode" | "notarial_acts">[], rec: Pick<Recording, "instrument_number" | "recorded_at"> | null): DeliveryIndicators {
  const ron = c.closing_type === "ron" && sessions.some((s) => s.mode === "ron" && s.notarial_acts.some((a) => a.recordable && a.certificate_indicates_communication_technology));
  return { enote_indicator: c.note_form === "enote", remote_notarization_indicator: ron, min: e?.min ?? null, eregistry_status: e?.registration_status ?? null, recording: rec?.instrument_number && rec.recorded_at ? { instrument_number: rec.instrument_number, recorded_at: rec.recorded_at } : null };
}
/** The electronic loan file handed to servicing/delivery: signed documents, the tamper-sealed audit trail (life of loan + 7 years), signing evidence, eRegistry acknowledgments, recording receipts. */
export function electronicLoanFile(c: Closing, sessions: readonly SigningSession[], e: ENote | null, mers: readonly MersTransaction[], recs: readonly Recording[]): { audit_trails: readonly { session_id: string; document_id: string; hash: string; retention_class: string }[]; signing_records: readonly { session_id: string; documents: readonly SignedDocument[]; identity: readonly { party_id: string; method: IdentityMethod; result: string }[] }[]; eregistry: readonly MersTransaction[]; recordings: readonly { recording_id: string; instrument_number: string | null; recorded_at: string | null }[]; enote: ENote | null; indicators: DeliveryIndicators } {
  return {
    audit_trails: sessions.filter((s) => s.audit_trail_document_id && s.audit_trail_hash).map((s) => ({ session_id: s.session_id, document_id: s.audit_trail_document_id!, hash: s.audit_trail_hash!, retention_class: RETENTION_ENOTE_SIGNING })),
    signing_records: sessions.map((s) => ({ session_id: s.session_id, documents: s.documents_signed, identity: s.identity_proofing.map((p) => ({ party_id: p.party_id, method: p.method, result: p.result })) })),
    eregistry: mers, recordings: recs.map((r) => ({ recording_id: r.recording_id, instrument_number: r.instrument_number, recorded_at: r.recorded_at })), enote: e,
    indicators: deliveryIndicators(c, e, sessions, recs.find((r) => r.recorded_at) ?? null),
  };
}

// ============================================================ recordings / custody (entity shapes)
export interface Recording { readonly recording_id: string; readonly closing_id: string; readonly application_id: string; readonly closing_document_id: string; readonly channel: "erecording" | "paper"; readonly vendor: string | null; readonly submitter_party_id: string; readonly state: string; readonly county: string; readonly county_fips: string | null; readonly package_ref: string | null; readonly pria_model: "model_1_image" | "model_2_image_index" | "model_3_xml"; readonly submitted_at: string | null; readonly accepted_at: string | null; readonly rejected_at: string | null; readonly rejection_reason: string | null; readonly resubmitted_count: number; readonly paper_fallback_at: string | null; readonly tracking_ref: string | null; readonly county_receipt_at: string | null; readonly recorded_at: string | null; readonly instrument_number: string | null; readonly book_page: string | null; readonly recording_fee_cents: bigint | null; readonly recorded_image_document_id: string | null; readonly date_of_policy: PlainDate | null; readonly gap_days: number | null; readonly status: "pending" | "submitted" | "accepted" | "rejected" | "paper_fallback" | "recorded"; readonly anchor_date: PlainDate; readonly due_date: PlainDate; }
export type NoteLocation = "settlement_agent" | "courier" | "warehouse_custodian" | "document_custodian" | "released_form_2009";
export interface CustodyLink { readonly holder_party_id: string; readonly holder_role: NoteLocation; readonly from_at: string; readonly to_at: string | null; readonly tracking_ref: string | null; readonly evidence_document_id: string | null; }
export interface CustodyRecord { readonly application_id: string; readonly closing_id: string; readonly note_form: "paper"; readonly note_location: NoteLocation; readonly custodian_party_id: string; readonly chain: readonly CustodyLink[]; readonly original_received_at: string | null; readonly handoff_due: PlainDate; }

// ============================================================ emitters (the closer's acts)
export interface ScheduleClosingInput { readonly closing_id: string; readonly application_id: string; readonly scheduled_at: string; readonly time_zone: string; readonly decision: ClosingTypeDecision; readonly state: string; readonly county_fips: string | null; readonly transaction_type: Closing["transaction_type"]; readonly tx_50a6: boolean; readonly rescindable: boolean; readonly dry_state: boolean; readonly settlement_agent_party_id: string; readonly notary_party_id: string | null; readonly ron_provider_party_id: string | null; readonly location_type: Closing["location_type"]; readonly hpml: HpmlRow | null; readonly document_set_id: string | null; readonly at: string; }
/** `closing.scheduled` — the trigger every pre-closing gate in §22–§26 and 30.3 keys on; the HPML fields are stamped from 23.4's row (hpmlClosingPayload). TX 50(a)(6) closings are refused outside a permitted office. */
export function scheduleClosing(events: EventStore, i: ScheduleClosingInput): { closing: Closing; event: DomainEvent } {
  if (i.tx_50a6 && !txClosingLocationOk(i.location_type, true)) throw new RangeError(`TX 50(a)(6): closing location must be a permanent office of the lender, an attorney or a title company (got ${i.location_type ?? "none"})`);
  if (i.decision.closing_type === "ron" && i.notary_party_id === null && i.ron_provider_party_id === null) throw new RangeError("a RON closing needs a notary or RON provider");
  const h = i.hpml ? hpmlClosingPayload(i.hpml) : { is_hpml: false, escrow_required: false, appraisal_rules_apply: false, escrow_min_cancel_date: null };
  const scheduled_note_date = localDate(i.scheduled_at, i.time_zone);
  const closing: Closing = { closing_id: i.closing_id, application_id: i.application_id, scheduled_at: i.scheduled_at, time_zone: i.time_zone, scheduled_note_date, closing_type: i.decision.closing_type, note_form: i.decision.note_form, state: i.state, county_fips: i.county_fips, transaction_type: i.transaction_type, tx_50a6: i.tx_50a6, rescindable: i.rescindable, dry_state: i.dry_state, settlement_agent_party_id: i.settlement_agent_party_id, notary_party_id: i.notary_party_id, ron_provider_party_id: i.ron_provider_party_id, location_type: i.location_type, ...h, document_set_id: i.document_set_id, documents_released_at: null, instructions_acknowledged_at: null, enote_indicator: i.decision.enote_indicator, remote_notarization_indicator: i.decision.remote_notarization_indicator, witness_manifest: [], pre_session_checks_passed_at: null, signing_start_at: null, signing_end_at: null, consummation_at: null, consummation_on: null, note_date: null, execution_review_passed_at: null, execution_defects: [], execution_status: "scheduled", session_ids: [], audit_trail_document_ids: [] };
  const event = events.append({ type: "closing.scheduled", applicationId: i.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: i.application_id, closing_id: i.closing_id, scheduled_at: i.scheduled_at, scheduled_note_date, closing_type: closing.closing_type, note_form: closing.note_form, enote: closing.note_form === "enote", ron: closing.closing_type === "ron", wet: closing.closing_type === "wet", settlement_agent_party_id: i.settlement_agent_party_id, notary_party_id: i.notary_party_id, ron_provider_party_id: i.ron_provider_party_id, transaction_type: i.transaction_type, tx_50a6: i.tx_50a6, state: i.state, is_hpml: h.is_hpml, escrow_required: h.escrow_required, appraisal_rules_apply: h.appraisal_rules_apply, escrow_min_cancel_date: h.escrow_min_cancel_date, closing_type_reasons: i.decision.reasons, rule_set_version: RULE_SET_VERSION_26_2 } });
  return { closing, event };
}
/** 26.1's `closing.documents.released` / `closing.instructions.acknowledged` fold into the closing — the signing gate. */
export function applyReleaseEvent(c: Closing, e: DomainEvent): Closing {
  const p = e.payload as Record<string, unknown>;
  if (e.type === "closing.documents.released") return { ...c, document_set_id: (p.set_id as string) ?? c.document_set_id, documents_released_at: e.occurredAt, execution_status: c.execution_status === "scheduled" ? "package_released" : c.execution_status };
  if (e.type === "closing.instructions.acknowledged") return { ...c, instructions_acknowledged_at: e.occurredAt };
  return c;
}
export function recordEligibilityCheck(events: EventStore, c: Closing, check: "ron_state_auth" | "agent_eclosing", result: { eligible: boolean; refusals?: readonly string[]; reason?: string | null; downgrade_to?: ClosingType | null }, at: string): DomainEvent {
  return events.append({ type: "closing.eligibility.checked", applicationId: c.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: c.application_id, closing_id: c.closing_id, check, result: result.eligible ? "eligible" : "refused", refusals: result.refusals ?? (result.reason ? [result.reason] : []), downgrade_to: result.downgrade_to ?? null, closing_type: c.closing_type } });
}
export function verifyConsent(events: EventStore, c: Closing, consent: ClosingEsignConsent | null, at: string): { open: boolean; reason: string | null; event: DomainEvent | null } {
  const r = esignConsentCheck(consent, c.closing_type, at); if (!r.open) return { ...r, event: null };
  return { ...r, event: events.append({ type: "closing.consent.verified", applicationId: c.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: c.application_id, closing_id: c.closing_id, consent_id: consent?.consent_id ?? null, scope: consent?.scope ?? ["paper"], paper_option_offered: true, reaffirmed_at: at } }) };
}
export function passPreSessionChecks(events: EventStore, c: Closing, r: PreSessionResult, at: string): { closing: Closing; event: DomainEvent } {
  if (!r.passed) throw new RangeError(`pre-session checks blocked: ${r.blocking.join("; ")}`);
  return { closing: { ...c, pre_session_checks_passed_at: at, execution_status: "pre_session_checks_passed" }, event: events.append({ type: "closing.pre_session_checks.passed", applicationId: c.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: c.application_id, closing_id: c.closing_id, checked: r.checked } }) };
}
export const sessionModeFor = (ct: ClosingType): SessionMode => (ct === "ron" ? "ron" : ct === "ipen" ? "ipen" : ct === "hybrid" ? "esign_only" : "wet_witnessed");
export function openSigningSession(events: EventStore, c: Closing, i: { session_id: string; at: string; signer_party_ids: readonly string[]; notary: { party_id: string; commission_state: string; commission_number: string; physical_location_state: string } | null; platform_session_ref: string | null; consent_record_id: string | null; signer_physical_location?: Record<string, { state: string; country: string }>; rule?: JurisdictionRonRule }): { closing: Closing; session: SigningSession; event: DomainEvent } {
  const guardAge = Date.parse(i.at) - Date.parse(c.pre_session_checks_passed_at ?? "1970-01-01T00:00:00Z");
  if (!c.pre_session_checks_passed_at || guardAge > 24 * 3_600_000) throw new RangeError("session_in_progress requires pre_session_checks_passed within the last 24 hours");
  if (!c.documents_released_at) throw new RangeError("the document set has not been released (26.1 closing.documents.released)");
  if (c.tx_50a6 && !c.instructions_acknowledged_at) throw new RangeError("TX 50(a)(6): SM_O71_INSTRUCTIONS_ACK_GATE closed");
  const mode = sessionModeFor(c.closing_type); const r = i.rule ?? ronRule(c.state);
  if (mode === "ron" && i.notary && r.notary_in_state_required && (i.notary.commission_state !== c.state || i.notary.physical_location_state !== c.state)) throw new RangeError(`RON notary must be commissioned and physically located in ${c.state}`);
  const session: SigningSession = { session_id: i.session_id, closing_id: c.closing_id, application_id: c.application_id, platform_session_ref: i.platform_session_ref, mode, signer_party_ids: i.signer_party_ids, notary_party_id: i.notary?.party_id ?? null, notary_commission_state: i.notary?.commission_state ?? null, notary_commission_number: i.notary?.commission_number ?? null, notary_physical_location_state: i.notary?.physical_location_state ?? null, signer_physical_location: i.signer_physical_location ?? {}, consent_record_id: i.consent_record_id, identity_proofing: [], recording_ref: null, recording_custodian: mode === "ron" ? "ron_provider" : null, recording_retention_years: mode === "ron" ? r.recording_retention_years : null, journal_ref: null, audit_trail_document_id: null, audit_trail_hash: null, audit_trail_received_at: null, documents_signed: [], notarial_acts: [], started_at: null, ended_at: null, status: i.consent_record_id || mode === "wet_witnessed" ? "consent_captured" : "created", failure_reason: null, retake_blocked_until: null, retake_blocked_notary_party_id: null, reschedule_proposal: [], retention_class: RETENTION_ENOTE_SIGNING };
  const event = events.append({ type: "closing.session.created", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: i.session_id, mode, platform_session_ref: i.platform_session_ref, notary_party_id: session.notary_party_id, signer_party_ids: i.signer_party_ids } });
  return { closing: { ...c, session_ids: [...c.session_ids, i.session_id] }, session, event };
}
export interface ProofIdentityInput { readonly party_id: string; readonly method: IdentityMethod; readonly credential_type: string | null; readonly credential_analysis_result: "pass" | "fail" | null; readonly kba_attempts: readonly KbaAttempt[]; readonly vendor: string | null; readonly evidence_document_id: string | null; readonly at: string; readonly notary_party_id: string; readonly rule?: JurisdictionRonRule; readonly notary_refused?: boolean; }
/** Technical path = credential analysis pass + KBA pass; non-technical (personal knowledge / credible witness) only where the state and Fannie Mae permit; a notary's refusal is never overridden. */
export function proofIdentity(events: EventStore, c: Closing, s: SigningSession, i: ProofIdentityInput): { session: SigningSession; record: IdentityProofingRecord; kba: KbaEvaluation | null; events: DomainEvent[] } {
  const r = i.rule ?? ronRule(c.state); const out: DomainEvent[] = [];
  if (!r.identity_proofing_methods.includes(i.method)) throw new RangeError(`${i.method} is not an identity-proofing method ${c.state} permits`);
  let result: IdentityProofingRecord["result"]; let kba: KbaEvaluation | null = null; let failure: SessionFailure | null = null;
  if (i.notary_refused) { result = "failed"; failure = "identity"; }
  else if (i.method === "credential_analysis_kba") {
    if (i.credential_analysis_result !== "pass") { result = "failed"; failure = "credential_analysis"; }
    else { kba = evaluateKba(i.kba_attempts, r.kba_params); result = kba.result === "pass" ? "proofed" : kba.result === "retake_allowed" ? "retake_offered" : "failed"; if (result === "failed") failure = "identity"; }
  } else result = "proofed";
  const record: IdentityProofingRecord = { party_id: i.party_id, method: i.method, credential_type: i.credential_type, credential_analysis_result: i.credential_analysis_result, kba: kba ? { questions: i.kba_attempts.at(-1)?.questions ?? 0, correct: i.kba_attempts.at(-1)?.correct ?? 0, attempts: kba.attempts, seconds: i.kba_attempts.at(-1)?.seconds ?? 0 } : null, vendor: i.vendor, evidence_document_id: i.evidence_document_id, result, proofed_at: result === "proofed" ? i.at : null };
  const identity_proofing = [...s.identity_proofing.filter((p) => p.party_id !== i.party_id), record];
  if (result === "failed") {
    const blocked = kba?.retake_blocked_until ?? toIso(Date.parse(i.at) + r.kba_params.retake_within_hours * 3_600_000);
    const session: SigningSession = { ...s, identity_proofing, status: "failed", failure_reason: failure, ended_at: i.at, retake_blocked_until: blocked, retake_blocked_notary_party_id: i.notary_party_id, reschedule_proposal: ["wet", "ipen"] };
    out.push(events.append({ type: "closing.session.failed", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, reason: failure, party_id: i.party_id, kba_reasons: kba?.reasons ?? [], retake_blocked_until: blocked, retake_blocked_notary_party_id: i.notary_party_id, reschedule_proposal: ["wet", "ipen"] } }));
    return { session, record, kba, events: out };
  }
  const allProofed = s.signer_party_ids.every((p) => identity_proofing.some((x) => x.party_id === p && x.result === "proofed"));
  const session: SigningSession = { ...s, identity_proofing, status: allProofed ? "identity_proofed" : s.status };
  out.push(events.append({ type: "closing.identity.proofed", applicationId: c.application_id, actor: { kind: "external", id: i.notary_party_id, role: "notary" }, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, party_id: i.party_id, method: i.method, result, attempts: kba?.attempts ?? 1, retake_deadline: kba?.retake_deadline ?? null } }));
  return { session, record, kba, events: out };
}
export function startSession(events: EventStore, c: Closing, s: SigningSession, at: string): { closing: Closing; session: SigningSession; event: DomainEvent } {
  if (s.status === "failed" || s.status === "abandoned") throw new RangeError(`session ${s.session_id} is ${s.status}`);
  if (s.mode !== "wet_witnessed" && s.status !== "identity_proofed") throw new RangeError("every signer must be identity-proofed before the session starts");
  return { closing: { ...c, signing_start_at: c.signing_start_at ?? at, execution_status: "session_in_progress" }, session: { ...s, status: "in_session", started_at: at }, event: events.append({ type: "closing.session.started", applicationId: c.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, mode: s.mode, automation_disclosed: true } }) };
}
export interface SignDocumentInput { readonly closing_document_id: string; readonly kind: string; readonly signer_party_id: string; readonly signed_at: string; readonly signature_method: SignedDocument["signature_method"]; readonly required_note_signers: readonly string[]; readonly single_record: boolean; readonly action_taken: boolean; readonly hpml?: HpmlRow | null; }
/** `closing.document.signed`; the final required note/eNote signature is `closing.consummated` (the Reg Z consummation moment) and, for an eNote, `enote.signed`. B8-8-01: one signature per record, initiated by the signer's own action. */
export function signDocument(events: EventStore, c: Closing, s: SigningSession, i: SignDocumentInput): { closing: Closing; session: SigningSession; consummation: ConsummationResult | null; events: DomainEvent[] } {
  if (s.status !== "in_session" && s.status !== "documents_signed") throw new RangeError(`session ${s.session_id} is ${s.status}`);
  if (!i.single_record || !i.action_taken) throw new RangeError("B8-8-01: a single electronic signature cannot be applied to multiple records and must be initiated by the signer");
  if ((i.kind === "enote" && i.signature_method === "wet") || (i.kind === "note" && i.signature_method !== "wet")) throw new RangeError("the note is single-method: eNote fully electronic or paper note fully wet");
  const out: DomainEvent[] = []; const signed: SignedDocument = { closing_document_id: i.closing_document_id, kind: i.kind, signed_at: i.signed_at, signature_method: i.signature_method, signer_party_id: i.signer_party_id };
  out.push(events.append({ type: "closing.document.signed", applicationId: c.application_id, actor: { kind: "external", id: i.signer_party_id, role: "signer" }, occurredAt: i.signed_at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, closing_document_id: i.closing_document_id, kind: i.kind, signed_at: i.signed_at, signature_method: i.signature_method, signer_party_id: i.signer_party_id } }));
  const documents_signed = [...s.documents_signed, signed];
  let closing = c; let consummation: ConsummationResult | null = null;
  if ((i.kind === "enote" || i.kind === "note") && !c.consummation_at) {
    consummation = consummationFromSignatures(documents_signed.map((d) => ({ ...d, required: true })), c.scheduled_note_date, c.time_zone, i.required_note_signers);
    if (consummation.note_fully_signed) {
      if (consummation.redraw_required) throw new RangeError(`note signed ${consummation.consummation_on} after the scheduled note date ${c.scheduled_note_date} — re-draw required (26.1 date_change)`);
      const anchor_date = c.transaction_type === "purchase" && !c.dry_state ? c.scheduled_note_date : null;   // MERS_PROC_MOM_REGISTER_7 (26.4): note date for purchases outside escrow states, funding date otherwise
      closing = { ...c, consummation_at: consummation.consummation_at, consummation_on: consummation.consummation_on, note_date: consummation.note_date, execution_status: "signed" };
      const h = i.hpml ? hpmlClosingPayload(i.hpml) : { is_hpml: c.is_hpml, escrow_required: c.escrow_required, appraisal_rules_apply: c.appraisal_rules_apply, escrow_min_cancel_date: c.escrow_min_cancel_date };
      out.push(events.append({ type: "closing.consummated", applicationId: c.application_id, actor: CLOSER, occurredAt: consummation.consummation_at!, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, consummation_at: consummation.consummation_at, consummation_on: consummation.consummation_on, consummation_date_local: consummation.consummation_on, note_date: consummation.note_date, anchor_date, tx_50a6: c.tx_50a6, is_hpml: h.is_hpml, escrow_required: h.escrow_required, appraisal_rules_apply: h.appraisal_rules_apply, escrow_min_cancel_date: h.escrow_min_cancel_date, note_form: c.note_form, enote_indicator: c.note_form === "enote", remote_notarization_indicator: c.closing_type === "ron", closing_type: c.closing_type, transaction_type: c.transaction_type, rescindable: c.rescindable, state: c.state, dry_state: c.dry_state, signing_date: consummation.consummation_on } }));
      if (i.kind === "enote") out.push(events.append({ type: "enote.signed", applicationId: c.application_id, actor: CLOSER, occurredAt: consummation.consummation_at!, payload: { application_id: c.application_id, closing_id: c.closing_id, closing_document_id: i.closing_document_id, signing_completed_at: consummation.consummation_at, signers: i.required_note_signers } }));
    }
  }
  return { closing, session: { ...s, documents_signed, status: "documents_signed" }, consummation, events: out };
}
export interface NotarialActInput { readonly closing_document_id: string; readonly kind: string; readonly act_type: "acknowledgment" | "jurat"; readonly completed_at: string; readonly certificate_indicates_communication_technology: boolean; readonly recordable: boolean; readonly last: boolean; readonly notary_party_id: string; readonly connectivity_lost?: boolean; }
/** Only the notary performs the act; a RON certificate must indicate communication technology; connectivity loss voids the act (the notary restarts it, both logged). The security instrument's act anchors the dry-state recording clock. */
export function completeNotarialAct(events: EventStore, c: Closing, s: SigningSession, i: NotarialActInput): { closing: Closing; session: SigningSession; event: DomainEvent } {
  if (i.notary_party_id !== s.notary_party_id) throw new RangeError("only the session's notary performs the notarial act");
  if (i.connectivity_lost) return { closing: c, session: s, event: events.append({ type: "closing.notarial_act.voided", applicationId: c.application_id, actor: { kind: "external", id: i.notary_party_id, role: "notary" }, occurredAt: i.completed_at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, closing_document_id: i.closing_document_id, reason: "connectivity_lost — the notary restarts the act; no partial notarization" } }) };
  if (s.mode === "ron" && !i.certificate_indicates_communication_technology) throw new RangeError("A.R.S. §41-263 / R.C. 147.64: the RON certificate must indicate the act was performed using communication technology");
  const act: NotarialAct = { closing_document_id: i.closing_document_id, act_type: i.act_type, completed_at: i.completed_at, certificate_indicates_communication_technology: i.certificate_indicates_communication_technology, recordable: i.recordable };
  const recording_anchor = i.recordable && i.kind === "security_instrument" && recordingAnchorKind(c) === "notarial_act";
  const anchor_date = localDate(i.completed_at, c.time_zone);
  const event = events.append({ type: "closing.notarial_act.completed", applicationId: c.application_id, actor: { kind: "external", id: i.notary_party_id, role: "notary" }, occurredAt: i.completed_at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, closing_document_id: i.closing_document_id, kind: i.kind, act_type: i.act_type, last: i.last, recordable: i.recordable, recording_anchor, anchor_date, erecord_due: recording_anchor ? erecordSubmitDue(anchor_date) : null, certificate_indicates_communication_technology: i.certificate_indicates_communication_technology } });
  return { closing: i.last ? { ...c, execution_status: "notarized", remote_notarization_indicator: c.closing_type === "ron" && (c.remote_notarization_indicator || i.certificate_indicates_communication_technology) } : c, session: { ...s, notarial_acts: [...s.notarial_acts, act], status: i.last ? "notarial_acts_complete" : s.status }, event };
}
export function createENote(c: Closing, i: { enote_id: string; closing_document_id: string; min: string; partner_org_id: string; location_org_id?: string }): ENote {
  if (c.note_form !== "enote") throw new RangeError("the closing's note form is paper — a paper note is never converted into an eNote (A2-4.1-03)");
  return { enote_id: i.enote_id, application_id: c.application_id, closing_id: c.closing_id, closing_document_id: i.closing_document_id, min: i.min, smart_doc_version: SMART_DOC_VERSION, controller_org_id: i.partner_org_id, location_org_id: i.location_org_id ?? SM_ORG_ID, delegatee_org_id: SM_ORG_ID, servicing_agent_org_id: SM_ORG_ID, controller: "PARTNER", location: i.location_org_id && i.location_org_id !== SM_ORG_ID ? "VENDOR" : "SM", signing_completed_at: null, tamper_sealed_at: null, tamper_seal_hash: null, tamper_seal_hash_alg: "SHA-256", authoritative_copy_ref: null, authoritative_copy_validated_at: null, registration_due_at: null, registration_anchor_date: null, eregistry_registration_txn_id: null, registration_status: "pending", registered_at: null, secured_party_org_id: null, secured_party_set_at: null, edelivered_to_fnma_at: null, transfer_control_location_at: null, status: "created" };
}
/** After the last eNote signature the platform applies the SHA-256 tamper-evident seal → `enote.tamper_sealed` (arms MERS_PROC_ENOTE_REGISTER_1BD on the local anchor date, SM_O72_ENOTE_SAME_DAY_REGISTER, SM_O72_ENOTE_LOCATION_GATE). */
export function tamperSeal(events: EventStore, c: Closing, e: ENote, i: { tamper_sealed_at: string; seal_hash: string; signing_completed_at: string; authoritative_copy_ref: string | null }): { enote: ENote; due: RegistrationDue; event: DomainEvent } {
  if (!c.consummation_at) throw new RangeError("the eNote is sealed only after the final required signature");
  const due = registrationDueAt(i.tamper_sealed_at, i.signing_completed_at, c.time_zone);
  const enote: ENote = { ...e, signing_completed_at: i.signing_completed_at, tamper_sealed_at: i.tamper_sealed_at, tamper_seal_hash: i.seal_hash, authoritative_copy_ref: i.authoritative_copy_ref, registration_due_at: due.due_at, registration_anchor_date: due.anchor_date, status: "tamper_sealed" };
  const event = events.append({ type: "enote.tamper_sealed", applicationId: c.application_id, actor: { kind: "external", id: "eclosing_platform" }, occurredAt: i.tamper_sealed_at, payload: { application_id: c.application_id, closing_id: c.closing_id, enote_id: e.enote_id, min: e.min, tamper_sealed_at: i.tamper_sealed_at, signing_completed_at: i.signing_completed_at, registration_anchor_date: due.anchor_date, registration_due_at: due.due_at, registration_target_at: due.target_at, seal_hash: i.seal_hash, hash_alg: "SHA-256", authoritative_copy_ref: i.authoritative_copy_ref } });
  return { enote, due, event };
}
/** SM (Location) validates the eVault copy's hash against the platform seal → `enote.authoritative_copy.validated{hash_match}`; only a match opens SM_O72_ENOTE_LOCATION_GATE. */
export function validateAuthoritativeCopy(events: EventStore, c: Closing, e: ENote, i: { evault_copy_hash: string | null; evault_status: "intact" | "tampered" | "missing"; at: string }): { enote: ENote; gate: ReturnType<typeof enoteLocationGate>; event: DomainEvent } {
  const gate = enoteLocationGate({ tamper_seal_hash: e.tamper_seal_hash, evault_copy_hash: i.evault_copy_hash, evault_status: i.evault_status });
  const event = events.append({ type: "enote.authoritative_copy.validated", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, enote_id: e.enote_id, min: e.min, hash_match: gate.hash_match, gate_open: gate.open, reason: gate.reason, evault_status: i.evault_status, location_org_id: e.location_org_id } });
  return { enote: gate.open ? { ...e, authoritative_copy_validated_at: i.at } : e, gate, event };
}
/** Digitally signed Registration XML (Controller = partner; Location = SM/vendor eVault; Delegatee for Transfers = SM; Servicing Agent = SM; the 26.1 MIN) — refused while the Location gate is closed; acceptance → `enote.registered`, rejection → `enote.registration.rejected`. */
export async function registerENote(events: EventStore, registry: ERegistryPort26, c: Closing, e: ENote, i: { at: string; signing_key_id?: string; unsigned?: boolean }): Promise<{ enote: ENote; txn: MersTransaction; ack: ERegistryAck; event: DomainEvent; on_time: boolean | null }> {
  if (!e.tamper_sealed_at || !e.tamper_seal_hash) throw new LocationGateClosed("no tamper seal — nothing to register");
  if (!e.authoritative_copy_validated_at) throw new LocationGateClosed(enoteLocationGate({ tamper_seal_hash: e.tamper_seal_hash, evault_copy_hash: null }).reason ?? "Authoritative Copy not validated");
  const body = { min: e.min, controller_org_id: e.controller_org_id, location_org_id: e.location_org_id, delegatee_org_id: e.delegatee_org_id, servicing_agent_org_id: e.servicing_agent_org_id, tamper_seal_hash: e.tamper_seal_hash, smart_doc_version: e.smart_doc_version };
  const signature = i.unsigned ? null : signRequest(body, i.signing_key_id); const ack = await registry.register({ ...body, signature }, i.at);
  const txn: MersTransaction = { id: ack.txn_id, application_id: c.application_id, min: e.min, txn_type: "eregistry_registration", request_signed_hash: signature ?? "", submitted_at: i.at, ack_at: ack.ack_at, result: ack.accepted ? "accepted" : "rejected", error_codes: ack.error_codes, channel: "xml" };
  const due: RegistrationDue | null = e.registration_due_at && e.registration_anchor_date ? { anchor_date: e.registration_anchor_date, due_date: localDate(e.registration_due_at, "America/New_York"), due_at: e.registration_due_at, target_at: toIso(Date.parse(e.tamper_sealed_at) + 2 * 3_600_000) } : null;
  if (!ack.accepted) {
    const event = events.append({ type: "enote.registration.rejected", applicationId: c.application_id, actor: { kind: "external", id: "mers_eregistry" }, occurredAt: ack.ack_at, payload: { application_id: c.application_id, closing_id: c.closing_id, enote_id: e.enote_id, min: e.min, txn_id: ack.txn_id, error_codes: ack.error_codes, registration_due_at: e.registration_due_at, retry: "fix and resubmit within the 1-BD window" } });
    return { enote: { ...e, eregistry_registration_txn_id: ack.txn_id, registration_status: "rejected" }, txn, ack, event, on_time: null };
  }
  const on_time = due ? registrationOnTime(ack.ack_at, due) : null;
  const enote: ENote = { ...e, eregistry_registration_txn_id: ack.txn_id, registration_status: "registered", registered_at: ack.ack_at, status: "registered" };
  const event = events.append({ type: "enote.registered", applicationId: c.application_id, actor: { kind: "external", id: "mers_eregistry" }, occurredAt: ack.ack_at, payload: { application_id: c.application_id, closing_id: c.closing_id, enote_id: e.enote_id, min: e.min, txn_id: ack.txn_id, registered_at: ack.ack_at, controller: "partner", location: enote.location === "SM" ? "sm_evault" : "vendor_evault", delegatee: "sm", servicing_agent: "sm", controller_org_id: e.controller_org_id, location_org_id: e.location_org_id, delegatee_org_id: e.delegatee_org_id, registration_due_at: e.registration_due_at, on_time, late: on_time === false, source: "origination" } });
  return { enote, txn, ack, event, on_time };
}
/** Change Data naming SM's Org ID as Secured Party before any warehouse advance → `enote.secured_party.set` (satisfies SM_O72_SECURED_PARTY_BEFORE_ADVANCE_GATE). */
export async function setSecuredParty(events: EventStore, registry: ERegistryPort26, c: Closing, e: ENote, i: { at: string; secured_party_org_id?: string; signing_key_id?: string }): Promise<{ enote: ENote; txn: MersTransaction; ack: ERegistryAck; event: DomainEvent | null }> {
  if (e.registration_status !== "registered") throw new RangeError(`Change Data (Secured Party) needs a registered eNote (status ${e.registration_status})`);
  const sp = i.secured_party_org_id ?? SM_ORG_ID; const signature = signRequest({ min: e.min, kind: "change_data_secured_party", secured_party_org_id: sp }, i.signing_key_id); const ack = await registry.changeDataSecuredParty(e.min, sp, signature, i.at);
  const txn: MersTransaction = { id: ack.txn_id, application_id: c.application_id, min: e.min, txn_type: "eregistry_change_data_secured_party", request_signed_hash: signature, submitted_at: i.at, ack_at: ack.ack_at, result: ack.accepted ? "accepted" : "rejected", error_codes: ack.error_codes, channel: "xml" };
  if (!ack.accepted) return { enote: e, txn, ack, event: null };
  return { enote: { ...e, secured_party_org_id: sp, secured_party_set_at: ack.ack_at, status: "secured_party_set" }, txn, ack, event: events.append({ type: "enote.secured_party.set", applicationId: c.application_id, actor: { kind: "external", id: "mers_eregistry" }, occurredAt: ack.ack_at, payload: { application_id: c.application_id, closing_id: c.closing_id, enote_id: e.enote_id, min: e.min, secured_party_org_id: sp, secured_party: "sm", set_at: ack.ack_at, txn_id: ack.txn_id } }) };
}
/** Registration Reversal (B8-8-02: replacement eNote after a data error; rescission / unwind — decision 26.2-Q6: after the Secured Party release) → `enote.registration.reversed`. */
export async function reverseRegistration(events: EventStore, registry: ERegistryPort26, c: Closing, e: ENote, i: { at: string; reason: "redraw_replacement" | "rescission" | "unwind" | "data_error"; replacement_registered: boolean; signing_key_id?: string }): Promise<{ enote: ENote; txns: MersTransaction[]; events: DomainEvent[] }> {
  if (e.registration_status !== "registered") throw new RangeError("a never-registered eNote needs no Registration Reversal — re-draw and re-sign (26.1)");
  if (i.reason === "redraw_replacement" && !i.replacement_registered) throw new RangeError("B8-8-02: the original is de-activated via Registration Reversal only after the replacement eNote registers");
  const out: DomainEvent[] = []; const txns: MersTransaction[] = []; let cur = e;
  if (cur.secured_party_org_id) { const sig = signRequest({ min: e.min, kind: "change_data_secured_party_release" }, i.signing_key_id); const rel = await registry.changeDataSecuredParty(e.min, "", sig, i.at); txns.push({ id: rel.txn_id, application_id: c.application_id, min: e.min, txn_type: "eregistry_change_data_secured_party_release", request_signed_hash: sig, submitted_at: i.at, ack_at: rel.ack_at, result: rel.accepted ? "accepted" : "rejected", error_codes: rel.error_codes, channel: "xml" }); cur = { ...cur, secured_party_org_id: null }; }
  const signature = signRequest({ min: e.min, kind: "registration_reversal", reason: i.reason }, i.signing_key_id); const ack = await registry.reverseRegistration(e.min, i.reason, signature, i.at);
  txns.push({ id: ack.txn_id, application_id: c.application_id, min: e.min, txn_type: "eregistry_registration_reversal", request_signed_hash: signature, submitted_at: i.at, ack_at: ack.ack_at, result: ack.accepted ? "accepted" : "rejected", error_codes: ack.error_codes, channel: "xml" });
  if (!ack.accepted) return { enote: cur, txns, events: out };
  out.push(events.append({ type: "enote.registration.reversed", applicationId: c.application_id, actor: { kind: "external", id: "mers_eregistry" }, occurredAt: ack.ack_at, payload: { application_id: c.application_id, closing_id: c.closing_id, enote_id: e.enote_id, min: e.min, reason: i.reason, txn_id: ack.txn_id, reversed_at: ack.ack_at } }));
  return { enote: { ...cur, registration_status: "reversed", status: "reversed" }, txns, events: out };
}
/** The tamper-sealed audit trail (hash-verified against the platform's) → `closing.audit_trail.received`; retained `fnma_enote_signing_life_plus_7y` — the video stays with the RON provider (SEL-2026-05) under `ron_recording_state_<n>y`. */
export function ingestAuditTrail(events: EventStore, c: Closing, s: SigningSession, i: { at: string; document_id: string; audit_trail_hash: string; platform_hash: string; recording_ref: string | null; journal_ref: string | null }): { closing: Closing; session: SigningSession; event: DomainEvent } {
  if (i.audit_trail_hash !== i.platform_hash) throw new RangeError("audit trail hash does not match the platform's — not accepted");
  if (s.mode === "ron" && !i.recording_ref) throw new RangeError("RON: the provider-held recording reference must accompany the audit trail");
  const session: SigningSession = { ...s, audit_trail_document_id: i.document_id, audit_trail_hash: i.audit_trail_hash, audit_trail_received_at: i.at, recording_ref: i.recording_ref, journal_ref: i.journal_ref, status: "audit_trail_received" };
  const event = events.append({ type: "closing.audit_trail.received", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, audit_trail_document_id: i.document_id, audit_trail_hash: i.audit_trail_hash, hash_verified: true, recording_ref: i.recording_ref, recording_custodian: s.recording_custodian, recording_retention_years: s.recording_retention_years, retention_class: RETENTION_ENOTE_SIGNING } });
  return { closing: { ...c, audit_trail_document_ids: [...c.audit_trail_document_ids, i.document_id], execution_status: c.note_form === "enote" ? "sealed" : c.execution_status }, session, event };
}
export function recordExecutionReview(events: EventStore, c: Closing, r: ExecutionReview, at: string): { closing: Closing; event: DomainEvent } {
  if (r.passed) return { closing: { ...c, execution_review_passed_at: at, execution_defects: r.defects, execution_status: "execution_reviewed" }, event: events.append({ type: "closing.execution_review.passed", applicationId: c.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: c.application_id, closing_id: c.closing_id, soft_defects: r.defects.map((d) => d.code), name_affidavits: r.name_affidavits } }) };
  return { closing: { ...c, execution_defects: r.defects, execution_status: "session_failed" }, event: events.append({ type: "closing.execution_review.failed", applicationId: c.application_id, actor: CLOSER, occurredAt: at, payload: { application_id: c.application_id, closing_id: c.closing_id, defects: r.defects, funding_blocked: r.funding_blocked, redraw: r.redraw, escalate_to: "settlement_agent" } }) };
}
export function openRecording(c: Closing, i: { recording_id: string; closing_document_id: string; channel: "erecording" | "paper"; vendor: string | null; submitter_party_id: string; state: string; county: string; county_fips: string | null; anchor_date: PlainDate; pria_model?: Recording["pria_model"]; date_of_policy?: PlainDate | null }): Recording {
  return { recording_id: i.recording_id, closing_id: c.closing_id, application_id: c.application_id, closing_document_id: i.closing_document_id, channel: i.channel, vendor: i.vendor, submitter_party_id: i.submitter_party_id, state: i.state, county: i.county, county_fips: i.county_fips, package_ref: null, pria_model: i.pria_model ?? "model_2_image_index", submitted_at: null, accepted_at: null, rejected_at: null, rejection_reason: null, resubmitted_count: 0, paper_fallback_at: null, tracking_ref: null, county_receipt_at: null, recorded_at: null, instrument_number: null, book_page: null, recording_fee_cents: null, recorded_image_document_id: null, date_of_policy: i.date_of_policy ?? null, gap_days: null, status: "pending", anchor_date: i.anchor_date, due_date: erecordSubmitDue(i.anchor_date) };
}
/** eRecording package accepted for processing → `recording.submitted` (satisfies SM_O72_ERECORD_SUBMIT_1BD; a corrected resubmission also emits `recording.resubmission.accepted`). Never with a handwritten instrument change. */
export function submitERecording(events: EventStore, c: Closing, r: Recording, i: { at: string; package_ref: string; instrument_altered?: boolean; resubmission?: boolean }): { recording: Recording; events: DomainEvent[] } {
  if (i.instrument_altered) throw new RangeError("a recording is never submitted with a handwritten instrument change — re-draw (26.1)");
  const out: DomainEvent[] = []; const resubmission = !!i.resubmission || r.status === "rejected";
  const recording: Recording = { ...r, package_ref: i.package_ref, submitted_at: i.at, accepted_at: i.at, status: "accepted", resubmitted_count: resubmission ? r.resubmitted_count + 1 : r.resubmitted_count };
  out.push(events.append({ type: "recording.submitted", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, recording_id: r.recording_id, closing_document_id: r.closing_document_id, channel: r.channel, vendor: r.vendor, package_ref: i.package_ref, submitted_at: i.at, accepted: true, resubmission, due_date: r.due_date, county: r.county, state: r.state } }));
  if (resubmission) out.push(events.append({ type: "recording.resubmission.accepted", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, recording_id: r.recording_id, package_ref: i.package_ref, accepted_at: i.at, attempt: recording.resubmitted_count + 1 } }));
  return { recording, events: out };
}
export const REJECTION_CURES: Record<string, string> = { missing_cover_sheet: "add the county cover sheet and resubmit", margin: "reformat margins per county standard", illegible_image: "rescan at 300 dpi", missing_legal_description: "attach Exhibit A", fee_short: "correct the fee and resubmit", notary_defect: "re-notarize (settlement_agent)", county_outage: "paper fallback" };
export function handleRecordingReject(events: EventStore, c: Closing, r: Recording, i: { at: string; reason: string }): { recording: Recording; cure: string; cure_due: PlainDate; event: DomainEvent } {
  const rejected_on = localDate(i.at, c.time_zone); const cure_due = recordingRejectCureDue(rejected_on);
  const recording: Recording = { ...r, rejected_at: i.at, rejection_reason: i.reason, status: "rejected" };
  const event = events.append({ type: "recording.rejected", applicationId: c.application_id, actor: { kind: "external", id: r.vendor ?? "erecording" }, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, recording_id: r.recording_id, rejection_reason: i.reason, rejected_on, cure: REJECTION_CURES[i.reason] ?? "correct and resubmit", cure_due, escalate_to: "settlement_agent" } });
  return { recording, cure: REJECTION_CURES[i.reason] ?? "correct and resubmit", cure_due, event };
}
/** Unavailable county or uncured rejection → paper package by tracked courier → `recording.paper_fallback` (+ `recording.submitted{channel=paper}` for 26.4's SM_O74_RECORDED_SI_PAPER_90); county receipt → `recording.county_receipt.confirmed`. The paper fallback is never disabled. */
export function dispatchPaperRecording(events: EventStore, c: Closing, r: Recording, i: { at: string; tracking_ref: string; county_turnaround_days?: number }): { recording: Recording; expected_recording_date: PlainDate; due: PlainDate; events: DomainEvent[] } {
  const fallback_date = localDate(i.at, c.time_zone); const due = paperFallbackDue(fallback_date); const expected_recording_date = addDays(fallback_date, i.county_turnaround_days ?? 30);
  const recording: Recording = { ...r, channel: "paper", paper_fallback_at: i.at, tracking_ref: i.tracking_ref, submitted_at: i.at, status: "paper_fallback" };
  const out = [
    events.append({ type: "recording.paper_fallback", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, recording_id: r.recording_id, fallback_date, tracking_ref: i.tracking_ref, county_receipt_due: due, expected_recording_date, prior_rejection: r.rejection_reason } }),
    events.append({ type: "recording.submitted", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, recording_id: r.recording_id, closing_document_id: r.closing_document_id, channel: "paper", vendor: null, package_ref: i.tracking_ref, submitted_at: i.at, accepted: true, resubmission: false, due_date: r.due_date, county: r.county, state: r.state } }),
  ];
  return { recording, expected_recording_date, due, events: out };
}
export function confirmCountyReceipt(events: EventStore, c: Closing, r: Recording, i: { at: string; evidence_document_id: string | null }): { recording: Recording; event: DomainEvent } {
  return { recording: { ...r, county_receipt_at: i.at }, event: events.append({ type: "recording.county_receipt.confirmed", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, recording_id: r.recording_id, received_at: i.at, evidence_document_id: i.evidence_document_id } }) };
}
/** Recorded (instrument number, book/page, timestamp) → `recording.confirmed` with `gap_days` against the Date of Policy (26.4's trailing-document clocks key on it). */
export function confirmRecording(events: EventStore, c: Closing, r: Recording, i: { at: string; instrument_number: string; book_page: string | null; recording_fee_cents: bigint | null; recorded_image_document_id: string | null; date_of_policy?: PlainDate | null }): { recording: Recording; event: DomainEvent } {
  const dop = i.date_of_policy ?? r.date_of_policy; const gap_days = dop ? recordingGapDays(i.at, dop, c.time_zone) : null;
  const recording: Recording = { ...r, recorded_at: i.at, instrument_number: i.instrument_number, book_page: i.book_page, recording_fee_cents: i.recording_fee_cents, recorded_image_document_id: i.recorded_image_document_id, date_of_policy: dop ?? null, gap_days, status: "recorded" };
  return { recording, event: events.append({ type: "recording.confirmed", applicationId: c.application_id, actor: { kind: "external", id: r.vendor ?? "county_recorder" }, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, recording_id: r.recording_id, closing_document_id: r.closing_document_id, channel: r.channel, recorded_at: i.at, instrument_number: i.instrument_number, book_page: i.book_page, recording_fee_cents: i.recording_fee_cents, gap_days, covered_risk_14_applies: gap_days !== null && gap_days > 0, recorded_image_document_id: i.recorded_image_document_id } }) };
}
/** Paper note (wet or hybrid paper note): `custody_records` seeded `note_location=settlement_agent` at signing. */
export function seedCustodyRecord(events: EventStore, c: Closing, i: { at: string; custodian_party_id: string; settlement_agent_party_id?: string }): { custody: CustodyRecord; event: DomainEvent } {
  if (c.note_form !== "paper") throw new RangeError("no paper note exists for an eNote closing — nothing ships to the custodian");
  if (!c.consummation_on) throw new RangeError("the note is not yet signed");
  const holder = i.settlement_agent_party_id ?? c.settlement_agent_party_id;
  const custody: CustodyRecord = { application_id: c.application_id, closing_id: c.closing_id, note_form: "paper", note_location: "settlement_agent", custodian_party_id: i.custodian_party_id, chain: [{ holder_party_id: holder, holder_role: "settlement_agent", from_at: i.at, to_at: null, tracking_ref: null, evidence_document_id: null }], original_received_at: null, handoff_due: paperNoteHandoffDue(c.consummation_on) };
  return { custody, event: events.append({ type: "custody.record.seeded", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, note_form: "paper", note_location: "settlement_agent", custodian_party_id: i.custodian_party_id, handoff_due: custody.handoff_due } }) };
}
/** Courier pickup scan → `custody.paper_note.shipped{tracking_ref}` (satisfies SM_O72_PAPER_NOTE_HANDOFF_1BD; anchors 26.4's receipt timer); custodian receipt → `custody.paper_note.received`. */
export function trackPaperNote(events: EventStore, c: Closing, k: CustodyRecord, i: { at: string; op: "shipped" | "received"; tracking_ref: string; courier_party_id?: string; evidence_document_id?: string | null }): { custody: CustodyRecord; event: DomainEvent } {
  const closeLast = (chain: readonly CustodyLink[], at: string): CustodyLink[] => chain.map((l, n) => (n === chain.length - 1 && !l.to_at ? { ...l, to_at: at } : l));
  if (i.op === "shipped") {
    if (k.note_location !== "settlement_agent") throw new RangeError(`note is at ${k.note_location}, not with the settlement agent`);
    const chain = [...closeLast(k.chain, i.at), { holder_party_id: i.courier_party_id ?? "courier", holder_role: "courier" as const, from_at: i.at, to_at: null, tracking_ref: i.tracking_ref, evidence_document_id: i.evidence_document_id ?? null }];
    return { custody: { ...k, note_location: "courier", chain }, event: events.append({ type: "custody.paper_note.shipped", applicationId: c.application_id, actor: { kind: "external", id: c.settlement_agent_party_id, role: "settlement_agent" }, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, tracking_ref: i.tracking_ref, shipped_at: i.at, shipped_on: localDate(i.at, c.time_zone), from_party_id: c.settlement_agent_party_id, to_custodian_party_id: k.custodian_party_id, on_time: localDate(i.at, c.time_zone) <= k.handoff_due, note_form: "paper" } }) };
  }
  if (k.note_location !== "courier") throw new RangeError("the note has not shipped");
  const chain = [...closeLast(k.chain, i.at), { holder_party_id: k.custodian_party_id, holder_role: "warehouse_custodian" as const, from_at: i.at, to_at: null, tracking_ref: i.tracking_ref, evidence_document_id: i.evidence_document_id ?? null }];
  return { custody: { ...k, note_location: "warehouse_custodian", chain, original_received_at: i.at }, event: events.append({ type: "custody.paper_note.received", applicationId: c.application_id, actor: { kind: "external", id: k.custodian_party_id, role: "custodian" }, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, tracking_ref: i.tracking_ref, received_at: i.at, custodian_party_id: k.custodian_party_id, note_form: "paper" } }) };
}
export function failSession(events: EventStore, c: Closing, s: SigningSession, i: { at: string; reason: SessionFailure; proposal: readonly ClosingType[] }): { closing: Closing; session: SigningSession; event: DomainEvent } {
  return { closing: { ...c, execution_status: "session_failed" }, session: { ...s, status: i.reason === "signer_no_show" ? "abandoned" : "failed", failure_reason: i.reason, ended_at: i.at, reschedule_proposal: i.proposal }, event: events.append({ type: "closing.session.failed", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, session_id: s.session_id, reason: i.reason, reschedule_proposal: i.proposal } }) };
}
export function rescheduleClosing(events: EventStore, c: Closing, i: { at: string; scheduled_at: string; closing_type: ClosingType; reason: string }): { closing: Closing; event: DomainEvent } {
  const note_form: "enote" | "paper" = i.closing_type === "wet" ? "paper" : c.note_form;
  return { closing: { ...c, scheduled_at: i.scheduled_at, scheduled_note_date: localDate(i.scheduled_at, c.time_zone), closing_type: i.closing_type, note_form, enote_indicator: note_form === "enote", remote_notarization_indicator: i.closing_type === "ron", execution_status: i.closing_type === "wet" && c.closing_type !== "wet" ? "converted_to_paper_path" : "rescheduled", pre_session_checks_passed_at: null }, event: events.append({ type: "closing.rescheduled", applicationId: c.application_id, actor: CLOSER, occurredAt: i.at, payload: { application_id: c.application_id, closing_id: c.closing_id, scheduled_at: i.scheduled_at, closing_type: i.closing_type, reason: i.reason, re_evaluate: ["25.2 consummation date", "21.4 lock", "26.1 re-draw if the note date changed"] } }) };
}
/** Facts for the evaluators (evaluators-26-2.ts). */
export function closingGateFacts(c: Closing, s: SigningSession | null, e: ENote | null, consent: ClosingEsignConsent | null, eligibility: readonly EclosingEligibility[], ron: Partial<ClosingTypeInput> = {}): Record<string, unknown> {
  return { closing_type: c.closing_type, note_form: c.note_form, state: c.state, county_fips: c.county_fips, tx_50a6: c.tx_50a6, settlement_agent_party_id: c.settlement_agent_party_id, consent, eligibility, tamper_seal_hash: e?.tamper_seal_hash ?? null, evault_copy_hash: e?.authoritative_copy_validated_at ? e.tamper_seal_hash : null, secured_party_org_id: e?.secured_party_org_id ?? null, registration_status: e?.registration_status ?? null,
    audit_trail_received_at: s?.audit_trail_received_at ?? null, audit_trail_hash: s?.audit_trail_hash ?? null, recording_ref: s?.recording_ref ?? null, recording_custodian: s?.recording_custodian ?? null, ...ron };
}
