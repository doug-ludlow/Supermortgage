/**
 * §6.3/6.4 Custodial reconciliation — Forms 496/496A composition, the
 * three-way match, auto-clear, draft variance, shortage funding tiers,
 * deadlines (day 45 rolled back), stale checks and the attestation window.
 */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import { rollBack, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { fannieBusinessDay } from "../investor/period.ts";

export interface SectionI { readonly bank_closing_ledger_cents: Cents; readonly deposits_in_transit_cents: Cents; readonly disbursements_in_transit_cents: Cents; readonly adjustments_cents: Cents; }
export function adjustedDepository(s: SectionI): Cents { return s.bank_closing_ledger_cents + s.deposits_in_transit_cents - s.disbursements_in_transit_cents + s.adjustments_cents; }

export interface Form496SS { L3_prepaid_net: Cents; L4_curtailments: Cents; L5_interest_fundings: Cents; L7_payoff_fixed_net: Cents; L8_delinquent_net: Cents; L9_fnma_receivable: Cents; L10_variances: Cents; L11_other: Cents; }
export function form496SS(c: Form496SS): { L12: Cents } { return { L12: c.L3_prepaid_net + c.L4_curtailments + c.L5_interest_fundings + c.L7_payoff_fixed_net + c.L8_delinquent_net + c.L9_fnma_receivable + c.L10_variances + c.L11_other }; }
export interface Form496AA { L1_full_installments_net: Cents; L11_other: Cents; }
export function form496AA(c: Form496AA): { L12: Cents } { return { L12: c.L1_full_installments_net + c.L11_other }; }

/** The identity checked before the form is drafted: L12 = cashbook = adjusted depository. */
export function reconcile(sectionI: SectionI, cashbookCents: Cents, L12: Cents): { adjusted_depository_cents: Cents; difference_cents: Cents; balanced: boolean } {
  const adj = adjustedDepository(sectionI);
  return { adjusted_depository_cents: adj, difference_cents: adj - cashbookCents, balanced: adj === cashbookCents && L12 === cashbookCents };
}

/** 6.4 rule 1 composition. */
export interface TiComposition { P: Cents; N: Cents; A: Cents; LD: Cents; U: Cents; BD: Cents; I: Cents; O: Cents; }
export function form496A(c: TiComposition): { L1: Cents; L2: Cents; L3: Cents; L4: Cents; L5: Cents; L6: Cents; L7: Cents; advance_unfunded_cents: Cents } {
  const L1 = c.P - c.N, L2 = c.A, L3 = c.LD, L4 = c.U, L5 = c.BD, L6 = c.I + c.O;
  return { L1, L2, L3, L4, L5, L6, L7: L1 + L2 + L3 + L4 + L5 + L6, advance_unfunded_cents: c.N - c.A > 0n ? c.N - c.A : 0n };
}

/** Form 496/496A: 45 calendar days after period end, rolled back to the preceding servicer BD, 17:00 local; warning at day 30. */
export function form496Deadline(periodEnd: PlainDate): { due_on: PlainDate; due_at_ms: number; warning_on: PlainDate } {
  const due_on = rollBack(addDays(periodEnd, 45), servicer);
  return { due_on, due_at_ms: zonedEpochMs(due_on, "17:00", "America/New_York"), warning_on: addDays(periodEnd, 30) };
}
/** S/S funds available on the 18th (F-1-20): preceding BD when the 18th is not one, 00:01 ET. */
export function ssFundsAvailableMs(monthOf: PlainDate): number { const { y, m } = parts(monthOf); return zonedEpochMs(rollBack(ymd(y, m, 18), fannieEt), "00:01", "America/New_York"); }
/** LL-2026-05 escrow attestation window for month M: opens BD3 of M+1, closes BD2 of M+2 17:00 ET. */
export function attestationWindow(periodEnd: PlainDate): { opens_on: PlainDate; closes_at_ms: number; closes_on: PlainDate; draft_warning_on: PlainDate } {
  const { y, m } = parts(periodEnd);
  const m1 = ymd(m === 12 ? y + 1 : y, (m % 12) + 1, 1), m2 = ymd(m >= 11 ? y + 1 : y, ((m + 1) % 12) + 1, 1);
  const closes_on = fannieBusinessDay(m2, 2);
  return { opens_on: fannieBusinessDay(m1, 3), closes_on, closes_at_ms: zonedEpochMs(closes_on, "17:00", "America/New_York"), draft_warning_on: addBusinessDays(closes_on, -3, fannieEt) };
}

export type MatchTier = "reference" | "amount_date_1to1" | "amount_date_many_to_1" | "unmatched";
export interface BankLine { readonly id: string; readonly amount_cents: Cents; readonly value_date: PlainDate; readonly reference?: string; readonly type_code?: string; readonly memo?: string; }
export interface LedgerItem { readonly id: string; readonly amount_cents: Cents; readonly date: PlainDate; readonly reference?: string; readonly batch_id?: string; }
/** 6.3 rule 2 deterministic matching order. */
export function matchBankLine(line: BankLine, ledger: readonly LedgerItem[]): { tier: MatchTier; ledger_ids: string[] } {
  const byRef = line.reference ? ledger.filter((l) => l.reference === line.reference) : [];
  if (byRef.length) return { tier: "reference", ledger_ids: byRef.map((l) => l.id) };
  const oneToOne = ledger.filter((l) => l.amount_cents === line.amount_cents && Math.abs(daysBetween(l.date, line.value_date)) <= 1);
  if (oneToOne.length === 1) return { tier: "amount_date_1to1", ledger_ids: [oneToOne[0]!.id] };
  const batches = new Map<string, LedgerItem[]>();
  for (const l of ledger) if (l.batch_id) { const a = batches.get(l.batch_id) ?? []; a.push(l); batches.set(l.batch_id, a); }
  for (const [, items] of batches) if (items.reduce((s, i) => s + i.amount_cents, 0n) === line.amount_cents && items.every((i) => Math.abs(daysBetween(i.date, line.value_date)) <= 1)) return { tier: "amount_date_many_to_1", ledger_ids: items.map((i) => i.id) };
  return { tier: "unmatched", ledger_ids: [] };
}
export const BAI2_CATEGORY: Record<string, string> = { "165": "ach_credit", "142": "ach_credit", "168": "ach_credit", "115": "lockbox", "116": "lockbox", "195": "incoming_wire", "555": "returned_item", "451": "ach_debit", "455": "ach_debit", "469": "ach_debit", "475": "check_paid", "495": "outgoing_wire", "560": "bank_fee", "561": "bank_fee", "568": "bank_fee" };
export function controlTotalsOk(creditLines: readonly Cents[], summaryCredits: Cents, debitLines: readonly Cents[], summaryDebits: Cents): boolean { return creditLines.reduce((a, b) => a + b, 0n) === summaryCredits && debitLines.reduce((a, b) => a + b, 0n) === summaryDebits; }

/** 6.3 rule 3 auto-clear windows for in-transit items. */
export function autoClears(kind: "deposit_in_transit" | "disbursement_in_transit", ledgerDate: PlainDate, bankDate: PlainDate): boolean { return businessDaysAfter(ledgerDate, bankDate) <= (kind === "deposit_in_transit" ? 2 : 3); }
function businessDaysAfter(a: PlainDate, b: PlainDate): number { let n = 0, d = a; while (d < b) { d = addDays(d, 1); if (servicer.isBusinessDay(d)) n++; } return n; }

/** 6.3 rule 4 draft variance decomposition against LSDU adjustments. */
export function draftVariance(expected: Cents, bankDebit: Cents, adjustments: readonly { loan: string; amount_cents: Cents; reason: string }[]): { variance_cents: Cents; items: { loan: string; amount_cents: Cents; root_cause: string }[]; residual_to_shortage_surplus_cents: Cents; action: "matched" | "refund_claim" | "remit_shortage_1bd" | "none" } {
  const v = bankDebit - expected;
  const items = adjustments.map((a) => ({ loan: a.loan, amount_cents: -a.amount_cents, root_cause: a.reason }));
  const explained = adjustments.reduce((s, a) => s + a.amount_cents, 0n);
  const residual = v - explained;
  return { variance_cents: v, items, residual_to_shortage_surplus_cents: residual, action: v === 0n ? "matched" : residual > 0n ? "refund_claim" : residual < 0n ? "remit_shortage_1bd" : "none" };
}

/** 6.3 rule 5 shortage funding tiers; due 2 servicer BD 17:00. */
export function shortageFunding(shortfallCents: Cents, identifiedOn: PlainDate, suspiciousDebit = false): { tier: "agent_auto" | "officer_1bd" | "officer_partner_fraud"; due_on: PlainDate; due_at_ms: number } {
  const tier = suspiciousDebit || shortfallCents > 2_500_000n ? "officer_partner_fraud" : shortfallCents > 100_000n ? "officer_1bd" : "agent_auto";
  const due_on = addBusinessDays(identifiedOn, 2, servicer);
  return { tier, due_on, due_at_ms: zonedEpochMs(due_on, "17:00", "America/New_York") };
}
export const RECON_WRITE_OFF_LIMIT_CENTS = 2_500n;   // ≤ $25.00 rounding class (6.3 rule 5)
/** 6.4 rule 3: checks stale after 180 days. */
export function isStaleCheck(issuedOn: PlainDate, asOf: PlainDate): boolean { return daysBetween(issuedOn, asOf) >= 180; }
export function lossDraftAgedMonths(receivedOn: PlainDate, asOf: PlainDate): number { const a = parts(receivedOn), b = parts(asOf); return (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0); }
export function attestationVariance(servicerEnding: Cents, fnmaComputed: Cents, explanation: string | null): { variance_cents: Cents; answer: "Yes" | "No"; gate_open: boolean; commentary: string | null } {
  const v = servicerEnding - fnmaComputed;
  return { variance_cents: v, answer: v === 0n ? "Yes" : "No", gate_open: v === 0n || !!explanation, commentary: v === 0n ? null : explanation };
}
