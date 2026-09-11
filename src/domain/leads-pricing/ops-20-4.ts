/**
 * §20.4 Rate quote and pricing engine — the deterministic rules of the `pricing` agent: base price from the active
 * `rate_sheets` row, LLPAs from the versioned `llpa_tables` rows (rule set `fnma.llpa.<matrix_version>`, addendum §9 —
 * never a constant in service code), the 25 bps servicing strip, SM's third-party cost schedule, the pass-through
 * solve (price → rate), payment / MI / escrow / prepaid-interest / APR estimates, quote validity, the written-quote
 * disclaimer gate, pricing exceptions and the fee-item hand-off to 21.2. One small function per rule / T-id; money is
 * bigint cents, prices 3 dp, rates 5 dp on the 0.125 % grid, LLPA percentages 3 dp, rounding half-up at each dollar
 * conversion (spec 20.4 business rules).
 *
 * Reused, never re-implemented: levelPayment / ratePercent (src/kernel/money), prepaidInterest (30.2), computeApr
 * (25.1 Appendix J engine), deriveToleranceClass (21.2), addBusinessDays + servicer calendar (kernel). 21.4's lock desk
 * prices through the `PricingPort` it declares (src/domain/application/ops-21-4.ts) — `PricingEnginePort` below
 * implements it over this engine (`priceQuote`).
 *
 * Events (every payload carries `origination: true` so the origination timer rows arm — src/kernel/timers/engine.ts
 * isOriginationContext; `applicationId` is set when the quote belongs to an application):
 *   rate_sheet.published{rate_sheet_id, source, status=active, published_at, published_on, expires_at, execution}   [arms SM_RATE_SHEET_PUBLISH_DAILY (recurring) and FNMA_PEWL_QUOTE_ID_WINDOW (source=pe_whole_loan_api)]
 *   rate_sheet.superseded{rate_sheet_id, superseded_by} · rate_sheet.withdrawn{rate_sheet_id, reason}
 *   llpa_table.loaded{matrix_version, grids, status, verified_by} · llpa_table.verified{matrix_version, verified_by} · llpa_table.activated{matrix_version}
 *   fee_schedule.refreshed{fee_schedule_id, jurisdiction, refreshed_at, refreshed_on, version}   [arms + satisfies SM_FEE_SCHEDULE_REFRESH_30]
 *   quote.created{quote_id, purpose, quoted_at, quoted_on, valid_until, expected_purchase_ready_date, rate_sheet_id, llpa_table_id, note_rate}   [arms SM_QUOTE_VALIDITY_GATE, SM_LLPA_TABLE_VERSION_GATE]
 *   quote.presented{quote_id, mlo_review_id} · quote.expired{quote_id, valid_until} · quote.superseded{quote_id, superseded_by, reason} · quote.locked{quote_id, lock_id, sfcs}
 *   terms.presentation.requested{quote_id, requested_at, mlo_of_record_id}   [20.3's SM_MLO_PREAPP_TERMS_REVIEW_1BH trigger — the personalized quote asks for the MLO review]
 *   quote.render.requested{quote_id, template} · quote.rendered{quote_id, notice_id, disclaimer_verified=true} · quote.render.blocked{quote_id, reasons}   [REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE]
 *   pricing.exception.requested{exception_id, quote_id, kind, amount_bps, requested_at, requested_on, due_on}   [arms SM_PRICING_EXCEPTION_APPROVAL_1BD]
 *   pricing.exception.approved{exception_id} | pricing.exception.denied{exception_id, reason} · pricing.exception.decided{exception_id, outcome∈{approved, denied}}   [satisfies it]
 *   pricing.feed.fallback{attempts, source} · pricing.feed.unavailable{api_failures, export_failed}   [T11 — the human_portal_task for `fnma_portal_operator`]
 */
import { createHash } from "node:crypto";
import { Decimal, divRound } from "../../kernel/money/decimal.ts";
import { type Cents, centsToDecimal, levelPayment, ratePercent, sumCents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, plainDate } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { wallClock, zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";
import { prepaidInterest, type PrepaidInterest } from "../orig-boarding/ops-30-2.ts";
import { computeApr, type AprCalculation } from "../compliance-disclosures/ops-25-1.ts";
import { deriveToleranceClass, type FeeItemInput, type LeSection, type ProviderSource, type ToleranceClass } from "../application/ops-21-2.ts";
import type { PricingPort as LockPricingPort, PriceRequest as LockPriceRequest, PricingQuote as LockPricingQuote, RateSheet as LockRateSheet } from "../application/ops-21-4.ts";
import type { RenderedBlock } from "../../notices/render.ts";

export const PRICING_AGENT: Actor = { kind: "agent", id: "pricing" };
export const ENGINE_VERSION = "20.4-engine.v1";
export const RULE_SET_VERSION_20_4 = "sm.pricing.2026.v1";
export const LLPA_BUNDLE = "fnma.llpa";
export const ET = "America/New_York";
/** Selling Guide C3-1-01: minimum servicing fee 25 bps (fixed and ARM); v1 prices at the minimum, no buy-up/buy-down (open question 3). */
export const SERVICING_FEE_BPS = 25;
/** Rule 4: residual premium above third-party costs → lender credit capped at 12.5 bps of the loan amount; the rest is retained by SM (open question 1). */
export const RESIDUAL_CREDIT_CAP_BPS = "12.5";
export const QUOTE_MAX_VALIDITY_HOURS = 24;
export const REPUBLISH_THRESHOLD_BPS = "12.5";
export const PUBLISH_TIME_ET = "06:35";
export const FEE_SCHEDULE_REFRESH_DAYS = 30;
export const RATE_QUOTE_TEMPLATE = "NTC_SM_RATE_QUOTE";
export const DISCLAIMER_TEMPLATE = "NTC_REGZ_1026_19E2II_QUOTE_DISCLAIMER";
/** 12 CFR 1026.19(e)(2)(ii): the statement, verbatim, at the top of the first page in ≥ 12-point type. */
export const DISCLAIMER_STATEMENT = "Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.";
export const DISCLAIMER_MIN_PT = 12;
export const DISCLAIMER_MAX_Y_FRACTION = 0.05;
/** LL-2024-01 reissue: the $2,500 HomeReady very-low-income credit runs for whole loans Purchase Ready through Feb 28, 2027. */
export const HOMEREADY_VLI_CREDIT_CENTS = 250_000n;
export const HOMEREADY_VLI_CREDIT_LAST_PURCHASE_READY = "2027-02-28" as PlainDate;
/** LL-2025-04: 2026 baseline conforming limits by unit count; high-cost ceiling for 1 unit. */
export const BASELINE_LIMITS_2026: Readonly<Record<1 | 2 | 3 | 4, Cents>> = { 1: 83_275_000n, 2: 106_625_000n, 3: 128_880_000n, 4: 160_175_000n };
export const HIGH_COST_CEILING_1_UNIT_2026 = 124_912_500n;
/** Special feature codes the pricing inputs imply (staged for 29.3). */
export const SFC = { vantagescore_4: "067", homeready: "900", high_balance: "808", lcor: "007", manufactured_home: "235", duty_to_serve: "874", homeready_vli_credit: "884" } as const;

export class QuoteRefused extends Error { readonly code: string; constructor(code: string, detail: string) { super(`${code}: ${detail}`); this.name = "QuoteRefused"; this.code = code; } }
export class PricingRoleDenied extends Error { readonly code = "ROLE_DENIED"; readonly required: string; constructor(actor: Actor, required: string, what: string) { super(`${what} requires role ${required}; actor is ${actor.kind}:${actor.id}${actor.role ? ` (${actor.role})` : ""}`); this.name = "PricingRoleDenied"; this.required = required; } }
const nonEmpty = (v: unknown, what: string): string => { if (typeof v !== "string" || !v.trim()) throw new RangeError(`${what} is required`); return v; };
const isHuman = (a: Actor, role: string): boolean => a.kind === "human" && a.role === role;
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x))).digest("hex");
const HUNDRED = Decimal.fromInt(100);
const dec = (s: string): Decimal => Decimal.parse(s);
const isoDateEt = (iso: string): PlainDate => wallClock(Date.parse(iso), ET).date;
/** `round_half_up(cents × pct / 100)` — a percentage of the loan amount in cents (LLPAs, premiums, credit caps). */
export const pctOfCents = (cents: Cents, pct: string): Cents => centsToDecimal(cents).mul(dec(pct)).div(HUNDRED).toCents("HALF_UP");
/** Basis points of the loan amount in cents, half-up (12.5 bps of $560,000 = $700.00). */
export const bpsOfCents = (cents: Cents, bps: string): Cents => centsToDecimal(cents).mul(dec(bps)).div(Decimal.fromInt(10_000)).toCents("HALF_UP");
/** "6.125" (percent, 3 dp on the grid) → "0.06125" (rate, 5 dp) and back. */
export const rateFromPct = (pct: string): string => dec(pct).div(HUNDRED).toFixed(5, "HALF_UP");
export const pctFromRate = (rate: string): string => dec(rate).mul(HUNDRED).toFixed(3, "HALF_UP");
const onEighthGrid = (pct: string): boolean => dec(pct).mul(Decimal.fromInt(1000)).toScaledInt(0, "HALF_UP") % 125n === 0n;

// ============================================================ rate sheets (rule 1)
export type RateSheetSource = "pe_whole_loan_api" | "browse_prices_export" | "partner_rate_sheet" | "manual_ui_read";
export const RATE_SHEET_SOURCES: readonly RateSheetSource[] = ["pe_whole_loan_api", "browse_prices_export", "partner_rate_sheet", "manual_ui_read"];
export type Amortization = "fixed" | "arm_5_6" | "arm_7_6" | "arm_10_6";
export interface RateSheetPrice { readonly product_code: string; readonly term_months: number; readonly amortization: Amortization; readonly note_rate: string; readonly pass_through_rate: string; readonly lock_period_days: number; readonly price: string; readonly pe_wl_quote_id: string | null; readonly pe_wl_quote_expires_at: string | null; }
export interface RateSheet {
  readonly rate_sheet_id: string; readonly partner_id: string; readonly source: RateSheetSource; readonly published_at: string; readonly effective_from: string; readonly expires_at: string;
  readonly execution: "best_efforts" | "mandatory_indicative"; readonly servicing_fee_bps: number; readonly prices: readonly RateSheetPrice[]; readonly status: "active" | "superseded" | "withdrawn";
  readonly published_by: string; readonly raw_response_document_id: string | null; readonly stale: boolean; readonly dual_entry_verified_by: readonly string[];
}
export interface RateSheetPriceInput { readonly product_code: string; readonly term_months: number; readonly amortization?: Amortization; readonly note_rate_pct: string; readonly lock_period_days: number; readonly price: string; readonly pe_wl_quote_id?: string | null; readonly pe_wl_quote_expires_at?: string | null; }
export interface PublishRateSheetInput {
  readonly rate_sheet_id: string; readonly partner_id: string; readonly source: RateSheetSource; readonly published_at: string; readonly expires_at: string; readonly prices: readonly RateSheetPriceInput[];
  readonly execution?: "best_efforts" | "mandatory_indicative"; readonly published_by: string; readonly raw_response_document_id?: string | null; readonly stale?: boolean;
  /** `manual_ui_read` only: the second operator's independent entry — must match the first line for line (T11 "dual entry"). */
  readonly dual_entry?: { readonly operator_id: string; readonly prices: readonly RateSheetPriceInput[] } | null;
  readonly previous_active?: RateSheet | null;
}
/** Rule 1: pass-through = note rate − 25 bps servicing fee (C2-1.1-02 "the difference between the gross note rate and the servicing fee"). */
export const passThroughRate = (noteRate: string, servicingFeeBps: number = SERVICING_FEE_BPS): string => dec(noteRate).sub(Decimal.fromInt(servicingFeeBps).div(Decimal.fromInt(10_000))).toFixed(5, "HALF_UP");
export function normalizePrice(p: RateSheetPriceInput, servicingFeeBps: number): RateSheetPrice {
  if (!/^\d+\.\d{3}$/.test(p.note_rate_pct)) throw new RangeError(`note_rate_pct ${p.note_rate_pct} must have three decimals (6.125)`);
  if (!onEighthGrid(p.note_rate_pct)) throw new RangeError(`note rate ${p.note_rate_pct}% is not on the 0.125% grid (C2-1.1-02)`);
  if (!/^\d+\.\d{3}$/.test(p.price)) throw new RangeError(`price ${p.price} must be 3 dp (% of par)`);
  if (!(p.lock_period_days > 0)) throw new RangeError("lock_period_days must be positive");
  const note_rate = rateFromPct(p.note_rate_pct);
  return { product_code: p.product_code, term_months: p.term_months, amortization: p.amortization ?? "fixed", note_rate, pass_through_rate: passThroughRate(note_rate, servicingFeeBps), lock_period_days: p.lock_period_days, price: p.price, pe_wl_quote_id: p.pe_wl_quote_id ?? null, pe_wl_quote_expires_at: p.pe_wl_quote_expires_at ?? null };
}
/** T11: a `manual_ui_read` sheet needs two operators' independent entries that agree line for line. */
export function dualEntryCheck(first: readonly RateSheetPriceInput[], second: { readonly operator_id: string; readonly prices: readonly RateSheetPriceInput[] } | null | undefined, publishedBy: string): string[] {
  if (!second) throw new RangeError("a manual_ui_read sheet needs dual entry (a second operator's independent entry)");
  if (second.operator_id === publishedBy) throw new RangeError("dual entry must come from a second operator");
  const key = (p: RateSheetPriceInput) => `${p.product_code}|${p.term_months}|${p.amortization ?? "fixed"}|${p.lock_period_days}|${p.note_rate_pct}|${p.price}`;
  const a = [...first].map(key).sort(), b = [...second.prices].map(key).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) throw new RangeError("dual entry mismatch: the two operators' entries differ — reconcile against the PE–WL UI before publishing");
  return [publishedBy, second.operator_id];
}
/**
 * Publishes a rate sheet (daily 06:35 ET, intra-day on a ≥ 12.5 bps move, or a fallback source): validates every
 * price on the grid, derives the pass-through rates, supersedes the prior active sheet and appends
 * `rate_sheet.published` (the recurring SM_RATE_SHEET_PUBLISH_DAILY row re-arms from it).
 */
