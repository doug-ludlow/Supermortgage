/**
 * `applications` repository — the origination aggregate before funding (migration 0057; architecture baseline
 * addendum §3). An application is created with its borrowers and subject property, carries the partner (lender of
 * record), the channel and the prior loan it refinances, and is linked to the servicing `loans` row 30.2 creates at
 * funding. Nothing here touches a servicing table.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./client.ts";
import { toJson } from "./client.ts";

export type ApplicationChannel = "refi_trigger" | "organic" | "referral";
export type TransactionType = "purchase" | "limited_cash_out" | "cash_out";
export type Occupancy = "primary" | "second_home" | "investment";

export interface ApplicationBorrowerInput {
  readonly legal_name: string;
  readonly borrower_role?: "borrower" | "co_borrower" | "non_occupant_co_borrower" | "non_borrowing_spouse" | "trustee";
  readonly date_of_birth?: string | null;
  readonly tin_last4?: string | null;
  readonly marital_status?: "married" | "unmarried" | "separated" | null;
  readonly citizenship_status?: "us_citizen" | "permanent_resident" | "non_permanent_resident" | null;
  readonly language_preference?: string | null;
  readonly contact?: Record<string, unknown>;
}
export interface ApplicationPropertyInput {
  readonly address_line1: string; readonly address_line2?: string | null; readonly city: string; readonly state: string; readonly postal_code: string; readonly county?: string | null;
  readonly property_type?: string | null; readonly units?: number | null; readonly estimated_value_cents?: bigint | null;
}
export interface ApplicationInput {
  readonly id?: string;
  readonly partner_party_id: string;
  readonly channel: ApplicationChannel;
  readonly transaction_type: TransactionType;
  readonly occupancy: Occupancy;
  readonly product_code?: string | null;
  readonly intake_channel?: "voice" | "chat" | "web" | "human_agent" | null;
  readonly interview_language?: string | null;
  readonly prior_loan_id?: string | null;
  readonly borrowers: readonly ApplicationBorrowerInput[];
  readonly property?: ApplicationPropertyInput | null;
}
export interface ApplicationRow {
  readonly id: string; readonly partner_party_id: string; readonly channel: ApplicationChannel; readonly transaction_type: TransactionType; readonly occupancy: Occupancy;
  readonly product_code: string | null; readonly status: string; readonly application_date: string | null; readonly trid_application_date: string | null; readonly hmda_application_date: string | null;
  readonly mlo_of_record_id: string | null; readonly mlo_nmlsr_id: string | null; readonly ai_intake_mode: string; readonly intake_channel: string | null; readonly interview_language: string | null;
  readonly six_items: Record<string, unknown>; readonly prior_loan_id: string | null; readonly loan_id: string | null; readonly created_at: string; readonly updated_at: string;
}
export interface ApplicationRecord extends ApplicationRow {
  readonly borrowers: readonly { id: string; borrower_role: string; legal_name: string; borrower_id: string | null }[];
  readonly properties: readonly { id: string; address_line1: string; city: string; state: string; postal_code: string; property_id: string | null }[];
}

const APP_COLS = "id, partner_party_id, channel, transaction_type, occupancy, product_code, status, application_date, trid_application_date, hmda_application_date, mlo_of_record_id, mlo_nmlsr_id, ai_intake_mode, intake_channel, interview_language, six_items, prior_loan_id, loan_id, created_at, updated_at";

export class PgApplicationRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async create(input: ApplicationInput, q: Queryable = this.db): Promise<ApplicationRecord> {
    if (!input.borrowers.length) throw new RangeError("an application needs at least one borrower");
    const id = input.id ?? randomUUID();
    await q.query(
      `INSERT INTO applications (id, partner_party_id, channel, transaction_type, occupancy, product_code, intake_channel, interview_language, prior_loan_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.partner_party_id, input.channel, input.transaction_type, input.occupancy, input.product_code ?? null, input.intake_channel ?? null, input.interview_language ?? null, input.prior_loan_id ?? null]);
    for (const b of input.borrowers) {
      await q.query(
        `INSERT INTO application_borrowers (application_id, borrower_role, legal_name, date_of_birth, tin_last4, marital_status, citizenship_status, language_preference, contact)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [id, b.borrower_role ?? "borrower", b.legal_name, b.date_of_birth ?? null, b.tin_last4 ?? null, b.marital_status ?? null, b.citizenship_status ?? null, b.language_preference ?? null, toJson(b.contact ?? {})]);
    }
    if (input.property) {
      const p = input.property;
      await q.query(
        `INSERT INTO application_properties (application_id, address_line1, address_line2, city, state, postal_code, county, property_type, units, estimated_value_cents, is_subject)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`,
        [id, p.address_line1, p.address_line2 ?? null, p.city, p.state, p.postal_code, p.county ?? null, p.property_type ?? null, p.units ?? null, p.estimated_value_cents ?? null]);
    }
    return (await this.get(id, q))!;
  }

  async get(id: string, q: Queryable = this.db): Promise<ApplicationRecord | undefined> {
    const rows = await q.query<ApplicationRow & Record<string, unknown>>(`SELECT ${APP_COLS} FROM applications WHERE id = $1`, [id]);
    const app = rows[0];
    if (!app) return undefined;
    const borrowers = await q.query<{ id: string; borrower_role: string; legal_name: string; borrower_id: string | null }>(`SELECT id, borrower_role, legal_name, borrower_id FROM application_borrowers WHERE application_id = $1 ORDER BY created_at, id`, [id]);
    const properties = await q.query<{ id: string; address_line1: string; city: string; state: string; postal_code: string; property_id: string | null }>(`SELECT id, address_line1, city, state, postal_code, property_id FROM application_properties WHERE application_id = $1 ORDER BY is_subject DESC, created_at`, [id]);
    return { ...app, borrowers, properties };
  }

  async setStatus(id: string, status: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE applications SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  }

  /** The hand-off (30.2): the servicing row exists; both sides point at each other. */
  async linkLoan(id: string, loanId: string, q: Queryable = this.db): Promise<void> {
    await q.query(`UPDATE applications SET loan_id = $2, updated_at = now() WHERE id = $1`, [id, loanId]);
    await q.query(`UPDATE loans SET origination_application_id = $1 WHERE id = $2`, [id, loanId]);
  }

  async list(limit = 100): Promise<ApplicationRow[]> {
    return this.db.query<ApplicationRow & Record<string, unknown>>(`SELECT ${APP_COLS} FROM applications ORDER BY created_at DESC LIMIT $1`, [limit]);
  }
}
