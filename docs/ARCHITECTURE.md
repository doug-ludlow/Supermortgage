# Architecture

Supermortgage is one platform built to one specification: 36 sections, 212 processes, under `spec/sections/`. Sections 1–19 are servicing, 20–31 origination, 32 the borrower experience, 33 the partner book, 34 the operator portal, 35 the operations runtime and 36 the servicing partner portal. Everything below is measured by `tools/audit.py` against `spec/registry/manifest.json`; the current fractions are in [audit/COVERAGE.md](audit/COVERAGE.md) and the only allowed statement of progress is one of those fractions.

## The shape of every process

Every process spec has the same eleven subsections (`spec/TEMPLATE-process.md`), and the code for a process maps onto them one to one:

| Spec subsection | Lands in |
|---|---|
| Inputs and triggers | the events the process consumes; the tools' input shapes in `src/app/tools/section<n>-<m>.ts` |
| Data model | `db/migrations/<nnnn>_<slug>.sql` (append-only; 176 files today, numbered sparsely in reserved blocks) + `types.ts` in the domain module |
| State machine | `machine.ts`, a `Machine<State, Ctx>` from `src/kernel/fsm` |
| Timers and gates | rows in `spec/registry/timers.json`; the section's `timers.ts` holds cited overrides where a row's prose carries a condition the offset grammar cannot parse |
| Business rules and calculations | `rules.ts` / `allocation.ts` and their kin: pure functions over integer cents; every worked example is a test |
| Integrations | a port in `src/infra/integrations/` with an in-repo FAKE (35 `Fake*` classes today) and, under `INTEGRATIONS=real`, the adapter the vendor's switch names (35.12) |
| Outputs and artifacts | events, balanced ledger entry sets, notices, documents (35.2's object store and PDF writer) |
| AI agent design | `service.ts` and the process's tool file: the agent's tool surface, every command a validated, role-checked function the AI path and the human path both call |
| Edge cases and failure modes | guardrails on the tools (a refusal answers 409 with the guardrail's code and citation) and the failure rows of the tests |
| Test cases and acceptance criteria | `src/domain/<section>/<n>-<m>.spec.test.ts`, one `node:test` per T-id titled exactly as the spec |
| Audit and evidence | the event log, the ledger, `agent_decisions`, the action log, and the audit's hosted and persisted columns (35.11) |

## Non-negotiable conventions

1. **Money is `bigint` cents.** Never `number`. Rates and amortization go through `Decimal` (fixed scale 30) and are rounded once, half-up, at the point the spec says.
2. **Dates are `PlainDate` civil dates** anchored to the calendar the spec names. The six day units are `calendar_days`, `business_days_federal`, `business_days_servicer`, `business_days_fannie_et`, `business_days_creditor` (Reg Z §1026.2(a)(6) general) and `business_days_regz_specific` (Reg Z specific; Saturdays count). They are never substituted for one another. Wall-clock cut-offs are resolved in the named zone.
3. **Append-only.** Events, ledger lines, decisions, notices and the action log are never updated or deleted (a trigger in Postgres, construction in memory). Corrections are new rows. Migrations are append-only too: a new file, never an edit to an applied one.
4. **Every ledger entry set balances** or it is rejected, in memory by `MemoryLedger.post` and in Postgres by a deferred constraint trigger at commit. Every line carries the `rule_ref` that justified it.
5. **Timers come from the registry.** Section code does not hard-code deadlines; it emits the trigger event with the payload fields the row anchors on, and the engine arms, satisfies and breaches. Where a row's prose cannot be parsed, the section's `timers.ts` adds a cited override rather than a silent guess.
6. **Agents propose; humans approve what the spec says humans approve.** Money fields are never agent-corrected; waivers need an `officer`; the service refuses otherwise and writes nothing. Every agent action that changes state leaves an `agent_decisions` row with rule set, model and prompt versions.
7. **The AI path and the human path run the same validators.** The tool surface is the only way to change state; the operator portal, the borrower surfaces and the agents all call it through the command bus.
8. **Every vendor is a FAKE in every build stage.** `INTEGRATIONS=fake` is the mode every deploy runs in; a production environment refuses it at start (`NO_FAKE_IN_PRODUCTION`); under `real` each vendor's switch names its adapter, and a real switch with no adapter answers a typed refusal per call.
9. **Erasable TypeScript only.** Node 22 runs `.ts` directly with type-stripping: no `enum`, no parameter properties, no namespaces, no build step.
10. **Status is measured, not remembered.** Progress is a fraction from `npm run audit`; a T-id counts only as a non-todo `node:test` with the spec's exact title, a timer only when armable, satisfiable and its events emitted by source. `npm test` ends with the ratchet (`tools/audit.py --check`): no total in `docs/audit/baseline.json` may fall, and the baseline moves up only in the commit that earned it.
11. **Retired units are recorded, never deleted.** A decision that retires part of the spec is a dated record in `docs/decisions/` quoting the owner's words; each retired unit is one appended row of `spec/registry/retired.json` citing that record, which the audit subtracts before it counts. Twenty-seven T-ids are retired today, all by the 2026-09-16 Apply product decision.

## How the platform is layered

```
spec/registry/            sections, processes, timers, notices, agents, retired, manifest — generated, machine-readable
src/kernel/               money, calendars, events, FSM, ledger, timers, concurrency
src/domain/<section>/     rules, machines, services and the per-process acceptance tests (36 modules today)
src/app/                  the command bus, the agent registry and kill switch, roles, gate evaluators, escalations, tools per process
src/notices/              the notice registry: authored templates, content checklists, channel decisions, delivery
src/infra/db/             repositories, the unit of work, the per-suite test databases
src/infra/integrations/   ports and FAKEs; 35.12's real-ports seam binds real adapters under INTEGRATIONS=real
src/runtime/              the hosted runtime (serve, sweep, migrate, seed-demo), the API, the sweep's passes, the borrower API and flows
src/console/              the operator portal at /ops (34.x) and the work screens (35.8)
apps/borrower/            the Apply product (32.19) and the demo walk
```

A tool call hydrates the subject's rows, events, ledger and open timers, runs through the command bus (allowlists, roles, guardrails, decision record) and commits in one transaction. The unit of work is scoped to a loan, an application or both (`PgUnitOfWork.run({ loanId?, applicationId? })`).

## One product: servicing, origination, the surfaces and the runtime

Sections 1–19 (servicing) and 20–31 (origination, imported by `tools/import_origination.py`) are one platform with one id grammar, one registry, one audit and one kernel. Sections 32–36 project and operate them; none of them redefines a name.

- **A name means one thing everywhere.** A table, event, timer code, notice code, agent or role one section defines is reused by the others, never redefined. `python3 tools/spec_lint_names.py` (run by `npm test`) fails on a timer code re-triggered by a different event in a later section or an agent, role or calendar the kernel lacks; `src/kernel/timers/registry.ts` lets the lowest-numbered section own a shared code and treats later rows as references. A rule that genuinely differs gets its own code, named as the variant.
- **One loan for life.** Before funding the aggregate is `applications`; events, timers, decisions, consents, documents and escalations carry `application_id`. 30.2 creates the servicing `loans` row at funding with `origination_application_id` and boards it through 1.1's pipeline; from then on the same row is what sections 2–19 service. Purchase (30.1) is an investor update, never a re-board. Payoff (16) retires the row; a refinance (20) opens a new application with `prior_loan_id`, and 35.10 pays off, releases and links the prior loan when the new one funds.
- **Two contexts, one engine.** Timers defined by sections 20–31 arm only on events that carry origination context; a transferred-in loan never picks up an origination clock.
- **One runtime, one service set.** The hosted `Runtime` (`src/runtime/app.ts`) executes every tool through the same command bus the unit harnesses use and constructs one instance per runtime of each stateful section service over forwarding stores whose writes land in the unit of work of the command that is executing. 35.1's persistence seam moves the entity records that matter into typed tables and dispatches the integration outbox.
- **One sweep, every minute.** `Runtime.sweep` is the scheduled pass both the Cloud Run job and `POST /v1/sweep` take. It takes a lease (one sweep at a time; a firing that finds the lease held writes `sweep.run_skipped` and exits), writes a `sweep_runs` row, and runs its passes in this order: `outbox.dispatch`, `cycles` (35.3's planner and executor), `refi.daily` (20.1, once a day at or after 06:30 ET), `partner_book.review` (33.2), `partner_book.readiness` (33.3), `partner_book.daily_reports` (34.3), `controls` (34.4), `fake_reviewers` (every pending human item older than the delay, approved as `human:FAKE:<role>`, outside production only), `roles.sweep` (35.7), `work.sweep` (35.8), `posture.sweep` (35.12), `orchestration.pass` and `orchestration.daily_receipt` (35.6), `refinance.closeout` and `refinance.board` (35.10), `record.verify` (35.1, daily), `default_case.daily` (35.9), `ops.steward` (35.11), `breach_action.recon`, `timers.breach` (paged), `work.breaches`, `close.plan` (35.4), `partner_book.reminders` and `partner_book.tape_late` (33.1), `refinance.breach_actions` (35.10) and `documents` (35.2's staged-blob drain), then the `sweep.run_completed` receipt. Every pass commits through the command bus, so what one satisfies is never breached by the next. The borrower flows' scheduled tick is the sweep entry point's and the demo clock's, not a pass of `Runtime.sweep`.
- **The borrower surfaces (32).** The spec for section 32 is generated from `docs/ux/` by `tools/import_ux.py`; it projects sections 1–31 and owns no timer, notice or worked figure. The product surface is the Apply product on `/app` (32.19): the door, the steps to Review, five tabs, every vendor call finishing on the tap, and the DU moment (32.18), where the platform pulls credit and runs DU itself at the six items. The conversation (32.16) sits behind Chat; the video agent (32.17) stays mounted at `/app/video`. Its tests are API-level `node:test` plus Playwright driven from `node:test` in `src/domain/borrower`, against the FAKE vendors.
- **The partner book (33) and the operator portal (34).** A partner's tape becomes monitored loans and real accounts; the daily review and readiness run as sweep passes; staff run the platform from `/ops` behind a real sign-in with roles and an action log (34.1), the directory (34.2), the book operations (34.3) and the evidence and controls views (34.4).
- **The operations runtime (35).** What turns a measured-complete spec into a platform that runs loans over time: the persistence seam (35.1), documents (35.2), cycles and jobs with receipts (35.3), month-end and year-end close (35.4), the installment schedule and the daily cashiering cycle (35.5), closing-to-delivery orchestration (35.6), operating roles and credentials on `/v1` (35.7), operator work screens (35.8), default operations over time (35.9), the refinance close of the loop (35.10), stewardship and hosted measurement (35.11) and production posture (35.12).
- **Two journeys prove it.** `src/runtime/lifecycle.test.ts` runs one synthetic borrower over HTTP from the refinance trigger on an existing loan through application, quote, LE, intent, lock, commitment, verifications, DU and the decision, valuation, the CD, documents, consummation, funding, the 30.2 hand-off into one `loans` row, delivery and purchase, a payment, a payoff and a new refinance application, and audits the id grammar over the whole log. `src/runtime/purchase-lifecycle.test.ts` drives the purchase journey the same way; steps the tool surface does not carry yet are listed in that file's header as gaps, never faked.

## Adding a section or a process

Sections are markdown-first: the spec exists, is registered and is counted before any code.

1. Copy `spec/TEMPLATE-process.md` (and `spec/TEMPLATE-section-README.md` for a new section) into `spec/sections/<nn>-<slug>/`, keep the headings verbatim, and write the process: its T-numbered acceptance tests, tables, timer rows, notices, tools and worked figures in the exact textual forms the template's comment block states.
2. `npm run spec:register && npm run spec:manifest && npm run spec:scaffold`. Registration re-derives the timer rows from the file, the manifest counts the units, and the scaffold writes `src/domain/<section>/<n>-<m>.spec.test.ts` with one `todo` test per T-id, titled exactly. The audit measures the section from its first commit.
3. `npm run spec:lint -- --verbose` lists timer rows the offset grammar cannot parse; add a cited override in the section's `timers.ts` for each, never a hard-coded deadline in service code.
4. Build to the spec: the migration for the data model, `types.ts`, `machine.ts`, the rules, the service and the tool file. Implement a T-id by replacing its `todo: true` line with the real test; reproduce the worked arithmetic as assertions.
5. Before each commit: `npm run typecheck` and `npm run test:affected` (the borrower app's typecheck, lint and unit tests when its files changed). A landing runs the full `npm test`; CI runs it on every push. Move the baseline up with `npm run audit:baseline` in the same commit as the work that earned it.
6. Note the open questions you resolved and the default you took in the commit message. A process is done only when its row in `docs/audit/COVERAGE.md` is at 100% of its units.
