/**
 * §12.6 Payment Deferral operating rules — the functions that append the deferral's own events, i.e. the code paths
 * the 12.6 timer rows (spec/sections/12-loss-mitigation/12-6-payment-deferral.md "Timers and gates"; overrides in
 * ./timers.ts and ./timers-12-6.ts) are armed and closed on. The pure calculators stay in ./deferral.ts (screen, NIB,
 * new payment, timeline) and ./ops.ts (cap structure, ledger, clocks); this file versions the `payment_deferrals`
 * record (12.6 data model) and emits:
 *
 *  - `offerDeferral`               → `payment_deferral.offered{basis, brp_complete, decided_on, …}` — the offer/solicitation
 *                                    decision the 12.6 `deferral.screen` tool records when the caller names a `basis`;
 *                                    arms `FNMA_D2205_EVAL_NOTICE_DEFERRAL_5` on the BRP basis (D2-3.2-04: "Evaluation
 *                                    Notice per D2-2-05 required only when a complete BRP was submitted").
 *  - `acceptDeferral`              → `payment_deferral.accepted{accepted_on, accepted_via, completion_month_end, entry_deadline,
 *                                    lar_by, processing_month}` — acceptance "evidenced by the borrower contacting the servicer,
 *                                    returning an executed agreement, or any other method"; derived from the 12.2
 *                                    `lossmit.offer.responded{response=accepted, option=payment_deferral}` by `watchDeferralEvents`.
 *  - `recordContractualPayment`    → `payment_deferral.contractual_payment.received{full, received_on}` — rule 4's gate
 *                                    (6 months delinquent at evaluation or a cap-exceeding structure).
 *  - `completeDeferral`            → `payment_deferral.completed{completed_on, effective_date, processing_month, entry_deadline}` and
 *                                    `payment_deferral.effective{effective_date, next_due_date}` — completion is the SMDU case
 *                                    submission with the campaign ID (D2-3.2-04); the 12.6 `smdu.case.submit` tool calls it.
 *                                    `payment_deferral.effective` arms `FNMA_D23204_CUSTODIAN_25` on `effective_date`.
 *  - `recordedOriginalReceived`    → `erecording.recorded_document.received{received_on}` (arms `FNMA_D23204_RECORDED_ORIGINAL_5BD`).
 *  - `confirmCustodianDelivery`    → `custodian.delivery.confirmed{document, complete}` — the inbound custodian receipt validated
 *                                    against the deferral's recording state (satisfies `FNMA_D23204_CUSTODIAN_25` / `_RECORDED_ORIGINAL_5BD`).
 *  - `notifyFnmaLegal`             → `fnma.legal.notified{form=form_20, notice_date, notified_on, due_by, cure_by, late}` — the Form 20
 *                                    to Fannie Mae Legal on a Texas §50(a)(6) allegation (7 `business_days_servicer`; 60-day cure),
 *                                    validated against the 4.5 `complaint.tx_50a6_defect.alleged` on file (satisfies `TX_50A6_DEFERRAL_NOTICE_7BD`).
 *  - `postDeferralRedelinquency`   → `payment_deferral.redelinquent{fnma_day=60, post_deferral_within_6m, qrpc, day_60_date}` — the 12.6
 *                                    watcher over the 11.1 delinquency milestone for a loan whose deferral became effective within the
 *                                    last 6 months (arms `FNMA_D23206_POSTDEFERRAL_FLEX_SOLICIT_75`; D2-3.2-06 streamlined solicitation).
 *
 * Money is bigint cents; dates are PlainDate; every state change is a new record version plus an event, never an edit
 * of history. The store is structural (the app's EntityStore satisfies it) so this file depends on the kernel only.
 */
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { type PlainDate, plainDate, addDays, addMonths, startOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { screen, timeline, type DeferralFacts, type Screen } from "./deferral.ts";
import { capStructure } from "./ops.ts";

export const DEFERRAL_ACTOR: Actor = { kind: "agent", id: "lossmit-underwriter" };
export const RULE_SET_VERSION = "fnma.d23204.2025-08";
export const OFFER_TEMPLATE = "NTC_FNMA_D23204_DEFERRAL_OFFER";
export const COMPLETED_TEMPLATE = "NTC_FNMA_D23204_DEFERRAL_COMPLETED";
export const AGREEMENT_DOCUMENT = "DOC_FNMA_PAYMENT_DEFERRAL_AGREEMENT";
export const STREAMLINED_SOLICIT_TEMPLATE = "NTC_FNMA_D23206_SOLICIT_STREAMLINED";
/** The 12.2 basis enum as 12.6 uses it: a complete BRP evaluated under the hierarchy, a servicer-initiated loan-level screen (comment 41(c)(2)(i)-1), or the two D2-3.2-04 post-plan solicitations. */
export type DeferralBasis = "brp" | "streamlined" | "post_forbearance" | "post_repayment";
export const DEFERRAL_BASES: readonly DeferralBasis[] = ["brp", "streamlined", "post_forbearance", "post_repayment"];
export const SOLICITATION_TEMPLATES: Readonly<Record<"post_forbearance" | "post_repayment", string>> = { post_forbearance: "NTC_FNMA_D23204_SOLICIT_POST_FORB", post_repayment: "NTC_FNMA_D23204_SOLICIT_POST_REPAY" };
export type DeferralStatus = "offered" | "solicited" | "accepted" | "awaiting_contractual_payment" | "pending_smdu_entry" | "completed" | "agreement_sent" | "documented" | "closed" | "declined" | "expired";
export type CustodianDocument = "certified_copy" | "executed_copy" | "recorded_original";
export type AcceptedVia = "contact" | "executed_agreement" | "written" | "verbal" | "esign" | "other";

export interface DeferralRecord { readonly id: string; readonly data: Record<string, unknown>; }
export interface DeferralStore {
  get(kind: string, id: string): DeferralRecord | undefined;
  list(kind: string, where?: (d: Record<string, unknown>) => boolean): readonly DeferralRecord[];
  put(kind: string, id: string, data: Record<string, unknown>, by: Actor, now: string): DeferralRecord;
}
export interface DeferralEnv { readonly events: EventStore; readonly store: DeferralStore; readonly actor: Actor; readonly now: string; }

const KIND = "payment_deferrals";
const OPEN: readonly string[] = ["offered", "solicited", "accepted", "awaiting_contractual_payment", "pending_smdu_entry", "completed", "agreement_sent", "documented"];
const today = (env: DeferralEnv): PlainDate => plainDate(env.now.slice(0, 10));
const d = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? plainDate(v) : null);
const emit = (env: DeferralEnv, type: string, loanId: string, payload: Record<string, unknown>): DomainEvent => env.events.append({ type, loanId, actor: env.actor, payload });
const patch = (env: DeferralEnv, rec: DeferralRecord, changes: Record<string, unknown>): DeferralRecord => env.store.put(KIND, rec.id, changes, env.actor, env.now);

