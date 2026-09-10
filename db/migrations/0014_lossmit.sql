-- 0014_lossmit.sql — Section 12 (12.1–12.9): applications, requirements, evaluations, offers, appeals, plans, deferrals, modifications, liquidations; foreclosure_holds (owned by 12.1, vocabulary from 13.2).
BEGIN;

CREATE TABLE lossmit_requirement_catalog (
  code                  text NOT NULL,
  rule_set              text NOT NULL,
  applies_to_options    text[] NOT NULL DEFAULT '{}',
  source                text NOT NULL CHECK (source IN ('borrower','servicer_file','third_party')),
  staleness_days        int NOT NULL DEFAULT 90,
  fnma_citation         text,
  description           text,
  PRIMARY KEY (code, rule_set)
);
CREATE TABLE lossmit_applications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  rule_set              text NOT NULL DEFAULT 'regx.lossmit.2013',
  received_at           timestamptz NOT NULL,
  received_date         date NOT NULL,
  receipt_channel       text,
  submitted_by_party_id uuid REFERENCES parties(id),
  is_potential_successor boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'received',
  foreclosure_sale_date_at_receipt date,
  first_filing_made_at_receipt boolean NOT NULL DEFAULT false,
  protection_tier       text CHECK (protection_tier IN ('ge_90','gt_37','le_37','none')),
  facially_complete_at  timestamptz,
  complete_at           timestamptz,
  deemed_complete_date  date,
  reasonable_date       date,
  reasonable_date_basis jsonb,
  ack_sent_on           date,
  duplicative_of_application_id uuid REFERENCES lossmit_applications(id),
  duplicative_determination jsonb,
  transferor_received_date date,
  closed_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lossmit_requirements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES lossmit_applications(id),
  catalog_code          text NOT NULL,
  borrower_id           uuid REFERENCES borrowers(id),
  status                text NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','requested','received','verified','stale','waived','not_required','third_party_pending')),
  requested_at          timestamptz[] NOT NULL DEFAULT '{}',
  received_at           timestamptz,
  document_id           uuid REFERENCES documents(id),
  stale_after           date,
  waived_reason         text,
  extraction            jsonb,
  verification          jsonb
);
COMMENT ON COLUMN lossmit_requirements.extraction IS 'pii';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_class text;

-- foreclosure_holds — owned by 12.1; kind vocabulary per 13.2
CREATE TABLE foreclosure_holds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  source_case_id        uuid REFERENCES cases(id),
  kind                  text NOT NULL,
  scope                 text[] NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opened_by_event_id    uuid,
  expires_at            timestamptz,
  closed_at             timestamptz,
  closed_by_event_id    uuid,
  close_reason          text,
  rule_citation         text NOT NULL,
  attorney_instruction_id uuid,
  decision_id           uuid REFERENCES agent_decisions(id),
  CONSTRAINT foreclosure_holds_kind_chk CHECK (
    kind IN ('regx_f2_prefiling','regx_g_dual_track','lm_review_cycle','lm_offer_pending','lm_appeal_pending','lm_third_party_pending','fnma_e3401_evaluation','fnma_e3401_offer_window','fnma_e3401_appeal','fnma_trial_performing','fnma_plan_performing','fnma_shortsale_marketing_45','fnma_shortsale_review_15','fnma_shortsale_close_60','fnma_dil_accepted_60','fnma_maf_7','bk_stay','scra_3953','disaster_approval','litigation','environmental','title','transfer_k2')
    OR kind ~ '^state_dual_track:[A-Z]{2}$'),
  CONSTRAINT foreclosure_holds_scope_chk CHECK (scope <@ ARRAY['refer','first_notice','judgment_motion','sale_schedule','sale_conduct','eviction']::text[])
);
CREATE INDEX foreclosure_holds_open_idx ON foreclosure_holds(loan_id) WHERE closed_at IS NULL;
-- append-only close: only closed_* / close_reason may change
CREATE OR REPLACE FUNCTION foreclosure_holds_close_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'foreclosure_holds row already closed'; END IF;
  IF NEW.kind <> OLD.kind OR NEW.scope <> OLD.scope OR NEW.opened_at <> OLD.opened_at OR NEW.loan_id <> OLD.loan_id THEN RAISE EXCEPTION 'foreclosure_holds is append-only except for close'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER foreclosure_holds_close_only BEFORE UPDATE ON foreclosure_holds FOR EACH ROW EXECUTE FUNCTION foreclosure_holds_close_only();
