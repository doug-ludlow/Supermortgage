/**
 * §27.2 Purchase-proceeds settlement, warehouse payoff, gain-on-sale computation, the borrower rate pass-through
 * proof (Grander economics), the MSR data hand-off, the 12.5 bps platform fee, post-purchase adjustments and the
 * GL export. One small pure function per rule / T-id; the event emitters the 27.2 timers arm on and are satisfied by;
 * balanced ledger sets for SM's books and the partner GL mirror. Every amount is deterministic code (Decimal, never
 * floating point; bigint cents; rounding half-up at each dollar conversion — spec "Business rules" preamble).
 *
 * Reused from 27.1 (never re-implemented): the accrual / payoff calculators (`payoffStatement`, the cumulative
 * accrual rows), the advance-keyed emitter (`emitAdvance` — every 27.2 event carries loanId + applicationId +
 * payload.source = "origination" so the origination timers arm), the ledger account names and the bank wire port.
 *
 * Events (timer subject in brackets):
 *   purchase_advice.received{advice_date, fnma_loan_number, net_proceeds_cents, …}      [arms FNMA_C2_2_05_PPA_REQUEST_30; 30.1 consumes]
 *   purchase_advice.matched / purchase_advice.unmatched (advice for a loan SM did not fund)
 *   proceeds.received{receipt_id, value_date, amount_cents}                              [satisfies SM_WH_PROCEEDS_EXPECTED_1BD; arms SM_WH_PROCEEDS_MATCH_SAME_DAY]
 *   proceeds.matched{match_id, matched_at, variance_cents, status}                       [satisfies …MATCH_SAME_DAY; arms SM_WH_PAYOFF_POST_SAME_DAY, SM_MSR_HANDOFF_1BD]
 *   proceeds.exception{kind ∈ price, llpa, interest, fees, unexplained, convention_changed, wrong_account, missing_advice, duplicate_receipt}
 *   proceeds.provisional_match{…}  fnma_interest_convention.locked{convention}
 *   settlement.waterfall.posted{posted_at, shortfall_cents, shortfall}                    [satisfies …PAYOFF_POST; arms SM_WH_PARTNER_RESIDUAL_1BD, SM_WH_SHORTFALL_DRAFT_2BD, SM_GOS_POST_1BD]
 *   warehouse.advance.repaid{repaid_from=purchase_proceeds, bank_matched, note_form, repaid_at}   [27.1 baseline; arms the bailee / Interim Funder release clocks; 30.1 consumes]
 *   warehouse.bailee_letter.released (paper) / warehouse.collateral.status_changed{to=released} (eNote: Funding Agreement release on payment)
 *   partner.residual.paid{wire_ref, value_date}                                          [satisfies SM_WH_PARTNER_RESIDUAL_1BD]
 *   settlement.shortfall.drafted / settlement.shortfall.received                          [SM_WH_SHORTFALL_DRAFT_2BD]
 *   gain_on_sale.computed / gain_on_sale.posted{passthrough_reconciled=true} / rate_passthrough.reconciled{status}   [SM_GOS_POST_1BD]
 *   msr.handoff.issued / msr.handoff.acknowledged                                        [SM_MSR_HANDOFF_1BD]
 *   platform_fee.accrued{period, fee_cents}                                              [SM_PLATFORM_FEE_ACCRUAL_MONTHLY]
 *   gl.export.completed{target ∈ sm_gl, partner_gl}                                      [SM_GL_EXPORT_DAILY]
 *   ppa.requested{kind ∈ funds_transfer_error, data_correction; channel} / ppa.resolved   [FNMA_C2_2_05_PPA_REQUEST_30, FNMA_C1_2_02_PPA_LLPA_REPRICING_18M]
 *   premium_recapture.assessed{assessed_cents}                                           [FNMA_C1_1_01_PREMIUM_RECAPTURE_120 (20.1) — exposure kept until the gate opens]
 * Consumed (never re-emitted): `custody.certified` / `delivery.status.observed` / `loan.purchased` (29.4 / 30.1),
 * `warehouse.interim_funder.removed` (30.1 emits under 27.2's SM_WH_INTERIM_FUNDER_RELEASE_2BD).
 */
import { createHash } from "node:crypto";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, daysBetween, addMonths, parts, ymd, daysInMonth, endOfMonth } from "../../kernel/calendar/date.ts";
import { addBusinessDays, rollBack, rollForward, servicer, federal, fannieEt } from "../../kernel/calendar/business.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, EntrySetInput, LineInput, LoanAccount, CustodialAccount, CorporateAccount, EntrySet } from "../../kernel/ledger/ledger.ts";
import { WAREHOUSE_AGENT, roundCents, etDate, etHour, GuardrailViolation, emitAdvance, emitFacility, WH_ACCOUNTS, type AdvanceKeys, type PayoffStatement, type NoteForm } from "./ops-27-1.ts";

export { WAREHOUSE_AGENT, GuardrailViolation, roundCents, etDate };
export const ECONOMICS_RULE_SETS = { fnma: "fnma.selling.2026-09-02", llpa: "fnma.llpa.09.09.2026", warehouse: "sm.warehouse.v1", economics: "sm.economics.v1" } as const;

// ============================================================ policy (sm.economics.v1 — term-sheet parameters)
export interface EconomicsPolicy {
  readonly version: string;
  /** 12.5 bps/yr on UPB (rule 9). */
  readonly platform_fee_bps: string;
  /** Fixed 25 bps servicing fee (v1: no buy-up/buy-down). */
  readonly servicing_fee_bps: number;
  /** SM cost recovery capped at the quote's forecast × 110% (rule 3 step 4; 27.2-Q2). */
  readonly cost_recovery_cap_pct: number;
  readonly surplus_disposition: "partner" | "sm_capped_recovery" | "borrower_post_closing_credit";
  readonly post_closing_borrower_credit: boolean;
  /** |variance| ≤ $1.00 → matched (rounding). */
  readonly rounding_tolerance_cents: Cents;
  /** |variance| ≤ $100.00 with a fully explained breakdown → matched_with_variance. */
  readonly explained_tolerance_cents: Cents;
  /** A receipt without an advice is provisionally matched to the loan whose forecast equals the amount within $100. */
  readonly provisional_tolerance_cents: Cents;
  /** $100 minimum (credit or debit) for LLPA data-correction PPAs. */
  readonly ppa_llpa_min_cents: Cents;
  readonly recapture_window_days: number;
  readonly ppa_funds_transfer_window_days: number;
  readonly ppa_llpa_lookback_months: number;
  readonly advice_cutoff_et: string;
  readonly match_deadline_et: string;
  readonly gl_export_et: string;
  readonly fee_accrual_et: string;
}
export const ECONOMICS_V1: EconomicsPolicy = {
  version: ECONOMICS_RULE_SETS.economics, platform_fee_bps: "12.5", servicing_fee_bps: 25, cost_recovery_cap_pct: 110, surplus_disposition: "partner", post_closing_borrower_credit: false,
  rounding_tolerance_cents: 100n, explained_tolerance_cents: 10_000n, provisional_tolerance_cents: 10_000n, ppa_llpa_min_cents: 10_000n,
  recapture_window_days: 120, ppa_funds_transfer_window_days: 30, ppa_llpa_lookback_months: 18, advice_cutoff_et: "14:00", match_deadline_et: "18:00", gl_export_et: "20:00", fee_accrual_et: "03:00",
};

// ============================================================ helpers
export type RemittanceType = "aa" | "ss" | "sa";
export type InterestConvention = "a_30_360" | "b_act_365";
export type PartnerConvention = InterestConvention | "unresolved";
export type ObservedConvention = InterestConvention | "other";
export type InterestDirection = "due_fannie_mae" | "due_lender" | "none";
const cmp = (a: Cents, b: Cents): Cents => (a < b ? a : b);
export const absCents = (v: Cents): Cents => (v < 0n ? -v : v);
const pctOfPar = (price: string): Decimal => Decimal.parse(price).div(Decimal.fromInt(100));
const pctToRatio = (pct: string): Decimal => Decimal.parse(pct).div(Decimal.fromInt(100));
const mul = (cents: Cents, r: Decimal): Cents => roundCents(Decimal.fromBigInt(cents).mul(r));
/** 30/360 (US) day count between two dates (Nov 19 → Dec 1 = 12; Dec 1 → Dec 2 = 1). */
export function days30_360(from: PlainDate, to: PlainDate): number {
  const a = parts(from), b = parts(to);
  const d1 = Math.min(a.d, 30), d2 = d1 === 30 ? Math.min(b.d, 30) : b.d;
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1);
}
/** `UPB × rate × days / basis`, rounded half-up to the cent (basis 360 for convention A, 365 for B). */
export function simpleInterest(upbCents: Cents, rate: string, days: number, basis: 360 | 365): Cents {
  if (days <= 0) return 0n;
  return roundCents(Decimal.fromBigInt(upbCents).mul(Decimal.parse(rate)).mul(Decimal.fromInt(days)).div(Decimal.fromInt(basis)));
}
/** 26.3's prepaid interest at closing: cent-rounded per diem (note rate / 365) × days ($93.97 × 19 = $1,785.43; $71.96 × 13 = $935.48). */
export function prepaidInterest(upbCents: Cents, noteRate: string, days: number): { per_diem_cents: Cents; prepaid_interest_cents: Cents } {
  const per_diem_cents = roundCents(Decimal.fromBigInt(upbCents).mul(Decimal.parse(noteRate)).div(Decimal.fromInt(365)));
  return { per_diem_cents, prepaid_interest_cents: per_diem_cents * BigInt(days) };
}

// ============================================================ rule 1: forecast at delivery
export interface LlpaItem { readonly code: string; readonly pct: string; }
export interface LlpaLine extends LlpaItem { readonly cents: Cents; }
export interface InterestForecast { readonly direction: InterestDirection; readonly days_a: number; readonly days_b: number; readonly cents_a: Cents; readonly cents_b: Cents; readonly signed_a: Cents; readonly signed_b: Cents; readonly from: PlainDate; readonly to: PlainDate; }
export interface ForecastInput {
  readonly upb_cents: Cents; readonly price: string; readonly llpa_items: readonly LlpaItem[]; readonly remittance_type: RemittanceType;
  readonly purchase_date: PlainDate; readonly lpi_date: PlainDate; readonly pass_through_rate: string; readonly fees_cents: Cents; readonly matrix_version: string;
}
export interface ProceedsForecast {
  readonly expected_gross_cents: Cents; readonly expected_llpa_cents: Cents; readonly llpa_items: readonly LlpaLine[]; readonly interest: InterestForecast;
  readonly expected_fees_cents: Cents; readonly expected_net_a_cents: Cents; readonly expected_net_b_cents: Cents; readonly matrix_version: string; readonly purchase_date: PlainDate;
  readonly conventions_stored: readonly ["a_30_360", "b_act_365"];
}
/**
 * C2-1.1-06 interest at purchase. A/A: purchase < LPI (paid ahead — a new loan with prepaid interest) → Fannie Mae
 * deducts from the purchase date to the LPI date; purchase > LPI → Fannie Mae pays from the LPI date to the purchase
 * date. S/S and S/A: from the first of the purchase month to the day before purchase (zero days on the 1st).
 * Convention A = 30/360 day-months; B = actual days / 365 — both are computed while `fnma_interest_convention = unresolved`.
 */
