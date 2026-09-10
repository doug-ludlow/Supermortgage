-- 0038_payoff_statement_lifecycle.sql — §16.1 payoff statement: the rows the engine writes, as it writes them.
-- Append-only: this file adds columns and replaces one trigger; it never edits an applied migration.
--   * payoff_statements (0009, fixed by 0018) still carried the 0009 BEFORE UPDATE OR DELETE `payoff_statements_immutable`
--     trigger, which forbids the 16.1 state machine (`rendered → sent → superseded | expired | relied_upon | closed`), the
--     append of `delivered_to` delivery evidence and the `superseded_by` back-link. It is replaced by a lifecycle trigger:
--     DELETE is still forbidden; UPDATE may only move `status` forward, append to `delivered_to`, and set `sent_on`, `notice_id`
--     and `superseded_by` once — every figure column (quote_id, good_through, total_cents, per_diem_cents, hash,
--     verification_token, wire_instruction_version_id, state_variant) stays immutable ("accurate when issued": a changed
--     figure is a new statement from a new payoff_quotes row).
--   * payoff_quotes gains the columns the calculator row carries (`fees_cents` — borrower-payable NSF/other fees as one line,
--     `interest_cents`, `nib_line_cents`, `fees_waived_cents` / `fees_waived_reason` (2.7 waiver), `components` (the calculator
--     input, so a recompute runs on the same inputs), `deadlines`, `valid_until`, `good_through_capped`, `state`,
--     `supersedes_quote_id`, `trigger_event` / `occurred_on` / `statement_id` for `quote_type = 'updated'`); `ledger_snapshot_id`
--     is the committed ledger_entries high-water mark (a text mark, not a uuid).
--   * payoff_requests gains the 16.1 intake facts (`received_on` clock start, `requester_classification`, `requester_verified`,
--     `authorization_request_sent_at`, `borrower_party_ids`, `governing_deadline` / `governing_due` / `warning_on`,
--     `third_party_due_on`, `requested_payoff_on`) and its requester_type check accepts the 7.6/16.1 vocabulary
--     (borrower, confirmed_successor, attorney, counselor, lender_or_title, unknown) alongside the 0009 values.
BEGIN;

-- ---- payoff_statements: lifecycle instead of blanket immutability --------------------------------------------------------
ALTER TABLE payoff_statements
  ADD COLUMN IF NOT EXISTS request_id uuid REFERENCES payoff_requests(id),
  ADD COLUMN IF NOT EXISTS requester_type text,
  ADD COLUMN IF NOT EXISTS state char(2),
  ADD COLUMN IF NOT EXISTS state_text text,
  ADD COLUMN IF NOT EXISTS verify_path text,
  ADD COLUMN IF NOT EXISTS rendered_on date,
  ADD COLUMN IF NOT EXISTS sent_on date,
  ADD COLUMN IF NOT EXISTS escrow_balance_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escrow_paragraph text,
  ADD COLUMN IF NOT EXISTS escrow_cutoff_on date,
  ADD COLUMN IF NOT EXISTS borrower_to_pay jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS alternative_text text,
  ADD COLUMN IF NOT EXISTS hsa_note text,
  ADD COLUMN IF NOT EXISTS buydown_credit_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accuracy_gate jsonb,
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES payoff_statements(id);

