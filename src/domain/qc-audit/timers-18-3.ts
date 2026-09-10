/**
 * §18.3 timer satisfaction overrides: for every 18.3 registry row whose "Satisfied by"
 * column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides, so these win the merge.
 * The events named here are the ones src/domain/qc-audit/ops-18-3.ts produces: computeMetrics →
 * `star.metrics.computed`, ingestScorecard → `star.scorecard.ingested{ingested_at}`, reconcileMonth →
 * `star.reconciled{reconciled_at}`, publishConfig → `star.config.published{year}`, deliverPartnerReport →
 * `star.partner_report.delivered`.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_18_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("SM_STAR_COMPUTE_MONTHLY_BD5", {
    trigger: "`investor_reporting_periods.closed{checklist_complete=true}`",
    anchorField: "period_end",
    offset: "BD5",
    satisfied: "`star.metrics.computed`",
    why: "§18.3 timer table: Fannie Mae period close (BD2) → metrics computed by BD5 `business_days_fannie_et` of the month after the reporting period (\"after investor reporting is final\"). The trigger is §5's period close with the rule-10 checklist complete (`investor_reporting_periods.closed{checklist_complete=true}`, payload `periodAnchors()` in src/domain/investor/period.ts, which always carries `period_end`); the anchor is the period's last calendar day, so +5 Fannie business days lands on BD5 of the following month — anchored on the BD2 close date itself the same offset would land on BD7, which is why the anchor is a payload field and why `computeClockFromPeriodClose` in ops-18-3.ts falls back to the month before the close date, never to the close date.",
  });
  o("SM_STAR_SCORECARD_INGEST_5BD", {
    trigger: "`fnma.connect.report.available{report_id=511}`",
    anchorField: "available_on",
    satisfied: "`star.scorecard.ingested`",
    why: "§18.3 timer table: `fnma.connect.report.available{511}` (availability) → scorecard ingested within 5 business days, sev-3 on breach. The registry's `{511}` is the report's Fannie Mae Connect id (spec: \"published in Fannie Mae Connect … `reportId=511`\"; Integrations: \"report 511 STAR Scorecard\"), not a payload field — the platform's `fnma.connect.report.available` events (§5.4/5.7 and `ingestReportAvailability` in ops-18-3.ts) spell it as the `report_id` field, so the trigger conditions on `report_id=511` and only the STAR Scorecard availability arms this clock; anchored on the event's `available_on`. 18.3-T8: available 2027-02-15 → ingested by 2027-02-22 (`scorecardClocks` in ops-18-3.ts; `ingestScorecard` emits the satisfying event with `ingested_at` only once every scorecard row is structured — a row rejected for manual entry keeps the clock running).",
  });
  o("SM_STAR_RECON_10BD", {
    anchorField: "ingested_at",
    why: "§18.3 timer table: `star.scorecard.ingested` (ingested_at) → `star.reconciled` \"(all metrics within tolerance or explained)\" within 10 business days, sev-2 → partner report on breach. The registry's satisfied text is kept verbatim (its pattern parses to `star.reconciled`); the parenthetical is enforced by `reconcileMonth`, which emits the event only when every metric `star.metrics.computed` produced for the month has a reconciliation row that is within tolerance, explained or suppressed — a subset, an empty list or a metric still awaiting its scorecard row never satisfies it. The clock is not armed before ingestion (`scorecardClockStatus` reports `not_armed`, no sev-2) (18.3-T8: ingested 2027-02-22 → reconciled by 2027-03-08).",
  });
  o("SM_STAR_CONFIG_ANNUAL_JAN", {
    satisfied: "`star.config.published{year}`",
    why: "§18.3 timer table: program year (Jan 1) → `star_metrics_config` loaded by Jan 31 (the February scorecard reflects the changes), sev-2 on breach; `publishConfig` emits `star.config.published{year, version}` after validating min_denominator 30 and 100-point peer-group weights.",
  });
  o("SM_STAR_PARTNER_REPORT_MONTHLY", {
    trigger: "`star.reconciled`",
    anchorField: "reconciled_at",
    offset: "+5 business_days_servicer",
    satisfied: "`star.partner_report.delivered`",
    why: "§18.3 timer table: `star.reconciled` (reconciled_at) → 'partner report delivered' within 5 business days, sev-3 on breach — the monthly STAR Replica & Reconciliation Report (STAR-RPT-MONTHLY-v1) sent through the partner channel; `deliverPartnerReport` withholds the delivery event until `officer` sign-off when the report carries STAR data under the subservicing agreement's confidentiality clause and after the distribution-list screen.",
  });
}
