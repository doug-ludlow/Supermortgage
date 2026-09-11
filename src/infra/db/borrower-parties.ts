/**
 * Party resolution and scoping for the borrower surface (docs/ux/02-data-contracts.md §6; migration 0111).
 *
 * A borrower is a `parties` row (party_type `borrower`). The subjects a party may read are resolved from the shared
 * tables — never from anything the UI stores: `application_borrowers.party_id` (an application before funding, and the
 * loan it became), `borrowers.party_id` → `loan_borrowers` (a serviced loan), and `loan_parties` rows whose role is one of
 * the scoped roles (confirmed_successor, poa, authorized_third_party, executor). A `potential_successor` sees only 4.4
 * correspondence and therefore no subject here.
 */
import type { Queryable } from "./client.ts";
import { toJson } from "./client.ts";

export type PartyRoleScope = "borrower" | "co_borrower" | "non_occupant_co_borrower" | "non_borrowing_spouse" | "trustee" | "confirmed_successor" | "poa" | "authorized_third_party" | "executor";
export const SCOPED_LOAN_PARTY_ROLES: readonly string[] = ["confirmed_successor", "poa", "authorized_third_party", "executor"];

export interface Subject {
  readonly application_id: string | null;
  readonly loan_id: string | null;
  readonly role: string;
  readonly stage: "origination" | "servicing";
  readonly label: string;
  /** The party's own application_borrowers row on that application (own-only document classes, 02 §1.4). */
  readonly application_borrower_id: string | null;
}
export interface PartyRow { readonly id: string; readonly party_type: string; readonly legal_name: string; readonly contact: Record<string, unknown>; readonly created_at: string; }

