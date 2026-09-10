/**
 * §6.2 operating rules over the T&I custodial calculators (./accounts.ts, ./ops.ts) — the process's event
 * emitters. Each is a validated code path that appends the event a 6.2 registry row is armed or satisfied
 * by (src/kernel/timers/engine.ts matches them by type + payload field, same subject):
 *
 *   planTiAccounts               `custodial.account.planned{kind=ti}`          arms FNMA_F103_FORM1014_IN_EFFECT_GATE per T&I account
 *   form1014InEffect             `custodial.form.in_effect{kind=1014}`         opens the gate (F-1-03 executed Form 1014)
 *   tiDepositGateCheck           `custodial.deposit.blocked` + Change/Replace task while the gate is closed or the form
 *                                does not list the loan's remittance type (6.2-T1)
 *   ingestTiStatementLine        `custodial.interest.credited` from the bank statement's interest line (arms
 *                                FNMA_A4102_TI_INTEREST_DISBURSE_30 on the bank credit date); a matched credit →
 *                                confirmTiDeposit; a debit → tiUnmatchedDebit (6.2-T6)
 *   receivePurchaseProceeds      `transfer_in.purchase_proceeds.received` (1.6 inbound wire) arms
 *                                FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD on the receipt date
 *   confirmTiDeposit             `custodial.deposit.confirmed{account_kind=ti}` satisfies the boarding deposit row
 *                                (and 2.1's 24-hour row) on the same subject
 *   disposeInterestCredit        rule 2 postings into the ledger, `escrow.interest.credited` per loan (the cash side of
 *                                STATE_ESCROW_INTEREST_CREDIT_RECUR) and `custodial.interest.disbursed` once the
 *                                ledger's interest-pending control balance is zero (6.2-T2/T3)
 *   interestDisbursedIfSettled   the bus `ledger.post` hook: the disbursed event is emitted from the ledger balance,
 *                                never from a self-declared flag
 *   handleInterestDisbursementBreach  `officer` medium + the aged "Other" item on Form 496A line 6 (6.2-T4)
 *   openEscrowAccount            `escrow.account.opened{interest_state=true, next_interest_credit_on}` arms
 *                                STATE_ESCROW_INTEREST_CREDIT_RECUR (cadence per jurisdiction_rules.escrow_interest)
 *
 * bigint cents; PlainDate + the servicer calendar; the ledger's allowed-transfer matrix (./ops.ts) stays the
 * guard on every posting the bus makes.
 */
import { type PlainDate, addDays, addMonths, endOfMonth, parts, ymd, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, wallClock } from "../../kernel/calendar/zoned.ts";
import { type Cents, formatCents } from "../../kernel/money/cents.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, CorporateAccount, CustodialAccount, EntrySet, EntrySetInput, Ledger } from "../../kernel/ledger/ledger.ts";
import { depositGate, interestDispositionDueMs, type AccountUse, type DepositGateTask, type FormStatus } from "./accounts.ts";
import { ET, interestDispositionPostings, interestDispositionStatus, tiUnmatchedDebit, type PostingLine, type PostingSet } from "./ops.ts";
import { matchBankLine, type BankLine, type LedgerItem } from "./reconciliation.ts";

// ---- ports -----------------------------------------------------------------
/** What the 6.2 emitters need from a unit of work: the event spine, the ledger, the actor and the clock; escalations, timers and the decision log when the caller has them. */
export interface TiOps {
  readonly events: EventStore;
  readonly ledger: Ledger;
  readonly actor: Actor;
  /** ISO instant of the unit of work. */
  readonly now: string;
  readonly escalations?: { open(input: { kind: "officer" | "human_portal_task"; ownerRole?: string; severity?: string; loanId?: string; payload?: Record<string, unknown> }, by: Actor): { id: string } };
  readonly timers?: { byCode(code: string): readonly { readonly subject: { readonly kind: string; readonly id: string }; readonly status: string }[] };
  readonly decide?: (d: { agent: string; action: string; rationale: string; ruleSetVersion: string; loanId?: string; subject?: { kind: string; id: string }; ruleCode?: string }) => void;
}

export type TiAccountKind = "ti" | "ti_unapplied" | "ti_loss_draft" | "ti_buydown";
const REMITTANCE_TYPES: readonly AccountUse[] = ["A/A", "S/A", "S/S"];
const CUSTODIAL_ACCOUNT = "custodial_account";
const todayOf = (ops: TiOps): PlainDate => wallClock(Date.parse(ops.now), ET).date;
const need = (cond: boolean, msg: string): void => { if (!cond) throw new RangeError(msg); };

/** F-1-03 (05/13/2026) T&I title, verbatim (spec 6.2 "Verified requirement"); compared byte-for-byte to the signature card (6.1 rule 3). */
export const tiTitleF103 = (servicerName: string): string => `${servicerName}, as agent and/or trustee for the benefit of Fannie Mae and payments of various mortgagors, respectively (Custodial Account)`;

