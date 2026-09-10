/**
 * §10.6 process-owned operations — the denial composed from the decision record, the borrower's response routed
 * (NoE / SMDU valuation appeal / human review), the human-review clock and its outcome letter, and the send-time
 * guardrails the `notices.*` tool enforces.
 *
 * AI agent design (spec 10.6): "The `pmi` agent composes the denial from the decision record: it selects reason codes
 * only from `mi_evaluations.reasons` (no free-form grounds), fills the numeric fields from the evaluation snapshot,
 * drafts the cure paragraph, runs the required-content checklist, and sends." — `composeDenial` is that path: the
 * grounds, numbers, valuation paragraph and cure come from the stored `mi_evaluations` row, never from the caller.
 * Guardrails: "the notice cannot issue without a linked `mi_evaluations` row" (`DENIAL_NEEDS_EVALUATION_ROW` reads the
 * loan's `mi.evaluation.completed` record); "any change to numbers after composition forces re-composition"
 * (`RECOMPOSE_AFTER_NUMBER_CHANGE` compares the payload's numbers with the `mi.denial.composed` snapshot).
 *
 * Inputs and triggers: "`mi.denial.disputed` (borrower response) → NoE case (Section 4.1) or valuation appeal
 * (`mi.valuation.appeal_requested`, within 60 days of evaluation); `mi.human_review.requested`." —
 * `attachDenialHooks_10_6` is the ingestion handler for the inbound borrower response; `requestHumanReview` appends
 * `mi.human_review.requested` (the SM_MI_HUMAN_REVIEW_10BD trigger) and opens the `human_agent` task with the package;
 * `completeHumanReview` appends `mi.human_review.completed` with the outcome letter (the satisfier) and, on a reversal,
 * hands the grant to 10.1 finalization (`cancelBasisOnRecord`) with the 10.5 refund of premiums collected since.
 */
import type { CommandContext, Guardrail } from "../../app/commands.ts";
import { guard, str, cents, type ToolInput, type ToolRuntime, type EntityStore } from "../../app/tools.ts";
import type { EscalationService, Escalation } from "../../app/escalations.ts";
import { SYSTEM, type Actor, type DomainEvent, type EventStore } from "../../kernel/events/index.ts";
import type { TimerEngine } from "../../kernel/timers/index.ts";
import { type PlainDate, addDays, addMonths, parts, plainDate as D } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, servicer } from "../../kernel/calendar/business.ts";
import { type Cents, formatCents } from "../../kernel/money/cents.ts";
import { bpsToPercent, seasoningMonths, type LateInstallment } from "./cancellation.ts";
import { denialDue, historyRenewalDate, humanReviewDue, ltvDenialContent, reversalGrant, valuationDenialWindows, disputeRoute } from "./denial.ts";
import { buildSchedule, scheduledDateForPct, type ScheduleTerms } from "./schedule.ts";

