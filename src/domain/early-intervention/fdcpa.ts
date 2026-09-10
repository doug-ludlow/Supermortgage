/**
 * §11.4 FDCPA / Reg F — debt-collector determination, validation notice
 * timing and content, overlays, and the per-loan `fdcpa_status` state
 * machine that produces the `fdcpa.*` events the section's timers arm and
 * satisfy on (`fdcpa.initial_communication.recorded`, `fdcpa.validation_notice.sent`
 * / `.assumed_received`, `fdcpa.validation_period.ended`, `fdcpa.dispute.received`,
 * `fdcpa.original_creditor.requested`, `fdcpa.cease.received` / `.withdrawn`,
 * `fdcpa.attorney_gate.released`, `fdcpa.furnishing_gate.opened`,
 * `collection.activity.last`, `records.retention.expired`).
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addYears } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";

/** 11.4 data model: `determination_basis ∈ {default_at_obtain, bankruptcy_at_obtain, foreclosure_at_obtain, counsel_override, not_in_default}`. */
export type DeterminationBasis = "default_at_obtain" | "bankruptcy_at_obtain" | "foreclosure_at_obtain" | "counsel_override" | "not_in_default";
/** §1692a(6)(F)(iii): status fixed as of the date the debt was obtained for servicing (11.4 rule 1). */
export function determineDebtCollector(f: { regx_days_delinquent_at_transfer: number; bk_active: boolean; fc_active: boolean; accelerated: boolean; threshold_days?: number; originated_by_partner?: boolean; counsel_override?: { debt_collector: boolean; rationale: string } | null; /** An installment due on or before the transfer date and unpaid (11.4-T1: due on the transfer date → default with threshold 0). */ unpaid_installment_at_transfer?: boolean }): { debt_collector: boolean; basis: DeterminationBasis; threshold_days: number; rationale?: string } {
  const t = f.threshold_days ?? 0;
  if (f.counsel_override) return { debt_collector: f.counsel_override.debt_collector, basis: "counsel_override", threshold_days: t, rationale: f.counsel_override.rationale };
  // Newly originated loans boarded from the partner's origination pipeline are never DC (§1692a(6)(F)(ii)).
  if (f.originated_by_partner) return { debt_collector: false, basis: "not_in_default", threshold_days: t, rationale: "originated by the partner (§1692a(6)(F)(ii))" };
  // §1024.31: delinquency begins on the due date; "any periodic payment past due as of the transfer date, grace period notwithstanding" (rule 1).
  const inDefault = f.unpaid_installment_at_transfer === true || f.regx_days_delinquent_at_transfer > 0;
  if (inDefault && f.regx_days_delinquent_at_transfer >= t) return { debt_collector: true, basis: "default_at_obtain", threshold_days: t };
  if (f.bk_active) return { debt_collector: true, basis: "bankruptcy_at_obtain", threshold_days: t };
  if (f.fc_active) return { debt_collector: true, basis: "foreclosure_at_obtain", threshold_days: t };
  // Acceleration presupposes a default under the uniform instrument (¶22): default at the time obtained.
  if (f.accelerated) return { debt_collector: true, basis: "default_at_obtain", threshold_days: t, rationale: "accelerated at transfer" };
  return { debt_collector: false, basis: "not_in_default", threshold_days: t };
}
/** §1006.34(a)(1)(i)(B): written notice within five *calendar* days of the initial communication. */
export function validationNoticeDue(initialCommunicationOn: PlainDate): PlainDate { return addDays(initialCommunicationOn, 5); }
/** §1006.34(b)(5): assumed receipt five days after mailing excluding Saturdays, Sundays and legal public holidays; validation period ends 30 days later. */
export function validationPeriod(mailedOn: PlainDate): { assumed_receipt_on: PlainDate; validation_period_end_on: PlainDate } { const r = addBusinessDays(mailedOn, 5, federal); return { assumed_receipt_on: r, validation_period_end_on: addDays(r, 30) }; }