/** The loan's open (non-disaster) deferral — by id when given, else the latest record still in flight. */
export function deferralFor(env: DeferralEnv, loanId: string, id?: string | null): DeferralRecord | undefined {
  if (id) { const r = env.store.get(KIND, id); if (r && r.data.loan_id !== loanId) throw new RangeError(`payment deferral ${id} belongs to another loan`); return r; }
  return env.store.list(KIND, (x) => x.loan_id === loanId && x.kind === "standard" && OPEN.includes(String(x.status))).at(-1);
}
function requireDeferral(env: DeferralEnv, loanId: string, id?: string | null): DeferralRecord {
  const r = deferralFor(env, loanId, id); if (!r) throw new RangeError(`no open payment deferral for loan ${loanId}${id ? ` (${id})` : ""}`); return r;
}

// ---------------------------------------------------------------------------------------------- offer / solicitation
export interface OfferInput {
  readonly loan_id: string; readonly deferral_id?: string | null; readonly basis: string; readonly facts: DeferralFacts; readonly result?: Screen; readonly application_complete?: boolean; readonly decided_on?: PlainDate | null;
  /** Partner's written equal-treatment election (rule 5 / open question 2) — refused when the case can still be completed by the 15th. */
  readonly processing_month_elected?: boolean;
  /** `jurisdiction_rules.deferral_recording` — a recordable agreement (12.6-T10). */
  readonly recording_required?: boolean;
}
/**
 * The offer (BRP / streamlined) or solicitation (post-forbearance / post-repayment) decision on an *eligible* screen.
 * Criteria 4–11 are assertions (an ineligible screen is refused, not offered — it goes to `lossmit_reviewer` and the
 * Flex Mod path); the cap structure (rule 4 / 12.6-T4) and the contractual-payment gate ride on the record and event.
 */