// ---- plan → gate → activate --------------------------------------------------
export interface TiPlannedAccount { readonly custodial_account_id: string; readonly account_kind: TiAccountKind; readonly remittance_types: readonly AccountUse[]; readonly form_type: "1014"; readonly title: string; readonly purpose: string; }
const PURPOSE: Record<TiAccountKind, string> = { ti: "T&I escrow for all Fannie Mae remittance types (buydown funds in main, ledger control account)", ti_unapplied: "unapplied (suspense) funds — partial payments, overages/shortages, rental income (6.5)", ti_loss_draft: "insurance loss drafts (9.7)", ti_buydown: "buydown funds not yet scheduled for application" };

/**
 * Inputs and triggers: `subservicing.arrangement.created` → plan the T&I accounts — all remittance types on one
 * Form 1014 unless the partner contract requires per-type separation (open question 4: default no); default
 * layout (open question 1): main + `ti_unapplied` + `ti_loss_draft`, buydown funds in main. One
 * `custodial.account.planned{kind=ti}` per account arms FNMA_F103_FORM1014_IN_EFFECT_GATE for it.
 */
export function planTiAccounts(ops: TiOps, f: { arrangement_id: string; portfolio: readonly { remittance_type: AccountUse }[]; servicer_name?: string; sub_accounts?: readonly Exclude<TiAccountKind, "ti">[]; separate_by_remittance_type?: boolean }): { accounts: TiPlannedAccount[]; events: DomainEvent[] } {
  need(f.arrangement_id.trim().length > 0, "arrangement_id is required");
  need(f.portfolio.length > 0, "portfolio is empty: nothing to plan");
  for (const l of f.portfolio) need(REMITTANCE_TYPES.includes(l.remittance_type), `remittance type ${String(l.remittance_type)} is not one of A/A, S/A, S/S`);
  const types = REMITTANCE_TYPES.filter((t) => f.portfolio.some((l) => l.remittance_type === t));
  const title = tiTitleF103(f.servicer_name ?? "Supermortgage");
  const mains: TiPlannedAccount[] = f.separate_by_remittance_type
    ? types.map((t): TiPlannedAccount => ({ custodial_account_id: `${f.arrangement_id}:ti:${t.replace("/", "")}`, account_kind: "ti", remittance_types: [t], form_type: "1014", title, purpose: PURPOSE.ti }))
    : [{ custodial_account_id: `${f.arrangement_id}:ti`, account_kind: "ti", remittance_types: types, form_type: "1014", title, purpose: PURPOSE.ti }];
  const subKinds: readonly Exclude<TiAccountKind, "ti">[] = f.sub_accounts ?? ["ti_unapplied", "ti_loss_draft"];
  const subs: TiPlannedAccount[] = [...new Set(subKinds)].map((k): TiPlannedAccount => ({ custodial_account_id: `${f.arrangement_id}:${k}`, account_kind: k, remittance_types: types, form_type: "1014", title, purpose: PURPOSE[k] }));
  const accounts = [...mains, ...subs];
  const events = accounts.map((a) => ops.events.append({ type: "custodial.account.planned", aggregate: { kind: CUSTODIAL_ACCOUNT, id: a.custodial_account_id }, actor: ops.actor,
    payload: { kind: "ti", account_kind: a.account_kind, custodial_account_id: a.custodial_account_id, arrangement_id: f.arrangement_id, remittance_types: a.remittance_types, form_type: "1014", title: a.title, purpose: a.purpose } }));
  return { accounts, events };
}

/**
 * `custodial.form.in_effect` (1014) → activate: the executed form (hash required — 6.1 guardrail) on or after its
 * effective date opens FNMA_F103_FORM1014_IN_EFFECT_GATE for the account. The state-machine guard on `active`
 * (remittance types on the executed form ⊇ the portfolio's) is reported, not enforced here: a loan whose type is
 * missing is blocked per deposit by tiDepositGateCheck (6.2-T1), the form itself is in effect.
 */
export function form1014InEffect(ops: TiOps, f: { form_id: string; custodial_account_id: string; remittance_types: readonly AccountUse[]; executed_document_hash: string | null; effective_on: PlainDate; portfolio_remittance_types?: readonly AccountUse[] }): { in_effect: true; covers_portfolio: boolean; uncovered_remittance_types: AccountUse[]; event: DomainEvent } {
  need(!!f.executed_document_hash && f.executed_document_hash.trim().length > 0, "custodial.form.in_effect requires executed_document_hash (6.1 guardrail)");
  need(f.remittance_types.length > 0, "Form 1014 lists at least one remittance type");
  for (const t of f.remittance_types) need(REMITTANCE_TYPES.includes(t), `remittance type ${String(t)} is not one of A/A, S/A, S/S`);
  need(f.effective_on <= todayOf(ops), `effective date ${f.effective_on} not reached`);
  const uncovered = (f.portfolio_remittance_types ?? []).filter((t) => !f.remittance_types.includes(t));
  const event = ops.events.append({ type: "custodial.form.in_effect", aggregate: { kind: CUSTODIAL_ACCOUNT, id: f.custodial_account_id }, actor: ops.actor,
    payload: { kind: "1014", form_type: "1014", form_id: f.form_id, custodial_account_id: f.custodial_account_id, remittance_types: f.remittance_types, executed_document_hash: f.executed_document_hash, effective_on: f.effective_on, covers_portfolio: uncovered.length === 0 } });
  return { in_effect: true, covers_portfolio: uncovered.length === 0, uncovered_remittance_types: uncovered, event };
}

