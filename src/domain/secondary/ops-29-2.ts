/**
 * §29.2 Pipeline and interest-rate-risk management — the `secondary` agent's pure rules over `pipeline_positions`,
 * `pull_through_models` / `pull_through_estimates`, `fallout_events`, `hedge_positions` (0103) with `hedge_trades`,
 * `mark_to_market_runs`, `rate_shock_reports`, `margin_calls` and `hedge_policies` (migration 0104). One small function
 * per rule / T-id; `PipelineService` is the runtime service `secondary_pipeline` that the section29-2 tools call. It
 * reuses 29.1 (ops-29-1.ts): the `fannie_sifma` calendar, ET wall-clock helpers, the mandatory pair-off / extension
 * arithmetic (C2-1.1-04) and the best-efforts extension carry; 20.4's quote supplies the lock's base price; 21.4's
 * `lock.*` events and 29.1's `commitment.*` events drive the per-lock exposure state.
 *
 * Money in cents (bigint); prices in percent of par to 3 dp (5 dp as stored); probabilities and durations to 4 dp;
 * rounding half-up to cents at each dollar conversion (spec "Business rules"). Every event carries `source:
 * "origination"` (or the application id) so the 29.2 timers arm under origination context (src/kernel/timers/engine.ts).
 *
 * Events (owned here; aggregate `hedge_program`/<partner> for program-level clocks, `hedge_position`/<id> for the
 * roll gate, `margin_call`/<id> for FINRA 4210, the application for per-lock rows):
 *   hedge.policy.updated{policy_id, version, execution_mode, effective_from, review_due_on, initial, status, clock_anchor_on,
 *                        liquidity_review_on, fallout_review_on}                                   [arms every recurring 29.2 clock; SM_HEDGE_POLICY_REVIEW_1Y]
 *   pipeline.snapshot.taken{snapshot_id, execution_mode, locked_uncommitted_cents, expected_deliverable_cents, hedge_face_cents,
 *                        coverage_ratio, coverage_checked, within_band, coverage_outside_band, intraday, clock_anchor_on}
 *   pipeline.price_move.detected{move_bps, threshold_bps}                                          [SM_PIPELINE_INTRADAY_MOVE_TRIGGER]
 *   pull_through.estimated{lock_id, model_id, stage, probability, expected_deliverable_cents}
 *   fallout.recorded{fallout_id, lock_id, reason, stage, rate_move_bps_at_fallout, days_in_pipeline}
 *   fallout.report.published{review_on, cohort, realized_pct, predicted_pct, recalibration_proposed, fallout_review_on, consumers}
 *   hedge.rebalance.recommended{package_id, delta_face_cents, instrument, rationale, escalation_id}
 *   hedge.trade.authorized{package_id, escalation_id}
 *   hedge.trade.executed{trade_id, position_id, kind, instrument, face_cents, price, notification_date, roll_due_on, realized_pl_cents}
 *   hedge.position.rolled{position_id, next_position_id} · hedge.position.paired_off{position_id, realized_pl_cents}
 *   hedge.commitment.requested{amount_cents, product, ptr_range, period_days, officer_authorization_escalation_id}   (consumed by 29.1)
 *   mtm.run.completed{run_id, gl_exported, gl_export_document_id, exported_at, export_hash, clock_anchor_on}
 *   rate_shock.report.published{report_id, limits_breached, clock_anchor_on}
 *   liquidity.report.published{report_id, liquidity_need_cents, shortfall_cents, shortfall_on, liquidity_review_on}
 *   margin.call.received{call_id, counterparty_id, amount_cents, due_at} · margin.call.funded{call_id, wire_id, approvals}
 *   pull_through.model.recalibrated{model_id, version, status, initial, approved_by, o12_2_review_id}
 *   partner.report.published{report_id, kind, document_id, snapshot_ids}
 */
import { createHash, randomUUID } from "node:crypto";
import { type PlainDate, addDays, addMonths, addYears, daysBetween, dayOfWeek, parts, plainDate, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays } from "../../kernel/calendar/business.ts";
import { type Cents, centsToDecimal, formatCents } from "../../kernel/money/cents.ts";
import { Decimal } from "../../kernel/money/decimal.ts";
import type { Actor, Clock, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { Breach } from "../../kernel/timers/engine.ts";
import { EscalationService } from "../../app/escalations.ts";
import { ET, SECONDARY_AGENT, bestEffortsExtensionFee, etDate, etInstant, fannieSifma, isSifmaEarlyClose, mandatoryExtensionFee, mandatoryPairOff, mandatoryTolerance } from "./ops-29-1.ts";

export { ET, SECONDARY_AGENT, fannieSifma };
export const RULE_SET_VERSION_29_2 = "fnma.selling.2026-09-02+fnma.pewl.2025-02+finra.4210.2024-05-22+sifma.upm.ch7+sm.hedge_policy.v1";
export const PRICE_MOVE_THRESHOLD_BPS = 12.5;
export const SHOCKS_BPS: readonly number[] = [-100, -50, -25, 0, 25, 50, 100];
export const FINRA_4210_DE_MINIMIS_CENTS: Cents = 25_000_000n;
export const SMALL_CASH_COUNTERPARTY_CENTS: Cents = 1_000_000_000n;
export const FHFA_ORIGINATION_LIQUIDITY_THRESHOLD_CENTS: Cents = 100_000_000_000n;
export const PULL_THROUGH_DRIFT_POINTS = "10";

export class PipelineRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.name = "PipelineRefused"; this.code = code; }
}

const dec = (s: string | number): Decimal => Decimal.parse(String(s));
const HUNDRED = Decimal.fromInt(100);
const TEN_K = Decimal.fromInt(10_000);
const fromCents = (c: Cents): Decimal => centsToDecimal(c);
const f4 = (d: Decimal): string => d.toFixed(4, "HALF_UP");
const f3 = (d: Decimal): string => d.toFixed(3, "HALF_UP");
const positive = (c: Cents, what: string): Cents => { if (c <= 0n) throw new RangeError(`${what} must be positive`); return c; };
const dollars = (c: Cents): string => formatCents(c, { symbol: true, grouping: true }).replace(/\.00$/, "");
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ============================================================ Policy (rule 1; open questions 4, 7, 8)
export type ExecutionMode = "best_efforts" | "mandatory";
export type HedgeInstrument = "fnma_mandatory_commitment" | "tba_umbs_30" | "tba_umbs_15";
export interface HedgePolicy {
  readonly policy_id: string; readonly partner_id: string; readonly version: number; readonly execution_mode: ExecutionMode;
  readonly instruments: readonly HedgeInstrument[]; readonly hedge_products: readonly string[];
  readonly coverage_band_low: string; readonly coverage_band_high: string; readonly max_uncommitted_days: number; readonly max_unhedged_cents: Cents;
  readonly rate_shock_limit_cents: Readonly<Record<string, Cents>>; readonly margin_liquidity_reserve_cents: Cents; readonly trade_authorization_threshold_cents: Cents;
  readonly auto_execute_within_band: boolean; readonly roll_lead_business_days: number; readonly dealer_margin_threshold_cents: Cents; readonly dealer_min_lot_cents: Cents;
  readonly servicing_value_multiple: string; readonly servicing_fee_bps: number; readonly default_duration: string; readonly default_duration_factor: string;
  readonly approved_by: string | null; readonly approved_at: string | null; readonly effective_from: PlainDate; readonly review_due_on: PlainDate; readonly status: "draft" | "approved" | "superseded";
}
export type PolicyInput = Partial<Omit<HedgePolicy, "policy_id" | "version" | "review_due_on" | "status">> & { readonly effective_from: PlainDate };
export const DEFAULT_HEDGE_POLICY: Omit<HedgePolicy, "policy_id" | "partner_id" | "version" | "effective_from" | "review_due_on" | "status" | "approved_by" | "approved_at"> = {
  execution_mode: "best_efforts", instruments: ["fnma_mandatory_commitment"], hedge_products: ["30yr_fixed_conforming", "15yr_fixed_conforming"],
  coverage_band_low: "0.85", coverage_band_high: "1.10", max_uncommitted_days: 5, max_unhedged_cents: 0n,
  rate_shock_limit_cents: {}, margin_liquidity_reserve_cents: 0n, trade_authorization_threshold_cents: 0n, auto_execute_within_band: false, roll_lead_business_days: 3,
  dealer_margin_threshold_cents: 2_500_000n, dealer_min_lot_cents: 25_000_000n, servicing_value_multiple: "4.5", servicing_fee_bps: 25, default_duration: "4.0", default_duration_factor: "1.0000",
};
/** Open question 4: the rate-shock limit at ±100 bp defaults to 1.5% of the hedged pipeline. */
export const defaultRateShockLimitCents = (hedgedPipelineCents: Cents): Cents => fromCents(hedgedPipelineCents).mul(dec("0.015")).toCents("HALF_UP");
/** LL-2026-04 annual-review discipline: `review_due_on = effective_from + 1 year`. */
export const policyReviewDueOn = (effectiveFrom: PlainDate): PlainDate => addYears(effectiveFrom, 1);

// ============================================================ Calendars: SIFMA class dates (rule 9) and the monthly / weekly anchors
export type SifmaClass = "A" | "B";
export interface SifmaClassDates { readonly settlement_month: PlainDate; readonly sifma_class: SifmaClass; readonly notification_date: PlainDate; readonly settlement_date: PlainDate; }
/** SIFMA MBS Notification and Settlement Dates 2026–2027 (verified 2026-09-10): Class A (30-year UMBS) and Class B (15-year). */
export const SIFMA_CLASS_DATES: readonly SifmaClassDates[] = [
  { settlement_month: plainDate("2026-10-01"), sifma_class: "A", notification_date: plainDate("2026-10-08"), settlement_date: plainDate("2026-10-13") },
  { settlement_month: plainDate("2026-11-01"), sifma_class: "A", notification_date: plainDate("2026-11-09"), settlement_date: plainDate("2026-11-12") },
  { settlement_month: plainDate("2026-12-01"), sifma_class: "A", notification_date: plainDate("2026-12-08"), settlement_date: plainDate("2026-12-10") },
  { settlement_month: plainDate("2027-01-01"), sifma_class: "A", notification_date: plainDate("2027-01-12"), settlement_date: plainDate("2027-01-14") },
  { settlement_month: plainDate("2026-11-01"), sifma_class: "B", notification_date: plainDate("2026-11-13"), settlement_date: plainDate("2026-11-17") },
  { settlement_month: plainDate("2026-12-01"), sifma_class: "B", notification_date: plainDate("2026-12-11"), settlement_date: plainDate("2026-12-15") },
  { settlement_month: plainDate("2027-01-01"), sifma_class: "B", notification_date: plainDate("2027-01-14"), settlement_date: plainDate("2027-01-19") },
];
export const firstOfMonth = (d: PlainDate): PlainDate => { const p = parts(d); return ymd(p.y, p.m, 1); };
export function sifmaDates(settlementMonth: PlainDate, cls: SifmaClass, table: readonly SifmaClassDates[] = SIFMA_CLASS_DATES): SifmaClassDates {
  const m = firstOfMonth(settlementMonth);
  const row = table.find((r) => r.settlement_month === m && r.sifma_class === cls);
  if (!row) throw new RangeError(`no SIFMA class ${cls} dates loaded for ${m} (reload the calendar)`);
  return row;
}
export const instrumentClass = (instrument: HedgeInstrument): SifmaClass | null => (instrument === "tba_umbs_30" ? "A" : instrument === "tba_umbs_15" ? "B" : null);
/** Rule 9: `roll_due_on = businessDaysBefore(notification_date, roll_lead_business_days, 'fannie_sifma')` — Dec 8, 2026 → Thu Dec 3 (Dec 7, 4, 3); Jan 12, 2027 → Thu Jan 7 (Jan 11, 8, 7). */
export function rollDueOn(notificationDate: PlainDate, lead: number = DEFAULT_HEDGE_POLICY.roll_lead_business_days, cal: Calendar = fannieSifma): { roll_due_on: PlainDate; roll_due_at: string } {
  if (!Number.isInteger(lead) || lead < 1) throw new RangeError("roll_lead_business_days must be a positive integer");
  const d = addBusinessDays(notificationDate, -lead, cal); return { roll_due_on: d, roll_due_at: etInstant(d, "12:00") };
}
/** Rule 4: the settlement month after the expected delivery month; never the current month within the roll lead of its notification date. */
export function settlementMonthFor(expectedDeliveryOn: PlainDate, cls: SifmaClass, asOf: PlainDate, lead: number = DEFAULT_HEDGE_POLICY.roll_lead_business_days, cal: Calendar = fannieSifma): SifmaClassDates {
  let m = firstOfMonth(addMonths(expectedDeliveryOn, 1));
  for (let i = 0; i < 12; i++) { const row = SIFMA_CLASS_DATES.find((r) => r.settlement_month === m && r.sifma_class === cls); if (row && rollDueOn(row.notification_date, lead, cal).roll_due_on > asOf) return row; m = addMonths(m, 1); }
  throw new RangeError("no settlement month outside the roll lead is loaded");
}
/** The n-th `fannie_sifma` business day of a month (monthly fallout review: the 3rd — Mon Oct 5, 2026). */
export function nthBusinessDayOfMonth(y: number, m: number, n: number, cal: Calendar = fannieSifma): PlainDate {
  let d = ymd(y, m, 1); let seen = cal.isBusinessDay(d) ? 1 : 0;
  while (seen < n) { d = addDays(d, 1); if (cal.isBusinessDay(d)) seen++; }
  return d;
}
/** The next monthly review on or after `from` (3rd business day of the month). */
export function nextFalloutReviewOn(from: PlainDate, cal: Calendar = fannieSifma): PlainDate {
  const p = parts(from); const thisMonth = nthBusinessDayOfMonth(p.y, p.m, 3, cal);
  if (thisMonth >= from) return thisMonth;
  const n = parts(addMonths(ymd(p.y, p.m, 1), 1)); return nthBusinessDayOfMonth(n.y, n.m, 3, cal);
}
/** The next Friday on or after `from` (weekly liquidity stress, 17:30 ET). */
export const nextFridayOnOrAfter = (from: PlainDate): PlainDate => addDays(from, (5 - dayOfWeek(from) + 7) % 7);

