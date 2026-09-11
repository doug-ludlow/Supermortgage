-- 0089_appraisal_review.sql — §24.2 appraisal receipt, UCDP/Collateral Underwriter review, reconsideration of value,
-- appraisal quality/bias controls, Reg B delivery and HPML appraisal rules
-- (spec/sections/24-…/24-2-appraisal-receipt-ucdp-collateral-underwriter-review-reconsi.md "Data model"; addendum §3 names
-- `appraisals` and `rov_requests` as the section's baseline tables — created here with 24.2's columns; 0088 (24.1) left
-- appraisals / ucdp_submissions to this file). Owned here: appraisals, ucdp_submissions, valuations (the Reg B artifact
-- register), rov_requests. Not here (other owners, never duplicated): valuation_orders / property_data_collections /
-- appraiser_panel / valuation_fee_benchmarks (0088), applications / application_properties / purchase_contracts (0057),
-- hpml_determinations / qm_determinations (0087), disclosures / fee_items (0064), consents (0001 — the
-- `regb_1002_14_timing_waiver` statement is a consents row whose kind enum is extended below), escalations (0019),
-- documents / parties / agent_decisions (0001), borrower_fair_lending (0001 — the fair-lending record the bias scan writes).
-- Versions are rows: one `appraisals` row per (application, appraisal, version_no); a revision is a new row, never an update
-- of the received package (guardrail "never alter a report"). `ucdp_submissions` and `valuations` are facts and are
-- append-only (0001's forbid_mutation trigger); delivery evidence lives on the appraisal version and in `disclosures`.
-- Retention: fnma_loan_file_life_plus_4y (SSRs, review, ROV file) and regb_25m (copy packages, valuations register).
BEGIN;

ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'esign_disclosures';
ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'regb_1002_14_timing_waiver';

-- ---------------------------------------------------------------- appraisals (one row per version; review state machine in 24.2)
CREATE TABLE appraisals (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appraisal_id                      uuid NOT NULL,                                   -- the report identity shared by every version
  application_id                    uuid NOT NULL REFERENCES applications(id),
  loan_id                           uuid REFERENCES loans(id),                       -- set by 30.2 at hand-off
  valuation_order_id                uuid REFERENCES valuation_orders(order_id),      -- 24.1 order (0088); a second_appraisal_hpml order is a distinct row
  version_no                        int NOT NULL CHECK (version_no >= 1),
  is_final_version                  boolean NOT NULL DEFAULT false,                  -- the version used in the underwriting decision (B4-1.1-06)
  received_at                       timestamptz NOT NULL,
  completion_at                     timestamptz,                                     -- Reg B completion: later of last version received / reviewed-and-accepted (comment 14(a)(1)-4)
  effective_date                    date NOT NULL,
  form                              text NOT NULL CHECK (form IN ('1004', '1004_desktop', '1004_hybrid', '1004C', '1025', '1073', '1073_hybrid', '2090', 'urar_uad36')),
  uad_version                       text NOT NULL CHECK (uad_version IN ('2.6', '3.6')),
  appraiser_party_id                uuid NOT NULL REFERENCES parties(id),
  supervisory_appraiser_party_id    uuid REFERENCES parties(id),
  zip_document_id                   uuid REFERENCES documents(id),
  xml_document_id                   uuid REFERENCES documents(id),
  pdf_document_id                   uuid REFERENCES documents(id),
  package_hash                      char(64),                                        -- frozen package hash (portal fallback uploads the same bytes)
  uad_compliance_result             jsonb,
  appraised_value_cents             bigint NOT NULL CHECK (appraised_value_cents > 0),
  condition_rating                  text CHECK (condition_rating IN ('C1', 'C2', 'C3', 'C4', 'C5', 'C6')),   -- read from the UAD file; policy is 24.3's
  quality_rating                    text CHECK (quality_rating IN ('Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6')),
  ucdp_status                       text NOT NULL DEFAULT 'not_submitted' CHECK (ucdp_status IN ('not_submitted', 'pending', 'successful', 'not_successful')),
  ucdp_doc_file_id                  text,                                            -- one Doc File ID per loan, same for either GSE; never another lender's
  ssr_document_id                   uuid REFERENCES documents(id),
  cu_score                          numeric(4,1) CHECK (cu_score IS NULL OR (cu_score >= 1.0 AND cu_score <= 5.0) OR cu_score = 999),
  cu_flags                          jsonb NOT NULL DEFAULT '{"overvaluation": false, "undervaluation": false, "property_eligibility_policy": false, "appraisal_quality": false}',
  cu_messages                       jsonb NOT NULL DEFAULT '[]',
  hard_stops                        jsonb NOT NULL DEFAULT '[]',
  review_status                     text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'ucdp_pending', 'ucdp_successful', 'ucdp_not_successful', 'override_requested', 'in_review', 'accepted', 'correction_requested', 'field_review_ordered', 'second_appraisal_ordered', 'rejected')),
  review_findings                   jsonb,
  bias_scan_result                  jsonb,                                           -- {terms_hit[], demographic_references[], severity}
  value_used_cents                  bigint CHECK (value_used_cents IS NULL OR (value_used_cents > 0 AND value_used_cents <= appraised_value_cents)),  -- never above the appraised value
  value_basis                       text CHECK (value_basis IN ('appraised', 'purchase_price', 'lower_of_two')),
  rw_relief_property_value          boolean NOT NULL DEFAULT false,                  -- CU ≤ 2.5 ∧ Successful ∧ CU-analysed form (A2-2-06)
  hpml_second_appraisal             boolean NOT NULL DEFAULT false,
  copy_required_by                  date,                                            -- min(completion + 7 cd, consummation − 3 business_days_creditor)
  copy_delivered_at                 timestamptz,
  copy_receipt_evidence             text CHECK (copy_receipt_evidence IN ('esign_confirmed', 'portal_viewed', 'mailbox_rule', 'in_person')),
  copy_notice_id                    uuid,
  transferred_from_lender           boolean NOT NULL DEFAULT false,                  -- 24.1 transfer: resubmitted under the partner
  retention_class                   text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, appraisal_id, version_no)
);
CREATE INDEX appraisals_application_idx ON appraisals(application_id, appraisal_id, version_no);
CREATE UNIQUE INDEX appraisals_final_version_idx ON appraisals(application_id, appraisal_id) WHERE is_final_version;
COMMENT ON TABLE appraisals IS '24.2 appraisal versions: receipt, UCDP/CU results, review status, bias scan, value used, Reg B copy state. One row per version; revisions are new rows (never alter a report). Retention fnma_loan_file_life_plus_4y (+ regb_25m for copy evidence).';

