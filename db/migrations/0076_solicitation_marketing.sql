-- 0076_solicitation_marketing.sql — §20.2 solicitation, marketing and consent compliance
-- (spec/sections/20-refinance-triggers-solicitation-lead-intake-and-pricing/20-2-*.md; addendum §4 "one product, one id grammar").
-- 20.2's own tables (`marketing_campaigns`, `marketing_creatives` — the 24-month MAP archive, `marketing_touches` — the per-touch
-- log with its legal basis, `dnc_scrubs`, `marketing_suppressions`) and the marketing columns the spec adds to the servicing
-- `consents` table (7.4; 0001/0009/0057): purpose, written_consent, pewc_elements, signature_kind, disclosure_text_hash,
-- written_confirmation_due_at, national_dnc_written_permission. Kinds reused (tcpa_voice / tcpa_sms with purpose=marketing) — no
-- new consent_kind values. `phone_numbers` (11.1, 0013) and `contacts` (0005) are referenced, never redefined; `rate_sheets` is
-- 0074's; `lead_id` / `opportunity_id` / `program_id` are plain keys (20.3's `leads` and 20.1's opportunity tables land in parallel).
-- Additive only. Touch, scrub and suppression lifecycles are also recorded in `loan_events` (marketing.touch.*, dnc.scrub.completed,
-- marketing.suppression.*); `dnc_scrubs` and `marketing_suppressions` are append-only (forbid_mutation, 0001).
BEGIN;

-- ───────────────────────────── consents (7.4; columns added here — data model) ─────────────────────────────
ALTER TABLE consents ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'informational' CHECK (purpose IN ('informational', 'marketing'));
ALTER TABLE consents ADD COLUMN IF NOT EXISTS written_consent boolean NOT NULL DEFAULT false;
ALTER TABLE consents ADD COLUMN IF NOT EXISTS pewc_elements jsonb;                              -- {authorizes_atds_or_artificial_voice, not_condition_of_purchase, seller_named, caller_on_behalf='Supermortgage', phone_number_as_entered}
ALTER TABLE consents ADD COLUMN IF NOT EXISTS signature_kind text CHECK (signature_kind IN ('esign_click_typed_name', 'checkbox_with_text', 'sms_keyword_double_optin', 'wet_ink', 'voice_recording_interim'));
ALTER TABLE consents ADD COLUMN IF NOT EXISTS disclosure_text_hash text;
ALTER TABLE consents ADD COLUMN IF NOT EXISTS written_confirmation_due_at timestamptz;          -- voice_recording_interim: captured_at + 24 h
ALTER TABLE consents ADD COLUMN IF NOT EXISTS national_dnc_written_permission boolean NOT NULL DEFAULT false;
-- 7.4 machine + 20.2 state machine: `pending_written_confirmation` for voice_recording_interim → active on written confirmation within 24 h, else expired.
ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_status_check;
ALTER TABLE consents ADD CONSTRAINT consents_status_check CHECK (status IN ('pending_verification', 'pending_written_confirmation', 'active', 'suspect', 'withdrawn', 'expired', 'superseded'));
ALTER TABLE consents ADD CONSTRAINT consents_pewc_written CHECK (purpose <> 'marketing' OR written_consent = false OR (pewc_elements IS NOT NULL AND signature_kind IS NOT NULL AND signature_kind <> 'voice_recording_interim'));
COMMENT ON COLUMN consents.purpose IS '20.2 data model: informational (11.1 servicing calls) or marketing (PEWC for AI-voice/SMS marketing; 47 CFR 64.1200(a)(2), (f)(9))';
COMMENT ON COLUMN consents.pewc_elements IS '20.2 rule 3: both (f)(9) disclosures, the partner named as seller, Supermortgage as caller on its behalf, the number as entered';
COMMENT ON COLUMN consents.national_dnc_written_permission IS '20.2: the signed written agreement naming the seller and the number satisfies 47 CFR 64.1200(c)(2)(ii) / TSR §310.4(b)(1)(iii)(B)(1) when the number is on the registry';

