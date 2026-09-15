/**
 * 34.5 `directory.list` — the accounts list (rules 4, 5, 7, 8, 9): a browse over every borrower party from every door, newest
 * first by creation, one page of 50 with a `next` cursor, masked exactly as 34.2's search is (mask.ts) and logged exactly as it
 * is (`directory.listed{staff_user_id, filters_hash, results}` — the filters as a sha-256 of their canonical form, never a text).
 *
 *   one row per `parties{borrower}`; an un-identified video party (contact.provisional = video with no e-mail — 32.17: "nothing of
 *   it is shown to anyone else") is never a row and its placeholder application is no subject of any row
 *   origin       partner_book (a borrowers row on a partner's loan) · video_door (the first session came through the video door) ·
 *                front_door — the same derivation as search.ts `originsOf`, written into the query so it can be filtered and paged;
 *                `origins` names both doors when a partner-book party also used the front door (34.2's edge case)
 *   doors        the distinct `sessions.auth_method`s, labelled through account.ts DOOR_LABELS
 *   status       invited (provisioned, never signed in) · active (any session)
 *   verified     the e-mail's verified instant: party_credentials.email_verified_at, else a verified Google identity's first sign-in,
 *                else the first one-time code to the e-mail (possession proven) — or null (unverified)
 *   stage        monitored (a partner-book loan; `activated` once the homeowner signed in) > boarded (a served loan) > funded
 *                (`loan.funded`) > closing (`clear_to_close.issued`) > decision (`decision.issued`) > application (an application
 *                row — `application.trid_received` still reads `application`, as the `journey_progress` view reads it) > lead (a live
 *                20.3 lead names the party and no application exists) > account
 *   subjects     application ids and loan numbers, last four only (search.ts `subjectsOf` — the search's shape)
 *   partner      the lender or servicer of record: the application's, else the loan's, else the configured entry partner
 *                (src/runtime/borrower/partner.ts entryPartner — what the borrower thread names; never Supermortgage)
 *   name         the legal name when one was captured; an account whose legal_name is still its e-mail address (DELTA-29) or the
 *                video door's placeholder shows `legal_name: null, name_state: not_captured` — the list never carries an address in clear
 *
 * Filters (rule 5): origin, door, status, verified, stage, partner, created_since, created_until, last_seen_since, has_application,
 * has_loan, signed_in_today; sort newest | last_seen | name; a keyset cursor (the sort key and the id) so a party created while
 * paging cannot appear twice. More than 50 matches is a page, never NARROW_QUERY (that refusal is the search's). The "Not yet an
 * account" tab (rule 9, T4) is increment 2: `tab=not_yet_an_account` answers 501 NOT_BUILT until it lands.
 *
 * LIST_VOLUME (rule 8): the logged wrapper counts the day's pages and rows by this person across `directory.list`, `pipeline.list`
 * and `loans.list` (their look events); past 20 pages or 1,000 rows in a day (America/New_York) it opens one `compliance` escalation
 * naming the person, the counts and the day — one per person per day, on the pattern of 34.2's 20-unmasks rule. The list keeps
 * answering: the control is the escalation, not a lock-out.
 */
