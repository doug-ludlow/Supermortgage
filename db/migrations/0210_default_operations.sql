-- 0210_default_operations.sql — §35.9 "Default operations over time": the case engine's own rows beside the sections'
-- case tables (0015 foreclosure, 0016 bankruptcy, 0017 REO/claims), which stay theirs and are written only by their
-- tools. Retention class `life_of_loan_plus_4y` (spec Data model: "an existing retention_class value, 19.1's
-- life-of-loan class; the 7-year court classes stay with the 13.x/14.x rows that carry them"); no PII column beyond ids
-- — names and addresses stay in the owning rows. Append-only where the spec says so (forbid_mutation, like loan_events);
-- the three mutable tables (`case_milestone_expectations`, `breach_action_registry`, `claim_candidates`) move only in
-- the columns the state machine names and are never deleted (the timers precedent, src/infra/db/timers.ts:2-5).
BEGIN;

-- Data model: case_timelines — one row per consumed event per case (rule 1: the fold; `event_id` unique so folding twice writes nothing).
CREATE TABLE case_timelines (
  id               bigserial PRIMARY KEY,
  loan_id          uuid NOT NULL REFERENCES loans(id),
  case_id          uuid,                                              -- null for an early-intervention window (no `cases` row)
  case_kind        text NOT NULL CHECK (case_kind IN ('early_intervention', 'lossmit', 'foreclosure', 'bankruptcy', 'reo', 'claim')),
  event_id         uuid NOT NULL UNIQUE REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,   -- the fold reads persisted events; the command's own references below are checked at COMMIT (0150 precedent)
  event_sequence   bigint NOT NULL,
  event_type       text NOT NULL,
  occurred_on      date NOT NULL,
  source           text NOT NULL CHECK (source IN ('section', 'firm', 'dra', 'docket', 'court', 'screen', 'cycle', 'sweep')),
  status_before    text,
  status_after     text,
  milestone_code   text,
  detail           jsonb NOT NULL DEFAULT '{}',                       -- ids and figures as strings of cents, never document bytes
  retention_class  retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_timelines_loan_seq_idx ON case_timelines (loan_id, event_sequence);
CREATE INDEX case_timelines_case_idx ON case_timelines (case_id, event_sequence);
CREATE TRIGGER case_timelines_immutable BEFORE UPDATE OR DELETE ON case_timelines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: case_milestone_expectations — mutable on the timers precedent (`status`, `due_on` and the satisfying ids move; never deleted).
CREATE TABLE case_milestone_expectations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id             uuid NOT NULL REFERENCES loans(id),
  case_id             uuid NOT NULL,
  case_kind           text NOT NULL,
  milestone_code      text NOT NULL,
  expected_on         date NOT NULL,
  due_on              date NOT NULL,
  basis               text NOT NULL CHECK (basis IN ('firm_forecast', 'docket_order', 'jurisdiction_default', 'section_clock', 'person')),
  basis_ref           text,
  status              text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'due', 'satisfied', 'waived', 'cancelled')),
  satisfied_event_id  uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  waived_by           uuid REFERENCES staff_users(id),
  waiver_reason       text,
  work_item_id        uuid,                                           -- 35.8 work_items, set when `due`
  timer_id            uuid REFERENCES timers(id) DEFERRABLE INITIALLY DEFERRED,
  retention_class     retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX case_milestone_expectations_open_idx ON case_milestone_expectations (case_id, milestone_code) WHERE status IN ('expected', 'due');
