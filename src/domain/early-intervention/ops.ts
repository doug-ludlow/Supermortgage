/**
 * §11 operational rules above the calculators: borrower-initiated and
 * ongoing-loss-mitigation satisfaction, the discharge overlay, channel
 * selection (TCPA), SMS revocation, quiet hours across candidate time
 * zones, the Reg F 7-in-7 counter and post-conversation cooling-off, the
 * D2-2-02 cadence with holiday shift and pre-sale stop, promise follow-up,
 * the AI-voice flag fallback, boarding seeds, recording disclosure, EI
 * notice render/channel/solicitation/failover rules, QRPC third-party and
 * verification rules, AW reporting, FDCPA overlays, and the imminent-default
 * notice schedule, Colorado flow, SMDU outage and Chapter 13 substitution.
 */
import { type PlainDate, addDays, daysBetween, parts } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer, fannieEt, federal } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type Window, openWindow, applyContact, bspDueAfterQrpc, LIVE_DAYS, NOTICE_DAYS } from "./windows.ts";
import { promiseToPay, thirdPartyAuthorization, reasonCode } from "./qrpc.ts";
import { overshadows } from "./fdcpa.ts";
import { evaluate, solicitationGate, type Evaluation, type Result } from "./imminent-default.ts";

const MIN = 60_000;

// ---- 11.1 live contact ------------------------------------------------------

/** 11.1-T5 — a borrower-initiated verified conversation is live contact (comment 39(a)-2) and a Fannie Mae inbound contact. */
export function inboundLiveContact(windows: Window[], on: PlainDate): { satisfied: Window[]; basis: "borrower_initiated"; plan_record: { type: "contact.inbound.received"; direction: "inbound"; on: PlainDate } } {
  return { satisfied: applyContact(windows, on, "live", "borrower_initiated"), basis: "borrower_initiated", plan_record: { type: "contact.inbound.received", direction: "inbound", on } };
}

/** 11.1-T8 — after a discharge (a) never resumes; (b) re-arms only on a post-petition payment. */
export function dischargedWindow(dueDate: PlainDate, o: { payment_after_petition: boolean }): Window {
  const w = openWindow(dueDate, { principal_residence: true, bankruptcy: "discharged" });
  if (o.payment_after_petition) w.notice = "open";
  return w;
}

/** 11.1-T9 — windows maturing while §1024.41 ongoing contact is active are satisfied by it (comment 39(a)-6). */
export function applyOngoingLossmit(windows: Window[], activeFrom: PlainDate, activeTo: PlainDate): Window[] {
  const hit: Window[] = [];
  for (const w of windows) if (w.live === "open" && w.live_due_at >= activeFrom && w.live_due_at <= activeTo) { w.live = "satisfied_ongoing_lossmit"; w.live_basis = "lossmit.ongoing_contact"; hit.push(w); }
  return hit;
}

export interface ChannelInput { readonly line_type: "mobile" | "landline" | "voip" | "unknown"; readonly tcpa_voice_consent: boolean; readonly tcpa_sms_consent?: boolean; readonly written_consent?: boolean; readonly ai_voice_attempts_30d?: number; readonly human_only?: boolean; readonly source?: string; }
/** 11.1 rule 7 / T10 / T21 — channel matrix at dial time. */
export function selectChannel(i: ChannelInput): { ai_voice: boolean; sms: boolean; route: "ai_voice" | "human_manual_dial"; refused_by: string | null; task: "human_manual_dial" | null } {
  const human = (why: string | null) => ({ ai_voice: false, sms: i.tcpa_sms_consent === true, route: "human_manual_dial" as const, refused_by: why, task: "human_manual_dial" as const });
  if (i.human_only) return human("contact_preferences.human_only");
  if (i.source === "skip_trace") return human("skip-traced number: human dial until confirmed");
  if (i.line_type === "landline") {
    if (!i.written_consent && (i.ai_voice_attempts_30d ?? 0) >= 3) return human("TCPA_64_1200_A3_LANDLINE_AI_3IN30");
    return { ai_voice: true, sms: false, route: "ai_voice", refused_by: null, task: null };
  }
  if (!i.tcpa_voice_consent) return human("TCPA_64_1200_A1_CELL_CONSENT_GATE");
  return { ai_voice: true, sms: i.tcpa_sms_consent === true, route: "ai_voice", refused_by: null, task: null };
}

const REVOKE_WORDS = /^\s*(stop|quit|end|revoke|opt\s*out|cancel|unsubscribe)\b/i;
/** 11.1-T11 — per-se revocation keywords are honored at commit (≤1 minute), one confirmation text within 5 minutes, legal deadline 10 federal business days. */
export function smsRevocation(i: { received_at_ms: number; text: string; received_on: PlainDate }): { revoked: boolean; committed_by_ms: number; blocked: readonly string[]; confirmation_text: { count: 1; send_by_ms: number } | null; timer: { code: "TCPA_64_1200_A10_REVOCATION_HONOR_10BD"; status: "satisfied" | "open"; satisfied_at_ms: number | null; legal_due: PlainDate } } {
  const revoked = REVOKE_WORDS.test(i.text);
  return { revoked, committed_by_ms: i.received_at_ms + MIN, blocked: revoked ? ["ai_voice", "sms"] : [], confirmation_text: revoked ? { count: 1, send_by_ms: i.received_at_ms + 5 * MIN } : null,
    timer: { code: "TCPA_64_1200_A10_REVOCATION_HONOR_10BD", status: revoked ? "satisfied" : "open", satisfied_at_ms: revoked ? i.received_at_ms : null, legal_due: addBusinessDays(i.received_on, 10, federal) } };
}

