/**
 * §35.6 rule 8 readers — the purchase side. 27.2's settlement registration is built from the record (21.4's lock and its 20.4
 * quote, 29.1's commitment, 27.1's advance, 26.1's note terms, 25.2's final CD, 26.3's funding, 29.3's SFCs, 29.4's
 * certification); the SAME 27.2 `purchase_advices` row is mapped into 29.4's and 30.1's advice shapes; 30.1's loan row comes
 * from 30.2's loan and the record. Every field names its event or row; a missing path is a RecordGap, never a default.
 */
import type { DomainEvent } from "../../kernel/events/index.ts";
import type { EntityRecord } from "../../app/tools.ts";
import { type OrchRecord, type Source, src, RecordGap } from "./facts-35-6.ts";
import { partyFacts, loanTerms, escrowFacts, cdRow, productFacts, ltvPct, type ClosingFacts } from "./facts-35-6-b.ts";
import { commitmentFacts } from "./facts-35-6-c.ts";
import { addMonths, plainDate } from "../../kernel/calendar/date.ts";

type Row = Record<string, unknown>;
const S = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));

/** "6.125" → "0.06125" (27.2's decimal-fraction rates); a fraction stays. Decimal-string arithmetic, no floats. */
export function asFraction(rate: string): string {
  const t = rate.trim(); if (!t || Number.isNaN(Number(t))) throw new RecordGap("rate", `not a rate: ${rate}`);
  if (Number(t) < 1) return t;
  const [ip, fp = ""] = t.split("."); const digits = (ip!.padStart(2, "0") + fp).replace(/0+$/, "");
  return `0.${digits || "0"}`;
}
/** "0.05875" → "5.875" (29.4's and 30.1's percent rates); a percent stays. */
export function asPct(rate: string): string {
  const t = rate.trim(); if (!t || Number.isNaN(Number(t))) throw new RecordGap("rate", `not a rate: ${rate}`);
  if (Number(t) >= 1) return t;
  const [, fp = ""] = t.split("."); const d = fp.padEnd(3, "0"); const ip = d.slice(0, 2).replace(/^0/, "") || "0"; const rest = d.slice(2).replace(/0+$/, "");
  return rest ? `${ip}.${rest}` : ip;
}
const remitKey = (v: string): string => { const r = v.toLowerCase().replace(/[^a-z_]/g, ""); return r === "actual_actual" || r === "aa" ? "aa" : r === "scheduled_scheduled" || r === "ss" ? "ss" : r === "scheduled_actual" || r === "sa" ? "sa" : r; };
/** 27.2 spells remittance types `aa | ss | sa`, 29.4 `actual_actual | …`, 30.1 `AA | SS | SA`. */
export const remit27 = (v: string): string => remitKey(v);
export const remit29 = (v: string): string => ({ aa: "actual_actual", ss: "scheduled_scheduled", sa: "scheduled_actual" } as Record<string, string>)[remitKey(v)] ?? v;
export const remit30 = (v: string): string => remitKey(v).toUpperCase();

/** 27.2's stored advice for the loan (the Sellers API poll keyed it by the seller loan number) — the ONE row all three sides read. 29.4's projection under the same kind carries `variance_cents`, never `raw_document_id`. */
export function settlementAdvice(rec: OrchRecord, loanId: string): EntityRecord | null {
  return rec.entities("purchase_advices", (d) => d["loan_id"] === loanId && typeof d["raw_document_id"] === "string" && d["status"] !== "superseded").at(-1) ?? null;
}
/** 27.2's `purchase_advice.received` for the row (its signed `interest_adjustment_cents` is the owner's arithmetic). */
export function settlementAdviceEvent(rec: OrchRecord, adviceId: string): DomainEvent {
  const ev = rec.last("purchase_advice.received", (p) => p["purchase_advice_id"] === adviceId && p["raw_document_id"] !== undefined);
  if (!ev) throw new RecordGap("purchase_advice.received", `27.2 recorded no purchase_advice.received for ${adviceId}`);
  return ev;
}

