-- 0074_pricing_engine.sql — §20.4 rate quote and pricing engine
-- (spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-4-*.md; addendum §3 "Pricing and secondary", §9 rule sets).
-- The addendum §3 baseline tables (`rate_sheets`, `llpa_tables`, `pricing_quotes`) and 20.4's own (`sm_cost_schedules`, `fee_schedules`,
-- `pricing_exceptions`), plus the `rule_sets` row `fnma.llpa.09.09.2026` the engine reads its grids from. Additive only: `applications`
-- is 0057's, `documents`/`rule_sets` are 0001/0006's; `lead_id` and `loan_id` are plain keys (20.3's `leads` migration lands in parallel;
-- `loans` exists from funding). Quote and exception lifecycles are recorded in `loan_events` (quote.created/presented/expired/superseded/locked,
-- pricing.exception.requested/approved/denied/decided); `pricing_exceptions` and `llpa_tables` verification rows are append-only.
BEGIN;

-- ───────────────────────────── rate sheets (rule 1) ─────────────────────────────
CREATE TABLE rate_sheets (
  rate_sheet_id             text PRIMARY KEY,
  partner_id                uuid REFERENCES parties(id),
  source                    text NOT NULL CHECK (source IN ('pe_whole_loan_api', 'browse_prices_export', 'partner_rate_sheet', 'manual_ui_read')),
  published_at              timestamptz NOT NULL,
  effective_from            timestamptz NOT NULL,
  expires_at                timestamptz NOT NULL,                              -- next publish or committing close (quote validity input)
  execution                 text NOT NULL DEFAULT 'best_efforts' CHECK (execution IN ('best_efforts', 'mandatory_indicative')),
  servicing_fee_bps         integer NOT NULL DEFAULT 25 CHECK (servicing_fee_bps BETWEEN 25 AND 50),   -- C3-1-01 minimum 25 / maximum 50
  prices                    jsonb NOT NULL,                                    -- [{product_code, term_months, amortization, note_rate (5 dp), pass_through_rate, lock_period_days, price (3 dp), pe_wl_quote_id, pe_wl_quote_expires_at}]
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'withdrawn')),
  published_by              text NOT NULL,                                     -- agent run / operator
  dual_entry_verified_by    text[] NOT NULL DEFAULT '{}',                      -- manual_ui_read: the two operators whose entries agreed
  stale                     boolean NOT NULL DEFAULT false,                    -- Friday's sheet carried through the weekend
  raw_response_document_id  uuid REFERENCES documents(id),                     -- raw API response / export retained 3 years
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > published_at),
  CHECK (source <> 'manual_ui_read' OR cardinality(dual_entry_verified_by) >= 2)
);
COMMENT ON TABLE rate_sheets IS '20.4 data model / addendum §3: one row per published sheet (daily 06:35 ET, intra-day ≥ 12.5 bps, fallback sources); prices carry note_rate, the 25 bps pass-through rate and the PE–WL quote ids; SM_RATE_SHEET_PUBLISH_DAILY re-arms from rate_sheet.published.';
CREATE INDEX rate_sheets_partner_active_idx ON rate_sheets(partner_id, status, published_at DESC);

-- ───────────────────────────── LLPA tables (rule 2; rule set fnma.llpa.<version>) ─────────────────────────────
CREATE TABLE llpa_tables (
  llpa_table_id             text PRIMARY KEY,                                  -- llpa-<matrix_version>-<grid>
  matrix_version            text NOT NULL,                                     -- '09.09.2026'
  rule_set_id               uuid REFERENCES rule_sets(id),                     -- fnma.llpa.<matrix_version>
  effective_from            date NOT NULL,
  effective_to              date,
  grid                      text NOT NULL CHECK (grid IN ('purchase_fico', 'purchase_vs4', 'lcor_fico', 'lcor_vs4', 'cashout_fico', 'cashout_vs4', 'attr_purchase', 'attr_lcor', 'attr_cashout', 'min_mi_fico', 'min_mi_vs4', 'waivers', 'credits')),
  rows                      jsonb NOT NULL,                                    -- score band → LTV band → pct (3 dp)
  source_document_id        text NOT NULL,
  verified_by               text[] NOT NULL DEFAULT '{}',                      -- two distinct human reviewers before 'verified'
  notes                     jsonb NOT NULL DEFAULT '{}'::jsonb,                -- flags for partially verified cells (bands_unverified, second_home_unverified) — quotes in those cells are blocked
  status                    text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'verified', 'active', 'retired')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matrix_version, grid),
  CHECK (status = 'staged' OR cardinality(verified_by) >= 2)
);
COMMENT ON TABLE llpa_tables IS '20.4 data model / addendum §3: the LLPA Matrix by version and grid (Classic FICO and VantageScore 4.0 families with different score bands; attribute, minimum-MI, waiver and credit tables); staged → verified (two reviewers) → active (effective date) → retired; SM_LLPA_TABLE_VERSION_GATE selects the version by expected Purchase Ready date.';
CREATE INDEX llpa_tables_version_idx ON llpa_tables(matrix_version, status);

