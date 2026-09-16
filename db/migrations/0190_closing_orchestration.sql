-- 0190_closing_orchestration.sql — §35.6 "Closing, funding and delivery orchestration"
-- (spec/sections/35-operations-runtime/35-6-closing-funding-and-delivery-orchestration.md, Data model). Five tables:
--   closing_orchestrations       one row per application (unique); MUTABLE on the timers precedent — `step`, `status`,
--                                `waiting_on`, the timestamps and the counters change; every change is journaled in
--                                closing_orchestration_steps; never deleted (no_delete trigger).
--   closing_orchestration_steps  APPEND-ONLY: the journal — every entered / command_run / command_refused / command_failed /
--                                waiting / completed / skipped / held / released / unwound / cancelled entry with the owning event
--                                that moved the step, the command, the actor, the decision row and the sweep run.
--   funding_snapshots            APPEND-ONLY: one row per attempt to build 30.2's OriginationSnapshot from the record — the
--                                snapshot (cents as strings), its sources per field, the gaps, whether a nonprod fixture filled one.
--   purchase_reconciliations     APPEND-ONLY: one row per purchase — 29.4's advice, 30.1's match and 27.2's bank credit on the
--                                same loan id, the payoff and the waterfall figures, the three sides and the status.
--   orchestration_daily_receipts APPEND-ONLY: one row per platform day — the Closing board's counts (SM_ORCH_OPEN_BOOK_DAILY's
--                                receipt row).
-- Retention life_of_loan_plus_4y (the receipts corporate_7y). No PII column anywhere: every borrower fact is referenced by row id;
-- `detail`/`sources`/`snapshot` carry ids, dates and cents-strings (the snapshot's borrower block is the 30.2 hand-off's — its
-- TIN/DOB leaves are stored as last4/absent by the builder, never in full). Five base tables (src/infra/db/db.test.ts +5).
BEGIN;

CREATE TABLE closing_orchestrations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL UNIQUE REFERENCES applications(id),
  loan_id                     uuid REFERENCES loans(id),                   -- set at loan.staged
  transaction_type            text CHECK (transaction_type IN ('purchase', 'refinance', 'limited_cash_out', 'cash_out')),
  funding_type                text CHECK (funding_type IN ('wet', 'dry')),  -- 26.3 computeDates
  note_form                   text CHECK (note_form IN ('paper', 'enote')),
  closing_type                text CHECK (closing_type IN ('ron', 'ipen', 'hybrid', 'wet')),   -- 26.2's decision
  rescindable                 boolean,
  step                        text NOT NULL,
  status                      text NOT NULL CHECK (status IN ('open', 'waiting_human', 'waiting_vendor', 'waiting_borrower', 'waiting_window', 'held', 'completed', 'unwound', 'cancelled', 'unwinding')),
  waiting_on                  text,                                          -- a kernel role, a vendor port key, `borrower`, or a timer code
  hold_reason                 text,
  scheduled_consummation_at   timestamptz,
  consummation_at             timestamptz,
  rescission_expires_at       timestamptz,
  earliest_funding_date       date,
  funded_at                   timestamptz,
  staged_at                   timestamptz,
  boarded_at                  timestamptz,
  package_frozen_at           timestamptz,
  delivered_at                timestamptz,
  certified_at                timestamptz,
  purchased_at                timestamptz,
  reconciled_at               timestamptz,
  completed_at                timestamptz,
  funding_id                  text,
  warehouse_advance_id        text,
  delivery_id                 text,
  purchase_advice_id          text,
  funding_snapshot_id         uuid,                                          -- FK added below (funding_snapshots)
  purchase_reconciliation_id  uuid,                                          -- FK added below (purchase_reconciliations)
  last_event_sequence         bigint NOT NULL DEFAULT 0,                     -- the last loan_events.sequence the pass folded in
  step_attempts               int NOT NULL DEFAULT 0,
  lease_holder                text,
  lease_until                 timestamptz,                                   -- wall time, 5 minutes (rule 1)
  opened_at                   timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  retention_class             retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
