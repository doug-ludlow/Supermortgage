-- 0104: 29.2 Pipeline and interest-rate-risk management — the children of the baseline `hedge_positions` (0103):
-- `hedge_trades`, `pipeline_positions` (daily and intraday snapshots), `pull_through_models` / `pull_through_estimates`,
-- `fallout_events`, `mark_to_market_runs`, `rate_shock_reports`, `margin_calls` and `hedge_policies` (the partner's
-- hedging policy as data). Money in bigint cents; prices as percent of par to 5 dp as stored (3 dp as quoted; TBA 32nds
-- converted at 5 dp); probabilities, durations and coverage ratios to 4 dp; every timestamp is ET wall-clock stored as
-- timestamptz. Snapshots, estimates, fallout events, trades, runs, reports and calls are append-only (forbid_mutation);
-- a position (0103) or a margin call changes status only from a confirmation / wire, never on an AI decision.
BEGIN;

-- Partner policy as data (rule 1; open questions 4, 7, 8). One approved version at a time; LL-2026-04 annual review.
CREATE TABLE hedge_policies (
  policy_id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id                         text NOT NULL,
  version                            int NOT NULL CHECK (version > 0),
  execution_mode                     text NOT NULL CHECK (execution_mode IN ('best_efforts', 'mandatory')),
  instruments                        text[] NOT NULL DEFAULT '{fnma_mandatory_commitment}',              -- ⊆ {fnma_mandatory_commitment, tba_umbs_30, tba_umbs_15}
  hedge_products                     text[] NOT NULL DEFAULT '{30yr_fixed_conforming,15yr_fixed_conforming}',
  coverage_band_low                  numeric(6,4) NOT NULL DEFAULT 0.8500,
  coverage_band_high                 numeric(6,4) NOT NULL DEFAULT 1.1000,
  max_uncommitted_days               int NOT NULL DEFAULT 5,                                             -- SM_UNCOMMITTED_POSITION_5BD
  max_unhedged_cents                 bigint NOT NULL DEFAULT 0,
  rate_shock_limit_cents             jsonb NOT NULL DEFAULT '{}'::jsonb,                                 -- per shock bp → limit (default ±100 bp: 1.5% of the hedged pipeline)
  margin_liquidity_reserve_cents     bigint NOT NULL DEFAULT 0,                                          -- the −100 bp projected call plus 25%
  trade_authorization_threshold_cents bigint NOT NULL DEFAULT 0,                                         -- 0 = every trade authorized by the officer
  auto_execute_within_band           boolean NOT NULL DEFAULT false,
  roll_lead_business_days            int NOT NULL DEFAULT 3,                                             -- SIFMA_TBA_ROLL_GATE_3BD
  dealer_margin_threshold_cents      bigint NOT NULL DEFAULT 2500000,                                    -- modeled $25,000 (FINRA 4210 floor $250,000)
  dealer_min_lot_cents               bigint NOT NULL DEFAULT 25000000,                                   -- $250,000 [UNVERIFIED — dealer terms]
  servicing_value_multiple           numeric(6,3) NOT NULL DEFAULT 4.500,                                -- partner MSR multiple (SAB 109 servicing component)
  servicing_fee_bps                  int NOT NULL DEFAULT 25,
  default_duration                   numeric(6,4) NOT NULL DEFAULT 4.0000,
  approved_by                        text,
  approved_at                        timestamptz,
  effective_from                     date NOT NULL,
  review_due_on                      date NOT NULL,                                                      -- effective_from + 1 year (SM_HEDGE_POLICY_REVIEW_1Y)
  status                             text NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, version),
  CHECK (coverage_band_low > 0 AND coverage_band_low < coverage_band_high),
  CHECK (review_due_on > effective_from)
);
COMMENT ON TABLE hedge_policies IS '29.2 data model: the partner''s hedging / secondary-marketing policy as data — execution mode, instruments, coverage band (default 0.85–1.10), limits, dealer terms, model governance; a new version approved by the partner officer satisfies SM_HEDGE_POLICY_REVIEW_1Y; while the review is overdue new locks stay best efforts.';
CREATE UNIQUE INDEX hedge_policies_one_approved ON hedge_policies(partner_id) WHERE status = 'approved';