export function purchaseInterest(upbCents: Cents, ptr: string, remittance: RemittanceType, purchaseDate: PlainDate, lpiDate: PlainDate): InterestForecast {
  let direction: InterestDirection, from: PlainDate, to: PlainDate;
  if (remittance === "aa") {
    if (purchaseDate < lpiDate) { direction = "due_fannie_mae"; from = purchaseDate; to = lpiDate; }
    else if (purchaseDate > lpiDate) { direction = "due_lender"; from = lpiDate; to = purchaseDate; }
    else { direction = "none"; from = purchaseDate; to = purchaseDate; }
  } else {
    const p = parts(purchaseDate); from = ymd(p.y, p.m, 1); to = purchaseDate; direction = p.d === 1 ? "none" : "due_lender";
  }
  const days_a = days30_360(from, to), days_b = daysBetween(from, to);
  const cents_a = simpleInterest(upbCents, ptr, days_a, 360), cents_b = simpleInterest(upbCents, ptr, days_b, 365);
  const sign = direction === "due_fannie_mae" ? -1n : direction === "due_lender" ? 1n : 0n;
  return { direction, days_a, days_b, cents_a, cents_b, signed_a: sign * cents_a, signed_b: sign * cents_b, from, to };
}
/** `expected_gross = round(price/100 × UPB)`; `expected_llpa = Σ round(pct × UPB)` on the matrix version active on the expected Purchase Ready date; `expected_net = gross − llpa ± interest − fees`. */
export function forecastProceeds(i: ForecastInput): ProceedsForecast {
  if (i.upb_cents <= 0n) throw new RangeError("upb_cents must be > 0");
  const expected_gross_cents = mul(i.upb_cents, pctOfPar(i.price));
  const llpa_items = i.llpa_items.map((l) => ({ ...l, cents: mul(i.upb_cents, pctToRatio(l.pct)) }));
  const expected_llpa_cents = llpa_items.reduce((s, l) => s + l.cents, 0n);
  const interest = purchaseInterest(i.upb_cents, i.pass_through_rate, i.remittance_type, i.purchase_date, i.lpi_date);
  const base = expected_gross_cents - expected_llpa_cents - i.fees_cents;
  return { expected_gross_cents, expected_llpa_cents, llpa_items, interest, expected_fees_cents: i.fees_cents, expected_net_a_cents: base + interest.signed_a, expected_net_b_cents: base + interest.signed_b, matrix_version: i.matrix_version, purchase_date: i.purchase_date, conventions_stored: ["a_30_360", "b_act_365"] };
}
export const expectedNet = (f: ProceedsForecast, c: PartnerConvention): Cents => (c === "b_act_365" ? f.expected_net_b_cents : f.expected_net_a_cents);
export const forecastSignedInterest = (f: ProceedsForecast, c: PartnerConvention): Cents => (c === "b_act_365" ? f.interest.signed_b : f.interest.signed_a);

// ============================================================ rule 2: three-way match
export interface PurchaseAdviceRecord {
  readonly purchase_advice_id: string; readonly loan_id: string | null; readonly delivery_id: string | null; readonly fnma_loan_number: string; readonly seller_loan_number: string; readonly commitment_id_fnma: string | null;
  readonly advice_date: PlainDate; readonly purchase_date: PlainDate; readonly purchase_ready_date: PlainDate | null; readonly remittance_type: RemittanceType;
  readonly note_rate: string; readonly pass_through_rate: string; readonly servicing_fee_bps: number; readonly lpi_date: PlainDate;
  readonly interest_days: number; readonly interest_direction: InterestDirection; readonly interest_cents: Cents;
  readonly upb_cents: Cents; readonly price: string; readonly gross_price_proceeds_cents: Cents; readonly llpa_items: readonly LlpaLine[]; readonly llpa_total_cents: Cents;
  readonly other_fees_cents: Cents; readonly net_proceeds_cents: Cents; readonly payee_code: string; readonly wire_nickname: string | null;
  readonly source: "purchase_advice_api_sellers" | "purchase_advice_api_servicers" | "connect_report" | "manual"; readonly raw_document_id: string; readonly received_at: string;
  readonly status: "received" | "matched" | "exception" | "adjusted" | "superseded"; readonly fnma_servicer_number: string;
}
export interface ProceedsReceiptRecord {
  readonly receipt_id: string; readonly bank_ref: string; readonly value_date: PlainDate; readonly amount_cents: Cents; readonly originator_name: string; readonly reference_text: string; readonly account_ref: string;
  readonly matched_advice_ids: readonly string[]; readonly status: "unmatched" | "matched" | "partial" | "returned" | "suspense" | "provisional"; readonly received_at: string;
}
export interface SettlementKeys extends AdvanceKeys { readonly funding_id: string; readonly delivery_id: string | null; readonly fnma_loan_number: string | null; readonly seller_loan_number: string; }
/** Guardrail: the agent may never accept an advice that fails the loan-number / seller-number key match. */
export function adviceKeysMatch(advice: Pick<PurchaseAdviceRecord, "fnma_loan_number" | "seller_loan_number">, keys: Pick<SettlementKeys, "fnma_loan_number" | "seller_loan_number">): boolean {
  if (advice.seller_loan_number !== keys.seller_loan_number) return false;
  return keys.fnma_loan_number === null || keys.fnma_loan_number === advice.fnma_loan_number;
}
export function assertAdviceKeys(advice: Pick<PurchaseAdviceRecord, "fnma_loan_number" | "seller_loan_number" | "purchase_advice_id">, keys: Pick<SettlementKeys, "fnma_loan_number" | "seller_loan_number">): void {
  if (!adviceKeysMatch(advice, keys)) throw new GuardrailViolation("ADVICE_KEY_MISMATCH", "27.2 guardrails: the agent may never accept an advice that fails the loan-number/seller-number key match", `advice ${advice.purchase_advice_id} (${advice.fnma_loan_number} / ${advice.seller_loan_number}) does not key to ${keys.fnma_loan_number ?? "(no Fannie Mae number yet)"} / ${keys.seller_loan_number}`);
}
/** Which convention the advice's interest line reproduces (± $1 rounding): A, B, or other. */
export function observedConvention(advice: Pick<PurchaseAdviceRecord, "interest_cents" | "interest_direction">, f: ProceedsForecast, tol: Cents = 100n): ObservedConvention {
  if (advice.interest_direction !== f.interest.direction) return "other";
  if (absCents(advice.interest_cents - f.interest.cents_a) <= tol) return "a_30_360";
  if (absCents(advice.interest_cents - f.interest.cents_b) <= tol) return "b_act_365";
  return "other";
}
export const adviceSignedInterest = (a: Pick<PurchaseAdviceRecord, "interest_cents" | "interest_direction">): Cents => (a.interest_direction === "due_fannie_mae" ? -a.interest_cents : a.interest_direction === "due_lender" ? a.interest_cents : 0n);
export interface VarianceBreakdown { readonly price_cents: Cents; readonly llpa_cents: Cents; readonly interest_cents: Cents; readonly fees_cents: Cents; readonly convention_cents: Cents; readonly unexplained_cents: Cents; }
export type MatchStatus = "matched" | "matched_with_variance" | "exception" | "ppa_requested" | "resolved" | "provisional";
export type ExceptionKind = "price" | "llpa" | "interest" | "fees" | "unexplained" | "convention_changed" | "wrong_account" | "missing_advice" | "duplicate_receipt";
export interface MatchEscalation { readonly kind: "officer" | "sev1" | "sev2" | "human_portal_task"; readonly role: string; readonly party: "sm" | "partner"; readonly severity: string; readonly reason: string; }
export interface MatchInput {
  readonly keys: SettlementKeys; readonly forecast: ProceedsForecast; readonly advice: PurchaseAdviceRecord; readonly received_cents: Cents; readonly receipt_account_ref: string;
  readonly partner_convention: PartnerConvention; readonly collection_account_ref: string; readonly expected_payee_code: string | null; readonly policy?: EconomicsPolicy;
}
export interface MatchResult {
  readonly status: MatchStatus; readonly expected_proceeds_cents: Cents; readonly advice_proceeds_cents: Cents; readonly received_cents: Cents; readonly variance_cents: Cents; readonly variance_breakdown: VarianceBreakdown;
  readonly interest_convention_observed: ObservedConvention; readonly convention_basis: InterestConvention; readonly convention_action: "lock" | "none" | "changed" | "unresolved"; readonly convention_after: PartnerConvention;
  readonly exception_kind: ExceptionKind | null; readonly tolerance_rule_applied: string; readonly funds_transfer_error: boolean; readonly escalations: readonly MatchEscalation[];
  readonly rule_set_versions: typeof ECONOMICS_RULE_SETS;
}
/** Explanation order: price, LLPA, interest (direction/days/convention), fees, unexplained (= received − advice net: the funds-transfer component). */
export function explainVariance(f: ProceedsForecast, advice: PurchaseAdviceRecord, receivedCents: Cents, basis: InterestConvention, observed: ObservedConvention): { variance_cents: Cents; breakdown: VarianceBreakdown } {
  const expected = expectedNet(f, basis);
  const variance_cents = receivedCents - expected;
  const price_cents = advice.gross_price_proceeds_cents - f.expected_gross_cents;
  const llpa_cents = -(advice.llpa_total_cents - f.expected_llpa_cents);
  const fees_cents = -(advice.other_fees_cents - f.expected_fees_cents);
  const interest_raw = adviceSignedInterest(advice) - forecastSignedInterest(f, basis);
  const convention_cents = observed !== "other" && observed !== basis ? forecastSignedInterest(f, observed) - forecastSignedInterest(f, basis) : 0n;
  const interest_cents = interest_raw - convention_cents;
  const unexplained_cents = variance_cents - (price_cents + llpa_cents + interest_cents + fees_cents + convention_cents);
  return { variance_cents, breakdown: { price_cents, llpa_cents, interest_cents, fees_cents, convention_cents, unexplained_cents } };
}
export function matchProceeds(i: MatchInput): MatchResult {
  const pol = i.policy ?? ECONOMICS_V1;
  assertAdviceKeys(i.advice, i.keys);
  const observed = observedConvention(i.advice, i.forecast);
  const basis: InterestConvention = i.partner_convention === "unresolved" ? "a_30_360" : i.partner_convention;
  const { variance_cents, breakdown } = explainVariance(i.forecast, i.advice, i.received_cents, basis, observed);
  const escalations: MatchEscalation[] = [];
  let convention_action: MatchResult["convention_action"] = "none", convention_after: PartnerConvention = i.partner_convention, exception_kind: ExceptionKind | null = null;
  if (i.partner_convention === "unresolved") { if (observed === "other") convention_action = "unresolved"; else { convention_action = "lock"; convention_after = observed; } }
  else if (observed !== "other" && observed !== i.partner_convention) { convention_action = "changed"; exception_kind = "convention_changed"; escalations.push({ kind: "officer", role: "officer", party: "sm", severity: "sev-2", reason: "convention_changed: advice matches the other interest convention after the partner lock (27.2-Q1) — both conventions kept" }); }
  let funds_transfer_error = false;
  if (i.receipt_account_ref !== i.collection_account_ref || (i.expected_payee_code !== null && i.advice.payee_code !== i.expected_payee_code)) {
    exception_kind = "wrong_account"; funds_transfer_error = true;
    escalations.push({ kind: "sev1", role: "officer", party: "sm", severity: "sev-1", reason: "proceeds wired to an account other than SM's collection account (payee-code error): C2-2-05 request the same day; bailee-letter enforcement; 27.1 collateral chain stays open" });
  }
  const abs = absCents(variance_cents);
  let status: MatchStatus, tolerance_rule_applied: string;
  if (exception_kind) { status = "exception"; tolerance_rule_applied = exception_kind; }
  else if (abs <= pol.rounding_tolerance_cents) { status = "matched"; tolerance_rule_applied = "rounding_le_100_cents"; }
  else if (abs <= pol.explained_tolerance_cents && absCents(breakdown.unexplained_cents) <= pol.rounding_tolerance_cents) { status = "matched_with_variance"; tolerance_rule_applied = "explained_le_10000_cents"; }
  else {
    status = "exception"; tolerance_rule_applied = "above_tolerance";
    const comps: [ExceptionKind, Cents][] = [["price", breakdown.price_cents], ["llpa", breakdown.llpa_cents], ["interest", breakdown.interest_cents], ["fees", breakdown.fees_cents], ["unexplained", breakdown.unexplained_cents]];
    exception_kind = absCents(breakdown.unexplained_cents) > pol.rounding_tolerance_cents ? "unexplained" : comps.sort((a, b) => (absCents(b[1]) > absCents(a[1]) ? 1 : -1))[0]![0];
    funds_transfer_error = exception_kind === "unexplained";
  }
  return { status, expected_proceeds_cents: expectedNet(i.forecast, basis), advice_proceeds_cents: i.advice.net_proceeds_cents, received_cents: i.received_cents, variance_cents, variance_breakdown: breakdown,
    interest_convention_observed: observed, convention_basis: basis, convention_action, convention_after, exception_kind, tolerance_rule_applied, funds_transfer_error, escalations, rule_set_versions: ECONOMICS_RULE_SETS };
}
/** One wire, many loans: split by the daily advice set; a residual difference ≤ $1.00 per loan is absorbed on the last loan, otherwise the remainder goes to suspense. */
export function splitReceipt(receiptCents: Cents, advices: readonly Pick<PurchaseAdviceRecord, "purchase_advice_id" | "net_proceeds_cents">[], tol: Cents = 100n): { allocations: { purchase_advice_id: string; cents: Cents }[]; suspense_cents: Cents } {
  const total = advices.reduce((s, a) => s + a.net_proceeds_cents, 0n);
  const diff = receiptCents - total;
  const allocations = advices.map((a) => ({ purchase_advice_id: a.purchase_advice_id, cents: a.net_proceeds_cents }));
  if (allocations.length && absCents(diff) <= tol * BigInt(allocations.length)) { allocations[allocations.length - 1]!.cents += diff; return { allocations, suspense_cents: 0n }; }
  return { allocations, suspense_cents: diff };
}
/** A receipt with no advice by 14:00 ET is provisionally matched to the loan whose forecast equals the amount within $100 (confirmed when the advice arrives). */
export function provisionalMatch(receivedCents: Cents, f: ProceedsForecast, partnerConvention: PartnerConvention, nowIso: string, policy: EconomicsPolicy = ECONOMICS_V1): { provisional: boolean; reason: string; variance_cents: Cents } {
  const basis: InterestConvention = partnerConvention === "unresolved" ? "a_30_360" : partnerConvention;
  const variance_cents = receivedCents - expectedNet(f, basis);
  const cutoff = Number(policy.advice_cutoff_et.slice(0, 2));
  if (etHour(nowIso) < cutoff) return { provisional: false, reason: `before the ${policy.advice_cutoff_et} ET advice cut-off: hold the receipt leg`, variance_cents };
  if (absCents(variance_cents) > policy.provisional_tolerance_cents) return { provisional: false, reason: "amount does not equal the forecast within $100", variance_cents };
  return { provisional: true, reason: "no advice by 14:00 ET; forecast equals the amount within $100", variance_cents };
}
/** No advice by the next business day after the receipt value date → `proceeds.exception{kind=missing_advice}` and the Connect-report fallback task. */
export function missingAdvice(valueDate: PlainDate, today: PlainDate): { missing: boolean; deadline: PlainDate } {
  const deadline = addBusinessDays(valueDate, 1, servicer);
  return { missing: today > deadline, deadline };
}