CREATE TABLE llpa_table_verifications (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_version            text NOT NULL,
  reviewer                  text NOT NULL,
  verified_at               timestamptz NOT NULL DEFAULT now(),
  pages_checked             text[] NOT NULL DEFAULT '{}',
  flagged_cells_cleared     text[] NOT NULL DEFAULT '{}',
  UNIQUE (matrix_version, reviewer)
);
COMMENT ON TABLE llpa_table_verifications IS '20.4 audit and evidence: the per-version load/verification log with reviewer identities and flagged cells (append-only).';
CREATE TRIGGER llpa_table_verifications_immutable BEFORE UPDATE OR DELETE ON llpa_table_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── SM cost schedules (rule 3) and jurisdiction fee schedules (rule 11) ─────────────────────────────
CREATE TABLE sm_cost_schedules (
  cost_schedule_id          text PRIMARY KEY,
  partner_id                uuid REFERENCES parties(id),
  state                     char(2) NOT NULL,
  transaction_type          transaction_type NOT NULL,
  valuation_method          text NOT NULL CHECK (valuation_method IN ('value_acceptance', 'value_acceptance_pd', 'hybrid', 'desktop', 'traditional')),
  items                     jsonb NOT NULL,                                    -- [{fee_code (MISMO), vendor, amount_cents or formula, le_section, tolerance_class, paid_by='sm_third_party_cost_program'}]
  effective_from            date NOT NULL,
  effective_to              date,
  approved_by               text NOT NULL,                                     -- partner officer
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, state, transaction_type, valuation_method, effective_from)
);
COMMENT ON TABLE sm_cost_schedules IS '20.4 data model: SM-borne third-party costs per state / transaction type / valuation method from vendor contracts (value acceptance → appraisal item /bin/bash; hybrid → PDC/hybrid fee; traditional → appraisal fee) — the Σ the pass-through solve must cover; officer-approved versions.';

CREATE TABLE fee_schedules (
  fee_schedule_id           text PRIMARY KEY,
  jurisdiction              text NOT NULL,                                     -- state or state:county (recording / transfer-tax tables are jurisdictional facts; never below county)
  items                     jsonb NOT NULL,                                    -- [{fee_code, section (LE A/B/C/E/F/G/H), amount_cents or formula, source ∈ {vendor_api, jurisdiction_table, contract, estimate}, tolerance_class, refreshed_at}]
  version                   text NOT NULL,
  effective_from            date NOT NULL,
  refreshed_at              timestamptz NOT NULL,                              -- SM_FEE_SCHEDULE_REFRESH_30 anchor; older than 30 days → fee items flagged stale_source for 21.2
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (jurisdiction, version)
);
COMMENT ON TABLE fee_schedules IS '20.4 data model: jurisdiction fee tables (recording per page, transfer tax per ,000, vendor estimates) that feed 21.2 fee_items with tolerance classes; refreshed every 30 days (fee_schedule.refreshed).';

