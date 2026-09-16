-- 35.8 timer table rows 2–3: the age clocks' breach actions are the work.breaches pass's, one escalation per role per sweep
-- (src/domain/operations-runtime/work-35-8/sweep.ts); the item's own `aged` event names the two-day clock handled, as
-- `unstaffed` (0202) names the five-day one. The partial index carries openGlobal()'s exact predicate
-- (src/infra/db/timers.ts): a global command reads the platform's few global clocks, never a scan of every item's.
-- Append-only: 0200–0202 are untouched.
BEGIN;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'work_item_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE work_item_events DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE work_item_events ADD CONSTRAINT work_item_events_kind_check CHECK (kind IN ('opened', 'claimed', 'released', 'claim_expired', 'approval_waiting', 'closed', 'cancelled', 'unstaffed', 'aged'));
CREATE INDEX IF NOT EXISTS timers_open_global_idx ON timers (armed_at) WHERE loan_id IS NULL AND application_id IS NULL AND status IN ('armed', 'breached') AND subject_kind NOT IN ('work_item', 'work_action');
CREATE INDEX IF NOT EXISTS timers_breached_code_idx ON timers (code, subject_kind) WHERE status = 'breached';

COMMIT;
