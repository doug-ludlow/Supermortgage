/**
 * §13.9 operating rules the tool path runs over the calculators in scra.ts and ops.ts — the events the process's
 * registry rows arm on and are satisfied by, each validated here and appended by the 13.9 ops of
 * `scra.case.get/open/close` (src/app/tools/section13-9.ts, delegated from the 13.8 block of src/app/tools/section13.ts;
 * 13.9 names no tools of its own in agents.json):
 *   - `scra.request.received{sufficient_evidence, received_on, basis, within_statutory_window, honored}` (op=rate_request):
 *     written notice + orders / DMDC certificate / Form 180 (rule 1); a request after the 180-day window is honoured on
 *     verified service (policy); SM_SCRA_RATE_ACTIVATE_5BD arms only on sufficient evidence; SCRA_3937B1_NOTICE_WINDOW_180
 *     is satisfied by any request; a written assertion without evidence → `scra.orders.requested` + attorney (T9);
 *   - `scra.rate_reduction.applied{period_id, capped_rate, method, effective_due, mbs, activated_on, …}` (op=rate_activate)
 *     with `scra.recalculation.completed{forgiven_cents}`, `scra.subsidy.activated`, `scra.relief.started{kind=interest_rate_cap}`,
 *     the rule-7 reallocation postings and the D2-3.4-01 letters (`notice.sent{template}`) — the money math is code
 *     (rules 4–7, 10) from the loan's baseline `loan_terms`, never from the caller;
 *   - `form_1022.sent{channel, due_by}` (op=form_1022_sent) and the inbound Fannie Mae acknowledgements (op=fnma_ack):
 *     `form_1022.acknowledged`, `fnma.upload.accepted{kind=form_1022}` (MBS CD15), `investor.event.accepted{kind=lar_83}` (ARM 83);
 *   - `arm.adjustment.scheduled{scra_cap_active=true}` + `investor.event.submitted{kind=lar_83}` (op=arm_adjustment, rule 3);
 *   - `scra.subsidy.recalculated` (op=subsidy_recalc, F-1-19 "at least annually");
 *   - `custodial.receipt.matched{kind=scra_subsidy}` / `custodial.receipt.exception` (op=custodial_receipt, the designated
 *     military-indulgence custodial account feed, 6.x reconciliation; officer informed above $10k aggregate shortfall);
 *   - `scra.overpayment.elected{election}` + `scra.overpayment.election_recorded` (op=election; op=election_lapse applies
 *     decision 13.9-3 after 30 days and tells the borrower);
 *   - `scra.rate_period.tail_started{cap_ends_on}` (13.8 op=close → `scra.period.ended`), `notice.sent{NTC_SCRA_3937_RATE_END}`
 *     (op=rate_end_letter, 60 days before restoration) and `scra.rate_reduction.ended` (op=restore — blocked through `cap_ends_on`).
 * Dates are PlainDate; cents are bigint; nothing here reads the store — the handlers pass facts in and append what comes back.
 */
import { type PlainDate, addDays, addMonths, parts, ymd, startOfMonth, endOfMonth } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { balanceAfter } from "../lossmit/flexmod.ts";
import { recalculate, capEffectivePaymentDue, cappedRate, capEndsOn, restorationInstallment, endDateLetterDue, servicingFee, requestWithinStatute, type RecalcRow } from "./scra.ts";
import { form1022Schedule, lateChargeWaiver, overpaymentElection, defaultElection, assertedServiceWithoutEvidence, armAdjustment, type Posting } from "./ops.ts";

export interface EmittedEvent { readonly type: string; readonly payload: Record<string, unknown>; }
export interface Escalation { readonly kind: "attorney" | "officer" | "human_agent" | "fnma_portal_operator"; readonly severity?: "sev1" | "sev2" | "sev3"; readonly reason: string; }
export type RateBasis = "orders" | "dmdc" | "form_180";
export type CapMethod = "standard" | "interest_subsidy";
export type PeriodStatus = "requested" | "active" | "tail" | "ended" | "declined";
export type Election = "refund" | "curtailment" | "apply_to_installment";
export const ELECTIONS: readonly Election[] = ["refund", "curtailment", "apply_to_installment"];
export const FORM_1022_REASONS = ["rate_reduction", "payment_change", "other_indulgence", "rate_restoration"] as const;
export type Form1022Reason = (typeof FORM_1022_REASONS)[number];
export type Form1022Channel = "email_form1022" | "mbs_upload" | "transaction_83";
/** Decision 13.9-1: default amortization method (F-1-19 Interest Subsidy). */
export const DEFAULT_METHOD: CapMethod = "interest_subsidy";
/** F-1-19: servicing fee on the UPB at the beginning of each month (0.25%/yr), never a percentage-of-interest factor. */
export const SERVICING_FEE_PCT = "0.25";
/** Policy: the officer is informed when Fannie Mae funding shortfalls exceed $10,000 in aggregate. */
export const OFFICER_SHORTFALL_THRESHOLD_CENTS: Cents = 1_000_000n;
/** Decision 13.9-3: the default election when the borrower does not choose within 30 days. */
export const DEFAULT_ELECTION: Election = "curtailment";

const monthsBetween = (a: PlainDate, b: PlainDate): number => { const pa = parts(a), pb = parts(b); return (pb.y - pa.y) * 12 + (pb.m - pa.m); };
const yyyymm = (d: PlainDate): string => d.slice(0, 7);
const refuseWith = <T extends { allowed: boolean; refusal: string | null }>(base: Omit<T, "allowed" | "refusal">, refusal: string): T => ({ ...(base as T), allowed: false, refusal });

