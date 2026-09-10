/**
 * Reg X §1024.31 delinquency: "a period of time during which a borrower and
 * a borrower's mortgage loan obligation are delinquent. A borrower's mortgage
 * loan obligation is delinquent beginning on the date a periodic payment
 * sufficient to cover principal, interest, and, if applicable, escrow becomes
 * due and unpaid." Payments are applied to the oldest outstanding periodic
 * payment first (comment 31(Delinquency)-2), so the counter is
 *
 *     regx_days_delinquent(t) = t − min{ D : installment D unpaid }
 *
 * and MUST be derived from the payment history by FIFO application, never
 * from a transferor's delinquency code (spec 1.1, 11.1 rule 2).
 */
import { type PlainDate, daysBetween } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Installment, HistoricalPayment } from "./types.ts";

export interface AppliedInstallment extends Installment {
  readonly satisfied_on: PlainDate | null;      // receipt date of the payment that completed it (credited_as_of)
  readonly paid_cents: Cents;
}

export interface FifoResult {
  readonly installments: readonly AppliedInstallment[];
  readonly unapplied_cents: Cents;              // residual below one full installment
}

/**
 * Apply receipts oldest-first to installments oldest-first. A receipt only
 * satisfies an installment when the accumulated funds cover the full periodic
 * payment (comment 31(Delinquency)-2; partials accumulate in suspense — 2.2).
 */
export function applyFifo(installments: readonly Installment[], payments: readonly HistoricalPayment[]): FifoResult {
  const sched = [...installments].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
  const rcpts = [...payments].sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : 0));
  const out: AppliedInstallment[] = sched.map((i) => ({ ...i, satisfied_on: null, paid_cents: 0n }));
  let pool = 0n, idx = 0;
  for (const r of rcpts) {
    pool += r.amount_cents;
    while (idx < out.length && pool >= out[idx]!.amount_cents) {
      const inst = out[idx]!;
      pool -= inst.amount_cents;
      out[idx] = { ...inst, satisfied_on: r.received_on, paid_cents: inst.amount_cents };
      idx++;
    }
  }
  return { installments: out, unapplied_cents: pool };
}

/** Unpaid *as of* `asOf`: never satisfied, or satisfied by a receipt dated after `asOf`. */
export function isUnpaidAsOf(i: AppliedInstallment, asOf: PlainDate): boolean {
  return i.satisfied_on === null || i.satisfied_on > asOf;
}

export function earliestUnpaidDueDate(applied: readonly AppliedInstallment[], asOf: PlainDate): PlainDate | null {
  for (const i of applied) if (isUnpaidAsOf(i, asOf) && i.due_date <= asOf) return i.due_date;
  return null;
}

/** Days delinquent under §1024.31 as of `asOf` (0 when current). */
export function regxDaysDelinquent(applied: readonly AppliedInstallment[], asOf: PlainDate): number {
  const d = earliestUnpaidDueDate(applied, asOf);
  return d === null ? 0 : Math.max(0, daysBetween(d, asOf));
}

export type FnmaDelinquencyStatus = "current" | "30" | "60" | "90" | "120+";

/**
 * Fannie Mae / MBA bucket: number of periodic payments past due as of `asOf`
 * (an installment due *on* `asOf` is not yet late). 11.1 worked example:
 * LPI 11/01, Dec 1 unpaid → "30" at Dec 31.
 */
export function fnmaDelinquencyStatus(applied: readonly AppliedInstallment[], asOf: PlainDate): FnmaDelinquencyStatus {
  const missed = applied.filter((i) => isUnpaidAsOf(i, asOf) && i.due_date < asOf).length;
  if (missed === 0) return "current";
  if (missed === 1) return "30";
  if (missed === 2) return "60";
  if (missed === 3) return "90";
  return "120+";
}
