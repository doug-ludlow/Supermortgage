/**
 * §30.1 operating rules — Fannie Mae post-purchase servicing setup. One small pure function per rule / T-id over the
 * servicing calculators this process reuses: 5.1's LAR codec and period clocks (src/domain/investor), 5.2's A/A
 * remittance and CRS threshold, 6.x's custodial ledger vocabulary, 1.5's MERS org ids. Events are the platform's
 * statement that a Fannie Mae response was parsed: nothing here marks a submission accepted without one.
 *
 *   rule 1–3   purchaseUpdate / seedInvestorPosition / ptrConsistency        `loan.investor_updated{investor=fnma}`
 *   rule 4     purchaseMonthInterestDeduction / purchaseMonthRemittance         (nothing remitted for the purchase month)
 *   rule 5     firstLarClocks / firstLarProjection / submitFirstLar / acceptFirstLar / nextCycleNoPayment / paymentLar
 *   rule 7     escrowSetupPlan / sendEscrowSetupEvents / ackEscrowSetup          `escrow.setup_event.sent`, `investor_events.acked{type=EscrowSetup}`
 *   rule 8     scheduleCustodialTransfers / executeBookTransfer / matchBankFeed  `custodial.prepurchase_funds.transferred{kind, bank_matched}`
 *   rule 9     interimFunderRemovalTxn / recordMinUpdateAck / verifyMersInvestor `warehouse.interim_funder.removed`, `mers.investor.fnma_verified`
 *   rule 10    verifyENote / enoteCommandGate                                    `enote.post_purchase.verified`
 *   rule 11    finalizeCustodyRecord                                             `custody.record.finalized`
 *   rule 12    establishmentCheck / firstLarGate / preparePpaPackage             `loan.fnma_established`, `position_variance.opened`, `ppa.requested`
 *   roll-up    investorSetupStatus / completeInvestorSetup / postPurchaseSetupLine `loan.reporting_active`
 */
import { createHash } from "node:crypto";
import type { EventStore, DomainEvent, Actor } from "../../kernel/events/index.ts";
import type { Ledger, AccountRef, EntrySet } from "../../kernel/ledger/ledger.ts";
import { plainDate as D, addMonths, addDays, daysBetween, endOfMonth, type PlainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, nextBusinessDay, rollBack, servicer, fannieEt } from "../../kernel/calendar/business.ts";
import { zonedEpochMs, toIso, wallClock } from "../../kernel/calendar/zoned.ts";
import { Decimal, divRound, monthlyInterest, ratePercent, type Cents } from "../../kernel/money/index.ts";
import { projectLar96, type Lar96 } from "../investor/lar.ts";
import type { LarPayload } from "../investor/types.ts";
import { noActivityProjection } from "../investor/ops.ts";
import { larDeadlineMs, assignActivityPeriod, period as periodOf } from "../investor/period.ts";
import { aaRemittance, crsAaRequest } from "../investor/remittance.ts";
import { FANNIE_MAE_ORG_ID } from "../../infra/integrations/mers.ts";
import { SUPERMORTGAGE_ORG_ID } from "../transfers/inbound.ts";

export const RULE_SET_VERSION = "30.1@ops.v1";
export const ET = "America/New_York";
/** Rule 12's stated UPB tolerance (±$0.05). At establishment the seed is the delivered amount and T8 opens a money variance on a one-cent
 * difference ($560,000.01), so establishmentCheck compares to the cent by default (`upb_tolerance_cents` 0n); a caller checking a
 * position Fannie Mae has already amortized passes this figure explicitly. Reported as a spec discrepancy (rule 12 vs T8). */
export const UPB_TOLERANCE_CENTS: Cents = 5n;
/** Pre-purchase custodial accounts (operational prerequisite; open question 2). */
export const PREPURCHASE_TI_ACCOUNT = "custodial_ti_prepurchase";
export const PREPURCHASE_PI_ACCOUNT = "custodial_pi_prepurchase";
export const ESCROW_EVENTS_FLAG = "investor_reporting.escrow_events";
export const ESCROW_SETUP_ITEM_TYPE = "Set up";
export const FNMA_EVAULT_ORG_ID = "1000010";   // Fannie Mae is the eNote custodian (A3-3-04); same Org ID on the eRegistry

export type RemittanceType = "AA" | "SA" | "SS";
export type InvestorSetupStatus = "pre_purchase" | "purchased" | "established" | "first_lar_accepted" | "escrow_setup_acked" | "reporting_active";
export type NoteForm = "paper" | "enote";
export type CustodialTransferKind = "ti_escrow_balance" | "ti_buydown_funds" | "pi_prepurchase_collections";
export type VarianceKind = "upb" | "lpi" | "ptr" | "remittance_type" | "lender_loan_id" | "escrow_balance";
export type EscrowSetupDeadlineBasis = "purchase_day_visibility" | "establishment_day_visibility" | "target_pending_visibility";

const SYSTEM_30_1: Actor = { kind: "agent", id: "investor-reporting" };
const need = (cond: boolean, what: string): void => { if (!cond) throw new RangeError(what); };
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const etDate = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
const loanEvents = (store: EventStore, loanId: string, type: string): DomainEvent[] => store.byLoan(loanId).filter((e) => e.type === type);
const latest = (xs: readonly DomainEvent[]): DomainEvent | null => (xs.length ? xs[xs.length - 1]! : null);
const ctx = (i: { readonly loan_id: string; readonly application_id?: string | null }): { loanId: string; applicationId?: string } => ({ loanId: i.loan_id, ...(i.application_id ? { applicationId: i.application_id } : {}) });
const withApp = (i: { readonly application_id?: string | null }): { application_id: string | null; source: "origination" } => ({ application_id: i.application_id ?? null, source: "origination" });
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const bps = (ratePct: string): number => Number(divRound(Decimal.parse(ratePct).unscaled * 100n, Decimal.ONE.unscaled, "HALF_UP"));

// ───────────────────────────── inputs ─────────────────────────────
/** Whole Loan Purchase Advice fields 27.2 delivers on `purchase_advice.received`. */
export interface PurchaseAdvice {
  readonly advice_id: string; readonly fnma_loan_number: string; readonly fnma_servicer_number: string; readonly lender_loan_number: string;
  readonly advice_date: PlainDate; readonly purchase_date: PlainDate; readonly remittance_type: RemittanceType;
  readonly pass_through_rate: string; readonly note_rate_pct: string; readonly servicing_fee_bps: number;
  readonly interest_adjustment_cents: Cents; readonly net_proceeds_cents: Cents;
}
/** The boarded (30.2) loan as 30.1 finds it at purchase. */
export interface PurchaseLoan {
  readonly loan_id: string; readonly application_id?: string | null; readonly servicing_loan_number: string;
  readonly original_upb_cents: Cents; readonly principal_paid_cents?: Cents; readonly first_payment_date: PlainDate; readonly note_rate_pct: string;
  readonly commitment_remittance_type: RemittanceType; readonly escrowed: boolean; readonly note_form: NoteForm; readonly mers_registered: boolean; readonly min?: string | null;
}
export interface InvestorPositionSeed {
  readonly loan_id: string; readonly fnma_lpi_date: PlainDate; readonly fnma_actual_upb_cents: Cents; readonly remittance_type: RemittanceType; readonly fnma_ptr: string;
  readonly participation_pct: "100.000000"; readonly source: "purchase_advice"; readonly as_of: PlainDate;
}
export interface PositionVariance { readonly kind: VarianceKind; readonly money: boolean; readonly expected: string; readonly observed: string; readonly citation: string; readonly requires: readonly string[] }

// ───────────────────────────── rules 1–3, 13: purchase update ─────────────────────────────
/** Rule 13: `note_rate − ptr − gfee(0) = servicing_fee` (both rates from the advice; whole loans carry no g-fee). */
export function ptrConsistency(noteRatePct: string, ptrPct: string, servicingFeeBps: number, gfeeBps = 0): { consistent: boolean; implied_fee_bps: number } {
  const implied = bps(noteRatePct) - bps(ptrPct) - gfeeBps;
  return { consistent: implied === servicingFeeBps, implied_fee_bps: implied };
}
/** Rule 1: `investor_loan_positions` seed — LPI = first payment date − 1 month; UPB = original amount less principal already paid. */
export function seedInvestorPosition(loan: PurchaseLoan, advice: PurchaseAdvice): InvestorPositionSeed {
  return { loan_id: loan.loan_id, fnma_lpi_date: addMonths(loan.first_payment_date, -1), fnma_actual_upb_cents: loan.original_upb_cents - (loan.principal_paid_cents ?? 0n), remittance_type: advice.remittance_type, fnma_ptr: advice.pass_through_rate, participation_pct: "100.000000", source: "purchase_advice", as_of: advice.purchase_date };
}
export const purchaseIdempotencyKey = (a: PurchaseAdvice): string => sha256(`${a.fnma_loan_number}|${a.purchase_date}|${a.advice_id}`);

export interface PurchaseUpdateResult {
  readonly ok: boolean; readonly replayed: boolean; readonly variance: PositionVariance | null; readonly event: DomainEvent | null;
  readonly loan_patch: Record<string, unknown> | null; readonly loan_terms_v2: Record<string, unknown> | null; readonly position: InvestorPositionSeed | null; readonly idempotency_key: string;
}
/**
 * Rules 1–3 (idempotent purchase update). Match by Loan Delivery Lender Loan Number = `loans.servicing_loan_number`
 * (rule 6 — no LAR 81 when they agree); a remittance type on the advice that differs from the commitment is a
 * `position_variance` (C1-3-01: Fannie Mae "generally will not change the remittance type"), never a silent overwrite.
 */