-- ───────────────────────────── pricing quotes (rules 4–6, 9) ─────────────────────────────
CREATE TABLE pricing_quotes (
  quote_id                  text PRIMARY KEY,
  lead_id                   uuid,                                              -- 20.3 leads (no FK: that migration lands in parallel)
  application_id            uuid REFERENCES applications(id),
  loan_id                   uuid REFERENCES loans(id),
  purpose                   text NOT NULL CHECK (purpose IN ('candidate', 'lead_quote', 'lock', 'relock', 'reprice', 'commitment')),
  rate_sheet_id             text NOT NULL REFERENCES rate_sheets(rate_sheet_id),
  llpa_table_id             text NOT NULL REFERENCES llpa_tables(llpa_table_id),
  cost_schedule_id          text NOT NULL REFERENCES sm_cost_schedules(cost_schedule_id),
  fee_schedule_id           text REFERENCES fee_schedules(fee_schedule_id),
  rule_set_version          text NOT NULL,                                     -- sm.pricing.2026.v1
  llpa_rule_set             text NOT NULL,                                     -- fnma.llpa.09.09.2026
  engine_version            text NOT NULL,
  inputs                    jsonb NOT NULL,                                    -- {product_code, term_months, transaction_type, occupancy, property_type, units, loan_amount_cents, value_cents, ltv, cltv, representative_score, score_model, score_source, state, county, high_balance, subordinate_financing, mi_option, homeready, fthb_ami_waiver, dts_waiver, lock_period_days, expected_purchase_ready_date}
  inputs_hash               text NOT NULL,
  outcome                   text NOT NULL CHECK (outcome IN ('priced', 'not_priceable')),
  base_price                numeric(7,3),
  llpa_items                jsonb NOT NULL,                                    -- [{grid, row, col, pct}]
  llpa_total_pct            numeric(6,3) NOT NULL,
  waiver_applied            text CHECK (waiver_applied IN ('homeready', 'fthb_ami', 'duty_to_serve')),
  credits_cents             bigint NOT NULL DEFAULT 0,                         -- HomeReady very-low-income FTHB −,500
  llpa_cents                bigint NOT NULL,
  net_price                 numeric(7,3),
  third_party_costs_cents   bigint NOT NULL,
  net_premium_cents         bigint NOT NULL,
  residual_cents            bigint NOT NULL,
  lender_credit_cents       bigint NOT NULL,
  sm_retained_cents         bigint NOT NULL,
  note_rate                 numeric(7,5),
  pass_through_rate         numeric(7,5),
  pi_cents                  bigint NOT NULL,
  mi_monthly_cents          bigint NOT NULL DEFAULT 0,
  escrow_monthly_estimate_cents bigint NOT NULL DEFAULT 0,
  prepaid_interest_cents    bigint NOT NULL DEFAULT 0,
  apr_estimate              numeric(6,3),
  points_cents              bigint NOT NULL DEFAULT 0 CHECK (points_cents = 0),   -- 0 by program
  solve_trace               jsonb NOT NULL,                                    -- [{rate, price, premium, net, pass}]
  sfcs                      text[] NOT NULL DEFAULT '{}',                      -- 067 VantageScore, 900 HomeReady, 808 high-balance, 007 LCOR (29.3)
  flags                     text[] NOT NULL DEFAULT '{}',                      -- no_score_lowest_band, eligibility_review_23_2, matrix_change_exposure
  quoted_at                 timestamptz NOT NULL,
  valid_until               timestamptz NOT NULL,                              -- min(rate_sheets.expires_at, quoted_at + 24 h)
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'presented', 'superseded', 'expired', 'locked')),
  mlo_review_id             text,
  disclaimer_notice_id      uuid,                                              -- the rendered NTC_SM_RATE_QUOTE (disclaimer render proof)
  agent_decision_id         uuid REFERENCES agent_decisions(id),
  explanation_text          text,
  numeric_hash              text NOT NULL,                                     -- reproducibility fingerprint (T8)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until > quoted_at),
  CHECK (lender_credit_cents >= 0 AND sm_retained_cents >= 0)
);
COMMENT ON TABLE pricing_quotes IS '20.4 data model / addendum §3: every quote with the ids that reproduce it (rate_sheet_id, llpa_table_id, cost_schedule_id, fee_schedule_id, rule-set and engine versions), the LLPA items and solve trace, the pass-through outcome (note rate, 25 bps pass-through, residual → capped lender credit, SM retained), payment/MI/escrow/APR estimates and the validity window; status by loan_events (quote.*).';
CREATE INDEX pricing_quotes_application_idx ON pricing_quotes(application_id, quoted_at DESC);
CREATE INDEX pricing_quotes_lead_idx ON pricing_quotes(lead_id, quoted_at DESC);
CREATE INDEX pricing_quotes_sheet_idx ON pricing_quotes(rate_sheet_id, status);

-- ───────────────────────────── pricing exceptions (rule 8) ─────────────────────────────
CREATE TABLE pricing_exceptions (
  exception_id              text PRIMARY KEY,
  quote_id                  text NOT NULL REFERENCES pricing_quotes(quote_id),
  application_id            uuid REFERENCES applications(id),
  kind                      text NOT NULL CHECK (kind IN ('competitor_match', 'error_correction', 'program_credit', 'relationship')),
  amount_bps                numeric(7,2) NOT NULL,
  amount_cents              bigint NOT NULL,
  requested_by              text NOT NULL,
  requested_at              timestamptz NOT NULL,
  due_on                    date NOT NULL,                                     -- SM_PRICING_EXCEPTION_APPROVAL_1BD: +1 business_days_servicer
  evidence_document_id      uuid REFERENCES documents(id),
  approved_by               text,                                              -- partner secondary officer
  approved_at               timestamptz,
  fair_lending_review_id    text,                                              -- 31.2 quarterly disparity review
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'auto_denied')),
  denial_reason             text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'relationship'),                                              -- prohibited by default (rule 8)
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
COMMENT ON TABLE pricing_exceptions IS '20.4 data model: the only path to a price that is not the engine''s (competitor_match / error_correction / program_credit with evidence; relationship prohibited); decided by the partner officer within 1 BD or auto-denied; reviewed quarterly by 31.2; the row is written once and decided by a decision-only update.';
CREATE INDEX pricing_exceptions_quote_idx ON pricing_exceptions(quote_id, status);
CREATE OR REPLACE FUNCTION pricing_exceptions_decision_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'pricing_exceptions % is already %', OLD.exception_id, OLD.status; END IF;
  IF NEW.quote_id <> OLD.quote_id OR NEW.kind <> OLD.kind OR NEW.amount_bps <> OLD.amount_bps OR NEW.amount_cents <> OLD.amount_cents OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'pricing_exceptions % : only the decision columns may change', OLD.exception_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pricing_exceptions_decision_only BEFORE UPDATE ON pricing_exceptions FOR EACH ROW EXECUTE FUNCTION pricing_exceptions_decision_only();
