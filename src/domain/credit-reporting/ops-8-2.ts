/**
 * §8.2 dispute handling — the operating layer over ./disputes.ts (clocks, reviewer conditions, CCC lifecycle,
 * corrections fan-out): the 15-minute ACDV poll and per-control-number ingest, direct-dispute intake (written,
 * oral, NoE-linked, complaint/attorney/CFPB), supplementation (extend to 45 / new case), the human-made
 * frivolous determination, evidence rows and the reasonable-investigation guards (rule 3), reviewer requests and
 * actions (the eight conditions), the response payload from the 8.1 snapshot logic (rule 4), the
 * `credit.dispute.responded` fan-out with AUDs to every other bureau through the e-OSCAR port (rule 5), the
 * results / frivolous / acknowledgment letters through the Notice Registry (rule 8), close with the CCC
 * transition (rule 6), the due-date watch (80 % / 90 % escalations and the best-available response at the due
 * date — never RESOLVED-NORESPONSEPROVIDED), the API-outage fallback (a `human_agent` web-app task carrying the
 * response payload), the identity-theft block path (8.2-T9) and the XB gate assertion the 8.1 render runs.
 *
 * Every event named in src/domain/credit-reporting/timers-8-2.ts is appended here — by the 8.2 tools in
 * src/app/tools/section08.ts calling these functions, or by the scheduler / ingestion entry points below:
 *
 *   schedule.tick{cadence=every_15_minutes, job}            eoscar.poll.succeeded{found, ingested} · eoscar.poll.failed{consecutive_failures} · eoscar.poll.alarm
 *   credit.dispute.acdv.received{control_number, bureau, received_at, response_due_on, cra_received_at, cra_outer_bound_on, …}
 *   credit.dispute.received{dispute_id, source, received_at, ccc=XB, ccc_via}   (every channel — the XB gate trigger)
 *   credit.dispute.acdv.viewed{control_number}   credit.dispute.evidence.recorded{evidence}   credit.dispute.investigated{determination, confidence}
 *   credit.dispute.review_requested{approver, conditions, requested_at}   credit.dispute.reviewed{reviewer_id, action}
 *   credit.dispute.acdv.responded{control_number, response_code, determination, submitted_at, eoscar_status}
 *   credit.dispute.responded{determination, submitted_at, bureau, aud_to}   eoscar.aud.submitted{aud_id, bureau, purpose, fan_out_complete}
 *   credit.dispute.direct.received{received_at, results_due_on, …}   credit.dispute.direct.supplemented{received_at, within_30, extended_to}
 *   credit.dispute.frivolous_determined{determined_on, reasons, required_information}   credit.dispute.noe_linked{noe_response_due_on}
 *   credit.dispute.escalated{to, threshold}   credit.dispute.eoscar_status{status}   credit.dispute.closed{status, ccc_transition, open_disputes_remaining}
 *   credit.block.notice.received{control_number, party_id}   case.fraud.opened{source}   credit.dispute.transferor_notified{disputed_month}
 *   credit.dispute.outage.routed{route}   credit.dispute.servicing_correction.requested{commands}
 *   notice.sent{template} is the Notice Registry's (src/notices/service.ts) when the results / frivolous letters go out.
 *
 * bigint cents; PlainDate on the federal (frivolous notice) and servicer (AUD fan-out, review SLA) calendars;
 * receipt timestamps resolve to their America/New_York civil date (rule 1).
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, businessDaysBetween, rollBack, federal, servicer } from "../../kernel/calendar/business.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import type { Actor, EventStore, DomainEvent } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/engine.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";
import type { NoticeService, Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import { eoscarOutageRouting, type Acdv, type AcdvResponse, type Aud, type EoscarPort } from "../../infra/integrations/credit.ts";
import { renderBase } from "./metro2.ts";
import type { Metro2Snapshot, Ccc } from "./types.ts";
import {
  acdvClocks, directDisputeClocks, supplementationOpensNewCase, frivolousNoticeDue, requiresHumanReview, dueDatePlan, acdvCaseClose,
  cccOnReceipt, cccOnClose, correctionFanOut, preBoardingDetermination, ACDV_NO_RESPONSE_STATUS, ACDV_SUBMITTED_STATUS, ACDV_RETURNED_STATUS, BUREAUS,
  type Bureau, type Determination, type DisputeCategory, type DisputeChannel, type ReviewInput, type ReviewDecision, type AcdvClocks, type DueDatePlan,
} from "./disputes.ts";
import { identityTheftResponse, type IdentityTheftResponse } from "./suppression.ts";
import { CreditReportingRefused, oralDisputeIntake, linkedNoeDispute, type CreditCycleRunner, type CycleBuild, type CorrectionInput } from "./ops.ts";

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------
export type DisputeSource = "acdv" | "direct_written" | "direct_oral" | "noe_linked" | "complaint" | "attorney" | "cfpb_portal";
export type DisputeStatus = "received" | "viewed" | "classified" | "frivolous_pending" | "investigating" | "review_pending" | "responded" | "correcting" | "closed" | "closed_frivolous" | "closed_out_of_scope" | "expired_no_response";
export type EvidenceType = "ledger_history" | "payment_image" | "allocation_trace" | "notice_copy" | "contact_log" | "lossmit_agreement" | "bankruptcy_docket" | "scra_certificate" | "prior_servicer_record" | "boarding_reconciliation" | "prior_dispute" | "borrower_submission";
export const EVIDENCE_TYPES: readonly EvidenceType[] = ["ledger_history", "payment_image", "allocation_trace", "notice_copy", "contact_log", "lossmit_agreement", "bankruptcy_docket", "scra_certificate", "prior_servicer_record", "boarding_reconciliation", "prior_dispute", "borrower_submission"];
export type FrivolousBasis = "f1_insufficient_information" | "f2_substantially_same" | "f3_exception_b";
export const RESULTS_TEMPLATE = "NTC_FCRA_1022_43E_RESULTS";
export const FRIVOLOUS_TEMPLATE = "NTC_FCRA_1022_43F_FRIVOLOUS";
export const ACK_TEMPLATE = "NTC_FCRA_1022_43_ACK";
export const ACDV_POLL_JOB = "eoscar-acdv-poll";
export const ACDV_POLL_CADENCE = "every_15_minutes";
/** Reviewer roles that may act on a dispute (AI agent design: `human_agent` / `officer`). */
const REVIEWER_ROLES: readonly string[] = ["human_agent", "officer"];
/** Determinations that change furnished data — the corrections fan-out and the XR transition (rules 5–6; rule 3(iii): `unverifiable` deletes/modifies the item). */
export const DATA_CHANGING: ReadonlySet<Determination> = new Set<Determination>(["modified", "deleted_account", "deleted_consumer", "unverifiable"]);
/**
 * e-OSCAR ACDV Response Codes, as commonly used: "accurate as reported", "modify as indicated", the delete codes
 * (8.2 rule 4). [UNVERIFIED — the licensed table (eo2026.07 redefines 12/13) is loaded from e-OSCAR at build; 8.2-Q6.]
 */
export const RESPONSE_CODES: Readonly<Record<Determination, string>> = { verified_as_reported: "01", modified: "02", deleted_account: "03", deleted_consumer: "04", unverifiable: "02", frivolous: "" };
export const VERIFIED_RESPONSE_CODE = RESPONSE_CODES.verified_as_reported;
/** e-OSCAR dispute codes → `category` (rule 2). [UNVERIFIED — commonly cited codes; the licensed Dispute Code table is loaded at build, and callers may pass `category`.] */
export const DISPUTE_CODE_CATEGORY: Readonly<Record<string, DisputeCategory>> = { "001": "not_mine", "002": "mixed_file", "003": "identity_theft", "021": "liability", "106": "payment_history", "112": "dates", "113": "balance" };
/** Rule 2: the evidence plan per category (evidence types of `credit_dispute_evidence`). */
export const EVIDENCE_PLAN: Readonly<Record<DisputeCategory, readonly EvidenceType[]>> = {
  payment_history: ["ledger_history", "payment_image", "allocation_trace", "lossmit_agreement", "prior_dispute"],
  status_or_rating: ["ledger_history", "payment_image", "allocation_trace", "lossmit_agreement"],
  amount_past_due: ["ledger_history", "allocation_trace"],
  balance: ["ledger_history", "allocation_trace"],
  dates: ["ledger_history", "boarding_reconciliation", "prior_servicer_record"],
  not_mine: ["boarding_reconciliation", "borrower_submission", "prior_servicer_record"],
  identity_theft: ["boarding_reconciliation", "borrower_submission", "contact_log"],
  mixed_file: ["boarding_reconciliation", "borrower_submission"],
  liability: ["boarding_reconciliation", "notice_copy"],
  terms: ["boarding_reconciliation", "notice_copy"],
  special_comment_or_ccc: ["ledger_history", "lossmit_agreement", "prior_dispute"],
  bankruptcy_cii: ["bankruptcy_docket"],
  deceased: ["contact_log", "borrower_submission"],
  scra: ["scra_certificate"],
  transfer_duplicate: ["prior_servicer_record", "boarding_reconciliation"],
  other: ["borrower_submission", "ledger_history"],
};