export function publishRateSheet(events: EventStore, i: PublishRateSheetInput, actor: Actor = PRICING_AGENT): { sheet: RateSheet; event: DomainEvent; superseded: DomainEvent | null } {
  nonEmpty(i.rate_sheet_id, "rate_sheet_id"); nonEmpty(i.partner_id, "partner_id"); nonEmpty(i.published_by, "published_by");
  if (!RATE_SHEET_SOURCES.includes(i.source)) throw new RangeError(`source ${String(i.source)} is not one of ${RATE_SHEET_SOURCES.join("/")}`);
  if (!i.prices.length) throw new RangeError("a rate sheet needs at least one price");
  if (Date.parse(i.expires_at) <= Date.parse(i.published_at)) throw new RangeError("expires_at must be after published_at");
  const dual = i.source === "manual_ui_read" ? dualEntryCheck(i.prices, i.dual_entry, i.published_by) : [];
  const sheet: RateSheet = { rate_sheet_id: i.rate_sheet_id, partner_id: i.partner_id, source: i.source, published_at: i.published_at, effective_from: i.published_at, expires_at: i.expires_at, execution: i.execution ?? "best_efforts", servicing_fee_bps: SERVICING_FEE_BPS,
    prices: i.prices.map((p) => normalizePrice(p, SERVICING_FEE_BPS)), status: "active", published_by: i.published_by, raw_response_document_id: i.raw_response_document_id ?? null, stale: i.stale ?? false, dual_entry_verified_by: dual };
  let superseded: DomainEvent | null = null;
  if (i.previous_active && i.previous_active.status === "active") superseded = events.append({ type: "rate_sheet.superseded", actor, occurredAt: i.published_at, aggregate: { kind: "rate_sheet", id: i.previous_active.rate_sheet_id }, payload: { rate_sheet_id: i.previous_active.rate_sheet_id, superseded_by: sheet.rate_sheet_id, origination: true } });
  const event = events.append({ type: "rate_sheet.published", actor, occurredAt: i.published_at, aggregate: { kind: "rate_sheet", id: sheet.rate_sheet_id },
    payload: { rate_sheet_id: sheet.rate_sheet_id, partner_id: sheet.partner_id, source: sheet.source, status: "active", execution: sheet.execution, published_at: sheet.published_at, published_on: isoDateEt(sheet.published_at), expires_at: sheet.expires_at, price_count: sheet.prices.length, stale: sheet.stale, dual_entry_verified_by: dual, pe_wl_quote_expires_at: sheet.prices.find((p) => p.pe_wl_quote_expires_at)?.pe_wl_quote_expires_at ?? null, origination: true } });
  return { sheet, event, superseded };
}
/** Edge case "API vs UI discrepancy": the sheet is withdrawn (sev 2; operator reconciliation) and no quote prices from it. */
export function withdrawRateSheet(events: EventStore, sheet: RateSheet, reason: string, at: string, actor: Actor = PRICING_AGENT): { sheet: RateSheet; event: DomainEvent } {
  const next: RateSheet = { ...sheet, status: "withdrawn" };
  return { sheet: next, event: events.append({ type: "rate_sheet.withdrawn", actor, occurredAt: at, aggregate: { kind: "rate_sheet", id: sheet.rate_sheet_id }, payload: { rate_sheet_id: sheet.rate_sheet_id, reason, origination: true } }) };
}
/** The active sheet in force at `at` (published ≤ at < expires_at, status active); Friday's sheet carries the weekend with `stale=true`. */
export function activeSheetAt(sheets: readonly RateSheet[], at: string): RateSheet | null {
  const t = Date.parse(at);
  return [...sheets].filter((s) => s.status === "active" && Date.parse(s.published_at) <= t && t < Date.parse(s.expires_at)).sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at)).at(-1) ?? null;
}
/** Intra-day republish trigger: any product's price moved ≥ 12.5 bps (0.125 points of par) against the active sheet. */
export function republishNeeded(active: RateSheet, fresh: readonly RateSheetPriceInput[], thresholdBps: string = REPUBLISH_THRESHOLD_BPS): boolean {
  const key = (p: { product_code: string; term_months: number; lock_period_days: number }, rate: string) => `${p.product_code}|${p.term_months}|${p.lock_period_days}|${rate}`;
  const cur = new Map(active.prices.map((p) => [key(p, p.note_rate), dec(p.price)]));
  const threshold = dec(thresholdBps).div(HUNDRED);
  return fresh.some((p) => { const c = cur.get(key(p, rateFromPct(p.note_rate_pct))); return c !== undefined && dec(p.price).sub(c).abs().cmp(threshold) >= 0; });
}

// ---- price feed with fallbacks (T11; integrations table)
export interface PriceFeedPort { readonly loanPricingApi: () => readonly RateSheetPriceInput[]; readonly browsePricesExport: () => readonly RateSheetPriceInput[]; }
export interface PriceFeedResult { readonly source: RateSheetSource | null; readonly prices: readonly RateSheetPriceInput[]; readonly api_failures: number; readonly export_failed: boolean; readonly fallback: "browse_prices_export" | "manual_ui_read" | null; readonly errors: readonly string[]; }
/** Loan Pricing API ×3 (5xx/timeouts) → Browse Prices export → `manual_ui_read` by the `fnma_portal_operator` (no quotes until that sheet, dual-entered, is published). */
export function fetchPrices(port: PriceFeedPort, attempts = 3): PriceFeedResult {
  const errors: string[] = [];
  for (let n = 0; n < attempts; n++) { try { return { source: "pe_whole_loan_api", prices: port.loanPricingApi(), api_failures: n, export_failed: false, fallback: null, errors }; } catch (e) { errors.push(`api attempt ${n + 1}: ${(e as Error).message}`); } }
  try { return { source: "browse_prices_export", prices: port.browsePricesExport(), api_failures: attempts, export_failed: false, fallback: "browse_prices_export", errors }; } catch (e) { errors.push(`browse prices export: ${(e as Error).message}`); }
  return { source: null, prices: [], api_failures: attempts, export_failed: true, fallback: "manual_ui_read", errors };
}
export function recordFeedOutcome(events: EventStore, r: PriceFeedResult, at: string, actor: Actor = PRICING_AGENT): DomainEvent | null {
  if (r.source === "pe_whole_loan_api") return null;
  if (r.source === "browse_prices_export") return events.append({ type: "pricing.feed.fallback", actor, occurredAt: at, payload: { attempts: r.api_failures, source: r.source, errors: r.errors, origination: true } });
  return events.append({ type: "pricing.feed.unavailable", actor, occurredAt: at, payload: { api_failures: r.api_failures, export_failed: r.export_failed, required_source: "manual_ui_read", owner_role: "fnma_portal_operator", errors: r.errors, origination: true } });
}

// ============================================================ LLPA tables (rule 2, rule 10; matrix 09.09.2026)
export type LlpaGrid = "purchase_fico" | "purchase_vs4" | "lcor_fico" | "lcor_vs4" | "cashout_fico" | "cashout_vs4" | "attr_purchase" | "attr_lcor" | "attr_cashout" | "min_mi_fico" | "min_mi_vs4" | "waivers" | "credits";
export const LLPA_GRIDS: readonly LlpaGrid[] = ["purchase_fico", "purchase_vs4", "lcor_fico", "lcor_vs4", "cashout_fico", "cashout_vs4", "attr_purchase", "attr_lcor", "attr_cashout", "min_mi_fico", "min_mi_vs4", "waivers", "credits"];
export type ScoreModel = "classic_fico" | "vantagescore_4";
export const LTV_BANDS = ["≤30.00%", "30.01–60.00%", "60.01–70.00%", "70.01–75.00%", "75.01–80.00%", "80.01–85.00%", "85.01–90.00%", "90.01–95.00%", ">95.00%"] as const;
const LTV_UPPER_X100 = [3000, 6000, 7000, 7500, 8000, 8500, 9000, 9500, Infinity] as const;
export const MIN_MI_LTV_BANDS = ["80.01–85.00%", "85.01–90.00%", "90.01–95.00%", "95.01–97.00%"] as const;
export const FICO_BANDS = ["≥780", "760–779", "740–759", "720–739", "700–719", "680–699", "660–679", "640–659", "≤639"] as const;
const FICO_LOWER = [780, 760, 740, 720, 700, 680, 660, 640, -Infinity] as const;
export const VS4_BANDS = ["≥800", "780–799", "760–779", "740–759", "720–739", "700–719", "680–699", "660–679", "≤659"] as const;
const VS4_LOWER = [800, 780, 760, 740, 720, 700, 680, 660, -Infinity] as const;
export const MIN_MI_FICO_BANDS = [">740", "720–739", "700–719", "680–699", "660–679", "640–659", "620–639", "<620"] as const;
const MIN_MI_FICO_LOWER = [741, 720, 700, 680, 660, 640, 620, -Infinity] as const;
export const MIN_MI_VS4_BANDS = [">760", "740–759", "720–739", "700–719", "680–699", "660–679", "640–659", "<640"] as const;
const MIN_MI_VS4_LOWER = [761, 740, 720, 700, 680, 660, 640, -Infinity] as const;
export type AttributeRow = "arm" | "condo" | "investment_property" | "second_home" | "manufactured_home" | "units_2_4" | "high_balance_fixed" | "high_balance_arm" | "subordinate_financing";
export type GridRows = Readonly<Record<string, Readonly<Record<string, string>>>>;
export interface LlpaRuleSet {
  readonly bundle: typeof LLPA_BUNDLE; readonly version: string; readonly effective_from: PlainDate; readonly effective_to: PlainDate | null; readonly source: string; readonly source_document_id: string;
  readonly grids: Readonly<Record<LlpaGrid, GridRows>>;
  /** Cells the load flagged for the two-reviewer visual check (cleared by the verification log). */
  readonly notes: Readonly<Record<string, unknown>>;
}
const row = (cols: readonly string[], vals: readonly string[]): Readonly<Record<string, string>> => { if (cols.length !== vals.length) throw new RangeError(`grid row has ${vals.length} cells for ${cols.length} columns`); return Object.fromEntries(cols.map((c, i) => [c, vals[i]!])); };
const grid = (rows: readonly string[], cols: readonly string[], cells: readonly (readonly string[])[]): GridRows => Object.fromEntries(rows.map((r, i) => [r, row(cols, cells[i]!)]));
const rep = (v: string, n: number): string[] => Array.from({ length: n }, () => v);
/** VantageScore 4.0 grids: every row equals the Classic FICO row one band lower (verified cell-by-cell 2026-09-11). */
const shifted = (fico: GridRows, vsBands: readonly string[], ficoBands: readonly string[]): GridRows => Object.fromEntries(vsBands.map((b, i) => [b, fico[ficoBands[i]!]!]));
const LCOR_FICO = grid(FICO_BANDS, LTV_BANDS, [
  ["0.000", "0.000", "0.000", "0.125", "0.500", "0.625", "0.500", "0.375", "0.375"],
  ["0.000", "0.000", "0.125", "0.375", "0.875", "1.000", "0.750", "0.625", "0.625"],
  ["0.000", "0.000", "0.250", "0.750", "1.125", "1.375", "1.125", "1.000", "1.000"],
  ["0.000", "0.000", "0.500", "1.000", "1.625", "1.750", "1.500", "1.250", "1.250"],
  ["0.000", "0.000", "0.625", "1.250", "1.875", "2.125", "1.750", "1.625", "1.625"],
  ["0.000", "0.000", "0.875", "1.625", "2.250", "2.500", "2.125", "1.750", "1.750"],
  ["0.000", "0.125", "1.125", "1.875", "2.500", "3.000", "2.375", "2.125", "2.125"],
  ["0.000", "0.250", "1.375", "2.125", "2.875", "3.375", "2.875", "2.500", "2.500"],
  ["0.000", "0.375", "1.750", "2.500", "3.500", "3.875", "3.625", "2.500", "2.500"]]);