DROP TRIGGER IF EXISTS payoff_statements_immutable ON payoff_statements;
CREATE OR REPLACE FUNCTION payoff_statements_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old int; rank_new int;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'payoff_statements are retained for life of loan + 4 years; never deleted'; END IF;
  -- figures and identity are immutable: a changed figure is a new statement from a new payoff_quotes row (16.1 "accurate when issued")
  IF NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.good_through <> OLD.good_through OR NEW.total_cents <> OLD.total_cents OR NEW.per_diem_cents <> OLD.per_diem_cents
     OR NEW.hash <> OLD.hash OR NEW.verification_token IS DISTINCT FROM OLD.verification_token OR NEW.wire_instruction_version_id IS DISTINCT FROM OLD.wire_instruction_version_id
     OR NEW.state_variant IS DISTINCT FROM OLD.state_variant OR NEW.loan_id <> OLD.loan_id THEN
    RAISE EXCEPTION 'payoff_statements figures are immutable; issue an updated statement from a new payoff_quotes row';
  END IF;
  -- status moves forward only: rendered → sent → superseded | expired | relied_upon | closed
  rank_old := CASE OLD.status WHEN 'rendered' THEN 0 WHEN 'sent' THEN 1 WHEN 'superseded' THEN 2 WHEN 'expired' THEN 2 WHEN 'relied_upon' THEN 2 WHEN 'closed' THEN 3 ELSE 0 END;
  rank_new := CASE NEW.status WHEN 'rendered' THEN 0 WHEN 'sent' THEN 1 WHEN 'superseded' THEN 2 WHEN 'expired' THEN 2 WHEN 'relied_upon' THEN 2 WHEN 'closed' THEN 3 ELSE 0 END;
  IF rank_new < rank_old THEN RAISE EXCEPTION 'payoff_statements.status moves forward only (% → % refused)', OLD.status, NEW.status; END IF;
  -- delivery evidence is append-only; sent_on, notice_id and superseded_by are set once
  IF jsonb_array_length(NEW.delivered_to) < jsonb_array_length(OLD.delivered_to) OR (NEW.delivered_to -> 0 IS DISTINCT FROM OLD.delivered_to -> 0 AND jsonb_array_length(OLD.delivered_to) > 0) THEN
    RAISE EXCEPTION 'payoff_statements.delivered_to is append-only';
  END IF;
  IF OLD.sent_on IS NOT NULL AND NEW.sent_on IS DISTINCT FROM OLD.sent_on THEN RAISE EXCEPTION 'payoff_statements.sent_on is set once'; END IF;
  IF OLD.notice_id IS NOT NULL AND NEW.notice_id IS DISTINCT FROM OLD.notice_id THEN RAISE EXCEPTION 'payoff_statements.notice_id is set once'; END IF;
  IF OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN RAISE EXCEPTION 'payoff_statements.superseded_by is set once'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payoff_statements_lifecycle BEFORE UPDATE OR DELETE ON payoff_statements FOR EACH ROW EXECUTE FUNCTION payoff_statements_lifecycle();

-- ---- payoff_quotes: the calculator row as written -------------------------------------------------------------------------
ALTER TABLE payoff_quotes
  ADD COLUMN IF NOT EXISTS state char(2),
  ADD COLUMN IF NOT EXISTS fees_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS nib_line_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_waived_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_waived_reason text,
  ADD COLUMN IF NOT EXISTS components jsonb,
  ADD COLUMN IF NOT EXISTS rate_segments_in_force jsonb,
  ADD COLUMN IF NOT EXISTS deadlines jsonb,
  ADD COLUMN IF NOT EXISTS valid_until date,
  ADD COLUMN IF NOT EXISTS good_through_capped boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supersedes_quote_id uuid REFERENCES payoff_quotes(id),
  ADD COLUMN IF NOT EXISTS trigger_event text,
  ADD COLUMN IF NOT EXISTS occurred_on date,
  ADD COLUMN IF NOT EXISTS statement_id uuid REFERENCES payoff_statements(id);
ALTER TABLE payoff_quotes ALTER COLUMN ledger_snapshot_id TYPE text USING ledger_snapshot_id::text;
COMMENT ON COLUMN payoff_quotes.ledger_snapshot_id IS 'committed ledger_entries high-water mark the figure was computed on (16.1 data model)';
COMMENT ON COLUMN payoff_quotes.fees_cents IS 'NSF and other borrower-payable fees as one line (nsf_fees_cents + other_fees) — the calculator input';
COMMENT ON COLUMN payoff_quotes.components IS 'the calculator input (Components) so a recompute runs on the same inputs plus the stated post-event changes';
-- the supersession back-link remains the only mutable field (0018 payoff_quotes_supersede_only)

-- ---- payoff_requests: the 16.1 intake facts -----------------------------------------------------------------------------------
ALTER TABLE payoff_requests
  ADD COLUMN IF NOT EXISTS received_on date,
  ADD COLUMN IF NOT EXISTS clock_basis text,
  ADD COLUMN IF NOT EXISTS requester text CHECK (requester IN ('consumer','third_party')),
  ADD COLUMN IF NOT EXISTS requester_classification text CHECK (requester_classification IN ('consumer_request','authorized_agent','request_authorization_send_to_borrower')),
  ADD COLUMN IF NOT EXISTS authorization_evidence boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requester_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS authorization_request_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS good_through date,
  ADD COLUMN IF NOT EXISTS requested_payoff_on date,
  ADD COLUMN IF NOT EXISTS governing_deadline text CHECK (governing_deadline IN ('federal','state')),
  ADD COLUMN IF NOT EXISTS governing_due date,
  ADD COLUMN IF NOT EXISTS warning_on date,
  ADD COLUMN IF NOT EXISTS third_party_due_on date,
  ADD COLUMN IF NOT EXISTS reasonable_time_evidence_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS borrower_party_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE payoff_requests DROP CONSTRAINT IF EXISTS payoff_requests_requester_type_check;
ALTER TABLE payoff_requests ADD CONSTRAINT payoff_requests_requester_type_check CHECK (requester_type IN (
  'borrower','coborrower','successor_confirmed','attorney','counselor','refinancing_lender','title_escrow','other_agent',
  'confirmed_successor','lender_or_title','unknown'));

COMMIT;
