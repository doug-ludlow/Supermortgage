-- 0083_identity_fraud_screening.sql — 22.6 Identity, fraud, OFAC/AML, Red Flags, occupancy/undisclosed-REO and
-- non-arm's-length screening (spec/sections/22-…/22-6-…md "Data model"; addendum §3). `applications` and its children
-- are 0057's; `cases` (0001; the fraud investigation joins it with case_type = 'fraud' — the servicing `fraud_cases`
-- table of 0021 is 18.5's post-funding case and is not redefined here); `documents` (0001); `verifications` is the
-- baseline table 0081 created (22.3/22.4 columns) and 22.6 extends for kind ∈ {identity, ssn, ofac, fraud}. 28.4 owns
-- `sars` and the filings; it reads and updates `red_flag_events` as the ITPP program owner and never redefines it.
-- Append-only where the rows are evidence (screenings, legal-presence assessments, investigations, SAR candidates):
-- a new assessment is a new row; every state change is also a `loan_events` row keyed by application_id.
BEGIN;

-- Retention classes 22.6 defines (31 CFR 501.601 — OFAC records "for at least 10 years"; SSA CBSV user agreement —
-- signed SSA-89 forms retained five years; 31 CFR 1029.320(d) — SAR and supporting documentation five years).
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ofac_records_10y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'ssa_89_5y';
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'bsa_sar_5y';

-- ───────────────────────────── applications: the fraud_hold overlay and the screening state ─────────────────────────────
-- State machine: `fraud_hold` overlays any state and blocks submitDu (new casefiles), issueCD, consummate and
-- funding.authorized until released by the fraud-risk agent's concluded investigation (or the bsa_officer for OFAC matches).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_hold            boolean NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_hold_reason     text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_hold_placed_at  timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fraud_hold_case_id    uuid REFERENCES cases(id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS screening_status      text NOT NULL DEFAULT 'screening_open'
  CHECK (screening_status IN ('screening_open', 'screening_clear', 'rescreen_due', 'screening_final'));
COMMENT ON COLUMN applications.fraud_hold IS '22.6 state machine: the hold overlay — blocks submitDu / issueCD / consummate / funding.authorized; placed by fraud.hold.placed (OFAC match_true, inconsistent occupancy, high-severity fraud-tool alert, investigation) and released only by fraud.hold.released after investigation.concluded (bsa_officer for OFAC).';
COMMENT ON COLUMN applications.screening_status IS '22.6 application-level screening: screening_open → screening_clear (all borrowers verified, SSN consistent/validated, legal presence, OFAC clear for all parties, fraud-tool alerts dispositioned, occupancy consistent, REO reconciled, non-arm''s-length eligible) → rescreen_due (party change / pre-closing) → screening_final at consummation.';

-- ───────────────────────────── verifications (baseline; kind ∈ {identity, ssn, ofac, fraud} owned here) ─────────────────────────────
ALTER TABLE verifications DROP CONSTRAINT IF EXISTS verifications_kind_check;
ALTER TABLE verifications ADD CONSTRAINT verifications_kind_check
  CHECK (kind IN ('income', 'employment', 'vvoe', 'assets', 'tax_transcript', 'rental', 'identity', 'ssn', 'ofac', 'fraud'));
ALTER TABLE verifications DROP CONSTRAINT IF EXISTS verifications_component_check;
ALTER TABLE verifications ADD CONSTRAINT verifications_component_check
  CHECK (component IN ('income', 'employment', 'assets', 'tax_transcript', 'rental', 'identity', 'ssn', 'ofac', 'fraud'));
