-- 0101_hmda_capture_lar.sql — §28.3 HMDA data capture, ULI generation, rate-spread and other derived fields, LAR editing,
-- annual/quarterly submission and public disclosure obligations
-- (spec/sections/28-quality-control-hmda-and-fraud-aml-reporting/28-3-hmda-data-capture-uli-generation-rate-spread-and-other-deriv.md "Data model").
-- Owned here: the five 28.3 tables `hmda_ulis`, `hmda_lar_files`, `hmda_edit_verifications`, `hmda_coverage_tests`,
-- `hmda_public_notices`, plus the columns 28.3 adds to shared tables: `hmda_records` (created by 0068 for 21.6's
-- action-taken write — ALTERed here with every remaining §1003.4(a) data point, never a second CREATE), the `uli` column on
-- `applications` and `loans` (assigned at `application.received`; 29.3's ULDD reads it as UniversalLoanIdentifier), and the
-- `hmda_correction_log`. Not here (other owners, never duplicated): `applications` and `restricted_fl.applicant_demographics`
-- (0057), `decisions` / `adverse_actions` (0068), `apor_tables` (23.4), `credit_reports` (0079), `locks` (0066), `documents`
-- and `loans` (0001). Money is bigint cents; rates and the rate spread numeric to 3 dp (FIG: "to at least three (3) decimal
-- places"); dates are the creditor's civil dates. `hmda_ulis`, `hmda_edit_verifications`, `hmda_coverage_tests`,
-- `hmda_public_notices` and `hmda_correction_log` are append-only (0001's forbid_mutation trigger); `hmda_records` and
-- `hmda_lar_files` carry a status and are never deleted (a `hmda_records` row is never deleted — an excluded transaction is
-- marked `excluded_reason` and omitted from the LAR). Retention: `hmda_3y` on the LAR copy (§1003.5(a)(1)(i)); the
-- application-level data also sit under `regb_25m` / `fnma_loan_file_life_plus_4y` in the file (31.3 owns the gate).
BEGIN;

-- ---------------------------------------------------------------- the ULI on the aggregate (28.3 rule 2; 29.3 ULDD UniversalLoanIdentifier)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS uli text;                          -- LEI (20) + loan identifier (≤ 23) + check digit (2) ≤ 45 characters
COMMENT ON COLUMN applications.uli IS '28.3 rule 2: assigned at application.received — lei || loan_identifier || MOD 97-10 check digit (Appendix C to Part 1003); never derived from PII; 29.3 deliveryData reads it.';
ALTER TABLE loans ADD COLUMN IF NOT EXISTS uli text;
COMMENT ON COLUMN loans.uli IS '28.3: the ULI carried from applications.uli when 30.2 creates the servicing row (one identifier for life; 29.3 ULDD UniversalLoanIdentifier).';
CREATE INDEX IF NOT EXISTS applications_uli_idx ON applications(uli) WHERE uli IS NOT NULL;

-- ---------------------------------------------------------------- hmda_records: every remaining §1003.4(a) data point (0068 created the row for 21.6's write)
ALTER TABLE hmda_records
  ADD COLUMN IF NOT EXISTS hmda_record_id              uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS partner_id                  uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS lei                         char(20),                            -- the partner's LEI (§1003.4(a)(1)(i)(A))
  ADD COLUMN IF NOT EXISTS reporting_year              int,                                 -- year of action_taken_date
  ADD COLUMN IF NOT EXISTS loan_identifier             text CHECK (loan_identifier IS NULL OR (char_length(loan_identifier) <= 23 AND loan_identifier ~ '^[A-Za-z0-9]+$')),  -- 'A' || yy || class || 6-digit sequence (opaque)
  ADD COLUMN IF NOT EXISTS check_digit                 char(2),
  ADD COLUMN IF NOT EXISTS application_date            date,                                -- policy: Reg B application_date (21.1-Q6)
  ADD COLUMN IF NOT EXISTS loan_type                   int NOT NULL DEFAULT 1 CHECK (loan_type BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS loan_purpose                int CHECK (loan_purpose IN (1, 2, 31, 32, 4, 5)),
  ADD COLUMN IF NOT EXISTS preapproval                 int NOT NULL DEFAULT 2 CHECK (preapproval IN (1, 2)),
  ADD COLUMN IF NOT EXISTS construction_method         int CHECK (construction_method IN (1, 2)),
  ADD COLUMN IF NOT EXISTS occupancy_type              int CHECK (occupancy_type IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS loan_amount_cents           bigint,                              -- amount applied for until origination, then the note amount
  ADD COLUMN IF NOT EXISTS street_address              text,
  ADD COLUMN IF NOT EXISTS city                        text,
  ADD COLUMN IF NOT EXISTS state                       char(2),
  ADD COLUMN IF NOT EXISTS zip                         text,
  ADD COLUMN IF NOT EXISTS county_fips                 char(5),
  ADD COLUMN IF NOT EXISTS census_tract                text CHECK (census_tract IS NULL OR census_tract = 'NA' OR census_tract ~ '^[0-9]{11}$'),
  ADD COLUMN IF NOT EXISTS geocode_source              text,
  ADD COLUMN IF NOT EXISTS geocoded_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS applicant_ethnicity         int[] CHECK (applicant_ethnicity IS NULL OR cardinality(applicant_ethnicity) <= 5),
  ADD COLUMN IF NOT EXISTS applicant_ethnicity_free_text text,
  ADD COLUMN IF NOT EXISTS applicant_race              int[] CHECK (applicant_race IS NULL OR cardinality(applicant_race) <= 5),
  ADD COLUMN IF NOT EXISTS applicant_race_free_text_fields jsonb,
  ADD COLUMN IF NOT EXISTS applicant_sex               int CHECK (applicant_sex IN (1, 2, 3, 4, 5, 6)),
  ADD COLUMN IF NOT EXISTS applicant_ethnicity_observed int CHECK (applicant_ethnicity_observed IN (1, 2, 3, 4)),
  ADD COLUMN IF NOT EXISTS applicant_race_observed     int CHECK (applicant_race_observed IN (1, 2, 3, 4)),
  ADD COLUMN IF NOT EXISTS applicant_sex_observed      int CHECK (applicant_sex_observed IN (1, 2, 3, 4)),
  ADD COLUMN IF NOT EXISTS applicant_age               int,                                 -- numeric, 8888 NA, 9999 no co-applicant
  ADD COLUMN IF NOT EXISTS co_applicant_ethnicity      int[] CHECK (co_applicant_ethnicity IS NULL OR cardinality(co_applicant_ethnicity) <= 5),
  ADD COLUMN IF NOT EXISTS co_applicant_ethnicity_free_text text,
  ADD COLUMN IF NOT EXISTS co_applicant_race           int[] CHECK (co_applicant_race IS NULL OR cardinality(co_applicant_race) <= 5),
  ADD COLUMN IF NOT EXISTS co_applicant_race_free_text_fields jsonb,
  ADD COLUMN IF NOT EXISTS co_applicant_sex            int CHECK (co_applicant_sex IN (1, 2, 3, 4, 5, 6)),
  ADD COLUMN IF NOT EXISTS co_applicant_ethnicity_observed int CHECK (co_applicant_ethnicity_observed IN (1, 2, 3, 4)),
  ADD COLUMN IF NOT EXISTS co_applicant_race_observed  int CHECK (co_applicant_race_observed IN (1, 2, 3, 4)),
  ADD COLUMN IF NOT EXISTS co_applicant_sex_observed   int CHECK (co_applicant_sex_observed IN (1, 2, 3, 4)),
  ADD COLUMN IF NOT EXISTS co_applicant_age            int,
  ADD COLUMN IF NOT EXISTS income_thousands            int,                                 -- round_half_up(relied-on annual income / 1000); NA null
  ADD COLUMN IF NOT EXISTS purchaser_type              int CHECK (purchaser_type BETWEEN 0 AND 9 OR purchaser_type IN (71, 72)),
  ADD COLUMN IF NOT EXISTS rate_spread                 numeric(8,3),                        -- null = NA (actions 3–7; comment 4(a)(12)-6)
  ADD COLUMN IF NOT EXISTS rate_set_date               date,                                -- the final rate-set before final action (comment 4(a)(12)-3)
  ADD COLUMN IF NOT EXISTS apr                         numeric(7,3),
  ADD COLUMN IF NOT EXISTS apor                        numeric(7,3),
  ADD COLUMN IF NOT EXISTS apor_table_id               text,
  ADD COLUMN IF NOT EXISTS rate_spread_ffiec_response  text,                                -- the FFIEC Rate Spread API cross-check ("0.139" / "NA")
  ADD COLUMN IF NOT EXISTS hoepa_status                int CHECK (hoepa_status IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS lien_status                 int NOT NULL DEFAULT 1 CHECK (lien_status IN (1, 2)),
  ADD COLUMN IF NOT EXISTS applicant_credit_score      int,                                 -- 8888 NA
  ADD COLUMN IF NOT EXISTS applicant_score_model       int CHECK (applicant_score_model IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 1111)),
  ADD COLUMN IF NOT EXISTS applicant_score_model_text  text,
  ADD COLUMN IF NOT EXISTS co_applicant_credit_score   int,
  ADD COLUMN IF NOT EXISTS co_applicant_score_model    int CHECK (co_applicant_score_model IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1111)),
  ADD COLUMN IF NOT EXISTS co_applicant_score_model_text text,
  ADD COLUMN IF NOT EXISTS denial_reasons              int[] CHECK (denial_reasons IS NULL OR cardinality(denial_reasons) <= 4),   -- 10 when NA (0068 keeps denial_reason_1..4 for 21.6's write)
  ADD COLUMN IF NOT EXISTS total_loan_costs_cents      bigint,                              -- §1026.38(f)(4); null = NA
  ADD COLUMN IF NOT EXISTS total_points_and_fees_cents bigint,                              -- NA for TRID loans
  ADD COLUMN IF NOT EXISTS origination_charges_cents   bigint,                              -- §1026.38(f)(1) borrower-paid at or before closing
  ADD COLUMN IF NOT EXISTS discount_points_cents       bigint,                              -- §1026.37(f)(1)(i); blank (null) when none
  ADD COLUMN IF NOT EXISTS lender_credits_cents        bigint,                              -- §1026.38(h)(3); blank (null) when none
  ADD COLUMN IF NOT EXISTS interest_rate               numeric(7,3),
  ADD COLUMN IF NOT EXISTS prepayment_penalty_term     int,                                 -- months; null = NA
  ADD COLUMN IF NOT EXISTS dti                         numeric(6,3),
  ADD COLUMN IF NOT EXISTS cltv                        numeric(7,3),
  ADD COLUMN IF NOT EXISTS loan_term_months            int,
  ADD COLUMN IF NOT EXISTS intro_rate_period_months    int,                                 -- null = NA (fixed); 60/84/120 for the SOFR ARMs
  ADD COLUMN IF NOT EXISTS balloon                     int NOT NULL DEFAULT 2 CHECK (balloon IN (1, 2)),
  ADD COLUMN IF NOT EXISTS interest_only               int NOT NULL DEFAULT 2 CHECK (interest_only IN (1, 2)),
  ADD COLUMN IF NOT EXISTS negative_amortization       int NOT NULL DEFAULT 2 CHECK (negative_amortization IN (1, 2)),
  ADD COLUMN IF NOT EXISTS other_non_amortizing        int NOT NULL DEFAULT 2 CHECK (other_non_amortizing IN (1, 2)),
  ADD COLUMN IF NOT EXISTS property_value_cents        bigint,                              -- the value relied on (24.x); null = NA
  ADD COLUMN IF NOT EXISTS mh_secured_property_type    int CHECK (mh_secured_property_type IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS mh_land_property_interest   int CHECK (mh_land_property_interest IN (1, 2, 3, 4, 5)),
  ADD COLUMN IF NOT EXISTS total_units                 int,
  ADD COLUMN IF NOT EXISTS multifamily_affordable_units int,                                -- null = NA
  ADD COLUMN IF NOT EXISTS submission_of_application   int NOT NULL DEFAULT 1 CHECK (submission_of_application IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS initially_payable           int NOT NULL DEFAULT 1 CHECK (initially_payable IN (1, 2, 3)),
  ADD COLUMN IF NOT EXISTS nmlsr_id                    text,
  ADD COLUMN IF NOT EXISTS aus_1                       int CHECK (aus_1 BETWEEN 1 AND 7),
  ADD COLUMN IF NOT EXISTS aus_result_1                int CHECK (aus_result_1 BETWEEN 1 AND 24),
  ADD COLUMN IF NOT EXISTS aus_2                       int, ADD COLUMN IF NOT EXISTS aus_result_2 int,
  ADD COLUMN IF NOT EXISTS aus_3                       int, ADD COLUMN IF NOT EXISTS aus_result_3 int,
  ADD COLUMN IF NOT EXISTS aus_4                       int, ADD COLUMN IF NOT EXISTS aus_result_4 int,
  ADD COLUMN IF NOT EXISTS aus_5                       int, ADD COLUMN IF NOT EXISTS aus_result_5 int,
  ADD COLUMN IF NOT EXISTS reverse_mortgage            int NOT NULL DEFAULT 2 CHECK (reverse_mortgage IN (1, 2)),
  ADD COLUMN IF NOT EXISTS open_end                    int NOT NULL DEFAULT 2 CHECK (open_end IN (1, 2)),
  ADD COLUMN IF NOT EXISTS business_purpose            int NOT NULL DEFAULT 2 CHECK (business_purpose IN (1, 2)),
  ADD COLUMN IF NOT EXISTS completeness_status         text NOT NULL DEFAULT 'open' CHECK (completeness_status IN ('open', 'final_action_pending_fields', 'complete', 'edits_failed', 'filed')),
  ADD COLUMN IF NOT EXISTS missing_fields              text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS field_sources               jsonb NOT NULL DEFAULT '{}',         -- per data point: {source, ref, version, derived_at}
  ADD COLUMN IF NOT EXISTS last_derived_at             timestamptz,
  ADD COLUMN IF NOT EXISTS lar_file_id                 uuid,                                -- FK added below once hmda_lar_files exists
  ADD COLUMN IF NOT EXISTS excluded_reason             text,                                -- §1003.3(c) exclusion (e.g. cema_gap_advance, unimproved_land); omitted from the LAR
  ADD COLUMN IF NOT EXISTS rule_set_version            text NOT NULL DEFAULT 'regc.hmda.2026';
ALTER TABLE hmda_records ADD CONSTRAINT hmda_records_uli_len CHECK (uli IS NULL OR char_length(uli) <= 45);
ALTER TABLE hmda_records ADD CONSTRAINT hmda_records_rate_spread_only_when_originated CHECK (rate_spread IS NULL OR action_taken IN (1, 2, 8));   -- comment 4(a)(12)-6
ALTER TABLE hmda_records ADD CONSTRAINT hmda_records_date_order CHECK (action_taken_date IS NULL OR application_date IS NULL OR application_date <= action_taken_date);
CREATE UNIQUE INDEX IF NOT EXISTS hmda_records_uli_uidx ON hmda_records(uli) WHERE uli IS NOT NULL;
CREATE INDEX IF NOT EXISTS hmda_records_year_status_idx ON hmda_records(reporting_year, completeness_status);
COMMENT ON COLUMN hmda_records.completeness_status IS '28.3 state machine: open → final_action_pending_fields → complete → filed; complete → edits_failed → complete after a source correction. Terminal for a year: filed.';

-- ---------------------------------------------------------------- hmda_ulis: the ULI registry (rule 2; one sequence per partner per year)
CREATE TABLE hmda_ulis (
  uli                           text PRIMARY KEY CHECK (char_length(uli) <= 45),
  lei                           char(20) NOT NULL,
  loan_identifier               text NOT NULL CHECK (char_length(loan_identifier) <= 23 AND loan_identifier ~ '^[A-Za-z0-9]+$'),
  check_digit                   char(2) NOT NULL,
  application_id                uuid NOT NULL REFERENCES applications(id),
  partner_id                    uuid REFERENCES parties(id),
  sequence_year                 int NOT NULL,
  sequence_number               int NOT NULL,
  assigned_at                   timestamptz NOT NULL DEFAULT now(),
  validated_by_ffiec_api        boolean NOT NULL DEFAULT false,               -- POST /v2/public/uli/validate → {"isValid": true}
  ffiec_validated_at            timestamptz,
  UNIQUE (lei, loan_identifier),
  UNIQUE (application_id)
);
CREATE TRIGGER hmda_ulis_immutable BEFORE UPDATE OR DELETE ON hmda_ulis FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE hmda_ulis IS '28.3 rule 2 / §1003.4(a)(1)(i): uli = lei || loan_identifier || ISO/IEC 7064 MOD 97-10 check digit (Appendix C); unique within the institution; never PII; assigned at application.received; the FFIEC Check Digit API validates each once.';

-- ---------------------------------------------------------------- hmda_lar_files: TS + LAR pipe-delimited files, platform edits, receipts (rule 14)
CREATE TABLE hmda_lar_files (
  lar_file_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                    uuid REFERENCES parties(id),
  lei                           char(20) NOT NULL,
  reporting_year                int NOT NULL,
  quarter                       int CHECK (quarter BETWEEN 1 AND 4),         -- null for the annual file
  kind                          text NOT NULL CHECK (kind IN ('annual', 'quarterly', 'resubmission')),
  ts_row                        text NOT NULL,                                -- Record Identifier 1; 15 fields (institution, year, quarter, contact, agency 9, total entries, TIN, LEI)
  lar_row_count                 int NOT NULL,
  file_document_id              uuid REFERENCES documents(id),
  sha256                        text NOT NULL,
  built_at                      timestamptz NOT NULL,
  platform_sequence_number      int,                                          -- POST …/submissions
  status_code                   int NOT NULL DEFAULT 1 CHECK (status_code BETWEEN 1 AND 15 OR status_code = -1),
  parse_errors                  jsonb NOT NULL DEFAULT '[]',
  sv_edits                      jsonb NOT NULL DEFAULT '[]',
  quality_edits                 jsonb NOT NULL DEFAULT '[]',
  macro_edits                   jsonb NOT NULL DEFAULT '[]',
  quality_verified_by           text,
  quality_verified_at           timestamptz,
  macro_verified_by             text,
  macro_verified_at             timestamptz,
  signed_by_officer_id          text,                                         -- set only by a /sign call made under the officer's own Login.gov identity
  signed_at                     timestamptz,
  receipt                       text,
  filing_deadline               date NOT NULL,                                -- Mar 1 of Y+1 (annual) / quarter-end + 60 (quarterly)
  supersedes_lar_file_id        uuid REFERENCES hmda_lar_files(lar_file_id),  -- resubmission chain
  retention_class               retention_class NOT NULL DEFAULT 'hmda_3y',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lei, reporting_year, quarter, platform_sequence_number)
);
CREATE INDEX hmda_lar_files_year_idx ON hmda_lar_files(lei, reporting_year, status_code);
COMMENT ON TABLE hmda_lar_files IS '28.3 rule 14 / §1003.5(a): one row per submission sequence; status_code follows the HMDA Platform (1 … 8/9 S/V, 10/11 quality, 12/13 macro, 14 ready, 15 accepted, -1 error); signed_at only under the officer''s token; the accepted file, edit reports and receipt are retained hmda_3y.';
ALTER TABLE hmda_records ADD CONSTRAINT hmda_records_lar_file_fk FOREIGN KEY (lar_file_id) REFERENCES hmda_lar_files(lar_file_id);

-- ---------------------------------------------------------------- hmda_edit_verifications: quality/macro explanations (records for §1003.6 bona fide error treatment)
CREATE TABLE hmda_edit_verifications (
  verification_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lar_file_id                   uuid NOT NULL REFERENCES hmda_lar_files(lar_file_id),
  edit_code                     text NOT NULL,                                -- FIG edit id, e.g. Q614, M001, V625
  edit_type                     char(1) NOT NULL CHECK (edit_type IN ('S', 'V', 'Q', 'M')),
  affected_ulis                 text[] NOT NULL DEFAULT '{}',
  explanation                   text NOT NULL CHECK (char_length(explanation) > 0),   -- must cite the data ("12 of 1,203 records have income > $500K; verified against decisions")
  verified_by                   text NOT NULL,                                -- agent run id or officer id
  verified_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hmda_edit_verifications_file_idx ON hmda_edit_verifications(lar_file_id, edit_code);
CREATE TRIGGER hmda_edit_verifications_immutable BEFORE UPDATE OR DELETE ON hmda_edit_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE hmda_edit_verifications IS '28.3 rule 14: every quality (Q) and macro (M) edit is explained with the supporting numbers before POST …/edits/quality|macro {"verified": true}; S/V edits are corrected at source, never explained away.';

-- ---------------------------------------------------------------- hmda_coverage_tests: the §1003.2(g)(2) 25/200 test per reporting year (rule 1)
CREATE TABLE hmda_coverage_tests (
  test_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                    uuid REFERENCES parties(id),
  reporting_year                int NOT NULL,
  msa_office_on_dec31           boolean NOT NULL,                             -- (g)(2)(i): home or branch office in an MSA on the preceding Dec 31
  closed_end_originations_y1    int NOT NULL CHECK (closed_end_originations_y1 >= 0),   -- Y-1
  closed_end_originations_y2    int NOT NULL CHECK (closed_end_originations_y2 >= 0),   -- Y-2
  open_end_y1                   int NOT NULL DEFAULT 0,
  open_end_y2                   int NOT NULL DEFAULT 0,
  preceding_year_total_records  int NOT NULL DEFAULT 0,                      -- §1003.5(a)(1)(ii): ≥ 60,000 → quarterly reporter
  covered                       boolean NOT NULL,
  quarterly_reporter            boolean NOT NULL DEFAULT false,
  basis                         text NOT NULL,
  evidence_document_id          uuid REFERENCES documents(id),
  decided_by_officer_id         text,
  decided_by_officer_at         timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, reporting_year, created_at)
);
CREATE TRIGGER hmda_coverage_tests_immutable BEFORE UPDATE OR DELETE ON hmda_coverage_tests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE hmda_coverage_tests IS '28.3 rule 1 / 12 CFR 1003.2(g)(2): covered = msa_office_on_dec31 AND closed_end(Y-1) >= 25 AND closed_end(Y-2) >= 25 (or the 200 open-end test); the partner officer decides by Jan 31; every record is captured and edit-checked regardless.';

-- ---------------------------------------------------------------- hmda_public_notices: §1003.5(b)(2), (c)(1), (e) partner-office artifacts (rule 16)
CREATE TABLE hmda_public_notices (
  notice_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                    uuid REFERENCES parties(id),
  kind                          text NOT NULL CHECK (kind IN ('disclosure_statement_notice_b2', 'modified_lar_notice_c1', 'lobby_notice_e')),
  year                          int NOT NULL,
  template_code                 text NOT NULL,                                -- NTC_HMDA_1003_5B_DISCLOSURE_STMT_NOTICE | NTC_HMDA_1003_5C_MODIFIED_LAR_NOTICE | NTC_HMDA_1003_5E_LOBBY_NOTICE
  ffiec_notice_received_at      date,                                         -- (b)(2): the FFIEC availability notice
  due_on                        date,                                         -- (b)(2): +3 business_days_creditor
  made_available_at             date NOT NULL,
  available_until               date,                                         -- b2: +5 years; c1: +3 years; e: null (permanent)
  locations                     jsonb NOT NULL DEFAULT '[]',                  -- home office and each MSA/MD branch
  evidence_document_id          uuid REFERENCES documents(id),                -- signed office attestations with photos
  last_attested_at              date,
  created_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hmda_public_notices_partner_idx ON hmda_public_notices(partner_id, kind, year);
CREATE TRIGGER hmda_public_notices_immutable BEFORE UPDATE OR DELETE ON hmda_public_notices FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE hmda_public_notices IS '28.3 rule 16 / 12 CFR 1003.5(b)(2), (c), (d), (e): the written notices that the disclosure statement / modified LAR "may be obtained on the Bureau''s Web site at www.consumerfinance.gov/hmda" — available 5 / 3 years; the lobby notice is permanent.';

-- ---------------------------------------------------------------- hmda_correction_log: corrections after acceptance (rule 15; §1003.6 bona fide error evidence)
CREATE TABLE hmda_correction_log (
  correction_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lar_file_id                   uuid REFERENCES hmda_lar_files(lar_file_id),
  resubmission_lar_file_id      uuid REFERENCES hmda_lar_files(lar_file_id),
  ulis                          text[] NOT NULL,
  error_class                   text NOT NULL,                                -- e.g. county_tract_mismatch, income, rate_spread
  discovery_route               text NOT NULL CHECK (discovery_route IN ('platform_edit', 'qc', 'exam', 'self_identified')),
  owning_process                text NOT NULL,                                -- corrections flow through the owning process (25.2 for a CD field …)
  corrected_by                  text NOT NULL,
  corrected_at                  timestamptz NOT NULL DEFAULT now(),
  detail                        jsonb NOT NULL DEFAULT '{}'
);
CREATE TRIGGER hmda_correction_log_immutable BEFORE UPDATE OR DELETE ON hmda_correction_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE hmda_correction_log IS '28.3 rule 15: a material error discovered after acceptance → corrected at source, a new submission for the same year, the officer re-signs; the log records the ULIs, the error class and the discovery route.';

COMMIT;
