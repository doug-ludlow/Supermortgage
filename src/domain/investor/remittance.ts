/**
 * §5.2 Remittance of P&I — calculators by remittance type, payoff interest,
 * draft calendar, CRS thresholds, variance classification, compensatory fees.
 * All rate math via Decimal; money rounded half-up at each named line item.
 */
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { ratePercent, monthlyInterest } from "../../kernel/money/cents.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, daysBetween, addMonths, parts, ymd } from "../../kernel/calendar/date.ts";
import { nextBusinessDay, federal, fannieEt, addBusinessDays } from "../../kernel/calendar/business.ts";
import type { RemittanceType } from "./types.ts";

const pct = (p: string) => ratePercent(p);
const partOf = (c: Cents, participationPct: string) => participationPct === "100" ? c : divRound(c * Decimal.parse(participationPct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP");

/** Interest for one month on `upb` at `rate`% (round half-up). */
export const monthInterest = (upb: Cents, rate: string): Cents => monthlyInterest(upb, pct(rate));

export interface ScheduledMonth { readonly prior_scheduled_upb_cents: Cents; readonly gross_interest_cents: Cents; readonly scheduled_principal_cents: Cents; readonly ending_scheduled_upb_cents: Cents; readonly fnma_interest_cents: Cents; readonly fnma_principal_cents: Cents; readonly servicing_fee_cents: Cents; }

/** S/S: interest at PTR on prior scheduled UPB; scheduled principal = P&I − note interest; both × participation. */
export function scheduledMonth(priorScheduledUpb: Cents, noteRate: string, ptr: string, piCents: Cents, participation = "100"): ScheduledMonth {
  const gross = monthInterest(priorScheduledUpb, noteRate);
  const principal = piCents - gross;
  const fnmaInterest = monthInterest(priorScheduledUpb, ptr);
  return { prior_scheduled_upb_cents: priorScheduledUpb, gross_interest_cents: gross, scheduled_principal_cents: principal, ending_scheduled_upb_cents: priorScheduledUpb - principal, fnma_interest_cents: partOf(fnmaInterest, participation), fnma_principal_cents: partOf(principal, participation), servicing_fee_cents: gross - fnmaInterest };
}

/** Roll an S/S schedule forward n months (5.2 worked example: 1,476.00 / 1,476.10 / 1,476.19 / 1,476.29). */
export function scheduleForward(startScheduledUpb: Cents, noteRate: string, ptr: string, piCents: Cents, months: number): ScheduledMonth[] {
  const out: ScheduledMonth[] = []; let upb = startScheduledUpb;
  for (let i = 0; i < months; i++) { const m = scheduledMonth(upb, noteRate, ptr, piCents); out.push(m); upb = m.ending_scheduled_upb_cents; }
  return out;
}

/** S/A: interest advanced months 1–3; month 4 reports −3 months (recovery). */
export function saInterest(priorActualUpb: Cents, ptr: string, monthsDelinquent: number, participation = "100"): Cents {
  const one = partOf(monthInterest(priorActualUpb, ptr), participation);
  if (monthsDelinquent <= 3) return one;
  if (monthsDelinquent === 4) return -3n * one;
  return 0n;
}

/** A/A: Fannie Mae interest at PTR on prior actual UPB only when a contractual payment posts; servicing fee = note interest − PTR interest. */
export function aaRemittance(priorActualUpb: Cents, noteRate: string, ptr: string, principalCollected: Cents, participation = "100"): { fnma_interest_cents: Cents; servicing_fee_cents: Cents; principal_cents: Cents; remittance_cents: Cents; note_interest_cents: Cents } {
  const noteInt = monthInterest(priorActualUpb, noteRate), ptrInt = partOf(monthInterest(priorActualUpb, ptr), participation);
  return { note_interest_cents: noteInt, fnma_interest_cents: ptrInt, servicing_fee_cents: noteInt - ptrInt, principal_cents: partOf(principalCollected, participation), remittance_cents: ptrInt + partOf(principalCollected, participation) };
}

/** 5.2 rule 6 payoff interest: A/A full months ÷12 + days ÷365 at PTR; S/A half month; S/S full month. */
export function payoffInterest(type: RemittanceType, upb: Cents, ptr: string, lpi: PlainDate, payoffDate: PlainDate): Cents {
  const month = monthInterest(upb, ptr);
  if (type === "SA") return divRound(month, 2n, "HALF_UP");
  if (type === "SS") return month;
  // A/A: whole months from LPI, then days
  let months = 0; let cursor = lpi;
  while (addMonths(cursor, 1) <= payoffDate) { cursor = addMonths(cursor, 1); months++; }
  const days = daysBetween(cursor, payoffDate);
  const daily = upb * pct(ptr).unscaled * BigInt(days);
  return BigInt(months) * month + divRound(daily, 365n * Decimal.ONE.unscaled, "HALF_UP");
}

export const CRS_AA_THRESHOLD_CENTS = 250_000n;
/** A/A: CRS code 001 the day net collections exceed $2,500; settlement the next Federal Reserve business day. */
export function crsAaRequest(netCollectedCents: Cents, today: PlainDate, lastWorkDayOfMonth: boolean): { instruct: boolean; settlement_date: PlainDate | null; code: "001" } {
  const instruct = netCollectedCents > CRS_AA_THRESHOLD_CENTS || (lastWorkDayOfMonth && netCollectedCents > 0n);
  return { instruct, settlement_date: instruct ? nextBusinessDay(today, federal) : null, code: "001" };
}

/** Special remittances after liquidation: instructed within two Fannie BDs of receipt (5.2-T11), 16:00 ET. */
export function specialRemittanceDeadline(receivedOn: PlainDate): PlainDate { return addBusinessDays(receivedOn, 2, fannieEt); }

export type VarianceClass = "sda_credit" | "sda_recovery" | "reclass_reimbursement_208" | "ptr_mismatch" | "lpi_mismatch" | "fnma_projection" | "unexplained";
export function classifyVariance(expected: Cents, notified: Cents, hints: { sda_active?: boolean; sda_credit_cents?: Cents; recovery?: boolean; code?: string }): { class: VarianceClass; variance_cents: Cents; draft_expectation_cents: Cents } {
  const v = notified - expected;
  if (hints.sda_credit_cents !== undefined && expected + hints.sda_credit_cents === notified) return { class: "sda_credit", variance_cents: v, draft_expectation_cents: notified };
  if (hints.recovery) return { class: "sda_recovery", variance_cents: v, draft_expectation_cents: notified };
  if (hints.code === "208") return { class: "reclass_reimbursement_208", variance_cents: v, draft_expectation_cents: notified };
  return { class: v === 0n ? "fnma_projection" : "unexplained", variance_cents: v, draft_expectation_cents: expected };
}

/** 5.2 rule 11: compensatory fee = max(ladder minimum, amount × days × (prime + 3%) ÷ 365). */
export function compensatoryFee(amountCents: Cents, daysLate: number, primePct: string, minimumCents: Cents = 25_000n): Cents {
  const rate = pct(primePct).add(Decimal.parse("0.03"));
  const fee = divRound(amountCents * rate.unscaled * BigInt(daysLate), 365n * Decimal.ONE.unscaled, "HALF_UP");
  return fee > minimumCents ? fee : minimumCents;
}

/** 5.5 g-fee check figure: round_half_up(prior scheduled UPB × gfee ÷ 12). */
export function gfeeCheckFigure(priorScheduledUpb: Cents, gfeePct: string): Cents { return monthInterest(priorScheduledUpb, gfeePct); }

/** Funding shortfall → corporate-to-custodial advance (dual control ≥ $250,000). */
export function fundingDecision(expectedDraft: Cents, custodialAvailable: Cents): { shortfall_cents: Cents; advance: boolean; dual_control: boolean } {
  const s = expectedDraft - custodialAvailable;
  return { shortfall_cents: s > 0n ? s : 0n, advance: s > 0n, dual_control: s >= 25_000_000n };
}

export function periodMonth(d: PlainDate): PlainDate { const { y, m } = parts(d); return ymd(y, m, 1); }