// ============================================================ Rule 2: pull-through
export type PipelineStage = "locked" | "du_approved" | "ctc" | "cd_delivered" | "consummated" | "funded";
export type TransactionType = "purchase" | "refinance";
export type PullThroughMethod = "lookup" | "logistic" | "ml";
export interface PullThroughModel {
  readonly model_id: string; readonly version: string; readonly method: PullThroughMethod; readonly features: readonly string[];
  readonly parameters: { readonly stage_base: Readonly<Record<PipelineStage, string>>; readonly rally_step_bps: string; readonly rally_adjustment: string; readonly selloff_adjustment: string; readonly floor: string; readonly cap: string; readonly refinance_adjustment: string };
  readonly calibration_window: { readonly from: PlainDate; readonly to: PlainDate } | null; readonly validation_document_id: string | null; readonly approved_by: string | null; readonly o12_2_review_id: string | null;
  readonly effective_from: PlainDate; readonly status: "proposed" | "approved" | "stale" | "superseded";
}
/** v1 lookup defaults (until calibrated on the partner's own data). */
export const PULL_THROUGH_MODEL_V1: PullThroughModel = {
  model_id: "pull_through.v1", version: "v1", method: "lookup", features: ["stage", "days_to_expiry", "rate_move_bps", "transaction_type", "occupancy", "ltv_bucket", "channel", "state"],
  parameters: { stage_base: { locked: "0.72", du_approved: "0.80", ctc: "0.92", cd_delivered: "0.97", consummated: "0.995", funded: "1.00" }, rally_step_bps: "12.5", rally_adjustment: "-0.02", selloff_adjustment: "0.01", floor: "0.50", cap: "1.00", refinance_adjustment: "-0.05" },
  calibration_window: null, validation_document_id: null, approved_by: "officer", o12_2_review_id: "o12.2-model-inventory-v1", effective_from: plainDate("2026-09-01"), status: "approved",
};
export interface PullThroughInput { readonly stage: PipelineStage; readonly rate_move_bps?: number; readonly transaction_type?: TransactionType; readonly model?: PullThroughModel; readonly base_probability?: string; }
/** `p = base(stage) + rate-move adjustment (−0.02 per −12.5 bps rally, +0.01 per +12.5 bps sell-off) − 0.05 for refinances`, floored 0.50, capped 1.00 (4 dp). */
export function pullThroughProbability(i: PullThroughInput): { probability: string; base: string; rate_adjustment: string; steps: number } {
  const m = i.model ?? PULL_THROUGH_MODEL_V1; const p = m.parameters;
  const base = dec(i.base_probability ?? p.stage_base[i.stage]);
  const bps = i.rate_move_bps ?? 0;
  const steps = Math.floor(Math.abs(bps) / Number(p.rally_step_bps));
  const adj = bps < 0 ? dec(p.rally_adjustment).mul(Decimal.fromInt(steps)) : dec(p.selloff_adjustment).mul(Decimal.fromInt(steps));
  let prob = base.add(adj); if (i.transaction_type === "refinance") prob = prob.add(dec(p.refinance_adjustment));
  if (prob.cmp(dec(p.floor)) < 0) prob = dec(p.floor); if (prob.cmp(dec(p.cap)) > 0) prob = dec(p.cap);
  return { probability: f4(prob), base: f4(base), rate_adjustment: f4(adj), steps: bps < 0 ? -steps : steps };
}
/** `expected_deliverable = Σ p × amount` (half-up to the cent per lock). */
export const expectedDeliverableCents = (locks: readonly { amount_cents: Cents; probability: string }[]): Cents => locks.reduce((s, l) => s + fromCents(l.amount_cents).mul(dec(l.probability)).toCents("HALF_UP"), 0n);
/** Realized pull-through of a cohort versus the model's prediction; drift beyond ±10 points proposes a recalibration and moves hedge ratios to the conservative band edge. */
export interface FalloutReason { readonly reason: FalloutReasonCode; readonly count: number; readonly note?: string; }
export type FalloutReasonCode = "borrower_withdrawal" | "lender_declination" | "relock_elsewhere" | "ineligible" | "expired_unclosed" | "closed_undeliverable" | "other";
export function analyzeFalloutCohort(i: { cohort: string; locks: number; fallouts: number; predicted_pct: string; reasons?: readonly FalloutReason[]; drift_points?: string }): { cohort: string; realized_pct: string; predicted_pct: string; difference_points: string; within_tolerance: boolean; recalibration_proposed: boolean; hedge_ratio_mode: "model" | "conservative_band_edge"; reasons: readonly FalloutReason[]; fallout_rate_pct: string } {
  if (!Number.isInteger(i.locks) || i.locks <= 0) throw new RangeError("locks must be a positive integer");
  if (!Number.isInteger(i.fallouts) || i.fallouts < 0 || i.fallouts > i.locks) throw new RangeError("fallouts must be between 0 and locks");
  const realized = Decimal.fromInt(i.locks - i.fallouts).mul(HUNDRED).div(Decimal.fromInt(i.locks));
  const diff = realized.sub(dec(i.predicted_pct));
  const within = diff.abs().cmp(dec(i.drift_points ?? PULL_THROUGH_DRIFT_POINTS)) <= 0;
  const reasons = i.reasons ?? [];
  if (reasons.reduce((s, r) => s + r.count, 0) > i.fallouts) throw new RangeError("fallout reasons exceed the fallout count");
  return { cohort: i.cohort, realized_pct: realized.toFixed(1, "HALF_UP"), predicted_pct: dec(i.predicted_pct).toFixed(1, "HALF_UP"), difference_points: diff.toFixed(1, "HALF_UP"), within_tolerance: within, recalibration_proposed: !within, hedge_ratio_mode: within ? "model" : "conservative_band_edge", reasons, fallout_rate_pct: Decimal.fromInt(i.fallouts).mul(HUNDRED).div(Decimal.fromInt(i.locks)).toFixed(1, "HALF_UP") };
}

// ============================================================ Rule 3: hedge ratio and coverage
/** `duration_factor = Δprice_whole_loan / Δprice_hedge` over the last 20 business days of paired prices (sum of moves); default 1.0000 when the series is too short or flat. */
export function estimateDurationFactor(series: readonly { whole_loan_price: string; hedge_price: string }[], fallback: string = DEFAULT_HEDGE_POLICY.default_duration_factor): { duration_factor: string; observations: number; method: "regression_20bd" | "default" } {
  if (series.length < 2) return { duration_factor: f4(dec(fallback)), observations: series.length, method: "default" };
  let num = Decimal.ZERO, den = Decimal.ZERO;
  for (let k = 1; k < series.length; k++) { const dw = dec(series[k]!.whole_loan_price).sub(dec(series[k - 1]!.whole_loan_price)); const dh = dec(series[k]!.hedge_price).sub(dec(series[k - 1]!.hedge_price)); num = num.add(dw.mul(dh)); den = den.add(dh.mul(dh)); }
  if (den.isZero()) return { duration_factor: f4(dec(fallback)), observations: series.length, method: "default" };
  return { duration_factor: f4(num.div(den)), observations: series.length, method: "regression_20bd" };
}
export interface CoverageInput { readonly hedge_face_cents: Cents; readonly duration_factor: string; readonly expected_deliverable_cents: Cents; readonly coverage_band_low?: string; readonly coverage_band_high?: string; }
export interface Coverage { readonly target_hedge_face_cents: Cents; readonly coverage_ratio: string | null; readonly within_band: boolean; readonly band: { low: string; high: string }; readonly delta_face_cents: Cents; readonly points_outside: string; readonly page_officer_within_1h: boolean; }
/** `target_hedge_face = expected_deliverable ÷ duration_factor`; `coverage_ratio = hedge_face × duration_factor ÷ expected_deliverable`; rebalance size `target − hedge_face`. */
export function computeCoverage(i: CoverageInput): Coverage {
  const df = dec(i.duration_factor); if (df.isZero() || df.isNegative()) throw new RangeError("duration_factor must be positive");
  const low = i.coverage_band_low ?? DEFAULT_HEDGE_POLICY.coverage_band_low, high = i.coverage_band_high ?? DEFAULT_HEDGE_POLICY.coverage_band_high;
  const target = i.expected_deliverable_cents <= 0n ? 0n : fromCents(i.expected_deliverable_cents).div(df).toCents("HALF_UP");
  if (i.expected_deliverable_cents <= 0n) return { target_hedge_face_cents: 0n, coverage_ratio: null, within_band: i.hedge_face_cents === 0n, band: { low, high }, delta_face_cents: -i.hedge_face_cents, points_outside: "0.0000", page_officer_within_1h: false };
  const ratio = fromCents(i.hedge_face_cents).mul(df).div(fromCents(i.expected_deliverable_cents));
  const within = ratio.cmp(dec(low)) >= 0 && ratio.cmp(dec(high)) <= 0;
  const outside = within ? Decimal.ZERO : ratio.cmp(dec(low)) < 0 ? dec(low).sub(ratio) : ratio.sub(dec(high));
  return { target_hedge_face_cents: target, coverage_ratio: f4(ratio), within_band: within, band: { low, high }, delta_face_cents: target - i.hedge_face_cents, points_outside: f4(outside), page_officer_within_1h: outside.cmp(dec("0.20")) > 0 };
}
/** Hedge ratios under a stale model use the conservative band edge (under-hedge in a rally-prone month is preferred to over-hedge). */
export const conservativeTargetFace = (expectedDeliverableCents: Cents, durationFactor: string, bandLow: string = DEFAULT_HEDGE_POLICY.coverage_band_low): Cents => fromCents(expectedDeliverableCents).mul(dec(bandLow)).div(dec(durationFactor)).toCents("HALF_UP");
export interface RebalanceInput extends CoverageInput { readonly instrument: HedgeInstrument; readonly trade_price?: string; readonly mark_price?: string; readonly dealer_min_lot_cents?: Cents; readonly coupon?: string; readonly settlement_month?: PlainDate; }
export interface Rebalance { readonly coverage: Coverage; readonly action: "buy_back" | "sell" | "none"; readonly face_cents: Cents; readonly instrument: HedgeInstrument; readonly below_minimum_lot: boolean; readonly realized_pl_estimate_cents: Cents | null; readonly rationale: string; readonly description: string; }
/** Rule 3: rebalance when the ratio leaves the band — size `target − hedge_face`; a buy-back at the mark realizes `face × (trade − mark)/100` (TBA short). */
export function recommendRebalance(i: RebalanceInput): Rebalance {
  const coverage = computeCoverage(i);
  const delta = coverage.delta_face_cents; const abs = delta < 0n ? -delta : delta;
  const minLot = i.dealer_min_lot_cents ?? (i.instrument === "fnma_mandatory_commitment" ? 1n : DEFAULT_HEDGE_POLICY.dealer_min_lot_cents);
  const below = abs > 0n && abs < minLot;
  const action: Rebalance["action"] = coverage.within_band || abs === 0n || below ? "none" : delta < 0n ? "buy_back" : "sell";
  const face = action === "none" ? 0n : abs;
  const pl = action === "buy_back" && i.trade_price && i.mark_price ? tbaPairOffPl(face, i.trade_price, i.mark_price) : null;
  const desc = action === "none" ? "no rebalance" : tradeDescription({ side: action === "buy_back" ? "buy" : "sell", face_cents: face, instrument: i.instrument, coupon: i.coupon ?? null, settlement_month: i.settlement_month ?? null });
  const rationale = coverage.within_band ? `coverage ${coverage.coverage_ratio} inside [${coverage.band.low}, ${coverage.band.high}]` : below ? `coverage ${coverage.coverage_ratio} outside the band but the ${dollars(abs)} delta is below the ${dollars(minLot)} minimum lot` : `coverage ${coverage.coverage_ratio} outside [${coverage.band.low}, ${coverage.band.high}]: ${action === "buy_back" ? "buy back" : "sell"} ${dollars(face)} to reach target ${dollars(coverage.target_hedge_face_cents)}`;
  return { coverage, action, face_cents: face, instrument: i.instrument, below_minimum_lot: below, realized_pl_estimate_cents: pl, rationale, description: desc };
}
/** The one-line package text: "sell $4,000,000 UMBS 30-yr 6.0 Dec". */
export function tradeDescription(i: { side: "sell" | "buy"; face_cents: Cents; instrument: HedgeInstrument; coupon: string | null; settlement_month: PlainDate | null }): string {
  const amt = dollars(i.face_cents);
  if (i.instrument === "fnma_mandatory_commitment") return `${i.side === "sell" ? "commit" : "pair off"} ${amt} Fannie Mae mandatory`;
  const term = i.instrument === "tba_umbs_30" ? "30" : "15"; const cpn = i.coupon ? dec(i.coupon).toFixed(1, "HALF_UP") : "";
  const mon = i.settlement_month ? MONTH_SHORT[parts(i.settlement_month).m - 1] : "";
  return [`${i.side} ${amt} UMBS ${term}-yr`, cpn, mon].filter(Boolean).join(" ");
}

