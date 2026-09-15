-- 0139 — 34.1 rule 4, amended 2026-09-15 (the operator-portal proposal §3 "Every log row carries the role"; 34.1-T9):
-- the action log gains the role that acted. Append-only in both senses: a new file that adds one nullable column to an
-- append-only table (forbid_mutation stays; nothing is backfilled — a row older than this migration keeps NULL because no
-- role was recorded when it was written). 35.7's later extension adds principal_id, surface and source beside it.
BEGIN;

ALTER TABLE staff_actions ADD COLUMN role text;
COMMENT ON COLUMN staff_actions.role IS '34.1 rule 4 "and the role that acted": set for every request from the chosen actor — the request''s preferred role when the route accepts it, or the least-privileged accepted role the account holds that a GET fell back to (rule 3, order ops_analyst < officer < compliance < admin); on a refusal the role that was asked for, beside refusal_code. NULL on the door routes (no session) and on rows written before migration 0139.';

COMMIT;
