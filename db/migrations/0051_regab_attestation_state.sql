-- 0051: §18.6 data model corrections on the four Reg AB tables created by 0021 (append-only: 0021 is applied, so
-- the changes are ALTERs here).
--   attestation_packages.status — the spec's state machine `planned → evidence_compiled → walkthroughs → testing (auditor)
--     → exceptions_evaluated → assertion_signed → attestation_received → delivered → closed` plus the
--     `material_noncompliance_disclosed` branch (0021 carried draft/evidence_complete/auditor_engaged, which the
--     SM_ATTEST_EVIDENCE_COMPILE_FYE_15 satisfier `status=evidence_compiled` could never write);
--   assessment period (rule 4): the *issuer's* PSA year may straddle calendar years, so the package carries
--     period_start/period_end beside fiscal_year;
--   the officer signature record `assertion_signed` requires (18.6-T7; signed_by_officer_id was already there);
--   control_matrix versions (edge case "mid-year platform changes: control descriptions versioned");
--   retention corporate_7y on all four tables (data-model bullet "Retention corporate_7y").
BEGIN;

-- ---- attestation_packages: state machine, assessment period, officer signature record, retention ------------------
ALTER TABLE attestation_packages DROP CONSTRAINT attestation_packages_status_check;
UPDATE attestation_packages SET status = CASE status WHEN 'draft' THEN 'planned' WHEN 'evidence_complete' THEN 'evidence_compiled' WHEN 'auditor_engaged' THEN 'testing' ELSE status END;
ALTER TABLE attestation_packages ALTER COLUMN status SET DEFAULT 'planned';
ALTER TABLE attestation_packages ADD CONSTRAINT attestation_packages_status_check
  CHECK (status IN ('planned', 'evidence_compiled', 'walkthroughs', 'testing', 'exceptions_evaluated', 'material_noncompliance_disclosed', 'assertion_signed', 'attestation_received', 'delivered', 'closed'));
ALTER TABLE attestation_packages
  ADD COLUMN period_start    date,                                              -- rule 4: issuer PSA period (may differ from Supermortgage's fiscal year)
  ADD COLUMN period_end      date,
  ADD COLUMN signed_by_role  text CHECK (signed_by_role IS NULL OR signed_by_role = 'officer'),
  ADD COLUMN signed_at       timestamptz,
  ADD COLUMN retention       retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE attestation_packages ADD CONSTRAINT attestation_packages_period_check CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end);
-- 18.6-T7: no package is assertion_signed (or beyond) without an officer signature record
ALTER TABLE attestation_packages ADD CONSTRAINT attestation_packages_assertion_signed_officer
  CHECK (status NOT IN ('assertion_signed', 'attestation_received', 'delivered', 'closed')
         OR (signed_by_officer_id IS NOT NULL AND signed_by_role = 'officer' AND signed_at IS NOT NULL AND management_assertion_document_id IS NOT NULL));
COMMENT ON TABLE attestation_packages IS '§18.6 attestation package (1122 assessment / 1123 statement / SOC 1 Type II / USAP): issuer-period scope, material noncompliance list, officer signature record, auditor report, delivery; status follows the §18.6 state machine (17 CFR 229.1122–1123).';
COMMENT ON COLUMN attestation_packages.status IS '§18.6 state machine: planned → evidence_compiled → walkthroughs → testing → exceptions_evaluated → assertion_signed → attestation_received → delivered → closed; material_noncompliance_disclosed branch.';
COMMENT ON COLUMN attestation_packages.period_start IS '§18.6 rule 4: the assessment covers the issuer''s reporting period (PSA), not necessarily Supermortgage''s fiscal year.';
COMMENT ON COLUMN attestation_packages.signed_by_role IS '18.6-T7: management assertions and 1123 statements are officer acts — the agent never signs or asserts.';

-- ---- control_matrix: versioned control descriptions, retention ------------------------------------------------------
ALTER TABLE control_matrix DROP CONSTRAINT control_matrix_pkey;
ALTER TABLE control_matrix
  ADD COLUMN version         int NOT NULL DEFAULT 1,
  ADD COLUMN effective_from  date,
  ADD COLUMN effective_to    date,
  ADD COLUMN retention       retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE control_matrix ADD PRIMARY KEY (criterion, control_code, version);
ALTER TABLE control_matrix ADD CONSTRAINT control_matrix_frequency_check CHECK (frequency IS NULL OR frequency IN ('monthly', 'quarterly', 'annual', 'event'));
COMMENT ON TABLE control_matrix IS '§18.6 control matrix: each 1122(d) criterion mapped to platform controls with owner, evidence query, 18.1 rule codes and frequency; versioned so the auditor can test both periods after a mid-year change.';

-- ---- control_evidence / investor_programs: retention -------------------------------------------------------------------
ALTER TABLE control_evidence ADD COLUMN retention retention_class NOT NULL DEFAULT 'corporate_7y';
ALTER TABLE control_evidence ADD COLUMN complete boolean;
COMMENT ON COLUMN control_evidence.complete IS '§18.6 rule 4: evidence present for every expected period of the control''s frequency inside the window (SM_ATTEST_EVIDENCE_COMPILE_FYE_15).';
ALTER TABLE investor_programs ADD COLUMN retention retention_class NOT NULL DEFAULT 'corporate_7y';
COMMENT ON TABLE investor_programs IS '§18.6 applicability per investor program: regab_applicable (12 U.S.C. 1719(d) exempts Fannie Mae), usap_requested, PSA deliverable rule, applicable 1122(d) criteria.';

-- ---- persistence for every row the 18.6 tools and reactor write (src/app/tools/section18-6.ts) ----------------------------
-- account → program mapping: REGAB_1122_2VII_RECON_ITEMS_90 arms only for items on accounts of a regab_applicable program
-- (Item 1122(d)(2)(vii) "all ABS bank accounts"; 18.6-T1 a Fannie Mae account never starts a REGAB_* clock; 18.6-T4)
ALTER TABLE custodial_accounts ADD COLUMN investor_program_id uuid REFERENCES investor_programs(id);
COMMENT ON COLUMN custodial_accounts.investor_program_id IS '§18.6: the investor program whose regab_applicable flag decides whether reconciling items on this account start the Reg AB (2)(vii) clock.';
ALTER TABLE investor_programs
  ADD COLUMN custodial_account_ids uuid[] NOT NULL DEFAULT '{}',   -- the same mapping as recorded at onboarding (investor_program.create)
  ADD COLUMN applicability_basis  text,                             -- rule 18.6-1 citation the determination rests on
  ADD COLUMN deliverables         text[] NOT NULL DEFAULT '{}';     -- the attestation_packages.kind values a cycle opens for the program
-- attestation_packages: the cycle (entity:program:FYE) and program the package belongs to, and the partner it is delivered to
ALTER TABLE attestation_packages
  ADD COLUMN cycle_id       text,
  ADD COLUMN program_id     uuid REFERENCES investor_programs(id),
  ADD COLUMN partner_entity text;
-- control_evidence: the package a binder was generated for, the criterion, the frequency bookkeeping (rule 4) and the hashes of the
-- cited documents ("evidence binders with hashes"; a binder cites only documents on file)
ALTER TABLE control_evidence
  ADD COLUMN package_id              uuid REFERENCES attestation_packages(id),
  ADD COLUMN criterion               text,
  ADD COLUMN expected_count          int,
  ADD COLUMN missing_periods         text[] NOT NULL DEFAULT '{}',
  ADD COLUMN evidence_document_sha256 text[] NOT NULL DEFAULT '{}';
-- the Reg AB exception register (guardrail: "exception omissions are impossible by construction — every 18.1 finding tagged to a
-- criterion appears in the exception list until dispositioned by the officer"; 18.6-T3/T4). Distinct from §17's control_exceptions
-- (security-control waivers, 0022). One register for every package: no package scoping column, so a row can neither be hidden from
-- one package's list nor stay open for another once the officer has dispositioned it. Append-only: rows are never deleted, their
-- identity never changes, and the only update is the officer's disposition (which is never undone).
CREATE TABLE regab_control_exceptions (
  finding_id          text PRIMARY KEY,                                      -- the qc_findings id, or TB-<timer_code>-<subject_id> for a timer breach
  criterion           text NOT NULL,                                         -- 1122.d.<n>.<roman>
  severity            text NOT NULL,
  description         text NOT NULL,
  source              text NOT NULL CHECK (source IN ('finding', 'timer_breach')),
  timer_code          text,
  timer_id            uuid,
  account_id          uuid REFERENCES custodial_accounts(id),
  program_id          uuid REFERENCES investor_programs(id),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dispositioned')),
  officer_disposition jsonb,                                                 -- {officer_id, disposition}
  dispositioned_at    timestamptz,
  recorded_by         text NOT NULL,                                         -- system:* for the reactor's timer breaches, agent:qc-audit for an explicit record
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  retention           retention_class NOT NULL DEFAULT 'corporate_7y',
  CONSTRAINT regab_control_exceptions_disposition_check CHECK (status = 'open' OR (officer_disposition IS NOT NULL AND dispositioned_at IS NOT NULL))
);
CREATE OR REPLACE FUNCTION regab_control_exceptions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'regab_control_exceptions is append-only: an exception leaves the open list only on an officer disposition (18.6)'; END IF;
  IF NEW.finding_id <> OLD.finding_id OR NEW.criterion <> OLD.criterion OR NEW.severity <> OLD.severity OR NEW.description <> OLD.description OR NEW.source <> OLD.source
     OR NEW.recorded_at <> OLD.recorded_at OR NEW.recorded_by <> OLD.recorded_by THEN
    RAISE EXCEPTION 'regab_control_exceptions is append-only: a recorded exception is never re-recorded (18.6)';
  END IF;
  IF OLD.status = 'dispositioned' AND (NEW.status <> 'dispositioned' OR NEW.officer_disposition IS DISTINCT FROM OLD.officer_disposition) THEN
    RAISE EXCEPTION 'regab_control_exceptions: an officer disposition is never undone (18.6)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER regab_control_exceptions_guard BEFORE UPDATE OR DELETE ON regab_control_exceptions FOR EACH ROW EXECUTE FUNCTION regab_control_exceptions_guard();
CREATE INDEX regab_control_exceptions_open_idx ON regab_control_exceptions(criterion) WHERE status = 'open';
COMMENT ON TABLE regab_control_exceptions IS '§18.6 exception register: every 18.1 finding tagged to a 1122(d) criterion and every REGAB_* timer breach, open until the officer dispositions it; one register for every attestation package (17 CFR 229.1122(a)(3)).';

COMMIT;
