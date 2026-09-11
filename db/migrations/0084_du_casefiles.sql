-- 0084_du_casefiles.sql — 23.1 DU casefile creation, submission, resubmission tolerances, versioning and the casefile
-- lifecycle (spec/sections/23-…/23-1-…md "Data model"; addendum §3 `du_casefiles` (`casefile_id`, `du_version`) and
-- `du_submissions` (`submission_number`, `recommendation`, `findings_document_id`, `messages`, `risk_factors`,
-- `validation_results`, `value_acceptance_offer`, `mi_requirement`)). `applications` (0057) is the aggregate;
-- `application_borrowers` (0057), `credit_reports` (0079), `documents` (0001/0057) and `agent_decisions` (0001) are
-- referenced by id. State transitions of a casefile/submission are `loan_events` rows keyed by application_id
-- (du.casefile.created, du.submitted, du.findings.received, …); the tables below keep the rows the process reads back.
-- `du_resubmission_checks` is the B3-2-10 evidence log (the diff and rule evaluation for every resubmission or waiver)
-- and is append-only. Retention class fnma_loan_file_life_plus_4y (A2-4.1-02); DU findings are Fannie Mae-confidential
-- and never borrower-deliverable.
BEGIN;

-- R1: one casefile per application (superseded rows keep their IDs; DU's "potential casefile ID reuse" red flag is
-- enforced by never re-using a casefile for a different borrower/property). policy_generation is the creation-keyed
-- rule set (June 27, 2026 minimum-credit-risk standards; Sept 26, 2026 DU validation-service changes); the
-- submission-keyed counterpart is du_submissions.du_release_applied. Archival: B3-2-01 earlier of last update + 270
-- days or creation + 540 days (660 for single-closing C-to-P — not built; the rule is data, not hard-coded).
CREATE TABLE du_casefiles (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casefile_id                     text NOT NULL UNIQUE,                        -- DU loan casefile ID (reported at delivery, A2-2-04; ULDD 29.3)
  application_id                  uuid NOT NULL REFERENCES applications(id),
  du_version                      text NOT NULL DEFAULT '12.1',
  seller_number                   char(9) NOT NULL,                            -- the partner's Fannie Mae seller number (casefiles are the partner's)
  system_id_ref                   text NOT NULL,                               -- partner-org System ID assigned to SM's TSP Product (Technology Manager)
  tsp_product_ref                 text NOT NULL,
  created_at                      timestamptz NOT NULL,
  last_updated_at                 timestamptz NOT NULL,                        -- DU's "last updated" as reported/observed (submission or findings)
  policy_generation               text NOT NULL CHECK (policy_generation IN ('pre_2026_06_27', '2026_06_27', '2026_09_26')),
  archive_270_due_at              date NOT NULL,                               -- last_updated_at + 270 days
  archive_540_due_at              date NOT NULL,                               -- created_at + 540 days
  archive_due_at                  date NOT NULL,                               -- min of the two; warning at T−30 (day 240)
  status                          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'credit_associated', 'submitted', 'findings_received', 'resubmission_required', 'final', 'delivered', 'error', 'archive_warning', 'archived', 'superseded')),
  credit_association              jsonb NOT NULL DEFAULT '[]',                 -- per borrower: {borrower_id, mode ∈ order_new|reissue, credit_agency_code, reference_number (restricted read), report_type ∈ joint|individual, credit_report_id → credit_reports.id, score_model, expires_at}
  score_model                     text CHECK (score_model IN ('classic_fico', 'vantagescore_4')),  -- copied from applications.score_model (22.2 R11); never mixed across borrowers
  validation_opt_in               boolean NOT NULL DEFAULT true,               -- DU validation service opt-in (income/employment via asset reports; B3-2-02)
  final_submission_id             uuid,                                        -- FK added below (du_submissions)
  superseded_by_casefile_id       uuid REFERENCES du_casefiles(id),
  supersede_reason                text CHECK (supersede_reason IN ('archived', 'borrower_identity_change', 'casefile_error')),
  submission_count                int NOT NULL DEFAULT 0,
  red_flag_excessive_resubmissions boolean NOT NULL DEFAULT false,             -- > 10 submissions (rule 6; B3-2-11 red-flag message; reviewer after 15)
  retention_class                 text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  CONSTRAINT du_casefiles_archive_due CHECK (archive_due_at = LEAST(archive_270_due_at, archive_540_due_at))
);
CREATE INDEX du_casefiles_application_idx ON du_casefiles(application_id, created_at);
CREATE INDEX du_casefiles_archive_idx ON du_casefiles(archive_due_at) WHERE status NOT IN ('archived', 'superseded', 'delivered');
COMMENT ON TABLE du_casefiles IS '23.1: one DU loan casefile per application under the partner''s seller number (SM as TSP). policy_generation = creation-keyed DU rule set; archive_270/540_due_at per B3-2-01; status per the 23.1 state machine (draft → credit_associated → submitted → findings_received → [resubmission_required → submitted]* → final → delivered; side states error / archive_warning / archived / superseded). credit_association reference numbers are PII-adjacent (restricted read). Retention fnma_loan_file_life_plus_4y.';

