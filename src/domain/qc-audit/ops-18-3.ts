/**
 * §18.3 STAR performance measurement — per-T-id rule functions layered on ./star.ts (rateBps, metricResult,
 * composite) and the monthly run's operations: compute → ingest → reconcile → investigate → report, each returning the
 * registry event that satisfies its timer (`star.metrics.computed`, `star.scorecard.ingested`, `star.reconciled`,
 * `star.config.published`, `star.partner_report.delivered`). Pure; bigint-free (the process has no money).
 *
 * Where ./star.ts (shared, read-only) is wrong for a T-id the corrected rule lives here:
 *   - starClocks counts +7 calendar days for the "5 business days" ingest row → scorecardClocks (business days);
 *   - inquiryAllowed ignores the `officer` sign-off the guardrail requires → fnmaErrorInquiryGate;
 *   - reconcile rate-compares a suppressed metric as 0 bps → reconcileMetric (suppressed metrics are not rate-reconciled);
 *   - beyondTimeframe has no six-month reporting window → beyondTimeframeTransition;
 *   - includedInMetric compares full dates (a mid-month transfer-in stretches to three base months) → transfereeIncluded;
 *   - confidentialityFilter only matches "STAR-level|performer|recognition|rating" → starResultsMention;
 *   - composite takes an injected percentile → normalizedScore derives it (vs. Comp when a scorecard exists, else vs.
 *     the internal prior-12-month distribution) and compositeWithReferences feeds it in.
 *
 * Confidentiality is keyed on the report's classification, not only on its wording: a report flagged
 * `carries_star_data` is withheld from every third-party recipient whatever the text says (the text screen is the
 * second net, for drafts nobody classified). `star.scorecard.ingested` is emitted only once every scorecard row is
 * structured (a rejected row waits for manual entry), and `star.reconciled` only once every metric the month computed
 * has been compared and is within tolerance, explained or suppressed — the registry row's parenthetical.
 *
 * Verified sources quoted below: STAR FAQs (Apr. 6, 2026) — "Loans are excluded from the transferor's metrics in the
 * transfer month. Transferred loans are excluded from the transferee's calculations for two months following transfer
 * (except for 6-month Mod and Payment Deferral Performance metrics)."; "STAR Scorecard results are confidential, and
 * a servicer may not disclose STAR Scorecard results to any third parties by any means"; "No scores for metrics with
 * <30 loans in denominator"; Transition to Beyond Timeframe "measures the number of loans that are within 180 days of
 * the state foreclosure time frame that transition to beyond time frame status over a six-month reporting period."
 */