-- OFAC screens (31 CFR 501) and fraud-tool runs are program duties, not consent-based orders; identity rows carry the
-- biometric consent and SSN rows the SSA-89 authorization.
ALTER TABLE verifications ALTER COLUMN authorization_consent_id DROP NOT NULL;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS subject_kind                    text CHECK (subject_kind IS NULL OR subject_kind IN ('borrower', 'non_borrower_party'));
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS subject_party_id                text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS identity_level                  text CHECK (identity_level IS NULL OR identity_level IN ('ial1_data_match', 'ial2_remote_doc_biometric', 'ial2_supervised_remote', 'in_person_notary'));
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS id_document_type                text CHECK (id_document_type IS NULL OR id_document_type IN ('drivers_license', 'state_id', 'passport', 'passport_card', 'permanent_resident_card', 'ead', 'military_id', 'other'));
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS id_document_issuer              text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS id_document_number_hash         text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS id_document_expires_on          date;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS document_authentication_result  text CHECK (document_authentication_result IS NULL OR document_authentication_result IN ('pass', 'fail', 'inconclusive'));
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS liveness_result                 text CHECK (liveness_result IS NULL OR liveness_result IN ('pass', 'fail', 'inconclusive'));
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS face_match_score                numeric(5,4);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS data_match                      jsonb NOT NULL DEFAULT '{}';         -- name/DOB/address/phone vs application, credit header, vendor sources
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS ssn_validation_method           text CHECK (ssn_validation_method IS NULL OR ssn_validation_method IN ('not_required', 'cbsv_web_service', 'cbsv_online', 'ecbsv', 'ssa_89_paper'));
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS ssn_match                       boolean;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS ssn_death_indicator             boolean;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS ssn_discrepancy_open            boolean NOT NULL DEFAULT false;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS sfc_162_required                boolean NOT NULL DEFAULT false;       -- B2-2-01: validated by the SSA but a discrepancy persists in credit/DU/Loan Delivery → 29.3
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS ofac_list_version               text;                                 -- SLS publication date/hash
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS ofac_screen_result              text CHECK (ofac_screen_result IS NULL OR ofac_screen_result IN ('clear', 'potential_match', 'false_positive_resolved', 'true_match_blocked', 'true_match_rejected'));
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS ofac_match_details              jsonb;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS fraud_tool_vendor               text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS fraud_report_id                 text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS fraud_score                     numeric(7,2);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS fraud_alerts                    jsonb NOT NULL DEFAULT '[]';         -- per alert: category, severity, disposition
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS screened_at                     timestamptz;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS valid_until                     date;                                 -- identity: note date; OFAC: next list change; fraud tool: CTC
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS evidence_document_ids           uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS retention_class                 text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y'
  CHECK (retention_class IN ('fnma_loan_file_life_plus_4y', 'ofac_records_10y', 'ssa_89_5y', 'bsa_sar_5y'));
COMMENT ON COLUMN verifications.identity_level IS '22.6 R1: each borrower must reach ial2_remote_doc_biometric (document authenticated, liveness passed, face match ≥ vendor threshold, data match) — inconclusive → ial2_supervised_remote (SM_IDENTITY_RETRY_2BD) → in_person_notary at closing (26.2); submitDu waits for at least a supervised remote pass.';
COMMENT ON COLUMN verifications.retention_class IS '22.6: identity/fraud rows fnma_loan_file_life_plus_4y; OFAC rows ofac_records_10y (31 CFR 501.601); SSA-89 evidence ssa_89_5y.';

