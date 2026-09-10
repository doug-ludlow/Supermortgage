-- 0055_fnma_tech_provider_evidence.sql — Section 19.3 (Fannie Mae data/tech-provider requirements): the evidence the
-- five input clocks and the vendor state machine read from the *record* rather than the caller — the vendor incident's
-- SLA measurement (SM_VENDOR_INCIDENT_NOTICE_SLA: awareness, notice receipt, hours, sla_met), the Tier 1 activation
-- evidence and the officer's approval on `vendors`, the LL-2026-04 policy's annual review record
-- (FNMA_LL2026_04_POLICY_REVIEW_365; DOC_AI_GOVERNANCE_POLICY), the arrangement the Form 101 belongs to
-- (FNMA_A2107_FORM101_INCEPTION_GATE / _TERMINATION_5BD), and the Technology Guide Integration Interface compliance
-- state the 120-day rule disables (FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120: "must not transfer data via an
-- Integration Interface if the Integration Interface is out of compliance for more than 120 days"). Append-only.
BEGIN;

-- vendor_incidents: the contractual notice SLA measured from the vendor's awareness (rule 6 INCIDENT_NOTICE_24H)
ALTER TABLE vendor_incidents
  ADD COLUMN IF NOT EXISTS vendor_aware_at     timestamptz,
  ADD COLUMN IF NOT EXISTS sla_hours           int NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS notice_due_at       timestamptz,
  ADD COLUMN IF NOT EXISTS notice_received_at  timestamptz,
  ADD COLUMN IF NOT EXISTS notice_document_id  uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS hours_to_notice     numeric(8,2);
COMMENT ON COLUMN vendor_incidents.vendor_aware_at IS '19.3 SM_VENDOR_INCIDENT_NOTICE_SLA anchor: the vendor''s awareness as reported; notice_due_at = vendor_aware_at + sla_hours (24 h default, mandatory clause INCIDENT_NOTICE_24H)';
COMMENT ON COLUMN vendor_incidents.sla_met IS '19.3: notice_received_at − vendor_aware_at ≤ sla_hours; a miss is logged as a vendor SLA breach and feeds a triggered reassessment';

-- vendors: the activation evidence and the officer''s approval the state machine reads from the record
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS ll2026_04_attestation_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS officer_approved_by  text,
  ADD COLUMN IF NOT EXISTS officer_approved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS credentials_revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS data_return_certified_at timestamptz,
  ADD COLUMN IF NOT EXISTS data_return_certificate_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS sla_breaches         int NOT NULL DEFAULT 0;
COMMENT ON COLUMN vendors.officer_approved_by IS '19.3 state machine: Tier 1 needs an officer approval before approved/active; recorded once, carried to activation';
COMMENT ON COLUMN vendors.data_return_certified_at IS '19.3 state machine: terminated requires data return/destruction certification (data_return.certified by an officer) and credential revocation';

-- ai_policy_documents (0021): the designated owner''s annual review record (LL-2026-04 "at least annually")
ALTER TABLE ai_policy_documents
  ADD COLUMN IF NOT EXISTS approved_by   text,
  ADD COLUMN IF NOT EXISTS reviewed_at   date,
  ADD COLUMN IF NOT EXISTS reviewed_by   text,
  ADD COLUMN IF NOT EXISTS review_document_id uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','reviewed'));
COMMENT ON COLUMN ai_policy_documents.reviewed_at IS '19.3 FNMA_LL2026_04_POLICY_REVIEW_365: ai_policy.reviewed{signed_by_owner=true}; next_review_due = reviewed_at + 1 year';

-- data_access_authorizations: the arrangement the Form 101 belongs to (A2-1-07: at inception and again at termination)
ALTER TABLE data_access_authorizations
  ADD COLUMN IF NOT EXISTS arrangement_contract_id uuid REFERENCES counterparty_contracts(id),
  ADD COLUMN IF NOT EXISTS arrangement_effective_from date,
  ADD COLUMN IF NOT EXISTS arrangement_terminated_effective_on date,
  ADD COLUMN IF NOT EXISTS form101_termination_due date;

-- contract_events: the termination''s effective date (the Form 101 termination clock runs from it, not from the notice)
ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS effective_on date;

-- integration_interfaces: Technology Guide Integration Interface compliance state (schema/version drift → 120-day clock → disabled)
CREATE TABLE integration_interfaces (
  id                    text PRIMARY KEY,                                          -- e.g. 'lsdu-b2b', 'servicing-events-api'
  status                text NOT NULL DEFAULT 'compliant' CHECK (status IN ('compliant','noncompliant','disabled')),
  detected_on           date,
  disable_on            date,                                                      -- detected_on + 120 calendar days
  disabled_on           date,
  restored_on           date,
  drift                 jsonb,                                                     -- {expected_spec_version, actual_spec_version, description}
  evidence_document_id  uuid REFERENCES documents(id),                             -- the operator''s conformance evidence on restoration
  updated_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE integration_interfaces IS '19.3 FNMA_TECHGUIDE_INTEGRATION_COMPLIANCE_120: integration.noncompliance.detected{detected_at} → +120 calendar days; disabled on day 120 (daily sweep, sev-1); integration.compliance.restored on the operator''s evidence';

COMMIT;