export function purchaseUpdate(store: EventStore, i: { readonly loan: PurchaseLoan; readonly advice: PurchaseAdvice; readonly now: string; readonly actor?: Actor }): PurchaseUpdateResult {
  const { loan, advice } = i; const actor = i.actor ?? SYSTEM_30_1;
  need(/^\d{10}$/.test(advice.fnma_loan_number), "fnma_loan_number must be 10 digits (C2-2-05: enter it into the records immediately)");
  need(/^\d{9}$/.test(advice.fnma_servicer_number), "fnma_servicer_number must be the partner's 9-digit seller/servicer number");
  const key = purchaseIdempotencyKey(advice);
  const prior = loanEvents(store, loan.loan_id, "loan.investor_updated").find((e) => p(e).idempotency_key === key);
  if (prior) return { ok: true, replayed: true, variance: null, event: prior, loan_patch: null, loan_terms_v2: null, position: null, idempotency_key: key };
  const refuse = (variance: PositionVariance): PurchaseUpdateResult => {
    const event = store.append({ type: "position_variance.opened", ...ctx(loan), actor, occurredAt: i.now, payload: { ...variance, ...withApp(loan), fnma_loan_number: advice.fnma_loan_number, purchase_advice_id: advice.advice_id, status: "open", lar_held: true } });
    return { ok: false, replayed: false, variance, event, loan_patch: null, loan_terms_v2: null, position: null, idempotency_key: key };
  };
  if (advice.lender_loan_number !== loan.servicing_loan_number)
    return refuse({ kind: "lender_loan_id", money: false, expected: loan.servicing_loan_number, observed: advice.lender_loan_number, citation: "IRM p. 29 (LAR 81) / 5.1 Loan Data Change", requires: ["lar81_or_loan_data_change"] });
  if (advice.remittance_type !== loan.commitment_remittance_type)
    return refuse({ kind: "remittance_type", money: false, expected: loan.commitment_remittance_type, observed: advice.remittance_type, citation: "Selling Guide C1-3-01 (08/26/2014): after purchase Fannie Mae generally will not change the remittance type the lender selected; the commitment record is the evidence", requires: ["commitment_record", "fnma_confirmation"] });
  const ptr = ptrConsistency(advice.note_rate_pct, advice.pass_through_rate, advice.servicing_fee_bps);
  if (!ptr.consistent)
    return refuse({ kind: "ptr", money: true, expected: `${ptr.implied_fee_bps} bps`, observed: `${advice.servicing_fee_bps} bps`, citation: "Selling Guide C2-1.1-02: pass-through rate = gross note rate − servicing fee", requires: ["ppa_package", "officer_approval"] });
  const position = seedInvestorPosition(loan, advice);
  const loan_terms_v2 = { version: 2, effective_date: advice.purchase_date, remittance_type: advice.remittance_type, pass_through_rate: advice.pass_through_rate, servicing_fee_bps: advice.servicing_fee_bps, gfee_bps: 0 };
  const loan_patch = { investor: "fnma", fnma_loan_number: advice.fnma_loan_number, fnma_servicer_number: advice.fnma_servicer_number, purchase_date: advice.purchase_date, purchase_advice_id: advice.advice_id,
    remittance_type: advice.remittance_type, pass_through_rate: advice.pass_through_rate, servicing_fee_bps: advice.servicing_fee_bps, participation_pct: "100.000000", servicing_option: advice.remittance_type === "SS" ? "regular" : null,
    investor_setup_status: "purchased" as InvestorSetupStatus, fnma_first_reporting_period: periodOf(advice.purchase_date) };
  const event = store.append({ type: "loan.investor_updated", ...ctx(loan), actor, occurredAt: i.now,
    payload: { ...loan_patch, ...withApp(loan), loan_terms: loan_terms_v2, investor_loan_position: { ...position }, idempotency_key: key, advice_date: advice.advice_date } });
  return { ok: true, replayed: false, variance: null, event, loan_patch, loan_terms_v2, position, idempotency_key: key };
}
/** The seed as a row event (`seedInvestorPosition` tool): 5.1 owns the table; 30.1 writes the first row with `source='purchase_advice'`. */
export function recordInvestorPositionSeed(store: EventStore, i: { readonly loan: PurchaseLoan; readonly advice: PurchaseAdvice; readonly now: string; readonly actor?: Actor }): { position: InvestorPositionSeed; event: DomainEvent } {
  const position = seedInvestorPosition(i.loan, i.advice);
  const event = store.append({ type: "investor_loan_positions.seeded", ...ctx(i.loan), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.now, payload: { ...position, ...withApp(i.loan) } });
  return { position, event };
}
/** The `purchase_advice.received` event 27.2 appends for the loan (30.1 consumes it; SM_FNMA_LOAN_NUMBER_RECORD_T0 arms on it). */
export const purchaseAdviceReceived = (store: EventStore, loanId: string): DomainEvent | null => latest(loanEvents(store, loanId, "purchase_advice.received"));

// ───────────────────────────── rule 4: purchase-month economics ─────────────────────────────
/** C2-1.1-06: for a new origination (LPI after the purchase date) Fannie Mae deducts interest from the purchase date through the day before the LPI date; 360- and 365-day bases (the convention is 27.2's to reconcile). */
export function purchaseMonthInterestDeduction(upbCents: Cents, ptrPct: string, purchaseDate: PlainDate, lpiDate: PlainDate): { days: number; cents_360: Cents; cents_365: Cents } {
  const days = daysBetween(purchaseDate, lpiDate);
  need(days >= 0, "the LPI date of a new origination is on/after the purchase date");
  const annual = upbCents * ratePercent(ptrPct).unscaled * BigInt(days);
  return { days, cents_360: divRound(annual, 360n * Decimal.ONE.unscaled, "HALF_UP"), cents_365: divRound(annual, 365n * Decimal.ONE.unscaled, "HALF_UP") };
}
/** Nothing is remitted for the purchase month (settled in the price): no `remittance_calculations` row; the first LAR carries zero interest and principal. */
export function purchaseMonthRemittance(purchaseDate: PlainDate): { period: string; remittance_calculations: readonly never[]; first_lar_interest_cents: Cents; first_lar_principal_cents: Cents } {
  return { period: periodOf(purchaseDate), remittance_calculations: [], first_lar_interest_cents: 0n, first_lar_principal_cents: 0n };
}