/**
 * The gate's breach action: `escrow.deposit.initiated` / `suspense.item.created` (cash side) are blocked while
 * FNMA_F103_FORM1014_IN_EFFECT_GATE is armed for the account or the executed Form 1014 does not list the loan's
 * remittance type; the block opens the portal operator's CBAM Change/Replace (or signature) task (6.2-T1).
 */
export function tiDepositGateCheck(ops: TiOps, f: { custodial_account_id: string; loan_id: string; remittance_type: AccountUse; form: { status: FormStatus; remittance_types: readonly AccountUse[] }; deposit_kind?: "escrow.deposit.initiated" | "suspense.item.created" }): { ok: true } | { ok: false; gate: "FNMA_F103_FORM1014_IN_EFFECT_GATE"; reason: string; task: DepositGateTask | null; escalation_id: string | null; blocked: string; event: DomainEvent } {
  need(REMITTANCE_TYPES.includes(f.remittance_type), `remittance type ${String(f.remittance_type)} is not one of A/A, S/A, S/S`);
  const gateArmed = (ops.timers?.byCode("FNMA_F103_FORM1014_IN_EFFECT_GATE") ?? []).some((t) => t.subject.kind === CUSTODIAL_ACCOUNT && t.subject.id === f.custodial_account_id && (t.status === "armed" || t.status === "breached"));
  // the engine is the authority on whether the gate is open: an armed gate means the executed form is not in effect yet, whatever the caller's form row says
  const status: FormStatus = gateArmed && (f.form.status === "in_effect" || f.form.status === "pending_replacement") ? "fully_signed" : f.form.status;
  const g = depositGate({ status, kind: "1014", remittance_types: f.form.remittance_types }, f.remittance_type);
  if (g.ok) return g;
  const blocked = f.deposit_kind ?? "escrow.deposit.initiated";
  const event = ops.events.append({ type: "custodial.deposit.blocked", loanId: f.loan_id, aggregate: { kind: CUSTODIAL_ACCOUNT, id: f.custodial_account_id }, actor: ops.actor,
    payload: { gate: "FNMA_F103_FORM1014_IN_EFFECT_GATE", custodial_account_id: f.custodial_account_id, loan_id: f.loan_id, remittance_type: f.remittance_type, blocked, reason: g.reason, task: g.task } });
  const escalation = g.task && ops.escalations ? ops.escalations.open({ kind: "human_portal_task", ownerRole: g.task.role, loanId: f.loan_id, payload: { task: g.task.action, form_kind: g.task.form_kind, add_remittance_types: g.task.add_remittance_types, custodial_account_id: f.custodial_account_id, gate: "FNMA_F103_FORM1014_IN_EFFECT_GATE", reason: g.reason } }, ops.actor) : null;
  return { ok: false, gate: "FNMA_F103_FORM1014_IN_EFFECT_GATE", reason: g.reason, task: g.task, escalation_id: escalation?.id ?? null, blocked, event };
}

// ---- statement ingestion: interest credits, deposits, debits --------------------
export interface TiStatementLine extends BankLine { readonly direction: "credit" | "debit"; /** camt.053 BkTxCd (e.g. `ACMT/MCOP/INTR`). */ readonly bktxcd?: string; }
/** Bank-specific mapping of the interest credit line (spec: BAI2 detail codes in the interest family or camt.053 `BkTxCd` `ACMT/…/INTR` — [bank-specific mapping; UNVERIFIED]); treasury supplies the depository's codes. */
export interface InterestCodeMapping { readonly bai2_interest_codes: readonly string[]; readonly camt_interest: RegExp; }
export const DEFAULT_INTEREST_MAPPING: InterestCodeMapping = { bai2_interest_codes: ["352", "354"], camt_interest: /^ACMT\/[A-Z]{4}\/INTR$/ };
export const isInterestCredit = (line: TiStatementLine, mapping: InterestCodeMapping = DEFAULT_INTEREST_MAPPING): boolean =>
  line.direction === "credit" && ((line.type_code !== undefined && mapping.bai2_interest_codes.includes(line.type_code)) || (line.bktxcd !== undefined && mapping.camt_interest.test(line.bktxcd)));

