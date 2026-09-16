-- 35.7 Operating roles, identity and the FAKE handover — the review's fix-ups to 0170 (a new file: migrations are append-only).
-- 1. One approval, one consumption (35.7 rule 2): a second `dual_control.consumed` for the same request fails on this partial
--    unique index inside the command's own transaction; executeWithControls answers APPROVAL_STALE and nothing of the second run commits.
CREATE UNIQUE INDEX loan_events_dual_control_consumed_once ON loan_events ((payload->>'request_id')) WHERE type = 'dual_control.consumed';

-- 2. api_principals (35.7 data model): the principal's identity is fixed at issue — only the usage, revocation and refusal-counter
--    columns ever change (last_used_at, revoked_at, revoked_by, revoked_cause, refusals_in_hour, refusals_window_started_at, refused_escalated_at).
CREATE OR REPLACE FUNCTION api_principals_fixed_columns() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.staff_user_id IS DISTINCT FROM OLD.staff_user_id OR NEW.party_id IS DISTINCT FROM OLD.party_id
     OR NEW.name IS DISTINCT FROM OLD.name OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.scopes IS DISTINCT FROM OLD.scopes OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.retention_class IS DISTINCT FROM OLD.retention_class THEN
    RAISE EXCEPTION 'API_PRINCIPAL_IMMUTABLE: only last_used_at, revoked_at, revoked_by, revoked_cause, refusals_in_hour, refusals_window_started_at and refused_escalated_at change after issue (35.7 data model)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER api_principals_fixed_columns BEFORE UPDATE ON api_principals FOR EACH ROW EXECUTE FUNCTION api_principals_fixed_columns();

-- 3. The revert of a handover is the same two people's decision (35.7 rule 7, state machine "handover.revert, nonprod only, the same two
--    people"): one of them requests it (`revert_requested`, 10 minutes), the other confirms (`reverted`).
ALTER TABLE role_handovers DROP CONSTRAINT role_handovers_action_check;
ALTER TABLE role_handovers ADD CONSTRAINT role_handovers_action_check CHECK (action IN ('planned', 'requested', 'enabled', 'revert_requested', 'reverted', 'expired'));
