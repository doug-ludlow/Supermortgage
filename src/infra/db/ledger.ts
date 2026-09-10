/**
 * `ledger_entry_sets` / `ledger_lines` repository. The database enforces what
 * MemoryLedger enforces in code: lines are immutable, every set balances (a
 * deferred constraint trigger checks the sum at COMMIT), and reversals are
 * new sets that reference the original.
 */
import type { EntrySet, Line, AccountRef, AccountScope, LoanAccount, CustodialAccount, CorporateAccount } from "../../kernel/ledger/ledger.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Queryable } from "./client.ts";

interface SetRow extends Record<string, unknown> { id: string; effective_date: string; posted_at: string; description: string; source_event_id: string | null; reverses_set_id: string | null; }
interface LineRow extends Record<string, unknown> { id: string; set_id: string; sequence: number; scope: AccountScope; account: string; loan_id: string | null; custodial_account_id: string | null; amount_cents: bigint; rule_ref: string; memo: string | null; }

function refOf(r: LineRow): AccountRef {
  if (r.scope === "loan") return { scope: "loan", loanId: r.loan_id!, account: r.account as LoanAccount };
  if (r.scope === "custodial") return { scope: "custodial", custodialAccountId: r.custodial_account_id!, account: r.account as CustodialAccount };
  return { scope: "corporate", account: r.account as CorporateAccount };
}
function rowToLine(r: LineRow): Line {
  return { id: r.id, setId: r.set_id, sequence: r.sequence, account: refOf(r), amountCents: r.amount_cents, ruleRef: r.rule_ref, ...(r.memo ? { memo: r.memo } : {}) };
}
function whereAccount(a: AccountRef, startAt: number): { sql: string; params: unknown[] } {
  if (a.scope === "loan") return { sql: `scope = 'loan' AND loan_id = $${startAt} AND account = $${startAt + 1}`, params: [a.loanId, a.account] };
  if (a.scope === "custodial") return { sql: `scope = 'custodial' AND custodial_account_id = $${startAt} AND account = $${startAt + 1}`, params: [a.custodialAccountId, a.account] };
  return { sql: `scope = 'corporate' AND account = $${startAt}`, params: [a.account] };
}

export class PgLedgerRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  /** Persist a set the domain already validated. The balance trigger re-checks at COMMIT. */
  async post(set: EntrySet, q: Queryable = this.db): Promise<void> {
    await q.query(`INSERT INTO ledger_entry_sets (id, effective_date, posted_at, description, source_event_id, reverses_set_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [set.id, set.effectiveDate, set.postedAt, set.description, set.sourceEventId ?? null, set.reversesSetId ?? null]);
    for (const l of set.lines) {
      const a = l.account;
      await q.query(`INSERT INTO ledger_lines (id, set_id, sequence, scope, account, loan_id, custodial_account_id, amount_cents, rule_ref, memo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [l.id, set.id, l.sequence, a.scope, a.account, a.scope === "loan" ? a.loanId : null, a.scope === "custodial" ? a.custodialAccountId : null, l.amountCents, l.ruleRef, l.memo ?? null]);
    }
  }
  async balance(account: AccountRef, asOf?: PlainDate): Promise<Cents> {
    const w = whereAccount(account, 1);
    const params: unknown[] = [...w.params];
    let sql = `SELECT coalesce(sum(l.amount_cents), 0)::bigint AS s FROM ledger_lines l`;
    if (asOf !== undefined) { params.push(asOf); sql += ` JOIN ledger_entry_sets s ON s.id = l.set_id WHERE ${w.sql} AND s.effective_date <= $${params.length}`; }
    else sql += ` WHERE ${w.sql}`;
    const rows = await this.db.query<{ s: bigint }>(sql, params);
    return rows[0]!.s;
  }
  async linesFor(account: AccountRef): Promise<Line[]> {
    const w = whereAccount(account, 1);
    return (await this.db.query<LineRow>(`SELECT * FROM ledger_lines WHERE ${w.sql} ORDER BY created_at, sequence`, w.params)).map(rowToLine);
  }
  /** Every set touching a loan (any line with that loan_id), lines included, oldest first. */
  async setsForLoan(loanId: string): Promise<EntrySet[]> {
    const sets = await this.db.query<SetRow>(`SELECT DISTINCT s.* FROM ledger_entry_sets s JOIN ledger_lines l ON l.set_id = s.id WHERE l.loan_id = $1 ORDER BY s.posted_at, s.id`, [loanId]);
    const out: EntrySet[] = [];
    for (const s of sets) {
      const lines = (await this.db.query<LineRow>(`SELECT * FROM ledger_lines WHERE set_id = $1 ORDER BY sequence`, [s.id])).map(rowToLine);
      out.push({ id: s.id, effectiveDate: s.effective_date as PlainDate, postedAt: s.posted_at, description: s.description, lines,
        ...(s.source_event_id ? { sourceEventId: s.source_event_id } : {}), ...(s.reverses_set_id ? { reversesSetId: s.reverses_set_id } : {}) });
    }
    return out;
  }
}