export type InterestDisposition = "pending" | "to_borrowers" | "to_corporate" | "mixed";
/** `custodial_interest_credits` row (0007). */
export interface InterestCreditRow { readonly id: string; readonly custodial_account_id: string; readonly bank_statement_line_id: string | null; readonly credited_on: PlainDate; readonly amount_cents: Cents; readonly admin_expense_cents: Cents; readonly disposition: InterestDisposition; readonly disbursed_on: PlainDate | null; readonly interest_ambiguous: boolean; }
export type DepositSource = "boarding_escrow" | "payment_escrow" | "loss_draft" | "suspense" | "buydown";
export interface PendingDeposit extends LedgerItem { readonly deposit_id: string; readonly source: DepositSource; readonly transfer_id?: string; readonly loan_id?: string; }

const cashRef = (accountKind: TiAccountKind, id: string): AccountRef => ({ scope: "custodial", custodialAccountId: id, account: accountKind === "ti_unapplied" ? "custodial_ti_unapplied_cash" : "custodial_ti_cash" });
/** The 6.2 data-model control account `interest_pending` (sub-ledger of `custodial_ti_cash:<id>`; composition line 6 "I"). */
export const interestPendingRef = (custodialAccountId: string): AccountRef => ({ scope: "custodial", custodialAccountId, account: "interest_pending" as CustodialAccount });

/**
 * One T&I statement line. Interest family → `custodial.interest.credited` (the 30-day clock runs from the credit
 * date even when the bank posts interest net of fees / as a combined line — `interest_ambiguous` asks for the
 * analysis statement; a credit to the wrong sub-account is an erroneous deposit to move within 1 BD, F-1-03).
 * Other credits are matched to the pending deposits (→ confirmTiDeposit); debits with no `disbursements` match
 * within 1 BD open `unmatched_debit` (high) and pull the positive-pay exception list (6.2-T6).
 */
export function ingestTiStatementLine(ops: TiOps, f: { custodial_account_id: string; account_kind: TiAccountKind; line: TiStatementLine; pending_deposits?: readonly PendingDeposit[]; disbursements?: readonly LedgerItem[]; as_of?: PlainDate; mapping?: InterestCodeMapping; interest_ambiguous?: boolean }):
  | { kind: "interest_credit"; credit: InterestCreditRow; misdirected: boolean; move_by: PlainDate | null; disburse_by: PlainDate; set: EntrySet; event: DomainEvent }
  | { kind: "deposit_confirmed"; deposit: PendingDeposit; event: DomainEvent; set: EntrySet }
  | { kind: "credit_unmatched"; line: TiStatementLine }
  | { kind: "debit"; unmatched: ReturnType<typeof tiUnmatchedDebit>; event: DomainEvent | null } {
  need(f.line.id.trim().length > 0, "bank statement line id is required");
  need(f.line.amount_cents > 0n, "statement line amount must be positive (direction carries the sign)");
  const asOf = f.as_of ?? todayOf(ops);
  if (f.line.direction === "debit") {
    const unmatched = tiUnmatchedDebit({ debit: f.line, disbursements: f.disbursements ?? [], as_of: asOf });
    const event = unmatched.exception ? ops.events.append({ type: "reconciliation_item.opened", aggregate: { kind: CUSTODIAL_ACCOUNT, id: f.custodial_account_id }, actor: ops.actor,
      payload: { category: "unmatched_debit", severity: "high", custodial_account_id: f.custodial_account_id, bank_statement_line_id: f.line.id, amount_cents: f.line.amount_cents, first_seen_on: asOf, actions: unmatched.actions } }) : null;
    return { kind: "debit", unmatched, event };
  }
  if (isInterestCredit(f.line, f.mapping)) {
    const credit: InterestCreditRow = { id: `IC-${f.line.id}`, custodial_account_id: f.custodial_account_id, bank_statement_line_id: f.line.id, credited_on: f.line.value_date, amount_cents: f.line.amount_cents, admin_expense_cents: 0n, disposition: "pending", disbursed_on: null, interest_ambiguous: f.interest_ambiguous === true };
    const misdirected = f.account_kind !== "ti";
    // the credit lands in T&I cash and sits in the interest-pending control until rule 2 disposes it
    const set = ops.ledger.post({ effectiveDate: credit.credited_on, description: `bank interest credit ${credit.id}`, lines: [{ account: cashRef(f.account_kind, f.custodial_account_id), amountCents: credit.amount_cents, ruleRef: "6.2 rule 2 credit" }, { account: interestPendingRef(f.custodial_account_id), amountCents: -credit.amount_cents, ruleRef: "6.2 rule 2 credit" }] }, ops.now);
    const disburse_by = wallClock(interestDispositionDueMs(credit.credited_on), ET).date;
    const event = ops.events.append({ type: "custodial.interest.credited", aggregate: { kind: CUSTODIAL_ACCOUNT, id: f.custodial_account_id }, actor: ops.actor,
      payload: { custodial_account_id: f.custodial_account_id, account_kind: f.account_kind, interest_credit_id: credit.id, bank_statement_line_id: credit.bank_statement_line_id, credited_on: credit.credited_on, amount_cents: credit.amount_cents, interest_ambiguous: credit.interest_ambiguous, misdirected, disburse_by, ledger_set_id: set.id } });
    return { kind: "interest_credit", credit, misdirected, move_by: misdirected ? addBusinessDays(credit.credited_on, 1, servicer) : null, disburse_by, set, event };
  }
  const m = matchBankLine(f.line, f.pending_deposits ?? []);
  const deposit = m.tier === "unmatched" ? undefined : (f.pending_deposits ?? []).find((d) => m.ledger_ids.includes(d.id));
  if (!deposit) return { kind: "credit_unmatched", line: f.line };
  const c = confirmTiDeposit(ops, { custodial_account_id: f.custodial_account_id, account_kind: f.account_kind, deposit_id: deposit.deposit_id, amount_cents: f.line.amount_cents, bank_statement_line_id: f.line.id, confirmed_on: f.line.value_date, source: deposit.source, ...(deposit.transfer_id ? { transfer_id: deposit.transfer_id } : {}), ...(deposit.loan_id ? { loan_id: deposit.loan_id } : {}) });
  return { kind: "deposit_confirmed", deposit, event: c.event, set: c.set };
}

