/**
 * §16.2 operating rules over the payoff calculators (quote.ts, remit.ts) and
 * the investor/cashiering/servicing-request calculators the process reuses:
 * the payoff date (rule 1), the good-funds method policy (prerequisites /
 * `SM_PAYOFF_GOODFUNDS_GATE`), funds matching (edge case "partial data"), the
 * variance tolerance table, absorption authority and the short-payoff path
 * (rules 2 and 5 / open questions 2–3), application to zero (rule 3), Fannie
 * Mae's share with the participation percentage (rule 4), the Outputs ledger
 * sets, the advance special remittance kept out of the CRS 001 draft (rule 7 /
 * F-1-09), the CRS batch and its 16:00 ET cut-off failure mode (integrations),
 * the reversal branches (rule 6), the LAR 60 removal principal with the NIB
 * validation (T8), the autodraft stop and post-payoff receipt (rules 9–10),
 * the payoff-statement NoE (rule 5 / §1024.35(b)(6)), the S/A collected-
 * interest deficit (worked example), the escrow refund clocks and the
 * housekeeping fan-out (rule 9). One small pure function per rule; the LLM
 * never computes money — these do.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal, fannieEt, nextBusinessDay, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import type { EntrySetInput, AccountRef, LoanAccount, CustodialAccount, CorporateAccount } from "../../kernel/ledger/ledger.ts";
import { loadRegistry } from "../../kernel/timers/registry.ts";
import { compensatoryFee } from "../investor/remittance.ts";
import { bd2CloseMs, nextMonth, calendarDraftDate, larDeadlineMs, fannieBusinessDay, period as activityPeriodOf, periodEndOf, removalCorrectionCloseMs } from "../investor/period.ts";
import { exceptionDetectedEvent } from "../investor/ops.ts";
import { zoned } from "../investor/lar.ts";
import { deadlines as noeDeadlines, type Deadlines as NoeDeadlines } from "../servicing-requests/noe.ts";
import { noeOpenedPayload, type NoeOpenedPayload } from "../servicing-requests/cases.ts";
import { enrollmentMachine, type EnrollmentStatus } from "../cashiering/autodraft.ts";
import { interest, quote, deemedPayoffDate, type Components } from "./quote.ts";
import { fnmaShare, variance, SHORT_TOLERANCE_CENTS, OVER_TOLERANCE_CENTS, APPLICATION_ORDER } from "./remit.ts";

const ET = "America/New_York";
export type EscalationKind = "human_portal_task" | "officer" | "attorney" | "signing_officer" | "lossmit_reviewer" | "fraud_officer" | "human_agent" | "sev1" | "sev2" | "sev3" | "sev4";
export interface Escalation { readonly kind: EscalationKind; readonly owner_role: string; readonly severity: "sev1" | "sev2" | "sev3" | "sev4" | null; readonly reason: string; }
export type RemittanceType = "AA" | "SA" | "SS";
export type FundsMethod = "wire" | "ach_credit" | "ach_debit" | "cashiers_check" | "certified_check" | "check" | "internal_transfer" | "closing_agent_wire";
const partOf = (c: Cents, participationPct: string): Cents => participationPct === "100" ? c : divRound(c * Decimal.parse(participationPct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP");

// ───── rule 1: payoff date ─────
/** `payoff_date = credited_as_of` (F-1-09), the closing agent's settlement date for S/S loans paid by a closing agent (F-1-20), with the F-1-09 non-business-day rule. */
export function payoffDate(i: { received_on: PlainDate; remittance_type: RemittanceType; paid_by: "borrower" | "closing_agent" | "estate" | "other"; settlement_date?: PlainDate | null; due_on?: PlainDate | null }): { payoff_date: PlainDate; basis: "credited_as_of" | "closing_agent_settlement_date" | "f109_non_business_day" } {
  if (i.remittance_type === "SS" && i.paid_by === "closing_agent" && i.settlement_date) return { payoff_date: i.settlement_date, basis: "closing_agent_settlement_date" };
  if (i.due_on) { const d = deemedPayoffDate(i.received_on, i.due_on); if (d !== i.received_on) return { payoff_date: d, basis: "f109_non_business_day" }; }
  return { payoff_date: i.received_on, basis: "credited_as_of" };
}

// ───── good-funds policy (operational prerequisite; SM_PAYOFF_GOODFUNDS_GATE holds until `payoff.funds.cleared`) ─────
export const ACH_DEBIT_PAYOFF_MAX_CENTS = 2_500_000n;   // open question 4 default: ≤ $25,000 with a 5-BD hold; above that wire only
export function goodFundsClearing(i: { method: FundsMethod; amount_cents: Cents; received_at_ms: number; bank_verified?: boolean; settlement_date?: PlainDate | null; now_ms?: number }): { status: "cleared" | "held" | "refused"; cleared_at_ms: number | null; cleared_on: PlainDate | null; hold: string; refusal: string | null } {
  const receivedOn = wallClock(i.received_at_ms, ET).date; const now = i.now_ms ?? i.received_at_ms;
  const at = (d: PlainDate, hold: string) => { const ms = zonedEpochMs(d, "09:00", ET); const cleared = Math.max(ms, i.received_at_ms); return { status: cleared <= now ? "cleared" as const : "held" as const, cleared_at_ms: cleared, cleared_on: d, hold, refusal: null }; };
  switch (i.method) {
    case "wire": case "closing_agent_wire": case "internal_transfer": return { status: "cleared", cleared_at_ms: i.received_at_ms, cleared_on: receivedOn, hold: "final on receipt", refusal: null };
    case "cashiers_check": case "certified_check": return i.bank_verified ? { status: "cleared", cleared_at_ms: i.received_at_ms, cleared_on: receivedOn, hold: "bank-verified: final on receipt", refusal: null } : at(addBusinessDays(receivedOn, 1, servicer), "1 business_days_servicer unless bank-verified");
    case "check": return at(addBusinessDays(receivedOn, 7, servicer), "7 business_days_servicer");
    case "ach_credit": return i.settlement_date ? at(i.settlement_date, "at settlement") : { status: "held", cleared_at_ms: null, cleared_on: null, hold: "at settlement (settlement date not yet known)", refusal: null };
    case "ach_debit": return i.amount_cents > ACH_DEBIT_PAYOFF_MAX_CENTS ? { status: "refused", cleared_at_ms: null, cleared_on: null, hold: "none", refusal: `ACH debit payoff ${i.amount_cents} > ${ACH_DEBIT_PAYOFF_MAX_CENTS}: wire only (good-funds policy, open question 4)` } : at(addBusinessDays(receivedOn, 5, servicer), "5 business_days_servicer good-funds hold");
  }
}

// ───── funds matching (edge case "partial data"; 6.5 research 1 BD) ─────
export interface OpenQuote { readonly quote_id: string; readonly loan_id: string; readonly total_cents: Cents; readonly good_through: PlainDate; readonly verification_token?: string | null; }
/** Reference match first (loan number / quote id / verification token); else a single open quote within ± `payoff.short_tolerance_cents`; else research within 1 BD. */
export function matchFunds(i: { amount_cents: Cents; bank_reference: string | null; received_on: PlainDate; quotes: readonly OpenQuote[] }): { matched: OpenQuote | null; basis: "reference" | "amount_within_tolerance" | null; status: "matched" | "unmatched"; research_by: PlainDate | null } {
  const ref = (i.bank_reference ?? "").trim();
  const byRef = ref ? i.quotes.find((q) => q.loan_id === ref || q.quote_id === ref || (q.verification_token !== null && q.verification_token !== undefined && q.verification_token === ref)) ?? null : null;
  if (byRef) return { matched: byRef, basis: "reference", status: "matched", research_by: null };
  const byAmount = i.quotes.filter((q) => { const v = i.amount_cents - q.total_cents; return v >= -SHORT_TOLERANCE_CENTS && v <= SHORT_TOLERANCE_CENTS; });
  if (byAmount.length === 1) return { matched: byAmount[0]!, basis: "amount_within_tolerance", status: "matched", research_by: null };
  return { matched: null, basis: null, status: "unmatched", research_by: addBusinessDays(i.received_on, 1, servicer) };
}