/** A refusal by an 8.2 guardrail or state-machine guard: nothing is written, the code names the rule. */
export class DisputeRefused extends Error {
  readonly code: string;
  constructor(code: string, why: string) { super(`${code}: ${why}`); this.name = "DisputeRefused"; this.code = code; }
}
const AGG = "credit_dispute";
const need = (v: unknown, what: string): void => { if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) throw new RangeError(`${what} is required`); };
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
/** Receipt timestamps anchor on their America/New_York civil date (rule 1). */
export const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), "America/New_York").date;
const isReviewer = (a: Actor): boolean => a.kind === "human" && !!a.role && REVIEWER_ROLES.includes(a.role);
const isOfficer = (a: Actor): boolean => a.kind === "human" && a.role === "officer";

/** Rule 2 classification from dispute codes then text; an explicit `category` wins. */
export function classifyDispute(codes: readonly string[], text: string, explicit?: DisputeCategory): { category: DisputeCategory; evidence_plan: readonly EvidenceType[] } {
  let category: DisputeCategory | undefined = explicit;
  if (!category) for (const c of codes) { const m = DISPUTE_CODE_CATEGORY[c]; if (m) { category = m; break; } }
  if (!category) {
    const t = text.toLowerCase();
    category = /identity theft|fraud/.test(t) ? "identity_theft" : /not mine|never had|never opened/.test(t) ? "not_mine" : /mixed|someone else/.test(t) ? "mixed_file" : /bankrupt|discharg/.test(t) ? "bankruptcy_cii" : /scra|active duty|servicemember/.test(t) ? "scra" : /deceased|estate|passed away/.test(t) ? "deceased" : /date opened|first delinquen|date closed|last payment/.test(t) ? "dates" : /balance|owe/.test(t) ? "balance" : /past due amount|amount past due/.test(t) ? "amount_past_due" : /late|payment|paid|status/.test(t) ? "payment_history" : "other";
  }
  return { category, evidence_plan: EVIDENCE_PLAN[category] };
}

export interface EvidenceRow { readonly evidence_type: EvidenceType; readonly document_id?: string; readonly system_snapshot_id?: string; readonly relied_upon: boolean; readonly note?: string; }
export interface Finding { readonly claim: string; readonly finding: string; readonly effect: "changes_outcome" | "no_change"; readonly why: string; }
export interface CreditDispute {
  readonly id: string; readonly loan_id: string; readonly borrower_id: string | null; readonly source: DisputeSource; readonly cra: Bureau | null;
  readonly acdv_control_number: string | null; readonly received_at: string; readonly received_on: PlainDate; readonly category: DisputeCategory;
  readonly evidence_plan: readonly EvidenceType[]; readonly response_due_at: PlainDate | null; readonly results_due_at: PlainDate | null; readonly status: DisputeStatus;
  readonly ccc_transition: Ccc; readonly clocks: AcdvClocks | null;
}

// ---------------------------------------------------------------------------
// the runner: every event below is appended over the loan event log
// ---------------------------------------------------------------------------
export class DisputeCaseRunner {
  private readonly events: EventStore;
  private readonly actor: Actor;
  constructor(events: EventStore, actor: Actor) { this.events = events; this.actor = actor; }

  private emit(type: string, loanId: string | null, disputeId: string | null, payload: Record<string, unknown>, actor: Actor = this.actor): DomainEvent {
    return this.events.append({ type, ...(loanId ? { loanId } : {}), ...(disputeId ? { aggregate: { kind: AGG, id: disputeId } } : {}), actor, payload: { ...(disputeId ? { dispute_id: disputeId } : {}), ...payload } });
  }
  private ofDispute(type: string, disputeId: string): DomainEvent[] { return this.events.ofType(type).filter((e) => e.payload.dispute_id === disputeId); }
  private last(type: string, disputeId: string): DomainEvent | undefined { return this.ofDispute(type, disputeId).at(-1); }
  /** The receipt record of a dispute (`credit.dispute.acdv.received` or `credit.dispute.direct.received`). */
  receipt(disputeId: string): DomainEvent {
    const r = this.last("credit.dispute.acdv.received", disputeId) ?? this.last("credit.dispute.direct.received", disputeId);
    if (!r) throw new RangeError(`no credit_disputes row ${disputeId}`);
    return r;
  }
  /** Open disputes on a loan: received and not yet closed (the XB gate holds while any is open — rule 6). */
  openDisputeIds(loanId: string): string[] {
    const closed = new Set(this.events.ofType("credit.dispute.closed").filter((e) => e.loanId === loanId).map((e) => String(e.payload.dispute_id)));
    return this.events.ofType("credit.dispute.received").filter((e) => e.loanId === loanId).map((e) => String(e.payload.dispute_id)).filter((id) => !closed.has(id));
  }
  private receivedEvent(f: { dispute_id: string; loan_id: string; borrower_id: string | null; source: DisputeSource; bureau: Bureau | null; received_at: string; received_on: PlainDate; next_cycle_transmit_on: PlainDate | null }): { ccc: "XB"; via: "aud" | "next_cycle" } {
    const on = cccOnReceipt(f.received_on, f.next_cycle_transmit_on ?? addDays(f.received_on, 5));   // no next-cycle date known → carried in the next file
    const open = this.openDisputeIds(f.loan_id);
    this.emit("credit.dispute.received", f.loan_id, f.dispute_id, { source: f.source, loan_id: f.loan_id, borrower_id: f.borrower_id, bureau: f.bureau, received_at: f.received_at, received_on: f.received_on, ccc: "XB", ccc_via: on.via, open_disputes: [...open, f.dispute_id] });
    return { ccc: "XB", via: on.via };
  }

