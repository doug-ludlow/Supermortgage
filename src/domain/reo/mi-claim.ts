/** 15.3 MI claim filing — routing, deadlines, shadow claim, curtailment monitor. */
import { type PlainDate, addDays, addMonths, daysBetween } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import { type Cents, monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export function filer(i: { micp_participant: boolean; micp_effective: PlainDate | null; liquidation_date: PlainDate }): "fnma_micp" | "servicer_direct" {
  return i.micp_participant && i.micp_effective !== null && i.liquidation_date >= i.micp_effective ? "fnma_micp" : "servicer_direct";
}

export interface MiClaimClocks { readonly claim_filing_deadline: PlainDate; readonly micp_docs_due: PlainDate; readonly internal_target: PlainDate; readonly direct_file_due: PlainDate; }

/** Rule 2 — master-policy deadline from the liquidation anchor; docs 10 fannie_et BD earlier; direct filing = expense anchor + 30. */
export function miClaimClocks(liquidationAnchor: PlainDate, expenseAnchor: PlainDate, filingDays = 60, cal: Calendar = fannieEt): MiClaimClocks {
  const deadline = addDays(liquidationAnchor, filingDays);
  return { claim_filing_deadline: deadline, micp_docs_due: addBusinessDays(deadline, -10, cal), internal_target: addDays(liquidationAnchor, 15), direct_file_due: addDays(expenseAnchor, 30) };
}

export interface ShadowInput {
  readonly upb_cents: Cents; readonly note_rate_pct: string; readonly interest_paid_to: PlainDate; readonly anchor: PlainDate; readonly default_date: PlainDate;
  readonly taxes_cents: Cents; readonly hazard_cents: Cents; readonly hazard_refund_cents: Cents; readonly hoa_cents: Cents; readonly preservation_inspection_cents: Cents; readonly attorney_fees_costs_cents: Cents;
  readonly credits_cents: Cents; readonly coverage_pct: string; readonly net_proceeds_cents?: Cents | null;
}
export interface ShadowClaim { readonly interest_months: number; readonly interest_cents: Cents; readonly capped: boolean; readonly attorney_cap_cents: Cents; readonly claimable_advances_cents: Cents; readonly claim_amount_cents: Cents; readonly percentage_benefit_cents: Cents; readonly benefit_cents: Cents; }

/** Rule 4 — per-month rounded interest + stub ÷ 365, 36-month cap; attorney cap 3% (UPB ≥ $200k) else min($6,000, 5%). */
export function shadowClaim(i: ShadowInput): ShadowClaim {
  let months = 0, cursor = i.interest_paid_to;
  while (addMonths(cursor, 1) <= i.anchor) { cursor = addMonths(cursor, 1); months++; }
  const capMonths = 36;
  const capped = months > capMonths;
  const usedMonths = Math.min(months, capMonths);
  const stubDays = capped ? 0 : daysBetween(cursor, i.anchor);
  const rate = ratePercent(i.note_rate_pct);
  const monthly = monthlyInterest(i.upb_cents, rate);
  const daily = Decimal.fromBigInt(i.upb_cents).mul(rate).div(Decimal.fromInt(365)).toScaledInt(4, "HALF_UP");   // 4 dp per rule 4
  const stub = Decimal.fromUnscaled(daily * Decimal.ONE.unscaled / 10000n).mul(Decimal.fromInt(stubDays)).toScaledInt(0, "HALF_UP");
  const interest = monthly * BigInt(usedMonths) + stub;
  const attorneyCap = i.upb_cents >= 20_000_000n
    ? Decimal.fromBigInt(i.upb_cents).mul(Decimal.parse("0.03")).toScaledInt(0, "HALF_UP")
    : (() => { const five = Decimal.fromBigInt(i.upb_cents).mul(Decimal.parse("0.05")).toScaledInt(0, "HALF_UP"); return five < 600_000n ? five : 600_000n; })();
  const attorney = i.attorney_fees_costs_cents < attorneyCap ? i.attorney_fees_costs_cents : attorneyCap;
  const advances = i.taxes_cents + (i.hazard_cents - i.hazard_refund_cents) + i.hoa_cents + i.preservation_inspection_cents + attorney;
  const claim = i.upb_cents + interest + advances - i.credits_cents;
  const pctBenefit = Decimal.fromBigInt(claim).mul(Decimal.parse(i.coverage_pct).div(Decimal.fromInt(100))).toScaledInt(0, "HALF_UP");
  let benefit = pctBenefit;
  if (i.net_proceeds_cents !== undefined && i.net_proceeds_cents !== null) { const loss = claim - i.net_proceeds_cents; benefit = loss < pctBenefit ? (loss < 0n ? 0n : loss) : pctBenefit; }
  return { interest_months: usedMonths, interest_cents: interest, capped, attorney_cap_cents: attorneyCap, claimable_advances_cents: advances, claim_amount_cents: claim, percentage_benefit_cents: pctBenefit, benefit_cents: benefit };
}

/** Rule 5 — NOD due by the 25th of the month after the second missed payment; late days exclude that interest. */
export function nodExcludedInterest(upb: Cents, noteRatePct: string, nodDue: PlainDate, reportedOn: PlainDate): { days: number; cents: Cents; attribution: "servicer_caused" | null } {
  const days = Math.max(0, daysBetween(nodDue, reportedOn));
  const daily = Decimal.fromBigInt(upb).mul(ratePercent(noteRatePct)).div(Decimal.fromInt(365));
  return { days, cents: daily.mul(Decimal.fromInt(days)).toScaledInt(0, "HALF_UP"), attribution: days > 0 ? "servicer_caused" : null };
}

export interface CurtailmentRiskInput { readonly nod_late_days: number; readonly fcl_days_used: number; readonly fcl_days_allowable: number; readonly allowable_delays: number; readonly interest_months: number; readonly property_condition_flags: number; readonly premium_gap: boolean; readonly docs_ready: boolean; }
export function curtailmentRisk(i: CurtailmentRiskInput): { projected_excess_days: number; score: number; diligence_task: boolean } {
  const excess = Math.max(0, i.fcl_days_used - (i.fcl_days_allowable + i.allowable_delays));
  let score = 0;
  if (i.nod_late_days > 0) score += 0.3;
  if (excess > 0) score += Math.min(0.6, 0.4 + excess / 50);
  if (i.interest_months >= 30) score += 0.3;
  score += Math.min(0.2, i.property_condition_flags * 0.1);
  if (i.premium_gap) score += 0.2;
  if (!i.docs_ready) score += 0.1;
  score = Math.min(1, Math.round(score * 100) / 100);
  return { projected_excess_days: excess, score, diligence_task: score >= 0.6 };
}

/** 15.3-T6 — document request due = earlier of the request's Due Date and 5 BD. */
export function docRequestDue(requestedOn: PlainDate, dueDate: PlainDate | null, cal: Calendar = fannieEt): PlainDate {
  const five = addBusinessDays(requestedOn, 5, cal);
  return dueDate !== null && dueDate < five ? dueDate : five;
}
export function eobVariance(shadow: Cents, eob: Cents): { variance_cents: Cents; analyze: boolean } {
  const v = shadow - eob; const abs = v < 0n ? -v : v;
  return { variance_cents: v, analyze: abs > 25_000n || abs * 1000n > shadow * 5n };
}
export function proceedsRemitDue(receivedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(receivedOn, 2, cal); }
export function supplementalUploadDue(windowEnd: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(windowEnd, -10, cal); }
export function unpaidEscalationOn(perfectedOn: PlainDate): PlainDate { return addDays(perfectedOn, 60); }
export function interestCapBriefing(interestMonths: number): boolean { return interestMonths >= 30; }
export function insurerMismatchCorrectionDue(foundOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(foundOn, 1, cal); }
