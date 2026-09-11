-- 0102_fraud_aml_sar_ofac.sql — 28.4 Fraud, misrepresentation, AML/SAR, OFAC, and Fannie Mae fraud reporting
-- (spec/sections/28-…/28-4-….md "Data model"). One SAR record type for the whole platform: `sars` is the filing
-- record the servicing side never created (18.5's `fraud_cases`/`fraud_reports` of 0021 carry the case and the Fannie
-- Mae channels; 22.6's `sar_candidates` of 0083 is the agent's package) — origination and servicing cases both file
-- through it. Reuse with ALTERs, never a duplicate: the 28.4 case payload is added to 0021's `fraud_cases` (the shared
-- `cases{case_type='fraud'}` row it is keyed by), the Fannie Mae report columns are added to 0021's `fraud_reports`
-- and `fnma_fraud_reports` is a projection over it; `red_flag_events` (0083) is 22.6's and is never redefined here.
-- New: `sar_decisions`, `ofac_hits`, `ofac_reports`, `identity_theft_requests`, `bsa_program`, and the retention-class
-- projection `bsa_sar_5y` (31 CFR 1029.320(c): five years from the date of filing). Money in bigint cents; dates ET.
-- Append-only where the rows are evidence (decisions, reports, hits are never deleted; a SAR row moves through its
-- status but is never deleted; every state change is also a `loan_events` row keyed by application_id / loan_id).
BEGIN;

ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ofac_10y';                    -- 31.3's class name for OFAC records (§501.601)

-- ───────────────────────────── fraud_cases (0021; keyed by cases.id) gains the 28.4 payload ─────────────────────────────
ALTER TABLE fraud_cases ALTER COLUMN subject_kind SET DEFAULT 'unknown';           -- origination cases open before a subject is identified
ALTER TABLE fraud_cases ALTER COLUMN flagged_at SET DEFAULT now();
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS application_id              uuid REFERENCES applications(id);
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS partner_id                  uuid REFERENCES parties(id);
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS opened_at                   timestamptz;
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS opened_by                   text;                     -- agent run / QC / servicing / tip
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS signals                     jsonb NOT NULL DEFAULT '[]';   -- [{source_process, signal_code, evidence_refs[], score}]
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS scheme_hypotheses           text[] NOT NULL DEFAULT '{}';
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS subjects                    jsonb NOT NULL DEFAULT '[]';   -- parties with role; PII-restricted
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS amount_cents                bigint NOT NULL DEFAULT 0 CHECK (amount_cents >= 0);   -- the $5,000 test (§1029.320(a)(1))
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS triage_status               text NOT NULL DEFAULT 'open' CHECK (triage_status IN ('open', 'under_review', 'suspicious_determined', 'not_suspicious', 'closed'));
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS triage_due_on               date;
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS initial_detection_at        date;                     -- set once at suspicious_determined — the §1029.320(b)(3) anchor (immutable)
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS subject_identified          boolean;
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS requires_immediate_attention boolean NOT NULL DEFAULT false;
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS law_enforcement_notified_at timestamptz;             -- (b)(4)
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS fnma_reasonable_basis_at    date;                     -- A3-4-03 anchor (can differ from initial_detection_at)
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS production_hold             boolean NOT NULL DEFAULT false;   -- SM_FRAUD_PRODUCTION_HOLD (issueCD / consummate / disburse / submitDelivery)
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS decision_reasons_for_no_sar text;
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS triage_rationale            text;
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS closed_at                   timestamptz;
ALTER TABLE fraud_cases ADD COLUMN IF NOT EXISTS retention_classes           text[] NOT NULL DEFAULT '{bsa_sar_5y,fnma_loan_file_life_plus_4y}';
CREATE OR REPLACE FUNCTION fraud_cases_anchor_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.initial_detection_at IS NOT NULL AND NEW.initial_detection_at IS DISTINCT FROM OLD.initial_detection_at THEN
    RAISE EXCEPTION 'fraud_cases.initial_detection_at is immutable once set (28.4 state machine; 31 CFR 1029.320(b)(3))';
  END IF;
  IF OLD.triage_status = 'closed' AND NEW.triage_status <> 'closed' THEN
    RAISE EXCEPTION 'a closed fraud case is not reopened; open a new case';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fraud_cases_anchor_immutable BEFORE UPDATE ON fraud_cases FOR EACH ROW EXECUTE FUNCTION fraud_cases_anchor_immutable();
