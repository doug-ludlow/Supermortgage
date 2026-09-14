# Supermortgage

One platform that acquires, originates and services mortgages, run by agents, with people only where the law puts them.

A servicer partner hands us its book and every homeowner on it becomes an account the same minute. An agent reviews each loan every morning against live rates and the partner's own values. When a refinance is worth their attention the offer goes out, the homeowner says Yes to Michelle (the assistant), and the file is assembled, underwritten, closed, funded, delivered to Fannie Mae and boarded without anyone touching a row. The new loan is serviced on the same platform and reviewed again the next morning.

```
partner tape → accounts + invitation → daily review → offer → Yes → readiness asks
  → credit · income · assets · identity → DU → disclosures → eClose · fund
  → deliver to Fannie Mae → board → service → daily review …
```

Everything is built to the [specification](spec/) in `spec/sections/` — 33 sections, 185 processes — and measured against it. Nothing is "done" by assertion: a process is done when the audit says every one of its units is built, and the audit only counts a real test with the spec's exact wording.

## Status (measured, 14 September 2026)

From `npm run audit` (`tools/audit.py`), which measures the tree against `spec/registry/manifest.json`, the spec in its own units. Regenerated into [docs/audit/COVERAGE.md](docs/audit/COVERAGE.md) on every run and ratcheted by `npm test` against [docs/audit/baseline.json](docs/audit/baseline.json): no total may fall, no process marked done may drop below 100%.

| Unit of the spec | Built / spec |
|---|---|
| T-numbered acceptance tests, one verbatim `node:test` each | 2,152 / 2,165 |
| Data-model tables created by a migration | 734 / 735 |
| Timer codes the engine can arm and satisfy | 2,032 / 2,032 |
| Notice templates authored with content rules | 307 / 307 |
| Agent tools registered as commands on the bus | 1,392 / 1,392 |
| Worked-example money figures reproduced by a test | 1,233 / 1,233 |
| **All spec units** | **7,850 / 7,864 (99.8%)** |
| Processes at 100% of their units | 183 / 185 |

| Area | Sections | Units built / spec |
|---|---|---|
| Servicing | §1–§19 | 4,583 / 4,583 |
| Origination | §20–§31 | 2,863 / 2,863 |
| Borrower experience | §32 | 346 / 354 |
| The partner book | §33 | 58 / 64 (33.3 in build) |

After every deploy a real browser with the real model walks the deployed demo and checks ten things a person must see work (`apps/borrower/tests/walk/demo-walk.mts`); a failed outcome fails the deploy. That walk, not the fractions, is the platform's claim that the surface works.

## What is here

**Servicing (sections 1–19).** Boarding and transfers in, cashiering and payment allocation, escrow, borrower communications and notices, Fannie Mae investor reporting and remittance, custodial accounts, compliance disclosures, credit reporting, insurance and property protection, PMI, early intervention and collections, loss mitigation, foreclosure, bankruptcy, REO and claims, payoff and lien release, transfers out, QC and regulatory reporting, records and security.

**Origination (sections 20–31).** Refinance triggers and pricing, the application and initial disclosures, the verification engine (credit, income, assets, identity, fraud), Desktop Underwriter and the credit decision, valuation and title and insurance, compliance testing and the Closing Disclosure, eClosing and funding, warehouse funding, QC and HMDA, secondary delivery to Fannie Mae, post-purchase boarding, and the cross-cutting rules for licensing, AI governance and fair lending.

**Borrower experience (section 32).** The doors (e-mail or phone code, password, passkey, OIDC), the conversation with Michelle, the cards, the record, the journey, the model turn with its guard (no figure the model typed, no DU or credit words, no approval language), the video agent, and the DU moment: the platform pulls credit and runs DU itself the moment the six items are in.

**The partner book (section 33).** 33.1: a partner's tape (the first partner's 118-column layout) and its e-mail/phone supplement become monitored loans and real accounts with an invitation and a reminder; the partner keeps servicing them. 33.2: the daily refinance review — 20.1's engine over the partner's facts, an analyst that writes the reason in plain words but cannot decide, offers delivered through the marketing gates and expired. 33.3 (in build): refinance readiness — what a refinance needs, what is on file and how fresh, the Yes that opens the refinance from a monitored loan, and the asks until DU runs.

