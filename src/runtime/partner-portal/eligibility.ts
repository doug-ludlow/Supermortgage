/**
 * 36.3 — the eligibility board (spec/sections/36-servicing-partner-portal/36-3-eligibility-board-three-buckets.md), read
 * by ./routes.ts on `GET /v1/partner/eligibility`. A projection and nothing more: 34.3's `book.loans` with the tenant filter
 * (never null — 36.1 rule 4), the partner-grade mask (36.1; ./mask.ts), the pure bucket mapping (rule 1;
 * src/domain/servicing-partner-portal/buckets.ts) over each row's `on_hold`, `latest_review` and the review's
 * `facts.watch_rate_pct`, the narrowing keys (rule 3), the counts over the whole tenant book (rule 4) and, beside each row,
 * 36.4's `pipeline_stage` and 36.5's `banner` — computed on every read, stored nowhere. Nothing is written but 36.1's log row.
 *
 *   partnerLoanRows     rule 5: PartnerLoanRow[] — 34.3's BookLoanRow with the servicer loan number reduced to its last four,
 *                       the homeowner's first name and last initial, e-mail / phone / city dropped, and `bucket`, `watch_rate_pct`,
 *                       `reasons_in_words`, `pipeline_stage`, `banner`, `refinanced_by_loan_id` added. Never a FICO, DTI, ZIP,
 *                       street, investor column, e-mail, phone, SSN or DOB (34.3's row carries none; the mask drops the rest).
 *   partnerEligibility  the answer: { as_of_date, counts, loans } — the board is the monitored book (rule 4); Holds is a place, not a bucket.
 */
import { REVIEW_PENDING, REVIEW_PENDING_WORDS, bannerOf, bucketOf, countsOf, eligibilityQueryOf, type BoardBucket, type BucketCounts, type EligibilityQuery } from "../../domain/servicing-partner-portal/buckets.ts";
import { lastFour } from "../../domain/partner-book/import.ts";
import { reasonsInWords } from "../partner-book-review.ts";
import { bookLoans, type BookLoanRow, type BookLoansFilter } from "../book-ops/loans.ts";
import type { Runtime } from "../app.ts";
import { firstNameLastInitial } from "./mask.ts";
import { motionsOf, type LoanMotion } from "./motions.ts";
import { tenantFilter, type TenantScope } from "./scope.ts";

/** Rule 5: 34.3's row, masked partner-grade, with the board's fields beside it. */
export type PartnerLoanRow = Omit<BookLoanRow, "servicer_loan_number" | "homeowner" | "city"> & {
  /** the servicer loan number's last four — the list mask (the full number only on a detail for partner_admin / partner_ops) */
  servicer_loan_last4: string;
  homeowner: { party_id: string | null; legal_name: string | null };
  /** rule 1: one of the three lists; null on a held row (Holds) */
  bucket: BoardBucket | null;
  /** rule 1: the review's `facts.watch_rate_pct` on a Likely soon row; null otherwise */
  watch_rate_pct: string | null;
  /** rule 6: the engine's reason codes (the latest review's; `review_pending` before the first review) */
  reasons: string[];
  /** rule 6: 33.2's words for each code — never free text, never a figure */
  reasons_in_words: string[];
  /** 36.4: the member's current stage when it is on the feed, else null */
  pipeline_stage: string | null;
  /** 36.5 rule 4: one of three sentences, null for a retired row (DELTA-03) */
  banner: string | null;
  /** 35.10 rule 7: the new loan that paid this one off, when set */
  refinanced_by_loan_id: string | null;
};

/** The review's `facts.watch_rate_pct` on the latest review row per loan (33.2 rule 3 writes it for `watching`). */
async function watchRatesOf(rt: Runtime, loanIds: readonly string[]): Promise<Map<string, string | null>> {
  if (!loanIds.length) return new Map();
  const rows = await rt.db.query<{ loan_id: string; watch_rate_pct: string | null }>(
    `SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, facts->>'watch_rate_pct' AS watch_rate_pct FROM partner_book_reviews WHERE loan_id = ANY($1::uuid[]) ORDER BY loan_id, as_of_date DESC, created_at DESC`, [loanIds]);
  return new Map(rows.map((r) => [r.loan_id, r.watch_rate_pct]));
}
/** The link columns 34.3's row leaves out: 35.10's `refinanced_by_loan_id` and 30.2's `origination_application_id`. */
async function linksOf(rt: Runtime, loanIds: readonly string[]): Promise<Map<string, { refinanced_by_loan_id: string | null; origination_application_id: string | null }>> {
  if (!loanIds.length) return new Map();
  const rows = await rt.db.query<{ loan_id: string; refinanced_by_loan_id: string | null; origination_application_id: string | null }>(`SELECT id::text AS loan_id, refinanced_by_loan_id::text AS refinanced_by_loan_id, origination_application_id::text AS origination_application_id FROM loans WHERE id = ANY($1::uuid[])`, [loanIds]);
  return new Map(rows.map((r) => [r.loan_id, { refinanced_by_loan_id: r.refinanced_by_loan_id, origination_application_id: r.origination_application_id }]));
}
/** Rule 6: each code through 33.2's words; this board's own `review_pending` through its one sentence. */
export const reasonWordsOf = (reasons: readonly string[]): string[] => reasons.map((r) => (r === REVIEW_PENDING ? REVIEW_PENDING_WORDS : reasonsInWords([r])[0]!));

