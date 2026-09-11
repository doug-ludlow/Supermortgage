-- 0090_property_project_eligibility.sql — §24.3 Property and project eligibility (property types, condo/PUD project
-- review incl. CPM and deferred-maintenance rules, manufactured housing, ADUs, condition ratings, escrow holdbacks)
-- (spec/sections/24-…/24-3-property-and-project-eligibility-property-types-condo-pud-pr.md "Data model"; addendum §3).
-- Owned here: property_eligibility_reviews, project_reviews (the addendum §3 baseline table with 24.3's column set),
-- escrow_holdbacks, mh_verifications, and the `holdback_escrow` projection over 0001's ledger_lines (the custodial
-- holdback funds 30.2 posts through the loan sub-account `holdback_escrow` at funding — baseline §5; never a second
-- ledger). Not here (other owners, never duplicated): applications / application_properties / purchase_contracts
-- (0057), documents / loans / custodial_accounts / ledger_lines (0001), valuations / appraisals (24.2, in flight),
-- conditions (23.1). Reviews are recomputed "on every input" — each recomputation is a NEW row (append-only, 0001's
-- forbid_mutation trigger); the current review is the latest reviewed_at per application. Retention: project files
-- are loan-file class "until all mortgages sold to Fannie Mae have been liquidated" (B4-2.1-01).
BEGIN;

-- ---------------------------------------------------------------- property_eligibility_reviews (R1/R2: B2-3 and B4-1.3 checks; one row per recomputation)
CREATE TABLE property_eligibility_reviews (
  review_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id),
  reviewed_at               timestamptz NOT NULL,
  rule_set_version          text NOT NULL,                                   -- fnma.selling.2026-09-02 with the dated switches applied (see checks)
  checks                    jsonb NOT NULL,                                  -- [{rule, inputs, outcome ∈ {pass, fail, n/a}, evidence_document_ids, citation}]
  property_class            text NOT NULL CHECK (property_class IN ('sfr', 'pud_unit', 'condo_unit', 'detached_condo_unit', 'two_to_four', 'mh', 'mh_advantage', 'mixed_use', 'leasehold', 'multi_parcel')),
  adu_present               boolean NOT NULL DEFAULT false,
  adu_permitted             boolean,
  adu_rent_usable           boolean NOT NULL DEFAULT false,                  -- B3-3.8-02: purchase / limited cash-out only; 75% of the lease; ≤ 30% of total qualifying income
  zoning_status             text CHECK (zoning_status IN ('legal', 'legal_nonconforming', 'illegal', 'none')),
  condition_rating          text CHECK (condition_rating IN ('C1', 'C2', 'C3', 'C4', 'C5', 'C6')),
  quality_rating            text CHECK (quality_rating IN ('Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6')),
  as_is_or_subject_to       text CHECK (as_is_or_subject_to IN ('as_is', 'subject_to')),
  repairs                   jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{item, safety_related, estimate_cents, path ∈ {complete_before_sale, holdback, none}}]
  solar                     jsonb,                                           -- {ownership ∈ {owned, leased_ppa, financed_ucc, personal_property}, pace, loss_payee_third_party, alternate_power}
  pace_lien                 boolean NOT NULL DEFAULT false,
  disaster_flag             boolean NOT NULL DEFAULT false,
  result                    text NOT NULL CHECK (result IN ('eligible', 'eligible_with_conditions', 'ineligible')),
  ineligible_reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  valuation_id              uuid,                                            -- 24.2's valuations row the ratings came from (0089, in flight — no FK until it lands)
  created_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE property_eligibility_reviews IS '24.3 property_eligibility_reviews: one row per recomputation of the B2-3 / B4-1.3 property eligibility checks (property class, ADU, zoning, condition/quality routing, repairs paths, solar/PACE, disaster flag); result feeds the consummate and submitDelivery gates; recomputed on application, appraisal/PDC, title and any change to property facts.';
