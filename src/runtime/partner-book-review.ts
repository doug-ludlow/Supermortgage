/**
 * §33.2 — the daily refinance review of the partner book (spec/sections/33-partner-book/33-2-*.md), as the runtime pass
 * the sweep takes after the daily refinance check (src/runtime/app.ts Runtime.sweep → refiDailyRun → partnerBookReviewRun).
 * Once per calendar day (America/New_York), at/after 07:00 ET, per partner program (`run_id = review-<as_of>-<program>`):
 *
 *   rule 1  the facts into the universe — `monitoredUniverseRows` builds 20.1's UniverseLoan per monitored loan from the
 *           LATEST partner_book_facts row (balance, next due date and delinquency, value with source and confidence, the
 *           partner's FICO as `representative_score{score_source=partner_file}`, MI, ARM, the bk/fc/modification/servicing
 *           flags) and the loan's own properties/terms columns of `v_refi_universe` — never ledger, installments or transfer
 *           rows; 20.1's own investor-blind and prohibited-basis check (assertInvestorBlind) runs on every row before it is
 *           returned. src/runtime/refi-daily.ts universeFromView takes these rows beside the serviced ones and loads them
 *           through `20.1 loadUniverse{op=load_row}`; 20.1's run evaluates them like any other loan (rule 2).
 *   rule 3  the review — per loan per day one `partner_book_reviews` row: the verdict by the state-machine mapping over
 *           the day's opportunity row (`verdictOf`), `reasons` = the engine's suppression reasons or the fire rule's satisfied
 *           conditions, `facts` = the engine's inputs and outputs copied (`reviewFactsOf`; `watch_rate_pct` for `watching`),
 *           the `review.write` decision (agent `refi-analyst`, rule set sm.refi_trigger.v1+partner_book.review.v1) and
 *           `partner_book.review.written` (loan-scoped, origination: true) — one transaction per loan (`writeReview`).
 *   rule 4  the analyst's turn per loan (src/runtime/partner-book-analyst.ts analystTurn) — skipped, never the review, when
 *           the model is off, rate-limited, refused, or the pass's cap is reached; `analyst.skipped` on the row.
 *   rules 5–6  offer delivery and expiry (src/runtime/partner-book-offers.ts) after the reviews of the day.
 *   then    `partner_book.review.run_completed{as_of_date, reviewed, candidates, watching, not_now, excluded, analyst_turns,
 *           analyst_skipped, origination}` (global) — SM_PARTNER_BOOK_REVIEW_DAILY's trigger and satisfying event
 *           (src/domain/partner-book/timers-33-2.ts: the day's clock on the global subject, anchor as_of_date + 1 day 07:00 ET).
 *
 * Idempotent per day: a program whose run_completed for the as-of date exists is not reviewed twice; a loan whose review
 * row for the day exists is counted, not rewritten (UNIQUE (loan_id, as_of_date)). The review needs the day's 20.1 run
 * (`refi.trigger.run_completed{as_of_date, program_id}`): without it the pass reports and the clock breaches tomorrow.
 * The analyst never decides: the verdict, the rate and every figure are the engine's, copied here. Money is bigint cents in
 * memory and decimal-string cents on the row; dates are PlainDate.
 */
import { randomUUID } from "node:crypto";
import { wallClock } from "../kernel/calendar/zoned.ts";
import { plainDate as D, addMonths, daysBetween, type PlainDate } from "../kernel/calendar/date.ts";
import { type Cents, centsToDecimal, ratePercent } from "../kernel/money/cents.ts";
import { Decimal } from "../kernel/money/decimal.ts";
import type { Actor } from "../kernel/events/index.ts";
import { toJson, type Queryable } from "../infra/db/client.ts";
import { decodeEntityData } from "../infra/db/entities.ts";
import type { DecisionInput } from "../infra/db/decisions.ts";
import { EntityStore } from "../app/tools.ts";
import { assertInvestorBlind, ltvOf, type PartnerProgram, type RefiOpportunity, type UniverseLoan, type ValueEstimate, type MiStatus } from "../domain/leads-pricing/ops-20-1.ts";
import type { Occupancy, PropertyType } from "../domain/leads-pricing/ops-20-4.ts";
import { monthsBetween } from "../domain/partner-book/import.ts";
import type { Fact } from "../domain/partner-book/profiles/m3-v1.ts";
import { ANALYST_MAX_PER_DAY, analystTurn, type AnalystLlm, type AnalystTurnResult } from "./partner-book-analyst.ts";
import { heldLoanIds } from "./partner-book.ts";
import { deliverOffers, expireOffers, openOffersOf } from "./partner-book-offers.ts";
import type { Runtime } from "./app.ts";
import type { Logger } from "./log.ts";

export const ET = "America/New_York";
/** The spec's schedule: 07:00 America/New_York, after 20.1's 06:30 run ("Trigger & frequency"). */
export const REVIEW_AT_ET = "07:00";
export const REVIEW_RUN_PREFIX = "review-";
export const REFI_ANALYST = "refi-analyst";
export const REFI_ANALYST_AGENT: Actor = { kind: "agent", id: REFI_ANALYST };
/** The decision record's rule set (rule 3): 20.1's selection rule set plus this process's review rules. */
export const REVIEW_RULE_SET_VERSION = "sm.refi_trigger.v1+partner_book.review.v1";
export const REVIEW_RULE_CODE = "33.2 rules 1–6";
/** A partner value within 12 months of the as-of date is `medium` confidence, older `low`; beyond 24 months the review is `not_now` (open question 1's default). */
export const VALUE_MEDIUM_MONTHS = 12;
export const VALUE_STALE_MONTHS = 24;
/** A candidate's reasons: the fire rule's satisfied conditions (rule 3). */
export const CANDIDATE_REASONS: readonly string[] = ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen", "state_rule"];
/** 20.1's exclusions (loadUniverse) → `excluded`; its solicitation gates → `not_now`. */
export const EXCLUSION_REASONS: readonly string[] = ["not_active", "bankruptcy_active", "foreclosure_referred", "lossmit_plan_active", "deceased_or_sii_pending", "transfer_out_pending", "delinquent"];
export const NOT_NOW_REASONS: readonly string[] = ["cooldown", "frequency_cap", "premium_recapture_window", "marketing_suppression"];
/** 20.1 evaluateLoan's reason for a candidate pricing refused outright (`pricing_refused:<code|message>`, e.g. no cost schedule for the loan's state) → `not_now` (state machine). */
export const PRICING_REFUSED_PREFIX = "pricing_refused";
const CANDIDATE_STATUSES = new Set(["offer_ready", "offered", "engaged", "converted"]);

export type ReviewVerdict = "candidate" | "watching" | "not_now" | "excluded";
export type ReviewFacts = {
  note_rate_pct: string; candidate_rate_pct: string | null; rate_delta_bps: number | null; upb_cents: string; value_cents: string; value_source: "partner_fmv" | "partner_bpo" | "partner_appraisal"; value_as_of: string; value_confidence: "medium" | "low";
  ltv: string; remaining_term_months: number; pi_cents: string; candidate_pi_cents: string | null; candidate_loan_amount_cents: string | null; monthly_delta_cents: string | null; npv_cents: string | null; breakeven_months: number | null; seven_year_delta_cents: string | null;
  days_delinquent: number; flags: string[]; watch_rate_pct?: string;
};
/** One loan's review of the day as the engine's rows determine it (rule 3), before the analyst's turn. */
export interface Review {
  readonly loan_id: string; readonly party_id: string | null; readonly as_of_date: PlainDate; readonly program_id: string; readonly opportunity_id: string | null; readonly opportunity_status: string | null;
  readonly verdict: ReviewVerdict; readonly reasons: string[]; readonly facts: ReviewFacts;
  /** The engine's own explanation text (20.1 explainBenefit for a fired opportunity; else the verdict and its reasons) — what stands when the analyst's turn is skipped. */
  readonly engine_explanation: string;
}
/** The analyst's part of the row: the turn, or why it was skipped (rule 4). */
export type ReviewAnalyst = { model_version: string; prompt_version: string; turn_id: string; rationale: string; flags: string[]; confidence: number } | { skipped: string; explanation_text: string; /** the `agent_turns` row when the model ran before the skip (provenance, refused, a run without a write) — counted as a turn on the receipt and under the cap */ turn_id?: string };