CREATE INDEX fraud_cases_application_idx ON fraud_cases(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX fraud_cases_triage_open_idx ON fraud_cases(triage_due_on) WHERE triage_status IN ('open', 'under_review');
COMMENT ON COLUMN fraud_cases.initial_detection_at IS '28.4 rule 2: the timestamp of suspicious_determined after the officer-reviewed triage (FFIEC reading: the clock "does not begin until an appropriate review is conducted and a determination is made"), or the earlier date the facts were first assembled when the officer says they were conclusive (worked example 1: determined Oct 21, 2026, anchored Mon Oct 19 → SAR due Wed Nov 18, 2026); immutable once set.';
COMMENT ON COLUMN fraud_cases.production_hold IS '28.4 rule 1 / SM_FRAUD_PRODUCTION_HOLD: true while the case is open on an open application — overlays 22.6''s applications.fraud_hold (assertNoFraudHold) and blocks issueCD, consummate, disburse, submitDelivery (23.3/25.2/26.3/29.3); released on not_suspicious or a chosen decision path.';

-- ───────────────────────────── sars — the SAR record inside sar_confidentiality_acl (31 CFR 1029.320) ─────────────────────────────
CREATE TABLE sars (
  sar_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                   uuid NOT NULL REFERENCES cases(id),                     -- cases{case_type='fraud'} (fraud_cases.case_id)
  candidate_id              uuid REFERENCES sar_candidates(candidate_id),          -- 22.6's package when the case came through an investigation
  application_id            uuid REFERENCES applications(id),
  loan_id                   uuid REFERENCES loans(id),
  filer                     text NOT NULL CHECK (filer IN ('partner', 'sm', 'joint')),
  filing_org_ein_ref        text NOT NULL,                                          -- BSA E-Filing Supervisory User enrollment (EIN) reference — never the EIN itself
  subjects                  jsonb NOT NULL DEFAULT '[]',                            -- Part I (PII-restricted)
  activity                  jsonb NOT NULL DEFAULT '{}',                            -- Part II: dates, amounts, activity types incl. mortgage-fraud categories
  narrative_document_id     uuid REFERENCES documents(id),                          -- Part V (AI-drafted, officer-edited); the text never leaves the compartment
  narrative_hash            text,
  narrative_officer_edited  boolean NOT NULL DEFAULT false,
  supporting_documents      uuid[] NOT NULL DEFAULT '{}',                            -- deemed filed with the SAR; retained with it
  due_on                    date NOT NULL,                                           -- initial_detection_at + 30 (60 without a subject); prior filed_on + 120 for continuing activity
  outer_limit_on            date NOT NULL,
  officer_decision_due_on   date NOT NULL,                                           -- SM_BSA_OFFICER_SAR_DECISION_SLA_5: min(drafted + 5, due_on − 3)
  continuing_activity_of    uuid REFERENCES sars(sar_id),
  amended_from_bsa_id       text,                                                    -- corrected/amended SAR referencing the prior BSA ID
  drafted_at                timestamptz NOT NULL,
  filed_at                  timestamptz,
  filed_on                  date,
  bsa_id                    text,                                                    -- acknowledgement (BSA Identifier)
  filing_channel            text NOT NULL DEFAULT 'discrete' CHECK (filing_channel IN ('discrete', 'batch_xml', 'sdtm')),
  officer_id                text,
  officer_decision          text CHECK (officer_decision IS NULL OR officer_decision IN ('file', 'no_file')),
  officer_decided_at        timestamptz,
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'officer_review', 'approved', 'filed', 'acknowledged', 'rejected', 'no_file')),
  retention_until           date,                                                    -- filed_on + 5 years (§1029.320(c))
  retention_class           text NOT NULL DEFAULT 'bsa_sar_5y' CHECK (retention_class = 'bsa_sar_5y'),
  acl                       text NOT NULL DEFAULT 'sar_confidentiality_acl' CHECK (acl = 'sar_confidentiality_acl'),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sars_filed_shape CHECK (status NOT IN ('filed', 'acknowledged') OR (filed_at IS NOT NULL AND filed_on IS NOT NULL AND retention_until IS NOT NULL AND officer_id IS NOT NULL)),
  CONSTRAINT sars_acknowledged_has_bsa_id CHECK (status <> 'acknowledged' OR bsa_id IS NOT NULL),
  CONSTRAINT sars_no_file_has_officer CHECK (status <> 'no_file' OR (officer_decision = 'no_file' AND officer_id IS NOT NULL))
);
CREATE INDEX sars_case_idx ON sars(case_id);
CREATE INDEX sars_open_idx ON sars(due_on) WHERE status IN ('draft', 'officer_review', 'approved', 'rejected');
CREATE TRIGGER sars_no_delete BEFORE DELETE ON sars FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE sars IS '28.4 (31 CFR 1029.320): the platform''s one SAR record — drafted by the fraud-risk agent (structured fields + who/what/when/where/why/how narrative), decided and filed by the bsa_officer (discrete BSA E-Filing, or batch XML/SDTM where the officer''s approval is the filing decision), acknowledged with a BSA ID, retained five years from filing (bsa_sar_5y; 31.3''s BSA_1029_320C_SAR_RETENTION_5Y). Lives only in sar_confidentiality_acl: bsa_officer roles of the filing organization(s) and the fraud-risk agent''s SAR-preparation identity; the partner and SM see each other''s rows only under a joint filing or one corporate structure (§1029.320(d)); never referenced by a borrower-facing artifact or a production decision.';

