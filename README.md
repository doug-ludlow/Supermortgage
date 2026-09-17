# Supermortgage

Supermortgage is the Self-Improving Mortgage: homeowners are continuously and automatically refinanced at the best available interest rate. The average US homeowner would save close to $100,000 over the life of a loan.

It is one platform that acquires, originates and services mortgages, run by agents, with people only where the law puts them.

The first customers come through servicer partnerships. A servicer hands us its book and every homeowner on it becomes a member. Every morning an agent reviews each loan against live rates and the partner's own facts. When a refinance is worth the homeowner's attention the offer goes out; the homeowner says yes, applies on their phone, and the file is assembled, underwritten, closed, funded, delivered to Fannie Mae and boarded without anyone touching a row. The new loan is serviced on the same platform, the prior loan is paid off and released, and the review runs again the next morning.

```
partner tape → accounts + invitation → daily review → offer → Yes → Apply
  → credit · income · assets · identity → DU → disclosures → eClose · fund
  → deliver to Fannie Mae → board → pay off the prior loan → service → daily review …
```

Everything is built to the [specification](spec/) in `spec/sections/` (36 sections, 212 processes) and measured against it. Nothing is done by assertion: a process is done when the audit counts every one of its units as built, and the audit only counts a real test carrying the spec's exact wording.

## Status (measured, 16 September 2026)

From `npm run audit` (`tools/audit.py`), which measures the tree against `spec/registry/manifest.json`, the spec in its own units. It is regenerated into [docs/audit/COVERAGE.md](docs/audit/COVERAGE.md) on every run and ratcheted by `npm test` against [docs/audit/baseline.json](docs/audit/baseline.json): no total may fall, and no process marked done may drop below 100%.

| Unit of the spec | Built / spec |
|---|---|
| T-numbered acceptance tests, one verbatim `node:test` each | 2,435 / 2,480 |
| Data-model tables created by a migration | 848 / 852 |
| Timer codes the engine can arm and satisfy | 2,097 / 2,097 |
| Notice templates authored with content rules | 308 / 309 |
| Agent tools registered as commands on the bus | 1,574 / 1,579 |
| Worked-example money figures reproduced by a test | 1,467 / 1,470 |
| **All spec units** | **8,729 / 8,787 (99.3%)** |
| Processes at 100% of their units | 204 / 212 |
| Tools executed over the hosted API (35.11) | 1,550 / 1,579 |
| Tables that hold rows after the journeys (35.11) | 128 / 852 |

Twenty-seven T-ids are retired by a dated owner decision in [docs/decisions/](docs/decisions/) and subtracted before the count.

| Area | Sections | Units built / spec | Processes at 100% |
|---|---|---|---|
| Servicing | §1–§19 | 4,594 / 4,594 | 114 / 114 |
| Origination | §20–§31 | 2,939 / 2,939 | 54 / 54 |
| Borrower experience | §32 | 349 / 350 | 17 / 18 |
| The partner book | §33 | 69 / 69 | 3 / 3 |
| The operator portal | §34 | 63 / 80 | 4 / 5 |
| The operations runtime | §35 | 715 / 715 | 12 / 12 |
| The servicing partner portal | §36 | 0 / 40 | 0 / 6 (specified, not built) |

After every deploy a real browser walks the Apply product on the deployed demo and checks ten things a person must see work (`apps/borrower/tests/walk/demo-walk.mts`): the door, the account, a purchase to the underwriting run, a purchase still looking for a home, a cash-out refinance to the same run, errors shown in plain words, My Loan and Tasks, sign-out, the partner-book homeowner's door, and returns and deep links. A failed outcome fails the deploy. The walk takes about two and a half minutes and read ten of ten on the latest deploy. That walk, not the fractions, is the platform's claim that the surface works. The same job then walks the partner portal at `/partners` (`apps/partner/tests/walk/partner-walk.mts`: the door, the seeded admin's sign-in, Home, Eligibility, a loan page's banner and Serviced tab, sign-out — seven outcomes, each recorded by name).

## What is here

**Servicing (sections 1–19).** Boarding and transfers in, cashiering and payment allocation, escrow, borrower communications and notices, Fannie Mae investor reporting and remittance, custodial accounts, compliance disclosures, credit reporting, insurance and property protection, PMI, early intervention and collections, loss mitigation, foreclosure, bankruptcy, REO and claims, payoff and lien release, transfers out, QC and regulatory reporting, records and security.

**Origination (sections 20–31).** Refinance triggers and pricing, the application and initial disclosures, the verification engine (credit, income, assets, identity, fraud), Desktop Underwriter and the credit decision, valuation and title and insurance, compliance testing and the Closing Disclosure, eClosing and funding, warehouse funding, QC and HMDA, secondary delivery to Fannie Mae, post-purchase boarding, and the cross-cutting rules for licensing, AI governance and fair lending.

