-- 16.4 MERS deactivation — post-deactivation snapshot reason.
-- Spec 16.4 data model: `mers_min_snapshots` (1.5): post-deactivation snapshot (`status = inactive`, reason Paid in
-- Full); rule 4 (Verification): the snapshot "must show status = inactive with the paid-in-full reason"
-- (verificationSnapshot in src/domain/payoff/ops-16-4.ts checks it). The 1.5 table (0019) carries no reason
-- column; append-only migrations, so the column is added here. No new tables.
BEGIN;

ALTER TABLE mers_min_snapshots ADD COLUMN IF NOT EXISTS reason text;
COMMENT ON COLUMN mers_min_snapshots.reason IS '16.4 rule 4 / data model: deactivation reason carried by the post-deactivation snapshot (Paid in Full; charge-off reason per the MERS Procedures); null on active MINs and pre-deactivation snapshots.';

ALTER TABLE mers_min_snapshots ADD COLUMN IF NOT EXISTS verified_transaction_id uuid REFERENCES mers_transactions(id);
COMMENT ON COLUMN mers_min_snapshots.verified_transaction_id IS '16.4 rule 4: the deactivation / deactivation_reversal transaction this snapshot verified (mers_transactions.verified_snapshot_id points back the other way).';

COMMIT;