-- ───────────────────────────── party_screenings (R4; OFAC_SDN_SCREEN_GATE) ─────────────────────────────
CREATE TABLE party_screenings (
  screening_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id),
  party_id          text NOT NULL,
  party_role        text NOT NULL CHECK (party_role IN ('borrower', 'co_borrower', 'non_borrowing_spouse', 'seller', 'buyer_agent', 'listing_agent', 'builder_developer', 'settlement_agent', 'title_company', 'appraiser', 'pdc_collector', 'gift_donor', 'employer', 'subordinate_lender', 'dpa_provider', 'poa_agent', 'trustee', 'other')),
  lists_checked     text[] NOT NULL DEFAULT '{ofac_sdn,ofac_consolidated}',
  list_versions     jsonb NOT NULL DEFAULT '{}',                       -- {ofac_sdn: "<SLS publication date/hash>", …}
  result            text NOT NULL CHECK (result IN ('clear', 'potential_match', 'match_resolved_false', 'match_true')),
  resolution        jsonb,                                              -- identifiers compared: DOB, address, nationality, ID numbers
  screened_at       timestamptz NOT NULL,
  rescreen_due_at   timestamptz,                                        -- next list change / 1 business_days_creditor before consummation / before funding.authorized
  agent_run_id      text,
  retention_class   text NOT NULL DEFAULT 'ofac_records_10y' CHECK (retention_class IN ('ofac_records_10y', 'fnma_loan_file_life_plus_4y')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX party_screenings_app_idx ON party_screenings(application_id, screened_at DESC);
CREATE TRIGGER party_screenings_immutable BEFORE UPDATE OR DELETE ON party_screenings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE party_screenings IS '22.6 R4: every party (borrowers, non-borrowing spouse, seller, agents, settlement agent/title, appraiser/PDC, gift donor, employer, DPA provider, POA agent, trustee) screened against the SDN and Non-SDN Consolidated lists (and SAM / HUD LDP / FHFA SCP for vendors — A3-4-03) against a recorded SLS list version; potential matches resolved by ≥ 2 non-name identifiers; match_true → transaction rejected / property blocked → 28.4 ORS report within 10 business days; records kept 10 years (31 CFR 501.601). Append-only: a re-screen is a new row.';

-- ───────────────────────────── legal_presence_records (R3; restricted like applicant_demographics) ─────────────────────────────
CREATE TABLE restricted_fl.legal_presence_records (
  record_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id),
  borrower_id               uuid NOT NULL REFERENCES application_borrowers(id),
  status_declared           text NOT NULL CHECK (status_declared IN ('us_citizen', 'lawful_permanent_resident', 'non_permanent_resident', 'other')),
  evidence_kind             text NOT NULL CHECK (evidence_kind IN ('passport_us', 'birth_certificate_not_required', 'permanent_resident_card', 'ead', 'visa_with_i94', 'i797_approval', 'other')),
  evidence_document_id      uuid REFERENCES documents(id),
  evidence_expires_on       date,
  scheduled_note_date       date,
  expires_before_note_date  boolean NOT NULL DEFAULT false,
  renewal_receipt_present   boolean NOT NULL DEFAULT false,             -- USCIS extension receipt (accepted only with legal_presence.pending_renewal_accepted — Q5)
  assessment                text NOT NULL CHECK (assessment IN ('legally_present', 'not_established', 'ineligible')),
  regb_6b7_rationale        text NOT NULL,                               -- Reg B §1002.6(b)(7): rights-and-remedies basis only, never a national-origin proxy
  assessed_at               timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legal_presence_records_borrower_idx ON restricted_fl.legal_presence_records(borrower_id, assessed_at DESC);
CREATE TRIGGER legal_presence_records_immutable BEFORE UPDATE OR DELETE ON restricted_fl.legal_presence_records FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE restricted_fl.legal_presence_records IS '22.6 R3 (B2-2-02; Reg B §1002.6(b)(7)): the lender''s determination that a non-U.S. citizen borrower is legally present — permanent resident card / EAD / visa with I-94 / I-797; expires_before_note_date = evidence_expires_on < scheduled_note_date → renewal evidence required (pending receipt only under partner policy). Restricted access like applicant_demographics; the rationale is the rights-and-remedies basis only.';

-- ───────────────────────────── occupancy_assessments (R7; SM_OCCUPANCY_REO_GATE) ─────────────────────────────
CREATE TABLE occupancy_assessments (
  assessment_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid NOT NULL REFERENCES applications(id),
  declared_occupancy       occupancy_type NOT NULL,
  signals                  jsonb NOT NULL DEFAULT '{}',                 -- distance km, residence retained/sold/rented, size/price downgrade, other rentals, insurance policy type, mailing address, credit-header addresses, rent-free letter, DU occupancy-modified message, prior misrepresentation
  risk_score               int NOT NULL CHECK (risk_score >= 0),
  conclusion               text NOT NULL CHECK (conclusion IN ('consistent', 'needs_explanation', 'inconsistent')),
  explanation_document_id  uuid REFERENCES documents(id),
  investigation_id         uuid,
  assessed_at              timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX occupancy_assessments_app_idx ON occupancy_assessments(application_id, assessed_at DESC);
CREATE TRIGGER occupancy_assessments_immutable BEFORE UPDATE OR DELETE ON occupancy_assessments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE occupancy_assessments IS '22.6 R7 (B2-1.1-01; Reverse Occupancy Scheme; Reverification of Occupancy, Oct 2025): weighted signals — distance > 100 km +3, retained residence with rent needed +3, smaller/cheaper purchase +2, ≥ 2 other rentals +2, rent-free letter +2, DU occupancy-modified +3, landlord/DP-3 policy +3, mailing address ≠ subject +2, reverse-occupancy pattern +3; ≥ 5 needs_explanation, ≥ 8 (or a contradiction) inconsistent → investigation. Never uses applicant_demographics.';

-- ───────────────────────────── reo_discovery_checks (R8) ─────────────────────────────
CREATE TABLE reo_discovery_checks (
  check_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id         uuid NOT NULL REFERENCES applications(id),
  borrower_id            uuid NOT NULL REFERENCES application_borrowers(id),
  sources                text[] NOT NULL,                                -- credit_mortgage_tradelines, mers_lookup, public_records_vendor, tax_assessor, prior_application_data, servicing_book, du_message
  findings               jsonb NOT NULL DEFAULT '[]',                    -- properties found vs declared
  undisclosed_count      int NOT NULL DEFAULT 0 CHECK (undisclosed_count >= 0),
  status                 text NOT NULL CHECK (status IN ('clear', 'discrepancy_open', 'resolved_added_to_reo', 'resolved_not_borrower')),
  evidence_document_ids  uuid[] NOT NULL DEFAULT '{}',
  checked_at             timestamptz NOT NULL,
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reo_discovery_checks_app_idx ON reo_discovery_checks(application_id, checked_at DESC);
CREATE TRIGGER reo_discovery_checks_immutable BEFORE UPDATE OR DELETE ON reo_discovery_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE reo_discovery_checks IS '22.6 R8 (B2-2-03 / B3-6-01 / A3-4-02): mortgage and HELOC tradelines, MERS MIN search (26.4 adapter), fraud-tool property search, assessor data, SM''s subserviced book and DU messages against the REO schedule; a discrepancy is resolved either by adding the property to application_reo (22.5 PITIA, 23.2 count, 22.4 reserves, 23.1 resubmission) or by documenting that it is not the borrower''s. A resolution is a new row.';

-- ───────────────────────────── non_arms_length_assessments (R9; FNMA_B2_1_3_01_NON_ARMS_LENGTH_GATE) ─────────────────────────────
CREATE TABLE non_arms_length_assessments (
  assessment_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id             uuid NOT NULL REFERENCES applications(id),
  relationship_kind          text NOT NULL CHECK (relationship_kind IN ('none', 'family', 'employer_employee', 'business_affiliation', 'agent_is_party', 'builder_relationship', 'landlord_tenant', 'other')),
  property_new_construction  boolean NOT NULL DEFAULT false,
  occupancy                  occupancy_type NOT NULL,
  eligible                   boolean NOT NULL,                            -- B2-1.3-01: new construction with a builder/developer/seller relationship → principal residence only
  value_acceptance_blocked   boolean NOT NULL DEFAULT false,              -- gift of equity → B4-1.4-10 ineligible for value acceptance (24.1 orders an appraisal)
  gift_of_equity_cents       bigint NOT NULL DEFAULT 0 CHECK (gift_of_equity_cents >= 0),
  documentation_required     text[] NOT NULL DEFAULT '{}',
  assessed_at                timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX non_arms_length_assessments_app_idx ON non_arms_length_assessments(application_id, assessed_at DESC);
CREATE TRIGGER non_arms_length_assessments_immutable BEFORE UPDATE OR DELETE ON non_arms_length_assessments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE non_arms_length_assessments IS '22.6 R9 (B2-1.3-01, 11/05/2025): relationship or business affiliation between seller and buyer — existing property eligible with standard documentation; newly constructed property with a builder/developer/seller relationship → principal residence only (second home / investment ineligible; never coach an occupancy change); gift of equity → 22.4 rules and value-acceptance block.';

-- ───────────────────────────── red_flag_events (R6; 16 CFR 681 program log; RED_FLAGS_681_RESPONSE_1BD) ─────────────────────────────
CREATE TABLE red_flag_events (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id),
  category        text NOT NULL CHECK (category IN ('cra_alert', 'address_discrepancy', 'suspicious_document', 'suspicious_pii', 'unusual_activity', 'notice_from_victim_or_le', 'vendor_alert', 'agent_observation')),
  red_flag_code   text NOT NULL,                                         -- ITPP Appendix A-style program catalog code
  detected_at     timestamptz NOT NULL,
  detected_by     text NOT NULL,                                         -- agent run / vendor / human
  response        text CHECK (response IS NULL OR response IN ('monitor', 'verify_identity', 'contact_consumer', 'decline_to_proceed', 'close_case_false_positive', 'escalate', 'notify_law_enforcement', 'no_action')),
  responded_at    timestamptz,
  response_hours  numeric(8,2),                                          -- ITPP annual report: response time per event
  sla_breached    boolean NOT NULL DEFAULT false,
  resolution      jsonb,
  sla_timer_id    uuid,
  case_id         uuid REFERENCES cases(id),                             -- cases{case_type='fraud'} when escalated
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX red_flag_events_app_idx ON red_flag_events(application_id, detected_at DESC);
CREATE INDEX red_flag_events_open_idx ON red_flag_events(detected_at) WHERE responded_at IS NULL;
-- Detection fields are written once; the response fields are filled once by the responding act (the event spine
-- carries red_flag.detected / red_flag.responded); rows are never deleted.
CREATE OR REPLACE FUNCTION red_flag_events_response_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.application_id <> OLD.application_id OR NEW.category <> OLD.category OR NEW.red_flag_code <> OLD.red_flag_code OR NEW.detected_at <> OLD.detected_at OR NEW.detected_by <> OLD.detected_by THEN
    RAISE EXCEPTION 'red_flag_events detection fields are immutable';
  END IF;
  IF OLD.responded_at IS NOT NULL AND (NEW.responded_at IS DISTINCT FROM OLD.responded_at OR NEW.response IS DISTINCT FROM OLD.response) THEN
    RAISE EXCEPTION 'red_flag_events response is recorded once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER red_flag_events_response_only BEFORE UPDATE ON red_flag_events FOR EACH ROW EXECUTE FUNCTION red_flag_events_response_only();
CREATE TRIGGER red_flag_events_no_delete BEFORE DELETE ON red_flag_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE red_flag_events IS '22.6 R6 (16 CFR 681.1(d)): the Identity Theft Prevention Program log — CRA alerts, address discrepancies, suspicious documents (22.1), suspicious PII (SSN not issued/deceased/issued before DOB), unusual activity, victim/law-enforcement/CRA notices, vendor alerts, agent observations; response within 1 business_days_creditor (RED_FLAGS_681_RESPONSE_1BD); the annual ITPP report summarizes events, responses and response times. Owned by 22.6; 28.4 (program owner) reads and updates the response fields.';

-- ───────────────────────────── fraud_investigations (R10; joins cases{case_type='fraud'}) ─────────────────────────────
CREATE TABLE fraud_investigations (
  investigation_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                       uuid NOT NULL REFERENCES cases(id),       -- cases.case_type = 'fraud'
  application_id                uuid NOT NULL REFERENCES applications(id),
  opened_at                     timestamptz NOT NULL,
  triggers                      uuid[] NOT NULL DEFAULT '{}',              -- red_flag_events, integrity checks, alerts
  hypotheses                    jsonb NOT NULL DEFAULT '[]',               -- identity theft, straw buyer, occupancy, income/asset fabrication, undisclosed IPC/silent second, appraisal collusion, elder/affinity fraud, money laundering
  evidence_document_ids         uuid[] NOT NULL DEFAULT '{}',
  status                        text NOT NULL DEFAULT 'opened' CHECK (status IN ('opened', 'evidence_gathering', 'concluded', 'handed_off', 'closed')),
  conclusion                    text CHECK (conclusion IS NULL OR conclusion IN ('no_basis', 'insufficient', 'reasonable_basis_misrepresentation', 'reasonable_basis_fraud', 'identity_theft_confirmed')),
  concluded_at                  timestamptz,
  sar_candidate                 boolean NOT NULL DEFAULT false,
  sar_detection_date            date,                                      -- = concluded_at date when sar_candidate (policy Q2: the review's conclusion is the "initial detection")
  fnma_self_report_candidate    boolean NOT NULL DEFAULT false,
  ofac_event                    boolean NOT NULL DEFAULT false,
  loan_disposition              text CHECK (loan_disposition IS NULL OR loan_disposition IN ('proceed', 'proceed_with_conditions', 'decline_via_o2_6', 'withdraw_by_borrower', 'cancel')),
  prepared_package_document_id  uuid REFERENCES documents(id),             -- for 28.4 (bsa_sar_5y; access list bsa_officer/officer/qc_officer/fraud-risk)
  reviewer_id                   text,
  extension_reason              text,                                      -- bsa_officer extension of SM_FRAUD_INVESTIGATION_10BD with a written reason
  created_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fraud_investigations_app_idx ON fraud_investigations(application_id, opened_at DESC);
CREATE INDEX fraud_investigations_case_idx ON fraud_investigations(case_id);
CREATE TRIGGER fraud_investigations_no_delete BEFORE DELETE ON fraud_investigations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE fraud_investigations IS '22.6 R10: opened on any high-severity trigger (investigation.opened arms SM_FRAUD_INVESTIGATION_10BD: +10 business_days_creditor); hypotheses tested and evidence gathered; concluded within 10 business days — sar_detection_date = concluded_at date when sar_candidate (the SAR "initial detection", 31 CFR 1029.320(b)(3)); fnma_self_report_candidate → A3-4-03 (28.4); the loan disposition goes to 21.6 with underwriting_reviewer approval and never names the SAR. One row per investigation over the shared cases{case_type=fraud} row.';

-- ───────────────────────────── sar_candidates (R10/R11; 28.4 consumes and owns `sars`) ─────────────────────────────
CREATE TABLE sar_candidates (
  candidate_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id             uuid NOT NULL REFERENCES fraud_investigations(investigation_id),
  application_id               uuid NOT NULL REFERENCES applications(id),
  detection_date               date NOT NULL,                              -- = fraud_investigations.sar_detection_date
  subject_identified           boolean NOT NULL,
  amount_cents                 bigint NOT NULL CHECK (amount_cents >= 0),  -- the transaction amount (loan amount or the funds involved); SAR required when ≥ $5,000 and a category applies
  category                     text NOT NULL CHECK (category IN ('funds_from_illegal_activity', 'evade_bsa_requirements', 'no_apparent_lawful_purpose', 'facilitate_criminal_activity')),  -- §1029.320(a)(2)(i)–(iv)
  filing_due_on                date NOT NULL,                              -- detection_date + 30 calendar days (28.4's BSA_1029_320_SAR_30)
  outer_limit_on               date NOT NULL,                              -- detection_date + 60 calendar days when no subject is identified ("in no case" beyond)
  narrative_draft_document_id  uuid REFERENCES documents(id),              -- restricted; never in borrower-visible stores
  status                       text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'sent_to_bsa_officer', 'filed', 'declined_by_bsa_officer')),
  sent_at                      timestamptz,
  access_roles                 text[] NOT NULL DEFAULT '{bsa_officer,officer,qc_officer}',   -- plus the fraud-risk agent; R11 confidentiality guardrail
  retention_class              text NOT NULL DEFAULT 'bsa_sar_5y' CHECK (retention_class = 'bsa_sar_5y'),
  created_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sar_candidates_investigation_idx ON sar_candidates(investigation_id);
CREATE TRIGGER sar_candidates_no_delete BEFORE DELETE ON sar_candidates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE sar_candidates IS '22.6 R10/R11 (31 CFR 1029.320): the package the fraud-risk agent prepares for the partner''s bsa_officer (sar.candidate.prepared within SM_SAR_PACKAGE_5BD of the detection date) — category, amount, subject, narrative draft and exhibits; 28.4 decides and files (sars) within 30 calendar days of detection (60 without a subject). Confidential: never disclosed outside the access list; no borrower-facing artifact references it.';

COMMIT;
