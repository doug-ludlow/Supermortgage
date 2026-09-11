-- 0092_origination_insurance_flood_columns.sql — §24.5 Hazard, flood and other property insurance at origination
-- (spec/sections/24-…/24-5-hazard-flood-and-other-property-insurance-coverage-deductibl.md "Data model"; addendum §3).
-- 24.5 creates NO table of its own: `flood_determinations` (9.6), `insurance_policies`, `insurance_requirements` and
-- `insurance_deficiencies` (9.1) are the SERVICING tables of 0011_insurance.sql — one name means one thing everywhere —
-- and origination ADDS its columns here (ALTER TABLE … ADD COLUMN IF NOT EXISTS; never a second CREATE). Rows are
-- written to these tables at `loan.funded` (30.2 creates the `loans` row; loan_id is then known and the origination row
-- becomes the servicing row with application_id kept for the audit); before funding the 24.5 records live in the
-- application's event stream (`loan_events.application_id`) and the runtime entity store. Baseline tables used but
-- owned elsewhere: applications / application_properties (0057), documents / notices / disclosures (0001+),
-- conditions (23.1), fee_items (21.x), escrow_lines (3.2; 30.3 seeds them), timers, agent_decisions, escalations.
BEGIN;

-- ---------------------------------------------------------------- flood_determinations (9.6 owns; origination adds)
ALTER TABLE flood_determinations
  ADD COLUMN IF NOT EXISTS application_id                uuid REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS ordered_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS sfhdf_form_version            text,                       -- e.g. "FF-206-FY-21-116" (configuration: OMB 1660-0040 expires 2026-09-30)
  ADD COLUMN IF NOT EXISTS lol_purchased                 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lol_certificate_id            text,                       -- 30.4 binds it to the servicing loan number (SM_FLOOD_LOL_SERVICING_LINK_2BD)
  ADD COLUMN IF NOT EXISTS notice_required               boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notice_delivered_at           timestamptz,                -- baseline: the FIRST delivery
  ADD COLUMN IF NOT EXISTS notice_document_id            uuid REFERENCES documents(id),
  ADD COLUMN IF NOT EXISTS notice_delivery_channel       text CHECK (notice_delivery_channel IN ('esign', 'portal', 'mail')),
  ADD COLUMN IF NOT EXISTS notice_effective_receipt_date date,                       -- e-sign confirmed same day; mailbox rule +3 business_days_regz_specific for mail
  ADD COLUMN IF NOT EXISTS notice_acknowledged_at        timestamptz,
  ADD COLUMN IF NOT EXISTS notice_reasonable_period_days int,                        -- consummation − effective receipt (≥ 10 passes FDPA_4104A_FLOOD_NOTICE_GATE)
  ADD COLUMN IF NOT EXISTS notice_short_period_reason    text,
  ADD COLUMN IF NOT EXISTS sfc_180                       boolean NOT NULL DEFAULT false,  -- never true when any residential structure is in an SFHA
  ADD COLUMN IF NOT EXISTS community_participating       boolean,
  ADD COLUMN IF NOT EXISTS determination_basis           text NOT NULL DEFAULT 'vendor' CHECK (determination_basis IN ('vendor', 'manual_review')),
  ADD COLUMN IF NOT EXISTS origination_status            text CHECK (origination_status IN ('ordered', 'received', 'not_required', 'notice_due', 'notice_delivered', 'coverage_pending', 'coverage_verified', 'ineligible', 'withdrawn'));
COMMENT ON COLUMN flood_determinations.application_id IS '24.5: the origination application the SFHDF was ordered for (with the title order); kept after funding for the audit';
COMMENT ON COLUMN flood_determinations.notice_reasonable_period_days IS '24.5 rule 5: consummation date − effective receipt date of NTC_FDPA_4104A_FLOOD_NOTICE; ≥ 10 calendar days passes the gate (Interagency Q&A), shorter only with notice_short_period_reason + acknowledgment';
CREATE INDEX IF NOT EXISTS flood_determinations_application_idx ON flood_determinations (application_id) WHERE application_id IS NOT NULL;