-- ───────────────────────────── sar_decisions (file / no_file / continuing_review; append-only) ─────────────────────────────
CREATE TABLE sar_decisions (
  decision_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              uuid NOT NULL REFERENCES cases(id),
  sar_id               uuid REFERENCES sars(sar_id),
  decision             text NOT NULL CHECK (decision IN ('file', 'no_file', 'continuing_review')),
  rationale            text NOT NULL,                                                -- FFIEC: "the specific reason for filing or not filing a SAR"
  decided_by           text NOT NULL,                                                -- bsa_officer (continuing_review: the scheduling actor)
  decided_at           timestamptz NOT NULL,
  review_period_days   int CHECK (review_period_days IS NULL OR review_period_days = 90),
  next_review_due_at   date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sar_decisions_continuing_shape CHECK (decision <> 'continuing_review' OR (review_period_days = 90 AND next_review_due_at IS NOT NULL))
);
CREATE INDEX sar_decisions_case_idx ON sar_decisions(case_id, decided_at DESC);
CREATE TRIGGER sar_decisions_immutable BEFORE UPDATE OR DELETE ON sar_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE sar_decisions IS '28.4: every SAR decision with its rationale — file, no_file (documented reasons; closes the case), continuing_review (90-day review; the continuing SAR is due 120 days after the prior filing — policy per FinCEN SAR FAQ Oct 9, 2025). A case closes only with a file or no_file row.';

