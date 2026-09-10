import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, dayOfWeek, addDays, addMonths, daysBetween, toEpochDays, fromEpochDays, nthWeekday, lastWeekday } from "./date.ts";
import { federalHolidays, isFederalHoliday } from "./holidays.ts";
import { addBusinessDays, businessDaysBetween, federal, servicer, servicerCalendar, fannieEt, rollForward, nextBusinessDay } from "./business.ts";
import { zonedEpochMs, wallClock, toIso } from "./zoned.ts";

test("date arithmetic is exact across leap years and month ends", () => {
  assert.equal(dayOfWeek(D("1970-01-01")), 4);          // Thursday
  assert.equal(dayOfWeek(D("2026-10-01")), 4);          // spec 1.1-T6: Oct 1, 2026 is a Thursday
  assert.equal(dayOfWeek(D("2026-12-02")), 3);          // spec 1.1-T7: Dec 2, 2026 is a Wednesday
  assert.equal(addDays(D("2024-02-28"), 1), "2024-02-29");
  assert.equal(addDays(D("2023-02-28"), 1), "2023-03-01");
  assert.equal(addMonths(D("2026-01-31"), 1), "2026-02-28");
  assert.equal(addMonths(D("2024-01-31"), 1), "2024-02-29");
  assert.equal(addMonths(D("2026-03-31"), -1), "2026-02-28");
  assert.equal(daysBetween(D("2026-08-01"), D("2026-10-01")), 61); // spec 1.1-T5
  for (const s of ["1900-03-01", "2000-02-29", "2026-09-10", "2100-12-31"]) assert.equal(fromEpochDays(toEpochDays(D(s))), s);
  assert.equal(nthWeekday(2026, 1, 1, 3), "2026-01-19");   // MLK Day 2026
  assert.equal(lastWeekday(2026, 5, 1), "2026-05-25");     // Memorial Day 2026
});

test("federal holidays follow 5 U.S.C. 6103 with observance shifting", () => {
  const names = federalHolidays(2026).map((h) => `${h.name}:${h.observed}`);
  assert.ok(names.includes("Independence Day:2026-07-03"));          // Jul 4, 2026 is a Saturday → Friday
  assert.ok(names.includes("Thanksgiving Day:2026-11-26"));
  assert.ok(names.includes("Christmas Day:2026-12-25"));
  assert.ok(names.includes("Juneteenth National Independence Day:2026-06-19"));
  assert.equal(isFederalHoliday(D("2026-07-03")), true);
  assert.equal(isFederalHoliday(D("2026-07-04")), false);            // the Saturday itself is not the observed day
  assert.equal(isFederalHoliday(D("2027-12-31")), true);             // Jan 1, 2028 is a Saturday → observed Dec 31, 2027
  assert.equal(isFederalHoliday(D("2020-06-19")), false);            // Juneteenth became a holiday in 2021
});

test("business day conventions differ by calendar", () => {
  // Wed Nov 25, 2026 + 1 federal business day skips Thanksgiving → Fri Nov 27
  assert.equal(addBusinessDays(D("2026-11-25"), 1, federal), "2026-11-27");
  assert.equal(addBusinessDays(D("2026-11-25"), 1, fannieEt), "2026-11-27");
  // A servicer that is open the Friday after Thanksgiving but closed on a company day
  const sm = servicerCalendar({ closures: [D("2026-11-27")] });
  assert.equal(addBusinessDays(D("2026-11-25"), 1, sm), "2026-11-30");
  // Saturday-open servicer counts Saturdays
  const sat = servicerCalendar({ saturdayOpen: true });
  assert.equal(addBusinessDays(D("2026-09-11"), 1, sat), "2026-09-12");
  assert.equal(addBusinessDays(D("2026-09-11"), 1, servicer), "2026-09-14");
  // Walking backwards
  assert.equal(addBusinessDays(D("2026-09-14"), -1, federal), "2026-09-11");
  assert.equal(businessDaysBetween(D("2026-09-11"), D("2026-09-18"), federal), 5);
  assert.equal(businessDaysBetween(D("2026-09-18"), D("2026-09-11"), federal), -5);
  assert.equal(rollForward(D("2026-09-12"), federal), "2026-09-14");
  assert.equal(nextBusinessDay(D("2026-12-02"), fannieEt), "2026-12-03"); // spec 1.1-T7
});

test("zoned wall-clock instants respect DST in America/New_York", () => {
  // 1.1-T7: EscrowSetup due 03:00 ET Dec 3, 2026 (EST, UTC−5) → 08:00Z
  assert.equal(toIso(zonedEpochMs(D("2026-12-03"), "03:00", "America/New_York")), "2026-12-03T08:00:00.000Z");
  // Summer: 20:00 EDT (UTC−4) → 00:00Z next day
  assert.equal(toIso(zonedEpochMs(D("2026-07-15"), "20:00", "America/New_York")), "2026-07-16T00:00:00.000Z");
  const w = wallClock(zonedEpochMs(D("2026-03-08"), "12:00", "America/New_York"), "America/New_York");
  assert.deepEqual([w.date, w.hour, w.minute], ["2026-03-08", 12, 0]);
});