/** 20.4's priced quote the lock executed on: the latest `pricing_quotes` row at the lock's note rate quoted on or before the lock (the lock-day solve carries the economics 27.2 registers — costs, lender credit, SM retained, LLPA). */
export function pricingQuoteRow(rec: OrchRecord, terms: ReturnType<typeof loanTerms>): EntityRecord {
  const rate = asPct(terms.note_rate_pct.value); const lockedAt = S(terms.lock.payload["locked_at"]) ?? terms.lock.occurredAt;
  const rows = rec.entities("pricing_quotes", (d) => d["outcome"] === "priced" && d["third_party_costs_cents"] !== undefined && typeof d["quoted_at"] === "string" && String(d["quoted_at"]) <= lockedAt && asPct(String(d["note_rate_pct"] ?? d["note_rate"] ?? "")) === rate);
  const row = [...rows].sort((a, b) => String(a.data["quoted_at"]).localeCompare(String(b.data["quoted_at"]))).at(-1);
  if (!row) throw new RecordGap("pricing_quotes", `no priced 20.4 quote at ${rate}% on or before the lock (${lockedAt})`);
  for (const k of ["third_party_costs_cents", "lender_credit_cents", "sm_retained_cents", "llpa_total_pct", "llpa_cents", "matrix_version"]) if (row.data[k] === undefined || row.data[k] === null) throw new RecordGap(`pricing_quotes.${k}`, `20.4's quote ${row.id} carries no ${k}`);
  return row;
}

