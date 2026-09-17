/**
 * 36.5 — Home, the daily report and the two-mode loan page (spec/sections/36-servicing-partner-portal/
 * 36-5-partner-home-reports-two-mode-loan-page.md), read by ./routes.ts on `GET /v1/partner/home`, `GET /v1/partner/reports/daily[/export]`
 * and `GET /v1/partner/loans/{id}`. A projection and nothing more: 33.1's status line, 34.3's `book.loans` counts, 36.3's board
 * counts and 36.4's feed for Home (rule 1); 34.3's `partner_book_daily_reports` row read for the tenant (rules 2–3); 34.3's `book.loan`
 * masked partner-grade with the banner, the page's bucket and the stage computed on every read (rules 4–8; src/domain/
 * servicing-partner-portal/buckets.ts); 36.6's one code in the `serviced` field (src/domain/servicing-partner-portal/serviced.ts).
 * Nothing is stored, nothing is computed about a loan, no model turn runs, and nothing is written but 36.1's log row.
 *
 *   partnerHome              rule 1: `{ as_of_date, partner, book, eligibility, pipeline, latest_report_id }` — every number a count of the
 *                            tenant's rows or a stored field; before the first import every count is 0, the dates null and the page says
 *                            "Upload a tape to open the book."
 *   partnerDailyReports      rule 2: the tenant's report rows newest first (34.3's listDailyReports with the tenant, never null)
 *   partnerDailyReport       rule 2: the newest row for the tenant and the day, or 404 NOT_FOUND (a day the sweep has not reached, another
 *                            tenant's day — the same answer)
 *   partnerDailyReportExport rule 3: the stored row as a file — its JSON (34.3's document text) and a CSV of its counts; a read, no
 *                            `documents` row, no newer report row (34.3's hashed export stays `compliance`'s on /ops)
 *   partnerLoanDetail        rules 4–10: PartnerLoanDetail — banner, bucket, pipeline_stage, the row (36.3 rule 5's, the full servicer loan
 *                            number for partner_admin / partner_ops), facts_history as names of what changed (never a raw fact), reviews with
 *                            the analyst's rationale as stored (tokens) and rendered from that row's own facts as /ops renders it, readiness,
 *                            offers, the links to the new or the prior loan, the hold, `serviced` and the disabled Serviced tab.
 */
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { lastFour } from "../../domain/partner-book/import.ts";
import { bannerOf, pageBucketOf, type PageBucket } from "../../domain/servicing-partner-portal/buckets.ts";
import { ET, isInFlightStage } from "../../domain/servicing-partner-portal/pipeline.ts";
import { SERVICED_TAB, servicedFieldOf, type ServicedRefusal, type ServicedTab } from "../../domain/servicing-partner-portal/serviced.ts";
import { reviewTokenValues, type ReviewFacts, type ReviewVerdict } from "../partner-book-review.ts";
import { bookLoans } from "../book-ops/loans.ts";
import { diffFacts } from "../book-ops/history.ts";
import { type Row, homeownersOf, isDate } from "../book-ops/common.ts";
import { latestDailyReport, listDailyReports, renderDailyReport, type DailyReportRow } from "../book-ops/report.ts";
import type { Runtime } from "../app.ts";
import { BOOK_COPY, partnerStatus } from "./book.ts";
import { partnerEligibility, partnerLoanRows, reasonWordsOf, type PartnerLoanRow } from "./eligibility.ts";
import { eligibilityQueryOf, type BucketCounts } from "../../domain/servicing-partner-portal/buckets.ts";
import { firstNameLastInitial } from "./mask.ts";
import { partnerPipeline } from "./pipeline.ts";
import { notFound, tenantFilter, tenantLoan, tenantLoanRow, type TenantScope } from "./scope.ts";

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// ---------------------------------------------------------------- the tenant on the page (GLBA §1016.13: the partner's legal name and NMLSR id, never a Supermortgage name)
export interface PartnerIdentity { readonly partner_party_id: string; readonly legal_name: string; readonly nmlsr_id: string | null }
/** The tenant's parties{servicer} row (legal name) and its NMLSR id from the `partners/<id>` entity 33.1 keeps, else the row's contact — as /v1/partner/me answers it. */
export async function tenantIdentity(rt: Runtime, scope: TenantScope): Promise<PartnerIdentity> {
  const row = (await rt.db.query<{ legal_name: string; nmlsr_id: string | null }>(`SELECT legal_name, contact->>'nmlsr_id' AS nmlsr_id FROM parties WHERE id = $1 AND party_type = 'servicer'`, [scope.partner_party_id]))[0];
  if (!row) throw notFound("partner");
  const entity = await rt.entities.current("partners", scope.partner_party_id);
  return { partner_party_id: scope.partner_party_id, legal_name: row.legal_name, nmlsr_id: s(entity?.data["nmlsr_id"]) ?? s(row.nmlsr_id) };
}

