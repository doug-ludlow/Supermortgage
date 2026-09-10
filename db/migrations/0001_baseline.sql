-- 0001_baseline.sql — Supermortgage system-of-record baseline
--
-- Conventions (from the spec's baseline data model):
--   * every money column is bigint cents; never numeric/float
--   * every table has created_at timestamptz; append-only tables have no updated_at
--   * effective-dated tables carry effective_from/effective_to and are never edited in place
--   * PII columns are marked with COMMENT 'pii' so the encryption layer / access-logging
--     (Section 19) can enumerate them
--   * retention_class drives Section 19 purge/hold logic

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE retention_class AS ENUM ('life_of_loan_plus_4y', 'respa_5y', 'regz_2y', 'ecoa_25m', 'glba_5y', 'permanent');
CREATE TYPE actor_kind AS ENUM ('agent', 'human', 'system', 'external');

-- ───────────────────────────── parties & people ─────────────────────────────
CREATE TYPE party_type AS ENUM ('servicer', 'transferor', 'transferee', 'custodian', 'attorney', 'trustee', 'vendor', 'investor', 'mi_company', 'successor_in_interest', 'authorized_third_party', 'other');

CREATE TABLE parties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_type      party_type NOT NULL,
  legal_name      text NOT NULL,
  servicer_number char(9),                       -- Fannie Mae 9-digit servicer number where applicable
  mers_org_id     char(7),
  contact         jsonb NOT NULL DEFAULT '{}',   -- addresses, phones, emails (pii)
  sii_confirmed_at timestamptz,                  -- successor-in-interest confirmation (4.4)
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN parties.contact IS 'pii';

CREATE TABLE borrowers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name         text NOT NULL,
  tin_encrypted      bytea,                      -- SSN/ITIN, encrypted at rest
  tin_last4          char(4),
  date_of_birth      date,
  preferred_language text,                       -- ISO 639-1; W-012 if missing
  deceased_at        date,
  scra_active        boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN borrowers.legal_name IS 'pii';
COMMENT ON COLUMN borrowers.tin_encrypted IS 'pii';
COMMENT ON COLUMN borrowers.date_of_birth IS 'pii';

-- Fair-lending elements live in a restricted, access-logged table (1.1 open question 2, default).
CREATE TABLE borrower_fair_lending (
  borrower_id   uuid PRIMARY KEY REFERENCES borrowers(id),
  ethnicity     jsonb,
  race          jsonb,
  sex           text,
  age_at_application int,
  collection_method text,                        -- 'self_reported' | 'observed' | 'not_provided'
  origination_date date,                         -- W-011 applies to originations ≥ 2023-03-01
  retention      retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE borrower_fair_lending IS 'restricted: every read is written to access_log';

-- ───────────────────────────── properties ─────────────────────────────
CREATE TABLE properties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_line1     text NOT NULL,
  address_line2     text,
  city              text NOT NULL,
  state             char(2) NOT NULL,
  postal_code       text NOT NULL,
  county            text,
  tax_parcel_id     text,
  tax_parcel_verified boolean NOT NULL DEFAULT false,   -- W-004
  property_type     text,
  occupancy         text,                         -- owner_occupied | second_home | investment
  units             smallint,
  flood_zone        text,
  flood_determination_document_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN properties.address_line1 IS 'pii';

-- ───────────────────────────── documents ─────────────────────────────
CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id          uuid,                          -- FK added after loans
  kind             text NOT NULL,                 -- note | mortgage | allonge | assignment | boarding_tape | notice | ...
  sha256           char(64) NOT NULL,
  byte_size        bigint NOT NULL,
  storage_uri      text NOT NULL,
  mime_type        text,
  received_from    uuid REFERENCES parties(id),
  retention_class  retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  legal_hold       boolean NOT NULL DEFAULT false,
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_sha256_idx ON documents(sha256);

-- ───────────────────────────── loans ─────────────────────────────
CREATE TYPE remittance_type AS ENUM ('A/A', 'S/A', 'S/S');
CREATE TYPE lien_position AS ENUM ('first', 'second', 'other');
CREATE TYPE loan_status AS ENUM ('staged', 'active', 'paid_off', 'foreclosed', 'reo', 'transferred_out', 'repurchased', 'charged_off');

CREATE TABLE loans (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fnma_loan_number           char(10) NOT NULL UNIQUE,          -- HF-001
  servicer_loan_number       text NOT NULL UNIQUE,
  transferor_loan_number     text,
  min                        char(18) UNIQUE,                   -- MERS MIN; HF-008/HF-017
  mers_eligible              boolean NOT NULL DEFAULT true,
  partner_party_id           uuid NOT NULL REFERENCES parties(id),   -- master servicer of record
  prior_servicer_party_id    uuid REFERENCES parties(id),
  property_id                uuid NOT NULL REFERENCES properties(id),
  status                     loan_status NOT NULL DEFAULT 'staged',
  lien                       lien_position NOT NULL DEFAULT 'first',
  instrument_date            date NOT NULL,                     -- note date; drives instrument_profile (pre/post 1999-03-01)
  origination_date           date,
  original_upb_cents         bigint NOT NULL CHECK (original_upb_cents > 0),
  original_term_months       int NOT NULL CHECK (original_term_months > 0),
  first_payment_date         date NOT NULL,
  maturity_date              date NOT NULL,
  emortgage                  boolean NOT NULL DEFAULT false,
  boarded_at                 timestamptz,
  boarding_batch_id          uuid,                              -- FK added below
  default_status_at_boarding boolean,
  fdcpa_debt_collector_flag  boolean,
  regx_days_delinquent_at_boarding int,
  fnma_delinquency_status_at_boarding text,
  retention_class            retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at                 timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE documents ADD CONSTRAINT documents_loan_fk FOREIGN KEY (loan_id) REFERENCES loans(id);
CREATE INDEX documents_loan_idx ON documents(loan_id);

-- Effective-dated terms: a new row per change, never an edit (1.1 "Retro-corrections").
CREATE TYPE interest_method AS ENUM ('30_360', 'actual_360', 'actual_365', 'daily_simple');
CREATE TYPE amortization_type AS ENUM ('fixed', 'arm', 'step', 'balloon', 'interest_only', 'buydown');

CREATE TABLE loan_terms (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                  uuid NOT NULL REFERENCES loans(id),
  effective_from           date NOT NULL,
  effective_to             date,
  source                   text NOT NULL,                       -- boarding | modification | arm_change | escrow_analysis | correction
  source_event_id          uuid,
  amortization             amortization_type NOT NULL DEFAULT 'fixed',
  note_rate_bps            int NOT NULL CHECK (note_rate_bps >= 0),          -- 6.375% = 63750 (1 bp = 0.01%; stored ×10 for 1/1000 % precision)
  pi_cents                 bigint NOT NULL CHECK (pi_cents >= 0),
  escrow_payment_cents     bigint NOT NULL DEFAULT 0 CHECK (escrow_payment_cents >= 0),
  escrowed                 boolean NOT NULL DEFAULT false,
  interest_method          interest_method NOT NULL DEFAULT '30_360',
  remittance_type          remittance_type NOT NULL,
  late_charge_pct_bps      int,                                  -- 4% = 4000 (×1000 scale, consistent with note_rate_bps)
  late_charge_grace_days   smallint,
  late_charge_max_cents    bigint,
  maturity_date            date NOT NULL,
  remaining_term_months    int,
  deferred_principal_cents bigint NOT NULL DEFAULT 0,
  forborne_principal_cents bigint NOT NULL DEFAULT 0,
  -- ARM fields (HF-006)
  arm_index                text,
  arm_margin_bps           int,
  arm_initial_cap_bps      int,
  arm_periodic_cap_bps     int,
  arm_lifetime_cap_bps     int,
  arm_floor_bps            int,
  arm_lookback_days        smallint,
  arm_next_change_date     date,
  arm_change_frequency_months smallint,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX loan_terms_loan_eff_idx ON loan_terms(loan_id, effective_from DESC);

CREATE TABLE loan_borrowers (
  loan_id      uuid NOT NULL REFERENCES loans(id),
  borrower_id  uuid NOT NULL REFERENCES borrowers(id),
  role         text NOT NULL DEFAULT 'borrower',                -- borrower | coborrower | cosigner
  is_primary   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (loan_id, borrower_id)
);

CREATE TABLE loan_parties (                                     -- attorneys, ACP, successors, authorized third parties
  loan_id     uuid NOT NULL REFERENCES loans(id),
  party_id    uuid NOT NULL REFERENCES parties(id),
  role        text NOT NULL,
  started_at  date NOT NULL,
  ended_at    date,
  PRIMARY KEY (loan_id, party_id, role, started_at)
);

-- ───────────────────────────── consents ─────────────────────────────
CREATE TYPE consent_kind AS ENUM ('esign', 'tcpa_voice', 'tcpa_sms', 'email_marketing', 'autopay', 'ai_voice', 'language_preference');
CREATE TYPE consent_provenance AS ENUM ('transferor', 'borrower_direct', 'portal', 'recorded_call', 'written');

CREATE TABLE consents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id              uuid NOT NULL REFERENCES loans(id),
  borrower_id          uuid REFERENCES borrowers(id),
  kind                 consent_kind NOT NULL,
  granted              boolean NOT NULL,
  provenance           consent_provenance NOT NULL,
  verified             boolean NOT NULL DEFAULT false,          -- transferor-supplied consents board as verified=false
  evidence_document_id uuid REFERENCES documents(id),
  captured_at          timestamptz NOT NULL,
  revoked_at           timestamptz,
  channel_identifier   text,                                    -- phone/email the consent covers (pii)
  created_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN consents.channel_identifier IS 'pii';
CREATE INDEX consents_loan_kind_idx ON consents(loan_id, kind);

-- ───────────────────────────── escrow ─────────────────────────────
CREATE TYPE escrow_line_type AS ENUM ('county_tax', 'city_tax', 'school_tax', 'other_tax', 'hazard', 'flood', 'wind', 'earthquake', 'mi', 'hoa', 'ground_rent', 'other');

CREATE TABLE escrow_accounts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                   uuid NOT NULL UNIQUE REFERENCES loans(id),
  computation_year_start    date NOT NULL,
  aggregate_method          boolean NOT NULL DEFAULT true,
  cushion_months            smallint NOT NULL DEFAULT 2,
  last_analysis_at          date,                               -- W-009 if > 12 months
  shortage_cents            bigint NOT NULL DEFAULT 0,
  surplus_cents             bigint NOT NULL DEFAULT 0,
  flag_50_rule_shortfall    bigint NOT NULL DEFAULT 0,          -- 2.2 $50-rule shortfalls to surface at next analysis
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE escrow_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_account_id   uuid NOT NULL REFERENCES escrow_accounts(id),
  line_type           escrow_line_type NOT NULL,
  payee_party_id      uuid REFERENCES parties(id),
  payee_ref           text,                                     -- parcel / policy number
  annual_amount_cents bigint NOT NULL CHECK (annual_amount_cents >= 0),
  next_due_date       date,
  frequency           text NOT NULL DEFAULT 'annual',
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escrow_lines_acct_idx ON escrow_lines(escrow_account_id);

-- ───────────────────────────── cases (cross-cutting) ─────────────────────────────
CREATE TABLE cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type     text NOT NULL,                                  -- transfer_in | lossmit | foreclosure | bankruptcy | noe | rfi | sii | ...
  loan_id       uuid REFERENCES loans(id),
  status        text NOT NULL,
  owner_role    text,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  data          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_loan_type_idx ON cases(loan_id, case_type) WHERE closed_at IS NULL;

-- ───────────────────────────── loan_events (append-only spine) ─────────────────────────────
CREATE TABLE loan_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence        bigserial NOT NULL UNIQUE,
  type            text NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  loan_id         uuid REFERENCES loans(id),
  aggregate_kind  text,
  aggregate_id    text,
  actor_kind      actor_kind NOT NULL,
  actor_id        text NOT NULL,
  actor_role      text,
  payload         jsonb NOT NULL DEFAULT '{}',
  causation_id    uuid,
  correlation_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_events_loan_idx ON loan_events(loan_id, sequence);
CREATE INDEX loan_events_type_idx ON loan_events(type, occurred_at);
CREATE INDEX loan_events_agg_idx ON loan_events(aggregate_kind, aggregate_id);

-- Immutability: no UPDATE/DELETE on the event log.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER loan_events_immutable BEFORE UPDATE OR DELETE ON loan_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── timers ─────────────────────────────
CREATE TYPE timer_status AS ENUM ('armed', 'satisfied', 'breached', 'satisfied_late', 'cancelled', 'needs_human');

CREATE TABLE timers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL,                          -- registry code, e.g. SM_BOARD_FIRST_CYCLE
  subject_kind          text NOT NULL,                          -- loan | transfer_batch | case | payment | global
  subject_id            text NOT NULL,
  loan_id               uuid REFERENCES loans(id),
  armed_at              timestamptz NOT NULL,
  armed_by_event_id     uuid NOT NULL REFERENCES loan_events(id),
  anchor_date           date NOT NULL,
  due_date              date,
  due_at                timestamptz,
  status                timer_status NOT NULL DEFAULT 'armed',
  satisfied_at          timestamptz,
  satisfied_by_event_id uuid REFERENCES loan_events(id),
  breached_at           timestamptz,
  cancelled_reason      text,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timers_open_due_idx ON timers(due_at) WHERE status = 'armed';
CREATE INDEX timers_subject_idx ON timers(subject_kind, subject_id, code);
CREATE INDEX timers_loan_idx ON timers(loan_id) WHERE status IN ('armed', 'breached');

-- ───────────────────────────── ledger ─────────────────────────────
CREATE TYPE account_scope AS ENUM ('loan', 'custodial', 'corporate');

CREATE TABLE custodial_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_party_id uuid NOT NULL REFERENCES parties(id),
  kind             text NOT NULL,                               -- pi | ti | ti_unapplied | clearing
  remittance_type  remittance_type,
  bank_party_id    uuid REFERENCES parties(id),
  account_last4    char(4),
  fnma_form_1013_document_id uuid REFERENCES documents(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entry_sets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_date   date NOT NULL,
  posted_at        timestamptz NOT NULL DEFAULT now(),
  description      text NOT NULL,
  source_event_id  uuid REFERENCES loan_events(id),
  reverses_set_id  uuid REFERENCES ledger_entry_sets(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id               uuid NOT NULL REFERENCES ledger_entry_sets(id),
  sequence             smallint NOT NULL,
  scope                account_scope NOT NULL,
  account              text NOT NULL,
  loan_id              uuid REFERENCES loans(id),
  custodial_account_id uuid REFERENCES custodial_accounts(id),
  amount_cents         bigint NOT NULL CHECK (amount_cents <> 0),   -- debit +, credit −
  rule_ref             text NOT NULL,
  memo                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (set_id, sequence),
  CHECK ((scope = 'loan' AND loan_id IS NOT NULL) OR (scope = 'custodial' AND custodial_account_id IS NOT NULL) OR (scope = 'corporate'))
);
CREATE INDEX ledger_lines_loan_acct_idx ON ledger_lines(loan_id, account);
CREATE INDEX ledger_lines_cust_acct_idx ON ledger_lines(custodial_account_id, account);
CREATE TRIGGER ledger_lines_immutable BEFORE UPDATE OR DELETE ON ledger_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_sets_immutable BEFORE UPDATE OR DELETE ON ledger_entry_sets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every entry set must balance. Enforced as a deferred constraint trigger so a set is checked at COMMIT.
CREATE OR REPLACE FUNCTION assert_entry_set_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint; n int;
BEGIN
  SELECT coalesce(sum(amount_cents), 0), count(*) INTO s, n FROM ledger_lines WHERE set_id = NEW.set_id;
  IF s <> 0 THEN RAISE EXCEPTION 'ledger entry set % does not balance (sum % cents)', NEW.set_id, s; END IF;
  IF n < 2 THEN RAISE EXCEPTION 'ledger entry set % needs at least two lines', NEW.set_id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_set_balanced();

-- ───────────────────────────── agent decisions (AI-first audit) ─────────────────────────────
CREATE TABLE agent_decisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent                 text NOT NULL,                          -- boarding | cashiering | transfer | ...
  loan_id               uuid REFERENCES loans(id),
  subject_kind          text,
  subject_id            text,
  rule_code             text,
  action                text NOT NULL,
  evidence_document_ids uuid[] NOT NULL DEFAULT '{}',
  confidence            numeric(5,4),
  rule_set_version      text NOT NULL,
  model_version         text,
  prompt_version        text,
  rationale             text NOT NULL,
  approved_by           text,                                   -- human user id when a role approval was required
  approved_role         text,
  event_id              uuid REFERENCES loan_events(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_decisions_loan_idx ON agent_decisions(loan_id, created_at);
CREATE TRIGGER agent_decisions_immutable BEFORE UPDATE OR DELETE ON agent_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── integration messages ─────────────────────────────
CREATE TYPE msg_direction AS ENUM ('in', 'out');
CREATE TABLE integration_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter          text NOT NULL,                               -- transferor_sftp | fnma-lsdu | fnma-servicing-events | mers | ...
  direction        msg_direction NOT NULL,
  idempotency_key  text NOT NULL,
  document_id      uuid REFERENCES documents(id),
  status           text NOT NULL DEFAULT 'received',
  payload_summary  jsonb NOT NULL DEFAULT '{}',
  acked_at         timestamptz,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter, direction, idempotency_key)
);

-- ───────────────────────────── restricted-data access log ─────────────────────────────
CREATE TABLE access_log (
  id          bigserial PRIMARY KEY,
  table_name  text NOT NULL,
  row_id      uuid,
  actor_kind  actor_kind NOT NULL,
  actor_id    text NOT NULL,
  purpose     text,
  accessed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
