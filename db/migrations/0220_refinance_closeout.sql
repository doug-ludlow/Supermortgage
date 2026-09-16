-- 0220_refinance_closeout.sql — 35.10 The refinance close of the loop
-- (spec/sections/35-operations-runtime/35-10-the-refinance-close-of-the-loop.md, Data model).
--   refinance_closeouts               mutable on the timers precedent (`step`, `status`, `waiting_on`, the ids and timestamps change; every
--                                     change is journaled in refinance_closeout_steps) — one row per refinance application with a prior loan
--                                     on the platform (ONE_CLOSEOUT_PER_APPLICATION: application_id UNIQUE).
--   refinance_closeout_steps          APPEND-ONLY: the journal — every step entered/completed, every owning command run, refused or failed,
--                                     with its trigger event and the owner's decision id (`detail` carries ids, dates and cents-strings only).
--   prior_loan_retirements            APPEND-ONLY: the retirement with its evidence; a reversal appends a superseding row (`retired_on` null,
--                                     `retirement_event_id` = the reversal) — uniqueness is per (prior_loan_id, retirement_event_id).
--   partner_retirement_notifications  APPEND-ONLY: one row per act (notified / acknowledged / confirmed / disputed / resolved); the latest row
--                                     per retirement is its state.
--   refinance_closeout_daily_receipts APPEND-ONLY: the Refinance board's daily receipt (35.8 reads it), one per as_of_date.
--   Baseline columns: loans.refinanced_by_loan_id / retired_at / retired_reason (written only by PgLoanRepository.projectStatus, 35.1's
--   projector, from `refinance.prior_loan.retired` / `payoff.reversed`); payoff_demands gains the statuses `paid` and `cancelled`, the
--   treatment `partner_obligation`, `payoff_posted_on` and `wire_reference` (24.4's row, written by 24.4's own tools — parsePayoffStatement{op: paid},
--   requestPayoff{op: cancel}; 24.4 keeps the row as an entity kind, so these CHECK widenings state the typed table's contract for the day it is projected).
--   Retention life_of_loan_plus_4y; no PII column — every borrower and partner fact is referenced by row id. 16.x / 24.4 / 16.3 / 3.5 rows are
--   entity-store kinds whose ids are strings (as are `documents` rows the sections write — 16.3, 26.1, 22.1), so the closeout references them as text,
--   never as FKs into the typed tables 35.1 mints keys for.
-- Five base tables (src/infra/db/db.test.ts counts 789 through 0220).
BEGIN;

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS refinanced_by_loan_id uuid REFERENCES loans(id),
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_reason text CHECK (retired_reason IN ('payoff', 'refinance_same_servicer', 'refinance_partner', 'transfer_out', 'other'));
COMMENT ON COLUMN loans.refinanced_by_loan_id IS '35.10 rule 7: the new loan that paid this one off — written when 30.2''s loan.staged names it (refinance.new_loan.linked); cleared by payoff.reversed';
COMMENT ON COLUMN loans.retired_reason IS '35.10 rule 7: why the row is paid_off / transferred_out — set by the 35.1 projector from refinance.prior_loan.retired{mode} (refinance_same_servicer | refinance_partner) or loan.paid_in_full (payoff); NO_DIRECT_STATUS_WRITE';
CREATE INDEX IF NOT EXISTS loans_refinanced_by_idx ON loans(refinanced_by_loan_id) WHERE refinanced_by_loan_id IS NOT NULL;

ALTER TABLE payoff_demands DROP CONSTRAINT IF EXISTS payoff_demands_status_check;
ALTER TABLE payoff_demands ADD CONSTRAINT payoff_demands_status_check CHECK (status IN ('requested', 'received', 'stale', 'refreshed', 'funded', 'rejected', 'paid', 'cancelled'));
ALTER TABLE payoff_demands DROP CONSTRAINT IF EXISTS payoff_demands_escrow_treatment_check;
ALTER TABLE payoff_demands ADD CONSTRAINT payoff_demands_escrow_treatment_check CHECK (escrow_treatment IN ('refund_by_servicer', 'credit_to_new_loan', 'net_against_shortage', 'partner_obligation'));
ALTER TABLE payoff_demands ADD COLUMN IF NOT EXISTS payoff_posted_on date, ADD COLUMN IF NOT EXISTS wire_reference text;
COMMENT ON COLUMN payoff_demands.payoff_posted_on IS '35.10 rule 7 / 24.4: the day the settlement statement''s payoff line was paid to the servicer of record (monitored mode: the partner''s wire); status = paid';

CREATE TABLE refinance_closeouts (
  id                          uuid PRIMARY KEY,
  application_id              uuid NOT NULL UNIQUE REFERENCES applications(id),
  prior_loan_id               uuid NOT NULL REFERENCES loans(id),
  new_loan_id                 uuid REFERENCES loans(id),
  orchestration_id            uuid,                                                -- 35.6's closing_orchestrations row when it exists (no FK: 35.6 lands beside this)
  partner_party_id            uuid REFERENCES parties(id),
  mode                        text NOT NULL CHECK (mode IN ('serviced_same_servicer', 'monitored_partner')),
  prior_status_at_open        text NOT NULL CHECK (prior_status_at_open IN ('active', 'monitored')),
  step                        text NOT NULL,
  status                      text NOT NULL CHECK (status IN ('open', 'waiting_human', 'waiting_vendor', 'waiting_partner', 'waiting_window', 'held', 'completed', 'unwound', 'cancelled')),
  waiting_on                  text,
  hold_reason                 text,
  payoff_demand_id            text,                                                -- 24.4 payoff_demands entity id (<application_id>:<liability_id>)
  payoff_request_id           text,                                                -- 16.1 payoff_requests entity id (serviced)
  quote_id                    text,                                                -- 16.1 payoff_quotes entity id (serviced)
  statement_document_id       text,                                                -- documents entity id (the statement, 35.2)
  good_through                date,
  quoted_total_cents          bigint,
  per_diem_cents              bigint,
  projected_disbursement_date date,
  disbursement_date           date,
  payoff_date                 date,
  funds_id                    text,                                                -- 16.2 payoff_funds entity id
  settlement_id               text,                                                -- 16.2 payoff_settlements entity id
  escrow_treatment            text CHECK (escrow_treatment IN ('credit_to_new_loan', 'refund', 'none', 'partner_obligation')),
  escrow_balance_cents        bigint,
  escrow_consent_id           text,                                                -- 30.3 consents entity id (consent:escrow_credit_to_new_loan:<old>:<application>)
  escrow_credit_event_id      uuid REFERENCES loan_events(id),
  refund_disbursement_id      text,                                                -- 3.5 refunds / disbursements entity id
  release_task_id             text,                                                -- 16.3 release_tasks entity id
  retirement_id               uuid,                                                -- prior_loan_retirements.id (FK added below)
  partner_notification_id     uuid,                                                -- partner_retirement_notifications.id (FK added below)
  last_event_sequence         bigint NOT NULL DEFAULT 0,
  step_attempts               integer NOT NULL DEFAULT 0,
  lease_holder                text,
  lease_until                 timestamptz,
  opened_at                   timestamptz NOT NULL,
  retired_at                  timestamptz,
  completed_at                timestamptz,
  updated_at                  timestamptz NOT NULL,
  retention                   retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
COMMENT ON TABLE refinance_closeouts IS '35.10: one closeout per refinance application with a prior loan on the platform — the join between 24.4''s demand and 16.1''s request, driven by the owners'' events, run by the sweep (closeout.pass), ending with the prior loans row retired by projection and the new loans row linked; mutable on the timers precedent, every change journaled in refinance_closeout_steps';
CREATE INDEX refinance_closeouts_open_idx ON refinance_closeouts(status, step) WHERE status NOT IN ('completed', 'unwound', 'cancelled');
CREATE INDEX refinance_closeouts_prior_idx ON refinance_closeouts(prior_loan_id);
-- edge case: a second application on the same prior loan while a closeout is open is cancelled{prior_loan_in_closeout} — one open closeout per prior loan, race-safe
CREATE UNIQUE INDEX refinance_closeouts_one_open_per_prior_idx ON refinance_closeouts(prior_loan_id) WHERE status NOT IN ('completed', 'unwound', 'cancelled');

CREATE TABLE refinance_closeout_steps (
  id                uuid PRIMARY KEY,
  closeout_id       uuid NOT NULL REFERENCES refinance_closeouts(id),
  application_id    uuid NOT NULL REFERENCES applications(id),
  prior_loan_id     uuid NOT NULL REFERENCES loans(id),
  step              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('entered', 'command_run', 'command_refused', 'command_failed', 'waiting', 'completed', 'skipped', 'held', 'resumed', 'unwound', 'cancelled')),
  clocked           boolean NOT NULL DEFAULT false,
  waiting_on        text,
  trigger_event_id  uuid REFERENCES loan_events(id),
  command_process   text,
  command_name      text,
  command_op        text,
  actor_kind        text,
  actor_id          text,
  actor_role        text,
  decision_id       uuid REFERENCES agent_decisions(id),               -- the owner's decision for the command this line journals (null on a refusal / failure)
  refusal_code      text,
  error_class       text,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,                 -- ids, dates and cents-strings only
  sweep_run_id      uuid REFERENCES sweep_runs(id),                    -- 35.1's run when the sweep ran the command
  created_at        timestamptz NOT NULL DEFAULT now(),
  retention         retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
COMMENT ON TABLE refinance_closeout_steps IS '35.10 rule 10: the closeout journal — every step entered/completed, every owning command with its trigger event, actor and the owner''s decision id, every refusal and failure; `clocked` = whether SM_REFI_CLOSEOUT_STALLED_2BD armed for the entry (false while waiting on a borrower, a statutory window, a signing_officer or the partner''s tape); append-only';
CREATE INDEX refinance_closeout_steps_closeout_idx ON refinance_closeout_steps(closeout_id, created_at, id);
CREATE TRIGGER refinance_closeout_steps_immutable BEFORE UPDATE OR DELETE ON refinance_closeout_steps FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE prior_loan_retirements (
  id                    uuid PRIMARY KEY,
  prior_loan_id         uuid NOT NULL REFERENCES loans(id),
  new_loan_id           uuid REFERENCES loans(id),
  application_id        uuid NOT NULL REFERENCES applications(id),
  closeout_id           uuid NOT NULL REFERENCES refinance_closeouts(id),
  mode                  text NOT NULL CHECK (mode IN ('serviced_same_servicer', 'monitored_partner')),
  prior_status          text NOT NULL CHECK (prior_status IN ('active', 'monitored')),
  retired_on            date,                                          -- the payoff date; null on the superseding row a reversal appends
  retirement_event_id   uuid NOT NULL REFERENCES loan_events(id),      -- refinance.prior_loan.retired, or payoff.reversed on the superseding row
  settlement_event_id   uuid REFERENCES loan_events(id),               -- loan.paid_in_full (serviced) / funding.disbursement.confirmed (monitored)
  settlement_id         text,                                          -- 16.2 payoff_settlements entity id (serviced)
  payoff_demand_id      text,                                          -- 24.4 payoff_demands entity id
  payoff_total_cents    bigint,
  upb_cents             bigint,
  interest_cents        bigint,
  fees_cents            bigint,
  remitted_to           text CHECK (remitted_to IN ('fnma_crs', 'warehouse_paydown', 'partner_wire')),
  wire_reference        text,
  escrow_treatment      text,
  escrow_balance_cents  bigint,
  evidence_document_id  text,                                          -- documents entity id: the final settlement statement (the CRS confirmation where one exists)
  decision_id           uuid REFERENCES agent_decisions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  retention             retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  UNIQUE (prior_loan_id, retirement_event_id)                       -- one row per prior loan and retirement event: the reversal's superseding row keeps the table append-only (the spec's `unique prior_loan_id` is enforced as one live retirement by closeout.retire)
);
COMMENT ON TABLE prior_loan_retirements IS '35.10 rule 7: the retirement is an event with evidence; the status is its projection. One row per prior loan; a reversal inside 16.2''s finality window appends a superseding row (retired_on null, retirement_event_id = payoff.reversed); append-only';
CREATE INDEX prior_loan_retirements_loan_idx ON prior_loan_retirements(prior_loan_id, created_at DESC);
CREATE TRIGGER prior_loan_retirements_immutable BEFORE UPDATE OR DELETE ON prior_loan_retirements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE refinance_closeouts ADD CONSTRAINT refinance_closeouts_retirement_fk FOREIGN KEY (retirement_id) REFERENCES prior_loan_retirements(id);

CREATE TABLE partner_retirement_notifications (
  id                      uuid PRIMARY KEY,
  retirement_id           uuid NOT NULL REFERENCES prior_loan_retirements(id),
  prior_loan_id           uuid NOT NULL REFERENCES loans(id),
  partner_party_id        uuid NOT NULL REFERENCES parties(id),
  kind                    text NOT NULL CHECK (kind IN ('notified', 'acknowledged', 'confirmed', 'disputed', 'resolved')),
  integration_message_id  uuid REFERENCES integration_messages(id),    -- the outbox row (notified only)
  channel                 text CHECK (channel IN ('partner_api', 'sftp', 'email')),
  payload_hash            char(64),
  servicer_loan_number    text,
  notified_on             date,
  ack_reference           text,
  confirmation_source     text CHECK (confirmation_source IN ('tape', 'ack', 'ops_resolve')),
  confirmation_import_id  uuid REFERENCES partner_book_imports(id),
  tape_status             text,
  escalation_id           uuid REFERENCES escalations(id),
  actor_kind              text,
  actor_id                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  retention               retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
COMMENT ON TABLE partner_retirement_notifications IS '35.10 rule 8: the partner is told the same day (one outbox row, adapter partner-book.notify, idempotency key retirement:<prior_loan_id>, PARTNER_PAYLOAD_MINIMAL) and confirms by tape, acknowledgement or the analyst''s book.resolve; one row per act, the latest row per retirement is its state; append-only';
CREATE INDEX partner_retirement_notifications_retirement_idx ON partner_retirement_notifications(retirement_id, created_at DESC);
CREATE TRIGGER partner_retirement_notifications_immutable BEFORE UPDATE OR DELETE ON partner_retirement_notifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE refinance_closeouts ADD CONSTRAINT refinance_closeouts_notification_fk FOREIGN KEY (partner_notification_id) REFERENCES partner_retirement_notifications(id);

CREATE TABLE refinance_closeout_daily_receipts (
  id                  uuid PRIMARY KEY,
  as_of_date          date NOT NULL UNIQUE,
  open                integer NOT NULL,
  by_mode             jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_step             jsonb NOT NULL DEFAULT '{}'::jsonb,
  waiting_human       integer NOT NULL,
  waiting_vendor      integer NOT NULL,
  waiting_partner     integer NOT NULL,
  held                integer NOT NULL,
  retired_today       integer NOT NULL,
  completed_today     integer NOT NULL,
  unwound_today       integer NOT NULL,
  releases_open       integer NOT NULL,
  partner_unconfirmed integer NOT NULL,
  oldest_open_step    text,
  oldest_open_days    integer,
  report_document_id  text,                                            -- documents entity id (35.2)
  created_at          timestamptz NOT NULL DEFAULT now(),
  retention           retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
COMMENT ON TABLE refinance_closeout_daily_receipts IS '35.10 rule 11: the board is a receipt — closeout.board writes one row per day (counts of refinance_closeouts by mode, step and wait; the retirements, completions and unwinds of the day; releases open; partners unconfirmed) and refinance.closeout.daily.run_completed re-arms SM_REFI_CLOSEOUT_BOARD_DAILY; 35.8''s Refinance board renders it; append-only';
CREATE TRIGGER refinance_closeout_daily_receipts_immutable BEFORE UPDATE OR DELETE ON refinance_closeout_daily_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
