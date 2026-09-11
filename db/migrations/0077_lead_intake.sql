-- 0077_lead_intake.sql — §20.3 lead intake, identity, E-SIGN/TCPA consents and the pre-qualification interview
-- (spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-3-*.md "Data model"; addendum §3).
-- Owned here: leads, lead_interactions, prequalifications, credit_authorizations (22.2 references), plus the consent kind
-- `ai_disclosure_ack` and a `lead_id` key on the 7.4 `consents` table (E-SIGN / TCPA / disclosure-acknowledgement rows are
-- captured before a loan or an application exists). Not here (other owners, never duplicated): applications and its children
-- (0057), consents / parties / documents (0001), pricing_quotes (0074 — its bare `lead_id` is now keyed to `leads`), credit_reports
-- (0079 — the soft-pull report; `prequalifications.soft_pull_report_id` is a plain key because 0079 lands after this file in a fresh
-- database), hmda_records (0068 — never written for a prequalification: not a §1003.2(b)(2) preapproval program), verifications
-- (22.6; assurance_level is carried on the lead).
-- One id space: the lead becomes the application — `applications.id = leads.lead_id` at conversion (20.3 rule 5 / 21.1), so
-- pricing_quotes.lead_id, consents.lead_id and applications.id all name the same file. credit_authorizations are facts
-- (FCRA audit: the text hash and signature evidence are retained through lead expiry) and are append-only (0001's forbid_mutation).
BEGIN;

-- consents{kind=ai_disclosure_ack} (rule 1: the first-contact AI disclosure logged with version and timestamp).
ALTER TYPE consent_kind ADD VALUE IF NOT EXISTS 'ai_disclosure_ack';

-- ───────────────────────────── leads (PII) ─────────────────────────────
CREATE TABLE leads (
  lead_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),        -- = applications.id once converted
  partner_id                  uuid NOT NULL REFERENCES parties(id),
  channel                     text NOT NULL CHECK (channel IN ('refi_trigger', 'organic', 'referral')),   -- mirrors applications.channel
  source_touch_id             uuid,                                              -- 20.2 touch (its table lands in parallel)
  opportunity_id              uuid,                                              -- 20.1 refi_opportunities (lands in parallel)
  loan_id                     uuid REFERENCES loans(id),                         -- existing subserviced loan
  party_id                    uuid REFERENCES parties(id),                       -- existing borrower
  prospect                    jsonb,                                             -- {name, email, phone, state} (pii)
  consumer_state              char(2),
  property_state              char(2),
  property_address            text,                                              -- pii
  transaction_intent          text NOT NULL DEFAULT 'undecided' CHECK (transaction_intent IN ('refinance', 'purchase', 'undecided')),
  status                      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'disclosed', 'authenticated', 'exploring', 'prequal_requested', 'prequalified', 'terms_review', 'terms_presented', 'applying', 'converted', 'expired', 'closed_lost')),
  assurance_level             text NOT NULL DEFAULT 'L0_contact_unverified' CHECK (assurance_level IN ('L0_contact_unverified', 'L1_channel_otp', 'L2_account_authenticated', 'L3_document_biometric', 'L4_ssa_cbsv')),
  first_interaction_at        timestamptz,
  ai_disclosure_notice_id     uuid REFERENCES notices(id),
  ai_disclosure_version       text,
  co_admt_preuse_notice_id    uuid REFERENCES notices(id),
  esign_consent_id            uuid REFERENCES consents(id),
  tcpa_consent_ids            uuid[] NOT NULL DEFAULT '{}',
  credit_authorization_id     uuid,                                              -- credit_authorizations (created below; FK added after)
  prequal_id                  uuid,                                              -- prequalifications (FK added after)
  quote_ids                   text[] NOT NULL DEFAULT '{}',                      -- pricing_quotes.quote_id
  mlo_of_record_id            text,
  mlo_nmlsr_id                text,
  trid_items                  jsonb NOT NULL DEFAULT '{}',                       -- {name, income, ssn_for_credit, property_address, value_estimate, loan_amount_sought} → {present, source ∈ consumer_stated|on_file_confirmed|derived_not_counted, at}
  application_id              uuid REFERENCES applications(id),                  -- = lead_id after conversion
  regb_application_at         timestamptz,                                       -- Reg B receipt (the consumer's request, or an earlier communicated evaluation)
  trid_application_at         timestamptz,                                       -- max(at) of the six items
  last_activity_at            timestamptz NOT NULL,
  expires_at                  date NOT NULL,                                     -- last_activity + 90 calendar days (SM_LEAD_INACTIVITY_EXPIRY_90)
  closed_reason               text,
  retention_class             text NOT NULL DEFAULT 'sm_lead_36m' CHECK (retention_class IN ('sm_lead_36m', 'regb_25m')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (channel <> 'refi_trigger' OR loan_id IS NOT NULL),
  CHECK (application_id IS NULL OR application_id = lead_id)
);
COMMENT ON TABLE leads IS '20.3 data model: one row per lead (a 20.2 response, an organic inquiry, a referral or a subserviced borrower''s request); the state machine new → disclosed → authenticated → exploring → prequal_requested → prequalified → terms_review → terms_presented → applying → converted | expired | closed_lost; trid_items is the six-item detector''s evidence (TRID anchor proof for 21.2); the lead id is the application id it becomes.';
COMMENT ON COLUMN leads.prospect IS 'pii';
COMMENT ON COLUMN leads.property_address IS 'pii';
COMMENT ON COLUMN leads.trid_items IS '20.3 rule 5: each item {present, source, at}; derived_not_counted never counts; trid_application_at = max(at) once all six are present';
CREATE INDEX leads_partner_status_idx ON leads(partner_id, status);
CREATE INDEX leads_party_idx ON leads(party_id) WHERE party_id IS NOT NULL;
CREATE INDEX leads_loan_idx ON leads(loan_id) WHERE loan_id IS NOT NULL;
CREATE INDEX leads_expires_idx ON leads(expires_at) WHERE status NOT IN ('converted', 'expired', 'closed_lost');

-- ───────────────────────────── lead_interactions (AI conversation sessions with disclosure evidence) ─────────────────────────────
CREATE TABLE lead_interactions (
  interaction_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                     uuid NOT NULL REFERENCES leads(lead_id),
  channel                     text NOT NULL CHECK (channel IN ('web_chat', 'voice_inbound', 'voice_outbound', 'sms', 'portal', 'email', 'human_call')),
  started_at                  timestamptz NOT NULL,
  ended_at                    timestamptz,
  ai                          boolean NOT NULL DEFAULT true,
  disclosure_delivered_at     timestamptz,                                       -- SM_AI_INTERACTION_DISCLOSURE_GATE evidence
  disclosure_version          text,
  human_transfer_requested_at timestamptz,
  human_agent_id              uuid REFERENCES personnel(id),
  transcript_id               uuid REFERENCES documents(id),
  recording_id                uuid REFERENCES documents(id),
  state_rules_applied         text[] NOT NULL DEFAULT '{}',                      -- UT/CA/CO overlays applied (jurisdiction_rules.ai_disclosure_rule)
  agent_run_id                text,
  retention_class             text NOT NULL DEFAULT 'tcpa_consent_4y',           -- transcripts/recordings: TCPA/consent 4 years min; MAP 24 months for scripts
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (NOT ai OR disclosure_delivered_at IS NULL OR disclosure_delivered_at >= started_at)
);
COMMENT ON TABLE lead_interactions IS '20.3 data model: every conversation on a lead (channel, AI or human, disclosure delivered/version, human transfer, transcript/recording, state rules applied, agent run) — the per-channel disclosure evidence the audit section requires.';
CREATE INDEX lead_interactions_lead_idx ON lead_interactions(lead_id, started_at);

-- ───────────────────────────── credit_authorizations (FCRA §604(a)(3)(A); 22.2 references; append-only) ─────────────────────────────
CREATE TABLE credit_authorizations (
  authorization_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                     uuid REFERENCES leads(lead_id),
  application_id              uuid REFERENCES applications(id),
  kind                        text NOT NULL CHECK (kind IN ('soft_prequal', 'hard_application')),
  party_id                    uuid REFERENCES parties(id),
  text_version                text NOT NULL,                                     -- counsel-approved authorization language version
  text_version_hash           text NOT NULL,                                     -- retained through lead expiry (FCRA audit)
  signature_kind              text NOT NULL CHECK (signature_kind IN ('esign_click_typed_name', 'wet_ink')),
  captured_at                 timestamptz NOT NULL,
  channel                     text NOT NULL CHECK (channel IN ('web_chat', 'voice_inbound', 'voice_outbound', 'sms', 'portal', 'email', 'human_call')),
  evidence                    jsonb NOT NULL DEFAULT '{}',                       -- {ip, user_agent, session_id}
  permissible_purpose         text NOT NULL DEFAULT 'consumer_initiated_credit_transaction_1681b_a3A' CHECK (permissible_purpose IN ('consumer_initiated_credit_transaction_1681b_a3A', 'account_review_1681b_a3A')),
  end_user                    text NOT NULL DEFAULT 'partner' CHECK (end_user = 'partner'),   -- the creditor is the FCRA end user
  consumer_initiated          boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (lead_id IS NOT NULL OR application_id IS NOT NULL)
);
COMMENT ON TABLE credit_authorizations IS '20.3 data model (22.2 references): the consumer''s soft-prequal / hard-application credit authorization with text hash, signature evidence, permissible purpose and end_user=partner — the FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE evidence; a soft-pull authorization is the TRID "SSN to obtain a credit report" item (open question 1 default); append-only.';
CREATE INDEX credit_authorizations_lead_idx ON credit_authorizations(lead_id, kind);
CREATE INDEX credit_authorizations_application_idx ON credit_authorizations(application_id) WHERE application_id IS NOT NULL;
CREATE TRIGGER credit_authorizations_immutable BEFORE UPDATE OR DELETE ON credit_authorizations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── prequalifications ─────────────────────────────
CREATE TABLE prequalifications (
  prequal_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                     uuid NOT NULL REFERENCES leads(lead_id),
  requested_at                timestamptz NOT NULL,
  basis                       text NOT NULL CHECK (basis IN ('consumer_stated_only', 'soft_pull')),
  soft_pull_report_id         uuid,                                              -- credit_reports (0079; report_type soft_prequal) — deleted at lead expiry absent an application (rule 9)
  estimated_representative_score integer CHECK (estimated_representative_score IS NULL OR estimated_representative_score BETWEEN 300 AND 850),
  score_source                text,
  stated_income_cents         bigint,                                            -- only when the consumer volunteers it in a purchase prequal (rule 5)
  stated_assets_cents         bigint,
  value_estimate_cents        bigint,
  loan_amount_range_cents     int8range,
  ltv_estimate                numeric(6,3),
  program_fit                 jsonb NOT NULL DEFAULT '{}',                       -- criteria met/not met — informational
  quote_id                    text REFERENCES pricing_quotes(quote_id),
  outcome                     text CHECK (outcome IS NULL OR outcome IN ('information_provided', 'letter_issued', 'converted_to_application', 'abandoned')),
  letter_document_id          uuid REFERENCES documents(id),
  retention_class             text NOT NULL DEFAULT 'sm_lead_36m' CHECK (retention_class IN ('regb_25m', 'sm_lead_36m')),   -- regb_25m if an application follows
  regb_decline_risk_flag      boolean NOT NULL DEFAULT false,                    -- true if any generated text was classified as a delivered decline — must stay false
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE prequalifications IS '20.3 data model: the prequalification request (basis, soft report link, stated figures, LTV estimate, program fit, quote, outcome, letter) — never a Reg C §1003.2(b)(2) preapproval (no hmda_records row); regb_decline_risk_flag is the Reg B classifier evidence.';
CREATE INDEX prequalifications_lead_idx ON prequalifications(lead_id, requested_at);

ALTER TABLE leads ADD CONSTRAINT leads_credit_authorization_fk FOREIGN KEY (credit_authorization_id) REFERENCES credit_authorizations(authorization_id);
ALTER TABLE leads ADD CONSTRAINT leads_prequal_fk FOREIGN KEY (prequal_id) REFERENCES prequalifications(prequal_id);

-- ───────────────────────────── consents (7.4 table; 20.3 keys lead-stage rows to the lead) ─────────────────────────────
ALTER TABLE consents ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES leads(lead_id);
ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_keyed;
ALTER TABLE consents ADD CONSTRAINT consents_keyed CHECK (loan_id IS NOT NULL OR application_id IS NOT NULL OR lead_id IS NOT NULL);
COMMENT ON COLUMN consents.lead_id IS '20.3: consents captured before an application exists (esign with scope origination_disclosures / origination_esign_signatures, tcpa_voice / tcpa_sms informational, ai_disclosure_ack) — the lead id is the application id it becomes';
CREATE INDEX IF NOT EXISTS consents_lead_kind_idx ON consents(lead_id, kind) WHERE lead_id IS NOT NULL;

-- pricing_quotes.lead_id (0074: "no FK: that migration lands in parallel") — the same id space now that leads exists.
ALTER TABLE pricing_quotes ADD CONSTRAINT pricing_quotes_lead_fk FOREIGN KEY (lead_id) REFERENCES leads(lead_id);

COMMIT;
