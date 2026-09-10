/** §1.3 / §17.2 RESPA transfer notices — goodbye/hello dates, respa_effective_date override, protected-payment rule, short-year statement. */
import { type PlainDate, addDays, dayOfWeek, parts, ymd } from "../../kernel/calendar/date.ts";
import { fannieEt, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";

/** 17.2 decision 1: when the 1st is not a Fannie business day and installments are due on the 1st, the effective date is the 1st. */
export function respaEffectiveDate(transferDate: PlainDate, installmentsDueOn1st: boolean): PlainDate { const { y, m } = parts(transferDate); const first = ymd(y, m, 1); return installmentsDueOn1st && !fannieEt.isBusinessDay(first) && transferDate !== first ? first : transferDate; }
export function noticeDates(effective: PlainDate): { goodbye_due: PlainDate; hello_due: PlainDate; window_end: PlainDate; transferor_stops: PlainDate; transferee_starts: PlainDate; short_year_statement_due: PlainDate } {
  return { goodbye_due: addDays(effective, -15), hello_due: addDays(effective, 15), window_end: addDays(effective, 59), transferor_stops: addDays(effective, -1), transferee_starts: effective, short_year_statement_due: addDays(effective, 60) };
}
/** Mail runs release on the last vendor collection day (Friday) before a weekend due date. */
export function runScheduledOn(due: PlainDate): PlainDate { let d = due; while (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) d = addDays(d, -1); return d; }
export function protectedPayment(receivedByTransferorOn: PlainDate, dueDate: PlainDate, graceDays: number, effective: PlainDate): { protected: boolean; credited_as_of: PlainDate } {
  const windowEnd = addDays(effective, 59);
  const p = receivedByTransferorOn <= addDays(dueDate, graceDays) && receivedByTransferorOn >= effective && receivedByTransferorOn <= windowEnd;
  return { protected: p, credited_as_of: receivedByTransferorOn };
}
export function forwardBy(receivedOn: PlainDate): PlainDate { return addBusinessDays(receivedOn, 1, servicer); }
export const REQUIRED_CONTENT = ["effective_date", "transferee_block", "transferor_block", "transferor_tollfree", "transferee_tollfree", "stop_start_dates", "insurance_paragraph", "servicing_terms_only", "ms2_60_day_sentence"] as const;
export function contentCheck(present: readonly string[]): { ok: boolean; missing: string[] } { const m = REQUIRED_CONTENT.filter((r) => !present.includes(r)); return { ok: m.length === 0, missing: [...m] }; }
export function achCancelBy(transferDate: PlainDate): PlainDate { return addBusinessDays(transferDate, -3, servicer); }
export function correctiveNoticeDue(cancelledOn: PlainDate): PlainDate { return addDays(cancelledOn, 7); }
export function skipTraceDue(returnedOn: PlainDate): PlainDate { return addBusinessDays(returnedOn, 5, servicer); }