/** 11.1 rule 8 / T12 — the permitted window is the intersection over every candidate time zone; policy voice (08:00, 20:30], SMS/email (08:00, 20:00]. */
export function quietHoursCheck(i: { dial_at_ms: number; time_zones: readonly string[]; mode: "voice" | "sms" | "email" }): { permitted: boolean; refused_for: readonly { tz: string; local: string }[]; window: string } {
  const end = i.mode === "voice" ? 20 * 60 + 30 : 20 * 60;
  const refused: { tz: string; local: string }[] = [];
  for (const tz of i.time_zones) { const w = wallClock(i.dial_at_ms, tz); const m = w.hour * 60 + w.minute; if (!(m > 8 * 60 && m <= end)) refused.push({ tz, local: `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}` }); }
  return { permitted: refused.length === 0, refused_for: refused, window: `after 08:00 through ${i.mode === "voice" ? "20:30" : "20:00"} local` };
}

export interface CallAttempt { readonly at_ms: number; readonly person: string; readonly outcome: string; readonly consent_callback?: boolean; }
const DAY = 86_400_000;
const counts = (a: CallAttempt) => a.outcome !== "busy_or_failed" && !a.consent_callback;
/** 11.1 rule 9 — counted calls to a person in the trailing 7 days as of `at_ms` (inclusive). */
export function countedCalls(attempts: readonly CallAttempt[], person: string, atMs: number): number {
  return attempts.filter((a) => a.person === person && counts(a) && a.at_ms <= atMs && a.at_ms > atMs - 7 * DAY).length;
}
/** 11.1-T13 — the running count for `person` after each attempt in order. */
export function regfRunningCounts(attempts: readonly CallAttempt[], person: string): number[] { return attempts.map((a) => countedCalls(attempts, person, a.at_ms)); }
/** Dial check: an 8th counted call in 7 days is refused; a consent-based callback within 7 days of the consent is excluded. */
export function regfDialCheck(attempts: readonly CallAttempt[], person: string, atMs: number, o: { callback_consent_at_ms?: number | null } = {}): { allowed: boolean; count_after: number; refused_by: "REGF_1006_14_CALL_CAP_7IN7" | null; regf_exclusion: "consent_within_7d" | null } {
  const consent = o.callback_consent_at_ms !== undefined && o.callback_consent_at_ms !== null && atMs - o.callback_consent_at_ms <= 7 * DAY && atMs >= o.callback_consent_at_ms;
  if (consent) return { allowed: true, count_after: countedCalls(attempts, person, atMs), refused_by: null, regf_exclusion: "consent_within_7d" };
  const after = countedCalls(attempts, person, atMs) + 1;
  return after > 7 ? { allowed: false, count_after: after, refused_by: "REGF_1006_14_CALL_CAP_7IN7", regf_exclusion: null } : { allowed: true, count_after: after, refused_by: null, regf_exclusion: null };
}
/** 11.1-T14 — no call within seven days after a conversation (conversation day = day 1) unless the consumer asked for a callback. */
export function postConversationGate(conversationOn: PlainDate, requestedOn: PlainDate, o: { callback_consent?: boolean } = {}): { allowed: boolean; refused_by: "REGF_1006_14_POST_CONVERSATION_7" | null; permitted_from: PlainDate } {
  const from = addDays(conversationOn, 7);
  if (o.callback_consent) return { allowed: true, refused_by: null, permitted_from: from };
  return requestedOn >= from ? { allowed: true, refused_by: null, permitted_from: from } : { allowed: false, refused_by: "REGF_1006_14_POST_CONVERSATION_7", permitted_from: from };
}

/** 11.1-T15 — `FNMA_D2202_OUTBOUND_EVERY_7`: last attempt + 7, shifted to the next day the servicer is open (A4-2.1-04). */
export function nextOutboundDue(lastAttemptOn: PlainDate, cal: Calendar = servicer): { nominal: PlainDate; due: PlainDate; shifted: boolean } {
  const nominal = addDays(lastAttemptOn, 7); let d = nominal;
  while (!cal.isBusinessDay(d)) d = addDays(d, 1);
  return { nominal, due: d, shifted: d !== nominal };
}

