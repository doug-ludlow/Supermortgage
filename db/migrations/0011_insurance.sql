-- 0011_insurance.sql — Section 9 (9.1–9.9): policies, evidence, requirements, deficiencies, FPI, refunds, flood, claims, inspections, preservation.
BEGIN;

CREATE TABLE insurance_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  property_id           uuid REFERENCES properties(id),
  policy_kind           text NOT NULL CHECK (policy_kind IN ('hazard','wind','hail','flood','earthquake','unit_owner','master_condo','master_pud','master_coop','rcbap','lpi_hazard','lpi_wind','lpi_flood','other')),
  carrier_party_id      uuid REFERENCES parties(id),
  agent_party_id        uuid REFERENCES parties(id),
  policy_number_enc     bytea,
  named_insureds        jsonb NOT NULL DEFAULT '[]',
  effective_date        date,
  expiration_date       date,
  coverage_dwelling_cents bigint,
  coverage_basis        text CHECK (coverage_basis IN ('replacement_cost','extended_rc','guaranteed_rc','acv','unknown')),
  roof_basis            text CHECK (roof_basis IN ('rc','acv','unknown')),
  deductible_cents      bigint,
  deductible_pct        numeric(6,4),
  peril_deductibles     jsonb NOT NULL DEFAULT '[]',
  coverage_form         text CHECK (coverage_form IN ('special','broad','basic','named_peril','unknown')),
  excluded_perils       text[] NOT NULL DEFAULT '{}',
  premium_cents         bigint,
  premium_frequency     text,
  mortgagee_clause_text text,
  mortgagee_clause_status text CHECK (mortgagee_clause_status IN ('valid','invalid','missing','unknown')),
  cancellation_notice_days int,
  carrier_rating        jsonb,
  status                text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','verified','deficient','expiring','expired','cancelled','nonrenewed','replaced','superseded')),
  source                text CHECK (source IN ('boarding','vendor_feed','eoi_document','carrier_api','borrower_portal','mail','agent_call')),
  evidence_document_id  uuid REFERENCES documents(id),
  verified_at           timestamptz,
  verified_by_run_id    uuid,
  last_known_coverage_cents bigint,
  -- flood fields (9.6)
  nfip                  boolean,
  private_flood_compliance_aid boolean,
  b7_elements           jsonb,
  building_coverage_cents bigint,
  contents_coverage_cents bigint,
  nfip_deductible_cents bigint,
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN insurance_policies.policy_number_enc IS 'pii';
COMMENT ON COLUMN insurance_policies.named_insureds IS 'pii';
CREATE TABLE insurance_policy_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id             uuid NOT NULL REFERENCES insurance_policies(id),
  version               int NOT NULL,
  snapshot              jsonb NOT NULL,
  changed_by            text NOT NULL,
  at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version)
);
CREATE TRIGGER insurance_policy_versions_immutable BEFORE UPDATE OR DELETE ON insurance_policy_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE insurance_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  policy_id             uuid REFERENCES insurance_policies(id),
  document_id           uuid REFERENCES documents(id),
  received_at           timestamptz NOT NULL,
  channel               text,
  written               boolean NOT NULL DEFAULT true,
  extraction_json       jsonb,
  extraction_model_version text,
  verification_status   text NOT NULL DEFAULT 'received' CHECK (verification_status IN ('received','extracted','needs_carrier_confirmation','confirmed','rejected','superseded')),
  reject_reason         text CHECK (reject_reason IN ('not_confirmed_by_carrier_or_agent','terms_noncompliant','illegible','wrong_property','expired_term')),
  confirmed_via         text CHECK (confirmed_via IN ('vendor','carrier_api','agent_call','borrower_portal_link')),
  sufficiency_result    jsonb
);
CREATE TABLE insurance_requirements (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  hazard_required       boolean NOT NULL DEFAULT true,
  wind_separate_required boolean NOT NULL DEFAULT false,
  flood_required        boolean NOT NULL DEFAULT false,
  unit_policy_required  boolean NOT NULL DEFAULT false,
  master_policy_required boolean NOT NULL DEFAULT false,
  required_deductible_max_pct numeric(6,4) NOT NULL DEFAULT 5.0000,
  required_perils       text[] NOT NULL DEFAULT '{}',
  basis_required        text NOT NULL DEFAULT 'replacement_cost',
  rule_set              text NOT NULL DEFAULT 'fnma.insurance.2026-08',
  computed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE insurance_deficiencies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  policy_id             uuid REFERENCES insurance_policies(id),
  kind                  text NOT NULL CHECK (kind IN ('expired','cancelled','nonrenewed','insufficient_coverage','acv_dwelling','deductible_excess','perils_gap','rating_fail','mortgagee_clause','named_insured','flood_none','flood_insufficient','master_lapse','unit_policy_missing','coverage_decrease_unconfirmed')),
  detected_at           timestamptz NOT NULL DEFAULT now(),
  basis_evidence        jsonb,
  regx_reasonable_basis boolean NOT NULL DEFAULT false,
  k5_status             text NOT NULL DEFAULT 'n/a' CHECK (k5_status IN ('n/a','advance_required','inability_documented')),
  notice_id             uuid REFERENCES notices(id),
  fpi_case_id           uuid,
  resolved_at           timestamptz,
  resolution            text CHECK (resolution IN ('evidence_received','lpi_placed','waived_by_policy','paid_off','transferred','reo'))
);
ALTER TABLE jurisdiction_rules
  ADD COLUMN IF NOT EXISTS hazard_amount_cap_rule jsonb,
  ADD COLUMN IF NOT EXISTS lpi_state_regulation jsonb,
  ADD COLUMN IF NOT EXISTS lpi_prompt_charge_prohibited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS interior_entry_allowed_prefc boolean,
  ADD COLUMN IF NOT EXISTS vacant_property_registration jsonb;

