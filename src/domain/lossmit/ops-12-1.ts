/**
 * §12.1 operating rules the acknowledgment handler runs beyond the pure calculators in application.ts and the
 * 12.1 block of ops.ts: the per-document receipt that arms the CA §2924.10 clock (T10), the §1024.41(k) carry-over
 * intake of a transferor's pending application (edge case "transfer-in mid-application"; 1.7's
 * `REGX_1024_41K2_TRANSFEREE_ACK_10`), the ≤45-days-before-sale path (rule 3, T5), the §1024.41(i) duplicative
 * intake (rule 8, T6/T7), the reasonable-date decision record (rule 5, T3), the (c)(2)(iv) facial-completion hold
 * (rule 7, T4), the NPRM review-cycle hold (rule 10, T11) and the day-6 breach response (T12). Every function is
 * pure: it validates the inbound record and returns the store row, the event payload and the escalation the
 * handler in src/app/tools/section12-1.ts persists — nothing here appends an event by itself.
 */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { ackDue, fortyFiveDayTest, protectionTier, reasonableDate, type ProtectionTier, type ReasonableDateInputs } from "./application.ts";
import { caPerDocumentAcks, nprmRfa, duplicativeDetermination, ackBreach, ACK_TIMER_CODES, type Hold, type Escalation } from "./ops.ts";
import { transferorClocks, transfereeAckDue, deemedReceived } from "../transfers/lossmit-inflight.ts";

const isDate = (s: unknown): s is PlainDate => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const requireDate = (v: unknown, field: string): PlainDate => { if (!isDate(v)) throw new RangeError(`${field} must be a YYYY-MM-DD date`); return v; };

// ============================================================ T10 — per-document receipt (data model `documents.doc_class`; CA §2924.10)
/** 12.1 data model: the `documents.doc_class` vocabulary a loss-mitigation submission may carry. */
export const DOC_CLASSES = ["form_710", "paystub", "w2", "tax_return", "bank_statement", "award_letter", "profit_loss", "hardship_letter", "death_certificate", "divorce_decree", "military_orders", "bk_schedules", "4506c", "listing_agreement", "purchase_contract", "hud1_cd", "other"] as const;
export type DocClass = (typeof DOC_CLASSES)[number];
export interface DocumentReceiptInput { readonly document_id: string; readonly loan_id: string; readonly doc_class: string; readonly received_on: PlainDate; readonly state: string; readonly section_2924_15?: boolean | null; readonly application_id?: string | null; readonly sha256?: string | null; readonly channel?: string | null; }
export interface DocumentReceipt {
  readonly document: { id: string; loan_id: string; application_id: string | null; doc_class: DocClass; received_on: PlainDate; state: string; section_2924_15: boolean; sha256: string | null; channel: string | null };
  /** `lossmit.document.received` — the trigger of `CA_CIV_2924_10_ACK_5BD` when `state=CA, section_2924_15=true`. */
  readonly event: { type: "lossmit.document.received"; payload: Record<string, unknown> };
  readonly ca_ack: { code: "NTC_CA_2924_10_ACK"; timer: "CA_CIV_2924_10_ACK_5BD"; ack_by: PlainDate; calendar: string } | null;
}
/**
 * Rule 12.1 (Cal. Civ. Code §2924.10; timer table `CA_CIV_2924_10_ACK_5BD`): every document received in connection with a
 * first-lien modification application on a §2924.15 loan is acknowledged within 5 business days of *that* receipt — one
 * clock per document, never one per application. The inbound record is validated (id, class, date) before anything is
 * recorded; a partial or illegible document is still `received` (edge case: "never silently ignored").
 */