// ============================================================ Rules 6, 11, 12: marks, pair-off P&L, residual exposures
export interface IrlcInput { readonly amount_cents: Cents; readonly market_price: string; readonly lock_base_price: string; readonly probability: string; readonly servicing_value_multiple?: string; readonly servicing_fee_bps?: number; }
export interface IrlcValue { readonly irlc_sale_price_component_cents: Cents; readonly irlc_servicing_component_cents: Cents; readonly irlc_fv_cents: Cents; }
/** SAB 105/109 (ASC 815-10-15-71): `sale = (market − lock_base) × amount × p`; `servicing = multiple × fee_bps/10,000 × amount × p` — reported separately (partner MSR economics vs the pass-through pool). */
export function irlcFairValue(i: IrlcInput): IrlcValue {
  const amt = fromCents(positive(i.amount_cents, "amount_cents")); const p = dec(i.probability);
  const sale = dec(i.market_price).sub(dec(i.lock_base_price)).div(HUNDRED).mul(amt).mul(p).toCents("HALF_UP");
  const servicing = dec(i.servicing_value_multiple ?? DEFAULT_HEDGE_POLICY.servicing_value_multiple).mul(Decimal.fromInt(i.servicing_fee_bps ?? DEFAULT_HEDGE_POLICY.servicing_fee_bps)).div(TEN_K).mul(amt).mul(p).toCents("HALF_UP");
  return { irlc_sale_price_component_cents: sale, irlc_servicing_component_cents: servicing, irlc_fv_cents: sale + servicing };
}
/** `hedge_fv = face × (trade_price − mark_price)/100` for a short (a long is the negative). */
export const hedgeFairValue = (faceCents: Cents, tradePrice: string, markPrice: string, side: "sell" | "buy" = "sell"): Cents => { const v = fromCents(positive(faceCents, "face_cents")).mul(dec(tradePrice).sub(dec(markPrice))).div(HUNDRED).toCents("HALF_UP"); return side === "sell" ? v : -v; };
/** Held-for-sale loans: `hfs_fv = upb × (net_price_market − 100)/100`; LOCOM caps the carrying value at the lower of cost and fair value, FVO carries fair value. */
export function hfsFairValue(i: { upb_cents: Cents; net_price_market: string; cost_basis_cents: Cents; election?: "fvo" | "locom" }): { hfs_fv_cents: Cents; carrying_cents: Cents; valuation_allowance_cents: Cents } {
  const fv = fromCents(i.upb_cents).mul(dec(i.net_price_market).sub(HUNDRED)).div(HUNDRED).toCents("HALF_UP") + i.upb_cents;
  const locom = fv < i.cost_basis_cents ? fv : i.cost_basis_cents;
  return { hfs_fv_cents: fv, carrying_cents: (i.election ?? "fvo") === "fvo" ? fv : locom, valuation_allowance_cents: (i.election ?? "fvo") === "fvo" ? 0n : i.cost_basis_cents - locom };
}
/** Rule 11: TBA pair-off P&L `= face × (trade_price − pair_off_price)/100` (short). $400,000 × (100.500 − 101.500)/100 = −$4,000.00. */
export const tbaPairOffPl = (faceCents: Cents, tradePrice: string, pairOffPrice: string): Cents => fromCents(positive(faceCents, "face_cents")).mul(dec(tradePrice).sub(dec(pairOffPrice))).div(HUNDRED).toCents("HALF_UP");
/** Rule 12: `uncommitted_exposure = Σ locked_uncommitted × duration × shock` — rising rates hurt: +25 bp on $1,500,000 at duration 4.0 → −$15,000. */
export const uncommittedExposureCents = (lockedUncommittedCents: Cents, shockBps: number, duration: string = DEFAULT_HEDGE_POLICY.default_duration): Cents => fromCents(lockedUncommittedCents).mul(dec(duration)).mul(Decimal.fromInt(shockBps)).div(TEN_K).neg().toCents("HALF_UP");
/** Rule 12: `pair_off_risk = Σ closed_undeliverable × max(0, market − commitment price)` — falling rates hurt. */
export const pairOffRiskCents = (rows: readonly { amount_cents: Cents; commitment_price: string; market_price: string }[]): Cents => rows.reduce((s, r) => s + mandatoryPairOff(r.amount_cents, r.commitment_price, r.market_price).fee_cents, 0n);
/** Worked example 1: the 5-day extension quote recommended as insurance on a commitment whose closing sits inside its expiry only because of a rolled holiday — $610,000 × 5.875%/360 × 5 = $497.74 (29.1 rule 10 arithmetic). */
export function extensionInsuranceQuote(maxAmountCents: Cents, maxPtrPct: string, days: number): { days: number; fee_cents: Cents; per_diem_cents: string } { const r = bestEffortsExtensionFee(maxAmountCents, maxPtrPct, days); return { days, fee_cents: r.fee_cents, per_diem_cents: r.per_diem_cents }; }
/** Rule 11: the daily mandatory-commitment decision — a partial pair-off (29.1 rule 12) against a short extension of the late balance (per diem on the lowest PTR). */
export interface CommitmentDecisionInput { readonly commitment_id: string; readonly original_amount_cents: Cents; readonly commitment_price: string; readonly live_price: string; readonly expires_on: PlainDate; readonly expected_deliverable_cents: Cents; readonly late_balance_cents: Cents; readonly late_loan_stages: readonly PipelineStage[]; readonly extension_days: number; readonly min_ptr: string; readonly as_of: string; }
export interface CommitmentDecision { readonly pair_off: { amount_cents: Cents; fee_cents: Cents; cash_back_cents: Cents; remaining_undelivered_cents: Cents; inside_tolerance: boolean }; readonly extension: { days: number; amount_cents: Cents; fee_cents: Cents; per_diem_cents: string; new_expires_on: PlainDate }; readonly recommendation: "extension" | "pair_off"; readonly decide_by: string; readonly officer_decision_required: true; readonly rationale: string; }
export function commitmentPairOffOrExtend(i: CommitmentDecisionInput): CommitmentDecision {
  const tol = mandatoryTolerance(i.original_amount_cents);
  const shortfall = i.original_amount_cents - i.expected_deliverable_cents;
  const pairOffAmount = shortfall > tol.tolerance_cents ? shortfall - tol.tolerance_cents : 0n;
  const po = pairOffAmount > 0n ? mandatoryPairOff(pairOffAmount, i.commitment_price, i.live_price) : { fee_cents: 0n, cash_back_cents: 0n };
  const ext = mandatoryExtensionFee(i.late_balance_cents, i.min_ptr, i.extension_days);
  const allLate = i.late_loan_stages.length > 0 && i.late_loan_stages.every((s) => s === "cd_delivered" || s === "consummated" || s === "funded");
  const recommendation: CommitmentDecision["recommendation"] = allLate ? "extension" : "pair_off";
  const decideOn = addBusinessDays(i.expires_on, -1, fannieSifma) < plainDate(etDate(i.as_of)) ? i.expires_on : i.expires_on;
  return { pair_off: { amount_cents: pairOffAmount, fee_cents: po.fee_cents, cash_back_cents: po.cash_back_cents, remaining_undelivered_cents: shortfall - pairOffAmount, inside_tolerance: shortfall - pairOffAmount <= tol.tolerance_cents },
    extension: { days: i.extension_days, amount_cents: i.late_balance_cents, fee_cents: ext.fee_cents, per_diem_cents: ext.per_diem_cents, new_expires_on: addBusinessDays(addDays(i.expires_on, i.extension_days), 0, fannieSifma) },
    recommendation, decide_by: etInstant(decideOn, isSifmaEarlyClose(decideOn) ? "14:00" : "17:00"), officer_decision_required: true,
    rationale: allLate ? `late loans at stage ${[...new Set(i.late_loan_stages)].join("/")} (p ≥ 0.97): extend ${i.extension_days} days for ${formatCents(ext.fee_cents, { symbol: true })} rather than pair off for ${formatCents(po.fee_cents, { symbol: true })}` : `late loans not yet at cd_delivered: pair off ${dollars(pairOffAmount)} (${po.cash_back_cents > 0n ? `cash back ${formatCents(po.cash_back_cents, { symbol: true })}` : `fee ${formatCents(po.fee_cents, { symbol: true })}`})` };
}

// ============================================================ Rule 7: rate shock; rule 8: liquidity
export interface RateShockInput {
  readonly covered_amount_cents: Cents; readonly expected_deliverable_cents: Cents; readonly p_base: string; readonly hedge_face_cents: Cents; readonly hedge_trade_price: string; readonly hedge_mark_price: string;
  readonly duration?: string; readonly duration_factor?: string; readonly margin_posted_cents?: Cents; readonly shocks?: readonly number[]; readonly rate_shock_limit_cents?: Readonly<Record<string, Cents>>; readonly transaction_type?: TransactionType; readonly model?: PullThroughModel;
}
export interface ShockRow { readonly shock_bps: number; readonly price_change: string; readonly probability: string; readonly expected_deliverable_cents: Cents; readonly pipeline_value_cents: Cents; readonly hedge_value_cents: Cents; readonly net_value_cents: Cents; readonly coverage_ratio: string | null; readonly under_hedge_cents: Cents; readonly projected_margin_call_cents: Cents; readonly projected_pair_off_cost_cents: Cents; readonly limit_cents: Cents | null; readonly limit_breached: boolean | null; }
/**
 * For each shock: `Δprice ≈ −duration × s/100`; p re-estimated under the shock; the pipeline's current expected deliverable
 * re-scaled by `p_shock / p_base` and repriced; a short hedge gains when prices fall; projected margin call = max(0, hedge MTM
 * loss − margin already posted); projected pair-off cost = the over-hedge × |Δprice|.
 */
export function rateShockTable(i: RateShockInput): ShockRow[] {
  const duration = dec(i.duration ?? DEFAULT_HEDGE_POLICY.default_duration); const df = i.duration_factor ?? DEFAULT_HEDGE_POLICY.default_duration_factor;
  const pBase = dec(i.p_base); if (pBase.isZero()) throw new RangeError("p_base must be positive");
  return (i.shocks ?? SHOCKS_BPS).map((s) => {
    const dPrice = duration.mul(Decimal.fromInt(s)).div(HUNDRED).neg();
    const p = dec(pullThroughProbability({ stage: "locked", rate_move_bps: s, base_probability: i.p_base, ...(i.transaction_type ? { transaction_type: i.transaction_type } : {}), ...(i.model ? { model: i.model } : {}) }).probability);
    const deliverable = fromCents(i.covered_amount_cents).mul(p).toCents("HALF_UP");
    const pipeline = fromCents(i.expected_deliverable_cents).mul(p).div(pBase).mul(dPrice).div(HUNDRED).toCents("HALF_UP");
    const hedge = i.hedge_face_cents > 0n ? fromCents(i.hedge_face_cents).mul(dPrice).div(HUNDRED).neg().toCents("HALF_UP") : 0n;
    const cov = computeCoverage({ hedge_face_cents: i.hedge_face_cents, duration_factor: df, expected_deliverable_cents: deliverable });
    const under = deliverable - i.hedge_face_cents;
    const loss = hedge < 0n ? -hedge : 0n; const posted = i.margin_posted_cents ?? 0n;
    const over = under < 0n ? -under : 0n;
    const limit = i.rate_shock_limit_cents?.[String(s)] ?? null; const net = hedge + pipeline;
    return { shock_bps: s, price_change: f3(dPrice), probability: f4(p), expected_deliverable_cents: deliverable, pipeline_value_cents: pipeline, hedge_value_cents: hedge, net_value_cents: net, coverage_ratio: cov.coverage_ratio, under_hedge_cents: under,
      projected_margin_call_cents: loss > posted ? loss - posted : 0n, projected_pair_off_cost_cents: fromCents(over).mul(dPrice.abs()).div(HUNDRED).toCents("HALF_UP"), limit_cents: limit, limit_breached: limit === null ? null : (net < 0n ? -net : net) > limit };
  });
}
export interface LiquidityInput { readonly projected_margin_calls_cents: Cents; readonly pair_off_fees_due_5d_cents: Cents; readonly extension_carry_accrued_cents: Cents; readonly warehouse_curtailments_due_cents: Cents; readonly annual_origination_cents?: Cents; readonly fhfa_origination_liquidity_cents?: Cents; readonly reserve_cents: Cents; readonly as_of: PlainDate; readonly earliest_due_on?: PlainDate | null; }
/** Rule 8: `liquidity_need = margin (−100 bp) + pair-off fees due within 5 days + extension carry accrued + warehouse curtailments due + FHFA origination-liquidity requirement (≥ $1B origination)`. */
export function computeLiquidityNeed(i: LiquidityInput): { liquidity_need_cents: Cents; fhfa_requirement_cents: Cents; reserve_cents: Cents; shortfall_cents: Cents; shortfall_on: PlainDate | null; components: Record<string, Cents> } {
  const fhfa = (i.annual_origination_cents ?? 0n) >= FHFA_ORIGINATION_LIQUIDITY_THRESHOLD_CENTS ? (i.fhfa_origination_liquidity_cents ?? 0n) : 0n;
  const need = i.projected_margin_calls_cents + i.pair_off_fees_due_5d_cents + i.extension_carry_accrued_cents + i.warehouse_curtailments_due_cents + fhfa;
  const shortfall = need > i.reserve_cents ? need - i.reserve_cents : 0n;
  return { liquidity_need_cents: need, fhfa_requirement_cents: fhfa, reserve_cents: i.reserve_cents, shortfall_cents: shortfall, shortfall_on: shortfall > 0n ? (i.earliest_due_on ?? addBusinessDays(i.as_of, 1, fannieSifma)) : null,
    components: { projected_margin_calls_cents: i.projected_margin_calls_cents, pair_off_fees_due_5d_cents: i.pair_off_fees_due_5d_cents, extension_carry_accrued_cents: i.extension_carry_accrued_cents, warehouse_curtailments_due_cents: i.warehouse_curtailments_due_cents, fhfa_requirement_cents: fhfa } };
}
/** Open question 4: margin liquidity reserve = the −100 bp projected call plus 25%. */
export const marginLiquidityReserveCents = (projectedCallMinus100Cents: Cents): Cents => fromCents(projectedCallMinus100Cents).mul(dec("1.25")).toCents("HALF_UP");

// ============================================================ FINRA 4210 variation margin
/** A dealer call issues when the excess net mark-to-market loss exceeds the annex threshold (default modeled $25,000; the rule's floor is $250,000). */
export function marginCallAmount(excessNetMtmLossCents: Cents, thresholdCents: Cents = DEFAULT_HEDGE_POLICY.dealer_margin_threshold_cents): { call_cents: Cents; above_de_minimis: boolean } {
  const loss = excessNetMtmLossCents > 0n ? excessNetMtmLossCents : 0n;
  return { call_cents: loss > thresholdCents ? loss - thresholdCents : 0n, above_de_minimis: loss > FINRA_4210_DE_MINIMIS_CENTS };
}
/** `FINRA_4210_VARIATION_MARGIN_1BD`: due close of business the next `business_days_fannie_et` day after receipt (ET); wires on early-close days go before 2:00 p.m. ET. Mon Nov 2 → Tue Nov 3; Tue Nov 10 → Thu Nov 12 (Veterans Day). */
export function marginCallDue(receivedAtIso: string, cal: Calendar = fannieSifma, dueHhmm: string | null = null): { due_on: PlainDate; due_at: string } {
  const d = addBusinessDays(plainDate(etDate(receivedAtIso)), 1, cal);
  return { due_on: d, due_at: etInstant(d, dueHhmm ?? (isSifmaEarlyClose(d) ? "14:00" : "17:00")) };
}
export interface WireApproval { readonly actor_id: string; readonly role: string; }
/** 26.3 dual control reused for margin wires: two distinct approvers, one of them the `funding_approver`. */
export function dualControlSatisfied(approvals: readonly WireApproval[]): { satisfied: boolean; reason?: string } {
  const ids = new Set(approvals.map((a) => a.actor_id));
  if (ids.size < 2) return { satisfied: false, reason: "dual control needs two distinct approvers" };
  if (!approvals.some((a) => a.role === "funding_approver")) return { satisfied: false, reason: "one approver must hold the funding_approver role" };
  return { satisfied: true };
}

