-- 0103: 29.1 Committing and pricing execution — `commitments` (baseline §3; column set owned by 29.1) with its children
-- (`commitment_modifications`, `commitment_extensions`, `commitment_pair_offs`, `commitment_over_deliveries`,
-- `committing_fee_drafts`, `pewl_price_captures`) and the baseline `hedge_positions` table (29.2 owns the column set
-- — addendum §3 names both under "Pricing and secondary"; 29.2 adds its own children in 0104). `locks.commitment_id`
-- (0066) points here. Money in bigint cents; prices as percent of par to 5 dp as stored (3 dp as quoted by PE–WL);
-- rates 4 dp; every Fannie Mae timestamp is ET. Child rows and price captures are append-only (forbid_mutation).
BEGIN;

CREATE TABLE commitments (
  commitment_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                    text NOT NULL,
  commitment_id_fnma            text UNIQUE,                                          -- Fannie Mae commitment number (from the Loan Committing confirmation / PE–WL UI)
  type                          text NOT NULL CHECK (type IN ('best_efforts', 'mandatory')),
  execution_channel             text NOT NULL DEFAULT 'api' CHECK (execution_channel IN ('api', 'ui_operator', 'sales_desk')),
  application_id                uuid REFERENCES applications(id),                     -- best efforts (null for mandatory)
  loan_id                       uuid REFERENCES loans(id),                            -- set at funding (30.2)
  lock_id                       uuid REFERENCES locks(lock_id),
  lineage_id                    uuid,                                                 -- 21.4; one open commitment per lineage
  du_casefile_id                text,
  underwriting_method           text NOT NULL DEFAULT 'du' CHECK (underwriting_method IN ('du', 'other')),
  du_recommendation_at          timestamptz,
  product_code                  text NOT NULL,
  fnma_product_name             text NOT NULL,
  amortization                  text NOT NULL DEFAULT 'fixed' CHECK (amortization IN ('fixed', 'arm_5_6', 'arm_7_6', 'arm_10_6')),
  term_months                   int NOT NULL DEFAULT 360,
  note_rate                     numeric(6,4) NOT NULL,
  servicing_fee_bps             int NOT NULL DEFAULT 25 CHECK (servicing_fee_bps BETWEEN 25 AND 50),
  lpmi_bps                      int NOT NULL DEFAULT 0,
  pass_through_rate             numeric(6,4) NOT NULL,                                -- note_rate − servicing fee − LPMI (rule 3)
  ptr_range_low                 numeric(6,4),                                         -- mandatory: five consecutive PTRs (50 bp range)
  ptr_range_high                numeric(6,4),
  remittance_type               text NOT NULL DEFAULT 'actual_actual' CHECK (remittance_type IN ('actual_actual', 'scheduled_scheduled', 'scheduled_actual')),
  servicing_option              text NOT NULL DEFAULT 'retained' CHECK (servicing_option = 'retained'),
  amount_cents                  bigint NOT NULL CHECK (amount_cents > 0),             -- best efforts: current loan amount
  max_amount_cents              bigint NOT NULL CHECK (max_amount_cents >= amount_cents), -- best efforts: maximum over the life (the fee base)
  original_amount_cents         bigint NOT NULL,                                      -- mandatory: the committed amount (tolerance base)
  remaining_balance_cents       bigint NOT NULL DEFAULT 0,
  purchased_cents               bigint NOT NULL DEFAULT 0,
  paired_off_cents              bigint NOT NULL DEFAULT 0,
  over_delivered_cents          bigint NOT NULL DEFAULT 0,
  tolerance_low_cents           bigint,                                               -- mandatory: original − max($10,000, 2.5%) (C2-2-01)
  tolerance_high_cents          bigint,
  hbl_cap_pct                   numeric(5,2),
  commitment_price              numeric(9,5) NOT NULL DEFAULT 0,
  quote_id_fnma                 text,
  quoted_at                     timestamptz,
  quote_expires_at              timestamptz,
  executed_at                   timestamptz,
  effective_on                  date,
  commitment_period_days        int,
  expires_on                    date,                                                 -- a fannie_sifma business day (as extended)
  original_expires_on           date,
  manual_extension_days         int NOT NULL DEFAULT 0 CHECK (manual_extension_days BETWEEN 0 AND 30),
  auto_extension_days           int NOT NULL DEFAULT 0 CHECK (auto_extension_days BETWEEN 0 AND 60),
  closed_status_set_at          timestamptz,
  fnma_loan_status              text CHECK (fnma_loan_status IN ('committed', 'closed', 'fallout', 'expired', 'purchase_requested', 'purchase_ready', 'purchased')),
  status                        text NOT NULL CHECK (status IN ('requested', 'priced', 'queued', 'executed', 'unconfirmed', 'committed', 'closed', 'delivered', 'purchased', 'paired_off', 'fallout', 'expired', 'rejected', 'authorized', 'open', 'fulfilled', 'auto_paired_off')),
  pair_off_terms                jsonb,
  fallout_reason                text CHECK (fallout_reason IN ('borrower_withdrawal', 'lender_declination', 'ineligible_key_data_change', 'auto_expired', 'failure_to_deliver', 'address_change_recommit', 'uw_method_change_recommit')),
  pair_off_expected             boolean,
  dpa_exposure_until            date,                                                 -- fallout/expiration + 30 calendar days (C2-1.2-02 duplicate price adjustment)
  duplicate_of_commitment_id    uuid REFERENCES commitments(commitment_id),
  expected_purchase_ready_date  date,
  llpa_forecast_pct             numeric(6,3),
  llpa_forecast_cents           bigint,
  credits_forecast_cents        bigint NOT NULL DEFAULT 0,
  net_price_forecast            numeric(9,5),
  proceeds_forecast_cents       bigint,
  execution_variance_cents      bigint,                                               -- commitment price vs pricing_quotes.base_price (rule 6)
  confirmation_document_id      uuid REFERENCES documents(id),
  email_confirmation_document_id uuid REFERENCES documents(id),
  agent_decision_id             uuid REFERENCES agent_decisions(id),
  borrower_last_name            text,                                                 -- PII (as PE–WL requires)
  property_address              text,                                                 -- PII (as PE–WL requires)
  disbursement_date             date,
  first_payment_date            date,
  queued_release_at             timestamptz,
  overnight_price_change        numeric(9,5),
  sfcs_staged                   text[] NOT NULL DEFAULT '{}',
  recorded_by                   text NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CHECK (type <> 'best_efforts' OR application_id IS NOT NULL),
  CHECK (type <> 'mandatory' OR (ptr_range_low IS NOT NULL AND ptr_range_high IS NOT NULL)),
  CHECK (expires_on IS NULL OR effective_on IS NULL OR expires_on - effective_on <= 90)
);
COMMENT ON TABLE commitments IS '29.1 data model: PE–Whole Loan commitments in the partner''s name — best efforts (per lock lineage; requested → priced → executed → committed → closed → purchased | paired_off; fallout/expired open the 30-day DPA window) and mandatory (flag-gated; authorized → open → fulfilled | paired_off). Retention fnma_loan_file_life_plus_4y; PII only on borrower_last_name / property_address.';
CREATE UNIQUE INDEX commitments_one_open_per_lineage ON commitments(lineage_id) WHERE lineage_id IS NOT NULL AND status IN ('executed', 'unconfirmed', 'committed', 'closed', 'delivered');
CREATE INDEX commitments_app_idx ON commitments(application_id);
CREATE INDEX commitments_expiry_idx ON commitments(expires_on) WHERE status IN ('committed', 'closed', 'delivered', 'open');
CREATE INDEX commitments_dpa_idx ON commitments(borrower_last_name, property_address, dpa_exposure_until) WHERE dpa_exposure_until IS NOT NULL;

