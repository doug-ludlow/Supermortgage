/**
 * §35.4 — SQL reads over the sections' own typed rows (rule 12: "every figure on an attestation is read"): the reportable
 * sets of the tax year (7.1's own `interest_due` query, src/runtime/servicing.ts:255), the custodial cashbook, 6.3's
 * composition rows and its statement of record, and the receipt rows of loan_events. Nothing here writes.
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { PlainDate } from "../../../kernel/calendar/date.ts";
import { IRS_1098_FILE_FLOOR, IRS_1099_INT_FLOOR } from "./figures.ts";

const big = (s: string | null | undefined): bigint => BigInt(s ?? "0");

/** 7.1 rule 11: every loan with `interest_due` credits from borrower funds in the calendar year (the 2.1 allocation credits; amount_cents < 0), with the year's sum per loan. */
export async function reportableLoans(q: Queryable, taxYear: number): Promise<{ loan_id: string; interest_cents: bigint }[]> {
  const rows = await q.query<{ loan_id: string; s: string }>(`SELECT l.loan_id::text AS loan_id, (-sum(l.amount_cents))::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id
    WHERE l.scope = 'loan' AND l.account = 'interest_due' AND l.amount_cents < 0 AND e.effective_date >= $1::date AND e.effective_date < $2::date GROUP BY l.loan_id HAVING sum(l.amount_cents) < 0 ORDER BY l.loan_id`, [`${taxYear}-01-01`, `${taxYear + 1}-01-01`]);
  return rows.map((r) => ({ loan_id: r.loan_id, interest_cents: big(r.s) }));
}
export const filedLoans = (loans: readonly { interest_cents: bigint }[]): number => loans.filter((l) => l.interest_cents >= IRS_1098_FILE_FLOOR).length;
/** 3.9: the loans whose escrow interest credited in the year is at or above $10.00 per borrower (the `corporate_expense_escrow_interest` debits are the corporate side; the loan side is the `escrow` credit whose rule_ref names 3.9). */
export async function ioe1099Loans(q: Queryable, taxYear: number): Promise<{ loan_id: string; interest_cents: bigint }[]> {
  const rows = await q.query<{ loan_id: string; s: string }>(`SELECT l.loan_id::text AS loan_id, (-sum(l.amount_cents))::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id
    WHERE l.scope = 'loan' AND l.account IN ('escrow', 'escrow_liability') AND l.amount_cents < 0 AND l.rule_ref LIKE '%3.9%' AND e.effective_date >= $1::date AND e.effective_date < $2::date GROUP BY l.loan_id ORDER BY l.loan_id`, [`${taxYear}-01-01`, `${taxYear + 1}-01-01`]);
  return rows.map((r) => ({ loan_id: r.loan_id, interest_cents: big(r.s) })).filter((r) => r.interest_cents >= IRS_1099_INT_FLOOR);
}
/** Rule 10: the 1099-A/C set — a 15.x acquisition (redemption ended, Mortgage Release accepted, third-party sale), a known abandonment, or a discharge of debt in the year; read from the sections' own events (no 15.x typed row at HEAD). */
export async function form1099AcLoans(q: Queryable, taxYear: number): Promise<{ loan_id: string; kind: "A" | "C"; event_type: string; event_id: string }[]> {
  const rows = await q.query<{ loan_id: string; type: string; id: string }>(`SELECT loan_id::text AS loan_id, type, id::text AS id FROM loan_events WHERE loan_id IS NOT NULL AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
    AND type IN ('foreclosure.sale.completed', 'foreclosure.sale.third_party', 'reo.acquired', 'mortgage_release.accepted', 'mortgage_release.completed', 'redemption.expired', 'property.abandoned', 'debt.discharged', 'charge_off.discharged') ORDER BY occurred_at`, [`${taxYear}-01-01T05:00:00.000Z`, `${taxYear + 1}-01-01T05:00:00.000Z`]);
  const seen = new Set<string>(); const out: { loan_id: string; kind: "A" | "C"; event_type: string; event_id: string }[] = [];
  for (const r of rows) { const kind = /discharg/.test(r.type) ? "C" : "A"; const k = `${r.loan_id}:${kind}`; if (seen.has(k)) continue; seen.add(k); out.push({ loan_id: r.loan_id, kind, event_type: r.type, event_id: r.id }); }
  return out;
}

/** Rule 3: cashbook = Σ ledger_lines(custodial_pi_cash:<account>) through as_of (bigint; debit +, credit −). */
export async function cashbook(q: Queryable, custodialAccountId: string, asOf: PlainDate): Promise<bigint> {
  const r = await q.query<{ s: string }>(`SELECT coalesce(sum(l.amount_cents), 0)::text AS s FROM ledger_lines l JOIN ledger_entry_sets e ON e.id = l.set_id WHERE l.scope = 'custodial' AND l.custodial_account_id = $1 AND l.account = 'custodial_pi_cash' AND e.effective_date <= $2::date`, [custodialAccountId, asOf]);
  return big(r[0]?.s);
}
/** 6.3 rule 6: the composition L1..L11 from `remittance_components` for the period (component_code `Ln_*` → `Ln`), as cents. */
export async function composition(q: Queryable, custodialAccountId: string, period: string, remittanceType: string | null): Promise<Record<string, bigint>> {
  const rows = await q.query<{ code: string; s: string }>(`SELECT component_code AS code, amount_cents::text AS s FROM remittance_components WHERE custodial_account_id = $1 AND period = $2${remittanceType ? " AND remittance_type = $3" : ""} ORDER BY component_code`, remittanceType ? [custodialAccountId, period, remittanceType] : [custodialAccountId, period]);
  const out: Record<string, bigint> = {};
  for (const r of rows) { const m = /^(L\d{1,2})_/.exec(r.code); if (m) out[m[1]!] = (out[m[1]!] ?? 0n) + big(r.s); }
  return out;
}
export const l12Of = (c: Record<string, bigint>): bigint => Object.values(c).reduce((a, b) => a + b, 0n);
/** The composition in the wire form: `{L1..L11: "<cents>"}` decimal strings, in line order. */
export const compositionSnapshot = (c: Record<string, bigint>): Record<string, string> => Object.fromEntries(Object.keys(c).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map((k) => [k, c[k]!.toString()]));