-- ───────────────────────────── ofac_hits (screening execution is 22.6''s party_screenings / verifications{kind=ofac}) ─────────────────────────────
CREATE TABLE ofac_hits (
  hit_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screening_id          uuid REFERENCES party_screenings(screening_id),             -- 22.6 (origination)
  screening_result_id   uuid REFERENCES screening_results(id),                      -- 18.5 (servicing)
  party_id              text NOT NULL,
  application_id        uuid REFERENCES applications(id),
  loan_id               uuid REFERENCES loans(id),
  list                  text NOT NULL CHECK (list IN ('sdn', 'non_sdn_consolidated')),
  entry_uid             text NOT NULL,                                               -- SLS entry uid (Advanced Sanctions Data Model)
  match_score           numeric(5,2) NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  match_fields          text[] NOT NULL DEFAULT '{}',                                -- name / alias / DOB / place / ID
  disposition           text NOT NULL DEFAULT 'potential' CHECK (disposition IN ('potential', 'false_positive', 'confirmed_match')),
  dispositioned_by      text,                                                        -- agent (below the auto-clear score) / bsa_officer
  dispositioned_at      timestamptz,
  analysis              text,                                                        -- written match analysis (required for false_positive)
  blocked_property      jsonb,                                                       -- {description, value_cents, blocked_on, location, account_ref}
  rejected_transaction  jsonb,                                                       -- {description, value_cents, rejected_on, counterparties}
  unblocked_on          date,
  retention_until       date,                                                        -- rejected/screening: transaction + 10y; blocked: set only by the unblocking report (unblocked_on + 10y)
  retention_class       text NOT NULL DEFAULT 'ofac_records_10y' CHECK (retention_class IN ('ofac_records_10y', 'ofac_10y')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ofac_hits_source CHECK (screening_id IS NOT NULL OR screening_result_id IS NOT NULL),
  CONSTRAINT ofac_hits_disposition_shape CHECK (disposition = 'potential' OR (dispositioned_by IS NOT NULL AND dispositioned_at IS NOT NULL AND analysis IS NOT NULL)),
  CONSTRAINT ofac_hits_confirmed_shape CHECK (disposition <> 'confirmed_match' OR blocked_property IS NOT NULL OR rejected_transaction IS NOT NULL)
);
CREATE INDEX ofac_hits_open_idx ON ofac_hits(created_at) WHERE disposition = 'potential';
CREATE INDEX ofac_hits_blocked_idx ON ofac_hits(unblocked_on) WHERE blocked_property IS NOT NULL;
CREATE TRIGGER ofac_hits_no_delete BEFORE DELETE ON ofac_hits FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE ofac_hits IS '28.4 rule 6 (31 CFR 501): a potential match from 22.6''s screening → false_positive (written analysis; bsa_officer above the auto-clear score) or confirmed_match (bsa_officer) → blocked property (funds in a blocked interest-bearing account; ofac.property.blocked → OFAC_501_603_BLOCKED_REPORT_10BD) or rejected transaction (refused wire; ofac.transaction.rejected → OFAC_501_604_REJECTED_REPORT_10BD). Retention 10 years from the transaction; for blocked property for as long as it stays blocked plus 10 years after the unblocking date (§501.601) — retention_until is set only when the unblocking report is recorded (T4).';

-- ───────────────────────────── ofac_reports (ORS submissions by the bsa_officer; append-only) ─────────────────────────────
CREATE TABLE ofac_reports (
  report_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hit_id               uuid NOT NULL REFERENCES ofac_hits(hit_id),
  kind                 text NOT NULL CHECK (kind IN ('blocked_initial', 'unblocking', 'rejected_transaction', 'annual_blocked')),
  due_on               date NOT NULL,                                                -- +10 business_days_federal (blocked / unblocking / rejected); Sept 30 (annual, as of June 30)
  submitted_at         timestamptz NOT NULL,
  submitted_on         date NOT NULL,
  late                 boolean NOT NULL DEFAULT false,
  ors_reference        text NOT NULL,
  content_document_id  uuid REFERENCES documents(id),
  officer_id           text NOT NULL,                                                -- bsa_officer
  retention_until      date NOT NULL,                                                -- submitted_on + 10 years
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ofac_reports_hit_idx ON ofac_reports(hit_id, kind);
CREATE TRIGGER ofac_reports_immutable BEFORE UPDATE OR DELETE ON ofac_reports FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE ofac_reports IS '28.4 (31 CFR 501.603/.604): blocked-property initial report within 10 business days of the block (T4: blocked Thu Nov 12, 2026 → Fri Nov 27), unblocking report within 10 business days of unblocking, rejected-transaction report within 10 business days (rejected Fri Oct 9, 2026 → Mon Oct 26), annual report by Sept 30 as of June 30 — through the OFAC Reporting System (ORS) by the bsa_officer, never the agent.';

-- ───────────────────────────── fraud_reports (0021) gains the 28.4 Fannie Mae report columns; fnma_fraud_reports is its projection ─────────────────────────────
ALTER TABLE fraud_reports DROP CONSTRAINT IF EXISTS fraud_reports_channel_check;
ALTER TABLE fraud_reports ADD CONSTRAINT fraud_reports_channel_check CHECK (channel IN ('lqc_self_report', 'ethics_email_ofac', 'fraud_tip_form', 'fraud_hotline', 'fnma_legal_email', 'law_enforcement', 'state_regulator', 'carrier', 'suspected_fraud_form', 'phone'));
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS application_id            uuid REFERENCES applications(id);
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS loan_id                   uuid REFERENCES loans(id);
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS fnma_loan_number          text;                     -- null until purchase (30.1); required for the LQC self-report
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS reasonable_basis_at       date;                     -- A3-4-03 anchor; due_at = + 30 calendar days
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS submit_by_policy          date;                     -- last creditor business day on or before due_at (Fri Dec 25, 2026 → Thu Dec 24)
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS approved_by_officer_at    timestamptz;              -- partner officer
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS approved_by               text;
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS submitted_by_operator_id  text;                     -- fnma_portal_operator (LQC is portal-only)
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS reference                 text;                     -- LQC reference / form confirmation
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS synopsis_document_id      uuid REFERENCES documents(id);
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS documents                 uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'submitted'));
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS late                      boolean NOT NULL DEFAULT false;
ALTER TABLE fraud_reports ADD COLUMN IF NOT EXISTS qc_self_report_id         uuid;                     -- 28.2 qc_self_reports{report_type=fraud} when the loan was sold (FK left soft: 0100 is a sibling migration)
CREATE VIEW fnma_fraud_reports AS
  SELECT id AS report_id, case_id, application_id, loan_id, fnma_loan_number, channel, reasonable_basis_at, due_at, submit_by_policy, approved_by_officer_at, approved_by,
         sent_at AS submitted_at, submitted_by_operator_id, reference, synopsis_document_id, documents, status, late, qc_self_report_id, package_document_id, evidence
  FROM fraud_reports
  WHERE channel IN ('lqc_self_report', 'suspected_fraud_form', 'phone', 'fraud_tip_form', 'fraud_hotline');
