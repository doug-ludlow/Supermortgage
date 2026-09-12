/**
 * The partner (the lender/creditor) an entry names when no application names one — 32.14 DELTA-15, docs/ux/17 §2.0.
 *
 * Supermortgage is the subservicer and the assistant's operator; it is never the lender. The servicing batch keeps a
 * `servicer` party named "Supermortgage" (src/runtime/transfers.ts) for its custodial accounts, so the "newest servicer
 * party" fallback of the first build could pick Supermortgage itself and the disclosure line then read "working for
 * Supermortgage, your lender". This resolver is the one place the fallback lives and it refuses that party by name:
 * the configured `BORROWER_DEFAULT_PARTNER_ID` when set (any non-borrower party), else the newest servicer party that is
 * not Supermortgage, else null — the caller refuses (503 NOT_WIRED) or seeds a FAKE demo partner; nothing invents one.
 */
import type { Queryable } from "../../infra/db/client.ts";

export type PartnerParty = { id: string; legal_name: string };
type Db = Queryable;

export const SUPERMORTGAGE_PARTY_NAME = "Supermortgage";
export const isSupermortgage = (legalName: string | null | undefined): boolean => (legalName ?? "").trim().toLowerCase() === SUPERMORTGAGE_PARTY_NAME.toLowerCase();
const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** A named party as the partner: any non-borrower party by id, never Supermortgage itself. */
export async function partnerById(db: Db, id: string | null | undefined): Promise<PartnerParty | null> {
  const wanted = (id ?? "").trim();
  if (!isUuid(wanted)) return null;
  const row = (await db.query<PartnerParty>(`SELECT id, legal_name FROM parties WHERE id = $1 AND party_type <> 'borrower'`, [wanted]))[0];
  return row && !isSupermortgage(row.legal_name) ? row : null;
}

/** The configured partner, else the newest servicer party that is not Supermortgage, else null. */
export async function entryPartner(db: Db, configuredId: string | null | undefined): Promise<PartnerParty | null> {
  const configured = await partnerById(db, configuredId);
  if (configured) return configured;
  if ((configuredId ?? "").trim()) return null;   // configured but missing: refuse rather than guess (DELTA-15)
  return (await db.query<PartnerParty>(`SELECT id, legal_name FROM parties WHERE party_type = 'servicer' AND lower(legal_name) <> lower($1) ORDER BY created_at DESC LIMIT 1`, [SUPERMORTGAGE_PARTY_NAME]))[0] ?? null;
}
