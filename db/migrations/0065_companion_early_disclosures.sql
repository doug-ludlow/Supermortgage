-- 0065_companion_early_disclosures.sql — §21.3 Companion early disclosures: homeownership counseling list, Your Home Loan
-- Toolkit, AfBA, Reg B appraisal notice, FCRA/Reg V credit-score notices, ARM program disclosure and CHARM booklet, GLBA
-- initial privacy notice, the retired RESPA Servicing Disclosure Statement, and state early disclosures
-- (spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-3-*.md "Data model").
-- Additive only: `disclosures` is 0064's (21.2) — the companion kinds it already enumerates (sds, hcl, toolkit, afba,
-- regb_appraisal_notice, credit_score_notice, rbp_notice, arm_program, charm, privacy, state:XX) gain the columns the 21.3
-- data model names; `applications`/`application_borrowers` are 0057's; `parties`, `documents`, `consents` are 0001's.
-- The six tables the 21.3 data model owns are created here. `jurisdiction_rules.early_disclosures` lives in the shared
-- 0002 `jurisdiction_rules.rules` jsonb (31.1 maintains; 21.3 executes) — no new table.
BEGIN;

-- Retention classes the 21.3 data model names ("Retention class per row").
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regb_25m';          -- Reg B appraisal notice, score notices (policy)
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'respa_afba_5y';     -- §1024.15(d): 5 years after execution
ALTER TYPE retention_class ADD VALUE IF NOT EXISTS 'regz_general_2y';   -- §1026.25(a): two years after the date disclosures are required to be made

-- ---------------------------------------------------------------- disclosures: columns added for the companion kinds
ALTER TABLE disclosures
  ADD COLUMN application_borrower_id      uuid REFERENCES application_borrowers(id),   -- per-applicant notices (score notices, state acknowledgments); null = joint/application-level
  ADD COLUMN rule_code                    text,                                        -- REGX_1024_20, REGZ_1026_19G, REGB_1002_14A2, FCRA_609G, REGV_1022_74D, REGZ_1026_19B, GLBA_1016_4, REGX_1024_15, REGZ_1026_35C5, NY_3NYCRR_38_3, …
  ADD COLUMN anchor_event                 text,
  ADD COLUMN anchor_at                    timestamptz,
  ADD COLUMN due_at                       timestamptz,
  ADD COLUMN calendar_code                text,                                        -- 'creditor'
  ADD COLUMN required                     boolean,                                     -- false when an exemption applies
  ADD COLUMN asset_version                text,                                        -- Toolkit '2026-08', CHARM '2020-06', privacy edition, TX SML form, CA DFPI translation
  ADD COLUMN language_edition             text CHECK (language_edition IS NULL OR language_edition IN ('en', 'es', 'zh', 'ko', 'tl', 'vi')),
  ADD COLUMN acknowledgment_required      boolean NOT NULL DEFAULT false,
  ADD COLUMN acknowledged_at              timestamptz,
  ADD COLUMN acknowledgment_evidence_id   uuid REFERENCES documents(id),
  ADD COLUMN generated_at                 timestamptz,                                 -- counseling list
  ADD COLUMN data_snapshot_id             text,                                        -- counseling list HUD snapshot; ARM illustration inputs
  ADD CONSTRAINT disclosures_exemption_reason_known CHECK (exemption_reason IS NULL OR exemption_reason IN ('refinance_no_toolkit', 'reverse_only', 'no_affiliate_referral', 'fixed_rate', 'not_hpml', 'state_not_applicable', 'provided_by_other_person', 'no_score')),
  ADD CONSTRAINT disclosures_exempt_needs_reason CHECK (status <> 'exempt' OR exemption_reason IS NOT NULL);
COMMENT ON COLUMN disclosures.rule_code IS '21.3: the rule the companion row executes; required=false rows carry exemption_reason; satisfied_by_disclosure_id points at the LE that carries the Reg B / HPML appraisal statement.';