CREATE TRIGGER foreclosure_holds_no_delete BEFORE DELETE ON foreclosure_holds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 12.2
CREATE TABLE smdu_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_type             text NOT NULL,
  submitted_at          timestamptz,
  payload_hash          text NOT NULL,
  fnma_case_id          text,
  status                text NOT NULL DEFAULT 'prepared',
  decision              jsonb,
  letters               uuid[] NOT NULL DEFAULT '{}',
  errors                jsonb NOT NULL DEFAULT '[]',
  imminent_default_indicator boolean,
  hardship_reason       text,
  hardship_start_date   date,
  idempotency_key       text NOT NULL UNIQUE
);
CREATE TABLE lossmit_evaluations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid REFERENCES lossmit_applications(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  basis                 text NOT NULL CHECK (basis IN ('complete_application','incomplete_c2ii','short_term_c2iii','servicer_initiated_c2i1','imminent_default')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  complete_date_for_c   date,
  due_at                date,
  hierarchy_version     text NOT NULL,
  inputs                jsonb NOT NULL DEFAULT '{}',
  smdu_case_ids         uuid[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'open',
  decided_at            timestamptz,
  evaluator_run_id      uuid,
  reviewer_id           text,
  reviewer_decision     text,
  reviewer_at           timestamptz,
  notice_id             uuid REFERENCES notices(id),
  provided_at           date
);
COMMENT ON COLUMN lossmit_evaluations.inputs IS 'pii';
CREATE TABLE lossmit_option_determinations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id         uuid NOT NULL REFERENCES lossmit_evaluations(id),
  option_code           text NOT NULL CHECK (option_code IN ('reinstatement','forbearance','repayment_plan','payment_deferral','disaster_payment_deferral','flex_mod','short_sale','mortgage_release','military_indulgence','qma')),
  hierarchy_rank        int NOT NULL,
  result                text NOT NULL CHECK (result IN ('offered','denied','not_evaluated_ranking','not_evaluated_ineligible_by_loan_data','pending_third_party','referred_to_fnma')),
  reason_codes          text[] NOT NULL DEFAULT '{}',
  investor_name         text NOT NULL DEFAULT 'Fannie Mae',
  investor_requirement_text text,
  npv_inputs            jsonb,
  terms                 jsonb,
  smdu_decision_id      text,
  rep_warrant_relief    boolean
);
CREATE TABLE lossmit_offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id         uuid NOT NULL REFERENCES lossmit_evaluations(id),
  option_code           text NOT NULL,
  origin                text NOT NULL DEFAULT 'evaluation' CHECK (origin IN ('evaluation','appeal')),
  terms                 jsonb NOT NULL,
  provided_at           date NOT NULL,
  accept_by             date NOT NULL,
  accept_by_basis       text NOT NULL CHECK (accept_by_basis IN ('regx_14','regx_7','ny_30','fnma_14','policy','e2iii_extension')),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','deemed_rejected','expired_reasonable_period','superseded_by_appeal','withdrawn')),
  accepted_via          text CHECK (accepted_via IN ('verbal','written','payment','portal')),
  accepted_at           timestamptz,
  grace_until           date
);

