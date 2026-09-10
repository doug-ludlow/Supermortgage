/**
 * §4 servicing-request operations beyond the clock arithmetic in noe.ts /
 * rfi.ts / continuity.ts / successor.ts / complaints.ts: the NoE paths
 * (good-faith foreclosure responses, overbroad carve-outs, document copies,
 * early correction, NY overrides, AI triage, mail-vendor manifests, fee
 * prohibition, transfer-in residual clocks), RFI exceptions and extensions,
 * continuity callbacks, warm transfers, accuracy harness, metrics and
 * routing, successor post-confirmation rights, expedited timers, assumptions,
 * matrix gaps and fraud signals, and complaint escalations, monitors,
 * analytics and monetary authority.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addYears } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, federal } from "../../kernel/calendar/business.ts";
import { deadlines, type AssertionType, type Deadlines } from "./noe.ts";
import { federalDays } from "./clocks.ts";
import { itemDeadlines } from "./rfi.ts";
import { assignmentDue, type Episode } from "./continuity.ts";
import { rightsOnConfirmation } from "./successor.ts";

// ---------------------------------------------------------------- 4.1 NoE
/** (f)(2) good-faith path (T5): received ≤ 7 days before the sale → a good-faith contact logged before the sale; no acknowledgment timer. */
export function goodFaithResponse(receivedOn: PlainDate, saleOn: PlainDate, contactOn: PlainDate, mode: "oral" | "written"): { profile: Deadlines["profile"]; ack_timer: null; contact: { on: PlainDate; mode: string; before_sale: boolean }; satisfied: boolean } {
  const d = deadlines("b10", receivedOn, { sale_date: saleOn });
  return { profile: d.profile, ack_timer: null, contact: { on: contactOn, mode, before_sale: contactOn < saleOn }, satisfied: d.profile === "fc_within_7_days_goodfaith" && contactOn < saleOn };
}
export interface Assertion { readonly id: string; readonly type: AssertionType | "unidentifiable"; readonly text: string; }
/** (g)(1)(ii) carve-out (T7): identifiable assertions are investigated; only the residue is overbroad, and the (g)(2) notice states the basis and what was carved out. */
export function splitOverbroad(assertions: readonly Assertion[], receivedOn: PlainDate): { investigate: Assertion[]; overbroad_residue: Assertion[]; exception_notice: { template: "NTC_REGX_35G2_EXCEPTION"; basis: "overbroad"; due_on: PlainDate; carved_out: string[] } | null; response_due: PlainDate } {
  const investigate = assertions.filter((a) => a.type !== "unidentifiable"); const residue = assertions.filter((a) => a.type === "unidentifiable");
  const dueMax = investigate.map((a) => deadlines(a.type as AssertionType, receivedOn).response_due).sort().pop() ?? federalDays(receivedOn, 30);
  return { investigate, overbroad_residue: residue, exception_notice: residue.length ? { template: "NTC_REGX_35G2_EXCEPTION", basis: "overbroad", due_on: federalDays(receivedOn, 5), carved_out: investigate.map((a) => a.id) } : null, response_due: dueMax };
}
/** (e)(4) document copies (T10): snapshots within 15 federal BD of the request; privileged items withheld with the written notice in the same window. */
export function documentRequest(requestedOn: PlainDate, docs: readonly { id: string; privileged?: boolean; relied_on: boolean }[]): { copies_due: PlainDate; provided: { id: string; kind: "snapshot" }[]; withheld: { id: string; notice: "NTC_REGX_35E4_WITHHELD"; basis: "privileged" }[]; notice: "NTC_REGX_35E4_DOCS" } {
  const due = federalDays(requestedOn, 15);
  return { copies_due: due, provided: docs.filter((d) => d.relied_on && !d.privileged).map((d) => ({ id: d.id, kind: "snapshot" as const })), withheld: docs.filter((d) => d.relied_on && d.privileged).map((d) => ({ id: d.id, notice: "NTC_REGX_35E4_WITHHELD" as const, basis: "privileged" as const })), notice: "NTC_REGX_35E4_DOCS" };
}
/** (f)(1) early correction (T11): fixed and noticed within 5 federal BD → the ack/response timers cancel with reason `early_correction`. */
export function earlyCorrection(receivedOn: PlainDate, fixedOn: PlainDate, letterMailedOn: PlainDate): { qualifies: boolean; cancel_reason: "early_correction" | null; timers_cancelled: string[]; notice: "NTC_REGX_35F1_EARLY_CORRECTION" } {
  const q = fixedOn <= letterMailedOn && letterMailedOn <= federalDays(receivedOn, 5);
  return { qualifies: q, cancel_reason: q ? "early_correction" : null, timers_cancelled: q ? ["REGX_1024_35D_NOE_ACK_5", "REGX_1024_35E_NOE_RESPONSE_30"] : [], notice: "NTC_REGX_35F1_EARLY_CORRECTION" };
}
/** NY 3 NYCRR 419.6 override (T12): a foreclosure-related NoE with a sale ≤ 60 days out is due in 15 servicer BD; a std_30 NY extension adds 7 BD. */
export function nyNoeDeadline(receivedOn: PlainDate, f: { foreclosure_assertion: boolean; sale_on?: PlainDate | null }): { response_due: PlainDate; basis: string; extension_days: 7 } {
  const fc = f.foreclosure_assertion && f.sale_on && f.sale_on <= addDays(receivedOn, 60);
  return { response_due: fc ? addBusinessDays(receivedOn, 15, servicer) : addBusinessDays(receivedOn, 30, servicer), basis: fc ? "419.6(c): foreclosure-related, sale within 60 days → 15 business days" : "419.6: 30 business days", extension_days: 7 };
}
export function nyExtension(d: { response_due: PlainDate }): PlainDate { return addBusinessDays(d.response_due, 7, servicer); }
/** AI triage (T13): confidence < 0.7 → needs_human with the ack timer running; a later human classification never moves the receipt date. */
export function triageWithConfidence(f: { confidence: number; received_on: PlainDate; human_classified_on?: PlainDate | null }): { queue: "needs_human" | "auto"; receipt_date: PlainDate; ack_due: PlainDate; human_within_1bd: boolean | null } {
  const needsHuman = f.confidence < 0.7;
  return { queue: needsHuman ? "needs_human" : "auto", receipt_date: f.received_on, ack_due: federalDays(f.received_on, 5), human_within_1bd: f.human_classified_on ? f.human_classified_on <= addBusinessDays(f.received_on, 1, servicer) : null };
}
/** Mail-vendor manifest watch (T14): no manifest by 18:00 ET → alarm and the manual intake protocol (receipt dates from the physical stamp). */
export function manifestWatch(f: { expected_by: string; received_at: string | null; now: string }): { alarm: boolean; protocol: "manual_intake" | "normal"; receipt_date_source: "physical_stamp" | "manifest" } {
  const late = f.received_at === null && f.now >= f.expected_by;
  return { alarm: late, protocol: late ? "manual_intake" : "normal", receipt_date_source: late ? "physical_stamp" : "manifest" };
}
/** (h) fee prohibition (T15): no NoE communication may request a fee or payment (template checklist assertion). */
export function noeCommunicationCheck(text: string): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  if (/\b(fee|charge)\b[^.]{0,60}\b(for|to) (this|your|the) (notice|dispute|review|investigation)/i.test(text)) v.push("fee for the notice of error");
  if (/(bring|make) (your )?(account|loan) current[^.]{0,40}(before|to) (we|our)/i.test(text) || /must (pay|remit)[^.]{0,60}(before|to) (we|our) (respond|investigate|review)/i.test(text)) v.push("payment as a condition of the response");
  return { ok: v.length === 0, violations: v };
}
/** Transfer-in open case (T16): the case boards with the transferor's receipt date and the residual clock. */
export function boardOpenNoe(f: { type: AssertionType; transferor_received_on: PlainDate; boarded_on: PlainDate }): { receipt_date: PlainDate; response_due: PlainDate; residual_federal_bd: number } {
  const d = deadlines(f.type, f.transferor_received_on);
  let n = 0; let x = f.boarded_on; while (x < d.response_due) { x = addBusinessDays(x, 1, federal); n++; }
  return { receipt_date: f.transferor_received_on, response_due: d.response_due, residual_federal_bd: n };
}

