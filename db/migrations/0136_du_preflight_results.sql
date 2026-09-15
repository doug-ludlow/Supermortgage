-- 0136_du_preflight_results.sql — 23.7 Preflight: what DU rejects that the schema accepts
-- (spec/sections/23-desktop-underwriter-and-the-credit-decision/23-7-preflight-and-the-du-port-contract.md "Data model").
--
-- One row per preflight run over an emitted DU Specification document (src/domain/underwriting/du/preflight.ts
-- runDuPreflight): `checks` holds one entry per check, in the order the spec's Business rules give them with the
-- credentials check first (T12), each `{code, passed, xpath, detail}`; `passed` is the conjunction. Every run is
-- recorded, passing or not (a refusal is a row too — the audit reads "the du_preflight_results row with every check
-- and its outcome"). Append-only: a re-run after a re-emission is a new row against the new du_documents row.
BEGIN;

CREATE TABLE du_preflight_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES du_documents(id),        -- the emitted document the checks ran over (23.6, 0129)
  application_id  uuid NOT NULL REFERENCES applications(id),
  passed          boolean NOT NULL,                                 -- every check passed → du.preflight.passed opened SM_DU_PREFLIGHT_GATE
  checks          jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array'), -- [{code, passed, xpath, detail}] in check order, credentials first
  ran_at          timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX du_preflight_results_document_idx ON du_preflight_results(document_id, ran_at);
CREATE INDEX du_preflight_results_application_idx ON du_preflight_results(application_id, ran_at);
CREATE TRIGGER du_preflight_results_immutable BEFORE UPDATE OR DELETE ON du_preflight_results FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
COMMENT ON TABLE du_preflight_results IS '23.7: one row per preflight run over an emitted DU Specification document (du_documents), passing or not; checks is the ordered list {code, passed, xpath, detail} — credentials first, then graph integrity, cardinality, ownership, substance, duplicate assets, employer arcs, the casefile identifier. Append-only. du.preflight.passed / du.preflight.refused carry the same checks on the bus; SM_DU_PREFLIGHT_GATE opens on passed.';
COMMENT ON COLUMN du_preflight_results.checks IS 'One entry per check that ran, in order. A failed credentials check (DU_PREFLIGHT_CREDENTIALS) runs before any other check (T12) and is then the only entry.';

COMMIT;