export interface ReviewProgramRun {
  readonly program_id: string; readonly partner_id: string; readonly run_id: string; readonly loans: number; readonly reviewed: number; readonly written: number; readonly already_reviewed: number;
  readonly candidates: number; readonly watching: number; readonly not_now: number; readonly excluded: number;
  readonly analyst_turns: number; readonly analyst_skipped: number; readonly analyst_skipped_by_reason: Readonly<Record<string, number>>;
  readonly offers: { delivered: number; portal_only: number }; readonly expired: number;
  readonly skipped: readonly { loan_id: string; reason: string }[]; readonly error: string | null;
}
export interface ReviewRunReport {
  readonly at: string; readonly as_of_date: PlainDate; readonly ran: boolean; readonly reason: string | null;
  readonly monitored_loans: number; readonly programs: readonly ReviewProgramRun[]; readonly line: string;
}
export interface ReviewRunOptions { readonly logger?: Logger | undefined; readonly llm?: AnalystLlm | null; /** run regardless of the wall clock (tests) */ readonly force?: boolean; /** the pass's analyst cap (PARTNER_BOOK_ANALYST_MAX_PER_DAY) */ readonly maxAnalystTurns?: number }

type Row = Record<string, unknown>;
const c = (v: unknown): Cents => (typeof v === "bigint" ? v : v === undefined || v === null || v === "" ? 0n : BigInt(String(v)));
const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const dateOf = (v: unknown): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? D(v.slice(0, 10)) : null);
export const reviewRunIdFor = (asOf: PlainDate, programId: string): string => `${REVIEW_RUN_PREFIX}${asOf}-${programId}`;
export const opportunityIdFor = (loanId: string, asOf: PlainDate, programId: string): string => `opp-${loanId}-${asOf}-${programId}`;

// ---------------------------------------------------------------- rule 1: the facts → 20.1's row
const fMoney = (v: Fact | undefined): Cents | null => (typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isInteger(v) ? BigInt(v) : null);
const fRate = (v: Fact | undefined): string | null => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Decimal.parse(v).toFixed(3) : typeof v === "number" && Number.isFinite(v) ? v.toFixed(3) : null);
const fInt = (v: Fact | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);
const fBool = (v: Fact | undefined): boolean | null => (typeof v === "boolean" ? v : typeof v === "string" ? (/^(y|yes|true|t|1)$/i.test(v) ? true : /^(n|no|false|f|0)$/i.test(v) ? false : null) : null);
const fDate = (v: Fact | undefined): PlainDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? D(v) : null);
const fText = (v: Fact | undefined): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const occupancyOf = (v: unknown): Occupancy => { const x = String(v ?? "").toLowerCase(); return x === "second_home" || x === "second" || x.startsWith("second") ? "second_home" : x === "investment" || x === "investor" || x.startsWith("invest") ? "investment" : "primary"; };
const propertyTypeOf = (v: unknown): PropertyType => { const x = String(v ?? "sfr").toLowerCase(); return (["sfr", "pud", "condo", "coop", "manufactured_home"] as const).find((t) => t === x) ?? (x === "manufactured" ? "manufactured_home" : x.startsWith("condo") ? "condo" : x.includes("pud") || x.includes("planned") ? "pud" : "sfr"); };
const unitsOf = (v: unknown): 1 | 2 | 3 | 4 => { const n = Number(v ?? 1); return n === 2 || n === 3 || n === 4 ? n : 1; };
const ratePctOfBps = (bps: unknown): string => (Number(bps ?? 0) / 10_000).toFixed(3);   // loan_terms.note_rate_bps is ×10 (7.250 % = 72500)
/** The partner's notation: a 3/6/9 (30/60/90 days) or F (120+/foreclosure) in the latest pay-string month (the last character). */
const payStringLate = (v: Fact | undefined): boolean => typeof v === "string" && /[369F]$/i.test(v.trim());
/** An MBA delinquency status other than current: a day count > 0 or a late/delinquent word (BK/FC codes are the bankruptcy/foreclosure flags' business). */
const mbaStatusLate = (v: Fact | undefined): boolean => typeof v === "string" && ((/^\d+$/.test(v.trim()) && Number(v.trim()) > 0) || /late|delinq/i.test(v));
/** Within `months` of the as-of date: as_of − months ≤ date. */
const within = (date: PlainDate, asOf: PlainDate, months: number): boolean => date >= addMonths(asOf, -months);
/** Rule 3: the rate the loan would need to see on the sheet to fire — the current rate minus 25 bps, rounded down to the 0.125 grid (5.875 → 5.625). */
export function watchRatePct(noteRatePct: string): string { const r = Decimal.parse(noteRatePct).sub(Decimal.parse("0.25")); const eighths = Math.floor(Number(r.mul(Decimal.fromInt(8)).toFixed(6, "HALF_UP")) + 1e-9); return (eighths / 8).toFixed(3); }
/** A 20.4 note rate ("0.06125") as the tape's percent text ("6.125"). */
export const pctOfRate = (rate: string | null | undefined): string | null => (rate ? Decimal.parse(rate).mul(Decimal.fromInt(100)).toFixed(3, "HALF_UP") : null);

