/**
 * §34.3 rule 5 — "The day across the book." Reviews and readiness for an as-of date: counts by verdict and by missing item,
 * the lists, and the run receipts (`partner_book.review.run_completed`, `partner_book.readiness.run_completed`) with their
 * timestamps against the 07:30 ET expectations (Key deadlines: the review by 07:30 ET and readiness by 07:30 ET). A missing
 * receipt is shown as missing (edge cases: the review ran but readiness did not) beside the `ops_analyst` escalation the
 * sweep hook opens at 07:45 ET (src/runtime/book-ops/routes.ts sweepDailyReports). Rule 7: every number is a count of rows
 * or a receipt's own figure.
 */
import { plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import type { Runtime } from "../app.ts";
import { type Homeowner, type Row, RECEIPT_EXPECTED_ET, atEt, homeownersOf, isDate, isUuid, str } from "./common.ts";

export type Receipt = { present: boolean; at: string | null; expected_by: string; late: boolean | null; run_id: string | null; program_id: string | null; partner_id: string | null; payload: Row | null };
export type DayReviewLine = { loan_id: string; servicer_loan_number: string; homeowner: Homeowner; verdict: string; reasons: string[]; opportunity_id: string | null; analyst: "turn" | "skipped" | "none"; analyst_skipped: string | null; on_hold: boolean };
export type DayReadinessLine = { readiness_check_id: string; loan_id: string; servicer_loan_number: string; application_id: string | null; ready: boolean; missing: string[]; items: Row[] };
export type BookDay = {
  as_of_date: string; partner_party_id: string | null;
  reviews: { count: number; by_verdict: Record<string, number>; on_hold: number; analyst_turns: number; analyst_skipped_by_reason: Record<string, number>; lines: DayReviewLine[] };
  readiness: { checked: number; ready: number; not_ready: number; by_missing_item: Record<string, number>; lines: DayReadinessLine[] };
  receipts: { review: Receipt[]; readiness: Receipt };
  escalations: { id: string; kind: string; owner_role: string | null; status: string; opened_at: string; payload: Row }[];
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(obj) : []);

/** The day's receipts of one type — the review's per program (payload.partner_id names the partner), readiness's one global. */
async function receiptsOf(rt: Runtime, type: string, asOf: PlainDate, partner: string | null): Promise<Receipt[]> {
  const expected = atEt(asOf, RECEIPT_EXPECTED_ET);
  const evs = await rt.db.query<{ occurred_at: string; payload: Row }>(`SELECT occurred_at::text AS occurred_at, payload FROM loan_events WHERE type = $1 AND payload->>'as_of_date' = $2 AND ($3::text IS NULL OR payload->>'partner_id' = $3::text OR payload->>'partner_id' IS NULL) ORDER BY sequence`, [type, asOf, partner]);
  return evs.map((e) => { const at = str(e.payload["at"]) ?? new Date(e.occurred_at).toISOString(); return { present: true, at, expected_by: expected, late: at > expected, run_id: str(e.payload["run_id"]), program_id: str(e.payload["program_id"]), partner_id: str(e.payload["partner_id"]), payload: e.payload }; });
}
const absent = (asOf: PlainDate): Receipt => ({ present: false, at: null, expected_by: atEt(asOf, RECEIPT_EXPECTED_ET), late: null, run_id: null, program_id: null, partner_id: null, payload: null });

/** GET …/reviews?as_of=&partner= and GET …/readiness?as_of=&partner= (the same day view). */
export async function bookDay(rt: Runtime, i: { readonly partner?: string | null; readonly as_of: string }): Promise<BookDay> {
  if (!isDate(i.as_of)) throw new RangeError("as_of is a date (YYYY-MM-DD)");
  const asOf = plainDate(i.as_of); const partner = isUuid(i.partner) ? i.partner : null;
  const db = rt.db;
  const [reviews, checks, reviewReceipts, readinessReceipts, escalations] = await Promise.all([
    db.query<{ loan_id: string; servicer_loan_number: string; verdict: string; reasons: unknown; opportunity_id: string | null; analyst: Row }>(
      `SELECT r.loan_id::text AS loan_id, l.servicer_loan_number, r.verdict, r.reasons, r.opportunity_id, r.analyst FROM partner_book_reviews r JOIN loans l ON l.id = r.loan_id WHERE r.as_of_date = $1 AND ($2::uuid IS NULL OR l.partner_party_id = $2::uuid) ORDER BY l.servicer_loan_number, r.created_at`, [asOf, partner]),
    db.query<{ id: string; loan_id: string; servicer_loan_number: string; application_id: string | null; ready: boolean; missing: unknown; items: unknown }>(
      `SELECT k.id::text AS id, k.loan_id::text AS loan_id, l.servicer_loan_number, k.application_id::text AS application_id, k.ready, k.missing, k.items FROM readiness_checks k JOIN loans l ON l.id = k.loan_id WHERE k.as_of_date = $1 AND ($2::uuid IS NULL OR l.partner_party_id = $2::uuid) ORDER BY l.servicer_loan_number, k.created_at`, [asOf, partner]),
    receiptsOf(rt, "partner_book.review.run_completed", asOf, partner),
    receiptsOf(rt, "partner_book.readiness.run_completed", asOf, null),
    db.query<{ id: string; kind: string; owner_role: string | null; status: string; opened_at: string; payload: Row }>(`SELECT id::text AS id, kind, owner_role, status, opened_at::text AS opened_at, payload FROM escalations WHERE payload->>'kind' = 'partner_book_day_receipt_missing' AND payload->>'as_of_date' = $1 AND ($2::text IS NULL OR payload->>'partner_id' = $2::text) ORDER BY opened_at`, [asOf, partner]),
  ]);
  const owners = await homeownersOf(db, reviews.map((r) => r.loan_id));
  const nobody: Homeowner = { party_id: null, legal_name: null, email_masked: null, phone_masked: null };
  const byVerdict: Record<string, number> = { candidate: 0, watching: 0, not_now: 0, excluded: 0 }; const skippedBy: Record<string, number> = {}; let turns = 0; let onHold = 0;
  const lines: DayReviewLine[] = reviews.map((r) => {
    const reasons = strings(r.reasons); const a = obj(r.analyst); const skipped = str(a["skipped"]);
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1; if (skipped) skippedBy[skipped] = (skippedBy[skipped] ?? 0) + 1; if (str(a["turn_id"])) turns += 1; const held = reasons.includes("not_on_latest_tape"); if (held) onHold += 1;
    return { loan_id: r.loan_id, servicer_loan_number: r.servicer_loan_number, homeowner: owners.get(r.loan_id) ?? nobody, verdict: r.verdict, reasons, opportunity_id: r.opportunity_id, analyst: skipped ? "skipped" : str(a["turn_id"]) ? "turn" : "none", analyst_skipped: skipped, on_hold: held };
  });
  const byMissing: Record<string, number> = {};
  const rlines: DayReadinessLine[] = checks.map((k) => { const missing = strings(k.missing); for (const m of missing) byMissing[m] = (byMissing[m] ?? 0) + 1; return { readiness_check_id: k.id, loan_id: k.loan_id, servicer_loan_number: k.servicer_loan_number, application_id: k.application_id, ready: k.ready === true, missing, items: rows(k.items) }; });
  const readyCount = rlines.filter((x) => x.ready).length;
  return { as_of_date: asOf, partner_party_id: partner,
    reviews: { count: lines.length, by_verdict: byVerdict, on_hold: onHold, analyst_turns: turns, analyst_skipped_by_reason: skippedBy, lines },
    readiness: { checked: rlines.length, ready: readyCount, not_ready: rlines.length - readyCount, by_missing_item: byMissing, lines: rlines },
    receipts: { review: reviewReceipts.length ? reviewReceipts : [absent(asOf)], readiness: readinessReceipts[0] ?? absent(asOf) },
    escalations };
}