// ───────────────────────────── rule 12: establishment reconciliation ─────────────────────────────
export type EstablishmentSource = "lsdu_position" | "connect_loan_activity_summary" | "servicing_platform_position";
export interface FnmaObservedPosition { readonly fnma_lpi_date: PlainDate | null; readonly fnma_upb_cents: Cents; readonly fnma_remittance_type: RemittanceType; readonly fnma_ptr: string }
export interface EstablishmentCheckRow {
  readonly loan_id: string; readonly checked_at: string; readonly source: EstablishmentSource; readonly found: boolean;
  readonly fnma_lpi_date: PlainDate | null; readonly fnma_upb_cents: Cents | null; readonly fnma_remittance_type: RemittanceType | null; readonly fnma_ptr: string | null;
  readonly variance: { upb_diff_cents: Cents; lpi_match: boolean; remittance_match: boolean; ptr_match: boolean; within_tolerance: boolean } | null; readonly agent_run_id: string | null;
}
export interface EstablishmentResult {
  readonly row: EstablishmentCheckRow; readonly status: "established" | "position_variance" | "establishment_lag"; readonly established_at: PlainDate | null;
  readonly variances: PositionVariance[]; readonly lar_held: boolean; readonly events: DomainEvent[];
  /** `establishment_lag` past +2 Fannie Mae BDs: the Investor Reporting Representative package for `fnma_portal_operator`. */
  readonly portal_package: { kind: "human_portal_task"; role: "fnma_portal_operator"; package: "investor_reporting_representative"; evidence: string[] } | null;
}
const cmpRate = (a: string, b: string): boolean => Decimal.parse(a).unscaled === Decimal.parse(b).unscaled;
/** Rule 12: compare Fannie Mae's LPI/UPB/remittance type/PTR to our seed; UPB > ±$0.05 or LPI ≠ ours → money `position_variance`; found and reconciled → `loan.fnma_established`. */
export function establishmentCheck(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly checked_at: string; readonly source: EstablishmentSource; readonly found: boolean; readonly observed?: FnmaObservedPosition | null; readonly expected: InvestorPositionSeed; readonly purchase_date: PlainDate; readonly upb_tolerance_cents?: Cents; readonly agent_run_id?: string | null; readonly actor?: Actor }): EstablishmentResult {
  const actor = i.actor ?? SYSTEM_30_1; const events: DomainEvent[] = []; const tol = i.upb_tolerance_cents ?? 0n;
  const o = i.found ? i.observed ?? null : null;
  need(!i.found || !!o, "a found position carries the observed LPI/UPB/remittance type/PTR");
  const variance = o ? { upb_diff_cents: o.fnma_upb_cents - i.expected.fnma_actual_upb_cents, lpi_match: o.fnma_lpi_date === i.expected.fnma_lpi_date, remittance_match: o.fnma_remittance_type === i.expected.remittance_type, ptr_match: cmpRate(o.fnma_ptr, i.expected.fnma_ptr), within_tolerance: false } : null;
  if (variance) variance.within_tolerance = (variance.upb_diff_cents < 0n ? -variance.upb_diff_cents : variance.upb_diff_cents) <= tol && variance.lpi_match && variance.remittance_match && variance.ptr_match;
  const row: EstablishmentCheckRow = { loan_id: i.loan_id, checked_at: i.checked_at, source: i.source, found: i.found, fnma_lpi_date: o?.fnma_lpi_date ?? null, fnma_upb_cents: o?.fnma_upb_cents ?? null, fnma_remittance_type: o?.fnma_remittance_type ?? null, fnma_ptr: o?.fnma_ptr ?? null, variance, agent_run_id: i.agent_run_id ?? null };
  events.push(store.append({ type: "fnma_establishment_checks.recorded", ...ctx(i), actor, occurredAt: i.checked_at, payload: { ...row, check_source: row.source, fnma_upb_cents: row.fnma_upb_cents === null ? null : String(row.fnma_upb_cents), variance: variance ? { ...variance, upb_diff_cents: String(variance.upb_diff_cents) } : null, ...withApp(i) } }));
  if (!i.found) {
    const escalateOn = addBusinessDays(i.purchase_date, 2, fannieEt); const today = etDate(i.checked_at);
    const portal_package = today >= escalateOn ? { kind: "human_portal_task" as const, role: "fnma_portal_operator" as const, package: "investor_reporting_representative" as const, evidence: ["purchase_advice", "loan_delivery_status_purchased_and_funded", `establishment checks ${loanEvents(store, i.loan_id, "fnma_establishment_checks.recorded").length}`] } : null;
    events.push(store.append({ type: "investor_setup.establishment_lag", ...ctx(i), actor, occurredAt: i.checked_at, payload: { check_source: i.source, checked_on: today, escalate_on: escalateOn, portal_package, lar_held: true, ...withApp(i) } }));
    return { row, status: "establishment_lag", established_at: null, variances: [], lar_held: true, events, portal_package };
  }
  const variances: PositionVariance[] = [];
  const v = variance!, ob = o!;
  if (!((v.upb_diff_cents < 0n ? -v.upb_diff_cents : v.upb_diff_cents) <= tol)) variances.push({ kind: "upb", money: true, expected: String(i.expected.fnma_actual_upb_cents), observed: String(ob.fnma_upb_cents), citation: `30.1 rule 12 / T8: UPB variance beyond ±${tol} cents → position_variance (money) → PPA/Loan Data Change package before the first LAR`, requires: ["ppa_package", "officer_approval"] });
  if (!v.lpi_match) variances.push({ kind: "lpi", money: true, expected: String(i.expected.fnma_lpi_date), observed: String(ob.fnma_lpi_date), citation: "30.1 rule 12: LPI ≠ ours → position_variance", requires: ["ppa_package", "officer_approval"] });
  if (!v.remittance_match) variances.push({ kind: "remittance_type", money: false, expected: i.expected.remittance_type, observed: ob.fnma_remittance_type, citation: "Selling Guide C1-3-01", requires: ["commitment_record", "fnma_confirmation"] });
  if (!v.ptr_match) variances.push({ kind: "ptr", money: true, expected: i.expected.fnma_ptr, observed: ob.fnma_ptr, citation: "Selling Guide C2-1.1-02", requires: ["ppa_package", "officer_approval"] });
  if (variances.length) {
    for (const x of variances) events.push(store.append({ type: "position_variance.opened", ...ctx(i), actor, occurredAt: i.checked_at, payload: { ...x, check_source: i.source, status: "open", lar_held: true, ...withApp(i) } }));
    return { row, status: "position_variance", established_at: null, variances, lar_held: true, events, portal_package: null };
  }
  const established_at = etDate(i.checked_at);
  events.push(store.append({ type: "loan.fnma_established", ...ctx(i), actor, occurredAt: i.checked_at, payload: { established_at, fnma_established_at: established_at, check_source: i.source, investor_setup_status: "established", fnma_lpi_date: ob.fnma_lpi_date, fnma_upb_cents: String(ob.fnma_upb_cents), ...withApp(i) } }));
  return { row, status: "established", established_at, variances: [], lar_held: false, events, portal_package: null };
}
/** Open variances (opened − resolved) on the loan: while any exists the first LAR is held (rules 3, 12; T8, T9). */
export function openVariances(store: EventStore, loanId: string): { kind: VarianceKind; money: boolean; citation: string; opened_event_id: string }[] {
  const resolved = new Set(loanEvents(store, loanId, "position_variance.resolved").map((e) => String(p(e).opened_event_id)));
  return loanEvents(store, loanId, "position_variance.opened").filter((e) => !resolved.has(e.id)).map((e) => ({ kind: p(e).kind as VarianceKind, money: p(e).money === true, citation: String(p(e).citation), opened_event_id: e.id }));
}
export function firstLarGate(store: EventStore, loanId: string): { held: boolean; reasons: string[] } {
  const open = openVariances(store, loanId);
  const lagged = latest(loanEvents(store, loanId, "investor_setup.establishment_lag")) !== null && latest(loanEvents(store, loanId, "loan.fnma_established")) === null;
  const reasons = [...open.map((v) => `position_variance{${v.kind}} open (${v.citation})`), ...(lagged ? ["loan not established in Fannie Mae's records (LAR would be Invalid)"] : [])];
  return { held: reasons.length > 0, reasons };
}
/** Rule 12 / T8: the PPA (Loan Data Change) package that resolves a money variance — prepared by the agent, filed by `fnma_portal_operator`; the officer's approval is a separate record. */
export function preparePpaPackage(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly opened_event_id: string; readonly kind: VarianceKind; readonly evidence_document_ids: readonly string[]; readonly now: string; readonly actor?: Actor }): { package_id: string; event: DomainEvent } {
  need(i.evidence_document_ids.length > 0, "a PPA package carries evidence (Purchase Advice, establishment check, note/CD) — never a bare adoption of Fannie Mae's figure");
  const package_id = `ppa-${sha256(`${i.loan_id}|${i.opened_event_id}`).slice(0, 12)}`;
  const event = store.append({ type: "ppa.requested", ...ctx(i), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.now, payload: { package_id, kind: "position_variance", variance_kind: i.kind, opened_event_id: i.opened_event_id, evidence_document_ids: [...i.evidence_document_ids], channel: "lsdu_loan_data_change", filed_by_role: "fnma_portal_operator", ...withApp(i) } });
  return { package_id, event };
}
/** Adopting Fannie Mae's money figure: refused without the officer's approval record and the PPA package (guardrail). */
export function adoptFnmaFigure(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly opened_event_id: string; readonly ppa_package_id?: string | null; readonly officer_approval_id?: string | null; readonly adopted_value: string; readonly now: string; readonly actor?: Actor }): { ok: true; event: DomainEvent } | { ok: false; code: "MONEY_VARIANCE_EVIDENCE"; reason: string } {
  const missing = [...(i.ppa_package_id ? [] : ["ppa_package"]), ...(i.officer_approval_id ? [] : ["officer_approval_record"])];
  if (missing.length) return { ok: false, code: "MONEY_VARIANCE_EVIDENCE", reason: `money-field variances are never corrected to Fannie Mae's values without evidence: missing ${missing.join(", ")}` };
  const event = store.append({ type: "position_variance.resolved", ...ctx(i), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.now, payload: { opened_event_id: i.opened_event_id, resolution: "fnma_adjusted", ppa_package_id: i.ppa_package_id, officer_approval_id: i.officer_approval_id, adopted_value: i.adopted_value, ...withApp(i) } });
  return { ok: true, event };
}
export function resolveVariance(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly opened_event_id: string; readonly resolution: "commitment_confirmed" | "fnma_adjusted" | "lar81_filed" | "closed_manual"; readonly evidence_document_ids: readonly string[]; readonly now: string; readonly actor?: Actor }): DomainEvent {
  need(i.evidence_document_ids.length > 0, "a variance is resolved on evidence");
  return store.append({ type: "position_variance.resolved", ...ctx(i), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.now, payload: { opened_event_id: i.opened_event_id, resolution: i.resolution, evidence_document_ids: [...i.evidence_document_ids], ...withApp(i) } });
}

// ───────────────────────────── rule 5: the first LAR (acquisition month) and the cycles after ─────────────────────────────
export interface FirstLarClocks { readonly activity_period: string; readonly target_on: PlainDate; readonly target_at_ms: number; readonly hard_deadline_on: PlainDate; readonly hard_deadline_at_ms: number; readonly basis: "last_fannie_bd_of_purchase_month" | "bd1_prior_period_limit" }
/**
 * TT96 user guide: LARs "in the same month that the loans are acquired" → target the next Fannie Mae BD 20:00 ET after
 * establishment; hard stop 20:00 ET on the last Fannie Mae business day of the purchase month — unless establishment
 * itself falls on BD1 of the following month (purchase on the month's last business day), when IRM 2-01's prior-period
 * limit (BD1 20:00 ET) is the hard stop. BD2 17:00/15:00 ET are period-close / bulk cut-off, never this deadline.
 */
