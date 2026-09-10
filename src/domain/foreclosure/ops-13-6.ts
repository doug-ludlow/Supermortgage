/**
 * §13.6 Default-related law-firm management — the operating rules over the pure calculators in ./firms.ts and
 * ./ops.ts. Each function validates the inbound record (a firm submission, a Fannie Mae determination, an inbound
 * attorney-network message, a DRA export row, an invoice) and returns the events the process appends (the §13.7
 * `EmittedEvent` pattern: src/app/tools/section13-6.ts appends them from the tool handlers, never a bare literal).
 * Every event a 13.6 registry row is armed or satisfied by comes from here:
 *
 *   firm.candidate.created / firm.due_diligence.completed{passed, tier} — rule 1 / F-2-04: E&O by tier, two
 *       Qualifying Attorneys; a passing file yields the Form 200 package for the partner `officer`'s signature.
 *   firm.selection.decided{decision, decided_on} — A4-2.2-01/-04: selection, rejection, retention and suspension
 *       decisions are retained "seven years after the decision" (FNMA_A4201_RECORDS_7Y);
 *       records.retention.released{kind=firm_selection} closes the clock (19.x).
 *   form200.submitted{submitted_on, expectation_due} / form200.responded{response} — "Within 15 business days
 *       following the submission of Form 200, Fannie Mae expects" to respond (FNMA_A4201_FORM200_RESPONSE_15BD).
 *   firm.training.completed / firm.lra.executed / firm.retained{state, retained_from} — "No Objection" + training +
 *       LRA ⇒ `retained` (officer); the retention starts the SM_FIRM_REVIEW_ANNUAL cycle.
 *   firm.eo_policy.expiring{eo_expires_on} / firm.eo_policy.renewed — the E&O certificate on file runs the
 *       SM_FIRM_EO_EXPIRY_30 clock (due eo_expires_on − 30); renewal evidence closes it; referrals pause at expiry.
 *   foreclosure.referral.requested{firm_id, state} — the referral command the FNMA_A4201_RETAINED_FIRM_GATE
 *       evaluator (13.6.firmRetainedAndCurrent) is asserted on; matter.referred / firm.referral.acknowledged
 *       (FNMA_E3205_FIRM_ACK_2BD, 13.3) / matter.acknowledged / matter.completed{outcome} follow.
 *   attorney_reviews.completed{review_id, kind} + firm.review.completed{findings} — A4-2.2-02's fifteen elements
 *       evidenced; firm.scorecard.published{band} / firm.review.scheduled{kind=risk_triggered} (rule 7; 13.6-T10).
 *   attorney_escalation.discovered{category, discovered_on, due} / firm.escalation.sent{to=loanservicing,
 *       message_id} — A4-2.2-02 "Within two business days of discovery, or sooner if circumstances warrant" by
 *       email to loanservicing@fanniemae.com naming points of contact (FNMA_A4202_FIRM_ESCALATION_2BD).
 *   firm.suspension.proposed / fnma.notified{kind, plan_attached} / firm.suspended / firm.terminated — A4-2.2-04
 *       "prior notice at least five business days before implementing the decision" with the plan
 *       (FNMA_A4204_SUSPENSION_NOTICE_5BD).
 *   firm.matter_transfer.requested{bulk_threshold_reached, post_sale} / matter.transferred — E-1.1-01: ≥30
 *       transfers in 6 months same state need 5 BD notice (FNMA_E1101_BULK_TRANSFER_NOTICE_5BD, satisfied by
 *       fnma.notified{kind=bulk_matter_transfer}); a post-sale transfer needs prior approval
 *       (FNMA_E1101_POST_SALE_TRANSFER_APPROVAL_GATE, evaluator 13.6.fannieMaePriorApproval).
 *   attorney.instruction.acknowledged{dra_reportable=true, expected_dra_event, expected_by} / dra.event.matched /
 *       dra.exception.raised / dra.exception.resolved — rule 6: expected DRA events derived from instructions;
 *       missing after 2 BD ⇒ exception, firm call, 13.5 credit "DRA unverified" (SM_DRA_EVENT_EXPECTED_2BD).
 *   firm.invoice.received{received_on} / firm.invoice.reviewed / firm.invoice.approved{approved_on} /
 *       firm.invoice.paid — E-5-02/E-5-05 review within 10 BD (policy), payment within 30 days of approval
 *       (SM_INVOICE_REVIEW_10BD, SM_INVOICE_PAY_30); claim.milestone.reached{kind} / claim.filed{system=p360}
 *       (FNMA_F105_EXPENSE_CLAIM_60, 15.2).
 */
import { type PlainDate, addDays, addMonths, addYears, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { firmDueDiligence, firmRetention, firmEscalation, suspensionGate, matterTransferGate, scorecardReview, type Escalation } from "./ops.ts";
import { form200Expectation, eoTierFor, eoShortfalls, draEventLate, type EoTier } from "./firms.ts";

export const RULE_SET_VERSION_13_6 = "13.6@A4-2.2-01(05/08/2024)+A4-2.2-02(11/12/2014)+A4-2.2-04(08/15/2018)+F-2-04(10/11/2023)+E-5-05(02/12/2020)+E-5-06(11/12/2014)+E-1.1-01(05/08/2024)";
type Row = Record<string, unknown>;
export interface EmittedEvent { readonly type: string; readonly payload: Row; readonly aggregate?: { readonly kind: string; readonly id: string }; readonly loan_id?: string }
export interface OpResult { readonly row: Row; readonly events: EmittedEvent[]; readonly escalations: Escalation[] }

export const FNMA_LEGAL_EMAIL = "loanservicing@fanniemae.com";
export const firmAggregate = (firmId: string) => ({ kind: "attorney_firm", id: firmId });
export const retentionAggregate = (firmId: string, state: string) => ({ kind: "attorney_retention", id: `${firmId}:${state}` });
export const escalationAggregate = (escalationId: string) => ({ kind: "attorney_escalation", id: escalationId });
/** Invoice events carry the invoice as their subject (payload.loan_id names the loan) so SM_INVOICE_REVIEW_10BD / SM_INVOICE_PAY_30 run per invoice, not per loan. */
export const invoiceAggregate = (invoiceId: string) => ({ kind: "attorney_invoice", id: invoiceId });
export const transferLane = (fromFirm: string, toFirm: string, state: string): string => `${fromFirm}>${toFirm}:${state.toUpperCase()}`;
export const laneAggregate = (lane: string) => ({ kind: "firm_transfer_lane", id: lane });

export type FirmStatus = "candidate" | "rejected" | "form200_pending" | "no_objection" | "retained" | "suspended" | "terminated";
export type Form200Response = "no_objection" | "objection" | "info_requested";
export const FORM200_RESPONSES: readonly Form200Response[] = ["no_objection", "objection", "info_requested"];
/** A4-2.2-02: the eleven escalation matters plus the A4-2.2-04 suspension/transfer/termination triggers; breaches and fraud go the same day. */
export const ESCALATION_CATEGORIES = ["suspension_transfer_termination_trigger", "bar_complaint", "sanction", "systemic_litigation", "data_breach", "fraud", "governmental_inquiry", "media_inquiry", "capacity", "retention_agreement_breach", "systemic_issue", "servicer_process_issue", "organizational_change"] as const;
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];
/** A4-2.2-02: the fifteen minimum monitoring elements every review evidences. */
export const REVIEW_ELEMENTS = ["eligibility", "retention_agreement", "guide", "law", "capacity", "reputational_risk", "information_security", "document_custody", "business_continuity", "eo", "financial_viability", "staffing", "ratios", "training", "quality_of_work"] as const;
export type ReviewKind = "annual" | "risk_triggered" | "onsite" | "desk";
export const REVIEW_KINDS: readonly ReviewKind[] = ["annual", "risk_triggered", "onsite", "desk"];
export type MatterKind = "foreclosure" | "bankruptcy" | "eviction" | "litigation" | "reo_closing";
export const MATTER_KINDS: readonly MatterKind[] = ["foreclosure", "bankruptcy", "eviction", "litigation", "reo_closing"];
export type ClaimMilestone = "sale" | "reinstatement" | "payoff" | "workout";
export const CLAIM_MILESTONES: readonly ClaimMilestone[] = ["sale", "reinstatement", "payoff", "workout"];
export type FnmaNoticeKind = "firm_suspension" | "firm_termination" | "bulk_matter_transfer" | "matter_transfer" | "special_counsel";
export const FNMA_NOTICE_KINDS: readonly FnmaNoticeKind[] = ["firm_suspension", "firm_termination", "bulk_matter_transfer", "matter_transfer", "special_counsel"];
/** Rule 6: the DRA event each Guide-mandated instruction / internal milestone must produce (DRA Event List; State Milestones Cross Reference Table). */
export const DRA_EXPECTED_EVENT: Readonly<Record<string, string>> = { REFERRAL: "referral received", FIRST_LEGAL: "first legal action", BID_INSTRUCTIONS: "sale scheduled", POSTPONE_SALE: "sale postponed", CANCEL_SALE: "sale cancelled", CERTIFY_SALE: "sale held", BK_FILED: "bankruptcy filed", BK_RELIEF: "relief from stay" };
export const BULK_TRANSFER_THRESHOLD = 30;
export const RECORDS_RETENTION_YEARS = 7;
export const INVOICE_REVIEW_BD = 10, INVOICE_PAY_DAYS = 30, EXPENSE_CLAIM_DAYS = 60, EO_WARNING_DAYS = 30, REVIEW_MONTHS_LOW = 12, REVIEW_MONTHS_HIGH = 6;