/** Rule 5: the tenant's rows (34.3's `book.loans` with `filter.partner` = the tenant, never null) projected partner-grade. `filter.status` narrows to the monitored book for the board. */
export async function partnerLoanRows(rt: Runtime, scope: TenantScope, filter: Omit<BookLoansFilter, "partner"> = {}, now: string = rt.clock.now()): Promise<{ rows: PartnerLoanRow[]; motions: Map<string, LoanMotion> }> {
  const book = await bookLoans(rt, tenantFilter(scope, filter), now);
  const mine = book.loans.filter((l) => l.partner_party_id === scope.partner_party_id);   // 36.1 rule 4, belt and braces over 34.3's own filter
  const ids = mine.map((l) => l.loan_id);
  const [watch, links, motions] = await Promise.all([watchRatesOf(rt, ids), linksOf(rt, ids), motionsOf(rt, ids)]);
  const rows = mine.map((l): PartnerLoanRow => {
    const { servicer_loan_number, homeowner, city: _city, ...rest } = l;
    const b = bucketOf({ on_hold: l.on_hold, latest_review: l.latest_review, watch_rate_pct: watch.get(l.loan_id) ?? null });
    const motion = motions.get(l.loan_id); const link = links.get(l.loan_id);
    return { ...rest, servicer_loan_last4: lastFour(servicer_loan_number), homeowner: { party_id: homeowner.party_id, legal_name: firstNameLastInitial(homeowner.legal_name) },
      bucket: b.bucket, watch_rate_pct: b.watch_rate_pct, reasons: [...b.reasons], reasons_in_words: reasonWordsOf(b.reasons), pipeline_stage: motion?.projection.current?.stage ?? null,
      banner: bannerOf({ status: l.status, partner_legal_name: l.partner_legal_name, open_application: (motion?.open_application_id ?? null) !== null, origination_application_id: link?.origination_application_id ?? null }),
      refinanced_by_loan_id: link?.refinanced_by_loan_id ?? null };
  });
  return { rows, motions };
}

export interface PartnerEligibility { readonly partner_party_id: string; readonly as_of_date: string | null; readonly counts: BucketCounts; readonly query: { bucket: BoardBucket | null; state: string | null; on_hold: boolean | null; applied: readonly string[] }; readonly loans: PartnerLoanRow[] }
/** GET /v1/partner/eligibility (Inputs and triggers): the monitored book bucketed (rule 1), the counts over the whole tenant book (rule 4), the list narrowed by rule 3's keys and nothing else. */
export async function partnerEligibility(rt: Runtime, scope: TenantScope, query: EligibilityQuery, now: string = rt.clock.now()): Promise<PartnerEligibility> {
  const { rows } = await partnerLoanRows(rt, scope, { status: "monitored" }, now);   // rule 4: the board is the monitored book; paid_off / transferred_out / active rows are neither counted nor listed
  const counts = countsOf(rows.map((r) => ({ place: r.on_hold ? "holds" as const : r.bucket ?? "not_near" })));
  const asOf = rows.reduce<string | null>((m, r) => (r.latest_review && (m === null || r.latest_review.as_of_date > m) ? r.latest_review.as_of_date : m), null);
  const onHold = query.on_hold === true;
  const loans = rows.filter((r) => (onHold ? r.on_hold : !r.on_hold) && (query.bucket === null || onHold || r.bucket === query.bucket) && (query.state === null || r.state === query.state));
  return { partner_party_id: scope.partner_party_id, as_of_date: asOf, counts, query: { bucket: query.bucket, state: query.state, on_hold: query.on_hold, applied: query.applied }, loans };
}
/** The query keys off a URL's search params (rule 3), for the route. */
export const eligibilityQueryFromUrl = (url: URL): EligibilityQuery => eligibilityQueryOf([...url.searchParams.entries()].filter(([k]) => k !== "role"));
