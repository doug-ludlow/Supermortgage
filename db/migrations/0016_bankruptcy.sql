-- 0016_bankruptcy.sql — Section 14 (14.1–14.4): cases, docket events, claims, filings, ledger views, stay gates, 3002.1 notices, statements.
BEGIN;

CREATE TABLE bankruptcy_cases (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  court_id              text NOT NULL,
  case_number_full      text NOT NULL,
  chapter               smallint NOT NULL CHECK (chapter IN (7,11,12,13)),
  petition_date         date NOT NULL,
  order_for_relief_date date,
  conversion_date       date,
  converted_from_chapter smallint,
  joint_flag            boolean NOT NULL DEFAULT false,
  filer_borrower_ids    uuid[] NOT NULL DEFAULT '{}',
  non_filing_obligor_ids uuid[] NOT NULL DEFAULT '{}',
  codebtor_stay_applies boolean NOT NULL DEFAULT false,
  trustee               jsonb,
  debtor_attorney       jsonb,
  judge                 text,
  meeting_341_at        timestamptz,
  bar_date              date,
  poc_supplement_due    date,
  principal_residence   boolean,
  verification          jsonb,
  prior_cases           jsonb NOT NULL DEFAULT '[]',
  serial_filer_class    text NOT NULL DEFAULT 'none' CHECK (serial_filer_class IN ('none','one_prior_dismissed_1y','two_plus_prior_dismissed_1y','abusive_suspected')),
  stay_status           text NOT NULL DEFAULT 'pending_verification' CHECK (stay_status IN ('pending_verification','in_effect','not_in_effect_362c4','terminated_362c3','relief_granted','relief_conditional','annulled','ended_discharge','ended_dismissal','ended_closed')),
  stay_events           jsonb NOT NULL DEFAULT '[]',
  codebtor_stay_status  text,
  plan                  jsonb,
  soi                   jsonb,
  reaffirmation         jsonb,
  discharge_at          date,
  dismissal_at          date,
  closed_at             date,
  dismissal_with_prejudice boolean,
  in_rem_order          jsonb,
  referral              jsonb,
  fnma_status_code      text,
  fnma_form20_sent_at   timestamptz,
  monitor               jsonb,
  status                text NOT NULL DEFAULT 'open',
  retention             retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN bankruptcy_cases.debtor_attorney IS 'pii';
CREATE INDEX bankruptcy_cases_loan_idx ON bankruptcy_cases(loan_id);
CREATE TABLE bankruptcy_docket_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES bankruptcy_cases(case_id),
  source                text NOT NULL CHECK (source IN ('ebn','pcl','vendor','attorney','mail','dra','contact')),
  docket_no             text,
  event_type            text NOT NULL,
  event_date            date NOT NULL,
  entered_at            timestamptz NOT NULL DEFAULT now(),
  document_id           uuid REFERENCES documents(id),
  parsed                jsonb,
  classifier_confidence numeric(4,3),
  verified_by           text,
  applied_at            timestamptz
);
CREATE TRIGGER bankruptcy_docket_events_immutable BEFORE DELETE ON bankruptcy_docket_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE bankruptcy_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES bankruptcy_cases(case_id),
  claim_no              text,
  version               int NOT NULL DEFAULT 1,
  filed_at              timestamptz,
  filed_by              text,
  status                text NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','package_ready','escalated','signed','filed','supplement_due','supplement_filed','objected','allowed','disallowed','withdrawn','transferred')),
  as_of_date            date NOT NULL,
  part2                 jsonb NOT NULL,
  part3                 jsonb NOT NULL,
  part4                 jsonb NOT NULL,
  part5_history_document_id uuid REFERENCES documents(id),
  escrow_statement_document_id uuid REFERENCES documents(id),
  writing_documents     jsonb,
  perfection_evidence_document_id uuid REFERENCES documents(id),
  claim_document_id     uuid REFERENCES documents(id),
  objection             jsonb,
  allowed_amounts       jsonb,
  UNIQUE (case_id, version)
);
CREATE TABLE bankruptcy_filings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES bankruptcy_cases(case_id),
  filing_type           text NOT NULL CHECK (filing_type IN ('noa','poc','poc_amendment','poc_supplement_120','s1_payment_change','s2_fee_notice','m1r_status_response','nr_final_cure_response','m2r_motion_response','mfr','mfr_declaration','objection_confirmation','objection_plan_modification','response_claim_objection','adequate_protection_motion','sequestration_motion','motion_to_dismiss','agreed_order','reaffirmation','transfer_of_claim','withdrawal','form20_package','notice_of_transfer_e2_1_05')),
  official_form         text,
  template_version      text,
  status                text NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting','package_ready','escalated_attorney','escalated_signing','signed','submitted_to_counsel','filed','served','docketed','rejected','withdrawn','superseded')),
  signed_by             text,
  signature_document_id uuid REFERENCES documents(id),
  filed_at              timestamptz,
  docket_no             text,
  served_at             timestamptz,
  service_method        text CHECK (service_method IN ('cm_ecf','mail','email_consent')),
  served_parties        jsonb,
  certificate_of_service_document_id uuid REFERENCES documents(id),
  deadline_timer_id     uuid REFERENCES timers(id),
  evidence_bundle_id    uuid,
  retention             retention_class NOT NULL DEFAULT 'corporate_7y',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bankruptcy_ledger_views (
  case_id               uuid PRIMARY KEY REFERENCES bankruptcy_cases(case_id),
  prepetition_arrearage_claim_cents bigint NOT NULL DEFAULT 0,
  prepetition_receipts_cents bigint NOT NULL DEFAULT 0,
  prepetition_balance_cents bigint NOT NULL DEFAULT 0,
  postpetition_installments jsonb NOT NULL DEFAULT '[]',
  postpetition_suspense_cents bigint NOT NULL DEFAULT 0,
  postpetition_fees_memo jsonb NOT NULL DEFAULT '[]',
  postpetition_days_delinquent int NOT NULL DEFAULT 0,
  postpetition_fnma_bucket text,
  views                 jsonb NOT NULL DEFAULT '{}',
  cramdown              jsonb,
  computed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stay_gates (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  case_id               uuid REFERENCES bankruptcy_cases(case_id),
  collections_blocked   boolean NOT NULL DEFAULT false,
  foreclosure_blocked   boolean NOT NULL DEFAULT false,
  late_charges_blocked  boolean NOT NULL DEFAULT false,
  nsf_fees_blocked      boolean NOT NULL DEFAULT false,
  autodraft_paused      boolean NOT NULL DEFAULT false,
  credit_reporting_overlay text,
  statement_mode        text,
  early_intervention_mode text NOT NULL DEFAULT 'normal' CHECK (early_intervention_mode IN ('normal','bk_modified_once','exempt')),
  contact_route         text NOT NULL DEFAULT 'borrower' CHECK (contact_route IN ('borrower','counsel_only','counsel_and_borrower_informational')),
  payoff_mode           text NOT NULL DEFAULT 'standard' CHECK (payoff_mode IN ('standard','reasonable_time_bk')),
  escrow_mode           text NOT NULL DEFAULT 'standard' CHECK (escrow_mode IN ('standard','postpetition_ch13')),
  codebtor_ids_protected uuid[] NOT NULL DEFAULT '{}',
  reason_codes          text[] NOT NULL DEFAULT '{}',
  computed_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE jurisdiction_rules ADD COLUMN IF NOT EXISTS bankruptcy jsonb;
CREATE TABLE court_calendars (
  court_id              text NOT NULL,
  holiday               date NOT NULL,
  name                  text,
  PRIMARY KEY (court_id, holiday)
);

-- 14.2
CREATE TABLE bk_payment_change_notices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES bankruptcy_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  claim_no              text,
  source                text,
  change_kind           text NOT NULL CHECK (change_kind IN ('increase','decrease')),
  old_total_cents       bigint NOT NULL,
  new_total_cents       bigint NOT NULL,
  pi_old_cents          bigint,
  pi_new_cents          bigint,
  escrow_old_cents      bigint,
  escrow_new_cents      bigint,
  rate_old              numeric(7,5),
  rate_new              numeric(7,5),
  effective_due_date    date NOT NULL,
  deadline_file_serve   date NOT NULL,
  target_file_date      date,
  filing_id             uuid REFERENCES bankruptcy_filings(id),
  filed_at              timestamptz,
  served_at             timestamptz,
  service               jsonb,
  timely                boolean,
  effective_date_applied date,
  objection             jsonb,
  attachments           jsonb,
  fnma_fee_claimable    boolean,
  status                text NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','package_ready','escalated','signed','filed_served','effective','objected','determined','superseded','withdrawn'))
);
CREATE TABLE bk_postpetition_fee_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES bankruptcy_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  fee_id                uuid REFERENCES fees(id),
  line_no               smallint CHECK (line_no BETWEEN 1 AND 14),
  description           text NOT NULL,
  incurred_on           date NOT NULL,
  amount_cents          bigint NOT NULL,
  recoverable_basis     text,
  fnma_reimbursed       boolean NOT NULL DEFAULT false,
  notice_deadline       date NOT NULL,
  notice_filing_id      uuid REFERENCES bankruptcy_filings(id),
  noticed_at            timestamptz,
  challenge_deadline    date,
  status                text NOT NULL DEFAULT 'incurred' CHECK (status IN ('incurred','batched','noticed','challenged','determined_allowed','determined_disallowed','allowed_by_lapse','precluded_not_noticed','waived','collected'))
);
CREATE TABLE bk_status_responses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES bankruptcy_cases(case_id),
  kind                  text NOT NULL CHECK (kind IN ('m1r','nr','m2r')),
  trigger_docket_event_id uuid REFERENCES bankruptcy_docket_events(id),
  served_on             date NOT NULL,
  service_method        text,
  response_deadline     date NOT NULL,
  computation           jsonb,
  agree_with_trustee    boolean,
  filing_id             uuid REFERENCES bankruptcy_filings(id),
  status                text NOT NULL DEFAULT 'open'
);