const money = (c: Cents): string => formatCents(c, { symbol: true, grouping: true });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d: PlainDate): string => { const p = parts(d); return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`; };
const isDate = (v: unknown): v is PlainDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const optDate = (v: unknown): PlainDate | null => (isDate(v) ? v : null);
const optCents = (v: unknown): Cents | null => (v === undefined || v === null || v === "" ? null : cents(v));

export type DenialKind = "request_denial" | "auto_not_current" | "midpoint_not_current" | "case_expired" | "info_request";
export type ValuationKind = "bpo" | "appraisal" | "avm" | "none";
const VALUATION_LABEL: Record<Exclude<ValuationKind, "none">, string> = { bpo: "broker price opinion", appraisal: "appraisal", avm: "automated valuation" };
const valuationKindOf = (raw: unknown): ValuationKind => { const k = String(raw ?? ""); if (/avm/.test(k)) return "avm"; if (/appraisal|1025/.test(k)) return "appraisal"; if (/bpo/.test(k)) return "bpo"; return "none"; };

/** `mi_denial_reasons` (reference): code → HPA / Fannie Mae ground and the data fields the paragraph needs (spec 10.6 data model). */
export const MI_DENIAL_REASONS: Readonly<Record<string, { hpa_ground: string; fnma_ground: string; required_fields: readonly string[] }>> = {
  LTV_ABOVE_THRESHOLD: { hpa_ground: "12 U.S.C. 4902(a)(1): the principal balance has not reached 80 percent of the original value", fnma_ground: "B-8.1-04 original value: balance above the threshold", required_fields: ["evaluation_upb_cents", "basis_value_cents", "ltv_bps", "threshold_bps"] },
  LTV_ABOVE_THRESHOLD_ORIGINAL: { hpa_ground: "12 U.S.C. 4902(a)(1)", fnma_ground: "B-8.1-04 original value", required_fields: ["evaluation_upb_cents", "basis_value_cents", "ltv_bps", "threshold_bps"] },
  LTV_ABOVE_THRESHOLD_CURRENT: { hpa_ground: "n/a (current-value path is Fannie Mae's)", fnma_ground: "B-8.1-04 current value: balance above 75/80 percent of the current value", required_fields: ["evaluation_upb_cents", "basis_value_cents", "ltv_bps", "threshold_bps", "valuation"] },
  NOT_CURRENT: { hpa_ground: "12 U.S.C. 4902(a)(3): the mortgagor is not current", fnma_ground: "B-8.1-04: current as of the last day of the preceding month", required_fields: ["received_on"] },
  PAYMENT_HISTORY_30_12M: { hpa_ground: "12 U.S.C. 4902(a)(4)(B)(i): a payment 30 or more days past due within the 12 months before the request", fnma_ground: "B-8.1-04 acceptable payment record", required_fields: ["late_installments"] },
  PAYMENT_HISTORY_60_24M: { hpa_ground: "12 U.S.C. 4902(a)(4)(B)(ii): a payment 60 or more days past due within the 24 months before the request", fnma_ground: "B-8.1-04 acceptable payment record", required_fields: ["late_installments"] },
  SEASONING_INSUFFICIENT: { hpa_ground: "n/a", fnma_ground: "B-8.1-04: current-value requests need 24 months of seasoning (60 months at 80 percent)", required_fields: ["consummation"] },
  SEASONING_LT_24M: { hpa_ground: "n/a", fnma_ground: "B-8.1-04: 24 months of seasoning", required_fields: ["consummation"] },
  SEASONING_LT_60M_LTV_GT_75: { hpa_ground: "n/a", fnma_ground: "B-8.1-04: 75 percent between 24 and 60 months", required_fields: ["consummation", "ltv_bps"] },
  VALUE_DECLINED_BELOW_ORIGINAL: { hpa_ground: "12 U.S.C. 4902(a)(4)(A): the value has declined below the original value", fnma_ground: "B-8.1-04 value check", required_fields: ["valuation"] },
  IMPROVEMENTS_NOT_SUBSTANTIATED: { hpa_ground: "n/a", fnma_ground: "B-8.1-04 improvements", required_fields: [] },
  PROPERTY_TYPE_70_RULE: { hpa_ground: "n/a", fnma_ground: "B-8.1-04: 70 percent for two- to four-unit principal residences and investment properties", required_fields: ["ltv_bps", "threshold_bps"] },
  ASSUMPTION_HISTORY_LT_24M: { hpa_ground: "n/a", fnma_ground: "B-8.1-04 assumptions", required_fields: [] },
  EVIDENCE_NOT_RECEIVED: { hpa_ground: "12 U.S.C. 4902(a)(4)(A): evidence and certification not satisfied", fnma_ground: "F-1-02 fee not received", required_fields: [] },
  SUBORDINATE_LIEN_CERT_MISSING: { hpa_ground: "12 U.S.C. 4902(a)(4)(B)(ii)", fnma_ground: "B-8.1-04", required_fields: [] },
  MI_NOT_BORROWER_PAID: { hpa_ground: "12 U.S.C. 4905 (lender-paid: informational)", fnma_ground: "n/a", required_fields: [] },
  MI_NOT_ACTIVE: { hpa_ground: "n/a", fnma_ground: "n/a", required_fields: [] },
  REQUEST_NOT_FROM_AUTHORIZED_PARTY: { hpa_ground: "n/a", fnma_ground: "n/a", required_fields: [] },
};

// ---- composition -----------------------------------------------------------------

export interface ComposeDenialInput {
  readonly loan_id: string;
  readonly evaluation_id: string;
  readonly notice_date: PlainDate;
  /** Loan identifiers / contact block the template needs (`account_last4`, `property_address`, `servicer_*`); the composed fields override anything else. */
  readonly identity?: Record<string, unknown>;
  readonly state?: string | null;
  readonly case_id?: string | null;
  /** The loan's amortization terms, so the cure paragraph can name the scheduled 80 percent date (R2 "projected scheduled 80% date"). */
  readonly schedule?: ScheduleTerms;
}
export interface DenialNumbers { readonly evaluation_upb_cents: string; readonly value_cents: string; readonly ltv_percent: string; readonly threshold_percent: string; }
export interface DenialComposition {
  readonly denial_id: string;
  readonly kind: "request_denial";
  readonly evaluation_id: string;
  readonly reason_codes: readonly string[];
  readonly determined_at: PlainDate;
  readonly due_on: PlainDate;
  readonly numbers: DenialNumbers;
  /** The `NTC_HPA_4904B_DENIAL` payload the `notices.*` tool sends. */
  readonly payload: Record<string, unknown>;
  /** The valuation the borrower may appeal (only when it did not support termination) — `smdu.valuation.appeal` input. */
  readonly appeal: { readonly valuation_kind: ValuationKind; readonly appeal_by: PlainDate; readonly valid_until: PlainDate } | null;
}

/** The evaluation the denial rests on, from the loan's record: the `mi_evaluations` row whose `mi.evaluation.completed` is on the event log. */
export function evaluationOnRecord(loanEvents: readonly DomainEvent[], evaluationId: string): DomainEvent | undefined {
  return loanEvents.find((e) => e.type === "mi.evaluation.completed" && e.payload.evaluation_id === evaluationId);
}

export function composeDenial(deps: { events: EventStore; store: EntityStore; actor: Actor; now: string }, i: ComposeDenialInput): DenialComposition {
  if (!i.loan_id || !i.evaluation_id) throw new RangeError("loan_id and evaluation_id are required");
  const rec = deps.store.get("mi_evaluations", i.evaluation_id);
  const onRecord = evaluationOnRecord(deps.events.byLoan(i.loan_id), i.evaluation_id);
  if (!rec || !onRecord) throw new RangeError(`no mi_evaluations row ${i.evaluation_id} on ${i.loan_id}`);
  const ev = rec.data;
  if (ev.loan_id !== i.loan_id) throw new RangeError(`evaluation ${i.evaluation_id} belongs to ${String(ev.loan_id)}, not ${i.loan_id}`);
  if (ev.result !== "ineligible") throw new RangeError(`evaluation ${i.evaluation_id} is ${String(ev.result)}; a denial states an ineligible decision`);
  const reasons = Array.isArray(ev.reasons) ? (ev.reasons as unknown[]).map(String) : [];
  if (reasons.length === 0) throw new RangeError(`evaluation ${i.evaluation_id} carries no reason codes`);
  const unknown = reasons.filter((r) => !MI_DENIAL_REASONS[r]);
  if (unknown.length) throw new RangeError(`reason codes not in mi_denial_reasons: ${unknown.join(", ")}`);

  const upb = cents(ev.evaluation_upb_cents), value = cents(ev.basis_value_cents);
  const ltvBps = Number(ev.ltv_bps), thresholdBps = ev.threshold_bps === null || ev.threshold_bps === undefined ? null : Number(ev.threshold_bps);
  const path = String(ev.path ?? "original_value");
  const receivedOn = optDate(ev.received_on) ?? optDate(ev.evaluated_at)!;
  const determinedAt = optDate(ev.evaluated_at) ?? D(deps.now.slice(0, 10));
  const evidenceOn = optDate(ev.evidence_satisfied_on) ?? optDate(ev.valuation_delivered_on);
  const consummation = optDate(ev.consummation);
  const lates = Array.isArray(ev.late_installments) ? (ev.late_installments as LateInstallment[]) : [];
  const avm = optCents(ev.avm_cents);
  const delivered = [...deps.events.byLoan(i.loan_id)].reverse().find((e) => e.type === "mi.valuation.delivered");
  const valuationKind: ValuationKind = path === "current_value" ? (valuationKindOf(delivered?.payload.kind) === "none" ? "bpo" : valuationKindOf(delivered?.payload.kind)) : avm !== null ? "avm" : "none";
  const deliveredOn = optDate(ev.valuation_delivered_on) ?? optDate(delivered?.payload.delivered_at);
  const thresholdText = thresholdBps === null ? "the applicable" : `${Math.floor(thresholdBps / 100)} percent`;
  const c = ltvDenialContent({ evaluation_upb_cents: upb, value_cents: value, ltv_bps: ltvBps, threshold_bps: thresholdBps ?? 8000, scheduled_80_date: null });

  const grounds: string[] = [], cure: string[] = [], reasonData: Record<string, unknown> = { evaluation_upb_cents: upb, basis_value_cents: value, ltv_bps: ltvBps, threshold_bps: thresholdBps, path, received_on: receivedOn, evidence_satisfied_on: evidenceOn };
  for (const r of reasons) {
    switch (r) {
      case "LTV_ABOVE_THRESHOLD": case "LTV_ABOVE_THRESHOLD_ORIGINAL": case "PROPERTY_TYPE_70_RULE": {
        grounds.push(`your loan balance is above ${thresholdText} of the original value of your property.`);
        const sched = i.schedule ? scheduledDateForPct(buildSchedule(i.schedule), value, thresholdBps !== null ? thresholdBps / 100 : 80) : null;
        if (sched) reasonData.scheduled_threshold_date = sched.due_date;
        const cv = consummation ? { from: addMonths(consummation, 24), at80: addMonths(consummation, 60) } : null;
        cure.push(`${sched ? `your balance is scheduled to reach ${thresholdText} on ${longDate(sched.due_date)} (${sched.due_date}); you may qualify earlier when` : "you may qualify when"} your balance is ${c.balance_needed} or less${cv ? `, or you may ask us to evaluate the current value of your property after ${longDate(cv.from)} at a threshold of 75 percent (80 percent from ${longDate(cv.at80)}) with a broker price opinion at ${c.current_value_fee}` : `, or you may ask us to evaluate the current value of your property with a broker price opinion at ${c.current_value_fee}`}.`);
        break;
      }
      case "LTV_ABOVE_THRESHOLD_CURRENT": case "SEASONING_LT_60M_LTV_GT_75": {
        grounds.push(`your loan balance is above ${thresholdText} of the current value of your property.`);
        cure.push(`a balance of ${c.balance_needed} or less would meet the ${thresholdText} threshold.`);
        break;
      }
      case "NOT_CURRENT": {
        grounds.push(`your loan was not current as of the last day of the month before we received your request on ${receivedOn}.`);
        cure.push("once your loan is current you may renew your request; cancellation takes effect after you become current.");
        break;
      }
      case "PAYMENT_HISTORY_30_12M": case "PAYMENT_HISTORY_60_24M": {
        const win = r === "PAYMENT_HISTORY_30_12M" ? { months: 12, days: 30 } : { months: 24, days: 60 };
        const named = lates.filter((l) => l.days_late >= win.days);
        if (named.length === 0) throw new RangeError(`${r} without the offending installment on the evaluation row (late_installments)`);
        grounds.push(`your payment history does not meet the requirement: ${named.map((l) => `the installment due ${l.due_date} was received ${l.paid_on ?? "—"}, ${l.days_late} days past due`).join("; ")}, within the ${win.months} months before your request (no payment may be ${win.days} or more days past due in that period).`);
        const renewals = named.map((l) => (l.paid_on ? (win.months === 12 ? historyRenewalDate(l.paid_on) : addDays(addMonths(l.paid_on, 24), 1)) : null)).filter((d): d is PlainDate => d !== null);
        const renewal = renewals.length ? renewals.reduce((a, b) => (b > a ? b : a)) : null;
        reasonData.late_installments = named; reasonData.renewal_on = renewal;
        cure.push(renewal ? `a renewed request on or after ${renewal}, when the ${win.months}-month window no longer contains ${named.length === 1 ? "that installment" : "those installments"} (assuming no other late payments), would satisfy the payment-history condition.` : "a renewed request once the late installment is paid and ages out of the look-back window would satisfy the payment-history condition.");
        break;
      }
      case "SEASONING_INSUFFICIENT": case "SEASONING_LT_24M": {
        grounds.push("your loan has not been in place for the 24 months Fannie Mae requires before the current value of your property may be used (B-8.1-04).");
        if (consummation) cure.push(`you may renew a current-value request on or after ${longDate(addMonths(consummation, 24))}.`);
        break;
      }
      case "VALUE_DECLINED_BELOW_ORIGINAL": grounds.push("the current value of your property is below its original value, so the original-value path is not available (12 U.S.C. 4902(a)(4)(A))."); cure.push("you may ask us to evaluate the current value of your property under Fannie Mae's current-value path."); break;
      case "EVIDENCE_NOT_RECEIVED": grounds.push("the valuation fee or certification we requested was not received within 60 days."); cure.push("you may renew your request and provide the fee or certification."); break;
      default: grounds.push(`${MI_DENIAL_REASONS[r]!.fnma_ground} (${r}).`); break;
    }
  }

  // R2 "for value — valuation type, value, date, and the AVM disclaimer (or BPO/appraisal result and the appeal/120-day rules)"
  let valuationText = "No valuation was used to make this determination.", appeal: DenialComposition["appeal"] = null;
  if (valuationKind === "avm") valuationText = `The automated value of ${money(path === "current_value" ? value : avm!)}${deliveredOn ? ` as of ${deliveredOn}` : ""} was developed by an automated valuation model and is not an appraisal; it may not be appealed, but you may pay for a broker price opinion or appraisal.`;
  else if (valuationKind !== "none") {
    if (!deliveredOn) throw new RangeError("a current-value denial needs the valuation delivery date (valuation_delivered_on)");
    const w = valuationDenialWindows(deliveredOn);
    valuationText = `This determination used a ${VALUATION_LABEL[valuationKind]} of ${money(value)} delivered ${deliveredOn}. Because it did not support cancellation, you may appeal it through us until ${w.appeal_by}; the valuation remains valid until ${w.valid_until}.`;
    appeal = { valuation_kind: valuationKind, appeal_by: w.appeal_by, valid_until: w.valid_until };
    reasonData.valuation = { kind: valuationKind, value_cents: value, delivered_on: deliveredOn, appeal_by: w.appeal_by, valid_until: w.valid_until };
  }
  const seasoning = consummation ? seasoningMonths(consummation, determinedAt) : null;
  const pathText = path === "current_value" ? `Fannie Mae current value${seasoning !== null ? ` (${seasoning} months of seasoning)` : ""}` : ev.hpa_covered === false ? "Fannie Mae original value" : "Homeowners Protection Act and Fannie Mae original value";
  const numbers: DenialNumbers = { evaluation_upb_cents: String(upb), value_cents: String(value), ltv_percent: bpsToPercent(ltvBps), threshold_percent: thresholdBps === null ? "" : bpsToPercent(thresholdBps) };
  const payload: Record<string, unknown> = {
    ...(i.identity ?? {}), notice_date: i.notice_date, received_on: receivedOn, evaluation_id: i.evaluation_id, reason_codes: reasons,
    grounds_text: grounds.join(" "), evaluation_upb_cents: upb, ltv_percent: numbers.ltv_percent, value_label: path === "current_value" ? "current value" : "original value", value_cents: value,
    path_text: pathText, threshold_percent: numbers.threshold_percent, valuation_kind: valuationKind, valuation_text: valuationText, ...(valuationKind === "avm" ? { avm_disclaimer: true } : {}),
    mn_overlay: i.state === "MN", cure_text: cure.join(" "),
  };
  const dueOn = denialDue({ received_on: receivedOn, evidence_satisfied_on: evidenceOn, scheduled_termination_on: null, state: i.state ?? "" });
  const denialId = `den-${i.loan_id}-${deps.store.list("mi_denials", (d) => d.loan_id === i.loan_id).length + 1}`;
  deps.store.put("mi_denials", denialId, { id: denialId, case_id: i.case_id ?? ev.case_id ?? null, loan_id: i.loan_id, kind: "request_denial", determined_at: determinedAt, evaluation_id: i.evaluation_id, reason_codes: reasons, reason_data: reasonData, valuation_id: null, notice_id: null, due_on: dueOn, sent_at: null, human_review_requested_at: null, human_review_outcome: null, qc_sampled: false, superseded_by_grant_id: null, status: "notice_composed" }, deps.actor, deps.now);
  deps.events.append({ type: "mi.denial.composed", loanId: i.loan_id, actor: deps.actor, payload: { denial_id: denialId, evaluation_id: i.evaluation_id, kind: "request_denial", reason_codes: reasons, due_on: dueOn, numbers, template: "NTC_HPA_4904B_DENIAL" } });
  return { denial_id: denialId, kind: "request_denial", evaluation_id: i.evaluation_id, reason_codes: reasons, determined_at: determinedAt, due_on: dueOn, numbers, payload, appeal };
}

/** MN §47.207 subd. 4 "request additional information" (also used nationally when the request lacks essentials): the `NTC_MI_INFO_REQUEST` payload and its `mi_denials` row (kind `info_request`, due 30 days from receipt). */
export function composeInfoRequest(deps: { events: EventStore; store: EntityStore; actor: Actor; now: string }, i: { loan_id: string; received_on: PlainDate; state: string | null; missing: readonly string[]; notice_date: PlainDate; identity?: Record<string, unknown>; case_id?: string | null }): { denial_id: string; due_on: PlainDate; payload: Record<string, unknown>; closes_after_days: 60 } {
  if (!i.loan_id) throw new RangeError("loan_id is required");
  if (i.missing.length === 0) throw new RangeError("an information request names what is missing");
  const dueOn = addDays(i.received_on, 30);
  const denialId = `den-${i.loan_id}-${deps.store.list("mi_denials", (d) => d.loan_id === i.loan_id).length + 1}`;
  deps.store.put("mi_denials", denialId, { id: denialId, case_id: i.case_id ?? null, loan_id: i.loan_id, kind: "info_request", determined_at: i.notice_date, evaluation_id: null, reason_codes: ["EVIDENCE_NOT_RECEIVED"], reason_data: { missing: i.missing, received_on: i.received_on, state: i.state }, valuation_id: null, notice_id: null, due_on: dueOn, sent_at: null, human_review_requested_at: null, human_review_outcome: null, qc_sampled: false, superseded_by_grant_id: null, status: "notice_composed" }, deps.actor, deps.now);
  deps.events.append({ type: "mi.denial.composed", loanId: i.loan_id, actor: deps.actor, payload: { denial_id: denialId, evaluation_id: null, kind: "info_request", reason_codes: ["EVIDENCE_NOT_RECEIVED"], due_on: dueOn, numbers: null, template: "NTC_MI_INFO_REQUEST" } });
  return { denial_id: denialId, due_on: dueOn, closes_after_days: 60, payload: { ...(i.identity ?? {}), notice_date: i.notice_date, received_on: i.received_on, missing: i.missing.map((item) => ({ item })), mn_overlay: i.state === "MN", denial_id: denialId } };
}

// ---- send-time guardrails ----------------------------------------------------------

const DENIAL = "NTC_HPA_4904B_DENIAL";
const loanOf = (i: ToolInput, ctx: CommandContext): string => (typeof i.loan_id === "string" && i.loan_id ? i.loan_id : ctx.loanId ?? "");
const payloadOf = (i: ToolInput): Record<string, unknown> => (i.payload !== null && typeof i.payload === "object" && !Array.isArray(i.payload) ? (i.payload as Record<string, unknown>) : {});

/** 10.6 guardrail: "the notice cannot issue without a linked `mi_evaluations` row" — the row is the `mi.evaluation.completed` on the loan's record, and it must be the ineligible decision the denial states. */
export const DENIAL_NEEDS_EVALUATION_ROW: Guardrail<ToolInput> = guard("DENIAL_NEEDS_EVALUATION", "10.6 guardrail: the denial cannot issue without a linked `mi_evaluations` row", (i, ctx) => {
  if (str(i, "template_code") !== DENIAL) return undefined;
  const id = typeof i.evaluation_id === "string" && i.evaluation_id ? i.evaluation_id : typeof payloadOf(i).evaluation_id === "string" ? String(payloadOf(i).evaluation_id) : null;
  if (!id) return "link the evaluation row first (evaluation_id)";
  const e = evaluationOnRecord(ctx.events.byLoan(loanOf(i, ctx)), id);
  if (!e) return `no mi_evaluations row ${id} on the loan's record (mi.evaluation.completed)`;
  if (e.payload.result !== "ineligible") return `evaluation ${id} is ${String(e.payload.result)}, not ineligible — a denial states an ineligible decision`;
  return undefined;
});

