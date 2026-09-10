-- 0024: chart of accounts (1.6 / 17.3 "ledger_accounts additions").
-- Every ledger line names an account from this chart; the transfer-in/out
-- clearing accounts are per batch and the due-to/due-from accounts per
-- custodial account, so the batch clearing can be proven to net to zero.
CREATE TABLE ledger_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text NOT NULL CHECK (scope IN ('loan', 'custodial', 'corporate')),
  account          text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('asset', 'liability', 'receivable', 'memo', 'clearing', 'cash', 'income', 'expense')),
  section          text NOT NULL,                       -- owning spec process, e.g. '1.6'
  batch_id         uuid,                                -- per-batch clearing accounts (transfer_in_clearing, transfer_out_clearing)
  custodial_account_id text,                            -- per custodial account (due_to/due_from_*)
  counterparty     text,                                -- transferor / transferee partner id where applicable
  description      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, account, batch_id, custodial_account_id)
);
CREATE INDEX ledger_accounts_batch_idx ON ledger_accounts (batch_id) WHERE batch_id IS NOT NULL;

-- Baseline rows: the kernel's fixed accounts (src/kernel/ledger/ledger.ts).
INSERT INTO ledger_accounts (scope, account, kind, section, description) VALUES
  ('loan', 'principal', 'asset', '2.1', 'interest-bearing UPB'),
  ('loan', 'deferred_principal', 'asset', '2.4', 'non-interest-bearing deferred principal'),
  ('loan', 'forborne_principal', 'asset', '2.4', 'forborne principal'),
  ('loan', 'interest_due', 'receivable', '2.1', 'scheduled interest due'),
  ('loan', 'escrow', 'liability', '3.1', 'escrow balance (liability to the borrower)'),
  ('loan', 'escrow_advance', 'receivable', '3.2', 'escrow advances receivable'),
  ('loan', 'corporate_advance', 'receivable', '15.2', 'corporate advances receivable'),
  ('loan', 'late_charges', 'memo', '2.7', 'late charges receivable (memo)'),
  ('loan', 'suspense_unapplied', 'liability', '2.2', 'unapplied funds'),
  ('custodial', 'transfer_in_clearing', 'clearing', '1.6', 'per-batch transfer-in clearing; nets to zero when the position reconciliation closes'),
  ('custodial', 'transfer_out_clearing', 'clearing', '17.3', 'per-batch transfer-out clearing'),
  ('custodial', 'due_to_transferor', 'liability', '1.6', 'amounts owed to the transferor from the final accounting'),
  ('custodial', 'due_from_transferor', 'receivable', '1.6', 'amounts the transferor owes (advances substantiated in the final accounting)'),
  ('custodial', 'due_to_transferee', 'liability', '17.3', 'amounts owed to the transferee'),
  ('custodial', 'due_from_transferee', 'receivable', '17.3', 'advances receivable from the transferee'),
  ('custodial', 'custodial_pi_cash', 'cash', '6.1', 'P&I custodial cash'),
  ('custodial', 'custodial_ti_cash', 'cash', '6.1', 'T&I custodial cash'),
  ('custodial', 'fnma_remittance_payable', 'liability', '5.2', 'unremitted P&I collections payable to Fannie Mae'),
  ('corporate', 'variance_absorbed', 'expense', '1.6', 'reconciliation variances absorbed with officer approval');
