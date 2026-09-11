-- 0060_escrow_credit_transfers.sql — §30.3 escrow account establishment at origination.
-- New table `escrow_credit_transfers` (30.3 data model: the §1024.34(b)(2) same-servicer refinance credit of the prior
-- loan's remaining escrow balance to the new loan's escrow account, posted at the new loan's settlement with the
-- borrower's recorded agreement) plus the columns 30.3 adds to the servicing-owned escrow tables (3.1/3.2/3.8 own the
-- tables; 30.3 sets the origination columns) and the `escrow_credit_to_new_loan` consent kind 3.5 names.
-- Append-only: the transfer is a ledger fact (its entry sets are immutable); rows are never updated or deleted.
BEGIN;

-- consents{kind=escrow_credit_to_new_loan} (7.4 table; 3.5 names the kind; 30.3 rule 8 captures it before settlement).
ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'escrow_credit_to_new_loan';
ALTER TABLE consents ADD COLUMN IF NOT EXISTS new_application_id uuid REFERENCES applications(id);
COMMENT ON COLUMN consents.new_application_id IS '30.3 rule 8: the refinance application whose escrow account receives a §1024.34(b)(2) credit (consent kind escrow_credit_to_new_loan; loan_id is the loan being paid off)';

-- escrow_accounts (3.1 owns; 30.3 columns set at establishment).
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS establishment_reason text CHECK (establishment_reason IN ('origination', 'transfer_in', 'waiver_revoked', 'borrower_request'));
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS established_at date;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS computation_year_end date;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS cushion_cap_source text;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS monthly_escrow_payment_cents bigint;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS custodial_account_id text;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS interest_rule_code text;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS hpml_escrow_min_cancel_date date;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS origination_waiver_id uuid REFERENCES escrow_waivers(id);
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS initial_statement_delivered_at date;
ALTER TABLE escrow_accounts ADD COLUMN IF NOT EXISTS initial_statement_delivery_basis text CHECK (initial_statement_delivery_basis IN ('at_settlement', 'within_45_days'));
COMMENT ON COLUMN escrow_accounts.hpml_escrow_min_cancel_date IS '30.3 rule 9: consummation + 5 years from 23.4''s hpml_determinations (§1026.35(b)(3)(i)(B)); null when not HPML';
COMMENT ON COLUMN escrow_accounts.custodial_account_id IS 'custodial_ti_prepurchase from funding until purchase; the Fannie Mae T&I account after 30.1';

-- escrow_lines (3.2 owns; 0004 added source/estimate_basis/installment_count/terminates_on/effective_from): `source` gains `origination` (30.3 data model).
ALTER TABLE escrow_lines DROP CONSTRAINT IF EXISTS escrow_lines_source_check;
ALTER TABLE escrow_lines ADD CONSTRAINT escrow_lines_source_check CHECK (source IN ('tax_service', 'insurance_tracker', 'mi_adapter', 'hoa_manual', 'boarding', 'origination'));
ALTER TABLE escrow_lines ADD COLUMN IF NOT EXISTS payee_reference text;
COMMENT ON COLUMN escrow_lines.payee_reference IS '30.3: APN, policy number or MI certificate the line pays';

-- escrow_analyses (3.2 owns; 30.3 columns: source, the CD version, dates, the (g)(3) single-item lines and aggregate adjustment, (l)(7) figures, freeze).
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'servicing' CHECK (source IN ('origination', 'servicing'));
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES applications(id);
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS cd_version_id text;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS settlement_date date;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS disbursement_date date;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS first_payment_date date;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS single_item_lines jsonb;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS aggregate_adjustment_cents bigint;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS escrowed_costs_year1_cents bigint;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS non_escrowed_costs_year1_cents bigint;
ALTER TABLE escrow_analyses ADD COLUMN IF NOT EXISTS frozen_at timestamptz;
COMMENT ON COLUMN escrow_analyses.single_item_lines IS '30.3 rule 4: the CD (g)(3) months × per-month amount per item; aggregate_adjustment_cents = target_at_start_cents − Σ lines (≤ 0)';

-- escrow_waivers (3.8 owns; 30.3 origination-use columns).
ALTER TABLE escrow_waivers ADD COLUMN IF NOT EXISTS application_id uuid REFERENCES applications(id);
ALTER TABLE escrow_waivers ADD COLUMN IF NOT EXISTS policy_version text;
ALTER TABLE escrow_waivers ADD COLUMN IF NOT EXISTS borrower_election_document_id uuid REFERENCES documents(id);
ALTER TABLE escrow_waivers ADD COLUMN IF NOT EXISTS pricing_adjustment_bps integer NOT NULL DEFAULT 0;
ALTER TABLE escrow_waivers ALTER COLUMN loan_id DROP NOT NULL;
COMMENT ON COLUMN escrow_waivers.application_id IS '30.3 rule 7: an origination-time waiver is decided on the application before a loan row exists (loan_id set at funding, 30.2)';

-- §1024.34(b)(2): same-servicer refinance escrow credit (30.3 rule 8; worked example 3).
CREATE TABLE escrow_credit_transfers (
  id                                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_loan_id                               uuid NOT NULL REFERENCES loans(id),          -- the loan paid off (subserviced by SM)
  new_loan_id                               uuid REFERENCES loans(id),                   -- set once 30.2 creates the servicing row
  new_application_id                        uuid NOT NULL REFERENCES applications(id),
  agreement_consent_id                      uuid NOT NULL REFERENCES consents(id),       -- consents{kind=escrow_credit_to_new_loan, captured_at ≤ settlement}
  old_balance_after_final_disbursements_cents bigint NOT NULL CHECK (old_balance_after_final_disbursements_cents >= 0),
  credited_cents                            bigint NOT NULL CHECK (credited_cents >= 0),
  refunded_remainder_cents                  bigint NOT NULL DEFAULT 0 CHECK (refunded_remainder_cents >= 0),   -- (b)(1) refund of any excess over target_at_start
  payoff_date                               date NOT NULL,
  posted_at                                 date NOT NULL,                               -- the new loan's settlement date
  ledger_entry_ids                          uuid[] NOT NULL DEFAULT '{}',                -- Dr old escrow / Cr new escrow; Fannie Mae T&I → custodial_ti_prepurchase
  cash_from_custodial_account_id            text NOT NULL,
  cash_to_custodial_account_id              text NOT NULL DEFAULT 'custodial_ti_prepurchase',
  cd_line_reference                         text,                                        -- 25.2's credit line (open question 5)
  borrower_closing_escrow_funds_cents       bigint NOT NULL CHECK (borrower_closing_escrow_funds_cents >= 0),   -- target_at_start − credited
  rule_ref                                  text NOT NULL DEFAULT '12 CFR 1024.34(b)(2); comment 34(b)(1)-1',
  source_event_id                           uuid REFERENCES loan_events(id),
  created_at                                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE escrow_credit_transfers IS '30.3 rule 8: the remaining escrow balance of a same-servicer loan being refinanced, credited to the new loan''s escrow at settlement with the borrower''s recorded/written agreement (§1024.34(b)(2)); append-only';
CREATE INDEX escrow_credit_transfers_old_loan_idx ON escrow_credit_transfers(old_loan_id);
CREATE INDEX escrow_credit_transfers_new_app_idx ON escrow_credit_transfers(new_application_id);
CREATE TRIGGER escrow_credit_transfers_immutable BEFORE UPDATE OR DELETE ON escrow_credit_transfers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