// ============================================================ intake (`scra.request.received`; rule 1; T9/T10)
export interface RateRequestInput {
  readonly loan_id: string; readonly received_on: PlainDate; readonly channel: string; readonly written_notice: boolean;
  readonly orders_document_id?: string | null; readonly dmdc_certificate_id?: string | null; readonly form_180_document_id?: string | null;
  /** The loan's latest DMDC status on file (13.8 `scra_verifications`) — a Y is verified service. */
  readonly dmdc_status_on_file: "Y" | "N" | "Z" | null;
  readonly origination_on: PlainDate | null; readonly service_begin_on: PlainDate; readonly service_end_on?: PlainDate | null; readonly note_rate_pct: string;
}
export interface RateRequestResult {
  readonly allowed: boolean; readonly refusal: string | null; readonly sufficient_evidence: boolean; readonly basis: RateBasis | null;
  readonly within_statutory_window: boolean | null; readonly honored: boolean; readonly cap_effective_payment_due: PlainDate; readonly statutory_effective_on: PlainDate;
  readonly cap_ends_on: PlainDate | null; readonly request_orders: boolean; readonly escalation: Escalation | null; readonly events: readonly EmittedEvent[];
}
/**
 * Rule 1: a pre-service obligation (origination < service begin) bearing more than 6%; evidence = written notice (any
 * written channel; a call is logged and a written confirmation requested) + orders **or** a DMDC certificate / Form 180
 * (policy). §3937(b)(1): the request is the servicemember's statutory right within 180 days after release; later requests
 * are honoured on verified service (policy; edge cases). Rule 2: `cap_effective_payment_due` is the first payment due
 * after entry (D2-3.4-01); `statutory_effective_on` is the call-up date (§3937(b)(2)).
 */
export function rateRequest(i: RateRequestInput): RateRequestResult {
  const effectiveDue = capEffectivePaymentDue(i.service_begin_on);
  const capEnds = i.service_end_on ? capEndsOn(i.service_end_on) : null;
  const window = i.service_end_on ? requestWithinStatute(i.service_end_on, i.received_on).statutory : null;
  const base = { sufficient_evidence: false, basis: null, within_statutory_window: window, honored: false, cap_effective_payment_due: effectiveDue, statutory_effective_on: i.service_begin_on, cap_ends_on: capEnds, request_orders: false, escalation: null, events: [] as EmittedEvent[] };
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (!i.written_notice) return refuseWith<RateRequestResult>(base, `a ${i.channel || "call"} alone is not written notice — log the contact and request a written confirmation (50 U.S.C. 3937(b)(1); rule 1)`);
  if (!i.origination_on) return refuseWith<RateRequestResult>(base, "origination_on is required (loans.origination_date) — §3937 covers obligations incurred before service");
  if (!(i.origination_on < i.service_begin_on)) return refuseWith<RateRequestResult>(base, `origination ${i.origination_on} is not before service began ${i.service_begin_on} — not a pre-service obligation (50 U.S.C. 3937(a)(1))`);
  if (i.service_end_on && i.service_end_on < i.service_begin_on) return refuseWith<RateRequestResult>(base, `service_end_on ${i.service_end_on} precedes service_begin_on ${i.service_begin_on}`);
  if (cappedRate(i.note_rate_pct) === i.note_rate_pct) return refuseWith<RateRequestResult>(base, `the note rate ${i.note_rate_pct}% does not exceed 6% — nothing to cap (50 U.S.C. 3937(a)(1))`);
  const basis: RateBasis | null = i.orders_document_id ? "orders" : i.form_180_document_id ? "form_180" : i.dmdc_certificate_id || i.dmdc_status_on_file === "Y" ? "dmdc" : null;
  const sufficient = basis !== null;
  const honored = sufficient;   // policy: a request after the 180-day window is honoured on verified service (edge cases)
  const common = { loan_id: i.loan_id, received_on: i.received_on, channel: i.channel, written_notice: true, basis, sufficient_evidence: sufficient, within_statutory_window: window, honored, service_begin_on: i.service_begin_on, service_end_on: i.service_end_on ?? null, cap_effective_payment_due: effectiveDue, statutory_effective_on: i.service_begin_on, cap_ends_on: capEnds, orders_document_id: i.orders_document_id ?? null, dmdc_certificate_id: i.dmdc_certificate_id ?? null, form_180_document_id: i.form_180_document_id ?? null };
  if (!sufficient) {
    const a = assertedServiceWithoutEvidence({ written_assertion: true, dmdc_status: i.dmdc_status_on_file ?? "N", orders_document_id: i.orders_document_id ?? null });
    return { allowed: true, refusal: null, sufficient_evidence: false, basis: null, within_statutory_window: window, honored: false, cap_effective_payment_due: effectiveDue, statutory_effective_on: i.service_begin_on, cap_ends_on: capEnds, request_orders: a.request_orders,
      escalation: a.escalation ? { kind: "attorney", reason: a.escalation.reason } : null,
      events: [{ type: "scra.request.received", payload: common }, { type: "scra.orders.requested", payload: { loan_id: i.loan_id, received_on: i.received_on, reason: "written assertion of service; DMDC not Y and no orders — no denial without attorney review (13.9 guardrail)" } }] };
  }
  return { allowed: true, refusal: null, sufficient_evidence: true, basis, within_statutory_window: window, honored, cap_effective_payment_due: effectiveDue, statutory_effective_on: i.service_begin_on, cap_ends_on: capEnds, request_orders: false, escalation: null, events: [{ type: "scra.request.received", payload: common }] };
}

/** The attorney's denial after review (13.9 guardrail: "no denial without `attorney` review when service is asserted in writing"). */
export function declineRequest(i: { actor_role: string | null; status: string; reason: string; decided_on: PlainDate }): { allowed: boolean; refusal: string | null; event: EmittedEvent | null } {
  if (i.actor_role !== "attorney") return { allowed: false, refusal: "a request asserting service in writing is denied only by the attorney after review (13.9 guardrail)", event: null };
  if (i.status !== "requested") return { allowed: false, refusal: `only a requested period can be declined (status ${i.status || "none"})`, event: null };
  if (!i.reason) return { allowed: false, refusal: "reason is required — verification must show no qualifying service", event: null };
  return { allowed: true, refusal: null, event: { type: "scra.rate_request.declined", payload: { reason: i.reason, decided_on: i.decided_on, reviewed_by: "attorney" } } };
}