const emailOrPhone = (contact: Record<string, unknown>): { emails: string[]; phones: string[] } => {
  const s = (v: unknown): string[] => (typeof v === "string" && v ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { emails: [...s(contact["email"]), ...s(contact["emails"])].map((e) => e.trim().toLowerCase()), phones: [...s(contact["phone"]), ...s(contact["phones"]), ...s(contact["mobile"])].map(normalizePhone) };
};
export const normalizePhone = (p: string): string => { const d = p.replace(/[^\d+]/g, ""); return d.startsWith("+") ? d : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : d; };
export const normalizeDestination = (channel: "sms" | "email", d: string): string => (channel === "email" ? d.trim().toLowerCase() : normalizePhone(d));

export class PgBorrowerPartyRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async get(partyId: string, q: Queryable = this.db): Promise<PartyRow | undefined> {
    const rows = await q.query<PartyRow & Record<string, unknown>>(`SELECT id, party_type, legal_name, contact, created_at FROM parties WHERE id = $1`, [partyId]);
    return rows[0];
  }

  /**
   * The party a one-time code destination belongs to: a party whose contact lists it, else an application borrower whose
   * contact lists it (linked to a new borrower party on the spot), else a new borrower party carrying only the destination.
   * A borrower never authenticates as someone else: the destination is what the code went to.
   */
  async resolveOrCreateByDestination(channel: "sms" | "email", destination: string, q: Queryable = this.db): Promise<{ party: PartyRow; created: boolean; linked_application_borrowers: number }> {
    const dest = normalizeDestination(channel, destination);
    const key = channel === "email" ? "emails" : "phones";
    const parties = await q.query<PartyRow & Record<string, unknown>>(`SELECT id, party_type, legal_name, contact, created_at FROM parties WHERE party_type = 'borrower' ORDER BY created_at`);
    const found = parties.find((p) => emailOrPhone(p.contact)[key].includes(dest));
    if (found) return { party: found, created: false, linked_application_borrowers: await this.linkUnlinkedBorrowers(found.id, channel, dest, q) };
    // an application borrower the intake interview (21.1) created with this contact → their own party
    const abs = await q.query<{ id: string; legal_name: string; contact: Record<string, unknown> }>(`SELECT id, legal_name, contact FROM application_borrowers WHERE party_id IS NULL ORDER BY created_at`);
    const ab = abs.find((b) => emailOrPhone(b.contact)[key].includes(dest));
    const legalName = ab?.legal_name ?? (channel === "email" ? dest : "Borrower (phone)");
    const contact = channel === "email" ? { email: dest } : { phone: dest };
    const rows = await q.query<PartyRow & Record<string, unknown>>(`INSERT INTO parties (party_type, legal_name, contact) VALUES ('borrower', $1, $2::jsonb) RETURNING id, party_type, legal_name, contact, created_at`, [legalName, toJson(contact)]);
    const party = rows[0]!;
    return { party, created: true, linked_application_borrowers: await this.linkUnlinkedBorrowers(party.id, channel, dest, q) };
  }
  /** Every unlinked application borrower whose contact carries the verified destination is this party (the code proved possession). */
  private async linkUnlinkedBorrowers(partyId: string, channel: "sms" | "email", dest: string, q: Queryable): Promise<number> {
    const key = channel === "email" ? "emails" : "phones";
    const abs = await q.query<{ id: string; contact: Record<string, unknown> }>(`SELECT id, contact FROM application_borrowers WHERE party_id IS NULL`);
    let n = 0;
    for (const b of abs) if (emailOrPhone(b.contact)[key].includes(dest)) { await q.query(`UPDATE application_borrowers SET party_id = $2 WHERE id = $1 AND party_id IS NULL`, [b.id, partyId]); n++; }
    return n;
  }
  /** Explicit link (an InviteCard, a test fixture): the application borrower row is this party's. */
  async linkApplicationBorrower(applicationBorrowerId: string, partyId: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE application_borrowers SET party_id = $2 WHERE id = $1`, [applicationBorrowerId, partyId]);
  }
  async linkBorrower(borrowerId: string, partyId: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE borrowers SET party_id = $2 WHERE id = $1`, [borrowerId, partyId]);
  }

  /** 02 §6: every subject the party may read, with the role that grants it. */
  async subjectsOf(partyId: string, q: Queryable = this.db): Promise<Subject[]> {
    const out: Subject[] = [];
    const apps = await q.query<{ ab_id: string; application_id: string; borrower_role: string; loan_id: string | null; transaction_type: string; address_line1: string | null }>(
      `SELECT ab.id AS ab_id, ab.application_id, ab.borrower_role, a.loan_id, a.transaction_type, (SELECT p.address_line1 FROM application_properties p WHERE p.application_id = a.id ORDER BY p.is_subject DESC, p.created_at LIMIT 1) AS address_line1
       FROM application_borrowers ab JOIN applications a ON a.id = ab.application_id WHERE ab.party_id = $1 ORDER BY a.created_at`, [partyId]);
    for (const a of apps) out.push({ application_id: a.application_id, loan_id: a.loan_id, role: a.borrower_role, stage: a.loan_id ? "servicing" : "origination", label: `${a.transaction_type === "purchase" ? "Buying" : "Refinancing"}${a.address_line1 ? ` · ${a.address_line1}` : ""}`, application_borrower_id: a.ab_id });
    const loans = await q.query<{ loan_id: string; role: string; servicer_loan_number: string | null; origination_application_id: string | null }>(
      `SELECT lb.loan_id, lb.role, l.servicer_loan_number, l.origination_application_id FROM borrowers b JOIN loan_borrowers lb ON lb.borrower_id = b.id JOIN loans l ON l.id = lb.loan_id WHERE b.party_id = $1 ORDER BY l.created_at`, [partyId]);
    for (const l of loans) if (!out.some((s) => s.loan_id === l.loan_id)) out.push({ application_id: l.origination_application_id, loan_id: l.loan_id, role: l.role, stage: "servicing", label: `Your loan${l.servicer_loan_number ? ` ····${l.servicer_loan_number.slice(-4)}` : ""}`, application_borrower_id: null });
    const parties = await q.query<{ loan_id: string; role: string; servicer_loan_number: string | null; origination_application_id: string | null }>(
      `SELECT lp.loan_id, lp.role, l.servicer_loan_number, l.origination_application_id FROM loan_parties lp JOIN loans l ON l.id = lp.loan_id WHERE lp.party_id = $1 AND lp.ended_at IS NULL AND lp.role = ANY($2::text[]) ORDER BY lp.started_at`, [partyId, [...SCOPED_LOAN_PARTY_ROLES]]);
    for (const p of parties) if (!out.some((s) => s.loan_id === p.loan_id)) out.push({ application_id: p.origination_application_id, loan_id: p.loan_id, role: p.role, stage: "servicing", label: `Loan${p.servicer_loan_number ? ` ····${p.servicer_loan_number.slice(-4)}` : ""} (${p.role.replace(/_/g, " ")})`, application_borrower_id: null });
    return out;
  }

  /** The party's application_borrowers rows: what L2 (SSN last 4 + DOB) matches against and what L3 prefills. */
  async applicationBorrowersOf(partyId: string, q: Queryable = this.db): Promise<{ id: string; application_id: string; legal_name: string; tin_last4: string | null; date_of_birth: string | null; prefill: Record<string, unknown> }[]> {
    return q.query(`SELECT id, application_id, legal_name, tin_last4, date_of_birth, prefill FROM application_borrowers WHERE party_id = $1 ORDER BY created_at`, [partyId]);
  }
  async applicationBorrowerIds(applicationId: string, q: Queryable = this.db): Promise<string[]> {
    return (await q.query<{ id: string }>(`SELECT id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at, id`, [applicationId])).map((r) => r.id);
  }
  /** L3: the identity vendor's extraction lands as prefill with source=stripe_identity and no confirmed_at (01 §5; O2.1 rule 1). */
  async writePrefill(applicationBorrowerId: string, fields: Record<string, { value: unknown; source: string; extracted_at: string; confirmed_at: null }>, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE application_borrowers SET prefill = prefill || $2::jsonb WHERE id = $1`, [applicationBorrowerId, toJson(fields)]);
  }
}