const PURCHASE_FICO = grid(FICO_BANDS, LTV_BANDS, [
  ["0.000", "0.000", "0.000", "0.000", "0.375", "0.375", "0.250", "0.250", "0.125"],
  ["0.000", "0.000", "0.000", "0.250", "0.625", "0.625", "0.500", "0.500", "0.250"],
  ["0.000", "0.000", "0.125", "0.375", "0.875", "1.000", "0.750", "0.625", "0.500"],
  ["0.000", "0.000", "0.250", "0.750", "1.250", "1.250", "1.000", "0.875", "0.750"],
  ["0.000", "0.000", "0.375", "0.875", "1.375", "1.500", "1.250", "1.125", "0.875"],
  ["0.000", "0.000", "0.625", "1.125", "1.750", "1.875", "1.500", "1.375", "1.125"],
  ["0.000", "0.000", "0.750", "1.375", "1.875", "2.125", "1.750", "1.625", "1.250"],
  ["0.000", "0.000", "1.125", "1.500", "2.250", "2.500", "2.000", "1.875", "1.500"],
  ["0.000", "0.125", "1.500", "2.125", "2.750", "2.875", "2.625", "2.250", "1.750"]]);
const CASHOUT_COLS = LTV_BANDS.slice(0, 5);
const CASHOUT_FICO = grid(FICO_BANDS, CASHOUT_COLS, [
  ["0.375", "0.375", "0.625", "0.875", "1.375"], ["0.375", "0.375", "0.875", "1.250", "1.875"], ["0.375", "0.375", "1.000", "1.625", "2.375"],
  ["0.375", "0.500", "1.375", "2.000", "2.750"], ["0.375", "0.500", "1.625", "2.625", "3.250"], ["0.375", "0.625", "2.000", "2.875", "3.750"],
  ["0.375", "0.875", "2.750", "4.000", "4.750"], ["0.375", "1.375", "3.125", "4.625", "5.125"], ["0.375", "1.375", "3.375", "4.875", "5.125"]]);
const ATTR_ROWS: readonly AttributeRow[] = ["arm", "condo", "investment_property", "second_home", "manufactured_home", "units_2_4", "high_balance_fixed", "high_balance_arm", "subordinate_financing"];
const ATTR_9 = grid(ATTR_ROWS, LTV_BANDS, [
  [...rep("0.000", 7), "0.250", "0.250"],
  ["0.000", "0.000", "0.125", "0.125", ...rep("0.750", 5)],
  ["1.125", "1.125", "1.625", "2.125", "3.375", ...rep("4.125", 4)],
  ["1.125", "1.125", "1.625", "2.125", "3.375", ...rep("4.125", 4)],   // second home — identical to investment property in the 09.09.2026 text layer (re-read 2026-09-11)
  rep("0.500", 9),
  ["0.000", "0.000", "0.375", "0.375", ...rep("0.625", 5)],
  ["0.500", "0.500", "0.750", "0.750", ...rep("1.000", 5)],
  ["1.250", "1.250", "1.500", "1.500", "2.500", "2.500", "2.500", "2.750", "2.750"],
  ["0.625", "0.625", "0.625", "0.875", "1.125", "1.125", "1.125", "1.875", "1.875"]]);
const ATTR_CASHOUT = grid(ATTR_ROWS, CASHOUT_COLS, [
  rep("0.000", 5), ["0.000", "0.000", "0.125", "0.125", "0.750"], ["1.125", "1.125", "1.625", "2.125", "3.375"], ["1.125", "1.125", "1.625", "2.125", "3.375"], rep("0.500", 5),
  ["0.000", "0.000", "0.375", "0.375", "0.625"], ["1.250", "1.250", "1.500", "1.500", "1.750"], ["2.000", "2.000", "2.250", "2.250", "3.250"], ["0.625", "0.625", "0.625", "0.875", "1.125"]]);
const MIN_MI_FICO = grid(MIN_MI_FICO_BANDS, MIN_MI_LTV_BANDS, [
  ["0.125", "0.375", "0.500", "1.000"], ["0.125", "0.625", "0.875", "1.250"], ["0.125", "0.750", "0.875", "1.250"], ["0.125", "0.750", "0.875", "1.750"],
  ["0.750", "1.250", "1.750", "2.125"], ["1.250", "1.750", "2.000", "2.375"], ["1.750", "2.000", "2.250", "2.750"], ["2.000", "2.250", "2.500", "3.000"]]);
/**
 * The LLPA Matrix, version stamp 09.09.2026 (singlefamily.fanniemae.com/media/9391; LL-2026-06 VantageScore 4.0 grids,
 * SEL-2025-09 "≤639" bottom row, no DTI / escrow-waiver / temporary-buydown rows), as the `rule_sets` row
 * `fnma.llpa.09.09.2026` — the engine reads every percentage from a loaded `llpa_tables` row derived from it.
 */
export const FNMA_LLPA_09_09_2026: LlpaRuleSet = {
  bundle: LLPA_BUNDLE, version: "09.09.2026", effective_from: "2026-09-09" as PlainDate, effective_to: null, source: "Fannie Mae LLPA Matrix 09.09.2026 (media/9391), verified 2026-09-10, re-read cell-by-cell 2026-09-11", source_document_id: "doc-llpa-matrix-09-09-2026",
  grids: {
    purchase_fico: PURCHASE_FICO, purchase_vs4: shifted(PURCHASE_FICO, VS4_BANDS, FICO_BANDS), lcor_fico: LCOR_FICO, lcor_vs4: shifted(LCOR_FICO, VS4_BANDS, FICO_BANDS), cashout_fico: CASHOUT_FICO, cashout_vs4: shifted(CASHOUT_FICO, VS4_BANDS, FICO_BANDS),
    attr_purchase: ATTR_9, attr_lcor: ATTR_9, attr_cashout: ATTR_CASHOUT, min_mi_fico: MIN_MI_FICO, min_mi_vs4: shifted(MIN_MI_FICO, MIN_MI_VS4_BANDS, MIN_MI_FICO_BANDS),
    waivers: { homeready: { sfc: SFC.homeready, keeps: "min_mi" }, fthb_ami: { ami_limit_pct: "100", ami_limit_high_cost_pct: "120", keeps: "min_mi" }, duty_to_serve: { sfc: SFC.duty_to_serve, keeps: "min_mi" } },
    credits: { homeready_vli_fthb: { cents: String(HOMEREADY_VLI_CREDIT_CENTS), ami_max_pct: "50", sfcs: `${SFC.homeready_vli_credit},${SFC.homeready}`, purchase_ready_through: HOMEREADY_VLI_CREDIT_LAST_PURCHASE_READY } },
  },
  notes: {},
};
export interface LlpaTable {
  readonly llpa_table_id: string; readonly matrix_version: string; readonly effective_from: PlainDate; readonly effective_to: PlainDate | null; readonly grid: LlpaGrid; readonly rows: GridRows;
  readonly source_document_id: string; readonly verified_by: readonly string[]; readonly notes: Readonly<Record<string, unknown>>; readonly status: "staged" | "verified" | "active" | "retired";
}
/** `loadLlpaTable`: stages one `llpa_tables` row per grid from the rule set (status `staged`; the flagged cells stay in `notes` until two reviewers verify). */
export function loadLlpaTables(events: EventStore, rs: LlpaRuleSet, opts: { at: string; notes?: Readonly<Record<string, unknown>>; status?: "staged" | "active" }, actor: Actor = PRICING_AGENT): { tables: LlpaTable[]; event: DomainEvent } {
  if (rs.bundle !== LLPA_BUNDLE) throw new RangeError(`rule set bundle ${rs.bundle} is not ${LLPA_BUNDLE}`);
  nonEmpty(rs.version, "matrix_version");
  const notes = { ...rs.notes, ...(opts.notes ?? {}) };
  const tables = LLPA_GRIDS.map((g): LlpaTable => ({ llpa_table_id: `llpa-${rs.version}-${g}`, matrix_version: rs.version, effective_from: rs.effective_from, effective_to: rs.effective_to, grid: g, rows: rs.grids[g], source_document_id: rs.source_document_id, verified_by: [], notes, status: opts.status ?? "staged" }));
  const event = events.append({ type: "llpa_table.loaded", actor, occurredAt: opts.at, aggregate: { kind: "llpa_table", id: `llpa-${rs.version}` }, payload: { matrix_version: rs.version, bundle: rs.bundle, rule_set: `${rs.bundle}.${rs.version}`, effective_from: rs.effective_from, grids: [...LLPA_GRIDS], status: opts.status ?? "staged", notes, origination: true } });
  return { tables, event };
}
/** Two distinct human reviewers verify a staged version page by page; the second verification clears the `notes` flags and moves every grid to `verified`. */
export function verifyLlpaTables(events: EventStore, tables: readonly LlpaTable[], reviewer: Actor, at: string): { tables: LlpaTable[]; event: DomainEvent | null; verified: boolean } {
  if (reviewer.kind !== "human") throw new PricingRoleDenied(reviewer, "human reviewer", "LLPA table verification");
  const version = tables[0]?.matrix_version; if (!version) throw new RangeError("no tables to verify");
  const already = tables[0]!.verified_by;
  if (already.includes(reviewer.id)) throw new RangeError(`${reviewer.id} already verified ${version}; a second, different reviewer is required`);
  const verified_by = [...already, reviewer.id];
  const verified = verified_by.length >= 2;
  const next = tables.map((t): LlpaTable => ({ ...t, verified_by, ...(verified ? { notes: {}, status: t.status === "staged" ? "verified" : t.status } : {}) }));
  const event = verified ? events.append({ type: "llpa_table.verified", actor: reviewer, occurredAt: at, aggregate: { kind: "llpa_table", id: `llpa-${version}` }, payload: { matrix_version: version, verified_by, origination: true } }) : null;
  return { tables: next, event, verified };
}
export function activateLlpaTables(events: EventStore, tables: readonly LlpaTable[], at: string, actor: Actor = PRICING_AGENT): { tables: LlpaTable[]; event: DomainEvent } {
  const version = tables[0]?.matrix_version; if (!version) throw new RangeError("no tables to activate");
  if (tables.some((t) => t.status === "staged")) throw new RangeError(`${version} is not verified by two reviewers`);
  return { tables: tables.map((t): LlpaTable => ({ ...t, status: "active" })), event: events.append({ type: "llpa_table.activated", actor, occurredAt: at, aggregate: { kind: "llpa_table", id: `llpa-${version}` }, payload: { matrix_version: version, origination: true } }) };
}
/**
 * SM_LLPA_TABLE_VERSION_GATE (rule 2; T7): the matrix version whose `effective_from ≤ expected_purchase_ready_date <
 * effective_to`; a newer version announced with a future effective date is used when the Purchase Ready date falls on or
 * after it and the quote carries `matrix_change_exposure=true`. Refused (`no_active_table`) when no version covers the date.
 */
export function selectLlpaVersion(tables: readonly LlpaTable[], expectedPurchaseReady: PlainDate): { matrix_version: string; tables: LlpaTable[]; matrix_change_exposure: boolean; current_active_version: string | null } {
  const usable = tables.filter((t) => t.status !== "retired");
  const versions = [...new Set(usable.map((t) => t.matrix_version))].map((v) => usable.find((t) => t.matrix_version === v)!).filter((t) => t.effective_from <= expectedPurchaseReady && (t.effective_to === null || expectedPurchaseReady < t.effective_to)).sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
  const chosen = versions.at(-1);
  if (!chosen) throw new QuoteRefused("no_active_table", `no LLPA table covers expected_purchase_ready_date ${expectedPurchaseReady}`);
  const current = usable.filter((t) => t.status === "active").map((t) => t.matrix_version).sort().at(-1) ?? null;
  return { matrix_version: chosen.matrix_version, tables: usable.filter((t) => t.matrix_version === chosen.matrix_version), matrix_change_exposure: current !== null && chosen.matrix_version !== current, current_active_version: current };
}
/** A grid reader scoped to one score model: reading a Classic FICO grid for a VantageScore quote (or vice versa) fails (rule 10; T3). */
export interface GridReader { readonly model: ScoreModel; readonly matrix_version: string; readonly grid: (g: LlpaGrid) => LlpaTable; readonly cell: (g: LlpaGrid, r: string, c: string) => string; }
export function tableReader(tables: readonly LlpaTable[], model: ScoreModel): GridReader {
  const version = tables[0]?.matrix_version; if (!version) throw new QuoteRefused("no_active_table", "no LLPA tables loaded");
  const suffix = model === "classic_fico" ? "_fico" : "_vs4"; const other = model === "classic_fico" ? "_vs4" : "_fico";
  const gridOf = (g: LlpaGrid): LlpaTable => {
    if (g.endsWith(other)) throw new QuoteRefused("wrong_score_model_grid", `grid ${g} is not readable for score_model=${model} (LL-2026-06: the engine must never map a ${model} score to the ${g} grid)`);
    const t = tables.find((x) => x.grid === g); if (!t) throw new QuoteRefused("no_active_table", `grid ${g} missing from matrix ${version}`);
    if (t.notes.bands_unverified === true) throw new QuoteRefused("table_unverified", `${g} (${version}) carries notes.bands_unverified=true — blocked until the verification log clears it`);
    return t;
  };
  void suffix;
  return { model, matrix_version: version, grid: gridOf, cell: (g, r, c) => { const t = gridOf(g); const v = t.rows[r]?.[c]; if (v === undefined) throw new RangeError(`no cell ${g}[${r}][${c}] in matrix ${version}`); return v; } };
}