export function documentReceipt(i: DocumentReceiptInput): DocumentReceipt {
  if (!i.document_id) throw new RangeError("document_id is required");
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!(DOC_CLASSES as readonly string[]).includes(i.doc_class)) throw new RangeError(`doc_class ${i.doc_class || "(empty)"} is not one of ${DOC_CLASSES.join(", ")}`);
  const receivedOn = requireDate(i.received_on, "received_on");
  const state = (i.state || "").toUpperCase();
  const section2924_15 = state === "CA" && i.section_2924_15 !== false;   // CA §2924.15: owner-occupied principal-residence first liens; the caller's loan fact narrows it, silence keeps the ack (over-inclusive is the safe default)
  const ack = section2924_15 ? caPerDocumentAcks("CA", [receivedOn])[0]! : null;
  const document = { id: i.document_id, loan_id: i.loan_id, application_id: i.application_id ?? null, doc_class: i.doc_class as DocClass, received_on: receivedOn, state, section_2924_15: section2924_15, sha256: i.sha256 ?? null, channel: i.channel ?? null };
  return {
    document,
    event: { type: "lossmit.document.received", payload: { document_id: i.document_id, application_id: document.application_id, doc_class: document.doc_class, received_on: receivedOn, receipt: receivedOn, state, section_2924_15: section2924_15, ca_ack_by: ack?.ack_by ?? null, sha256: document.sha256 } },
    ca_ack: ack ? { code: "NTC_CA_2924_10_ACK", timer: "CA_CIV_2924_10_ACK_5BD", ack_by: ack.ack_by, calendar: ack.calendar } : null,
  };
}

// ============================================================ edge case — transfer-in mid-application (§1024.41(k); 1.7 `REGX_1024_41K2_TRANSFEREE_ACK_10`)
/** The transferor's loss-mitigation file as 1.7 lands it in `transfer_lossmit_files` (the 12.1 `transfer.lossmit_file.get` tool reads the same rows). */
export interface TransferorLossmitFile { readonly received_at: PlainDate | null; readonly ack_sent_at: PlainDate | null; readonly status: string | null; readonly reasonable_date?: PlainDate | null; readonly complete_at?: PlainDate | null; readonly documents?: readonly string[]; }
const CLOSED_STATUSES = new Set(["closed", "withdrawn", "denied_final", "expired", "paid_off", "current"]);
export interface CarryoverIntake {
  readonly lossmit_pending: boolean; readonly ack_not_sent: boolean; readonly lossmit_ack_unexpired: boolean; readonly lossmit_ack_sent: boolean;
  readonly deemed_received_at: PlainDate | null; readonly transferor_ack_due: PlainDate | null; readonly transferee_ack_due: PlainDate | null;
  /** The clock the transferee owes: the (k)(2)(i) 10-day clock when the transferor's period was unexpired, the plain (b)(2) 5-day clock when the period had lapsed unsent (the transferee is newly subject), nothing when the ack was sent or nothing is pending. */
  readonly timer: "REGX_1024_41K2_TRANSFEREE_ACK_10" | "REGX_1024_41B2_LM_ACK_5" | null;
  readonly record: Record<string, unknown> | null;
  /** `transfer.in.completed{lossmit_pending, ack_not_sent, lossmit_ack_unexpired, transfer_date}` — the 12.1 spelling of the carry-over input; arms `REGX_1024_41K2_TRANSFEREE_ACK_10` when all three flags are true. */
  readonly event: { type: "transfer.in.completed"; payload: Record<string, unknown> };
  /** When the transferor's period had already lapsed unsent, the transferee is newly subject to §1024.41(b)(2): the ordinary receipt event with the transfer date as `received_date`. */
  readonly received_event: { type: "lossmit.application.received"; payload: Record<string, unknown> } | null;
}
/**
 * Rule 12.1 (comment 41(k)(1)-1; §1024.41(k)(2)(i)): documents the transferor received keep the transferor's date;
 * an application whose (b)(2) acknowledgment was not sent and whose 5-day period had not expired at the transfer date
 * is acknowledged within 10 federal business days of the transfer date (`REGX_1024_41K2_TRANSFEREE_ACK_10`); an
 * acknowledgment the transferor already sent is not re-sent (comment 41(k)(1)(i)-3).
 */
