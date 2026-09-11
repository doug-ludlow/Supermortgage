/**
 * Loan/party/property/custodial-account rows — the referential spine every
 * other table hangs off. `createFixture` seeds the minimum a test (or a
 * boarding run) needs: a partner party, a property, a loan, and the three
 * custodial accounts cashiering posts to.
 */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import type { Queryable } from "./client.ts";

export interface LoanRow {
  readonly id: string; readonly fnma_loan_number: string; readonly servicer_loan_number: string; readonly partner_party_id: string; readonly property_id: string;
  readonly status: string; readonly instrument_date: PlainDate; readonly original_upb_cents: Cents; readonly original_term_months: number; readonly first_payment_date: PlainDate; readonly maturity_date: PlainDate;
}

export interface FixtureInput {
  readonly fnmaLoanNumber: string;                    // 10 digits
  readonly servicerLoanNumber: string;
  readonly instrumentDate: PlainDate;
  readonly originalUpbCents: Cents;
  readonly originalTermMonths: number;
  readonly firstPaymentDate: PlainDate;
  readonly maturityDate: PlainDate;
  readonly partnerName?: string;
  readonly property?: { line1: string; city: string; state: string; postalCode: string };
  readonly status?: "staged" | "active";
}

export interface Fixture { readonly loanId: string; readonly partnerPartyId: string; readonly propertyId: string; readonly custodial: { clearing: string; pi: string; ti: string }; }

export class PgLoanRepository {
  private readonly db: Queryable;
  constructor(db: Queryable) { this.db = db; }

  async get(id: string): Promise<LoanRow | undefined> {
    const rows = await this.db.query<LoanRow & Record<string, unknown>>(`SELECT id, fnma_loan_number, servicer_loan_number, partner_party_id, property_id, status, instrument_date, original_upb_cents, original_term_months, first_payment_date, maturity_date FROM loans WHERE id = $1`, [id]);
    return rows[0];
  }

  /**
   * `loans.status` projection from the event spine (the row is a read model of `loan_events`; nothing else flips it).
   * 16.2 rule 3 / 16.1: `loan.paid_in_full` retires the row (`paid_off`); 16.2 rule 6: a `payoff.reversed` inside the
   * finality window reopens it (`active`) — after BD2 17:00 ET the reversal is refused upstream (NO_REVERSAL_AFTER_CLOSE),
   * so a closed-period payoff never reactivates. Runs inside the command's transaction (PgUnitOfWork).
   */
  async projectStatus(events: readonly { readonly type: string; readonly loanId?: string }[], q: Queryable = this.db): Promise<void> {
    for (const e of events) {
      if (!e.loanId) continue;
      if (e.type === "loan.paid_in_full") await q.query(`UPDATE loans SET status = 'paid_off' WHERE id = $1 AND status IN ('staged', 'active')`, [e.loanId]);
      else if (e.type === "payoff.reversed") await q.query(`UPDATE loans SET status = 'active' WHERE id = $1 AND status = 'paid_off'`, [e.loanId]);
    }
  }

  async createFixture(f: FixtureInput, q: Queryable = this.db): Promise<Fixture> {
    const partner = await q.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name) VALUES ('servicer', $1) RETURNING id`, [f.partnerName ?? "Test Partner Servicing LLC"]);
    const partnerPartyId = partner[0]!.id;
    const p = f.property ?? { line1: "1 Test St", city: "Testville", state: "TX", postalCode: "75001" };
    const prop = await q.query<{ id: string }>(`INSERT INTO properties (address_line1, city, state, postal_code) VALUES ($1, $2, $3, $4) RETURNING id`, [p.line1, p.city, p.state, p.postalCode]);
    const propertyId = prop[0]!.id;
    const loan = await q.query<{ id: string }>(
      `INSERT INTO loans (fnma_loan_number, servicer_loan_number, partner_party_id, property_id, status, instrument_date, original_upb_cents, original_term_months, first_payment_date, maturity_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [f.fnmaLoanNumber, f.servicerLoanNumber, partnerPartyId, propertyId, f.status ?? "active", f.instrumentDate, f.originalUpbCents, f.originalTermMonths, f.firstPaymentDate, f.maturityDate]);
    const custodial: Record<string, string> = {};
    for (const kind of ["clearing", "pi", "ti"] as const) {
      const c = await q.query<{ id: string }>(`INSERT INTO custodial_accounts (partner_party_id, kind, remittance_type) VALUES ($1, $2, 'A/A') RETURNING id`, [partnerPartyId, kind]);
      custodial[kind] = c[0]!.id;
    }
    return { loanId: loan[0]!.id, partnerPartyId, propertyId, custodial: { clearing: custodial["clearing"]!, pi: custodial["pi"]!, ti: custodial["ti"]! } };
  }
}