-- ---------------------------------------------------------------- counseling_lists (rule 3; §1024.20(a)(1); 80 FR 22091)
CREATE TABLE counseling_lists (
  list_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                 uuid NOT NULL REFERENCES applications(id),
  application_borrower_id        uuid REFERENCES application_borrowers(id),        -- the applicant whose zip generated the list (primary; a co-applicant with a different zip gets a second list)
  zip_used                       char(5) NOT NULL,
  zip_source                     text NOT NULL CHECK (zip_source IN ('current_address', 'mailing_address', 'property_address_overseas')),
  centroid_lat                   numeric(9,6),
  centroid_long                  numeric(9,6),
  hud_snapshot_at                timestamptz NOT NULL,                              -- moment the HUD data was obtained; must be <= 30 calendar days before delivery
  agencies                       jsonb NOT NULL,                                    -- exactly 10 entries with the eleven data fields, sorted by distance from the centroid
  accompanying_language_version  text NOT NULL,                                     -- the 2015 interpretive rule text, verbatim
  rendered_document_id           uuid REFERENCES documents(id),
  disclosure_id                  uuid REFERENCES disclosures(id),
  superseded_by_list_id          uuid REFERENCES counseling_lists(list_id),        -- regenerated after an address change or a stale snapshot
  generated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counseling_lists_ten_agencies CHECK (jsonb_typeof(agencies) = 'array' AND jsonb_array_length(agencies) = 10)
);
COMMENT ON TABLE counseling_lists IS '21.3 rule 3: the generated §1024.20 list — ten closest HUD-approved agencies to the centroid of the applicant''s current-address zip (property zip only when the current address has no five-digit zip), eleven data fields, accompanying language verbatim; hud_snapshot_at is the "obtained" time for the 30-day rule.';
CREATE INDEX counseling_lists_application_idx ON counseling_lists(application_id);

-- ---------------------------------------------------------------- affiliate_relationships (rule 8; RESPA §3(7)–(8); §1024.15)
CREATE TABLE affiliate_relationships (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_party_id                 uuid NOT NULL REFERENCES parties(id),             -- partner or SM (or an associate of either)
  provider_party_id              uuid NOT NULL REFERENCES parties(id),
  relationship                   text NOT NULL CHECK (relationship IN ('affiliate', 'ownership_gt_1pct', 'associate')),
  ownership_pct                  numeric(5,2) CHECK (ownership_pct IS NULL OR (ownership_pct >= 0 AND ownership_pct <= 100)),
  services                       text[] NOT NULL DEFAULT '{}',
  appendix_d_statement_document_id uuid REFERENCES documents(id),
  charge_range                   jsonb NOT NULL DEFAULT '{}',                       -- {service: {low_cents, high_cents}} or a single estimate
  effective_from                 date NOT NULL,
  effective_to                   date,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_relationships_pct_when_ownership CHECK (relationship <> 'ownership_gt_1pct' OR ownership_pct > 1)
);
COMMENT ON TABLE affiliate_relationships IS '21.3 rule 8: the partner''s and SM''s AfBA inventory — every settlement-service provider in which the owner or an associate holds an affiliate relationship or > 1 % ownership (12 U.S.C. 2602(7)–(8)); default inventory none (open question 4).';
CREATE INDEX affiliate_relationships_provider_idx ON affiliate_relationships(provider_party_id, effective_from);

