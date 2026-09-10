-- 0005_servicing_requests.sql — Section 4 (4.1–4.5): NoE/RFI cases, continuity, successors, complaints; contacts baseline.
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regx_1y_post_transfer';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regulatory_correspondence_7y';

-- ─────────── 4.1 designated addresses, inbound communications ───────────
CREATE TABLE designated_addresses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('noe_rfi_exclusive','online_exclusive','lossmit','continuity','general','payment')),
  lines                 jsonb NOT NULL,
  channel               text NOT NULL CHECK (channel IN ('mail','web_form','secure_message','email')),
  effective_from        date NOT NULL,
  effective_to          date,
  designation_notice_template_version text,
  published_on          jsonb NOT NULL DEFAULT '{"website": false, "statements": false, "ei_notices": false}',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX designated_addresses_one_active_noe ON designated_addresses(kind) WHERE kind = 'noe_rfi_exclusive' AND effective_to IS NULL;

CREATE TABLE inbound_communications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid REFERENCES loans(id),
  party_id              uuid REFERENCES parties(id),
  channel               text NOT NULL,
  received_at           timestamptz NOT NULL,
  receipt_date          date NOT NULL,                             -- America/New_York; mail = vendor receipt date
  received_address_id   uuid REFERENCES designated_addresses(id),
  document_id           uuid REFERENCES documents(id),
  text                  text,
  language_detected     text,
  classifier_run_id     uuid,
  classifications       jsonb NOT NULL DEFAULT '[]',
  routed_case_ids       uuid[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'new' CHECK (status IN ('new','routed','no_action','needs_human')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN inbound_communications.text IS 'pii';

-- cases: section-specific columns (4.1 NoE, 4.2 RFI, 4.5 complaints)
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_date date,
  ADD COLUMN IF NOT EXISTS received_via text,
  ADD COLUMN IF NOT EXISTS received_at_exclusive_address boolean,
  ADD COLUMN IF NOT EXISTS is_qwr boolean,
  ADD COLUMN IF NOT EXISTS submitted_by_agent boolean,
  ADD COLUMN IF NOT EXISTS agent_authorization_status text CHECK (agent_authorization_status IN ('n/a','pending','verified','refused')),
  ADD COLUMN IF NOT EXISTS foreclosure_sale_date_at_receipt date,
  ADD COLUMN IF NOT EXISTS deadline_profile text,
  ADD COLUMN IF NOT EXISTS extension_used boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exception_basis text,
  ADD COLUMN IF NOT EXISTS determination text,
  ADD COLUMN IF NOT EXISTS human_review_reason text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS jurisdiction_profile text,
  ADD COLUMN IF NOT EXISTS is_potential_successor_request boolean,
  ADD COLUMN IF NOT EXISTS requester_role text CHECK (requester_role IN ('borrower','agent','confirmed_successor','potential_successor')),
  ADD COLUMN IF NOT EXISTS omissions_applied jsonb,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS regulator_code text,
  ADD COLUMN IF NOT EXISTS regulator_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS regulator_final_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS is_oral boolean,
  ADD COLUMN IF NOT EXISTS primary_issue text,
  ADD COLUMN IF NOT EXISTS sub_issue text,
  ADD COLUMN IF NOT EXISTS secondary_issues text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS severity text CHECK (severity IN ('low','medium','high','critical')),
  ADD COLUMN IF NOT EXISTS flags jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS linked_case_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS root_cause_code text,
  ADD COLUMN IF NOT EXISTS root_cause_owner_process text,
  ADD COLUMN IF NOT EXISTS remediation jsonb,
  ADD COLUMN IF NOT EXISTS response_type text,
  ADD COLUMN IF NOT EXISTS closed_with text,
  ADD COLUMN IF NOT EXISTS regulator_response_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS officer_approved_by text,
  ADD COLUMN IF NOT EXISTS consumer_feedback jsonb;

CREATE TABLE case_assertions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  seq                   smallint NOT NULL,
  category              text NOT NULL,                             -- b1..b11
  description           text NOT NULL,
  period_start          date,
  period_end            date,
  amount_asserted_cents bigint,
  investigation         jsonb NOT NULL DEFAULT '{}',
  determination         text CHECK (determination IN ('error_found','no_error','cannot_determine_needs_borrower_info','out_of_scope','duplicative','overbroad')),
  correction_commands   uuid[] NOT NULL DEFAULT '{}',
  ledger_entry_set_ids  uuid[] NOT NULL DEFAULT '{}',
  effective_date_of_correction date,
  response_notice_id    uuid,
  UNIQUE (case_id, seq)
);
CREATE TABLE system_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  kind                  text NOT NULL,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  document_id           uuid NOT NULL REFERENCES documents(id),
  payload               jsonb NOT NULL
);
CREATE TRIGGER system_snapshots_immutable BEFORE UPDATE OR DELETE ON system_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE case_relied_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  assertion_id          uuid REFERENCES case_assertions(id),
  document_id           uuid REFERENCES documents(id),
  system_snapshot_id    uuid REFERENCES system_snapshots(id),
  relied_upon           boolean NOT NULL DEFAULT true,
  withheld_reason       text CHECK (withheld_reason IN ('confidential','proprietary','privileged')),
  CHECK (document_id IS NOT NULL OR system_snapshot_id IS NOT NULL)
);
CREATE TABLE document_copy_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  requested_at          timestamptz NOT NULL,
  requested_via         text,
  due_at                timestamptz NOT NULL,
  fulfilled_notice_id   uuid,
  withheld_notice_id    uuid
);

