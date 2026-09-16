/**
 * §35.10 rule 3 — inputs come FROM THE RECORD. The pass derives every input the owning sections' tools take: the prior
 * loan's UPB from the `principal` ledger balance, the note rate from the current `loan_terms`, the paid-through installment
 * from 2.x's own cash-state reader (the last satisfied installment: 16.1's `lpi_due`, from which interest accrues), the
 * state from `properties`, the escrow balance and suspense from the ledger, the custodial ids from `custodial_accounts`,
 * the investor facts from 29.4's `loan.purchased` / 30.1's `loan.investor_updated`, the partner's tape terms from 33.1's
 * `partner_book_facts`, the projected disbursement date from 26.3's funding calendar, the settlement statement's payoff
 * line from the classified `documents` row 26.3's `funding.disbursement.confirmed` names, the borrower's consent from 30.3's
 * row. A hosted call that supplies any of these is refused (NO_CLIENT_STATE — src/app/tools/section35-10.ts).
 */
import type { Queryable } from "../../../infra/db/client.ts";
import type { EntityStore } from "../../../app/tools.ts";
import type { DomainEvent } from "../../../kernel/events/index.ts";
import { plainDate as D, addDays, addMonths, type PlainDate } from "../../../kernel/calendar/date.ts";
import type { Cents } from "../../../kernel/money/cents.ts";
import type { PartnerLoanTerms } from "../../../infra/integrations/partner-payoff.ts";

type Row = Record<string, unknown>;
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v).replace(/\.\d+$/, "")));
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
export const pl = (e: DomainEvent): Row => e.payload as Row;

export interface CashStateFacts { readonly lpi_date: PlainDate | null; readonly note_rate_pct: string; readonly custodial: { clearing: string; pi: string; ti: string } | null; readonly upb_cents: Cents; }
export interface RecordIo { readonly q: Queryable; readonly store: EntityStore; readonly events: readonly DomainEvent[]; /** 2.x's own cash-state reader (src/runtime/servicing.ts loanCashState), the platform's view of the installments */ readonly cash: (loanId: string, asOf: PlainDate) => Promise<CashStateFacts>; }

