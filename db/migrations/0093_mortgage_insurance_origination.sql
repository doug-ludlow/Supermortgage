-- 0093_mortgage_insurance_origination.sql — §24.6 Mortgage insurance at origination: quotes, coverage selection, the
-- certificate (baseline table, addendum §3: mi_company_code, certificate_number, coverage_pct, premium_plan,
-- activated_at) with its state machine, and the HPA §4903 / §4905 disclosures
-- (spec/sections/24-…/24-6-mortgage-insurance-ordering-coverage-selection-mi-types-bpmi.md "Data model").
-- Owned here: mi_certificates, mi_quotes, hpa_disclosures. Not here (other owners, never duplicated): mi_policies /
-- mi_schedules / mi_schedule_rows (servicing 10.x, 0012 — 30.4 seeds them from the certificate at boarding),
-- applications (0057), du_submissions.mi_requirement (0084), disclosures (0064), documents / parties (0001),
-- notices (0009), loans (0001). mi_quotes and hpa_disclosures are append-only (0001's forbid_mutation trigger): a
-- re-quote is a new row; the initial amortization schedule is immutable (schedule_version = 'initial', its hash
-- stored). mi_certificates carries the origination status machine and is superseded by 10.1's mi_policies row
-- once boarded. Retention: loan-file class fnma_loan_file_life_plus_4y.
BEGIN;

-- ---------------------------------------------------------------- mi_certificates (baseline; owned here)
CREATE TABLE mi_certificates (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),                   -- set by 30.2 at funding (hand-off)
  mi_company_code             text NOT NULL CHECK (mi_company_code IN ('01','06','12','33','37','38','43','44')),   -- Fannie Mae MI code, July 2025 approved list
  mi_company_party_id         uuid REFERENCES parties(id),
  quote_id                    uuid,                                        -- mi_quotes.id (nullable until a plan is selected)
  quote_rate_bps              int,
  quote_received_at           timestamptz,
  quote_expires_at            timestamptz,
  order_type                  text CHECK (order_type IN ('delegated','non_delegated')),
  du_reliance                 boolean NOT NULL DEFAULT false,              -- insurer program accepts DU Approve/Eligible
  du_casefile_id              text,
  submitted_at                timestamptz,
  commitment_number           text,
  commitment_issued_at        timestamptz,
  commitment_expires_at       timestamptz,
  certificate_number_enc      bytea,                                       -- encrypted (pii)
  coverage_pct                numeric(5,2) NOT NULL,
  coverage_option             text NOT NULL DEFAULT 'standard' CHECK (coverage_option IN ('standard','minimum')),
  llpa_min_coverage_bps       numeric(7,2),                                -- LLPA Matrix minimum-MI grid cell, e.g. 37.50
  premium_plan                text NOT NULL CHECK (premium_plan IN ('bpmi_monthly','bpmi_annual','bpmi_single','bpmi_split','financed_single','lpmi_monthly','lpmi_single')),  -- identical enum to mi_policies.premium_plan
  renewal_type                text CHECK (renewal_type IN ('constant','declining','level')),
  premium_rate_bps            int NOT NULL,
  monthly_premium_cents       bigint NOT NULL DEFAULT 0,
  upfront_premium_cents       bigint NOT NULL DEFAULT 0,
  financed_premium_cents      bigint NOT NULL DEFAULT 0,
  refundable                  boolean NOT NULL DEFAULT false,
  base_ltv_bps                int NOT NULL,                                -- truncated to two decimals of a percent (B2-1.2-01)
  base_ltv_pct_rounded        int NOT NULL,                                -- rounded up to the whole percent
  gross_ltv_pct_rounded       int,                                         -- with the financed premium (B7-1-04)
  property_value_basis_cents  bigint NOT NULL,                             -- lower of price / appraisal; appraisal for a refinance
  original_value_cents        bigint NOT NULL,                             -- HPA §4901(12)
  is_refinance                boolean NOT NULL DEFAULT false,
  hpa_covered                 boolean NOT NULL,                            -- 1 unit ∧ principal residence ∧ not lpmi_*
  high_risk                   boolean NOT NULL DEFAULT false,
  hpa_disclosure_kind         text CHECK (hpa_disclosure_kind IN ('initial_fixed','initial_arm','lpmi_commitment','fnma_only')),
  note_date                   date,
  activation_requested_at     timestamptz,
  activated_at                timestamptz,
  activation_effective_date   date,                                        -- = note date
  first_premium_due_date      date,
  remitted_at                 timestamptz,
  sfc_codes                   text[] NOT NULL DEFAULT '{}',                -- 019 (LPMI), 281 (financed MI)
  status                      text NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted','plan_selected','ordered','committed','docs_ready','activation_requested','active','declined','cancelled_pre_closing','expired')),
  cancel_reason               text,
  decline_reason              text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mi_certificates IS '24.6: MI quote → plan → order → commitment/certificate → activation at the note date; boarded to mi_policies (10.1) by 30.4; 30.2 OB-009 reads status ∈ {active, activation_requested}.';
COMMENT ON COLUMN mi_certificates.certificate_number_enc IS 'pii';
CREATE INDEX mi_certificates_app_idx ON mi_certificates(application_id, created_at);
CREATE UNIQUE INDEX mi_certificates_one_live ON mi_certificates(application_id) WHERE status IN ('plan_selected','ordered','committed','docs_ready','activation_requested','active');

-- ---------------------------------------------------------------- mi_quotes (new; append-only — a re-quote is a new row)
CREATE TABLE mi_quotes (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  mi_company_code             text NOT NULL CHECK (mi_company_code IN ('01','06','12','33','37','38','43','44')),
  request_payload_hash        text NOT NULL,                               -- MISMO 3.5 rate-quote request (idempotent per insurer)
  plan                        text NOT NULL CHECK (plan IN ('bpmi_monthly','bpmi_annual','bpmi_single','bpmi_split','financed_single','lpmi_monthly','lpmi_single')),
  coverage_pct                numeric(5,2) NOT NULL,
  coverage_option             text NOT NULL DEFAULT 'standard' CHECK (coverage_option IN ('standard','minimum')),
  rate_bps                    int NOT NULL,                                -- the insurer's rate — premiums are never derived from an internal table
  renewal_rate_bps            int,
  renewal_type                text CHECK (renewal_type IN ('constant','declining','level')),
  premium_cents               bigint NOT NULL,                             -- monthly for monthly plans, upfront for single / financed
  monthly_premium_cents       bigint NOT NULL DEFAULT 0,
  upfront_premium_cents       bigint NOT NULL DEFAULT 0,
  refundable                  boolean NOT NULL DEFAULT false,
  quoted_at                   timestamptz NOT NULL,
  expires_at                  timestamptz NOT NULL,
  selected                    boolean NOT NULL DEFAULT false,
  selected_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mi_quotes IS '24.6: MI rate quotes (≥ 2 approved insurers when available) priced from each insurer''s own rate; the selected row is the plan the LE/CD shows.';
CREATE INDEX mi_quotes_app_idx ON mi_quotes(application_id, quoted_at);
CREATE TRIGGER mi_quotes_immutable BEFORE UPDATE OR DELETE ON mi_quotes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- hpa_disclosures (new; the rendered disclosure and its initial schedule are immutable; delivered_at set once)
CREATE TABLE hpa_disclosures (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  mi_certificate_id           uuid NOT NULL REFERENCES mi_certificates(id),
  kind                        text NOT NULL CHECK (kind IN ('initial_fixed','initial_arm','lpmi_commitment')),
  notice_code                 text NOT NULL CHECK (notice_code IN ('NTC_HPA_4903_INITIAL_FIXED','NTC_HPA_4903_INITIAL_ARM','NTC_HPA_4905_LPMI')),
  notice_id                   uuid REFERENCES notices(id),
  amortization_schedule_document_id uuid REFERENCES documents(id),        -- fixed-rate: the written initial amortization schedule
  schedule_version            text NOT NULL DEFAULT 'initial' CHECK (schedule_version = 'initial'),   -- 10.1 mi_schedules.basis = 'initial'
  schedule_hash               text,                                       -- sha256 of the 360 rows (litigation evidence)
  cancellation_date           date,                                       -- scheduled 80% date (§4901(2))
  termination_date            date,                                       -- scheduled 78% date (§4901(18)); LPMI: the BPMI-equivalent date
  midpoint_termination_date   date NOT NULL,                              -- §4901(7) / §4902(c)
  original_value_cents        bigint NOT NULL,
  rendered_at                 timestamptz NOT NULL,
  delivered_at                timestamptz,                                -- = consummation_at for initial_*; ≤ the commitment letter for lpmi_commitment
  payload                     jsonb NOT NULL,                             -- the rendered payload (dates, thresholds, schedule rows)
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE hpa_disclosures IS '24.6: HPA §4903(a)(1) initial disclosure (fixed: initial amortization schedule + notice; ARM: notice) delivered at consummation, and the §4905(c) LPMI disclosure delivered no later than the commitment.';
CREATE INDEX hpa_disclosures_app_idx ON hpa_disclosures(application_id, rendered_at);
-- delivered_at is written once at consummation; the schedule itself is immutable (schedule_version fixed at 'initial', hash + document row).
CREATE OR REPLACE FUNCTION hpa_disclosures_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'hpa_disclosures is append-only'; END IF;
  IF NEW.schedule_hash IS DISTINCT FROM OLD.schedule_hash OR NEW.cancellation_date IS DISTINCT FROM OLD.cancellation_date OR NEW.termination_date IS DISTINCT FROM OLD.termination_date OR NEW.midpoint_termination_date IS DISTINCT FROM OLD.midpoint_termination_date OR NEW.payload IS DISTINCT FROM OLD.payload OR OLD.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'hpa_disclosures: the rendered disclosure and its initial schedule are immutable (only delivered_at may be set once)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hpa_disclosures_immutable BEFORE UPDATE OR DELETE ON hpa_disclosures FOR EACH ROW EXECUTE FUNCTION hpa_disclosures_guard();

COMMIT;