export function firstLarClocks(purchaseDate: PlainDate, establishedAt: PlainDate): FirstLarClocks {
  need(establishedAt >= purchaseDate, "a loan is established on or after its purchase date");
  const target_on = nextBusinessDay(establishedAt, fannieEt);
  const nextMonth = periodOf(establishedAt) !== periodOf(purchaseDate);
  const hard_deadline_on = nextMonth ? establishedAt : rollBack(endOfMonth(purchaseDate), fannieEt);
  return { activity_period: periodOf(purchaseDate), target_on, target_at_ms: zonedEpochMs(target_on, "20:00", ET), hard_deadline_on, hard_deadline_at_ms: zonedEpochMs(hard_deadline_on, "20:00", ET), basis: nextMonth ? "bd1_prior_period_limit" : "last_fannie_bd_of_purchase_month" };
}
export interface FirstLarProjection { readonly lar: Lar96; readonly payload: LarPayload; readonly clocks: FirstLarClocks; readonly event_type: "payment.none"; readonly sequence: 1 }
/** LAR 96 for the acquisition month: partner servicer number, action 00, action date = establishment date, zero interest and principal (rule 4), LPI/UPB from the seed. */
export function firstLarProjection(i: { readonly servicer_number: string; readonly fnma_loan_number: string; readonly position: InvestorPositionSeed; readonly purchase_date: PlainDate; readonly established_at: PlainDate }): FirstLarProjection {
  const clocks = firstLarClocks(i.purchase_date, i.established_at);
  const payload: LarPayload = { lpi_date: i.position.fnma_lpi_date, upb_cents: i.position.fnma_actual_upb_cents, nib_cents: 0n, interest_cents: 0n, principal_cents: 0n, other_fees_cents: 0n, action_code: "00", action_date: i.established_at };
  return { lar: projectLar96(i.servicer_number, i.fnma_loan_number, payload), payload, clocks, event_type: "payment.none", sequence: 1 };
}
export type LarChannel = "lsdu_b2b" | "lsdu_upload" | "lsdu_single";
/** `investor.first_lar.submitted` — only when nothing holds the LAR (rule 12); the event carries the record and both clocks. */
export function submitFirstLar(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly projection: FirstLarProjection; readonly submission_id: string; readonly channel: LarChannel; readonly now: string; readonly actor?: Actor }): { ok: true; event: DomainEvent; late_vs_target: boolean } | { ok: false; code: "FIRST_LAR_HELD"; reasons: string[] } {
  const gate = firstLarGate(store, i.loan_id);
  if (gate.held) return { ok: false, code: "FIRST_LAR_HELD", reasons: gate.reasons };
  const c = i.projection.clocks; const nowMs = Date.parse(i.now);
  const event = store.append({ type: "investor.first_lar.submitted", ...ctx(i), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.now, payload: { submission_id: i.submission_id, channel: i.channel, event_type: "payment.none", activity_period: c.activity_period, sequence: 1, record: i.projection.lar.record, fields: { ...i.projection.lar.fields },
    target_at: toIso(c.target_at_ms), hard_deadline_at: toIso(c.hard_deadline_at_ms), late_vs_target: nowMs > c.target_at_ms, ...withApp(i) } });
  return { ok: true, event, late_vs_target: nowMs > c.target_at_ms };
}
/** `investor.first_lar.accepted` is written from a parsed Fannie Mae response only (5.1 guardrail); a non-escrowed / flag-off loan reaches `escrow_setup_acked` on it (T11). */
export function acceptFirstLar(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly submission_id: string; readonly fnma_response_id: string; readonly accepted_at: string; readonly escrow_setup_required: boolean; readonly actor?: Actor }): { events: DomainEvent[]; status: InvestorSetupStatus } {
  need(i.fnma_response_id.trim().length > 0, "acceptance needs the parsed Fannie Mae response id");
  const sub = loanEvents(store, i.loan_id, "investor.first_lar.submitted").find((e) => p(e).submission_id === i.submission_id);
  need(!!sub, `no first LAR submission ${i.submission_id} on loan ${i.loan_id}`);
  const late = Date.parse(i.accepted_at) > Date.parse(String(p(sub!).hard_deadline_at));
  const events: DomainEvent[] = [store.append({ type: "investor.first_lar.accepted", ...ctx(i), actor: { kind: "external", id: "fnma" }, occurredAt: i.accepted_at, causationId: sub!.id, payload: { submission_id: i.submission_id, fnma_response_id: i.fnma_response_id, activity_period: p(sub!).activity_period, event_type: "payment.none", action_code: "00", late_vs_hard_deadline: late, investor_setup_status: "first_lar_accepted", ...withApp(i) } })];
  let status: InvestorSetupStatus = "first_lar_accepted";
  if (!i.escrow_setup_required) { status = "escrow_setup_acked"; events.push(store.append({ type: "investor_setup.escrow_setup_acked", ...ctx(i), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.accepted_at, payload: { basis: "no_escrow_setup_event", investor_setup_status: status, ...withApp(i) } })); }
  return { events, status };
}
/** The cycle after the purchase month runs under 5.1: no payment expected → `payment.none` by the IRED (CD22, preceding BD) 20:00 ET. */
export function nextCycleNoPayment(i: { readonly month_of: PlainDate; readonly servicer_number: string; readonly fnma_loan_number: string; readonly sequence: number; readonly position: InvestorPositionSeed }): ReturnType<typeof noActivityProjection> & { due_on: PlainDate } {
  const pr = noActivityProjection({ month_of: i.month_of, mode: "legacy", servicer_number: i.servicer_number, fnma_loan_number: i.fnma_loan_number, sequence: i.sequence, position: { lpi_date: i.position.fnma_lpi_date, upb_cents: i.position.fnma_actual_upb_cents, nib_cents: 0n } });
  return { ...pr, due_on: wallClock(pr.submit_by_ms, ET).date };
}
export interface PaymentLar { readonly lar: Lar96; readonly payload: LarPayload; readonly activity_period: string; readonly due_at_ms: number; readonly due_on: PlainDate; readonly remittance: ReturnType<typeof aaRemittance>; readonly new_upb_cents: Cents; readonly new_lpi_date: PlainDate; readonly crs: ReturnType<typeof crsAaRequest> }
/** Rule 5 (January): the first contractual payment → LAR by the next Fannie Mae BD 20:00 ET; A/A remittance at PTR on the prior actual UPB; CRS 001 the same day when > $2,500 (5.2). */
export function paymentLar(i: { readonly servicer_number: string; readonly fnma_loan_number: string; readonly prior_upb_cents: Cents; readonly prior_lpi_date: PlainDate; readonly note_rate_pct: string; readonly ptr_pct: string; readonly payment_cents: Cents; readonly processed_at: string; readonly open_periods: readonly string[] }): PaymentLar {
  const noteInterest = monthlyInterest(i.prior_upb_cents, ratePercent(i.note_rate_pct));
  const principal = i.payment_cents - noteInterest;
  need(principal > 0n, "a contractual payment covers the month's note interest");
  const remittance = aaRemittance(i.prior_upb_cents, i.note_rate_pct, i.ptr_pct, principal);
  const processedOn = etDate(i.processed_at); const ms = Date.parse(i.processed_at);
  const new_upb_cents = i.prior_upb_cents - principal; const new_lpi_date = addMonths(i.prior_lpi_date, 1);
  const payload: LarPayload = { lpi_date: new_lpi_date, upb_cents: new_upb_cents, nib_cents: 0n, interest_cents: remittance.fnma_interest_cents, principal_cents: remittance.principal_cents, other_fees_cents: 0n, action_code: "00", action_date: processedOn };
  const due_at_ms = larDeadlineMs(ms, false);
  return { lar: projectLar96(i.servicer_number, i.fnma_loan_number, payload), payload, activity_period: assignActivityPeriod(processedOn, ms, false, i.open_periods), due_at_ms, due_on: wallClock(due_at_ms, ET).date, remittance, new_upb_cents, new_lpi_date, crs: crsAaRequest(remittance.remittance_cents, processedOn, false) };
}

// ───────────────────────────── rule 7: Escrow Setup event (LL-2026-05) ─────────────────────────────
export interface EscrowCategoryBalance { readonly category: "ti" | "buydown" | "loss_draft" | "renovation"; readonly balance_cents: Cents }
export interface EscrowSetupEventPlan { readonly category: string; readonly item_type: typeof ESCROW_SETUP_ITEM_TYPE; readonly sequence: 1; readonly amount_cents: Cents; readonly balance_cents: Cents; readonly processed_on: PlainDate; readonly event_id: string }
export interface EscrowSetupPlan {
  readonly required: boolean; readonly why: string; readonly events: EscrowSetupEventPlan[];
  readonly target_on: PlainDate; readonly target_at_ms: number;
  readonly deadline_on: PlainDate | null; readonly deadline_at_ms: number | null; readonly deadline_basis: EscrowSetupDeadlineBasis; readonly contractual: boolean;
}
/**
 * One `escrow.setup` event per category with a nonzero balance (`item_type='Set up'`, sequence 1, amount = balance).
 * Target: the purchase day as processing day → next Fannie Mae BD 03:00 ET (the registry clock). Recorded deadline:
 * from the observed Servicing Platform visibility date — purchase-day visibility keeps the target; establishment-day
 * visibility moves it to the BD after that (LL-2026-05: "when the loan is onboarded to the Fannie Mae Servicing Platform").
 */