-- ───────────────────────────── campaigns ─────────────────────────────
CREATE TABLE marketing_campaigns (
  campaign_id               text PRIMARY KEY,
  partner_id                uuid REFERENCES parties(id),
  program_id                text,                                                 -- 20.1 program
  kind                      text NOT NULL CHECK (kind IN ('refi_trigger_outbound', 'organic_nurture', 'general_advertising', 'prescreen')),
  channels                  text[] NOT NULL CHECK (channels <@ ARRAY['email', 'portal', 'mail', 'sms', 'ai_voice', 'human_voice']::text[] AND cardinality(channels) >= 1),
  selection_rule_set        text NOT NULL,                                        -- investor-blind; references the 20.1 rule set
  creative_ids              text[] NOT NULL DEFAULT '{}',
  approved_by               text,                                                 -- partner officer / delegated compliance reviewer
  approved_at               timestamptz,
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'live', 'paused', 'ended')),
  started_at                timestamptz,
  ended_at                  timestamptz,
  map_rule_archive_until    date,                                                 -- last dissemination + 24 months (12 CFR 1014.5)
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved', 'live', 'paused', 'ended') OR approved_at IS NOT NULL),
  CHECK (selection_rule_set NOT ILIKE '%investor%')
);
COMMENT ON TABLE marketing_campaigns IS '20.2 data model: one row per campaign (refi_trigger_outbound / organic_nurture / general_advertising / prescreen — flag-gated); draft → approved (partner compliance) → live → paused | ended; campaign.ended anchors REGN_1014_5_RECORDS_24M.';
CREATE INDEX marketing_campaigns_partner_status_idx ON marketing_campaigns(partner_id, status);

-- ───────────────────────────── creatives (retention regn_1014_5_24m) ─────────────────────────────
CREATE TABLE marketing_creatives (
  creative_id               text PRIMARY KEY,
  campaign_id               text NOT NULL REFERENCES marketing_campaigns(campaign_id),
  channel                   text NOT NULL CHECK (channel IN ('email', 'portal', 'mail', 'sms', 'ai_voice', 'human_voice')),
  template_code             text NOT NULL REFERENCES notice_templates(code),      -- Notice Registry
  template_version          text NOT NULL,
  content_hash              text,                                                 -- sha256 of the rendered variant
  rate_sheet_id             text REFERENCES rate_sheets(rate_sheet_id),           -- rate-bearing creatives; stale → suppressed
  variables_schema          text[] NOT NULL DEFAULT '{}',                         -- never an investor variable (B2-1.3-04)
  checklists                jsonb,                                                -- {regz_1026_24, map_1014_3, state, fnma_b2_1_3_04, tcpa_b, canspam}
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  approved_by               text,
  approved_at               timestamptz,
  superseded_by             text,
  prompt_version            text,                                                 -- AI voice/chat scripts (MAP Rule "sales scripts")
  rendered_text             text,
  disseminated_from         date,
  disseminated_to           date,
  archive_document_id       uuid REFERENCES documents(id),                        -- the MAP archive bundle (variants, prompt, product list)
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND checklists IS NOT NULL)),
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL),
  CHECK (NOT (variables_schema::text ILIKE '%investor%' OR variables_schema::text ILIKE '%fnma%' OR variables_schema::text ILIKE '%pool%' OR variables_schema::text ILIKE '%mbs%'))
);
COMMENT ON TABLE marketing_creatives IS '20.2 data model: every creative with its compliance checklists and content hash; retention regn_1014_5_24m — creative.superseded anchors REGN_1014_5_RECORDS_24M at last dissemination + 24 months.';
COMMENT ON COLUMN marketing_creatives.rendered_text IS 'pii';
CREATE INDEX marketing_creatives_campaign_idx ON marketing_creatives(campaign_id, channel, status);

-- ───────────────────────────── touches (per-touch log with the legal basis) ─────────────────────────────
CREATE TABLE marketing_touches (
  touch_id                  text PRIMARY KEY,
  campaign_id               text NOT NULL REFERENCES marketing_campaigns(campaign_id),
  creative_id               text REFERENCES marketing_creatives(creative_id),
  party_id                  uuid REFERENCES parties(id),
  loan_id                   uuid REFERENCES loans(id),
  lead_id                   uuid,                                                 -- 20.3 leads
  opportunity_id            uuid,                                                 -- 20.1 opportunity
  channel                   text NOT NULL CHECK (channel IN ('email', 'portal', 'mail', 'sms', 'ai_voice', 'human_voice')),
  destination_kind          text CHECK (destination_kind IN ('phone_number', 'email', 'address', 'portal')),
  destination_id            uuid,                                                 -- phone_numbers.id / delivery_addresses.id / address id
  queued_at                 timestamptz NOT NULL,
  scheduled_for             timestamptz,                                          -- called-party local window
  scheduled_tz              text,
  sent_at                   timestamptz,
  outcome                   text NOT NULL DEFAULT 'queued' CHECK (outcome IN ('queued', 'scheduled', 'suppressed', 'sent', 'delivered', 'bounced', 'answered_ai', 'answered_human', 'voicemail_no_message', 'opted_out', 'replied')),
  legal_basis               jsonb,                                                -- {tcpa:{required, consent_id, line_type}, dnc:{national_hit, ebr_basis, scrub_id, company_dnc_hit}, quiet_hours:{local_time, tz, window}, canspam:{optout_state}, state:{rules_applied[]}}
  gates                     jsonb NOT NULL DEFAULT '[]',                          -- [{code, result, basis}]
  suppression_reason        text,
  agent_decision_id         uuid REFERENCES agent_decisions(id),
  call_recording_id         text,
  transcript_id             text,
  notice_id                 uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome <> 'suppressed' OR suppression_reason IS NOT NULL),
  CHECK (outcome NOT IN ('sent', 'delivered', 'bounced', 'answered_ai', 'answered_human', 'voicemail_no_message', 'opted_out', 'replied') OR sent_at IS NOT NULL)
);
COMMENT ON TABLE marketing_touches IS '20.2 data model: one row per outbound touch — queued → suppressed | scheduled → sent → delivered/answered_ai/answered_human/voicemail_no_message/bounced/opted_out/replied — with the gate results and legal basis (consent id, EBR basis, scrub id, local time/tz) the audit reproduces for a TCPA demand letter.';
CREATE INDEX marketing_touches_party_idx ON marketing_touches(party_id, queued_at DESC);
CREATE INDEX marketing_touches_campaign_idx ON marketing_touches(campaign_id, outcome);
CREATE INDEX marketing_touches_opportunity_idx ON marketing_touches(opportunity_id) WHERE opportunity_id IS NOT NULL;