CREATE INDEX closing_orchestrations_open_idx ON closing_orchestrations (status, updated_at) WHERE status NOT IN ('completed', 'unwound', 'cancelled');
CREATE INDEX closing_orchestrations_loan_idx ON closing_orchestrations (loan_id) WHERE loan_id IS NOT NULL;
CREATE OR REPLACE FUNCTION closing_orchestrations_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'closing_orchestrations is never deleted (35.6 data model: mutable on the timers precedent, journaled in closing_orchestration_steps)'; END $$;
CREATE TRIGGER closing_orchestrations_no_delete BEFORE DELETE ON closing_orchestrations FOR EACH ROW EXECUTE FUNCTION closing_orchestrations_no_delete();
COMMENT ON TABLE closing_orchestrations IS '35.6 data model: one orchestration per application, driven by the record, idempotent per sweep (rule 1).';

CREATE TABLE closing_orchestration_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orchestration_id   uuid NOT NULL REFERENCES closing_orchestrations(id),
  application_id     uuid NOT NULL,
  loan_id            uuid,
  step               text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('entered', 'command_run', 'command_refused', 'command_failed', 'waiting', 'completed', 'skipped', 'held', 'released', 'unwound', 'cancelled')),
  clocked            boolean NOT NULL DEFAULT false,                         -- whether SM_ORCH_STEP_STALLED_2BD armed for this entry
  waiting_on         text,
  trigger_event_id   uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- the owning-section event that moved the step
  command_process    text,
  command_name       text,
  command_op         text,
  actor_kind         text,
  actor_id           text,
  actor_role         text,
  decision_id        uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  refusal_code       text,
  error_class        text,
  detail             jsonb NOT NULL DEFAULT '{}',                            -- ids, dates and cents-strings only; never a name, TIN or account
  sweep_run_id       uuid REFERENCES sweep_runs(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  retention_class    retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
CREATE INDEX closing_orchestration_steps_orch_idx ON closing_orchestration_steps (orchestration_id, created_at);
CREATE INDEX closing_orchestration_steps_app_idx ON closing_orchestration_steps (application_id, step, kind);
-- rule 1: a step is entered exactly once per orchestration; re-entry after a hold is `released`, not a second `entered`
CREATE UNIQUE INDEX closing_orchestration_steps_entered_once ON closing_orchestration_steps (orchestration_id, step) WHERE kind = 'entered';
CREATE TRIGGER closing_orchestration_steps_immutable BEFORE UPDATE OR DELETE ON closing_orchestration_steps FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE closing_orchestration_steps IS '35.6 data model: the append-only journal of every orchestration step, command, wait, hold and outcome.';

CREATE TABLE funding_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL REFERENCES applications(id),
  orchestration_id   uuid REFERENCES closing_orchestrations(id),
  snapshot_hash      char(64) NOT NULL,                                      -- SHA-256 of the canonical JSON, bigints as decimal strings
  snapshot           jsonb NOT NULL,                                         -- 30.2's OriginationSnapshot, cents as strings
  sources            jsonb NOT NULL DEFAULT '{}',                            -- {path: {kind: event | entity | table, ref, process}}
  gaps               text[] NOT NULL DEFAULT '{}',                           -- the paths the record could not supply
  fixture_used       boolean NOT NULL DEFAULT false,                         -- true only when a nonprod build filled a gap from demoSnapshot
  environment        text NOT NULL,
  built_at           timestamptz NOT NULL,
  built_by           jsonb NOT NULL DEFAULT '{}',                            -- the actor
  fund_event_id      uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- loan.staged, once used
  refused_code       text CHECK (refused_code IS NULL OR refused_code IN ('FIXTURE_REFUSED', 'SNAPSHOT_GAP', 'BOARDING_HARD_FAILURE', 'RESCISSION_NOT_EXPIRED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  retention_class    retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
CREATE INDEX funding_snapshots_app_idx ON funding_snapshots (application_id, built_at DESC);
CREATE TRIGGER funding_snapshots_immutable BEFORE UPDATE OR DELETE ON funding_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE funding_snapshots IS '35.6 rule 6: the hand-off snapshot built from the record, field by field, with its sources and gaps.';

CREATE TABLE purchase_reconciliations (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                      uuid NOT NULL REFERENCES loans(id),
  application_id               uuid NOT NULL REFERENCES applications(id),
  orchestration_id             uuid REFERENCES closing_orchestrations(id),
  delivery_id                  text,
  purchase_advice_id           text,
  advice_date                  date,
  purchase_date                date,
  price_pct                    numeric(10,6),
  upb_cents                    bigint,
  principal_proceeds_cents     bigint,
  interest_adjustment_cents    bigint,
  llpa_total_cents             bigint,
  fees_cents                   bigint,
  advice_net_proceeds_cents    bigint,                                       -- 29.4's row
  expected_net_proceeds_cents  bigint,                                       -- 29.4 R3 / 27.2 forecastProceeds
  investor_net_proceeds_cents  bigint,                                       -- the figure 30.1 matched
  bank_received_cents          bigint,                                       -- 27.2 proceeds.received
  warehouse_payoff_cents       bigint,                                       -- 27.1: principal + accrued interest + fee
  warehouse_interest_cents     bigint,
  warehouse_fee_cents          bigint,
  sm_cost_recovery_cents       bigint,
  sm_retained_cents            bigint,
  partner_residual_cents       bigint,
  variance_cents               bigint,                                       -- advice − expected
  variance_breakdown           jsonb NOT NULL DEFAULT '{}',                  -- 27.2's {price, llpa, interest, fees}
  sides                        jsonb NOT NULL DEFAULT '{}',                  -- {"29.4": reconciled | variance, "30.1": matched | unmatched, "27.2": matched | exception}
  interest_convention          text CHECK (interest_convention IN ('a_30_360', 'b_act_365', 'unresolved')),
  status                       text NOT NULL CHECK (status IN ('reconciled', 'exception')),
  escalation_id                uuid,
  decision_id                  uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  retention_class              retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
CREATE INDEX purchase_reconciliations_loan_idx ON purchase_reconciliations (loan_id, created_at DESC);
CREATE TRIGGER purchase_reconciliations_immutable BEFORE UPDATE OR DELETE ON purchase_reconciliations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE purchase_reconciliations IS '35.6 rule 8: a purchase is reconciled on three sides of the same loan id, or it is an exception.';

CREATE TABLE orchestration_daily_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date           date NOT NULL UNIQUE,
  open                 int NOT NULL DEFAULT 0,
  waiting_human        int NOT NULL DEFAULT 0,
  waiting_vendor       int NOT NULL DEFAULT 0,
  waiting_borrower     int NOT NULL DEFAULT 0,
  waiting_window       int NOT NULL DEFAULT 0,
  held                 int NOT NULL DEFAULT 0,
  completed_today      int NOT NULL DEFAULT 0,
  unwound_today        int NOT NULL DEFAULT 0,
  fixture_used_today   int NOT NULL DEFAULT 0,
  oldest_open_step     text,
  oldest_open_days     int,
  by_waiting_on        jsonb NOT NULL DEFAULT '{}',
  report_document_id   uuid,                                                 -- 35.2's documents row (the Closing board)
  created_at           timestamptz NOT NULL DEFAULT now(),
  retention_class      retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE TRIGGER orchestration_daily_receipts_immutable BEFORE UPDATE OR DELETE ON orchestration_daily_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE orchestration_daily_receipts IS '35.6 rule 10: the daily Closing board receipt (SM_ORCH_OPEN_BOOK_DAILY).';

ALTER TABLE closing_orchestrations ADD CONSTRAINT closing_orchestrations_snapshot_fk FOREIGN KEY (funding_snapshot_id) REFERENCES funding_snapshots(id);
ALTER TABLE closing_orchestrations ADD CONSTRAINT closing_orchestrations_reconciliation_fk FOREIGN KEY (purchase_reconciliation_id) REFERENCES purchase_reconciliations(id);

COMMIT;
