/**
 * The L0 lead session's cookie map (docs/ux/15-entry-sign-up-and-sign-in.md §4, §6.1 `lead_tokens`; migration 0117).
 * An opaque token (32 random bytes, base64url) names a 20.3 lead for the anonymous minute; the row keeps only its sha256
 * (the same discipline as `sessions.token_hash`), carries no loan data and no PII, lives 30 days, and records the party
 * the lead was linked to at L1. Nothing here decides policy — src/runtime/borrower/lead-routes.ts reads and links; the
 * 32.14 flow purges the row when the lead expires.
 */
import { randomBytes } from "node:crypto";
import type { Queryable } from "./client.ts";
import { sha256hex } from "./borrower-sessions.ts";

export const LEAD_TOKEN_DAYS = 30;
export interface LeadTokenRow {
  readonly token_hash: string; readonly lead_id: string; readonly partner_party_id: string | null; readonly created_at: string; readonly expires_at: string; readonly last_seen_at: string;
  readonly linked_party_id: string | null; readonly linked_at: string | null; readonly ip: string | null; readonly user_agent: string | null;
}
const COLS = "token_hash, lead_id, partner_party_id, created_at, expires_at, last_seen_at, linked_party_id, linked_at, ip, user_agent";

/** A lead token: 32 random bytes, base64url; the row keeps only its hash. */
export const newLeadToken = (): string => randomBytes(32).toString("base64url");
export const hashLeadToken = (token: string): string => sha256hex(token);
export const daysAfterIso = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

export class PgLeadTokenRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async create(i: { lead_id: string; partner_party_id: string | null; now: string; ip?: string | null; user_agent?: string | null }, q: Queryable = this.db): Promise<{ token: string; row: LeadTokenRow }> {
    const token = newLeadToken();
    const rows = await q.query<LeadTokenRow & Record<string, unknown>>(
      `INSERT INTO lead_tokens (token_hash, lead_id, partner_party_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $4, $6, $7) RETURNING ${COLS}`,
      [hashLeadToken(token), i.lead_id, i.partner_party_id, i.now, daysAfterIso(i.now, LEAD_TOKEN_DAYS), i.ip ?? null, i.user_agent ?? null]);
    return { token, row: rows[0]! };
  }
  /** The row behind a token (any state — the caller judges expiry and linkage); undefined for an unknown token. */
  async byToken(token: string, q: Queryable = this.db): Promise<LeadTokenRow | undefined> {
    return (await q.query<LeadTokenRow & Record<string, unknown>>(`SELECT ${COLS} FROM lead_tokens WHERE token_hash = $1`, [hashLeadToken(token)]))[0];
  }
  async byLead(leadId: string, q: Queryable = this.db): Promise<LeadTokenRow[]> {
    return q.query<LeadTokenRow & Record<string, unknown>>(`SELECT ${COLS} FROM lead_tokens WHERE lead_id = $1 ORDER BY created_at`, [leadId]);
  }
  async touch(tokenHash: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE lead_tokens SET last_seen_at = $2 WHERE token_hash = $1`, [tokenHash, now]);
  }
  /** L1 reached: the lead behind the token is this party's (`lead.linked{party_id}` on the lead is the owning record; this is the cookie's side). */
  async link(tokenHash: string, partyId: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE lead_tokens SET linked_party_id = $2, linked_at = coalesce(linked_at, $3), last_seen_at = $3 WHERE token_hash = $1`, [tokenHash, partyId, now]);
  }
  /** `lead.expired`: every token of the lead is purged (32.14 T19 — an unauthenticated lead leaves no row behind). */
  async purgeByLead(leadId: string, q: Queryable = this.db): Promise<number> {
    return (await q.query<{ token_hash: string }>(`DELETE FROM lead_tokens WHERE lead_id = $1 RETURNING token_hash`, [leadId])).length;
  }
  /** Housekeeping: tokens past their 30 days. */
  async purgeExpired(now: string, q: Queryable = this.db): Promise<number> {
    return (await q.query<{ token_hash: string }>(`DELETE FROM lead_tokens WHERE expires_at <= $1 RETURNING token_hash`, [now])).length;
  }
}
