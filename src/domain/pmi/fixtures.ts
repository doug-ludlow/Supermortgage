/**
 * §10 worked-loan fixture: sales price $400,000 / appraisal $410,000
 * (original value $400,000.00), $380,000 at 6.50% for 360 months, first
 * payment 2024-05-01, P&I $2,401.86. Installment ledgers are built with the
 * cashiering FIFO so "current" and "days past due" mean what Sections 2 and
 * 5 mean.
 */
import { type PlainDate, addMonths, plainDate as D } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { applyFifo, type AppliedInstallment } from "../boarding/delinquency.ts";

export const WORKED_LOAN = { sales_price_cents: 40000000n as Cents, appraised_value_cents: 41000000n as Cents, original_value_cents: 40000000n as Cents, upb_cents: 38000000n as Cents, rate_pct: "6.5", term_months: 360, first_due: D("2024-05-01"), pi_cents: 240186n as Cents } as const;

/** Installments from `first_due`, each paid on the mapped date (default on time; `null` = unpaid); nothing due after `through` is paid. */
export function installmentLedger(count: number, paid: Record<string, string | null> = {}, through: PlainDate = D("2099-01-01"), firstDue: PlainDate = WORKED_LOAN.first_due, amount: Cents = WORKED_LOAN.pi_cents): readonly AppliedInstallment[] {
  const inst = Array.from({ length: count }, (_, i) => ({ due_date: addMonths(firstDue, i), amount_cents: amount }));
  const pays = inst.flatMap((i) => {
    if (i.due_date > through) return [];
    const p = paid[i.due_date];
    if (p === null) return [];
    return [{ received_on: p ? D(p) : i.due_date, amount_cents: amount }];
  });
  return applyFifo(inst, pays).installments;
}