// ============================================================ activation (`scra.rate_reduction.applied`; rules 2–7, 10; T1/T2/T6)
export interface ActivationInput {
  readonly period_id: string; readonly loan_id: string; readonly status: string; readonly sufficient_evidence: boolean; readonly activated_on: PlainDate; readonly method: CapMethod; readonly mbs: boolean;
  readonly original_principal_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly first_payment_due: PlainDate; readonly pi_cents: Cents;
  readonly service_begin_on: PlainDate; readonly service_end_on: PlainDate | null; readonly next_due_on: PlainDate;
  readonly late_charges: readonly { readonly fee_id: string; readonly assessed_on: PlainDate; readonly cents: Cents; readonly paid: boolean }[];
}
export interface ActivationResult {
  readonly allowed: boolean; readonly refusal: string | null; readonly status: "active" | "tail"; readonly capped_rate: string; readonly cap_effective_payment_due: PlainDate; readonly cap_ends_on: PlainDate | null;
  readonly first_n: number; readonly upb_before_cap_cents: Cents; readonly paid_at_note_rate_count: number; readonly remaining_term_after: number; readonly delinquent_at_entry: boolean;
  readonly rows: readonly RecalcRow[]; readonly forgiven_total_cents: Cents; readonly upb_after_cents: Cents; readonly new_payment_cents: Cents; readonly standard_payment_cents: Cents; readonly subsidy_payment_cents: Cents;
  readonly next_interest_capped_cents: Cents; readonly scheduled_principal_cents: Cents; readonly fnma_differential_cents: Cents; readonly servicing_fee_cents: Cents; readonly new_payment_due: PlainDate;
  readonly late_charges_waived_cents: Cents; readonly late_charges_refunded_cents: Cents; readonly late_charge_fee_ids: readonly string[]; readonly overpayment_cents: Cents; readonly shortfall_cents: Cents; readonly sufficient_alone: boolean;
  readonly postings: readonly Posting[]; readonly investor_postings: readonly Posting[]; readonly events: readonly EmittedEvent[];
}
/**
 * The deterministic recalculation (rule 5) from the baseline loan terms: installment #n for `cap_effective_payment_due`,
 * the UPB before it (the original schedule), every installment due on/after it and already paid at the note rate
 * (`next_due_on` is the first unpaid one), the forgiven interest per installment (rule 10 rounding), the new payment
 * (rule 4: subsidy = scheduled principal + UPB × 6%/12; standard = re-amortization over the remaining term), the Fannie
 * Mae differential and the servicing fee on UPB (rule 6). Late charges assessed in the cap window are waived (unpaid) or
 * refunded into the overpayment (paid) — §3937(d), D2-3.4-01. Rule 7 postings: Dr `scra_interest_forgiven` (contra to
 * interest income) / Cr `scra_overpayment_payable` per installment; MBS: Dr `fnma_military_indulgence_receivable` /
 * Cr `interest_income` for the month's differential.
 */
