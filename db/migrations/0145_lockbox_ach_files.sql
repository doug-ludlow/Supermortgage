-- 0145 — 35.5 rules 7–8 "Lockbox ingest (`lockbox_ingest`)" and "ACH origination and returns as cycles" (spec/sections/35-operations-runtime/35-5-*.md,
-- Data model): the lockbox batch and its items, the NACHA return file, and the two columns a return needs on 2.3's `ach_entries`.
--
--   lockbox_batches    one row per remittance file the lockbox agent delivers: the stored file (documents, sha256 — unique: the same file twice is a
--                      no-op with a decision naming the first batch), the agent's receipt date, the cut-off zone, the control total and the counts.
--                      Status received → posted (every item a `payments` row or 6.5's suspense item, variance 0) | variance (Σ items ≠ the control
--                      total: nothing posted until `officer` resolves the item). Append-only in every fact column: UPDATE may move only the state
--                      machine's columns (status, items_identified, items_unidentified, items_rejected, variance_cents, posted_at) — the
--                      servicer_profiles / timers precedent of state columns beside frozen facts — and DELETE is refused.
--   lockbox_items      one row per detail line: the scanline, the amount, the check number, the payer (pii), the scan instant, `after_cutoff` and
--                      `received_on` (rule 7 / 2.1 rule 1: the agent's receipt date, or the next servicer business day when scanned after
--                      payment_channels.cutoff_time in cutoff_tz), the identification (match_method, matched_loan_id), the payment or suspense item
--                      the item became, the disposition and who resolved it. UPDATE may move only matched_loan_id, match_method, payment_id,
--                      suspense_item_id, disposition and resolved_by; the money column is frozen (an amount change is 6.5's command); DELETE never.
--                      The payment's idempotency_key is sha256(`lockbox|batch_id|item_no|amount_cents|received_on`) (2.1's key form).
--   ach_return_files   one row per NACHA return/NOC file (rule 8): unique sha256 — the same file twice is a no-op; forbid_mutation (the row is
--                      written once the file is processed, both timestamps on it).
--   ach_entries        + loan_id (FK loans) and enrollment_key (the JSONB autodraft_enrollments id) so a return finds its loan and its enrollment
--                      before 35.1's projector mints the typed autodraft_enrollments id (35.5 plan D5 / Ask 3; the enrollment_id FK stays NULL until then).
--
-- FK deferrals (35.5 plan D5): lockbox_items.payment_id is a plain uuid — no typed `payments` row exists before 35.1's projector keeps the uuid
-- legacy id as the typed id (35.1 adds the FK); lockbox_items.suspense_item_id is text (the JSONB suspense_items id until 35.1's projector).
-- Retention: life_of_loan_plus_4y for batches and items (the spec's default), respa_5y for the return file (Integrations: "retention_class respa_5y
-- for the ACH files per 0003:252"). Money is bigint cents. The only personal column is lockbox_items.payer_name — the name on a check, the
-- payments.payer_name text + COMMENT 'pii' precedent (0003:50); no taxpayer identifier is stored here.
BEGIN;

-- ───────────────────────────── lockbox_batches ─────────────────────────────
CREATE TABLE lockbox_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lockbox_id           text NOT NULL,                                                         -- the payment_channels-level lockbox (P.O. box + bank), e.g. LBX-1
  file_name            text NOT NULL,
  sha256               char(64) NOT NULL UNIQUE,                                              -- over the file bytes: the same file twice is a no-op
  document_id          uuid REFERENCES documents(id),                                         -- the stored file (35.2; worm_pending until its WORM store)
  receipt_date         date NOT NULL,                                                         -- the lockbox agent's date (the file header's date)
  cutoff_tz            text NOT NULL,                                                         -- payment_channels.cutoff_tz of the lockbox channel
  items                int NOT NULL,
  control_total_cents  bigint NOT NULL,
  items_identified     int NOT NULL DEFAULT 0,
  items_unidentified   int NOT NULL DEFAULT 0,
  items_rejected       int NOT NULL DEFAULT 0,
  status               text NOT NULL CHECK (status IN ('received', 'posted', 'variance')),
  variance_cents       bigint NOT NULL DEFAULT 0,                                             -- Σ items − control total; ≠ 0 refuses posting until officer resolves
  posted_at            timestamptz,
  retention_class      retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lockbox_batches_lockbox_idx ON lockbox_batches(lockbox_id, receipt_date);
CREATE INDEX lockbox_batches_status_idx ON lockbox_batches(status) WHERE status <> 'posted';
CREATE OR REPLACE FUNCTION lockbox_batches_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lockbox_batches is append-only: DELETE refused (35.5 Data model)'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.lockbox_id IS DISTINCT FROM OLD.lockbox_id OR NEW.file_name IS DISTINCT FROM OLD.file_name OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.receipt_date IS DISTINCT FROM OLD.receipt_date OR NEW.cutoff_tz IS DISTINCT FROM OLD.cutoff_tz
     OR NEW.items IS DISTINCT FROM OLD.items OR NEW.control_total_cents IS DISTINCT FROM OLD.control_total_cents OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'lockbox_batches is append-only: only status, items_identified, items_unidentified, items_rejected, variance_cents and posted_at may change (35.5 Data model)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lockbox_batches_guard BEFORE UPDATE OR DELETE ON lockbox_batches FOR EACH ROW EXECUTE FUNCTION lockbox_batches_guard();
COMMENT ON TABLE lockbox_batches IS '35.5 rule 7: one row per lockbox remittance file (sha256 unique); received → posted | variance; append-only in every fact column.';
COMMENT ON COLUMN lockbox_batches.variance_cents IS 'Σ lockbox_items.amount_cents − control_total_cents; ≠ 0 leaves the batch in variance with nothing posted (CONTROL_TOTAL_MATCH) until officer resolves the item.';

-- ───────────────────────────── lockbox_items ─────────────────────────────
CREATE TABLE lockbox_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid NOT NULL REFERENCES lockbox_batches(id),
  item_no              int NOT NULL,
  scanline             text NOT NULL DEFAULT '',
  loan_number_read     text,                                                                  -- the loan number the scanline / OCR read, matched or not
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  check_number         text,
  payer_name           text,
  scanned_at           timestamptz NOT NULL,
  after_cutoff         boolean NOT NULL DEFAULT false,                                        -- scanned after payment_channels.cutoff_time in cutoff_tz (2.1 rule 1)
  received_on          date NOT NULL,                                                         -- the receipt date, or the next servicer business day when after the cut-off
  image_document_id    uuid REFERENCES documents(id),
  matched_loan_id      uuid REFERENCES loans(id),
  match_method         text NOT NULL CHECK (match_method IN ('scanline', 'loan_number', 'coupon_ocr', 'manual', 'none')),
  payment_id           uuid,                                                                  -- FK to payments added by 35.1 with its projector (plan D5)
  suspense_item_id     text,                                                                  -- 6.5's suspense_items row (the JSONB id until 35.1's projector)
  disposition          text NOT NULL CHECK (disposition IN ('identified', 'unidentified', 'duplicate', 'rejected')),
  resolved_by          jsonb,                                                                 -- {actor, role, reason, at, decision_id} when a human resolved it (lockbox.item.resolve)
  retention_class      retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, item_no)
);
CREATE INDEX lockbox_items_loan_idx ON lockbox_items(matched_loan_id) WHERE matched_loan_id IS NOT NULL;
CREATE INDEX lockbox_items_open_idx ON lockbox_items(disposition) WHERE disposition = 'unidentified';
COMMENT ON COLUMN lockbox_items.payer_name IS 'pii';
CREATE OR REPLACE FUNCTION lockbox_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lockbox_items is append-only: DELETE refused (35.5 Data model)'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.item_no IS DISTINCT FROM OLD.item_no OR NEW.scanline IS DISTINCT FROM OLD.scanline
     OR NEW.loan_number_read IS DISTINCT FROM OLD.loan_number_read OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.check_number IS DISTINCT FROM OLD.check_number
     OR NEW.payer_name IS DISTINCT FROM OLD.payer_name OR NEW.scanned_at IS DISTINCT FROM OLD.scanned_at OR NEW.after_cutoff IS DISTINCT FROM OLD.after_cutoff
     OR NEW.received_on IS DISTINCT FROM OLD.received_on OR NEW.image_document_id IS DISTINCT FROM OLD.image_document_id OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'NO_MONEY_FIELD: lockbox_items is append-only in every fact column — only matched_loan_id, match_method, payment_id, suspense_item_id, disposition and resolved_by may change (an amount change is 6.5''s command; 35.5 rule 10)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lockbox_items_guard BEFORE UPDATE OR DELETE ON lockbox_items FOR EACH ROW EXECUTE FUNCTION lockbox_items_guard();