// ───── rule 2 variance + rule 5 short payoff + open questions 2–3 ─────
export const AGENT_ABSORB_LIMIT_CENTS = 50_000n;
export const UNCURED_OFFICER_REVIEW_CENTS = 100_000n;
export type ShortageDisposition = "none" | "borrower_collected" | "servicer_absorbed" | "reliance_absorbed" | "waived_tolerance";
export type VarianceOutcome = "paid_in_full" | "paid_in_full_tolerance" | "overage_refund" | "demand" | "cured" | "absorbed";
export function disposeVariance(i: { amount_cents: Cents; exact_total_cents: Cents; reliance_state: boolean; within_good_through: boolean; statement_error?: boolean; approver_role?: string | null; received_on?: PlainDate | null; per_diem_cents?: Cents; cure_received_cents?: Cents; cure_received_on?: PlainDate | null; additional_interest_allowed?: boolean }): {
  variance_cents: Cents; disposition: ReturnType<typeof variance>["disposition"]; shortage_disposition: ShortageDisposition; outcome: VarianceOutcome; overage_refund_by_bd: 10 | null; demand: boolean; approval: "auto" | "agent" | "officer"; refusal: string | null;
  suspense_reason: "short_payoff" | "overpayment" | null; demand_by: PlainDate | null; uncured_on: PlainDate | null; paid_in_full_as_of: PlainDate | null; additional_interest_cents: Cents; expense_account: "payoff_tolerance_expense" | "payoff_shortfall_expense" | null;
} {
  const v = variance(i.amount_cents, i.exact_total_cents, i.reliance_state, i.within_good_through);
  const short = v.variance_cents < 0n ? -v.variance_cents : 0n;
  const received = i.received_on ?? null;
  const cure = i.cure_received_cents ?? 0n;
  const cured = v.disposition === "short_payoff_demand_1bd" && cure > 0n && i.amount_cents + cure >= i.exact_total_cents - SHORT_TOLERANCE_CENTS;
  const absorbed = v.disposition === "reliance_absorbed" || (v.disposition === "short_payoff_demand_1bd" && i.statement_error === true && !cured);
  const approval: "auto" | "agent" | "officer" = short <= SHORT_TOLERANCE_CENTS ? "auto" : short <= AGENT_ABSORB_LIMIT_CENTS ? "agent" : "officer";
  const refusal = absorbed && approval === "officer" && i.approver_role !== "officer" ? `absorbed shortage ${short} > ${AGENT_ABSORB_LIMIT_CENTS} needs officer approval (package: quote, statement, funds evidence, state reliance rule, variance analysis)` : null;
  const shortage_disposition: ShortageDisposition = cured ? "borrower_collected" : v.disposition === "paid_in_full_tolerance_expense" && v.variance_cents < 0n ? "waived_tolerance" : v.disposition === "reliance_absorbed" ? "reliance_absorbed" : absorbed ? "servicer_absorbed" : "none";
  const demand = v.disposition === "short_payoff_demand_1bd" && !absorbed && !cured;
  const outcome: VarianceOutcome = cured ? "cured" : absorbed ? "absorbed" : demand ? "demand" : v.disposition === "paid_in_full_overage_refund_10bd" ? "overage_refund" : v.disposition === "paid_in_full_tolerance_expense" ? "paid_in_full_tolerance" : "paid_in_full";
  // cured → paid in full as of the original payoff date; additional interest only if the state and statement allow (reliance states: none)
  const addlAllowed = i.additional_interest_allowed ?? !i.reliance_state;
  const addl = cured && addlAllowed && received && i.cure_received_on && i.per_diem_cents ? i.per_diem_cents * BigInt(Math.max(0, daysBetween(received, i.cure_received_on))) : 0n;
  return { variance_cents: v.variance_cents, disposition: v.disposition, shortage_disposition, outcome, overage_refund_by_bd: v.disposition === "paid_in_full_overage_refund_10bd" ? 10 : null, demand, approval, refusal,
    suspense_reason: demand ? "short_payoff" : v.disposition === "paid_in_full_overage_refund_10bd" ? "overpayment" : null,
    demand_by: demand && received ? addBusinessDays(received, 1, servicer) : null, uncured_on: demand && received ? addDays(received, 30) : null,
    paid_in_full_as_of: outcome === "demand" ? null : received, additional_interest_cents: addl,
    expense_account: shortage_disposition === "waived_tolerance" ? "payoff_tolerance_expense" : absorbed ? "payoff_shortfall_expense" : null };
}
/** Rule 5 / open question 3: not cured in 30 days and no reliance → funds applied per the note (installment(s) due, then a curtailment); the loan stays active and the borrower is notified. */
export function applyUncuredPerNote(i: { received_on: PlainDate; today: PlainDate; funds_cents: Cents; installments: readonly { due_on: PlainDate; amount_cents: Cents; interest_cents?: Cents }[]; reliance_state: boolean; balances?: { principal_cents: Cents; interest_due_cents: Cents } }): { eligible: boolean; uncured_on: PlainDate; outcome: "applied_per_note" | "hold"; installments_paid: PlainDate[]; installments_cents: Cents; installment_interest_cents: Cents; installment_principal_cents: Cents; curtailment_cents: Cents; extra_interest_cents: Cents; unapplied_cents: Cents; loan_status: "active"; notice_required: boolean; escalation: Escalation | null; reason: string | null } {
  const uncuredOn = addDays(i.received_on, 30);
  const hold = (reason: string) => ({ eligible: false, uncured_on: uncuredOn, outcome: "hold" as const, installments_paid: [], installments_cents: 0n, installment_interest_cents: 0n, installment_principal_cents: 0n, curtailment_cents: 0n, extra_interest_cents: 0n, unapplied_cents: 0n, loan_status: "active" as const, notice_required: false, escalation: null, reason });
  if (i.reliance_state) return hold("reliance state: the statement figure binds — disposition is reliance_absorbed, not application per the note");
  if (i.today < uncuredOn) return hold(`cure window open until ${uncuredOn}; funds stay in suspense_items{short_payoff}`);
  let remaining = i.funds_cents; const paid: PlainDate[] = []; let inst = 0n, instInt = 0n;
  for (const x of [...i.installments].sort((a, b) => (a.due_on < b.due_on ? -1 : 1))) { if (x.amount_cents <= remaining) { remaining -= x.amount_cents; inst += x.amount_cents; instInt += x.interest_cents ?? 0n; paid.push(x.due_on); } else break; }
  // the curtailment never overshoots the principal: what is left pays interest still due under the note, and any remainder stays in suspense
  const max = (a: Cents, b: Cents) => (a > b ? a : b), min = (a: Cents, b: Cents) => (a < b ? a : b);
  let curtailment = remaining, extraInterest = 0n, unapplied = 0n;
  if (i.balances) { curtailment = min(remaining, max(0n, i.balances.principal_cents - (inst - instInt))); const left = remaining - curtailment; extraInterest = min(left, max(0n, i.balances.interest_due_cents - instInt)); unapplied = left - extraInterest; }
  // the borrower is notified (rule 5 / open question 3): the tool derives it from the sent demand — never a literal here
  return { eligible: true, uncured_on: uncuredOn, outcome: "applied_per_note", installments_paid: paid, installments_cents: inst, installment_interest_cents: instInt, installment_principal_cents: inst - instInt, curtailment_cents: curtailment, extra_interest_cents: extraInterest, unapplied_cents: unapplied, loan_status: "active", notice_required: true,
    escalation: i.funds_cents > UNCURED_OFFICER_REVIEW_CENTS ? { kind: "officer", owner_role: "officer", severity: null, reason: `uncured shortage funds ${i.funds_cents} > ${UNCURED_OFFICER_REVIEW_CENTS} applied per the note (open question 3)` } : null, reason: null };
}
/** Ledger set for the day-30 application per the note: Dr `suspense/unapplied` (the held funds) / Cr `interest_due` (installment interest) and `principal` (installment principal, then the curtailment). */
export function perNoteEntrySet(loanId: string, r: ReturnType<typeof applyUncuredPerNote>, on: PlainDate): EntrySetInput | null {
  if (!r.eligible) return null;
  const principal = r.installment_principal_cents + r.curtailment_cents; const interestPaid = r.installment_interest_cents + r.extra_interest_cents;
  const lines = [{ account: loanAcct(loanId, "suspense_unapplied"), amountCents: r.installments_cents + r.curtailment_cents + r.extra_interest_cents, ruleRef: "16.2.rule5.applied_per_note" }];
  if (interestPaid > 0n) lines.push({ account: loanAcct(loanId, "interest_due"), amountCents: -interestPaid, ruleRef: "16.2.rule5.applied_per_note.interest" });
  if (principal > 0n) lines.push({ account: loanAcct(loanId, "principal"), amountCents: -principal, ruleRef: "16.2.rule5.applied_per_note.principal" });
  return { effectiveDate: on, description: `uncured short payoff applied per the note ${loanId}`, lines };
}

