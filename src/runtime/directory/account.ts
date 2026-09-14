/**
 * 34.2 `directory.account` — the account page (rules 1, 2, 6): the person, their origin (`front door` / `video door` /
 * `partner book: <partner>`, both doors when a partner-book party was linked to a homegrown one — 33.1 rule 3), the first
 * session and the doors used since, the subjects with last-four identifiers, the session history (times, doors, levels —
 * never a token), the credential kinds, the consents with kinds and dates, the partner's latest facts as of their date for a
 * monitored loan (labelled as the partner's), the latest review verdict and the readiness summary (both through
 * src/runtime/borrower/record.ts, the projection the borrower surface reads — the directory projects, it never edits).
 *
 * Masked for the role before it leaves (ROLE_MASK): the level is `maskLevelFor(roles, unmask)` — an ops_analyst is always
 * masked; compliance / officer see the full contact and the SSN last four + date of birth only under an active unmask row
 * (unmask.ts activeUnmaskFields). Never: a full SSN (the encrypted TIN is not read), a credential hash, a session token, a
 * vendor payload. Every look is `directory.viewed{staff_user_id, party_id, section}` (LOG_EVERY_LOOK).
 */
import type { Queryable } from "../../infra/db/client.ts";
import { PgBorrowerUiRepository } from "../../infra/db/borrower-ui.ts";
import type { Actor } from "../../kernel/events/index.ts";
import type { Runtime } from "../app.ts";
import { BorrowerRecordReader, type PartnerBookReview, type ReadinessView } from "../borrower/record.ts";
import { contactView, identityView, lastFour, maskEmail, maskLevelFor, maskPhone, stripSecrets, type ContactView, type MaskLevel } from "./mask.ts";
import { partyScope, type PartyScope } from "./scope.ts";
import { originsOf } from "./search.ts";

export const DOOR_LABELS: Readonly<Record<string, string>> = { otp_phone: "one-time code (SMS)", otp_email: "one-time code (e-mail)", passkey: "passkey", oidc_google: "Google sign-in", password: "password", video: "video door" };
/** The partner's facts the account page summarizes (33.1's fact keys; identifiers, status and the tape's figures — the raw tape never). */
export const PARTNER_FACT_KEYS: readonly string[] = ["servicing_status", "mba_delinquency_status", "pay_string", "next_due_date", "last_payment_date", "upb_cents", "note_rate_pct", "pi_cents", "ti_cents", "total_due_cents", "remaining_term_months", "maturity_date", "occupancy", "property_type", "loan_type", "property_city", "property_state", "fc_status", "fc_referral_date", "bk_chapter", "bk_status", "escrow_balance_cents", "modification_flag"];

export interface DirectorySession { session_id: string; level: string; door: string; auth_method: string; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null; open: boolean }
export interface DirectoryConsent { consent_id: string; loan_id: string; kind: string; granted: boolean; provenance: string; verified: boolean; captured_at: string; revoked_at: string | null; channel: string | null }
export interface DirectoryInvitation { invitation_id: string; loan_id: string; kind: string; channel: string; sent_at: string; bounced_at: string | null }
export interface DirectorySubject {
  loan_id: string | null; application_id: string | null; loan_last4: string | null; application_last4: string | null; label: string; role: string; stage: "origination" | "servicing"; loan_status: string | null; application_status: string | null;
  status_badge: string | null; state_source: string | null;
  monitored: boolean;
  partner: { partner_party_id: string | null; partner_name: string | null; as_of_date: string | null; label: "the partner's facts"; facts: Record<string, unknown> | null } | null;
  review: Omit<PartnerBookReview, "watch_rate_pct"> | null;
  readiness: ReadinessView | null;
}
export interface DirectoryAccount {
  party_id: string; legal_name: string; created_at: string;
  origin: string; origin_kind: "front_door" | "video_door" | "partner_book"; doors: string[]; partner: { partner_party_id: string; partner_name: string } | null;
  status: "invited" | "active"; first_session_at: string | null; last_session_at: string | null;
  contact: ContactView; identity: ReturnType<typeof identityView>;
  credential_kinds: string[];
  subjects: DirectorySubject[]; sessions: DirectorySession[]; consents: DirectoryConsent[]; invitations: DirectoryInvitation[];
  mask: MaskLevel; roles: string[]; as_of: string;
}
export interface DirectoryAccountOptions { readonly roles: readonly string[]; readonly unmask?: readonly string[]; readonly now?: string }