export function offerDeferral(env: DeferralEnv, i: OfferInput): { deferral: Record<string, unknown>; event: DomainEvent } {
  if (!DEFERRAL_BASES.includes(i.basis as DeferralBasis)) throw new RangeError(`basis ${i.basis} is not one of ${DEFERRAL_BASES.join("/")}`);
  if (i.facts.disaster) throw new RangeError("a disaster payment deferral is offered under 12.7 (D2-3.2-05), not here");
  const s = i.result ?? screen(i.facts);
  if (!s.eligible) throw new RangeError(`cannot offer: ${s.reason} — D2-3.2-04 criteria are assertions; route ${s.next}`);
  const basis = i.basis as DeferralBasis;
  const decided = i.decided_on ?? today(env);
  const id = i.deferral_id || `pd-${i.loan_id}-${i.facts.evaluation_date}`;
  const existing = env.store.get(KIND, id);
  if (existing && OPEN.includes(String(existing.data.status)) && existing.data.status !== "offered" && existing.data.status !== "solicited") throw new RangeError(`payment deferral ${id} is already ${String(existing.data.status)}`);
  const cap = capStructure({ prior_deferred_months: i.facts.cumulative_deferred_months, requested_months: i.facts.months_delinquent });
  const solicitation = basis === "post_forbearance" || basis === "post_repayment";
  const template = solicitation ? SOLICITATION_TEMPLATES[basis] : OFFER_TEMPLATE;
  const tl = timeline(i.facts.evaluation_date, { processing_month_elected: i.processing_month_elected === true });   // refuses an election the 15th still permits completing without
  const rec = env.store.put(KIND, id, {
    id, loan_id: i.loan_id, kind: "standard", basis, status: solicitation ? "solicited" : "offered", evaluation_date: i.facts.evaluation_date, delinquency_months_at_eval: i.facts.months_delinquent,
    months_deferred: s.months_deferred, cumulative_months_after: i.facts.cumulative_deferred_months + s.months_deferred, contractual_payment_required: s.contractual_payment_required, installments_to_pay: cap.installments_to_pay,
    prior_deferral_effective_dates: i.facts.prior_deferral_effective && !i.facts.prior_deferral_was_disaster ? [i.facts.prior_deferral_effective] : [], application_complete: i.application_complete === true,
    processing_month: tl.processing_month, entry_deadline: tl.entry_deadline, lar_by: tl.lar_deadline, recording_required: i.recording_required === true, offered_on: decided, offer_template: template,
    evaluation_notice_required: basis === "brp", accept_window_days: i.application_complete === true ? 14 : null,
  }, env.actor, env.now);
  const event = emit(env, "payment_deferral.offered", i.loan_id, {
    deferral_id: id, basis, brp_complete: basis === "brp", application_complete: i.application_complete === true, decided_on: decided, evaluation_date: i.facts.evaluation_date, months_delinquent: i.facts.months_delinquent,
    months_deferred: s.months_deferred, cumulative_months_after: i.facts.cumulative_deferred_months + s.months_deferred, contractual_payment_required: s.contractual_payment_required, installments_to_pay: cap.installments_to_pay,
    evaluation_notice_required: basis === "brp", template, solicitation, accept_window_days: i.application_complete === true ? 14 : null, processing_month: tl.processing_month, entry_deadline: tl.entry_deadline, recording_required: i.recording_required === true,
  });
  return { deferral: rec.data, event };
}

// ---------------------------------------------------------------------------------------------- acceptance
export interface AcceptInput { readonly loan_id: string; readonly deferral_id?: string | null; readonly accepted_on?: PlainDate | null; readonly accepted_via: AcceptedVia | string; readonly processing_month_elected?: boolean; }
/** Acceptance by any evidence (D2-3.2-04); fixes the completion month (evaluation month, or the elected processing month) and its entry / LAR deadlines (F-1-22). */
export function acceptDeferral(env: DeferralEnv, i: AcceptInput): { deferral: Record<string, unknown>; event: DomainEvent } {
  const rec = requireDeferral(env, i.loan_id, i.deferral_id);
  if (rec.data.status !== "offered" && rec.data.status !== "solicited") throw new RangeError(`payment deferral ${rec.id} is ${String(rec.data.status)}, not awaiting acceptance`);
  const accepted = i.accepted_on ?? today(env);
  const evaluation = d(rec.data.evaluation_date)!;
  const tl = timeline(evaluation, { processing_month_elected: i.processing_month_elected === true || rec.data.processing_month === true });
  const gate = rec.data.contractual_payment_required === true;
  const next = patch(env, rec, { status: gate ? "awaiting_contractual_payment" : "accepted", accepted_on: accepted, accepted_via: i.accepted_via, processing_month: tl.processing_month, entry_deadline: tl.entry_deadline, lar_by: tl.lar_deadline });
  const event = emit(env, "payment_deferral.accepted", i.loan_id, { deferral_id: rec.id, accepted_on: accepted, accepted_via: i.accepted_via, completion_month_end: tl.entry_deadline, entry_deadline: tl.entry_deadline, lar_by: tl.lar_deadline, processing_month: tl.processing_month, contractual_payment_required: gate, option: "payment_deferral" });
  return { deferral: next.data, event };
}

