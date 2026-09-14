/**
 * §34.3 rule 2 — "History shows what changed." Each import row of a partner: as-of date, uploaded by, rows, exceptions,
 * created / updated / unchanged, parties, invitations, on hold; opening it lists the per-loan lines with the change and, for
 * an updated loan, the facts that differed (UPB, rate, P&I, next due, status, value) as before / after — derived from the
 * import's partner_book_facts row against the loan's previous one (Verified requirement, discrepancy 2: never stored again).
 * The report itself is 33.1's (`partner_book_imports.report`): exceptions by code with the row and the servicer loan number,
 * the gap counts, the supplement's matched / orphan counts, the loans now on hold (`not_on_tape`), a rejected file's missing
 * headers. Nothing is computed about a loan (rule 7): a "before" and an "after" are two stored facts side by side.
 */
import type { Queryable } from "../../infra/db/client.ts";
import type { Runtime } from "../app.ts";
import { type Row, isUuid, scrubDestinations, str } from "./common.ts";

/** The facts the history compares for an updated loan (rule 2: UPB, rate, P&I, next due, status, value). */
export const HISTORY_FACT_KEYS: readonly { key: string; label: string }[] = [
  { key: "upb_cents", label: "UPB" }, { key: "note_rate_pct", label: "rate" }, { key: "pi_cents", label: "P&I" }, { key: "next_due_date", label: "next due" }, { key: "servicing_status", label: "status" },
  { key: "fmv_cents", label: "value" }, { key: "fmv_date", label: "value date" }, { key: "bpo_value_cents", label: "BPO" }, { key: "bpo_date", label: "BPO date" },
];
export type FactDiff = { key: string; label: string; before: unknown; after: unknown };
export type ImportLoanLine = { loan_id: string; servicer_loan_number: string; party_id: string | null; change: "created" | "updated" | "unchanged"; as_of_date: string | null; previous_as_of_date: string | null; diff: FactDiff[]; changed_keys: string[] };
export type ImportHistoryRow = {
  import_id: string; partner_party_id: string; as_of_date: string; profile: string; status: string; uploaded_by: string | null; created_at: string;
  rows_total: number; rows_loaded: number; rows_exception: number; loans_created: number; loans_updated: number; loans_unchanged: number; parties_created: number; parties_linked: number;
  invitations_sent: number; invitations_held: number; on_hold: number; exceptions_by_code: Record<string, number>; missing_headers: string[] | null;
};
export type ImportDetail = ImportHistoryRow & { report: Row; lines: ImportLoanLine[]; not_on_tape: { loan_id: string; servicer_loan_number: string; last_as_of_date: string }[] };

type ImportRow = { id: string; partner_party_id: string; as_of_date: string; profile: string; status: string; actor_id: string | null; created_at: string; rows_total: number; rows_loaded: number; rows_exception: number; loans_created: number; loans_updated: number; parties_created: number; parties_linked: number; invitations_sent: number; report: Row };
const IMPORT_COLS = `id::text AS id, partner_party_id::text AS partner_party_id, as_of_date::text AS as_of_date, profile, status, actor_id, created_at::text AS created_at, rows_total, rows_loaded, rows_exception, loans_created, loans_updated, parties_created, parties_linked, invitations_sent, report`;
const arr = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === "object") : []);
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

function historyRow(r: ImportRow): ImportHistoryRow {
  const report = obj(r.report); const gaps = obj(report["gaps"]); const rejected = obj(report["rejected"]);
  const byCode: Record<string, number> = {};
  for (const e of arr(report["exceptions"])) { const code = str(e["code"]) ?? "unknown"; byCode[code] = (byCode[code] ?? 0) + 1; }
  const loaded = Number(r.rows_loaded), created = Number(r.loans_created), updated = Number(r.loans_updated);
  return { import_id: r.id, partner_party_id: r.partner_party_id, as_of_date: r.as_of_date, profile: r.profile, status: r.status, uploaded_by: r.actor_id, created_at: r.created_at,
    rows_total: Number(r.rows_total), rows_loaded: loaded, rows_exception: Number(r.rows_exception), loans_created: created, loans_updated: updated, loans_unchanged: Math.max(0, loaded - created - updated), parties_created: Number(r.parties_created), parties_linked: Number(r.parties_linked),
    invitations_sent: Number(r.invitations_sent), invitations_held: Number(gaps["invitation_held"] ?? 0), on_hold: arr(report["not_on_tape"]).length, exceptions_by_code: byCode, missing_headers: Array.isArray(rejected["missing_headers"]) ? (rejected["missing_headers"] as string[]) : null };
}

