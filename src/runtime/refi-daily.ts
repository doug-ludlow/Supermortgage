/**
 * The daily refinance check (§20.1 "Inputs and triggers": "Schedule: `SM_REFI_TRIGGER_DAILY` at 06:30 ET after the
 * rate-sheet snapshot `rate_sheet.published` (20.4) — one run per partner program per day") as a runtime pass the sweep
 * takes every minute (src/runtime/app.ts Runtime.sweep, before its breach pass; the Cloud Run job and POST /v1/sweep both
 * go through it). Once per calendar day (America/New_York), at/after 06:30 ET:
 *
 *   1. the day's rate sheet — the rate feed's prices (src/infra/integrations/rates.ts: the FAKE, or FRED behind
 *      RATE_FEED=fred) published through `20.4 publishRateSheet` as `rs-<date>-<vendor>`; idempotent per day (a sheet of
 *      that id is not published twice); `rate_sheet.published` arms the day's SM_REFI_TRIGGER_DAILY (global subject —
 *      src/domain/leads-pricing/timers-20-1.ts);
 *   2. the universe — every active loan of `v_refi_universe` (rule 1; investor-blind by construction — the pass refuses
 *      if the view exposes an investor column, as ops-20-1 assertInvestorBlind does per row), joined at run time to what
 *      the view comment says joins there: the ledger's principal balance, the unpaid installments (delinquency), the
 *      boarding flags (bankruptcy / foreclosure / loss-mitigation / SII), transfer-out, the escrow lines, the origination
 *      record's value and score, and the vendor facts the servicing tables never carry (the AVM / indexed value, the
 *      representative score on file, county limit, MI, title date) from the loan's latest `refi_universe` row — else a
 *      FAKE fallback the spec names (indexed origination value at `confidence=low`, which suppresses > 90 % LTV). Rows
 *      that changed reach the store through `20.1 loadUniverse{op=load_row}` (the investor-field guardrail); the gate
 *      facts (29.4's `loan.purchased{purchase_date}`, the last decline, the offer history) ride inline on the run;
 *   3. `20.1 emitOfferReady{op=run, trigger_kind=scheduled}` per partner program (`run-<date>-<program>`), then
 *      `20.1 writeDecision` per opportunity the run wrote (the agent_decisions row with rule_ref "20.1 rules 1–9");
 *      `refi.trigger.run_completed` satisfies SM_REFI_TRIGGER_DAILY (and re-arms it for tomorrow); a run that cannot
 *      start (no sheet, no matrix) is reported and the clock breaches at 06:30 tomorrow — sev 3 → compliance-sentinel,
 *      the spec's own breach action;
 *   4. one log line: loans in the universe, evaluated, offers, suppressed by reason.
 *
 * Scopes: the run is one global command over the whole book (the program is the partner's), reading the rows inline;
 * the `refi_universe` row and the `refi_gate_facts` row of a loan are written loan-scoped (`load_row` executed for the
 * loan — an entity row whose data names a loan is that loan's, src/infra/db/entities.ts), as are the `refi_opportunities`
 * rows the run writes (their data names the loan), so every loan-scoped read (the 32.11 flow, the borrower record, the
 * fixtures' own loan-scoped commands) sees them and versions never collide. Money is bigint cents; dates are PlainDate;
 * the run's figures are the engine's, never this file's.
 */
import { wallClock, zonedEpochMs, toIso } from "../kernel/calendar/zoned.ts";
import { plainDate as D, addDays, addMonths, daysBetween, type PlainDate } from "../kernel/calendar/date.ts";
import type { Actor } from "../kernel/events/index.ts";
import type { Cents } from "../kernel/money/cents.ts";
import { EntityStore } from "../app/tools.ts";
import { decodeEntityData } from "../infra/db/entities.ts";
import type { RateFeedPort } from "../infra/integrations/rates.ts";
import { INTAKE_AGENT, INVESTOR_FIELDS, NO_GATE_FACTS, RefiRefused, assertInvestorBlind, scheduledUpb, monthsBetween, type GateFacts, type PartnerProgram, type UniverseLoan, type ValueEstimate, type MiStatus } from "../domain/leads-pricing/ops-20-1.ts";
import { activeSheetAt, type RateSheet, type Occupancy, type PropertyType } from "../domain/leads-pricing/ops-20-4.ts";
import type { Runtime } from "./app.ts";
import type { Logger } from "./log.ts";