// ============================================================ Rule 1: hedge-program eligibility (and the T13 review breach)
export interface EligibilityInput { readonly product_code: string; readonly amortization?: string; readonly flags?: Record<string, unknown>; readonly policy: HedgePolicy | null; readonly as_of: PlainDate; readonly newer_version_approved?: boolean; }
export function hedgeProgramEligibility(i: EligibilityInput): { eligible: boolean; execution: "mandatory_pipeline" | "best_efforts"; reason: string } {
  const enabled = i.flags?.["execution.mandatory_enabled"] === true || i.flags?.["execution.mandatory_enabled"] === "true";
  if (!enabled) return { eligible: false, execution: "best_efforts", reason: "execution.mandatory_enabled=false" };
  if (!i.policy || i.policy.status !== "approved") return { eligible: false, execution: "best_efforts", reason: "no approved hedge policy" };
  if (i.policy.execution_mode !== "mandatory") return { eligible: false, execution: "best_efforts", reason: "policy execution_mode=best_efforts" };
  if (i.as_of > i.policy.review_due_on && !i.newer_version_approved) return { eligible: false, execution: "best_efforts", reason: "SM_HEDGE_POLICY_REVIEW_1Y: policy review overdue — mandatory execution suspended for new locks" };
  if (!i.policy.hedge_products.includes(i.product_code)) return { eligible: false, execution: "best_efforts", reason: `product ${i.product_code} stays best efforts under the policy` };
  return { eligible: true, execution: "mandatory_pipeline", reason: "covered by the hedge program" };
}
/** `SM_PIPELINE_INTRADAY_MOVE_TRIGGER`: a TBA / whole-loan price move ≥ 12.5 bps versus the last snapshot (20.4's republish threshold). */
export function priceMoveTrigger(lastPrice: string, currentPrice: string, thresholdBps: number = PRICE_MOVE_THRESHOLD_BPS): { move_bps: string; triggered: boolean } {
  const move = dec(currentPrice).sub(dec(lastPrice)).mul(HUNDRED); return { move_bps: move.toFixed(1, "HALF_UP"), triggered: move.abs().cmp(dec(thresholdBps)) >= 0 };
}
/** `SM_UNCOMMITTED_POSITION_5BD`: +5 `business_days_fannie_et` from the lock's ET date, 5:00 p.m. ET (Wed Oct 7 → Wed Oct 14, 2026 across Columbus Day). */
export function uncommittedPositionDue(lockedAtIso: string, days: number = DEFAULT_HEDGE_POLICY.max_uncommitted_days, cal: Calendar = fannieSifma): { due_on: PlainDate; due_at: string } { const d = addBusinessDays(plainDate(etDate(lockedAtIso)), days, cal); return { due_on: d, due_at: etInstant(d, "17:00") }; }

// ============================================================ Gate facts for the evaluator (SM_HEDGE_COVERAGE_BAND_GATE)
export type GateFacts = Record<string, unknown>;
const fs = (f: GateFacts, k: string): string | null => (typeof f[k] === "string" && f[k] !== "" ? String(f[k]) : typeof f[k] === "number" ? String(f[k]) : null);
const fc = (f: GateFacts, k: string): Cents => (typeof f[k] === "bigint" ? (f[k] as bigint) : f[k] === undefined || f[k] === null || f[k] === "" ? 0n : BigInt(String(f[k])));
export const coverageBandGate = (f: GateFacts): { open: boolean; reason?: string } => {
  const ratio = fs(f, "coverage_ratio");
  const low = fs(f, "coverage_band_low") ?? DEFAULT_HEDGE_POLICY.coverage_band_low, high = fs(f, "coverage_band_high") ?? DEFAULT_HEDGE_POLICY.coverage_band_high;
  if (ratio === null) {
    const ed = fc(f, "expected_deliverable_cents"); if (ed <= 0n) return { open: true };
    const c = computeCoverage({ hedge_face_cents: fc(f, "hedge_face_cents"), duration_factor: fs(f, "duration_factor") ?? "1.0000", expected_deliverable_cents: ed, coverage_band_low: low, coverage_band_high: high });
    return c.within_band ? { open: true } : { open: false, reason: `SM_HEDGE_COVERAGE_BAND_GATE: coverage ${c.coverage_ratio} outside [${low}, ${high}]` };
  }
  const r = dec(ratio); return r.cmp(dec(low)) >= 0 && r.cmp(dec(high)) <= 0 ? { open: true } : { open: false, reason: `SM_HEDGE_COVERAGE_BAND_GATE: coverage ${f4(r)} outside [${low}, ${high}]` };
};

// ============================================================ Records (migration 0104 projections)
export type LockExposureState = "locked_uncommitted" | "committed_be" | "mandatory_pipeline" | "closed_be" | "funded_unsold" | "delivered" | "purchased" | "fallout" | "closed_undeliverable";
export interface PipelineLock {
  readonly lock_id: string; readonly application_id: string; readonly lineage_id: string | null; readonly locked_at: string; readonly expires_on: PlainDate | null; readonly amount_cents: Cents; readonly note_rate: string; readonly ptr: string; readonly lock_base_price: string;
  readonly product_code: string; readonly amortization: string; readonly transaction_type: TransactionType; readonly stage: PipelineStage; readonly state: LockExposureState; readonly hedge_program: boolean; readonly commitment_id: string | null; readonly commitment_price: string | null; readonly commitment_expires_on: PlainDate | null;
  readonly rate_move_bps: number; readonly probability_override: string | null; readonly funded_on: PlainDate | null; readonly upb_cents: Cents | null; readonly cost_basis_cents: Cents | null;
}
export type HedgePositionStatus = "open" | "rolled" | "paired_off" | "closed";
export interface HedgePosition {
  readonly position_id: string; readonly partner_id: string; readonly instrument: HedgeInstrument; readonly coupon: string | null; readonly settlement_month: PlainDate | null; readonly sifma_class: SifmaClass | null; readonly notification_date: PlainDate | null; readonly settlement_date: PlainDate | null;
  readonly side: "sell" | "buy"; readonly face_cents: Cents; readonly original_face_cents: Cents; readonly trade_price: string; readonly trade_date: PlainDate; readonly trade_time_et: string; readonly counterparty_id: string; readonly commitment_id: string | null; readonly status: HedgePositionStatus; readonly roll_due_on: PlainDate | null;
  readonly mark_price: string | null; readonly mark_cents: Cents | null; readonly marked_at: string | null; readonly realized_pl_cents: Cents; readonly authorized_by: string | null; readonly agent_decision_id: string | null; readonly confirmation_document_id: string;
}
export type TradeKind = "open" | "pair_off" | "roll_close" | "roll_open" | "assign_to_commitment";
export interface HedgeTrade { readonly trade_id: string; readonly position_id: string; readonly kind: TradeKind; readonly face_cents: Cents; readonly price: string; readonly executed_at: string; readonly executed_by: string; readonly confirmation_document_id: string; readonly realized_pl_cents: Cents | null; }
export interface TradePackage { readonly package_id: string; readonly kind: "open" | "rebalance" | "roll" | "pair_off"; readonly side: "sell" | "buy"; readonly instrument: HedgeInstrument; readonly coupon: string | null; readonly settlement_month: PlainDate | null; readonly face_cents: Cents; readonly price_expectation: string | null; readonly description: string; readonly rationale: string; readonly policy_checks: readonly { check: string; passed: boolean }[]; readonly alternatives: readonly { description: string; cost_cents: Cents }[]; readonly escalation_id: string; readonly status: "recommended" | "authorized" | "executed" | "declined" | "expired"; readonly position_id: string | null; readonly prepared_at: string; readonly model_version: string; }
export interface PipelinePosition {
  readonly snapshot_id: string; readonly as_of: string; readonly execution_mode: ExecutionMode; readonly intraday: boolean; readonly locked_uncommitted_cents: Cents; readonly committed_be_cents: Cents; readonly closed_be_cents: Cents; readonly mandatory_pipeline_cents: Cents; readonly funded_unsold_cents: Cents;
  readonly expected_pull_through_pct: string | null; readonly expected_deliverable_cents: Cents; readonly hedge_face_cents: Cents; readonly duration_factor: string; readonly coverage_ratio: string | null; readonly within_band: boolean; readonly whole_loan_mark_price: string | null; readonly tba_mark_price: string | null;
  readonly pipeline_value_cents: Cents; readonly hedge_value_cents: Cents; readonly net_value_cents: Cents; readonly expirations_7d: readonly { commitment_id: string; amount_cents: Cents; expires_on: PlainDate }[]; readonly dpa_exposures: readonly { commitment_id: string; dpa_exposure_until: PlainDate }[];
  readonly undeliverable_closed_cents: Cents; readonly pair_off_risk_cents: Cents; readonly extension_carry_accrued_cents: Cents; readonly residual_shocks: Readonly<Record<string, Cents>>; readonly buckets: readonly { key: string; state: LockExposureState; amount_cents: Cents; count: number }[]; readonly price_source: string; readonly locks: readonly { lock_id: string; state: LockExposureState; stage: PipelineStage; probability: string; amount_cents: Cents }[];
}
export interface PullThroughEstimate { readonly estimate_id: string; readonly lock_id: string; readonly as_of: string; readonly model_id: string; readonly stage: PipelineStage; readonly rate_move_bps: number; readonly days_to_expiry: number | null; readonly probability: string; readonly expected_deliverable_cents: Cents; }
export interface FalloutEvent { readonly fallout_id: string; readonly lock_id: string; readonly commitment_id: string | null; readonly occurred_at: string; readonly stage: PipelineStage; readonly reason: FalloutReasonCode; readonly rate_move_bps_at_fallout: number; readonly days_in_pipeline: number; readonly dpa_incurred_cents: Cents; readonly pair_off_fee_cents: Cents; }
export interface MarkToMarketRun { readonly run_id: string; readonly as_of: string; readonly snapshot_id: string; readonly price_sources: Readonly<Record<string, string>>; readonly irlc_fv_cents: Cents; readonly irlc_sale_price_component_cents: Cents; readonly irlc_servicing_component_cents: Cents; readonly hfs_loans_fv_cents: Cents; readonly hfs_loans_cost_basis_cents: Cents; readonly hedge_fv_cents: Cents; readonly net_fv_cents: Cents; readonly day_change_cents: Cents; readonly realized_pl_mtd_cents: Cents; readonly stale_prices: readonly string[]; readonly gl_export_document_id: string; readonly exported_at: string; readonly export_hash: string; readonly gl_export: Record<string, unknown>; }
export interface RateShockReport { readonly report_id: string; readonly as_of: string; readonly shocks: readonly ShockRow[]; readonly limits_checked: readonly { shock_bps: number; limit_cents: Cents | null; breached: boolean | null }[]; readonly published_document_id: string; }
export interface MarginCall { readonly call_id: string; readonly counterparty_id: string; readonly received_at: string; readonly amount_cents: Cents; readonly basis: Record<string, unknown>; readonly due_on: PlainDate; readonly due_at: string; readonly funded_at: string | null; readonly wire_id: string | null; readonly status: "open" | "funded" | "disputed"; readonly escalation_id: string | null; }
export interface PartnerReport { readonly report_id: string; readonly kind: "daily_position" | "rate_shock" | "liquidity_stress" | "fallout_review" | "hedge_effectiveness" | "policy_compliance" | "policy_review"; readonly document_id: string; readonly published_at: string; readonly snapshot_ids: readonly string[]; readonly body: Record<string, unknown>; }

// ============================================================ The runtime service
export interface PipelineDeps { readonly events: EventStore; readonly clock: Clock; readonly escalations?: EscalationService; readonly partner_id?: string; readonly calendar?: Calendar; readonly flags?: Record<string, unknown>; readonly model?: PullThroughModel; }
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;
const cents = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const hash = (o: unknown): string => createHash("sha256").update(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).digest("hex").slice(0, 32);

export class PipelineService {
  readonly d: PipelineDeps; readonly esc: EscalationService; readonly cal: Calendar; readonly partnerId: string;
  private flagsState: Record<string, unknown>;
  readonly policies: HedgePolicy[] = []; readonly locks = new Map<string, PipelineLock>(); readonly positions: HedgePosition[] = []; readonly trades: HedgeTrade[] = []; readonly packages: TradePackage[] = [];
  readonly snapshots: PipelinePosition[] = []; readonly estimates: PullThroughEstimate[] = []; readonly fallouts: FalloutEvent[] = []; readonly mtmRuns: MarkToMarketRun[] = []; readonly shockReports: RateShockReport[] = []; readonly marginCalls: MarginCall[] = []; readonly reports: PartnerReport[] = []; readonly models: PullThroughModel[] = [];
  readonly liquidityReports: (ReturnType<typeof computeLiquidityNeed> & { report_id: string; as_of: string })[] = [];
  private hedgeRatioMode: "model" | "conservative_band_edge" = "model";
  private lastPrices: { whole_loan: string | null; tba: string | null } = { whole_loan: null, tba: null };
  constructor(deps: PipelineDeps) { this.d = deps; this.esc = deps.escalations ?? new EscalationService(deps.events, deps.clock); this.cal = deps.calendar ?? fannieSifma; this.partnerId = deps.partner_id ?? "partner-1"; this.flagsState = { ...(deps.flags ?? {}) }; this.models.push(deps.model ?? PULL_THROUGH_MODEL_V1); }

  now(): string { return this.d.clock.now(); }
  setFlags(f: Record<string, unknown>): void { this.flagsState = { ...this.flagsState, ...f }; }
  flags(f: Record<string, unknown> = {}): Record<string, unknown> { return { ...this.flagsState, ...f }; }
  mandatoryEnabled(f: Record<string, unknown> = {}): boolean { const v = this.flags(f)["execution.mandatory_enabled"]; return v === true || v === "true"; }
  policy(): HedgePolicy | null { return this.policies.filter((x) => x.status === "approved").at(-1) ?? null; }
  model(): PullThroughModel { return this.models.filter((m) => m.status === "approved").at(-1) ?? this.models[0]!; }
  hedgeRatioModeNow(): "model" | "conservative_band_edge" { return this.hedgeRatioMode; }
  private program(): { kind: string; id: string } { return { kind: "hedge_program", id: this.partnerId }; }
  private emit(type: string, payload: Record<string, unknown>, o: { aggregate?: { kind: string; id: string }; applicationId?: string; actor?: Actor } = {}): DomainEvent {
    return this.d.events.append({ type, actor: o.actor ?? SECONDARY_AGENT, aggregate: o.aggregate ?? this.program(), ...(o.applicationId ? { applicationId: o.applicationId } : {}), payload: { ...payload, partner_id: this.partnerId, source: "origination" } });
  }
  private officer(task: string, payload: Record<string, unknown>, severity?: string, applicationId?: string): string {
    return this.esc.open({ kind: "officer", ownerRole: "officer", ...(severity ? { severity } : {}), ...(applicationId ? { applicationId } : {}), payload: { task, ...payload } }, SECONDARY_AGENT).id;
  }
  /** `lock.executed` (21.4) anchors SM_UNCOMMITTED_POSITION_5BD on the lock's ET date: `locked_on` is set on the lock view for the row's anchor. */
  private clockAnchors(on: PlainDate): Record<string, unknown> { return { clock_anchor_on: on, liquidity_review_on: nextFridayOnOrAfter(addDays(on, 1)), fallout_review_on: nextFalloutReviewOn(addDays(on, 1), this.cal) }; }