const doorOf = (m: string): string => DOOR_LABELS[m] ?? m;

async function sessionsOf(db: Queryable, partyId: string, now: string): Promise<DirectorySession[]> {
  const rows = await db.query<{ session_id: string; level: string; auth_method: string; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null }>(
    `SELECT session_id::text AS session_id, level, auth_method, created_at, last_seen_at, expires_at, revoked_at FROM sessions WHERE party_id = $1 ORDER BY created_at, session_id`, [partyId]);
  return rows.map((s) => ({ session_id: s.session_id, level: s.level, door: doorOf(s.auth_method), auth_method: s.auth_method, created_at: s.created_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at, revoked_at: s.revoked_at, open: !s.revoked_at && s.expires_at > now }));
}
async function credentialKindsOf(db: Queryable, partyId: string): Promise<string[]> {
  const out: string[] = [];
  if ((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM party_credentials WHERE party_id = $1`, [partyId]))[0]?.n !== "0") out.push("password");
  if ((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM passkey_credentials WHERE party_id = $1 AND revoked_at IS NULL`, [partyId]))[0]?.n !== "0") out.push("passkey");
  if ((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM oidc_identities WHERE party_id = $1`, [partyId]))[0]?.n !== "0") out.push("oidc_google");
  return out;
}
async function consentsOf(db: Queryable, scope: PartyScope, level: MaskLevel): Promise<DirectoryConsent[]> {
  if (!scope.borrower_ids.length && !scope.loan_ids.length) return [];
  const rows = await db.query<{ id: string; loan_id: string; kind: string; granted: boolean; provenance: string; verified: boolean; captured_at: string; revoked_at: string | null; channel_identifier: string | null }>(
    `SELECT id::text AS id, loan_id::text AS loan_id, kind::text AS kind, granted, provenance::text AS provenance, verified, captured_at, revoked_at, channel_identifier FROM consents
     WHERE (borrower_id = ANY($1::uuid[])) OR (borrower_id IS NULL AND loan_id = ANY($2::uuid[])) ORDER BY captured_at, id`, [scope.borrower_ids, scope.loan_ids]);
  return rows.map((c) => ({ consent_id: c.id, loan_id: c.loan_id, kind: c.kind, granted: c.granted, provenance: c.provenance, verified: c.verified, captured_at: c.captured_at, revoked_at: c.revoked_at, channel: c.channel_identifier ? (level.contact ? c.channel_identifier : c.channel_identifier.includes("@") ? maskEmail(c.channel_identifier) : maskPhone(c.channel_identifier)) : null }));
}
async function invitationsOf(db: Queryable, partyId: string): Promise<DirectoryInvitation[]> {
  const rows = await db.query<{ id: string; loan_id: string; kind: string; channel: string; sent_at: string; bounced_at: string | null }>(`SELECT id::text AS id, loan_id::text AS loan_id, kind, channel, sent_at, bounced_at FROM partner_book_invitations WHERE party_id = $1 ORDER BY sent_at, id`, [partyId]);
  return rows.map((r) => ({ invitation_id: r.id, loan_id: r.loan_id, kind: r.kind, channel: r.channel, sent_at: r.sent_at, bounced_at: r.bounced_at }));
}
async function identityRows(db: Queryable, scope: PartyScope): Promise<{ tin_last4: string | null; date_of_birth: string | null; source: string }[]> {
  const out: { tin_last4: string | null; date_of_birth: string | null; source: string }[] = [];
  if (scope.borrower_ids.length) for (const b of await db.query<{ tin_last4: string | null; date_of_birth: string | null; partner: boolean }>(`SELECT b.tin_last4, b.date_of_birth::text AS date_of_birth, EXISTS (SELECT 1 FROM loan_borrowers lb JOIN loans l ON l.id = lb.loan_id WHERE lb.borrower_id = b.id AND l.partner_party_id IS NOT NULL) AS partner FROM borrowers b WHERE b.id = ANY($1::uuid[]) ORDER BY b.created_at`, [scope.borrower_ids])) out.push({ tin_last4: b.tin_last4, date_of_birth: b.date_of_birth, source: b.partner ? "partner supplement" : "servicing record" });
  if (scope.application_borrower_ids.length) for (const a of await db.query<{ tin_last4: string | null; date_of_birth: string | null }>(`SELECT tin_last4, date_of_birth::text AS date_of_birth FROM application_borrowers WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [scope.application_borrower_ids])) out.push({ tin_last4: a.tin_last4, date_of_birth: a.date_of_birth, source: "application" });
  return out;
}
/** The partner's latest facts row of a monitored loan, reduced to the summary keys (the tape's raw cells never). */
async function partnerFacts(db: Queryable, loanId: string): Promise<{ partner_party_id: string | null; partner_name: string | null; as_of_date: string | null; facts: Record<string, unknown> | null }> {
  const row = (await db.query<{ as_of_date: string; facts: Record<string, unknown>; partner_party_id: string; partner_name: string | null }>(`SELECT f.as_of_date::text AS as_of_date, f.facts, f.partner_party_id::text AS partner_party_id, p.legal_name AS partner_name FROM partner_book_facts f LEFT JOIN parties p ON p.id = f.partner_party_id WHERE f.loan_id = $1 ORDER BY f.as_of_date DESC, f.created_at DESC LIMIT 1`, [loanId]))[0];
  if (!row) return { partner_party_id: null, partner_name: null, as_of_date: null, facts: null };
  const facts: Record<string, unknown> = {};
  for (const k of PARTNER_FACT_KEYS) if (row.facts[k] !== undefined && row.facts[k] !== null) facts[k] = row.facts[k];
  return { partner_party_id: row.partner_party_id, partner_name: row.partner_name, as_of_date: row.as_of_date, facts };
}