export function escrowSetupPlan(i: { readonly loan_id: string; readonly escrowed: boolean; readonly flag_on: boolean; readonly categories: readonly EscrowCategoryBalance[]; readonly purchase_date: PlainDate; readonly visibility_observed_on: PlainDate | null }): EscrowSetupPlan {
  const target_on = nextBusinessDay(i.purchase_date, fannieEt);
  const base = { target_on, target_at_ms: zonedEpochMs(target_on, "03:00", ET), contractual: i.purchase_date >= D("2026-12-01") };
  if (!i.escrowed) return { ...base, required: false, why: "non-escrowed loan: no Escrow Setup event; escrow_setup_acked is reached on first_lar_accepted", events: [], deadline_on: null, deadline_at_ms: null, deadline_basis: "target_pending_visibility" };
  if (!i.flag_on) return { ...base, required: false, why: `${ESCROW_EVENTS_FLAG} off: 3.7's cut-over job sends the Setup events when the flag turns on`, events: [], deadline_on: null, deadline_at_ms: null, deadline_basis: "target_pending_visibility" };
  const processed_on = i.visibility_observed_on ?? i.purchase_date;
  const events = i.categories.filter((c) => c.balance_cents > 0n).map((c): EscrowSetupEventPlan => ({ category: c.category, item_type: ESCROW_SETUP_ITEM_TYPE, sequence: 1, amount_cents: c.balance_cents, balance_cents: c.balance_cents, processed_on, event_id: `ES-${i.loan_id}-${c.category}-1` }));
  if (!i.visibility_observed_on) return { ...base, required: events.length > 0, why: "queued at loan.purchased; submitted on the establishment day", events, deadline_on: null, deadline_at_ms: null, deadline_basis: "target_pending_visibility" };
  const basis: EscrowSetupDeadlineBasis = i.visibility_observed_on <= i.purchase_date ? "purchase_day_visibility" : "establishment_day_visibility";
  const deadline_on = nextBusinessDay(basis === "purchase_day_visibility" ? i.purchase_date : i.visibility_observed_on, fannieEt);
  return { ...base, required: events.length > 0, why: `Servicing Platform visibility observed ${i.visibility_observed_on}`, events, deadline_on, deadline_at_ms: zonedEpochMs(deadline_on, "03:00", ET), deadline_basis: basis };
}
/** 3.7's `escrow.setup_event.sent` per category (the same event 3.7's cut-over job appends), with the deadline basis on the payload for the decision record. */
export function sendEscrowSetupEvents(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly plan: EscrowSetupPlan; readonly submission_id: string; readonly now: string; readonly actor?: Actor }): DomainEvent[] {
  need(i.plan.required, "no Escrow Setup event is due for this loan");
  need(i.plan.deadline_at_ms !== null, "the Setup event is submitted only once the loan is visible on the Servicing Platform (fatal rule: valid loan number / servicer association)");
  return i.plan.events.map((e) => store.append({ type: "escrow.setup_event.sent", ...ctx(i), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.now, payload: { event_id: e.event_id, category: e.category, item_type: e.item_type, sequence: e.sequence, amount_cents: String(e.amount_cents), balance_cents: String(e.balance_cents), processed_on: e.processed_on,
    deadline_at: toIso(i.plan.deadline_at_ms!), deadline_basis: i.plan.deadline_basis, target_at: toIso(i.plan.target_at_ms), submission_id: i.submission_id, contractual: i.plan.contractual, status: "sent", ...withApp(i) } }));
}
/** Fannie Mae's parsed acknowledgment of one Setup event → 1.1/3.7's `investor_events.acked{type=EscrowSetup, category}`; the ack completing the category set carries `every_category=true` (the timer's satisfying event). */
export function ackEscrowSetup(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly category: string; readonly fnma_response_id: string; readonly status: "accepted" | "accepted_warning" | "rejected"; readonly message?: string | null; readonly acked_at: string }): { every_category: boolean; acked: string[]; expected: string[]; event: DomainEvent } {
  need(i.fnma_response_id.trim().length > 0, "an ack is written from the parsed Fannie Mae response only");
  const sent = loanEvents(store, i.loan_id, "escrow.setup_event.sent"); const expected = [...new Set(sent.map((e) => String(p(e).category)))];
  need(expected.includes(i.category), `no Escrow Setup event was sent for category ${i.category}`);
  const sentEvent = latest(sent.filter((e) => p(e).category === i.category))!;
  if (i.status === "rejected") {
    const event = store.append({ type: "escrow.event.rejected", ...ctx(i), actor: { kind: "external", id: "fnma" }, occurredAt: i.acked_at, causationId: sentEvent.id, payload: { event_id: p(sentEvent).event_id, category: i.category, sequence: 1, reason: i.message ?? null, fnma_response_id: i.fnma_response_id, exception: "setup_rejected", ...withApp(i) } });
    return { every_category: false, acked: [], expected, event };
  }
  const acked = [...new Set([...loanEvents(store, i.loan_id, "investor_events.acked").filter((e) => p(e).type === "EscrowSetup").map((e) => String(p(e).category)), i.category])];
  const every = expected.every((c) => acked.includes(c));
  const late = Date.parse(i.acked_at) > Date.parse(String(p(sentEvent).deadline_at));
  const event = store.append({ type: "investor_events.acked", ...ctx(i), actor: { kind: "external", id: "fnma" }, occurredAt: i.acked_at, causationId: sentEvent.id,
    payload: { type: "EscrowSetup", category: i.category, sequence: 1, status: i.status, warning: i.status === "accepted_warning" ? i.message ?? null : null, fnma_response_id: i.fnma_response_id, acked_categories: acked, expected_categories: expected, every_category: every, deadline_at: p(sentEvent).deadline_at, deadline_basis: p(sentEvent).deadline_basis, late, ...withApp(i) } });
  return { every_category: every, acked, expected, event };
}
/** The decision record's `escrow_setup` block (AI agent design): category, amount, deadline basis, accepted_at. */
export function escrowSetupDecision(store: EventStore, loanId: string, plan: EscrowSetupPlan): { category: string; amount_cents: Cents; deadline_at: string | null; deadline_basis: EscrowSetupDeadlineBasis; accepted_at: string | null }[] {
  return plan.events.map((e) => { const ack = latest(loanEvents(store, loanId, "investor_events.acked").filter((a) => p(a).type === "EscrowSetup" && p(a).category === e.category)); return { category: e.category, amount_cents: e.amount_cents, deadline_at: plan.deadline_at_ms === null ? null : toIso(plan.deadline_at_ms), deadline_basis: plan.deadline_basis, accepted_at: ack ? ack.occurredAt : null }; });
}

