# Supermortgage

An AI-first Fannie Mae subservicing platform, built process-by-process to the
[build specification](spec/) — 19 sections, 114 processes, 1,365 timers and
gates, 1,255 acceptance tests, researched against primary sources (Reg X,
Reg Z, the Fannie Mae Servicing Guide, Lender Letters, MERS procedures).

The spec is the source of truth. Code cites it (`F-1-09:order_1999plus:interest`,
`2.2:50_rule`, `HF-003`) and the acceptance tests in each section's spec are
reproduced as the test suite.

## Layout

```
spec/                     the specification, extracted from the artifact (regenerate: npm run spec:extract)
  sections/<nn>-<slug>/   one markdown file per process, README per section
  registry/               sections.json · processes.json · timers.json (machine-readable)
src/kernel/               cross-cutting primitives every section builds on
  money/                  integer-cent bigint money, fixed-scale Decimal, amortization
  calendar/               PlainDate, federal holidays, the four day-count calendars, ET wall-clock
  events/                 append-only loan_events store + the spec's trigger-pattern syntax
  fsm/                    declarative state machines with guards and role requirements
  ledger/                 double-entry entry sets that must balance; reversal-not-edit
  timers/                 registry loader, offset grammar, arm/satisfy/breach engine
src/domain/               one directory per spec section/process
  boarding/               §1.1 loan data intake & validation (HF/W gate, MIN, Reg X delinquency, opening ledger)
  cashiering/             §2.1 accept & post periodic payments (+ the §2.2 $50 rule)
db/migrations/            Postgres schema (bigint cents; immutable event log, ledger, decisions)
tools/                    spec extraction and registry lint
```

## Running

Node ≥ 22.18 (type-stripping, no build step) and Postgres 16.

```sh
npm install
npm test                  # node:test, all sections
npm run typecheck
npm run spec:lint         # how much of the timer registry is mechanically executable
DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh
```

## Status

| Area | State |
|---|---|
| Spec materialized in repo | ✅ all 114 processes + registries |
| Kernel (money, calendars, events, FSM, ledger, timers) | ✅ tested |
| Timer registry | ✅ 1,365 rows loaded; 741 armable purely from the registry, the rest armed by section code |
| Postgres schema | ✅ baseline + Section 1 tables; deferred balance constraint on the ledger |
| §1.1 Boarding intake & validation | ✅ 1.1-T1…T10 |
| §2.1 Payment posting (+ §2.2 $50 rule) | ✅ 2.1-T1…T6, T8, T9 |
| Everything else | ⏳ see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the build order |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how a section is added and
which conventions are non-negotiable.
