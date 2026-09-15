/** §4.4 Successor in interest — timeline, document matrix, determination. */
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { federalDays } from "./clocks.ts";
export type TransferType = "death_relative" | "joint_tenancy_survivor" | "divorce" | "spouse_or_child_transfer" | "trust" | "arms_length_sale";
/** 4.4 rule 1 worked timeline: the document-description letter 5 federal BD from the inquiry; the determination 10 federal BD from the documents; a written request from the potential successor is an RFI answered within 30 federal BD (2026-10-02 → 2026-11-17: Columbus Day and Veterans Day excluded). */
export function timeline(inquiryOn: PlainDate, documentsReceivedOn?: PlainDate, writtenRequestOn?: PlainDate): { documents_letter_due: PlainDate; confirmation_due: PlainDate | null; rfi_response_due: PlainDate | null } { return { documents_letter_due: federalDays(inquiryOn, 5), confirmation_due: documentsReceivedOn ? federalDays(documentsReceivedOn, 10) : null, rfi_response_due: writtenRequestOn ? federalDays(writtenRequestOn, 30) : null }; }
/** The D1-4.1-02 (08/13/2025) exempt transactions and transferees — a broader list than the five Reg X §1024.31 transfer types. */
export type FnmaExemptItem = "joint_tenant_death" | "junior_lienholder_foreclosure_or_dil" | "unrelated_coborrower_occupying_12m" | "natural_person_assumes_and_co_occupies" | "leasehold_le_3y_no_option" | "subordinate_lien" | "pmsi_household_appliances" | "relative_of_deceased_occupying" | "family_member_occupying" | "divorce_spouse_occupying" | "inter_vivos_trust_borrower_beneficiary" | "borrower_controlled_llc";
export const FNMA_EXEMPT_ITEMS: readonly FnmaExemptItem[] = ["joint_tenant_death", "junior_lienholder_foreclosure_or_dil", "unrelated_coborrower_occupying_12m", "natural_person_assumes_and_co_occupies", "leasehold_le_3y_no_option", "subordinate_lien", "pmsi_household_appliances", "relative_of_deceased_occupying", "family_member_occupying", "divorce_spouse_occupying", "inter_vivos_trust_borrower_beneficiary", "borrower_controlled_llc"];
/** The exempt-transferee items the Guide conditions on occupancy; the condition is waived for loans purchased/securitized by Fannie Mae on/after June 1, 2016 (D1-4.1-02 note). */
const OCCUPANCY_ITEMS: ReadonlySet<FnmaExemptItem> = new Set<FnmaExemptItem>(["relative_of_deceased_occupying", "family_member_occupying", "divorce_spouse_occupying"]);
export const FNMA_OCCUPANCY_WAIVER_FROM: PlainDate = "2016-06-01" as PlainDate;
/** The LLC exemption exists only for loans purchased/securitized on/after June 1, 2016. */
export const FNMA_LLC_EXEMPTION_FROM: PlainDate = "2016-06-01" as PlainDate;
/** The five §1024.31 transfer types as `TransferType` codes (Reg X successor-in-interest status). */
export const REGX_SII_TYPES: ReadonlySet<string> = new Set(["death_relative", "joint_tenancy_survivor", "divorce", "spouse_or_child_transfer", "trust"]);
export interface FnmaExemptFacts {
  readonly transfer_type: TransferType | "junior_lienholder" | "unrelated_coborrower" | "leasehold" | "subordinate_lien" | "pmsi_appliances" | "borrower_llc" | string;
  /** A related or unrelated natural person acknowledges in writing that they assume the note and security instrument … */
  readonly assumes_in_writing?: boolean;
  /** … and will occupy the property with the transferor as a principal residence. */
  readonly co_occupies_with_transferor?: boolean;
  /** The transferee occupies (the exempt-transferee items); `false` fails an occupancy-conditioned item on a pre-2016-06-01 loan. */
  readonly occupies?: boolean;
  readonly months_since_closing?: number;
  readonly lease_years?: number; readonly purchase_option?: boolean;
  readonly purchased_by_fnma_on?: PlainDate | null;
  readonly release_of_liability_requested?: boolean; readonly modification?: boolean;
}
/**
 * D1-4.1-02 exempt-transaction evaluation (4.4 rule 4 / rule 6; 4.4-T5): processed "without reviewing or approving the
 * terms of the transfer" and without enforcing due-on-sale; creditworthiness review only when the prior borrower asks
 * for a release of liability; an assumption only with a release of liability or a modification (F-1-17 note). Evaluated
 * separately from the Reg X determination — an arm's-length buyer who assumes in writing and occupies with the
 * transferor is an exempt transferee yet `not_successor` under §1024.31.
 */