import { type PlainDate, addMonths, endOfMonth, plainDate, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";
import { type Metric, type MetricResult, type VarianceClass, MIN_DENOMINATOR, composite, metricResult, rateBps } from "./star.ts";
import type { Actor, DomainEvent, EventStore } from "../../kernel/events/index.ts";

export const STAR_METRICS: readonly Metric[] = ["T60", "C60", "RET_EFF", "MOD6", "PD6", "BEYOND_TF"];
/** Metrics the transferee exclusion does not touch (FAQ: "except for 6-month Mod and Payment Deferral Performance metrics"). */
export const TRANSFEREE_EXEMPT_METRICS: readonly Metric[] = ["MOD6", "PD6"];
/** "two months following transfer" — the transfer month and the next one, counted at month granularity. */
export const TRANSFEREE_EXCLUSION_MONTHS = 2;
export type StarView = "master_partner" | "acting_supermortgage" | "internal_total";
export type StarRunState = "snapshot_built" | "metrics_computed" | "scorecard_awaited" | "scorecard_ingested" | "reconciled" | "reported" | "variance_investigation" | "suppressed";
export type PeerGroup = "Strategic" | "Premier" | "Select";

const monthOf = (d: PlainDate): string => d.slice(0, 7);
const firstOfMonth = (d: PlainDate): PlainDate => plainDate(`${monthOf(d)}-01`);
const monthStart = (yyyyMm: string): PlainDate => plainDate(`${yyyyMm}-01`);

// ---------------------------------------------------------------- peer groups and weights (verified FAQ figures)
/** "Strategic ≥ 450,000; Premier 130,000–449,999; Select 40,000–129,999" by total Fannie Mae loan count as of January 1. */
export function peerGroup(loanCountJan1: number): PeerGroup | null {
  if (loanCountJan1 >= 450_000) return "Strategic";
  if (loanCountJan1 >= 130_000) return "Premier";
  if (loanCountJan1 >= 40_000) return "Select";
  return null;
}
/** 2026 weights — Strategic/Premier: T60 30, C60 25, RET_EFF 15, MOD6 10, PD6 10, BEYOND_TF 10; Select: T60 45, C60 40, RET_EFF 15. */
export const STAR_WEIGHTS_2026: Readonly<Record<PeerGroup, Readonly<Partial<Record<Metric, number>>>>> = {
  Strategic: { T60: 30, C60: 25, RET_EFF: 15, MOD6: 10, PD6: 10, BEYOND_TF: 10 },
  Premier: { T60: 30, C60: 25, RET_EFF: 15, MOD6: 10, PD6: 10, BEYOND_TF: 10 },
  Select: { T60: 45, C60: 40, RET_EFF: 15 },
};

// ---------------------------------------------------------------- transfers (T3)
/**
 * 18.3-T3 common rule at month granularity: a transferred-in loan is out of every metric but MOD6/PD6 for the transfer
 * month and the month after, whatever the day of transfer; a transferred-out loan is out of everything in the transfer month.
 * (./star.ts includedInMetric compares full dates, which stretches a mid-month transfer-in to three base months.)
 */
export function transfereeIncluded(metric: Metric, baseMonth: PlainDate, transferredIn: PlainDate | null, transferredOut: PlainDate | null = null): boolean {
  if (transferredOut !== null && monthOf(transferredOut) === monthOf(baseMonth)) return false;
  if (transferredIn === null || TRANSFEREE_EXEMPT_METRICS.includes(metric)) return true;
  return monthOf(baseMonth) >= monthOf(addMonths(firstOfMonth(transferredIn), TRANSFEREE_EXCLUSION_MONTHS));
}

export interface TransfereeMonth { readonly base_month: string; readonly excluded_from: Metric[]; readonly included_in: Metric[]; }
export interface TransfereeExclusionWindow {
  readonly transferred_in: PlainDate;
  /** Base months (YYYY-MM) in which the loan is excluded from every metric but MOD6/PD6. */
  readonly excluded_months: string[];
  /** First base month (YYYY-MM) in which the loan counts in all metrics. */
  readonly first_full_month: string;
  readonly excluded_metrics: Metric[];
  readonly always_included: Metric[];
  readonly by_month: TransfereeMonth[];
}
/** 18.3-T3: the schedule for one transfer-in — which metrics the loan is in, month by month, through its first full month. */
export function transfereeExclusionWindow(transferredIn: PlainDate): TransfereeExclusionWindow {
  const start = firstOfMonth(transferredIn);
  const by_month: TransfereeMonth[] = [];
  for (let k = 0; k <= TRANSFEREE_EXCLUSION_MONTHS; k++) {
    const base = addMonths(start, k);
    const included_in = STAR_METRICS.filter((m) => transfereeIncluded(m, base, transferredIn, null));
    by_month.push({ base_month: monthOf(base), excluded_from: STAR_METRICS.filter((m) => !included_in.includes(m)), included_in });
  }
  const excluded_months = by_month.filter((r) => r.excluded_from.length > 0).map((r) => r.base_month);
  return {
    transferred_in: transferredIn,
    excluded_months,
    first_full_month: monthOf(addMonths(start, TRANSFEREE_EXCLUSION_MONTHS)),
    excluded_metrics: STAR_METRICS.filter((m) => !TRANSFEREE_EXEMPT_METRICS.includes(m)),
    always_included: [...TRANSFEREE_EXEMPT_METRICS],
    by_month,
  };
}

// ---------------------------------------------------------------- monthly compute (T1, T2, T4; SM_STAR_COMPUTE_MONTHLY_BD5)
/** Timer row: Fannie Mae period close (BD2) → metrics computed by BD5 `business_days_fannie_et` of the month after the reporting period; sev-3. */
export function computeClock(i: { period_month: string; cal?: Calendar }): { code: "SM_STAR_COMPUTE_MONTHLY_BD5"; period_end: PlainDate; period_close_bd2: PlainDate; due: PlainDate; satisfied_by: "star.metrics.computed"; breach: "sev3" } {
  const cal = i.cal ?? fannieEt;
  const period_end = endOfMonth(monthStart(i.period_month));
  return { code: "SM_STAR_COMPUTE_MONTHLY_BD5", period_end, period_close_bd2: addBusinessDays(period_end, 2, cal), due: addBusinessDays(period_end, 5, cal), satisfied_by: "star.metrics.computed", breach: "sev3" };
}
/** The trigger the registry row is armed on: the §5 period close (`investor_reporting_periods.closed{checklist_complete=true}`, payload `periodAnchors()` — `period_end` is the anchor). */
export const STAR_COMPUTE_TRIGGER = "investor_reporting_periods.closed";
/**
 * The compute clock from the period-close event itself. The anchor is the period's last calendar day (`period_end`, or
 * the `period` YYYY-MM the §5 payload carries); a payload that carries neither is anchored on the month *before* the
 * close date — a BD2 close always falls in the month after the period — so the clock lands on BD5 of that month and
 * never on BD7 (which +5 business days from the BD2 close date itself would give).
 */
export function computeClockFromPeriodClose(i: { payload: { period_end?: PlainDate | string; period?: string; checklist_complete?: boolean }; closed_on: PlainDate; cal?: Calendar }): ReturnType<typeof computeClock> & { anchored_on: "period_end" | "period" | "closed_on_prior_month"; armed: boolean } {
  const cal = i.cal ?? fannieEt;
  const period_month = typeof i.payload.period_end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(i.payload.period_end) ? monthOf(plainDate(i.payload.period_end)) : typeof i.payload.period === "string" && /^\d{4}-\d{2}$/.test(i.payload.period) ? i.payload.period : monthOf(addMonths(firstOfMonth(i.closed_on), -1));
  const anchored_on = typeof i.payload.period_end === "string" ? "period_end" : typeof i.payload.period === "string" ? "period" : "closed_on_prior_month";
  return { ...computeClock({ period_month, cal }), anchored_on, armed: i.payload.checklist_complete !== false };
}

/** One metric's cohort after the population filter: `population` loans at base, `excluded` of them dropped by a verified exclusion, `numerator` hits. */
export interface CohortCounts { readonly metric: Metric; readonly population: number; readonly excluded: number; readonly numerator: number; }
export interface StarMetricResultRow extends MetricResult {
  readonly program_year: number; readonly as_of_month: string; readonly view: StarView; readonly metric_code: Metric; readonly config_version: string;
  readonly computed_at: string; readonly comp_rate_bps: number | null;
  /** Hash of the `loan_delinquency_months` population the row was computed from (spec data model; the audit's "monthly population hashes"). */
  readonly population_hash: string | null;
}
/**
 * 18.3-T1/T2/T4 + `star.metrics.computed`: denominators are the population less the verified exclusions (C60 drops
 * loans in an active repayment plan at the base month), rates are `round_half_up(numerator × 10000 / denominator)` in
 * bps, and a denominator under 30 is `suppressed` (rate null, still reported internally with the flag). Every result
 * row carries the population hash so it can be tied back to the snapshot it was computed from.
 */
export function computeMetrics(i: { program_year: number; as_of_month: string; view: StarView; config_version: string; cohorts: readonly CohortCounts[]; computed_at: string; population_hash?: string }): {
  results: StarMetricResultRow[]; suppressed: Metric[]; state: "metrics_computed"; event: { type: "star.metrics.computed"; payload: { as_of_month: string; view: StarView; config_version: string; computed_at: string; metrics: number; suppressed: Metric[]; population_hash: string | null } };
} {
  const population_hash = i.population_hash ?? null;
  const results = i.cohorts.map((c) => {
    if (c.excluded > c.population || c.numerator < 0 || c.numerator > c.population - c.excluded) throw new RangeError(`${c.metric}: numerator ${c.numerator} / population ${c.population} − excluded ${c.excluded} is not a cohort`);
    const r = metricResult(c.metric, c.numerator, c.population - c.excluded);
    return { ...r, program_year: i.program_year, as_of_month: i.as_of_month, view: i.view, metric_code: c.metric, config_version: i.config_version, computed_at: i.computed_at, comp_rate_bps: null, population_hash };
  });
  const suppressed = results.filter((r) => r.suppressed).map((r) => r.metric);
  return { results, suppressed, state: "metrics_computed", event: { type: "star.metrics.computed", payload: { as_of_month: i.as_of_month, view: i.view, config_version: i.config_version, computed_at: i.computed_at, metrics: results.length, suppressed, population_hash } } };
}

/** 18.3-T4: the composite takes only unsuppressed metrics, weighted for the peer group; a suppressed metric contributes nothing. */
export function compositeFor(results: readonly MetricResult[], group: PeerGroup, percentile: (m: Metric) => number): { composite: number; included: Metric[]; excluded_suppressed: Metric[] } {
  const weights = STAR_WEIGHTS_2026[group];
  const weighted = results.filter((r) => weights[r.metric] !== undefined);
  const included = weighted.filter((r) => !r.suppressed).map((r) => r.metric);
  return { composite: composite(weighted.map((r) => ({ rate_bps: r.rate_bps, suppressed: r.suppressed, weight: weights[r.metric]!, percentile: percentile(r.metric) }))), included, excluded_suppressed: weighted.filter((r) => r.suppressed).map((r) => r.metric) };
}

// ---------------------------------------------------------------- composite normalization ("percentile vs. Comp, else vs. the internal prior-12-month distribution")
/** Direction of each metric: T60 and BEYOND_TF are transition rates (lower is better); the cure/retention/performance rates are higher-is-better. */
export const LOWER_IS_BETTER: Readonly<Record<Metric, boolean>> = { T60: true, C60: false, RET_EFF: false, MOD6: false, PD6: false, BEYOND_TF: true };
/** Empirical percentile of `value` within `reference` (0–100, ties count half), direction-aware: the share of the reference the metric beats. */
export function percentileRank(value: number, reference: readonly number[], lowerIsBetter: boolean): number {
  if (reference.length === 0) throw new RangeError("percentileRank: empty reference distribution");
  let beats = 0, ties = 0;
  for (const r of reference) { if (r === value) ties++; else if (lowerIsBetter ? value < r : value > r) beats++; }
  return Math.round(((beats + 0.5 * ties) / reference.length) * 10000) / 100;
}
export interface NormalizationReference { readonly comp_rates_bps: readonly number[]; readonly prior_12_month_bps: readonly number[]; }
/**
 * `normalized_score_i`: the metric's percentile vs. Comp when a scorecard exists (this month's Comp and any earlier
 * Comps on file for the metric), else vs. the internal prior-12-month distribution of the metric's own rates. A
 * suppressed metric has no score (null) and is out of the composite; a live metric with no reference at all (first
 * month, no scorecard) cannot be normalized — RangeError, the composite is not reported.
 */
export function normalizedScore(i: { metric: Metric; rate_bps: number | null; suppressed: boolean; reference: NormalizationReference }): { percentile: number | null; basis: "comp" | "internal_prior_12_months" | "suppressed"; reference_size: number } {
  if (i.suppressed || i.rate_bps === null) return { percentile: null, basis: "suppressed", reference_size: 0 };
  const comp = i.reference.comp_rates_bps, prior = i.reference.prior_12_month_bps.slice(-12);
  if (comp.length > 0) return { percentile: percentileRank(i.rate_bps, comp, LOWER_IS_BETTER[i.metric]), basis: "comp", reference_size: comp.length };
  if (prior.length > 0) return { percentile: percentileRank(i.rate_bps, prior, LOWER_IS_BETTER[i.metric]), basis: "internal_prior_12_months", reference_size: prior.length };
  throw new RangeError(`${i.metric}: no Comp and no prior-12-month distribution to normalize against`);
}
/** `composite = Σ weight_i × normalized_score_i` over the peer group's weighted, unsuppressed metrics, each score derived by normalizedScore. */
export function compositeWithReferences(results: readonly MetricResult[], group: PeerGroup, references: Readonly<Partial<Record<Metric, NormalizationReference>>>): ReturnType<typeof compositeFor> & { scores: { metric: Metric; percentile: number | null; basis: "comp" | "internal_prior_12_months" | "suppressed" }[] } {
  const weights = STAR_WEIGHTS_2026[group];
  const scores = results.filter((r) => weights[r.metric] !== undefined).map((r) => {
    const s = normalizedScore({ metric: r.metric, rate_bps: r.rate_bps, suppressed: r.suppressed, reference: references[r.metric] ?? { comp_rates_bps: [], prior_12_month_bps: [] } });
    return { metric: r.metric, percentile: s.percentile, basis: s.basis };
  });
  const byMetric = new Map(scores.map((s) => [s.metric, s.percentile ?? 0] as const));
  return { ...compositeFor(results, group, (m) => byMetric.get(m) ?? 0), scores };
}

// ---------------------------------------------------------------- BEYOND_TF (T7)
/** "within 180 days of the state foreclosure time frame" at base; "transition to beyond time frame status over a six-month reporting period". */
export const BEYOND_TF_NEAR_DAYS = 180;
export const BEYOND_TF_REPORTING_MONTHS = 6;
/**
 * 18.3-T7: a loan is in the denominator when (allowed + LL-2025-01 allowable delays) − elapsed at base is between 0 and
 * 180 days; it is in the numerator only when a later monthly snapshot inside the six-month reporting period
 * (base + 1 … base + 6) first shows elapsed days beyond the allowed time frame. Later transitions do not count.
 */
export function beyondTimeframeTransition(i: { allowed_days: number; elapsed_at_base: number; base_month: PlainDate; elapsed_by_month: readonly { as_of_month: PlainDate; fc_days_elapsed: number }[]; allowable_delay_days?: number }): {
  allowed_effective: number; days_remaining: number; in_denominator: boolean; in_numerator: boolean; window_months: string[]; transition_month: string | null;
} {
  const allowed_effective = i.allowed_days + (i.allowable_delay_days ?? 0);
  const days_remaining = allowed_effective - i.elapsed_at_base;
  const in_denominator = days_remaining >= 0 && days_remaining <= BEYOND_TF_NEAR_DAYS;
  const base = firstOfMonth(i.base_month);
  const window_months = Array.from({ length: BEYOND_TF_REPORTING_MONTHS }, (_, k) => monthOf(addMonths(base, k + 1)));
  const first = [...i.elapsed_by_month].sort((a, b) => (a.as_of_month < b.as_of_month ? -1 : 1)).find((r) => monthOf(r.as_of_month) > monthOf(base) && r.fc_days_elapsed > allowed_effective);
  const transition_month = first ? monthOf(first.as_of_month) : null;
  return { allowed_effective, days_remaining, in_denominator, in_numerator: in_denominator && transition_month !== null && window_months.includes(transition_month), window_months, transition_month };
}

// ---------------------------------------------------------------- scorecard ingestion (T8; SM_STAR_SCORECARD_INGEST_5BD / SM_STAR_RECON_10BD)
export interface ScorecardIngestClock { readonly code: "SM_STAR_SCORECARD_INGEST_5BD"; readonly anchor: PlainDate; readonly due: PlainDate; readonly satisfied_by: "star.scorecard.ingested"; readonly breach: "sev3"; }
export interface ReconClock { readonly code: "SM_STAR_RECON_10BD"; readonly anchor: PlainDate; readonly anchored_on: "ingested_at" | "ingest_deadline"; readonly due: PlainDate; readonly satisfied_by: "star.reconciled"; readonly breach: "sev2_partner_report"; }
/**
 * 18.3-T8 clocks: report 511 available → ingested within 5 business days (sev-3); ingested → reconciled within 10
 * business days (sev-2 → partner report). The reconciliation clock anchors on the actual `ingested_at`; until the
 * scorecard is in, its latest possible due date is projected from the ingest deadline. (./star.ts starClocks counts
 * +7 calendar days, which only coincides with 5 BD around a Monday holiday.)
 */
export function scorecardClocks(i: { available_on: PlainDate; ingested_at?: PlainDate | null; cal?: Calendar }): { ingest: ScorecardIngestClock; reconcile: ReconClock } {
  const cal = i.cal ?? servicer;
  const ingestDue = addBusinessDays(i.available_on, 5, cal);
  const anchor = i.ingested_at ?? ingestDue;
  return {
    ingest: { code: "SM_STAR_SCORECARD_INGEST_5BD", anchor: i.available_on, due: ingestDue, satisfied_by: "star.scorecard.ingested", breach: "sev3" },
    reconcile: { code: "SM_STAR_RECON_10BD", anchor, anchored_on: i.ingested_at ? "ingested_at" : "ingest_deadline", due: addBusinessDays(anchor, 10, cal), satisfied_by: "star.reconciled", breach: "sev2_partner_report" },
  };
}
/** `not_armed`: the registry row's trigger has not fired yet (SM_STAR_RECON_10BD is triggered by `star.scorecard.ingested`, so it cannot breach before ingestion). */
export type TimerStatus = "not_armed" | "satisfied" | "open" | "breached";
export interface ClockStatus { readonly code: string; readonly due: PlainDate; readonly status: TimerStatus; readonly satisfied_on: PlainDate | null; readonly breach: { kind: "sev3" | "sev2"; action: string } | null; }
/**
 * T8 "else timers breach": each clock is satisfied by its event on/before due, open while due is ahead, breached after
 * due (or satisfied late). Until the scorecard is ingested only the ingest clock runs; the reconciliation clock is
 * `not_armed` (its `due` is the projection from the ingest deadline) and carries no sev-2 — the registry row is
 * triggered by `star.scorecard.ingested` and anchored on `ingested_at`.
 */
export function scorecardClockStatus(i: { available_on: PlainDate; ingested_at: PlainDate | null; reconciled_at: PlainDate | null; today: PlainDate; cal?: Calendar }): { ingest: ClockStatus; reconcile: ClockStatus; state: StarRunState } {
  const c = scorecardClocks({ available_on: i.available_on, ingested_at: i.ingested_at ?? null, ...(i.cal ? { cal: i.cal } : {}) });
  const judge = (due: PlainDate, doneOn: PlainDate | null): TimerStatus => (doneOn !== null ? (doneOn <= due ? "satisfied" : "breached") : i.today > due ? "breached" : "open");
  const ingestStatus = judge(c.ingest.due, i.ingested_at);
  const reconStatus: TimerStatus = i.ingested_at === null ? "not_armed" : judge(c.reconcile.due, i.reconciled_at);
  return {
    ingest: { code: c.ingest.code, due: c.ingest.due, status: ingestStatus, satisfied_on: i.ingested_at, breach: ingestStatus === "breached" ? { kind: "sev3", action: "sev-3: scorecard not ingested within 5 business days of availability; retry next BD" } : null },
    reconcile: { code: c.reconcile.code, due: c.reconcile.due, status: reconStatus, satisfied_on: i.reconciled_at, breach: reconStatus === "breached" ? { kind: "sev2", action: "sev-2 → partner report: reconciliation not closed within 10 business days of ingestion" } : null },
    state: i.reconciled_at !== null ? "reconciled" : i.ingested_at !== null ? "scorecard_ingested" : "scorecard_awaited",
  };
}

/** A scorecard row; `fnma_rate_bps` null = Fannie Mae published no score ("No scores for metrics with <30 loans in denominator"). */
export interface ScorecardRowInput { readonly metric_code: Metric; readonly fnma_numerator: number | null; readonly fnma_denominator: number | null; readonly fnma_rate_bps: number | null; readonly comp_rate_bps: number | null; readonly rank: number | null; readonly peer_group: PeerGroup | null; }
export interface StarScorecardRow extends ScorecardRowInput { readonly view: StarView; readonly as_of_month: string; readonly document_id: string; readonly parsed_at: string; }
/**
 * Scorecard ingestion (PDF/Excel → structured; extraction validated against the numeric totals): a row whose stated
 * rate does not reproduce from its own numerator/denominator is rejected for manual entry, and the scorecard is not
 * ingested until every row is structured — `star.scorecard.ingested` (the SM_STAR_SCORECARD_INGEST_5BD satisfaction
 * and the SM_STAR_RECON_10BD anchor, `ingested_at`) is withheld while any metric is `pending_manual_entry`, so the
 * ingest clock keeps pressing for the console entry and no metric can drop out of the reconciliation loop. Re-run
 * with the corrected rows to complete. A parse failure never blocks the internal computation.
 */
export function ingestScorecard(i: { view: StarView; as_of_month: string; document_id: string; rows: readonly ScorecardRowInput[]; parsed_at: string; ingested_on: PlainDate }): {
  scorecards: StarScorecardRow[]; rejected: { metric_code: Metric; reason: string }[]; pending_manual_entry: Metric[]; state: "scorecard_ingested" | "scorecard_awaited";
  event: { type: "star.scorecard.ingested"; payload: { view: StarView; as_of_month: string; document_id: string; ingested_at: PlainDate; metrics: number; unscored: Metric[] } } | null;
  manual_entry_task: { kind: "human_portal_task"; task: "star_scorecard_manual_entry"; document_id: string; metrics: Metric[] } | null;
} {
  if (i.rows.length === 0) throw new RangeError(`scorecard ${i.document_id}: no rows parsed`);
  const scorecards: StarScorecardRow[] = []; const rejected: { metric_code: Metric; reason: string }[] = [];
  const seen = new Set<Metric>();
  for (const r of i.rows) {
    if (seen.has(r.metric_code)) throw new RangeError(`scorecard ${i.document_id}: ${r.metric_code} appears twice`);
    seen.add(r.metric_code);
    if (r.fnma_rate_bps !== null && r.fnma_numerator !== null && r.fnma_denominator !== null && r.fnma_denominator > 0 && rateBps(r.fnma_numerator, r.fnma_denominator) !== r.fnma_rate_bps) { rejected.push({ metric_code: r.metric_code, reason: `stated ${r.fnma_rate_bps} bps ≠ ${rateBps(r.fnma_numerator, r.fnma_denominator)} bps from ${r.fnma_numerator}/${r.fnma_denominator}; manual entry` }); continue; }
    scorecards.push({ ...r, view: i.view, as_of_month: i.as_of_month, document_id: i.document_id, parsed_at: i.parsed_at });
  }
  const pending_manual_entry = rejected.map((r) => r.metric_code);
  const ok = pending_manual_entry.length === 0;
  return {
    scorecards, rejected, pending_manual_entry, state: ok ? "scorecard_ingested" : "scorecard_awaited",
    event: ok ? { type: "star.scorecard.ingested", payload: { view: i.view, as_of_month: i.as_of_month, document_id: i.document_id, ingested_at: i.ingested_on, metrics: scorecards.length, unscored: scorecards.filter((s) => s.fnma_rate_bps === null).map((s) => s.metric_code) } } : null,
    manual_entry_task: ok ? null : { kind: "human_portal_task", task: "star_scorecard_manual_entry", document_id: i.document_id, metrics: pending_manual_entry },
  };
}

// ---------------------------------------------------------------- reconciliation and variance investigation (T5)
/** "tolerance ±25 bps or ±2 loans in numerator/denominator, whichever is larger" (open question 3 default). */
export const RECON_TOLERANCE = { bps: 25, loans: 2 } as const;
/** `awaiting_scorecard`: the metric was computed but has no scorecard row yet (rejected for manual entry, or absent from the parsed document) — it blocks `star.reconciled` like an open investigation. */
export type ReconStatus = "reconciled" | "variance_investigation" | "explained" | "suppressed" | "awaiting_scorecard";
export interface LoanLevelDiffs { readonly ours_not_theirs: string[]; readonly theirs_not_ours: string[]; readonly source: "scorecard_loan_level" | "fnma_connect_delinquency_reports" | "pending_loan_level_download"; }
export interface StarReconciliationRow {
  readonly as_of_month: string; readonly metric_code: Metric; readonly internal_rate_bps: number | null; readonly fnma_rate_bps: number | null; readonly delta_bps: number | null;
  readonly loan_diff: number | null; readonly within_tolerance: boolean; readonly loan_level_diffs: LoanLevelDiffs | null;
  readonly classification: VarianceClass | null; readonly evidence_refs: string[]; readonly explanation: string | null; readonly status: ReconStatus;
}
/**
 * 18.3-T5: internal vs. scorecard per metric. Inside tolerance → `reconciled`; beyond it → a `variance_investigation`
 * opens carrying the loan-level diff (ours-not-theirs / theirs-not-ours from the scorecard's loan-level download or the
 * Fannie Mae Connect delinquency reports). A suppressed internal metric (denominator < 30) is not rate-reconciled at
 * all — it is reported with the flag (./star.ts reconcile compares it as 0 bps). No scorecard row (`scorecard: null`)
 * → `awaiting_scorecard`. A scorecard row without a score (Fannie Mae's own < 30 suppression) reconciles only when
 * the denominators agree within the loan tolerance; otherwise the population difference is investigated.
 */
export function reconcileMetric(i: { as_of_month: string; internal: MetricResult; scorecard: { fnma_rate_bps: number | null; fnma_numerator: number | null; fnma_denominator: number | null } | null; our_loans?: readonly string[]; their_loans?: readonly string[]; diff_source?: LoanLevelDiffs["source"] }): StarReconciliationRow {
  const base = { as_of_month: i.as_of_month, metric_code: i.internal.metric, fnma_rate_bps: i.scorecard?.fnma_rate_bps ?? null, classification: null, evidence_refs: [] as string[], explanation: null };
  const internal_rate_bps = i.internal.suppressed ? null : i.internal.rate_bps;
  if (i.scorecard === null) return { ...base, internal_rate_bps, delta_bps: null, loan_diff: null, within_tolerance: false, loan_level_diffs: null, status: "awaiting_scorecard", explanation: "no scorecard row for the metric yet (pending manual entry or absent from the parsed document)" };
  if (i.internal.suppressed || i.internal.rate_bps === null) return { ...base, internal_rate_bps: null, delta_bps: null, loan_diff: null, within_tolerance: true, loan_level_diffs: null, status: "suppressed" };
  const loan_diff = i.scorecard.fnma_numerator !== null && i.scorecard.fnma_denominator !== null ? Math.max(Math.abs(i.internal.numerator - i.scorecard.fnma_numerator), Math.abs(i.internal.denominator - i.scorecard.fnma_denominator)) : null;
  const ours = new Set(i.our_loans ?? []), theirs = new Set(i.their_loans ?? []);
  const haveLists = i.our_loans !== undefined && i.their_loans !== undefined;
  const diffs = (): LoanLevelDiffs => ({ ours_not_theirs: [...ours].filter((l) => !theirs.has(l)).sort(), theirs_not_ours: [...theirs].filter((l) => !ours.has(l)).sort(), source: haveLists ? (i.diff_source ?? "scorecard_loan_level") : "pending_loan_level_download" });
  if (i.scorecard.fnma_rate_bps === null) {
    const denominatorsAgree = i.scorecard.fnma_denominator !== null && Math.abs(i.internal.denominator - i.scorecard.fnma_denominator) <= RECON_TOLERANCE.loans;
    if (denominatorsAgree) return { ...base, internal_rate_bps, delta_bps: null, loan_diff, within_tolerance: true, loan_level_diffs: null, status: "reconciled", explanation: "Fannie Mae published no score (denominator < 30); denominators agree within tolerance" };
    return { ...base, internal_rate_bps, delta_bps: null, loan_diff, within_tolerance: false, loan_level_diffs: diffs(), status: "variance_investigation", explanation: "Fannie Mae published no score (denominator < 30) but the internal denominator is scored — population difference" };
  }
  const delta_bps = i.internal.rate_bps - i.scorecard.fnma_rate_bps;
  const within_tolerance = Math.abs(delta_bps) <= RECON_TOLERANCE.bps || (loan_diff !== null && loan_diff <= RECON_TOLERANCE.loans);
  if (within_tolerance) return { ...base, internal_rate_bps, delta_bps, loan_diff, within_tolerance, loan_level_diffs: null, status: "reconciled" };
  return { ...base, internal_rate_bps, delta_bps, loan_diff, within_tolerance, loan_level_diffs: diffs(), status: "variance_investigation" };
}
/** Closing a variance investigation needs a classification and at least one evidence ref; nothing else moves it out of `variance_investigation`. */
export function closeVarianceInvestigation(row: StarReconciliationRow, close: { classification: VarianceClass | null; evidence_refs: readonly string[]; explanation: string }): {
  closed: boolean; row: StarReconciliationRow; refusal: { code: "VARIANCE_NOT_OPEN" | "VARIANCE_CLOSE_REQUIRES_CLASSIFICATION" | "VARIANCE_CLOSE_REQUIRES_EVIDENCE"; reason: string } | null;
  follow_up: "link_reporting_evidence" | "fix_config" | "finding_to_18_1" | "fnma_inquiry" | null;
} {
  if (row.status !== "variance_investigation") return { closed: false, row, refusal: { code: "VARIANCE_NOT_OPEN", reason: `${row.metric_code} ${row.as_of_month} is ${row.status}, not under investigation` }, follow_up: null };
  if (close.classification === null) return { closed: false, row, refusal: { code: "VARIANCE_CLOSE_REQUIRES_CLASSIFICATION", reason: "a variance investigation closes only with a classification (reporting timing / definition mismatch / data defect / Fannie Mae error)" }, follow_up: null };
  const refs = [...new Set(close.evidence_refs.filter((r) => r.trim() !== ""))];
  if (refs.length === 0) return { closed: false, row, refusal: { code: "VARIANCE_CLOSE_REQUIRES_EVIDENCE", reason: "a variance investigation closes only with evidence refs (Section 5 ack/reject records, config diff, 18.1 finding or the Fannie Mae loan-level download)" }, follow_up: null };
  const follow_up = close.classification === "reporting_timing" ? "link_reporting_evidence" : close.classification === "definition_mismatch" ? "fix_config" : close.classification === "data_defect" ? "finding_to_18_1" : "fnma_inquiry";
  return { closed: true, row: { ...row, classification: close.classification, evidence_refs: refs, explanation: close.explanation, status: "explained" }, refusal: null, follow_up };
}
/**
 * SM_STAR_RECON_10BD is satisfied by `star.reconciled` "(all metrics within tolerance or explained)": the rows are
 * checked against `computed_metrics` — the metric set `star.metrics.computed` produced for the month — so a subset,
 * an empty list, or a metric still `awaiting_scorecard` never closes the month. Rows for metrics the month did not
 * compute, duplicates, and an empty row list are RangeErrors.
 */
export function reconcileMonth(i: { as_of_month: string; view: StarView; computed_metrics: readonly Metric[]; rows: readonly StarReconciliationRow[]; reconciled_on: PlainDate }): {
  state: "reconciled" | "variance_investigation" | "scorecard_ingested"; open_investigations: Metric[]; missing_metrics: Metric[]; awaiting_scorecard: Metric[];
  event: { type: "star.reconciled"; payload: { as_of_month: string; view: StarView; reconciled_at: PlainDate; metrics: number; within_tolerance: Metric[]; explained: Metric[]; suppressed: Metric[] } } | null;
} {
  if (i.computed_metrics.length === 0) throw new RangeError(`${i.as_of_month} ${i.view}: no metrics computed for the month — nothing to reconcile`);
  if (i.rows.length === 0) throw new RangeError(`${i.as_of_month} ${i.view}: no reconciliation rows`);
  const seen = new Set<Metric>();
  for (const r of i.rows) {
    if (r.as_of_month !== i.as_of_month) throw new RangeError(`${r.metric_code}: row is for ${r.as_of_month}, not ${i.as_of_month}`);
    if (!i.computed_metrics.includes(r.metric_code)) throw new RangeError(`${r.metric_code}: not among the metrics computed for ${i.as_of_month} ${i.view}`);
    if (seen.has(r.metric_code)) throw new RangeError(`${r.metric_code}: reconciled twice for ${i.as_of_month}`);
    seen.add(r.metric_code);
  }
  const open_investigations = i.rows.filter((r) => r.status === "variance_investigation").map((r) => r.metric_code);
  const awaiting_scorecard = i.rows.filter((r) => r.status === "awaiting_scorecard").map((r) => r.metric_code);
  const missing_metrics = i.computed_metrics.filter((m) => !seen.has(m));
  if (open_investigations.length > 0) return { state: "variance_investigation", open_investigations, missing_metrics, awaiting_scorecard, event: null };
  if (missing_metrics.length > 0 || awaiting_scorecard.length > 0) return { state: "scorecard_ingested", open_investigations, missing_metrics, awaiting_scorecard, event: null };
  const by = (s: ReconStatus) => i.rows.filter((r) => r.status === s).map((r) => r.metric_code);
  return { state: "reconciled", open_investigations, missing_metrics, awaiting_scorecard, event: { type: "star.reconciled", payload: { as_of_month: i.as_of_month, view: i.view, reconciled_at: i.reconciled_on, metrics: i.rows.length, within_tolerance: by("reconciled"), explained: by("explained"), suppressed: by("suppressed") } } };
}

// ---------------------------------------------------------------- guardrails (T6, "never alter delinquency history")
export const FNMA_ERROR_GUARDRAIL_CITATION = "§18.3 guardrails: classification \"Fannie Mae error\" requires two independent evidence refs and `officer` sign-off before any inquiry is sent";
/** Evidence refs are `source:id`; two refs are independent when they come from different sources. */
export function independentEvidenceSources(refs: readonly string[]): string[] {
  return [...new Set(refs.map((r) => r.trim()).filter((r) => r !== "").map((r) => (r.includes(":") ? r.slice(0, r.indexOf(":")) : r)))];
}
/**
 * 18.3-T6: a "Fannie Mae error" inquiry to the Servicing Representative / STAR mailbox cannot be sent with fewer than two
 * independent evidence refs, nor without `officer` sign-off (external inquiries escalate to the officer). Other
 * classifications raise no external inquiry. (./star.ts inquiryAllowed counts refs only and ignores the sign-off.)
 */
export function fnmaErrorInquiryGate(i: { classification: VarianceClass; evidence_refs: readonly string[]; officer_signoff: { officer_id: string; signed_at: string } | null }): {
  allowed: boolean; independent_sources: string[]; refusal: { code: "FNMA_ERROR_EVIDENCE_REFS" | "FNMA_ERROR_OFFICER_SIGNOFF"; citation: string; reason: string } | null; escalation: { kind: "officer"; reason: string } | null; inquiry_required: boolean;
} {
  if (i.classification !== "fnma_error") return { allowed: true, independent_sources: independentEvidenceSources(i.evidence_refs), refusal: null, escalation: null, inquiry_required: false };
  const independent_sources = independentEvidenceSources(i.evidence_refs);
  if (independent_sources.length < 2) return { allowed: false, independent_sources, refusal: { code: "FNMA_ERROR_EVIDENCE_REFS", citation: FNMA_ERROR_GUARDRAIL_CITATION, reason: `${independent_sources.length} independent evidence ref(s); two are required before an inquiry is sent` }, escalation: null, inquiry_required: true };
  if (i.officer_signoff === null) return { allowed: false, independent_sources, refusal: { code: "FNMA_ERROR_OFFICER_SIGNOFF", citation: FNMA_ERROR_GUARDRAIL_CITATION, reason: "officer sign-off is required before a Fannie Mae error inquiry is sent" }, escalation: { kind: "officer", reason: "external inquiry (Fannie Mae error classification) awaiting officer sign-off" }, inquiry_required: true };
  return { allowed: true, independent_sources, refusal: null, escalation: null, inquiry_required: true };
}
/** "never alter delinquency history to match a scorecard": the STAR module reads `loan_delinquency_months`; it never writes it. */
export function delinquencyHistoryWriteGate(i: { target: string; op: "read" | "write"; reason?: string }): { allowed: boolean; refusal: { code: "NO_DELINQUENCY_HISTORY_REWRITE"; citation: string; reason: string; instead: string } | null } {
  if (i.op === "write" && /^(loan_delinquency_months|fnma_delinquency_status|delinquency_history)$/.test(i.target)) {
    return { allowed: false, refusal: { code: "NO_DELINQUENCY_HISTORY_REWRITE", citation: "§18.3 guardrails: never alter delinquency history to match a scorecard", reason: `write to ${i.target} refused${i.reason ? ` (${i.reason})` : ""}`, instead: "classify the variance (reporting timing → Section 5 evidence; definition mismatch → config; data defect → 18.1 finding; Fannie Mae error → officer-signed inquiry)" } };
  }
  return { allowed: true, refusal: null };
}

// ---------------------------------------------------------------- program-year config (SM_STAR_CONFIG_ANNUAL_JAN)
export type StarMetricCode = Metric | "DIS_FB_TAKEUP" | "DIS_30_CURE" | `SUPP_${string}`;
export interface StarMetricsConfigRow { readonly program_year: number; readonly metric_code: StarMetricCode; readonly version: string; readonly definition: { readonly min_denominator: number; readonly lookback_months: number | null; readonly exclusions: readonly string[]; readonly lower_is_better: boolean }; readonly weight_by_peer_group: Readonly<Partial<Record<PeerGroup, number>>>; readonly source_citation: string; readonly verified: boolean; }
/** Timer row: program year (Jan 1) → config loaded by Jan 31 (the February scorecard reflects the changes); sev-2. */
export function configClock(i: { program_year: number }): { code: "SM_STAR_CONFIG_ANNUAL_JAN"; anchor: PlainDate; due: PlainDate; satisfied_by: "star.config.published"; breach: "sev2" } {
  return { code: "SM_STAR_CONFIG_ANNUAL_JAN", anchor: ymd(i.program_year, 1, 1), due: ymd(i.program_year, 1, 31), satisfied_by: "star.config.published", breach: "sev2" };
}
/**
 * Loads a program-year `star_metrics_config` version: every row carries min_denominator 30, peer-group weights sum to
 * 100 per group, and unverified metrics (the guide formulas the spec marks [UNVERIFIED]) keep the pipeline internal-only.
 */
export function publishConfig(i: { program_year: number; version: string; rows: readonly StarMetricsConfigRow[]; published_on: PlainDate }): {
  rows: StarMetricsConfigRow[]; unverified: StarMetricCode[]; external_use_allowed: boolean; on_time: boolean; event: { type: "star.config.published"; payload: { year: number; version: string; published_on: PlainDate; metrics: number; verified: boolean } };
} {
  for (const r of i.rows) {
    if (r.program_year !== i.program_year || r.version !== i.version) throw new RangeError(`${r.metric_code}: config row is not ${i.program_year}/${i.version}`);
    if (r.definition.min_denominator !== MIN_DENOMINATOR) throw new RangeError(`${r.metric_code}: min_denominator must be ${MIN_DENOMINATOR} ("No scores for metrics with <30 loans in denominator")`);
  }
  for (const g of ["Strategic", "Premier", "Select"] as const) {
    const sum = i.rows.reduce((s, r) => s + (r.weight_by_peer_group[g] ?? 0), 0);
    if (sum !== 100) throw new RangeError(`${g} weights sum to ${sum}, not 100`);
  }
  const unverified = i.rows.filter((r) => !r.verified).map((r) => r.metric_code);
  return { rows: [...i.rows], unverified, external_use_allowed: unverified.length === 0, on_time: i.published_on <= configClock({ program_year: i.program_year }).due, event: { type: "star.config.published", payload: { year: i.program_year, version: i.version, published_on: i.published_on, metrics: i.rows.length, verified: unverified.length === 0 } } };
}

// ---------------------------------------------------------------- confidentiality (T9)
export type StarAudience = "vendor" | "marketing" | "partner" | "internal" | "fnma";
export type StarDocumentKind = "newsletter" | "marketing_material" | "partner_report" | "internal_report" | "fnma_inquiry" | "distribution_list";
export const STAR_CONFIDENTIALITY_CITATION = "STAR FAQs (Apr. 6, 2026): \"STAR Scorecard results are confidential, and a servicer may not disclose STAR Scorecard results to any third parties by any means\"";
export interface ConfidentialityRefusal { readonly code: "STAR_CONFIDENTIALITY"; readonly citation: string; readonly matched: string; readonly reason: string; readonly escalation: { kind: "officer"; reason: string } | null; }
export interface ConfidentialityDecision { readonly allowed: boolean; readonly mentions_star_results: boolean; readonly refusal: ConfidentialityRefusal | null; }

/** The program token: "STAR" (case-sensitive — "five-star service" is not the program) or its spelled-out name. */
const starToken = (s: string): boolean => /\bSTAR\b/.test(s) || /\bServicer Total Achievement and Rewards\b/i.test(s);
/** A result, standing or recognition word. */
const STAR_RESULT_WORDS = /\b(?:performance|performer|performing|level|recognition|recogni[sz]ed|rating|rated|scorecard|results?|rank(?:s|ed|ing)?|scores?|peer[- ]group|top[- ](?:three|3)|standing|award|metrics?|leads?|leader|leading)\b/i;
/**
 * The text screen: a sentence that names STAR together with a result word is a disclosure; so is a document that names
 * the program in one sentence and states a result, rank or standing in another ("Fannie Mae runs STAR. We ranked top
 * three in our peer group." — the sentence split alone would let that through). Naming the program with no result
 * anywhere in the text is not a disclosure.
 */
export function starResultsMention(text: string): string | null {
  const segs = text.split(/(?<=[.!?\n])/).map((s) => s.trim()).filter((s) => s !== "");
  for (const seg of segs) if (starToken(seg) && STAR_RESULT_WORDS.test(seg)) return seg;
  const named = segs.find(starToken); const result = segs.find((s) => STAR_RESULT_WORDS.test(s));
  return named !== undefined && result !== undefined ? `${named} … ${result}` : null;
}
/** What a report classified `carries_star_data` is, whatever its wording — the STAR classification is the primary key of the filter. */
export const CARRIES_STAR_DATA_MATCH = "report classified carries_star_data=true (STAR Scorecard data)";

/**
 * 18.3-T9 guardrail: the confidentiality filter on report distribution. The filter keys first on the report's STAR
 * classification (`carries_star_data`, the state-machine flag the officer signs off on) and second on the text: any
 * third-party-facing document (vendor newsletter, marketing material, a vendor or marketing recipient on a list) that
 * carries STAR data or cites STAR results or standing is blocked — including "STAR performance" (edge case: "do not
 * claim 'STAR performance' externally"); the partner only under the subservicing-agreement confidentiality clause;
 * internal and Fannie Mae-facing text passes. Recognition wording may travel inside Fannie Mae's own marketing package;
 * scorecard data never does.
 */
export function confidentialityGate(i: { audience: StarAudience; kind: StarDocumentKind; text: string; carries_star_data?: boolean; partner_confidentiality_clause?: boolean; fnma_marketing_package?: boolean }): ConfidentialityDecision {
  const textMatch = starResultsMention(i.text);
  const matched = i.carries_star_data === true ? (textMatch === null ? CARRIES_STAR_DATA_MATCH : `${CARRIES_STAR_DATA_MATCH}; "${textMatch}"`) : textMatch;
  if (matched === null) return { allowed: true, mentions_star_results: false, refusal: null };
  if (i.audience === "internal" || i.audience === "fnma") return { allowed: true, mentions_star_results: true, refusal: null };
  if (i.fnma_marketing_package === true && i.carries_star_data !== true && textMatch !== null && /recognition|recogni[sz]ed|top[- ](?:three|3)|performer|award/i.test(textMatch)) return { allowed: true, mentions_star_results: true, refusal: null };
  if (i.audience === "partner" && i.partner_confidentiality_clause === true) return { allowed: true, mentions_star_results: true, refusal: null };
  const third_party = i.audience === "vendor" || i.audience === "marketing";
  const why = i.audience === "partner" ? "partner sharing of STAR Scorecard results needs the subservicing-agreement confidentiality clause" : `"a servicer may not disclose STAR Scorecard results to any third parties by any means" — ${i.audience} distribution refused`;
  const cites = i.carries_star_data === true ? `carries STAR Scorecard data${textMatch !== null ? ` and cites "${textMatch}"` : ""}` : `cites "${matched}"`;
  return {
    allowed: false,
    mentions_star_results: true,
    refusal: { code: "STAR_CONFIDENTIALITY", citation: STAR_CONFIDENTIALITY_CITATION, matched, reason: `${i.kind} for ${i.audience} ${cites} — ${why}`, escalation: third_party ? { kind: "officer", reason: `third-party ${i.kind} ${i.carries_star_data === true ? "carries STAR Scorecard data" : "draft cited STAR results"}; blocked by the confidentiality filter` } : null },
  };
}

/**
 * Distribution-list screen: every recipient outside internal/fnma (and the partner without the clause) is dropped from
 * a report that carries STAR data (`carries_star_data`, the classification) or whose text cites STAR results.
 */
export function screenDistributionList(i: { text: string; recipients: readonly { id: string; audience: StarAudience }[]; carries_star_data?: boolean; partner_confidentiality_clause?: boolean }): { allowed: { id: string; audience: StarAudience }[]; dropped: { id: string; audience: StarAudience; reason: string }[]; screened_on: ("classification" | "text")[] } {
  const allowed: { id: string; audience: StarAudience }[] = []; const dropped: { id: string; audience: StarAudience; reason: string }[] = [];
  for (const r of i.recipients) {
    const d = confidentialityGate({ audience: r.audience, kind: "distribution_list", text: i.text, ...(i.carries_star_data !== undefined ? { carries_star_data: i.carries_star_data } : {}), ...(i.partner_confidentiality_clause !== undefined ? { partner_confidentiality_clause: i.partner_confidentiality_clause } : {}) });
    if (d.allowed) allowed.push({ id: r.id, audience: r.audience }); else dropped.push({ id: r.id, audience: r.audience, reason: d.refusal!.reason });
  }
  const screened_on: ("classification" | "text")[] = [...(i.carries_star_data === true ? ["classification" as const] : []), ...(starResultsMention(i.text) !== null ? ["text" as const] : [])];
  return { allowed, dropped, screened_on };
}

// ---------------------------------------------------------------- partner report (SM_STAR_PARTNER_REPORT_MONTHLY)
export const STAR_PARTNER_REPORT_TEMPLATE = "STAR-RPT-MONTHLY-v1";
/** Timer row: `star.reconciled` (reconciled_at) → partner report delivered within 5 business days; satisfied by `star.partner_report.delivered`; sev-3. */
export function partnerReportClock(i: { reconciled_at: PlainDate; carries_star_data: boolean; cal?: Calendar }): { code: "SM_STAR_PARTNER_REPORT_MONTHLY"; anchor: PlainDate; due: PlainDate; satisfied_by: "star.partner_report.delivered"; breach: "sev3"; template: typeof STAR_PARTNER_REPORT_TEMPLATE; officer_signoff_required: boolean } {
  return { code: "SM_STAR_PARTNER_REPORT_MONTHLY", anchor: i.reconciled_at, due: addBusinessDays(i.reconciled_at, 5, i.cal ?? servicer), satisfied_by: "star.partner_report.delivered", breach: "sev3", template: STAR_PARTNER_REPORT_TEMPLATE, officer_signoff_required: i.carries_star_data };
}
/** Release gate for the partner report: STAR-bearing reports need the confidentiality clause and `officer` sign-off before `star.partner_report.delivered` may be emitted. */
export function partnerReportRelease(i: { carries_star_data: boolean; partner_confidentiality_clause: boolean; officer_signoff: { officer_id: string; signed_at: string } | null }): { allowed: boolean; refusal: { code: "STAR_CONFIDENTIALITY" | "OFFICER_SIGNOFF_REQUIRED"; reason: string } | null; event: "star.partner_report.delivered" | null } {
  if (!i.carries_star_data) return { allowed: true, refusal: null, event: "star.partner_report.delivered" };
  if (!i.partner_confidentiality_clause) return { allowed: false, refusal: { code: "STAR_CONFIDENTIALITY", reason: "partner report carries STAR data but the subservicing agreement has no confidentiality clause covering STAR Scorecard sharing" }, event: null };
  if (i.officer_signoff === null) return { allowed: false, refusal: { code: "OFFICER_SIGNOFF_REQUIRED", reason: "partner report carrying STAR data needs officer sign-off under the confidentiality clause" }, event: null };
  return { allowed: true, refusal: null, event: "star.partner_report.delivered" };
}
/**
 * Partner delivery: the release gate plus the distribution-list screen keyed on the report's STAR classification
 * (`carries_star_data`) and its text; the timer event is produced only when the report may go and at least one
 * partner recipient survives the screen. Vendor and marketing recipients never receive a STAR-bearing report.
 */
export function deliverPartnerReport(i: { as_of_month: string; reconciled_at: PlainDate; delivered_on: PlainDate; carries_star_data: boolean; partner_confidentiality_clause: boolean; officer_signoff: { officer_id: string; signed_at: string } | null; recipients: readonly { id: string; audience: StarAudience }[]; text: string }): {
  clock: ReturnType<typeof partnerReportClock>; release: ReturnType<typeof partnerReportRelease>; distribution: ReturnType<typeof screenDistributionList>; on_time: boolean;
  event: { type: "star.partner_report.delivered"; payload: { as_of_month: string; template: typeof STAR_PARTNER_REPORT_TEMPLATE; delivered_at: PlainDate; recipients: string[]; officer_id: string | null } } | null;
} {
  const clock = partnerReportClock({ reconciled_at: i.reconciled_at, carries_star_data: i.carries_star_data });
  const release = partnerReportRelease({ carries_star_data: i.carries_star_data, partner_confidentiality_clause: i.partner_confidentiality_clause, officer_signoff: i.officer_signoff });
  const distribution = screenDistributionList({ text: i.text, recipients: i.recipients, carries_star_data: i.carries_star_data, partner_confidentiality_clause: i.partner_confidentiality_clause });
  const partners = distribution.allowed.filter((r) => r.audience === "partner").map((r) => r.id);
  const ok = release.allowed && partners.length > 0;
  return { clock, release, distribution, on_time: i.delivered_on <= clock.due, event: ok ? { type: "star.partner_report.delivered", payload: { as_of_month: i.as_of_month, template: STAR_PARTNER_REPORT_TEMPLATE, delivered_at: i.delivered_on, recipients: partners, officer_id: i.officer_signoff?.officer_id ?? null } } : null };
}

// ---------------------------------------------------------------- event-store wiring: availability → ingested → reconciled → partner report, one subject per scorecard
/** The emitter shape the tools/service hand in (as §5's ops do): the append-only event store, the acting agent/human, and the clock. */
export interface StarEmitter { readonly events: EventStore; readonly actor: Actor; readonly now: string; }
export interface StarSubject { readonly kind: "star_scorecard"; readonly id: string; }
/** Fannie Mae Connect report id of the STAR Scorecard ("View your Scorecard" → connect.fanniemae.com report-center, `reportId=511`). */
export const STAR_SCORECARD_REPORT_ID = "511";
export const STAR_SCORECARD_REPORT = "star_scorecard";
/** How the availability reached us: the email subscription (mailbox parser), the Insights & Reporting API, or the operator's own portal check. */
export type ReportAvailabilitySource = "email_subscription" | "api_pull" | "ui_download";
const AVAILABILITY_SOURCES: readonly ReportAvailabilitySource[] = ["email_subscription", "api_pull", "ui_download"];
const STAR_VIEWS: readonly StarView[] = ["master_partner", "acting_supermortgage", "internal_total"];
/** One scorecard (a view for a month) is the subject every 18.3 clock is armed on and satisfied against — the engine matches subjects exactly. */
export function starScorecardSubject(view: StarView, as_of_month: string): StarSubject { return { kind: "star_scorecard", id: `${view}:${as_of_month}` }; }
/** The `human_portal_task` package for a UI download: report id, month, expected file name; the operator uploads to `documents`. */
export interface ScorecardPortalTask { readonly kind: "human_portal_task"; readonly task: "star_scorecard_download"; readonly assignee: "fnma_portal_operator"; readonly report_id: "511"; readonly report: "star_scorecard"; readonly view: StarView; readonly as_of_month: string; readonly expected_file_name: string; readonly download_by: PlainDate; }
/**
 * Inbound integration event — Fannie Mae Connect says report 511 (STAR Scorecard) is available: the email subscription
 * → mailbox parser, the API pull, or the operator's own check. The record is validated (the report id must be 511 —
 * any other Connect report belongs to §5; a real view, a YYYY-MM month, a calendar date) and appended as
 * `fnma.connect.report.available{report_id=511, available_on}` on the scorecard subject: the SM_STAR_SCORECARD_INGEST_5BD
 * trigger, anchored on `available_on`. Unless the Insights API is entitled (default: not), the return also carries the
 * `human_portal_task` package for `fnma_portal_operator` (report id, month, expected file name, download by the clock's due date).
 */
export function ingestReportAvailability(em: StarEmitter, i: { report_id: string | number; view: StarView; as_of_month: string; available_on: PlainDate; source: ReportAvailabilitySource; api_entitled?: boolean; subject_line?: string | null }): { subject: StarSubject; clock: ScorecardIngestClock; event: DomainEvent; portal_task: ScorecardPortalTask | null } {
  if (String(i.report_id) !== STAR_SCORECARD_REPORT_ID) throw new RangeError(`report ${i.report_id} is not the STAR Scorecard (Fannie Mae Connect report 511)`);
  if (!STAR_VIEWS.includes(i.view)) throw new RangeError(`view ${String(i.view)} is not master_partner/acting_supermortgage/internal_total`);
  if (!/^\d{4}-\d{2}$/.test(i.as_of_month)) throw new RangeError(`as_of_month ${i.as_of_month} is not YYYY-MM`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.available_on)) throw new RangeError(`available_on ${i.available_on} is not a calendar date`);
  if (!AVAILABILITY_SOURCES.includes(i.source)) throw new RangeError(`source ${String(i.source)} is not ${AVAILABILITY_SOURCES.join("/")}`);
  const subject = starScorecardSubject(i.view, i.as_of_month);
  const clock = scorecardClocks({ available_on: i.available_on }).ingest;
  const api = i.api_entitled === true && i.source === "api_pull";
  const expected_file_name = `STAR_Scorecard_511_${i.as_of_month}`;
  const event = em.events.append({ type: "fnma.connect.report.available", aggregate: subject, actor: em.actor, payload: { report: STAR_SCORECARD_REPORT, report_id: STAR_SCORECARD_REPORT_ID, view: i.view, as_of_month: i.as_of_month, available_on: i.available_on, source: i.source, subject_line: i.subject_line ?? null, ingest_by: clock.due, delivery: api ? "api_pull" : "ui_download", expected_file_name } });
  return { subject, clock, event, portal_task: api ? null : { kind: "human_portal_task", task: "star_scorecard_download", assignee: "fnma_portal_operator", report_id: "511", report: "star_scorecard", view: i.view, as_of_month: i.as_of_month, expected_file_name, download_by: clock.due } };
}
/** `computeMetrics` + the `star.metrics.computed` append on the scorecard subject (the SM_STAR_COMPUTE_MONTHLY_BD5 satisfaction; the recurring row re-arms on the §5 period subject it was armed on). */
export function recordMetricsComputed(em: StarEmitter, i: Parameters<typeof computeMetrics>[0] & { period_subject?: { kind: string; id: string } }): ReturnType<typeof computeMetrics> & { subject: StarSubject; appended: DomainEvent } {
  const r = computeMetrics(i);
  const subject = starScorecardSubject(i.view, i.as_of_month);
  const appended = em.events.append({ type: r.event.type, aggregate: i.period_subject ?? subject, actor: em.actor, payload: { ...r.event.payload, scorecard_subject: subject.id } });
  return { ...r, subject, appended };
}
/** `ingestScorecard` + the `star.scorecard.ingested{ingested_at}` append when every row is structured — satisfies SM_STAR_SCORECARD_INGEST_5BD and arms SM_STAR_RECON_10BD on `ingested_at`. Nothing is appended while a row waits for manual entry. */
export function recordScorecardIngestion(em: StarEmitter, i: Parameters<typeof ingestScorecard>[0]): ReturnType<typeof ingestScorecard> & { subject: StarSubject; appended: DomainEvent | null } {
  const r = ingestScorecard(i);
  const subject = starScorecardSubject(i.view, i.as_of_month);
  const appended = r.event === null ? null : em.events.append({ type: r.event.type, aggregate: subject, actor: em.actor, payload: { ...r.event.payload, report_id: STAR_SCORECARD_REPORT_ID } });
  return { ...r, subject, appended };
}
/** `reconcileMonth` + the `star.reconciled{reconciled_at}` append when every computed metric is within tolerance, explained or suppressed — satisfies SM_STAR_RECON_10BD and arms SM_STAR_PARTNER_REPORT_MONTHLY on `reconciled_at`. */
export function recordReconciliation(em: StarEmitter, i: Parameters<typeof reconcileMonth>[0]): ReturnType<typeof reconcileMonth> & { subject: StarSubject; appended: DomainEvent | null } {
  const r = reconcileMonth(i);
  const subject = starScorecardSubject(i.view, i.as_of_month);
  const appended = r.event === null ? null : em.events.append({ type: r.event.type, aggregate: subject, actor: em.actor, payload: { ...r.event.payload } });
  return { ...r, subject, appended };
}
/** `deliverPartnerReport` + the `star.partner_report.delivered` append once the release gate and the distribution screen let the report go — satisfies SM_STAR_PARTNER_REPORT_MONTHLY. */
export function recordPartnerReportDelivery(em: StarEmitter, i: Parameters<typeof deliverPartnerReport>[0] & { view: StarView }): ReturnType<typeof deliverPartnerReport> & { subject: StarSubject; appended: DomainEvent | null } {
  const { view, ...rest } = i;
  const r = deliverPartnerReport(rest);
  const subject = starScorecardSubject(view, i.as_of_month);
  const appended = r.event === null ? null : em.events.append({ type: r.event.type, aggregate: subject, actor: em.actor, payload: { ...r.event.payload, view } });
  return { ...r, subject, appended };
}