  // ---- Policy (rule 1; T13)
  adoptPolicy(i: PolicyInput & { at?: string; approved_by?: string | null }): HedgePolicy {
    const at = i.at ?? this.now(); const prev = this.policy();
    const { at: _a, approved_by, ...rest } = i; void _a;
    const pol: HedgePolicy = { ...DEFAULT_HEDGE_POLICY, ...rest, policy_id: randomUUID(), partner_id: this.partnerId, version: (prev?.version ?? 0) + 1, effective_from: i.effective_from, review_due_on: policyReviewDueOn(i.effective_from), approved_by: approved_by ?? null, approved_at: at, status: "approved" };
    for (let k = 0; k < this.policies.length; k++) if (this.policies[k]!.status === "approved") this.policies[k] = { ...this.policies[k]!, status: "superseded" };
    this.policies.push(pol);
    const anchorOn = plainDate(etDate(at)) > pol.effective_from ? plainDate(etDate(at)) : pol.effective_from;
    this.emit("hedge.policy.updated", { policy_id: pol.policy_id, version: pol.version, execution_mode: pol.execution_mode, instruments: [...pol.instruments], effective_from: pol.effective_from, review_due_on: pol.review_due_on, initial: prev === null, status: "approved", approved_by: pol.approved_by, ...this.clockAnchors(anchorOn) });
    return pol;
  }
  policyState(asOf: PlainDate = plainDate(etDate(this.now()))): { policy: HedgePolicy | null; review_overdue: boolean; mandatory_suspended_for_new_locks: boolean } {
    const pol = this.policy(); const overdue = !!pol && asOf > pol.review_due_on;
    return { policy: pol, review_overdue: overdue, mandatory_suspended_for_new_locks: overdue || !pol };
  }
  eligibility(lock: Pick<PipelineLock, "product_code" | "amortization">, at: string = this.now(), flags: Record<string, unknown> = {}): ReturnType<typeof hedgeProgramEligibility> {
    return hedgeProgramEligibility({ product_code: lock.product_code, amortization: lock.amortization, flags: this.flags(flags), policy: this.policy(), as_of: plainDate(etDate(at)) });
  }

  // ---- Locks and their exposure state (the derived state machine)
  upsertLock(i: Partial<PipelineLock> & { lock_id: string; application_id: string; locked_at: string; amount_cents: Cents; note_rate: string; lock_base_price: string; product_code: string }, flags: Record<string, unknown> = {}): PipelineLock {
    const prev = this.locks.get(i.lock_id);
    const elig = prev ? null : this.eligibility({ product_code: i.product_code, amortization: i.amortization ?? "fixed" }, i.locked_at, flags);
    const lock: PipelineLock = { lineage_id: null, expires_on: null, ptr: i.ptr ?? f3(dec(i.note_rate).sub(dec("0.25"))), amortization: "fixed", transaction_type: "purchase", stage: "locked", state: elig?.eligible ? "mandatory_pipeline" : "locked_uncommitted", hedge_program: elig?.eligible ?? false, commitment_id: null, commitment_price: null, commitment_expires_on: null, rate_move_bps: 0, probability_override: null, funded_on: null, upb_cents: null, cost_basis_cents: null, ...(prev ?? {}), ...i } as PipelineLock;
    this.locks.set(lock.lock_id, lock); return lock;
  }
  patchLock(lockId: string, patch: Partial<PipelineLock>): PipelineLock { const cur = this.locks.get(lockId); if (!cur) throw new RangeError(`no lock ${lockId}`); const next = { ...cur, ...patch }; this.locks.set(lockId, next); return next; }
  lock(lockId: string): PipelineLock { const l = this.locks.get(lockId); if (!l) throw new RangeError(`no lock ${lockId}`); return l; }
  /** Consume the section's inputs: 21.4 `lock.*`, 29.1 `commitment.*`, 26.3/30.2 `loan.funded`, 29.4/30.1 `loan.purchased`, 21.6 `decision.issued`, 23.1 `du.findings.received`. */
  ingest(e: DomainEvent, flags: Record<string, unknown> = {}): void {
    const x = p(e); const lockId = typeof x.lock_id === "string" ? x.lock_id : null;
    switch (e.type) {
      case "lock.executed": { if (!lockId || !e.applicationId) return; this.upsertLock({ lock_id: lockId, application_id: e.applicationId, lineage_id: (x.lineage_id as string | undefined) ?? null, locked_at: (x.locked_at as string | undefined) ?? e.occurredAt, amount_cents: cents(x.loan_amount_cents ?? x.amount_cents), note_rate: String(x.note_rate ?? "0"), lock_base_price: String(x.price ?? x.base_price ?? "100"), product_code: String(x.product_code ?? ""), expires_on: typeof x.expires_on === "string" ? plainDate(x.expires_on) : null, ...(x.transaction_type ? { transaction_type: x.transaction_type as TransactionType } : {}) }, flags); return; }
      case "commitment.executed": { const l = this.lockByRef(lockId, x); if (!l) return; if (x.type === "mandatory") return; this.patchLock(l.lock_id, { state: "committed_be", commitment_id: String(x.commitment_id ?? ""), commitment_price: String(x.price ?? ""), commitment_expires_on: typeof x.expires_on === "string" ? plainDate(x.expires_on) : null }); return; }
      case "du.findings.received": { const l = this.lockByRef(lockId, x); if (l && x.recommendation === "approve_eligible" && l.stage === "locked") this.patchLock(l.lock_id, { stage: "du_approved" }); return; }
      case "closing.consummated": { const l = this.lockByRef(lockId, x); if (l) this.patchLock(l.lock_id, { stage: "consummated" }); return; }
      case "loan.funded": { const l = this.lockByRef(lockId, x); if (!l) return; this.patchLock(l.lock_id, { stage: "funded", state: l.hedge_program ? "funded_unsold" : "closed_be", funded_on: typeof x.disbursement_date === "string" ? plainDate(x.disbursement_date) : plainDate(etDate(e.occurredAt)), upb_cents: cents(x.upb_cents) || l.amount_cents, cost_basis_cents: cents(x.cost_basis_cents) || l.amount_cents }); return; }
      case "delivery.submitted": { const l = this.lockByRef(lockId, x); if (l) this.patchLock(l.lock_id, { state: "delivered" }); return; }
      case "loan.purchased": { const l = this.lockByRef(lockId, x); if (l) this.patchLock(l.lock_id, { state: "purchased" }); return; }
      case "lock.cancelled": case "lock.expired": case "commitment.fallout.recorded": case "decision.issued": case "qc.review.closed": {
        if (e.type === "decision.issued" && !["denial", "withdrawal"].includes(String(x.outcome ?? x.decision))) return;
        if (e.type === "qc.review.closed" && x.outcome !== "ineligible") return;
        const l = this.lockByRef(lockId, x); if (!l || l.state === "fallout" || l.state === "purchased") return;
        const reason = this.falloutReason(e.type, String(x.reason ?? x.outcome ?? x.decision ?? "other"));
        this.recordFallout({ lock_id: l.lock_id, reason, at: e.occurredAt, rate_move_bps_at_fallout: l.rate_move_bps, dpa_incurred_cents: cents(x.dpa_cost_cents), pair_off_fee_cents: cents(x.fee_cents) }); return;
      }
      default: return;
    }
  }
  private lockByRef(lockId: string | null, x: Record<string, unknown>): PipelineLock | null {
    if (lockId && this.locks.has(lockId)) return this.locks.get(lockId)!;
    const byLineage = typeof x.lineage_id === "string" ? [...this.locks.values()].find((l) => l.lineage_id === x.lineage_id && l.state !== "fallout") : undefined; if (byLineage) return byLineage;
    const byApp = typeof x.application_id === "string" ? [...this.locks.values()].find((l) => l.application_id === x.application_id && l.state !== "fallout") : undefined; return byApp ?? null;
  }
  private falloutReason(type: string, raw: string): FalloutReasonCode {
    if (type === "lock.expired") return "expired_unclosed"; if (type === "qc.review.closed") return "ineligible";
    if (["borrower_withdrawal", "withdrawal", "borrower_request"].includes(raw)) return "borrower_withdrawal"; if (["lender_declination", "denial", "denied"].includes(raw)) return "lender_declination";
    if (raw.includes("relock")) return "relock_elsewhere"; if (raw.includes("ineligible")) return "ineligible"; if (raw === "failure_to_deliver") return "closed_undeliverable"; return "other";
  }
  recordFallout(i: { lock_id: string; reason: FalloutReasonCode; at?: string; rate_move_bps_at_fallout?: number; dpa_incurred_cents?: Cents; pair_off_fee_cents?: Cents }): FalloutEvent {
    const l = this.lock(i.lock_id); const at = i.at ?? this.now();
    const row: FalloutEvent = { fallout_id: randomUUID(), lock_id: l.lock_id, commitment_id: l.commitment_id, occurred_at: at, stage: l.stage, reason: i.reason, rate_move_bps_at_fallout: i.rate_move_bps_at_fallout ?? l.rate_move_bps, days_in_pipeline: daysBetween(plainDate(etDate(l.locked_at)), plainDate(etDate(at))), dpa_incurred_cents: i.dpa_incurred_cents ?? 0n, pair_off_fee_cents: i.pair_off_fee_cents ?? 0n };
    this.fallouts.push(row); this.patchLock(l.lock_id, { state: i.reason === "closed_undeliverable" ? "closed_undeliverable" : "fallout" });
    this.emit("fallout.recorded", { fallout_id: row.fallout_id, lock_id: row.lock_id, commitment_id: row.commitment_id, reason: row.reason, stage: row.stage, rate_move_bps_at_fallout: row.rate_move_bps_at_fallout, days_in_pipeline: row.days_in_pipeline }, { applicationId: l.application_id, aggregate: { kind: "application", id: l.application_id } });
    return row;
  }
  /** The intraday watch: a price ≥ 12.5 bps away from the last snapshot's emits `pipeline.price_move.detected`. */
  observePrice(i: { whole_loan_price?: string; tba_price?: string; at?: string }): { triggered: boolean; move_bps: string | null } {
    const last = i.whole_loan_price !== undefined ? this.lastPrices.whole_loan : this.lastPrices.tba; const cur = i.whole_loan_price ?? i.tba_price;
    if (!cur || !last) return { triggered: false, move_bps: null };
    const m = priceMoveTrigger(last, cur); if (m.triggered) this.emit("pipeline.price_move.detected", { move_bps: m.move_bps, threshold_bps: PRICE_MOVE_THRESHOLD_BPS, instrument: i.whole_loan_price !== undefined ? "whole_loan" : "tba", at: i.at ?? this.now() });
    return { triggered: m.triggered, move_bps: m.move_bps };
  }

  // ---- Pull-through (rule 2)
  estimatePullThrough(lockId: string, i: { at?: string; rate_move_bps?: number } = {}): PullThroughEstimate {
    const l = this.lock(lockId); const at = i.at ?? this.now(); const bps = i.rate_move_bps ?? l.rate_move_bps;
    const prob = l.probability_override ?? pullThroughProbability({ stage: l.stage, rate_move_bps: bps, transaction_type: l.transaction_type, model: this.model() }).probability;
    const row: PullThroughEstimate = { estimate_id: randomUUID(), lock_id: l.lock_id, as_of: at, model_id: this.model().model_id, stage: l.stage, rate_move_bps: bps, days_to_expiry: l.expires_on ? daysBetween(plainDate(etDate(at)), l.expires_on) : null, probability: prob, expected_deliverable_cents: expectedDeliverableCents([{ amount_cents: l.amount_cents, probability: prob }]) };
    this.estimates.push(row); if (bps !== l.rate_move_bps) this.patchLock(l.lock_id, { rate_move_bps: bps });
    this.emit("pull_through.estimated", { estimate_id: row.estimate_id, lock_id: row.lock_id, model_id: row.model_id, model_version: this.model().version, stage: row.stage, rate_move_bps: bps, probability: prob, expected_deliverable_cents: String(row.expected_deliverable_cents) }, { applicationId: l.application_id, aggregate: { kind: "application", id: l.application_id } });
    return row;
  }