-- R3–R5: every DU request is the whole ULAD snapshot (DU Spec, MISMO 3.4 Build 324), hashed into request_hash;
-- two identical hashes in a row are suppressed unless reason ∈ {error_retry, final_closed_loan_match}.
-- du_release_applied = the latest DU release evening ≤ submitted_at (submission-keyed changes: "submitted or
-- resubmitted on or after the evening of" June 26 / Sept 25, 2026). is_final + closed_loan_snapshot_hash = the
-- B3-2-10 "reflect the loan as it was closed" proof (FNMA_B3_2_10_DU_FINAL_MATCH_GATE); the final findings PDF is the
-- permanent-loan-file copy (B3-2-04).
CREATE TABLE du_submissions (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  casefile_id                     uuid NOT NULL REFERENCES du_casefiles(id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  submission_number               int NOT NULL,
  submission_type                 text NOT NULL CHECK (submission_type IN ('credit_only', 'credit_and_underwriting', 'underwriting_only')),
  reason                          text NOT NULL CHECK (reason IN ('initial', 'data_change', 'tolerance_breach', 'credit_refresh', 'validation_report_update', 'error_retry', 'final_closed_loan_match', 'delivery_correction')),
  request_document_id             uuid REFERENCES documents(id),               -- DU Spec XML (retention fnma_loan_file_life_plus_4y; Fannie Mae-confidential)
  request_hash                    bytea NOT NULL,
  du_version                      text NOT NULL DEFAULT '12.1',
  du_release_applied              text NOT NULL,                               -- e.g. 2026_06_26, 2026_09_09, 2026_09_25
  return_file_types               text[] NOT NULL DEFAULT '{json_v2,pdf_standard}',  -- types 16/17 refused from Dec 1, 2026 (FNMA_DU_RETURN_FILE_16_17_RETIRE)
  findings_document_id            uuid REFERENCES documents(id),               -- addendum §3 (the JSON v2 findings)
  findings_json_document_id       uuid REFERENCES documents(id),
  findings_pdf_document_id        uuid REFERENCES documents(id),               -- standard PDF for the loan file
  submitted_at                    timestamptz NOT NULL,
  acked_at                        timestamptz,
  findings_received_at            timestamptz,
  status                          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'acked', 'findings_received', 'error', 'superseded')),
  error_code                      text,                                        -- DU Error Codes document / DI_TRANSPORT_OUTAGE / SCORE_MODEL_MIXED
  error_message                   text,
  recommendation                  text CHECK (recommendation IN ('approve_eligible', 'approve_ineligible', 'refer_with_caution', 'out_of_scope', 'error')),
  messages                        jsonb NOT NULL DEFAULT '[]',                 -- DU messages (23.2 opens conditions; 23.1 only stores them)
  risk_factors                    jsonb NOT NULL DEFAULT '{}',
  validation_results              jsonb NOT NULL DEFAULT '[]',                 -- per component: validated / not_validated / unable_to_validate (+ close_by_date; 22.3 gate)
  value_acceptance_offer          jsonb,                                       -- 24.1 consumes (from the final submission)
  mi_requirement                  jsonb,                                       -- 24.6 consumes
  dti_du                          numeric(6,3),
  ltv_du                          numeric(6,3),
  cltv_du                         numeric(6,3),
  hcltv_du                        numeric(6,3),
  reserves_required_cents         bigint,                                      -- "Reserves Required to be Verified" (22.4 gate; B3-2-10 90 % rule)
  total_funds_to_verify_cents     bigint,
  qualifying_rate                 numeric(7,5),
  note_rate                       numeric(7,5),
  loan_amount_cents               bigint NOT NULL,
  is_final                        boolean NOT NULL DEFAULT false,
  closed_loan_snapshot_hash       bytea,                                       -- = closing-data hash when is_final (B3-2-10 first sentence)
  findings_hash                   bytea,
  submitted_via                   text NOT NULL DEFAULT 'di_channel' CHECK (submitted_via IN ('di_channel', 'du_ui_fallback')),  -- fnma_portal_operator upload on DI outage
  rationale                       text,                                        -- required after the 10th submission (rule 6)
  agent_run_id                    text,
  UNIQUE (casefile_id, submission_number)
);
CREATE INDEX du_submissions_application_idx ON du_submissions(application_id, submitted_at);
CREATE INDEX du_submissions_final_idx ON du_submissions(casefile_id) WHERE is_final;
COMMENT ON TABLE du_submissions IS '23.1: one row per DU submission (credit_only / credit_and_underwriting / underwriting_only) — request hash (whole-file ULAD snapshot; duplicate suppression), du_release_applied (submission-keyed DU release), findings JSON v2 + PDF, recommendation and the messages/validation/value-acceptance/MI payloads 23.2, 23.3, 24.1, 24.6 and 25.1 consume; is_final + closed_loan_snapshot_hash prove B3-2-10 "the data submitted to DU must reflect the loan as it was closed" (FNMA_B3_2_10_DU_FINAL_MATCH_GATE).';
ALTER TABLE du_casefiles ADD CONSTRAINT du_casefiles_final_submission_fk FOREIGN KEY (final_submission_id) REFERENCES du_submissions(id);

