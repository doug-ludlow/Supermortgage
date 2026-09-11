/**
 * §24.6 Mortgage insurance at origination — DU's MI requirement (23.1), Fannie Mae's LTV rounding (B2-1.2-01), the
 * B7-1-02 coverage table with the minimum-coverage option and its LLPA (LLPA Matrix 09.09.2026), MI rate quotes and
 * ordering through the insurers' adapters, the commitment / certificate, activation at the note date, BPMI monthly
 * (non-waivable escrow, B2-1.5-04) versus single / split / financed premiums (B7-1-04) and LPMI (B7-1-03), the HPA
 * §4903 initial disclosure (fixed: initial amortization schedule + notice; ARM: notice) and the §4905(c) LPMI
 * disclosure at commitment. Small pure functions, one per rule / T-id, plus the event recorders that arm and close
 * the 24.6 timers. Bigint cents, PlainDate arithmetic, erasable TypeScript only.
 *
 * Seams (reused, never re-implemented):
 *   10.2/10.3 (src/domain/pmi/schedule.ts) own the amortization schedule and the HPA date arithmetic — buildSchedule,
 *        scheduledDateForPct (80% cancellation / 78% termination), midpoint — so the purchase fixture's Oct 1, 2034 /
 *        Dec 1, 2035 / Jan 1, 2042 reproduce from the code the servicing side runs; 10.2's lpmiOptionsNoticeDue gives
 *        the §4905(c)(2) send-by date from `lpmi_equiv_termination_date`.
 *   23.1 emits `du.findings.received{mi_requirement}` (ops-23-1.ts) — the quote clock's trigger; 22.4 emits
 *        `ipc.excess.reclassified{adjusted_price_cents}` (ops-22-4.ts) — a value-basis change → revalue().
 *   30.2's OB-009 reads mi_certificates.status ∈ {active, activation_requested} + certificate number, coverage,
 *        plan and hpa_disclosure_kind; 30.4's HO-018 waits for 10.x's `mi_policy.activated` (10.4 ingests the
 *        seedMiPolicy payload). 3.8's FNMA_B101_MI_MONTHLY_ESCROW_GATE is referenced (30.3 satisfies it).
 *   29.3/29.4 read sfc_codes (019 LPMI / 281 financed MI), Financed MI Amount and the MI Financed Indicator.
 *
 * Events (every one carries `applicationId` + payload.application_id so the origination timers arm — engine.ts isOriginationContext):
 *   mi.quote.received{insurers, quote_ids, count}                       [satisfies SM_MI_QUOTE_1BD]
 *   mi.plan.selected{premium_plan, coverage_option, quote_id}           [arms HPA_4905C_LPMI_DISCLOSURE_GATE when premium_plan ∈ {lpmi_monthly, lpmi_single}]
 *   mi.ordered{order_type, du_reliance, mi_company_code}                [satisfies SM_MI_ORDER_2BD]
 *   mi.commitment.received{commitment_number, commitment_expires_at}   [satisfies FNMA_B7_1_01_MI_COMMITMENT_BEFORE_DOCS_GATE]
 *   mi.certificate.issued{certificate_number, coverage_pct}             mi.certificate.expiring{commitment_expires_at}
 *   mi.cancelled_pre_closing{reason}                                    mi.declined{reason}
 *   hpa.initial_disclosure.rendered{kind, cancellation_date, termination_date, midpoint_termination_date, schedule_hash}
 *   hpa.initial_disclosure.delivered{delivered_at, consummation_at}      [satisfies HPA_4903_INITIAL_DISCLOSURE_GATE]
 *   hpa.lpmi_disclosure.delivered{delivered_at}                          [satisfies HPA_4905C_LPMI_DISCLOSURE_GATE]
 *   mi.activation.requested{note_date}                                   [arms FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE (29.4 asserts it at submitDelivery)]
 *   mi.activated{activation_effective_date, certificate_number}          [satisfies SM_MI_ACTIVATE_1BD, FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE]
 *   mi.premium.remitted{amount_cents}                                    [satisfies SM_MI_UPFRONT_REMIT_10]
 * Consumed: du.findings.received (23.1), decision.issued{conditional_approval} (21.6), closing.scheduled / closing.consummated (26.1),
 *   loan.funded (30.2), lock.executed (21.4), ipc.excess.reclassified (22.4).
 */
import { createHash } from "node:crypto";
import { type PlainDate, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, creditor } from "../../kernel/calendar/business.ts";
import { type Cents, levelPayment, ratePercent } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { buildSchedule, scheduledDateForPct, midpoint, thresholdCents, type ScheduleVersion, type ScheduleRow } from "../pmi/schedule.ts";
import { lpmiOptionsNoticeDue } from "../pmi/termination.ts";

export const AGENT_24_6: Actor = { kind: "agent", id: "title-closing" };
export const RULE_SET_SELLING = "fnma.selling.2026-09-02";
export const RULE_SET_LLPA = "fnma.llpa.2026-09-09";
export const RULE_SET_LIMITS = "fnma.limits.2026";
export const APPROVED_MI_LIST_VERSION = "2025-07";
/** 00a-fnma §4.2: 2026 one-unit baseline conforming loan limit. */
export const LOAN_LIMIT_2026_1_UNIT_CENTS: Cents = 83_275_000n;
export const SFC_LPMI = "019";
export const SFC_FINANCED_MI = "281";
export const NTC_HPA_4903_INITIAL_FIXED = "NTC_HPA_4903_INITIAL_FIXED";
export const NTC_HPA_4903_INITIAL_ARM = "NTC_HPA_4903_INITIAL_ARM";
export const NTC_HPA_4905_LPMI = "NTC_HPA_4905_LPMI";

/** Approved Mortgage Insurers and Related Identifiers (July 2025): the definitive list; 95/97 mean "MI not required". */
export const APPROVED_MI_INSURERS: readonly { code: string; name: string }[] = [
  { code: "01", name: "Enact Mortgage Insurance Corporation" }, { code: "06", name: "Mortgage Guaranty Insurance Corporation" },
  { code: "12", name: "United Guaranty Residential Insurance Company" }, { code: "33", name: "Radian Guaranty Inc." },
  { code: "37", name: "MassHousing Mortgage Insurance Fund" }, { code: "38", name: "Arch Mortgage Insurance Company" },
  { code: "43", name: "Essent Guaranty, Inc." }, { code: "44", name: "National Mortgage Insurance Corporation" },
];
export const MI_NOT_REQUIRED_CODES: readonly string[] = ["95", "97"];
export const isApprovedInsurer = (code: string): boolean => APPROVED_MI_INSURERS.some((i) => i.code === code);
export const insurerName = (code: string): string | null => APPROVED_MI_INSURERS.find((i) => i.code === code)?.name ?? null;

export class MiRefused extends RangeError { readonly code: string; readonly citation: string; constructor(code: string, citation: string, reason: string) { super(`${code}: ${reason}`); this.name = "MiRefused"; this.code = code; this.citation = citation; } }

export type PremiumPlan = "bpmi_monthly" | "bpmi_annual" | "bpmi_single" | "bpmi_split" | "financed_single" | "lpmi_monthly" | "lpmi_single";
export const PREMIUM_PLANS: readonly PremiumPlan[] = ["bpmi_monthly", "bpmi_annual", "bpmi_single", "bpmi_split", "financed_single", "lpmi_monthly", "lpmi_single"];
export const isLpmi = (plan: PremiumPlan): boolean => plan === "lpmi_monthly" || plan === "lpmi_single";
export type CoverageOption = "standard" | "minimum";
export type TransactionType = "purchase" | "limited_cash_out" | "cash_out";
export type Product = "fixed" | "arm";
export type Occupancy = "primary" | "second_home" | "investment";
export type ScoreModel = "classic_fico" | "vantagescore_4";
export type RenewalType = "constant" | "declining" | "level";
export type MiStatus = "quoted" | "plan_selected" | "ordered" | "committed" | "docs_ready" | "activation_requested" | "active" | "declined" | "cancelled_pre_closing" | "expired";
export type HpaKind = "initial_fixed" | "initial_arm" | "lpmi_commitment";

export const civilDate = (iso: string): PlainDate => plainDate(iso.slice(0, 10));
/** n / d rounded half up (non-negative bigint). */
export const divHalfUp = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);
const emit = (events: EventStore, applicationId: string, type: string, payload: Record<string, unknown>, at: string, actor: Actor = AGENT_24_6, loanId?: string | null): DomainEvent =>
  events.append({ type, applicationId, ...(loanId ? { loanId } : {}), aggregate: { kind: "application", id: applicationId }, actor, occurredAt: at, payload: { application_id: applicationId, ...payload } });

// ============================================================ the insurers' adapters (mi/* — MISMO 3.5 rate quote; order / activation / remittance vendor-specific)
/** Wired by the runtime as `services.mi_origination`; every call is idempotent by payload hash on the adapter side. Absent in tests → the tool inputs carry the insurer responses. */
export interface MiOriginationPort {
  rateQuote(req: { application_id: string; loan_amount_cents: Cents; coverage_pct: number; coverage_option: CoverageOption; plans: readonly PremiumPlan[]; insurers: readonly string[]; facts: Record<string, unknown> }): Promise<readonly QuoteInput[]>;
  submitOrder(req: { application_id: string; mi_company_code: string; order_type: "delegated" | "non_delegated"; du_casefile_id: string | null; quote_id: string; package: Record<string, unknown> }): Promise<{ order_id: string; acknowledged_at: string }>;
  getCommitment(req: { application_id: string; mi_company_code: string; order_id?: string | null }): Promise<CommitmentRaw>;
  activate(req: { mi_company_code: string; certificate_number: string | null; commitment_number: string | null; note_date: PlainDate }): Promise<{ activation_effective_date: PlainDate; certificate_number: string; confirmed_at: string }>;
  remitPremium(req: { mi_company_code: string; certificate_number: string; amount_cents: Cents; remitted_at: string }): Promise<{ remittance_id: string }>;
}

