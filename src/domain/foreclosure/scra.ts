/** §13.8 SCRA foreclosure protection and §13.9 6% interest cap. */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { levelPayment, monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { type PlainDate, addYears, addDays, addMonths, parts, ymd, daysBetween } from "../../kernel/calendar/date.ts";

/** §3953(c): protection through one calendar year after service ends, inclusive; addYears clamps Feb 29 → Feb 28. */
export function protectionEndsOn(serviceEndOn: PlainDate): PlainDate { return addYears(serviceEndOn, 1); }
export function fcGateClosed(today: PlainDate, serviceEndOn: PlainDate | null, activeDuty: boolean): boolean { if (activeDuty) return true; if (!serviceEndOn) return false; return today <= protectionEndsOn(serviceEndOn); }
export function dmdcFresh(certificateOn: PlainDate, today: PlainDate): boolean { return daysBetween(certificateOn, today) <= 30; }
export function preServiceObligation(originationOn: PlainDate, serviceBeginOn: PlainDate): boolean { return originationOn < serviceBeginOn; }
/** Cap applies from the first payment due after entry (the whole installment). */
export function capEffectivePaymentDue(serviceBeginOn: PlainDate): PlainDate { const { y, m } = parts(serviceBeginOn); const first = ymd(y, m, 1); return first > serviceBeginOn ? first : addMonths(first, 1); }
export function cappedRate(contractRatePct: string): string { return Decimal.parse(contractRatePct).cmp(Decimal.parse("6")) > 0 ? "6.000" : contractRatePct; }
export interface RecalcRow { readonly n: number; readonly due: PlainDate; readonly upb_before_cents: Cents; readonly interest_note_cents: Cents; readonly interest_capped_cents: Cents; readonly forgiven_cents: Cents; readonly principal_cents: Cents; }
/** Interest-subsidy method: principal per the original schedule; interest at min(6%, note). */
export function recalculate(o: { upb_cents: Cents; note_rate_pct: string; pi_cents: Cents; first_capped_due: PlainDate; first_n: number; paid_at_note_rate_count: number; remaining_term_after: number }): { rows: RecalcRow[]; forgiven_total_cents: Cents; upb_after_cents: Cents; next_payment_subsidy_cents: Cents; next_payment_standard_cents: Cents; next_interest_note_cents: Cents; next_interest_capped_cents: Cents; fnma_differential_cents: Cents } {
  const note = ratePercent(o.note_rate_pct), cap = ratePercent(cappedRate(o.note_rate_pct));
  const rows: RecalcRow[] = []; let upb = o.upb_cents; let forgiven = 0n;
  for (let k = 0; k < o.paid_at_note_rate_count; k++) {
    const iNote = monthlyInterest(upb, note), iCap = monthlyInterest(upb, cap); const principal = o.pi_cents - iNote;
    rows.push({ n: o.first_n + k, due: addMonths(o.first_capped_due, k), upb_before_cents: upb, interest_note_cents: iNote, interest_capped_cents: iCap, forgiven_cents: iNote - iCap, principal_cents: principal });
    forgiven += iNote - iCap; upb -= principal;
  }
  const nextNote = monthlyInterest(upb, note), nextCap = monthlyInterest(upb, cap); const schedPrincipal = o.pi_cents - nextNote;
  return { rows, forgiven_total_cents: forgiven, upb_after_cents: upb, next_payment_subsidy_cents: schedPrincipal + nextCap, next_payment_standard_cents: levelPayment(upb, cap, o.remaining_term_after), next_interest_note_cents: nextNote, next_interest_capped_cents: nextCap, fnma_differential_cents: nextNote - nextCap };
}
export function servicingFee(upb: Cents, feePct: string): Cents { return monthlyInterest(upb, ratePercent(feePct)); }
export function armCappedRate(currentArmRatePct: string): string { return cappedRate(currentArmRatePct); }
export function capEndsOn(serviceEndOn: PlainDate): PlainDate { return addYears(serviceEndOn, 1); }
export function restorationInstallment(capEnds: PlainDate): PlainDate { const { y, m } = parts(capEnds); return addMonths(ymd(y, m, 1), 1); }
export function endDateLetterDue(capEnds: PlainDate): PlainDate { return addDays(capEnds, -60); }
export function form1022Due(reductionMonth: PlainDate, mbs: boolean): { channel: "email_bd9" | "upload_cd15"; note: string } { void reductionMonth; return mbs ? { channel: "upload_cd15", note: "MBS: upload by CD15 of the following month" } : { channel: "email_bd9", note: "portfolio: email by BD9 of the following month" }; }
export function requestWithinStatute(releaseOn: PlainDate, requestOn: PlainDate): { statutory: boolean; honored: boolean } { return { statutory: daysBetween(releaseOn, requestOn) <= 180, honored: true }; }
void divRound;