-- 14.3
CREATE TABLE bk_statement_status (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  case_id               uuid REFERENCES bankruptcy_cases(case_id),
  mode                  text NOT NULL CHECK (mode IN ('standard','modified_ch7_11','modified_ch12_13','exempt_cease_request','exempt_plan_surrender','exempt_court_order','exempt_soi_surrender','exempt_charged_off_n_a','single_statement_skip')),
  basis_document_id     uuid REFERENCES documents(id),
  basis_event_id        uuid,
  exclusive_address_used boolean,
  last_request          jsonb,
  addressing            text CHECK (addressing IN ('debtor','counsel','counsel_and_debtor','trustee_copy')),
  addressing_basis      text,
  single_statement_used_for_cycle date,
  resume_from_cycle     date,
  debt_discharged       boolean NOT NULL DEFAULT false,
  reaffirmed            boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bk_early_intervention (
  case_id               uuid PRIMARY KEY REFERENCES bankruptcy_cases(case_id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  required              boolean NOT NULL,
  deadline              date,
  sent_at               timestamptz,
  recipient             text CHECK (recipient IN ('borrower','counsel')),
  notice_id             uuid REFERENCES notices(id),
  once_per_case_satisfied boolean NOT NULL DEFAULT false
);
CREATE TABLE communications_matrix (
  version               text NOT NULL,
  communication_code    text NOT NULL,
  mode                  text NOT NULL CHECK (mode IN ('stay_in_effect','stay_relief_granted','discharged_no_reaffirm','dismissed','codebtor_protected')),
  action                text NOT NULL CHECK (action IN ('send','send_modified','send_via_counsel','suppress')),
  legend_required       boolean NOT NULL DEFAULT false,
  citation              text,
  PRIMARY KEY (version, communication_code, mode)
);
-- 14.4: bankruptcy_reporting_state (8.3) additions
ALTER TABLE bankruptcy_reporting_state
  ADD COLUMN IF NOT EXISTS reaffirmation_final boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS postpetition_days_delinquent int,
  ADD COLUMN IF NOT EXISTS cramdown jsonb,
  ADD COLUMN IF NOT EXISTS evidence_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS case_id uuid REFERENCES bankruptcy_cases(case_id);

COMMIT;