// ============================================================ rule 3: waterfall
export interface WaterfallInput {
  readonly received_cents: Cents; readonly payoff: PayoffStatement; readonly third_party_costs_actual_cents: Cents; readonly quote_third_party_costs_cents: Cents; readonly quote_sm_retained_cents: Cents;
  readonly value_date: PlainDate; readonly policy?: EconomicsPolicy;
}
export interface Waterfall {
  readonly received_cents: Cents; readonly value_date: PlainDate;
  readonly advance_principal_cents: Cents; readonly capitalized_interest_cents: Cents; readonly accrued_interest_cents: Cents; readonly warehouse_fees_cents: Cents; readonly payoff_total_cents: Cents;
  readonly warehouse_paid_cents: Cents; readonly paid_principal_cents: Cents; readonly paid_capitalized_cents: Cents; readonly paid_accrued_cents: Cents; readonly paid_fees_cents: Cents; readonly shortfall_cents: Cents;
  readonly sm_cost_recovery_cap_cents: Cents; readonly sm_cost_recovery_due_cents: Cents; readonly sm_cost_excess_borne_by_sm_cents: Cents; readonly sm_cost_recovery_cents: Cents; readonly sm_cost_recovery_receivable_cents: Cents;
  readonly sm_retained_residual_cents: Cents; readonly sm_retained_receivable_cents: Cents; readonly partner_residual_cents: Cents; readonly partner_wire_required: boolean; readonly partner_wire_value_date: PlainDate | null;
  readonly shortfall_draft_due_on: PlainDate | null; readonly partner_receivable_cents: Cents; readonly warehouse_repaid_in_full: boolean;
}
/** `cap = round(quote × 110%)`; recovery = min(actual invoices, cap); the excess above the cap is SM's (27.2-Q2). */
export function costRecoveryDue(actualCents: Cents, quoteCents: Cents, policy: EconomicsPolicy = ECONOMICS_V1): { cap_cents: Cents; due_cents: Cents; excess_sm_cents: Cents } {
  const cap_cents = mul(quoteCents, Decimal.ratio(BigInt(policy.cost_recovery_cap_pct), 100n));
  const due_cents = cmp(actualCents, cap_cents);
  return { cap_cents, due_cents, excess_sm_cents: actualCents - due_cents };
}
/**
 * received → (1) advance principal incl. capitalized interest → (2) accrued interest through the day before the value
 * date (27.1 cumulative method) → (3) warehouse fees → (4) SM cost recovery (invoices, capped) → (5) SM retained residual
 * (20.4-Q1) → (6) partner residual (wired next federal business day under dual control). received < (1)+(2)+(3): the
 * shortfall is drafted from the partner within 2 business days and (4)–(5) become receivables.
 */
export function settlementWaterfall(i: WaterfallInput): Waterfall {
  if (i.received_cents < 0n) throw new RangeError("received_cents must be ≥ 0");
  const pol = i.policy ?? ECONOMICS_V1; const p = i.payoff;
  let remaining = i.received_cents;
  const take = (due: Cents): Cents => { const t = cmp(remaining, due < 0n ? 0n : due); remaining -= t; return t; };
  const paid_principal_cents = take(p.outstanding_principal_cents), paid_capitalized_cents = take(p.capitalized_interest_cents), paid_accrued_cents = take(p.accrued_not_capitalized_cents), paid_fees_cents = take(p.fees_cents);
  const warehouse_paid_cents = paid_principal_cents + paid_capitalized_cents + paid_accrued_cents + paid_fees_cents;
  const shortfall_cents = p.total_cents - warehouse_paid_cents;
  const cost = costRecoveryDue(i.third_party_costs_actual_cents, i.quote_third_party_costs_cents, pol);
  const sm_cost_recovery_cents = take(cost.due_cents); const sm_retained_residual_cents = take(i.quote_sm_retained_cents);
  const partner_residual_cents = remaining;
  const sm_cost_recovery_receivable_cents = cost.due_cents - sm_cost_recovery_cents, sm_retained_receivable_cents = i.quote_sm_retained_cents - sm_retained_residual_cents;
  return { received_cents: i.received_cents, value_date: i.value_date, advance_principal_cents: p.outstanding_principal_cents, capitalized_interest_cents: p.capitalized_interest_cents, accrued_interest_cents: p.accrued_not_capitalized_cents, warehouse_fees_cents: p.fees_cents, payoff_total_cents: p.total_cents,
    warehouse_paid_cents, paid_principal_cents, paid_capitalized_cents, paid_accrued_cents, paid_fees_cents, shortfall_cents, sm_cost_recovery_cap_cents: cost.cap_cents, sm_cost_recovery_due_cents: cost.due_cents, sm_cost_excess_borne_by_sm_cents: cost.excess_sm_cents,
    sm_cost_recovery_cents, sm_cost_recovery_receivable_cents, sm_retained_residual_cents, sm_retained_receivable_cents, partner_residual_cents, partner_wire_required: partner_residual_cents > 0n, partner_wire_value_date: partner_residual_cents > 0n ? addBusinessDays(i.value_date, 1, federal) : null,
    shortfall_draft_due_on: shortfall_cents > 0n ? addBusinessDays(i.value_date, 2, servicer) : null, partner_receivable_cents: shortfall_cents + sm_cost_recovery_receivable_cents + sm_retained_receivable_cents, warehouse_repaid_in_full: shortfall_cents === 0n };
}

// ============================================================ rule 4: releases
export interface ReleasePlan { readonly note_form: NoteForm; readonly bailee_letter_release_due_on: PlainDate | null; readonly interim_funder_removal_due_on: PlainDate | null; readonly secured_party_release: "funding_agreement_on_payment" | "not_applicable"; readonly collateral_chain: "closed" | "open_pending_interim_funder"; readonly c2_2_03_satisfied: true; }
/** Paper: bailee letter released the same servicer business day, Interim Funder Org ID removal within 2; eNote: the registry already removed SM at Transfer of Control and the Funding Agreement releases SM's interest on payment — the chain closes. */
export function releasePlan(noteForm: NoteForm, repaidOn: PlainDate): ReleasePlan {
  if (noteForm === "paper") return { note_form: noteForm, bailee_letter_release_due_on: rollForward(repaidOn, servicer), interim_funder_removal_due_on: addBusinessDays(repaidOn, 2, servicer), secured_party_release: "not_applicable", collateral_chain: "open_pending_interim_funder", c2_2_03_satisfied: true };
  return { note_form: noteForm, bailee_letter_release_due_on: null, interim_funder_removal_due_on: null, secured_party_release: "funding_agreement_on_payment", collateral_chain: "closed", c2_2_03_satisfied: true };
}