// ───── rule 3 application to zero (Allocation Engine, payoff mode) ─────
export interface PayoffBuckets { readonly accrued_interest: Cents; readonly principal: Cents; readonly nib_deferred?: Cents; readonly nib_forborne?: Cents; readonly escrow_advance?: Cents; readonly late_charges?: Cents; readonly nsf_other_fees?: Cents; readonly corporate_advances?: Cents; readonly recording_release_fee?: Cents; readonly buydown_credit?: Cents; readonly suspense_credit?: Cents; readonly escrow_balance?: Cents; }
export type ApplicationLine = { account: (typeof APPLICATION_ORDER)[number]; cents: Cents };
/**
 * Buydown/suspense credits offset first; then interest → principal → NIB → escrow advance → late charges → NSF/other → corporate advances → recording fee.
 * Funds short by more than the tolerance are never applied (they sit in `suspense_items{short_payoff}` for the cure window — rule 5); a shortfall
 * within the tolerance is funded to `payoff_tolerance_expense` so every account reads zero except `escrow` (refund pending) and `suspense/unapplied` (overage pending).
 */
export function applyToZero(b: PayoffBuckets, amountCents: Cents): { lines: ApplicationLine[]; offsets_cents: Cents; applied_cents: Cents; unapplied_cents: Cents; balances_after: Record<string, Cents>; zero: boolean; escrow_refund_pending_cents: Cents; total_due_cents: Cents; short_cents: Cents; tolerance_expense_cents: Cents; held_in_suspense: "short_payoff" | null } {
  const offsets = (b.buydown_credit ?? 0n) + (b.suspense_credit ?? 0n);
  const dues = APPLICATION_ORDER.map((acct) => ({ account: acct, cents: (b as unknown as Record<string, Cents | undefined>)[acct] ?? 0n }));
  const totalDue = dues.reduce((t, l) => t + l.cents, 0n);
  const funds = amountCents + offsets;
  const shortfall = totalDue - funds;
  if (shortfall > SHORT_TOLERANCE_CENTS) {
    const after: Record<string, Cents> = Object.fromEntries(dues.map((l) => [l.account, l.cents]));
    return { lines: [], offsets_cents: offsets, applied_cents: 0n, unapplied_cents: funds, balances_after: { ...after, escrow: b.escrow_balance ?? 0n, suspense_unapplied: funds }, zero: false, escrow_refund_pending_cents: 0n, total_due_cents: totalDue, short_cents: shortfall, tolerance_expense_cents: 0n, held_in_suspense: "short_payoff" };
  }
  const tolerance = shortfall > 0n ? shortfall : 0n;
  const overage = shortfall < 0n ? -shortfall : 0n;
  const after: Record<string, Cents> = Object.fromEntries(dues.map((l) => [l.account, 0n]));
  return { lines: dues, offsets_cents: offsets, applied_cents: totalDue - tolerance, unapplied_cents: overage, balances_after: { ...after, escrow: b.escrow_balance ?? 0n, suspense_unapplied: overage }, zero: true, escrow_refund_pending_cents: b.escrow_balance ?? 0n, total_due_cents: totalDue, short_cents: tolerance, tolerance_expense_cents: tolerance, held_in_suspense: null };
}

// ───── rule 4: Fannie Mae's share with the participation percentage ─────
/** F-1-20 S/S exception, derived from the `fannie_et` calendar (never a caller flag): no full-month interest when the liquidation is processed on BD1 and reported to Fannie Mae by BD2 of that month. */
export function ssBd1Bd2Exception(i: { type: RemittanceType; processed_on: PlainDate; reported_on?: PlainDate | null }): boolean {
  if (i.type !== "SS") return false;
  const bd1 = fannieBusinessDay(i.processed_on, 1), bd2 = fannieBusinessDay(i.processed_on, 2);
  return i.processed_on === bd1 && (i.reported_on ?? i.processed_on) <= bd2;
}
export interface FnmaPayoffShare { principal_cents: Cents; interest_cents: Cents; collected_interest_cents: Cents; servicing_fee_cents: Cents; ss_interest_gap_cents: Cents; total_cents: Cents; participation_pct: string; interest_deficit_cents: Cents; scheduled_cycle_interest_cents: Cents; ss_bd1_bd2_exception: boolean; }
/**
 * `principal_due = (UPB + NIB) × participation_pct`; interest by remittance type × participation (rule 4).
 * Servicing fee = interest collected at the note rate − interest due at PTR for the same days, for every remittance type; under S/A–S/S the PTR interest
 * for the full months from the LPI date is scheduled-cycle interest the regular draft covers (`scheduled_cycle_interest_cents`, never in the payoff draft), and
 * the servicer funds the payoff-month deficit (S/S full month, S/A half month) from corporate (`interest_deficit_cents`).
 */