-- R4: B3-2-10 as executable logic — one row per tested field on every application diff (the audit trail that data was
-- never manipulated to reach a recommendation). Append-only.
CREATE TABLE du_resubmission_checks (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  casefile_id                     uuid NOT NULL REFERENCES du_casefiles(id),
  baseline_submission_id          uuid REFERENCES du_submissions(id),          -- the last findings-received submission (null only for an identity change before any findings)
  trigger_event                   text NOT NULL,                               -- application.data.changed | liabilities.changed | verification.received | credit.refresh.received | valuation.received | lock.executed | …
  field                           text NOT NULL CHECK (field IN ('note_rate', 'dti', 'income', 'liabilities', 'assets', 'reserves', 'loan_amount', 'ltv', 'cltv', 'occupancy', 'product', 'amortization', 'loan_term', 'property_type', 'loan_purpose', 'sales_price', 'appraised_value', 'borrower_identity', 'credit_report', 'validation_report', 'mi_coverage', 'llpa_band', 'eligibility_flag')),
  old_value                       jsonb,
  new_value                       jsonb,
  rule_code                       text NOT NULL CHECK (rule_code IN ('B3_2_10_RATE_DECREASE', 'B3_2_10_RATE_DECREASE_BUYDOWN', 'B3_2_10_DTI_45_OR_3PT', 'B3_2_10_DTI_OVER_50', 'B3_2_10_INCOME_LIMITED', 'B3_2_10_REFI_AMOUNT_500_1PCT', 'B3_2_10_REFI_AMOUNT_MINUS_5PCT', 'B3_2_10_PURCHASE_AMOUNT', 'B3_2_10_RESERVES_90PCT', 'B3_2_10_CLOSED_LOAN_FIELD', 'B3_2_10_LCOR_CASH_BACK', 'B3_2_01_CREDIT_EXPIRED', 'B3_2_02_VALIDATION_UPDATE', 'DU_JOBAID_IDENTITY_CHANGE')),
  result                          text NOT NULL CHECK (result IN ('within_tolerance', 'resubmission_required', 'new_casefile_required', 'ineligible_change')),
  arithmetic                      jsonb NOT NULL DEFAULT '{}',                 -- {dti_before, dti_after, delta, amount_before, amount_after, ltv_before, ltv_after, reserves_required, reserves_verified, …}
  citation                        text NOT NULL,
  evaluated_at                    timestamptz NOT NULL,
  resubmission_id                 uuid REFERENCES du_submissions(id),          -- the submission the check produced (null for a waiver)
  agent_decision_id               uuid REFERENCES agent_decisions(id)
);
CREATE INDEX du_resubmission_checks_application_idx ON du_resubmission_checks(application_id, evaluated_at);
CREATE TRIGGER du_resubmission_checks_immutable BEFORE UPDATE OR DELETE ON du_resubmission_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE du_resubmission_checks IS '23.1: the B3-2-10 per-change tests (rate decrease / buydown, DTI 45 % or +3 points (> 50 % ineligible, B3-6-02), income-limited products "income greater than the application indicates", refinance amount +$500-or-1 % / −5 % with the MI / LLPA / eligibility proviso, purchase amount (no tolerance), reserves 90 %, the eight closed-loan fields, credit expiry (B3-2-01), validation-report update (B3-2-02), identity change (DU job aid)) with their arithmetic — append-only evidence for QC/MORA and exams.';

COMMIT;
