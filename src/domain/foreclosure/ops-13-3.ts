/**
 * §13.3 operating rules over the pure calculators in ./ops.ts and ./referral.ts — the referral lifecycle that arms
 * and satisfies the 13.3 timer rows (timers-13-3.ts / ../timers.ts) by validating each inbound record or servicer act
 * and appending the event the row names (a bare literal never stands in for an emitter):
 *
 *   referralEligible          all gates open ∧ review `refer`         → `foreclosure.referral.eligible{eligibility_date}`
 *                                                                        (arms SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE, policy 5 cd)
 *   sendReferralPackage       `foreclosure.refer` with the E-1.1-02 manifest → `foreclosure.referral.sent{sent_at, package_manifest}`
 *                                                                        (arms FNMA_E3205_FIRM_ACK_2BD; satisfies the 5-cd SLA and E-1.2-02 day-121 gate)
 *   ingestFirmAck             attorney-network ACK{complete, missing[]} → `firm.referral.acknowledged{complete}` + `foreclosure.referral.acknowledged`;
 *                                                                        an incomplete ACK is also the firm's document request (E-3.2-05 "missing items within 3 BD")
 *   ingestFirmDocumentRequest DOCUMENT_REQUEST                          → `firm.document.requested{request}` (arms FNMA_E3205_MISSING_DOCS_3BD)
 *   sendDocumentsToFirm       outbound DOCUMENTS with SHA-256 manifest   → `attorney.documents.sent` (satisfies it)
 *   documentRequestBreach     3 BD lapse                                 → sev-1 escalation + `comp_fee_exposure.flagged{kind=missing_documents}` (13.3-T8)
 *   ingestFirmAdvanceRequest  ADVANCE_REQUEST{amount}                    → `firm.advance.requested{request}` (arms FNMA_E3205_ADVANCE_REQUEST_10BD)
 *   decideAdvanceRequest      funded / declined                          → `attorney.advance.decided{result}` (satisfies it)
 *   ingestFirmSaleScheduled   SALE_SCHEDULED{date}                       → `foreclosure.sale.scheduled{sale_at, outreach_stop_on, method}` — the sale-anchored
 *                                                                        rows (E-3.2-06 outreach stop, E-3.3-01 review −30, E-3.3-03 inspection −35,
 *                                                                        E-3.3-05 valuation −90 / reserve −90..−30, E-3.2-05 bid −5 BD) arm here
 *   closeOutreachCampaign     11.x campaign closed for sale proximity    → `outreach.campaign.closed{reason=sale_proximity}`
 *   sendStatePreForeclosureNotice  statutory NTC_STATE_PREFC_* mailing  → `notice.sent{template, channels, mailed_on}` (NY: arms the §1306 3-BD clock;
 *                                                                        NJ: arms the 180-day FFA staleness clock)
 *   recordStateFiling         NY DFS §1306 portal receipt                → `state.filing.completed{kind=ny_dfs_1306}`
 *   ingestFirmMilestone       MILESTONE{code}                            → `foreclosure.milestone.recorded{code}`; first-legal codes also
 *                                                                        `foreclosure.first_notice.filed` (closes the NJ NOI clock), JUDGMENT_ENTERED → `foreclosure.judgment.entered`
 *   completePresaleReview     E-3.3-01 review                            → `foreclosure.presale_review.completed{result}`
 *   recordPresaleInspection   E-3.3-03 inspection                        → `inspection.completed{presale}` (presale only inside the 35-day window);
 *                                                                        major uninsured damage ⇒ no bid, Servicing Representative contact task (13.3-T11)
 *   orderValuation / ingestValuationResult   E-3.3-05 valuation          → `fnma.valuation.ordered` (no earlier than sale −90) / `fnma.valuation.result.received`
 *   requestReservePrice / ingestReservePrice E-3.3-05 reserve price       → `fnma.reserve_price.requested` (−90..−30 window) / `fnma.reserve_price.received{unexpired}`
 *   recordSaleCompleted       E-3.5-02 completion (later of sale / confirmation) → `foreclosure.sale.completed{insurance_cancel_anchor_on}` (arms FNMA_E3502_INSURANCE_CANCEL_14)
 *   reinstatementTendered     E-3.2-08 full tender before the sale       → `loan.reinstated`, `foreclosure.sale.cancelled{reason=reinstated}`, `note.returned{form=Form 2009}` (13.3-T7)
 *
 * Dates are PlainDate; money in payloads is the cents string of a bigint; nothing here reads a store unless one is
 * handed in (the rows of the 13.3 data model are written when it is).
 */
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { referralEligible as eligible, type Gates, firmAckDue } from "./referral.ts";
import { referralPackage, firmDocumentRequest, preSaleInspectionStop, reinstatementAccepted, reserveFallback, type Escalation } from "./ops.ts";

type Row = Record<string, unknown>;
export interface LifecycleRecord { readonly id: string; readonly data: Row }
/** The slice of src/app/tools.ts `EntityStore` the lifecycle writes (structural; optional). */
export interface LifecycleStore { get(kind: string, id: string): LifecycleRecord | undefined; put(kind: string, id: string, data: Row, by: Actor, now: string): LifecycleRecord }
export interface LifecycleEscalations { open(input: { kind: "officer" | "attorney" | "human_agent" | "human_portal_task" | "sev1" | "sev2" | "sev3"; loanId?: string; caseId?: string; severity?: string; payload?: Row }, by: Actor): { id: string } }
export interface LifecycleDeps { readonly events: EventStore; readonly clock: { now(): string }; readonly actor?: Actor; readonly store?: LifecycleStore; readonly escalations?: LifecycleEscalations }