/**
 * The bank credit matched to a deposit: T&I cash in, clearing out, and `custodial.deposit.confirmed{account_kind}`
 * on the deposit's subject — the transfer batch for a boarding deposit (FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD),
 * the loan for an escrow / loss-draft / suspense receipt (FNMA_C1101_DEPOSIT_CUSTODIAL_24H, 2.1).
 */
export function confirmTiDeposit(ops: TiOps, f: { custodial_account_id: string; account_kind: TiAccountKind; deposit_id: string; amount_cents: Cents; bank_statement_line_id?: string; confirmed_on: PlainDate; source: DepositSource; transfer_id?: string; loan_id?: string }): { event: DomainEvent; set: EntrySet } {
  need(f.amount_cents > 0n, "a confirmed deposit is a positive amount");
  need(f.deposit_id.trim().length > 0, "deposit_id is required");
  const clearing: AccountRef = { scope: "custodial", custodialAccountId: f.custodial_account_id, account: f.source === "boarding_escrow" ? "transfer_in_clearing" : "clearing_cash" };
  const set = ops.ledger.post({ effectiveDate: f.confirmed_on, description: `T&I deposit ${f.deposit_id} confirmed (${f.source})`, lines: [{ account: cashRef(f.account_kind, f.custodial_account_id), amountCents: f.amount_cents, ruleRef: "6.2 F-1-03 deposit" }, { account: clearing, amountCents: -f.amount_cents, ruleRef: "6.2 F-1-03 deposit" }] }, ops.now);
  const event = ops.events.append({ type: "custodial.deposit.confirmed", ...(f.loan_id ? { loanId: f.loan_id } : {}), aggregate: f.transfer_id ? { kind: "transfer_in", id: f.transfer_id } : { kind: CUSTODIAL_ACCOUNT, id: f.custodial_account_id }, actor: ops.actor,
    payload: { custodial_account_id: f.custodial_account_id, account_kind: f.account_kind, deposit_id: f.deposit_id, amount_cents: f.amount_cents, bank_statement_line_id: f.bank_statement_line_id ?? null, confirmed_on: f.confirmed_on, source: f.source, transfer_id: f.transfer_id ?? null, ledger_set_id: set.id } });
  return { event, set };
}

/**
 * 1.6's inbound wire of purchase proceeds: F-1-03 — borrower escrow balances and buydown funds are deposited
 * "within one business day after receiving purchase proceeds". Validates the wire covers them and appends
 * `transfer_in.purchase_proceeds.received{received_on}` on the transfer batch, arming
 * FNMA_F103_BOARDING_ESCROW_DEPOSIT_1BD (1 business_days_servicer from the receipt date).
 */
export function receivePurchaseProceeds(ops: TiOps, f: { transfer_id: string; received_on: PlainDate; amount_cents: Cents; escrow_balances_cents: Cents; buydown_cents?: Cents; custodial_account_id: string; wire_reference?: string }): { deposit_due_on: PlainDate; deposit_due_at_ms: number; escrow_deposit_cents: Cents; event: DomainEvent } {
  need(f.transfer_id.trim().length > 0, "transfer_id is required");
  need(f.amount_cents > 0n, "purchase proceeds must be a positive amount");
  need(f.escrow_balances_cents >= 0n && (f.buydown_cents ?? 0n) >= 0n, "escrow balances and buydown funds are non-negative");
  const escrowDeposit = f.escrow_balances_cents + (f.buydown_cents ?? 0n);
  need(f.amount_cents >= escrowDeposit, `purchase proceeds ${formatCents(f.amount_cents)} do not cover the escrow balances and buydown funds ${formatCents(escrowDeposit)}`);
  const deposit_due_on = addBusinessDays(f.received_on, 1, servicer);
  const event = ops.events.append({ type: "transfer_in.purchase_proceeds.received", aggregate: { kind: "transfer_in", id: f.transfer_id }, actor: ops.actor,
    payload: { transfer_id: f.transfer_id, received_on: f.received_on, amount_cents: f.amount_cents, escrow_balances_cents: f.escrow_balances_cents, buydown_cents: f.buydown_cents ?? 0n, escrow_deposit_cents: escrowDeposit, custodial_account_id: f.custodial_account_id, deposit_due_on, wire_reference: f.wire_reference ?? null } });
  return { deposit_due_on, deposit_due_at_ms: zonedEpochMs(deposit_due_on, "17:00", ET), escrow_deposit_cents: escrowDeposit, event };
}