export interface SettlementRegistration { readonly loan: Row; readonly sources: Record<string, Source> }
/** 27.2 `forecastProceeds{op: register}`'s loan from the record. */
export async function settlementRegistration(rec: OrchRecord, i: { loan_id: string; seller_loan_number: string; delivery_id: string; funding_id: string; closing: ClosingFacts }): Promise<SettlementRegistration> {
  const terms = loanTerms(rec); const product = productFacts(rec, terms); const c = commitmentFacts(rec); const parties = await partyFacts(rec, i.closing);
  const funded = rec.last("loan.funded"); if (!funded) throw new RecordGap("loan.funded", "no loan.funded (26.3)");
  const advance = rec.last("warehouse.advance.funded"); if (!advance) throw new RecordGap("warehouse.advance.funded", "27.1's funded advance is not on the record");
  const certified = rec.last("custody.certified", (p) => p["expected_purchase_date"] !== undefined); if (!certified) throw new RecordGap("custody.certified", "29.4's certification is not on the record");
  const submitted = rec.last("delivery.submitted"); if (!submitted) throw new RecordGap("delivery.submitted", "no Loan Delivery submission (29.4)");
  const cd = cdRow(rec); if (!cd) throw new RecordGap("disclosures:cd", "no CD row (25.2)");
  const lockId = String(terms.lock.payload["lock_id"]); const lockRow = rec.entity("locks", lockId) ?? null;
  const quoteRow = pricingQuoteRow(rec, terms); const quote = quoteRow.data; const quoteId = quoteRow.id;
  const noteTerms = ((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined) ?? null;
  const firstPayment = S(noteTerms?.["first_payment_date"]); if (!firstPayment) throw new RecordGap("closing_data_snapshots.note_terms", "26.1's note terms carry no first payment date");
  const subject = rec.app.properties[0]; if (!subject) throw new RecordGap("application_properties", "no subject property (21.1)");
  if (!rec.app.occupancy) throw new RecordGap("applications.occupancy", "the application carries no occupancy (21.1)");
  const sfc = rec.last("delivery.sfc.assigned"); if (!sfc) throw new RecordGap("delivery.sfc.assigned", "29.3 assigned no SFCs");
  const registered = rec.last("enote.registered"); const noteDoc = rec.entities("closing_documents", (d) => d["kind"] === "enote" || d["kind"] === "note").at(-1) ?? null;
  const facilityId = String(advance.payload["facility_id"]); const facilityRow = rec.entities("warehouse_facilities", (d) => d["facility_id"] === facilityId).at(-1) ?? null;
  const bailee = i.closing.note_form === "paper" ? rec.entities("bailee_letters", (d) => d["advance_id"] === advance.payload["advance_id"]).at(-1) ?? null : null;
  const custodianParty = i.closing.note_form === "paper" ? S(rec.entities("custodian_certifications").at(-1)?.data["custodian_party_id"]) : null;
  // third-party costs actually invoiced: 27.2's invoice documents when the record carries them; otherwise the quote's forecast stands as the actual (the cap check is then vacuous) — the source says which
  const invoices = rec.entities("vendor_invoices", (d) => d["loan_id"] === i.loan_id || d["application_id"] === rec.app.id);
  const actualCosts = invoices.length ? invoices.reduce((sum, r) => sum + BigInt(String(r.data["amount_cents"] ?? "0")), 0n) : BigInt(String(quote["third_party_costs_cents"]));
  const llpaItems = ((quote["llpa_items"] as Row[] | undefined) ?? []).filter((x) => x["waived"] !== true).map((x) => ({ code: S(x["code"]) ?? `${String(x["grid"])}:${String(x["row"])}:${String(x["col"])}`, pct: String(x["pct"]) }));
  const loan: Row = {
    loan_id: i.loan_id, application_id: rec.app.id, advance_id: String(advance.payload["advance_id"]), facility_id: facilityId, funding_id: i.funding_id, delivery_id: i.delivery_id, fnma_loan_number: S(submitted.payload["fnma_loan_number"]), seller_loan_number: i.seller_loan_number,
    ...(facilityRow ? { partner_id: String(facilityRow.data["partner_id"]) } : {}),
    upb_cents: String(terms.loan_amount_cents.value), note_rate: asFraction(terms.note_rate_pct.value), pass_through_rate: asFraction(c.pass_through_rate), remittance_type: remit27(c.remittance_type), lpi_date: addMonths(plainDate(firstPayment), -1), first_payment_date: firstPayment,
    term_months: terms.term_months, amortization_type: product.amortization, product_code: product.product_code, pi_cents: String(terms.pi_cents.value), escrow_indicator: escrowFacts(rec) !== null, mi_flag: ltvPct(rec).value > 80, occupancy: rec.app.occupancy, property_state: subject.state, sfc_codes: ((sfc.payload["codes"] as unknown[] | undefined) ?? []).map(String),
    price: c.price, llpa_items: llpaItems, fees_cents: "0", expected_purchase_date: String(certified.payload["expected_purchase_date"]), matrix_version: String(quote["matrix_version"]),
    quote: { quote_id: quoteId, price: c.price, llpa_total_pct: String(quote["llpa_total_pct"]), third_party_costs_cents: String(quote["third_party_costs_cents"]), lender_credit_cents: String(quote["lender_credit_cents"]), sm_retained_cents: String(quote["sm_retained_cents"]), matrix_version: String(quote["matrix_version"]), solve_trace_document_id: S(quote["solve_trace_document_id"]) ?? `pricing_quotes:${quoteId}:solve_trace`, quoted_note_rate: asFraction(String(quote["note_rate_pct"] ?? quote["note_rate"] ?? terms.note_rate_pct.value)) },
    lock_id: lockId, evidence: { quote_solve_trace_document_id: S(quote["solve_trace_document_id"]) ?? `pricing_quotes:${quoteId}:solve_trace`, lock_confirmation_document_id: S(lockRow?.data["confirmation_document_id"]) ?? `locks:${lockId}:confirmation`, final_cd_document_id: S(cd.data["document_id"]) ?? cd.id, note_document_id: S(noteDoc?.data["document_id"]) ?? noteDoc?.id ?? "", purchase_advice_document_id: "", invoice_document_ids: invoices.map((r) => r.id) },
    disclosure_id_cd_final: cd.id, cd_lender_credit_cents: String(terms.lender_credit_cents.value), prepaid_interest_collected_cents: String(funded.payload["prepaid_interest_cents"] ?? "0"), third_party_costs_actual_cents: String(actualCosts),
    note_form: i.closing.note_form, bailee_letter_id: bailee?.id ?? null, custodian_party_id: custodianParty, min: S(registered?.payload["min"]) ?? null,
  };
  const sources: Record<string, Source> = { lock: terms.loan_amount_cents.source, quote: src("entity", `pricing_quotes:${quoteRow.id}:${quoteRow.version}`, "20.4"), commitment: c.source, product: product.source, advance: src("event", `warehouse.advance.funded:${advance.id}`, "27.1"),
    funded: src("event", `loan.funded:${funded.id}`, "26.3"), certified: src("event", `custody.certified:${certified.id}`, "29.4"), submitted: src("event", `delivery.submitted:${submitted.id}`, "29.4"), cd: src("entity", `disclosures:${cd.id}:${cd.version}`, "25.2"), sfcs: src("event", `delivery.sfc.assigned:${sfc.id}`, "29.3"),
    note_terms: src("entity", `closing_data_snapshots:${rec.entities("closing_data_snapshots").at(-1)!.id}`, "26.1"), party: parties.sources["partner"]!,
    third_party_costs_actual: invoices.length ? src("entity", invoices.map((r) => `vendor_invoices:${r.id}`).join(","), "27.2") : src("derived", `no vendor invoices on the record: 20.4 quote ${quoteId}'s third_party_costs_cents stands as the actual`, "27.2"),
    ...(registered ? { enote: src("event", `enote.registered:${registered.id}`, "26.2") } : {}) };
  return { loan, sources };
}

/** The 27.2 row as 29.4's `PurchaseAdviceInput` (29.4's own projection gets its own id: the two owners share the `purchase_advices` kind). */
export function adviceFor294(rec: OrchRecord, row: EntityRecord): { advice: Row; sources: Record<string, Source> } {
  const d = row.data; const ev = settlementAdviceEvent(rec, row.id); const c = commitmentFacts(rec);
  const advice: Row = { purchase_advice_id: `${row.id}:delivery`, fnma_loan_number: String(d["fnma_loan_number"]), advice_date: String(d["advice_date"]), purchase_date: String(d["purchase_date"]), commitment_id_fnma: S(d["commitment_id_fnma"]) ?? c.commitment_id_fnma, payee_code: String(d["payee_code"] ?? ""),
    remittance_type: remit29(String(d["remittance_type"])), pass_through_rate: asPct(String(d["pass_through_rate"])), servicing_fee_rate: c.servicing_fee_rate, price: String(d["price"]), upb_cents: String(d["upb_cents"]), principal_proceeds_cents: String(d["gross_price_proceeds_cents"]),
    interest_adjustment_cents: String(ev.payload["interest_adjustment_cents"]), llpa_total_cents: String(d["llpa_total_cents"]), llpa_lines: ((d["llpa_items"] as Row[] | undefined) ?? []).map((l) => ({ code: String(l["code"]), pct: String(l["pct"]), cents: String(l["cents"]) })),
    fees: BigInt(String(d["other_fees_cents"] ?? "0")) !== 0n ? [{ kind: "other", cents: String(d["other_fees_cents"]) }] : [], net_proceeds_cents: String(d["net_proceeds_cents"]), wire_reference: S(d["wire_nickname"]), source: "api", raw_payload_document_id: S(d["raw_document_id"]), received_at: String(d["received_at"]) };
  return { advice, sources: { advice: src("entity", `purchase_advices:${row.id}:${row.version}`, "27.2"), received: src("event", `purchase_advice.received:${ev.id}`, "27.2"), commitment: c.source } };
}

/** The 27.2 row as 30.1's `PurchaseAdvice` and 30.2's loan as 30.1's `PurchaseLoan`. */
export async function investorMatchInput(rec: OrchRecord, row: EntityRecord, i: { loan_id: string; seller_loan_number: string; closing: ClosingFacts }): Promise<{ loan: Row; advice: Row; sources: Record<string, Source> }> {
  const d = row.data; const ev = settlementAdviceEvent(rec, row.id); const terms = loanTerms(rec); const c = commitmentFacts(rec); const parties = await partyFacts(rec, i.closing);
  const servicer = S(d["fnma_servicer_number"]) ?? parties.partner_servicer_number; if (!servicer) throw new RecordGap("parties.servicer_number", "the partner's 9-digit Fannie Mae seller/servicer number is not on the record (20.2)");
  const noteTerms = ((rec.entities("closing_data_snapshots").at(-1)?.data["payload"] as Row | undefined)?.["note_terms"] as Row | undefined) ?? null;
  const firstPayment = S(noteTerms?.["first_payment_date"]); if (!firstPayment) throw new RecordGap("closing_data_snapshots.note_terms", "26.1's note terms carry no first payment date");
  const registered = rec.last("enote.registered");
  const loan: Row = { servicing_loan_number: i.seller_loan_number, original_upb_cents: String(terms.loan_amount_cents.value), first_payment_date: firstPayment, note_rate_pct: asPct(terms.note_rate_pct.value), commitment_remittance_type: remit30(c.remittance_type), escrowed: escrowFacts(rec) !== null,
    note_form: i.closing.note_form, mers_registered: registered !== null || rec.has("mers.registration.confirmed"), min: S(registered?.payload["min"]) ?? S(rec.payload("closing.scheduled")?.["min"]) };
  const advice: Row = { advice_id: row.id, fnma_loan_number: String(d["fnma_loan_number"]), fnma_servicer_number: servicer, lender_loan_number: String(d["seller_loan_number"]), advice_date: String(d["advice_date"]), purchase_date: String(d["purchase_date"]), remittance_type: remit30(String(d["remittance_type"])),
    pass_through_rate: asPct(String(d["pass_through_rate"])), note_rate_pct: asPct(String(d["note_rate"])), servicing_fee_bps: Number(d["servicing_fee_bps"]), interest_adjustment_cents: String(ev.payload["interest_adjustment_cents"]), net_proceeds_cents: String(d["net_proceeds_cents"]) };
  return { loan, advice, sources: { advice: src("entity", `purchase_advices:${row.id}:${row.version}`, "27.2"), loan: src("table", `loans:${i.loan_id}`, "30.2"), lock: terms.note_rate_pct.source, commitment: c.source, partner: parties.sources["partner"]! } };
}
