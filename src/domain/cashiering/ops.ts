/**
 * §2 operations — the event-emitting layer over the pure calculators. Every
 * timer row in the section's registry is armed by an event some process emits
 * and satisfied by another; the calculators (partials, autodraft, curtailment,
 * biweekly, trial, latecharges) are pure, so this module is where the
 * `suspense.item.created`, `ach.r11.resolved`, `report.produced`,
 * `custodian.delivery.evidenced`, `trial_payment.satisfied`,
 * `late_charges.all_waived` … events named in `timers.ts` actually come from.
 * Money stays bigint cents; dates are PlainDate; nothing here edits a row —
 * state changes are new events and new versions.
 */
import { randomUUID } from "node:crypto";
import type { EventStore, Actor, DomainEvent } from "../../kernel/events/index.ts";
import { type PlainDate, addDays, addYears, endOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer, fannieEt, type Calendar } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type LoanCashState, type Fee } from "./types.ts";
import { allocate, type AllocationPlan } from "./allocation.ts";
import { openSuspenseItem, sweepReturns, reclassifyStaleHalves, recordForeclosureHoldDecision, type SuspenseItem, type PartialContext, type PartialDecision, type Commitment, type SuspenseReason } from "./partials.ts";
import { handleReturn, revocationEffect, returnRateReport, holdChannelForReview, canOriginateDebit, validateDraftDay, variableAmountNoticeStatus, type Enrollment, type ReturnCode, type ReturnRateStats, type ReturnRateReport, type ReturnDisposition, type SecCode } from "./autodraft.ts";
import { activateReamortizedTerms, reapplicationGate, type Reamortization } from "./curtailment.ts";
import type { Arrangement } from "./biweekly.ts";
import { trialReceipt, trialMonthEnd, trialCompletion, type TrialOverlay, type TrialReceiptResult } from "./trial.ts";
import { assessLateCharge, recordFee, waiveLateCharge, releaseSuspended, nsfFee, graceEndFor, receivedTowardBasis, type AssessmentInput, type AssessmentResult, type WaiverReason, type WaiverResult, type NsfJurisdiction } from "./latecharges.ts";

export const CASHIERING_OPS_ACTOR: Actor = { kind: "agent", id: "cashiering" };

export interface OpsDeps { readonly events: EventStore; readonly clock: { now(): string }; readonly calendar?: Calendar; readonly actor?: Actor; }
type Payload = Record<string, unknown>;
type Aggregate = { readonly kind: string; readonly id: string };

const str = (c: Cents): string => c.toString();

export class CashieringOps {
  private readonly events: EventStore;
  private readonly clock: { now(): string };
  private readonly cal: Calendar;
  private readonly actor: Actor;

  constructor(deps: OpsDeps) { this.events = deps.events; this.clock = deps.clock; this.cal = deps.calendar ?? servicer; this.actor = deps.actor ?? CASHIERING_OPS_ACTOR; }

  private emit(type: string, loanId: string | undefined, payload: Payload, aggregate?: Aggregate): DomainEvent {
    return this.events.append({ type, ...(loanId ? { loanId } : {}), ...(aggregate ? { aggregate } : {}), actor: this.actor, payload });
  }
  private queueNotice(loanId: string | undefined, template: string, payload: Payload, aggregate?: Aggregate): DomainEvent { return this.emit("notice.queued", loanId, { template, ...payload }, aggregate); }

  // ───────────────────────── 2.1 deposit evidence (`custodial_deposits` rows; FNMA_C1101_* clocks)
  /** The bank's credit evidence for a lockbox batch or a direct receipt — the events the 24-hour / 1-BD / 2-BD deposit timers are satisfied by. */
  recordDepositEvidence(subject: Aggregate, evidence: { clearing_deposited_at?: string; custodial_deposited_at?: string; bank_reference: string; custodial_account_id: string; payment_ids?: readonly string[]; evidence_document_id?: string }, loanId?: string): DomainEvent[] {
    const out: DomainEvent[] = [];
    const base = { bank_reference: evidence.bank_reference, custodial_account_id: evidence.custodial_account_id, payment_ids: [...(evidence.payment_ids ?? [])], evidence_document_id: evidence.evidence_document_id ?? null };
    if (evidence.clearing_deposited_at) out.push(this.emit("custodial_deposits.clearing_deposited_at", loanId, { ...base, clearing_deposited_at: evidence.clearing_deposited_at }, subject));
    if (evidence.custodial_deposited_at) out.push(this.emit("custodial_deposits.custodial_deposited_at", loanId, { ...base, custodial_deposited_at: evidence.custodial_deposited_at }, subject));
    return out;
  }