COMMENT ON VIEW fnma_fraud_reports IS '28.4 rule 5 (A3-4-03): the Fannie Mae fraud reports — LQC self-report ("Self Report of Lender QC Findings", deficiency category Fraud/Misrepresentation) for delivered/committed loans, the Suspected Mortgage Fraud Report form or 1-800-2FANNIE at the partner''s election otherwise — projected from 18.5''s fraud_reports (0021) so origination and servicing report through one row type; due 30 days from reasonable_basis_at (T5: Wed Nov 25, 2026 → Fri Dec 25; submitted by Thu Dec 24; Mon Dec 28 is a breach); approved by the partner officer, submitted by the fnma_portal_operator; SAR material excluded.';

-- ───────────────────────────── identity_theft_requests (FCRA §609(e); FCRA_609E_VICTIM_RECORDS_30) ─────────────────────────────
CREATE TABLE identity_theft_requests (
  request_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester            text NOT NULL CHECK (requester IN ('victim', 'law_enforcement')),
  application_id       uuid REFERENCES applications(id),
  loan_id              uuid REFERENCES loans(id),
  received_on          date NOT NULL,
  verified             boolean NOT NULL DEFAULT false,
  verification         jsonb NOT NULL DEFAULT '{}',                                  -- {identity_proof, claim_proof ∈ {police_report, ftc_affidavit}}
  due_on               date NOT NULL,                                                -- received_on + 30 calendar days
  records_provided_at  timestamptz,
  declined_reason      text CHECK (declined_reason IS NULL OR declined_reason IN ('identity_not_verified', 'request_based_on_misrepresentation', 'information_would_be_used_in_furtherance_of_crime', 'otherwise_prohibited_by_law')),   -- §609(e)(5)
  document_ids         uuid[] NOT NULL DEFAULT '{}',
  charge_cents         bigint NOT NULL DEFAULT 0 CHECK (charge_cents = 0),           -- "without charge"
  status               text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'records_provided', 'declined')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_theft_requests_outcome CHECK ((status = 'records_provided' AND records_provided_at IS NOT NULL) OR (status = 'declined' AND declined_reason IS NOT NULL) OR status = 'received')
);
CREATE INDEX identity_theft_requests_open_idx ON identity_theft_requests(due_on) WHERE status = 'received';
CREATE TRIGGER identity_theft_requests_no_delete BEFORE DELETE ON identity_theft_requests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE identity_theft_requests IS '28.4 rule 7 (15 U.S.C. 1681g(e)): a victim''s (or authorized law enforcement''s) request for the application and business transaction records — verified (identity proof + police report or FTC affidavit), provided without charge within 30 days of receipt (T9: Mon Nov 2, 2026 → Wed Dec 2, 2026) or declined on a documented (e)(5) ground.';

