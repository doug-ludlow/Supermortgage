/**
 * Activity periods and the Fannie Mae reporting calendar (5.1 rules 2, 4 and
 * the timer rows): BD2 17:00 ET close, CD22 IRED sweep, next-BD 20:00 ET
 * non-removal deadline, BD2 17:00 ET removal deadline, LAR 83 BD5.
 */
import { type PlainDate, parts, ymd, addMonths, daysInMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, nextBusinessDay, rollBack, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";

const ET = "America/New_York";
export const period = (d: PlainDate): string => d.slice(0, 7);
export function firstOfMonth(d: PlainDate): PlainDate { const { y, m } = parts(d); return ymd(y, m, 1); }
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
/** Calendar-day draft date rolled back to the preceding Fannie BD (CD18 S/S, CD20 S/A, CD7 g-fee). */
export function calendarDraftDate(monthOf: PlainDate, cd: number): PlainDate { const { y, m } = parts(monthOf); return rollBack(ymd(y, m, cd), fannieEt); }
export function nextMonth(d: PlainDate): PlainDate { return firstOfMonth(addMonths(d, 1)); }
/** Funding gate: T−1 16:00 ET before a draft. */
export function fundingGateMs(draftDate: PlainDate): number { return zonedEpochMs(addBusinessDays(draftDate, -1, fannieEt), "16:00", ET); }