export function carryoverIntake(i: { readonly loan_id: string; readonly transfer_date: PlainDate; readonly file: TransferorLossmitFile | null; readonly rule_set?: string | null }): CarryoverIntake {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  const T = requireDate(i.transfer_date, "transfer_date");
  const f = i.file;
  const pending = Boolean(f && f.received_at && !CLOSED_STATUSES.has(f.status ?? ""));
  if (!pending || !f?.received_at) {
    return { lossmit_pending: false, ack_not_sent: false, lossmit_ack_unexpired: false, lossmit_ack_sent: false, deemed_received_at: null, transferor_ack_due: null, transferee_ack_due: null, timer: null, record: null,
      event: { type: "transfer.in.completed", payload: { transfer_date: T, lossmit_pending: false, ack_not_sent: false, lossmit_ack_unexpired: false, lossmit_ack_sent: false, deemed_received_at: null } }, received_event: null };
  }
  const receivedAt = requireDate(f.received_at, "file.received_at");
  const ackSent = f.ack_sent_at !== null && f.ack_sent_at !== undefined;
  if (ackSent) requireDate(f.ack_sent_at, "file.ack_sent_at");
  const clocks = transferorClocks(receivedAt, T);
  const unexpired = clocks.handoff_if_unsent;                       // the transferor's 5-day period had not run out at T
  const ackNotSent = !ackSent;
  const subjectAtTransferor = unexpired;                            // (k)(2)(i): the transferor was still inside its (b)(2) period
  const deemed = deemedReceived(receivedAt, true, T);               // transferor dates carry (comment 41(k)(1)-1)
  const transfereeDue = ackNotSent ? transfereeAckDue(T, subjectAtTransferor) : null;
  const timer = !ackNotSent ? null : unexpired ? "REGX_1024_41K2_TRANSFEREE_ACK_10" : "REGX_1024_41B2_LM_ACK_5";
  const status = f.status && !CLOSED_STATUSES.has(f.status) ? f.status : "incomplete";
  const record = { loan_id: i.loan_id, status, received_on: deemed, transferor_received_date: receivedAt, transfer_date: T, transferor_ack_sent_at: f.ack_sent_at ?? null, ack_due: transfereeDue ?? clocks.ack_due, rule_set: i.rule_set ?? "regx.lossmit.2013", reasonable_date: f.reasonable_date ?? null, complete_at: f.complete_at ?? null, carried_over: true, carryover_timer: timer };
  const payload = { transfer_date: T, lossmit_pending: true, ack_not_sent: ackNotSent, lossmit_ack_unexpired: unexpired, lossmit_ack_sent: ackSent, deemed_received_at: deemed, transferor_received_date: receivedAt, transferor_ack_due: clocks.ack_due, transferee_ack_due: transfereeDue, status };
  return { lossmit_pending: true, ack_not_sent: ackNotSent, lossmit_ack_unexpired: unexpired, lossmit_ack_sent: ackSent, deemed_received_at: deemed, transferor_ack_due: clocks.ack_due, transferee_ack_due: transfereeDue, timer, record,
    event: { type: "transfer.in.completed", payload },
    received_event: timer === "REGX_1024_41B2_LM_ACK_5" ? { type: "lossmit.application.received", payload: { status, received_date: T, deemed_received_at: deemed, transferor_received_date: receivedAt, newly_subject_transferee: true } } : null };
}

// ============================================================ rule 3 / T5 — application ≤45 days before a scheduled sale
export interface LateApplicationIntake { readonly b2_applies: false; readonly days_before_sale: number; readonly protection_tier: ProtectionTier; readonly d2205_notice: "NTC_FNMA_D2205_LATE_BRP_PLAN"; readonly d2205_notice_due: PlainDate; readonly expedited_review: true; readonly record: Record<string, unknown>; readonly event: { type: "lossmit.application.received_within_45_days"; payload: Record<string, unknown> }; }
/**
 * Rule 12.1 rule 3 (§1024.41(b)(2)(i); comment 41(b)(2)(i)-1): received within 45 days of a scheduled sale → no (b)(2)
 * acknowledgment duty, so the receipt is not the `lossmit.application.received` the ack clocks key on; Fannie Mae's
 * D2-2-05 "explanation of plan" acknowledgment goes out within 5 servicer business days and 12.2's expedited review is
 * queued. Returns null when (b)(2) applies (the ordinary receipt path runs).
 */
