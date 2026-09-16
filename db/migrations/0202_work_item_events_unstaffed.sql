-- 35.8 timer table row 3 (SM_WORK_ITEM_AGE_5BD): the sweep's `role.queue.unstaffed{role}` is emitted once per breached clock;
-- the receipt that makes it once is the item's own `unstaffed` event naming the timer (work_item_events, indexed by item and
-- kind) — never a scan of loan_events payloads, which grew with the book (src/runtime/demo-clock.test.ts: 45 demo days in
-- one request budget). The subject index on timers serves PgTimerRepository.forSubjects (a command hydrates the clocks of the
-- work items and proposals it names, in place of every global command reading them all). Append-only: 0200 is untouched.
BEGIN;

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'work_item_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE work_item_events DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE work_item_events ADD CONSTRAINT work_item_events_kind_check CHECK (kind IN ('opened', 'claimed', 'released', 'claim_expired', 'approval_waiting', 'closed', 'cancelled', 'unstaffed'));
CREATE INDEX IF NOT EXISTS work_item_events_item_kind_idx ON work_item_events (work_item_id, kind);
CREATE INDEX IF NOT EXISTS timers_subject_open_idx ON timers (subject_kind, subject_id) WHERE status IN ('armed', 'breached');
CREATE INDEX IF NOT EXISTS work_items_open_source_idx ON work_items (source_kind, source_id) WHERE status NOT IN ('closed', 'cancelled');

COMMIT;
