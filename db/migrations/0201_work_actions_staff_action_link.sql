-- 35.8 data model (rule 10): `work_actions.staff_action_id` is filled by the reconciliation's join — the console writes the
-- staff_actions row after the answer (34.1 rule 4), so the act cannot carry it at insert. 0200's trigger admitted only a
-- proposal's resolution; this one also admits the one-time NULL → value fill of `staff_action_id` on any row (never a change
-- once set, never with any other column). Every other UPDATE and every DELETE stays refused. Append-only migration: 0200 is
-- untouched, the function is replaced under the same trigger.
BEGIN;

CREATE OR REPLACE FUNCTION work_actions_proposal_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'work_actions is append-only (35.8 data model)'; END IF;
  -- the reconciliation's link: staff_action_id NULL → value, nothing else moving
  IF OLD.staff_action_id IS NULL AND NEW.staff_action_id IS NOT NULL AND row_to_json(OLD)::jsonb - 'staff_action_id' = row_to_json(NEW)::jsonb - 'staff_action_id' THEN RETURN NEW; END IF;
  IF OLD.staff_action_id IS DISTINCT FROM NEW.staff_action_id THEN RAISE EXCEPTION 'work_actions.staff_action_id is set once by the reconciliation (35.8 rule 10)'; END IF;
  IF OLD.status <> 'proposed' OR NEW.status NOT IN ('approved', 'declined', 'expired') THEN RAISE EXCEPTION 'work_actions admits only the resolution of a proposal (35.8 rules 5–6)'; END IF;
  IF row_to_json(OLD)::jsonb - 'status' - 'refusal_code' <> row_to_json(NEW)::jsonb - 'status' - 'refusal_code' THEN RAISE EXCEPTION 'work_actions: only status and refusal_code move on a proposal'; END IF;
  RETURN NEW;
END $$;

-- The link is a claim the reconciliation verifies, not a constraint: rule 10's orphan IS "an executed row whose staff_actions
-- row is gone" (35.8-T11 deletes one in its fixture), which a foreign key would make unrepresentable. The column stays a
-- uuid the recon fills and re-checks each day.
ALTER TABLE work_actions DROP CONSTRAINT IF EXISTS work_actions_staff_action_id_fkey;

COMMIT;