/** 11.1-T16 — outbound attempts stop 60 (judicial) / 30 (non-judicial) days before the sale unless the jurisdiction requires contact through sale. */
export function preSaleStop(i: { sale_date: PlainDate; judicial: boolean; contact_required_through_sale?: boolean }): { stop_from: PlainDate; gate: "FNMA_D2202_CEASE_PRE_SALE_60J" | "FNMA_D2202_CEASE_PRE_SALE_30NJ"; attemptAllowed: (on: PlainDate) => { allowed: boolean; refused_by: string | null; logged_basis: string | null } } {
  const stop = addDays(i.sale_date, i.judicial ? -60 : -30); const gate = i.judicial ? "FNMA_D2202_CEASE_PRE_SALE_60J" as const : "FNMA_D2202_CEASE_PRE_SALE_30NJ" as const;
  return { stop_from: stop, gate, attemptAllowed: (on) => on < stop ? { allowed: true, refused_by: null, logged_basis: null } : i.contact_required_through_sale ? { allowed: true, refused_by: null, logged_basis: "jurisdiction_rules.contact_required_through_sale" } : { allowed: false, refused_by: gate, logged_basis: null } };
}

/** 11.1-T17 — a cadence-ceasing promise; the 00:05 check the day after the promise date breaks it when no covering payment exists. */
export function promiseFollowUp(i: { promised_cents: Cents; due_on: PlainDate; recorded_on: PlainDate; total_delinquent_cents: Cents; covering_payment_cents: Cents | null; check_on: PlainDate }): { plan_after_promise: string; check: { event: "promise_to_pay.broken" | "promise_to_pay.kept" | null; plan: string; resumed_on: PlainDate | null } } {
  const p = promiseToPay(i.promised_cents, i.due_on, i.recorded_on, i.total_delinquent_cents);
  if (i.check_on <= i.due_on) return { plan_after_promise: p.plan, check: { event: null, plan: p.plan, resumed_on: null } };
  const kept = i.covering_payment_cents !== null && i.covering_payment_cents >= i.promised_cents;
  return { plan_after_promise: p.plan, check: kept ? { event: "promise_to_pay.kept", plan: "ceased{resolved}", resumed_on: null } : { event: "promise_to_pay.broken", plan: "active", resumed_on: i.check_on } };
}

/** 11.1-T18 — with the flag off the AI conversation is an effort, not live contact; the human-verified join adds a second row that is. */
export function aiQrpcWithFlagOff(i: { due_date: PlainDate; ai_conversation_on: PlainDate; human_join: boolean }): { contacts: readonly { mode: string; live_contact: boolean; live_contact_basis: string }[]; fallback_timer: { code: "SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD"; due: PlainDate }; window_live: "open" | "satisfied_live" } {
  const w = openWindow(i.due_date, { principal_residence: true });
  const rows = [{ mode: "ai_voice", live_contact: false, live_contact_basis: "ai_voice_flag_off" }];
  if (i.human_join) { rows.push({ mode: "human_voice", live_contact: true, live_contact_basis: "human_voice" }); applyContact([w], i.ai_conversation_on, "live", "human_voice"); }
  return { contacts: rows, fallback_timer: { code: "SM_LIVE_CONTACT_HUMAN_FALLBACK_5CD", due: addDays(w.live_due_at, -5) }, window_live: w.live === "satisfied_live" ? "satisfied_live" : "open" };
}

const HUMAN_TRIGGERS = /\b(representative|person|human|supervisor|agent)\b/i;
/** 11.1-T19 — a request for a person starts a warm transfer within 10 s; the human leg decides live-contact status. */
export function humanTransferRequest(i: { utterance: string; requested_at_ms: number }): { warm_transfer: boolean; start_by_ms: number | null; human_transfer_requested: boolean; live_contact_determined_by: "human_leg" | "ai_leg" } {
  const t = HUMAN_TRIGGERS.test(i.utterance);
  return { warm_transfer: t, start_by_ms: t ? i.requested_at_ms + 10_000 : null, human_transfer_requested: t, live_contact_determined_by: t ? "human_leg" : "ai_leg" };
}

/** 11.1-T20 — boarding: a human call task for day 1–3. */
export function boardingCallTaskDue(boardedOn: PlainDate): PlainDate { return addDays(boardedOn, 2); }

/** 11.1-T22 — non-principal residence: Reg X windows `not_applicable`; Fannie Mae day-36 start (rolled to an open day) and 7-day cadence still run. */
export function regxApplicability(i: { principal_residence: boolean; due_date: PlainDate; cal?: Calendar }): { regx_window: "not_applicable" | "applies"; fnma: { start: { code: "FNMA_D2202_OUTBOUND_START_36"; due: PlainDate }; cadence_every_days: 7 } } {
  const cal = i.cal ?? servicer; let d = addDays(i.due_date, LIVE_DAYS); while (!cal.isBusinessDay(d)) d = addDays(d, 1);
  return { regx_window: i.principal_residence ? "applies" : "not_applicable", fnma: { start: { code: "FNMA_D2202_OUTBOUND_START_36", due: d }, cadence_every_days: 7 } };
}

/** 11.1-T23 — two-party states: the recording disclosure must appear in the first 15 seconds of the transcript. */
export function recordingDisclosureCheck(i: { two_party_state: boolean; transcript: readonly { t_s: number; text: string }[] }): { required: boolean; present_within_15s: boolean; compliant: boolean } {
  const present = i.transcript.some((s) => s.t_s <= 15 && /record(ed|ing)/i.test(s.text));
  return { required: i.two_party_state, present_within_15s: present, compliant: !i.two_party_state || present };
}

