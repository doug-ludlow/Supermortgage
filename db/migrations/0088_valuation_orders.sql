-- 0088_valuation_orders.sql — §24.1 valuation method selection and ordering, appraiser independence, property data collection
-- (spec/sections/24-…/24-1-valuation-method-selection-and-ordering-value-acceptance-val.md "Data model"; addendum §3 names
-- `valuation_orders` and `property_data_collections` as the section's baseline tables — created here, columns per 24.1).
-- Owned here: valuation_orders, property_data_collections, appraiser_panel, amc_registrations, valuation_fee_benchmarks,
-- air_contact_log. Not here (other owners, never duplicated): applications / application_properties / purchase_contracts
-- (0057), fee_items (0064 — the `appraisal_fee` row with tolerance_class = zero when borrower-paid is 21.2's), intent_records /
-- fee_gate_checks (0066), du_casefiles / du_submissions (0084), hpml_determinations (0087), agent_decisions / documents /
-- parties (0001), appraisals / ucdp_submissions (24.2). The AIR contact log and the fee benchmarks are append-only (0001's
-- forbid_mutation trigger): a contact is a fact, a benchmark refresh is a new row. Retention class fnma_loan_file_life_plus_4y.
BEGIN;

-- ---------------------------------------------------------------- valuation_orders (state machine in 24.1; one row per order, child rows for updates / reassignments)
CREATE TABLE valuation_orders (
  order_id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                        uuid NOT NULL REFERENCES applications(id),
  status                                text NOT NULL DEFAULT 'method_pending' CHECK (status IN ('method_pending', 'fee_gate_wait', 'ready_to_order', 'ordered', 'assigned', 'inspection_scheduled', 'inspected', 'report_received', 'cancelled', 'reassigned', 'expired', 'update_required',
                                                                                                'offer_recorded', 'offer_exercised', 'offer_lost', 'pdc_ordered', 'pdc_collected', 'pdc_submitted', 'pdc_accepted', 'converted_to_hybrid', 'converted_to_traditional')),
  method                                text NOT NULL CHECK (method IN ('value_acceptance', 'value_acceptance_pd', 'hybrid', 'desktop', 'traditional')),
  assignment_type                       text NOT NULL CHECK (assignment_type IN ('traditional', 'desktop', 'hybrid', 'pdc_only', 'appraisal_update', 'completion_report', 'second_appraisal_hpml', 'field_review')),
  form_code                             text CHECK (form_code IN ('1004', '1073', '1025', '1004C', '1004_desktop', '1004_hybrid', '1073_hybrid', '1004D', 'urar_uad36', 'update_uad36', 'completion_uad36')),
  uad_version                           text NOT NULL DEFAULT '3.6' CHECK (uad_version IN ('2.6', '3.6')),
  du_submission_id                      uuid,                                        -- 0084 du_submissions
  offer_type                            text NOT NULL DEFAULT 'none' CHECK (offer_type IN ('value_acceptance', 'value_acceptance_pd', 'none')),
  offer_issued_at                       date,
  offer_expires_on                      date,                                        -- offer_issued_at + 4 calendar months (same day-of-month; end-of-month clamp)
  ordered_by_agent_run_id               text,
  fee_gate_evidence_id                  text,                                        -- fee_gate_checks.check_id (borrower-paid) or intent_records.intent_id (SM-borne)
  fee_quote_cents                       bigint CHECK (fee_quote_cents IS NULL OR fee_quote_cents > 0),
  fee_invoice_cents                     bigint CHECK (fee_invoice_cents IS NULL OR fee_invoice_cents > 0),
  fee_paid_by                           text NOT NULL DEFAULT 'sm' CHECK (fee_paid_by IN ('sm', 'borrower', 'seller', 'other')),
  fee_benchmark_id                      uuid,                                        -- FK added below (valuation_fee_benchmarks)
  channel                               text NOT NULL DEFAULT 'amc' CHECK (channel IN ('amc', 'panel')),
  vendor_party_id                       uuid REFERENCES parties(id),
  amc_party_id                          uuid REFERENCES parties(id),
  amc_registration_id                   uuid,                                        -- FK added below (amc_registrations)
  appraiser_party_id                    uuid REFERENCES parties(id),
  appraiser_license_state               char(2),
  appraiser_license_number              text,
  appraiser_license_type                text CHECK (appraiser_license_type IN ('licensed', 'certified_residential', 'certified_general')),
  appraiser_license_expires_on          date,
  asc_registry_checked_at               timestamptz,
  pdc_id                                uuid,                                        -- FK added below (property_data_collections)
  property_state                        char(2) NOT NULL,
  first_ucdp_submission_on              date,                                        -- FNMA_UAD_3_6_REQUIRED_GATE: on/after 2026-11-02 → uad_version must be 3.6
  ordered_at                            timestamptz,
  assigned_at                           timestamptz,
  inspection_scheduled_at               timestamptz,
  inspection_completed_at               timestamptz,
  received_at                           timestamptz,
  report_document_id                    uuid REFERENCES documents(id),               -- the UAD 3.6 ZIP as received (handed to 24.2 appraisals)
  effective_date                        date,
  age_4m_update_after                   date,                                        -- effective_date + 4 months (B4-1.2-04)
  age_12m_expires_on                    date,                                        -- effective_date + 12 months (B4-1.2-04)
  cancel_reason                         text,
  reassigned_from_order_id              uuid REFERENCES valuation_orders(order_id),
  parent_order_id                       uuid REFERENCES valuation_orders(order_id),  -- appraisal_update / completion_report children
  transferred_from_lender               boolean NOT NULL DEFAULT false,
  transfer_air_attestation_document_id  uuid REFERENCES documents(id),
  vendor_order_id                       text,
  engagement_letter_document_id         uuid REFERENCES documents(id),
  payload_hash                          text,                                        -- hash of the allowlisted outbound payload (proof no value information was sent)
  retention_class                       text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                            timestamptz NOT NULL DEFAULT now(),
  updated_at                            timestamptz NOT NULL DEFAULT now(),
  CHECK (offer_type = 'none' OR offer_issued_at IS NOT NULL),
  CHECK (NOT transferred_from_lender OR transfer_air_attestation_document_id IS NOT NULL)
);
COMMENT ON TABLE valuation_orders IS '24.1 valuation_orders: one row per valuation order (traditional / desktop / hybrid / PDC-only / appraisal update / completion / HPML second appraisal / field review) with the DU offer it rests on, the fee-gate evidence, the §1026.42(f) benchmark, the appraiser license snapshot, the AMC registration, SLA timestamps (SM_VALUATION_*_SLA), the report as received and the B4-1.2-04 age dates; value-acceptance paths are rows with method value_acceptance(_pd) and no report. Transfers under AIR §6 carry transferred_from_lender + the attestation. Retention fnma_loan_file_life_plus_4y; PII: borrower access contact only (not stored here).';
CREATE INDEX valuation_orders_application_idx ON valuation_orders (application_id, created_at DESC);
CREATE INDEX valuation_orders_status_idx ON valuation_orders (status) WHERE status NOT IN ('report_received', 'cancelled', 'expired', 'offer_exercised');

-- ---------------------------------------------------------------- property_data_collections (B4-1.4-11; PDCIR)
CREATE TABLE property_data_collections (
  pdc_id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                    uuid NOT NULL REFERENCES applications(id),
  valuation_order_id                uuid REFERENCES valuation_orders(order_id),
  vendor_party_id                   uuid REFERENCES parties(id),
  collector_party_id                uuid REFERENCES parties(id),
  collector_background_check_on     date NOT NULL,                                   -- annual background check (< 12 months at order)
  collector_training_evidence_id    uuid REFERENCES documents(id),
  pdcir_attestation_id              uuid REFERENCES documents(id),
  ordered_at                        timestamptz NOT NULL,
  collected_at                      timestamptz,
  upd_version                       text,                                            -- Uniform Property Dataset version
  floor_plan_document_id            uuid REFERENCES documents(id),                   -- ANSI-conforming floor plan
  image_document_ids                jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_issue_flag                 boolean NOT NULL DEFAULT false,
  safety_issue_notes                text,
  property_data_id_fnma             text,                                            -- Property Data API id (delivered with SFC 774; 29.3 ULDD)
  submitted_at                      timestamptz,
  accepted_on                       date,
  submission_status                 text NOT NULL DEFAULT 'pending' CHECK (submission_status IN ('pending', 'accepted', 'rejected')),
  rejection_messages                jsonb NOT NULL DEFAULT '[]'::jsonb,
  status                            text NOT NULL DEFAULT 'pdc_ordered' CHECK (status IN ('pdc_ordered', 'pdc_collected', 'pdc_submitted', 'pdc_accepted', 'converted_to_hybrid', 'converted_to_traditional', 'cancelled')),
  valid_until                       date,                                            -- collected_at + 12 months
  retention_class                   text NOT NULL DEFAULT 'fnma_loan_file_life_plus_4y',
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  CHECK (submission_status <> 'accepted' OR property_data_id_fnma IS NOT NULL)
);
COMMENT ON TABLE property_data_collections IS '24.1 property_data_collections: the value acceptance + property data collection (interior + exterior visual observation, UPD, ANSI floor plan, images) by a trained and vetted collector under the PDCIR; the Property Data API submission and returned Property Data ID (FNMA_B4_1_4_11_PDC_API_SUBMIT_GATE: held before the note date); a safety_issue_flag blocks VA+PD and converts the method (the PDC is then shared with the appraiser at engagement, B4-1.2-03).';
CREATE INDEX property_data_collections_application_idx ON property_data_collections (application_id);
ALTER TABLE valuation_orders ADD CONSTRAINT valuation_orders_pdc_fk FOREIGN KEY (pdc_id) REFERENCES property_data_collections(pdc_id);

-- ---------------------------------------------------------------- appraiser_panel (B4-1.1-03 selection criteria; ASC National Registry)
CREATE TABLE appraiser_panel (
  party_id                uuid PRIMARY KEY REFERENCES parties(id),
  license_state           char(2) NOT NULL,
  license_type            text NOT NULL CHECK (license_type IN ('licensed', 'certified_residential', 'certified_general')),
  license_number          text NOT NULL,
  license_expires_on      date NOT NULL,
  asc_registry_status     text NOT NULL DEFAULT 'unknown' CHECK (asc_registry_status IN ('active', 'inactive', 'revoked', 'suspended', 'unknown')),
  asc_registry_checked_on date,
  disciplinary_history    jsonb NOT NULL DEFAULT '[]'::jsonb,
  geo_competency          jsonb NOT NULL DEFAULT '{}'::jsonb,                          -- counties / ZIPs / property types
  amc_party_id            uuid REFERENCES parties(id),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  removal_reason          text,
  last_assigned_at        timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'removed' OR removal_reason IS NOT NULL)
);
COMMENT ON TABLE appraiser_panel IS '24.1 appraiser_panel: state-licensed / certified appraisers (direct panel or AMC-sourced) with the ASC National Registry snapshot the SM_APPRAISER_LICENSE_GATE reads (license active in the subject-property state; ASC check ≤ 30 days old), disciplinary history for AIR §7 / §1026.42(g) referrals and geo-competency for rotation; a removal is never for a "low value" (AIR §1.2).';

-- ---------------------------------------------------------------- amc_registrations (12 U.S.C. 3353; state AMC statutes)
CREATE TABLE amc_registrations (
  amc_registration_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amc_party_id            uuid NOT NULL REFERENCES parties(id),
  state                   char(2) NOT NULL,
  registration_number     text NOT NULL,
  expires_on              date NOT NULL,
  asc_amc_registry_status text NOT NULL DEFAULT 'unknown' CHECK (asc_amc_registry_status IN ('active', 'inactive', 'unknown')),
  evidence_document_id    uuid REFERENCES documents(id),
  verified_at             timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (amc_party_id, state, registration_number)
);
COMMENT ON TABLE amc_registrations IS '24.1 amc_registrations: per-state AMC registration evidence (number, expiry, ASC AMC registry status) the SM_AMC_REGISTRATION_GATE reads before an AMC-path order (12 U.S.C. 3353(d): no services in a State unless registered); state-specific rules (payment timing, panel notice) live in jurisdiction_rules.amc (31.1).';
CREATE INDEX amc_registrations_state_idx ON amc_registrations (state, amc_party_id, expires_on DESC);
ALTER TABLE valuation_orders ADD CONSTRAINT valuation_orders_amc_registration_fk FOREIGN KEY (amc_registration_id) REFERENCES amc_registrations(amc_registration_id);

-- ---------------------------------------------------------------- valuation_fee_benchmarks (§1026.42(f)(3) third-party survey / (f)(2) market data; append-only)
CREATE TABLE valuation_fee_benchmarks (
  benchmark_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state             char(2) NOT NULL,
  county_fips       char(5) NOT NULL,
  form_code         text NOT NULL,
  assignment_type   text NOT NULL CHECK (assignment_type IN ('traditional', 'desktop', 'hybrid', 'pdc_only', 'appraisal_update', 'completion_report', 'second_appraisal_hpml', 'field_review')),
  median_fee_cents  bigint NOT NULL CHECK (median_fee_cents > 0),
  p25_fee_cents     bigint NOT NULL CHECK (p25_fee_cents > 0),
  p75_fee_cents     bigint NOT NULL CHECK (p75_fee_cents >= p25_fee_cents),
  source            text NOT NULL CHECK (source IN ('third_party_survey_1026_42f3', 'market_data_1026_42f2')),
  as_of             date NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (p25_fee_cents <= median_fee_cents AND median_fee_cents <= p75_fee_cents)
);
COMMENT ON TABLE valuation_fee_benchmarks IS '24.1 valuation_fee_benchmarks: customary-and-reasonable fee benchmarks per state / county / form / assignment type (median, p25, p75) from a §1026.42(f)(3) third-party survey excluding AMC-ordered fees or (f)(2) market data, refreshed at least annually as new rows (append-only); R3 tests the appraiser share (not the AMC gross) against p25–p75 or a logged (f)(2) adjustment reason.';
CREATE INDEX valuation_fee_benchmarks_lookup_idx ON valuation_fee_benchmarks (state, county_fips, form_code, assignment_type, as_of DESC);
CREATE TRIGGER valuation_fee_benchmarks_immutable BEFORE UPDATE OR DELETE ON valuation_fee_benchmarks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE valuation_orders ADD CONSTRAINT valuation_orders_fee_benchmark_fk FOREIGN KEY (fee_benchmark_id) REFERENCES valuation_fee_benchmarks(benchmark_id);

-- ---------------------------------------------------------------- air_contact_log (AIR §1.2 / §4.1 audit; append-only; exportable)
CREATE TABLE air_contact_log (
  contact_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  valuation_order_id          uuid REFERENCES valuation_orders(order_id),
  direction                   text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  counterparty_role           text NOT NULL CHECK (counterparty_role IN ('appraiser', 'amc', 'pdc', 'borrower', 'agent')),
  actor                       text NOT NULL,                                          -- agent run or user (kind:id)
  actor_is_restricted_party   boolean NOT NULL DEFAULT false CHECK (actor_is_restricted_party = false),   -- enforced at the service boundary, not only logged
  channel                     text NOT NULL,
  content_hash                text NOT NULL,
  payload_document_id         uuid REFERENCES documents(id),
  value_request_refused       boolean NOT NULL DEFAULT false,                         -- "what value do you need?" → scripted refusal, counted on the vendor AIR score
  at                          timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE air_contact_log IS '24.1 air_contact_log: every contact between the platform and the appraiser / AMC / property data collector / borrower / agent about a valuation, with the actor and its restricted-party status (must be false — AIR §4.1.1 production staff never touch the appraisal function), the channel and a content hash; append-only and exportable for Fannie Mae QC/MORA and CFPB §1026.42 examinations.';
CREATE INDEX air_contact_log_application_idx ON air_contact_log (application_id, at);
CREATE TRIGGER air_contact_log_immutable BEFORE UPDATE OR DELETE ON air_contact_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
