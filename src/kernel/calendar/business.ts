/**
 * The spec distinguishes four day-count units and is explicit that they are
 * NOT interchangeable:
 *
 *  - `calendar_days`
 *  - `business_days_federal`   Reg X "days excluding legal public holidays,
 *                              Saturdays, and Sundays"
 *  - `business_days_servicer`  Reg X §1024.31 "a day on which the servicer's
 *                              offices are open to the public for carrying on
 *                              substantially all of its business functions"
 *  - `business_days_fannie_et` Fannie Mae business days, America/New_York
 *
 * Each is a `Calendar`. The servicer calendar is configurable (extra closure
 * days, and whether Saturday counts) because §1024.31 is about *this*
 * servicer's actual hours, not the federal list.
 */
import { type PlainDate, addDays, isWeekend, dayOfWeek } from "./date.ts";
import { isFederalHoliday } from "./holidays.ts";

export type DayUnit = "calendar_days" | "business_days_federal" | "business_days_servicer" | "business_days_fannie_et";
export const DAY_UNITS: readonly DayUnit[] = ["calendar_days", "business_days_federal", "business_days_servicer", "business_days_fannie_et"];

export interface Calendar {
  readonly unit: DayUnit;
  readonly timeZone: string;
  isBusinessDay(date: PlainDate): boolean;
}

export const calendarDays: Calendar = {
  unit: "calendar_days", timeZone: "UTC",
  isBusinessDay: () => true,
};

export const federal: Calendar = {
  unit: "business_days_federal", timeZone: "America/New_York",
  isBusinessDay: (d) => !isWeekend(d) && !isFederalHoliday(d),
};

/** Fannie Mae observes the federal holiday schedule; all cut-offs are Eastern Time. */
export const fannieEt: Calendar = {
  unit: "business_days_fannie_et", timeZone: "America/New_York",
  isBusinessDay: (d) => !isWeekend(d) && !isFederalHoliday(d),
};

export interface ServicerCalendarConfig {
  readonly timeZone?: string;
  /** Days the servicer's public offices are closed beyond weekends + federal holidays. */
  readonly closures?: readonly PlainDate[];
  /** Federal holidays on which the servicer IS open (§1024.31 is about actual hours). */
  readonly openOnHolidays?: readonly PlainDate[];
  readonly saturdayOpen?: boolean;
}

export function servicerCalendar(cfg: ServicerCalendarConfig = {}): Calendar {
  const closures = new Set(cfg.closures ?? []);
  const open = new Set(cfg.openOnHolidays ?? []);
  return {
    unit: "business_days_servicer",
    timeZone: cfg.timeZone ?? "America/New_York",
    isBusinessDay(d) {
      if (closures.has(d)) return false;
      const w = dayOfWeek(d);
      if (w === 0) return false;
      if (w === 6) return cfg.saturdayOpen === true;
      if (open.has(d)) return true;
      return !isFederalHoliday(d);
    },
  };
}

/** Default servicer calendar: Monday–Friday, closed on federal holidays. */
export const servicer: Calendar = servicerCalendar();

export interface CalendarSet {
  readonly calendar_days: Calendar;
  readonly business_days_federal: Calendar;
  readonly business_days_servicer: Calendar;
  readonly business_days_fannie_et: Calendar;
}

export const defaultCalendars: CalendarSet = {
  calendar_days: calendarDays,
  business_days_federal: federal,
  business_days_servicer: servicer,
  business_days_fannie_et: fannieEt,
};

/**
 * Add `n` business days. n=0 returns `date` unchanged even if it is not a
 * business day (callers roll explicitly with `nextBusinessDay`). Negative n
 * walks backwards.
 */
export function addBusinessDays(date: PlainDate, n: number, cal: Calendar): PlainDate {
  if (!Number.isInteger(n)) throw new TypeError("n must be an integer");
  let d = date;
  const step = n < 0 ? -1 : 1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    d = addDays(d, step);
    if (cal.isBusinessDay(d)) remaining--;
  }
  return d;
}

/** The first business day strictly after `date`. */
export function nextBusinessDay(date: PlainDate, cal: Calendar): PlainDate { return addBusinessDays(date, 1, cal); }

/** `date` if it is a business day, else the next one (roll forward). */
export function rollForward(date: PlainDate, cal: Calendar): PlainDate {
  return cal.isBusinessDay(date) ? date : nextBusinessDay(date, cal);
}

/** `date` if it is a business day, else the previous one (roll back). */
export function rollBack(date: PlainDate, cal: Calendar): PlainDate {
  return cal.isBusinessDay(date) ? date : addBusinessDays(date, -1, cal);
}

/** Business days from `a` (exclusive) to `b` (inclusive); negative if b < a. */
export function businessDaysBetween(a: PlainDate, b: PlainDate, cal: Calendar): number {
  if (a === b) return 0;
  const sign = b > a ? 1 : -1;
  let count = 0, d = a;
  while (d !== b) { d = addDays(d, sign); if (cal.isBusinessDay(d)) count++; }
  return count * sign;
}

export function addUnit(date: PlainDate, n: number, unit: DayUnit, cals: CalendarSet = defaultCalendars): PlainDate {
  return unit === "calendar_days" ? addDays(date, n) : addBusinessDays(date, n, cals[unit]);
}