export interface MonitoredFactsRow { readonly loan_id: string; readonly as_of_date: PlainDate; readonly facts: Record<string, Fact> }
/** The latest partner_book_facts row per loan (33.1: "the latest row per loan is the record 33.2 reads"). */
export async function latestPartnerFacts(db: Queryable, loanIds: readonly string[]): Promise<Map<string, MonitoredFactsRow>> {
  if (!loanIds.length) return new Map();
  const rows = await db.query<{ loan_id: string; as_of_date: string; facts: Record<string, Fact> }>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, as_of_date::text AS as_of_date, facts FROM partner_book_facts WHERE loan_id = ANY($1::uuid[]) ORDER BY loan_id, as_of_date DESC, created_at DESC`, [loanIds]);
  return new Map(rows.map((r) => [r.loan_id, { loan_id: r.loan_id, as_of_date: D(r.as_of_date.slice(0, 10)), facts: r.facts }]));
}
/** The import's row exceptions for a loan (`partner_book.loan.loaded{exceptions}` of its latest load — `implausible_value` marks the review `not_now`, rule 2). */
export async function loanLoadExceptions(db: Queryable, loanIds: readonly string[]): Promise<Map<string, string[]>> {
  if (!loanIds.length) return new Map();
  const rows = await db.query<{ loan_id: string; payload: Row }>(`SELECT DISTINCT ON (loan_id) loan_id::text AS loan_id, payload FROM loan_events WHERE type = 'partner_book.loan.loaded' AND loan_id = ANY($1::uuid[]) ORDER BY loan_id, sequence DESC`, [loanIds]);
  return new Map(rows.map((r) => [r.loan_id, Array.isArray(r.payload["exceptions"]) ? (r.payload["exceptions"] as unknown[]).map(String) : []]));
}
/** The primary borrower's party per loan (33.1 rule 3: borrowers.party_id). */
export async function partiesOfLoans(db: Queryable, loanIds: readonly string[]): Promise<Map<string, string | null>> {
  if (!loanIds.length) return new Map();
  const rows = await db.query<{ loan_id: string; party_id: string | null }>(`SELECT DISTINCT ON (lb.loan_id) lb.loan_id::text AS loan_id, b.party_id::text AS party_id FROM loan_borrowers lb JOIN borrowers b ON b.id = lb.borrower_id WHERE lb.loan_id = ANY($1::uuid[]) ORDER BY lb.loan_id, lb.is_primary DESC, b.created_at`, [loanIds]);
  return new Map(rows.map((r) => [r.loan_id, r.party_id]));
}
/** The current entity rows of one kind by id (entity_current: the latest version whatever scope wrote it), decoded (bigint cents revived). */
export async function entityRowsById(db: Queryable, kind: string, ids: readonly string[]): Promise<Map<string, Row>> {
  if (!ids.length) return new Map();
  const rows = await db.query<Row>(`SELECT id, data FROM entity_current WHERE kind = $1 AND id = ANY($2::text[])`, [kind, ids]);
  return new Map(rows.map((r) => [String(r["id"]), decodeEntityData(r["data"])]));
}

/**
 * Rule 1: 20.1's UniverseLoan per monitored loan from the latest partner_book_facts row and the loan's own properties /
 * terms columns of `v_refi_universe` (status `monitored`): `upb_cents` = the interest-bearing UPB (the deferred UPB stays on
 * the terms row as deferred_principal); `note_rate_pct`; `pi_cents`; `next_due_date` and `regx_days_delinquent` = days from
 * the tape's next due date to the as-of date when past, else 0 — the pay string and the MBA status corroborate (a 3/6/9 in
 * the latest month or a status other than current marks the loan delinquent); `remaining_term_months` from the maturity
 * date; `value_estimate` = the newest of Current FMV and Most Recent BPO by their dates (partner_fmv / partner_bpo), else
 * the original appraised value (partner_appraisal) — confidence `medium` within 12 months of the as-of date, `low` beyond;
 * `representative_score` = Current FICO (`score_source = partner_file`, pricing only); MI from the PMI flag and rate; the
 * bankruptcy / foreclosure / modification / transfer flags; escrow from T&I; the ARM first adjustment from the fixed period;
 * product_code FRM<term> | ARM; status `active` for the engine. Every row passes 20.1's assertInvestorBlind (no investor key,
 * no prohibited-basis key) before it is returned; a loan without a facts row or a value is skipped with its reason.
 */
export async function monitoredUniverseRows(rt: Runtime, asOf: PlainDate): Promise<{ rows: UniverseLoan[]; skipped: { loan_id: string; reason: string }[] }> {
  const view = await rt.db.query<Row>(`SELECT loan_id::text AS loan_id, partner_id::text AS partner_id, note_date::text AS note_date, consummation_date::text AS consummation_date, first_payment_date::text AS first_payment_date, original_upb_cents::text AS original_upb_cents, original_term_months, amortization::text AS amortization, note_rate_bps, pi_cents::text AS pi_cents, escrow_monthly_cents::text AS escrow_monthly_cents, escrowed, remaining_term_months, maturity_date::text AS maturity_date, property_state, county, occupancy, property_type, units, refi_do_not_solicit, refi_last_offered_at, refi_offers_12m FROM v_refi_universe WHERE status::text = 'monitored' ORDER BY loan_id`);
  const rows: UniverseLoan[] = []; const skipped: { loan_id: string; reason: string }[] = [];
  if (!view.length) return { rows, skipped };
  const factsBy = await latestPartnerFacts(rt.db, view.map((v) => String(v["loan_id"])));
  for (const v of view) {
    const loan_id = String(v["loan_id"]);
    try {
      const fr = factsBy.get(loan_id); if (!fr) throw new RangeError("no partner_book_facts row (33.1 import)");
      const F = fr.facts;
      const originalTerm = fInt(F["original_term_months"]) ?? Number(v["original_term_months"] ?? 360);
      const first = dateOf(v["first_payment_date"]) ?? fDate(F["first_payment_date"]); if (!first) throw new RangeError("no first_payment_date");
      const note = dateOf(v["note_date"]) ?? fDate(F["origination_date"]) ?? first;
      const maturity = fDate(F["maturity_date"]) ?? dateOf(v["maturity_date"]) ?? addMonths(first, originalTerm - 1);
      const nextDueTape = fDate(F["next_due_date"]);
      // the next due date: the tape's (a current loan's next installment, a delinquent loan's oldest unpaid one); without one, the first installment after as-of
      let next_due_date: PlainDate;
      if (nextDueTape) next_due_date = nextDueTape;
      else { const k = Math.max(0, monthsBetween(first, asOf)); const cand = addMonths(first, k); next_due_date = cand <= asOf ? addMonths(first, k + 1) : cand; }
      const remaining_term_months = next_due_date <= maturity ? monthsBetween(next_due_date, maturity) + 1 : (fInt(F["remaining_term_months"]) ?? Number(v["remaining_term_months"] ?? 0));
      const payments_made = Math.max(0, Math.min(originalTerm, originalTerm - remaining_term_months));
      const note_rate_pct = fRate(F["note_rate_pct"]) ?? ratePctOfBps(v["note_rate_bps"]);
      const upb_cents = fMoney(F["upb_cents"]); if (upb_cents === null || upb_cents <= 0n) throw new RangeError("no interest-bearing UPB on the tape");
      const original_upb_cents = fMoney(F["original_upb_cents"]) ?? c(v["original_upb_cents"]);
      const pi_cents = fMoney(F["pi_cents"]) ?? c(v["pi_cents"]);
      // delinquency: days past the tape's next due date at as-of; the pay string / MBA status corroborate (a loan they mark late is late even when the due date alone would not)
      let regx_days_delinquent = next_due_date < asOf ? daysBetween(next_due_date, asOf) : 0;
      if (regx_days_delinquent === 0 && (payStringLate(F["pay_string"]) || mbaStatusLate(F["mba_delinquency_status"]))) regx_days_delinquent = 30;
      // the value: the newest of Current FMV / Most Recent BPO by date, else the original appraised value (at the closing date)
      const fmv = fMoney(F["fmv_cents"]), bpo = fMoney(F["bpo_value_cents"]), appraised = fMoney(F["appraised_value_cents"]);
      const candidates: { source: ValueEstimate["source"]; value_cents: Cents; as_of: PlainDate }[] = [];
      if (fmv !== null && fmv > 0n) candidates.push({ source: "partner_fmv", value_cents: fmv, as_of: fDate(F["fmv_date"]) ?? fr.as_of_date });
      if (bpo !== null && bpo > 0n) candidates.push({ source: "partner_bpo", value_cents: bpo, as_of: fDate(F["bpo_date"]) ?? fr.as_of_date });
      candidates.sort((a, b) => (a.as_of < b.as_of ? 1 : a.as_of > b.as_of ? -1 : 0));
      const picked = candidates[0] ?? (appraised !== null && appraised > 0n ? { source: "partner_appraisal" as const, value_cents: appraised, as_of: fDate(F["origination_date"]) ?? note } : null);
      if (!picked) throw new RangeError("no value on the tape (Current FMV, Most Recent BPO or Orig Appraised Value)");
      const value_estimate: ValueEstimate = { ...picked, confidence: within(picked.as_of, asOf, VALUE_MEDIUM_MONTHS) ? "medium" : "low" };
      // MI: the PMI flag; the monthly premium from the PMI rate on the UPB when given
      const pmi = fBool(F["pmi_flag"]) === true; const pmiRateRaw = fRate(F["pmi_rate_pct"]);
      // the profile's rate parser reads a cell ≤ 1 as a fraction (0.550 → "55.000"); a PMI rate is a fraction of a percent to a few percent, so a "rate" above 5 % is that ×100 reading, undone here
      const pmiRate = pmiRateRaw && Number(pmiRateRaw) > 5 ? Decimal.parse(pmiRateRaw).div(Decimal.fromInt(100)).toFixed(3) : pmiRateRaw;
      const mi_status: MiStatus = pmi ? "bpmi_active" : "none";
      const mi_monthly_cents = pmi && pmiRate && Decimal.parse(pmiRate).cmp(Decimal.ZERO) > 0 ? centsToDecimal(upb_cents).mul(ratePercent(pmiRate)).div(Decimal.fromInt(12)).toCents("HALF_UP") : 0n;
      // the flags (bankruptcy: the indicator, or a filing neither discharged nor dismissed; foreclosure: the indicator or a referral date; loss mitigation: a modification in process; transfer: the servicing status)
      const bankruptcy_active = fBool(F["bk_status"]) === true || (fDate(F["bk_filed_date"]) !== null && fBool(F["bk_discharged"]) !== true && fDate(F["bk_dismissed_date"]) === null);
      const foreclosure_referred = fBool(F["fc_status"]) === true || fDate(F["fc_referral_date"]) !== null;
      const lossmit_plan_active = fBool(F["modification_flag"]) === true;
      const transfer_out_pending = /transfer|service[\s_-]?released|sold/i.test(fText(F["servicing_status"]) ?? "");
      // escrow from T&I; the ARM first adjustment from the fixed period; the product code
      const ti = fMoney(F["ti_cents"]) ?? c(v["escrow_monthly_cents"]); const escrowed = ti > 0n;
      const amortization: UniverseLoan["amortization"] = String(v["amortization"] ?? "fixed").startsWith("arm") ? "arm" : "fixed";
      const fixedPeriod = fInt(F["arm_fixed_period_months"]) ?? 0;
      const row: UniverseLoan = {
        loan_id, partner_id: String(v["partner_id"]), status: "active", product_code: amortization === "arm" ? "ARM" : `FRM${Math.round(originalTerm / 12)}`, amortization,
        note_date: note, first_payment_date: first, consummation_date: dateOf(v["consummation_date"]) ?? note, title_date: note,
        original_upb_cents, original_term_months: originalTerm, note_rate_pct, pi_cents, payments_made, upb_cents, next_due_date, remaining_term_months,
        escrowed, escrow_monthly_cents: ti, net_escrow_deposit_estimate_cents: escrowed ? ti * 2n : 0n, taxes_annual_cents: null, insurance_annual_cents: null,
        mi_status, mi_monthly_cents, occupancy: occupancyOf(v["occupancy"] ?? F["occupancy"]), property_type: propertyTypeOf(v["property_type"] ?? F["property_type"]), units: unitsOf(v["units"]),
        property_state: String(v["property_state"] ?? F["property_state"] ?? "XX"), county: s(v["county"]) ?? fText(F["property_county"]) ?? "", county_limit_cents: null,
        value_estimate, representative_score: fInt(F["fico_current"]) ?? fInt(F["fico_original"]), score_source: "partner_file",
        regx_days_delinquent, bankruptcy_active, foreclosure_referred, lossmit_plan_active, deceased_or_sii_pending: false, transfer_out_pending,
        refi_do_not_solicit: v["refi_do_not_solicit"] === true, refi_last_offered_at: s(v["refi_last_offered_at"]), refi_offers_12m: Number(v["refi_offers_12m"] ?? 0),
        arm_first_adjustment_date: amortization === "arm" && fixedPeriod > 0 ? addMonths(first, fixedPeriod) : null,
      };
      assertInvestorBlind(row as unknown as Row);   // 20.1 rules 7–8: no investor key, no prohibited-basis key (name, ZIP, DTI, age never reach the row)
      rows.push(row);
    } catch (e) { skipped.push({ loan_id, reason: e instanceof Error ? e.message : String(e) }); }
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------- rule 3: the verdict and the facts
/**
 * State machine: offer_ready | offered | engaged | converted → `candidate`; suppressed by an exclusion (not current, bankruptcy,
 * foreclosure, loss mitigation, transfer pending) or not in the universe → `excluded`; suppressed by cooldown / frequency
 * cap / recapture window / marketing suppression, an `implausible_value` exception on the facts, a value older than 24
 * months, or a candidate the engine could not price (`pricing_refused:…` — no cost schedule for its state) → `not_now`; otherwise (no_benefit, a rate delta under the floor, any fire-rule miss: the loan is current and
 * eligible, the numbers are not there today) → `watching`.
 */
export function verdictOf(i: { opportunity: Pick<RefiOpportunity, "status" | "suppression_reasons"> | null; exceptions: readonly string[]; value_as_of: PlainDate | null; as_of: PlainDate; held?: boolean }): { verdict: ReviewVerdict; reasons: string[] } {
  const opp = i.opportunity;
  // 33.1 rule 8: a loan absent from the partner's latest tape is held out of the review — `not_now`, reason `not_on_latest_tape` — until the next tape carries it or book.resolve{keep} lifts the hold (src/runtime/partner-book.ts holdsOf)
  if (i.held) return { verdict: "not_now", reasons: [HOLD_REASON, ...(opp?.status === "suppressed" ? [...(opp.suppression_reasons ?? [])] : [])] };
  if (!opp) return { verdict: "excluded", reasons: ["not_in_universe"] };
  const sup = [...(opp.suppression_reasons ?? [])];
  if (opp.status === "suppressed" && sup.some((r) => EXCLUSION_REASONS.includes(r))) return { verdict: "excluded", reasons: sup };
  const implausible = i.exceptions.includes("implausible_value");
  const stale = i.value_as_of !== null && !within(i.value_as_of, i.as_of, VALUE_STALE_MONTHS);
  const gated = opp.status === "suppressed" && sup.some((r) => NOT_NOW_REASONS.includes(r) || r.startsWith(PRICING_REFUSED_PREFIX));   // a loan the engine could not price (no cost schedule for its state) is `not_now` with the engine's `pricing_refused:…` reason, never `watching`
  if (implausible || stale || gated || opp.status === "declined" || opp.status === "expired") {
    return { verdict: "not_now", reasons: [...sup, ...(implausible ? ["implausible_value"] : []), ...(stale ? ["value_stale"] : []), ...(opp.status === "declined" ? ["declined"] : opp.status === "expired" ? ["expired"] : [])] };
  }
  if (CANDIDATE_STATUSES.has(opp.status)) return { verdict: "candidate", reasons: [...CANDIDATE_REASONS] };
  return { verdict: "watching", reasons: sup.length ? sup : ["no_benefit"] };
}

/** The review's inputs as the engine saw them (rule 3): the row's facts and the day's opportunity figures, copied — never computed here. */
export function reviewFactsOf(i: { row: UniverseLoan; opportunity: RefiOpportunity | null; exceptions: readonly string[]; as_of: PlainDate; verdict: ReviewVerdict }): ReviewFacts {
  const { row, opportunity: opp } = i; const ve = row.value_estimate; const m = opp?.benefit_metrics ?? null; const ct = opp?.candidate_terms ?? null;
  const source: ReviewFacts["value_source"] = ve.source === "partner_bpo" ? "partner_bpo" : ve.source === "partner_appraisal" ? "partner_appraisal" : "partner_fmv";
  const flags: string[] = [];
  if (row.bankruptcy_active) flags.push("bankruptcy_active"); if (row.foreclosure_referred) flags.push("foreclosure_referred"); if (row.lossmit_plan_active) flags.push("lossmit_plan_active");
  if (row.deceased_or_sii_pending) flags.push("deceased_or_sii_pending"); if (row.transfer_out_pending) flags.push("transfer_out_pending"); if (row.refi_do_not_solicit) flags.push("marketing_suppression");
  if (row.regx_days_delinquent > 0) flags.push("delinquent"); if (row.mi_status === "bpmi_active") flags.push("mi_active");
  if (ve.confidence === "low") flags.push("value_low_confidence"); if (!within(ve.as_of, i.as_of, VALUE_STALE_MONTHS)) flags.push("value_stale");
  if (row.arm_first_adjustment_date && row.arm_first_adjustment_date >= i.as_of && row.arm_first_adjustment_date <= addMonths(i.as_of, 12)) flags.push("arm_reset_within_12m");
  for (const x of i.exceptions) if (!flags.includes(x)) flags.push(x);
  const facts: ReviewFacts = {
    note_rate_pct: row.note_rate_pct, candidate_rate_pct: pctOfRate(ct?.note_rate ?? null), rate_delta_bps: m?.rate_delta_bps ?? null,
    upb_cents: String(row.upb_cents), value_cents: String(ve.value_cents), value_source: source, value_as_of: ve.as_of, value_confidence: ve.confidence === "low" ? "low" : "medium",
    ltv: ltvOf(row.upb_cents, ve.value_cents).ltv, remaining_term_months: row.remaining_term_months, pi_cents: String(row.pi_cents),
    candidate_pi_cents: ct?.pi_cents !== null && ct?.pi_cents !== undefined ? String(ct.pi_cents) : null, candidate_loan_amount_cents: ct ? String(ct.loan_amount_cents) : null,
    monthly_delta_cents: m ? String(m.payment_delta_cents) : null, npv_cents: m ? String(m.npv_cents) : null, breakeven_months: m ? m.breakeven_months : null, seven_year_delta_cents: m ? String(m.seven_year_total_cost_delta_cents) : null,
    days_delinquent: row.regx_days_delinquent, flags,
  };
  return i.verdict === "watching" ? { ...facts, watch_rate_pct: watchRatePct(row.note_rate_pct) } : facts;
}

/** One loan's review of the day from the engine's rows (the `refi_universe` row 20.1 loaded and the day's `refi_opportunities` row). */
export function reviewOf(i: { loan_id: string; party_id: string | null; as_of: PlainDate; program_id: string; row: UniverseLoan | null; opportunity: RefiOpportunity | null; exceptions: readonly string[]; held?: boolean }): Review {
  const opp = i.opportunity;
  const v = i.held ? verdictOf({ opportunity: opp, exceptions: i.exceptions, value_as_of: i.row?.value_estimate.as_of ?? null, as_of: i.as_of, held: true }) : i.row ? verdictOf({ opportunity: opp, exceptions: i.exceptions, value_as_of: i.row.value_estimate.as_of, as_of: i.as_of }) : { verdict: "excluded" as const, reasons: ["not_in_universe"] };
  if (!i.row) {
    const facts: ReviewFacts = { note_rate_pct: "0.000", candidate_rate_pct: null, rate_delta_bps: null, upb_cents: "0", value_cents: "0", value_source: "partner_fmv", value_as_of: i.as_of, value_confidence: "low", ltv: "0.0000", remaining_term_months: 0, pi_cents: "0", candidate_pi_cents: null, candidate_loan_amount_cents: null, monthly_delta_cents: null, npv_cents: null, breakeven_months: null, seven_year_delta_cents: null, days_delinquent: 0, flags: [...(i.held ? [HOLD_REASON] : []), "not_in_universe", ...i.exceptions] };
    return { loan_id: i.loan_id, party_id: i.party_id, as_of_date: i.as_of, program_id: i.program_id, opportunity_id: opp?.opportunity_id ?? null, opportunity_status: opp?.status ?? null, verdict: v.verdict, reasons: v.reasons, facts, engine_explanation: i.held ? `not_now: ${v.reasons.join(", ")}` : "excluded: the loan is not in the day's universe" };
  }
  const facts = reviewFactsOf({ row: i.row, opportunity: opp, exceptions: i.exceptions, as_of: i.as_of, verdict: v.verdict });
  if (i.held && !facts.flags.includes(HOLD_REASON)) facts.flags.unshift(HOLD_REASON);
  const engine_explanation = v.verdict === "candidate" && opp?.explanation_text ? opp.explanation_text : `${v.verdict}: ${v.reasons.join(", ")}`;
  return { loan_id: i.loan_id, party_id: i.party_id, as_of_date: i.as_of, program_id: i.program_id, opportunity_id: opp?.opportunity_id ?? null, opportunity_status: opp?.status ?? null, verdict: v.verdict, reasons: v.reasons, facts, engine_explanation };
}

// ---------------------------------------------------------------- rule 4 / rule 7: the facts as tokens and the verdict in words (never a raw figure in a model-facing text)
/** The review facts the model and the surface see as `{{facts.<key>}}` tokens; `reviewTokenValues` resolves them (the surface's job, never the model's). */
export const REVIEW_TOKEN_KEYS = ["rate_now", "candidate_rate", "rate_delta", "upb", "value", "value_as_of", "ltv", "remaining_term", "payment_now", "candidate_payment", "monthly_delta", "npv", "breakeven", "seven_year_delta", "days_delinquent", "watch_rate"] as const;
export type ReviewTokenKey = (typeof REVIEW_TOKEN_KEYS)[number];
const usd = (cents: string): string => { const c0 = BigInt(cents); const neg = c0 < 0n; const a = neg ? -c0 : c0; return `${neg ? "-" : ""}$${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(a % 100n).toString().padStart(2, "0")}`; };
const pct = (p: string): string => `${Decimal.parse(p).toFixed(3, "HALF_UP")}%`;
/** `{{facts.rate_now}}` … per fact the review carries (a fact the day has no figure for — no candidate priced — is null). */
export function reviewTokens(f: ReviewFacts): Record<ReviewTokenKey, string | null> {
  const t = (k: ReviewTokenKey, present: boolean): string | null => (present ? `{{facts.${k}}}` : null);
  return { rate_now: t("rate_now", true), candidate_rate: t("candidate_rate", f.candidate_rate_pct !== null), rate_delta: t("rate_delta", f.rate_delta_bps !== null), upb: t("upb", true), value: t("value", true), value_as_of: t("value_as_of", true), ltv: t("ltv", true), remaining_term: t("remaining_term", true),
    payment_now: t("payment_now", true), candidate_payment: t("candidate_payment", f.candidate_pi_cents !== null), monthly_delta: t("monthly_delta", f.monthly_delta_cents !== null), npv: t("npv", f.npv_cents !== null), breakeven: t("breakeven", f.breakeven_months !== null), seven_year_delta: t("seven_year_delta", f.seven_year_delta_cents !== null), days_delinquent: t("days_delinquent", true), watch_rate: t("watch_rate", f.watch_rate_pct !== undefined) };
}
/** The tokens' values — the engine's figures formatted for a surface (32.11 / the record), keyed `facts.<key>`. */
export function reviewTokenValues(f: ReviewFacts): Record<string, string> {
  const out: Record<string, string> = { "facts.rate_now": pct(f.note_rate_pct), "facts.upb": usd(f.upb_cents), "facts.value": usd(f.value_cents), "facts.value_as_of": f.value_as_of, "facts.ltv": `${Decimal.parse(f.ltv).mul(Decimal.fromInt(100)).toFixed(2, "HALF_UP")}%`, "facts.remaining_term": `${f.remaining_term_months} months`, "facts.payment_now": usd(f.pi_cents), "facts.days_delinquent": String(f.days_delinquent) };
  if (f.candidate_rate_pct !== null) out["facts.candidate_rate"] = pct(f.candidate_rate_pct);
  if (f.rate_delta_bps !== null) out["facts.rate_delta"] = `${f.rate_delta_bps} basis points`;
  if (f.candidate_pi_cents !== null) out["facts.candidate_payment"] = usd(f.candidate_pi_cents);
  if (f.monthly_delta_cents !== null) out["facts.monthly_delta"] = usd(f.monthly_delta_cents);
  if (f.npv_cents !== null) out["facts.npv"] = usd(f.npv_cents);
  if (f.breakeven_months !== null) out["facts.breakeven"] = `${f.breakeven_months} months`;
  if (f.seven_year_delta_cents !== null) out["facts.seven_year_delta"] = usd(f.seven_year_delta_cents);
  if (f.watch_rate_pct !== undefined) out["facts.watch_rate"] = pct(f.watch_rate_pct);
  return out;
}
/** 33.1 rule 8: the review's reason for a loan absent from the partner's latest tape (the literal the copy library keys `refi.review.reason.not_on_latest_tape`). */
export const HOLD_REASON = "not_on_latest_tape";
const REASON_WORDS: Readonly<Record<string, string>> = {
  not_on_latest_tape: "the loan was not on the partner's latest tape and is on hold until it returns or an operator resolves it",
  rate_delta: "the rate reduction clears the program's floor", npv_positive: "the savings over the holding period are positive", seven_year_delta_positive: "the total cost over seven years is lower", prescreen: "the loan passes the eligibility prescreen", state_rule: "the state's borrower's-interest rule is met",
  no_benefit: "the numbers are not there today", prescreen_failed: "the eligibility prescreen is not met", state_rule_failed: "the state's borrower's-interest rule is not met", not_priceable: "no rate on today's sheet covers the costs", not_priced: "the candidate could not be priced",
  cooldown: "the homeowner declined an offer recently", frequency_cap: "the homeowner has had the program's offers for the year", premium_recapture_window: "the loan is inside the investor's recapture window", marketing_suppression: "the homeowner asked not to be solicited",
  not_active: "the loan is not active", bankruptcy_active: "an active bankruptcy", foreclosure_referred: "a foreclosure referral", lossmit_plan_active: "a loss-mitigation plan in process", deceased_or_sii_pending: "a pending successor-in-interest matter", transfer_out_pending: "a servicing transfer pending", delinquent: "the loan is not current",
  not_in_universe: "the loan is not in today's universe", implausible_value: "the tape carries a value that does not read right", value_stale: "the value on file is too old", declined: "the homeowner declined the offer", expired: "the offer expired",
};
/** The engine's reason codes in plain words (a fire-rule miss such as `rate_delta_bps -25 < 25` by its prefix) — never a figure. */
export function reasonsInWords(reasons: readonly string[]): string[] {
  return reasons.map((r) => REASON_WORDS[r] ?? (r.startsWith("rate_delta_bps") ? "the rate reduction is under the program's floor" : r.startsWith("npv_cents") ? "the savings over the holding period are not positive" : r.startsWith("seven_year") ? "the total cost over seven years is not lower" : r.startsWith("lifetime_interest") ? "a new full term would cost more in interest and the same-term option does not save enough" : r.startsWith("pricing_refused") ? "pricing refused the candidate" : r.replace(/[\d$%.,-]+/g, "").replace(/_/g, " ").trim()));
}
export const VERDICT_WORDS: Readonly<Record<ReviewVerdict, string>> = { candidate: "a candidate today: the engine's offer is ready", watching: "watching: the loan is current and eligible, the numbers are not there today", not_now: "not now", excluded: "excluded from today's review" };

/** The analyst's turn result as the row carries it (rule 4): the turn, or `{skipped, explanation_text}` with the engine's own text standing in. */
export const analystOf = (review: Review, r: AnalystTurnResult): ReviewAnalyst => ("skipped" in r ? { skipped: r.skipped, explanation_text: review.engine_explanation, ...(r.turn_id ? { turn_id: r.turn_id } : {}) } : { model_version: r.model_version, prompt_version: r.prompt_version, turn_id: r.turn_id, rationale: r.rationale, flags: [...r.flags], confidence: r.confidence });

// ---------------------------------------------------------------- the review row, its decision and its event (shared by the pass and the 33.2 `review.write` bus tool)
export interface ReviewWriteRecord { readonly review_id: string; readonly decision_id: string; readonly decision: DecisionInput; readonly event: { type: "partner_book.review.written"; loanId: string; aggregate: { kind: string; id: string }; payload: Record<string, unknown> } }
/** The decision record (`review.write` by `refi-analyst`: {loan_id, as_of_date, verdict, opportunity_id, rule_set_version, model_version, prompt_version, confidence, rationale, flags}) and the loan-scoped `partner_book.review.written` event. */
export function reviewWriteRecord(review: Review, analyst: ReviewAnalyst, run_id: string, ids: { review_id?: string; decision_id?: string } = {}): ReviewWriteRecord {
  const review_id = ids.review_id ?? randomUUID(); const decision_id = ids.decision_id ?? randomUUID();
  const turn = "skipped" in analyst ? null : analyst;
  const rationale = turn ? turn.rationale : `${review.engine_explanation}${"skipped" in analyst ? ` (analyst skipped: ${analyst.skipped})` : ""}`;
  const decision: DecisionInput = { agent: REFI_ANALYST, action: "review.write", ruleSetVersion: REVIEW_RULE_SET_VERSION, loanId: review.loan_id, subject: { kind: "partner_book_review", id: review_id }, ruleCode: REVIEW_RULE_CODE,
    confidence: turn ? turn.confidence : 1, modelVersion: turn ? turn.model_version : "engine (deterministic)", promptVersion: turn ? turn.prompt_version : "33.2-v1",
    rationale: `verdict ${review.verdict} for loan ${review.loan_id} as of ${review.as_of_date}${review.opportunity_id ? ` (opportunity ${review.opportunity_id})` : ""}; reasons: ${review.reasons.join(", ") || "none"}; flags: ${(turn ? turn.flags : review.facts.flags).join(", ") || "none"}; ${rationale}` };
  const event: ReviewWriteRecord["event"] = { type: "partner_book.review.written", loanId: review.loan_id, aggregate: { kind: "partner_book_review", id: review_id },
    payload: { review_id, loan_id: review.loan_id, party_id: review.party_id, as_of_date: review.as_of_date, run_id, verdict: review.verdict, opportunity_id: review.opportunity_id, reasons: review.reasons, decision_id, analyst: "skipped" in analyst ? { skipped: analyst.skipped, ...(analyst.turn_id ? { turn_id: analyst.turn_id } : {}) } : { turn_id: analyst.turn_id, model_version: analyst.model_version, prompt_version: analyst.prompt_version }, origination: true } };
  return { review_id, decision_id, decision, event };
}
/** The `partner_book_reviews` row (append-only; one per loan per day). */
export async function insertReviewRow(q: Queryable, review: Review, analyst: ReviewAnalyst, run_id: string, r: ReviewWriteRecord, createdAt: string): Promise<void> {
  await q.query(`INSERT INTO partner_book_reviews (id, loan_id, party_id, as_of_date, run_id, opportunity_id, verdict, reasons, facts, analyst, decision_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)`,
    [r.review_id, review.loan_id, review.party_id, review.as_of_date, run_id, review.opportunity_id, review.verdict, toJson(review.reasons), toJson(review.facts), toJson(analyst), r.decision_id, createdAt]);
}
/** The review written in ONE unit of work on the loan: the event, the decision (the id the row carries) and the row. */
export async function writeReview(rt: Runtime, review: Review, analyst: ReviewAnalyst, run_id: string): Promise<{ review_id: string; decision_id: string }> {
  const r = reviewWriteRecord(review, analyst, run_id);
  await rt.uow.run({ loanId: review.loan_id }, async (ctx) => { ctx.events.append({ type: r.event.type, loanId: r.event.loanId, aggregate: r.event.aggregate, actor: REFI_ANALYST_AGENT, payload: r.event.payload }); },
    { clock: rt.clock, commit: async (q) => { await rt.uow.decisions.record(r.decision, q, r.decision_id); await insertReviewRow(q, review, analyst, run_id, r, rt.clock.now()); } });
  return { review_id: r.review_id, decision_id: r.decision_id };
}

// ---------------------------------------------------------------- the daily pass
export type MonitoredLoan = { loan_id: string; partner_id: string; servicer_loan_number: string };
/** Every `loans{status=monitored}` with a partner_book_facts row (inputs and triggers). */
export async function monitoredLoans(db: Queryable): Promise<MonitoredLoan[]> {
  return db.query<MonitoredLoan>(`SELECT l.id::text AS loan_id, l.partner_party_id::text AS partner_id, l.servicer_loan_number FROM loans l WHERE l.status = 'monitored' AND EXISTS (SELECT 1 FROM partner_book_facts f WHERE f.loan_id = l.id) ORDER BY l.servicer_loan_number, l.id`);
}
/** Has the review completed for `asOf` under `programId` (idempotent per day)? */
export async function reviewRanToday(db: Queryable, asOf: PlainDate, programId: string): Promise<boolean> {
  return (await db.query<{ n: string }>(`SELECT 1 AS n FROM loan_events WHERE type = 'partner_book.review.run_completed' AND payload->>'as_of_date' = $1 AND payload->>'program_id' = $2 LIMIT 1`, [asOf, programId])).length > 0;
}
/** 20.1's run of the day for the program (`refi.trigger.run_completed{as_of_date, program_id}`) — the review needs it. */
export async function refiRanToday(db: Queryable, asOf: PlainDate, programId: string): Promise<boolean> {
  return (await db.query<{ n: string }>(`SELECT 1 AS n FROM loan_events WHERE type = 'refi.trigger.run_completed' AND payload->>'as_of_date' = $1 AND payload->>'program_id' = $2 LIMIT 1`, [asOf, programId])).length > 0;
}
/** The day's review rows already written (a second pass counts them, never duplicates them). */
export async function reviewsOfDay(db: Queryable, asOf: PlainDate, loanIds: readonly string[]): Promise<Map<string, { verdict: ReviewVerdict; opportunity_id: string | null; analyst: Row }>> {
  if (!loanIds.length) return new Map();
  const rows = await db.query<{ loan_id: string; verdict: ReviewVerdict; opportunity_id: string | null; analyst: Row }>(`SELECT loan_id::text AS loan_id, verdict, opportunity_id, analyst FROM partner_book_reviews WHERE as_of_date = $1 AND loan_id = ANY($2::uuid[])`, [asOf, loanIds]);
  return new Map(rows.map((r) => [r.loan_id, { verdict: r.verdict, opportunity_id: r.opportunity_id, analyst: r.analyst }]));
}

/** The engine's rows for a set of monitored loans on a day: the `refi_universe` row, the `refi_opportunities` row, the loan's open offer (an earlier opportunity `offered` and unexpired, or `engaged`), the import exceptions, the party. */
export async function reviewInputs(db: Queryable, loanIds: readonly string[], asOf: PlainDate, programId: string, now?: string): Promise<{ rows: Map<string, UniverseLoan>; opportunities: Map<string, RefiOpportunity>; open_offers: Map<string, RefiOpportunity>; exceptions: Map<string, string[]>; parties: Map<string, string | null>; holds: Set<string> }> {
  const [rowsRaw, oppsRaw, open_offers, exceptions, parties, holds] = await Promise.all([entityRowsById(db, "refi_universe", loanIds), entityRowsById(db, "refi_opportunities", loanIds.map((id) => opportunityIdFor(id, asOf, programId))), openOffersOf(db, loanIds, asOf), loanLoadExceptions(db, loanIds), partiesOfLoans(db, loanIds),
    heldLoanIds({ db, clock: { now: () => now ?? `${asOf}T23:59:59.000Z` } }, loanIds)]);   // 33.1 rule 8: the loans on hold (not_on_latest_tape) as of the pass
  const rows = new Map([...rowsRaw.entries()].map(([id, d]) => [id, d as unknown as UniverseLoan]));
  const opportunities = new Map<string, RefiOpportunity>(); for (const [, d] of oppsRaw) { const o = d as unknown as RefiOpportunity; opportunities.set(o.loan_id, o); }
  return { rows, opportunities, open_offers, exceptions, parties, holds };
}
/**
 * The opportunity the day's review reads: the day's row, unless the loan has an open offer (an earlier opportunity `offered`
 * and unexpired, or `engaged`) and the day brought no row (refi-daily holds such a loan out of the engine's run) or only a
 * duplicate `offer_ready` — then the open offer is continued: verdict `candidate`, `opportunity_id` = the open one, so the
 * row and the situation's `offer_card_instance_id` point at the live card. A day's `suppressed` row (the loan turned
 * delinquent, a marketing suppression) stands over the open offer: the review says what the engine says today.
 */
export function reviewOpportunityOf(day: RefiOpportunity | null, open: RefiOpportunity | null): RefiOpportunity | null {
  if (!open || open.opportunity_id === day?.opportunity_id) return day;
  return !day || day.status === "offer_ready" ? open : day;
}

const skippedReport = (nowIso: string, asOf: PlainDate, reason: string, monitored: number, programs: ReviewProgramRun[] = []): ReviewRunReport => ({ at: nowIso, as_of_date: asOf, ran: false, reason, monitored_loans: monitored, programs, line: `partner book review ${asOf}: not run (${reason})` });

/**
 * The daily pass (rules 1–6): reads the day's opportunities of every monitored loan (the facts → universe overlay is
 * refi-daily's, rule 1), writes one partner_book_reviews row per loan with the analyst's turn, then offer delivery and
 * expiry, then `partner_book.review.run_completed` (global) — idempotent per day per program.
 */
export async function partnerBookReviewRun(rt: Runtime, nowIso: string, opts: ReviewRunOptions = {}): Promise<ReviewRunReport> {
  const wc = wallClock(Date.parse(nowIso), ET); const asOf = wc.date; const log = opts.logger;
  const [hh, mm] = REVIEW_AT_ET.split(":").map(Number) as [number, number];
  const loans = await monitoredLoans(rt.db);
  if (!loans.length) return skippedReport(nowIso, asOf, "no monitored loans with partner_book_facts (33.1 import)", 0);
  if (!opts.force && wc.hour * 60 + wc.minute < hh * 60 + mm) return skippedReport(nowIso, asOf, `before ${REVIEW_AT_ET} ET`, loans.length);
  const store = new EntityStore(); store.seed(await rt.entities.load({}));
  const programs = store.list("partner_programs").map((r) => r.data as unknown as PartnerProgram);
  const byPartner = new Map<string, MonitoredLoan[]>(); for (const l of loans) byPartner.set(l.partner_id, [...(byPartner.get(l.partner_id) ?? []), l]);
  const out: ReviewProgramRun[] = []; const notDue: string[] = [];
  const maxTurns = opts.maxAnalystTurns ?? ANALYST_MAX_PER_DAY;
  for (const [partnerId, mine] of byPartner) {
    const program = programs.find((p) => p.partner_id === partnerId);
    if (!program) { notDue.push(`partner ${partnerId}: no partner_programs row (20.1 loadUniverse{op=register_program}; ${mine.length} loans)`); continue; }
    const run_id = reviewRunIdFor(asOf, program.program_id);
    if (await reviewRanToday(rt.db, asOf, program.program_id)) { notDue.push(`${program.program_id}: already ran today`); continue; }
    if (!(await refiRanToday(rt.db, asOf, program.program_id))) { notDue.push(`${program.program_id}: no 20.1 run today (refi.trigger.run_completed{as_of_date=${asOf}}) — the review waits; SM_PARTNER_BOOK_REVIEW_DAILY breaches tomorrow`); continue; }
    const ids = mine.map((l) => l.loan_id);
    const counts = { candidate: 0, watching: 0, not_now: 0, excluded: 0 } as Record<ReviewVerdict, number>;
    const skippedBy: Record<string, number> = {}; const skippedLoans: { loan_id: string; reason: string }[] = [];
    let turns = 0; let written = 0; let already = 0; let error: string | null = null;
    const candidateOpps: string[] = [];
    try {
      const [inputs, existing] = await Promise.all([reviewInputs(rt.db, ids, asOf, program.program_id, nowIso), reviewsOfDay(rt.db, asOf, ids)]);
      for (const l of mine) {
        const prior = existing.get(l.loan_id);
        // a turn is counted whenever the model ran (an agent_turns row: a written rationale or a post-run skip carrying its turn_id); a skip is the row's `analyst.skipped` whatever ran
        if (prior) { already += 1; counts[prior.verdict] += 1; if (prior.verdict === "candidate" && prior.opportunity_id) candidateOpps.push(prior.opportunity_id); if (typeof prior.analyst["skipped"] === "string") skippedBy[String(prior.analyst["skipped"])] = (skippedBy[String(prior.analyst["skipped"])] ?? 0) + 1; if (typeof prior.analyst["turn_id"] === "string") turns += 1; continue; }
        const review = reviewOf({ loan_id: l.loan_id, party_id: inputs.parties.get(l.loan_id) ?? null, as_of: asOf, program_id: program.program_id, row: inputs.rows.get(l.loan_id) ?? null, opportunity: reviewOpportunityOf(inputs.opportunities.get(l.loan_id) ?? null, inputs.open_offers.get(l.loan_id) ?? null), exceptions: inputs.exceptions.get(l.loan_id) ?? [], held: inputs.holds.has(l.loan_id) });
        // rule 4: the analyst's turn — capped per pass; the model off / rate-limited / refused / an error skips the turn, never the review
        let turn: AnalystTurnResult;
        if (turns >= maxTurns) turn = { skipped: "cap" };
        else { try { turn = await analystTurn(rt, opts.llm ?? null, { loan_id: review.loan_id, party_id: review.party_id, as_of_date: asOf, verdict: review.verdict, reasons: review.reasons, facts: review.facts }, { logger: log, run_id, as_of_date: asOf, turns_today: turns, max_per_day: maxTurns }); } catch (e) { log?.warn("partner book review: analyst turn failed", { loan_id: l.loan_id, error: e instanceof Error ? e.message : String(e) }); turn = { skipped: "error" }; } }
        if ("skipped" in turn) skippedBy[turn.skipped] = (skippedBy[turn.skipped] ?? 0) + 1;
        if (!("skipped" in turn) || turn.turn_id) turns += 1;   // the cap (PARTNER_BOOK_ANALYST_MAX_PER_DAY) bounds model spend: a provenance / refused skip ran the model too
        try { await writeReview(rt, review, analystOf(review, turn), run_id); written += 1; counts[review.verdict] += 1; if (review.verdict === "candidate" && review.opportunity_id) candidateOpps.push(review.opportunity_id); }
        catch (e) { const msg = e instanceof Error ? e.message : String(e); skippedLoans.push({ loan_id: l.loan_id, reason: `review not written: ${msg}` }); log?.warn("partner book review: row refused", { loan_id: l.loan_id, run_id, error: msg }); }
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); log?.error("partner book review: run failed", { program_id: program.program_id, run_id, error }); }
    // rules 5–6: offer delivery for the day's candidates, expiry of every breached 30-day clock on a monitored loan — never failing the pass
    let offers = { delivered: 0, portal_only: 0 }; let expired = 0;
    if (!error) {
      try { offers = await deliverOffers(rt, nowIso, { logger: log, as_of_date: asOf, program_id: program.program_id, opportunity_ids: candidateOpps }); } catch (e) { log?.error("partner book review: offer delivery failed", { program_id: program.program_id, error: e instanceof Error ? e.message : String(e) }); }
      try { expired = (await expireOffers(rt, nowIso)).expired; } catch (e) { log?.error("partner book review: offer expiry failed", { program_id: program.program_id, error: e instanceof Error ? e.message : String(e) }); }
      const analystSkipped = Object.values(skippedBy).reduce((a, b) => a + b, 0);
      // the receipt (global): SM_PARTNER_BOOK_REVIEW_DAILY's trigger and satisfying event — the day's clock, re-armed for tomorrow 07:00 ET
      await rt.uow.run({}, async (ctx) => { ctx.events.append({ type: "partner_book.review.run_completed", aggregate: { kind: "partner_program", id: program.program_id }, actor: REFI_ANALYST_AGENT,
        payload: { run_id, program_id: program.program_id, partner_id: partnerId, as_of_date: asOf, at: nowIso, reviewed: written + already, written, already_reviewed: already, candidates: counts.candidate, watching: counts.watching, not_now: counts.not_now, excluded: counts.excluded, analyst_turns: turns, analyst_skipped: analystSkipped, analyst_skipped_by_reason: skippedBy, offers_delivered: offers.delivered, offers_portal_only: offers.portal_only, expired, skipped: skippedLoans.length, rule_set_version: REVIEW_RULE_SET_VERSION, origination: true } }); }, { clock: rt.clock });
    }
    out.push({ program_id: program.program_id, partner_id: partnerId, run_id, loans: mine.length, reviewed: written + already, written, already_reviewed: already, candidates: counts.candidate, watching: counts.watching, not_now: counts.not_now, excluded: counts.excluded,
      analyst_turns: turns, analyst_skipped: Object.values(skippedBy).reduce((a, b) => a + b, 0), analyst_skipped_by_reason: skippedBy, offers, expired, skipped: skippedLoans, error });
  }
  if (!out.length) return skippedReport(nowIso, asOf, notDue.join("; ") || "nothing due", loans.length);
  const sum = (k: keyof Pick<ReviewProgramRun, "reviewed" | "candidates" | "watching" | "not_now" | "excluded" | "analyst_turns" | "analyst_skipped" | "expired">): number => out.reduce((a, p) => a + p[k], 0);
  const errors = out.filter((p) => p.error).map((p) => `${p.program_id}: ${p.error}`);
  const line = `partner book review ${asOf}: programs=${out.length} monitored=${loans.length} reviewed=${sum("reviewed")} candidates=${sum("candidates")} watching=${sum("watching")} not_now=${sum("not_now")} excluded=${sum("excluded")} analyst_turns=${sum("analyst_turns")} analyst_skipped=${sum("analyst_skipped")} offers=${out.reduce((a, p) => a + p.offers.delivered, 0)} portal_only=${out.reduce((a, p) => a + p.offers.portal_only, 0)} expired=${sum("expired")} skipped=${out.reduce((a, p) => a + p.skipped.length, 0)}${notDue.length ? ` not_due=${JSON.stringify(notDue)}` : ""}${errors.length ? ` errors=${JSON.stringify(errors)}` : ""}`;
  log?.info("partner book review run", { at: nowIso, as_of_date: asOf, programs: out, not_due: notDue, line });
  return { at: nowIso, as_of_date: asOf, ran: true, reason: null, monitored_loans: loans.length, programs: out, line };
}