-- 9.2–9.5 force-placed
CREATE TABLE fpi_cases (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  deficiency_id         uuid REFERENCES insurance_deficiencies(id),
  insurance_type        text NOT NULL CHECK (insurance_type IN ('hazard','wind','hail','flood')),
  track                 text NOT NULL CHECK (track IN ('regx_hazard','fdpa_flood')),
  escrowed              boolean NOT NULL,
  k5_gate               text NOT NULL DEFAULT 'n/a' CHECK (k5_gate IN ('n/a','blocked_advance','open_inability')),
  basis_summary         text,
  first_notice_id       uuid REFERENCES notices(id),
  first_notice_mailed_at date,
  reminder_notice_id    uuid REFERENCES notices(id),
  reminder_mailed_at    date,
  reminder_production_at timestamptz,
  reminder_variant      text CHECK (reminder_variant IN ('b_no_info','c_insufficient')),
  unverified_ranges     jsonb,
  evidence_window_end   date,
  earliest_charge_date  date,
  lapse_start           date,
  lpi_placement_id      uuid,
  annual_premium_cents  bigint,
  premium_is_estimate   boolean,
  estimate_basis        text,
  renewal_cycle         int NOT NULL DEFAULT 0,
  flood_notice_mailed_at date,
  flood_earliest_placement_date date,
  flood_required_amount_cents bigint,
  flood_lpi_effective   date,
  status                text NOT NULL DEFAULT 'open',
  closed_reason         text
);
ALTER TABLE insurance_deficiencies ADD CONSTRAINT insurance_deficiencies_fpi_fk FOREIGN KEY (fpi_case_id) REFERENCES fpi_cases(case_id);
CREATE TABLE lpi_placements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fpi_case_id           uuid NOT NULL REFERENCES fpi_cases(case_id),
  lpi_policy_id         uuid REFERENCES insurance_policies(id),
  carrier_party_id      uuid REFERENCES parties(id),
  coverage_amount_cents bigint NOT NULL,
  coverage_method       text NOT NULL CHECK (coverage_method IN ('last_known','rcv_estimate','upb_cap','state_cap')),
  deductible_cents      bigint NOT NULL,
  effective_date        date NOT NULL,
  expiration_date       date NOT NULL,
  premium_cents         bigint NOT NULL,
  premium_is_estimate   boolean NOT NULL DEFAULT false,
  bound_at              timestamptz,
  vendor_ref            text,
  previous_placement_id uuid REFERENCES lpi_placements(id),
  cancelled_at          timestamptz,
  cancellation_effective date,
  refund_cents          bigint,
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','bound','billed','charged','cancel_requested','cancelled','refunded'))
);
ALTER TABLE fpi_cases ADD CONSTRAINT fpi_cases_placement_fk FOREIGN KEY (lpi_placement_id) REFERENCES lpi_placements(id);
CREATE TABLE lpi_charges (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fpi_case_id           uuid NOT NULL REFERENCES fpi_cases(case_id),
  placement_id          uuid NOT NULL REFERENCES lpi_placements(id),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  amount_cents          bigint NOT NULL,
  assessed_at           timestamptz NOT NULL DEFAULT now(),
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  reversal_entry_set_id uuid REFERENCES ledger_entry_sets(id),
  disbursement_id       uuid REFERENCES disbursements(id),
  borrower_paid_cents   bigint NOT NULL DEFAULT 0
);
CREATE TABLE fpi_renewals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fpi_case_id           uuid NOT NULL REFERENCES fpi_cases(case_id),
  placement_id          uuid REFERENCES lpi_placements(id),
  anniversary_date      date NOT NULL,
  notice_id             uuid REFERENCES notices(id),
  notice_mailed_at      date,
  earliest_renewal_charge_date date,
  quoted_premium_cents  bigint,
  premium_is_estimate   boolean,
  status                text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','notice_sent','chargeable','charged','closed_evidence','closed_other'))
);
CREATE TABLE fpi_refunds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fpi_case_id           uuid NOT NULL REFERENCES fpi_cases(case_id),
  placement_id          uuid NOT NULL REFERENCES lpi_placements(id),
  evidence_id           uuid REFERENCES insurance_evidence(id),
  evidence_received_at  date NOT NULL,
  borrower_coverage_start date NOT NULL,
  borrower_coverage_end date,
  overlap_start         date NOT NULL,
  overlap_end           date NOT NULL,
  overlap_days          int NOT NULL,
  daily_rate_cents      numeric(20,6) NOT NULL,
  overlap_premium_cents bigint NOT NULL,
  related_fees_cents    bigint NOT NULL DEFAULT 0,
  assessed_removed_cents bigint NOT NULL,
  paid_refund_cents     bigint NOT NULL,
  refund_method         text CHECK (refund_method IN ('escrow_credit','ach','check','account_credit')),
  refund_sent_at        timestamptz,
  deadline              date NOT NULL,
  cancellation_effective date NOT NULL,
  carrier_refund_cents  bigint,
  carrier_refund_received_at date,
  fnma_claim_adjustment_id uuid,
  root_cause            text,
  status                text NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','cancel_requested','cancelled','refunded','closed'))
);

