/** §13.7 Environmental hazard / non-routine litigation. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
export type Category = 1 | 2 | 3 | null;
export function classify(f: { damages_against_fnma: boolean; attacks_validity_priority_enforceability: boolean; enumerated_risk: boolean; damages_claim: boolean; confidence: number }): { classification: "non_routine" | "routine" | "attorney_confirmation_required"; category: Category } {
  if (f.damages_against_fnma) return { classification: "non_routine", category: 1 }; if (f.attacks_validity_priority_enforceability) return { classification: "non_routine", category: 2 }; if (f.enumerated_risk) return { classification: "non_routine", category: 3 };
  if (f.confidence < 0.8 || f.damages_claim) return { classification: "attorney_confirmation_required", category: null };
  return { classification: "routine", category: null };
}
export function form20Due(noticeOn: PlainDate): PlainDate { return addBusinessDays(noticeOn, 2, servicer); }
export function litigationHold(f: { category: Category; seeks_injunction: boolean; damages_only: boolean }): boolean { return !f.damages_only && (f.category === 2 || f.seeks_injunction); }
export function exceptionTrigger(kind: "standing" | "mers" | "hamp", event: "answer" | "summary_judgment_motion" | "briefing" | "trial"): boolean { void kind; return event !== "answer"; }
export function environmental(state: "suspected" | "confirmed", on: PlainDate): { confirm_by: PlainDate | null; report_by: PlainDate | null; gate_closed: boolean } { return state === "suspected" ? { confirm_by: addDays(on, 10), report_by: null, gate_closed: false } : { confirm_by: null, report_by: addBusinessDays(on, 2, servicer), gate_closed: true }; }
export function leadPaintNoticeDue(referralOn: PlainDate): PlainDate { return addDays(referralOn, 30); }
export function motionDraftDue(filingDue: PlainDate): PlainDate { return addBusinessDays(filingDue, -5, servicer); }