export function fnmaPayoffShare(f: Omit<Parameters<typeof fnmaShare>[0], "processed_bd1_reported_bd2"> & { participation_pct?: string; processed_on?: PlainDate; reported_on?: PlainDate | null }): FnmaPayoffShare {
  const p = f.participation_pct ?? "100";
  const exception = ssBd1Bd2Exception({ type: f.type, processed_on: f.processed_on ?? f.payoff_on, reported_on: f.reported_on ?? null });
  const s = fnmaShare({ ...f, processed_bd1_reported_bd2: exception });
  const ptr = interest(f.upb_cents, f.ptr_pct, f.lpi_due, f.payoff_on);
  // servicer-funded PTR interest: S/S the full-month gap; S/A the half month beyond the PTR-equivalent of the days collected (worked example: $6.83); A/A none
  const saDeficit = f.type === "SA" && s.interest_cents > ptr.partial_cents ? s.interest_cents - ptr.partial_cents : 0n;
  const deficit = f.type === "SS" ? s.ss_interest_gap_cents : saDeficit;
  const scheduled = f.type === "AA" ? 0n : ptr.full_cents;
  const fnmaFromCollections = s.interest_cents - deficit + scheduled;
  const fee = s.collected_interest_cents > fnmaFromCollections ? s.collected_interest_cents - fnmaFromCollections : 0n;
  if (p === "100") return { ...s, servicing_fee_cents: fee, participation_pct: p, interest_deficit_cents: deficit, scheduled_cycle_interest_cents: scheduled, ss_bd1_bd2_exception: exception };
  const principal = partOf(f.upb_cents + f.nib_cents, p), fnmaInt = partOf(s.interest_cents, p), pDeficit = partOf(deficit, p), pScheduled = partOf(scheduled, p);
  const gap = s.ss_interest_gap_cents > 0n ? partOf(s.ss_interest_gap_cents, p) : 0n;
  const pFee = s.collected_interest_cents > fnmaInt - pDeficit + pScheduled ? s.collected_interest_cents - (fnmaInt - pDeficit + pScheduled) : 0n;
  return { principal_cents: principal, interest_cents: fnmaInt, collected_interest_cents: s.collected_interest_cents, servicing_fee_cents: pFee, ss_interest_gap_cents: gap, total_cents: principal + fnmaInt, participation_pct: p, interest_deficit_cents: pDeficit, scheduled_cycle_interest_cents: pScheduled, ss_bd1_bd2_exception: exception };
}
/** F-1-20: S/A draft on the 20th and S/S draft on the 18th of the month following the payoff month (preceding `fannie_et` BD). */
export function fnmaDraftDate(type: RemittanceType, payoffOn: PlainDate): PlainDate | null {
  if (type === "AA") return null;
  return calendarDraftDate(nextMonth(payoffOn), type === "SA" ? 20 : 18);
}
/** IRM §4-08 / SVC-2026-03 finality: BD2 17:00 ET of the month following the payoff month — after it the payoff is not reactivated. */
export function finalityAtMs(payoffOn: PlainDate): number { return bd2CloseMs(nextMonth(payoffOn)); }
/** The activity period a payoff reports in (5.1 rule 2 for a removal processed before the close), its last calendar day (the correction clock's anchor) and the BD2 17:00 ET close after which the action code 60 is final (IRM §4-08). */
export function payoffActivityPeriod(payoffOn: PlainDate): { activity_period: string; period_end: PlainDate; correction_close_ms: number } {
  const ap = activityPeriodOf(payoffOn);
  return { activity_period: ap, period_end: periodEndOf(payoffOn), correction_close_ms: removalCorrectionCloseMs(ap) };
}
/** IRM §2-04: the LAR 60 is due by 20:00 ET on the next `fannie_et` business day after processing — 17:00 ET when that day is BD2 (a payoff processed on BD1). */
export function lar60DueMs(processedAtMs: number): number { return larDeadlineMs(processedAtMs, true); }
/** The `investor_event_exceptions.detected{family=removal}` event a pre-close reversal raises on the accepted/submitted LAR 60 (5.1/5.3 correction clock `FNMA_IRM_REMOVAL_CORRECTION_BD2_1700`). */
export function reversalExceptionEvent(i: { loan_id: string; correcting_event_id: string; payoff_on: PlainDate; cause: ReversalCause; detected_at_ms: number }): ReturnType<typeof exceptionDetectedEvent> {
  return exceptionDetectedEvent({ event_id: i.correcting_event_id, loan_id: i.loan_id, family: "removal", activity_period: payoffActivityPeriod(i.payoff_on).activity_period, severity: "hard", code: `PAYOFF_${i.cause.toUpperCase()}_PRE_CLOSE`, detected_at_ms: i.detected_at_ms });
}
/** Inbound LSDU acknowledgment of a removal event (validated before anything is appended): a correction acknowledged after the BD2 17:00 ET close is refused — the action code 60 is final (IRM §4-08, SVC-2026-03). */
export function acceptRemovalAck(i: { event_status: string; correction: boolean; corrects_event_id?: string | null; ack_reference: string | null; accepted_at_ms: number; finality_at_ms: number }): { status: "accepted"; supersedes_event_id: string | null; accepted_on: PlainDate } {
  if (!i.ack_reference || !i.ack_reference.trim()) throw new RangeError("LSDU acknowledgment needs an ack reference (the inbound record's identifier)");
  if (!["submitted", "accepted", "accepted_with_warnings"].includes(i.event_status)) throw new RangeError(`investor event is ${i.event_status}: only a submitted event can be acknowledged`);
  if (!Number.isFinite(i.accepted_at_ms)) throw new RangeError("accepted_at must be a timestamp");
  if (i.correction && i.accepted_at_ms > i.finality_at_ms) throw new RangeError(`correction acknowledged ${toIso(i.accepted_at_ms)} after the period close ${toIso(i.finality_at_ms)} (BD2 17:00 ET): the action code 60 is final — the loan is not reactivated (IRM §4-08; SVC-2026-03); open a qc_finding`);
  if (i.correction && !i.corrects_event_id) throw new RangeError("a correcting removal event must name the event it supersedes");
  return { status: "accepted", supersedes_event_id: i.correction ? i.corrects_event_id ?? null : null, accepted_on: wallClock(i.accepted_at_ms, ET).date };
}
/** Event types whose timers a payoff arms; a pre-close reversal cancels every open instance they armed (rule 6: housekeeping tasks cancelled/reversed). */
export const PAYOFF_ARMING_EVENTS: ReadonlySet<string> = new Set(["loan.paid_in_full", "payoff.completed", "payoff.applied", "payoff.funds.cleared", "payoff.funds.received", "payoff.funds_received"]);

