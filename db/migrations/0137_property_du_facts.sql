-- 0137_property_du_facts.sql — 32.18 rule 7 / 23.6: the two subject-property facts only the borrower gives, asked on the home card
-- (spec/sections/32-borrower-experience/32-18-*.md rule 7: "the home card (32.3 R1), which asks both on every file").
--
-- `estate_type` answers DU's PROPERTY_DETAIL/PropertyEstateType (URLA L2.3, required — FeeSimple | Leasehold in the DU Spec 1.9.3
-- corpus); `existing_clean_energy_lien` answers PROPERTY_DETAIL/PropertyExistingCleanEnergyLienIndicator (URLA L1.10, required).
-- Stored in the card's own vocabulary (the option ids the borrower tapped); src/domain/underwriting/du/emit.ts loadGraph
-- translates to the DU enumeration at assembly, and a null stays absent from the document (rule 4: never a default).
-- application_properties is a 0057 origination table, not a du_* table, so its CHECK is outside tools/build-du.mjs's enum diff.
ALTER TABLE application_properties ADD COLUMN IF NOT EXISTS estate_type text CHECK (estate_type IN ('fee_simple', 'leasehold'));
ALTER TABLE application_properties ADD COLUMN IF NOT EXISTS existing_clean_energy_lien boolean;
COMMENT ON COLUMN application_properties.estate_type IS 'DU PropertyEstateType (URLA L2.3): fee_simple → FeeSimple, leasehold → Leasehold; the borrower''s answer on the home card (32.3 R1 / 32.18 rule 7)';
COMMENT ON COLUMN application_properties.existing_clean_energy_lien IS 'DU PropertyExistingCleanEnergyLienIndicator (URLA L1.10): a PACE or clean-energy loan on the home; the borrower''s answer on the home card (32.3 R1 / 32.18 rule 7)';
