-- 0042: §17.1 transfer-out state on transfer_batches (append-only: 0002 created the table with the boarding enum and
-- 0019 added the 1.2/17.1 columns, so everything here is an ALTER — no new table).
--   transfer_batch_status — the §17.1 state machine values 0002's boarding enum lacks: `proposed → plan_approved →
--     package_ready → submitted → info_requested ⇄ submitted → approved → loan_list_frozen → notice_window → pre_cutover →
--     cutover → post_transfer → retention → closed`, exceptions `denied`, `withdrawn`, `on_hold` (spec: State machine);
--   case_type — `transfer_batches.status` (`case_type='transfer_out'`): a transfer-out row is direction 'out';
--   the batch facts ops-17-1.ts TransferOutBatch carries and the tools persist: partner_id, anchor_basis
--     (`fnma_directed` for cause: "the platform switches all 17.x timers to `fnma_instruction` anchors recorded on the
--     batch"), form629_rule / form629_deadline / form629_anchor_date (earlier of sale/transfer date), approval_on,
--     held_from (`on_hold` resumes where it left), first/last_batch_for_partner (last = measured from the partner's
--     batches at each transition), supermortgage_is_tech_provider (A2-1-01), fnma_instruction, goodbye_run_status and
--     respa_exclusion (§1024.33(b)(2)(i)(C) officer sign-off, 17.1-T5), portal_task_ids (decision record),
--     form629_portal_task_sla_due (SM_PORTAL_TASK_FORM629_SLA_2), form582_reflected_filing_id (A2-1-07);
--   qx_status — 0019 left it unconstrained text: the enum the spec names, mirroring the Quick Exchange ladder
--     (Servicing Transfers User Guide: New → Pending Servicing Transfer Review → Pending Servicing Transfer Analysis →
--     Pending Internal Sign Off → Pending Final Approval → Approval Letters Sent / Denied / Cancelled);
--   transfer_batch_loans — the 17.1-T8 withdrawal after the CD25 attestation: withdrawal_flag, paid_off_on,
--     removal_report_by (5.3 removal reported by BD2), the final-tape marker.
BEGIN;

ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'plan_approved';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'package_ready';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'submitted';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'info_requested';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'loan_list_frozen';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'notice_window';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'pre_cutover';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'post_transfer';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'retention';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'denied';
ALTER TYPE transfer_batch_status ADD VALUE IF NOT EXISTS 'on_hold';

ALTER TABLE transfer_batches
  ADD COLUMN IF NOT EXISTS case_type text NOT NULL DEFAULT 'transfer_in' CHECK (case_type IN ('transfer_in', 'transfer_out')),
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS anchor_basis text NOT NULL DEFAULT 'transfer_date' CHECK (anchor_basis IN ('transfer_date', 'fnma_instruction')),
  ADD COLUMN IF NOT EXISTS form629_rule text CHECK (form629_rule IN ('30_day_subservicing', '60_day_servicing', 'fnma_instruction')),
  ADD COLUMN IF NOT EXISTS form629_deadline date,
  ADD COLUMN IF NOT EXISTS form629_anchor_date date,
  ADD COLUMN IF NOT EXISTS approval_on date,
  ADD COLUMN IF NOT EXISTS held_from transfer_batch_status,
  ADD COLUMN IF NOT EXISTS first_batch_for_partner boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_batch_for_partner boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supermortgage_is_tech_provider boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fnma_instruction jsonb,
  ADD COLUMN IF NOT EXISTS goodbye_run_status text CHECK (goodbye_run_status IN ('planned', 'complete', 'excluded')),
  ADD COLUMN IF NOT EXISTS respa_exclusion jsonb,
  ADD COLUMN IF NOT EXISTS portal_task_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS form629_portal_task_sla_due date,
  ADD COLUMN IF NOT EXISTS form582_reflected_filing_id uuid REFERENCES regulatory_filings(id);
ALTER TABLE transfer_batches ADD CONSTRAINT transfer_batches_qx_status_check
  CHECK (qx_status IS NULL OR qx_status IN ('New', 'Pending Servicing Transfer Review', 'Pending Servicing Transfer Analysis', 'Pending Internal Sign Off', 'Pending Final Approval', 'Approval Letters Sent', 'Denied', 'Cancelled'));
ALTER TABLE transfer_batches ADD CONSTRAINT transfer_batches_transfer_out_direction CHECK (case_type <> 'transfer_out' OR direction = 'out');
-- §1024.33(b)(2)(i)(C): the exclusion is the partner officer's recorded sign-off, never a bare status
ALTER TABLE transfer_batches ADD CONSTRAINT transfer_batches_respa_exclusion_recorded CHECK (goodbye_run_status IS DISTINCT FROM 'excluded' OR respa_exclusion IS NOT NULL);
COMMENT ON COLUMN transfer_batches.case_type IS '§17.1 state machine: `transfer_batches.status` (`case_type=''transfer_out''`) — the transfer-out ladder; transfer_in rows keep the §1.1/1.2 boarding ladder.';
COMMENT ON COLUMN transfer_batches.qx_status IS '§17.1 data model: enum mirroring the Quick Exchange statuses (Servicing Transfers User Guide): New → Pending Servicing Transfer Review → Pending Servicing Transfer Analysis → Pending Internal Sign Off → Pending Final Approval → Approval Letters Sent / Denied / Cancelled.';
COMMENT ON COLUMN transfer_batches.last_batch_for_partner IS '§17.1 timers `transfer.batch.cutover_completed{last batch for this partner}` / `transfer.batch.closed{last batch}`: measured from the partner''s other transfer_out batches at each transition (ops-17-1.ts lastBatchForPartner), never remembered from the proposal.';
COMMENT ON COLUMN transfer_batches.anchor_basis IS '§17.1 edge case: `fnma_directed` for cause with immediate effect — Fannie Mae''s instructions override the cadence; the platform switches all 17.x timers to `fnma_instruction` anchors recorded on the batch.';
COMMENT ON COLUMN transfer_batches.respa_exclusion IS '§17.1 rule: `master_change_sub_retained` with payee, address, account number and payment amount unchanged — no RESPA notice (§1024.33(b)(2)(i)(C)); the `officer` sign-off records the exclusion (17.1-T5).';
COMMENT ON COLUMN transfer_batches.form582_reflected_filing_id IS 'A2-1-07 / FNMA_A2_1_07_FORM582_TERMINATION_REFLECTED: the partner''s Form 582 filing (regulatory_filings, 18.4) that no longer lists Supermortgage as subservicer after the last batch cut over.';

ALTER TABLE transfer_batch_loans
  ADD COLUMN IF NOT EXISTS withdrawal_flag text CHECK (withdrawal_flag IN ('withdrawn', 'withdrawn_after_attestation')),
  ADD COLUMN IF NOT EXISTS paid_off_on date,
  ADD COLUMN IF NOT EXISTS removal_report_by date;
COMMENT ON COLUMN transfer_batch_loans.withdrawal_flag IS '17.1-T8: a payoff/repurchase/foreclosure after the CD25 attestation is `withdrawn_after_attestation` — the loan still moves in Fannie Mae''s system on BD3 unless Fannie Mae removes it; Supermortgage reports the removal (5.3) by BD2 and the transferee tape marks it.';

COMMIT;