/** The import's facts row per loan beside the loan's previous one (by as-of date, then created_at) — two stored rows, nothing derived. */
async function factsPairs(db: Queryable, importId: string): Promise<Map<string, { as_of_date: string; facts: Row; prev_as_of_date: string | null; prev_facts: Row | null }>> {
  const rows = await db.query<{ loan_id: string; as_of_date: string; facts: Row; prev_as_of_date: string | null; prev_facts: Row | null }>(
    `SELECT f.loan_id::text AS loan_id, f.as_of_date::text AS as_of_date, f.facts, p.as_of_date::text AS prev_as_of_date, p.facts AS prev_facts
       FROM partner_book_facts f
       LEFT JOIN LATERAL (SELECT q.as_of_date, q.facts FROM partner_book_facts q WHERE q.loan_id = f.loan_id AND (q.as_of_date < f.as_of_date OR (q.as_of_date = f.as_of_date AND q.created_at < f.created_at)) ORDER BY q.as_of_date DESC, q.created_at DESC LIMIT 1) p ON true
      WHERE f.import_id = $1`, [importId]);
  return new Map(rows.map((r) => [r.loan_id, { as_of_date: r.as_of_date, facts: r.facts, prev_as_of_date: r.prev_as_of_date, prev_facts: r.prev_facts }]));
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** The before / after of the compared facts (rule 2) and every other key that differs (the tape's own as-of date excepted, as 33.1's `unchanged` rule excepts it). */
export function diffFacts(before: Row | null, after: Row): { diff: FactDiff[]; changed_keys: string[] } {
  if (!before) return { diff: [], changed_keys: [] };
  const diff = HISTORY_FACT_KEYS.filter((k) => !same(before[k.key], after[k.key])).map((k) => ({ key: k.key, label: k.label, before: before[k.key] ?? null, after: after[k.key] ?? null }));
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]); keys.delete("as_of_date");
  return { diff, changed_keys: [...keys].filter((k) => !same(before[k], after[k])).sort() };
}

/** GET …/imports/{id}: the report and the per-row lines with the before / after facts of every updated loan. */
export async function bookImportDetail(rt: Runtime, importId: string): Promise<ImportDetail | null> {
  if (!isUuid(importId)) return null;
  const r = (await rt.db.query<ImportRow>(`SELECT ${IMPORT_COLS} FROM partner_book_imports WHERE id = $1`, [importId]))[0];
  if (!r) return null;
  const head = historyRow(r); const report = obj(r.report);
  const pairs = await factsPairs(rt.db, importId);
  const lines: ImportLoanLine[] = arr(report["loans"]).map((l) => {
    const loanId = str(l["loan_id"]) ?? ""; const change = (str(l["change"]) ?? "unchanged") as ImportLoanLine["change"]; const pair = pairs.get(loanId);
    const d = change === "updated" && pair ? diffFacts(pair.prev_facts, pair.facts) : { diff: [], changed_keys: [] };
    return { loan_id: loanId, servicer_loan_number: str(l["servicer_loan_number"]) ?? "", party_id: str(l["party_id"]), change, as_of_date: pair?.as_of_date ?? null, previous_as_of_date: pair?.prev_as_of_date ?? null, diff: d.diff.map((x) => scrubDestinations(x as unknown as Row) as unknown as FactDiff), changed_keys: d.changed_keys };
  });
  const not_on_tape = arr(report["not_on_tape"]).map((n) => ({ loan_id: str(n["loan_id"]) ?? "", servicer_loan_number: str(n["servicer_loan_number"]) ?? "", last_as_of_date: str(n["last_as_of_date"]) ?? "" }));
  // the report as stored, its invitations reduced to hashes and dates (NO_DESTINATION — 33.1 stores hashes already; the projection re-asserts it)
  const invitations = arr(report["invitations"]).map((i) => ({ party_id: str(i["party_id"]), loan_id: str(i["loan_id"]), channel: str(i["channel"]), destination_hash: str(i["destination_hash"]), notice_id: str(i["notice_id"]), bounced: i["bounced"] === true, held_reason: str(i["held_reason"]) }));
  return { ...head, report: { ...report, invitations }, lines, not_on_tape };
}

/** GET …/imports?partner=: the history, newest first — each import with what it changed and its per-loan lines. */
export async function bookHistory(rt: Runtime, partnerId?: string | null, opts: { readonly lines?: boolean; readonly limit?: number } = {}): Promise<{ partner_party_id: string | null; imports: (ImportHistoryRow & { lines?: ImportLoanLine[] })[] }> {
  const partner = isUuid(partnerId) ? partnerId : null;
  const rows = await rt.db.query<ImportRow>(`SELECT ${IMPORT_COLS} FROM partner_book_imports WHERE ($1::uuid IS NULL OR partner_party_id = $1::uuid) ORDER BY created_at DESC, as_of_date DESC LIMIT $2`, [partner, Math.min(Math.max(opts.limit ?? 200, 1), 1000)]);
  const imports: (ImportHistoryRow & { lines?: ImportLoanLine[] })[] = [];
  for (const r of rows) {
    const head = historyRow(r);
    if (opts.lines === false) { imports.push(head); continue; }
    const detail = await bookImportDetail(rt, r.id);
    imports.push({ ...head, lines: detail?.lines ?? [] });
  }
  return { partner_party_id: partner, imports };
}
