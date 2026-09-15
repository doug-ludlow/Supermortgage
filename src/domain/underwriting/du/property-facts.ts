/**
 * 32.3 R1 / 32.18 rule 7 — the subject-property facts the home card asks on every file and the facts the platform derives
 * from what the borrower confirmed, translated for 23.6's assembly (src/domain/underwriting/du/emit.ts loadGraph):
 *
 *   estate_type                  "Do you own the land, or is it a leasehold?"        → PROPERTY_DETAIL/PropertyEstateType (URLA L2.3, required)
 *   existing_clean_energy_lien   "Is there a PACE or clean-energy loan on the home?" → PROPERTY_DETAIL/PropertyExistingCleanEnergyLienIndicator (URLA L1.10, required)
 *   property_type (confirmed)    → PROPERTY_DETAIL/AttachmentType (conditional: FinancedUnitCount < 5) — derived, never asked, never defaulted
 *
 * The card's option ids are the borrower's plain choices (stored as such on application_properties, migration 0137); the
 * DU vocabulary is a translation here, never a word on a card. The enumeration values are the DU Spec 1.9.3 corpus's
 * (src/infra/integrations/du-schema/samples: FeeSimple / Leasehold; Attached / Detached), not the generated tables —
 * neither PropertyEstateType nor AttachmentType is a Du* enumeration there.
 */
/** The option ids the home card offers for the estate, in the order the copy library lists them (`refi.home.estate`). */
export const ESTATE_OPTIONS: readonly { id: string; label: string }[] = [{ id: "fee_simple", label: "I own the land" }, { id: "leasehold", label: "It is a leasehold" }];
export const ESTATE_TYPE_OF_OPTION: Readonly<Record<string, "FeeSimple" | "Leasehold">> = { fee_simple: "FeeSimple", leasehold: "Leasehold" };
/** The option ids for the clean-energy lien question (`refi.home.clean_energy_lien`): no first — it is the common answer. */
export const CLEAN_ENERGY_LIEN_OPTIONS: readonly { id: string; label: string }[] = [{ id: "no", label: "No" }, { id: "yes", label: "Yes" }];
/** A yes/no option id as the boolean the column holds; null when the answer is neither (nothing is written). */
export const yesNoOf = (v: string | null | undefined): boolean | null => (v === "yes" ? true : v === "no" ? false : null);
/**
 * 0057's `application_properties.property_type` vocabulary (sfr | condo | pud | 2_4_unit | manufactured, plus the spellings the
 * cards and 32.18's snapshot use) → DU AttachmentType. A planned-unit-development home can be either (the corpus's one PUD,
 * DI-C07, is Detached), so `pud` derives nothing and the data point stays absent rather than guessed; likewise any type not listed.
 */
export const ATTACHMENT_OF_PROPERTY_TYPE: Readonly<Record<string, "Attached" | "Detached">> = {
  sfr: "Detached", sfr_detached: "Detached", single_family: "Detached", detached: "Detached", manufactured: "Detached", manufactured_home: "Detached", "2_4_unit": "Detached", "2-4": "Detached", "2_unit": "Detached", "3_unit": "Detached", "4_unit": "Detached", two_to_four_units: "Detached",
  sfr_attached: "Attached", attached: "Attached", condo: "Attached", condominium: "Attached", townhouse: "Attached", townhome: "Attached", coop: "Attached",
};
export const attachmentOf = (propertyType: string | null | undefined): "Attached" | "Detached" | null => (propertyType ? ATTACHMENT_OF_PROPERTY_TYPE[propertyType.trim().toLowerCase()] ?? null : null);
/** 0057's property_type vocabulary as the home card and the snapshot spell it — a confirmed type outside it is not written to the row (the intake record keeps the string). */
export const PROPERTY_TYPES: ReadonlySet<string> = new Set(Object.keys(ATTACHMENT_OF_PROPERTY_TYPE).concat(["pud"]));
