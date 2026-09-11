/**
 * §27.2 process-owned tools — bus tools for 27.2 defined with `defineTools("27.2", "warehouse", defs)` from
 * ../tools.ts. Every tool string is one spec/registry/agents.json names for 27.2 (`warehouse`): pollPurchaseAdvices,
 * ingestReceipts, forecastProceeds, matchProceeds, explainVariance, postWaterfall, releaseCollateral,
 * schedulePartnerResidual (hands to funding_approver), funding_approver (the human dual-control residual release —
 * humanOnly), computeGainOnSale, reconcilePassthrough, issueMsrHandoff, accruePlatformFee, exportGl, preparePpa (hands
 * to fnma_portal_operator / officer{partner}), fnma_portal_operator (the human LSDU / Connect-report path — humanOnly),
 * writeDecision. Guardrails encode the paragraph: never release a partner residual wire without funding_approver; never
 * net a commitment fee draft against proceeds; never change the borrower's terms or post a borrower adjustment; never
 * alter SM's cost recovery above the invoice/cap; never write off a shortfall or set off partner funds without
 * officer{sm}; never submit a PPA under the partner's credentials; never accept an advice that fails the key match.
 * Every number is computed by src/domain/warehouse/ops-27-2.ts; the 27.1 payoff calculators are reused for the
 * warehouse payoff figure. Spread by ./index.ts.
 */
import { defineTools, compute, decision, never, needsRole, cents, str, flag, type ToolDef, type ToolInput, type ToolRuntime } from "../tools.ts";
import type { CommandContext } from "../commands.ts";
import type { Actor, DomainEvent } from "../../kernel/events/index.ts";
import { plainDate as D, type PlainDate } from "../../kernel/calendar/date.ts";
import type { EntrySetInput } from "../../kernel/ledger/ledger.ts";
import type { Cents } from "../../kernel/money/index.ts";
import { FACILITY_FIXTURE, payoffStatement, etDate, type AdvanceRecord, type FacilityTerms, type NoteForm, type PayoffStatement, type WireApproval } from "../../domain/warehouse/ops-27-1.ts";
import { warehouseServices } from "./section27-1.ts";
import {
  ECONOMICS_V1, ECONOMICS_RULE_SETS, GuardrailViolation, FakePurchaseAdviceApi, FakeCollectionBank, forecastProceeds, expectedNet, matchProceeds, explainVariance, provisionalMatch, missingAdvice, adviceSignedInterest, settlementWaterfall, releasePlan, computeGainOnSale, reconcilePassthrough, assessPremiumRecapture,
  msrHandoffPayload, MSR_SCHEMA_VERSION, platformFeeAccrual, periodOf, preparePpa, assertPpaSubmitter, buildGlBatches, compact, forecastLedgerSet, receiptLedgerSet, costRecoveryReceivableSet, waterfallLedgerSets, residualPaidLedgerSet, shortfallReceivedLedgerSet, platformFeeLedgerSet, recaptureReversalLedgerSet, gosMemoLedgerSet,
  recordPurchaseAdvice, recordUnmatchedAdvice, recordReceipt, recordMatch, recordProvisionalMatch, recordProceedsException, recordWaterfall, recordReleases, recordShortfallReceived, recordResidualPaid, recordGosComputed, recordPassthroughReconciled, recordMsrHandoff, recordMsrAcknowledged, recordPlatformFee, recordGlExport, recordPpaRequested, recordPpaResolved, recordPremiumRecapture, recordCertificationObserved, settlementDecisionRecord,
  type SettlementServices, type SettlementKeys, type PurchaseAdviceRecord, type ProceedsReceiptRecord, type RawPurchaseAdvice, type ProceedsForecast, type MatchResult, type Waterfall, type GainOnSale, type PassthroughRecon, type QuoteEconomics, type PassthroughEvidence, type PartnerConvention, type RemittanceType, type InterestDirection, type LlpaItem, type PpaRequest, type PpaKind, type GlBatch, type MsrPayload,
} from "../../domain/warehouse/ops-27-2.ts";

