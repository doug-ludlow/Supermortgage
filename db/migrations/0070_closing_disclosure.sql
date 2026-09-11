-- 0070_closing_disclosure.sql — §25.2 Closing Disclosure: preparation, delivery and receipt evidence, the three-specific-
-- business-day waiting period, redisclosure, post-consummation corrections, the seller's CD and the UCD
-- (spec/sections/25-…/25-2-closing-disclosure-preparation-delivery-and-receipt-evidence.md "Data model").
-- Owned here: cd_receipts, cd_figure_sources, cd_consistency_checks, ucd_submissions, cd_waivers, plus the CD columns the
-- spec adds to the baseline `disclosures` table (0064; kind ∈ cd, corrected_cd, seller_cd). Not here (other owners, never
-- duplicated): `disclosures` / `fee_items` / `apr_calculations` (0064, 21.2), `closings` (26.2), `deliveries` (29.3 — the
-- UCD casefile ID is copied there at delivery), `tolerance_tests` / `tolerance_cures` (21.5), `documents` / `consents` /
-- `escalations` (0001/0019 with the 0057 application key). Append-only where the audit needs an immutable trail (receipts,
-- consistency checks, UCD submissions, waivers) — 0001's forbid_mutation trigger. Retention class regz_cd_5y (0059).
BEGIN;

