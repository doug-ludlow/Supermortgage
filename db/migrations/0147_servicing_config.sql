-- 0147_servicing_config.sql — §35.5 rule 9, data model rows `servicer_profiles` and `loan_servicing_configs`: the two
-- constants (`SERVICER_CONTACT`, `LOAN_LOCAL_TZ`) become an effective-dated servicer profile and a per-loan configuration
-- row. Retention class `permanent` for the profile (it is the servicer's identity on every notice ever rendered) and
-- `life_of_loan_plus_4y` for the loan's configuration. PII: the profile's TIN is stored encrypted with its last four only.
--
-- `servicer_profiles` is append-only in its versions: a version is INSERTed as `draft` or `active`; the only UPDATE the
-- trigger allows moves `status` (draft → active → superseded) and closes `effective_to`; nothing else changes and nothing
-- is deleted. Exactly one `active` version per servicing party on any date: the range trigger refuses an overlap.
-- `loan_servicing_configs` is append-only (forbid_mutation): a change is a new effective-dated row.
BEGIN;

CREATE TABLE servicer_profiles (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  servicing_party_id            uuid NOT NULL REFERENCES parties(id),
  version                       int NOT NULL CHECK (version >= 1),
  effective_from                date NOT NULL,
  effective_to                  date,
  legal_name                    text NOT NULL,
  dba                           text,
  nmls_id                       text,
  tin_encrypted                 bytea,                          -- AES-256-GCM (src/infra/pii/tin.ts), never the digits
  tin_last4                     char(4),
  toll_free_phone               text NOT NULL,
  servicer_address              text NOT NULL,
  exclusive_address             text NOT NULL,
  remittance_address            text NOT NULL,
  payment_requirements_version  text REFERENCES payment_requirements(version),
  portal_url                    text,
  counselor_url                 text,
  hud_phone                     text,
  hours                         text,
  languages                     text[] NOT NULL DEFAULT '{en}',
  status                        text NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  approved_by_decision_id       uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  retention                     retention_class NOT NULL DEFAULT 'permanent',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (servicing_party_id, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX servicer_profiles_party_eff_idx ON servicer_profiles (servicing_party_id, effective_from DESC);

CREATE OR REPLACE FUNCTION servicer_profiles_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'servicer_profiles versions are never deleted (35.5 data model)';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.servicing_party_id IS DISTINCT FROM OLD.servicing_party_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.legal_name IS DISTINCT FROM OLD.legal_name OR NEW.dba IS DISTINCT FROM OLD.dba
     OR NEW.nmls_id IS DISTINCT FROM OLD.nmls_id OR NEW.tin_encrypted IS DISTINCT FROM OLD.tin_encrypted OR NEW.tin_last4 IS DISTINCT FROM OLD.tin_last4
     OR NEW.toll_free_phone IS DISTINCT FROM OLD.toll_free_phone OR NEW.servicer_address IS DISTINCT FROM OLD.servicer_address
     OR NEW.exclusive_address IS DISTINCT FROM OLD.exclusive_address OR NEW.remittance_address IS DISTINCT FROM OLD.remittance_address
     OR NEW.payment_requirements_version IS DISTINCT FROM OLD.payment_requirements_version OR NEW.portal_url IS DISTINCT FROM OLD.portal_url
     OR NEW.counselor_url IS DISTINCT FROM OLD.counselor_url OR NEW.hud_phone IS DISTINCT FROM OLD.hud_phone OR NEW.hours IS DISTINCT FROM OLD.hours
     OR NEW.languages IS DISTINCT FROM OLD.languages OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.retention IS DISTINCT FROM OLD.retention THEN
    RAISE EXCEPTION 'servicer_profiles version % is immutable but for status, effective_to and its approval (35.5 data model)', OLD.id;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('active', 'superseded')) OR (OLD.status = 'active' AND NEW.status = 'superseded') OR NEW.status = OLD.status) THEN
    RAISE EXCEPTION 'servicer_profiles: % → % is not a transition of the state machine (draft → active → superseded)', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER servicer_profiles_versioned BEFORE UPDATE OR DELETE ON servicer_profiles FOR EACH ROW EXECUTE FUNCTION servicer_profiles_versioned();

-- exactly one active version per servicing party at any date (no btree_gist on this server: a range check in plpgsql)
CREATE OR REPLACE FUNCTION servicer_profiles_one_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM servicer_profiles p
     WHERE p.servicing_party_id = NEW.servicing_party_id AND p.id <> NEW.id AND p.status = 'active'
       AND daterange(p.effective_from, p.effective_to, '[)') && daterange(NEW.effective_from, NEW.effective_to, '[)')) THEN
    RAISE EXCEPTION 'servicer_profiles: another active version overlaps [%, %) for party % (exactly one active version at any date)', NEW.effective_from, NEW.effective_to, NEW.servicing_party_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER servicer_profiles_one_active BEFORE INSERT OR UPDATE ON servicer_profiles FOR EACH ROW EXECUTE FUNCTION servicer_profiles_one_active();

CREATE TABLE loan_servicing_configs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id              uuid NOT NULL REFERENCES loans(id),
  effective_from       date NOT NULL,
  time_zone            text NOT NULL,
  time_zone_source     text NOT NULL CHECK (time_zone_source IN ('state_default', 'county_override', 'borrower_stated', 'manual')),
  jurisdiction_state   char(2) NOT NULL,
  servicer_profile_id  uuid NOT NULL REFERENCES servicer_profiles(id),
  lockbox_id           text,
  channels_enabled     text[] NOT NULL DEFAULT '{}',
  late_charge_terms    jsonb NOT NULL DEFAULT '{}',
  nsf_fee_allowed      boolean NOT NULL,                       -- from jurisdiction_rules.rules.nsf_fee (NSF_ONLY_WHERE_ALLOWED: no row on file → false, never a default authority)
  written_by           jsonb NOT NULL DEFAULT '{}',
  decision_id          uuid REFERENCES agent_decisions(id) DEFERRABLE INITIALLY DEFERRED,
  retention            retention_class NOT NULL DEFAULT 'life_of_loan_plus_4y',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_servicing_configs_loan_eff_idx ON loan_servicing_configs (loan_id, effective_from DESC, created_at DESC);
CREATE TRIGGER loan_servicing_configs_immutable BEFORE UPDATE OR DELETE ON loan_servicing_configs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

COMMIT;