  // ───────────────────────── 2.2 suspense items (6.5's `suspense_items`; this process creates partial/remainder/trial holds)
  /** Open the item for a held partial — `suspense.item.created{partial_payment[, condition_commitment=unknown]}` arms the 30-day and the 2-BD commitment clocks. */
  openPartial(ctx: PartialContext, d: PartialDecision, reason: SuspenseReason = "partial_payment"): SuspenseItem {
    const item = openSuspenseItem(ctx, d, reason, this.cal);
    this.emit("suspense.item.created", item.loan_id, { suspense_item_id: item.id, payment_id: item.payment_id, reason_code: item.reason_code, [item.reason_code]: true, amount_cents: str(item.amount_cents), received_on: item.received_on,
      partial_commitment_due_on: item.partial_commitment_due_on, rule_path: item.rule_path, decision_cite: item.decision_cite ?? null, condition_commitment: d.kind === "contact_pending" ? "unknown" : "met", fc_decision_due_on: item.fc_decision_due_on ?? null }, { kind: "suspense_item", id: item.id });
    if (d.kind === "contact_pending") this.emit("borrower_comms.contact_requested", item.loan_id, { intent: "partial_commitment", suspense_item_id: item.id, within: "2 business_days_servicer", due_by: addBusinessDays(item.received_on, 2, this.cal) }, { kind: "suspense_item", id: item.id });
    return item;
  }
  /** `contact.completed{intent=partial_commitment}` — the borrower's commitment captured by borrower-comms (or a coupon note read from the image). */
  recordCommitmentContact(item: SuspenseItem, contact: { channel: string; commitment: Commitment; transcript_ref?: string }, on: PlainDate): SuspenseItem {
    if (item.status === "contact_pending") item.status = "open";
    if (!item.partial_commitment_due_on) item.partial_commitment_due_on = addDays(item.received_on, 30);
    this.emit("contact.completed", item.loan_id, { intent: "partial_commitment", suspense_item_id: item.id, channel: contact.channel, commitment_kind: contact.commitment.kind, stated_date: contact.commitment.stated_date ?? null, transcript_ref: contact.transcript_ref ?? null, completed_on: on, partial_commitment_due_on: item.partial_commitment_due_on }, { kind: "suspense_item", id: item.id });
    return item;
  }
  closeSuspenseItem(item: SuspenseItem, outcome: "matched" | "applied" | "reclassified" | "returned" | "refunded", on: PlainDate): DomainEvent {
    if (outcome === "applied" || outcome === "matched") item.status = "applied"; else if (outcome === "returned") item.status = "returned"; else if (outcome === "refunded") item.status = "refunded";
    return this.emit("suspense.item.closed", item.loan_id, { suspense_item_id: item.id, outcome, amount_cents: str(item.amount_cents), closed_on: on }, { kind: "suspense_item", id: item.id });
  }
  /** 2.2 rule 6 / T7: the day-31 sweep returns lapsed partials by the original rail with `SUSP-PARTIAL-RETURN-v1`. */
  sweepReturns(items: SuspenseItem[], today: PlainDate, pFor: (loanId: string) => Cents, sumOpen: (loanId: string) => Cents): SuspenseItem[] {
    const returned = sweepReturns(items, today, pFor, sumOpen);
    for (const it of returned) {
      this.emit("suspense.item.returned", it.loan_id, { suspense_item_id: it.id, amount_cents: str(it.amount_cents), rail: it.return_rail ?? null, returned_on: today, commitment_due_on: it.partial_commitment_due_on }, { kind: "suspense_item", id: it.id });
      this.queueNotice(it.loan_id, "SUSP-PARTIAL-RETURN-v1", { suspense_item_id: it.id, amount_cents: str(it.amount_cents), rail: it.return_rail ?? null, citation: "Servicing Guide C-1.1-02 (30-day commitment lapsed)" }, { kind: "suspense_item", id: it.id });
      this.emit("suspense.item.closed", it.loan_id, { suspense_item_id: it.id, outcome: "returned", amount_cents: str(it.amount_cents), closed_on: today }, { kind: "suspense_item", id: it.id });
    }
    return returned;
  }
  /** 2.5-T5 / `SM_BIWEEKLY_HALF_STALE_45`: a half unmatched for > 45 days is reclassified to `partial_payment` (30-day clock from today) and the borrower is contacted. */
  reclassifyStaleHalves(items: SuspenseItem[], today: PlainDate): SuspenseItem[] {
    const out = reclassifyStaleHalves(items, today);
    for (const it of out) {
      this.emit("suspense.item.closed", it.loan_id, { suspense_item_id: it.id, outcome: "reclassified", from: "biweekly_accumulation", to: "partial_payment", closed_on: today }, { kind: "suspense_item", id: it.id });
      this.emit("suspense.item.created", it.loan_id, { suspense_item_id: it.id, payment_id: it.payment_id, reason_code: "partial_payment", partial_payment: true, amount_cents: str(it.amount_cents), received_on: today, partial_commitment_due_on: it.partial_commitment_due_on, rule_path: it.rule_path, condition_commitment: "unknown", reclassified_from: "biweekly_accumulation" }, { kind: "suspense_item", id: it.id });
      this.emit("borrower_comms.contact_requested", it.loan_id, { intent: "stale_biweekly_half", suspense_item_id: it.id, reason: "no second half received within 45 days — the contractor appears to have stopped", due_by: addBusinessDays(today, 2, this.cal) }, { kind: "suspense_item", id: it.id });
    }
    return out;
  }
  /** 2.2-T6: the foreclosure case owner's accept-vs-return decision recorded against the item's 2-BD clock. */
  fcHoldDecision(item: SuspenseItem, decision: "accept_and_apply" | "return", decidedOn: PlainDate, decidedBy: string): SuspenseItem {
    recordForeclosureHoldDecision(item, decision, decidedOn, decidedBy);
    this.emit("suspense.fc_hold.decided", item.loan_id, { suspense_item_id: item.id, decision, decided_on: decidedOn, decided_by: decidedBy, due_on: item.fc_decision_due_on, on_time: item.fc_decision!.on_time, cite: "Servicing Guide C-1.1-02 (foreclosure position)" }, { kind: "suspense_item", id: item.id });
    return item;
  }

