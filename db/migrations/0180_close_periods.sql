-- 0180_close_periods.sql — 35.4 Month-end and year-end close (spec/sections/35-operations-runtime/35-4-month-end-and-year-end-close.md, "Data model").
--   close_periods         mutable on the timers precedent (status, timestamps and the reopen counter move; every change is journaled in
--                         close_period_events); one row per (kind, period, servicer_number). Retention corporate_7y.
--   close_period_steps    mutable — status, attempts, receipts and timestamps move; journaled. One row per (close_period_id, code). corporate_7y.
--   close_period_events   APPEND-ONLY: the journal — every transition, every receipt (unique by the receipt's loan_events row, rule 11). corporate_7y.
--   close_attestations    APPEND-ONLY: the balance attestation to the cent and the tax-year attestation; a re-attestation after a reopen is a new
--                         row with supersedes_attestation_id (rule 9). Retention life_of_loan_plus_4y (cites custodial accounts and reconciliations).
--   close_reopens         APPEND-ONLY: the officer's reopen with what was reset and what was kept. corporate_7y.
--   tax_year_closes       APPEND-ONLY: the year as a whole — the reportable set, the 1099-INT set, the 1099-A/C set and the ledger interest sum. tax_4y.
-- Six base tables (src/infra/db/db.test.ts: 789 through 0171 → 795). No PII column: ids, codes, cents and dates only. Append-only in both senses:
-- nothing already applied is edited. The receipt filters, dependencies and owner clocks are data (rule 1: "the chain is data, not code").
BEGIN;

CREATE TABLE close_periods (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                   text NOT NULL CHECK (kind IN ('month', 'tax_year')),
  period                 char(7) NOT NULL,                              -- YYYY-MM; for kind tax_year YYYY-TY
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  servicer_number        char(9) NOT NULL,
  tax_year               int,                                           -- kind tax_year only
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'attested', 'reopened', 'closed')),
  opened_at              timestamptz NOT NULL,
  opened_by_event_id     uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- the `ledger.month.ended` row (null for a kind tax_year period opened by close.tax_year); deferred: the row is written in the command whose events persist at commit (0150 precedent)
  attested_at            timestamptz,
  current_attestation_id uuid,                                          -- → close_attestations (FK added below, after the table)
  closed_at              timestamptz,
  reopen_count           int NOT NULL DEFAULT 0,
  current_reopen_id      uuid,                                          -- → close_reopens (FK added below)
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  retention_class        retention_class NOT NULL DEFAULT 'corporate_7y',
  UNIQUE (kind, period, servicer_number)
);
COMMENT ON TABLE close_periods IS '35.4 data model: one close period per (kind, period, servicer_number) — open → attested → closed, reopened by an officer; every change journaled in close_period_events.';

CREATE TABLE close_period_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_period_id    uuid NOT NULL REFERENCES close_periods(id),
  code               text NOT NULL CHECK (code IN ('eod_cutoff', 'custodial_day_close', 'metro2_snapshot', 'lar', 'period_close', 'ledger_period_close', 'balance_attestation', 'form496', 'form496a', 'qc_cycle', 'star', 'eligibility', 'tax_year_close', 'form_1098_furnish', 'form_1099_int_furnish', 'form_1099_ac_furnish', 'form_1098_file', 'form_1099_int_file', 'form_1099_ac_file')),
  owner_process      text NOT NULL,                                     -- 2.1, 6.3, 8.1, 5.1, 6.4, 18.1, 18.3, 18.7, 7.1, 3.9, 15.x, 35.4, 35.5
  depends_on         text[] NOT NULL DEFAULT '{}',                      -- step codes in the same period
  cycle_code         text,                                              -- 35.3 cycle_registry.cycle_code the step plans; null for a receipt-only step
  unit_scope         text NOT NULL CHECK (unit_scope IN ('global', 'per_custodial_account', 'per_loan')),
  not_before         timestamptz,
  owner_timer_code   text,                                              -- the owning section's clock, read-only (mirrored on the board)
  owner_due_at       timestamptz,                                       -- mirrored from timers when armed
  receipt_event_type text,
  receipt_filter     jsonb NOT NULL DEFAULT '{}',
  expected_receipts  int NOT NULL DEFAULT 1,
  received           int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'blocked' CHECK (status IN ('blocked', 'planned', 'running', 'completed', 'skipped', 'stalled', 'failed', 'pre_reopen')),
  cycle_run_id       uuid,                                              -- 35.3 cycle_runs.id (no FK: the table is 35.3's)
  started_at         timestamptz,
  completed_at       timestamptz,
  skipped_reason     text,
  attempts           int NOT NULL DEFAULT 0,
  last_error         text,
  receipts_from      timestamptz,                                       -- null until a reopen resets the step; then only receipts observed after this instant count (rule 9)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  retention_class    retention_class NOT NULL DEFAULT 'corporate_7y',
  UNIQUE (close_period_id, code)
);
CREATE INDEX close_period_steps_status_idx ON close_period_steps (close_period_id, status);
COMMENT ON TABLE close_period_steps IS '35.4 rule 1: the chain as data — one row per step with its dependencies, its 35.3 cycle, its receipt filter and the owner''s clock; blocked → planned → running → completed (stalled is a label; a final step is relabelled pre_reopen on a reopen).';