const NUMBER_KEYS: readonly (keyof DenialNumbers)[] = ["evaluation_upb_cents", "value_cents", "ltv_percent", "threshold_percent"];
/** 10.6 guardrail: "any change to numbers after composition forces re-composition" — the payload's numbers must equal the `mi.denial.composed` snapshot of the evaluation. */
export const RECOMPOSE_AFTER_NUMBER_CHANGE: Guardrail<ToolInput> = guard("RECOMPOSE_AFTER_NUMBER_CHANGE", "10.6 guardrail: any change to numbers after composition forces re-composition", (i, ctx) => {
  if (str(i, "template_code") !== DENIAL) return undefined;
  const id = typeof i.evaluation_id === "string" ? i.evaluation_id : "";
  const composed = [...ctx.events.byLoan(loanOf(i, ctx))].reverse().find((e) => e.type === "mi.denial.composed" && e.payload.evaluation_id === id);
  if (!composed) return undefined;
  const snap = composed.payload.numbers as DenialNumbers, p = payloadOf(i);
  const changed = NUMBER_KEYS.filter((k) => String(p[k] ?? "") !== snap[k]);
  return changed.length ? `${changed.join(", ")} differ from the composed denial ${String(composed.payload.denial_id)} — re-compose from the evaluation (composeDenial) instead of editing the numbers` : undefined;
});