// ───── Outputs: ledger entry sets (balanced, rule_ref on every line) ─────
const loanAcct = (loanId: string, account: string): AccountRef => ({ scope: "loan", loanId, account: account as LoanAccount });
const custAcct = (custodialAccountId: string, account: string): AccountRef => ({ scope: "custodial", custodialAccountId, account: account as CustodialAccount });
const corpAcct = (account: string): AccountRef => ({ scope: "corporate", account: account as CorporateAccount });
const LOAN_ACCOUNT_FOR: Record<(typeof APPLICATION_ORDER)[number], string> = { accrued_interest: "interest_due", principal: "principal", nib_deferred: "deferred_principal", nib_forborne: "forborne_principal", escrow_advance: "escrow_advance", late_charges: "late_charges", nsf_other_fees: "nsf_fees", corporate_advances: "corporate_advance", recording_release_fee: "recording_fee_payable" };
const FEE_INCOME_FOR: Partial<Record<(typeof APPLICATION_ORDER)[number], string>> = { late_charges: "late_charge_income", nsf_other_fees: "nsf_fee_income", corporate_advances: "advance_receivable", recording_release_fee: "recording_fee_payable", escrow_advance: "escrow_advance_recovery" };
export interface LedgerInputs { readonly loan_id: string; readonly custodial: { readonly pi: string; readonly ti: string; readonly clearing: string }; readonly payoff_on: PlainDate; readonly received_cents: Cents; readonly application: ReturnType<typeof applyToZero>; readonly buydown_cents: Cents; readonly share: { readonly principal_cents: Cents; readonly interest_cents: Cents; readonly collected_interest_cents: Cents; readonly servicing_fee_cents: Cents; readonly ss_interest_gap_cents: Cents; readonly total_cents: Cents; readonly interest_deficit_cents?: Cents; readonly scheduled_cycle_interest_cents?: Cents } | null; readonly absorbed_shortage_cents?: Cents; readonly remittance_type: RemittanceType; }
export function payoffLedgerSets(i: LedgerInputs): { sets: EntrySetInput[]; balanced: boolean; servicer_funded_cents: Cents; fnma_payable_cents: Cents; scheduled_cycle_interest_cents: Cents; servicing_fee_withdrawable_cents: Cents } {
  const a = i.application; const L = (loanId: string, acct: string, cents: Cents, ruleRef: string) => ({ account: loanAcct(loanId, acct), amountCents: cents, ruleRef });
  const C = (id: string, acct: string, cents: Cents, ruleRef: string) => ({ account: custAcct(id, acct), amountCents: cents, ruleRef });
  const K = (acct: string, cents: Cents, ruleRef: string) => ({ account: corpAcct(acct), amountCents: cents, ruleRef });
  const sets: EntrySetInput[] = [];
  const absorbed = i.absorbed_shortage_cents ?? 0n; const tolerance = a.tolerance_expense_cents; const overage = a.unapplied_cents;
  // 1. loan application: Dr suspense/unapplied (received, less any overage left pending) [+ buydown credit, + servicer-funded shortfall] / Cr every due account (rule 3)
  const applied = a.lines.filter((l) => l.cents > 0n);
  if (applied.length) {
    const lines = [L(i.loan_id, "suspense_unapplied", i.received_cents - overage, "16.2.rule3.application"), ...applied.map((l) => L(i.loan_id, LOAN_ACCOUNT_FOR[l.account], -l.cents, `16.2.rule3.${l.account}`))];
    if (i.buydown_cents > 0n) lines.push(C(i.custodial.ti, "buydown_funds_held", i.buydown_cents, "16.2.rule7.buydown_credit"));
    if (tolerance > 0n) lines.push(K("payoff_tolerance_expense", tolerance, "16.2.rule2.tolerance"));
    if (absorbed > 0n) lines.push(K("payoff_shortfall_expense", absorbed, "16.2.rule5.absorbed_shortage"));
    sets.push({ effectiveDate: i.payoff_on, description: `payoff application to zero ${i.loan_id}`, lines });
  }
  // 2. custodial split of the cash received: P&I custodial, corporate (fees, advance recoveries, recording fee), T&I (overage pending refund) / Cr clearing
  const feePortion = applied.filter((l) => FEE_INCOME_FOR[l.account] !== undefined).reduce((t, l) => t + l.cents, 0n);
  const piCash = i.received_cents - overage - feePortion;
  if (i.received_cents > 0n) {
    const lines = [C(i.custodial.clearing, "clearing_cash", -i.received_cents, "16.2.outputs.custodial_split")];
    if (piCash > 0n) lines.push(C(i.custodial.pi, "custodial_pi_cash", piCash, "16.2.outputs.custodial_split.pi"));
    if (feePortion > 0n) lines.push(K("corporate_cash", feePortion, "16.2.outputs.custodial_split.corporate"));
    if (overage > 0n) lines.push(C(i.custodial.ti, "custodial_ti_cash", overage, "16.2.rule2.overage_pending_refund"));
    sets.push({ effectiveDate: i.payoff_on, description: `payoff cash split ${i.loan_id}`, lines });
  }
  // 3. Fannie Mae's share and the servicing fee recognised as liabilities of the P&I custodial against the unremitted-collections memo (5.2 drafts Dr fnma_remittance_payable / Cr custodial_pi_cash);
  //    a PTR deficit (S/S full month, S/A half month) is servicer-funded from corporate (rule 4)
  let payable = 0n, fee = 0n, gap = 0n, scheduled = 0n;
  if (i.share) {
    const piCollected = i.share.principal_cents + i.share.collected_interest_cents;   // UPB + NIB + interest collected at the note rate
    gap = i.share.interest_deficit_cents ?? i.share.ss_interest_gap_cents;             // servicer-funded PTR interest (S/S full month; S/A half month beyond the days collected)
    scheduled = i.share.scheduled_cycle_interest_cents ?? 0n;                           // S/A–S/S: PTR interest for the full months from the LPI date, remitted through the regular draft (F-1-20), never in the payoff draft
    payable = i.share.total_cents + i.buydown_cents;
    // the servicing fee is what the borrower's collections carry beyond Fannie Mae's PTR interest (rule 4): payoff share less the servicer-funded deficit, plus the scheduled-cycle months
    fee = piCollected > payable - gap - i.buydown_cents + scheduled ? piCollected - (payable - gap - i.buydown_cents + scheduled) : 0n;
    const lines = [C(i.custodial.pi, "pi_collections_unremitted", piCollected + i.buydown_cents, "16.2.rule4.recognition"), C(i.custodial.pi, "fnma_remittance_payable", -(payable - gap), "16.2.rule4.fnma_share")];
    if (scheduled > 0n) lines.push(C(i.custodial.pi, "fnma_remittance_payable", -scheduled, "16.2.rule4.scheduled_cycle_interest (F-1-20 regular draft)"));
    if (fee > 0n) lines.push(C(i.custodial.pi, "servicing_fee_withdrawable", -fee, "16.2.rule4.servicing_fee"));
    sets.push({ effectiveDate: i.payoff_on, description: `Fannie Mae share recognition ${i.loan_id} (${i.remittance_type})`, lines });
    if (gap > 0n) sets.push({ effectiveDate: i.payoff_on, description: `servicer-funded PTR interest gap ${i.loan_id} (${i.remittance_type})`, lines: [K("payoff_interest_shortfall_expense", gap, "16.2.rule4.ss_interest_gap"), K("corporate_cash", -gap, "16.2.rule4.ss_interest_gap"), C(i.custodial.pi, "custodial_pi_cash", gap, "16.2.rule4.ss_interest_gap.funding"), C(i.custodial.pi, "fnma_remittance_payable", -gap, "16.2.rule4.ss_interest_gap.payable")] });
  }
  // 4. servicer-absorbed shortage / tolerance shortfall funded into the P&I custodial so Fannie Mae is always remitted in full (rules 2 and 5)
  if (absorbed > 0n) sets.push({ effectiveDate: i.payoff_on, description: `absorbed payoff shortage funding ${i.loan_id}`, lines: [K("corporate_cash", -absorbed, "16.2.rule5.absorbed_shortage.funding"), C(i.custodial.pi, "custodial_pi_cash", absorbed, "16.2.rule5.absorbed_shortage.funding")] });
  if (tolerance > 0n) sets.push({ effectiveDate: i.payoff_on, description: `tolerance shortfall funding ${i.loan_id}`, lines: [K("corporate_cash", -tolerance, "16.2.rule2.tolerance.funding"), C(i.custodial.pi, "custodial_pi_cash", tolerance, "16.2.rule2.tolerance.funding")] });
  const balanced = sets.every((s) => s.lines.reduce((t, l) => t + l.amountCents, 0n) === 0n && s.lines.every((l) => l.amountCents !== 0n && l.ruleRef.length > 0));
  return { sets, balanced, servicer_funded_cents: tolerance + absorbed + gap, fnma_payable_cents: payable, scheduled_cycle_interest_cents: scheduled, servicing_fee_withdrawable_cents: fee };
}

// ───── rule 7 / F-1-09: advances repaid by special remittance, never inside the payoff draft ─────
export const CRS_ADVANCE_REPAY_CODE = "352";   // [PARTIALLY VERIFIED code]
export function advanceSpecialRemittance(i: { payoff_on: PlainDate; fnma_share_cents: Cents; buydown_remit_cents?: Cents; fnma_advance_repay_cents: Cents; servicer_advance_recovered_cents?: Cents }): { crs_001_cents: Cents; crs_352_cents: Cents; special_remit_by: PlainDate | null; excluded_from_001: boolean; servicer_recovery_cents: Cents } {
  const repay = i.fnma_advance_repay_cents > 0n ? i.fnma_advance_repay_cents : 0n;
  return { crs_001_cents: i.fnma_share_cents + (i.buydown_remit_cents ?? 0n), crs_352_cents: repay, special_remit_by: repay > 0n ? addDays(i.payoff_on, 30) : null, excluded_from_001: true, servicer_recovery_cents: i.servicer_advance_recovered_cents ?? 0n };
}