CREATE INDEX case_milestone_expectations_loan_idx ON case_milestone_expectations (loan_id, status);
CREATE TRIGGER case_milestone_expectations_no_delete BEFORE DELETE ON case_milestone_expectations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: breach_action_registry — a row per timer code, re-versioned by `compliance` with `officer` confirmation, never deleted
-- (rule 7; discrepancy 2: `cited_text` quotes the registry's breach column verbatim so the executable set is explicit and reviewable).
CREATE TABLE breach_action_registry (
  timer_code       text PRIMARY KEY,
  owner_process    text NOT NULL,
  cited_text       text NOT NULL,
  action_kind      text NOT NULL CHECK (action_kind IN ('escalate', 'refuse_gate', 'message_firm', 'instruct_firm', 'open_work_item', 'set_flag', 'run_tool', 'inform', 'cancel_clock')),
  action_spec      jsonb NOT NULL DEFAULT '{}',
  needs_human      boolean NOT NULL DEFAULT false,
  version          int NOT NULL DEFAULT 1 CHECK (version >= 1),
  registered_by    uuid REFERENCES staff_users(id),                   -- null for the seed rows
  registered_at    timestamptz NOT NULL DEFAULT now(),
  retention_class  retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER breach_action_registry_no_delete BEFORE DELETE ON breach_action_registry FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: breach_actions — append-only, one action per breach instance (`timer_id` unique; ONE_ACTION_PER_BREACH).
CREATE TABLE breach_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timer_id          uuid NOT NULL UNIQUE REFERENCES timers(id) DEFERRABLE INITIALLY DEFERRED,
  timer_code        text NOT NULL,
  loan_id           uuid REFERENCES loans(id),
  application_id    uuid,
  breached_at       timestamptz NOT NULL,
  registry_version  int,
  action_kind       text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('executed', 'deferred', 'escalated_only', 'refused', 'failed')),
  command_event_id  uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  escalation_id     uuid REFERENCES escalations(id) DEFERRABLE INITIALLY DEFERRED,
  work_item_id      uuid,
  refusal_code      text,
  error_class       text,
  decision_id       uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  retention_class   retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX breach_actions_loan_idx ON breach_actions (loan_id, created_at);
CREATE INDEX breach_actions_day_idx ON breach_actions (breached_at);
CREATE TRIGGER breach_actions_immutable BEFORE UPDATE OR DELETE ON breach_actions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: docket_reactions — append-only, one per docket entry (`docket_event_id` unique). The docket entry is 14.1's
-- store row (`bankruptcy_docket_events` kind), so the id is its text key, not a foreign key to the typed table.
CREATE TABLE docket_reactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id               uuid NOT NULL REFERENCES loans(id),
  case_id               text NOT NULL,
  docket_event_id       text NOT NULL UNIQUE,
  classification        text,
  classifier_confidence numeric(4,3),
  reaction_kind         text NOT NULL CHECK (reaction_kind IN ('stay_gate', 'status_change', 'timer_arm', 'poc_supplement', 'mfr_path', 'plan_change', 'payment_change_response', 'statement_mode', 'counsel_package', 'form20', 'none')),
  command_event_id      uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  needs_human           boolean NOT NULL DEFAULT false,
  work_item_id          uuid,
  reacted_at            timestamptz NOT NULL,
  decision_id           uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  retention_class       retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX docket_reactions_loan_idx ON docket_reactions (loan_id, reacted_at);
CREATE TRIGGER docket_reactions_immutable BEFORE UPDATE OR DELETE ON docket_reactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: firm_dispatches — append-only in every column the dispatch is made of; the outbox stamps delivery
-- (`sent_at`, `integration_message_id`) and the acknowledgment path stamps `acknowledged_at` / `ack_source` / `ack_event_id`
-- once each (rule 8: "acknowledged_at, ack_source, ack_event_id" live on the row) — a trigger refuses any other UPDATE and
-- every DELETE.
CREATE TABLE firm_dispatches (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                 uuid NOT NULL REFERENCES loans(id),
  case_id                 uuid,
  firm_id                 text NOT NULL,                              -- 13.6's `attorney_firms` store key
  kind                    text NOT NULL CHECK (kind IN ('referral_package', 'instruction', 'message', 'documents', 'invoice_response', 'status_demand', 'ack_demand')),
  owning_event_id         uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  integration_message_id  uuid REFERENCES integration_messages(id) DEFERRABLE INITIALLY DEFERRED,
  document_id             uuid REFERENCES documents(id) DEFERRABLE INITIALLY DEFERRED,
  sent_at                 timestamptz,
  acknowledged_at         timestamptz,
  ack_source              text CHECK (ack_source IN ('firm_message', 'dra', 'fake')),
  ack_event_id            uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  retention_class         retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX firm_dispatches_case_idx ON firm_dispatches (case_id, kind);
CREATE INDEX firm_dispatches_loan_idx ON firm_dispatches (loan_id, created_at);
CREATE OR REPLACE FUNCTION firm_dispatches_ack_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.loan_id <> OLD.loan_id OR NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.firm_id <> OLD.firm_id OR NEW.kind <> OLD.kind
     OR NEW.owning_event_id IS DISTINCT FROM OLD.owning_event_id OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'firm_dispatches is append-only beyond its delivery and acknowledgment stamps (35.9 rule 8)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER firm_dispatches_ack_only BEFORE UPDATE ON firm_dispatches FOR EACH ROW EXECUTE FUNCTION firm_dispatches_ack_only();
CREATE TRIGGER firm_dispatches_no_delete BEFORE DELETE ON firm_dispatches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: claim_candidates — mutable on the timers precedent (status and the claim/package ids move; never deleted).
CREATE TABLE claim_candidates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id              uuid NOT NULL REFERENCES loans(id),
  case_id              uuid,
  claim_kind           text NOT NULL CHECK (claim_kind IN ('expense_571', 'mi_claim', 'delinquency_advance_4828')),
  milestone_event_id   uuid NOT NULL REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  milestone_kind       text NOT NULL,
  milestone_date       date NOT NULL,
  legal_due_on         date,                                          -- the 15.x row's date, read from that row's clock — never computed here
  package_due_on       date NOT NULL,                                 -- SM_CLAIM_PACKAGE_5BD's
  status               text NOT NULL DEFAULT 'opened' CHECK (status IN ('opened', 'package_building', 'package_built', 'filed', 'settled', 'closed', 'withdrawn')),
  claim_id             text,                                          -- `expense_claims.id` or `mi_claims.id` (15.x store keys)
  package_document_id  uuid REFERENCES documents(id) DEFERRABLE INITIALLY DEFERRED,
  opened_at            timestamptz NOT NULL,
  filed_at             timestamptz,
  retention_class      retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, claim_kind, milestone_event_id)
);
CREATE INDEX claim_candidates_open_idx ON claim_candidates (status, package_due_on);
CREATE TRIGGER claim_candidates_no_delete BEFORE DELETE ON claim_candidates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Data model: default_case_daily_runs — append-only, one per calendar day (`as_of_date` unique).
CREATE TABLE default_case_daily_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date               date NOT NULL UNIQUE,
  cycle_run_ids            uuid[] NOT NULL DEFAULT '{}',
  loans_scanned            int NOT NULL DEFAULT 0,
  events_folded            int NOT NULL DEFAULT 0,
  milestones_expected      int NOT NULL DEFAULT 0,
  milestones_due           int NOT NULL DEFAULT 0,
  milestones_satisfied     int NOT NULL DEFAULT 0,
  docket_events_reacted    int NOT NULL DEFAULT 0,
  docket_events_deferred   int NOT NULL DEFAULT 0,
  breach_actions_executed  int NOT NULL DEFAULT 0,
  breach_actions_deferred  int NOT NULL DEFAULT 0,
  breach_actions_missing   int NOT NULL DEFAULT 0,
  claims_opened            int NOT NULL DEFAULT 0,
  claims_packaged          int NOT NULL DEFAULT 0,
  firm_dispatches          int NOT NULL DEFAULT 0,
  firm_acks                int NOT NULL DEFAULT 0,
  exposure_recomputed      int NOT NULL DEFAULT 0,
  outcome                  text NOT NULL CHECK (outcome IN ('completed', 'partial', 'failed')),
  report_document_id       uuid REFERENCES documents(id) DEFERRABLE INITIALLY DEFERRED,
  receipt_event_id         uuid REFERENCES loan_events(id) DEFERRABLE INITIALLY DEFERRED,
  retention_class          retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER default_case_daily_runs_immutable BEFORE UPDATE OR DELETE ON default_case_daily_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Seed rows (rule 7): registered by the build, `cited_text` verbatim from spec/registry/timers.json's breach column (the
