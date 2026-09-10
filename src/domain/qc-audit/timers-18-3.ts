/**
 * §18.3 timer satisfaction overrides: for every 18.3 registry row whose "Satisfied by"
 * column is prose, a `reg.override(code, { satisfied | evaluator, trigger?, offset?, anchorField?, why })`
 * (see src/domain/foreclosure/timers.ts applyForeclosureSatisfiedOverrides for the pattern).
 * Called from this section's timers.ts after the section-level overrides.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_18_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The other four 18.3 rows already carry backticked satisfied events (`star.metrics.computed`, `star.scorecard.ingested`,
  // `star.reconciled`, `star.config.published{year}`); only the partner-report row is prose.
  o("SM_STAR_PARTNER_REPORT_MONTHLY", {
    trigger: "`star.reconciled`",
    anchorField: "reconciled_at",
    offset: "+5 business_days_servicer",
    satisfied: "`star.partner_report.delivered`",
    why: "§18.3 timer table: `star.reconciled` (reconciled_at) → 'partner report delivered' within 5 business days, sev-3 on breach — the monthly STAR Replica & Reconciliation Report (STAR-RPT-MONTHLY-v1) sent through the partner channel; `partnerReportRelease` withholds the delivery event until `officer` sign-off when the report carries STAR data under the subservicing agreement's confidentiality clause.",
  });
}
