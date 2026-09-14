/**
 * §34.3 — the shared readings of the partner-book operations views (spec/sections/34-operator-portal/34-3-*.md).
 * Everything here reads section 33's rows (partner_book_imports, partner_book_facts, partner_book_invitations,
 * partner_book_reviews, readiness_checks, the 20.1 entities, timers, escalations) and projects them for the portal; nothing
 * is computed about a loan (rule 7) — a figure is a stored fact, a stored engine figure or a count of rows, and a figure the
 * rows do not carry is `null`, never estimated.
 *
 *   maskEmail / maskPhone / maskContact   ROLE_MASK (34.2 rule 2): a homeowner's contact leaves every view as `m…@example.com` /
 *                                         `···0101`; the unmask is 34.2's own logged action and never happens here.
 *   holdsOf                               33.1 rule 8 read from rows: a monitored loan is on hold (`not_on_latest_tape`) when its latest
 *                                         partner_book_facts.as_of_date is older than the partner's latest loaded import's as-of date and no
 *                                         `partner_book.loan.resolved{resolution=keep}` was logged within the last KEEP_LIFTS_HOLD_DAYS (7) days.
 *                                         Computed here from the same rows 33.1 reads (the integration step may point this at 33.1's own
 *                                         export once its name is confirmed).
 *   recordBookViewed                      the event `book.viewed{staff_user_id, partner_id, view}` (global) the routes log per look; 34.1's
 *                                         action log carries the request itself.
 */
import { randomBytes } from "node:crypto";
import type { Queryable } from "../../infra/db/client.ts";
import type { Actor } from "../../kernel/events/index.ts";
import { addDays, plainDate, type PlainDate } from "../../kernel/calendar/date.ts";
import { wallClock, zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import type { Runtime } from "../app.ts";

export type Row = Record<string, unknown>;
export const ET = "America/New_York";
/** 33.2 / 33.3: the review by 07:30 ET and readiness by 07:30 ET each day (Key deadlines). */
export const RECEIPT_EXPECTED_ET = "07:30";
/** AI agent design: `ops_analyst` when a day has no review or readiness receipt by 07:45 ET. */
export const RECEIPT_ESCALATE_ET = "07:45";
/** 33.1 rule 8: the next tape is expected 7 calendar days after the last as-of date (SM_PARTNER_BOOK_TAPE_EXPECTED_7). */
export const TAPE_EXPECTED_DAYS = 7;
/** 33.1 rule 8: `keep` lifts the hold for 7 days. */
export const KEEP_LIFTS_HOLD_DAYS = 7;
export const TAPE_CLOCK = "SM_PARTNER_BOOK_TAPE_EXPECTED_7";
export const HOLD_REASON = "not_on_latest_tape";
export const RESOLUTIONS: readonly string[] = ["paid_off", "transferred_out", "keep"];
export const PORTFOLIO_AGENT: Actor = { kind: "agent", id: "portfolio" };
export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0);
export const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

// ---------------------------------------------------------------- time-ordered ids for append-only rows
let lastMs = 0; let lastSeq = 0;
/**
 * A UUID v7 (48-bit wall-clock milliseconds, a 12-bit monotonic sequence within the millisecond, 62 random bits): the ids of the
 * append-only report rows sort by insertion order, so "the newest row wins" holds even when every row shares a `created_at`
 * (a FixedClock in tests; two rows in one settlement) — `ORDER BY created_at DESC, id DESC`.
 */
export function newestId(): string {
  let ms = Date.now();
  if (ms <= lastMs) { ms = lastMs; lastSeq = (lastSeq + 1) & 0x0fff; if (lastSeq === 0) { lastMs += 1; ms = lastMs; } } else { lastMs = ms; lastSeq = 0; }
  const b = Buffer.alloc(16); b.writeUIntBE(ms, 0, 6);
  b.writeUInt16BE(0x7000 | lastSeq, 6);
  const r = randomBytes(8); r[0] = ((r[0] ?? 0) & 0x3f) | 0x80; r.copy(b, 8);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------- ROLE_MASK (34.2 rule 2) / NO_DESTINATION
/** `maria.garcia@example.com` → `m…@example.com`; anything without an @ → `…`. */
export function maskEmail(email: unknown): string | null {
  if (typeof email !== "string" || !email.trim()) return null;
  const at = email.indexOf("@"); if (at <= 0) return "…";
  return `${email.slice(0, 1)}…${email.slice(at)}`;
}
/** `+16025550101` → `···0101`. */
export function maskPhone(phone: unknown): string | null {
  if (typeof phone !== "string" || !phone.trim()) return null;
  const digits = phone.replace(/\D/g, "");
  return `···${digits.slice(-4).padStart(4, "·")}`;
}
export type MaskedContact = { email_masked: string | null; phone_masked: string | null };
export function maskContact(contact: unknown): MaskedContact {
  const c = contact && typeof contact === "object" ? (contact as Row) : {};
  const email = typeof c["email"] === "string" ? c["email"] : Array.isArray(c["emails"]) && typeof c["emails"][0] === "string" ? c["emails"][0] : null;
  const phone = typeof c["phone"] === "string" ? c["phone"] : Array.isArray(c["phones"]) && typeof c["phones"][0] === "string" ? c["phones"][0] : null;
  return { email_masked: maskEmail(email), phone_masked: maskPhone(phone) };
}
/** A facts / raw object with any destination-looking column masked (the tape profile carries none, the supplement's never reach the facts row — belt and braces for NO_DESTINATION). */
export function scrubDestinations<T extends Row>(o: T): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(o)) out[k] = /e-?mail/i.test(k) ? maskEmail(v) ?? v : /phone|mobile|cell/i.test(k) && typeof v === "string" && /\d{7,}/.test(v.replace(/\D/g, "")) ? maskPhone(v) : v;
  return out as T;
}