// ---- interest disposition (rule 2) --------------------------------------------
const CORPORATE = /^(corporate_cash|corporate_bank_fee_recovery|corporate_interest_income|corporate_expense_escrow_interest|interest_due_corporate)$/;
/** Domain posting line → kernel ledger account (the 6.2 data model's sub-ledger control accounts ride on the custodial scope). */
export function toAccountRef(l: PostingLine): AccountRef {
  const m = /^(custodial_ti_cash|custodial_ti_unapplied_cash|interest_pending):(.+)$/.exec(l.account);
  if (m) return { scope: "custodial", custodialAccountId: m[2]!, account: m[1] as CustodialAccount };
  if (l.account === "escrow_liability") { need(!!l.loan_id, "escrow_liability line needs loan_id"); return { scope: "loan", loanId: l.loan_id!, account: "escrow" }; }
  if (CORPORATE.test(l.account)) return { scope: "corporate", account: l.account as CorporateAccount };
  throw new RangeError(`no ledger account for posting line ${l.account}`);
}
export const toEntrySet = (s: PostingSet): EntrySetInput => ({ effectiveDate: s.effective_on, description: s.description, lines: s.lines.map((l) => ({ account: toAccountRef(l), amountCents: l.amount_cents, ruleRef: l.rule_ref })) });

export interface InterestAllocation { readonly loan_id: string; readonly statutory_cents: Cents; readonly state?: string; readonly period_start?: PlainDate; readonly period_end?: PlainDate; readonly next_interest_credit_on?: PlainDate; }
/**
 * Rule 2 for one credit: E = documented bank analysis fees on the account, to_borrowers = the statutory
 * obligations 3.9 reports, to_corporate = I − E − to_borrowers (≥ 0; a shortfall is funded from corporate as a
 * servicer expense — an `officer` decision that the escalation records, 6.2-T3). The sets post into the ledger
 * (custodial_ti_cash / interest_pending / borrower escrow / corporate), each borrower credit emits
 * `escrow.interest.credited` (3.9's event — the cash side of STATE_ESCROW_INTEREST_CREDIT_RECUR), and
 * `custodial.interest.disbursed` is appended only when the ledger's interest-pending balance for the account is
 * zero — that is what satisfies FNMA_A4102_TI_INTEREST_DISBURSE_30 (6.2-T2). Decision record:
 * {interest_credit_id, E, to_borrowers, to_corporate, loan_count, jurisdiction_rule_versions}.
 */