// ============================================================ rules 5–7: gain on sale, pass-through reconciliation, recapture exposure
export interface QuoteEconomics { readonly quote_id: string; readonly price: string; readonly llpa_total_pct: string; readonly third_party_costs_cents: Cents; readonly lender_credit_cents: Cents; readonly sm_retained_cents: Cents; readonly matrix_version: string; readonly solve_trace_document_id: string; readonly quoted_note_rate: string; }
export interface GosInput {
  readonly upb_cents: Cents; readonly quote: QuoteEconomics; readonly advice: Pick<PurchaseAdviceRecord, "purchase_advice_id" | "price" | "llpa_total_cents" | "other_fees_cents" | "interest_cents" | "interest_direction" | "purchase_date">;
  readonly prepaid_interest_collected_cents: Cents; readonly cd_lender_credit_cents: Cents; readonly note_rate: string; readonly third_party_costs_actual_cents: Cents;
  readonly warehouse_interest_cents: Cents; readonly warehouse_fees_cents: Cents; readonly sm_cost_recovery_cents: Cents; readonly sm_retained_residual_cents: Cents; readonly policy?: EconomicsPolicy;
}
export interface GosExpected { readonly price: string; readonly quoted_note_rate: string; readonly llpa_total_pct: string; readonly llpa_cents: Cents; readonly gross_premium_cents: Cents; readonly net_premium_cents: Cents; readonly third_party_costs_cents: Cents; readonly lender_credit_cents: Cents; readonly sm_retained_cents: Cents; readonly matrix_version: string; readonly by_construction: boolean; }
export interface GosActual {
  readonly price: string; readonly gross_premium_cents: Cents; readonly llpa_cents: Cents; readonly net_premium_cents: Cents; readonly interest_adjustment_cents: Cents; readonly fees_cents: Cents; readonly prepaid_interest_collected_cents: Cents; readonly interest_carry_cents: Cents;
  readonly lender_credit_cents: Cents; readonly third_party_costs_actual_cents: Cents; readonly warehouse_interest_cents: Cents; readonly warehouse_fees_cents: Cents; readonly warehouse_carry_cents: Cents; readonly sm_cost_recovery_cents: Cents; readonly sm_retained_residual_cents: Cents; readonly partner_origination_result_cents: Cents;
}
export interface GainOnSale {
  readonly expected: GosExpected; readonly actual: GosActual;
  readonly variance: { readonly price_cents: Cents; readonly llpa_cents: Cents; readonly costs_cents: Cents; readonly interest_items_cents: Cents; readonly warehouse_carry_cents: Cents; readonly sm_retained_cents: Cents; readonly lender_credit_cents: Cents };
  readonly gaap_view: { readonly net_proceeds_cents: Cents; readonly carrying_amount_cents: Cents; readonly gain_on_sale_cents: Cents; readonly interest_expense_cents: Cents; readonly deferral_policy: "partner_accountants_asc_310_20" };
  readonly recapture_exposure_cents: Cents; readonly recapture_exposure_until: PlainDate; readonly rule_set_versions: typeof ECONOMICS_RULE_SETS;
}
/** `gross_premium = round((price − 100)/100 × UPB)` (101.375 on $560,000 = $7,700.00; 100.875 = $4,900.00; 99.000 = −$5,600.00). */
export const grossPremium = (price: string, upbCents: Cents): Cents => roundCents(Decimal.fromBigInt(upbCents).mul(Decimal.parse(price).sub(Decimal.fromInt(100))).div(Decimal.fromInt(100)));
/** `recapture_exposure = gross_premium` until purchase_date + 120 calendar days (C1-1-01; Fannie Mae may reduce it by LLPAs less 50 bps at its discretion). */
export function recaptureExposure(grossPremiumCents: Cents, purchaseDate: PlainDate, policy: EconomicsPolicy = ECONOMICS_V1): { cents: Cents; until: PlainDate } {
  return { cents: grossPremiumCents > 0n ? grossPremiumCents : 0n, until: addDays(purchaseDate, policy.recapture_window_days) };
}
/**
 * Program view (rule 5): partner origination result = net_premium − lender_credit − sm_cost_recovery − sm_retained −
 * warehouse_interest − warehouse_fees + interest_carry, interest_carry = prepaid interest collected + Fannie Mae's
 * (signed) interest adjustment. GAAP view (data only): net proceeds − carrying amount, warehouse interest as expense.
 */
export function computeGainOnSale(i: GosInput): GainOnSale {
  const pol = i.policy ?? ECONOMICS_V1;
  const q = i.quote;
  const exp_gross = grossPremium(q.price, i.upb_cents), exp_llpa = mul(i.upb_cents, pctToRatio(q.llpa_total_pct)), exp_net = exp_gross - exp_llpa;
  const expected: GosExpected = { price: q.price, quoted_note_rate: q.quoted_note_rate, llpa_total_pct: q.llpa_total_pct, llpa_cents: exp_llpa, gross_premium_cents: exp_gross, net_premium_cents: exp_net, third_party_costs_cents: q.third_party_costs_cents, lender_credit_cents: q.lender_credit_cents, sm_retained_cents: q.sm_retained_cents, matrix_version: q.matrix_version,
    by_construction: exp_net === q.third_party_costs_cents + q.lender_credit_cents + q.sm_retained_cents };
  const act_gross = grossPremium(i.advice.price, i.upb_cents), act_net = act_gross - i.advice.llpa_total_cents;
  const fnma_interest = adviceSignedInterest(i.advice);
  const interest_carry = i.prepaid_interest_collected_cents + fnma_interest;
  const warehouse_carry = i.warehouse_interest_cents + i.warehouse_fees_cents;
  const result = act_net - i.cd_lender_credit_cents - i.sm_cost_recovery_cents - i.sm_retained_residual_cents - warehouse_carry + interest_carry;
  const actual: GosActual = { price: i.advice.price, gross_premium_cents: act_gross, llpa_cents: i.advice.llpa_total_cents, net_premium_cents: act_net, interest_adjustment_cents: fnma_interest, fees_cents: i.advice.other_fees_cents, prepaid_interest_collected_cents: i.prepaid_interest_collected_cents, interest_carry_cents: interest_carry,
    lender_credit_cents: i.cd_lender_credit_cents, third_party_costs_actual_cents: i.third_party_costs_actual_cents, warehouse_interest_cents: i.warehouse_interest_cents, warehouse_fees_cents: i.warehouse_fees_cents, warehouse_carry_cents: warehouse_carry, sm_cost_recovery_cents: i.sm_cost_recovery_cents, sm_retained_residual_cents: i.sm_retained_residual_cents, partner_origination_result_cents: result };
  const net_proceeds = act_gross + i.upb_cents - i.advice.llpa_total_cents + fnma_interest - i.advice.other_fees_cents;
  const rec = recaptureExposure(act_gross, i.advice.purchase_date, pol);
  return { expected, actual,
    variance: { price_cents: act_gross - exp_gross, llpa_cents: i.advice.llpa_total_cents - exp_llpa, costs_cents: i.third_party_costs_actual_cents - q.third_party_costs_cents, interest_items_cents: interest_carry, warehouse_carry_cents: warehouse_carry, sm_retained_cents: i.sm_retained_residual_cents - q.sm_retained_cents, lender_credit_cents: i.cd_lender_credit_cents - q.lender_credit_cents },
    gaap_view: { net_proceeds_cents: net_proceeds, carrying_amount_cents: i.upb_cents, gain_on_sale_cents: net_proceeds - i.upb_cents, interest_expense_cents: warehouse_carry, deferral_policy: "partner_accountants_asc_310_20" },
    recapture_exposure_cents: rec.cents, recapture_exposure_until: rec.until, rule_set_versions: ECONOMICS_RULE_SETS };
}
export interface PassthroughEvidence { readonly quote_solve_trace_document_id: string; readonly lock_confirmation_document_id: string; readonly final_cd_document_id: string; readonly note_document_id: string; readonly purchase_advice_document_id: string; readonly invoice_document_ids: readonly string[]; }
export interface PassthroughRecon {
  readonly quoted_note_rate: string; readonly note_rate: string; readonly cd_lender_credit_cents: Cents; readonly expected_net_premium_cents: Cents; readonly actual_net_premium_cents: Cents; readonly costs_forecast_cents: Cents; readonly costs_recovered_cents: Cents; readonly sm_retained_cents: Cents;
  readonly surplus_cents: Cents; readonly surplus_disposition: EconomicsPolicy["surplus_disposition"]; readonly borrower_post_closing_adjustment_cents: 0n; readonly evidence_document_ids: readonly string[];
  readonly variance_lines: { readonly a_price_cents: Cents; readonly b_llpa_cents: Cents; readonly c_costs_cents: Cents; readonly d_interest_items_cents: Cents; readonly e_warehouse_carry_cents: Cents };
  readonly status: "reconciled" | "variance_explained" | "exception"; readonly flags: readonly string[]; readonly borrower_benefit_fixed_at_closing: true;
}
/** Rule 6: the term-sheet proof — expected (lock) vs actual (advice + invoices); the borrower's benefit is fixed at closing; post-closing variances settle between SM and the partner per sm.economics.v1. */
export function reconcilePassthrough(g: GainOnSale, i: { note_rate: string; cd_lender_credit_cents: Cents; evidence: PassthroughEvidence; policy?: EconomicsPolicy }): PassthroughRecon {
  const pol = i.policy ?? ECONOMICS_V1;
  const surplus_cents = g.actual.net_premium_cents - g.expected.net_premium_cents;
  const flags: string[] = [];
  const rateMatches = i.note_rate === g.expected.quoted_note_rate;
  const creditMatches = i.cd_lender_credit_cents === g.expected.lender_credit_cents;
  if (!rateMatches) flags.push("note_rate_differs_from_quote");
  if (!creditMatches) flags.push("cd_lender_credit_differs_from_quote");
  if (g.actual.net_premium_cents < g.expected.third_party_costs_cents) flags.push("not_priceable_should_have_returned_at_lock");
  if (!g.expected.by_construction) flags.push("quote_solve_identity_broken");
  const explained = surplus_cents === g.variance.price_cents - g.variance.llpa_cents;
  const status: PassthroughRecon["status"] = flags.length ? "exception" : surplus_cents === 0n && g.variance.costs_cents === 0n ? "reconciled" : explained ? "variance_explained" : "exception";
  return { quoted_note_rate: g.expected.quoted_note_rate, note_rate: i.note_rate, cd_lender_credit_cents: i.cd_lender_credit_cents, expected_net_premium_cents: g.expected.net_premium_cents, actual_net_premium_cents: g.actual.net_premium_cents, costs_forecast_cents: g.expected.third_party_costs_cents, costs_recovered_cents: g.actual.sm_cost_recovery_cents, sm_retained_cents: g.actual.sm_retained_residual_cents,
    surplus_cents, surplus_disposition: pol.surplus_disposition, borrower_post_closing_adjustment_cents: 0n,
    evidence_document_ids: [i.evidence.quote_solve_trace_document_id, i.evidence.lock_confirmation_document_id, i.evidence.final_cd_document_id, i.evidence.note_document_id, i.evidence.purchase_advice_document_id, ...i.evidence.invoice_document_ids],
    variance_lines: { a_price_cents: g.variance.price_cents, b_llpa_cents: g.variance.llpa_cents, c_costs_cents: g.variance.costs_cents, d_interest_items_cents: g.variance.interest_items_cents, e_warehouse_carry_cents: g.variance.warehouse_carry_cents }, status, flags, borrower_benefit_fixed_at_closing: true };
}
/** Rule 7: Fannie Mae's recapture (payoff within 120 days) is the partner's as seller; SM's cost recovery is not clawed back (27.2-Q4). */
export function assessPremiumRecapture(g: Pick<GainOnSale, "recapture_exposure_cents" | "recapture_exposure_until"> & { readonly actual: Pick<GosActual, "sm_cost_recovery_cents"> }, r: { payoff_date: PlainDate; assessed_cents: Cents; purchase_date: PlainDate }): { within_window: boolean; assessed_cents: Cents; allocation: "partner"; sm_cost_recovery_cents_after: Cents; recapture_exposure_cents_after: 0n; days_after_purchase: number } {
  if (r.assessed_cents < 0n) throw new RangeError("assessed_cents must be ≥ 0");
  return { within_window: r.payoff_date <= g.recapture_exposure_until, assessed_cents: r.assessed_cents, allocation: "partner", sm_cost_recovery_cents_after: g.actual.sm_cost_recovery_cents, recapture_exposure_cents_after: 0n, days_after_purchase: daysBetween(r.purchase_date, r.payoff_date) };
}

