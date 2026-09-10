-- 0029: §12.9 data model — `dil_cases` (Mortgage Release: exit option, 60/90-day document clock with
-- weekly updates, inspection/title/deed evidence, lien-release clock, REOgram link) plus the two
-- §12.1 projections the spec names as tables: `lossmit_contact_attempts` (the §1024.41(b)(1)
-- reasonable-diligence contacts, a view over `contacts` with purpose lossmit_diligence) and
-- `lossmit_notices` (the §12 notice family, a view over `notices`).
BEGIN;

CREATE TABLE dil_cases (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  liquidation_case_id         uuid NOT NULL REFERENCES liquidation_cases(id),
  loan_id                     uuid NOT NULL REFERENCES loans(id),
  exit_option                 text NOT NULL CHECK (exit_option IN ('immediate', 'transition_3m', 'lease_12m')),
  acceptance_date             date NOT NULL,
  docs_deadline               date NOT NULL,                                     -- acceptance + 60 (D2-3.3-02)
  docs_extended_deadline      date,                                              -- acceptance + 90 with weekly updates
  weekly_updates              jsonb NOT NULL DEFAULT '[]',                       -- [{on, note}] every 7 days past day 60
  inspection                  jsonb,                                             -- {ordered_on, received_on, vacant, secure}
  title                       jsonb,                                             -- {ordered_on, received_on, clear_marketable, subordinate_liens}
  deed                        jsonb,                                             -- {executed_on, received_on, recorded_on, scheduled_sale_on}
  personal_property_release_doc_id uuid REFERENCES documents(id),
  lien_release_due            date,                                              -- acceptance + vacancy confirmation + 30 BD
  reogram_id                  text,
  status                      text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'documents_pending', 'deed_received', 'completed', 'cancelled')),
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dil_cases IS '§12.9 Mortgage Release case: exit option, document/weekly-update clocks, deed and lien-release evidence (D2-3.3-02, F-1-13).';
CREATE INDEX dil_cases_loan_idx ON dil_cases (loan_id, acceptance_date);

CREATE VIEW lossmit_contact_attempts AS
  SELECT id, loan_id, party_id, borrower_id, direction, mode, attempted_at, result, live_contact, qrpc, purpose
  FROM contacts WHERE purpose = 'lossmit_diligence';
COMMENT ON VIEW lossmit_contact_attempts IS '§12.1 data model: the §1024.41(b)(1) reasonable-diligence attempts — contacts logged with purpose lossmit_diligence.';

CREATE VIEW lossmit_notices AS
  SELECT id, template_code, template_version, loan_id, case_id, status, held_reason, produced_at, payload, document_id, channel_decision
  FROM notices WHERE template_code LIKE 'NTC_REGX_41%' OR template_code LIKE 'NTC_FNMA_D22%' OR template_code LIKE 'NTC_FNMA_D23%'
     OR template_code LIKE 'NTC_CA_2924_10%' OR template_code LIKE 'NTC_REGB_1002_9_LM%' OR template_code = 'NTC_FNMA_EVAL_NOTICE_STREAMLINED';
COMMENT ON VIEW lossmit_notices IS '§12.1 data model: the loss-mitigation notice family (acks, evaluation notices, appeal, plan and liquidation letters) projected from notices.';

COMMIT;
