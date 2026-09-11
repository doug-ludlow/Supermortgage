-- 0098_purchase_proceeds_settlement.sql — §27.2 Purchase-proceeds settlement, warehouse payoff, gain-on-sale computation and
-- the borrower rate pass-through (Grander economics), MSR accounting hand-off to the partner
-- (spec/sections/27-…/27-2-purchase-proceeds-settlement-….md "Data model"). Owned here: the nine 27.2 tables
-- `proceeds_receipts`, `proceeds_matches`, `settlement_waterfalls`, `gain_on_sale_computations`,
-- `rate_passthrough_reconciliations`, `msr_handoffs`, `platform_fee_accruals`, `ppa_requests`, `gl_export_batches`, plus the
-- "Added columns" 27.2 assigns to shared tables (`warehouse_advances.proceeds_match_id`; `wire_verifications.purpose` gains
-- the value `partner_residual` — 24.4 table, new purpose value defined here). Not here (other owners, never duplicated):
-- `purchase_advices` (addendum baseline column set, written by 27.2; 29.4's delivery migration lands it — referenced by a
-- plain uuid until then), `deliveries` / `fundings` (29.4 / 26.3, in flight), applications (0057), loans / documents /
-- ledger_lines / agent_decisions (0001), warehouse_advances (0097), pricing_quotes (0074), locks (0066), disclosures (0064).
-- Money is bigint cents; prices to 3 dp (% of par); rates 5 dp; LLPA percentages 3 dp. Matches, waterfalls, gain-on-sale
-- computations, reconciliations, accruals and GL batches are append-only (0001's forbid_mutation trigger); receipts,
-- hand-offs and PPA requests carry a status and are never deleted. Retention: fnma_loan_file_life_plus_4y plus SM's
-- 7-year commercial-records policy; raw API JSON retained 4 years (documents).
BEGIN;

-- ---------------------------------------------------------------- proceeds_receipts (bank credits to SM's collection account; one wire may cover several loans)
CREATE TABLE proceeds_receipts (
  receipt_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_ref                        text NOT NULL UNIQUE,                            -- bank / FedLine incoming-wire reference (duplicate → suspense and return)
  value_date                      date NOT NULL,
  amount_cents                    bigint NOT NULL,                                 -- negative for a PPA debit settled by draft
  originator_name                 text NOT NULL,                                   -- Fannie Mae
  reference_text                  text,                                            -- payee code / loan numbers where present
  account_ref                     text NOT NULL,                                   -- must be SM's collection account (warehouse_facilities.collection_account_ref)
  matched_advice_ids              uuid[] NOT NULL DEFAULT '{}',
  status                          text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'provisional', 'matched', 'partial', 'returned', 'suspense')),
  received_at                     timestamptz NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE proceeds_receipts IS '27.2 proceeds_receipts: intraday bank credits of Fannie Mae purchase proceeds to SM''s collection account — the operative settlement trigger (C2-2-03 / C2-2-04); unmatched → provisional (no advice by 14:00 ET, forecast within $100) → matched; duplicates and unexplained remainders to suspense.';
CREATE INDEX proceeds_receipts_value_date_idx ON proceeds_receipts (value_date, status);
CREATE TRIGGER proceeds_receipts_no_delete BEFORE DELETE ON proceeds_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- proceeds_matches (the three-way match: advice ↔ receipt ↔ advance/funding; append-only)
CREATE TABLE proceeds_matches (
  match_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                         uuid REFERENCES loans(id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  purchase_advice_id              uuid,                                            -- purchase_advices (addendum baseline; 29.4 migration in flight — no FK until it lands)
  receipt_id                      uuid NOT NULL REFERENCES proceeds_receipts(receipt_id),
  advance_id                      uuid NOT NULL REFERENCES warehouse_advances(advance_id),
  funding_id                      uuid,                                            -- 26.3 fundings (in flight)
  expected_proceeds_cents         bigint NOT NULL,                                 -- forecast at delivery (rule 1) under the convention basis
  advice_proceeds_cents           bigint NOT NULL,
  received_cents                  bigint NOT NULL,
  variance_cents                  bigint NOT NULL,                                 -- received − expected
  variance_breakdown              jsonb NOT NULL DEFAULT '{}'::jsonb,              -- {price_cents, llpa_cents, interest_cents, fees_cents, convention_cents, unexplained_cents}
  interest_convention_observed    text NOT NULL CHECK (interest_convention_observed IN ('a_30_360', 'b_act_365', 'other')),
  convention_basis                text NOT NULL CHECK (convention_basis IN ('a_30_360', 'b_act_365')),
  convention_action               text NOT NULL DEFAULT 'none' CHECK (convention_action IN ('lock', 'none', 'changed', 'unresolved')),
  tolerance_rule_applied          text NOT NULL,
  exception_kind                  text CHECK (exception_kind IN ('price', 'llpa', 'interest', 'fees', 'unexplained', 'convention_changed', 'wrong_account', 'missing_advice', 'duplicate_receipt')),
  status                          text NOT NULL CHECK (status IN ('provisional', 'matched', 'matched_with_variance', 'exception', 'ppa_requested', 'resolved')),
  matched_at                      timestamptz NOT NULL,
  agent_decision_id               uuid REFERENCES agent_decisions(id),
  created_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE proceeds_matches IS '27.2 proceeds_matches: the three-way match of the Whole Loan Purchase Advice, the bank receipt and the 27.1 advance / 26.3 funding with the component-by-component variance explanation (price, LLPA, interest incl. the 30/360 vs actual/365 convention, fees, unexplained); tolerances $1.00 (matched) / $100.00 explained (matched_with_variance); append-only — a re-match is a new row.';
CREATE INDEX proceeds_matches_loan_idx ON proceeds_matches (loan_id, matched_at DESC);
CREATE TRIGGER proceeds_matches_immutable BEFORE UPDATE OR DELETE ON proceeds_matches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- settlement_waterfalls (rule 3; append-only)
CREATE TABLE settlement_waterfalls (
  waterfall_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id                        uuid NOT NULL REFERENCES proceeds_matches(match_id),
  advance_id                      uuid NOT NULL REFERENCES warehouse_advances(advance_id),
  loan_id                         uuid REFERENCES loans(id),
  received_cents                  bigint NOT NULL,
  advance_principal_cents         bigint NOT NULL,
  capitalized_interest_cents      bigint NOT NULL DEFAULT 0,
  accrued_interest_cents          bigint NOT NULL DEFAULT 0,                       -- through the day before the value date (27.1 cumulative method)
  warehouse_fees_cents            bigint NOT NULL DEFAULT 0,
  sm_cost_recovery_cents          bigint NOT NULL DEFAULT 0,                       -- actual invoices capped at the quote forecast × 110%
  sm_cost_recovery_receivable_cents bigint NOT NULL DEFAULT 0,                     -- short-paid recovery → partner receivable [27.2-Q2]
  sm_retained_residual_cents      bigint NOT NULL DEFAULT 0,                       -- pricing_quotes.sm_retained_cents (20.4-Q1)
  shortfall_cents                 bigint NOT NULL DEFAULT 0,                       -- received < payoff → drafted from the partner within 2 business days
  partner_residual_cents          bigint NOT NULL DEFAULT 0,
  partner_wire_ref                text,
  partner_wire_value_date         date,
  settled_at                      timestamptz NOT NULL,
  ledger_entry_ids                uuid[] NOT NULL DEFAULT '{}',
  created_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE settlement_waterfalls IS '27.2 settlement_waterfalls: proceeds applied same day as the match (value date = receipt value date) — (1) advance principal incl. capitalized interest, (2) accrued interest, (3) warehouse fees, (4) SM cost recovery, (5) SM retained residual, (6) partner residual wired the next business day under dual control; shortfalls drafted from the partner.';
CREATE TRIGGER settlement_waterfalls_immutable BEFORE UPDATE OR DELETE ON settlement_waterfalls FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- gain_on_sale_computations (rules 5 and 7; append-only)
CREATE TABLE gain_on_sale_computations (
  gos_id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                         uuid REFERENCES loans(id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  quote_id                        text REFERENCES pricing_quotes(quote_id),         -- 20.4 locked quote
  lock_id                         uuid REFERENCES locks(lock_id),                    -- 21.4
  purchase_advice_id              uuid,
  expected                        jsonb NOT NULL,                                  -- {price, llpa_total_pct, llpa_cents, gross_premium_cents, net_premium_cents, third_party_costs_cents, lender_credit_cents, sm_retained_cents, matrix_version}
  actual                          jsonb NOT NULL,                                  -- {price, llpa_cents, interest_adjustment_cents, fees_cents, prepaid_interest_collected_cents, interest_carry_cents, lender_credit_cents, third_party_costs_actual_cents, warehouse_interest_cents, warehouse_fees_cents, sm_cost_recovery_cents, sm_retained_residual_cents, partner_origination_result_cents}
  variance                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  gaap_view                       jsonb NOT NULL DEFAULT '{}'::jsonb,              -- partner: gain on sale = net proceeds − carrying amount; warehouse interest as interest expense
  recapture_exposure_cents        bigint NOT NULL DEFAULT 0,                       -- gross premium until purchase_date + 120 days (C1-1-01)
  recapture_exposure_until        date,
  posted_at                       timestamptz,
  agent_decision_id               uuid REFERENCES agent_decisions(id),
  created_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE gain_on_sale_computations IS '27.2 gain_on_sale_computations: the partner''s gain on sale computed by SM as its agent — program view (net premium − lender credit − SM cost recovery − SM retained − warehouse carry + interest carry = partner origination result ≈ 0 by construction) and GAAP view (data only; the partner''s accountants make the ASC 860/948 entries); premium-recapture exposure kept until 20.1''s 120-day gate opens.';
CREATE TRIGGER gain_on_sale_computations_immutable BEFORE UPDATE OR DELETE ON gain_on_sale_computations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- rate_passthrough_reconciliations (rule 6 — the term-sheet proof; append-only)
CREATE TABLE rate_passthrough_reconciliations (
  recon_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                         uuid REFERENCES loans(id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  gos_id                          uuid NOT NULL REFERENCES gain_on_sale_computations(gos_id),
  quote_id                        text REFERENCES pricing_quotes(quote_id),
  lock_id                         uuid REFERENCES locks(lock_id),
  disclosure_id_cd_final          uuid REFERENCES disclosures(id),                   -- 25.2 final CD (lender credit, page 2)
  quoted_note_rate                numeric(8,5) NOT NULL,
  note_rate                       numeric(8,5) NOT NULL,
  solve_trace_document_id         uuid REFERENCES documents(id),                     -- 20.4 quote solve trace
  cd_lender_credit_cents          bigint NOT NULL,
  expected_net_premium_cents      bigint NOT NULL,
  actual_net_premium_cents        bigint NOT NULL,
  costs_forecast_cents            bigint NOT NULL,
  costs_recovered_cents           bigint NOT NULL,
  sm_retained_cents               bigint NOT NULL,
  surplus_cents                   bigint NOT NULL,                                 -- actual − expected
  surplus_disposition             text NOT NULL DEFAULT 'partner' CHECK (surplus_disposition IN ('partner', 'sm_capped_recovery', 'borrower_post_closing_credit')),
  variance_lines                  jsonb NOT NULL DEFAULT '{}'::jsonb,              -- (a) price (b) LLPA (c) costs (d) interest items (e) warehouse carry
  evidence_document_ids           uuid[] NOT NULL DEFAULT '{}',                    -- quote solve trace, lock confirmation, final CD page 2, note, purchase advice, invoices
  flags                           jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                          text NOT NULL CHECK (status IN ('reconciled', 'variance_explained', 'exception')),
  created_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE rate_passthrough_reconciliations IS '27.2 rate_passthrough_reconciliations: expected (lock: net premium = third-party cost forecast + lender credit + SM retained, by construction of the 20.4 solve) vs actual (advice + invoices) with the evidence lineage — the Reg N substantiation that the gain on sale was passed through to the borrower''s rate; the borrower''s benefit is fixed at closing, post-closing variances settle between SM and the partner (sm.economics.v1).';
CREATE TRIGGER rate_passthrough_reconciliations_immutable BEFORE UPDATE OR DELETE ON rate_passthrough_reconciliations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- msr_handoffs (rule 8: data, never a valuation)
CREATE TABLE msr_handoffs (
  handoff_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                         uuid REFERENCES loans(id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  partner_id                      uuid NOT NULL REFERENCES parties(id),
  purchase_advice_id              uuid,
  payload                         jsonb NOT NULL,                                  -- exactly {fnma_loan_number, seller_loan_number, upb_at_purchase_cents, note_rate, pass_through_rate, servicing_fee_bps, remittance_type, purchase_date, first_payment_date, lpi_date, term_months, amortization_type, product_code, pi_cents, escrow_indicator, mi_flag, occupancy, property_state, sfc_codes, platform_fee_bps}
  delivered_at                    timestamptz NOT NULL,
  channel                         text NOT NULL CHECK (channel IN ('partner_api', 'sftp', 'portal')),
  acknowledged_at                 timestamptz,
  schema_version                  text NOT NULL DEFAULT 'msr-handoff.v1',
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE msr_handoffs IS '27.2 msr_handoffs: the MSR data file delivered to the partner''s accounting channel within one business day of the match (purchase advice attached); SM performs no valuation — the servicing fee is the fixed 25 bps and the 12.5 bps platform fee is disclosed so the partner''s MSR model nets it.';
CREATE TRIGGER msr_handoffs_no_delete BEFORE DELETE ON msr_handoffs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- platform_fee_accruals (rule 9: 12.5 bps/yr on UPB; append-only)
CREATE TABLE platform_fee_accruals (
  accrual_id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                         uuid NOT NULL REFERENCES loans(id),
  period                          char(7) NOT NULL,                                -- YYYY-MM
  upb_basis_cents                 bigint NOT NULL,                                 -- UPB at the first of the period (at purchase for the first period)
  days_in_period                  integer NOT NULL,
  days_accrued                    integer NOT NULL,
  fee_cents                       bigint NOT NULL,                                 -- round_half_up(UPB × 0.00125 / 12), prorated first/last period
  basis_rule                      text NOT NULL CHECK (basis_rule IN ('prorated_first_period', 'full_month', 'prorated_last_period')),
  posted_at                       timestamptz NOT NULL,
  invoice_id                      uuid,                                            -- subservicing invoice (servicing billing 5.x/6.x)
  ledger_entry_id                 uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, period)
);
COMMENT ON TABLE platform_fee_accruals IS '27.2 platform_fee_accruals: the monthly 12.5 bps platform fee per purchased loan (accrual begins at the Fannie Mae purchase date — 27.2-Q3), posted to platform_fee_receivable / platform_fee_income and billed with the subservicing invoice.';
CREATE TRIGGER platform_fee_accruals_immutable BEFORE UPDATE OR DELETE ON platform_fee_accruals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- ppa_requests (rule 11: funds-transfer corrections and LSDU data corrections)
CREATE TABLE ppa_requests (
  ppa_id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                         uuid REFERENCES loans(id),
  application_id                  uuid NOT NULL REFERENCES applications(id),
  purchase_advice_id              uuid,
  kind                            text NOT NULL CHECK (kind IN ('funds_transfer_error', 'data_correction')),
  channel                         text NOT NULL CHECK (channel IN ('email_acquisitions_loan_delivery', 'lsdu')),
  requested_at                    timestamptz,
  due_at                          date NOT NULL,                                   -- advice_date + 30 calendar days (C2-2-05) / purchase_date + 18 months (C1-2-02); no business-day roll
  platform_target_on              date NOT NULL,                                   -- the last business day on or before due_at
  amount_cents                    bigint NOT NULL,
  attributes                      jsonb NOT NULL DEFAULT '{}'::jsonb,              -- LSDU data-change attributes (PPA Data Change Rules Matrix)
  fnma_reference                  text,
  filed_by_role                   text NOT NULL CHECK (filed_by_role IN ('fnma_portal_operator', 'officer')),
  status                          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'below_threshold', 'submitted', 'accepted', 'rejected', 'settled')),
  resolution_cents                bigint,
  resolved_at                     timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ppa_requests IS '27.2 ppa_requests: post-purchase adjustment requests — funds-transfer errors by e-mail to acquisitions_loan_delivery@fanniemae.com under the partner''s seller number within 30 days of the advice (C2-2-05), LLPA data corrections through LSDU by the human fnma_portal_operator{party=partner} ($100 minimum; 18-month lookback); settlements match as new proceeds_receipts rows.';
CREATE INDEX ppa_requests_due_idx ON ppa_requests (due_at, status);
CREATE TRIGGER ppa_requests_no_delete BEFORE DELETE ON ppa_requests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- gl_export_batches (rule 10; append-only, idempotent by ledger entry id)
CREATE TABLE gl_export_batches (
  batch_id                        text PRIMARY KEY,                                -- gl-<target>-<period_date>: a re-run carries the same id
  target                          text NOT NULL CHECK (target IN ('sm_gl', 'partner_gl')),
  period_date                     date NOT NULL,
  lines                           jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{ledger_entry_id, account_code, debit_cents, credit_cents, loan_id, loan_event_id, memo}]
  line_count                      integer NOT NULL DEFAULT 0,
  control_totals                  jsonb NOT NULL DEFAULT '{}'::jsonb,              -- {debit_cents, credit_cents, balanced, entry_sets}
  hash                            text NOT NULL,
  format                          text NOT NULL DEFAULT 'json' CHECK (format IN ('csv', 'json', 'api')),
  exported_at                     timestamptz NOT NULL,
  acknowledged_at                 timestamptz,
  status                          text NOT NULL DEFAULT 'exported' CHECK (status IN ('empty', 'exported', 'acknowledged')),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE gl_export_batches IS '27.2 gl_export_batches: the 20:00 ET daily export of every balanced ledger entry set linked to a loan event — once, by entry id — for SM''s GL and the partner GL mirror, with control totals and a hash per batch; acknowledgments recorded; period-end close waits for them.';
CREATE TRIGGER gl_export_batches_no_delete BEFORE DELETE ON gl_export_batches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- added columns (27.2 "Added columns")
ALTER TABLE warehouse_advances ADD COLUMN proceeds_match_id uuid REFERENCES proceeds_matches(match_id);
COMMENT ON COLUMN warehouse_advances.proceeds_match_id IS '27.2: the three-way match that repaid the advance from purchase proceeds.';
ALTER TABLE wire_verifications DROP CONSTRAINT wire_verifications_purpose_check;
ALTER TABLE wire_verifications ADD CONSTRAINT wire_verifications_purpose_check CHECK (purpose IN ('closing_funds', 'payoff_existing_lien', 'subordinate_payoff', 'partner_residual'));
COMMENT ON COLUMN wire_verifications.purpose IS '24.4 purposes plus 27.2''s partner_residual: the partner operating-account beneficiary for residual wires under the LSA, re-verified by callback to the LSA notice contacts on any change.';

COMMIT;
