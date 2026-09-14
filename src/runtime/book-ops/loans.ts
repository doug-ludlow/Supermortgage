/**
 * §34.3 rule 3 — "The book and the hold queue." The loans table: servicer loan number, homeowner (masked as 34.2), state,
 * UPB, note rate, next due, value and its date, status, account activated?, latest verdict, ready?; filters by partner,
 * status, hold, verdict, ready. The hold queue lists the loans absent from the latest tape with the last as-of they
 * appeared on and the resolve control (paid_off / transferred_out / keep, with a reason) — 33.1 rule 8.
 *
 * Every figure is the loan's latest partner_book_facts row (UPB, rate, P&I, T&I, next due) or 33.2's own value selection
 * read back through 33.3's `newestFactsValue` (the newest of FMV / BPO by date, else the original appraisal — a choice among
 * stored facts, never an estimate); the verdict is the latest partner_book_reviews row, readiness the latest readiness_checks
 * row, activation the `partner_book.account.activated` event (or a session on the party). Rule 7: nothing computed.
 */
import { newestFactsValue } from "../partner-book-readiness.ts";
import type { Runtime } from "../app.ts";
import { type Homeowner, type Hold, type Row, RESOLUTIONS, holdsOf, homeownersOf, isUuid, str } from "./common.ts";

export type BookLoanRow = {
  loan_id: string; servicer_loan_number: string; partner_party_id: string; partner_legal_name: string; status: string; state: string | null; city: string | null;
  homeowner: Homeowner; facts_as_of: string | null; upb_cents: string | null; note_rate_pct: string | null; pi_cents: string | null; ti_cents: string | null; next_due_date: string | null; last_payment_date: string | null;
  value: { value_cents: string; as_of: string | null } | null; servicing_status: string | null;
  account_activated: boolean; activated_at: string | null; latest_review: { as_of_date: string; verdict: string; reasons: string[] } | null; latest_readiness: { as_of_date: string; ready: boolean; missing: string[] } | null;
  on_hold: boolean; hold: Hold | null;
};
export type BookLoansFilter = { readonly partner?: string | null; readonly status?: string | null; readonly hold?: boolean | null; readonly verdict?: string | null; readonly ready?: boolean | null };
export type HoldQueueRow = Hold & { homeowner: Homeowner; status: string; resolutions: readonly string[] };
export type BookLoans = { filter: BookLoansFilter; loans: BookLoanRow[]; hold_queue: HoldQueueRow[]; counts: { loans: number; on_hold: number; by_status: Record<string, number>; by_verdict: Record<string, number>; ready: number; not_ready: number; unchecked: number } };

const LOAN_STATUSES = new Set(["monitored", "paid_off", "transferred_out"]);
const VERDICTS = new Set(["candidate", "watching", "not_now", "excluded"]);

type LoanRow = { loan_id: string; servicer_loan_number: string; partner_party_id: string; partner_legal_name: string; status: string; state: string | null; city: string | null; facts_as_of: string | null; facts: Row | null; activated_at: string | null; review_as_of: string | null; verdict: string | null; reasons: unknown; ready_as_of: string | null; ready: boolean | null; missing: unknown };
const LOANS_SQL = `SELECT l.id::text AS loan_id, l.servicer_loan_number, l.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_legal_name, l.status::text AS status, p.state, p.city,
       f.as_of_date::text AS facts_as_of, f.facts,
       coalesce((SELECT min(e.occurred_at)::text FROM loan_events e WHERE e.loan_id = l.id AND e.type = 'partner_book.account.activated'),
                (SELECT min(s.created_at)::text FROM sessions s JOIN borrowers b ON b.party_id = s.party_id JOIN loan_borrowers lb ON lb.borrower_id = b.id AND lb.loan_id = l.id)) AS activated_at,
       r.as_of_date::text AS review_as_of, r.verdict, r.reasons, k.as_of_date::text AS ready_as_of, k.ready, k.missing
  FROM loans l
  JOIN parties pp ON pp.id = l.partner_party_id
  LEFT JOIN properties p ON p.id = l.property_id
  LEFT JOIN LATERAL (SELECT q.as_of_date, q.facts FROM partner_book_facts q WHERE q.loan_id = l.id ORDER BY q.as_of_date DESC, q.created_at DESC LIMIT 1) f ON true
  LEFT JOIN LATERAL (SELECT q.as_of_date, q.verdict, q.reasons FROM partner_book_reviews q WHERE q.loan_id = l.id ORDER BY q.as_of_date DESC, q.created_at DESC LIMIT 1) r ON true
  LEFT JOIN LATERAL (SELECT q.as_of_date, q.ready, q.missing FROM readiness_checks q WHERE q.loan_id = l.id ORDER BY q.created_at DESC LIMIT 1) k ON true
 WHERE l.partner_party_id IS NOT NULL AND EXISTS (SELECT 1 FROM partner_book_facts x WHERE x.loan_id = l.id)
   AND ($1::uuid IS NULL OR l.partner_party_id = $1::uuid) AND ($2::text IS NULL OR l.status::text = $2::text)
 ORDER BY pp.legal_name, l.servicer_loan_number, l.id`;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** GET …/loans?partner=&status=&hold=&verdict=&ready= — the book with its latest facts, and the hold queue (33.1 rule 8). */