-- lowest-numbered section's row owns a shared code), version 1, `registered_by` null. Every other 11.x–15.x code is
-- `escalate` by absence (open question 2: "only the seeded rows execute; every other code is escalated_only, recorded").
INSERT INTO breach_action_registry (timer_code, owner_process, cited_text, action_kind, action_spec, needs_human) VALUES
  ('FNMA_E3205_FIRM_ACK_2BD', '13.3', 'sev 2 → firm call; 13.6 scorecard', 'message_firm',
   '{"process": "13.6", "tool": "attorney.message.send", "kind": "ack_demand", "input_derivation": "ackDemandFromCase", "scorecard": true}', false),
  ('FNMA_E3302_SALE_CERT_WINDOW_7_15', '13.2', 'sev 1; postpone instruction auto-issued at −7 if uncertified', 'instruct_firm',
   '{"process": "13.2", "tool": "attorney.instruction.send", "kind": "POSTPONE_SALE", "input_derivation": "postponeSaleFromCase", "gate_step": "sale_schedule"}', false),
  ('FNMA_E3215_TIMEFRAME_WARNING_70', '13.5', 'firm status demand (13.6)', 'message_firm',
   '{"process": "13.6", "tool": "attorney.message.send", "kind": "status_demand", "input_derivation": "statusDemandFromCase", "set_flag": {"flag_table": "fc_timeframe_tracking", "flag_column": "status", "flag_value": "at_risk_70pct"}}', false),
  ('REGX_1024_41G_INSTRUCT_COUNSEL_1BD', '13.2', 'sev 1 → `attorney` escalation; `officer` informed', 'escalate',
   '{"role": "attorney", "inform_roles": ["officer"]}', false),
  ('FNMA_E3205_MISSING_DOCS_3BD', '13.3', 'sev 1 (indemnification/comp-fee exposure)', 'open_work_item',
   '{"screen_code": "foreclosure_case", "role": "attorney", "input_derivation": "documentRequestFromCase"}', true),
  ('SM_BK_DOCKET_SYNC_1BD', '14.1', 'sev-3; stale-case exception', 'run_tool',
   '{"process": "35.9", "tool": "docket.sync", "input_derivation": "docketSyncFromCase"}', false),
  ('FNMA_E2_1_04_LAWFIRM_ACK_2BD', '14.1', 'sev-3; re-send; firm scorecard', 'message_firm',
   '{"process": "13.6", "tool": "attorney.message.send", "kind": "ack_demand", "input_derivation": "ackDemandFromCase", "scorecard": true}', false),
  ('SM_MICP_DOCS_TARGET_15', '15.3', 'sev-2', 'open_work_item',
   '{"screen_code": "escalation", "role": "fnma_portal_operator", "input_derivation": "micpUploadFromCandidate"}', true),
  ('SM_CASE_MILESTONE_OVERDUE_5BD', '35.9', 'sev 2 → `attorney` (the firm has not reported the milestone five business days past its due date and nobody waived it; the executor sends the 13.6 status demand — rule 8)', 'message_firm',
   '{"process": "13.6", "tool": "attorney.message.send", "kind": "status_demand", "input_derivation": "statusDemandFromCase"}', false);