export interface PriorLoanFacts {
  readonly loan_id: string; readonly fnma_loan_number: string | null; readonly servicer_loan_number: string; readonly partner_party_id: string; readonly partner_servicer_number: string | null; readonly partner_legal_name: string; readonly property_id: string; readonly status: string; readonly first_payment_date: PlainDate; readonly instrument_date: PlainDate; readonly min: string | null; readonly mers_eligible: boolean;
  readonly state: string; readonly county: string | null; readonly property_address: string;
  readonly note_rate_pct: string; readonly escrowed: boolean; readonly remittance_type: "AA" | "SA" | "SS"; readonly escrow_payment_cents: Cents;
  readonly upb_cents: Cents; readonly escrow_balance_cents: Cents; readonly suspense_cents: Cents; readonly late_charges_cents: Cents; readonly other_fees_cents: Cents; readonly interest_due_cents: Cents;
  readonly lpi_due: PlainDate | null; readonly custodial: { clearing: string; pi: string; ti: string } | null; readonly ti_prepurchase_id: string | null;
  readonly purchased: { pass_through_rate: string; purchase_date: PlainDate | null } | null; readonly wire_instruction_version_id: string | null; readonly borrower_names: readonly string[];
}
export async function priorLoanFacts(io: RecordIo, loanId: string, asOf: PlainDate): Promise<PriorLoanFacts> {
  const loan = (await io.q.query<Row>(`SELECT l.id::text AS id, l.fnma_loan_number, l.servicer_loan_number, l.partner_party_id::text AS partner_party_id, l.property_id::text AS property_id, l.status::text AS status, l.first_payment_date::text AS first_payment_date, l.instrument_date::text AS instrument_date, l.min, l.mers_eligible,
      p.state, p.county, p.address_line1, p.city, p.postal_code, pa.servicer_number, pa.legal_name
      FROM loans l JOIN properties p ON p.id = l.property_id JOIN parties pa ON pa.id = l.partner_party_id WHERE l.id = $1`, [loanId]))[0];
  if (!loan) throw new RangeError(`no loans row ${loanId}`);
  const terms = (await io.q.query<Row>(`SELECT note_rate_bps, escrowed, remittance_type::text AS remittance_type, escrow_payment_cents FROM loan_terms WHERE loan_id = $1 ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [loanId]))[0];
  const bal = await io.q.query<{ account: string; s: string }>(`SELECT account, sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND loan_id = $1 GROUP BY account`, [loanId]);
  const of = (a: string): Cents => c(bal.find((r) => r.account === a)?.s ?? "0");
  const cash = await io.cash(loanId, asOf);
  const rate = terms ? (Number(terms["note_rate_bps"]) / 10_000).toFixed(3) : cash.note_rate_pct;
  const remit = String(terms?.["remittance_type"] ?? "A/A").replace("/", "").toUpperCase() as "AA" | "SA" | "SS";
  const tiPre = (await io.q.query<{ id: string }>(`SELECT id::text AS id FROM custodial_accounts WHERE partner_party_id = $1 AND kind = 'ti_prepurchase' ORDER BY created_at LIMIT 1`, [String(loan["partner_party_id"])]))[0]?.id ?? null;
  const names = (await io.q.query<{ n: string }>(`SELECT b.legal_name AS n FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = $1 ORDER BY lb.is_primary DESC, b.legal_name`, [loanId])).map((r) => r.n);
  // the investor facts: 29.4's loan.purchased (pass_through_rate) or 30.1's loan.investor_updated{investor_loan_position.fnma_ptr}; absent → not purchased (the warehouse advance is repaid by 27.2)
  const mine = io.events.filter((e) => e.loanId === loanId);
  const purchasedEv = [...mine].reverse().find((e) => e.type === "loan.purchased") ?? null;
  const investorEv = [...mine].reverse().find((e) => e.type === "loan.investor_updated") ?? null;
  const ptr = s(purchasedEv ? pl(purchasedEv)["pass_through_rate"] : null) ?? s(investorEv ? (pl(investorEv)["investor_loan_position"] as Row | undefined)?.["fnma_ptr"] : null) ?? s(investorEv ? (pl(investorEv)["loan_terms"] as Row | undefined)?.["pass_through_rate"] : null);
  const purchased = ptr && (loan["fnma_loan_number"] || investorEv) ? { pass_through_rate: ptr, purchase_date: dateOf(purchasedEv ? pl(purchasedEv)["purchase_date"] : investorEv ? pl(investorEv)["advice_date"] : null) } : null;
  // 16.1's vault-backed wire instruction (an officer-rotated active version; the statement renders only that version — 16.1-T13)
  const wire = [...io.store.list("payoff_wire_instructions", (d) => d["status"] === "active")].sort((a, b) => String(b.data["effective_from"] ?? "").localeCompare(String(a.data["effective_from"] ?? "")))[0] ?? null;
  return {
    loan_id: loanId, fnma_loan_number: s(loan["fnma_loan_number"]), servicer_loan_number: String(loan["servicer_loan_number"]), partner_party_id: String(loan["partner_party_id"]), partner_servicer_number: s(loan["servicer_number"]), partner_legal_name: String(loan["legal_name"]), property_id: String(loan["property_id"]), status: String(loan["status"]),
    first_payment_date: D(String(loan["first_payment_date"]).slice(0, 10)), instrument_date: D(String(loan["instrument_date"]).slice(0, 10)), min: s(loan["min"]), mers_eligible: loan["mers_eligible"] === true,
    state: String(loan["state"]), county: s(loan["county"]), property_address: `${String(loan["address_line1"])}, ${String(loan["city"])}, ${String(loan["state"])} ${String(loan["postal_code"])}`,
    note_rate_pct: rate, escrowed: terms ? terms["escrowed"] === true : true, remittance_type: remit === "SA" || remit === "SS" ? remit : "AA", escrow_payment_cents: c(terms?.["escrow_payment_cents"]),
    upb_cents: of("principal"), escrow_balance_cents: -of("escrow"), suspense_cents: -of("suspense_unapplied"), late_charges_cents: of("late_charges"), other_fees_cents: of("other_fees") + of("nsf_fees"), interest_due_cents: of("interest_due"),
    lpi_due: cash.lpi_date, custodial: cash.custodial, ti_prepurchase_id: tiPre, purchased, wire_instruction_version_id: wire ? wire.id : null, borrower_names: names,
  };
}

/** 33.1's latest tape facts for a monitored loan, as the partner's servicing system states them (the FAKE partner answers from these). */
export async function partnerTerms(q: Queryable, loanId: string): Promise<PartnerLoanTerms | null> {
  const row = (await q.query<{ facts: Row; as_of_date: string }>(`SELECT facts, as_of_date::text AS as_of_date FROM partner_book_facts WHERE loan_id = $1 ORDER BY as_of_date DESC, created_at DESC LIMIT 1`, [loanId]))[0];
  const loan = (await q.query<{ n: string }>(`SELECT servicer_loan_number AS n FROM loans WHERE id = $1`, [loanId]))[0];
  if (!row || !loan) return null;
  const f = row.facts;
  const money = (v: unknown): Cents => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : typeof v === "number" ? BigInt(Math.round(v * 100)) : c(v));
  const nextDue = dateOf(f["next_due_date"]) ?? addMonths(D(row.as_of_date.slice(0, 10)), 1);
  return { servicer_loan_number: loan.n, upb_cents: money(f["upb_cents"] ?? f["total_upb_cents"]), note_rate_pct: Number(String(f["note_rate_pct"] ?? "0")).toFixed(3), pi_cents: money(f["pi_cents"]), next_due_date: nextDue, as_of_date: D(row.as_of_date.slice(0, 10)), escrow_balance_cents: f["escrow_balance_cents"] === undefined || f["escrow_balance_cents"] === null ? null : money(f["escrow_balance_cents"]) };
}

/** The projected disbursement date: 26.3's funding calendar (`fundings.scheduled_funding_date`, moved by `funding.date.resynced{disbursement_date}`), else 26.1's closing snapshot, else the scheduled note date the closing was set for plus 26.3's rescission days for a rescindable refinance (Tue–Thu, disbursement the fourth business day). */
export function projectedDisbursement(store: EntityStore, events: readonly DomainEvent[], applicationId: string): { date: PlainDate; source: string; funding_id: string | null } | null {
  const app = events.filter((e) => e.applicationId === applicationId);
  const funding = [...store.list("fundings", (d) => d["application_id"] === applicationId)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  // the loan funded already (the fund bridge's direct path — no 26.2 schedule, no 26.3 calendar): the disbursement date is the funding date
  const funded = [...app].reverse().find((e) => e.type === "loan.funded" && dateOf(pl(e)["disbursement_date"] ?? pl(e)["funding_date"]));
  if (funded) return { date: (dateOf(pl(funded)["disbursement_date"]) ?? dateOf(pl(funded)["funding_date"]))!, source: "loan.funded", funding_id: funding?.id ?? s(pl(funded)["funding_id"]) };
  const resync = [...app].reverse().find((e) => e.type === "funding.date.resynced" && dateOf(pl(e)["disbursement_date"] ?? pl(e)["new"]));
  if (resync) return { date: (dateOf(pl(resync)["disbursement_date"]) ?? dateOf(pl(resync)["new"]))!, source: "funding.date.resynced", funding_id: funding?.id ?? s(pl(resync)["funding_id"]) };
  if (funding && dateOf(funding.data["scheduled_funding_date"])) return { date: dateOf(funding.data["scheduled_funding_date"])!, source: "26.3 funding calendar", funding_id: funding.id };
  const snap = store.list("closing_data_snapshots", (d) => d["application_id"] === applicationId).map((r) => (r.data["payload"] as Row | undefined)?.["scheduled_disbursement_date"]).find((v) => dateOf(v));
  if (snap) return { date: dateOf(snap)!, source: "26.1 closing snapshot", funding_id: null };
  const scheduled = [...app].reverse().find((e) => e.type === "closing.scheduled");
  const noteDate = scheduled ? dateOf(pl(scheduled)["scheduled_note_date"]) : null;
  if (noteDate) return { date: addDays(noteDate, 4), source: "closing.scheduled + the rescission window (26.3 calendar not opened yet)", funding_id: null };
  return null;
}
export function fundingIdFor(store: EntityStore, applicationId: string): string | null {
  return [...store.list("fundings", (d) => d["application_id"] === applicationId)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
}

/** The final settlement statement (22.1's classified `documents` row) named by `funding.disbursement.confirmed{evidence_document_id}`: its payoff line for the demand. */
export interface PayoffLine { readonly amount_cents: Cents; readonly wire_reference: string | null; readonly payee_party_id: string | null; readonly payoff_demand_id: string | null; }
export function settlementPayoffLine(store: EntityStore, evidenceDocumentId: string, demandId: string | null, partnerPartyId: string | null): PayoffLine | null {
  const doc = store.get("documents", evidenceDocumentId); if (!doc) return null;
  const meta = (doc.data["metadata"] as Row | undefined) ?? doc.data;
  const lines = (meta["payoff_lines"] as Row[] | undefined) ?? [];
  const hit = lines.find((l) => demandId && l["payoff_demand_id"] === demandId) ?? lines.find((l) => partnerPartyId && l["payee_party_id"] === partnerPartyId) ?? null;
  if (!hit) return null;
  return { amount_cents: c(hit["amount_cents"]), wire_reference: s(hit["wire_reference"]), payee_party_id: s(hit["payee_party_id"]), payoff_demand_id: s(hit["payoff_demand_id"]) };
}
/** The borrower's written authorization on file (comment 36(c)(3)-1): a `documents` row of kind payoff_authorization on the application, else the application itself — the refinance application the borrower signed is the request made on the consumer's behalf. */
export function authorizationDocument(store: EntityStore, applicationId: string): string {
  const doc = store.list("documents", (d) => d["application_id"] === applicationId && d["kind"] === "payoff_authorization")[0];
  return doc ? doc.id : `application:${applicationId}:payoff-authorization`;
}
/** 24.4's liability id for the prior lien: the application's liability that names the prior loan, else a stable id of the prior loan. */
export function liabilityIdFor(store: EntityStore, applicationId: string, priorLoanId: string): string {
  const liability = store.list("application_liabilities", (d) => d["application_id"] === applicationId && (d["loan_id"] === priorLoanId || d["prior_loan_id"] === priorLoanId))[0] ?? store.list("du_liabilities", (d) => d["application_id"] === applicationId && d["loan_id"] === priorLoanId)[0];
  return liability ? liability.id : `prior-loan:${priorLoanId}`;
}
/** 30.3's `consents{kind=escrow_credit_to_new_loan}` for the prior loan and this application (the row 30.3 `record_credit_agreement` writes; the event it appends). */
export function creditConsent(store: EntityStore, events: readonly DomainEvent[], priorLoanId: string, applicationId: string): { consent_id: string; captured_at: PlainDate } | null {
  const id = `consent:escrow_credit_to_new_loan:${priorLoanId}:${applicationId}`;
  const row = store.get("consents", id);
  if (row && dateOf(row.data["captured_at"])) return { consent_id: id, captured_at: dateOf(row.data["captured_at"])! };
  const ev = [...events].reverse().find((e) => e.type === "consent.captured" && pl(e)["kind"] === "escrow_credit_to_new_loan" && e.loanId === priorLoanId && (pl(e)["new_application_id"] === applicationId || e.applicationId === applicationId));
  return ev && dateOf(pl(ev)["captured_at"]) ? { consent_id: s(pl(ev)["consent_id"]) ?? id, captured_at: dateOf(pl(ev)["captured_at"])! } : null;
}
/** The CD's initial escrow deposit ((g)(3), 30.3's figure): 25.2's rendered CD on the record, else 26.3's `loan.funded{escrow_deposit_cents}`. */
export function cdInitialDeposit(store: EntityStore, events: readonly DomainEvent[], applicationId: string): Cents | null {
  const cd = [...store.list("disclosures", (d) => d["application_id"] === applicationId && String(d["kind"] ?? "").startsWith("cd"))].sort((a, b) => Number(b.data["cd_version"] ?? 0) - Number(a.data["cd_version"] ?? 0))[0];
  // 25.2's cdFigureSnapshot is flat (figures.initial_escrow_payment_cents); an escrow sub-object is accepted too
  const figures = cd ? (cd.data["figures"] as Row | undefined) : undefined;
  const fig = (figures?.["escrow"] as Row | undefined) ?? figures;
  if (fig && fig["initial_escrow_payment_cents"] !== undefined && fig["initial_escrow_payment_cents"] !== null) return c(fig["initial_escrow_payment_cents"]);
  const funded = [...events].reverse().find((e) => e.type === "loan.funded" && e.applicationId === applicationId);
  return funded && pl(funded)["escrow_deposit_cents"] !== undefined ? c(pl(funded)["escrow_deposit_cents"]) : null;
}
/** The state's customary security instrument for 16.3's instrument selection (the deed-of-trust states; Georgia's security deed; a mortgage elsewhere) unless the loan's own closing documents say otherwise. */
export function securityInstrumentFor(store: EntityStore, loanId: string, state: string): "mortgage" | "deed_of_trust" | "security_deed" {
  const doc = store.list("closing_documents", (d) => d["kind"] === "security_instrument" && (d["loan_id"] === loanId));
  const kind = s(doc[0]?.data["instrument"]);
  if (kind === "mortgage" || kind === "deed_of_trust" || kind === "security_deed") return kind;
  if (state === "GA") return "security_deed";
  return ["AK", "AZ", "CA", "CO", "DC", "ID", "MD", "MS", "MO", "MT", "NE", "NV", "NC", "OR", "TN", "TX", "UT", "VA", "WA", "WV"].includes(state) ? "deed_of_trust" : "mortgage";
}
/** The prior loan's purchase state for the retirement's remittance path (rule 4 edge case): purchased → fnma_crs; still in the warehouse → warehouse_paydown. */
export const remittedTo = (facts: PriorLoanFacts): "fnma_crs" | "warehouse_paydown" => (facts.purchased && facts.fnma_loan_number ? "fnma_crs" : "warehouse_paydown");