// ---- borrower response: NoE / appeal / human review ---------------------------------------

export interface DenialDeps { readonly events: EventStore; readonly store: EntityStore; readonly actor: Actor; readonly now: string; readonly timers?: TimerEngine; readonly escalations?: Pick<EscalationService, "open" | "complete"> & { readonly opened?: readonly Escalation[] }; }
const depsOf = (ctx: CommandContext, rt: ToolRuntime): DenialDeps => ({ events: ctx.events, store: rt.store, actor: ctx.actor, now: ctx.now, timers: ctx.timers, escalations: rt.escalations });

export interface NoeFromDenialInput { readonly loan_id: string; readonly received_on: PlainDate; readonly pmi_case_id: string; readonly evaluation_id?: string | null; readonly assertion: string; readonly id?: string | null; readonly state?: string | null; }
/**
 * R4 — "A written dispute asserting an error → NoE (Section 4.1) with the PMI case attached." The case opens with the
 * §4.1 `case.noe.opened` record (§1024.35(b)(11) "any other servicing error"; (b)(1)–(3) when a payment was misapplied),
 * so REGX_1024_35D_NOE_ACK_5 / REGX_1024_35E_NOE_RESPONSE_30 arm on `receipt_date` (5 / 30 federal business days).
 */
export function openDenialDisputeNoe(deps: DenialDeps, i: NoeFromDenialInput): Record<string, unknown> {
  if (!i.loan_id || !i.received_on) throw new RangeError("loan_id and received_on are required");
  if (!i.pmi_case_id) throw new RangeError("pmi_case_id is required: the NoE from a denial dispute links the PMI case");
  if (!i.assertion) throw new RangeError("assertion is required (the borrower's written assertion of error)");
  const on = i.received_on, ackDue = addBusinessDays(on, 5, federal), responseDue = addBusinessDays(on, 30, federal);
  const paymentRelated = /payment|late|past due|misappl/i.test(i.assertion);
  const caseId = i.id || `noe-${i.loan_id}-${on}`;
  const assertions = [{ id: `${caseId}:1`, category: paymentRelated ? "b1_3" : "b11", profile: "std_30", ack_due: ackDue, response_due: responseDue, identifiable: true, description: i.assertion }];
  const row = deps.store.put("cases", caseId, { loan_id: i.loan_id, case_type: "noe", received_on: on, receipt_date: on, ack_due: ackDue, response_due: responseDue, pmi_case_id: i.pmi_case_id, evaluation_id: i.evaluation_id ?? null, assertion: i.assertion, deadline_profiles: ["std_30"], linked_case_ids: [i.pmi_case_id], status: "open", source: "denial_dispute" }, deps.actor, deps.now);
  deps.events.append({ type: "case.noe.opened", loanId: i.loan_id, actor: deps.actor, aggregate: { kind: "case", id: caseId }, payload: { case_id: caseId, receipt_date: on, receipt_at: deps.now, received_on: on, state: i.state ?? null, ack_required: true, ack_due: ackDue, std_assertion: true, payment_related: paymentRelated, payoff_assertion: false, foreclosure_assertion: false, fc_response_assertion: false, goodfaith_assertion: false, assertions, linked_case_ids: [i.pmi_case_id], pmi_case_id: i.pmi_case_id, evaluation_id: i.evaluation_id ?? null, source: "denial_dispute" } });
  return { ...row.data, id: caseId };
}
/** The 10.6 `case.noe.open` tool handler. */
export function caseNoeOpen_10_6(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  return openDenialDisputeNoe(depsOf(ctx, rt), { loan_id: str(i, "loan_id"), received_on: D(str(i, "received_on")), pmi_case_id: str(i, "pmi_case_id"), evaluation_id: (i.evaluation_id as string | undefined) ?? null, assertion: str(i, "assertion"), id: (i.id as string | undefined) ?? null, state: (i.state as string | undefined) ?? null });
}