export function activateRatePeriod(i: ActivationInput): ActivationResult {
  const effectiveDue = capEffectivePaymentDue(i.service_begin_on);
  const capEnds = i.service_end_on ? capEndsOn(i.service_end_on) : null;
  const empty: Omit<ActivationResult, "allowed" | "refusal"> = { status: capEnds ? "tail" : "active", capped_rate: cappedRate(i.note_rate_pct), cap_effective_payment_due: effectiveDue, cap_ends_on: capEnds, first_n: 0, upb_before_cap_cents: 0n, paid_at_note_rate_count: 0, remaining_term_after: 0, delinquent_at_entry: false, rows: [], forgiven_total_cents: 0n, upb_after_cents: 0n, new_payment_cents: 0n, standard_payment_cents: 0n, subsidy_payment_cents: 0n, next_interest_capped_cents: 0n, scheduled_principal_cents: 0n, fnma_differential_cents: 0n, servicing_fee_cents: 0n, new_payment_due: i.next_due_on, late_charges_waived_cents: 0n, late_charges_refunded_cents: 0n, late_charge_fee_ids: [], overpayment_cents: 0n, shortfall_cents: 0n, sufficient_alone: false, postings: [], investor_postings: [], events: [] };
  if (i.status !== "requested") return refuseWith<ActivationResult>(empty, `only a requested period activates (status ${i.status || "none"})`);
  if (!i.sufficient_evidence) return refuseWith<ActivationResult>(empty, "the request stands without sufficient evidence (written notice + orders, a DMDC certificate or Form 180) — orders were requested; no activation and no denial without attorney review (rule 1; 13.9 guardrail)");
  if (!(i.original_principal_cents > 0n) || !(i.pi_cents > 0n) || !(i.term_months > 0)) return refuseWith<ActivationResult>(empty, "loan_terms baseline (original_principal_cents, pi_cents, term_months) is required — money math is code");
  if (cappedRate(i.note_rate_pct) === i.note_rate_pct) return refuseWith<ActivationResult>(empty, `the note rate ${i.note_rate_pct}% does not exceed 6% — nothing to cap`);
  const firstN = monthsBetween(i.first_payment_due, effectiveDue) + 1;
  if (firstN < 1) return refuseWith<ActivationResult>(empty, `cap_effective_payment_due ${effectiveDue} precedes the first payment due ${i.first_payment_due}`);
  if (firstN > i.term_months) return refuseWith<ActivationResult>(empty, `cap_effective_payment_due ${effectiveDue} is past the loan's term`);
  const delinquentAtEntry = i.next_due_on < effectiveDue;
  const paid = delinquentAtEntry ? 0 : monthsBetween(effectiveDue, i.next_due_on);
  const remaining = i.term_months - (firstN - 1) - paid;
  if (remaining < 1) return refuseWith<ActivationResult>(empty, "no installments remain after the paid-at-note-rate run");
  const upbBefore = balanceAfter(i.original_principal_cents, i.note_rate_pct, i.term_months, firstN - 1);
  const r = recalculate({ upb_cents: upbBefore, note_rate_pct: i.note_rate_pct, pi_cents: i.pi_cents, first_capped_due: effectiveDue, first_n: firstN, paid_at_note_rate_count: paid, remaining_term_after: remaining });
  const newPayment = i.method === "standard" ? r.next_payment_standard_cents : r.next_payment_subsidy_cents;
  const newPaymentDue = delinquentAtEntry ? effectiveDue : i.next_due_on;
  const lc = lateChargeWaiver({ charges: i.late_charges, cap_effective_due: effectiveDue, cap_ends_on: capEnds ?? ymd(9999, 12, 31) });
  const overpayment = r.forgiven_total_cents + lc.refunded_cents;
  const sufficient = overpayment >= newPayment; const shortfall = sufficient ? 0n : newPayment - overpayment;
  const postings: Posting[] = [];
  for (const row of r.rows) if (row.forgiven_cents > 0n) postings.push({ account: "scra_interest_forgiven", debit: row.forgiven_cents, credit: 0n, rule_ref: "13.9.rule7.reallocation" }, { account: "scra_overpayment_payable", debit: 0n, credit: row.forgiven_cents, rule_ref: "13.9.rule7.reallocation" });
  if (lc.waived_cents > 0n) postings.push({ account: "late_charge_income", debit: lc.waived_cents, credit: 0n, rule_ref: "13.9.rule5.late_charge_waiver" }, { account: "late_charges", debit: 0n, credit: lc.waived_cents, rule_ref: "13.9.rule5.late_charge_waiver" });
  if (lc.refunded_cents > 0n) postings.push({ account: "late_charge_income", debit: lc.refunded_cents, credit: 0n, rule_ref: "13.9.rule5.late_charge_refund" }, { account: "scra_overpayment_payable", debit: 0n, credit: lc.refunded_cents, rule_ref: "13.9.rule5.late_charge_refund" });
  const investor: Posting[] = i.mbs && r.fnma_differential_cents > 0n ? [{ account: "fnma_military_indulgence_receivable", debit: r.fnma_differential_cents, credit: 0n, rule_ref: "13.9.rule7.mbs_receivable" }, { account: "interest_income", debit: 0n, credit: r.fnma_differential_cents, rule_ref: "13.9.rule7.mbs_receivable" }] : [];
  const status: "active" | "tail" = capEnds ? "tail" : "active";
  const reductionMonthStart = startOfMonth(i.activated_on);
  const events: EmittedEvent[] = [
    { type: "scra.rate_reduction.applied", payload: { period_id: i.period_id, loan_id: i.loan_id, capped_rate: cappedRate(i.note_rate_pct), pre_cap_rate: i.note_rate_pct, method: i.method, effective_due: effectiveDue, statutory_effective_on: i.service_begin_on, mbs: i.mbs, status, activated_on: i.activated_on, reduction_month_start: reductionMonthStart, form_1022_bd_anchor_on: endOfMonth(i.activated_on), cap_ends_on: capEnds, new_payment_cents: newPayment, new_payment_due: newPaymentDue, pre_cap_pi_cents: i.pi_cents, servicing_fee_cents: servicingFee(r.upb_after_cents, SERVICING_FEE_PCT) } },
    { type: "scra.recalculation.completed", payload: { period_id: i.period_id, count: r.rows.length, forgiven_cents: r.forgiven_total_cents, overpayment_cents: overpayment, late_charges_waived_cents: lc.waived_cents, late_charges_refunded_cents: lc.refunded_cents, upb_after_cents: r.upb_after_cents, delinquent_at_entry: delinquentAtEntry } },
    { type: "scra.relief.started", payload: { period_id: i.period_id, kind: "interest_rate_cap", started_on: i.activated_on, effective_due: effectiveDue, consumer: "8.3" } },
  ];
  if (i.method === "interest_subsidy") events.push({ type: "scra.subsidy.activated", payload: { period_id: i.period_id, activated_on: i.activated_on, next_adjust_on: addMonths(i.activated_on, 12), payment_cents: newPayment } });
  if (lc.waived_cents + lc.refunded_cents > 0n) events.push({ type: "late_charges.waived", payload: { period_id: i.period_id, cents: lc.waived_cents + lc.refunded_cents, waived_cents: lc.waived_cents, refunded_cents: lc.refunded_cents, fee_ids: i.late_charges.filter((c) => c.assessed_on >= effectiveDue && (!capEnds || c.assessed_on <= capEnds)).map((c) => c.fee_id), reason: "scra_rate_cap", gate: lc.gate } });
  return { allowed: true, refusal: null, status, capped_rate: cappedRate(i.note_rate_pct), cap_effective_payment_due: effectiveDue, cap_ends_on: capEnds, first_n: firstN, upb_before_cap_cents: upbBefore, paid_at_note_rate_count: paid, remaining_term_after: remaining, delinquent_at_entry: delinquentAtEntry,
    rows: r.rows, forgiven_total_cents: r.forgiven_total_cents, upb_after_cents: r.upb_after_cents, new_payment_cents: newPayment, standard_payment_cents: r.next_payment_standard_cents, subsidy_payment_cents: r.next_payment_subsidy_cents, next_interest_capped_cents: r.next_interest_capped_cents, scheduled_principal_cents: r.next_payment_subsidy_cents - r.next_interest_capped_cents, fnma_differential_cents: r.fnma_differential_cents, servicing_fee_cents: servicingFee(r.upb_after_cents, SERVICING_FEE_PCT), new_payment_due: newPaymentDue,
    late_charges_waived_cents: lc.waived_cents, late_charges_refunded_cents: lc.refunded_cents, late_charge_fee_ids: i.late_charges.filter((c) => c.assessed_on >= effectiveDue && (!capEnds || c.assessed_on <= capEnds)).map((c) => c.fee_id), overpayment_cents: overpayment, shortfall_cents: shortfall, sufficient_alone: sufficient, postings, investor_postings: investor, events };
}

