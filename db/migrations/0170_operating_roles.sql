-- 0170_operating_roles.sql — 35.7 Operating roles, identity and the FAKE handover
-- (spec/sections/35-operations-runtime/35-7-operating-roles-identity-and-the-fake-handover.md, Data model).
--   role_grants            APPEND-ONLY: the ledger of every change to staff_users.reviewer_roles — grant, revoke, break-glass and its
--                          expiry — with the granting and confirming persons, the rationale and the decision row. Retention corporate_7y.
--   role_queue_snapshots   APPEND-ONLY: one row per role per queue scan (twenty-two a day per environment) — open items, holders,
--                          whether a FAKE fills it, the status of rule 5. Retention security_logs_5y.
--   role_handovers         APPEND-ONLY: the FAKE handover per (environment, role) — planned, requested, enabled, reverted, expired —
--                          with both people and the holders at the switch; the current FAKE set is the environment's default minus the
--                          roles whose latest row is `enabled` (rule 6). Retention security_logs_5y.
--   breakglass_uses        APPEND-ONLY: an emergency assumption of a role for one subject and four hours (rule 8); the review is an
--                          event and a decision row by a different compliance member, never an update. Retention security_logs_5y.
--   api_principals         the per-person and per-service credentials of `/v1` (rule 2): the token only as its sha-256 (shown once at
--                          issue, never a column), the scopes, the expiry (≤ 90 days staff, ≤ 365 days service/partner), `last_used_at`
--                          (touched at most once a minute) and the refusal counters of a dead token (the `ciso` anomaly, once per hour).
--                          Not append-only: the revocation and the counters move. Retention corporate_7y.
--   staff_users            + reviewer_roles (rule 1: any of the twenty-two kernel roles, never admin — the CHECK's literal list equals
--                          src/app/roles.ts HUMAN_ROLES; src/infra/db/db.test.ts ROLE_LIST_DRIFT asserts it), the three disjointness CHECKs
--                          of rule 3, and the ROLE_CHANGE_WITHOUT_GRANT constraint trigger (an UPDATE of the column without a role_grants
--                          row in the same transaction is refused).
--   staff_actions          + principal_id, surface (ops | v1), source (session | principal | shared_token | header) — 34.1 rule 4's row for
--                          every `/v1` request as well as every portal request (0139's header left room for these three).
-- Five base tables (src/infra/db/db.test.ts counts 781 through 0170 at HEAD; 789 once 35.1's 0150 precedes it). No borrower PII anywhere.
-- Append-only in both senses: nothing already applied is edited; identities (0022) is reused as 19.2's mirror, never altered.
BEGIN;

-- 22 literals = src/app/roles.ts HUMAN_ROLES, in its order (db.test.ts ROLE_LIST_DRIFT compares them word for word)
CREATE TABLE role_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id   uuid NOT NULL REFERENCES staff_users(id),
  role            text NOT NULL CHECK (role IN ('officer', 'attorney', 'signing_officer', 'fnma_portal_operator', 'human_agent', 'lossmit_reviewer', 'fraud_officer', 'ciso', 'compliance', 'counsel', 'ops_analyst', 'mlo_of_record', 'underwriting_reviewer', 'notary', 'settlement_agent', 'closing_attorney', 'appraiser', 'property_data_collector', 'funding_approver', 'bsa_officer', 'qc_officer', 'licensed_specialist')),
  environment     text NOT NULL,                                          -- nonprod | production | the ENVIRONMENT value
  action          text NOT NULL CHECK (action IN ('grant', 'revoke', 'breakglass', 'breakglass_expired')),
  request_id      uuid,                                                   -- the two-person request an independence-role grant answers
  granted_by      uuid REFERENCES staff_users(id),                        -- NULL when the cause is 34.1's disable / access review, a break-glass expiry or the nonprod bootstrap
  confirmed_by    uuid REFERENCES staff_users(id),                        -- the compliance confirmation of an independence role
  cause           text CHECK (cause IN ('grant', 'revoke', 'disabled', 'access_review', 'breakglass', 'breakglass_expired', 'bootstrap_nonprod')),
  rationale       text,
  decision_id     uuid REFERENCES agent_decisions(id),                    -- the decision row committed in the same transaction (NULL on the sweep's expiry rows)
  effective_at    timestamptz NOT NULL,                                   -- the command clock
  expires_at      timestamptz,                                            -- break-glass: used_at + 4 hours
  created_at      timestamptz NOT NULL DEFAULT now(),                     -- the wall clock: "the latest row" orders by it
  retention_class retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX role_grants_user_role_idx ON role_grants (staff_user_id, role, environment, created_at DESC);
CREATE INDEX role_grants_request_idx ON role_grants (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX role_grants_expiry_idx ON role_grants (expires_at) WHERE action = 'breakglass';
CREATE TRIGGER role_grants_immutable BEFORE UPDATE OR DELETE ON role_grants FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE role_grants IS '35.7 data model: the append-only ledger of every reviewer-role grant, revoke and break-glass; every change to staff_users.reviewer_roles has a row here in the same transaction.';

CREATE TABLE role_queue_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id           uuid NOT NULL,                                    -- 35.3's cycle_runs.id or the sweep's run id (no FK: neither table is this process's)
  environment           text NOT NULL,
  as_of_date            date NOT NULL,
  role                  text NOT NULL CHECK (role IN ('officer', 'attorney', 'signing_officer', 'fnma_portal_operator', 'human_agent', 'lossmit_reviewer', 'fraud_officer', 'ciso', 'compliance', 'counsel', 'ops_analyst', 'mlo_of_record', 'underwriting_reviewer', 'notary', 'settlement_agent', 'closing_attorney', 'appraiser', 'property_data_collector', 'funding_approver', 'bsa_officer', 'qc_officer', 'licensed_specialist')),
  open_items            int NOT NULL DEFAULT 0 CHECK (open_items >= 0),
  oldest_opened_at      timestamptz,
  holders               int NOT NULL DEFAULT 0,
  holders_signed_in_30d int NOT NULL DEFAULT 0,
  fake                  boolean NOT NULL DEFAULT false,
  status                text NOT NULL CHECK (status IN ('staffed', 'fake', 'unstaffed', 'idle')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  retention_class       retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX role_queue_snapshots_latest_idx ON role_queue_snapshots (environment, role, created_at DESC);
CREATE INDEX role_queue_snapshots_run_idx ON role_queue_snapshots (scan_run_id);
CREATE TRIGGER role_queue_snapshots_immutable BEFORE UPDATE OR DELETE ON role_queue_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE role_queue_snapshots IS '35.7 rule 5: one append-only row per role per queue scan — the proof that each role had someone to do its work, or the escalation that said it did not.';

CREATE TABLE role_handovers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     text NOT NULL,
  role            text NOT NULL CHECK (role IN ('officer', 'attorney', 'signing_officer', 'fnma_portal_operator', 'human_agent', 'lossmit_reviewer', 'fraud_officer', 'ciso', 'compliance', 'counsel', 'ops_analyst', 'mlo_of_record', 'underwriting_reviewer', 'notary', 'settlement_agent', 'closing_attorney', 'appraiser', 'property_data_collector', 'funding_approver', 'bsa_officer', 'qc_officer', 'licensed_specialist')),
  action          text NOT NULL CHECK (action IN ('planned', 'requested', 'enabled', 'reverted', 'expired')),
  request_id      uuid,
  requested_by    uuid REFERENCES staff_users(id),
  confirmed_by    uuid REFERENCES staff_users(id),
  holders         jsonb NOT NULL DEFAULT '[]',                            -- the staff_user_ids holding the role at that instant
  pending_items   int,                                                    -- queue items open at the switch
  rationale       text,
  decision_id     uuid REFERENCES agent_decisions(id),
  effective_at    timestamptz NOT NULL,
  expires_at      timestamptz,                                            -- requested: effective_at + 10 minutes
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX role_handovers_latest_idx ON role_handovers (environment, role, created_at DESC);
CREATE INDEX role_handovers_request_idx ON role_handovers (request_id) WHERE request_id IS NOT NULL;
CREATE TRIGGER role_handovers_immutable BEFORE UPDATE OR DELETE ON role_handovers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE role_handovers IS '35.7 rules 6–7: the FAKE handover per environment and role, two people''s decision; the current FAKE set is the environment''s default minus the roles whose latest row is enabled.';

CREATE TABLE breakglass_uses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id        uuid NOT NULL REFERENCES role_grants(id),
  staff_user_id   uuid NOT NULL REFERENCES staff_users(id),
  role            text NOT NULL CHECK (role IN ('officer', 'attorney', 'signing_officer', 'fnma_portal_operator', 'human_agent', 'lossmit_reviewer', 'fraud_officer', 'ciso', 'compliance', 'counsel', 'ops_analyst', 'mlo_of_record', 'underwriting_reviewer', 'notary', 'settlement_agent', 'closing_attorney', 'appraiser', 'property_data_collector', 'funding_approver', 'bsa_officer', 'qc_officer', 'licensed_specialist')),
  subject_kind    text NOT NULL CHECK (subject_kind IN ('loan', 'application')),
  subject_id      uuid NOT NULL,
  reason          text NOT NULL,
  used_at         timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX breakglass_uses_user_idx ON breakglass_uses (staff_user_id, expires_at DESC);
CREATE TRIGGER breakglass_uses_immutable BEFORE UPDATE OR DELETE ON breakglass_uses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE breakglass_uses IS '35.7 rule 8: an emergency assumption of a role for one subject and four hours; reviewed by a different compliance member within one servicer business day.';

CREATE TABLE api_principals (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                       text NOT NULL CHECK (kind IN ('staff', 'service', 'partner')),
  staff_user_id              uuid REFERENCES staff_users(id),
  party_id                   uuid REFERENCES parties(id),
  name                       text NOT NULL,
  token_hash                 text NOT NULL UNIQUE,                         -- sha-256 hex of the token; the token itself is never a column
  scopes                     jsonb NOT NULL DEFAULT '{}',                  -- {loans: "all" | [ids], applications: "all" | [ids], partner_id?, processes: [prefixes]}
  issued_by                  uuid REFERENCES staff_users(id),
  issued_at                  timestamptz NOT NULL,
  expires_at                 timestamptz NOT NULL,                         -- ≤ 365 days for service and partner, ≤ 90 days for staff
  last_used_at               timestamptz,                                  -- touched at most once a minute
  revoked_at                 timestamptz,
  revoked_by                 uuid REFERENCES staff_users(id),
  revoked_cause              text CHECK (revoked_cause IN ('revoke', 'disabled', 'expired')),
  refusals_in_hour           int NOT NULL DEFAULT 0,                       -- the anomaly counter for a revoked or expired token
  refusals_window_started_at timestamptz,
  refused_escalated_at       timestamptz,                                  -- the ciso anomaly opened at most once per hour per token
  created_at                 timestamptz NOT NULL DEFAULT now(),
  retention_class            retention_class NOT NULL DEFAULT 'corporate_7y',
  CHECK ((kind = 'staff') = (staff_user_id IS NOT NULL)),
  CHECK (kind <> 'partner' OR party_id IS NOT NULL)
);
CREATE INDEX api_principals_staff_idx ON api_principals (staff_user_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE api_principals IS '35.7 rule 2: the credentials of /v1 — a staff principal acts as the person under a role they hold, a service or partner principal as a system actor and never a human role; the token is stored only as its sha-256.';
COMMENT ON COLUMN api_principals.token_hash IS 'sha-256 of the bearer; the token is shown once at issue and never stored';

-- staff_users: the reviewer roles (rule 1) and the disjointness matrix (rule 3)
ALTER TABLE staff_users ADD COLUMN reviewer_roles text[] NOT NULL DEFAULT '{}'
  CONSTRAINT staff_users_reviewer_roles_check CHECK (reviewer_roles <@ ARRAY['officer', 'attorney', 'signing_officer', 'fnma_portal_operator', 'human_agent', 'lossmit_reviewer', 'fraud_officer', 'ciso', 'compliance', 'counsel', 'ops_analyst', 'mlo_of_record', 'underwriting_reviewer', 'notary', 'settlement_agent', 'closing_attorney', 'appraiser', 'property_data_collector', 'funding_approver', 'bsa_officer', 'qc_officer', 'licensed_specialist']::text[]);
ALTER TABLE staff_users ADD CONSTRAINT staff_users_disjoint_qc_officer CHECK (NOT ('qc_officer' = ANY(reviewer_roles) AND ('officer' = ANY(roles) OR reviewer_roles && ARRAY['mlo_of_record', 'underwriting_reviewer', 'funding_approver', 'settlement_agent', 'signing_officer']::text[])));
ALTER TABLE staff_users ADD CONSTRAINT staff_users_disjoint_funding_approver CHECK (NOT ('funding_approver' = ANY(reviewer_roles) AND ('officer' = ANY(roles) OR 'settlement_agent' = ANY(reviewer_roles))));
ALTER TABLE staff_users ADD CONSTRAINT staff_users_disjoint_underwriting_reviewer CHECK (NOT ('underwriting_reviewer' = ANY(reviewer_roles) AND 'mlo_of_record' = ANY(reviewer_roles)));
COMMENT ON COLUMN staff_users.reviewer_roles IS '35.7 rule 1: the kernel roles the person may act under beside the four staff roles — any of HUMAN_ROLES, never admin; a session''s actable set is roles ∪ reviewer_roles minus admin. Changed only with a role_grants row in the same transaction (ROLE_CHANGE_WITHOUT_GRANT).';

-- ROLE_CHANGE_WITHOUT_GRANT: an UPDATE of reviewer_roles needs a role_grants row for the user written by the SAME transaction.
-- Keyed on the writing transaction (the row versions' xmin), so a grant row may carry any timestamp and the writer may INSERT
-- and UPDATE in either order. AFTER + DEFERRABLE INITIALLY DEFERRED, so the row CHECKs above raise first on a hand-written UPDATE.
-- Caveat: a grant row written inside a SAVEPOINT carries the subtransaction's xid and does not count; src/infra/db/client.ts tx is a
-- plain BEGIN/COMMIT and no writer here uses savepoints.
CREATE OR REPLACE FUNCTION staff_users_role_change_needs_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reviewer_roles IS DISTINCT FROM NEW.reviewer_roles
     AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.staff_user_id = NEW.id AND g.xmin = (SELECT u.xmin FROM staff_users u WHERE u.id = NEW.id)) THEN
    RAISE EXCEPTION 'ROLE_CHANGE_WITHOUT_GRANT: staff_users.reviewer_roles changes only with a role_grants row in the same transaction (35.7 data model)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER staff_users_role_change_needs_grant AFTER UPDATE OF reviewer_roles ON staff_users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION staff_users_role_change_needs_grant();

-- staff_actions (append-only; forbid_mutation stays; nullable columns beside 0139's role — 34.1's data model left room for them)
ALTER TABLE staff_actions ADD COLUMN principal_id uuid REFERENCES api_principals(id);
ALTER TABLE staff_actions ADD COLUMN surface text NOT NULL DEFAULT 'ops' CHECK (surface IN ('ops', 'v1'));
ALTER TABLE staff_actions ADD COLUMN source text CHECK (source IN ('session', 'principal', 'shared_token', 'header'));
CREATE INDEX staff_actions_principal_idx ON staff_actions (principal_id, at) WHERE principal_id IS NOT NULL;
COMMENT ON COLUMN staff_actions.surface IS '35.7: ops (the portal) | v1 (the API) — one row per request on either surface (34.1 rule 4)';
COMMENT ON COLUMN staff_actions.source IS '34.1 rule 4 / 35.7: session (a staff session), principal (an api_principals row), shared_token (the API_TOKEN outside production), header (the deploy workflow''s x-actor-* behind the ops bearer)';
COMMENT ON COLUMN staff_actions.principal_id IS '35.7: the api_principals row a /v1 request presented; NULL on the portal and under the shared token';

COMMIT;
