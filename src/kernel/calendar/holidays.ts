/**
 * Federal legal public holidays (5 U.S.C. § 6103) with the statutory observance
 * rule: a holiday falling on Saturday is observed the preceding Friday; on
 * Sunday, the following Monday. This is the exclusion set for
 * `business_days_federal` (Reg X's "days excluding legal public holidays,
 * Saturdays, and Sundays") and the base set for the Fannie Mae ET calendar.
 */
import { type PlainDate, ymd, nthWeekday, lastWeekday, dayOfWeek, addDays } from "./date.ts";

export interface Holiday { readonly name: string; readonly date: PlainDate; readonly observed: PlainDate; }

function observed(date: PlainDate): PlainDate {
  const w = dayOfWeek(date);
  return w === 6 ? addDays(date, -1) : w === 0 ? addDays(date, 1) : date;
}

const cache = new Map<number, readonly Holiday[]>();

export function federalHolidays(year: number): readonly Holiday[] {
  const hit = cache.get(year);
  if (hit) return hit;
  const fixed = (name: string, m: number, d: number) => ({ name, date: ymd(year, m, d), observed: observed(ymd(year, m, d)) });
  const floating = (name: string, date: PlainDate) => ({ name, date, observed: date });
  const list: Holiday[] = [
    fixed("New Year's Day", 1, 1),
    floating("Birthday of Martin Luther King, Jr.", nthWeekday(year, 1, 1, 3)),
    floating("Washington's Birthday", nthWeekday(year, 2, 1, 3)),
    floating("Memorial Day", lastWeekday(year, 5, 1)),
    ...(year >= 2021 ? [fixed("Juneteenth National Independence Day", 6, 19)] : []),
    fixed("Independence Day", 7, 4),
    floating("Labor Day", nthWeekday(year, 9, 1, 1)),
    floating("Columbus Day", nthWeekday(year, 10, 1, 2)),
    fixed("Veterans Day", 11, 11),
    floating("Thanksgiving Day", nthWeekday(year, 11, 4, 4)),
    fixed("Christmas Day", 12, 25),
  ];
  // New Year's Day of the *next* year observed on Dec 31 of this year (when Jan 1 is a Saturday).
  const nextNy = ymd(year + 1, 1, 1);
  if (dayOfWeek(nextNy) === 6) list.push({ name: "New Year's Day (observed)", date: nextNy, observed: addDays(nextNy, -1) });
  cache.set(year, list);
  return list;
}

export function isFederalHoliday(date: PlainDate): boolean {
  const year = Number(date.slice(0, 4));
  return federalHolidays(year).some((h) => h.observed === date);
}