  // ---- ACDV intake ------------------------------------------------------------------------------------------------
  /**
   * One ACDV → one `credit_disputes` row (`source='acdv'`): validates the CRA record, computes the clocks (rule 1 —
   * the ACDV's Response Due Date governs; internal target +7; the CRA's 30/45-day outer bound from `cra_received_at`)
   * and emits `credit.dispute.acdv.received` (FCRA_1681S2B_ACDV_RESPONSE_DUE / SM_ACDV_INTERNAL_TARGET_CD7 /
   * FCRA_1681I_A1_CRA_OUTER_30_45) then `credit.dispute.received` (FCRA_1681S2A3_XB_FLAG_GATE).
   */
  ingestAcdv(f: { acdv: Acdv; loan_id: string; borrower_id?: string; received_at: string; subscriber_code?: string; consumer_statement?: string; category?: DisputeCategory; identifiers_match?: boolean; next_cycle_transmit_on?: PlainDate }): CreditDispute {
    const a = f.acdv;
    need(f.loan_id, "loan_id"); need(a.controlNumber, "acdv.controlNumber"); need(f.received_at, "received_at");
    if (!/^\d{6,}$/.test(a.controlNumber)) throw new RangeError(`ACDV control number ${a.controlNumber} is not numeric`);
    if (!BUREAUS.includes(a.bureau)) throw new RangeError(`bureau ${String(a.bureau)} is not one of ${BUREAUS.join("/")}`);
    if (!isDate(a.responseDueOn)) throw new RangeError(`ACDV ${a.controlNumber} carries no Response Due Date`);
    if (Number.isNaN(Date.parse(a.receivedAt))) throw new RangeError(`ACDV ${a.controlNumber} carries no CRA date`);
    const id = `acdv-${a.bureau}-${a.controlNumber}`;
    if (this.events.ofType("credit.dispute.acdv.received").some((e) => e.payload.dispute_id === id)) throw new RangeError(`ACDV ${a.controlNumber} already ingested (idempotency by control number)`);
    const receivedOn = etDate(f.received_at); const responseDue = a.responseDueOn as PlainDate; const craReceived = etDate(a.receivedAt);
    if (responseDue < receivedOn) throw new RangeError(`ACDV ${a.controlNumber} Response Due Date ${responseDue} precedes receipt ${receivedOn}`);
    const clocks = acdvClocks(receivedOn, responseDue, craReceived, a.fcraRelevantInfo);
    const window = daysBetween(receivedOn, responseDue);
    const escalateOfficerOn = addDays(receivedOn, Math.floor(window * 0.8));
    const { category, evidence_plan } = classifyDispute(a.disputeCodes, f.consumer_statement ?? "", f.category);
    this.emit("credit.dispute.acdv.received", f.loan_id, id, {
      source: "acdv", loan_id: f.loan_id, borrower_id: f.borrower_id ?? null, control_number: a.controlNumber, bureau: a.bureau, subscriber_code: f.subscriber_code ?? null, account_number: a.accountNumber,
      dispute_codes: [...a.disputeCodes], category, evidence_plan: [...evidence_plan], consumer: { name: a.consumer.name, ssn_last4: a.consumer.ssnLast4 }, identifiers_match: f.identifiers_match ?? true,
      fcra_relevant_information: a.fcraRelevantInfo, consumer_supplied_information: a.fcraRelevantInfo, consumer_statement: f.consumer_statement ?? null, image_document_ids: [...a.images],
      cra_received_at: craReceived, received_at: f.received_at, received_on: receivedOn, response_due_on: responseDue, internal_target_on: clocks.internal_target, cra_outer_bound_on: clocks.outer_bound,
      escalate_officer_on: escalateOfficerOn, escalate_on: clocks.escalate_on, eoscar_status: "PENDING-SENDREQUEST",
    });
    this.receivedEvent({ dispute_id: id, loan_id: f.loan_id, borrower_id: f.borrower_id ?? null, source: "acdv", bureau: a.bureau, received_at: f.received_at, received_on: receivedOn, next_cycle_transmit_on: f.next_cycle_transmit_on ?? null });
    return { id, loan_id: f.loan_id, borrower_id: f.borrower_id ?? null, source: "acdv", cra: a.bureau, acdv_control_number: a.controlNumber, received_at: f.received_at, received_on: receivedOn, category, evidence_plan, response_due_at: responseDue, results_due_at: null, status: "received", ccc_transition: "XB", clocks };
  }
  /** The scheduler's 15-minute tick for the e-OSCAR poll (SM_ACDV_POLL_15M trigger; global subject). */
  acdvPollTick(now: string): DomainEvent {
    return this.events.append({ type: "schedule.tick", actor: { kind: "system", id: "scheduler" }, payload: { cadence: ACDV_POLL_CADENCE, job: ACDV_POLL_JOB, at: now } });
  }
  private consecutivePollFailures(): number {
    let n = 0;
    for (const e of [...this.events.all()].reverse()) { if (e.type === "eoscar.poll.succeeded") break; if (e.type === "eoscar.poll.failed") n++; }
    return n;
  }
  /**
   * `/acdvreq/vX/find` (PENDING-SENDREQUEST, last 7 days) → one `credit.dispute.acdv.received` per new control number →
   * `eoscar.poll.succeeded` (SM_ACDV_POLL_15M satisfied). A failure is `eoscar.poll.failed{consecutive_failures}`; the
   * second consecutive failure raises `eoscar.poll.alarm` — the `human_agent` checks the web app with interactive credentials.
   */
  async pollAcdvs(port: EoscarPort, f: { now: string; since?: string; loan_id_for: (a: Acdv) => string | null; borrower_id_for?: (a: Acdv) => string | null; next_cycle_transmit_on?: PlainDate }): Promise<{ ok: boolean; found: number; ingested: string[]; skipped: string[]; consecutive_failures: number; alarm: boolean; action: "none" | "human_agent_checks_web_app" }> {
    const since = f.since ?? new Date(Date.parse(f.now) - 7 * 86_400_000).toISOString();
    let list: readonly Acdv[];
    try { list = await port.findAcdvs(since); }
    catch (e) {
      const n = this.consecutivePollFailures() + 1;
      this.emit("eoscar.poll.failed", null, null, { job: ACDV_POLL_JOB, at: f.now, since, consecutive_failures: n, error: (e as Error).message });
      const alarm = n >= 2;
      if (alarm) this.emit("eoscar.poll.alarm", null, null, { job: ACDV_POLL_JOB, at: f.now, consecutive_failures: n, action: "human_agent_checks_web_app", credentials: "interactive users are separate from API users" });
      return { ok: false, found: 0, ingested: [], skipped: [], consecutive_failures: n, alarm, action: alarm ? "human_agent_checks_web_app" : "none" };
    }
    const ingested: string[] = []; const skipped: string[] = [];
    for (const a of list) {
      const loanId = f.loan_id_for(a);
      if (!loanId || this.events.ofType("credit.dispute.acdv.received").some((e) => e.payload.control_number === a.controlNumber)) { skipped.push(a.controlNumber); continue; }
      const borrower = f.borrower_id_for?.(a) ?? null;
      this.ingestAcdv({ acdv: a, loan_id: loanId, received_at: f.now, ...(borrower ? { borrower_id: borrower } : {}), ...(f.next_cycle_transmit_on ? { next_cycle_transmit_on: f.next_cycle_transmit_on } : {}) });
      ingested.push(a.controlNumber);
    }
    this.emit("eoscar.poll.succeeded", null, null, { job: ACDV_POLL_JOB, at: f.now, since, found: list.length, ingested: [...ingested], skipped: [...skipped] });
    return { ok: true, found: list.length, ingested, skipped, consecutive_failures: 0, alarm: false, action: "none" };
  }
  /** `/acdvreq/vX/view/{ctrl}`: images downloaded; e-OSCAR moves the ACDV to PENDING-AWAITINGRESPONSE (mandatory before a response). */
  acdvViewed(f: { control_number: string; images_downloaded: number; at: string }): { dispute_id: string | null; eoscar_status: "PENDING-AWAITINGRESPONSE" } {
    need(f.control_number, "control_number");
    const r = this.events.ofType("credit.dispute.acdv.received").find((e) => e.payload.control_number === f.control_number);
    const id = r ? String(r.payload.dispute_id) : null;
    this.emit("credit.dispute.acdv.viewed", r?.loanId ?? null, id, { control_number: f.control_number, images_downloaded: f.images_downloaded, viewed_at: f.at, eoscar_status: "PENDING-AWAITINGRESPONSE" });
    return { dispute_id: id, eoscar_status: "PENDING-AWAITINGRESPONSE" };
  }

