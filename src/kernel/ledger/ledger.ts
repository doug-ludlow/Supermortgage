/**
 * Double-entry ledger. Every money movement in the spec is an *entry set*
 * (the `ledger_entry_set_id` on `payment_allocations`) that must balance to
 * zero across its lines, each line tagged with the `rule_ref` that justified
 * it (e.g. `F-1-09:order_1999plus:interest`).
 *
 * Accounts are scoped: loan-level (`principal`, `interest_due`, `escrow`,
 * `suspense_unapplied`, ...), custodial (`clearing_cash`, `custodial_pi_cash`,
 * ...) and corporate (`servicing_fee_income`, ...). Amounts are cents; debit
 * positive, credit negative — so a set balances iff its lines sum to 0.
 */
import { randomUUID } from "node:crypto";
import type { Cents } from "../money/cents.ts";
import type { PlainDate } from "../calendar/date.ts";

export type AccountScope = "loan" | "custodial" | "corporate";

export const LOAN_ACCOUNTS = [
  "principal", "interest_due", "escrow", "suspense_unapplied", "late_charges", "nsf_fees", "other_fees",
  "deferred_principal", "forborne_principal", "corporate_advance", "escrow_advance",
  // §14.1 data model: bk_* loan sub-accounts (baseline §5 extension)
  "bk_prepetition_arrearage", "bk_postpetition_suspense", "bk_postpetition_fees_memo", "bk_unsecured_cramdown", "bk_trustee_clearing",
  // §16.2/16.3: the recording-fee liability collected from the payoff funds
  "recording_fee_payable",
  // origination (30.2 opening set / 24.3 completion holdback / 26.x buydown funds)
  "prepaid_interest", "buydown_funds", "holdback_escrow",
  // §27.1 warehouse: the per-loan advance receivable (sub-ledgered by component) and the partner's mirror
  "warehouse_advance_receivable.principal", "warehouse_advance_receivable.capitalized_interest", "warehouse_advance_receivable.fees", "warehouse_interest_receivable", "warehouse_fees_receivable", "partner_funding_contribution", "warehouse_payable",
] as const;
export const CUSTODIAL_ACCOUNTS = [
  "clearing_cash", "custodial_pi_cash", "custodial_ti_cash", "custodial_ti_unapplied_cash", "transfer_in_clearing",
  // §6.2 interest pending / §15.3 remittance payable
  "interest_pending", "fnma_remittance_payable",
  // §30.2 per-loan funding clearing and the pre-purchase T&I account (30.1 prerequisite)
  "origination_funding_clearing", "custodial_ti_prepurchase_cash",
  // §27.1/27.2 warehouse funding, collection and haircut-reserve bank accounts
  "sm_funding_cash", "sm_collection_cash", "partner_haircut_reserve",
] as const;
export const CORPORATE_ACCOUNTS = [
  "servicing_fee_income", "late_charge_income", "nsf_fee_income", "corporate_cash", "fnma_payable", "advance_receivable",
  // §6.2 custodial reconciliation
  "corporate_bank_fee_recovery", "corporate_interest_income", "corporate_expense_escrow_interest", "interest_due_corporate",
  // §16.3 lien release
  "release_penalty_expense", "release_recording_expense",
  // origination vendor costs and fee receivables (21.4 / 22.1 / 24.1); tolerance cures and refunds (21.5); committing fees (29.1)
  "third_party_costs", "accounts_payable_vendor", "origination_fees_receivable", "origination_vendor_payable", "tolerance_cure_expense", "borrower_refunds_payable",
  "committing_fee_expense", "committing_fee_partner_draft", "partner_reimbursable_from_sm",
  // §26.3/27.1 warehouse (SM side) and §27.2 settlement / partner GL mirror
  "warehouse_advance_receivable", "warehouse_interest_receivable", "warehouse_fees_receivable", "warehouse_interest_income", "warehouse_fees", "warehouse_loss_reserve", "warehouse_interest_expense",
  "sm_funding_cash", "partner_haircut_reserve", "warehouse_payable", "partner_funding_contribution",
  "purchase_proceeds_receivable", "purchase_proceeds_suspense", "sm_cost_recovery_receivable", "sm_cost_recovery_income", "sm_program_margin", "partner_settlement_payable", "partner_shortfall_receivable",
  "platform_fee_receivable", "platform_fee_income", "gain_on_sale", "loans_held_for_sale", "cost_recovery_expense", "partner_residual_receivable", "premium_recapture_payable", "borrower_rate_passthrough", "premium_recapture_contingency",
] as const;

export type LoanAccount = (typeof LOAN_ACCOUNTS)[number];
export type CustodialAccount = (typeof CUSTODIAL_ACCOUNTS)[number];
export type CorporateAccount = (typeof CORPORATE_ACCOUNTS)[number];