**Borrower experience (section 32).** The Apply product at `/app`: five tabs (Apply, Chat, My Loan, Tasks, Account) on one paper-and-ink surface, a step per screen from the goal to Review, every vendor call finishing on the tap, and the DU moment, where the platform pulls credit and runs DU itself the moment the six items are in. The doors (e-mail code, password, passkey, Sign in with Google), the conversation with Michelle behind Chat, the record, the journey, the model turn with its guard (no figure the model typed, no DU or credit words, no approval language), and the video agent at `/video`.

**The partner book (section 33).** A partner's tape (the first partner's 118-column layout) and its e-mail and phone supplement become monitored loans and real accounts with an invitation and a reminder; the partner keeps servicing them. The daily refinance review runs 20.1's engine over the partner's facts, an analyst writes the reason in plain words but cannot decide, and offers go out through the marketing gates and expire. Refinance readiness knows what a refinance needs, what is on file and how fresh, takes the Yes that opens the refinance from a monitored loan, and asks for what is missing until DU runs.

**The operator portal (section 34).** Staff accounts behind a real sign-in with roles, the action log, the account directory of every person and their activity masked by role, partner-book operations (uploads, import history, reviews, readiness, the daily report), and the evidence and controls views (clocks, escalations, the outbox, AI systems, the evidence pack). The portal's information architecture and the accounts list (34.5) are the open work.

**The operations runtime (section 35).** What takes a measured-complete spec from a demonstration to a platform that runs loans over time: the persistence seam and the typed record, documents and artifacts (the object store, the PDF writer, e-sign envelopes, print and mail manifests), cycles and jobs with receipts, month-end and year-end close, the installment schedule and the daily cashiering cycle (lockbox, ACH, NACHA returns), closing-to-delivery orchestration, operating roles and credentials for every person the spec names, operator work screens, default operations over time, the refinance close of the loop (the prior loan paid off, released and linked), operations stewardship with hosted measurement, and production posture (a production environment apart from nonprod, a vendor switch per integration, backups, the restore drill, the go-live checklist).

**The servicing partner portal (section 36).** Specified, registered and scaffolded; nothing built yet. Partner users and roles under a tenant scope, the tape drop, an eligibility board, the refinance pipeline feed, the partner's home and reports, and the post-refinance serviced pane.

**Surfaces.**

| Surface | Path | What it is |
|---|---|---|
| Apply | `/app` | the borrower product: Apply, Chat, My Loan, Tasks, Account; sign-in by code, password, passkey or Google (`apps/borrower`, Next.js) |
| Video door | `/video` | a live call with Michelle that opens an account on the spot (a FAKE stage unless a Tavus key is set) |
| Operator portal | `/ops` | staff sign-in, the directory, the partner book, clocks, escalations, agent decisions, the AI log, the work screens (`src/console`) |
| Partner portal | `/partners` | the servicing partner's people: sign-in by code and password, the tape drop, the eligibility board, the refinance pipeline, the daily report, the partner's users (`apps/partner`, Next.js, over `/v1/partner/*`); deployed at `/partners` on the demo host as its own Cloud Run service behind the load balancer (`Dockerfile.partner`, `infra/terraform`), walked after every deploy by `apps/partner/tests/walk/partner-walk.mts` |
| API | `/v1/*` | every command the surfaces use, the operator endpoints (transfers, partner-book imports, the sweep, the demo clock) |

**Agents.** Forty named agents (`spec/registry/agents.json`), from boarding and cashiering to the refinance analyst, the readiness agent and the ops steward, each with an allowlist of tools, guardrails and a decision record per action. Decisions that matter (credit, selection, money) are deterministic engines with decision records; the model speaks to the borrower and explains the analyst's review, and a guard rejects any figure it types.

## How it is governed

- **The spec is the source of truth.** Every process is a markdown file with a fixed set of headings; the extractors count its T-ids, tables, timers, notices, tools and worked figures. Code cites the rule it implements.
- **Fair lending and FCRA by construction.** Refinance selection reads an allowlist of facts; name, ZIP, age, DTI and score are not inputs; no consumer report is pulled to select anyone; a partner's score prices an offer only after the borrower's own Yes.
- **People where the law wants them.** The officer approves a campaign once and any waiver on a money field; the loan officer of record reviews terms; the compliance officer trips the kill switch. Nothing else waits on a human. Outside production those roles are FAKE reviewers that approve after a delay so the demo runs unattended.
- **Append-only records.** Events, ledger sets (balanced, with a rule reference), decisions and notices are never edited; every clock is armed by an event and satisfied by an event, with a breach escalation.
- **Retired units are recorded, never deleted.** A decision that retires part of the spec is a dated record in `docs/decisions/` quoting the owner's words, and one appended row of `spec/registry/retired.json`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the conventions that are not optional and how a section is added; [docs/ux/](docs/ux/) for the borrower product's design and copy; [docs/DEPLOY.md](docs/DEPLOY.md) for hosting; [docs/README.md](docs/README.md) for the map of the documentation.