  // ---- The daily / intraday position (rules 1, 3, 12, 13)
  takeSnapshot(i: { at?: string; whole_loan_price?: string | null; tba_price?: string | null; price_source?: string; intraday?: boolean; duration?: string; duration_factor?: string; rate_move_bps?: number; dpa_exposures?: readonly { commitment_id: string; dpa_exposure_until: PlainDate }[]; extension_carry_accrued_cents?: Cents; flags?: Record<string, unknown> } = {}): PipelinePosition {
    const at = i.at ?? this.now(); const pol = this.policy(); const asOf = plainDate(etDate(at));
    const mode: ExecutionMode = this.mandatoryEnabled(i.flags ?? {}) && pol?.execution_mode === "mandatory" ? "mandatory" : "best_efforts";
    const df = i.duration_factor ?? pol?.default_duration_factor ?? DEFAULT_HEDGE_POLICY.default_duration_factor; const duration = i.duration ?? pol?.default_duration ?? DEFAULT_HEDGE_POLICY.default_duration;
    const wl = i.whole_loan_price ?? this.lastPrices.whole_loan; const tba = i.tba_price ?? this.lastPrices.tba;
    const live = [...this.locks.values()].filter((l) => l.state !== "purchased" && l.state !== "fallout");
    const sum = (st: LockExposureState): Cents => live.filter((l) => l.state === st).reduce((s, l) => s + l.amount_cents, 0n);
    const rows = live.map((l) => { const prob = l.probability_override ?? pullThroughProbability({ stage: l.stage, rate_move_bps: i.rate_move_bps ?? l.rate_move_bps, transaction_type: l.transaction_type, model: this.model() }).probability; return { lock_id: l.lock_id, state: l.state, stage: l.stage, probability: prob, amount_cents: l.amount_cents, hedge: l.hedge_program }; });
    const covered = rows.filter((r) => r.hedge && (r.state === "mandatory_pipeline" || r.state === "funded_unsold"));
    const expected = expectedDeliverableCents(covered);
    const hedgeFace = this.positions.filter((x) => x.status === "open" && x.side === "sell").reduce((s, x) => s + x.face_cents, 0n);
    const cov = mode === "mandatory" ? computeCoverage({ hedge_face_cents: hedgeFace, duration_factor: df, expected_deliverable_cents: expected, coverage_band_low: pol?.coverage_band_low ?? DEFAULT_HEDGE_POLICY.coverage_band_low, coverage_band_high: pol?.coverage_band_high ?? DEFAULT_HEDGE_POLICY.coverage_band_high }) : null;
    const hedgeValue = tba ? this.positions.filter((x) => x.status === "open" && x.instrument !== "fnma_mandatory_commitment").reduce((s, x) => s + hedgeFairValue(x.face_cents, x.trade_price, tba, x.side), 0n) : 0n;
    const pipelineValue = wl ? covered.reduce((s, r) => { const l = this.lock(r.lock_id); return s + fromCents(l.amount_cents).mul(dec(r.probability)).mul(dec(wl).sub(dec(l.commitment_price ?? l.lock_base_price))).div(HUNDRED).toCents("HALF_UP"); }, 0n) : 0n;
    const lockedUncommitted = sum("locked_uncommitted");
    const shocks: Record<string, Cents> = {}; for (const s of SHOCKS_BPS) shocks[String(s)] = uncommittedExposureCents(lockedUncommitted, s, duration);
    const undeliverable = live.filter((l) => l.state === "closed_undeliverable");
    const buckets = new Map<string, { key: string; state: LockExposureState; amount_cents: Cents; count: number }>();
    for (const l of live) { const key = `${l.product_code}|${l.amortization}|${dec(l.note_rate).toFixed(3, "HALF_UP")}|${l.ptr}|${l.state}`; const b = buckets.get(key) ?? { key, state: l.state, amount_cents: 0n, count: 0 }; buckets.set(key, { ...b, amount_cents: b.amount_cents + l.amount_cents, count: b.count + 1 }); }
    const snap: PipelinePosition = { snapshot_id: randomUUID(), as_of: at, execution_mode: mode, intraday: i.intraday ?? false, locked_uncommitted_cents: lockedUncommitted, committed_be_cents: sum("committed_be"), closed_be_cents: sum("closed_be"), mandatory_pipeline_cents: sum("mandatory_pipeline"), funded_unsold_cents: sum("funded_unsold"),
      expected_pull_through_pct: covered.length ? f4(fromCents(expected).div(fromCents(covered.reduce((s, r) => s + r.amount_cents, 0n))).mul(HUNDRED)) : null, expected_deliverable_cents: expected, hedge_face_cents: hedgeFace, duration_factor: df, coverage_ratio: cov?.coverage_ratio ?? null, within_band: cov?.within_band ?? true, whole_loan_mark_price: wl ?? null, tba_mark_price: tba ?? null,
      pipeline_value_cents: pipelineValue, hedge_value_cents: hedgeValue, net_value_cents: pipelineValue + hedgeValue, expirations_7d: live.filter((l) => l.commitment_id && l.commitment_expires_on && daysBetween(asOf, l.commitment_expires_on) <= 7 && l.commitment_expires_on >= asOf).map((l) => ({ commitment_id: l.commitment_id!, amount_cents: l.amount_cents, expires_on: l.commitment_expires_on! })),
      dpa_exposures: i.dpa_exposures ?? [], undeliverable_closed_cents: undeliverable.reduce((s, l) => s + l.amount_cents, 0n), pair_off_risk_cents: wl ? pairOffRiskCents(undeliverable.filter((l) => l.commitment_price).map((l) => ({ amount_cents: l.amount_cents, commitment_price: l.commitment_price!, market_price: wl }))) : 0n, extension_carry_accrued_cents: i.extension_carry_accrued_cents ?? 0n,
      residual_shocks: shocks, buckets: [...buckets.values()], price_source: i.price_source ?? "pewl_live+hedge-feed", locks: rows.map(({ hedge: _h, ...r }) => { void _h; return r; }) };
    this.snapshots.push(snap); if (wl) this.lastPrices.whole_loan = wl; if (tba) this.lastPrices.tba = tba;
    this.emit("pipeline.snapshot.taken", { snapshot_id: snap.snapshot_id, as_of: at, execution_mode: mode, intraday: snap.intraday, locked_uncommitted_cents: String(lockedUncommitted), expected_deliverable_cents: String(expected), hedge_face_cents: String(hedgeFace), coverage_ratio: snap.coverage_ratio, coverage_checked: true, within_band: snap.within_band, coverage_outside_band: !snap.within_band, page_officer: cov?.page_officer_within_1h ?? false, model_version: this.model().version, clock_anchor_on: asOf });
    if (cov && !cov.within_band && cov.page_officer_within_1h) this.officer("officer_coverage_page", { snapshot_id: snap.snapshot_id, coverage_ratio: cov.coverage_ratio, band: cov.band, page_within: "1 hour" }, "sev2");
    return snap;
  }
  lastSnapshot(): PipelinePosition | null { return this.snapshots.at(-1) ?? null; }

  // ---- Trade packages (rules 3, 4; AI design guardrails) — T3, T4, T10
  private assertMandatory(flags: Record<string, unknown>, what: string): void { if (!this.mandatoryEnabled(flags)) throw new PipelineRefused("MANDATORY_DISABLED", `${what} refused: execution.mandatory_enabled=false (best-efforts mode has no hedge)`); }
  prepareTradePackage(i: { side: "sell" | "buy"; instrument: HedgeInstrument; face_cents: Cents; coupon?: string | null; settlement_month?: PlainDate | null; price_expectation?: string | null; rationale?: string; kind?: TradePackage["kind"]; position_id?: string | null; alternatives?: readonly { description: string; cost_cents: Cents }[]; at?: string; flags?: Record<string, unknown>; expected_delivery_on?: PlainDate | null }): TradePackage {
    const flags = i.flags ?? {}; const at = i.at ?? this.now(); this.assertMandatory(flags, "prepareTradePackage");
    const pol = this.policy(); if (!pol) throw new PipelineRefused("NO_HEDGE_POLICY", "no approved hedge policy version");
    positive(i.face_cents, "face_cents");
    const checks: { check: string; passed: boolean }[] = [{ check: `instrument ${i.instrument} within hedge_policies.instruments`, passed: pol.instruments.includes(i.instrument) }, { check: "execution.mandatory_enabled", passed: true }, { check: "authorized by the partner officer/trader (hedge.auto_execute_within_band=false)", passed: !pol.auto_execute_within_band }];
    let settlement = i.settlement_month ?? null; const cls = instrumentClass(i.instrument);
    if (cls && !settlement && i.expected_delivery_on) settlement = settlementMonthFor(i.expected_delivery_on, cls, plainDate(etDate(at)), pol.roll_lead_business_days, this.cal).settlement_month;
    if (cls && settlement) { const sd = sifmaDates(settlement, cls); const rd = rollDueOn(sd.notification_date, pol.roll_lead_business_days, this.cal).roll_due_on; checks.push({ check: `settlement ${settlement} outside the ${pol.roll_lead_business_days}-business-day roll lead of ${sd.notification_date}`, passed: plainDate(etDate(at)) < rd }); }
    const failed = checks.filter((c) => !c.passed); if (failed.length) throw new PipelineRefused("OUTSIDE_HEDGE_POLICY", failed.map((c) => c.check).join("; "));
    const description = tradeDescription({ side: i.side, face_cents: i.face_cents, instrument: i.instrument, coupon: i.coupon ?? null, settlement_month: settlement });
    const priceText = i.price_expectation ? ` at ${i.price_expectation}` : "";
    const pkg: TradePackage = { package_id: randomUUID(), kind: i.kind ?? "open", side: i.side, instrument: i.instrument, coupon: i.coupon ?? null, settlement_month: settlement, face_cents: i.face_cents, price_expectation: i.price_expectation ?? null, description: `${description}${priceText}`, rationale: i.rationale ?? "hedge program coverage", policy_checks: checks, alternatives: i.alternatives ?? [], escalation_id: "", status: "recommended", position_id: i.position_id ?? null, prepared_at: at, model_version: this.model().version };
    const escalationId = this.officer("officer_trade_authorization", { package_id: pkg.package_id, description: pkg.description, side: pkg.side, instrument: pkg.instrument, face_cents: String(pkg.face_cents), price_expectation: pkg.price_expectation, rationale: pkg.rationale, policy_checks: checks, alternatives: pkg.alternatives.map((a) => ({ description: a.description, cost_cents: String(a.cost_cents) })), executes: "the partner's trader with the broker-dealer (never the platform)" });
    const withEsc = { ...pkg, escalation_id: escalationId }; this.packages.push(withEsc);
    this.emit("hedge.rebalance.recommended", { package_id: pkg.package_id, delta_face_cents: String(i.side === "sell" ? i.face_cents : -i.face_cents), instrument: i.instrument, rationale: pkg.rationale, description: pkg.description, escalation_id: escalationId, model_version: pkg.model_version });
    return withEsc;
  }
  /** Rule 3 end to end: coverage from the last snapshot (or the given figures) → a package when outside the band (the same day). */
  recommendRebalance(i: { at?: string; hedge_face_cents?: Cents; expected_deliverable_cents?: Cents; duration_factor?: string; instrument?: HedgeInstrument; mark_price?: string; trade_price?: string; coupon?: string | null; settlement_month?: PlainDate | null; flags?: Record<string, unknown> } = {}): Rebalance & { package: TradePackage | null } {
    const pol = this.policy(); const snap = this.lastSnapshot();
    const face = i.hedge_face_cents ?? snap?.hedge_face_cents ?? 0n; const expected = i.expected_deliverable_cents ?? snap?.expected_deliverable_cents ?? 0n; const df = i.duration_factor ?? snap?.duration_factor ?? DEFAULT_HEDGE_POLICY.default_duration_factor;
    const instrument = i.instrument ?? this.positions.find((x) => x.status === "open")?.instrument ?? pol?.instruments[0] ?? "fnma_mandatory_commitment";
    const open = this.positions.find((x) => x.status === "open" && x.instrument === instrument);
    const low = this.hedgeRatioMode === "conservative_band_edge" ? pol?.coverage_band_low ?? DEFAULT_HEDGE_POLICY.coverage_band_low : undefined;
    const r = recommendRebalance({ hedge_face_cents: face, expected_deliverable_cents: this.hedgeRatioMode === "conservative_band_edge" && low ? fromCents(expected).mul(dec(low)).toCents("HALF_UP") : expected, duration_factor: df, coverage_band_low: pol?.coverage_band_low ?? DEFAULT_HEDGE_POLICY.coverage_band_low, coverage_band_high: pol?.coverage_band_high ?? DEFAULT_HEDGE_POLICY.coverage_band_high, instrument, ...(i.mark_price ? { mark_price: i.mark_price } : {}), ...(i.trade_price ?? open?.trade_price ? { trade_price: i.trade_price ?? open!.trade_price } : {}), dealer_min_lot_cents: pol?.dealer_min_lot_cents ?? DEFAULT_HEDGE_POLICY.dealer_min_lot_cents, coupon: i.coupon ?? open?.coupon ?? "6.000", ...(i.settlement_month ?? open?.settlement_month ? { settlement_month: (i.settlement_month ?? open!.settlement_month)! } : {}) });
    if (r.action === "none" || !this.mandatoryEnabled(i.flags ?? {})) return { ...r, package: null };
    const pkg = this.prepareTradePackage({ side: r.action === "buy_back" ? "buy" : "sell", instrument, face_cents: r.face_cents, coupon: i.coupon ?? open?.coupon ?? null, settlement_month: i.settlement_month ?? open?.settlement_month ?? null, price_expectation: i.mark_price ?? null, rationale: r.rationale, kind: "rebalance", position_id: open?.position_id ?? null, at: i.at ?? this.now(), flags: i.flags ?? {}, alternatives: r.realized_pl_estimate_cents !== null ? [{ description: `pair-off cost of the over-hedge at ${i.mark_price}`, cost_cents: -r.realized_pl_estimate_cents }] : [] });
    return { ...r, package: pkg };
  }
  authorizeTradePackage(i: { package_id: string; at?: string; authorized_by: Actor }): TradePackage {
    const k = this.packages.findIndex((x) => x.package_id === i.package_id); if (k < 0) throw new RangeError(`no package ${i.package_id}`);
    if (i.authorized_by.kind !== "human" || i.authorized_by.role !== "officer") throw new PipelineRefused("OFFICER_AUTHORIZATION", "a trade package is authorized by the partner officer/trader, never by an agent");
    const e = this.esc.list().find((x) => x.id === this.packages[k]!.escalation_id); if (e && e.status !== "completed") this.esc.complete(e.id, i.authorized_by);
    const pkg = { ...this.packages[k]!, status: "authorized" as const }; this.packages[k] = pkg;
    this.emit("hedge.trade.authorized", { package_id: pkg.package_id, escalation_id: pkg.escalation_id, authorized_by: i.authorized_by.id, at: i.at ?? this.now() });
    return pkg;
  }
  package(id: string): TradePackage { const x = this.packages.find((k) => k.package_id === id); if (!x) throw new RangeError(`no package ${id}`); return x; }
  position(id: string): HedgePosition { const x = this.positions.find((k) => k.position_id === id); if (!x) throw new RangeError(`no hedge position ${id}`); return x; }
  private setPosition(next: HedgePosition): HedgePosition { const k = this.positions.findIndex((x) => x.position_id === next.position_id); if (k < 0) this.positions.push(next); else this.positions[k] = next; return next; }
  /** A position is recorded from the confirmation only — never on an AI decision, never without the confirmation document. */
  recordTradeConfirmation(i: { kind: TradeKind; face_cents: Cents; price: string; executed_at?: string; executed_by: string; confirmation_document_id: string | null; package_id?: string | null; position_id?: string | null; instrument?: HedgeInstrument; side?: "sell" | "buy"; coupon?: string | null; settlement_month?: PlainDate | null; counterparty_id?: string; commitment_id?: string | null; authorized_by?: string | null; roll_open?: { price: string; settlement_month: PlainDate; confirmation_document_id: string } | null }): { position: HedgePosition; trade: HedgeTrade; next_position: HedgePosition | null } {
    if (!i.confirmation_document_id) throw new PipelineRefused("CONFIRMATION_REQUIRED", "no trade is recorded until the dealer confirmation document is attached");
    positive(i.face_cents, "face_cents"); const at = i.executed_at ?? this.now(); const pol = this.policy();
    const pkg = i.package_id ? this.package(i.package_id) : null;
    if (pkg && pkg.status !== "authorized" && pkg.status !== "executed") throw new PipelineRefused("TRADE_NOT_AUTHORIZED", `package ${pkg.package_id} is ${pkg.status}: the partner officer/trader authorizes before execution`);
    let position: HedgePosition; let next: HedgePosition | null = null; let realized: Cents | null = null;
    if (i.kind === "open" || i.kind === "roll_open") {
      const instrument = i.instrument ?? pkg?.instrument ?? "tba_umbs_30"; const cls = instrumentClass(instrument); const settle = i.settlement_month ?? pkg?.settlement_month ?? null;
      const sd = cls && settle ? sifmaDates(settle, cls) : null; const roll = sd ? rollDueOn(sd.notification_date, pol?.roll_lead_business_days ?? DEFAULT_HEDGE_POLICY.roll_lead_business_days, this.cal).roll_due_on : null;
      position = this.setPosition({ position_id: randomUUID(), partner_id: this.partnerId, instrument, coupon: i.coupon ?? pkg?.coupon ?? null, settlement_month: sd?.settlement_month ?? settle, sifma_class: cls, notification_date: sd?.notification_date ?? null, settlement_date: sd?.settlement_date ?? null, side: i.side ?? pkg?.side ?? "sell", face_cents: i.face_cents, original_face_cents: i.face_cents, trade_price: i.price, trade_date: plainDate(etDate(at)), trade_time_et: `${String(etWallHour(at).hour).padStart(2, "0")}:${String(etWallHour(at).minute).padStart(2, "0")}`, counterparty_id: i.counterparty_id ?? (instrument === "fnma_mandatory_commitment" ? "fannie_mae" : "dealer-a"), commitment_id: i.commitment_id ?? null, status: "open", roll_due_on: roll, mark_price: null, mark_cents: null, marked_at: null, realized_pl_cents: 0n, authorized_by: i.authorized_by ?? pkg?.escalation_id ?? null, agent_decision_id: null, confirmation_document_id: i.confirmation_document_id });
    } else {
      const cur = this.position(i.position_id ?? pkg?.position_id ?? ""); if (cur.status !== "open") throw new PipelineRefused("POSITION_NOT_OPEN", `position ${cur.position_id} is ${cur.status}`);
      if (i.face_cents > cur.face_cents) throw new RangeError(`face ${dollars(i.face_cents)} exceeds the open ${dollars(cur.face_cents)}`);
      realized = cur.side === "sell" ? tbaPairOffPl(i.face_cents, cur.trade_price, i.price) : -tbaPairOffPl(i.face_cents, cur.trade_price, i.price);
      const remaining = cur.face_cents - i.face_cents; const flat = remaining === 0n;
      const status: HedgePositionStatus = !flat ? "open" : i.kind === "roll_close" ? "rolled" : i.kind === "assign_to_commitment" ? "closed" : "paired_off";
      position = this.setPosition({ ...cur, face_cents: flat ? cur.face_cents : remaining, status, realized_pl_cents: cur.realized_pl_cents + realized, mark_price: i.price, marked_at: at });
      if (i.kind === "roll_close" && i.roll_open) next = this.recordTradeConfirmation({ kind: "roll_open", face_cents: i.face_cents, price: i.roll_open.price, executed_at: at, executed_by: i.executed_by, confirmation_document_id: i.roll_open.confirmation_document_id, instrument: cur.instrument, side: cur.side, coupon: cur.coupon, settlement_month: i.roll_open.settlement_month, counterparty_id: cur.counterparty_id, authorized_by: i.authorized_by ?? null }).position;
    }
    const trade: HedgeTrade = { trade_id: randomUUID(), position_id: position.position_id, kind: i.kind, face_cents: i.face_cents, price: i.price, executed_at: at, executed_by: i.executed_by, confirmation_document_id: i.confirmation_document_id, realized_pl_cents: realized };
    this.trades.push(trade);
    if (pkg) { const k = this.packages.findIndex((x) => x.package_id === pkg.package_id); this.packages[k] = { ...pkg, status: "executed", position_id: position.position_id }; }
    const agg = { kind: "hedge_position", id: position.position_id };
    this.emit("hedge.trade.executed", { trade_id: trade.trade_id, position_id: position.position_id, kind: i.kind, instrument: position.instrument, side: position.side, face_cents: String(i.face_cents), price: i.price, executed_at: at, executed_by: i.executed_by, confirmation_document_id: i.confirmation_document_id, settlement_month: position.settlement_month, notification_date: position.notification_date, roll_due_on: position.roll_due_on, realized_pl_cents: realized === null ? null : String(realized), package_id: pkg?.package_id ?? null }, { aggregate: agg });
    if (position.status === "rolled") this.emit("hedge.position.rolled", { position_id: position.position_id, next_position_id: next?.position_id ?? null, realized_pl_cents: String(position.realized_pl_cents), at }, { aggregate: agg });
    if (position.status === "paired_off" || position.status === "closed") this.emit("hedge.position.paired_off", { position_id: position.position_id, realized_pl_cents: String(position.realized_pl_cents), how: position.status === "closed" ? "assigned_to_commitment" : "pair_off", at }, { aggregate: agg });
    if (this.snapshots.length) this.takeSnapshot({ at, intraday: true, price_source: "coverage check after hedge.trade.executed" });
    return { position, trade, next_position: next };
  }
  /** Rule 9: the roll recommendation for a TBA position (front month flat by `roll_due_on` 12:00 p.m. ET; pair off instead when the covered loans will have been delivered). */
  scheduleRoll(i: { position_id: string; at?: string; covered_delivered_by_notification?: boolean }): { position_id: string; roll_due_on: PlainDate; roll_due_at: string; notification_date: PlainDate; back_month: SifmaClassDates; recommendation: "roll" | "pair_off"; description: string } {
    const x = this.position(i.position_id); if (!x.notification_date || !x.sifma_class || !x.settlement_month) throw new RangeError(`position ${x.position_id} is not a TBA position`);
    const pol = this.policy(); const lead = pol?.roll_lead_business_days ?? DEFAULT_HEDGE_POLICY.roll_lead_business_days; const roll = rollDueOn(x.notification_date, lead, this.cal);
    const back = sifmaDates(addMonths(x.settlement_month, 1), x.sifma_class); const rec = i.covered_delivered_by_notification ? "pair_off" : "roll";
    return { position_id: x.position_id, roll_due_on: roll.roll_due_on, roll_due_at: roll.roll_due_at, notification_date: x.notification_date, back_month: back, recommendation: rec, description: rec === "roll" ? `close ${tradeDescription({ side: x.side === "sell" ? "buy" : "sell", face_cents: x.face_cents, instrument: x.instrument, coupon: x.coupon, settlement_month: x.settlement_month })}; open ${tradeDescription({ side: x.side, face_cents: x.face_cents, instrument: x.instrument, coupon: x.coupon, settlement_month: back.settlement_month })} by ${roll.roll_due_on} 12:00 ET` : `pair off ${dollars(x.face_cents)} ${x.instrument} by ${roll.roll_due_on} 12:00 ET (covered loans delivered)` };
  }
  /** Rule 10: the hedge migrates into the actual forward sale — a short Fannie Mae mandatory commitment for the closed balance (29.1 executes it) with the equivalent TBA face paired off. */
  requestMandatoryCommitment(i: { amount_cents: Cents; product: string; ptr_range: { low: string; high: string }; period_days: number; officer_authorization: { escalation_id: string; status: string } | null; at?: string; flags?: Record<string, unknown>; pair_off_position_id?: string | null }): { request_id: string; event: DomainEvent; pair_off_recommendation: string | null } {
    this.assertMandatory(i.flags ?? {}, "requestMandatoryCommitment"); positive(i.amount_cents, "amount_cents");
    const esc = i.officer_authorization ? this.esc.list().find((x) => x.id === i.officer_authorization!.escalation_id) : undefined;
    const approved = !!esc && esc.kind === "officer" && esc.status === "completed" && esc.payload.task === "officer_mandatory_authorization";
    if (!approved) throw new PipelineRefused("OFFICER_MANDATORY_AUTHORIZATION", "never request a Fannie Mae mandatory commitment without the 29.1 officer authorization (a completed officer_mandatory_authorization escalation)");
    if (!Number.isInteger(i.period_days) || i.period_days < 1 || i.period_days > 90) throw new RangeError("period_days must be 1–90 (C2-1.1-01)");
    const at = i.at ?? this.now(); const requestId = randomUUID();
    const ev = this.emit("hedge.commitment.requested", { request_id: requestId, amount_cents: String(i.amount_cents), product: i.product, ptr_range: `${i.ptr_range.low}–${i.ptr_range.high}`, ptr_range_low: i.ptr_range.low, ptr_range_high: i.ptr_range.high, period_days: i.period_days, officer_authorization_escalation_id: i.officer_authorization!.escalation_id, expires_on: addBusinessDays(addDays(plainDate(etDate(at)), i.period_days), 0, this.cal), consumer: "29.1 prepareMandatoryPackage" });
    const po = i.pair_off_position_id ? this.position(i.pair_off_position_id) : this.positions.find((x) => x.status === "open" && x.instrument !== "fnma_mandatory_commitment") ?? null;
    return { request_id: requestId, event: ev, pair_off_recommendation: po ? `pair off ${dollars(i.amount_cents < po.face_cents ? i.amount_cents : po.face_cents)} of ${po.instrument} ${po.settlement_month ?? ""} at the 8:15 a.m. ET price` : null };
  }
  /** Rule 11 / worked example 3: the daily pair-off-versus-extension package for a Fannie Mae mandatory commitment (T8). */
  prepareCommitmentDecision(i: CommitmentDecisionInput & { flags?: Record<string, unknown> }): CommitmentDecision & { escalation_id: string } {
    const d = commitmentPairOffOrExtend(i);
    const escalationId = this.officer("officer_commitment_decision", { commitment_id: i.commitment_id, pair_off: { amount_cents: String(d.pair_off.amount_cents), fee_cents: String(d.pair_off.fee_cents), cash_back_cents: String(d.pair_off.cash_back_cents) }, extension: { days: d.extension.days, amount_cents: String(d.extension.amount_cents), fee_cents: String(d.extension.fee_cents) }, recommendation: d.recommendation, decide_by: d.decide_by, rationale: d.rationale, operator: "fnma_portal_operator executes in PE–WL (29.1)" }, "sev2");
    return { ...d, escalation_id: escalationId };
  }