// ============================================================ Form 1022 / MBS upload / Transaction 83 (F-1-19; T5)
export interface Form1022Input { readonly period_id: string; readonly reason: string; readonly reduction_month: PlainDate; readonly mbs: boolean; readonly sent_on: PlainDate; readonly message_id: string | null; readonly file_id: string | null; }
export interface Form1022Result { readonly allowed: boolean; readonly refusal: string | null; readonly channel: Form1022Channel; readonly month: string; readonly due_by: PlainDate; readonly on_time: boolean; readonly events: readonly EmittedEvent[]; }
/** Portfolio/PFP: the Form 1022 email to militaryindulgence@fanniemae.com by BD9 of the following month; MBS: the investor-reporting upload by CD15 — both tracked with acknowledgements. */
export function form1022Submission(i: Form1022Input): Form1022Result {
  const sched = form1022Schedule({ reduction_month: i.reduction_month, mbs: i.mbs });
  const channel: Form1022Channel = i.mbs ? "mbs_upload" : "email_form1022";
  const base = { channel, month: yyyymm(i.reduction_month), due_by: sched.due, on_time: i.sent_on <= sched.due, events: [] as EmittedEvent[] };
  if (!(FORM_1022_REASONS as readonly string[]).includes(i.reason)) return refuseWith<Form1022Result>(base, `reason must be one of ${FORM_1022_REASONS.join(", ")}`);
  if (!i.mbs && !i.message_id) return refuseWith<Form1022Result>(base, "message_id is required — the Form 1022 email is tracked by message id (F-1-19 / F-4-02)");
  if (i.mbs && !i.file_id) return refuseWith<Form1022Result>(base, "file_id is required — the MBS notification is a file upload on the investor reporting system (F-1-19)");
  const payload = { period_id: i.period_id, reason: i.reason, month: base.month, due_by: sched.due, channel, sent_on: i.sent_on, on_time: base.on_time, message_id: i.message_id, file_id: i.file_id, timer: i.mbs ? "FNMA_F119_MBS_UPLOAD_CD15" : "FNMA_F119_FORM1022_BD9" };
  const events: EmittedEvent[] = [{ type: "form_1022.sent", payload }];
  if (i.mbs) events.push({ type: "fnma.upload.submitted", payload: { ...payload, kind: "form_1022" } });
  return { allowed: true, refusal: null, ...base, events };
}

export interface FnmaAckInput { readonly submission_id: string; readonly channel: string; readonly reason: string | null; readonly month: string | null; readonly already_acked: string | null; readonly ack_id: string; readonly accepted: boolean; readonly accepted_on: PlainDate; readonly reason_code?: string | null; }
export interface FnmaAckResult { readonly allowed: boolean; readonly refusal: string | null; readonly event: EmittedEvent | null; readonly escalation: Escalation | null; }
/** The inbound Fannie Mae acknowledgement, validated against the tracked submission: email ack, MBS upload accepted/rejected (CD15 row), LAR 83 accepted/rejected (5.1). */
export function ingestFnmaAck(i: FnmaAckInput): FnmaAckResult {
  if (!i.ack_id) return { allowed: false, refusal: "ack_id is required — the acknowledgement is Fannie Mae's record, not the agent's", event: null, escalation: null };
  if (i.already_acked) return { allowed: false, refusal: `submission ${i.submission_id} was already acknowledged (${i.already_acked})`, event: null, escalation: null };
  const common = { submission_id: i.submission_id, ack_id: i.ack_id, accepted: i.accepted, accepted_on: i.accepted_on, reason: i.reason, month: i.month, reason_code: i.reason_code ?? null };
  if (i.channel === "email_form1022") return { allowed: true, refusal: null, event: { type: i.accepted ? "form_1022.acknowledged" : "form_1022.bounced", payload: { ...common, channel: i.channel } }, escalation: i.accepted ? null : { kind: "fnma_portal_operator", reason: `Form 1022 ${i.submission_id} bounced — resend and contact the Servicing Representative (13.9 Integrations)` } };
  if (i.channel === "mbs_upload") return { allowed: true, refusal: null, event: { type: i.accepted ? "fnma.upload.accepted" : "fnma.upload.rejected", payload: { ...common, kind: "form_1022", channel: i.channel } }, escalation: i.accepted ? null : { kind: "fnma_portal_operator", reason: `MBS notification upload ${i.submission_id} rejected (${i.reason_code ?? "no reason code"}) — re-upload before CD15` } };
  if (i.channel === "transaction_83") return { allowed: true, refusal: null, event: { type: i.accepted ? "investor.event.accepted" : "investor.event.rejected", payload: { ...common, kind: "lar_83", event_type: "rate_payment.change", channel: i.channel } }, escalation: i.accepted ? null : { kind: "fnma_portal_operator", reason: `LAR 83 ${i.submission_id} rejected (${i.reason_code ?? "no reason code"}) — 5.1 correction` } };
  return { allowed: false, refusal: `channel ${i.channel || "none"} is not one of email_form1022, mbs_upload, transaction_83`, event: null, escalation: null };
}

// ============================================================ ARM adjustment during the cap (rule 3; T4)
export interface ArmAdjustmentInput { readonly period_id: string; readonly status: string; readonly product: string; readonly adjusted_rate_pct: string; readonly scheduled_on: PlainDate; readonly cap_ends_on: PlainDate | null; }
export interface ArmAdjustmentResult { readonly allowed: boolean; readonly refusal: string | null; readonly applied_rate_pct: string; readonly capped: boolean; readonly events: readonly EmittedEvent[]; }
/** F-1-19: an ARM "must be treated as a fixed-rate mortgage loan bearing interest at 6%, unless the applicable adjustable rate would be lower"; each scheduled adjustment reports via Transaction 83 / the servicing event. */
export function armAdjustmentDuringCap(i: ArmAdjustmentInput): ArmAdjustmentResult {
  const base = { applied_rate_pct: i.adjusted_rate_pct, capped: false, events: [] as EmittedEvent[] };
  if (i.product !== "arm") return refuseWith<ArmAdjustmentResult>(base, `loan product ${i.product || "unknown"} is not an ARM — no scheduled adjustment to report`);
  if (i.status !== "active" && i.status !== "tail") return refuseWith<ArmAdjustmentResult>(base, `no active cap (status ${i.status || "none"}) — the adjustment is an ordinary 4.x rate change`);
  if (!/^\d+(\.\d+)?$/.test(i.adjusted_rate_pct)) return refuseWith<ArmAdjustmentResult>(base, "adjusted_rate_pct must be a decimal percent string");
  if (i.cap_ends_on && i.scheduled_on > i.cap_ends_on) return refuseWith<ArmAdjustmentResult>(base, `adjustment ${i.scheduled_on} falls after cap_ends_on ${i.cap_ends_on} — restore first (rule 9)`);
  const a = armAdjustment({ adjusted_rate_pct: i.adjusted_rate_pct, scheduled_on: i.scheduled_on, cap_active: true });
  const payload = { period_id: i.period_id, scra_cap_active: true, scheduled_on: i.scheduled_on, adjusted_rate_pct: i.adjusted_rate_pct, applied_rate_pct: a.applied_rate_pct, capped: a.capped, timer: a.timer };
  return { allowed: true, refusal: null, applied_rate_pct: a.applied_rate_pct, capped: a.capped, events: [{ type: "arm.adjustment.scheduled", payload }, { type: "investor.event.submitted", payload: { ...payload, kind: a.event.kind, servicing_event: a.event.servicing_event, channel: "transaction_83" } }] };
}

