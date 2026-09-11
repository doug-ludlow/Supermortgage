-- 0107_licensing_approvals.sql — §31.1 Licensing, approvals and the partner boundary (spec/sections/31-…/31-1-licensing-approvals-and-the-partner-boundary.md
-- "Data model"). Owned here: the licence registry `licenses` (partner and SM, company/branch/individual — one registry drives
-- the origination and servicing sides; 25.1 keeps per-loan `license_checks` snapshots from it), the state matrix
-- `license_requirements` (versioned; nine verified states at v1, every other state `unverified` = fail-closed), the
-- `mlo_roster` (partner-employed/sponsored MLOs of record; SM employees never assignable by default), `fnma_approvals`
-- (eMortgage special approval, TSP certification / Technology Manager assignment per product, MERS/eVault/warehouse
-- agreements), `eligibility_inputs_origination` (the quarterly origination-liquidity component 18.3's FHFA test consumes),
-- `tpo_program_reviews` (the partner's A3-3-01 program over SM) and `ai_intake_legal_positions` (the written per-state
-- position on AI intake). Plus the `jurisdiction_rules.licensing` projection columns and the `origination.warehouse_legal_form`
-- config row. Not here (other owners, never duplicated): parties / documents / agent_decisions (0001), jurisdiction_rules
-- (0002), escalations (0019), data_access_authorizations / counterparty_contracts (0022 — Form 101 and executed contracts),
-- applications / feature_flags (0057). Money is bigint cents; rates numeric(5,4). The eligibility inputs are append-only
-- (0001's forbid_mutation trigger); registries carry a status and are never deleted. Retention: corporate_7y.
BEGIN;

-- ---------------------------------------------------------------- licenses (the registry; partner + SM; company / branch / individual)
CREATE TABLE licenses (
  license_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_kind               text NOT NULL CHECK (holder_kind IN ('partner_company', 'partner_branch', 'partner_individual', 'sm_company', 'sm_branch', 'sm_individual')),
  holder_ref                uuid NOT NULL,                                         -- party / branch / person id
  party_id                  uuid REFERENCES parties(id),                           -- the partner (lender of record) or SM party the holder belongs to
  nmls_id                   text,                                                  -- public NMLS data (not restricted)
  jurisdiction              char(2) NOT NULL,
  license_type_code         text NOT NULL,                                         -- AZ_MORTGAGE_BANKER, OH_RMLA_CERTIFICATE, OH_LOAN_PROCESSING_EXEMPTION_LETTER, NC_MORTGAGE_ORIGINATION_SUPPORT_REGISTRATION, IL_INDEPENDENT_LOAN_PROCESSING_ENTITY, TX_IC_LOAN_PROCESSOR_UNDERWRITER_COMPANY, WA_MORTGAGE_BROKER, CT_LOAN_PROCESSOR_UNDERWRITER, FL_LOAN_ORIGINATOR_CONTRACT_PROCESSOR, <ST>_MLO, <ST>_SERVICER_*
  authority_citation        text NOT NULL DEFAULT '',
  activity_scope            text[] NOT NULL CHECK (activity_scope <@ ARRAY['lend', 'broker', 'service', 'processing_underwriting_entity', 'mlo_individual', 'processor_underwriter_individual', 'exempt_letter']::text[] AND cardinality(activity_scope) > 0),
  status                    text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'applied', 'pending', 'approved', 'approved_conditions', 'approved_inactive', 'renewal_requested', 'terminated_expired', 'terminated_surrendered', 'suspended', 'revoked', 'not_required', 'exempt')),
  issued_at                 date,
  expires_at                date,                                                  -- NMLS annual licences: Dec 31
  renewal_window_opens      date,                                                  -- Nov 1
  renewal_requested_at      date,
  renewed_at                date,
  reinstatement_deadline    date,                                                  -- Feb 28/29
  sponsor_license_id        uuid REFERENCES licenses(license_id),                  -- individual licences: the sponsoring company licence
  bond_amount_cents         bigint CHECK (bond_amount_cents IS NULL OR bond_amount_cents >= 0),
  bond_expires_at           date,
  qualifying_individual_id  uuid,                                                  -- TX QI; NC/IL supervising MLO
  ce_completed_at           date,                                                  -- individuals
  ce_hours                  numeric(4,1) CHECK (ce_hours IS NULL OR ce_hours >= 0),
  last_nmls_sync_at         timestamptz,
  nmls_status_raw           text,
  evidence_document_id      uuid REFERENCES documents(id),                         -- the agent never writes approved without this or an NMLS record
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT licenses_approved_needs_evidence CHECK (status NOT IN ('approved', 'approved_conditions', 'approved_inactive', 'exempt', 'renewal_requested') OR evidence_document_id IS NOT NULL OR nmls_status_raw IS NOT NULL)
);
CREATE INDEX licenses_holder_idx ON licenses(holder_kind, holder_ref, status);
CREATE INDEX licenses_jurisdiction_idx ON licenses(jurisdiction, status);
CREATE INDEX licenses_expiry_idx ON licenses(expires_at) WHERE status IN ('approved', 'approved_conditions', 'exempt');
COMMENT ON TABLE licenses IS '31.1 licenses (retention corporate_7y): every partner and SM licence, registration, exemption letter and individual MLO/processor licence, mirrored nightly from NMLS (SM_O121_NMLS_SYNC_DAILY); status transitions only from an NMLS record or an issued licence document; activity_scope carries the servicing rows too (one registry drives both specs; 25.1 license_checks snapshot from it).';
COMMENT ON COLUMN licenses.nmls_id IS 'public NMLS data — not restricted';
CREATE TRIGGER licenses_no_delete BEFORE DELETE ON licenses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- license_requirements (the state matrix; versioned by superseded_by)
CREATE TABLE license_requirements (
  requirement_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction              char(2) NOT NULL,
  activity                  text NOT NULL CHECK (activity IN ('lend', 'broker', 'service', 'processing_underwriting_entity', 'processor_underwriter_individual_independent', 'mlo_individual', 'solicitation_display')),
  applies_to                text NOT NULL CHECK (applies_to IN ('partner', 'sm')),
  requirement_kind          text NOT NULL CHECK (requirement_kind IN ('license', 'registration', 'exemption_letter', 'declaration', 'none', 'unverified')),
  license_type_code         text,
  citation                  text NOT NULL,
  quoted_text               text NOT NULL,
  verification_status       text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('verified', 'partially_verified', 'unverified')),
  verified_at               date,
  verified_by               text,                                                  -- counsel user id / agent run (drafts only)
  source_url                text,
  effective_from            date NOT NULL,
  superseded_by             uuid REFERENCES license_requirements(requirement_id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT license_requirements_verified_needs_counsel CHECK (verification_status = 'unverified' OR (verified_at IS NOT NULL AND verified_by IS NOT NULL)),
  CONSTRAINT license_requirements_unverified_kind CHECK (requirement_kind <> 'unverified' OR verification_status = 'unverified')
);
CREATE INDEX license_requirements_state_idx ON license_requirements(jurisdiction, applies_to, activity) WHERE superseded_by IS NULL;
COMMENT ON TABLE license_requirements IS '31.1 license_requirements (the published matrix, versioned): per state and activity, what the partner or SM must hold — license / registration / exemption_letter / declaration / none — with citation, quoted statute text and counsel''s verification status. Nine verified states at v1 (AZ, OH, TX, NC, IL, WA, FL, CA, CT); every other state is seeded unverified with requirement_kind = unverified (fail-closed: SM_LICENSE_STATE_GATE never opens on an unverified processor rule). The agent (matrix.propose) drafts rows; only counsel sets verified.';
CREATE TRIGGER license_requirements_no_delete BEFORE DELETE ON license_requirements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- mlo_roster (MLOs of record; derived columns recomputed nightly)
CREATE TABLE mlo_roster (
  mlo_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id                 uuid NOT NULL,
  nmls_id                   text NOT NULL,
  employer                  text NOT NULL CHECK (employer IN ('partner', 'sm')),
  sponsor_license_id        uuid REFERENCES licenses(license_id),                  -- the partner company licence
  state_licenses            uuid[] NOT NULL DEFAULT '{}',                          -- → licenses
  states_assignable         char(2)[] NOT NULL DEFAULT '{}',                       -- derived nightly: approved, sponsored, CE current, not suspended/revoked
  lo_comp_plan_id           uuid,                                                  -- 25.1
  capacity_per_day          integer NOT NULL DEFAULT 10 CHECK (capacity_per_day >= 0),
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'offboarded')),
  assignable                boolean NOT NULL DEFAULT false,                        -- derived; employer = sm rows are false unless an SM lender/broker sponsor licence in the state and the state''s AI-intake position permit (default never)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mlo_roster_assignable_idx ON mlo_roster(assignable, status);
