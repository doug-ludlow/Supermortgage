-- 0067_tolerance_tests_cures.sql — §21.5 changed circumstances, revised Loan Estimates and tolerance management
-- (spec/sections/21-application-urla-initial-disclosures-intent-to-proceed-rate/21-5-*.md "Data model"; addendum §3 "Disclosures and fees").
-- `tolerance_tests` (baseline; defined here) and `tolerance_cures` (new). `changed_circumstances` is 0066's (21.4 inserts kind=rate_lock /
-- borrower_request; 21.5 owns the semantics — its columns already carry basis, information_received_at, ten_pct_threshold_test, valid,
-- invalid_reason, reflected_on, baseline_reset); `fee_items` / `disclosures` are 0064's (fee_items.changed_circumstance_id, baseline columns).
-- Ledger accounts `tolerance_cure_expense` and `borrower_refunds_payable` (baseline §5, added by 21.5) are posted through ledger_entry_sets.
BEGIN;

-- ---------------------------------------------------------------- tolerance tests (one row per run at every stage; 25.1 back-references it)
CREATE TABLE tolerance_tests (
  test_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  stage                       text NOT NULL CHECK (stage IN ('le_revision', 'cd_initial', 'cd_corrected', 'pre_funding', 'post_consummation', 'qc')),
  run_at                      timestamptz NOT NULL,
  baseline_snapshot_id        text NOT NULL,                                     -- the fee_items baselines in force (initial LE id + reset cc ids)
  comparison_disclosure_id    uuid NOT NULL REFERENCES disclosures(id),          -- the LE/CD version tested
  zero_results                jsonb NOT NULL DEFAULT '[]',                       -- [{fee_item_id, baseline_cents, actual_cents, excess_cents}]
  lender_credit_result        jsonb NOT NULL,                                    -- {baseline_cents, actual_cents, shortfall_cents} (comment 19(e)(3)(i)-5: downward = increase)
  ten_pct_result              jsonb NOT NULL,                                    -- {items[], baseline_sum_cents, actual_sum_cents, limit_cents = floor(baseline × 110/100), excess_cents}
  unlimited_results           jsonb NOT NULL DEFAULT '[]',                       -- [{fee_item_id, baseline_cents, actual_cents, estimate_source, estimated_at, reasonableness}]
  total_excess_cents          bigint NOT NULL CHECK (total_excess_cents >= 0),   -- Σ zero excess + lender-credit shortfall + ten-percent excess (rule 9)
  status                      text NOT NULL CHECK (status IN ('pass', 'cure_required', 'cured_at_closing', 'refund_required', 'refunded', 'escalated')),
  cure_route                  text NOT NULL DEFAULT 'none' CHECK (cure_route IN ('none', 'lender_credit_at_closing', 'refund_post_consummation')),
  review_threshold_cents      bigint NOT NULL DEFAULT 50000,                     -- rule_sets.cure_review_threshold_cents ($500): above it → escalated to compliance-sentinel (SM_TOLERANCE_CURE_REVIEW_SLA_1BD)
  compliance_test_run_id      uuid,                                              -- 25.1 compliance_test_runs back-reference (FK not declared: 0069 builds in parallel)
  engine_version              text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tolerance_tests_status_route CHECK ((total_excess_cents = 0 AND status = 'pass' AND cure_route = 'none') OR (total_excess_cents > 0 AND status <> 'pass' AND cure_route <> 'none'))
);
COMMENT ON TABLE tolerance_tests IS '21.5: the good-faith test (12 CFR 1026.19(e)(3)(i)–(iii)) run at every LE/CD stage with the full item-level arithmetic; results are immutable — only status (pass → cure_required → cured_at_closing | refund_required → refunded; escalated) and the 25.1 back-reference move.';
CREATE INDEX tolerance_tests_application_idx ON tolerance_tests(application_id, run_at);
CREATE OR REPLACE FUNCTION tolerance_tests_results_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'tolerance_tests is append-only (21.5 audit and evidence)'; END IF;
  IF NEW.application_id <> OLD.application_id OR NEW.stage <> OLD.stage OR NEW.run_at <> OLD.run_at OR NEW.baseline_snapshot_id <> OLD.baseline_snapshot_id OR NEW.comparison_disclosure_id <> OLD.comparison_disclosure_id
     OR NEW.zero_results <> OLD.zero_results OR NEW.lender_credit_result <> OLD.lender_credit_result OR NEW.ten_pct_result <> OLD.ten_pct_result OR NEW.unlimited_results <> OLD.unlimited_results
     OR NEW.total_excess_cents <> OLD.total_excess_cents OR NEW.cure_route <> OLD.cure_route OR NEW.engine_version <> OLD.engine_version THEN
    RAISE EXCEPTION 'tolerance_tests results are immutable: re-run the test (inputs + engine_version → identical result)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tolerance_tests_results_immutable BEFORE UPDATE OR DELETE ON tolerance_tests FOR EACH ROW EXECUTE FUNCTION tolerance_tests_results_immutable();