-- ───────────────────────────── bsa_program (one row per program owner: partner, sm) ─────────────────────────────
CREATE TABLE bsa_program (
  program_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner                             text NOT NULL UNIQUE CHECK (owner IN ('partner', 'sm')),
  version                           text NOT NULL,
  compliance_date                   date,                                            -- set by the final rule (FR 2026-07033) — a version bump, not a redesign (T14)
  approved_by_senior_management_at  date,
  board_approved_at                 date,
  risk_assessment_document_id       uuid REFERENCES documents(id),
  risk_assessment_date              date,
  compliance_officer_id             text NOT NULL,                                   -- §1029.210(b)(2) designated compliance officer (the bsa_officer)
  training                          jsonb NOT NULL DEFAULT '[]',                     -- [{person, course, completed_at}]
  independent_tests                 jsonb NOT NULL DEFAULT '[]',                     -- [{tester, independent_of_officer: true, period, report_document_id, findings, remediation_due}]
  red_flags_itpp_document_id        uuid REFERENCES documents(id),
  red_flags_board_report_at         date,
  next_review_due_on                date,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bsa_program_no_delete BEFORE DELETE ON bsa_program FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE bsa_program IS '28.4 rule 10 (31 CFR 1029.210; FR 2026-07033 NPRM structure; 16 CFR 681): the written AML program per owner — senior-management (and board) approval, the documented risk assessment, the compliance officer, training records for every "appropriate person", independent tests by a tester other than the compliance officer (T11), the Red Flags ITPP and its annual board report; the annual rows BSA_1029_210_* and FCRA_681_ITPP_BOARD_REPORT_ANNUAL run against it.';

-- ───────────────────────────── bsa_sar_5y — the retention-class projection (31 CFR 1029.320(c); 31.3 disposal gate) ─────────────────────────────
CREATE VIEW bsa_sar_5y AS
  SELECT 'sars'::text AS record_table, sar_id AS record_id, case_id, filed_on AS anchor_on, retention_until, status
  FROM sars
  UNION ALL
  SELECT 'sar_candidates'::text, candidate_id, NULL::uuid, detection_date, NULL::date, status
  FROM sar_candidates
  UNION ALL
  SELECT 'verifications'::text, verification_id, NULL::uuid, COALESCE(screened_at, received_at, created_at)::date, NULL::date, kind::text
  FROM verifications
  WHERE retention_class = 'bsa_sar_5y';
COMMENT ON VIEW bsa_sar_5y IS '28.4 / 31.3 retention class bsa_sar_5y: every record retained "for a period of five years from the date of filing the SAR" (31 CFR 1029.320(c)) — SAR rows (retention_until = filed_on + 5 years; worked example 1: filed Fri Oct 30, 2026 → Oct 30, 2031), 22.6''s SAR candidates and supporting verification rows tagged with the class; the disposal gate BSA_1029_320C_SAR_RETENTION_5Y reads it.';

COMMIT;
