/** 18.3 STAR performance measurement — rates in bps, suppression, exclusions, reconciliation. */
import { type PlainDate, addDays, addMonths } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt } from "../../kernel/calendar/business.ts";

export type Metric = "T60" | "C60" | "RET_EFF" | "MOD6" | "PD6" | "BEYOND_TF";
export const MIN_DENOMINATOR = 30;

export function rateBps(numerator: number, denominator: number): number { return Math.floor((numerator * 10000) / denominator + 0.5); }
export interface MetricResult { readonly metric: Metric; readonly numerator: number; readonly denominator: number; readonly rate_bps: number | null; readonly suppressed: boolean; }
export function metricResult(metric: Metric, numerator: number, denominator: number): MetricResult {
  const suppressed = denominator < MIN_DENOMINATOR;
  return { metric, numerator, denominator, rate_bps: suppressed ? null : rateBps(numerator, denominator), suppressed };
}
/** Common rules — transferred-in loans excluded for two months after transfer (except MOD6/PD6); transferred-out excluded in the transfer month. */
export function includedInMetric(metric: Metric, baseMonth: PlainDate, transferredIn: PlainDate | null, transferredOut: PlainDate | null): boolean {
  if (transferredOut !== null && transferredOut.slice(0, 7) === baseMonth.slice(0, 7)) return false;
  if (transferredIn !== null && metric !== "MOD6" && metric !== "PD6" && baseMonth < addMonths(transferredIn, 2)) return false;
  return true;
}
/** BEYOND_TF — in the denominator when allowed − elapsed ≤ 180 at base; in the numerator when elapsed later exceeds allowed within six months. */
export function beyondTimeframe(allowedDays: number, elapsedAtBase: number, elapsedAtEnd: number): { in_denominator: boolean; in_numerator: boolean } {
  const inDen = allowedDays - elapsedAtBase <= 180 && allowedDays - elapsedAtBase >= 0;
  return { in_denominator: inDen, in_numerator: inDen && elapsedAtEnd > allowedDays };
}
export function composite(results: readonly { rate_bps: number | null; suppressed: boolean; weight: number; percentile: number }[]): number {
  const live = results.filter((r) => !r.suppressed);
  const w = live.reduce((s, r) => s + r.weight, 0);
  return w === 0 ? 0 : Math.round((live.reduce((s, r) => s + r.weight * r.percentile, 0) / w) * 100) / 100;
}
/** Reconciliation — tolerance ±25 bps or ±2 loans, whichever is larger. */
export function reconcile(internal: MetricResult, scorecardBps: number, scorecardNum: number, scorecardDen: number): { within_tolerance: boolean; delta_bps: number } {
  const delta = (internal.rate_bps ?? 0) - scorecardBps;
  const loanDiff = Math.max(Math.abs(internal.numerator - scorecardNum), Math.abs(internal.denominator - scorecardDen));
  return { within_tolerance: Math.abs(delta) <= 25 || loanDiff <= 2, delta_bps: delta };
}
export type VarianceClass = "reporting_timing" | "definition_mismatch" | "data_defect" | "fnma_error";
export function inquiryAllowed(cls: VarianceClass, evidenceRefs: number): boolean { return cls !== "fnma_error" || evidenceRefs >= 2; }
export function starClocks(reportAvailableOn: PlainDate, cal: Calendar = fannieEt): { ingest_by: PlainDate; reconcile_by: PlainDate } { return { ingest_by: addDays(reportAvailableOn, 7), reconcile_by: addBusinessDays(addDays(reportAvailableOn, 7), 10, cal) }; }
export function confidentialityFilter(text: string): boolean { return /\bSTAR[- ](level|performer|recognition|rating)/i.test(text); }