// ───── CRS batch (integrations: fnma-crs, UI upload by the fnma_portal_operator) ─────
export interface SettlementRow { readonly loan_id: string; readonly settlement_id?: string; readonly fnma_loan_number: string; readonly remittance_type: RemittanceType; readonly fnma_share_cents: Cents; readonly buydown_remit_cents?: Cents; readonly fnma_advance_repay_cents?: Cents; readonly payoff_on: PlainDate; }
export interface CrsLine { readonly lender_id: string; readonly code: "001" | "352"; readonly amount_cents: Cents; readonly loan_number: string; readonly settlement_on: PlainDate; }
export function crsBatch(i: { lender_id: string; instructed_at_ms: number; settlements: readonly SettlementRow[] }): { lines: CrsLine[]; control_total_cents: Cents; batch_on: PlainDate; before_cutoff: boolean; settlement_on: PlainDate; upload_task: { kind: "human_portal_task"; role: "fnma_portal_operator"; package: string[] }; text: string } {
  const wc = wallClock(i.instructed_at_ms, ET); const cutoff = zonedEpochMs(wc.date, "16:00", ET);
  const before = i.instructed_at_ms <= cutoff; const instructOn = before ? wc.date : nextBusinessDay(wc.date, fannieEt); const settleOn = nextBusinessDay(instructOn, federal);
  const lines: CrsLine[] = [];
  for (const s of i.settlements) {
    if (s.remittance_type === "AA") lines.push({ lender_id: i.lender_id, code: "001", amount_cents: s.fnma_share_cents + (s.buydown_remit_cents ?? 0n), loan_number: s.fnma_loan_number, settlement_on: settleOn });
    if ((s.fnma_advance_repay_cents ?? 0n) > 0n) lines.push({ lender_id: i.lender_id, code: "352", amount_cents: s.fnma_advance_repay_cents!, loan_number: s.fnma_loan_number, settlement_on: settleOn });
  }
  const total = lines.reduce((t, l) => t + l.amount_cents, 0n);
  return { lines, control_total_cents: total, batch_on: instructOn, before_cutoff: before, settlement_on: settleOn, upload_task: { kind: "human_portal_task", role: "fnma_portal_operator", package: ["batch file", "control totals", "loan list", "quote/settlement references", `cut-off 16:00 ET ${instructOn}`] }, text: lines.map((l) => [l.lender_id, l.code, l.amount_cents.toString(), l.loan_number, l.settlement_on].join("|")).join("\n") };
}
const AA_IMMEDIATE = "FNMA_F120_PAYOFF_AA_IMMEDIATE" as const;
const severityOf = (code: string): "sev1" | "sev2" | "sev3" | "sev4" => `sev${loadRegistry().get(code)?.severity.level ?? 1}` as "sev1";
/** Failure mode: CRS upload missed before 16:00 ET → next-BD settlement, FNMA_F120_PAYOFF_AA_IMMEDIATE breaches at the registry's severity, and the A1-4.2-01 late-fee exposure is noted for the 6.3 reconciliation. */
export function missedCrsCutoff(i: { payoff_on: PlainDate; instructed_at_ms: number; remittance_cents: Cents; prime_pct: string }): { missed: boolean; instruct_on: PlainDate; settlement_on: PlainDate; expected_settlement_on: PlainDate; days_late: number; cutoff_at_ms: number; breach: { timer: typeof AA_IMMEDIATE; severity: "sev1" | "sev2" | "sev3" | "sev4" } | null; late_fee_exposure: { cite: "A1-4.2-01"; fee_cents: Cents; logged_for: "6.3"; account: "comp_fee_exposure" } | null } {
  const b = crsBatch({ lender_id: "", instructed_at_ms: i.instructed_at_ms, settlements: [] });
  const expected = nextBusinessDay(i.payoff_on, federal);
  const daysLate = Math.max(0, Math.round((Date.parse(b.settlement_on) - Date.parse(expected)) / 86_400_000));
  const cutoff = zonedEpochMs(i.payoff_on, "16:00", ET);
  const missed = i.instructed_at_ms > cutoff;
  return { missed, instruct_on: b.batch_on, settlement_on: b.settlement_on, expected_settlement_on: expected, days_late: daysLate, cutoff_at_ms: cutoff, breach: missed ? { timer: AA_IMMEDIATE, severity: severityOf(AA_IMMEDIATE) } : null, late_fee_exposure: missed ? { cite: "A1-4.2-01", fee_cents: compensatoryFee(i.remittance_cents, Math.max(1, daysLate), i.prime_pct), logged_for: "6.3", account: "comp_fee_exposure" } : null };
}

// ───── rule 6: reversal (returned item / wire recall) ─────
export type ReversalCause = "returned_item" | "wire_recall";
export interface ReversalTask { readonly task: HousekeepingTask; readonly status: string; }
export const TASK_REVERSAL: Partial<Record<HousekeepingTask, string>> = { escrow_refund: "refund_stop_pay", short_year_statement: "statement_withdrawn", mi_notify: "mi_reinstatement_request", insurance_interest_remove: "tracker_re_add", lpi_cancel: "lpi_reinstate", tax_authority_notify: "tax_authority_re_notify", tax_service_delete: "tax_service_re_add", credit_report_paid: "metro2_correction", form_1098_tag: "tag_removed", autodraft_stop: "enrollment_not_restored", fnma_advance_repay: "special_remittance_cancelled", buydown_apply: "buydown_reinstated", paid_in_full_letter: "correction_letter", records_retention_start: "retention_clock_reset", enote_paper_copy: "cancelled", custody_docs_request: "custody_request_cancelled" };
export function reversePayoff(i: { payoff_on: PlainDate; returned_at_ms: number; finality_at_ms: number; cause: ReversalCause; tasks: readonly ReversalTask[]; refund_disbursement_id?: string | null; fnma_share_cents: Cents; sending_bank_indemnity?: boolean; officer_approved?: boolean }): {
  branch: "reversed_pre_close" | "reversed_post_close"; returned_on: PlainDate; correcting_removal_event: { action_code: "60"; correction: true; effective: PlainDate; due_at_ms: number } | null; ledger_reopen_as_of: PlainDate | null; refund_stop_pay: boolean; task_reversals: { task: HousekeepingTask; action: string }[];
  fnma_liquidated_in_error: boolean; amount_due_to_fnma_cents: Cents; funds_returnable: boolean; loan_status: "active" | "paid_in_full_in_error"; escalations: Escalation[];
} {
  const returnedOn = wallClock(i.returned_at_ms, ET).date; const after = i.returned_at_ms > i.finality_at_ms;
  const esc: Escalation[] = [];
  if (i.cause === "wire_recall") esc.push({ kind: "fraud_officer", owner_role: "security-records", severity: "sev1", reason: `wire recall/fraud signal on the payoff wire returned ${returnedOn}` });
  const returnable = i.cause !== "wire_recall" || (i.sending_bank_indemnity === true && i.officer_approved === true);
  if (i.cause === "wire_recall" && !returnable) esc.push({ kind: "officer", owner_role: "officer", severity: null, reason: "wire recall response: funds are not returned without the sending bank's indemnity and officer approval" });
  if (after) {
    esc.push({ kind: "officer", owner_role: "officer", severity: null, reason: `fnma_liquidated_in_error: return ${returnedOn} after period close ${toIso(i.finality_at_ms)} — the amount due to Fannie Mae (${i.fnma_share_cents}) has been or will be remitted; officer decides funding (5.3 open question 2); borrower servicing continues` });
    return { branch: "reversed_post_close", returned_on: returnedOn, correcting_removal_event: null, ledger_reopen_as_of: null, refund_stop_pay: false, task_reversals: [], fnma_liquidated_in_error: true, amount_due_to_fnma_cents: i.fnma_share_cents, funds_returnable: returnable, loan_status: "paid_in_full_in_error", escalations: esc };
  }
  const reversals = i.tasks.filter((t) => t.status !== "cancelled").map((t) => ({ task: t.task, action: TASK_REVERSAL[t.task] ?? "cancelled" }));
  return { branch: "reversed_pre_close", returned_on: returnedOn, correcting_removal_event: { action_code: "60", correction: true, effective: i.payoff_on, due_at_ms: i.finality_at_ms }, ledger_reopen_as_of: i.payoff_on, refund_stop_pay: !!i.refund_disbursement_id, task_reversals: reversals, fnma_liquidated_in_error: false, amount_due_to_fnma_cents: 0n, funds_returnable: returnable, loan_status: "active", escalations: esc };
}