export function lateApplicationIntake(i: { readonly loan_id: string; readonly received_on: PlainDate; readonly sale_on: PlainDate | null; readonly application_id: string }): LateApplicationIntake | null {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  const receivedOn = requireDate(i.received_on, "received_on");
  const t = fortyFiveDayTest(receivedOn, i.sale_on);
  if (t.b2_applies || !i.sale_on) return null;
  const tier = protectionTier(receivedOn, i.sale_on);
  const record = { loan_id: i.loan_id, status: "received", received_on: receivedOn, foreclosure_sale_date_at_receipt: i.sale_on, protection_tier: tier.protection_tier, b2_applies: false, d2205_notice_due: t.d2205_notice_due, expedited_review: true, ack_due: null };
  return { b2_applies: false, days_before_sale: tier.days_before_sale!, protection_tier: tier.protection_tier, d2205_notice: "NTC_FNMA_D2205_LATE_BRP_PLAN", d2205_notice_due: t.d2205_notice_due!, expedited_review: true, record,
    event: { type: "lossmit.application.received_within_45_days", payload: { application_id: i.application_id, received_date: receivedOn, sale_date: i.sale_on, days_before_sale: tier.days_before_sale, b2_applies: false, protection_tier: tier.protection_tier, d2205_notice: "NTC_FNMA_D2205_LATE_BRP_PLAN", d2205_notice_due: t.d2205_notice_due, expedited_review: true } } };
}

// ============================================================ rule 8 / T6–T7 — §1024.41(i) duplicative application
export interface DuplicativeIntake { readonly duplicative: boolean; readonly refusal: string | null; readonly reviewer_required: boolean; readonly fnma_evaluation_required: true; readonly timers_started: readonly string[]; readonly courtesy_notice: "NTC_REGX_41I_DUPLICATIVE" | null; readonly determination: Record<string, unknown>; readonly record: Record<string, unknown> | null; readonly event: { type: "lossmit.application.duplicative"; payload: Record<string, unknown> } | null; }
/**
 * Rule 12.1 rule 8 (§1024.41(i); comments 41(i)-1, -2): duplicative only when a prior application by the same borrower
 * reached `complete`, was fully processed by Supermortgage (never a transferor) and the loan was never current since.
 * Removing the §1024.41 rights is a `lossmit_reviewer` decision (guardrail); once approved the application is recorded
 * `duplicative`, no (b)(2)/(c)(3) clocks start, Fannie Mae's evaluation still runs (§1024.38(b)(2)(v)) and the courtesy
 * notice goes out. A borrower who was current in between gets the full process (T7) — the caller then runs the ordinary
 * receipt path, which arms the acknowledgment clocks.
 */
export function duplicativeIntake(i: { readonly loan_id: string; readonly application_id: string; readonly received_on: PlainDate; readonly prior_complete_on: PlainDate; readonly prior_application_id?: string | null; readonly prior_fully_processed_by_us: boolean; readonly current_since_prior: boolean; readonly reviewer_approval_id?: string | null }): DuplicativeIntake {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  const receivedOn = requireDate(i.received_on, "received_on"); const priorOn = requireDate(i.prior_complete_on, "prior_complete_on");
  const d = duplicativeDetermination({ received_on: receivedOn, prior_complete_on: priorOn, prior_fully_processed_by_us: i.prior_fully_processed_by_us, current_since_prior: i.current_since_prior, reviewer_approval_id: i.reviewer_approval_id ?? null });
  const determination = { rule: "12 CFR 1024.41(i)", prior_application_id: i.prior_application_id ?? null, prior_complete_on: priorOn, prior_fully_processed_by_us: i.prior_fully_processed_by_us, current_since_prior: i.current_since_prior, duplicative: d.duplicative, reviewer_approval_id: i.reviewer_approval_id ?? null, determined_for: receivedOn };
  if (!d.duplicative || d.refusal) return { duplicative: d.duplicative, refusal: d.refusal, reviewer_required: d.reviewer_required, fnma_evaluation_required: true, timers_started: d.timers_started, courtesy_notice: d.courtesy_notice, determination, record: null, event: null };
  const record = { loan_id: i.loan_id, status: "duplicative", received_on: receivedOn, duplicative_of_application_id: i.prior_application_id ?? null, duplicative_determination: determination, ack_due: null, fnma_evaluation_required: true };
  return { duplicative: true, refusal: null, reviewer_required: true, fnma_evaluation_required: true, timers_started: [], courtesy_notice: "NTC_REGX_41I_DUPLICATIVE", determination, record,
    event: { type: "lossmit.application.duplicative", payload: { application_id: i.application_id, received_date: receivedOn, prior_application_id: i.prior_application_id ?? null, prior_complete_on: priorOn, reviewer_approval_id: i.reviewer_approval_id, fnma_evaluation_required: true, courtesy_notice: "NTC_REGX_41I_DUPLICATIVE", timers_started: [] as string[] } } };
}