// ---------------------------------------------------------------- 4.2 RFI
/** Call recordings (T5): within retention → provided within the 30-BD clock, as audio by secure message when consented, else mailed media/transcript. */
export function recordingsResponse(f: { requested_on: PlainDate; call_on: PlainDate; retention_months: number; esign_consented: boolean }): { available: boolean; format: "audio_secure_message" | "mailed_media_or_transcript" | "not_available"; response_due: PlainDate } {
  const within = f.call_on >= addDays(f.requested_on, -Math.round(f.retention_months * 30.4375));
  return { available: within, format: !within ? "not_available" : f.esign_consented ? "audio_secure_message" : "mailed_media_or_transcript", response_due: itemDeadlines("standard", f.requested_on).response_due };
}
/** §1024.36(i) potential-successor request (T7): the document-description notice within 5 federal BD (policy), never later than 30; an sii case opens; no account information is disclosed. */
export function potentialSuccessorRfi(receivedOn: PlainDate): { notice: "NTC_REGX_36I_SII_DOCS"; target_on: PlainDate; latest_on: PlainDate; opens_case: "sii"; account_information_disclosed: false } {
  return { notice: "NTC_REGX_36I_SII_DOCS", target_on: federalDays(receivedOn, 5), latest_on: federalDays(receivedOn, 30), opens_case: "sii", account_information_disclosed: false };
}
/** Duplicative (T8): the same item for the same period answered within 12 months; a new period is answered. */
export function duplicativeRfi(f: { prior_answered_on: PlainDate | null; prior_period: string | null; period: string; received_on: PlainDate }): "duplicative" | null {
  return f.prior_answered_on && f.prior_period === f.period && f.received_on <= addYears(f.prior_answered_on, 1) ? "duplicative" : null;
}
/** Untimely (T9): received more than one year after discharge/transfer → exception notice within 5 federal BD. */
export function untimelyRfi(f: { discharge_or_transfer_on: PlainDate; received_on: PlainDate }): { exception: "untimely" | null; notice_due: PlainDate | null } {
  const u = f.received_on > addYears(f.discharge_or_transfer_on, 1);
  return { exception: u ? "untimely" : null, notice_due: u ? federalDays(f.received_on, 5) : null };
}
/** Custodian retrieval (T10): the (d)(2) extension is used when retrieval exceeds the standard clock; the response lands within 45 total federal BD; the extension notice cites the retrieval. */
export function custodianExtension(receivedOn: PlainDate, retrievalBusinessDays: number): { extension_used: boolean; extension_notice_by: PlainDate; response_due: PlainDate; reason: string } {
  const std = itemDeadlines("standard", receivedOn);
  const used = retrievalBusinessDays > 10;
  return { extension_used: used, extension_notice_by: std.response_due, response_due: used ? federalDays(receivedOn, 45) : std.response_due, reason: used ? "document custodian retrieval" : "" };
}
/** Early response (T11): answered within 5 federal BD → the ack timer cancels with reason `early_response`. */
export function earlyResponse(receivedOn: PlainDate, respondedOn: PlainDate): { qualifies: boolean; cancel_reason: "early_response" | null; notice: "NTC_REGX_36E_EARLY" } {
  const q = respondedOn <= federalDays(receivedOn, 5);
  return { qualifies: q, cancel_reason: q ? "early_response" : null, notice: "NTC_REGX_36E_EARLY" };
}
/** Privilege (T13): a request for legal analysis routes to the attorney for a privilege determination; the withholding notice issues within the item's clock. */
export function privilegeRouting(itemText: string, receivedOn: PlainDate): { route: "attorney" | "case_agent"; notice: "NTC_REGX_36F2_EXCEPTION" | null; basis: "confidential_privileged" | null; due_on: PlainDate } {
  const priv = /legal (analysis|opinion|advice)|attorney|privileged|counsel/i.test(itemText);
  return { route: priv ? "attorney" : "case_agent", notice: priv ? "NTC_REGX_36F2_EXCEPTION" : null, basis: priv ? "confidential_privileged" : null, due_on: itemDeadlines("standard", receivedOn).response_due };
}