COMMENT ON TABLE mlo_roster IS '31.1 mlo_roster: every mlo_of_record 21.1 may stamp on an application (applications.mlo_of_record_id / mlo_nmlsr_id) — partner-employed and partner-sponsored by default (open question 5); states_assignable and assignable are derived nightly from licenses (approved, sponsorship active, CE current for the renewal year, no suspended/revoked). SM employees: assignable = false unless licenses.sponsor_license_id resolves to an SM lender/broker licence in that state and jurisdiction_rules.licensing.ai_intake_position permits.';

-- ---------------------------------------------------------------- fnma_approvals (origination-side approvals and authorizations registry)
CREATE TABLE fnma_approvals (
  approval_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity                    text NOT NULL CHECK (entity IN ('partner', 'sm')),
  party_id                  uuid REFERENCES parties(id),
  kind                      text NOT NULL CHECK (kind IN ('seller_servicer_approval', 'servicer_approval', 'emortgage_special_approval', 'tsp_integration_agreement', 'tsp_certification', 'tm_tsp_product_assignment', 'developer_portal_app', 'ucdp_lender_registration', 'ucdp_lender_agent_registration', 'loan_delivery_warehouse_org', 'pe_whole_loan_access', 'cpm_access', 'mers_membership', 'mers_eregistry_addendum', 'enote_warehouse_agreement', 'custodian_form_2017', 'related_party_designation')),
  product                   text CHECK (product IS NULL OR product IN ('du', 'earlycheck', 'ucdp', 'ucd', 'property_data', 'pricing_committing', 'purchase_advice', 'ami_homeready', 'appraisal_findings', 'loan_lookup')),
  seller_servicer_number    char(9),                                               -- the partner''s 9-digit number (parties.servicer_number)
  status                    text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'applied', 'testing', 'granted', 'active', 'conditions', 'suspended', 'revoked', 'expired')),
  granted_at                date,
  expires_at                date,
  conditions                jsonb NOT NULL DEFAULT '{}'::jsonb,                    -- e.g. eMortgage approval limited to certain eClosing providers (gates 26.2''s vendor choice)
  evidence_document_id      uuid REFERENCES documents(id),                         -- approval letter / e-mail, certification confirmation, Technology Manager screenshot
  contact_ref               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fnma_approvals_product_kinds CHECK (kind NOT IN ('tsp_certification', 'tm_tsp_product_assignment') OR product IS NOT NULL),
  CONSTRAINT fnma_approvals_granted_needs_evidence CHECK (status NOT IN ('granted', 'active') OR evidence_document_id IS NOT NULL)
);
CREATE INDEX fnma_approvals_kind_idx ON fnma_approvals(entity, kind, product, status);
COMMENT ON TABLE fnma_approvals IS '31.1 fnma_approvals: the partner''s special approvals (eMortgage — FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE) and SM''s Technology Service Provider authorizations per product (tsp_certification granted + tm_tsp_product_assignment active + 19.3 Form 101 → FNMA_TSP_PRODUCTION_CERT_GATE), MERS/eRegistry/eVault/warehouse eNote agreements, UCDP/PE/Loan Delivery registrations. Form 101 lives in 19.3 data_access_authorizations; executed contracts in 19.3 counterparty_contracts (referenced). granted/active only with evidence.';
CREATE TRIGGER fnma_approvals_no_delete BEFORE DELETE ON fnma_approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- eligibility_inputs_origination (quarterly; consumed by 18.3 FHFA_ELIG_QUARTERLY_TEST; append-only)
CREATE TABLE eligibility_inputs_origination (
  id                                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period                               text NOT NULL CHECK (period ~ '^[0-9]{4}Q[1-4]$'),
  as_of                                date NOT NULL,
  hfs_upb_cents                        bigint NOT NULL CHECK (hfs_upb_cents >= 0),                     -- funded, not yet purchased (27.1 warehouse_advances ∪ 29.4 deliveries.purchase_date is null)
  irlc_pipeline_cents                  bigint NOT NULL CHECK (irlc_pipeline_cents >= 0),               -- 21.4 locks.status = active not yet funded
  fallout_rate                         numeric(5,4) NOT NULL CHECK (fallout_rate >= 0 AND fallout_rate <= 1),   -- 29.2 trailing pull-through complement
  irlc_adjusted_cents                  bigint NOT NULL CHECK (irlc_adjusted_cents >= 0),               -- round-half-up(irlc_pipeline_cents × (1 − fallout_rate))
  origination_liquidity_base_cents     bigint NOT NULL CHECK (origination_liquidity_base_cents >= 0),  -- hfs + irlc_adjusted
  trailing_12m_originations_cents      bigint NOT NULL CHECK (trailing_12m_originations_cents >= 0),   -- most recent four quarters, 1–4 unit first liens excl. reverse, C-to-P to home buyers, lot loans
  origination_liquidity_applies        boolean NOT NULL,                                               -- trailing > $1,000,000,000.00 (A4-1-01 08/05/2026)
  origination_liquidity_required_cents bigint NOT NULL CHECK (origination_liquidity_required_cents >= 0),   -- applies ? round-half-up(base × 50 bps) : 0
  computed_at                          timestamptz NOT NULL,
  due_to_18_3                          date NOT NULL,                                                  -- quarter-end + 5 business_days_fannie_et (FNMA_A4_1_01_ORIG_LIQUIDITY_INPUTS_QBD5)
  delivered_to_18_3_at                 timestamptz,
  created_at                           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_inputs_origination_period_idx ON eligibility_inputs_origination(period, computed_at DESC);
COMMENT ON TABLE eligibility_inputs_origination IS '31.1 eligibility_inputs_origination (append-only): the origination-liquidity component of the FHFA/Selling Guide A4-1-01 eligibility test — 50 bps × (HFS + fallout-adjusted IRLC pipeline) for a non-depository originating more than $1 billion in the most recent four quarters (Q4 2026 worked example: $150,000,000.00 + $140,000,000.00 = $290,000,000.00 × 0.5 % = $1,450,000.00, due to 18.3 by Fri Jan 8, 2027); 18.3''s FHFA_ELIG_QUARTERLY_TEST consumes it.';
CREATE TRIGGER eligibility_inputs_origination_immutable BEFORE UPDATE OR DELETE ON eligibility_inputs_origination FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- tpo_program_reviews (the partner''s A3-3-01 program over SM)
CREATE TABLE tpo_program_reviews (
  review_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject                   text NOT NULL DEFAULT 'sm' CHECK (subject = 'sm'),
  kind                      text NOT NULL CHECK (kind IN ('initial_approval', 'annual_financial_statements', 'quarterly_performance', 'licensing_reverification', 'qc_plan_review')),
  period_start              date NOT NULL,
  period_end                date NOT NULL CHECK (period_end >= period_start),
  inputs                    jsonb NOT NULL DEFAULT '{}'::jsonb,                    -- defect rates (28.1/28.2), EPD, LQC findings (29.4), SLA metrics, complaint counts, licence status summary
  findings                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  rating                    text,
  completed_at              date,
  approved_by               text,                                                  -- partner officer (annual financial review)
  document_id               uuid REFERENCES documents(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tpo_annual_review_needs_officer CHECK (kind <> 'annual_financial_statements' OR completed_at IS NULL OR approved_by IS NOT NULL)
);
CREATE INDEX tpo_program_reviews_kind_idx ON tpo_program_reviews(kind, period_end DESC);
COMMENT ON TABLE tpo_program_reviews IS '31.1 tpo_program_reviews: the partner''s Selling Guide A3-3-01 third-party-origination program run over SM (initial approval file, annual financial-statement review by the partner officer — FNMA_A3_3_01_TPO_ANNUAL_FINANCIAL_REVIEW_365, quarterly performance — FNMA_A3_3_01_TPO_QUARTERLY_PERFORMANCE_90, licensing re-verification — FNMA_A3_3_01_TPO_LICENSE_REVERIFY_365, QC plan review); no SFC 211/212 is delivered (31.1 §C position).';
CREATE TRIGGER tpo_program_reviews_no_delete BEFORE DELETE ON tpo_program_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- ai_intake_legal_positions (written per-state position on AI intake; reviewed annually)
CREATE TABLE ai_intake_legal_positions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction              char(2) NOT NULL,
  position                  text NOT NULL CHECK (position IN ('assisted_required', 'autonomous_permitted_by_written_position', 'unresolved')),
  memo_document_id          uuid REFERENCES documents(id),
  counsel                   text NOT NULL,
  issued_at                 date NOT NULL,
  review_due_at             date NOT NULL,                                         -- issued_at + 365 (SM_O121_AI_POSITION_REVIEW_365)
  superseded_by             uuid REFERENCES ai_intake_legal_positions(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_intake_autonomous_needs_memo CHECK (position <> 'autonomous_permitted_by_written_position' OR memo_document_id IS NOT NULL)
);
CREATE INDEX ai_intake_legal_positions_state_idx ON ai_intake_legal_positions(jurisdiction) WHERE superseded_by IS NULL;
COMMENT ON TABLE ai_intake_legal_positions IS '31.1 ai_intake_legal_positions: counsel''s written position per state on AI intake under the SAFE Act (an AI is not "an individual"; default assisted_required — the partner-employed mlo_of_record presents terms and approves LE terms and locks; autonomous only on a state-specific memo, reviewed annually; a stale autonomous memo degrades to unresolved and closes the state for new applications).';
CREATE TRIGGER ai_intake_legal_positions_no_delete BEFORE DELETE ON ai_intake_legal_positions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- jurisdiction_rules.licensing projections (backward compatibility for 20.2 / 22.1 / 22.3 / 25.1)
ALTER TABLE jurisdiction_rules
  ADD COLUMN IF NOT EXISTS lender_license_types text[] GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(rules->'licensing'->'lender_license_types') = 'array' AND (rules->'licensing'->>'lender_license_types') <> '[]' THEN string_to_array(replace(btrim(replace(rules->'licensing'->>'lender_license_types', '"', ''), '[]'), ' ', ''), ',') ELSE ARRAY[]::text[] END) STORED,
  ADD COLUMN IF NOT EXISTS processor_license_required text GENERATED ALWAYS AS (COALESCE(rules->'licensing'->>'processor_license_required', 'unverified')) STORED;
COMMENT ON COLUMN jurisdiction_rules.lender_license_types IS '31.1 projection of jurisdiction_rules.rules->licensing->lender_license_types (the partner company licence types a state needs)';
COMMENT ON COLUMN jurisdiction_rules.processor_license_required IS '31.1 projection of jurisdiction_rules.rules->licensing->processor_license_required ∈ none | exemption_letter | registration | entity_license | unverified (default unverified: fail-closed)';

-- ---------------------------------------------------------------- config owned here: the warehouse legal form (§G Form A; Form B prohibited without an officer + attorney decision record)
INSERT INTO feature_flags(key, value, updated_by) VALUES ('origination.warehouse_legal_form', '"secured_loan_to_partner"', 'migration:0107') ON CONFLICT (key) DO NOTHING;

COMMIT;
