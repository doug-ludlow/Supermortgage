-- 0057_origination_seam.sql — the origination/servicing seam (spec/origination/01-architecture-baseline-addendum.md §3).
-- One loan for life: an `applications` row is the aggregate before funding; 30.2 creates the servicing `loans` row at
-- funding with `origination_application_id`, sets `applications.loan_id`, and stages it through 1.1's boarding tables
-- with `source = 'origination'`. Events are keyed by `application_id` before funding and `loan_id` after (both columns
-- on `loan_events`, append-only as before). Nothing here redefines a servicing table; every change is additive.

-- ---------------------------------------------------------------- the applications aggregate (addendum §3)
CREATE TYPE application_channel AS ENUM ('refi_trigger', 'organic', 'referral');
CREATE TYPE transaction_type AS ENUM ('purchase', 'limited_cash_out', 'cash_out');
CREATE TYPE occupancy_type AS ENUM ('primary', 'second_home', 'investment');

CREATE TABLE applications (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_party_id            uuid NOT NULL REFERENCES parties(id),     -- lender of record (addendum §1)
  channel                     application_channel NOT NULL,
  transaction_type            transaction_type NOT NULL,
  occupancy                   occupancy_type NOT NULL,
  product_code                text,
  status                      text NOT NULL DEFAULT 'started',          -- state machine in 21.x/23.x
  application_date            date,                                     -- Reg B receipt date (21.1)
  trid_application_date       date,                                     -- six items received (21.2)
  hmda_application_date       date,                                     -- 28.3 reads
  application_received_at     timestamptz,
  trid_received_at            timestamptz,
  mlo_of_record_id            text,                                     -- partner-employed/sponsored MLO (addendum §8.1)
  mlo_nmlsr_id                text,
  ai_intake_mode              text NOT NULL DEFAULT 'assisted' CHECK (ai_intake_mode IN ('assisted', 'supervised_present', 'autonomous')),
  intake_channel              text CHECK (intake_channel IN ('voice', 'chat', 'web', 'human_agent')),
  interview_language          text,                                     -- BCP-47
  urla_form_version           text NOT NULL DEFAULT '1/2021',
  ulad_version                text NOT NULL DEFAULT 'MISMO 3.4 B324',
  six_items                   jsonb NOT NULL DEFAULT '{}',              -- {name, income, ssn, property_address, property_value_estimate, loan_amount_sought} → {submitted_at, source, value_hash}
  prior_loan_id               uuid REFERENCES loans(id),                -- refinance of a loan on the subserviced book (20.x → 16.x payoff)
  loan_id                     uuid REFERENCES loans(id),                -- set at funding when the servicing row is created (30.2)
  retention_class             retention_class NOT NULL DEFAULT 'ecoa_25m',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_partner_idx ON applications(partner_party_id, status);
CREATE INDEX applications_loan_idx ON applications(loan_id) WHERE loan_id IS NOT NULL;
CREATE INDEX applications_prior_loan_idx ON applications(prior_loan_id) WHERE prior_loan_id IS NOT NULL;

CREATE TABLE application_borrowers (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  borrower_id                     uuid REFERENCES borrowers(id),        -- linked to the servicing party at funding
  borrower_role                   text NOT NULL DEFAULT 'borrower' CHECK (borrower_role IN ('borrower', 'co_borrower', 'non_occupant_co_borrower', 'non_borrowing_spouse', 'trustee')),
  legal_name                      text NOT NULL,
  tin_encrypted                   bytea,
  tin_last4                       char(4),
  date_of_birth                   date,
  marital_status                  text CHECK (marital_status IN ('married', 'unmarried', 'separated')),
  unmarried_addendum_required     boolean NOT NULL DEFAULT false,
  citizenship_status              text CHECK (citizenship_status IN ('us_citizen', 'permanent_resident', 'non_permanent_resident')),
  legal_presence_evidence_document_id uuid REFERENCES documents(id),
  legal_presence_expires_on       date,
  language_preference             text,                                 -- Form 1103 SCIF
  homeownership_education         jsonb NOT NULL DEFAULT '{}',          -- Form 1103 SCIF
  joint_intent_affirmed_at        timestamptz,
  contact                         jsonb NOT NULL DEFAULT '{}',          -- addresses, phones, emails (pii)
  created_at                      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_borrowers_app_idx ON application_borrowers(application_id);

-- Demographic information (Reg C §1003.4(a)(10), Appendix B): restricted, access-logged, never derived by the platform.
CREATE TABLE restricted_fl.applicant_demographics (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_borrower_id   uuid NOT NULL REFERENCES application_borrowers(id),
  ethnicity                 jsonb,
  race                      jsonb,
  sex                       text,
  age                       int,
  declined_ethnicity        boolean NOT NULL DEFAULT false,
  declined_race             boolean NOT NULL DEFAULT false,
  declined_sex              boolean NOT NULL DEFAULT false,
  visual_observation_used   boolean NOT NULL DEFAULT false,             -- only lawful for in-person applications
  collection_channel        text NOT NULL CHECK (collection_channel IN ('in_person', 'telephone', 'internet', 'mail')),
  collected_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applicant_demographics_no_observation_remote CHECK (NOT visual_observation_used OR collection_channel = 'in_person'),
  CONSTRAINT applicant_demographics_declined_ethnicity CHECK (NOT declined_ethnicity OR ethnicity IS NULL),
  CONSTRAINT applicant_demographics_declined_race CHECK (NOT declined_race OR race IS NULL)
);
CREATE TRIGGER applicant_demographics_immutable BEFORE UPDATE OR DELETE ON restricted_fl.applicant_demographics FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation();

CREATE TABLE application_properties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  property_id           uuid REFERENCES properties(id),                 -- linked to the servicing property at funding
  address_line1         text, address_line2 text, city text, state char(2), postal_code text, county text,
  property_type         text,                                           -- sfr | condo | pud | 2_4_unit | manufactured
  units                 int,
  estimated_value_cents bigint,
  is_subject            boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_properties_app_idx ON application_properties(application_id);

CREATE TABLE application_income (                                       -- per source, versioned (22.3 writes the calculation)
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  application_borrower_id uuid NOT NULL REFERENCES application_borrowers(id),
  version               int NOT NULL DEFAULT 1,
  source_kind           text NOT NULL,                                  -- base | overtime | bonus | commission | self_employment | rental | retirement | other
  employer              jsonb NOT NULL DEFAULT '{}',
  monthly_amount_cents  bigint NOT NULL CHECK (monthly_amount_cents >= 0),
  qualifying            boolean NOT NULL DEFAULT true,
  calculation           jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_income_app_idx ON application_income(application_id);

CREATE TABLE application_assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  application_borrower_id uuid REFERENCES application_borrowers(id),
  asset_kind            text NOT NULL,                                  -- checking | savings | retirement | gift | proceeds_of_sale | other
  institution           text,
  account_last4         char(4),
  balance_cents         bigint NOT NULL CHECK (balance_cents >= 0),
  verified              boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_assets_app_idx ON application_assets(application_id);

CREATE TABLE application_liabilities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  application_borrower_id uuid REFERENCES application_borrowers(id),
  liability_kind        text NOT NULL,                                  -- mortgage | heloc | installment | revolving | lease | alimony | child_support | other
  creditor_name         text,
  monthly_payment_cents bigint NOT NULL DEFAULT 0 CHECK (monthly_payment_cents >= 0),
  balance_cents         bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  paid_at_closing       boolean NOT NULL DEFAULT false,
  source                text NOT NULL DEFAULT 'credit_report',          -- credit_report | borrower_stated | reo
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_liabilities_app_idx ON application_liabilities(application_id);

CREATE TABLE application_reo (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  application_borrower_id uuid REFERENCES application_borrowers(id),
  address               jsonb NOT NULL,
  property_status       text NOT NULL,                                  -- retained | sold | pending_sale
  occupancy             occupancy_type,
  market_value_cents    bigint,
  mortgage_payment_cents bigint NOT NULL DEFAULT 0,
  rental_income_cents   bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE declarations (                                             -- URLA section 5, per borrower
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  application_borrower_id uuid NOT NULL REFERENCES application_borrowers(id),
  answers               jsonb NOT NULL,                                 -- {occupy_as_primary, ownership_interest_3y, ..., bankruptcy_7y, ...}
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_contracts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id),
  document_id           uuid REFERENCES documents(id),
  sales_price_cents     bigint NOT NULL CHECK (sales_price_cents > 0),
  seller_concessions_cents bigint NOT NULL DEFAULT 0,
  contract_date         date,
  closing_date          date,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- shared tables: keyed by application before funding
ALTER TABLE loans ADD COLUMN origination_application_id uuid REFERENCES applications(id);
CREATE UNIQUE INDEX loans_origination_application_idx ON loans(origination_application_id) WHERE origination_application_id IS NOT NULL;
-- A newly originated loan has no Fannie Mae loan number until purchase (30.1 records it); a transferred-in loan always has one (HF-001).
ALTER TABLE loans ALTER COLUMN fnma_loan_number DROP NOT NULL;
ALTER TABLE loans ADD CONSTRAINT loans_fnma_number_after_purchase CHECK (fnma_loan_number IS NOT NULL OR origination_application_id IS NOT NULL);

ALTER TABLE loan_events ADD COLUMN application_id uuid REFERENCES applications(id);
CREATE INDEX loan_events_application_idx ON loan_events(application_id, sequence) WHERE application_id IS NOT NULL;

ALTER TABLE consents ALTER COLUMN loan_id DROP NOT NULL;
ALTER TABLE consents ADD COLUMN application_id uuid REFERENCES applications(id);
ALTER TABLE consents ADD CONSTRAINT consents_keyed CHECK (loan_id IS NOT NULL OR application_id IS NOT NULL);

ALTER TABLE documents ADD COLUMN application_id uuid REFERENCES applications(id);
CREATE INDEX documents_application_idx ON documents(application_id) WHERE application_id IS NOT NULL;

ALTER TABLE escalations ADD COLUMN application_id uuid REFERENCES applications(id);
ALTER TABLE agent_decisions ADD COLUMN application_id uuid REFERENCES applications(id);
ALTER TABLE timers ADD COLUMN application_id uuid REFERENCES applications(id);
CREATE INDEX timers_application_idx ON timers(application_id) WHERE application_id IS NOT NULL;

-- ---------------------------------------------------------------- 1.1's boarding pipeline, generalized (30.2)
ALTER TYPE boarding_status ADD VALUE IF NOT EXISTS 'boarded_with_warnings';
ALTER TABLE boarding_staging ALTER COLUMN batch_loan_id DROP NOT NULL;
ALTER TABLE boarding_staging ALTER COLUMN tape_id DROP NOT NULL;
ALTER TABLE boarding_staging ADD COLUMN application_id uuid REFERENCES applications(id);
ALTER TABLE boarding_staging ADD COLUMN source text NOT NULL DEFAULT 'transfer' CHECK (source IN ('transfer', 'origination'));
ALTER TABLE boarding_staging ADD CONSTRAINT boarding_staging_keyed CHECK ((source = 'transfer' AND batch_loan_id IS NOT NULL) OR (source = 'origination' AND application_id IS NOT NULL));
ALTER TABLE boarding_validations ADD COLUMN application_id uuid REFERENCES applications(id);
ALTER TABLE boarding_validations ALTER COLUMN batch_loan_id DROP NOT NULL;
CREATE INDEX boarding_validations_application_idx ON boarding_validations(application_id, rule_code) WHERE application_id IS NOT NULL;

-- ---------------------------------------------------------------- origination feature flags and rule sets (addendum §9)
CREATE TABLE feature_flags (
  key            text PRIMARY KEY,                                      -- origination.ai_mlo_intake, investor_reporting.escrow_events, ...
  value          jsonb NOT NULL,
  scope          text NOT NULL DEFAULT 'global',                        -- global | state:XX | partner:<id>
  memo_document_id uuid REFERENCES documents(id),                       -- e.g. the written state-specific memo an `autonomous` setting requires
  updated_by     text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO feature_flags(key, value, updated_by) VALUES ('origination.ai_mlo_intake', '"assisted"', 'migration:0057');