CREATE TABLE close_period_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_period_id  uuid NOT NULL REFERENCES close_periods(id),
  step_id          uuid REFERENCES close_period_steps(id),
  type             text NOT NULL CHECK (type IN ('close.period.opened', 'close.step.planned', 'close.step.started', 'close.receipt.recorded', 'close.step.completed', 'close.step.stalled', 'close.step.skipped', 'close.step.failed', 'close.step.reset', 'close.period.attested', 'close.attestation.variance', 'close.period.reopened', 'close.period.closed', 'close.tax_year.planned', 'close.tax_year.closed')),
  source_event_id  uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- the loan_events row that is the receipt, when one is
  actor            jsonb NOT NULL DEFAULT '{}',
  payload          jsonb NOT NULL DEFAULT '{}',
  occurred_at      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  retention_class  retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE UNIQUE INDEX close_period_events_source_once ON close_period_events (source_event_id) WHERE source_event_id IS NOT NULL;   -- rule 11: a receipt is recorded once
CREATE INDEX close_period_events_period_idx ON close_period_events (close_period_id, occurred_at);
CREATE TRIGGER close_period_events_immutable BEFORE UPDATE OR DELETE ON close_period_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE close_period_events IS '35.4: the append-only journal of every period and step transition and every receipt (source_event_id = the owning section''s own event, unique).';

