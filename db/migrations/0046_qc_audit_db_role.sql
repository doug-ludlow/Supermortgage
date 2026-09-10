-- 18.1 Internal QC plan — the `qc_audit` database role behind the qc-audit agent's tools allowlist.
-- Spec (AI agent design): "Tools allowlist: read-only SQL over projections and immutable logs; recompute
-- engines; document retrieval; `cases.create{qc_finding}`; `escalations.create`; report rendering.
-- Never: write to operational tables, post ledger entries (remediation entries are posted by the owning
-- agent from the CAPA), send borrower communications, or change rule sets."
-- 18.1-T10: "Given `qc-audit` attempts `INSERT` into `ledger_entries`, then the DB role denies it and the
-- attempt is logged." `ledger_entries` is the physical pair ledger_entry_sets + ledger_lines. The denial is
-- SQLSTATE 42501 (insufficient_privilege) from this grant set; Postgres writes the error to the server log,
-- and — because a denied statement cannot write a row inside its own failed transaction — the application
-- records the attempt as an access_log row and a `security.access_denied` event on the append-only log
-- (src/domain/qc-audit/ops-18-1.ts qcAuditWriteAttempt; the tool bus refuses the same use before it reaches
-- the database and appends `command.refused`). Mirrored in QC_AUDIT_DB_GRANTS. No new tables.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qc_audit') THEN CREATE ROLE qc_audit NOLOGIN; END IF;
END $$;
COMMENT ON ROLE qc_audit IS '18.1 qc-audit agent: SELECT on projections and immutable logs; INSERT only on QC/AI governance records, cases, escalations, decisions, documents, portal tasks and access_log; never ledger, loan_events, loans, notices or rule sets (18.1-T10).';

GRANT USAGE ON SCHEMA public TO qc_audit;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO qc_audit;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO qc_audit;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO qc_audit;

-- the records the process writes (append-only rows; qc_tests / agent_decisions carry forbid_mutation triggers)
GRANT INSERT ON qc_cycles, qc_samples, qc_tests, qc_findings, qc_corrective_actions, qc_reports,
                cases, escalations, agent_decisions, documents, human_portal_tasks,
                ai_evaluations, ai_monitoring_metrics, ai_disclosure_requests, access_log TO qc_audit;
-- the only in-place changes: cycle and finding state (the state machines in the spec)
GRANT UPDATE (status, closed_at, report_document_id, signed_by_officer_id) ON qc_cycles TO qc_audit;
GRANT UPDATE (status, root_cause, affected_population_query, affected_count, remediation_cents_total, reported_to_partner_at, reported_to_fnma_at) ON qc_findings TO qc_audit;

-- explicit, reviewable denials: nothing below was ever granted; the REVOKEs state the rule where an auditor looks
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ledger_entry_sets, ledger_lines, ledger_accounts FROM qc_audit;      -- "post ledger entries"
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON loan_events, loans, loan_terms, timers FROM qc_audit;                -- "write to operational tables"
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON notices, notice_deliveries, notice_batches FROM qc_audit;            -- "send borrower communications"
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON qc_rules, rule_sets FROM qc_audit;                                   -- "change rule sets"

COMMIT;
