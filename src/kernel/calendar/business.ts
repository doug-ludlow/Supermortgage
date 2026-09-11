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
 * The origination baseline addendum (spec/origination/01-architecture-baseline-addendum.md §4) adds two
 * Reg Z definitions that are likewise not interchangeable with the four above:
 *
 *  - `business_days_creditor`      Reg Z §1026.2(a)(6) first sentence: a day on which the creditor's offices are
 *                                  open to the public for carrying on substantially all of its business functions
 *                                  (decision: Mon–Fri excluding federal holidays plus any published closures)
 *  - `business_days_regz_specific` Reg Z §1026.2(a)(6) second sentence: all calendar days except Sundays and the
 *                                  federal legal public holidays — the LE 7-day, CD 3-day, revised-LE 4-day and
 *                                  rescission clocks ("SBD" in timer codes)
 *
 * Each is a `Calendar`. The servicer calendar is configurable (extra closure
 * days, and whether Saturday counts) because §1024.31 is about *this*
 * servicer's actual hours, not the federal list.
 */
import { type PlainDate, addDays, isWeekend, dayOfWeek } from "./date.ts";
import { isFederalHoliday } from "./holidays.ts";

export type DayUnit = "calendar_days" | "business_days_federal" | "business_days_servicer" | "business_days_fannie_et" | "business_days_creditor" | "business_days_regz_specific";
export const DAY_UNITS: readonly DayUnit[] = ["calendar_days", "business_days_federal", "business_days_servicer", "business_days_fannie_et", "business_days_creditor", "business_days_regz_specific"];

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
/**
 * Fannie Mae-only closures the spec cites (§5.1 "Holiday ambiguity": "Fannie Mae-only holidays (e.g., day
 * after Thanksgiving) shift reporting deadlines but not necessarily Federal Reserve draft settlement —
 * calendar table carries both flags"; §5.2 worked example 5 and §5.3-T8 name Nov 26–27, 2026). The list is
 * per published year: the spec's §1.1-T7, §19.1-T6 and §19.3 examples count Fri Nov 27, 2026 as a Fannie
 * business day on the reporting clocks, and §15.1-T2/§15.3 count Fri Nov 26, 2027 as one, so only the
 * P360/REOgram confirmation clock (§5.3-T8) resolves against this observed calendar; every other
 * `fannie_et` timer uses `fannieEt` above. Flagged in docs/audit as a spec inconsistency to settle at onboarding.
 */
export const FNMA_PUBLISHED_CLOSURES: readonly PlainDate[] = ["2026-11-27" as PlainDate];
export function fannieMaeObservedCalendar(closures: readonly PlainDate[] = FNMA_PUBLISHED_CLOSURES): Calendar {
  const closed = new Set(closures);
  return { unit: "business_days_fannie_et", timeZone: "America/New_York", isBusinessDay: (d) => fannieEt.isBusinessDay(d) && !closed.has(d) };
}
export const fannieEtObserved: Calendar = fannieMaeObservedCalendar();

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

export interface CreditorCalendarConfig {
  readonly timeZone?: string;
  /** Published closures of the partner/SM origination office beyond weekends + federal holidays. */
  readonly closures?: readonly PlainDate[];
}
/** Reg Z §1026.2(a)(6) general definition — the creditor's own office days (addendum §4 decision: Mon–Fri, federal holidays and published closures off). */
export function creditorCalendar(cfg: CreditorCalendarConfig = {}): Calendar {
  const closures = new Set(cfg.closures ?? []);
  return {
    unit: "business_days_creditor",
    timeZone: cfg.timeZone ?? "America/New_York",
    isBusinessDay: (d) => !isWeekend(d) && !isFederalHoliday(d) && !closures.has(d),
  };
}
export const creditor: Calendar = creditorCalendar();

/** Reg Z §1026.2(a)(6) specific definition: every day except Sundays and the legal public holidays in 5 U.S.C. 6103(a). Saturdays count. */
export const regzSpecific: Calendar = {
  unit: "business_days_regz_specific", timeZone: "America/New_York",
  isBusinessDay: (d) => dayOfWeek(d) !== 0 && !isFederalHoliday(d),
};

export interface CalendarSet {
  readonly calendar_days: Calendar;
  readonly business_days_federal: Calendar;
  readonly business_days_servicer: Calendar;
  readonly business_days_fannie_et: Calendar;
  readonly business_days_creditor: Calendar;
  readonly business_days_regz_specific: Calendar;
}

export const defaultCalendars: CalendarSet = {
  calendar_days: calendarDays,
  business_days_federal: federal,
  business_days_servicer: servicer,
  business_days_fannie_et: fannieEt,
  business_days_creditor: creditor,
  business_days_regz_specific: regzSpecific,
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
