-- 0069_compliance_testing_engine.sql — §25.1 compliance testing engine (spec/sections/25-…/25-1-….md "Data model").
-- Owned here: compliance_test_definitions, compliance_test_runs, compliance_tests, compliance_waivers, fee_benchmarks,
-- finance_charge_classifications, license_checks, pricing_exception_reviews. Not here (other owners, never duplicated):
-- `qm_determinations` / `hpml_determinations` / `high_cost_determinations` / `apor_tables` (23.4), `tolerance_tests` /
-- `tolerance_cures` (21.5), `fee_items` / `disclosures` (21.2), `apr_calculations` (addendum §3 baseline; 21.2's engine
-- table — the checkpoint columns 25.1 adds ride with it). Append-only where the spec's audit needs an immutable trail
-- (test rows, waivers, license evidence, pricing-exception reviews, classifications) — 0001's forbid_mutation trigger.
BEGIN;

-- ---------------------------------------------------------------- test registry (compliance_test_definitions)
CREATE TABLE compliance_test_definitions (
  test_code            text PRIMARY KEY,                                   -- registry key (STATE_HIGH_COST_<ST> rows are added per state)
  title                text NOT NULL,
  citation             text NOT NULL,
  blocking_default     boolean NOT NULL,
  checkpoints          text[] NOT NULL,                                    -- ⊆ {le, lock, revised_le, cd, corrected_cd, consummation, disbursement, delivery, post_closing_qc}
  jurisdiction_scope   text NOT NULL CHECK (jurisdiction_scope IN ('federal', 'state', 'policy')),
  rule_set_code        text NOT NULL,                                      -- rule_sets.bundle
  owner_process        text NOT NULL,                                      -- 25.1, or 21.5 (TRID_19E3_TOLERANCE) / 23.4 (QM_1026_43, HPML_1026_35, HOEPA_1026_32)
  waivable             boolean NOT NULL DEFAULT false,                     -- false for every legal test
  created_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE compliance_test_definitions IS '25.1 test registry: blocking B / warning W, checkpoints, rule set, owner; waivable=false for every legal test (only policy tests such as FEE_REASONABLENESS and RESPA_8_MSA_INVENTORY may carry a compliance_waivers row).';
INSERT INTO compliance_test_definitions (test_code, title, citation, blocking_default, checkpoints, jurisdiction_scope, rule_set_code, owner_process, waivable) VALUES
  ('APR_1026_22_ACCURACY', 'APR accuracy', '12 CFR 1026.22(a)(2)-(5); Appendix J', true, '{cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'federal', 'regz.apr.appendix_j', '25.1', false),
  ('FC_1026_4_CLASSIFICATION', 'Finance-charge classification', '12 CFR 1026.4', true, '{le,lock,revised_le,cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'federal', 'regz.finance_charge.1026_4', '25.1', false),
  ('FC_1026_38O2_ACCURACY', 'Finance-charge accuracy on the CD', '12 CFR 1026.38(o)(2)', true, '{cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'federal', 'regz.trid.2017', '25.1', false),
  ('TRID_19E3_TOLERANCE', 'Good-faith tolerance (21.5 runToleranceTest)', '12 CFR 1026.19(e)(3)', true, '{revised_le,cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'federal', 'regz.trid.2017', '21.5', false),
  ('QM_1026_43', 'General QM / ATR (23.4 determination)', '12 CFR 1026.43(e)', true, '{le,lock,revised_le,cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'federal', 'regz.qm.general.2021', '23.4', false),
  ('HPML_1026_35', 'Higher-priced mortgage loan (23.4 determination)', '12 CFR 1026.35', true, '{le,lock,revised_le,cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'federal', 'regz.hpml', '23.4', false),
  ('HOEPA_1026_32', 'High-cost mortgage (23.4 determination; Fannie Mae ineligible)', '12 CFR 1026.32; B2-1.5-02', true, '{le,lock,revised_le,cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'federal', 'regz.hoepa', '23.4', false),
  ('STATE_HIGH_COST', 'State high-cost / predatory statute (STATE_HIGH_COST_<ST>)', 'state statute per jurisdiction_rules.high_cost_statute', true, '{le,lock,revised_le,cd,corrected_cd,consummation,disbursement,delivery,post_closing_qc}', 'state', 'state.high_cost', '25.1', false),
  ('POINTS_FEES_3PCT_FNMA', 'Fannie Mae points-and-fees eligibility (policy pending B2-1.5-02 verification)', 'Fannie Mae B2-1.5-02', true, '{delivery}', 'policy', 'regz.qm.general.2021', '25.1', false),
  ('RESPA_8_UNEARNED_FEES', 'No unearned fees / splits', '12 CFR 1024.14(b)-(c)', true, '{cd,corrected_cd,delivery}', 'federal', 'respa.section8', '25.1', false),
  ('RESPA_8_AFBA_DISCLOSURE', 'Affiliated business arrangement disclosure', '12 CFR 1024.15', true, '{le,cd,corrected_cd}', 'federal', 'respa.section8', '25.1', false),
  ('RESPA_8_MSA_INVENTORY', 'MSA fair-market-value support', '12 CFR 1024.14(g); RESPA Section 8 FAQs', false, '{cd,corrected_cd}', 'policy', 'respa.section8', '25.1', true),
  ('FEE_REASONABLENESS', 'Bona fide and reasonable (c)(7) fees (W -> B when an exclusion depends on it)', '12 CFR 1026.4(c)(7); fee_benchmarks', false, '{cd,corrected_cd}', 'policy', 'regz.finance_charge.1026_4', '25.1', true),
  ('LOCOMP_1026_36D', 'Loan-originator compensation', '12 CFR 1026.36(d)', true, '{le,lock,cd,corrected_cd}', 'federal', 'regz.locomp.1026_36', '25.1', false),
  ('STEERING_1026_36E_OPTIONS', 'Anti-steering safe-harbor options', '12 CFR 1026.36(e)(2)-(3)', true, '{lock}', 'federal', 'regz.locomp.1026_36', '25.1', false),
  ('LO_QUAL_1026_36F', 'Loan-originator qualification', '12 CFR 1026.36(f)', true, '{le}', 'federal', 'nmls.licensing', '25.1', false),
  ('NMLSR_ID_1026_36G', 'Name and NMLSR ID on the 1003, LE, CD, note and security instrument', '12 CFR 1026.36(g)', true, '{le,cd,corrected_cd,consummation}', 'federal', 'regz.locomp.1026_36', '25.1', false),
  ('NMLS_LICENSE_COMPANY', 'Partner company license for the property state', 'SAFE Act; state law; NMLS', true, '{le,cd,corrected_cd}', 'federal', 'nmls.licensing', '25.1', false),
  ('NMLS_LICENSE_BRANCH', 'Branch license where the state licenses branches', 'state law; NMLS', true, '{le,cd,corrected_cd}', 'state', 'nmls.licensing', '25.1', false),
  ('NMLS_LICENSE_MLO', 'MLO of record license and sponsorship', '12 CFR 1008.103; 12 CFR 1026.36(f)(2)', true, '{le,cd,corrected_cd}', 'federal', 'nmls.licensing', '25.1', false),
  ('SM_STATE_PROCESSOR_LICENSE', 'SM third-party processor/underwriter license', '12 CFR 1008.103(d); jurisdiction_rules (31.1)', true, '{le}', 'state', 'nmls.licensing', '25.1', false),
  ('ESIGN_7001C_CONSENT', 'E-SIGN consent for electronic delivery', '15 U.S.C. 7001(c)(1)', true, '{le,cd,corrected_cd,consummation}', 'federal', 'esign.7001c', '25.1', false),
  ('TCPA_CONSENT_OUTBOUND', 'Prior express consent for AI-voice outbound contact', '47 CFR 64.1200; FCC 24-17', true, '{}', 'federal', 'tcpa.64_1200', '25.1', false),
  ('FAIR_LENDING_PRICING_EXCEPTION', 'No discretionary pricing', 'Reg B 1002.4; LL-2026-04', true, '{le,lock,cd,corrected_cd}', 'federal', 'regz.locomp.1026_36', '25.1', false),
  ('ARBITRATION_1026_36H', 'No mandatory arbitration clause', '12 CFR 1026.36(h)', true, '{consummation}', 'federal', 'regz.locomp.1026_36', '25.1', false),
  ('CREDIT_INSURANCE_1026_36I', 'No financed credit-insurance premiums', '12 CFR 1026.36(i)', true, '{consummation}', 'federal', 'regz.locomp.1026_36', '25.1', false),
  ('AI_DISCLOSURE_STATE', 'State AI-disclosure presence (31.2 owns content)', 'CO/CA/UT statutes via jurisdiction_rules', true, '{le,cd,corrected_cd}', 'state', 'state.ai_disclosure', '25.1', false);

-- ---------------------------------------------------------------- runs and tests
CREATE TABLE compliance_test_runs (
  run_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                uuid NOT NULL REFERENCES applications(id),
  loan_id                       uuid REFERENCES loans(id),                  -- set after funding (30.2)
  checkpoint                    text NOT NULL CHECK (checkpoint IN ('le', 'lock', 'revised_le', 'cd', 'corrected_cd', 'consummation', 'disbursement', 'delivery', 'post_closing_qc')),
  triggered_by_event_id         uuid REFERENCES loan_events(id),
  started_at                    timestamptz NOT NULL,
  completed_at                  timestamptz,
  rule_set_versions             jsonb NOT NULL DEFAULT '{}',              -- code -> version in force on the checkpoint date
  inputs_hash                   text NOT NULL,                             -- SHA-256 of the canonical input snapshot
  inputs_snapshot_document_id   uuid REFERENCES documents(id),             -- retention regz_cd_5y
  overall_result                text CHECK (overall_result IN ('pass', 'pass_with_warnings', 'fail', 'error')),
  blocking_failures             int NOT NULL DEFAULT 0,
  status                        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'passed_with_warnings', 'failed', 'errored', 'superseded')),
  agent_run_id                  text,
  superseded_by_run_id          uuid REFERENCES compliance_test_runs(run_id),
  created_at                    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE compliance_test_runs IS '25.1: one row per checkpoint evaluation; queued -> running -> {passed, passed_with_warnings, failed, errored}; any terminal run becomes superseded when an invalidating event arrives. Gate state is derived (open iff the latest non-superseded run passed within the freshness window: 24 h LE/lock, 4 h CD onward).';
CREATE INDEX compliance_test_runs_app_idx ON compliance_test_runs(application_id, checkpoint, started_at DESC);

CREATE TABLE compliance_tests (
  test_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES compliance_test_runs(run_id),
  test_code          text NOT NULL,                                        -- registry key (STATE_HIGH_COST_<ST> allowed)
  rule_set_version   text NOT NULL,
  jurisdiction       text NOT NULL,                                        -- US or state code
  inputs_hash        text NOT NULL,
  result             text NOT NULL CHECK (result IN ('pass', 'fail', 'warn', 'not_applicable', 'error')),
  blocking           boolean NOT NULL,
  measured_value     numeric,
  threshold_value    numeric,
  unit               text,
  message            text NOT NULL,
  evidence           jsonb NOT NULL DEFAULT '{}',                          -- citations, intermediate values, APOR table date, cure plan
  waiver_id          uuid,                                                 -- compliance_waivers (FK added below)
  retention_class    retention_class NOT NULL DEFAULT 'regz_cd_5y',        -- regz_atr_3y rows keep the longer class
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE compliance_tests IS '25.1: one row per test per run — measured value, threshold, citations and evidence; append-only (exam evidence; re-running a snapshot must yield identical rows).';
CREATE INDEX compliance_tests_run_idx ON compliance_tests(run_id, test_code);
CREATE TRIGGER compliance_tests_immutable BEFORE UPDATE OR DELETE ON compliance_tests FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- waivers (policy tests only; officer)
CREATE TABLE compliance_waivers (
  waiver_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       uuid NOT NULL REFERENCES compliance_tests(test_id),
  test_code     text NOT NULL REFERENCES compliance_test_definitions(test_code),
  kind          text NOT NULL DEFAULT 'policy_only' CHECK (kind = 'policy_only'),
  approved_by   text NOT NULL,                                             -- officer
  rationale     text NOT NULL,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE compliance_waivers IS '25.1: policy-only waivers attached by the partner officer; a legal test (compliance_test_definitions.waivable=false) can never carry one — enforced by the trigger below and by ops-25-1.ts requestWaiver.';
ALTER TABLE compliance_tests ADD CONSTRAINT compliance_tests_waiver_fk FOREIGN KEY (waiver_id) REFERENCES compliance_waivers(waiver_id);
CREATE OR REPLACE FUNCTION compliance_waiver_policy_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM compliance_test_definitions d WHERE d.test_code = NEW.test_code AND d.waivable) THEN
    RAISE EXCEPTION 'compliance test % is a legal test (waivable=false) - no waiver may be attached', NEW.test_code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_waivers_policy_only BEFORE INSERT ON compliance_waivers FOR EACH ROW EXECUTE FUNCTION compliance_waiver_policy_only();
CREATE TRIGGER compliance_waivers_immutable BEFORE UPDATE OR DELETE ON compliance_waivers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- finance-charge classification and fee benchmarks
CREATE TABLE fee_benchmarks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state         char(2) NOT NULL,
  county        text,
  service_code  text NOT NULL,                                             -- MISMO loan-cost taxonomy
  low_cents     bigint NOT NULL CHECK (low_cents >= 0),
  high_cents    bigint NOT NULL CHECK (high_cents >= low_cents),
  source        text NOT NULL,
  as_of         date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE fee_benchmarks IS '25.1: bands by state/county/service (SM transaction history + vendor fee schedules, refreshed quarterly; decision 25.1-Q5 +/-25% of the median) for the FEE_REASONABLENESS test that conditions the 1026.4(c)(7) exclusions.';
CREATE INDEX fee_benchmarks_lookup_idx ON fee_benchmarks(state, service_code, county);

CREATE TABLE finance_charge_classifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid REFERENCES compliance_test_runs(run_id),
  application_id     uuid NOT NULL REFERENCES applications(id),
  fee_item_id        uuid NOT NULL,                                        -- fee_items (21.2; FK added when that table lands)
  classification     text NOT NULL CHECK (classification IN ('finance_charge', 'prepaid_finance_charge', 'excluded_c1', 'excluded_c2', 'excluded_c5', 'excluded_c7i', 'excluded_c7ii', 'excluded_c7iii', 'excluded_c7iv', 'excluded_c7v', 'excluded_d', 'excluded_e1', 'excluded_e2', 'excluded_e3', 'conditional_a2')),
  basis_citation     text NOT NULL,
  rationale          text NOT NULL,
  reasonable         boolean,                                              -- fee-reasonableness result feeding (c)(7)
  rule_set_version   text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE finance_charge_classifications IS '25.1: the 1026.4 classification of every fee item with its citation (rule set regz.finance_charge.1026_4); conditional_a2 flips to finance_charge when the creditor requires the agent/charge or retains a portion; append-only per run.';
CREATE INDEX finance_charge_classifications_app_idx ON finance_charge_classifications(application_id, fee_item_id);
CREATE TRIGGER finance_charge_classifications_immutable BEFORE UPDATE OR DELETE ON finance_charge_classifications FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- licensing evidence
CREATE TABLE license_checks (
  check_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_type            text NOT NULL CHECK (party_type IN ('company', 'branch', 'individual')),
  party_ref             text NOT NULL,                                     -- partner id / branch id / mlo_of_record_id
  nmls_id               text NOT NULL,
  state                 char(2) NOT NULL,
  license_type          text NOT NULL,
  status                text NOT NULL CHECK (status IN ('approved', 'approved_conditions', 'pending', 'inactive', 'expired', 'revoked', 'not_found')),
  sponsorship_ok        boolean,                                           -- individual sponsored by the partner
  checked_at            timestamptz NOT NULL,
  valid_through         date,
  source                text NOT NULL CHECK (source IN ('nmls_b2b', 'nmls_consumer_access_manual')),
  evidence_document_id  uuid REFERENCES documents(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE license_checks IS '25.1: NMLS company/branch/individual license evidence per property state (B2B feed nightly or manual Consumer Access lookups every 30 days); a row older than 30 days counts as not_found (SM_O61_LICENSE_CHECK_REFRESH_30). Append-only.';
CREATE INDEX license_checks_party_idx ON license_checks(party_type, party_ref, state, checked_at DESC);
CREATE TRIGGER license_checks_immutable BEFORE UPDATE OR DELETE ON license_checks FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- fair-lending pricing exceptions
CREATE TABLE pricing_exception_reviews (
  review_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id),
  deviation_ref   text NOT NULL,                                           -- the pricing_quotes / locks row that deviates from rate_sheets
  deviation_bps   numeric(9,2) NOT NULL,
  reason_code     text NOT NULL CHECK (reason_code IN ('tolerance_cure', 'corrective_action', 'program_rule', 'rate_passthrough_recompute', 'lock_policy', 'documented_error_correction')),
  discretionary   boolean NOT NULL DEFAULT false CHECK (discretionary = false),   -- discretionary pricing is not a legal value (25.1-T9)
  reviewed_by     text NOT NULL,                                           -- agent run id or officer
  result          text NOT NULL CHECK (result IN ('approved', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pricing_exception_reviews IS '25.1: every deviation between the quoted/locked price and rate_sheets carries a non-discretionary reason code (FAIR_LENDING_PRICING_EXCEPTION); 31.2 monitors the aggregate. CHECK (discretionary = false). Append-only.';
CREATE INDEX pricing_exception_reviews_app_idx ON pricing_exception_reviews(application_id, created_at);
CREATE TRIGGER pricing_exception_reviews_immutable BEFORE UPDATE OR DELETE ON pricing_exception_reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