/** 11.1-T24 — reversal after a `cancelled_paid`: 11.2 issues the notice by the unchanged due date unless one was already sent. */
export function noticeActionAfterReversal(w: Window, noticeSent: boolean): { notice_due_at: PlainDate; action: "none_already_sent" | "issue_by_due" } {
  return { notice_due_at: w.notice_due_at, action: noticeSent ? "none_already_sent" : "issue_by_due" };
}

// ---- 11.2 written early intervention notice ----------------------------------

/** 11.2-T9 — the §1024.40 assigned-contact block is a send precondition; auto-assignment runs and the render is retried. */
export function eiRenderGate(i: { assigned_contact_block_present: boolean; exclusive_address_present: boolean }): { send_allowed: boolean; action: "auto_assign_4_3" | null; failing: readonly string[] } {
  const failing = [...(i.assigned_contact_block_present ? [] : ["continuity_block_present"]), ...(i.exclusive_address_present ? [] : ["exclusive_noe_rfi_address"])];
  return { send_allowed: failing.length === 0, action: i.assigned_contact_block_present ? null : "auto_assign_4_3", failing };
}

/** 11.2-T10 / rule 11 — electronic only with `esign` consent for class `regx_ei`; a bounce generates mail the same day. */
export function eiChannel(i: { esign_consent_regx_ei: boolean; bounced_on?: PlainDate | null }): { channel: "electronic" | "mail"; mail_generated_on: PlainDate | null } {
  if (!i.esign_consent_regx_ei) return { channel: "mail", mail_generated_on: null };
  if (i.bounced_on) return { channel: "mail", mail_generated_on: i.bounced_on };
  return { channel: "electronic", mail_generated_on: null };
}

export interface SolicitationPackage { readonly kind: "bsp" | "form745_letter"; readonly trigger: "day45_no_qrpc" | "qrpc_no_resolution"; readonly contents: readonly string[]; readonly includes_4506c: boolean; readonly same_envelope_with_ei: boolean; readonly hope_hotline_present: true; readonly fnma_action_event: "Borrower Solicitation Package"; }
const BSP_CONTENTS = ["form_745", "form_710", "document_checklist", "return_envelope", "portal_upload_link"] as const;
/** 11.2-T11 / rule 9 — day 45 with no QRPC and no resolution → the full BSP in the EI envelope. */
export function day45Solicitation(i: { qrpc_established: boolean; resolved: boolean; regx_days: number; principal_residence?: boolean }): SolicitationPackage | null {
  if (i.qrpc_established || i.resolved || i.regx_days < 45) return null;
  return { kind: "bsp", trigger: "day45_no_qrpc", contents: BSP_CONTENTS, includes_4506c: false, same_envelope_with_ei: i.principal_residence !== false, hope_hotline_present: true, fnma_action_event: "Borrower Solicitation Package" };
}
/** 11.2-T12 — QRPC without resolution: BSP within 3 servicer BD unless one was already sent. */
export function bspAfterQrpc(i: { qrpc_on: PlainDate; prior_bsp_id: string | null }): { send: boolean; due: PlainDate | null; decision_cites: string | null } {
  return i.prior_bsp_id ? { send: false, due: null, decision_cites: i.prior_bsp_id } : { send: true, due: bspDueAfterQrpc(i.qrpc_on), decision_cites: null };
}
/** 11.2-T13 — investment property: no Reg X notice leg; Fannie Mae day-45 solicitation still runs. */
export function noticeLegApplicability(i: { principal_residence: boolean; due_date: PlainDate }): { regx_notice_leg: "not_applicable" | "open"; fnma_solicitation_45: { code: "FNMA_D2204_SOLICITATION_45"; due: PlainDate } } {
  return { regx_notice_leg: i.principal_residence ? "open" : "not_applicable", fnma_solicitation_45: { code: "FNMA_D2204_SOLICITATION_45", due: addDays(i.due_date, NOTICE_DAYS) } };
}
/** 11.2-T14 / 11.4-T6 — DC-loan EI notice in the validation period: §1006.18(e) fragment required, no overshadowing. */
export function dcLoanEiNotice(i: { text: string; validation_end: PlainDate; ref_date: PlainDate; in_validation_period: boolean }): { fragment_present: boolean; overshadow_issues: readonly string[]; accepted: boolean } {
  const frag = /communication is from a debt collector/i.test(i.text);
  const issues = i.in_validation_period ? overshadows(i.text, i.validation_end, i.ref_date) : [];
  return { fragment_present: frag, overshadow_issues: issues, accepted: frag && issues.length === 0 };
}
/** 11.2-T15 — print vendor failover: the secondary mails next day; both failing past the deadline is a breach with an officer escalation. */
export function printFailover(i: { primary_failed_on: PlainDate; secondary_available: boolean; notice_due: PlainDate; recovered_on?: PlainDate | null }): { mailed_on: PlainDate; vendor: "secondary" | "primary_recovered"; timer_satisfied: boolean; breached: boolean; escalation: { role: "officer" } | null } {
  if (i.secondary_available) { const on = addDays(i.primary_failed_on, 1); return { mailed_on: on, vendor: "secondary", timer_satisfied: on <= i.notice_due, breached: on > i.notice_due, escalation: on > i.notice_due ? { role: "officer" } : null }; }
  const on = i.recovered_on ?? addDays(i.notice_due, 1);
  return { mailed_on: on, vendor: "primary_recovered", timer_satisfied: on <= i.notice_due, breached: on > i.notice_due, escalation: on > i.notice_due ? { role: "officer" } : null };
}

