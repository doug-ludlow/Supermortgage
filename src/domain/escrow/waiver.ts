/** §3.8 Escrow waiver administration. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addYears, addMonths } from "../../kernel/calendar/date.ts";

export interface WaiverRequest { readonly requested_on: PlainDate; readonly upb_cents: Cents; readonly original_appraised_value_cents: Cents; readonly hpml: boolean; readonly consummation_date?: PlainDate; readonly original_property_value_cents?: Cents; readonly regx_days_delinquent: number; readonly late_30_in_12m: number; readonly late_60_in_24m: number; readonly prior_modification: boolean; readonly prior_waiver_missed_payments: boolean; readonly monthly_mi_line: boolean; readonly flood_escrow_mandatory: boolean; readonly instrument_permits: boolean; readonly state?: string; readonly state_right_met?: boolean; readonly next_due_dates: readonly PlainDate[]; }
export interface WaiverDecision { readonly decision: "approved" | "partial" | "denied"; readonly reasons: string[]; readonly re_request_on: PlainDate | null; readonly effective_on: PlainDate | null; readonly lines_kept: string[]; }

export function evaluateWaiver(r: WaiverRequest): WaiverDecision {
  const reasons: string[] = []; const kept: string[] = []; let reRequest: PlainDate | null = null;
  if (!r.instrument_permits) reasons.push("INSTRUMENT_NO_WAIVER");
  if (r.flood_escrow_mandatory) kept.push("flood"); if (r.monthly_mi_line) kept.push("mi");
  if (r.hpml) {
    const five = r.consummation_date ? addYears(r.consummation_date, 5) : null;
    if (five && r.requested_on < five) { reasons.push("HPML_5_YEARS"); reRequest = five; }
    if (r.original_property_value_cents !== undefined && !(r.upb_cents * 100n < r.original_property_value_cents * 80n)) reasons.push("HPML_LTV_GE_80_ORIG_VALUE");
    if (r.regx_days_delinquent > 0) reasons.push("HPML_DELINQUENT");
  }
  if (r.prior_modification) reasons.push("PRIOR_MODIFICATION"); if (r.prior_waiver_missed_payments) reasons.push("PRIOR_WAIVER_MISSED");
  if (r.late_30_in_12m > 0) { reasons.push("DELINQ_12M"); reRequest = reRequest ?? addMonths(r.requested_on, 12); }
  if (r.late_60_in_24m > 0) { reasons.push("DELINQ_60D_24M"); reRequest = reRequest ?? addMonths(r.requested_on, 24); }
  if (!(r.upb_cents * 100n < r.original_appraised_value_cents * 80n)) reasons.push("FNMA_LTV_GE_80");
  const denied = reasons.length > 0 && !r.state_right_met;
  if (denied) return { decision: "denied", reasons, re_request_on: reRequest, effective_on: null, lines_kept: kept };
  const eff = r.next_due_dates.find((d) => d >= addDays(r.requested_on, 15)) ?? null;
  return { decision: kept.length ? "partial" : "approved", reasons: [], re_request_on: null, effective_on: eff, lines_kept: kept };
}
/** 3.8 rule 5 revocation on an advance for an unpaid item. */
export function revocation(advanceOn: PlainDate, advanceCents: Cents, penaltyCents: Cents): { revoked_on: PlainDate; opening_balance_cents: Cents; initial_statement_due_on: PlainDate; deficiency_cents: Cents } {
  const total = advanceCents + penaltyCents;
  return { revoked_on: advanceOn, opening_balance_cents: -total, initial_statement_due_on: addDays(advanceOn, 45), deficiency_cents: total };
}
export function waiverCloseoutDeadlines(effectiveOn: PlainDate): { refund_by: PlainDate; short_year_statement_by: PlainDate } { return { refund_by: addDays(effectiveOn, 30), short_year_statement_by: addDays(effectiveOn, 60) }; }
