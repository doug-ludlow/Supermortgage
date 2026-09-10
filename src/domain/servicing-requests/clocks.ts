/** Reg X §1024.35/.36 day counting: day 0 = receipt, count forward excluding Saturdays, Sundays and legal public holidays; due end of day ET. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
export function federalDays(receivedOn: PlainDate, n: number): PlainDate { return addBusinessDays(receivedOn, n, federal); }
export function dueMs(d: PlainDate): number { return zonedEpochMs(d, "23:59", "America/New_York"); }
export function calendarDays(receivedOn: PlainDate, n: number): PlainDate { return addDays(receivedOn, n); }