-- 12.3
CREATE TABLE lossmit_appeals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES lossmit_applications(id),
  evaluation_id         uuid NOT NULL REFERENCES lossmit_evaluations(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  denial_notice_id      uuid REFERENCES notices(id),
  appeal_window_ends    date NOT NULL,
  received_at           timestamptz NOT NULL,
  received_date         date NOT NULL,
  channel               text,
  written_confirmation_document_id uuid REFERENCES documents(id),
  eligible              boolean,
  ineligibility_reason  text CHECK (ineligibility_reason IN ('tier_lt_90_after_filing','non_modification_option','late','duplicative_prior_complete','not_principal_residence_fnma')),
  new_information       boolean NOT NULL DEFAULT false,
  new_information_doc_ids uuid[] NOT NULL DEFAULT '{}',
  reviewer_id           text,
  reviewer_independence_check jsonb,
  ai_reeval_run_id      uuid,
  decision              text CHECK (decision IN ('granted_new_offer','granted_original_offer_reinstated','denied')),
  decided_at            timestamptz,
  notice_id             uuid REFERENCES notices(id),
  provided_at           date,
  accept_by             date,
  tpp_first_due         date,
  status                text NOT NULL DEFAULT 'received'
);

-- 12.4 / 12.5 workout plans
CREATE TABLE fnma_exception_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL,
  package_document_id   uuid REFERENCES documents(id),
  submitted_at          timestamptz,
  channel               text,
  decision              text,
  decided_at            timestamptz,
  evidence_document_id  uuid REFERENCES documents(id)
);
CREATE TABLE workout_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  plan_type             text NOT NULL CHECK (plan_type IN ('forbearance','repayment')),
  basis                 text,
  hardship_code         text,
  disaster_event_id     uuid,
  qrpc_contact_id       uuid REFERENCES contacts(id),
  start_date            date NOT NULL,
  current_term_end      date,
  cumulative_months     int NOT NULL DEFAULT 0,
  initial_start_date    date,
  delinquency_months_at_start int,
  projected_delinquency_at_end int,
  payment_mode          text CHECK (payment_mode IN ('suspended','reduced')),
  reduced_amount_cents  bigint,
  arrears_at_start_cents bigint,
  late_charges_included_cents bigint,
  term_months           int,
  installment_cents     bigint,
  contractual_payment_cents bigint,
  payment_cap_cents     bigint,
  cure_date             date,
  brp_required          boolean,
  brp_application_id    uuid REFERENCES lossmit_applications(id),
  fnma_approval_id      uuid REFERENCES fnma_exception_requests(id),
  regx_short_term       boolean,
  regx_basis            text,
  regx_terms_notice_id  uuid REFERENCES notices(id),
  status                text NOT NULL DEFAULT 'offered',
  exception_request_id  uuid REFERENCES fnma_exception_requests(id),
  evaluation_notice_id  uuid REFERENCES notices(id),
  smdu_case_id          uuid REFERENCES smdu_cases(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workout_plan_terms (
  plan_id               uuid NOT NULL REFERENCES workout_plans(id),
  term_no               int NOT NULL,
  term_start            date NOT NULL,
  term_end              date NOT NULL,
  months                int NOT NULL CHECK (months <= 3),
  approved_by           text NOT NULL,
  notice_id             uuid REFERENCES notices(id),
  PRIMARY KEY (plan_id, term_no)
);
CREATE TABLE workout_plan_schedule (
  plan_id               uuid NOT NULL REFERENCES workout_plans(id),
  due_date              date NOT NULL,
  expected_amount_cents bigint NOT NULL DEFAULT 0,
  contractual_cents     bigint,
  installment_cents     bigint,
  expected_total_cents  bigint,
  received_amount_cents bigint NOT NULL DEFAULT 0,
  received_at           timestamptz,
  status                text NOT NULL DEFAULT 'due' CHECK (status IN ('due','met','missed','excused')),
  estimate_flags        jsonb,
  PRIMARY KEY (plan_id, due_date)
);
ALTER TABLE fees ADD COLUMN IF NOT EXISTS suppressed_by_case_id uuid REFERENCES cases(id);

-- 12.6 / 12.7 deferrals
CREATE TABLE payment_deferrals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  kind                  text NOT NULL CHECK (kind IN ('standard','disaster')),
  basis                 text,
  evaluation_date       date NOT NULL,
  delinquency_months_at_eval int NOT NULL,
  months_deferred       int NOT NULL CHECK (months_deferred BETWEEN 1 AND 12),
  deferred_pi_cents     bigint NOT NULL,
  deferred_escrow_adv_cents bigint NOT NULL DEFAULT 0,
  deferred_servicing_adv_cents bigint NOT NULL DEFAULT 0,
  nib_total_cents       bigint NOT NULL,
  cumulative_months_after int NOT NULL,
  cumulative_disaster_months int NOT NULL DEFAULT 0,
  prior_deferral_effective_dates date[] NOT NULL DEFAULT '{}',
  effective_date        date NOT NULL,
  processing_month      boolean NOT NULL DEFAULT false,
  contractual_payment_required boolean NOT NULL DEFAULT true,
  contractual_payment_received_at timestamptz,
  escrow_analysis_id    uuid REFERENCES escrow_analyses(id),
  escrow_shortage_cents bigint,
  shortage_monthly_cents bigint,
  late_charges_waived_cents bigint NOT NULL DEFAULT 0,
  disaster_event_id     uuid,
  disaster_basis        text,
  delinquency_months_at_disaster int,
  fnma_prior_approval_id uuid REFERENCES fnma_exception_requests(id),
  same_event_prior_deferral_check boolean,
  smdu_case_id          uuid REFERENCES smdu_cases(id),
  campaign_id           text,
  smdu_entered_at       timestamptz,
  agreement_document_id uuid REFERENCES documents(id),
  agreement_sent_at     timestamptz,
  agreement_executed_at timestamptz,
  recording_required    boolean NOT NULL DEFAULT false,
  recorded_at           timestamptz,
  custodian_delivered_at timestamptz,
  incentive_claim_id    uuid,
  status                text NOT NULL DEFAULT 'evaluated',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE loan_terms ADD COLUMN IF NOT EXISTS deferred_principal_nib_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE loan_terms ADD COLUMN IF NOT EXISTS forborne_principal_nib_cents bigint NOT NULL DEFAULT 0;

-- 12.8 modifications
CREATE TABLE modifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  program               text NOT NULL DEFAULT 'flex_mod',
  basis                 text,
  evaluation_date       date NOT NULL,
  delinquency_days_at_eval int,
  imminent_default      boolean NOT NULL DEFAULT false,
  disaster              boolean NOT NULL DEFAULT false,
  valuation             jsonb,
  mod_interest_rate_version text,
  waterfall_inputs      jsonb NOT NULL,
  waterfall_steps       jsonb NOT NULL,
  target_pi_cents       bigint,
  pre_mod_pi_cents      bigint NOT NULL,
  terms                 jsonb NOT NULL,
  exhaustion_offer      boolean NOT NULL DEFAULT false,
  trial_months          smallint CHECK (trial_months IN (3,4)),
  trial_plan_id         uuid,
  smdu_tpp_case_id      uuid REFERENCES smdu_cases(id),
  smdu_close_case_id    uuid REFERENCES smdu_cases(id),
  mbs                   boolean NOT NULL DEFAULT false,
  reclassified_at       timestamptz,
  form_3179_document_id uuid REFERENCES documents(id),
  form_3179_sent_at     timestamptz,
  borrower_executed_at  timestamptz,
  servicer_executed_at  timestamptz,
  officer_signature_date date,
  recording_required    boolean NOT NULL DEFAULT false,
  recorded_at           timestamptz,
  custodian_delivered_at timestamptz,
  incentive_claim_id    uuid,
  effective_event_id    uuid UNIQUE,
  completed_at          timestamptz,
  completed_event_id    uuid UNIQUE,
  status                text NOT NULL DEFAULT 'evaluating' CHECK (status IN ('evaluating','tpp_offered','tpp_active','tpp_failed','pending_execution','effective','completed','cancelled')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trial_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modification_id       uuid NOT NULL REFERENCES modifications(id),
  months                smallint NOT NULL,
  first_due_date        date NOT NULL,
  trial_pi_cents        bigint NOT NULL,
  trial_escrow_cents    bigint NOT NULL DEFAULT 0,
  trial_total_cents     bigint NOT NULL,
  status                text NOT NULL DEFAULT 'offered'
);
ALTER TABLE modifications ADD CONSTRAINT modifications_trial_plan_fk FOREIGN KEY (trial_plan_id) REFERENCES trial_plans(id);
CREATE TABLE trial_plan_schedule (
  trial_plan_id         uuid NOT NULL REFERENCES trial_plans(id),
  due_date              date NOT NULL,
  amount_cents          bigint NOT NULL,
  received_cents        bigint NOT NULL DEFAULT 0,
  received_at           timestamptz,
  status                text NOT NULL DEFAULT 'due' CHECK (status IN ('due','met','missed')),
  PRIMARY KEY (trial_plan_id, due_date)
);

-- 12.9 liquidations
CREATE TABLE liquidation_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               uuid REFERENCES cases(id),
  kind                  text NOT NULL CHECK (kind IN ('shortsale','dil')),
  basis                 text,
  delinquency_tier      text CHECK (delinquency_tier IN ('lt_90','d90_18m','gt_18m','ch7_discharge')),
  brp_required          boolean NOT NULL DEFAULT true,
  brp_application_id    uuid REFERENCES lossmit_applications(id),
  hardship_code         text,
  new_mortgage_check    jsonb,
  imminent_default      boolean NOT NULL DEFAULT false,
  valuation             jsonb,
  housing_ratio         numeric(7,4),
  nonretirement_reserves_cents bigint,
  contribution          jsonb,
  relocation            jsonb,
  subordinate_liens     jsonb NOT NULL DEFAULT '[]',
  mi                    jsonb,
  fnma_case             jsonb,
  -- DIL extension
  exit_option           text CHECK (exit_option IN ('immediate','transition_3m','lease_12m')),
  acceptance_date       date,
  docs_deadline         date,
  weekly_updates        jsonb NOT NULL DEFAULT '[]',
  inspection            jsonb,
  title                 jsonb,
  deed                  jsonb,
  personal_property_release_doc_id uuid REFERENCES documents(id),
  lien_release_due      date,
  reogram_id            uuid,
  status                text NOT NULL DEFAULT 'open',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shortsale_offers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES liquidation_cases(id),
  received_at           timestamptz NOT NULL,
  acknowledged_at       timestamptz,
  offer_price_cents     bigint NOT NULL,
  buyer                 jsonb,
  agent                 jsonb,
  net_proceeds_cents    bigint,
  allowable_costs       jsonb,
  decision              text CHECK (decision IN ('approved','countered','declined')),
  decided_at            timestamptz,
  revised               boolean NOT NULL DEFAULT false,
  closing_deadline      date,
  extension_id          uuid
);
COMMENT ON COLUMN shortsale_offers.buyer IS 'pii';
CREATE TABLE shortsale_closings (
  case_id               uuid PRIMARY KEY REFERENCES liquidation_cases(id),
  settlement_statement_doc_id uuid REFERENCES documents(id),
  reviewed_at           timestamptz,
  review_findings       jsonb,
  proceeds_cents        bigint,
  received_at           timestamptz,
  remitted_at           timestamptz,
  affidavit_form191_doc_id uuid REFERENCES documents(id),
  deficiency_waiver_doc_id uuid REFERENCES documents(id),
  deed_restriction_confirmed boolean NOT NULL DEFAULT false
);

COMMIT;