-- ---------------------------------------------------------------- insurance_policies (9.1 owns; origination adds)
ALTER TABLE insurance_policies
  ADD COLUMN IF NOT EXISTS application_id                uuid REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS evidence_kind                 text CHECK (evidence_kind IN ('declarations', 'binder', 'certificate', 'policy', 'electronic_verification', 'master_certificate', 'rcbap_declarations', 'flood_declarations', 'ho6_declarations', 'liability_certificate', 'fidelity_certificate')),
  ADD COLUMN IF NOT EXISTS premium_paid_at_closing       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS premium_paid_through          date,                       -- 30.3 seeds the escrow line's renewal at this date
  ADD COLUMN IF NOT EXISTS first_year_premium_cents      bigint,
  ADD COLUMN IF NOT EXISTS origination_verified_at       timestamptz,
  ADD COLUMN IF NOT EXISTS origination_adequacy          jsonb,                      -- {test: PASS|FAIL|N/A} keyed to B7-3-01/-02/-03/-04/-06/-08 rules
  ADD COLUMN IF NOT EXISTS mortgagee_clause_check        jsonb,                      -- {partner_named, successors_assigns_phrase, servicer_address, mers_absent}
  ADD COLUMN IF NOT EXISTS named_insured_matches_title   boolean,
  ADD COLUMN IF NOT EXISTS fair_plan                     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mortgage_impairment_relief    boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN insurance_policies.origination_verified_at IS '24.5: the policy verified at origination under fnma.insurance.2026-08 (the same engine as 9.1); status verified is what 30.2 OB-010 and 30.4 read';
CREATE INDEX IF NOT EXISTS insurance_policies_application_idx ON insurance_policies (application_id) WHERE application_id IS NOT NULL;

-- ---------------------------------------------------------------- insurance_requirements (9.1 owns the computed record; origination adds)
ALTER TABLE insurance_requirements
  ADD COLUMN IF NOT EXISTS application_id                uuid REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS computed_from                 text CHECK (computed_from IN ('du_findings', 'project_review', 'flood_determination')),
  ADD COLUMN IF NOT EXISTS flood_required_amount_cents   bigint,                     -- min(100% RCV, NFIP max, note amount)
  ADD COLUMN IF NOT EXISTS flood_deductible_max_cents    bigint,                     -- NFIP maximum option (1,000,000)
  ADD COLUMN IF NOT EXISTS hazard_deductible_max_cents   bigint,                     -- 5% × dwelling coverage
  ADD COLUMN IF NOT EXISTS master_per_unit_deductible_max_cents bigint NOT NULL DEFAULT 5000000,
  ADD COLUMN IF NOT EXISTS ho6_required                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ho6_min_amount_cents          bigint,
  ADD COLUMN IF NOT EXISTS ho6_deductible_max_cents      bigint,
  ADD COLUMN IF NOT EXISTS liability_required            boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fidelity_required             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fidelity_min_cents            bigint;
COMMENT ON COLUMN insurance_requirements.flood_required_amount_cents IS '24.5 rule 4 / B7-3-06: lesser of 100% RCV, the NFIP maximum ($250,000 single-family building) and the UPB / note amount';

-- ---------------------------------------------------------------- insurance_deficiencies (9.1 owns; origination adds the stage)
ALTER TABLE insurance_deficiencies
  ADD COLUMN IF NOT EXISTS application_id                uuid REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS stage                         text NOT NULL DEFAULT 'servicing' CHECK (stage IN ('origination', 'servicing')),
  ADD COLUMN IF NOT EXISTS condition_kind                text CHECK (condition_kind IN ('ptd', 'ptf'));
ALTER TABLE insurance_deficiencies DROP CONSTRAINT IF EXISTS insurance_deficiencies_kind_check;
ALTER TABLE insurance_deficiencies ADD CONSTRAINT insurance_deficiencies_kind_check CHECK (kind IN ('expired', 'cancelled', 'nonrenewed', 'insufficient_coverage', 'acv_dwelling', 'deductible_excess', 'perils_gap', 'rating_fail', 'mortgagee_clause', 'named_insured', 'flood_none', 'flood_insufficient', 'flood_deductible', 'master_lapse', 'unit_policy_missing', 'coverage_decrease_unconfirmed',
  'effective_date', 'premium_unpaid', 'nfip_not_applied_paid_at_closing', 'private_flood_terms', 'master_rcv_undocumented', 'master_coverage_short', 'master_form', 'ho6_insufficient', 'ho6_deductible_excess', 'liability_missing', 'fidelity_missing'));
ALTER TABLE insurance_deficiencies DROP CONSTRAINT IF EXISTS insurance_deficiencies_resolution_check;
ALTER TABLE insurance_deficiencies ADD CONSTRAINT insurance_deficiencies_resolution_check CHECK (resolution IN ('evidence_received', 'lpi_placed', 'waived_by_policy', 'paid_off', 'transferred', 'reo', 'cured', 'withdrawn'));
COMMENT ON COLUMN insurance_deficiencies.stage IS '24.5 rule 9: origination-stage deficiencies open a ptf condition; outcomes cured / waived_by_policy (officer) / withdrawn';

COMMIT;
