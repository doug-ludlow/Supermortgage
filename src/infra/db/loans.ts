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
   * `loans.status` projection from the event spine (the row is a read model of `loan_events`; nothing else flips it — 35.10
   * NO_DIRECT_STATUS_WRITE: a contract test greps `src/` for any other writer).
   * 16.2 rule 3 / 16.1: `loan.paid_in_full` retires the row (`paid_off`, retired_reason `payoff`); 16.2 rule 6: a `payoff.reversed`
   * inside the finality window reopens it (`active`, the retirement columns cleared) — after BD2 17:00 ET the reversal is refused
   * upstream (NO_REVERSAL_AFTER_CLOSE), so a closed-period payoff never reactivates.
   * 35.10 rule 7: `refinance.prior_loan.retired{mode}` — a `monitored` loan (33.1's row) is retired by the refinance that paid it
   * through the partner (`monitored` → `paid_off`, retired_reason `refinance_partner`); a serviced prior loan was retired by
   * `loan.paid_in_full` already and the event restates the reason (`refinance_same_servicer`). `refinance.new_loan.linked{new_loan_id}`
   * writes `refinanced_by_loan_id`. 33.1 rule 8 / edge cases: `partner_book.loan.resolved{status}` (the analyst's book.resolve) and
   * `partner_book.loan.loaded{status}` (a later tape marking the loan paid or transferred) move a `monitored` row to that status.
   * Runs inside the command's transaction (PgUnitOfWork).
   */
  async projectStatus(events: readonly { readonly type: string; readonly loanId?: string; readonly payload?: Record<string, unknown>; readonly occurredAt?: string }[], q: Queryable = this.db): Promise<void> {
    for (const e of events) {
      if (!e.loanId) continue;
      const p = e.payload ?? {};
      const at = e.occurredAt ?? new Date().toISOString();
      if (e.type === "loan.paid_in_full") await q.query(`UPDATE loans SET status = 'paid_off', retired_at = coalesce(retired_at, $2::timestamptz), retired_reason = coalesce(retired_reason, 'payoff') WHERE id = $1 AND status IN ('staged', 'active')`, [e.loanId, at]);
      else if (e.type === "payoff.reversed") await q.query(`UPDATE loans SET status = 'active', retired_at = NULL, retired_reason = NULL, refinanced_by_loan_id = NULL WHERE id = $1 AND status = 'paid_off'`, [e.loanId]);
      else if (e.type === "refinance.prior_loan.retired") {
        if (p["mode"] === "monitored_partner") await q.query(`UPDATE loans SET status = 'paid_off', retired_at = $2::timestamptz, retired_reason = 'refinance_partner' WHERE id = $1 AND status = 'monitored'`, [e.loanId, at]);
        else await q.query(`UPDATE loans SET retired_at = coalesce(retired_at, $2::timestamptz), retired_reason = 'refinance_same_servicer' WHERE id = $1 AND status = 'paid_off'`, [e.loanId, at]);
      }
      else if (e.type === "refinance.new_loan.linked" && typeof p["new_loan_id"] === "string") await q.query(`UPDATE loans SET refinanced_by_loan_id = $2 WHERE id = $1`, [e.loanId, p["new_loan_id"]]);
      else if ((e.type === "partner_book.loan.resolved" || e.type === "partner_book.loan.loaded") && (p["status"] === "paid_off" || p["status"] === "transferred_out")) await q.query(`UPDATE loans SET status = $2::loan_status WHERE id = $1 AND status = 'monitored'`, [e.loanId, p["status"]]);
    }
  }

  async createFixture(f: FixtureInput, q: Queryable = this.db): Promise<Fixture> {
    const partner = await q.query<{ id: string }>(`INSERT INTO parties (party_type, legal_name, synthetic) VALUES ('servicer', $1, true) RETURNING id`, [f.partnerName ?? "Test Partner Servicing LLC"]);
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
