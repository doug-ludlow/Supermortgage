/**
 * Activity periods and the Fannie Mae reporting calendar (5.1 rules 2, 4 and
 * the timer rows): BD2 17:00 ET close, CD22 IRED sweep, next-BD 20:00 ET
 * non-removal deadline, BD2 17:00 ET removal deadline, LAR 83 BD5, the BD1/BD2
 * correction windows, and the anchor dates the period-driven §5 timers resolve
 * against (`periodAnchors`).
 */
import { type PlainDate, parts, ymd, addMonths, addDays, daysInMonth, endOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, nextBusinessDay, rollBack, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";

const ET = "America/New_York";
export const period = (d: PlainDate): string => d.slice(0, 7);
export function firstOfMonth(d: PlainDate): PlainDate { const { y, m } = parts(d); return ymd(y, m, 1); }
/** Last calendar day of the month containing `d` — the "period end" the correction and LAR 89 clocks anchor on. */
export function periodEndOf(d: PlainDate): PlainDate { return endOfMonth(d); }
/** First calendar day of an activity period given as YYYY-MM. */
export function periodStart(activityPeriod: string): PlainDate { const [y, m] = activityPeriod.split("-").map(Number) as [number, number]; return ymd(y, m, 1); }
/** BD n of the month containing `d` (Fannie Mae ET calendar). */
export function fannieBusinessDay(d: PlainDate, n: number): PlainDate { return addBusinessDays(firstOfMonth(d), n, fannieEt) === firstOfMonth(d) ? firstOfMonth(d) : (fannieEt.isBusinessDay(firstOfMonth(d)) ? addBusinessDays(firstOfMonth(d), n - 1, fannieEt) : addBusinessDays(firstOfMonth(d), n, fannieEt)); }
export function bd2CloseMs(monthOf: PlainDate): number { return zonedEpochMs(fannieBusinessDay(monthOf, 2), "17:00", ET); }

/** 5.1 rule 2. */
export function assignActivityPeriod(effective: PlainDate, processedAtMs: number, isRemoval: boolean, openPeriods: readonly string[]): string {
  const processedDate = wallClock(processedAtMs, ET).date;
  const current = period(processedDate);
  const earliestOpen = [...openPeriods].sort()[0] ?? current;
  if (processedAtMs > bd2CloseMs(processedDate)) return current;
  if (effective < firstOfMonth(processedDate)) return earliestOpen;
  return isRemoval ? earliestOpen : current;
}

/** Non-removal LAR: next Fannie Mae BD 20:00 ET. Removal: BD2 17:00 ET when processed on BD1, else next BD 20:00 ET. */
export function larDeadlineMs(processedAtMs: number, isRemoval: boolean): number {
  const d = wallClock(processedAtMs, ET).date;
  if (isRemoval && d === fannieBusinessDay(d, 1)) return zonedEpochMs(fannieBusinessDay(d, 2), "17:00", ET);
  return zonedEpochMs(nextBusinessDay(d, fannieEt), "20:00", ET);
}
/** LL-2026-05 servicing events: next Fannie BD 03:00 ET. */
export function eventDeadlineMs(processedAtMs: number): number { return zonedEpochMs(nextBusinessDay(wallClock(processedAtMs, ET).date, fannieEt), "03:00", ET); }
/** LAR 83 rate/payment change: 5th Fannie BD after the calculation date, 20:00 ET (5.1-T9). */
export function lar83DeadlineMs(calcDate: PlainDate): number { return zonedEpochMs(addBusinessDays(calcDate, 5, fannieEt), "20:00", ET); }
/** IRED sweep: CD22 or the preceding business day, run 18:00 ET (5.1 rule 4). */
export function iredSweepDate(monthOf: PlainDate): PlainDate { const { y, m } = parts(monthOf); return rollBack(ymd(y, m, Math.min(22, daysInMonth(y, m))), fannieEt); }
export function iredSweepRunMs(monthOf: PlainDate): number { return zonedEpochMs(iredSweepDate(monthOf), "18:00", ET); }
/** IRED deadline: CD22 (preceding BD) 20:00 ET — the LAR floor "regardless of whether a payment was received". */
export function iredDeadlineMs(monthOf: PlainDate): number { return zonedEpochMs(iredSweepDate(monthOf), "20:00", ET); }
/** Calendar-day draft date rolled back to the preceding Fannie BD (CD18 S/S, CD20 S/A, CD7 g-fee). */
export function calendarDraftDate(monthOf: PlainDate, cd: number): PlainDate { const { y, m } = parts(monthOf); return rollBack(ymd(y, m, cd), fannieEt); }
export function nextMonth(d: PlainDate): PlainDate { return firstOfMonth(addMonths(d, 1)); }
/** Funding gate: T−1 16:00 ET before a draft. */
export function fundingGateMs(draftDate: PlainDate): number { return zonedEpochMs(addBusinessDays(draftDate, -1, fannieEt), "16:00", ET); }

/** Removal corrections close BD2 17:00 ET of the month following the activity period (IRM 4-08; `FNMA_IRM_REMOVAL_CORRECTION_BD2_1700`). */
export function removalCorrectionCloseMs(activityPeriod: string): number { return bd2CloseMs(nextMonth(periodStart(activityPeriod))); }
/** Non-removal corrections close BD1 20:00 ET of the following month (C-4.3-01; `FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000`). */
export function nonRemovalCorrectionCloseMs(activityPeriod: string): number { return zonedEpochMs(fannieBusinessDay(nextMonth(periodStart(activityPeriod)), 1), "20:00", ET); }
/** LAR 89 is due by the last reporting day of the period containing the MI termination's effective date = BD2 17:00 ET of the following month. */
export function lar89DueMs(effective: PlainDate): number { return bd2CloseMs(nextMonth(effective)); }
/** TT 32 is due ≥15 calendar days before the transfer effective date (IRM p. 28; `FNMA_IRM_TT32_15CD`). */
export function tt32DueOn(transferEffective: PlainDate): PlainDate { return addDays(transferEffective, -15); }
/** IRM 4-01: the pre-deferral contractual-payment LAR must be accepted at least one Fannie BD before the end of the processing month. */
export function deferralLarDeadlineOn(processedOn: PlainDate): PlainDate { return addBusinessDays(periodEndOf(processedOn), -1, fannieEt); }
/** 5.2 rule 9 / IRM: a surplus unreconciled 90 calendar days after it first appears may be zeroed by Fannie Mae (`FNMA_IRM_SURPLUS_RESOLVE_90`). */
export function surplusResolveDueOn(firstSeen: PlainDate): PlainDate { return addDays(firstSeen, 90); }
/** F-1-20: A/A collections on the last work day not remitted → CRS request on BD1 of the following month by 16:00 ET. */
export function bd1CatchUpMs(monthOf: PlainDate): number { return zonedEpochMs(fannieBusinessDay(nextMonth(monthOf), 1), "16:00", ET); }
/** Bulk B2B/LSDU upload cutoff: BD2 15:00 ET of the month following the activity period. */
export function bulkCutoffMs(activityPeriod: string): number { return zonedEpochMs(fannieBusinessDay(nextMonth(periodStart(activityPeriod)), 2), "15:00", ET); }

export interface PeriodAnchors {
  readonly period: string; readonly period_start: PlainDate; readonly period_end: PlainDate;
  /** BD1 / BD2 of the following month (the correction close and the period close). */
  readonly bd1_following: PlainDate; readonly bd2_following: PlainDate; readonly close_at: string; readonly bulk_cutoff_at: string;
  /** IRED: CD22 of the period month, preceding BD. */
  readonly ired_on: PlainDate; readonly ired_at: string;
  /** Draft dates of the remittance cycle that settles this period's activity (the following month), each rolled back to the preceding Fannie BD. */
  readonly ss_draft_on: PlainDate; readonly sa_draft_on: PlainDate; readonly gfee_draft_on: PlainDate; readonly pool_draft_on: PlainDate; readonly mbsx_bd4_on: PlainDate; readonly gfee_bill_due_on: PlainDate;
  readonly following_month_start: PlainDate;
}
/**
 * The payload of `investor_reporting_periods.opened` (and `.closed`): every date a period-driven §5 timer anchors on,
 * computed once from the period month so the registry rows resolve mechanically (`anchorField` + a grammar offset).
 */
export function periodAnchors(monthOf: PlainDate): PeriodAnchors {
  const start = firstOfMonth(monthOf); const end = periodEndOf(start); const next = nextMonth(start);
  const bd1 = fannieBusinessDay(next, 1), bd2 = fannieBusinessDay(next, 2);
  return {
    period: period(start), period_start: start, period_end: end, bd1_following: bd1, bd2_following: bd2,
    close_at: new Date(zonedEpochMs(bd2, "17:00", ET)).toISOString(), bulk_cutoff_at: new Date(zonedEpochMs(bd2, "15:00", ET)).toISOString(),
    ired_on: iredSweepDate(start), ired_at: new Date(iredDeadlineMs(start)).toISOString(),
    ss_draft_on: calendarDraftDate(next, 18), sa_draft_on: calendarDraftDate(next, 20), gfee_draft_on: calendarDraftDate(next, 7), pool_draft_on: calendarDraftDate(next, 6), mbsx_bd4_on: fannieBusinessDay(next, 4), gfee_bill_due_on: calendarDraftDate(next, 5),
    following_month_start: next,
  };
}
