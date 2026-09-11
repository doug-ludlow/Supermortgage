-- 0087_atr_qm_determinations.sql — §23.4 ATR/QM, HPML, HOEPA and state high-cost determinations
-- (spec/sections/23-…/23-4-atr-qm-hpml-hoepa-and-state-high-cost-determinations.md "Data model"; addendum §3).
-- Owned here: apor_tables, qm_determinations, hpml_determinations, high_cost_determinations — 25.1's 0069 named them as
-- 23.4's and did not create them. Not here (other owners, never duplicated): apr_calculations (0064), fee_items /
-- disclosures (21.2), locks (0066), compliance_test_runs / compliance_tests (0069), escrow_accounts.hpml_escrow_min_cancel_date
-- (0060 — 30.3 writes it from hpml_determinations), credit_reports (0079). Every stage row is immutable (state machine:
-- "each stage row is immutable; the current determination is the latest stage") — 0001's forbid_mutation trigger; a
-- relock supersedes a lock-stage row by a new row with `status = 'superseded'` on the old one via a fresh insert, never
-- an update (see supersede() in src/domain/underwriting/ops-23-4.ts). Retention class regz_atr_3y (§1026.25(c)(3)).
BEGIN;

-- ---------------------------------------------------------------- APOR snapshots (FFIEC weekly tables; FFIEC_APOR_TABLE_REFRESH_WEEKLY)
CREATE TABLE apor_tables (
  table_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  published_on         date NOT NULL,                                     -- FFIEC posting date (Thursday)
  effective_week       date NOT NULL,                                     -- the Monday the table is dated and effective
  type                 text NOT NULL CHECK (type IN ('fixed', 'adjustable')),
  rows                 jsonb NOT NULL,                                    -- term (years; initial fixed period for ARMs) → APOR as text, e.g. {"30": "6.020"}
  source_url           text NOT NULL,
  fetched_at           timestamptz NOT NULL,
  hash                 text NOT NULL,                                     -- idempotency by table hash (Integrations)
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (effective_week, type, hash)
);
COMMENT ON TABLE apor_tables IS '23.4 apor_tables: weekly FFIEC APOR table snapshots (fixed / adjustable) keyed by the effective Monday; the row a determination cites is the table current on the rate-set date (apor.table.ingested{table_date}); part of the §1026.25(c)(3) evidence.';
CREATE INDEX apor_tables_week_idx ON apor_tables (type, effective_week DESC);
CREATE TRIGGER apor_tables_immutable BEFORE UPDATE OR DELETE ON apor_tables FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- qm_determinations (one row per application and stage; relocks insert a superseding row)
CREATE TABLE qm_determinations (
  determination_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                    uuid NOT NULL REFERENCES applications(id),
  loan_id                           uuid REFERENCES loans(id),                    -- set on post_closing rows after 30.2's hand-off
  stage                             text NOT NULL CHECK (stage IN ('le', 'lock', 'cd', 'consummation', 'post_closing')),
  status                            text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
  supersedes_determination_id       uuid REFERENCES qm_determinations(determination_id),
  apr_calculation_id                uuid REFERENCES apr_calculations(id),         -- 25.1's engine row (23.4 never computes APR)
  apr                               numeric(7,4) NOT NULL,
  rate_set_date                     date NOT NULL,                                -- locks.locked_at::date of the last rate-setting lock (relock / float-down resets it)
  lock_id                           uuid REFERENCES locks(lock_id),
  apor_table_id                     uuid REFERENCES apor_tables(table_id),
  apor_source                       text NOT NULL CHECK (apor_source IN ('ffiec_table', 'rate_spread_api')),
  apor                              numeric(7,4),
  apor_stale                        boolean NOT NULL DEFAULT false,
  blocked_reason                    text,                                         -- apor_stale / apor_missing: the determination is blocked, qm_type null
  spread                            numeric(7,4),                                 -- round(apr − apor, 3)
  loan_amount_cents                 bigint NOT NULL CHECK (loan_amount_cents > 0),
  amount_financed_cents             bigint NOT NULL,
  total_loan_amount_cents           bigint NOT NULL,                              -- §1026.32(b)(4)(i): amount financed − financed (iii)/(iv)/(vi) items included in points and fees
  apr_tier                          text NOT NULL CHECK (apr_tier IN ('first_lien_ge_137958', 'first_lien_82775_137957', 'first_lien_lt_82775', 'mh_lt_137958', 'sub_ge_82775', 'sub_lt_82775')),
  apr_threshold_pts                 numeric(4,2) NOT NULL,
  apr_test_pass                     boolean,
  pf_tier                           text NOT NULL CHECK (pf_tier IN ('pct3_ge_137958', 'usd4139_82775_137957', 'pct5_27592_82774', 'usd1380_17245_27591', 'pct8_lt_17245')),
  cap_cents                         bigint NOT NULL,                              -- floor(total_loan_amount_cents × pct / 100) for the percentage tiers (rule 3)
  points_and_fees_cents             bigint NOT NULL,
  pf_pass                           boolean NOT NULL,
  pf_items                          jsonb NOT NULL,                               -- [{fee_item_id, description, amount_cents, payee, category ∈ b1_i…b1_vi, included, exclusion ∈ {interest, agency_mi, pmi_at_or_below_fha, pmi_after_consummation, bona_fide_third_party, bona_fide_discount_2, bona_fide_discount_1, creditor_employee_comp, reasonable_no_comp_not_affiliate, not_finance_charge, null}}]
  bona_fide_discount_points_excluded_cents bigint NOT NULL DEFAULT 0,
  undiscounted_rate                 numeric(7,4),                                 -- 20.4 pricing_quotes at the rate-set date (evidence for (b)(1)(i)(E)/(F))
  product_tests                     jsonb NOT NULL,                               -- {term_le_30y, no_negam, no_io, no_balloon, substantially_equal, max_rate_5y_underwriting}
  consider_verify                   jsonb NOT NULL,                               -- the eight §1026.43(c)(2) factors: [{factor, value, evidence_refs[], verification_standard_ref}]
  consider_verify_complete          boolean NOT NULL,
  hpct                              boolean,                                      -- spread ≥ 1.5 (first lien) / 3.5 (subordinate) — §1026.43(b)(4)
  hpct_threshold_pts                numeric(4,2) NOT NULL,
  qm_type                           text CHECK (qm_type IN ('general_safe_harbor', 'general_rebuttable', 'not_qm')),
  fnma_spread_ok                    boolean,                                      -- B2-1.5-02: spread ≤ 2.25
  cure_required_cents               bigint,                                       -- post_closing excess: remediation refund only (no §1026.43(e)(3)(iii) cure for loans consummated after 2021-01-10)
  cure_deadline                     date,                                         -- always null for platform loans (the 210-day cure sunset)
  cure_paid_at                      timestamptz,
  computed_from_final_cd            boolean NOT NULL DEFAULT false,
  determined_at                     timestamptz NOT NULL,
  rule_set_versions                 jsonb NOT NULL,                               -- {regz.qm.general.2021: '2026', regz.hpml: '2026', regz.hoepa: '2026', …}
  agent_decision_id                 uuid REFERENCES agent_decisions(id),
  retention_class                   text NOT NULL DEFAULT 'regz_atr_3y',
  created_at                        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE qm_determinations IS '23.4 qm_determinations: the General QM / ATR determination per application and stage (le → lock → cd → consummation → post_closing; the current row is the latest stage; a relock inserts a superseding lock row). Immutable; §1026.25(c)(3) evidence (regz_atr_3y).';
CREATE INDEX qm_determinations_app_stage_idx ON qm_determinations (application_id, stage, determined_at DESC);
CREATE TRIGGER qm_determinations_immutable BEFORE UPDATE OR DELETE ON qm_determinations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- hpml_determinations (§1026.35)
CREATE TABLE hpml_determinations (
  determination_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id                         uuid NOT NULL REFERENCES applications(id),
  loan_id                                uuid REFERENCES loans(id),
  stage                                  text NOT NULL CHECK (stage IN ('le', 'lock', 'cd', 'consummation', 'post_closing')),
  qm_determination_id                    uuid REFERENCES qm_determinations(determination_id),
  apr                                    numeric(7,4) NOT NULL,
  apor                                   numeric(7,4),
  rate_set_date                          date NOT NULL,
  spread                                 numeric(7,4),
  lien                                   text NOT NULL CHECK (lien IN ('first', 'subordinate')),
  above_conforming                       boolean NOT NULL,                         -- loan amount > fnma.limits.2026 conforming limit → 2.5 threshold
  threshold_pts                          numeric(4,2) NOT NULL CHECK (threshold_pts IN (1.5, 2.5, 3.5)),
  is_hpml                                boolean,
  principal_dwelling                     boolean NOT NULL,
  escrow_required                        boolean NOT NULL,                         -- is_hpml AND first lien AND principal dwelling (§1026.35(b)(1))
  escrow_established_before_consummation boolean,                                  -- 30.3's escrow.initial_analysis.approved{hpml=true}
  escrow_waiver_elected                  boolean NOT NULL DEFAULT false,           -- refused on an HPML (REGZ_1026_35B1_HPML_ESCROW_GATE)
  escrow_min_cancel_date                 date,                                     -- consummation + 5 years (§1026.35(b)(3)(i)(B)); copied to escrow_accounts.hpml_escrow_min_cancel_date by 30.3
  appraisal_rules_apply                  boolean NOT NULL,                         -- is_hpml AND qm_type = not_qm AND loan_amount > $34,200 (2026) — 24.2 applies §1026.35(c)
  flip_check                             jsonb,                                    -- from 24.2: seller acquisition date/price, contract date/price, second appraisal required
  small_creditor_exempt                  boolean NOT NULL DEFAULT false CHECK (small_creditor_exempt = false),   -- always false for an escrowing lender ((b)(2)(iii)(D))
  determined_at                          timestamptz NOT NULL,
  rule_set_versions                      jsonb NOT NULL,
  retention_class                        text NOT NULL DEFAULT 'regz_atr_3y',
  created_at                             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE hpml_determinations IS '23.4 hpml_determinations: the §1026.35 higher-priced mortgage loan determination per stage (APOR + 1.5 / 2.5 / 3.5 as of the rate-set date), the escrow mandate and five-year cancellation floor, and the appraisal-rule applicability 24.2 reads. Immutable.';
CREATE INDEX hpml_determinations_app_stage_idx ON hpml_determinations (application_id, stage, determined_at DESC);
CREATE TRIGGER hpml_determinations_immutable BEFORE UPDATE OR DELETE ON hpml_determinations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- high_cost_determinations (§1026.32 HOEPA and state statutes)
CREATE TABLE high_cost_determinations (
  determination_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id         uuid NOT NULL REFERENCES applications(id),
  loan_id                uuid REFERENCES loans(id),
  stage                  text NOT NULL CHECK (stage IN ('le', 'lock', 'cd', 'consummation', 'post_closing')),
  qm_determination_id    uuid REFERENCES qm_determinations(determination_id),
  hoepa                  jsonb NOT NULL,                       -- {apr_test:{threshold_pts (6.5|8.5), spread, fail}, pf_test:{base_cents, threshold_cents, pf_cents, fail}, ppp_test:{fail}}
  is_hoepa               boolean NOT NULL,
  state_tests            jsonb NOT NULL,                       -- [{state, statute, definition, applies_by_size, size_cap_cents, reference_rate_series ∈ {treasury_yield, apor, pmms_ne, hoepa_ref}, apr_test:{threshold, reference_value, spread, fail}, pf_test:{threshold_pct, threshold_cents, pf_cents, fail}, other_tests, result ∈ {not_applicable, pass, fail}, fnma_ineligible_if_fail, state_pf_definition_unverified}]
  is_state_high_cost     boolean NOT NULL,
  fnma_eligible          boolean NOT NULL,                     -- B2-1.5-02 / A3-2-02: not HOEPA, no listed state fail, spread ≤ 2.25, points and fees within the cap
  fnma_ineligibility_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  determined_at          timestamptz NOT NULL,
  rule_set_versions      jsonb NOT NULL,
  retention_class        text NOT NULL DEFAULT 'regz_atr_3y',
  created_at             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE high_cost_determinations IS '23.4 high_cost_determinations: the HOEPA (§1026.32(a)(1)) and state high-cost / predatory-statute tests per stage with the Fannie Mae eligibility flag (B2-1.5-02 state higher-priced loans table). A true is_hoepa or a listed-state fail is a hard block (REGZ_1026_32_HOEPA_GATE / STATE_HIGH_COST_GATE). Immutable.';
CREATE INDEX high_cost_determinations_app_stage_idx ON high_cost_determinations (application_id, stage, determined_at DESC);
CREATE TRIGGER high_cost_determinations_immutable BEFORE UPDATE OR DELETE ON high_cost_determinations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
