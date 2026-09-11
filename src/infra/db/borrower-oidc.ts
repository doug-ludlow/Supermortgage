/**
 * OpenID Connect identities (docs/ux/15-entry-sign-up-and-sign-in.md §3, §6.1 DELTA-12; migration 0116): a borrower party
 * keyed on the provider's stable `(issuer, subject)`. The party is resolved by the verified e-mail on the first sign-in and
 * by `sub` afterwards (a changed e-mail still lands on the same party). The provider's `name` is the party's PROVISIONAL
 * legal name — written the way the identity vendor's extraction is (01 §5 L3; `application_borrowers.prefill` with
 * `source = oidc_google`, `confirmed_at = null`) and on the party row only while the party has no better name than the
 * e-mail it was created from. Nothing here decides policy; src/runtime/borrower/oidc.ts verifies the token first.
 */
import type { Queryable } from "./client.ts";
import { toJson } from "./client.ts";

export interface OidcIdentityRow {
  readonly id: string; readonly party_id: string; readonly issuer: string; readonly subject: string; readonly email: string | null; readonly email_verified: boolean; readonly name: string | null;
  readonly first_seen_at: string; readonly last_seen_at: string; readonly revoked_at: string | null;
}
const COLS = "id, party_id, issuer, subject, email, email_verified, name, first_seen_at, last_seen_at, revoked_at";
export const OIDC_PREFILL_SOURCE = "oidc_google";

export class PgBorrowerOidcRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async bySubject(issuer: string, subject: string, q: Queryable = this.db): Promise<OidcIdentityRow | undefined> {
    const rows = await q.query<OidcIdentityRow & Record<string, unknown>>(`SELECT ${COLS} FROM oidc_identities WHERE issuer = $1 AND subject = $2`, [issuer, subject]);
    return rows[0];
  }
  async ofParty(partyId: string, q: Queryable = this.db): Promise<OidcIdentityRow[]> {
    return q.query<OidcIdentityRow & Record<string, unknown>>(`SELECT ${COLS} FROM oidc_identities WHERE party_id = $1 AND revoked_at IS NULL ORDER BY first_seen_at`, [partyId]);
  }
  /** The row for (issuer, subject): inserted on the first sign-in, refreshed (e-mail, verification, name, last_seen_at) on every later one. */
  async upsert(i: { party_id: string; issuer: string; subject: string; email: string | null; email_verified: boolean; name: string | null; now: string }, q: Queryable = this.db): Promise<{ row: OidcIdentityRow; created: boolean }> {
    const existing = await this.bySubject(i.issuer, i.subject, q);
    if (existing) {
      const rows = await q.query<OidcIdentityRow & Record<string, unknown>>(`UPDATE oidc_identities SET email = $3, email_verified = $4, name = coalesce($5, name), last_seen_at = $6 WHERE issuer = $1 AND subject = $2 RETURNING ${COLS}`, [i.issuer, i.subject, i.email, i.email_verified, i.name, i.now]);
      return { row: rows[0]!, created: false };
    }
    const rows = await q.query<OidcIdentityRow & Record<string, unknown>>(`INSERT INTO oidc_identities (party_id, issuer, subject, email, email_verified, name, first_seen_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${COLS}`, [i.party_id, i.issuer, i.subject, i.email, i.email_verified, i.name, i.now]);
    return { row: rows[0]!, created: true };
  }
  async revoke(id: string, now: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE oidc_identities SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, now]);
  }
  /**
   * The provider's `name` as the party's provisional legal name (the Stripe prefill pattern, 01 §5): on the party row only while its
   * name is the e-mail it was created from (or an earlier provisional name from the same source), and as `prefill.legal_name{source:
   * oidc_google, confirmed_at: null}` on every application_borrowers row of the party that carries no prefilled name yet — the identity
   * ConfirmCard (32.3 E5) is what turns a prefill into a confirmed field; nothing here confirms anything.
   */
  async provisionalName(partyId: string, name: string, now: string, q: Queryable = this.db): Promise<{ party_renamed: boolean; prefilled_rows: number }> {
    const trimmed = name.trim(); if (!trimmed) return { party_renamed: false, prefilled_rows: 0 };
    const renamed = await q.query<{ id: string }>(`UPDATE parties SET legal_name = $2, contact = contact || $3::jsonb WHERE id = $1 AND (lower(legal_name) = lower(coalesce(contact->>'email', '')) OR contact->>'legal_name_source' = $4) AND legal_name IS DISTINCT FROM $2 RETURNING id`, [partyId, trimmed, toJson({ legal_name_source: OIDC_PREFILL_SOURCE }), OIDC_PREFILL_SOURCE]);
    const prefilled = await q.query<{ id: string }>(`UPDATE application_borrowers SET prefill = prefill || $2::jsonb WHERE party_id = $1 AND NOT (prefill ? 'legal_name') RETURNING id`, [partyId, toJson({ legal_name: { value: trimmed, source: OIDC_PREFILL_SOURCE, extracted_at: now, confirmed_at: null } })]);
    return { party_renamed: renamed.length > 0, prefilled_rows: prefilled.length };
  }
}
