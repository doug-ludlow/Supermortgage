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
src/infra/db/             Postgres repositories + loan-scoped unit of work over db/migrations
src/infra/integrations/   outbox, adapter ports and fakes for every counterparty the spec names
src/notices/              Notice Registry: catalog, template versions, content-rule checklists, channel decision, delivery service
src/app/                  command bus, agent registry + kill switch, role gates, gate evaluators, escalations
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
python3 tools/extract_notices.py   # regenerate spec/registry/notices.json (notice codes) from the spec
python3 tools/extract_agents.py    # regenerate spec/registry/agents.json (agents, tools, guardrails) from the spec
npm run test:db           # database-backed acceptance tests (needs Postgres; `npm test` skips them when none answers)
DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh
```

## Status

| Area | State |
|---|---|
| Spec materialized in repo | ✅ all 114 processes + registries |
| Kernel (money, calendars, events, FSM, ledger, timers) | ✅ tested |
| Timer registry | ✅ 1,365 rows loaded (1,206 unique codes); 774 armable purely from the registry, the other 616 via cited overrides in each section's `timers.ts` (`src/domain/timer-overrides.ts` applies all 19; 109 are evaluator-backed gates) — 1,206/1,206 armable |
| Postgres schema | ✅ 23 migrations, 438 tables covering every section's "Data model" subsection; append-only/immutability triggers, restricted `restricted_fl` schema |
| Integration framework | ✅ `src/infra/integrations`: idempotent outbox over `integration_messages` (dedupe by adapter+direction+key, backoff retry, dead-letter → `human_portal_tasks`), failure vocabulary (transient / unavailable-with-fallback / permanent rejection), BAI2 and Nacha codecs, and typed ports with behaviour-faithful fakes for fnma-lsdu (hard/soft/invalid/missing, head-of-line), fnma-servicing-events, SMDU, P360, CRS file builder, Connect, MERS, custodian, WORM e-vault, lockbox, custodial-bank, ODFI, print/mail, e-delivery, telephony, Metro 2, e-OSCAR, LPI tracking, flood, tax service, MI, PACER, DMDC, e-recording |
| Notice Registry | ✅ `src/notices`: all 248 NTC_/INS_ codes the spec names (`spec/registry/notices.json` via `tools/extract_notices.py`) registered with class/channel policy; immutable effective-dated template versions with machine-checkable content, data and layout rules; publish gate (a failing block rule cannot be published); dependency-free renderer; channel decision per 7.4 (consent class, mail-only, bounce → same-day mail, split parties); `NoticeService` render → checklist → hold/send → proof of delivery with events; authored, rule-checked versions for the H-30 statements, MS-3(A) force-placed notice, MS-4(A) early-intervention notice, H-4(D)(3) ARM initial notice and the §1024.41(b)(2) acknowledgment |
| Application layer | ✅ `src/app`: command bus every state change goes through (AI kill switch / AI-off routing, per-agent tool allowlists from `spec/registry/agents.json`, role gates, money-field protection, guardrails that refuse before anything runs, automatic `agent_decisions` rows with rule set / model / prompt / approver, `command.executed` / `command.refused` events); the 20 agents the spec defines with their processes, tools and escalation roles; 109 gate evaluators resolving every `evaluator:` ref the timer overrides name; escalations with role-checked completion |
| Persistence layer | ✅ `src/infra/db`: `pg` client (bigint cents), repositories for `loan_events`, ledger sets/lines, `timers`, `agent_decisions`, loan fixtures; `PgUnitOfWork` hydrates a loan's history into the kernel stores, runs the synchronous domain command, and commits events + ledger + timers + decisions in one transaction. DB-backed acceptance tests (2.1-T1 end to end) via `npm run test:db` |
| §1 Boarding & transfers in (1.1–1.7) | ✅ `src/domain/boarding`, `src/domain/transfers` |
| §2 Cashiering (2.1–2.7) | ✅ `src/domain/cashiering` |
| §3 Escrow (3.1–3.9) | ✅ `src/domain/escrow` |
| §4 Customer service & servicing requests (4.1–4.6) | ✅ `src/domain/servicing-requests` |
| §5 Investor reporting & remittance (5.1–5.7) | ✅ `src/domain/investor` |
| §6 Custodial accounts (6.1–6.5) | ✅ `src/domain/custodial` |
| §7 Compliance notices (7.1–7.6) | ✅ `src/domain/notices` |
| §8 Credit reporting (8.1–8.3) | ✅ `src/domain/credit-reporting` |
| §9 Insurance & property (9.1–9.9) | ✅ `src/domain/insurance` |
| §10 Private mortgage insurance (10.1–10.6) | ✅ `src/domain/pmi` |
| §11 Early intervention (11.1–11.5) | ✅ `src/domain/early-intervention` |
| §12 Loss mitigation (12.1–12.9) | ✅ `src/domain/lossmit` |
| §13 Foreclosure (13.1–13.9) | ✅ `src/domain/foreclosure` |
| §14 Bankruptcy (14.1–14.4) | ✅ `src/domain/bankruptcy` |
| §15 REO, claims, advances (15.1–15.4) | ✅ `src/domain/reo` |
| §16 Payoff & lien release (16.1–16.3) | ✅ `src/domain/payoff` |
| §17 Transfers out (17.1–17.4) | ✅ `src/domain/transfers` |
| §18 QC, audit, attestations (18.1–18.7) | ✅ `src/domain/qc-audit` |
| §19 Records, security, vendors, fair lending (19.1–19.4) | ✅ `src/domain/data-security` |
| Audit | ⏳ every section's tests reproduce the spec's worked examples; discrepancies found on the way are listed in [docs/AUDIT-NOTES.md](docs/AUDIT-NOTES.md) |

Each domain module is pure business logic (typed inputs → typed results) with
a `*.test.ts` file whose test names carry the spec's T-numbers. Persistence
beyond the baseline schema, adapters (e-OSCAR, P360, SMDU, lockbox, print) and
the agent layer are the next build phases.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how a section is added and
which conventions are non-negotiable.
