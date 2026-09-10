// 18.3 STAR performance measurement
// spec/sections/18-qc-audit-regulatory-reporting/18-3-star-performance-measurement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { loadRegistry, computeDue, defaultAnchorResolver } from "../../kernel/timers/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { MemoryEventStore, FixedClock } from "../../kernel/events/store.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import type { DomainEvent } from "../../kernel/events/types.ts";
import { periodAnchors } from "../investor/period.ts";
import { applyQcAuditTimerOverrides } from "./timers.ts";
import { rateBps, metricResult } from "./star.ts";
import { transferInExclusion, distributionFilter } from "./ops.ts";
import {
  transfereeIncluded, transfereeExclusionWindow, confidentialityGate, starResultsMention, screenDistributionList, partnerReportClock, partnerReportRelease, deliverPartnerReport, STAR_METRICS, CARRIES_STAR_DATA_MATCH,
  computeMetrics, computeClock, computeClockFromPeriodClose, STAR_COMPUTE_TRIGGER, compositeFor, compositeWithReferences, normalizedScore, percentileRank, LOWER_IS_BETTER, peerGroup, STAR_WEIGHTS_2026, beyondTimeframeTransition, scorecardClocks, scorecardClockStatus, ingestScorecard,
  reconcileMetric, closeVarianceInvestigation, reconcileMonth, RECON_TOLERANCE, fnmaErrorInquiryGate, delinquencyHistoryWriteGate, configClock, publishConfig, type StarMetricsConfigRow,
  ingestReportAvailability, recordScorecardIngestion, recordReconciliation, recordPartnerReportDelivery, starScorecardSubject, STAR_SCORECARD_REPORT_ID, type StarEmitter,
} from "./ops-18-3.ts";
import { GUARDRAILS_18_3 } from "../../app/tools/section18-3.ts";
import type { CommandContext } from "../../app/commands.ts";

const AT = "2027-02-05T15:00:00Z";
const overriddenRegistry = () => { const reg = loadRegistry(); applyQcAuditTimerOverrides(reg); return reg; };
const dueFromRegistry = (code: string, anchor: string) => computeDue(overriddenRegistry().get(code)!.offsetParsed, D(anchor), Date.parse(`${anchor}T12:00:00Z`)).dueDate;
const periodClosed = (payload: Record<string, unknown>, occurredAt: string): DomainEvent => ({ id: "e-1", type: "investor_reporting_periods.closed", occurredAt, actor: { kind: "agent", id: "investor-reporting" }, payload } as unknown as DomainEvent);

