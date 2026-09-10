/** §5.4 Stop Delinquency Advance and §5.5 Guaranty fee relief — prediction, advance ledger, recovery matching. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addMonths } from "../../kernel/calendar/date.ts";
import { period, nextMonth, calendarDraftDate } from "./period.ts";
import { scheduleForward, gfeeCheckFigure, type ScheduledMonth } from "./remittance.ts";

export type SdaStatus = "not_applicable" | "predicted" | "active" | "exited";
/** 5.4 data model `advances.status`. */
export type AdvanceStatus = "outstanding" | "recovered_from_borrower" | "reimbursed_by_fnma" | "written_off";
export interface SdaState { status: SdaStatus; predicted_entry_period: string | null; fm_pi_receivable_cents: Cents; servicer_advances_outstanding_cents: Cents; advances: { period: string; amount_cents: Cents; draft_date: PlainDate; status: AdvanceStatus }[]; }

/** Consecutive unpaid installments at period end from LPI (5.4 rule 2). */
export function consecutiveMonthsDelinquent(lpi: PlainDate, periodEnd: PlainDate): number { let n = 0; let d = addMonths(lpi, 1); while (d <= periodEnd) { n++; d = addMonths(d, 1); } return n; }

export function sdaApplies(type: "AA" | "SA" | "SS", servicingOption: "special" | "regular"): boolean { return type === "SS" && servicingOption === "special"; }

/** Predict entry: the period in which the loan is four consecutive months delinquent at period end. */
export function predictSda(lpi: PlainDate, type: "AA" | "SA" | "SS", option: "special" | "regular", asOfPeriodEnd: PlainDate): SdaState {
  const st: SdaState = { status: "not_applicable", predicted_entry_period: null, fm_pi_receivable_cents: 0n, servicer_advances_outstanding_cents: 0n, advances: [] };
  if (!sdaApplies(type, option)) return st;
  if (consecutiveMonthsDelinquent(lpi, asOfPeriodEnd) >= 4) { st.status = "predicted"; st.predicted_entry_period = period(asOfPeriodEnd); }
  return st;
}

/** Advance schedule: activity periods 1–4 delinquent are drafted (CD18, rolled back) and funded by corporate advances. */
export function advanceSchedule(lpi: PlainDate, scheduledUpb: Cents, noteRate: string, ptr: string, pi: Cents): { months: ScheduledMonth[]; drafts: { period: string; draft_date: PlainDate; amount_cents: Cents }[]; total_cents: Cents } {
  const months = scheduleForward(scheduledUpb, noteRate, ptr, pi, 4);
  const drafts = months.map((m, i) => { const activity = addMonths(lpi, i + 1); return { period: period(activity), draft_date: calendarDraftDate(nextMonth(activity), 18), amount_cents: m.fnma_interest_cents + m.fnma_principal_cents }; });
  return { months, drafts, total_cents: drafts.reduce((s, d) => s + d.amount_cents, 0n) };
}

/** 5.4 rule 3–4: while Stop Advance is set Fannie Mae's receivable grows by the scheduled P&I of each period it credits; a contractual payment's recovery draft equals the receivable for the periods it clears. */
export function fmReceivableForPeriods(months: readonly ScheduledMonth[]): Cents { return months.reduce((s, m) => s + m.fnma_interest_cents + m.fnma_principal_cents, 0n); }
/** Only full contractual payments count during SDA (partials sit in suspense): n × P&I. */
export function contractualPaymentsTotal(piCents: Cents, count: number): Cents { return piCents * BigInt(count); }
/** 5.4-T1: the funding gate excludes the loan from the first CD18 draft after Fannie Mae's report shows `active`. */
export function firstExcludedDraft(fnmaActiveReportedOn: PlainDate): PlainDate { const cd18 = calendarDraftDate(fnmaActiveReportedOn, 18); return cd18 > fnmaActiveReportedOn ? cd18 : calendarDraftDate(nextMonth(fnmaActiveReportedOn), 18); }
/** 5.4-T1 boundary: if Fannie Mae credits an earlier draft than the four-advance model predicts, flag the boundary and reverse that period's advance. */
export function sdaBoundaryReconciliation(f: { predicted_first_excluded_draft: PlainDate; fnma_credited_draft: PlainDate; advances: readonly { period: string; draft_date: PlainDate }[] }): { boundary_flagged: boolean; reverse_advance_period: string | null } {
  if (f.fnma_credited_draft >= f.predicted_first_excluded_draft) return { boundary_flagged: false, reverse_advance_period: null };
  const hit = f.advances.find((a) => a.draft_date === f.fnma_credited_draft);
  return { boundary_flagged: true, reverse_advance_period: hit?.period ?? null };
}

/**
 * F-1-20: a contractual payment collected during SDA is drafted by Fannie Mae first to recover its own advances (`fm_pi_receivable`);
 * once that is zero the servicer retains subsequent payments to recover its delinquency advances, FIFO by period — those rows move
 * to `recovered_from_borrower` (5.4 data model), never `reimbursed_by_fnma`, which is the reclass/deferral/liquidation exit path.
 */
export function applyRecovery(st: SdaState, recoveryCents: Cents): { to_fnma_receivable_cents: Cents; to_servicer_advances_cents: Cents } {
  const a = recoveryCents < st.fm_pi_receivable_cents ? recoveryCents : st.fm_pi_receivable_cents; st.fm_pi_receivable_cents -= a;
  let left = recoveryCents - a; let b = 0n;
  for (const adv of st.advances) { if (left <= 0n) break; if (adv.status === "outstanding") { const take = left < adv.amount_cents ? left : adv.amount_cents; if (take === adv.amount_cents) adv.status = "recovered_from_borrower"; left -= take; b += take; } }
  st.servicer_advances_outstanding_cents -= b;
  return { to_fnma_receivable_cents: a, to_servicer_advances_cents: b };
}

/** 5.5: monthly g-fee check figures across the schedule (52.08 / 52.04 / 51.99 / 51.94 in the worked example). */
export function gfeeSchedule(scheduledUpb: Cents, noteRate: string, ptr: string, pi: Cents, gfeePct: string, months: number): Cents[] {
  const sched = scheduleForward(scheduledUpb, noteRate, ptr, pi, months);
  return sched.map((m) => gfeeCheckFigure(m.prior_scheduled_upb_cents, gfeePct));
}
export function gfeeReliefConsistent(sda: SdaStatus, gfee: SdaStatus, option: "special" | "regular"): boolean { return option === "regular" ? true : sda === gfee; }