// ============================================================ rule 5 / T1, T3 — reasonable-date decision record (`lossmit_applications.reasonable_date_basis`)
export interface ReasonableDateDecision { readonly reasonable_date: PlainDate; readonly basis: string; readonly milestone_conflict: boolean; readonly reasonable_date_basis: Record<string, unknown>; readonly escalation: Escalation | null; readonly timer: "REGX_1024_41B2II_REASONABLE_DATE"; }
/**
 * Rule 12.1 rule 5 (comments 41(b)(2)(ii)-1..-3): 30 days from the notice, capped at the earliest live milestone (document
 * staleness, day 120 of delinquency, sale−90, sale−38), never under 7 days; when the cap falls inside the floor the floor
 * wins and `milestone_conflict=true` routes the file to `lossmit_reviewer` for expedited handling (T3(b)). Every
 * milestone evaluated is recorded — the `reasonable_date_basis` jsonb the (b)(2) notice is audited against.
 */
export function reasonableDateDecision(i: ReasonableDateInputs): ReasonableDateDecision {
  const ackOn = requireDate(i.ack_sent_on, "ack_sent_on");
  const r = reasonableDate(i);
  const basis = { ack_sent_on: ackOn, default_ack_plus_30: addDays(ackOn, 30), floor_ack_plus_7: addDays(ackOn, 7), day_120_of_delinquency: i.earliest_unpaid_due ? addDays(i.earliest_unpaid_due, 119) : null, sale_minus_90: i.sale_on ? addDays(i.sale_on, -90) : null, sale_minus_38: i.sale_on ? addDays(i.sale_on, -38) : null, doc_staleness_90: i.oldest_doc_date ? addDays(i.oldest_doc_date, 90) : null, chosen: r.basis, milestone_conflict: r.milestone_conflict, citation: "12 CFR 1024.41(b)(2)(ii); comments 41(b)(2)(ii)-1..-3" };
  return { reasonable_date: r.date, basis: r.basis, milestone_conflict: r.milestone_conflict, reasonable_date_basis: basis, timer: "REGX_1024_41B2II_REASONABLE_DATE",
    escalation: r.milestone_conflict ? { kind: "lossmit_reviewer", severity: "sev2", reason: `milestone_conflict: the ${r.basis} — expedited handling (12.1-T3; comment 41(b)(2)(ii)-3)` } : null };
}

// ============================================================ rule 7 / T4 — the (c)(2)(iv) facial-completion hold (`foreclosure_holds`, consumed by 13.1/13.2)
export interface FacialHoldRecord { readonly kind: "regx_f2_prefiling" | "regx_g_dual_track"; readonly scope: readonly string[]; readonly opened_on: PlainDate; readonly rule_citation: string; readonly timer: "REGX_1024_41C2IV_FACIALLY_COMPLETE_HOLD"; }
/** Rule 12.1 rule 7 / timer table: facially complete → `regx_f2_prefiling` before the first notice or filing, `regx_g_dual_track` once foreclosure has been initiated (§1024.41(f)(2), (g)); the hold stays active through verification and the supplemental request. */
export function facialHold(i: { readonly facially_complete_on: PlainDate; readonly first_filing_made: boolean }): FacialHoldRecord {
  const on = requireDate(i.facially_complete_on, "facially_complete_on");
  return i.first_filing_made
    ? { kind: "regx_g_dual_track", scope: ["judgment_motion", "sale_schedule", "sale_conduct"], opened_on: on, rule_citation: "12 CFR 1024.41(g); (c)(2)(iv)", timer: "REGX_1024_41C2IV_FACIALLY_COMPLETE_HOLD" }
    : { kind: "regx_f2_prefiling", scope: ["refer", "first_notice"], opened_on: on, rule_citation: "12 CFR 1024.41(f)(2); (c)(2)(iv)", timer: "REGX_1024_41C2IV_FACIALLY_COMPLETE_HOLD" };
}