  // ---- Marks (rules 5, 6) — T2, T12
  runMarkToMarket(i: { at?: string; snapshot_id?: string | null; whole_loan_price: string; whole_loan_price_id: string; tba_price?: string | null; tba_price_id?: string | null; close_of_business?: boolean; stale?: readonly string[]; hfs_net_price_market?: string | null; election?: "fvo" | "locom"; realized_pl_mtd_cents?: Cents; probabilities?: Readonly<Record<string, string>> }): MarkToMarketRun {
    const at = i.at ?? this.now(); const pol = this.policy();
    if (i.close_of_business && !(i.stale ?? []).includes(i.whole_loan_price_id)) throw new PipelineRefused("COB_PRICE_UNFLAGGED", "never mark to a close-of-business PE–WL display price without flagging it");
    const snap = i.snapshot_id ? this.snapshots.find((s) => s.snapshot_id === i.snapshot_id) ?? null : this.lastSnapshot();
    const live = [...this.locks.values()].filter((l) => l.state !== "purchased" && l.state !== "fallout");
    let sale = 0n, servicing = 0n, hfs = 0n, cost = 0n;
    for (const l of live) {
      const prob = i.probabilities?.[l.lock_id] ?? snap?.locks.find((r) => r.lock_id === l.lock_id)?.probability ?? l.probability_override ?? pullThroughProbability({ stage: l.stage, rate_move_bps: l.rate_move_bps, transaction_type: l.transaction_type, model: this.model() }).probability;
      if (l.stage === "funded" && l.upb_cents) { const h = hfsFairValue({ upb_cents: l.upb_cents, net_price_market: i.hfs_net_price_market ?? i.whole_loan_price, cost_basis_cents: l.cost_basis_cents ?? l.upb_cents, ...(i.election ? { election: i.election } : {}) }); hfs += h.hfs_fv_cents; cost += l.cost_basis_cents ?? l.upb_cents; continue; }
      const market = l.state === "committed_be" && l.commitment_price ? l.commitment_price : i.whole_loan_price;   // once committed best efforts the sale-price component is locked against Fannie Mae
      const v = irlcFairValue({ amount_cents: l.amount_cents, market_price: market, lock_base_price: l.lock_base_price, probability: prob, servicing_value_multiple: pol?.servicing_value_multiple ?? DEFAULT_HEDGE_POLICY.servicing_value_multiple, servicing_fee_bps: pol?.servicing_fee_bps ?? DEFAULT_HEDGE_POLICY.servicing_fee_bps });
      sale += v.irlc_sale_price_component_cents; servicing += v.irlc_servicing_component_cents;
    }
    let hedge = 0n;
    for (const x of this.positions) { if (x.status !== "open") continue; const mark = x.instrument === "fnma_mandatory_commitment" ? i.whole_loan_price : i.tba_price ?? x.mark_price; if (!mark) continue; const mc = hedgeFairValue(x.face_cents, x.trade_price, mark, x.side); hedge += mc; this.setPosition({ ...x, mark_price: mark, mark_cents: mc, marked_at: at }); }
    const irlc = sale + servicing; const net = irlc + hfs + hedge; const prev = this.mtmRuns.filter((r) => etDate(r.as_of) < etDate(at)).at(-1);
    const sources: Record<string, string> = { whole_loan: i.whole_loan_price_id, ...(i.tba_price_id ? { tba: i.tba_price_id } : {}) };
    const exportBody = { as_of: at, snapshot_id: snap?.snapshot_id ?? null, price_sources: sources, irlc_fv: String(irlc), irlc_sale_price_component: String(sale), irlc_servicing_component: String(servicing), hfs_fv: String(hfs), hfs_cost_basis: String(cost), hedge_fv: String(hedge), net_fv: String(net), day_change: String(net - (prev?.net_fv_cents ?? 0n)), realized_pl_mtd: String(i.realized_pl_mtd_cents ?? this.trades.reduce((s, t) => (etDate(t.executed_at).slice(0, 7) === etDate(at).slice(0, 7) ? s + (t.realized_pl_cents ?? 0n) : s), 0n)), stale_prices: [...(i.stale ?? [])], elections: { hfs: i.election ?? "fvo", hedge_accounting: "none (economic hedge through earnings)" } };
    const h = hash(exportBody);
    const run: MarkToMarketRun = { run_id: randomUUID(), as_of: at, snapshot_id: snap?.snapshot_id ?? "", price_sources: sources, irlc_fv_cents: irlc, irlc_sale_price_component_cents: sale, irlc_servicing_component_cents: servicing, hfs_loans_fv_cents: hfs, hfs_loans_cost_basis_cents: cost, hedge_fv_cents: hedge, net_fv_cents: net, day_change_cents: net - (prev?.net_fv_cents ?? 0n), realized_pl_mtd_cents: BigInt(exportBody.realized_pl_mtd), stale_prices: [...(i.stale ?? [])], gl_export_document_id: `gl-export-${h}`, exported_at: at, export_hash: h, gl_export: exportBody };
    this.mtmRuns.push(run);
    this.emit("mtm.run.completed", { run_id: run.run_id, snapshot_id: run.snapshot_id, gl_exported: true, gl_export_document_id: run.gl_export_document_id, exported_at: at, export_hash: h, irlc_fv_cents: String(irlc), hfs_fv_cents: String(hfs), hedge_fv_cents: String(hedge), net_fv_cents: String(net), day_change_cents: String(run.day_change_cents), price_sources: sources, stale_prices: run.stale_prices, clock_anchor_on: plainDate(etDate(at)) });
    return run;
  }
  // ---- Rate shock and liquidity (rules 7, 8) — T7
  runRateShock(i: Omit<RateShockInput, "rate_shock_limit_cents"> & { at?: string; rate_shock_limit_cents?: Readonly<Record<string, Cents>> }): RateShockReport {
    const at = i.at ?? this.now(); const pol = this.policy();
    const limits = i.rate_shock_limit_cents ?? pol?.rate_shock_limit_cents ?? {};
    const rows = rateShockTable({ ...i, rate_shock_limit_cents: limits });
    const report: RateShockReport = { report_id: randomUUID(), as_of: at, shocks: rows, limits_checked: rows.map((r) => ({ shock_bps: r.shock_bps, limit_cents: r.limit_cents, breached: r.limit_breached })), published_document_id: `rate-shock-${hash(rows)}` };
    this.shockReports.push(report);
    const breached = rows.filter((r) => r.limit_breached).map((r) => r.shock_bps);
    this.emit("rate_shock.report.published", { report_id: report.report_id, document_id: report.published_document_id, limits_breached: breached, clock_anchor_on: plainDate(etDate(at)) });
    if (breached.length) this.officer("officer_rate_shock_limit", { report_id: report.report_id, shocks_breached: breached }, "sev2");
    return report;
  }
  computeLiquidityNeed(i: Omit<LiquidityInput, "as_of" | "reserve_cents"> & { at?: string; reserve_cents?: Cents }): ReturnType<typeof computeLiquidityNeed> & { report_id: string; as_of: string } {
    const at = i.at ?? this.now(); const pol = this.policy(); const asOf = plainDate(etDate(at));
    const r = computeLiquidityNeed({ ...i, as_of: asOf, reserve_cents: i.reserve_cents ?? pol?.margin_liquidity_reserve_cents ?? 0n });
    const report = { ...r, report_id: randomUUID(), as_of: at }; this.liquidityReports.push(report);
    this.emit("liquidity.report.published", { report_id: report.report_id, liquidity_need_cents: String(r.liquidity_need_cents), reserve_cents: String(r.reserve_cents), shortfall_cents: String(r.shortfall_cents), shortfall_on: r.shortfall_on, liquidity_review_on: nextFridayOnOrAfter(addDays(asOf, 1)), clock_anchor_on: asOf });
    if (r.shortfall_cents > 0n) this.officer("officer_liquidity_shortfall", { report_id: report.report_id, shortfall_cents: String(r.shortfall_cents), shortfall_on: r.shortfall_on }, "sev1");
    return report;
  }
  // ---- FINRA 4210 margin — T6
  recordMarginCall(i: { counterparty_id: string; received_at?: string; amount_cents: Cents; basis?: Record<string, unknown>; due_hhmm?: string | null }): MarginCall {
    const at = i.received_at ?? this.now(); positive(i.amount_cents, "amount_cents");
    const due = marginCallDue(at, this.cal, i.due_hhmm ?? null);
    const escalationId = this.officer("officer_margin_call", { counterparty_id: i.counterparty_id, amount_cents: String(i.amount_cents), due_at: due.due_at, wire: "26.3 rail under funding_approver dual control" }, "sev2");
    const call: MarginCall = { call_id: randomUUID(), counterparty_id: i.counterparty_id, received_at: at, amount_cents: i.amount_cents, basis: i.basis ?? {}, due_on: due.due_on, due_at: due.due_at, funded_at: null, wire_id: null, status: "open", escalation_id: escalationId };
    this.marginCalls.push(call);
    this.emit("margin.call.received", { call_id: call.call_id, counterparty_id: call.counterparty_id, amount_cents: String(call.amount_cents), received_at: at, received_on: plainDate(etDate(at)), due_on: call.due_on, due_at: call.due_at, escalation_id: escalationId }, { aggregate: { kind: "margin_call", id: call.call_id } });
    return call;
  }
  fundMarginCall(i: { call_id: string; wire_id: string; released_at?: string; approvals: readonly WireApproval[] }): MarginCall {
    const k = this.marginCalls.findIndex((c) => c.call_id === i.call_id); if (k < 0) throw new RangeError(`no margin call ${i.call_id}`);
    const dc = dualControlSatisfied(i.approvals); if (!dc.satisfied) throw new PipelineRefused("DUAL_CONTROL", dc.reason!);
    const at = i.released_at ?? this.now(); const call = { ...this.marginCalls[k]!, funded_at: at, wire_id: i.wire_id, status: "funded" as const }; this.marginCalls[k] = call;
    this.emit("margin.call.funded", { call_id: call.call_id, wire_id: i.wire_id, amount_cents: String(call.amount_cents), funded_at: at, late: at > call.due_at, approvals: i.approvals.map((a) => ({ actor_id: a.actor_id, role: a.role })) }, { aggregate: { kind: "margin_call", id: call.call_id } });
    return call;
  }
  disputeMarginCall(i: { call_id: string; reason: string }): MarginCall { const k = this.marginCalls.findIndex((c) => c.call_id === i.call_id); if (k < 0) throw new RangeError(`no margin call ${i.call_id}`); const call = { ...this.marginCalls[k]!, status: "disputed" as const }; this.marginCalls[k] = call; this.officer("officer_margin_dispute", { call_id: call.call_id, reason: i.reason }, "sev2"); return call; }

