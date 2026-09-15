/** §4.3 Continuity of contact — assignment by day 45, release rule, CA SPOC. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
export function assignmentDue(dueDateUnpaid: PlainDate, principalResidence: boolean): PlainDate | "not_required" { return principalResidence ? addDays(dueDateUnpaid, 45) : "not_required"; }
/**
 * Who must have a contact point (4.3 edge case "Non-principal-residence loans"; 4.3-Q4): §1024.40 applies only to a
 * loan secured by the borrower's principal residence (§1024.30(c)(2)), while Fannie Mae A4-1-01 (02/12/2025) and
 * A4-2.1-01 (09/09/2020) require a continuity-of-contact approach — "one individual or a dedicated team of
 * individuals" — for every delinquent loan. The standard team is therefore assigned either way; the named human of
 * record is the Reg X design requirement only.
 */
export function contactPointRequirement(principalResidence: boolean): { regx_1024_40: "required" | "not_required"; fnma_a4_2_1_01_dmm: "required"; assign: true; named_human_required: boolean; basis: "regx_1024_40" | "fnma_a4_2_1_01_dmm" } {
  return { regx_1024_40: principalResidence ? "required" : "not_required", fnma_a4_2_1_01_dmm: "required", assign: true, named_human_required: principalResidence, basis: principalResidence ? "regx_1024_40" : "fnma_a4_2_1_01_dmm" };
}
export interface Episode { status: "assigned" | "released" | "not_required"; consecutive_on_time: number; mode: "ai_first_named_human" | "human_team" | "human_individual"; team: "default" | "bankruptcy_specialist"; }
export function onPayment(e: Episode, onTime: boolean, permanentAgreement: boolean): Episode { if (!permanentAgreement) return e; e.consecutive_on_time = onTime ? e.consecutive_on_time + 1 : 0; if (e.consecutive_on_time >= 2) e.status = "released"; return e; }
/**
 * 4.3 rule 3, dated: a payment under a *permanent* agreement counts when received within the grace period and no late
 * charge posted; a late payment (late charge assessed) resets the counter; the second on-time payment releases on its
 * receipt date. Trial-period payments never count.
 */
export function onPermanentPayment(e: Episode, f: { due_date: PlainDate; received_on: PlainDate; grace_days?: number; late_charge_posted?: boolean; permanent_agreement: boolean }): { episode: Episode; on_time: boolean; release_on: PlainDate | null } {
  const onTime = f.received_on <= addDays(f.due_date, f.grace_days ?? 15) && f.late_charge_posted !== true;
  const before = e.status;
  onPayment(e, onTime, f.permanent_agreement);
  return { episode: e, on_time: onTime, release_on: before !== "released" && e.status === "released" ? f.received_on : null };
}
export function release(e: Episode, reason: "current" | "payoff" | "refinance" | "title_transfer" | "transfer_out"): Episode { e.status = "released"; void reason; return e; }
export function caSpocDue(requestOn: PlainDate): PlainDate { return addBusinessDays(requestOn, 2, servicer); }
/** Cal. Civ. Code §2923.7(c): the SPOC stays until every option offered by or through the servicer is exhausted (the 12.x terminal determination, including any appeal) or the account is current. */
export function caSpocPersists(f: { current: boolean; determination: "pending" | "denied" | "approved" | null; appeal_pending: boolean }): boolean {
  if (f.current) return false;
  if (f.determination === "denied" && !f.appeal_pending) return false;
  return true;
}
/** Comment 40(a)-2: a bankruptcy filing reassigns the same episode to the bankruptcy-specialist team; no new episode. */
export function bankruptcyReassign(e: Episode): Episode { e.team = "bankruptcy_specialist"; return e; }