  // ---- direct intake ----------------------------------------------------------------------------------------------
  /**
   * A written, oral, complaint, attorney or NoE-linked direct dispute (Reg V §1022.43; 4.1 Intake Router `kind='credit_dispute'`):
   * `received_at` = mail-vendor / electronic receipt (America/New_York); day 0 = receipt; results due day 30 (policy
   * dispatch by day 25 and never after the last business day on or before day 30). Oral disputes are logged as a contact
   * with `credit_dispute_asserted=true` and open a case anyway (8.2-Q2). Emits `credit.dispute.direct.received`
   * (FCRA_1022_43E_DIRECT_RESULTS_30), `credit.dispute.received` (XB gate) and, when the letter is also an NoE (rule 9),
   * `credit.dispute.noe_linked` with the 4.1 clock.
   */
  receiveDirectDispute(f: { loan_id: string; borrower_id?: string; source: Exclude<DisputeSource, "acdv">; received_at: string; channel?: "mail" | "web_form" | "secure_message" | "email" | "oral" | "complaint_portal" | "attorney_letter"; allegations: readonly string[]; category?: DisputeCategory; image_document_ids?: readonly string[]; next_cycle_transmit_on?: PlainDate; automation_disclosed?: boolean; credit_repair_indicators?: readonly string[]; supersedes_dispute_id?: string; noe_case_id?: string }): CreditDispute & { opens_case: boolean; results_due_on: PlainDate; dispatch_target_on: PlainDate; mail_by_on: PlainDate; noe_linked: boolean; noe_response_due_on: PlainDate | null; ccc_via: "aud" | "next_cycle" } {
    need(f.loan_id, "loan_id"); need(f.received_at, "received_at"); need(f.allegations, "allegations");
    if (Number.isNaN(Date.parse(f.received_at))) throw new RangeError(`received_at ${f.received_at} is not an instant`);
    const receivedOn = etDate(f.received_at);
    const text = f.allegations.join(" ");
    const oral = f.source === "direct_oral" ? oralDisputeIntake({ utterance: text, received_on: receivedOn, next_cycle_transmit_on: f.next_cycle_transmit_on ?? addDays(receivedOn, 5), automation_disclosed: f.automation_disclosed === true }) : null;
    if (oral && !oral.opens_case) throw new DisputeRefused("NOT_A_CREDIT_DISPUTE", `the utterance does not assert an inaccuracy in furnished credit information: "${text}"`);
    const { category, evidence_plan } = classifyDispute([], text, f.category ?? (oral ? (oral.category as DisputeCategory) : undefined));
    const clocks = directDisputeClocks(receivedOn);
    const mailBy = rollBack(clocks.results_due, servicer);
    const noe = linkedNoeDispute({ received_on: receivedOn, allegations: f.allegations });
    const noeLinked = noe.noe_case !== null;
    const seq = this.events.ofType("credit.dispute.direct.received").filter((e) => e.loanId === f.loan_id).length + 1;
    const id = `dd-${f.loan_id}-${receivedOn}-${seq}`;
    const noeCaseId = noeLinked ? f.noe_case_id ?? `noe-${id}` : null;
    this.emit("credit.dispute.direct.received", f.loan_id, id, {
      source: f.source, channel: f.channel ?? (f.source === "direct_oral" ? "oral" : "mail"), loan_id: f.loan_id, borrower_id: f.borrower_id ?? null, received_at: f.received_at, received_on: receivedOn,
      results_due_on: clocks.results_due, dispatch_target_on: clocks.dispatch_target, mail_by_on: mailBy, category, evidence_plan: [...evidence_plan], allegations: [...f.allegations],
      image_document_ids: [...(f.image_document_ids ?? [])], noe_linked: noeLinked, noe_case_id: noeCaseId, credit_repair_indicators: [...(f.credit_repair_indicators ?? [])], supersedes_dispute_id: f.supersedes_dispute_id ?? null,
      contact_log: oral ? { credit_dispute_asserted: true, automation_disclosed: oral.automation_disclosed, human_transfer_requested: oral.human_transfer_requested } : null, results_template: RESULTS_TEMPLATE,
    });
    const on = this.receivedEvent({ dispute_id: id, loan_id: f.loan_id, borrower_id: f.borrower_id ?? null, source: f.source, bureau: null, received_at: f.received_at, received_on: receivedOn, next_cycle_transmit_on: f.next_cycle_transmit_on ?? null });
    if (noeLinked) this.emit("credit.dispute.noe_linked", f.loan_id, id, { noe_case_id: noeCaseId, noe_response_due_on: noe.noe_case!.response_due, noe_basis: noe.noe_case!.basis, results_due_on: clocks.results_due, earlier_clock: noe.earlier_clock, shared_corrections: true, combined_letter_allowed: noe.combined_letter_allowed });
    return { id, loan_id: f.loan_id, borrower_id: f.borrower_id ?? null, source: f.source, cra: null, acdv_control_number: null, received_at: f.received_at, received_on: receivedOn, category, evidence_plan, response_due_at: null, results_due_at: clocks.results_due, status: "received", ccc_transition: "XB", clocks: null,
      opens_case: true, results_due_on: clocks.results_due, dispatch_target_on: clocks.dispatch_target, mail_by_on: mailBy, noe_linked: noeLinked, noe_response_due_on: noe.noe_case?.response_due ?? null, ccc_via: on.via };
  }
  /**
   * The consumer supplements: within the 30 days → `extended_to` = receipt + 45 and `credit.dispute.direct.supplemented{within_30=true}`
   * (FCRA_1022_43E_DIRECT_RESULTS_EXT_45 replaces the 30 — the open 30-day instance is cancelled when the engine is given);
   * after day 30 → a new case (new clock) if it carries new information, else a letter referencing the prior results.
   */
  supplementDirectDispute(f: { dispute_id: string; supplemented_at: string; new_information: boolean; document_ids?: readonly string[] }, timers?: TimerEngine): { action: "extended" | "new_case" | "letter_referencing_prior_results"; extended_to: PlainDate | null; new_dispute: CreditDispute | null; cancelled_timer_ids: string[] } {
    const r = this.receipt(f.dispute_id); const p = r.payload;
    if (p.source === "acdv") throw new DisputeRefused("ACDV_NOT_SUPPLEMENTED", "supplementation extends only a direct dispute (§1022.43(e)(3)); the CRA extends its own reinvestigation under §1681i(a)(1)(B)");
    const receivedOn = p.received_on as PlainDate; const on = etDate(f.supplemented_at); const loanId = r.loanId!;
    if (!supplementationOpensNewCase(receivedOn, on)) {
      const extended = directDisputeClocks(receivedOn, on).extended_to!;
      this.emit("credit.dispute.direct.supplemented", loanId, f.dispute_id, { loan_id: loanId, received_at: p.received_at, received_on: receivedOn, supplemented_at: f.supplemented_at, supplemented_on: on, within_30: true, extended_to: extended, new_information: f.new_information, document_ids: [...(f.document_ids ?? [])] });
      const cancelled: string[] = [];
      for (const t of timers?.byCode("FCRA_1022_43E_DIRECT_RESULTS_30") ?? []) if (t.status === "armed" && t.loanId === loanId) { timers!.cancel(t.id, `replaced by FCRA_1022_43E_DIRECT_RESULTS_EXT_45 (§1022.43(e)(3) / §1681i(a)(1)(B): supplemented ${on}, results due ${extended})`, this.actor); cancelled.push(t.id); }
      return { action: "extended", extended_to: extended, new_dispute: null, cancelled_timer_ids: cancelled };
    }
    if (f.new_information) {
      const nd = this.receiveDirectDispute({ loan_id: loanId, ...(p.borrower_id ? { borrower_id: String(p.borrower_id) } : {}), source: p.source as Exclude<DisputeSource, "acdv">, received_at: f.supplemented_at, allegations: p.allegations as string[], category: p.category as DisputeCategory, image_document_ids: [...(f.document_ids ?? [])], supersedes_dispute_id: f.dispute_id });
      return { action: "new_case", extended_to: null, new_dispute: nd, cancelled_timer_ids: [] };
    }
    this.emit("credit.dispute.direct.supplemented", loanId, f.dispute_id, { loan_id: loanId, received_at: p.received_at, received_on: receivedOn, supplemented_at: f.supplemented_at, supplemented_on: on, within_30: false, extended_to: null, new_information: false, action: "letter_referencing_prior_results" });
    return { action: "letter_referencing_prior_results", extended_to: null, new_dispute: null, cancelled_timer_ids: [] };
  }
  /**
   * §1022.43(f): frivolous/irrelevant only for a direct dispute, only on the (f)(1) grounds, made by a human reviewer on
   * the agent's recommendation (rule 7); a repeat that includes any new document is investigated instead (8.2-T6).
   * Emits `credit.dispute.frivolous_determined{determined_on}` (FCRA_1022_43F_FRIVOLOUS_NOTICE_5BD: 5 federal business days).
   */
  determineFrivolous(f: { dispute_id: string; determined_on: PlainDate; basis: FrivolousBasis; repeat: boolean; new_information: boolean; reasons: readonly string[]; required_information: readonly string[]; credit_repair_belief?: boolean }, approver: Actor): { notice_due_on: PlainDate; approved_by: string; status: "frivolous_pending" } {
    const r = this.receipt(f.dispute_id);
    if (r.payload.source === "acdv") throw new DisputeRefused("ACDV_NEVER_FRIVOLOUS", "an ACDV is never deemed frivolous (guardrail; §1681s-2(b) carries no (f) exception)");
    if (!isReviewer(approver)) throw new DisputeRefused("FRIVOLOUS_NEEDS_HUMAN", `a frivolous/irrelevant determination is made only by a human reviewer (human_agent/officer); actor is ${approver.kind}:${approver.id}`);
    if (f.new_information) throw new DisputeRefused("NOT_FRIVOLOUS_NEW_INFORMATION", "a repeat dispute that includes information not previously provided is not substantially the same (§1022.43(f)(1)(ii)) — investigate it");
    if (f.basis === "f2_substantially_same" && !f.repeat) throw new DisputeRefused("NOT_A_REPEAT", "(f)(1)(ii) applies only to a dispute substantially the same as one previously submitted");
    need(f.reasons, "reasons"); need(f.required_information, "required_information (the standardized list, §1022.43(f)(2)(ii)(B))");
    if (f.basis === "f3_exception_b" && f.credit_repair_belief && !isOfficer(approver)) throw new DisputeRefused("CREDIT_REPAIR_EXCEPTION_NEEDS_OFFICER", "the credit-repair-organization exception is reserved for template floods and is an officer decision");
    const due = frivolousNoticeDue(f.determined_on, federal);
    this.emit("credit.dispute.frivolous_determined", r.loanId!, f.dispute_id, { loan_id: r.loanId, determined_on: f.determined_on, basis: f.basis, repeat: f.repeat, new_information: false, reasons: [...f.reasons], required_information: [...f.required_information], approved_by: approver.id, approver_role: approver.role ?? null, notice_due_on: due, notice_template: FRIVOLOUS_TEMPLATE }, approver);
    return { notice_due_on: due, approved_by: approver.id, status: "frivolous_pending" };
  }

