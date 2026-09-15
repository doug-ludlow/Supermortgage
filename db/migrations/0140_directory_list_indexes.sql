-- 0140_directory_list_indexes.sql — 34.5 The portal's information architecture and the accounts list
-- (spec/sections/34-operator-portal/34-5-the-portal-s-information-architecture-and-the-accounts-list.md, Data model).
--
-- New tables: none — every column of the accounts list exists in rows the directory already reads (34.2). Two indexes so that
-- `directory.list` (src/runtime/directory/list.ts) — one row per borrower party, newest first by creation, a cursor of 50 with
-- the id as the tiebreak — stays fast over many parties, and the first-seen / last-seen columns read a party's sessions in order:
--
--   parties_directory_created_idx   borrower parties by creation time, descending, the id as the tiebreak (partial: party_type = borrower)
--   sessions_party_created_idx      sessions by party and creation time (first seen = the earliest, last seen = the latest last_seen_at)
--
-- Append-only: no table, column or constraint changes; `db.test`'s base-table count is unchanged.
BEGIN;
CREATE INDEX parties_directory_created_idx ON parties (created_at DESC, id DESC) WHERE party_type = 'borrower';
CREATE INDEX sessions_party_created_idx ON sessions (party_id, created_at);
COMMENT ON INDEX parties_directory_created_idx IS '34.5 rule 5: the accounts list pages borrower parties newest first by creation with the id as the tiebreak.';
COMMENT ON INDEX sessions_party_created_idx IS '34.5 rule 4: a party''s sessions in creation order — the first-seen, last-seen and doors-used columns of the accounts list.';
COMMIT;