// ============================================================ rule 8: MSR hand-off (data, never a valuation)
export const MSR_PAYLOAD_FIELDS = ["fnma_loan_number", "seller_loan_number", "upb_at_purchase_cents", "note_rate", "pass_through_rate", "servicing_fee_bps", "remittance_type", "purchase_date", "first_payment_date", "lpi_date", "term_months", "amortization_type", "product_code", "pi_cents", "escrow_indicator", "mi_flag", "occupancy", "property_state", "sfc_codes", "platform_fee_bps"] as const;
export interface MsrPayload {
  readonly fnma_loan_number: string; readonly seller_loan_number: string; readonly upb_at_purchase_cents: Cents; readonly note_rate: string; readonly pass_through_rate: string; readonly servicing_fee_bps: number; readonly remittance_type: RemittanceType;
  readonly purchase_date: PlainDate; readonly first_payment_date: PlainDate; readonly lpi_date: PlainDate; readonly term_months: number; readonly amortization_type: string; readonly product_code: string; readonly pi_cents: Cents; readonly escrow_indicator: boolean; readonly mi_flag: boolean; readonly occupancy: string; readonly property_state: string; readonly sfc_codes: readonly string[]; readonly platform_fee_bps: number;
}
export const MSR_SCHEMA_VERSION = "msr-handoff.v1";
/** Exactly the rule-8 fields (a superset input is trimmed; no valuation field ever): the fixed 25 bps servicing fee and the 12.5 bps platform fee come from policy. */
export function msrHandoffPayload(i: Omit<MsrPayload, "servicing_fee_bps" | "platform_fee_bps"> & Record<string, unknown>, policy: EconomicsPolicy = ECONOMICS_V1): MsrPayload {
  if (!i.fnma_loan_number) throw new RangeError("fnma_loan_number is required (from the purchase advice)");
  const out: Record<string, unknown> = {};
  for (const k of MSR_PAYLOAD_FIELDS) out[k] = i[k];
  out.servicing_fee_bps = policy.servicing_fee_bps; out.platform_fee_bps = Number(policy.platform_fee_bps);
  return out as unknown as MsrPayload;
}
/** Standard level P&I: `UPB × r × (1+r)^n / ((1+r)^n − 1)`, r = note rate / 12 ($560,000 at 6.125%/360 = $3,402.62). */
export function scheduledPi(upbCents: Cents, noteRate: string, termMonths: number): Cents {
  const r = Decimal.parse(noteRate).div(Decimal.fromInt(12)); const f = Decimal.ONE.add(r).pow(termMonths);
  return roundCents(Decimal.fromBigInt(upbCents).mul(r).mul(f).div(f.sub(Decimal.ONE)));
}
/** UPB after one scheduled payment: `UPB − (P&I − round(UPB × rate / 12))` ($560,000 → $559,455.71 after Jan 1, 2027). */
export function upbAfterPayment(upbCents: Cents, noteRate: string, piCents: Cents): { interest_cents: Cents; principal_cents: Cents; upb_after_cents: Cents } {
  const interest_cents = roundCents(Decimal.fromBigInt(upbCents).mul(Decimal.parse(noteRate)).div(Decimal.fromInt(12)));
  const principal_cents = piCents - interest_cents;
  return { interest_cents, principal_cents, upb_after_cents: upbCents - principal_cents };
}

// ============================================================ rule 9: platform fee (12.5 bps/yr on UPB)
export type FeeBasisRule = "prorated_first_period" | "full_month" | "prorated_last_period";
export interface PlatformFeeAccrual { readonly period: string; readonly upb_basis_cents: Cents; readonly days_in_period: number; readonly days_accrued: number; readonly fee_cents: Cents; readonly basis_rule: FeeBasisRule; readonly monthly_fee_cents: Cents; }
const feeRatio = (policy: EconomicsPolicy): Decimal => Decimal.parse(policy.platform_fee_bps).div(Decimal.fromInt(10_000)).div(Decimal.fromInt(12));
/** `monthly_fee = round_half_up(UPB × 0.00125 / 12)` ($560,000 → $58.33; $559,455.71 → $58.28). */
export const monthlyPlatformFee = (upbCents: Cents, policy: EconomicsPolicy = ECONOMICS_V1): Cents => roundCents(Decimal.fromBigInt(upbCents).mul(feeRatio(policy)));
export const periodOf = (d: PlainDate): string => d.slice(0, 7);
/** First period prorated by days from the purchase date to month-end (inclusive) / days in month; last period to the payoff/transfer date; otherwise the full month on the UPB as of the 1st. */
export function platformFeeAccrual(i: { upb_basis_cents: Cents; period: string; purchase_date: PlainDate; payoff_date?: PlainDate | null; policy?: EconomicsPolicy }): PlatformFeeAccrual {
  if (!/^\d{4}-\d{2}$/.test(i.period)) throw new RangeError(`period ${i.period} is not YYYY-MM`);
  const pol = i.policy ?? ECONOMICS_V1; const y = Number(i.period.slice(0, 4)), m = Number(i.period.slice(5, 7));
  const first = ymd(y, m, 1), last = endOfMonth(first), days_in_period = daysInMonth(y, m);
  if (i.purchase_date > last) throw new RangeError(`no platform fee for ${i.period}: accrual begins at the Fannie Mae purchase date ${i.purchase_date} (27.2-Q3)`);
  const from = i.purchase_date > first ? i.purchase_date : first; const to = i.payoff_date && i.payoff_date < last ? i.payoff_date : last;
  const days_accrued = daysBetween(from, to) + 1;
  const basis_rule: FeeBasisRule = from !== first ? "prorated_first_period" : to !== last ? "prorated_last_period" : "full_month";
  const monthly_fee_cents = monthlyPlatformFee(i.upb_basis_cents, pol);
  const fee_cents = basis_rule === "full_month" ? monthly_fee_cents : roundCents(Decimal.fromBigInt(i.upb_basis_cents).mul(feeRatio(pol)).mul(Decimal.fromInt(days_accrued)).div(Decimal.fromInt(days_in_period)));
  return { period: i.period, upb_basis_cents: i.upb_basis_cents, days_in_period, days_accrued, fee_cents, basis_rule, monthly_fee_cents };
}

// ============================================================ rule 11: post-purchase adjustments
export type PpaKind = "funds_transfer_error" | "data_correction";
export type PpaChannel = "email_acquisitions_loan_delivery" | "lsdu";
export interface PpaRequest {
  readonly ppa_id: string; readonly loan_id: string; readonly purchase_advice_id: string; readonly kind: PpaKind; readonly channel: PpaChannel; readonly requested_at: string | null; readonly due_at: PlainDate; readonly platform_target_on: PlainDate;
  readonly amount_cents: Cents; readonly attributes: Readonly<Record<string, unknown>>; readonly fnma_reference: string | null; readonly status: "draft" | "submitted" | "accepted" | "rejected" | "settled" | "below_threshold";
  readonly resolution_cents: Cents | null; readonly resolved_at: string | null; readonly filed_by_role: "fnma_portal_operator" | "officer"; readonly party: "partner"; readonly seller_number: string; readonly fnma_loan_number: string; readonly requires_human_submission: boolean;
}
/** Funds-transfer errors → e-mail to acquisitions_loan_delivery@fanniemae.com within 30 days of the advice date; LLPA data corrections → LSDU by `fnma_portal_operator{party=partner}` within 29.4's 18-month lookback; $100 minimum on LLPA PPAs. */
export function preparePpa(i: { ppa_id: string; loan_id: string; purchase_advice_id: string; kind: PpaKind; advice_date: PlainDate; purchase_date: PlainDate; amount_cents: Cents; attributes?: Record<string, unknown>; seller_number: string; fnma_loan_number: string; policy?: EconomicsPolicy }): PpaRequest {
  const pol = i.policy ?? ECONOMICS_V1;
  const channel: PpaChannel = i.kind === "funds_transfer_error" ? "email_acquisitions_loan_delivery" : "lsdu";
  const due_at = i.kind === "funds_transfer_error" ? addDays(i.advice_date, pol.ppa_funds_transfer_window_days) : addMonths(i.purchase_date, pol.ppa_llpa_lookback_months);
  const below = i.kind === "data_correction" && absCents(i.amount_cents) < pol.ppa_llpa_min_cents;
  return { ppa_id: i.ppa_id, loan_id: i.loan_id, purchase_advice_id: i.purchase_advice_id, kind: i.kind, channel, requested_at: null, due_at, platform_target_on: rollBack(due_at, federal), amount_cents: i.amount_cents, attributes: i.attributes ?? {}, fnma_reference: null,
    status: below ? "below_threshold" : "draft", resolution_cents: null, resolved_at: null, filed_by_role: channel === "lsdu" ? "fnma_portal_operator" : "officer", party: "partner", seller_number: i.seller_number, fnma_loan_number: i.fnma_loan_number, requires_human_submission: channel === "lsdu" };
}
/** Guardrail: a PPA is never submitted by the agent under the partner's credentials — LSDU filings are a human `fnma_portal_operator{party=partner}` act. */
export function assertPpaSubmitter(p: Pick<PpaRequest, "channel" | "status">, by: Actor): void {
  if (p.status === "below_threshold") throw new RangeError("LLPA PPA below the $100 minimum threshold is not filed");
  if (p.channel === "lsdu" && (by.kind !== "human" || by.role !== "fnma_portal_operator")) throw new GuardrailViolation("PPA_NOT_UNDER_PARTNER_CREDENTIALS", "27.2 guardrails: the agent may never submit a PPA under the partner's credentials (human fnma_portal_operator{party=partner})", `LSDU submission by ${by.kind}:${by.id}`);
}

