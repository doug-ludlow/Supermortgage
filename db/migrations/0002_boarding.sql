-- 0002_boarding.sql — Section 1 (Boarding / Servicing Transfer-In) tables per spec 1.1 data model
BEGIN;

CREATE TYPE transfer_type AS ENUM ('master_to_sub', 'sub_to_sub', 'servicing_sale_with_sub', 'custodian_only');
CREATE TYPE transfer_batch_status AS ENUM ('proposed', 'approved', 'tapes_pending', 'staging', 'cutover', 'reconciling', 'monitoring', 'closed', 'withdrawn');
CREATE TYPE notice_mode AS ENUM ('separate', 'combined');

CREATE TABLE transfer_batches (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                   uuid REFERENCES cases(id),
  transfer_type             transfer_type NOT NULL,
  transferor_party_id       uuid NOT NULL REFERENCES parties(id),
  transferor_servicer_number char(9) NOT NULL,
  partner_servicer_number   char(9) NOT NULL,
  sale_date                 date,
  transfer_date             date NOT NULL,                      -- must be first fannie_et business day of month (validated in code)
  respa_effective_date      date NOT NULL,                      -- first payment due to Supermortgage (12 U.S.C. 2605(i)(1))
  d_code                    text,
  fnma_consent_document_id  uuid REFERENCES documents(id),
  notice_mode               notice_mode NOT NULL DEFAULT 'separate',
  status                    transfer_batch_status NOT NULL DEFAULT 'proposed',
  loan_count                int NOT NULL DEFAULT 0,
  upb_total_cents           bigint NOT NULL DEFAULT 0,
  escrow_total_cents        bigint NOT NULL DEFAULT 0,
  rule_set_version          text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE loans ADD CONSTRAINT loans_boarding_batch_fk FOREIGN KEY (boarding_batch_id) REFERENCES transfer_batches(id);

CREATE TYPE boarding_status AS ENUM ('staged', 'validated', 'exception', 'boarded', 'reconciled', 'active', 'rejected_to_transferor', 'withdrawn');

CREATE TABLE transfer_batch_loans (
  id                                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                             uuid NOT NULL REFERENCES transfer_batches(id),
  transferor_loan_number               text NOT NULL,
  fnma_loan_number                     char(10) NOT NULL,
  min                                  char(18),
  loan_id                              uuid REFERENCES loans(id),
  boarding_status                      boarding_status NOT NULL DEFAULT 'staged',
  boarding_hold                        boolean NOT NULL DEFAULT false,
  default_status_at_boarding           boolean,
  regx_days_delinquent_at_boarding     int,
  fnma_delinquency_status_at_boarding  text,
  fdcpa_debt_collector_flag            boolean,
  lossmit_in_process                   boolean NOT NULL DEFAULT false,
  fc_active                            boolean NOT NULL DEFAULT false,
  bk_active                            boolean NOT NULL DEFAULT false,
  scra_active                          boolean NOT NULL DEFAULT false,
  sii_present                          boolean NOT NULL DEFAULT false,
  emortgage                            boolean NOT NULL DEFAULT false,
  acp_enrolled                         boolean NOT NULL DEFAULT false,
  created_at                           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, fnma_loan_number)                            -- HF-017 within a batch
);
CREATE INDEX transfer_batch_loans_status_idx ON transfer_batch_loans(batch_id, boarding_status);

CREATE TYPE boarding_tape_kind AS ENUM ('preliminary', 'final', 'payment_history', 'escrow_history', 'escrow_analysis', 'lossmit', 'fc_bk', 'images_manifest', 'consents', 'correspondence', 'trial_balance', 'custodial_recon', 'investor_reports');

CREATE TABLE boarding_tapes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     uuid NOT NULL REFERENCES transfer_batches(id),
  kind         boarding_tape_kind NOT NULL,
  document_id  uuid NOT NULL REFERENCES documents(id),
  codec        text NOT NULL,                                   -- mismo_mstc | csv_v1 | ...
  row_count    int NOT NULL,
  received_at  timestamptz NOT NULL,
  as_of        date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Versioned transferor → MISMO v3.6 mapping rule sets.
CREATE TABLE mapping_rule_sets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transferor_party_id uuid NOT NULL REFERENCES parties(id),
  version             text NOT NULL,
  rules               jsonb NOT NULL,                           -- [{source_column, canonical_path, transform, required}]
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transferor_party_id, version)
);

CREATE TABLE boarding_staging (
  id              bigserial PRIMARY KEY,
  batch_loan_id   uuid NOT NULL REFERENCES transfer_batch_loans(id),
  tape_id         uuid NOT NULL REFERENCES boarding_tapes(id),
  canonical_path  text NOT NULL,                                -- e.g. LOAN/TERMS_OF_LOAN/NoteRatePercent
  raw_value       text,
  canonical_value jsonb,
  mapping_rule_id text,
  source_column   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boarding_staging_loan_idx ON boarding_staging(batch_loan_id, canonical_path);
CREATE TRIGGER boarding_staging_immutable BEFORE UPDATE OR DELETE ON boarding_staging FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TYPE validation_severity AS ENUM ('hard', 'warning', 'info');
CREATE TYPE validation_result AS ENUM ('pass', 'fail', 'waived');
CREATE TYPE validation_resolution AS ENUM ('transferor_corrected', 'agent_corrected', 'waived_with_reason', 'rejected');

CREATE TABLE boarding_validations (
  id                   bigserial PRIMARY KEY,
  batch_loan_id        uuid NOT NULL REFERENCES transfer_batch_loans(id),
  run_id               uuid NOT NULL,
  rule_code            text NOT NULL,                           -- HF-001 … W-016
  severity             validation_severity NOT NULL,
  result               validation_result NOT NULL,
  expected             jsonb,
  actual               jsonb,
  message              text,
  resolved_by          text,
  resolution           validation_resolution,
  evidence_document_id uuid REFERENCES documents(id),
  rule_set_version     text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boarding_validations_loan_idx ON boarding_validations(batch_loan_id, rule_code);
CREATE TRIGGER boarding_validations_immutable BEFORE UPDATE OR DELETE ON boarding_validations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE boarding_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_loan_id  uuid NOT NULL REFERENCES transfer_batch_loans(id),
  validation_id  bigint NOT NULL REFERENCES boarding_validations(id),
  rule_code      text NOT NULL,
  severity       validation_severity NOT NULL,
  money_field    boolean NOT NULL DEFAULT false,                -- money fields are never agent-corrected
  owner          text NOT NULL,                                 -- boarding | officer | transferor | fnma_portal_operator
  sla_timer_id   uuid REFERENCES timers(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolution     validation_resolution,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boarding_exceptions_open_idx ON boarding_exceptions(batch_loan_id) WHERE resolved_at IS NULL;

-- Jurisdiction rules referenced by HF-020 and many later sections.
CREATE TABLE jurisdiction_rules (
  state                    char(2) PRIMARY KEY,
  licensed                 boolean NOT NULL DEFAULT false,      -- Supermortgage servicer license held
  license_number           text,
  partial_payment_fc_risk  boolean NOT NULL DEFAULT false,
  judicial_foreclosure     boolean NOT NULL DEFAULT false,
  rules                    jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now()
);

COMMIT;