  // ---- investigation -----------------------------------------------------------------------------------------------
  /** `credit_dispute_evidence` rows (document or system snapshot; `relied_upon`). */
  recordEvidence(f: { dispute_id: string; evidence: readonly EvidenceRow[] }): { relied_upon: number; total: number } {
    const r = this.receipt(f.dispute_id); need(f.evidence, "evidence");
    for (const e of f.evidence) { if (!EVIDENCE_TYPES.includes(e.evidence_type)) throw new RangeError(`evidence_type ${e.evidence_type} is not one of ${EVIDENCE_TYPES.join("/")}`); if (!e.document_id && !e.system_snapshot_id) throw new RangeError("an evidence row cites a document_id or a system_snapshot_id"); }
    const relied = f.evidence.filter((e) => e.relied_upon).length;
    this.emit("credit.dispute.evidence.recorded", r.loanId!, f.dispute_id, { evidence: f.evidence.map((e) => ({ ...e })), relied_upon: relied, total: f.evidence.length });
    return { relied_upon: relied, total: this.evidenceRows(f.dispute_id).length };
  }
  evidenceRows(disputeId: string): EvidenceRow[] { return this.ofDispute("credit.dispute.evidence.recorded", disputeId).flatMap((e) => e.payload.evidence as EvidenceRow[]); }
  /**
   * Rule 3 as code: `verified_as_reported` needs ≥1 relied-upon evidence row and every consumer image answered in the
   * findings; a pre-boarding item without the transferor record or the boarding reconciliation is `unverifiable`
   * (rule 3(iii)); an ACDV is never frivolous. Then the reviewer conditions (AI agent design) — a required review emits
   * `credit.dispute.review_requested{approver, requested_at}` (SM_DISPUTE_REVIEW_SLA_BD1) with the escalation package.
   */
  investigate(f: { dispute_id: string; determination: Determination; confidence: number; findings: readonly Finding[]; requested_at: string; review?: Omit<ReviewInput, "determination" | "confidence" | "category" | "channel">; pre_boarding?: { transferor_record: boolean; boarding_reconciliation: boolean; substantiated: boolean } }): { determination: Determination; review: ReviewDecision; status: "investigating" | "review_pending"; evidence_relied_upon: number } {
    const r = this.receipt(f.dispute_id); const p = r.payload; const source = p.source as DisputeSource;
    const channel: DisputeChannel = source === "acdv" ? "acdv" : source === "direct_oral" ? "oral" : p.channel === "mail" || p.channel === "attorney_letter" ? "direct_mail" : "direct_electronic";
    let determination = f.determination;
    if (f.pre_boarding) determination = preBoardingDetermination(f.pre_boarding.transferor_record, f.pre_boarding.boarding_reconciliation, f.pre_boarding.substantiated);
    if (determination === "frivolous" && channel === "acdv") throw new DisputeRefused("ACDV_NEVER_FRIVOLOUS", "an ACDV is never deemed frivolous (guardrail)");
    const relied = this.evidenceRows(f.dispute_id).filter((e) => e.relied_upon).length;
    if (determination === "verified_as_reported" && relied === 0) throw new DisputeRefused("VERIFIED_NEEDS_EVIDENCE", "never respond \"verified\" without evidence rows: ≥1 credit_dispute_evidence.relied_upon row (state machine guard; rule 3(i))");
    const images = (p.image_document_ids as string[] | undefined) ?? [];
    if (images.length > 0 && f.findings.length === 0) throw new DisputeRefused("IMAGES_NOT_ANSWERED", `${images.length} consumer-supplied image(s) must be reviewed and each factual claim answered in investigation.findings (rule 3(ii))`);
    if (determination === "verified_as_reported" && f.findings.some((x) => x.effect === "changes_outcome")) throw new DisputeRefused("FINDING_CHANGES_OUTCOME", "a finding that changes the outcome cannot end in verified_as_reported");
    this.emit("credit.dispute.investigated", r.loanId!, f.dispute_id, { determination, draft_determination: f.determination, confidence: f.confidence, findings: f.findings.map((x) => ({ ...x })), category: p.category, evidence_relied_upon: relied, pre_boarding: f.pre_boarding ?? null, identifiers_match: p.identifiers_match ?? true, investigated_at: f.requested_at });
    const review = requiresHumanReview({ determination, confidence: f.confidence, category: p.category as DisputeCategory, channel, ...(p.identifiers_match === false ? { identifier_mismatch: true } : {}), ...(f.pre_boarding ? { pre_boarding_period: true, prior_servicer_records_complete: f.pre_boarding.transferor_record } : {}), ...(f.review ?? {}) });
    if (review.required) this.requestReview({ dispute_id: f.dispute_id, review, requested_at: f.requested_at, draft: { determination, confidence: f.confidence, findings: f.findings } });
    return { determination, review, status: review.required ? "review_pending" : "investigating", evidence_relied_upon: relied };
  }
  /** The escalation package: draft response, decision record, evidence with snapshots, the consumer's images, timer status, a one-paragraph summary. */
  requestReview(f: { dispute_id: string; review: ReviewDecision; requested_at: string; draft: { determination: Determination; confidence: number; findings: readonly Finding[] } }): DomainEvent {
    const r = this.receipt(f.dispute_id); const p = r.payload;
    const timers = { response_due_on: p.response_due_on ?? null, results_due_on: p.results_due_on ?? null, escalate_on: p.escalate_on ?? null, keep_running: true };
    return this.emit("credit.dispute.review_requested", r.loanId!, f.dispute_id, { approver: f.review.approver, conditions: [...f.review.conditions], reasons: [...f.review.reasons], fair_lending_log: f.review.fair_lending_log, requested_at: f.requested_at, sla: "1 business_days_servicer",
      evidence_pack: { draft_determination: f.draft.determination, confidence: f.draft.confidence, findings: f.draft.findings.map((x) => ({ ...x })), evidence: this.evidenceRows(f.dispute_id), images: p.image_document_ids ?? [], timers, summary: `${String(p.source)} dispute ${f.dispute_id} (${String(p.category)}): draft ${f.draft.determination} at ${f.draft.confidence}; conditions ${f.review.conditions.join(",") || "none"}` } });
  }
  /** Reviewer action (SM_DISPUTE_REVIEW_SLA_BD1 satisfied): a human with the requested role — an `officer` may act on a `human_agent` request, never the reverse. */
  recordReview(f: { dispute_id: string; action: "approve" | "modify" | "reject"; rationale: string; reviewed_at: string; determination?: Determination }, reviewer: Actor): DomainEvent {
    const req = this.last("credit.dispute.review_requested", f.dispute_id);
    if (!req) throw new DisputeRefused("NO_REVIEW_REQUESTED", `no open review request on ${f.dispute_id}`);
    if (!isReviewer(reviewer)) throw new DisputeRefused("REVIEWER_ROLE", `reviewer action requires human_agent/officer; actor is ${reviewer.kind}:${reviewer.id}${reviewer.role ? ` (${reviewer.role})` : ""}`);
    if (req.payload.approver === "officer" && !isOfficer(reviewer)) throw new DisputeRefused("OFFICER_REQUIRED", `review of ${f.dispute_id} was routed to officer (conditions ${(req.payload.conditions as number[]).join(",")}); actor is ${reviewer.role}`);
    need(f.rationale, "rationale");
    return this.emit("credit.dispute.reviewed", req.loanId!, f.dispute_id, { reviewer_id: reviewer.id, reviewer_role: reviewer.role, action: f.action, rationale: f.rationale, reviewed_at: f.reviewed_at, determination: f.determination ?? (req.payload.evidence_pack && (req.payload.evidence_pack as { draft_determination: Determination }).draft_determination) }, reviewer);
  }

