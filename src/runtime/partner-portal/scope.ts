/**
 * 36.1 rule 4 — "Tenant or 404." Every query the partner wrapper runs carries `partner_party_id = session.partner_party_id`,
 * taken from the session and never from a header, a body field or a query string; 34.3's read functions are called with
 * `filter.partner` set to it (never null), and a row whose `partner_party_id` is another tenant's answers `404 NOT_FOUND` —
 * never `403`, never an empty list beside an error (existence is not a signal; 34.2 rule 4). The refused request's log row
 * reads `result = refused`, `refusal_code = NOT_FOUND` with the requested id and no homeowner field (36.1-T3).
 *
 * `bookLoan` (src/runtime/book-ops/loan.ts) takes no filter — it answers a loan by id — so the tenant check is made here on
 * the row it returns, before anything of it reaches the wire; the list reads (36.3–36.5) pass `tenantFilter(session)`.
 */
import { bookLoan, type BookLoan } from "../book-ops/loan.ts";
import type { BookLoansFilter } from "../book-ops/loans.ts";
import type { Runtime } from "../app.ts";
import { PartnerError } from "./roles.ts";

/** What a scoped read needs of the session: the tenant. */
export interface TenantScope { readonly partner_party_id: string }
/** The one refusal a query outside the tenant answers (rule 4): 404 NOT_FOUND, on the wire and on the log row. */
export const notFound = (what: string): PartnerError => new PartnerError(404, "NOT_FOUND", `no such ${what}`);
/** 34.3's `filter.partner` — always the session's tenant, never null (rule 4). */
export const tenantFilter = (scope: TenantScope, more: Omit<BookLoansFilter, "partner"> = {}): BookLoansFilter => ({ ...more, partner: scope.partner_party_id });
/** A row is the tenant's or it does not exist (rule 4). */
export function requireTenant<T extends { readonly partner_party_id: string | null | undefined }>(scope: TenantScope, row: T | null | undefined, what: string): T {
  if (!row || row.partner_party_id !== scope.partner_party_id) throw notFound(what);
  return row;
}
/** GET /v1/partner/book/loans/{id}: 34.3's loan page for the tenant's loan; another tenant's, or none, is 404 (36.1-T3). */
export async function tenantLoan(rt: Runtime, scope: TenantScope, loanId: string, now: string = rt.clock.now()): Promise<BookLoan> {
  const l = await bookLoan(rt, loanId, now);
  if (!l || l.loan.partner_party_id !== scope.partner_party_id) throw notFound("loan");
  return l;
}

/** The `loans` row's link columns (36.5 rules 4–5; 36.6 rule 3): `status`, 30.2's `origination_application_id`, 35.10's `refinanced_by_loan_id`. */
export interface TenantLoanRow { readonly loan_id: string; readonly partner_party_id: string; readonly servicer_loan_number: string; readonly status: string; readonly origination_application_id: string | null; readonly refinanced_by_loan_id: string | null; readonly property_id: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Rule 4 on the `loans` row itself, before any page is built (36.5's loan page, 36.6's serviced route): the row is the tenant's
 * or it does not exist — an unknown id, a malformed id and another tenant's loan answer the same 404. Unlike `tenantLoan`, this
 * read needs no partner_book_facts row, so the new `active` loan 30.2 boarded from the refinance application (a `loans` row with
 * `partner_party_id` = the tenant and `origination_application_id` set, never on a tape) is the tenant's here too (36.5-T4, 36.6-T2).
 */
export async function tenantLoanRow(rt: Runtime, scope: TenantScope, loanId: string): Promise<TenantLoanRow> {
  if (!UUID.test(loanId)) throw notFound("loan");
  const row = (await rt.db.query<TenantLoanRow & Record<string, unknown>>(`SELECT id::text AS loan_id, partner_party_id::text AS partner_party_id, servicer_loan_number, status::text AS status, origination_application_id::text AS origination_application_id, refinanced_by_loan_id::text AS refinanced_by_loan_id, property_id::text AS property_id FROM loans WHERE id = $1`, [loanId]))[0];
  return requireTenant(scope, row, "loan");
}