-- credit_reporting_suppressions — 4.1 slice; 8.3 extends
CREATE TABLE credit_reporting_suppressions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  borrower_id           uuid REFERENCES borrowers(id),
  case_id               uuid REFERENCES cases(id),
  scope                 jsonb NOT NULL DEFAULT '"all"',
  starts_at             date NOT NULL,
  ends_at               date,
  reason                text NOT NULL DEFAULT 'regx_1024_35_i',
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ─────────── 4.2 RFI ───────────
CREATE TABLE case_request_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES cases(id),
  seq                   smallint NOT NULL,
  item_kind             text NOT NULL,
  description           text,
  period_start          date,
  period_end            date,
  determination         text CHECK (determination IN ('provided','not_available','exception_duplicative','exception_confidential','exception_irrelevant','exception_overbroad','exception_untimely','deferred_until_confirmation')),
  not_available_basis   text,
  documents_provided    uuid[] NOT NULL DEFAULT '{}',
  search_log            jsonb NOT NULL DEFAULT '[]',
  UNIQUE (case_id, seq)
);
CREATE TABLE records_inventory (
  record_type           text PRIMARY KEY,
  system                text NOT NULL,
  availability_class    text NOT NULL,
  retrieval_sla_days    int NOT NULL,
  owner_agent           text NOT NULL
);

-- ─────────── 4.3 continuity ───────────
CREATE TABLE personnel (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('human','ai_agent')),
  display_name          text NOT NULL,
  employee_id           text,
  licenses              jsonb NOT NULL DEFAULT '{}',
  languages             text[] NOT NULL DEFAULT '{}',
  time_zone             text,
  active                boolean NOT NULL DEFAULT true
);
CREATE TABLE contact_teams (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  members               uuid[] NOT NULL DEFAULT '{}',
  direct_number         text,
  hours                 jsonb NOT NULL DEFAULT '{}',
  states_served         text[] NOT NULL DEFAULT '{}',
  bankruptcy_specialist boolean NOT NULL DEFAULT false
);
CREATE TABLE continuity_episodes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  started_at            date NOT NULL,
  assignment_due_at     date NOT NULL,
  assigned_at           timestamptz,
  assignment_mode       text CHECK (assignment_mode IN ('ai_first_named_human','human_team','human_individual','ai_only')),
  team_id               uuid REFERENCES contact_teams(id),
  named_human_id        uuid REFERENCES personnel(id),
  ca_spoc_required      boolean NOT NULL DEFAULT false,
  ca_spoc_assigned_at   timestamptz,
  released_at           timestamptz,
  release_reason        text CHECK (release_reason IN ('two_consecutive_permanent_payments','current','paid_off','refinanced','title_transferred','transfer_out')),
  permanent_agreement_id uuid,
  consecutive_on_time_payments int NOT NULL DEFAULT 0,
  CHECK (assignment_mode = 'ai_only' OR assignment_mode IS NULL OR named_human_id IS NOT NULL)
);
-- contacts (baseline; also used by 11.x, 18.x)
CREATE TABLE contacts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  party_id              uuid REFERENCES parties(id),
  borrower_id           uuid REFERENCES borrowers(id),
  direction             text NOT NULL CHECK (direction IN ('outbound','inbound')),
  mode                  text NOT NULL,                             -- call | sms | email | letter | portal | in_person
  attempted_at          timestamptz NOT NULL,
  result                text,
  live_contact          boolean NOT NULL DEFAULT false,
  qrpc                  boolean NOT NULL DEFAULT false,
  episode_id            uuid REFERENCES continuity_episodes(id),
  assigned_personnel_id uuid REFERENCES personnel(id),
  disclosure_given      boolean,
  human_transfer_requested boolean NOT NULL DEFAULT false,
  human_transfer_completed_at timestamptz,
  transcript_document_id uuid REFERENCES documents(id),
  narrative             text,
  language              text,
  agent_run_id          uuid,
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN contacts.narrative IS 'pii';
CREATE INDEX contacts_loan_idx ON contacts(loan_id, attempted_at);
CREATE TRIGGER contacts_immutable BEFORE UPDATE OR DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE callback_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id            uuid NOT NULL REFERENCES continuity_episodes(id),
  requested_at          timestamptz NOT NULL,
  channel               text NOT NULL,
  due_at                timestamptz NOT NULL,
  completed_contact_id  uuid REFERENCES contacts(id)
);