## What is real and what is simulated

Real: the platform, its data model (848 tables over 176 migrations), every rule and clock, the Apply and video surfaces, the operator portal, the model turns (Claude through `@anthropic-ai/sdk`), the Google Cloud deploy (Cloud Run, Cloud SQL, a load balancer with Cloud Armor, Cloud Scheduler running the sweep every minute), CI and the browser walk after every deploy.

Real, since 23.5–23.7 landed: the DU Specification document. What 23.1 hashes and would send is a MISMO 3.4 B324 file assembled from the relationship graph against tables generated from Fannie Mae's own specification, matching all eighteen of Fannie's sample submissions and preflighted against the checks DU applies beyond the schema ([docs/du-graph.md](docs/du-graph.md)). The transport is not real: the port is a FAKE that validates the bytes with the same XSD chain, mints DU's casefile identifier itself and answers with fixture findings.

Simulated: every outside vendor port is an in-repo FAKE that behaves like the real one (Stripe Identity, Plaid, Truv, the credit bureau, the DU transport, FRED rates, e-mail and SMS, print and mail, e-vault, MERS, lockbox, e-OSCAR, RON, title, Tavus, Google sign-in), and the partner's tape is a deterministic twelve-loan fixture in the partner's own layout. `INTEGRATIONS=fake` is the mode every deploy runs in. `INTEGRATIONS=real` exists (35.12): each vendor has a switch, a production environment refuses `fake` at start, and a real switch with no adapter answers a typed refusal per call rather than crashing. One real adapter is written today, the BAI2 lockbox file reader; every other switch is unbound. Do not load real borrower data into the nonprod deploy; the production controls are in [docs/DEPLOY.md](docs/DEPLOY.md).

## Layout

```
spec/                     the specification: one markdown file per process under sections/<nn>-<slug>/, a README per section;
                          registry/ (sections, processes, timers, notices, agents, retired, manifest) is machine-readable and generated
src/kernel/               money (bigint cents, Decimal, amortization), calendars (PlainDate, six day counts), events, FSM, ledger, timers
src/domain/<section>/     the business logic and the per-process acceptance tests (<n>-<m>.spec.test.ts, one node:test per T-id);
                          operations-runtime/ holds section 35, borrower/ section 32, partner-book/ section 33, operator-portal/ section 34
src/app/                  the command bus, agent registry and kill switch, role gates, gate evaluators, tools per process (tools/section*.ts)
src/notices/              the notice registry: authored templates, content checklists, channel decisions, delivery
src/infra/db/             Postgres repositories, the unit of work over db/migrations/, the per-suite test databases
src/infra/integrations/   adapter ports and their FAKEs (the outbox, e-mail/SMS, credit, DU, banking, e-vault, MERS, rates, OIDC, Tavus …)
src/runtime/              the hosted runtime: main.ts (serve · sweep · migrate · seed-demo), the API server, the sweep's passes,
                          the partner book, the demo clock, the borrower API with its flows and agent turn (runtime/borrower/)
src/console/              the operator portal and console at /ops
apps/borrower/            the Apply product (Next.js) and the demo walk (tests/walk/)
db/migrations/            append-only schema (bigint cents; immutable events, ledger, decisions)
infra/                    Terraform and the bootstrap script for Google Cloud
tools/                    spec extraction, registration, manifest, audit, scaffolding, lints, the affected-suite gate, the hosted probe
docs/                     ARCHITECTURE, DEPLOY, the audit (COVERAGE, baseline, VERIFICATION), decisions, the UX design and copy library
```

## Running

Node ≥ 22.18 (type-stripping, no build step) and Postgres 16.

```sh
npm install
service postgresql start                                           # or your own Postgres
DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh
npm run typecheck
npm run test:affected     # the commit gate: the non-browser suites a change can reach, then the audit ratchet
npm test                  # every test file (a landing), then the audit ratchet, the name lint and the DU schema check
npm run audit             # the fractions above, regenerated into docs/audit/
npm run spec:lint         # how much of the timer registry is mechanically armable and satisfiable
```

Every database-backed suite calls `testDatabase(import.meta.url)` (`src/infra/db/test-db.ts`) and gets its own database, cloned in well under a second from a template migrated once per server. No suite runs `db/migrate.sh` itself and no two suites share a database, so `npm run test:db` (`REQUIRE_DB=1`, every suite, no skipping) runs the whole tree concurrently. Six suites drive Chromium; they take one browser lock and rebuild the borrower app, so they run at landings, in CI and with `npm run test:affected -- --browser`, not on every commit. One suite on its own:

```sh
REQUIRE_DB=1 node --experimental-strip-types --test src/domain/partner-book/33-1.spec.test.ts
```

### Hosted runtime

`src/runtime/main.ts` is the container entrypoint (`Dockerfile`), four modes on one image:

```sh
export DATABASE_URL=postgresql://sm:sm@localhost/supermortgage API_TOKEN=dev-token
npm run migrate           # db/migrate.sh through the entrypoint (the Cloud Run migrate job)
npm start                 # the API and the operator portal on $PORT (default 8080): GET /healthz, /readyz; the borrower API under /v1/borrower
npm run sweep             # one pass, then exit (Cloud Scheduler runs it every minute)
node --experimental-strip-types src/runtime/main.ts seed-demo    # the 100-loan demo transfer batch, the entry demo, the fixture partner book
```

One sweep pass runs, in order: the scheduled cycles (35.3), the daily refinance check (20.1, at or after 06:30 ET), the partner book's daily review, readiness and daily reports (33.x), the controls, the FAKE reviewers, the role queues, the work queues, the production-posture scan, the closing orchestration and its daily receipt, the refinance close-out and board (35.10), the default cases (35.9), the ops steward (35.11), breach actions and due timers, the close plan (35.4), the partner-book reminders and late-tape clock, and the document manifests. Every pass commits through the command bus, so what one pass satisfies is never breached by the next.

The Apply product: `cd apps/borrower && npm install && npm run dev` (it talks to the API above). The demo walk against a deployed host: `DEMO_BASE=https://… node --experimental-strip-types tests/walk/demo-walk.mts` from `apps/borrower`.

Every API route but the probes needs `Authorization: Bearer $API_TOKEN` or a staff or partner credential (35.7); the borrower API uses its own sessions. A tool call hydrates the subject's rows, events, ledger and open timers, runs through the command bus (allowlists, roles, guardrails, decision record) and commits in one transaction; a refusal answers 409 with the guardrail's code and citation.

### Deploy

Google Cloud (Cloud Run for the API and the Apply product, Cloud SQL, Secret Manager, a load balancer with Cloud Armor) deploys from GitHub Actions over Workload Identity Federation; it is in `infra/` and documented step by step in [docs/DEPLOY.md](docs/DEPLOY.md). Three workflows:

- `ci`: the checks (typecheck, the audit ratchet, the name lint, the DU schema check, migrations on a fresh database, the hosted probe of every tool), the test suite in four shards, and the image built and run in all its modes. About nine minutes.
- `deploy`: preflight, Terraform, the two images, migrate, deploy, smoke tests, then the demo walk. A push that changes only documentation ships nothing.
- `walk`: the same ten-outcome walk on demand against any base URL.

## Working on it

The process is spec-first and measured; the rules are in [CLAUDE.md](CLAUDE.md). In short: read the process's markdown end to end before touching it; reproduce its T-ids verbatim as tests and its worked arithmetic as assertions; a new section starts from `spec/TEMPLATE-process.md` and is registered before its first commit (`npm run spec:register && npm run spec:manifest && npm run spec:scaffold`). Before a commit: `npm run typecheck` and `npm run test:affected`, plus the borrower app's typecheck, lint and unit tests when its files changed. CI is the full-suite gate and a red CI is fixed forward at once; the full local `npm test` is for landing a branch. The baseline moves up in the same commit as the work that earned it, never down.

## Next

1. The open spec units: 34.5 (the portal's information architecture and the accounts list, 5 of 22), 32.19-T18 (every rendered string a copy key, one test), and section 36, the servicing partner portal (40 units, spec only).
2. The Direct Integration transport to Desktop Underwriter, blocked on TSP onboarding and on Fannie Mae's DU Error Codes document; until then the port stays a FAKE that validates what it is sent.
3. The real vendor adapters behind the 35.12 switches: one is written (the BAI2 lockbox reader); identity, credit, income and asset verification, rates, e-mail and SMS, print and mail, e-vault, MERS, e-OSCAR, RON, title and Google sign-in are not.
4. The two arcs whose endpoints disagree in Fannie's ArcRoles tab (`UNDERWRITING_VERIFICATION` to `ASSET` and to `EMPLOYER`): a question for Fannie Mae, never a guess ([docs/du-graph.md](docs/du-graph.md)); and `COUNSELING_EVENT` on the graph before HomeReady is offered.
5. The cash-out purpose on the servicing channel's own loan-amount card (32.11), so a refinance opened from a monitored loan carries `RefinancePrimaryPurposeType` the way the Apply product does.