  // ---- response ----------------------------------------------------------------------------------------------------
  /**
   * Rule 4: the ACDV response returns the full current Metro 2 field set generated from the 8.1 snapshot logic as of
   * the response date — never typed by hand — with the outcome applied (corrections overlaid; DA/DF or ECOA Z for
   * deletes) and XB carried while the dispute is open.
   */
  responsePayload(f: { control_number: string; determination: Determination; snapshot: Metro2Snapshot; party_id: string; corrections?: Record<string, string>; narrative?: string }): AcdvResponse {
    if (f.determination === "frivolous") throw new DisputeRefused("ACDV_NEVER_FRIVOLOUS", "an ACDV response has no frivolous code");
    const seg = f.snapshot.consumers.find((c) => c.party_id === f.party_id); if (!seg) throw new RangeError(`consumer ${f.party_id} is not on the snapshot for ${f.snapshot.loan_id}`);
    const fields: Record<string, string> = { ...renderBase(f.snapshot), ecoa: seg.ecoa, cii: seg.cii, ccc: "XB", ...(f.corrections ?? {}) };
    if (f.determination === "deleted_account") fields.account_status = "DA";
    if (f.determination === "deleted_consumer") fields.ecoa = "Z";
    return { controlNumber: f.control_number, responseCode: RESPONSE_CODES[f.determination], accountFields: fields, complianceConditionCode: "XB", ...(f.narrative ? { narrative: f.narrative } : {}) };
  }
  /**
   * After `/acdvresp/vX/submit` (the `eoscar.acdv.find/view/validate/submit` tool): `credit.dispute.acdv.responded`
   * (RESOLVED-SENDINGTOAGENCY — the three ACDV clocks) and `credit.dispute.responded{determination}` — for a
   * data-changing outcome the FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2 trigger with the fan-out plan (rule 5).
   */
  acdvResponded(f: { control_number: string; response_code: string; determination: Determination | null; submitted_at: string; fields_changed?: readonly string[] }): { dispute_id: string | null; bureau: Bureau | null; data_changed: boolean; aud_to: readonly Bureau[]; aud_due: PlainDate | null } {
    need(f.control_number, "control_number"); need(f.submitted_at, "submitted_at");
    if (f.response_code === ACDV_NO_RESPONSE_STATUS) throw new DisputeRefused("DUE_DATE_NEVER_LAPSES", `${ACDV_NO_RESPONSE_STATUS} is never a response`);
    const r = this.events.ofType("credit.dispute.acdv.received").find((e) => e.payload.control_number === f.control_number);
    const id = r ? String(r.payload.dispute_id) : null; const bureau = (r?.payload.bureau as Bureau | undefined) ?? null; const loanId = r?.loanId ?? null;
    const determination = f.determination ?? (f.response_code === VERIFIED_RESPONSE_CODE ? "verified_as_reported" : null);
    this.emit("credit.dispute.acdv.responded", loanId, id, { control_number: f.control_number, bureau, response_code: f.response_code, determination, submitted_at: f.submitted_at, eoscar_status: ACDV_SUBMITTED_STATUS, fields_changed: [...(f.fields_changed ?? [])] });
    const changed = determination !== null && DATA_CHANGING.has(determination);
    const fan = changed ? correctionFanOut(etDate(f.submitted_at), bureau, false, true, servicer) : null;
    this.emit("credit.dispute.responded", loanId, id, { source: "acdv", control_number: f.control_number, bureau, determination, response_code: f.response_code, submitted_at: f.submitted_at, data_changed: changed, aud_to: fan ? [...fan.aud_to] : [], aud_due: fan?.aud_due ?? null });
    return { dispute_id: id, bureau, data_changed: changed, aud_to: fan?.aud_to ?? [], aud_due: fan?.aud_due ?? null };
  }
  /**
   * Rule 5 / §1681s-2(b)(1)(D): AUDs to every other bureau that received the data, ≤2 servicer business days after the
   * response — validated first (a reject is fixed and resubmitted the same day, never left at the due date), then
   * submitted through the port; each emits `eoscar.aud.submitted{bureau, purpose, fan_out_complete}` and the last of the
   * required set carries `fan_out_complete=true` (FCRA_1681S2B_D_OTHER_CRAS_AUD_BD2 satisfied). A bureau that sent its
   * own ACDV on the same item is answered by its ACDV, not an AUD (edge: duplicate ACDVs across bureaus).
   */
  async submitAudFanOut(port: EoscarPort, f: { dispute_id: string; account_number: string; bureaus: readonly Bureau[]; fields: Record<string, string>; reason: string; now: string; purpose?: "correction" | "dispute_flag"; bureaus_with_own_acdv?: readonly Bureau[]; skip_next_cycle?: boolean }): Promise<{ aud_ids: string[]; bureaus: Bureau[]; completed_at: string | null; in_cycle: true }> {
    const r = this.receipt(f.dispute_id);
    if (f.skip_next_cycle) throw new DisputeRefused("AUD_NOT_IN_CYCLE_SUBSTITUTE", "an AUD may not substitute for in-cycle reporting — the next 8.1 cycle still carries the value (e-OSCAR AUD rule; 8.2-T14)");
    const required = f.bureaus.filter((b) => !(f.bureaus_with_own_acdv ?? []).includes(b));
    need(required, "bureaus");
    const purpose = f.purpose ?? "correction";
    const auds: Aud[] = required.map((b) => ({ audId: `AUD-${f.dispute_id}-${b}-${f.now.slice(0, 10)}`, bureau: b, accountNumber: f.account_number, fields: { ...f.fields }, reason: f.reason }));
    const invalid: string[] = [];
    for (const a of auds) { const v = await port.validateAud(a); if (!v.valid) invalid.push(`${a.bureau}: ${v.errors.join("; ")}`); }
    if (invalid.length) throw new DisputeRefused("AUD_INVALID", `fix the Metro 2 field errors and resubmit the same day — ${invalid.join(" | ")}`);
    const ids: string[] = []; let completed: string | null = null;
    for (const [i, a] of auds.entries()) {
      const s = await port.submitAud(a, f.now);
      const last = i === auds.length - 1;
      ids.push(s.audId); if (last) completed = s.submittedAt;
      this.emit("eoscar.aud.submitted", r.loanId!, f.dispute_id, { aud_id: s.audId, bureau: a.bureau, account_number: a.accountNumber, reason: a.reason, purpose, submitted_at: s.submittedAt, fields: Object.keys(a.fields), fan_out_complete: purpose === "correction" && last, remaining: auds.length - i - 1, duplicate: s.duplicate });
      const dofd = a.fields["date_of_first_delinquency"] ?? a.fields["dofd"];
      if (dofd && dofd !== "00000000") this.emit("credit.dofd.furnished", r.loanId!, f.dispute_id, { via: "aud", dofd, aud_id: s.audId });
    }
    return { aud_ids: ids, bureaus: [...required], completed_at: completed, in_cycle: true };
  }
  /**
   * Rule 5 / 8.2-T2: a `modified`/`deleted` outcome creates the `credit_reporting_corrections` row (8.1 runner: DOFD may
   * move only with evidence; DA/DF and ECOA Z need the officer) and issues the linked 4.1 servicing corrections —
   * `payment.reapply` for the misposted receipt and `fee.reverse` for every late charge assessed on an installment the
   * reapplied receipt satisfied within the grace period.
   */
  modifyCorrections(runner: CreditCycleRunner, f: { dispute_id: string; correction: Omit<CorrectionInput, "loan_id" | "source">; reapply?: { payment_id: string; deposited_on: PlainDate; amount_cents: bigint; to_installment_due: PlainDate; from: "suspense" | "unapplied" }; late_charges_assessed?: readonly { installment_due: PlainDate; assessed_on: PlainDate; amount_cents: bigint }[]; grace_days?: number }, approver?: Actor): { correction: ReturnType<CreditCycleRunner["createCorrection"]>["correction"]; commands: { command: "payment.reapply" | "fee.reverse"; [k: string]: unknown }[]; late_charges_reversed_cents: bigint } {
    const r = this.receipt(f.dispute_id); const loanId = r.loanId!;
    const source: CorrectionInput["source"] = r.payload.source === "acdv" ? "dispute_acdv" : "dispute_direct";
    const c = runner.createCorrection({ loan_id: loanId, source, ...f.correction }, approver);
    const commands: { command: "payment.reapply" | "fee.reverse"; [k: string]: unknown }[] = [];
    let reversed = 0n;
    if (f.reapply) {
      commands.push({ command: "payment.reapply", payment_id: f.reapply.payment_id, from: f.reapply.from, to_installment_due: f.reapply.to_installment_due, effective_date: f.reapply.deposited_on, amount_cents: f.reapply.amount_cents.toString(), rule_ref: "8.2 rule 5 / 4.1 payment.reapply" });
      const grace = f.grace_days ?? 15;
      for (const lc of f.late_charges_assessed ?? []) if (lc.installment_due <= f.reapply.to_installment_due && f.reapply.deposited_on <= addDays(lc.installment_due, grace)) { commands.push({ command: "fee.reverse", fee: "late_charge", installment_due: lc.installment_due, assessed_on: lc.assessed_on, amount_cents: lc.amount_cents.toString(), rule_ref: "8.2 rule 5 / 4.1 fee.reverse: receipt within grace" }); reversed += lc.amount_cents; }
    }
    this.emit("credit.dispute.servicing_correction.requested", loanId, f.dispute_id, { commands: commands.map((x) => ({ ...x })), correction_aud_due: c.correction.aud_due, late_charges_reversed_cents: reversed.toString(), via: "4.1 correction commands" });
    return { correction: c.correction, commands, late_charges_reversed_cents: reversed };
  }
  /** e-OSCAR status history (archive/notification polls): RESOLVED-RETURNEDTOAGENCY closes an ACDV; RESOLVED-NORESPONSEPROVIDED is the breach state that must never occur. */
  eoscarStatus(f: { control_number: string; status: string; at: string }): { dispute_id: string | null; breach: boolean } {
    const r = this.events.ofType("credit.dispute.acdv.received").find((e) => e.payload.control_number === f.control_number);
    const id = r ? String(r.payload.dispute_id) : null;
    const breach = f.status === ACDV_NO_RESPONSE_STATUS;
    this.emit("credit.dispute.eoscar_status", r?.loanId ?? null, id, { control_number: f.control_number, status: f.status, at: f.at, breach });
    if (breach) this.emit("credit.dispute.expired_no_response", r?.loanId ?? null, id, { control_number: f.control_number, at: f.at, severity: "sev1", escalate_to: "officer" });
    return { dispute_id: id, breach };
  }

  // ---- notices (direct) ----------------------------------------------------------------------------------------------
  private noticePayloadBase(disputeId: string, sentOn: PlainDate): { received_on: PlainDate; loan_id: string; days_after_receipt: number } {
    const r = this.receipt(disputeId);
    return { received_on: r.payload.received_on as PlainDate, loan_id: r.loanId!, days_after_receipt: daysBetween(r.payload.received_on as PlainDate, sentOn) };
  }
  /**
   * Rule 8: the results letter (each item, determination and reason; corrections and when they appear; CRA dispute
   * rights; the direct-dispute address; the human-review path on an adverse AI determination) through the Notice
   * Registry — `notice.sent{template=NTC_FCRA_1022_43E_RESULTS}` satisfies FCRA_1022_43E_DIRECT_RESULTS_30/EXT_45 —
   * then `credit.dispute.responded` for the direct channel (mailing is the response).
   */
  async sendResultsNotice(notices: NoticeService, f: { dispute_id: string; determination: Determination; recipients: readonly Recipient[]; items: readonly { item: string; determination: string; reason: string }[]; corrections: readonly string[]; adverse_ai: boolean; sent_at: string; dispute_address: string; servicer_phone: string; servicer_address: string }): Promise<{ notice: Notice; mailed_by_day_30: boolean; data_changed: boolean; aud_to: readonly Bureau[]; aud_due: PlainDate | null }> {
    const sentOn = etDate(f.sent_at); const base = this.noticePayloadBase(f.dispute_id, sentOn);
    const supp = this.ofDispute("credit.dispute.direct.supplemented", f.dispute_id).find((e) => e.payload.within_30 === true);
    const ext = (supp?.payload.extended_to as PlainDate | undefined) ?? null;
    const due = ext ?? (this.receipt(f.dispute_id).payload.results_due_on as PlainDate);
    // NTC_FCRA_1022_43E_RESULTS 1.1.0 (src/notices/authored/section8-2.ts): the period in force is 30 days, or 45 when supplemented within the 30 (§1681i(a)(1)(B))
    const n = notices.render({ templateCode: RESULTS_TEMPLATE, loanId: base.loan_id, recipients: f.recipients, asOf: sentOn, payload: { ...base, items: f.items.map((x) => ({ ...x })), corrections: [...f.corrections], adverse_ai: f.adverse_ai, human_review_offered: f.adverse_ai, dispute_address: f.dispute_address, servicer_phone: f.servicer_phone, servicer_address: f.servicer_address, results_due: due, results_period_days: ext ? 45 : 30, extended_to: ext, supplemented_on: (supp?.payload.supplemented_on as PlainDate | undefined) ?? null } });
    if (n.status === "held") throw new DisputeRefused("RESULTS_NOTICE_HELD", n.heldReason ?? "checklist failed");
    const sent = await notices.send(n.id);
    const changed = DATA_CHANGING.has(f.determination);
    const fan = changed ? correctionFanOut(sentOn, null, false, true, servicer) : null;
    this.emit("credit.dispute.responded", base.loan_id, f.dispute_id, { source: "direct", bureau: null, determination: f.determination, submitted_at: f.sent_at, notice_id: sent.id, data_changed: changed, aud_to: fan ? [...fan.aud_to] : [], aud_due: fan?.aud_due ?? null });
    return { notice: sent, mailed_by_day_30: sentOn <= due, data_changed: changed, aud_to: fan?.aud_to ?? [], aud_due: fan?.aud_due ?? null };
  }
  /** §1022.43(f)(2): the (f) notice — reasons and the standardized list of information required — by mail unless the consumer authorized another means; within 5 federal business days (FCRA_1022_43F_FRIVOLOUS_NOTICE_5BD satisfied by `notice.sent{template=NTC_FCRA_1022_43F_FRIVOLOUS}`). */
  async sendFrivolousNotice(notices: NoticeService, f: { dispute_id: string; recipients: readonly Recipient[]; sent_at: string; dispute_address: string; servicer_phone: string; servicer_address: string }): Promise<{ notice: Notice; mailed_by_due: boolean; business_days_after_determination: number }> {
    const det = this.last("credit.dispute.frivolous_determined", f.dispute_id);
    if (!det) throw new DisputeRefused("NO_FRIVOLOUS_DETERMINATION", `no human frivolous determination on ${f.dispute_id}`);
    const sentOn = etDate(f.sent_at); const base = this.noticePayloadBase(f.dispute_id, sentOn);
    const bd = businessDaysBetween(det.payload.determined_on as PlainDate, sentOn, federal);
    const n = notices.render({ templateCode: FRIVOLOUS_TEMPLATE, loanId: base.loan_id, recipients: f.recipients, asOf: sentOn, payload: { ...base, reason: (det.payload.reasons as string[]).join("; "), required_information: [...(det.payload.required_information as string[])], business_days_after_determination: bd, determined_by_human: true, dispute_address: f.dispute_address, servicer_phone: f.servicer_phone, servicer_address: f.servicer_address } });
    if (n.status === "held") throw new DisputeRefused("FRIVOLOUS_NOTICE_HELD", n.heldReason ?? "checklist failed");
    const sent = await notices.send(n.id);
    return { notice: sent, mailed_by_due: sentOn <= (det.payload.notice_due_on as PlainDate), business_days_after_determination: bd };
  }
  /** 8.2-Q4 policy acknowledgment (not required by Reg V): receipt date, expected results date, the direct-dispute address. */
  async sendAcknowledgment(notices: NoticeService, f: { dispute_id: string; recipients: readonly Recipient[]; sent_at: string; dispute_address: string; servicer_phone: string; servicer_address: string }): Promise<Notice> {
    const sentOn = etDate(f.sent_at); const base = this.noticePayloadBase(f.dispute_id, sentOn);
    const n = notices.render({ templateCode: ACK_TEMPLATE, loanId: base.loan_id, recipients: f.recipients, asOf: sentOn, payload: { ...base, results_due: this.receipt(f.dispute_id).payload.results_due_on, dispute_address: f.dispute_address, servicer_phone: f.servicer_phone, servicer_address: f.servicer_address } });
    if (n.status === "held") throw new DisputeRefused("ACK_NOTICE_HELD", n.heldReason ?? "checklist failed");
    return notices.send(n.id);
  }