// ---- 11.3 QRPC ----------------------------------------------------------------

/** 11.3-T5 — an unauthorized third party gets no account details, the authorization form, and no QRPC. */
export function thirdPartyCall(i: { claimed_relation: string; authorization_valid: boolean }): { disclose_account_details: boolean; offer: "FRM_SM_THIRD_PARTY_AUTH" | null; qrpc_recorded_allowed: boolean; outcome: "answered_unverified_third_party" | "authorized_third_party" } {
  return i.authorization_valid ? { disclose_account_details: true, offer: null, qrpc_recorded_allowed: true, outcome: "authorized_third_party" } : { disclose_account_details: false, offer: "FRM_SM_THIRD_PARTY_AUTH", qrpc_recorded_allowed: false, outcome: "answered_unverified_third_party" };
}
/** 11.3-T6 — a verified borrower's recorded oral authorization on a three-way call: `discuss_only` for 90 days. */
export function threeWayAuthorization(i: { borrower_verified: boolean; on: PlainDate; party: string }): { scope: "discuss_only"; expires_on: PlainDate; party_role: "trusted_advisor"; may_complete_qrpc: true } | null {
  if (!i.borrower_verified) return null;
  const a = thirdPartyAuthorization("oral_three_way", i.on);
  return { scope: "discuss_only", expires_on: a.expires_on!, party_role: "trusted_advisor", may_complete_qrpc: true };
}
export type QrpcStatus = "conversation_only" | "qrpc_complete" | "pending_human_verification" | "qrpc_verified" | "qrpc_rejected";
/** 11.3-T7 — with the flag off the AI record waits for human verification; only `qrpc_verified` emits the event. */
export function qrpcRecordStatus(i: { complete: boolean; ai_voice_counts: boolean; achieved_on: PlainDate; cal?: Calendar }): { status: QrpcStatus; timer: { code: "SM_QRPC_HUMAN_VERIFY_1BD"; due: PlainDate } | null; events: readonly string[] } {
  if (!i.complete) return { status: "conversation_only", timer: null, events: [] };
  if (i.ai_voice_counts) return { status: "qrpc_complete", timer: null, events: ["contact.qrpc.established"] };
  return { status: "pending_human_verification", timer: { code: "SM_QRPC_HUMAN_VERIFY_1BD", due: addBusinessDays(i.achieved_on, 1, i.cal ?? servicer) }, events: [] };
}
export function humanVerify(outcome: "qrpc_verified" | "qrpc_rejected"): { status: QrpcStatus; events: readonly string[]; task: "human_call" | null } {
  return outcome === "qrpc_verified" ? { status: "qrpc_verified", events: ["contact.qrpc.established"], task: null } : { status: "qrpc_rejected", events: [], task: "human_call" };
}
/** 11.3-T8 — legacy AW: reported once, in the first file after the QRPC, effective the QRPC date, with the reason code. */
export function awReporting(i: { qrpc_on: PlainDate; reason: string; report_months: readonly string[] }): readonly { month: string; status: "AW" | null; effective: string | null; reason_code: string | null }[] {
  const { y, m, d } = parts(i.qrpc_on); const eff = `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
  const qm = `${y}-${String(m).padStart(2, "0")}`; let reported = false;
  return i.report_months.map((month) => { if (!reported && month > qm) { reported = true; return { month, status: "AW", effective: eff, reason_code: reasonCode(i.reason) }; } return { month, status: null, effective: null, reason_code: null }; });
}
/** 11.3-T10 — modification terms are licensed activity in some states: the AI declines to quote and warm-transfers. */
export function licensedNegotiationGate(i: { question: string; mlo_licensing_for_lossmit: boolean; licensed_specialist_on_call?: boolean }): { asks_terms: boolean; decline_quote: boolean; warm_transfer: "licensed_specialist" | null; response: string } {
  const asks = /\b(rate|payment|terms|interest)\b/i.test(i.question);
  if (asks && i.mlo_licensing_for_lossmit && !i.licensed_specialist_on_call) return { asks_terms: true, decline_quote: true, warm_transfer: "licensed_specialist", response: "I can't quote modification terms. A licensed specialist can walk you through what a modification could look like; I'll connect you now." };
  return { asks_terms: asks, decline_quote: false, warm_transfer: null, response: "Let me explain the options that may be available and how to apply." };
}
/** 11.3-T11 — disaster reason types are mutually exclusive with Property Problem on the event rail. */
export function disasterReasonType(i: { fema_ia_county: boolean }): { reason_type: string; fnma_reason_code: string; property_problem_set: false } {
  return { reason_type: i.fema_ia_county ? "Disaster Impact – FEMA-declared IA area" : "Casualty Loss", fnma_reason_code: reasonCode("disaster_casualty"), property_problem_set: false };
}
/** 11.3-T13 — every extracted element must cite a transcript evidence span. */
export function validateExtraction(elements: Record<string, { value: unknown; evidence_span: string | null }>): { valid: boolean; missing_evidence: readonly string[]; record_status: "qrpc_candidate" | "conversation_only" } {
  const missing = Object.entries(elements).filter(([, e]) => e.value !== null && e.value !== undefined && !e.evidence_span).map(([k]) => k);
  return { valid: missing.length === 0, missing_evidence: missing, record_status: missing.length === 0 ? "qrpc_candidate" : "conversation_only" };
}
/** 11.3-T14 — a represented Chapter 13 debtor: verify, confine to counsel-permitted information, no QRPC without counsel. */
export function representedDebtorCall(i: { chapter: 7 | 13; represented_by_counsel: boolean; counsel_involved: boolean }): { verify: true; discussion_scope: "counsel_permitted_information" | "full"; qrpc_recorded: boolean; route: "counsel" | "borrower" } {
  if (!i.represented_by_counsel) return { verify: true, discussion_scope: "full", qrpc_recorded: true, route: "borrower" };
  return { verify: true, discussion_scope: "counsel_permitted_information", qrpc_recorded: i.counsel_involved, route: "counsel" };
}

// ---- 11.4 FDCPA ---------------------------------------------------------------

/** 11.4-T5 — a written dispute in the validation period ceases collection until verification mails; statements continue. */
export function disputeLifecycle(i: { received_on: PlainDate; verification_mailed_on: PlainDate | null }): { collection_ceased_at: PlainDate; collection_resumed_at: PlainDate | null; statements_allowed: true; callAllowed: (on: PlainDate) => { allowed: boolean; reason: string | null } } {
  return { collection_ceased_at: i.received_on, collection_resumed_at: i.verification_mailed_on, statements_allowed: true,
    callAllowed: (on) => on >= i.received_on && (i.verification_mailed_on === null || on < i.verification_mailed_on) ? { allowed: false, reason: "collection ceased pending verification (§1006.38)" } : { allowed: true, reason: null } };
}
/** 11.4-T7 — written cease on a DC loan. */
export function writtenCease(i: { received_on: PlainDate; ack_sent_before: boolean }): { plan: "suspended{cease_request}"; ei_variant: "fdcpa"; cycle_days: 190; send_ack: boolean; borrower_initiated_lossmit_call: "answered_fully"; gate: "REGF_1006_6C_CEASE_GATE" } {
  return { plan: "suspended{cease_request}", ei_variant: "fdcpa", cycle_days: 190, send_ack: !i.ack_sent_before, borrower_initiated_lossmit_call: "answered_fully", gate: "REGF_1006_6C_CEASE_GATE" };
}
/** 11.4-T8 — oral "stop calling": calls/SMS/email stop within a minute, mail continues, EI variant unchanged, written option explained. */
export function oralCease(i: { at_ms: number }): { stopped: readonly string[]; stopped_by_ms: number; mail_continues: true; ei_variant: "standard"; cease_scope: "oral_calls_only"; transcript_explanation: string } {
  return { stopped: ["voice", "sms", "email"], stopped_by_ms: i.at_ms + MIN, mail_continues: true, ei_variant: "standard", cease_scope: "oral_calls_only", transcript_explanation: "We will stop calling, texting and emailing you now. If you also want us to stop sending collection mail, you can tell us that in writing and we will stop all collection contact." };
}
/** 11.4-T9 — attorney representation: communications to counsel; direct contact re-opens after 30 days of documented non-response. */
export function attorneyGate(i: { designated_on: PlainDate; counsel_contacted_on: PlainDate; counsel_responded: boolean; today: PlainDate }): { direct_allowed: boolean; route: "counsel" | "borrower"; reopen_on: PlainDate; decision_record: { action: string; basis: string } | null } {
  const reopen = addDays(i.counsel_contacted_on, 30);
  if (!i.counsel_responded && i.today >= reopen) return { direct_allowed: true, route: "borrower", reopen_on: reopen, decision_record: { action: "direct_contact_reopened", basis: `§1006.6(b)(2): attorney failed to respond for 30 days after ${i.counsel_contacted_on}` } };
  return { direct_allowed: false, route: "counsel", reopen_on: reopen, decision_record: null };
}
/** 11.4-T10 — the §1006.30(a) furnishing gate opens on a conversation, or 14 days after mailing with no undeliverability notice. */
export function furnishingGate(i: { mailed_on: PlainDate; undeliverable_on?: PlainDate | null; conversation_on?: PlainDate | null }): { furnishing_gate_open_at: PlainDate | null; basis: string } {
  const byMail = addDays(i.mailed_on, 14);
  const mailOpen = i.undeliverable_on && i.undeliverable_on <= byMail ? null : byMail;
  const conv = i.conversation_on ?? null;
  if (conv && (mailOpen === null || conv < mailOpen)) return { furnishing_gate_open_at: conv, basis: "conversation with the consumer" };
  return mailOpen ? { furnishing_gate_open_at: mailOpen, basis: "14 days after mailing with no undeliverability notice" } : { furnishing_gate_open_at: null, basis: "undeliverable notice received; gate closed" };
}
/** 11.4-T11 — SMS to a DC-loan consumer needs an RND check ≤60 days old or an inbound text ≤60 days. */
export function smsRndGate(i: { days_since_rnd_check: number | null; days_since_consumer_texted: number | null }): { allowed: boolean; refused_by: "REGF_1006_6D5_SMS_RND_60" | null } {
  const ok = (i.days_since_rnd_check !== null && i.days_since_rnd_check <= 60) || (i.days_since_consumer_texted !== null && i.days_since_consumer_texted <= 60);
  return { allowed: ok, refused_by: ok ? null : "REGF_1006_6D5_SMS_RND_60" };
}
const DEBT_WORDS = /\b(debt|collect|past due|delinquen|mortgage payment|amount owed|overdue)\b/i;
/** 11.4-T12 — DC-loan email: opt-out statement present, no debt reference in the subject line. */
export function dcEmailCheck(i: { subject: string; body: string }): { opt_out_present: boolean; subject_clean: boolean; compliant: boolean } {
  const opt = /\b(opt out|unsubscribe|stop receiving)\b/i.test(i.body); const subj = !DEBT_WORDS.test(i.subject);
  return { opt_out_present: opt, subject_clean: subj, compliant: opt && subj };
}
/** 11.4-T13 — voicemail on a DC loan: limited-content message fields only. */
export function voicemailCheck(i: { text: string; business_name: string; agent_name: string; phone: string }): { allowed: boolean; template: "limited_content"; violations: readonly string[] } {
  const v: string[] = [];
  if (DEBT_WORDS.test(i.text)) v.push("mentions the debt");
  if (!i.text.includes(i.business_name)) v.push("business name missing");
  if (!/\b(call|reply|contact) (us|me) back\b|please (call|return)/i.test(i.text)) v.push("request to reply missing");
  if (!i.text.includes(i.agent_name)) v.push("agent name missing");
  if (!i.text.includes(i.phone)) v.push("telephone number missing");
  return { allowed: v.length === 0, template: "limited_content", violations: v };
}
/** 11.4-T14 — deceased consumer reported by a third party. */
export function deceasedReport(i: { reporter_relation: string }): { disclose_debt: false; may_request_location_info: true; wait_for: "executor_or_successor"; route: "4.4"; reporter_is_consumer: boolean } {
  return { disclose_debt: false, may_request_location_info: true, wait_for: "executor_or_successor", route: "4.4", reporter_is_consumer: ["spouse", "executor", "administrator", "confirmed_successor"].includes(i.reporter_relation) };
}
/** 11.4-T15 — AI personas use a registered assumed name consistently (§1006.18(f)); DC-loan transcripts carry the disclosure. */
export function assumedNameCheck(i: { persona: string; registry: readonly string[]; transcript: string }): { registered: boolean; identity_present: boolean; disclosure_present: boolean; compliant: boolean } {
  const reg = i.registry.includes(i.persona); const id = i.transcript.includes(`${i.persona} with Supermortgage`); const disc = /this communication is from a debt collector/i.test(i.transcript);
  return { registered: reg, identity_present: id, disclosure_present: disc, compliant: reg && id && disc };
}
/** 11.4-T16 — state overlays apply through the Contact Engine even where Reg F does not. */
export function stateOverlay(i: { state: string; debt_collector: boolean }): { regf_applicable: boolean; overlays: readonly string[]; contact_engine: { quiet_hours: boolean; harassment_rules: boolean; call_cap_7d: number | null } } {
  const ov = i.state === "CA" ? ["rosenthal_ca"] : i.state === "MA" ? ["ma_940_cmr_7"] : [];
  return { regf_applicable: i.debt_collector, overlays: ov, contact_engine: { quiet_hours: i.debt_collector || ov.length > 0, harassment_rules: i.debt_collector || ov.includes("rosenthal_ca"), call_cap_7d: ov.includes("ma_940_cmr_7") ? 2 : i.debt_collector ? 7 : 5 } };
}

// ---- 11.5 imminent default ------------------------------------------------------

/** 11.5-T7 — Form 182 (decline + 30) combined with the Reg B notice (complete BRP + 30): the earlier date governs; no issue without a reviewer. */
export function adverseNoticeSchedule(i: { declined_on: PlainDate; brp_complete_on: PlainDate; current_at_evaluation: boolean; counteroffer_accepted: boolean; reviewer_id: string | null }): { form182_due: PlainDate | null; regb_due: PlainDate; combined_due: PlainDate; can_issue: boolean; blocked_by: string | null } {
  const f = i.current_at_evaluation && !i.counteroffer_accepted ? addDays(i.declined_on, 30) : null; const r = addDays(i.brp_complete_on, 30);
  return { form182_due: f, regb_due: r, combined_due: f !== null && f < r ? f : r, can_issue: i.reviewer_id !== null, blocked_by: i.reviewer_id === null ? "no adverse notice without reviewer_id" : null };
}
/** 11.5-T8 — a counteroffer accepted within the 14-day window cancels the Form 182 timer. */
export function counterofferAcceptance(i: { offer_sent_on: PlainDate; accepted_on: PlainDate }): { within_window: boolean; form182_timer: "cancelled" | "running" } {
  const w = daysBetween(i.offer_sent_on, i.accepted_on) <= 14 && i.accepted_on >= i.offer_sent_on;
  return { within_window: w, form182_timer: w ? "cancelled" : "running" };
}
/** 11.5-T9 — Form 745/BSP below 30 days delinquent only on the borrower's own request, which is logged as the basis. */
export function bspSendCheck(i: { regx_days: number; borrower_asked_for_help: boolean; request_logged_at?: string | null }): { permitted: boolean; refused_by: "FNMA_D2101_NO_SOLICIT_LT30" | null; basis: string | null } {
  const g = solicitationGate(i.regx_days, i.borrower_asked_for_help);
  if (!g.ok) return { permitted: false, refused_by: g.gate, basis: null };
  return { permitted: true, refused_by: null, basis: i.regx_days >= 30 ? "regx_days_delinquent ≥ 30" : `borrower request logged ${i.request_logged_at ?? "on the call"}` };
}
/** 11.5-T10 — income documents older than 90 days (180 disaster) at completeness make the BRP incomplete. */
export function brpCompleteness(i: { completeness_on: PlainDate; documents: readonly { kind: string; dated: PlainDate }[]; disaster_impacted?: boolean }): { complete: boolean; missing_items: readonly string[]; notice: "NTC_REGX_41B2_ACK_INCOMPLETE" | null; max_age_days: 90 | 180 } {
  const max = i.disaster_impacted ? 180 : 90;
  const stale = i.documents.filter((d) => daysBetween(d.dated, i.completeness_on) > max).map((d) => `${d.kind} dated ${d.dated} (older than ${max} days)`);
  return { complete: stale.length === 0, missing_items: stale, notice: stale.length ? "NTC_REGX_41B2_ACK_INCOMPLETE" : null, max_age_days: max };
}
/** 11.5-T11 — Colorado: pre-decision notice before an AI-influenced adverse determination, explanation of failed tests, appeal channel. */
export function coloradoDecisionFlow(i: { state: string; ai_influenced: boolean; result: Result }): { steps: readonly string[]; explanation: readonly string[]; appeal_channel: string | null; pre_decision_notice: "NTC_CO_AI_ACT_PRE_DECISION" | null } {
  const adverse = i.result.outcome === "ineligible";
  if (i.state !== "CO" || !i.ai_influenced || !adverse) return { steps: ["determination"], explanation: adverse && i.result.outcome === "ineligible" ? i.result.failed : [], appeal_channel: adverse ? "12.3 appeal / lossmit_reviewer human review" : null, pre_decision_notice: null };
  return { steps: ["NTC_CO_AI_ACT_PRE_DECISION", "determination"], explanation: i.result.outcome === "ineligible" ? i.result.failed : [], appeal_channel: "12.3 appeal / lossmit_reviewer human review", pre_decision_notice: "NTC_CO_AI_ACT_PRE_DECISION" };
}
/** 11.5-T12 — SMDU B2B unavailable ≥4 hours: portal task with the full package, due 1 Fannie Mae BD; the decision PDF is attached on completion. */
export function smduB2bOutage(i: { unavailable_hours: number; created_on: PlainDate; package: Record<string, unknown> }): { human_portal_task: { kind: "smdu"; owner_role: "fnma_portal_operator"; due: PlainDate; package: Record<string, unknown>; timer: "FNMA_SMDU_PORTAL_TASK_1BD" } | null; retry: boolean } {
  if (i.unavailable_hours < 4) return { human_portal_task: null, retry: true };
  return { human_portal_task: { kind: "smdu", owner_role: "fnma_portal_operator", due: addBusinessDays(i.created_on, 1, fannieEt), package: i.package, timer: "FNMA_SMDU_PORTAL_TASK_1BD" }, retry: false };
}
export function completePortalTask(i: { decision_pdf_document_id: string | null }): { completed: boolean; attached: boolean } { return { completed: i.decision_pdf_document_id !== null, attached: i.decision_pdf_document_id !== null }; }
/** 11.5-T13 — the deterministic evaluation job: the same matrix whether AI mode is on or off. */
export function evaluationMatrix(e: Evaluation, aiMode: boolean): { ai_mode: boolean; result: Result; reviewer_step: "lossmit_reviewer_on_adverse"; notice_step: "form182_regb_or_12_2" } {
  return { ai_mode: aiMode, result: evaluate(e), reviewer_step: "lossmit_reviewer_on_adverse", notice_step: "form182_regb_or_12_2" };
}
/** 11.5-T14 — Chapter 13: bankruptcy schedules ≤90 days old substitute for Form 710; communications through counsel. */
export function chapter13Substitution(i: { chapter: 7 | 13; schedules_dated: PlainDate; evaluation_date: PlainDate }): { substitute_for_form_710: boolean; schedule_age_days: number; communications: "through_counsel" | "borrower" } {
  const age = daysBetween(i.schedules_dated, i.evaluation_date);
  return { substitute_for_form_710: i.chapter === 13 && age <= 90, schedule_age_days: age, communications: i.chapter === 13 ? "through_counsel" : "borrower" };
}