// ---- helpers ------------------------------------------------------------------
const need = (i: ToolInput, ...keys: string[]): void => { for (const k of keys) if (i[k] === undefined || i[k] === null || i[k] === "") throw new RangeError(`${k} is required`); };
const rec = (i: ToolInput, k: string): Record<string, unknown> => { const v = i[k]; if (!v || typeof v !== "object") throw new RangeError(`${k} is required`); return v as Record<string, unknown>; };
const date = (v: unknown, what: string): PlainDate => { if (typeof v !== "string" || !v) throw new RangeError(`${what} is required`); return D(v); };
const optDate = (v: unknown): PlainDate | null => (typeof v === "string" && v ? D(v) : null);
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
/** bigint → string for the entity store (JSON-safe), recursively. */
const ser = (v: unknown): unknown => (typeof v === "bigint" ? String(v) : Array.isArray(v) ? v.map(ser) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ser(x)])) : v);
/** string → bigint for every `*_cents` key, recursively (the inverse of `ser` for money). */
const revive = (v: unknown, key = ""): unknown => (typeof v === "string" && key.endsWith("_cents") && /^-?\d+$/.test(v) ? BigInt(v) : Array.isArray(v) ? v.map((x) => revive(x, key)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, revive(x, k)])) : v);
const K = { loans: "settlement_loans", partners: "warehouse_partners", advices: "purchase_advices", receipts: "proceeds_receipts", matches: "proceeds_matches", waterfalls: "settlement_waterfalls", gos: "gain_on_sale_computations", recons: "rate_passthrough_reconciliations", msr: "msr_handoffs", fees: "platform_fee_accruals", ppas: "ppa_requests", gl: "gl_export_batches", glState: "gl_export_state", approvals: "funding_approvals", advances: "warehouse_advances", accruals: "warehouse_interest_accruals", facilities: "warehouse_facilities" } as const;
/** The 27.2 ports (Purchase Advice Sellers/Servicers APIs, collection-bank credit feed) — wired by the runtime under services.settlement; fakes when absent. The residual wire goes through 27.1's bank port (services.warehouse). */
export function settlementServices(rt: ToolRuntime): SettlementServices {
  const s = rt.services as Record<string, unknown>;
  if (!s.settlement) s.settlement = { advices: new FakePurchaseAdviceApi(), collectionBank: new FakeCollectionBank() } satisfies SettlementServices;
  return s.settlement as SettlementServices;
}
export type SettlementStatus = "awaiting_purchase" | "advice_received" | "proceeds_received" | "matched" | "exception" | "ppa_requested" | "resolved" | "settled" | "closed" | "not_purchased" | "repurchased_from_fnma";
/** Per-loan settlement facts registered at delivery (keys, terms, the 20.4 quote, 25.2/26.3 figures, collateral facts) and advanced by every step. */
export interface SettlementLoan extends SettlementKeys {
  readonly partner_id: string; readonly upb_cents: Cents; readonly note_rate: string; readonly pass_through_rate: string; readonly remittance_type: RemittanceType; readonly lpi_date: PlainDate; readonly first_payment_date: PlainDate;
  readonly term_months: number; readonly amortization_type: string; readonly product_code: string; readonly pi_cents: Cents; readonly escrow_indicator: boolean; readonly mi_flag: boolean; readonly occupancy: string; readonly property_state: string; readonly sfc_codes: readonly string[];
  readonly price: string; readonly llpa_items: readonly LlpaItem[]; readonly fees_cents: Cents; readonly expected_purchase_date: PlainDate; readonly matrix_version: string;
  readonly quote: QuoteEconomics; readonly lock_id: string; readonly evidence: PassthroughEvidence; readonly disclosure_id_cd_final: string; readonly cd_lender_credit_cents: Cents; readonly prepaid_interest_collected_cents: Cents; readonly third_party_costs_actual_cents: Cents;
  readonly note_form: NoteForm; readonly bailee_letter_id: string | null; readonly custodian_party_id: string | null; readonly min: string | null;
  readonly certification_date: PlainDate | null; readonly purchase_date: PlainDate | null; readonly purchase_advice_id: string | null; readonly match_id: string | null; readonly waterfall_id: string | null; readonly gos_id: string | null; readonly recon_id: string | null; readonly handoff_id: string | null;
  readonly forecast_posted: boolean; readonly cost_receivable_posted: boolean; readonly releases_issued: boolean; readonly status: SettlementStatus;
}
const loanOf = (rt: ToolRuntime, i: ToolInput): SettlementLoan => { need(i, "loan_id"); const r = rt.store.get(K.loans, str(i, "loan_id")); if (!r) throw new RangeError(`no settlement record for loan ${str(i, "loan_id")} (forecastProceeds op=register first)`); return revive(r.data) as SettlementLoan; };
const putLoan = (rt: ToolRuntime, l: SettlementLoan, ctx: CommandContext): SettlementLoan => { rt.store.put(K.loans, l.loan_id!, ser(l) as Record<string, unknown>, ctx.actor, ctx.now); return l; };
const keysOf = (l: SettlementLoan): SettlementKeys => ({ advance_id: l.advance_id, loan_id: l.loan_id, application_id: l.application_id, facility_id: l.facility_id, funding_id: l.funding_id, delivery_id: l.delivery_id, fnma_loan_number: l.fnma_loan_number, seller_loan_number: l.seller_loan_number });
const facilityOf = (rt: ToolRuntime, l: { facility_id: string }): FacilityTerms => { const r = rt.store.get(K.facilities, l.facility_id); return r ? (revive(r.data) as FacilityTerms) : FACILITY_FIXTURE; };
const partnerConvention = (rt: ToolRuntime, partnerId: string): PartnerConvention => (rt.store.get(K.partners, partnerId)?.data.fnma_interest_convention as PartnerConvention | undefined) ?? "unresolved";
const adviceOf = (rt: ToolRuntime, id: string | null): PurchaseAdviceRecord | null => (id ? (revive(rt.store.get(K.advices, id)?.data) as PurchaseAdviceRecord | undefined) ?? null : null);
const receiptOf = (rt: ToolRuntime, id: string): ProceedsReceiptRecord & { loan_id: string | null } => revive(rt.store.require(K.receipts, id).data) as ProceedsReceiptRecord & { loan_id: string | null };
const latestReceiptFor = (rt: ToolRuntime, loanId: string): (ProceedsReceiptRecord & { loan_id: string | null }) | null => { const rows = rt.store.list(K.receipts, (d) => d.loan_id === loanId).map((r) => revive(r.data) as ProceedsReceiptRecord & { loan_id: string | null }); return rows.sort((a, b) => (a.received_at < b.received_at ? -1 : 1)).at(-1) ?? null; };
const matchOf = (rt: ToolRuntime, id: string | null): (MatchResult & { match_id: string; purchase_advice_id: string; receipt_id: string; matched_at: string; loan_id: string }) | null => (id ? (revive(rt.store.get(K.matches, id)?.data) as (MatchResult & { match_id: string; purchase_advice_id: string; receipt_id: string; matched_at: string; loan_id: string }) | undefined) ?? null : null);
const waterfallOf = (rt: ToolRuntime, id: string | null): (Waterfall & { waterfall_id: string; match_id: string; posted_at: string; partner_wire_ref: string | null; shortfall_received_cents: Cents }) | null => (id ? (revive(rt.store.get(K.waterfalls, id)?.data) as (Waterfall & { waterfall_id: string; match_id: string; posted_at: string; partner_wire_ref: string | null; shortfall_received_cents: Cents }) | undefined) ?? null : null);
const gosOf = (rt: ToolRuntime, id: string | null): (GainOnSale & { gos_id: string; recapture_assessed_cents: Cents | null }) | null => (id ? (revive(rt.store.get(K.gos, id)?.data) as (GainOnSale & { gos_id: string; recapture_assessed_cents: Cents | null }) | undefined) ?? null : null);
const forecastFor = (l: SettlementLoan, purchaseDate: PlainDate): ProceedsForecast => forecastProceeds({ upb_cents: l.upb_cents, price: l.price, llpa_items: l.llpa_items, remittance_type: l.remittance_type, purchase_date: purchaseDate, lpi_date: l.lpi_date, pass_through_rate: l.pass_through_rate, fees_cents: l.fees_cents, matrix_version: l.matrix_version });
/** The 27.1 payoff statement for the advance: principal + capitalized interest + accrued-not-capitalized interest through the day before the value date + fees (27.1's records when present; the caller's figures otherwise). */
function payoffFor(rt: ToolRuntime, l: SettlementLoan, valueDate: PlainDate, given: Record<string, unknown> | null): PayoffStatement {
  const adv = rt.store.get(K.advances, l.advance_id);
  if (adv) {
    const a = revive(adv.data) as AdvanceRecord;
    const accrued = rt.store.list(K.accruals, (d) => d.advance_id === l.advance_id && d.capitalized !== true && String(d.accrual_date) < valueDate).reduce((s, r) => s + cents(r.data.posted_cents), 0n);
    return payoffStatement({ outstanding_principal_cents: a.outstanding_principal_cents, capitalized_interest_cents: a.capitalized_interest_cents, accrued_not_capitalized_cents: accrued, fees_cents: a.fees_outstanding_cents, repayment_on: valueDate });
  }
  if (!given) throw new RangeError(`no warehouse advance ${l.advance_id} in the store and no payoff figures given`);
  return payoffStatement({ outstanding_principal_cents: cents(given.outstanding_principal_cents), capitalized_interest_cents: cents(given.capitalized_interest_cents), accrued_not_capitalized_cents: cents(given.accrued_not_capitalized_cents), fees_cents: cents(given.fees_cents), repayment_on: valueDate });
}
const post = (ctx: CommandContext, sets: readonly EntrySetInput[]): string[] => sets.map(compact).filter((s): s is EntrySetInput => s !== null).map((s) => ctx.ledger.post(s, ctx.now).id);
/** A data-dependent refusal inside a handler: logged as a guardrail violation event, then thrown (the bus logs input-only refusals itself as `command.refused`). */
const refuse = (ctx: CommandContext, code: string, citation: string, why: string, subject: Record<string, unknown>): never => {
  ctx.events.append({ type: "warehouse.guardrail.violated", loanId: ctx.loanId, actor: ctx.actor, payload: { code, citation, reason: why, ...subject } });
  throw new GuardrailViolation(code, citation, why);
};
const loanRow = (r: Record<string, unknown>): SettlementLoan => {
  const q = (r.quote && typeof r.quote === "object" ? r.quote : {}) as Record<string, unknown>; const ev = (r.evidence && typeof r.evidence === "object" ? r.evidence : {}) as Record<string, unknown>;
  return { loan_id: optStr(r.loan_id), application_id: String(r.application_id ?? ""), advance_id: String(r.advance_id ?? ""), facility_id: String(r.facility_id ?? FACILITY_FIXTURE.facility_id), funding_id: String(r.funding_id ?? ""), delivery_id: optStr(r.delivery_id), fnma_loan_number: optStr(r.fnma_loan_number), seller_loan_number: String(r.seller_loan_number ?? ""),
    partner_id: String(r.partner_id ?? FACILITY_FIXTURE.partner_id), upb_cents: cents(r.upb_cents), note_rate: String(r.note_rate ?? ""), pass_through_rate: String(r.pass_through_rate ?? ""), remittance_type: (String(r.remittance_type ?? "aa") as RemittanceType), lpi_date: date(r.lpi_date, "loan.lpi_date"), first_payment_date: date(r.first_payment_date, "loan.first_payment_date"),
    term_months: Number(r.term_months ?? 360), amortization_type: String(r.amortization_type ?? "fixed"), product_code: String(r.product_code ?? ""), pi_cents: cents(r.pi_cents), escrow_indicator: r.escrow_indicator === true, mi_flag: r.mi_flag === true, occupancy: String(r.occupancy ?? "primary"), property_state: String(r.property_state ?? ""), sfc_codes: Array.isArray(r.sfc_codes) ? (r.sfc_codes as string[]) : [],
    price: String(r.price ?? "100.000"), llpa_items: arr(r.llpa_items).map((l) => ({ code: String(l.code ?? ""), pct: String(l.pct ?? "0") })), fees_cents: cents(r.fees_cents), expected_purchase_date: date(r.expected_purchase_date, "loan.expected_purchase_date"), matrix_version: String(r.matrix_version ?? ECONOMICS_RULE_SETS.llpa),
    quote: { quote_id: String(q.quote_id ?? ""), price: String(q.price ?? r.price ?? "100.000"), llpa_total_pct: String(q.llpa_total_pct ?? "0"), third_party_costs_cents: cents(q.third_party_costs_cents), lender_credit_cents: cents(q.lender_credit_cents), sm_retained_cents: cents(q.sm_retained_cents), matrix_version: String(q.matrix_version ?? ECONOMICS_RULE_SETS.llpa), solve_trace_document_id: String(q.solve_trace_document_id ?? ""), quoted_note_rate: String(q.quoted_note_rate ?? r.note_rate ?? "") },
    lock_id: String(r.lock_id ?? ""), evidence: { quote_solve_trace_document_id: String(ev.quote_solve_trace_document_id ?? q.solve_trace_document_id ?? ""), lock_confirmation_document_id: String(ev.lock_confirmation_document_id ?? ""), final_cd_document_id: String(ev.final_cd_document_id ?? ""), note_document_id: String(ev.note_document_id ?? ""), purchase_advice_document_id: String(ev.purchase_advice_document_id ?? ""), invoice_document_ids: Array.isArray(ev.invoice_document_ids) ? (ev.invoice_document_ids as string[]) : [] },
    disclosure_id_cd_final: String(r.disclosure_id_cd_final ?? ""), cd_lender_credit_cents: cents(r.cd_lender_credit_cents), prepaid_interest_collected_cents: cents(r.prepaid_interest_collected_cents), third_party_costs_actual_cents: cents(r.third_party_costs_actual_cents),
    note_form: r.note_form === "paper" ? "paper" : "enote", bailee_letter_id: optStr(r.bailee_letter_id), custodian_party_id: optStr(r.custodian_party_id), min: optStr(r.min), certification_date: optDate(r.certification_date), purchase_date: optDate(r.purchase_date), purchase_advice_id: null, match_id: null, waterfall_id: null, gos_id: null, recon_id: null, handoff_id: null,
    forecast_posted: false, cost_receivable_posted: false, releases_issued: false, status: "awaiting_purchase" };
};
const rawAdvice = (r: Record<string, unknown>, source: PurchaseAdviceRecord["source"]): RawPurchaseAdvice => ({ fnma_loan_number: String(r.fnma_loan_number ?? ""), seller_loan_number: String(r.seller_loan_number ?? r.lender_loan_number ?? ""), fnma_servicer_number: String(r.fnma_servicer_number ?? ""), commitment_id_fnma: optStr(r.commitment_id_fnma), advice_date: date(r.advice_date, "advice.advice_date"), purchase_date: date(r.purchase_date, "advice.purchase_date"), purchase_ready_date: optDate(r.purchase_ready_date),
  remittance_type: String(r.remittance_type ?? "aa") as RemittanceType, note_rate: String(r.note_rate ?? ""), pass_through_rate: String(r.pass_through_rate ?? ""), servicing_fee_bps: Number(r.servicing_fee_bps ?? ECONOMICS_V1.servicing_fee_bps), lpi_date: date(r.lpi_date, "advice.lpi_date"), interest_days: Number(r.interest_days ?? 0), interest_direction: String(r.interest_direction ?? "none") as InterestDirection, interest_cents: cents(r.interest_cents),
  upb_cents: cents(r.upb_cents), price: String(r.price ?? ""), gross_price_proceeds_cents: cents(r.gross_price_proceeds_cents), llpa_items: arr(r.llpa_items).map((l) => ({ code: String(l.code ?? ""), pct: String(l.pct ?? "0"), cents: cents(l.cents) })), llpa_total_cents: cents(r.llpa_total_cents), other_fees_cents: cents(r.other_fees_cents), net_proceeds_cents: cents(r.net_proceeds_cents),
  payee_code: String(r.payee_code ?? ""), wire_nickname: optStr(r.wire_nickname), source, raw_json: typeof r.raw_json === "string" ? r.raw_json : JSON.stringify(r) });