-- 9.6 flood
CREATE TABLE flood_determinations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  property_id           uuid REFERENCES properties(id),
  vendor_party_id       uuid REFERENCES parties(id),
  vendor_ref            text,
  determination_date    date NOT NULL,
  sfhdf_document_id     uuid REFERENCES documents(id),
  zone                  text,
  sfha                  boolean NOT NULL,
  cbrs_opa              boolean NOT NULL DEFAULT false,
  community_number      text,
  community_name        text,
  participating         boolean,
  program_status        text CHECK (program_status IN ('regular','emergency','suspended','non_participating')),
  map_panel             text,
  map_date              date,
  lol                   boolean NOT NULL DEFAULT false,
  multiple_structures   boolean NOT NULL DEFAULT false,
  structures            jsonb NOT NULL DEFAULT '[]',
  determination_type    text NOT NULL CHECK (determination_type IN ('boarding','reorder','lol_update','map_change','manual_review','loma_lomr')),
  previous_id           uuid REFERENCES flood_determinations(id),
  coverage_required     boolean NOT NULL,
  required_amount_cents bigint
);
CREATE TABLE flood_map_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  determination_id      uuid NOT NULL REFERENCES flood_determinations(id),
  received_at           timestamptz NOT NULL,
  effective_date        date NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('into_sfha','out_of_sfha','zone_change_within','community_change')),
  old_zone              text,
  new_zone              text,
  fnma_deadline         date,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','notified','covered','lpi_placed','released','closed'))
);