export interface HumanReviewRequest { readonly loan_id: string; readonly requested_on: PlainDate; readonly evaluation_id: string; readonly denial_id?: string | null; readonly requester_party_id?: string | null; readonly reason?: string | null; }
export interface HumanReviewOpened { readonly review_id: string; readonly due: PlainDate; readonly timer_id: string | null; readonly task: Escalation | null; readonly package: Record<string, unknown>; }
/**
 * R4 — "a request for a human → `human_agent` review within 10 BD". Appends `mi.human_review.requested` (the
 * SM_MI_HUMAN_REVIEW_10BD trigger, anchored on `request_date`) and opens the `human_agent` task with "the human reviewer's
 * package (evaluation inputs, payment-history table with dates, valuation report, rule citations)" under that SLA timer.
 */
export function requestHumanReview(deps: DenialDeps, i: HumanReviewRequest): HumanReviewOpened {
  if (!i.loan_id || !i.requested_on || !i.evaluation_id) throw new RangeError("loan_id, requested_on and evaluation_id are required");
  const loanEvents = deps.events.byLoan(i.loan_id);
  const onRecord = evaluationOnRecord(loanEvents, i.evaluation_id);
  if (!onRecord) throw new RangeError(`no mi_evaluations row ${i.evaluation_id} on ${i.loan_id}`);
  const ev = deps.store.get("mi_evaluations", i.evaluation_id)?.data ?? onRecord.payload;
  const denial = i.denial_id ? deps.store.get("mi_denials", i.denial_id) : deps.store.list("mi_denials", (d) => d.loan_id === i.loan_id && d.evaluation_id === i.evaluation_id).at(-1);
  const due = humanReviewDue(i.requested_on, servicer);
  const reviewId = `hr-${i.loan_id}-${deps.store.list("mi_human_reviews", (d) => d.loan_id === i.loan_id).length + 1}`;
  const lates = Array.isArray(ev.late_installments) ? (ev.late_installments as LateInstallment[]) : [];
  const valuation = [...loanEvents].reverse().find((e) => e.type === "mi.valuation.delivered")?.payload ?? null;
  const reasons = Array.isArray(ev.reasons) ? (ev.reasons as unknown[]).map(String) : [];
  const pkg: Record<string, unknown> = {
    evaluation_id: i.evaluation_id, denial_id: denial?.id ?? null,
    evaluation_inputs: { path: ev.path, evaluation_upb_cents: ev.evaluation_upb_cents, basis_value_cents: ev.basis_value_cents, ltv_bps: ev.ltv_bps, threshold_bps: ev.threshold_bps, received_on: ev.received_on ?? null, evaluated_at: ev.evaluated_at, reasons, smdu_evaluation_id: ev.smdu_evaluation_id ?? null },
    payment_history: { late30_12m: ev.late30_12m ?? null, late60_24m: ev.late60_24m ?? null, installments: lates.map((l) => ({ due_date: l.due_date, paid_on: l.paid_on, days_late: l.days_late, disaster_attributable: l.disaster_attributable })) },
    valuation_report: valuation ? { kind: valuation.kind, value_cents: valuation.value_cents, delivered_at: valuation.delivered_at } : null,
    rule_citations: [...new Set(["12 U.S.C. 4902(a)", "12 U.S.C. 4904(b)", "B-8.1-04", ...reasons.map((r) => MI_DENIAL_REASONS[r]?.hpa_ground ?? r)])],
    borrower_reason: i.reason ?? null, colorado_ai_act: "deterministic rule evaluation plus Fannie Mae's SMDU decision — human review on request (baseline §8)",
  };
  const requested = deps.events.append({ type: "mi.human_review.requested", loanId: i.loan_id, actor: deps.actor, payload: { review_id: reviewId, request_date: i.requested_on, evaluation_id: i.evaluation_id, denial_id: denial?.id ?? null, due, requester_party_id: i.requester_party_id ?? null, package: pkg } });
  const timer = deps.timers?.byCode("SM_MI_HUMAN_REVIEW_10BD").find((t) => t.armedByEventId === requested.id) ?? null;
  const task = deps.escalations?.open({ kind: "human_agent", loanId: i.loan_id, ...(denial ? { caseId: denial.id } : {}), payload: { review_id: reviewId, package: pkg, due, outcome_options: ["upheld", "reversed"] }, ...(timer ? { slaTimerId: timer.id } : {}) }, deps.actor) ?? null;
  deps.store.put("mi_human_reviews", reviewId, { id: reviewId, loan_id: i.loan_id, evaluation_id: i.evaluation_id, denial_id: denial?.id ?? null, requested_on: i.requested_on, due, timer_id: timer?.id ?? null, task_id: task?.id ?? null, status: "open", outcome: null, outcome_letter_document_id: null }, deps.actor, deps.now);
  if (denial) deps.store.put("mi_denials", denial.id, { human_review_requested_at: deps.now, status: "human_review" }, deps.actor, deps.now);
  return { review_id: reviewId, due, timer_id: timer?.id ?? null, task, package: pkg };
}