const nonEmpty = (v: unknown, field: string): string => { const s = typeof v === "string" ? v.trim() : ""; if (!s) throw new RangeError(`${field} is required`); return s; };
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => { const s = nonEmpty(v, field); if (!allowed.includes(s as T)) throw new RangeError(`${field} must be one of ${allowed.join("/")} (got ${s})`); return s as T; };
const positive = (v: Cents | null | undefined, field: string): Cents => { if (v === null || v === undefined || v < 0n) throw new RangeError(`${field} must be a non-negative amount in cents`); return v; };

// ============================================================ selection and retention (A4-2.2-01, F-2-04)
export function firmCandidateCreated(i: { firm_id: string; legal_name: string; offices?: readonly string[]; created_on: PlainDate }): OpResult {
  const firmId = nonEmpty(i.firm_id, "firm_id"), name = nonEmpty(i.legal_name, "legal_name");
  const row = { firm_id: firmId, legal_name: name, offices: [...(i.offices ?? [])], status: "candidate" satisfies FirmStatus, created_on: i.created_on };
  return { row, events: [{ type: "firm.candidate.created", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, legal_name: name, created_on: i.created_on } }], escalations: [] };
}

/** Rule 1 / F-2-04: E&O tier minimums for the firm's annual foreclosure volume; a failing file rejects the firm (informed; records kept 7 years), a passing one yields the Form 200 package for the officer's signature. */
export function dueDiligenceCompleted(i: { firm_id: string; annual_foreclosures: number; eo_per_occurrence_cents: Cents; eo_aggregate_cents: Cents; eo_expires_on: PlainDate | null; qualifying_attorneys?: number; completed_on: PlainDate }): OpResult & { passed: boolean; tier: EoTier; failing: string[] } {
  const firmId = nonEmpty(i.firm_id, "firm_id");
  if (!Number.isInteger(i.annual_foreclosures) || i.annual_foreclosures < 0) throw new RangeError("annual_foreclosures must be a non-negative integer");
  positive(i.eo_per_occurrence_cents, "eo_per_occurrence_cents"); positive(i.eo_aggregate_cents, "eo_aggregate_cents");
  const dd = firmDueDiligence({ annual_foreclosures: i.annual_foreclosures, eo_per_occurrence_cents: i.eo_per_occurrence_cents, eo_aggregate_cents: i.eo_aggregate_cents, ...(i.qualifying_attorneys !== undefined ? { qualifying_attorneys: i.qualifying_attorneys } : {}) });
  const row: Row = { eo_tier: dd.tier, eo_per_occurrence_cents: i.eo_per_occurrence_cents, eo_aggregate_cents: i.eo_aggregate_cents, eo_expires_on: i.eo_expires_on, annual_foreclosures: i.annual_foreclosures, due_diligence: { passed: dd.passed, tier: dd.tier, failing: dd.failing, completed_on: i.completed_on }, form200_package: dd.form200_package, status: dd.passed ? "candidate" : "rejected" };
  const events: EmittedEvent[] = [{ type: "firm.due_diligence.completed", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, passed: dd.passed, tier: dd.tier, failing: dd.failing, completed_on: i.completed_on, form200_package: dd.form200_package } }];
  if (!dd.passed) events.push({ type: "firm.selection.decided", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, decision: "rejected", decided_on: i.completed_on, reasons: dd.failing, inform_firm: true, retain_until: addYears(i.completed_on, RECORDS_RETENTION_YEARS) } });
  return { row, events, escalations: [], passed: dd.passed, tier: dd.tier, failing: dd.failing };
}

/** A4-2.2-01: one Form 200 per firm and jurisdiction, submitted under the partner's servicer number — the officer's certification of F-2-04. */
export function form200Submitted(i: { firm_id: string; state: string; due_diligence_passed: boolean; submitted_on: PlainDate; package_document_id: string; certified_by: string }): OpResult & { expectation_due: PlainDate } {
  const firmId = nonEmpty(i.firm_id, "firm_id"), state = nonEmpty(i.state, "state").toUpperCase();
  if (!i.due_diligence_passed) throw new RangeError(`Form 200 for ${firmId}/${state} refused: due diligence has not passed F-2-04 (A4-2.2-01 "certifies the law firm's satisfaction of Fannie Mae's minimum requirements")`);
  nonEmpty(i.package_document_id, "package_document_id");
  const r = firmRetention({ form200_submitted_on: i.submitted_on, response: null });
  const row = { firm_id: firmId, jurisdiction_state: state, form200_submitted_at: i.submitted_on, form200_response: null, form200_response_at: null, training_completed_at: null, lra_executed_at: null, retained_from: null, retained_to: null, suspended_from: null, form200_package_document_id: i.package_document_id, certified_by: i.certified_by, expectation_due: r.expectation_due, status: "form200_pending" };
  return { row, expectation_due: r.expectation_due, escalations: [], events: [{ type: "form200.submitted", aggregate: retentionAggregate(firmId, state), payload: { firm_id: firmId, jurisdiction_state: state, submitted_on: i.submitted_on, expectation_due: r.expectation_due, timer: r.timer, certified_by: i.certified_by } }] };
}

