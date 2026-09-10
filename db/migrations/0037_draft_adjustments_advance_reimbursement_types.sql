-- 0037: §15.4 data model — "Reuse … `draft_adjustments` (5.4: add `type` values `delinquency_advance_reimbursement`,
-- `sa_interest_reimbursement`)". 0006 already carries `delinquency_advance_reimbursement`; this adds
-- `sa_interest_reimbursement` (the S/A fourth-month interest reimbursement after the liquidation LAR, IRM pp. 26–27),
-- `sda_recovery_credit` (the 5.4 Stop Delinquency Advance recovery credit as it appears on the Cash Adjustments report
-- before its principal/interest split is known — rule 3 "Fannie Mae's recovery credits first") and `debit_adjustment`
-- (rule 8: a reimbursement Fannie Mae claws back after an elimination/rescission "appears as a debit adjustment matched
-- to a reversing `advance_recoveries` row"), plus the report-line reference the 15.4 matching guardrail requires
-- ("never book a recovery without a report-line reference": report id + row + row hash, CRS code, description).
-- Append-only: a new constraint replaces the 0006 CHECK; no applied file is edited. No new tables.
BEGIN;

ALTER TABLE draft_adjustments DROP CONSTRAINT IF EXISTS draft_adjustments_type_check;
ALTER TABLE draft_adjustments ADD CONSTRAINT draft_adjustments_type_check CHECK (type IN (
  'sda_principal_credit', 'sda_interest_credit', 'sda_principal_recovery', 'sda_interest_recovery', 'reclass_reimbursement',
  'delinquency_advance_reimbursement', 'sa_interest_reimbursement', 'sda_recovery_credit', 'debit_adjustment', 'other'));

ALTER TABLE draft_adjustments
  ADD COLUMN IF NOT EXISTS report_line_ref text,                                    -- <report id>#<row>:<fnv1a row hash> (ops-15-4 parseCashAdjustmentLines)
  ADD COLUMN IF NOT EXISTS report_row      int,
  ADD COLUMN IF NOT EXISTS crs_code        text,                                    -- e.g. 208 "S/S Cash DelMod/PD P&I Advance Reimbursement" (usage UNVERIFIED; parsed if it appears)
  ADD COLUMN IF NOT EXISTS description     text;
CREATE INDEX IF NOT EXISTS draft_adjustments_report_line_idx ON draft_adjustments (report_line_ref) WHERE report_line_ref IS NOT NULL;

COMMENT ON TABLE draft_adjustments IS '§5.4 / §15.4: Remittance Detail – Cash Adjustments, draft-notification and purchase-advice lines parsed per activity period and matched FIFO to `advances` (15.4 rule 4, $0.05 per line); `type` carries the 15.4 values delinquency_advance_reimbursement, sa_interest_reimbursement, sda_recovery_credit and debit_adjustment (rule 8 clawback); `report_line_ref` is the evidence every `advance_recoveries` row must cite.';
COMMENT ON COLUMN draft_adjustments.report_line_ref IS '§15.4 audit and evidence: report id + row + row hash; a recovery is never booked without it.';

COMMIT;