// ============================================================ rule 10: GL export
export const SETTLEMENT_ACCOUNTS = {
  proceeds_receivable: "purchase_proceeds_receivable", proceeds_suspense: "purchase_proceeds_suspense", collection_cash: WH_ACCOUNTS.collection_cash, cost_recovery_receivable: "sm_cost_recovery_receivable", cost_recovery_income: "sm_cost_recovery_income", third_party_costs: "third_party_costs",
  program_margin: "sm_program_margin", partner_payable: "partner_settlement_payable", shortfall_receivable: "partner_shortfall_receivable", platform_fee_receivable: "platform_fee_receivable", platform_fee_income: "platform_fee_income", haircut_reserve: WH_ACCOUNTS.haircut_reserve,
  // partner GL mirror
  gain_on_sale: "gain_on_sale", loans_held_for_sale: "loans_held_for_sale", warehouse_payable: WH_ACCOUNTS.partner_payable, warehouse_interest_expense: WH_ACCOUNTS.partner_interest_expense, cost_recovery_expense: "cost_recovery_expense", partner_residual_receivable: "partner_residual_receivable", recapture_payable: "premium_recapture_payable",
  borrower_rate_passthrough: "borrower_rate_passthrough", premium_recapture_contingency: "premium_recapture_contingency", partner_contribution: WH_ACCOUNTS.partner_contribution,
} as const;
export const PARTNER_MIRROR_ACCOUNTS: ReadonlySet<string> = new Set([SETTLEMENT_ACCOUNTS.gain_on_sale, SETTLEMENT_ACCOUNTS.loans_held_for_sale, SETTLEMENT_ACCOUNTS.warehouse_payable, SETTLEMENT_ACCOUNTS.warehouse_interest_expense, SETTLEMENT_ACCOUNTS.cost_recovery_expense, SETTLEMENT_ACCOUNTS.partner_residual_receivable, SETTLEMENT_ACCOUNTS.recapture_payable, SETTLEMENT_ACCOUNTS.borrower_rate_passthrough, SETTLEMENT_ACCOUNTS.premium_recapture_contingency, SETTLEMENT_ACCOUNTS.partner_contribution]);
export type GlTarget = "sm_gl" | "partner_gl";
export interface GlLine { readonly ledger_entry_id: string; readonly entry_set_id: string; readonly account_code: string; readonly debit_cents: Cents; readonly credit_cents: Cents; readonly loan_id: string | null; readonly loan_event_id: string | null; readonly memo: string; readonly effective_date: PlainDate; }
export interface GlBatch { readonly batch_id: string; readonly target: GlTarget; readonly period_date: PlainDate; readonly lines: readonly GlLine[]; readonly line_count: number; readonly control_totals: { readonly debit_cents: Cents; readonly credit_cents: Cents; readonly balanced: boolean; readonly entry_sets: number }; readonly hash: string; readonly format: "json"; readonly exported_at: string; readonly acknowledged_at: string | null; readonly status: "exported" | "acknowledged" | "empty"; }
/** An entry set belongs to the partner mirror when any of its lines hits a mirror account (sets are authored whole per target, so each batch balances). */
export const glTargetOf = (set: EntrySet): GlTarget => (set.lines.some((l) => PARTNER_MIRROR_ACCOUNTS.has(l.account.account)) ? "partner_gl" : "sm_gl");
export const glBatchId = (target: GlTarget, periodDate: PlainDate): string => `gl-${target}-${periodDate}`;
/** Every balanced entry set created on `period_date` (postedAt, ET) exported once — idempotent by ledger entry id; a re-run yields the same batch ids and no duplicate lines. */
export function buildGlBatches(sets: readonly EntrySet[], periodDate: PlainDate, alreadyExported: ReadonlySet<string>, exportedAt: string): { sm_gl: GlBatch; partner_gl: GlBatch; exported_line_ids: string[] } {
  const today = sets.filter((s) => etDate(s.postedAt) === periodDate);
  const build = (target: GlTarget): GlBatch => {
    const lines: GlLine[] = [];
    for (const s of today) { if (glTargetOf(s) !== target) continue; for (const l of s.lines) { if (alreadyExported.has(l.id)) continue; lines.push({ ledger_entry_id: l.id, entry_set_id: s.id, account_code: l.account.account, debit_cents: l.amountCents > 0n ? l.amountCents : 0n, credit_cents: l.amountCents < 0n ? -l.amountCents : 0n, loan_id: l.account.scope === "loan" ? l.account.loanId : null, loan_event_id: s.sourceEventId ?? null, memo: l.memo ?? s.description, effective_date: s.effectiveDate }); } }
    const debit_cents = lines.reduce((t, l) => t + l.debit_cents, 0n), credit_cents = lines.reduce((t, l) => t + l.credit_cents, 0n);
    const hash = createHash("sha256").update(JSON.stringify(lines.map((l) => [l.ledger_entry_id, l.account_code, String(l.debit_cents), String(l.credit_cents)]))).digest("hex");
    return { batch_id: glBatchId(target, periodDate), target, period_date: periodDate, lines, line_count: lines.length, control_totals: { debit_cents, credit_cents, balanced: debit_cents === credit_cents, entry_sets: new Set(lines.map((l) => l.entry_set_id)).size }, hash, format: "json", exported_at: exportedAt, acknowledged_at: null, status: lines.length ? "exported" : "empty" };
  };
  const sm_gl = build("sm_gl"), partner_gl = build("partner_gl");
  return { sm_gl, partner_gl, exported_line_ids: [...sm_gl.lines, ...partner_gl.lines].map((l) => l.ledger_entry_id) };
}

// ============================================================ ledger sets (SM books; partner mirror)
// 27.2 keeps per-loan settlement sub-ledgers under the corporate account names (proceeds, receivables, the partner GL mirror) — the loan-scope union is the servicing chart, so the cast stays here.
const loanAcct = (loanId: string, account: string): AccountRef => ({ scope: "loan", loanId, account: account as LoanAccount });
const corpAcct = (account: CorporateAccount): AccountRef => ({ scope: "corporate", account });
const custodialAcct = (custodialAccountId: string, account: CustodialAccount): AccountRef => ({ scope: "custodial", custodialAccountId, account });
const line = (account: AccountRef, amountCents: Cents, ruleRef: string, memo?: string): LineInput => ({ account, amountCents, ruleRef, ...(memo ? { memo } : {}) });
/** Drop zero lines; a set with fewer than two lines is not postable (the caller skips it). */
export const compact = (s: EntrySetInput): EntrySetInput | null => { const lines = s.lines.filter((l) => l.amountCents !== 0n); return lines.length >= 2 ? { ...s, lines } : null; };
/** Forecast at delivery: Dr purchase_proceeds_receivable{loan} / Cr partner_settlement_payable{loan} (SM collects the partner's proceeds under the bailee letter). */
export const forecastLedgerSet = (loanId: string, on: PlainDate, expectedCents: Cents): EntrySetInput => ({ effectiveDate: on, description: `purchase proceeds forecast ${loanId}`, lines: [line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.proceeds_receivable), expectedCents, "27.2:forecast:receivable", "expected net proceeds at delivery (rule 1)"), line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.partner_payable), -expectedCents, "27.2:forecast:partner_payable")] });
/** Receipt: Dr sm_collection_cash / Cr purchase_proceeds_receivable{loan}; the explained difference to the partner's settlement payable; any unexplained difference to purchase_proceeds_suspense until explained. */
export function receiptLedgerSet(loanId: string, r: { value_date: PlainDate; received_cents: Cents; expected_cents: Cents; unexplained_cents: Cents; collection_account_ref: string; receipt_id: string }): EntrySetInput {
  const explained = r.received_cents - r.expected_cents - r.unexplained_cents;
  return { effectiveDate: r.value_date, description: `purchase proceeds receipt ${r.receipt_id}`, lines: [
    line(custodialAcct(r.collection_account_ref, SETTLEMENT_ACCOUNTS.collection_cash), r.received_cents, "27.2:receipt:cash", "bank credit, Fannie Mae"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.proceeds_receivable), -r.expected_cents, "27.2:receipt:receivable", "clears the delivery forecast"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.partner_payable), -explained, "27.2:receipt:explained_variance", "price/LLPA/interest/fees variance to the partner (seller risk — 27.2-Q2)"),
    line(corpAcct(SETTLEMENT_ACCOUNTS.proceeds_suspense), -r.unexplained_cents, "27.2:receipt:suspense", "unexplained until explained / PPA")] };
}
/** SM cost recovery receivable for the actual third-party invoices (previously Dr against third_party_costs). */
export const costRecoveryReceivableSet = (loanId: string, on: PlainDate, cents: Cents): EntrySetInput => ({ effectiveDate: on, description: `SM cost recovery receivable ${loanId}`, lines: [line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.cost_recovery_receivable), cents, "27.2:costs:receivable", "actual third-party invoices"), line(corpAcct(SETTLEMENT_ACCOUNTS.third_party_costs), -cents, "27.2:costs:offset")] });
/** The waterfall on SM's books: Dr partner_settlement_payable{loan} for everything applied; Cr the warehouse receivables (payoff), Cr sm_cost_recovery_receivable, Cr sm_program_margin (the residual stays in partner_settlement_payable until wired). */
export function waterfallLedgerSets(loanId: string, w: Waterfall, upbCents: Cents): { sm: EntrySetInput; partner_mirror: EntrySetInput } {
  const applied = w.warehouse_paid_cents + w.sm_cost_recovery_cents + w.sm_retained_residual_cents;
  const sm: EntrySetInput = { effectiveDate: w.value_date, description: `settlement waterfall ${loanId}`, lines: [
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.partner_payable), applied, "27.2:waterfall:partner_payable", "proceeds applied per the LSA waterfall"),
    line(loanAcct(loanId, WH_ACCOUNTS.advance_principal), -w.paid_principal_cents, "27.2:waterfall:principal", "(1) advance principal"),
    line(loanAcct(loanId, WH_ACCOUNTS.advance_capitalized), -w.paid_capitalized_cents, "27.2:waterfall:capitalized", "(1) capitalized interest"),
    line(loanAcct(loanId, WH_ACCOUNTS.interest_receivable), -w.paid_accrued_cents, "27.2:waterfall:interest", "(2) accrued interest through the day before the value date"),
    line(loanAcct(loanId, WH_ACCOUNTS.fees_receivable), -w.paid_fees_cents, "27.2:waterfall:fees", "(3) warehouse fees"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.cost_recovery_receivable), -w.sm_cost_recovery_cents, "27.2:waterfall:cost_recovery", "(4) SM cost recovery (invoices, capped at forecast × 110%)"),
    line(corpAcct(SETTLEMENT_ACCOUNTS.program_margin), -w.sm_retained_residual_cents, "27.2:waterfall:sm_retained", "(5) SM retained residual (20.4-Q1)")] };
  const net_proceeds_vs_upb = w.received_cents - upbCents;
  const partner_mirror: EntrySetInput = { effectiveDate: w.value_date, description: `partner GL mirror: sale to Fannie Mae ${loanId}`, lines: [
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.warehouse_payable), w.paid_principal_cents + w.paid_capitalized_cents, "27.2:mirror:warehouse_payable", "warehouse advance repaid from proceeds"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.warehouse_interest_expense), w.paid_accrued_cents + w.paid_fees_cents, "27.2:mirror:interest_expense", "warehouse interest and fees (interest expense — not part of the pass-through)"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.cost_recovery_expense), w.sm_cost_recovery_cents + w.sm_retained_residual_cents, "27.2:mirror:cost_recovery_expense", "SM cost recovery and retained residual under the term sheet"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.partner_residual_receivable), w.partner_residual_cents, "27.2:mirror:residual", "residual due from SM's collection account"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.loans_held_for_sale), -upbCents, "27.2:mirror:lhfs", "carrying amount (UPB; deferred costs/credits per the partner's ASC 310-20 policy)"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.gain_on_sale), -net_proceeds_vs_upb, "27.2:mirror:gain_on_sale", "GAAP view: net proceeds − carrying amount")] };
  return { sm, partner_mirror };
}
export const residualPaidLedgerSet = (loanId: string, on: PlainDate, cents: Cents, collectionAccountRef: string): EntrySetInput => ({ effectiveDate: on, description: `partner residual wire ${loanId}`, lines: [line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.partner_payable), cents, "27.2:residual:partner_payable"), line(custodialAcct(collectionAccountRef, SETTLEMENT_ACCOUNTS.collection_cash), -cents, "27.2:residual:cash", "outbound wire under dual control (funding_approver)")] });
/** The partner's shortfall draft (haircut-reserve draw or wire) applied to the unpaid warehouse receivables, then SM's receivables. */
export function shortfallReceivedLedgerSet(loanId: string, w: Waterfall, on: PlainDate, amountCents: Cents, haircutReserveRef: string): EntrySetInput {
  let rem = amountCents; const take = (due: Cents): Cents => { const t = cmp(rem, due); rem -= t; return t; };
  const principal = take(w.advance_principal_cents - w.paid_principal_cents), cap = take(w.capitalized_interest_cents - w.paid_capitalized_cents), accrued = take(w.accrued_interest_cents - w.paid_accrued_cents), fees = take(w.warehouse_fees_cents - w.paid_fees_cents), cost = take(w.sm_cost_recovery_receivable_cents), retained = take(w.sm_retained_receivable_cents);
  return { effectiveDate: on, description: `partner shortfall received ${loanId}`, lines: [
    line(custodialAcct(haircutReserveRef, SETTLEMENT_ACCOUNTS.haircut_reserve), amountCents, "27.2:shortfall:draw", "haircut-reserve draw / partner wire (SM_WH_SHORTFALL_DRAFT_2BD)"),
    line(loanAcct(loanId, WH_ACCOUNTS.advance_principal), -principal, "27.2:shortfall:principal"), line(loanAcct(loanId, WH_ACCOUNTS.advance_capitalized), -cap, "27.2:shortfall:capitalized"), line(loanAcct(loanId, WH_ACCOUNTS.interest_receivable), -accrued, "27.2:shortfall:interest"), line(loanAcct(loanId, WH_ACCOUNTS.fees_receivable), -fees, "27.2:shortfall:fees"),
    line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.cost_recovery_receivable), -cost, "27.2:shortfall:cost_recovery"), line(corpAcct(SETTLEMENT_ACCOUNTS.program_margin), -retained, "27.2:shortfall:sm_retained"), line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.partner_payable), -rem, "27.2:shortfall:excess_to_partner")] };
}
export const platformFeeLedgerSet = (loanId: string, on: PlainDate, a: PlatformFeeAccrual): EntrySetInput => ({ effectiveDate: on, description: `platform fee ${a.period} ${loanId}`, lines: [line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.platform_fee_receivable), a.fee_cents, "27.2:platform_fee:receivable", `${a.basis_rule} ${a.days_accrued}/${a.days_in_period} on ${a.upb_basis_cents}`), line(corpAcct(SETTLEMENT_ACCOUNTS.platform_fee_income), -a.fee_cents, "27.2:platform_fee:income", "billed with the subservicing invoice")] });
/** Partner-mirror reversal on Fannie Mae's premium recapture: Dr gain_on_sale / Cr premium_recapture_payable (the partner bears it as seller — 27.2-Q4). */
export const recaptureReversalLedgerSet = (loanId: string, on: PlainDate, cents: Cents): EntrySetInput => ({ effectiveDate: on, description: `premium recapture reversal ${loanId}`, lines: [line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.gain_on_sale), cents, "27.2:recapture:gain_reversal", "C1-1-01 recapture within 120 days"), line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.recapture_payable), -cents, "27.2:recapture:payable")] });
/** Memo pair on the partner mirror: the borrower's rate pass-through (lender credit) and the recapture contingency (gross premium) — data only. */
export const gosMemoLedgerSet = (loanId: string, on: PlainDate, g: GainOnSale): EntrySetInput => ({ effectiveDate: on, description: `partner GL memo: pass-through and recapture contingency ${loanId}`, lines: [line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.borrower_rate_passthrough), g.actual.lender_credit_cents, "27.2:memo:passthrough", "lender credit on the final CD (Reg N substantiation)"), line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.premium_recapture_contingency), g.recapture_exposure_cents, "27.2:memo:recapture_contingency", `until ${g.recapture_exposure_until}`), line(loanAcct(loanId, SETTLEMENT_ACCOUNTS.gain_on_sale), -(g.actual.lender_credit_cents + g.recapture_exposure_cents), "27.2:memo:offset", "memo offset")] });

