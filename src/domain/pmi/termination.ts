/**
 * 10.2 Automatic termination @78% and 10.3 midpoint — applicability, the
 * month-preceding current test, cure, and the shared finalization clocks.
 */
import { type PlainDate, addDays, addMonths, endOfMonth, parts, ymd } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { AppliedInstallment } from "../boarding/delinquency.ts";
import { firstOfFollowingMonth } from "./schedule.ts";

export function rule78Applies(i: { consummation: PlainDate; units: number; occupancy_at_origination: "principal" | "second_home" | "investment" }): boolean {
  return i.consummation >= "1999-07-29" && i.units === 1 && (i.occupancy_at_origination === "principal" || i.occupancy_at_origination === "second_home");
}

/** R3 — every installment due on/before the first of the month preceding T was received by the end of that month. */
export function isCurrent(installments: readonly AppliedInstallment[], T: PlainDate): boolean {
  const { y, m } = parts(addMonths(T, -1));
  const firstPrev = ymd(y, m, 1), endPrev = endOfMonth(firstPrev);
  return installments.filter((i) => i.due_date <= firstPrev).every((i) => i.satisfied_on !== null && i.satisfied_on <= endPrev);
}

/** Installment(s) that failed the test — grounds for the not-current notice. */
export function notCurrentGrounds(installments: readonly AppliedInstallment[], T: PlainDate): PlainDate[] {
  const { y, m } = parts(addMonths(T, -1));
  const firstPrev = ymd(y, m, 1), endPrev = endOfMonth(firstPrev);
  return installments.filter((i) => i.due_date <= firstPrev && (i.satisfied_on === null || i.satisfied_on > endPrev)).map((i) => i.due_date);
}

/** First date on which no installment is past due (regx_days_delinquent = 0), or null if still delinquent. */
export function becameCurrentOn(installments: readonly AppliedInstallment[], from: PlainDate): PlainDate | null {
  let candidate = from;
  for (let guard = 0; guard < 400; guard++) {
    const due = installments.filter((i) => i.due_date <= candidate);
    if (due.some((i) => i.satisfied_on === null)) return null;
    const latest = due.reduce((a, i) => (i.satisfied_on! > a ? i.satisfied_on! : a), from);
    if (latest <= candidate) return candidate;
    candidate = latest;
  }
  return null;
}

export type Lar89Code = "51" | "52" | "53" | "54";

export interface FinalizationClocks {
  readonly effective_on: PlainDate;
  readonly notice_due: PlainDate;              // HPA_4904A_TERMINATION_NOTICE_30
  readonly premium_stop_from: PlainDate;       // HPA_4902E_STOP_PREMIUM_30 anchor (4902(e))
  readonly premium_stop_by: PlainDate;         // HPA_4902E_STOP_PREMIUM_30
  readonly refund_due: PlainDate;              // HPA_4902F1_REFUND_45
  readonly insurer_notice_due: PlainDate;      // 2 BD
  readonly escrow_interim_analysis_due: PlainDate; // 10 BD (10.5 R6)
  readonly lar89: { readonly code: Lar89Code; readonly action_date: string };
}

/**
 * R4 R-F1…R-F6 shared pipeline. `premiumStopFrom` is the HPA_4902E_STOP_PREMIUM_30 anchor: the effective date for
 * automatic terminations (4902(e)(2)/(3)); for borrower cancellations the later of receipt and the evidence-satisfied
 * date (4902(e)(1); 10.1 timer table) — which can precede the effective date when a curtailment posts after the request.
 */
export function finalizationClocks(effective: PlainDate, code: Lar89Code, cal: Calendar = servicer, premiumStopFrom: PlainDate = effective): FinalizationClocks {
  const { y, m, d } = parts(effective);
  return {
    effective_on: effective, notice_due: addDays(effective, 30), premium_stop_from: premiumStopFrom, premium_stop_by: addDays(premiumStopFrom, 30), refund_due: addDays(effective, 45),
    insurer_notice_due: addBusinessDays(effective, 2, cal), escrow_interim_analysis_due: addBusinessDays(effective, 10, cal),
    lar89: { code, action_date: `${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}${String(y % 100).padStart(2, "0")}` },
  };
}

export type AutoResult =
  | { readonly status: "terminated"; readonly clocks: FinalizationClocks }
  | { readonly status: "deferred_not_current"; readonly grounds: readonly PlainDate[]; readonly not_current_notice_due: PlainDate; readonly cure_on: PlainDate | null; readonly cure_effective: PlainDate | null; readonly clocks: FinalizationClocks | null }
  | { readonly status: "not_applicable_midpoint_only" };

/** 10.2/10.3 sweep on the scheduled trigger date T. */
export function automaticTermination(installments: readonly AppliedInstallment[], T: PlainDate, applies = true, cal: Calendar = servicer): AutoResult {
  if (!applies) return { status: "not_applicable_midpoint_only" };
  if (isCurrent(installments, T)) return { status: "terminated", clocks: finalizationClocks(T, "53", cal) };
  const cure = becameCurrentOn(installments, T);
  const eff = cure === null ? null : firstOfFollowingMonth(cure);
  return { status: "deferred_not_current", grounds: notCurrentGrounds(installments, T), not_current_notice_due: addDays(T, 30), cure_on: cure, cure_effective: eff, clocks: eff === null ? null : finalizationClocks(eff, "53", cal) };
}

/** 10.3 R4 — earlier of the 78% date and the midpoint termination date. */
export function pendingTriggerDate(scheduled78: PlainDate | null, midpointTermination: PlainDate, rule78: boolean): PlainDate {
  if (!rule78 || scheduled78 === null) return midpointTermination;
  return scheduled78 < midpointTermination ? scheduled78 : midpointTermination;
}

/** LPMI: options notice by the equivalent date + 30; no cancellation, refund or LAR 89. */
export function lpmiOptionsNoticeDue(equivTerminationDate: PlainDate): PlainDate { return addDays(equivTerminationDate, 30); }

/** 10.3 pre-1999 loans boarded past their midpoint: terminate on boarding with an officer restitution escalation. */
export function legacyBoardingTermination(midpointTermination: PlainDate, boardedOn: PlainDate, miActive: boolean, current: boolean): { terminate_on: PlainDate; escalate_officer: true; sentinel_exception: "self-identified HPA exception (prior servicer period)"; restitution_review: true } | null {
  return miActive && current && midpointTermination <= boardedOn ? { terminate_on: boardedOn, escalate_officer: true, sentinel_exception: "self-identified HPA exception (prior servicer period)", restitution_review: true } : null;
}
