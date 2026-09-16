/**
 * 36.3 rule 1 — "The bucket is the verdict." The pure projection of 33.2's stored verdict and 33.1's hold into the
 * eligibility board's three buckets (spec/sections/36-servicing-partner-portal/36-3-eligibility-board-three-buckets.md),
 * plus the two page values 36.5 rule 5 hands the loan page and the banner sentence of 36.5 rule 4. No I/O, no date
 * arithmetic, no figure: everything here is a function of the row the runtime already read (34.3's BookLoanRow with the
 * review's `facts.watch_rate_pct`), and nothing is stored (no `bucket` column on `loans`; brief §4.6 and §10).
 *
 *   bucketOf         rule 1's precedence: on_hold → Holds (none of the three); no review → not_near{review_pending};
 *                    candidate → eligible_now; watching → likely_soon (+ watch_rate_pct); not_now | excluded → not_near
 *                    with the engine's reasons[] as codes. A candidate in motion (an offer offered / engaged, an open
 *                    application) stays eligible_now — 36.4 sets `pipeline_stage` beside it; nothing here re-selects.
 *   eligibilityQueryOf  rule 3: `bucket`, `state` (two letters, upper-cased), `on_hold` (true|false); every other key and
 *                    every value outside those sets is dropped unread — never applied, never an error.
 *   countsOf         rule 4: the three buckets over the monitored loans not on hold, plus the held ones.
 *   bannerOf         36.5 rule 4: exactly one of the three sentences, or null for a paid_off / transferred_out row (DELTA-03).
 *   pageBucketOf     36.5 rule 5: `serviced` for an active row, `in_refinance` for a monitored row with an open refinance
 *                    application, else rule 1's value; null for a paid_off / transferred_out row.
 */

export type BoardBucket = "eligible_now" | "likely_soon" | "not_near";
export const BOARD_BUCKETS: readonly BoardBucket[] = ["eligible_now", "likely_soon", "not_near"];
export const isBoardBucket = (v: unknown): v is BoardBucket => typeof v === "string" && (BOARD_BUCKETS as readonly string[]).includes(v);
/** Where a row sits: one of the three lists, or Holds (Book > Holds, 36.2) — never a fourth bucket (Open question 4). */
export type BoardPlace = BoardBucket | "holds";
/** The page's values (36.5 rule 5) beside the board's three. */
export type PageBucket = BoardBucket | "in_refinance" | "serviced";
/** The three labels the page shows (Outputs and artifacts). */
export const BUCKET_LABELS: Readonly<Record<BoardBucket, string>> = { eligible_now: "Eligible now", likely_soon: "Likely soon", not_near: "Not near" };

/** Rule 6: this board's one reason of its own, for a loan with no review row yet, and its words. */
export const REVIEW_PENDING = "review_pending";
export const REVIEW_PENDING_WORDS = "the first review has not run";

/** What the projection reads of a row: 34.3's `on_hold` and `latest_review`, and the review's `facts.watch_rate_pct` (33.2 rule 3). */
export interface BucketRowInput {
  readonly on_hold: boolean;
  readonly latest_review: { readonly as_of_date: string; readonly verdict: string; readonly reasons: readonly string[] } | null;
  /** the latest review's `facts.watch_rate_pct` — set by 33.2 for `watching` only */
  readonly watch_rate_pct?: string | null;
}
export interface BucketResult {
  /** one of the three, or null when the row is on Holds */
  readonly bucket: BoardBucket | null;
  readonly place: BoardPlace;
  /** the engine's reason codes carried across unchanged (rule 6), or [review_pending] before the first review */
  readonly reasons: readonly string[];
  /** rule 1: the watch rate on a Likely soon row only */
  readonly watch_rate_pct: string | null;
  /** the latest review's date, null before the first review */
  readonly review_as_of: string | null;
}

/** The verdict's bucket (33.2's four verdicts → the three lists). An unknown verdict string reads Not near: never a fourth place. */
export function bucketForVerdict(verdict: string): BoardBucket {
  return verdict === "candidate" ? "eligible_now" : verdict === "watching" ? "likely_soon" : "not_near";
}

/** Rule 1, in its order of precedence. Pure. */
export function bucketOf(row: BucketRowInput): BucketResult {
  const review = row.latest_review;
  if (row.on_hold) return { bucket: null, place: "holds", reasons: review ? [...review.reasons] : [REVIEW_PENDING], watch_rate_pct: null, review_as_of: review?.as_of_date ?? null };
  if (!review) return { bucket: "not_near", place: "not_near", reasons: [REVIEW_PENDING], watch_rate_pct: null, review_as_of: null };
  const bucket = bucketForVerdict(review.verdict);
  const watch = bucket === "likely_soon" && typeof row.watch_rate_pct === "string" && row.watch_rate_pct !== "" ? row.watch_rate_pct : null;
  return { bucket, place: bucket, reasons: [...review.reasons], watch_rate_pct: watch, review_as_of: review.as_of_date };
}

