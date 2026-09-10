-- 0044_transfer_out_corrections_recon_acks.sql — §17.3 Data/document transfer (append-only: 0019 created the 17.3 tables;
-- everything here is an ALTER or a new table).
--   transfer_out_deliverables.correction_seq — the corrected re-issue of an acknowledged deliverable (Bulletin 2020-02
--     preliminary QC; 17.3-T13 "cannot be satisfied until a corrected preliminary is acknowledged"): the transferee's load
--     report showed differences, so the same kind is regenerated, validated, attested, delivered and acknowledged again;
--     each correction increments the sequence (ops-17-3.ts regenerationAllowed). 0 = the original issue.
--   transfer_out_custodial_recon_acks — FNMA_F1_11_CUSTODIAL_RECON_5BD is satisfied by `deliverable.acked{D08}` "for every
--     Supermortgage custodial account holding funds for the transferred population" (A2-1-07: the accounts are not transferred,
--     their balances are), and SM_XFER_OUT_CUSTODIAL_CLOSE_60 anchors on the reconciliation ack date: one row per account per
--     batch records which account the transferee's D08 acknowledgment covered and when (ingestTransfereeAck; the T+30
--     adjustment window in runOutboundDqGate{op=custodial_window} reads them).
BEGIN;

ALTER TABLE transfer_out_deliverables ADD COLUMN IF NOT EXISTS correction_seq int NOT NULL DEFAULT 0 CHECK (correction_seq >= 0);
COMMENT ON COLUMN transfer_out_deliverables.correction_seq IS '17.3 preliminary QC (Bulletin 2020-02) / 17.3-T13: the corrected re-issue number of an acknowledged deliverable — a load report with mapping differences is answered by regenerating the same kind (correction_seq + 1) through the ladder; `transfer.prelim_qc.completed` is emitted only when the corrected preliminary is acknowledged with a clean load report.';

CREATE TABLE transfer_out_custodial_recon_acks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id              uuid NOT NULL REFERENCES transfer_batches(id),
  custodial_account_id  uuid NOT NULL REFERENCES custodial_accounts(id),
  deliverable_id        uuid REFERENCES transfer_out_deliverables(id),
  acked_on              date NOT NULL,
  ack_reference         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, custodial_account_id, acked_on)
);
CREATE TRIGGER transfer_out_custodial_recon_acks_immutable BEFORE UPDATE OR DELETE ON transfer_out_custodial_recon_acks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE transfer_out_custodial_recon_acks IS '17.3 timer table FNMA_F1_11_CUSTODIAL_RECON_5BD: the transferee''s D08 acknowledgment per Supermortgage custodial account holding funds for the transferred population (A2-1-07; F-1-11 "custodial bank reconciliation for each account as of the cutoff date"); the latest acked_on anchors SM_XFER_OUT_CUSTODIAL_CLOSE_60 (+60 calendar days once the T+30 adjustment window closed with no open variance).';

COMMIT;
