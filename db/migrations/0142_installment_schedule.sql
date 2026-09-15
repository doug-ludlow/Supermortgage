-- 0142 — 35.5 "The installment schedule and the daily cashiering cycle" (spec/sections/35-operations-runtime/35-5-*.md, Data model):
-- the schedule 2.1 declares as a projection is written at boarding (rule 1) and re-projected on every terms change (rule 3);
-- the per-loan servicing configuration (rule 9) and the effective-dated servicer profile replace the two runtime constants.
--
--   loan_installments          baseline 0003:105, extended: sequence, upb_before/after, rate_bps, terms_id, schedule_run_id,
--                              satisfied_by_payment_id, absorbs_rounding, interest_variance_cents. Mutable in exactly the columns the
--                              state machine moves (status, satisfied_on, credited_as_of, satisfied_by_payment_id, late_charge_state,
--                              interest_variance_cents, updated_at); a money / terms column of a `satisfied` or `prepaid` row is frozen
--                              (SATISFIED_ROW_FROZEN — rule 3: "a satisfied row changes only through 2.1's reversal"); DELETE is refused
--                              always (a reprojection replaces `due` rows by INSERT … ON CONFLICT and records the prior values in
--                              installment_schedule_runs.replaced).
--   installment_schedule_runs  append-only: one row per schedule write (fund | transfer | reprojection | correction) with the run's
--                              arithmetic, the sha256 of the written rows and the decision that wrote it.
--   servicer_profiles          append-only versions: exactly one `active` version per servicing party at any date (btree_gist
--                              exclusion over the effective range); UPDATE may move only `status` and `effective_to` (the `timers`
--                              precedent of a state column beside otherwise-frozen facts), DELETE never.
--   loan_servicing_configs     append-only, effective-dated: the latest row by effective_from ≤ today is the loan's configuration.
--
-- FK deferrals (35.5 plan D5): loan_installments.satisfied_by_payment_id is a plain uuid — no typed `payments` row exists before
-- 35.1's projector keeps a uuid legacy id as the typed id; 35.1 adds the FK. installment_schedule_runs.trigger_event_id is a plain
-- uuid (the transfer path persists its events after the loan rows in the same transaction).
-- Money is bigint cents. Nothing here is a consumer identifier except servicer_profiles.tin, the servicer's own EIN (see its comment).
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────────────────────── installment_schedule_runs ─────────────────────────────
CREATE TABLE installment_schedule_runs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                  uuid NOT NULL REFERENCES loans(id),
  terms_id                 uuid REFERENCES loan_terms(id),
  source                   text NOT NULL CHECK (source IN ('fund', 'transfer', 'reprojection', 'correction')),
  trigger_event_id         uuid,                                   -- loan.boarded / loan_terms.* (no FK: the transfer path persists events after the rows)
  first_due                date NOT NULL,
  last_due                 date NOT NULL,
  rows                     int NOT NULL,
  rows_replaced            int NOT NULL DEFAULT 0,
  rows_kept                int NOT NULL DEFAULT 0,
  pi_cents                 bigint NOT NULL,
  rate_bps                 int NOT NULL,
  upb_start_cents          bigint NOT NULL,
  total_interest_cents     bigint NOT NULL,
  total_principal_cents    bigint NOT NULL,
  maturity_variance_cents  bigint NOT NULL DEFAULT 0,               -- the UPB left at maturity before the final row absorbs it; 0 for a consistent tape
  replaced                 jsonb NOT NULL DEFAULT '[]',             -- the prior values of every replaced row (reprojection)
  sha256                   char(64) NOT NULL,                       -- over the written rows
  decision_id              uuid REFERENCES agent_decisions(id),
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX installment_schedule_runs_loan_idx ON installment_schedule_runs(loan_id, created_at);
CREATE TRIGGER installment_schedule_runs_immutable BEFORE UPDATE OR DELETE ON installment_schedule_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE installment_schedule_runs IS '35.5 rule 1–3: one row per schedule write; append-only; sha256 over the rows as written; `replaced` keeps the prior values a reprojection overwrote.';