export const LIFECYCLE_ACTOR: Actor = { kind: "agent", id: "foreclosure-ops" };
export const REFERRAL_SLA_DAYS = 5;                       // decision 13.3-4: internal SLA after eligibility (principal residences)
export const FIRM_DOCS_BD = 3;                            // E-3.2-05 / E-1.1-02
export const ADVANCE_DECISION_BD = 10;                    // E-3.2-05
export const NY_1306_FILING_BD = 3;                       // RPAPL §1306
export const NJ_NOI_STALE_DAYS = 180;                     // N.J.S.A. 2A:50-56 (30–180 days before filing)
export const NJ_NOI_MIN_DAYS = 30;
export const PRESALE_REVIEW_DAYS = 30;                    // E-3.3-01
export const PRESALE_INSPECTION_DAYS = 35;                // E-3.3-03
export const VALUATION_ORDER_DAYS = 90;                   // E-3.3-05
export const VALUATION_RESULT_DAYS = 10;
export const RESERVE_WINDOW = { open_days: 90, close_days: 30 } as const;   // E-3.3-05
export const BID_INSTRUCTIONS_BD = 5;                     // E-3.2-05
export const INSURANCE_CANCEL_DAYS = 14;                  // E-3.5-02
export const OUTREACH_STOP_DAYS = { judicial: 60, non_judicial: 30 } as const;   // E-3.2-06
export const RESERVE_REASON_CODE = "Reserve Price Bid Instructions";
export const METHODS = ["judicial", "non_judicial", "court_supervised"] as const;
export type Method = (typeof METHODS)[number];
export const STATE_PREFC_TEMPLATES = ["NTC_STATE_PREFC_NY_1304", "NTC_STATE_PREFC_NJ_NOI", "NTC_STATE_PREFC_MA_35A", "NTC_STATE_PREFC_TX_51002D", "NTC_STATE_PREFC_MD_NOI", "NTC_STATE_PREFC_CA_2923_5_LETTER", "NTC_STATE_PREFC_WA_61_24_031_LETTER", "NTC_STATE_PREFC_NV_107_5XX", "NTC_STATE_PREFC_GA_162_2"] as const;
/** Statutes that require certified *and* first-class mailing (RPAPL §1304; N.J.S.A. 2A:50-56 certified RRR; M.G.L. c.244 §35A; Md. RP §7-105.1). */
export const CERTIFIED_AND_FIRST_CLASS = new Set<string>(["NTC_STATE_PREFC_NY_1304", "NTC_STATE_PREFC_NJ_NOI", "NTC_STATE_PREFC_MA_35A", "NTC_STATE_PREFC_MD_NOI"]);
export const NY_MIN_AGENCIES = 5;
export const MILESTONE_CODES = ["REFERRAL_RECEIVED", "TITLE_ORDERED", "TITLE_REVIEWED", "FIRST_LEGAL", "NOD_RECORDED", "COMPLAINT_FILED", "SERVICE_COMPLETE", "NOS_ISSUED", "JUDGMENT_MOTION_FILED", "JUDGMENT_ENTERED", "SALE_SCHEDULED", "SALE_POSTPONED", "SALE_HELD", "CONFIRMATION", "DEED_RECORDED"] as const;
/** The codes that are the state's first legal action (complaint / NOD / NOS): `foreclosure.first_notice.filed`. */
export const FIRST_LEGAL_CODES = new Set<string>(["FIRST_LEGAL", "NOD_RECORDED", "COMPLAINT_FILED", "NOS_ISSUED"]);
export const MILESTONE_SOURCES = ["firm", "dra", "court", "servicer"] as const;
export const STATE_FILINGS = ["ny_dfs_1306"] as const;

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const requireDate = (v: unknown, name: string): PlainDate => { if (typeof v !== "string" || !dateRe.test(v)) throw new RangeError(`${name} must be a PlainDate (YYYY-MM-DD)`); return v as PlainDate; };
const requireId = (v: unknown, name: string): string => { if (typeof v !== "string" || v.trim() === "") throw new RangeError(`${name} is required`); return v; };
const money = (c: Cents): string => c.toString();

export interface Refused { readonly ok: false; readonly refusal: string; readonly event: null }
export interface Emitted<T extends Row = Row> { readonly ok: true; readonly refusal: null; readonly event: DomainEvent; readonly facts: T }

/** Sale-anchored dates the E-3.x rows key on, computed once from the firm's sale date. */
export function saleAnchors(saleAt: PlainDate, method: Method): { outreach_stop_on: PlainDate; presale_review_due: PlainDate; inspection_window_opens: PlainDate; valuation_order_opens: PlainDate; reserve_window_opens: PlainDate; reserve_window_closes: PlainDate; bid_instructions_due: PlainDate } {
  return {
    outreach_stop_on: addDays(saleAt, -(method === "non_judicial" ? OUTREACH_STOP_DAYS.non_judicial : OUTREACH_STOP_DAYS.judicial)),   // court-supervised (MD order to docket) is a court proceeding: 60
    presale_review_due: addDays(saleAt, -PRESALE_REVIEW_DAYS),
    inspection_window_opens: addDays(saleAt, -PRESALE_INSPECTION_DAYS),
    valuation_order_opens: addDays(saleAt, -VALUATION_ORDER_DAYS),
    reserve_window_opens: addDays(saleAt, -RESERVE_WINDOW.open_days),
    reserve_window_closes: addDays(saleAt, -RESERVE_WINDOW.close_days),
    bid_instructions_due: addBusinessDays(saleAt, -BID_INSTRUCTIONS_BD, servicer),
  };
}

export class ReferralLifecycle {
  private readonly d: LifecycleDeps;
  constructor(d: LifecycleDeps) { this.d = d; }
  private get actor(): Actor { return this.d.actor ?? LIFECYCLE_ACTOR; }
  private emit(type: string, loanId: string, caseId: string | null, payload: Row, causationId?: string): DomainEvent {
    return this.d.events.append({ type, loanId, ...(caseId ? { aggregate: { kind: "case", id: caseId } } : {}), actor: this.actor, ...(causationId ? { causationId } : {}), payload: { loan_id: loanId, ...(caseId ? { case_id: caseId } : {}), ...payload } });
  }
  private put(kind: string, id: string, data: Row): void { this.d.store?.put(kind, id, data, this.actor, this.d.clock.now()); }

