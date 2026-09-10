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
export function forbearanceCarryover(cumulativeMonths: number, requested: number): { allowed_months: number; exception_required: boolean } { const room = Math.max(0, 12 - cumulativeMonths); return { allowed_months: Math.min(requested, room), exception_required: requested > room }; }
export function transferorContinuesGate(reason: string): { ok: boolean; gate: "REGX_1024_41_TRANSFEROR_CONTINUES_GATE" } { return { ok: reason !== "transfer_out", gate: "REGX_1024_41_TRANSFEROR_CONTINUES_GATE" }; }
export function postTransferForwardDue(receivedOn: PlainDate): PlainDate { return receivedOn; }
export function documentRequestOrder(transferorFailed: boolean): "ask_transferor" | "ask_borrower" { return transferorFailed ? "ask_borrower" : "ask_transferor"; }