// ---------------------------------------------------------------------------------------------- contractual payment (rule 4)
export interface ContractualPaymentInput { readonly loan_id: string; readonly deferral_id?: string | null; readonly received_on: PlainDate; readonly amount_cents: Cents; readonly contractual_payment_cents: Cents; }
/** Rule 4: the full contractual payment in the solicitation and/or processing month — a partial or out-of-window receipt does not open the gate. */
export function recordContractualPayment(env: DeferralEnv, i: ContractualPaymentInput): { full: boolean; in_window: boolean; deferral: Record<string, unknown>; event: DomainEvent } {
  const rec = requireDeferral(env, i.loan_id, i.deferral_id);
  const evaluation = d(rec.data.evaluation_date)!;
  const windowEnd = d(rec.data.entry_deadline) ?? timeline(evaluation, { processing_month_elected: rec.data.processing_month === true }).entry_deadline;
  const full = i.amount_cents >= i.contractual_payment_cents;
  const inWindow = i.received_on >= startOfMonth(evaluation) && i.received_on <= windowEnd;
  const opens = full && inWindow;
  const next = patch(env, rec, opens ? { contractual_payment_received_at: i.received_on, ...(rec.data.status === "awaiting_contractual_payment" ? { status: "pending_smdu_entry" } : {}) } : {});
  const event = emit(env, "payment_deferral.contractual_payment.received", i.loan_id, { deferral_id: rec.id, received_on: i.received_on, amount_cents: i.amount_cents, contractual_payment_cents: i.contractual_payment_cents, full, in_window: inWindow, gate_open: opens, window_end: windowEnd });
  return { full, in_window: inWindow, deferral: next.data, event };
}

// ---------------------------------------------------------------------------------------------- completion (SMDU case submission)
export interface CompleteInput { readonly loan_id: string; readonly deferral_id?: string | null; readonly completed_on?: PlainDate | null; readonly processing_month_elected?: boolean; readonly lar_acked?: boolean; }
/**
 * "Fannie Mae considers a payment deferral to be completed when the case is submitted into Fannie Mae's servicing
 * solutions system, including entry of loan-level information such as the applicable campaign ID" (D2-3.2-04). The
 * completion evidence is the loan's latest `smdu.case.submitted{workout=payment_deferral}`; the guards are the state
 * machine's `assertContractualPaymentIfRequired`, `assertLarBeforeCompletion` and `assertEntryByMonthEnd`. A case
 * entered outside the 12.6 offer path (no `payment_deferrals` record) is recorded as-is with the evaluation month =
 * the completion month. Effective date = first day of the month after the completion month; `next_due_date` resets.
 */
/**
 * The state machine's completion guards, run *before* the case is submitted (the 12.6 `smdu.case.submit` tool) and
 * again by `completeDeferral`: `assertContractualPaymentIfRequired`, `assertLarBeforeCompletion` (the 12.6
 * `investor.report_contractual_payments` submission or the 5.x `investor.event.accepted{kind=contractual_payments}`
 * ack on the loan, or the caller's `lar_acked` assertion) and `assertEntryByMonthEnd`. A loan without a
 * `payment_deferrals` record (a case entered outside the 12.6 offer path) has nothing to assert against.
 */
