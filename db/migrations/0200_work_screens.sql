-- 0200_work_screens.sql — 35.8 Operator work screens: the per-loan and per-application work the console lacks
-- (spec/sections/35-operations-runtime/35-8-operator-work-screens.md, Data model).
--   work_screen_versions   APPEND-ONLY: one row per (code, version) — the screen's actions with the roles copied from the tool's
--                          humanRoles, the tool's money fields and the per-action `money` flag at registration; the highest version
--                          is current; a stale screen (rule 10) is re-registered as version + 1. Retention security_logs_5y.
--   work_items             the queue (mutable on the timers precedent, src/infra/db/timers.ts): one open item per source
--                          (source_kind, source_id) while status ∉ {closed, cancelled}; the claim, its expiry and the lapse count.
--   work_item_events       APPEND-ONLY: every transition of an item with the person, the session and the role.
--   work_actions           one row per act — executed, proposed, refused, error; a proposal's resolution (approved | declined |
--                          expired, rule 5 / rule 6) is the ONLY update the table admits (work_actions_proposal_only): every other
--                          UPDATE and every DELETE is refused. The decision payload holds the person's fields only (cents as
--                          strings; never a name, address or account). Retention security_logs_5y.
--   work_derivations       APPEND-ONLY: the derived input's hash, its sources (sequence numbers and versions read, never row
--                          contents) and the document that keeps the canonical JSON (35.2). Retention life_of_loan_plus_4y.
--   work_approvals         APPEND-ONLY: at most one approval row per proposal (unique work_action_id); the approver is never the
--                          proposer (SAME_PERSON, checked by the tool; the CHECK below re-asserts it).
--   work_log_recon_runs    APPEND-ONLY: the daily reconciliation of the action log (rule 10).
--   agent_decisions        + inputs_snapshot_hash — the sha-256 of the canonical JSON the tool received (rule 3: what the engine
--                          saw; 35.8-T1 asserts it equals work_derivations.input_sha256). Filled by the command bus for every decision.
-- Seven base tables (src/infra/db/db.test.ts: 789 through 0171 → 796). No borrower PII anywhere: ids, codes, dates and cents strings.
BEGIN;

CREATE TABLE work_screen_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code IN ('le_review', 'cd_review', 'conditions', 'closing_schedule', 'funding_release', 'payment_post', 'payment_reverse', 'escrow_analysis', 'payoff_quote', 'lossmit_decision', 'foreclosure_case', 'bankruptcy_case')),
  version         int NOT NULL CHECK (version >= 1),
  subject_kind    text NOT NULL CHECK (subject_kind IN ('loan', 'application')),
  owning_process  text NOT NULL,
  read_tools      text[] NOT NULL DEFAULT '{}',
  actions         jsonb NOT NULL,                                          -- [{code, process, tool, op?, roles, tool_money_fields, money, decision_schema, derived_fields, deriver, deriver_version}]
  registered_at   timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y',
  UNIQUE (code, version)
);
CREATE TRIGGER work_screen_versions_immutable BEFORE UPDATE OR DELETE ON work_screen_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE work_screen_versions IS '35.8 data model: the registered screens; the highest version per code is current; rule 10 re-registers a screen whose tool roles or money fields changed.';

CREATE TABLE work_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_code       text NOT NULL,
  subject_kind      text NOT NULL,
  subject_id        text NOT NULL,
  loan_id           uuid REFERENCES loans(id),
  application_id    uuid REFERENCES applications(id),
  source_kind       text NOT NULL CHECK (source_kind IN ('escalation', 'portal_task', 'held_notice', 'dead_letter', 'breached_timer', 'job_dead', 'orchestration_held', 'approval_pending', 'case_milestone', 'manual')),
  source_id         text NOT NULL,
  required_role     text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'waiting_approval', 'closed', 'cancelled')),
  claimed_by        uuid REFERENCES staff_users(id),
  claimed_at        timestamptz,
  claim_expires_at  timestamptz,
  claim_lapses      int NOT NULL DEFAULT 0,
  opened_at         timestamptz NOT NULL,
  due_at            timestamptz,
  closed_at         timestamptz,
  closed_by         uuid REFERENCES staff_users(id),
  disposition       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  retention_class   retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE UNIQUE INDEX work_items_open_source_idx ON work_items (source_kind, source_id) WHERE status NOT IN ('closed', 'cancelled');
CREATE INDEX work_items_status_role_idx ON work_items (status, required_role, opened_at);
CREATE INDEX work_items_subject_idx ON work_items (subject_kind, subject_id);
CREATE INDEX work_items_claim_idx ON work_items (claim_expires_at) WHERE status = 'claimed';
COMMENT ON TABLE work_items IS '35.8 data model: the queue — one open item per source; claimed for 4 hours by one person (SM_WORK_ITEM_CLAIM_4H); closed by the person or by the source''s own closing event.';

CREATE TABLE work_item_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id    uuid NOT NULL REFERENCES work_items(id),
  kind            text NOT NULL CHECK (kind IN ('opened', 'claimed', 'released', 'claim_expired', 'approval_waiting', 'closed', 'cancelled')),
  staff_user_id   uuid REFERENCES staff_users(id),
  session_id      uuid REFERENCES staff_sessions(session_id),
  role            text,
  reason          text,
  at              timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX work_item_events_item_idx ON work_item_events (work_item_id, at);