  // ============================================================ eligibility and referral (SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE, FNMA_E3205_FIRM_ACK_2BD)
  /** Rule 1: 13.4 review `refer` ∧ every `refer` gate open ⇒ eligible today; the internal SLA (decision 13.3-4) runs 5 calendar days from `eligibility_date`. */
  referralEligible(i: { loan_id: string; case_id?: string | null; review_outcome: Parameters<typeof eligible>[0]; gates: Gates; today: PlainDate; principal_residence: boolean }): Emitted<{ eligibility_date: PlainDate; refer_by: PlainDate }> | (Refused & { blocked_by: string[] }) {
    const r = eligible(i.review_outcome, i.gates);
    if (!r.ok) return { ok: false, refusal: `not eligible for referral: ${r.blocked_by.join(", ")} (13.3 rule 1)`, event: null, blocked_by: r.blocked_by };
    const referBy = addDays(i.today, REFERRAL_SLA_DAYS);
    const event = this.emit("foreclosure.referral.eligible", i.loan_id, i.case_id ?? null, { eligibility_date: i.today, refer_by: referBy, principal_residence: i.principal_residence, review_outcome: i.review_outcome, sla: "SM_FC_REFER_WITHIN_5CD_OF_ELIGIBLE" });
    return { ok: true, refusal: null, event, facts: { eligibility_date: i.today, refer_by: referBy } };
  }

  /** `foreclosure.refer` (E-1.2-02): the package with its E-1.1-02 manifest hashes goes to the retained firm; `referral_sent_at` is the referral date; status 43 queued; the firm's acknowledgment is due in 2 BD. */
  sendReferralPackage(i: { loan_id: string; case_id: string; firm_id: string; referral_on: PlainDate; day: number; principal_residence: boolean; review_outcome: string; documents: readonly { id: string; sha256: string }[]; data_snapshot?: Row }): Emitted<{ referral_id: string; referral_sent_at: PlainDate; firm_ack_due: PlainDate; status_code: "43" }> | Refused {
    requireId(i.firm_id, "firm_id"); requireId(i.case_id, "case_id");
    if (i.documents.some((doc) => !doc.id || !/^[0-9a-f]+$/i.test(doc.sha256))) return { ok: false, refusal: "every package document needs an id and a hex SHA-256 (E-1.1-02 manifest)", event: null };
    const p = referralPackage({ referral_on: i.referral_on, day: i.day, principal_residence: i.principal_residence, review_outcome: i.review_outcome, documents: i.documents });
    if (!p.allowed) return { ok: false, refusal: p.refusal ?? "referral refused", event: null };
    const referralId = `ref-${i.case_id}-${i.referral_on}`;
    this.put("attorney_referrals", referralId, { case_id: i.case_id, loan_id: i.loan_id, firm_id: i.firm_id, package_manifest: p.manifest, data_snapshot: i.data_snapshot ?? {}, sent_at: i.referral_on, ack_at: null, ack_complete: null, missing_items: null });
    this.put("foreclosure_cases", i.case_id, { case_id: i.case_id, loan_id: i.loan_id, firm_id: i.firm_id, referral_sent_at: i.referral_on, status: "referred", principal_residence: i.principal_residence });
    const event = this.emit("foreclosure.referral.sent", i.loan_id, i.case_id, { referral_id: referralId, firm_id: i.firm_id, sent_at: i.referral_on, referral_sent_at: p.referral_sent_at, regx_day: i.day, principal_residence: i.principal_residence, package_manifest: p.manifest, fnma_owns_or_securitizes: true, first_notice_authorized: false, status_code_queued: p.status_code, firm_ack_due: p.firm_ack_due });
    return { ok: true, refusal: null, event, facts: { referral_id: referralId, referral_sent_at: p.referral_sent_at, firm_ack_due: p.firm_ack_due, status_code: p.status_code } };
  }

  /** Inbound ACK{complete, missing[]} (Integrations): the firm's acknowledgment closes the 2-BD clock; an incomplete ACK lists the missing items and is at once the firm's document request (edge case: "missing items due in 3 BD; the referral date stands"). */
  ingestFirmAck(i: { loan_id: string; case_id: string; referral_id: string; firm_id: string; acknowledged_on: PlainDate; complete: boolean; missing?: readonly string[]; message_seq?: number | null; sent_at?: PlainDate | null }): (Emitted<{ ack_due: PlainDate | null; on_time: boolean | null; document_request: DomainEvent | null }> & { events: DomainEvent[] }) | Refused {
    requireId(i.firm_id, "firm_id"); requireId(i.referral_id, "referral_id"); requireDate(i.acknowledged_on, "acknowledged_on");
    const missing = [...(i.missing ?? [])];
    if (!i.complete && missing.length === 0) return { ok: false, refusal: "an incomplete ACK must list the missing items (E-3.2-05)", event: null };
    if (i.complete && missing.length > 0) return { ok: false, refusal: "a complete ACK cannot list missing items", event: null };
    const due = i.sent_at ? firmAckDue(i.sent_at) : null;
    const base = { referral_id: i.referral_id, firm_id: i.firm_id, acknowledged_on: i.acknowledged_on, complete: i.complete, missing, message_seq: i.message_seq ?? null, ack_due: due, on_time: due ? i.acknowledged_on <= due : null };
    const event = this.emit("firm.referral.acknowledged", i.loan_id, i.case_id, base);
    const canonical = this.emit("foreclosure.referral.acknowledged", i.loan_id, i.case_id, base, event.id);
    this.put("attorney_referrals", i.referral_id, { ack_at: i.acknowledged_on, ack_complete: i.complete, missing_items: missing });
    this.put("foreclosure_cases", i.case_id, { referral_ack_at: i.acknowledged_on, status: "acknowledged" });
    const events = [event, canonical];
    let documentRequest: DomainEvent | null = null;
    if (!i.complete) { const r = this.ingestFirmDocumentRequest({ loan_id: i.loan_id, case_id: i.case_id, firm_id: i.firm_id, request_id: `${i.referral_id}-ack-missing`, items: missing, requested_on: i.acknowledged_on }); if (r.ok) { documentRequest = r.event; events.push(r.event); } }
    return { ok: true, refusal: null, event, events, facts: { ack_due: due, on_time: base.on_time, document_request: documentRequest } };
  }