export type Homeowner = { party_id: string | null; legal_name: string | null } & MaskedContact;
/** The loan's primary borrower's party, masked (34.2): name, `m…@`, `···1234`. */
export async function homeownersOf(db: Queryable, loanIds: readonly string[]): Promise<Map<string, Homeowner>> {
  if (!loanIds.length) return new Map();
  const rows = await db.query<{ loan_id: string; party_id: string | null; legal_name: string | null; contact: unknown }>(
    `SELECT DISTINCT ON (lb.loan_id) lb.loan_id::text AS loan_id, p.id::text AS party_id, coalesce(p.legal_name, b.legal_name) AS legal_name, p.contact
       FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id LEFT JOIN parties p ON p.id = b.party_id
      WHERE lb.loan_id = ANY($1::uuid[]) ORDER BY lb.loan_id, lb.is_primary DESC, b.created_at`, [loanIds]);
  return new Map(rows.map((r) => [r.loan_id, { party_id: r.party_id, legal_name: r.legal_name, ...maskContact(r.contact) }]));
}

// ---------------------------------------------------------------- 33.1 rule 8: the hold, read from rows
export type Hold = { loan_id: string; servicer_loan_number: string; partner_party_id: string; partner_legal_name: string; last_as_of_date: string; partner_as_of_date: string; not_on_tape_since: string | null };
const HOLD_SQL = `SELECT l.id::text AS loan_id, l.servicer_loan_number, l.partner_party_id::text AS partner_party_id, pp.legal_name AS partner_legal_name, f.last_as_of_date, i.partner_as_of_date,
       (SELECT min(e.occurred_at)::text FROM loan_events e WHERE e.loan_id = l.id AND e.type = 'partner_book.loan.not_on_tape' AND e.payload->>'as_of_date' > f.last_as_of_date) AS not_on_tape_since
  FROM loans l
  JOIN parties pp ON pp.id = l.partner_party_id
  JOIN LATERAL (SELECT max(pf.as_of_date)::text AS last_as_of_date FROM partner_book_facts pf WHERE pf.loan_id = l.id) f ON f.last_as_of_date IS NOT NULL
  JOIN LATERAL (SELECT max(pi.as_of_date)::text AS partner_as_of_date FROM partner_book_imports pi WHERE pi.partner_party_id = l.partner_party_id AND pi.status = 'loaded') i ON i.partner_as_of_date IS NOT NULL
 WHERE l.status = 'monitored' AND f.last_as_of_date < i.partner_as_of_date
   AND ($1::uuid IS NULL OR l.partner_party_id = $1::uuid) AND ($2::uuid IS NULL OR l.id = $2::uuid)
   AND NOT EXISTS (SELECT 1 FROM loan_events k WHERE k.loan_id = l.id AND k.type = 'partner_book.loan.resolved' AND k.payload->>'resolution' = 'keep' AND k.occurred_at > ($3::timestamptz - make_interval(days => $4::int)))
 ORDER BY pp.legal_name, l.servicer_loan_number`;
/** The partner's (or every partner's) monitored loans on hold now (33.1 rule 8 — see the module comment). */
export async function holdsOf(rt: Pick<Runtime, "db" | "clock">, partnerPartyId?: string | null, now: string = rt.clock.now()): Promise<Hold[]> {
  return rt.db.query<Hold>(HOLD_SQL, [isUuid(partnerPartyId) ? partnerPartyId : null, null, now, KEEP_LIFTS_HOLD_DAYS]);
}
export async function holdOf(rt: Pick<Runtime, "db" | "clock">, loanId: string, now: string = rt.clock.now()): Promise<Hold | null> {
  if (!isUuid(loanId)) return null;
  return (await rt.db.query<Hold>(HOLD_SQL, [null, loanId, now, KEEP_LIFTS_HOLD_DAYS]))[0] ?? null;
}

