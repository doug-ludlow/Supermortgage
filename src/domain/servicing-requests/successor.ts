/** §4.4 Successor in interest — timeline, document matrix, determination. */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { federalDays } from "./clocks.ts";
export type TransferType = "death_relative" | "joint_tenancy_survivor" | "divorce" | "spouse_or_child_transfer" | "trust" | "arms_length_sale";
export function timeline(inquiryOn: PlainDate, documentsReceivedOn?: PlainDate): { documents_letter_due: PlainDate; confirmation_due: PlainDate | null } { return { documents_letter_due: federalDays(inquiryOn, 5), confirmation_due: documentsReceivedOn ? federalDays(documentsReceivedOn, 10) : null }; }
export function requiredDocuments(t: TransferType, held: readonly string[]): string[] {
  const m: Record<TransferType, string[]> = { death_relative: ["death_certificate", "recorded_deed", "letters_testamentary", "will"], joint_tenancy_survivor: ["death_certificate", "recorded_deed"], divorce: ["divorce_decree", "separation_agreement"], spouse_or_child_transfer: ["recorded_deed"], trust: ["trust_certification"], arms_length_sale: [] };
  return m[t].filter((d) => !held.includes(d));
}
export function determine(t: TransferType, docs: readonly string[], vestingEstablished: boolean): "confirmed" | "additional_documents_required" | "not_successor" {
  if (t === "arms_length_sale") return "not_successor";
  return requiredDocuments(t, docs).length === 0 && vestingEstablished ? "confirmed" : "additional_documents_required";
}
export function rightsOnConfirmation(acknowledged: boolean): { noe_rfi_payoff: true; statements_and_ei: boolean; obligor: false } { return { noe_rfi_payoff: true, statements_and_ei: acknowledged, obligor: false }; }