export function assertDeferralCompletable(env: DeferralEnv, i: CompleteInput): { deferral: DeferralRecord | undefined; completed_on: PlainDate; entry_deadline: PlainDate; processing_month: boolean; effective_date: PlainDate } {
  const completedOn = i.completed_on ?? today(env);
  const rec = deferralFor(env, i.loan_id, i.deferral_id);
  if (rec && rec.data.status === "completed") throw new RangeError(`payment deferral ${rec.id} is already completed`);
  if (rec?.data.contractual_payment_required === true && !rec.data.contractual_payment_received_at) throw new RangeError("FNMA_D23204_CONTRACTUAL_PAYMENT_GATE: the full contractual payment has not been received in the solicitation/processing month (D2-3.2-04 rule 4)");
  const larAcked = i.lar_acked === true || env.events.byLoan(i.loan_id).some((e) => e.type === "investor.contractual_payments.reported" || (e.type === "investor.event.accepted" && e.payload.kind === "contractual_payments"));
  if (rec && !larAcked) throw new RangeError("assertLarBeforeCompletion: the full monthly contractual payment must be reported via LAR before completing the deferral (F-1-22)");
  const evaluation = d(rec?.data.evaluation_date) ?? completedOn;
  const tl = timeline(evaluation, { completion_on: completedOn, processing_month_elected: i.processing_month_elected === true || rec?.data.processing_month === true });
  if (completedOn > tl.entry_deadline) throw new RangeError(`assertEntryByMonthEnd: entered ${completedOn} after the ${tl.processing_month ? "processing" : "evaluation"}-month deadline ${tl.entry_deadline} — re-evaluate eligibility next month (D2-3.2-04)`);
  return { deferral: rec, completed_on: completedOn, entry_deadline: tl.entry_deadline, processing_month: tl.processing_month, effective_date: tl.effective };
}
export function completeDeferral(env: DeferralEnv, i: CompleteInput): { deferral: Record<string, unknown>; completed: DomainEvent; effective: DomainEvent; effective_date: PlainDate; entry_deadline: PlainDate; processing_month: boolean } {
  const sub = env.events.byLoan(i.loan_id).filter((e) => e.type === "smdu.case.submitted" && e.payload.workout === "payment_deferral").at(-1);
  if (!sub) throw new RangeError("completion is the SMDU case submission (D2-3.2-04) — submit the PAYMENT_DEFERRAL case first");
  if (!sub.payload.campaign_id) throw new RangeError("the SMDU case must carry the applicable campaign ID (D2-3.2-04)");
  const completedOn = i.completed_on ?? d(sub.payload.submitted_on) ?? today(env);
  const { deferral: rec } = assertDeferralCompletable(env, { ...i, completed_on: completedOn });
  const evaluation = d(rec?.data.evaluation_date) ?? completedOn;
  const tl = timeline(evaluation, { completion_on: completedOn, processing_month_elected: i.processing_month_elected === true || rec?.data.processing_month === true });
  const id = rec?.id ?? `pd-${i.loan_id}-${evaluation}`;
  const base = rec ?? env.store.put(KIND, id, { id, loan_id: i.loan_id, kind: "standard", basis: null, status: "pending_smdu_entry", evaluation_date: evaluation, processing_month: false, recording_required: false, contractual_payment_required: false }, env.actor, env.now);
  const next = patch(env, base, { status: "completed", smdu_case_id: sub.payload.case_id ?? null, campaign_id: sub.payload.campaign_id, smdu_entered_at: completedOn, completed_on: completedOn, processing_month: tl.processing_month, entry_deadline: tl.entry_deadline, lar_by: tl.lar_deadline, effective_date: tl.effective, next_due_date: tl.effective, agreement_by: tl.agreement_by, custodian_by: tl.custodian_by, regx_days_delinquent: 0 });
  const completed = emit(env, "payment_deferral.completed", i.loan_id, { deferral_id: id, case_id: sub.payload.case_id ?? null, campaign_id: sub.payload.campaign_id, completed_on: completedOn, evaluation_date: evaluation, effective_date: tl.effective, processing_month: tl.processing_month, entry_deadline: tl.entry_deadline, lar_by: tl.lar_deadline, agreement_by: tl.agreement_by, custodian_by: tl.custodian_by, submission_event_id: sub.id });
  const effective = emit(env, "payment_deferral.effective", i.loan_id, { deferral_id: id, effective_date: tl.effective, next_due_date: tl.effective, case_id: sub.payload.case_id ?? null, regx_days_delinquent: 0, custodian_by: tl.custodian_by });
  return { deferral: next.data, completed, effective, effective_date: tl.effective, entry_deadline: tl.entry_deadline, processing_month: tl.processing_month };
}