// ---------------------------------------------------------------- rule 1: Home
export interface PartnerHome {
  readonly partner_party_id: string;
  /** 36.3's board date (the latest review's as-of), carried beside the counts (discrepancy 1; 36.5-T1's "for the same as_of") */
  readonly as_of_date: string | null;
  readonly partner: { legal_name: string; nmlsr_id: string | null };
  /** 33.1's status line and 34.3's counts for the tenant */
  readonly book: { loans_monitored: number; on_hold: number; last_as_of: string | null; next_tape_due: string | null; late: boolean; imports: number };
  /** 36.3's counts for the board's as_of_date — the three buckets (the held count is the book line's `on_hold`) */
  readonly eligibility: Pick<BucketCounts, "eligible_now" | "likely_soon" | "not_near">;
  /** 36.4: the members whose current stage is neither terminal nor `boarded`, and those `boarded` with `entered_at` in the calendar month of the read (America/New_York) */
  readonly pipeline: { in_flight: number; boarded_mtd: number };
  /** the newest partner_book_daily_reports row of the tenant, null before the first */
  readonly latest_report_id: string | null;
  readonly latest_report_as_of: string | null;
  /** before the first import: every count 0, the dates null, and the page's sentence */
  readonly empty: boolean;
  readonly copy: string;
}
/** GET /v1/partner/home (rule 1): counts of the tenant's rows the owners already keep — 36.5-T1: `eligibility` is 36.3's `counts` and `pipeline.in_flight` is 36.4's for the same `as_of_date`. */
export async function partnerHome(rt: Runtime, scope: TenantScope, now: string = rt.clock.now()): Promise<PartnerHome> {
  const [partner, status, book, board, feed, reports] = await Promise.all([
    tenantIdentity(rt, scope),
    partnerStatus(rt, scope, now),                                                              // 33.1's line: last as-of, next expected (SM_PARTNER_BOOK_TAPE_EXPECTED_7), late, holds
    bookLoans(rt, tenantFilter(scope, { status: "monitored" }), now),                            // 34.3's counts for the tenant (filter.partner never null)
    partnerEligibility(rt, scope, eligibilityQueryOf([]), now),                                  // 36.3's counts and its as_of_date — the same function the board answers with
    partnerPipeline(rt, scope, now),                                                             // 36.4's items — the same function the feed answers with
    listDailyReports(rt, scope.partner_party_id, 1),
  ]);
  const month = wallClock(Date.parse(now), ET).date.slice(0, 7);
  const in_flight = feed.items.filter((i) => isInFlightStage(i.stage)).length;
  const boarded_mtd = feed.items.filter((i) => i.stage === "boarded" && wallClock(Date.parse(i.entered_at), ET).date.slice(0, 7) === month).length;
  const newest = reports.find((r) => r.partner_party_id === scope.partner_party_id) ?? null;
  const empty = status.as_of_date === null;
  return {
    partner_party_id: scope.partner_party_id, as_of_date: board.as_of_date, partner: { legal_name: partner.legal_name, nmlsr_id: partner.nmlsr_id },
    book: { loans_monitored: book.loans.filter((l) => l.partner_party_id === scope.partner_party_id && l.status === "monitored").length, on_hold: status.on_hold, last_as_of: status.as_of_date, next_tape_due: status.next_expected, late: status.late, imports: status.imports },
    eligibility: { eligible_now: board.counts.eligible_now, likely_soon: board.counts.likely_soon, not_near: board.counts.not_near }, pipeline: { in_flight, boarded_mtd }, latest_report_id: newest?.id ?? null, latest_report_as_of: newest?.as_of_date ?? null,
    empty, copy: empty ? BOOK_COPY.empty : BOOK_COPY.upload,
  };
}

