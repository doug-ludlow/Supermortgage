/**
 * 34.2 `directory.search` — rule 4 ("Search never leaks") and Discrepancy (1):
 *
 *   - fewer than three characters is refused (`QUERY_TOO_SHORT`); more than 50 matches asks for a narrower query (`NARROW_QUERY`);
 *   - a partial e-mail, phone or name matches by PREFIX on the normalized value (lower-cased e-mail, E.164 phone, lower-cased
 *     legal name — the expression indexes of 0128; a name also matches on any later word, "Garcia" finds "Maria Garcia");
 *   - a four-digit query is a last-four search (T1: "the last four of loan 1's servicer loan number", "the phone's last four
 *     digits") over servicer loan numbers, phones, application ids and party ids — the directory's own idiom for identifiers;
 *   - results carry names and masked contact only (mask.ts); the query itself is logged as a sha256 hash on
 *     `directory.searched{staff_user_id, query_hash, results}` (global; no query text, no destination, no name);
 *   - a servicer loan number that matches a loan with no party (loaded before any supplement) is listed under `no_account_yet`
 *     with the partner and the last four (edge case 3); two parties sharing an e-mail are both listed (edge case 1).
 *
 * The search reads borrower parties only (a servicer or an investor row is not a person in the directory).
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import { normalizePhone } from "../../infra/db/borrower-parties.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import { lastFour, maskEmail, maskPhone } from "./mask.ts";
import { unidentifiedVideoPartySql } from "./scope.ts";

export const SEARCH_MIN_CHARS = 3;
export const SEARCH_MAX_RESULTS = 50;
export const queryHash = (q: string): string => createHash("sha256").update(q.trim().toLowerCase()).digest("hex");

export class DirectorySearchRefused extends RangeError {
  readonly code: "QUERY_TOO_SHORT" | "NARROW_QUERY";
  readonly matches: number;
  constructor(code: "QUERY_TOO_SHORT" | "NARROW_QUERY", detail: string, matches = 0) { super(detail); this.name = "DirectorySearchRefused"; this.code = code; this.matches = matches; }
}

export interface DirectorySearchHit {
  readonly party_id: string;
  readonly legal_name: string;
  readonly email: string | null;   // masked
  readonly phone: string | null;   // masked
  readonly origin: "front_door" | "video_door" | "partner_book";
  readonly partner_name: string | null;
  readonly matched_on: readonly ("name" | "email" | "phone" | "servicer_loan_number" | "application_id" | "party_id")[];
  readonly subjects: readonly { loan_id: string | null; application_id: string | null; loan_last4: string | null; application_last4: string | null; status: string | null }[];
}
export interface DirectoryNoAccountHit { readonly loan_id: string; readonly loan_last4: string | null; readonly partner_party_id: string | null; readonly partner_name: string | null; readonly status: string | null }
export interface DirectorySearchResult { readonly query_hash: string; readonly results: readonly DirectorySearchHit[]; readonly no_account_yet: readonly DirectoryNoAccountHit[]; readonly count: number; readonly event_id: string | null }

interface Row extends Record<string, unknown> { party_id: string; legal_name: string; contact: Record<string, unknown>; m_name: boolean; m_email: boolean; m_phone: boolean; m_party: boolean }
interface LoanRow extends Record<string, unknown> { loan_id: string; servicer_loan_number: string | null; status: string; partner_party_id: string | null; partner_name: string | null; party_id: string | null; origination_application_id: string | null }
interface AppRow extends Record<string, unknown> { application_id: string; loan_id: string | null; party_id: string | null; status: string | null }

/** What the query is: a last-four (exactly four digits), a phone-ish string (digits, +, spaces, punctuation; ≥ 5 digits), an e-mail-ish string (an `@`), or text (a name, a loan number, an id). */
export function classifyQuery(q: string): { kind: "last4" | "phone" | "email" | "text"; value: string } {
  const t = q.trim();
  const digits = t.replace(/\D/g, "");
  if (/^\d{4}$/.test(t)) return { kind: "last4", value: t };
  if (t.includes("@")) return { kind: "email", value: t.toLowerCase() };
  if (/^[\d+()\-.\s]+$/.test(t) && digits.length >= 5) return { kind: "phone", value: normalizePhone(t) };
  return { kind: "text", value: t.toLowerCase() };
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 34.2's un-identified video party (scope.ts): never searchable as a person — by name, e-mail, phone or id — whether its session is open or closed. */
const NOT_A_PERSON = unidentifiedVideoPartySql("parties");

/** The rows of `parties` (borrower) matching the query, with which fields matched — the expression indexes of 0128 serve the three prefix predicates. */
async function matchParties(db: Queryable, c: ReturnType<typeof classifyQuery>, raw: string): Promise<Row[]> {
  const pre = `${escapeLike(c.value)}%`;
  if (c.kind === "last4") {
    return db.query<Row>(`SELECT id::text AS party_id, legal_name, contact, false AS m_name, false AS m_email,
        (right(directory_e164(contact->>'phone'), 4) = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(contact->'phones') = 'array' THEN contact->'phones' ELSE '[]'::jsonb END) ph WHERE right(directory_e164(ph), 4) = $1)) AS m_phone,
        right(id::text, 4) = $1 AS m_party
      FROM parties WHERE party_type = 'borrower' AND NOT ${NOT_A_PERSON} AND (right(directory_e164(contact->>'phone'), 4) = $1 OR right(id::text, 4) = $1
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(contact->'phones') = 'array' THEN contact->'phones' ELSE '[]'::jsonb END) ph WHERE right(directory_e164(ph), 4) = $1))
      ORDER BY legal_name, id LIMIT ${SEARCH_MAX_RESULTS + 1}`, [c.value]);
  }
  if (c.kind === "phone") {
    // a run of digits is a phone fragment AND may be the first characters of a party id (a uuid whose leading hex digits are all numeric — about
    // one id in forty at eight characters): the text branch's id-prefix predicate rides along, so "searchable by id prefix" holds for every id
    const idPre = /^\d+$/.test(raw.trim()) ? `${escapeLike(raw.trim())}%` : null;
    return db.query<Row>(`SELECT id::text AS party_id, legal_name, contact, false AS m_name, false AS m_email,
        (directory_e164(contact->>'phone') LIKE $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(contact->'phones') = 'array' THEN contact->'phones' ELSE '[]'::jsonb END) ph WHERE directory_e164(ph) LIKE $1)) AS m_phone,
        ($2::text IS NOT NULL AND id::text LIKE $2::text) AS m_party
      FROM parties WHERE party_type = 'borrower' AND NOT ${NOT_A_PERSON} AND (directory_e164(contact->>'phone') LIKE $1
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(contact->'phones') = 'array' THEN contact->'phones' ELSE '[]'::jsonb END) ph WHERE directory_e164(ph) LIKE $1)
        OR ($2::text IS NOT NULL AND id::text LIKE $2::text))
      ORDER BY legal_name, id LIMIT ${SEARCH_MAX_RESULTS + 1}`, [pre, idPre]);
  }
  if (c.kind === "email") {
    return db.query<Row>(`SELECT id::text AS party_id, legal_name, contact, false AS m_name, true AS m_email, false AS m_phone, false AS m_party
      FROM parties WHERE party_type = 'borrower' AND NOT ${NOT_A_PERSON} AND (lower(contact->>'email') LIKE $1
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(contact->'emails') = 'array' THEN contact->'emails' ELSE '[]'::jsonb END) em WHERE lower(em) LIKE $1))
      ORDER BY legal_name, id LIMIT ${SEARCH_MAX_RESULTS + 1}`, [pre]);
  }
  // text: a name (the whole name or any later word by prefix), the first characters of an e-mail (T1: "the first six characters of the e-mail"), a party id prefix
  return db.query<Row>(`SELECT id::text AS party_id, legal_name, contact,
      (lower(legal_name) LIKE $1 OR lower(legal_name) LIKE $2) AS m_name,
      (lower(contact->>'email') LIKE $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(contact->'emails') = 'array' THEN contact->'emails' ELSE '[]'::jsonb END) em WHERE lower(em) LIKE $1)) AS m_email,
      false AS m_phone, (id::text LIKE $1) AS m_party
    FROM parties WHERE party_type = 'borrower' AND NOT ${NOT_A_PERSON} AND (lower(legal_name) LIKE $1 OR lower(legal_name) LIKE $2 OR lower(contact->>'email') LIKE $1 OR id::text LIKE $1
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(contact->'emails') = 'array' THEN contact->'emails' ELSE '[]'::jsonb END) em WHERE lower(em) LIKE $1))
    ORDER BY legal_name, id LIMIT ${SEARCH_MAX_RESULTS + 1}`, [pre, `% ${pre}`]);
}

/** Loans whose servicer loan number matches (a last four, or a prefix / the whole number), with their party (borrowers.party_id) and partner. */
async function matchLoans(db: Queryable, c: ReturnType<typeof classifyQuery>): Promise<LoanRow[]> {
  if (c.kind === "email" || c.kind === "phone") return [];
  const sql = `SELECT l.id::text AS loan_id, l.servicer_loan_number, l.status::text AS status, l.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_name, l.origination_application_id::text AS origination_application_id,
      (SELECT b.party_id::text FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = l.id AND b.party_id IS NOT NULL ORDER BY lb.role, b.created_at LIMIT 1) AS party_id
    FROM loans l LEFT JOIN parties pp ON pp.id = l.partner_party_id WHERE l.servicer_loan_number IS NOT NULL AND ${c.kind === "last4" ? "right(l.servicer_loan_number, 4) = $1" : "lower(l.servicer_loan_number) LIKE $1"} ORDER BY l.created_at LIMIT ${SEARCH_MAX_RESULTS + 1}`;
  return db.query<LoanRow>(sql, [c.kind === "last4" ? c.value : `${escapeLike(c.value)}%`]);
}
/** Applications whose id matches (a last four or a prefix), with the first borrower party. */
async function matchApplications(db: Queryable, c: ReturnType<typeof classifyQuery>): Promise<AppRow[]> {
  if (c.kind === "email" || c.kind === "phone") return [];
  return db.query<AppRow>(`SELECT a.id::text AS application_id, a.loan_id::text AS loan_id, a.status::text AS status,
      (SELECT ab.party_id::text FROM application_borrowers ab WHERE ab.application_id = a.id AND ab.party_id IS NOT NULL ORDER BY ab.created_at LIMIT 1) AS party_id
    FROM applications a WHERE ${c.kind === "last4" ? "right(a.id::text, 4) = $1" : "a.id::text LIKE $1"} ORDER BY a.created_at LIMIT ${SEARCH_MAX_RESULTS + 1}`, [c.kind === "last4" ? c.value : `${escapeLike(c.value)}%`]);
}

/** The subjects of the listed parties in one query (the search shows last-four identifiers and the loan status, never a figure) — the accounts list (34.5, list.ts) reads the same shape. */
export async function subjectsOf(db: Queryable, partyIds: readonly string[]): Promise<Map<string, DirectorySearchHit["subjects"][number][]>> {
  const out = new Map<string, DirectorySearchHit["subjects"][number][]>();
  if (!partyIds.length) return out;
  const loans = await db.query<{ party_id: string; loan_id: string; servicer_loan_number: string | null; status: string; origination_application_id: string | null }>(
    `SELECT b.party_id::text AS party_id, l.id::text AS loan_id, l.servicer_loan_number, l.status::text AS status, l.origination_application_id::text AS origination_application_id
     FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id JOIN loans l ON l.id = lb.loan_id WHERE b.party_id = ANY($1::uuid[]) ORDER BY l.created_at`, [partyIds]);
  for (const l of loans) { const list = out.get(l.party_id) ?? []; if (!list.some((s) => s.loan_id === l.loan_id)) list.push({ loan_id: l.loan_id, application_id: l.origination_application_id, loan_last4: lastFour(l.servicer_loan_number), application_last4: lastFour(l.origination_application_id), status: l.status }); out.set(l.party_id, list); }
  const apps = await db.query<{ party_id: string; application_id: string; loan_id: string | null; status: string | null }>(
    `SELECT ab.party_id::text AS party_id, a.id::text AS application_id, a.loan_id::text AS loan_id, a.status::text AS status FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE ab.party_id = ANY($1::uuid[]) ORDER BY a.created_at`, [partyIds]);
  for (const a of apps) { const list = out.get(a.party_id) ?? []; if (!list.some((s) => s.application_id === a.application_id || (a.loan_id && s.loan_id === a.loan_id))) list.push({ loan_id: a.loan_id, application_id: a.application_id, loan_last4: null, application_last4: lastFour(a.application_id), status: a.status }); out.set(a.party_id, list); }
  return out;
}

/** The origin of each listed party (rule 1): a borrowers row on a partner's loan → partner book; a first session through the video door → video door; else the front door. */
export async function originsOf(db: Queryable, partyIds: readonly string[]): Promise<Map<string, { origin: DirectorySearchHit["origin"]; partner_name: string | null; partner_party_id: string | null }>> {
  const out = new Map<string, { origin: DirectorySearchHit["origin"]; partner_name: string | null; partner_party_id: string | null }>();
  if (!partyIds.length) return out;
  const partners = await db.query<{ party_id: string; partner_party_id: string; partner_name: string }>(
    `SELECT DISTINCT ON (b.party_id) b.party_id::text AS party_id, l.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_name
     FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id JOIN loans l ON l.id = lb.loan_id JOIN parties pp ON pp.id = l.partner_party_id
     WHERE b.party_id = ANY($1::uuid[]) AND l.partner_party_id IS NOT NULL ORDER BY b.party_id, l.created_at`, [partyIds]);
  for (const p of partners) out.set(p.party_id, { origin: "partner_book", partner_name: p.partner_name, partner_party_id: p.partner_party_id });
  const video = await db.query<{ party_id: string }>(`SELECT DISTINCT ON (party_id) party_id::text AS party_id FROM (SELECT party_id, auth_method FROM sessions WHERE party_id = ANY($1::uuid[]) ORDER BY party_id, created_at) s WHERE auth_method = 'video'`, [partyIds]);
  for (const v of video) if (!out.has(v.party_id)) out.set(v.party_id, { origin: "video_door", partner_name: null, partner_party_id: null });
  for (const id of partyIds) if (!out.has(id)) out.set(id, { origin: "front_door", partner_name: null, partner_party_id: null });
  return out;
}

export interface DirectorySearchInput { readonly q: string; readonly roles: readonly string[]; readonly staff_user_id?: string | null; readonly session_id?: string | null }

/** The search itself (no log): the parties, the loans without a party, the counts — the runtime wrapper below logs the query hash. */
export async function directorySearch(db: Queryable, input: DirectorySearchInput): Promise<Omit<DirectorySearchResult, "event_id">> {
  const q = String(input.q ?? "").trim();
  if (q.length < SEARCH_MIN_CHARS) throw new DirectorySearchRefused("QUERY_TOO_SHORT", `a directory search needs at least ${SEARCH_MIN_CHARS} characters`);
  const c = classifyQuery(q);
  const [parties, loans, apps] = await Promise.all([matchParties(db, c, q), matchLoans(db, c), matchApplications(db, c)]);
  const matched = new Map<string, { row: Row | null; on: Set<DirectorySearchHit["matched_on"][number]> }>();
  for (const r of parties) { const on = new Set<DirectorySearchHit["matched_on"][number]>(); if (r.m_name) on.add("name"); if (r.m_email) on.add("email"); if (r.m_phone) on.add("phone"); if (r.m_party) on.add("party_id"); matched.set(r.party_id, { row: r, on }); }
  const noAccount: DirectoryNoAccountHit[] = [];
  for (const l of loans) {
    if (l.party_id) { const m = matched.get(l.party_id) ?? { row: null, on: new Set() }; m.on.add("servicer_loan_number"); matched.set(l.party_id, m); }
    else noAccount.push({ loan_id: l.loan_id, loan_last4: lastFour(l.servicer_loan_number), partner_party_id: l.partner_party_id, partner_name: l.partner_name, status: l.status });
  }
  for (const a of apps) if (a.party_id) { const m = matched.get(a.party_id) ?? { row: null, on: new Set() }; m.on.add("application_id"); matched.set(a.party_id, m); }
  const total = matched.size + noAccount.length;
  if (total > SEARCH_MAX_RESULTS) throw new DirectorySearchRefused("NARROW_QUERY", `${total} matches; narrow the query`, total);
  // the rows a loan or application match named but the party query did not select
  const missing = [...matched.entries()].filter(([, m]) => !m.row).map(([id]) => id);
  if (missing.length) for (const r of await db.query<Row>(`SELECT id::text AS party_id, legal_name, contact, false AS m_name, false AS m_email, false AS m_phone, false AS m_party FROM parties WHERE id = ANY($1::uuid[]) AND party_type = 'borrower' AND NOT ${NOT_A_PERSON}`, [missing])) matched.get(r.party_id)!.row = r;
  const ids = [...matched.keys()].filter((id) => matched.get(id)!.row);
  const [subjects, origins] = await Promise.all([subjectsOf(db, ids), originsOf(db, ids)]);
  const results: DirectorySearchHit[] = ids.map((id) => { const m = matched.get(id)!; const r = m.row!; const o = origins.get(id)!; const email = typeof r.contact["email"] === "string" ? r.contact["email"] : Array.isArray(r.contact["emails"]) ? String((r.contact["emails"] as unknown[])[0] ?? "") : ""; const phone = typeof r.contact["phone"] === "string" ? r.contact["phone"] : Array.isArray(r.contact["phones"]) ? String((r.contact["phones"] as unknown[])[0] ?? "") : "";
    return { party_id: id, legal_name: r.legal_name, email: maskEmail(email), phone: maskPhone(phone), origin: o.origin, partner_name: o.partner_name, matched_on: [...m.on], subjects: subjects.get(id) ?? [] }; })
    .sort((a, b) => a.legal_name.localeCompare(b.legal_name) || a.party_id.localeCompare(b.party_id));
  return { query_hash: queryHash(q), results, no_account_yet: noAccount, count: total };
}

/** The search on the bus's behalf: the result plus `directory.searched{staff_user_id, query_hash, results}` logged (global; no query text) — a refused query logs nothing. */
export async function directorySearchLogged(rt: Runtime, input: DirectorySearchInput, actor: Actor): Promise<DirectorySearchResult> {
  const r = await directorySearch(rt.db, input);
  const staff = input.staff_user_id ?? actor.id;
  const w = await rt.uow.run({}, async (ctx) => { ctx.events.append({ type: "directory.searched", aggregate: { kind: "staff_user", id: staff }, actor, payload: { staff_user_id: staff, ...(input.session_id ? { session_id: input.session_id } : {}), query_hash: r.query_hash, results: r.count, no_account_yet: r.no_account_yet.length } }); }, { clock: rt.clock });
  return { ...r, event_id: w.events[0]?.id ?? null };
}