// ---------------------------------------------------------------------------------------------- recording and custodian (T10)
export interface RecordedOriginalInput { readonly loan_id: string; readonly deferral_id?: string | null; readonly document_id: string; readonly received_on: PlainDate; }
/** The recorder returns the original of a recordable agreement (`jurisdiction_rules.deferral_recording=true`) — the custodian gets it within 5 `business_days_servicer`. */
export function recordedOriginalReceived(env: DeferralEnv, i: RecordedOriginalInput): { deferral: Record<string, unknown>; event: DomainEvent; original_to_custodian_by: PlainDate } {
  const rec = requireDeferral(env, i.loan_id, i.deferral_id);
  if (rec.data.recording_required !== true) throw new RangeError(`payment deferral ${rec.id} is not a recordable agreement (jurisdiction_rules.deferral_recording=false)`);
  const by = addBusinessDays(i.received_on, 5, servicer);
  const next = patch(env, rec, { recorded_at: i.received_on, recorded_original_received_at: i.received_on, recorded_document_id: i.document_id });
  const event = emit(env, "erecording.recorded_document.received", i.loan_id, { deferral_id: rec.id, document_id: i.document_id, received_on: i.received_on, receipt: i.received_on, original_to_custodian_by: by });
  return { deferral: next.data, event, original_to_custodian_by: by };
}
export interface CustodianConfirmInput { readonly loan_id: string; readonly deferral_id?: string | null; readonly document: CustodianDocument; readonly confirmed_on: PlainDate; readonly receipt_id: string; }
/** Inbound custodian confirmation: recordable → certified copy within 25 days of the effective date, then the recorded original; otherwise the servicer-signed / fully executed copy within 25 days (D2-3.2-04). */
export function confirmCustodianDelivery(env: DeferralEnv, i: CustodianConfirmInput): { deferral: Record<string, unknown>; event: DomainEvent; complete: boolean } {
  const rec = requireDeferral(env, i.loan_id, i.deferral_id);
  if (!d(rec.data.effective_date)) throw new RangeError(`payment deferral ${rec.id} has no effective date yet — nothing to deliver`);
  const recordable = rec.data.recording_required === true;
  if (i.document === "certified_copy" && !recordable) throw new RangeError("a certified copy is delivered only for a recorded agreement");
  if (i.document === "executed_copy" && recordable) throw new RangeError("a recordable agreement goes to the custodian as a certified copy, then the recorded original");
  if (i.document === "recorded_original" && (!recordable || !rec.data.recorded_original_received_at)) throw new RangeError("the recorded original has not been received from the recorder");
  const deliveries = [...((rec.data.custodian_deliveries as { document: string; on: PlainDate }[] | undefined) ?? []), { document: i.document, on: i.confirmed_on }];
  const complete = recordable ? deliveries.some((x) => x.document === "recorded_original") : deliveries.some((x) => x.document === "executed_copy");
  const next = patch(env, rec, { custodian_deliveries: deliveries, ...(complete ? { custodian_delivered_at: i.confirmed_on, status: "documented" } : {}) });
  const event = emit(env, "custodian.delivery.confirmed", i.loan_id, { deferral_id: rec.id, document: i.document, confirmed_on: i.confirmed_on, receipt_id: i.receipt_id, complete });
  return { deferral: next.data, event, complete };
}

// ---------------------------------------------------------------------------------------------- Texas §50(a)(6) Form 20
export interface FnmaLegalInput { readonly loan_id: string; readonly case_id: string; readonly notice_date?: PlainDate | null; readonly notified_on?: PlainDate | null; readonly ack_id?: string | null; readonly deferral_id?: string | null; }
/**
 * Texas §50(a)(6): "on notice of a violation, inform Fannie Mae Legal (Form 20) within 7 business days and cure within
 * 60 days". The Form 20 filing is validated against the 4.5 allegation on file for the case
 * (`complaint.tx_50a6_defect.alleged{case_id, notice_date}`) and appended as `fnma.legal.notified{form=form_20}`.
 */