export interface Itemization { readonly itemization_date: PlainDate; readonly amount_on_itemization_cents: Cents; readonly interest_since_cents: Cents; readonly fees_since_cents: Cents; readonly payments_since_cents: Cents; readonly credits_since_cents: Cents; readonly current_amount_cents: Cents; }
export function itemizationChecks(i: Itemization): { sum_cents: Cents; consistent: boolean; rounding_difference_cents: Cents } {
  const sum = i.amount_on_itemization_cents + i.interest_since_cents + i.fees_since_cents - i.payments_since_cents - i.credits_since_cents;
  return { sum_cents: sum, consistent: sum === i.current_amount_cents, rounding_difference_cents: i.current_amount_cents - sum };
}
/** Overshadowing template check during the validation period. */
export function overshadows(text: string, validationEnd: PlainDate, refDate: PlainDate): string[] {
  const issues: string[] = [];
  const m = /within (\d+) days/i.exec(text); if (m && addDays(refDate, Number(m[1])) < validationEnd) issues.push(`demands payment within ${m[1]} days, before the validation period ends`);
  if (/immediately|final notice|legal action will/i.test(text)) issues.push("threatens action inconsistent with the dispute right");
  if (!/dispute/i.test(text)) issues.push("dispute statement missing");
  return issues;
}
export type Overlay = { dispute_open?: boolean; cease_active?: boolean; attorney_represented?: boolean; bankruptcy_stay?: boolean };
export const PERMITTED_DURING_CEASE = new Set(["NTC_REGF_1006_6C_CEASE_ACK", "remedy_notice", "regx_ei_notice", "lossmit_response", "periodic_statement", "legally_required"]);
export function communicationAllowed(o: Overlay, kind: string, direction: "outbound_collection" | "borrower_initiated"): { allowed: boolean; reason?: string } {
  if (direction === "borrower_initiated") return { allowed: true };
  if (o.bankruptcy_stay) return { allowed: false, reason: "bankruptcy_stay" };
  if (o.attorney_represented) return { allowed: false, reason: "attorney_represented (§1006.6(b)(2))" };
  if (o.dispute_open && !PERMITTED_DURING_CEASE.has(kind)) return { allowed: false, reason: "collection ceased pending verification (§1006.38)" };
  if (o.cease_active && !PERMITTED_DURING_CEASE.has(kind)) return { allowed: false, reason: "written cease (§1006.6(c))" };
  return { allowed: true };
}

// ---- per-loan fdcpa_status state machine ----------------------------------------------------

export type FdcpaState = "not_applicable" | "determined" | "awaiting_initial_communication" | "initial_communication_made" | "validation_notice_sent" | "validation_period_open" | "validation_period_closed";
export interface FdcpaEvent { readonly type: string; readonly payload: Record<string, unknown>; }
export interface FdcpaStatus {
  readonly loan_id: string; readonly debt_collector: boolean; readonly determination_basis: DeterminationBasis; readonly threshold_days: number; readonly determined_on: PlainDate;
  state: FdcpaState;
  initial_communication_at: PlainDate | null; initial_communication_channel: string | null;
  validation_sent_at: PlainDate | null; validation_channel: string | null; assumed_receipt_on: PlainDate | null; validation_period_end_on: PlainDate | null;
  oc_request_at: PlainDate | null; oc_response_sent_at: PlainDate | null;
  cease_received_at: PlainDate | null; cease_scope: "written_full" | "oral_calls_only" | null; cease_withdrawn_at: PlainDate | null;
  attorney_party_id: string | null; attorney_contacted_on: PlainDate | null; attorney_nonresponse_since: PlainDate | null;
  furnishing_gate_open_at: PlainDate | null; undeliverable_at: PlainDate | null;
  disputes: { received_on: PlainDate; kind: "dispute" | "original_creditor_request"; written: boolean; within_validation_period: boolean; status: "open" | "verification_sent" | "oc_sent" | "duplicative_notified" | "closed"; resolved_on: PlainDate | null }[];
  last_collection_activity_on: PlainDate | null;
  readonly history: string[];
}
export function fdcpaStatusAtBoarding(loanId: string, transferOn: PlainDate, f: Parameters<typeof determineDebtCollector>[0]): { status: FdcpaStatus; events: FdcpaEvent[] } {
  const d = determineDebtCollector(f);
  const status: FdcpaStatus = { loan_id: loanId, debt_collector: d.debt_collector, determination_basis: d.basis, threshold_days: d.threshold_days, determined_on: transferOn, state: d.debt_collector ? "awaiting_initial_communication" : "not_applicable",
    initial_communication_at: null, initial_communication_channel: null, validation_sent_at: null, validation_channel: null, assumed_receipt_on: null, validation_period_end_on: null, oc_request_at: null, oc_response_sent_at: null,
    cease_received_at: null, cease_scope: null, cease_withdrawn_at: null, attorney_party_id: null, attorney_contacted_on: null, attorney_nonresponse_since: null, furnishing_gate_open_at: null, undeliverable_at: null, disputes: [], last_collection_activity_on: null, history: [`${transferOn} determined ${d.basis} (days ${f.regx_days_delinquent_at_transfer}, threshold ${d.threshold_days})`] };
  return { status, events: [{ type: "fdcpa.status.determined", payload: { loan_id: loanId, debt_collector: d.debt_collector, determination_basis: d.basis, regx_days_delinquent_at_boarding: f.regx_days_delinquent_at_transfer, threshold_days: d.threshold_days } }] };
}
export function overlayOf(st: FdcpaStatus, o: { bankruptcy_stay?: boolean } = {}): Overlay {
  return { dispute_open: st.disputes.some((d) => d.status === "open" && d.within_validation_period && d.written), cease_active: st.cease_scope === "written_full" && st.cease_withdrawn_at === null, attorney_represented: st.attorney_party_id !== null && st.attorney_nonresponse_since === null, ...(o.bankruptcy_stay ? { bankruptcy_stay: true } : {}) };
}
const inPeriod = (st: FdcpaStatus, on: PlainDate): boolean => st.validation_period_end_on !== null && on <= st.validation_period_end_on;

