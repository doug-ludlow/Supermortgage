/**
 * The borrower parties of a serviced loan and the Notice Registry recipients they become — the servicing notices' addressees
 * (7.1 statements, 7.4's Form 1098, 2.3's autodraft notices from the daily unit). Moved here from src/runtime/servicing.ts by 35.5
 * (the daily unit in src/domain/operations-runtime/cashiering-cycle.ts reads them; servicing.ts re-exports them, so its importers
 * are unchanged). Money never appears here; consents are read from the `consents` table as 7.4 records them.
 */
import type { Recipient } from "../notices/channel.ts";
import { plainDate as D } from "../kernel/calendar/date.ts";
import type { Consent, ConsentStatus } from "../domain/notices/esign.ts";
import type { Runtime } from "./app.ts";

type Row = Record<string, unknown>;
export interface ServicingParty { readonly party_id: string; readonly legal_name: string; readonly email: string | null; readonly mailing_address: string | null; readonly esign: Consent | null; readonly irs_estatement: Consent | null; readonly consent_ids: { esign: string | null; irs_estatement: string | null }; }
const consentStatus = (v: unknown): ConsentStatus => { const st = String(v ?? "active"); if (st === "revoked") return "withdrawn"; return (["pending_verification", "active", "suspect", "reconsent_required", "withdrawn", "expired", "evidence_only"].includes(st) ? st : "evidence_only") as ConsentStatus; };
/** Every borrower party on the loan (the application's borrowers once funded; `borrowers.party_id` on a serviced loan) with the property's mailing address and the party's latest E-SIGN / IRS e-statement consents. */
export async function servicingParties(rt: Pick<Runtime, "db">, loanId: string): Promise<ServicingParty[]> {
  const rows = await rt.db.query<{ party_id: string; legal_name: string; contact: Record<string, unknown> | null }>(
    `SELECT DISTINCT ON (x.party_id) x.party_id, x.legal_name, p.contact FROM (
       SELECT ab.party_id, ab.legal_name, ab.created_at FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE a.loan_id = $1 AND ab.party_id IS NOT NULL
       UNION ALL SELECT b.party_id, b.legal_name, b.created_at FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id WHERE lb.loan_id = $1 AND b.party_id IS NOT NULL) x JOIN parties p ON p.id = x.party_id ORDER BY x.party_id, x.created_at`, [loanId]);
  const prop = (await rt.db.query<Row>(`SELECT pr.address_line1, pr.city, pr.state, pr.postal_code FROM loans l JOIN properties pr ON pr.id = l.property_id WHERE l.id = $1`, [loanId]))[0];
  const address = prop ? `${String(prop.address_line1)}, ${String(prop.city)}, ${String(prop.state)} ${String(prop.postal_code)}` : null;
  const consents = rows.length ? await rt.db.query<Row>(`SELECT id, party_id, kind::text AS kind, status, scope, hw_sw_version, captured_at, verified FROM consents WHERE party_id = ANY($1::uuid[]) AND kind IN ('esign', 'irs_estatement') ORDER BY captured_at`, [rows.map((r) => r.party_id)]) : [];
  const consentOf = (partyId: string, kind: string): { consent: Consent | null; id: string | null } => {
    const row = consents.filter((x) => x.party_id === partyId && x.kind === kind).at(-1); if (!row) return { consent: null, id: null };
    const classes = kind === "irs_estatement" ? ["irs_estatement"] : Array.isArray(row.scope) ? (row.scope as string[]) : [];
    return { consent: { party_id: partyId, classes, disclosure_version: String(row.hw_sw_version ?? "2.0"), status: consentStatus(row.status), consented_on: D(String(row.captured_at).slice(0, 10)), soft_bounces_30d: 0 }, id: String(row.id) };
  };
  return rows.map((r) => { const e = consentOf(r.party_id, "esign"); const irs = consentOf(r.party_id, "irs_estatement"); const email = typeof r.contact?.["email"] === "string" ? (r.contact["email"] as string) : null; return { party_id: r.party_id, legal_name: r.legal_name, email, mailing_address: address, esign: e.consent, irs_estatement: irs.consent, consent_ids: { esign: e.id, irs_estatement: irs.id } }; });
}
export const recipientsOf = (parties: readonly ServicingParty[], consent: "esign" | "irs_estatement" = "esign"): Recipient[] => parties.map((p) => ({ partyId: p.party_id, name: p.legal_name, mailingAddress: p.mailing_address, ...(p.email ? { email: p.email } : {}), ...((consent === "irs_estatement" ? p.irs_estatement : p.esign) ? { consent: consent === "irs_estatement" ? p.irs_estatement! : p.esign! } : {}) }));