  // ───────────────────────── 2.3 autodraft lifecycle
  /** Authorization captured with every Nacha/Reg E element: `autodraft.enrollment.authorized` arms the 1-BD copy-delivery clock and (WEB/TEL) the validation gate. */
  authorizeEnrollment(e: Enrollment, authorizedOn: PlainDate): { copy_due_by: PlainDate } {
    e.status = "authorized"; e.authorized_on = authorizedOn;
    const copy_due_by = addBusinessDays(authorizedOn, 1, this.cal);
    this.emit("autodraft.enrollment.authorized", e.loan_id, { enrollment_id: e.id, sec_code: e.authorization.sec, authorized_at: authorizedOn, amount_rule: e.authorization.amount_rule, first_debit_on: e.authorization.first_debit_on }, { kind: "autodraft_enrollment", id: e.id });
    this.queueNotice(e.loan_id, "AUTODRAFT-CONFIRM-v1", { enrollment_id: e.id, due_by: copy_due_by, send_within: "1 business_days_servicer", citation: "12 CFR 1005.10(b); Nacha minimum authorization elements", channel_rule: e.authorization.esign_consent ? "electronic" : "mail" }, { kind: "autodraft_enrollment", id: e.id });
    return { copy_due_by };
  }
  /** The copy of the authorization delivered (`SM_AUTODRAFT_COPY_DELIVERY_1BD` satisfied by `notice.sent{enrollment_confirmation}`). */
  sendEnrollmentConfirmation(e: Enrollment, sentOn: PlainDate, channel: "electronic" | "mail" = e.authorization.esign_consent ? "electronic" : "mail"): DomainEvent {
    return this.emit("notice.sent", e.loan_id, { kind: "enrollment_confirmation", enrollment_confirmation: true, template: "AUTODRAFT-CONFIRM-v1", enrollment_id: e.id, sent_on: sentOn, channel, authorization_text_included: true }, { kind: "autodraft_enrollment", id: e.id });
  }
  /** A $0 prenote (PPD fallback) — `ach.prenote.transmitted` arms the 3-banking-day wait. */
  transmitPrenote(e: Enrollment, settlementOn: PlainDate): DomainEvent {
    e.status = "validating";
    return this.emit("ach.prenote.transmitted", e.loan_id, { enrollment_id: e.id, prenote_settlement_date: settlementOn, company_entry_description: "ACCTVERIFY" }, { kind: "autodraft_enrollment", id: e.id });
  }
  /** Validation result (API, prenote, micro-entries, NOC, history): `autodraft.validation.completed{status}`; a validated enrollment goes `active`. */
  completeValidation(e: Enrollment, status: "validated_api" | "validated_prenote" | "validated_microentry" | "validated_history" | "validated_noc" | "failed", on: PlainDate, nextDraftOn: PlainDate | null = null): Enrollment {
    const ok = status.startsWith("validated_");
    e.validation_status = ok ? "validated" : "failed";
    e.status = ok ? "active" : "requested";
    if (ok && nextDraftOn) e.next_draft_on = nextDraftOn;
    this.emit("autodraft.validation.completed", e.loan_id, { enrollment_id: e.id, status, validated_at: ok ? on : null, next_draft_on: e.next_draft_on }, { kind: "autodraft_enrollment", id: e.id });
    return e;
  }
  /** Schedule one entry: the C-1.1-03 gate (`autodraft.entry.scheduled` → evaluator) and the origination guardrails run before any file is built. */
  scheduleEntry(e: Enrollment, installmentDueDate: PlainDate, settlementDate: PlainDate, amountCents: Cents, opts: { graceDays?: number; today?: PlainDate } = {}): { ok: true; trace: string } | { ok: false; reason: string; gate: string } {
    const graceDays = opts.graceDays ?? 15;
    const can = canOriginateDebit(e);
    if (!can.ok) { this.emit("autodraft.entry.refused", e.loan_id, { enrollment_id: e.id, reason: can.reason, gate: can.gate, settlement_date: settlementDate }, { kind: "autodraft_enrollment", id: e.id }); return can; }
    // Reg E §1005.10(d)(1): a changed amount is transmitted only after the 10-day notice was sent; otherwise the entry is held and a sev-2 escalation raised (2.3-T3).
    const notice = variableAmountNoticeStatus(e, amountCents, settlementDate, opts.today ?? settlementDate);
    if (!notice.ok) {
      this.emit("autodraft.entry.held", e.loan_id, { enrollment_id: e.id, settlement_date: settlementDate, amount_cents: str(amountCents), reason: "variable-amount notice not sent 10 days before the debit", deadline: notice.deadline, action: notice.action }, { kind: "autodraft_enrollment", id: e.id });
      this.emit("escalation.requested", e.loan_id, { to: "cashiering", severity: "sev-2", reason: `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10: no notice for the ${settlementDate} debit of ${str(amountCents)}¢ by ${notice.deadline}`, enrollment_id: e.id }, { kind: "autodraft_enrollment", id: e.id });
      return { ok: false, reason: `10-day variable-amount notice not sent by ${notice.deadline} (${notice.action})`, gate: "REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10" };
    }
    const day = validateDraftDay(Number(settlementDate.slice(8, 10)), Number(installmentDueDate.slice(8, 10)), graceDays);
    if (!day.ok) return { ok: false, reason: day.reason, gate: "FNMA_C1103_DRAFT_BY_PENALTY_FREE_DATE_GATE" };
    const trace = `${e.id}:${settlementDate}`;
    this.emit("autodraft.entry.scheduled", e.loan_id, { enrollment_id: e.id, trace, installment_due_date: installmentDueDate, settlement_date: settlementDate, amount_cents: str(amountCents), grace_days: graceDays, company_entry_description: "MORTGAGE PMT" }, { kind: "autodraft_enrollment", id: e.id });
    return { ok: true, trace };
  }
  /** Reg E §1005.10(d)(1): the variable-amount notice, sent ≥ 10 days before the changed debit (`notice.sent{kind=variable_amount_10d}`). */
  sendVariableAmountNotice(e: Enrollment, amountCents: Cents, debitOn: PlainDate, sentOn: PlainDate, template = "AUTODRAFT-AMOUNT-CHANGE-v1"): DomainEvent {
    e.notices.push({ template, sent_on: sentOn, amount_cents: amountCents, debit_on: debitOn });
    return this.emit("notice.sent", e.loan_id, { kind: "variable_amount_10d", template, enrollment_id: e.id, amount_cents: str(amountCents), debit_on: debitOn, sent_on: sentOn, deadline: addDays(debitOn, -10), on_time: sentOn <= addDays(debitOn, -10), citation: "12 CFR 1005.10(d)(1)" }, { kind: "autodraft_enrollment", id: e.id });
  }
  /** 2.3 rule 6: a revocation through any channel; timely → the unsent entry is cancelled; after transmission → same-day refund + officer notice; retention class applied. */
  receiveRevocation(e: Enrollment, on: PlainDate, opts: { channel: "oral" | "written" | "portal" | "bank_stop"; scheduled_settlement_date: PlainDate; file_transmitted_on: PlainDate | null; trace?: string }): ReturnType<typeof revocationEffect> & { retention_until: PlainDate } {
    const agg = { kind: "autodraft_enrollment", id: e.id };
    this.emit("autodraft.revocation.received", e.loan_id, { enrollment_id: e.id, channel: opts.channel, received_on: on, scheduled_settlement_date: opts.scheduled_settlement_date }, agg);
    const eff = revocationEffect(on, opts.file_transmitted_on, opts.scheduled_settlement_date);
    if (eff.stop_entry) this.emit("ach.entry.cancelled", e.loan_id, { enrollment_id: e.id, trace: opts.trace ?? `${e.id}:${opts.scheduled_settlement_date}`, reason: "revocation", settlement_date: opts.scheduled_settlement_date }, agg);
    if (eff.refund_same_day) this.emit("ach.credit.refund_originated", e.loan_id, { enrollment_id: e.id, refund_on: opts.scheduled_settlement_date, sec_code: "PPD", direction: "credit", company_entry_description: "REFUND", same_day: true, reason: "debit settled after a timely revocation (treated as unauthorized)" }, agg);   // 2.3 rule 6: "refund by PPD credit the same day"
    if (eff.officer_notice) this.emit("escalation.requested", e.loan_id, { to: "officer", reason: "debit transmitted after a timely revocation", enrollment_id: e.id }, agg);
    e.status = "revoked";
    const retention_until = addYears(on, 2);
    this.emit("autodraft.revoked", e.loan_id, { enrollment_id: e.id, revoked_at: on, revocation_source: opts.channel, retention_until }, agg);
    this.emit("retention.class_applied", e.loan_id, { class: "tpsc_2y_post_revocation", enrollment_id: e.id, retention_until }, agg);
    this.queueNotice(e.loan_id, "AUTODRAFT-REVOKED-v1", { enrollment_id: e.id, revoked_on: on }, agg);
    return { ...eff, retention_until };
  }
  confirmRevocationInWriting(e: Enrollment, on: PlainDate): DomainEvent { return this.emit("autodraft.revocation.confirmed_in_writing", e.loan_id, { enrollment_id: e.id, confirmed_on: on }, { kind: "autodraft_enrollment", id: e.id }); }
  /** 2.3 rule 7: `ach.return.received{reason_code}` (arms the R01/R09 counter and the R11 window), the disposition, and `ach.r11.resolved` for R11. */
  handleReturn(e: Enrollment, code: ReturnCode, returnedOn: PlainDate, opts: Parameters<typeof handleReturn>[3] & { trace?: string; amount_cents?: Cents }): ReturnDisposition {
    const agg = { kind: "autodraft_enrollment", id: e.id };
    this.emit("ach.return.received", e.loan_id, { enrollment_id: e.id, reason_code: code, [code]: true, returned_on: returnedOn, return_settlement_date: returnedOn, original_settlement_date: opts.original_entry_on ?? null, trace: opts.trace ?? null, amount_cents: opts.amount_cents !== undefined ? str(opts.amount_cents) : null }, agg);
    const d = handleReturn(e, code, returnedOn, opts);
    if (d.notice) this.queueNotice(e.loan_id, d.notice, { enrollment_id: e.id, return_code: code, retry_on: d.retry_on, nsf_fee: d.assess_nsf_fee, ...(d.retry_on ? { with: "AUTODRAFT-RETRY-v1" } : {}) }, agg);
    if (d.retry_on) this.emit("ach.entry.reinitiation_scheduled", e.loan_id, { enrollment_id: e.id, retry_on: d.retry_on, company_entry_description: d.company_entry_description, reinitiation_of: opts.trace ?? null, reinitiation_count: e.reinitiations.length }, agg);
    if (code === "R11") this.emit("ach.r11.resolved", e.loan_id, { enrollment_id: e.id, outcome: d.enrollment_action === "correct_and_reinitiate" ? "corrected_reinitiated" : "not_reinitiated", corrected_on: d.retry_on, correction_window_ends_on: d.correction_window_ends_on ?? null, refused: d.refused ?? null }, agg);
    if (d.enrollment_action === "suspended_returns" || d.enrollment_action === "terminated" || d.enrollment_action === "revoked" || d.enrollment_action === "paused") {
      e.status = d.enrollment_action;
      this.emit(d.enrollment_action === "revoked" ? "autodraft.revoked" : "autodraft.status.changed", e.loan_id, { enrollment_id: e.id, status: e.status, return_code: code, ...(d.enrollment_action === "revoked" ? { revoked_at: returnedOn, retention_until: addYears(returnedOn, 2) } : {}) }, agg);
      // an unauthorized return cancels the enrollment (rule 7): the 2-year post-revocation retention class applies from the return date (NACHA_AUTH_RETENTION_2Y_POST_REVOCATION)
      if (d.enrollment_action === "revoked") this.emit("retention.class_applied", e.loan_id, { class: "tpsc_2y_post_revocation", enrollment_id: e.id, retention_until: addYears(returnedOn, 2) }, agg);
    }
    if (d.open_fraud_case) this.emit("fraud.case.opened", e.loan_id, { enrollment_id: e.id, return_code: code, reason: "unauthorized return against a valid authorization — dispute with the RDFI through the ODFI" }, agg);
    return d;
  }
  /** `NACHA_RETURN_RATE_MONTHLY_WATCH` / 2.3-T8: the 60-day report; a breaching channel notifies the officer and the ODFI and holds that channel's enrollments for review. */
  monthlyReturnRateWatch(enrollments: readonly Enrollment[], stats: readonly ReturnRateStats[], periodEnd: PlainDate): { report: ReturnRateReport; held: Enrollment[]; notified: ("officer" | "odfi")[] } {
    const report = returnRateReport(stats, periodEnd);
    this.emit("report.produced", undefined, { report: "nacha_return_rate", period_end: periodEnd, lookback_days: report.lookback_days, channels: report.channels.map((c) => ({ ...c })), breached_channels: [...report.breached_channels] }, { kind: "report", id: `nacha_return_rate:${periodEnd}` });
    const held: Enrollment[] = []; const notified: ("officer" | "odfi")[] = [];
    for (const c of report.channels.filter((x) => x.breaches.length > 0)) {
      this.emit("nacha.return_rate.threshold_breached", undefined, { channel: c.channel, breaches: [...c.breaches], unauthorized_bps: c.unauthorized_bps, administrative_bps: c.administrative_bps, overall_bps: c.overall_bps, period_end: periodEnd }, { kind: "report", id: `nacha_return_rate:${periodEnd}` });
      this.emit("escalation.requested", undefined, { to: "officer", severity: "sev-2", reason: `Nacha return-rate threshold breached on ${c.channel}: ${c.breaches.join(", ")}`, channel: c.channel, period_end: periodEnd }, { kind: "report", id: `nacha_return_rate:${periodEnd}` }); notified.push("officer");
      this.emit("odfi.notified", undefined, { channel: c.channel, breaches: [...c.breaches], period_end: periodEnd, report: "nacha_return_rate" }, { kind: "report", id: `nacha_return_rate:${periodEnd}` }); notified.push("odfi");
      for (const e of holdChannelForReview(enrollments, c.channel, periodEnd)) { held.push(e); this.emit("autodraft.enrollment.held_for_review", e.loan_id, { enrollment_id: e.id, channel: c.channel, reason: "return_rate_review", since: periodEnd }, { kind: "autodraft_enrollment", id: e.id }); }
    }
    return { report, held, notified };
  }
  adoptFraudPolicy(on: PlainDate, by: string): DomainEvent { return this.emit("policy.adopted", undefined, { policy: "nacha_fraud", adopted_on: on, last_reviewed_on: on, by }, { kind: "policy", id: "nacha_fraud" }); }
  /** Nacha Fraud Monitoring Phase 2: the officer's annual review (`policy.reviewed{nacha_fraud}` re-arms the 365-day recurrence). */
  recordFraudPolicyReview(on: PlainDate, by: string): DomainEvent { return this.emit("policy.reviewed", undefined, { policy: "nacha_fraud", nacha_fraud: true, reviewed_on: on, last_reviewed_on: on, by }, { kind: "policy", id: "nacha_fraud" }); }
  /** 2.5 case 3: an in-house split half settles (`autodraft.entry.settled{arrangement=inhouse_split, half=…}`). */
  settleSplitHalf(e: Enrollment, half: "first" | "second", settlementOn: PlainDate, amountCents: Cents, dueDate: PlainDate): DomainEvent {
    return this.emit("autodraft.entry.settled", e.loan_id, { enrollment_id: e.id, arrangement: "inhouse_split", half, settlement_date: settlementOn, due_date: dueDate, amount_cents: str(amountCents) }, { kind: "autodraft_enrollment", id: e.id });
  }