-- ───────────────────────────── loan_installments (baseline 0003:105), extended ─────────────────────────────
ALTER TABLE loan_installments
  ADD COLUMN sequence                 int,                                            -- 1 = the first payment date
  ADD COLUMN upb_before_cents         bigint,
  ADD COLUMN upb_after_cents          bigint,
  ADD COLUMN rate_bps                 int,                                            -- the loan_terms.note_rate_bps the row was projected under
  ADD COLUMN terms_id                 uuid REFERENCES loan_terms(id),
  ADD COLUMN schedule_run_id          uuid REFERENCES installment_schedule_runs(id),
  ADD COLUMN satisfied_by_payment_id  uuid,                                           -- FK to `payments` added by 35.1 with its projector (plan D5)
  ADD COLUMN absorbs_rounding         boolean NOT NULL DEFAULT false,                 -- true on the final row
  ADD COLUMN interest_variance_cents  bigint;                                         -- rule 4: engine interest − the row's, recorded by the unit that posted it
CREATE INDEX loan_installments_run_idx ON loan_installments(schedule_run_id);
COMMENT ON COLUMN loan_installments.satisfied_by_payment_id IS '35.5 plan D5: the posting payment''s uuid; FK to payments added by 35.1 once its projector keeps a uuid legacy id as the typed id.';

-- Rule 3 / guardrail SATISFIED_ROW_FROZEN: a money or terms column of a satisfied/prepaid row never changes by UPDATE; a row is never deleted.
CREATE OR REPLACE FUNCTION loan_installments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'loan_installments is append-only: DELETE refused (a reprojection replaces due rows by INSERT ... ON CONFLICT)'; END IF;
  IF OLD.status IN ('satisfied', 'prepaid') AND (
       NEW.pi_cents IS DISTINCT FROM OLD.pi_cents OR NEW.interest_cents IS DISTINCT FROM OLD.interest_cents OR NEW.principal_cents IS DISTINCT FROM OLD.principal_cents
    OR NEW.escrow_cents IS DISTINCT FROM OLD.escrow_cents OR NEW.terms_id IS DISTINCT FROM OLD.terms_id OR NEW.sequence IS DISTINCT FROM OLD.sequence
    OR NEW.upb_before_cents IS DISTINCT FROM OLD.upb_before_cents OR NEW.upb_after_cents IS DISTINCT FROM OLD.upb_after_cents OR NEW.rate_bps IS DISTINCT FROM OLD.rate_bps
    OR NEW.schedule_run_id IS DISTINCT FROM OLD.schedule_run_id OR NEW.absorbs_rounding IS DISTINCT FROM OLD.absorbs_rounding) THEN
    RAISE EXCEPTION 'SATISFIED_ROW_FROZEN: loan_installments % / % is %; a money or terms column changes only through 2.1''s reversal (35.5 rule 3)', OLD.loan_id, OLD.due_date, OLD.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER loan_installments_guard BEFORE UPDATE OR DELETE ON loan_installments FOR EACH ROW EXECUTE FUNCTION loan_installments_guard();