export function disposeInterestCredit(ops: TiOps, f: { credit: InterestCreditRow; admin_expense_cents: Cents; allocations: readonly InterestAllocation[]; posted_on: PlainDate; officer_approval_id?: string; jurisdiction_rule_versions?: Readonly<Record<string, string>> }): { credit: InterestCreditRow; disposition: ReturnType<typeof interestDispositionPostings>["disposition"]; postings: PostingSet[]; sets: EntrySet[]; interest_pending_after_cents: Cents; on_time: boolean; disbursed: DomainEvent | null; escrow_credits: DomainEvent[]; escalation_id: string | null; memo: ReturnType<typeof interestDispositionPostings>["memo"] } {
  need(f.credit.disposition === "pending", `interest credit ${f.credit.id} is already disposed (${f.credit.disposition})`);
  need(f.credit.amount_cents > 0n, "interest credit must be positive");
  need(f.admin_expense_cents >= 0n, "administrative expenses are non-negative (bank analysis fees on this account only)");
  need(f.posted_on >= f.credit.credited_on, "postings cannot precede the bank credit date");
  for (const a of f.allocations) need(a.statutory_cents >= 0n && a.loan_id.trim().length > 0, "each allocation is a loan with a non-negative statutory amount");
  const r = interestDispositionPostings({ credit_id: f.credit.id, custodial_account_id: f.credit.custodial_account_id, credited_on: f.credit.credited_on, amount_cents: f.credit.amount_cents, admin_expense_cents: f.admin_expense_cents, allocations: f.allocations, posted_on: f.posted_on });
  const shortfall = r.disposition.corporate_funds_shortfall_cents;
  need(shortfall === 0n || !!f.officer_approval_id, `corporate funding of the statutory-interest shortfall ${formatCents(shortfall)} is an officer decision (6.2 escalations)`);
  const agg = { kind: CUSTODIAL_ACCOUNT, id: f.credit.custodial_account_id };
  // the bank credit set is already in the ledger when the statement line was ingested; post it once
  const creditDesc = `bank interest credit ${f.credit.id}`;
  const sets = r.sets.filter((s) => s.description !== creditDesc || !ops.ledger.sets().some((x) => x.description === creditDesc)).map((s) => ops.ledger.post(toEntrySet(s), ops.now));
  const escalation = shortfall > 0n && ops.escalations ? ops.escalations.open({ kind: "officer", severity: "medium", payload: { interest_credit_id: f.credit.id, custodial_account_id: f.credit.custodial_account_id, E: f.admin_expense_cents, to_borrowers: r.disposition.to_borrowers_cents, to_corporate: r.disposition.to_corporate_cents, corporate_funds_shortfall_cents: shortfall, loan_count: f.allocations.length, officer_approval_id: f.officer_approval_id ?? null, ledger_account: "corporate_expense_escrow_interest", reason: r.escalation?.reason ?? null } }, ops.actor) : null;
  const escrow_credits = f.allocations.filter((a) => a.statutory_cents > 0n).map((a) => ops.events.append({ type: "escrow.interest.credited", loanId: a.loan_id, actor: ops.actor,
    payload: { loan_id: a.loan_id, amount_cents: a.statutory_cents, credited_on: f.posted_on, state: a.state ?? null, interest_credit_id: f.credit.id, source: "custodial_ti_interest", category: "Taxes & Insurance", reason: "interest credit", next_interest_credit_on: a.next_interest_credit_on ?? nextInterestCreditDate(addDays(f.posted_on, 1), "annual") } }));
  const pendingAfter = ops.ledger.balance(interestPendingRef(f.credit.custodial_account_id));
  const disposition: InterestDisposition = r.disposition.to_borrowers_cents > 0n && (r.disposition.to_corporate_cents > 0n || f.admin_expense_cents > 0n) ? "mixed" : r.disposition.to_borrowers_cents > 0n ? "to_borrowers" : "to_corporate";
  const credit: InterestCreditRow = { ...f.credit, admin_expense_cents: f.admin_expense_cents, disposition, disbursed_on: pendingAfter === 0n ? f.posted_on : null };
  const disbursed = pendingAfter === 0n ? ops.events.append({ type: "custodial.interest.disbursed", aggregate: agg, actor: ops.actor,
    payload: { interest_credit_id: f.credit.id, custodial_account_id: f.credit.custodial_account_id, interest_pending_after_cents: pendingAfter, disbursed_on: f.posted_on, on_time: r.on_time, to_borrowers_cents: r.disposition.to_borrowers_cents, to_fees_cents: r.disposition.to_fees_cents, to_corporate_cents: r.disposition.to_corporate_cents, corporate_funds_shortfall_cents: shortfall, loan_count: f.allocations.length, memo_template: r.memo.template } }) : null;
  ops.decide?.({ agent: ops.actor.id, action: "custodial.interest.dispose", ruleSetVersion: "6.2@rule2.v1", ruleCode: "A4-1-02", subject: { kind: "custodial_interest_credit", id: f.credit.id },
    rationale: JSON.stringify({ interest_credit_id: f.credit.id, E: String(f.admin_expense_cents), to_borrowers: String(r.disposition.to_borrowers_cents), to_corporate: String(r.disposition.to_corporate_cents), corporate_funds_shortfall: String(shortfall), loan_count: f.allocations.length, jurisdiction_rule_versions: f.jurisdiction_rule_versions ?? {} }) });
  return { credit, disposition: r.disposition, postings: r.sets, sets, interest_pending_after_cents: pendingAfter, on_time: r.on_time, disbursed, escrow_credits, escalation_id: escalation?.id ?? null, memo: r.memo };
}

/** The T&I account an entry set touches (its `custodial_ti_*` line), for the bus hook below. */
export const tiAccountIdOf = (set: { readonly lines?: readonly { readonly account: { readonly scope: string; readonly account: string; readonly custodialAccountId?: string } }[] } | undefined): string | null =>
  set?.lines?.find((l) => l.account.scope === "custodial" && /^(custodial_ti|interest_pending)/.test(l.account.account))?.account.custodialAccountId ?? null;
/**
 * Bus hook for `ledger.post` (6.2): after a posting that names an `interest_credit_id`, the disbursed event is
 * emitted iff the ledger shows the credit (interest-pending lines exist for the account) and its interest-pending
 * balance is zero — the "all of the credit moved out" condition proven from postings, not a caller's flag.
 */