  // ---- close ----------------------------------------------------------------------------------------------------------
  /**
   * `responded → closed` requires RESOLVED-RETURNEDTOAGENCY (ACDV) or the mailed results letter (direct) and, when the
   * determination changed data, the corrections row plus the completed AUD fan-out; `frivolous_pending → closed_frivolous`
   * requires the human determination and the (f) notice. The CCC transition (rule 6): XR after corrections, XC on verified
   * with stated disagreement, XH otherwise. `credit.dispute.closed{open_disputes_remaining=0}` releases the XB gate.
   */
  closeDispute(f: { dispute_id: string; determination: Determination; closed_at: string; continuing_disagreement?: boolean; out_of_scope?: boolean; mailing_evidence_document_id?: string }): { status: DisputeStatus; ccc_transition: Ccc; open_disputes_remaining: number } {
    const r = this.receipt(f.dispute_id); const p = r.payload; const loanId = r.loanId!; const acdv = p.source === "acdv";
    if (this.last("credit.dispute.closed", f.dispute_id)) throw new DisputeRefused("ALREADY_CLOSED", `${f.dispute_id} is closed`);
    let status: DisputeStatus = "closed";
    if (f.determination === "frivolous") {
      if (acdv) throw new DisputeRefused("ACDV_NEVER_FRIVOLOUS", "an ACDV is never deemed frivolous");
      if (!this.last("credit.dispute.frivolous_determined", f.dispute_id)) throw new DisputeRefused("FRIVOLOUS_NEEDS_HUMAN", "closed_frivolous requires the human determination");
      if (!this.noticeSentAfterReceipt(loanId, FRIVOLOUS_TEMPLATE, r.occurredAt)) throw new DisputeRefused("FRIVOLOUS_NOTICE_REQUIRED", "closed_frivolous requires the (f)(2) notice within 5 business days");
      status = "closed_frivolous";
    } else if (acdv) {
      const st = this.last("credit.dispute.eoscar_status", f.dispute_id)?.payload.status;
      const c = acdvCaseClose(String(st ?? this.last("credit.dispute.acdv.responded", f.dispute_id)?.payload.eoscar_status ?? "PENDING"), f.determination, f.continuing_disagreement);
      if (!c.closed) throw new DisputeRefused("CLOSE_REQUIRES_RETURNED", c.reason ?? `close requires ${ACDV_RETURNED_STATUS}`);
    } else {
      if (f.out_of_scope) status = "closed_out_of_scope";
      if (!this.noticeSentAfterReceipt(loanId, RESULTS_TEMPLATE, r.occurredAt) && !f.mailing_evidence_document_id) throw new DisputeRefused("MAILING_EVIDENCE_REQUIRED", "a direct dispute closes on mailing evidence of the results letter (§1022.43(e)(3)); an out-of-scope (b) exception is still answered by letter");
    }
    if (DATA_CHANGING.has(f.determination)) {
      if (!this.events.ofType("credit.correction.created").some((e) => e.loanId === loanId && e.occurredAt >= r.occurredAt)) throw new DisputeRefused("CORRECTION_ROW_REQUIRED", "a modified/deleted outcome closes only with its credit_reporting_corrections row (rule 5)");
      if (!this.ofDispute("eoscar.aud.submitted", f.dispute_id).some((e) => e.payload.fan_out_complete === true)) throw new DisputeRefused("AUD_FANOUT_REQUIRED", "a modified/deleted outcome closes only after AUDs to every other bureau that received the data (§1681s-2(b)(1)(D))");
    }
    const ccc = f.determination === "frivolous" ? "XH" : cccOnClose(f.determination, f.continuing_disagreement === true);
    const remaining = this.openDisputeIds(loanId).filter((id) => id !== f.dispute_id).length;
    this.emit("credit.dispute.closed", loanId, f.dispute_id, { status, determination: f.determination, ccc_transition: ccc, ccc_from: "XB", continuing_disagreement: f.continuing_disagreement === true, closed_at: f.closed_at, open_disputes_remaining: remaining, ccc_effective: "next cycle (AUD if >10 days away)" });
    return { status, ccc_transition: ccc, open_disputes_remaining: remaining };
  }
  private noticeSentAfterReceipt(loanId: string, template: string, since: string): boolean {
    return this.events.ofType("notice.sent").some((e) => e.loanId === loanId && e.payload.template === template && e.occurredAt >= since);
  }