// ---- band lookups
const bandOf = (labels: readonly string[], lowers: readonly number[], score: number): string => labels[lowers.findIndex((lo) => score >= lo)]!;
export const scoreBand = (model: ScoreModel, score: number | null): { row: string; no_score: boolean } => score === null ? { row: model === "classic_fico" ? FICO_BANDS[8] : VS4_BANDS[8], no_score: true } : { row: model === "classic_fico" ? bandOf(FICO_BANDS, FICO_LOWER, score) : bandOf(VS4_BANDS, VS4_LOWER, score), no_score: false };
export const minMiBand = (model: ScoreModel, score: number | null): string => score === null ? (model === "classic_fico" ? MIN_MI_FICO_BANDS[7] : MIN_MI_VS4_BANDS[7]) : model === "classic_fico" ? bandOf(MIN_MI_FICO_BANDS, MIN_MI_FICO_LOWER, score) : bandOf(MIN_MI_VS4_BANDS, MIN_MI_VS4_LOWER, score);
/** Gross LTV to 2 dp as hundredths of a percent (70.00 % → 7000): `loan / min(value, price)` for a purchase, `/ value` for a refinance (half-up). */
export function ltvX100(loanCents: Cents, valueCents: Cents, priceCents: Cents | null, transaction: TransactionType): number {
  if (loanCents <= 0n) throw new RangeError("loan_amount_cents must be positive");
  const denom = transaction === "purchase" && priceCents !== null && priceCents > 0n && priceCents < valueCents ? priceCents : valueCents;
  if (denom <= 0n) throw new RangeError("value_cents must be positive");
  return Number(divRound(loanCents * 10_000n, denom, "HALF_UP"));
}
export const ltvBand = (x100: number): string => LTV_BANDS[LTV_UPPER_X100.findIndex((u) => x100 <= u)]!;
export const minMiLtvBand = (x100: number): string | null => (x100 <= 8000 ? null : x100 <= 8500 ? MIN_MI_LTV_BANDS[0] : x100 <= 9000 ? MIN_MI_LTV_BANDS[1] : x100 <= 9500 ? MIN_MI_LTV_BANDS[2] : x100 <= 9700 ? MIN_MI_LTV_BANDS[3] : null);
/** High-balance = loan amount above the 2026 baseline limit for the unit count; the county table (F11) caps conforming eligibility (T10). */
export function highBalance(loanCents: Cents, units: 1 | 2 | 3 | 4, countyLimitCents: Cents | null): { high_balance: boolean; baseline_limit_cents: Cents; conforming: boolean } {
  const baseline = BASELINE_LIMITS_2026[units];
  const limit = countyLimitCents ?? baseline;
  return { high_balance: loanCents > baseline, baseline_limit_cents: baseline, conforming: loanCents <= limit };
}

// ============================================================ quote inputs
export type TransactionType = "purchase" | "limited_cash_out" | "cash_out";
export type Occupancy = "primary" | "second_home" | "investment";
export type PropertyType = "sfr" | "pud" | "condo" | "coop" | "manufactured_home";
export type MiOption = "none" | "standard" | "minimum_coverage";
export interface HomeReadyEvaluation { readonly eligible: boolean; readonly source: "ami_api" | "du_message"; readonly ami_pct: number | null; readonly evaluated_at: string; }
export interface QuoteInputs {
  readonly product_code: string; readonly term_months: number; readonly amortization: Amortization; readonly transaction_type: TransactionType; readonly occupancy: Occupancy; readonly property_type: PropertyType; readonly units: 1 | 2 | 3 | 4;
  readonly loan_amount_cents: Cents; readonly value_cents: Cents; readonly purchase_price_cents: Cents | null;
  readonly representative_score: number | null; readonly score_model: ScoreModel; readonly score_source: string; readonly borrower_score_models: readonly ScoreModel[];
  readonly state: string; readonly county: string; readonly county_limit_cents: Cents | null; readonly subordinate_financing_cents: Cents; readonly mi_option: MiOption;
  readonly homeready: boolean; readonly homeready_evaluation: HomeReadyEvaluation | null; readonly first_time_homebuyer: boolean; readonly fthb_ami_waiver: boolean; readonly dts_waiver: boolean; readonly very_low_income: boolean;
  readonly lock_period_days: number; readonly expected_purchase_ready_date: PlainDate; readonly escrowed: boolean; readonly valuation_method: "value_acceptance" | "value_acceptance_pd" | "hybrid" | "desktop" | "traditional";
  /** Rule 4: the borrower elects to pay the third-party costs in cash to obtain a lower rate (T12). */
  readonly borrower_pays_third_party_costs: boolean;
  readonly taxes_annual_cents: Cents | null; readonly insurance_annual_cents: Cents | null; readonly mi_annual_rate_pct: string | null;
  readonly assumed_disbursement_date: PlainDate | null; readonly first_payment_date: PlainDate | null;
}
export const PROHIBITED_BASIS_FIELDS: readonly string[] = ["race", "ethnicity", "color", "religion", "national_origin", "sex", "gender", "marital_status", "age", "receipt_of_public_assistance", "familial_status", "disability", "zip_code_cost_table"];
/** Rule 8: the engine's inputs exclude any prohibited basis and proxies (no ZIP-level cost tables below county). */
export function assertNoProhibitedBasis(inputs: Record<string, unknown>): void {
  const hit = Object.keys(inputs).filter((k) => PROHIBITED_BASIS_FIELDS.includes(k));
  if (hit.length) throw new QuoteRefused("prohibited_basis_input", `pricing inputs may not carry ${hit.join(", ")} (Reg B §1002.4(a); 20.4 rule 8)`);
}
export function validateInputs(i: QuoteInputs): void {
  assertNoProhibitedBasis(i as unknown as Record<string, unknown>);
  if (i.loan_amount_cents <= 0n) throw new RangeError("loan_amount_cents must be positive");
  if (i.value_cents <= 0n) throw new RangeError("value_cents must be positive");
  if (![1, 2, 3, 4].includes(i.units)) throw new RangeError("units must be 1–4");
  if (i.representative_score !== null && (i.representative_score < 300 || i.representative_score > 850)) throw new RangeError(`representative_score ${i.representative_score} out of range`);
  const models = new Set(i.borrower_score_models);
  if (models.size > 1) throw new QuoteRefused("mixed_score_models", "VantageScore 4.0 for one borrower and Classic FICO for another: rejected (LL-2026-06 — the same model for all borrowers); 22.2 re-orders under one model");
  if (models.size === 1 && !models.has(i.score_model)) throw new QuoteRefused("mixed_score_models", `score_model ${i.score_model} does not match the borrowers' report model`);
  if (i.homeready && !(i.homeready_evaluation?.eligible)) throw new QuoteRefused("waiver_without_evaluation", "never apply a HomeReady waiver without an AMI/HomeReady evaluation or a DU HomeReady message (guardrail)");
  if (!(i.lock_period_days > 0)) throw new RangeError("lock_period_days must be positive");
  plainDate(i.expected_purchase_ready_date);
}

// ============================================================ LLPA computation (rule 2)
export interface LlpaItem { readonly grid: LlpaGrid; readonly row: string; readonly col: string; readonly pct: string; readonly waived: boolean; }
export type Waiver = "homeready" | "fthb_ami" | "duty_to_serve" | null;
export interface LlpaResult {
  readonly llpa_table_id: string; readonly matrix_version: string; readonly ltv_x100: number; readonly ltv: string; readonly ltv_band: string; readonly score_row: string; readonly high_balance: boolean;
  readonly llpa_items: readonly LlpaItem[]; readonly llpa_items_waived: readonly LlpaItem[]; readonly llpa_total_pct: string; readonly waiver_applied: Waiver; readonly credits_cents: Cents; readonly llpa_cents: Cents;
  readonly sfcs: readonly string[]; readonly flags: readonly string[]; readonly matrix_change_exposure: boolean;
}
const purposeKey = (t: TransactionType): "purchase" | "lcor" | "cashout" => (t === "purchase" ? "purchase" : t === "limited_cash_out" ? "lcor" : "cashout");
const sumPct = (items: readonly { pct: string }[]): string => items.reduce((a, it) => a.add(dec(it.pct)), Decimal.ZERO).toFixed(3, "HALF_UP");
/**
 * Rule 2 in full: purpose grid by transaction type and score model; row by representative score (no score → lowest
 * row, flagged for 23.2); column by gross LTV; attribute rows; minimum-MI LLPA by base LTV when elected; waivers
 * (HomeReady SFC 900 / FTHB ≤ 100 % AMI / Duty to Serve) leave only the minimum-MI LLPA; the HomeReady very-low-income
 * FTHB credit through Feb 28, 2027; `llpa_cents = round_half_up(llpa_total_pct × loan_amount_cents)` — the forecast
 * 27.2 reconciles against the Purchase Advice.
 */
export function computeLlpa(tables: readonly LlpaTable[], i: QuoteInputs): LlpaResult {
  validateInputs(i);
  const sel = selectLlpaVersion(tables, i.expected_purchase_ready_date);
  const rd = tableReader(sel.tables, i.score_model);
  const purpose = purposeKey(i.transaction_type);
  const gridName = `${purpose}_${i.score_model === "classic_fico" ? "fico" : "vs4"}` as LlpaGrid;
  const x100 = ltvX100(i.loan_amount_cents, i.value_cents, i.purchase_price_cents, i.transaction_type);
  const col = ltvBand(x100);
  if (i.transaction_type === "cash_out" && x100 > 8000) throw new QuoteRefused("ltv_exceeds_program", `cash-out LTV ${(x100 / 100).toFixed(2)}% exceeds the 80% Eligibility Matrix maximum`);
  const flags: string[] = []; const sfcs = new Set<string>();
  const { row: scoreRow, no_score } = scoreBand(i.score_model, i.representative_score);
  if (no_score) flags.push("no_score_lowest_band", "eligibility_review_23_2");
  if (i.score_model === "vantagescore_4") sfcs.add(SFC.vantagescore_4);
  if (i.transaction_type === "limited_cash_out") sfcs.add(SFC.lcor);
  if (sel.matrix_change_exposure) flags.push("matrix_change_exposure");
  const items: LlpaItem[] = [{ grid: gridName, row: scoreRow, col, pct: rd.cell(gridName, scoreRow, col), waived: false }];
  const attrGrid = `attr_${purpose}` as LlpaGrid;
  const attr = (r: AttributeRow) => items.push({ grid: attrGrid, row: r, col, pct: rd.cell(attrGrid, r, col), waived: false });
  if (i.occupancy === "second_home") { const t = rd.grid(attrGrid); if (t.notes.second_home_unverified === true) throw new QuoteRefused("table_unverified", "second-home attribute row is flagged in the table's notes"); attr("second_home"); }
  if (i.occupancy === "investment") attr("investment_property");
  if (i.property_type === "condo") attr("condo");
  if (i.property_type === "manufactured_home") { attr("manufactured_home"); sfcs.add(SFC.manufactured_home); }
  if (i.units >= 2) attr("units_2_4");
  const hb = highBalance(i.loan_amount_cents, i.units, i.county_limit_cents);
  if (!hb.conforming) throw new QuoteRefused("not_conforming", `loan amount exceeds the county limit ${hb.baseline_limit_cents}`);
  if (hb.high_balance) { attr(i.amortization === "fixed" ? "high_balance_fixed" : "high_balance_arm"); sfcs.add(SFC.high_balance); }
  if (i.amortization !== "fixed") attr("arm");
  if (i.subordinate_financing_cents > 0n) attr("subordinate_financing");
  let minMi: LlpaItem | null = null;
  if (i.mi_option === "minimum_coverage") { const c = minMiLtvBand(x100); if (c) { const g = `min_mi_${i.score_model === "classic_fico" ? "fico" : "vs4"}` as LlpaGrid; const r = minMiBand(i.score_model, i.representative_score); minMi = { grid: g, row: r, col: c, pct: rd.cell(g, r, c), waived: false }; } }
  let waiver: Waiver = null;
  if (i.homeready && i.homeready_evaluation?.eligible) { waiver = "homeready"; sfcs.add(SFC.homeready); }
  else if (i.first_time_homebuyer && i.fthb_ami_waiver) waiver = "fthb_ami";
  else if (i.dts_waiver) { waiver = "duty_to_serve"; sfcs.add(SFC.duty_to_serve); }
  const counted: LlpaItem[] = waiver ? (minMi ? [minMi] : []) : (minMi ? [...items, minMi] : items);
  const waived: LlpaItem[] = waiver ? items.map((it) => ({ ...it, waived: true })) : [];
  let credits = 0n;
  if (waiver === "homeready" && i.very_low_income && i.first_time_homebuyer && i.transaction_type === "purchase" && i.expected_purchase_ready_date <= HOMEREADY_VLI_CREDIT_LAST_PURCHASE_READY) { credits = HOMEREADY_VLI_CREDIT_CENTS; sfcs.add(SFC.homeready_vli_credit); }
  const total = sumPct(counted);
  const llpa_table_id = rd.grid(gridName).llpa_table_id;
  return { llpa_table_id, matrix_version: sel.matrix_version, ltv_x100: x100, ltv: (x100 / 10_000).toFixed(4), ltv_band: col, score_row: scoreRow, high_balance: hb.high_balance, llpa_items: counted, llpa_items_waived: waived, llpa_total_pct: total, waiver_applied: waiver, credits_cents: credits, llpa_cents: pctOfCents(i.loan_amount_cents, total), sfcs: [...sfcs].sort(), flags, matrix_change_exposure: sel.matrix_change_exposure };
}

