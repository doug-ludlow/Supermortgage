/**
 * §29.1 Committing and pricing execution — the `secondary` agent's pure rules over `commitments` and its children
 * (migration 0103: commitments, commitment_modifications, commitment_extensions, commitment_pair_offs,
 * commitment_over_deliveries, committing_fee_drafts, pewl_price_captures). One small function per rule / T-id; the
 * `CommitmentService` is the runtime service `secondary` — it implements 21.4's `CommitmentPort` (replacing
 * ops-21-4.ts InMemoryCommitmentAdapter) and appends every event with `applicationId` (origination timers arm only
 * on origination context — src/kernel/timers/engine.ts).
 *
 * Events (subject = the application for best efforts; aggregate `commitment` for mandatory):
 *   commitment.requested{commitment_id, lineage_id, amount_cents, executed_today_cents}                    [FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE]
 *   commitment.priced{commitment_id, quote_id_fnma, price, ptr, quoted_at, expires_at, source}              [FNMA_PEWL_COMMIT_ACCEPT_60S]
 *   commitment.executed{commitment_id, commitment_id_fnma, type, price, ptr, expires_on, original_expires_on, underwriting_method, amount_cents}
 *                                                                                                            [expiry rows, extension caps, tolerance and composite delivery gates]
 *   commitment.rejected{commitment_id, reason, queued, release_at}
 *   commitment.modified{commitment_id, fields, repriced, new_commitment_price, worst_case_applied, amount_cents, max_amount_cents}   [satisfies FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD]
 *   commitment.extended{commitment_id, kind, days, per_diem_cents, fee_cents, new_expires_on}
 *   commitment.closed_status.set{commitment_id, disbursement_date, original_expires_on, expires_on, first_payment_date, loan_age_due_on}
 *                                                                                                            [satisfies FNMA_PEWL_CLOSED_STATUS_1BD; arms the 60-day cap and the loan-age reference]
 *   commitment.fallout.recorded{commitment_id, reason, pair_off_expected, fallout_on, dpa_exposure_until}   [FNMA_PEWL_DPA_WINDOW_30]
 *   commitment.expired{commitment_id, expires_on, dpa_exposure_until}
 *   commitment.paired_off{commitment_id, kind, amount_cents, fee_cents, cash_back_cents, market_price}
 *   commitment.over_delivered{commitment_id, amount_cents, fee_cents, cash_back_cents}
 *   commitment.fulfilled{commitment_id, purchased_cents}                                                     [satisfies the mandatory expiry / tolerance / cap rows]
 *   commitment.operator_task.completed{escalation_id, commitment_id, confirmation_document_id}              [satisfies SM_PORTAL_OPERATOR_COMMITMENT_TASK_4H]
 *   committing_fee.drafted · committing_fee.reconciled{draft_id, ledger_set_id} · committing_fee.exception{draft_id, variance_cents}
 *
 * Consumed: lock.executed / lock.relocked / lock.float_down.applied / lock.cancelled{reason} / lock.expired (21.4),
 * du.findings.received{recommendation} (23.1), loan.funded{disbursement_date, first_payment_date} (26.3/30.2),
 * loan.purchased (29.4/30.1), application.withdrawn / counteroffer.accepted (21.6), rescission.exercised (25.3),
 * escalation.created{kind=human_portal_task, task=fnma_portal_commitment_task} (the operator task the SLA row watches).
 */
