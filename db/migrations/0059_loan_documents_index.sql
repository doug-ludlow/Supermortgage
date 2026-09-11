-- 0059_loan_documents_index.sql — §30.2 data model: `loan_documents_index` (new) and the addendum §10 retention classes
-- the origination artifacts re-keyed at boarding carry (rule 6). Every other 30.2 table already exists: loans /
-- loan_terms / borrowers / loan_borrowers / properties / documents (0001), boarding_staging / boarding_validations (0002,
-- generalized with source='origination' + application_id in 0057). Append-only, like the rest of the boarding tables.

-- Retention classes per spec/origination/01-architecture-baseline-addendum.md §10 (30.2 rule 6). Deliberately NOT inside
-- the transaction below: a new enum value cannot be used in the transaction that adds it (0008 pattern).
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regz_le_3y';                    -- §1026.25(c)(1)(i)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regz_cd_5y';                    -- §1026.25(c)(1)(ii)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regz_atr_3y';                   -- §1026.25(c)(3)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regb_25m';                      -- §1002.12(b)(1)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'hmda_3y';                       -- §1003.5
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'respa_afba_5y';                 -- §1024.15(d)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fdpa_life_of_loan';             -- SFHDF
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_loan_file_life_plus_4y';   -- A2-4.1-02 via A2-5-01
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ron_recording_state_ny';        -- `ron_recording_state_<n>y` (state-specific years on the RON provider)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'esign_consent_life';            -- 15 U.S.C. 7001(e)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'bsa_sar_5y';                    -- 31 CFR 1020.320(d)

BEGIN;

-- 30.2 data model: "`loan_documents_index` (new): `loan_id`, `document_id`, `kind`, `required_for_servicing_file boolean`
-- (§1024.38(c)(2)(ii) security instrument), `trailing boolean`". One row per origination artifact re-keyed to the loan at
-- boarding (and the Purchase Advice at 30.1's purchase update), with the retention class chosen by rule 6 (the longest
-- class wins where an artifact is in several) and where the object lives (`custody`).
CREATE TABLE loan_documents_index (
  id                          bigserial PRIMARY KEY,
  loan_id                     uuid NOT NULL REFERENCES loans(id),
  application_id              uuid REFERENCES applications(id),          -- the origination aggregate the artifact came from
  document_id                 uuid NOT NULL REFERENCES documents(id),
  kind                        text NOT NULL,                             -- note | security_instrument | recorded_security_instrument | closing_disclosure_final | loan_estimate | title_policy | appraisal | mi_certificate | hpa_disclosure | flood_notice | escrow_initial_statement | esign_consent | purchase_advice | ...
  retention_class             retention_class NOT NULL,                  -- addendum §10 class (rule 6)
  custody                     text NOT NULL CHECK (custody IN ('platform', 'custodian', 'evault', 'recorder')),
  required_for_servicing_file boolean NOT NULL DEFAULT false,            -- §1024.38(c)(2)(ii): the security instrument copy
  "trailing"                  boolean NOT NULL DEFAULT false,            -- recorded instrument / final title policy still outstanding at boarding (OW-008 / OW-009)
  indexed_by_event_id         uuid REFERENCES loan_events(id),           -- the `documents.indexed` event
  indexed_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, document_id)
);
COMMENT ON TABLE loan_documents_index IS '30.2 rule 6: every origination artifact re-keyed to loan_id with its retention class; the §1024.38(c)(2) servicing file reads the security-instrument row (required_for_servicing_file) and the trailing-document rows; append-only.';
COMMENT ON COLUMN loan_documents_index.retention_class IS 'addendum §10: regz_le_3y | regz_cd_5y | regz_atr_3y | regb_25m | hmda_3y | respa_afba_5y | fdpa_life_of_loan | fnma_loan_file_life_plus_4y | ron_recording_state_ny | esign_consent_life | bsa_sar_5y — the longest class wins';
CREATE INDEX loan_documents_index_loan_idx ON loan_documents_index(loan_id, kind);
CREATE INDEX loan_documents_index_servicing_file_idx ON loan_documents_index(loan_id) WHERE required_for_servicing_file;
CREATE TRIGGER loan_documents_index_immutable BEFORE UPDATE OR DELETE ON loan_documents_index FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