/** The subjects with their status badge and — for a monitored loan — the partner's facts, the review and the readiness through the borrower record reader. */
async function subjectsOf(rt: Runtime, scope: PartyScope, asOf: string): Promise<DirectorySubject[]> {
  const reader = new BorrowerRecordReader(rt.db);
  const cards = await new PgBorrowerUiRepository(rt.db).cardsOf(scope.party.id);
  const out: DirectorySubject[] = [];
  for (const s of scope.subjects) {
    const loan = s.loan_id ? (await rt.db.query<{ status: string; servicer_loan_number: string | null; partner_party_id: string | null }>(`SELECT status::text AS status, servicer_loan_number, partner_party_id::text AS partner_party_id FROM loans WHERE id = $1`, [s.loan_id]))[0] ?? null : null;
    const app = s.application_id ? (await rt.db.query<{ status: string | null }>(`SELECT status::text AS status FROM applications WHERE id = $1`, [s.application_id]))[0] ?? null : null;
    const monitored = loan?.status === "monitored";
    let badge: string | null = null; let state_source: string | null = null; let review: DirectorySubject["review"] = null; let readiness: ReadinessView | null = null;
    try {
      const rec = await reader.record({ id: scope.party.id, legal_name: scope.party.legal_name }, s, cards, asOf);
      badge = rec.status.badge; state_source = rec.status.state_source;
      if (rec.partner_book?.review) { const { watch_rate_pct: _drop, ...rest } = rec.partner_book.review; review = rest; }
      readiness = rec.partner_book?.readiness ?? rec.readiness ?? null;
    } catch (e) { rt.logger?.warn("directory: record projection failed for a subject", { party_id: scope.party.id, loan_id: s.loan_id, application_id: s.application_id, error: e instanceof Error ? e.message : String(e) }); }
    const partner = monitored && s.loan_id ? { ...(await partnerFacts(rt.db, s.loan_id)), label: "the partner's facts" as const } : null;
    out.push({ loan_id: s.loan_id, application_id: s.application_id, loan_last4: lastFour(loan?.servicer_loan_number), application_last4: lastFour(s.application_id), label: s.label, role: s.role, stage: s.stage, loan_status: loan?.status ?? null, application_status: app?.status ?? null, status_badge: badge, state_source, monitored, partner, review, readiness });
  }
  return out;
}

