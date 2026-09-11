-- 0080: §22.3 income and employment verification — the four tables the spec's data model adds beside the baseline
-- `application_income` (0057, versioned per source; 22.3 writes the calculation columns into its `calculation` jsonb)
-- and `verifications` (22.1/23.x baseline). Employment and business verifications are the B3-3.1-04 evidence records
-- (append-only: a re-performed VVOE after a closing move is a new row); income calculations are versioned by
-- `superseded_by`; tax transcript requests follow the signed → ordered → received | no_record | rejected → expired
-- lifecycle with the IVES retention class (`irs_ives_2y`: audit logs and 4506-C copies two years from signing).
BEGIN;

-- ───────────────────────────── employment_verifications (VVOE records; B3-3.1-04) ─────────────────────────────
CREATE TABLE employment_verifications (
  vvoe_id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                   uuid NOT NULL REFERENCES applications(id),
  borrower_id                      uuid NOT NULL REFERENCES application_borrowers(id),
  income_ids                       uuid[] NOT NULL DEFAULT '{}',
  method                           text NOT NULL CHECK (method IN ('verbal_ai_voice', 'verbal_human', 'written_form_1005', 'employer_email', 'vendor_written', 'paystub_15bd', 'bank_statement_15bd', 'military_les_120', 'dmdc', 'du_validation')),
  employer_name                    text NOT NULL,
  employer_phone                   text,
  phone_source                     text CHECK (phone_source IS NULL OR phone_source IN ('directory_assistance', 'internet_listing', 'licensing_bureau', 'telephone_book', 'vendor_database')),
  phone_source_evidence_document_id uuid REFERENCES documents(id),
  contact_name                     text,                                    -- person who confirmed the employment for the lender
  contact_title                    text,
  verifier_identity                text NOT NULL,                           -- agent run id or human
  contacted_at                     timestamptz NOT NULL,
  employment_status                text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'on_leave', 'terminated', 'unknown')),
  start_date_confirmed             date,
  note_date_used                   date NOT NULL,
  window_start                     date NOT NULL,                           -- note_date_used − 10 business_days_creditor (15 for the document alternatives; 120 calendar days LES/DMDC)
  within_window                    boolean NOT NULL,
  recording_document_id            uuid REFERENCES documents(id),           -- AI voice recording where consented/permitted (jurisdiction_rules.call_recording_consent)
  transcript_document_id           uuid REFERENCES documents(id),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_verifications_verbal_record CHECK (method NOT IN ('verbal_ai_voice', 'verbal_human') OR (contact_name IS NOT NULL AND contact_title IS NOT NULL AND phone_source IS NOT NULL))
);
COMMENT ON TABLE employment_verifications IS '22.3 verbal/written/vendor/document VOE records per borrower (B3-3.1-04): independent phone source with evidence, contact and verifier names/titles, the note date used and the window computed on calendar creditor; append-only';
CREATE INDEX employment_verifications_app_idx ON employment_verifications(application_id, borrower_id);
CREATE TRIGGER employment_verifications_immutable BEFORE UPDATE OR DELETE ON employment_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── business_verifications (self-employment existence; B3-3.1-04, 120 calendar days) ─────────────────────────────
CREATE TABLE business_verifications (
  verification_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id         uuid NOT NULL REFERENCES applications(id),
  borrower_id            uuid NOT NULL REFERENCES application_borrowers(id),
  business_name          text NOT NULL,
  source                 text NOT NULL CHECK (source IN ('cpa_letter', 'regulatory_agency', 'licensing_bureau', 'phone_listing_and_address', 'secretary_of_state')),
  source_reference       text NOT NULL,
  verified_at            date NOT NULL,
  note_date_used         date NOT NULL,
  window_start           date NOT NULL,                                     -- note_date_used − 120 calendar days
  within_window          boolean NOT NULL,
  evidence_document_id   uuid REFERENCES documents(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE business_verifications IS '22.3 self-employment business-existence verifications (B3-3.1-04): third-party source and reference, verified date against the 120-calendar-day window before the note date; append-only';
CREATE INDEX business_verifications_app_idx ON business_verifications(application_id, borrower_id);
CREATE TRIGGER business_verifications_immutable BEFORE UPDATE OR DELETE ON business_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── income_calculations (versioned formula runs per application_income source) ─────────────────────────────
CREATE TABLE income_calculations (
  calc_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  income_id        uuid NOT NULL REFERENCES application_income(id),
  formula_version  text NOT NULL,                                           -- e.g. B3-3.3-02.variable_trending.v2026-03-04
  inputs           jsonb NOT NULL DEFAULT '{}',                             -- cents as strings
  steps            jsonb NOT NULL DEFAULT '[]',                             -- [{label, cents}] with the single half-up rounding at the final monthly figure
  result_cents     bigint NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  agent_run_id     uuid,
  superseded_by    uuid REFERENCES income_calculations(calc_id)
);
COMMENT ON TABLE income_calculations IS '22.3 income calculations: every run of a versioned formula for a source with its inputs, step-by-step arithmetic in cents and result; a re-run supersedes the prior row (superseded_by) rather than editing it';
CREATE INDEX income_calculations_income_idx ON income_calculations(income_id, computed_at);

-- ───────────────────────────── tax_transcript_requests (Form 4506-C / 8821 and IVES transcript orders) ─────────────────────────────
CREATE TABLE tax_transcript_requests (
  request_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                    uuid NOT NULL REFERENCES applications(id),
  borrower_id                       uuid NOT NULL REFERENCES application_borrowers(id),
  form                              text NOT NULL CHECK (form IN ('4506c', '8821')),
  signed_at                         timestamptz NOT NULL,
  signature_method                  text NOT NULL CHECK (signature_method IN ('esign_2fa', 'esign_kba', 'esign_sso', 'wet')),
  signature_audit_log_document_id   uuid REFERENCES documents(id),         -- IVES: an audit log of the entire electronic signing ceremony
  valid_until                       date NOT NULL,                           -- signed_at + 120 calendar days (B3-3.1-02)
  channel                           text CHECK (channel IS NULL OR channel IN ('ives_a2a', 'ives_webui', 'du_transcript_supplier')),
  participant_id_masked             text,
  transcript_types                  text[] NOT NULL DEFAULT '{return_1040}', -- return_1040 | wage_income
  tax_years                         int[] NOT NULL,
  ordered_at                        timestamptz,
  received_at                       timestamptz,
  status                            text NOT NULL DEFAULT 'signed' CHECK (status IN ('signed', 'ordered', 'received', 'no_record', 'rejected', 'expired')),
  fee_cents                         int NOT NULL DEFAULT 0 CHECK (fee_cents >= 0), -- 400 per transcript under IVES → third_party_costs
  discrepancy                       jsonb,
  retention_class                   text NOT NULL DEFAULT 'irs_ives_2y' CHECK (retention_class = 'irs_ives_2y'),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_transcript_requests_years CHECK (cardinality(tax_years) BETWEEN 1 AND 4),
  CONSTRAINT tax_transcript_requests_esign_log CHECK (signature_method = 'wet' OR signature_audit_log_document_id IS NOT NULL)
);
COMMENT ON TABLE tax_transcript_requests IS '22.3 Form 4506-C / 8821 authorizations (per qualifying borrower, valid 120 days from signature) and the IVES / DU-supplier transcript orders they back: channel, types, years, fee, IRS response and reconciled discrepancies; retained two years under irs_ives_2y';
CREATE INDEX tax_transcript_requests_app_idx ON tax_transcript_requests(application_id, borrower_id, status);

COMMIT;