export function form200Responded(i: { firm_id: string; state: string; submitted_on: PlainDate; response: Form200Response; responded_on: PlainDate; note?: string | null }): OpResult & { on_time: boolean } {
  const firmId = nonEmpty(i.firm_id, "firm_id"), state = nonEmpty(i.state, "state").toUpperCase(); const response = oneOf(i.response, FORM200_RESPONSES, "response");
  if (i.responded_on < i.submitted_on) throw new RangeError("responded_on precedes the Form 200 submission");
  const due = form200Expectation(i.submitted_on); const onTime = i.responded_on <= due;
  const status: FirmStatus = response === "objection" ? "rejected" : response === "no_objection" ? "no_objection" : "form200_pending";
  const events: EmittedEvent[] = [{ type: "form200.responded", aggregate: retentionAggregate(firmId, state), payload: { firm_id: firmId, jurisdiction_state: state, response, responded_on: i.responded_on, expectation_due: due, on_time: onTime, note: i.note ?? null } }];
  if (response === "objection") events.push({ type: "firm.selection.decided", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, decision: "rejected", decided_on: i.responded_on, reasons: ["Fannie Mae Objection determination (A4-2.2-01)"], inform_firm: true, retain_until: addYears(i.responded_on, RECORDS_RETENTION_YEARS) } });
  return { row: { form200_response: response, form200_response_at: i.responded_on, status }, events, escalations: [], on_time: onTime };
}

export function trainingCompleted(i: { firm_id: string; state: string; completed_on: PlainDate }): OpResult {
  const firmId = nonEmpty(i.firm_id, "firm_id"), state = nonEmpty(i.state, "state").toUpperCase();
  return { row: { training_completed_at: i.completed_on }, escalations: [], events: [{ type: "firm.training.completed", aggregate: retentionAggregate(firmId, state), payload: { firm_id: firmId, jurisdiction_state: state, completed_on: i.completed_on } }] };
}
export function lraExecuted(i: { firm_id: string; state: string; executed_on: PlainDate; document_id: string }): OpResult {
  const firmId = nonEmpty(i.firm_id, "firm_id"), state = nonEmpty(i.state, "state").toUpperCase(); nonEmpty(i.document_id, "document_id");
  return { row: { lra_executed_at: i.executed_on, lra_document_id: i.document_id }, escalations: [], events: [{ type: "firm.lra.executed", aggregate: retentionAggregate(firmId, state), payload: { firm_id: firmId, jurisdiction_state: state, executed_on: i.executed_on, document_id: i.document_id, confidential: true } }] };
}

/** "No Objection" + training + LRA ⇒ `retained` (officer); the retention decision is kept 7 years and starts the annual review cycle. */
export function firmRetained(i: { firm_id: string; state: string; submitted_on: PlainDate; response: Form200Response | null; training_completed_on: PlainDate | null; lra_executed_on: PlainDate | null; eo_expires_on: PlainDate | null; retained_from: PlainDate; risk_band?: "low" | "medium" | "high" }): OpResult & { review_due: PlainDate } {
  const firmId = nonEmpty(i.firm_id, "firm_id"), state = nonEmpty(i.state, "state").toUpperCase();
  const r = firmRetention({ form200_submitted_on: i.submitted_on, response: i.response, training_completed_on: i.training_completed_on, lra_executed_on: i.lra_executed_on, eo_expires_on: i.eo_expires_on, today: i.retained_from });
  if (r.status !== "retained") throw new RangeError(`${firmId}/${state} cannot be retained: status ${r.status} (No Objection + training + LRA required; A4-2.2-01)`);
  if (!r.referral_allowed) throw new RangeError(`${firmId}/${state} cannot be retained with expired E&O (F-2-04)`);
  const reviewDue = addMonths(i.retained_from, i.risk_band === "medium" || i.risk_band === "high" ? REVIEW_MONTHS_HIGH : REVIEW_MONTHS_LOW);
  return { row: { retained_from: i.retained_from, retained_to: null, suspended_from: null, status: "retained", next_review_due: reviewDue }, review_due: reviewDue, escalations: [], events: [
    { type: "firm.retained", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, state, jurisdiction_state: state, retained_from: i.retained_from, review_due: reviewDue } },
    { type: "firm.selection.decided", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, decision: "retained", jurisdiction_state: state, decided_on: i.retained_from, retain_until: addYears(i.retained_from, RECORDS_RETENTION_YEARS) } }] };
}

/** F-2-04 E&O by tier; the certificate on file runs the 30-day expiry clock; a later certificate is the renewal evidence. */
export function eoPolicyRecorded(i: { firm_id: string; annual_foreclosures: number; per_occurrence_cents: Cents; aggregate_cents: Cents; expires_on: PlainDate; recorded_on: PlainDate; previous_expires_on: PlainDate | null; certificate_document_id: string }): OpResult & { tier: EoTier; warn_on: PlainDate } {
  const firmId = nonEmpty(i.firm_id, "firm_id"); nonEmpty(i.certificate_document_id, "certificate_document_id");
  const tier = eoTierFor(i.annual_foreclosures); const short = eoShortfalls(tier, positive(i.per_occurrence_cents, "per_occurrence_cents"), positive(i.aggregate_cents, "aggregate_cents"));
  if (short.length) throw new RangeError(short.join("; "));
  if (i.expires_on <= i.recorded_on) throw new RangeError(`E&O certificate expires ${i.expires_on}, on or before ${i.recorded_on}`);
  const warnOn = addDays(i.expires_on, -EO_WARNING_DAYS); const events: EmittedEvent[] = [];
  if (i.previous_expires_on) events.push({ type: "firm.eo_policy.renewed", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, previous_expires_on: i.previous_expires_on, eo_expires_on: i.expires_on, renewed_on: i.recorded_on, certificate_document_id: i.certificate_document_id } });
  events.push({ type: "firm.eo_policy.expiring", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, eo_tier: tier, eo_expires_on: i.expires_on, warn_on: warnOn, referrals_pause_on: i.expires_on, certificate_document_id: i.certificate_document_id } });
  return { row: { eo_tier: tier, eo_per_occurrence_cents: i.per_occurrence_cents, eo_aggregate_cents: i.aggregate_cents, eo_expires_on: i.expires_on, eo_certificate_document_id: i.certificate_document_id }, events, escalations: [], tier, warn_on: warnOn };
}

/** The facts FNMA_A4201_RETAINED_FIRM_GATE (evaluator 13.6.firmRetainedAndCurrent) is asserted on — read from attorney_retentions / attorney_firms, never from the caller. */
export function retentionFacts(i: { firm_status: string | null; retention: Row | null; eo_expires_on: PlainDate | null; today: PlainDate }): { firm_retained_for_state: boolean; lra_executed: boolean; training_done: boolean; eo_unexpired: boolean } {
  const r = i.retention;
  return { firm_retained_for_state: i.firm_status === "retained" && Boolean(r?.retained_from) && !r?.retained_to && !r?.suspended_from, lra_executed: Boolean(r?.lra_executed_at), training_done: Boolean(r?.training_completed_at), eo_unexpired: i.eo_expires_on !== null && i.eo_expires_on >= i.today };
}