// ============================================================ cost and fee schedules (rules 3, 11)
export interface CostItem { readonly fee_code: string; readonly description: string; readonly mismo_fee_type: string; readonly le_section: LeSection; readonly vendor: string; readonly amount_cents: Cents; readonly provider_source: ProviderSource; readonly shoppable: boolean; readonly valuation_methods?: readonly string[]; }
export interface SmCostSchedule { readonly cost_schedule_id: string; readonly partner_id: string; readonly state: string; readonly transaction_type: TransactionType; readonly valuation_method: string; readonly items: readonly CostItem[]; readonly effective_from: PlainDate; readonly approved_by: string; }
export interface FeeScheduleItem { readonly fee_code: string; readonly description: string; readonly le_section: LeSection; readonly mismo_fee_type: string; readonly amount_cents: Cents; readonly source: "vendor_api" | "jurisdiction_table" | "contract" | "estimate"; readonly refreshed_at: string; }
export interface FeeSchedule { readonly fee_schedule_id: string; readonly jurisdiction: string; readonly items: readonly FeeScheduleItem[]; readonly version: string; readonly effective_from: PlainDate; readonly refreshed_at: string; }
/** Rule 3: `third_party_costs_cents = Σ items` for the state / transaction / valuation method (value acceptance → appraisal item $0). */
export function thirdPartyCosts(schedule: SmCostSchedule, i: { readonly state: string; readonly transaction_type: TransactionType; readonly valuation_method: string }): { items: CostItem[]; total_cents: Cents } {
  if (schedule.state !== i.state || schedule.transaction_type !== i.transaction_type) throw new RangeError(`cost schedule ${schedule.cost_schedule_id} is for ${schedule.state}/${schedule.transaction_type}, not ${i.state}/${i.transaction_type}`);
  const items = schedule.items.filter((c) => !c.valuation_methods || c.valuation_methods.includes(i.valuation_method)).map((c) => (i.valuation_method.startsWith("value_acceptance") && /appraisal/i.test(c.fee_code) ? { ...c, amount_cents: 0n } : c));
  return { items, total_cents: sumCents(items.map((c) => c.amount_cents)) };
}
export function refreshFeeSchedule(events: EventStore, s: Omit<FeeSchedule, "refreshed_at" | "version"> & { readonly version?: string }, at: string, actor: Actor = PRICING_AGENT): { schedule: FeeSchedule; event: DomainEvent } {
  nonEmpty(s.fee_schedule_id, "fee_schedule_id"); nonEmpty(s.jurisdiction, "jurisdiction");
  const schedule: FeeSchedule = { ...s, version: s.version ?? at.slice(0, 10), refreshed_at: at, items: s.items.map((it) => ({ ...it, refreshed_at: it.refreshed_at || at })) };
  const event = events.append({ type: "fee_schedule.refreshed", actor, occurredAt: at, aggregate: { kind: "fee_schedule", id: schedule.fee_schedule_id }, payload: { fee_schedule_id: schedule.fee_schedule_id, jurisdiction: schedule.jurisdiction, version: schedule.version, refreshed_at: at, refreshed_on: isoDateEt(at), item_count: schedule.items.length, origination: true } });
  return { schedule, event };
}
export const feeScheduleStale = (s: FeeSchedule, asOf: string): boolean => Date.parse(asOf) - Date.parse(s.refreshed_at) > FEE_SCHEDULE_REFRESH_DAYS * 86_400_000;
export type PaidBy = "sm_third_party_cost_program" | "borrower";
export interface QuoteFeeItem extends FeeItemInput { readonly tolerance_class: ToleranceClass; readonly paid_by: PaidBy; readonly stale_source: boolean; }
/** Rule 11: the quote's fee items with `tolerance_class` (21.2's rule 4) and `paid_by` — SM's cost program, or the borrower when they elected to pay costs (T12). */
export function buildFeeItems(q: { inputs: QuoteInputs; quote_id: string; quoted_at: string; cost_items: readonly CostItem[] }, fees: FeeSchedule | null): QuoteFeeItem[] {
  const paid_by: PaidBy = q.inputs.borrower_pays_third_party_costs ? "borrower" : "sm_third_party_cost_program";
  const estimated_at = isoDateEt(q.quoted_at);
  const costs: QuoteFeeItem[] = q.cost_items.map((c) => { const base: FeeItemInput = { fee_code: c.fee_code, description: c.description, le_section: c.le_section, mismo_fee_type: c.mismo_fee_type, amount_cents: c.amount_cents, provider_source: c.provider_source, shoppable: c.shoppable, estimate_source: "pricing_engine", estimate_source_ref: `sm_cost_schedule:${q.quote_id}`, estimated_at, finance_charge: false, paid_to: c.vendor }; return { ...base, tolerance_class: deriveToleranceClass(base), paid_by, stale_source: false }; });
  const stale = fees ? feeScheduleStale(fees, q.quoted_at) : false;
  const juris: QuoteFeeItem[] = (fees?.items ?? []).map((f) => { const base: FeeItemInput = { fee_code: f.fee_code, description: f.description, le_section: f.le_section, mismo_fee_type: f.mismo_fee_type, amount_cents: f.amount_cents, provider_source: "government", shoppable: false, estimate_source: f.source === "jurisdiction_table" ? "county_table" : "fee_schedule", estimate_source_ref: `${fees!.fee_schedule_id}@${fees!.version}`, estimated_at, finance_charge: false }; return { ...base, tolerance_class: deriveToleranceClass(base), paid_by: "borrower", stale_source: stale }; });
  return [...costs, ...juris];
}

// ============================================================ pass-through solve (rule 4)
export interface SolveRow { readonly rate: string; readonly rate_pct: string; readonly price: string; readonly premium_cents: Cents; readonly net_cents: Cents; readonly pass: boolean; }
export interface SolveResult {
  readonly outcome: "priced" | "not_priceable"; readonly solve_trace: readonly SolveRow[]; readonly note_rate: string | null; readonly note_rate_pct: string | null; readonly pass_through_rate: string | null; readonly base_price: string | null; readonly net_price: string | null;
  readonly lock_period_days_priced: number; readonly net_premium_cents: Cents; readonly residual_cents: Cents; readonly lender_credit_cents: Cents; readonly sm_retained_cents: Cents; readonly lender_credit_cap_cents: Cents; readonly third_party_costs_cents: Cents; readonly pe_wl_quote_id: string | null; readonly pe_wl_quote_expires_at: string | null;
}
/** Sheet prices for (product, term, amortization) at the requested lock period, or the next longer period on the sheet (rule 1), ascending by rate. */
export function candidateRates(sheet: RateSheet, i: Pick<QuoteInputs, "product_code" | "term_months" | "amortization" | "lock_period_days">): { rows: RateSheetPrice[]; lock_period_days: number } {
  if (sheet.status !== "active") throw new QuoteRefused("sheet_not_active", `rate sheet ${sheet.rate_sheet_id} is ${sheet.status}`);
  if (sheet.execution === "mandatory_indicative") throw new QuoteRefused("mandatory_display_only", "mandatory-execution indicatives are display-only (execution.mandatory_enabled=false)");
  const product = sheet.prices.filter((p) => p.product_code === i.product_code && p.term_months === i.term_months && p.amortization === i.amortization);
  const periods = [...new Set(product.map((p) => p.lock_period_days))].sort((a, b) => a - b);
  const period = periods.find((d) => d >= i.lock_period_days);
  if (period === undefined) throw new QuoteRefused("no_lock_period", `no lock period ≥ ${i.lock_period_days} days on sheet ${sheet.rate_sheet_id} for ${i.product_code}/${i.term_months}/${i.amortization}`);
  return { rows: product.filter((p) => p.lock_period_days === period).sort((a, b) => dec(a.note_rate).cmp(dec(b.note_rate))), lock_period_days: period };
}
/**
 * Rule 4: for each candidate r ascending, `net_premium(r) = round_half_up((price(r) − 100)/100 × loan) − llpa_cents +
 * credits_cents`; `r* = min{r : net_premium(r) ≥ third_party_costs}`; residual → lender credit capped at 12.5 bps, the
 * rest retained by SM; `not_priceable` when no sheet rate covers the costs (the program then offers the lowest rate
 * with borrower-paid costs). Never a price that is not on the sheet.
 */
export function solvePassThrough(sheet: RateSheet, i: Pick<QuoteInputs, "product_code" | "term_months" | "amortization" | "lock_period_days" | "loan_amount_cents" | "borrower_pays_third_party_costs">, llpa: Pick<LlpaResult, "llpa_cents" | "credits_cents">, thirdPartyCostsCents: Cents, policy: { residual_credit_cap_bps?: string } = {}): SolveResult {
  const { rows, lock_period_days } = candidateRates(sheet, i);
  const costs = i.borrower_pays_third_party_costs ? 0n : thirdPartyCostsCents;
  const cap = bpsOfCents(i.loan_amount_cents, policy.residual_credit_cap_bps ?? RESIDUAL_CREDIT_CAP_BPS);
  const trace: SolveRow[] = []; let star: RateSheetPrice | null = null;
  for (const p of rows) {
    const premium = pctOfCents(i.loan_amount_cents, dec(p.price).sub(HUNDRED).toFixed(3, "HALF_UP"));
    const net = premium - llpa.llpa_cents + llpa.credits_cents;
    const pass = net >= costs;
    trace.push({ rate: p.note_rate, rate_pct: pctFromRate(p.note_rate), price: p.price, premium_cents: premium, net_cents: net, pass });
    if (pass && !star) star = p;
  }
  if (!star) return { outcome: "not_priceable", solve_trace: trace, note_rate: null, note_rate_pct: null, pass_through_rate: null, base_price: null, net_price: null, lock_period_days_priced: lock_period_days, net_premium_cents: 0n, residual_cents: 0n, lender_credit_cents: 0n, sm_retained_cents: 0n, lender_credit_cap_cents: cap, third_party_costs_cents: costs, pe_wl_quote_id: null, pe_wl_quote_expires_at: null };
  const net = trace.find((t) => t.rate === star!.note_rate)!.net_cents;
  const residual = net - costs;
  const credit = residual < cap ? residual : cap;
  const llpaPct = centsToDecimal(llpa.llpa_cents).div(centsToDecimal(i.loan_amount_cents)).mul(HUNDRED);
  return { outcome: "priced", solve_trace: trace, note_rate: star.note_rate, note_rate_pct: pctFromRate(star.note_rate), pass_through_rate: star.pass_through_rate, base_price: star.price, net_price: dec(star.price).sub(llpaPct).toFixed(3, "HALF_UP"), lock_period_days_priced: lock_period_days,
    net_premium_cents: net, residual_cents: residual, lender_credit_cents: credit, sm_retained_cents: residual - credit, lender_credit_cap_cents: cap, third_party_costs_cents: costs, pe_wl_quote_id: star.pe_wl_quote_id, pe_wl_quote_expires_at: star.pe_wl_quote_expires_at };
}