**Surfaces.**

| Surface | Path | What it is |
|---|---|---|
| Borrower app | `/app` | the conversation, a rail with one current ask, the record; sign-in by code, password or passkey (`apps/borrower`, Next.js) |
| Video door | `/video` | a live call with Michelle that opens an account on the spot (FAKE vendor unless a Tavus key is set) |
| Ops console | `/ops` | loans, clocks, escalations, agent decisions, the AI log, the partner-book upload and report (`src/console`) |
| API | `/v1/*` | every command the surfaces use, the operator endpoints (transfers, partner-book imports, the sweep, the demo clock) |

**Agents.** 39 named agents (`spec/registry/agents.json`), from boarding and cashiering to the refinance analyst and the readiness agent, each with an allowlist of tools, guardrails and a decision record per action. Decisions that matter — credit, selection, money — are deterministic engines with decision records; the model speaks to the borrower and explains the analyst's review, and a guard rejects any figure it types.

## How it is governed

- **The spec is the source of truth.** Every process is a markdown file with a fixed set of headings; the extractors count its T-ids, tables, timers, notices, tools and worked figures. Code cites the rule it implements.
- **Fair lending and FCRA by construction.** Refinance selection reads an allowlist of facts; name, ZIP, age, DTI and score are not inputs; no consumer report is pulled to select anyone; a partner's score prices an offer only after the borrower's own Yes.
- **People where the law wants them.** The officer approves a campaign once and any waiver on a money field; the loan officer of record reviews terms; the compliance officer trips the kill switch. Nothing else waits on a human. Outside production those roles are FAKE reviewers that approve after a delay so the demo runs unattended.
- **Append-only records.** Events, ledger sets (balanced, with a rule reference), decisions and notices are never edited; every clock is armed by an event and satisfied by an event, with a breach escalation.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the conventions that are not optional and how a section is added; [docs/ux/](docs/ux/) for the borrower product's design and copy; [docs/DEPLOY.md](docs/DEPLOY.md) for hosting.

## What is real and what is simulated

Real: the platform, its data model (756 tables over 127 migrations), every rule and clock, the borrower and video surfaces, the model turns (Claude through `@anthropic-ai/sdk`), the Google Cloud deploy (Cloud Run, Cloud SQL, a load balancer with Cloud Armor, Cloud Scheduler running the sweep every minute), CI and the browser walk after every deploy.

Simulated, in every build stage so far: every outside vendor is an in-repo FAKE that behaves like the real one — Stripe Identity, Plaid, Truv, the credit bureau, Desktop Underwriter, FRED rates, e-mail and SMS, print and mail, e-vault, MERS, lockbox, e-OSCAR — and the partner's tape is a deterministic twelve-loan fixture in the partner's own layout. `INTEGRATIONS=fake` is the only mode that exists. Do not load real borrower data into the nonprod deploy; the production controls are listed in [docs/DEPLOY.md](docs/DEPLOY.md).

## Layout

```
spec/                     the specification: one markdown file per process under sections/<nn>-<slug>/, a README per section;
                          registry/ (sections, processes, timers, notices, agents, manifest) is machine-readable and generated
src/kernel/               money (bigint cents, Decimal, amortization), calendars (PlainDate, four day counts), events, FSM, ledger, timers
src/domain/<section>/     the business logic and the per-process acceptance tests (<n>-<m>.spec.test.ts, one node:test per T-id)
src/app/                  the command bus, agent registry and kill switch, role gates, gate evaluators, tools per process (tools/section*.ts)
src/notices/              the notice registry: authored templates, content checklists, channel decisions, delivery
src/infra/db/             Postgres repositories and the unit of work over db/migrations/
src/infra/integrations/   adapter ports and their FAKEs (the outbox, e-mail/SMS, credit, DU, Plaid, Truv, rates, e-vault, MERS …)
src/runtime/              the hosted runtime: main.ts (serve · sweep · migrate · seed-demo), the API server, the daily refinance run,
                          the partner book (import, review, readiness), the borrower API and its flows and agent turn (runtime/borrower/)
src/console/              the ops console at /ops
apps/borrower/            the borrower app (Next.js) and the demo walk
db/migrations/            append-only schema (bigint cents; immutable events, ledger, decisions)
infra/                    Terraform and the bootstrap script for Google Cloud
tools/                    spec extraction, registration, manifest, audit, scaffolding and lints
docs/                     ARCHITECTURE, DEPLOY, the audit (COVERAGE, baseline), the UX design and copy library
```