// ---------------------------------------------------------------- 4.3 continuity of contact
/** T2: assignment by day 45 regardless of whether an EI notice is due; the EI send auto-assigns if earlier. */
export function assignmentTrigger(dueUnpaid: PlainDate, principalResidence: boolean, eiNoticeOn: PlainDate | null): { assign_by: PlainDate | "not_required"; basis: "day_45" | "ei_notice" | "not_required" } {
  const d = assignmentDue(dueUnpaid, principalResidence);
  if (d === "not_required") return { assign_by: d, basis: "not_required" };
  return eiNoticeOn && eiNoticeOn < d ? { assign_by: eiNoticeOn, basis: "ei_notice" } : { assign_by: d, basis: "day_45" };
}
/** T4: an after-hours call creates a callback request; the assigned team makes live contact within 1 servicer BD (same day if before 3 p.m. local). */
export function callbackRequest(f: { called_at_local: string; staffed_from: string; staffed_to: string }): { callback: boolean; live_contact_due: PlainDate; same_day_target: boolean } {
  const date = f.called_at_local.slice(0, 10) as PlainDate; const time = f.called_at_local.slice(11, 16);
  const afterHours = time < f.staffed_from || time >= f.staffed_to;
  return { callback: afterHours, live_contact_due: addBusinessDays(date, 1, servicer), same_day_target: !afterHours && time < "15:00" };
}
/** T5: "I want a person" → warm transfer within the call, logged. */
export function handleUtterance(text: string): { human_transfer_requested: boolean; action: "warm_transfer_now" | "continue" } {
  const h = /\b(a |an )?(person|human|agent|representative|someone real|operator)\b/i.test(text) && /\b(want|need|speak|talk|give me|get me|transfer)\b/i.test(text);
  return { human_transfer_requested: h, action: h ? "warm_transfer_now" : "continue" };
}
/** T8: every (b)(1) statement must match `lossmit_facts`; the harness requires 100% agreement for release. */
export function accuracyHarness(statements: readonly { fact: string; value: unknown }[], facts: Record<string, unknown>): { agreement_pct: number; release: boolean; mismatches: string[] } {
  const mism = statements.filter((s) => JSON.stringify(facts[s.fact]) !== JSON.stringify(s.value)).map((s) => s.fact);
  const pct = statements.length ? Math.round((10_000 * (statements.length - mism.length)) / statements.length) / 100 : 100;
  return { agreement_pct: pct, release: mism.length === 0, mismatches: mism };
}
/** T10: A4-2.1-04 metrics — ASA ≤ 60s, blockage ≤ 1%, abandonment ≤ 5%; a miss opens an officer remediation task. */
export function callMetrics(cdrs: { offered: number; answered_seconds: readonly number[]; abandoned: number; blocked: number }): { asa_seconds: number; abandonment_pct: number; blockage_pct: number; misses: string[]; officer_task: "a4_2_1_04_remediation" | null } {
  const asa = cdrs.answered_seconds.length ? cdrs.answered_seconds.reduce((a, b) => a + b, 0) / cdrs.answered_seconds.length : 0;
  const ab = cdrs.offered ? (100 * cdrs.abandoned) / cdrs.offered : 0; const bl = cdrs.offered ? (100 * cdrs.blocked) / cdrs.offered : 0;
  const misses = [asa > 60 ? `ASA ${asa}s > 60s` : null, ab > 5 ? `abandonment ${ab.toFixed(1)}% > 5%` : null, bl > 1 ? `blockage ${bl.toFixed(1)}% > 1%` : null].filter((x): x is string => !!x);
  return { asa_seconds: asa, abandonment_pct: ab, blockage_pct: bl, misses, officer_task: misses.length ? "a4_2_1_04_remediation" : null };
}
/** T11: `continuity.ai_first=off` for a state → human queue; the assignment record shows `human_team`. */
export function routeCall(state: string, aiFirstOff: ReadonlySet<string>): { queue: "human" | "ai_first"; assignment_mode: Episode["mode"] } {
  return aiFirstOff.has(state) ? { queue: "human", assignment_mode: "human_team" } : { queue: "ai_first", assignment_mode: "ai_first_named_human" };
}
/** T12: transfer-out closes the episode; the transfer file carries the assignment and open callbacks. */
export function closeForTransferOut(e: Episode, openCallbacks: readonly { id: string }[], transferOn: PlainDate): { episode: Episode; close_reason: "transfer_out"; transfer_file: { assignment: Episode; open_callbacks: string[]; closed_on: PlainDate } } {
  e.status = "released";
  return { episode: e, close_reason: "transfer_out", transfer_file: { assignment: { ...e }, open_callbacks: openCallbacks.map((c) => c.id), closed_on: transferOn } };
}