// ============================================================ ports (Purchase Advice APIs, collection bank) with fakes
export interface RawPurchaseAdvice extends Omit<PurchaseAdviceRecord, "purchase_advice_id" | "loan_id" | "delivery_id" | "received_at" | "status" | "raw_document_id"> { readonly raw_json: string; }
export interface PurchaseAdviceApiPort { pollSellers(adviceDate: PlainDate): Promise<readonly RawPurchaseAdvice[]>; pollServicers(sinceDate: PlainDate): Promise<readonly RawPurchaseAdvice[]>; }
export class FakePurchaseAdviceApi implements PurchaseAdviceApiPort {
  readonly queued: RawPurchaseAdvice[] = []; readonly polls: { kind: "sellers" | "servicers"; date: PlainDate }[] = [];
  queue(a: RawPurchaseAdvice): void { this.queued.push(a); }
  async pollSellers(adviceDate: PlainDate): Promise<readonly RawPurchaseAdvice[]> { this.polls.push({ kind: "sellers", date: adviceDate }); return this.queued.filter((a) => a.advice_date === adviceDate); }
  async pollServicers(sinceDate: PlainDate): Promise<readonly RawPurchaseAdvice[]> { this.polls.push({ kind: "servicers", date: sinceDate }); return this.queued.filter((a) => a.purchase_date >= sinceDate); }
}
export interface BankCredit { readonly bank_ref: string; readonly value_date: PlainDate; readonly amount_cents: Cents; readonly originator_name: string; readonly reference_text: string; readonly account_ref: string; readonly received_at: string; }
export interface CollectionBankPort { credits(sinceIso: string): Promise<readonly BankCredit[]>; }
export class FakeCollectionBank implements CollectionBankPort { readonly queued: BankCredit[] = []; queue(c: BankCredit): void { this.queued.push(c); } async credits(sinceIso: string): Promise<readonly BankCredit[]> { return this.queued.filter((c) => c.received_at >= sinceIso); } }
export interface SettlementServices { readonly advices: PurchaseAdviceApiPort; readonly collectionBank: CollectionBankPort; }

// ============================================================ event emitters (the timers' triggers and satisfiers)
type Emit = (type: string, k: AdvanceKeys, payload: Record<string, unknown>, at?: string, actor?: Actor) => DomainEvent;
export const emitSettlement = (events: EventStore): Emit => emitAdvance(events);
const S = (v: Cents): string => String(v);
export function recordPurchaseAdvice(events: EventStore, k: SettlementKeys, a: PurchaseAdviceRecord, at: string): DomainEvent {
  return emitSettlement(events)("purchase_advice.received", k, { advice_id: a.purchase_advice_id, purchase_advice_id: a.purchase_advice_id, fnma_loan_number: a.fnma_loan_number, fnma_servicer_number: a.fnma_servicer_number, lender_loan_number: a.seller_loan_number, seller_loan_number: a.seller_loan_number,
    advice_date: a.advice_date, purchase_date: a.purchase_date, purchase_ready_date: a.purchase_ready_date, remittance_type: a.remittance_type, pass_through_rate: a.pass_through_rate, note_rate_pct: a.note_rate, note_rate: a.note_rate, servicing_fee_bps: a.servicing_fee_bps, lpi_date: a.lpi_date,
    interest_adjustment_cents: S(adviceSignedInterest(a)), interest_direction: a.interest_direction, interest_days: a.interest_days, upb_cents: S(a.upb_cents), price: a.price, gross_price_proceeds_cents: S(a.gross_price_proceeds_cents), llpa_total_cents: S(a.llpa_total_cents), net_proceeds_cents: S(a.net_proceeds_cents), payee_code: a.payee_code, source: a.source, raw_document_id: a.raw_document_id }, at);
}
export const recordUnmatchedAdvice = (events: EventStore, a: PurchaseAdviceRecord, at: string): DomainEvent => events.append({ type: "purchase_advice.unmatched", actor: WAREHOUSE_AGENT, occurredAt: at, payload: { purchase_advice_id: a.purchase_advice_id, fnma_loan_number: a.fnma_loan_number, seller_loan_number: a.seller_loan_number, advice_date: a.advice_date, reason: "advice for a loan SM did not fund (partner's other channel): stored, reported to the partner, excluded from SM economics", source: "origination" } });
export function recordReceipt(events: EventStore, k: SettlementKeys | null, r: ProceedsReceiptRecord, at: string): DomainEvent {
  const payload = { receipt_id: r.receipt_id, bank_ref: r.bank_ref, value_date: r.value_date, amount_cents: S(r.amount_cents), originator_name: r.originator_name, reference_text: r.reference_text, account_ref: r.account_ref, status: r.status };
  return k ? emitSettlement(events)("proceeds.received", k, payload, at) : events.append({ type: "proceeds.received", actor: WAREHOUSE_AGENT, occurredAt: at, payload: { ...payload, source: "origination" } });
}
export function recordMatch(events: EventStore, k: SettlementKeys, m: MatchResult & { match_id: string; purchase_advice_id: string; receipt_id: string; matched_at: string }): DomainEvent[] {
  const out: DomainEvent[] = [];
  const base = { match_id: m.match_id, purchase_advice_id: m.purchase_advice_id, receipt_id: m.receipt_id, matched_at: m.matched_at, status: m.status, variance_cents: S(m.variance_cents), variance_breakdown: Object.fromEntries(Object.entries(m.variance_breakdown).map(([a, b]) => [a, S(b)])), interest_convention_observed: m.interest_convention_observed, tolerance_rule_applied: m.tolerance_rule_applied, expected_proceeds_cents: S(m.expected_proceeds_cents), advice_proceeds_cents: S(m.advice_proceeds_cents), received_cents: S(m.received_cents) };
  if (m.status === "matched" || m.status === "matched_with_variance") { out.push(emitSettlement(events)("proceeds.matched", k, base, m.matched_at)); out.push(emitSettlement(events)("purchase_advice.matched", k, { purchase_advice_id: m.purchase_advice_id, match_id: m.match_id, matched_at: m.matched_at }, m.matched_at)); }
  else out.push(emitSettlement(events)("proceeds.exception", k, { ...base, kind: m.exception_kind, funds_transfer_error: m.funds_transfer_error }, m.matched_at));
  if (m.convention_action === "lock") out.push(emitSettlement(events)("fnma_interest_convention.locked", k, { convention: m.convention_after, locked_by_advice_id: m.purchase_advice_id, locked_at: m.matched_at }, m.matched_at));
  return out;
}
export const recordProvisionalMatch = (events: EventStore, k: SettlementKeys, p: { match_id: string; receipt_id: string; variance_cents: Cents; at: string }): DomainEvent => emitSettlement(events)("proceeds.provisional_match", k, { match_id: p.match_id, receipt_id: p.receipt_id, variance_cents: S(p.variance_cents), status: "provisional", confirmed_when: "purchase_advice.received" }, p.at);
export const recordProceedsException = (events: EventStore, k: SettlementKeys, kind: ExceptionKind, payload: Record<string, unknown>, at: string): DomainEvent => emitSettlement(events)("proceeds.exception", k, { kind, ...payload }, at);
export function recordWaterfall(events: EventStore, k: SettlementKeys & { note_form: NoteForm }, w: Waterfall, r: { waterfall_id: string; match_id: string; posted_at: string; ledger_entry_ids: readonly string[] }): DomainEvent[] {
  const out: DomainEvent[] = [];
  out.push(emitSettlement(events)("settlement.waterfall.posted", k, { waterfall_id: r.waterfall_id, match_id: r.match_id, posted_at: r.posted_at, value_date: w.value_date, received_cents: S(w.received_cents), payoff_total_cents: S(w.payoff_total_cents), warehouse_paid_cents: S(w.warehouse_paid_cents),
    sm_cost_recovery_cents: S(w.sm_cost_recovery_cents), sm_retained_residual_cents: S(w.sm_retained_residual_cents), partner_residual_cents: S(w.partner_residual_cents), shortfall_cents: S(w.shortfall_cents), shortfall: w.shortfall_cents > 0n, partner_wire_value_date: w.partner_wire_value_date, ledger_entry_ids: [...r.ledger_entry_ids] }, r.posted_at));
  if (w.warehouse_repaid_in_full) out.push(recordRepaidFromProceeds(events, k, { repaid_at: r.posted_at, amount_cents: w.warehouse_paid_cents, match_id: r.match_id }));
  else out.push(emitSettlement(events)("settlement.shortfall.drafted", k, { waterfall_id: r.waterfall_id, shortfall_cents: S(w.shortfall_cents), due_on: w.shortfall_draft_due_on, source_of_funds: "partner_haircut_reserve_or_wire", sm_cost_recovery_receivable_cents: S(w.sm_cost_recovery_receivable_cents), partner_receivable_cents: S(w.partner_receivable_cents) }, r.posted_at));
  return out;
}
/** 27.1's baseline event, the `repaid_from=purchase_proceeds` variant 30.1 consumes: repaid_at = the receipt value date (ET), bank-matched. */
export const recordRepaidFromProceeds = (events: EventStore, k: SettlementKeys & { note_form: NoteForm }, r: { repaid_at: string; amount_cents: Cents; match_id: string }): DomainEvent =>
  emitSettlement(events)("warehouse.advance.repaid", k, { repaid_at: etDate(r.repaid_at), repaid_from: "purchase_proceeds", bank_matched: true, note_form: k.note_form, amount_cents: S(r.amount_cents), match_id: r.match_id }, r.repaid_at);
