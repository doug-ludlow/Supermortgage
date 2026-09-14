-- 0131_staff_failed_at.sql — 34.1 rule 1's lockout window (review finding on the first build): "five failed sign-ins for one
-- account in an hour" (spec/sections/34-operator-portal/34-1-*.md, AI agent design escalations). `staff_users.failed_signins`
-- counted forever — after a lapsed 15-minute lock a single wrong password (failures 6 ≥ 5) re-locked the account and opened
-- another `compliance` escalation, and four failures months apart plus one today locked it too. `last_failed_at` carries the
-- window: src/runtime/staff/repo.ts recordFailure restarts the count at 1 when the previous lock has lapsed or the last
-- failure is older than an hour. A column only — no table is added (src/infra/db/db.test.ts stays at 765). Append-only:
-- 0127 (staff) is not edited.
BEGIN;

ALTER TABLE staff_users ADD COLUMN last_failed_at timestamptz;   -- rule 1: the instant of the latest failed sign-in (password or e-mail code); null once cleared
COMMENT ON COLUMN staff_users.last_failed_at IS '34.1 rule 1: the latest failed sign-in; the five-in-an-hour window and the lapsed-lock reset key off it';

COMMIT;