-- ─────────── 4.4 successors in interest ───────────
ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS relationship_to_borrower text,
  ADD COLUMN IF NOT EXISTS contact_preferences jsonb,
  ADD COLUMN IF NOT EXISTS preferred_language text,
  ADD COLUMN IF NOT EXISTS address_confidential boolean NOT NULL DEFAULT false;
CREATE TABLE sii_cases (
  case_id               uuid PRIMARY KEY REFERENCES cases(id),
  transferor_borrower_id uuid REFERENCES borrowers(id),
  potential_successor_party_id uuid REFERENCES parties(id),
  notice_source         text NOT NULL,
  transfer_type         text CHECK (transfer_type IN ('1_joint_tenant_death','2_relative_on_death','3_spouse_children','4_divorce_separation','5_inter_vivos_trust','non_exempt_other')),
  state                 char(2),
  scenario_code         text,
  documents_required    jsonb NOT NULL DEFAULT '[]',
  documents_received    jsonb NOT NULL DEFAULT '[]',
  determination         text NOT NULL DEFAULT 'pending' CHECK (determination IN ('pending','confirmed','additional_documents_required','not_successor','withdrawn')),
  determined_at         timestamptz,
  lossmit_pending       boolean NOT NULL DEFAULT false,
  ack_notice_sent_at    timestamptz,
  ack_status            text NOT NULL DEFAULT 'not_sent' CHECK (ack_status IN ('not_sent','sent','returned','revoked')),
  assumption_status     text NOT NULL DEFAULT 'none' CHECK (assumption_status IN ('none','requested','executed','declined')),
  release_of_liability_status text
);
CREATE TABLE sii_document_matrix (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state                 char(2) NOT NULL,
  transfer_type         text NOT NULL,
  scenario_code         text NOT NULL,
  required_documents    jsonb NOT NULL,
  source                text,
  counsel_reviewed_at   timestamptz,
  version               text NOT NULL,
  UNIQUE (state, transfer_type, scenario_code, version)
);
CREATE TABLE sii_documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES sii_cases(case_id),
  doc_type              text NOT NULL,
  document_id           uuid NOT NULL REFERENCES documents(id),
  received_at           timestamptz NOT NULL,
  verification          jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'received' CHECK (status IN ('received','accepted','insufficient'))
);
CREATE TABLE sii_acknowledgments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               uuid NOT NULL REFERENCES sii_cases(case_id),
  sent_notice_id        uuid,
  returned_at           timestamptz,
  elected_notices       boolean,
  revoked_at            timestamptz
);
CREATE TABLE assumptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  party_id              uuid NOT NULL REFERENCES parties(id),
  kind                  text NOT NULL CHECK (kind IN ('exempt_assumption','assumption_with_modification','release_of_liability')),
  agreement_document_id uuid REFERENCES documents(id),
  signed_by_signing_officer_id uuid REFERENCES personnel(id),
  executed_at           timestamptz,
  mi_approval_ref       text,
  fnma_notification_ref text
);

-- ─────────── 4.5 complaints ───────────
CREATE TABLE complaint_taxonomy (
  code                  text NOT NULL,
  version               text NOT NULL,
  parent_code           text,
  label                 text NOT NULL,
  cfpb_issue            text,
  cfpb_sub_issue        text,
  PRIMARY KEY (code, version)
);
CREATE TABLE udaap_monitors (
  code                  text PRIMARY KEY,
  description           text NOT NULL,
  metric_sql            text NOT NULL,
  threshold             numeric NOT NULL,
  comparator            text NOT NULL DEFAULT '>',
  window_days           int NOT NULL,
  owner_role            text NOT NULL
);
CREATE TABLE population_remediations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue                 text NOT NULL,
  lookback_start        date NOT NULL,
  criteria_sql          text NOT NULL,
  loans_affected        int NOT NULL DEFAULT 0,
  total_cents           bigint NOT NULL DEFAULT 0,
  approved_by           text,
  executed_at           timestamptz,
  investor_notification_ref text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE complaint_analytics (
  period                text NOT NULL,
  dimension             text NOT NULL,
  key                   text NOT NULL,
  count                 int NOT NULL,
  uphold_rate           numeric(6,4),
  median_resolution_days numeric(6,2),
  monetary_relief_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (period, dimension, key)
);

COMMIT;
