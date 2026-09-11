-- 0064_loan_estimate.sql — §21.2 TRID application receipt, application date and the Loan Estimate
-- (spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-2-*.md; addendum §3 "Disclosures and fees").
-- The shared origination disclosure tables the addendum names (`disclosures`, `fee_items`, `apr_calculations`) plus 21.2's own
-- `settlement_service_provider_lists` and `creditor_calendars`, and the LE columns 21.2 adds to `applications`. Additive only:
-- `applications` and its children are 0057's; `consents`, `documents`, `escalations` are 0001/0019's with the 0057 application key.
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regz_le_3y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'fnma_loan_file_life_plus_4y';

-- ---------------------------------------------------------------- creditor calendars (rule 1; open question 1)
CREATE TABLE creditor_calendars (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_party_id        uuid NOT NULL REFERENCES parties(id),
  calendar_code           text NOT NULL DEFAULT 'creditor' CHECK (calendar_code = 'creditor'),
  time_zone               text NOT NULL,                                        -- IANA zone the §1026.37(a)(13) times are stated in (America/Phoenix for the fixture)
  open_weekdays           int[] NOT NULL DEFAULT '{1,2,3,4,5}',                 -- ISO weekday numbers; 6 present = saturday_open
  saturday_open           boolean NOT NULL DEFAULT false,
  open_on_holidays        date[] NOT NULL DEFAULT '{}',                         -- federal holidays the partner declares open (e.g. Columbus Day)
  closure_dates           date[] NOT NULL DEFAULT '{}',                         -- published closures beyond weekends + federal holidays
  effective_from          date NOT NULL,
  effective_to            date,
  created_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE creditor_calendars IS '21.2 rule 1: the partner''s declared Reg Z §1026.2(a)(6) general business-day calendar (`business_days_creditor`); Saturday/holiday openings only shorten deadlines. The specific-definition calendar (`regz_specific`, Saturdays count) is code, not data.';
CREATE UNIQUE INDEX creditor_calendars_partner_idx ON creditor_calendars(partner_party_id, effective_from);

-- ---------------------------------------------------------------- disclosures (addendum §3; 21.2 columns for kind='le')
CREATE TABLE disclosures (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),                        -- set by 30.2 at hand-off
  kind                        text NOT NULL CHECK (kind IN ('le', 'cd', 'corrected_cd', 'seller_cd', 'sds', 'hcl', 'toolkit', 'afba', 'regb_appraisal_notice', 'credit_score_notice', 'rbp_notice', 'arm_program', 'charm', 'privacy', 'rescission_h8', 'rescission_h9', 'hpa_initial', 'initial_escrow_stmt', 'flood_notice') OR kind ~ '^state:[A-Z]{2}$'),
  version                     int NOT NULL DEFAULT 1,
  le_version                  int,                                              -- 1 for the initial LE; 21.5 increments
  basis                       text CHECK (basis IN ('initial', 'revised')),
  status                      text NOT NULL DEFAULT 'assembling' CHECK (status IN ('assembling', 'rendered', 'pending_mlo', 'approved', 'delivered', 'mailed', 'received', 'deemed_received', 'superseded', 'withdrawn_application', 'exempt', 'satisfied_by_le')),
  rendered_document_id        uuid REFERENCES documents(id),
  rendered_at                 timestamptz,
  template_version            text,                                             -- 'H-24 2017'
  data_hash                   char(64),                                         -- sha256 of the rendered data set; the MLO approves this exact hash
  delivered_at                timestamptz,
  delivery_channel            text CHECK (delivery_channel IN ('esign_portal', 'email', 'mail', 'in_person', 'courier')),
  mailed_at                   timestamptz,                                      -- print vendor's mailing-date evidence
  mailing_proof_document_id   uuid REFERENCES documents(id),
  deemed_receipt_date         date,                                             -- delivery/mailing date + 3 business_days_regz_specific when not in person
  received_at                 timestamptz,                                      -- evidence-based
  receipt_evidence            text CHECK (receipt_evidence IN ('esign_confirmed', 'mailbox_rule', 'in_person', 'courier')),
  effective_receipt_date      date,                                             -- received_at::date if evidence else deemed_receipt_date
  esign_consent_id            uuid REFERENCES consents(id),                     -- unrevoked, scoped to disclosures, dated before delivered_at
  rate_locked                 boolean,
  lock_expires_at             timestamptz,
  closing_costs_expire_at     timestamptz,                                      -- §1026.37(a)(13)(ii): 10 creditor BD, 5:00 p.m. creditor time; blank after intent (21.4)
  time_zone                   text,
  servicing_intent            text CHECK (servicing_intent IN ('service', 'transfer')),
  creditor_nmlsr_id           text,
  loan_officer_name           text,
  loan_officer_nmlsr_id       text,
  mlo_review_id               text,                                             -- 21.1 mlo_reviews (stage le_terms) approving data_hash
  apr_calculation_id          uuid,                                             -- FK added below
  tip_pct                     numeric(7,3),
  in_5y_total_cents           bigint,
  in_5y_principal_cents       bigint,
  loan_costs_total_cents      bigint,
  other_costs_total_cents     bigint,
  lender_credits_cents        bigint CHECK (lender_credits_cents IS NULL OR lender_credits_cents <= 0),
  cash_to_close_cents         bigint,
  earliest_consummation_date  date,                                             -- delivery/mailing + 7 business_days_regz_specific (initial LE governs)
  waiver_consent_id           uuid REFERENCES consents(id),                     -- §1026.19(e)(1)(v) emergency statement (kind trid_7day_waiver)
  superseded_by_id            uuid REFERENCES disclosures(id),
  exemption_reason            text,                                             -- 21.3 rows: refinance_no_toolkit, reverse_only, …
  satisfied_by_disclosure_id  uuid REFERENCES disclosures(id),                  -- 21.3 Reg B / HPML rows satisfied by the LE
  retention_class             retention_class NOT NULL DEFAULT 'regz_le_3y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disclosures_le_version_keyed CHECK (kind <> 'le' OR (le_version IS NOT NULL AND basis IS NOT NULL)),
  CONSTRAINT disclosures_electronic_needs_consent CHECK (delivery_channel IS NULL OR delivery_channel NOT IN ('esign_portal', 'email') OR delivered_at IS NULL OR esign_consent_id IS NOT NULL)
);
COMMENT ON TABLE disclosures IS 'addendum §3 disclosures + 21.2 LE columns: one row per rendered version (an LE never changes after delivery — a revision is a new row, superseded_by_id links the lineage); delivery/receipt evidence per §1026.19(e)(1)(iii)–(iv); retention regz_le_3y (documents also carry fnma_loan_file_life_plus_4y).';
CREATE INDEX disclosures_application_idx ON disclosures(application_id, kind, le_version);
CREATE UNIQUE INDEX disclosures_initial_le_idx ON disclosures(application_id) WHERE kind = 'le' AND le_version = 1;

