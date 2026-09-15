/** §1.7 / §17.4 Loss-mit in flight — §1024.41(k) transferee clocks, deemed dates, work-down rules, forbearance carry-over. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";

export function deemedReceived(transferorReceivedOn: PlainDate, subjectAtTransferor: boolean, transferDate: PlainDate): PlainDate { return subjectAtTransferor ? transferorReceivedOn : transferDate; }
/** (k)(2)(i): 10 federal BD from transfer when the transferor's 5-day ack period was unexpired; (b)(2) 5 BD when newly subject. */
export function transfereeAckDue(transferDate: PlainDate, subjectAtTransferor: boolean): PlainDate { return subjectAtTransferor ? addBusinessDays(transferDate, 10, federal) : addBusinessDays(transferDate, 5, federal); }
/** (k)(3): complete application pending at transfer → 30 calendar days from the transfer date. */
export function transfereeEvaluationDue(transferDate: PlainDate): PlainDate { return addDays(transferDate, 30); }
/** (k)(4): appeal → later of 30 days from transfer and 30 days from the appeal. */
export function transfereeAppealDue(transferDate: PlainDate, appealReceivedOn: PlainDate): PlainDate { const a = addDays(transferDate, 30), b = addDays(appealReceivedOn, 30); return a > b ? a : b; }
export function transferorClocks(receivedOn: PlainDate, T: PlainDate): { ack_due: PlainDate; ack_target: PlainDate; handoff_if_unsent: boolean } { const due = addBusinessDays(receivedOn, 5, federal); return { ack_due: due, ack_target: addBusinessDays(T, -1, federal) < due ? addBusinessDays(T, -1, federal) : due, handoff_if_unsent: due >= T }; }
export function firstFilingGate(reasonableDate: PlainDate | null, today: PlainDate): { ok: boolean; gate: "REGX_1024_41K2_NO_FIRST_FILING_GATE"; allowed_from: PlainDate | null } { const from = reasonableDate ? addDays(reasonableDate, 1) : null; return { ok: !from || today >= from, gate: "REGX_1024_41K2_NO_FIRST_FILING_GATE", allowed_from: from }; }
export function honorTransferorOffer(acceptedOn: PlainDate, acceptBy: PlainDate): "honor_no_reunderwrite" | "expired" { return acceptedOn <= acceptBy ? "honor_no_reunderwrite" : "expired"; }
/**
 * Forbearance extension room — Servicing Guide D2-3.2-01 (04/08/2026), which carries the LL-2026-01 rule: a plan "must not be
 * extended beyond a date that would exceed a cumulative term of 12 months as measured from the start date of the initial
 * forbearance plan, or result in the mortgage loan becoming greater than 12 months delinquent" — two independent limbs.
 * `monthsDelinquentAtStart` (the loan's `fnma_delinquency_status` in months at the increment's start) measures limb 2; without
 * it only the cumulative limb is measured (17.4's TO-08 export of the transferor's history — the transferee applies limb 2 at
 * extension time, where 1.7's gate evaluator requires it).
 */
export function forbearanceCarryover(cumulativeMonths: number, requested: number, monthsDelinquentAtStart?: number | null): { allowed_months: number; exception_required: boolean } {
  const room = forbearanceLimbs(cumulativeMonths, requested, monthsDelinquentAtStart).room;
  return { allowed_months: Math.min(requested, room), exception_required: requested > room };
}
export type ForbearanceLimb = "cumulative_12m" | "delinquency_12m";
/** The two D2-3.2-01 limbs of a requested increment: months of room under each, the projected delinquency at term end, and which limbs the request breaches. */
export function forbearanceLimbs(cumulativeMonths: number, requested: number, monthsDelinquentAtStart?: number | null): { cumulative_room: number; delinquency_room: number | null; room: number; projected_months_delinquent_at_term_end: number | null; breached: ForbearanceLimb[] } {
  const cumulativeRoom = Math.max(0, 12 - cumulativeMonths);
  const delq = typeof monthsDelinquentAtStart === "number" && Number.isFinite(monthsDelinquentAtStart) ? monthsDelinquentAtStart : null;
  const delinquencyRoom = delq === null ? null : Math.max(0, 12 - delq);
  const projected = delq === null ? null : delq + requested;
  const breached: ForbearanceLimb[] = [];
  if (cumulativeMonths + requested > 12) breached.push("cumulative_12m");
  if (projected !== null && projected > 12) breached.push("delinquency_12m");
  return { cumulative_room: cumulativeRoom, delinquency_room: delinquencyRoom, room: delinquencyRoom === null ? cumulativeRoom : Math.min(cumulativeRoom, delinquencyRoom), projected_months_delinquent_at_term_end: projected, breached };
}
export function transferorContinuesGate(reason: string): { ok: boolean; gate: "REGX_1024_41_TRANSFEROR_CONTINUES_GATE" } { return { ok: reason !== "transfer_out", gate: "REGX_1024_41_TRANSFEROR_CONTINUES_GATE" }; }
export function postTransferForwardDue(receivedOn: PlainDate): PlainDate { return receivedOn; }
export function documentRequestOrder(transferorFailed: boolean): "ask_transferor" | "ask_borrower" { return transferorFailed ? "ask_borrower" : "ask_transferor"; }
