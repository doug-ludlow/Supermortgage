# Supermortgage — working notes for Claude

- The spec under `spec/` is the source of truth. Before touching a process, read its markdown end to end; reproduce its T-numbered acceptance tests verbatim as `node:test` cases and its worked arithmetic as assertions.
- Conventions are listed in `docs/ARCHITECTURE.md` and are not optional: bigint cents, PlainDate + the four named calendars, append-only event/ledger/decision tables, balanced ledger sets with `rule_ref`, registry-driven timers, officer-only waivers on money fields.
- Node 22 type-stripping runs `.ts` directly: erasable syntax only (no `enum`, no parameter properties, no namespaces). `npm test` and `npm run typecheck` must both pass before a commit.
- Timer rows that the offset grammar can't parse are listed by `npm run spec:lint -- --verbose`. Handle them with a cited override in the section's `timers.ts`, never by hard-coding a deadline in service code.
- Postgres: `service postgresql start`, then `DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh`. Migrations are append-only too — new file, never edit an applied one.