export function recordReleases(events: EventStore, k: SettlementKeys & { note_form: NoteForm; bailee_letter_id: string | null; custodian_party_id: string | null; min: string | null }, plan: ReleasePlan, at: string): DomainEvent[] {
  if (plan.note_form === "paper") return [emitSettlement(events)("warehouse.bailee_letter.released", k, { bailee_letter_id: k.bailee_letter_id, custodian_party_id: k.custodian_party_id, released_at: at, release_notice_document_id: `doc:release-${k.advance_id}`, letter_status: "released", interim_funder_removal_due_on: plan.interim_funder_removal_due_on, min: k.min, why: "Fannie Mae owns the note on payment (C1-2-03); housekeeping and the custodian's file" }, at)];
  return [emitSettlement(events)("warehouse.collateral.status_changed", k, { from: "transferred_pending_payment", to: "released", reason: "eNote Funding Agreement releases SM's interest when Fannie Mae pays the purchase price; Secured Party already removed at Transfer of Control", secured_party_released_at: at, collateral_chain: "closed" }, at)];
}
export const recordShortfallReceived = (events: EventStore, k: SettlementKeys & { note_form: NoteForm }, r: { waterfall_id: string; amount_cents: Cents; received_at: string; source: "haircut_reserve_draw" | "partner_wire"; match_id: string; repaid_in_full: boolean }): DomainEvent[] => {
  const out = [emitSettlement(events)("settlement.shortfall.received", k, { waterfall_id: r.waterfall_id, amount_cents: S(r.amount_cents), received_at: r.received_at, source: r.source }, r.received_at)];
  if (r.repaid_in_full) out.push(recordRepaidFromProceeds(events, k, { repaid_at: r.received_at, amount_cents: r.amount_cents, match_id: r.match_id }));
  return out;
};
export const recordResidualPaid = (events: EventStore, k: SettlementKeys, r: { wire_ref: string; value_date: PlainDate; amount_cents: Cents; approval_id: string; paid_at: string }): DomainEvent => emitSettlement(events)("partner.residual.paid", k, { wire_ref: r.wire_ref, value_date: r.value_date, amount_cents: S(r.amount_cents), funding_approver_approval_id: r.approval_id, dual_control: true, beneficiary_verified: true }, r.paid_at);
export const recordGosComputed = (events: EventStore, k: SettlementKeys, r: { gos_id: string; g: GainOnSale; at: string }): DomainEvent => emitSettlement(events)("gain_on_sale.computed", k, { gos_id: r.gos_id, partner_origination_result_cents: S(r.g.actual.partner_origination_result_cents), net_premium_cents: S(r.g.actual.net_premium_cents), recapture_exposure_cents: S(r.g.recapture_exposure_cents), recapture_exposure_until: r.g.recapture_exposure_until }, r.at);
export function recordPassthroughReconciled(events: EventStore, k: SettlementKeys, r: { gos_id: string; recon_id: string; recon: PassthroughRecon; at: string }): DomainEvent[] {
  return [emitSettlement(events)("rate_passthrough.reconciled", k, { recon_id: r.recon_id, gos_id: r.gos_id, status: r.recon.status, surplus_cents: S(r.recon.surplus_cents), surplus_disposition: r.recon.surplus_disposition, flags: [...r.recon.flags], evidence_document_ids: [...r.recon.evidence_document_ids] }, r.at),
    emitSettlement(events)("gain_on_sale.posted", k, { gos_id: r.gos_id, recon_id: r.recon_id, passthrough_reconciled: true, passthrough_status: r.recon.status, posted_at: r.at }, r.at)];
}
export const recordMsrHandoff = (events: EventStore, k: SettlementKeys, r: { handoff_id: string; channel: "partner_api" | "sftp" | "portal"; payload: MsrPayload; purchase_advice_id: string; at: string }): DomainEvent => emitSettlement(events)("msr.handoff.issued", k, { handoff_id: r.handoff_id, channel: r.channel, schema_version: MSR_SCHEMA_VERSION, purchase_advice_id: r.purchase_advice_id, payload: { ...r.payload, upb_at_purchase_cents: S(r.payload.upb_at_purchase_cents), pi_cents: S(r.payload.pi_cents) }, valuation: null }, r.at);
export const recordMsrAcknowledged = (events: EventStore, k: SettlementKeys, r: { handoff_id: string; at: string }): DomainEvent => emitSettlement(events)("msr.handoff.acknowledged", k, { handoff_id: r.handoff_id, acknowledged_at: r.at }, r.at);
export const recordPlatformFee = (events: EventStore, k: SettlementKeys, a: PlatformFeeAccrual, r: { accrual_id: string; at: string; ledger_entry_id: string | null }): DomainEvent => emitSettlement(events)("platform_fee.accrued", k, { accrual_id: r.accrual_id, period: a.period, fee_cents: S(a.fee_cents), upb_basis_cents: S(a.upb_basis_cents), basis_rule: a.basis_rule, days_accrued: a.days_accrued, days_in_period: a.days_in_period, ledger_entry_id: r.ledger_entry_id }, r.at);
export const recordGlExport = (events: EventStore, facilityId: string, b: GlBatch, at: string): DomainEvent => emitFacility(events, facilityId, "gl.export.completed", { batch_id: b.batch_id, target: b.target, period_date: b.period_date, line_count: b.line_count, control_totals: { debit_cents: S(b.control_totals.debit_cents), credit_cents: S(b.control_totals.credit_cents), balanced: b.control_totals.balanced }, hash: b.hash, status: b.status, acknowledged_at: b.acknowledged_at }, at);
export const recordPpaRequested = (events: EventStore, k: SettlementKeys, p: PpaRequest, by: Actor, at: string): DomainEvent => emitSettlement(events)("ppa.requested", k, { ppa_id: p.ppa_id, purchase_advice_id: p.purchase_advice_id, kind: p.kind, channel: p.channel, llpa_relevant: p.kind === "data_correction", submitted_on: etDate(at), due_at: p.due_at, platform_target_on: p.platform_target_on, amount_cents: S(p.amount_cents), attributes: p.attributes, seller_number: p.seller_number, fnma_loan_number: p.fnma_loan_number, filed_by_role: p.filed_by_role, party: p.party, requested_at: at }, at, by);
export const recordPpaResolved = (events: EventStore, k: SettlementKeys, p: PpaRequest, r: { resolution_cents: Cents; fnma_reference: string; resolved_at: string; outcome: "accepted" | "rejected" | "settled" }): DomainEvent => emitSettlement(events)("ppa.resolved", k, { ppa_id: p.ppa_id, kind: p.kind, channel: p.channel, outcome: r.outcome, resolution_cents: S(r.resolution_cents), fnma_reference: r.fnma_reference, resolved_at: r.resolved_at }, r.resolved_at);
export const recordPremiumRecapture = (events: EventStore, k: SettlementKeys, r: { gos_id: string; assessed_cents: Cents; payoff_date: PlainDate; within_window: boolean; fnma_reference: string; at: string; ledger_entry_id: string | null }): DomainEvent => emitSettlement(events)("premium_recapture.assessed", k, { gos_id: r.gos_id, assessed_cents: S(r.assessed_cents), payoff_date: r.payoff_date, within_window: r.within_window, fnma_reference: r.fnma_reference, allocation: "partner", sm_cost_recovery_clawed_back: false, recapture_exposure_cents_after: "0", ledger_entry_id: r.ledger_entry_id, gate_evidence: "FNMA_C1_1_01_PREMIUM_RECAPTURE_120 (20.1)" }, r.at);
/** Platform record of the custodian certification / eNote auto-certification (29.4's `custody.certified`, observed from Loan Delivery) — arms SM_WH_PROCEEDS_EXPECTED_1BD on `certification_date`. */
export const recordCertificationObserved = (events: EventStore, k: SettlementKeys, r: { certification_date: PlainDate; note_form: NoteForm; observed_at: string; source: "custodian" | "loan_delivery_auto_certification" }): DomainEvent => emitSettlement(events)("custody.certified", k, { certification_date: r.certification_date, note_form: r.note_form, source_system: r.source, observed_by: "27.2 (platform record of the 29.4 observation)", expected_proceeds_on: addBusinessDays(r.certification_date, 1, fannieEt) }, r.observed_at, { kind: "external", id: "loan_delivery" });

// ============================================================ decision record (LL-2026-04 lineage)
export function settlementDecisionRecord(r: { match_id: string; keys: SettlementKeys; expected: Cents; advice: Cents; received: Cents; breakdown: VarianceBreakdown; convention_used: InterestConvention; waterfall: Waterfall | null; releases: ReleasePlan | null; gos: GainOnSale | null; passthrough_status: PassthroughRecon["status"] | null; ppa_decision: string | null; outcome: string; rationale: string; llm: { model_version: string | null; prompt_version: string | null }; reviewer: string | null }): Record<string, unknown> {
  return { match_id: r.match_id, keys: { loan_id: r.keys.loan_id, application_id: r.keys.application_id, advance_id: r.keys.advance_id, funding_id: r.keys.funding_id, delivery_id: r.keys.delivery_id, fnma_loan_number: r.keys.fnma_loan_number, seller_loan_number: r.keys.seller_loan_number },
    expected: S(r.expected), advice: S(r.advice), received: S(r.received), variance_breakdown: Object.fromEntries(Object.entries(r.breakdown).map(([a, b]) => [a, S(b)])), convention_used: r.convention_used,
    waterfall: r.waterfall ? { warehouse_paid_cents: S(r.waterfall.warehouse_paid_cents), sm_cost_recovery_cents: S(r.waterfall.sm_cost_recovery_cents), sm_retained_residual_cents: S(r.waterfall.sm_retained_residual_cents), partner_residual_cents: S(r.waterfall.partner_residual_cents), shortfall_cents: S(r.waterfall.shortfall_cents) } : null,
    releases: r.releases, gos_components: r.gos ? { partner_origination_result_cents: S(r.gos.actual.partner_origination_result_cents), net_premium_cents: S(r.gos.actual.net_premium_cents), interest_carry_cents: S(r.gos.actual.interest_carry_cents) } : null, passthrough_status: r.passthrough_status, ppa_decision: r.ppa_decision,
    rationale: r.rationale, rule_set_versions: ECONOMICS_RULE_SETS, model_version: r.llm.model_version, prompt_version: r.llm.prompt_version, outcome: r.outcome, reviewer: r.reviewer, numbers_by: "deterministic code; the LLM drafts narrative only" };
}
