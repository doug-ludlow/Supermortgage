-- 0240_production_posture.sql — 35.12 Production posture
-- (spec/sections/35-operations-runtime/35-12-production-posture.md, Data model).
--   environment_manifests  APPEND-ONLY: one row per deploy (posture.record) — Terraform, secret names and version ages, runtime facts,
--                          the env_hash; never a secret's payload. Retention security_logs_5y.
--   posture_controls       APPEND-ONLY by version: the catalogue of rule 2 (PST-01…PST-17), seeded at version 1 below; a change is a new version.
--   posture_checks         APPEND-ONLY: one row per control per run (posture.check). Retention security_logs_5y.
--   posture_findings       APPEND-ONLY: the finding's history (opened → acknowledged → resolved | excepted → expired); the current state is the
--                          latest row of a finding_id. Retention security_logs_5y.
--   integration_switches   APPEND-ONLY: the per-vendor switch ledger (rule 4) — one row per confirmed throw with both people (the request is an
--                          event, integration.switch.requested, 35.7's grant-request pattern); the mode in force is the latest row. Retention corporate_7y.
--   restore_drills         APPEND-ONLY: every quarterly restore with observed RPO/RTO, row checks, chain and ledger results, the clone's lifecycle.
--   data_scans             APPEND-ONLY: the daily nonprod scan and the production inverse — counts only, never a value or an id of a person.
--   parallel_runs          APPEND-ONLY: the 28-day parallel run against the incumbent — opened, day_reconciled, extended, closed. Retention corporate_7y.
--   parallel_run_diffs     APPEND-ONLY: one diff per (loan, field, day) — a loan_id and two figures, never a person. Retention corporate_7y.
--   go_live_checklists     APPEND-ONLY: GL-01…GL-12 computed statuses with evidence references, the waivers, and GL-00 the two-person attestation.
--   parties                + synthetic (set true by every fixture and seed writer; the nonprod scan's first rule and the production scan's inverse).
--   transfer_batches       + synthetic (from the tape's X-Supermortgage-Synthetic header; the rows it boards inherit it).
--   staff_oidc_identities  the staff member's OpenID Connect binding from the environment's provider (the ops-console OIDC client, an operational
--                          prerequisite) — issuer and subject only, never an e-mail or a name; PST-06 reads it. Not append-only: revoked_at moves.
--                          Retention security_logs_5y. (32.14's oidc_identities is the borrower's and stays untouched.)
--   security_controls      the 19.2 rows the PST → CTL map targets are inserted when absent, so control_test_results.control_code resolves.
-- Eleven base tables (src/infra/db/db.test.ts: 789 → 800). No borrower PII in any table of this process.
-- Append-only in both senses: nothing already applied is edited.
BEGIN;

CREATE TABLE environment_manifests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     text NOT NULL CHECK (environment IN ('nonprod', 'staging', 'production')),
  project_id      text NOT NULL,
  region          text NOT NULL,
  image_digest    text NOT NULL,
  migration_head  text NOT NULL,
  terraform       jsonb NOT NULL DEFAULT '{}',
  secrets         jsonb NOT NULL DEFAULT '[]',                                -- [{name, version_created_at, placeholder}] — never a value
  runtime         jsonb NOT NULL DEFAULT '{}',                                -- {integrations, fake_reviewers, environment, env_names[], …}
  env_hash        char(64) NOT NULL,                                          -- sha-256 over the canonical JSON of terraform, secret names + ages bucketed by day, runtime
  deploy_run_id   text,
  recorded_by     uuid REFERENCES api_principals(id),                         -- the deploy workflow's service principal (NULL for a staff session)
  document_id     uuid REFERENCES documents(id),                              -- the hashed manifest document
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX environment_manifests_env_idx ON environment_manifests (environment, created_at DESC);
CREATE INDEX environment_manifests_digest_idx ON environment_manifests (image_digest, environment);
CREATE TRIGGER environment_manifests_immutable BEFORE UPDATE OR DELETE ON environment_manifests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE environment_manifests IS '35.12 rule 1: the environment as recorded at every deploy — values and names only, never a secret''s payload.';

CREATE TABLE posture_controls (
  code                  text NOT NULL,
  version               int NOT NULL,
  name                  text NOT NULL,
  environments          text[] NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3')),
  check_kind            text NOT NULL CHECK (check_kind IN ('terraform', 'runtime', 'secret_age', 'iam', 'network', 'database', 'data_scan', 'identity')),
  expected              jsonb NOT NULL DEFAULT '{}',
  citation              text NOT NULL,
  security_control_code text REFERENCES security_controls(code),
  created_at            timestamptz NOT NULL DEFAULT now(),
  retention_class       retention_class NOT NULL DEFAULT 'security_logs_5y',
  PRIMARY KEY (code, version)
);
CREATE TRIGGER posture_controls_immutable BEFORE UPDATE OR DELETE ON posture_controls FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE posture_controls IS '35.12 rule 2: the posture control catalogue; a change is a new version, never an edit.';

CREATE TABLE posture_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL,
  environment     text NOT NULL,
  manifest_id     uuid REFERENCES environment_manifests(id),                  -- NULL for a scan-driven row (PST-11 from the production scan)
  control_code    text NOT NULL,
  control_version int NOT NULL,
  result          text NOT NULL CHECK (result IN ('pass', 'fail', 'not_applicable', 'unverifiable')),
  observed        jsonb NOT NULL DEFAULT '{}',
  expected        jsonb NOT NULL DEFAULT '{}',
  checked_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y',
  FOREIGN KEY (control_code, control_version) REFERENCES posture_controls(code, version)
);
CREATE INDEX posture_checks_run_idx ON posture_checks (run_id);
CREATE INDEX posture_checks_env_control_idx ON posture_checks (environment, control_code, checked_at DESC);
CREATE TRIGGER posture_checks_immutable BEFORE UPDATE OR DELETE ON posture_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE posture_checks IS '35.12 rule 3: one row per control per posture run; the run''s receipt is posture.check.run_completed.';

CREATE TABLE posture_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id      uuid NOT NULL,
  environment     text NOT NULL,
  control_code    text NOT NULL,
  action          text NOT NULL CHECK (action IN ('opened', 'acknowledged', 'resolved', 'excepted', 'expired')),
  check_id        uuid REFERENCES posture_checks(id),
  severity        text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3')),
  detected_at     timestamptz NOT NULL,
  resolved_at     timestamptz,
  cause           text CHECK (cause IN ('manifest', 'exception')),
  exception_id    uuid REFERENCES control_exceptions(id),
  by              uuid REFERENCES staff_users(id),
  decision_id     uuid REFERENCES agent_decisions(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX posture_findings_finding_idx ON posture_findings (finding_id, created_at DESC);
CREATE INDEX posture_findings_env_control_idx ON posture_findings (environment, control_code, created_at DESC);
CREATE TRIGGER posture_findings_immutable BEFORE UPDATE OR DELETE ON posture_findings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE posture_findings IS '35.12 rule 3: a failure is a clock with an owner — the finding''s history; its current state is the latest row.';

CREATE TABLE integration_switches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment     text NOT NULL CHECK (environment IN ('nonprod', 'staging', 'production')),
  vendor          text NOT NULL CHECK (vendor IN ('lockbox_bai2', 'ach_nacha', 'eoscar', 'fnma_p360', 'fnma_smdu', 'fnma_lsdu', 'fnma_du', 'fnma_earlycheck', 'fnma_loan_lookup', 'print_mail', 'evault', 'mers', 'stripe_identity', 'plaid', 'truv', 'irs_ives', 'ron', 'telephony_sms_email', 'edelivery', 'rates', 'google_oidc', 'tavus', 'blob_store', 'warehouse', 'wire_verification', 'credit_bureau', 'amc', 'title', 'cbsv', 'ofac_screener', 'fraud_tool', 'ucdp', 'state_doi', 'alta_registry')),
  mode            text NOT NULL CHECK (mode IN ('fake', 'real', 'off')),
  endpoint_class  text NOT NULL CHECK (endpoint_class IN ('sandbox', 'live')),
  secret_ref      text,                                                       -- a Secret Manager resource name, never a value
  egress_rule     text,
  request_id      uuid NOT NULL,
  requested_by    uuid REFERENCES staff_users(id),
  confirmed_by    uuid REFERENCES staff_users(id),
  rationale       text,
  effective_at    timestamptz NOT NULL,                                       -- the confirmation instant (the request itself is an event, integration.switch.requested)
  decision_id     uuid REFERENCES agent_decisions(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX integration_switches_vendor_idx ON integration_switches (environment, vendor, created_at DESC);
CREATE INDEX integration_switches_request_idx ON integration_switches (request_id);
CREATE TRIGGER integration_switches_immutable BEFORE UPDATE OR DELETE ON integration_switches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE integration_switches IS '35.12 rule 4: INTEGRATIONS as a real switch per vendor — two people per throw; the mode in force is the latest row with an effective_at.';

CREATE TABLE restore_drills (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment          text NOT NULL,
  source_backup_id     text,
  backup_taken_at      timestamptz,
  pitr_target_at       timestamptz NOT NULL,
  clone_instance       text,
  started_at           timestamptz NOT NULL,
  completed_at         timestamptz NOT NULL,
  rpo_observed_s       int,
  rto_observed_s       int NOT NULL,
  row_checks           jsonb NOT NULL DEFAULT '[]',
  event_chain_ok       boolean NOT NULL,
  ledger_balanced      boolean NOT NULL,
  result               text NOT NULL CHECK (result IN ('passed', 'failed')),
  failure_reason       text,
  clone_destroyed_at   timestamptz,
  evidence_document_id uuid REFERENCES documents(id),
  performed_by         uuid REFERENCES staff_users(id),
  witnessed_by         uuid REFERENCES staff_users(id),
  decision_id          uuid REFERENCES agent_decisions(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  retention_class      retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX restore_drills_env_idx ON restore_drills (environment, completed_at DESC);
CREATE TRIGGER restore_drills_immutable BEFORE UPDATE OR DELETE ON restore_drills FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE restore_drills IS '35.12 rule 5: every restore drill with observed RPO/RTO, row checks, chain and ledger results and the clone''s lifecycle.';

CREATE TABLE data_scans (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment            text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('nonprod_real_data', 'classification_inventory', 'production_synthetic')),
  scanned_at             timestamptz NOT NULL,
  tables_scanned         int NOT NULL,
  rows_examined          bigint NOT NULL,
  findings               jsonb NOT NULL DEFAULT '[]',                         -- [{table, column, rule, count}] — counts only
  real_data_found        boolean NOT NULL,
  synthetic_coverage_pct numeric(6,3),
  evidence_document_id   uuid REFERENCES documents(id),
  purges_scan_id         uuid REFERENCES data_scans(id),                       -- a clean scan carrying the finding's scan_id (posture.real_data.purged)
  created_at             timestamptz NOT NULL DEFAULT now(),
  retention_class        retention_class NOT NULL DEFAULT 'security_logs_5y'
);
CREATE INDEX data_scans_env_idx ON data_scans (environment, kind, scanned_at DESC);
CREATE TRIGGER data_scans_immutable BEFORE UPDATE OR DELETE ON data_scans FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE data_scans IS '35.12 rule 6: no real borrower data in nonprod, no synthetic data in production — counts only, never a value or an id of a person.';

CREATE TABLE parallel_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parallel_run_id            uuid NOT NULL,
  environment                text NOT NULL,
  incumbent_servicer         text NOT NULL,
  opened_on                  date NOT NULL,
  planned_end_on             date NOT NULL,
  loan_count                 int NOT NULL,
  action                     text NOT NULL CHECK (action IN ('opened', 'day_reconciled', 'extended', 'closed')),
  as_of_date                 date,
  comparisons                int,
  matched                    int,
  mismatched                 int,
  mismatch_cents             bigint,
  incumbent_file_document_id uuid REFERENCES documents(id),
  report_document_id         uuid REFERENCES documents(id),
  outcome                    text CHECK (outcome IN ('passed', 'abandoned')),
  reason                     text,
  by                         uuid REFERENCES staff_users(id),
  decision_id                uuid REFERENCES agent_decisions(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  retention_class            retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX parallel_runs_run_idx ON parallel_runs (parallel_run_id, created_at DESC);
CREATE INDEX parallel_runs_env_idx ON parallel_runs (environment, created_at DESC);
CREATE TRIGGER parallel_runs_immutable BEFORE UPDATE OR DELETE ON parallel_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE parallel_runs IS '35.12 rules 7 and 9: the 28-day parallel run against the incumbent, day by day.';

CREATE TABLE parallel_run_diffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diff_id         uuid NOT NULL,
  parallel_run_id uuid NOT NULL,
  as_of_date      date NOT NULL,
  loan_id         uuid REFERENCES loans(id),
  field           text NOT NULL CHECK (field IN ('upb_cents', 'escrow_balance_cents', 'next_due_date', 'late_charges_accrued_cents', 'interest_paid_ytd_cents', 'amount_due_cents', 'days_delinquent', 'form_496_remittance_cents')),
  ours            text,
  theirs          text,
  delta_cents     bigint NOT NULL DEFAULT 0,
  action          text NOT NULL CHECK (action IN ('opened', 'dispositioned', 'reopened')),
  disposition     text CHECK (disposition IN ('ours_right', 'theirs_right', 'both_wrong', 'timing')),
  reason          text,
  by              uuid REFERENCES staff_users(id),
  decision_id     uuid REFERENCES agent_decisions(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX parallel_run_diffs_diff_idx ON parallel_run_diffs (diff_id, created_at DESC);
CREATE INDEX parallel_run_diffs_run_idx ON parallel_run_diffs (parallel_run_id, as_of_date);
CREATE TRIGGER parallel_run_diffs_immutable BEFORE UPDATE OR DELETE ON parallel_run_diffs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE parallel_run_diffs IS '35.12 rule 8: a diff is a loan_id, a field and two figures — dispositioned by an officer, corrected by the owning section, never a person.';

CREATE TABLE go_live_checklists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id    uuid NOT NULL,
  environment     text NOT NULL,
  item_code       text NOT NULL CHECK (item_code ~ '^GL-(0[0-9]|1[0-2])$'),
  status          text NOT NULL CHECK (status IN ('open', 'satisfied', 'waived', 'attested')),
  evidence_ref    text,
  reason          text,
  by              uuid REFERENCES staff_users(id),
  by_role         text,
  confirmed_by    uuid REFERENCES staff_users(id),
  manifest_id     uuid REFERENCES environment_manifests(id),
  request_id      uuid,                                                       -- GL-00: the ciso request (an event, go_live.attest.requested) the compliance confirmation answers
  decision_id     uuid REFERENCES agent_decisions(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'corporate_7y'
);
CREATE INDEX go_live_checklists_env_idx ON go_live_checklists (environment, checklist_id, item_code, created_at DESC);
CREATE TRIGGER go_live_checklists_immutable BEFORE UPDATE OR DELETE ON go_live_checklists FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE go_live_checklists IS '35.12 rule 10: the go-live checklist, computed never typed; GL-00 is the two-person attestation.';

-- extended baseline tables
ALTER TABLE parties ADD COLUMN synthetic boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN parties.synthetic IS '35.12 rule 6: set true by every fixture and seed writer, never by a production writer.';
ALTER TABLE transfer_batches ADD COLUMN synthetic boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN transfer_batches.synthetic IS '35.12 rule 6: from the tape''s X-Supermortgage-Synthetic: true header; the rows it boards inherit it.';
CREATE TABLE staff_oidc_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id   uuid NOT NULL REFERENCES staff_users(id),
  environment     text NOT NULL,
  issuer          text NOT NULL,                                              -- the environment's provider (https://accounts.google.com for the Workspace directory)
  subject         text NOT NULL,                                              -- the provider's stable `sub`; never the e-mail or the display name
  bound_at        timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retention_class retention_class NOT NULL DEFAULT 'security_logs_5y',
  UNIQUE (issuer, subject)
);
CREATE INDEX staff_oidc_identities_user_idx ON staff_oidc_identities (staff_user_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE staff_oidc_identities IS '35.12 PST-06: a person behind every staff credential — the staff member''s OpenID Connect binding from the environment''s provider; issuer and subject only.';

-- the 19.2 controls the posture catalogue maps onto, named as src/app/tools/section19-2.ts names them (control_test_results.control_code resolves against them; inserted only when 19.2 has not)
INSERT INTO security_controls (code, name, objective, owner_role, test_frequency, automated) VALUES
  ('CTL-SEC-01', 'Multi-factor authentication', '23 NYCRR 500.12; 16 CFR 314.4(c)(5)', 'ciso', 'daily', true),
  ('CTL-SEC-02', 'Credential age', '23 NYCRR 500.7; 16 CFR 314.4(c)(1) — Fannie Mae credentials past 90 (human) / 365 (system ID) days', 'ciso', 'daily', true),
  ('CTL-SEC-03', 'TLS profile against the registry gate', '23 NYCRR 500.15; 16 CFR 314.4(c)(3)', 'ciso', 'daily', true),
  ('CTL-SEC-04', 'Scan ingestion', '23 NYCRR 500.5 — vulnerability scans ingested and triaged', 'ciso', 'daily', true),
  ('CTL-SEC-05', 'Audit trail', '23 NYCRR 500.6; 16 CFR 314.4(c)(8)', 'ciso', 'daily', true),
  ('CTL-SEC-06', 'Asset inventory and classification', '23 NYCRR 500.13', 'ciso', 'daily', true),
  ('CTL-SEC-07', 'Monitoring and training', '23 NYCRR 500.14', 'ciso', 'daily', true),
  ('CTL-SEC-16', 'Restore test', '23 NYCRR 500.16(d); 16 CFR 314.4(h) — the backup restore test', 'ciso', 'quarterly', true)
ON CONFLICT (code) DO NOTHING;

-- the catalogue of rule 2, version 1 (a change is a new version)
INSERT INTO posture_controls (code, version, name, environments, severity, check_kind, expected, citation, security_control_code) VALUES
  ('PST-01', 1, 'private networking', '{production,staging}', 'sev1', 'network', '{"sql.ipv4_enabled": false, "sql.private_service_access": true, "run.vpc_egress": "set"}', '35.12 rule 2 PST-01 (sql.tf:39 today)', 'CTL-SEC-03'),
  ('PST-02', 1, 'high availability', '{production}', 'sev2', 'terraform', '{"sql.availability_type": "REGIONAL"}', '35.12 rule 2 PST-02 (sql.tf:18 today)', 'CTL-SEC-16'),
  ('PST-03', 1, 'backups', '{nonprod,staging,production}', 'sev1', 'terraform', '{"sql.pitr": true, "sql.log_retention_days_min": 7, "sql.retained_backups_min": 14}', '35.12 rule 2 PST-03 (sql.tf:23-31)', 'CTL-SEC-16'),
  ('PST-04', 1, 'CMEK and rotation', '{nonprod,staging,production}', 'sev2', 'terraform', '{"sql.cmek_key": "set", "sql.rotation_period_s_max": 7776000}', '35.12 rule 2 PST-04 (kms.tf:18)', 'CTL-SEC-03'),
  ('PST-05', 1, 'no shared credential', '{production,staging}', 'sev1', 'runtime', '{"env_names_exclude": ["API_TOKEN"], "staff_actions.source_not_in": ["shared_token", "header"]}', '35.12 rule 2 PST-05 (server.ts:46-48 today)', 'CTL-SEC-01'),
  ('PST-06', 1, 'a person behind every staff credential', '{production}', 'sev1', 'identity', '{"password_credentials": 0, "without_oidc": 0}', '35.12 rule 2 PST-06', 'CTL-SEC-01'),
  ('PST-07', 1, 'narrowed deployer', '{production}', 'sev2', 'iam', '{"iam.deployer_roles_exclude": ["roles/editor", "roles/owner"]}', '35.12 rule 2 PST-07 (bootstrap.sh:121 today)', 'CTL-SEC-02'),
  ('PST-08', 1, 'WAF enforced', '{production}', 'sev2', 'network', '{"armor.waf_preview": false, "armor.allowlist_count_min": 1}', '35.12 rule 2 PST-08 (lb.tf:45, :57 today)', 'CTL-SEC-04'),
  ('PST-09', 1, 'cipher keys and secrets present', '{production,staging}', 'sev1', 'runtime', '{"placeholder": false, "required": ["supermortgage-staff-email-key", "supermortgage-tin-cipher-key", "supermortgage-borrower-url-secret", "supermortgage-database-url"]}', '35.12 rule 2 PST-09 (config.ts:28, repo.ts:32, tin.ts:17)', 'CTL-SEC-03'),
  ('PST-10', 1, 'no FAKE in production', '{production}', 'sev1', 'runtime', '{"runtime.integrations": "real", "runtime.fake_reviewers": "off", "integration_switches.fake": 0, "handovers.enabled": "all"}', '35.12 rule 2 PST-10 (run.tf:10, reviewers.ts:54-57 today; 35.7 rule 6)', 'CTL-SEC-02'),
  ('PST-11', 1, 'demo surfaces absent', '{production}', 'sev1', 'database', '{"demo_clock_status": 403, "demo_clock_rows": 0, "parties.synthetic_true": 0}', '35.12 rule 2 PST-11 (server.ts:354, :361; main.ts:57)', 'CTL-SEC-05'),
  ('PST-12', 1, 'org policies and audit sinks', '{production}', 'sev2', 'iam', '{"org_policies": ["sql.restrictPublicIp", "iam.allowedPolicyMemberDomains", "compute.requireShieldedVm"], "audit_sink_locked": true}', '35.12 rule 2 PST-12 (DEPLOY.md:402 item 7)', 'CTL-SEC-05'),
  ('PST-13', 1, 'promoted image', '{production}', 'sev3', 'runtime', '{"staging_manifest_min_age_h": 24, "staging_run": "passing"}', '35.12 rule 2 PST-13', 'CTL-SEC-04'),
  ('PST-14', 1, 'secret age', '{production,staging}', 'sev2', 'secret_age', '{"max_age_days": 90}', '35.12 rule 2 PST-14 (19.2 credential reset applied to machine secrets)', 'CTL-SEC-01'),
  ('PST-15', 1, 'classification inventory', '{nonprod,staging,production}', 'sev2', 'database', '{"assets.classification": "set", "assets.data_classes": "set", "restricted_kinds": ["database", "bucket", "key"]}', '35.12 rule 2 PST-15 (19.2 assets; 23 NYCRR 500.13)', 'CTL-SEC-06'),
  ('PST-16', 1, 'egress matches the switches', '{production,staging}', 'sev2', 'network', '{"egress_rules": "exactly the vendors in mode real"}', '35.12 rule 2 PST-16', 'CTL-SEC-02'),
  ('PST-17', 1, 'logs carry no PII', '{nonprod,staging,production}', 'sev1', 'runtime', '{"logs.sample_lines": 1000, "logs.email_matches": 0, "logs.tin_matches": 0, "logs.name_fields": 0}', '35.12 rule 2 PST-17 (34.1 rule 4; migration 0139)', 'CTL-SEC-05');

COMMIT;