export async function bookLoans(rt: Runtime, filter: BookLoansFilter = {}, now: string = rt.clock.now()): Promise<BookLoans> {
  const partner = isUuid(filter.partner) ? filter.partner : null;
  const status = filter.status && LOAN_STATUSES.has(filter.status) ? filter.status : null;
  const verdict = filter.verdict && VERDICTS.has(filter.verdict) ? filter.verdict : null;
  const [rows, holds] = await Promise.all([rt.db.query<LoanRow>(LOANS_SQL, [partner, status]), holdsOf(rt, partner, now)]);
  const holdBy = new Map(holds.map((h) => [h.loan_id, h]));
  const owners = await homeownersOf(rt.db, [...new Set([...rows.map((r) => r.loan_id), ...holds.map((h) => h.loan_id)])]);
  const nobody: Homeowner = { party_id: null, legal_name: null, email_masked: null, phone_masked: null };
  const all: BookLoanRow[] = rows.map((r) => {
    const facts = r.facts ?? null; const hold = holdBy.get(r.loan_id) ?? null;
    return { loan_id: r.loan_id, servicer_loan_number: r.servicer_loan_number, partner_party_id: r.partner_party_id, partner_legal_name: r.partner_legal_name, status: r.status, state: r.state, city: r.city,
      homeowner: owners.get(r.loan_id) ?? nobody, facts_as_of: r.facts_as_of,
      upb_cents: str(facts?.["upb_cents"]), note_rate_pct: str(facts?.["note_rate_pct"]), pi_cents: str(facts?.["pi_cents"]), ti_cents: str(facts?.["ti_cents"]), next_due_date: str(facts?.["next_due_date"]), last_payment_date: str(facts?.["last_payment_date"]),
      value: newestFactsValue(facts), servicing_status: str(facts?.["servicing_status"]),
      account_activated: r.activated_at !== null, activated_at: r.activated_at,
      latest_review: r.review_as_of && r.verdict ? { as_of_date: r.review_as_of, verdict: r.verdict, reasons: strings(r.reasons) } : null,
      latest_readiness: r.ready_as_of ? { as_of_date: r.ready_as_of, ready: r.ready === true, missing: strings(r.missing) } : null,
      on_hold: hold !== null, hold };
  });
  const loans = all.filter((l) => (filter.hold === true ? l.on_hold : filter.hold === false ? !l.on_hold : true) && (verdict ? l.latest_review?.verdict === verdict : true) && (filter.ready === true ? l.latest_readiness?.ready === true : filter.ready === false ? l.latest_readiness !== null && !l.latest_readiness.ready : true));
  const by = (pick: (l: BookLoanRow) => string | null): Record<string, number> => { const out: Record<string, number> = {}; for (const l of all) { const k = pick(l); if (k) out[k] = (out[k] ?? 0) + 1; } return out; };
  const hold_queue: HoldQueueRow[] = holds.map((h) => ({ ...h, homeowner: owners.get(h.loan_id) ?? nobody, status: all.find((l) => l.loan_id === h.loan_id)?.status ?? "monitored", resolutions: RESOLUTIONS }));
  return { filter: { partner, status, hold: filter.hold ?? null, verdict, ready: filter.ready ?? null }, loans, hold_queue,
    counts: { loans: all.length, on_hold: holds.length, by_status: by((l) => l.status), by_verdict: by((l) => l.latest_review?.verdict ?? null), ready: all.filter((l) => l.latest_readiness?.ready === true).length, not_ready: all.filter((l) => l.latest_readiness !== null && !l.latest_readiness.ready).length, unchecked: all.filter((l) => l.latest_readiness === null).length } };
}