  // ============================================================ firm document requests (FNMA_E3205_MISSING_DOCS_3BD)
  /** Inbound DOCUMENT_REQUEST: the servicer supplies the items within 3 BD (E-3.2-05; E-1.1-02 "within three business days"). */
  ingestFirmDocumentRequest(i: { loan_id: string; case_id: string; firm_id: string; request_id: string; items: readonly string[]; requested_on: PlainDate }): Emitted<{ due_on: PlainDate }> | Refused {
    requireId(i.request_id, "request_id"); requireId(i.firm_id, "firm_id"); requireDate(i.requested_on, "requested_on");
    if (i.items.length === 0) return { ok: false, refusal: "a document request names at least one item", event: null };
    const due = addBusinessDays(i.requested_on, FIRM_DOCS_BD, servicer);
    const event = this.emit("firm.document.requested", i.loan_id, i.case_id, { request_id: i.request_id, firm_id: i.firm_id, items: [...i.items], request: i.requested_on, requested_on: i.requested_on, due_on: due, message: "DOCUMENT_REQUEST" });
    this.put("firm_document_requests", i.request_id, { loan_id: i.loan_id, case_id: i.case_id, firm_id: i.firm_id, items: [...i.items], requested_on: i.requested_on, due_on: due, fulfilled_on: null });
    return { ok: true, refusal: null, event, facts: { due_on: due } };
  }
  /** Outbound DOCUMENTS message with a SHA-256 manifest answers the request. */
  sendDocumentsToFirm(i: { loan_id: string; case_id: string; firm_id: string; request_id: string; documents: readonly { id: string; sha256: string }[]; sent_on: PlainDate; requested_on?: PlainDate | null }): Emitted<{ on_time: boolean | null }> | Refused {
    requireId(i.request_id, "request_id"); requireDate(i.sent_on, "sent_on");
    if (i.documents.length === 0 || i.documents.some((doc) => !doc.id || !/^[0-9a-f]+$/i.test(doc.sha256))) return { ok: false, refusal: "documents sent to the firm carry ids and hex SHA-256 hashes (E-1.1-02 manifest)", event: null };
    const due = i.requested_on ? addBusinessDays(i.requested_on, FIRM_DOCS_BD, servicer) : null;
    const onTime = due ? i.sent_on <= due : null;
    const event = this.emit("attorney.documents.sent", i.loan_id, i.case_id, { request_id: i.request_id, firm_id: i.firm_id, documents: i.documents.map((doc) => ({ id: doc.id, sha256: doc.sha256 })), sent_on: i.sent_on, due_on: due, on_time: onTime, message: "DOCUMENTS" });
    this.put("firm_document_requests", i.request_id, { fulfilled_on: i.sent_on });
    return { ok: true, refusal: null, event, facts: { on_time: onTime } };
  }
  /** 3 BD lapse without a response (13.3-T8): sev-1 escalation (indemnification / make-whole / comp-fee exposure, E-1.1-02) and the exposure flag for 13.5. */
  documentRequestBreach(i: { loan_id: string; case_id: string; request_id: string; requested_on: PlainDate; fulfilled_on: PlainDate | null; today: PlainDate }): { breached: boolean; due: PlainDate; escalation: Escalation | null; escalation_id: string | null; event: DomainEvent | null } {
    const r = firmDocumentRequest({ requested_on: i.requested_on, fulfilled_on: i.fulfilled_on, today: i.today });
    if (!r.breached) return { breached: false, due: r.due, escalation: null, escalation_id: null, event: null };
    const esc = this.d.escalations?.open({ kind: "sev1", loanId: i.loan_id, caseId: i.case_id, severity: "sev1", payload: { reason: r.escalation!.reason, request_id: i.request_id, due: r.due } }, this.actor) ?? null;
    const event = this.emit("comp_fee_exposure.flagged", i.loan_id, i.case_id, { kind: "missing_documents", request_id: i.request_id, due_on: r.due, flagged_on: i.today, escalation_id: esc?.id ?? null, severity: "sev1" });
    return { breached: true, due: r.due, escalation: r.escalation, escalation_id: esc?.id ?? null, event };
  }

  // ============================================================ advance requests (FNMA_E3205_ADVANCE_REQUEST_10BD)
  /** Inbound ADVANCE_REQUEST{amount}: answered within 10 BD (E-3.2-05). */
  ingestFirmAdvanceRequest(i: { loan_id: string; case_id: string; firm_id: string; request_id: string; amount_cents: Cents; purpose: string; requested_on: PlainDate }): Emitted<{ due_on: PlainDate }> | Refused {
    requireId(i.request_id, "request_id"); requireId(i.firm_id, "firm_id"); requireDate(i.requested_on, "requested_on");
    if (typeof i.amount_cents !== "bigint" || i.amount_cents <= 0n) return { ok: false, refusal: "amount_cents must be a positive bigint", event: null };
    if (!i.purpose) return { ok: false, refusal: "purpose is required (what the advance funds)", event: null };
    const due = addBusinessDays(i.requested_on, ADVANCE_DECISION_BD, servicer);
    const event = this.emit("firm.advance.requested", i.loan_id, i.case_id, { request_id: i.request_id, firm_id: i.firm_id, amount: money(i.amount_cents), amount_cents: money(i.amount_cents), purpose: i.purpose, request: i.requested_on, requested_on: i.requested_on, due_on: due, message: "ADVANCE_REQUEST" });
    this.put("firm_advance_requests", i.request_id, { loan_id: i.loan_id, case_id: i.case_id, firm_id: i.firm_id, amount_cents: i.amount_cents, purpose: i.purpose, requested_on: i.requested_on, due_on: due, result: null });
    return { ok: true, refusal: null, event, facts: { due_on: due } };
  }
  /** The servicer funds (a corporate advance, 15.2 expense-claim tagged) or declines; either answers the clock. */
  decideAdvanceRequest(i: { loan_id: string; case_id: string; firm_id: string; request_id: string; result: "funded" | "declined"; decided_on: PlainDate; amount_cents?: Cents | null; reason?: string | null }): Emitted<{ result: "funded" | "declined" }> | Refused {
    requireId(i.request_id, "request_id"); requireDate(i.decided_on, "decided_on");
    if (i.result !== "funded" && i.result !== "declined") return { ok: false, refusal: "result must be funded or declined (E-3.2-05)", event: null };
    if (i.result === "funded" && (typeof i.amount_cents !== "bigint" || i.amount_cents <= 0n)) return { ok: false, refusal: "a funded advance carries the positive amount_cents funded", event: null };
    if (i.result === "declined" && !i.reason) return { ok: false, refusal: "a declined advance carries the reason", event: null };
    const event = this.emit("attorney.advance.decided", i.loan_id, i.case_id, { request_id: i.request_id, firm_id: i.firm_id, result: i.result, decided_on: i.decided_on, amount_cents: i.amount_cents ? money(i.amount_cents) : null, reason: i.reason ?? null, ...(i.result === "funded" ? { ledger: "corporate_advances", expense_claim_eligible: true } : {}) });
    this.put("firm_advance_requests", i.request_id, { result: i.result, decided_on: i.decided_on });
    return { ok: true, refusal: null, event, facts: { result: i.result } };
  }

