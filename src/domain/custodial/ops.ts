/**
 * §6 mechanics beyond the calculators in accounts/reconciliation/suspense:
 * executed-form verification, the 3-BD ineligibility notice outcome and the
 * DocuSign-declined path (6.1); interest-disposition postings, breach/late
 * handling, T&I unmatched debits and the ledger's allowed-transfer matrix
 * (6.2); the period-close event that arms the 45-day timers, the Form 496
 * timer outcome, unidentified-debit fraud path, unposted bank credits →
 * suspense, bank-fee reimbursement, statement quarantine, reviewer rework,
 * approval reminder, retro-corrections, the LL-2026-05 A/A line-1 switch and
 * the form generator (workbook cells, PDF render, hashes) (6.3); paid-not-
 * issued checks, aged loss drafts, the attestation tie-out and gate (6.4);
 * partial accumulation, day-30 returns, the $50 rule, Reg Z crediting on
 * accumulation, suspense aging and the AI-outreach warm transfer (6.5).
 * bigint cents throughout.
 */
import { addDays, daysBetween, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { type Cents, formatCents } from "../../kernel/money/cents.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { interestDispositionDueMs, ineligibilityNoticeDueMs, disposeInterest, fdicUninsuredExposure, formMachine, type FormStatus } from "./accounts.ts";
import { form496Deadline, shortageFunding, controlTotalsOk, matchBankLine, lossDraftAgedMonths, residualCategory, BAI2_FAMILY, form496SS, form496SA, form496AA, form496A, reconcile, formWorkbook, attestationWindow, attestationVariance, FORM_496_TEMPLATE, FORM_496A_TEMPLATE, type BankLine, type LedgerItem, type SectionI, type FormTemplate, type Workbook, type AaLine1Basis, type Bai2Family, type ReconciliationCategory, type Form496AA, type Form496SS, type Form496SA, type TiComposition } from "./reconciliation.ts";
import { agingDays, identify, isSuspenseTerminal, type Receipt, type CandidateLoan } from "./suspense.ts";
import { handleUtterance } from "../servicing-requests/ops.ts";

export const ET = "America/New_York";
/** A balanced posting plan (debit +, credit −) the 6.x tools hand to `ledger.post*`; `account` is the spec's ledger account name. */
export interface PostingLine { readonly account: string; readonly loan_id?: string; readonly amount_cents: Cents; readonly rule_ref: string; }
export interface PostingSet { readonly description: string; readonly effective_on: PlainDate; readonly lines: readonly PostingLine[]; }
export const postingSetBalanced = (s: PostingSet): boolean => s.lines.reduce((a, l) => a + l.amount_cents, 0n) === 0n;

// ---- 6.1 -------------------------------------------------------------------
export interface FormFacts { readonly account_number: string; readonly title: string; readonly aba: string; readonly remittance_type: string; readonly effective_date: PlainDate; }
/** 6.1 agent design: the executed PDF is verified field by field against the plan; any mismatch reopens the portal task and the form is never `in_effect` without the executed document hash. */
export function verifyExecutedForm(f: { plan: FormFacts; executed: FormFacts; executed_document_hash: string | null }): { matches: boolean; mismatches: (keyof FormFacts)[]; in_effect: boolean; reopen_task: boolean; reason: string | null } {
  const keys: (keyof FormFacts)[] = ["account_number", "title", "aba", "remittance_type", "effective_date"];
  const mismatches = keys.filter((k) => f.plan[k] !== f.executed[k]);
  if (mismatches.length) return { matches: false, mismatches, in_effect: false, reopen_task: true, reason: `executed form differs from the plan: ${mismatches.join(", ")}` };
  if (!f.executed_document_hash) return { matches: true, mismatches: [], in_effect: false, reopen_task: false, reason: "no executed document hash" };
  return { matches: true, mismatches: [], in_effect: true, reopen_task: false, reason: null };
}
/** 6.1-T5 / FNMA_A4102_DEPOSITORY_INELIGIBLE_NOTIFY_3BD: satisfied by `custodial.depository.fnma_notified` by day 3 (17:00 ET); otherwise breached with an `officer` critical escalation. */
export function ineligibilityNoticeOutcome(f: { detected_on: PlainDate; notified_at_ms: number | null; now_ms: number }): { due_at_ms: number; due_on: PlainDate; status: "satisfied" | "armed" | "breached" | "satisfied_late"; satisfied_by: "custodial.depository.fnma_notified"; escalation: { role: "officer"; severity: "critical" } | null; recipients: ["custodial_account@fanniemae.com", "partner"] } {
  const due = ineligibilityNoticeDueMs(f.detected_on);
  const due_on = wallClock(due, ET).date;
  const base = { due_at_ms: due, due_on, satisfied_by: "custodial.depository.fnma_notified" as const, recipients: ["custodial_account@fanniemae.com", "partner"] as ["custodial_account@fanniemae.com", "partner"] };
  if (f.notified_at_ms !== null && f.notified_at_ms <= due) return { ...base, status: "satisfied", escalation: null };
  if (f.notified_at_ms !== null) return { ...base, status: "satisfied_late", escalation: { role: "officer", severity: "critical" } };
  const breached = f.now_ms > due;
  return { ...base, status: breached ? "breached" : "armed", escalation: breached ? { role: "officer", severity: "critical" } : null };
}
/** 6.1 rule 5 worked example: a rating downgrade below the eligibility floor → `ineligible_detected`, account on `watch`, uninsured exposure, remedy plan, and the CUST-DEP-INELIG-v1 notice payload for the Fannie Mae custodial team (A4-1-02). */
export function ineligibleDepositoryPackage(f: { depository_name: string; aba: string; agency: "idc" | "kbra" | "sp" | "moodys"; prior_rating: string | number; new_rating: string | number; floor: string | number; detected_on: PlainDate; balances_cents: readonly { account_id: string; balance_cents: Cents }[]; replacement_depository: string; next_remittance_on: PlainDate }): { event: "custodial.depository.ineligible_detected"; account_status: "watch"; due_at_ms: number; exposure_cents: Cents; remedy: { replacement_depository: string; migrate_by: PlainDate; interim: "keep balances fully insured or transfer at Fannie Mae's direction" }; notice: { template: "CUST-DEP-INELIG-v1"; citation: "A4-1-02"; to: "custodial_account@fanniemae.com"; cc: "partner"; payload: Record<string, unknown> } } {
  const exposure = f.balances_cents.reduce((s, b) => s + fdicUninsuredExposure(b.balance_cents), 0n);
  const due = ineligibilityNoticeDueMs(f.detected_on);
  const payload = { depository_name: f.depository_name, aba: f.aba, agency: f.agency.toUpperCase(), prior_rating: String(f.prior_rating), new_rating: String(f.new_rating), floor: String(f.floor), detected_on: f.detected_on, notify_by: wallClock(due, ET).date, exposure_cents: exposure, replacement_depository: f.replacement_depository, migrate_by: f.next_remittance_on, balances: f.balances_cents.map((b) => ({ account_id: b.account_id, balance_cents: b.balance_cents })), partner_copied: true, cbam_note: true };
  return { event: "custodial.depository.ineligible_detected", account_status: "watch", due_at_ms: due, exposure_cents: exposure, remedy: { replacement_depository: f.replacement_depository, migrate_by: f.next_remittance_on, interim: "keep balances fully insured or transfer at Fannie Mae's direction" }, notice: { template: "CUST-DEP-INELIG-v1", citation: "A4-1-02", to: "custodial_account@fanniemae.com", cc: "partner", payload } };
}
export interface DeclineTimerPort { open(): readonly { id: string; code: string; subject: { kind: string; id: string } }[]; cancel(id: string, reason: string, actor?: Actor): void; all(): readonly { id: string; status: string; cancelledReason?: string }[]; }
export interface DeclineEscalationPort { open(input: { kind: "officer"; ownerRole?: string; severity?: string; payload?: Record<string, unknown> }, by: Actor): { id: string }; }
/**
 * 6.1-T8 / edge "Depository declines the DocuSign": the form goes `signatures_declined`, an `officer`
 * escalation is opened with the Guide title language and Fannie Mae's contact attached, no funds move, and
 * every open timer on the form is cancelled with a reason — never deleted (append-only timer history).
 */
export function formDeclined(f: { form_id: string; status: FormStatus; declined_by: string; reason: string; actor: Actor; timers: DeclineTimerPort; escalations: DeclineEscalationPort }): { status: FormStatus; escalation_id: string; timers_cancelled: { id: string; code: string; reason: string }[]; timers_deleted: 0; funds_moved: false; attachments: ["F-1-03 title language", "custodial_account@fanniemae.com"] } {
  const t = formMachine.attempt(f.status, "declined", f.actor, {});
  if (!t.ok) throw new RangeError(`form ${f.form_id}: ${t.reason}`);
  const before = f.timers.all().length;
  const reason = `DocuSign declined by ${f.declined_by}: ${f.reason}`;
  const cancelled: { id: string; code: string; reason: string }[] = [];
  for (const inst of f.timers.open()) if (inst.subject.kind === "custodial_form" && inst.subject.id === f.form_id) { f.timers.cancel(inst.id, reason, f.actor); cancelled.push({ id: inst.id, code: inst.code, reason }); }
  if (f.timers.all().length !== before) throw new RangeError("timer rows are append-only: a cancel never deletes");
  const esc = f.escalations.open({ kind: "officer", severity: "high", payload: { form_id: f.form_id, event: "custodial.form.signatures_declined", declined_by: f.declined_by, reason: f.reason, attachments: ["F-1-03 title language", "custodial_account@fanniemae.com"], funds_moved: false, timers_cancelled: cancelled.map((c) => c.code) } }, f.actor);
  return { status: t.to, escalation_id: esc.id, timers_cancelled: cancelled, timers_deleted: 0, funds_moved: false, attachments: ["F-1-03 title language", "custodial_account@fanniemae.com"] };
}

// ---- 6.2 -------------------------------------------------------------------
/** 6.2-T4: no disposition by day 30 → breach, `officer` medium, and the credit appears as an aged "Other" item on Form 496A line 6; a disposition after day 30 closes the item but the breach (and its escalation) stands as `satisfied_late`. */
export function interestDispositionStatus(f: { credited_on: PlainDate; amount_cents: Cents; disposed_at_ms: number | null; now_ms: number }): { due_ms: number; status: "satisfied" | "armed" | "breached" | "satisfied_late"; escalation: { role: "officer"; severity: "medium" } | null; form496a_item: { line: 6; category: "Other"; description: string; amount_cents: Cents; aging_days: number } | null } {
  const due = interestDispositionDueMs(f.credited_on);
  if (f.disposed_at_ms !== null && f.disposed_at_ms <= due) return { due_ms: due, status: "satisfied", escalation: null, form496a_item: null };
  if (f.disposed_at_ms !== null) return { due_ms: due, status: "satisfied_late", escalation: { role: "officer", severity: "medium" }, form496a_item: null };
  const breached = f.now_ms > due;
  const aging = daysBetween(f.credited_on, wallClock(f.now_ms, ET).date);
  return { due_ms: due, status: breached ? "breached" : "armed", escalation: breached ? { role: "officer", severity: "medium" } : null, form496a_item: { line: 6, category: "Other", description: `interest credited ${f.credited_on} pending disposition`, amount_cents: f.amount_cents, aging_days: aging } };
}
/**
 * 6.2 rule 2/3, T2/T3: the disposition postings for one interest credit — per-loan escrow credits
 * (Dr interest_payable_borrowers / Cr escrow_liability), the fee transfer and the corporate sweep, each a
 * balanced set; when statutory interest exceeds I − E corporate funds the shortfall (an `officer` decision,
 * ledger `corporate_expense_escrow_interest`, never `servicer_advance_receivable`). "Interest pending" is
 * the control balance the composition carries on line 6; it returns to zero on the final posting, which is
 * what satisfies FNMA_A4102_TI_INTEREST_DISBURSE_30 (`custodial.interest.disbursed`).
 */
export function interestDispositionPostings(f: { credit_id: string; custodial_account_id: string; credited_on: PlainDate; amount_cents: Cents; admin_expense_cents: Cents; allocations: readonly { loan_id: string; statutory_cents: Cents }[]; posted_on: PlainDate }): { disposition: ReturnType<typeof disposeInterest>; sets: PostingSet[]; interest_pending_after_cents: Cents; due_at_ms: number; on_time: boolean; timer_satisfied_by: "custodial.interest.disbursed"; escalation: { role: "officer"; reason: string } | null; memo: { template: "CUST-TI-INT-DISP-v1"; citation: "A4-1-02"; payload: Record<string, unknown> } } {
  const toBorrowers = f.allocations.reduce((s, a) => s + a.statutory_cents, 0n);
  const d = disposeInterest(f.amount_cents, f.admin_expense_cents, toBorrowers);
  const cash = `custodial_ti_cash:${f.custodial_account_id}`, pending = `interest_pending:${f.custodial_account_id}`;
  const sets: PostingSet[] = [{ description: `bank interest credit ${f.credit_id}`, effective_on: f.credited_on, lines: [{ account: cash, amount_cents: f.amount_cents, rule_ref: "6.2 rule 2 credit" }, { account: pending, amount_cents: -f.amount_cents, rule_ref: "6.2 rule 2 credit" }] }];
  if (d.corporate_funds_shortfall_cents > 0n) sets.push({ description: "corporate funds the statutory-interest shortfall", effective_on: f.posted_on, lines: [{ account: "corporate_expense_escrow_interest", amount_cents: d.corporate_funds_shortfall_cents, rule_ref: "6.2 rule 2(c)" }, { account: "corporate_cash", amount_cents: -d.corporate_funds_shortfall_cents, rule_ref: "6.2 rule 2(c)" }, { account: cash, amount_cents: d.corporate_funds_shortfall_cents, rule_ref: "6.2 rule 2(c)" }, { account: pending, amount_cents: -d.corporate_funds_shortfall_cents, rule_ref: "6.2 rule 2(c)" }] });
  if (toBorrowers > 0n) sets.push({ description: `statutory escrow interest to ${f.allocations.length} borrowers`, effective_on: f.posted_on, lines: [{ account: pending, amount_cents: toBorrowers, rule_ref: "6.2 rule 2(b); 3.9" }, ...f.allocations.map((a) => ({ account: "escrow_liability", loan_id: a.loan_id, amount_cents: -a.statutory_cents, rule_ref: "6.2 rule 2(b); 3.9" }))] });
  if (f.admin_expense_cents > 0n) sets.push({ description: "bank analysis fees to corporate", effective_on: f.posted_on, lines: [{ account: pending, amount_cents: f.admin_expense_cents, rule_ref: "6.2 rule 2(a)" }, { account: cash, amount_cents: -f.admin_expense_cents, rule_ref: "6.2 rule 2(a)" }, { account: "corporate_cash", amount_cents: f.admin_expense_cents, rule_ref: "6.2 rule 2(a)" }, { account: "corporate_bank_fee_recovery", amount_cents: -f.admin_expense_cents, rule_ref: "6.2 rule 2(a)" }] });
  if (d.to_corporate_cents > 0n) sets.push({ description: "residual interest to corporate", effective_on: f.posted_on, lines: [{ account: pending, amount_cents: d.to_corporate_cents, rule_ref: "6.2 rule 2(c)" }, { account: cash, amount_cents: -d.to_corporate_cents, rule_ref: "6.2 rule 2(c)" }, { account: "corporate_cash", amount_cents: d.to_corporate_cents, rule_ref: "6.2 rule 2(c)" }, { account: "corporate_interest_income", amount_cents: -d.to_corporate_cents, rule_ref: "6.2 rule 2(c)" }] });
  const pendingAfter = -sets.flatMap((s) => s.lines).filter((l) => l.account === pending).reduce((a, l) => a + l.amount_cents, 0n);
  const due = interestDispositionDueMs(f.credited_on);
  const on_time = zonedEpochMs(f.posted_on, "17:00", ET) <= due;
  const shortfall = d.corporate_funds_shortfall_cents > 0n;
  const payload = { credit_id: f.credit_id, custodial_account_id: f.custodial_account_id, credited_on: f.credited_on, amount_cents: f.amount_cents, admin_expense_cents: f.admin_expense_cents, to_borrowers_cents: d.to_borrowers_cents, to_corporate_cents: d.to_corporate_cents, corporate_funds_shortfall_cents: d.corporate_funds_shortfall_cents, loan_count: f.allocations.length, disburse_by: wallClock(due, ET).date, posted_on: f.posted_on, on_time };
  return { disposition: d, sets, interest_pending_after_cents: pendingAfter, due_at_ms: due, on_time, timer_satisfied_by: "custodial.interest.disbursed", escalation: shortfall ? { role: "officer", reason: `to_borrowers ${formatCents(toBorrowers)} > I − E ${formatCents(f.amount_cents - f.admin_expense_cents)}: corporate funds ${formatCents(d.corporate_funds_shortfall_cents)}` } : null, memo: { template: "CUST-TI-INT-DISP-v1", citation: "A4-1-02", payload } };
}
/** 6.2-T6: a T&I statement debit with no `disbursements` match within 1 BD → `unmatched_debit` (high) and the bank's positive-pay exception list is pulled. */
export function tiUnmatchedDebit(f: { debit: BankLine; disbursements: readonly LedgerItem[]; as_of: PlainDate }): { exception: { code: "unmatched_debit"; severity: "high"; amount_cents: Cents; debit_id: string } | null; actions: string[]; matched_ids: string[] } {
  const m = matchBankLine(f.debit, f.disbursements);
  if (m.tier !== "unmatched") return { exception: null, actions: [], matched_ids: m.ledger_ids };
  if (f.as_of < addBusinessDays(f.debit.value_date, 1, servicer)) return { exception: null, actions: ["wait_1bd"], matched_ids: [] };
  return { exception: { code: "unmatched_debit", severity: "high", amount_cents: f.debit.amount_cents, debit_id: f.debit.id }, actions: ["pull_positive_pay_exception_list", "open_exception"], matched_ids: [] };
}
/**
 * 6.2 guardrail / 6.4 guardrail — the ledger's allowed-transfer matrix, evaluated on the accounts an entry
 * set actually touches (not a self-declared destination): T&I cash moves only against another
 * `custodial_ti_*` account, the clearing/boarding accounts (deposits in), corporate cash / the corporate
 * interest-fee accounts (corporate ↔ T&I), or a borrower's own escrow / suspense / escrow-advance balance
 * (T&I → payee/borrower). P&I and T&I never commingle, and no set moves funds between two borrowers'
 * escrow balances.
 */
export interface EntryLineLike { readonly account: { readonly scope: string; readonly account: string; readonly loanId?: string; readonly custodialAccountId?: string }; readonly amountCents: Cents; }
const TI_CORPORATE_OK = /^(corporate_cash|advance_receivable|corporate_interest_income|corporate_bank_fee_recovery|corporate_expense_escrow_interest|interest_due_corporate)$/;
const TI_LOAN_OK = /^(escrow|escrow_advance|suspense_unapplied)$/;
export function tiTransferMatrixViolation(set: { readonly lines?: readonly EntryLineLike[] } | undefined): string | undefined {
  const lines = set?.lines ?? [];
  if (!lines.length) return undefined;
  const escrowByLoan = new Map<string, Cents>();
  for (const l of lines) if (l.account.scope === "loan" && l.account.account === "escrow") escrowByLoan.set(l.account.loanId ?? "?", (escrowByLoan.get(l.account.loanId ?? "?") ?? 0n) + l.amountCents);
  const sums = [...escrowByLoan.values()];
  if (sums.some((s) => s > 0n) && sums.some((s) => s < 0n)) return "funds may not move between borrowers' escrow balances (6.4 guardrail)";
  const ti = lines.filter((l) => l.account.scope === "custodial" && /^custodial_ti/.test(l.account.account));
  if (!ti.length) return undefined;
  for (const l of lines) {
    if (l.account.scope === "custodial") { if (l.account.account === "custodial_pi_cash") return "P&I and T&I funds never commingle (A4-1-02)"; continue; }
    if (l.account.scope === "corporate") { if (!TI_CORPORATE_OK.test(l.account.account)) return `T&I funds may not move to corporate account ${l.account.account}; only corporate cash and the interest/fee accounts are in the matrix`; continue; }
    if (l.account.scope === "loan") { if (!TI_LOAN_OK.test(l.account.account)) return `T&I funds may not move to loan account ${l.account.account}; only the borrower's escrow, suspense or escrow-advance balance is in the matrix`; continue; }
    return `T&I funds may not move to ${l.account.scope}:${l.account.account}`;
  }
  return undefined;
}
/** 6.4 agent design: `ledger.post_advance` is corporate → T&I only (Dr custodial_ti_* / Cr corporate). */
export function advanceDirectionViolation(set: { readonly lines?: readonly EntryLineLike[] } | undefined): string | undefined {
  const lines = set?.lines ?? [];
  if (!lines.length) return undefined;
  for (const l of lines) {
    const ti = l.account.scope === "custodial" && /^custodial_ti/.test(l.account.account);
    const corp = l.account.scope === "corporate" && /^(corporate_cash|advance_receivable)$/.test(l.account.account);
    if (!ti && !corp) return `ledger.post_advance touches only corporate cash and custodial_ti_* (got ${l.account.scope}:${l.account.account})`;
    if (ti && l.amountCents < 0n) return "ledger.post_advance never withdraws from T&I (corporate → T&I only)";
    if (corp && l.amountCents > 0n) return "ledger.post_advance never credits T&I funds to corporate (corporate → T&I only)";
  }
  return tiTransferMatrixViolation(set);
}

// ---- 6.3 -------------------------------------------------------------------
/**
 * `ledger.period.closed` for a custodial account carries the computed 45-day deadline (day 45 rolled back to
 * the preceding servicer business day, 17:00 local) and the day-30 warning, so the registry rows
 * FNMA_F496_PI_RECON_45 / FNMA_F496A_TI_RECON_45 (offset "0, 17:00" on `recon_due_on`) arm on the spec's date.
 */
export function periodClosedEvent(f: { period_end: PlainDate; account_kind: "pi" | "ti" | "ti_unapplied" | "ti_loss_draft" | "ti_buydown"; custodial_account_id: string; remittance_type?: string }): { type: "ledger.period.closed"; aggregate: { kind: "custodial_account"; id: string }; payload: { period_end: PlainDate; account_kind: string; custodial_account_id: string; remittance_type: string | null; recon_due_on: PlainDate; recon_due_at: string; recon_warning_on: PlainDate; form: "496" | "496A" } } {
  const d = form496Deadline(f.period_end);
  return { type: "ledger.period.closed", aggregate: { kind: "custodial_account", id: f.custodial_account_id }, payload: { period_end: f.period_end, account_kind: f.account_kind, custodial_account_id: f.custodial_account_id, remittance_type: f.remittance_type ?? null, recon_due_on: d.due_on, recon_due_at: new Date(d.due_at_ms).toISOString(), recon_warning_on: d.warning_on, form: f.account_kind === "pi" ? "496" : "496A" } };
}
/** 6.3-T3 / 6.4-T8: the 45-day form timer is satisfied only by `custodial.reconciliation.completed`; a breach is `officer` critical + partner notice + a Compliance Sentinel line. */
export function form496TimerOutcome(f: { kind: "monthly_form_496" | "monthly_form_496a"; period_end: PlainDate; completed_at_ms: number | null; now_ms: number }): { due_at_ms: number; due_on: PlainDate; warning_on: PlainDate; status: "satisfied" | "armed" | "breached"; escalation: { role: "officer"; severity: "critical" } | null; partner_notice: boolean; sentinel_line: string | null } {
  const d = form496Deadline(f.period_end);
  if (f.completed_at_ms !== null && f.completed_at_ms <= d.due_at_ms) return { ...d, status: "satisfied", escalation: null, partner_notice: false, sentinel_line: null };
  const breached = f.now_ms > d.due_at_ms;
  return { ...d, status: breached ? "breached" : "armed", escalation: breached ? { role: "officer", severity: "critical" } : null, partner_notice: breached, sentinel_line: breached ? `${f.kind} for period ending ${f.period_end} not completed by ${d.due_on} 17:00 (45-day custodial reconciliation, Fannie Mae A4-1-02)` : null };
}
/** 6.3-T5 / rule 5: an unmatched bank debit absent from Draft Notifications and CRS reports is a suspected unauthorized debit — critical, `fraud` case, same-day bank contact, funding tier, `officer`. */
export function unidentifiedDebit(f: { amount_cents: Cents; type_code: string; in_draft_notifications: boolean; in_crs_reports: boolean; identified_on: PlainDate }): { severity: "critical" | null; fraud_case: boolean; bank_contact_by: PlainDate | null; funding: ReturnType<typeof shortageFunding> | null; escalation: "officer" | null; category: ReconciliationCategory; instrument: Bai2Family } {
  const category = residualCategory(f.type_code, "debit");
  const instrument = BAI2_FAMILY[f.type_code] ?? "other";
  if (f.in_draft_notifications || f.in_crs_reports) return { severity: null, fraud_case: false, bank_contact_by: null, funding: null, escalation: null, category, instrument };
  return { severity: "critical", fraud_case: true, bank_contact_by: f.identified_on, funding: shortageFunding(f.amount_cents, f.identified_on, true), escalation: "officer", category, instrument };
}
/**
 * 6.3-T4 / rule 2(iv) / 6.5 rule 1 (worked example B): a bank credit with no ledger match opens item
 * `bank_credit_unposted` and a `suspense_items` row the same day; it posts to a loan only on a ≥ 0.97
 * unique identification (then the item clears the same day), otherwise the row goes to research/contact.
 */
export function openBankCreditUnposted(f: { line: BankLine; ledger: readonly LedgerItem[]; today: PlainDate; custodial_account_id: string; candidates?: readonly CandidateLoan[]; receipt?: Receipt }): { matched: boolean; item: { category: "bank_credit_unposted"; amount_cents: Cents; first_seen_on: PlainDate; loan_id: string | null; status: "open" | "cleared"; root_cause: string } | null; suspense_item: { source: "bank_credit_unposted"; reason_code: "unidentified_payer" | "unidentified_loan"; amount_cents: Cents; received_on: PlainDate; created_on: PlainDate; payer_name: string | null; status: "open" | "applied" | "contact_pending" | "researching"; loan_id: string | null; bank_statement_line_id: string } | null; identification: ReturnType<typeof identify> | null; auto_post: boolean; same_day: boolean } {
  const m = matchBankLine(f.line, f.ledger);
  if (m.tier !== "unmatched") return { matched: true, item: null, suspense_item: null, identification: null, auto_post: false, same_day: true };
  const receipt: Receipt = f.receipt ?? { amount_cents: f.line.amount_cents, ...(f.line.memo ? { memo: f.line.memo, payer_name: f.line.memo } : {}) };
  const id = f.candidates?.length ? identify(receipt, f.candidates) : null;
  const auto = id?.decision === "auto_apply";
  const status = auto ? "applied" as const : id?.decision === "contact_pending" ? "contact_pending" as const : "researching" as const;
  return { matched: false, auto_post: !!auto, same_day: f.today === f.line.value_date || daysBetween(f.line.value_date, f.today) <= 1, identification: id,
    item: { category: "bank_credit_unposted", amount_cents: f.line.amount_cents, first_seen_on: f.line.value_date, loan_id: auto ? id!.loan_id : null, status: auto ? "cleared" : "open", root_cause: auto ? `identified to loan ${id!.loan_id} at ${id!.scores[0]!.score}` : `unidentified deposit (BAI2 ${f.line.type_code ?? "?"}${f.line.memo ? `, memo "${f.line.memo}"` : ""})` },
    suspense_item: { source: "bank_credit_unposted", reason_code: f.line.memo ? "unidentified_loan" : "unidentified_payer", amount_cents: f.line.amount_cents, received_on: f.line.value_date, created_on: f.today, payer_name: f.line.memo ?? null, status, loan_id: auto ? id!.loan_id : null, bank_statement_line_id: f.line.id } };
}
/** 6.3 rule 3 / T7: a bank fee debited from a custodial account is reimbursed from corporate within 1 BD (custodial funds may not bear servicer expenses), the item clears, and the fee is re-billed to corporate ops. */
export function bankFeeReimbursement(f: { fee_cents: Cents; debited_on: PlainDate; custodial_account_id: string; account_kind: "pi" | "ti"; reimbursed_on: PlainDate | null }): { item: { category: "bank_fee"; amount_cents: Cents; first_seen_on: PlainDate; status: "open" | "cleared" | "overdue"; root_cause: string }; reimburse_by: PlainDate; reimbursement: PostingSet; rebill: { to: "corporate_ops"; account: "corporate_bank_fee_expense"; amount_cents: Cents; custodial_account_id: string }; cleared_on: PlainDate | null } {
  const due = addBusinessDays(f.debited_on, 1, servicer);
  const cash = `custodial_${f.account_kind}_cash:${f.custodial_account_id}`;
  const cleared = f.reimbursed_on !== null && f.reimbursed_on <= due;
  const status = cleared ? "cleared" as const : f.reimbursed_on === null ? "open" as const : "overdue" as const;
  return { item: { category: "bank_fee", amount_cents: -f.fee_cents, first_seen_on: f.debited_on, status: f.reimbursed_on !== null ? (cleared ? "cleared" : "overdue") : status, root_cause: `bank analysis fee ${formatCents(f.fee_cents)} debited ${f.debited_on}; reimbursed from corporate` },
    reimburse_by: due,
    reimbursement: { description: `corporate reimburses bank fee ${formatCents(f.fee_cents)} to ${cash}`, effective_on: f.reimbursed_on ?? due, lines: [{ account: cash, amount_cents: f.fee_cents, rule_ref: "6.3 rule 3 bank_fee" }, { account: "corporate_cash", amount_cents: -f.fee_cents, rule_ref: "6.3 rule 3 bank_fee" }, { account: "corporate_bank_fee_expense", amount_cents: f.fee_cents, rule_ref: "6.3 rule 3 re-bill" }, { account: "corporate_bank_fee_recovery", amount_cents: -f.fee_cents, rule_ref: "6.3 rule 3 re-bill" }] },
    rebill: { to: "corporate_ops", account: "corporate_bank_fee_expense", amount_cents: f.fee_cents, custodial_account_id: f.custodial_account_id }, cleared_on: f.reimbursed_on !== null && cleared ? f.reimbursed_on : null };
}
/** 6.3-T10 / rule 1: control totals must tie or the statement is quarantined and re-requested; the daily reconciliation closes carrying the item. */
export function ingestStatement(f: { file_id: string; credit_lines: readonly Cents[]; summary_credits: Cents; debit_lines: readonly Cents[]; summary_debits: Cents }): { ok: boolean; exception: "control_total_mismatch" | null; quarantined: boolean; bank_rerequest_logged: boolean; daily_close_item: string | null } {
  const ok = controlTotalsOk(f.credit_lines, f.summary_credits, f.debit_lines, f.summary_debits);
  return { ok, exception: ok ? null : "control_total_mismatch", quarantined: !ok, bank_rerequest_logged: !ok, daily_close_item: ok ? null : `statement ${f.file_id} quarantined: 49-record totals ≠ Σ 16 records` };
}
export interface Section3Item { readonly id: string; readonly category: string; readonly amount_cents: Cents; readonly loan_id: string | null; readonly root_cause: string | null; readonly first_seen_on: PlainDate; readonly evidence_refs: readonly string[]; readonly age_months?: number; }
/** 6.3-T11: the `qc-audit` reviewer requires loan / root cause / aging / evidence on every Section III item; otherwise `rework`, never `approved`. */
export function reviewerRun(items: readonly Section3Item[], f: { difference_cents: Cents; preparer_run_id: string; posting_run_ids: readonly string[] }): { status: "approved" | "rework"; findings: string[] } {
  const findings: string[] = [];
  for (const it of items) {
    if (!it.loan_id && it.category !== "bank_fee" && it.category !== "interest_credit") findings.push(`${it.id}: no loan number`);
    if (!it.root_cause) findings.push(`${it.id}: no root cause`);
    if (!it.evidence_refs.length) findings.push(`${it.id}: no evidence`);
    if (it.category === "loss_draft_aged_7m" && (it.age_months === undefined || it.age_months < 7)) findings.push(`${it.id}: aged loss draft needs age in months`);
  }
  if (f.difference_cents !== 0n) findings.push("difference ≠ 0");
  if (f.posting_run_ids.includes(f.preparer_run_id)) findings.push("segregation: preparer run also posted payments");
  return { status: findings.length ? "rework" : "approved", findings };
}
/** 6.3-T12: with `custodial.form496.human_approval = on`, no officer action within 3 servicer BD after review → reminder; the 45-day timer is untouched. */
export function approvalReminder(f: { human_approval_on: boolean; reviewed_on: PlainDate; officer_action_on: PlainDate | null; today: PlainDate }): { reminder: boolean; reminder_due_on: PlainDate | null; form_timer_affected: false; form_timer_satisfied_by: "custodial.reconciliation.completed" } {
  const dueOn = addBusinessDays(f.reviewed_on, 3, servicer);
  const reminder = f.human_approval_on && f.officer_action_on === null && f.today > dueOn;
  return { reminder, reminder_due_on: f.human_approval_on ? dueOn : null, form_timer_affected: false, form_timer_satisfied_by: "custodial.reconciliation.completed" };
}
/** 6.3-T13 / edge "Retro-corrections": a reversal after the period's form is completed never alters it; the next month's Section III carries the item with aging from the original date. */
export function retroCorrection(f: { completed_period_end: PlainDate; original_receipt_on: PlainDate; reversal_posted_on: PlainDate; amount_cents: Cents; completed_form_version: number }): { completed_form_version: number; completed_form_changed: false; carried_in_period: string; item: Section3Item & { aging_days: number } } {
  const { y, m } = { y: Number(f.reversal_posted_on.slice(0, 4)), m: Number(f.reversal_posted_on.slice(5, 7)) };
  return { completed_form_version: f.completed_form_version, completed_form_changed: false, carried_in_period: `${y}-${String(m).padStart(2, "0")}`, item: { id: `retro-${f.original_receipt_on}`, category: "returned_item", amount_cents: -f.amount_cents, loan_id: null, root_cause: `payment reversal posted ${f.reversal_posted_on} for a ${f.original_receipt_on} receipt (post-completion)`, first_seen_on: f.original_receipt_on, evidence_refs: [], aging_days: daysBetween(f.original_receipt_on, f.reversal_posted_on) } };
}
/** The Form 472 (Schedule 3 shortage/surplus) timers of IRM §1-02; LL-2026-05 retires them for A/A once auto-drafting is live ("settle-up" of outstanding balances is a one-time draft/credit with its own item category). */
export const FORM_472_TIMERS: readonly string[] = ["FNMA_IRM102_SHORTAGE_REMIT_1BD", "FNMA_IRM102_SURPLUS_UNEXPLAINED_90"];
export function form472TimersFor(f: { remittance_type: "A/A" | "S/A" | "S/S"; aa_autodraft_on: boolean }): readonly string[] { return f.remittance_type === "A/A" && f.aa_autodraft_on ? [] : FORM_472_TIMERS; }
/** 6.3-T14 / edge "A/A auto-draft go-live (LL-2026-05)": with the flag on, line 1 is composed from events processed with the draft pending (≤ 2 BD) instead of "collected, not remitted", and the Form 472 timers are not started for A/A. */
export function aaLine1Logic(f: { autodraft_on: boolean; composition?: Form496AA }): { line1_basis: AaLine1Basis; L1: Cents; L12: Cents; form472_timers_started: boolean; form472_timers: readonly string[]; settle_up_category: "fnma_settle_up" | null } {
  const basis: AaLine1Basis = f.autodraft_on ? "events_processed_draft_pending_2bd" : "collected_not_remitted";
  const c = form496AA(f.composition ?? { L11_other: 0n }, basis);
  const timers = form472TimersFor({ remittance_type: "A/A", aa_autodraft_on: f.autodraft_on });
  return { line1_basis: basis, L1: c.L1, L12: c.L12, form472_timers_started: timers.length > 0, form472_timers: timers, settle_up_category: f.autodraft_on ? "fnma_settle_up" : null };
}
/**
 * 6.3-T1 / 6.4-T1 — the monthly job: compose Section II from the period-close components (by remittance
 * type, or the T&I composition for the 496A), check the identity L12 (L7) = cashbook = adjusted depository,
 * run the reviewer, populate the registered template's cells, render the PDF and hash both. The form is
 * `completed` (timer-satisfying) only after a passed review and, when `custodial.form496.human_approval`
 * is on, the officer's approval.
 */
export interface CustodialFormInput { readonly kind: "ss" | "sa" | "aa" | "496a"; readonly period: string; readonly custodial_account_id: string; readonly servicer_number?: string; readonly remittance_type?: string; readonly section_i: SectionI; readonly cashbook_cents: Cents; readonly composition: Readonly<Record<string, Cents>>; readonly section_iii: readonly Section3Item[]; readonly template?: FormTemplate; readonly aa_autodraft_on?: boolean; readonly preparer_run_id: string; readonly posting_run_ids: readonly string[]; readonly human_approval_on?: boolean; readonly officer_approval_id?: string | null; readonly complete?: boolean; readonly attestation?: { readonly servicer_ending_cents: Cents; readonly fnma_computed_cents: Cents; readonly explanation: string | null } | null; }
export interface CustodialFormResult { readonly form_kind: "monthly_form_496" | "monthly_form_496a"; readonly lines: Readonly<Record<string, Cents>>; readonly total_cents: Cents; readonly adjusted_depository_cents: Cents; readonly difference_cents: Cents; readonly balanced: true; readonly review: ReturnType<typeof reviewerRun>; readonly status: "rework" | "under_review" | "approved" | "completed"; readonly workbook: Workbook; readonly xlsx_sha256: string; readonly pdf_sha256: string; readonly attestation: ReturnType<typeof attestationVariance> | null; readonly events: string[]; }
export function generateCustodialForm(f: CustodialFormInput): CustodialFormResult {
  const c = f.composition;
  const lines: Record<string, Cents> = {};
  let total: Cents;
  if (f.kind === "496a") {
    const need = ["P", "N", "A", "LD", "U", "BD", "I", "O"]; for (const k of need) if (c[k] === undefined) throw new RangeError(`496A composition needs ${need.join(", ")}`);
    const r = form496A(c as unknown as TiComposition);
    Object.assign(lines, { "II.1": r.L1, "II.2": r.L2, "II.3": r.L3, "II.4": r.L4, "II.5": r.L5, "II.6": r.L6, "II.7": r.L7 }); total = r.L7;
  } else if (f.kind === "ss") {
    const r = form496SS(c as unknown as Form496SS);
    Object.assign(lines, { "II.3": c.L3_prepaid_net ?? 0n, "II.4": c.L4_curtailments ?? 0n, "II.5": c.L5_interest_fundings ?? 0n, "II.7": c.L7_payoff_fixed_net ?? 0n, "II.8": c.L8_delinquent_net ?? 0n, "II.9": c.L9_fnma_receivable ?? 0n, "II.10": c.L10_variances ?? 0n, "II.11": c.L11_other ?? 0n, "II.12": r.L12 }); total = r.L12;
  } else if (f.kind === "sa") {
    const r = form496SA(c as unknown as Form496SA);
    Object.assign(lines, { "II.2": c.L2_principal_current ?? 0n, "II.3": c.L3_prepaid_net ?? 0n, "II.4": c.L4_curtailments ?? 0n, "II.6": c.L6_interest_gain_loss ?? 0n, "II.11": c.L11_other ?? 0n, "II.12": r.L12 }); total = r.L12;
  } else {
    const r = form496AA(c as unknown as Form496AA, f.aa_autodraft_on ? "events_processed_draft_pending_2bd" : "collected_not_remitted");
    Object.assign(lines, { "II.1": r.L1, "II.11": c.L11_other ?? 0n, "II.12": r.L12 }); total = r.L12;
  }
  const rec = reconcile(f.section_i, f.cashbook_cents, total);
  if (!rec.balanced) throw new RangeError(`form not generated: difference ${rec.difference_cents} cents (identity ${f.kind === "496a" ? "L7" : "L12"} = cashbook = adjusted depository must hold)`);
  const review = reviewerRun(f.section_iii, { difference_cents: rec.difference_cents, preparer_run_id: f.preparer_run_id, posting_run_ids: f.posting_run_ids });
  const att = f.attestation ? attestationVariance(f.attestation.servicer_ending_cents, f.attestation.fnma_computed_cents, f.attestation.explanation) : null;
  const findings = [...review.findings, ...(att && !att.gate_open ? ["attestation_variance unexplained"] : [])];
  const reviewed = { ...review, findings, status: findings.length ? "rework" as const : "approved" as const };
  const status: CustodialFormResult["status"] = reviewed.status === "rework" ? "rework" : f.human_approval_on && !f.officer_approval_id ? "under_review" : f.complete ? "completed" : "approved";
  const template = f.template ?? (f.kind === "496a" ? FORM_496A_TEMPLATE : FORM_496_TEMPLATE);
  const s = f.section_i;
  const iii = (cat: string) => f.section_iii.filter((i) => i.category === cat).map((i) => ({ loan: i.loan_id ?? "batch", root_cause: i.root_cause ?? "", amount: formatCents(i.amount_cents), aging_days: i.first_seen_on, ...(i.age_months !== undefined ? { age_months: i.age_months } : {}) }));
  const values: Record<string, unknown> = { servicer_number: f.servicer_number ?? "", period: f.period, custodial_account: f.custodial_account_id, remittance_type: f.remittance_type ?? (f.kind === "496a" ? "T&I" : f.kind.toUpperCase()),
    "I.1": s.bank_closing_ledger_cents, "I.2": s.deposits_in_transit_cents, "I.3": s.disbursements_in_transit_cents, "I.4": s.deposits_in_transit_cents - s.disbursements_in_transit_cents + s.adjustments_cents, "I.5": rec.adjusted_depository_cents, "I.6": f.cashbook_cents, "I.7": rec.difference_cents, ...lines,
    "III.deposits_in_transit": iii("deposit_in_transit"), "III.disbursements_in_transit": [...iii("disbursement_in_transit"), ...iii("outstanding_check")], "III.adjustments": f.section_iii.filter((i) => !["deposit_in_transit", "disbursement_in_transit", "outstanding_check", "loss_draft_aged_7m", "unapplied_aged"].includes(i.category)).map((i) => ({ loan: i.loan_id ?? "—", category: i.category, root_cause: i.root_cause ?? "", amount: formatCents(i.amount_cents), aging_days: i.first_seen_on })),
    ...(f.kind === "496a" ? { "III.loss_drafts_aged_7m": iii("loss_draft_aged_7m"), "III.unapplied_needing_resolution": iii("unapplied_aged") } : {}) };
  const workbook = formWorkbook(template, values);
  return { form_kind: f.kind === "496a" ? "monthly_form_496a" : "monthly_form_496", lines, total_cents: total, adjusted_depository_cents: rec.adjusted_depository_cents, difference_cents: rec.difference_cents, balanced: true, review: reviewed, status, workbook, xlsx_sha256: workbook.xlsx.sha256, pdf_sha256: workbook.pdf.sha256, attestation: att,
    events: ["custodial.reconciliation.drafted", ...(status === "completed" ? ["custodial.reconciliation.completed"] : [])] };
}

// ---- 6.4 -------------------------------------------------------------------
/** 6.4-T7 / edge "Vendor outage on positive pay": a paid check with no issued record is a critical exception, `fraud` case and a bank claim within 1 BD. */
export function paidNotIssued(f: { paid: readonly { check_number: string; amount_cents: Cents; paid_on: PlainDate }[]; issued: readonly { check_number: string; amount_cents: Cents }[] }): { exceptions: { check_number: string; amount_cents: Cents; severity: "critical"; fraud_case: true; bank_claim_by: PlainDate }[] } {
  const exceptions = f.paid.filter((p) => !f.issued.some((i) => i.check_number === p.check_number && i.amount_cents === p.amount_cents)).map((p) => ({ check_number: p.check_number, amount_cents: p.amount_cents, severity: "critical" as const, fraud_case: true as const, bank_claim_by: addBusinessDays(p.paid_on, 1, servicer) }));
  return { exceptions };
}
/** 6.4-T3 / FNMA_F496A_LOSS_DRAFT_AGED_7M: a loss draft held ≥ 7 months is a Section III item that needs loan number, age in months, amount and an explanation before the form can be `approved`; the `insurance-property` agent is asked for status (9.7). */
export function lossDraftAgedItem(f: { loan_id: string | null; amount_cents: Cents; received_on: PlainDate; as_of: PlainDate; explanation: string | null }): { aged: boolean; age_months: number; item: (Section3Item & { age_months: number }) | null; required: ["loan_id", "age_months", "amount_cents", "explanation"]; missing: string[]; approvable: boolean; insurance_property_status_request: boolean } {
  const months = lossDraftAgedMonths(f.received_on, f.as_of);
  const aged = months >= 7;
  const missing = aged ? [...(!f.loan_id ? ["loan_id"] : []), ...(!f.explanation ? ["explanation"] : [])] : [];
  return { aged, age_months: months, required: ["loan_id", "age_months", "amount_cents", "explanation"], missing, approvable: !aged || missing.length === 0, insurance_property_status_request: aged,
    item: aged ? { id: `ld-${f.loan_id ?? "?"}-${f.received_on}`, category: "loss_draft_aged_7m", amount_cents: f.amount_cents, loan_id: f.loan_id, root_cause: f.explanation, first_seen_on: f.received_on, evidence_refs: ["loss_draft_register"], age_months: months } : null };
}
/** 6.4-T6 / SM_F496A_BEFORE_ATTESTATION_GATE: the attestation task is blocked until the period's 496A is under review with a zero or explained variance; with no draft 3 BD before the window closes → `officer`. */
export function attestationGateEscalation(f: { period_end: PlainDate; form_496a_status: "not_started" | "composing" | "drafted" | "under_review" | "approved" | "completed" | "rework"; attestation_variance_cents: Cents; variance_explained: boolean; today: PlainDate }): { window: ReturnType<typeof attestationWindow>; gate_open: boolean; blocks: "human_portal_task:escrow_attestation" | null; escalation: { role: "officer"; reason: string } | null } {
  const w = attestationWindow(f.period_end);
  const reviewed = ["under_review", "approved", "completed"].includes(f.form_496a_status);
  const open = reviewed && (f.attestation_variance_cents === 0n || f.variance_explained);
  const late = !["drafted", "under_review", "approved", "completed"].includes(f.form_496a_status) && f.today >= w.draft_warning_on;
  return { window: w, gate_open: open, blocks: open ? null : "human_portal_task:escrow_attestation", escalation: late ? { role: "officer", reason: `no Form 496A draft for ${f.period_end} by ${w.draft_warning_on} (3 BD before the attestation window closes ${w.closes_on})` } : null };
}
/** 6.4 rule 4 / worked example: the attestation's per-category ending balances, loan count and Σ contractual escrow payments must equal the platform's snapshot; aged loss drafts (≥ 7 months) need a Section III explanation. */
export function attestationTieOut(f: { snapshot: { ti_ending_cents: Cents; loan_count: number; contractual_escrow_sum_cents: Cents; loss_draft_cents: Cents; loss_draft_loans: number }; attestation: { ti_ending_cents: Cents; loan_count: number; contractual_escrow_sum_cents: Cents; loss_draft_cents: Cents; loss_draft_loans: number }; loss_drafts: readonly { loan_id: string; received_on: PlainDate; explanation: string | null }[]; as_of: PlainDate }): { ties: boolean; variances: string[]; aged_loss_drafts: { loan_id: string; months: number; explanation_required: true; explanation: string | null }[]; answer: "Yes" | "No" } {
  const variances: string[] = [];
  for (const k of ["ti_ending_cents", "loan_count", "contractual_escrow_sum_cents", "loss_draft_cents", "loss_draft_loans"] as const) if (f.snapshot[k] !== f.attestation[k]) variances.push(k);
  const aged = f.loss_drafts.map((l) => ({ loan_id: l.loan_id, months: lossDraftAgedMonths(l.received_on, f.as_of), explanation: l.explanation })).filter((l) => l.months >= 7).map((l) => ({ ...l, explanation_required: true as const }));
  return { ties: variances.length === 0, variances, aged_loss_drafts: aged, answer: variances.length === 0 ? "Yes" : "No" };
}

// ---- 6.5 -------------------------------------------------------------------
export interface PartialReceipt { readonly on: PlainDate; readonly amount_cents: Cents; readonly rail: "ach_credit" | "check"; readonly originating_account_last4?: string; }
/**
 * 6.5 rule 3 / T1: partials held under C-1.1-02 apply as one periodic payment when Σ ≥ P, `credited_as_of`
 * the completing receipt's date (Reg Z (c)(1)(ii)(B)); each held receipt gets `SUSP-PARTIAL-HOLD-v1`
 * (amount, balance due, 30-day date) and the periodic statement (7.1) discloses the held balance until
 * applied (§1026.41(d)(3)). When the four conditions fail the servicer returns the partial
 * (`SUSP-PARTIAL-RETURN-v1`) — the registry has no other partial-payment template.
 */
export function partialAccumulation(f: { periodic_payment_cents: Cents; receipts: readonly PartialReceipt[]; conditions_met: boolean }): { applied: boolean; credited_as_of: PlainDate | null; suspense_cents: Cents; partial_commitment_due_on: PlainDate | null; statement_lines: { on: PlainDate; held_cents: Cents }[]; timer_satisfied: "FNMA_C1102_PARTIAL_BALANCE_30" | null; satisfied_by: "suspense.accumulation.sufficient" | null; notices: { template: "SUSP-PARTIAL-HOLD-v1" | "SUSP-PARTIAL-RETURN-v1"; on: PlainDate; amount_cents: Cents; balance_due_cents: Cents; commitment_due_on: PlainDate | null }[]; action: "hold_partial" | "apply" | "return_partial" } {
  if (!f.receipts.length) throw new RangeError("receipts required");
  const sorted = [...f.receipts].sort((a, b) => a.on.localeCompare(b.on));
  if (!f.conditions_met) return { applied: false, credited_as_of: null, suspense_cents: 0n, partial_commitment_due_on: null, statement_lines: [], timer_satisfied: null, satisfied_by: null, action: "return_partial", notices: sorted.map((r) => ({ template: "SUSP-PARTIAL-RETURN-v1" as const, on: r.on, amount_cents: r.amount_cents, balance_due_cents: f.periodic_payment_cents - r.amount_cents, commitment_due_on: null })) };
  const commitment = addDays(sorted[0]!.on, 30);
  let sum = 0n; const lines: { on: PlainDate; held_cents: Cents }[] = []; let credited: PlainDate | null = null;
  const notices: { template: "SUSP-PARTIAL-HOLD-v1" | "SUSP-PARTIAL-RETURN-v1"; on: PlainDate; amount_cents: Cents; balance_due_cents: Cents; commitment_due_on: PlainDate | null }[] = [];
  for (const r of sorted) {
    sum += r.amount_cents;
    if (credited === null && sum >= f.periodic_payment_cents) { credited = r.on; lines.push({ on: r.on, held_cents: sum - f.periodic_payment_cents }); }
    else { lines.push({ on: r.on, held_cents: credited ? sum - f.periodic_payment_cents : sum }); if (credited === null) notices.push({ template: "SUSP-PARTIAL-HOLD-v1", on: r.on, amount_cents: r.amount_cents, balance_due_cents: f.periodic_payment_cents - sum, commitment_due_on: commitment }); }
  }
  const applied = credited !== null;
  return { applied, credited_as_of: credited, suspense_cents: applied ? sum - f.periodic_payment_cents : sum, partial_commitment_due_on: commitment, statement_lines: lines, timer_satisfied: applied ? "FNMA_C1102_PARTIAL_BALANCE_30" : null, satisfied_by: applied ? "suspense.accumulation.sufficient" : null, notices, action: applied ? "apply" : "hold_partial" };
}
/** 6.5 rule 3 / T2: nothing by day 30 → the partial returns by the original rail to the originating account with `SUSP-PARTIAL-RETURN-v1`. */
export function partialReturnSweep(f: { received_on: PlainDate; amount_cents: Cents; rail: "ach_credit" | "check"; originating_account_last4?: string; held_cents: Cents; periodic_payment_cents: Cents; today: PlainDate; active_lossmit_case: boolean }): { due_on: PlainDate; returned: boolean; returned_on: PlainDate | null; rail: "ach_credit" | "check" | null; destination: string | null; notice: "SUSP-PARTIAL-RETURN-v1" | null; status: "returned" | "open" | "lossmit_hold" } {
  const due = addDays(f.received_on, 30);
  if (f.active_lossmit_case) return { due_on: due, returned: false, returned_on: null, rail: null, destination: null, notice: null, status: "lossmit_hold" };
  if (f.today > due && f.held_cents < f.periodic_payment_cents) return { due_on: due, returned: true, returned_on: f.today, rail: f.rail, destination: f.rail === "ach_credit" ? `originating account …${f.originating_account_last4 ?? "????"}` : "remitter address on the check image", notice: "SUSP-PARTIAL-RETURN-v1", status: "returned" };
  return { due_on: due, returned: false, returned_on: null, rail: null, destination: null, notice: null, status: "open" };
}
/** C-1.1-02 $50 rule (6.5 rule 3 / T3): deficiency ≤ $50, instrument dated ≥ March 1999 and fewer than 3 such applications in 12 months → apply and reduce escrow by the deficiency. */
export function fiftyDollarRule(f: { amount_cents: Cents; periodic_payment_cents: Cents; instrument_date: PlainDate; partial_count_12m: number; received_on: PlainDate }): { applies: boolean; deficiency_cents: Cents; escrow_reduction_cents: Cents; credited_as_of: PlainDate | null; partial_count_12m_after: number; treatment: "fifty_dollar_rule" | "ordinary_partial" } {
  const deficiency = f.periodic_payment_cents - f.amount_cents;
  const applies = deficiency > 0n && deficiency <= 5_000n && f.instrument_date >= ("1999-03-01" as PlainDate) && f.partial_count_12m < 3;
  return { applies, deficiency_cents: deficiency, escrow_reduction_cents: applies ? deficiency : 0n, credited_as_of: applies ? f.received_on : null, partial_count_12m_after: applies ? f.partial_count_12m + 1 : f.partial_count_12m, treatment: applies ? "fifty_dollar_rule" : "ordinary_partial" };
}
/** Reg Z §1026.36(c)(1)(ii)(B) (6.5-T6): when Σ unapplied reaches P the payment is credited as of the accumulation date even if the job runs later; the 1-BD timer is satisfied by `payment.applied{credited_as_of=accumulation}`. */
export function applyOnAccumulation(f: { accumulated_on: PlainDate; job_run_on: PlainDate; periodic_payment_cents: Cents; held_cents: Cents }): { apply: boolean; credited_as_of: PlainDate | null; due_on: PlainDate; on_time: boolean; timer: "REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD"; satisfied_by: string | null } {
  const due = addBusinessDays(f.accumulated_on, 1, servicer);
  const apply = f.held_cents >= f.periodic_payment_cents;
  return { apply, credited_as_of: apply ? f.accumulated_on : null, due_on: due, on_time: apply && f.job_run_on <= due, timer: "REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD", satisfied_by: apply ? `payment.applied{credited_as_of=${f.accumulated_on}}` : null };
}
/** 6.5-T8 / SM_SUSPENSE_AGE_90_ESCALATE: a non-terminal item aged 90 days → `officer` high and a partner aging-report line. */
export function suspenseAging(f: { item_id: string; loan_id: string | null; amount_cents: Cents; status: string; received_on: PlainDate; today: PlainDate }): { aging_days: number; terminal: boolean; escalation: { role: "officer"; severity: "high" } | null; partner_report_line: string | null } {
  const terminal = isSuspenseTerminal(f.status);
  const aging = Math.floor(agingDays(f.received_on, f.today));
  const esc = !terminal && aging >= 90;
  return { aging_days: aging, terminal, escalation: esc ? { role: "officer", severity: "high" } : null, partner_report_line: esc ? `${f.item_id} | loan ${f.loan_id ?? "—"} | ${f.status} | ${aging} days | ${f.amount_cents} cents` : null };
}
/** 6.5 guardrails (baseline §8(6)): AI outreach discloses automation; a request for a person is a warm transfer to `human_agent`, recorded on the contact. */
export function aiOutreachContact(f: { utterance: string; at: string; disclosure_given: boolean }): { mode: "ai_voice"; disclosure_given: boolean; human_transfer_requested: boolean; transfer_to: "human_agent" | null; transfer_time: string | null } {
  const u = handleUtterance(f.utterance);
  return { mode: "ai_voice", disclosure_given: f.disclosure_given, human_transfer_requested: u.human_transfer_requested, transfer_to: u.human_transfer_requested ? "human_agent" : null, transfer_time: u.human_transfer_requested ? f.at : null };
}
export const at = (d: PlainDate, hhmm: string): number => zonedEpochMs(d, hhmm, ET);