import { randomUUID } from "node:crypto";
import { type PlainDate, addDays, addMonths, daysBetween, dayOfWeek, endOfMonth, isWeekend, nthWeekday, parts, plainDate, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, rollBack, rollForward } from "../../kernel/calendar/business.ts";
import { isFederalHoliday } from "../../kernel/calendar/holidays.ts";
import { toIso, wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { type Cents, centsToDecimal, formatCents } from "../../kernel/money/cents.ts";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import type { Actor, Clock, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import type { AccountRef, CorporateAccount, EntrySet, Ledger } from "../../kernel/ledger/ledger.ts";
import type { Breach } from "../../kernel/timers/engine.ts";
import type { EscalationService, EscalationKind } from "../../app/escalations.ts";
import { type CancelReason, type CommitmentPort, type CommitmentRecord, type Lock, linkCommitment } from "../application/ops-21-4.ts";
import { computeLlpa, type LlpaTable, type QuoteInputs, type ScoreModel, SFC } from "../leads-pricing/ops-20-4.ts";

export const SECONDARY_AGENT: Actor = { kind: "agent", id: "secondary" };
export const ET = "America/New_York";
export const RULE_SET_VERSION_29_1 = "fnma.selling.2026-09-02+fnma.pewl.2025-02+fnma.llpa.09.09.2026";
/** PE–WL committing windows (00b-orig F7 / best-efforts job aid): standard Mon–Fri 08:15–17:00 ET (early-close days end at 14:00); extended best efforts to 22:00 ET (the FAQ says 23:30 — the adapter reads it from policy). */
export const STANDARD_OPEN_HHMM = "08:15", STANDARD_CLOSE_HHMM = "17:00", EARLY_CLOSE_HHMM = "14:00", COB_PRICE_END_HHMM = "20:00";
/** Expiring-commitments sweep: 4:30 p.m. ET, or 12:30 p.m. ET on a SIFMA early-close day (edge case: mandatory commitment expiring Fri Nov 27, 2026). */
export const SWEEP_HHMM = "16:30", SWEEP_EARLY_CLOSE_HHMM = "12:30";
export const UI_ACCEPT_WINDOW_SECONDS = 60;
export const FEE_DAY_COUNT = 360;

export class CommitmentRefused extends Error {
  readonly code: string; readonly citation: string; readonly reason: string;
  constructor(code: string, citation: string, reason: string) { super(`${code}: ${reason}`); this.name = "CommitmentRefused"; this.code = code; this.citation = citation; this.reason = code; }
}
const dec = (s: string | number | bigint): Decimal => Decimal.parse(String(s));
const HUNDRED = Decimal.fromInt(100);
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const positive = (v: Cents, what: string): Cents => { if (typeof v !== "bigint" || v <= 0n) throw new RangeError(`${what} must be positive cents`); return v; };
const isoOrThrow = (v: unknown, what: string): string => { const s = nonEmpty(v, what); if (Number.isNaN(Date.parse(s))) throw new RangeError(`${what} must be an ISO instant`); return s; };
/** ET wall clock of an instant. */
export const etWall = (iso: string): { date: PlainDate; hour: number; minute: number } => wallClock(Date.parse(iso), ET);
export const etDate = (iso: string): PlainDate => etWall(iso).date;
export const etInstant = (date: PlainDate, hhmm: string): string => toIso(zonedEpochMs(date, hhmm, ET));
const p = (e: DomainEvent): Record<string, unknown> => e.payload as Record<string, unknown>;

// ============================================================ Rule 16: the SIFMA bond-market calendar behind `business_days_fannie_et`
/** Easter Sunday (Gregorian, anonymous algorithm) — SIFMA recommends a full close on Good Friday, which the federal calendar lacks. */
export function easterSunday(y: number): PlainDate {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}
export const isGoodFriday = (d: PlainDate): boolean => d === addDays(easterSunday(parts(d).y), -2);
/** SIFMA full closes (sifma.org, read 2026-09-10): the federal holidays plus Good Friday — 2026: Columbus Day Mon Oct 12, Veterans Day Wed Nov 11, Thanksgiving Thu Nov 26, Christmas Fri Dec 25; New Year's Day Fri Jan 1, 2027. */
export const isSifmaFullClose = (d: PlainDate): boolean => isFederalHoliday(d) || isGoodFriday(d);
/** SIFMA early closes (2:00 p.m. ET): the day after Thanksgiving, Dec 24 and Dec 31 when weekdays, and the business day before the Independence Day close — 2026: Fri Nov 27, Thu Dec 24, Thu Dec 31. Early-close days count as business days. */
export function isSifmaEarlyClose(d: PlainDate): boolean {
  if (isWeekend(d) || isSifmaFullClose(d)) return false;
  const { y, m, day } = { ...parts(d), day: parts(d).d };
  if (m === 11 && d === addDays(nthWeekday(y, 11, 4, 4), 1)) return true;
  if (m === 12 && (day === 24 || day === 31)) return true;
  const july4 = ymd(y, 7, 4); const observed = dayOfWeek(july4) === 6 ? addDays(july4, -1) : dayOfWeek(july4) === 0 ? addDays(july4, 1) : july4;
  return d === addBusinessDays(observed, -1, fannieSifma);
}
/** `holiday_calendars.fannie_sifma`: weekdays less SIFMA full closes; the unit stays `business_days_fannie_et` (baseline §4). */
export const fannieSifma: Calendar = { unit: "business_days_fannie_et", timeZone: ET, isBusinessDay: (d) => !isWeekend(d) && !isSifmaFullClose(d) };
/** T14: the expiring-day sweep runs at 12:30 p.m. ET on an early-close day, 4:30 p.m. ET otherwise. */
export const expiringDaySweepHhmm = (d: PlainDate): string => (isSifmaEarlyClose(d) ? SWEEP_EARLY_CLOSE_HHMM : SWEEP_HHMM);
/** T14: a requested expiration rolls forward to the next `fannie_sifma` business day before the API is called (Fri Dec 25 → Mon Dec 28; Sun Dec 6 → Mon Dec 7; Fri Nov 27 early close stays). */
export function rollExpirationToBusinessDay(requested: PlainDate, cal: Calendar = fannieSifma): { expires_on: PlainDate; rolled: boolean; early_close: boolean; sweep_hhmm: string } {
  const expires_on = rollForward(requested, cal);
  return { expires_on, rolled: expires_on !== requested, early_close: isSifmaEarlyClose(expires_on), sweep_hhmm: expiringDaySweepHhmm(expires_on) };
}

// ---- Rule 4 / edge cases: committing windows ------------------------------------------------------------------
export type WindowKind = "standard" | "extended" | "closed";
export interface WindowState { readonly kind: WindowKind; readonly business_day: boolean; readonly early_close: boolean; readonly closes_at: string | null; readonly next_open_at: string; readonly cob_price_period: boolean; }
/** Where an instant falls on the PE–WL clock: standard (live prices), extended (after-hours best efforts, policy-gated), or closed (queue to the next 8:15 a.m. ET open). Close-of-business prices (5–8 p.m. ET) are never executable. */
export function committingWindow(atIso: string, policy: { extended_close_hhmm?: string } = {}, cal: Calendar = fannieSifma): WindowState {
  const w = etWall(atIso); const d = w.date; const t = Date.parse(atIso);
  const bd = cal.isBusinessDay(d); const early = isSifmaEarlyClose(d);
  const open = zonedEpochMs(d, STANDARD_OPEN_HHMM, ET), close = zonedEpochMs(d, early ? EARLY_CLOSE_HHMM : STANDARD_CLOSE_HHMM, ET), extClose = zonedEpochMs(d, policy.extended_close_hhmm ?? "22:00", ET), cobEnd = zonedEpochMs(d, COB_PRICE_END_HHMM, ET);
  const nextOpenDay = bd && t < open ? d : addBusinessDays(d, 1, cal);
  const next_open_at = etInstant(nextOpenDay, STANDARD_OPEN_HHMM);
  if (!bd) return { kind: "closed", business_day: false, early_close: false, closes_at: null, next_open_at, cob_price_period: false };
  if (t >= open && t < close) return { kind: "standard", business_day: true, early_close: early, closes_at: toIso(close), next_open_at, cob_price_period: false };
  if (t >= close && t < extClose) return { kind: "extended", business_day: true, early_close: early, closes_at: toIso(extClose), next_open_at, cob_price_period: t < cobEnd };
  return { kind: "closed", business_day: true, early_close: early, closes_at: null, next_open_at, cob_price_period: false };
}

// ============================================================ Rules 2, 3, 5, 6: commitment terms and the forecast
export interface CommitmentPolicy {
  readonly commitment_buffer_days: number; readonly max_commitment_period_days: number; readonly servicing_fee_bps: number; readonly remittance_type: RemittanceType;
  readonly pair_off_officer_threshold_cents: Cents; readonly dpa_officer_threshold_cents: Cents; readonly daily_limit_cents: Cents; readonly fee_draft_tolerance_cents: Cents;
  readonly be_manual_extension_cap_days: number; readonly be_closed_autoext_cap_days: number; readonly mand_extension_cap_days: number; readonly pair_off_decision_lead_bd: number;
  readonly after_hours_commit: boolean; readonly mandatory_enabled: boolean; readonly extended_close_hhmm: string; readonly uncommitted_position_policy_days: number; readonly expected_purchase_ready_bd: number;
}
/** Partner policy defaults (open questions 1, 2, 4, 6, 8; rules 2, 10, 12, 14, 15). */
export const DEFAULT_POLICY: CommitmentPolicy = {
  commitment_buffer_days: 14, max_commitment_period_days: 90, servicing_fee_bps: 25, remittance_type: "actual_actual",
  pair_off_officer_threshold_cents: 250_000n, dpa_officer_threshold_cents: 100_000n, daily_limit_cents: 20_000_000_000n, fee_draft_tolerance_cents: 100n,
  be_manual_extension_cap_days: 30, be_closed_autoext_cap_days: 60, mand_extension_cap_days: 30, pair_off_decision_lead_bd: 5,
  after_hours_commit: false, mandatory_enabled: false, extended_close_hhmm: "22:00", uncommitted_position_policy_days: 5, expected_purchase_ready_bd: 5,
};
export type RemittanceType = "actual_actual" | "scheduled_scheduled" | "scheduled_actual";
export type CommitmentType = "best_efforts" | "mandatory";
export type ExecutionChannel = "api" | "ui_operator" | "sales_desk";
export type UnderwritingMethod = "du" | "other";
export type Amortization = "fixed" | "arm_5_6" | "arm_7_6" | "arm_10_6";
export type CommitmentStatus = "requested" | "priced" | "queued" | "executed" | "unconfirmed" | "committed" | "closed" | "delivered" | "purchased" | "paired_off" | "fallout" | "expired" | "rejected"
  | "authorized" | "open" | "fulfilled" | "auto_paired_off";
export type FnmaLoanStatus = "committed" | "closed" | "fallout" | "expired" | "purchase_requested" | "purchase_ready" | "purchased";
export type FalloutReason = "borrower_withdrawal" | "lender_declination" | "ineligible_key_data_change" | "auto_expired" | "failure_to_deliver" | "address_change_recommit" | "uw_method_change_recommit";

export interface CommitmentExpiration { readonly expires_on: PlainDate; readonly raw_expires_on: PlainDate; readonly commitment_period_days: number; readonly capped_at_90: boolean; readonly capped_at_loan_age: boolean; readonly lock_outruns_commitment: boolean; }
/** Rule 2: `expires_on = nextBusinessDay(lock.expires_on + 14, fannie_sifma)`; `expires_on − effective_on ≤ 90` else `effective_on + 90` rolled backward; never beyond the loan-age due date (29.4). Fixture: Nov 23 + 14 = Mon Dec 7, 2026 (61 days). */
export function commitmentExpiration(lockExpiresOn: PlainDate, effectiveOn: PlainDate, policy: Pick<CommitmentPolicy, "commitment_buffer_days" | "max_commitment_period_days"> = DEFAULT_POLICY, loanAgeDueOn: PlainDate | null = null, cal: Calendar = fannieSifma): CommitmentExpiration {
  const raw = addDays(lockExpiresOn, policy.commitment_buffer_days);
  let expires_on = rollForward(raw, cal); let capped_at_90 = false, capped_at_loan_age = false;
  if (daysBetween(effectiveOn, expires_on) > policy.max_commitment_period_days) { expires_on = rollBack(addDays(effectiveOn, policy.max_commitment_period_days), cal); capped_at_90 = true; }
  if (loanAgeDueOn && expires_on > loanAgeDueOn) { expires_on = rollBack(loanAgeDueOn, cal); capped_at_loan_age = true; }
  return { expires_on, raw_expires_on: raw, commitment_period_days: daysBetween(effectiveOn, expires_on), capped_at_90, capped_at_loan_age, lock_outruns_commitment: expires_on < lockExpiresOn };
}
/** Rule 3: `pass_through_rate = note_rate − servicing_fee − lpmi` (4 dp); 25 bps strip for every product (F-2-09 minimum; ARM exactly 25 bps). 6.1250 → 5.8750. */
export function passThroughRate(noteRatePct: string, servicingFeeBps: number = DEFAULT_POLICY.servicing_fee_bps, lpmiBps = 0, amortization: Amortization = "fixed"): string {
  if (amortization !== "fixed" && servicingFeeBps !== 25) throw new CommitmentRefused("arm_strip_25bps", "PE–WL FAQ: a servicing strip of 25 bps is required on all commitments for ARM products", `ARM strip must be 25 bps, not ${servicingFeeBps}`);
  if (amortization === "fixed" && (servicingFeeBps < 25 || servicingFeeBps > 50)) throw new CommitmentRefused("strip_outside_f209", "Servicing Guide F-2-09: fixed-rate 0.25% minimum, 0.50% maximum", `${servicingFeeBps} bps is outside 25–50`);
  return dec(noteRatePct).sub(Decimal.fromInt(servicingFeeBps + lpmiBps).div(Decimal.fromInt(10_000)).mul(HUNDRED)).toFixed(4, "HALF_UP");
}
/** Rule 12: five consecutive PTRs in 0.125% steps (a 50 bp range) from the minimum — 5.625 → 5.625, 5.750, 5.875, 6.000, 6.125. */
export function mandatoryPtrRange(minPtrPct: string): { ptr_range_low: string; ptr_range_high: string; ptrs: readonly string[] } {
  const lo = dec(minPtrPct); const eighth = Decimal.parse("0.125");
  if (!lo.div(eighth).sub(Decimal.fromBigInt(lo.div(eighth).toScaledInt(0, "DOWN"))).isZero()) throw new CommitmentRefused("ptr_not_eighth", "PE–WL Mandatory Committing: the minimum PTR may start on any 1/8 percent", `${minPtrPct} is not a multiple of 0.125`);
  const ptrs = [0, 1, 2, 3, 4].map((k) => lo.add(eighth.mul(Decimal.fromInt(k))).toFixed(4, "HALF_UP"));
  return { ptr_range_low: ptrs[0]!, ptr_range_high: ptrs[4]!, ptrs };
}
/** Rule 5: `expected_purchase_ready_date = disbursement_date_planned + 5 business_days_fannie_et`. */
export const expectedPurchaseReadyDate = (disbursementPlanned: PlainDate, bd: number = DEFAULT_POLICY.expected_purchase_ready_bd, cal: Calendar = fannieSifma): PlainDate => addBusinessDays(disbursementPlanned, bd, cal);

export interface ForecastInput { readonly commitment_price: string; readonly llpa_forecast_pct: string; readonly upb_at_purchase_cents: Cents; readonly credits_forecast_cents?: Cents; }
export interface Forecast { readonly net_price_forecast: string; readonly premium_cents: Cents; readonly llpa_forecast_cents: Cents; readonly credits_forecast_cents: Cents; readonly proceeds_forecast_cents: Cents; }
/** Rule 5: `net_price_forecast = commitment_price − llpa_forecast_pct`; `proceeds = round_half_up(upb × net/100) + credits` — before the C2-1.1-06 interest adjustment (29.4/27.2). Fixture: 101.375 − 0.125 = 101.250 → $567,000.00 = $560,000 + $7,700.00 − $700.00. */
export function netPriceForecast(i: ForecastInput): Forecast {
  positive(i.upb_at_purchase_cents, "upb_at_purchase_cents");
  const net = dec(i.commitment_price).sub(dec(i.llpa_forecast_pct));
  const upb = centsToDecimal(i.upb_at_purchase_cents);
  const credits = i.credits_forecast_cents ?? 0n;
  return { net_price_forecast: net.toFixed(3, "HALF_UP"), premium_cents: upb.mul(dec(i.commitment_price).sub(HUNDRED)).div(HUNDRED).toCents("HALF_UP"), llpa_forecast_cents: upb.mul(dec(i.llpa_forecast_pct)).div(HUNDRED).toCents("HALF_UP"),
    credits_forecast_cents: credits, proceeds_forecast_cents: upb.mul(net).div(HUNDRED).toCents("HALF_UP") + credits };
}
/** The unrounded proceeds figure as PE–WL would show it (worked example 2: $409,500 × 1.00875 = $413,083.125 → $413,083.13 half-up; $413,083.12 truncated). */
export const proceedsUnrounded = (upbCents: Cents, netPrice: string): { half_up_cents: Cents; truncated_cents: Cents; exact: string } => {
  const x = centsToDecimal(upbCents).mul(dec(netPrice)).div(HUNDRED); return { half_up_cents: x.toCents("HALF_UP"), truncated_cents: x.toCents("DOWN"), exact: x.toFixed(3, "DOWN") };
};
export interface LlpaForecastInput { readonly tables: readonly LlpaTable[]; readonly expected_purchase_ready_date: PlainDate; readonly loan_amount_cents: Cents; readonly value_cents: Cents; readonly purchase_price_cents?: Cents | null; readonly representative_score: number | null; readonly score_model: ScoreModel;
  readonly transaction_type: QuoteInputs["transaction_type"]; readonly occupancy?: QuoteInputs["occupancy"]; readonly property_type?: QuoteInputs["property_type"]; readonly units?: 1 | 2 | 3 | 4; readonly amortization?: Amortization; readonly product_code?: string; readonly term_months?: number; readonly state?: string; readonly county?: string;
  readonly subordinate_financing_cents?: Cents; readonly mi_option?: QuoteInputs["mi_option"]; readonly homeready?: boolean; readonly homeready_evaluation?: QuoteInputs["homeready_evaluation"]; readonly first_time_homebuyer?: boolean; readonly very_low_income?: boolean; readonly lock_period_days?: number; }
export interface LlpaForecast { readonly llpa_forecast_pct: string; readonly llpa_forecast_cents: Cents; readonly credits_forecast_cents: Cents; readonly matrix_version: string; readonly cells: readonly { grid: string; row: string; col: string; pct: string }[]; readonly waived: readonly { grid: string; row: string; col: string; pct: string }[]; readonly sfcs: readonly string[]; readonly waiver_applied: string | null; }
/** Rule 5: `llpa_forecast_pct = Σ grid cells` per 20.4 rule 2 on the matrix in force on `expected_purchase_ready_date` (`SM_LLPA_TABLE_VERSION_GATE`); SFCs implied by pricing (007, 900, 067, 808) are staged for 29.3. */
export function llpaForecast(i: LlpaForecastInput): LlpaForecast {
  const q: QuoteInputs = { product_code: i.product_code ?? "FRM30_CONV", term_months: i.term_months ?? 360, amortization: i.amortization ?? "fixed", transaction_type: i.transaction_type, occupancy: i.occupancy ?? "primary", property_type: i.property_type ?? "sfr", units: i.units ?? 1,
    loan_amount_cents: i.loan_amount_cents, value_cents: i.value_cents, purchase_price_cents: i.purchase_price_cents ?? null, representative_score: i.representative_score, score_model: i.score_model, score_source: i.score_model === "vantagescore_4" ? "tri_merge_vantagescore_4" : "tri_merge_classic_fico", borrower_score_models: [i.score_model],
    state: i.state ?? "AZ", county: i.county ?? "Maricopa", county_limit_cents: null, subordinate_financing_cents: i.subordinate_financing_cents ?? 0n, mi_option: i.mi_option ?? "none", homeready: i.homeready ?? false, homeready_evaluation: i.homeready_evaluation ?? null, first_time_homebuyer: i.first_time_homebuyer ?? false, fthb_ami_waiver: false, dts_waiver: false, very_low_income: i.very_low_income ?? false,
    lock_period_days: i.lock_period_days ?? 45, expected_purchase_ready_date: i.expected_purchase_ready_date, escrowed: true, valuation_method: "traditional", borrower_pays_third_party_costs: false, taxes_annual_cents: null, insurance_annual_cents: null, mi_annual_rate_pct: null, assumed_disbursement_date: null, first_payment_date: null };
  const r = computeLlpa(i.tables, q);
  const cell = (it: { grid: string; row: string; col: string; pct: string }) => ({ grid: it.grid, row: it.row, col: it.col, pct: it.pct });
  return { llpa_forecast_pct: r.llpa_total_pct, llpa_forecast_cents: r.llpa_cents, credits_forecast_cents: r.credits_cents, matrix_version: r.matrix_version, cells: r.llpa_items.map(cell), waived: r.llpa_items_waived.map(cell), sfcs: r.sfcs, waiver_applied: r.waiver_applied };
}
/** Rule 6: `execution_variance_cents = round_half_up((commitment_price − base_price)/100 × loan_amount_cents)` — +0.500 on $560,000 = +$2,800.00 program surplus. */
export const executionVarianceCents = (commitmentPrice: string, basePrice: string, loanAmountCents: Cents): Cents => centsToDecimal(positive(loanAmountCents, "loan_amount_cents")).mul(dec(commitmentPrice).sub(dec(basePrice))).div(HUNDRED).toCents("HALF_UP");
/** The servicing strip in month one: `upb × bps/10000 / 12` — $560,000 × 0.0025 / 12 = $116.67 (the partner's MSR). */
export const servicingStripMonthOne = (upbCents: Cents, bps: number = DEFAULT_POLICY.servicing_fee_bps): Cents => centsToDecimal(upbCents).mul(Decimal.fromInt(bps)).div(Decimal.fromInt(10_000)).div(Decimal.fromInt(12)).toCents("HALF_UP");

// ============================================================ Rule 7: key-data changes and worse-case pricing
export type KeyDataField = "loan_amount_cents" | "product_code" | "note_rate" | "units" | "seller_loan_number" | "loan_status" | "borrower" | "address";
export const KEY_DATA_FIELDS: readonly KeyDataField[] = ["loan_amount_cents", "product_code", "note_rate", "units", "seller_loan_number", "loan_status", "borrower", "address"];
/** C2-1.2-03 "worse case pricing when applicable": the lender receives `min(commitment_price, live_price_for_new_terms)` — 101.375 stays when the 6.250% live price is 101.750. */
export function worstCasePrice(commitmentPrice: string, livePriceForNewTerms: string): { new_commitment_price: string; worst_case_applied: boolean; repriced: boolean } {
  const cur = dec(commitmentPrice), live = dec(livePriceForNewTerms);
  return { new_commitment_price: (live.cmp(cur) < 0 ? live : cur).toFixed(3, "HALF_UP"), worst_case_applied: true, repriced: true };
}
/** Rule 7: an amount increase raises `amount_cents` and `max_amount_cents`; a decrease lowers `amount_cents` only (the fee base "throughout the life of the commitment"). $412,000 → $409,500 keeps max $412,000. */
export function applyAmountChange(amountCents: Cents, maxAmountCents: Cents, newAmountCents: Cents): { amount_cents: Cents; max_amount_cents: Cents } {
  positive(newAmountCents, "new loan amount");
  return { amount_cents: newAmountCents, max_amount_cents: newAmountCents > maxAmountCents ? newAmountCents : maxAmountCents };
}
/** Rule 7 / edge cases: a complete address change or DU→Other switch is fallout + recommit (not a duplicate — the property differs). */
export const requiresRecommit = (fields: readonly KeyDataField[], detail: { complete_address_change?: boolean; uw_method_to_other?: boolean } = {}): FalloutReason | null =>
  detail.uw_method_to_other ? "uw_method_change_recommit" : fields.includes("address") && detail.complete_address_change ? "address_change_recommit" : null;
/** Timer: the key-data notice is due +1 `business_days_fannie_et` at 5:00 p.m. ET from the change instant's ET civil date (2:10 p.m. ET Thu Nov 5 → Fri Nov 6, 2026 5:00 p.m. ET). */
export function keyDataChangeDue(changedAtIso: string, cal: Calendar = fannieSifma): { due_on: PlainDate; due_at: string } { const d = addBusinessDays(etDate(isoOrThrow(changedAtIso, "changed_at")), 1, cal); return { due_on: d, due_at: etInstant(d, STANDARD_CLOSE_HHMM) }; }
/** Rule 9: closed status is due +1 `business_days_fannie_et` 5:00 p.m. ET after disbursement (Thu Nov 12 → Fri Nov 13, 2026 5:00 p.m. ET). */
export function closedStatusDue(disbursementDate: PlainDate, cal: Calendar = fannieSifma): { due_on: PlainDate; due_at: string } { const d = addBusinessDays(disbursementDate, 1, cal); return { due_on: d, due_at: etInstant(d, STANDARD_CLOSE_HHMM) }; }
/** 29.4's loan-age reference (B2-1.5-02): the last day of the sixth month counting the first-payment month as month one — Jan 1, 2027 → Wed Jun 30, 2027. */
export const loanAgeDueOn = (firstPaymentDate: PlainDate): PlainDate => endOfMonth(addMonths(firstPaymentDate, 5));

// ============================================================ Rule 8: fallout and the DPA window
export interface FalloutOutcome { readonly status: "fallout" | "expired"; readonly fallout_reason: FalloutReason; readonly pair_off_expected: boolean; readonly fallout_on: PlainDate; readonly dpa_exposure_until: PlainDate; }
/** `lock.cancelled{borrower_withdrawal|lender_declination}` and ineligibility → fallout without fee; `failure_to_deliver` (closed, not delivered) → pair-off expected; `dpa_exposure_until = fallout_date + 30`. Fri Oct 23, 2026 → Sun Nov 22, 2026. */
export function classifyFallout(reason: FalloutReason | CancelReason, falloutOn: PlainDate): FalloutOutcome {
  const map: Record<string, FalloutReason> = { borrower_withdrawal: "borrower_withdrawal", lender_declination: "lender_declination", product_change_ineligible: "ineligible_key_data_change", ineligible_key_data_change: "ineligible_key_data_change", expired: "auto_expired", auto_expired: "auto_expired", superseded: "ineligible_key_data_change",
    failure_to_deliver: "failure_to_deliver", address_change_recommit: "address_change_recommit", uw_method_change_recommit: "uw_method_change_recommit" };
  const r = map[reason]; if (!r) throw new RangeError(`unknown fallout reason ${reason}`);
  return { status: r === "auto_expired" ? "expired" : "fallout", fallout_reason: r, pair_off_expected: r === "failure_to_deliver", fallout_on: falloutOn, dpa_exposure_until: addDays(falloutOn, 30) };
}
export interface DpaFacts { readonly dpa_exposure_until?: unknown; readonly requested_on?: unknown; readonly same_borrower_property?: unknown; readonly dpa_acknowledged?: unknown; readonly dpa_cost_cents?: unknown; readonly officer_approved?: unknown; readonly dpa_officer_threshold_cents?: unknown; }
/** `FNMA_PEWL_DPA_WINDOW_30`: a recommit for the same borrower + property on or before `dpa_exposure_until` is refused unless `dpa_acknowledged=true` (and `officer` approval above $1,000). Tue Nov 10 refused; Mon Nov 23 open. */
export function dpaWindowGate(f: DpaFacts): { open: boolean; reason?: string; inside_window: boolean } {
  const until = typeof f.dpa_exposure_until === "string" ? plainDate(f.dpa_exposure_until) : null; const on = typeof f.requested_on === "string" ? plainDate(f.requested_on) : null;
  if (!until || !on || f.same_borrower_property === false) return { open: true, inside_window: false };
  const inside = on <= until; if (!inside) return { open: true, inside_window: false };
  if (f.dpa_acknowledged !== true) return { open: false, reason: "dpa_window", inside_window: true };
  const cost = typeof f.dpa_cost_cents === "bigint" ? f.dpa_cost_cents : BigInt(String(f.dpa_cost_cents ?? "0")); const thr = typeof f.dpa_officer_threshold_cents === "bigint" ? f.dpa_officer_threshold_cents : DEFAULT_POLICY.dpa_officer_threshold_cents;
  if (cost > thr && f.officer_approved !== true) return { open: false, reason: `dpa_window: DPA ${formatCents(cost, { symbol: true })} exceeds the ${formatCents(thr, { symbol: true })} threshold without officer approval`, inside_window: true };
  return { open: true, inside_window: true };
}
/** Worked example 3(a): the DPA economics — uncommitted exposure (expected move × amount) versus the worse-case DPA (commitment price − live price when the market rallied); the agent waits when the DPA costs more. */
export function dpaEconomics(i: { amount_cents: Cents; original_price: string; live_price: string; expected_move_points: string; days_uncommitted: number; policy?: CommitmentPolicy }): { dpa_cost_cents: Cents; exposure_cents: Cents; choice: "wait" | "recommit_with_dpa"; officer_notification: boolean } {
  const amt = centsToDecimal(positive(i.amount_cents, "amount_cents"));
  const dpaPts = dec(i.live_price).sub(dec(i.original_price)); const dpa_cost_cents = dpaPts.isNegative() ? 0n : amt.mul(dpaPts).div(HUNDRED).toCents("HALF_UP");
  const exposure_cents = amt.mul(dec(i.expected_move_points)).div(HUNDRED).toCents("HALF_UP");
  const pol = i.policy ?? DEFAULT_POLICY;
  return { dpa_cost_cents, exposure_cents, choice: dpa_cost_cents > exposure_cents ? "wait" : "recommit_with_dpa", officer_notification: i.days_uncommitted > pol.uncommitted_position_policy_days };
}

// ============================================================ Rules 10–12: fees
/** Rule 10: `per_diem = max_amount × max_ptr / 360` (exact decimal cents); `fee = round_half_up(per_diem × days)`. $560,000 × 0.05875 / 360 = 9,138.89 cents/day; 8 days → $731.11. */
export function bestEffortsExtensionFee(maxAmountCents: Cents, maxPtrPct: string, days: number): { per_diem_cents: string; per_diem_display: string; fee_cents: Cents } {
  if (!Number.isInteger(days) || days <= 0) throw new RangeError("days must be a positive integer");
  const perDiem = centsToDecimal(positive(maxAmountCents, "max_amount_cents")).mul(dec(maxPtrPct)).div(HUNDRED).div(Decimal.fromInt(FEE_DAY_COUNT));
  return { per_diem_cents: perDiem.mul(HUNDRED).toFixed(2, "HALF_UP"), per_diem_display: `$${perDiem.toFixed(4, "HALF_UP")}/day`, fee_cents: perDiem.mul(Decimal.fromInt(days)).toCents("HALF_UP") };
}
/** Rule 11: best-efforts pair-off `fee = round_half_up(max_amount × max(0, market − commitment)/100)`; no cash back assumed **[PARTIALLY VERIFIED]**. $560,000 × 0.0075 = $4,200.00; at 100.500 the fee is $0.00. */
export function bestEffortsPairOffFee(maxAmountCents: Cents, commitmentPrice: string, marketPrice: string): { fee_cents: Cents; cash_back_cents: 0n; price_delta: string } {
  const delta = dec(marketPrice).sub(dec(commitmentPrice));
  return { fee_cents: delta.isNegative() ? 0n : centsToDecimal(positive(maxAmountCents, "max_amount_cents")).mul(delta).div(HUNDRED).toCents("HALF_UP"), cash_back_cents: 0n, price_delta: delta.toFixed(3, "HALF_UP") };
}
/** Rule 11: the alternative to pairing off now — carrying auto-extensions to the 60-day cap at the per diem ($91.3889/day × 60 = $5,483.33). */
export function carryAlternative(maxAmountCents: Cents, maxPtrPct: string, days: number): { days: number; per_diem_display: string; carry_cents: Cents; statement: string } {
  const f = bestEffortsExtensionFee(maxAmountCents, maxPtrPct, days);
  return { days, per_diem_display: f.per_diem_display, carry_cents: f.fee_cents, statement: `waiting to the automatic pair-off would add ${days} days of auto-extension carry at ${f.per_diem_display} → ${formatCents(f.fee_cents, { symbol: true })}, plus open market risk` };
}
/** Rule 11 decision rule: pair off now when non-delivery is certain; otherwise compare the expected carry `(1 − p_cure) × (fee_now + remaining carry)` with `fee_now`. */
export function pairOffDecision(i: { certain_non_delivery: boolean; cure_probability?: string; fee_now_cents: Cents; remaining_carry_cents: Cents }): "pair_off_now" | "carry" {
  if (i.certain_non_delivery) return "pair_off_now";
  const pCure = dec(i.cure_probability ?? "0"); const expectedCarry = Decimal.ONE.sub(pCure).mul(centsToDecimal(i.fee_now_cents + i.remaining_carry_cents));
  return expectedCarry.cmp(centsToDecimal(i.fee_now_cents)) > 0 ? "pair_off_now" : "carry";
}
/** Rule 12: `tolerance = max($10,000, round_half_up(2.5% × original))`; good delivery within [original − tol, original + tol]; over-delivery cap 25%. $5,000,000 → $4,875,000–$5,125,000, cap $1,250,000. */
export function mandatoryTolerance(originalAmountCents: Cents): { tolerance_cents: Cents; tolerance_low_cents: Cents; tolerance_high_cents: Cents; over_delivery_cap_cents: Cents; post_over_delivery_tolerance_cents: Cents } {
  const o = positive(originalAmountCents, "original_amount_cents");
  const pct = divRound(o * 25n, 1000n, "HALF_UP"); const tolerance = pct > 1_000_000n ? pct : 1_000_000n;
  return { tolerance_cents: tolerance, tolerance_low_cents: o - tolerance, tolerance_high_cents: o + tolerance, over_delivery_cap_cents: divRound(o * 25n, 100n, "HALF_UP"), post_over_delivery_tolerance_cents: 5_000n };
}
/** Rule 12: mandatory pair-off / over-delivery `amount × (market − commitment)/100` — positive = fee, negative = cash back (C2-1.1-04). $275,000 at 100.750 vs 101.250 → cash back $1,375.00; at 101.750 → fee $1,375.00. */
export function mandatoryPairOff(amountCents: Cents, commitmentPrice: string, marketPrice: string): { fee_cents: Cents; cash_back_cents: Cents; price_delta: string } {
  const x = centsToDecimal(positive(amountCents, "amount_cents")).mul(dec(marketPrice).sub(dec(commitmentPrice))).div(HUNDRED).toCents("HALF_UP");
  return { fee_cents: x > 0n ? x : 0n, cash_back_cents: x < 0n ? -x : 0n, price_delta: dec(marketPrice).sub(dec(commitmentPrice)).toFixed(3, "HALF_UP") };
}
/** Rule 12: mandatory extension per diem `= remaining_balance × min_ptr / 360`; $400,000 × 0.05625 / 360 × 10 = $625.00. */
export function mandatoryExtensionFee(remainingBalanceCents: Cents, minPtrPct: string, days: number): { per_diem_cents: string; fee_cents: Cents } {
  if (!Number.isInteger(days) || days <= 0) throw new RangeError("days must be a positive integer");
  const perDiem = centsToDecimal(positive(remainingBalanceCents, "remaining_balance_cents")).mul(dec(minPtrPct)).div(HUNDRED).div(Decimal.fromInt(FEE_DAY_COUNT));
  return { per_diem_cents: perDiem.mul(HUNDRED).toFixed(2, "HALF_UP"), fee_cents: perDiem.mul(Decimal.fromInt(days)).toCents("HALF_UP") };
}
/** Caps: best-efforts manual extensions ≤ 30 cumulative days before closing; mandatory ≤ 30; closed best efforts auto-extend to 60 from the original expiration. */
export function extensionCapCheck(cumulativeDays: number, requestedDays: number, capDays: number): { allowed: boolean; cumulative_after: number } { const after = cumulativeDays + requestedDays; return { allowed: after <= capDays, cumulative_after: after }; }
/** `FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60`: `original_expires_on + 60` (Dec 7, 2026 → Fri Feb 5, 2027); the pair-off decision is escalated ≥ 5 business days earlier (Fri Jan 29, 2027). */
export function autoExtensionCap(originalExpiresOn: PlainDate, policy: Pick<CommitmentPolicy, "be_closed_autoext_cap_days" | "pair_off_decision_lead_bd"> = DEFAULT_POLICY, cal: Calendar = fannieSifma): { cap_on: PlainDate; decision_by: PlainDate } {
  const cap_on = addDays(originalExpiresOn, policy.be_closed_autoext_cap_days); return { cap_on, decision_by: addBusinessDays(cap_on, -policy.pair_off_decision_lead_bd, cal) };
}
/** Rule 14: `Σ executed today (ET) + amount ≤ $200,000,000` (C2-1.1-03) — $199,600,000 + $560,000 is refused, queued, Sales Desk via the officer. */
export function dailyLimitCheck(executedTodayCents: Cents, amountCents: Cents, limitCents: Cents = DEFAULT_POLICY.daily_limit_cents): { allowed: boolean; after_cents: Cents; headroom_cents: Cents } {
  const after = executedTodayCents + positive(amountCents, "amount_cents"); return { allowed: after <= limitCents, after_cents: after, headroom_cents: limitCents - executedTodayCents };
}
/** `FNMA_C2_1_2_03_DU_APPROVE_60_GATE`: under `du` the Approve/Eligible must be ≤ 60 calendar days before execution (Sat Aug 1 → Wed Oct 7 = 67 days refused; Oct 6 → Oct 7 open until Sat Dec 5). */
export function duApproveWindow(duRecommendationAt: string | null, executedAt: string, underwritingMethod: UnderwritingMethod): { open: boolean; days: number | null; window_closes_on: PlainDate | null; reason?: string } {
  if (underwritingMethod === "other") return { open: true, days: null, window_closes_on: null };
  if (!duRecommendationAt) return { open: false, days: null, window_closes_on: null, reason: "FNMA_C2_1_2_03_DU_APPROVE_60_GATE: no DU Approve/Eligible on file" };
  const days = daysBetween(etDate(duRecommendationAt), etDate(executedAt)); const closes = addDays(etDate(duRecommendationAt), 60);
  return days <= 60 && days >= 0 ? { open: true, days, window_closes_on: closes } : { open: false, days, window_closes_on: closes, reason: `FNMA_C2_1_2_03_DU_APPROVE_60_GATE: DU Approve/Eligible is ${days} days old (> 60)` };
}
/** Rule 15: a fee draft matches a child row within ±$1.00 (rounding); otherwise `exception`. $731.11 vs $731.11 → matched; $760.00 → exception (variance $28.89). */
export function reconcileDraft(draftCents: Cents, expectedCents: Cents, toleranceCents: Cents = DEFAULT_POLICY.fee_draft_tolerance_cents): { status: "matched" | "exception"; variance_cents: Cents } {
  const v = draftCents - expectedCents; const a = v < 0n ? -v : v; return { status: a <= toleranceCents ? "matched" : "exception", variance_cents: v };
}

// ---- gate evaluators (facts → open/closed; evaluators-29-1.ts wraps them) -------------------------------------
const fs = (f: Record<string, unknown>, k: string): string | null => (typeof f[k] === "string" && f[k] ? String(f[k]) : null);
const fc = (f: Record<string, unknown>, k: string): Cents => (typeof f[k] === "bigint" ? (f[k] as bigint) : f[k] === undefined || f[k] === null || f[k] === "" ? 0n : BigInt(String(f[k])));
const fn = (f: Record<string, unknown>, k: string, d = 0): number => (f[k] === undefined || f[k] === null ? d : Number(f[k]));
export type GateFacts = Record<string, unknown>;
export const duApproveWindowGate = (f: GateFacts): { open: boolean; reason?: string } => { const r = duApproveWindow(fs(f, "du_recommendation_at"), fs(f, "executed_at") ?? fs(f, "now") ?? new Date(0).toISOString(), (fs(f, "underwriting_method") as UnderwritingMethod | null) ?? "du"); return r.open ? { open: true } : { open: false, reason: r.reason ?? "closed" }; };
/** `FNMA_PEWL_COMMIT_ACCEPT_60S`: the commit must reference an unexpired quote (API `quote_expires_at`) or accept inside the 60-second UI window. */
export const commitAcceptWindowGate = (f: GateFacts): { open: boolean; reason?: string } => {
  const now = fs(f, "now"); const exp = fs(f, "quote_expires_at"); const quotedAt = fs(f, "quoted_at");
  if (!now) return { open: false, reason: "FNMA_PEWL_COMMIT_ACCEPT_60S: now is required" };
  if (exp) return Date.parse(now) <= Date.parse(exp) ? { open: true } : { open: false, reason: `FNMA_PEWL_COMMIT_ACCEPT_60S: quote expired at ${exp}` };
  if (quotedAt) return Date.parse(now) - Date.parse(quotedAt) <= fn(f, "window_seconds", UI_ACCEPT_WINDOW_SECONDS) * 1000 ? { open: true } : { open: false, reason: "FNMA_PEWL_COMMIT_ACCEPT_60S: the 60-second acceptance window has passed — re-price" };
  return { open: false, reason: "FNMA_PEWL_COMMIT_ACCEPT_60S: no quote timestamp" };
};
export const dailyLimitGate = (f: GateFacts): { open: boolean; reason?: string } => { const r = dailyLimitCheck(fc(f, "executed_today_cents"), fc(f, "amount_cents") || 1n, f.daily_limit_cents === undefined ? DEFAULT_POLICY.daily_limit_cents : fc(f, "daily_limit_cents")); return r.allowed ? { open: true } : { open: false, reason: `FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE: ${formatCents(r.after_cents, { symbol: true })} would exceed the $200,000,000 daily limit` }; };
export const beExtensionCapGate = (f: GateFacts): { open: boolean; reason?: string } => { if (f.closed === true) return { open: true }; const r = extensionCapCheck(fn(f, "manual_extension_days"), fn(f, "requested_days"), fn(f, "cap_days", DEFAULT_POLICY.be_manual_extension_cap_days)); return r.allowed ? { open: true } : { open: false, reason: `FNMA_C2_1_2_02_BE_EXTENSION_CAP_30: cumulative manual extensions would reach ${r.cumulative_after} days (> 30)` }; };
export const mandExtensionCapGate = (f: GateFacts): { open: boolean; reason?: string } => { const r = extensionCapCheck(fn(f, "manual_extension_days"), fn(f, "requested_days"), fn(f, "cap_days", DEFAULT_POLICY.mand_extension_cap_days)); return r.allowed ? { open: true } : { open: false, reason: `FNMA_C2_1_1_04_MAND_EXTENSION_CAP_30: cumulative extensions would reach ${r.cumulative_after} days (> 30)` }; };
export const mandToleranceGate = (f: GateFacts): { open: boolean; reason?: string } => { const o = fc(f, "original_amount_cents"); if (o <= 0n) return { open: false, reason: "FNMA_PEWL_MAND_TOLERANCE_GATE: original_amount_cents is required" }; const t = mandatoryTolerance(o); const pu = fc(f, "purchased_cents"); return pu >= t.tolerance_low_cents && pu <= t.tolerance_high_cents ? { open: true } : { open: false, reason: `FNMA_PEWL_MAND_TOLERANCE_GATE: purchased ${formatCents(pu, { symbol: true })} outside [${formatCents(t.tolerance_low_cents, { symbol: true })}, ${formatCents(t.tolerance_high_cents, { symbol: true })}]` }; };
/** `FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY` (composite): open while `today_et < expires_on` and the custodian can still receive by the first morning delivery of `expires_on − 1 business_days_fannie_et` (29.4 supplies `custodian_receipt_possible_on`). */
export const deliveryCommitmentGate = (f: GateFacts): { open: boolean; reason?: string; custodian_deadline_on?: PlainDate } => {
  const exp = fs(f, "expires_on"); const today = fs(f, "today_et"); if (!exp || !today) return { open: false, reason: "FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY: expires_on and today_et are required" };
  const deadline = addBusinessDays(plainDate(exp), -1, fannieSifma);
  if (!(plainDate(today) < plainDate(exp))) return { open: false, reason: `FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY: commitment expired ${exp}`, custodian_deadline_on: deadline };
  const receipt = fs(f, "custodian_receipt_possible_on");
  if (receipt && plainDate(receipt) > deadline) return { open: false, reason: `FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY: custodian receipt ${receipt} is after the first morning delivery of ${deadline} (C2-2-01)`, custodian_deadline_on: deadline };
  return { open: true, custodian_deadline_on: deadline };
};

// ============================================================ Data model (migration 0103)
export interface Commitment {
  readonly commitment_id: string; readonly partner_id: string; readonly commitment_id_fnma: string | null; readonly type: CommitmentType; readonly execution_channel: ExecutionChannel; readonly application_id: string | null; readonly loan_id: string | null;
  readonly lock_id: string | null; readonly lineage_id: string | null; readonly du_casefile_id: string | null; readonly underwriting_method: UnderwritingMethod; readonly du_recommendation_at: string | null;
  readonly product_code: string; readonly fnma_product_name: string; readonly amortization: Amortization; readonly term_months: number; readonly note_rate: string; readonly servicing_fee_bps: number; readonly lpmi_bps: number; readonly pass_through_rate: string; readonly ptr_range_low: string | null; readonly ptr_range_high: string | null;
  readonly remittance_type: RemittanceType; readonly servicing_option: "retained"; readonly amount_cents: Cents; readonly max_amount_cents: Cents; readonly original_amount_cents: Cents; readonly remaining_balance_cents: Cents; readonly purchased_cents: Cents; readonly paired_off_cents: Cents; readonly over_delivered_cents: Cents;
  readonly tolerance_low_cents: Cents | null; readonly tolerance_high_cents: Cents | null; readonly hbl_cap_pct: string | null; readonly commitment_price: string; readonly quote_id_fnma: string | null; readonly quoted_at: string | null; readonly quote_expires_at: string | null;
  readonly executed_at: string | null; readonly effective_on: PlainDate | null; readonly commitment_period_days: number | null; readonly expires_on: PlainDate | null; readonly original_expires_on: PlainDate | null; readonly manual_extension_days: number; readonly auto_extension_days: number;
  readonly closed_status_set_at: string | null; readonly fnma_loan_status: FnmaLoanStatus | null; readonly status: CommitmentStatus; readonly pair_off_terms: Record<string, unknown> | null; readonly fallout_reason: FalloutReason | null; readonly pair_off_expected: boolean | null; readonly dpa_exposure_until: PlainDate | null; readonly duplicate_of_commitment_id: string | null;
  readonly expected_purchase_ready_date: PlainDate | null; readonly llpa_forecast_pct: string | null; readonly llpa_forecast_cents: Cents | null; readonly credits_forecast_cents: Cents; readonly net_price_forecast: string | null; readonly proceeds_forecast_cents: Cents | null; readonly execution_variance_cents: Cents | null;
  readonly confirmation_document_id: string | null; readonly email_confirmation_document_id: string | null; readonly agent_decision_id: string | null; readonly borrower_last_name: string | null; readonly property_address: string | null; readonly disbursement_date: PlainDate | null; readonly first_payment_date: PlainDate | null;
  readonly queued_release_at: string | null; readonly overnight_price_change: string | null; readonly sfcs_staged: readonly string[]; readonly recorded_by: string; readonly created_at: string; readonly updated_at: string;
}
type CommitmentPatch = { -readonly [K in keyof Commitment]?: Commitment[K] };
export interface CommitmentModification { readonly modification_id: string; readonly commitment_id: string; readonly changed_at: string; readonly reported_at: string; readonly due_at: string; readonly fields: { before: Record<string, unknown>; after: Record<string, unknown> }; readonly repriced: boolean; readonly new_commitment_price: string | null; readonly worst_case_applied: boolean; readonly channel: ExecutionChannel; readonly confirmation_document_id: string | null; readonly late: boolean; }
export type ExtensionKind = "manual" | "auto_1d" | "auto_5d";
export type FeePayer = "sm" | "partner";
export interface CommitmentExtension { readonly extension_id: string; readonly commitment_id: string; readonly kind: ExtensionKind; readonly days: number; readonly per_diem_cents: string; readonly fee_cents: Cents; readonly requested_at: string; readonly new_expires_on: PlainDate; readonly payer: FeePayer; readonly confirmation_document_id: string | null; readonly source: "request" | "confirmation" | "draft"; readonly escalation_id: string | null; }
export interface CommitmentPairOff { readonly pair_off_id: string; readonly commitment_id: string; readonly kind: "lender_requested" | "automatic"; readonly amount_cents: Cents; readonly commitment_price: string; readonly market_price: string | null; readonly fee_cents: Cents; readonly cash_back_cents: Cents; readonly executed_at: string | null; readonly prepared_at: string; readonly payer: FeePayer; readonly confirmation_document_id: string | null; readonly status: "prepared" | "approved" | "executed"; readonly approval_escalation_id: string | null; readonly operator_escalation_id: string | null; readonly alternative: { days: number; carry_cents: Cents; statement: string } | null; readonly source: "package" | "draft"; }
export interface CommitmentOverDelivery { readonly over_delivery_id: string; readonly commitment_id: string; readonly amount_cents: Cents; readonly commitment_price: string; readonly market_price: string; readonly fee_cents: Cents; readonly cash_back_cents: Cents; readonly executed_at: string; }
export type FeeType = "extension" | "pair_off" | "duplicate_price_adjustment" | "over_delivery" | "post_purchase_adjustment" | "other";
export interface FeeDraftNotification { readonly draft_id: string; readonly notification_date: PlainDate; readonly draft_date: PlainDate; readonly commitment_id_fnma: string; readonly fnma_loan_number?: string | null; readonly fee_type: FeeType; readonly amount_cents: Cents; readonly raw_document_id?: string | null; }
export interface CommittingFeeDraft extends FeeDraftNotification { readonly reconciled_to: string | null; readonly variance_cents: Cents | null; readonly status: "new" | "matched" | "exception"; readonly ledger_set_id: string | null; readonly escalation_id: string | null; }
export type CapturePurpose = "commitment" | "pair_off_quote" | "extension_quote" | "mark";
export interface PewlPriceCapture { readonly capture_id: string; readonly commitment_id: string | null; readonly purpose: CapturePurpose; readonly price: string; readonly ptr: string; readonly captured_at: string; readonly source: "api" | "ui" | "browse_export"; readonly quote_id_fnma: string | null; readonly quote_expires_at: string | null; readonly close_of_business: boolean; readonly raw: Record<string, unknown>; }

// ---- ledger accounts (new, defined here; the kernel's list predates origination — cast like 21.4's origination_fees_receivable)
export const COMMITTING_FEE_EXPENSE: AccountRef = { scope: "corporate", account: "committing_fee_expense" };
export const COMMITTING_FEE_PARTNER_DRAFT: AccountRef = { scope: "corporate", account: "committing_fee_partner_draft" };
export const PARTNER_REIMBURSABLE_FROM_SM: AccountRef = { scope: "corporate", account: "partner_reimbursable_from_sm" };
export const COMMITTING_CASH_BACK_RECEIVABLE: AccountRef = { scope: "corporate", account: "committing_cash_back_receivable" as CorporateAccount };

// ============================================================ Ports (PE–Whole Loan API for best efforts; UI/Sales Desk are operator tasks)
export interface PewlPriceRequest { readonly product_code: string; readonly note_rate: string; readonly pass_through_rate: string; readonly remittance_type: RemittanceType; readonly expires_on: PlainDate; readonly loan_amount_cents: Cents; readonly ltv_pct?: string | null; readonly representative_score?: number | null; readonly units?: number; readonly occupancy?: string; readonly property_type?: string; readonly state?: string; }
export interface PewlQuote { readonly quote_id_fnma: string; readonly price: string; readonly ptr: string; readonly quoted_at: string; readonly quote_expires_at: string; readonly close_of_business: boolean; readonly source: "api" | "browse_export" | "ui"; readonly raw: Record<string, unknown>; }
export interface PewlCommitRequest { readonly quote_id_fnma: string; readonly idempotency_key: string; readonly lineage_id: string | null; readonly loan: Record<string, unknown>; readonly expires_on: PlainDate; readonly underwriting_method: UnderwritingMethod; readonly du_casefile_id: string | null; }
export interface PewlConfirmation { readonly commitment_id_fnma: string; readonly price: string; readonly expires_on: PlainDate; readonly confirmed_at: string; readonly confirmation_document_id: string; readonly fnma_loan_status: FnmaLoanStatus; }
/** `integrations/fnma-api` PE–Whole Loan adapter (Loan Pricing + Loan Committing APIs, **[PARTIALLY VERIFIED — login-gated spec]**): best efforts only. Mandatory commitments, pair-offs, extensions and over-deliveries are UI (`fnma_portal_operator`) or Sales Desk. */
export interface PewlPort { loanPricing(req: PewlPriceRequest, at: string): PewlQuote; loanCommitting(req: PewlCommitRequest, at: string): PewlConfirmation | null; }
/** Test double: a live price by date (ET) or a single price, a quote TTL, optional commit timeout, optional close-of-business flag after 5 p.m. */
export class FakePewl implements PewlPort {
  private price: string; readonly byDate: Record<string, string>; readonly byRate: Record<string, string>; quoteTtlMinutes: number; timeoutNextCommit = false; readonly requests: PewlCommitRequest[] = []; readonly quotes: PewlQuote[] = []; private n = 0; readonly cobAfterClose: boolean;
  constructor(o: { price: string; by_date?: Record<string, string>; by_rate?: Record<string, string>; quote_ttl_minutes?: number; cob_after_close?: boolean } ) { this.price = o.price; this.byDate = o.by_date ?? {}; this.byRate = o.by_rate ?? {}; this.quoteTtlMinutes = o.quote_ttl_minutes ?? 30; this.cobAfterClose = o.cob_after_close ?? true; }
  setPrice(p: string): void { this.price = p; }
  livePrice(req: Pick<PewlPriceRequest, "note_rate">, at: string): string { return this.byRate[req.note_rate] ?? this.byDate[etDate(at)] ?? this.price; }
  loanPricing(req: PewlPriceRequest, at: string): PewlQuote {
    const w = committingWindow(at); const cob = this.cobAfterClose && w.kind === "extended" && w.cob_price_period;
    const q: PewlQuote = { quote_id_fnma: `PEWL-Q-${String(++this.n).padStart(6, "0")}`, price: this.livePrice(req, at), ptr: req.pass_through_rate, quoted_at: at, quote_expires_at: toIso(Date.parse(at) + this.quoteTtlMinutes * 60_000), close_of_business: cob, source: "api", raw: { request: { ...req, loan_amount_cents: String(req.loan_amount_cents) } } };
    this.quotes.push(q); return q;
  }
  loanCommitting(req: PewlCommitRequest, at: string): PewlConfirmation | null {
    this.requests.push(req); if (this.timeoutNextCommit) { this.timeoutNextCommit = false; return null; }
    const q = this.quotes.find((x) => x.quote_id_fnma === req.quote_id_fnma); if (!q) throw new RangeError(`unknown quote ${req.quote_id_fnma}`);
    return { commitment_id_fnma: `BE-2026-${String(this.requests.length).padStart(4, "0")}`, price: q.price, expires_on: rollExpirationToBusinessDay(req.expires_on).expires_on, confirmed_at: at, confirmation_document_id: `doc-pewl-conf-${this.requests.length}`, fnma_loan_status: "committed" };
  }
}
/** Sales Desk (recorded line; an authorized partner trader) — the fallback execution channel when the PE–WL UI is down. */
export interface SalesDeskPort { recordedCall(order: { kind: "mandatory" | "pair_off" | "extension" | "over_delivery"; commitment_id: string; terms: Record<string, unknown> }, at: string): { confirmation_document_id: string; recorded_line_id: string }; }
export class FakeSalesDesk implements SalesDeskPort { readonly calls: unknown[] = []; recordedCall(order: { kind: string; commitment_id: string; terms: Record<string, unknown> }, at: string) { this.calls.push({ ...order, at }); return { confirmation_document_id: `doc-desk-${this.calls.length}`, recorded_line_id: `line-${this.calls.length}` }; } }

// ============================================================ The service (runtime `secondary`; implements 21.4's CommitmentPort)
export interface BestEffortsRequest {
  readonly application_id: string; readonly lock_id: string; readonly lineage_id: string; readonly lock_status: string; readonly mlo_approved: boolean; readonly loan_amount_cents: Cents; readonly note_rate: string; readonly base_price: string; readonly product_code: string; readonly lock_expires_on: PlainDate; readonly rate_set_date: PlainDate;
  readonly property_address: string | null; readonly borrower_last_name: string | null; readonly address_complete: boolean; readonly du_casefile_id: string | null; readonly underwriting_method?: UnderwritingMethod; readonly du_recommendation_at?: string | null; readonly amortization?: Amortization; readonly term_months?: number; readonly lpmi_bps?: number;
  readonly remittance_type?: RemittanceType; readonly requested_expires_on?: PlainDate | null; readonly loan_age_due_on?: PlainDate | null; readonly disbursement_date_planned?: PlainDate | null; readonly dpa_acknowledged?: boolean; readonly dpa_officer_approved?: boolean; readonly forecast?: Omit<LlpaForecastInput, "expected_purchase_ready_date" | "loan_amount_cents"> | null; readonly seller_loan_number?: string | null;
}
export interface CommitOutcome { readonly commitment: Commitment; readonly queued: boolean; readonly quote: PewlPriceCapture | null; readonly forecast: (Forecast & Partial<LlpaForecast>) | null; readonly guardrail_results: readonly { code: string; passed: boolean; detail: string }[]; readonly linked_event: DomainEvent | null; }
export interface ServiceDeps { readonly events: EventStore; readonly clock: Clock; readonly pewl?: PewlPort; readonly salesDesk?: SalesDeskPort; readonly ledger?: Ledger; readonly escalations?: EscalationService; readonly llpaTables?: readonly LlpaTable[]; readonly policy?: Partial<CommitmentPolicy>; readonly partner_id?: string; readonly calendar?: Calendar; }
export interface QueuedRequest { readonly request: BestEffortsRequest; readonly commitment_id: string; readonly queued_at: string; readonly release_at: string; readonly reason: string; }

export class CommitmentService implements CommitmentPort {
  readonly rows: Commitment[] = []; readonly modifications: CommitmentModification[] = []; readonly extensions: CommitmentExtension[] = []; readonly pairOffs: CommitmentPairOff[] = []; readonly overDeliveries: CommitmentOverDelivery[] = []; readonly feeDrafts: CommittingFeeDraft[] = []; readonly priceCaptures: PewlPriceCapture[] = [];
  readonly queue: QueuedRequest[] = []; readonly packages: Record<string, unknown>[] = []; readonly posted: EntrySet[] = [];
  readonly policy: CommitmentPolicy; readonly d: ServiceDeps; readonly cal: Calendar; readonly partnerId: string; readonly actor: Actor = SECONDARY_AGENT;
  constructor(deps: ServiceDeps) { this.d = deps; this.policy = { ...DEFAULT_POLICY, ...(deps.policy ?? {}) }; this.cal = deps.calendar ?? fannieSifma; this.partnerId = deps.partner_id ?? "partner-1"; }
  private now(): string { return this.d.clock.now(); }
  setPolicy(patch: Partial<CommitmentPolicy>): void { Object.assign(this.policy as CommitmentPolicy, patch); }
  /** Feature flags: `execution.mandatory_enabled` (baseline §9) and `secondary.after_hours_commit` — from the policy or a `flags` map the runtime reads off `feature_flags`. */
  flags(f: Record<string, unknown> = {}): { mandatory_enabled: boolean; after_hours_commit: boolean } { return { mandatory_enabled: f["execution.mandatory_enabled"] === true || f["execution.mandatory_enabled"] === "true" || (f["execution.mandatory_enabled"] === undefined && this.policy.mandatory_enabled), after_hours_commit: f["secondary.after_hours_commit"] === true || f["secondary.after_hours_commit"] === "true" || (f["secondary.after_hours_commit"] === undefined && this.policy.after_hours_commit) }; }

  // ---- queries
  get(id: string): Commitment { const c = this.rows.find((x) => x.commitment_id === id); if (!c) throw new RangeError(`no commitment ${id}`); return c; }
  byLineage(lineageId: string): Commitment[] { return this.rows.filter((c) => c.lineage_id === lineageId); }
  open(lineageId: string): CommitmentRecord[] { return this.byLineage(lineageId).filter((c) => this.isOpen(c)).map((c) => this.toRecord(c)); }
  openCommitment(lineageId: string): Commitment | null { return this.byLineage(lineageId).find((c) => this.isOpen(c)) ?? null; }
  isOpen(c: Commitment): boolean { return !["fallout", "expired", "rejected", "purchased", "paired_off", "fulfilled", "auto_paired_off"].includes(c.status); }
  /** 21.4's view (CommitmentRecord): committed / modified / fallout. */
  toRecord(c: Commitment): CommitmentRecord { return { commitment_id: c.commitment_id, commitment_id_fnma: c.commitment_id_fnma ?? "", lineage_id: c.lineage_id ?? "", lock_id: c.lock_id ?? "", application_id: c.application_id ?? "", type: "best_efforts", status: c.status === "fallout" || c.status === "expired" ? "fallout" : this.modifications.some((m) => m.commitment_id === c.commitment_id) ? "modified" : "committed", expires_on: c.expires_on ?? c.original_expires_on ?? plainDate("1970-01-01"), executed_at: c.executed_at ?? c.created_at, price: c.commitment_price, modifications: this.modifications.filter((m) => m.commitment_id === c.commitment_id).length, fallout_reason: c.fallout_reason }; }
  /** Rule 14: Σ `amount_cents` executed on an ET day across the partner's seller number. */
  executedTodayCents(atIso: string): Cents { const day = etDate(atIso); return this.rows.filter((c) => c.executed_at && etDate(c.executed_at) === day && c.status !== "rejected").reduce((s, c) => s + c.amount_cents, 0n); }
  /** 29.2's position feed: each lineage as locked_uncommitted / committed / closed / fallout … */
  position(atIso: string): { commitment_id: string; lineage_id: string | null; application_id: string | null; state: "locked_uncommitted" | "committed" | "closed" | "fallout" | "expired" | "purchased" | "paired_off" | "mandatory_open"; amount_cents: Cents; release_at: string | null; expires_on: PlainDate | null }[] {
    return this.rows.filter((c) => c.created_at <= atIso).map((c) => ({ commitment_id: c.commitment_id, lineage_id: c.lineage_id, application_id: c.application_id, amount_cents: c.amount_cents, release_at: c.queued_release_at, expires_on: c.expires_on,
      state: c.status === "queued" || c.status === "requested" || c.status === "priced" || c.status === "rejected" || c.status === "unconfirmed" ? "locked_uncommitted" : c.status === "closed" || c.status === "delivered" ? "closed" : c.status === "fallout" ? "fallout" : c.status === "expired" ? "expired" : c.status === "purchased" || c.status === "fulfilled" ? "purchased" : c.status === "paired_off" || c.status === "auto_paired_off" ? "paired_off" : c.type === "mandatory" ? "mandatory_open" : "committed" }));
  }

  // ---- event helpers
  private emit(c: Pick<Commitment, "commitment_id" | "application_id" | "loan_id">, type: string, payload: Record<string, unknown>, at: string = this.now()): DomainEvent {
    return this.d.events.append({ type, ...(c.application_id ? { applicationId: c.application_id } : {}), ...(c.loan_id ? { loanId: c.loan_id } : {}), aggregate: { kind: "commitment", id: c.commitment_id }, actor: this.actor, occurredAt: at,
      payload: { commitment_id: c.commitment_id, ...(c.application_id ? { application_id: c.application_id } : {}), source: "origination", ...payload } });
  }
  private update(id: string, patch: Partial<Commitment>, at: string = this.now()): Commitment { const i = this.rows.findIndex((x) => x.commitment_id === id); if (i < 0) throw new RangeError(`no commitment ${id}`); const next = { ...this.rows[i]!, ...patch, updated_at: at }; this.rows[i] = next; return next; }
  private escalate(kind: EscalationKind, c: Pick<Commitment, "commitment_id" | "application_id" | "loan_id">, payload: Record<string, unknown>, severity?: string, ownerRole?: string): string | null {
    if (!this.d.escalations) return null;
    const e = this.d.escalations.open({ kind, ...(c.application_id ? { applicationId: c.application_id } : {}), ...(c.loan_id ? { loanId: c.loan_id } : {}), ...(severity ? { severity } : {}), ...(ownerRole ? { ownerRole } : {}), payload: { commitment_id: c.commitment_id, ...(c.application_id ? { application_id: c.application_id } : {}), source: "origination", ...payload } }, this.actor);
    return e.id;
  }
  /** Every UI-only step is a `fnma_portal_operator` task (4-hour SLA; 1 hour when the commitment expires today) — `escalation.created{kind=human_portal_task, task=fnma_portal_commitment_task}` arms `SM_PORTAL_OPERATOR_COMMITMENT_TASK_4H`. */
  private operatorTask(c: Commitment, step: string, pkg: Record<string, unknown>, at: string): string | null {
    const expiringToday = c.expires_on !== null && c.expires_on === etDate(at);
    return this.escalate("human_portal_task", c, { task: "fnma_portal_commitment_task", step, sla_hours: expiringToday ? 1 : 4, expiring_today: expiringToday, accept_window_seconds: UI_ACCEPT_WINDOW_SECONDS, package: pkg, runbook: `pewl-${step}` }, expiringToday ? "sev2" : "sev3");
  }
  /** Operator tasks opened for this process (the SLA sweep re-queues to the backup operator at breach). */
  operatorTasksOpened(): DomainEvent[] { return this.d.events.ofType("escalation.created").filter((e) => p(e).kind === "human_portal_task" && p(e).task === "fnma_portal_commitment_task"); }
  recordOperatorConfirmation(i: { escalation_id: string; commitment_id: string; confirmation_document_id: string; at?: string }): DomainEvent {
    const c = this.get(i.commitment_id); nonEmpty(i.confirmation_document_id, "confirmation_document_id");
    return this.emit(c, "commitment.operator_task.completed", { escalation_id: i.escalation_id, confirmation_document_id: i.confirmation_document_id }, i.at ?? this.now());
  }

  // ---- Rule 4: price capture ---------------------------------------------------------------
  priceForCommitment(i: { commitment_id?: string | null; product_code: string; note_rate: string; pass_through_rate?: string; remittance_type?: RemittanceType; expires_on: PlainDate; loan_amount_cents: Cents; purpose?: CapturePurpose; at?: string; source?: "api" | "ui" | "browse_export"; price?: string; quote_id_fnma?: string; quote_expires_at?: string; ltv_pct?: string | null; representative_score?: number | null; state?: string }): PewlPriceCapture {
    const at = i.at ?? this.now(); nonEmpty(i.product_code, "product_code"); nonEmpty(i.note_rate, "note_rate"); positive(i.loan_amount_cents, "loan_amount_cents");
    const ptr = i.pass_through_rate ?? passThroughRate(i.note_rate, this.policy.servicing_fee_bps);
    const expires_on = rollExpirationToBusinessDay(plainDate(i.expires_on), this.cal).expires_on;
    let cap: PewlPriceCapture;
    if (i.price !== undefined) {   // UI price read by the operator, or a Browse Prices export — never a close-of-business price
      cap = { capture_id: randomUUID(), commitment_id: i.commitment_id ?? null, purpose: i.purpose ?? "commitment", price: dec(i.price).toFixed(3, "HALF_UP"), ptr, captured_at: at, source: i.source ?? "ui", quote_id_fnma: i.quote_id_fnma ?? null, quote_expires_at: i.quote_expires_at ?? (i.source === "ui" || i.source === undefined ? toIso(Date.parse(at) + UI_ACCEPT_WINDOW_SECONDS * 1000) : null), close_of_business: committingWindow(at, this.policy).cob_price_period && i.source !== "browse_export", raw: { price: i.price } };
    } else {
      const port = this.d.pewl; if (!port) throw new RangeError("a PE–WL pricing port (or an explicit price) is required");
      const q = port.loanPricing({ product_code: i.product_code, note_rate: i.note_rate, pass_through_rate: ptr, remittance_type: i.remittance_type ?? this.policy.remittance_type, expires_on, loan_amount_cents: i.loan_amount_cents, ltv_pct: i.ltv_pct ?? null, representative_score: i.representative_score ?? null, ...(i.state ? { state: i.state } : {}) }, at);
      cap = { capture_id: randomUUID(), commitment_id: i.commitment_id ?? null, purpose: i.purpose ?? "commitment", price: dec(q.price).toFixed(3, "HALF_UP"), ptr: q.ptr, captured_at: q.quoted_at, source: q.source, quote_id_fnma: q.quote_id_fnma, quote_expires_at: q.quote_expires_at, close_of_business: q.close_of_business, raw: q.raw };
    }
    this.priceCaptures.push(cap);
    const subj = { commitment_id: cap.commitment_id ?? `quote-${cap.capture_id}`, application_id: i.commitment_id ? this.get(i.commitment_id).application_id : null, loan_id: null };
    this.emit(subj, "commitment.priced", { capture_id: cap.capture_id, quote_id_fnma: cap.quote_id_fnma, price: cap.price, ptr: cap.ptr, quoted_at: cap.captured_at, expires_at: cap.quote_expires_at, source: cap.source, close_of_business: cap.close_of_business, purpose: cap.purpose }, at);
    if (i.commitment_id && cap.purpose === "commitment") this.update(i.commitment_id, { status: "priced", quote_id_fnma: cap.quote_id_fnma, quoted_at: cap.captured_at, quote_expires_at: cap.quote_expires_at, commitment_price: cap.price, pass_through_rate: cap.ptr }, at);
    return cap;
  }
  captureMarketPrice(i: { commitment_id: string; purpose: CapturePurpose; at?: string; price?: string; source?: "api" | "ui" | "browse_export" }): PewlPriceCapture {
    const c = this.get(i.commitment_id);
    return this.priceForCommitment({ commitment_id: c.commitment_id, product_code: c.product_code, note_rate: c.note_rate, pass_through_rate: c.pass_through_rate, remittance_type: c.remittance_type, expires_on: c.expires_on ?? plainDate(etDate(i.at ?? this.now())), loan_amount_cents: c.amount_cents, purpose: i.purpose, ...(i.at ? { at: i.at } : {}), ...(i.price !== undefined ? { price: i.price } : {}), ...(i.source ? { source: i.source } : {}) });
  }

  // ---- Rules 1, 2, 13, 14 and the guards: best-efforts request → price → commit ----------------
  private newRow(i: BestEffortsRequest, at: string, expiration: CommitmentExpiration): Commitment {
    const ptr = passThroughRate(i.note_rate, this.policy.servicing_fee_bps, i.lpmi_bps ?? 0, i.amortization ?? "fixed");
    return { commitment_id: randomUUID(), partner_id: this.partnerId, commitment_id_fnma: null, type: "best_efforts", execution_channel: "api", application_id: i.application_id, loan_id: null, lock_id: i.lock_id, lineage_id: i.lineage_id, du_casefile_id: i.du_casefile_id, underwriting_method: i.underwriting_method ?? (i.du_casefile_id ? "du" : "other"), du_recommendation_at: i.du_recommendation_at ?? null,
      product_code: i.product_code, fnma_product_name: i.amortization && i.amortization !== "fixed" ? `Conventional ARM ${i.amortization}` : `${(i.term_months ?? 360) / 12}-Year Fixed Rate`, amortization: i.amortization ?? "fixed", term_months: i.term_months ?? 360, note_rate: dec(i.note_rate).toFixed(4, "HALF_UP"), servicing_fee_bps: this.policy.servicing_fee_bps, lpmi_bps: i.lpmi_bps ?? 0, pass_through_rate: ptr, ptr_range_low: null, ptr_range_high: null,
      remittance_type: i.remittance_type ?? this.policy.remittance_type, servicing_option: "retained", amount_cents: i.loan_amount_cents, max_amount_cents: i.loan_amount_cents, original_amount_cents: i.loan_amount_cents, remaining_balance_cents: i.loan_amount_cents, purchased_cents: 0n, paired_off_cents: 0n, over_delivered_cents: 0n, tolerance_low_cents: null, tolerance_high_cents: null, hbl_cap_pct: null,
      commitment_price: "0.000", quote_id_fnma: null, quoted_at: null, quote_expires_at: null, executed_at: null, effective_on: null, commitment_period_days: expiration.commitment_period_days, expires_on: expiration.expires_on, original_expires_on: expiration.expires_on, manual_extension_days: 0, auto_extension_days: 0, closed_status_set_at: null, fnma_loan_status: null, status: "requested", pair_off_terms: null,
      fallout_reason: null, pair_off_expected: null, dpa_exposure_until: null, duplicate_of_commitment_id: null, expected_purchase_ready_date: i.disbursement_date_planned ? expectedPurchaseReadyDate(i.disbursement_date_planned, this.policy.expected_purchase_ready_bd, this.cal) : null, llpa_forecast_pct: null, llpa_forecast_cents: null, credits_forecast_cents: 0n, net_price_forecast: null, proceeds_forecast_cents: null, execution_variance_cents: null,
      confirmation_document_id: null, email_confirmation_document_id: null, agent_decision_id: null, borrower_last_name: i.borrower_last_name, property_address: i.property_address, disbursement_date: null, first_payment_date: null, queued_release_at: null, overnight_price_change: null, sfcs_staged: [], recorded_by: `${this.actor.kind}:${this.actor.id}`, created_at: at, updated_at: at };
  }
  /** `commitment.requested` on `lock.executed` (rule 1): the row exists from the request so the daily-limit gate can see it. */
  request(i: BestEffortsRequest, at: string = this.now()): Commitment {
    nonEmpty(i.application_id, "application_id"); nonEmpty(i.lock_id, "lock_id"); nonEmpty(i.lineage_id, "lineage_id"); positive(i.loan_amount_cents, "loan_amount_cents"); nonEmpty(i.note_rate, "note_rate"); nonEmpty(i.base_price, "base_price"); plainDate(i.lock_expires_on); plainDate(i.rate_set_date);
    const existing = this.byLineage(i.lineage_id).find((c) => c.status === "requested" || c.status === "priced" || c.status === "queued");
    if (existing) return existing;
    const expiration = i.requested_expires_on ? { ...commitmentExpiration(i.lock_expires_on, plainDate(etDate(at)), this.policy, i.loan_age_due_on ?? null, this.cal), expires_on: rollExpirationToBusinessDay(i.requested_expires_on, this.cal).expires_on } : commitmentExpiration(i.lock_expires_on, plainDate(etDate(at)), this.policy, i.loan_age_due_on ?? null, this.cal);
    const c = this.newRow(i, at, { ...expiration, commitment_period_days: daysBetween(plainDate(etDate(at)), expiration.expires_on) }); this.rows.push(c);
    this.emit(c, "commitment.requested", { lineage_id: c.lineage_id, lock_id: c.lock_id, amount_cents: String(c.amount_cents), executed_today_cents: String(this.executedTodayCents(at)), expires_on: c.expires_on, type: c.type }, at);
    return c;
  }
  private reject(c: Commitment, reason: string, citation: string, detail: string, at: string, queued = false, release_at: string | null = null): never {
    this.update(c.commitment_id, { status: queued ? "queued" : "rejected", queued_release_at: release_at }, at);
    this.emit(c, "commitment.rejected", { reason, citation, detail, queued, release_at }, at);
    throw new CommitmentRefused(reason, citation, detail);
  }
  /** The guardrails of the state machine (`executed` requires …), in order; every result lands in the decision record. */
  private guard(c: Commitment, i: BestEffortsRequest, at: string, flags: Record<string, unknown>): { results: { code: string; passed: boolean; detail: string }[]; window: WindowState; dpa: ReturnType<typeof dpaWindowGate> } {
    const results: { code: string; passed: boolean; detail: string }[] = [];
    const chk = (code: string, passed: boolean, detail: string) => { results.push({ code, passed, detail }); return passed; };
    if (!chk("lock_state", i.lock_status === "executed" || i.lock_status === "confirmed", `lock.status=${i.lock_status}`)) this.reject(c, "lock_not_executed", "29.1 guards: executed requires lock.status ∈ {executed, confirmed}", `lock ${i.lock_id} is ${i.lock_status}`, at);
    if (!chk("mlo_approval", i.mlo_approved, "mlo approval recorded on the lock (21.4)")) this.reject(c, "mlo_approval_missing", "29.1 AI design: never commit without an executed, MLO-approved lock", "lock lacks the MLO of record's approval", at);
    const otherOpen = this.byLineage(i.lineage_id).find((x) => x.commitment_id !== c.commitment_id && this.isOpen(x) && x.status !== "requested" && x.status !== "priced" && x.status !== "queued");
    if (!chk("one_open_per_lineage", !otherOpen, otherOpen ? `open commitment ${otherOpen.commitment_id_fnma}` : "no other open commitment on the lineage")) this.reject(c, "DUPLICATE_COMMITMENT", "C2-1.2-02 duplicate commitment price adjustment; rule 13: one open commitment per lineage_id", `lineage ${i.lineage_id} already has an open commitment`, at);
    const casefileDup = i.du_casefile_id ? this.rows.find((x) => x.commitment_id !== c.commitment_id && x.du_casefile_id === i.du_casefile_id && this.isOpen(x) && x.commitment_id_fnma) : undefined;
    if (!chk("casefile_not_committed", !casefileDup, casefileDup ? `casefile ${i.du_casefile_id} on ${casefileDup.commitment_id_fnma}` : "casefile not previously committed")) this.reject(c, "duplicate_casefile", "PE–WL FAQ: the system will not allow a committed loan with the same DU Casefile ID", `DU casefile ${i.du_casefile_id} is already committed`, at);
    if (!chk("complete_address", i.address_complete && !!i.property_address, i.property_address ?? "TBD")) this.reject(c, "tbd_address", "29.1 rule 13 / AI design: never a commitment on a TBD address (PE–WL auto-DPA on fallout)", "property address is incomplete", at);
    const du = duApproveWindow(i.du_recommendation_at ?? null, at, c.underwriting_method);
    if (!chk("FNMA_C2_1_2_03_DU_APPROVE_60_GATE", du.open, du.days === null ? "underwriting_method=other" : `${du.days} days since Approve/Eligible`)) this.reject(c, "FNMA_C2_1_2_03_DU_APPROVE_60_GATE", "C2-1.2-03: the DU loan casefile must have received Approve/Eligible no earlier than 60 days prior to commitment", du.reason ?? "closed", at);
    const prior = this.rows.filter((x) => x.commitment_id !== c.commitment_id && x.dpa_exposure_until && x.borrower_last_name === i.borrower_last_name && x.property_address === i.property_address).sort((a, b) => (a.dpa_exposure_until! < b.dpa_exposure_until! ? 1 : -1))[0];
    const dpa = dpaWindowGate({ dpa_exposure_until: prior?.dpa_exposure_until ?? null, requested_on: etDate(at), same_borrower_property: !!prior, dpa_acknowledged: i.dpa_acknowledged === true, officer_approved: i.dpa_officer_approved === true, dpa_officer_threshold_cents: this.policy.dpa_officer_threshold_cents });
    if (!chk("FNMA_PEWL_DPA_WINDOW_30", dpa.open, prior ? `prior fallout ${prior.commitment_id_fnma} DPA window to ${prior.dpa_exposure_until}` : "no prior fallout for this borrower/property")) this.reject(c, "dpa_window", "C2-1.2-02: duplicate commitment price adjustment within 30 days of fallout or expiration", dpa.reason ?? "dpa_window", at);
    if (prior && dpa.inside_window) this.update(c.commitment_id, { duplicate_of_commitment_id: prior.commitment_id }, at);
    const period = daysBetween(plainDate(etDate(at)), c.expires_on!);
    if (!chk("expires_on_business_day_le_90", this.cal.isBusinessDay(c.expires_on!) && period <= this.policy.max_commitment_period_days && period >= 1, `${c.expires_on} (${period} days)`)) this.reject(c, "expiration_invalid", "C2-1.1-03 / C2-1.2-02: commitments must expire on a business day, 1–90 days", `${c.expires_on} is not a valid expiration`, at);
    const limit = dailyLimitCheck(this.executedTodayCents(at), c.amount_cents, this.policy.daily_limit_cents);
    if (!chk("FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE", limit.allowed, `${formatCents(limit.after_cents, { symbol: true })} after this commit`)) {
      const w0 = committingWindow(at, this.policy, this.cal); const release = w0.next_open_at;
      this.queue.push({ request: i, commitment_id: c.commitment_id, queued_at: at, release_at: release, reason: "daily_limit" });
      this.escalate("officer", c, { task: "sales_desk_daily_limit_approval", reason: "FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE", executed_today_cents: String(this.executedTodayCents(at)), amount_cents: String(c.amount_cents), action: "contact the Capital Markets Pricing and Sales Desk for approval or let the commit run next day" }, "sev2");
      this.reject(c, "FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE", "C2-1.1-03: lenders may not exceed $200 million in aggregate commitment volume per day", `${formatCents(limit.after_cents, { symbol: true })} exceeds the daily limit; queued to ${release}`, at, true, release);
    }
    const window = committingWindow(at, this.policy, this.cal); const fl = this.flags(flags);
    const inWindow = window.kind === "standard" || (window.kind === "extended" && fl.after_hours_commit && !window.cob_price_period);
    if (!chk("committing_window", inWindow, `${window.kind}${window.kind === "extended" ? ` (after_hours_commit=${fl.after_hours_commit})` : ""}`)) {
      // 29.2 carries the lock as "locked, uncommitted" overnight: the reference mark at queue time (never executed — a close-of-business price) is what the overnight price change is measured from.
      if (this.d.pewl) { const m = this.priceForCommitment({ commitment_id: c.commitment_id, product_code: c.product_code, note_rate: c.note_rate, pass_through_rate: c.pass_through_rate, remittance_type: c.remittance_type, expires_on: c.expires_on!, loan_amount_cents: c.amount_cents, purpose: "mark", at }); this.update(c.commitment_id, { commitment_price: m.price }, at); }
      this.queue.push({ request: i, commitment_id: c.commitment_id, queued_at: at, release_at: window.next_open_at, reason: "outside_window" });
      this.reject(c, "outside_window", "PE–WL windows (00b-orig F7): standard 8:15 a.m.–5:00 p.m. ET; close-of-business prices may not be used to execute commitments", `lock at ${at} is outside the committing window; queued to ${window.next_open_at}`, at, true, window.next_open_at);
    }
    return { results, window, dpa };
  }
  /** Rule 1 end to end: validate the lineage, DU window, address, day limit and window, price through the API, check the borrower's quote (execution variance), commit inside the quote window, store the confirmation, emit `commitment.executed`; 21.4's `linkCommitment` records `lock.commitment.linked` when the lock is supplied. */
  commitBestEfforts(i: BestEffortsRequest, o: { at?: string; lock?: Lock | null; flags?: Record<string, unknown>; quote?: PewlPriceCapture | null } = {}): CommitOutcome {
    const at = o.at ?? this.now();
    let c = this.request(i, at);
    const markPrice = c.status === "requested" && c.commitment_price !== "0.000" ? c.commitment_price : null;   // a released queue entry: the queue-time mark
    const g = this.guard(c, i, at, o.flags ?? {});
    const quote = o.quote ?? (c.quote_id_fnma && c.quote_expires_at && Date.parse(c.quote_expires_at) > Date.parse(at) ? this.priceCaptures.find((q) => q.quote_id_fnma === c.quote_id_fnma) ?? null : null) ?? this.priceForCommitment({ commitment_id: c.commitment_id, product_code: c.product_code, note_rate: c.note_rate, pass_through_rate: c.pass_through_rate, remittance_type: c.remittance_type, expires_on: c.expires_on!, loan_amount_cents: c.amount_cents, at, ...(i.forecast?.state ? { state: i.forecast.state } : {}) });
    if (quote.close_of_business) this.reject(c, "cob_price", "PE–WL: close-of-business prices may not be used to execute any commitments", "the captured price is a close-of-business price", at);
    const accept = commitAcceptWindowGate({ now: at, quote_expires_at: quote.quote_expires_at, quoted_at: quote.captured_at });
    g.results.push({ code: "FNMA_PEWL_COMMIT_ACCEPT_60S", passed: accept.open, detail: accept.reason ?? `quote ${quote.quote_id_fnma} valid to ${quote.quote_expires_at}` });
    if (!accept.open) this.reject(c, "quote_expired", "FNMA_PEWL_COMMIT_ACCEPT_60S: never commit on a stale price — re-price", accept.reason ?? "stale quote", at);
    const port = this.d.pewl; if (!port) throw new RangeError("a PE–WL committing port is required");
    const conf = port.loanCommitting({ quote_id_fnma: quote.quote_id_fnma ?? "", idempotency_key: `${i.lineage_id}:${i.lock_id}`, lineage_id: i.lineage_id, loan: { loan_amount_cents: String(c.amount_cents), note_rate: c.note_rate, product_code: c.product_code, remittance_type: c.remittance_type, borrower_last_name: c.borrower_last_name, property_address: c.property_address, seller_loan_number: i.seller_loan_number ?? null }, expires_on: c.expires_on!, underwriting_method: c.underwriting_method, du_casefile_id: c.du_casefile_id }, at);
    if (!conf) {   // timeout after send → unconfirmed; reconciled from the e-mail confirmation / UI within 15 minutes, else operator task; no second commit until reconciled
      c = this.update(c.commitment_id, { status: "unconfirmed" }, at);
      this.emit(c, "commitment.unconfirmed", { reconcile_by: toIso(Date.parse(at) + 15 * 60_000) }, at);
      throw new CommitmentRefused("unconfirmed", "29.1 integrations: timeout after send → unconfirmed; reconcile from the confirmation e-mail / PE–WL UI within 15 minutes", `commit for ${c.commitment_id} sent but not confirmed`);
    }
    const variance = executionVarianceCents(conf.price, i.base_price, c.amount_cents);
    const overnight = markPrice ? dec(conf.price).sub(dec(markPrice)).toFixed(3, "HALF_UP") : null;
    c = this.update(c.commitment_id, { status: "committed", commitment_id_fnma: conf.commitment_id_fnma, commitment_price: dec(conf.price).toFixed(3, "HALF_UP"), executed_at: at, effective_on: plainDate(etDate(at)), expires_on: conf.expires_on, original_expires_on: conf.expires_on, commitment_period_days: daysBetween(plainDate(etDate(at)), conf.expires_on), fnma_loan_status: conf.fnma_loan_status, confirmation_document_id: conf.confirmation_document_id, execution_variance_cents: variance, quote_id_fnma: quote.quote_id_fnma, quoted_at: quote.captured_at, quote_expires_at: quote.quote_expires_at, execution_channel: quote.source === "ui" ? "ui_operator" : "api", overnight_price_change: overnight, queued_release_at: null }, at);
    this.emit(c, "commitment.executed", { commitment_id_fnma: c.commitment_id_fnma, type: c.type, price: c.commitment_price, ptr: c.pass_through_rate, expires_on: c.expires_on, original_expires_on: c.original_expires_on, commitment_period_days: c.commitment_period_days, underwriting_method: c.underwriting_method, du_casefile_id: c.du_casefile_id, amount_cents: String(c.amount_cents), lineage_id: c.lineage_id, lock_id: c.lock_id, quote_id_fnma: c.quote_id_fnma, execution_variance_cents: String(variance), remittance_type: c.remittance_type, execution_channel: c.execution_channel, confirmation_document_id: c.confirmation_document_id }, at);
    let forecast: CommitOutcome["forecast"] = null;
    if (i.forecast && c.expected_purchase_ready_date) forecast = this.computeNetPriceForecast({ commitment_id: c.commitment_id, forecast: i.forecast, at });
    const linked = o.lock ? linkCommitment(this.d.events, o.lock, this.toRecord(this.get(c.commitment_id)), at).event : null;
    return { commitment: this.get(c.commitment_id), queued: false, quote, forecast, guardrail_results: g.results, linked_event: linked };
  }
  /** 08:15 a.m. ET window open (and Sales Desk approval on the daily limit): release the queue — each commit re-prices live and records the overnight price change. */
  releaseQueue(at: string = this.now(), o: { lock?: Lock | null; flags?: Record<string, unknown>; only?: string | null } = {}): CommitOutcome[] {
    const due = this.queue.filter((q) => Date.parse(q.release_at) <= Date.parse(at) && (!o.only || q.commitment_id === o.only)); const out: CommitOutcome[] = [];
    for (const q of due) {
      this.queue.splice(this.queue.indexOf(q), 1);
      const c = this.get(q.commitment_id);
      this.update(c.commitment_id, { status: "requested", queued_release_at: null }, at);
      out.push(this.commitBestEfforts(q.request, { at, lock: o.lock ?? null, flags: o.flags ?? {} }));
    }
    return out;
  }
  // ---- CommitmentPort (21.4 calls with the lock alone: fixture defaults for what the lock does not carry)
  requestBestEfforts(lock: Lock, at: string): CommitmentRecord {
    if (!lock.expires_on || !lock.rate_set_date) throw new CommitmentRefused("LOCK_STATE", "29.1 best efforts: requested on lock.executed", "commitment needs an executed lock");
    const du = this.d.events.ofType("du.findings.received").filter((e) => e.applicationId === lock.application_id && p(e).recommendation === "approve_eligible").at(-1);
    const r = this.commitBestEfforts({ application_id: lock.application_id, lock_id: lock.lock_id, lineage_id: lock.lineage_id, lock_status: lock.status, mlo_approved: !!lock.mlo_nmlsr_id, loan_amount_cents: lock.loan_amount_cents, note_rate: lock.note_rate, base_price: lock.price, product_code: lock.product_code, lock_expires_on: lock.expires_on, rate_set_date: lock.rate_set_date,
      property_address: "on file (21.4 lock)", borrower_last_name: "on file", address_complete: true, du_casefile_id: du ? String(p(du).casefile_id) : null, underwriting_method: du ? "du" : "other", du_recommendation_at: du ? du.occurredAt : null }, { at, lock });
    return this.toRecord(r.commitment);
  }
  keyDataChange(lock: Lock, at: string, change: string): CommitmentRecord {
    const cur = this.openCommitment(lock.lineage_id); if (!cur) throw new CommitmentRefused("NO_COMMITMENT", "C2-1.2-03", `lineage ${lock.lineage_id} has no open commitment`);
    const after: Record<string, unknown> = {}; if (/note_rate|price/.test(change)) after.note_rate = lock.note_rate; if (/amount/.test(change)) after.loan_amount_cents = lock.loan_amount_cents; if (/product/.test(change)) after.product_code = lock.product_code;
    const m = this.modifyCommitment({ commitment_id: cur.commitment_id, changed_at: at, reported_at: at, after: Object.keys(after).length ? after : { note_rate: lock.note_rate }, live_price_for_new_terms: lock.price, lock_id: lock.lock_id });
    return this.toRecord(this.get(m.commitment_id));
  }
  recordFallout(lineageId: string, reason: CancelReason, at: string): { commitment: CommitmentRecord | null; pair_off_expected: false } {
    const cur = this.openCommitment(lineageId); if (!cur) return { commitment: null, pair_off_expected: false };
    const c = this.moveToFallout({ commitment_id: cur.commitment_id, reason, at });
    return { commitment: this.toRecord(c), pair_off_expected: false };
  }

  // ---- Rule 5: forecast ----------------------------------------------------------------------
  computeNetPriceForecast(i: { commitment_id: string; forecast: Omit<LlpaForecastInput, "expected_purchase_ready_date" | "loan_amount_cents"> & { expected_purchase_ready_date?: PlainDate; upb_at_purchase_cents?: Cents }; at?: string }): Forecast & LlpaForecast & { expected_purchase_ready_date: PlainDate } {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now();
    const eprd = i.forecast.expected_purchase_ready_date ?? c.expected_purchase_ready_date; if (!eprd) throw new RangeError("expected_purchase_ready_date is required (disbursement_date_planned + 5 business_days_fannie_et)");
    const tables = i.forecast.tables ?? this.d.llpaTables ?? []; if (!tables.length) throw new RangeError("llpa tables (20.4) are required for the forecast");
    const upb = i.forecast.upb_at_purchase_cents ?? c.amount_cents;
    const l = llpaForecast({ ...i.forecast, tables, loan_amount_cents: upb, expected_purchase_ready_date: eprd });
    const f = netPriceForecast({ commitment_price: c.commitment_price, llpa_forecast_pct: l.llpa_forecast_pct, upb_at_purchase_cents: upb, credits_forecast_cents: l.credits_forecast_cents });
    this.update(c.commitment_id, { expected_purchase_ready_date: eprd, llpa_forecast_pct: l.llpa_forecast_pct, llpa_forecast_cents: f.llpa_forecast_cents, credits_forecast_cents: f.credits_forecast_cents, net_price_forecast: f.net_price_forecast, proceeds_forecast_cents: f.proceeds_forecast_cents, sfcs_staged: l.sfcs }, at);
    this.emit(c, "commitment.forecast.updated", { expected_purchase_ready_date: eprd, matrix_version: l.matrix_version, llpa_forecast_pct: l.llpa_forecast_pct, llpa_forecast_cents: String(f.llpa_forecast_cents), net_price_forecast: f.net_price_forecast, proceeds_forecast_cents: String(f.proceeds_forecast_cents), sfcs: l.sfcs }, at);
    return { ...l, ...f, expected_purchase_ready_date: eprd };
  }

  // ---- Rule 7: key-data modifications --------------------------------------------------------
  modifyCommitment(i: { commitment_id: string; changed_at: string; reported_at?: string; after: Record<string, unknown>; live_price_for_new_terms?: string | null; channel?: ExecutionChannel; confirmation_document_id?: string | null; lock_id?: string | null; complete_address_change?: boolean; uw_method_to_other?: boolean; ineligible?: boolean }): CommitmentModification {
    const c = this.get(i.commitment_id); const changedAt = isoOrThrow(i.changed_at, "changed_at"); const reportedAt = i.reported_at ?? this.now();
    if (c.status !== "committed" && c.status !== "closed") throw new CommitmentRefused("not_modifiable", "29.1 state machine: modifications apply to committed/closed best-efforts commitments", `commitment ${c.commitment_id} is ${c.status}`);
    const fields = Object.keys(i.after).filter((k): k is KeyDataField => (KEY_DATA_FIELDS as readonly string[]).includes(k)); if (!fields.length) throw new RangeError(`after must name a key-data field (${KEY_DATA_FIELDS.join(", ")})`);
    if (i.ineligible) { this.moveToFallout({ commitment_id: c.commitment_id, reason: "ineligible_key_data_change", at: reportedAt }); throw new CommitmentRefused("ineligible_key_data_change", "C2-1.2-02: a key-data change that makes the loan ineligible is fallout without fee", "loan no longer eligible — fallout recorded"); }
    const recommit = requiresRecommit(fields, { ...(i.complete_address_change !== undefined ? { complete_address_change: i.complete_address_change } : {}), ...(i.uw_method_to_other !== undefined ? { uw_method_to_other: i.uw_method_to_other } : {}) });
    if (recommit) { this.moveToFallout({ commitment_id: c.commitment_id, reason: recommit, at: reportedAt }); throw new CommitmentRefused(recommit, "PE–WL FAQ: complete property address changes and a change in underwriting type from DU to other require fallout and recommitment", `${recommit}: fallout recorded; recommit on a new commitment`); }
    const before: Record<string, unknown> = {}; const patch: CommitmentPatch = {};
    const rowKey: Partial<Record<KeyDataField, keyof Commitment>> = { loan_amount_cents: "amount_cents", note_rate: "note_rate", product_code: "product_code", address: "property_address", borrower: "borrower_last_name" };
    for (const f of fields) { const k = rowKey[f]; before[f] = k ? (c[k] as unknown) ?? null : null; }
    if (i.after.loan_amount_cents !== undefined) { const amt = applyAmountChange(c.amount_cents, c.max_amount_cents, typeof i.after.loan_amount_cents === "bigint" ? i.after.loan_amount_cents : BigInt(String(i.after.loan_amount_cents))); patch.amount_cents = amt.amount_cents; patch.max_amount_cents = amt.max_amount_cents; patch.remaining_balance_cents = amt.amount_cents; }
    let repriced = false, worst = false, newPrice: string | null = null;
    if ((i.after.note_rate !== undefined || i.after.product_code !== undefined)) {
      if (i.after.note_rate !== undefined) { patch.note_rate = dec(String(i.after.note_rate)).toFixed(4, "HALF_UP"); patch.pass_through_rate = passThroughRate(patch.note_rate, c.servicing_fee_bps, c.lpmi_bps, c.amortization); }
      if (i.after.product_code !== undefined) patch.product_code = String(i.after.product_code);
      const live = i.live_price_for_new_terms ?? this.captureMarketPrice({ commitment_id: c.commitment_id, purpose: "mark", at: reportedAt }).price;
      const w = worstCasePrice(c.commitment_price, live); repriced = w.repriced; worst = w.worst_case_applied; newPrice = w.new_commitment_price; patch.commitment_price = newPrice;
    }
    if (i.after.units !== undefined) before.units = null;
    const due = keyDataChangeDue(changedAt, this.cal);
    const m: CommitmentModification = { modification_id: randomUUID(), commitment_id: c.commitment_id, changed_at: changedAt, reported_at: reportedAt, due_at: due.due_at, fields: { before, after: Object.fromEntries(fields.map((f) => [f, typeof i.after[f] === "bigint" ? String(i.after[f]) : i.after[f]])) }, repriced, new_commitment_price: newPrice, worst_case_applied: worst, channel: i.channel ?? "api", confirmation_document_id: i.confirmation_document_id ?? null, late: Date.parse(reportedAt) > Date.parse(due.due_at) };
    this.modifications.push(m);
    const next = this.update(c.commitment_id, { ...patch, ...(i.lock_id ? { lock_id: i.lock_id } : {}) }, reportedAt);
    if (m.channel === "ui_operator") this.operatorTask(next, "modify", { commitment_id_fnma: next.commitment_id_fnma, fields: m.fields, due_at: m.due_at }, reportedAt);
    this.emit(next, "commitment.modified", { modification_id: m.modification_id, commitment_id_fnma: next.commitment_id_fnma, lineage_id: next.lineage_id, lock_id: next.lock_id, fields: m.fields, change: fields.join(","), repriced, new_commitment_price: newPrice, worst_case_applied: worst, price: next.commitment_price, amount_cents: String(next.amount_cents), max_amount_cents: String(next.max_amount_cents), due_at: m.due_at, late: m.late, worst_case_pricing: "fannie_mae_acquisition_price" }, reportedAt);
    return m;
  }

  // ---- Rule 9: closed status -----------------------------------------------------------------
  /** On `loan.funded` (disbursement, not consummation): closed status the same day where possible and never later than 5:00 p.m. ET the next Fannie Mae business day — from that moment the loan is a mandatory obligation. */
  setClosedStatus(i: { commitment_id: string; disbursement_date: PlainDate; at?: string; first_payment_date?: PlainDate | null; loan_id?: string | null; funded?: boolean; channel?: ExecutionChannel }): Commitment {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now(); plainDate(i.disbursement_date);
    const funded = i.funded ?? this.d.events.ofType("loan.funded").some((e) => (c.application_id && (e.applicationId === c.application_id || p(e).application_id === c.application_id)) || (c.loan_id && e.loanId === c.loan_id));
    if (!funded) throw new CommitmentRefused("not_funded", "29.1 guards: `closed` requires `loan.funded` (disbursement — PE–WL glossary: funds have been disbursed to the borrower(s))", `no loan.funded for commitment ${c.commitment_id}`);
    if (c.status !== "committed") throw new CommitmentRefused("not_committed", "29.1 state machine: closed follows committed", `commitment ${c.commitment_id} is ${c.status}`);
    const due = closedStatusDue(i.disbursement_date, this.cal); const fp = i.first_payment_date ?? c.first_payment_date ?? null;
    const next = this.update(c.commitment_id, { status: "closed", fnma_loan_status: "closed", closed_status_set_at: at, disbursement_date: i.disbursement_date, ...(fp ? { first_payment_date: fp } : {}), ...(i.loan_id ? { loan_id: i.loan_id } : {}), execution_channel: i.channel ?? c.execution_channel, expected_purchase_ready_date: expectedPurchaseReadyDate(i.disbursement_date, this.policy.expected_purchase_ready_bd, this.cal) }, at);
    this.emit(next, "commitment.closed_status.set", { commitment_id_fnma: next.commitment_id_fnma, disbursement_date: i.disbursement_date, closed_status_set_at: at, due_at: due.due_at, late: Date.parse(at) > Date.parse(due.due_at), original_expires_on: next.original_expires_on, expires_on: next.expires_on, first_payment_date: fp, loan_age_due_on: fp ? loanAgeDueOn(fp) : null, mandatory_obligation: true, loan_delivery_visible_by: toIso(Date.parse(at) + 20 * 60_000), autoext_cap_on: autoExtensionCap(next.original_expires_on!, this.policy, this.cal).cap_on }, at);
    return next;
  }

  // ---- Rules 10, 12: extensions --------------------------------------------------------------
  requestExtension(i: { commitment_id: string; days: number; at?: string; payer?: FeePayer; cause?: string; channel?: ExecutionChannel }): CommitmentExtension {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now();
    if (!Number.isInteger(i.days) || i.days <= 0) throw new RangeError("days must be a positive integer");
    if (!this.isOpen(c) || c.status === "requested" || c.status === "priced" || c.status === "queued") throw new CommitmentRefused("not_extendable", "C2-1.1-04 / C2-1.2-02: extensions are requested on or before the expiration date in effect", `commitment ${c.commitment_id} is ${c.status}`);
    if (c.expires_on && plainDate(etDate(at)) > c.expires_on) throw new CommitmentRefused("after_expiration", "C2-1.1-04: each request must be made before the contract expiration date in effect following the previous extension", `${etDate(at)} is after ${c.expires_on}`);
    const cumulative = this.extensions.filter((e) => e.commitment_id === c.commitment_id && e.kind === "manual").reduce((s, e) => s + e.days, 0);
    let fee: { per_diem_cents: string; fee_cents: Cents };
    if (c.type === "best_efforts") {
      const cap = extensionCapCheck(cumulative, i.days, this.policy.be_manual_extension_cap_days);
      if (c.status !== "closed" && !cap.allowed) throw new CommitmentRefused("FNMA_C2_1_2_02_BE_EXTENSION_CAP_30", "C2-1.2-02: lenders may extend commitments … for up to a maximum of 30 days for a fee", `cumulative manual extensions would reach ${cap.cumulative_after} days (> 30)`);
      const maxPtr = this.maxPtrOverLife(c); fee = bestEffortsExtensionFee(c.max_amount_cents, maxPtr, i.days);
    } else {
      const cap = extensionCapCheck(cumulative, i.days, this.policy.mand_extension_cap_days);
      if (!cap.allowed) throw new CommitmentRefused("FNMA_C2_1_1_04_MAND_EXTENSION_CAP_30", "C2-1.1-04: multiple extensions as long as the total extension period is no longer than 30 days", `cumulative extensions would reach ${cap.cumulative_after} days (> 30)`);
      fee = mandatoryExtensionFee(c.remaining_balance_cents, c.ptr_range_low ?? c.pass_through_rate, i.days);
    }
    const newExpires = rollForward(addDays(c.expires_on!, i.days), this.cal);
    const ext: CommitmentExtension = { extension_id: randomUUID(), commitment_id: c.commitment_id, kind: "manual", days: i.days, per_diem_cents: fee.per_diem_cents, fee_cents: fee.fee_cents, requested_at: at, new_expires_on: newExpires, payer: i.payer ?? "sm", confirmation_document_id: null, source: "request", escalation_id: null };
    const esc = i.channel === "sales_desk" ? null : this.operatorTask(c, "extension", { commitment_id_fnma: c.commitment_id_fnma, days: i.days, per_diem_cents: fee.per_diem_cents, fee_cents: String(fee.fee_cents), new_expires_on: newExpires, cause: i.cause ?? null }, at);
    const row = { ...ext, escalation_id: esc }; this.extensions.push(row);
    const next = this.update(c.commitment_id, { expires_on: newExpires, manual_extension_days: cumulative + i.days, execution_channel: i.channel ?? "ui_operator" }, at);
    this.emit(next, "commitment.extended", { extension_id: row.extension_id, kind: "manual", days: i.days, per_diem_cents: fee.per_diem_cents, fee_cents: String(fee.fee_cents), new_expires_on: newExpires, expires_on: newExpires, payer: row.payer, cumulative_manual_days: cumulative + i.days }, at);
    return row;
  }
  /** PE–WL's automatic extension of a closed best-efforts loan (5 days on the night the commitment expires; 1 day/5 days for mandatory) recorded from the confirmation or the fee draft; capped at 60 days from the original expiration. */
  recordAutoExtension(i: { commitment_id: string; kind: "auto_1d" | "auto_5d"; at?: string; source?: "confirmation" | "draft"; confirmation_document_id?: string | null }): CommitmentExtension {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now(); const days = i.kind === "auto_1d" ? 1 : 5;
    const cap = c.type === "best_efforts" ? autoExtensionCap(c.original_expires_on!, this.policy, this.cal).cap_on : null;
    const newExpires = rollForward(addDays(c.expires_on!, days), this.cal);
    if (cap && newExpires > cap) throw new CommitmentRefused("FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60", "C2-1.2-02: a closed loan automatically extends five calendar days … for a maximum of 60 calendar days from the original expiration date", `${newExpires} is past the cap ${cap}`);
    const fee = c.type === "best_efforts" ? bestEffortsExtensionFee(c.max_amount_cents, this.maxPtrOverLife(c), days) : mandatoryExtensionFee(c.remaining_balance_cents, c.ptr_range_low ?? c.pass_through_rate, days);
    const ext: CommitmentExtension = { extension_id: randomUUID(), commitment_id: c.commitment_id, kind: i.kind, days, per_diem_cents: fee.per_diem_cents, fee_cents: fee.fee_cents, requested_at: at, new_expires_on: newExpires, payer: "sm", confirmation_document_id: i.confirmation_document_id ?? null, source: i.source ?? "confirmation", escalation_id: null };
    this.extensions.push(ext);
    const next = this.update(c.commitment_id, { expires_on: newExpires, auto_extension_days: c.auto_extension_days + days }, at);
    this.emit(next, "commitment.extended", { extension_id: ext.extension_id, kind: i.kind, days, per_diem_cents: fee.per_diem_cents, fee_cents: String(fee.fee_cents), new_expires_on: newExpires, expires_on: newExpires, payer: "sm", source: ext.source }, at);
    return ext;
  }
  /** `max_ptr` is the highest PTR carried during the commitment's life (modifications may raise the note rate). */
  maxPtrOverLife(c: Commitment): string { const seen = [c.pass_through_rate, ...this.modifications.filter((m) => m.commitment_id === c.commitment_id).map((m) => (m.fields.before.note_rate ? passThroughRate(String(m.fields.before.note_rate), c.servicing_fee_bps, c.lpmi_bps, c.amortization) : c.pass_through_rate))]; return seen.reduce((a, b) => (dec(b).cmp(dec(a)) > 0 ? b : a)); }

  // ---- Rule 8: fallout and expiry ------------------------------------------------------------
  moveToFallout(i: { commitment_id: string; reason: FalloutReason | CancelReason; at?: string; detail?: string | null }): Commitment {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now();
    if (!this.isOpen(c)) throw new CommitmentRefused("not_open", "29.1 state machine: fallout is terminal", `commitment ${c.commitment_id} is ${c.status}`);
    if (c.status === "closed" && i.reason !== "failure_to_deliver") throw new CommitmentRefused("closed_is_mandatory", "PE–WL FAQ: closed loans are considered a mandatory obligation — the option is a pair-off, not fallout", `closed commitment ${c.commitment_id} cannot fall out on ${i.reason}`);
    const f = classifyFallout(i.reason, plainDate(etDate(at)));
    const next = this.update(c.commitment_id, { status: f.status, fnma_loan_status: f.status === "expired" ? "expired" : "fallout", fallout_reason: f.fallout_reason, pair_off_expected: f.pair_off_expected, dpa_exposure_until: f.dpa_exposure_until }, at);
    this.emit(next, "commitment.fallout.recorded", { commitment_id_fnma: next.commitment_id_fnma, lineage_id: next.lineage_id, reason: f.fallout_reason, pair_off_expected: f.pair_off_expected, fallout_on: f.fallout_on, dpa_exposure_until: f.dpa_exposure_until, detail: i.detail ?? null, borrower_last_name: next.borrower_last_name, property_address: next.property_address }, at);
    if (f.pair_off_expected) this.escalate("officer", next, { task: "pair_off_decision", reason: f.fallout_reason }, "sev2");
    return next;
  }
  /** `FNMA_C2_1_2_02_BE_COMMITMENT_EXPIRY` breach without closing → expired (fallout; DPA window); closed → PE–WL auto-extends. */
  expire(i: { commitment_id: string; at?: string }): Commitment {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now();
    if (c.status === "closed") { this.recordAutoExtension({ commitment_id: c.commitment_id, kind: "auto_5d", at }); return this.get(c.commitment_id); }
    if (c.status !== "committed") throw new CommitmentRefused("not_expirable", "29.1 state machine", `commitment ${c.commitment_id} is ${c.status}`);
    const until = addDays(c.expires_on!, 30);
    const next = this.update(c.commitment_id, { status: "expired", fnma_loan_status: "expired", fallout_reason: "auto_expired", pair_off_expected: false, dpa_exposure_until: until }, at);
    this.emit(next, "commitment.expired", { commitment_id_fnma: next.commitment_id_fnma, expires_on: c.expires_on, fallout_on: c.expires_on, dpa_exposure_until: until, pair_off_expected: false, borrower_last_name: next.borrower_last_name, property_address: next.property_address }, at);
    return next;
  }

  // ---- Rule 11 / 12: pair-offs and over-deliveries -----------------------------------------------
  preparePairOffPackage(i: { commitment_id: string; market_price?: string; at?: string; amount_cents?: Cents; certain_non_delivery?: boolean; cure_probability?: string; reason?: string; payer?: FeePayer; officer_authorized?: boolean; channel?: "ui_operator" | "sales_desk" }): CommitmentPairOff & { decision: "pair_off_now" | "carry"; package: Record<string, unknown> } {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now();
    if (c.type === "best_efforts" && c.status !== "closed") throw new CommitmentRefused("pair_off_requires_closed", "PE–WL FAQ: once you have changed the loan status to closed, you have the option to pair-off — best-efforts pair-offs are only for closed loans", `commitment ${c.commitment_id} is ${c.status}`);
    if (c.type === "mandatory" && !this.isOpen(c)) throw new CommitmentRefused("not_open", "29.1 state machine", `commitment ${c.commitment_id} is ${c.status}`);
    if (c.type === "mandatory" && i.officer_authorized !== true) throw new CommitmentRefused("officer_authorization_required", "29.1 open question 4: every mandatory pair-off requires an officer authorization recorded in escalations", "mandatory pair-off without officer authorization");
    const market = i.market_price ?? this.captureMarketPrice({ commitment_id: c.commitment_id, purpose: "pair_off_quote", at }).price;
    if (i.market_price !== undefined) this.priceCaptures.push({ capture_id: randomUUID(), commitment_id: c.commitment_id, purpose: "pair_off_quote", price: dec(market).toFixed(3, "HALF_UP"), ptr: c.pass_through_rate, captured_at: at, source: "ui", quote_id_fnma: null, quote_expires_at: toIso(Date.parse(at) + UI_ACCEPT_WINDOW_SECONDS * 1000), close_of_business: false, raw: { price: market } });
    const amount = i.amount_cents ?? (c.type === "best_efforts" ? c.max_amount_cents : c.remaining_balance_cents);
    const fee = c.type === "best_efforts" ? bestEffortsPairOffFee(c.max_amount_cents, c.commitment_price, market) : mandatoryPairOff(amount, c.commitment_price, market);
    const cap = c.type === "best_efforts" ? autoExtensionCap(c.original_expires_on!, this.policy, this.cal) : null;
    const carryDays = cap ? Math.max(0, daysBetween(plainDate(etDate(at)), cap.cap_on)) : 0;
    const alt = c.type === "best_efforts" ? carryAlternative(c.max_amount_cents, this.maxPtrOverLife(c), this.policy.be_closed_autoext_cap_days) : null;
    const decision = pairOffDecision({ certain_non_delivery: i.certain_non_delivery ?? true, ...(i.cure_probability !== undefined ? { cure_probability: i.cure_probability } : {}), fee_now_cents: fee.fee_cents, remaining_carry_cents: alt ? bestEffortsExtensionFee(c.max_amount_cents, this.maxPtrOverLife(c), Math.max(1, carryDays)).fee_cents : 0n });
    const needsOfficer = fee.fee_cents > this.policy.pair_off_officer_threshold_cents;
    const pkg: Record<string, unknown> = { commitment_id_fnma: c.commitment_id_fnma, type: c.type, kind: "lender_requested", amount_cents: String(amount), commitment_price: c.commitment_price, market_price: dec(market).toFixed(3, "HALF_UP"), price_delta: fee.price_delta, fee_cents: String(fee.fee_cents), cash_back_cents: String(fee.cash_back_cents), fee_display: formatCents(fee.fee_cents, { symbol: true }), cash_back_display: formatCents(fee.cash_back_cents, { symbol: true }),
      reason: i.reason ?? null, decision, alternative: alt ? { days: alt.days, per_diem: alt.per_diem_display, carry_cents: String(alt.carry_cents), carry_display: formatCents(alt.carry_cents, { symbol: true }), auto_pair_off_on: cap!.cap_on, statement: alt.statement } : null, officer_approval_required: needsOfficer, threshold_cents: String(this.policy.pair_off_officer_threshold_cents), accept_window_seconds: UI_ACCEPT_WINDOW_SECONDS, payer: i.payer ?? "sm", request_by: c.expires_on ? etInstant(c.expires_on, isSifmaEarlyClose(c.expires_on) ? EARLY_CLOSE_HHMM : STANDARD_CLOSE_HHMM) : null };
    const approval = needsOfficer ? this.escalate("officer", c, { task: "officer_pair_off_approval", sla_hours: 1, package: pkg }, "sev2") : null;
    const operator = i.channel === "sales_desk" ? null : needsOfficer ? null : this.operatorTask(c, "pair_off", pkg, at);
    const row: CommitmentPairOff = { pair_off_id: randomUUID(), commitment_id: c.commitment_id, kind: "lender_requested", amount_cents: amount, commitment_price: c.commitment_price, market_price: dec(market).toFixed(3, "HALF_UP"), fee_cents: fee.fee_cents, cash_back_cents: fee.cash_back_cents, executed_at: null, prepared_at: at, payer: i.payer ?? "sm", confirmation_document_id: null, status: "prepared", approval_escalation_id: approval, operator_escalation_id: operator, alternative: alt ? { days: alt.days, carry_cents: alt.carry_cents, statement: alt.statement } : null, source: "package" };
    this.pairOffs.push(row); this.packages.push({ kind: "pair_off", pair_off_id: row.pair_off_id, ...pkg });
    this.update(c.commitment_id, { pair_off_terms: pkg }, at);
    this.emit(c, "commitment.pair_off.prepared", { pair_off_id: row.pair_off_id, amount_cents: String(amount), fee_cents: String(fee.fee_cents), cash_back_cents: String(fee.cash_back_cents), market_price: row.market_price, officer_approval_required: needsOfficer, decision }, at);
    return { ...row, decision, package: pkg };
  }
  /** The officer approves (fee above threshold) and the `fnma_portal_operator` executes inside the 60-second window (or the Sales Desk on a recorded line); the confirmation closes the package. */
  recordPairOff(i: { pair_off_id?: string; commitment_id: string; kind?: "lender_requested" | "automatic"; executed_at?: string; confirmation_document_id?: string | null; officer_approved?: boolean; channel?: "ui_operator" | "sales_desk"; fee_cents?: Cents; cash_back_cents?: Cents; amount_cents?: Cents; source?: "package" | "draft" }): CommitmentPairOff {
    const c = this.get(i.commitment_id); const at = i.executed_at ?? this.now();
    let row = i.pair_off_id ? this.pairOffs.find((x) => x.pair_off_id === i.pair_off_id) : this.pairOffs.filter((x) => x.commitment_id === c.commitment_id && x.status !== "executed").at(-1);
    if (!row) {   // an automatic pair-off observed from the fee draft (the 60-day cap or an unfulfilled mandatory commitment)
      row = { pair_off_id: randomUUID(), commitment_id: c.commitment_id, kind: i.kind ?? "automatic", amount_cents: i.amount_cents ?? (c.type === "best_efforts" ? c.max_amount_cents : c.remaining_balance_cents), commitment_price: c.commitment_price, market_price: null, fee_cents: i.fee_cents ?? 0n, cash_back_cents: i.cash_back_cents ?? 0n, executed_at: null, prepared_at: at, payer: "sm", confirmation_document_id: null, status: "prepared", approval_escalation_id: null, operator_escalation_id: null, alternative: null, source: i.source ?? "draft" }; this.pairOffs.push(row);
    }
    if (row.kind === "lender_requested" && row.approval_escalation_id && i.officer_approved !== true) throw new CommitmentRefused("officer_approval_required", "29.1 open question 8: officer approval for pair-off fees > $2,500", `pair-off ${row.pair_off_id} needs the officer's approval`);
    if (i.channel === "sales_desk" && this.d.salesDesk) { const r = this.d.salesDesk.recordedCall({ kind: "pair_off", commitment_id: c.commitment_id, terms: { amount_cents: String(row.amount_cents) } }, at); row = { ...row, confirmation_document_id: r.confirmation_document_id }; }
    const done: CommitmentPairOff = { ...row, status: "executed", executed_at: at, confirmation_document_id: i.confirmation_document_id ?? row.confirmation_document_id, kind: i.kind ?? row.kind };
    this.pairOffs[this.pairOffs.indexOf(row)] = done;
    const remaining = c.type === "mandatory" ? c.remaining_balance_cents - done.amount_cents : 0n;
    const next = this.update(c.commitment_id, { paired_off_cents: c.paired_off_cents + done.amount_cents, remaining_balance_cents: remaining < 0n ? 0n : remaining, status: c.type === "best_efforts" || remaining <= 0n ? (done.kind === "automatic" ? "auto_paired_off" : "paired_off") : c.status, execution_channel: i.channel ?? "ui_operator" }, at);
    this.emit(next, "commitment.paired_off", { pair_off_id: done.pair_off_id, kind: done.kind, amount_cents: String(done.amount_cents), fee_cents: String(done.fee_cents), cash_back_cents: String(done.cash_back_cents), market_price: done.market_price, commitment_price: done.commitment_price, payer: done.payer, confirmation_document_id: done.confirmation_document_id, remaining_balance_cents: String(next.remaining_balance_cents), automatic: done.kind === "automatic" }, at);
    if (done.kind === "automatic") this.escalate("officer", next, { task: "auto_pair_off_recorded", fee_cents: String(done.fee_cents), inform: ["27.1 warehouse", "27.2 gain on sale"] }, "sev1");
    return done;
  }
  recordOverDelivery(i: { commitment_id: string; amount_cents: Cents; market_price: string; at?: string; officer_authorized?: boolean }): CommitmentOverDelivery {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now(); if (c.type !== "mandatory") throw new CommitmentRefused("not_mandatory", "C2-2-01: over-delivery applies to mandatory commitments", "best-efforts commitments are loan-specific");
    if (i.officer_authorized !== true) throw new CommitmentRefused("officer_authorization_required", "29.1 open question 4", "over-delivery without officer authorization");
    const cap = mandatoryTolerance(c.original_amount_cents).over_delivery_cap_cents;
    if (c.over_delivered_cents + i.amount_cents > cap) throw new CommitmentRefused("over_delivery_cap", "C2-2-01: the maximum overdelivery amount is 25% of the original commitment amount", `${formatCents(c.over_delivered_cents + i.amount_cents, { symbol: true })} exceeds ${formatCents(cap, { symbol: true })}`);
    const fee = mandatoryPairOff(i.amount_cents, c.commitment_price, i.market_price);
    const od: CommitmentOverDelivery = { over_delivery_id: randomUUID(), commitment_id: c.commitment_id, amount_cents: i.amount_cents, commitment_price: c.commitment_price, market_price: dec(i.market_price).toFixed(3, "HALF_UP"), fee_cents: fee.fee_cents, cash_back_cents: fee.cash_back_cents, executed_at: at }; this.overDeliveries.push(od);
    const next = this.update(c.commitment_id, { over_delivered_cents: c.over_delivered_cents + i.amount_cents, amount_cents: c.amount_cents + i.amount_cents, remaining_balance_cents: c.remaining_balance_cents + i.amount_cents, tolerance_high_cents: c.amount_cents + i.amount_cents + 5_000n }, at);
    this.emit(next, "commitment.over_delivered", { over_delivery_id: od.over_delivery_id, amount_cents: String(od.amount_cents), fee_cents: String(od.fee_cents), cash_back_cents: String(od.cash_back_cents), market_price: od.market_price, new_tolerance_high_cents: String(next.tolerance_high_cents) }, at);
    return od;
  }

  // ---- Rule 12 / open question 4: mandatory (flag-gated) --------------------------------------
  prepareMandatoryPackage(i: { amount_cents: Cents; product_code: string; min_ptr: string; period_days: number; remittance_type?: RemittanceType; at?: string; flags?: Record<string, unknown>; officer_authorization?: { escalation_id: string; status: string } | null; hedge_request_id?: string | null; hbl_cap_pct?: string | null }): Commitment & { package: Record<string, unknown>; operator_escalation_id: string | null } {
    const at = i.at ?? this.now(); const fl = this.flags(i.flags ?? {});
    if (!fl.mandatory_enabled) throw new CommitmentRefused("mandatory_disabled", "29.1 rule 1 / baseline §9: execution.mandatory_enabled=false — best efforts only", "mandatory execution is not enabled for the partner");
    positive(i.amount_cents, "amount_cents"); nonEmpty(i.product_code, "product_code"); nonEmpty(i.min_ptr, "min_ptr");
    if (!Number.isInteger(i.period_days) || i.period_days < 1 || i.period_days > 90) throw new CommitmentRefused("period_out_of_range", "C2-1.1-03: commitments … can be taken for 1 to 90 days", `${i.period_days} days`);
    if (i.amount_cents % 100n !== 0n) throw new CommitmentRefused("not_whole_dollars", "C2-1.1-03: commitments are issued in multiples of $1", `${i.amount_cents} cents`);
    if (!i.officer_authorization || i.officer_authorization.status !== "approved") throw new CommitmentRefused("officer_mandatory_authorization_required", "29.1 guards: mandatory executed requires execution.mandatory_enabled=true and an officer_mandatory_authorization escalation resolved approved", "no approved officer_mandatory_authorization");
    const ptrs = mandatoryPtrRange(i.min_ptr); const tol = mandatoryTolerance(i.amount_cents);
    const expires = rollExpirationToBusinessDay(addDays(plainDate(etDate(at)), i.period_days), this.cal);
    const limit = dailyLimitCheck(this.executedTodayCents(at), i.amount_cents, this.policy.daily_limit_cents);
    if (!limit.allowed) throw new CommitmentRefused("FNMA_C2_1_1_03_DAILY_LIMIT_200M_GATE", "C2-1.1-03: $200 million aggregate commitment volume per day", `${formatCents(limit.after_cents, { symbol: true })} would exceed the daily limit`);
    const c: Commitment = { ...this.newRow({ application_id: "", lock_id: "", lineage_id: "", lock_status: "n/a", mlo_approved: true, loan_amount_cents: i.amount_cents, note_rate: dec(i.min_ptr).add(Decimal.parse("0.25")).toFixed(4, "HALF_UP"), base_price: "0", product_code: i.product_code, lock_expires_on: expires.expires_on, rate_set_date: plainDate(etDate(at)), property_address: null, borrower_last_name: null, address_complete: true, du_casefile_id: null, underwriting_method: "other", remittance_type: i.remittance_type ?? this.policy.remittance_type },
      at, { expires_on: expires.expires_on, raw_expires_on: expires.expires_on, commitment_period_days: i.period_days, capped_at_90: false, capped_at_loan_age: false, lock_outruns_commitment: false }),
      type: "mandatory", execution_channel: "ui_operator", application_id: null, lock_id: null, lineage_id: null, status: "authorized", ptr_range_low: ptrs.ptr_range_low, ptr_range_high: ptrs.ptr_range_high, pass_through_rate: ptrs.ptr_range_low, tolerance_low_cents: tol.tolerance_low_cents, tolerance_high_cents: tol.tolerance_high_cents, hbl_cap_pct: i.hbl_cap_pct ?? null, effective_on: plainDate(etDate(at)), commitment_period_days: daysBetween(plainDate(etDate(at)), expires.expires_on) };
    this.rows.push(c);
    const pkg: Record<string, unknown> = { execution_type: "mandatory", product_name: c.fnma_product_name, remittance_type: c.remittance_type, amount_cents: String(i.amount_cents), amount_display: formatCents(i.amount_cents, { symbol: true }), period_days: i.period_days, expires_on: expires.expires_on, rolled_from: addDays(plainDate(etDate(at)), i.period_days), ptrs: ptrs.ptrs, ptr_range: `${ptrs.ptr_range_low}–${ptrs.ptr_range_high}`, servicing_fee_bps: c.servicing_fee_bps,
      tolerance_low_cents: String(tol.tolerance_low_cents), tolerance_high_cents: String(tol.tolerance_high_cents), tolerance_cents: String(tol.tolerance_cents), over_delivery_cap_cents: String(tol.over_delivery_cap_cents), hbl_cap_pct: i.hbl_cap_pct ?? null, officer_authorization_escalation_id: i.officer_authorization.escalation_id, hedge_request_id: i.hedge_request_id ?? null, accept_window_seconds: UI_ACCEPT_WINDOW_SECONDS, channel: "PE–WL UI (or Sales Desk recorded line)", request_by: etInstant(expires.expires_on, isSifmaEarlyClose(expires.expires_on) ? EARLY_CLOSE_HHMM : STANDARD_CLOSE_HHMM) };
    const esc = this.operatorTask(c, "mandatory_commit", pkg, at); this.packages.push({ kind: "mandatory", commitment_id: c.commitment_id, ...pkg });
    this.emit(c, "commitment.mandatory.package.prepared", { amount_cents: String(i.amount_cents), expires_on: expires.expires_on, ptrs: ptrs.ptrs, tolerance_low_cents: String(tol.tolerance_low_cents), tolerance_high_cents: String(tol.tolerance_high_cents), over_delivery_cap_cents: String(tol.over_delivery_cap_cents), operator_escalation_id: esc }, at);
    return { ...this.get(c.commitment_id), package: pkg, operator_escalation_id: esc };
  }
  /** The operator's (or Sales Desk's) confirmation of the mandatory commitment. */
  recordMandatoryExecution(i: { commitment_id: string; commitment_id_fnma: string; price: string; executed_at?: string; confirmation_document_id?: string | null; channel?: "ui_operator" | "sales_desk"; expires_on?: PlainDate | null }): Commitment {
    const c = this.get(i.commitment_id); const at = i.executed_at ?? this.now(); if (c.type !== "mandatory" || c.status !== "authorized") throw new CommitmentRefused("not_authorized", "29.1 state machine: mandatory authorized → executed", `commitment ${c.commitment_id} is ${c.status}`);
    nonEmpty(i.commitment_id_fnma, "commitment_id_fnma"); nonEmpty(i.price, "price");
    const expires = i.expires_on ?? c.expires_on!;
    const next = this.update(c.commitment_id, { status: "open", commitment_id_fnma: i.commitment_id_fnma, commitment_price: dec(i.price).toFixed(3, "HALF_UP"), executed_at: at, effective_on: plainDate(etDate(at)), expires_on: expires, original_expires_on: expires, commitment_period_days: daysBetween(plainDate(etDate(at)), expires), execution_channel: i.channel ?? "ui_operator", confirmation_document_id: i.confirmation_document_id ?? null }, at);
    this.emit(next, "commitment.executed", { commitment_id_fnma: next.commitment_id_fnma, type: "mandatory", price: next.commitment_price, ptr: next.ptr_range_low, ptr_range_high: next.ptr_range_high, expires_on: expires, original_expires_on: expires, commitment_period_days: next.commitment_period_days, underwriting_method: "other", amount_cents: String(next.amount_cents), original_amount_cents: String(next.original_amount_cents), tolerance_low_cents: String(next.tolerance_low_cents), tolerance_high_cents: String(next.tolerance_high_cents), execution_channel: next.execution_channel, lineage_id: null, lock_id: null, du_casefile_id: null, quote_id_fnma: null, execution_variance_cents: "0", remittance_type: next.remittance_type, confirmation_document_id: next.confirmation_document_id }, at);
    return next;
  }
  /** `loan.purchased` (29.4/30.1): best efforts → purchased + `commitment.fulfilled`; mandatory → accumulate and fulfil inside the tolerance band. */
  recordPurchase(i: { commitment_id: string; purchased_cents: Cents; at?: string; loan_id?: string | null; purchase_date?: PlainDate | null }): Commitment {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now(); positive(i.purchased_cents, "purchased_cents");
    if (c.type === "best_efforts") {
      const next = this.update(c.commitment_id, { status: "purchased", fnma_loan_status: "purchased", purchased_cents: i.purchased_cents, remaining_balance_cents: 0n, ...(i.loan_id ? { loan_id: i.loan_id } : {}) }, at);
      this.emit(next, "commitment.fulfilled", { commitment_id_fnma: next.commitment_id_fnma, purchased_cents: String(i.purchased_cents), purchase_date: i.purchase_date ?? etDate(at), days_before_expiry: next.expires_on ? daysBetween(plainDate(i.purchase_date ?? etDate(at)), next.expires_on) : null }, at);
      return next;
    }
    const purchased = c.purchased_cents + i.purchased_cents; const remaining = c.remaining_balance_cents - i.purchased_cents;
    const inBand = purchased >= (c.tolerance_low_cents ?? 0n) && purchased <= (c.tolerance_high_cents ?? purchased);
    const next = this.update(c.commitment_id, { purchased_cents: purchased, remaining_balance_cents: remaining < 0n ? 0n : remaining, ...(inBand ? { status: "fulfilled" as CommitmentStatus } : {}) }, at);
    if (inBand) this.emit(next, "commitment.fulfilled", { commitment_id_fnma: next.commitment_id_fnma, purchased_cents: String(purchased), within_tolerance: true }, at);
    return next;
  }

  // ---- Rule 15: fee drafts ---------------------------------------------------------------------
  reconcileFeeDrafts(drafts: readonly FeeDraftNotification[], at: string = this.now()): CommittingFeeDraft[] {
    const out: CommittingFeeDraft[] = [];
    for (const n of drafts) {
      if (this.feeDrafts.some((d) => d.draft_id === n.draft_id)) { out.push(this.feeDrafts.find((d) => d.draft_id === n.draft_id)!); continue; }
      nonEmpty(n.draft_id, "draft_id"); nonEmpty(n.commitment_id_fnma, "commitment_id_fnma");
      const c = this.rows.find((x) => x.commitment_id_fnma === n.commitment_id_fnma) ?? null;
      const subj = c ?? { commitment_id: `unknown:${n.commitment_id_fnma}`, application_id: null, loan_id: null };
      this.emit(subj, "committing_fee.drafted", { draft_id: n.draft_id, fee_type: n.fee_type, amount_cents: String(n.amount_cents), commitment_id_fnma: n.commitment_id_fnma, notification_date: n.notification_date, draft_date: n.draft_date }, at);
      let candidate: { id: string; expected: Cents; payer: FeePayer; cashBack: boolean } | null = null;
      if (c) {
        const taken = new Set(this.feeDrafts.map((d) => d.reconciled_to));
        if (n.fee_type === "extension") { const e = this.extensions.filter((x) => x.commitment_id === c.commitment_id && !taken.has(x.extension_id)).sort((a, b) => Number((a.fee_cents - n.amount_cents) ** 2n - (b.fee_cents - n.amount_cents) ** 2n))[0]; if (e) candidate = { id: e.extension_id, expected: e.fee_cents, payer: e.payer, cashBack: false }; }
        else if (n.fee_type === "pair_off" || n.fee_type === "over_delivery") {
          const open = this.pairOffs.filter((x) => x.commitment_id === c.commitment_id && !taken.has(x.pair_off_id));
          let po = open.filter((x) => x.status === "executed").at(-1) ?? open.at(-1);   // the executed pair-off first; a prepared package only when nothing executed
          if (!po && n.fee_type === "pair_off" && (c.status === "closed" || c.type === "mandatory")) po = this.recordPairOff({ commitment_id: c.commitment_id, kind: "automatic", executed_at: etInstant(n.draft_date, "00:00"), fee_cents: n.amount_cents, source: "draft" });   // an automatic pair-off the platform did not observe: create the child row from the draft
          if (po) candidate = { id: po.pair_off_id, expected: po.cash_back_cents > 0n ? -po.cash_back_cents : po.fee_cents, payer: po.payer, cashBack: po.cash_back_cents > 0n };
        }
      }
      const rec = candidate ? reconcileDraft(n.amount_cents, candidate.expected, this.policy.fee_draft_tolerance_cents) : { status: "exception" as const, variance_cents: n.amount_cents };
      let ledgerSetId: string | null = null, escalationId: string | null = null;
      if (rec.status === "matched" && candidate) {
        const amt = n.amount_cents < 0n ? -n.amount_cents : n.amount_cents;
        const lines = candidate.cashBack ? [{ account: COMMITTING_CASH_BACK_RECEIVABLE, amountCents: amt, ruleRef: "29.1 rule 12: cash back on a lender-requested pair-off (C2-1.1-04)" }, { account: COMMITTING_FEE_PARTNER_DRAFT, amountCents: -amt, ruleRef: "29.1 rule 15: credited to the partner's Fannie Mae draft account" }]
          : candidate.payer === "sm" ? [{ account: COMMITTING_FEE_EXPENSE, amountCents: amt, ruleRef: `29.1 rule 15 / open question 3: ${n.fee_type} fee borne by SM (fulfillment cause)` }, { account: PARTNER_REIMBURSABLE_FROM_SM, amountCents: -amt, ruleRef: "29.1 rule 15: mirrored as partner_reimbursable_from_sm (the draft hits the partner's account)" }]
          : [{ account: COMMITTING_FEE_PARTNER_DRAFT, amountCents: amt, ruleRef: `29.1 rule 15 / open question 3: ${n.fee_type} fee borne by the partner (its own act)` }, { account: COMMITTING_FEE_PARTNER_DRAFT, amountCents: -amt, ruleRef: "29.1 rule 15: partner's Fannie Mae draft" }];
        if (this.d.ledger) { const set = this.d.ledger.post({ effectiveDate: n.draft_date, description: `committing fee draft ${n.draft_id} (${n.fee_type}) on ${n.commitment_id_fnma}`, lines }, at); this.posted.push(set); ledgerSetId = set.id; }
        this.emit(subj, "committing_fee.reconciled", { draft_id: n.draft_id, reconciled_to: candidate.id, fee_type: n.fee_type, amount_cents: String(n.amount_cents), variance_cents: String(rec.variance_cents), payer: candidate.payer, ledger_set_id: ledgerSetId, accounts: lines.map((l) => l.account.account) }, at);
      } else {
        escalationId = this.escalate("officer", subj, { task: "fee_draft_exception", draft_id: n.draft_id, fee_type: n.fee_type, amount_cents: String(n.amount_cents), expected_cents: candidate ? String(candidate.expected) : null, variance_cents: String(rec.variance_cents), inquiry_window_days: 30 }, "sev3");
        this.emit(subj, "committing_fee.exception", { draft_id: n.draft_id, fee_type: n.fee_type, amount_cents: String(n.amount_cents), expected_cents: candidate ? String(candidate.expected) : null, variance_cents: String(rec.variance_cents), escalation_id: escalationId, inquiry_by: addDays(n.notification_date, 30) }, at);
      }
      const row: CommittingFeeDraft = { ...n, fnma_loan_number: n.fnma_loan_number ?? null, raw_document_id: n.raw_document_id ?? null, reconciled_to: candidate?.id ?? null, variance_cents: rec.variance_cents, status: rec.status, ledger_set_id: ledgerSetId, escalation_id: escalationId };
      this.feeDrafts.push(row); out.push(row);
    }
    return out;
  }

  // ---- nightly PE–WL / Loan Delivery status reconciliation and the sweeps ----------------------
  reconcilePewlStatus(i: { commitment_id: string; fnma_loan_status: FnmaLoanStatus; at?: string; commitment_id_fnma?: string | null; expires_on?: PlainDate | null }): { commitment: Commitment; mismatch: boolean; escalation_id: string | null } {
    const c = this.get(i.commitment_id); const at = i.at ?? this.now();
    const expected: Record<string, FnmaLoanStatus | null> = { committed: "committed", closed: "closed", delivered: "purchase_requested", purchased: "purchased", fallout: "fallout", expired: "expired" };
    const mismatch = (expected[c.status] ?? null) !== null && expected[c.status] !== i.fnma_loan_status && !(c.status === "closed" && (i.fnma_loan_status === "purchase_requested" || i.fnma_loan_status === "purchase_ready"));
    const patch: CommitmentPatch = { fnma_loan_status: i.fnma_loan_status };
    if (i.expires_on && c.expires_on !== i.expires_on) patch.expires_on = i.expires_on;   // Fannie Mae rolled the expiration: store its date; recompute timers
    if (i.commitment_id_fnma && !c.commitment_id_fnma) { patch.commitment_id_fnma = i.commitment_id_fnma; if (c.status === "unconfirmed") patch.status = "committed"; }
    const next = this.update(c.commitment_id, patch, at);
    const esc = mismatch ? this.escalate("officer", next, { task: "pewl_status_reconciliation", platform_status: c.status, fnma_loan_status: i.fnma_loan_status }, "sev3", "ops_analyst") : null;
    this.emit(next, "commitment.status.reconciled", { fnma_loan_status: i.fnma_loan_status, platform_status: next.status, mismatch, expires_on: next.expires_on, escalation_id: esc }, at);
    return { commitment: next, mismatch, escalation_id: esc };
  }
  /** The 4:30 p.m. ET (12:30 on early-close days) expiring-commitments sweep: closed loans nearing the 60-day cap get the pair-off decision escalated ≥ 5 business days early; commitments expiring within 7 days are listed for 29.2. */
  expiringSweep(at: string = this.now()): { sweep_hhmm: string; escalated: string[]; expiring_within_7: string[]; auto_extended: string[] } {
    const today = plainDate(etDate(at)); const escalated: string[] = [], expiring: string[] = [], autoExt: string[] = [];
    for (const c of this.rows) {
      if (!this.isOpen(c) || !c.expires_on || !c.original_expires_on) continue;
      if (daysBetween(today, c.expires_on) <= 7) expiring.push(c.commitment_id);
      if (c.type === "best_efforts" && c.status === "closed") {
        const cap = autoExtensionCap(c.original_expires_on, this.policy, this.cal);
        const decided = this.pairOffs.some((x) => x.commitment_id === c.commitment_id) || this.d.events.ofType("escalation.created").some((e) => p(e).commitment_id === c.commitment_id && p(e).task === "pair_off_decision");
        if (!decided && today >= cap.decision_by) { this.escalate("officer", c, { task: "pair_off_decision", reason: "FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60", cap_on: cap.cap_on, decision_by: cap.decision_by, per_diem: bestEffortsExtensionFee(c.max_amount_cents, this.maxPtrOverLife(c), 1).per_diem_display }, "sev2"); escalated.push(c.commitment_id); }
        if (today >= c.expires_on && addDays(c.expires_on, 5) <= cap.cap_on) { this.recordAutoExtension({ commitment_id: c.commitment_id, kind: "auto_5d", at }); autoExt.push(c.commitment_id); }
      }
    }
    return { sweep_hhmm: expiringDaySweepHhmm(today), escalated, expiring_within_7: expiring, auto_extended: autoExt };
  }
  /** Timer breaches this process answers (the engine emits `timer.breached`; the runtime hands the breach here). */
  handleBreach(b: Breach, at: string = this.now()): string | null {
    const code = b.instance.code; const appId = b.instance.applicationId ?? null; const c = this.rows.find((x) => (appId && x.application_id === appId) || (b.instance.subject.kind === "commitment" && x.commitment_id === b.instance.subject.id)) ?? { commitment_id: b.instance.subject.id, application_id: appId, loan_id: b.instance.loanId ?? null };
    const base = { timer_code: code, timer_id: b.instance.id, due_date: b.instance.dueDate ?? null, breach: b.breachText };
    switch (code) {
      case "FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD": return this.escalate("officer", c, { ...base, task: "key_data_notice_late", also: "compliance-sentinel", note: "modification still made; proceeds/price mismatch risk logged" }, "sev2");
      case "FNMA_PEWL_CLOSED_STATUS_1BD": { this.escalate("human_portal_task", c, { ...base, task: "fnma_portal_commitment_task", step: "closed_status", sla_hours: 1 }, "sev2"); return this.escalate("officer", c, { ...base, task: "closed_status_late", note: "the loan cannot appear in Loan Delivery until closed (29.4 delivery clock at risk)" }, "sev2"); }
      case "FNMA_C2_1_2_02_BE_CLOSED_AUTOEXT_CAP_60": return this.escalate("officer", c, { ...base, task: "auto_pair_off_at_cap", inform: ["27.2", "27.1"] }, "sev1");
      case "FNMA_C2_1_1_03_MAND_COMMITMENT_EXPIRY": return this.escalate("officer", c, { ...base, task: "mandatory_expiry_unfulfilled", note: "PE–WL auto 1-day/5-day extension (fee) or auto pair-off (fee); 29.2 position updated" }, "sev1");
      case "SM_PORTAL_OPERATOR_COMMITMENT_TASK_4H": return this.escalate("human_portal_task", c, { ...base, task: "fnma_portal_commitment_task", step: "requeue_backup_operator", sla_hours: 1 }, "sev2");
      case "FNMA_C2_2_DELIVERY_COMMITMENT_EXPIRY": return this.escalate("officer", c, { ...base, task: "delivery_gate_closed", note: "29.4 may not submit against this commitment; extend (≤ caps) or re-commit" }, "sev2");
      case "FNMA_C2_1_2_02_BE_COMMITMENT_EXPIRY": { if ("status" in c) { this.expire({ commitment_id: c.commitment_id, at }); } return null; }
      default: return null;
    }
  }
  /** 29.2's daily position at 7:00 a.m. ET: uncommitted locks past the policy window are an officer notification (worked example 3(a)). */
  uncommittedBeyondPolicy(at: string = this.now()): string[] { const today = plainDate(etDate(at)); return this.position(at).filter((x) => x.state === "locked_uncommitted").map((x) => this.get(x.commitment_id)).filter((c) => addBusinessDays(plainDate(etDate(c.created_at)), this.policy.uncommitted_position_policy_days, this.cal) < today).map((c) => c.commitment_id); }
}
export { SFC as PRICING_SFC };