-- ---------------------------------------------------------------- APR calculations (rule 9; 25.1 re-tests against §1026.22)
CREATE TABLE apr_calculations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  disclosure_id               uuid REFERENCES disclosures(id),
  method                      text NOT NULL CHECK (method IN ('appendix_j_exact', 'appendix_j_disregard_17c4')),
  loan_amount_cents           bigint NOT NULL,
  note_rate_pct               numeric(7,4) NOT NULL,
  term_months                 int NOT NULL,
  payment_cents               bigint NOT NULL,                                  -- P&I (+ MI) in the stream
  prepaid_finance_charge_cents bigint NOT NULL,
  amount_financed_cents       bigint NOT NULL,
  finance_charge_cents        bigint NOT NULL,
  odd_days                    int NOT NULL DEFAULT 0,
  odd_fraction                numeric(12,10) NOT NULL DEFAULT 0,
  unit_period_rate            numeric(18,12) NOT NULL,
  apr_pct                     numeric(10,6) NOT NULL,
  apr_disclosed_pct           numeric(7,3) NOT NULL,
  tip_pct                     numeric(7,3),
  inputs                      jsonb NOT NULL DEFAULT '{}',                      -- fee_items ids and finance-charge flags
  tolerance_class             text CHECK (tolerance_class IN ('eighth', 'quarter', 'a4', 'a5')),
  rule_set_version            text NOT NULL DEFAULT 'regz.trid.2017',
  computed_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE apr_calculations IS '21.2 rule 9 / 25.1: Appendix J actuarial APR on the amount financed (loan − prepaid finance charges), inputs and method stored; append-only.';
CREATE INDEX apr_calculations_disclosure_idx ON apr_calculations(disclosure_id);
CREATE TRIGGER apr_calculations_immutable BEFORE UPDATE OR DELETE ON apr_calculations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE disclosures ADD CONSTRAINT disclosures_apr_fk FOREIGN KEY (apr_calculation_id) REFERENCES apr_calculations(id);

