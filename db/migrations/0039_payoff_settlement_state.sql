-- 0039_payoff_settlement_state.sql — §16.2 (Remit payoff proceeds to Fannie Mae): the columns the 16.2 tools persist on the
-- 0018 tables (payoff_funds, payoff_settlements, payoff_housekeeping_tasks) so the guardrail "CRS amounts must equal
-- payoff_settlements values" is enforced against the stored share, plus the chart-of-accounts rows the 16.2 Outputs ledger
-- sets post to (rules 2, 4, 5, 10 and the missed-CRS-cutoff exposure). Append-only: 0018 is not edited.

-- payoff_funds: the intake's match / good-funds evidence (rule 1, good-funds policy, edge case "partial data")
ALTER TABLE payoff_funds
  ADD COLUMN payoff_date_basis   text CHECK (payoff_date_basis IN ('credited_as_of','closing_agent_settlement_date','f109_non_business_day')),
  ADD COLUMN expected_clear_at   timestamptz,
  ADD COLUMN good_funds_hold     text,
  ADD COLUMN match_status        text CHECK (match_status IN ('matched','unmatched')),
  ADD COLUMN match_basis         text CHECK (match_basis IN ('reference','amount_within_tolerance')),
  ADD COLUMN research_by         date,
  ADD COLUMN settlement_id       uuid REFERENCES payoff_settlements(id);

-- payoff_settlements: Fannie Mae's share and the CRS figures (rule 4, rule 7), the application (rule 3), finality and the
-- reversal branches (rule 6), the S/S BD1/BD2 exception derived from the fannie_et calendar (F-1-20), the activity period (IRM §2-04)
ALTER TABLE payoff_settlements
  ADD COLUMN processed_on                 date,
  ADD COLUMN activity_period              text,                                   -- YYYY-MM the LAR 60 reports in
  ADD COLUMN funds_id                     uuid REFERENCES payoff_funds(id),
  ADD COLUMN amount_received_cents        bigint,
  ADD COLUMN fnma_share_cents             bigint,                                 -- principal + interest at PTR × participation: the CRS 001 / drafted amount
  ADD COLUMN scheduled_cycle_interest_cents bigint NOT NULL DEFAULT 0,            -- S/A–S/S: PTR interest for the full months from the LPI date, remitted through the regular draft
  ADD COLUMN ss_bd1_bd2_exception         boolean NOT NULL DEFAULT false,
  ADD COLUMN crs_001_cents                bigint,
  ADD COLUMN special_remit_by             date,
  ADD COLUMN draft_on                     date,
  ADD COLUMN tolerance_expense_cents      bigint NOT NULL DEFAULT 0,
  ADD COLUMN absorbed_shortage_cents      bigint NOT NULL DEFAULT 0,
  ADD COLUMN servicer_funded_cents        bigint NOT NULL DEFAULT 0,
  ADD COLUMN lines                        jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN zero                         boolean NOT NULL DEFAULT false,
  ADD COLUMN ledger_set_ids               jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN remitted_on                  date,
  ADD COLUMN payoff_reversed              boolean NOT NULL DEFAULT false,
  ADD COLUMN reversed_at                  timestamptz,
  ADD COLUMN correcting_event_id          uuid REFERENCES investor_events(id),
  ADD COLUMN correction_accepted_at       timestamptz,
  ADD COLUMN ledger_reversal_set_ids      jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN timers_cancelled             jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN fnma_liquidated_in_error     boolean NOT NULL DEFAULT false,
  ADD COLUMN liquidated_in_error_at       timestamptz,
  ADD COLUMN amount_due_to_fnma_cents     bigint,
  ADD COLUMN noe_case_id                  uuid;
ALTER TABLE payoff_settlements DROP CONSTRAINT IF EXISTS payoff_settlements_status_check;
ALTER TABLE payoff_settlements ADD CONSTRAINT payoff_settlements_status_check
  CHECK (status IN ('open','paid_in_full','remitted','housekeeping_complete','closed','reversed_pre_close','reversed_post_close'));

-- payoff_housekeeping_tasks: the loan, the timer code and calendar due date the fan-out computes (rule 9), the rule 6 reversal action
ALTER TABLE payoff_housekeeping_tasks
  ADD COLUMN loan_id          uuid REFERENCES loans(id),
  ADD COLUMN timer_code       text,
  ADD COLUMN due_on           date,
  ADD COLUMN reversal_action  text,
  ADD COLUMN reversed_at      timestamptz;
ALTER TABLE payoff_housekeeping_tasks DROP CONSTRAINT IF EXISTS payoff_housekeeping_tasks_status_check;
ALTER TABLE payoff_housekeeping_tasks ADD CONSTRAINT payoff_housekeeping_tasks_status_check
  CHECK (status IN ('open','completed','reversed','cancelled'));

-- Chart of accounts: the 16.2 Outputs ledger sets (custodial recognition of Fannie Mae's share and the servicing fee, the buydown
-- credit, the corporate expenses rules 2/4/5 name, the A1-4.2-01 exposure memo). Loan-scope accounts the sets post to that 0024 lacks.
INSERT INTO ledger_accounts (scope, account, kind, section, description) VALUES
  ('loan',      'nsf_fees',                        'memo',      '2.7',  'NSF fees receivable (memo)'),
  ('loan',      'other_fees',                      'memo',      '2.7',  'other fees receivable (memo)'),
  ('loan',      'recording_fee_payable',           'liability', '16.2', 'third-party recording / release fee collected under C-1.2-05 (never netted from proceeds, F-1-05)'),
  ('custodial', 'clearing_cash',                   'clearing',  '2.1',  'bank clearing (lockbox / wire / ACH) before the custodial split'),
  ('custodial', 'pi_collections_unremitted',       'memo',      '16.2', 'P&I collections recognised but not yet drafted (rule 4 recognition)'),
  ('custodial', 'servicing_fee_withdrawable',      'liability', '16.2', 'servicing fee retained from the payoff interest (note rate − PTR), withdrawable from the P&I custodial'),
  ('custodial', 'buydown_funds_held',              'liability', '16.2', 'buydown funds held and applied to the payoff (C-1.2-03), remitted with the proceeds'),
  ('corporate', 'payoff_tolerance_expense',        'expense',   '16.2', 'short payoff within the $50 tolerance absorbed (rule 2)'),
  ('corporate', 'payoff_shortfall_expense',        'expense',   '16.2', 'servicer- or reliance-absorbed payoff shortage (rule 5; §1024.35(b)(6) statement error)'),
  ('corporate', 'payoff_interest_shortfall_expense','expense',  '16.2', 'S/S full-month / S/A half-month PTR interest the servicer funds at payoff (F-1-20; open question 1: expense, not servicer_advance_receivable)'),
  ('corporate', 'escrow_advance_recovery',         'income',    '16.2', 'escrow advances recovered in the payoff'),
  ('corporate', 'comp_fee_exposure',               'memo',      '16.2', 'A1-4.2-01 late-remittance fee exposure logged for the 6.3 reconciliation when the CRS 16:00 ET cut-off is missed')
ON CONFLICT DO NOTHING;
