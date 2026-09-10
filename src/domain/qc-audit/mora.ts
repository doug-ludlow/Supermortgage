/** 18.2 Fannie Mae MORA / examiner reviews — deadline arithmetic and warnings. */
import { type PlainDate, addDays } from "../../kernel/calendar/date.ts";
import { type Calendar, addBusinessDays, fannieEt, rollBack, servicer } from "../../kernel/calendar/business.ts";

export interface ExamClocks { readonly due: PlainDate; readonly internal_target: PlainDate; readonly officer_gate: PlainDate; readonly warn_50: PlainDate; readonly warn_80: PlainDate; }

/** Rule 4 — due = notification + 30 CD (or as stated); target = prior business day when the due date is a weekend/holiday; officer gate 3 days before target. */
export function examClocks(notifiedOn: PlainDate, statedDue: PlainDate | null = null, cal: Calendar = fannieEt): ExamClocks {
  const due = statedDue ?? addDays(notifiedOn, 30);
  const target = rollBack(due, cal);
  const span = Math.max(1, Math.round((Date.parse(due) - Date.parse(notifiedOn)) / 86_400_000));
  return { due, internal_target: target, officer_gate: addBusinessDays(target, -1, cal) < addDays(target, -3) ? addBusinessDays(target, -1, cal) : addDays(target, -3), warn_50: addDays(notifiedOn, Math.floor(span * 0.5)), warn_80: addDays(notifiedOn, Math.floor(span * 0.8)) };
}
export function extensionRequestNeeded(assembledOn: PlainDate | null, warn80: PlainDate, today: PlainDate): boolean { return today >= warn80 && (assembledOn === null || assembledOn > today); }
export function findingCapaDue(receivedOn: PlainDate, cal: Calendar = servicer): PlainDate { return addBusinessDays(receivedOn, 15, cal); }
export function privilegeExcluded(documentClass: string): boolean { return ["attorney_client", "work_product", "attorney_communication"].includes(documentClass); }
export function legalConclusionGuardrail(text: string): "attorney" | null { return /\b(we complied with|in compliance with|no violation of)\s+§?\s*\d/i.test(text) ? "attorney" : null; }