-- Jurisdiction overrides (rule 4): `jurisdiction_rules.rules.fc_milestone_defaults.<method>.<milestone>` — the per-milestone
-- default lead times (calendar days from the prior milestone) used when no firm forecast or docket order exists.
-- [UNVERIFIED — fixed demo constants for the fixture states (open question 4); a production table needs counsel's review.]
-- Written into the SQL row's `rules` jsonb; src/domain/operations-runtime/default-35-9.ts exports the same constants as the
-- in-code fallback so a store-only world agrees with the table.
INSERT INTO jurisdiction_rules (state, judicial_foreclosure, rules) VALUES
  ('FL', true,  '{"fc_milestone_defaults": {"judicial": {"first_legal": 45, "service_complete": 60, "judgment": 240, "sale_scheduled": 45, "sale_held": 30, "deed_recorded": 30}}}'),
  ('NY', true,  '{"fc_milestone_defaults": {"judicial": {"first_legal": 45, "service_complete": 90, "judgment": 300, "sale_scheduled": 60, "sale_held": 30, "deed_recorded": 30}}}'),
  ('OH', true,  '{"fc_milestone_defaults": {"judicial": {"first_legal": 45, "service_complete": 60, "judgment": 180, "sale_scheduled": 45, "sale_held": 30, "deed_recorded": 30}}}'),
  ('TX', false, '{"fc_milestone_defaults": {"non_judicial": {"first_legal": 45, "sale_scheduled": 21, "sale_held": 30, "deed_recorded": 30}}}'),
  ('AZ', false, '{"fc_milestone_defaults": {"non_judicial": {"first_legal": 45, "sale_scheduled": 90, "sale_held": 30, "deed_recorded": 30}}}'),
  ('CA', false, '{"fc_milestone_defaults": {"non_judicial": {"first_legal": 45, "sale_scheduled": 90, "sale_held": 30, "deed_recorded": 30}}}')
ON CONFLICT (state) DO UPDATE SET rules = jurisdiction_rules.rules || EXCLUDED.rules;

COMMIT;