  // ───────────────────────── 2.4 re-amortization (Form 181) and reapplication
  /** Form 181 executed: `reamortizations.executed{executed_at}` arms the 10-BD custodian-delivery clock; the borrower gets `REAMORT-EFFECTIVE-v1` (also the Reg E 10-day notice for autodraft borrowers). */
  executeReamortization(state: LoanCashState, re: Reamortization, opts: { borrower_execution_required: boolean; signing_officer: string; emortgage?: boolean }): { reamortization_id: string } {
    const id = randomUUID();
    this.emit("reamortizations.executed", state.loan_id, { reamortization_id: id, executed_at: re.executed_on, effective_on: re.effective_on, basis_upb_cents: str(re.upb_cents), rate_pct: re.note_rate_pct, remaining_term_months: re.remaining_term_months, new_pi_cents: str(re.new_pi_cents), form: re.form, borrower_execution_required: opts.borrower_execution_required, signing_officer: opts.signing_officer, emortgage: opts.emortgage ?? false, counts_as_modification: re.counts_as_modification }, { kind: "reamortization", id });
    this.queueNotice(state.loan_id, "REAMORT-EFFECTIVE-v1", { reamortization_id: id, new_pi_cents: str(re.new_pi_cents), effective_on: re.effective_on, doubles_as_reg_e_10_day_notice: true }, { kind: "reamortization", id });
    return { reamortization_id: id };
  }
  /** The new `loan_terms` version takes effect: `loan_terms.activated` (arms LAR 83 / Reg E notice clocks) and the `rate_payment.change` investor event 5.1 submits. */
  activateReamortizedTerms(state: LoanCashState, re: Reamortization, reamortizationId: string, calculationDate: PlainDate, nextDraftOn: PlainDate | null = re.effective_on): { state: LoanCashState; loan_terms_version: number; lar83_due_by: PlainDate } {
    const r = activateReamortizedTerms(state, re);
    const lar83_due_by = addBusinessDays(calculationDate, 5, fannieEt);
    this.emit("loan_terms.activated", state.loan_id, { reason: "reamortization", reamortization_id: reamortizationId, loan_terms_version: r.loan_terms_version, effective_on: re.effective_on, new_pi_cents: str(re.new_pi_cents), calculation_date: calculationDate, scheduled_settlement_date: nextDraftOn, next_draft_on: nextDraftOn }, { kind: "reamortization", id: reamortizationId });
    this.emit("investor_events.created", state.loan_id, { type: "rate_payment.change", mode: "lar", lar_codes: ["83"], reamortization_id: reamortizationId, effective_date: re.effective_on, calculation_date: calculationDate, new_pi_cents: str(re.new_pi_cents), rate_pct: re.note_rate_pct, processed_at: this.clock.now(), due_by: lar83_due_by }, { kind: "reamortization", id: reamortizationId });
    return { ...r, lar83_due_by };
  }
  /** Delivery evidence for the executed Form 181 (custodian; eVault for eMortgages) — `custodian.delivery.evidenced{document=form_181}`. */
  recordForm181Delivery(loanId: string, reamortizationId: string, evidence: { delivered_on: PlainDate; custodian_id: string; document_id: string; evault_reference?: string }): DomainEvent {
    return this.emit("custodian.delivery.evidenced", loanId, { document: "form_181", reamortization_id: reamortizationId, delivered_on: evidence.delivered_on, custodian_id: evidence.custodian_id, document_id: evidence.document_id, evault_reference: evidence.evault_reference ?? null }, { kind: "reamortization", id: reamortizationId });
  }
  /** C-1.2-01 reapplication request: `curtailment.reapplication.requested` arms the four-condition gate; MBS loans are refused toward a 12.x workout. */
  requestReapplication(state: LoanCashState, facts: { current_before_curtailment: boolean; within_reapply_window: boolean; no_intervening_delinquency: boolean; borrower_requested_in_writing: boolean; amount_cents: Cents }): ReturnType<typeof reapplicationGate> {
    this.emit("curtailment.reapplication.requested", state.loan_id, { ...facts, amount_cents: str(facts.amount_cents), mbs_pool: state.mbs_pool ?? false });
    const gate = reapplicationGate(state);
    if (!gate.ok) this.emit("curtailment.reapplication.refused", state.loan_id, { reason: gate.reason, suggest: gate.suggest });
    return gate;
  }

