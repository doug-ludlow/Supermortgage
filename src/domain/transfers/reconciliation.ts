/** §1.6 / §17.3 transfer reconciliation — wires by category, variance categories, escrow continuity, final accounting, deliverable schedule. */
import type { Cents } from "../../kernel/money/cents.ts";
import { divRound, Decimal } from "../../kernel/money/decimal.ts";
import { type PlainDate, addDays, endOfMonth, addMonths, addYears } from "../../kernel/calendar/date.ts";
import { addBusinessDays, fannieEt, servicer, rollBack } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { fannieBusinessDay } from "../investor/period.ts";

export interface LoanBalances { readonly upb_cents: Cents; readonly escrow_cents: Cents; readonly unapplied_cents: Cents; readonly corporate_advances_cents: Cents; readonly late_charges_cents: Cents; readonly unremitted_pi_cents?: Cents; readonly prepaid_next_period_pi_cents?: Cents; readonly pi_advances_cents?: Cents; readonly escrow_interest_rate_pct?: string | null; }
export function expectedWires(loans: readonly LoanBalances[], includeEscrowInterestMonth = false): { ti_wire_cents: Cents; pi_wire_cents: Cents; escrow_advances_receivable_cents: Cents; corporate_advances_receivable_cents: Cents; pi_advances_receivable_cents: Cents; late_charges_memo_cents: Cents; final_accounting_receivable_cents: Cents } {
  let ti = 0n, pi = 0n, escAdv = 0n, corp = 0n, piAdv = 0n, lc = 0n;
  for (const l of loans) {
    if (l.escrow_cents > 0n) { let e = l.escrow_cents; if (includeEscrowInterestMonth && l.escrow_interest_rate_pct) e += divRound(l.escrow_cents * Decimal.parse(l.escrow_interest_rate_pct).unscaled, 100n * 12n * Decimal.ONE.unscaled, "HALF_UP"); ti += e; } else escAdv += -l.escrow_cents;
    pi += l.unapplied_cents + (l.unremitted_pi_cents ?? 0n) + (l.prepaid_next_period_pi_cents ?? 0n);
    corp += l.corporate_advances_cents; piAdv += l.pi_advances_cents ?? 0n; lc += l.late_charges_cents;
  }
  return { ti_wire_cents: ti, pi_wire_cents: pi, escrow_advances_receivable_cents: escAdv, corporate_advances_receivable_cents: corp, pi_advances_receivable_cents: piAdv, late_charges_memo_cents: lc, final_accounting_receivable_cents: piAdv + escAdv + corp };
}
export function wireVariance(expected: Cents, received: Cents, category: "ti" | "pi", today: PlainDate): { variance_cents: Cents; category: "matched" | "unknown"; sla_due: PlainDate | null; blocks_wires_matched: boolean } { const v = received - expected; return { variance_cents: v, category: v === 0n ? "matched" : "unknown", sla_due: v === 0n ? null : addBusinessDays(today, 5, servicer), blocks_wires_matched: v !== 0n }; }
export function absorbGate(varianceCents: Cents, officerApproved: boolean): boolean { const abs = varianceCents < 0n ? -varianceCents : varianceCents; return abs <= 500_000n || officerApproved; }
export function fnmaPositionLagDeadline(transferDate: PlainDate): PlainDate { return rollBack(endOfMonth(transferDate), fannieEt); }
export function escrowContinuity(paymentUnchanged: boolean, methodUnchanged: boolean, transferDate: PlainDate): { initial_statement_due: PlainDate | null; computation_year_start: PlainDate | "retained" } { return paymentUnchanged && methodUnchanged ? { initial_statement_due: null, computation_year_start: "retained" } : { initial_statement_due: addDays(transferDate, 60), computation_year_start: transferDate }; }
export function finalAccountingDue(transferDate: PlainDate): PlainDate { return addDays(transferDate, 30); }
export function lateChargeReceivable(piCents: Cents, pct: string): Cents { return divRound(piCents * Decimal.parse(pct).unscaled, 100n * Decimal.ONE.unscaled, "HALF_UP"); }
/** §17.3 deliverable schedule for a transfer date T. */
export function outboundSchedule(T: PlainDate): Record<string, PlainDate | string> {
  const tPlus1 = addBusinessDays(T, 1, fannieEt);
  return { test_tape_by: addDays(T, -30), preliminary_by: addDays(T, -14), preliminary_qc_by: addDays(T, -7), counterparties_by: addBusinessDays(T, -1, servicer), freeze_at: `${addBusinessDays(T, -1, servicer)} COB`, final_tape_by: tPlus1, wires_by: tPlus1, images_by: addBusinessDays(T, 5, fannieEt), custodial_recons_by: addBusinessDays(T, 5, fannieEt), final_period_close: `${fannieBusinessDay(T, 2)} 17:00 ET`, fnma_processes_on: fannieBusinessDay(T, 3), final_accounting_by: addDays(T, 30), mi_notice_by: addDays(T, 60), support_window_end: addDays(T, 90), noe_rfi_tail_end: addYears(T, 1) };
}
export function finalPeriodCloseMs(T: PlainDate): number { return zonedEpochMs(fannieBusinessDay(T, 2), "17:00", "America/New_York"); }
export function transfereeRequestDue(receivedOn: PlainDate): PlainDate { return addBusinessDays(receivedOn, 5, servicer); }
export function custodianShipBy(tedNotificationOn: PlainDate): PlainDate { return addDays(tedNotificationOn, 30); }
void addMonths;