  // ============================================================ sale scheduling (the sale-anchored E-3.x rows)
  /** Inbound SALE_SCHEDULED{date}: the firm's sale date anchors the outreach stop, pre-sale review, inspection, valuation, reserve-price and bid-instruction clocks; status 71 queued. */
  ingestFirmSaleScheduled(i: { loan_id: string; case_id: string; firm_id: string; sale_at: PlainDate; method: string; message_seq?: number | null; rescheduled_from?: PlainDate | null }): Emitted<ReturnType<typeof saleAnchors> & { sale_at: PlainDate; method: Method }> | Refused {
    requireId(i.firm_id, "firm_id"); requireDate(i.sale_at, "sale_at");
    if (!(METHODS as readonly string[]).includes(i.method)) return { ok: false, refusal: `method must be one of ${METHODS.join(", ")}`, event: null };
    const method = i.method as Method;
    const a = saleAnchors(i.sale_at, method);
    const type = i.rescheduled_from ? "foreclosure.sale.rescheduled" : "foreclosure.sale.scheduled";
    const payload = { firm_id: i.firm_id, sale_at: i.sale_at, scheduled_sale_date: i.sale_at, method, ...a, rescheduled_from: i.rescheduled_from ?? null, message_seq: i.message_seq ?? null, source: "firm", status_code_queued: "71" };
    const event = this.emit(type, i.loan_id, i.case_id, payload);
    // a reschedule re-anchors every sale-keyed clock: the platform arms them on `foreclosure.sale.scheduled` only
    const scheduled = i.rescheduled_from ? this.emit("foreclosure.sale.scheduled", i.loan_id, i.case_id, payload, event.id) : event;
    this.put("foreclosure_cases", i.case_id, { sale_scheduled_at: i.sale_at, method, status: "sale_scheduled" });
    return { ok: true, refusal: null, event: scheduled, facts: { sale_at: i.sale_at, method, ...a } };
  }
  /** 11.x closes the outreach campaign at sale −60 (judicial) / −30 (non-judicial) (E-3.2-06). */
  closeOutreachCampaign(i: { loan_id: string; case_id: string; campaign_id: string; closed_on: PlainDate; sale_at: PlainDate; method: string }): Emitted<{ outreach_stop_on: PlainDate; on_time: boolean }> | Refused {
    requireId(i.campaign_id, "campaign_id"); requireDate(i.closed_on, "closed_on");
    if (!(METHODS as readonly string[]).includes(i.method)) return { ok: false, refusal: `method must be one of ${METHODS.join(", ")}`, event: null };
    const stop = saleAnchors(i.sale_at, i.method as Method).outreach_stop_on;
    const event = this.emit("outreach.campaign.closed", i.loan_id, i.case_id, { campaign_id: i.campaign_id, reason: "sale_proximity", closed_on: i.closed_on, sale_at: i.sale_at, outreach_stop_on: stop, on_time: i.closed_on <= stop, consumer: "11.x" });
    return { ok: true, refusal: null, event, facts: { outreach_stop_on: stop, on_time: i.closed_on <= stop } };
  }

  // ============================================================ state pre-foreclosure notices (STATE_NY_RPAPL1306_DFS_FILING_3BD, STATE_NJ_FFA_NOI_STALE_180)
  /** A statutory NTC_STATE_PREFC_* mailing with its delivery evidence (mail-only; E-SIGN never substitutes for statutory certified mail). NY needs ≥5 county agencies (RPAPL §1304(2)) and certified + first-class; NJ certified RRR + first-class. */
  sendStatePreForeclosureNotice(i: { loan_id: string; case_id: string; template: string; state: string; mailed_on: PlainDate; channels: readonly { channel: string; tracking?: string | null; party_id?: string | null }[]; notice_id?: string | null; county_agencies?: readonly string[]; language?: string | null }): Emitted<{ s1306_due: PlainDate | null; noi_stale_on: PlainDate | null; first_notice_not_before: PlainDate | null }> | Refused {
    if (!(STATE_PREFC_TEMPLATES as readonly string[]).includes(i.template)) return { ok: false, refusal: `${i.template} is not a 13.3 state pre-foreclosure notice`, event: null };
    requireDate(i.mailed_on, "mailed_on");
    const kinds = new Set(i.channels.map((c) => c.channel));
    if ([...kinds].some((k) => !/^(certified_mail|first_class|registered_mail|overnight)$/.test(k))) return { ok: false, refusal: "statutory notices go by mail only (certified_mail, first_class, registered_mail, overnight)", event: null };
    if (CERTIFIED_AND_FIRST_CLASS.has(i.template) && !(kinds.has("certified_mail") && kinds.has("first_class"))) return { ok: false, refusal: `${i.template} requires certified and first-class mailing evidence`, event: null };
    if (kinds.has("certified_mail") && i.channels.some((c) => c.channel === "certified_mail" && !c.tracking)) return { ok: false, refusal: "certified mail carries its tracking number (proof of mailing)", event: null };
    if (i.template === "NTC_STATE_PREFC_NY_1304" && (i.county_agencies?.length ?? 0) < NY_MIN_AGENCIES) return { ok: false, refusal: `RPAPL §1304 lists at least ${NY_MIN_AGENCIES} housing counseling agencies for the county`, event: null };
    const s1306Due = i.template === "NTC_STATE_PREFC_NY_1304" ? addBusinessDays(i.mailed_on, NY_1306_FILING_BD, servicer) : null;
    const noiStale = i.template === "NTC_STATE_PREFC_NJ_NOI" ? addDays(i.mailed_on, NJ_NOI_STALE_DAYS) : null;
    const notBefore = i.template === "NTC_STATE_PREFC_NY_1304" ? addDays(i.mailed_on, 90) : i.template === "NTC_STATE_PREFC_NJ_NOI" ? addDays(i.mailed_on, NJ_NOI_MIN_DAYS) : null;
    const event = this.emit("notice.sent", i.loan_id, i.case_id, { template: i.template, notice_id: i.notice_id ?? null, state: i.state, statutory: true, kind: "state_prefc", mailed_on: i.mailed_on, sent_at: i.mailed_on, channels: i.channels.map((c) => ({ channel: c.channel, tracking: c.tracking ?? null, party_id: c.party_id ?? null, satisfies_timer: true })), county_agencies: i.county_agencies ? [...i.county_agencies] : null, language: i.language ?? null, s1306_due: s1306Due, noi_stale_on: noiStale, first_notice_not_before: notBefore });
    return { ok: true, refusal: null, event, facts: { s1306_due: s1306Due, noi_stale_on: noiStale, first_notice_not_before: notBefore } };
  }
  /** NY DFS §1306 filing receipt (decision 13.3-5: `human_portal_task{kind=ny_dfs_1306}` until a batch interface exists) — a condition precedent to the action. */
  recordStateFiling(i: { loan_id: string; case_id: string; kind: string; filed_on: PlainDate; receipt_id: string; mailed_on?: PlainDate | null }): Emitted<{ due: PlainDate | null; on_time: boolean | null }> | Refused {
    if (!(STATE_FILINGS as readonly string[]).includes(i.kind)) return { ok: false, refusal: `kind must be one of ${STATE_FILINGS.join(", ")}`, event: null };
    requireId(i.receipt_id, "receipt_id"); requireDate(i.filed_on, "filed_on");
    const due = i.mailed_on ? addBusinessDays(i.mailed_on, NY_1306_FILING_BD, servicer) : null;
    const onTime = due ? i.filed_on <= due : null;
    const event = this.emit("state.filing.completed", i.loan_id, i.case_id, { kind: i.kind, ny_dfs_1306: i.kind === "ny_dfs_1306", filed_on: i.filed_on, receipt_id: i.receipt_id, mailed_on: i.mailed_on ?? null, due_on: due, on_time: onTime, channel: "dfs_portal" });
    return { ok: true, refusal: null, event, facts: { due, on_time: onTime } };
  }