// ---------------------------------------------------------------- rule 3: the query keys
export const ELIGIBILITY_QUERY_KEYS = ["bucket", "state", "on_hold"] as const;
export interface EligibilityQuery {
  readonly bucket: BoardBucket | null;
  /** the property state, two letters upper-cased */
  readonly state: string | null;
  readonly on_hold: boolean | null;
  /** the keys applied, for the log line (names only, never a value) */
  readonly applied: readonly string[];
  /** the keys dropped unread — unknown keys and known keys with a value outside the set */
  readonly dropped: readonly string[];
}
/** Rule 3: three keys narrow; everything else (`fico`, `dti`, `zip`, `name`, `age`, `investor`, `score`, `ready`, …) is dropped unread. Pure over the query's pairs. */
export function eligibilityQueryOf(pairs: Iterable<readonly [string, string]>): EligibilityQuery {
  let bucket: BoardBucket | null = null; let state: string | null = null; let on_hold: boolean | null = null;
  const applied: string[] = []; const dropped: string[] = [];
  for (const [rawKey, rawValue] of pairs) {
    const key = rawKey.trim(); const value = rawValue.trim();
    if (key === "bucket" && isBoardBucket(value)) { bucket = value; applied.push(key); continue; }
    if (key === "state" && /^[A-Za-z]{2}$/.test(value)) { state = value.toUpperCase(); applied.push(key); continue; }
    if (key === "on_hold" && (value === "true" || value === "false")) { on_hold = value === "true"; applied.push(key); continue; }
    dropped.push(key);
  }
  return { bucket, state, on_hold, applied: [...new Set(applied)], dropped: [...new Set(dropped)] };
}

// ---------------------------------------------------------------- rule 4: the counts
export interface BucketCounts { readonly eligible_now: number; readonly likely_soon: number; readonly not_near: number; readonly on_hold: number }
/** Rule 4: `eligible_now + likely_soon + not_near` = the monitored loans not on hold; `+ on_hold` = every monitored loan of the tenant. Over the whole book, whatever the query. */
export function countsOf(places: Iterable<Pick<BucketResult, "place">>): BucketCounts {
  const c = { eligible_now: 0, likely_soon: 0, not_near: 0, on_hold: 0 };
  for (const p of places) { if (p.place === "holds") c.on_hold += 1; else c[p.place] += 1; }
  return c;
}

// ---------------------------------------------------------------- 36.5 rules 4 and 5: the banner and the page's bucket
export const BANNER_IN_REFINANCE = "In refinance — origination in progress";
export const BANNER_ACTIVE = "Active — Supermortgage subservicing";
export const bannerMonitored = (partnerLegalName: string): string => `Monitored — ${partnerLegalName} remains servicer`;
export interface BannerRowInput {
  /** `loans.status`: monitored | paid_off | transferred_out | active */
  readonly status: string;
  /** the tenant's `parties.legal_name` — never a Supermortgage name */
  readonly partner_legal_name: string;
  /** a refinance application with `prior_loan_id` = the loan whose disposition is not terminal (33.3 `refi.open` until 21.6 / 30.2) */
  readonly open_application: boolean;
  /** `loans.origination_application_id`: set on the loan 30.2 boarded from the refinance application */
  readonly origination_application_id: string | null;
}
/** 36.5 rule 4: exactly one of three sentences, computed from `loans.status`, the application's state and the link; null for a retired row (DELTA-03 — never a sentence minted here). */
export function bannerOf(row: BannerRowInput): string | null {
  if (row.status === "monitored") return row.open_application ? BANNER_IN_REFINANCE : bannerMonitored(row.partner_legal_name);
  if (row.status === "active" && row.origination_application_id) return BANNER_ACTIVE;
  return null;
}
/** 36.5 rule 5: the row's state on the page — `serviced` (active), `in_refinance` (monitored with an open application), else rule 1's value (a held loan reads its verdict's bucket here, with `on_hold` beside it); null for a retired row. */
export function pageBucketOf(row: BucketRowInput & Pick<BannerRowInput, "status" | "open_application">): PageBucket | null {
  if (row.status === "active") return "serviced";
  if (row.status !== "monitored") return null;
  if (row.open_application) return "in_refinance";
  const r = bucketOf({ ...row, on_hold: false });
  return r.bucket;
}