-- ---------------------------------------------------------------- disclosures: CD columns (kind = cd | corrected_cd | seller_cd)
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS cd_version                  int;                      -- 1 = initial
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS cd_reason                   text CHECK (cd_reason IS NULL OR cd_reason IN ('initial', 'pre_consummation_no_wait', 'pre_consummation_new_wait', 'post_consummation_event', 'clerical', 'tolerance_refund'));
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS redisclosure_triggers       jsonb NOT NULL DEFAULT '[]';  -- which of (f)(2)(ii)(A)/(B)/(C) fired, with the 25.1 test ids
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS figures_hash                char(64);                 -- sha256 of the rendered H-25 data set
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS figure_source_version       text;                     -- "settlement_agent=2,creditor=1,escrow=1"
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS new_waiting_period          boolean;                  -- (f)(2)(ii): a new three-business-day wait
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS waiver_document_id          uuid REFERENCES documents(id);
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS superseded_by_disclosure_id uuid REFERENCES disclosures(id);
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS consummated_at              timestamptz;              -- the version in force at closing.consummated (disclosure.cd.consummated)
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS gate_run_id                 text;                     -- 25.1 compliance_test_runs row (checkpoint cd / corrected_cd)
COMMENT ON COLUMN disclosures.cd_version IS '25.2 data model: CD version (1 = initial); earliest_consummation_date (0064) is derived across all required consumers'' cd_receipts (latest effective_receipt_date + 3 business_days_regz_specific); retention_class regz_cd_5y for every CD version (§1026.25(c)(1)(ii)).';
ALTER TABLE disclosures DROP CONSTRAINT IF EXISTS disclosures_cd_version_keyed;
ALTER TABLE disclosures ADD CONSTRAINT disclosures_cd_version_keyed CHECK (kind NOT IN ('cd', 'corrected_cd') OR (cd_version IS NOT NULL AND cd_reason IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS disclosures_cd_version_idx ON disclosures(application_id, cd_version) WHERE kind IN ('cd', 'corrected_cd');

-- ---------------------------------------------------------------- cd_receipts — one row per consumer per CD version
CREATE TABLE cd_receipts (
  receipt_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_id           uuid NOT NULL REFERENCES disclosures(id),
  application_id          uuid NOT NULL REFERENCES applications(id),
  consumer_id             uuid NOT NULL REFERENCES application_borrowers(id),   -- every borrower; every rescinding consumer (non-borrower spouse) on a refinance (§1026.17(d))
  delivered_at            timestamptz NOT NULL,
  delivery_channel        text NOT NULL CHECK (delivery_channel IN ('esign_portal', 'email_link', 'mail', 'courier', 'in_person')),
  mailed_at               timestamptz,                                          -- USPS acceptance date from the print/mail manifest
  receipt_evidence        text CHECK (receipt_evidence IN ('esign_confirmed', 'portal_acknowledged', 'in_person', 'mailbox_rule', 'courier_signed')),
  actual_receipt_at       timestamptz,                                          -- only with evidence of an enumerated kind (decision 25.2-Q2: never an e-mail "opened" event or a phone call)
  presumed_receipt_date   date,                                                 -- delivered/mailed date + 3 business_days_regz_specific (§1026.19(f)(1)(iii))
  effective_receipt_date  date,                                                 -- actual date if evidenced (never later than presumed), else presumed; in person: the delivery date
  evidence_document_id    uuid REFERENCES documents(id),                        -- e-sign certificate, portal acknowledgement, courier signature, settlement agent's signed receipt
  esign_consent_id        uuid REFERENCES consents(id),
  local_date_time_zone    text,                                                 -- the consumer's zone the vendor captured (receipt date = local calendar date)
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cd_receipts_actual_needs_evidence CHECK (actual_receipt_at IS NULL OR receipt_evidence IN ('esign_confirmed', 'portal_acknowledged', 'in_person', 'courier_signed')),
  CONSTRAINT cd_receipts_electronic_needs_consent CHECK (delivery_channel NOT IN ('esign_portal', 'email_link') OR esign_consent_id IS NOT NULL),
  CONSTRAINT cd_receipts_mail_needs_mailed_at CHECK (delivery_channel <> 'mail' OR mailed_at IS NOT NULL)
);
COMMENT ON TABLE cd_receipts IS '25.2 data model: per-consumer delivery and receipt evidence for each CD version; the gate REGZ_1026_19F1_CD_3SBD_GATE uses the LATEST effective_receipt_date across the required consumers; append-only (§1026.25(c)(1)(ii) retention regz_cd_5y).';
CREATE UNIQUE INDEX cd_receipts_version_consumer_idx ON cd_receipts(disclosure_id, consumer_id);
CREATE INDEX cd_receipts_application_idx ON cd_receipts(application_id);
CREATE TRIGGER cd_receipts_immutable BEFORE UPDATE OR DELETE ON cd_receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- cd_figure_sources — every inbound figure version, hashed and reconciled
CREATE TABLE cd_figure_sources (
  source_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL REFERENCES applications(id),
  party                   text NOT NULL CHECK (party IN ('settlement_agent', 'creditor', 'mi', 'flood', 'payoff', 'escrow')),
  version                 int NOT NULL,
  received_at             timestamptz NOT NULL DEFAULT now(),
  payload_document_id     uuid REFERENCES documents(id),                        -- fee sheet / settlement statement / seller CD data (MISMO Title & Closing or portal upload)
  hash                    char(64) NOT NULL,
  reconciled              boolean NOT NULL DEFAULT false,
  reconciled_at           timestamptz,
  variances               jsonb NOT NULL DEFAULT '[]',                          -- [{fee_code, settlement_agent_cents, creditor_cents, delta_cents}]
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cd_figure_sources_reconciled_no_variances CHECK (NOT reconciled OR variances = '[]'::jsonb)
);
COMMENT ON TABLE cd_figure_sources IS '25.2 rule "Content assembly": figures come from versioned sources, never typed; every inbound version is hashed and reconciled against the creditor fee items — an unreconciled variance blocks the CD gate; SM_O62_SETTLEMENT_FIGURES_5SBD is satisfied by party=settlement_agent, reconciled=true.';
CREATE UNIQUE INDEX cd_figure_sources_party_version_idx ON cd_figure_sources(application_id, party, version);

-- ---------------------------------------------------------------- cd_consistency_checks — CD-to-note checks 26.1 consumes before generateClosingDocuments
CREATE TABLE cd_consistency_checks (
  check_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL REFERENCES applications(id),
  disclosure_id           uuid REFERENCES disclosures(id),
  cd_version              int NOT NULL,
  check_code              text NOT NULL CHECK (check_code IN ('CD_NOTE_LOAN_AMOUNT', 'CD_NOTE_RATE', 'CD_NOTE_TERM', 'CD_NOTE_FIRST_PAYMENT_DATE', 'CD_NOTE_MATURITY_DATE', 'CD_NOTE_PI', 'CD_NOTE_LATE_CHARGE', 'CD_NOTE_PREPAY', 'CD_NOTE_ARM_TERMS', 'CD_BORROWER_NAMES_VESTING', 'CD_PROPERTY_ADDRESS', 'CD_NMLSR_IDS', 'CD_ESCROW_VS_O11_3', 'CD_MI_VS_CERT', 'CD_PAYOFF_VS_DEMAND', 'CD_CASH_TO_CLOSE_VS_SETTLEMENT_LEDGER')),
  cd_value                text,
  note_or_source_value    text,
  result                  text NOT NULL CHECK (result IN ('match', 'mismatch', 'n/a')),
  resolved_by             text,                                                 -- the corrected CD (disclosure id) or corrected source that resolved a mismatch
  created_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE cd_consistency_checks IS '25.2 rule "CD-to-note consistency checks": one row per code per CD version (CD_NOTE_PI is $3,402.62 on the refinance fixture — a one-cent mismatch blocks); any mismatch blocks 26.1''s generateClosingDocuments until the CD is corrected; append-only.';
CREATE INDEX cd_consistency_checks_version_idx ON cd_consistency_checks(application_id, cd_version, check_code);
CREATE TRIGGER cd_consistency_checks_immutable BEFORE UPDATE OR DELETE ON cd_consistency_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- ucd_submissions — UCD Collection Solution submissions (DI; UI fallback)
CREATE TABLE ucd_submissions (
  ucd_submission_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL REFERENCES applications(id),
  loan_id                 uuid REFERENCES loans(id),
  ucd_version             text NOT NULL CHECK (ucd_version IN ('1.5', '2.0')),   -- v2.0 by default; v1.5 on flag fnma.ucd.version=1.5 until the Q4 2026 mandate date
  schema_version          text NOT NULL DEFAULT 'MISMO v3.3.0299',
  casefile_id_ucd         text,                                                 -- the UCD Casefile ID returned (copied to deliveries.ucd_casefile_id — 29.3/29.4 read)
  du_casefile_id          text NOT NULL,                                        -- linkage
  xml_document_id         uuid REFERENCES documents(id),
  xml_hash                char(64) NOT NULL,
  embedded_cd_disclosure_id uuid NOT NULL REFERENCES disclosures(id),           -- the CD version whose PDF is embedded (never a superseded version)
  channel                 text NOT NULL CHECK (channel IN ('di', 'ui')),
  submitted_at            timestamptz,
  status                  text NOT NULL CHECK (status IN ('generated', 'submitted', 'accepted', 'accepted_with_warnings', 'rejected', 'error')),
  feedback_messages       jsonb NOT NULL DEFAULT '[]',
  critical_edit_failures  int NOT NULL DEFAULT 0 CHECK (critical_edit_failures >= 0),
  is_final                boolean NOT NULL DEFAULT false,                       -- true for the version delivered (accepted, zero critical edits, final CD embedded)
  submitted_by            text NOT NULL,                                        -- agent run / fnma_portal_operator
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ucd_submissions_final_is_accepted CHECK (NOT is_final OR (status IN ('accepted', 'accepted_with_warnings') AND critical_edit_failures = 0))
);
COMMENT ON TABLE ucd_submissions IS '25.2 rule "UCD": one row per submission, idempotent by (application_id, cd_version, ucd_version); FNMA_UCD_ACCEPTED_GATE opens on an accepted row with zero critical edits embedding the final CD; a post-consummation correction before purchase requires a new row (SM_O62_UCD_RESUBMIT_ON_CORRECTION); append-only.';
CREATE INDEX ucd_submissions_application_idx ON ucd_submissions(application_id, submitted_at);
CREATE TRIGGER ucd_submissions_immutable BEFORE UPDATE OR DELETE ON ucd_submissions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- cd_waivers — §1026.19(f)(1)(iv) consumer waiver of the waiting period
CREATE TABLE cd_waivers (
  waiver_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL REFERENCES applications(id),
  disclosure_id           uuid REFERENCES disclosures(id),
  consumer_ids            uuid[] NOT NULL,                                      -- every consumer entitled to the disclosure signs
  statement_document_id   uuid NOT NULL REFERENCES documents(id),               -- the consumer's own dated, signed statement (never a printed form — decision 25.2-Q3)
  emergency_summary       text NOT NULL,
  dated_on                date NOT NULL,
  received_at             timestamptz NOT NULL,
  accepted_by             text NOT NULL,                                        -- partner `officer`
  accepted_at             timestamptz NOT NULL,
  earliest_consummation_date date NOT NULL,                                     -- acceptance date, never before receipt of the CD
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cd_waivers_consumers_nonempty CHECK (cardinality(consumer_ids) > 0)
);
COMMENT ON TABLE cd_waivers IS '25.2 rule "Waiver": §1026.19(f)(1)(iv) — a consumer-authored, dated, signed statement describing the bona fide personal financial emergency, accepted by officer; "Printed forms for this purpose are prohibited" (the platform never supplies wording); the only way the waiting period is shortened; append-only.';
CREATE INDEX cd_waivers_application_idx ON cd_waivers(application_id);
CREATE TRIGGER cd_waivers_immutable BEFORE UPDATE OR DELETE ON cd_waivers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
