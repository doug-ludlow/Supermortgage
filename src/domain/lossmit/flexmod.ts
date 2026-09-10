/** §12.8 Fannie Mae Flex Modification — the F-1-27 waterfall (rule set fnma.flexmod.2025-08), trial mechanics, conversion dates. */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { levelPayment, monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { type PlainDate, addMonths, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";

export interface WaterfallInputs { readonly ib_upb_cents: Cents; readonly accrued_interest_cents: Cents; readonly escrow_advances_cents: Cents; readonly servicing_advances_cents: Cents; readonly prior_nib_cents: Cents; readonly buydown_funds_cents?: Cents; readonly value_cents: Cents; readonly contract_rate_pct: string; readonly is_arm_not_final: boolean; readonly remaining_term_months: number; readonly pre_mod_pi_cents: Cents; readonly mir_pct: string; readonly delinquent_31_plus: boolean; }
export interface WaterfallResult { readonly gross_upb_cents: Cents; readonly mtmltv: string; readonly rate_pct: string; readonly term_months: number; readonly ib_upb_cents: Cents; readonly forborne_cents: Cents; readonly pi_cents: Cents; readonly target_pi_cents: Cents; readonly reduction_pct: string; readonly eligible: boolean; readonly reason?: string; readonly trace: string[]; readonly post_mod_ib_mtmltv: string; readonly forbearance_caps?: { a: Cents; b: Cents; c: Cents }; }

const pct = (n: Cents, d: Cents) => Decimal.ratio(n * 100n, d).toFixed(2);
export function targetPi(preModPi: Cents): Cents { const eighty = preModPi * 80n; const q = eighty / 100n; return eighty % 100n === 0n ? q - 1n : q; }   // largest cent strictly below 80%
/** IB UPB that yields P&I = target at rate/term: UPB = P(1 − (1+r)^−n)/r, floored to cents and verified. */
function solveUpb(target: Cents, ratePct: string, n: number): Cents {
  const r = ratePercent(ratePct).div(Decimal.fromInt(12));
  const growth = Decimal.ONE.add(r).pow(n);
  const upb = Decimal.ratio(target, 100n).mul(growth.sub(Decimal.ONE)).div(r.mul(growth));
  let c = upb.toCents("FLOOR");                       // solve, round down to cents, verify P&I ≤ target, adjust by cents (F-1-27)
  while (levelPayment(c, ratePercent(ratePct), n) > target) c -= 1n;
  return c;
}
export function waterfall(i: WaterfallInputs): WaterfallResult {
  const trace: string[] = [];
  const gross = i.ib_upb_cents + i.accrued_interest_cents + i.escrow_advances_cents + i.servicing_advances_cents + i.prior_nib_cents - (i.buydown_funds_cents ?? 0n);
  const mtmltv = pct(gross, i.value_cents); trace.push(`step1 gross=${gross} mtmltv=${mtmltv}%`);
  const target = targetPi(i.pre_mod_pi_cents);
  const mir = Decimal.parse(i.mir_pct); const contract = Decimal.parse(i.contract_rate_pct);
  let rate = i.is_arm_not_final ? (contract.cmp(mir) > 0 ? contract : mir) : contract; trace.push(`step2 rate=${rate.toFixed(3)}`);
  let term = i.remaining_term_months;
  const piAt = (upb: Cents, r: Decimal, n: number) => levelPayment(upb, r.div(Decimal.fromInt(100)), n);
  let pi = piAt(gross, rate, term);
  if (Decimal.parse(mtmltv).cmp(Decimal.parse("50")) >= 0 && rate.cmp(mir) > 0) {
    while (pi > target && rate.sub(Decimal.parse("0.125")).cmp(mir) >= 0) { rate = rate.sub(Decimal.parse("0.125")); pi = piAt(gross, rate, term); trace.push(`step3 rate→${rate.toFixed(3)} pi=${pi}`); }
    // F-1-27 step 3: a partial increment lands exactly on the MIR floor (never on the target).
    if (pi > target && rate.cmp(mir) > 0) { rate = mir; pi = piAt(gross, rate, term); trace.push(`step3 partial→floor ${rate.toFixed(3)} pi=${pi}`); }
  } else trace.push("step3 skipped (mtmltv<50 or rate≤MIR)");
  // F-1-27 step 4: extend one month at a time up to 480 from the effective date; stop at the first term where P&I ≤ target.
  if (pi > target && term < 480) { while (pi > target && term < 480) { term += 1; pi = piAt(gross, rate, term); } trace.push(`step4 term→${term} pi=${pi}`); }
  let ib = gross, forborne = 0n; let caps: WaterfallResult["forbearance_caps"];
  if (pi > target && Decimal.parse(mtmltv).cmp(Decimal.parse("50")) > 0) {
    const a = gross - solveUpb(target, rate.toFixed(3), term); const b = gross - i.value_cents / 2n; const c = divRound(gross * 30n, 100n, "HALF_UP");
    caps = { a, b, c }; forborne = [a, b, c].reduce((x, y) => (y < x ? y : x)); if (forborne < 0n) forborne = 0n; ib = gross - forborne; pi = piAt(ib, rate, term);
    trace.push(`step5 a=${a} b=${b} c=${c} forborne=${forborne} ib=${ib} pi=${pi}`);
  }
  const eligible = pi <= target || (i.delinquent_31_plus ? pi <= i.pre_mod_pi_cents : pi < i.pre_mod_pi_cents);
  const reduction = Decimal.ratio((i.pre_mod_pi_cents - pi) * 100n, i.pre_mod_pi_cents).toFixed(4);
  return { gross_upb_cents: gross, mtmltv, rate_pct: rate.toFixed(3), term_months: term, ib_upb_cents: ib, forborne_cents: forborne, pi_cents: pi, target_pi_cents: target, reduction_pct: reduction, eligible, ...(eligible ? {} : { reason: "INV_FNMA_F127_PI_RULE" }), trace, post_mod_ib_mtmltv: pct(ib, i.value_cents), ...(caps ? { forbearance_caps: caps } : {}) };
}
/** IB UPB after n level payments (for the worked example: 51 payments of $250,000 @ 6.5% → $236,765.47). */
export function balanceAfter(original: Cents, ratePct: string, term: number, paymentsMade: number): Cents { const p = levelPayment(original, ratePercent(ratePct), term); let upb = original; for (let k = 0; k < paymentsMade; k++) { const i = monthlyInterest(upb, ratePercent(ratePct)); upb -= p - i; } return upb; }
export function accruedInterest(upb: Cents, ratePct: string, months: number): Cents { return BigInt(months) * monthlyInterest(upb, ratePercent(ratePct)); }
export function trialCount(delinquent31Plus: boolean): 3 | 4 { return delinquent31Plus ? 3 : 4; }
export function trialSchedule(noticeSentOn: PlainDate, count: 3 | 4, tiMonthly: Cents, shortageMonthly: Cents, pi: Cents, processingMonth = false): { due_dates: PlainDate[]; trial_payment_cents: Cents; capitalization_date: PlainDate; effective: PlainDate; form_3179_by: PlainDate; incentive_deadline: PlainDate } {
  const { y, m, d } = parts(noticeSentOn); const first = addMonths(ymd(y, m, 1), d <= 15 ? 1 : 2);
  const dues = Array.from({ length: count }, (_, k) => addMonths(first, k)); const last = dues[count - 1]!;
  const eff = addMonths(last, processingMonth ? 2 : 1);
  // F-2-02: the $1,000 incentive needs the SMDU close within two months of the last day of the month in which the final trial payment is due (independent of a processing month).
  return { due_dates: dues, trial_payment_cents: pi + tiMonthly + shortageMonthly, capitalization_date: last, effective: eff, form_3179_by: last, incentive_deadline: endOfMonth(addMonths(last, 2)) };
}
export function trialMonthMet(receivedOn: PlainDate, dueOn: PlainDate, amount: Cents, trialAmount: Cents): boolean { return amount >= trialAmount && receivedOn <= endOfMonth(dueOn); }
export function solicitationAllowed(saleOn: PlainDate | null, today: PlainDate, judicial: boolean): boolean { if (!saleOn) return true; const days = (Date.parse(saleOn) - Date.parse(today)) / 86_400_000; return days > (judicial ? 60 : 30); }