CREATE INDEX property_eligibility_reviews_app_idx ON property_eligibility_reviews (application_id, reviewed_at DESC);
CREATE TRIGGER property_eligibility_reviews_immutable BEFORE UPDATE OR DELETE ON property_eligibility_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- project_reviews (addendum §3 baseline; B4-2 Full Review / waiver / PERS / FHA; CPM record; validity)
CREATE TABLE project_reviews (
  project_review_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id),
  project_id                uuid,                                            -- SM project master (shared across applications in the same project)
  project_name              text,
  project_type              text NOT NULL CHECK (project_type IN ('condo', 'pud', 'mh_condo', 'mh_pud')),
  project_status            text CHECK (project_status IN ('new', 'established')),
  review_type               text NOT NULL CHECK (review_type IN ('full_cpm', 'full_no_cpm', 'pers', 'fha', 'waived', 'pud_waived', 'limited_legacy')),
  status                    text NOT NULL CHECK (status IN ('not_required', 'pending_docs', 'in_review', 'cpm_entry_pending', 'certified', 'waived', 'ineligible', 'expired')),
  application_date          date NOT NULL,                                   -- the dated rule-set switches key off it (limited_legacy < 2026-08-03; 15% reserves ≥ 2027-01-04)
  units_total               int,
  units_conveyed            int,
  presale_pct               numeric(6,4),
  single_entity_max_units   int,
  commercial_pct            numeric(6,4),
  delinquency_60_pct        numeric(6,4),
  special_assessments       jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{purpose, approved_on, planned_or_executing, original_cents, remaining_cents, per_unit_cents, paid_in_full_by, related_to_critical_repair, delinquency_pct}]
  critical_repairs          jsonb NOT NULL DEFAULT '[]'::jsonb,
  inspection_reports        jsonb NOT NULL DEFAULT '[]'::jsonb,              -- [{date, kind, findings, critical, reviewed}]
  evacuation_order          boolean NOT NULL DEFAULT false,
  regulatory_action         boolean NOT NULL DEFAULT false,
  litigation                jsonb NOT NULL DEFAULT '[]'::jsonb,
  annual_assessment_income_cents bigint,
  reserve_allocation_cents  bigint,
  reserve_pct               numeric(7,4),                                    -- allocation ÷ annual budgeted assessment income, 4 places (0.1042)
  reserve_study             jsonb,                                           -- {date, highest_recommended_cents, method ∈ {component, threshold, baseline}}
  insurance_review_ref      uuid,                                            -- 24.5 project insurance review
  questionnaire_document_id uuid REFERENCES documents(id),
  questionnaire_kind        text CHECK (questionnaire_kind IN ('form_1076_2016_addendum_2021', 'equivalent')),
  docs_as_of                date,                                            -- oldest document date (SM_PROJECT_DOCS_AGE_120)
  cpm_project_id            text,                                            -- 6-digit CPM ID (ULDD SID 39)
  cpm_phase_id              text,                                            -- 9-digit Phase ID (ULDD SID 49.2)
  cpm_certification_id      text,
  cpm_status                text CHECK (cpm_status IN ('approved_by_fnma', 'lender_certified', 'unavailable', 'not_found')),
  cpm_recorded_by           text,                                            -- the fnma_portal_operator who keyed CPM (UI-only; never the agent)
  cpm_cert_expires_on       date,
  project_type_code         char(1) CHECK (project_type_code IN ('E', 'F', 'R', 'S', 'T', 'U', 'V')),
  tests                     jsonb NOT NULL DEFAULT '[]'::jsonb,              -- every B4-2.1-03 / B4-2.2-01 / -02 test with inputs, outcome and citation
  rule_set_version          text NOT NULL,
  reviewed_at               timestamptz,
  expires_at                date,                                            -- established: reviewed_at + 1 year; new: + 180 days; capped by cpm_cert_expires_on
  result                    text CHECK (result IN ('eligible', 'eligible_with_conditions', 'ineligible')),
  ineligible_reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE project_reviews IS '24.3 project_reviews (addendum §3 baseline): the condo / PUD project review per application — review type under the post-Aug 3, 2026 methods (Full Review with CPM, PERS, FHA, waiver; limited_legacy only for application_date < 2026-08-03), every B4-2.1-03 / B4-2.2-01 / -02 test, special assessments and critical repairs, the reserve ratio, the CPM record the fnma_portal_operator keyed, Project Type Code and the B4-2.1-01 validity (expires_at). Append-only: a re-review is a new row.';