  // ---- due-date watch, outage, identity theft, pre-boarding, XB gate -----------------------------------------------------
  /**
   * 8.2-T3 / FCRA_1681S2B_ACDV_RESPONSE_DUE breach column: no reviewer action by 80 % of the Response Due Date →
   * `officer` sev-1; by 90 % → the case auto-escalates to `officer` and enters the `human_agent` queue (the timers keep
   * running); absent action by the due date the agent submits a best-available response (a modify in the consumer's
   * favour with a follow-up correction) — never RESOLVED-NORESPONSEPROVIDED. Idempotent per threshold.
   */
  acdvDueDateWatch(f: { dispute_id: string; today: PlainDate; now: string }, escalations?: EscalationService): { plan: DueDatePlan; reviewed: boolean; responded: boolean; escalated_now: { to: string; threshold: number }[]; escalations: Escalation[] } {
    const r = this.receipt(f.dispute_id); const p = r.payload; const loanId = r.loanId!;
    if (p.source !== "acdv") throw new DisputeRefused("NOT_AN_ACDV", `${f.dispute_id} is a direct dispute — the results letter clock applies`);
    const clocks = acdvClocks(p.received_on as PlainDate, p.response_due_on as PlainDate, p.cra_received_at as PlainDate, p.consumer_supplied_information === true);
    const reviewed = !!this.last("credit.dispute.reviewed", f.dispute_id);
    const responded = !!this.last("credit.dispute.acdv.responded", f.dispute_id);
    const draft = (this.last("credit.dispute.investigated", f.dispute_id)?.payload.determination as Determination | undefined) ?? "verified_as_reported";
    const plan = dueDatePlan(clocks, f.today, reviewed, draft);
    const done: { to: string; threshold: number }[] = []; const opened: Escalation[] = [];
    if (responded) return { plan, reviewed, responded, escalated_now: done, escalations: opened };
    const already = new Set(this.ofDispute("credit.dispute.escalated", f.dispute_id).map((e) => Number(e.payload.threshold)));
    const fire = (threshold: number, to: "officer", queue: "human_agent" | null, severity: "sev1" | "sev2") => {
      if (already.has(threshold)) return;
      this.emit("credit.dispute.escalated", loanId, f.dispute_id, { to, queue, threshold, severity, at: f.now, response_due_on: p.response_due_on, reason: `no reviewer action by ${threshold * 100}% of the Response Due Date` });
      done.push({ to, threshold });
      if (escalations) {
        opened.push(escalations.open({ kind: "officer", loanId, severity, payload: { dispute_id: f.dispute_id, control_number: p.control_number, threshold, response_due_on: p.response_due_on, draft_determination: draft, package: "draft response, decision record, evidence with snapshots, consumer images, timer status, summary" } }, this.actor));
        if (queue) opened.push(escalations.open({ kind: "human_agent", loanId, payload: { dispute_id: f.dispute_id, control_number: p.control_number, threshold, queue: "unreviewed ACDV at 90% of the Response Due Date", response_due_on: p.response_due_on } }, this.actor));
      }
    };
    if (!reviewed && f.today >= (p.escalate_officer_on as PlainDate)) fire(0.8, "officer", null, "sev1");
    if (!reviewed && f.today >= clocks.escalate_on) fire(0.9, "officer", "human_agent", "sev1");
    return { plan, reviewed, responded, escalated_now: done, escalations: opened };
  }
  /**
   * 8.2-T11 / edge "e-OSCAR API outage": a 5xx / auth failure with the response due within 3 days → a `human_agent`
   * task carrying the exact response payload for web-app entry (interactive credentials are separate from the API
   * users); later items wait for the API. Tokens are cached (no per-call auth) — the outage is logged either way.
   */
  outageFallback(f: { dispute_id: string; response: AcdvResponse; today: PlainDate; now: string; outage_started_at: string; error: string }, escalations: EscalationService): { route: "human_web_app" | "wait_for_api"; outage_hours: number; task: Escalation | null } {
    const r = this.receipt(f.dispute_id); const p = r.payload; const loanId = r.loanId!;
    const due = String(p.response_due_on);
    const route = eoscarOutageRouting(due, f.today);
    const hours = Math.round(((Date.parse(f.now) - Date.parse(f.outage_started_at)) / 3_600_000) * 100) / 100;
    this.emit("credit.dispute.outage.routed", loanId, f.dispute_id, { route, outage_hours: hours, outage_started_at: f.outage_started_at, error: f.error, response_due_on: due, control_number: p.control_number });
    if (route !== "human_web_app") return { route, outage_hours: hours, task: null };
    const task = escalations.open({ kind: "human_agent", loanId, payload: { task: "eoscar_web_app_entry", dispute_id: f.dispute_id, control_number: p.control_number, bureau: p.bureau, response_due_on: due, response_payload: { controlNumber: f.response.controlNumber, responseCode: f.response.responseCode, accountFields: { ...f.response.accountFields }, ...(f.response.complianceConditionCode ? { complianceConditionCode: f.response.complianceConditionCode } : {}) }, credentials: "interactive e-OSCAR user (separate from API users)", outage_hours: hours } }, this.actor);
    return { route, outage_hours: hours, task };
  }
  /**
   * 8.2-T9 / rule 7 of 8.3: an identity-theft dispute code with a §1681c-2 block notification → `credit.block.notice.received`,
   * furnishing for the consumer stops immediately (the 8.3 suppression: omit_account, or delete_consumer / ECOA Z when we
   * never had liability — an `officer` decision), a `fraud` case opens, and the `officer` reviews any DF/ECOA Z.
   */
  identityTheftIntake(f: { dispute_id: string; party_id: string; block_notice: { control_number: string; cra: Bureau; received_at: string; identity_theft_report_id: string }; never_liable: boolean; requested_at: string }): IdentityTheftResponse & { review: ReviewDecision; furnishing_stops_immediately: true; delete_requires: "officer" } {
    const r = this.receipt(f.dispute_id); const p = r.payload; const loanId = r.loanId!;
    need(f.block_notice.control_number, "block_notice.control_number"); need(f.block_notice.identity_theft_report_id, "block_notice.identity_theft_report_id (§1681c-2(a): an identity theft report)");
    if (p.category !== "identity_theft" && p.category !== "not_mine" && p.category !== "mixed_file") throw new DisputeRefused("NOT_IDENTITY_THEFT", `${f.dispute_id} is a ${String(p.category)} dispute`);
    const receivedOn = etDate(f.block_notice.received_at);
    this.emit("credit.block.notice.received", loanId, f.dispute_id, { kind: "Block", control_number: f.block_notice.control_number, cra: f.block_notice.cra, party_id: f.party_id, received_at: f.block_notice.received_at, received_on: receivedOn, identity_theft_report_id: f.block_notice.identity_theft_report_id, action: "omit_account_immediately_and_open_fraud_case" });
    const it = identityTheftResponse({ party_id: f.party_id, received_on: receivedOn, never_liable: f.never_liable }, servicer);
    this.emit("case.fraud.opened", loanId, f.dispute_id, { loan_id: loanId, party_id: f.party_id, source: "8.2 identity-theft ACDV with §1681c-2 block notification", opened_at: f.requested_at, suppression: { reason: it.suppression.reason, mechanism: it.suppression.mechanism, codes: [...(it.suppression.codes ?? [])] } });
    const review = requiresHumanReview({ determination: f.never_liable ? "deleted_consumer" : "modified", confidence: 1, category: "identity_theft", channel: "acdv" });
    this.requestReview({ dispute_id: f.dispute_id, review, requested_at: f.requested_at, draft: { determination: f.never_liable ? "deleted_consumer" : "modified", confidence: 1, findings: [] } });
    return { ...it, review, furnishing_stops_immediately: true, delete_requires: "officer" };
  }
  /**
   * 8.2-T8 / rule 3(iii): a disputed pre-boarding item with neither the transferor's record nor the boarding
   * reconciliation is `unverifiable` — the month's history is deleted (PHP `D`: no payment history available) through a
   * `credit_reporting_corrections` row, the transferor is notified (records request under the transfer agreement; 5-BD
   * internal SLA), and condition (7) routes the case to `human_agent` while the prior-servicer records are incomplete.
   */
  preBoardingInvestigation(runner: CreditCycleRunner, f: { dispute_id: string; disputed_month: PlainDate; boarded_on: PlainDate; transferor: { name: string; contact: string }; transferor_record: boolean; boarding_reconciliation: boolean; substantiated: boolean; reported_php_char: string; determined_on: PlainDate; requested_at: string; confidence: number }): { determination: Determination; correction: ReturnType<CreditCycleRunner["createCorrection"]>["correction"] | null; transferor_notification: { to: string; kind: "dispute_unverifiable_records_request"; respond_by: PlainDate } | null; review: ReviewDecision } {
    if (f.disputed_month >= f.boarded_on) throw new DisputeRefused("NOT_PRE_BOARDING", `${f.disputed_month} is on or after boarding ${f.boarded_on}`);
    const inv = this.investigate({ dispute_id: f.dispute_id, determination: "verified_as_reported", confidence: f.confidence, findings: [{ claim: `late mark for ${f.disputed_month.slice(0, 7)} reported by the transferor`, finding: f.transferor_record || f.boarding_reconciliation ? "hand-off record consulted" : "no transferor record and no boarding reconciliation", effect: f.transferor_record || f.boarding_reconciliation ? "no_change" : "changes_outcome", why: "rule 3(iii): a furnisher may not verify what it cannot substantiate" }], requested_at: f.requested_at, pre_boarding: { transferor_record: f.transferor_record, boarding_reconciliation: f.boarding_reconciliation, substantiated: f.substantiated } });
    if (inv.determination === "verified_as_reported") return { determination: inv.determination, correction: null, transferor_notification: null, review: inv.review };
    const r = this.receipt(f.dispute_id); const loanId = r.loanId!;
    const source: CorrectionInput["source"] = r.payload.source === "acdv" ? "dispute_acdv" : "dispute_direct";
    const c = runner.createCorrection({ loan_id: loanId, source, fields_changed: [{ field: `payment_history_profile[${f.disputed_month.slice(0, 7)}]`, before: f.reported_php_char, after: inv.determination === "unverifiable" ? "D" : "0" }], evidence_document_id: null, determined_on: f.determined_on });
    const respondBy = addBusinessDays(f.determined_on, 5, servicer);
    this.emit("credit.dispute.transferor_notified", loanId, f.dispute_id, { transferor: f.transferor.name, contact: f.transferor.contact, disputed_month: f.disputed_month, determination: inv.determination, kind: "dispute_unverifiable_records_request", respond_by: respondBy, reason: "no hand-off evidence for the disputed period; the item is deleted as unverifiable (§1681s-2(b)(1)(E)); records requested under the transfer agreement (17.3/1.6)" });
    return { determination: inv.determination, correction: c.correction, transferor_notification: { to: f.transferor.name, kind: "dispute_unverifiable_records_request", respond_by: respondBy }, review: inv.review };
  }
}

/**
 * FCRA_1681S2A3_XB_FLAG_GATE breach column: "8.1 generator must carry XB for the consumer/account while open;
 * `metro2.file.render` asserts" — every included record of a loan with an open dispute carries CCC XB on the disputed
 * consumer's segment(s) (rule 6: XB on receipt from the next furnishing; an AUD when the next cycle is >10 days away).
 */
export function xbGateAssertion(build: CycleBuild, open: readonly { loan_id: string; party_id: string | null }[]): { asserted: true; records_checked: number } {
  let checked = 0;
  for (const o of open) {
    const rec = build.included.find((s) => s.loan_id === o.loan_id);
    if (!rec) continue;   // omitted / suppressed records carry no segment to flag
    checked++;
    const segs = rec.consumers.filter((c) => o.party_id === null || c.party_id === o.party_id);
    const missing = segs.filter((c) => c.ccc !== "XB");
    if (segs.length === 0 || missing.length) throw new CreditReportingRefused("XB_FLAG_GATE", `loan ${o.loan_id}: open dispute — segment(s) ${missing.map((c) => `${c.party_id}(${c.ccc || "none"})`).join(", ") || o.party_id} must carry CCC XB while the dispute is open (§1681s-2(a)(3))`);
  }
  return { asserted: true, records_checked: checked };
}