-- ---------------------------------------------------------------- referrals (rule 8; §1024.14(f); §1024.15(b))
CREATE TABLE referrals (
  referral_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                 uuid NOT NULL REFERENCES applications(id),
  referring_party_id             uuid NOT NULL REFERENCES parties(id),
  provider_party_id              uuid NOT NULL REFERENCES parties(id),
  service                        text NOT NULL,
  referred_at                    timestamptz NOT NULL,
  required_use                   boolean NOT NULL DEFAULT false,                    -- true only for attorney / credit_reporting_agency / appraiser (§1024.15(b)(2))
  afba_required                  boolean NOT NULL,
  afba_disclosure_id             uuid REFERENCES disclosures(id),
  source_process                 text NOT NULL,                                     -- 21.2 / 24.1 / 24.4 / 24.5 / 24.6
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referrals_required_use_exceptions CHECK (required_use = false OR service IN ('attorney', 'credit_reporting_agency', 'appraiser'))
);
COMMENT ON TABLE referrals IS '21.3 rule 8: the referral log — every step that names or selects a settlement-service provider; afba_required when affiliate_relationships matches the referring party; required use only for the three §1024.15(b)(2) exceptions.';
CREATE INDEX referrals_application_idx ON referrals(application_id, referred_at);
CREATE TRIGGER referrals_immutable BEFORE UPDATE OR DELETE ON referrals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- arm_programs (rule 7; §1026.19(b)(2); Fannie Mae Standard ARM Plan Matrix)
CREATE TABLE arm_programs (
  program_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fnma_plan_number               text NOT NULL CHECK (fnma_plan_number IN ('4926', '4927', '4928', '4929')),
  label                          text NOT NULL,                                     -- 3/6, 5/6, 7/6, 10/6 SOFR
  index                          text NOT NULL DEFAULT 'sofr_30d_avg' CHECK (index = 'sofr_30d_avg'),
  index_source_text              text NOT NULL,                                     -- "30-day Average SOFR as published by the Federal Reserve Bank of New York"
  lookback_days                  int NOT NULL DEFAULT 45 CHECK (lookback_days = 45),
  caps                           jsonb NOT NULL,                                    -- {first, subsequent, lifetime} in percentage points
  rounding                       text NOT NULL DEFAULT 'nearest_eighth' CHECK (rounding = 'nearest_eighth'),
  initial_fixed_months           int NOT NULL,
  adjustment_notice_text_version text NOT NULL,                                     -- §1026.20(c)/(d) description (servicing 2.x)
  illustration_basis             text NOT NULL CHECK (illustration_basis IN ('historical_15y', 'max_rate_payment')),
  illustration_as_of             text NOT NULL,                                     -- month/year, e.g. '2026-10'
  illustration                   jsonb NOT NULL,                                    -- $10,000 initial and maximum rate/payment
  template_version               text NOT NULL,
  effective_from                 date NOT NULL,
  effective_to                   date,
  created_at                     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE arm_programs IS '21.3 rule 7: one row per Fannie Mae SOFR plan (4926/4927/4928/4929) and illustration month — the program-level facts the §1026.19(b)(2) disclosure renders (index, source, lookback, caps, rounding, (viii)(B) $10,000 illustration); never a consumer-specific rate.';
CREATE UNIQUE INDEX arm_programs_plan_asof_idx ON arm_programs(fnma_plan_number, illustration_as_of, template_version);

-- ---------------------------------------------------------------- score_disclosures (rule 6; FCRA §609(g); Reg V §1022.74(d), §1022.75(c))
CREATE TABLE score_disclosures (
  score_disclosure_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                 uuid NOT NULL REFERENCES applications(id),
  application_borrower_id        uuid NOT NULL REFERENCES application_borrowers(id),
  credit_report_id               text NOT NULL,                                     -- 22.2 credit adapter payload id (idempotency key)
  scores                         jsonb NOT NULL,                                    -- [{cra, model, score, range_low, range_high, date, key_factors[], inquiries_factor, representative, distribution}]
  rendered_document_id           uuid REFERENCES documents(id),                     -- §609(g) notice + H-3, one document per borrower
  disclosure_id                  uuid REFERENCES disclosures(id),
  delivered_at                   timestamptz,
  mailed_at                      timestamptz,
  retention_class                retention_class NOT NULL DEFAULT 'regb_25m',
  created_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT score_disclosures_one_per_report UNIQUE (application_borrower_id, credit_report_id)
);
COMMENT ON TABLE score_disclosures IS '21.3 rule 6: per-borrower §609(g) Notice to the Home Loan Applicant + Reg V H-3 exception notice — every score obtained for that borrower, the representative score flagged, never another borrower''s data (§1022.75(c)).';
CREATE INDEX score_disclosures_application_idx ON score_disclosures(application_id, application_borrower_id);

-- ---------------------------------------------------------------- early_disclosure_packages (outputs; state machine "package-level")
CREATE TABLE early_disclosure_packages (
  package_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                 uuid NOT NULL REFERENCES applications(id),
  assembled_at                   timestamptz NOT NULL,
  items                          jsonb NOT NULL DEFAULT '[]',                       -- [{disclosure_id, kind, rule_code, required, satisfied_by}]
  status                         text NOT NULL DEFAULT 'assembling' CHECK (status IN ('assembling', 'delivered', 'complete')),
  delivery_channel               text CHECK (delivery_channel IN ('esign_portal', 'email', 'mail', 'in_person', 'courier')),
  delivered_at                   timestamptz,
  mailed_at                      timestamptz,
  receipt_evidence               jsonb NOT NULL DEFAULT '{}',
  le_disclosure_id               uuid REFERENCES disclosures(id),                   -- when riding with the LE
  created_at                     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE early_disclosure_packages IS '21.3 outputs: the companion plan per application — one item per rule (required, exempt or satisfied-by-LE) with delivery/receipt evidence; complete when every required row is terminal.';
CREATE INDEX early_disclosure_packages_application_idx ON early_disclosure_packages(application_id);

COMMIT;