// ============================================================ payment, MI, escrow, prepaid interest, APR (rule 5)
/** B7-1-02 standard coverage by LTV band (HomeReady 25 % at 95.01–97 %); minimum-coverage option 6/12/16/18 %. */
export function miCoveragePct(x100: number, option: MiOption, homeready: boolean): number {
  if (option === "none" || x100 <= 8000) return 0;
  const band = x100 <= 8500 ? 0 : x100 <= 9000 ? 1 : x100 <= 9500 ? 2 : 3;
  if (option === "minimum_coverage") return [6, 12, 16, 18][band]!;
  return homeready && band === 3 ? 25 : [12, 25, 30, 35][band]!;
}
/** BPMI monthly = round_half_up(loan × annual rate / 12) — the MI rate-quote API's premium rate (illustrative 0.58 %/yr → $199.13 on $412,000). */
export const bpmiMonthly = (loanCents: Cents, annualRatePct: string): Cents => centsToDecimal(loanCents).mul(ratePercent(annualRatePct)).div(Decimal.fromInt(12)).toCents("HALF_UP");
/** Escrow monthly estimate = (taxes + insurance) / 12 half-up; the initial deposit is 30.3's aggregate analysis at LE time (flagged `estimate`). */
export const escrowMonthlyEstimate = (taxesAnnual: Cents, insuranceAnnual: Cents): Cents => divRound(taxesAnnual + insuranceAnnual, 12n, "HALF_UP");
export interface PaymentEstimate { readonly pi_cents: Cents; readonly mi_monthly_cents: Cents; readonly mi_coverage_pct: number; readonly escrow_monthly_estimate_cents: Cents; readonly escrow_estimate_flag: "estimate"; readonly total_monthly_cents: Cents; readonly prepaid: PrepaidInterest | null; readonly apr: AprCalculation | null; readonly apr_estimate: string | null; }
export function computePayment(i: QuoteInputs, noteRatePct: string, x100: number): PaymentEstimate {
  const pi = levelPayment(i.loan_amount_cents, ratePercent(noteRatePct), i.term_months);
  const coverage = miCoveragePct(x100, i.mi_option, i.homeready);
  const mi = coverage > 0 && i.mi_annual_rate_pct ? bpmiMonthly(i.loan_amount_cents, i.mi_annual_rate_pct) : 0n;
  const escrow = i.escrowed ? escrowMonthlyEstimate(i.taxes_annual_cents ?? 0n, i.insurance_annual_cents ?? 0n) : 0n;
  const prepaid = i.assumed_disbursement_date ? prepaidInterest(i.loan_amount_cents, noteRatePct, i.assumed_disbursement_date) : null;
  const apr = prepaid && i.first_payment_date ? computeApr({ loan_amount_cents: i.loan_amount_cents, note_rate_pct: noteRatePct, term_months: i.term_months, term_start_date: i.assumed_disbursement_date!, first_payment_date: i.first_payment_date, prepaid_finance_charges_cents: 0n, prepaid_interest_cents: prepaid.prepaid_interest_cents, ...(mi > 0n ? { mi_stream_cents: Array.from({ length: i.term_months }, () => mi) } : {}), checkpoint: "le" }) : null;
  return { pi_cents: pi, mi_monthly_cents: mi, mi_coverage_pct: coverage, escrow_monthly_estimate_cents: escrow, escrow_estimate_flag: "estimate", total_monthly_cents: pi + mi + escrow, prepaid, apr, apr_estimate: apr ? apr.apr_disclosed_str : null };
}

// ============================================================ quote validity (rule 6; T5)
/** `YYYY-MM-DDTHH:MM±HH:MM` in Eastern time — the presentation form of `valid_until` ("valid today until 5:00 p.m. ET"). */
export function isoEt(ms: number): string {
  const w = wallClock(ms, ET); const local = zonedEpochMs(w.date, `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`, ET);
  const offMin = Math.round((Date.UTC(Number(w.date.slice(0, 4)), Number(w.date.slice(5, 7)) - 1, Number(w.date.slice(8, 10)), w.hour, w.minute) - local) / 60_000);
  const sign = offMin < 0 ? "-" : "+"; const a = Math.abs(offMin);
  return `${w.date}T${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
export function quoteValidity(quotedAt: string, sheet: Pick<RateSheet, "expires_at">): { valid_until: string; valid_until_ms: number; basis: "sheet_expiry" | "24h" } {
  const q = Date.parse(quotedAt), s = Date.parse(sheet.expires_at), cap = q + QUOTE_MAX_VALIDITY_HOURS * 3_600_000;
  const ms = Math.min(s, cap);
  return { valid_until: isoEt(ms), valid_until_ms: ms, basis: s <= cap ? "sheet_expiry" : "24h" };
}
export const quoteValidAt = (q: Pick<PricingQuote, "valid_until">, at: string): boolean => Date.parse(at) <= Date.parse(q.valid_until);
/** SM_QUOTE_VALIDITY_GATE: a lock (21.4) is allowed only inside the window; afterwards the borrower is re-quoted (up or down), never silently held. */
export function lockWindowCheck(q: Pick<PricingQuote, "valid_until" | "status">, at: string): { allowed: boolean; reason: "quote_expired" | "quote_not_current" | null } {
  if (q.status === "superseded" || q.status === "expired") return { allowed: false, reason: "quote_not_current" };
  return quoteValidAt(q, at) ? { allowed: true, reason: null } : { allowed: false, reason: "quote_expired" };
}

// ============================================================ the quote (rule 9: every id and version on the row)
export type QuotePurpose = "candidate" | "lead_quote" | "lock" | "relock" | "reprice" | "commitment";
export type QuoteStatus = "draft" | "presented" | "superseded" | "expired" | "locked";
export interface QuoteContext { readonly sheet: RateSheet; readonly tables: readonly LlpaTable[]; readonly cost_schedule: SmCostSchedule; readonly fee_schedule: FeeSchedule | null; readonly policy?: { residual_credit_cap_bps?: string }; }
export interface QuoteMeta { readonly quote_id: string; readonly purpose: QuotePurpose; readonly quoted_at: string; readonly lead_id?: string | null; readonly application_id?: string | null; readonly loan_id?: string | null; readonly engine_version?: string; }
export interface PricingQuote extends LlpaResult, SolveResult {
  readonly quote_id: string; readonly lead_id: string | null; readonly application_id: string | null; readonly loan_id: string | null; readonly purpose: QuotePurpose;
  readonly rate_sheet_id: string; readonly cost_schedule_id: string; readonly fee_schedule_id: string | null; readonly rule_set_version: string; readonly llpa_rule_set: string; readonly engine_version: string;
  readonly inputs: QuoteInputs; readonly inputs_hash: string; readonly cost_items: readonly CostItem[]; readonly fee_items: readonly QuoteFeeItem[];
  readonly pi_cents: Cents; readonly mi_monthly_cents: Cents; readonly mi_coverage_pct: number; readonly escrow_monthly_estimate_cents: Cents; readonly total_monthly_cents: Cents; readonly prepaid_interest_cents: Cents; readonly prepaid_interest_days: number; readonly per_diem_cents: Cents; readonly apr_estimate: string | null; readonly points_cents: Cents;
  readonly quoted_at: string; readonly valid_until: string; readonly status: QuoteStatus; readonly mlo_review_id: string | null; readonly disclaimer_notice_id: string | null; readonly agent_decision_id: string | null; readonly explanation_text: string; readonly numeric_hash: string;
}
/** The reproducibility fingerprint: every numeric field of the quote as a string (T8 compares two quotes by it). */
export function numericFields(q: PricingQuote): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) { if (typeof v === "bigint" || typeof v === "number") out[k] = String(v); else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) out[k] = v; }
  out.solve_trace = q.solve_trace.map((t) => `${t.rate}:${t.price}:${t.premium_cents}:${t.net_cents}`).join("|");
  out.llpa_items = q.llpa_items.map((it) => `${it.grid}:${it.row}:${it.col}:${it.pct}`).join("|");
  out.fee_items = q.fee_items.map((f) => `${f.fee_code}:${f.amount_cents}:${f.tolerance_class}:${f.paid_by}`).join("|");
  return out;
}
/**
 * The whole engine for one quote: LLPAs → costs → solve → payment/estimates → validity, every id and version stamped
 * (rule 9), `quote.created` appended (SM_QUOTE_VALIDITY_GATE and SM_LLPA_TABLE_VERSION_GATE arm from it). A pure
 * function of `(context ids, inputs, quoted_at)`: re-running it reproduces every numeric field.
 */
export function priceQuote(events: EventStore | null, ctx: QuoteContext, inputs: QuoteInputs, meta: QuoteMeta, actor: Actor = PRICING_AGENT): { quote: PricingQuote; event: DomainEvent | null } {
  nonEmpty(meta.quote_id, "quote_id"); nonEmpty(meta.quoted_at, "quoted_at");
  if (Date.parse(meta.quoted_at) >= Date.parse(ctx.sheet.expires_at) || Date.parse(meta.quoted_at) < Date.parse(ctx.sheet.published_at)) throw new QuoteRefused("sheet_not_in_force", `rate sheet ${ctx.sheet.rate_sheet_id} is not in force at ${meta.quoted_at}`);
  const llpa = computeLlpa(ctx.tables, inputs);
  const costs = thirdPartyCosts(ctx.cost_schedule, inputs);
  const solve = solvePassThrough(ctx.sheet, inputs, llpa, costs.total_cents, ctx.policy ?? {});
  const fee_items = buildFeeItems({ inputs, quote_id: meta.quote_id, quoted_at: meta.quoted_at, cost_items: costs.items }, ctx.fee_schedule);
  const pay = solve.note_rate_pct ? computePayment(inputs, solve.note_rate_pct, llpa.ltv_x100) : null;
  const validity = quoteValidity(meta.quoted_at, ctx.sheet);
  const engine_version = meta.engine_version ?? ENGINE_VERSION;
  const base: Omit<PricingQuote, "numeric_hash" | "explanation_text"> = { ...llpa, ...solve,
    quote_id: meta.quote_id, lead_id: meta.lead_id ?? null, application_id: meta.application_id ?? null, loan_id: meta.loan_id ?? null, purpose: meta.purpose,
    rate_sheet_id: ctx.sheet.rate_sheet_id, cost_schedule_id: ctx.cost_schedule.cost_schedule_id, fee_schedule_id: ctx.fee_schedule?.fee_schedule_id ?? null, rule_set_version: RULE_SET_VERSION_20_4, llpa_rule_set: `${LLPA_BUNDLE}.${llpa.matrix_version}`, engine_version,
    inputs, inputs_hash: sha(inputs), cost_items: costs.items, fee_items,
    pi_cents: pay?.pi_cents ?? 0n, mi_monthly_cents: pay?.mi_monthly_cents ?? 0n, mi_coverage_pct: pay?.mi_coverage_pct ?? 0, escrow_monthly_estimate_cents: pay?.escrow_monthly_estimate_cents ?? 0n, total_monthly_cents: pay?.total_monthly_cents ?? 0n,
    prepaid_interest_cents: pay?.prepaid?.prepaid_interest_cents ?? 0n, prepaid_interest_days: pay?.prepaid?.days ?? 0, per_diem_cents: pay?.prepaid?.per_diem_cents ?? 0n, apr_estimate: pay?.apr_estimate ?? null, points_cents: 0n,
    quoted_at: meta.quoted_at, valid_until: validity.valid_until, status: "draft", mlo_review_id: null, disclaimer_notice_id: null, agent_decision_id: null };
  const explanation_text = explainQuote(base as PricingQuote);
  const quote: PricingQuote = { ...base, explanation_text, numeric_hash: sha(numericFields({ ...base, explanation_text, numeric_hash: "" })) };
  const event = events ? events.append({ type: "quote.created", actor, occurredAt: meta.quoted_at, ...(quote.application_id ? { applicationId: quote.application_id } : {}), aggregate: { kind: "pricing_quote", id: quote.quote_id },
    payload: { quote_id: quote.quote_id, purpose: quote.purpose, outcome: quote.outcome, quoted_at: quote.quoted_at, quoted_on: isoDateEt(quote.quoted_at), valid_until: quote.valid_until, expected_purchase_ready_date: inputs.expected_purchase_ready_date, rate_sheet_id: quote.rate_sheet_id, llpa_table_id: quote.llpa_table_id, matrix_version: quote.matrix_version, note_rate: quote.note_rate, pass_through_rate: quote.pass_through_rate, lender_credit_cents: String(quote.lender_credit_cents), sfcs: quote.sfcs, flags: quote.flags, lead_id: quote.lead_id, application_id: quote.application_id, engine_version, origination: true } }) : null;
  return { quote, event };
}
export function recomputeQuote(ctx: QuoteContext, q: PricingQuote): PricingQuote {
  if (ctx.sheet.rate_sheet_id !== q.rate_sheet_id || ctx.cost_schedule.cost_schedule_id !== q.cost_schedule_id || (ctx.fee_schedule?.fee_schedule_id ?? null) !== q.fee_schedule_id) throw new RangeError("recompute needs the quote's own rate_sheet_id / cost_schedule_id / fee_schedule_id");
  return priceQuote(null, ctx, q.inputs, { quote_id: q.quote_id, purpose: q.purpose, quoted_at: q.quoted_at, lead_id: q.lead_id, application_id: q.application_id, loan_id: q.loan_id, engine_version: q.engine_version }).quote;
}
const money = (c: Cents): string => { const neg = c < 0n; const a = neg ? -c : c; const d = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `${neg ? "-" : ""}$${d}.${(a % 100n).toString().padStart(2, "0")}`; };
/** The plain-language explanation from computed fields only (the LLM drafts prose inside this frame; it never chooses the rate). */
export function explainQuote(q: PricingQuote): string {
  if (q.outcome === "not_priceable") return `No rate on today's sheet covers the ${money(q.third_party_costs_cents)} of third-party costs under the no-cost program (deep-discount market). The lowest sheet rate is available with the third-party costs paid by you at closing.`;
  const star = q.solve_trace.find((t) => t.pass)!; const below = q.solve_trace.filter((t) => !t.pass).at(-1);
  const alt = q.inputs.borrower_pays_third_party_costs ? "" : ` Same-term alternative: if you pay the ${money(q.third_party_costs_cents)} of third-party costs yourself, the lowest rate whose price is at or above par applies.`;
  return `Your rate is ${star.rate_pct}% because at that rate the investor price of ${star.price} yields a premium of ${money(star.premium_cents)}; after loan-level price adjustments of ${money(q.llpa_cents)}${q.waiver_applied ? ` (waived: ${q.waiver_applied})` : ""} the net ${money(star.net_cents)} covers the ${money(q.third_party_costs_cents)} of third-party costs that SM pays for you.` +
    (below ? ` The next lower rate, ${below.rate_pct}%, nets ${money(below.net_cents)} and does not cover those costs.` : "") +
    ` The remaining ${money(q.residual_cents)} is passed to you as a lender credit of ${money(q.lender_credit_cents)} (capped at 12.5 bps); ${money(q.sm_retained_cents)} is retained. No points are charged.${alt}`;
}

