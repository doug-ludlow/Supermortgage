/** 10.5 Unearned premium refund — estimates, timing, dispute policy. */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export type RefundPlan = { kind: "monthly"; premium_cents: Cents; coverage_month_start: PlainDate } | { kind: "annual"; premium_cents: Cents; anniversary_start: PlainDate } | { kind: "single"; premium_cents: Cents; refund_pct: string };

/** R2 — monthly: premium × (30 − days)/30; annual: premium × (365 − days)/365; single: premium × pct. */
export function unearnedEstimate(p: RefundPlan, E: PlainDate): Cents {
  const prem = Decimal.fromBigInt(p.premium_cents);
  if (p.kind === "monthly") { const days = Math.max(0, Math.min(30, daysBetween(p.coverage_month_start, E))); return prem.mul(Decimal.fromInt(30 - days)).div(Decimal.fromInt(30)).toScaledInt(0, "HALF_UP"); }
  if (p.kind === "annual") { const days = Math.max(0, Math.min(365, daysBetween(p.anniversary_start, E))); return prem.mul(Decimal.fromInt(365 - days)).div(Decimal.fromInt(365)).toScaledInt(0, "HALF_UP"); }
  return prem.mul(Decimal.parse(p.refund_pct)).toScaledInt(0, "HALF_UP");
}

export interface RefundClocks { readonly insurer_notice_due: PlainDate; readonly insurer_transfer_due: PlainDate; readonly advance_if_unfunded_by: PlainDate; readonly borrower_refund_due: PlainDate; }

/** R4 — insurer notified ≤ 2 BD; transfer expected within 30 days of notice; advance at E + 40; pay by E + 45. */
export function refundClocks(E: PlainDate, insurerNotifiedOn: PlainDate | null, cal: Calendar = servicer): RefundClocks {
  const notice = insurerNotifiedOn ?? addBusinessDays(E, 2, cal);
  return { insurer_notice_due: addBusinessDays(E, 2, cal), insurer_transfer_due: addDays(notice, 30), advance_if_unfunded_by: addDays(E, 40), borrower_refund_due: addDays(E, 45) };
}

export const VARIANCE_TOLERANCE: Cents = 100n;

/** R2 — pay the insurer's amount on time; > $1.00 variance → dispute; pay the higher if unresolved by day 40. */
export function reconcileInsurerRefund(estimate: Cents, insurer: Cents, unresolvedAtDay40: boolean): { status: "matched" | "disputed"; pay_borrower_cents: Cents; variance_cents: Cents } {
  const v = insurer - estimate;
  const abs = v < 0n ? -v : v;
  if (abs <= VARIANCE_TOLERANCE) return { status: "matched", pay_borrower_cents: insurer, variance_cents: v };
  return { status: "disputed", pay_borrower_cents: unresolvedAtDay40 ? (estimate > insurer ? estimate : insurer) : insurer, variance_cents: v };
}

/** R1 — refund legs by plan. */
export function refundLegs(plan: "bpmi_monthly" | "bpmi_annual" | "bpmi_single_financed" | "lpmi"): readonly ("insurer_unearned" | "escrow_mi_line" | "corporate_income")[] {
  if (plan === "lpmi") return ["corporate_income"];
  if (plan === "bpmi_single_financed") return ["insurer_unearned"];
  return ["insurer_unearned", "escrow_mi_line"];
}

/** R3 — never offset the refund without a signed election after E (10.5-T7). */
export function refundApplicationAllowed(target: "borrower" | "late_charges" | "principal" | "escrow", electionSignedOn: PlainDate | null, E: PlainDate): boolean {
  return target === "borrower" || (electionSignedOn !== null && electionSignedOn > E);
}

/** Insurer look-back shortfall (worked example): days before the look-back window are a corporate expense. */
export function lookbackShortfall(E: PlainDate, insurerReceivedOn: PlainDate, lookbackDays: number, dailyPremium: Decimal): Cents {
  const windowStart = addDays(insurerReceivedOn, -lookbackDays);
  const days = Math.max(0, daysBetween(E, windowStart));
  return dailyPremium.mul(Decimal.fromInt(days)).toScaledInt(0, "HALF_UP");
}

/** 10.5-T8 — a returned ACH (R03) → check within 5 BD; the 45-day timer is satisfied on the mailing date. */
export function returnedAchCheckDue(returnedOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(returnedOn, 5, cal); }
