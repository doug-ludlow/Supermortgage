/** §3.8 Escrow waiver administration. */
import type { Cents } from "../../kernel/money/cents.ts";
import { type PlainDate, addDays, addYears, addMonths } from "../../kernel/calendar/date.ts";

export interface WaiverRequest {
  readonly requested_on: PlainDate; readonly upb_cents: Cents; readonly original_appraised_value_cents: Cents; readonly hpml: boolean; readonly consummation_date?: PlainDate; readonly original_property_value_cents?: Cents;
  readonly regx_days_delinquent: number; readonly late_30_in_12m: number; readonly late_60_in_24m: number; readonly prior_modification: boolean; readonly prior_waiver_missed_payments: boolean;
  readonly monthly_mi_line: boolean; readonly flood_escrow_mandatory: boolean; readonly instrument_permits: boolean; readonly state?: string; readonly state_right_met?: boolean; readonly next_due_dates: readonly PlainDate[];
  /** Amortization schedule (due date → UPB after that payment) used to date an LTV re-request; the next due date is the fallback. */
  readonly projected_upb?: readonly { on: PlainDate; upb_cents: Cents }[];
  /** Dates of the most recent 30-day / 60-day delinquencies (the re-request date is when they age out of the 12 / 24-month window). */
  readonly last_late_30_on?: PlainDate; readonly last_late_60_on?: PlainDate;
}
/** 3.8 data model `denial_reasons` codes. */
export type DenialReason = "PRIOR_MOD_OR_WAIVER_MISSED" | "DELINQ_12M" | "DELINQ_60D_24M" | "LTV_GE_80_ORIG_APPRAISED" | "HPML_LT_5Y" | "HPML_LTV_GE_80_ORIG_VALUE" | "HPML_DELINQUENT" | "FLOOD_MANDATORY" | "MI_MONTHLY" | "INSTRUMENT_PROHIBITS" | "OTHER";
export interface WaiverDecision { readonly decision: "approved" | "partial" | "denied"; readonly reasons: DenialReason[]; readonly re_request_on: PlainDate | null; readonly effective_on: PlainDate | null; readonly lines_kept: string[]; readonly kept_reasons: DenialReason[]; readonly state_right_applied: boolean; }

/** Open question 1 default: a state termination right (IL 765 ILCS 910/5, MN 47.20 subd. 9) overrides only the Fannie Mae B-1-01 denial tests — never Reg Z §1026.35(b)(3), 12 CFR 22.5, the MI rule or the instrument. */
const FNMA_TESTS: ReadonlySet<DenialReason> = new Set<DenialReason>(["PRIOR_MOD_OR_WAIVER_MISSED", "DELINQ_12M", "DELINQ_60D_24M", "LTV_GE_80_ORIG_APPRAISED"]);
const below80 = (upb: Cents, value: Cents): boolean => upb * 100n < value * 80n;
const later = (a: PlainDate | null, b: PlainDate | null): PlainDate | null => (a === null ? b : b === null ? a : a > b ? a : b);

/**
 * Rule engine. `decidedOn` is the approval/denial date (defaults to the request date for a same-day decision): 3.8 rule 2 dates
 * the effective date from *approval* ("the next payment due date ≥ 15 days after approval"), and rule 1(d) tests the HPML
 * five-year bar as of the decision (`today ≥ consummation_date + 5 years`).
 */
export function evaluateWaiver(r: WaiverRequest, decidedOn: PlainDate = r.requested_on): WaiverDecision {
  const reasons: DenialReason[] = []; const kept: string[] = []; const keptReasons: DenialReason[] = [];
  let reRequest: PlainDate | null = null; let permanent = false;
  const nextDue = r.next_due_dates.find((d) => d > r.requested_on) ?? null;
  if (!r.instrument_permits) { reasons.push("INSTRUMENT_PROHIBITS"); permanent = true; }
  if (r.flood_escrow_mandatory) { kept.push("flood"); keptReasons.push("FLOOD_MANDATORY"); }
  if (r.monthly_mi_line) { kept.push("mi"); keptReasons.push("MI_MONTHLY"); }
  if (r.hpml) {
    const five = r.consummation_date ? addYears(r.consummation_date, 5) : null;
    if (five && decidedOn < five) { reasons.push("HPML_LT_5Y"); reRequest = later(reRequest, five); }
    if (r.original_property_value_cents !== undefined && !below80(r.upb_cents, r.original_property_value_cents)) {
      reasons.push("HPML_LTV_GE_80_ORIG_VALUE");
      // Re-request once the UPB is below 80% of the original value: the first scheduled due date whose amortized UPB clears the test, else the next due date (the next principal payment).
      const on = r.projected_upb?.find((p) => below80(p.upb_cents, r.original_property_value_cents!))?.on ?? nextDue;
      reRequest = later(reRequest, on);
    }
    if (r.regx_days_delinquent > 0) { reasons.push("HPML_DELINQUENT"); reRequest = later(reRequest, nextDue); }
  }
  if (r.prior_modification || r.prior_waiver_missed_payments) { reasons.push("PRIOR_MOD_OR_WAIVER_MISSED"); permanent = true; }   // B-1-01: permanent denial reasons
  if (r.late_30_in_12m > 0) { reasons.push("DELINQ_12M"); reRequest = later(reRequest, addDays(addMonths(r.last_late_30_on ?? r.requested_on, 12), 1)); }
  if (r.late_60_in_24m > 0) { reasons.push("DELINQ_60D_24M"); reRequest = later(reRequest, addDays(addMonths(r.last_late_60_on ?? r.requested_on, 24), 1)); }
  if (!below80(r.upb_cents, r.original_appraised_value_cents)) {
    reasons.push("LTV_GE_80_ORIG_APPRAISED");
    reRequest = later(reRequest, r.projected_upb?.find((p) => below80(p.upb_cents, r.original_appraised_value_cents))?.on ?? nextDue);
  }
  const binding = reasons.filter((c) => !FNMA_TESTS.has(c));
  const stateRight = r.state_right_met === true && reasons.length > 0 && binding.length === 0;
  const denied = reasons.length > 0 && !stateRight;
  if (denied) return { decision: "denied", reasons, re_request_on: permanent ? null : reRequest, effective_on: null, lines_kept: kept, kept_reasons: keptReasons, state_right_applied: false };
  const eff = r.next_due_dates.find((d) => d >= addDays(decidedOn, 15)) ?? null;   // rule 2: ≥ 15 days after approval, not after the request
  return { decision: kept.length ? "partial" : "approved", reasons: stateRight ? reasons : [], re_request_on: null, effective_on: eff, lines_kept: kept, kept_reasons: keptReasons, state_right_applied: stateRight };
}
/** 3.8 rule 5 revocation on an advance for an unpaid item. */
export function revocation(advanceOn: PlainDate, advanceCents: Cents, penaltyCents: Cents): { revoked_on: PlainDate; opening_balance_cents: Cents; initial_statement_due_on: PlainDate; deficiency_cents: Cents } {
  const total = advanceCents + penaltyCents;
  return { revoked_on: advanceOn, opening_balance_cents: -total, initial_statement_due_on: addDays(advanceOn, 45), deficiency_cents: total };
}
export function waiverCloseoutDeadlines(effectiveOn: PlainDate): { refund_by: PlainDate; short_year_statement_by: PlainDate } { return { refund_by: addDays(effectiveOn, 30), short_year_statement_by: addDays(effectiveOn, 60) }; }
