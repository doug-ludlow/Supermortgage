-- 0027: §5 data model — `servicer_advance_receivable` (5.2 "Ledger accounts added (per custodial account)",
-- 5.4 ledger, 5.5 rule 4 `servicer_advance_receivable(gfee)`, 5.2-T6 reason `ss_payoff_interest`) as the
-- per-custodial-account subledger behind the ledger account of the same name, and the versioned F-1-21 /
-- Servicing Platform code maps `dq_status_code_map` / `dq_reason_code_map` (5.7 data model).
BEGIN;

CREATE TABLE servicer_advance_receivable (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  loan_id               uuid REFERENCES loans(id),
  advance_id            uuid REFERENCES advances(id),
  kind                  text NOT NULL CHECK (kind IN ('pi_delinquency', 'sa_interest', 'gfee', 'ss_payoff_interest', 'compensatory', 'other')),
  reason                text NOT NULL,                                    -- e.g. ss_payoff_interest (5.2-T6), sda_draft (5.4), gfee_draft (5.5)
  activity_period       char(7) NOT NULL,
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  status                text NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding', 'reimbursed_by_fnma', 'recovered_from_borrower', 'recovered_from_proceeds', 'written_off')),
  posted_entry_set_id   uuid,                                             -- Dr servicer_advance_receivable / Cr custodial_pi_cash
  recovered_entry_set_id uuid,                                            -- the reversing set on reimbursement/recovery
  recovered_at          timestamptz,
  recovery_source       text CHECK (recovery_source IN ('fnma_reimbursement', 'fnma_recovery_credit', 'borrower_payment', 'payoff_proceeds', 'responsible_party')),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX servicer_advance_receivable_open_idx ON servicer_advance_receivable (custodial_account_id, status) WHERE status = 'outstanding';
CREATE INDEX servicer_advance_receivable_loan_idx ON servicer_advance_receivable (loan_id, activity_period);
COMMENT ON TABLE servicer_advance_receivable IS '§5.2/5.4/5.5: subledger of corporate advances into a custodial account, matched FIFO to Fannie Mae reimbursement/recovery credits (SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES, SM_GFEE_RECOVERY_MATCH_2_CYCLES); the ledger_accounts row of the same name carries the balance.';

CREATE TABLE dq_status_code_map (
  rule_set              text NOT NULL,                                    -- fnma.f121.codes.2023-10 | fnma.se.delinquency.v1
  internal_state        text NOT NULL,
  code                  text NOT NULL,                                    -- F-1-21 2-character status code or Servicing Platform allowable value
  priority_level        smallint NOT NULL CHECK (priority_level BETWEEN 1 AND 5),
  requires_effective    boolean NOT NULL DEFAULT false,
  requires_completion   boolean NOT NULL DEFAULT false,
  one_month_only        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (rule_set, internal_state)
);
COMMENT ON TABLE dq_status_code_map IS '§5.7 rule 2: internal loan state → F-1-21 status code with priority level and date requirements; versioned by rule set.';
INSERT INTO dq_status_code_map (rule_set, internal_state, code, priority_level, requires_effective, requires_completion, one_month_only) VALUES
  ('fnma.f121.codes.2023-10', 'trial_active',            'BF', 1, true,  true,  false),
  ('fnma.f121.codes.2023-10', 'forbearance_active',      '09', 1, true,  true,  false),
  ('fnma.f121.codes.2023-10', 'repayment_active',        '12', 1, true,  true,  false),
  ('fnma.f121.codes.2023-10', 'short_sale_offer',        '17', 1, true,  false, false),
  ('fnma.f121.codes.2023-10', 'short_sale_marketing',    '15', 5, true,  false, false),
  ('fnma.f121.codes.2023-10', 'modification_completed',  '28', 1, true,  false, false),
  ('fnma.f121.codes.2023-10', 'scra',                    '32', 1, true,  false, false),
  ('fnma.f121.codes.2023-10', 'mortgage_release_approved','44', 1, true,  false, false),
  ('fnma.f121.codes.2023-10', 'chargeoff',               '29', 1, true,  false, false),
  ('fnma.f121.codes.2023-10', 'assumption',              '27', 1, true,  false, false),
  ('fnma.f121.codes.2023-10', 'brp_complete',            'H5', 2, true,  false, false),
  ('fnma.f121.codes.2023-10', 'bankruptcy_ch7',          '65', 3, true,  false, false),
  ('fnma.f121.codes.2023-10', 'bankruptcy_ch11',         '66', 3, true,  false, false),
  ('fnma.f121.codes.2023-10', 'bankruptcy_ch13',         '67', 3, true,  false, false),
  ('fnma.f121.codes.2023-10', 'bankruptcy_ch12',         '59', 3, true,  false, false),
  ('fnma.f121.codes.2023-10', 'bankruptcy_ch13_post_petition', '69', 3, true, false, false),
  ('fnma.f121.codes.2023-10', 'bankruptcy_ch7_asset',    '3L', 3, true,  false, false),
  ('fnma.f121.codes.2023-10', 'bankruptcy_surrender',    '3M', 3, true,  false, false),
  ('fnma.f121.codes.2023-10', 'referred',                '43', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'sale_scheduled',          '71', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'sale_continued',          '95', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'judgment',                '94', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'contested',               '33', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'mediation',               'BG', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'title_issue',             'BE', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'probate',                 '31', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'partial_reinstatement',   '20', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'third_party_sale',        '30', 4, true,  false, false),
  ('fnma.f121.codes.2023-10', 'qrpc_no_solution',        'AW', 5, true,  false, true),
  ('fnma.f121.codes.2023-10', 'breach_letter',           '80', 5, true,  false, false),
  ('fnma.f121.codes.2023-10', 'delinquent_30_plus',      '42', 5, false, false, false);

CREATE TABLE dq_reason_code_map (
  rule_set              text NOT NULL,
  hardship              text NOT NULL,
  code                  text NOT NULL,                                    -- 001–031 / INC
  requires_borrower_statement boolean NOT NULL DEFAULT true,
  PRIMARY KEY (rule_set, hardship)
);
COMMENT ON TABLE dq_reason_code_map IS '§5.7 rule 3: hardship captured at QRPC/loss-mit intake → delinquency reason code; 031 when no contact, 015 (other) with a decision note.';
INSERT INTO dq_reason_code_map (rule_set, hardship, code, requires_borrower_statement) VALUES
  ('fnma.f121.codes.2023-10', 'death',                 '001', true),
  ('fnma.f121.codes.2023-10', 'illness',               '002', true),
  ('fnma.f121.codes.2023-10', 'divorce',               '004', true),
  ('fnma.f121.codes.2023-10', 'curtailment_of_income', '006', true),
  ('fnma.f121.codes.2023-10', 'disaster',              '019', true),
  ('fnma.f121.codes.2023-10', 'unemployment',          '016', true),
  ('fnma.f121.codes.2023-10', 'military',              '014', true),
  ('fnma.f121.codes.2023-10', 'other',                 '015', true),
  ('fnma.f121.codes.2023-10', 'unable_to_contact',     '031', false);

COMMIT;