  // ============================================================ milestones (foreclosure.first_notice.filed closes STATE_NJ_FFA_NOI_STALE_180)
  /** Inbound MILESTONE{code} from the firm / DRA / court: the append-only `foreclosure_milestones` row plus the canonical event for the first legal action and judgment. */
  ingestFirmMilestone(i: { loan_id: string; case_id: string; firm_id: string; code: string; occurred_on: PlainDate; source: string; evidence_document_id?: string | null; first_notice_kind?: string | null }): (Emitted<{ first_notice_filed: boolean }> & { events: DomainEvent[] }) | Refused {
    if (!(MILESTONE_CODES as readonly string[]).includes(i.code) && !/^EVICTION_[A-Z_]+$/.test(i.code)) return { ok: false, refusal: `${i.code} is not a foreclosure milestone code (13.3 data model)`, event: null };
    if (!(MILESTONE_SOURCES as readonly string[]).includes(i.source)) return { ok: false, refusal: `source must be one of ${MILESTONE_SOURCES.join(", ")}`, event: null };
    requireDate(i.occurred_on, "occurred_on");
    const event = this.emit("foreclosure.milestone.recorded", i.loan_id, i.case_id, { firm_id: i.firm_id, code: i.code, occurred_on: i.occurred_on, source: i.source, evidence_document_id: i.evidence_document_id ?? null, reported_at: this.d.clock.now() });
    this.put("foreclosure_milestones", `${i.case_id}-${i.code}-${i.occurred_on}`, { case_id: i.case_id, loan_id: i.loan_id, code: i.code, occurred_on: i.occurred_on, source: i.source, evidence_document_id: i.evidence_document_id ?? null, reported_at: this.d.clock.now() });
    const events = [event];
    const firstLegal = FIRST_LEGAL_CODES.has(i.code);
    if (firstLegal) { events.push(this.emit("foreclosure.first_notice.filed", i.loan_id, i.case_id, { filed_on: i.occurred_on, first_notice_kind: i.first_notice_kind ?? i.code, source: i.source, evidence_document_id: i.evidence_document_id ?? null }, event.id)); this.put("foreclosure_cases", i.case_id, { first_notice_filed_at: i.occurred_on, first_notice_kind: i.first_notice_kind ?? i.code, status: "first_legal" }); }
    if (i.code === "JUDGMENT_ENTERED") { events.push(this.emit("foreclosure.judgment.entered", i.loan_id, i.case_id, { entered_on: i.occurred_on, source: i.source }, event.id)); this.put("foreclosure_cases", i.case_id, { judgment_entered_at: i.occurred_on, status: "judgment" }); }
    return { ok: true, refusal: null, event, events, facts: { first_notice_filed: firstLegal } };
  }