// ---------------------------------------------------------------- 4.4 successor in interest
/** T6/T7: after confirmation, statements/escrow/EI wait for the acknowledgment; NoE/RFI/payoff never wait. */
export function postConfirmationRights(f: { confirmed_on: PlainDate; ack_returned_on: PlainDate | null; rfi_received_on?: PlainDate | null; payoff_requested_on?: PlainDate | null }): { statements_ei_escrow: "held" | "next_cycle"; rfi_response_due: PlainDate | null; payoff_due: PlainDate | null; escrow_statement_addressee: boolean; rights: ReturnType<typeof rightsOnConfirmation> } {
  const ack = f.ack_returned_on !== null;
  return { statements_ei_escrow: ack ? "next_cycle" : "held", rfi_response_due: f.rfi_received_on ? itemDeadlines("standard", f.rfi_received_on).response_due : null, payoff_due: f.payoff_requested_on ? addBusinessDays(f.payoff_requested_on, 7, servicer) : null, escrow_statement_addressee: ack, rights: rightsOnConfirmation(ack) };
}
/** T8: a pending loss-mit application halves every SII policy timer; on confirmation the application is treated as received on the confirmation date. */
export function siiTimers(f: { identified_on: PlainDate; lossmit_pending: boolean; confirmed_on?: PlainDate | null }): { docs_description_due: PlainDate; facilitate_due: PlainDate; reviewer_flag: "sii_pending_confirmation" | null; application_received_date: PlainDate | null } {
  const half = f.lossmit_pending;
  return { docs_description_due: federalDays(f.identified_on, half ? 2 : 5), facilitate_due: federalDays(f.identified_on, half ? 1 : 2), reviewer_flag: half ? "sii_pending_confirmation" : null, application_received_date: f.lossmit_pending && f.confirmed_on ? f.confirmed_on : null };
}
/** T10: an executed assumption needs the signing-officer record, interested-party notifications within 10 servicer BD, MI approval where MI exists, and a loan-data change where terms change. */
export function assumptionExecuted(f: { executed_on: PlainDate; signing_officer_id: string | null; mi_exists: boolean; mi_approval_on_file: boolean; terms_changed: boolean }): { ok: boolean; problems: string[]; notify_interested_parties_by: PlainDate; loan_data_change: boolean } {
  const p: string[] = [];
  if (!f.signing_officer_id) p.push("signing_officer signature record missing");
  if (f.mi_exists && !f.mi_approval_on_file) p.push("MI company approval not on file");
  return { ok: p.length === 0, problems: p, notify_interested_parties_by: addBusinessDays(f.executed_on, 10, servicer), loan_data_change: f.terms_changed };
}
/** T11: a state/transfer scenario without a counsel-reviewed matrix row uses the (i)(2) examples letter and flags the case `matrix_gap`. */
export function documentDescription(matrixRow: readonly string[] | null): { letter: "matrix" | "i2_examples"; documents: string[]; flag: "matrix_gap" | null; questions: string[] } {
  if (matrixRow) return { letter: "matrix", documents: [...matrixRow], flag: null, questions: [] };
  return { letter: "i2_examples", documents: ["death certificate", "recorded deed", "will or letters testamentary", "divorce decree", "trust certification"], flag: "matrix_gap", questions: ["How did the deceased hold title?", "Is there a will or probate?", "What is your relationship to the borrower?"] };
}
/** T12: fraud/elder-abuse indicators → officer and attorney escalation; no confirmation. */
export function fraudSignals(f: { instrument: "quitclaim" | "warranty_deed" | "other"; grantor_age?: number; grantee_related: boolean; recorded_days_ago: number; notary_anomaly?: boolean }): { escalate: ("officer" | "attorney")[]; confirm: boolean; signals: string[] } {
  const s: string[] = [];
  if (f.instrument === "quitclaim" && !f.grantee_related && f.recorded_days_ago <= 30) s.push("fresh quitclaim to an unrelated party");
  if ((f.grantor_age ?? 0) >= 80 && f.instrument === "quitclaim") s.push("elderly grantor");
  if (f.notary_anomaly) s.push("notarization anomaly");
  return { escalate: s.length ? ["officer", "attorney"] : [], confirm: s.length === 0, signals: s };
}