CREATE TRIGGER work_item_events_immutable BEFORE UPDATE OR DELETE ON work_item_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE work_derivations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_code     text NOT NULL,
  action_code     text NOT NULL,
  deriver         text NOT NULL,
  deriver_version text NOT NULL,
  subject_kind    text NOT NULL,
  subject_id      text NOT NULL,
  sources         jsonb NOT NULL DEFAULT '{}',                             -- loan_events.through_sequence, ledger_lines.max_id, loan_installments.version, service_snapshots.id, orchestration_id, entity_records versions — ids and numbers only
  input_sha256    char(64) NOT NULL,
  document_id     uuid REFERENCES documents(id),                           -- the canonical JSON as work-derivation.json (35.2)
  derived_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y'
);
CREATE INDEX work_derivations_subject_idx ON work_derivations (subject_kind, subject_id, derived_at);
CREATE TRIGGER work_derivations_immutable BEFORE UPDATE OR DELETE ON work_derivations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE work_actions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id        uuid REFERENCES work_items(id),                        -- null for an unqueued act
  screen_code         text NOT NULL,
  screen_version      int NOT NULL,
  action_code         text NOT NULL,
  subject_kind        text NOT NULL,
  subject_id          text NOT NULL,
  loan_id             uuid REFERENCES loans(id),
  application_id      uuid REFERENCES applications(id),
  staff_user_id       uuid REFERENCES staff_users(id),                       -- null for the case agent's proposal
  actor_id            text NOT NULL,                                         -- the bus actor (a staff user id, or agent:case)
  session_id          uuid REFERENCES staff_sessions(session_id),
  role                text,
  decision_payload    jsonb NOT NULL DEFAULT '{}',
  decision_sha256     char(64) NOT NULL,
  derivation_id       uuid REFERENCES work_derivations(id),
  process             text NOT NULL,
  tool                text NOT NULL,
  status              text NOT NULL CHECK (status IN ('executed', 'proposed', 'approved', 'declined', 'expired', 'refused', 'error')),
  refusal_code        text,
  command_event_id    uuid REFERENCES loan_events(id),                       -- the first event the command wrote
  agent_decision_id   uuid REFERENCES agent_decisions(id),
  staff_action_id     uuid REFERENCES staff_actions(id),                     -- filled by the reconciliation's join (the row lands after the answer, 34.1 rule 4)
  approval_of         uuid REFERENCES work_actions(id),
  input_sha256        char(64),
  created_at          timestamptz NOT NULL DEFAULT now(),
  retention_class     retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX work_actions_subject_idx ON work_actions (subject_kind, subject_id, created_at DESC);
CREATE INDEX work_actions_item_idx ON work_actions (work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX work_actions_status_idx ON work_actions (status, created_at);
CREATE OR REPLACE FUNCTION work_actions_proposal_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'work_actions is append-only (35.8 data model)'; END IF;
  IF OLD.status <> 'proposed' OR NEW.status NOT IN ('approved', 'declined', 'expired') THEN RAISE EXCEPTION 'work_actions admits only the resolution of a proposal (35.8 rules 5–6)'; END IF;
  IF row_to_json(OLD)::jsonb - 'status' - 'refusal_code' <> row_to_json(NEW)::jsonb - 'status' - 'refusal_code' THEN RAISE EXCEPTION 'work_actions: only status and refusal_code move on a proposal'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_actions_proposal_only BEFORE UPDATE OR DELETE ON work_actions FOR EACH ROW EXECUTE FUNCTION work_actions_proposal_only();
COMMENT ON TABLE work_actions IS '35.8 data model: one row per act (executed | proposed | refused | error); a proposal resolves once to approved | declined | expired and nothing else ever moves.';

CREATE TABLE work_approvals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_action_id          uuid NOT NULL UNIQUE REFERENCES work_actions(id),  -- the proposal; at most one approval row
  approver_staff_user_id  uuid REFERENCES staff_users(id),
  approver_actor_id       text NOT NULL,
  proposer_actor_id       text NOT NULL,
  session_id              uuid REFERENCES staff_sessions(session_id),
  role                    text NOT NULL,
  decision                text NOT NULL CHECK (decision IN ('approved', 'declined')),
  reason                  text,
  executed_action_id      uuid REFERENCES work_actions(id),                  -- null on decline
  created_at              timestamptz NOT NULL DEFAULT now(),
  retention_class         retention_class NOT NULL DEFAULT 'security_logs_5y',
  CHECK (approver_actor_id <> proposer_actor_id)
);
CREATE TRIGGER work_approvals_immutable BEFORE UPDATE OR DELETE ON work_approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE work_log_recon_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date                date NOT NULL,
  actions_checked           int NOT NULL DEFAULT 0,
  orphans                   int NOT NULL DEFAULT 0,
  stale_screens             int NOT NULL DEFAULT 0,
  sole_officer_money_acts   int NOT NULL DEFAULT 0,
  outcome                   text NOT NULL CHECK (outcome IN ('completed', 'failed')),
  report_document_id        uuid REFERENCES documents(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  retention_class           retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX work_log_recon_runs_day_idx ON work_log_recon_runs (as_of_date, created_at DESC);
CREATE TRIGGER work_log_recon_runs_immutable BEFORE UPDATE OR DELETE ON work_log_recon_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- rule 3 / T1: the decision record carries the hash of the canonical input the tool received (src/app/canonical.ts); null for rows written before this file
ALTER TABLE agent_decisions ADD COLUMN inputs_snapshot_hash char(64);

COMMIT;