test("18.3-T1: Given 6,210 loans ≤ 30 days at base and 87 transitions to 60+, then `T60 = 140 bps`.", () => {
  const run = computeMetrics({ program_year: 2027, as_of_month: "2027-01", view: "internal_total", config_version: "2026.1", computed_at: AT, cohorts: [{ metric: "T60", population: 6210, excluded: 0, numerator: 87 }] });
  const t60 = run.results[0]!;
  assert.equal(t60.metric_code, "T60"); assert.equal(t60.denominator, 6210); assert.equal(t60.numerator, 87);
  assert.equal(t60.rate_bps, 140); assert.equal(t60.suppressed, false);
  // rate_bps = round_half_up(87 × 10000 / 6210) = round_half_up(140.096…) = 140 (1.40%)
  assert.equal(rateBps(87, 6210), 140);
  assert.equal(run.state, "metrics_computed"); assert.equal(run.event.type, "star.metrics.computed");
  assert.deepEqual(run.event.payload, { as_of_month: "2027-01", view: "internal_total", config_version: "2026.1", computed_at: AT, metrics: 1, suppressed: [], population_hash: null });
  // the result row carries the population hash of the snapshot it was computed from (star_metric_results.population_hash), as does the event
  const hashed = computeMetrics({ program_year: 2027, as_of_month: "2027-01", view: "internal_total", config_version: "2026.1", computed_at: AT, population_hash: "sha256:9c1f", cohorts: [{ metric: "T60", population: 6210, excluded: 0, numerator: 87 }] });
  assert.equal(hashed.results[0]!.population_hash, "sha256:9c1f"); assert.equal(hashed.event.payload.population_hash, "sha256:9c1f"); assert.equal(t60.population_hash, null);
  // SM_STAR_COMPUTE_MONTHLY_BD5: the January 2027 period closes BD2 (2027-02-02) and the metrics are due BD5 (2027-02-05)
  const clock = computeClock({ period_month: "2027-01" });
  assert.deepEqual(clock, { code: "SM_STAR_COMPUTE_MONTHLY_BD5", period_end: D("2027-01-31"), period_close_bd2: D("2027-02-02"), due: D("2027-02-05"), satisfied_by: "star.metrics.computed", breach: "sev3" });
  assert.equal(dueFromRegistry("SM_STAR_COMPUTE_MONTHLY_BD5", "2027-01-31"), "2027-02-05");
  assert.equal(computeClock({ period_month: "2027-09" }).due, "2027-10-07"); assert.equal(dueFromRegistry("SM_STAR_COMPUTE_MONTHLY_BD5", "2027-09-30"), "2027-10-07");
  // the registry row is armed by §5's period close (checklist complete) and anchored on its `period_end` (periodAnchors payload) — the engine resolves BD5 of the following month, not BD7 from the BD2 close date
  const def = overriddenRegistry().get("SM_STAR_COMPUTE_MONTHLY_BD5")!;
  assert.equal(def.triggerPattern!.type, STAR_COMPUTE_TRIGGER); assert.equal(def.triggerPattern!.type, "investor_reporting_periods.closed"); assert.equal(def.anchorField, "period_end");
  const closeEvent = periodClosed({ ...periodAnchors(D("2027-01-15")), checklist_complete: true }, "2027-02-02T22:00:00Z");
  assert.equal(eventMatches(def.triggerPattern!, closeEvent), true);
  assert.equal(eventMatches(def.triggerPattern!, periodClosed({ ...periodAnchors(D("2027-01-15")), checklist_complete: false }, "2027-02-02T22:00:00Z")), false, "a close with the checklist open does not arm the clock");
  const anchor = defaultAnchorResolver(def, closeEvent)!;
  assert.equal(anchor, "2027-01-31"); assert.equal(computeDue(def.offsetParsed, anchor, Date.parse("2027-01-31T12:00:00Z")).dueDate, "2027-02-05");
  // the domain clock from the same event: period_end → BD5; a payload without it is anchored on the month before the close, never on the close date (which would give BD7 = 2027-02-09)
  assert.deepEqual(computeClockFromPeriodClose({ payload: closeEvent.payload as { period_end: string; checklist_complete: boolean }, closed_on: D("2027-02-02") }), { ...clock, anchored_on: "period_end", armed: true });
  assert.deepEqual(computeClockFromPeriodClose({ payload: { period: "2027-01" }, closed_on: D("2027-02-02") }), { ...clock, anchored_on: "period", armed: true });
  assert.deepEqual(computeClockFromPeriodClose({ payload: {}, closed_on: D("2027-02-02") }), { ...clock, anchored_on: "closed_on_prior_month", armed: true });
  assert.equal(computeClockFromPeriodClose({ payload: {}, closed_on: D("2027-02-03") }).due, "2027-02-05", "a late (BD3) close does not move the BD5 due date");
  assert.equal(computeClockFromPeriodClose({ payload: { checklist_complete: false }, closed_on: D("2027-02-02") }).armed, false);
  assert.throws(() => computeMetrics({ program_year: 2027, as_of_month: "2027-01", view: "internal_total", config_version: "2026.1", computed_at: AT, cohorts: [{ metric: "T60", population: 6210, excluded: 0, numerator: 6211 }] }), RangeError);
});
test("18.3-T2: Given 435 loans 60+ at base of which 23 are in active repayment plans, then the C60 denominator is 412 and 118 cures → `2,864 bps` (round-half-up of 2,864.08); with 119 cures → `2,888 bps` (2,888.35).", () => {
  const run = (cures: number) => computeMetrics({ program_year: 2027, as_of_month: "2027-01", view: "internal_total", config_version: "2026.1", computed_at: AT, cohorts: [{ metric: "C60", population: 435, excluded: 23, numerator: cures }] }).results[0]!;
  const c118 = run(118), c119 = run(119);
  assert.equal(c118.denominator, 412); assert.equal(c118.numerator, 118); assert.equal(c118.rate_bps, 2864); assert.equal(c118.suppressed, false);
  assert.equal(c119.denominator, 412); assert.equal(c119.rate_bps, 2888);
  // round-half-up: 118 × 10000 / 412 = 2864.077… → 2,864; 119 × 10000 / 412 = 2888.349… → 2,888
  assert.equal(rateBps(118, 412), 2864); assert.equal(rateBps(119, 412), 2888);
  assert.ok(Math.abs((118 * 10000) / 412 - 2864.08) < 0.01); assert.ok(Math.abs((119 * 10000) / 412 - 2888.35) < 0.01);
  // the verified exclusion is the only thing that moves the denominator: without it 118/435 = 2,713 bps
  assert.equal(rateBps(118, 435), 2713);
});
test("18.3-T3: Given a loan transferred in on 2027-02-01, then it is excluded from T60/C60/RET_EFF for Feb and Mar 2027 but included in MOD6/PD6.", () => {
  const w = transfereeExclusionWindow(D("2027-02-01"));
  assert.deepEqual(w.excluded_months, ["2027-02", "2027-03"]); assert.equal(w.first_full_month, "2027-04");
  assert.deepEqual(w.excluded_metrics, ["T60", "C60", "RET_EFF", "BEYOND_TF"]); assert.deepEqual(w.always_included, ["MOD6", "PD6"]);
  for (const base of [D("2027-02-01"), D("2027-03-01")]) {
    for (const m of ["T60", "C60", "RET_EFF"] as const) assert.equal(transfereeIncluded(m, base, D("2027-02-01")), false, `${m} ${base}`);
    for (const m of ["MOD6", "PD6"] as const) assert.equal(transfereeIncluded(m, base, D("2027-02-01")), true, `${m} ${base}`);
  }
  for (const m of STAR_METRICS) assert.equal(transfereeIncluded(m, D("2027-04-01"), D("2027-02-01")), true, m);
  // the shared calculator agrees on a first-of-month transfer
  assert.deepEqual(transferInExclusion(D("2027-02-01"), D("2027-03-01")).excluded_from, ["T60", "C60", "RET_EFF", "BEYOND_TF"]);
  assert.deepEqual(transferInExclusion(D("2027-02-01"), D("2027-03-01")).included_in, ["MOD6", "PD6"]);
  // "two months following transfer" is a month rule: a 2027-02-15 transfer-in is out for Feb and Mar and back in T60 for April, not May
  assert.equal(transfereeIncluded("T60", D("2027-03-01"), D("2027-02-15")), false);
  assert.equal(transfereeIncluded("T60", D("2027-04-01"), D("2027-02-15")), true);
  assert.deepEqual(transfereeExclusionWindow(D("2027-02-15")).excluded_months, ["2027-02", "2027-03"]);
  assert.equal(transfereeExclusionWindow(D("2027-02-15")).first_full_month, "2027-04");
  // transferor: out of everything in the transfer month only
  assert.equal(transfereeIncluded("MOD6", D("2027-02-01"), null, D("2027-02-10")), false);
  assert.equal(transfereeIncluded("MOD6", D("2027-03-01"), null, D("2027-02-10")), true);
});
test("18.3-T4: Given a metric with denominator 27, then the result is `suppressed=true` and excluded from the composite.", () => {
  const run = computeMetrics({ program_year: 2027, as_of_month: "2027-01", view: "internal_total", config_version: "2026.1", computed_at: AT, cohorts: [
    { metric: "T60", population: 6210, excluded: 0, numerator: 87 }, { metric: "C60", population: 435, excluded: 23, numerator: 118 }, { metric: "RET_EFF", population: 190, excluded: 0, numerator: 61 },
    { metric: "MOD6", population: 40, excluded: 0, numerator: 31 }, { metric: "PD6", population: 27, excluded: 0, numerator: 9 }, { metric: "BEYOND_TF", population: 55, excluded: 0, numerator: 4 },
  ] });
  const pd6 = run.results.find((r) => r.metric_code === "PD6")!;
  assert.equal(pd6.denominator, 27); assert.equal(pd6.suppressed, true); assert.equal(pd6.rate_bps, null); assert.equal(pd6.numerator, 9);
  assert.deepEqual(run.suppressed, ["PD6"]); assert.deepEqual(run.event.payload.suppressed, ["PD6"]);
  // one loan more (denominator 30) would score
  assert.equal(metricResult("PD6", 9, 30).suppressed, false); assert.equal(metricResult("PD6", 9, 30).rate_bps, 3000);
  // Strategic/Premier composite: PD6's 10 points drop out and the rest are re-normalised (30·80 + 25·60 + 15·50 + 10·70 + 10·40) / 90 = 63.89
  const pct: Record<string, number> = { T60: 80, C60: 60, RET_EFF: 50, MOD6: 70, PD6: 100, BEYOND_TF: 40 };
  const strategic = compositeFor(run.results, "Strategic", (m) => pct[m]!);
  assert.deepEqual(strategic.excluded_suppressed, ["PD6"]); assert.deepEqual(strategic.included, ["T60", "C60", "RET_EFF", "MOD6", "BEYOND_TF"]);
  assert.equal(strategic.composite, Math.round(((30 * 80 + 25 * 60 + 15 * 50 + 10 * 70 + 10 * 40) / 90) * 100) / 100);
  assert.equal(strategic.composite, 63.89);
  // had PD6 scored, its 100th percentile would have lifted the composite — the suppressed metric contributes nothing
  const scored = compositeFor(run.results.map((r) => (r.metric_code === "PD6" ? { ...r, suppressed: false, rate_bps: 3333 } : r)), "Strategic", (m) => pct[m]!);
  assert.equal(scored.composite, 67.5); assert.deepEqual(scored.excluded_suppressed, []);
  // Select weights never carried PD6 at all
  assert.deepEqual(compositeFor(run.results, "Select", (m) => pct[m]!).included, ["T60", "C60", "RET_EFF"]);
  // the normalized score of a suppressed metric is null (no basis) and compositeWithReferences leaves it out even when a Comp exists for it
  assert.deepEqual(normalizedScore({ metric: "PD6", rate_bps: null, suppressed: true, reference: { comp_rates_bps: [3100], prior_12_month_bps: [] } }), { percentile: null, basis: "suppressed", reference_size: 0 });
  const refs = { T60: { comp_rates_bps: [150], prior_12_month_bps: [] }, C60: { comp_rates_bps: [2600], prior_12_month_bps: [] }, RET_EFF: { comp_rates_bps: [3300], prior_12_month_bps: [] }, MOD6: { comp_rates_bps: [7600], prior_12_month_bps: [] }, PD6: { comp_rates_bps: [3100], prior_12_month_bps: [] }, BEYOND_TF: { comp_rates_bps: [700], prior_12_month_bps: [] } } as const;
  const withRefs = compositeWithReferences(run.results, "Strategic", refs);
  assert.deepEqual(withRefs.excluded_suppressed, ["PD6"]); assert.deepEqual(withRefs.scores.find((s) => s.metric === "PD6"), { metric: "PD6", percentile: null, basis: "suppressed" });
  // T60 140 < Comp 150 (lower is better) → 100; C60 2,864 > 2,600 → 100; RET_EFF 3,211 < 3,300 → 0; MOD6 7,750 > 7,600 → 100; BEYOND_TF 727 > 700 (lower is better) → 0 → (30·100 + 25·100 + 15·0 + 10·100 + 10·0) / 90 = 72.22
  assert.deepEqual(withRefs.scores.filter((s) => s.metric !== "PD6").map((s) => s.percentile), [100, 100, 0, 100, 0]);
  assert.equal(withRefs.composite, 72.22);
});
test("18.3-T5: Given an internal C60 of 2,864 bps and a scorecard value of 2,700 bps (delta 164 bps), then a `variance_investigation` opens with loan-level diffs and closes only with a classification and evidence refs.", () => {
  const internal = metricResult("C60", 118, 412);
  assert.equal(internal.rate_bps, 2864);
  const ours = ["L-101", "L-102", "L-103", "L-104"], theirs = ["L-101", "L-102", "L-105"];
  const open = reconcileMetric({ as_of_month: "2027-01", internal, scorecard: { fnma_rate_bps: 2700, fnma_numerator: 110, fnma_denominator: 407 }, our_loans: ours, their_loans: theirs });
  assert.equal(open.delta_bps, 164); assert.equal(open.within_tolerance, false); assert.equal(open.status, "variance_investigation");
  assert.equal(open.loan_diff, 8);
  assert.deepEqual(open.loan_level_diffs, { ours_not_theirs: ["L-103", "L-104"], theirs_not_ours: ["L-105"], source: "scorecard_loan_level" });
  assert.equal(open.classification, null); assert.deepEqual(open.evidence_refs, []);
  // without the loan-level download the diff is pending, the investigation still opens
  assert.equal(reconcileMetric({ as_of_month: "2027-01", internal, scorecard: { fnma_rate_bps: 2700, fnma_numerator: null, fnma_denominator: null } }).loan_level_diffs!.source, "pending_loan_level_download");
  // tolerance ±25 bps or ±2 loans, whichever is larger: 2,850 (14 bps) reconciles; 2,800 (64 bps) but 2 loans apart reconciles; 164 bps and 8 loans does not
  assert.deepEqual(RECON_TOLERANCE, { bps: 25, loans: 2 });
  assert.equal(reconcileMetric({ as_of_month: "2027-01", internal, scorecard: { fnma_rate_bps: 2850, fnma_numerator: 118, fnma_denominator: 412 } }).status, "reconciled");
  assert.equal(reconcileMetric({ as_of_month: "2027-01", internal, scorecard: { fnma_rate_bps: 2800, fnma_numerator: 116, fnma_denominator: 412 } }).status, "reconciled");
  // a suppressed internal metric is not rate-reconciled (never compared as 0 bps)
  const pd6 = reconcileMetric({ as_of_month: "2027-01", internal: metricResult("PD6", 9, 27), scorecard: { fnma_rate_bps: 3300, fnma_numerator: 9, fnma_denominator: 27 } });
  assert.equal(pd6.status, "suppressed"); assert.equal(pd6.delta_bps, null); assert.equal(pd6.internal_rate_bps, null);
  // closes only with a classification and evidence refs
  const noClass = closeVarianceInvestigation(open, { classification: null, evidence_refs: ["investor_events:ack-2027-01-L-103"], explanation: "late status report" });
  assert.equal(noClass.closed, false); assert.equal(noClass.refusal!.code, "VARIANCE_CLOSE_REQUIRES_CLASSIFICATION"); assert.equal(noClass.row.status, "variance_investigation");
  const noRefs = closeVarianceInvestigation(open, { classification: "reporting_timing", evidence_refs: [], explanation: "late status report" });
  assert.equal(noRefs.closed, false); assert.equal(noRefs.refusal!.code, "VARIANCE_CLOSE_REQUIRES_EVIDENCE"); assert.equal(noRefs.row.status, "variance_investigation");
  const closed = closeVarianceInvestigation(open, { classification: "reporting_timing", evidence_refs: ["investor_events:ack-2027-01-L-103", "investor_events:reject-2027-01-L-104"], explanation: "L-103/L-104 cures reported after the period close (Section 5 ack records linked)" });
  assert.equal(closed.closed, true); assert.equal(closed.row.status, "explained"); assert.equal(closed.row.classification, "reporting_timing"); assert.equal(closed.follow_up, "link_reporting_evidence");
  assert.deepEqual(closed.row.evidence_refs, ["investor_events:ack-2027-01-L-103", "investor_events:reject-2027-01-L-104"]); assert.deepEqual(closed.row.loan_level_diffs, open.loan_level_diffs);
  assert.equal(closeVarianceInvestigation(closed.row, { classification: "data_defect", evidence_refs: ["qc_findings:F-1"], explanation: "x" }).refusal!.code, "VARIANCE_NOT_OPEN");
  // `star.reconciled` (SM_STAR_RECON_10BD, "all metrics within tolerance or explained") only once every metric the month computed has a row that is within tolerance, explained or suppressed
  const computed = ["T60", "C60", "PD6"] as const;
  const t60 = reconcileMetric({ as_of_month: "2027-01", internal: metricResult("T60", 87, 6210), scorecard: { fnma_rate_bps: 138, fnma_numerator: 86, fnma_denominator: 6210 } });
  assert.deepEqual(reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: computed, rows: [t60, open, pd6], reconciled_on: D("2027-03-05") }), { state: "variance_investigation", open_investigations: ["C60"], missing_metrics: [], awaiting_scorecard: [], event: null });
  const done = reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: computed, rows: [t60, closed.row, pd6], reconciled_on: D("2027-03-05") });
  assert.equal(done.state, "reconciled"); assert.equal(done.event!.type, "star.reconciled");
  assert.deepEqual(done.event!.payload, { as_of_month: "2027-01", view: "internal_total", reconciled_at: D("2027-03-05"), metrics: 3, within_tolerance: ["T60"], explained: ["C60"], suppressed: ["PD6"] });
  // a subset of the month's metrics never reconciles the month: C60 and PD6 uncompared → no event, the run stays scorecard_ingested
  const subset = reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: computed, rows: [t60], reconciled_on: D("2027-03-05") });
  assert.equal(subset.state, "scorecard_ingested"); assert.deepEqual(subset.missing_metrics, ["C60", "PD6"]); assert.equal(subset.event, null);
  // nor an empty list, a row for a metric the month did not compute, or a metric reconciled twice
  assert.throws(() => reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: computed, rows: [], reconciled_on: D("2027-03-05") }), RangeError);
  assert.throws(() => reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: [], rows: [t60], reconciled_on: D("2027-03-05") }), RangeError);
  assert.throws(() => reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: ["T60"], rows: [t60, pd6], reconciled_on: D("2027-03-05") }), /PD6: not among the metrics computed/);
  assert.throws(() => reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: computed, rows: [t60, t60, closed.row, pd6], reconciled_on: D("2027-03-05") }), /T60: reconciled twice/);
  // a computed metric with no scorecard row yet (rejected for manual entry) is `awaiting_scorecard` and blocks the event like an open investigation
  const waiting = reconcileMetric({ as_of_month: "2027-01", internal: metricResult("C60", 118, 412), scorecard: null });
  assert.equal(waiting.status, "awaiting_scorecard"); assert.equal(waiting.fnma_rate_bps, null); assert.equal(waiting.within_tolerance, false);
  const blocked = reconcileMonth({ as_of_month: "2027-01", view: "internal_total", computed_metrics: computed, rows: [t60, waiting, pd6], reconciled_on: D("2027-03-05") });
  assert.equal(blocked.state, "scorecard_ingested"); assert.deepEqual(blocked.awaiting_scorecard, ["C60"]); assert.equal(blocked.event, null);
  assert.equal(closeVarianceInvestigation(waiting, { classification: "reporting_timing", evidence_refs: ["investor_events:ack-1"], explanation: "x" }).refusal!.code, "VARIANCE_NOT_OPEN");
  // Fannie Mae published no score for a metric (< 30 loans on their side): reconciled when the denominators agree within 2 loans, otherwise the population difference is investigated
  const unscoredAgree = reconcileMetric({ as_of_month: "2027-01", internal: metricResult("MOD6", 24, 31), scorecard: { fnma_rate_bps: null, fnma_numerator: 22, fnma_denominator: 29 } });
  assert.equal(unscoredAgree.status, "reconciled"); assert.equal(unscoredAgree.delta_bps, null); assert.equal(unscoredAgree.internal_rate_bps, 7742); assert.match(unscoredAgree.explanation!, /published no score/);
  const unscoredApart = reconcileMetric({ as_of_month: "2027-01", internal: metricResult("MOD6", 30, 40), scorecard: { fnma_rate_bps: null, fnma_numerator: 22, fnma_denominator: 29 }, our_loans: ["M-1", "M-2"], their_loans: ["M-1"] });
  assert.equal(unscoredApart.status, "variance_investigation"); assert.deepEqual(unscoredApart.loan_level_diffs, { ours_not_theirs: ["M-2"], theirs_not_ours: [], source: "scorecard_loan_level" });
  assert.equal(reconcileMetric({ as_of_month: "2027-01", internal: metricResult("PD6", 9, 27), scorecard: { fnma_rate_bps: null, fnma_numerator: 9, fnma_denominator: 27 } }).status, "suppressed");
});
test('18.3-T6: Given a "Fannie Mae error" classification with one evidence ref, then the inquiry cannot be sent (guardrail).', () => {
  const officer = { officer_id: "off-1", signed_at: "2027-03-04T15:00:00Z" };
  const one = fnmaErrorInquiryGate({ classification: "fnma_error", evidence_refs: ["fnma_connect:dq-report-2027-01"], officer_signoff: officer });
  assert.equal(one.allowed, false); assert.equal(one.refusal!.code, "FNMA_ERROR_EVIDENCE_REFS"); assert.match(one.refusal!.reason, /1 independent evidence ref/);
  assert.match(one.refusal!.citation, /two independent evidence refs and `officer` sign-off before any inquiry is sent/);
  assert.equal(one.inquiry_required, true); assert.equal(one.escalation, null);
  // two refs from the same source are not independent
  const sameSource = fnmaErrorInquiryGate({ classification: "fnma_error", evidence_refs: ["fnma_connect:dq-report-2027-01", "fnma_connect:dq-report-2027-01-loan-level"], officer_signoff: officer });
  assert.equal(sameSource.allowed, false); assert.equal(sameSource.refusal!.code, "FNMA_ERROR_EVIDENCE_REFS"); assert.deepEqual(sameSource.independent_sources, ["fnma_connect"]);
  // two independent refs still cannot be sent without officer sign-off — the officer is escalated
  const noOfficer = fnmaErrorInquiryGate({ classification: "fnma_error", evidence_refs: ["fnma_connect:dq-report-2027-01", "investor_events:ack-2027-01-L-103"], officer_signoff: null });
  assert.equal(noOfficer.allowed, false); assert.equal(noOfficer.refusal!.code, "FNMA_ERROR_OFFICER_SIGNOFF"); assert.deepEqual(noOfficer.escalation, { kind: "officer", reason: "external inquiry (Fannie Mae error classification) awaiting officer sign-off" });
  const ok = fnmaErrorInquiryGate({ classification: "fnma_error", evidence_refs: ["fnma_connect:dq-report-2027-01", "investor_events:ack-2027-01-L-103"], officer_signoff: officer });
  assert.equal(ok.allowed, true); assert.equal(ok.refusal, null); assert.deepEqual(ok.independent_sources, ["fnma_connect", "investor_events"]);
  // other classifications raise no external inquiry
  assert.deepEqual(fnmaErrorInquiryGate({ classification: "data_defect", evidence_refs: ["qc_findings:F-1"], officer_signoff: null }), { allowed: true, independent_sources: ["qc_findings"], refusal: null, escalation: null, inquiry_required: false });
  // a Fannie Mae error closes the investigation and hands off to the (gated) inquiry
  const open = reconcileMetric({ as_of_month: "2027-01", internal: metricResult("C60", 118, 412), scorecard: { fnma_rate_bps: 2700, fnma_numerator: 110, fnma_denominator: 407 }, our_loans: ["L-1"], their_loans: [] });
  assert.equal(closeVarianceInvestigation(open, { classification: "fnma_error", evidence_refs: ["fnma_connect:dq-report-2027-01", "investor_events:ack-2027-01-L-1"], explanation: "Fannie Mae dropped L-1's cure" }).follow_up, "fnma_inquiry");
  // "never alter delinquency history to match a scorecard"
  const rewrite = delinquencyHistoryWriteGate({ target: "loan_delinquency_months", op: "write", reason: "align L-1 with scorecard" });
  assert.equal(rewrite.allowed, false); assert.equal(rewrite.refusal!.code, "NO_DELINQUENCY_HISTORY_REWRITE"); assert.match(rewrite.refusal!.instead, /classify the variance/);
  assert.deepEqual(delinquencyHistoryWriteGate({ target: "loan_delinquency_months", op: "read" }), { allowed: true, refusal: null });
  assert.deepEqual(delinquencyHistoryWriteGate({ target: "star_reconciliations", op: "write" }), { allowed: true, refusal: null });
});
test("18.3-T7: Given a foreclosure with 900 allowed days and 740 elapsed (160 days remaining) at base, when it exceeds 900 days within six months, then it counts in BEYOND_TF's numerator.", () => {
  // monthly snapshots after the January 2027 base: +31, +28, +31, +30, +31, +30 days → the July snapshot shows 921 > 900
  const running = [["2027-02-01", 771], ["2027-03-01", 799], ["2027-04-01", 830], ["2027-05-01", 860], ["2027-06-01", 891], ["2027-07-01", 921], ["2027-08-01", 952]] as const;
  const rows = running.map(([d, n]) => ({ as_of_month: D(d), fc_days_elapsed: n }));
  const r = beyondTimeframeTransition({ allowed_days: 900, elapsed_at_base: 740, base_month: D("2027-01-01"), elapsed_by_month: rows });
  assert.equal(r.days_remaining, 160); assert.equal(r.in_denominator, true);
  assert.deepEqual(r.window_months, ["2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07"]);
  assert.equal(r.transition_month, "2027-07"); assert.equal(r.in_numerator, true);
  // a loan resolved before the time frame runs out (sale in May) never transitions
  const resolved = beyondTimeframeTransition({ allowed_days: 900, elapsed_at_base: 740, base_month: D("2027-01-01"), elapsed_by_month: rows.slice(0, 3) });
  assert.equal(resolved.in_denominator, true); assert.equal(resolved.transition_month, null); assert.equal(resolved.in_numerator, false);
  // a transition after the six-month reporting period (first seen in the August snapshot) is outside the window
  const late = beyondTimeframeTransition({ allowed_days: 900, elapsed_at_base: 740, base_month: D("2027-01-01"), elapsed_by_month: [...rows.slice(0, 5), { as_of_month: D("2027-07-01"), fc_days_elapsed: 900 }, { as_of_month: D("2027-08-01"), fc_days_elapsed: 931 }] });
  assert.equal(late.transition_month, "2027-08"); assert.equal(late.in_numerator, false);
  // 200 days remaining at base is not "within 180 days of the state foreclosure time frame" — out of the denominator, so never in the numerator
  const far = beyondTimeframeTransition({ allowed_days: 900, elapsed_at_base: 700, base_month: D("2027-01-01"), elapsed_by_month: [{ as_of_month: D("2027-07-01"), fc_days_elapsed: 905 }] });
  assert.equal(far.days_remaining, 200); assert.equal(far.in_denominator, false); assert.equal(far.in_numerator, false);
  // LL-2025-01 allowable delays credited by Section 13 extend the time frame: 60 days of delay → 220 remaining → out of the cohort
  const delayed = beyondTimeframeTransition({ allowed_days: 900, elapsed_at_base: 740, base_month: D("2027-01-01"), elapsed_by_month: rows, allowable_delay_days: 60 });
  assert.equal(delayed.allowed_effective, 960); assert.equal(delayed.days_remaining, 220); assert.equal(delayed.in_denominator, false);
  // already beyond the time frame at base is not a transition
  assert.equal(beyondTimeframeTransition({ allowed_days: 900, elapsed_at_base: 910, base_month: D("2027-01-01"), elapsed_by_month: rows }).in_denominator, false);
});
test("18.3-T8: Given report 511 available on 2027-02-15, then ingestion completes by 2027-02-22 and reconciliation by 2027-03-08 (10 BD), else timers breach.", () => {
  const c = scorecardClocks({ available_on: D("2027-02-15") });
  assert.equal(c.ingest.code, "SM_STAR_SCORECARD_INGEST_5BD"); assert.equal(c.ingest.due, "2027-02-22"); assert.equal(c.ingest.satisfied_by, "star.scorecard.ingested"); assert.equal(c.ingest.breach, "sev3");
  assert.equal(c.reconcile.code, "SM_STAR_RECON_10BD"); assert.equal(c.reconcile.anchored_on, "ingest_deadline"); assert.equal(c.reconcile.due, "2027-03-08"); assert.equal(c.reconcile.satisfied_by, "star.reconciled"); assert.equal(c.reconcile.breach, "sev2_partner_report");
  // the registry rows compute the same dates from the same anchors
  assert.equal(dueFromRegistry("SM_STAR_SCORECARD_INGEST_5BD", "2027-02-15"), "2027-02-22");
  assert.equal(dueFromRegistry("SM_STAR_RECON_10BD", "2027-02-22"), "2027-03-08");
  const reg = overriddenRegistry();
  assert.equal(reg.get("SM_STAR_SCORECARD_INGEST_5BD")!.anchorField, "available_on"); assert.equal(reg.get("SM_STAR_SCORECARD_INGEST_5BD")!.satisfiedPattern!.type, "star.scorecard.ingested");
  assert.equal(reg.get("SM_STAR_RECON_10BD")!.anchorField, "ingested_at"); assert.equal(reg.get("SM_STAR_RECON_10BD")!.satisfiedPattern!.type, "star.reconciled");
  // business days, not +7 calendar days: a Friday 2027-02-12 availability skips Presidents' Day (02-15) → 02-22; 2027-11-19 skips Thanksgiving (11-25) → 11-29
  assert.equal(scorecardClocks({ available_on: D("2027-02-12") }).ingest.due, "2027-02-22");
  assert.equal(scorecardClocks({ available_on: D("2027-11-19") }).ingest.due, "2027-11-29");
  assert.equal(scorecardClocks({ available_on: D("2027-11-19"), ingested_at: D("2027-11-22") }).reconcile.due, "2027-12-07");
  // a scorecard row whose stated rate does not reproduce from its own totals is rejected for manual entry, and the scorecard is not ingested until it is entered: no event, the ingest clock keeps running
  const rows = [
    { metric_code: "T60", fnma_numerator: 86, fnma_denominator: 6210, fnma_rate_bps: 138, comp_rate_bps: 150, rank: 12, peer_group: "Select" },
    { metric_code: "C60", fnma_numerator: 108, fnma_denominator: 400, fnma_rate_bps: 2700, comp_rate_bps: 2600, rank: 9, peer_group: "Select" },
    { metric_code: "RET_EFF", fnma_numerator: 61, fnma_denominator: 190, fnma_rate_bps: 3300, comp_rate_bps: null, rank: null, peer_group: "Select" },
  ] as const;
  const partial = ingestScorecard({ view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", parsed_at: "2027-02-17T14:00:00Z", ingested_on: D("2027-02-17"), rows });
  assert.equal(partial.state, "scorecard_awaited"); assert.equal(partial.scorecards.length, 2); assert.deepEqual(partial.rejected.map((r) => r.metric_code), ["RET_EFF"]); assert.match(partial.rejected[0]!.reason, /stated 3300 bps ≠ 3211 bps from 61\/190; manual entry/);
  assert.equal(partial.event, null); assert.deepEqual(partial.pending_manual_entry, ["RET_EFF"]);
  assert.deepEqual(partial.manual_entry_task, { kind: "human_portal_task", task: "star_scorecard_manual_entry", document_id: "doc-511-2027-01", metrics: ["RET_EFF"] });
  assert.equal(scorecardClockStatus({ available_on: D("2027-02-15"), ingested_at: null, reconciled_at: null, today: D("2027-02-17") }).ingest.status, "open");
  // manual entry completes the ingestion: the event carries `ingested_at`, the reconciliation anchor; early ingestion pulls the reconciliation due date forward
  const ing = ingestScorecard({ view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", parsed_at: "2027-02-18T14:00:00Z", ingested_on: D("2027-02-18"), rows: [rows[0], rows[1], { ...rows[2], fnma_rate_bps: 3211 }] });
  assert.equal(ing.state, "scorecard_ingested"); assert.equal(ing.scorecards.length, 3); assert.deepEqual(ing.rejected, []); assert.deepEqual(ing.pending_manual_entry, []); assert.equal(ing.manual_entry_task, null);
  assert.deepEqual(ing.event, { type: "star.scorecard.ingested", payload: { view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", ingested_at: D("2027-02-18"), metrics: 3, unscored: [] } });
  const early = scorecardClocks({ available_on: D("2027-02-15"), ingested_at: ing.event!.payload.ingested_at });
  assert.equal(early.reconcile.anchored_on, "ingested_at"); assert.equal(early.reconcile.due, "2027-03-04");
  // a metric Fannie Mae did not score (< 30 loans) is a structured row with a null rate, not a rejection
  const unscored = ingestScorecard({ view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", parsed_at: "2027-02-18T14:00:00Z", ingested_on: D("2027-02-18"), rows: [rows[0], { metric_code: "PD6", fnma_numerator: 9, fnma_denominator: 27, fnma_rate_bps: null, comp_rate_bps: null, rank: null, peer_group: "Select" }] });
  assert.equal(unscored.state, "scorecard_ingested"); assert.deepEqual(unscored.event!.payload.unscored, ["PD6"]);
  assert.throws(() => ingestScorecard({ view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", parsed_at: "2027-02-18T14:00:00Z", ingested_on: D("2027-02-18"), rows: [] }), RangeError);
  assert.throws(() => ingestScorecard({ view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", parsed_at: "2027-02-18T14:00:00Z", ingested_on: D("2027-02-18"), rows: [rows[0], rows[0]] }), /T60 appears twice/);
  // on time: both satisfied
  const onTime = scorecardClockStatus({ available_on: D("2027-02-15"), ingested_at: D("2027-02-22"), reconciled_at: D("2027-03-08"), today: D("2027-03-09") });
  assert.equal(onTime.ingest.status, "satisfied"); assert.equal(onTime.reconcile.status, "satisfied"); assert.equal(onTime.state, "reconciled"); assert.equal(onTime.ingest.breach, null); assert.equal(onTime.reconcile.breach, null);
  // else timers breach: no ingestion by 02-23 → sev-3; ingested on time but not reconciled by 03-09 → sev-2 → partner report
  const noIngest = scorecardClockStatus({ available_on: D("2027-02-15"), ingested_at: null, reconciled_at: null, today: D("2027-02-23") });
  assert.equal(noIngest.ingest.status, "breached"); assert.equal(noIngest.ingest.breach!.kind, "sev3"); assert.equal(noIngest.reconcile.status, "not_armed"); assert.equal(noIngest.state, "scorecard_awaited");
  const noRecon = scorecardClockStatus({ available_on: D("2027-02-15"), ingested_at: D("2027-02-22"), reconciled_at: null, today: D("2027-03-09") });
  assert.equal(noRecon.ingest.status, "satisfied"); assert.equal(noRecon.reconcile.status, "breached"); assert.equal(noRecon.reconcile.breach!.kind, "sev2"); assert.match(noRecon.reconcile.breach!.action, /partner report/); assert.equal(noRecon.state, "scorecard_ingested");
  assert.equal(scorecardClockStatus({ available_on: D("2027-02-15"), ingested_at: D("2027-02-23"), reconciled_at: null, today: D("2027-02-23") }).ingest.status, "breached");
  assert.equal(scorecardClockStatus({ available_on: D("2027-02-15"), ingested_at: null, reconciled_at: null, today: D("2027-02-19") }).ingest.status, "open");
  // SM_STAR_RECON_10BD is triggered by `star.scorecard.ingested` and anchored on `ingested_at`: with nothing ingested by 03-09 only the ingest clock's sev-3 stands — the reconciliation clock is not armed and carries no sev-2
  const neverIngested = scorecardClockStatus({ available_on: D("2027-02-15"), ingested_at: null, reconciled_at: null, today: D("2027-03-09") });
  assert.equal(neverIngested.ingest.status, "breached"); assert.equal(neverIngested.ingest.breach!.kind, "sev3");
  assert.equal(neverIngested.reconcile.status, "not_armed"); assert.equal(neverIngested.reconcile.breach, null); assert.equal(neverIngested.reconcile.due, "2027-03-08"); assert.equal(neverIngested.state, "scorecard_awaited");

  // Through the TimerEngine, on one scorecard subject: the inbound Fannie Mae Connect availability (report 511, 2027-02-15) arms
  // SM_STAR_SCORECARD_INGEST_5BD due 2027-02-22; the ingestion event satisfies it and arms SM_STAR_RECON_10BD on `ingested_at` due 2027-03-08;
  // the reconciliation event satisfies that and arms the partner-report clock on `reconciled_at`.
  const engineRun = (): { clock: FixedClock; store: MemoryEventStore; engine: TimerEngine; em: () => StarEmitter } => {
    const clock = new FixedClock("2027-02-15T14:00:00Z"); const store = new MemoryEventStore(clock); const engine = new TimerEngine(overriddenRegistry(), store, { processes: ["18.3"] });
    return { clock, store, engine, em: () => ({ events: store, actor: { kind: "agent", id: "qc-audit" }, now: clock.now() }) };
  };
  const run = engineRun();
  const avail = ingestReportAvailability(run.em(), { report_id: 511, view: "master_partner", as_of_month: "2027-01", available_on: D("2027-02-15"), source: "email_subscription" });
  assert.equal(avail.event.type, "fnma.connect.report.available"); assert.equal(avail.event.payload.report_id, "511"); assert.equal(STAR_SCORECARD_REPORT_ID, "511");
  assert.equal(avail.event.payload.available_on, "2027-02-15"); assert.deepEqual(avail.event.aggregate, starScorecardSubject("master_partner", "2027-01")); assert.deepEqual(avail.subject, { kind: "star_scorecard", id: "master_partner:2027-01" });
  assert.equal(eventMatches(reg.get("SM_STAR_SCORECARD_INGEST_5BD")!.triggerPattern!, avail.event), true);
  assert.equal(reg.get("SM_STAR_SCORECARD_INGEST_5BD")!.triggerPattern!.raw, "fnma.connect.report.available{report_id=511}");
  // the UI-download package for fnma_portal_operator (report 511 is not API-exposed by default)
  assert.deepEqual(avail.portal_task, { kind: "human_portal_task", task: "star_scorecard_download", assignee: "fnma_portal_operator", report_id: "511", report: "star_scorecard", view: "master_partner", as_of_month: "2027-01", expected_file_name: "STAR_Scorecard_511_2027-01", download_by: D("2027-02-22") });
  assert.equal(avail.clock.due, "2027-02-22");
  const ingestInst = run.engine.byCode("SM_STAR_SCORECARD_INGEST_5BD");
  assert.equal(ingestInst.length, 1); assert.equal(ingestInst[0]!.status, "armed"); assert.equal(ingestInst[0]!.anchorDate, "2027-02-15"); assert.equal(ingestInst[0]!.dueDate, "2027-02-22");
  assert.deepEqual(ingestInst[0]!.subject, { kind: "star_scorecard", id: "master_partner:2027-01" });
  assert.equal(run.engine.byCode("SM_STAR_RECON_10BD").length, 0, "the reconciliation clock is not armed before ingestion");
  // another Connect report (a §5 delinquency report) is not the STAR Scorecard: the inbound record is refused and nothing is armed
  assert.throws(() => ingestReportAvailability(run.em(), { report_id: 512, view: "master_partner", as_of_month: "2027-01", available_on: D("2027-02-15"), source: "email_subscription" }), RangeError);
  assert.throws(() => ingestReportAvailability(run.em(), { report_id: "511", view: "master_partner", as_of_month: "2027-1", available_on: D("2027-02-15"), source: "email_subscription" }), RangeError);
  assert.equal(eventMatches(reg.get("SM_STAR_SCORECARD_INGEST_5BD")!.triggerPattern!, { ...avail.event, payload: { ...avail.event.payload, report_id: "512" } }), false);
  assert.equal(run.engine.byCode("SM_STAR_SCORECARD_INGEST_5BD").length, 1);
  // a partially structured scorecard appends nothing: the ingest clock keeps running
  run.clock.set("2027-02-17T14:00:00Z");
  const held = recordScorecardIngestion(run.em(), { view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", parsed_at: "2027-02-17T14:00:00Z", ingested_on: D("2027-02-17"), rows });
  assert.equal(held.appended, null); assert.equal(ingestInst[0]!.status, "armed");
  // ingestion completes on 2027-02-22: satisfied on time; SM_STAR_RECON_10BD armed on ingested_at → due 2027-03-08 (10 BD)
  run.clock.set("2027-02-22T20:00:00Z");
  const fullRows = [rows[0], { ...rows[1], fnma_numerator: 117, fnma_denominator: 410, fnma_rate_bps: 2854 }, { ...rows[2], fnma_rate_bps: 3211 }] as const;
  const ingested = recordScorecardIngestion(run.em(), { view: "master_partner", as_of_month: "2027-01", document_id: "doc-511-2027-01", parsed_at: "2027-02-22T20:00:00Z", ingested_on: D("2027-02-22"), rows: fullRows });
  assert.equal(ingested.appended!.type, "star.scorecard.ingested"); assert.equal(ingested.appended!.payload.ingested_at, "2027-02-22");
  assert.equal(eventMatches(reg.get("SM_STAR_SCORECARD_INGEST_5BD")!.satisfiedPattern!, ingested.appended!), true);
  assert.equal(ingestInst[0]!.status, "satisfied"); assert.equal(ingestInst[0]!.satisfiedByEventId, ingested.appended!.id);
  const reconInst = run.engine.byCode("SM_STAR_RECON_10BD");
  assert.equal(reconInst.length, 1); assert.equal(reconInst[0]!.status, "armed"); assert.equal(reconInst[0]!.anchorDate, "2027-02-22"); assert.equal(reconInst[0]!.dueDate, "2027-03-08");
  assert.deepEqual(reconInst[0]!.subject, { kind: "star_scorecard", id: "master_partner:2027-01" });
  assert.equal(run.engine.evaluate("2027-03-08T20:00:00Z").length, 0, "nothing breaches on the due date itself");
  // else timers breach: not reconciled by 2027-03-08 → sev-2 (→ partner report)
  const breaches = run.engine.evaluate("2027-03-09T12:00:00Z");
  assert.deepEqual(breaches.map((b) => [b.instance.code, b.severity]), [["SM_STAR_RECON_10BD", 2]]); assert.match(breaches[0]!.breachText, /partner report/); assert.equal(reconInst[0]!.status, "breached");
  // the late reconciliation (every computed metric within tolerance) satisfies it late and arms the partner-report clock on reconciled_at (2027-03-09 + 5 BD = 2027-03-16)
  run.clock.set("2027-03-09T15:00:00Z");
  const internal = computeMetrics({ program_year: 2027, as_of_month: "2027-01", view: "master_partner", config_version: "2026.1", computed_at: AT, cohorts: [{ metric: "T60", population: 6210, excluded: 0, numerator: 87 }, { metric: "C60", population: 435, excluded: 23, numerator: 118 }, { metric: "RET_EFF", population: 190, excluded: 0, numerator: 61 }] });
  const reconRows = internal.results.map((r) => { const sc = ingested.scorecards.find((s) => s.metric_code === r.metric)!; return reconcileMetric({ as_of_month: "2027-01", internal: r, scorecard: { fnma_rate_bps: sc.fnma_rate_bps, fnma_numerator: sc.fnma_numerator, fnma_denominator: sc.fnma_denominator } }); });
  assert.deepEqual(reconRows.map((r) => [r.metric_code, r.delta_bps, r.status]), [["T60", 2, "reconciled"], ["C60", 10, "reconciled"], ["RET_EFF", 0, "reconciled"]]);
  const reconciled = recordReconciliation(run.em(), { as_of_month: "2027-01", view: "master_partner", computed_metrics: internal.results.map((r) => r.metric), rows: reconRows, reconciled_on: D("2027-03-09") });
  assert.equal(reconciled.appended!.type, "star.reconciled"); assert.equal(reconciled.appended!.payload.reconciled_at, "2027-03-09");
  assert.equal(reconInst[0]!.status, "satisfied_late"); assert.equal(reconInst[0]!.satisfiedByEventId, reconciled.appended!.id);
  const reportInst = run.engine.byCode("SM_STAR_PARTNER_REPORT_MONTHLY");
  assert.equal(reportInst.length, 1); assert.equal(reportInst[0]!.status, "armed"); assert.equal(reportInst[0]!.anchorDate, "2027-03-09"); assert.equal(reportInst[0]!.dueDate, "2027-03-16");
  assert.equal(partnerReportClock({ reconciled_at: D("2027-03-09"), carries_star_data: true }).due, "2027-03-16");
  // the officer-signed partner report closes the last clock
  run.clock.set("2027-03-12T15:00:00Z");
  const delivered = recordPartnerReportDelivery(run.em(), { view: "master_partner", as_of_month: "2027-01", reconciled_at: D("2027-03-09"), delivered_on: D("2027-03-12"), carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: { officer_id: "off-1", signed_at: "2027-03-12T14:00:00Z" }, recipients: [{ id: "partner-ops", audience: "partner" }, { id: "news@vendor", audience: "vendor" }], text: "STAR Replica & Reconciliation Report, January 2027 — all metrics within tolerance." });
  assert.equal(delivered.appended!.type, "star.partner_report.delivered"); assert.deepEqual(delivered.appended!.payload.recipients, ["partner-ops"]); assert.equal(delivered.on_time, true);
  assert.equal(reportInst[0]!.status, "satisfied");
  assert.deepEqual(run.store.all().filter((e) => e.type.startsWith("timer.")).map((e) => [e.type, (e.payload as { code: string }).code]), [
    ["timer.armed", "SM_STAR_SCORECARD_INGEST_5BD"], ["timer.satisfied", "SM_STAR_SCORECARD_INGEST_5BD"], ["timer.armed", "SM_STAR_RECON_10BD"], ["timer.breached", "SM_STAR_RECON_10BD"],
    ["timer.satisfied", "SM_STAR_RECON_10BD"], ["timer.armed", "SM_STAR_PARTNER_REPORT_MONTHLY"], ["timer.satisfied", "SM_STAR_PARTNER_REPORT_MONTHLY"],
  ]);
  // else timers breach (ingest side): no ingestion by 2027-02-22 end of day → sev-3, and only the ingest clock exists to breach
  const late = engineRun();
  ingestReportAvailability(late.em(), { report_id: "511", view: "master_partner", as_of_month: "2027-01", available_on: D("2027-02-15"), source: "ui_download" });
  assert.equal(late.engine.evaluate("2027-02-22T20:00:00Z").length, 0);
  const lateBreaches = late.engine.evaluate("2027-02-23T12:00:00Z");
  assert.deepEqual(lateBreaches.map((b) => [b.instance.code, b.severity, b.breachText]), [["SM_STAR_SCORECARD_INGEST_5BD", 3, "sev-3"]]);
  assert.equal(late.engine.byCode("SM_STAR_RECON_10BD").length, 0);
  // an API-entitled pull needs no portal task
  assert.equal(ingestReportAvailability(late.em(), { report_id: "511", view: "acting_supermortgage", as_of_month: "2027-01", available_on: D("2027-02-15"), source: "api_pull", api_entitled: true }).portal_task, null);
});
test('18.3-T9: Given a vendor newsletter draft citing "STAR-level performance," then the confidentiality filter blocks it.', () => {
  const draft = "Vendor update: Supermortgage delivers STAR-level performance for its partners this quarter.";
  const r = confidentialityGate({ audience: "vendor", kind: "newsletter", text: draft });
  assert.equal(r.allowed, false); assert.equal(r.mentions_star_results, true);
  assert.equal(r.refusal!.code, "STAR_CONFIDENTIALITY"); assert.match(r.refusal!.matched, /STAR-level performance/);
  assert.match(r.refusal!.citation, /may not disclose STAR Scorecard results to any third parties by any means/);
  assert.match(r.refusal!.reason, /a servicer may not disclose STAR Scorecard results to any third parties by any means/);
  assert.deepEqual(r.refusal!.escalation, { kind: "officer", reason: "third-party newsletter draft cited STAR results; blocked by the confidentiality filter" });
  assert.equal(distributionFilter({ audience: "vendor", text: draft }).blocked, true);
  assert.equal(confidentialityGate({ audience: "marketing", kind: "marketing_material", text: "We ranked in the STAR scorecard top three" }).allowed, false);
  // edge case: do not claim "STAR performance" externally — nor recognition phrased around the peer group
  assert.equal(confidentialityGate({ audience: "vendor", kind: "newsletter", text: "Press release: Supermortgage's STAR performance leads the industry." }).allowed, false);
  assert.equal(confidentialityGate({ audience: "marketing", kind: "marketing_material", text: "We were a top three performer in our STAR peer group in 2026." }).allowed, false);
  assert.equal(confidentialityGate({ audience: "vendor", kind: "newsletter", text: "Our STAR results: C60 at 2,864 bps." }).allowed, false);
  // naming the program without a result, or a lowercase "star", is not a disclosure
  assert.equal(starResultsMention("Supermortgage participates in Fannie Mae's STAR Program as a subservicer."), null);
  assert.equal(starResultsMention("Five-star service ratings from our borrowers."), null);
  // the same words are fine internally and to Fannie Mae; the partner only under the confidentiality clause
  assert.equal(confidentialityGate({ audience: "internal", kind: "internal_report", text: draft }).allowed, true);
  assert.equal(confidentialityGate({ audience: "fnma", kind: "fnma_inquiry", text: "our STAR results show C60 at 2,864 bps" }).allowed, true);
  assert.equal(confidentialityGate({ audience: "partner", kind: "partner_report", text: draft, partner_confidentiality_clause: true }).allowed, true);
  const partnerNoClause = confidentialityGate({ audience: "partner", kind: "partner_report", text: draft, partner_confidentiality_clause: false });
  assert.equal(partnerNoClause.allowed, false); assert.match(partnerNoClause.refusal!.reason, /subservicing-agreement confidentiality clause/); assert.equal(partnerNoClause.refusal!.escalation, null);
  // recognition may be shared only inside Fannie Mae's marketing package
  assert.equal(confidentialityGate({ audience: "marketing", kind: "marketing_material", text: "Recognised as a top three STAR performer for 2026.", fnma_marketing_package: true }).allowed, true);
  assert.equal(confidentialityGate({ audience: "marketing", kind: "marketing_material", text: "Recognised as a top three STAR performer for 2026." }).allowed, false);
  // a vendor newsletter that does not cite STAR passes
  assert.deepEqual(confidentialityGate({ audience: "vendor", kind: "newsletter", text: "Vendor update: new document upload portal goes live in October." }), { allowed: true, mentions_star_results: false, refusal: null });
  // distribution-list screen on a STAR-bearing report
  const dl = screenDistributionList({ text: "Monthly STAR results attached", recipients: [{ id: "ops@sm", audience: "internal" }, { id: "news@vendor", audience: "vendor" }, { id: "partner-ops", audience: "partner" }], partner_confidentiality_clause: true });
  assert.deepEqual(dl.allowed.map((x) => x.id), ["ops@sm", "partner-ops"]); assert.deepEqual(dl.dropped.map((x) => x.id), ["news@vendor"]); assert.deepEqual(dl.screened_on, ["text"]);
  // the filter keys on the report's STAR classification, not on its wording: a report flagged carries_star_data is withheld from vendor and marketing recipients even when the text never says "STAR"
  const replica = "Monthly replica report attached: C60 2,864 bps, rank 9 of 41.";
  assert.equal(starResultsMention(replica), null);
  const classified = screenDistributionList({ text: replica, carries_star_data: true, recipients: [{ id: "partner-ops", audience: "partner" }, { id: "news@vendor", audience: "vendor" }, { id: "pr@marketing", audience: "marketing" }, { id: "ops@sm", audience: "internal" }], partner_confidentiality_clause: true });
  assert.deepEqual(classified.allowed.map((x) => x.id), ["partner-ops", "ops@sm"]); assert.deepEqual(classified.dropped.map((x) => x.id), ["news@vendor", "pr@marketing"]); assert.deepEqual(classified.screened_on, ["classification"]);
  assert.match(classified.dropped[0]!.reason, /carries STAR Scorecard data/); assert.match(classified.dropped[0]!.reason, /may not disclose STAR Scorecard results to any third parties/);
  const flagged = confidentialityGate({ audience: "vendor", kind: "distribution_list", text: replica, carries_star_data: true });
  assert.equal(flagged.allowed, false); assert.equal(flagged.refusal!.matched, CARRIES_STAR_DATA_MATCH); assert.deepEqual(flagged.refusal!.escalation, { kind: "officer", reason: "third-party distribution_list carries STAR Scorecard data; blocked by the confidentiality filter" });
  assert.equal(confidentialityGate({ audience: "partner", kind: "partner_report", text: replica, carries_star_data: true }).allowed, false, "the partner needs the clause for classified data too");
  assert.equal(confidentialityGate({ audience: "partner", kind: "partner_report", text: replica, carries_star_data: true, partner_confidentiality_clause: true }).allowed, true);
  assert.equal(confidentialityGate({ audience: "internal", kind: "internal_report", text: replica, carries_star_data: true }).allowed, true);
  // scorecard data never travels in Fannie Mae's marketing package — only recognition wording does
  assert.equal(confidentialityGate({ audience: "marketing", kind: "marketing_material", text: "Recognised as a top three STAR performer for 2026.", carries_star_data: true, fnma_marketing_package: true }).allowed, false);
  // the text screen reads the whole draft, not one sentence at a time, and knows the program's spelled-out name
  assert.equal(confidentialityGate({ audience: "vendor", kind: "newsletter", text: "Fannie Mae runs STAR. We ranked top three in our peer group this year." }).allowed, false);
  assert.equal(starResultsMention("Fannie Mae runs STAR. We ranked top three in our peer group this year."), "Fannie Mae runs STAR. … We ranked top three in our peer group this year.");
  assert.equal(confidentialityGate({ audience: "vendor", kind: "newsletter", text: "Monthly Servicer Total Achievement and Rewards replica report attached: C60 2,864 bps, rank 9 of 41." }).allowed, false);
  assert.equal(starResultsMention("Fannie Mae runs the STAR Program. Our new upload portal goes live in October."), null);
});

test("18.3 worked figures (Select weights, base month Jan 2027): T60 87/6,210 → 140 bps; C60 435 − 23 = 412, 118 cures → 2,864 bps (119 → 2,888); RET_EFF 61/190 → 3,211 bps; PD6 denominator 27 suppressed and out of the composite; config due Jan 31; partner report due 5 BD after reconciliation 2027-03-08 → 2027-03-15", () => {
  assert.equal(rateBps(87, 6210), 140);
  assert.equal(rateBps(118, 412), 2864); assert.equal(rateBps(119, 412), 2888);
  assert.equal(rateBps(61, 190), 3211);
  const run = computeMetrics({ program_year: 2027, as_of_month: "2027-01", view: "internal_total", config_version: "2026.1", computed_at: AT, cohorts: [
    { metric: "T60", population: 6210, excluded: 0, numerator: 87 }, { metric: "C60", population: 435, excluded: 23, numerator: 118 }, { metric: "RET_EFF", population: 190, excluded: 0, numerator: 61 }, { metric: "PD6", population: 27, excluded: 0, numerator: 9 },
  ] });
  // C60: 435 loans 60+ at base, 23 in active repayment plans excluded → the engine's denominator is 412
  assert.equal(run.results.find((r) => r.metric_code === "C60")!.denominator, 412);
  assert.deepEqual(run.results.map((r) => [r.metric_code, r.denominator, r.rate_bps, r.suppressed]), [["T60", 6210, 140, false], ["C60", 412, 2864, false], ["RET_EFF", 190, 3211, false], ["PD6", 27, null, true]]);
  // Select weights 45/40/15 (a < 40,000-loan book is not in a peer group at all — internal_total view, no Comp)
  assert.deepEqual(STAR_WEIGHTS_2026.Select, { T60: 45, C60: 40, RET_EFF: 15 });
  assert.equal(peerGroup(39_999), null); assert.equal(peerGroup(40_000), "Select"); assert.equal(peerGroup(129_999), "Select"); assert.equal(peerGroup(130_000), "Premier"); assert.equal(peerGroup(449_999), "Premier"); assert.equal(peerGroup(450_000), "Strategic");
  // normalized_score_i with no scorecard = the metric's percentile vs. the internal prior-12-month distribution (direction-aware, ties count half)
  assert.deepEqual(LOWER_IS_BETTER, { T60: true, C60: false, RET_EFF: false, MOD6: false, PD6: false, BEYOND_TF: true });
  const prior = {
    T60: [152, 148, 161, 139, 155, 143, 150, 158, 147, 140, 162, 149],           // 140 beats 10 of 12, ties 1 → 87.5 (lower is better)
    C60: [2700, 2810, 2755, 2900, 2864, 2690, 2820, 2780, 2950, 2730, 2801, 2799], // 2,864 beats 9, ties 1 → 79.17
    RET_EFF: [3000, 3100, 3250, 3150, 3300, 3050, 3211, 3180, 3120, 3400, 3090, 3010], // 3,211 beats 8, ties 1 → 70.83
  } as const;
  assert.equal(percentileRank(140, prior.T60, true), 87.5); assert.equal(percentileRank(2864, prior.C60, false), 79.17); assert.equal(percentileRank(3211, prior.RET_EFF, false), 70.83);
  assert.deepEqual(normalizedScore({ metric: "T60", rate_bps: 140, suppressed: false, reference: { comp_rates_bps: [], prior_12_month_bps: prior.T60 } }), { percentile: 87.5, basis: "internal_prior_12_months", reference_size: 12 });
  const noScorecard = { T60: { comp_rates_bps: [], prior_12_month_bps: prior.T60 }, C60: { comp_rates_bps: [], prior_12_month_bps: prior.C60 }, RET_EFF: { comp_rates_bps: [], prior_12_month_bps: prior.RET_EFF } };
  const select = compositeWithReferences(run.results, "Select", noScorecard);
  // composite = (45 × 87.5 + 40 × 79.17 + 15 × 70.83) / 100 = 81.67; PD6 is not a Select metric
  assert.deepEqual(select.scores, [{ metric: "T60", percentile: 87.5, basis: "internal_prior_12_months" }, { metric: "C60", percentile: 79.17, basis: "internal_prior_12_months" }, { metric: "RET_EFF", percentile: 70.83, basis: "internal_prior_12_months" }]);
  assert.equal(select.composite, Math.round(((45 * 87.5 + 40 * 79.17 + 15 * 70.83) / 100) * 100) / 100); assert.equal(select.composite, 81.67); assert.deepEqual(select.included, ["T60", "C60", "RET_EFF"]); assert.deepEqual(select.excluded_suppressed, []);
  assert.equal(compositeFor(run.results, "Select", (m) => select.scores.find((s) => s.metric === m)!.percentile!).composite, 81.67);
  // once a scorecard exists the score is the percentile vs. Comp (this month's and any earlier Comps on file): C60 2,864 vs Comp 2,600 → 100; vs [2,600, 2,700, 2,900] → 66.67; a Comp ties at 50
  assert.deepEqual(normalizedScore({ metric: "C60", rate_bps: 2864, suppressed: false, reference: { comp_rates_bps: [2600], prior_12_month_bps: prior.C60 } }), { percentile: 100, basis: "comp", reference_size: 1 });
  assert.equal(normalizedScore({ metric: "C60", rate_bps: 2864, suppressed: false, reference: { comp_rates_bps: [2600, 2700, 2900], prior_12_month_bps: [] } }).percentile, 66.67);
  assert.equal(normalizedScore({ metric: "C60", rate_bps: 2864, suppressed: false, reference: { comp_rates_bps: [2864], prior_12_month_bps: [] } }).percentile, 50);
  assert.equal(normalizedScore({ metric: "T60", rate_bps: 140, suppressed: false, reference: { comp_rates_bps: [150], prior_12_month_bps: [] } }).percentile, 100, "lower is better: 140 beats a 150 Comp");
  // only the last 12 months of the internal distribution count; a live metric with no reference at all cannot be normalized
  assert.equal(normalizedScore({ metric: "T60", rate_bps: 140, suppressed: false, reference: { comp_rates_bps: [], prior_12_month_bps: [999, ...prior.T60] } }).reference_size, 12);
  assert.throws(() => normalizedScore({ metric: "T60", rate_bps: 140, suppressed: false, reference: { comp_rates_bps: [], prior_12_month_bps: [] } }), RangeError);
  assert.throws(() => percentileRank(140, [], true), RangeError);
  // program-year config: due Jan 31; the 2026 weights sum to 100 per peer group; unverified guide formulas keep the pipeline internal-only
  assert.deepEqual(configClock({ program_year: 2027 }), { code: "SM_STAR_CONFIG_ANNUAL_JAN", anchor: D("2027-01-01"), due: D("2027-01-31"), satisfied_by: "star.config.published", breach: "sev2" });
  const row = (metric_code: StarMetricsConfigRow["metric_code"], verified: boolean): StarMetricsConfigRow => ({ program_year: 2027, metric_code, version: "2027.1", definition: { min_denominator: 30, lookback_months: 6, exclusions: ["transferor_transfer_month", "transferee_two_months"], lower_is_better: metric_code === "T60" || metric_code === "BEYOND_TF" }, weight_by_peer_group: { Strategic: STAR_WEIGHTS_2026.Strategic[metric_code as "T60"] ?? 0, Premier: STAR_WEIGHTS_2026.Premier[metric_code as "T60"] ?? 0, Select: STAR_WEIGHTS_2026.Select[metric_code as "T60"] ?? 0 }, source_citation: "STAR FAQs (Apr. 6, 2026)", verified });
  const cfg = publishConfig({ program_year: 2027, version: "2027.1", published_on: D("2027-01-20"), rows: [row("T60", true), row("C60", true), row("RET_EFF", true), row("MOD6", false), row("PD6", false), row("BEYOND_TF", true)] });
  assert.deepEqual(cfg.unverified, ["MOD6", "PD6"]); assert.equal(cfg.external_use_allowed, false); assert.equal(cfg.on_time, true);
  assert.deepEqual(cfg.event, { type: "star.config.published", payload: { year: 2027, version: "2027.1", published_on: D("2027-01-20"), metrics: 6, verified: false } });
  assert.throws(() => publishConfig({ program_year: 2027, version: "2027.1", published_on: D("2027-01-20"), rows: [row("T60", true), row("C60", true)] }), /Strategic weights sum to 55/);
  assert.throws(() => publishConfig({ program_year: 2027, version: "2027.1", published_on: D("2027-01-20"), rows: [{ ...row("T60", true), definition: { ...row("T60", true).definition, min_denominator: 25 } }, row("C60", true), row("RET_EFF", true), row("MOD6", false), row("PD6", false), row("BEYOND_TF", true)] }), /min_denominator must be 30/);
  // partner report: reconciled 2027-03-08 → due 2027-03-15; STAR-bearing → officer sign-off under the clause
  const clock = partnerReportClock({ reconciled_at: D("2027-03-08"), carries_star_data: true });
  assert.equal(clock.due, "2027-03-15"); assert.equal(clock.satisfied_by, "star.partner_report.delivered"); assert.equal(clock.officer_signoff_required, true);
  assert.equal(dueFromRegistry("SM_STAR_PARTNER_REPORT_MONTHLY", "2027-03-08"), "2027-03-15");
  assert.equal(partnerReportRelease({ carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: null }).refusal!.code, "OFFICER_SIGNOFF_REQUIRED");
  assert.equal(partnerReportRelease({ carries_star_data: true, partner_confidentiality_clause: false, officer_signoff: { officer_id: "off-1", signed_at: "2027-03-10T15:00:00Z" } }).refusal!.code, "STAR_CONFIDENTIALITY");
  assert.equal(partnerReportRelease({ carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: { officer_id: "off-1", signed_at: "2027-03-10T15:00:00Z" } }).event, "star.partner_report.delivered");
  const delivery = deliverPartnerReport({ as_of_month: "2027-01", reconciled_at: D("2027-03-08"), delivered_on: D("2027-03-12"), carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: { officer_id: "off-1", signed_at: "2027-03-10T15:00:00Z" }, text: "STAR Replica & Reconciliation Report — STAR results for January 2027", recipients: [{ id: "partner-ops", audience: "partner" }, { id: "news@vendor", audience: "vendor" }] });
  assert.equal(delivery.on_time, true); assert.deepEqual(delivery.distribution.dropped.map((d) => d.id), ["news@vendor"]);
  assert.deepEqual(delivery.event, { type: "star.partner_report.delivered", payload: { as_of_month: "2027-01", template: "STAR-RPT-MONTHLY-v1", delivered_at: D("2027-03-12"), recipients: ["partner-ops"], officer_id: "off-1" } });
  assert.equal(deliverPartnerReport({ as_of_month: "2027-01", reconciled_at: D("2027-03-08"), delivered_on: D("2027-03-12"), carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: null, text: "STAR results", recipients: [{ id: "partner-ops", audience: "partner" }] }).event, null);
  // the distribution screen keys on the report's STAR classification: a carries_star_data report whose text never says "STAR" still never reaches vendor or marketing recipients
  const spelledOut = deliverPartnerReport({ as_of_month: "2027-01", reconciled_at: D("2027-03-08"), delivered_on: D("2027-03-12"), carries_star_data: true, partner_confidentiality_clause: true, officer_signoff: { officer_id: "off-1", signed_at: "2027-03-10T15:00:00Z" }, text: "Monthly replica report attached: C60 2,864 bps, rank 9 of 41.", recipients: [{ id: "partner-ops", audience: "partner" }, { id: "news@vendor", audience: "vendor" }, { id: "pr@marketing", audience: "marketing" }] });
  assert.deepEqual(spelledOut.distribution.allowed.map((r) => r.id), ["partner-ops"]); assert.deepEqual(spelledOut.distribution.dropped.map((r) => r.id), ["news@vendor", "pr@marketing"]); assert.deepEqual(spelledOut.distribution.screened_on, ["classification"]);
  assert.deepEqual(spelledOut.event!.payload.recipients, ["partner-ops"]);
  // a report that does not carry STAR data (internal metrics only, no scorecard) goes to every recipient the text allows
  const plain = deliverPartnerReport({ as_of_month: "2027-01", reconciled_at: D("2027-03-08"), delivered_on: D("2027-03-12"), carries_star_data: false, partner_confidentiality_clause: false, officer_signoff: null, text: "Monthly servicing performance report attached.", recipients: [{ id: "partner-ops", audience: "partner" }, { id: "news@vendor", audience: "vendor" }] });
  assert.deepEqual(plain.distribution.dropped, []); assert.deepEqual(plain.distribution.screened_on, []); assert.deepEqual(plain.event!.payload.recipients, ["partner-ops"]);
});

test("18.3 guardrails in bus shape (never / needsRole over the domain gates): delinquency history is never rewritten to match a scorecard; a Fannie Mae error inquiry needs two independent evidence refs and the officer; third-party distribution of STAR results is refused", () => {
  const ctx = (role: string | null): CommandContext => ({ actor: role ? { kind: "human", id: `u-${role}`, role } : { kind: "agent", id: "qc-audit" }, now: "2027-03-04T15:00:00Z" } as unknown as CommandContext);
  const g = GUARDRAILS_18_3;
  assert.equal(g.noDelinquencyHistoryRewrite.code, "NO_DELINQUENCY_HISTORY_REWRITE"); assert.match(g.noDelinquencyHistoryRewrite.citation, /never alter delinquency history to match a scorecard/);
  assert.match(g.noDelinquencyHistoryRewrite.refuse({ op: "write", target: "loan_delinquency_months", changes: { fnma_delinquency_status: "current" } }, ctx("officer"))!, /classify the variance/);
  assert.equal(g.noDelinquencyHistoryRewrite.refuse({ op: "read", target: "loan_delinquency_months" }, ctx(null)), undefined);
  assert.equal(g.noDelinquencyHistoryRewrite.refuse({ op: "write", target: "star_reconciliations" }, ctx(null)), undefined);
  const twoRefs = ["fnma_connect:dq-report-2027-01", "investor_events:ack-2027-01-L-103"];
  assert.match(g.fnmaErrorEvidenceRefs.refuse({ classification: "fnma_error", send: true, evidence_refs: ["fnma_connect:dq-report-2027-01"] }, ctx("officer"))!, /two independent evidence refs/);
  assert.match(g.fnmaErrorEvidenceRefs.refuse({ classification: "fnma_error", send: true, evidence_refs: ["fnma_connect:dq-1", "fnma_connect:dq-2"] }, ctx("officer"))!, /two independent evidence refs/);
  assert.equal(g.fnmaErrorEvidenceRefs.refuse({ classification: "fnma_error", send: true, evidence_refs: twoRefs }, ctx(null)), undefined);
  assert.match(g.fnmaErrorOfficerSignoff.refuse({ classification: "fnma_error", send: true, evidence_refs: twoRefs }, ctx(null))!, /officer sign-off; requires officer/);
  assert.equal(g.fnmaErrorOfficerSignoff.refuse({ classification: "fnma_error", send: true, evidence_refs: twoRefs }, ctx("officer")), undefined);
  assert.equal(g.fnmaErrorOfficerSignoff.refuse({ classification: "fnma_error", send: false, evidence_refs: twoRefs }, ctx(null)), undefined, "drafting is not sending");
  assert.equal(g.fnmaErrorOfficerSignoff.refuse({ classification: "data_defect", send: true, evidence_refs: ["qc_findings:F-1"] }, ctx(null)), undefined);
  assert.match(g.confidentialityFilter.refuse({ audience: "vendor", kind: "newsletter", text: "Supermortgage delivers STAR-level performance." }, ctx("officer"))!, /STAR Scorecard results are confidential/);
  assert.match(g.confidentialityFilter.refuse({ audience: "partner", kind: "partner_report", text: "STAR results attached" }, ctx(null))!, /confidentiality clause/);
  assert.equal(g.confidentialityFilter.refuse({ audience: "partner", kind: "partner_report", text: "STAR results attached", partner_confidentiality_clause: true }, ctx(null)), undefined);
  assert.equal(g.confidentialityFilter.refuse({ audience: "internal", kind: "internal_report", text: "STAR results attached" }, ctx(null)), undefined);
  assert.equal(g.confidentialityFilter.refuse({ audience: "vendor", kind: "newsletter", text: "New document upload portal goes live in October." }, ctx(null)), undefined);
  // the classification flag is honoured on the bus: a carries_star_data report is refused for a vendor whatever its wording
  assert.match(g.confidentialityFilter.refuse({ audience: "vendor", kind: "distribution_list", text: "Monthly replica report attached: C60 2,864 bps.", carries_star_data: true }, ctx("officer"))!, /STAR Scorecard results are confidential/);
  assert.equal(g.confidentialityFilter.refuse({ audience: "partner", kind: "distribution_list", text: "Monthly replica report attached: C60 2,864 bps.", carries_star_data: true, partner_confidentiality_clause: true }, ctx(null)), undefined);
});