-- ---------------------------------------------------------------- fee items (addendum §3; 21.2 columns; 21.5 tolerance tests read these)
CREATE TABLE fee_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  fee_code                    text NOT NULL,
  description                 text NOT NULL,
  le_section                  text NOT NULL CHECK (le_section IN ('A_origination', 'B_cannot_shop', 'C_can_shop', 'E_taxes_gov', 'F_prepaids', 'G_initial_escrow', 'H_other', 'J_lender_credit')),
  mismo_fee_type              text NOT NULL,                                    -- MISMO 3.4 FeeType / PrepaidItemType / EscrowItemType (UCD-compatible)
  provider_source             text NOT NULL CHECK (provider_source IN ('creditor', 'affiliate', 'creditor_selected_third_party', 'list_provider', 'consumer_selected_off_list', 'government', 'none')),
  shoppable                   boolean NOT NULL DEFAULT false,
  tolerance_class             text CHECK (tolerance_class IN ('zero', 'ten_percent', 'unlimited')),
  baseline_amount_cents       bigint,
  baseline_disclosure_id      uuid REFERENCES disclosures(id),                  -- the LE that set the baseline (fee.baseline.set)
  current_amount_cents        bigint NOT NULL,
  paid_by                     text NOT NULL DEFAULT 'borrower' CHECK (paid_by IN ('borrower', 'seller', 'lender', 'other')),
  paid_to                     text,
  estimate_source             text NOT NULL CHECK (estimate_source IN ('pricing_engine', 'fee_schedule', 'vendor_quote', 'county_table', 'tax_bill', 'insurance_policy', 'borrower_stated', 'default_table')),
  estimate_source_ref         text NOT NULL,
  estimated_at                date NOT NULL,
  finance_charge              boolean NOT NULL DEFAULT false,                   -- APR input
  changed_circumstance_id     uuid,                                             -- 21.5 changed_circumstances
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_items_sign CHECK ((le_section = 'J_lender_credit' AND current_amount_cents <= 0) OR (le_section <> 'J_lender_credit' AND current_amount_cents >= 0))
);
COMMENT ON TABLE fee_items IS 'addendum §3 fee_items with 21.2 columns: MISMO loan-cost taxonomy, provider source, estimate source/ref/date (rule 5 freshness), finance-charge flag, tolerance class written at fee.baseline.set (rule 4).';
CREATE INDEX fee_items_application_idx ON fee_items(application_id, le_section);
CREATE UNIQUE INDEX fee_items_code_idx ON fee_items(application_id, fee_code, baseline_disclosure_id);

-- ---------------------------------------------------------------- written list of providers (§1026.19(e)(1)(vi)(C))
CREATE TABLE settlement_service_provider_lists (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  disclosure_id               uuid NOT NULL REFERENCES disclosures(id),
  services                    jsonb NOT NULL,                                   -- [{service, providers:[{party_id, name, affiliate boolean, estimated_fee_cents}]}]
  rendered_document_id        uuid REFERENCES documents(id),
  delivered_with_le           boolean NOT NULL DEFAULT true,
  delivered_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE settlement_service_provider_lists IS '21.2: the written list of settlement service providers delivered with the LE (NTC_REGZ_1026_19E1VI_PROVIDER_LIST); at least one available provider per shoppable service, affiliates flagged.';
CREATE INDEX sspl_disclosure_idx ON settlement_service_provider_lists(disclosure_id);

-- ---------------------------------------------------------------- applications: the 21.2 columns (trid_application_date is 0057's)
ALTER TABLE applications ADD COLUMN le_due_at timestamptz;                                          -- end of the third creditor business day
ALTER TABLE applications ADD COLUMN initial_le_disclosure_id uuid REFERENCES disclosures(id);
ALTER TABLE applications ADD COLUMN earliest_consummation_date date;                                -- initial LE delivery/mailing + 7 business_days_regz_specific
ALTER TABLE applications ADD COLUMN creditor_calendar_id uuid REFERENCES creditor_calendars(id);
COMMENT ON COLUMN applications.le_due_at IS '21.2 rule 2: le_due_at = end_of_day(nth_business_day(trid_application_date, 3, creditor)) in the creditor time zone';
COMMENT ON COLUMN applications.earliest_consummation_date IS '21.2: REGZ_1026_19E1III_LE_7SBD_GATE date — the initial LE governs; revised LEs do not restart the period (open question 5)';

COMMIT;