// ---------------------------------------------------------------- rules 2–3: the daily report, read for one tenant
export interface PartnerDailyReports { readonly partner_party_id: string; readonly reports: DailyReportRow[] }
/** GET /v1/partner/reports/daily (rule 2, no `as_of`): the tenant's rows newest first — 34.3's list with the tenant, never null; no other partner's row is listed. */
export async function partnerDailyReports(rt: Runtime, scope: TenantScope, limit = 200): Promise<PartnerDailyReports> {
  const rows = await listDailyReports(rt, scope.partner_party_id, limit);
  return { partner_party_id: scope.partner_party_id, reports: rows.filter((r) => r.partner_party_id === scope.partner_party_id) };   // 36.1 rule 4, belt and braces over 34.3's own filter
}
/** GET /v1/partner/reports/daily?as_of= (rule 2): the newest row for the tenant and the day, as 34.3's `book.daily_report` answers staff — the same id, counts, extract id and decision id; 404 NOT_FOUND for a day the tenant has no row (never produced here — Open question 3). */
export async function partnerDailyReport(rt: Runtime, scope: TenantScope, asOf: string): Promise<DailyReportRow> {
  if (!isDate(asOf)) throw new RangeError("as_of is a date (YYYY-MM-DD)");
  const r = await latestDailyReport(rt, scope.partner_party_id, asOf);
  if (!r || r.partner_party_id !== scope.partner_party_id) throw notFound("report");
  return r;
}
/** Rule 3 / Open question 2: the counts of the stored row as one CSV line (header + values) — a stored figure or a row count, never a figure made here. */
export function dailyReportCsv(r: DailyReportRow): string {
  const cols: [string, unknown][] = [
    ["report_id", r.id], ["partner_party_id", r.partner_party_id], ["partner_legal_name", r.partner_legal_name ?? ""], ["as_of_date", r.as_of_date], ["produced_by", r.produced_by], ["created_at", r.created_at], ["decision_id", r.decision_id ?? ""], ["fair_lending_extract_id", r.review.fair_lending_extract_id ?? ""],
    ["review_receipt_absent", r.review.absent], ["reviewed", r.review.reviewed], ["candidates", r.review.candidates], ["watching", r.review.watching], ["not_now", r.review.not_now], ["excluded", r.review.excluded], ["offers_delivered", r.review.offers_delivered], ["offers_portal_only", r.review.offers_portal_only], ["expired", r.review.expired], ["analyst_turns", r.review.analyst_turns], ["analyst_skipped", r.review.analyst_skipped],
    ["readiness_receipt_absent", r.readiness.absent], ["readiness_checked", r.readiness.checked], ["ready", r.readiness.ready], ["not_ready", r.readiness.not_ready], ["applications_opened", r.readiness.applications_opened], ["du_runs", r.readiness.du_runs],
    ["loans_monitored", r.book.loans_monitored], ["on_hold", r.book.on_hold], ["paid_off", r.book.paid_off], ["transferred_out", r.book.transferred_out], ["imports", r.book.imports], ["last_as_of_date", r.book.last_as_of_date ?? ""], ["next_expected", r.book.next_expected ?? ""],
  ];
  const cell = (v: unknown): string => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g, "\"\"")}"` : t; };
  return `${cols.map(([k]) => k).join(",")}\n${cols.map(([, v]) => cell(v)).join(",")}\n`;
}
export interface PartnerDailyReportExport { readonly report_id: string; readonly partner_party_id: string; readonly as_of_date: string; readonly format: "json" | "csv"; readonly filename: string; readonly content_type: string; readonly content: string; readonly byte_size: number; readonly report: DailyReportRow }
/** GET /v1/partner/reports/daily/export?as_of=&format= (rule 3): the stored row as a file — its JSON (34.3's own document text, hash for hash what `compliance` exports) or the CSV of its counts. A read: no `documents` row, no newer report row. */
export async function partnerDailyReportExport(rt: Runtime, scope: TenantScope, asOf: string, format: string | null): Promise<PartnerDailyReportExport> {
  const report = await partnerDailyReport(rt, scope, asOf);
  const csv = format === "csv";
  const content = csv ? dailyReportCsv(report) : renderDailyReport(report);
  return { report_id: report.id, partner_party_id: report.partner_party_id, as_of_date: report.as_of_date, format: csv ? "csv" : "json", filename: `daily-report-${report.as_of_date}.${csv ? "csv" : "json"}`, content_type: csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", content, byte_size: Buffer.byteLength(content, "utf8"), report };
}

// ---------------------------------------------------------------- rules 4–10: the two-mode loan page
/** Rule 7: one entry per import that carried the loan, newest first — the as-of date, 33.1 rule 2's word, and for `updated` the NAMES of the facts that differed (34.3 rule 2's list), never a value. */
export interface FactsHistoryEntry { readonly as_of_date: string; readonly import_id: string; readonly change: "created" | "updated" | "unchanged"; readonly changed: string[] }
/** Rule 6: one per 33.2 review row, newest first — the analyst's rationale as stored (tokens) and as the surface renders it from that row's own facts; the engine's text when the turn was skipped. */
export interface PageReview { readonly as_of_date: string; readonly verdict: ReviewVerdict; readonly verdict_words: string; readonly reasons: string[]; readonly reasons_in_words: string[]; readonly watch_rate_pct: string | null; readonly analyst_rationale_tokens: string | null; readonly analyst_rationale: string | null; readonly analyst_skipped: string | null; readonly analyst_flags: string[] }
/** Rule 8: the latest readiness row — the items by name and status, no source id, no document, no ask. */
export interface PageReadiness { readonly as_of_date: string; readonly ready: boolean; readonly missing: string[]; readonly items: { item: string; status: string }[] }
/** Rule 8: 34.3's opportunities with 20.1's word for the status, when the touch went out (null for a portal-only delivery) and when the offer expires — no rate, payment or NPV. */
export interface PageOffer { readonly opportunity_id: string; readonly as_of_date: string | null; readonly status: string | null; readonly delivered_at: string | null; readonly delivered_channels: string[]; readonly expires_at: string | null; readonly expired: boolean }
/** 36.2 rule 9's hold on the page: the dates only (the number is on the row, masked for the role); no resolve control. */
export interface PageHold { readonly last_as_of_date: string; readonly partner_as_of_date: string; readonly held_since: string | null }
export type PageLoanRow = Omit<PartnerLoanRow, "hold" | "homeowner" | "bucket"> & { servicer_loan_number?: string; bucket: PageBucket | null; homeowner: { party_id: string | null; legal_name: string | null; email_masked?: string | null; phone_masked?: string | null }; hold: PageHold | null; origination_application_id: string | null };
export interface PartnerLoanDetail {
  readonly loan_id: string; readonly partner_party_id: string;
  /** rule 4: exactly one of three sentences, or null for a retired row (DELTA-03: `status` and `refinanced_by_loan_id` say "paid off / refinanced") */
  readonly banner: string | null;
  /** rule 5: the row's state on the page */
  readonly bucket: PageBucket | null;
  /** rule 5: the member's 36.4 item's current stage when one exists (terminal and `boarded` included), else null */
  readonly pipeline_stage: string | null;
  readonly loan: PageLoanRow;
  readonly facts_history: FactsHistoryEntry[];
  readonly reviews: PageReview[];
  readonly readiness: PageReadiness | null;
  readonly offers: PageOffer[];
  /** navigation only (rule 9): the new loan's page, the prior loan's page, the refinance application, the feed's detail */
  readonly links: { refinanced_by_loan_id: string | null; prior_loan_id: string | null; refinance_application_id: string | null; pipeline: string | null; board: string; holds: string | null };
  /** rule 8: 36.6's refusal object for a monitored and for an active row in V1, null for a retired row */
  readonly serviced: ServicedRefusal | null;
  /** 36.6 rule 4: visible, disabled, the copy — on every loan page */
  readonly serviced_tab: ServicedTab;
}

const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
/** Rule 7: the import report's own word for the loan's row (`partner_book_imports.report.loans[].change`, 33.1 rule 2), by import id. */
async function changeWordsOf(rt: Runtime, loanId: string, importIds: readonly string[]): Promise<Map<string, FactsHistoryEntry["change"]>> {
  if (!importIds.length) return new Map();
  const rows = await rt.db.query<{ id: string; change: string | null }>(`SELECT i.id::text AS id, (SELECT l->>'change' FROM jsonb_array_elements(coalesce(i.report->'loans', '[]'::jsonb)) l WHERE l->>'loan_id' = $2 LIMIT 1) AS change FROM partner_book_imports i WHERE i.id = ANY($1::uuid[])`, [importIds, loanId]);
  const out = new Map<string, FactsHistoryEntry["change"]>();
  for (const r of rows) if (r.change === "created" || r.change === "updated" || r.change === "unchanged") out.set(r.id, r.change);
  return out;
}
/** Rule 6: the stored rationale with its `{{facts.<key>}}` tokens filled from that review row's own facts (33.2's reviewTokenValues — the surface's resolver); a token the facts lack renders as absent, never as a figure the page made up. */
export function renderRationale(rationale: string | null, facts: Row): string | null {
  if (rationale === null) return null;
  let values: Record<string, string> = {};
  try { values = reviewTokenValues(facts as unknown as ReviewFacts); } catch { values = {}; }
  return rationale.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_all, k: string) => values[k] ?? "").replace(/[ \t]{2,}/g, " ").trim();
}