  // ---- Fallout review and model governance (rules 2, 14) — T9
  analyzeFallout(i: { cohort: string; locks: number; fallouts: number; predicted_pct: string; reasons?: readonly FalloutReason[]; review_on?: PlainDate; at?: string }): ReturnType<typeof analyzeFalloutCohort> & { review_on: PlainDate; report_id: string; escalation_id: string | null; o12_2_review_requested: boolean; next_review_on: PlainDate } {
    const at = i.at ?? this.now(); const reviewOn = i.review_on ?? nextFalloutReviewOn(plainDate(etDate(at)), this.cal);
    const r = analyzeFalloutCohort(i); const nextReview = nextFalloutReviewOn(addDays(reviewOn, 1), this.cal);
    let escalationId: string | null = null;
    if (r.recalibration_proposed) { this.hedgeRatioMode = "conservative_band_edge"; escalationId = this.officer("officer_pull_through_recalibration", { cohort: i.cohort, realized_pct: r.realized_pct, predicted_pct: r.predicted_pct, difference_points: r.difference_points, proposal: "recalibrate the pull-through model (new pull_through_models version); 31.2 model-inventory review", hedge_ratio_mode: r.hedge_ratio_mode }, "sev3"); this.models.push({ ...this.model(), model_id: `${this.model().model_id}.proposed`, version: `${this.model().version}+recal-${i.cohort}`, status: "proposed", approved_by: null, o12_2_review_id: null }); }
    const report = this.publishPartnerReport({ kind: "fallout_review", at, body: { review_on: reviewOn, ...r, reasons: r.reasons, consumers: ["21.4 lock policy", "20.4 rate-sheet cushion"] }, snapshot_ids: this.lastSnapshot() ? [this.lastSnapshot()!.snapshot_id] : [] });
    this.emit("fallout.report.published", { report_id: report.report_id, review_on: reviewOn, cohort: i.cohort, locks: i.locks, fallouts: i.fallouts, realized_pct: r.realized_pct, predicted_pct: r.predicted_pct, difference_points: r.difference_points, recalibration_proposed: r.recalibration_proposed, hedge_ratio_mode: r.hedge_ratio_mode, reasons: r.reasons, consumers: ["21.4"], escalation_id: escalationId, fallout_review_on: nextReview, clock_anchor_on: reviewOn });
    return { ...r, review_on: reviewOn, report_id: report.report_id, escalation_id: escalationId, o12_2_review_requested: r.recalibration_proposed, next_review_on: nextReview };
  }
  /** Rule 14: a new pull-through model version needs the officer's approval and the 31.2 review before use; every hedge recommendation records the model version (LL-2026-04). */
  recalibratePullThrough(i: { version: string; method?: PullThroughMethod; parameters?: PullThroughModel["parameters"]; calibration_window?: PullThroughModel["calibration_window"]; validation_document_id?: string | null; approved_by: Actor | null; o12_2_review_id: string | null; effective_from?: PlainDate; at?: string }): PullThroughModel {
    const at = i.at ?? this.now(); const cur = this.model();
    if (!i.approved_by || i.approved_by.kind !== "human" || i.approved_by.role !== "officer") throw new PipelineRefused("MODEL_OFFICER_APPROVAL", "never change the pull-through model version without officer approval");
    if (!i.o12_2_review_id) throw new PipelineRefused("MODEL_O12_2_REVIEW", "never change the pull-through model version without the 31.2 model-inventory review");
    if ((i.method ?? cur.method) !== cur.method && !i.validation_document_id) throw new PipelineRefused("MODEL_METHOD_VALIDATION", "a change in method (lookup → logistic/ML) needs validation evidence (LL-2026-04)");
    const initial = !this.models.some((m) => m.status === "approved" && m.model_id !== PULL_THROUGH_MODEL_V1.model_id);
    const model: PullThroughModel = { model_id: `pull_through.${i.version}`, version: i.version, method: i.method ?? cur.method, features: cur.features, parameters: i.parameters ?? cur.parameters, calibration_window: i.calibration_window ?? null, validation_document_id: i.validation_document_id ?? null, approved_by: i.approved_by.id, o12_2_review_id: i.o12_2_review_id, effective_from: i.effective_from ?? plainDate(etDate(at)), status: "approved" };
    for (let k = 0; k < this.models.length; k++) if (this.models[k]!.status === "approved" || this.models[k]!.status === "proposed") this.models[k] = { ...this.models[k]!, status: "superseded" };
    this.models.push(model); this.hedgeRatioMode = "model";
    this.emit("pull_through.model.recalibrated", { model_id: model.model_id, version: model.version, method: model.method, status: "approved", initial, approved_by: model.approved_by, o12_2_review_id: model.o12_2_review_id, effective_from: model.effective_from, recalibrated_on: plainDate(etDate(at)) }, { aggregate: { kind: "pull_through_model", id: this.partnerId } });
    return model;
  }
  publishPartnerReport(i: { kind: PartnerReport["kind"]; at?: string; body?: Record<string, unknown>; snapshot_ids?: readonly string[] }): PartnerReport {
    const at = i.at ?? this.now(); const snaps = i.snapshot_ids ?? (this.lastSnapshot() ? [this.lastSnapshot()!.snapshot_id] : []);
    const body = i.body ?? (i.kind === "daily_position" && this.lastSnapshot() ? { ...this.lastSnapshot()!, hedge_positions: this.positions.filter((x) => x.status === "open"), mtm: this.mtmRuns.at(-1) ?? null } : {});
    const report: PartnerReport = { report_id: randomUUID(), kind: i.kind, document_id: `partner-report-${i.kind}-${hash({ at, snaps, body })}`, published_at: at, snapshot_ids: snaps, body };
    this.reports.push(report);
    this.emit("partner.report.published", { report_id: report.report_id, kind: i.kind, document_id: report.document_id, snapshot_ids: snaps });
    return report;
  }

  // ---- Breach handling (the timer table's breach column)
  handleBreach(b: Breach, at: string = this.now()): string | null {
    const x = b.instance; const pay = { code: b.def.code, timer_id: x.id, due_at: x.dueAt ? new Date(x.dueAt).toISOString() : null, breach: b.breachText, at };
    switch (b.def.code) {
      case "SM_UNCOMMITTED_POSITION_5BD": return this.officer("officer_uncommitted_position", { ...pay, subject: x.subject, action: "29.1 economics (DPA vs exposure) re-run daily" }, "sev2", x.applicationId);
      case "SIFMA_TBA_ROLL_GATE_3BD": return this.officer("officer_tba_roll_breach", { ...pay, position_id: x.subject.id, trader: "partner trader paged the same hour", rule: "the position must never reach the notification date" }, "sev1");
      case "FINRA_4210_VARIATION_MARGIN_1BD": return this.officer("officer_margin_call_overdue", { ...pay, call_id: x.subject.id, consequence: "dealer may liquidate after five business days (Rule 4210(e)(2)(H)); liquidity reserve drawn" }, "sev1");
      case "SM_HEDGE_COVERAGE_BAND_GATE": return this.officer("officer_coverage_band_breach", { ...pay, action: "rebalance due by the next business_days_fannie_et close" }, "sev2");
      case "SM_PIPELINE_POSITION_DAILY_0700ET": case "SM_MTM_DAILY_1700ET": return this.officer("officer_daily_artifact_missed", { ...pay, fallback: b.def.code === "SM_MTM_DAILY_1700ET" ? "prior-day marks carried with a flag" : "the 8:15 a.m. ET committing open proceeds on the last snapshot" }, "sev2");
      case "SM_HEDGE_POLICY_REVIEW_1Y": return this.officer("officer_hedge_policy_review", { ...pay, consequence: "mandatory execution suspended for new locks until a version is approved (LL-2026-04)" }, "sev2");
      case "SM_PULL_THROUGH_MODEL_RECALIBRATION_90": this.hedgeRatioMode = "conservative_band_edge"; for (let k = 0; k < this.models.length; k++) if (this.models[k]!.status === "approved") this.models[k] = { ...this.models[k]!, status: "stale" }; return this.officer("officer_model_stale", { ...pay, hedge_ratio_mode: "conservative_band_edge" }, "sev3");
      case "SM_RATE_SHOCK_REPORT_DAILY": case "SM_LIQUIDITY_STRESS_WEEKLY": case "SM_BE_FALLOUT_REVIEW_MONTHLY": return this.officer("officer_report_missed", pay, "sev3");
      default: return null;
    }
  }
}
function etWallHour(iso: string): { hour: number; minute: number } { const d = new Date(iso); const s = d.toLocaleTimeString("en-US", { timeZone: ET, hour12: false, hour: "2-digit", minute: "2-digit" }); const [h, m] = s.split(":"); return { hour: Number(h) % 24, minute: Number(m) }; }