export interface HumanReviewOutcome { readonly review_id: string; readonly outcome: "upheld" | "reversed"; readonly outcome_letter_document_id: string; readonly completed_on?: PlainDate; readonly qualified_on?: PlainDate | null; readonly premiums_collected?: readonly { on: PlainDate; amount_cents: Cents }[]; }
export interface HumanReviewClosed { readonly review_id: string; readonly outcome: "upheld" | "reversed"; readonly completed_on: PlainDate; readonly on_time: boolean; readonly grant: ReturnType<typeof reversalGrant> | null; }
/**
 * The reviewer's outcome letter closes the review: `mi.human_review.completed` (SM_MI_HUMAN_REVIEW_10BD's satisfier —
 * "`mi.human_review.completed` + response letter") "either upholds (restating grounds) or reverses (grant, effective as
 * of the date the borrower originally qualified, with refund of premiums collected since — 10.5)". The reversal grant
 * itself runs through 10.1 finalization (`pmi.* cancel` reads the reversal from the record) and 10.5 (R5: the denial
 * row stays, `superseded_by_grant_id` set by the grant).
 */
export function completeHumanReview(deps: DenialDeps, i: HumanReviewOutcome): HumanReviewClosed {
  const row = deps.store.get("mi_human_reviews", i.review_id);
  if (!row) throw new RangeError(`no human review ${i.review_id}`);
  if (row.data.status !== "open") throw new RangeError(`human review ${i.review_id} is ${String(row.data.status)}`);
  if (i.outcome !== "upheld" && i.outcome !== "reversed") throw new RangeError(`outcome ${String(i.outcome)} is not upheld/reversed`);
  if (!i.outcome_letter_document_id) throw new RangeError("outcome_letter_document_id is required: the review closes with the outcome letter");
  if (i.outcome === "reversed" && !i.qualified_on) throw new RangeError("a reversal names qualified_on — the date the borrower originally qualified (the grant's effective date)");
  const loanId = String(row.data.loan_id), completedOn = i.completed_on ?? D(deps.now.slice(0, 10)), due = row.data.due as PlainDate;
  if (row.data.task_id && deps.escalations) deps.escalations.complete(String(row.data.task_id), deps.actor, i.outcome_letter_document_id);
  const grant = i.outcome === "reversed" ? reversalGrant({ qualified_on: i.qualified_on!, premiums_collected: i.premiums_collected ?? [] }) : null;
  deps.events.append({ type: "mi.human_review.completed", loanId, actor: deps.actor, payload: { review_id: i.review_id, evaluation_id: row.data.evaluation_id, denial_id: row.data.denial_id, outcome: i.outcome, outcome_letter_document_id: i.outcome_letter_document_id, completed_on: completedOn, on_time: completedOn <= due, ...(grant ? { grant_effective_on: grant.effective_on, refund_cents: grant.refund_cents, refund_process: grant.refund_process } : {}) } });
  deps.store.put("mi_human_reviews", i.review_id, { status: "completed", outcome: i.outcome, outcome_letter_document_id: i.outcome_letter_document_id, completed_on: completedOn }, deps.actor, deps.now);
  if (row.data.denial_id) deps.store.put("mi_denials", String(row.data.denial_id), { human_review_outcome: i.outcome, status: i.outcome === "reversed" ? "reversed" : "upheld" }, deps.actor, deps.now);
  return { review_id: i.review_id, outcome: i.outcome, completed_on: completedOn, on_time: completedOn <= due, grant };
}