/** The projection (no log) — `directoryAccountLogged` below adds the `directory.viewed` event. Null when the id is not a borrower party. */
export async function directoryAccount(rt: Runtime, partyId: string, opts: DirectoryAccountOptions): Promise<DirectoryAccount | null> {
  const scope = await partyScope(rt.db, partyId);
  if (!scope) return null;
  const now = opts.now ?? rt.clock.now();
  const level = maskLevelFor(opts.roles, opts.unmask ?? []);
  const [sessions, credential_kinds, consents, invitations, identity, origins, subjects] = await Promise.all([
    sessionsOf(rt.db, partyId, now), credentialKindsOf(rt.db, partyId), consentsOf(rt.db, scope, level), invitationsOf(rt.db, partyId), identityRows(rt.db, scope), originsOf(rt.db, [partyId]), subjectsOf(rt, scope, now)]);
  const o = origins.get(partyId)!;
  // rule 1 / edge case 2: the doors — the partner book when the party holds a partner's loan, the front door when they hold a credential, an application or a non-video session, the video door when a session came through it
  const doors: string[] = [];
  if (o.origin === "partner_book") doors.push(`partner book: ${o.partner_name ?? ""}`.trim());
  if (sessions.some((s) => s.auth_method === "video")) doors.push("video door");
  if (credential_kinds.length || scope.application_ids.length || sessions.some((s) => s.auth_method !== "video")) doors.push("front door");
  if (!doors.length) doors.push(o.origin === "video_door" ? "video door" : "front door");
  const origin = o.origin === "partner_book" ? `partner book: ${o.partner_name ?? ""}`.trim() : o.origin === "video_door" ? "video door" : "front door";
  const account: DirectoryAccount = {
    party_id: partyId, legal_name: scope.party.legal_name, created_at: scope.party.created_at,
    origin, origin_kind: o.origin, doors: [...new Set(doors)], partner: o.partner_party_id ? { partner_party_id: o.partner_party_id, partner_name: o.partner_name ?? "" } : null,
    status: sessions.length ? "active" : "invited", first_session_at: sessions[0]?.created_at ?? null, last_session_at: sessions.at(-1)?.created_at ?? null,
    contact: contactView(scope.party.contact, level), identity: identityView(identity, level), credential_kinds,
    subjects, sessions, consents, invitations, mask: level, roles: [...opts.roles], as_of: now,
  };
  return stripSecrets(account);
}

export interface DirectoryLookInput { readonly staff_user_id: string; readonly session_id?: string | null }
/** The account on the bus's behalf: the projection plus `directory.viewed{staff_user_id, party_id, section: account}` (global; ids only). */
export async function directoryAccountLogged(rt: Runtime, partyId: string, opts: DirectoryAccountOptions, look: DirectoryLookInput, actor: Actor): Promise<(DirectoryAccount & { event_id: string | null }) | null> {
  const a = await directoryAccount(rt, partyId, opts);
  if (!a) return null;
  const w = await rt.uow.run({}, async (ctx) => { ctx.events.append({ type: "directory.viewed", aggregate: { kind: "party", id: partyId }, actor, payload: { staff_user_id: look.staff_user_id, ...(look.session_id ? { session_id: look.session_id } : {}), party_id: partyId, section: "account", unmasked: [...(opts.unmask ?? [])].filter((f) => (f === "contact" ? a.mask.contact : f === "identity" ? a.mask.identity : false)) } }); }, { clock: rt.clock });
  return { ...a, event_id: w.events[0]?.id ?? null };
}
