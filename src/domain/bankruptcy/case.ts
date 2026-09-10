/** §14.1 Bankruptcy monitoring & Proof of Claim — stay gates, prior filings, referral, POC arithmetic, ledger views, trustee vouchers. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound } from "../../kernel/money/decimal.ts";
import { monthlyInterest, ratePercent } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

export type Chapter = "7" | "11" | "12" | "13";
export type StayState = "in_effect" | "not_in_effect_362c4" | "terminated_362c3" | "relief_granted" | "ended_discharge" | "ended_dismissal" | "ended_closed";
export function stayGates(s: StayState, counselConfirmedNoStay = false, relief14DaysPassed = false): { collections_blocked: boolean; foreclosure_blocked: boolean; contact_route: "normal" | "counsel_only" | "informational_only"; late_charges: "memo_only" | "normal" | "waived_default" } {
  switch (s) {
    case "in_effect": return { collections_blocked: true, foreclosure_blocked: true, contact_route: "counsel_only", late_charges: "memo_only" };
    case "not_in_effect_362c4": case "terminated_362c3": return { collections_blocked: !counselConfirmedNoStay, foreclosure_blocked: !counselConfirmedNoStay, contact_route: "counsel_only", late_charges: "memo_only" };
    case "relief_granted": return { collections_blocked: true, foreclosure_blocked: !relief14DaysPassed, contact_route: "counsel_only", late_charges: "memo_only" };
    case "ended_discharge": return { collections_blocked: true, foreclosure_blocked: false, contact_route: "informational_only", late_charges: "memo_only" };
    default: return { collections_blocked: false, foreclosure_blocked: false, contact_route: "normal", late_charges: "waived_default" };
  }
}
export function priorFilingClass(priorDismissedWithin1y: number, abusivePattern: boolean): "none" | "one_prior_dismissed_1y" | "two_plus_prior_dismissed_1y" | "abusive_suspected" { if (abusivePattern) return "abusive_suspected"; return priorDismissedWithin1y >= 2 ? "two_plus_prior_dismissed_1y" : priorDismissedWithin1y === 1 ? "one_prior_dismissed_1y" : "none"; }
export function referralDecision(chapter: Chapter, delinquencyDaysAtFiling: number, openForeclosure: boolean, cramdownOrAbuse = false): { type: "full" | "poc_only"; form20: boolean; convert_to_full_when_60: boolean } {
  if (chapter === "11") return { type: "full", form20: true, convert_to_full_when_60: false };
  if (cramdownOrAbuse || delinquencyDaysAtFiling >= 60 || openForeclosure) return { type: "full", form20: false, convert_to_full_when_60: false };
  return { type: "poc_only", form20: false, convert_to_full_when_60: true };
}
export function clocks(petitionOn: PlainDate): { poc_bar: PlainDate; poc_supplement: PlainDate; prior_filing_check: PlainDate; referral: PlainDate; poc_package_target: PlainDate; serial_stay_30: PlainDate } {
  const bar = addDays(petitionOn, 70);
  return { poc_bar: bar, poc_supplement: addDays(petitionOn, 120), prior_filing_check: addDays(petitionOn, 14), referral: addDays(petitionOn, 14), poc_package_target: addDays(bar, -35), serial_stay_30: addDays(petitionOn, 30) };
}
export function conversionPocBar(conversionOn: PlainDate): PlainDate { return addDays(conversionOn, 70); }
export function mfrReferralDue(postpetition60On: PlainDate): PlainDate { return addDays(postpetition60On, 14); }

export interface UnpaidInstallment { readonly due: PlainDate; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly late_charge_cents: Cents; }
/** Scheduled splits of the unpaid pre-petition installments from the UPB after the last paid one. */
export function unpaidSplits(upbAfterLastPaid: Cents, ratePct: string, piCents: Cents, firstUnpaidDue: PlainDate, petitionOn: PlainDate, lateChargeCents: Cents, graceDays: number): UnpaidInstallment[] {
  const out: UnpaidInstallment[] = []; let upb = upbAfterLastPaid; let due = firstUnpaidDue;
  while (due <= petitionOn) { const i = monthlyInterest(upb, ratePercent(ratePct)); const p = piCents - i; out.push({ due, interest_cents: i, principal_cents: p, late_charge_cents: addDays(due, graceDays) < petitionOn ? lateChargeCents : 0n }); upb -= p; due = addMonths(due, 1); }
  return out;
}
export interface Poc { readonly part2_total_debt_cents: Cents; readonly part3: { principal_due_cents: Cents; interest_due_cents: Cents; prepetition_fees_due_cents: Cents; escrow_deficiency_cents: Cents; funds_on_hand_cents: Cents; total_prepetition_arrearage_cents: Cents }; readonly part4_monthly_cents: Cents; readonly part5_starts: PlainDate; }
export function proofOfClaim(f: { ib_upb_cents: Cents; nib_cents: Cents; unpaid: readonly UnpaidInstallment[]; other_prepetition_fees_cents: Cents; escrow_balance_at_petition_cents: Cents; funds_on_hand_cents: Cents; pi_cents: Cents; escrow_monthly_cents: Cents; pmi_cents?: Cents }): Poc {
  const principalDue = f.unpaid.reduce((s, i) => s + i.principal_cents, 0n), interestDue = f.unpaid.reduce((s, i) => s + i.interest_cents, 0n);
  const fees = f.unpaid.reduce((s, i) => s + i.late_charge_cents, 0n) + f.other_prepetition_fees_cents;
  const escrowDef = f.escrow_balance_at_petition_cents < 0n ? -f.escrow_balance_at_petition_cents : 0n;
  const arrears = principalDue + interestDue + fees + escrowDef - f.funds_on_hand_cents;
  return { part2_total_debt_cents: f.ib_upb_cents + f.nib_cents + interestDue + fees + escrowDef - f.funds_on_hand_cents, part3: { principal_due_cents: principalDue, interest_due_cents: interestDue, prepetition_fees_due_cents: fees, escrow_deficiency_cents: escrowDef, funds_on_hand_cents: f.funds_on_hand_cents, total_prepetition_arrearage_cents: arrears }, part4_monthly_cents: f.pi_cents + f.escrow_monthly_cents + (f.pmi_cents ?? 0n), part5_starts: f.unpaid[0]!.due };
}
export function planCureInstallment(arrears: Cents, months = 60): { installment_cents: Cents; last_installment_cents: Cents } { const i = divRound(arrears, BigInt(months), "HALF_UP"); return { installment_cents: i, last_installment_cents: arrears - i * BigInt(months - 1) }; }