COMMENT ON TABLE lockbox_items IS '35.5 rule 7: one row per remittance detail line; received_on per 2.1 rule 1; identified → a payments row, unidentified → 6.5''s suspense item; only the identification and disposition columns may change.';
COMMENT ON COLUMN lockbox_items.payment_id IS 'The payments row the identified item became (a uuid; the FK to payments is added by 35.1''s projector).';

-- ───────────────────────────── ach_return_files ─────────────────────────────
CREATE TABLE ach_return_files (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date           date NOT NULL,
  file_name            text NOT NULL,
  sha256               char(64) NOT NULL UNIQUE,                                              -- the same file twice is a no-op
  document_id          uuid REFERENCES documents(id),
  returns              int NOT NULL DEFAULT 0,
  nocs                 int NOT NULL DEFAULT 0,
  entries_matched      int NOT NULL DEFAULT 0,
  entries_unmatched    int NOT NULL DEFAULT 0,
  received_at          timestamptz NOT NULL,
  processed_at         timestamptz,
  retention_class      retention_class NOT NULL DEFAULT 'respa_5y',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ach_return_files_day_idx ON ach_return_files(as_of_date);
CREATE TRIGGER ach_return_files_immutable BEFORE UPDATE OR DELETE ON ach_return_files FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE ach_return_files IS '35.5 rule 8: one row per NACHA return/NOC file (sha256 unique — the same file twice writes nothing); append-only.';

-- ───────────────────────────── ach_entries: the loan and the JSONB enrollment key (plan D5) ─────────────────────────────
ALTER TABLE ach_entries ADD COLUMN loan_id uuid REFERENCES loans(id), ADD COLUMN enrollment_key text;
CREATE INDEX ach_entries_loan_idx ON ach_entries(loan_id) WHERE loan_id IS NOT NULL;
COMMENT ON COLUMN ach_entries.enrollment_key IS 'The JSONB autodraft_enrollments id the entry was built for; 35.1''s projector backfills enrollment_id (the FK to the typed row) from it.';

COMMIT;