-- ---------------------------------------------------------------- cures: the lender credit at closing or the post-consummation refund (§1026.19(f)(2)(v))
CREATE TABLE tolerance_cures (
  cure_id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id),
  test_id                     uuid NOT NULL REFERENCES tolerance_tests(test_id),
  amount_cents                bigint NOT NULL CHECK (amount_cents > 0),
  method                      text NOT NULL CHECK (method IN ('lender_credit_at_closing', 'refund_post_consummation')),
  funded_by                   text NOT NULL CHECK (funded_by IN ('sm', 'partner')),   -- rule 10 / term sheet: SM's estimation or vendor cause vs partner-controlled charges
  posted_at                   timestamptz NOT NULL,
  cd_disclosure_id            uuid REFERENCES disclosures(id),                   -- the CD / corrected CD showing the credit or refund (25.2)
  cd_statement                text NOT NULL,                                     -- §1026.38(h)(3): "Includes $X.XX credit for increase in closing costs above legal limit"
  refund_instrument           text CHECK (refund_instrument IN ('ach', 'check')),
  refund_sent_at              timestamptz,
  refund_due_on               date,                                              -- consummation + 60 calendar days (REGZ_1026_19F2V_TOLERANCE_REFUND_60)
  refund_released_by          text,                                              -- partner officer (human) — never an agent
  corrected_cd_delivered_at   timestamptz,                                       -- 25.2 disclosure.cd.corrected{reason=tolerance_refund}; both duties close the timer
  ledger_entry_id             uuid NOT NULL REFERENCES ledger_entry_sets(id),    -- tolerance_cure_expense / borrower_refunds_payable (baseline §5)
  refund_ledger_entry_id      uuid REFERENCES ledger_entry_sets(id),             -- borrower_refunds_payable cleared against corporate cash
  changed_circumstance_ids    uuid[] NOT NULL DEFAULT '{}',                      -- the invalid / late rows whose increase is being cured (changed_circumstances.cc_id, 0066)
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tolerance_cures_refund_fields CHECK (method <> 'refund_post_consummation' OR (refund_instrument IS NOT NULL AND refund_due_on IS NOT NULL)),
  CONSTRAINT tolerance_cures_closing_fields CHECK (method <> 'lender_credit_at_closing' OR cd_disclosure_id IS NOT NULL)
);
COMMENT ON TABLE tolerance_cures IS '21.5 rule 9: the closing-table cure (a lender credit equal to the excess; cash to close falls by cure_cents) or, for an excess discovered after consummation, the refund by ACH/check within 60 days with 25.2''s corrected CD by the same date — never funded by the borrower; the cause feeds the fair-lending and QC registers.';
CREATE INDEX tolerance_cures_application_idx ON tolerance_cures(application_id, posted_at);
CREATE UNIQUE INDEX tolerance_cures_test_idx ON tolerance_cures(test_id);

COMMIT;
