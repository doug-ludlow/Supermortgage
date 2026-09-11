-- 0078_document_intake.sql — 22.1 Document intake, classification, extraction, integrity/freshness checks and the borrower
-- needs-list loop: the tables the process defines (spec/sections/22-…/22-1-…md "Data model"). `documents` (0001; shared with
-- servicing) gains the 22.1-owned columns; `document_classes` (reference data), `document_extractions`,
-- `document_integrity_checks` and `document_requests` are new. `applications` / `application_borrowers` (0057) are the
-- aggregate; `conditions` (23.2/23.3), `verifications` / `du_submissions` (22.3/23.1) and `notices` (0009) are referenced by
-- id only. Append-only where the spec's rows are evidence: extractions (a new extractor run is a new row) and integrity
-- checks (every check with vendor and rule-set version). A request row changes status, so it is versioned by `updated_at`
-- and its history lives in loan_events (`document_request.*`).
BEGIN;

-- ───────────────────────────── document_classes (reference data; B1-1-03 scope flag) ─────────────────────────────
CREATE TABLE document_classes (
  code                      text PRIMARY KEY,
  family                    text NOT NULL CHECK (family IN ('identity', 'income_employment', 'tax', 'assets', 'liabilities', 'property_purchase', 'insurance', 'hoa_project', 'trust_entity', 'letters', 'credit', 'valuation', 'title', 'closing', 'other')),
  default_freshness_basis   text NOT NULL CHECK (default_freshness_basis IN ('b1_1_03_4m', 'b3_3_2_01_paystub_30d', 'b1_1_03_tax_year_table', 'b4_1_2_04_appraisal', 'du_validation_vendor_age', 'none')),
  default_retention_class   retention_class NOT NULL DEFAULT 'regb_25m',
  extraction_schema_version text NOT NULL DEFAULT '2026-09',
  is_credit_document        boolean NOT NULL DEFAULT false,           -- B1-1-03 "credit documents include credit reports and employment, income, and asset documentation"
  created_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE document_classes IS '22.1 data model: reference data for `documents.doc_class` — family, default freshness basis (R1/R2; open question 3: W-2/1099/returns follow the tax-year table, not the four-month rule), default retention class (R9) and the B1-1-03 credit-document flag.';
INSERT INTO document_classes (code, family, default_freshness_basis, is_credit_document) VALUES
  ('drivers_license', 'identity', 'none', false), ('passport', 'identity', 'none', false), ('state_id', 'identity', 'none', false), ('ssn_card', 'identity', 'none', false), ('permanent_resident_card', 'identity', 'none', false), ('ead', 'identity', 'none', false), ('itin_letter', 'identity', 'none', false),
  ('paystub', 'income_employment', 'b3_3_2_01_paystub_30d', true), ('w2', 'income_employment', 'b1_1_03_tax_year_table', true), ('form_1099', 'income_employment', 'b1_1_03_tax_year_table', true),
  ('form_1005_voe', 'income_employment', 'b1_1_03_4m', true), ('employment_offer', 'income_employment', 'b1_1_03_4m', true), ('vvoe_record', 'income_employment', 'du_validation_vendor_age', true), ('military_les', 'income_employment', 'b1_1_03_4m', true),
  ('ssa_award_letter', 'income_employment', 'b1_1_03_4m', true), ('pension_award_letter', 'income_employment', 'b1_1_03_4m', true), ('disability_award_letter', 'income_employment', 'b1_1_03_4m', true), ('divorce_decree', 'income_employment', 'none', false), ('support_order', 'income_employment', 'none', false), ('leave_confirmation', 'income_employment', 'b1_1_03_4m', true),
  ('form_1040', 'tax', 'b1_1_03_tax_year_table', true), ('schedule_c', 'tax', 'b1_1_03_tax_year_table', true), ('schedule_e', 'tax', 'b1_1_03_tax_year_table', true), ('schedule_k1', 'tax', 'b1_1_03_tax_year_table', true), ('form_1065', 'tax', 'b1_1_03_tax_year_table', true), ('form_1120', 'tax', 'b1_1_03_tax_year_table', true), ('form_1120s', 'tax', 'b1_1_03_tax_year_table', true),
  ('form_4506c', 'tax', 'none', false), ('form_8821', 'tax', 'none', false), ('irs_return_transcript', 'tax', 'b1_1_03_tax_year_table', true), ('irs_wage_income_transcript', 'tax', 'b1_1_03_tax_year_table', true), ('form_4868', 'tax', 'none', false),
  ('bank_statement', 'assets', 'b1_1_03_4m', true), ('brokerage_statement', 'assets', 'b1_1_03_4m', true), ('retirement_statement', 'assets', 'b1_1_03_4m', true), ('voa_report', 'assets', 'du_validation_vendor_age', true), ('form_1006_vod', 'assets', 'b1_1_03_4m', true),
  ('gift_letter', 'assets', 'none', false), ('gift_transfer_evidence', 'assets', 'b1_1_03_4m', true), ('emd_evidence', 'assets', 'b1_1_03_4m', true), ('asset_sale_evidence', 'assets', 'b1_1_03_4m', true),
  ('mortgage_statement', 'liabilities', 'b1_1_03_4m', true), ('heloc_statement', 'liabilities', 'b1_1_03_4m', true), ('student_loan_statement', 'liabilities', 'b1_1_03_4m', true), ('payoff_statement', 'liabilities', 'b1_1_03_4m', true), ('irs_installment_agreement', 'liabilities', 'b1_1_03_4m', true),
  ('purchase_contract', 'property_purchase', 'none', false), ('contract_addendum', 'property_purchase', 'none', false), ('lease_agreement', 'property_purchase', 'none', false), ('form_1007', 'property_purchase', 'none', false), ('form_1025', 'property_purchase', 'none', false),
  ('homeowners_policy', 'insurance', 'none', false), ('flood_policy', 'insurance', 'none', false), ('condo_master_policy', 'insurance', 'none', false), ('ho6_policy', 'insurance', 'none', false),
  ('hoa_questionnaire', 'hoa_project', 'none', false), ('hoa_budget', 'hoa_project', 'none', false), ('hoa_dues_statement', 'hoa_project', 'none', false), ('project_docs', 'hoa_project', 'none', false),
  ('trust_agreement', 'trust_entity', 'none', false), ('trust_certification', 'trust_entity', 'none', false),
  ('explanation_letter', 'letters', 'b1_1_03_4m', true), ('inquiry_explanation', 'letters', 'b1_1_03_4m', true), ('occupancy_letter', 'letters', 'b1_1_03_4m', true),
  ('credit_report', 'credit', 'b1_1_03_4m', true), ('credit_refresh_report', 'credit', 'b1_1_03_4m', true),
  ('appraisal_report', 'valuation', 'b4_1_2_04_appraisal', false), ('form_1004d_update', 'valuation', 'b4_1_2_04_appraisal', false), ('desktop_appraisal', 'valuation', 'b4_1_2_04_appraisal', false), ('pdc_report', 'valuation', 'b4_1_2_04_appraisal', false),
  ('title_commitment', 'title', 'none', false), ('title_policy', 'title', 'none', false),
  ('closing_disclosure', 'closing', 'none', false), ('note', 'closing', 'none', false), ('security_instrument', 'closing', 'none', false),
  ('unclassified', 'other', 'none', false);

-- ───────────────────────────── documents: the 22.1-owned columns (shared table, 0001; doc_class since 0014) ─────────────────────────────
-- `doc_class` carries no FK: 0014's loss-mitigation classes share the column; 22.1 rows use document_classes codes (the tools refuse others).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS doc_subclass                  text,
  ADD COLUMN IF NOT EXISTS classification_confidence     numeric(5,4),
  ADD COLUMN IF NOT EXISTS classifier_version            text,
  ADD COLUMN IF NOT EXISTS source_channel                text CHECK (source_channel IS NULL OR source_channel IN ('borrower_upload', 'borrower_email', 'borrower_mail_scan', 'vendor_delivery', 'agent_generated', 'partner_upload', 'fnma_delivery')),
  ADD COLUMN IF NOT EXISTS sender_identity               jsonb NOT NULL DEFAULT '{}',        -- portal user id, verified e-mail sender, vendor id, parent_document_id for bundle splits
  ADD COLUMN IF NOT EXISTS received_at                   timestamptz,
  ADD COLUMN IF NOT EXISTS document_date                 date,                              -- R1: the date the document bears, by class
  ADD COLUMN IF NOT EXISTS period_start                  date,
  ADD COLUMN IF NOT EXISTS period_end                    date,
  ADD COLUMN IF NOT EXISTS issuer_name                   text,
  ADD COLUMN IF NOT EXISTS subject_borrower_id           uuid REFERENCES application_borrowers(id),
  ADD COLUMN IF NOT EXISTS page_count                    int,
  ADD COLUMN IF NOT EXISTS integrity_status              text NOT NULL DEFAULT 'pending' CHECK (integrity_status IN ('pending', 'passed', 'flagged', 'failed', 'not_applicable')),
  ADD COLUMN IF NOT EXISTS freshness_basis               text NOT NULL DEFAULT 'none' CHECK (freshness_basis IN ('b1_1_03_4m', 'b3_3_2_01_paystub_30d', 'b1_1_03_tax_year_table', 'b4_1_2_04_appraisal', 'du_validation_vendor_age', 'none')),
  ADD COLUMN IF NOT EXISTS freshness_status              text NOT NULL DEFAULT 'n_a' CHECK (freshness_status IN ('fresh', 'expiring', 'expired', 'n_a')),
  ADD COLUMN IF NOT EXISTS expires_at                    date,                              -- R2: add_months(document_date, 4)
  ADD COLUMN IF NOT EXISTS supersedes_document_id        uuid REFERENCES documents(id),     -- R8
  ADD COLUMN IF NOT EXISTS additional_retention_classes  retention_class[] NOT NULL DEFAULT '{}',   -- R9: the ATR evidence set carries regz_atr_3y beside fnma_loan_file_life_plus_4y
  ADD COLUMN IF NOT EXISTS purge_eligible_on             date,                              -- R9: regb_25m from the denial/withdrawal notification date unless legal_hold
  ADD COLUMN IF NOT EXISTS pii_flags                     text[] NOT NULL DEFAULT '{}';      -- ssn, dob, account_number, id_number, tax_data, health
COMMENT ON COLUMN documents.expires_at IS '22.1 R2 (Selling Guide B1-1-03): document_date + 4 calendar months (end-of-month clamp); fresh iff expires_at >= the scheduled note date; re-tested by the nightly sweep and on every closing.scheduled.';
COMMENT ON COLUMN documents.integrity_status IS '22.1 R5 aggregation: any fail -> failed (underwriting_reviewer, 22.6 fraud candidate); >= 2 warn, or one warn on sole-evidence income/asset paper -> flagged; else passed. A request is satisfied only by a passed document.';
CREATE INDEX IF NOT EXISTS documents_app_class_idx ON documents(application_id, doc_class) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_expiry_idx ON documents(expires_at) WHERE expires_at IS NOT NULL AND freshness_status IN ('fresh', 'expiring');

-- ───────────────────────────── document_extractions (append-only) ─────────────────────────────
CREATE TABLE document_extractions (
  extraction_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        uuid NOT NULL REFERENCES documents(id),
  schema_version     text NOT NULL,
  fields             jsonb NOT NULL,                     -- per-class schema (paystub: employer_name … medicare_withholding_ytd_cents; bank_statement: institution … transactions[])
  field_confidence   jsonb NOT NULL DEFAULT '{}',
  extractor_version  text NOT NULL,
  ocr_engine         text,
  human_verified     boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE document_extractions IS '22.1 data model: the extracted fields with per-field confidence, extractor/OCR versions and human verification; one row per extractor run (LL-2026-04 evidence); append-only.';
CREATE INDEX document_extractions_doc_idx ON document_extractions(document_id, created_at);
CREATE TRIGGER document_extractions_immutable BEFORE UPDATE OR DELETE ON document_extractions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── document_integrity_checks (append-only) ─────────────────────────────
CREATE TABLE document_integrity_checks (
  check_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        uuid NOT NULL REFERENCES documents(id),
  check_type         text NOT NULL CHECK (check_type IN ('pdf_metadata', 'font_layout', 'arithmetic', 'running_balance', 'template_match', 'even_dollar', 'cross_document', 'vendor_fraud_score', 'sender_authentication', 'source_verification')),
  result             text NOT NULL CHECK (result IN ('pass', 'warn', 'fail', 'n_a')),
  score              numeric,
  details            jsonb NOT NULL DEFAULT '{}',        -- expected/actual/deviation/tolerance cents as strings; findings; mismatches; large deposits tagged for 22.4
  vendor             text,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  rule_set_version   text NOT NULL
);
COMMENT ON TABLE document_integrity_checks IS '22.1 R5: every battery check (pdf_metadata, font_layout, arithmetic incl. the Medicare 1.45 % / SS 6.2 % tolerance max(500 cents, 0.5 %), running_balance, template_match, even_dollar, cross_document, vendor_fraud_score, sender_authentication, source_verification) with vendor and rule-set version; append-only (A3-4-02 evidence).';
CREATE INDEX document_integrity_checks_doc_idx ON document_integrity_checks(document_id, checked_at);
CREATE TRIGGER document_integrity_checks_immutable BEFORE UPDATE OR DELETE ON document_integrity_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── document_requests (the needs list) ─────────────────────────────
CREATE TABLE document_requests (
  request_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  condition_id               uuid,                                     -- 23.2/23.3 `conditions` (their migration); null for intake/freshness/integrity rules
  borrower_id                uuid NOT NULL REFERENCES application_borrowers(id),
  doc_class                  text NOT NULL REFERENCES document_classes(code),
  qualifier                  jsonb NOT NULL DEFAULT '{}',              -- e.g. {employer: "Acme", months: 2, account_last4: "1234"}
  reason_code                text NOT NULL,                            -- DU message id / underwriter code / sm_intake / sm_freshness / sm_integrity_source_verification …
  reason_text                text NOT NULL,                            -- the plain-language line the needs list shows (derived, never free-typed)
  requested_at               timestamptz NOT NULL,
  due_at                     date NOT NULL,                            -- R7: requested_at + 5 calendar_days (reminders +2/+4)
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reminded', 'received', 'under_review', 'satisfied', 'waived', 'expired', 'cancelled')),
  satisfied_by_document_id   uuid REFERENCES documents(id),
  waived_by                  text CHECK (waived_by IS NULL OR waived_by IN ('du_validation', 'owning_process_rule')),
  waiver_reference           text,                                     -- the DU submission number or the owning process's rule citation
  reminder_count             int NOT NULL DEFAULT 0,
  channel_used               text[] NOT NULL DEFAULT '{}',
  notice_ids                 uuid[] NOT NULL DEFAULT '{}',
  verifying_document         boolean NOT NULL DEFAULT true,            -- TRID FAQ: the batch waits for disclosure.le.delivered
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (reason_text <> ''),
  CHECK ((status = 'waived') = (waived_by IS NOT NULL)),
  CHECK (status <> 'satisfied' OR satisfied_by_document_id IS NOT NULL)
);
COMMENT ON TABLE document_requests IS '22.1 R6/R7: the needs list — one open request per (borrower, doc_class, qualifier); satisfied only by a passed, unexpired, subject-matched document; waived only by a DU validation outcome (submission number recorded) or an owning-process rule; the SM_NEEDS_LIST_BORROWER_RESPONSE_5 / SM_NEEDS_LIST_REVIEW_1BD clocks run from loan_events.';
CREATE UNIQUE INDEX document_requests_open_dedupe_idx ON document_requests(application_id, borrower_id, doc_class, qualifier) WHERE status IN ('open', 'reminded', 'received', 'under_review');
CREATE INDEX document_requests_app_status_idx ON document_requests(application_id, status);

COMMIT;
