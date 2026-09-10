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
/** 1.6 data model `recon_variances.category`: variances are categorized, never plugged (rule 1). */
export type VarianceCategory = "matched" | "timing_in_transit" | "transferor_error" | "mapping_error" | "fnma_reporting_lag" | "unknown";
export const VARIANCE_CATEGORIES: readonly VarianceCategory[] = ["timing_in_transit", "transferor_error", "mapping_error", "fnma_reporting_lag", "unknown"];
export interface VarianceFacts {
  readonly difference_cents: Cents;
  /** Payments the transferor received after the T-1 cutoff and before the wire (1.3 forwarding file), not yet in either total. */
  readonly in_transit_cents?: Cents;
  /** The transferor has issued a corrected tape/trial balance that explains the difference. */
  readonly transferor_corrected?: boolean;
  /** The mapping layer read a column into the wrong canonical path (mapping_rules); the raw value agrees. */
  readonly mapping_mismatch?: boolean;
  /** Fannie Mae position still shows the transferor's pre-transfer figure and the transferor's transfer-month LAR has not posted (rule 4). */
  readonly fnma_position_is_pre_transfer?: boolean;
  readonly transferor_lar_posted?: boolean;
}
/** 1.6 rule 1/4: category by evidence — a timing lag at Fannie Mae is `fnma_reporting_lag`; an amount fully explained by in-transit payments is `timing_in_transit`; anything unexplained stays `unknown` (transferor query). */
export function classifyVariance(f: VarianceFacts): VarianceCategory {
  if (f.difference_cents === 0n) return "matched";
  if (f.fnma_position_is_pre_transfer && !f.transferor_lar_posted) return "fnma_reporting_lag";
  if (f.transferor_corrected) return "transferor_error";
  if (f.mapping_mismatch) return "mapping_error";
  const abs = f.difference_cents < 0n ? -f.difference_cents : f.difference_cents;
  if (f.in_transit_cents !== undefined && f.in_transit_cents !== 0n && (f.in_transit_cents < 0n ? -f.in_transit_cents : f.in_transit_cents) === abs) return "timing_in_transit";
  return "unknown";
}
export function wireVariance(expected: Cents, received: Cents, category: "ti" | "pi", today: PlainDate, facts: Omit<VarianceFacts, "difference_cents"> = {}): { variance_cents: Cents; category: VarianceCategory; sla_due: PlainDate | null; blocks_wires_matched: boolean; wire: "ti" | "pi" } {
  const v = received - expected;
  return { variance_cents: v, category: classifyVariance({ difference_cents: v, ...facts }), sla_due: v === 0n ? null : addBusinessDays(today, 5, servicer), blocks_wires_matched: v !== 0n, wire: category };
}
/** 1.6 rule 4 / 1.6-T7: Σ boarded UPB vs the LSDU position; a pre-transfer figure before the transferor's LAR posts is `fnma_reporting_lag` and must clear by the last Fannie Mae business day of the transfer month (SM_RECON_FNMA_POSITION_EOM). */
export function fnmaPositionRecon(i: { transfer_date: PlainDate; as_of: PlainDate; boarded_upb_cents: Cents; fnma_position_upb_cents: Cents; transferor_pre_transfer_upb_cents?: Cents | null; transferor_lar_posted: boolean }): { difference_cents: Cents; category: VarianceCategory; balanced: boolean; must_close_by: PlainDate; overdue: boolean } {
  const difference_cents = i.fnma_position_upb_cents - i.boarded_upb_cents;
  const preTransfer = i.transferor_pre_transfer_upb_cents !== undefined && i.transferor_pre_transfer_upb_cents !== null && i.fnma_position_upb_cents === i.transferor_pre_transfer_upb_cents;
  const category = classifyVariance({ difference_cents, fnma_position_is_pre_transfer: preTransfer, transferor_lar_posted: i.transferor_lar_posted });
  const must_close_by = fnmaPositionLagDeadline(i.transfer_date);
  return { difference_cents, category, balanced: difference_cents === 0n, must_close_by, overdue: difference_cents !== 0n && i.as_of > must_close_by };
}
/** 1.6 guardrails: fields on the borrower's account — any absorbed or written-off cent needs the officer. Portfolio-level fields carry the $25/loan, $5,000/batch thresholds. */
export const BORROWER_AFFECTING_FIELDS = ["upb", "lpi_date", "escrow_balance", "unapplied", "corporate_advances", "escrow_advances", "late_charges_due", "nsf_fees", "other_fees", "deferred_principal", "forborne_principal"] as const;
export const isBorrowerAffecting = (field: string | null | undefined): boolean => !!field && (BORROWER_AFFECTING_FIELDS as readonly string[]).includes(field);
export const LOAN_ABSORB_THRESHOLD_CENTS: Cents = 2_500n;      // ≥ $25/loan
export const BATCH_ABSORB_THRESHOLD_CENTS: Cents = 500_000n;   // ≥ $5,000/batch
/** Whether absorbing/writing off `varianceCents` needs `officer` approval (1.6 guardrails; open question 1 default thresholds). */
export function absorbNeedsOfficer(varianceCents: Cents, scope: "loan" | "batch" = "batch", borrowerAffecting = false): boolean {
  const abs = varianceCents < 0n ? -varianceCents : varianceCents;
  return borrowerAffecting || (scope === "batch" ? abs >= BATCH_ABSORB_THRESHOLD_CENTS : abs >= LOAN_ABSORB_THRESHOLD_CENTS);
}
/** 1.6-T8: the absorb command passes only when no officer is needed or one approved. */
export function absorbGate(varianceCents: Cents, officerApproved: boolean, scope: "loan" | "batch" = "batch", borrowerAffecting = false): boolean { return !absorbNeedsOfficer(varianceCents, scope, borrowerAffecting) || officerApproved; }
export function fnmaPositionLagDeadline(transferDate: PlainDate): PlainDate { return rollBack(endOfMonth(transferDate), fannieEt); }
/** 1.6-T6 / F-1-11: when the transferor's final accounting is not received by T+30, Supermortgage prepares its own shortage/surplus analysis for Fannie Mae (transferee liable for unresolved shortages). */
export function shortageAnalysisDraft(i: { batch_id: string; transfer_date: PlainDate; prepared_on: PlainDate; loans: readonly { fnma_loan_number: string; upb_cents: Cents; unremitted_pi_cents?: Cents; pi_advances_cents?: Cents; escrow_advances_cents?: Cents }[] }): { batch_id: string; status: "draft"; prepared_by: "supermortgage"; basis: string; prepared_on: PlainDate; final_accounting_due: PlainDate; loan_count: number; upb_total_cents: Cents; unremitted_pi_total_cents: Cents; advances_claimed_cents: Cents; shortage_surplus_cents: Cents; lines: { fnma_loan_number: string; upb_cents: Cents; unremitted_pi_cents: Cents; advances_cents: Cents }[] } {
  const lines = i.loans.map((l) => ({ fnma_loan_number: l.fnma_loan_number, upb_cents: l.upb_cents, unremitted_pi_cents: l.unremitted_pi_cents ?? 0n, advances_cents: (l.pi_advances_cents ?? 0n) + (l.escrow_advances_cents ?? 0n) }));
  const sum = (f: (x: (typeof lines)[number]) => Cents) => lines.reduce((s, x) => s + f(x), 0n);
  const unremitted = sum((x) => x.unremitted_pi_cents), advances = sum((x) => x.advances_cents);
  return { batch_id: i.batch_id, status: "draft", prepared_by: "supermortgage", basis: "F-1-11: no final accounting within 30 days of the transfer date; transferee liable for unresolved Fannie Mae shortages", prepared_on: i.prepared_on, final_accounting_due: finalAccountingDue(i.transfer_date), loan_count: lines.length, upb_total_cents: sum((x) => x.upb_cents), unremitted_pi_total_cents: unremitted, advances_claimed_cents: advances, shortage_surplus_cents: unremitted - advances, lines };
}
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