/**
 * 11.4 rule 2: the first outbound communication about the debt (or the first verified conversation). With the B-1 enclosed
 * no five-day clock runs (§1006.34(a)(1)(i)(A)); otherwise `REGF_1006_34_VALIDATION_NOTICE_5D` is due +5 calendar days.
 */
export function recordInitialCommunication(st: FdcpaStatus, i: { on: PlainDate; channel: "hello_letter" | "call_inbound" | "call_outbound" | "email"; validation_enclosed: boolean; oral_disclosure_given?: boolean }): { events: FdcpaEvent[]; validation_notice_due: PlainDate | null } {
  if (!st.debt_collector) return { events: [], validation_notice_due: null };
  if (st.initial_communication_at) return { events: [], validation_notice_due: null };
  st.initial_communication_at = i.on; st.initial_communication_channel = i.channel; st.state = "initial_communication_made"; st.last_collection_activity_on = i.on;
  st.history.push(`${i.on} initial communication (${i.channel}${i.validation_enclosed ? ", B-1 enclosed" : ""})`);
  const events: FdcpaEvent[] = [{ type: "fdcpa.initial_communication.recorded", payload: { loan_id: st.loan_id, on: i.on, channel: i.channel, validation_enclosed: i.validation_enclosed, oral_disclosure_given: i.oral_disclosure_given ?? false } }, { type: "collection.activity.last", payload: { loan_id: st.loan_id, on: i.on } }];
  if (i.validation_enclosed) return { events: [...events, ...recordValidationSent(st, { sent_on: i.on, channel: i.channel === "email" ? "electronic" : "mail" })], validation_notice_due: null };
  return { events, validation_notice_due: validationNoticeDue(i.on) };
}
/** `validation_sent_at` → `REGF_1006_34_ASSUMED_RECEIPT_5D` (+5 federal business days) → `REGF_1006_34_VALIDATION_PERIOD_30` (+30). */
export function recordValidationSent(st: FdcpaStatus, i: { sent_on: PlainDate; channel: "mail" | "electronic" }): FdcpaEvent[] {
  const p = validationPeriod(i.sent_on);
  st.validation_sent_at = i.sent_on; st.validation_channel = i.channel; st.assumed_receipt_on = p.assumed_receipt_on; st.validation_period_end_on = p.validation_period_end_on; st.state = "validation_notice_sent";
  st.history.push(`${i.sent_on} validation notice sent (${i.channel}); assumed receipt ${p.assumed_receipt_on}; period ends ${p.validation_period_end_on}`);
  return [{ type: "fdcpa.validation_notice.sent", payload: { loan_id: st.loan_id, sent_on: i.sent_on, channel: i.channel, template: "NTC_REGF_1006_34_VALIDATION_B1" } },
    { type: "fdcpa.validation_notice.assumed_received", payload: { loan_id: st.loan_id, assumed_receipt_on: p.assumed_receipt_on, validation_period_end_on: p.validation_period_end_on, effective_on: p.assumed_receipt_on } }];
}
/** Nightly: the validation period opens on assumed receipt and closes the day after `validation_period_end_on`; the furnishing gate opens 14 days after mailing absent undeliverability. */
export function fdcpaSweep(st: FdcpaStatus, today: PlainDate): FdcpaEvent[] {
  const events: FdcpaEvent[] = [];
  if (st.state === "validation_notice_sent" && st.assumed_receipt_on && today >= st.assumed_receipt_on) { st.state = "validation_period_open"; events.push({ type: "fdcpa.validation_period.opened", payload: { loan_id: st.loan_id, on: st.assumed_receipt_on } }); }
  if (st.state === "validation_period_open" && st.validation_period_end_on && today > st.validation_period_end_on) { st.state = "validation_period_closed"; events.push({ type: "fdcpa.validation_period.ended", payload: { loan_id: st.loan_id, validation_period_end_on: st.validation_period_end_on } }); }
  if (st.furnishing_gate_open_at === null && st.validation_sent_at && st.undeliverable_at === null && today >= addDays(st.validation_sent_at, 14)) events.push(...openFurnishingGate(st, addDays(st.validation_sent_at, 14), "14 days after mailing with no undeliverability notice"));
  return events;
}
export function openFurnishingGate(st: FdcpaStatus, on: PlainDate, basis: string): FdcpaEvent[] {
  if (st.furnishing_gate_open_at !== null) return [];
  st.furnishing_gate_open_at = on; st.history.push(`${on} furnishing gate opened: ${basis}`);
  return [{ type: "fdcpa.furnishing_gate.opened", payload: { loan_id: st.loan_id, furnishing_gate_open_at: on, basis } }];
}
/** A verified telephone/in-person conversation opens the §1006.30(a) furnishing gate and re-anchors retention. */
export function recordConversation(st: FdcpaStatus, on: PlainDate): FdcpaEvent[] {
  st.last_collection_activity_on = on;
  return [{ type: "collection.activity.last", payload: { loan_id: st.loan_id, on } }, ...openFurnishingGate(st, on, "conversation with the consumer")];
}
export function recordUndeliverable(st: FdcpaStatus, on: PlainDate): FdcpaEvent[] { st.undeliverable_at = on; return [{ type: "fdcpa.validation_notice.undeliverable", payload: { loan_id: st.loan_id, on } }]; }

