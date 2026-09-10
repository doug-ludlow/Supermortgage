/** §4.4 Successor in interest — timeline, document matrix, determination. */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { federalDays } from "./clocks.ts";
export type TransferType = "death_relative" | "joint_tenancy_survivor" | "divorce" | "spouse_or_child_transfer" | "trust" | "arms_length_sale";
export function timeline(inquiryOn: PlainDate, documentsReceivedOn?: PlainDate): { documents_letter_due: PlainDate; confirmation_due: PlainDate | null } { return { documents_letter_due: federalDays(inquiryOn, 5), confirmation_due: documentsReceivedOn ? federalDays(documentsReceivedOn, 10) : null }; }
/** Comment 38(b)(1)(vi)-3 seeds: joint tenancy/entirety survivorship needs a deed + death certificate (never probate); divorce needs the decree + agreement (never a deed). */
export const DOCUMENT_MATRIX: Record<TransferType, readonly string[]> = { death_relative: ["death_certificate", "recorded_deed", "letters_testamentary", "will"], joint_tenancy_survivor: ["death_certificate", "recorded_deed"], divorce: ["divorce_decree", "separation_agreement"], spouse_or_child_transfer: ["recorded_deed"], trust: ["trust_certification"], arms_length_sale: [] };
export function requiredDocuments(t: TransferType, held: readonly string[]): string[] { return DOCUMENT_MATRIX[t].filter((d) => !held.includes(d)); }
export function determine(t: TransferType, docs: readonly string[], vestingEstablished: boolean): "confirmed" | "additional_documents_required" | "not_successor" {
  if (t === "arms_length_sale") return "not_successor";
  return requiredDocuments(t, docs).length === 0 && vestingEstablished ? "confirmed" : "additional_documents_required";
}
/**
 * Comment 38(b)(1)(vi)-4 / 4.4 rule 4: documents that do not establish vesting get the specific additional items
 * (REGX_1024_38B1VI_SII_ADDL_DOCS_5, 5 federal BD), not a denial; complete documents get the determination within
 * REGX_1024_38B1VI_SII_CONFIRM_10 (10 federal BD; 5 when loss mit is pending).
 */
export function evaluateDocuments(t: TransferType, docs: readonly string[], vestingEstablished: boolean, receivedOn: PlainDate, lossmitPending = false): { determination: ReturnType<typeof determine>; still_required: string[]; notice: "NTC_REGX_38B1VI_SII_ADDL_DOCS" | "NTC_REGX_38B1VI_SII_CONFIRMED" | "NTC_REGX_38B1VI_SII_NOT_SUCCESSOR"; notice_due: PlainDate; denial: boolean } {
  const determination = determine(t, docs, vestingEstablished);
  const missing = requiredDocuments(t, docs);
  const still = determination === "additional_documents_required" ? (missing.length ? missing : ["court_order_or_letters_establishing_vesting"]) : [];
  const notice = determination === "confirmed" ? "NTC_REGX_38B1VI_SII_CONFIRMED" : determination === "not_successor" ? "NTC_REGX_38B1VI_SII_NOT_SUCCESSOR" : "NTC_REGX_38B1VI_SII_ADDL_DOCS";
  return { determination, still_required: still, notice, notice_due: federalDays(receivedOn, determination === "additional_documents_required" ? 5 : lossmitPending ? 5 : 10), denial: determination === "not_successor" };
}
export function rightsOnConfirmation(acknowledged: boolean): { noe_rfi_payoff: true; statements_and_ei: boolean; obligor: false } { return { noe_rfi_payoff: true, statements_and_ei: acknowledged, obligor: false }; }