// ---------------------------------------------------------------- 4.5 complaints
/** T5: a Texas §50(a)(6) defect allegation → attorney/officer escalation, Form 20 package, 60-day cure clock from the notice date. */
export function texasCure(noticeOn: PlainDate): { escalate: ["attorney", "officer"]; package: "form_20"; cure_by: PlainDate; timer: "TX_50A6_CURE_60" } { return { escalate: ["attorney", "officer"], package: "form_20", cure_by: addDays(noticeOn, 60), timer: "TX_50A6_CURE_60" }; }
/** T7: a borrower asking for a human twice without a transfer fires AI_HUMAN_REQUEST_UNMET (critical; governance owner notified the same day). */
export function aiTranscriptMonitor(transcript: readonly { speaker: "borrower" | "ai"; text: string; transferred?: boolean }[], now: PlainDate): { monitor: "AI_HUMAN_REQUEST_UNMET" | null; severity: "critical" | "standard"; notify: { role: "ai_governance_owner"; by: PlainDate } | null; requests: number } {
  const requests = transcript.filter((t) => t.speaker === "borrower" && handleUtterance(t.text).human_transfer_requested).length;
  const transferred = transcript.some((t) => t.transferred);
  const fire = requests >= 2 && !transferred;
  return { monitor: fire ? "AI_HUMAN_REQUEST_UNMET" : null, severity: fire ? "critical" : "standard", notify: fire ? { role: "ai_governance_owner", by: now } : null, requests };
}
/** T8: discrimination in a loss-mit denial → officer review, 19.4 record, 12.3 appeal handling, never an AI-only closure. */
export function fairLendingRouting(f: { alleges_discrimination: boolean; concerns_lossmit_denial: boolean }): { officer_review: boolean; fair_lending_record: "19.4" | null; appeal: "12.3" | null; ai_only_closure_allowed: boolean } {
  if (!f.alleges_discrimination) return { officer_review: false, fair_lending_record: null, appeal: null, ai_only_closure_allowed: true };
  return { officer_review: true, fair_lending_record: "19.4", appeal: f.concerns_lossmit_denial ? "12.3" : null, ai_only_closure_allowed: false };
}
/** T9: a regulator complaint for a loan not on the platform is answered within the state clock with no borrower data. */
export function wrongServicerResponse(receivedOn: PlainDate, stateClockDays: number): { response_by: PlainDate; content: "not_serviced_here_refer_to_correct_servicer"; borrower_data_disclosed: false } { return { response_by: addDays(receivedOn, stateClockDays), content: "not_serviced_here_refer_to_correct_servicer", borrower_data_disclosed: false }; }
/** T11: monthly analytics — complaints per 1,000 loans by category and by preferred language; monitor breaches open officer tasks. */
export function complaintAnalytics(complaints: readonly { category: string; preferred_language: string }[], loans: number, thresholdPer1000: number): { by_category: Record<string, number>; by_language: Record<string, number>; breaches: string[]; officer_tasks: number } {
  const per = (n: number) => Math.round((1000 * n * 100) / loans) / 100;
  const cat: Record<string, number> = {}, lang: Record<string, number> = {};
  for (const c of complaints) { cat[c.category] = (cat[c.category] ?? 0) + 1; lang[c.preferred_language] = (lang[c.preferred_language] ?? 0) + 1; }
  const byCat = Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, per(v)])); const byLang = Object.fromEntries(Object.entries(lang).map(([k, v]) => [k, per(v)]));
  const breaches = Object.entries(byCat).filter(([, v]) => v > thresholdPer1000).map(([k, v]) => `${k}: ${v} per 1,000 > ${thresholdPer1000}`);
  return { by_category: byCat, by_language: byLang, breaches, officer_tasks: breaches.length };
}
export const AI_MONETARY_LIMIT_CENTS: Cents = 50_000n;
/** T12: AI monetary authority ≤ 50,000¢ per loan; above it the correction is blocked pending officer approval and the borrower is told the review timeline. */
export function monetaryAuthority(amountCents: Cents, actor: { kind: string; role?: string }): { allowed: boolean; requires: "officer" | null; borrower_message: string | null } {
  if (actor.kind === "human" && actor.role === "officer") return { allowed: true, requires: null, borrower_message: null };
  if (amountCents <= AI_MONETARY_LIMIT_CENTS) return { allowed: true, requires: null, borrower_message: null };
  return { allowed: false, requires: "officer", borrower_message: "Your correction is under review by an officer; we will confirm within 10 business days." };
}