  // ============================================================ pre-sale review and inspection (FNMA_E3301_PRESALE_REVIEW_30, FNMA_E3303_PRESALE_INSPECTION_35)
  /** E-3.3-01: the review "at least 30 days prior to the scheduled foreclosure sale date" — gates re-evaluated, SCRA/BK scrub fresh, holds clear, bid basis in hand. */
  completePresaleReview(i: { loan_id: string; case_id: string; sale_at: PlainDate; completed_on: PlainDate; checks: { gates_open: boolean; scra_verified: boolean; bk_scrub_clear: boolean; holds_clear: boolean; bid_basis_ready: boolean } }): Emitted<{ result: "pass" | "hold"; failing: string[]; due_on: PlainDate; on_time: boolean }> {
    requireDate(i.sale_at, "sale_at"); requireDate(i.completed_on, "completed_on");
    const failing = Object.entries(i.checks).filter(([, v]) => v !== true).map(([k]) => k);
    const due = addDays(i.sale_at, -PRESALE_REVIEW_DAYS);
    const result = failing.length === 0 ? "pass" : "hold";
    const event = this.emit("foreclosure.presale_review.completed", i.loan_id, i.case_id, { sale_at: i.sale_at, completed_on: i.completed_on, due_on: due, on_time: i.completed_on <= due, result, failing, checks: { ...i.checks } });
    return { ok: true, refusal: null, event, facts: { result, failing, due_on: due, on_time: i.completed_on <= due } };
  }
  /** E-3.3-03: the inspection "within 35 days prior to foreclosure sale" — `presale` is true only inside that window; major uninsured damage ⇒ no bid and a Servicing Representative contact task (E-3.3-05; 13.3-T11). */
  recordPresaleInspection(i: { loan_id: string; case_id: string; inspection_id: string; sale_at: PlainDate; inspected_on: PlainDate; major_damage: boolean; insured: boolean; damage_kind?: string | null }): (Emitted<{ presale: boolean; window_opens: PlainDate; issue_bid: boolean; task_id: string | null }> & { events: DomainEvent[] }) | Refused {
    requireId(i.inspection_id, "inspection_id"); requireDate(i.sale_at, "sale_at"); requireDate(i.inspected_on, "inspected_on");
    const opens = addDays(i.sale_at, -PRESALE_INSPECTION_DAYS);
    const presale = i.inspected_on >= opens && i.inspected_on <= i.sale_at;
    const stop = preSaleInspectionStop({ major_damage: i.major_damage, insured: i.insured, ...(i.damage_kind ? { damage_kind: i.damage_kind } : {}) });
    const event = this.emit("inspection.completed", i.loan_id, i.case_id, { inspection_id: i.inspection_id, kind: "presale", presale, purpose: "presale", sale_at: i.sale_at, inspected_on: i.inspected_on, window_opens: opens, major_damage: i.major_damage, insured: i.insured, damage_kind: i.damage_kind ?? null, issue_bid: stop.issue_bid });
    const events = [event];
    let taskId: string | null = null;
    if (!stop.issue_bid) {
      taskId = this.d.escalations?.open({ kind: "human_agent", loanId: i.loan_id, caseId: i.case_id, severity: "sev2", payload: { task: stop.task!.kind, reason: stop.task!.reason, inspection_id: i.inspection_id, sale_at: i.sale_at, claim: "9.x" } }, this.actor)?.id ?? null;
      events.push(this.emit("foreclosure.sale.bid.withheld", i.loan_id, i.case_id, { inspection_id: i.inspection_id, reason: stop.task!.reason, task: stop.task!.kind, task_id: taskId }, event.id));
    }
    return { ok: true, refusal: null, event, events, facts: { presale, window_opens: opens, issue_bid: stop.issue_bid, task_id: taskId } };
  }

  // ============================================================ valuation and reserve price (FNMA_E3305_VALUATION_ORDER_WINDOW_90, FNMA_E3305_RESERVE_PRICE_WINDOW_30_90)
  /** E-3.3-05: the valuation is ordered through the servicing solutions system "as soon as it is aware of the foreclosure sale date, but no earlier than 90 days prior"; results within 10 calendar days. */
  orderValuation(i: { loan_id: string; case_id: string; order_id: string; sale_at: PlainDate; ordered_on: PlainDate }): Emitted<{ result_expected_by: PlainDate }> | Refused {
    requireId(i.order_id, "order_id"); requireDate(i.sale_at, "sale_at"); requireDate(i.ordered_on, "ordered_on");
    const opens = addDays(i.sale_at, -VALUATION_ORDER_DAYS);
    if (i.ordered_on < opens) return { ok: false, refusal: `valuation ordered ${i.ordered_on}, earlier than sale −90 (${opens}) — E-3.3-05 "no earlier than 90 days prior"`, event: null };
    const expected = addDays(i.ordered_on, VALUATION_RESULT_DAYS);
    const event = this.emit("fnma.valuation.ordered", i.loan_id, i.case_id, { order_id: i.order_id, sale_at: i.sale_at, ordered_on: i.ordered_on, window_opens: opens, result_expected_by: expected, channel: "fnma-smdu" });
    return { ok: true, refusal: null, event, facts: { result_expected_by: expected } };
  }
  /** Inbound valuation result (SMDU / portal fallback). */
  ingestValuationResult(i: { loan_id: string; case_id: string; order_id: string; received_on: PlainDate; value_cents: Cents; valuation_kind?: string | null }): Emitted<{ value_cents: Cents }> | Refused {
    requireId(i.order_id, "order_id"); requireDate(i.received_on, "received_on");
    if (typeof i.value_cents !== "bigint" || i.value_cents <= 0n) return { ok: false, refusal: "value_cents must be a positive bigint", event: null };
    const event = this.emit("fnma.valuation.result.received", i.loan_id, i.case_id, { order_id: i.order_id, received_on: i.received_on, value_cents: money(i.value_cents), valuation_kind: i.valuation_kind ?? null });
    return { ok: true, refusal: null, event, facts: { value_cents: i.value_cents } };
  }
  /** E-3.3-05: the reserve price is requested "between 30 and 90 days before the scheduled foreclosure sale date" with reason code "Reserve Price Bid Instructions". */
  requestReservePrice(i: { loan_id: string; case_id: string; request_id: string; sale_at: PlainDate; requested_on: PlainDate }): Emitted<{ window_opens: PlainDate; window_closes: PlainDate }> | Refused {
    requireId(i.request_id, "request_id"); requireDate(i.sale_at, "sale_at"); requireDate(i.requested_on, "requested_on");
    const opens = addDays(i.sale_at, -RESERVE_WINDOW.open_days), closes = addDays(i.sale_at, -RESERVE_WINDOW.close_days);
    if (i.requested_on < opens || i.requested_on > closes) return { ok: false, refusal: `reserve price requested ${i.requested_on}, outside the 30–90-day window (${opens}..${closes}) before the sale — E-3.3-05`, event: null };
    const event = this.emit("fnma.reserve_price.requested", i.loan_id, i.case_id, { request_id: i.request_id, sale_at: i.sale_at, requested_on: i.requested_on, window_opens: opens, window_closes: closes, reason_code: RESERVE_REASON_CODE, channel: "fnma-smdu" });
    return { ok: true, refusal: null, event, facts: { window_opens: opens, window_closes: closes } };
  }
  /** Inbound reserve price with its expiry: `unexpired` is measured against the sale date — an expired reserve satisfies nothing and the bid falls back to total indebtedness (`reserveFallback`, 13.3-T10). */
  ingestReservePrice(i: { loan_id: string; case_id: string; request_id: string; sale_at: PlainDate; reserve_cents: Cents; expires_on: PlainDate; received_on: PlainDate }): Emitted<{ unexpired: boolean }> | Refused {
    requireId(i.request_id, "request_id"); requireDate(i.sale_at, "sale_at"); requireDate(i.expires_on, "expires_on"); requireDate(i.received_on, "received_on");
    if (typeof i.reserve_cents !== "bigint" || i.reserve_cents <= 0n) return { ok: false, refusal: "reserve_cents must be a positive bigint", event: null };
    const unexpired = i.expires_on >= i.sale_at;
    const event = this.emit("fnma.reserve_price.received", i.loan_id, i.case_id, { request_id: i.request_id, sale_at: i.sale_at, reserve_cents: money(i.reserve_cents), reserve_price_cents: money(i.reserve_cents), expires_on: i.expires_on, received_on: i.received_on, unexpired });
    return { ok: true, refusal: null, event, facts: { unexpired } };
  }
  /** The bid basis at the sale (E-3.3-05): an unexpired reserve or total indebtedness — the decision record's rationale explains a fallback. */
  bidBasis(i: { reserve_cents: Cents | null; reserve_expires_on: PlainDate | null; sale_on: PlainDate; refresh_available_by: PlainDate | null; total_indebtedness_cents: Cents; insurance_claims_cents?: Cents }): ReturnType<typeof reserveFallback> { return reserveFallback(i); }