-- Pull-through model versions (rule 2; rule 14 LL-2026-04 governance) and per-lock estimates.
CREATE TABLE pull_through_models (
  model_id                 text PRIMARY KEY,                                                              -- e.g. pull_through.v1
  version                  text NOT NULL,
  method                   text NOT NULL CHECK (method IN ('lookup', 'logistic', 'ml')),
  features                 text[] NOT NULL,                                                               -- stage, days_to_expiry bucket, rate_move_bps bucket, transaction_type, occupancy, ltv bucket, channel, state
  parameters               jsonb NOT NULL,                                                                -- v1 lookup: stage_base {locked 0.72, du_approved 0.80, ctc 0.92, cd_delivered 0.97, consummated 0.995, funded 1.00}, −0.02 per −12.5 bp, +0.01 per +12.5 bp, floor 0.50, cap 1.00, refinance −0.05
  calibration_window       daterange,
  validation_document_id   uuid REFERENCES documents(id),
  approved_by              text,                                                                          -- partner officer
  o12_2_review_id          text,                                                                          -- 31.2 model inventory entry
  effective_from           date NOT NULL,
  status                   text NOT NULL CHECK (status IN ('proposed', 'approved', 'stale', 'superseded')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pull_through_models IS '29.2 rule 2 / 14: pull-through model versions registered in the 31.2 model inventory; a change in method (lookup → logistic/ML) needs officer approval and an 31.2 review before use; SM_PULL_THROUGH_MODEL_RECALIBRATION_90 flags a stale model (hedge ratios move to the conservative band edge).';

CREATE TABLE pull_through_estimates (
  estimate_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_id                    uuid NOT NULL REFERENCES locks(lock_id),
  as_of                      timestamptz NOT NULL,
  model_id                   text NOT NULL REFERENCES pull_through_models(model_id),
  stage                      text NOT NULL CHECK (stage IN ('locked', 'du_approved', 'ctc', 'cd_delivered', 'consummated', 'funded')),
  rate_move_bps              int NOT NULL DEFAULT 0,                                                       -- current market rate − lock rate
  days_to_expiry             int,
  probability                numeric(6,4) NOT NULL CHECK (probability BETWEEN 0 AND 1),
  expected_deliverable_cents bigint NOT NULL,                                                              -- p × amount (half-up)
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pull_through_estimates IS '29.2 rule 2: per-lock probability by stage × days-to-expiry × rate-move bucket (× transaction type …); expected_deliverable = Σ p × amount.';
CREATE INDEX pull_through_estimates_lock_idx ON pull_through_estimates(lock_id, as_of);
CREATE TRIGGER pull_through_estimates_immutable BEFORE UPDATE OR DELETE ON pull_through_estimates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Fallout by reason (rule 2 monthly review; feeds 21.4 lock policy). Append-only.
CREATE TABLE fallout_events (
  fallout_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_id                    uuid NOT NULL REFERENCES locks(lock_id),
  commitment_id              uuid REFERENCES commitments(commitment_id),
  occurred_at                timestamptz NOT NULL,
  stage                      text NOT NULL CHECK (stage IN ('locked', 'du_approved', 'ctc', 'cd_delivered', 'consummated', 'funded')),
  reason                     text NOT NULL CHECK (reason IN ('borrower_withdrawal', 'lender_declination', 'relock_elsewhere', 'ineligible', 'expired_unclosed', 'closed_undeliverable', 'other')),
  rate_move_bps_at_fallout   int NOT NULL DEFAULT 0,
  days_in_pipeline           int NOT NULL CHECK (days_in_pipeline >= 0),
  dpa_incurred_cents         bigint NOT NULL DEFAULT 0,                                                    -- 29.1 duplicate price adjustment
  pair_off_fee_cents         bigint NOT NULL DEFAULT 0,                                                    -- closed_undeliverable → 29.1 pair-off
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE fallout_events IS '29.2 data model: one row per lock that exits the pipeline without purchase (reason, stage, rate move, days in pipeline, DPA / pair-off cost) — the monthly cohort statistics compare realized pull-through with the model.';
CREATE INDEX fallout_events_occurred_idx ON fallout_events(occurred_at, reason);
CREATE TRIGGER fallout_events_immutable BEFORE UPDATE OR DELETE ON fallout_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Daily (07:00 ET) and intraday snapshots (rules 1, 3, 12, 13). Append-only.
CREATE TABLE pipeline_positions (
  snapshot_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of                          timestamptz NOT NULL,
  execution_mode                 text NOT NULL CHECK (execution_mode IN ('best_efforts', 'mandatory')),
  intraday                       boolean NOT NULL DEFAULT false,
  buckets                        jsonb NOT NULL DEFAULT '[]'::jsonb,                                       -- keyed by (product_code, amortization, note_rate, ptr, lock_status)
  locked_uncommitted_cents       bigint NOT NULL DEFAULT 0,
  committed_be_cents             bigint NOT NULL DEFAULT 0,
  closed_be_cents                bigint NOT NULL DEFAULT 0,
  mandatory_pipeline_cents       bigint NOT NULL DEFAULT 0,                                               -- locked loans covered by the hedge program
  funded_unsold_cents            bigint NOT NULL DEFAULT 0,                                               -- held for sale on the warehouse line
  expected_pull_through_pct      numeric(7,4),
  expected_deliverable_cents     bigint NOT NULL DEFAULT 0,
  hedge_face_cents               bigint NOT NULL DEFAULT 0,
  duration_factor                numeric(6,4) NOT NULL DEFAULT 1.0000,
  coverage_ratio                 numeric(6,4),
  within_band                    boolean NOT NULL DEFAULT true,
  whole_loan_mark_price          numeric(9,5),
  tba_mark_price                 numeric(9,5),
  pipeline_value_cents           bigint NOT NULL DEFAULT 0,
  hedge_value_cents              bigint NOT NULL DEFAULT 0,
  net_value_cents                bigint NOT NULL DEFAULT 0,
  expirations_7d                 jsonb NOT NULL DEFAULT '[]'::jsonb,                                       -- 29.1 commitments expiring within 7 days
  dpa_exposures                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  undeliverable_closed_cents     bigint NOT NULL DEFAULT 0,
  pair_off_risk_cents            bigint NOT NULL DEFAULT 0,
  extension_carry_accrued_cents  bigint NOT NULL DEFAULT 0,
  residual_shocks                jsonb NOT NULL DEFAULT '{}'::jsonb,                                       -- rule 12: uncommitted exposure per shock (+25 bp on $1.5M at duration 4.0 → −$15,000)
  price_source                   text NOT NULL,
  agent_decision_id              uuid REFERENCES agent_decisions(id),
  created_at                     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pipeline_positions IS '29.2 data model: the 07:00 ET position (12:00 / 16:00 intraday; 12:30 on SIFMA early-close days) — buckets, totals, expected deliverable, hedge face, coverage, marks and the best-efforts residual exposures; satisfies SM_PIPELINE_POSITION_DAILY_0700ET / SM_PIPELINE_INTRADAY_MOVE_TRIGGER.';
CREATE INDEX pipeline_positions_as_of_idx ON pipeline_positions(as_of);
CREATE TRIGGER pipeline_positions_immutable BEFORE UPDATE OR DELETE ON pipeline_positions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Executions recorded from confirmations against the 0103 hedge_positions rows (state machine). Append-only.
CREATE TABLE hedge_trades (
  trade_id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id                uuid NOT NULL REFERENCES hedge_positions(position_id),
  kind                       text NOT NULL CHECK (kind IN ('open', 'pair_off', 'roll_close', 'roll_open', 'assign_to_commitment')),
  face_cents                 bigint NOT NULL CHECK (face_cents > 0),
  price                      numeric(9,5) NOT NULL,
  executed_at                timestamptz NOT NULL,
  executed_by                text NOT NULL,                                                                -- the partner's trader (dealer) / fnma_portal_operator (commitments)
  confirmation_document_id   uuid NOT NULL REFERENCES documents(id),                                       -- no trade without a confirmation
  realized_pl_cents          bigint,                                                                       -- pair-off: face × (trade_price − pair_off_price)/100 (short)
  created_at                 timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE hedge_trades IS '29.2 data model: every dealer / Fannie Mae execution keyed by the confirmation (open, pair_off, roll_close, roll_open, assign_to_commitment); emits hedge.trade.executed (arms SIFMA_TBA_ROLL_GATE_3BD on an open TBA).';
CREATE INDEX hedge_trades_position_idx ON hedge_trades(position_id, executed_at);
CREATE TRIGGER hedge_trades_immutable BEFORE UPDATE OR DELETE ON hedge_trades FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The 17:00 ET mark (rules 5, 6; ASC 815/948/825 outputs) and its GL export. Append-only.
CREATE TABLE mark_to_market_runs (
  run_id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of                              timestamptz NOT NULL,
  snapshot_id                        uuid REFERENCES pipeline_positions(snapshot_id),
  price_sources                      jsonb NOT NULL,                                                       -- price ids (pewl_price_captures{purpose='mark'}, dealer 5:00 p.m. run)
  irlc_fv_cents                      bigint NOT NULL,
  irlc_sale_price_component_cents    bigint NOT NULL,                                                      -- (market − lock base) × amount × p — the Grander pass-through pool
  irlc_servicing_component_cents     bigint NOT NULL,                                                      -- multiple × fee/10,000 × amount × p — the partner's MSR economics (SAB 109)
  hfs_loans_fv_cents                 bigint NOT NULL DEFAULT 0,
  hfs_loans_cost_basis_cents         bigint NOT NULL DEFAULT 0,
  hedge_fv_cents                     bigint NOT NULL DEFAULT 0,                                            -- face × (trade − mark)/100 for a short
  net_fv_cents                       bigint NOT NULL,
  day_change_cents                   bigint NOT NULL,
  realized_pl_mtd_cents              bigint NOT NULL DEFAULT 0,
  stale_prices                       text[] NOT NULL DEFAULT '{}',
  gl_export_document_id              text NOT NULL,                                                        -- deterministic on (snapshot, price ids): a rerun reproduces the file
  export_hash                        text NOT NULL,
  exported_at                        timestamptz NOT NULL,
  agent_decision_id                  uuid REFERENCES agent_decisions(id),
  created_at                         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mark_to_market_runs IS '29.2 rules 5–6: IRLC fair value (sale-price and servicing components reported separately — SAB 105/109), held-for-sale valuation (LOCOM or FVO), hedge fair value, net and day change, with the GL export by 19:00 ET (SM_MTM_DAILY_1700ET).';
CREATE INDEX mark_to_market_runs_as_of_idx ON mark_to_market_runs(as_of);
CREATE TRIGGER mark_to_market_runs_immutable BEFORE UPDATE OR DELETE ON mark_to_market_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rule 7: the daily rate-shock table. Append-only.
CREATE TABLE rate_shock_reports (
  report_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of                   timestamptz NOT NULL,
  shocks                  jsonb NOT NULL,                                                                  -- [−100, −50, −25, 0, +25, +50, +100] bp → pipeline value, hedge value, net, p, coverage, projected margin call, projected pair-off cost
  limits_checked          jsonb NOT NULL DEFAULT '[]'::jsonb,                                              -- vs hedge_policies.rate_shock_limit_cents per shock
  published_document_id   text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE rate_shock_reports IS '29.2 rule 7: Δprice ≈ −duration × s/100; p re-estimated under the shock; projected margin call = max(0, hedge MTM loss − margin posted); compared with the policy limits (SM_RATE_SHOCK_REPORT_DAILY).';
CREATE TRIGGER rate_shock_reports_immutable BEFORE UPDATE OR DELETE ON rate_shock_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- FINRA 4210 variation margin (open → funded | disputed); funded only by a wire under funding_approver dual control.
CREATE TABLE margin_calls (
  call_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id   text NOT NULL,                                                                          -- broker-dealer under the MSFTA margin annex
  received_at       timestamptz NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents > 0),
  basis             jsonb NOT NULL DEFAULT '{}'::jsonb,                                                    -- positions, marks, excess net MTM loss, annex threshold
  due_on            date NOT NULL,
  due_at            timestamptz NOT NULL,                                                                  -- close of business the next business_days_fannie_et day (14:00 ET on SIFMA early-close days)
  funded_at         timestamptz,
  wire_id           text,                                                                                  -- 26.3 wire rail
  status            text NOT NULL CHECK (status IN ('open', 'funded', 'disputed')),
  escalation_id     uuid REFERENCES escalations(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'funded' OR (funded_at IS NOT NULL AND wire_id IS NOT NULL))
);
COMMENT ON TABLE margin_calls IS '29.2 data model: dealer variation-margin calls on the partner''s TBA shorts (FINRA Rule 4210(e)(2)(H), amendments effective May 22, 2024); FINRA_4210_VARIATION_MARGIN_1BD from receipt; disputed marks → officer engages the dealer.';
CREATE INDEX margin_calls_open_idx ON margin_calls(status, due_at) WHERE status = 'open';

COMMIT;