/** Advice ingestion (Sellers API poll, Connect report, manual): idempotent by (fnma_loan_number, advice_date); raw JSON retained; keyed to the loan or stored as unmatched. */
function ingestAdvices(rt: ToolRuntime, ctx: CommandContext, raws: readonly RawPurchaseAdvice[]): { stored: Record<string, unknown>[]; duplicates: string[]; unmatched: string[]; confirmed_provisional: string[] } {
  const out = { stored: [] as Record<string, unknown>[], duplicates: [] as string[], unmatched: [] as string[], confirmed_provisional: [] as string[] };
  for (const raw of raws) {
    const purchase_advice_id = `pa-${raw.fnma_loan_number}-${raw.advice_date}`;
    if (rt.store.get(K.advices, purchase_advice_id)) { out.duplicates.push(purchase_advice_id); continue; }
    const loanRec = rt.store.list(K.loans, (d) => d.seller_loan_number === raw.seller_loan_number || (typeof d.fnma_loan_number === "string" && d.fnma_loan_number === raw.fnma_loan_number))[0];
    const { raw_json, ...fields } = raw;
    const row: PurchaseAdviceRecord = { ...fields, purchase_advice_id, loan_id: loanRec ? String(loanRec.data.loan_id) : null, delivery_id: loanRec ? optStr(loanRec.data.delivery_id) : null, raw_document_id: `doc:${purchase_advice_id}.json`, received_at: ctx.now, status: "received" };
    rt.store.put(K.advices, purchase_advice_id, { ...(ser(row) as Record<string, unknown>), raw_json }, ctx.actor, ctx.now);
    if (!loanRec) { recordUnmatchedAdvice(ctx.events, row, ctx.now); out.unmatched.push(purchase_advice_id); out.stored.push({ purchase_advice_id, loan_id: null }); continue; }
    const l = revive(loanRec.data) as SettlementLoan;
    if (l.fnma_loan_number && l.fnma_loan_number !== raw.fnma_loan_number) refuse(ctx, "ADVICE_KEY_MISMATCH", "27.2 guardrails: the agent may never accept an advice that fails the loan-number/seller-number key match", `advice ${purchase_advice_id} keys ${raw.fnma_loan_number}/${raw.seller_loan_number} against ${l.fnma_loan_number}/${l.seller_loan_number}`, { purchase_advice_id });
    const next = putLoan(rt, { ...l, fnma_loan_number: raw.fnma_loan_number, purchase_date: raw.purchase_date, purchase_advice_id, status: l.status === "awaiting_purchase" ? "advice_received" : l.status }, ctx);
    recordPurchaseAdvice(ctx.events, keysOf(next), row, ctx.now);
    out.stored.push({ purchase_advice_id, loan_id: next.loan_id, net_proceeds_cents: String(row.net_proceeds_cents) });
    // a provisional match (receipt before advice) is confirmed by the advice
    const prov = rt.store.list(K.matches, (d) => d.loan_id === next.loan_id && d.status === "provisional")[0];
    if (prov) { runMatch(rt, ctx, next, row, receiptOf(rt, String(prov.data.receipt_id)), null, ctx.now); out.confirmed_provisional.push(String(prov.id)); }
  }
  return out;
}
/** The three-way match for a loan: stores the match row, posts the receipt set, locks the partner convention, raises exceptions / PPA drafts / escalations. */
function runMatch(rt: ToolRuntime, ctx: CommandContext, l: SettlementLoan, advice: PurchaseAdviceRecord, receipt: ProceedsReceiptRecord & { loan_id: string | null }, receivedCents: Cents | null, matchedAt: string): MatchResult & { match_id: string; purchase_advice_id: string; receipt_id: string; matched_at: string; events: DomainEvent[] } {
  const f = facilityOf(rt, l); const forecast = forecastFor(l, advice.purchase_date); const conv = partnerConvention(rt, l.partner_id);
  const m = matchProceeds({ keys: keysOf(l), forecast, advice, received_cents: receivedCents ?? receipt.amount_cents, receipt_account_ref: receipt.account_ref, partner_convention: conv, collection_account_ref: f.collection_account_ref, expected_payee_code: null });
  const match_id = `pm-${l.loan_id}-${rt.store.list(K.matches, (d) => d.loan_id === l.loan_id).length + 1}`;
  const full = { ...m, match_id, purchase_advice_id: advice.purchase_advice_id, receipt_id: receipt.receipt_id, matched_at: matchedAt };
  rt.store.put(K.matches, match_id, ser({ ...full, loan_id: l.loan_id, application_id: l.application_id, advance_id: l.advance_id, funding_id: l.funding_id, forecast_a_cents: forecast.expected_net_a_cents, forecast_b_cents: forecast.expected_net_b_cents, agent_decision_id: null }) as Record<string, unknown>, ctx.actor, ctx.now);
  const events = recordMatch(ctx.events, keysOf(l), full);
  const okMatch = m.status === "matched" || m.status === "matched_with_variance";
  rt.store.put(K.receipts, receipt.receipt_id, { status: okMatch ? "matched" : "suspense", matched_advice_ids: [advice.purchase_advice_id], loan_id: l.loan_id }, ctx.actor, ctx.now);
  rt.store.put(K.advices, advice.purchase_advice_id, { status: okMatch ? "matched" : "exception", loan_id: l.loan_id }, ctx.actor, ctx.now);
  if (m.convention_action === "lock") rt.store.put(K.partners, l.partner_id, { partner_id: l.partner_id, fnma_interest_convention: m.convention_after, locked_at: matchedAt, locked_by_advice_id: advice.purchase_advice_id, both_conventions_kept: false }, ctx.actor, ctx.now);
  if (m.convention_action === "changed") rt.store.put(K.partners, l.partner_id, { partner_id: l.partner_id, both_conventions_kept: true, last_conflicting_advice_id: advice.purchase_advice_id }, ctx.actor, ctx.now);
  for (const e of m.escalations) rt.escalations.open({ kind: e.kind, ownerRole: e.role, applicationId: l.application_id, ...(l.loan_id ? { loanId: l.loan_id } : {}), severity: e.severity, payload: { reason: e.reason, party: e.party, match_id, exception_kind: m.exception_kind } }, ctx.actor);
  // receipt on SM's books: cash in, forecast cleared, explained variance to the partner, unexplained to suspense
  const explained = okMatch || m.exception_kind === "llpa" || m.exception_kind === "price" || m.exception_kind === "interest" || m.exception_kind === "fees";
  post(ctx, [receiptLedgerSet(l.loan_id!, { value_date: receipt.value_date, received_cents: m.received_cents, expected_cents: m.expected_proceeds_cents, unexplained_cents: explained ? m.variance_breakdown.unexplained_cents : m.variance_cents, collection_account_ref: f.collection_account_ref, receipt_id: receipt.receipt_id })]);
  // exceptions that are Fannie Mae's to correct: funds-transfer errors (30-day e-mail window) and LLPA data corrections (LSDU, $100 minimum) are drafted now for the human filers
  const ppas: string[] = [];
  if (m.funds_transfer_error) ppas.push(draftPpa(rt, ctx, l, advice, "funds_transfer_error", m.variance_breakdown.unexplained_cents !== 0n ? -m.variance_breakdown.unexplained_cents : -m.variance_cents, { exception_kind: m.exception_kind }).ppa_id);
  if (m.exception_kind === "llpa") ppas.push(draftPpa(rt, ctx, l, advice, "data_correction", -m.variance_breakdown.llpa_cents, { llpa_advice_cents: String(advice.llpa_total_cents), llpa_forecast_cents: String(forecast.expected_llpa_cents), cause_owner: "secondary" }).ppa_id);
  putLoan(rt, { ...l, match_id, purchase_advice_id: advice.purchase_advice_id, fnma_loan_number: advice.fnma_loan_number, purchase_date: advice.purchase_date, status: okMatch ? "matched" : "exception" }, ctx);
  const adv = rt.store.get(K.advances, l.advance_id); if (adv) rt.store.put(K.advances, l.advance_id, { proceeds_match_id: match_id }, ctx.actor, ctx.now);
  ctx.decide({ agent: "warehouse", action: "matchProceeds", rationale: `${m.status}${m.exception_kind ? ` (${m.exception_kind})` : ""}: variance ${m.variance_cents} = price ${m.variance_breakdown.price_cents} + llpa ${m.variance_breakdown.llpa_cents} + interest ${m.variance_breakdown.interest_cents} + fees ${m.variance_breakdown.fees_cents} + convention ${m.variance_breakdown.convention_cents} + unexplained ${m.variance_breakdown.unexplained_cents}; convention observed ${m.interest_convention_observed}`, ruleSetVersion: ECONOMICS_RULE_SETS.economics, loanId: l.loan_id ?? ctx.loanId, subject: { kind: "proceeds_match", id: match_id }, ruleCode: "27.2:rule2" });
  return { ...full, events, ppas } as MatchResult & { match_id: string; purchase_advice_id: string; receipt_id: string; matched_at: string; events: DomainEvent[] };
}
function draftPpa(rt: ToolRuntime, ctx: CommandContext, l: SettlementLoan, advice: PurchaseAdviceRecord, kind: PpaKind, amountCents: Cents, attributes: Record<string, unknown>): PpaRequest {
  const ppa_id = `ppa-${l.loan_id}-${kind}-${rt.store.list(K.ppas, (d) => d.loan_id === l.loan_id).length + 1}`;
  const p = preparePpa({ ppa_id, loan_id: l.loan_id!, purchase_advice_id: advice.purchase_advice_id, kind, advice_date: advice.advice_date, purchase_date: advice.purchase_date, amount_cents: amountCents, attributes, seller_number: advice.fnma_servicer_number, fnma_loan_number: advice.fnma_loan_number });
  rt.store.put(K.ppas, ppa_id, ser({ ...p, application_id: l.application_id }) as Record<string, unknown>, ctx.actor, ctx.now);
  if (p.status === "draft") {
    if (p.channel === "lsdu") rt.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: l.application_id, ...(l.loan_id ? { loanId: l.loan_id } : {}), severity: "sev-3", payload: { reason: "ppa_lsdu_data_correction", party: "partner", ppa_id, due_at: p.due_at, platform_target_on: p.platform_target_on, sla: "1 business day", package: "AI-prepared LSDU data-correction package" } }, ctx.actor);
    else rt.escalations.open({ kind: "officer", ownerRole: "officer", applicationId: l.application_id, ...(l.loan_id ? { loanId: l.loan_id } : {}), severity: "sev-1", payload: { reason: "ppa_funds_transfer_correction_letter", party: "partner", ppa_id, due_at: p.due_at, platform_target_on: p.platform_target_on, channel: "acquisitions_loan_delivery@fanniemae.com", form_360_authority: true } }, ctx.actor);
  }
  return p;
}
/** The partner residual package for funding_approver (T3: scheduled the next federal business day; dual control; verified beneficiary). */
function scheduleResidual(rt: ToolRuntime, ctx: CommandContext, l: SettlementLoan, w: Waterfall & { waterfall_id: string }, wv: { id: string; purpose: string; match_result: string } | null): Record<string, unknown> {
  const f = facilityOf(rt, l);
  const pkg = { loan_id: l.loan_id, waterfall_id: w.waterfall_id, advance_id: l.advance_id, amount_cents: String(w.partner_residual_cents), value_date: w.partner_wire_value_date, beneficiary_wire_verification_id: wv?.id ?? null, beneficiary_verified: !!wv && wv.purpose === "partner_residual" && wv.match_result === "verified", from_account_ref: f.collection_account_ref, dual_control: true, idempotency_key: `${w.waterfall_id}:residual` };
  const already = rt.escalations.opened.find((e) => e.kind === "funding_approver" && e.status === "open" && (e.payload.package as { waterfall_id?: string } | undefined)?.waterfall_id === w.waterfall_id);
  const esc = already ?? rt.escalations.open({ kind: "funding_approver", ownerRole: "funding_approver", applicationId: l.application_id, ...(l.loan_id ? { loanId: l.loan_id } : {}), severity: "sev-2", payload: { reason: "partner_residual_wire", package: pkg, sla: "same day; wire value date = next federal business day" } }, ctx.actor);
  return { ...pkg, released: false, escalation_id: esc.id, handed_to: "funding_approver" };
}
const wvOf = (i: ToolInput): { id: string; purpose: string; match_result: string } | null => { const v = i.wire_verification; return v && typeof v === "object" ? { id: String((v as Record<string, unknown>).id ?? ""), purpose: String((v as Record<string, unknown>).purpose ?? ""), match_result: String((v as Record<string, unknown>).match_result ?? "") } : null; };
const gosInputOf = (rt: ToolRuntime, l: SettlementLoan): { g: GainOnSale; advice: PurchaseAdviceRecord; w: Waterfall & { waterfall_id: string } } => {
  const advice = adviceOf(rt, l.purchase_advice_id); const w = waterfallOf(rt, l.waterfall_id);
  if (!advice) throw new RangeError(`loan ${l.loan_id} has no purchase advice`); if (!w) throw new RangeError(`loan ${l.loan_id} has no posted waterfall`);
  const g = computeGainOnSale({ upb_cents: l.upb_cents, quote: l.quote, advice, prepaid_interest_collected_cents: l.prepaid_interest_collected_cents, cd_lender_credit_cents: l.cd_lender_credit_cents, note_rate: l.note_rate, third_party_costs_actual_cents: l.third_party_costs_actual_cents,
    warehouse_interest_cents: w.accrued_interest_cents + w.capitalized_interest_cents, warehouse_fees_cents: w.warehouse_fees_cents, sm_cost_recovery_cents: w.sm_cost_recovery_cents, sm_retained_residual_cents: w.sm_retained_residual_cents });
  return { g, advice, w };
};

