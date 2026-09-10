/** §4.3 Continuity of contact — assignment by day 45, release rule, CA SPOC. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
export function assignmentDue(dueDateUnpaid: PlainDate, principalResidence: boolean): PlainDate | "not_required" { return principalResidence ? addDays(dueDateUnpaid, 45) : "not_required"; }
export interface Episode { status: "assigned" | "released" | "not_required"; consecutive_on_time: number; mode: "ai_first_named_human" | "human_team" | "human_individual"; team: "default" | "bankruptcy_specialist"; }
export function onPayment(e: Episode, onTime: boolean, permanentAgreement: boolean): Episode { if (!permanentAgreement) return e; e.consecutive_on_time = onTime ? e.consecutive_on_time + 1 : 0; if (e.consecutive_on_time >= 2) e.status = "released"; return e; }
export function release(e: Episode, reason: "current" | "payoff" | "refinance" | "title_transfer" | "transfer_out"): Episode { e.status = "released"; void reason; return e; }
export function caSpocDue(requestOn: PlainDate): PlainDate { return addBusinessDays(requestOn, 2, servicer); }
export function bankruptcyReassign(e: Episode): Episode { e.team = "bankruptcy_specialist"; return e; }