export interface StatementOfRecord { readonly closing_ledger_cents: bigint | null; readonly document_id: string | null; readonly source: "bank_statements" | "custodial.statement.received" | null; readonly event_id: string | null; readonly statement_id: string | null }
/** 6.3's balance of record for the day: the `bank_statements` row (closing_ledger_cents, raw_document_id) when 6.3 wrote one, else its own `custodial.statement.received{closing_ledger_cents}` event for as_of_date (the latest one — a restatement is a later event). */
export async function statementOfRecord(q: Queryable, custodialAccountId: string, asOf: PlainDate): Promise<StatementOfRecord> {
  const row = (await q.query<{ c: string | null; d: string | null; id: string }>(`SELECT closing_ledger_cents::text AS c, raw_document_id::text AS d, id::text AS id FROM bank_statements WHERE custodial_account_id = $1 AND as_of_date = $2::date AND format IN ('bai2', 'camt053') AND coalesce(control_totals_ok, true) ORDER BY parsed_at DESC NULLS LAST LIMIT 1`, [custodialAccountId, asOf]))[0];
  if (row && row.c !== null) return { closing_ledger_cents: big(row.c), document_id: row.d, source: "bank_statements", event_id: null, statement_id: row.id };
  const ev = (await q.query<{ id: string; payload: Record<string, unknown> }>(`SELECT id::text AS id, payload FROM loan_events WHERE type = 'custodial.statement.received' AND payload->>'custodial_account_id' = $1 AND payload->>'as_of_date' = $2 AND coalesce(payload->>'control_totals_ok', 'true') = 'true' ORDER BY sequence DESC LIMIT 1`, [custodialAccountId, asOf]))[0];
  if (!ev) return { closing_ledger_cents: null, document_id: null, source: null, event_id: null, statement_id: null };
  const c = ev.payload["closing_ledger_cents"]; const doc = ev.payload["document_id"] ?? ev.payload["raw_document_id"] ?? null;
  return { closing_ledger_cents: c === null || c === undefined ? null : big(String(c)), document_id: doc === null ? null : String(doc), source: "custodial.statement.received", event_id: ev.id, statement_id: ev.payload["statement_id"] === undefined ? null : String(ev.payload["statement_id"]) };
}
/** 6.3 Section I from the items register: the open in-transit items and depository adjustments of the account as of the period end (`reconciliation_items`, first seen on or before as_of, not resolved by then). */
export async function sectionIItems(q: Queryable, custodialAccountId: string, asOf: PlainDate): Promise<{ deposits_in_transit_cents: bigint; disbursements_in_transit_cents: bigint; depository_adjustments_cents: bigint; item_ids: string[] }> {
  const rows = await q.query<{ id: string; category: string; s: string }>(`SELECT id::text AS id, category::text AS category, amount_cents::text AS s FROM reconciliation_items WHERE custodial_account_id = $1 AND first_seen_on <= $2::date AND (resolved_on IS NULL OR resolved_on > $2::date) AND status <> 'written_off' ORDER BY first_seen_on, id`, [custodialAccountId, asOf]);
  let dit = 0n, dsit = 0n, adj = 0n; const ids: string[] = [];
  for (const r of rows) {
    const a = big(r.s);
    if (r.category === "deposit_in_transit") { dit += a; ids.push(r.id); }
    else if (r.category === "disbursement_in_transit" || r.category === "outstanding_check" || r.category === "stale_check") { dsit += a < 0n ? -a : a; ids.push(r.id); }
    else if (r.category === "bank_fee" || r.category === "interest_credit" || r.category === "returned_item" || r.category === "bank_credit_unposted" || r.category === "bank_debit_unposted") { adj += a; ids.push(r.id); }
  }
  return { deposits_in_transit_cents: dit, disbursements_in_transit_cents: dsit, depository_adjustments_cents: adj, item_ids: ids };
}
/** The tax-year attestation's counts from 7.1's typed rows: forms furnished and filed for the year and Σ box 1. */
export async function forms1098(q: Queryable, taxYear: number): Promise<{ furnished: number; filed: number; box1_sum_cents: bigint; furnished_loan_ids: string[]; loan_ids: string[] }> {
  const rows = await q.query<{ loan_id: string; furnished_at: string | null; filed_at: string | null; box1: string | null }>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, furnished_at::text AS furnished_at, filed_at::text AS filed_at, coalesce(boxes->>'box1_cents', boxes->>'box1') AS box1 FROM tax_forms_1098 WHERE tax_year = $1 AND corrected_of IS NULL ORDER BY loan_id, furnished_at DESC NULLS LAST`, [taxYear]);
  let sum = 0n; const furnished: string[] = [];
  for (const r of rows) { sum += big(r.box1); if (r.furnished_at) furnished.push(r.loan_id); }
  return { furnished: furnished.length, filed: rows.filter((r) => r.filed_at).length, box1_sum_cents: sum, furnished_loan_ids: furnished, loan_ids: rows.map((r) => r.loan_id) };
}