-- 9.7 claims
CREATE TABLE insurance_claims (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  property_id           uuid REFERENCES properties(id),
  policy_id             uuid REFERENCES insurance_policies(id),
  loss_date             date,
  loss_cause            text CHECK (loss_cause IN ('fire','wind','hail','water','flood','theft','vandalism','earthquake','other')),
  disaster_event_id     uuid,
  reported_at           timestamptz,
  carrier_claim_no      text,
  adjuster_party_id     uuid REFERENCES parties(id),
  adjuster_estimate_cents bigint,
  rebuildable           text NOT NULL DEFAULT 'unknown' CHECK (rebuildable IN ('yes','no','unknown')),
  track                 text CHECK (track IN ('current_lt31','delinquent_31plus','abandoned_or_fc_sale','not_rebuildable')),
  track_determined_at   timestamptz,
  total_proceeds_expected_cents bigint,
  proceeds_received_cents bigint NOT NULL DEFAULT 0,
  held_cents            bigint NOT NULL DEFAULT 0,
  disbursed_cents       bigint NOT NULL DEFAULT 0,
  contents_ale_cents    bigint NOT NULL DEFAULT 0,
  interest_accrued_cents bigint NOT NULL DEFAULT 0,
  repair_plan_status    text NOT NULL DEFAULT 'none' CHECK (repair_plan_status IN ('none','submitted','approved')),
  bids                  jsonb NOT NULL DEFAULT '[]',
  public_adjuster       boolean NOT NULL DEFAULT false,
  fnma_third_party_approval_ref text,
  form176_sent_at       timestamptz,
  form176_reason        text,
  workout_case_id       uuid REFERENCES cases(id),
  status                text NOT NULL DEFAULT 'open',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE claim_instruments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES insurance_claims(id),
  instrument_type       text NOT NULL CHECK (instrument_type IN ('check','eft')),
  check_no              text,
  payees                text[] NOT NULL DEFAULT '{}',
  amount_cents          bigint NOT NULL,
  received_at           timestamptz NOT NULL,
  endorsement_required  boolean NOT NULL DEFAULT true,
  endorsement_status    text NOT NULL DEFAULT 'awaiting_borrower' CHECK (endorsement_status IN ('awaiting_borrower','awaiting_servicer','endorsed','deposited','returned')),
  deposited_at          timestamptz,
  custodial_account_id  uuid REFERENCES custodial_accounts(id),
  ledger_entry_set_id   uuid REFERENCES ledger_entry_sets(id),
  image_document_id     uuid REFERENCES documents(id)
);
COMMENT ON COLUMN claim_instruments.payees IS 'pii';
CREATE TABLE repair_inspections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES insurance_claims(id),
  type                  text NOT NULL CHECK (type IN ('progress','final','remote_photo','remote_video')),
  pct_complete          numeric(5,2),
  inspected_at          timestamptz NOT NULL,
  inspector_party_id    uuid REFERENCES parties(id),
  report_document_id    uuid REFERENCES documents(id),
  authenticity          jsonb,
  cost_cents            bigint NOT NULL DEFAULT 0,
  reimbursable          boolean NOT NULL DEFAULT false,
  claimed_in            uuid
);
CREATE TABLE claim_disbursements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id              uuid NOT NULL REFERENCES insurance_claims(id),
  seq                   smallint NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('contents_ale','initial','progress','final','prepaid_reimbursement','upb_application','remit_fnma_332','interest_payout','refund_to_borrower')),
  amount_cents          bigint NOT NULL,
  rule_basis            jsonb NOT NULL,
  inspection_id         uuid REFERENCES repair_inspections(id),
  lien_waivers          jsonb,
  payee_party_ids       uuid[] NOT NULL DEFAULT '{}',
  released_at           timestamptz,
  disbursement_id       uuid REFERENCES disbursements(id),
  approved_by_run_id    uuid,
  UNIQUE (claim_id, seq)
);

-- 9.8 inspections
CREATE TABLE property_inspections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  property_id           uuid REFERENCES properties(id),
  kind                  text NOT NULL CHECK (kind IN ('delinquency_exterior','delinquency_interior','curbside','vacancy_confirmation','occupancy_check','pre_sale_35','disaster','insured_loss_repair','disrepair','code_violation','other')),
  ordered_by            text NOT NULL CHECK (ordered_by IN ('servicer','fnma_program')),
  ordered_at            timestamptz NOT NULL,
  due_by                date,
  completed_at          timestamptz,
  vendor_party_id       uuid REFERENCES parties(id),
  inspector_ref         text,
  report_document_id    uuid REFERENCES documents(id),
  occupancy_result      text CHECK (occupancy_result IN ('occupied_borrower','occupied_tenant','occupied_unknown','vacant','abandoned','unknown')),
  signed_vacancy_cert   boolean NOT NULL DEFAULT false,
  condition             jsonb,
  photos                uuid[] NOT NULL DEFAULT '{}',
  legal_constraint_reason text,
  cost_cents            bigint NOT NULL DEFAULT 0,
  reimbursable          boolean NOT NULL DEFAULT false,
  expense_claim_id      uuid
);
CREATE TABLE inspection_schedules (
  loan_id               uuid PRIMARY KEY REFERENCES loans(id),
  mode                  text NOT NULL DEFAULT 'servicer' CHECK (mode IN ('servicer','pfpip','suspended')),
  next_due              date,
  last_completed_at     timestamptz,
  interval_min_days     int NOT NULL DEFAULT 20,
  interval_max_days     int NOT NULL DEFAULT 35,
  exception_reason      text,
  interior_required     boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE p360_pfpip_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  fnma_loan_no          char(10) NOT NULL,
  submitted_at          timestamptz,
  method                text NOT NULL CHECK (method IN ('api','human_portal_task')),
  payload               jsonb NOT NULL,
  fnma_status           text,
  last_reconciled_at    timestamptz,
  last_fnma_activity    jsonb,
  removed_at            timestamptz,
  removal_reason        text CHECK (removal_reason IN ('reinstated','liquidated_reo','paid_off','transferred','ineligible'))
);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS occupancy_status text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS resale_restriction text;

