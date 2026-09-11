-- entity_records keyed per scope. The agent tools number their rows over the command's SCOPED store
-- (24.1 `sel-${store.list(kind).length + 1}`, 24.5 `fd-n` / `ir-n` / `ev-n`, 28.1's plan-derived ids …), so two
-- applications legitimately hold the same (kind, id, version) — the storage key follows the store's own scope
-- (32.6 backend delta: before this, the second application's command failed its commit with a unique violation,
-- surfaced as 409 DUPLICATE_RECORD on the borrower routes and 500 on the tool routes). The scope key is derived
-- from the row's own application / loan column, so PgEntityRepository.save is unchanged. Global rows keep '' and
-- stay unique platform-wide; `entity_current` still answers a (kind, id) lookup with the latest version.
ALTER TABLE entity_records ADD COLUMN scope_key text GENERATED ALWAYS AS (coalesce(application_id, loan_id, '')) STORED NOT NULL;
ALTER TABLE entity_records DROP CONSTRAINT entity_records_pkey;
ALTER TABLE entity_records ADD CONSTRAINT entity_records_pkey PRIMARY KEY (kind, id, version, scope_key);