-- ---------------------------------------------------------------- ucdp_submissions (append-only facts per (appraisal version, GSE))
CREATE TABLE ucdp_submissions (
  submission_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appraisal_version_id              uuid NOT NULL REFERENCES appraisals(id),
  appraisal_id                      uuid NOT NULL,
  version_no                        int NOT NULL,
  gse                               text NOT NULL CHECK (gse IN ('fnma', 'fhlmc')),
  doc_file_id                       text NOT NULL,
  submitted_at                      timestamptz NOT NULL,
  channel                           text NOT NULL DEFAULT 'direct_integration' CHECK (channel IN ('direct_integration', 'ucdp_ui')),   -- outage → operator UI upload from the frozen package hash
  status                            text NOT NULL CHECK (status IN ('pending', 'successful', 'not_successful')),
  result_at                         timestamptz,
  ssr_pdf_document_id               uuid REFERENCES documents(id),
  ssr_json_document_id              uuid REFERENCES documents(id),
  findings                          jsonb NOT NULL DEFAULT '[]',                     -- severity-ordered: Fatal, Overridable, Warning
  cu_score                          numeric(4,1),
  cu_flags                          jsonb,
  override_request                  jsonb,                                           -- {reason_code, requested_by, requested_at, approved_at} — approval UI-only by fnma_portal_operator
  api_correlation_id                text,
  created_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ucdp_submissions_appraisal_idx ON ucdp_submissions(appraisal_id, version_no, gse);
CREATE TRIGGER ucdp_submissions_immutable BEFORE UPDATE OR DELETE ON ucdp_submissions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE ucdp_submissions IS '24.2 UCDP Direct Integration submissions and SSRs per GSE (idempotent by appraisal_id, version_no, gse; resubmissions keep the Doc File ID). Append-only: a status change is a new row. FNMA_B4_1_1_06_UCDP_SUCCESSFUL_GATE reads the final version''s fnma row.';

-- ---------------------------------------------------------------- valuations (Reg B §1002.14 artifact register; append-only)
CREATE TABLE valuations (
  valuation_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                    uuid NOT NULL REFERENCES applications(id),
  kind                              text NOT NULL CHECK (kind IN ('appraisal', 'appraisal_revision', 'appraisal_update', 'completion_report', 'avm_report', 'bpo', 'staff_value_document', 'field_review')),
  appraisal_version_id              uuid REFERENCES appraisals(id),
  source_document_id                uuid REFERENCES documents(id),
  developed_at                      date NOT NULL,
  delivered_at                      timestamptz,
  notice_id                         uuid,                                            -- the NTC_REGB_1002_14_VALUATION_COPY / _COPY_NOT_CONSUMMATED package that carried it
  excluded_reason                   text,                                            -- comment 14(b)(3)-3 (internal restatement; governmental assessed value); DU value-acceptance messages (open question 4)
  retention_class                   text NOT NULL DEFAULT 'regb_25m',
  created_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX valuations_application_idx ON valuations(application_id, delivered_at);
CREATE TRIGGER valuations_immutable BEFORE UPDATE OR DELETE ON valuations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE valuations IS '24.2 Reg B valuation register: every estimate of value developed in connection with the application (appraisals and revisions, AVM reports, BPOs, staff value documents, field reviews) with delivery evidence; append-only (delivery is recorded as a new row referencing the same source document). Retention regb_25m.';

-- ---------------------------------------------------------------- rov_requests (B4-1.3-12; one borrower-initiated ROV per appraisal, none after closing)
CREATE TABLE rov_requests (
  rov_id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appraisal_id                      uuid NOT NULL,
  application_id                    uuid NOT NULL REFERENCES applications(id),
  requested_by                      text NOT NULL CHECK (requested_by IN ('borrower', 'lender')),
  requested_at                      timestamptz NOT NULL,
  borrower_names                    jsonb NOT NULL DEFAULT '[]',
  property_address                  text NOT NULL,
  appraisal_effective_date          date NOT NULL,
  appraiser_name                    text NOT NULL,
  disputed_areas                    jsonb NOT NULL DEFAULT '[]',
  comparables                       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_array_length(comparables) <= 5),   -- each with `source`
  attachments                       jsonb NOT NULL DEFAULT '[]',
  status                            text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'screened', 'sme_review', 'forwarded', 'declined', 'awaiting_appraiser', 'response_received', 'closed')),
  screen_result                     text CHECK (screen_result IN ('complete', 'incomplete', 'duplicate_rejected', 'post_closing_rejected')),
  screen_reasons                    jsonb NOT NULL DEFAULT '[]',
  sme_reviewer                      text,                                            -- user or agent run (feature flag valuation.rov_sme)
  sme_escalation_id                 uuid REFERENCES escalations(id),
  sme_decision                      text CHECK (sme_decision IN ('forward', 'decline', 'forward_partial')),
  sme_rationale                     text,
  sent_to_appraiser_at              timestamptz,
  turn_time_due_at                  date,                                            -- sent_to_appraiser + 5 business_days_creditor
  response_received_at              timestamptz,
  revised_appraisal_version_id      uuid REFERENCES appraisals(id),
  outcome                           text CHECK (outcome IN ('value_increased', 'value_decreased', 'no_change', 'withdrawn', 'declined')),
  outcome_document_id               uuid REFERENCES documents(id),
  fair_lending_flag                 boolean NOT NULL DEFAULT false,
  complaint_case_id                 uuid REFERENCES cases(id),
  rejection_reason                  text,
  closed_at                         timestamptz,
  retention_class                   text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rov_requests_appraisal_idx ON rov_requests(appraisal_id, requested_by, requested_at);
CREATE UNIQUE INDEX rov_requests_one_borrower_rov_idx ON rov_requests(appraisal_id) WHERE requested_by = 'borrower' AND screen_result NOT IN ('duplicate_rejected', 'post_closing_rejected');
COMMENT ON TABLE rov_requests IS '24.2 reconsideration of value file (B4-1.3-12): request contents, screening, designated-SME decision, standardized appraiser communication, turn-time, response, outcome documentation retained in the loan file. One accepted borrower-initiated ROV per appraisal (partial unique index); none after closing (screen_result post_closing_rejected).';

COMMIT;