export function matterReferred(i: { matter_id: string; loan_id: string; case_id: string; firm_id: string; state: string; kind: MatterKind; referred_on: PlainDate }): OpResult & { ack_due: PlainDate } {
  const matterId = nonEmpty(i.matter_id, "matter_id"), loanId = nonEmpty(i.loan_id, "loan_id"), firmId = nonEmpty(i.firm_id, "firm_id"), state = nonEmpty(i.state, "state").toUpperCase(); const kind = oneOf(i.kind, MATTER_KINDS, "kind");
  const ackDue = addBusinessDays(i.referred_on, 2, servicer);
  return { row: { matter_id: matterId, loan_id: loanId, case_id: i.case_id, firm_id: firmId, state, kind, referred_at: i.referred_on, ack_at: null, ack_complete: null, ack_due: ackDue, status: "referred", expected_dra_events: [] }, ack_due: ackDue, escalations: [], events: [
    { type: "foreclosure.referral.requested", loan_id: loanId, payload: { matter_id: matterId, firm_id: firmId, state, kind, requested_on: i.referred_on } },
    { type: "matter.referred", loan_id: loanId, payload: { matter_id: matterId, firm_id: firmId, state, kind, referred_on: i.referred_on, ack_due: ackDue } }] };
}
/** Inbound `ACK` (E-3.2-05: acknowledge within 2 BD) — closes FNMA_E3205_FIRM_ACK_2BD (13.3) on the referral's loan. */
export function matterAcknowledged(i: { matter: Row; acknowledged_on: PlainDate; ack_complete: boolean; seq?: number }): OpResult & { on_time: boolean } {
  const loanId = nonEmpty(i.matter.loan_id, "matter.loan_id"); const ackDue = typeof i.matter.ack_due === "string" ? (i.matter.ack_due as PlainDate) : null;
  if (i.matter.status !== "referred") throw new RangeError(`matter ${String(i.matter.matter_id)} is ${String(i.matter.status)}, not awaiting acknowledgment`);
  const onTime = ackDue === null || i.acknowledged_on <= ackDue;
  return { row: { ack_at: i.acknowledged_on, ack_complete: i.ack_complete, status: i.ack_complete ? "acknowledged" : "referred" }, on_time: onTime, escalations: [], events: [
    { type: "firm.referral.acknowledged", loan_id: loanId, payload: { matter_id: i.matter.matter_id, firm_id: i.matter.firm_id, acknowledged_on: i.acknowledged_on, ack_complete: i.ack_complete, on_time: onTime, seq: i.seq ?? null } },
    ...(i.ack_complete ? [{ type: "matter.acknowledged", loan_id: loanId, payload: { matter_id: i.matter.matter_id, firm_id: i.matter.firm_id, acknowledged_on: i.acknowledged_on } }] : [])] };
}
/** Rule 6: an acknowledged Guide-mandated instruction sets the DRA event the firm must enter within 2 BD (SM_DRA_EVENT_EXPECTED_2BD). */
export function instructionAcknowledged(i: { matter: Row; instruction: string; acknowledged_on: PlainDate; seq?: number }): OpResult & { expected_dra_event: string | null; expected_by: PlainDate } {
  const loanId = nonEmpty(i.matter.loan_id, "matter.loan_id"); const instruction = nonEmpty(i.instruction, "instruction").toUpperCase();
  const expected = DRA_EXPECTED_EVENT[instruction] ?? null; const by = addBusinessDays(i.acknowledged_on, 2, servicer);
  const expectation = expected ? { instruction, expected_event: expected, event_date: i.acknowledged_on, expected_by: by, matched_on: null } : null;
  const prior = Array.isArray(i.matter.expected_dra_events) ? (i.matter.expected_dra_events as Row[]) : [];
  return { row: { expected_dra_events: expectation ? [...prior, expectation] : prior, last_instruction: instruction, last_instruction_acknowledged_on: i.acknowledged_on }, expected_dra_event: expected, expected_by: by, escalations: [], events: [
    { type: "attorney.instruction.acknowledged", loan_id: loanId, payload: { matter_id: i.matter.matter_id, firm_id: i.matter.firm_id, instruction, acknowledged_on: i.acknowledged_on, dra_reportable: expected !== null, expected_dra_event: expected, expected_by: expected ? by : null, seq: i.seq ?? null } }] };
}
/** A completed matter (sale held through confirmation, reinstatement, payoff, workout) is the 15.2 claim milestone: P360 claim within 60 days (FNMA_F105_EXPENSE_CLAIM_60). */
export function matterCompleted(i: { matter: Row; outcome: ClaimMilestone; completed_on: PlainDate; confirmation_completed?: boolean }): OpResult & { claim_due: PlainDate } {
  const loanId = nonEmpty(i.matter.loan_id, "matter.loan_id"); const outcome = oneOf(i.outcome, CLAIM_MILESTONES, "outcome");
  if (outcome === "sale" && i.confirmation_completed !== true) throw new RangeError("a sale completes the matter only once post-sale confirmation/ratification is completed (E-5-04)");
  const claimDue = addDays(i.completed_on, EXPENSE_CLAIM_DAYS);
  return { row: { status: "completed", completed_on: i.completed_on, outcome, confirmation_completed: outcome === "sale", claim_due: claimDue }, claim_due: claimDue, escalations: [], events: [
    { type: "matter.completed", loan_id: loanId, payload: { matter_id: i.matter.matter_id, firm_id: i.matter.firm_id, outcome, completed_on: i.completed_on } },
    { type: "claim.milestone.reached", loan_id: loanId, payload: { matter_id: i.matter.matter_id, kind: outcome, milestone_on: i.completed_on, claim_due: claimDue, system: "p360" } }] };
}
export function claimFiled(i: { matter: Row; claim_id: string; filed_on: PlainDate; claimable_cents: Cents }): OpResult & { on_time: boolean | null } {
  const loanId = nonEmpty(i.matter.loan_id, "matter.loan_id"); nonEmpty(i.claim_id, "claim_id"); positive(i.claimable_cents, "claimable_cents");
  if (i.matter.status !== "completed") throw new RangeError(`matter ${String(i.matter.matter_id)} has no claim milestone (status ${String(i.matter.status)})`);
  const due = typeof i.matter.claim_due === "string" ? (i.matter.claim_due as PlainDate) : null; const onTime = due ? i.filed_on <= due : null;
  return { row: { claim_id: i.claim_id, claim_filed_on: i.filed_on, claimable_cents: i.claimable_cents, status: "claimed" }, on_time: onTime, escalations: [], events: [
    { type: "claim.filed", loan_id: loanId, payload: { matter_id: i.matter.matter_id, claim_id: i.claim_id, system: "p360", filed_on: i.filed_on, claim_due: due, on_time: onTime, claimable_cents: i.claimable_cents } }] };
}

