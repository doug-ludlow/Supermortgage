-- 0058_post_purchase_setup.sql — 30.1 Fannie Mae post-purchase servicing setup: the two tables the process defines
-- (spec/sections/30-…/30-1-…md "Data model"). `loans` investor columns, `loan_terms` versions, `investor_loan_positions`
-- (5.1), `mers_transactions`/`mers_min_snapshots` (1.5), `enotes`/`custody_records` (1.4) and `investor_events` (5.1) are
-- servicing tables this process writes to, never redefined here. Append-only where the spec's rows are snapshots.
BEGIN;

-- Rule 12: one row per establishment check against Fannie Mae's records (LSDU position extract, Connect Loan Activity
-- Summary, Servicing Platform position) compared to the `investor_loan_positions` seed. Snapshots — append-only.
CREATE TABLE fnma_establishment_checks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id              uuid NOT NULL REFERENCES loans(id),
  checked_at           timestamptz NOT NULL,
  source               text NOT NULL CHECK (source IN ('lsdu_position', 'connect_loan_activity_summary', 'servicing_platform_position')),
  found                boolean NOT NULL,
  fnma_lpi_date        date,
  fnma_upb_cents       bigint,
  fnma_remittance_type text CHECK (fnma_remittance_type IN ('AA', 'SA', 'SS')),
  fnma_ptr             numeric(9,6),
  variance             jsonb,                                   -- {upb_diff_cents, lpi_match, remittance_match, ptr_match, within_tolerance} (UPB tolerance ±$0.05)
  agent_run_id         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (found = false OR (fnma_upb_cents IS NOT NULL AND fnma_remittance_type IS NOT NULL AND fnma_ptr IS NOT NULL))
);
COMMENT ON TABLE fnma_establishment_checks IS '30.1 rule 12: establishment reconciliation snapshots — Fannie Mae''s LPI/UPB/remittance type/PTR vs the investor_loan_positions seed; found=true and within tolerance emits loan.fnma_established, otherwise position_variance (money → officer, PPA/Loan Data Change package). Append-only.';
CREATE INDEX fnma_establishment_checks_loan_idx ON fnma_establishment_checks(loan_id, checked_at);
CREATE TRIGGER fnma_establishment_checks_immutable BEFORE UPDATE OR DELETE ON fnma_establishment_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Rule 8 / F-1-03: the pre-purchase custodial balances (escrow deposit collected at closing; any P&I received between
-- delivery and purchase; buydown funds) moved to the Fannie Mae T&I / P&I custodial account of the loan's remittance
-- type no later than one servicer business day after the purchase proceeds are received. Ledger: custodial book
-- transfer only (no borrower-level entry). transferred_at / bank_reference / ledger_entry_id are set when the transfer
-- posts and the bank feed shows the credit.
CREATE TABLE custodial_transfers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id              uuid NOT NULL REFERENCES loans(id),
  kind                 text NOT NULL CHECK (kind IN ('ti_escrow_balance', 'ti_buydown_funds', 'pi_prepurchase_collections')),
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  from_account_id      text NOT NULL CHECK (from_account_id IN ('custodial_ti_prepurchase', 'custodial_pi_prepurchase')),
  to_account_id        uuid NOT NULL REFERENCES custodial_accounts(id),   -- Fannie Mae T&I (6.2) or P&I of the remittance type (6.1)
  proceeds_received_at timestamptz NOT NULL,                             -- 27.2's bank match (`proceeds.received`)
  due_at               timestamptz NOT NULL,                             -- +1 business_days_servicer (FNMA_F1_03_*_DEPOSIT_PROCEEDS_1BD)
  transferred_at       timestamptz,
  bank_reference       text,                                             -- the T&I/P&I bank feed credit (BAI2/camt.053, 6.4)
  timer_id             uuid REFERENCES timers(id),
  ledger_entry_id      uuid REFERENCES ledger_entry_sets(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (transferred_at IS NULL OR ledger_entry_id IS NOT NULL),
  CHECK ((kind LIKE 'ti_%' AND from_account_id = 'custodial_ti_prepurchase') OR (kind = 'pi_prepurchase_collections' AND from_account_id = 'custodial_pi_prepurchase')),
  UNIQUE (loan_id, kind)
);
COMMENT ON TABLE custodial_transfers IS '30.1 rule 8 (Servicing Guide F-1-03 05/13/2026): pre-purchase custodial balances book-transferred to the Fannie Mae custodial accounts within one business day of the purchase proceeds; satisfied by custodial.prepurchase_funds.transferred{kind, bank_matched=true}; a late transfer breaches FNMA_F1_03_TI/PI_DEPOSIT_PROCEEDS_1BD (sev-1 → officer; Form 496A exception).';
CREATE INDEX custodial_transfers_due_idx ON custodial_transfers(due_at) WHERE transferred_at IS NULL;

COMMIT;