-- 9.9 preservation
CREATE TABLE preservation_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid REFERENCES cases(id),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  property_id           uuid REFERENCES properties(id),
  ftv_date              date NOT NULL,
  mode                  text NOT NULL CHECK (mode IN ('servicer','pfpip','hybrid','suspended')),
  posting_expires_at    date,
  initial_due           date NOT NULL,
  initial_completed_at  timestamptz,
  occupancy_status      text,
  bk_lossmit_constraints jsonb,
  entry_permitted       boolean,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE allowable_matrix (
  rule_set              text NOT NULL,
  code                  text NOT NULL,
  description           text NOT NULL,
  cap_cents             bigint NOT NULL,
  cap_unit              text NOT NULL CHECK (cap_unit IN ('each','per_ui','per_cy','per_unit','per_year','life_of_loan','per_month')),
  life_of_loan          boolean NOT NULL DEFAULT false,
  notes                 text,
  PRIMARY KEY (rule_set, code)
);
CREATE TABLE preservation_bids (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES preservation_cases(id),
  work_order_id         uuid,
  discovery_date        date NOT NULL,
  submit_due            date NOT NULL,
  submitted_at          timestamptz,
  channel               text CHECK (channel IN ('hometracker','form_1095_email')),
  human_task_id         uuid,
  amount_cents          bigint,
  fnma_decision         text NOT NULL DEFAULT 'pending' CHECK (fnma_decision IN ('pending','approved','modified','denied')),
  decision_at           timestamptz,
  reconsider_due        date,
  status                text NOT NULL DEFAULT 'open'
);
CREATE TABLE preservation_work_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES preservation_cases(id),
  vendor_party_id       uuid REFERENCES parties(id),
  kind                  text NOT NULL CHECK (kind IN ('initial_secure','initial_services','ongoing','emergency','damage','code_violation','registration','utility','specialty')),
  items                 jsonb NOT NULL DEFAULT '[]',
  ordered_at            timestamptz NOT NULL,
  due_by                date,
  completed_at          timestamptz,
  photos                uuid[] NOT NULL DEFAULT '{}',
  invoice_document_id   uuid REFERENCES documents(id),
  total_cents           bigint NOT NULL DEFAULT 0,
  within_allowable      boolean,
  bid_id                uuid REFERENCES preservation_bids(id),
  batf                  boolean NOT NULL DEFAULT false,
  claim_id              uuid,
  status                text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','in_progress','completed','cancelled','rejected'))
);
ALTER TABLE preservation_bids ADD CONSTRAINT preservation_bids_wo_fk FOREIGN KEY (work_order_id) REFERENCES preservation_work_orders(id);
CREATE TABLE property_registrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  jurisdiction_state    char(2) REFERENCES jurisdiction_rules(state),
  jurisdiction_rule_key text,
  registration_type     text NOT NULL CHECK (registration_type IN ('vacant','default','foreclosure','blight','contact_change')),
  trigger_event         text,
  due_date              date NOT NULL,
  filed_at              timestamptz,
  fee_cents             bigint NOT NULL DEFAULT 0,
  renewal_every         text,
  next_renewal_due      date,
  confirmation_document_id uuid REFERENCES documents(id),
  status                text NOT NULL DEFAULT 'due'
);

COMMIT;
