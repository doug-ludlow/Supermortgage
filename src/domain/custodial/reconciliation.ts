/**
 * §6.3/6.4 Custodial reconciliation — Forms 496/496A composition, the
 * three-way match, auto-clear, draft variance, shortage funding tiers,
 * deadlines (day 45 rolled back), stale checks, the attestation window,
 * the T&I composition snapshot and the workbook/PDF/hash generation the
 * forms' acceptance tests require. bigint cents throughout.
 */
import { createHash } from "node:crypto";
import { type Cents, formatCents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween, parts, ymd } from "../../kernel/calendar/date.ts";
import { rollBack, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { fannieBusinessDay } from "../investor/period.ts";

export interface SectionI { readonly bank_closing_ledger_cents: Cents; readonly deposits_in_transit_cents: Cents; readonly disbursements_in_transit_cents: Cents; readonly adjustments_cents: Cents; }
export function adjustedDepository(s: SectionI): Cents { return s.bank_closing_ledger_cents + s.deposits_in_transit_cents - s.disbursements_in_transit_cents + s.adjustments_cents; }

export interface Form496SS { L3_prepaid_net: Cents; L4_curtailments: Cents; L5_interest_fundings: Cents; L7_payoff_fixed_net: Cents; L8_delinquent_net: Cents; L9_fnma_receivable: Cents; L10_variances: Cents; L11_other: Cents; }
export function form496SS(c: Form496SS): { L12: Cents } { return { L12: c.L3_prepaid_net + c.L4_curtailments + c.L5_interest_fundings + c.L7_payoff_fixed_net + c.L8_delinquent_net + c.L9_fnma_receivable + c.L10_variances + c.L11_other }; }
/** 6.3 rule 6 S/A composition: L2 current-month principal, L3 prepaid net, L4 curtailments/liquidations, L6 payoff interest gains(−)/losses(+), L11 other. */
export interface Form496SA { L2_principal_current: Cents; L3_prepaid_net: Cents; L4_curtailments: Cents; L6_interest_gain_loss: Cents; L11_other: Cents; }
export function form496SA(c: Form496SA): { L12: Cents } { return { L12: c.L2_principal_current + c.L3_prepaid_net + c.L4_curtailments + c.L6_interest_gain_loss + c.L11_other }; }
/**
 * 6.3 rule 6 A/A composition. Line 1 has two bases (edge "A/A auto-draft go-live", LL-2026-05):
 * before go-live L1 = full installments collected and not yet drafted at month-end; after go-live
 * L1 = installments whose payment events Fannie Mae processed with the draft pending (≤ 2 BD).
 */
export type AaLine1Basis = "collected_not_remitted" | "events_processed_draft_pending_2bd";
export interface Form496AA { L1_full_installments_net?: Cents; L1_collected_not_remitted?: Cents; L1_events_processed_draft_pending?: Cents; L11_other: Cents; }
export function form496AA(c: Form496AA, basis: AaLine1Basis = "collected_not_remitted"): { L1: Cents; L1_basis: AaLine1Basis; L12: Cents } {
  const collected = c.L1_collected_not_remitted ?? c.L1_full_installments_net ?? 0n;
  const L1 = basis === "events_processed_draft_pending_2bd" ? (c.L1_events_processed_draft_pending ?? 0n) : collected;
  return { L1, L1_basis: basis, L12: L1 + c.L11_other };
}

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

/**
 * 6.4 rule 4/5 — the T&I composition snapshot (`ti_composition_snapshots`) is derived from the escrow
 * trial balance, the loss-draft and buydown registers and the suspense register at period close: P and N
 * from per-loan balances, loan count and Σ contractual escrow payments from `escrow_accounts` active at
 * period end, the per-category balances the LL-2026-05 attestation is answered from.
 */
export interface EscrowTrialBalanceRow { readonly loan_id: string; readonly balance_cents: Cents; readonly contractual_payment_cents: Cents; readonly category?: "T&I" | "renovation"; }
export interface LossDraftRow { readonly loan_id: string; readonly amount_cents: Cents; readonly received_on: PlainDate; readonly explanation?: string | null; }
export interface TiSnapshotInput { readonly period_end: PlainDate; readonly escrow_accounts: readonly EscrowTrialBalanceRow[]; readonly loss_drafts?: readonly LossDraftRow[]; readonly buydown_cents?: Cents; readonly unapplied_cents?: Cents; readonly advances_funded_cents?: Cents; readonly interest_pending_cents?: Cents; readonly other_cents?: Cents; }
export interface TiSnapshot extends TiComposition { readonly period_end: PlainDate; readonly loan_count: number; readonly contractual_escrow_payment_sum_cents: Cents; readonly ti_ending_cents: Cents; readonly negative_loans: number; readonly by_category: { readonly ti: { ending_cents: Cents; loan_count: number; contractual_sum_cents: Cents }; readonly loss_draft: { ending_cents: Cents; loan_count: number; aged_7m: { loan_id: string; months: number; amount_cents: Cents; explanation: string | null }[] }; readonly buydown: { ending_cents: Cents }; readonly renovation: { ending_cents: Cents; loan_count: number } }; readonly composition: ReturnType<typeof form496A>; }
export function tiCompositionSnapshot(f: TiSnapshotInput): TiSnapshot {
  let P = 0n, N = 0n, contractual = 0n, negatives = 0, tiCount = 0, tiEnding = 0n, tiContractual = 0n, renoEnding = 0n, renoCount = 0;
  for (const a of f.escrow_accounts) {
    if (a.balance_cents >= 0n) P += a.balance_cents; else { N += -a.balance_cents; negatives++; }
    contractual += a.contractual_payment_cents;
    if (a.category === "renovation") { renoEnding += a.balance_cents; renoCount++; } else { tiEnding += a.balance_cents; tiCount++; tiContractual += a.contractual_payment_cents; }
  }
  const drafts = f.loss_drafts ?? [];
  const LD = drafts.reduce((s, d) => s + d.amount_cents, 0n);
  const aged = drafts.map((d) => ({ loan_id: d.loan_id, months: lossDraftAgedMonths(d.received_on, f.period_end), amount_cents: d.amount_cents, explanation: d.explanation ?? null })).filter((d) => d.months >= 7);
  const c: TiComposition = { P, N, A: f.advances_funded_cents ?? N, LD, U: f.unapplied_cents ?? 0n, BD: f.buydown_cents ?? 0n, I: f.interest_pending_cents ?? 0n, O: f.other_cents ?? 0n };
  return { ...c, period_end: f.period_end, loan_count: f.escrow_accounts.length, contractual_escrow_payment_sum_cents: contractual, ti_ending_cents: P - N, negative_loans: negatives,
    by_category: { ti: { ending_cents: tiEnding, loan_count: tiCount, contractual_sum_cents: tiContractual }, loss_draft: { ending_cents: LD, loan_count: drafts.length, aged_7m: aged }, buydown: { ending_cents: c.BD }, renovation: { ending_cents: renoEnding, loan_count: renoCount } },
    composition: form496A(c) };
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
/** BAI2 type-code family (rule 2(iv) — instrument the residual came in on). Bank-specific usage [UNVERIFIED]. */
export type Bai2Family = "ach_credit" | "lockbox" | "incoming_wire" | "returned_item" | "ach_debit" | "check_paid" | "outgoing_wire" | "bank_fee" | "other";
export const BAI2_FAMILY: Readonly<Record<string, Bai2Family>> = { "165": "ach_credit", "142": "ach_credit", "168": "ach_credit", "115": "lockbox", "116": "lockbox", "195": "incoming_wire", "555": "returned_item", "451": "ach_debit", "455": "ach_debit", "469": "ach_debit", "475": "check_paid", "495": "outgoing_wire", "560": "bank_fee", "561": "bank_fee", "568": "bank_fee" };
/** `reconciliation_items.category` (6.3 data model enum) a residual bank line opens, inferred from its type code. */
export type ReconciliationCategory = "deposit_in_transit" | "disbursement_in_transit" | "bank_credit_unposted" | "bank_debit_unposted" | "draft_variance" | "returned_item" | "bank_fee" | "interest_credit" | "timing_difference" | "duplicate_posting" | "posting_error" | "servicing_fee_sweep_variance" | "advance_recovery_variance" | "pool_allocation_variance" | "title_mismatch" | "statement_missing" | "control_total_mismatch" | "fnma_receivable_variance" | "outstanding_check" | "stale_check" | "escrow_advance_unfunded" | "attestation_variance" | "loss_draft_aged_7m" | "unapplied_aged";
export const BAI2_CATEGORY: Readonly<Record<string, ReconciliationCategory>> = { "165": "bank_credit_unposted", "142": "bank_credit_unposted", "168": "bank_credit_unposted", "115": "bank_credit_unposted", "116": "bank_credit_unposted", "195": "bank_credit_unposted", "555": "returned_item", "451": "bank_debit_unposted", "455": "bank_debit_unposted", "469": "bank_debit_unposted", "475": "bank_debit_unposted", "495": "bank_debit_unposted", "560": "bank_fee", "561": "bank_fee", "568": "bank_fee" };
export function residualCategory(typeCode: string | undefined, direction: "credit" | "debit"): ReconciliationCategory { return (typeCode && BAI2_CATEGORY[typeCode]) || (direction === "credit" ? "bank_credit_unposted" : "bank_debit_unposted"); }
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
/** 6.3 rule 5 / item state machine: `written_off` only via `officer` with a reason, and only in the ≤ $25.00 rounding class. */
export function reconWriteOff(f: { amount_cents: Cents; actor_is_officer: boolean; reason: string }): { allowed: boolean; refusal: string | null; limit_cents: Cents } {
  const abs = f.amount_cents < 0n ? -f.amount_cents : f.amount_cents;
  if (!f.actor_is_officer) return { allowed: false, refusal: "reconciliation write-offs need officer sign-off", limit_cents: RECON_WRITE_OFF_LIMIT_CENTS };
  if (abs > RECON_WRITE_OFF_LIMIT_CENTS) return { allowed: false, refusal: `${formatCents(abs)} exceeds the ${formatCents(RECON_WRITE_OFF_LIMIT_CENTS)} rounding class — fund or clear instead`, limit_cents: RECON_WRITE_OFF_LIMIT_CENTS };
  if (!f.reason.trim()) return { allowed: false, refusal: "a write-off carries the officer's reason", limit_cents: RECON_WRITE_OFF_LIMIT_CENTS };
  return { allowed: true, refusal: null, limit_cents: RECON_WRITE_OFF_LIMIT_CENTS };
}
/** 6.4 rule 3: checks stale after 180 days. */
export function isStaleCheck(issuedOn: PlainDate, asOf: PlainDate): boolean { return daysBetween(issuedOn, asOf) >= 180; }
export function lossDraftAgedMonths(receivedOn: PlainDate, asOf: PlainDate): number { const a = parts(receivedOn), b = parts(asOf); return (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0); }
export function attestationVariance(servicerEnding: Cents, fnmaComputed: Cents, explanation: string | null): { variance_cents: Cents; answer: "Yes" | "No"; gate_open: boolean; commentary: string | null } {
  const v = servicerEnding - fnmaComputed;
  return { variance_cents: v, answer: v === 0n ? "Yes" : "No", gate_open: v === 0n || !!explanation, commentary: v === 0n ? null : explanation };
}

/**
 * 6.4 rule 2 / T2: negative escrow balances not covered by advances open `escrow_advance_unfunded`
 * and start `SM_TI_ESCROW_ADVANCE_FUND_1BD`; corporate funding by the next BD clears it.
 */
export function escrowAdvanceFunding(f: { negatives: readonly { loan_id: string; balance_cents: Cents }[]; advances_funded_cents: Cents; detected_on: PlainDate; funded_on: PlainDate | null; funded_cents: Cents }): { N: Cents; A: Cents; unfunded_cents: Cents; item: { category: "escrow_advance_unfunded"; amount_cents: Cents; loans: string[]; status: "open" | "cleared" | "breached" } | null; timer: "SM_TI_ESCROW_ADVANCE_FUND_1BD"; due_on: PlainDate; satisfied_by: "custodial.advance.funded"; escalation: { role: "officer"; severity: "high" } | null } {
  const N = f.negatives.reduce((s, n) => s + (n.balance_cents < 0n ? -n.balance_cents : n.balance_cents), 0n);
  const unfunded = N - f.advances_funded_cents > 0n ? N - f.advances_funded_cents : 0n;
  const due_on = addBusinessDays(f.detected_on, 1, servicer);
  const cleared = unfunded > 0n && f.funded_on !== null && f.funded_cents >= unfunded && f.funded_on <= due_on;
  const breached = unfunded > 0n && !cleared && f.funded_on !== null && f.funded_on > due_on;
  return { N, A: f.advances_funded_cents, unfunded_cents: unfunded, item: unfunded > 0n ? { category: "escrow_advance_unfunded", amount_cents: unfunded, loans: f.negatives.filter((n) => n.balance_cents < 0n).map((n) => n.loan_id), status: cleared ? "cleared" : breached ? "breached" : "open" } : null,
    timer: "SM_TI_ESCROW_ADVANCE_FUND_1BD", due_on, satisfied_by: "custodial.advance.funded", escalation: breached ? { role: "officer", severity: "high" } : null };
}

/** 6.4 rule 3 / T4: at 180 days a check is `stale` — void through positive pay, restore the funds to the originating balance, then reissue or enter 6.5's unclaimed-property track. */
export function staleCheckWorkflow(f: { check_number: string; payee: string; issued_on: PlainDate; amount_cents: Cents; as_of: PlainDate; originating_balance: "refund_payable" | "escrow" | "loss_draft_liability"; custodial_account_id: string; payee_confirmed: boolean }): { stale: boolean; stale_on: PlainDate; status: "outstanding" | "stale"; actions: string[]; restore_entry: { description: string; lines: { account: string; amount_cents: Cents; rule_ref: string }[] } | null; next: "reissue" | "unclaimed_property_6_5" | null; suspense_item: { source: "refund_returned"; reason_code: "returned_refund"; amount_cents: Cents; dormancy_start_on: PlainDate } | null } {
  const stale_on = addDays(f.issued_on, 180);
  if (!isStaleCheck(f.issued_on, f.as_of)) return { stale: false, stale_on, status: "outstanding", actions: [], restore_entry: null, next: null, suspense_item: null };
  const restore = { description: `void stale check ${f.check_number} (${f.payee}); funds restored to ${f.originating_balance}`, lines: [{ account: `custodial_ti_cash:${f.custodial_account_id}`, amount_cents: f.amount_cents, rule_ref: "6.4 rule 3 stale check" }, { account: f.originating_balance, amount_cents: -f.amount_cents, rule_ref: "6.4 rule 3 stale check" }] };
  const next = f.payee_confirmed ? "reissue" as const : "unclaimed_property_6_5" as const;
  return { stale: true, stale_on, status: "stale", actions: ["positive_pay.void", `restore_${f.originating_balance}`, next === "reissue" ? "reissue_check" : "open_6_5_unclaimed_property"], restore_entry: restore, next,
    suspense_item: next === "unclaimed_property_6_5" ? { source: "refund_returned", reason_code: "returned_refund", amount_cents: f.amount_cents, dormancy_start_on: f.issued_on } : null };
}

// ---- workbook / PDF / hashes (6.3-T1, 6.4-T1) ------------------------------
/** `form_templates` row: the official Excel template (hashed, registered) and its validated cell map (field → cell). Template hash/cell map [UNVERIFIED — registered at intake]. */
export interface FormTemplate { readonly form: "496" | "496A"; readonly version_label: string; readonly sha256: string; readonly cell_map: Readonly<Record<string, string>>; }
export const FORM_496_TEMPLATE: FormTemplate = { form: "496", version_label: "Form 496 (SVC-2026-01 Excel)", sha256: "unregistered-template-hash-496", cell_map: {
  servicer_number: "C3", period: "C4", custodial_account: "C5", remittance_type: "C6",
  "I.1": "D9", "I.2": "D10", "I.3": "D11", "I.4": "D12", "I.5": "D13", "I.6": "D14", "I.7": "D15",
  "II.1": "D18", "II.2": "D19", "II.3": "D20", "II.4": "D21", "II.5": "D22", "II.6": "D23", "II.7": "D24", "II.8": "D25", "II.9": "D26", "II.10": "D27", "II.11": "D28", "II.12": "D29",
  "III.deposits_in_transit": "B33", "III.disbursements_in_transit": "B40", "III.adjustments": "B47",
} };
export const FORM_496A_TEMPLATE: FormTemplate = { form: "496A", version_label: "Form 496A (SVC-2026-01 Excel)", sha256: "unregistered-template-hash-496a", cell_map: {
  servicer_number: "C3", period: "C4", custodial_account: "C5",
  "I.1": "D9", "I.2": "D10", "I.3": "D11", "I.4": "D12", "I.5": "D13", "I.6": "D14", "I.7": "D15",
  "II.1": "D18", "II.2": "D19", "II.3": "D20", "II.4": "D21", "II.5": "D22", "II.6": "D23", "II.7": "D24",
  "III.deposits_in_transit": "B28", "III.disbursements_in_transit": "B35", "III.adjustments": "B42", "III.loss_drafts_aged_7m": "B49", "III.unapplied_needing_resolution": "B56",
} };
export interface Workbook { readonly template_sha256: string; readonly cells: Readonly<Record<string, string>>; readonly populated_fields: readonly string[]; readonly missing_fields: readonly string[]; readonly xlsx: { readonly content: string; readonly sha256: string }; readonly pdf: { readonly text: string; readonly sha256: string }; }
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const cellText = (v: unknown): string => typeof v === "bigint" ? formatCents(v) : Array.isArray(v) ? v.map((x) => cellText(x)).join("; ") : v === null || v === undefined ? "" : typeof v === "object" ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${cellText(x)}`).join(", ") : String(v);
/** Populate the registered template's cell map from the form values (cents render as $ amounts), render the PDF text and hash both artifacts. */
export function formWorkbook(template: FormTemplate, values: Readonly<Record<string, unknown>>): Workbook {
  const cells: Record<string, string> = {}; const populated: string[] = []; const missing: string[] = [];
  for (const [field, cell] of Object.entries(template.cell_map)) { if (values[field] === undefined) { missing.push(field); continue; } cells[cell] = cellText(values[field]); populated.push(field); }
  const xlsxContent = JSON.stringify({ template: template.version_label, template_sha256: template.sha256, cells: Object.fromEntries(Object.keys(cells).sort().map((c) => [c, cells[c]!])) });
  const pdfText = [`Fannie Mae Form ${template.form} — ${template.version_label}`, ...populated.map((f) => `${f}: ${cells[template.cell_map[f]!]!}`)].join("\n");
  return { template_sha256: template.sha256, cells, populated_fields: populated, missing_fields: missing, xlsx: { content: xlsxContent, sha256: sha256(xlsxContent) }, pdf: { text: pdfText, sha256: sha256(pdfText) } };
}

/** 6.3 timer table / T9: draft coverage on the day before the draft uses the intraday *available* balance (rule 1); a shortfall is topped up from corporate the same day (`officer`, critical; command auto-prepared). */
export function draftCoverage(f: { expected_draft_cents: Cents; intraday_available_cents: Cents; as_of: PlainDate }): { covered: boolean; shortfall_cents: Cents; action: "corporate_top_up_same_day" | null; top_up_by: PlainDate | null; balance_basis: "available_045_CLAV"; escalation: { role: "officer"; severity: "critical" } | null } {
  const short = f.expected_draft_cents - f.intraday_available_cents;
  const covered = short <= 0n;
  return { covered, shortfall_cents: covered ? 0n : short, action: covered ? null : "corporate_top_up_same_day", top_up_by: covered ? null : f.as_of, balance_basis: "available_045_CLAV", escalation: covered ? null : { role: "officer", severity: "critical" } };
}