// ============================================================ oversight (A4-2.2-02)
export function reviewCompleted(i: { firm_id: string; review_id: string; kind: ReviewKind; completed_on: PlainDate; elements: Row; findings: readonly string[]; remediation_plan_document_id?: string | null; fnma_requested?: boolean }): OpResult & { next_review_due: PlainDate } {
  const firmId = nonEmpty(i.firm_id, "firm_id"), reviewId = nonEmpty(i.review_id, "review_id"); const kind = oneOf(i.kind, REVIEW_KINDS, "kind");
  const missing = REVIEW_ELEMENTS.filter((e) => { const v = i.elements[e] as Row | undefined; return !v || !v.result || !v.evidence_document_id; });
  if (missing.length) throw new RangeError(`review ${reviewId} must evidence all fifteen A4-2.2-02 elements; missing: ${missing.join(", ")}`);
  if (i.findings.length && !i.remediation_plan_document_id) throw new RangeError("a review with findings needs a remediation plan (A4-2.2-02)");
  const next = addMonths(i.completed_on, i.findings.length ? REVIEW_MONTHS_HIGH : REVIEW_MONTHS_LOW);
  return { row: { review_id: reviewId, firm_id: firmId, kind, completed_at: i.completed_on, elements: i.elements, findings: [...i.findings], remediation_plan_document_id: i.remediation_plan_document_id ?? null, fnma_requested: i.fnma_requested === true, next_review_due: next }, next_review_due: next, escalations: [], events: [
    { type: "attorney_reviews.completed", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, review_id: reviewId, kind, completed_on: i.completed_on, findings: i.findings.length, next_review_due: next } },
    { type: "firm.review.completed", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, review_id: reviewId, kind, findings: [...i.findings], remediation_plan_document_id: i.remediation_plan_document_id ?? null } }] };
}
/** Rule 7 / 13.6-T10: the monthly scorecard; two months running in the bottom band schedules a risk-triggered review and informs the officer. */
export function scorecardPublished(i: { firm_id: string; state: string; month: string; band: "top" | "middle" | "bottom"; history: readonly { month: string; band: "top" | "middle" | "bottom" }[]; published_on: PlainDate; metrics?: Row }): OpResult & { review_triggered: boolean } {
  const firmId = nonEmpty(i.firm_id, "firm_id"), state = nonEmpty(i.state, "state").toUpperCase();
  if (!/^\d{4}-\d{2}$/.test(i.month)) throw new RangeError("month must be YYYY-MM");
  const history = [...i.history.filter((h) => h.month !== i.month), { month: i.month, band: i.band }];
  const r = scorecardReview(history);
  const events: EmittedEvent[] = [{ type: "firm.scorecard.published", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, state, month: i.month, band: i.band, metrics: i.metrics ?? {} } }];
  if (r.trigger) events.push({ type: "firm.review.scheduled", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, kind: "risk_triggered", scheduled_for: addBusinessDays(i.published_on, 10, servicer), reason: r.escalation!.reason } });
  return { row: { firm_id: firmId, state, month: i.month, band: i.band, history }, review_triggered: r.trigger, escalations: r.escalation ? [r.escalation] : [], events };
}

export function escalationDiscovered(i: { escalation_id: string; firm_id: string; category: EscalationCategory; discovered_on: PlainDate; pocs: readonly string[]; litigation?: boolean; description?: string }): OpResult & { due: PlainDate; message_id: string } {
  const id = nonEmpty(i.escalation_id, "escalation_id"), firmId = nonEmpty(i.firm_id, "firm_id"); const category = oneOf(i.category, ESCALATION_CATEGORIES, "category");
  const r = firmEscalation({ firm_id: firmId, category, discovered_on: i.discovered_on, pocs: i.pocs });
  const channel = i.litigation ? "form20:quatro.fanniemae.com" : r.channel;
  return { row: { escalation_id: id, firm_id: firmId, category, discovered_at: i.discovered_on, due: r.due, sent_to_fnma_at: null, channel, message_id: null, poc: [...i.pocs], description: i.description ?? null, status: "open", decision: r.record.decision }, due: r.due, message_id: r.message_id, escalations: [], events: [
    { type: "attorney_escalation.discovered", aggregate: escalationAggregate(id), payload: { escalation_id: id, firm_id: firmId, category, discovered_on: i.discovered_on, due: r.due, same_day: r.due === i.discovered_on, channel } }] };
}
/** A4-2.2-02: the tracked email to loanservicing@fanniemae.com (Form 20 for litigation matters, 13.7) naming points of contact; the message id and decision record are stored. */
export function escalationSent(i: { escalation: Row; sent_on: PlainDate; message_id?: string | null; pocs?: readonly string[] }): OpResult & { on_time: boolean } {
  const id = nonEmpty(i.escalation.escalation_id, "escalation.escalation_id"), firmId = nonEmpty(i.escalation.firm_id, "escalation.firm_id"); const category = oneOf(i.escalation.category, ESCALATION_CATEGORIES, "escalation.category");
  if (i.escalation.status !== "open") throw new RangeError(`escalation ${id} is ${String(i.escalation.status)}`);
  const pocs = i.pocs && i.pocs.length ? [...i.pocs] : Array.isArray(i.escalation.poc) ? (i.escalation.poc as string[]) : [];
  const r = firmEscalation({ firm_id: firmId, category, discovered_on: i.escalation.discovered_at as PlainDate, pocs, sent_on: i.sent_on });
  if (r.refusal) throw new RangeError(r.refusal);
  const messageId = i.message_id?.trim() || r.message_id; const litigation = String(i.escalation.channel ?? "").startsWith("form20");
  return { row: { sent_to_fnma_at: i.sent_on, message_id: messageId, poc: pocs, status: "sent", on_time: r.on_time, decision: { ...r.record.decision, outcome: "sent", message_id: messageId } }, on_time: r.on_time === true, escalations: [], events: [
    { type: "firm.escalation.sent", aggregate: escalationAggregate(id), payload: { escalation_id: id, firm_id: firmId, category, to: litigation ? "form20" : "loanservicing", email: litigation ? null : FNMA_LEGAL_EMAIL, message_id: messageId, pocs, sent_on: i.sent_on, due: r.due, on_time: r.on_time } }] };
}