// ============================================================ lifecycle: presentation, expiry, supersession, lock (state machine)
export interface MloReview { readonly review_id: string; readonly outcome: "approved" | "returned"; readonly mlo_of_record_id: string; readonly mlo_name: string; readonly nmlsr_id: string; readonly completed_at: string; }
/** The personalized quote asks for the MLO review (20.3's `terms.presentation.requested`; SM_MLO_PREAPP_TERMS_REVIEW_1BH). */
export function requestTermsReview(events: EventStore, q: PricingQuote, r: { requested_at: string; mlo_of_record_id: string }, actor: Actor = PRICING_AGENT): DomainEvent {
  nonEmpty(r.mlo_of_record_id, "mlo_of_record_id");
  if (q.outcome !== "priced") throw new QuoteRefused("not_priceable", "a not-priceable quote is not presented as personalized terms");
  return events.append({ type: "terms.presentation.requested", actor, occurredAt: r.requested_at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, lead_id: q.lead_id, requested_at: r.requested_at, mlo_of_record_id: r.mlo_of_record_id, note_rate: q.note_rate, pi_cents: String(q.pi_cents), origination: true } });
}
/** `draft → presented` only after `mlo.review.completed{outcome=approved}` (20.3): the presentation names the MLO (§1026.36(g)). */
export function presentQuote(events: EventStore, q: PricingQuote, review: MloReview | null, at: string, actor: Actor = PRICING_AGENT): { quote: PricingQuote; event: DomainEvent } {
  if (!review || review.outcome !== "approved") throw new QuoteRefused("mlo_review_required", "never present a personalized quote before mlo.review.completed{outcome=approved} (20.3)");
  if (q.status !== "draft") throw new QuoteRefused("quote_not_current", `quote ${q.quote_id} is ${q.status}`);
  if (!quoteValidAt(q, at)) throw new QuoteRefused("quote_expired", `quote ${q.quote_id} expired ${q.valid_until}`);
  const quote: PricingQuote = { ...q, status: "presented", mlo_review_id: review.review_id };
  return { quote, event: events.append({ type: "quote.presented", actor, occurredAt: at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, mlo_review_id: review.review_id, mlo_name: review.mlo_name, nmlsr_id: review.nmlsr_id, valid_until: q.valid_until, origination: true } }) };
}
export function expireQuote(events: EventStore, q: PricingQuote, at: string, actor: Actor = PRICING_AGENT): { quote: PricingQuote; event: DomainEvent | null } {
  if (q.status === "locked" || q.status === "superseded" || q.status === "expired" || quoteValidAt(q, at)) return { quote: q, event: null };
  return { quote: { ...q, status: "expired" }, event: events.append({ type: "quote.expired", actor, occurredAt: at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, valid_until: q.valid_until, origination: true } }) };
}
export function supersedeQuote(events: EventStore, q: PricingQuote, by: string, reason: "rate_sheet_republished" | "input_changed" | "requote_after_expiry", at: string, actor: Actor = PRICING_AGENT): { quote: PricingQuote; event: DomainEvent } {
  if (q.status === "locked") throw new QuoteRefused("quote_locked", "a locked quote keeps its price (21.4 handles changes as changed circumstances)");
  return { quote: { ...q, status: "superseded" }, event: events.append({ type: "quote.superseded", actor, occurredAt: at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, superseded_by: by, reason, prior_note_rate: q.note_rate, origination: true } }) };
}
/** 21.4's `lock.executed` on the quote: `presented → locked`; the price is frozen (rule 6). */
export function markQuoteLocked(events: EventStore, q: PricingQuote, lock: { lock_id: string; executed_at: string }, actor: Actor = PRICING_AGENT): { quote: PricingQuote; event: DomainEvent } {
  const w = lockWindowCheck(q, lock.executed_at); if (!w.allowed) throw new QuoteRefused(w.reason!, `lock ${lock.lock_id} at ${lock.executed_at} is outside the quote window (valid until ${q.valid_until})`);
  return { quote: { ...q, status: "locked" }, event: events.append({ type: "quote.locked", actor, occurredAt: lock.executed_at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, lock_id: lock.lock_id, note_rate: q.note_rate, base_price: q.base_price, sfcs: [...q.sfcs], origination: true } }) };   // `sfcs`: 29.3 harvests the quote's SFCs (007/067/808/900/235/874/884) from quote.locked
}
/**
 * T5: a lock request after `valid_until` is refused (`quote_expired`) and the borrower is re-quoted from the sheet
 * in force at that time (the extended-hours sheet when published); with no sheet in force nothing is quoted.
 */
export function lockOrRequote(events: EventStore, ctx: Omit<QuoteContext, "sheet">, sheets: readonly RateSheet[], q: PricingQuote, r: { requested_at: string; new_quote_id: string }, actor: Actor = PRICING_AGENT): { allowed: boolean; reason: string | null; requote: PricingQuote | null; superseded: PricingQuote } {
  const w = lockWindowCheck(q, r.requested_at);
  if (w.allowed) return { allowed: true, reason: null, requote: null, superseded: q };
  const expired = expireQuote(events, q, r.requested_at, actor).quote;
  const sheet = activeSheetAt(sheets, r.requested_at);
  if (!sheet) return { allowed: false, reason: w.reason, requote: null, superseded: expired };
  const requote = priceQuote(events, { ...ctx, sheet }, q.inputs, { quote_id: r.new_quote_id, purpose: q.purpose, quoted_at: r.requested_at, lead_id: q.lead_id, application_id: q.application_id, loan_id: q.loan_id }, actor).quote;
  return { allowed: false, reason: w.reason, requote, superseded: expired };
}
/** Rate-sheet republish after presentation: every open quote on the old sheet is superseded and re-quoted (no bait-and-switch — the prior presentation is shown with the change explained). */
export function requoteOnRepublish(events: EventStore, ctx: QuoteContext, open: readonly PricingQuote[], at: string, newId: (q: PricingQuote) => string, actor: Actor = PRICING_AGENT): { superseded: PricingQuote; requote: PricingQuote; change_bps: string }[] {
  return open.filter((q) => (q.status === "draft" || q.status === "presented") && q.rate_sheet_id !== ctx.sheet.rate_sheet_id).map((q) => {
    const requote = priceQuote(events, ctx, q.inputs, { quote_id: newId(q), purpose: q.purpose, quoted_at: at, lead_id: q.lead_id, application_id: q.application_id, loan_id: q.loan_id }, actor).quote;
    const superseded = supersedeQuote(events, q, requote.quote_id, "rate_sheet_republished", at, actor).quote;
    const change = q.note_rate && requote.note_rate ? dec(requote.note_rate).sub(dec(q.note_rate)).mul(Decimal.fromInt(10_000)).toFixed(1, "HALF_UP") : "0.0";
    return { superseded, requote, change_bps: change };
  });
}