-- ───────────────────────────── servicer_profiles ─────────────────────────────
CREATE TABLE servicer_profiles (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  servicing_party_id            uuid NOT NULL REFERENCES parties(id),   -- Supermortgage's own party row
  version                       int NOT NULL,
  effective_from                date NOT NULL,
  effective_to                  date,
  legal_name                    text NOT NULL,
  dba                           text,
  nmls_id                       text,
  tin                           text,
  toll_free_phone               text NOT NULL,
  servicer_address              text NOT NULL,
  exclusive_address             text NOT NULL,                        -- §1024.35(c) NoE / §1024.36(b) RFI designation
  remittance_address            text NOT NULL,                        -- the lockbox P.O. box
  payment_requirements_version  text REFERENCES payment_requirements(version),
  portal_url                    text NOT NULL,
  counselor_url                 text NOT NULL,
  hud_phone                     text NOT NULL,
  hours                         text,
  languages                     text[] NOT NULL DEFAULT '{en}',
  status                        text NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  approved_by_decision_id       uuid REFERENCES agent_decisions(id),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (servicing_party_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- exactly one active version per servicing party at any date
  EXCLUDE USING gist (servicing_party_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&) WHERE (status = 'active')
);
-- pii by the cashiering-row convention (0003 payments.payer_name): the servicer's own EIN as printed on every Form 1098, never a consumer identifier.
COMMENT ON COLUMN servicer_profiles.tin IS 'pii';
COMMENT ON TABLE servicer_profiles IS '35.5 rule 9: append-only versions of the servicer identity every notice renders from; activation needs `compliance` and a decision; a version is superseded by a later version''s effective_from.';
-- Append-only versions: an UPDATE may move `status` and `effective_to` only (the activation of a later version closes the prior row); DELETE never.
CREATE OR REPLACE FUNCTION servicer_profiles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'servicer_profiles is append-only'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.servicing_party_id IS DISTINCT FROM OLD.servicing_party_id OR NEW.version IS DISTINCT FROM OLD.version OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.legal_name IS DISTINCT FROM OLD.legal_name OR NEW.dba IS DISTINCT FROM OLD.dba OR NEW.nmls_id IS DISTINCT FROM OLD.nmls_id OR NEW.tin IS DISTINCT FROM OLD.tin OR NEW.toll_free_phone IS DISTINCT FROM OLD.toll_free_phone
     OR NEW.servicer_address IS DISTINCT FROM OLD.servicer_address OR NEW.exclusive_address IS DISTINCT FROM OLD.exclusive_address OR NEW.remittance_address IS DISTINCT FROM OLD.remittance_address
     OR NEW.payment_requirements_version IS DISTINCT FROM OLD.payment_requirements_version OR NEW.portal_url IS DISTINCT FROM OLD.portal_url OR NEW.counselor_url IS DISTINCT FROM OLD.counselor_url
     OR NEW.hud_phone IS DISTINCT FROM OLD.hud_phone OR NEW.hours IS DISTINCT FROM OLD.hours OR NEW.languages IS DISTINCT FROM OLD.languages OR NEW.approved_by_decision_id IS DISTINCT FROM OLD.approved_by_decision_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'servicer_profiles is append-only: only status and effective_to may change (a new version is a new row)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER servicer_profiles_guard BEFORE UPDATE OR DELETE ON servicer_profiles FOR EACH ROW EXECUTE FUNCTION servicer_profiles_guard();

-- ───────────────────────────── loan_servicing_configs ─────────────────────────────
CREATE TABLE loan_servicing_configs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id                uuid NOT NULL REFERENCES loans(id),
  effective_from         date NOT NULL,
  time_zone              text NOT NULL,                                                       -- IANA
  time_zone_source       text NOT NULL CHECK (time_zone_source IN ('state_default', 'county_override', 'borrower_stated', 'manual')),
  jurisdiction_state     char(2) NOT NULL REFERENCES jurisdiction_rules(state),
  servicer_profile_id    uuid NOT NULL REFERENCES servicer_profiles(id),
  lockbox_id             text,
  channels_enabled       text[] NOT NULL DEFAULT '{}',                                        -- payment_channels.channel values
  late_charge_terms      jsonb NOT NULL,                                                      -- 2.7 lateChargeTerms output: pct, grace_days, conflict
  nsf_fee_allowed        boolean NOT NULL,                                                    -- jurisdiction_rules.rules.nsf_fee.allowed
  written_by             jsonb NOT NULL DEFAULT '{}',
  decision_id            uuid REFERENCES agent_decisions(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_servicing_configs_loan_idx ON loan_servicing_configs(loan_id, effective_from DESC);
CREATE TRIGGER loan_servicing_configs_immutable BEFORE UPDATE OR DELETE ON loan_servicing_configs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE loan_servicing_configs IS '35.5 rule 9: the loan''s time zone, jurisdiction and servicer profile, written in the boarding transaction; the latest row by effective_from ≤ today applies; a read with no row is a typed refusal (CONFIG_REQUIRED), never a default.';

COMMIT;
