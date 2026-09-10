/** §13.1 120-day prohibition and §13.2 dual-tracking — gate projections, E-3.2-04 ladder, tiers, holds, certification window. */
import { type PlainDate, addDays, daysBetween, endOfMonth } from "../../kernel/calendar/date.ts";

export function regxDays(today: PlainDate, earliestUnpaidDue: PlainDate | null): number { return earliestUnpaidDue ? Math.max(0, daysBetween(earliestUnpaidDue, today)) : 0; }
export type GateState = "not_applicable" | "closed" | "open" | "exception_open";
/** §1024.41(f)(1): first notice/filing no earlier than day 121; unknown occupancy ⇒ principal residence. */
export function gate120(today: PlainDate, earliestUnpaidDue: PlainDate | null, principalResidence: boolean | null, exception?: "due_on_sale" | "join_lienholder" | null): { state: GateState; opens_on: PlainDate | null; days: number } {
  const pr = principalResidence !== false;
  const days = regxDays(today, earliestUnpaidDue);
  if (!pr) return { state: "not_applicable", opens_on: null, days };
  if (exception) return { state: "exception_open", opens_on: null, days };
  const opens = earliestUnpaidDue ? addDays(earliestUnpaidDue, 121) : null;
  return { state: days >= 121 ? "open" : "closed", opens_on: opens, days };
}
/** §1024.41(f)(2): closed while a complete application received before first notice is pending, until an exit. */
export function preFilingAppGate(f: { complete_app_before_first_notice: boolean; exit: "ineligible_no_appeal" | "all_offers_rejected" | "agreement_defaulted" | null; duplicative_41i: boolean }): "open" | "closed" { return f.complete_app_before_first_notice && !f.exit && !f.duplicative_41i ? "closed" : "open"; }
/** E-1.2-02 non-principal-residence day-120 deadline with the E-3.2-04 suspension ladder. */
export type Rung = "a_eval_30" | "b_offer_14" | "c_accepted_month_end" | "d_performing_until_breach";
export function nonPrDeadline(earliestUnpaidDue: PlainDate): PlainDate { return addDays(earliestUnpaidDue, 120); }
export function ladderSuspension(event: { kind: "complete_brp" | "retention_offer" | "accepted_with_first_payment_due" | "first_payment_received" | "inquiry" | "incomplete_brp"; on: PlainDate; first_payment_due?: PlainDate }): { rung: Rung; resume_on: PlainDate | "on_breach" } | null {
  switch (event.kind) {
    case "complete_brp": return { rung: "a_eval_30", resume_on: addDays(event.on, 30) };
    case "retention_offer": return { rung: "b_offer_14", resume_on: addDays(event.on, 14) };
    case "accepted_with_first_payment_due": return { rung: "c_accepted_month_end", resume_on: endOfMonth(event.first_payment_due!) };
    case "first_payment_received": return { rung: "d_performing_until_breach", resume_on: "on_breach" };
    default: return null;   // inquiries and incomplete BRPs never postpone
  }
}
export type Tier = "g_full_90" | "g_37_to_89" | "none";
export function tierAtReceipt(receivedOn: PlainDate, saleAtReceipt: PlainDate | null): { regx: Tier; fnma: "standard" | "fnma_15_to_37" | null; days_before_sale: number | null; acceptance_days: 14 | 7 | 0; appeal: boolean } {
  if (!saleAtReceipt) return { regx: "g_full_90", fnma: "standard", days_before_sale: null, acceptance_days: 14, appeal: true };
  const d = daysBetween(receivedOn, saleAtReceipt);
  if (d >= 90) return { regx: "g_full_90", fnma: "standard", days_before_sale: d, acceptance_days: 14, appeal: true };
  if (d > 37) return { regx: "g_37_to_89", fnma: "standard", days_before_sale: d, acceptance_days: 7, appeal: false };
  return { regx: "none", fnma: d >= 15 ? "fnma_15_to_37" : null, days_before_sale: d, acceptance_days: 0, appeal: false };
}
export type Hold = "hold_evaluation" | "hold_offer_window" | "hold_appeal" | "hold_performing" | "hold_shortsale" | "fnma_e3401_evaluation";
export const BLOCKED_BY_HOLD: Record<Hold, string[]> = { hold_evaluation: ["judgment_motion", "sale_schedule", "sale_conduct"], hold_offer_window: ["judgment_motion", "sale_schedule", "sale_conduct"], hold_appeal: ["judgment_motion", "sale_schedule", "sale_conduct"], hold_performing: ["first_notice", "judgment_motion", "sale_schedule", "sale_conduct"], hold_shortsale: ["judgment_motion", "sale_conduct"], fnma_e3401_evaluation: ["sale_conduct"] };
export function stepAllowed(step: string, holds: readonly Hold[]): boolean { return !holds.some((h) => BLOCKED_BY_HOLD[h].includes(step)); }
export function holdExit(e: "ineligible_notice_no_appeal" | "all_options_rejected" | "trial_failed" | "shortsale_window_ended" | "fnma_rejected_offer"): "clear" { void e; return "clear"; }
export function certificationWindow(saleOn: PlainDate): { opens: PlainDate; closes: PlainDate } { return { opens: addDays(saleOn, -15), closes: addDays(saleOn, -7) }; }
export function pendingMotionInstruction(): "WITHDRAW_MOTION" | "REQUEST_CONTINUANCE" { return "WITHDRAW_MOTION"; }