CREATE INDEX project_reviews_app_idx ON project_reviews (application_id, created_at DESC);
CREATE INDEX project_reviews_project_idx ON project_reviews (project_id) WHERE project_id IS NOT NULL;
CREATE TRIGGER project_reviews_immutable BEFORE UPDATE OR DELETE ON project_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- escrow_holdbacks (R3: B4-1.2-05 postponed improvements; 120% / fixed price; note date + 180 days)
CREATE TABLE escrow_holdbacks (
  holdback_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id            uuid NOT NULL REFERENCES applications(id),
  loan_id                   uuid REFERENCES loans(id),                       -- set by 30.2 at funding (servicing 3.x administers after boarding)
  kind                      text NOT NULL CHECK (kind IN ('postponed_new_construction', 'postponed_existing_minor')),
  items                     jsonb NOT NULL,                                  -- [{item, in_sales_contract, delay_reason, safety_related=false, occupancy_permit_affected=false, estimate_cents}]
  estimate_cents            bigint NOT NULL CHECK (estimate_cents > 0),
  fixed_price_contract      boolean NOT NULL DEFAULT false,
  contract_cents            bigint,
  escrow_cents              bigint NOT NULL CHECK (escrow_cents > 0),        -- ceil(estimate × 1.20) or the fixed contract price
  custodial_account_id      uuid REFERENCES custodial_accounts(id),          -- segregated custodial account (24.3-Q5; servicing 6.x criteria)
  funded_at                 timestamptz,
  note_date                 date NOT NULL,
  completion_due_on         date NOT NULL,                                   -- note_date + 180 calendar_days (FNMA_B4_1_2_05_HOLDBACK_COMPLETION_180)
  completion_evidence_kind  text CHECK (completion_evidence_kind IN ('form_1004d', 'uad36_completion_report', 'form_1004d_virtual', 'attestation_letter_with_evidence', 'professional_inspection_report')),
  completion_document_id    uuid REFERENCES documents(id),
  completed_at              timestamptz,
  final_draw_released_at    timestamptz,                                     -- within 5 business_days_servicer of completed_at (SM_HOLDBACK_FINAL_DRAW_5BD)
  status                    text NOT NULL CHECK (status IN ('established', 'in_progress', 'completed', 'released', 'overdue')),
  rule_set_version          text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE escrow_holdbacks IS '24.3 escrow_holdbacks: B4-1.2-05 postponed-improvement escrows — contract items delayed for a valid reason that never affect safety, soundness, structural integrity or the occupancy permit; escrow_cents = ceil(estimate × 1.20) or the guaranteed fixed contract price, funded at closing into the custodial holdback account and posted to the loan sub-account holdback_escrow (30.2); completion within 180 days of the note date; final draw only after accepted completion evidence. Status transitions are new rows (append-only).';
CREATE INDEX escrow_holdbacks_app_idx ON escrow_holdbacks (application_id, created_at DESC);
CREATE INDEX escrow_holdbacks_due_idx ON escrow_holdbacks (completion_due_on) WHERE status IN ('established', 'in_progress');
CREATE TRIGGER escrow_holdbacks_immutable BEFORE UPDATE OR DELETE ON escrow_holdbacks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- mh_verifications (R6: B5-2-02 / B5-2-03; HUD labels, data plate, real-property evidence, MH Advantage → SFC 859)
CREATE TABLE mh_verifications (
  verification_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                        uuid NOT NULL REFERENCES applications(id),
  hud_label_numbers                     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- one per section (multi-width → several)
  data_plate_document_id                uuid REFERENCES documents(id),
  label_verification_letter_document_id uuid REFERENCES documents(id),       -- IBTS letter when labels are missing
  built_on                              date,                                -- HUD Code: on or after 1976-06-15
  width                                 text CHECK (width IN ('single', 'multi')),
  real_property_evidence_document_id    uuid REFERENCES documents(id),       -- affidavit of affixture / title surrender (jurisdiction_rules.mh_titling)
  foundation_cert_document_id           uuid REFERENCES documents(id),
  mh_advantage                          boolean NOT NULL DEFAULT false,
  mh_advantage_sticker_verified         boolean NOT NULL DEFAULT false,      -- by the appraiser on Form 1004C
  choicehome_label                      boolean NOT NULL DEFAULT false,      -- SEL-2025-07 equivalent
  alta_7                                boolean NOT NULL DEFAULT false,      -- 24.4 endorsement
  special_feature_codes                 jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ["859"] for MH Advantage
  result                                text NOT NULL CHECK (result IN ('eligible', 'eligible_with_conditions', 'ineligible')),
  ineligible_reasons                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  verified_at                           timestamptz NOT NULL,
  rule_set_version                      text NOT NULL,
  created_at                            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mh_verifications IS '24.3 mh_verifications: the manufactured-housing verification set (HUD Certification Label numbers and Data Plate reported on the 1004C or the verification letter, build date ≥ 1976-06-15, real-property evidence, foundation certification, width vs occupancy, MH Advantage sticker → SFC 859); SM_MH_LABEL_VERIFICATION_GATE reads the latest row.';
CREATE INDEX mh_verifications_app_idx ON mh_verifications (application_id, verified_at DESC);
CREATE TRIGGER mh_verifications_immutable BEFORE UPDATE OR DELETE ON mh_verifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- holdback_escrow (projection): the custodial holdback funds per loan from 0001's ledger, joined to the holdback they secure
CREATE VIEW holdback_escrow AS
  SELECT l.loan_id,
         h.holdback_id,
         h.application_id,
         -sum(l.amount_cents)                                        AS balance_cents,      -- the liability sub-account is credited at funding (30.2:opening:holdback_escrow); debited on release
         max(s.effective_date)                                       AS last_posted_on,
         count(*)                                                    AS line_count,
         h.escrow_cents, h.completion_due_on, h.status
    FROM ledger_lines l
    JOIN ledger_entry_sets s ON s.id = l.set_id
    LEFT JOIN escrow_holdbacks h ON h.loan_id = l.loan_id
   WHERE l.scope = 'loan' AND l.account = 'holdback_escrow'
   GROUP BY l.loan_id, h.holdback_id, h.application_id, h.escrow_cents, h.completion_due_on, h.status;
COMMENT ON VIEW holdback_escrow IS '24.3 holdback_escrow: projection of the loan sub-account `holdback_escrow` (baseline §5; posted by 30.2 at funding and released by 24.3 after accepted completion evidence) — the custodial holdback balance per loan next to the escrow_holdbacks row it secures; the ledger is the record, this view never is.';

COMMIT;
