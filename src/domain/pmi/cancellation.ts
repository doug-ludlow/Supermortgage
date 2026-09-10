/**
 * 10.1 Borrower-requested cancellation — original value, LTV in basis
 * points, current test, payment-history windows, value check, thresholds
 * and the HPA-anchored decision clock.
 */
import { type PlainDate, addDays, addMonths, daysBetween, endOfMonth } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";
import { fnmaDelinquencyStatus, regxDaysDelinquent } from "../boarding/delinquency.ts";

/** R2 — original value (4901(12)); NY §6503(d) uses the appraisal alone. */
export function originalValue(i: { sales_price_cents: Cents | null; appraised_value_cents: Cents | null; is_refinance: boolean; state: string }): Cents | null {
  const { sales_price_cents: sp, appraised_value_cents: av } = i;
  if (av === null) return null;
  if (i.state === "NY" || i.is_refinance) return av;
  if (sp === null) return null;
  return sp < av ? sp : av;
}

/** R3 — LTV in basis points, floored. */
export function ltvBps(upb: Cents, value: Cents): number { return Number((upb * 10000n) / value); }
export function evaluationUpb(i: { upb_cents: Cents; deferred_principal_cents: Cents; forborne_principal_cents: Cents }): Cents {
  return i.upb_cents + i.deferred_principal_cents + i.forborne_principal_cents;
}
/** Basis points → "83.88" (truncated, 10.6 R2). */
export function bpsToPercent(bps: number): string { return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`; }

export type PropertyClass = "1u_principal_or_second" | "2_4u_principal" | "1_4u_investment";

/** Fannie Mae original-value threshold: 80% for 1-unit principal/second home; 70% otherwise. */
export function originalValueThresholdBps(pc: PropertyClass): number { return pc === "1u_principal_or_second" ? 8000 : 7000; }

/** R7 — current-value thresholds by seasoning. */
export function currentValueThresholdBps(pc: PropertyClass, seasoningMonths: number, improvementsAccepted: boolean): number | null {
  if (pc !== "1u_principal_or_second") return seasoningMonths >= 24 ? 7000 : null;
  if (improvementsAccepted) return 8000;
  if (seasoningMonths >= 60) return 8000;
  if (seasoningMonths >= 24) return 7500;
  return null;
}

export function seasoningMonths(consummation: PlainDate, on: PlainDate): number {
  let n = 0;
  while (addMonths(consummation, n + 1) <= on) n++;
  return n;
}

/** R4 — Fannie Mae current: status current as of the last day of the month preceding receipt; HPA adds regx_days = 0 on the decision date. */
export function isCurrentForRequest(installments: readonly AppliedInstallment[], receivedOn: PlainDate, decisionOn: PlainDate): { fnma: boolean; hpa: boolean } {
  const precedingEnd = endOfMonth(addMonths(receivedOn, -1));
  const fnma = fnmaDelinquencyStatus(installments, precedingEnd) === "current";
  return { fnma, hpa: fnma && regxDaysDelinquent(installments, decisionOn) === 0 };
}

export interface LateInstallment { readonly due_date: PlainDate; readonly paid_on: PlainDate | null; readonly days_late: number; readonly disaster_attributable: boolean; }

export interface HistoryResult { readonly ok: boolean; readonly reason: "PAYMENT_HISTORY_30_12M" | "PAYMENT_HISTORY_60_24M" | null; readonly offending: readonly LateInstallment[]; readonly late30_12m: number; readonly late60_24m: number; }

/** R5 — window A [D−24m, D−12m): no ≥60-day late; window B [D−12m, D): no ≥30-day late; disaster-attributable exclusions. */
export function paymentHistory(installments: readonly AppliedInstallment[], D: PlainDate, disasterExcluded: ReadonlySet<PlainDate> = new Set(), loanAgeMonths = 999): HistoryResult {
  const aStart = addMonths(D, -Math.min(24, loanAgeMonths)), bStart = addMonths(D, -Math.min(12, loanAgeMonths));
  const lates: LateInstallment[] = installments
    .filter((i) => i.due_date >= aStart && i.due_date < D)
    .map((i) => ({ due_date: i.due_date, paid_on: i.satisfied_on, days_late: i.satisfied_on === null ? daysBetween(i.due_date, D) : daysBetween(i.due_date, i.satisfied_on), disaster_attributable: disasterExcluded.has(i.due_date) }));
  const counted = lates.filter((l) => !l.disaster_attributable);
  const b = counted.filter((l) => l.due_date >= bStart && l.days_late >= 30);
  const a = counted.filter((l) => l.due_date < bStart && l.days_late >= 60);
  const late30 = counted.filter((l) => l.due_date >= bStart && l.days_late >= 30).length;
  const late60 = counted.filter((l) => l.days_late >= 60).length;
  if (b.length > 0) return { ok: false, reason: "PAYMENT_HISTORY_30_12M", offending: b, late30_12m: late30, late60_24m: late60 };
  if (a.length > 0) return { ok: false, reason: "PAYMENT_HISTORY_60_24M", offending: a, late30_12m: late30, late60_24m: late60 };
  return { ok: true, reason: null, offending: [], late30_12m: late30, late60_24m: late60 };
}

export type ValueCheck = { readonly status: "value_not_declined" } | { readonly status: "value_check_needed"; readonly options: readonly { type: string; fee_cents: Cents }[] };

/** R6 — AVM ≥ original value, else borrower-paid evidence options; delivered value valid 120 days. */
export function valueCheck(avm: Cents | null, originalValueCents: Cents, units: number): ValueCheck {
  if (avm !== null && avm >= originalValueCents) return { status: "value_not_declined" };
  return { status: "value_check_needed", options: [{ type: "bpo", fee_cents: 19_000n }, { type: "restricted_appraisal", fee_cents: 45_000n }, ...(units > 1 ? [{ type: "appraisal_2_4_unit", fee_cents: 75_000n }] : [])] };
}
export function valuationValidUntil(deliveredOn: PlainDate): PlainDate { return addDays(deliveredOn, 120); }

export interface CancellationRequest {
  readonly received_on: PlainDate;
  readonly decision_on: PlainDate;
  readonly evidence_satisfied_on: PlainDate | null;
  readonly path: "original_value" | "current_value";
  readonly property_class: PropertyClass;
  readonly hpa_covered: boolean;
  readonly original_value_cents: Cents;
  readonly valuation_cents: Cents | null;         // current-value path or evidence
  readonly valuation_delivered_on: PlainDate | null;
  readonly evaluation_upb_cents: Cents;
  readonly threshold_reached_on: PlainDate | null; // date actual UPB first ≤ threshold (curtailment posting date etc.)
  readonly installments: readonly AppliedInstallment[];
  readonly avm_cents: Cents | null;
  readonly consummation: PlainDate;
  readonly improvements_accepted?: boolean;
  readonly disaster_excluded?: ReadonlySet<PlainDate>;
}

export interface CancellationDecision {
  readonly result: "eligible" | "ineligible" | "value_check_needed";
  readonly reasons: readonly string[];
  readonly ltv_bps: number;
  readonly threshold_bps: number | null;
  readonly effective_on: PlainDate | null;
  readonly lar89_action_code: "51" | "52" | null;
  readonly decision_due: PlainDate;
  readonly history: HistoryResult;
}

/** R9 — 30-day clock from receipt, re-anchored only by borrower-supplied evidence/fee. */
export function decisionDue(receivedOn: PlainDate, evidenceSatisfiedOn: PlainDate | null): PlainDate {
  const anchor = evidenceSatisfiedOn !== null && evidenceSatisfiedOn > receivedOn ? evidenceSatisfiedOn : receivedOn;
  return addDays(anchor, 30);
}

export function evaluateCancellation(r: CancellationRequest): CancellationDecision {
  const reasons: string[] = [];
  const due = decisionDue(r.received_on, r.evidence_satisfied_on);
  const D = r.threshold_reached_on !== null && r.threshold_reached_on > r.received_on ? r.threshold_reached_on : r.received_on;
  const history = paymentHistory(r.installments, D, r.disaster_excluded ?? new Set(), seasoningMonths(r.consummation, r.received_on));
  const cur = isCurrentForRequest(r.installments, r.received_on, r.decision_on);
  let threshold: number | null, ltv: number, value: Cents;
  if (r.path === "original_value") {
    threshold = originalValueThresholdBps(r.property_class); value = r.original_value_cents;
  } else {
    threshold = currentValueThresholdBps(r.property_class, seasoningMonths(r.consummation, r.received_on), r.improvements_accepted === true);
    if (r.valuation_cents === null) return { result: "value_check_needed", reasons: ["VALUATION_REQUIRED"], ltv_bps: 0, threshold_bps: threshold, effective_on: null, lar89_action_code: null, decision_due: due, history };
    value = r.valuation_cents;
  }
  ltv = ltvBps(r.evaluation_upb_cents, value);
  if (threshold === null) reasons.push("SEASONING_INSUFFICIENT");
  else if (ltv > threshold) reasons.push(r.path === "original_value" ? "LTV_ABOVE_THRESHOLD" : "LTV_ABOVE_THRESHOLD_CURRENT");
  if (!cur.fnma) reasons.push("NOT_CURRENT");
  if (!history.ok) reasons.push(history.reason!);
  if (reasons.length > 0) return { result: "ineligible", reasons, ltv_bps: ltv, threshold_bps: threshold, effective_on: null, lar89_action_code: null, decision_due: due, history };
  if (r.path === "original_value") {
    const vc = valueCheck(r.valuation_cents ?? r.avm_cents, r.original_value_cents, r.property_class === "2_4u_principal" ? 2 : 1);
    if (vc.status === "value_check_needed") return { result: "value_check_needed", reasons: ["VALUE_DECLINED_OR_UNKNOWN"], ltv_bps: ltv, threshold_bps: threshold, effective_on: null, lar89_action_code: null, decision_due: due, history };
    const candidates = [r.received_on, r.threshold_reached_on, r.evidence_satisfied_on].filter((x): x is PlainDate => x !== null);
    return { result: "eligible", reasons: [], ltv_bps: ltv, threshold_bps: threshold, effective_on: candidates.reduce((a, b) => (b > a ? b : a)), lar89_action_code: "51", decision_due: due, history };
  }
  const eff = r.valuation_delivered_on !== null && r.valuation_delivered_on > r.received_on ? r.valuation_delivered_on : r.received_on;
  return { result: "eligible", reasons: [], ltv_bps: ltv, threshold_bps: threshold, effective_on: eff, lar89_action_code: "52", decision_due: due, history };
}

/** 10.1-T10 — original value may only be set with an evidence document. */
export function setOriginalValueAllowed(evidenceDocumentId: string | null): boolean { return evidenceDocumentId !== null && evidenceDocumentId.length > 0; }

/** 10.1-T11 — a servicer override of SMDU history fields forfeits liability relief. */
export function smduLiabilityRelief(overrides: readonly string[]): boolean { return overrides.length === 0; }
