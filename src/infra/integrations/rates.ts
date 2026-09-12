/**
 * The daily rate source behind 20.4's rate sheet (`RateFeedPort`) — what src/runtime/refi-daily.ts publishes through
 * `20.4 publishRateSheet` at/after 06:30 ET every calendar day so 20.1's `SM_REFI_TRIGGER_DAILY` run prices against a
 * sheet of the day (spec 20.1 "Inputs and triggers": the run follows the rate-sheet snapshot `rate_sheet.published`).
 * The port answers 20.4's own price rows (`RateSheetPriceInput`: product, term, note rate on the 0.125 % grid, lock
 * period, price); nothing here prices a loan — 20.4's pass-through solve does, over the sheet this feed published.
 *
 *   FakeRateFeed   INTEGRATIONS=fake (the default, and the only adapter a test ever sees) — named FAKE. Deterministic:
 *                  the fixture grid of 20.1 worked example 1 / lifecycle.test.ts (6.375 → 101.875 … 5.875 → 99.750 for
 *                  the 30-year, a 15-year grid beside it), the same every day, so a daily run on the worked-example loan
 *                  reproduces the spec's figures (6.125 %, $3,402.62). `RATE_FEED_FAKE_SHIFT_BPS` (e.g. -25) moves the
 *                  whole grid for a demo that wants rates to fall.
 *   FredRateFeed   RATE_FEED=fred — the real thing: FRED's weekly MORTGAGE30US series (Freddie Mac PMMS, 30-year fixed
 *                  average) over https, no dependency beyond Node's `fetch`. `FRED_API_KEY` is optional: with a key the
 *                  JSON observations API answers the latest value; without one the public CSV download does. The
 *                  published rate becomes the par-ish centre of a five-rate grid on the 0.125 % grid with the fixture's
 *                  price steps (+0.500 per 0.125 %) — the same shape 20.4 solves over; the observation date rides on
 *                  every row (`pe_wl_quote_id = MORTGAGE30US:<date>`) so a sheet says which week it came from.
 *
 * `rateFeedFromEnv(env)` picks the adapter: only `RATE_FEED=fred` selects the real one; anything else is the FAKE.
 * The real adapter is never required by a test (no test sets RATE_FEED).
 */
import { TransientFailure, PermanentRejection } from "./failures.ts";
import type { RateSheetPriceInput, RateSheetSource } from "../../domain/leads-pricing/ops-20-4.ts";

export interface RateFeedPort {
  /** "FAKE" for the test double; the series name for a real source. */
  readonly vendorName: string;
  /** What 20.4 records as the sheet's `source`. */
  readonly source: RateSheetSource;
  /** The day's prices, as 20.4's `publishRateSheet` takes them. Throws TransientFailure when the source cannot be read. */
  fetchPrices(nowIso: string): Promise<readonly RateSheetPriceInput[]>;
}

/** The 0.125 % grid: a rate as a 3-dp string. */
export const toGrid = (rate: number): string => (Math.round(rate * 8) / 8).toFixed(3);
const price = (n: number): string => n.toFixed(3);
/** The fixture's 45-day best-efforts grid (20.1 worked example 1; src/runtime/borrower/fixtures/journey.ts PRICES): 30-year and 15-year fixed. */
export const FAKE_GRID_FRM30: readonly [string, string][] = [["6.375", "101.875"], ["6.250", "101.375"], ["6.125", "100.875"], ["6.000", "100.375"], ["5.875", "99.750"]];
export const FAKE_GRID_FRM15: readonly [string, string][] = [["5.750", "101.500"], ["5.625", "101.000"], ["5.500", "100.500"], ["5.375", "100.000"]];
const LOCK_DAYS = 45;
const rows = (grid: readonly [string, string][], product_code: string, term_months: number, shiftBps = 0, ref: string | null = null): RateSheetPriceInput[] =>
  grid.map(([r, p]) => ({ product_code, term_months, note_rate_pct: toGrid(Number(r) + shiftBps / 100), lock_period_days: LOCK_DAYS, price: p, ...(ref ? { pe_wl_quote_id: ref } : {}) }));

/** FAKE demo prices: the fixture grids, optionally shifted by whole 12.5-bps steps (the shape the fixtures' `grid45` builds). */
export function fakeDemoPrices(shiftBps = 0): readonly RateSheetPriceInput[] {
  const step = Math.round(shiftBps / 12.5) * 12.5;
  return [...rows(FAKE_GRID_FRM30, "FRM30", 360, step), ...rows(FAKE_GRID_FRM15, "FRM15", 180, step)];
}