// ============================================================ annual subsidy re-adjustment (F-1-19 "at least annually")
export interface SubsidyReadjustInput { readonly period_id: string; readonly status: string; readonly method: string; readonly as_of: PlainDate; readonly original_principal_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly first_payment_due: PlainDate; readonly pi_cents: Cents; readonly next_due_on: PlainDate; }
export interface SubsidyReadjustResult { readonly allowed: boolean; readonly refusal: string | null; readonly new_payment_cents: Cents; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly upb_cents: Cents; readonly next_adjust_on: PlainDate; readonly events: readonly EmittedEvent[]; }
/** Interest Subsidy method: "the sum of the next monthly principal installment called for by the applicable amortization schedule plus monthly interest at the rate of 6%", adjusted at least annually. */
export function subsidyReadjustment(i: SubsidyReadjustInput): SubsidyReadjustResult {
  const base = { new_payment_cents: 0n, interest_cents: 0n, principal_cents: 0n, upb_cents: 0n, next_adjust_on: addMonths(i.as_of, 12), events: [] as EmittedEvent[] };
  if (i.status !== "active" && i.status !== "tail") return refuseWith<SubsidyReadjustResult>(base, `no active cap (status ${i.status || "none"})`);
  if (i.method !== "interest_subsidy") return refuseWith<SubsidyReadjustResult>(base, "the annual re-adjustment applies to the Interest Subsidy method only (the standard method is a fixed re-amortization)");
  const n = monthsBetween(i.first_payment_due, i.next_due_on) + 1;
  if (n < 1 || n > i.term_months) return refuseWith<SubsidyReadjustResult>(base, `next_due_on ${i.next_due_on} is outside the loan's schedule`);
  const upb = balanceAfter(i.original_principal_cents, i.note_rate_pct, i.term_months, n - 1);
  const r = recalculate({ upb_cents: upb, note_rate_pct: i.note_rate_pct, pi_cents: i.pi_cents, first_capped_due: i.next_due_on, first_n: n, paid_at_note_rate_count: 0, remaining_term_after: i.term_months - (n - 1) });
  const principal = r.next_payment_subsidy_cents - r.next_interest_capped_cents;
  return { allowed: true, refusal: null, new_payment_cents: r.next_payment_subsidy_cents, interest_cents: r.next_interest_capped_cents, principal_cents: principal, upb_cents: upb, next_adjust_on: base.next_adjust_on,
    events: [{ type: "scra.subsidy.recalculated", payload: { period_id: i.period_id, as_of: i.as_of, next_due_on: i.next_due_on, new_payment_cents: r.next_payment_subsidy_cents, principal_cents: principal, interest_cents: r.next_interest_capped_cents, upb_cents: upb, next_adjust_on: base.next_adjust_on, fnma_differential_cents: r.fnma_differential_cents, timer: "FNMA_F119_SUBSIDY_ADJUST_12M" } }] };
}

// ============================================================ designated custodial account receipts (F-1-19 funding; 6.x reconciliation)
export interface CustodialReceiptInput { readonly period_id: string; readonly status: string; readonly receipt_id: string; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly month: string; readonly expected_cents: Cents; readonly prior_shortfall_cents: Cents; readonly already_matched_month: boolean; }
export interface CustodialReceiptResult { readonly allowed: boolean; readonly refusal: string | null; readonly matched: boolean; readonly shortfall_cents: Cents; readonly aggregate_shortfall_cents: Cents; readonly officer_informed: boolean; readonly postings: readonly Posting[]; readonly escalation: Escalation | null; readonly events: readonly EmittedEvent[]; }
/** "Fannie Mae will continue to make disbursements for the amount of the interest rate reduction … funded two days prior to the end of the month in the custodial account that the servicer has assigned for military indulgence funds." A short or missing disbursement is a 6.x reconciliation exception with no borrower impact. */
export function custodialReceiptMatch(i: CustodialReceiptInput): CustodialReceiptResult {
  const base = { matched: false, shortfall_cents: 0n, aggregate_shortfall_cents: i.prior_shortfall_cents, officer_informed: false, postings: [] as Posting[], escalation: null, events: [] as EmittedEvent[] };
  if (!i.receipt_id) return refuseWith<CustodialReceiptResult>(base, "receipt_id is required — the receipt is the custodial bank feed's record");
  if (!/^\d{4}-\d{2}$/.test(i.month)) return refuseWith<CustodialReceiptResult>(base, "month must be YYYY-MM");
  if (i.amount_cents < 0n) return refuseWith<CustodialReceiptResult>(base, "amount_cents cannot be negative");
  if (i.status !== "active" && i.status !== "tail") return refuseWith<CustodialReceiptResult>(base, `no active cap (status ${i.status || "none"}) — Fannie Mae funds the reduction through the indulgence end date plus one year only`);
  if (i.already_matched_month) return refuseWith<CustodialReceiptResult>(base, `month ${i.month} is already matched`);
  const shortfall = i.amount_cents < i.expected_cents ? i.expected_cents - i.amount_cents : 0n;
  const aggregate = i.prior_shortfall_cents + shortfall;
  const matched = shortfall === 0n;
  const postings: Posting[] = i.amount_cents > 0n ? [{ account: "custodial_mi_cash", debit: i.amount_cents, credit: 0n, rule_ref: "13.9.rule7.mbs_receipt" }, { account: "fnma_military_indulgence_receivable", debit: 0n, credit: i.amount_cents, rule_ref: "13.9.rule7.mbs_receipt" }] : [];
  const payload = { period_id: i.period_id, kind: "scra_subsidy", receipt_id: i.receipt_id, month: i.month, amount_cents: i.amount_cents, expected_cents: i.expected_cents, received_on: i.received_on, shortfall_cents: shortfall, timer: "FNMA_F119_MI_DISBURSEMENT_CHECK_M2" };
  const officer = aggregate > OFFICER_SHORTFALL_THRESHOLD_CENTS;
  const escalation: Escalation | null = matched ? null : officer ? { kind: "officer", severity: "sev3", reason: `Fannie Mae military-indulgence funding short ${shortfall} cents for ${i.month}; aggregate shortfall ${aggregate} cents exceeds $10,000 — informed per policy (no borrower impact; 6.x reconciliation)` } : { kind: "human_agent", severity: "sev3", reason: `Fannie Mae disbursement short ${shortfall} cents for ${i.month} — 6.x reconciliation exception and Fannie Mae inquiry (no borrower impact)` };
  return { allowed: true, refusal: null, matched, shortfall_cents: shortfall, aggregate_shortfall_cents: aggregate, officer_informed: officer, postings, escalation, events: [{ type: matched ? "custodial.receipt.matched" : "custodial.receipt.exception", payload: { ...payload, aggregate_shortfall_cents: aggregate, officer_informed: officer } }] };
}

