/** 18.6 Reg AB / USAP — applicability and assessment clocks. */
import { type PlainDate, addDays, daysBetween } from "../../kernel/calendar/date.ts";
export function regAbApplicable(program: "fnma_mbs" | "fnma_portfolio" | "registered_abs" | "private_whole_loan"): { regab: boolean; usap_contractual: boolean } {
  return { regab: program === "registered_abs", usap_contractual: program === "private_whole_loan" };
}
export function assessmentClocks(fye: PlainDate, psaDays = 60): { attestation_due: PlainDate; warning: PlainDate; assertion_due: PlainDate } {
  const due = addDays(fye, psaDays);
  return { attestation_due: due, warning: addDays(due, -30), assertion_due: addDays(due, -15) };
}
export function reconItemException(openedOn: PlainDate, asOf: PlainDate): boolean { return daysBetween(openedOn, asOf) > 90; }
export function exceptionRemovable(officerDisposition: boolean): boolean { return officerDisposition; }
export function assertionSignedAllowed(officerSignatureId: string | null): boolean { return officerSignatureId !== null; }