// ───────────────────────────── rule 8: custodial transfers (F-1-03) ─────────────────────────────
export interface CustodialTransferRow {
  readonly id: string; readonly loan_id: string; readonly kind: CustodialTransferKind; readonly amount_cents: Cents; readonly from_account_id: string; readonly to_account_id: string;
  readonly proceeds_received_at: string; readonly due_on: PlainDate; readonly due_at: string; transferred_at: string | null; bank_reference: string | null; ledger_entry_id: string | null; bank_matched_on: PlainDate | null;
}
/** 27.2's `proceeds.received` (the bank match) for the loan — the deposit clocks anchor on it. */
export const proceedsReceived = (store: EventStore, loanId: string): DomainEvent | null => latest(loanEvents(store, loanId, "proceeds.received"));
/** F-1-03: each pre-purchase balance moves to the Fannie Mae T&I / P&I custodial account no later than one servicer business day after the purchase proceeds are received. */
export function scheduleCustodialTransfers(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly proceeds_received_at: string; readonly balances: { readonly ti_escrow_balance_cents: Cents; readonly ti_buydown_funds_cents?: Cents; readonly pi_prepurchase_collections_cents?: Cents }; readonly fnma_ti_account_id: string; readonly fnma_pi_account_id: string; readonly actor?: Actor }): { rows: CustodialTransferRow[]; due_on: PlainDate; events: DomainEvent[] } {
  need(Date.parse(i.proceeds_received_at) > 0, "proceeds_received_at is the bank-matched receipt instant");
  const receivedOn = etDate(i.proceeds_received_at); const due_on = addBusinessDays(receivedOn, 1, servicer); const due_at = toIso(zonedEpochMs(due_on, "23:59", ET));
  const specs: { kind: CustodialTransferKind; amount: Cents; from: string; to: string }[] = [
    { kind: "ti_escrow_balance", amount: i.balances.ti_escrow_balance_cents, from: PREPURCHASE_TI_ACCOUNT, to: i.fnma_ti_account_id },
    { kind: "ti_buydown_funds", amount: i.balances.ti_buydown_funds_cents ?? 0n, from: PREPURCHASE_TI_ACCOUNT, to: i.fnma_ti_account_id },
    { kind: "pi_prepurchase_collections", amount: i.balances.pi_prepurchase_collections_cents ?? 0n, from: PREPURCHASE_PI_ACCOUNT, to: i.fnma_pi_account_id },
  ];
  const rows = specs.filter((s) => s.amount > 0n).map((s): CustodialTransferRow => ({ id: `ct-${i.loan_id}-${s.kind}`, loan_id: i.loan_id, kind: s.kind, amount_cents: s.amount, from_account_id: s.from, to_account_id: s.to, proceeds_received_at: i.proceeds_received_at, due_on, due_at, transferred_at: null, bank_reference: null, ledger_entry_id: null, bank_matched_on: null }));
  const events = rows.map((r) => store.append({ type: "custodial_transfers.scheduled", ...ctx(i), actor: i.actor ?? { kind: "agent", id: "custodial-recon" }, occurredAt: i.proceeds_received_at, payload: { transfer_id: r.id, kind: r.kind, amount_cents: String(r.amount_cents), from_account_id: r.from_account_id, to_account_id: r.to_account_id, proceeds_received_at: r.proceeds_received_at, due_on, due_at, ...withApp(i) } }));
  return { rows, due_on, events };
}
const custodialCash = (kind: CustodialTransferKind, accountId: string): AccountRef => ({ scope: "custodial", custodialAccountId: accountId, account: kind === "pi_prepurchase_collections" ? "custodial_pi_cash" : "custodial_ti_cash" });
/** The book transfer: Dr Fannie Mae custodial cash / Cr pre-purchase custodial cash — no borrower-level entry (the loan's `escrow` liability is unchanged). */
export function executeBookTransfer(ledger: Ledger, store: EventStore, row: CustodialTransferRow, i: { readonly application_id?: string | null; readonly transferred_at: string; readonly bank_reference?: string | null; readonly actor?: Actor }): { row: CustodialTransferRow; set: EntrySet; late: boolean; event: DomainEvent } {
  need(row.transferred_at === null, `custodial transfer ${row.id} was already executed at ${row.transferred_at}`);
  const on = etDate(i.transferred_at);
  const set = ledger.post({ effectiveDate: on, description: `30.1 F-1-03 ${row.kind} ${row.loan_id}: ${row.from_account_id} → ${row.to_account_id}`, lines: [
    { account: custodialCash(row.kind, row.to_account_id), amountCents: row.amount_cents, ruleRef: "30.1 rule 8 / F-1-03 one-business-day deposit" },
    { account: custodialCash(row.kind, row.from_account_id), amountCents: -row.amount_cents, ruleRef: "30.1 rule 8 / F-1-03 one-business-day deposit" }] }, i.transferred_at);
  row.transferred_at = i.transferred_at; row.ledger_entry_id = set.id; row.bank_reference = i.bank_reference ?? null;
  const late = on > row.due_on;
  const event = store.append({ type: "custodial.book_transfer.posted", loanId: row.loan_id, ...(i.application_id ? { applicationId: i.application_id } : {}), actor: i.actor ?? { kind: "agent", id: "custodial-recon" }, occurredAt: i.transferred_at, payload: { transfer_id: row.id, kind: row.kind, amount_cents: String(row.amount_cents), ledger_entry_id: set.id, transferred_on: on, due_on: row.due_on, late, bank_reference: row.bank_reference, ...withApp(i) } });
  return { row, set, late, event };
}
export interface BankFeedCredit { readonly amountCents: Cents; readonly bankReference: string; readonly text: string }
/** The T&I / P&I bank feed (BAI2/camt.053, 6.4) shows the credit → `custodial.prepurchase_funds.transferred{kind, bank_matched=true}` — the F-1-03 timers' satisfying event. */
export function matchBankFeed(store: EventStore, row: CustodialTransferRow, i: { readonly application_id?: string | null; readonly credits: readonly BankFeedCredit[]; readonly matched_at: string; readonly actor?: Actor }): { matched: boolean; credit: BankFeedCredit | null; event: DomainEvent | null } {
  need(row.transferred_at !== null, `custodial transfer ${row.id} has not been executed`);
  const credit = i.credits.find((c) => c.amountCents === row.amount_cents && (row.bank_reference === null || c.bankReference === row.bank_reference)) ?? null;
  if (!credit) return { matched: false, credit: null, event: null };
  row.bank_matched_on = etDate(i.matched_at); row.bank_reference = credit.bankReference;
  const event = store.append({ type: "custodial.prepurchase_funds.transferred", loanId: row.loan_id, ...(i.application_id ? { applicationId: i.application_id } : {}), actor: i.actor ?? { kind: "agent", id: "custodial-recon" }, occurredAt: i.matched_at,
    payload: { transfer_id: row.id, kind: row.kind, amount_cents: String(row.amount_cents), from_account_id: row.from_account_id, to_account_id: row.to_account_id, bank_reference: credit.bankReference, bank_matched: true, matched_on: row.bank_matched_on, ledger_entry_id: row.ledger_entry_id, transferred_at: row.transferred_at, late: etDate(row.transferred_at!) > row.due_on, ...withApp(i) } });
  return { matched: true, credit, event };
}

// ───────────────────────────── rule 9: MERS state after purchase ─────────────────────────────
export interface MinUpdateTxn { readonly txnId: string; readonly min: string; readonly type: "min_update_other"; readonly subtype: "interim_funder_removed"; readonly effectiveDate: PlainDate; readonly orgId: string; readonly field: "interim_funder"; readonly from_org_id: string; readonly to_org_id: null }
/** 27.2's `warehouse.advance.repaid` for the loan, with whether the repayment is bank-matched (`proceeds.matched` or the payload's own flag) and the note form. */
export function advanceRepaid(store: EventStore, loanId: string): { event: DomainEvent; repaid_on: PlainDate; bank_matched: boolean; note_form: NoteForm } | null {
  const e = latest(loanEvents(store, loanId, "warehouse.advance.repaid")); if (!e) return null;
  const matched = p(e).bank_matched === true || p(e).repaid_from === "purchase_proceeds" || loanEvents(store, loanId, "proceeds.matched").length > 0;
  const repaidRaw = p(e).repaid_at; const repaid_on = typeof repaidRaw === "string" ? (/^\d{4}-\d{2}-\d{2}$/.test(repaidRaw) ? D(repaidRaw) : etDate(repaidRaw)) : etDate(e.occurredAt);
  return { event: e, repaid_on, bank_matched: matched, note_form: p(e).note_form === "enote" ? "enote" : "paper" };
}
/** MIN Update removing SM's Interim Funder Org ID in the batch of the servicer business day after `warehouse.advance.repaid` — only after the repayment is bank-matched; never a TOB. */
export function interimFunderRemovalTxn(i: { readonly min: string; readonly repaid_on: PlainDate; readonly bank_matched: boolean; readonly sm_org_id?: string }): { txn: MinUpdateTxn; batch_on: PlainDate; tob: false } {
  need(i.bank_matched, "the Interim Funder removal is submitted only after warehouse.advance.repaid is bank-matched");
  need(/^\d{18}$/.test(i.min), "min must be 18 digits");
  const batch_on = addBusinessDays(i.repaid_on, 1, servicer); const org = i.sm_org_id ?? SUPERMORTGAGE_ORG_ID;
  return { txn: { txnId: `mu-${i.min}-if-${batch_on}`, min: i.min, type: "min_update_other", subtype: "interim_funder_removed", effectiveDate: batch_on, orgId: org, field: "interim_funder", from_org_id: org, to_org_id: null }, batch_on, tob: false };
}
export const isTob = (txn: { readonly type: string }): boolean => /tob/i.test(txn.type);
/** The MERS acknowledgment of the MIN Update: accepted → `mers_transactions{subtype=interim_funder_removed}` (1.5's `mers.txn.accepted`) and 27.2's `warehouse.interim_funder.removed`; rejected → 1.5 QA finding, resubmit after reconciliation. */
export function recordMinUpdateAck(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly txn: MinUpdateTxn; readonly batch_id: string; readonly accepted: boolean; readonly reject_reason?: string | null; readonly acked_at: string }): { events: DomainEvent[]; removed: boolean; qa_finding: { kind: "min_update_rejected"; min: string; reason: string } | null } {
  const MERS: Actor = { kind: "external", id: "mers" };
  const base = { batch_id: i.batch_id, min: i.txn.min, txn_type: i.txn.type, subtype: i.txn.subtype, effective_date: i.txn.effectiveDate, acked_at: i.acked_at, all_mins: true, ...withApp(i) };
  if (!i.accepted) {
    const reason = i.reject_reason ?? "rejected";
    return { events: [store.append({ type: "mers.txn.rejected", ...ctx(i), aggregate: { kind: "mers_txn", id: `${i.batch_id}:${i.txn.min}` }, actor: MERS, occurredAt: i.acked_at, payload: { ...base, reason } })], removed: false, qa_finding: { kind: "min_update_rejected", min: i.txn.min, reason } };
  }
  const accepted = store.append({ type: "mers.txn.accepted", ...ctx(i), aggregate: { kind: "mers_txn", id: `${i.batch_id}:${i.txn.min}` }, actor: MERS, occurredAt: i.acked_at, payload: base });
  const removed = store.append({ type: "warehouse.interim_funder.removed", ...ctx(i), actor: MERS, occurredAt: i.acked_at, causationId: accepted.id, payload: { min: i.txn.min, interim_funder_org_id_removed: i.txn.from_org_id, mers_transaction_subtype: i.txn.subtype, batch_id: i.batch_id, removed_at: i.acked_at, ...withApp(i) } });
  return { events: [accepted, removed], removed: true, qa_finding: null };
}
export interface MinFields { readonly investor_org_id: string; readonly servicer_org_id: string; readonly subservicer_org_id: string | null; readonly interim_funder_org_id: string | null; readonly status?: string }
export interface MersVerification { readonly verified: boolean; readonly problems: string[]; readonly due_on: PlainDate; readonly events: DomainEvent[]; readonly partner_query: { kind: "partner_query"; addressee: "Fannie Mae MERS Program Office"; citation: "Selling Guide B8-7-01"; min: string; snapshot_on: PlainDate; problems: string[] } | null; readonly w016_closed: boolean }
/**
 * Expected MIN record after purchase: Servicer = partner, Subservicer = SM, Investor = Fannie Mae (Fannie Mae's own update
 * — B8-7-01), Interim Funder empty. Verified from the batch acknowledgment / MRE snapshot; not reflected within 10 servicer
 * BDs → partner query package for Fannie Mae's MERS Program Office; 1.5's W-016 stays open. SM never submits a TOB.
 */