// ============================================================ suspensions, transfers, terminations (A4-2.2-04, E-1.1-01)
export function suspensionProposed(i: { firm_id: string; proposed_on: PlainDate; reason: string; package_document_id: string }): OpResult {
  const firmId = nonEmpty(i.firm_id, "firm_id"); nonEmpty(i.reason, "reason"); nonEmpty(i.package_document_id, "package_document_id");
  return { row: { suspension: { proposed_on: i.proposed_on, reason: i.reason, package_document_id: i.package_document_id, fnma_notified_on: null, plan_attached: false, implemented_on: null } }, escalations: [{ kind: "officer", severity: "sev2", reason: `suspension of ${firmId} proposed: ${i.reason} — officer decision with the AI package (A4-2.2-04)` }], events: [
    { type: "firm.suspension.proposed", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, proposed_on: i.proposed_on, reason: i.reason, package_document_id: i.package_document_id, earliest_implementation_after_notice_bd: 5 } }] };
}
/** A4-2.2-04 / E-1.1-01 notice to Fannie Mae with the implementation plan; the gate opens 5 servicer BD later. */
export function fnmaNotified(i: { firm_id: string; kind: FnmaNoticeKind; notified_on: PlainDate; plan_document_id?: string | null; lane?: string | null; message_id?: string | null }): OpResult & { earliest_implementation: PlainDate } {
  const firmId = nonEmpty(i.firm_id, "firm_id"); const kind = oneOf(i.kind, FNMA_NOTICE_KINDS, "kind"); const plan = Boolean(i.plan_document_id);
  if ((kind === "firm_suspension" || kind === "firm_termination") && !plan) throw new RangeError(`${kind} notice to Fannie Mae needs the implementation plan (A4-2.2-04)`);
  if (kind === "bulk_matter_transfer" && !i.lane) throw new RangeError("bulk_matter_transfer notice names the transfer lane (from firm > to firm : state)");
  const earliest = addBusinessDays(i.notified_on, 5, servicer);
  const aggregate = kind === "bulk_matter_transfer" ? laneAggregate(i.lane!) : firmAggregate(firmId);
  return { row: kind === "firm_suspension" ? { suspension_fnma_notified_on: i.notified_on, suspension_plan_attached: plan } : {}, earliest_implementation: earliest, escalations: [], events: [
    { type: "fnma.notified", aggregate, payload: { firm_id: firmId, kind, notified_on: i.notified_on, plan_attached: plan ? "true" : "false", plan_document_id: i.plan_document_id ?? null, lane: i.lane ?? null, message_id: i.message_id ?? null, earliest_implementation: earliest, to: FNMA_LEGAL_EMAIL } }] };
}
export function suspensionImplemented(i: { firm_id: string; suspension: Row | null; implement_on: PlainDate }): { allowed: boolean; refusal: string | null; earliest: PlainDate | null; gate: "FNMA_A4204_SUSPENSION_NOTICE_5BD"; row: Row; events: EmittedEvent[] } {
  const firmId = nonEmpty(i.firm_id, "firm_id"); const s = i.suspension;
  if (!s || typeof s.proposed_on !== "string") throw new RangeError(`no suspension proposed for ${firmId}`);
  const g = suspensionGate({ proposed_on: s.proposed_on as PlainDate, fnma_notified_on: typeof s.fnma_notified_on === "string" ? (s.fnma_notified_on as PlainDate) : null, plan_attached: s.plan_attached === true, implement_on: i.implement_on });
  if (!g.allowed) return { allowed: false, refusal: g.refusal, earliest: g.earliest, gate: "FNMA_A4204_SUSPENSION_NOTICE_5BD", row: {}, events: [] };
  return { allowed: true, refusal: null, earliest: g.earliest, gate: "FNMA_A4204_SUSPENSION_NOTICE_5BD", row: { status: "suspended", suspension: { ...s, implemented_on: i.implement_on } }, events: [
    { type: "firm.suspended", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, implemented_on: i.implement_on, fnma_notified_on: s.fnma_notified_on, earliest: g.earliest, referrals_stopped: true } },
    { type: "firm.selection.decided", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, decision: "suspended", decided_on: i.implement_on, retain_until: addYears(i.implement_on, RECORDS_RETENTION_YEARS) } }] };
}
/** Rule 5: the 30-in-6-months counter per (from-firm, to-firm, state); a post-sale transfer needs Fannie Mae's prior approval. */
export function matterTransferRequested(i: { matter: Row; to_firm: string; requested_on: PlainDate; reason: string; prior_lane_transfers_on: readonly PlainDate[]; sale_held: boolean }): OpResult & { lane: string; transfers_in_6m: number; bulk_threshold_reached: boolean; post_sale: boolean } {
  const matterId = nonEmpty(i.matter.matter_id, "matter.matter_id"), from = nonEmpty(i.matter.firm_id, "matter.firm_id"), to = nonEmpty(i.to_firm, "to_firm"), state = nonEmpty(i.matter.state, "matter.state").toUpperCase(); nonEmpty(i.reason, "reason");
  if (from === to) throw new RangeError("to_firm is the matter's current firm");
  if (i.matter.status === "completed" || i.matter.status === "transferred" || i.matter.status === "claimed") throw new RangeError(`matter ${matterId} is ${String(i.matter.status)}`);
  const lane = transferLane(from, to, state); const windowStart = addMonths(i.requested_on, -6);
  const count = i.prior_lane_transfers_on.filter((d) => d >= windowStart && d <= i.requested_on).length + 1; const bulk = count >= BULK_TRANSFER_THRESHOLD;
  return { row: { transfer: { to_firm: to, lane, requested_on: i.requested_on, reason: i.reason, transfers_in_6m: count, bulk_threshold_reached: bulk, post_sale: i.sale_held, fnma_notified_on: null, fnma_approval_document_id: null, transferred_on: null }, transfer_lane: lane, transfer_requested_on: i.requested_on }, lane, transfers_in_6m: count, bulk_threshold_reached: bulk, post_sale: i.sale_held,
    escalations: [{ kind: "officer", severity: "sev3", reason: `matter ${matterId} transfer ${from}→${to} (${state}) proposed: ${i.reason}${bulk ? ` — ${count}th in 6 months, Fannie Mae 5-BD notice required (E-1.1-01)` : ""}${i.sale_held ? " — post-sale, Fannie Mae prior approval required" : ""}` }],
    events: [{ type: "firm.matter_transfer.requested", aggregate: laneAggregate(lane), payload: { matter_id: matterId, loan_id: i.matter.loan_id, from_firm: from, to_firm: to, state, lane, requested_on: i.requested_on, reason: i.reason, transfers_in_6m: count, bulk_threshold_reached: bulk ? "true" : "false", post_sale: i.sale_held ? "true" : "false" } }] };
}
export function transferApprovalRecorded(i: { matter: Row; document_id: string; granted_on: PlainDate }): OpResult {
  const matterId = nonEmpty(i.matter.matter_id, "matter.matter_id"); nonEmpty(i.document_id, "document_id"); const t = (i.matter.transfer as Row | undefined) ?? null;
  if (!t) throw new RangeError(`no transfer requested for matter ${matterId}`);
  return { row: { transfer: { ...t, fnma_approval_document_id: i.document_id, fnma_approval_on: i.granted_on } }, escalations: [], events: [{ type: "fnma.transfer_approval.recorded", loan_id: String(i.matter.loan_id), payload: { matter_id: matterId, lane: t.lane, document_id: i.document_id, granted_on: i.granted_on } }] };
}
export function matterTransferred(i: { matter: Row; transfer_on: PlainDate; lane_notified_on: PlainDate | null; allowable_cents: Cents | null; paid_cents: Cents; new_matter_id: string }): { allowed: boolean; refusal: string | null; gate: string | null; earliest: PlainDate | null; row: Row; new_matter: Row; events: EmittedEvent[] } {
  const matterId = nonEmpty(i.matter.matter_id, "matter.matter_id"); const t = (i.matter.transfer as Row | undefined) ?? null; nonEmpty(i.new_matter_id, "new_matter_id");
  if (!t) throw new RangeError(`no transfer requested for matter ${matterId}`);
  const g = matterTransferGate({ state: String(i.matter.state), from_firm: String(i.matter.firm_id), to_firm: String(t.to_firm), transfers_in_6m_including_this: Number(t.transfers_in_6m), fnma_notified_on: i.lane_notified_on, transfer_on: i.transfer_on, post_sale: t.post_sale === true, fnma_approval_document_id: typeof t.fnma_approval_document_id === "string" ? t.fnma_approval_document_id : null });
  if (!g.allowed) return { allowed: false, refusal: g.refusal, gate: g.gate, earliest: g.earliest, row: {}, new_matter: {}, events: [] };
  // Rule 5: transferor paid to its last milestone; transferee's fee = allowable − amount paid (no duplicate fees; never charged to Fannie Mae or the borrower)
  const transfereeFee = i.allowable_cents === null ? null : i.allowable_cents - i.paid_cents < 0n ? 0n : i.allowable_cents - i.paid_cents;
  const newMatter: Row = { matter_id: i.new_matter_id, loan_id: i.matter.loan_id, case_id: i.matter.case_id, firm_id: t.to_firm, state: i.matter.state, kind: i.matter.kind, referred_at: i.transfer_on, ack_at: null, ack_complete: null, ack_due: addBusinessDays(i.transfer_on, 2, servicer), status: "referred", transferred_from_matter_id: matterId, transfer_reason: t.reason, transferee_fee_cap_cents: transfereeFee, expected_dra_events: [] };
  return { allowed: true, refusal: null, gate: g.gate, earliest: g.earliest, row: { status: "transferred", transfer: { ...t, transferred_on: i.transfer_on, transferee_matter_id: i.new_matter_id, transferee_fee_cap_cents: transfereeFee, transfer_fees_to_fnma_or_borrower_cents: 0n }, transferred_on: i.transfer_on }, new_matter: newMatter, events: [
    { type: "matter.transferred", loan_id: String(i.matter.loan_id), payload: { matter_id: matterId, new_matter_id: i.new_matter_id, from_firm: i.matter.firm_id, to_firm: t.to_firm, state: i.matter.state, lane: t.lane, transferred_on: i.transfer_on, gate: g.gate, transferee_fee_cap_cents: transfereeFee, paid_to_transferor_cents: i.paid_cents, transfer_fees_charged_cents: 0n } }] };
}
export function firmTerminated(i: { firm_id: string; open_matters: number; terminated_on: PlainDate; fnma_notified_on: PlainDate | null; plan_attached: boolean }): OpResult {
  const firmId = nonEmpty(i.firm_id, "firm_id");
  if (i.open_matters > 0) throw new RangeError(`${firmId} still has ${i.open_matters} open matter(s) — transfer them first (A4-2.2-04)`);
  const g = suspensionGate({ proposed_on: i.terminated_on, fnma_notified_on: i.fnma_notified_on, plan_attached: i.plan_attached, implement_on: i.terminated_on });
  if (!g.allowed) throw new RangeError(g.refusal ?? "termination refused");
  return { row: { status: "terminated", terminated_on: i.terminated_on }, escalations: [], events: [
    { type: "firm.terminated", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, terminated_on: i.terminated_on, fnma_notified_on: i.fnma_notified_on } },
    { type: "firm.selection.decided", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, decision: "terminated", decided_on: i.terminated_on, retain_until: addYears(i.terminated_on, RECORDS_RETENTION_YEARS) } }] };
}
/** A4-2.2-01/-04: selection, rejection and suspension records are released only "seven years after the decision" (or longer) and never under a legal hold (19.x). */
export function selectionRecordsReleased(i: { firm_id: string; decided_on: PlainDate; decision: string; released_on: PlainDate; legal_hold: boolean; longer_retention_until?: PlainDate | null }): OpResult & { eligible_on: PlainDate } {
  const firmId = nonEmpty(i.firm_id, "firm_id"); const eligible = addYears(i.decided_on, RECORDS_RETENTION_YEARS); const until = i.longer_retention_until && i.longer_retention_until > eligible ? i.longer_retention_until : eligible;
  if (i.legal_hold) throw new RangeError(`${firmId} selection records are under legal hold`);
  if (i.released_on < until) throw new RangeError(`${firmId} ${i.decision} records (decided ${i.decided_on}) are retained until ${until} — ${daysBetween(i.released_on, until)} days remain (A4-2.2-01/-04: seven years after the decision)`);
  return { row: { selection_records_released_on: i.released_on }, eligible_on: until, escalations: [], events: [{ type: "records.retention.released", aggregate: firmAggregate(firmId), payload: { firm_id: firmId, kind: "firm_selection", decision: i.decision, decided_on: i.decided_on, eligible_on: until, released_on: i.released_on } }] };
}