-- Rule 7: every key-data change reported through PE–WL within FNMA_C2_1_2_03_KEY_DATA_CHANGE_1BD. Append-only.
CREATE TABLE commitment_modifications (
  modification_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id              uuid NOT NULL REFERENCES commitments(commitment_id),
  changed_at                 timestamptz NOT NULL,                                    -- source event time
  reported_at                timestamptz NOT NULL,
  due_at                     timestamptz NOT NULL,                                    -- +1 business_days_fannie_et, 17:00 ET
  fields                     jsonb NOT NULL,                                          -- {before, after} over loan_amount_cents, product_code, note_rate, units, seller_loan_number, loan_status
  repriced                   boolean NOT NULL DEFAULT false,
  new_commitment_price       numeric(9,5),
  worst_case_applied         boolean NOT NULL DEFAULT false,
  channel                    text NOT NULL CHECK (channel IN ('api', 'ui_operator', 'sales_desk')),
  confirmation_document_id   uuid REFERENCES documents(id),
  late                       boolean NOT NULL DEFAULT false,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE commitment_modifications IS '29.1 rule 7: key-data modifications (loan amount, product, note rate, units, seller loan number, loan status); product/note-rate changes re-price at worse case (C2-1.2-03).';
CREATE TRIGGER commitment_modifications_immutable BEFORE UPDATE OR DELETE ON commitment_modifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rules 10, 12: manual extensions (≤ 30 days cumulative) and PE–WL automatic 1-day/5-day extensions (closed best efforts to 60 days). Append-only.
CREATE TABLE commitment_extensions (
  extension_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id              uuid NOT NULL REFERENCES commitments(commitment_id),
  kind                       text NOT NULL CHECK (kind IN ('manual', 'auto_1d', 'auto_5d')),
  days                       int NOT NULL CHECK (days > 0),
  per_diem_cents             numeric(14,2) NOT NULL,                                  -- max_amount × max_ptr / 360 (best efforts); remaining × min_ptr / 360 (mandatory)
  fee_cents                  bigint NOT NULL CHECK (fee_cents >= 0),
  requested_at               timestamptz NOT NULL,
  new_expires_on             date NOT NULL,
  payer                      text NOT NULL CHECK (payer IN ('sm', 'partner')),
  confirmation_document_id   uuid REFERENCES documents(id),
  source                     text NOT NULL DEFAULT 'request' CHECK (source IN ('request', 'confirmation', 'draft')),
  escalation_id              uuid REFERENCES escalations(id),
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE commitment_extensions IS '29.1 rules 10/12: extension fee arithmetic on the 360-day count (C2-1.1-02; PE–WL guide); payer per open question 3.';
CREATE TRIGGER commitment_extensions_immutable BEFORE UPDATE OR DELETE ON commitment_extensions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rules 11, 12: lender-requested and automatic pair-offs (fee ≥ 0; cash back mandatory only). Prepared → approved → executed; a status row per step.
CREATE TABLE commitment_pair_offs (
  pair_off_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id              uuid NOT NULL REFERENCES commitments(commitment_id),
  kind                       text NOT NULL CHECK (kind IN ('lender_requested', 'automatic')),
  amount_cents               bigint NOT NULL CHECK (amount_cents > 0),
  commitment_price           numeric(9,5) NOT NULL,
  market_price               numeric(9,5),
  fee_cents                  bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  cash_back_cents            bigint NOT NULL DEFAULT 0 CHECK (cash_back_cents >= 0),
  prepared_at                timestamptz NOT NULL,
  executed_at                timestamptz,
  payer                      text NOT NULL CHECK (payer IN ('sm', 'partner')),
  status                     text NOT NULL CHECK (status IN ('prepared', 'approved', 'executed')),
  approval_escalation_id     uuid REFERENCES escalations(id),                        -- officer_pair_off_approval (fee > threshold)
  operator_escalation_id     uuid REFERENCES escalations(id),                        -- fnma_portal_commitment_task (60-second acceptance)
  alternative                jsonb,                                                   -- the carry alternative shown in the package
  confirmation_document_id   uuid REFERENCES documents(id),
  source                     text NOT NULL DEFAULT 'package' CHECK (source IN ('package', 'draft')),
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE commitment_pair_offs IS '29.1 rules 11/12: pair-off fee on the maximum commitment amount (best efforts) or the paired-off amount (mandatory; cash back when the market fell — C2-1.1-04).';

-- Rule 12: mandatory over-deliveries (≤ 25% of the original amount). Append-only.
CREATE TABLE commitment_over_deliveries (
  over_delivery_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id              uuid NOT NULL REFERENCES commitments(commitment_id),
  amount_cents               bigint NOT NULL CHECK (amount_cents > 0),
  commitment_price           numeric(9,5) NOT NULL,
  market_price               numeric(9,5) NOT NULL,
  fee_cents                  bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  cash_back_cents            bigint NOT NULL DEFAULT 0 CHECK (cash_back_cents >= 0),
  executed_at                timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE commitment_over_deliveries IS '29.1 rule 12: over-delivery priced like a pair-off on the over-delivered amount; capped at 25% of the original commitment (C2-2-01).';
CREATE TRIGGER commitment_over_deliveries_immutable BEFORE UPDATE OR DELETE ON commitment_over_deliveries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rule 15: Committing & Delivery Fee Draft Notifications (daily JSON) reconciled to child rows within ±$1.00.
CREATE TABLE committing_fee_drafts (
  draft_id                   text PRIMARY KEY,                                        -- notification id (upsert key)
  notification_date          date NOT NULL,
  draft_date                 date NOT NULL,
  commitment_id_fnma         text NOT NULL,
  fnma_loan_number           char(10),
  fee_type                   text NOT NULL CHECK (fee_type IN ('extension', 'pair_off', 'duplicate_price_adjustment', 'over_delivery', 'post_purchase_adjustment', 'other')),
  amount_cents               bigint NOT NULL,                                         -- negative = cash back
  raw_document_id            uuid REFERENCES documents(id),
  reconciled_to              uuid,                                                    -- child row id (extension / pair-off / over-delivery)
  variance_cents             bigint,
  status                     text NOT NULL CHECK (status IN ('new', 'matched', 'exception')),
  ledger_set_id              uuid REFERENCES ledger_entry_sets(id),
  escalation_id              uuid REFERENCES escalations(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE committing_fee_drafts IS '29.1 rule 15: the fee draft is the truth — matched within ±$1.00 to a child row and posted (committing_fee_expense / partner_reimbursable_from_sm when SM bears; committing_fee_partner_draft; committing_cash_back_receivable), else committing_fee.exception → officer inquiry within 30 days.';
CREATE INDEX committing_fee_drafts_commitment_idx ON committing_fee_drafts(commitment_id_fnma, status);

-- Rule 4: raw Loan Pricing responses, pair-off/extension quotes and marks (retained 3 years). Append-only.
CREATE TABLE pewl_price_captures (
  capture_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id              uuid REFERENCES commitments(commitment_id),
  purpose                    text NOT NULL CHECK (purpose IN ('commitment', 'pair_off_quote', 'extension_quote', 'mark')),
  price                      numeric(9,5) NOT NULL,
  ptr                        numeric(6,4) NOT NULL,
  captured_at                timestamptz NOT NULL,
  source                     text NOT NULL CHECK (source IN ('api', 'ui', 'browse_export')),
  quote_id_fnma              text,
  quote_expires_at           timestamptz,
  close_of_business          boolean NOT NULL DEFAULT false,                          -- 5–8 p.m. ET prices are never executable
  raw                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pewl_price_captures IS '29.1 rule 4: every PE–WL price the agent acts on, stored raw with quote id and expiry; the commit call must reference an unexpired quote (FNMA_PEWL_COMMIT_ACCEPT_60S).';
CREATE TRIGGER pewl_price_captures_immutable BEFORE UPDATE OR DELETE ON pewl_price_captures FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Baseline §3 `hedge_positions` (mandatory only; 29.2 owns the column set — hedge_trades and the other 29.2 children arrive with 0104).
CREATE TABLE hedge_positions (
  position_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                 text NOT NULL,
  instrument                 text NOT NULL CHECK (instrument IN ('tba_umbs_30', 'tba_umbs_15', 'fnma_mandatory_commitment')),
  coupon                     numeric(5,3),
  settlement_month           date,
  sifma_class                text CHECK (sifma_class IN ('A', 'B')),
  notification_date          date,
  settlement_date            date,
  side                       text NOT NULL CHECK (side IN ('sell', 'buy')),
  face_cents                 bigint NOT NULL CHECK (face_cents > 0),
  trade_price                numeric(9,5),
  trade_date                 date,
  trade_time_et              time,
  counterparty_id            text NOT NULL,                                           -- 'fannie_mae' for commitments
  commitment_id              uuid REFERENCES commitments(commitment_id),              -- 29.1 mandatory commitment when the hedge is a Fannie Mae commitment
  status                     text NOT NULL CHECK (status IN ('open', 'rolled', 'paired_off', 'closed')),
  roll_due_on                date,
  mark_price                 numeric(9,5),
  mark_cents                 bigint,
  marked_at                  timestamptz,
  realized_pl_cents          bigint,
  authorized_by              text,
  agent_decision_id          uuid REFERENCES agent_decisions(id),
  confirmation_document_id   uuid REFERENCES documents(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE hedge_positions IS '29.2 data model (baseline §3): TBA forwards and Fannie Mae mandatory commitments hedging the mandatory pipeline; a position never transitions on an AI decision alone. Retention fnma_loan_file_life_plus_4y (commitment-linked) / sm_books_7y (dealer trades).';
CREATE INDEX hedge_positions_open_idx ON hedge_positions(status, settlement_month) WHERE status = 'open';

-- 29.1 ledger accounts (new, defined here).
INSERT INTO ledger_accounts (scope, account, kind, section, description) VALUES
  ('corporate', 'committing_fee_expense', 'expense', '29.1', 'PE–WL extension / pair-off / DPA fees SM bears (fulfillment cause — open question 3)'),
  ('corporate', 'committing_fee_partner_draft', 'liability', '29.1', 'fees drafted from the partner''s Fannie Mae draft account'),
  ('corporate', 'partner_reimbursable_from_sm', 'liability', '29.1', 'mirror of committing_fee_expense: what SM owes the partner for fees drafted from its account'),
  ('corporate', 'committing_cash_back_receivable', 'receivable', '29.1', 'mandatory pair-off / over-delivery cash back due from Fannie Mae (C2-1.1-04)');

COMMIT;
