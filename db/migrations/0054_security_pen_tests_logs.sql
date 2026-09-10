-- 0054: §19.2 data model — the two tables the spec names that 0022 folded elsewhere: `pen_tests`
-- (the annual independent third-party penetration test that satisfies the Supplement, FTC 314.4(d)(2)(i)
-- and NYDFS 500.5(a)(1); 0022 keeps a generic `security_program_records` row, this is the typed record)
-- and `security_logs_5y` (the write-once security log store of rule 7 / 23 NYCRR 500.6: hot 13 months,
-- cold to 5 years — the conservative reading the spec defaults to in open decision 1).
BEGIN;

CREATE TABLE pen_tests (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period                      text NOT NULL,                                     -- e.g. '2026' / '2026-H2'
  performer                   text NOT NULL,                                     -- independent third party (Supplement)
  independent_third_party     boolean NOT NULL DEFAULT true,
  scope                       jsonb NOT NULL DEFAULT '{}',                       -- {assets[], internet_facing, internal, application, cloud}
  methodology                 text,
  started_on                  date,
  completed_at                timestamptz,
  report_document_id          uuid REFERENCES documents(id),
  findings                    jsonb NOT NULL DEFAULT '[]',                       -- [{id, severity, cve?, asset_id?, description}]
  remediation_plan            jsonb NOT NULL DEFAULT '[]',                       -- [{finding_id, owner, due_on, vulnerability_id?}]
  material_change_trigger     boolean NOT NULL DEFAULT false,                    -- re-test after a material system change (FTC 314.4(d)(2)(i))
  satisfies_timer_codes       text[] NOT NULL DEFAULT ARRAY['FNMA_SUPP_PENTEST_ANNUAL_365'],
  program_record_id           uuid REFERENCES security_program_records(id),
  next_due_on                 date,                                              -- completed_at + 365 days
  retention                   retention_class NOT NULL DEFAULT 'corporate_7y',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (independent_third_party OR performer IS NOT NULL)
);
COMMENT ON TABLE pen_tests IS '§19.2 penetration tests: annual independent third-party test (Fannie Mae Supplement; FTC 16 CFR 314.4(d)(2)(i); 23 NYCRR 500.5(a)(1)) with findings and risk-rated remediation plan; `pen_test.completed` satisfies FNMA_SUPP_PENTEST_ANNUAL_365.';
CREATE INDEX pen_tests_period_idx ON pen_tests (period, completed_at);

CREATE TABLE security_logs_5y (
  id                          bigserial PRIMARY KEY,
  logged_at                   timestamptz NOT NULL,
  logged_on                   date NOT NULL,                                     -- logged_at in ET, for tiering
  source                      text NOT NULL CHECK (source IN ('idp','cloud_control_plane','pgaudit','application','loan_events','agent_runs','tool_calls','network_flow','edr','dlp','siem_alert','console_access','kms')),
  event_type                  text NOT NULL,
  actor                       text,                                              -- identity subject / agent id / system
  identity_id                 uuid REFERENCES identities(id),
  asset_id                    uuid REFERENCES assets(id),
  loan_id                     uuid REFERENCES loans(id),
  incident_id                 uuid REFERENCES security_incidents(id),
  purpose_code                text,                                              -- rule 5: every access to pii_level=high / restricted FL logged with purpose code and request id
  request_id                  text,
  severity                    text CHECK (severity IN ('info','low','medium','high','critical')),
  payload                     jsonb NOT NULL DEFAULT '{}',                       -- tokenized: no full SSNs, no restricted FL data
  sha256                      text NOT NULL,                                     -- integrity hash of the canonical record
  worm_location               text,                                              -- write-once copy (rule 7)
  hot_until                   date NOT NULL,                                     -- logged_on + 13 months
  retain_until                date NOT NULL,                                     -- logged_on + 5 years (23 NYCRR 500.6(b))
  retention                   retention_class NOT NULL DEFAULT 'security_logs_5y',
  CHECK (retain_until >= hot_until AND hot_until > logged_on)
);
COMMENT ON TABLE security_logs_5y IS '§19.2 rule 7 / 23 NYCRR 500.6 audit trail: SIEM-ingested security logs (IdP, cloud control plane, pgAudit, application/agent tool calls, network, EDR, DLP), write-once, hot 13 months and cold to 5 years (open decision 1 default); append-only.';
CREATE INDEX security_logs_5y_logged_idx ON security_logs_5y (logged_at);
CREATE INDEX security_logs_5y_identity_idx ON security_logs_5y (identity_id, logged_at);
CREATE INDEX security_logs_5y_incident_idx ON security_logs_5y (incident_id) WHERE incident_id IS NOT NULL;
CREATE TRIGGER security_logs_5y_immutable BEFORE UPDATE OR DELETE ON security_logs_5y FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
