/** 15.4 Delinquency advance reimbursement — expectations, FIFO matching, variances. */
import { type PlainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { calendarDraftDate, nextMonth } from "../investor/period.ts";

export type RecoveryEvent = "liquidation_lar" | "reclass" | "deferral" | "payoff" | "repurchase";

export interface Advance { readonly id: string; readonly activity_period: string; readonly amount_cents: Cents; readonly status: "outstanding" | "reimbursed_by_fnma" | "recovered_from_borrower"; }

export function outstanding(advances: readonly Advance[]): Cents { return advances.filter((a) => a.status === "outstanding").reduce((s, a) => s + a.amount_cents, 0n); }

/** Rule 3 — expectation by event: liquidation → two draft cycles; deferral → 4 fannie_et BD; reclass → purchase advice; payoff → none. */
export function expectedRecovery(event: RecoveryEvent, acceptedOn: PlainDate, cal: Calendar = fannieEt): { expected_by: PlainDate | null; cycles: readonly PlainDate[] } {
  if (event === "payoff" || event === "repurchase") return { expected_by: null, cycles: [] };
  if (event === "deferral") return { expected_by: addBusinessDays(acceptedOn, 4, cal), cycles: [] };
  if (event === "reclass") return { expected_by: acceptedOn, cycles: [] };
  const c1 = calendarDraftDate(nextMonth(acceptedOn), 18), c2 = calendarDraftDate(nextMonth(addMonths(acceptedOn, 1)), 18);
  return { expected_by: c2, cycles: [c1, c2] };
}

export const MATCH_TOLERANCE: Cents = 5n;

export interface MatchResult { readonly matched: readonly string[]; readonly matched_cents: Cents; readonly variance_cents: Cents; readonly status: "matched" | "variance" | "duplicate"; }

/** Rule 4 — FIFO by activity period, $0.05 tolerance per line. */
export function matchReimbursement(advances: readonly Advance[], credit: Cents): MatchResult {
  const open = advances.filter((a) => a.status === "outstanding").sort((a, b) => (a.activity_period < b.activity_period ? -1 : 1));
  if (open.length === 0) return { matched: [], matched_cents: 0n, variance_cents: credit, status: "duplicate" };
  const ids: string[] = []; let sum = 0n;
  for (const a of open) { if (sum + a.amount_cents <= credit + MATCH_TOLERANCE) { sum += a.amount_cents; ids.push(a.id); } else break; }
  const variance = credit - sum;
  const total = open.reduce((s, a) => s + a.amount_cents, 0n);
  const abs = variance < 0n ? -variance : variance;
  return { matched: ids, matched_cents: sum, variance_cents: total - credit, status: abs <= MATCH_TOLERANCE && sum === total ? "matched" : "variance" };
}

export function unrecoveredEscalationDue(acceptedOn: PlainDate): PlainDate { return addDays(acceptedOn, 60); }

/** Rule 1 — regular servicing option MBS must be repurchased/reclassified before foreclosure completion (E-3.5-01). */
export function mbsRemovalGate(servicingOption: "special" | "regular_mbs" | "portfolio", repurchaseOrReclassAccepted: boolean): { blocked: boolean; escalate: "officer" | null } {
  const blocked = servicingOption === "regular_mbs" && !repurchaseOrReclassAccepted;
  return { blocked, escalate: blocked ? "officer" : null };
}

/** S/A portfolio: interest advanced months 1–3 recovered by the month-4 negative-interest LAR. */
export function saRecoveryLar(monthlyInterestCents: Cents, monthsAdvanced: number): { lar: "96"; interest_cents: Cents } { return { lar: "96", interest_cents: -(monthlyInterestCents * BigInt(monthsAdvanced)) }; }

export function duplicateCreditNoticeDue(receivedOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(receivedOn, 2, cal); }