CREATE TABLE close_attestations (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_period_id                uuid NOT NULL REFERENCES close_periods(id),
  kind                           text NOT NULL CHECK (kind IN ('balance', 'tax_year')),
  outcome                        text NOT NULL CHECK (outcome IN ('attested', 'variance', 'refused')),
  as_of                          date NOT NULL,                          -- period_end
  custodial_account_id           uuid REFERENCES custodial_accounts(id),  -- balance kind
  remittance_type                text CHECK (remittance_type IN ('aa', 'sa', 'ss_mbs', 'ss_mrs')),
  bank_closing_ledger_cents      bigint,
  deposits_in_transit_cents      bigint,
  disbursements_in_transit_cents bigint,
  depository_adjustments_cents   bigint,
  adjusted_depository_cents      bigint,
  composition_snapshot           jsonb NOT NULL DEFAULT '{}',            -- {L1..L11: "<cents>"} decimal strings of cents, the wire form
  composition_l12_cents          bigint,
  cashbook_cents                 bigint,                                 -- Σ ledger_lines custodial_pi_cash:<account> through as_of
  variance_cents                 bigint NOT NULL,                        -- adjusted_depository − cashbook (balance); box1_sum − ledger_interest_sum (tax_year)
  reportable_loans               int,
  furnished_count                int,
  filed_count                    int,
  box1_sum_cents                 bigint,
  ledger_interest_sum_cents      bigint,
  confidence                     numeric(4,3),
  evidence_document_ids          uuid[] NOT NULL DEFAULT '{}',
  preparer_decision_id           uuid REFERENCES agent_decisions(id),
  reviewer_decision_id           uuid REFERENCES agent_decisions(id),
  officer_approval_id            uuid REFERENCES agent_decisions(id),
  human_approval_flag            boolean NOT NULL,                       -- the configuration value read at attestation (rule 7)
  attested_by                    jsonb NOT NULL DEFAULT '{}',            -- the actor
  supersedes_attestation_id      uuid REFERENCES close_attestations(id), -- set on the re-attestation after a reopen
  created_at                     timestamptz NOT NULL DEFAULT now(),
  retention_class                retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
CREATE INDEX close_attestations_period_idx ON close_attestations (close_period_id, created_at);
CREATE TRIGGER close_attestations_immutable BEFORE UPDATE OR DELETE ON close_attestations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE close_attestations IS '35.4 rule 3: the balance attestation to the cent (adjusted depository = cashbook = composition L12) and the tax-year attestation (counts and sums tie); never edited — a re-attestation supersedes.';

CREATE TABLE close_reopens (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_period_id           uuid NOT NULL REFERENCES close_periods(id),
  reason                    text NOT NULL,
  trigger_event_id          uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- the restated statement, the reversal or the correction
  requested_by              jsonb NOT NULL DEFAULT '{}',                -- agent or human
  approved_by_decision_id   uuid REFERENCES agent_decisions(id),        -- the officer's approval (the reopen decision row)
  prior_status              text NOT NULL CHECK (prior_status IN ('attested', 'closed')),
  steps_reset               text[] NOT NULL DEFAULT '{}',
  steps_kept                text[] NOT NULL DEFAULT '{}',               -- the final ones: lar, period_close, metro2_snapshot
  compliance_escalation_id  uuid,                                       -- when prior_status = closed
  reopened_at               timestamptz NOT NULL,
  re_attestation_id         uuid REFERENCES close_attestations(id),     -- set on the row that supersedes; the reopen row itself is never edited, so this is the re-attestation's own back-reference written at reopen time (null)
  closed_again_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  retention_class           retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX close_reopens_period_idx ON close_reopens (close_period_id, reopened_at);
CREATE TRIGGER close_reopens_immutable BEFORE UPDATE OR DELETE ON close_reopens FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE close_reopens IS '35.4 rule 9: the officer''s reopen — the reason, the triggering event, what was reset and what was kept; the original attestation is never edited.';

CREATE TABLE tax_year_closes (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year                    int NOT NULL UNIQUE,
  december_close_period_id    uuid REFERENCES close_periods(id),
  tax_year_close_period_id    uuid REFERENCES close_periods(id),        -- the kind tax_year row this close opened
  reportable_loans            int NOT NULL,                             -- 7.1: every loan with interest received in the year
  ioe_1099_loans              int NOT NULL,                             -- 3.9: ≥ $10.00
  form_1099_ac_loans          int NOT NULL,                             -- acquisitions, abandonments and discharges in the year (filed on Fannie Mae's behalf, C-4.2-01 / F-1-23)
  ledger_interest_sum_cents   bigint NOT NULL,
  filing_list_document_id     uuid REFERENCES documents(id),            -- the 1099-A/C filing list
  receipt_event_id            uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- `close.tax_year.closed`
  closed_at                   timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  retention_class             retention_class NOT NULL DEFAULT 'tax_4y'
);
CREATE TRIGGER tax_year_closes_immutable BEFORE UPDATE OR DELETE ON tax_year_closes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE tax_year_closes IS '35.4 rule 10: the tax year as a whole — the reportable, 1099-INT and 1099-A/C sets and the ledger interest sum the attestation ties to.';

ALTER TABLE close_periods ADD CONSTRAINT close_periods_current_attestation_fk FOREIGN KEY (current_attestation_id) REFERENCES close_attestations(id);
ALTER TABLE close_periods ADD CONSTRAINT close_periods_current_reopen_fk FOREIGN KEY (current_reopen_id) REFERENCES close_reopens(id);

COMMIT;