-- ───────────────────────────── DNC scrubs (TCPA_64_1200_C2_DNC_SCRUB_31; append-only) ─────────────────────────────
CREATE TABLE dnc_scrubs (
  scrub_id                  text PRIMARY KEY,
  source                    text NOT NULL DEFAULT 'ftc_registry' CHECK (source IN ('ftc_registry', 'state_registry')),
  registry_version_obtained_at timestamptz NOT NULL,
  obtained_on               date NOT NULL,
  valid_until               date NOT NULL,                                        -- obtained_on + 31 calendar days
  numbers_checked           integer NOT NULL CHECK (numbers_checked >= 0),
  hits                      integer NOT NULL CHECK (hits >= 0 AND hits <= numbers_checked),
  file_hash                 text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until = obtained_on + 31)
);
COMMENT ON TABLE dnc_scrubs IS '20.2 data model: each national/state do-not-call registry version obtained (47 CFR 64.1200(c)(2)(i)(D), TSR §310.4(b)(3)(iv): no more than 31 days old); telephone solicitations stop at 00:00 after valid_until until the next version (worked example 3).';
CREATE INDEX dnc_scrubs_valid_idx ON dnc_scrubs(source, valid_until DESC);
CREATE TRIGGER dnc_scrubs_immutable BEFORE UPDATE OR DELETE ON dnc_scrubs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────────── suppressions (company DNC 5 years; opt-outs indefinite; append-only) ─────────────────────────────
CREATE TABLE marketing_suppressions (
  suppression_id            text PRIMARY KEY,
  party_id                  uuid REFERENCES parties(id),
  phone_number_id           uuid REFERENCES phone_numbers(id),
  email_id                  uuid REFERENCES delivery_addresses(id),
  address_id                uuid,
  kind                      text NOT NULL CHECK (kind IN ('company_dnc', 'email_optout', 'sms_optout', 'mail_optout', 'all_marketing')),
  requested_at              timestamptz NOT NULL,
  requested_on              date NOT NULL,
  channel_received          text NOT NULL,                                        -- sms / email / voice / portal / letter
  honor_until               date,                                                 -- company_dnc: requested_on + 5 years; others null (indefinite)
  processed_at              timestamptz NOT NULL,                                 -- policy: immediate at commit; legal ceiling +10 business days
  legal_due_on              date NOT NULL,
  source_touch_id           text REFERENCES marketing_touches(touch_id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (party_id IS NOT NULL OR phone_number_id IS NOT NULL OR email_id IS NOT NULL OR address_id IS NOT NULL),
  CHECK ((kind = 'company_dnc') = (honor_until IS NOT NULL)),
  CHECK (kind <> 'company_dnc' OR honor_until = (requested_on + INTERVAL '5 years')::date),
  CHECK (processed_at >= requested_at)
);
COMMENT ON TABLE marketing_suppressions IS '20.2 data model: the consumer''s do-not-call / opt-out requests as recorded — company_dnc honored 5 years (47 CFR 64.1200(d)(6); terminates the EBR), email_optout (15 U.S.C. 7704(a)(4)), sms_optout (11.1 STOP), mail_optout, all_marketing; marketing.suppression.requested/recorded satisfy the 10-business-day ceilings.';
CREATE INDEX marketing_suppressions_party_idx ON marketing_suppressions(party_id, kind);
CREATE INDEX marketing_suppressions_phone_idx ON marketing_suppressions(phone_number_id) WHERE phone_number_id IS NOT NULL;
CREATE INDEX marketing_suppressions_email_idx ON marketing_suppressions(email_id) WHERE email_id IS NOT NULL;
CREATE TRIGGER marketing_suppressions_immutable BEFORE UPDATE OR DELETE ON marketing_suppressions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