// ============================================================ written quote and the §1026.19(e)(2)(ii) gate (rule 7; T4)
export const H24_HEADINGS: readonly string[] = ["Loan Terms", "Projected Payments", "Costs at Closing", "Loan Costs", "Other Costs", "Calculating Cash to Close", "Services You Cannot Shop For", "Services You Can Shop For", "Comparisons"];
export interface DisclaimerGateResult { readonly open: boolean; readonly reasons: readonly string[]; readonly disclaimer_block: RenderedBlock | null; }
/** The rendered document's blocks: the statement verbatim at the top of page 1 in ≥ 12-pt, and no H-24/H-25 resemblance (title or section headings). */
export function disclaimerGate(blocks: readonly RenderedBlock[], title: string | null): DisclaimerGateResult {
  const reasons: string[] = [];
  const first = [...blocks].filter((b) => b.page === 1).sort((a, b) => a.yFraction - b.yFraction)[0] ?? null;
  const disc = blocks.find((b) => b.text.trim().startsWith(DISCLAIMER_STATEMENT)) ?? null;
  if (!disc) reasons.push("disclaimer_missing");
  else {
    if (disc.page !== 1 || disc.yFraction > DISCLAIMER_MAX_Y_FRACTION || (first && first.id !== disc.id)) reasons.push("disclaimer_not_top_of_page_1");
    if (disc.pt < DISCLAIMER_MIN_PT) reasons.push(`disclaimer_font_${disc.pt}pt_below_12pt`);
  }
  const t = (title ?? "").trim();
  if (/^loan estimate$/i.test(t) || /^closing disclosure$/i.test(t)) reasons.push("title_resembles_h24_h25");
  const text = blocks.map((b) => b.text).join("\n");
  const hits = H24_HEADINGS.filter((h) => new RegExp(`(^|\\n)\\s*${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text) || blocks.some((b) => b.text.trim().toLowerCase().startsWith(h.toLowerCase())));
  if (hits.length >= 2) reasons.push(`h24_section_structure:${hits.join(",")}`);
  return { open: reasons.length === 0, reasons, disclaimer_block: disc };
}
/** The template dissimilarity check alone (title + H-24 section headings) for a template under review. */
export const h24Dissimilarity = (blocks: readonly RenderedBlock[], title: string | null): { dissimilar: boolean; reasons: readonly string[] } => { const r = disclaimerGate(blocks, title); const reasons = r.reasons.filter((x) => x.startsWith("title_") || x.startsWith("h24_")); return { dissimilar: reasons.length === 0, reasons }; };
export interface RenderOutcome { readonly blocked: boolean; readonly reasons: readonly string[]; readonly quote: PricingQuote; readonly requested: DomainEvent; readonly result: DomainEvent; }
/** REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE around a render: `quote.render.requested` arms it; `quote.rendered{disclaimer_verified=true}` satisfies it; a failed gate appends `quote.render.blocked` (sev 1) and the document is not issued. */
export function gateRender(events: EventStore, q: PricingQuote, rendered: { blocks: readonly RenderedBlock[]; title: string | null; notice_id: string | null }, at: string, actor: Actor = PRICING_AGENT): RenderOutcome {
  if (q.purpose === "lead_quote" && q.status === "draft") throw new QuoteRefused("mlo_review_required", "a personalized written quote is rendered only after the MLO review (20.3)");
  const requested = events.append({ type: "quote.render.requested", actor, occurredAt: at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, template: RATE_QUOTE_TEMPLATE, origination: true } });
  const g = disclaimerGate(rendered.blocks, rendered.title);
  if (!g.open) return { blocked: true, reasons: g.reasons, quote: q, requested, result: events.append({ type: "quote.render.blocked", actor, occurredAt: at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, reasons: g.reasons, severity: 1, gate: "REGZ_1026_19E2II_QUOTE_DISCLAIMER_GATE", origination: true } }) };
  const quote: PricingQuote = { ...q, disclaimer_notice_id: rendered.notice_id };
  return { blocked: false, reasons: [], quote, requested, result: events.append({ type: "quote.rendered", actor, occurredAt: at, ...(q.application_id ? { applicationId: q.application_id } : {}), aggregate: { kind: "pricing_quote", id: q.quote_id }, payload: { quote_id: q.quote_id, notice_id: rendered.notice_id, disclaimer_verified: true, disclaimer_pt: g.disclaimer_block?.pt ?? null, origination: true } }) };
}
/** The payload the NTC_SM_RATE_QUOTE template renders from (borrower-facing text comes only from the template). */
export function quoteNoticePayload(q: PricingQuote, p: { borrower_name: string; property_address: string; mlo_name: string; mlo_nmlsr_id: string; partner_name: string; partner_nmlsr_id: string; prepared_on: PlainDate }): Record<string, unknown> {
  if (q.outcome !== "priced") throw new QuoteRefused("not_priceable", "a not-priceable quote has no written terms");
  const w = wallClock(Date.parse(q.valid_until), ET); const h12 = ((w.hour + 11) % 12) + 1;
  return { ...p, quote_id: q.quote_id, title: "Your Rate Quote", loan_amount_cents: q.inputs.loan_amount_cents, note_rate_pct: q.note_rate_pct, apr_estimate_pct: q.apr_estimate ?? q.note_rate_pct, term_months: q.inputs.term_months, pi_cents: q.pi_cents, mi_monthly_cents: q.mi_monthly_cents, escrow_monthly_estimate_cents: q.escrow_monthly_estimate_cents, total_monthly_cents: q.total_monthly_cents, shows_total: true,
    lock_period_days: q.lock_period_days_priced, valid_until_display: `${w.date} ${h12}:${String(w.minute).padStart(2, "0")} ${w.hour < 12 ? "a.m." : "p.m."} ET`, points_cents: q.points_cents, lender_credit_cents: q.lender_credit_cents, has_lender_credit: q.lender_credit_cents > 0n, borrower_pays_costs: q.inputs.borrower_pays_third_party_costs, third_party_costs_cents: q.third_party_costs_cents, escrowed: q.inputs.escrowed, has_mi: q.mi_monthly_cents > 0n };
}

// ============================================================ pricing exceptions (rule 8; T6)
export type ExceptionKind = "competitor_match" | "error_correction" | "program_credit" | "relationship";
export const EXCEPTION_KINDS: readonly ExceptionKind[] = ["competitor_match", "error_correction", "program_credit", "relationship"];
export interface PricingException { readonly exception_id: string; readonly quote_id: string; readonly application_id: string | null; readonly kind: ExceptionKind; readonly amount_bps: string; readonly amount_cents: Cents; readonly requested_by: string; readonly requested_at: string; readonly due_on: PlainDate; readonly evidence_document_id: string | null; readonly approved_by: string | null; readonly approved_at: string | null; readonly fair_lending_review_id: string | null; readonly status: "pending" | "approved" | "denied" | "auto_denied"; readonly denial_reason: string | null; }
/** Rule 8: no user may adjust price except through an approved `pricing_exceptions` row with a reason code; until approval the quote stays at policy price. */
export function applyManualPrice(q: PricingQuote, change: { note_rate_pct?: string; price?: string; by: Actor }, exception: PricingException | null): PricingQuote {
  if (!exception) throw new QuoteRefused("no_pricing_exception", `manual price change by ${change.by.kind}:${change.by.id} refused — no pricing_exceptions row (rule 8: the note rate is a pure function of the inputs)`);
  if (exception.quote_id !== q.quote_id) throw new QuoteRefused("no_pricing_exception", `exception ${exception.exception_id} is for quote ${exception.quote_id}`);
  if (exception.status !== "approved") throw new QuoteRefused("exception_not_approved", `exception ${exception.exception_id} is ${exception.status}; the quote stays at policy price until an officer approves`);
  const credit = q.lender_credit_cents + exception.amount_cents;
  return { ...q, lender_credit_cents: credit, sm_retained_cents: q.sm_retained_cents - exception.amount_cents, ...(change.price ? { base_price: change.price } : {}), agent_decision_id: q.agent_decision_id };
}
export function requestException(events: EventStore, i: { exception_id: string; quote: PricingQuote; kind: ExceptionKind; amount_bps: string; requested_by: string; requested_at: string; evidence_document_id: string | null }, actor: Actor = PRICING_AGENT): { exception: PricingException; event: DomainEvent } {
  nonEmpty(i.exception_id, "exception_id"); nonEmpty(i.requested_by, "requested_by");
  if (!EXCEPTION_KINDS.includes(i.kind)) throw new RangeError(`kind ${String(i.kind)} is not one of ${EXCEPTION_KINDS.join("/")}`);
  if (i.kind === "relationship") throw new QuoteRefused("exception_kind_prohibited", "relationship exceptions are disabled by policy (rule 8: no discretionary pricing; Reg B §1002.4(a))");
  if ((i.kind === "competitor_match" || i.kind === "error_correction") && !i.evidence_document_id) throw new RangeError(`${i.kind} needs evidence_document_id (the competitor's quote / the erroneous input)`);
  if (i.quote.status === "locked") throw new QuoteRefused("quote_locked", "a locked quote is repriced only by 21.4/21.5");
  const requested_on = isoDateEt(i.requested_at); const due_on = addBusinessDays(requested_on, 1, servicer);
  const exception: PricingException = { exception_id: i.exception_id, quote_id: i.quote.quote_id, application_id: i.quote.application_id, kind: i.kind, amount_bps: i.amount_bps, amount_cents: bpsOfCents(i.quote.inputs.loan_amount_cents, i.amount_bps), requested_by: i.requested_by, requested_at: i.requested_at, due_on, evidence_document_id: i.evidence_document_id, approved_by: null, approved_at: null, fair_lending_review_id: null, status: "pending", denial_reason: null };
  const event = events.append({ type: "pricing.exception.requested", actor, occurredAt: i.requested_at, ...(i.quote.application_id ? { applicationId: i.quote.application_id } : {}), aggregate: { kind: "pricing_exception", id: exception.exception_id }, payload: { exception_id: exception.exception_id, quote_id: exception.quote_id, kind: exception.kind, amount_bps: exception.amount_bps, amount_cents: String(exception.amount_cents), requested_by: exception.requested_by, requested_at: exception.requested_at, requested_on, due_on, evidence_document_id: exception.evidence_document_id, origination: true } });
  return { exception, event };
}
/** The partner secondary `officer` decides; every decision is one `pricing.exception.decided{outcome}` (satisfies SM_PRICING_EXCEPTION_APPROVAL_1BD) next to the spec's approved/denied event; 31.2 reviews quarterly. */
export function decideException(events: EventStore, x: PricingException, d: { outcome: "approved" | "denied"; by: Actor; decided_at: string; reason?: string | null; fair_lending_review_id?: string | null }): { exception: PricingException; event: DomainEvent; decided: DomainEvent } {
  if (!isHuman(d.by, "officer")) throw new PricingRoleDenied(d.by, "officer", "a pricing exception decision");
  if (x.status !== "pending") throw new RangeError(`exception ${x.exception_id} is already ${x.status}`);
  const exception: PricingException = { ...x, status: d.outcome, approved_by: d.outcome === "approved" ? `${d.by.kind}:${d.by.id}` : null, approved_at: d.outcome === "approved" ? d.decided_at : null, fair_lending_review_id: d.fair_lending_review_id ?? null, denial_reason: d.outcome === "denied" ? (d.reason ?? "denied by officer") : null };
  const event = events.append({ type: d.outcome === "approved" ? "pricing.exception.approved" : "pricing.exception.denied", actor: d.by, occurredAt: d.decided_at, ...(x.application_id ? { applicationId: x.application_id } : {}), aggregate: { kind: "pricing_exception", id: x.exception_id }, payload: { exception_id: x.exception_id, quote_id: x.quote_id, kind: x.kind, amount_bps: x.amount_bps, reason: exception.denial_reason, origination: true } });
  const decided = events.append({ type: "pricing.exception.decided", actor: d.by, occurredAt: d.decided_at, ...(x.application_id ? { applicationId: x.application_id } : {}), aggregate: { kind: "pricing_exception", id: x.exception_id }, payload: { exception_id: x.exception_id, quote_id: x.quote_id, outcome: d.outcome, decided_by: `${d.by.kind}:${d.by.id}`, origination: true } });
  return { exception, event, decided };
}
/** Breach of SM_PRICING_EXCEPTION_APPROVAL_1BD: auto-denied; the consumer is re-quoted at policy price. */
export function autoDenyException(events: EventStore, x: PricingException, at: string, actor: Actor = PRICING_AGENT): { exception: PricingException; event: DomainEvent; decided: DomainEvent } {
  if (x.status !== "pending") throw new RangeError(`exception ${x.exception_id} is already ${x.status}`);
  const exception: PricingException = { ...x, status: "auto_denied", denial_reason: "SM_PRICING_EXCEPTION_APPROVAL_1BD breached — no officer decision within 1 business day" };
  const event = events.append({ type: "pricing.exception.denied", actor, occurredAt: at, ...(x.application_id ? { applicationId: x.application_id } : {}), aggregate: { kind: "pricing_exception", id: x.exception_id }, payload: { exception_id: x.exception_id, quote_id: x.quote_id, kind: x.kind, reason: exception.denial_reason, auto: true, origination: true } });
  const decided = events.append({ type: "pricing.exception.decided", actor, occurredAt: at, ...(x.application_id ? { applicationId: x.application_id } : {}), aggregate: { kind: "pricing_exception", id: x.exception_id }, payload: { exception_id: x.exception_id, quote_id: x.quote_id, outcome: "denied", auto: true, origination: true } });
  return { exception, event, decided };
}

// ============================================================ gate facts for the evaluators (evaluators-20-4.ts)
export function quoteValidityGate(f: { valid_until?: unknown; now?: unknown; status?: unknown }): { open: boolean; reason?: string } {
  const vu = typeof f.valid_until === "string" ? Date.parse(f.valid_until) : NaN; const now = typeof f.now === "string" ? Date.parse(f.now) : NaN;
  if (f.status === "expired" || f.status === "superseded") return { open: false, reason: `quote is ${String(f.status)}` };
  if (Number.isNaN(vu) || Number.isNaN(now)) return { open: false, reason: "valid_until and now are required" };
  return now <= vu ? { open: true } : { open: false, reason: `quote expired at ${String(f.valid_until)} (re-quote from the current sheet)` };
}
export function peWlQuoteIdWindow(f: { pe_wl_quote_expires_at?: unknown; now?: unknown }): { open: boolean; reason?: string } {
  if (typeof f.pe_wl_quote_expires_at !== "string") return { open: false, reason: "no Loan Pricing API quote id on the price (re-price before commit)" };
  const now = typeof f.now === "string" ? Date.parse(f.now) : NaN;
  return !Number.isNaN(now) && now <= Date.parse(f.pe_wl_quote_expires_at) ? { open: true } : { open: false, reason: `PE–WL quote id expired ${f.pe_wl_quote_expires_at} — re-price before the Loan Committing API call` };
}
export function llpaTableVersionGate(f: { expected_purchase_ready_date?: unknown; tables?: unknown }): { open: boolean; reason?: string } {
  if (typeof f.expected_purchase_ready_date !== "string" || !Array.isArray(f.tables)) return { open: false, reason: "expected_purchase_ready_date and tables are required" };
  try { const s = selectLlpaVersion(f.tables as LlpaTable[], plainDate(f.expected_purchase_ready_date)); return { open: true, ...(s.matrix_change_exposure ? { reason: `matrix_change_exposure: ${s.matrix_version} applies from ${s.tables[0]!.effective_from}` } : {}) }; }
  catch (e) { return { open: false, reason: (e as Error).message }; }
}
export function quoteDisclaimerGate(f: { blocks?: unknown; title?: unknown }): { open: boolean; reason?: string } {
  if (!Array.isArray(f.blocks)) return { open: false, reason: "rendered blocks are required" };
  const g = disclaimerGate(f.blocks as RenderedBlock[], typeof f.title === "string" ? f.title : null);
  return g.open ? { open: true } : { open: false, reason: g.reasons.join(", ") };
}

// ============================================================ the port 21.4's lock desk prices through
export interface EngineState { readonly sheets: readonly RateSheet[]; readonly tables: readonly LlpaTable[]; readonly cost_schedule: SmCostSchedule; readonly fee_schedule: FeeSchedule | null; readonly policy?: { residual_credit_cap_bps?: string }; }
/**
 * `PricingPort` (src/domain/application/ops-21-4.ts): `rateSheetAt` is the active sheet in force; `price` never invents
 * a price — the request's note rate must be on that sheet at the lock period, and the lender credit is what the engine
 * solved for the quote (passed through by 21.4 from `pricing_quotes`, else 0).
 */
export class PricingEnginePort implements LockPricingPort {
  private readonly state: EngineState; readonly quote_ttl_minutes: number;
  constructor(state: EngineState, opts: { quote_ttl_minutes?: number } = {}) { this.state = state; this.quote_ttl_minutes = opts.quote_ttl_minutes ?? 30; }
  rateSheetAt(at: string): LockRateSheet {
    const s = activeSheetAt(this.state.sheets, at); if (!s) throw new QuoteRefused("no_sheet", `no rate sheet in force at ${at} (no quotes until one is published)`);
    const llpa = this.state.tables.find((t) => t.status === "active")?.matrix_version ?? this.state.tables[0]?.matrix_version ?? "unloaded";
    return { rate_sheet_id: s.rate_sheet_id, effective_at: s.published_at, superseded_at: s.status === "active" ? null : s.expires_at, llpa_version: llpa };
  }
  price(req: LockPriceRequest, at: string): LockPricingQuote {
    if (req.loan_amount_cents <= 0n) throw new RangeError("loan_amount_cents must be positive");
    if (!/^\d+\.\d{3}$/.test(req.note_rate_pct)) throw new RangeError(`note_rate_pct ${req.note_rate_pct} must have three decimals (6.125)`);
    const sheet = activeSheetAt(this.state.sheets, at); if (!sheet) throw new QuoteRefused("no_sheet", `no rate sheet in force at ${at}`);
    const { rows } = candidateRates(sheet, { product_code: req.product_code, term_months: 360, amortization: "fixed", lock_period_days: req.lock_period_days });
    const rate = rateFromPct(req.note_rate_pct); const p = rows.find((r) => r.note_rate === rate);
    if (!p) throw new QuoteRefused("price_not_on_sheet", `never invent a price: ${req.note_rate_pct}% at ${req.lock_period_days} days is not on sheet ${sheet.rate_sheet_id}`);
    return { ...req, quote_id: `q-${sheet.rate_sheet_id}-${rate}-${req.lock_period_days}-${Date.parse(at)}`, rate_sheet_id: sheet.rate_sheet_id, llpa_version: this.rateSheetAt(at).llpa_version, price_pct: p.price, points_pct: "0.000", lender_credit_pct: req.lender_credit_pct ?? "0.000", quoted_at: at, quote_ttl_minutes: this.quote_ttl_minutes, quote_id_fnma: p.pe_wl_quote_id ?? req.quote_id_fnma ?? null };
  }
}