// ---------------------------------------------------------------- the partners (GET …/partners)
export type PartnerSummary = { partner_party_id: string; legal_name: string; loans_monitored: number; on_hold: number; imports: number; last_as_of_date: string | null; next_expected: string | null; tape_clock: { timer_id: string; status: string; due_at: string | null; due_date: string | null; breached_at: string | null } | null; clock_status: "armed" | "breached" | "none"; late: boolean };
/** Each partner with a book: legal name, loans monitored, last as-of, next expected (last + 7 days), the SM_PARTNER_BOOK_TAPE_EXPECTED_7 clock's status. */
export async function partnersOf(rt: Pick<Runtime, "db" | "clock">, now: string = rt.clock.now()): Promise<PartnerSummary[]> {
  const partners = await rt.db.query<{ partner_party_id: string; legal_name: string; last_as_of_date: string | null; imports: string; loans_monitored: string }>(
    `SELECT p.id::text AS partner_party_id, p.legal_name, (SELECT max(i.as_of_date)::text FROM partner_book_imports i WHERE i.partner_party_id = p.id AND i.status = 'loaded') AS last_as_of_date,
            (SELECT count(*)::text FROM partner_book_imports i WHERE i.partner_party_id = p.id) AS imports, (SELECT count(*)::text FROM loans l WHERE l.partner_party_id = p.id AND l.status = 'monitored') AS loans_monitored
       FROM parties p WHERE p.party_type = 'servicer' AND EXISTS (SELECT 1 FROM partner_book_imports i WHERE i.partner_party_id = p.id) ORDER BY p.legal_name`);
  const clocks = await rt.db.query<{ timer_id: string; status: string; due_at: string | null; due_date: string | null; breached_at: string | null; partner_id: string | null }>(
    `SELECT t.id::text AS timer_id, t.status::text AS status, t.due_at::text AS due_at, t.due_date::text AS due_date, t.breached_at::text AS breached_at, e.payload->>'partner_id' AS partner_id
       FROM timers t JOIN loan_events e ON e.id = t.armed_by_event_id WHERE t.code = $1 AND t.status IN ('armed', 'breached') ORDER BY t.armed_at DESC`, [TAPE_CLOCK]);
  const holds = await holdsOf(rt, null, now);
  return partners.map((p) => {
    const c = clocks.find((x) => x.partner_id === p.partner_party_id) ?? null;
    const next = p.last_as_of_date ? addDays(plainDate(p.last_as_of_date), TAPE_EXPECTED_DAYS) : null;
    return { partner_party_id: p.partner_party_id, legal_name: p.legal_name, loans_monitored: Number(p.loans_monitored), on_hold: holds.filter((h) => h.partner_party_id === p.partner_party_id).length, imports: Number(p.imports), last_as_of_date: p.last_as_of_date, next_expected: next,
      tape_clock: c ? { timer_id: c.timer_id, status: c.status, due_at: c.due_at, due_date: c.due_date, breached_at: c.breached_at } : null, clock_status: c ? (c.status === "breached" ? "breached" : "armed") : "none", late: c ? c.status === "breached" : next !== null && next < now.slice(0, 10) };
  });
}

// ---------------------------------------------------------------- the day's bounds and the receipt expectations (ET)
export const dayOf = (nowIso: string): PlainDate => wallClock(Date.parse(nowIso), ET).date;
/** The instant `hhmm` ET on `asOf`, as ISO. */
export const atEt = (asOf: PlainDate, hhmm: string): string => toIso(zonedEpochMs(asOf, hhmm, ET));
/** [start, end) of the ET calendar day as ISO instants. */
export const dayBounds = (asOf: PlainDate): { start: string; end: string } => ({ start: atEt(asOf, "00:00"), end: atEt(addDays(asOf, 1), "00:00") });

// ---------------------------------------------------------------- book.viewed
/** `book.viewed{staff_user_id, partner_id, view}` (global; Outputs) — one per look through the routes. */
export async function recordBookViewed(rt: Runtime, i: { staff_user_id: string | null; partner_id: string | null; view: string; subject?: Record<string, unknown> }, actor: Actor): Promise<void> {
  await rt.uow.run({}, async (ctx) => {
    ctx.events.append({ type: "book.viewed", aggregate: { kind: "partner_book_view", id: i.view }, actor, payload: { staff_user_id: i.staff_user_id, partner_id: i.partner_id, view: i.view, ...(i.subject ?? {}) } });
  }, { clock: rt.clock });
}