/** The 10.6 `documents.deliver` tool handler: delivers the document; with `human_review_id` the document is the reviewer's outcome letter and its delivery closes the review. */
export function documentsDeliver_10_6(i: ToolInput, ctx: CommandContext, rt: ToolRuntime): unknown {
  if (!str(i, "loan_id") || !str(i, "document_id")) throw new RangeError("loan_id and document_id are required");
  const channel = str(i, "channel") || "secure_edelivery";
  let review: HumanReviewClosed | null = null;
  if (str(i, "human_review_id")) {
    const premiums = Array.isArray(i.premiums_collected) ? (i.premiums_collected as { on: string; amount_cents: unknown }[]).map((p) => ({ on: D(p.on), amount_cents: cents(p.amount_cents) })) : [];
    review = completeHumanReview(depsOf(ctx, rt), { review_id: str(i, "human_review_id"), outcome: str(i, "outcome") as "upheld" | "reversed", outcome_letter_document_id: str(i, "document_id"), ...(str(i, "qualified_on") ? { qualified_on: D(str(i, "qualified_on")) } : {}), premiums_collected: premiums });
  }
  ctx.events.append({ type: "document.delivered", loanId: str(i, "loan_id"), actor: ctx.actor, payload: { document_id: str(i, "document_id"), channel, ...(review ? { kind: "human_review_outcome_letter", review_id: review.review_id, outcome: review.outcome } : {}) } });
  return { delivered: true, channel, ...(review ? { review } : {}) };
}

export interface DisputeRecord { readonly loan_id: string; readonly received_on: PlainDate; readonly evaluation_id: string; readonly pmi_case_id?: string | null; readonly text?: string | null; readonly asserts_error?: boolean; readonly valuation_disagreement?: boolean; readonly requests_human?: boolean; readonly valuation_id?: string | null; readonly valuation_kind?: string | null; readonly valuation_supported_termination?: boolean; readonly requester_party_id?: string | null; }
export interface DisputeRouting { readonly routes: readonly string[]; readonly noe: Record<string, unknown> | null; readonly appeal: { valuation_id: string; appeal_requested_on: PlainDate } | null; readonly human_review: HumanReviewOpened | null; }
/**
 * Inputs: "`mi.denial.disputed` (borrower response) → NoE case (Section 4.1) or valuation appeal (`mi.valuation.appeal_requested`,
 * within 60 days of evaluation); `mi.human_review.requested`." Validates the inbound record, then routes per R4.
 */
