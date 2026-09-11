# Architecture

## The shape of every process

Each of the 114 process specs has the same eleven subsections, and the code
for a process maps onto them one-to-one:

| Spec subsection | Lands in |
|---|---|
| Data model | `db/migrations/00nn_<section>.sql` + `types.ts` in the domain module |
| State machine | `machine.ts` — a `Machine<State, Ctx>` from `src/kernel/fsm` |
| Timers and gates | rows in `spec/registry/timers.json`; `timers.ts` holds explicit, cited overrides where the row's prose carries a condition the grammar can't |
| Business rules and calculations | `rules.ts` / `allocation.ts` — pure functions, integer cents, worked examples become tests |
| Integrations | adapters (not yet built) that emit/consume `integration_messages` |
| Outputs and artifacts | events + ledger entry sets + documents |
| AI agent design | `service.ts` — the agent's *tool surface*; every command is a validated, role-checked function the AI path and the human path both call |
| Test cases and acceptance criteria | `<process>.test.ts` — the spec's T-numbers, verbatim |
| Audit and evidence | falls out of the event log, ledger and `agent_decisions` |

## Non-negotiable conventions

1. **Money is `bigint` cents.** Never `number`. Rates and amortization go
   through `Decimal` (fixed scale 30) and are rounded once, half-up, at the
   point the spec says (`round_half_up(UPB × rate / 12)`).
2. **Dates are `PlainDate` civil dates** anchored to the calendar the spec
   names. `calendar_days`, `business_days_federal`, `business_days_servicer`
   and `business_days_fannie_et` are different calendars and are never
   substituted for one another. Wall-clock cut-offs are resolved in the named
   zone (`03:00 America/New_York`).
3. **Append-only.** `loan_events`, `ledger_lines`, `agent_decisions`,
   `boarding_validations` are never updated or deleted (enforced by trigger in
   Postgres and by construction in memory). Corrections are new rows —
   reversals, new `loan_terms` versions, new validation runs.
4. **Every ledger entry set balances** or it is rejected — in memory by
   `MemoryLedger.post`, in Postgres by a deferred constraint trigger at COMMIT.
   Every line carries the `rule_ref` that justified it.
5. **Timers come from the registry.** Section code does not hard-code
   deadlines; it emits the trigger event with the payload fields the row
   anchors on, and the engine arms/satisfies/breaches. Where a row's prose
   can't be parsed, `timers.ts` in the section adds a cited override rather
   than a silent guess.
6. **Agents propose, humans approve what the spec says humans approve.**
   Money fields are never agent-corrected; waivers need an `officer`; the
   service refuses otherwise and writes nothing. Every agent action that
   changes state leaves an `agent_decisions` row with rule set, model and
   prompt versions.
7. **The AI path and the human path run the same validators.** `service.ts`
   is the only way to change state; the ops console and the agent both call
   it.

## Build order

Sections are ordered by what they unblock. Boarding and cashiering are the
two roots — everything else reads loans that boarding created and cash that
cashiering posted.

1. ✅ §1.1 boarding intake · ✅ §2.1 posting (+ §2.2 partials)
2. ✅ §2.7 late charges · §2.3 ACH autodraft · §2.4 curtailments — closes the payment loop
3. ✅ §5.1 investor events/LAR · §5.2 remittance · §6.x custodial — Fannie Mae reporting off the events 2.1 already emits
4. ✅ §3.x escrow analysis and disbursement
5. ✅ §11.x early intervention (the 11.1/11.2 windows boarding already seeds) · §7.x periodic statements/notices · §4.x servicing requests
6. ✅ §12 loss mitigation · §13 foreclosure · §14 bankruptcy
7. ✅ §16 payoff · §17 transfer-out · §1.2–1.7 the rest of boarding
8. ✅ §8 credit reporting · §9/§10 insurance & MI · §15 REO/claims · §18 QC · §19 data & security

All 114 processes now have a domain module under `src/domain/`. What is *not*
built yet, in the order it should land: (a) persistence for the domain tables
each section's "Data model" subsection names (only the baseline and boarding
schemas exist), (b) the integration adapters each section calls (e-OSCAR,
P360/SMDU/LSDU, lockbox/BAI2, print/mail, e-vault) — built in `src/infra/integrations`,
(c) the agent layer — built in `src/app` (command bus, agent registry, evaluators,
escalations) with the ops console in `src/console` (role-scoped queues, loan record,
Compliance Sentinel, AI-path toggles), (d) the end-of-build audit against
`docs/AUDIT-NOTES.md`.

## Adding a section

1. Read `spec/sections/<nn>/<process>.md` end to end, including "Open questions".
2. Migration for the "Data model" tables.
3. `types.ts`, `machine.ts`, `rules.ts`, `service.ts` under `src/domain/<name>/`.
4. Run `npm run spec:lint -- --verbose` and add `timers.ts` overrides for any of the section's rows that show as prose.
5. Port every T-numbered acceptance test. The worked arithmetic in
   "Business rules" is a test too.
6. Note the open questions you resolved and the default you took in the
   commit message.

## One product: origination and servicing

Sections 20–31 (the Origination build specification, imported by `tools/import_origination.py`) and 1–19 are one
platform with one id grammar, one registry, one audit and one kernel. The seam is a set of rules the build enforces:

- **A name means one thing everywhere.** A table, event, timer code, notice code, agent or role the servicing spec
  defines is reused by origination, never redefined. `python3 tools/spec_lint_names.py` (run by `npm test`) fails on
  a timer code re-triggered by a different event in a later section, or an agent/role/calendar the kernel lacks;
  `src/kernel/timers/registry.ts` lets the servicing side own a shared code and treats origination rows as references.
  A rule that genuinely differs gets its own code, named as the variant (`LL_2026_05_ESCROW_SETUP_ORIG_PURCHASE_BD1`).
- **One loan for life.** Before funding the aggregate is `applications` (0057). Events, timers, decisions, consents,
  documents, escalations and entity rows carry `application_id`; the unit of work is scoped to a loan, an application
  or both (`PgUnitOfWork.run({ loanId?, applicationId? })`). 30.2 creates the servicing `loans` row at funding with
  `origination_application_id`, boards it through 1.1's pipeline with `boarding_staging.source = 'origination'`, and
  from then on the same row is what §2–§19 service. Purchase (30.1) is an investor update, never a re-board;
  `fnma_loan_number` is null until then. Payoff (§16) retires the row; a refinance (§20) opens a new application
  with `prior_loan_id`.
- **Two contexts, one engine.** Timers defined by sections 20–31 arm only on events that carry origination context
  (`DomainEvent.applicationId`, an `application` aggregate, or `payload.application_id` / `source = 'origination'`);
  a transferred-in loan never picks up an origination clock. The six day units — `calendar_days`,
  `business_days_federal`, `business_days_servicer`, `business_days_fannie_et`, `business_days_creditor` (Reg Z
  §1026.2(a)(6) general) and `business_days_regz_specific` (Reg Z specific; Saturdays count) — are the only calendars.
- **One test proves it.** The lifecycle acceptance test runs one synthetic borrower from refinance trigger through
  application, funding, boarding, first statement, payment, payoff and a new refinance, against Postgres.

