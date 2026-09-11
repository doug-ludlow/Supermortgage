/**
 * Borrower identity policy (docs/ux/01-foundations.md §5): levels L1/L2/L3 on `sessions`; bearer tokens; 30-minute idle
 * expiry before funding and 7 days with a passkey in servicing; the fresh-L1 rule (money movement needs a one-time code
 * verified within the last 10 minutes) as a reusable guard; and party scoping (02 §6) — every read resolves the
 * session's party to its subjects and refuses anything else. No party ever authenticates for another.
 */
import type { IncomingMessage } from "node:http";
import type { Queryable } from "../../infra/db/client.ts";
import { PgBorrowerSessionRepository, type SessionLevel, type SessionRow, type AuthMethod } from "../../infra/db/borrower-sessions.ts";
import { PgBorrowerPartyRepository, type PartyRow, type Subject } from "../../infra/db/borrower-parties.ts";
import { BorrowerError } from "./errors.ts";

export const IDLE_MINUTES_PRE_FUNDING = 30;
export const PASSKEY_SERVICING_DAYS = 7;
export const FRESH_L1_MINUTES = 10;
export const OTP_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const LEVEL_RANK: Readonly<Record<SessionLevel, number>> = { L1: 1, L2: 2, L3: 3 };

export const minutesAfter = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
export const daysAfter = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

/** 01 §5: a passkey session on a serviced loan lives 7 days; everything else expires 30 minutes after the last activity. */
export function sessionExpiry(authMethod: AuthMethod, subjects: readonly Subject[], now: string): string {
  const servicing = subjects.some((s) => s.stage === "servicing");
  return authMethod === "passkey" && servicing ? daysAfter(now, PASSKEY_SERVICING_DAYS) : minutesAfter(now, IDLE_MINUTES_PRE_FUNDING);
}
/** The fresh-L1 rule as a predicate: a one-time code verified within the last 10 minutes. */
export function hasFreshL1(session: Pick<SessionRow, "last_l1_at">, now: string): boolean {
  return session.last_l1_at !== null && Date.parse(session.last_l1_at) >= Date.parse(now) - FRESH_L1_MINUTES * 60_000 && Date.parse(session.last_l1_at) <= Date.parse(now) + 60_000;
}
/** The guard every money-movement command (payment, autopay change, payoff wire instructions view, PII reveal) calls first. */
export function requireFreshL1(session: Pick<SessionRow, "last_l1_at">, now: string): void {
  if (!hasFreshL1(session, now)) throw new BorrowerError(403, "FRESH_L1_REQUIRED", undefined, `a one-time code verified within ${FRESH_L1_MINUTES} minutes is required`);
}
export function requireLevel(session: Pick<SessionRow, "level">, level: SessionLevel): void {
  if (LEVEL_RANK[session.level] < LEVEL_RANK[level]) throw new BorrowerError(403, "LEVEL_REQUIRED", undefined, `${level} required; session is ${session.level}`);
}

/** What an authenticated borrower request carries: the live session, its party and the subjects the party may read. */
export interface BorrowerContext {
  readonly session: SessionRow;
  readonly party: PartyRow;
  readonly subjects: readonly Subject[];
  readonly token: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}
export const bearerOf = (req: IncomingMessage): string => { const h = String(req.headers["authorization"] ?? ""); return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : ""; };
export const ipOf = (req: IncomingMessage): string | null => { const f = req.headers["x-forwarded-for"]; const s = Array.isArray(f) ? f[0] : f; return (s ? s.split(",")[0]!.trim() : req.socket?.remoteAddress) ?? null; };
export const userAgentOf = (req: IncomingMessage): string | null => { const ua = req.headers["user-agent"]; return typeof ua === "string" ? ua.slice(0, 512) : null; };

export class BorrowerAuth {
  readonly sessions: PgBorrowerSessionRepository;
  readonly parties: PgBorrowerPartyRepository;
  constructor(db: Queryable) { this.sessions = new PgBorrowerSessionRepository(db); this.parties = new PgBorrowerPartyRepository(db); }

  /** Resolve the bearer token to a live session (401 AUTH_REQUIRED / SESSION_EXPIRED), touch it, and load the party's scope. */
  async authenticate(req: IncomingMessage, now: string): Promise<BorrowerContext> {
    const token = bearerOf(req);
    if (!token) throw new BorrowerError(401, "AUTH_REQUIRED");
    const session = await this.sessions.byToken(token);
    if (!session) throw new BorrowerError(401, "AUTH_REQUIRED");
    if (session.revoked_at || Date.parse(session.expires_at) <= Date.parse(now)) throw new BorrowerError(401, "SESSION_EXPIRED");
    const [party, subjects] = await Promise.all([this.parties.get(session.party_id), this.parties.subjectsOf(session.party_id)]);
    if (!party) throw new BorrowerError(401, "AUTH_REQUIRED");
    const expiresAt = sessionExpiry(session.auth_method, subjects, now);
    await this.sessions.touch(session.session_id, now, expiresAt);
    return { session: { ...session, last_seen_at: now, expires_at: expiresAt }, party, subjects, token, ip: ipOf(req), userAgent: userAgentOf(req) };
  }

  /** A new session after an L1 authentication; a party's scope decides the expiry policy. */
  async openSession(i: { party_id: string; auth_method: AuthMethod; now: string; otp: boolean; passkey_id?: string | null; ip?: string | null; user_agent?: string | null; level?: SessionLevel }): Promise<{ session: SessionRow; token: string; subjects: readonly Subject[]; party: PartyRow }> {
    const [party, subjects] = await Promise.all([this.parties.get(i.party_id), this.parties.subjectsOf(i.party_id)]);
    if (!party) throw new BorrowerError(401, "AUTH_REQUIRED");
    const r = await this.sessions.createSession({ party_id: i.party_id, level: i.level ?? "L1", auth_method: i.auth_method, now: i.now, expires_at: sessionExpiry(i.auth_method, subjects, i.now), last_l1_at: i.otp ? i.now : null, passkey_id: i.passkey_id ?? null, ip: i.ip ?? null, user_agent: i.user_agent ?? null });
    return { ...r, subjects, party };
  }
}

/** 02 §6 party scoping: the subject must be one the party may read, or the read is refused (403 PARTY_SCOPE) — never a 404 that would confirm existence. */
export function assertSubject(ctx: BorrowerContext, subject: { application_id?: string | null; loan_id?: string | null }): Subject {
  const found = ctx.subjects.find((s) => (subject.application_id && s.application_id === subject.application_id) || (subject.loan_id && s.loan_id === subject.loan_id));
  if (!found) throw new BorrowerError(403, "PARTY_SCOPE", undefined, "the subject is not on this party's record");
  return found;
}