export function verifyMersInvestor(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly min: string; readonly snapshot: MinFields; readonly snapshot_on: PlainDate; readonly purchase_date: PlainDate; readonly partner_org_id: string; readonly fnma_investor_org_id?: string; readonly sm_org_id?: string; readonly actor?: Actor }): MersVerification {
  const fnma = i.fnma_investor_org_id ?? FANNIE_MAE_ORG_ID, sm = i.sm_org_id ?? SUPERMORTGAGE_ORG_ID; const s = i.snapshot; const problems: string[] = [];
  if (s.status && s.status.toLowerCase() !== "active") problems.push(`MIN is ${s.status}`);
  if (s.investor_org_id !== fnma) problems.push(`investor ${s.investor_org_id} ≠ Fannie Mae ${fnma}`);
  if (s.servicer_org_id !== i.partner_org_id) problems.push(`servicer ${s.servicer_org_id} ≠ partner ${i.partner_org_id}`);
  if (s.subservicer_org_id !== sm) problems.push(`subservicer ${s.subservicer_org_id ?? "none"} ≠ SM ${sm}`);
  if (s.interim_funder_org_id) problems.push(`interim funder ${s.interim_funder_org_id} still named`);
  const due_on = addBusinessDays(i.purchase_date, 10, servicer); const actor = i.actor ?? { kind: "agent", id: "post-closing" }; const at = toIso(zonedEpochMs(i.snapshot_on, "07:00", ET));
  const events: DomainEvent[] = [store.append({ type: "mers_min_snapshots.recorded", ...ctx(i), actor, occurredAt: at, payload: { min: i.min, snapshot_source: "mers_batch", ...s, snapshot_on: i.snapshot_on, ...withApp(i) } })];
  if (s.investor_org_id === fnma) {
    events.push(store.append({ type: "mers.investor.fnma_verified", ...ctx(i), actor, occurredAt: at, payload: { min: i.min, investor_org_id: s.investor_org_id, verified_on: i.snapshot_on, snapshot_source: "mers_batch", subtype: "investor_verified", other_problems: problems, ...withApp(i) } }));
    events.push(store.append({ type: "loan.boarding_exception.resolved", ...ctx(i), actor, occurredAt: at, payload: { rule_code: "W-016", severity: "warning", resolved_by: "mers.investor.fnma_verified", min: i.min, ...withApp(i) } }));
    return { verified: true, problems, due_on, events, partner_query: null, w016_closed: true };
  }
  const partner_query = i.snapshot_on >= due_on ? { kind: "partner_query" as const, addressee: "Fannie Mae MERS Program Office" as const, citation: "Selling Guide B8-7-01" as const, min: i.min, snapshot_on: i.snapshot_on, problems } : null;
  if (partner_query) events.push(store.append({ type: "mers.investor.query_packaged", ...ctx(i), actor, occurredAt: at, payload: { ...partner_query, w016_open: true, no_tob: true, ...withApp(i) } }));
  return { verified: false, problems, due_on, events, partner_query, w016_closed: false };
}

// ───────────────────────────── rule 10: eNote state after purchase ─────────────────────────────
export interface ERegistryInquiry { readonly controller_org_id: string; readonly location_org_id: string; readonly master_servicer_org_id: string | null; readonly secured_party_org_id: string | null }
export type ENoteMismatch = "enote_controller_mismatch" | "enote_location_mismatch" | "enote_master_servicer_mismatch" | "enote_secured_party_present";
/** C1-2-04: Controller = Fannie Mae, Location = Fannie Mae's eVault, Master Servicer = SM's Org ID (the subservicer), Secured Party cleared → `enote.post_purchase.verified`; else the mismatch reasons that block eNote commands. */
export function verifyENote(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly inquiry: ERegistryInquiry; readonly inquiry_at: string; readonly fnma_org_id?: string; readonly fnma_evault_org_id?: string; readonly sm_org_id?: string; readonly actor?: Actor }): { verified: boolean; mismatches: ENoteMismatch[]; event: DomainEvent } {
  const fnma = i.fnma_org_id ?? FANNIE_MAE_ORG_ID, evault = i.fnma_evault_org_id ?? FNMA_EVAULT_ORG_ID, sm = i.sm_org_id ?? SUPERMORTGAGE_ORG_ID; const q = i.inquiry;
  const mismatches: ENoteMismatch[] = [];
  if (q.controller_org_id !== fnma) mismatches.push("enote_controller_mismatch");
  if (q.location_org_id !== evault) mismatches.push("enote_location_mismatch");
  if (q.master_servicer_org_id !== sm) mismatches.push("enote_master_servicer_mismatch");
  if (q.secured_party_org_id) mismatches.push("enote_secured_party_present");
  const actor = i.actor ?? { kind: "agent", id: "post-closing" };
  const event = mismatches.length
    ? store.append({ type: "enote.post_purchase.mismatch", ...ctx(i), actor, occurredAt: i.inquiry_at, payload: { ...q, reasons: mismatches, blocked_commands: ["payoff", "modification"], ...withApp(i) } })
    : store.append({ type: "enote.post_purchase.verified", ...ctx(i), actor, occurredAt: i.inquiry_at, payload: { ...q, post_purchase_verified_at: i.inquiry_at, sfc_508: true, note_location: "fnma_evault", ...withApp(i) } });
  return { verified: mismatches.length === 0, mismatches, event };
}
/** 1.4 pattern: payoff / modification commands on an eNote are blocked until the post-purchase eRegistry state is verified. */
export function enoteCommandGate(store: EventStore, loanId: string): { blocked: boolean; reason: ENoteMismatch | "enote_post_purchase_unverified" | null } {
  const last = latest(store.byLoan(loanId).filter((e) => e.type === "enote.post_purchase.verified" || e.type === "enote.post_purchase.mismatch"));
  if (!last) return { blocked: true, reason: "enote_post_purchase_unverified" };
  if (last.type === "enote.post_purchase.verified") return { blocked: false, reason: null };
  return { blocked: true, reason: ((p(last).reasons as ENoteMismatch[])[0] ?? "enote_post_purchase_unverified") };
}

// ───────────────────────────── rule 11: custody record ─────────────────────────────
export interface CustodyRecordFinal { readonly loan_id: string; readonly certification_status: "certified"; readonly code_type: "none"; readonly note_location: "custodian" | "fnma_evault"; readonly custodian_party_id: string | null; readonly sfc_508: boolean; readonly certified_on: PlainDate; readonly recert_timers: "not_applicable" }
/** Paper note: stays with the partner's Form 2017 custodian that certified (`certified`/`Qualified Cert`); eNote: Fannie Mae's eVault with SFC 508. 1.4's recert timers do not apply (no transfer). */
export function finalizeCustodyRecord(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly note_form: NoteForm; readonly certification_status: "certified" | "qualified_cert"; readonly custodian_party_id: string | null; readonly certified_on: PlainDate; readonly now: string; readonly actor?: Actor }): { record: CustodyRecordFinal; event: DomainEvent } {
  need(i.note_form === "enote" || !!i.custodian_party_id, "a paper note's custody record names the partner's Form 2017 custodian");
  const record: CustodyRecordFinal = { loan_id: i.loan_id, certification_status: "certified", code_type: "none", note_location: i.note_form === "enote" ? "fnma_evault" : "custodian", custodian_party_id: i.note_form === "enote" ? null : i.custodian_party_id, sfc_508: i.note_form === "enote", certified_on: i.certified_on, recert_timers: "not_applicable" };
  const event = store.append({ type: "custody.record.finalized", ...ctx(i), actor: i.actor ?? { kind: "agent", id: "boarding" }, occurredAt: i.now, payload: { ...record, loan_delivery_certification: i.certification_status, ...withApp(i) } });
  return { record, event };
}