// ============================================================ overpayment election (rule 6/7; decision 13.9-3; T7/T8)
export interface ElectionInput { readonly period_id: string; readonly election: string; readonly current_election: string; readonly overpayment_cents: Cents; readonly next_payment_cents: Cents; readonly recorded_on: PlainDate; readonly by: string; }
export interface ElectionResult { readonly allowed: boolean; readonly refusal: string | null; readonly election: Election | null; readonly postings: readonly Posting[]; readonly statement_line: string | null; readonly sufficient_alone: boolean; readonly shortfall_cents: Cents; readonly events: readonly EmittedEvent[]; }
/** The borrower's election: refund (Dr scra_overpayment_payable / Cr cash), curtailment (Cr principal; 5.1 curtailment event), or apply toward the next payment (Cr suspense/unapplied, then normal application). */
export function recordElection(i: ElectionInput): ElectionResult {
  const base = { election: null, postings: [] as Posting[], statement_line: null, sufficient_alone: i.overpayment_cents >= i.next_payment_cents, shortfall_cents: i.overpayment_cents >= i.next_payment_cents ? 0n : i.next_payment_cents - i.overpayment_cents, events: [] as EmittedEvent[] };
  if (!(ELECTIONS as readonly string[]).includes(i.election)) return refuseWith<ElectionResult>(base, `election must be one of ${ELECTIONS.join(", ")}`);
  if (i.current_election !== "pending") return refuseWith<ElectionResult>(base, `the election is already ${i.current_election} — a change goes through the human agent`);
  if (i.overpayment_cents <= 0n) return refuseWith<ElectionResult>(base, "no overpayment to elect on");
  const r = overpaymentElection({ overpayment_cents: i.overpayment_cents, next_payment_cents: i.next_payment_cents, election: i.election as Election, recorded_on: i.recorded_on });
  const payload = { period_id: i.period_id, election: i.election, amount_cents: i.overpayment_cents, elected_at: i.recorded_on, recorded_by: i.by, defaulted: false, sufficient_alone: r.sufficient_alone, shortfall_cents: r.shortfall_cents, statement_line: r.statement_line, timer: "SM_SCRA_OVERPAYMENT_ELECTION_30" };
  const events: EmittedEvent[] = [{ type: "scra.overpayment.elected", payload }, { type: "scra.overpayment.election_recorded", payload }];
  if (i.election === "curtailment") events.push({ type: "investor.curtailment.reported", payload: { period_id: i.period_id, amount_cents: i.overpayment_cents, reason: "scra_overpayment", consumer: "5.1" } });
  return { allowed: true, refusal: null, election: i.election as Election, postings: r.postings, statement_line: r.statement_line, sufficient_alone: r.sufficient_alone, shortfall_cents: r.shortfall_cents, events };
}

export interface ElectionLapseInput { readonly period_id: string; readonly current_election: string; readonly letter_sent_on: PlainDate | null; readonly overpayment_cents: Cents; readonly next_payment_cents: Cents; readonly today: PlainDate; }
export interface ElectionLapseResult { readonly allowed: boolean; readonly refusal: string | null; readonly due: PlainDate | null; readonly applied: Election | null; readonly postings: readonly Posting[]; readonly borrower_notice: "NTC_SCRA_3937_OVERPAYMENT_ELECTION" | null; readonly events: readonly EmittedEvent[]; }
/** No election within 30 days of the election letter → the default election (decision 13.9-3: principal curtailment) applies and the borrower is told. */
export function electionLapse(i: ElectionLapseInput): ElectionLapseResult {
  const base = { due: i.letter_sent_on ? addDays(i.letter_sent_on, 30) : null, applied: null, postings: [] as Posting[], borrower_notice: null, events: [] as EmittedEvent[] };
  if (!i.letter_sent_on) return refuseWith<ElectionLapseResult>(base, "no election letter on record — the 30 days run from NTC_SCRA_3937_OVERPAYMENT_ELECTION");
  if (i.current_election !== "pending") return refuseWith<ElectionLapseResult>(base, `the election is already ${i.current_election}`);
  const d = defaultElection({ letter_sent_on: i.letter_sent_on, today: i.today });
  if (!d.defaulted) return refuseWith<ElectionLapseResult>(base, `the election window is open until ${d.due} (SM_SCRA_OVERPAYMENT_ELECTION_30)`);
  const r = overpaymentElection({ overpayment_cents: i.overpayment_cents, next_payment_cents: i.next_payment_cents, election: DEFAULT_ELECTION, recorded_on: i.today });
  const payload = { period_id: i.period_id, election: DEFAULT_ELECTION, amount_cents: i.overpayment_cents, elected_at: i.today, defaulted: true, due: d.due, decision: "13.9-3", borrower_notice: d.borrower_notice, statement_line: r.statement_line, timer: "SM_SCRA_OVERPAYMENT_ELECTION_30" };
  return { allowed: true, refusal: null, due: d.due, applied: DEFAULT_ELECTION, postings: r.postings, borrower_notice: d.borrower_notice, events: [{ type: "scra.overpayment.elected", payload }, { type: "scra.overpayment.election_recorded", payload }, { type: "investor.curtailment.reported", payload: { period_id: i.period_id, amount_cents: i.overpayment_cents, reason: "scra_overpayment_default", consumer: "5.1" } }] };
}