  // ============================================================ sale completion (FNMA_E3502_INSURANCE_CANCEL_14)
  /** E-3.5-02: insurance is cancelled within 14 days of the later of sale completion or confirmation — the clock anchors on that later date, so a sale in a confirmation state is "completed" here only once confirmed. */
  recordSaleCompleted(i: { loan_id: string; case_id: string; sale_on: PlainDate; completed_on: PlainDate; outcome: "fnma_acquired" | "third_party"; confirmation_required: boolean; confirmed_on?: PlainDate | null }): Emitted<{ insurance_cancel_anchor_on: PlainDate; insurance_cancel_by: PlainDate }> | Refused {
    requireDate(i.sale_on, "sale_on"); requireDate(i.completed_on, "completed_on");
    if (i.outcome !== "fnma_acquired" && i.outcome !== "third_party") return { ok: false, refusal: "outcome must be fnma_acquired or third_party", event: null };
    if (i.confirmation_required && !i.confirmed_on) return { ok: false, refusal: "the sale completes on confirmation/ratification in this state — record it once confirmed (E-3.5-02 'later of')", event: null };
    if (i.completed_on < i.sale_on) return { ok: false, refusal: "completed_on precedes the sale", event: null };
    const anchor = i.confirmed_on && i.confirmed_on > i.completed_on ? i.confirmed_on : i.completed_on;
    const by = addDays(anchor, INSURANCE_CANCEL_DAYS);
    const event = this.emit("foreclosure.sale.completed", i.loan_id, i.case_id, { sale_on: i.sale_on, completed_on: i.completed_on, confirmed_on: i.confirmed_on ?? null, outcome: i.outcome, event: anchor, insurance_cancel_anchor_on: anchor, insurance_cancel_by: by, inspections_continue_until: by });
    this.put("foreclosure_cases", i.case_id, { sale_held_at: i.sale_on, sale_outcome: i.outcome, confirmation_at: i.confirmed_on ?? null, status: "post_sale" });
    return { ok: true, refusal: null, event, facts: { insurance_cancel_anchor_on: anchor, insurance_cancel_by: by } };
  }

  // ============================================================ reinstatement (E-3.2-08; 13.3-T7)
  /** A full tender before the sale is accepted: `loan.reinstated`, the firm's CANCEL_SALE instruction within 2 BD (target same day), the sale cancelled, the original note returned via Form 2009 when it was pulled. */
  reinstatementTendered(i: { loan_id: string; case_id: string; firm_id: string; tendered_on: PlainDate; sale_on: PlainDate; quote_cents: Cents; tendered_cents: Cents; note_pulled: boolean }): (Emitted<ReturnType<typeof reinstatementAccepted>> & { events: DomainEvent[] }) | (Refused & { decision: ReturnType<typeof reinstatementAccepted> }) {
    requireId(i.firm_id, "firm_id"); requireDate(i.tendered_on, "tendered_on"); requireDate(i.sale_on, "sale_on");
    const r = reinstatementAccepted({ tendered_on: i.tendered_on, sale_on: i.sale_on, quote_cents: i.quote_cents, tendered_cents: i.tendered_cents, note_pulled: i.note_pulled });
    if (!r.accepted) return { ok: false, refusal: r.refusal ?? "reinstatement refused", event: null, decision: r };
    const event = this.emit("loan.reinstated", i.loan_id, i.case_id, { firm_id: i.firm_id, reinstated_on: i.tendered_on, sale_on: i.sale_on, days_before_sale: daysBetween(i.tendered_on, i.sale_on), quote_cents: money(i.quote_cents), tendered_cents: money(i.tendered_cents), firm_notify_by: r.firm_notify_by, firm_notify_target: r.firm_notify_target, status_code_update: "F-1-21" });
    const events = [event,
      this.emit("foreclosure.sale.cancelled", i.loan_id, i.case_id, { reason: "reinstated", sale_on: i.sale_on, cancelled_on: i.tendered_on, instruction: r.instruction }, event.id),
      this.emit("foreclosure.case.closed", i.loan_id, i.case_id, { reason: "closed_reinstated", closed_on: i.tendered_on }, event.id)];
    if (r.note_return) events.push(this.emit("note.returned", i.loan_id, i.case_id, { form: r.note_return, requested_on: i.tendered_on, custodian: "document_custodian" }, event.id));
    this.put("foreclosure_cases", i.case_id, { status: "closed_reinstated", sale_scheduled_at: null });
    return { ok: true, refusal: null, event, events, facts: r };
  }
}