// ───────────────────────────── purchase intake and the roll-up ─────────────────────────────
export interface TimerCanceller { forSubject(kind: string, id: string): readonly { readonly id: string; readonly code: string; readonly status: string }[]; cancel(id: string, reason: string, actor?: Actor): void }
/** The 30.1 rows `loan.purchased` arms that do not apply to this loan are cancelled with the reason (the registry's conditions "escrowed loans; flag on", "MERS loans", "eNotes" — one code, one trigger). */
export function onLoanPurchased(timers: TimerCanceller, loan: PurchaseLoan, flags: { readonly escrow_events_on: boolean }): { cancelled: { code: string; reason: string }[] } {
  const cancelled: { code: string; reason: string }[] = [];
  const drop = (code: string, reason: string): void => { for (const t of timers.forSubject("loan", loan.loan_id)) if (t.code === code && (t.status === "armed" || t.status === "breached")) { timers.cancel(t.id, reason, SYSTEM_30_1); cancelled.push({ code, reason }); } };
  if (!loan.escrowed) drop("LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1", "non-escrowed loan: no Escrow Setup event (escrow_setup_acked on first_lar_accepted)");
  else if (!flags.escrow_events_on) drop("LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1", `${ESCROW_EVENTS_FLAG} off: 3.7's cut-over job sends the Setup event`);
  if (loan.note_form !== "enote") drop("SM_ENOTE_POST_PURCHASE_VERIFY_1BD", "paper note: no eRegistry state to verify");
  if (!loan.mers_registered) drop("SM_MERS_INVESTOR_FNMA_VERIFY_10BD", "not MERS-registered: investor verification by assignment record (1.4)");
  return { cancelled };
}
/** `proceeds.received` with no pre-purchase P&I collections: the P&I deposit row has nothing to move. */
export function onProceedsReceived(timers: TimerCanceller, loanId: string, balances: { readonly pi_prepurchase_collections_cents?: Cents }): { cancelled: string[] } {
  const cancelled: string[] = [];
  if ((balances.pi_prepurchase_collections_cents ?? 0n) === 0n) for (const t of timers.forSubject("loan", loanId)) if (t.code === "FNMA_F1_03_PI_DEPOSIT_PROCEEDS_1BD" && t.status === "armed") { timers.cancel(t.id, "no P&I collected between delivery and purchase", SYSTEM_30_1); cancelled.push(t.code); }
  return { cancelled };
}
export interface SetupFacts { readonly escrowed: boolean; readonly escrow_events_on: boolean; readonly note_form: NoteForm; readonly mers_registered: boolean }
export interface SetupProgress { readonly status: InvestorSetupStatus; readonly steps: Record<string, boolean>; readonly pending: string[] }
/** The state machine derived from the loan's events (transitions to established / first_lar_accepted / escrow_setup_acked come only from parsed Fannie Mae responses). */
export function investorSetupStatus(store: EventStore, loanId: string, f: SetupFacts): SetupProgress {
  const has = (type: string, pred: (e: DomainEvent) => boolean = () => true): boolean => loanEvents(store, loanId, type).some(pred);
  const purchased = has("loan.investor_updated"), established = has("loan.fnma_established"), larAccepted = has("investor.first_lar.accepted");
  const setupNeeded = f.escrowed && f.escrow_events_on;
  const escrowAcked = larAccepted && (setupNeeded ? has("investor_events.acked", (e) => p(e).type === "EscrowSetup" && p(e).every_category === true) : true);
  const scheduled = loanEvents(store, loanId, "custodial_transfers.scheduled").map((e) => String(p(e).transfer_id));
  const matched = new Set(loanEvents(store, loanId, "custodial.prepurchase_funds.transferred").filter((e) => p(e).bank_matched === true).map((e) => String(p(e).transfer_id)));
  const steps: Record<string, boolean> = {
    purchase_update: purchased, established, first_lar_accepted: larAccepted, escrow_setup_acked: escrowAcked,
    custodial_transfers_matched: scheduled.length > 0 && scheduled.every((id) => matched.has(id)),
    mers_investor_verified: f.mers_registered ? has("mers.investor.fnma_verified") : true,
    interim_funder_removed: f.mers_registered && f.note_form === "paper" ? has("warehouse.interim_funder.removed") : true,
    enote_verified: f.note_form === "enote" ? has("enote.post_purchase.verified") : true,
    custody_record_finalized: has("custody.record.finalized"),
  };
  const pending = Object.entries(steps).filter(([, ok]) => !ok).map(([k]) => k);
  const status: InvestorSetupStatus = !purchased ? "pre_purchase" : !established ? "purchased" : !larAccepted ? "established" : !escrowAcked ? "first_lar_accepted" : pending.length ? "escrow_setup_acked" : "reporting_active";
  return { status, steps, pending };
}
/** All sub-steps complete → `loan.reporting_active` (SM_INVESTOR_SETUP_COMPLETE_5BD's satisfying event); 5.x cycles take over. */
export function completeInvestorSetup(store: EventStore, i: { readonly loan_id: string; readonly application_id?: string | null; readonly facts: SetupFacts; readonly now: string; readonly actor?: Actor }): { progress: SetupProgress; event: DomainEvent | null } {
  const progress = investorSetupStatus(store, i.loan_id, i.facts);
  if (progress.status !== "reporting_active") return { progress, event: null };
  const prior = latest(loanEvents(store, i.loan_id, "loan.reporting_active"));
  if (prior) return { progress, event: prior };
  const purchase = latest(loanEvents(store, i.loan_id, "loan.investor_updated"));
  const purchaseDate = purchase ? D(String(p(purchase).purchase_date)) : etDate(i.now);
  const event = store.append({ type: "loan.reporting_active", ...ctx(i), actor: i.actor ?? SYSTEM_30_1, occurredAt: i.now, payload: { investor_setup_status: "reporting_active", completed_on: etDate(i.now), purchase_date: purchaseDate, days_to_reporting_active: daysBetween(purchaseDate, etDate(i.now)), steps: progress.steps, ...withApp(i) } });
  return { progress, event };
}
/** The "Post-purchase setup" line on the Compliance Sentinel daily report (30.4) — read from the loan's events and its timers. */
export function postPurchaseSetupLine(store: EventStore, loanId: string, timers: readonly { readonly code: string; readonly status: string; readonly dueDate?: PlainDate }[]): Record<string, unknown> {
  const one = (type: string): DomainEvent | null => latest(loanEvents(store, loanId, type));
  const timer = (code: string) => timers.filter((t) => t.code === code).at(-1) ?? null;
  const firstLar = one("investor.first_lar.accepted") ? "accepted" : timer("FNMA_TT96_FIRST_LAR_ACQ_MONTH_BD2")?.status === "breached" ? "breached" : one("investor.first_lar.submitted") ? "submitted" : firstLarGate(store, loanId).held ? "held" : "pending";
  const setup = one("investor_events.acked") ? "acked" : one("escrow.setup_event.sent") ? "sent" : one("investor_setup.escrow_setup_acked") ? "not_required" : "pending";
  const ct = one("custodial.prepurchase_funds.transferred") ? "matched" : timer("FNMA_F1_03_TI_DEPOSIT_PROCEEDS_1BD")?.status === "breached" ? "breached" : one("custodial_transfers.scheduled") ? "scheduled" : "pending";
  const active = one("loan.reporting_active");
  return { loan_id: loanId, purchase_date: one("loan.investor_updated") ? p(one("loan.investor_updated")!).purchase_date : null, establishment_date: one("loan.fnma_established") ? p(one("loan.fnma_established")!).established_at : null,
    first_lar_status: firstLar, setup_event_status: setup, custodial_transfer_status: ct, mers_verified: !!one("mers.investor.fnma_verified"), enote_verified: !!one("enote.post_purchase.verified"),
    days_to_reporting_active: active ? p(active).days_to_reporting_active : null, breached_timers: timers.filter((t) => t.status === "breached").map((t) => t.code) };
}
/** The AI agent design's decision record for the loan, assembled from the events every step appended. */
export function setupDecisionRecord(store: EventStore, loanId: string, plan: EscrowSetupPlan | null, extra: { readonly model_version?: string } = {}): Record<string, unknown> {
  const one = (type: string): DomainEvent | null => latest(loanEvents(store, loanId, type)); const pu = one("loan.investor_updated"); const sub = one("investor.first_lar.submitted"); const acc = one("investor.first_lar.accepted");
  return { loan_id: loanId, fnma_loan_number: pu ? p(pu).fnma_loan_number : null, purchase_date: pu ? p(pu).purchase_date : null, established_at: one("loan.fnma_established") ? p(one("loan.fnma_established")!).established_at : null, remittance_type: pu ? p(pu).remittance_type : null, ptr: pu ? p(pu).pass_through_rate : null,
    first_lar: { event_id: sub?.id ?? null, submitted_at: sub?.occurredAt ?? null, accepted_at: acc?.occurredAt ?? null }, escrow_setup: plan ? escrowSetupDecision(store, loanId, plan) : [],
    custodial_transfers: loanEvents(store, loanId, "custodial.prepurchase_funds.transferred").map((e) => ({ kind: p(e).kind, amount_cents: p(e).amount_cents, bank_reference: p(e).bank_reference, matched_on: p(e).matched_on })),
    mers: { interim_funder_removed_at: one("warehouse.interim_funder.removed")?.occurredAt ?? null, investor_verified_at: one("mers.investor.fnma_verified")?.occurredAt ?? null }, enote: { verified_at: one("enote.post_purchase.verified")?.occurredAt ?? null },
    variances: loanEvents(store, loanId, "position_variance.opened").map((e) => ({ kind: p(e).kind, citation: p(e).citation, money: p(e).money, resolved: loanEvents(store, loanId, "position_variance.resolved").some((r) => p(r).opened_event_id === e.id) })),
    rule_set_version: RULE_SET_VERSION, model_version: extra.model_version ?? null };
}
/** A `custodial_transfers` row's due date from the receipt instant alone (for the tools' read path). */
export const depositDueOn = (proceedsReceivedAt: string): PlainDate => addBusinessDays(etDate(proceedsReceivedAt), 1, servicer);
export const plainDate = D; export { addDays };