/** 11.4 rule 5: a written dispute / original-creditor request inside the period ceases collection until verification (or the OC response) is sent. */
export function receiveDispute(st: FdcpaStatus, i: { on: PlainDate; kind: "dispute" | "original_creditor_request"; written: boolean; basis?: "not_my_debt" | "amount_wrong" | "other"; duplicative_of?: string | null }): { events: FdcpaEvent[]; collection_ceased: boolean; within_validation_period: boolean; regf_cease_trigger: boolean } {
  const within = inPeriod(st, i.on);
  const cease = i.written && within;
  st.disputes.push({ received_on: i.on, kind: i.kind, written: i.written, within_validation_period: within, status: "open", resolved_on: null });
  if (i.kind === "original_creditor_request") st.oc_request_at = i.on;
  st.history.push(`${i.on} ${i.kind}${i.written ? " (written)" : " (oral)"}${within ? " within the validation period" : ""}${cease ? " — collection ceased" : ""}`);
  const type = i.kind === "dispute" ? "fdcpa.dispute.received" : "fdcpa.original_creditor.requested";
  return { events: [{ type, payload: { loan_id: st.loan_id, on: i.on, written: i.written, within_validation_period: within, basis: i.basis ?? null, duplicative_of: i.duplicative_of ?? null, collection_ceased: cease } }], collection_ceased: cease, within_validation_period: within, regf_cease_trigger: cease };
}
/** Verification / original-creditor response / duplicative notice mailed → collection resumes (`REGF_1006_38_*` gates lift on the `notice.sent`). */
export function resolveDispute(st: FdcpaStatus, i: { on: PlainDate; kind: "verification" | "original_creditor" | "duplicative" }): FdcpaEvent[] {
  const open = st.disputes.filter((d) => d.status === "open");
  for (const d of open) { d.status = i.kind === "verification" ? "verification_sent" : i.kind === "original_creditor" ? "oc_sent" : "duplicative_notified"; d.resolved_on = i.on; }
  if (i.kind === "original_creditor") st.oc_response_sent_at = i.on;
  st.history.push(`${i.on} ${i.kind} sent — collection resumes`);
  return [{ type: i.kind === "verification" ? "fdcpa.dispute.verification_sent" : i.kind === "original_creditor" ? "fdcpa.original_creditor.sent" : "fdcpa.dispute.duplicative_notified", payload: { loan_id: st.loan_id, on: i.on, template: i.kind === "verification" ? "NTC_REGF_1006_38_VERIFICATION" : i.kind === "original_creditor" ? "NTC_REGF_1006_38_ORIGINAL_CREDITOR" : "NTC_REGF_1006_38_DUPLICATIVE", collection_resumed_at: i.on } }];
}
/** 11.4 rule 6: written → `written_full` (all outbound collection communications stop); oral → `oral_calls_only` (calls/SMS/email stop, mail continues). */
export function receiveCease(st: FdcpaStatus, i: { on: PlainDate; written: boolean; document_id?: string | null; by_party_id?: string | null }): { events: FdcpaEvent[]; scope: "written_full" | "oral_calls_only"; regf_gate: "REGF_1006_6C_CEASE_GATE" | null } {
  const scope = i.written ? "written_full" : "oral_calls_only";
  if (i.written) { st.cease_received_at = i.on; st.cease_scope = "written_full"; st.cease_withdrawn_at = null; }
  else if (st.cease_scope !== "written_full") { st.cease_received_at = i.on; st.cease_scope = "oral_calls_only"; }
  st.history.push(`${i.on} cease request (${scope})`);
  const events: FdcpaEvent[] = i.written
    ? [{ type: "fdcpa.cease.received", payload: { loan_id: st.loan_id, written: true, scope, on: i.on, document_id: i.document_id ?? null, by_party_id: i.by_party_id ?? null } }]
    : [{ type: "consent.revoked", payload: { loan_id: st.loan_id, channels: ["ai_voice", "sms", "email", "human_voice"], method: "oral", on: i.on } }, { type: "consent.revocation.honored", payload: { loan_id: st.loan_id, channels: ["ai_voice", "sms", "email", "human_voice"], honored_on: i.on, scope } }];
  return { events, scope, regf_gate: i.written ? "REGF_1006_6C_CEASE_GATE" : null };
}
export function withdrawCease(st: FdcpaStatus, i: { on: PlainDate; written: boolean }): FdcpaEvent[] {
  if (!i.written || st.cease_scope !== "written_full") return [];
  st.cease_withdrawn_at = i.on; st.history.push(`${i.on} cease withdrawn in writing`);
  return [{ type: "fdcpa.cease.withdrawn", payload: { loan_id: st.loan_id, written: true, on: i.on } }];
}
/** 11.4 rule 7: representation routes communications to counsel; a 30-day documented non-response re-opens direct contact. */
export function designateAttorney(st: FdcpaStatus, i: { party_id: string; on: PlainDate; contacted_on: PlainDate }): FdcpaEvent[] {
  st.attorney_party_id = i.party_id; st.attorney_contacted_on = i.contacted_on; st.attorney_nonresponse_since = null; st.history.push(`${i.on} attorney designated (${i.party_id})`);
  return [{ type: "party.attorney.designated", payload: { loan_id: st.loan_id, party_id: i.party_id, on: i.on, contacted_on: i.contacted_on } }];
}
export function attorneyGateReview(st: FdcpaStatus, i: { today: PlainDate; counsel_responded: boolean; counsel_consented?: boolean }): FdcpaEvent[] {
  if (!st.attorney_party_id || !st.attorney_contacted_on || st.attorney_nonresponse_since) return [];
  if (i.counsel_consented) { st.attorney_nonresponse_since = i.today; return [{ type: "fdcpa.attorney_gate.released", payload: { loan_id: st.loan_id, reason: "consent", on: i.today } }]; }
  if (!i.counsel_responded && i.today >= addDays(st.attorney_contacted_on, 30)) { st.attorney_nonresponse_since = addDays(st.attorney_contacted_on, 30); st.history.push(`${i.today} direct contact re-opened: 30 days of documented non-response`); return [{ type: "fdcpa.attorney_gate.released", payload: { loan_id: st.loan_id, reason: "nonresponse_30d", on: st.attorney_nonresponse_since, decision: `§1006.6(b)(2): attorney failed to respond for 30 days after ${st.attorney_contacted_on}` } }]; }
  return [];
}
/** §1006.100 (3 years after the last collection activity) — subsumed by `life_of_loan_plus_4y`; the retention class releases on expiry. */
export function retentionSweep(st: FdcpaStatus, today: PlainDate): FdcpaEvent[] {
  if (!st.last_collection_activity_on) return [];
  const expires = addYears(st.last_collection_activity_on, 3);
  return today >= expires ? [{ type: "records.retention.expired", payload: { loan_id: st.loan_id, class: "regf_3y", anchored_on: st.last_collection_activity_on, expired_on: expires, superseded_by: "life_of_loan_plus_4y" } }] : [];
}