export function routeDenialDispute(deps: DenialDeps, r: DisputeRecord): DisputeRouting {
  if (!r.loan_id || !isDate(r.received_on) || !r.evaluation_id) throw new RangeError("loan_id, received_on and evaluation_id are required on the dispute");
  if (!evaluationOnRecord(deps.events.byLoan(r.loan_id), r.evaluation_id)) throw new RangeError(`no mi_evaluations row ${r.evaluation_id} on ${r.loan_id}`);
  const text = r.text ?? "";
  const flags = { asserts_error: r.asserts_error ?? /miscount|miscomput|misappl|error|wrong|incorrect/i.test(text), valuation_disagreement: r.valuation_disagreement ?? /valu(e|ation)|appraisal|bpo|worth/i.test(text), requests_human: r.requests_human ?? /human|person|someone|review by/i.test(text) };
  const routes = disputeRoute(flags);
  if (routes.length === 0) throw new RangeError("the dispute asserts no error, valuation disagreement or human-review request");
  const denial = deps.store.list("mi_denials", (d) => d.loan_id === r.loan_id && d.evaluation_id === r.evaluation_id).at(-1) ?? null;
  const pmiCase = r.pmi_case_id ?? (denial?.data.case_id as string | null | undefined) ?? denial?.id ?? null;
  if (denial) deps.store.put("mi_denials", denial.id, { status: "disputed", disputed_on: r.received_on, dispute_routes: routes }, deps.actor, deps.now);   // state machine: sent → disputed → (noe_opened | valuation_appealed | human_review)
  let noe: Record<string, unknown> | null = null, appeal: DisputeRouting["appeal"] = null, human: HumanReviewOpened | null = null;
  if (routes.includes("noe")) {
    if (!pmiCase) throw new RangeError("the NoE from a denial dispute needs the PMI case (pmi_case_id or a composed denial)");
    noe = openDenialDisputeNoe(deps, { loan_id: r.loan_id, received_on: r.received_on, pmi_case_id: pmiCase, evaluation_id: r.evaluation_id, assertion: text || "the denial was in error" });
  }
  if (routes.includes("smdu_appeal")) {
    // SMDU FAQ Q19–Q21: AVMs may not be appealed; appeals only when the valuation did not support termination.
    if (valuationKindOf(r.valuation_kind) === "avm") throw new RangeError("an AVM value may not be appealed (SMDU FAQ Q19); the borrower may pay for a BPO or appraisal");
    if (r.valuation_supported_termination === true) throw new RangeError("nothing to appeal: the valuation supported termination (SMDU FAQ Q20)");
    if (!r.valuation_id) throw new RangeError("valuation_id is required for a valuation appeal");
    deps.events.append({ type: "mi.valuation.appeal_requested", loanId: r.loan_id, actor: deps.actor, payload: { valuation_id: r.valuation_id, evaluation_id: r.evaluation_id, appeal_requested_on: r.received_on, extends_validity: false } });
    appeal = { valuation_id: r.valuation_id, appeal_requested_on: r.received_on };
  }
  if (routes.includes("human_review")) human = requestHumanReview(deps, { loan_id: r.loan_id, requested_on: r.received_on, evaluation_id: r.evaluation_id, denial_id: denial?.id ?? null, requester_party_id: r.requester_party_id ?? null, reason: text || null });
  else if (denial) deps.store.put("mi_denials", denial.id, { status: noe ? "noe_opened" : "valuation_appealed" }, deps.actor, deps.now);
  return { routes, noe, appeal, human_review: human };
}

export interface DenialHookDeps { readonly events: EventStore; readonly timers: TimerEngine; readonly store: EntityStore; readonly clock: { now(): string }; readonly escalations?: Pick<EscalationService, "open" | "complete">; readonly actor?: Actor; }
/**
 * Ingestion for 10.6: the borrower's response (`mi.denial.disputed`, from mail classification / the portal / borrower
 * comms) is validated and routed; a `notice.sent` of the denial or information request stamps the `mi_denials` row
 * (`notice_id`, `sent_at`, state `sent`). Returns the detach function.
 */
export function attachDenialHooks_10_6(deps: DenialHookDeps): () => void {
  const actor = deps.actor ?? SYSTEM;
  const offDispute = deps.events.subscribe("mi.denial.disputed", (e) => {
    if (!e.loanId) return;
    const p = e.payload;
    const record: DisputeRecord = { loan_id: e.loanId, received_on: optDate(p.received_on) ?? D(e.occurredAt.slice(0, 10)), evaluation_id: String(p.evaluation_id ?? ""), pmi_case_id: (p.pmi_case_id as string | undefined) ?? null, text: (p.text as string | undefined) ?? null,
      ...(typeof p.asserts_error === "boolean" ? { asserts_error: p.asserts_error } : {}), ...(typeof p.valuation_disagreement === "boolean" ? { valuation_disagreement: p.valuation_disagreement } : {}), ...(typeof p.requests_human === "boolean" ? { requests_human: p.requests_human } : {}),
      valuation_id: (p.valuation_id as string | undefined) ?? null, valuation_kind: (p.valuation_kind as string | undefined) ?? null, ...(typeof p.valuation_supported_termination === "boolean" ? { valuation_supported_termination: p.valuation_supported_termination } : {}), requester_party_id: (p.requester_party_id as string | undefined) ?? null };
    try {
      const r = routeDenialDispute({ events: deps.events, store: deps.store, actor, now: deps.clock.now(), timers: deps.timers, ...(deps.escalations ? { escalations: deps.escalations } : {}) }, record);
      deps.events.append({ type: "mi.denial.dispute.routed", loanId: e.loanId, actor, causationId: e.id, payload: { evaluation_id: record.evaluation_id, routes: r.routes, noe_case_id: r.noe ? String(r.noe.id) : null, human_review_id: r.human_review?.review_id ?? null, appeal_valuation_id: r.appeal?.valuation_id ?? null } });
    } catch (err) {
      deps.events.append({ type: "integration_messages.rejected", loanId: e.loanId, actor, causationId: e.id, payload: { kind: "mi_denial_dispute", evaluation_id: record.evaluation_id, message: err instanceof Error ? err.message : String(err) } });
    }
  });
  const offSent = deps.events.subscribe("notice.sent", (e) => {
    if (!e.loanId || (e.payload.template !== DENIAL && e.payload.template !== "NTC_MI_INFO_REQUEST")) return;
    const kind = e.payload.template === DENIAL ? "request_denial" : "info_request";
    const row = deps.store.list("mi_denials", (d) => d.loan_id === e.loanId && d.kind === kind && d.sent_at === null).at(-1);
    if (!row) return;
    deps.store.put("mi_denials", row.id, { notice_id: String(e.payload.notice_id), sent_at: String(e.payload.sent_at ?? e.occurredAt), status: "sent", sent_on_time: String(e.payload.sent_at ?? e.occurredAt).slice(0, 10) <= String(row.data.due_on) }, actor, deps.clock.now());
  });
  return () => { offDispute(); offSent(); };
}