// ============================================================ invoices (E-5-02, E-5-05, E-5-06)
export function invoiceReceived(i: { invoice_id: string; matter: Row; received_on: PlainDate; period?: string | null; lines: readonly Row[]; seq?: number }): OpResult & { review_due: PlainDate } {
  const invoiceId = nonEmpty(i.invoice_id, "invoice_id"); const matterId = nonEmpty(i.matter.matter_id, "matter.matter_id");
  if (!i.lines.length) throw new RangeError("an invoice needs at least one line");
  for (const [n, l] of i.lines.entries()) { oneOf(l.kind, ["fee_milestone", "cost", "tech_fee", "einvoice_fee", "excess_fee"], `lines[${n}].kind`); positive(typeof l.amount_cents === "bigint" ? l.amount_cents : null, `lines[${n}].amount_cents`); }
  const due = addBusinessDays(i.received_on, INVOICE_REVIEW_BD, servicer);
  return { row: { invoice_id: invoiceId, matter_id: matterId, loan_id: i.matter.loan_id, firm_id: i.matter.firm_id, received_at: i.received_on, period: i.period ?? null, lines: [...i.lines], review_due: due, status: "received", review_result: null, paid_at: null, paid_amount_cents: null, borrower_chargeable_cents: 0n, claimable_cents: 0n }, review_due: due, escalations: [], events: [
    { type: "firm.invoice.received", aggregate: invoiceAggregate(invoiceId), payload: { invoice_id: invoiceId, matter_id: matterId, loan_id: i.matter.loan_id, firm_id: i.matter.firm_id, received_on: i.received_on, review_due: due, lines: i.lines.length, seq: i.seq ?? null } }] };
}
/** E-5-02 "review/approve fees and costs": the rules engine's result is the approval (the model cannot approve a rejected line); approval starts the 30-day payment clock. */
export function invoiceReviewOutcome(i: { invoice_id: string; loan_id: string | null; matter_id: string; reviewed_on: PlainDate; review_result: string; fee_approved_cents: Cents; costs_approved_cents: Cents; tech_fee_approved_cents: Cents; rejected: number; cites: readonly string[] }): { events: EmittedEvent[]; approved_cents: Cents; pay_by: PlainDate | null } {
  const invoiceId = nonEmpty(i.invoice_id, "invoice_id"); const approved = i.fee_approved_cents + i.costs_approved_cents + i.tech_fee_approved_cents;
  const events: EmittedEvent[] = [{ type: "firm.invoice.reviewed", aggregate: invoiceAggregate(invoiceId), payload: { invoice_id: invoiceId, matter_id: i.matter_id, loan_id: i.loan_id, reviewed_on: i.reviewed_on, review_result: i.review_result, fee_approved_cents: i.fee_approved_cents, costs_approved_cents: i.costs_approved_cents, tech_fee_approved_cents: i.tech_fee_approved_cents, rejected: i.rejected, cites: [...i.cites] } }];
  const payBy = approved > 0n ? addDays(i.reviewed_on, INVOICE_PAY_DAYS) : null;
  if (approved > 0n) events.push({ type: "firm.invoice.approved", aggregate: invoiceAggregate(invoiceId), payload: { invoice_id: invoiceId, matter_id: i.matter_id, loan_id: i.loan_id, approved_on: i.reviewed_on, approved_cents: approved, pay_by: payBy, review_result: i.review_result } });
  return { events, approved_cents: approved, pay_by: payBy };
}
/** E-5-05: "Pay the law firm for the fees and costs incurred ... even if sufficient funds were not collected from the borrower"; the payment books the corporate advance (claim-eligible) and closes SM_INVOICE_PAY_30. */
export function invoicePaid(i: { invoice: Row; paid_on: PlainDate; paid_cents: Cents; payment_ref: string; dra_hold?: boolean }): OpResult & { advance: { loan_id: string | null; claim_eligible_cents: Cents; tech_fee_cents: Cents; borrower_chargeable_cents: Cents } } {
  const invoiceId = nonEmpty(i.invoice.invoice_id, "invoice.invoice_id"); nonEmpty(i.payment_ref, "payment_ref"); positive(i.paid_cents, "paid_cents");
  if (i.invoice.status !== "reviewed" && i.invoice.status !== "approved") throw new RangeError(`invoice ${invoiceId} is ${String(i.invoice.status)}, not approved for payment`);
  const fee = (i.invoice.fee_approved_cents as Cents | undefined) ?? 0n, costs = (i.invoice.costs_approved_cents as Cents | undefined) ?? 0n, tech = (i.invoice.tech_fee_approved_cents as Cents | undefined) ?? 0n; const approved = fee + costs + tech;
  if (approved === 0n) throw new RangeError(`invoice ${invoiceId} has no approved amount`);
  if (i.paid_cents !== approved) throw new RangeError(`payment ${i.paid_cents} ≠ approved ${approved} for invoice ${invoiceId} (the rules' approval is the payable amount)`);
  if (i.dra_hold === true) throw new RangeError(`invoice ${invoiceId} is held pending DRA reconciliation of the milestone (policy; never beyond the 30-day SLA once evidenced)`);
  const borrowerChargeable = (i.invoice.borrower_chargeable_cents as Cents | undefined) ?? fee + costs;   // 2.7 caps / 14.x apply upstream; the technology fee is never the borrower's (E-5-06)
  const loanId = typeof i.invoice.loan_id === "string" ? i.invoice.loan_id : null;
  return { row: { status: "paid", paid_at: i.paid_on, paid_amount_cents: i.paid_cents, payment_ref: i.payment_ref, claimable_cents: approved, borrower_chargeable_cents: borrowerChargeable }, advance: { loan_id: loanId, claim_eligible_cents: fee + costs, tech_fee_cents: tech, borrower_chargeable_cents: borrowerChargeable }, escalations: [], events: [
    { type: "firm.invoice.paid", aggregate: invoiceAggregate(invoiceId), payload: { invoice_id: invoiceId, matter_id: i.invoice.matter_id, loan_id: loanId, firm_id: i.invoice.firm_id, paid_on: i.paid_on, paid_cents: i.paid_cents, payment_ref: i.payment_ref, claim_eligible_cents: fee + costs, tech_fee_cents: tech, borrower_chargeable_cents: borrowerChargeable, rail: "nacha_ccd" } }] };
}