CREATE TRIGGER pricing_exceptions_no_delete BEFORE DELETE ON pricing_exceptions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── the LLPA Matrix as a versioned rule-set row (addendum §9: fnma.llpa.<version>) ─────────────────────────────
INSERT INTO rule_sets (bundle, version, effective_from, effective_to, content, approved_by)
VALUES ('fnma.llpa', '09.09.2026', DATE '2026-09-09', NULL, '{"grids":{"purchase_fico":{"≥780":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.000","75.01–80.00%":"0.375","80.01–85.00%":"0.375","85.01–90.00%":"0.250","90.01–95.00%":"0.250",">95.00%":"0.125"},"760–779":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.250","75.01–80.00%":"0.625","80.01–85.00%":"0.625","85.01–90.00%":"0.500","90.01–95.00%":"0.500",">95.00%":"0.250"},"740–759":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.125","70.01–75.00%":"0.375","75.01–80.00%":"0.875","80.01–85.00%":"1.000","85.01–90.00%":"0.750","90.01–95.00%":"0.625",">95.00%":"0.500"},"720–739":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.250","70.01–75.00%":"0.750","75.01–80.00%":"1.250","80.01–85.00%":"1.250","85.01–90.00%":"1.000","90.01–95.00%":"0.875",">95.00%":"0.750"},"700–719":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.375","70.01–75.00%":"0.875","75.01–80.00%":"1.375","80.01–85.00%":"1.500","85.01–90.00%":"1.250","90.01–95.00%":"1.125",">95.00%":"0.875"},"680–699":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.625","70.01–75.00%":"1.125","75.01–80.00%":"1.750","80.01–85.00%":"1.875","85.01–90.00%":"1.500","90.01–95.00%":"1.375",">95.00%":"1.125"},"660–679":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.750","70.01–75.00%":"1.375","75.01–80.00%":"1.875","80.01–85.00%":"2.125","85.01–90.00%":"1.750","90.01–95.00%":"1.625",">95.00%":"1.250"},"640–659":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"1.125","70.01–75.00%":"1.500","75.01–80.00%":"2.250","80.01–85.00%":"2.500","85.01–90.00%":"2.000","90.01–95.00%":"1.875",">95.00%":"1.500"},"≤639":{"≤30.00%":"0.000","30.01–60.00%":"0.125","60.01–70.00%":"1.500","70.01–75.00%":"2.125","75.01–80.00%":"2.750","80.01–85.00%":"2.875","85.01–90.00%":"2.625","90.01–95.00%":"2.250",">95.00%":"1.750"}},"purchase_vs4":{"≥800":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.000","75.01–80.00%":"0.375","80.01–85.00%":"0.375","85.01–90.00%":"0.250","90.01–95.00%":"0.250",">95.00%":"0.125"},"780–799":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.250","75.01–80.00%":"0.625","80.01–85.00%":"0.625","85.01–90.00%":"0.500","90.01–95.00%":"0.500",">95.00%":"0.250"},"760–779":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.125","70.01–75.00%":"0.375","75.01–80.00%":"0.875","80.01–85.00%":"1.000","85.01–90.00%":"0.750","90.01–95.00%":"0.625",">95.00%":"0.500"},"740–759":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.250","70.01–75.00%":"0.750","75.01–80.00%":"1.250","80.01–85.00%":"1.250","85.01–90.00%":"1.000","90.01–95.00%":"0.875",">95.00%":"0.750"},"720–739":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.375","70.01–75.00%":"0.875","75.01–80.00%":"1.375","80.01–85.00%":"1.500","85.01–90.00%":"1.250","90.01–95.00%":"1.125",">95.00%":"0.875"},"700–719":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.625","70.01–75.00%":"1.125","75.01–80.00%":"1.750","80.01–85.00%":"1.875","85.01–90.00%":"1.500","90.01–95.00%":"1.375",">95.00%":"1.125"},"680–699":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.750","70.01–75.00%":"1.375","75.01–80.00%":"1.875","80.01–85.00%":"2.125","85.01–90.00%":"1.750","90.01–95.00%":"1.625",">95.00%":"1.250"},"660–679":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"1.125","70.01–75.00%":"1.500","75.01–80.00%":"2.250","80.01–85.00%":"2.500","85.01–90.00%":"2.000","90.01–95.00%":"1.875",">95.00%":"1.500"},"≤659":{"≤30.00%":"0.000","30.01–60.00%":"0.125","60.01–70.00%":"1.500","70.01–75.00%":"2.125","75.01–80.00%":"2.750","80.01–85.00%":"2.875","85.01–90.00%":"2.625","90.01–95.00%":"2.250",">95.00%":"1.750"}},"lcor_fico":{"≥780":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.125","75.01–80.00%":"0.500","80.01–85.00%":"0.625","85.01–90.00%":"0.500","90.01–95.00%":"0.375",">95.00%":"0.375"},"760–779":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.125","70.01–75.00%":"0.375","75.01–80.00%":"0.875","80.01–85.00%":"1.000","85.01–90.00%":"0.750","90.01–95.00%":"0.625",">95.00%":"0.625"},"740–759":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.250","70.01–75.00%":"0.750","75.01–80.00%":"1.125","80.01–85.00%":"1.375","85.01–90.00%":"1.125","90.01–95.00%":"1.000",">95.00%":"1.000"},"720–739":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.500","70.01–75.00%":"1.000","75.01–80.00%":"1.625","80.01–85.00%":"1.750","85.01–90.00%":"1.500","90.01–95.00%":"1.250",">95.00%":"1.250"},"700–719":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.625","70.01–75.00%":"1.250","75.01–80.00%":"1.875","80.01–85.00%":"2.125","85.01–90.00%":"1.750","90.01–95.00%":"1.625",">95.00%":"1.625"},"680–699":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.875","70.01–75.00%":"1.625","75.01–80.00%":"2.250","80.01–85.00%":"2.500","85.01–90.00%":"2.125","90.01–95.00%":"1.750",">95.00%":"1.750"},"660–679":{"≤30.00%":"0.000","30.01–60.00%":"0.125","60.01–70.00%":"1.125","70.01–75.00%":"1.875","75.01–80.00%":"2.500","80.01–85.00%":"3.000","85.01–90.00%":"2.375","90.01–95.00%":"2.125",">95.00%":"2.125"},"640–659":{"≤30.00%":"0.000","30.01–60.00%":"0.250","60.01–70.00%":"1.375","70.01–75.00%":"2.125","75.01–80.00%":"2.875","80.01–85.00%":"3.375","85.01–90.00%":"2.875","90.01–95.00%":"2.500",">95.00%":"2.500"},"≤639":{"≤30.00%":"0.000","30.01–60.00%":"0.375","60.01–70.00%":"1.750","70.01–75.00%":"2.500","75.01–80.00%":"3.500","80.01–85.00%":"3.875","85.01–90.00%":"3.625","90.01–95.00%":"2.500",">95.00%":"2.500"}},"lcor_vs4":{"≥800":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.125","75.01–80.00%":"0.500","80.01–85.00%":"0.625","85.01–90.00%":"0.500","90.01–95.00%":"0.375",">95.00%":"0.375"},"780–799":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.125","70.01–75.00%":"0.375","75.01–80.00%":"0.875","80.01–85.00%":"1.000","85.01–90.00%":"0.750","90.01–95.00%":"0.625",">95.00%":"0.625"},"760–779":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.250","70.01–75.00%":"0.750","75.01–80.00%":"1.125","80.01–85.00%":"1.375","85.01–90.00%":"1.125","90.01–95.00%":"1.000",">95.00%":"1.000"},"740–759":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.500","70.01–75.00%":"1.000","75.01–80.00%":"1.625","80.01–85.00%":"1.750","85.01–90.00%":"1.500","90.01–95.00%":"1.250",">95.00%":"1.250"},"720–739":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.625","70.01–75.00%":"1.250","75.01–80.00%":"1.875","80.01–85.00%":"2.125","85.01–90.00%":"1.750","90.01–95.00%":"1.625",">95.00%":"1.625"},"700–719":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.875","70.01–75.00%":"1.625","75.01–80.00%":"2.250","80.01–85.00%":"2.500","85.01–90.00%":"2.125","90.01–95.00%":"1.750",">95.00%":"1.750"},"680–699":{"≤30.00%":"0.000","30.01–60.00%":"0.125","60.01–70.00%":"1.125","70.01–75.00%":"1.875","75.01–80.00%":"2.500","80.01–85.00%":"3.000","85.01–90.00%":"2.375","90.01–95.00%":"2.125",">95.00%":"2.125"},"660–679":{"≤30.00%":"0.000","30.01–60.00%":"0.250","60.01–70.00%":"1.375","70.01–75.00%":"2.125","75.01–80.00%":"2.875","80.01–85.00%":"3.375","85.01–90.00%":"2.875","90.01–95.00%":"2.500",">95.00%":"2.500"},"≤659":{"≤30.00%":"0.000","30.01–60.00%":"0.375","60.01–70.00%":"1.750","70.01–75.00%":"2.500","75.01–80.00%":"3.500","80.01–85.00%":"3.875","85.01–90.00%":"3.625","90.01–95.00%":"2.500",">95.00%":"2.500"}},"cashout_fico":{"≥780":{"≤30.00%":"0.375","30.01–60.00%":"0.375","60.01–70.00%":"0.625","70.01–75.00%":"0.875","75.01–80.00%":"1.375"},"760–779":{"≤30.00%":"0.375","30.01–60.00%":"0.375","60.01–70.00%":"0.875","70.01–75.00%":"1.250","75.01–80.00%":"1.875"},"740–759":{"≤30.00%":"0.375","30.01–60.00%":"0.375","60.01–70.00%":"1.000","70.01–75.00%":"1.625","75.01–80.00%":"2.375"},"720–739":{"≤30.00%":"0.375","30.01–60.00%":"0.500","60.01–70.00%":"1.375","70.01–75.00%":"2.000","75.01–80.00%":"2.750"},"700–719":{"≤30.00%":"0.375","30.01–60.00%":"0.500","60.01–70.00%":"1.625","70.01–75.00%":"2.625","75.01–80.00%":"3.250"},"680–699":{"≤30.00%":"0.375","30.01–60.00%":"0.625","60.01–70.00%":"2.000","70.01–75.00%":"2.875","75.01–80.00%":"3.750"},"660–679":{"≤30.00%":"0.375","30.01–60.00%":"0.875","60.01–70.00%":"2.750","70.01–75.00%":"4.000","75.01–80.00%":"4.750"},"640–659":{"≤30.00%":"0.375","30.01–60.00%":"1.375","60.01–70.00%":"3.125","70.01–75.00%":"4.625","75.01–80.00%":"5.125"},"≤639":{"≤30.00%":"0.375","30.01–60.00%":"1.375","60.01–70.00%":"3.375","70.01–75.00%":"4.875","75.01–80.00%":"5.125"}},"cashout_vs4":{"≥800":{"≤30.00%":"0.375","30.01–60.00%":"0.375","60.01–70.00%":"0.625","70.01–75.00%":"0.875","75.01–80.00%":"1.375"},"780–799":{"≤30.00%":"0.375","30.01–60.00%":"0.375","60.01–70.00%":"0.875","70.01–75.00%":"1.250","75.01–80.00%":"1.875"},"760–779":{"≤30.00%":"0.375","30.01–60.00%":"0.375","60.01–70.00%":"1.000","70.01–75.00%":"1.625","75.01–80.00%":"2.375"},"740–759":{"≤30.00%":"0.375","30.01–60.00%":"0.500","60.01–70.00%":"1.375","70.01–75.00%":"2.000","75.01–80.00%":"2.750"},"720–739":{"≤30.00%":"0.375","30.01–60.00%":"0.500","60.01–70.00%":"1.625","70.01–75.00%":"2.625","75.01–80.00%":"3.250"},"700–719":{"≤30.00%":"0.375","30.01–60.00%":"0.625","60.01–70.00%":"2.000","70.01–75.00%":"2.875","75.01–80.00%":"3.750"},"680–699":{"≤30.00%":"0.375","30.01–60.00%":"0.875","60.01–70.00%":"2.750","70.01–75.00%":"4.000","75.01–80.00%":"4.750"},"660–679":{"≤30.00%":"0.375","30.01–60.00%":"1.375","60.01–70.00%":"3.125","70.01–75.00%":"4.625","75.01–80.00%":"5.125"},"≤659":{"≤30.00%":"0.375","30.01–60.00%":"1.375","60.01–70.00%":"3.375","70.01–75.00%":"4.875","75.01–80.00%":"5.125"}},"attr_purchase":{"arm":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.000","75.01–80.00%":"0.000","80.01–85.00%":"0.000","85.01–90.00%":"0.000","90.01–95.00%":"0.250",">95.00%":"0.250"},"condo":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.125","70.01–75.00%":"0.125","75.01–80.00%":"0.750","80.01–85.00%":"0.750","85.01–90.00%":"0.750","90.01–95.00%":"0.750",">95.00%":"0.750"},"investment_property":{"≤30.00%":"1.125","30.01–60.00%":"1.125","60.01–70.00%":"1.625","70.01–75.00%":"2.125","75.01–80.00%":"3.375","80.01–85.00%":"4.125","85.01–90.00%":"4.125","90.01–95.00%":"4.125",">95.00%":"4.125"},"second_home":{"≤30.00%":"1.125","30.01–60.00%":"1.125","60.01–70.00%":"1.625","70.01–75.00%":"2.125","75.01–80.00%":"3.375","80.01–85.00%":"4.125","85.01–90.00%":"4.125","90.01–95.00%":"4.125",">95.00%":"4.125"},"manufactured_home":{"≤30.00%":"0.500","30.01–60.00%":"0.500","60.01–70.00%":"0.500","70.01–75.00%":"0.500","75.01–80.00%":"0.500","80.01–85.00%":"0.500","85.01–90.00%":"0.500","90.01–95.00%":"0.500",">95.00%":"0.500"},"units_2_4":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.375","70.01–75.00%":"0.375","75.01–80.00%":"0.625","80.01–85.00%":"0.625","85.01–90.00%":"0.625","90.01–95.00%":"0.625",">95.00%":"0.625"},"high_balance_fixed":{"≤30.00%":"0.500","30.01–60.00%":"0.500","60.01–70.00%":"0.750","70.01–75.00%":"0.750","75.01–80.00%":"1.000","80.01–85.00%":"1.000","85.01–90.00%":"1.000","90.01–95.00%":"1.000",">95.00%":"1.000"},"high_balance_arm":{"≤30.00%":"1.250","30.01–60.00%":"1.250","60.01–70.00%":"1.500","70.01–75.00%":"1.500","75.01–80.00%":"2.500","80.01–85.00%":"2.500","85.01–90.00%":"2.500","90.01–95.00%":"2.750",">95.00%":"2.750"},"subordinate_financing":{"≤30.00%":"0.625","30.01–60.00%":"0.625","60.01–70.00%":"0.625","70.01–75.00%":"0.875","75.01–80.00%":"1.125","80.01–85.00%":"1.125","85.01–90.00%":"1.125","90.01–95.00%":"1.875",">95.00%":"1.875"}},"attr_lcor":{"arm":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.000","75.01–80.00%":"0.000","80.01–85.00%":"0.000","85.01–90.00%":"0.000","90.01–95.00%":"0.250",">95.00%":"0.250"},"condo":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.125","70.01–75.00%":"0.125","75.01–80.00%":"0.750","80.01–85.00%":"0.750","85.01–90.00%":"0.750","90.01–95.00%":"0.750",">95.00%":"0.750"},"investment_property":{"≤30.00%":"1.125","30.01–60.00%":"1.125","60.01–70.00%":"1.625","70.01–75.00%":"2.125","75.01–80.00%":"3.375","80.01–85.00%":"4.125","85.01–90.00%":"4.125","90.01–95.00%":"4.125",">95.00%":"4.125"},"second_home":{"≤30.00%":"1.125","30.01–60.00%":"1.125","60.01–70.00%":"1.625","70.01–75.00%":"2.125","75.01–80.00%":"3.375","80.01–85.00%":"4.125","85.01–90.00%":"4.125","90.01–95.00%":"4.125",">95.00%":"4.125"},"manufactured_home":{"≤30.00%":"0.500","30.01–60.00%":"0.500","60.01–70.00%":"0.500","70.01–75.00%":"0.500","75.01–80.00%":"0.500","80.01–85.00%":"0.500","85.01–90.00%":"0.500","90.01–95.00%":"0.500",">95.00%":"0.500"},"units_2_4":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.375","70.01–75.00%":"0.375","75.01–80.00%":"0.625","80.01–85.00%":"0.625","85.01–90.00%":"0.625","90.01–95.00%":"0.625",">95.00%":"0.625"},"high_balance_fixed":{"≤30.00%":"0.500","30.01–60.00%":"0.500","60.01–70.00%":"0.750","70.01–75.00%":"0.750","75.01–80.00%":"1.000","80.01–85.00%":"1.000","85.01–90.00%":"1.000","90.01–95.00%":"1.000",">95.00%":"1.000"},"high_balance_arm":{"≤30.00%":"1.250","30.01–60.00%":"1.250","60.01–70.00%":"1.500","70.01–75.00%":"1.500","75.01–80.00%":"2.500","80.01–85.00%":"2.500","85.01–90.00%":"2.500","90.01–95.00%":"2.750",">95.00%":"2.750"},"subordinate_financing":{"≤30.00%":"0.625","30.01–60.00%":"0.625","60.01–70.00%":"0.625","70.01–75.00%":"0.875","75.01–80.00%":"1.125","80.01–85.00%":"1.125","85.01–90.00%":"1.125","90.01–95.00%":"1.875",">95.00%":"1.875"}},"attr_cashout":{"arm":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.000","70.01–75.00%":"0.000","75.01–80.00%":"0.000"},"condo":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.125","70.01–75.00%":"0.125","75.01–80.00%":"0.750"},"investment_property":{"≤30.00%":"1.125","30.01–60.00%":"1.125","60.01–70.00%":"1.625","70.01–75.00%":"2.125","75.01–80.00%":"3.375"},"second_home":{"≤30.00%":"1.125","30.01–60.00%":"1.125","60.01–70.00%":"1.625","70.01–75.00%":"2.125","75.01–80.00%":"3.375"},"manufactured_home":{"≤30.00%":"0.500","30.01–60.00%":"0.500","60.01–70.00%":"0.500","70.01–75.00%":"0.500","75.01–80.00%":"0.500"},"units_2_4":{"≤30.00%":"0.000","30.01–60.00%":"0.000","60.01–70.00%":"0.375","70.01–75.00%":"0.375","75.01–80.00%":"0.625"},"high_balance_fixed":{"≤30.00%":"1.250","30.01–60.00%":"1.250","60.01–70.00%":"1.500","70.01–75.00%":"1.500","75.01–80.00%":"1.750"},"high_balance_arm":{"≤30.00%":"2.000","30.01–60.00%":"2.000","60.01–70.00%":"2.250","70.01–75.00%":"2.250","75.01–80.00%":"3.250"},"subordinate_financing":{"≤30.00%":"0.625","30.01–60.00%":"0.625","60.01–70.00%":"0.625","70.01–75.00%":"0.875","75.01–80.00%":"1.125"}},"min_mi_fico":{">740":{"80.01–85.00%":"0.125","85.01–90.00%":"0.375","90.01–95.00%":"0.500","95.01–97.00%":"1.000"},"720–739":{"80.01–85.00%":"0.125","85.01–90.00%":"0.625","90.01–95.00%":"0.875","95.01–97.00%":"1.250"},"700–719":{"80.01–85.00%":"0.125","85.01–90.00%":"0.750","90.01–95.00%":"0.875","95.01–97.00%":"1.250"},"680–699":{"80.01–85.00%":"0.125","85.01–90.00%":"0.750","90.01–95.00%":"0.875","95.01–97.00%":"1.750"},"660–679":{"80.01–85.00%":"0.750","85.01–90.00%":"1.250","90.01–95.00%":"1.750","95.01–97.00%":"2.125"},"640–659":{"80.01–85.00%":"1.250","85.01–90.00%":"1.750","90.01–95.00%":"2.000","95.01–97.00%":"2.375"},"620–639":{"80.01–85.00%":"1.750","85.01–90.00%":"2.000","90.01–95.00%":"2.250","95.01–97.00%":"2.750"},"<620":{"80.01–85.00%":"2.000","85.01–90.00%":"2.250","90.01–95.00%":"2.500","95.01–97.00%":"3.000"}},"min_mi_vs4":{">760":{"80.01–85.00%":"0.125","85.01–90.00%":"0.375","90.01–95.00%":"0.500","95.01–97.00%":"1.000"},"740–759":{"80.01–85.00%":"0.125","85.01–90.00%":"0.625","90.01–95.00%":"0.875","95.01–97.00%":"1.250"},"720–739":{"80.01–85.00%":"0.125","85.01–90.00%":"0.750","90.01–95.00%":"0.875","95.01–97.00%":"1.250"},"700–719":{"80.01–85.00%":"0.125","85.01–90.00%":"0.750","90.01–95.00%":"0.875","95.01–97.00%":"1.750"},"680–699":{"80.01–85.00%":"0.750","85.01–90.00%":"1.250","90.01–95.00%":"1.750","95.01–97.00%":"2.125"},"660–679":{"80.01–85.00%":"1.250","85.01–90.00%":"1.750","90.01–95.00%":"2.000","95.01–97.00%":"2.375"},"640–659":{"80.01–85.00%":"1.750","85.01–90.00%":"2.000","90.01–95.00%":"2.250","95.01–97.00%":"2.750"},"<640":{"80.01–85.00%":"2.000","85.01–90.00%":"2.250","90.01–95.00%":"2.500","95.01–97.00%":"3.000"}},"waivers":{"homeready":{"sfc":"900","keeps":"min_mi"},"fthb_ami":{"ami_limit_pct":"100","ami_limit_high_cost_pct":"120","keeps":"min_mi"},"duty_to_serve":{"sfc":"874","keeps":"min_mi"}},"credits":{"homeready_vli_fthb":{"cents":"250000","ami_max_pct":"50","sfcs":"884,900","purchase_ready_through":"2027-02-28"}}},"notes":{},"source":"Fannie Mae LLPA Matrix 09.09.2026 (media/9391), verified 2026-09-10, re-read cell-by-cell 2026-09-11","source_document_id":"doc-llpa-matrix-09-09-2026","ltv_bands":["≤30.00%","30.01–60.00%","60.01–70.00%","70.01–75.00%","75.01–80.00%","80.01–85.00%","85.01–90.00%","90.01–95.00%",">95.00%"]}'::jsonb, 'two-reviewer verification log 2026-09-11')
ON CONFLICT (bundle, version) DO NOTHING;

COMMIT;