// ───── LAR 60 removal (IRM §2-04): principal includes NIB before the participation percentage; local validation blocks a submission that omits NIB ─────
export function lar60Removal(i: { upb_cents: Cents; nib_cents: Cents | null | undefined; interest_cents: Cents; participation_pct?: string }): { action_code: "60"; principal_cents: Cents; interest_cents: Cents; principal_field: string; interest_field: string } {
  if (i.nib_cents === null || i.nib_cents === undefined) throw new RangeError("NIB omitted: the LAR 60 principal must include the non-interest-bearing balance before the participation percentage (IRM §2-04) — local validation blocks submission");
  const p = i.participation_pct ?? "100";
  const principal = partOf(i.upb_cents + i.nib_cents, p), int = partOf(i.interest_cents, p);
  return { action_code: "60", principal_cents: principal, interest_cents: int, principal_field: zoned(principal), interest_field: zoned(int) };
}

// ───── rule 9 autodraft stop (T0, through 2.3's enrollment machine) and rule 10 post-payoff receipt ─────
const PAYOFF_AGENT = { kind: "agent" as const, id: "payoff-release" };
export function autodraftStop(i: { payoff_on: PlainDate; next_draft_on: PlainDate | null; enrollment_status: string; file_transmitted_on?: PlainDate | null }): { terminate_on: PlainDate; status: EnrollmentStatus; termination_reason: "payoff"; next_draft_on: null; stop_entry: boolean; debit_risk: boolean; transition: ReturnType<typeof enrollmentMachine.attempt>; timer: "SM_PAYOFF_AUTODRAFT_STOP_T0" } {
  const transition = enrollmentMachine.attempt(i.enrollment_status as EnrollmentStatus, "terminate", PAYOFF_AGENT, {});
  const transmitted = i.file_transmitted_on !== undefined && i.file_transmitted_on !== null && i.file_transmitted_on <= i.payoff_on;
  return { terminate_on: i.payoff_on, status: transition.ok ? transition.to : (i.enrollment_status as EnrollmentStatus), termination_reason: "payoff", next_draft_on: null, stop_entry: !transmitted, debit_risk: transmitted && i.next_draft_on !== null && i.next_draft_on > i.payoff_on, transition, timer: "SM_PAYOFF_AUTODRAFT_STOP_T0" };
}
export function postPayoffReceipt(i: { received_on: PlainDate; amount_cents: Cents; remitter: string; source: "autodraft" | "duplicate_wire" | "borrower_check" | "closing_agent" }): { suspense_reason: "post_payoff_receipt"; refund_to: string; refund_by: PlainDate; refund_cents: Cents; applied_to_fees: false; timer: "SM_OVERPAYMENT_REFUND_10BD" } {
  if (i.amount_cents <= 0n) throw new RangeError("a post-payoff receipt must be a positive amount");
  return { suspense_reason: "post_payoff_receipt", refund_to: i.remitter, refund_by: addBusinessDays(i.received_on, 10, servicer), refund_cents: i.amount_cents, applied_to_fees: false, timer: "SM_OVERPAYMENT_REFUND_10BD" };
}
/** Servicer business days from receipt (exclusive) to the refund's issue date (inclusive) — the figure the overage advice states. */
export function businessDaysAfter(from: PlainDate, to: PlainDate): number { let d = from, n = 0; while (d < to) { d = addBusinessDays(d, 1, servicer); n++; } return n; }
/** Rule 2 / rule 10: an overage or post-payoff receipt is refunded in full to the remitter within 10 BD of receipt, never applied to fees: Dr `suspense/unapplied` / Cr `custodial_ti_cash`. */
export function refundOverage(i: { loan_id: string; custodial_ti: string; received_on: PlainDate; issued_on: PlainDate; amount_cents: Cents }): { refund_cents: Cents; refund_by: PlainDate; on_time: boolean; bd_after_receipt: number; applied_to_fees_cents: 0n; entry_set: EntrySetInput } {
  if (i.amount_cents <= 0n) throw new RangeError("nothing to refund");
  const by = addBusinessDays(i.received_on, 10, servicer);
  return { refund_cents: i.amount_cents, refund_by: by, on_time: i.issued_on <= by, bd_after_receipt: businessDaysAfter(i.received_on, i.issued_on), applied_to_fees_cents: 0n,
    entry_set: { effectiveDate: i.issued_on, description: `payoff overage refund ${i.loan_id}`, lines: [{ account: loanAcct(i.loan_id, "suspense_unapplied"), amountCents: i.amount_cents, ruleRef: "16.2.rule10.refund (never applied to fees)" }, { account: custAcct(i.custodial_ti, "custodial_ti_cash"), amountCents: -i.amount_cents, ruleRef: "16.2.rule10.refund" }] } };
}

// ───── rule 5 / §1024.35(b)(6): NoE alleging the statement understated the balance ─────
export function statementShortageNoe(i: { noe_received_on: PlainDate; statement_hash: string; statement_total_cents: Cents; exact_total_cents: Cents; amount_cents: Cents; case_id?: string; loan_id?: string }): { assertion: "b6"; clocks: NoeDeadlines; noe: NoeOpenedPayload; shortage_cents: Cents; shortage_disposition: "servicer_absorbed"; demand: false; expense_account: "payoff_shortfall_expense"; officer_approval_required: boolean; response: { cites_statement_hash: true; statement_hash: string; text: string } } {
  if (!i.statement_hash.trim()) throw new RangeError("the payoff statement's content hash is required: the response cites it");
  const shortage = i.exact_total_cents - i.amount_cents > 0n ? i.exact_total_cents - i.amount_cents : 0n;
  const caseId = i.case_id ?? `noe-${i.loan_id ?? "loan"}-${i.noe_received_on}`;
  // the 4.1 record (`case.noe.opened` payload) with the b6 qualifiers its clocks arm on: ack 5 BD (§1024.35(d)), payoff response 7 BD (§1024.35(e)(3)(i)(A)), credit suppression 60 CD (§1024.35(i))
  const noe = noeOpenedPayload({ case_id: caseId, loan_id: i.loan_id ?? "", receipt_date: i.noe_received_on, assertions: [{ id: "1", category: "b6", description: `payoff statement ${i.statement_hash} understated the balance by ${shortage} cents` }] });
  return { assertion: "b6", clocks: noeDeadlines("b6", i.noe_received_on), noe, shortage_cents: shortage, shortage_disposition: "servicer_absorbed", demand: false, expense_account: "payoff_shortfall_expense", officer_approval_required: shortage > AGENT_ABSORB_LIMIT_CENTS,
    response: { cites_statement_hash: true, statement_hash: i.statement_hash, text: `Our payoff statement (content hash ${i.statement_hash}) stated ${i.statement_total_cents} cents; the amount required as of the payoff date was ${i.exact_total_cents} cents. The ${shortage}-cent difference was absorbed by the servicer and your loan is paid in full.` } };
}

