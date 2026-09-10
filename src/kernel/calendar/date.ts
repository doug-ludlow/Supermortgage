/**
 * Plain calendar dates as ISO `YYYY-MM-DD` strings backed by proleptic-Gregorian
 * day arithmetic. No `Date` objects, no timezones, no DST surprises — a
 * `PlainDate` is a civil date, which is what every deadline in the spec is
 * anchored to. Wall-clock instants (e.g. "03:00 America/New_York") live in
 * `zoned.ts`.
 */

export type PlainDate = string & { readonly __brand: "PlainDate" };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function plainDate(s: string): PlainDate {
  const m = ISO.exec(s);
  if (!m) throw new TypeError(`not an ISO date: ${JSON.stringify(s)}`);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw new RangeError(`invalid date: ${s}`);
  return s as PlainDate;
}

export function ymd(y: number, m: number, d: number): PlainDate {
  return plainDate(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

export function parts(date: PlainDate): { y: number; m: number; d: number } {
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) };
}

export function isLeapYear(y: number): boolean { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
}

/** Days since 1970-01-01 (may be negative). Howard Hinnant's civil-from-days algorithm. */
export function toEpochDays(date: PlainDate): number {
  let { y, m, d } = parts(date);
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromEpochDays(z: number): PlainDate {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return ymd(y + (m <= 2 ? 1 : 0), m, d);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: PlainDate): number {
  const z = toEpochDays(date);
  return ((z % 7) + 11) % 7; // 1970-01-01 was a Thursday (4)
}

export function isWeekend(date: PlainDate): boolean { const w = dayOfWeek(date); return w === 0 || w === 6; }

export function addDays(date: PlainDate, n: number): PlainDate { return fromEpochDays(toEpochDays(date) + n); }

/** Calendar days from `a` to `b` (positive when b is later). */
export function daysBetween(a: PlainDate, b: PlainDate): number { return toEpochDays(b) - toEpochDays(a); }

/** Add months with end-of-month clamping (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: PlainDate, n: number): PlainDate {
  const { y, m, d } = parts(date);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12 + 12) % 12 + 1;
  return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addYears(date: PlainDate, n: number): PlainDate { return addMonths(date, n * 12); }

export function compare(a: PlainDate, b: PlainDate): -1 | 0 | 1 { return a < b ? -1 : a > b ? 1 : 0; }
export function min(...ds: PlainDate[]): PlainDate { return ds.reduce((a, b) => (b < a ? b : a)); }
export function max(...ds: PlainDate[]): PlainDate { return ds.reduce((a, b) => (b > a ? b : a)); }

export function startOfMonth(date: PlainDate): PlainDate { const { y, m } = parts(date); return ymd(y, m, 1); }
export function endOfMonth(date: PlainDate): PlainDate { const { y, m } = parts(date); return ymd(y, m, daysInMonth(y, m)); }

/** n-th (1-based) weekday of a month, e.g. 3rd Monday of January → nthWeekday(y, 1, 1, 3). */
export function nthWeekday(y: number, m: number, weekday: number, n: number): PlainDate {
  const first = ymd(y, m, 1);
  const offset = (weekday - dayOfWeek(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

export function lastWeekday(y: number, m: number, weekday: number): PlainDate {
  const last = endOfMonth(ymd(y, m, 1));
  const offset = (dayOfWeek(last) - weekday + 7) % 7;
  return addDays(last, -offset);
}