export function notifyFnmaLegal(env: DeferralEnv, i: FnmaLegalInput): { event: DomainEvent; due_by: PlainDate; cure_by: PlainDate; late: boolean } {
  const alleged = env.events.byLoan(i.loan_id).filter((e) => e.type === "complaint.tx_50a6_defect.alleged" && (e.payload.case_id === i.case_id || e.aggregate?.id === i.case_id)).at(-1);
  if (!alleged) throw new RangeError(`no §50(a)(6) allegation on file for case ${i.case_id} (4.5 complaint.tx_50a6_defect.alleged)`);
  const noticeDate = i.notice_date ?? d(alleged.payload.notice_date);
  if (!noticeDate) throw new RangeError("the borrower's notice date is required");
  const notified = i.notified_on ?? today(env);
  if (notified < noticeDate) throw new RangeError(`Fannie Mae Legal cannot be notified (${notified}) before the borrower's notice (${noticeDate})`);
  const dueBy = addBusinessDays(noticeDate, 7, servicer);
  const cureBy = addDays(noticeDate, 60);
  const late = notified > dueBy;
  const rec = deferralFor(env, i.loan_id, i.deferral_id);
  const event = emit(env, "fnma.legal.notified", i.loan_id, { form: "form_20", case_id: i.case_id, notice_date: noticeDate, notified_on: notified, due_by: dueBy, cure_by: cureBy, late, ack_id: i.ack_id ?? null, deferral_id: rec?.id ?? null, allegation_event_id: alleged.id });
  return { event, due_by: dueBy, cure_by: cureBy, late };
}

// ---------------------------------------------------------------------------------------------- post-deferral re-delinquency (D2-3.2-06)
export interface RedelinquencyInput { readonly loan_id: string; readonly deferral_id?: string | null; readonly fnma_day: number; readonly on: PlainDate; readonly qrpc: boolean; }
/**
 * "Loan 60+ days delinquent within 6 months of the deferral effective date, no QRPC" → streamlined Flex Mod
 * solicitation by day 75 (12.8). Only the day-60 milestone of a loan whose (completed) deferral is effective opens
 * the window; the event carries the facts the row conditions on and the anchor (`day_60_date`).
 */
export function postDeferralRedelinquency(env: DeferralEnv, i: RedelinquencyInput): DomainEvent | null {
  const rec = deferralFor(env, i.loan_id, i.deferral_id);
  const effective = d(rec?.data.effective_date);
  if (!rec || !effective || i.fnma_day !== 60) return null;
  const within = i.on >= effective && i.on <= addMonths(effective, 6);
  return emit(env, "payment_deferral.redelinquent", i.loan_id, { deferral_id: rec.id, effective_date: effective, fnma_day: 60, day_60_date: i.on, post_deferral_within_6m: within, qrpc: i.qrpc, solicit_by: within && !i.qrpc ? addDays(i.on, 15) : null, next: within && !i.qrpc ? "flex_mod_streamlined" : null });
}

// ---------------------------------------------------------------------------------------------- event wiring
/**
 * Subscribes the 12.6 derivations to the platform events they follow: the 12.2 offer response
 * (`lossmit.offer.responded{response=accepted, option=payment_deferral}`) becomes `payment_deferral.accepted` for the
 * loan's offered/solicited deferral, and the 11.1 counter's `loan.delinquency.day_reached{fnma_day=60}` becomes
 * `payment_deferral.redelinquent` for a loan with an effective deferral. Loans without a 12.6 record are left alone.
 */
export function watchDeferralEvents(deps: { events: EventStore; store: DeferralStore; actor?: Actor }): () => void {
  const env = (e: DomainEvent): DeferralEnv => ({ events: deps.events, store: deps.store, actor: deps.actor ?? DEFERRAL_ACTOR, now: e.occurredAt });
  const offAccept = deps.events.subscribe("`lossmit.offer.responded{response=accepted, option=payment_deferral}`", (e) => {
    if (!e.loanId) return; const x = env(e); const rec = deferralFor(x, e.loanId);
    if (rec && (rec.data.status === "offered" || rec.data.status === "solicited")) acceptDeferral(x, { loan_id: e.loanId, deferral_id: rec.id, accepted_on: d(e.payload.responded_on), accepted_via: String(e.payload.accepted_via ?? "contact") });
  });
  const offDay60 = deps.events.subscribe("`loan.delinquency.day_reached{fnma_day=60}`", (e) => {
    if (!e.loanId) return; const on = d(e.payload.on) ?? plainDate(e.occurredAt.slice(0, 10));
    postDeferralRedelinquency(env(e), { loan_id: e.loanId, fnma_day: 60, on, qrpc: e.payload.qrpc === true || e.payload.qrpc_established === true });
  });
  return () => { offAccept(); offDay60(); };
}