export function fnmaExemptTransaction(f: FnmaExemptFacts): { exempt: boolean; item: FnmaExemptItem | null; regx_sii: boolean; occupancy_required: boolean; review_terms: false; creditworthiness_review: boolean; assumption_required: boolean; due_on_sale_enforced: boolean; basis: string } {
  const bought = f.purchased_by_fnma_on ?? null;
  let item: FnmaExemptItem | null = null;
  switch (f.transfer_type) {
    case "joint_tenancy_survivor": item = "joint_tenant_death"; break;
    case "death_relative": item = "relative_of_deceased_occupying"; break;
    case "spouse_or_child_transfer": item = "family_member_occupying"; break;
    case "divorce": item = "divorce_spouse_occupying"; break;
    case "trust": item = "inter_vivos_trust_borrower_beneficiary"; break;
    case "junior_lienholder": item = "junior_lienholder_foreclosure_or_dil"; break;
    case "unrelated_coborrower": item = (f.months_since_closing ?? 0) >= 12 && f.occupies !== false ? "unrelated_coborrower_occupying_12m" : null; break;
    case "leasehold": item = (f.lease_years ?? 99) <= 3 && !f.purchase_option ? "leasehold_le_3y_no_option" : null; break;
    case "subordinate_lien": item = "subordinate_lien"; break;
    case "pmsi_appliances": item = "pmsi_household_appliances"; break;
    case "borrower_llc": item = bought && bought >= FNMA_LLC_EXEMPTION_FROM ? "borrower_controlled_llc" : null; break;
    default: item = f.assumes_in_writing && f.co_occupies_with_transferor ? "natural_person_assumes_and_co_occupies" : null;
  }
  const occupancyRequired = item !== null && OCCUPANCY_ITEMS.has(item) && !(bought && bought >= FNMA_OCCUPANCY_WAIVER_FROM);
  const exempt = item !== null && !(occupancyRequired && f.occupies === false);
  const assumption = assumptionRequirement({ release_of_liability: f.release_of_liability_requested === true, modification: f.modification === true });
  return { exempt, item: exempt ? item : null, regx_sii: REGX_SII_TYPES.has(f.transfer_type), occupancy_required: occupancyRequired, review_terms: false, creditworthiness_review: f.release_of_liability_requested === true, assumption_required: assumption.required, due_on_sale_enforced: !exempt,
    basis: exempt ? `D1-4.1-02 exempt ${item}: processed without reviewing or approving the terms of the transfer; no due-on-sale enforcement` : "not an exempt transaction under D1-4.1-02 — a Garn-St Germain / due-on-sale question" };
}
/** F-1-17 note (4.4 rule 6): "Fannie Mae does not require an exempt transferee to assume the mortgage loan except in connection with a release of liability or in conjunction with a mortgage loan modification." */
export function assumptionRequirement(f: { release_of_liability: boolean; modification: boolean }): { required: boolean; basis: "release_of_liability" | "modification" | "optional_exempt_transferee"; citation: string } {
  if (f.release_of_liability) return { required: true, basis: "release_of_liability", citation: "F-1-17 note; F-1-28 release-of-liability review" };
  if (f.modification) return { required: true, basis: "modification", citation: "D1-4.1-02: the assumption agreement is signed in conjunction with the modification agreement" };
  return { required: false, basis: "optional_exempt_transferee", citation: "F-1-17 note: Fannie Mae does not require an exempt transferee to assume the mortgage loan except in connection with a release of liability or in conjunction with a mortgage loan modification" };
}
/** Comment 30(d)-3 (4.4 rule 5): after confirmation the servicer still complies with every applicable subpart C requirement with respect to the transferor borrower. */
export function transferorBorrowerRights(): { subpart_c: "all_applicable_requirements_continue"; citation: "comment 30(d)-3" } { return { subpart_c: "all_applicable_requirements_continue", citation: "comment 30(d)-3" }; }
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