  // ───────────────────────── 2.5 contractor arrangements
  /** A remittance arrived for the arrangement: `arrangement.updated{status=active}` (closes the previous 60-day dormancy clock; the receipt re-arms it). */
  recordContractorRemittance(a: Arrangement, on: PlainDate): Arrangement {
    a.status = "active"; a.last_remittance_on = on;
    this.emit("arrangement.updated", a.loan_id, { arrangement_id: a.id, status: "active", last_remittance_on: on, contractor_company_id: a.contractor_company_id }, { kind: "arrangement", id: a.id });
    return a;
  }
  markDormant(a: Arrangement, on: PlainDate): Arrangement {
    a.status = "dormant";
    this.emit("arrangement.updated", a.loan_id, { arrangement_id: a.id, status: "dormant", on }, { kind: "arrangement", id: a.id });
    this.emit("borrower_comms.contact_requested", a.loan_id, { intent: "contractor_autopay_stopped", arrangement_id: a.id, reason: "no contractor remittance for 60 days" }, { kind: "arrangement", id: a.id });
    return a;
  }
  endArrangement(a: Arrangement, on: PlainDate, reason: "borrower" | "payoff" | "transfer_out"): Arrangement {
    a.status = "ended";
    this.emit("arrangement.updated", a.loan_id, { arrangement_id: a.id, status: "ended", on, reason }, { kind: "arrangement", id: a.id });
    return a;
  }

