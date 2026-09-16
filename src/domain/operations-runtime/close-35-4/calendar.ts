/**
 * §35.4 rule 8 — BDn counts on the Fannie Mae calendar (`business_days_fannie_et`) for the period-open, stall and
 * attestation clocks and on the federal calendar for the tax-year close; instants are Eastern wall-clock times. The
 * clocks themselves are the registry's (spec/registry/timers.json, armed by the engine on this process's events); these
 * helpers derive the period keys, the `not_before` gates and the expected dates the tests assert.
 */
import { addBusinessDays, fannieEt, federal } from "../../../kernel/calendar/business.ts";
import { addDays, endOfMonth, parts, plainDate as D, startOfMonth, ymd, type PlainDate } from "../../../kernel/calendar/date.ts";
import { toIso, wallClock, zonedEpochMs } from "../../../kernel/calendar/zoned.ts";
import { ET } from "./types.ts";

export const at = (d: PlainDate, hhmm: string): string => toIso(zonedEpochMs(d, hhmm, ET));
export const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
export const etHhmm = (iso: string): string => { const w = wallClock(Date.parse(iso), ET); return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`; };
/** BDn of `business_days_fannie_et` after `d` (n=1 from a Saturday period end is the Monday: rule 8's Oct 2026 example). */
export const fannieBd = (d: PlainDate, n: number): PlainDate => addBusinessDays(d, n, fannieEt);
export const federalBd = (d: PlainDate, n: number): PlainDate => addBusinessDays(d, n, federal);
export const periodKeyOf = (d: PlainDate): string => d.slice(0, 7);
export const periodStartOf = (period: string): PlainDate => D(`${period}-01`);
export const periodEndOf = (period: string): PlainDate => endOfMonth(periodStartOf(period));
export const priorPeriodOf = (d: PlainDate): string => periodKeyOf(addDays(startOfMonth(d), -1));
export const isQuarterEnd = (period: string): boolean => [3, 6, 9, 12].includes(parts(periodStartOf(period)).m);
export const isDecember = (period: string): boolean => parts(periodStartOf(period)).m === 12;
export const taxYearOf = (period: string): number => parts(periodStartOf(period)).y;
export const taxPeriodKey = (taxYear: number): string => `${taxYear}-TY`;
export const taxYearEnd = (taxYear: number): PlainDate => ymd(taxYear, 12, 31);
/** 8.1's schedule: the snapshot builds 00:05 ET on the 1st of the following month. */
export const metro2NotBefore = (period: string): string => at(addDays(periodEndOf(period), 1), "00:05");
/** 18.1's schedule: the QC cycle opens on BD3 of the following month. */
export const qcNotBefore = (period: string): string => at(fannieBd(periodEndOf(period), 3), "00:00");
/** 7.1's "Jan 2, 00:05 ET". */
export const taxYearCloseNotBefore = (taxYear: number): string => at(ymd(taxYear + 1, 1, 2), "00:05");
/** The first business_days_fannie_et day after the period end — the `lar_daily` run the `lar` step waits on (IRM 2-01: BD1 20:00 ET). */
export const bd1Of = (period: string): PlainDate => fannieBd(periodEndOf(period), 1);