// ───── worked example: S/A half month vs collected PTR-equivalent ─────
export function saInterestDeficit(f: { upb_cents: Cents; note_rate_pct: string; ptr_pct: string; lpi_due: PlainDate; payoff_on: PlainDate }): { fnma_half_month_cents: Cents; collected_ptr_equivalent_cents: Cents; deficit_cents: Cents; servicer_funds: boolean } {
  const half = fnmaShare({ type: "SA", upb_cents: f.upb_cents, nib_cents: 0n, note_rate_pct: f.note_rate_pct, ptr_pct: f.ptr_pct, lpi_due: f.lpi_due, payoff_on: f.payoff_on }).interest_cents;
  const collectedPtr = interest(f.upb_cents, f.ptr_pct, f.lpi_due, f.payoff_on).partial_cents;
  const d = half - collectedPtr;
  return { fnma_half_month_cents: half, collected_ptr_equivalent_cents: collectedPtr, deficit_cents: d > 0n ? d : 0n, servicer_funds: d > 0n };
}
/** Exact figure at receipt (rule 2): the 16.1 quote recomputed as of the payoff date. */
export function exactFigure(c: Components, payoffOn: PlainDate): ReturnType<typeof quote> { return quote({ ...c, good_through: payoffOn }); }

// ───── rule 9: escrow refund (3.5; after the 5-BD in-flight hold, never beyond 20 BD) and the short-year statement (3.3) ─────
export function escrowRefund(i: { loan_id: string; custodial_ti: string; payoff_on: PlainDate; escrow_balance_cents: Cents; in_flight_disbursement_cents?: Cents }): { refund_cents: Cents; hold_until: PlainDate; issue_on: PlainDate; due_by: PlainDate; short_year_statement_by: PlainDate; timer: "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD"; entry_set: EntrySetInput | null } {
  const refund = i.escrow_balance_cents - (i.in_flight_disbursement_cents ?? 0n);
  const holdUntil = addBusinessDays(i.payoff_on, 5, servicer); const issueOn = nextBusinessDay(holdUntil, servicer); const dueBy = addBusinessDays(i.payoff_on, 20, federal);
  return { refund_cents: refund > 0n ? refund : 0n, hold_until: holdUntil, issue_on: issueOn <= dueBy ? issueOn : dueBy, due_by: dueBy, short_year_statement_by: addDays(i.payoff_on, 60), timer: "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD",
    entry_set: refund > 0n ? { effectiveDate: issueOn <= dueBy ? issueOn : dueBy, description: `payoff escrow refund ${i.loan_id}`, lines: [{ account: loanAcct(i.loan_id, "escrow"), amountCents: refund, ruleRef: "16.2.rule9.escrow_refund (12 CFR 1024.34(b)(1))" }, { account: custAcct(i.custodial_ti, "custodial_ti_cash"), amountCents: -refund, ruleRef: "16.2.rule9.escrow_refund (12 CFR 1024.34(b)(1))" }] } : null };
}

// ───── rule 9 housekeeping fan-out ─────
export type HousekeepingTask = "escrow_refund" | "short_year_statement" | "mi_notify" | "insurance_interest_remove" | "lpi_cancel" | "tax_authority_notify" | "tax_service_delete" | "credit_report_paid" | "form_1098_tag" | "autodraft_stop" | "fnma_advance_repay" | "buydown_apply" | "paid_in_full_letter" | "records_retention_start" | "enote_paper_copy" | "custody_docs_request";
export interface HousekeepingRow { readonly task: HousekeepingTask; readonly owner_agent: string; readonly timer_code: string | null; readonly due_on: PlainDate | null; readonly status: "open"; }
export function housekeepingTasks(i: { payoff_on: PlainDate; escrowed: boolean; mi_active: boolean; autodraft: boolean; fnma_advance_repay_cents: Cents; buydown_remit_cents: Cents; enote: boolean; lpi_active?: boolean; tax_service?: boolean }): HousekeepingRow[] {
  const p = i.payoff_on; const bd = (n: number) => addBusinessDays(p, n, servicer);
  const rows: HousekeepingRow[] = [];
  if (i.escrowed) rows.push({ task: "escrow_refund", owner_agent: "escrow", timer_code: "REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", due_on: addBusinessDays(p, 20, federal), status: "open" });
  if (i.escrowed) rows.push({ task: "short_year_statement", owner_agent: "escrow", timer_code: "REGX_1024_17I4_SHORT_YEAR_PAYOFF_60", due_on: addDays(p, 60), status: "open" });
  if (i.mi_active) rows.push({ task: "mi_notify", owner_agent: "mi", timer_code: "SM_PAYOFF_MI_NOTIFY_2BD", due_on: bd(2), status: "open" });
  rows.push({ task: "insurance_interest_remove", owner_agent: "insurance", timer_code: "SM_PAYOFF_INSURANCE_INTEREST_REMOVE_5BD", due_on: bd(5), status: "open" });
  if (i.lpi_active) rows.push({ task: "lpi_cancel", owner_agent: "insurance", timer_code: "SM_PAYOFF_INSURANCE_INTEREST_REMOVE_5BD", due_on: bd(5), status: "open" });
  if (i.escrowed || i.tax_service) { rows.push({ task: "tax_authority_notify", owner_agent: "escrow", timer_code: "SM_PAYOFF_TAX_AUTHORITY_NOTIFY_5BD", due_on: bd(5), status: "open" }); rows.push({ task: "tax_service_delete", owner_agent: "escrow", timer_code: "SM_PAYOFF_TAX_AUTHORITY_NOTIFY_5BD", due_on: bd(5), status: "open" }); }
  rows.push({ task: "credit_report_paid", owner_agent: "credit-reporting", timer_code: "SM_PAYOFF_CREDIT_REPORT_NEXT_CYCLE", due_on: null, status: "open" });
  rows.push({ task: "form_1098_tag", owner_agent: "escrow", timer_code: null, due_on: null, status: "open" });
  if (i.autodraft) rows.push({ task: "autodraft_stop", owner_agent: "cashiering", timer_code: "SM_PAYOFF_AUTODRAFT_STOP_T0", due_on: p, status: "open" });
  if (i.fnma_advance_repay_cents > 0n) rows.push({ task: "fnma_advance_repay", owner_agent: "investor-reporting", timer_code: "FNMA_F109_ADVANCE_REPAY_30", due_on: addDays(p, 30), status: "open" });
  if (i.buydown_remit_cents > 0n) rows.push({ task: "buydown_apply", owner_agent: "investor-reporting", timer_code: null, due_on: p, status: "open" });
  rows.push({ task: "paid_in_full_letter", owner_agent: "payoff-release", timer_code: "SM_PAYOFF_PIF_LETTER_5BD", due_on: bd(5), status: "open" });
  rows.push({ task: "records_retention_start", owner_agent: "security-records", timer_code: null, due_on: p, status: "open" });
  if (i.enote) rows.push({ task: "enote_paper_copy", owner_agent: "payoff-release", timer_code: null, due_on: null, status: "open" });
  rows.push({ task: "custody_docs_request", owner_agent: "payoff-release", timer_code: null, due_on: bd(1), status: "open" });
  return rows;
}
export { OVER_TOLERANCE_CENTS, SHORT_TOLERANCE_CENTS };