import { createHash } from "node:crypto";
import type { Db, Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { wallClock } from "../../kernel/calendar/zoned.ts";
import { EscalationService } from "../../app/escalations.ts";
import type { Runtime } from "../app.ts";
import { entryPartner } from "../borrower/partner.ts";
import { DOOR_LABELS } from "./account.ts";
import { maskEmail, maskPhone, stripSecrets } from "./mask.ts";
import { unidentifiedVideoPartySql } from "./scope.ts";
import { subjectsOf, type DirectorySearchHit } from "./search.ts";
import { DirectoryRefused } from "./unmask.ts";

/** The list's route (34.2's DIRECTORY_PATH + `/list`; stated here so routes.ts can hash its query without a module cycle). */
export const LIST_PATH = "/ops/api/directory/list";
export const LIST_PATH_RE = /^\/ops\/api\/directory\/list\/?$/;
export const LIST_PAGE_SIZE = 50;
export const LIST_VOLUME_PAGES_PER_DAY = 20;
export const LIST_VOLUME_ROWS_PER_DAY = 1000;
/** The look events LIST_VOLUME counts (rule 8): the three lists' pages; `directory.counted` never counts. */
export const LIST_VOLUME_EVENTS: readonly string[] = ["directory.listed", "pipeline.listed", "loans.listed"];
export const LIST_VOLUME_REASON = "directory.list.volume";
const ET = "America/New_York";

export const LIST_ORIGINS = ["front_door", "video_door", "partner_book"] as const;
export const LIST_STATUSES = ["invited", "active"] as const;
export const LIST_STAGES = ["lead", "account", "application", "decision", "closing", "funded", "boarded", "monitored"] as const;
export const LIST_SORTS = ["newest", "last_seen", "name"] as const;
export const LIST_TABS = ["accounts", "not_yet_an_account"] as const;
export const LIST_DOORS: readonly string[] = Object.keys(DOOR_LABELS);
export type ListOrigin = (typeof LIST_ORIGINS)[number];
export type ListStage = (typeof LIST_STAGES)[number];
export type ListSort = (typeof LIST_SORTS)[number];
export type ListTab = (typeof LIST_TABS)[number];

/** The filter keys the canonical form (and so the hash) knows, in their canonical order; anything else in a query is ignored. */
export const LIST_FILTER_KEYS = ["tab", "origin", "door", "status", "verified", "stage", "partner", "created_since", "created_until", "last_seen_since", "has_application", "has_loan", "signed_in_today", "sort"] as const;
export type ListFilterKey = (typeof LIST_FILTER_KEYS)[number];
export type CanonicalListFilters = Partial<Record<ListFilterKey, string>>;

/**
 * The canonical form of a request's filters — the known keys, trimmed, lower-cased where the value is an enum or a flag, the empty
 * ones dropped, in one order — from a query string or a bus input alike, so the route's action-log row and the tool's event carry
 * the same hash for the same look (NO_PII_IN_LOG: the hash is what is logged; the form itself is never). The cursor is not a filter.
 */
export function canonicalListFilters(src: URLSearchParams | Record<string, unknown>): CanonicalListFilters {
  const get = (k: string): unknown => (src instanceof URLSearchParams ? src.get(k) : src[k]);
  const out: CanonicalListFilters = {};
  for (const k of LIST_FILTER_KEYS) {
    const v = get(k); if (v === null || v === undefined) continue;
    const s = typeof v === "boolean" ? String(v) : String(v).trim(); if (!s) continue;
    out[k] = k === "created_since" || k === "created_until" || k === "last_seen_since" || k === "partner" ? s : s.toLowerCase();
  }
  return out;
}
/** sha-256 of the canonical filter JSON (keys in canonical order) — `directory.listed.filters_hash` and the action log's `filters_hash`. */
export const listFiltersHash = (f: CanonicalListFilters): string => createHash("sha256").update(JSON.stringify(f)).digest("hex");

export interface DirectoryListInput {
  readonly tab: ListTab; readonly sort: ListSort;
  readonly origin: ListOrigin | null; readonly door: string | null; readonly status: "invited" | "active" | null; readonly verified: boolean | null; readonly stage: ListStage | null; readonly partner: string | null;
  readonly created_since: string | null; readonly created_until: string | null; readonly last_seen_since: string | null;
  readonly has_application: boolean | null; readonly has_loan: boolean | null; readonly signed_in_today: boolean | null;
  readonly cursor: string | null;
  /** The canonical form the input was parsed from (what the hash is over). */
  readonly filters: CanonicalListFilters;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const oneOf = <T extends string>(k: string, v: string | undefined, set: readonly T[]): T | null => { if (v === undefined) return null; if (!(set as readonly string[]).includes(v)) throw new DirectoryRefused(400, "BAD_FILTER", `${k} is one of ${set.join(", ")}`, { filter: k }); return v as T; };
const flagOf = (k: string, v: string | undefined): boolean | null => { if (v === undefined) return null; if (v === "true" || v === "1" || v === "yes") return true; if (v === "false" || v === "0" || v === "no") return false; throw new DirectoryRefused(400, "BAD_FILTER", `${k} is true or false`, { filter: k }); };
/** A date (YYYY-MM-DD, the start or the end of that day in UTC) or an instant. */
const instantOf = (k: string, v: string | undefined, end: boolean): string | null => { if (v === undefined) return null; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return end ? `${v}T23:59:59.999Z` : `${v}T00:00:00.000Z`; const t = Date.parse(v); if (Number.isNaN(t)) throw new DirectoryRefused(400, "BAD_FILTER", `${k} is a date (YYYY-MM-DD) or an instant`, { filter: k }); return new Date(t).toISOString(); };

/** The validated input from a query string or a bus input: enums checked, flags parsed, dates bounded; the canonical filters kept for the hash. */
export function parseListInput(src: URLSearchParams | Record<string, unknown>): DirectoryListInput {
  const f = canonicalListFilters(src);
  const cursorRaw = src instanceof URLSearchParams ? src.get("cursor") : src["cursor"];
  const partner = f.partner ?? null; if (partner !== null && !UUID.test(partner)) throw new DirectoryRefused(400, "BAD_FILTER", "partner is the partner's party id (uuid)", { filter: "partner" });
  return {
    tab: oneOf("tab", f.tab, LIST_TABS) ?? "accounts", sort: oneOf("sort", f.sort, LIST_SORTS) ?? "newest",
    origin: oneOf("origin", f.origin, LIST_ORIGINS), door: oneOf("door", f.door, LIST_DOORS), status: oneOf("status", f.status, LIST_STATUSES), verified: flagOf("verified", f.verified), stage: oneOf("stage", f.stage, LIST_STAGES), partner,
    created_since: instantOf("created_since", f.created_since, false), created_until: instantOf("created_until", f.created_until, true), last_seen_since: instantOf("last_seen_since", f.last_seen_since, false),
    has_application: flagOf("has_application", f.has_application), has_loan: flagOf("has_loan", f.has_loan), signed_in_today: flagOf("signed_in_today", f.signed_in_today),
    cursor: typeof cursorRaw === "string" && cursorRaw.trim() ? cursorRaw.trim() : null, filters: f,
  };
}

// ───────── the cursor: the sort, the sort key of the last row and its id, base64url; a cursor of another sort is refused
interface Cursor { readonly s: ListSort; readonly k: string | null; readonly id: string }
const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
function decodeCursor(raw: string, sort: ListSort): Cursor {
  let c: unknown; try { c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { throw new DirectoryRefused(400, "BAD_CURSOR", "the cursor is not one this list issued"); }
  const o = c as Record<string, unknown>;
  if (!o || typeof o !== "object" || !UUID.test(String(o["id"] ?? "")) || (o["k"] !== null && typeof o["k"] !== "string") || o["s"] !== sort) throw new DirectoryRefused(400, "BAD_CURSOR", `the cursor is not one this list issued for sort ${sort}`);
  return { s: sort, k: o["k"] as string | null, id: String(o["id"]) };
}

export interface DirectoryListRow {
  readonly party_id: string;
  /** The legal name when one was captured; null (with `name_state`) while the account's name is still its e-mail or the video door's placeholder. */
  readonly legal_name: string | null; readonly name_state: "captured" | "not_captured";
  readonly email: string | null; readonly phone: string | null;   // masked (m…@example.com, ···0101)
  readonly origin: ListOrigin; readonly origin_label: string; readonly origins: readonly string[];
  readonly doors: readonly string[]; readonly door_methods: readonly string[];
  readonly status: "invited" | "active"; readonly open_session: boolean; readonly signed_in_today: boolean;
  readonly email_verified_at: string | null; readonly verified: boolean;
  readonly stage: ListStage; readonly activated: boolean;
  readonly subjects: DirectorySearchHit["subjects"];
  readonly partner: { partner_party_id: string; partner_name: string; source: "application" | "loan" | "configured" } | null;
  readonly created_at: string; readonly first_seen_at: string | null; readonly last_seen_at: string | null;
}
export interface DirectoryListResult {
  readonly tab: ListTab; readonly sort: ListSort; readonly filters: CanonicalListFilters; readonly filters_hash: string;
  readonly rows: readonly DirectoryListRow[]; readonly results: number; readonly page_size: number; readonly next: string | null;
  readonly as_of: string; readonly mask: "role"; readonly event_id?: string | null;
}

interface Row extends Record<string, unknown> {
  id: string; legal_name: string; contact: Record<string, unknown>; created_at: string;
  origin: ListOrigin; book_partner_id: string | null; book_partner_name: string | null;
  first_seen_at: string | null; last_seen_at: string | null; methods: string[]; open_session: boolean; signed_in_today: boolean;
  status: "invited" | "active"; email_verified_at: string | null; stage: ListStage; activated: boolean; n_apps: number; n_loans: number;
  partner_party_id: string | null; partner_name: string | null; partner_source: "application" | "loan" | "configured" | null; has_credential: boolean; sort_key: string | null;
}

/**
 * The one query behind the list (and, in increment 2, the counts): every borrower party with its derived columns as a CTE, the filters
 * as predicates over it, the sort as a keyset order. `$1` is `now`, `$2` today's date (America/New_York), `$3` the configured entry
 * partner (nullable; the partner of record when neither an application nor a loan names one) — the rest are the filters and the
 * cursor, appended in order.
 */
export function listQuery(i: DirectoryListInput, cursor: Cursor | null): { sql: string; params: unknown[]; base: number } {
  const p: unknown[] = []; const where: string[] = [];
  const add = (v: unknown): string => { p.push(v); return `$${p.length + 3}`; };
  if (i.origin) where.push(`r.origin = ${add(i.origin)}`);
  if (i.door) where.push(`${add(i.door)} = ANY(r.methods)`);
  if (i.status) where.push(`r.status = ${add(i.status)}`);
  if (i.verified !== null) where.push(i.verified ? `r.email_verified_at IS NOT NULL` : `r.email_verified_at IS NULL`);
  if (i.stage) where.push(`r.stage = ${add(i.stage)}`);
  if (i.partner) where.push(`r.partner_party_id = ${add(i.partner)}::uuid`);
  if (i.created_since) where.push(`r.created_at >= ${add(i.created_since)}::timestamptz`);
  if (i.created_until) where.push(`r.created_at <= ${add(i.created_until)}::timestamptz`);
  if (i.last_seen_since) where.push(`r.last_seen_at >= ${add(i.last_seen_since)}::timestamptz`);
  if (i.has_application !== null) where.push(i.has_application ? `r.n_apps > 0` : `r.n_apps = 0`);
  if (i.has_loan !== null) where.push(i.has_loan ? `r.n_loans > 0` : `r.n_loans = 0`);
  if (i.signed_in_today !== null) where.push(i.signed_in_today ? `r.signed_in_today` : `NOT r.signed_in_today`);
  // the sort and its keyset: creation (newest first, the id as the tiebreak — rule 5); last seen (nulls last); name (ascending)
  const key = i.sort === "newest" ? "r.created_at" : i.sort === "last_seen" ? "r.last_seen_at" : "lower(r.legal_name)";
  const order = i.sort === "newest" ? `r.created_at DESC, r.id DESC` : i.sort === "last_seen" ? `r.last_seen_at DESC NULLS LAST, r.id DESC` : `lower(r.legal_name) ASC, r.id ASC`;
  if (cursor) {
    const id = add(cursor.id);
    if (i.sort === "name") where.push(`(${key}, r.id) > (${add(cursor.k ?? "")}, ${id}::uuid)`);
    else if (cursor.k === null) where.push(`r.last_seen_at IS NULL AND r.id < ${id}::uuid`);
    else if (i.sort === "newest") where.push(`(r.created_at, r.id) < (${add(cursor.k)}::timestamptz, ${id}::uuid)`);
    else { const k = add(cursor.k); where.push(`(r.last_seen_at < ${k}::timestamptz OR (r.last_seen_at = ${k}::timestamptz AND r.id < ${id}::uuid) OR r.last_seen_at IS NULL)`); }
  }
  const sql = `WITH base AS (
      SELECT pt.id, pt.legal_name, pt.contact, pt.created_at FROM parties pt
      WHERE pt.party_type = 'borrower'
        AND NOT ${unidentifiedVideoPartySql("pt")}
    ), sess AS (
      SELECT s.party_id, min(s.created_at) AS first_seen_at, max(s.last_seen_at) AS last_seen_at,
             array_agg(DISTINCT s.auth_method) AS methods, (array_agg(s.auth_method ORDER BY s.created_at, s.session_id))[1] AS first_method,
             min(s.created_at) FILTER (WHERE s.auth_method = 'otp_email') AS first_email_code_at,
             bool_or(s.revoked_at IS NULL AND s.expires_at > $1::timestamptz) AS open_session,
             bool_or((s.created_at AT TIME ZONE '${ET}')::date = $2::date) AS signed_in_today
      FROM sessions s GROUP BY s.party_id
    ), pb AS (
      SELECT DISTINCT ON (b.party_id) b.party_id, l.partner_party_id, pp.legal_name AS partner_name
      FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id JOIN loans l ON l.id = lb.loan_id JOIN parties pp ON pp.id = l.partner_party_id
      WHERE b.party_id IS NOT NULL AND l.partner_party_id IS NOT NULL ORDER BY b.party_id, l.created_at
    ), lo AS (
      SELECT b.party_id, l.id AS loan_id, l.status::text AS status, l.partner_party_id, l.created_at,
             EXISTS (SELECT 1 FROM loan_events e WHERE e.loan_id = l.id AND e.type = 'partner_book.account.activated') AS activated
      FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id JOIN loans l ON l.id = lb.loan_id WHERE b.party_id IS NOT NULL
    ), loagg AS (
      SELECT party_id, count(*)::int AS n_loans, bool_or(status = 'monitored') AS monitored, bool_or(status <> 'monitored') AS serviced, bool_or(status = 'monitored' AND activated) AS activated,
             (array_agg(partner_party_id ORDER BY created_at) FILTER (WHERE partner_party_id IS NOT NULL))[1] AS loan_partner_id
      FROM lo GROUP BY party_id
    ), ap AS (
      SELECT ab.party_id, a.id AS application_id, a.partner_party_id, a.created_at FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE ab.party_id IS NOT NULL
    ), apagg AS (
      SELECT party_id, count(*)::int AS n_apps, (array_agg(partner_party_id ORDER BY created_at))[1] AS app_partner_id,
             bool_or(EXISTS (SELECT 1 FROM loan_events e WHERE e.application_id = ap.application_id AND e.type = 'loan.funded')) AS funded,
             bool_or(EXISTS (SELECT 1 FROM loan_events e WHERE e.application_id = ap.application_id AND e.type = 'clear_to_close.issued')) AS ctc,
             bool_or(EXISTS (SELECT 1 FROM loan_events e WHERE e.application_id = ap.application_id AND e.type = 'decision.issued')) AS decided
      FROM ap GROUP BY party_id
    ), ld AS (
      SELECT DISTINCT data->>'party_id' AS party_id FROM entity_current
      WHERE kind = 'leads' AND coalesce(data->>'party_id', '') <> '' AND coalesce(data->>'status', '') NOT IN ('converted', 'expired', 'closed_lost')
    ), cred AS (
      SELECT party_id, email_verified_at FROM party_credentials
    ), oid AS (
      SELECT party_id, min(first_seen_at) FILTER (WHERE email_verified) AS verified_at FROM oidc_identities WHERE revoked_at IS NULL GROUP BY party_id
    ), rows AS (
      SELECT b.id, b.legal_name, b.contact, b.created_at,
             CASE WHEN pb.party_id IS NOT NULL THEN 'partner_book' WHEN s.first_method = 'video' THEN 'video_door' ELSE 'front_door' END AS origin,
             pb.partner_party_id AS book_partner_id, pb.partner_name AS book_partner_name,
             s.first_seen_at, s.last_seen_at, coalesce(s.methods, '{}'::text[]) AS methods, coalesce(s.open_session, false) AS open_session, coalesce(s.signed_in_today, false) AS signed_in_today,
             CASE WHEN s.party_id IS NULL THEN 'invited' ELSE 'active' END AS status,
             coalesce(c.email_verified_at, o.verified_at, s.first_email_code_at) AS email_verified_at,
             CASE WHEN la.monitored THEN 'monitored' WHEN la.serviced THEN 'boarded' WHEN aa.funded THEN 'funded' WHEN aa.ctc THEN 'closing' WHEN aa.decided THEN 'decision'
                  WHEN coalesce(aa.n_apps, 0) > 0 THEN 'application' WHEN ld.party_id IS NOT NULL THEN 'lead' ELSE 'account' END AS stage,
             coalesce(la.activated, false) AS activated, coalesce(aa.n_apps, 0) AS n_apps, coalesce(la.n_loans, 0) AS n_loans,
             coalesce(aa.app_partner_id, la.loan_partner_id, $3::uuid) AS partner_party_id,
             CASE WHEN aa.app_partner_id IS NOT NULL THEN 'application' WHEN la.loan_partner_id IS NOT NULL THEN 'loan' WHEN $3::uuid IS NOT NULL THEN 'configured' ELSE NULL END AS partner_source,
             (c.party_id IS NOT NULL OR o.party_id IS NOT NULL) AS has_credential
      FROM base b
      LEFT JOIN sess s ON s.party_id = b.id LEFT JOIN pb ON pb.party_id = b.id LEFT JOIN loagg la ON la.party_id = b.id LEFT JOIN apagg aa ON aa.party_id = b.id
      LEFT JOIN ld ON ld.party_id = b.id::text LEFT JOIN cred c ON c.party_id = b.id LEFT JOIN oid o ON o.party_id = b.id
    )
    SELECT r.id::text AS id, r.legal_name, r.contact, r.created_at::text AS created_at, r.origin, r.book_partner_id::text AS book_partner_id, r.book_partner_name,
           r.first_seen_at::text AS first_seen_at, r.last_seen_at::text AS last_seen_at, r.methods, r.open_session, r.signed_in_today, r.status, r.email_verified_at::text AS email_verified_at,
           r.stage, r.activated, r.n_apps, r.n_loans, r.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_name, r.partner_source, r.has_credential, (${key})::text AS sort_key
    FROM rows r LEFT JOIN parties pp ON pp.id = r.partner_party_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${order}
    LIMIT ${LIST_PAGE_SIZE + 1}`;
  return { sql, params: p, base: 3 };
}

/** DELTA-29 / 32.17: an account whose legal name is still its e-mail address or the video door's placeholder has no captured name. */
export const isCapturedName = (name: string | null | undefined): boolean => !!name && !name.includes("@") && !/^borrower \(/i.test(name);
const firstString = (contact: Record<string, unknown>, k: string, ks: string): string => (typeof contact[k] === "string" ? (contact[k] as string) : Array.isArray(contact[ks]) ? String((contact[ks] as unknown[])[0] ?? "") : "");
const originLabel = (o: ListOrigin, partner: string | null): string => (o === "partner_book" ? `partner book: ${partner ?? ""}`.trim() : o === "video_door" ? "video door" : "front door");

/** The list itself (no log; the input parsed by `parseListInput`) — `directoryListLogged` below logs the look and watches the volume. */
export async function directoryList(db: Db, i: DirectoryListInput, nowIso: string): Promise<Omit<DirectoryListResult, "event_id">> {
  if (i.tab === "not_yet_an_account") throw new DirectoryRefused(501, "NOT_BUILT", "the \"Not yet an account\" tab (34.5 rule 9, T4) is increment 2 of the portal build; the accounts tab is served");
  const cursor = i.cursor ? decodeCursor(i.cursor, i.sort) : null;
  const today = String(wallClock(Date.parse(nowIso), ET).date);
  const configured = await entryPartner(db, process.env["BORROWER_DEFAULT_PARTNER_ID"]);
  const q = listQuery(i, cursor);
  const rows = await db.query<Row>(q.sql, [nowIso, today, configured?.id ?? null, ...q.params]);
  const page = rows.slice(0, LIST_PAGE_SIZE); const more = rows.length > LIST_PAGE_SIZE;
  const subjects = await subjectsOf(db, page.map((r) => r.id));
  const out: DirectoryListRow[] = page.map((r) => {
    // the partner of record: the application's, else the loan's, else the configured entry partner ($3 in the query) — never Supermortgage
    const partner = r.partner_party_id && r.partner_name && r.partner_source ? { partner_party_id: r.partner_party_id, partner_name: r.partner_name, source: r.partner_source } : null;
    // the doors, as account.ts derives them (34.2 rule 1 / edge case 2): the partner book when the party holds a partner's loan, the video door when a session came through it, the front door when they hold a credential, an application or a non-video session
    const origins: string[] = [];
    if (r.origin === "partner_book") origins.push(originLabel("partner_book", r.book_partner_name));
    if (r.methods.includes("video")) origins.push("video door");
    if (r.has_credential || r.n_apps > 0 || r.methods.some((m) => m !== "video")) origins.push("front door");
    if (!origins.length) origins.push(originLabel(r.origin, r.book_partner_name));
    const captured = isCapturedName(r.legal_name);
    return { party_id: r.id, legal_name: captured ? r.legal_name : null, name_state: captured ? "captured" : "not_captured",
      email: maskEmail(firstString(r.contact, "email", "emails")), phone: maskPhone(firstString(r.contact, "phone", "phones")),
      origin: r.origin, origin_label: originLabel(r.origin, r.book_partner_name), origins: [...new Set(origins)],
      doors: r.methods.map((m) => DOOR_LABELS[m] ?? m), door_methods: [...r.methods],
      status: r.status, open_session: r.open_session, signed_in_today: r.signed_in_today,
      email_verified_at: r.email_verified_at, verified: r.email_verified_at !== null,
      stage: r.stage, activated: r.activated, subjects: subjects.get(r.id) ?? [], partner,
      created_at: r.created_at, first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at };
  });
  const last = page.at(-1);
  const next = more && last ? encodeCursor({ s: i.sort, k: i.sort === "last_seen" ? last.sort_key : (last.sort_key ?? ""), id: last.id }) : null;
  // NO_SECRETS / NO_FULL_SSN: the defensive last pass over the rows (the cursor is an opaque key of this list's own and stays as issued)
  return { tab: i.tab, sort: i.sort, filters: i.filters, filters_hash: listFiltersHash(i.filters), rows: stripSecrets(out), results: out.length, page_size: LIST_PAGE_SIZE, next, as_of: nowIso, mask: "role" as const };
}

export interface DirectoryListLook { readonly staff_user_id: string; readonly session_id?: string | null }
/** The day's pages and rows one person read across the three lists (their look events), America/New_York. */
export async function listVolumeToday(db: Queryable, staffUserId: string, nowIso: string): Promise<{ day: string; pages: number; rows: number }> {
  const day = String(wallClock(Date.parse(nowIso), ET).date);
  const r = (await db.query<{ pages: string; rows: string }>(`SELECT count(*)::text AS pages, coalesce(sum((payload->>'results')::int), 0)::text AS rows FROM loan_events WHERE type = ANY($1::text[]) AND payload->>'staff_user_id' = $2 AND (occurred_at AT TIME ZONE $3)::date = $4::date`, [[...LIST_VOLUME_EVENTS], staffUserId, ET, day]))[0];
  return { day, pages: Number(r?.pages ?? "0"), rows: Number(r?.rows ?? "0") };
}

/**
 * The list on the bus's behalf: the page plus `directory.listed{staff_user_id, filters_hash, results}` (global; the filters as their
 * hash, never a text) — and LIST_VOLUME: past 20 pages or 1,000 rows by this person today (this page counted), one open `compliance`
 * escalation per person per day naming the person, the counts and the day. A refused page logs nothing.
 */
export async function directoryListLogged(rt: Runtime, input: URLSearchParams | Record<string, unknown>, look: DirectoryListLook, actor: Actor): Promise<DirectoryListResult & { escalation_id: string | null }> {
  const now = rt.clock.now();
  const r = await directoryList(rt.db, parseListInput(input), now);
  const before = await listVolumeToday(rt.db, look.staff_user_id, now);
  const pages = before.pages + 1; const rowsRead = before.rows + r.results;
  const over = pages > LIST_VOLUME_PAGES_PER_DAY || rowsRead > LIST_VOLUME_ROWS_PER_DAY;
  const alreadyOpen = over && (await rt.db.query<{ id: string }>(`SELECT id::text AS id FROM escalations WHERE completed_at IS NULL AND owner_role = 'compliance' AND payload->>'reason' = $1 AND payload->>'staff_user_id' = $2 AND payload->>'day' = $3`, [LIST_VOLUME_REASON, look.staff_user_id, before.day])).length > 0;
  let escalation_id: string | null = null; let escalations: EscalationService | undefined;
  const w = await rt.uow.run({}, async (ctx) => {
    ctx.events.append({ type: "directory.listed", aggregate: { kind: "staff_user", id: look.staff_user_id }, actor, payload: { staff_user_id: look.staff_user_id, ...(look.session_id ? { session_id: look.session_id } : {}), filters_hash: r.filters_hash, results: r.results, tab: r.tab, next: r.next !== null } });
    if (over && !alreadyOpen) {
      escalations = new EscalationService(ctx.events, ctx.clock);
      const e = escalations.open({ kind: "sev3", ownerRole: "compliance", severity: "3", payload: { reason: LIST_VOLUME_REASON, code: "LIST_VOLUME", staff_user_id: look.staff_user_id, day: before.day, pages, rows: rowsRead, tools: [...LIST_VOLUME_EVENTS], thresholds: { pages: LIST_VOLUME_PAGES_PER_DAY, rows: LIST_VOLUME_ROWS_PER_DAY }, note: "34.5 rule 8: more than 20 pages or 1,000 rows read by one person in one day across the lists; the lists keep answering" } }, actor);
      escalation_id = e.id;
    }
  }, { clock: rt.clock, commit: async (q) => { for (const e of escalations?.list() ?? []) await rt.escalationRepo.save(e, q); } });
  return { ...r, event_id: w.events[0]?.id ?? null, escalation_id };
}
