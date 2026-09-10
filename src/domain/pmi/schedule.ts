/**
 * Section 10 — MI amortization schedules (10.2 R2, 10.3 R1). A schedule
 * version is built once from the terms in effect and is the authority for
 * "scheduled" balances; curtailments never rebuild a fixed-rate schedule.
 */
import { type PlainDate, addDays, addMonths, parts, ymd } from "../../kernel/calendar/date.ts";
import { type Cents, levelPayment, monthlyInterest } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export interface ScheduleRow { readonly n: number; readonly due_date: PlainDate; readonly payment_cents: Cents; readonly interest_cents: Cents; readonly principal_cents: Cents; readonly upb_after_cents: Cents; }

export interface ScheduleTerms {
  readonly upb_cents: Cents;                   // balance at the start of this version
  readonly annual_rate: Decimal;
  readonly term_months: number;                // remaining amortizing term (after IO months)
  readonly first_due: PlainDate;
  readonly first_n?: number;                   // payment number of the first row (default 1)
  readonly io_months?: number;                 // interest-only rows before amortization
  readonly forborne_principal_cents?: Cents;   // constant component of "scheduled principal" (4902(d))
}

export type ScheduleVersionKind = "initial" | "arm_reset" | "modification";

export interface ScheduleVersion { readonly kind: ScheduleVersionKind; readonly rows: readonly ScheduleRow[]; readonly forborne_principal_cents: Cents; readonly pi_cents: Cents; }

/** Level-payment schedule with optional interest-only prefix. Final row absorbs rounding. */
export function buildSchedule(t: ScheduleTerms, kind: ScheduleVersionKind = "initial"): ScheduleVersion {
  const rows: ScheduleRow[] = [];
  let upb = t.upb_cents;
  let n = t.first_n ?? 1;
  let due = t.first_due;
  const io = t.io_months ?? 0;
  for (let i = 0; i < io; i++) {
    const interest = monthlyInterest(upb, t.annual_rate);
    rows.push({ n, due_date: due, payment_cents: interest, interest_cents: interest, principal_cents: 0n, upb_after_cents: upb });
    n++; due = addMonths(due, 1);
  }
  const pi = levelPayment(upb, t.annual_rate, t.term_months);
  for (let i = 0; i < t.term_months; i++) {
    const interest = monthlyInterest(upb, t.annual_rate);
    let principal = pi - interest;
    if (i === t.term_months - 1 || principal > upb) principal = upb;
    upb -= principal;
    rows.push({ n, due_date: due, payment_cents: principal + interest, interest_cents: interest, principal_cents: principal, upb_after_cents: upb });
    n++; due = addMonths(due, 1);
  }
  return { kind, rows, forborne_principal_cents: t.forborne_principal_cents ?? 0n, pi_cents: pi };
}

/** original_value × pct/100, half-up to cents. */
export function thresholdCents(originalValue: Cents, pct: number): Cents {
  return Decimal.fromBigInt(originalValue).mul(Decimal.fromInt(pct)).div(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP");
}

/** First due date whose scheduled principal (UPB after payment + forborne) ≤ threshold. */
export function scheduledDateForPct(v: ScheduleVersion, originalValue: Cents, pct: number): { due_date: PlainDate; n: number; upb_after_cents: Cents } | null {
  const th = thresholdCents(originalValue, pct);
  const row = v.rows.find((r) => r.upb_after_cents + v.forborne_principal_cents <= th);
  return row ? { due_date: row.due_date, n: row.n, upb_after_cents: row.upb_after_cents } : null;
}

export function scheduledUpb(v: ScheduleVersion, on: PlainDate): Cents {
  let upb = v.rows[0] ? v.rows[0].upb_after_cents + v.rows[0].principal_cents : 0n;
  for (const r of v.rows) { if (r.due_date <= on) upb = r.upb_after_cents; else break; }
  return upb;
}

/** ARM reset (10.2 R2): new schedule from the *scheduled* balance before the change-date payment. */
export function armResetVersion(prior: ScheduleVersion, changeN: number, newRate: Decimal, remainingTerm: number): ScheduleVersion {
  const before = prior.rows.find((r) => r.n === changeN - 1);
  const first = prior.rows.find((r) => r.n === changeN);
  if (!before || !first) throw new RangeError(`payment ${changeN} not in schedule`);
  return buildSchedule({ upb_cents: before.upb_after_cents, annual_rate: newRate, term_months: remainingTerm, first_due: first.due_date, first_n: changeN, forborne_principal_cents: prior.forborne_principal_cents }, "arm_reset");
}

// ---- 10.3 midpoint ------------------------------------------------------------

export interface Midpoint { readonly amortization_start: PlainDate; readonly midpoint_date: PlainDate; readonly midpoint_termination_date: PlainDate; }

/** amortization_start = first payment − 1 month; midpoint = start + term/2 months (odd: floor + 15 days → first of following month); termination = first of the month after. */
export function midpoint(firstPaymentDue: PlainDate, termMonths: number): Midpoint {
  const start = addMonths(firstPaymentDue, -1);
  let mid: PlainDate;
  if (termMonths % 2 === 0) mid = addMonths(start, termMonths / 2);
  else {
    const d = addDays(addMonths(start, Math.floor(termMonths / 2)), 15);
    mid = firstOfFollowingMonth(d);
  }
  return { amortization_start: start, midpoint_date: mid, midpoint_termination_date: firstOfFollowingMonth(mid) };
}

export function firstOfFollowingMonth(d: PlainDate): PlainDate { const { y, m } = parts(d); return addMonths(ymd(y, m, 1), 1); }