/** GET /v1/partner/loans/{id} (rules 4–10): the tenant's loan or 404 (36.1 rule 4) — a monitored row (34.3's page masked partner-grade), the retired prior loan (DELTA-03), or the new `active` loan 30.2 boarded from the refinance (never on a tape: no facts, no review, no offer of its own; banner Active, `bucket = serviced`, the link back to the prior loan). */
export async function partnerLoanDetail(rt: Runtime, scope: TenantScope, loanId: string, role: string, now: string = rt.clock.now()): Promise<PartnerLoanDetail> {
  const row = await tenantLoanRow(rt, scope, loanId);   // 404 NOT_FOUND before anything else: another tenant's loan, an unknown or a malformed id
  const full = role !== "partner_auditor";              // rule 10: the servicer loan number in full for partner_admin / partner_ops, its last four for partner_auditor
  const { rows, motions } = await partnerLoanRows(rt, scope, {}, now);
  const listed = rows.find((r) => r.loan_id === loanId) ?? null;
  const motion = motions.get(loanId);
  const openApplication = (motion?.open_application_id ?? null) !== null;
  const priorOf = row.origination_application_id ? (await rt.db.query<{ prior_loan_id: string | null }>(`SELECT prior_loan_id::text AS prior_loan_id FROM applications WHERE id = $1`, [row.origination_application_id]))[0]?.prior_loan_id ?? null : null;
  const banner = bannerOf({ status: row.status, partner_legal_name: listed?.partner_legal_name ?? (await tenantIdentity(rt, scope)).legal_name, open_application: openApplication, origination_application_id: row.origination_application_id });
  const pipeline_stage = motion?.projection.current?.stage ?? null;
  const serviced = servicedFieldOf(row.status);
  const links = (refinanceApplicationId: string | null): PartnerLoanDetail["links"] => ({ refinanced_by_loan_id: row.refinanced_by_loan_id, prior_loan_id: priorOf, refinance_application_id: refinanceApplicationId, pipeline: motion?.projection.current ? `/partners/pipeline/${loanId}` : null, board: "/partners/eligibility", holds: listed?.on_hold ? "/partners/book#holds" : null });

  if (!listed) {
    // the new active loan (or any tenant loan never on a tape): the row from `loans`, `properties` and `loan_borrowers` — no figure of the serviced loan on the page (36.6: the pane is dark)
    const [state, owners] = await Promise.all([
      row.property_id ? rt.db.query<{ state: string | null }>(`SELECT state FROM properties WHERE id = $1`, [row.property_id]) : Promise.resolve([] as { state: string | null }[]),
      homeownersOf(rt.db, [loanId]),
    ]);
    const o = owners.get(loanId) ?? { party_id: null, legal_name: null, email_masked: null, phone_masked: null };
    const partner = await tenantIdentity(rt, scope);
    const loan: PageLoanRow = { loan_id: loanId, partner_party_id: scope.partner_party_id, partner_legal_name: partner.legal_name, status: row.status, state: state[0]?.state ?? null, servicer_loan_last4: lastFour(row.servicer_loan_number), ...(full ? { servicer_loan_number: row.servicer_loan_number } : {}),
      homeowner: { party_id: o.party_id, legal_name: firstNameLastInitial(o.legal_name), ...(full ? { email_masked: o.email_masked, phone_masked: o.phone_masked } : {}) },
      facts_as_of: null, upb_cents: null, note_rate_pct: null, pi_cents: null, ti_cents: null, next_due_date: null, last_payment_date: null, value: null, servicing_status: null, account_activated: false, activated_at: null, latest_review: null, latest_readiness: null, on_hold: false, hold: null,
      bucket: pageBucketOf({ status: row.status, open_application: openApplication, on_hold: false, latest_review: null }), watch_rate_pct: null, reasons: [], reasons_in_words: [], pipeline_stage, banner, refinanced_by_loan_id: row.refinanced_by_loan_id, origination_application_id: row.origination_application_id };
    return { loan_id: loanId, partner_party_id: scope.partner_party_id, banner, bucket: loan.bucket, pipeline_stage, loan, facts_history: [], reviews: [], readiness: null, offers: [], links: links(row.origination_application_id), serviced, serviced_tab: SERVICED_TAB };
  }

  // a loan the tape carried: 34.3's page (the facts by as-of date, the reviews, the readiness rows, the offers) for the tenant's loan
  const l = await tenantLoan(rt, scope, loanId, now);
  const facts = l.facts_by_as_of;   // ascending by as-of date
  const words = await changeWordsOf(rt, loanId, [...new Set(facts.map((f) => f.import_id))]);
  const facts_history: FactsHistoryEntry[] = facts.map((f, i) => {
    const prev = i > 0 ? facts[i - 1]! : null;
    const d = prev ? diffFacts(prev.facts, f.facts) : { diff: [], changed_keys: [] };
    const change = words.get(f.import_id) ?? (prev === null ? "created" : d.changed_keys.length ? "updated" : "unchanged");
    return { as_of_date: f.as_of_date, import_id: f.import_id, change, changed: change === "updated" ? d.diff.map((x) => x.label) : [] };
  }).reverse();
  const reviews: PageReview[] = [...l.reviews].reverse().map((r) => ({
    as_of_date: r.as_of_date, verdict: r.verdict, verdict_words: r.verdict_words, reasons: [...r.reasons], reasons_in_words: reasonWordsOf(r.reasons),
    watch_rate_pct: r.verdict === "watching" && typeof r.facts["watch_rate_pct"] === "string" ? (r.facts["watch_rate_pct"] as string) : null,
    analyst_rationale_tokens: r.analyst.skipped ? r.analyst.explanation_text : r.analyst.rationale,
    analyst_rationale: r.analyst.skipped ? r.analyst.explanation_text : renderRationale(r.analyst.rationale, r.facts),
    analyst_skipped: r.analyst.skipped, analyst_flags: [...r.analyst.flags],
  }));
  const latestReadiness = l.readiness.length ? l.readiness[l.readiness.length - 1]! : null;
  const readiness: PageReadiness | null = latestReadiness ? { as_of_date: latestReadiness.as_of_date, ready: latestReadiness.ready, missing: [...latestReadiness.missing], items: latestReadiness.items.map((it) => ({ item: it.item, status: it.status })) } : null;
  const offers: PageOffer[] = l.offers.map((o) => { const sent = o.delivered.map((d) => d.sent_at).filter((x): x is string => !!x).sort(); return { opportunity_id: o.opportunity_id, as_of_date: o.as_of_date, status: o.status, delivered_at: iso(sent[0] ?? null), delivered_channels: o.delivered.map((d) => d.channel).filter((c): c is string => !!c), expires_at: o.offer_valid_until, expired: o.expired }; });
  const { hold, homeowner, bucket: _board, ...rest } = listed;
  const bucket = pageBucketOf({ status: row.status, open_application: openApplication, on_hold: listed.on_hold, latest_review: listed.latest_review, watch_rate_pct: listed.watch_rate_pct });
  const loan: PageLoanRow = { ...rest, ...(full ? { servicer_loan_number: l.loan.servicer_loan_number } : {}), bucket, pipeline_stage, banner,
    homeowner: { party_id: homeowner.party_id, legal_name: homeowner.legal_name, ...(full ? { email_masked: l.homeowner.email_masked, phone_masked: l.homeowner.phone_masked } : {}) },
    hold: hold ? { last_as_of_date: hold.last_as_of_date, partner_as_of_date: hold.partner_as_of_date, held_since: hold.not_on_tape_since } : null, origination_application_id: row.origination_application_id };
  const refinanceApplicationId = motion?.open_application_id ?? motion?.projection.current?.application_id ?? null;
  return { loan_id: loanId, partner_party_id: scope.partner_party_id, banner, bucket, pipeline_stage, loan, facts_history, reviews, readiness, offers, links: links(refinanceApplicationId), serviced, serviced_tab: SERVICED_TAB };
}