// ============================================================ rule 10 / T11 — NPRM review cycle
export interface NprmReviewCycle { readonly review_cycle_opened: boolean; readonly hold: Hold | null; readonly hold_record: { kind: "lm_review_cycle"; scope: readonly string[]; opened_on: PlainDate; rule_citation: string } | null; readonly notice: "NTC_REGX_41_NPRM_RFA_RECEIVED" | null; readonly days_before_sale: number | null; readonly status: "review_cycle_open" | "rfa_only"; }
/** Rule 12.1 rule 10: under `regx.lossmit.2024nprm` an RFA alone opens `review_cycle_open` and, when received more than 37 days before a sale, writes `foreclosure_holds{kind=lm_review_cycle}`; under the 2013 rule set an RFA opens nothing. */
export function nprmReviewCycle(i: { readonly regime: "2024nprm" | "2013"; readonly rfa_on: PlainDate; readonly sale_on: PlainDate | null; readonly oral: boolean }): NprmReviewCycle {
  const r = nprmRfa(i);
  return { review_cycle_opened: r.review_cycle_opened, hold: r.hold, notice: r.notice, days_before_sale: r.days_before_sale, status: r.review_cycle_opened ? "review_cycle_open" : "rfa_only",
    hold_record: r.hold ? { kind: "lm_review_cycle", scope: ["first_notice", "judgment_motion", "sale_conduct"], opened_on: i.rfa_on, rule_citation: "2024 NPRM proposed 12 CFR 1024.41(f)(2) (89 FR 60204)" } : null };
}

// ============================================================ T12 — day-6 breach response
export interface AckBreachResponse { readonly code: string; readonly escalation: Escalation & { readonly severity: "sev1" | "sev2" }; readonly noe_risk_flag: boolean; readonly ack_resend_required: true; readonly day6: PlainDate; readonly escalate_at_ms: number; readonly event: { type: "lossmit.ack.breached"; payload: Record<string, unknown> }; }
/**
 * Rule 12.1 timer table (`REGX_1024_41B2_LM_ACK_5` breach → `officer` sev-1, NoE-risk flag; `FNMA_D2205_BRP_ACK_5BD` →
 * `officer` sev-2): the 00:05 day-6 sweep opens the officer escalation, re-sends the acknowledgment under that
 * escalation (guardrail: never an ack after the clock without an `escalations` row) and — for the Reg X clock — flags the
 * loan as a §1024.35 notice-of-error risk. Any other code is not an acknowledgment breach and is refused.
 */
export function ackBreachResponse(i: { readonly code: string; readonly received_on: PlainDate; readonly timer_id: string; readonly tz?: string }): AckBreachResponse {
  if (!(ACK_TIMER_CODES as readonly string[]).includes(i.code)) throw new RangeError(`${i.code} is not one of the 12.1 acknowledgment clocks (${ACK_TIMER_CODES.join(", ")})`);
  const receivedOn = requireDate(i.received_on, "received_on"); const tz = i.tz ?? "America/New_York";
  const b = ackBreach({ received_on: receivedOn, produced: false, tz });
  const regx = i.code === "REGX_1024_41B2_LM_ACK_5";
  const severity: "sev1" | "sev2" = regx ? "sev1" : "sev2";
  const escalation = { kind: "officer" as const, severity, reason: regx ? `12.1: §1024.41(b)(2)(i)(B) acknowledgment not produced by ${ackDue(receivedOn, tz).due_on} (day 5); NoE-risk flag set (§1024.35(b)(7))` : `12.1: D2-2-05 acknowledgment not produced within 5 servicer business days of ${receivedOn}`, at_ms: b.escalation!.at_ms! };
  return { code: i.code, escalation, noe_risk_flag: regx, ack_resend_required: true, day6: b.day6, escalate_at_ms: zonedEpochMs(b.day6, "00:05", tz),
    event: { type: "lossmit.ack.breached", payload: { code: i.code, timer_id: i.timer_id, received_date: receivedOn, ack_due: ackDue(receivedOn, tz).due_on, day6: b.day6, severity, noe_risk_flag: regx, ack_resend_required: true } } };
}

/** Days from receipt to a scheduled sale, for the 45-day and protection-tier tests (null = no sale scheduled, treated as ≥45 / ≥90 — comments 41(b)(2)(i)-1, 41(b)(3)-1). */
export function daysBeforeSale(receivedOn: PlainDate, saleOn: PlainDate | null): number | null { return saleOn ? daysBetween(receivedOn, saleOn) : null; }
