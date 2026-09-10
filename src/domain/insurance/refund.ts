/**
 * 9.5 Force-placed cancellation/refund — overlap, daily rate, two-sided
 * correction; reused by 9.6 flood with a 30-day deadline.
 */
import { type PlainDate, addDays, daysBetween, min as minDate, max as maxDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";

export interface LpiTerm { readonly effective: PlainDate; readonly expiration: PlainDate; readonly premium_cents: Cents; }

export function termDays(t: LpiTerm): number { return daysBetween(t.effective, t.expiration); }

/** premium ÷ term_days at 6 dp (rule 2). */
export function dailyRate(t: LpiTerm): Decimal { return Decimal.ratio(t.premium_cents, BigInt(termDays(t))); }

/** Half-open overlap [max(starts), min(ends)) in days (rule 1). */
export function overlapDays(t: LpiTerm, borrowerStart: PlainDate, borrowerEnd: PlainDate | null): number {
  const start = maxDate(borrowerStart, t.effective);
  const end = borrowerEnd === null ? t.expiration : minDate(borrowerEnd, t.expiration);
  return Math.max(0, daysBetween(start, end));
}

export function overlapPremium(t: LpiTerm, days: number): Cents { return dailyRate(t).mul(Decimal.fromInt(days)).toScaledInt(0, "HALF_UP"); }

export interface CancellationInput {
  readonly terms: readonly LpiTerm[];
  readonly borrower_coverage_start: PlainDate;
  readonly borrower_coverage_end: PlainDate | null;
  readonly evidence_received_on: PlainDate;
  readonly borrower_paid_cents: Cents;         // paid toward the LPI charges (FIFO)
  readonly deadline_days?: 15 | 30;            // 15 hazard (§1024.37(g)), 30 flood (9.6 rule 6)
}

export interface CancellationResult {
  readonly overlap_days: number;
  readonly removed_cents: Cents;               // charges reversed
  readonly retained_cents: Cents;              // uncovered gap still owed
  readonly refund_cents: Cents;                // paid − retained, ≥ 0
  readonly still_due_cents: Cents;             // retained − paid, ≥ 0
  readonly cancellation_effective: PlainDate;
  readonly deadline: PlainDate;                // calendar deadline (9.5-T5)
  readonly root_cause: "borrower_evidence" | "servicer_error";
}

/** Rules 1–4, 6 — per-term overlaps summed; borrower refund independent of the carrier's refund. */
export function cancellation(i: CancellationInput): CancellationResult {
  let days = 0, removed = 0n, total = 0n;
  for (const t of i.terms) {
    const d = overlapDays(t, i.borrower_coverage_start, i.borrower_coverage_end);
    days += d; removed += overlapPremium(t, d); total += t.premium_cents;
  }
  const retained = total - removed;
  const refund = i.borrower_paid_cents > retained ? i.borrower_paid_cents - retained : 0n;
  const first = i.terms[0]!;
  const servicerError = i.borrower_coverage_start <= first.effective;
  return {
    overlap_days: days, removed_cents: removed, retained_cents: retained, refund_cents: refund,
    still_due_cents: retained > i.borrower_paid_cents ? retained - i.borrower_paid_cents : 0n,
    cancellation_effective: maxDate(i.borrower_coverage_start, first.effective),
    deadline: addDays(i.evidence_received_on, i.deadline_days ?? 15),
    root_cause: servicerError ? "servicer_error" : "borrower_evidence",
  };
}

/** Rule 5 — Fannie Mae already reimbursed the premium → remit the unearned refund within 30 days of the carrier refund. */
export function fnmaRemittanceDue(carrierRefundOn: PlainDate, claimPaid: boolean): PlainDate | null {
  return claimPaid ? addDays(carrierRefundOn, 30) : null;
}

/** Rule 6 ledger sketch: servicer cost = refund extended − carrier reimbursement. */
export function servicerNetCost(removed: Cents, carrierRefund: Cents): Cents { return removed - carrierRefund; }