export class FakeRateFeed implements RateFeedPort {
  readonly vendorName = "FAKE" as const;
  readonly source: RateSheetSource = "pe_whole_loan_api";
  private readonly shiftBps: number;
  readonly calls: string[] = [];
  constructor(opts: { shiftBps?: number } = {}) { this.shiftBps = opts.shiftBps ?? 0; }
  async fetchPrices(nowIso: string): Promise<readonly RateSheetPriceInput[]> { this.calls.push(nowIso); return fakeDemoPrices(this.shiftBps); }
}

/** A grid around a published average: the centre at the fixture's par-ish price, +0.500 per 0.125 % up, −0.500 down (the same slope the fixture grid carries). */
export function gridAround(centerRatePct: number, ref: string | null): readonly RateSheetPriceInput[] {
  const c = Number(toGrid(centerRatePct));
  const frm30: [string, string][] = [2, 1, 0, -1, -2].map((k) => [toGrid(c + k * 0.125), price(100.875 + k * 0.5)]);
  const frm15: [string, string][] = [1, 0, -1, -2].map((k) => [toGrid(c - 0.5 + k * 0.125), price(101.0 + k * 0.5)]);
  return [...rows(frm30, "FRM30", 360, 0, ref), ...rows(frm15, "FRM15", 180, 0, ref)];
}

export interface FredObservation { readonly date: string; readonly value: number; }
export interface FredRateFeedOptions { readonly apiKey?: string | undefined; readonly series?: string; readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number; }
export class FredRateFeed implements RateFeedPort {
  readonly vendorName: string;
  readonly source: RateSheetSource = "partner_rate_sheet";   // 20.4: a published external sheet, not the PE–Whole Loan API (never `manual_ui_read`, which is the operator's dual-entry act)
  private readonly apiKey: string;
  private readonly series: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(opts: FredRateFeedOptions = {}) {
    this.apiKey = (opts.apiKey ?? "").trim(); this.series = opts.series ?? "MORTGAGE30US"; this.fetchImpl = opts.fetchImpl ?? fetch; this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.vendorName = `FRED:${this.series}`;
  }
  /** The latest weekly observation on or before `nowIso`'s date (FRED publishes Thursdays; a "." value is a missing week). */
  async latest(nowIso: string): Promise<FredObservation> {
    const asOf = nowIso.slice(0, 10);
    const url = this.apiKey
      ? `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(this.series)}&api_key=${encodeURIComponent(this.apiKey)}&file_type=json&sort_order=desc&limit=8&observation_end=${asOf}`
      : `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(this.series)}`;
    let res: Response;
    try { res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: this.apiKey ? "application/json" : "text/csv" } }); }
    catch (e) { throw new TransientFailure(`${this.vendorName}: ${e instanceof Error ? e.message : String(e)}`, e); }
    if (!res.ok) throw new TransientFailure(`${this.vendorName}: HTTP ${res.status}`);
    const text = await res.text();
    const obs: FredObservation[] = [];
    if (this.apiKey) {
      const body = JSON.parse(text) as { observations?: { date: string; value: string }[] };
      for (const o of body.observations ?? []) if (o.value !== "." && Number.isFinite(Number(o.value))) obs.push({ date: o.date, value: Number(o.value) });
    } else {
      for (const line of text.split(/\r?\n/).slice(1)) { const [date, value] = line.split(","); if (date && value && value !== "." && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Number(value))) obs.push({ date, value: Number(value) }); }
    }
    const usable = obs.filter((o) => o.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
    const last = usable.at(-1);
    if (!last) throw new PermanentRejection("FRED_NO_OBSERVATION", `${this.vendorName}: no observation on or before ${asOf}`, []);
    if (last.value < 1 || last.value > 20) throw new PermanentRejection("FRED_VALUE_OUT_OF_RANGE", `${this.vendorName}: ${last.value} on ${last.date} is not a mortgage rate`, []);
    return last;
  }
  async fetchPrices(nowIso: string): Promise<readonly RateSheetPriceInput[]> { const o = await this.latest(nowIso); return gridAround(o.value, `${this.series}:${o.date}`); }
}

/** The adapter the environment names: `RATE_FEED=fred` (with an optional `FRED_API_KEY`) is the real source; everything else — INTEGRATIONS=fake included — is the FAKE. */
export function rateFeedFromEnv(env: NodeJS.ProcessEnv = process.env): RateFeedPort {
  if ((env["RATE_FEED"] ?? "").trim().toLowerCase() === "fred") return new FredRateFeed({ apiKey: env["FRED_API_KEY"], ...(env["FRED_SERIES"] ? { series: env["FRED_SERIES"] } : {}) });
  const shift = Number(env["RATE_FEED_FAKE_SHIFT_BPS"] ?? 0);
  return new FakeRateFeed({ shiftBps: Number.isFinite(shift) ? shift : 0 });
}