export interface PostPetitionInstallment { readonly due: PlainDate; readonly amount_cents: Cents; paid_cents: Cents; }
export interface Ledgers { prepetition_arrearage_cents: Cents; postpetition: PostPetitionInstallment[]; postpetition_suspense_cents: Cents; }
/** Trustee voucher application (rule 6a): conduit post-petition amounts oldest-first (short installments carry `short_cents`), arrearage amounts reduce the claim. */
export function applyVoucher(l: Ledgers, v: { amount_cents: Cents; designation: "post-petition" | "arrearage" | "unlabelled"; conduit_district: boolean }): { applied_postpetition_cents: Cents; applied_arrearage_cents: Cents; short: { due: PlainDate; short_cents: Cents }[] } {
  let pool = v.amount_cents; let pp = 0n, ar = 0n;
  const toPost = v.designation === "post-petition" || (v.designation === "unlabelled" && v.conduit_district);
  if (toPost) { for (const i of l.postpetition.sort((a, b) => (a.due < b.due ? -1 : 1))) { if (pool <= 0n) break; const need = i.amount_cents - i.paid_cents; if (need <= 0n) continue; const take = pool < need ? pool : need; i.paid_cents += take; pool -= take; pp += take; } }
  if (pool > 0n) { const take = pool < l.prepetition_arrearage_cents ? pool : l.prepetition_arrearage_cents; l.prepetition_arrearage_cents -= take; pool -= take; ar += take; }
  const short = l.postpetition.filter((i) => i.paid_cents > 0n && i.paid_cents < i.amount_cents).map((i) => ({ due: i.due, short_cents: i.amount_cents - i.paid_cents }));
  return { applied_postpetition_cents: pp, applied_arrearage_cents: ar, short };
}
export function postpetitionDelinquencyDays(l: Ledgers, today: PlainDate): number { const first = l.postpetition.filter((i) => i.paid_cents < i.amount_cents).sort((a, b) => (a.due < b.due ? -1 : 1))[0]; return first ? Math.max(0, (Date.parse(today) - Date.parse(first.due)) / 86_400_000) : 0; }
export function firmAckDue(referralOn: PlainDate): PlainDate { return addBusinessDays(referralOn, 2, servicer); }