// ---- tools ------------------------------------------------------------------
export const TOOLS_27_2: readonly ToolDef[] = defineTools("27.2", "warehouse", [
  // Whole Loan Purchase Advice Sellers API (06:00 ET, hourly to 14:00 ET on business days) / Servicers inventory / manual dual-keyed entry; idempotent by (fnma_loan_number, advice_date); raw JSON retained.
  { name: "pollPurchaseAdvices", kind: "write", handler: compute(async (i, ctx, rt) => {
      const source: PurchaseAdviceRecord["source"] = str(i, "source") === "manual" ? "manual" : str(i, "source") === "connect_report" ? "connect_report" : str(i, "op") === "servicers" ? "purchase_advice_api_servicers" : "purchase_advice_api_sellers";
      if (source === "manual" && !str(i, "second_keyer_id")) throw new RangeError("manual advice entry is dual-keyed: second_keyer_id is required");
      const given = arr(i.advices).map((r) => rawAdvice(r, source));
      const polled = given.length ? [] : source === "purchase_advice_api_servicers" ? await settlementServices(rt).advices.pollServicers(optDate(i.since) ?? etDate(ctx.now)) : source === "purchase_advice_api_sellers" ? await settlementServices(rt).advices.pollSellers(optDate(i.advice_date) ?? etDate(ctx.now)) : [];
      return { source, polled_at: ctx.now, ...ingestAdvices(rt, ctx, given.length ? given : polled) }; }),
    guardrails: [never("NO_UI_AUTOMATION", "§27 overview (7): the Technology Guide's UI-automation ban applies to the Purchase Advice API adapter and the portal islands", (i) => flag(i, "ui_automation"), "advices come from the API, the Connect report (human) or dual-keyed manual entry"),
      never("ADVICE_KEY_MISMATCH", "27.2 guardrails: the agent may never accept an advice that fails the loan-number/seller-number key match", (i) => flag(i, "accept_key_mismatch"), "an advice that does not key to the delivery is stored unmatched and reported, never accepted")] },
  // Bank credits to SM's collection account (intraday notifications / statement import); duplicates → suspense; keyed to the loan from the reference text.
  { name: "ingestReceipts", kind: "write", handler: compute(async (i, ctx, rt) => {
      const f = FACILITY_FIXTURE;
      const given = arr(i.receipts).map((r) => ({ bank_ref: String(r.bank_ref ?? ""), value_date: date(r.value_date, "receipt.value_date"), amount_cents: cents(r.amount_cents), originator_name: String(r.originator_name ?? "Fannie Mae"), reference_text: String(r.reference_text ?? ""), account_ref: String(r.account_ref ?? f.collection_account_ref), received_at: String(r.received_at ?? ctx.now), loan_id: optStr(r.loan_id) }));
      const credits = given.length ? given : (await settlementServices(rt).collectionBank.credits(str(i, "since") || ctx.now)).map((c) => ({ ...c, loan_id: null }));
      const out: Record<string, unknown>[] = [];
      for (const c of credits) {
        if (!c.bank_ref) throw new RangeError("receipt.bank_ref is required");
        const loanRec = c.loan_id ? rt.store.get(K.loans, c.loan_id) : rt.store.list(K.loans, (d) => (typeof d.seller_loan_number === "string" && d.seller_loan_number !== "" && c.reference_text.includes(String(d.seller_loan_number))) || (typeof d.fnma_loan_number === "string" && d.fnma_loan_number !== "" && c.reference_text.includes(String(d.fnma_loan_number))))[0];
        const l = loanRec ? (revive(loanRec.data) as SettlementLoan) : null;
        const dup = rt.store.get(K.receipts, c.bank_ref);
        const row: ProceedsReceiptRecord & { loan_id: string | null; wrong_account: boolean } = { receipt_id: c.bank_ref, bank_ref: c.bank_ref, value_date: c.value_date, amount_cents: c.amount_cents, originator_name: c.originator_name, reference_text: c.reference_text, account_ref: c.account_ref, matched_advice_ids: [], status: dup ? "suspense" : "unmatched", received_at: c.received_at, loan_id: l?.loan_id ?? null, wrong_account: c.account_ref !== f.collection_account_ref };
        if (dup) { if (l) recordProceedsException(ctx.events, keysOf(l), "duplicate_receipt", { bank_ref: c.bank_ref, amount_cents: String(c.amount_cents), disposition: "suspense; return per Fannie Mae's instruction" }, ctx.now); out.push({ receipt_id: c.bank_ref, status: "suspense", duplicate: true }); continue; }
        rt.store.put(K.receipts, c.bank_ref, ser(row) as Record<string, unknown>, ctx.actor, ctx.now);
        recordReceipt(ctx.events, l ? keysOf(l) : null, row, c.received_at);
        if (l && (l.status === "awaiting_purchase" || l.status === "advice_received")) putLoan(rt, { ...l, status: l.status === "advice_received" ? "advice_received" : "proceeds_received" }, ctx);
        out.push({ receipt_id: c.bank_ref, loan_id: l?.loan_id ?? null, amount_cents: String(c.amount_cents), value_date: c.value_date, wrong_account: row.wrong_account });
      }
      return { receipts: out }; }) },
  // Rule 1: register the loan's settlement facts at delivery, post the forecast to purchase_proceeds_receivable, record the certification observation (arms SM_WH_PROCEEDS_EXPECTED_1BD).
  { name: "forecastProceeds", kind: "write", handler: compute((i, ctx, rt) => {
      const op = str(i, "op") || "forecast";
      if (op === "register") { const l = loanRow(rec(i, "loan")); if (!l.loan_id) throw new RangeError("loan.loan_id is required"); putLoan(rt, l, ctx); return { registered: true, loan_id: l.loan_id, status: l.status }; }
      const l = loanOf(rt, i);
      if (op === "certified") {
        const certification_date = date(i.certification_date, "certification_date");
        const e = recordCertificationObserved(ctx.events, keysOf(l), { certification_date, note_form: l.note_form, observed_at: ctx.now, source: l.note_form === "enote" ? "loan_delivery_auto_certification" : "custodian" });
        putLoan(rt, { ...l, certification_date }, ctx); return { certification_date, expected_proceeds_on: e.payload.expected_proceeds_on, event_id: e.id };
      }
      const purchaseDate = optDate(i.purchase_date) ?? l.purchase_date ?? l.expected_purchase_date;
      const f = forecastFor(l, purchaseDate);
      const posted = l.forecast_posted ? [] : post(ctx, [forecastLedgerSet(l.loan_id!, etDate(ctx.now), expectedNet(f, partnerConvention(rt, l.partner_id)))]);
      putLoan(rt, { ...l, forecast_posted: true }, ctx);
      ctx.events.append({ type: "settlement.forecast.posted", loanId: l.loan_id ?? undefined, applicationId: l.application_id, actor: ctx.actor, payload: { application_id: l.application_id, purchase_date: purchaseDate, expected_net_a_cents: String(f.expected_net_a_cents), expected_net_b_cents: String(f.expected_net_b_cents), matrix_version: f.matrix_version, ledger_entry_set_ids: posted } } as Parameters<typeof ctx.events.append>[0]);
      return { ...(ser(f) as Record<string, unknown>), purchase_date: purchaseDate, ledger_entry_set_ids: posted }; }) },
  // Rule 2: the three-way match on the first of advice / receipt; provisional match (receipt, no advice by 14:00 ET); missing-advice exception with the Connect fallback; manual match needs two SM users.
  { name: "matchProceeds", kind: "write", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i);
      const receipt = str(i, "receipt_id") ? receiptOf(rt, str(i, "receipt_id")) : latestReceiptFor(rt, l.loan_id!);
      const advice = adviceOf(rt, str(i, "advice_id") || l.purchase_advice_id);
      if (!receipt) return { status: "awaiting_receipt", advice_id: advice?.purchase_advice_id ?? null, expected_proceeds_on: l.certification_date ? l.certification_date : null, reason: "advice leg held; the expected-proceeds clock (SM_WH_PROCEEDS_EXPECTED_1BD) runs from certification" };
      if (!advice) {
        const p = provisionalMatch(receipt.amount_cents, forecastFor(l, l.expected_purchase_date), partnerConvention(rt, l.partner_id), ctx.now);
        const miss = missingAdvice(receipt.value_date, etDate(ctx.now));
        if (miss.missing) {
          recordProceedsException(ctx.events, keysOf(l), "missing_advice", { receipt_id: receipt.receipt_id, value_date: receipt.value_date, deadline: miss.deadline, fallback: "Fannie Mae Connect Whole Loan Purchase Advice report" }, ctx.now);
          const esc = rt.escalations.open({ kind: "human_portal_task", ownerRole: "fnma_portal_operator", applicationId: l.application_id, ...(l.loan_id ? { loanId: l.loan_id } : {}), severity: "sev-2", payload: { reason: "connect_report_fallback", task: "retrieve the Whole Loan Purchase Advice report from Fannie Mae Connect and enter it (fnma_portal_operator op=connect_report)", receipt_id: receipt.receipt_id, party: "partner" } }, ctx.actor);
          putLoan(rt, { ...l, status: "exception" }, ctx);
          return { status: "exception", exception_kind: "missing_advice", deadline: miss.deadline, escalation_id: esc.id, handed_to: "fnma_portal_operator" };
        }
        if (!p.provisional) return { status: "held", reason: p.reason, variance_cents: String(p.variance_cents) };
        const match_id = `pm-${l.loan_id}-${rt.store.list(K.matches, (d) => d.loan_id === l.loan_id).length + 1}`;
        rt.store.put(K.matches, match_id, ser({ match_id, loan_id: l.loan_id, application_id: l.application_id, advance_id: l.advance_id, receipt_id: receipt.receipt_id, purchase_advice_id: null, status: "provisional", received_cents: receipt.amount_cents, variance_cents: p.variance_cents, matched_at: ctx.now, tolerance_rule_applied: "provisional_forecast_within_10000_cents" }) as Record<string, unknown>, ctx.actor, ctx.now);
        rt.store.put(K.receipts, receipt.receipt_id, { status: "provisional" }, ctx.actor, ctx.now);
        recordProvisionalMatch(ctx.events, keysOf(l), { match_id, receipt_id: receipt.receipt_id, variance_cents: p.variance_cents, at: ctx.now });
        putLoan(rt, { ...l, match_id, status: "proceeds_received" }, ctx);
        return { status: "provisional", match_id, variance_cents: String(p.variance_cents), confirmed_when: "purchase_advice.received", reason: p.reason };
      }
      if (str(i, "op") === "manual" && (!str(i, "first_user_id") || !str(i, "second_user_id") || str(i, "first_user_id") === str(i, "second_user_id"))) throw new RangeError("manual match requires two SM users (first_user_id, second_user_id)");
      const m = runMatch(rt, ctx, l, advice, receipt, i.received_cents !== undefined ? cents(i.received_cents) : null, str(i, "matched_at") || ctx.now);
      const { events, ...rest } = m;
      return { ...(ser(rest) as Record<string, unknown>), event_ids: events.map((e) => e.id) }; }),
    guardrails: [never("ADVICE_KEY_MISMATCH", "27.2 guardrails: the agent may never accept an advice that fails the loan-number/seller-number key match", (i) => flag(i, "accept_key_mismatch"), "keys are matched by code; no override"),
      never("NO_BORROWER_ADJUSTMENT", "27.2 guardrails: the agent may never change the borrower's terms or post a borrower adjustment", (i) => flag(i, "borrower_adjustment"), "the borrower's benefit is fixed at closing (rule 6)")] },
  // The deterministic component-by-component explanation (price, LLPA, interest incl. convention, fees, unexplained) — the LLM drafts the partner-facing narrative from these numbers only.
  { name: "explainVariance", kind: "read", handler: compute((i, _ctx, rt) => {
      need(i, "match_id"); const m = matchOf(rt, str(i, "match_id")); if (!m) throw new RangeError(`no proceeds match ${str(i, "match_id")}`);
      const l = revive(rt.store.require(K.loans, m.loan_id).data) as SettlementLoan; const advice = adviceOf(rt, m.purchase_advice_id);
      const bd = advice ? explainVariance(forecastFor(l, advice.purchase_date), advice, m.received_cents, m.convention_basis, m.interest_convention_observed) : { variance_cents: m.variance_cents, breakdown: m.variance_breakdown };
      const lines = Object.entries(bd.breakdown).filter(([, v]) => v !== 0n).map(([k, v]) => `${k.replace("_cents", "")}: ${v > 0n ? "+" : ""}${v} cents`);
      return { match_id: m.match_id, status: m.status, exception_kind: m.exception_kind, variance_cents: String(bd.variance_cents), variance_breakdown: ser(bd.breakdown), convention_basis: m.convention_basis, interest_convention_observed: m.interest_convention_observed, explanation_order: ["price", "llpa", "interest", "fees", "convention", "unexplained"],
        deterministic_summary: lines.length ? lines.join("; ") : "no variance", narrative: { drafted_by: "llm", numbers_by: "code", status: "draft_for_partner", text: null }, rule_set_versions: ECONOMICS_RULE_SETS }; }) },
  // Rule 3: the waterfall the same day as the match (value date = receipt value date) with the 27.1 payoff; repays the warehouse (`warehouse.advance.repaid{repaid_from=purchase_proceeds}`), issues the releases, drafts a shortfall or schedules the partner residual.
  { name: "postWaterfall", kind: "write", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i); const op = str(i, "op") || "post";
      if (op === "shortfall_received") {
        const w = waterfallOf(rt, l.waterfall_id); if (!w) throw new RangeError(`loan ${l.loan_id} has no posted waterfall`);
        const amount = cents(i.amount_cents); if (amount <= 0n) throw new RangeError("amount_cents must be > 0");
        const f = facilityOf(rt, l); const posted = post(ctx, [shortfallReceivedLedgerSet(l.loan_id!, w, etDate(ctx.now), amount, f.haircut_reserve_account_ref)]);
        const repaidInFull = amount + w.shortfall_received_cents >= w.shortfall_cents;
        const events = recordShortfallReceived(ctx.events, { ...keysOf(l), note_form: l.note_form }, { waterfall_id: w.waterfall_id, amount_cents: amount, received_at: ctx.now, source: str(i, "source") === "partner_wire" ? "partner_wire" : "haircut_reserve_draw", match_id: w.match_id, repaid_in_full: repaidInFull });
        rt.store.put(K.waterfalls, w.waterfall_id, { shortfall_received_cents: String(w.shortfall_received_cents + amount) }, ctx.actor, ctx.now);
        if (repaidInFull) { const adv = rt.store.get(K.advances, l.advance_id); if (adv) rt.store.put(K.advances, l.advance_id, { status: "repaid", repaid_at: ctx.now, repaid_from: "purchase_proceeds", outstanding_principal_cents: "0", capitalized_interest_cents: "0", fees_outstanding_cents: "0" }, ctx.actor, ctx.now); }
        return { received_cents: String(amount), repaid_in_full: repaidInFull, ledger_entry_set_ids: posted, event_ids: events.map((e) => e.id) };
      }
      const m = matchOf(rt, str(i, "match_id") || l.match_id); if (!m) throw new RangeError(`loan ${l.loan_id} has no three-way match`);
      if (m.status === "provisional") throw new RangeError("a provisional match is not settled until the advice confirms it");
      if (m.exception_kind === "wrong_account") refuse(ctx, "PROCEEDS_NOT_IN_SM_ACCOUNT", "27.2 rule 2 / 27.1 bailee letter: the release is conditioned on delivery of the proceeds to SM's account", "proceeds were credited to another account — no waterfall, C2-2-05 request the same day, collateral chain stays open", { match_id: m.match_id });
      if (l.waterfall_id) throw new RangeError(`waterfall ${l.waterfall_id} already posted for loan ${l.loan_id}`);
      const receipt = receiptOf(rt, m.receipt_id);
      const actualCosts = i.third_party_costs_actual_cents !== undefined ? cents(i.third_party_costs_actual_cents) : l.third_party_costs_actual_cents;
      const payoff = payoffFor(rt, l, receipt.value_date, i.payoff && typeof i.payoff === "object" ? (i.payoff as Record<string, unknown>) : null);
      const w = settlementWaterfall({ received_cents: m.received_cents, payoff, third_party_costs_actual_cents: actualCosts, quote_third_party_costs_cents: l.quote.third_party_costs_cents, quote_sm_retained_cents: l.quote.sm_retained_cents, value_date: receipt.value_date });
      const sets = waterfallLedgerSets(l.loan_id!, w, l.upb_cents);
      const posted = post(ctx, [...(l.cost_receivable_posted ? [] : [costRecoveryReceivableSet(l.loan_id!, receipt.value_date, actualCosts)]), sets.sm, sets.partner_mirror]);
      const waterfall_id = `wf-${l.loan_id}-${rt.store.list(K.waterfalls, (d) => d.loan_id === l.loan_id).length + 1}`;
      rt.store.put(K.waterfalls, waterfall_id, ser({ ...w, waterfall_id, match_id: m.match_id, loan_id: l.loan_id, advance_id: l.advance_id, posted_at: ctx.now, settled_at: ctx.now, ledger_entry_ids: posted, partner_wire_ref: null, shortfall_received_cents: 0n }) as Record<string, unknown>, ctx.actor, ctx.now);
      const events = recordWaterfall(ctx.events, { ...keysOf(l), note_form: l.note_form }, w, { waterfall_id, match_id: m.match_id, posted_at: ctx.now, ledger_entry_ids: posted });
      let releases: ReturnType<typeof releasePlan> | null = null;
      if (w.warehouse_repaid_in_full) {
        const adv = rt.store.get(K.advances, l.advance_id); if (adv) rt.store.put(K.advances, l.advance_id, { status: "repaid", repaid_at: ctx.now, repaid_from: "purchase_proceeds", outstanding_principal_cents: "0", capitalized_interest_cents: "0", fees_outstanding_cents: "0", proceeds_match_id: m.match_id, collateral_status: "released" }, ctx.actor, ctx.now);
        releases = releasePlan(l.note_form, receipt.value_date);
        events.push(...recordReleases(ctx.events, { ...keysOf(l), note_form: l.note_form, bailee_letter_id: l.bailee_letter_id, custodian_party_id: l.custodian_party_id, min: l.min }, releases, ctx.now));
      }
      const next = putLoan(rt, { ...l, waterfall_id, third_party_costs_actual_cents: actualCosts, cost_receivable_posted: true, releases_issued: releases !== null, status: w.warehouse_repaid_in_full ? "settled" : "exception" }, ctx);
      const residual = w.partner_wire_required ? scheduleResidual(rt, ctx, next, { ...w, waterfall_id }, wvOf(i)) : null;
      ctx.decide({ agent: "warehouse", action: "postWaterfall", rationale: JSON.stringify(settlementDecisionRecord({ match_id: m.match_id, keys: keysOf(l), expected: m.expected_proceeds_cents, advice: m.advice_proceeds_cents, received: m.received_cents, breakdown: m.variance_breakdown, convention_used: m.convention_basis, waterfall: w, releases, gos: null, passthrough_status: null, ppa_decision: null, outcome: w.warehouse_repaid_in_full ? "repaid" : "shortfall_drafted", rationale: "LSA waterfall (rule 3)", llm: { model_version: ctx.run?.modelVersion ?? null, prompt_version: ctx.run?.promptVersion ?? null }, reviewer: null })), ruleSetVersion: ECONOMICS_RULE_SETS.warehouse, loanId: l.loan_id ?? ctx.loanId, subject: { kind: "settlement_waterfall", id: waterfall_id }, ruleCode: "27.2:rule3" });
      return { waterfall_id, ...(ser(w) as Record<string, unknown>), payoff: ser(payoff), releases, residual_package: residual, ledger_entry_set_ids: posted, event_ids: events.map((e) => e.id) }; }),
    guardrails: [never("COST_RECOVERY_CAPPED", "27.2 guardrails: the agent may never alter SM's cost recovery above the invoice/cap (forecast × 110%)", (i) => flag(i, "override_cost_cap") || flag(i, "raise_cost_recovery"), "cost recovery = min(actual invoices, quote forecast × 1.10); the excess is SM's"),
      never("NO_FEE_DRAFT_NETTING", "27.2 guardrails: never net a commitment fee draft against proceeds (Committing and Delivery Fee Draft Notifications are matched to 29.1 records)", (i) => flag(i, "net_commitment_fee_draft"), "commitment-level fees are drafted separately and are not expected on the wire"),
      needsRole("WRITEOFF_SETOFF_NEEDS_OFFICER", "27.2 guardrails: the agent may never write off a shortfall or set off partner funds without officer{sm}", (i) => str(i, "op") === "write_off" || str(i, "op") === "set_off", ["officer"], "write-offs and set-offs are officer{sm} decisions"),
      never("NO_BORROWER_ADJUSTMENT", "27.2 guardrails: never change the borrower's terms or post a borrower adjustment", (i) => flag(i, "borrower_adjustment"), "no post-closing borrower adjustment (policy off)")] },
  // Rule 4: paper — bailee letter released the same day, Interim Funder removal within 2 business days (30.1 performs the MIN Update; 27.2 consumes `warehouse.interim_funder.removed`); eNote — Funding Agreement release on payment closes the chain.
  { name: "releaseCollateral", kind: "write", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i); const w = waterfallOf(rt, l.waterfall_id);
      if (!w || !w.warehouse_repaid_in_full) throw new RangeError(`advance ${l.advance_id} is not repaid — releases follow the payoff (C2-2-03: released no later than the date Fannie Mae acquires the note)`);
      const plan = releasePlan(l.note_form, w.value_date);
      const removed = ctx.events.all().find((e) => e.type === "warehouse.interim_funder.removed" && (e.loanId === l.loan_id || (e.payload as Record<string, unknown>).application_id === l.application_id)) ?? null;
      const events = l.releases_issued ? [] : recordReleases(ctx.events, { ...keysOf(l), note_form: l.note_form, bailee_letter_id: l.bailee_letter_id, custodian_party_id: l.custodian_party_id, min: l.min }, plan, ctx.now);
      if (!l.releases_issued) putLoan(rt, { ...l, releases_issued: true }, ctx);
      return { ...plan, interim_funder_removed: removed !== null, interim_funder_removed_event_id: removed?.id ?? null, collateral_chain: plan.note_form === "paper" ? (removed ? "closed" : "open_pending_interim_funder") : "closed", enote_secured_party_released_at: plan.note_form === "enote" ? ctx.now : null, event_ids: events.map((e) => e.id) }; }) },
  // Rule 3 step 6: the partner residual package for funding_approver (dual control; beneficiary re-verified as `wire_verifications{purpose=partner_residual}`); netting against a haircut-reserve top-up per the LSA (27.2-Q5).
  { name: "schedulePartnerResidual", kind: "act", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i); const w = waterfallOf(rt, l.waterfall_id); if (!w) throw new RangeError(`loan ${l.loan_id} has no posted waterfall`);
      if (!w.partner_wire_required) return { scheduled: false, reason: w.shortfall_cents > 0n ? "shortfall: no partner residual wire (rule 3)" : "no residual" };
      if (w.partner_wire_ref) return { scheduled: false, reason: `residual already paid (${w.partner_wire_ref})` };
      const wv = wvOf(i);
      if (wv && !(wv.purpose === "partner_residual" && wv.match_result === "verified")) refuse(ctx, "RESIDUAL_BENEFICIARY_UNVERIFIED", "27.2 edge cases: partner residual beneficiary changed → no wire until wire_verifications{purpose=partner_residual} is re-verified by callback to the LSA notice contacts", `wire verification ${wv.id} is ${wv.purpose}/${wv.match_result}`, { waterfall_id: w.waterfall_id });
      const topup = cents(i.haircut_topup_due_cents);
      const pkg = scheduleResidual(rt, ctx, l, w, wv);
      return { ...pkg, net_of_haircut_topup_cents: topup > 0n ? String(w.partner_residual_cents - (topup < w.partner_residual_cents ? topup : w.partner_residual_cents)) : null }; }),
    guardrails: [never("RESIDUAL_NEEDS_FUNDING_APPROVER", "27.2 guardrails: the agent may never release a partner residual wire without funding_approver", (i) => str(i, "op") === "release", "the outbound wire is a human funding_approver act (dual control)"),
      never("NO_BORROWER_ADJUSTMENT", "27.2 guardrails: never post a borrower adjustment", (i) => flag(i, "borrower_adjustment"), "no post-closing borrower adjustment (policy off)")] },
  // The human dual-control release of the partner residual: funding_approver approves the package and the wire goes out through 27.1's bank port; agents are refused by the bus (HUMAN_ONLY).
  { name: "funding_approver", kind: "act", humanOnly: true, humanRoles: ["funding_approver"], handler: compute(async (i, ctx, rt) => {
      const l = loanOf(rt, i); const w = waterfallOf(rt, l.waterfall_id); if (!w) throw new RangeError(`loan ${l.loan_id} has no posted waterfall`);
      if (!w.partner_wire_required || !w.partner_wire_value_date) throw new RangeError("no partner residual to release");
      if (w.partner_wire_ref) throw new RangeError(`residual already paid (${w.partner_wire_ref})`);
      const f = facilityOf(rt, l); const approval_id = `fa-residual-${w.waterfall_id}`;
      const ap: WireApproval = { approval_id, approved_by: ctx.actor, approved_at: ctx.now, wire_cents: w.partner_residual_cents };
      rt.store.put(K.approvals, approval_id, { approval_id, waterfall_id: w.waterfall_id, loan_id: l.loan_id, approved_by: ctx.actor, approved_at: ctx.now, wire_cents: String(w.partner_residual_cents), purpose: "partner_residual", dual_control: true }, ctx.actor, ctx.now);
      const wire = await warehouseServices(rt).bank.releaseWire({ advance_id: l.advance_id, value_date: w.partner_wire_value_date, amount_cents: w.partner_residual_cents, beneficiary_wire_verification_id: str(i, "wire_verification_id") || "wv-partner-residual", funding_account_ref: f.collection_account_ref, idempotency_key: `${w.waterfall_id}:residual` }, ap);
      const posted = wire.duplicate ? [] : post(ctx, [residualPaidLedgerSet(l.loan_id!, wire.value_date, w.partner_residual_cents, f.collection_account_ref)]);
      const e = recordResidualPaid(ctx.events, keysOf(l), { wire_ref: wire.wire_out_id, value_date: wire.value_date, amount_cents: w.partner_residual_cents, approval_id, paid_at: ctx.now });
      rt.store.put(K.waterfalls, w.waterfall_id, { partner_wire_ref: wire.wire_out_id, partner_wire_value_date: wire.value_date }, ctx.actor, ctx.now);
      for (const esc of rt.escalations.opened) if (esc.kind === "funding_approver" && esc.status === "open" && (esc.payload.package as { waterfall_id?: string } | undefined)?.waterfall_id === w.waterfall_id) { esc.status = "completed"; esc.completedAt = ctx.now; esc.completedBy = `${ctx.actor.kind}:${ctx.actor.id}`; }
      return { approval_id, wire_ref: wire.wire_out_id, value_date: wire.value_date, amount_cents: String(w.partner_residual_cents), ledger_entry_set_ids: posted, event_id: e.id }; }) },
  // Rules 5 and 7: the partner's gain on sale (program and GAAP views) computed by SM as its agent; premium recapture posts the partner-mirror reversal and closes the exposure; SM's cost recovery is never clawed back.
  { name: "computeGainOnSale", kind: "write", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i); const op = str(i, "op") || "compute";
      if (op === "premium_recapture") {
        const g = gosOf(rt, l.gos_id); if (!g) throw new RangeError(`loan ${l.loan_id} has no gain-on-sale computation`);
        const r = assessPremiumRecapture(g, { payoff_date: date(i.payoff_date, "payoff_date"), assessed_cents: cents(i.assessed_cents), purchase_date: l.purchase_date ?? g.recapture_exposure_until });
        const posted = post(ctx, [recaptureReversalLedgerSet(l.loan_id!, etDate(ctx.now), r.assessed_cents)]);
        rt.store.put(K.gos, g.gos_id, { recapture_exposure_cents: "0", recapture_assessed_cents: String(r.assessed_cents), recapture_assessed_at: ctx.now, recapture_within_window: r.within_window }, ctx.actor, ctx.now);
        const e = recordPremiumRecapture(ctx.events, keysOf(l), { gos_id: g.gos_id, assessed_cents: r.assessed_cents, payoff_date: date(i.payoff_date, "payoff_date"), within_window: r.within_window, fnma_reference: str(i, "fnma_reference"), at: ctx.now, ledger_entry_id: posted[0] ?? null });
        return { ...r, recapture_exposure_cents: "0", sm_cost_recovery_cents: String(r.sm_cost_recovery_cents_after), ledger_entry_set_ids: posted, event_id: e.id };
      }
      const { g } = gosInputOf(rt, l);
      const gos_id = l.gos_id ?? `gos-${l.loan_id}-${rt.store.list(K.gos, (d) => d.loan_id === l.loan_id).length + 1}`;
      rt.store.put(K.gos, gos_id, ser({ ...g, gos_id, loan_id: l.loan_id, application_id: l.application_id, quote_id: l.quote.quote_id, lock_id: l.lock_id, purchase_advice_id: l.purchase_advice_id, posted_at: null, recapture_assessed_cents: null }) as Record<string, unknown>, ctx.actor, ctx.now);
      putLoan(rt, { ...l, gos_id }, ctx);
      const e = recordGosComputed(ctx.events, keysOf(l), { gos_id, g, at: ctx.now });
      return { gos_id, ...(ser(g) as Record<string, unknown>), event_id: e.id }; }),
    guardrails: [never("NO_COST_RECOVERY_CLAWBACK", "27.2 rule 7 / 27.2-Q4: the partner bears Fannie Mae's recapture as seller; SM's cost recovery is not clawed back", (i) => flag(i, "claw_back_cost_recovery"), "recapture is allocated to the partner"),
      never("COST_RECOVERY_CAPPED", "27.2 guardrails: never alter SM's cost recovery above the invoice/cap", (i) => flag(i, "override_cost_cap"), "cost recovery is the waterfall's figure")] },
  // Rule 6: the term-sheet proof — expected (lock) vs actual (advice + invoices) with the evidence lineage; posts the gain (SM_GOS_POST_1BD) and feeds compliance-sentinel on exceptions (31.2).
  { name: "reconcilePassthrough", kind: "write", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i); const g = gosOf(rt, l.gos_id) ?? (() => { const { g: fresh } = gosInputOf(rt, l); return { ...fresh, gos_id: `gos-${l.loan_id}-1`, recapture_assessed_cents: null }; })();
      if (!l.gos_id) rt.store.put(K.gos, g.gos_id, ser({ ...g, loan_id: l.loan_id, application_id: l.application_id, quote_id: l.quote.quote_id, lock_id: l.lock_id, purchase_advice_id: l.purchase_advice_id }) as Record<string, unknown>, ctx.actor, ctx.now);
      const recon = reconcilePassthrough(g, { note_rate: l.note_rate, cd_lender_credit_cents: l.cd_lender_credit_cents, evidence: { ...l.evidence, purchase_advice_document_id: l.evidence.purchase_advice_document_id || (l.purchase_advice_id ? `doc:${l.purchase_advice_id}.json` : "") } });
      const recon_id = `rpr-${l.loan_id}-${rt.store.list(K.recons, (d) => d.loan_id === l.loan_id).length + 1}`;
      rt.store.put(K.recons, recon_id, ser({ ...recon, recon_id, loan_id: l.loan_id, application_id: l.application_id, gos_id: g.gos_id, quote_id: l.quote.quote_id, lock_id: l.lock_id, disclosure_id_cd_final: l.disclosure_id_cd_final, solve_trace_document_id: l.evidence.quote_solve_trace_document_id }) as Record<string, unknown>, ctx.actor, ctx.now);
      const posted = post(ctx, [gosMemoLedgerSet(l.loan_id!, etDate(ctx.now), g)]);
      rt.store.put(K.gos, g.gos_id, { posted_at: ctx.now, memo_ledger_entry_ids: posted }, ctx.actor, ctx.now);
      const events = recordPassthroughReconciled(ctx.events, keysOf(l), { gos_id: g.gos_id, recon_id, recon, at: ctx.now });
      const feed = recon.status === "exception" ? rt.escalations.open({ kind: "sev3", ownerRole: "compliance", applicationId: l.application_id, ...(l.loan_id ? { loanId: l.loan_id } : {}), severity: "sev-3", payload: { reason: "passthrough_exception", feed: "compliance-sentinel → 31.2 fair-lending/UDAAP review", flags: [...recon.flags], recon_id } }, ctx.actor) : null;
      putLoan(rt, { ...l, gos_id: g.gos_id, recon_id, status: l.status === "settled" && l.handoff_id ? "closed" : l.status }, ctx);
      return { recon_id, gos_id: g.gos_id, ...(ser(recon) as Record<string, unknown>), partner_origination_result_cents: String(g.actual.partner_origination_result_cents), compliance_feed_escalation_id: feed?.id ?? null, ledger_entry_set_ids: posted, event_ids: events.map((e) => e.id) }; }),
    guardrails: [never("NO_BORROWER_ADJUSTMENT", "27.2 rule 6 / 27.2-Q2: no post-closing borrower adjustment (policy flag economics.post_closing_borrower_credit = off)", (i) => flag(i, "borrower_post_closing_credit") || flag(i, "borrower_adjustment"), "the borrower's benefit is fixed at closing; variances settle between SM and the partner")] },
  // Rule 8: the MSR data file to the partner's accounting channel within 1 business day of the match (purchase advice attached); no valuation.
  { name: "issueMsrHandoff", kind: "write", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i); const op = str(i, "op") || "issue";
      if (op === "ack") { if (!l.handoff_id) throw new RangeError(`loan ${l.loan_id} has no MSR hand-off`); rt.store.put(K.msr, l.handoff_id, { acknowledged_at: ctx.now }, ctx.actor, ctx.now); const e = recordMsrAcknowledged(ctx.events, keysOf(l), { handoff_id: l.handoff_id, at: ctx.now }); putLoan(rt, { ...l, status: l.recon_id && l.status === "settled" ? "closed" : l.status }, ctx); return { handoff_id: l.handoff_id, acknowledged_at: ctx.now, event_id: e.id }; }
      const advice = adviceOf(rt, l.purchase_advice_id); if (!advice) throw new RangeError(`loan ${l.loan_id} has no purchase advice — the hand-off follows the match`);
      const payload: MsrPayload = msrHandoffPayload({ fnma_loan_number: advice.fnma_loan_number, seller_loan_number: l.seller_loan_number, upb_at_purchase_cents: advice.upb_cents, note_rate: l.note_rate, pass_through_rate: advice.pass_through_rate, remittance_type: advice.remittance_type, purchase_date: advice.purchase_date, first_payment_date: l.first_payment_date, lpi_date: advice.lpi_date, term_months: l.term_months, amortization_type: l.amortization_type, product_code: l.product_code, pi_cents: l.pi_cents, escrow_indicator: l.escrow_indicator, mi_flag: l.mi_flag, occupancy: l.occupancy, property_state: l.property_state, sfc_codes: l.sfc_codes });
      const channel = (str(i, "channel") === "sftp" ? "sftp" : str(i, "channel") === "portal" ? "portal" : "partner_api") as "partner_api" | "sftp" | "portal";
      const handoff_id = l.handoff_id ?? `msr-${l.loan_id}-1`;
      rt.store.put(K.msr, handoff_id, ser({ handoff_id, loan_id: l.loan_id, application_id: l.application_id, partner_id: l.partner_id, purchase_advice_id: advice.purchase_advice_id, payload, delivered_at: ctx.now, channel, acknowledged_at: null, schema_version: MSR_SCHEMA_VERSION, attachments: [advice.raw_document_id] }) as Record<string, unknown>, ctx.actor, ctx.now);
      putLoan(rt, { ...l, handoff_id }, ctx);
      const e = recordMsrHandoff(ctx.events, keysOf(l), { handoff_id, channel, payload, purchase_advice_id: advice.purchase_advice_id, at: ctx.now });
      return { handoff_id, channel, schema_version: MSR_SCHEMA_VERSION, payload: ser(payload), attachments: [advice.raw_document_id], valuation: null, event_id: e.id }; }),
    guardrails: [never("NO_MSR_VALUATION", "27.2 rule 8 / discrepancy 6: SM hands data; valuation and the ASC 860-50 entry are the partner's", (i) => flag(i, "include_valuation") || i.valuation !== undefined, "the hand-off carries no valuation field")] },
  // Rule 9: the monthly platform fee (1st, 03:00 ET) per purchased loan — prorated first/last periods, UPB as of the 1st otherwise; posted to platform_fee_receivable / platform_fee_income.
  { name: "accruePlatformFee", kind: "write", handler: compute((i, ctx, rt) => {
      need(i, "period"); const period = str(i, "period");
      const loans = str(i, "loan_id") ? [loanOf(rt, i)] : rt.store.list(K.loans, (d) => typeof d.purchase_date === "string" && d.purchase_date !== "").map((r) => revive(r.data) as SettlementLoan);
      const out: Record<string, unknown>[] = [];
      for (const l of loans) {
        if (!l.purchase_date) throw new RangeError(`loan ${l.loan_id} has no Fannie Mae purchase date — accrual begins at purchase (27.2-Q3)`);
        if (l.purchase_date > `${period}-31`) { out.push({ loan_id: l.loan_id, period, skipped: "before purchase" }); continue; }
        const accrual_id = `pfa-${l.loan_id}-${period}`;
        if (rt.store.get(K.fees, accrual_id)) { out.push({ loan_id: l.loan_id, period, skipped: "already accrued" }); continue; }
        const upb = i.upb_basis_cents !== undefined && str(i, "loan_id") ? cents(i.upb_basis_cents) : l.upb_cents;
        const a = platformFeeAccrual({ upb_basis_cents: upb, period, purchase_date: l.purchase_date, payoff_date: optDate(i.payoff_date) });
        const posted = post(ctx, [platformFeeLedgerSet(l.loan_id!, etDate(ctx.now), a)]);
        rt.store.put(K.fees, accrual_id, ser({ ...a, accrual_id, loan_id: l.loan_id, application_id: l.application_id, posted_at: ctx.now, invoice_id: null, ledger_entry_id: posted[0] ?? null }) as Record<string, unknown>, ctx.actor, ctx.now);
        const e = recordPlatformFee(ctx.events, keysOf(l), a, { accrual_id, at: ctx.now, ledger_entry_id: posted[0] ?? null });
        out.push({ accrual_id, loan_id: l.loan_id, ...(ser(a) as Record<string, unknown>), event_id: e.id });
      }
      return { period, accruals: out, current_period: periodOf(etDate(ctx.now)) }; }) },
  // Rule 10: the 20:00 ET export — every balanced ledger set created that day once (idempotent by entry id) for sm_gl and the partner_gl mirror; control totals and hash; acknowledgments.
  { name: "exportGl", kind: "write", handler: compute((i, ctx, rt) => {
      const period_date = optDate(i.period_date) ?? etDate(ctx.now); const facilityId = str(i, "facility_id") || FACILITY_FIXTURE.facility_id;
      if (str(i, "op") === "ack") { need(i, "batch_id"); const b = rt.store.require(K.gl, str(i, "batch_id")); rt.store.put(K.gl, b.id, { acknowledged_at: ctx.now, status: "acknowledged" }, ctx.actor, ctx.now); return { batch_id: b.id, acknowledged_at: ctx.now }; }
      const state = rt.store.get(K.glState, "exported"); const already = new Set<string>(Array.isArray(state?.data.line_ids) ? (state!.data.line_ids as string[]) : []);
      const r = buildGlBatches(ctx.ledger.sets(), period_date, already, ctx.now);
      const batches: GlBatch[] = [r.sm_gl, r.partner_gl];
      for (const b of batches) { const prev = rt.store.get(K.gl, b.batch_id); const merged = prev && b.line_count === 0 ? null : b; if (merged) rt.store.put(K.gl, b.batch_id, ser(prev ? { ...merged, lines: [...(prev.data.lines as unknown[]), ...merged.lines], line_count: Number(prev.data.line_count) + merged.line_count, rerun: true } : merged) as Record<string, unknown>, ctx.actor, ctx.now); }
      rt.store.put(K.glState, "exported", { line_ids: [...already, ...r.exported_line_ids] }, ctx.actor, ctx.now);
      const events = batches.map((b) => recordGlExport(ctx.events, facilityId, b, ctx.now));
      return { period_date, batches: batches.map((b) => ({ batch_id: b.batch_id, target: b.target, line_count: b.line_count, control_totals: ser(b.control_totals), hash: b.hash, status: b.status })), new_lines: r.exported_line_ids.length, event_ids: events.map((e) => e.id) }; }) },
  // Rule 11: PPA packages — funds-transfer corrections (e-mail, 30 days, officer{partner} signature) and LSDU data corrections ($100 minimum; human fnma_portal_operator{party=partner}); settlements re-enter as receipts.
  { name: "preparePpa", kind: "write", handler: compute((i, ctx, rt) => {
      const l = loanOf(rt, i); const op = str(i, "op") || "prepare";
      if (op === "prepare") {
        const advice = adviceOf(rt, str(i, "advice_id") || l.purchase_advice_id); if (!advice) throw new RangeError(`loan ${l.loan_id} has no purchase advice`);
        const kind: PpaKind = str(i, "kind") === "data_correction" ? "data_correction" : str(i, "kind") === "funds_transfer_error" ? "funds_transfer_error" : (() => { throw new RangeError("kind must be funds_transfer_error or data_correction"); })();
        const p = draftPpa(rt, ctx, l, advice, kind, cents(i.amount_cents), (i.attributes && typeof i.attributes === "object" ? i.attributes : {}) as Record<string, unknown>);
        return { ...(ser(p) as Record<string, unknown>), handed_to: p.channel === "lsdu" ? "fnma_portal_operator{party=partner}" : "officer{party=partner}" };
      }
      need(i, "ppa_id"); const p = revive(rt.store.require(K.ppas, str(i, "ppa_id")).data) as PpaRequest;
      if (op === "submit") {
        assertPpaSubmitter(p, ctx.actor);
        rt.store.put(K.ppas, p.ppa_id, { status: "submitted", requested_at: ctx.now, submitted_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now);
        const e = recordPpaRequested(ctx.events, keysOf(l), p, ctx.actor, ctx.now); putLoan(rt, { ...l, status: l.status === "exception" ? "ppa_requested" : l.status }, ctx);
        return { ppa_id: p.ppa_id, kind: p.kind, channel: p.channel, status: "submitted", due_at: p.due_at, event_id: e.id };
      }
      if (op === "resolve") {
        const resolution = cents(i.resolution_cents); const outcome = (str(i, "outcome") || "settled") as "accepted" | "rejected" | "settled";
        rt.store.put(K.ppas, p.ppa_id, { status: outcome, resolution_cents: String(resolution), resolved_at: ctx.now, fnma_reference: str(i, "fnma_reference") }, ctx.actor, ctx.now);
        const e = recordPpaResolved(ctx.events, keysOf(l), p, { resolution_cents: resolution, fnma_reference: str(i, "fnma_reference"), resolved_at: ctx.now, outcome });
        let receipt_id: string | null = null;
        if (resolution !== 0n) { receipt_id = `ppa-settlement-${p.ppa_id}`; rt.store.put(K.receipts, receipt_id, ser({ receipt_id, bank_ref: receipt_id, value_date: etDate(ctx.now), amount_cents: resolution, originator_name: "Fannie Mae", reference_text: `PPA ${p.ppa_id} ${p.fnma_loan_number}`, account_ref: facilityOf(rt, l).collection_account_ref, matched_advice_ids: [p.purchase_advice_id], status: "matched", received_at: ctx.now, loan_id: l.loan_id, ppa_id: p.ppa_id }) as Record<string, unknown>, ctx.actor, ctx.now); }
        putLoan(rt, { ...l, status: l.status === "ppa_requested" ? "resolved" : l.status }, ctx);
        return { ppa_id: p.ppa_id, outcome, resolution_cents: String(resolution), settlement_receipt_id: receipt_id, waterfall_delta: "re-run on the settlement receipt", event_id: e.id };
      }
      if (op === "write_off") { rt.store.put(K.ppas, p.ppa_id, { status: "rejected", written_off_at: ctx.now, written_off_by: `${ctx.actor.kind}:${ctx.actor.id}` }, ctx.actor, ctx.now); return { ppa_id: p.ppa_id, written_off: true, by: "officer{sm}" }; }
      throw new RangeError(`unknown op ${op}`); }),
    guardrails: [needsRole("PPA_LSDU_IS_HUMAN_PORTAL_OPERATOR", "27.2 guardrails: the agent may never submit a PPA under the partner's credentials (human fnma_portal_operator{party=partner})", (i) => str(i, "op") === "submit" && str(i, "channel") === "lsdu", ["fnma_portal_operator"], "LSDU filings are a human act"),
      never("NO_PARTNER_CREDENTIALS", "27.2 guardrails: never submit a PPA under the partner's credentials", (i) => flag(i, "use_partner_credentials"), "the agent prepares the package; the human files it"),
      needsRole("PPA_WRITEOFF_NEEDS_OFFICER", "27.2 timer table: 27.2 adds the write-off decision officer{sm} when repricing is lost", (i) => str(i, "op") === "write_off", ["officer"], "a lost repricing is written off by officer{sm}"),
      never("NO_FEE_DRAFT_NETTING", "27.2 guardrails: never net a commitment fee draft against proceeds", (i) => flag(i, "net_commitment_fee_draft"), "fee drafts are matched to 29.1 records, never netted")] },
  // The human portal path (partner's LSDU credentials; Fannie Mae Connect report; Loan Delivery status): agents are refused by the bus (HUMAN_ONLY).
  { name: "fnma_portal_operator", kind: "act", humanOnly: true, humanRoles: ["fnma_portal_operator"], handler: compute((i, ctx, rt) => {
      need(i, "op"); const op = str(i, "op");
      if (op === "submit_ppa") {
        need(i, "ppa_id"); const p = revive(rt.store.require(K.ppas, str(i, "ppa_id")).data) as PpaRequest & { application_id: string };
        const l = revive(rt.store.require(K.loans, p.loan_id).data) as SettlementLoan;
        assertPpaSubmitter(p, ctx.actor);
        rt.store.put(K.ppas, p.ppa_id, { status: "submitted", requested_at: ctx.now, submitted_by: `${ctx.actor.kind}:${ctx.actor.id}`, fnma_reference: str(i, "fnma_reference") || null }, ctx.actor, ctx.now);
        const e = recordPpaRequested(ctx.events, keysOf(l), p, ctx.actor, ctx.now);
        for (const esc of rt.escalations.opened) if (esc.kind === "human_portal_task" && esc.status === "open" && esc.payload.ppa_id === p.ppa_id) { esc.status = "completed"; esc.completedAt = ctx.now; esc.completedBy = `${ctx.actor.kind}:${ctx.actor.id}`; }
        putLoan(rt, { ...l, status: l.status === "exception" ? "ppa_requested" : l.status }, ctx);
        return { ppa_id: p.ppa_id, kind: p.kind, channel: p.channel, status: "submitted", due_at: p.due_at, event_id: e.id };
      }
      if (op === "connect_report") { const r = ingestAdvices(rt, ctx, arr(i.advices).map((a) => rawAdvice(a, "connect_report"))); for (const esc of rt.escalations.opened) if (esc.kind === "human_portal_task" && esc.status === "open" && esc.payload.reason === "connect_report_fallback") { esc.status = "completed"; esc.completedAt = ctx.now; esc.completedBy = `${ctx.actor.kind}:${ctx.actor.id}`; } return { source: "connect_report", ...r }; }
      if (op === "loan_delivery_status") { const l = loanOf(rt, i); const e = ctx.events.append({ type: "delivery.status.observed", ...(l.loan_id ? { loanId: l.loan_id } : {}), applicationId: l.application_id, actor: ctx.actor, occurredAt: ctx.now, payload: { application_id: l.application_id, loan_delivery_status: str(i, "loan_delivery_status") || "purchased_and_funded", observed_at: ctx.now, source: "origination" } }); return { observed: str(i, "loan_delivery_status") || "purchased_and_funded", event_id: e.id }; }
      throw new RangeError(`unknown op ${op}`); }) },
  { name: "writeDecision", kind: "write", handler: decision() },
]);
