-- 0100: 28.2 Post-closing QC program, Fannie Mae QC reviews (Loan Quality Connect), self-reporting, defect rates and
-- remedies/appeals (spec/sections/28-quality-control-hmda-and-fraud-aml-reporting/28-2-…md "Data model").
-- Owned here: fnma_qc_cases (LQC file requests, NOPDs, Resolution Requests, demands, appeals, relief reports,
-- self-report responses), qc_self_reports (D1-1-01 QC-findings / A3-2-01 compliance-with-laws / 28.4 fraud), remedy_ledger
-- (A2-3.2 remedies with the repurchase-price components, LLPAs excluded). Shared tables are REUSED, never redefined:
-- servicing 18.x's qc_cycles (0021) gains the 28.2 post-closing columns by ALTER; 28.1's qc_reviews (0099, if applied
-- before this file — ALTER … IF EXISTS keeps the file applicable either way) gains the post-closing additions; 23.3's
-- rep_warrant_relief (0086) gains the 28.2 confirmation / payment-history columns. Money is bigint cents; instants
-- timestamptz (the Fannie Mae notification instant is the anchor of every D2-1 clock); local dates date. Cases, self-reports
-- and remedies are append-only in the D1-1-01 sense ("maintain records of all loans self-reported") — never deleted
-- (0001's forbid_delete / forbid_mutation); state changes are also loan_events rows (`fnma.qc.*`, `remedy.*`, `qc.self_report.*`).
-- The enum value is added outside the transaction: Postgres refuses a new enum value used (as a DEFAULT) inside the
-- transaction that added it.
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_qc_3y';
BEGIN;

-- ───────────────────────────── qc_cycles: the 28.2 post-closing cycle columns (0021 created the row; kind='monthly') ─────────────────────────────
ALTER TABLE qc_cycles
  ADD COLUMN IF NOT EXISTS partner_id             text,
  ADD COLUMN IF NOT EXISTS production_month       date,                                          -- first day of the month of the disbursement date (D1-3-01)
  ADD COLUMN IF NOT EXISTS population             int,
  ADD COLUMN IF NOT EXISTS population_hash        text,
  ADD COLUMN IF NOT EXISTS random_method          text CHECK (random_method IN ('ten_percent', 'statistical')),
  ADD COLUMN IF NOT EXISTS random_target          int,
  ADD COLUMN IF NOT EXISTS statistical_params     jsonb,                                         -- {confidence: 0.95, precision: 0.02, statement_months: 6, expected_defect_rate}
  ADD COLUMN IF NOT EXISTS discretionary_count    int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selected_at            date,
  ADD COLUMN IF NOT EXISTS cycle_due_on           date,                                          -- last day of production_month + 90 calendar days
  ADD COLUMN IF NOT EXISTS report_scheduled_on    date,                                          -- policy: cycle_due_on − 2 calendar days rolled back to a creditor business day
  ADD COLUMN IF NOT EXISTS reviews_completed_at   date,
  ADD COLUMN IF NOT EXISTS rebuttals_closed_at    date,
  ADD COLUMN IF NOT EXISTS report_issued_at       date,
  ADD COLUMN IF NOT EXISTS post_closing_status    text CHECK (post_closing_status IN ('planned', 'selected', 'in_review', 'rebuttal', 'reported', 'in_arrears')),
  ADD COLUMN IF NOT EXISTS arrears_notice_sent_at date;
COMMENT ON COLUMN qc_cycles.cycle_due_on IS '28.2 rule 1: last_day(production_month) + 90 calendar days (D1-3-01 "within 90 days from the month of the disbursement date") — Nov 2026 → 2027-02-28; any state → in_arrears when today > cycle_due_on + 30 without reported (arrears_notice_sent_at required).';
CREATE INDEX IF NOT EXISTS qc_cycles_production_month_idx ON qc_cycles(partner_id, production_month);

-- ───────────────────────────── qc_reviews: post-closing additions (28.1 owns the table) ─────────────────────────────
ALTER TABLE IF EXISTS qc_reviews
  ADD COLUMN IF NOT EXISTS cycle_id                 uuid REFERENCES qc_cycles(id),
  ADD COLUMN IF NOT EXISTS fnma_loan_number         text,
  ADD COLUMN IF NOT EXISTS disbursement_date        date,
  ADD COLUMN IF NOT EXISTS review_scope             jsonb,                                       -- D1-3-02/-03 checklist with exemptions applied
  ADD COLUMN IF NOT EXISTS du_validation_components text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS close_by_date_met        boolean,
  ADD COLUMN IF NOT EXISTS reunderwrite_required    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS eligible_as_delivered    boolean,
  ADD COLUMN IF NOT EXISTS self_report_id           uuid,
  ADD COLUMN IF NOT EXISTS rebuttal_due_at          date,
  ADD COLUMN IF NOT EXISTS initial_severity         smallint CHECK (initial_severity BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS final_severity           smallint CHECK (final_severity BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS defect_class             text CHECK (defect_class IN ('underwriting_eligibility', 'compliance'));

-- ───────────────────────────── fnma_qc_cases (D2-1; one case per LQC task) ─────────────────────────────
CREATE TABLE fnma_qc_cases (
  case_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                 uuid REFERENCES loans(id),
  application_id          uuid REFERENCES applications(id),
  fnma_loan_number        text NOT NULL,
  case_type               text NOT NULL CHECK (case_type IN ('file_request', 'missing_documents', 'data_validation', 'nopd', 'resolution_request', 'demand_repurchase', 'demand_indemnification', 'demand_make_whole', 'pal', 'appeal_1', 'appeal_2', 'impasse', 'management_escalation', 'idr', 'relief_report', 'self_report_response')),
  lqc_task_id             text NOT NULL,                                                         -- idempotency: one case per LQC task; a duplicate notification links here
  notified_at             timestamptz NOT NULL,                                                  -- the Fannie Mae notification instant as shown in LQC / e-mail — the anchor
  notified_on             date NOT NULL,                                                         -- its Eastern civil date
  due_at                  date,                                                                  -- +30 (file request, data validation, NOPD) / +60 (Resolution Request, demands) calendar days
  policy_submit_by        date,                                                                  -- due − 2 calendar days rolled back to a business day (never the next)
  package_document_id     uuid REFERENCES documents(id),
  package_hash            text,                                                                  -- frozen before the operator escalation opens
  package_page_count      int,
  package_file_name       text,                                                                  -- FannieMaeLoanNumber_LoanFile.pdf (≤ 400 MB / 3,000 pages)
  operator_escalation_id  uuid REFERENCES escalations(id),
  submitted_at            timestamptz,                                                           -- operator-confirmed upload
  lqc_reference           text,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'package_ready', 'submitted', 'fnma_responded', 'closed')),
  outcome                 text CHECK (outcome IN ('no_defect', 'finding', 'pal', 'significant_defect', 'corrected', 'repurchased', 'alternative_remedy', 'appeal_granted', 'appeal_denied')),
  amount_cents            bigint,
  parent_case_id          uuid REFERENCES fnma_qc_cases(case_id),                                -- NOPD → resolution request → demand → appeals
  retention               retention_class NOT NULL DEFAULT 'fnma_qc_3y',
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fnma_qc_cases_one_per_task UNIQUE (lqc_task_id, case_type),
  CONSTRAINT fnma_qc_cases_submitted_has_reference CHECK (status NOT IN ('submitted', 'fnma_responded', 'closed') OR case_type IN ('relief_report', 'self_report_response') OR lqc_reference IS NOT NULL),
  CONSTRAINT fnma_qc_cases_package_before_submission CHECK (submitted_at IS NULL OR package_hash IS NOT NULL OR case_type IN ('relief_report', 'self_report_response'))
);
CREATE INDEX fnma_qc_cases_loan_idx ON fnma_qc_cases(loan_id, case_type, status);
CREATE INDEX fnma_qc_cases_due_idx ON fnma_qc_cases(due_at) WHERE status IN ('open', 'package_ready');
CREATE TRIGGER fnma_qc_cases_never_deleted BEFORE DELETE ON fnma_qc_cases FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE fnma_qc_cases IS '28.2 data model / D2-1: every Fannie Mae QC interaction as a case — file requests and data validations (30 days from notified_at, D2-1-02), missing-document notices, NOPDs (30 days, LQC job aid), Resolution Requests (60 days), demands (A2-3.2-01), the appeal ladder, relief reports and self-report responses. Portal-only: the agent builds the Form 1032 package and freezes package_hash; the fnma_portal_operator uploads and records submitted_at + lqc_reference. One case per LQC task (idempotent); children link through parent_case_id. Retention fnma_qc_3y.';

-- ───────────────────────────── qc_self_reports (D1-1-01 / A3-2-01 / A3-4-03) ─────────────────────────────
CREATE TABLE qc_self_reports (
  self_report_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                 uuid REFERENCES loans(id),
  application_id          uuid REFERENCES applications(id),
  fnma_loan_number        text,
  seller_loan_number      text,                                                                  -- 9-digit seller/servicer loan number (LQC job aid)
  borrower_last_name      text,
  note_date               date,
  report_type             text NOT NULL CHECK (report_type IN ('qc_findings', 'compliance_with_laws', 'fraud')),
  trigger                 text NOT NULL CHECK (trigger IN ('post_closing_qc', 'prefunding_survivor', 'servicing_discovery', 'fnma_inquiry', 'fraud_case')),
  confirmed_at            timestamptz NOT NULL,                                                  -- D1-1-01 anchor: the qc_officer's sustain decision (open question 6)
  due_at                  date NOT NULL,                                                         -- confirmed_at::date + 30 (qc_findings) / +60 (compliance_with_laws) calendar days
  fnma_reporting_category text CHECK (fnma_reporting_category IN ('category_1', 'category_2')),  -- A3-2-01 (compliance_with_laws only)
  synopsis                text,
  deficiencies            jsonb NOT NULL DEFAULT '[]'::jsonb,                                    -- [{category, sub_category, defect}] per fnma.qc.taxonomy.v1 / LQC drop-downs
  document_ids            uuid[] NOT NULL DEFAULT '{}',
  approved_by_officer_at  timestamptz,                                                           -- partner officer authorization
  submitted_at            timestamptz,                                                           -- operator-confirmed LQC "Save and Submit"
  lqc_reference           text,
  submission_count        smallint NOT NULL DEFAULT 0 CHECK (submission_count <= 1),             -- the form is never submitted more than once
  response_case_id        uuid REFERENCES fnma_qc_cases(case_id),
  status                  text NOT NULL DEFAULT 'required' CHECK (status IN ('required', 'drafted', 'approved', 'submitted', 'fnma_responded')),
  retention               retention_class NOT NULL DEFAULT 'fnma_qc_3y',
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qc_self_reports_submitted_after_approval CHECK (submitted_at IS NULL OR approved_by_officer_at IS NOT NULL),
  CONSTRAINT qc_self_reports_submitted_has_reference CHECK (submitted_at IS NULL OR lqc_reference IS NOT NULL)
);
CREATE INDEX qc_self_reports_loan_idx ON qc_self_reports(loan_id, report_type);
CREATE INDEX qc_self_reports_due_idx ON qc_self_reports(due_at) WHERE submitted_at IS NULL;
CREATE TRIGGER qc_self_reports_never_deleted BEFORE DELETE ON qc_self_reports FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE qc_self_reports IS '28.2 rule 7 / D1-1-01: self_report_required = eligible_as_delivered = false AND sold to Fannie Mae; confirmed_at is the qc_officer''s sustain decision, due 30 calendar days later via the LQC self-report functionality (category → sub-category → defect, synopsis, documents); A3-2-01 compliance-with-laws reports run 60 days from the Category 1 / Category 2 anchor; fraud reports (A3-4-03) are 28.4''s. One submission per loan, records kept indefinitely (fnma_qc_3y minimum).';

-- ───────────────────────────── remedy_ledger (A2-3.2-01 / -03; 27.2 settlement mechanics) ─────────────────────────────
CREATE TABLE remedy_ledger (
  remedy_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 uuid NOT NULL REFERENCES fnma_qc_cases(case_id),
  loan_id                 uuid REFERENCES loans(id),
  application_id          uuid REFERENCES applications(id),
  remedy_type             text NOT NULL CHECK (remedy_type IN ('repurchase', 'indemnification', 'make_whole', 'pal_llpa', 'pricing_adjustment', 'recourse', 'collateralized_indemnification', 'mi_stand_in', 'split_loss', 'loss_reimbursement')),
  demand_received_at      date NOT NULL,
  payment_due_at          date NOT NULL,                                                         -- demand_received_at + 60 calendar days unless an appeal suspends it
  appeal_1_due_at         date NOT NULL,                                                         -- demand_received_at + 60 calendar days
  amount_cents            bigint,
  components              jsonb,                                                                 -- {upb_cents, accrued_interest_cents, expenses_cents, llpa_excluded: true}
  appeal_status           text NOT NULL DEFAULT 'demanded' CHECK (appeal_status IN ('demanded', 'appeal_1_filed', 'appeal_1_denied', 'appeal_1_granted', 'appeal_2_filed', 'appeal_2_denied', 'appeal_2_granted', 'impasse', 'impasse_resolved', 'impasse_expired', 'management_escalation', 'management_escalation_decided', 'idr', 'paid', 'resolved')),
  appeals                 jsonb NOT NULL DEFAULT '[]'::jsonb,                                    -- [{stage, filed_on, new_information, response_expected_by, responded_on, outcome}] — at most two
  payment_timer           text NOT NULL DEFAULT 'running' CHECK (payment_timer IN ('running', 'suspended', 'paid')),
  impasse_declared_on     date,
  management_escalation_filed_on date,
  idr_initiated_on        date,
  paid_at                 timestamptz,                                                           -- partner officer's payment (never the agent)
  paid_by                 text,
  ledger_entry_id         uuid REFERENCES ledger_entry_sets(id),
  warehouse_advance_id    uuid,                                                                  -- 27.1 advance repaid on a repurchase (warehouse.advance.repaid{repaid_from=partner_repurchase})
  sm_indemnity_share_cents bigint,                                                               -- services-agreement indemnity (open question 8)
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remedy_ledger_paid_has_amount CHECK (paid_at IS NULL OR amount_cents IS NOT NULL),
  CONSTRAINT remedy_ledger_max_two_appeals CHECK (jsonb_array_length(appeals) <= 2)
);
CREATE INDEX remedy_ledger_loan_idx ON remedy_ledger(loan_id, appeal_status);
CREATE TRIGGER remedy_ledger_never_deleted BEFORE DELETE ON remedy_ledger FOR EACH ROW EXECUTE FUNCTION forbid_delete();
COMMENT ON TABLE remedy_ledger IS '28.2 rule 9 / A2-3.2-01: the partner pays a demand within 60 days of receipt unless an appeal is made (payment_timer suspended on appeal 1); repurchase price = UPB + accrued interest through the repurchase date + Fannie Mae''s property-related expenses, LLPAs excluded; PAL = the LLPA that should have been paid × UPB; the A2-3.2-03 ladder 60/60/15/60/15/30/15/30/15 lives in appeal_status and appeals (maximum two appeals — LQC FAQs). Payment reverses purchase proceeds and repays the warehouse advance (27.1/27.2).';

-- ───────────────────────────── rep_warrant_relief: 28.2 confirmation and payment-history columns (0086 created the row) ─────────────────────────────
ALTER TABLE rep_warrant_relief
  ADD COLUMN IF NOT EXISTS relief_report_id       text,                                          -- Fannie Mae relief report (Fannie Mae Connect) that listed the loan
  ADD COLUMN IF NOT EXISTS relief_basis           text CHECK (relief_basis IN ('payment_history_36', 'fnma_full_file_qc', 'du_limited_waiver', 'd1c_component', 'value_acceptance', 'cu_2_5')),
  ADD COLUMN IF NOT EXISTS payments_made          int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delinquencies_30       int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delinquencies_60_plus  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS target_36th_due_on     date,                                          -- first_payment_due + 35 months (A2-3.2-02)
  ADD COLUMN IF NOT EXISTS at_risk                boolean NOT NULL DEFAULT false,                -- delinquencies_30 ≥ 3 OR delinquencies_60_plus ≥ 1
  ADD COLUMN IF NOT EXISTS excluded_matters       text[] NOT NULL DEFAULT '{charter,misrepresentation,data_inaccuracy,title_lien,compliance_with_laws,unacceptable_products}';  -- A2-2-07 life-of-loan exclusions never lapse
COMMENT ON COLUMN rep_warrant_relief.relief_report_id IS '28.2 rule 10: status = confirmed_by_fnma is set only from a parsed Fannie Mae relief report listing the loan — never from the platform''s own 36-payment count.';

COMMIT;