// ============================================================ R1: LTV for MI (B2-1.2-01)
export type LtvBand = "80.01-85.00" | "85.01-90.00" | "90.01-95.00" | "95.01-97.00";
const BANDS: readonly LtvBand[] = ["80.01-85.00", "85.01-90.00", "90.01-95.00", "95.01-97.00"];
/** Band of a rounded LTV: null when ≤ 80% (MI not required) or > 97% (outside the table). */
export function ltvBand(ltvPctRounded: number): LtvBand | null {
  if (ltvPctRounded <= 80) return null;
  if (ltvPctRounded <= 85) return "80.01-85.00";
  if (ltvPctRounded <= 90) return "85.01-90.00";
  if (ltvPctRounded <= 95) return "90.01-95.00";
  if (ltvPctRounded <= 97) return "95.01-97.00";
  return null;
}
/** Purchase: lower of sales price and appraised value; refinance: the appraised value (B7-1-01 / B2-1.2-01). */
export function valueBasis(i: { transaction_type: TransactionType; sales_price_cents?: Cents | null; appraised_value_cents: Cents }): Cents {
  if (i.transaction_type !== "purchase" || i.sales_price_cents === undefined || i.sales_price_cents === null) return i.appraised_value_cents;
  return i.sales_price_cents < i.appraised_value_cents ? i.sales_price_cents : i.appraised_value_cents;
}
export interface RoundedLtv { readonly ltv_raw: string; readonly ltv_trunc2: string; readonly ltv_bps: number; readonly ltv_pct_rounded: number; }
/** "truncated (shortened) to two decimal places, then rounded up to the nearest whole percent" — 94.01 → 95; 80.001 → 80. */
export function roundLtv(loanCents: Cents, valueCents: Cents): RoundedLtv {
  if (valueCents <= 0n) throw new RangeError("value basis must be > 0");
  const micro = (loanCents * 1_000_000n) / valueCents;                       // truncated ratio × 10^6
  const bps = Number((loanCents * 10_000n) / valueCents);                      // truncated to two decimals of a percent
  const pct = Math.ceil(bps / 100);
  const raw = `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
  return { ltv_raw: raw, ltv_trunc2: `${Math.floor(bps / 100)}.${(bps % 100).toString().padStart(2, "0")}`, ltv_bps: bps, ltv_pct_rounded: pct };
}
export interface LtvComputation extends RoundedLtv { readonly value_basis_cents: Cents; readonly band: LtvBand | null; readonly mi_required: boolean; readonly gross_ltv_pct_rounded: number | null; readonly gross_ltv_bps: number | null; }
export function computeLtvRounded(i: { loan_amount_cents: Cents; transaction_type: TransactionType; sales_price_cents?: Cents | null; appraised_value_cents: Cents; financed_premium_cents?: Cents | null }): LtvComputation {
  const value = valueBasis(i);
  const base = roundLtv(i.loan_amount_cents, value);
  const fin = i.financed_premium_cents ?? 0n;
  const gross = fin > 0n ? roundLtv(i.loan_amount_cents + fin, value) : null;
  return { ...base, value_basis_cents: value, band: ltvBand(base.ltv_pct_rounded), mi_required: base.ltv_pct_rounded > 80, gross_ltv_pct_rounded: gross?.ltv_pct_rounded ?? null, gross_ltv_bps: gross?.ltv_bps ?? null };
}

// ============================================================ R2: coverage lookup (B7-1-02, 08/07/2019)
export type CoverageRow = "fixed_le_20" | "fixed_gt_20_or_arm" | "homeready_fixed_le_20" | "homeready_fixed_gt_20_or_arm" | "standard_mh";
type Cell = { readonly std: number; readonly min: number | null } | null;
const COVERAGE_TABLE: Record<CoverageRow, readonly [Cell, Cell, Cell, Cell]> = {
  fixed_le_20: [{ std: 6, min: null }, { std: 12, min: null }, { std: 25, min: 16 }, { std: 35, min: 18 }],
  fixed_gt_20_or_arm: [{ std: 12, min: 6 }, { std: 25, min: 12 }, { std: 30, min: 16 }, { std: 35, min: 18 }],
  homeready_fixed_le_20: [{ std: 6, min: null }, { std: 12, min: null }, { std: 25, min: 16 }, { std: 25, min: 18 }],
  homeready_fixed_gt_20_or_arm: [{ std: 12, min: 6 }, { std: 25, min: 12 }, { std: 25, min: 16 }, { std: 25, min: 18 }],
  standard_mh: [{ std: 12, min: 6 }, { std: 25, min: 12 }, { std: 30, min: 16 }, null],
};
export function coverageRow(i: { product: Product; term_months: number; homeready: boolean; standard_mh?: boolean }): CoverageRow {
  if (i.standard_mh) return "standard_mh";
  const le20 = i.product === "fixed" && i.term_months <= 240;
  if (i.homeready) return le20 ? "homeready_fixed_le_20" : "homeready_fixed_gt_20_or_arm";
  return le20 ? "fixed_le_20" : "fixed_gt_20_or_arm";
}
export interface CoverageLookup { readonly band: LtvBand | null; readonly row: CoverageRow; readonly standard_pct: number | null; readonly minimum_pct: number | null; readonly coverage_option: CoverageOption; readonly coverage_required_pct: number | null; readonly mi_required: boolean; readonly not_applicable: boolean; readonly rule_set_version: string; }
/** Coverage keyed by (product/term, HomeReady, standard MH, LTV band); the minimum option only where the table shows a * value. */
export function lookupCoverage(i: { ltv_pct_rounded: number; product: Product; term_months: number; homeready: boolean; standard_mh?: boolean; coverage_option?: CoverageOption }): CoverageLookup {
  const band = ltvBand(i.ltv_pct_rounded); const row = coverageRow(i); const option = i.coverage_option ?? "standard";
  if (!band) return { band, row, standard_pct: null, minimum_pct: null, coverage_option: option, coverage_required_pct: null, mi_required: i.ltv_pct_rounded > 80, not_applicable: i.ltv_pct_rounded > 97, rule_set_version: RULE_SET_SELLING };
  const cell = COVERAGE_TABLE[row][BANDS.indexOf(band)];
  if (!cell) return { band, row, standard_pct: null, minimum_pct: null, coverage_option: option, coverage_required_pct: null, mi_required: true, not_applicable: true, rule_set_version: RULE_SET_SELLING };
  if (option === "minimum" && cell.min === null) throw new MiRefused("MIN_COVERAGE_NOT_OFFERED", "B7-1-02: minimum coverage only where the table shows a * value", `no minimum-coverage option for ${row} at ${band}`);
  return { band, row, standard_pct: cell.std, minimum_pct: cell.min, coverage_option: option, coverage_required_pct: option === "minimum" ? cell.min : cell.std, mi_required: true, not_applicable: false, rule_set_version: RULE_SET_SELLING };
}

// ============================================================ R2: minimum-coverage LLPA (LLPA Matrix 09.09.2026, verified cell-by-cell 2026-09-11)
const MIN_MI_LLPA_ROWS: readonly { readonly classic_from: number; readonly cells: readonly [string, string, string, string] }[] = [
  { classic_from: 740, cells: ["0.125", "0.375", "0.500", "1.000"] },
  { classic_from: 720, cells: ["0.125", "0.625", "0.875", "1.250"] },
  { classic_from: 700, cells: ["0.125", "0.750", "0.875", "1.250"] },
  { classic_from: 680, cells: ["0.125", "0.750", "0.875", "1.750"] },
  { classic_from: 660, cells: ["0.750", "1.250", "1.750", "2.125"] },
  { classic_from: 640, cells: ["1.250", "1.750", "2.000", "2.375"] },
  { classic_from: 620, cells: ["1.750", "2.000", "2.250", "2.750"] },
  { classic_from: 0, cells: ["2.000", "2.250", "2.500", "3.000"] },
];
export interface MinCoverageLlpa { readonly grid: ScoreModel; readonly row_label: string; readonly band: LtvBand; readonly llpa_pct: string; readonly llpa_bps: number; readonly llpa_cents: Cents; readonly rule_set_version: string; }
/** Classic FICO grid, or the VantageScore 4.0 grid whose bands sit one band (20 points) higher; the LLPA is "in addition to any other LLPAs". */
export function lookupMinCoverageLlpa(i: { score_model: ScoreModel; representative_score: number; ltv_pct_rounded: number; loan_amount_cents: Cents }): MinCoverageLlpa {
  const band = ltvBand(i.ltv_pct_rounded); if (!band) throw new MiRefused("LLPA_NO_MI_BAND", "B7-1-02", `LTV ${i.ltv_pct_rounded}% is outside the MI bands`);
  const shift = i.score_model === "vantagescore_4" ? 20 : 0;
  const idx = MIN_MI_LLPA_ROWS.findIndex((r) => i.representative_score >= r.classic_from + shift);
  const row = MIN_MI_LLPA_ROWS[idx]!; const next = MIN_MI_LLPA_ROWS[idx - 1];
  const label = row.classic_from === 0 ? `< ${620 + shift}` : next ? `${row.classic_from + shift}–${next.classic_from + shift - 1}` : `≥ ${row.classic_from + shift}`;
  const pct = row.cells[BANDS.indexOf(band)]!;
  const bps = Number(Decimal.parse(pct).mul(Decimal.fromInt(100)).toFixed(1));
  const centsDue = Decimal.fromBigInt(i.loan_amount_cents).mul(Decimal.parse(pct)).div(Decimal.fromInt(100)).toScaledInt(0, "HALF_UP");
  return { grid: i.score_model, row_label: label, band, llpa_pct: pct, llpa_bps: bps, llpa_cents: centsDue, rule_set_version: RULE_SET_LLPA };
}

// ============================================================ R3: premium arithmetic (rates from the insurer's quote — never an internal table)
/** monthly BPMI / LPMI: round_half_up(loan × rate_bps ÷ 10000 ÷ 12). */
export const monthlyPremiumCents = (loanCents: Cents, rateBps: number): Cents => divHalfUp(loanCents * BigInt(rateBps), 120_000n);
/** single / upfront: round_half_up(loan × rate_bps ÷ 10000). */
export const upfrontPremiumCents = (loanCents: Cents, rateBps: number): Cents => divHalfUp(loanCents * BigInt(rateBps), 10_000n);
export interface QuoteInput { readonly mi_company_code: string; readonly plan: PremiumPlan; readonly coverage_pct: number; readonly coverage_option: CoverageOption; readonly rate_bps: number; readonly renewal_rate_bps?: number | null; readonly renewal_type?: RenewalType; readonly refundable?: boolean; readonly quoted_at: string; readonly expires_at: string; readonly quote_id?: string; readonly request_payload_hash?: string; }
export interface MiQuote extends QuoteInput { readonly quote_id: string; readonly application_id: string; readonly monthly_premium_cents: Cents; readonly upfront_premium_cents: Cents; readonly premium_cents: Cents; readonly renewal_type: RenewalType; readonly refundable: boolean; readonly selected: boolean; }
const isUpfrontPlan = (p: PremiumPlan): boolean => p === "bpmi_single" || p === "financed_single" || p === "lpmi_single" || p === "bpmi_split";
/** Price one insurer quote from its own rate: the monthly and/or upfront premium the plan carries. */
export function priceQuote(applicationId: string, loanCents: Cents, q: QuoteInput): MiQuote {
  if (!PREMIUM_PLANS.includes(q.plan)) throw new RangeError(`unknown premium plan ${q.plan}`);
  const upfront = isUpfrontPlan(q.plan) ? upfrontPremiumCents(loanCents, q.rate_bps) : 0n;
  const monthlyRate = q.plan === "bpmi_split" ? (q.renewal_rate_bps ?? 0) : q.rate_bps;
  const monthly = q.plan === "bpmi_monthly" || q.plan === "lpmi_monthly" || q.plan === "bpmi_split" ? monthlyPremiumCents(loanCents, monthlyRate) : q.plan === "bpmi_annual" ? divHalfUp(upfrontPremiumCents(loanCents, q.rate_bps), 12n) : 0n;
  return { ...q, quote_id: q.quote_id ?? `q-${q.mi_company_code}-${q.plan}-${q.coverage_pct}`, application_id: applicationId, monthly_premium_cents: monthly, upfront_premium_cents: upfront, premium_cents: isUpfrontPlan(q.plan) ? upfront : monthly, renewal_type: q.renewal_type ?? "constant", refundable: q.refundable ?? false, selected: false };
}
export interface PlanComparisonRow { readonly quote_id: string; readonly mi_company_code: string; readonly insurer: string | null; readonly plan: PremiumPlan; readonly coverage_pct: number; readonly coverage_option: CoverageOption; readonly rate_bps: number; readonly monthly_cents: Cents; readonly upfront_cents: Cents; readonly llpa_cents: Cents; readonly first_year_cost_cents: Cents; }
export interface PlanComparison { readonly rows: readonly PlanComparisonRow[]; readonly minimum_vs_standard: { readonly monthly_saving_cents: Cents; readonly llpa_cents: Cents; readonly breakeven_months: number | null } | null; readonly disclosure: string; }
export const PLAN_COMPARISON_DISCLOSURE = "This comparison was prepared automatically. Mortgage insurance protects the lender, not you, if the loan is not repaid. Each option is shown with its cost; none is recommended over another.";
/** Cost comparison across quotes (never steering): the minimum-coverage row carries its LLPA; break-even = LLPA ÷ monthly saving. */
export function compareMiPlans(i: { quotes: readonly MiQuote[]; llpa?: MinCoverageLlpa | null }): PlanComparison {
  const rows = i.quotes.map((q) => { const llpa = q.coverage_option === "minimum" ? (i.llpa?.llpa_cents ?? 0n) : 0n; return { quote_id: q.quote_id, mi_company_code: q.mi_company_code, insurer: insurerName(q.mi_company_code), plan: q.plan, coverage_pct: q.coverage_pct, coverage_option: q.coverage_option, rate_bps: q.rate_bps, monthly_cents: q.monthly_premium_cents, upfront_cents: q.upfront_premium_cents, llpa_cents: llpa, first_year_cost_cents: q.upfront_premium_cents + llpa + q.monthly_premium_cents * 12n }; });
  const std = rows.find((r) => r.coverage_option === "standard" && r.plan === "bpmi_monthly"), min = rows.find((r) => r.coverage_option === "minimum" && r.plan === "bpmi_monthly");
  const mvs = std && min ? (() => { const saving = std.monthly_cents - min.monthly_cents; return { monthly_saving_cents: saving, llpa_cents: min.llpa_cents, breakeven_months: saving > 0n ? Number(divHalfUp(min.llpa_cents, saving)) : null }; })() : null;
  return { rows, minimum_vs_standard: mvs, disclosure: PLAN_COMPARISON_DISCLOSURE };
}

// ============================================================ R6: financed single premium (B7-1-04)
export interface FinancedPlan { readonly financed_premium_cents: Cents; readonly note_amount_cents: Cents; readonly base_ltv_pct_rounded: number; readonly coverage_required_pct: number | null; readonly gross_ltv_pct_rounded: number; readonly max_ltv_pct: number; readonly loan_limit_cents: Cents; readonly eligible: true; readonly sfc_codes: readonly string[]; readonly mi_financed_indicator: true; readonly financed_mi_amount_cents: Cents; readonly pi_cents: Cents | null; readonly prepaids_line: string; }
/** Coverage on the base LTV, eligibility on the gross LTV and the loan limit; purchase / construction / limited cash-out only. */
export function financedSinglePremiumPlan(i: { loan_amount_cents: Cents; rate_bps: number; value_basis_cents: Cents; transaction_type: TransactionType; product: Product; term_months: number; homeready: boolean; standard_mh?: boolean; max_ltv_pct?: number; loan_limit_cents?: Cents; note_rate_pct?: string | null }): FinancedPlan {
  if (i.transaction_type === "cash_out") throw new MiRefused("FINANCED_MI_CASH_OUT", "B7-1-04: 'The loan purpose is purchase, construction, or limited cash-out refinance'", "a financed premium cannot be placed on a cash-out refinance");
  const financed = upfrontPremiumCents(i.loan_amount_cents, i.rate_bps); const note = i.loan_amount_cents + financed;
  const base = roundLtv(i.loan_amount_cents, i.value_basis_cents); const gross = roundLtv(note, i.value_basis_cents);
  const maxLtv = i.max_ltv_pct ?? 97; const limit = i.loan_limit_cents ?? LOAN_LIMIT_2026_1_UNIT_CENTS;
  if (gross.ltv_pct_rounded > maxLtv) throw new MiRefused("FINANCED_MI_OVER_MAX_LTV", "B7-1-04: the gross LTV 'may never exceed the LTV ratio allowed per the Eligibility Matrix'", `gross LTV ${gross.ltv_pct_rounded}% > ${maxLtv}%`);
  if (note > limit) throw new MiRefused("FINANCED_MI_OVER_LOAN_LIMIT", "B7-1-04: 'The loan amount including the financed mortgage insurance premium cannot exceed the applicable maximum Fannie Mae loan limit'", `note amount ${note} > limit ${limit}`);
  const cov = lookupCoverage({ ltv_pct_rounded: base.ltv_pct_rounded, product: i.product, term_months: i.term_months, homeready: i.homeready, ...(i.standard_mh !== undefined ? { standard_mh: i.standard_mh } : {}) });
  return { financed_premium_cents: financed, note_amount_cents: note, base_ltv_pct_rounded: base.ltv_pct_rounded, coverage_required_pct: cov.coverage_required_pct, gross_ltv_pct_rounded: gross.ltv_pct_rounded, max_ltv_pct: maxLtv, loan_limit_cents: limit, eligible: true, sfc_codes: [SFC_FINANCED_MI], mi_financed_indicator: true, financed_mi_amount_cents: financed,
    pi_cents: i.note_rate_pct ? levelPayment(note, ratePercent(i.note_rate_pct), i.term_months) : null, prepaids_line: `Mortgage Insurance Premium (${i.term_months} months)` };
}

// ============================================================ R5 / R11: HPA scope, initial schedule, dates
/** `hpa_covered = (units = 1) ∧ (occupancy = primary) ∧ (premium_plan ∉ lpmi_*)` — §4901(15) residential mortgage transaction; §4905(b) LPMI. */
export const hpaCovered = (i: { units: number; occupancy: Occupancy; premium_plan: PremiumPlan }): boolean => i.units === 1 && i.occupancy === "primary" && !isLpmi(i.premium_plan);
export interface InitialSchedule { readonly schedule: ScheduleVersion; readonly schedule_hash: string; readonly pi_cents: Cents; readonly note_amount_cents: Cents; readonly note_rate_pct: string; readonly term_months: number; readonly first_payment_due: PlainDate; }
export const scheduleHash = (rows: readonly ScheduleRow[]): string => createHash("sha256").update(rows.map((r) => `${r.n}|${r.due_date}|${r.payment_cents}|${r.interest_cents}|${r.principal_cents}|${r.upb_after_cents}`).join("\n")).digest("hex");
/** The immutable initial amortization schedule from the FINAL note terms (10.2's buildSchedule; interest half-up to cents each month). */
export function buildInitialAmortizationSchedule(i: { note_amount_cents: Cents; note_rate_pct: string; term_months: number; first_payment_due: PlainDate }): InitialSchedule {
  const schedule = buildSchedule({ upb_cents: i.note_amount_cents, annual_rate: ratePercent(i.note_rate_pct), term_months: i.term_months, first_due: i.first_payment_due }, "initial");
  return { schedule, schedule_hash: scheduleHash(schedule.rows), pi_cents: schedule.pi_cents, note_amount_cents: i.note_amount_cents, note_rate_pct: i.note_rate_pct, term_months: i.term_months, first_payment_due: i.first_payment_due };
}
export interface HpaDates { readonly original_value_cents: Cents; readonly threshold_80_cents: Cents; readonly threshold_78_cents: Cents; readonly cancellation_date: PlainDate | null; readonly cancellation_payment_n: number | null; readonly cancellation_balance_cents: Cents | null; readonly termination_date: PlainDate | null; readonly termination_payment_n: number | null; readonly termination_balance_cents: Cents | null; readonly amortization_start: PlainDate; readonly midpoint_date: PlainDate; readonly midpoint_termination_date: PlainDate; readonly lpmi_equiv_termination_date: PlainDate | null; readonly lpmi_options_notice_due: PlainDate | null; }
/** §4901(2)/(18)/(7) from the initial schedule: first scheduled balance ≤ 80% / ≤ 78% of original value; midpoint → first of the following month (§4902(c)). */
export function computeHpaDates(i: { schedule: ScheduleVersion; original_value_cents: Cents; term_months: number; first_payment_due: PlainDate }): HpaDates {
  const c = scheduledDateForPct(i.schedule, i.original_value_cents, 80), t = scheduledDateForPct(i.schedule, i.original_value_cents, 78); const m = midpoint(i.first_payment_due, i.term_months);
  return { original_value_cents: i.original_value_cents, threshold_80_cents: thresholdCents(i.original_value_cents, 80), threshold_78_cents: thresholdCents(i.original_value_cents, 78),
    cancellation_date: c?.due_date ?? null, cancellation_payment_n: c?.n ?? null, cancellation_balance_cents: c?.upb_after_cents ?? null, termination_date: t?.due_date ?? null, termination_payment_n: t?.n ?? null, termination_balance_cents: t?.upb_after_cents ?? null,
    amortization_start: m.amortization_start, midpoint_date: m.midpoint_date, midpoint_termination_date: m.midpoint_termination_date, lpmi_equiv_termination_date: t?.due_date ?? null, lpmi_options_notice_due: t ? lpmiOptionsNoticeDue(t.due_date) : null };
}
/** TRID §1026.37(c)(1)(i)(C): MI in every projected-payments column through the one containing the termination payment; a MI-free column from the next payment. */
export function projectedPaymentsMi(i: { termination_payment_n: number | null; monthly_premium_cents: Cents; term_months: number }): { columns: readonly { from_payment: number; to_payment: number; mi_cents: Cents }[]; mi_for_payment: (n: number) => Cents } {
  const last = i.termination_payment_n ?? i.term_months;
  const columns = last >= i.term_months ? [{ from_payment: 1, to_payment: i.term_months, mi_cents: i.monthly_premium_cents }] : [{ from_payment: 1, to_payment: last, mi_cents: i.monthly_premium_cents }, { from_payment: last + 1, to_payment: i.term_months, mi_cents: 0n }];
  return { columns, mi_for_payment: (n) => (n <= last ? i.monthly_premium_cents : 0n) };
}

// ============================================================ the certificate record and its state machine
export interface MiCertificate {
  readonly certificate_id: string; readonly application_id: string; readonly loan_id: string | null;
  readonly mi_company_code: string; readonly quote_id: string | null; readonly quote_rate_bps: number | null; readonly quote_received_at: string | null; readonly quote_expires_at: string | null;
  readonly order_type: "delegated" | "non_delegated" | null; readonly du_reliance: boolean; readonly du_casefile_id: string | null; readonly submitted_at: string | null;
  readonly commitment_number: string | null; readonly commitment_issued_at: string | null; readonly commitment_expires_at: string | null; readonly certificate_number: string | null;
  readonly coverage_pct: number; readonly coverage_option: CoverageOption; readonly llpa_min_coverage_bps: number | null; readonly election: { by: "borrower" | "partner"; recorded_at: string } | null;
  readonly premium_plan: PremiumPlan; readonly renewal_type: RenewalType; readonly premium_rate_bps: number; readonly monthly_premium_cents: Cents; readonly upfront_premium_cents: Cents; readonly financed_premium_cents: Cents; readonly refundable: boolean;
  readonly base_ltv_bps: number; readonly base_ltv_pct_rounded: number; readonly gross_ltv_pct_rounded: number | null; readonly property_value_basis_cents: Cents; readonly original_value_cents: Cents; readonly is_refinance: boolean;
  readonly units: number; readonly occupancy: Occupancy; readonly hpa_covered: boolean; readonly high_risk: boolean;
  readonly terms_verified_at: string | null; readonly hpa_disclosure_kind: HpaKind | "fnma_only" | null; readonly note_date: PlainDate | null;
  readonly activation_requested_at: string | null; readonly activated_at: string | null; readonly activation_effective_date: PlainDate | null; readonly first_premium_due_date: PlainDate | null; readonly remitted_at: string | null;
  readonly sfc_codes: readonly string[]; readonly status: MiStatus; readonly cancel_reason: string | null; readonly decline_reason: string | null;
}
const transition = (c: MiCertificate, from: readonly MiStatus[], to: MiStatus, what: string): void => { if (!from.includes(c.status)) throw new MiRefused("MI_STATE", "24.6 state machine", `${what}: certificate ${c.certificate_id} is ${c.status}, expected ${from.join("/")}`); void to; };

export interface QuoteRequest { readonly application_id: string; readonly loan_amount_cents: Cents; readonly quotes: readonly QuoteInput[]; readonly loan_id?: string | null; }
/** Quotes back from the insurers' adapters (idempotent by payload hash on their side): price each from its own rate; ≥ 2 insurers when available. */
export function receiveQuotes(events: EventStore, i: QuoteRequest, at: string, actor: Actor = AGENT_24_6): { quotes: MiQuote[]; insurers: string[]; event: DomainEvent } {
  if (!i.quotes.length) throw new RangeError("no quotes to record");
  for (const q of i.quotes) if (!isApprovedInsurer(q.mi_company_code)) throw new MiRefused("INSURER_NOT_APPROVED", "B7-1-01: insurers 'approved under Fannie Mae's Qualified Mortgage Insurer Approval Requirements' (July 2025 list)", `MI code ${q.mi_company_code} is not on the approved list`);
  const quotes = i.quotes.map((q) => priceQuote(i.application_id, i.loan_amount_cents, q));
  const insurers = [...new Set(quotes.map((q) => q.mi_company_code))];
  const event = emit(events, i.application_id, "mi.quote.received", { insurers, quote_ids: quotes.map((q) => q.quote_id), count: quotes.length, multiple_insurers: insurers.length >= 2 }, at, actor, i.loan_id ?? null);
  return { quotes, insurers, event };
}
export interface PlanSelection { readonly application_id: string; readonly quote: MiQuote; readonly election: { by: "borrower" | "partner"; recorded_at: string } | null; readonly llpa?: MinCoverageLlpa | null; readonly ltv: LtvComputation; readonly coverage: CoverageLookup; readonly units: number; readonly occupancy: Occupancy; readonly transaction_type: TransactionType; readonly loan_id?: string | null; readonly certificate_id?: string; }
/** The borrower's / partner's recorded election → `plan_selected`; the minimum option needs the recorded election AND its LLPA (guardrail). */
export function selectPlan(events: EventStore, i: PlanSelection, at: string, actor: Actor = AGENT_24_6): { certificate: MiCertificate; event: DomainEvent } {
  const q = i.quote;
  if (q.coverage_option === "minimum" && (!i.election || !i.llpa)) throw new MiRefused("MIN_COVERAGE_NEEDS_ELECTION_AND_LLPA", "24.6 guardrails: 'never select the minimum-coverage option without the recorded borrower/partner election and the LLPA in pricing'", "minimum coverage requires the recorded election and the LLPA passed to pricing");
  if (q.coverage_option === "minimum" && i.coverage.minimum_pct !== q.coverage_pct) throw new MiRefused("COVERAGE_BELOW_TABLE", "B7-1-02: 'no lower than minimum coverage'", `quoted ${q.coverage_pct}% ≠ minimum ${i.coverage.minimum_pct}%`);
  if (q.coverage_option === "standard" && i.coverage.standard_pct !== null && q.coverage_pct < i.coverage.standard_pct) throw new MiRefused("COVERAGE_BELOW_TABLE", "B7-1-02 standard coverage", `quoted ${q.coverage_pct}% < required ${i.coverage.standard_pct}%`);
  if (isLpmi(q.plan) && q.coverage_option === "minimum") throw new MiRefused("LPMI_STANDARD_ONLY", "24.6 verified requirement: 'default: standard coverage only for LPMI'", "LPMI is placed at standard coverage");
  const isRefi = i.transaction_type !== "purchase";
  const certificate: MiCertificate = { certificate_id: i.certificate_id ?? `mi-${i.application_id}-${q.mi_company_code}-${at.slice(0, 10)}`, application_id: i.application_id, loan_id: i.loan_id ?? null, mi_company_code: q.mi_company_code, quote_id: q.quote_id, quote_rate_bps: q.rate_bps, quote_received_at: q.quoted_at, quote_expires_at: q.expires_at,
    order_type: null, du_reliance: false, du_casefile_id: null, submitted_at: null, commitment_number: null, commitment_issued_at: null, commitment_expires_at: null, certificate_number: null,
    coverage_pct: q.coverage_pct, coverage_option: q.coverage_option, llpa_min_coverage_bps: q.coverage_option === "minimum" ? (i.llpa?.llpa_bps ?? null) : null, election: i.election,
    premium_plan: q.plan, renewal_type: q.renewal_type, premium_rate_bps: q.rate_bps, monthly_premium_cents: q.monthly_premium_cents, upfront_premium_cents: q.plan === "financed_single" ? 0n : q.upfront_premium_cents, financed_premium_cents: q.plan === "financed_single" ? q.upfront_premium_cents : 0n, refundable: q.refundable,
    base_ltv_bps: i.ltv.ltv_bps, base_ltv_pct_rounded: i.ltv.ltv_pct_rounded, gross_ltv_pct_rounded: i.ltv.gross_ltv_pct_rounded, property_value_basis_cents: i.ltv.value_basis_cents, original_value_cents: i.ltv.value_basis_cents, is_refinance: isRefi,
    units: i.units, occupancy: i.occupancy, hpa_covered: hpaCovered({ units: i.units, occupancy: i.occupancy, premium_plan: q.plan }), high_risk: false, terms_verified_at: null, hpa_disclosure_kind: null, note_date: null,
    activation_requested_at: null, activated_at: null, activation_effective_date: null, first_premium_due_date: null, remitted_at: null,
    sfc_codes: [...(isLpmi(q.plan) ? [SFC_LPMI] : []), ...(q.plan === "financed_single" ? [SFC_FINANCED_MI] : [])], status: "plan_selected", cancel_reason: null, decline_reason: null };
  const event = emit(events, i.application_id, "mi.plan.selected", { certificate_id: certificate.certificate_id, quote_id: q.quote_id, premium_plan: q.plan, coverage_option: q.coverage_option, coverage_pct: q.coverage_pct, mi_company_code: q.mi_company_code, llpa_min_coverage_bps: certificate.llpa_min_coverage_bps, election_by: i.election?.by ?? null, sfc_codes: certificate.sfc_codes, hpa_covered: certificate.hpa_covered }, at, actor, certificate.loan_id);
  return { certificate, event };
}
/** Delegated (DU Approve/Eligible + partner authority) or non-delegated (full package to the insurer's underwriter); the insurer must be on the approved list. */
export function submitOrder(events: EventStore, c: MiCertificate, i: { order_type: "delegated" | "non_delegated"; du_reliance: boolean; du_casefile_id: string | null; du_recommendation?: string | null }, at: string, actor: Actor = AGENT_24_6): { certificate: MiCertificate; event: DomainEvent; external_underwriter_followup: { role: "settlement_agent"; sla: "+2 business_days_creditor"; due: PlainDate } | null } {
  transition(c, ["plan_selected", "expired", "declined"], "ordered", "submitOrder");
  if (!isApprovedInsurer(c.mi_company_code)) throw new MiRefused("INSURER_NOT_APPROVED", "B7-1-01; 24.6 guardrails: 'never use an insurer absent from the approved list'", `MI code ${c.mi_company_code} is not on the July 2025 approved list`);
  if (i.order_type === "delegated" && i.du_reliance && i.du_recommendation !== undefined && i.du_recommendation !== null && i.du_recommendation !== "Approve/Eligible") throw new MiRefused("DELEGATED_NEEDS_DU_APPROVE_ELIGIBLE", "24.6 rule 8 / edge case: DU Approve/Eligible withdrawn → delegated order invalid", `DU recommendation ${i.du_recommendation} does not support a delegated order`);
  const certificate: MiCertificate = { ...c, order_type: i.order_type, du_reliance: i.du_reliance, du_casefile_id: i.du_casefile_id, submitted_at: at, status: "ordered" };
  const event = emit(events, c.application_id, "mi.ordered", { certificate_id: c.certificate_id, mi_company_code: c.mi_company_code, order_type: i.order_type, du_reliance: i.du_reliance, du_casefile_id: i.du_casefile_id, coverage_pct: c.coverage_pct, premium_plan: c.premium_plan }, at, actor, c.loan_id);
  return { certificate, event, external_underwriter_followup: i.order_type === "non_delegated" ? { role: "settlement_agent", sla: "+2 business_days_creditor", due: addBusinessDays(civilDate(at), 2, creditor) } : null };
}
export interface CommitmentRaw { readonly decision: "commitment" | "decline"; readonly commitment_number?: string | null; readonly certificate_number?: string | null; readonly coverage_pct?: number | string | null; readonly premium_plan?: string | null; readonly rate_bps?: number | string | null; readonly renewal_type?: string | null; readonly refundable?: boolean | null; readonly issued_at?: string | null; readonly expires_at?: string | null; readonly insurer_code?: string | null; readonly decline_reason?: string | null; readonly master_policy_version?: string | null; }
export interface ParsedCommitment { readonly decision: "commitment" | "decline"; readonly commitment_number: string | null; readonly certificate_number: string | null; readonly coverage_pct: number | null; readonly premium_plan: PremiumPlan | null; readonly rate_bps: number | null; readonly renewal_type: RenewalType | null; readonly refundable: boolean | null; readonly issued_at: string | null; readonly expires_at: string | null; readonly insurer_code: string | null; readonly decline_reason: string | null; readonly master_policy_version: string | null; }
/** Normalise the insurer's commitment / certificate response (vendor-specific fields → one shape). */
export function parseCommitment(raw: CommitmentRaw): ParsedCommitment {
  const num = (v: number | string | null | undefined): number | null => (v === undefined || v === null || v === "" ? null : Number(v));
  const plan = raw.premium_plan && PREMIUM_PLANS.includes(raw.premium_plan as PremiumPlan) ? (raw.premium_plan as PremiumPlan) : null;
  const renewal = raw.renewal_type === "constant" || raw.renewal_type === "declining" || raw.renewal_type === "level" ? raw.renewal_type : null;
  if (raw.decision === "commitment" && !raw.commitment_number) throw new RangeError("a commitment needs a commitment number");
  return { decision: raw.decision, commitment_number: raw.commitment_number ?? null, certificate_number: raw.certificate_number ?? null, coverage_pct: num(raw.coverage_pct), premium_plan: plan, rate_bps: num(raw.rate_bps), renewal_type: renewal, refundable: raw.refundable ?? null, issued_at: raw.issued_at ?? null, expires_at: raw.expires_at ?? null, insurer_code: raw.insurer_code ?? null, decline_reason: raw.decline_reason ?? null, master_policy_version: raw.master_policy_version ?? null };
}
/** Commitment → `committed` (+ `mi.certificate.issued` when the certificate number is on it); decline → `declined` with the underwriting_reviewer hand-off before any adverse action. */
export function receiveCommitment(events: EventStore, c: MiCertificate, p: ParsedCommitment, at: string, actor: Actor = AGENT_24_6): { certificate: MiCertificate; events: DomainEvent[]; escalation: { kind: "underwriting_reviewer"; reason: string } | null } {
  transition(c, ["ordered"], "committed", "receiveCommitment");
  if (p.decision === "decline") { const certificate: MiCertificate = { ...c, status: "declined", decline_reason: p.decline_reason ?? "insurer decline" }; return { certificate, events: [emit(events, c.application_id, "mi.declined", { certificate_id: c.certificate_id, mi_company_code: c.mi_company_code, reason: certificate.decline_reason }, at, actor, c.loan_id)], escalation: { kind: "underwriting_reviewer", reason: "MI declined (non-delegated) — review before any adverse action (21.6); alternative insurer allowed" } }; }
  if (p.insurer_code && p.insurer_code !== c.mi_company_code) throw new MiRefused("COMMITMENT_INSURER_MISMATCH", "24.6 state machine", `commitment from ${p.insurer_code}, order placed with ${c.mi_company_code}`);
  const certificate: MiCertificate = { ...c, commitment_number: p.commitment_number, commitment_issued_at: p.issued_at ?? at, commitment_expires_at: p.expires_at, certificate_number: p.certificate_number ?? c.certificate_number, coverage_pct: p.coverage_pct ?? c.coverage_pct, premium_plan: p.premium_plan ?? c.premium_plan, premium_rate_bps: p.rate_bps ?? c.premium_rate_bps, renewal_type: p.renewal_type ?? c.renewal_type, refundable: p.refundable ?? c.refundable, status: "committed" };
  const out = [emit(events, c.application_id, "mi.commitment.received", { certificate_id: c.certificate_id, mi_company_code: c.mi_company_code, commitment_number: p.commitment_number, commitment_expires_at: p.expires_at, coverage_pct: certificate.coverage_pct, premium_plan: certificate.premium_plan, master_policy_version: p.master_policy_version }, at, actor, c.loan_id)];
  if (certificate.certificate_number) out.push(emit(events, c.application_id, "mi.certificate.issued", { certificate_id: c.certificate_id, certificate_number: certificate.certificate_number, coverage_pct: certificate.coverage_pct, premium_plan: certificate.premium_plan }, at, actor, c.loan_id));
  return { certificate, events: out, escalation: null };
}
export interface FinalTerms { readonly loan_amount_cents: Cents; readonly value_basis_cents: Cents; readonly product: Product; readonly term_months: number; readonly homeready: boolean; readonly standard_mh?: boolean; readonly premium_plan_on_cd: PremiumPlan; readonly note_date: PlainDate; }
export interface CertificateCheck { readonly matches: boolean; readonly mismatches: readonly string[]; readonly required_coverage_pct: number | null; readonly final_ltv_pct_rounded: number; readonly sfc_codes: readonly string[]; readonly commitment_valid_at_note_date: boolean; }
/** Guard committed → docs_ready: coverage ≥ B7-1-02 for the FINAL LTV, plan = CD, SFCs computed, commitment unexpired at the note date, insurer approved. */
export function verifyCertificateMatchesTerms(c: MiCertificate, t: FinalTerms): CertificateCheck {
  const ltv = roundLtv(t.loan_amount_cents, t.value_basis_cents);
  const cov = lookupCoverage({ ltv_pct_rounded: ltv.ltv_pct_rounded, product: t.product, term_months: t.term_months, homeready: t.homeready, ...(t.standard_mh !== undefined ? { standard_mh: t.standard_mh } : {}), coverage_option: c.coverage_option });
  const mismatches: string[] = [];
  if (cov.coverage_required_pct !== null && c.coverage_pct < cov.coverage_required_pct) mismatches.push(`coverage ${c.coverage_pct}% < B7-1-02 requirement ${cov.coverage_required_pct}% at final LTV ${ltv.ltv_pct_rounded}%`);
  if (c.premium_plan !== t.premium_plan_on_cd) mismatches.push(`premium plan ${c.premium_plan} ≠ CD plan ${t.premium_plan_on_cd}`);
  if (!isApprovedInsurer(c.mi_company_code)) mismatches.push(`insurer ${c.mi_company_code} not on the approved list`);
  if (!["committed", "docs_ready"].includes(c.status)) mismatches.push(`status ${c.status} ∉ {committed, docs_ready}`);
  const valid = !c.commitment_expires_at || civilDate(c.commitment_expires_at) >= t.note_date;
  if (!valid) mismatches.push(`commitment expired ${c.commitment_expires_at} before the note date ${t.note_date}`);
  const sfc = [...(isLpmi(c.premium_plan) ? [SFC_LPMI] : []), ...(c.premium_plan === "financed_single" ? [SFC_FINANCED_MI] : [])];
  return { matches: mismatches.length === 0, mismatches, required_coverage_pct: cov.coverage_required_pct, final_ltv_pct_rounded: ltv.ltv_pct_rounded, sfc_codes: sfc, commitment_valid_at_note_date: valid };
}
const docsReady = (c: MiCertificate): boolean => c.terms_verified_at !== null && c.hpa_disclosure_kind !== null;
/** Record a passing verification; `docs_ready` once the HPA (or LPMI) disclosure is also on file. */
export function recordTermsVerified(c: MiCertificate, check: CertificateCheck, at: string, noteDate: PlainDate): MiCertificate {
  if (!check.matches) throw new MiRefused("CERTIFICATE_MISMATCH", "24.6 state machine guard committed → docs_ready", check.mismatches.join("; "));
  const next: MiCertificate = { ...c, terms_verified_at: at, sfc_codes: check.sfc_codes, note_date: noteDate };
  return docsReady(next) ? { ...next, status: "docs_ready" } : next;
}

// ---------------------------------------------------------------- R9 / T11: re-underwriting on a value change
export interface Revaluation { readonly value_basis_cents: Cents; readonly ltv: RoundedLtv; readonly old_coverage_required_pct: number | null; readonly new_coverage_required_pct: number | null; readonly band_changed: boolean; readonly requote_required: boolean; readonly reorder_required: boolean; readonly revised_le: { process: "21.5"; basis: "changed_circumstance"; reason: string } | null; readonly certificate: MiCertificate; readonly event: DomainEvent | null; }
/** Any change in loan amount / value basis / band → re-quote; a band change → revised LE (21.5) + re-order; the old certificate is `cancelled_pre_closing`. LTV ≤ 80% → MI no longer required. */
export function revalue(events: EventStore, c: MiCertificate, i: { loan_amount_cents: Cents; sales_price_cents?: Cents | null; appraised_value_cents: Cents; transaction_type: TransactionType; product: Product; term_months: number; homeready: boolean; standard_mh?: boolean }, at: string, actor: Actor = AGENT_24_6): Revaluation {
  const ltv = computeLtvRounded(i);
  const oldCov = lookupCoverage({ ltv_pct_rounded: c.base_ltv_pct_rounded, product: i.product, term_months: i.term_months, homeready: i.homeready, coverage_option: c.coverage_option });
  const newCov = lookupCoverage({ ltv_pct_rounded: ltv.ltv_pct_rounded, product: i.product, term_months: i.term_months, homeready: i.homeready, coverage_option: c.coverage_option });
  const bandChanged = oldCov.band !== newCov.band || oldCov.coverage_required_pct !== newCov.coverage_required_pct;
  const changed = bandChanged || ltv.value_basis_cents !== c.property_value_basis_cents || ltv.ltv_bps !== c.base_ltv_bps;
  if (!changed) return { value_basis_cents: ltv.value_basis_cents, ltv, old_coverage_required_pct: oldCov.coverage_required_pct, new_coverage_required_pct: newCov.coverage_required_pct, band_changed: false, requote_required: false, reorder_required: false, revised_le: null, certificate: c, event: null };
  const reason = !ltv.mi_required ? "LTV ≤ 80% after value change — MI no longer required" : bandChanged ? `coverage band changed ${oldCov.band} (${oldCov.coverage_required_pct}%) → ${newCov.band} (${newCov.coverage_required_pct}%)` : "value basis / LTV changed within the band";
  const cancel = bandChanged || !ltv.mi_required;
  const certificate: MiCertificate = cancel ? { ...c, status: "cancelled_pre_closing", cancel_reason: reason } : c;
  const event = cancel ? emit(events, c.application_id, "mi.cancelled_pre_closing", { certificate_id: c.certificate_id, reason, old_coverage_pct: oldCov.coverage_required_pct, new_coverage_pct: newCov.coverage_required_pct, new_ltv_pct_rounded: ltv.ltv_pct_rounded, value_basis_cents: ltv.value_basis_cents }, at, actor, c.loan_id) : null;
  return { value_basis_cents: ltv.value_basis_cents, ltv, old_coverage_required_pct: oldCov.coverage_required_pct, new_coverage_required_pct: newCov.coverage_required_pct, band_changed: bandChanged, requote_required: true, reorder_required: cancel, revised_le: bandChanged ? { process: "21.5", basis: "changed_circumstance", reason } : null, certificate, event };
}
/** Loan withdrawn / denied, or a re-order: the current certificate is cancelled before closing. */
export function cancelPreClosing(events: EventStore, c: MiCertificate, reason: string, at: string, actor: Actor = AGENT_24_6): { certificate: MiCertificate; event: DomainEvent } {
  if (c.status === "active" || c.status === "activation_requested") throw new MiRefused("MI_STATE", "24.6 state machine", "an activated certificate is cancelled through servicing (10.x), not pre-closing");
  return { certificate: { ...c, status: "cancelled_pre_closing", cancel_reason: reason }, event: emit(events, c.application_id, "mi.cancelled_pre_closing", { certificate_id: c.certificate_id, reason }, at, actor, c.loan_id) };
}
/** Commitment expired before a delayed closing → `expired` → re-order with the same insurer (new certificate number; HPA dates unchanged unless terms change). */
export function expireCommitment(events: EventStore, c: MiCertificate, at: string, actor: Actor = AGENT_24_6): { certificate: MiCertificate; event: DomainEvent } {
  if (!c.commitment_expires_at || civilDate(c.commitment_expires_at) >= civilDate(at)) throw new MiRefused("COMMITMENT_NOT_EXPIRED", "24.6 state machine", `commitment ${c.commitment_number} is valid until ${c.commitment_expires_at}`);
  return { certificate: { ...c, status: "expired" }, event: emit(events, c.application_id, "mi.certificate.expiring", { certificate_id: c.certificate_id, commitment_number: c.commitment_number, commitment_expires_at: c.commitment_expires_at, expired: true }, at, actor, c.loan_id) };
}

// ---------------------------------------------------------------- HPA disclosures (§4903 / §4905)
export interface HpaDisclosure { readonly disclosure_id: string; readonly application_id: string; readonly certificate_id: string; readonly kind: HpaKind; readonly notice_code: string; readonly notice_id: string | null; readonly amortization_schedule_document_id: string | null; readonly schedule_hash: string | null; readonly schedule_version: "initial"; readonly cancellation_date: PlainDate | null; readonly termination_date: PlainDate | null; readonly midpoint_termination_date: PlainDate; readonly original_value_cents: Cents; readonly rendered_at: string; readonly delivered_at: string | null; readonly payload: Record<string, unknown>; }
export interface HpaRenderInput { readonly product: Product; readonly initial: InitialSchedule; readonly dates: HpaDates; readonly partner_name: string; readonly borrower_name: string; readonly property_address: string; readonly loan_number?: string | null; readonly notice_id?: string | null; readonly amortization_schedule_document_id?: string | null; }
export type HpaRenderResult = { rendered: true; variant: "initial_fixed" | "initial_arm"; disclosure: HpaDisclosure; certificate: MiCertificate; event: DomainEvent } | { rendered: false; variant: "none_lpmi" | "fnma_only"; reason: string; certificate: MiCertificate; fnma_only_payload: Record<string, unknown> | null; event: DomainEvent | null };
/** §4903(a)(1): fixed → the initial amortization schedule + notice; ARM → notice. LPMI → nothing (§4905(b)); not HPA-covered → the Fannie Mae-only (B-8.1-04 midpoint) variant. Never from anything but the FINAL note terms. */
export function renderHpaDisclosure(events: EventStore, c: MiCertificate, i: HpaRenderInput, at: string, actor: Actor = AGENT_24_6): HpaRenderResult {
  if (isLpmi(c.premium_plan)) return { rendered: false, variant: "none_lpmi", reason: "12 U.S.C. 4905(b): §§4902–4904 do not apply to lender-paid MI — no §4903 initial disclosure", certificate: c, fnma_only_payload: null, event: null };
  if (c.terms_verified_at === null) throw new MiRefused("HPA_SCHEDULE_NEEDS_FINAL_TERMS", "24.6 guardrails: 'never render an HPA schedule from anything but the final note terms'", "verify the certificate against the final terms (verifyCertificateMatchesTerms) before rendering");
  const d = i.dates;
  if (!c.hpa_covered) {
    const payload = { variant: "fnma_only", basis: "Fannie Mae Servicing Guide B-8.1-04", units: c.units, occupancy: c.occupancy, midpoint_termination_date: d.midpoint_termination_date, scheduled_78_date: d.termination_date, auto_status: "not_applicable_midpoint_only", section_4903_content: false };
    const certificate: MiCertificate = { ...c, hpa_disclosure_kind: "fnma_only", status: c.terms_verified_at ? "docs_ready" : c.status };
    return { rendered: false, variant: "fnma_only", reason: "12 U.S.C. 4901(15): not a residential mortgage transaction (second home / investment / 2–4 units) — Fannie Mae B-8.1-04 rules only", certificate, fnma_only_payload: payload, event: emit(events, c.application_id, "hpa.initial_disclosure.rendered", { certificate_id: c.certificate_id, kind: "fnma_only", hpa_covered: false, midpoint_termination_date: d.midpoint_termination_date }, at, actor, c.loan_id) };
  }
  const kind: HpaKind = i.product === "fixed" ? "initial_fixed" : "initial_arm";
  const rows = i.initial.schedule.rows;
  const payload: Record<string, unknown> = { partner_name: i.partner_name, borrower_name: i.borrower_name, property_address: i.property_address, loan_number: i.loan_number ?? null, consummation_date: c.note_date, original_value_cents: d.original_value_cents, note_amount_cents: i.initial.note_amount_cents, note_rate_pct: i.initial.note_rate_pct, term_months: i.initial.term_months, pi_cents: i.initial.pi_cents, first_payment_due: i.initial.first_payment_due,
    cancellation_date: d.cancellation_date, termination_date: d.termination_date, midpoint_termination_date: d.midpoint_termination_date, threshold_80_cents: d.threshold_80_cents, threshold_78_cents: d.threshold_78_cents, high_risk: c.high_risk, premium_plan: c.premium_plan, monthly_premium_cents: c.monthly_premium_cents,
    ...(kind === "initial_fixed" ? { schedule_rows: rows.length, schedule_hash: i.initial.schedule_hash, schedule: rows.map((r) => ({ n: r.n, due_date: r.due_date, payment_cents: r.payment_cents, interest_cents: r.interest_cents, principal_cents: r.principal_cents, upb_after_cents: r.upb_after_cents })) } : {}) };
  const disclosure: HpaDisclosure = { disclosure_id: `hpa-${c.certificate_id}-${kind}`, application_id: c.application_id, certificate_id: c.certificate_id, kind, notice_code: kind === "initial_fixed" ? NTC_HPA_4903_INITIAL_FIXED : NTC_HPA_4903_INITIAL_ARM, notice_id: i.notice_id ?? null, amortization_schedule_document_id: kind === "initial_fixed" ? (i.amortization_schedule_document_id ?? null) : null, schedule_hash: kind === "initial_fixed" ? i.initial.schedule_hash : null, schedule_version: "initial",
    cancellation_date: d.cancellation_date, termination_date: d.termination_date, midpoint_termination_date: d.midpoint_termination_date, original_value_cents: d.original_value_cents, rendered_at: at, delivered_at: null, payload };
  const certificate: MiCertificate = { ...c, hpa_disclosure_kind: kind, status: c.status === "committed" && c.terms_verified_at ? "docs_ready" : c.status };
  const event = emit(events, c.application_id, "hpa.initial_disclosure.rendered", { certificate_id: c.certificate_id, disclosure_id: disclosure.disclosure_id, kind, notice_code: disclosure.notice_code, cancellation_date: d.cancellation_date, termination_date: d.termination_date, midpoint_termination_date: d.midpoint_termination_date, schedule_hash: disclosure.schedule_hash, schedule_rows: kind === "initial_fixed" ? rows.length : 0 }, at, actor, c.loan_id);
  return { rendered: true, variant: kind, disclosure, certificate, event };
}
/** Delivery "at the time at which the transaction is consummated": delivered_at = consummation_at (closing package, paper or electronic per the E-SIGN `closing` scope). */
export function deliverHpaDisclosure(events: EventStore, d: HpaDisclosure, consummationAt: string, actor: Actor = AGENT_24_6, loanId?: string | null): { disclosure: HpaDisclosure; event: DomainEvent } {
  if (d.kind === "lpmi_commitment") throw new RangeError("the LPMI disclosure is delivered at commitment (renderLpmiDisclosure)");
  const disclosure: HpaDisclosure = { ...d, delivered_at: consummationAt };
  return { disclosure, event: emit(events, d.application_id, "hpa.initial_disclosure.delivered", { certificate_id: d.certificate_id, disclosure_id: d.disclosure_id, kind: d.kind, delivered_at: consummationAt, consummation_at: consummationAt }, consummationAt, actor, loanId ?? null) };
}
export interface LpmiRenderInput { readonly delivered_at: string; readonly commitment_letter_issued_at?: string | null; readonly dates: HpaDates; readonly partner_name: string; readonly borrower_name: string; readonly property_address: string; readonly lpmi_rate_adjustment_pct?: string | null; readonly notice_id?: string | null; }
/** §4905(c): the LPMI disclosure "not later than the date on which a loan commitment is made" — platform anchor: delivered with / before the conditional-approval letter (24.6-Q3). SFC 019. */
export function renderLpmiDisclosure(events: EventStore, c: MiCertificate, i: LpmiRenderInput, actor: Actor = AGENT_24_6): { disclosure: HpaDisclosure; certificate: MiCertificate; event: DomainEvent } {
  if (!isLpmi(c.premium_plan)) throw new MiRefused("NOT_LPMI", "12 U.S.C. 4905(a)", `premium plan ${c.premium_plan} is borrower-paid — the §4903 initial disclosure applies instead`);
  if (i.commitment_letter_issued_at && i.commitment_letter_issued_at < i.delivered_at) throw new MiRefused("LPMI_DISCLOSURE_AFTER_COMMITMENT", "12 U.S.C. 4905(c)(1): 'not later than the date on which a loan commitment is made'", `commitment letter issued ${i.commitment_letter_issued_at} before the LPMI disclosure ${i.delivered_at} — treat the plan change as a new commitment delivered after the disclosure`);
  const payload: Record<string, unknown> = { partner_name: i.partner_name, borrower_name: i.borrower_name, property_address: i.property_address, delivered_on: civilDate(i.delivered_at), premium_plan: c.premium_plan, lpmi_rate_adjustment_pct: i.lpmi_rate_adjustment_pct ?? null, lpmi_equiv_termination_date: i.dates.lpmi_equiv_termination_date, midpoint_termination_date: i.dates.midpoint_termination_date, original_value_cents: i.dates.original_value_cents };
  const disclosure: HpaDisclosure = { disclosure_id: `hpa-${c.certificate_id}-lpmi_commitment`, application_id: c.application_id, certificate_id: c.certificate_id, kind: "lpmi_commitment", notice_code: NTC_HPA_4905_LPMI, notice_id: i.notice_id ?? null, amortization_schedule_document_id: null, schedule_hash: null, schedule_version: "initial", cancellation_date: null, termination_date: i.dates.lpmi_equiv_termination_date, midpoint_termination_date: i.dates.midpoint_termination_date, original_value_cents: i.dates.original_value_cents, rendered_at: i.delivered_at, delivered_at: i.delivered_at, payload };
  const certificate: MiCertificate = { ...c, hpa_disclosure_kind: "lpmi_commitment", sfc_codes: c.sfc_codes.includes(SFC_LPMI) ? c.sfc_codes : [...c.sfc_codes, SFC_LPMI], status: c.status === "committed" && c.terms_verified_at ? "docs_ready" : c.status };
  const event = emit(events, c.application_id, "hpa.lpmi_disclosure.delivered", { certificate_id: c.certificate_id, disclosure_id: disclosure.disclosure_id, notice_code: NTC_HPA_4905_LPMI, delivered_at: i.delivered_at, lpmi_equiv_termination_date: i.dates.lpmi_equiv_termination_date, sfc_codes: certificate.sfc_codes }, i.delivered_at, actor, c.loan_id);
  return { disclosure, certificate, event };
}

// ---------------------------------------------------------------- R10: activation and premium flow
export const activationDeadline = (noteDate: PlainDate): PlainDate => addBusinessDays(noteDate, 1, creditor);
/** Activation request at the note date (`closing.consummated`; `loan.funded` in dry states) — never before it, never on an expired commitment. */
export function requestActivation(events: EventStore, c: MiCertificate, i: { note_date: PlainDate; loan_id?: string | null }, at: string, actor: Actor = AGENT_24_6): { certificate: MiCertificate; event: DomainEvent; confirm_by: PlainDate } {
  transition(c, ["docs_ready", "committed"], "activation_requested", "requestActivation");
  if (civilDate(at) < i.note_date) throw new MiRefused("ACTIVATE_BEFORE_NOTE_DATE", "24.6 guardrails: 'never activate before the note date'", `activation requested ${at} before the note date ${i.note_date}`);
  if (c.commitment_expires_at && civilDate(c.commitment_expires_at) < i.note_date) throw new MiRefused("COMMITMENT_EXPIRED", "SM_MI_COMMITMENT_EXPIRY_GATE: consummation ≤ commitment expiry", `commitment expired ${c.commitment_expires_at} before the note date ${i.note_date} — re-order`);
  const loanId = i.loan_id ?? c.loan_id;
  const certificate: MiCertificate = { ...c, loan_id: loanId, note_date: i.note_date, activation_requested_at: at, status: "activation_requested" };
  const event = emit(events, c.application_id, "mi.activation.requested", { certificate_id: c.certificate_id, mi_company_code: c.mi_company_code, certificate_number: c.certificate_number, note_date: i.note_date, confirm_by: activationDeadline(i.note_date) }, at, actor, loanId);
  return { certificate, event, confirm_by: activationDeadline(i.note_date) };
}
/** Insurer confirmation: effective on the note date → `active` (terminal for origination; boarded to 10.1). */
export function confirmActivation(events: EventStore, c: MiCertificate, i: { activation_effective_date: PlainDate; certificate_number?: string | null; first_premium_due_date?: PlainDate | null }, at: string, actor: Actor = AGENT_24_6): { certificate: MiCertificate; event: DomainEvent } {
  transition(c, ["activation_requested"], "active", "confirmActivation");
  if (c.note_date && i.activation_effective_date !== c.note_date) throw new MiRefused("ACTIVATION_DATE_NOT_NOTE_DATE", "24.6 state machine: `active` requires `activation_effective_date = note date`", `insurer effective date ${i.activation_effective_date} ≠ note date ${c.note_date}`);
  const certificate: MiCertificate = { ...c, activated_at: at, activation_effective_date: i.activation_effective_date, certificate_number: i.certificate_number ?? c.certificate_number, first_premium_due_date: i.first_premium_due_date ?? c.first_premium_due_date, status: "active" };
  if (!certificate.certificate_number) throw new MiRefused("ACTIVATION_WITHOUT_CERTIFICATE_NUMBER", "B7-1-01: the lender must 'obtain and be able to produce evidence' of MI", "no certificate number on the activation confirmation");
  const event = emit(events, c.application_id, "mi.activated", { certificate_id: c.certificate_id, mi_company_code: c.mi_company_code, certificate_number: certificate.certificate_number, activation_effective_date: i.activation_effective_date, coverage_pct: c.coverage_pct, premium_plan: c.premium_plan, activated_at: at }, at, actor, certificate.loan_id);
  return { certificate, event };
}
/** Upfront (single / split) premiums remitted by SM within the master-policy window (10 calendar days from funding, 24.6-Q5); LPMI as the partner's corporate obligation. Monthly BPMI has nothing to remit at closing (10.x from the first payment). */
export function remitPremium(events: EventStore, c: MiCertificate, i: { remitted_at: string; amount_cents?: Cents | null; funded_on?: PlainDate | null }, actor: Actor = AGENT_24_6): { certificate: MiCertificate; event: DomainEvent; amount_cents: Cents; ledger_bucket: "third_party_costs" | "escrow_initial_deposit" | null } {
  const due = c.upfront_premium_cents + c.financed_premium_cents;
  const amount = i.amount_cents ?? (isLpmi(c.premium_plan) && c.premium_plan === "lpmi_monthly" ? c.monthly_premium_cents : due);
  if (amount <= 0n) throw new MiRefused("NOTHING_TO_REMIT", "24.6 rule 10: monthly BPMI — no premium at closing; the first premium is due with the first payment (10.x)", `premium plan ${c.premium_plan} has no upfront premium to remit`);
  if (!["active", "activation_requested"].includes(c.status)) throw new MiRefused("MI_STATE", "24.6 rule 10", `premium remitted only after activation is requested (status ${c.status})`);
  const certificate: MiCertificate = { ...c, remitted_at: i.remitted_at };
  const event = emit(events, c.application_id, "mi.premium.remitted", { certificate_id: c.certificate_id, mi_company_code: c.mi_company_code, amount_cents: amount, premium_plan: c.premium_plan, remitted_at: i.remitted_at, funded_on: i.funded_on ?? null, obligor: isLpmi(c.premium_plan) ? "partner_corporate" : c.premium_plan === "financed_single" ? "borrower_financed" : "borrower" }, i.remitted_at, actor, c.loan_id);
  return { certificate, event, amount_cents: amount, ledger_bucket: isLpmi(c.premium_plan) ? "third_party_costs" : c.premium_plan === "bpmi_monthly" ? "escrow_initial_deposit" : null };
}

// ---------------------------------------------------------------- 30.4 → 10.1 seed
export interface MiPolicySeed { readonly loan_id: string; readonly application_id: string; readonly insurer_code: string; readonly insurer_name: string; readonly certificate_number: string; readonly coverage_pct: number; readonly premium_plan: PremiumPlan; readonly renewal_type: RenewalType; readonly premium_rate_bps: number; readonly premium_amount_cents: Cents; readonly refundable: boolean; readonly hpa_covered: boolean; readonly sales_price_cents: Cents | null; readonly appraised_value_cents: Cents | null; readonly is_refinance: boolean; readonly original_value_cents: Cents; readonly occupancy_at_origination: "principal" | "second_home" | "investment"; readonly units: number; readonly consummation_date: PlainDate; readonly amortization_start: PlainDate; readonly amortization_term_months: number; readonly midpoint_date: PlainDate; readonly midpoint_termination_date: PlainDate; readonly scheduled_80_date: PlainDate | null; readonly scheduled_78_date: PlainDate | null; readonly auto_status: "pending" | "not_applicable_midpoint_only"; readonly lpmi_equiv_termination_date: PlainDate | null; readonly schedule_basis: "initial"; readonly schedule_hash: string | null; readonly sfc_codes: readonly string[]; readonly financed_mi_amount_cents: Cents; readonly mi_financed_indicator: boolean; readonly hpa_disclosure_kind: MiCertificate["hpa_disclosure_kind"]; readonly first_premium_due_date: PlainDate | null; }
/** The `mi_policies` (10.1) payload 30.4 boards from the certificate: HPA dates from the same schedule, `not_applicable_midpoint_only` for non-HPA loans, `lpmi_equiv_termination_date` for LPMI. */
export function seedMiPolicy(c: MiCertificate, i: { loan_id: string; dates: HpaDates; term_months: number; sales_price_cents?: Cents | null; appraised_value_cents?: Cents | null; schedule_hash?: string | null; consummation_date?: PlainDate | null }): MiPolicySeed {
  if (c.status !== "active" && c.status !== "activation_requested") throw new MiRefused("SEED_NEEDS_ACTIVATION", "24.6 guardrails: 'never … deliver without `active`'; 30.2 OB-009", `certificate ${c.certificate_id} is ${c.status}`);
  if (!c.certificate_number) throw new MiRefused("SEED_NEEDS_CERTIFICATE_NUMBER", "30.2 OB-009", "no certificate number");
  const consummation = i.consummation_date ?? c.note_date; if (!consummation) throw new RangeError("consummation / note date unknown");
  const lpmi = isLpmi(c.premium_plan);
  return { loan_id: i.loan_id, application_id: c.application_id, insurer_code: c.mi_company_code, insurer_name: insurerName(c.mi_company_code) ?? c.mi_company_code, certificate_number: c.certificate_number, coverage_pct: c.coverage_pct, premium_plan: c.premium_plan, renewal_type: c.renewal_type, premium_rate_bps: c.premium_rate_bps, premium_amount_cents: c.monthly_premium_cents > 0n ? c.monthly_premium_cents : c.upfront_premium_cents + c.financed_premium_cents, refundable: c.refundable,
    hpa_covered: c.hpa_covered, sales_price_cents: i.sales_price_cents ?? null, appraised_value_cents: i.appraised_value_cents ?? null, is_refinance: c.is_refinance, original_value_cents: c.original_value_cents, occupancy_at_origination: c.occupancy === "primary" ? "principal" : c.occupancy, units: c.units, consummation_date: consummation,
    amortization_start: i.dates.amortization_start, amortization_term_months: i.term_months, midpoint_date: i.dates.midpoint_date, midpoint_termination_date: i.dates.midpoint_termination_date, scheduled_80_date: c.hpa_covered ? i.dates.cancellation_date : null, scheduled_78_date: c.hpa_covered ? i.dates.termination_date : null,
    auto_status: c.hpa_covered ? "pending" : "not_applicable_midpoint_only", lpmi_equiv_termination_date: lpmi ? i.dates.lpmi_equiv_termination_date : null, schedule_basis: "initial", schedule_hash: i.schedule_hash ?? null, sfc_codes: c.sfc_codes, financed_mi_amount_cents: c.financed_premium_cents, mi_financed_indicator: c.financed_premium_cents > 0n, hpa_disclosure_kind: c.hpa_disclosure_kind, first_premium_due_date: c.first_premium_due_date };
}

// ============================================================ gates (pure; evaluators-24-6.ts adapts the facts)
export interface GateResult { readonly open: boolean; readonly reason?: string; }
const ok: GateResult = { open: true }; const no = (reason: string): GateResult => ({ open: false, reason });
export interface GateFacts { readonly status?: string | null; readonly coverage_pct?: number | null; readonly required_coverage_pct?: number | null; readonly mi_company_code?: string | null; readonly commitment_expires_at?: string | null; readonly consummation_on?: PlainDate | null; readonly premium_plan?: PremiumPlan | null; readonly hpa_covered?: boolean | null; readonly hpa_disclosure_kind?: string | null; readonly hpa_rendered?: boolean | null; readonly schedule_hash?: string | null; readonly delivered_at?: string | null; readonly consummation_at?: string | null; readonly lpmi_disclosure_delivered_at?: string | null; readonly commitment_letter_issued_at?: string | null; readonly certificate_number?: string | null; readonly mi_required?: boolean | null; readonly uldd_mi_data_complete?: boolean | null; }
/** FNMA_B7_1_01_MI_COMMITMENT_BEFORE_DOCS_GATE: status ∈ {committed, docs_ready, activation_requested, active}, coverage ≥ B7-1-02 for the final LTV, insurer approved. */
export function miCommitmentBeforeDocsGate(f: GateFacts): GateResult {
  if (f.mi_required === false) return ok;
  if (!["committed", "docs_ready", "activation_requested", "active"].includes(f.status ?? "")) return no(`doc generation (26.1) refused: MI status ${f.status ?? "none"} ∉ {committed, docs_ready}`);
  if (f.required_coverage_pct !== undefined && f.required_coverage_pct !== null && (f.coverage_pct ?? 0) < f.required_coverage_pct) return no(`doc generation (26.1) refused: coverage ${f.coverage_pct}% < B7-1-02 requirement ${f.required_coverage_pct}% for the final LTV`);
  if (f.mi_company_code && !isApprovedInsurer(f.mi_company_code)) return no(`doc generation (26.1) refused: insurer ${f.mi_company_code} not on the approved list`);
  return ok;
}
/** SM_MI_COMMITMENT_EXPIRY_GATE: consummation ≤ commitment expiry, else re-order and `consummate` refused. */
export function miCommitmentExpiryGate(f: GateFacts): GateResult {
  if (f.mi_required === false) return ok;
  if (!f.commitment_expires_at) return no("consummate refused: no MI commitment on file (re-order)");
  if (f.consummation_on && civilDate(f.commitment_expires_at) < f.consummation_on) return no(`consummate refused: MI commitment expired ${civilDate(f.commitment_expires_at)} before consummation ${f.consummation_on} — re-order`);
  return ok;
}
/** HPA_4903_INITIAL_DISCLOSURE_GATE: BPMI + hpa_covered → initial_fixed/initial_arm rendered from the immutable initial schedule and delivered at consummation (delivered_at = consummation_at). */
export function hpaInitialDisclosureGate(f: GateFacts): GateResult {
  if (f.mi_required === false || (f.premium_plan && isLpmi(f.premium_plan)) || f.hpa_covered === false) return ok;
  if (!f.hpa_rendered || !["initial_fixed", "initial_arm"].includes(f.hpa_disclosure_kind ?? "")) return no("consummate refused: no HPA §4903 initial disclosure rendered (initial_fixed / initial_arm with the immutable initial amortization schedule)");
  if (f.hpa_disclosure_kind === "initial_fixed" && !f.schedule_hash) return no("consummate refused: the fixed-rate initial disclosure carries no initial amortization schedule (§4903(a)(1)(A)(i))");
  if (f.consummation_at !== undefined && f.consummation_at !== null) { if (!f.delivered_at) return no("consummate refused: HPA initial disclosure not delivered at consummation"); if (f.delivered_at !== f.consummation_at) return no(`consummate refused: disclosures.delivered_at ${f.delivered_at} ≠ consummation_at ${f.consummation_at}`); }
  return ok;
}
/** HPA_4905C_LPMI_DISCLOSURE_GATE: for lpmi_* plans NTC_HPA_4905_LPMI delivered no later than the commitment / approval letter. */
export function lpmiDisclosureGate(f: GateFacts): GateResult {
  if (!f.premium_plan || !isLpmi(f.premium_plan)) return ok;
  if (!f.lpmi_disclosure_delivered_at) return no("approval/commitment letter refused: NTC_HPA_4905_LPMI not delivered (12 U.S.C. 4905(c): not later than the date on which a loan commitment is made)");
  if (f.commitment_letter_issued_at && f.commitment_letter_issued_at < f.lpmi_disclosure_delivered_at) return no(`approval/commitment letter refused: commitment ${f.commitment_letter_issued_at} precedes the LPMI disclosure ${f.lpmi_disclosure_delivered_at}`);
  return ok;
}
/** FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE: status = active with MI data (company code, certificate, coverage %, premium plan) for the ULDD. */
export function miActiveBeforeDeliveryGate(f: GateFacts): GateResult {
  if (f.mi_required === false) return ok;
  if (f.status !== "active") return no(`submitDelivery refused: MI status ${f.status ?? "none"} ≠ active`);
  if (!f.certificate_number || !f.mi_company_code || f.coverage_pct === undefined || f.coverage_pct === null || !f.premium_plan) return no("submitDelivery refused: MI data (company code, certificate number, coverage %, premium plan) incomplete for the ULDD");
  if (f.uldd_mi_data_complete === false) return no("submitDelivery refused: MI data points not mapped into the ULDD (29.3)");
  return ok;
}
export const GATES_24_6 = { FNMA_B7_1_01_MI_COMMITMENT_BEFORE_DOCS_GATE: miCommitmentBeforeDocsGate, SM_MI_COMMITMENT_EXPIRY_GATE: miCommitmentExpiryGate, HPA_4903_INITIAL_DISCLOSURE_GATE: hpaInitialDisclosureGate, HPA_4905C_LPMI_DISCLOSURE_GATE: lpmiDisclosureGate, FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE: miActiveBeforeDeliveryGate } as const;
/** Every 24.6 gate over one fact set; `consummate` / `generateDocs` / `submitDelivery` read the codes that concern them. */
export function evaluateGates(f: GateFacts, only?: readonly (keyof typeof GATES_24_6)[]): { all_open: boolean; results: Record<string, GateResult>; closed: string[] } {
  const codes = only ?? (Object.keys(GATES_24_6) as (keyof typeof GATES_24_6)[]);
  const results: Record<string, GateResult> = {}; for (const code of codes) results[code] = GATES_24_6[code](f);
  const closed = codes.filter((c) => !results[c]!.open);
  return { all_open: closed.length === 0, results, closed };
}
export const gateFactsOf = (c: MiCertificate | null, extra: Partial<GateFacts> = {}, disclosure?: HpaDisclosure | null): GateFacts & Record<string, unknown> => ({
  status: c?.status ?? null, coverage_pct: c?.coverage_pct ?? null, mi_company_code: c?.mi_company_code ?? null, commitment_expires_at: c?.commitment_expires_at ?? null, premium_plan: c?.premium_plan ?? null, hpa_covered: c?.hpa_covered ?? null, hpa_disclosure_kind: c?.hpa_disclosure_kind ?? null,
  hpa_rendered: !!disclosure, schedule_hash: disclosure?.schedule_hash ?? null, delivered_at: disclosure?.delivered_at ?? null, certificate_number: c?.certificate_number ?? null, lpmi_disclosure_delivered_at: disclosure?.kind === "lpmi_commitment" ? disclosure.delivered_at : null, ...extra });

// ============================================================ decision record
export interface DecisionRecord24_6 { readonly application_id: string; readonly ltv_raw: string; readonly ltv_rounded: number; readonly gross_ltv_rounded: number | null; readonly coverage_required_pct: number | null; readonly coverage_option: CoverageOption; readonly llpa_bps: number | null; readonly quotes: readonly { insurer: string; plan: PremiumPlan; rate_bps: number; premium: Cents }[]; readonly election: { by: "borrower" | "partner"; recorded_at: string } | null; readonly order: { type: string | null; du_reliance: boolean; casefile_id: string | null }; readonly certificate: { number: string | null; coverage_pct: number; expires: string | null }; readonly hpa: { original_value: Cents; cancellation_date: PlainDate | null; termination_date: PlainDate | null; midpoint: PlainDate | null }; readonly gates: Record<string, GateResult>; readonly rationale: string; readonly rule_set_version: string; readonly model_version: string; readonly prompt_version: string; readonly confidence: number; }
export function writeDecision(i: { certificate: MiCertificate; ltv: LtvComputation; coverage: CoverageLookup; llpa?: MinCoverageLlpa | null; quotes: readonly MiQuote[]; dates?: HpaDates | null; gates: Record<string, GateResult>; model_version: string; prompt_version: string; confidence?: number; rationale?: string }): DecisionRecord24_6 {
  const c = i.certificate;
  const rationale = i.rationale ?? `LTV ${i.ltv.ltv_raw} → truncated ${i.ltv.ltv_trunc2} → rounded ${i.ltv.ltv_pct_rounded}% (B2-1.2-01), band ${i.ltv.band ?? "≤ 80%"}, ${i.coverage.row} → ${i.coverage.coverage_option} coverage ${i.coverage.coverage_required_pct ?? "n/a"}% (B7-1-02)${i.llpa ? `, minimum-coverage LLPA ${i.llpa.llpa_pct}% (${i.llpa.grid} ${i.llpa.row_label})` : ""}; ${i.quotes.length} quote(s) from ${new Set(i.quotes.map((q) => q.mi_company_code)).size} insurer(s); plan ${c.premium_plan} with ${c.mi_company_code}; status ${c.status}${i.dates ? `; HPA cancellation ${i.dates.cancellation_date}, termination ${i.dates.termination_date}, midpoint ${i.dates.midpoint_termination_date}` : ""}.`;
  return { application_id: c.application_id, ltv_raw: i.ltv.ltv_raw, ltv_rounded: i.ltv.ltv_pct_rounded, gross_ltv_rounded: i.ltv.gross_ltv_pct_rounded, coverage_required_pct: i.coverage.coverage_required_pct, coverage_option: c.coverage_option, llpa_bps: c.llpa_min_coverage_bps, quotes: i.quotes.map((q) => ({ insurer: q.mi_company_code, plan: q.plan, rate_bps: q.rate_bps, premium: q.premium_cents })), election: c.election, order: { type: c.order_type, du_reliance: c.du_reliance, casefile_id: c.du_casefile_id }, certificate: { number: c.certificate_number, coverage_pct: c.coverage_pct, expires: c.commitment_expires_at },
    hpa: { original_value: c.original_value_cents, cancellation_date: i.dates?.cancellation_date ?? null, termination_date: i.dates?.termination_date ?? null, midpoint: i.dates?.midpoint_termination_date ?? null }, gates: i.gates, rationale, rule_set_version: `${RULE_SET_SELLING}+${RULE_SET_LLPA}+${RULE_SET_LIMITS}`, model_version: i.model_version, prompt_version: i.prompt_version, confidence: i.confidence ?? 0.99 };
}