export function interestDisbursedIfSettled(ops: TiOps, f: { interest_credit_id: string; custodial_account_id?: string | null; entry_set?: Parameters<typeof tiAccountIdOf>[0]; posted_on?: PlainDate }): DomainEvent | null {
  need(f.interest_credit_id.trim().length > 0, "interest_credit_id is required");
  const id = f.custodial_account_id || tiAccountIdOf(f.entry_set);
  if (!id) return null;
  const ref = interestPendingRef(id);
  if (ops.ledger.linesFor(ref).length === 0) return null;   // no credit on the books: nothing to have disbursed
  const balance = ops.ledger.balance(ref);
  if (balance !== 0n) return null;
  return ops.events.append({ type: "custodial.interest.disbursed", aggregate: { kind: CUSTODIAL_ACCOUNT, id }, actor: ops.actor, payload: { interest_credit_id: f.interest_credit_id, custodial_account_id: id, interest_pending_after_cents: balance, disbursed_on: f.posted_on ?? todayOf(ops) } });
}

/**
 * 6.2-T4 — `timer.breached{code=FNMA_A4102_TI_INTEREST_DISBURSE_30}`: `officer`, medium; the amount stays in the
 * composition "Other" line (Form 496A line 6) with aging until cleared.
 */
export function handleInterestDisbursementBreach(ops: TiOps, f: { code: string; timer_id?: string; credit: InterestCreditRow; now_ms: number }): ReturnType<typeof interestDispositionStatus> & { escalation_id: string | null } {
  need(f.code === "FNMA_A4102_TI_INTEREST_DISBURSE_30", `not the interest-disbursement timer: ${f.code}`);
  const s = interestDispositionStatus({ credited_on: f.credit.credited_on, amount_cents: f.credit.amount_cents, disposed_at_ms: f.credit.disbursed_on ? zonedEpochMs(f.credit.disbursed_on, "17:00", ET) : null, now_ms: f.now_ms });
  const escalation = s.escalation && ops.escalations ? ops.escalations.open({ kind: "officer", severity: s.escalation.severity, payload: { timer_code: f.code, timer_id: f.timer_id ?? null, interest_credit_id: f.credit.id, custodial_account_id: f.credit.custodial_account_id, amount_cents: f.credit.amount_cents, credited_on: f.credit.credited_on, due_at: new Date(s.due_ms).toISOString(), status: s.status, form496a_item: s.form496a_item } }, ops.actor) : null;
  return { ...s, escalation_id: escalation?.id ?? null };
}

// ---- state escrow interest (cadence; 3.9 owns the rate) -------------------------
export type EscrowInterestFrequency = "annual" | "quarterly" | "at_analysis";
/**
 * Next statutory credit date per `jurisdiction_rules.escrow_interest.frequency`: quarterly → last day of the
 * calendar quarter; annual → December 31 (the annual escrow statement cycle, 3.3); at_analysis → last day of the
 * loan's analysis month, next occurrence on or after `from`.
 */
export function nextInterestCreditDate(from: PlainDate, frequency: EscrowInterestFrequency, analysisMonth?: number): PlainDate {
  const p = parts(from);
  if (frequency === "quarterly") return endOfMonth(ymd(p.y, Math.ceil(p.m / 3) * 3, 1));
  if (frequency === "annual") return ymd(p.y, 12, 31);
  need(analysisMonth !== undefined && Number.isInteger(analysisMonth) && analysisMonth >= 1 && analysisMonth <= 12, "at_analysis cadence needs the analysis month (1–12)");
  const same = endOfMonth(ymd(p.y, analysisMonth!, 1));
  return same >= from ? same : endOfMonth(addMonths(same, 12));
}
/**
 * `escrow.account.opened` in an interest state arms STATE_ESCROW_INTEREST_CREDIT_RECUR (anchor
 * `next_interest_credit_on`; jurisdiction override — NY GOL §5-601, CA Civ. Code §2954.8, MN Stat. §47.20 …
 * per 00a §5.5; rate details owned by 3.9). A non-interest state opens the account with `interest_state=false`.
 */
export function openEscrowAccount(ops: TiOps, f: { loan_id: string; state: string; opened_on: PlainDate; escrow_interest: { rate_pct: string; frequency: EscrowInterestFrequency; rule_version?: string; analysis_month?: number } | null; initial_balance_cents?: Cents }): { interest_state: boolean; next_interest_credit_on: PlainDate | null; event: DomainEvent } {
  need(f.loan_id.trim().length > 0, "loan_id is required");
  need(/^[A-Z]{2}$/.test(f.state), `state must be a two-letter code (got ${f.state})`);
  plainDate(f.opened_on);
  const interest_state = f.escrow_interest !== null;
  const next = f.escrow_interest ? nextInterestCreditDate(f.opened_on, f.escrow_interest.frequency, f.escrow_interest.analysis_month) : null;
  const event = ops.events.append({ type: "escrow.account.opened", loanId: f.loan_id, actor: ops.actor,
    payload: { loan_id: f.loan_id, state: f.state, opened_on: f.opened_on, interest_state, escrow_interest_frequency: f.escrow_interest?.frequency ?? null, escrow_interest_rate_pct: f.escrow_interest?.rate_pct ?? null, jurisdiction_rule_version: f.escrow_interest?.rule_version ?? null, next_interest_credit_on: next, initial_balance_cents: f.initial_balance_cents ?? 0n } });
  return { interest_state, next_interest_credit_on: next, event };
}