// ============================================================ DRA reconciliation (rule 6)
export interface DraRow { readonly loan_id: string; readonly event_name: string; readonly event_date: PlainDate; readonly entered_by_firm: string | null }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function draSnapshotImported(i: { snapshot_id: string; firm_id: string | null; as_of: PlainDate; source: "portal_export" | "manual"; rows: readonly Row[] }): OpResult & { dra_rows: DraRow[] } {
  const id = nonEmpty(i.snapshot_id, "snapshot_id"); const source = oneOf(i.source, ["portal_export", "manual"], "source");
  const rows: DraRow[] = i.rows.map((r, n) => { const loan = nonEmpty(r.loan_id, `rows[${n}].loan_id`), name = nonEmpty(r.event_name, `rows[${n}].event_name`).toLowerCase(); const d = typeof r.event_date === "string" ? r.event_date.slice(0, 10) : ""; if (!ISO_DATE.test(d)) throw new RangeError(`rows[${n}].event_date must be an ISO date`); return { loan_id: loan, event_name: name, event_date: d as PlainDate, entered_by_firm: typeof r.entered_by_firm === "string" ? r.entered_by_firm : null }; });
  return { row: { snapshot_id: id, firm_id: i.firm_id, as_of: i.as_of, source, row_count: rows.length, imported_at: i.as_of }, dra_rows: rows, escalations: [], events: [{ type: "dra.snapshot.imported", ...(i.firm_id ? { aggregate: firmAggregate(i.firm_id) } : {}), payload: { snapshot_id: id, firm_id: i.firm_id, as_of: i.as_of, source, rows: rows.length } }] };
}
export interface DraExpectation { readonly matter_id: string; readonly loan_id: string; readonly instruction: string; readonly expected_event: string; readonly event_date: PlainDate; readonly expected_by: PlainDate; readonly matched_on: PlainDate | null }
export interface DraReconciliation { readonly matched: { matter_id: string; loan_id: string; expected_event: string; dra_event_date: PlainDate; difference_days: number }[]; readonly exceptions: { matter_id: string; loan_id: string; expected_event: string; expected_by: PlainDate; found: boolean; difference_days: number | null; reason: "missing" | "late" | "inconsistent" }[]; readonly events: EmittedEvent[]; readonly escalations: { loan_id: string; matter_id: string; escalation: Escalation }[] }
/** Rule 6: an expected event is matched when DRA shows it within a day of the internal date; missing after 2 BD or inconsistent (> 1 day) raises the exception, the firm-call task and marks the 13.5 credit "DRA unverified". */
export function reconcileDra(i: { expectations: readonly DraExpectation[]; dra_rows: readonly DraRow[]; today: PlainDate }): DraReconciliation {
  const matched: DraReconciliation["matched"] = [], exceptions: DraReconciliation["exceptions"] = [], events: EmittedEvent[] = [], escalations: DraReconciliation["escalations"] = [];
  for (const x of i.expectations) {
    if (x.matched_on) continue;
    const hit = i.dra_rows.filter((r) => r.loan_id === x.loan_id && r.event_name === x.expected_event.toLowerCase()).sort((a, b) => Math.abs(daysBetween(x.event_date, a.event_date)) - Math.abs(daysBetween(x.event_date, b.event_date)))[0] ?? null;
    if (hit && !draEventLate(x.event_date, hit.event_date, i.today)) {
      const diff = daysBetween(x.event_date, hit.event_date); matched.push({ matter_id: x.matter_id, loan_id: x.loan_id, expected_event: x.expected_event, dra_event_date: hit.event_date, difference_days: diff });
      events.push({ type: "dra.event.matched", loan_id: x.loan_id, payload: { matter_id: x.matter_id, instruction: x.instruction, expected_event: x.expected_event, expected_by: x.expected_by, dra_event_date: hit.event_date, difference_days: diff, entered_by_firm: hit.entered_by_firm, matched_on: i.today } });
      continue;
    }
    if (!hit && i.today <= x.expected_by) continue;   // still inside the 2-BD window
    const reason = hit ? "inconsistent" : i.today > x.expected_by ? "missing" : "late"; const diff = hit ? daysBetween(x.event_date, hit.event_date) : null;
    exceptions.push({ matter_id: x.matter_id, loan_id: x.loan_id, expected_event: x.expected_event, expected_by: x.expected_by, found: hit !== null, difference_days: diff, reason });
    events.push({ type: "dra.exception.raised", loan_id: x.loan_id, payload: { matter_id: x.matter_id, instruction: x.instruction, expected_event: x.expected_event, expected_by: x.expected_by, found: hit !== null, difference_days: diff, reason, credit_status: "DRA unverified", firm_call_task: true, raised_on: i.today } });
    escalations.push({ loan_id: x.loan_id, matter_id: x.matter_id, escalation: { kind: "human_agent", severity: "sev3", reason: `DRA shows no "${x.expected_event}" for ${x.instruction} by ${x.expected_by} (${reason}) — call the firm; 13.5 credit marked "DRA unverified"` } });
  }
  return { matched, exceptions, events, escalations };
}