  // ───────────────────────── 2.6 trial period plans
  /** 12.8's schedule handed to cashiering: one `lossmit.trial.started` per schedule row (each arms its own month-end deadline). */
  startTrial(trial: TrialOverlay): TrialOverlay {
    trial.months.forEach((m, i) => this.emit("lossmit.trial.started", undefined, { case_id: trial.case_id, loan_id: trial.loan_id, trial_number: i + 1, due_date: m.due_on, trial_amount_cents: str(m.amount_cents), month_end: endOfMonth(m.due_on) }, { kind: "trial_month", id: `${trial.case_id}:${i + 1}` }));
    return trial;
  }
  /** 2.6 rule 2 + rule 4: credit the receipt to the trial month, hold, apply a contractual installment on accumulation, report to SMDU upon receipt. */
  trialReceipt(trial: TrialOverlay, state: LoanCashState, amount: Cents, receivedOn: PlainDate, opts: { smduAvailable?: boolean } = {}): TrialReceiptResult & { smdu: "b2b" | "human_portal_task" } {
    const before = trial.applied_cents;
    const r = trialReceipt(trial, state, amount, receivedOn, opts.smduAvailable ?? true);
    const n = r.trial_month ? trial.months.indexOf(r.trial_month) + 1 : null;
    this.emit("trial_payment.received", trial.loan_id, { case_id: trial.case_id, trial_number: n, received_on: receivedOn, amount_cents: str(amount), cumulative_cents: r.trial_month ? str(r.trial_month.received_cents) : null, held_cents: str(trial.held_cents) });
    if (r.satisfied_now && n !== null) this.emit("trial_payment.satisfied", trial.loan_id, { case_id: trial.case_id, trial_number: n, due_date: r.trial_month!.due_on, received_on: receivedOn, cumulative_cents: str(r.trial_month!.received_cents) }, { kind: "trial_month", id: `${trial.case_id}:${n}` });
    if (r.contractual) this.emitContractualApplication(trial, state, r.contractual, receivedOn, trial.applied_cents - before);
    const via = (opts.smduAvailable ?? true) ? "b2b" : "human_portal_task";
    if (via === "b2b") this.emit("smdu.trial_payment.reported", trial.loan_id, { case_id: trial.case_id, trial_number: n, received_on: receivedOn, amount_cents: str(amount), via, reported_on: receivedOn });
    else this.emit("human_portal_task.created", trial.loan_id, { kind: "smdu_trial_payment", case_id: trial.case_id, trial_number: n, received_on: receivedOn, amount_cents: str(amount), sla: "1 business_days_fannie_et" });
    return { ...r, smdu: via };
  }
  /** The `fnma_portal_operator` finished the SMDU UI entry — the same event closes the 1-BD clock either way. */
  recordPortalTaskCompleted(trial: TrialOverlay, trialNumber: number, receivedOn: PlainDate, completedOn: PlainDate): DomainEvent {
    return this.emit("smdu.trial_payment.reported", trial.loan_id, { case_id: trial.case_id, trial_number: trialNumber, received_on: receivedOn, via: "human_portal_task", reported_on: completedOn });
  }
  private emitContractualApplication(trial: TrialOverlay, state: LoanCashState, plan: AllocationPlan, on: PlainDate, appliedCents: Cents): void {
    this.emit("suspense.accumulation.sufficient", trial.loan_id, { accumulated_on: on, credited_as_of: on, source: "trial_held_funds", case_id: trial.case_id, sum_cents: str(trial.held_cents + appliedCents), periodic_payment_cents: str(appliedCents) });
    for (const inst of plan.installments) {
      const ev = this.emit("payment.applied", trial.loan_id, { payment_id: `trial:${trial.case_id}:${on}`, installment_due_date: inst.due_date, interest_cents: str(inst.interest_cents), principal_cents: str(inst.principal_cents), escrow_cents: str(inst.escrow_cents), upb_after_cents: str(inst.upb_after_cents), credited_as_of: on, allocation_outcome: "applied", source: "trial_held_funds" });
      this.events.append({ type: "investor_events.created", loanId: trial.loan_id, actor: this.actor, causationId: ev.id, payload: { type: "payment.contractual", mode: "event", lar_codes: ["96"], effective_date: on, processed_at: this.clock.now(), lpi_date: inst.due_date, upb_cents: str(inst.upb_after_cents), interest_cents: str(inst.interest_cents), principal_cents: str(inst.principal_cents), rate_pct: state.note_rate_pct, pi_cents: str(inst.interest_cents + inst.principal_cents), suspense_balance_cents: str(trial.held_cents) } });
    }
    // 2.6 rule 2: the accumulated periodic payment is posted through the Allocation Engine with credited_as_of = the accumulation date — the posting
    // (`payment.posted{outcome=applied}`) is what closes REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD (§1026.36(c)(1)(ii); 2.5's spelling of "contractual installment applied").
    this.emit("payment.posted", trial.loan_id, { payment_id: `trial:${trial.case_id}:${on}`, outcome: plan.outcome, credited_as_of: on, received_on: on, amount_cents: str(appliedCents), rule_path: "2.6:r2:accumulation", source: "trial_held_funds", channel: "trial_held_funds", case_id: trial.case_id, installments: plan.installments.map((i) => i.due_date) }, { kind: "payment", id: `trial:${trial.case_id}:${on}` });
    this.queueNotice(trial.loan_id, "TRIAL-FUNDS-APPLIED-v1", { case_id: trial.case_id, installment_due_date: plan.installments[0]?.due_date ?? null, applied_cents: str(appliedCents), held_cents: str(trial.held_cents), citation: "Servicing Guide C-1.1-02" });
  }
  /**
   * 2.6 month-end sweep / T3: an unsatisfied trial month → `trial_payment.missed`, `lossmit.trial.failed`, the SMDU case cancelled (F-1-22),
   * suspended late charges collectible, and the held funds follow 2.2 (apply if ≥ PITI, else a `partial_payment` item with borrower contact).
   */
  trialMonthEnd(trial: TrialOverlay, state: LoanCashState, monthEnd: PlainDate, opts: { cancelSmduCase?: (caseId: string) => void; partial?: Omit<PartialContext, "state" | "received_on" | "amount_cents"> } = {}): { missed: ReturnType<typeof trialMonthEnd>["missed"]; failed: boolean; released: Fee[]; funds: { outcome: "applied" | "partial_payment_opened" | "none"; item: SuspenseItem | null; plan: AllocationPlan | null } } {
    const r = trialMonthEnd(trial, monthEnd);
    if (!r.failed || !r.missed) return { ...r, released: [], funds: { outcome: "none", item: null, plan: null } };
    const n = trial.months.indexOf(r.missed) + 1;
    this.emit("trial_payment.missed", trial.loan_id, { case_id: trial.case_id, trial_number: n, due_date: r.missed.due_on, month_end: monthEnd, received_cents: str(r.missed.received_cents), trial_amount_cents: str(r.missed.amount_cents) }, { kind: "trial_month", id: `${trial.case_id}:${n}` });
    this.emit("lossmit.trial.failed", trial.loan_id, { case_id: trial.case_id, failed_on: monthEnd, trial_number: n, held_cents: str(trial.held_cents), cite: "Servicing Guide D2-3.2-06" });
    opts.cancelSmduCase?.(trial.case_id);
    this.emit("smdu.case.cancelled", trial.loan_id, { case_id: trial.case_id, reason: "trial_failed", cite: "Servicing Guide F-1-22", on: monthEnd });
    const released = releaseSuspended(state, "trial_pending_waiver");
    for (const f of released) this.emit("fee.released", trial.loan_id, { fee_id: f.id, fee_type: f.fee_type, amount_cents: str(f.amount_cents), installment_due_date: f.installment_due_date, reason: "trial_failed: suspended late charges become collectible (D2-3.2-06)" });
    this.queueNotice(trial.loan_id, "TRIAL-FAILED-FUNDS-v1", { case_id: trial.case_id, held_cents: str(trial.held_cents), citation: "Servicing Guide C-1.1-02; D2-3.2-06" });
    // Held funds follow 2.2 (rule 6): Σ ≥ PITI → apply; the remainder is an ordinary partial with borrower contact.
    const oldest = state.installments.filter((i) => i.status === "due").sort((a, b) => (a.due_date < b.due_date ? -1 : 1))[0];
    const P = oldest ? oldest.pi_cents + oldest.escrow_cents : 0n;
    if (oldest && trial.held_cents >= P) {
      const plan = allocate({ ...state, trial_active: false, suspense_unapplied_cents: 0n }, { payment_id: `trial_failed:${trial.case_id}`, amount_cents: trial.held_cents, received_on: monthEnd, credited_as_of: monthEnd, designation: "contractual", bypass_overlays: true });
      trial.held_cents -= plan.installments.reduce((s, i) => s + i.interest_cents + i.principal_cents + i.escrow_cents, 0n);
      this.emit("trial.held_funds.resolved", trial.loan_id, { case_id: trial.case_id, outcome: "applied", installments: plan.installments.length, remaining_held_cents: str(trial.held_cents), on: monthEnd });
      return { ...r, released, funds: { outcome: "applied", item: null, plan } };
    }
    if (trial.held_cents > 0n) {
      const ctx: PartialContext = { state, received_on: monthEnd, amount_cents: trial.held_cents, days_delinquent: opts.partial?.days_delinquent ?? 0, payment_id: opts.partial?.payment_id ?? `trial_failed:${trial.case_id}`, rail: opts.partial?.rail ?? "ach_credit", commitment: null };
      const item = this.openPartial(ctx, { kind: "contact_pending", rule_path: "2.6:r6:trial_failed→2.2", cite: "Servicing Guide C-1.1-02" });
      return { ...r, released, funds: { outcome: "partial_payment_opened", item, plan: null } };
    }
    return { ...r, released, funds: { outcome: "none", item: null, plan: null } };
  }
  /** Held funds after a failed trial resolved (applied, applied to a successor workout, or returned) within `SM_TRIAL_FAILED_FUNDS_RESOLVE_30`. */
  resolveFailedTrialFunds(trial: TrialOverlay, outcome: "applied" | "successor_workout" | "returned", on: PlainDate): DomainEvent {
    const held = trial.held_cents; trial.held_cents = 0n;
    return this.emit("trial.held_funds.resolved", trial.loan_id, { case_id: trial.case_id, outcome, amount_cents: str(held), on });
  }
  /** Trial complete: `lossmit.trial.completed` arms the residual gate; `trial.residual.applied` (arrears interest first, then escrow advances; excess curtails) closes it before booking. */
  trialCompletion(trial: TrialOverlay, arrears: { interest_cents: Cents; escrow_advances_cents: Cents }, modificationEffectiveOn: PlainDate): ReturnType<typeof trialCompletion> {
    this.emit("lossmit.trial.completed", trial.loan_id, { case_id: trial.case_id, modification_effective_date: modificationEffectiveOn, held_cents: str(trial.held_cents) });
    const done = trialCompletion(trial, arrears);
    this.emit("trial.residual.applied", trial.loan_id, { case_id: trial.case_id, residual_cents: str(done.residual_cents), applied_to_interest_cents: str(done.applied_to_interest_cents), applied_to_escrow_advances_cents: str(done.applied_to_escrow_advances_cents), curtailment_cents: str(done.curtailment_cents), capitalized_interest_cents: str(done.capitalized_interest_cents), applied_on: addDays(modificationEffectiveOn, -1), modification_effective_date: modificationEffectiveOn, late_charges_in_capitalization_cents: "0" });
    this.queueNotice(trial.loan_id, "TRIAL-COMPLETE-FUNDS-v1", { case_id: trial.case_id, residual_cents: str(done.residual_cents), citation: "Servicing Guide C-1.1-02; F-1-27" });
    return done;
  }
  /** Conversion: `lossmit.modification.effective` → every late charge on the loan waived the same day (`late_charges.all_waived{reason=trial_conversion}`), none capitalized. */
  modificationEffective(trial: TrialOverlay, state: LoanCashState, effectiveOn: PlainDate): Cents {
    this.emit("lossmit.modification.effective", trial.loan_id, { case_id: trial.case_id, effective_date: effectiveOn });
    const total = this.waiveAll(state, "trial_conversion", this.actor, effectiveOn);
    trial.status = "modification_effective";
    return total;
  }