export type AccountRef =
  | { scope: "loan"; loanId: string; account: LoanAccount }
  | { scope: "custodial"; custodialAccountId: string; account: CustodialAccount }
  | { scope: "corporate"; account: CorporateAccount };

export function accountKey(a: AccountRef): string {
  switch (a.scope) {
    case "loan": return `loan:${a.loanId}:${a.account}`;
    case "custodial": return `custodial:${a.custodialAccountId}:${a.account}`;
    case "corporate": return `corporate:${a.account}`;
  }
}

export interface LineInput {
  readonly account: AccountRef;
  /** Debit positive, credit negative. */
  readonly amountCents: Cents;
  readonly ruleRef: string;
  readonly memo?: string;
}

export interface EntrySetInput {
  readonly effectiveDate: PlainDate;
  readonly description: string;
  readonly lines: readonly LineInput[];
  readonly sourceEventId?: string;
  /** For reversals, the set being reversed. */
  readonly reversesSetId?: string;
}

export interface Line extends LineInput { readonly id: string; readonly setId: string; readonly sequence: number; }
export interface EntrySet extends EntrySetInput { readonly id: string; readonly postedAt: string; readonly lines: readonly Line[]; }

export class UnbalancedEntrySet extends Error {
  readonly sumCents: Cents;
  readonly input: EntrySetInput;
  constructor(sumCents: Cents, input: EntrySetInput) {
    super(`entry set "${input.description}" does not balance: sum ${sumCents} cents`);
    this.sumCents = sumCents;
    this.input = input;
  }
}

export interface Ledger {
  post(input: EntrySetInput, postedAt?: string): EntrySet;
  reverse(setId: string, effectiveDate: PlainDate, reason: string, postedAt?: string): EntrySet;
  balance(account: AccountRef, asOf?: PlainDate): Cents;
  sets(): readonly EntrySet[];
  linesFor(account: AccountRef): readonly Line[];
}

export class MemoryLedger implements Ledger {
  private readonly entrySets: EntrySet[] = [];
  private readonly balances = new Map<string, Cents>();
  private readonly lineIndex = new Map<string, Line[]>();

  post(input: EntrySetInput, postedAt: string = new Date().toISOString()): EntrySet {
    if (input.lines.length < 2) throw new RangeError("an entry set needs at least two lines");
    const sum = input.lines.reduce((s, l) => s + l.amountCents, 0n);
    if (sum !== 0n) throw new UnbalancedEntrySet(sum, input);
    for (const l of input.lines) if (l.amountCents === 0n) throw new RangeError(`zero-amount line on ${accountKey(l.account)}`);
    const id = randomUUID();
    const lines: Line[] = input.lines.map((l, i) => ({ ...l, id: randomUUID(), setId: id, sequence: i + 1 }));
    const set: EntrySet = { ...input, id, postedAt, lines };
    this.entrySets.push(set);
    for (const l of lines) {
      const k = accountKey(l.account);
      this.balances.set(k, (this.balances.get(k) ?? 0n) + l.amountCents);
      let arr = this.lineIndex.get(k); if (!arr) { arr = []; this.lineIndex.set(k, arr); }
      arr.push(l);
    }
    return set;
  }

  /** Hydrate persisted entry sets (balances and line index rebuilt; nothing re-validated — the store already did). */
  seed(history: readonly EntrySet[]): void {
    for (const set of history) {
      this.entrySets.push(set);
      for (const l of set.lines) {
        const k = accountKey(l.account);
        this.balances.set(k, (this.balances.get(k) ?? 0n) + l.amountCents);
        let arr = this.lineIndex.get(k); if (!arr) { arr = []; this.lineIndex.set(k, arr); }
        arr.push(l);
      }
    }
  }

  /** Reversal = a new set with every line negated. Ledgers are never edited (spec: "never an edit"). */
  reverse(setId: string, effectiveDate: PlainDate, reason: string, postedAt?: string): EntrySet {
    const orig = this.entrySets.find((s) => s.id === setId);
    if (!orig) throw new RangeError(`no entry set ${setId}`);
    return this.post({
      effectiveDate,
      description: `REVERSAL of ${orig.description}: ${reason}`,
      reversesSetId: setId,
      lines: orig.lines.map((l) => ({ account: l.account, amountCents: -l.amountCents, ruleRef: l.ruleRef, memo: `reversal: ${reason}` })),
    }, postedAt);
  }

  balance(account: AccountRef, asOf?: PlainDate): Cents {
    if (asOf === undefined) return this.balances.get(accountKey(account)) ?? 0n;
    let s = 0n;
    for (const set of this.entrySets) if (set.effectiveDate <= asOf) for (const l of set.lines) if (accountKey(l.account) === accountKey(account)) s += l.amountCents;
    return s;
  }
  sets(): readonly EntrySet[] { return this.entrySets; }
  linesFor(account: AccountRef): readonly Line[] { return this.lineIndex.get(accountKey(account)) ?? []; }
}