export const ET = "America/New_York";
/** The spec's schedule: 06:30 America/New_York (20.1 timer table, anchor of SM_REFI_TRIGGER_DAILY). */
export const RUN_AT_ET = "06:30";
/** The sheet published here stays in force until the next morning's publish (07:00 ET next day; the 06:30 run finds it). */
export const SHEET_EXPIRES_AT_ET = "07:00";
export const PRICING_AGENT: Actor = { kind: "agent", id: "pricing" };
export const DAILY_RUN_PREFIX = "run-";

type Row = Record<string, unknown>;
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
/** Stable JSON for change detection (bigint → string, sorted keys). */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Row).sort(([a], [b]) => a.localeCompare(b))) : x));
export const sheetIdFor = (asOf: PlainDate, vendorName: string): string => `rs-${asOf}-${vendorName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
export const runIdFor = (asOf: PlainDate, programId: string): string => `${DAILY_RUN_PREFIX}${asOf}-${programId}`;

export interface RefiDailyProgramRun {
  readonly program_id: string; readonly partner_id: string; readonly run_id: string; readonly loans: number;
  readonly loans_in_universe: number; readonly loans_evaluated: number; readonly opportunities_detected: number; readonly suppressed_by_reason: Readonly<Record<string, number>>;
  readonly reused: number; readonly offer_ready: readonly string[]; readonly decisions: number; readonly error: string | null;
}
export interface RefiDailyReport {
  readonly at: string; readonly as_of_date: PlainDate; readonly ran: boolean; readonly reason: string | null;
  readonly rate_sheet: { rate_sheet_id: string; published: boolean; source: string; price_count: number } | null;
  readonly universe: { view_rows: number; loaded: number; unchanged: number; skipped: readonly { loan_id: string; reason: string }[] };
  readonly programs: readonly RefiDailyProgramRun[];
  readonly line: string;
}
export interface RefiDailyOptions { readonly feed: RateFeedPort; readonly logger?: Logger | undefined; /** run regardless of the wall clock (tests) */ readonly force?: boolean }

const skipped = (nowIso: string, asOf: PlainDate, reason: string, extra: Partial<RefiDailyReport> = {}): RefiDailyReport => ({ at: nowIso, as_of_date: asOf, ran: false, reason, rate_sheet: null, universe: { view_rows: 0, loaded: 0, unchanged: 0, skipped: [] }, programs: [], line: `refi daily ${asOf}: not run (${reason})`, ...extra });

/** Has `program_id` completed a run for `asOf` (any scope — the fixture's loan-scoped runs count too)? */
export async function ranToday(rt: Runtime, asOf: PlainDate, programId: string): Promise<boolean> {
  return (await rt.db.query<{ n: string }>(`SELECT 1 AS n FROM loan_events WHERE type = 'refi.trigger.run_completed' AND payload->>'as_of_date' = $1 AND payload->>'program_id' = $2 LIMIT 1`, [asOf, programId])).length > 0;
}

export async function refiDailyRun(rt: Runtime, nowIso: string, opts: RefiDailyOptions): Promise<RefiDailyReport> {
  const wc = wallClock(Date.parse(nowIso), ET); const asOf = wc.date;
  const [hh, mm] = RUN_AT_ET.split(":").map(Number) as [number, number];
  if (!opts.force && wc.hour * 60 + wc.minute < hh * 60 + mm) return skipped(nowIso, asOf, `before ${RUN_AT_ET} ET`);
  const store = new EntityStore(); store.seed(await rt.entities.load({}));
  const programs = store.list("partner_programs").map((r) => r.data as unknown as PartnerProgram);
  if (!programs.length) return skipped(nowIso, asOf, "no partner_programs row (20.1 loadUniverse{op=register_program})");
  const due: PartnerProgram[] = [];
  for (const p of programs) if (!(await ranToday(rt, asOf, p.program_id))) due.push(p);
  if (!due.length) return skipped(nowIso, asOf, "already ran today");
  const log = opts.logger;

  // 1. the day's sheet (once): the feed's prices through 20.4's own publish; an active sheet of the day published by someone else is used as is
  const sheets = store.list("rate_sheets").map((r) => r.data as unknown as RateSheet);
  const sheetId = sheetIdFor(asOf, opts.feed.vendorName);
  let rate_sheet: RefiDailyReport["rate_sheet"] = null;
  const existing = sheets.find((x) => x.rate_sheet_id === sheetId);
  if (existing) rate_sheet = { rate_sheet_id: existing.rate_sheet_id, published: false, source: existing.source, price_count: existing.prices.length };
  else {
    let prices: Awaited<ReturnType<RateFeedPort["fetchPrices"]>>;
    try { prices = await opts.feed.fetchPrices(nowIso); }
    catch (e) {
      const active = activeSheetAt(sheets, nowIso);
      log?.warn("refi daily: rate feed unavailable", { vendor: opts.feed.vendorName, error: e instanceof Error ? e.message : String(e), active_sheet: active?.rate_sheet_id ?? null });
      if (!active) return skipped(nowIso, asOf, `rate feed ${opts.feed.vendorName} unavailable and no sheet in force (run skipped, sev 3: SM_REFI_TRIGGER_DAILY breaches)`);
      rate_sheet = { rate_sheet_id: active.rate_sheet_id, published: false, source: active.source, price_count: active.prices.length }; prices = [];
    }
    if (!rate_sheet) {
      const expires = toIso(zonedEpochMs(addDays(asOf, 1), SHEET_EXPIRES_AT_ET, ET));
      const r = await rt.execute({ process: "20.4", name: "publishRateSheet", loanId: "", actor: PRICING_AGENT, input: { rate_sheet_id: sheetId, partner_id: due[0]!.partner_id, source: opts.feed.source, published_at: nowIso, expires_at: expires, prices, published_by: `${opts.feed.vendorName} feed (daily 06:30 ET run)` } });
      const o = r.output as { rate_sheet_id: string; source: string; price_count: number };
      rate_sheet = { rate_sheet_id: o.rate_sheet_id, published: true, source: o.source, price_count: o.price_count };
    }
  }

  // 2. the universe from the view
  const u = await universeFromView(rt, asOf);
  const universe = { view_rows: u.rows.length, loaded: 0, unchanged: 0, skipped: [...u.skipped] as { loan_id: string; reason: string }[] };
  const currentRows = new Map(u.currentRows.map((r) => [r.id, canon(r.data)]));
  const loaded: UniverseLoan[] = [];
  for (const row of u.rows) {
    if (currentRows.get(row.loan_id) === canon(row)) { universe.unchanged += 1; loaded.push(row); continue; }
    try {
      await rt.execute({ process: "20.1", name: "loadUniverse", loanId: row.loan_id, actor: INTAKE_AGENT, input: { op: "load_row", loan_id: row.loan_id, row, program_id: due[0]!.program_id, gate_facts: u.facts[row.loan_id] ?? NO_GATE_FACTS } });
      universe.loaded += 1; loaded.push(row);
    } catch (e) { universe.skipped.push({ loan_id: row.loan_id, reason: `load_row refused: ${e instanceof Error ? e.message : String(e)}` }); }
  }

  // 3. one run per partner program (the partner's own loans — rule 6), then the decision rows
  const programsOut: RefiDailyProgramRun[] = [];
  for (const p of due) {
    const mine = loaded.filter((l) => l.partner_id === p.partner_id);
    const run_id = runIdFor(asOf, p.program_id);
    try {
      const r = await rt.execute({ process: "20.1", name: "emitOfferReady", loanId: "", actor: INTAKE_AGENT, input: { op: "run", run_id, trigger_kind: "scheduled", program_id: p.program_id, as_of_date: asOf, at: nowIso, loans: mine, gate_facts: Object.fromEntries(mine.map((l) => [l.loan_id, u.facts[l.loan_id] ?? NO_GATE_FACTS])) } });
      const o = r.output as { loans_in_universe: number; loans_evaluated: number; opportunities_detected: number; suppressed_by_reason: Record<string, number>; reused: string[]; opportunities: { opportunity_id: string; loan_id: string; status: string }[] };
      let decisions = 0;
      for (const opp of o.opportunities) {
        if (o.reused.includes(opp.opportunity_id)) continue;
        // the opportunity row is the loan's (its data names the loan): the decision is written in the loan's scope, where the row is read back
        try { await rt.execute({ process: "20.1", name: "writeDecision", loanId: opp.loan_id, actor: INTAKE_AGENT, input: { opportunity_id: opp.opportunity_id, model_version: "refi-daily (deterministic)", prompt_version: "20.1-v1", confidence: 1 } }); decisions += 1; }
        catch (e) { log?.warn("refi daily: decision row refused", { opportunity_id: opp.opportunity_id, error: e instanceof Error ? e.message : String(e) }); }
      }
      programsOut.push({ program_id: p.program_id, partner_id: p.partner_id, run_id, loans: mine.length, loans_in_universe: o.loans_in_universe, loans_evaluated: o.loans_evaluated, opportunities_detected: o.opportunities_detected, suppressed_by_reason: o.suppressed_by_reason, reused: o.reused.length, offer_ready: o.opportunities.filter((x) => x.status === "offer_ready").map((x) => x.opportunity_id), decisions, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log?.error("refi daily: run refused", { program_id: p.program_id, run_id, error: msg });
      programsOut.push({ program_id: p.program_id, partner_id: p.partner_id, run_id, loans: mine.length, loans_in_universe: 0, loans_evaluated: 0, opportunities_detected: 0, suppressed_by_reason: {}, reused: 0, offer_ready: [], decisions: 0, error: msg });
    }
  }

  // 4. the one-line report
  const inUniverse = programsOut.reduce((a, p) => a + p.loans_in_universe, 0); const evaluated = programsOut.reduce((a, p) => a + p.loans_evaluated, 0); const offers = programsOut.reduce((a, p) => a + p.opportunities_detected, 0);
  const suppressed: Record<string, number> = {}; for (const p of programsOut) for (const [k, v] of Object.entries(p.suppressed_by_reason)) suppressed[k] = (suppressed[k] ?? 0) + v;
  const errors = programsOut.filter((p) => p.error).map((p) => `${p.program_id}: ${p.error}`);
  const line = `refi daily ${asOf}: sheet=${rate_sheet?.rate_sheet_id ?? "none"}${rate_sheet?.published ? " (published)" : ""} programs=${programsOut.length} view_rows=${universe.view_rows} loaded=${universe.loaded} unchanged=${universe.unchanged} skipped=${universe.skipped.length} universe=${inUniverse} evaluated=${evaluated} offers=${offers} suppressed=${JSON.stringify(suppressed)}${errors.length ? ` errors=${JSON.stringify(errors)}` : ""}`;
  log?.info("refi daily run", { at: nowIso, as_of_date: asOf, rate_sheet, universe: { ...universe, skipped: universe.skipped.length }, programs: programsOut, line });
  return { at: nowIso, as_of_date: asOf, ran: true, reason: null, rate_sheet, universe, programs: programsOut, line };
}

// ---------------------------------------------------------------- the universe: v_refi_universe + the run-time joins
export interface UniverseFromView { readonly rows: UniverseLoan[]; readonly facts: Record<string, GateFacts>; readonly skipped: { loan_id: string; reason: string }[]; readonly currentRows: { id: string; data: Row }[] }
const occupancyOf = (v: unknown): Occupancy => { const x = String(v ?? "").toLowerCase(); return x === "second_home" || x === "second" ? "second_home" : x === "investment" || x === "investor" ? "investment" : "primary"; };
const propertyTypeOf = (v: unknown): PropertyType => { const x = String(v ?? "sfr").toLowerCase(); return (["sfr", "pud", "condo", "coop", "manufactured_home"] as const).find((t) => t === x) ?? (x === "manufactured" ? "manufactured_home" : "sfr"); };
const unitsOf = (v: unknown): 1 | 2 | 3 | 4 => { const n = Number(v ?? 1); return n === 2 || n === 3 || n === 4 ? n : 1; };
const ratePct = (bps: unknown): string => (Number(bps ?? 0) / 10_000).toFixed(3);   // loan_terms.note_rate_bps is ×10 (6.375 % = 63750; 0001_baseline)
const TAX_TYPES = new Set(["county_tax", "city_tax", "school_tax", "other_tax"]); const INS_TYPES = new Set(["hazard", "flood", "wind", "earthquake"]);

/** Every active loan of the investor-blind view with its run-time joins; refuses if the view exposes an investor column. */
export async function universeFromView(rt: Runtime, asOf: PlainDate): Promise<UniverseFromView> {
  const cols = (await rt.db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'v_refi_universe'`)).map((r) => r.column_name);
  const bad = cols.filter((k) => INVESTOR_FIELDS.includes(k));
  if (bad.length) throw new RefiRefused("investor_field_visible", `v_refi_universe exposes ${bad.join(", ")} — the trigger's read model is investor-blind by construction (B2-1.3-04); the run cannot start`);
  const view = await rt.db.query<Row>(`SELECT loan_id::text AS loan_id, partner_id::text AS partner_id, status::text AS status, note_date::text AS note_date, consummation_date::text AS consummation_date, first_payment_date::text AS first_payment_date, original_upb_cents::text AS original_upb_cents, original_term_months, amortization::text AS amortization, note_rate_bps, pi_cents::text AS pi_cents, escrow_monthly_cents::text AS escrow_monthly_cents, escrowed, remaining_term_months, maturity_date::text AS maturity_date, property_state, county, occupancy, property_type, units, refi_do_not_solicit, refi_last_offered_at, refi_offers_12m FROM v_refi_universe ORDER BY loan_id`);
  const ids = view.map((r) => String(r["loan_id"]));
  const skippedOut: { loan_id: string; reason: string }[] = [];
  if (!ids.length) return { rows: [], facts: {}, skipped: skippedOut, currentRows: [] };
  const [principal, installments, flags, loansExtra, purchased, origValues, origScores, escrow, vendorRows, factRows] = await Promise.all([
    rt.db.query<Row>(`SELECT loan_id::text AS loan_id, sum(amount_cents)::text AS s FROM ledger_lines WHERE scope = 'loan' AND account = 'principal' AND loan_id = ANY($1::uuid[]) GROUP BY loan_id`, [ids]),
    rt.db.query<Row>(`SELECT loan_id::text AS loan_id, min(due_date)::text AS due FROM loan_installments WHERE status = 'due' AND loan_id = ANY($1::uuid[]) GROUP BY loan_id`, [ids]),
    rt.db.query<Row>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, bk_active, fc_active, lossmit_in_process, sii_present FROM transfer_batch_loans WHERE loan_id = ANY($1::uuid[]) ORDER BY loan_id, created_at DESC`, [ids]).catch(() => [] as Row[]),
    rt.db.query<Row>(`SELECT id::text AS loan_id, transfer_out_at::text AS transfer_out_at, regx_days_delinquent_at_boarding FROM loans WHERE id = ANY($1::uuid[])`, [ids]),
    rt.db.query<Row>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, payload->>'purchase_date' AS purchase_date FROM loan_events WHERE type = 'loan.purchased' AND loan_id = ANY($1::uuid[]) ORDER BY loan_id, sequence DESC`, [ids]),
    rt.db.query<Row>(`SELECT DISTINCT ON (a.loan_id) a.loan_id::text AS loan_id, ap.estimated_value_cents::text AS value_cents, a.created_at::text AS created_at FROM applications a JOIN application_properties ap ON ap.application_id = a.id AND ap.is_subject WHERE a.loan_id = ANY($1::uuid[]) AND ap.estimated_value_cents IS NOT NULL ORDER BY a.loan_id, a.created_at DESC`, [ids]).catch(() => [] as Row[]),
    rt.db.query<Row>(`SELECT DISTINCT ON (a.loan_id) a.loan_id::text AS loan_id, cr.representative_score FROM credit_reports cr JOIN applications a ON a.id = cr.application_id WHERE a.loan_id = ANY($1::uuid[]) AND cr.representative_score IS NOT NULL ORDER BY a.loan_id, cr.report_date DESC`, [ids]).catch(() => [] as Row[]),
    rt.db.query<Row>(`SELECT ea.loan_id::text AS loan_id, el.line_type::text AS line_type, sum(el.annual_amount_cents)::text AS s FROM escrow_lines el JOIN escrow_accounts ea ON ea.id = el.escrow_account_id WHERE el.active AND ea.loan_id = ANY($1::uuid[]) GROUP BY ea.loan_id, el.line_type`, [ids]).catch(() => [] as Row[]),
    rt.db.query<Row>(`SELECT id, data, loan_id::text AS loan_id FROM entity_current WHERE kind = 'refi_universe' AND id = ANY($1::text[])`, [ids]),
    rt.db.query<Row>(`SELECT id, data FROM entity_current WHERE kind = 'refi_gate_facts' AND id = ANY($1::text[])`, [ids]),
  ]);
  const by = <T extends Row>(rows: readonly T[]): Map<string, T> => new Map(rows.map((r) => [String(r["loan_id"]), r]));
  const principalBy = by(principal), instBy = by(installments), flagsBy = by(flags), extraBy = by(loansExtra), purchasedBy = by(purchased), valueBy = by(origValues), scoreBy = by(origScores);
  const escrowBy = new Map<string, { taxes: Cents; insurance: Cents }>();
  for (const r of escrow) { const id = String(r["loan_id"]); const cur = escrowBy.get(id) ?? { taxes: 0n, insurance: 0n }; const t = String(r["line_type"]); if (TAX_TYPES.has(t)) cur.taxes += c(r["s"]); if (INS_TYPES.has(t)) cur.insurance += c(r["s"]); escrowBy.set(id, cur); }
  const vendorBy = new Map(vendorRows.map((r) => [String(r["id"]), decodeEntityData(r["data"]) as Row]));
  const factsBy = new Map(factRows.map((r) => [String(r["id"]), decodeEntityData(r["data"]) as Row]));
  // the loan's current row (entity_current: the latest version whatever scope wrote it) is what a change is measured against
  const currentRows = [...vendorBy.entries()].map(([id, data]) => ({ id, data }));

  const rows: UniverseLoan[] = []; const facts: Record<string, GateFacts> = {};
  for (const v of view) {
    const loan_id = String(v["loan_id"]);
    try {
      const vendor = vendorBy.get(loan_id) ?? {};
      const first = dateOf(v["first_payment_date"]); const note = dateOf(v["note_date"]) ?? first; const originalTerm = Number(v["original_term_months"] ?? 360);
      if (!first || !note) throw new RangeError("no first_payment_date / note_date");
      // the next unpaid installment: the earliest `due` row when 2.1 projected the loan; else the first installment after as-of (current)
      const unpaid = dateOf(instBy.get(loan_id)?.["due"]);
      let next_due_date: PlainDate;
      if (unpaid) next_due_date = unpaid;
      else { const k = Math.max(0, monthsBetween(first, asOf)); const cand = addMonths(first, k); next_due_date = cand <= asOf ? addMonths(first, k + 1) : cand; }
      const payments_made = Math.max(0, Math.min(originalTerm, monthsBetween(first, next_due_date)));
      const remaining_term_months = Math.max(0, originalTerm - payments_made);
      const note_rate_pct = ratePct(v["note_rate_bps"]); const original_upb_cents = c(v["original_upb_cents"]);
      const ledgerPrincipal = c(principalBy.get(loan_id)?.["s"]);
      const upb_cents = ledgerPrincipal > 0n ? ledgerPrincipal : scheduledUpb(original_upb_cents, note_rate_pct, originalTerm, payments_made);
      const regx_days_delinquent = unpaid && unpaid < asOf ? daysBetween(unpaid, asOf) : 0;
      const f = flagsBy.get(loan_id) ?? {}; const x = extraBy.get(loan_id) ?? {};
      const escrowed = v["escrowed"] === true; const escrow_monthly_cents = c(v["escrow_monthly_cents"]);
      const esc = escrowBy.get(loan_id);
      const vendorValue = vendor["value_estimate"] as Row | undefined;
      const value_estimate: ValueEstimate = vendorValue && vendorValue["value_cents"] !== undefined ? { source: (vendorValue["source"] as ValueEstimate["source"]) ?? "avm", value_cents: c(vendorValue["value_cents"]), as_of: (s(vendorValue["as_of"]) as PlainDate | null) ?? asOf, confidence: (vendorValue["confidence"] as ValueEstimate["confidence"]) ?? "medium" }
        : valueBy.get(loan_id) ? { source: "origination_indexed", value_cents: c(valueBy.get(loan_id)!["value_cents"]), as_of: asOf, confidence: "medium" }
        : { source: "origination_indexed", value_cents: (original_upb_cents * 100n) / 80n, as_of: asOf, confidence: "low" };   // FAKE fallback: an 80 % LTV origination, unindexed — `confidence=low` widens the band (> 90 % suppressed)
      const amortization: UniverseLoan["amortization"] = String(v["amortization"] ?? "fixed").startsWith("arm") ? "arm" : "fixed";
      const row: UniverseLoan = {
        loan_id, partner_id: String(v["partner_id"]), status: "active", product_code: s(vendor["product_code"]) ?? (amortization === "arm" ? "ARM" : `FRM${Math.round(originalTerm / 12)}`), amortization,
        note_date: note, first_payment_date: first, consummation_date: dateOf(v["consummation_date"]) ?? note, title_date: (dateOf(vendor["title_date"]) ?? dateOf(v["consummation_date"]) ?? note),
        original_upb_cents, original_term_months: originalTerm, note_rate_pct, pi_cents: c(v["pi_cents"]), payments_made, upb_cents, next_due_date, remaining_term_months,
        escrowed, escrow_monthly_cents, net_escrow_deposit_estimate_cents: vendor["net_escrow_deposit_estimate_cents"] !== undefined ? c(vendor["net_escrow_deposit_estimate_cents"]) : escrowed ? escrow_monthly_cents * 2n : 0n,
        taxes_annual_cents: esc && esc.taxes > 0n ? esc.taxes : vendor["taxes_annual_cents"] !== undefined && vendor["taxes_annual_cents"] !== null ? c(vendor["taxes_annual_cents"]) : null,
        insurance_annual_cents: esc && esc.insurance > 0n ? esc.insurance : vendor["insurance_annual_cents"] !== undefined && vendor["insurance_annual_cents"] !== null ? c(vendor["insurance_annual_cents"]) : null,
        mi_status: (s(vendor["mi_status"]) as MiStatus | null) ?? "none", mi_monthly_cents: c(vendor["mi_monthly_cents"]),
        occupancy: occupancyOf(v["occupancy"] ?? vendor["occupancy"]), property_type: propertyTypeOf(v["property_type"] ?? vendor["property_type"]), units: unitsOf(v["units"] ?? vendor["units"]),
        property_state: String(v["property_state"] ?? vendor["property_state"] ?? "XX"), county: s(v["county"]) ?? s(vendor["county"]) ?? "", county_limit_cents: vendor["county_limit_cents"] !== undefined && vendor["county_limit_cents"] !== null ? c(vendor["county_limit_cents"]) : null,
        value_estimate, representative_score: typeof vendor["representative_score"] === "number" ? vendor["representative_score"] : scoreBy.get(loan_id) ? Number(scoreBy.get(loan_id)!["representative_score"]) : null, score_source: "origination_file",
        regx_days_delinquent, bankruptcy_active: f["bk_active"] === true, foreclosure_referred: f["fc_active"] === true, lossmit_plan_active: f["lossmit_in_process"] === true, deceased_or_sii_pending: f["sii_present"] === true, transfer_out_pending: x["transfer_out_at"] !== null && x["transfer_out_at"] !== undefined,
        refi_do_not_solicit: v["refi_do_not_solicit"] === true, refi_last_offered_at: s(v["refi_last_offered_at"]), refi_offers_12m: Number(v["refi_offers_12m"] ?? 0), arm_first_adjustment_date: dateOf(vendor["arm_first_adjustment_date"]),
      };
      assertInvestorBlind(row as unknown as Row);
      rows.push(row);
      const prior = factsBy.get(loan_id) ?? {};
      facts[loan_id] = { fnma_purchase_date: dateOf(purchasedBy.get(loan_id)?.["purchase_date"]) ?? dateOf(prior["fnma_purchase_date"]), declined_on: dateOf(prior["declined_on"]), offered_at: Array.isArray(prior["offered_at"]) ? (prior["offered_at"] as string[]) : [] };
    } catch (e) { skippedOut.push({ loan_id, reason: e instanceof Error ? e.message : String(e) }); }
  }
  return { rows, facts, skipped: skippedOut, currentRows };
}