  // ───────────────────────── 2.7 late-charge engine runs
  /** The daily run for one installment: `late_charge.assessment.run` (gates armed), `late_charge.grace_gate.opened` once past the grace end, and one decision event either way. */
  runAssessment(input: AssessmentInput): AssessmentResult {
    const loanId = input.state.loan_id;
    const grace_end_on = graceEndFor(input.state, input.installment_due_date, this.cal);
    // 2.7 rule 1: the engine runs the credited-funds test itself (`receivedTowardBasis`) unless the caller carries the credited figure.
    const i: AssessmentInput & { received_toward_basis_cents: Cents } = { ...input, received_toward_basis_cents: input.received_toward_basis_cents ?? receivedTowardBasis(input.state, input.installment_due_date, this.cal) };
    this.emit("late_charge.assessment.run", loanId, { installment_due_date: i.installment_due_date, run_on: i.run_on, grace_end_on, received_toward_basis_cents: str(i.received_toward_basis_cents), received_derived_from_state: input.received_toward_basis_cents === undefined, unposted_receipts_on_or_before_grace: i.unposted_receipts_on_or_before_grace });
    if (i.run_on > grace_end_on) this.emit("late_charge.grace_gate.opened", loanId, { installment_due_date: i.installment_due_date, grace_end_on, opened_on: i.run_on });
    const r = assessLateCharge(i);
    if (r.outcome === "assessed" || r.outcome === "accrued_suspended") {
      recordFee(i.state, r.fee);
      this.emit("fee.assessed", loanId, { fee_id: r.fee.id, fee_type: "late_charge", late_charge: true, installment_due_date: r.fee.installment_due_date, amount_cents: str(r.fee.amount_cents), state: r.fee.state, suppression: r.fee.suppression ?? null, assessed_on: r.fee.assessed_on, grace_end_on: r.grace_end_on }, { kind: "fee", id: r.fee.id });
      this.emit("payment.cycle.unpaid_day16", loanId, { due_date: i.installment_due_date, grace_end_on: r.grace_end_on, late_charges_due_cents: str(i.state.late_charges_due_cents) });
    }
    this.emit("late_charge.assessment.decided", loanId, { installment_due_date: i.installment_due_date, outcome: r.outcome, reason: r.outcome === "not_assessed" ? r.reason : null, grace_end_on: r.grace_end_on, decided_on: i.run_on, ...(r.outcome === "assessed" || r.outcome === "accrued_suspended" ? { fee_id: r.fee.id, amount_cents: str(r.fee.amount_cents) } : {}) });
    return r;
  }
  /** A waiver command (`late_charge.waive{courtesy}` arms the counter gate); the waiver itself is `fee.waived{<reason>}`. */
  waive(state: LoanCashState, feeId: string, reason: WaiverReason, actor: Actor, on: PlainDate): WaiverResult {
    this.emit("late_charge.waive", state.loan_id, { fee_id: feeId, reason, courtesy: reason === "courtesy", by: `${actor.kind}:${actor.id}${actor.role ? `:${actor.role}` : ""}`, courtesy_waivers_12m_before: state.courtesy_waivers_12m ?? 0 }, { kind: "fee", id: feeId });
    const r = waiveLateCharge(state, feeId, reason, actor);
    if (r.ok) {
      this.emit("fee.waived", state.loan_id, { fee_id: feeId, reason, [reason]: true, waived_cents: str(r.waived_cents), waived_on: on, by: `${actor.kind}:${actor.id}` }, { kind: "fee", id: feeId });
      this.queueNotice(state.loan_id, "LC-WAIVER-CONFIRM-v1", { fee_id: feeId, reason, waived_cents: str(r.waived_cents), optional: true }, { kind: "fee", id: feeId });
    } else this.emit("late_charge.waive.refused", state.loan_id, { fee_id: feeId, reason, code: r.code, why: r.reason }, { kind: "fee", id: feeId });
    return r;
  }
  /** Waive every open late charge (trial conversion, workout completion, SCRA): `fee.waived` per fee and one `late_charges.all_waived{reason}`. */
  waiveAll(state: LoanCashState, reason: WaiverReason, actor: Actor, on: PlainDate): Cents {
    let total = 0n; let count = 0;
    for (const f of state.fees ?? []) if (f.fee_type === "late_charge" && (f.state === "assessed" || f.state === "accrued_suspended")) { const r = this.waive(state, f.id, reason, actor, on); if (r.ok) { total += r.waived_cents; count++; } }
    this.emit("late_charges.all_waived", state.loan_id, { reason, total_cents: str(total), count, on, capitalized_cents: "0" });
    return total;
  }
  /** 2.7 rule 7 / T10: the returned-payment fee where authority exists, once per returned item, with `LC-NSF-FEE-v1`. */
  assessNsf(state: LoanCashState, j: NsfJurisdiction, opts: { our_error: boolean; returned_on: PlainDate; return_code: string; payment_id?: string }): Fee | null {
    const fee = nsfFee(state, j, opts);
    if (!fee) {
      const duplicate = !!opts.payment_id && (state.fees ?? []).some((f) => f.fee_type === "nsf_fee" && f.returned_payment_id === opts.payment_id && f.state !== "reversed");
      this.emit("nsf_fee.not_assessed", state.loan_id, { return_code: opts.return_code, returned_on: opts.returned_on, payment_id: opts.payment_id ?? null, reason: !j.allowed ? "jurisdiction does not allow NSF fees" : opts.our_error ? "return caused by our error" : duplicate ? "already assessed once for this returned item" : "overlay (bankruptcy/SCRA/forbearance)" });
      return null;
    }
    recordFee(state, fee);
    this.emit("fee.assessed", state.loan_id, { fee_id: fee.id, fee_type: "nsf_fee", amount_cents: str(fee.amount_cents), state: fee.state, assessed_on: fee.assessed_on, return_code: opts.return_code, payment_id: opts.payment_id ?? null, cap_cents: j.cap_cents === null ? null : str(j.cap_cents) }, { kind: "fee", id: fee.id });
    this.queueNotice(state.loan_id, "LC-NSF-FEE-v1", { fee_id: fee.id, amount_cents: str(fee.amount_cents), return_code: opts.return_code, authority: "loan documents / state law (jurisdiction_rules.nsf_fee)", with: "AUTODRAFT-RETURN-v1" }, { kind: "fee", id: fee.id });
    return fee;
  }
}
