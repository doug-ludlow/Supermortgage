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
] as const;
export const CUSTODIAL_ACCOUNTS = ["clearing_cash", "custodial_pi_cash", "custodial_ti_cash", "custodial_ti_unapplied_cash", "transfer_in_clearing"] as const;
export const CORPORATE_ACCOUNTS = ["servicing_fee_income", "late_charge_income", "nsf_fee_income", "corporate_cash", "fnma_payable", "advance_receivable"] as const;

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
