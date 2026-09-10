/** 18.5 Mortgage fraud reporting — scoring, priority, clocks. */
import { type PlainDate, addDays, endOfMonth, addMonths } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, servicer } from "../../kernel/calendar/business.ts";

export const FLAG_SCORES: Readonly<Record<string, number>> = { PAYOFF_WIRE_CHANGE: 90, NONARMS_SHORT_SALE: 70, DOC_METADATA_ANOMALY: 60, INCOME_DOC_INCONSISTENT: 50 };
export function caseScore(flags: readonly string[]): number {
  const distinct = [...new Set(flags)];
  if (distinct.length === 0) return 0;
  return Math.min(100, Math.max(...distinct.map((f) => FLAG_SCORES[f] ?? 0)) + 10 * (distinct.length - 1));
}
export function priority(score: number): "P1" | "P2" | "P3" { return score >= 80 ? "P1" : score >= 60 ? "P2" : "P3"; }
export function protectiveActions(flags: readonly string[]): string[] {
  const out: string[] = [];
  if (flags.includes("PAYOFF_WIRE_CHANGE")) out.push("hold_payoff_disbursement", "callback_task_human");
  if (flags.includes("NONARMS_SHORT_SALE")) out.push("short_sale_human_review");
  return out;
}
export interface FraudClocks { readonly diligence_due: PlainDate; readonly partner_notice_due: PlainDate; readonly fnma_report_due: PlainDate | null; readonly internal_target: PlainDate | null; }
/** Rule 4 — diligence 15 days from the flag; report 30 days from determination, internal target day 20; partner within 1 BD. */
export function fraudClocks(flaggedOn: PlainDate, determinedOn: PlainDate | null, cal: Calendar = servicer): FraudClocks {
  return { diligence_due: addDays(flaggedOn, 15), partner_notice_due: addBusinessDays(flaggedOn, 1, cal), fnma_report_due: determinedOn === null ? null : addDays(determinedOn, 30), internal_target: determinedOn === null ? null : addDays(determinedOn, 20) };
}
export function ofacEmailDueMs(matchedMs: number): number { return matchedMs + 24 * 3600 * 1000; }
export function lawFirmFraudNoticeDue(discoveredOn: PlainDate, cal: Calendar = fannieEt): PlainDate { return addBusinessDays(discoveredOn, 2, cal); }
export function protectiveHoldExpires(placedOn: PlainDate, renewedOn: PlainDate | null): PlainDate { return addDays(renewedOn ?? placedOn, 30); }
export function determinationRequiresOfficer(agentConfidence: number): true { void agentConfidence; return true; }
export function breachSelfReportDue(discoveredOn: PlainDate): PlainDate { const qEnd = endOfMonth(addMonths(discoveredOn, (2 - ((Number(discoveredOn.slice(5, 7)) - 1) % 3)))); return addDays(qEnd > discoveredOn ? qEnd : discoveredOn, 60); }
export function assignmentAllowed(officerId: string, subjects: readonly string[]): boolean { return !subjects.includes(officerId); }