// ============================================================ tail, end-date letter and restoration (rule 9; T3/T11)
export interface PeriodEndedResult { readonly cap_ends_on: PlainDate; readonly restoration_due: PlainDate; readonly end_letter_due: PlainDate; readonly event: EmittedEvent; }
/** 13.8 `scra.period.ended` → the rate period enters its one-year tail: `cap_ends_on = addYears(service_end_on, 1)` (never +365 days), restoration the first installment after, the end-date letter 60 days before. */
export function periodEnded(i: { period_id: string; status: string; service_end_on: PlainDate }): PeriodEndedResult | null {
  if (i.status !== "active") return null;
  const ends = capEndsOn(i.service_end_on);
  const out = { cap_ends_on: ends, restoration_due: restorationInstallment(ends), end_letter_due: endDateLetterDue(ends) };
  return { ...out, event: { type: "scra.rate_period.tail_started", payload: { period_id: i.period_id, service_end_on: i.service_end_on, ...out, timer: "SCRA_3937A1_CAP_TAIL_1Y" } } };
}

export interface RateEndLetterInput { readonly period_id: string; readonly status: string; readonly cap_ends_on: PlainDate | null; readonly today: PlainDate; readonly already_sent_on: PlainDate | null; }
export interface RateEndLetterResult { readonly allowed: boolean; readonly refusal: string | null; readonly due: PlainDate | null; readonly restoration_due: PlainDate | null; readonly template: "NTC_SCRA_3937_RATE_END"; }
/** Rule 9: the end-date letter goes out 60 days before restoration (policy) — not earlier, and once. */
export function rateEndLetter(i: RateEndLetterInput): RateEndLetterResult {
  const due = i.cap_ends_on ? endDateLetterDue(i.cap_ends_on) : null; const restoration = i.cap_ends_on ? restorationInstallment(i.cap_ends_on) : null;
  const base = { due, restoration_due: restoration, template: "NTC_SCRA_3937_RATE_END" as const };
  if (i.status !== "tail" || !i.cap_ends_on) return refuseWith<RateEndLetterResult>(base, `the period is not in its tail (status ${i.status || "none"}) — the end date is known only after scra.period.ended`);
  if (i.already_sent_on) return refuseWith<RateEndLetterResult>(base, `the end-date letter was already sent on ${i.already_sent_on}`);
  if (i.today < due!) return refuseWith<RateEndLetterResult>(base, `the end-date letter is due ${due} (60 days before restoration); today is ${i.today}`);
  return { allowed: true, refusal: null, ...base };
}

export interface RestorationInput { readonly period_id: string; readonly status: string; readonly cap_ends_on: PlainDate | null; readonly today: PlainDate; readonly pre_cap_pi_cents: Cents; readonly pre_cap_rate: string; readonly product: string; readonly method: string; readonly latest_arm_rate_pct: string | null; }
export interface RestorationResult { readonly allowed: boolean; readonly refusal: string | null; readonly restoration_due: PlainDate | null; readonly restored_pi_cents: Cents | null; readonly restored_rate_pct: string | null; readonly events: readonly EmittedEvent[]; }
/** Rule 9 / F-1-19 after active duty: fixed-rate — "the payment they had before the interest rate reduction"; ARM — the latest applicable rate (re-amortized under the standard method, 4.x). Restoration is blocked through `cap_ends_on` (SCRA_3937A1_CAP_TAIL_1Y "restoration blocked before"). */
export function restoreRate(i: RestorationInput): RestorationResult {
  const due = i.cap_ends_on ? restorationInstallment(i.cap_ends_on) : null;
  const base = { restoration_due: due, restored_pi_cents: null, restored_rate_pct: null, events: [] as EmittedEvent[] };
  if (i.status !== "tail" || !i.cap_ends_on) return refuseWith<RestorationResult>(base, `the period is not in its tail (status ${i.status || "none"})`);
  if (i.today <= i.cap_ends_on) return refuseWith<RestorationResult>(base, `restoration is blocked through cap_ends_on ${i.cap_ends_on} (50 U.S.C. 3937(a)(1)(A) "and one year thereafter"; SCRA_3937A1_CAP_TAIL_1Y) — today is ${i.today}`);
  const arm = i.product === "arm";
  const rate = arm ? i.latest_arm_rate_pct ?? i.pre_cap_rate : i.pre_cap_rate;
  const pi = arm ? null : i.pre_cap_pi_cents;
  const late = i.today > due!;
  const payload = { period_id: i.period_id, cap_ends_on: i.cap_ends_on, restoration_due: due, ended_on: i.today, restored_rate_pct: rate, restored_pi_cents: pi, arm_reamortize: arm, late, timer: "SCRA_3937A1_CAP_TAIL_1Y" };
  return { allowed: true, refusal: null, restoration_due: due, restored_pi_cents: pi, restored_rate_pct: rate, events: [{ type: "scra.rate_reduction.ended", payload }, { type: "scra.rate.restored", payload }] };
}

/** The Fannie Mae differential the designated custodial account should receive for a month: note interest − 6% interest on the UPB at the beginning of the month (rule 6/7). */
export function monthlyDifferential(i: { original_principal_cents: Cents; note_rate_pct: string; term_months: number; first_payment_due: PlainDate; pi_cents: Cents; installment_due_on: PlainDate }): Cents {
  const n = monthsBetween(i.first_payment_due, i.installment_due_on) + 1;
  if (n < 1 || n > i.term_months) throw new RangeError(`installment ${i.installment_due_on} is outside the loan's schedule`);
  const upb = balanceAfter(i.original_principal_cents, i.note_rate_pct, i.term_months, n - 1);
  return recalculate({ upb_cents: upb, note_rate_pct: i.note_rate_pct, pi_cents: i.pi_cents, first_capped_due: i.installment_due_on, first_n: n, paid_at_note_rate_count: 0, remaining_term_after: i.term_months - (n - 1) }).fnma_differential_cents;
}