## Running

Node ≥ 22 (type-stripping, no build step) and Postgres 16.

```sh
npm install
service postgresql start                                           # or your own Postgres
DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh
npm run typecheck
npm test                  # every test file, then the audit ratchet and the name lint (database suites skip without Postgres)
npm run audit             # the fractions above, regenerated into docs/audit/
npm run spec:lint         # how much of the timer registry is mechanically armable and satisfiable
```

Database-backed suites create their own database from `TEST_DATABASE_URL` (default `…/supermortgage_test`); run one on its own with

```sh
REQUIRE_DB=1 TEST_DATABASE_URL=postgresql://sm:sm@localhost/supermortgage_x node --experimental-strip-types --test src/domain/partner-book/33-1.spec.test.ts
```

### Hosted runtime

`src/runtime/main.ts` is the container entrypoint (`Dockerfile`), four modes on one image:

```sh
export DATABASE_URL=postgresql://sm:sm@localhost/supermortgage API_TOKEN=dev-token
npm run migrate           # db/migrate.sh through the entrypoint (the Cloud Run migrate job)
npm start                 # the API and the ops console on $PORT (default 8080): GET /healthz, /readyz; the borrower API under /v1/borrower
npm run sweep             # one pass: the flows' tick, the daily refinance run (06:30 ET), the daily review (07:00 ET), readiness (07:15 ET),
                          # the FAKE reviewers, due timers, the outbox, the invitation reminders — then exit (Cloud Scheduler runs it every minute)
node --experimental-strip-types src/runtime/main.ts seed-demo    # the 100-loan demo transfer batch, the entry demo, the fixture partner book
```

The borrower app: `cd apps/borrower && npm install && npm run dev` (it talks to the API above). The demo walk against a deployed host: `DEMO_BASE=https://… node --experimental-strip-types tests/walk/demo-walk.mts` from `apps/borrower`.

Every API route but the probes needs `Authorization: Bearer $API_TOKEN` (the borrower API uses its own sessions). A tool call hydrates the subject's rows, events, ledger and open timers, runs through the command bus (allowlists, roles, guardrails, decision record) and commits in one transaction; a refusal answers 409 with the guardrail's code and citation.

### Deploy

Google Cloud — Cloud Run (API, borrower app), Cloud SQL, Secret Manager, a load balancer with Cloud Armor, deploys from GitHub Actions over Workload Identity Federation — is in `infra/` and documented step by step in [docs/DEPLOY.md](docs/DEPLOY.md). Two workflows: `ci` (typecheck, tests, the registry lint, migrations on a fresh database, the image built and run in all its modes) and `deploy` (Terraform, images, migrate, deploy, smoke tests, then the demo walk).

## Working on it

The process is spec-first and measured; the rules are in [CLAUDE.md](CLAUDE.md). In short: read the process's markdown end to end before touching it; reproduce its T-ids verbatim as tests and its worked arithmetic as assertions; a new section starts from `spec/TEMPLATE-process.md` and is registered before its first commit (`npm run spec:register && npm run spec:manifest && npm run spec:scaffold`); `npm test` and `npm run typecheck` pass before every commit, and the baseline moves up in the same commit as the work that earned it, never down.

## Next

1. 33.3 refinance readiness (in build), then regular tapes on 33.1: a loan that disappears from a later tape is held and resolved by a person, a late tape breaches a clock, a late e-mail gets a late invitation.
2. Section 34, the operator portal: staff sign-in with roles, the account directory and every person's activity, partner book operations, evidence and controls. Internal only.
3. The partner book seeded on the deployed demo and an eleventh walk outcome: a homeowner from the book signs in from the invitation, says Yes, and reaches DU.
4. The path to production in [docs/DEPLOY.md](docs/DEPLOY.md), and the first real vendor adapter on the nonprod path.
