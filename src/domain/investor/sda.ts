/** §5.4 Stop Delinquency Advance and §5.5 Guaranty fee relief — prediction, advance ledger, recovery matching. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addMonths } from "../../kernel/calendar/date.ts";
import { period, nextMonth, calendarDraftDate } from "./period.ts";
import { scheduleForward, gfeeCheckFigure, type ScheduledMonth } from "./remittance.ts";

export type SdaStatus = "not_applicable" | "predicted" | "active" | "exited";
export interface SdaState { status: SdaStatus; predicted_entry_period: string | null; fm_pi_receivable_cents: Cents; servicer_advances_outstanding_cents: Cents; advances: { period: string; amount_cents: Cents; draft_date: PlainDate; status: "outstanding" | "reimbursed_by_fnma" }[]; }

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

/** During SDA a contractual payment's P&I is drafted by Fannie Mae as recovery against fm_pi_receivable first; the servicer then retains against its own advances (FIFO). */
export function applyRecovery(st: SdaState, recoveryCents: Cents): { to_fnma_receivable_cents: Cents; to_servicer_advances_cents: Cents } {
  const a = recoveryCents < st.fm_pi_receivable_cents ? recoveryCents : st.fm_pi_receivable_cents; st.fm_pi_receivable_cents -= a;
  let left = recoveryCents - a; let b = 0n;
  for (const adv of st.advances) { if (left <= 0n) break; if (adv.status === "outstanding") { const take = left < adv.amount_cents ? left : adv.amount_cents; if (take === adv.amount_cents) adv.status = "reimbursed_by_fnma"; left -= take; b += take; } }
  st.servicer_advances_outstanding_cents -= b;
  return { to_fnma_receivable_cents: a, to_servicer_advances_cents: b };
}

/** 5.5: monthly g-fee check figures across the schedule (52.08 / 52.04 / 51.99 / 51.94 in the worked example). */
export function gfeeSchedule(scheduledUpb: Cents, noteRate: string, ptr: string, pi: Cents, gfeePct: string, months: number): Cents[] {
  const sched = scheduleForward(scheduledUpb, noteRate, ptr, pi, months);
  return sched.map((m) => gfeeCheckFigure(m.prior_scheduled_upb_cents, gfeePct));
}
export function gfeeReliefConsistent(sda: SdaStatus, gfee: SdaStatus, option: "special" | "regular"): boolean { return option === "regular" ? true : sda === gfee; }
