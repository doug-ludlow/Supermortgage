# Section 35 — Operations runtime

## Overview

Section 35 takes a measured-complete spec — every T-id, table, timer, notice, tool and worked figure of sections 1–34 counted as built — from a single-process demonstration to a platform that runs real loans end to end on the hosted runtime, vendors aside. Nothing in it adds a borrower-facing rule; it makes the rules already specified survive a process restart, a second machine, a month of calendar days and a person who is not the developer. The twelve processes are the seams the gap assessment found between the tree at HEAD and an operating servicer: state that lives in process memory instead of Postgres (35.1), documents that exist only as in-memory bytes (35.2), cycles that run only when a demo step calls them (35.3), a month-end and year-end that nothing closes (35.4), an installment schedule and a whole-book daily cashiering sweep that exist only for the origination fixture (35.5), a closing-to-delivery chain that is stitched by hand (35.6), kernel roles held by no person and credentials asserted in a header (35.7), the per-loan work the console lacks (35.8), default cases that do not move with the calendar (35.9), a refinance that ends in a status flip instead of a payoff (35.10), an ops steward and an audit that measures the hosted runtime instead of the local tree (35.11), and a production environment that is not the nonprod one (35.12). Every vendor stays an in-repo `FAKE` (32.x rule), switched per vendor by `INTEGRATIONS` (35.12); the section's agents are the existing owners — `security-records`, `ops-steward`, `custodial-recon`, `cashiering`, `disclosures`, `case`, `foreclosure-ops`, `payoff-release`, `qc-audit`, `compliance-sentinel` — acting through bus tools with a person behind every approval the spec names.

Capacity: Supermortgage as platform operator, lender and servicer/subservicer at once; the section projects and orchestrates sections 1–34, owns no notice code (`NTC_…` stays with 7.x and the owning processes) and no borrower-facing rule. Consumers: every process whose commands now run on a persisted record, on a cycle with a receipt, under a human role a person holds.

Dependencies: 34.1 (staff accounts, roles and the action log — 35.7 and 35.8 build on the real actor), 34.4 (clocks, escalations, the outbox and the evidence pack — 35.1 dispatches what 34.4 shows), 19.x (records, security, retention — 35.2's integrity and holds, 35.12's data classes), 18.1 (AI systems and the kill switch — 35.11's steward runs under them), 2.x/3.x/5.x/6.x/7.x (the cycles 35.3 plans and 35.5 runs whole-book), 16.x/23.x/24.4/3.5 (the refinance close 35.10 runs as their owning agents), 21–30 (the orchestration 35.6 drives from clear-to-close through delivery), 11–15 (the case engine 35.9 folds), 33.x (the partner book the daily cycles and the handover board serve). The gap assessment (tasks/w11c426h6) and the §35 plan page (gate-logs/s35/plan35.html, written at d1238cc) ground each process; migrations run to 0137 and db.test counts 776 base tables at HEAD, so every new table here numbers from 0138.

Changes in flight that shape the build: the DU work (23.5–23.7) has landed and 35.6 orchestrates it rather than re-specifying it; §34 is done, so the staff actor, the action log and the controls screens are given, not built; the hosted runtime's audit column (35.11) is the first measurement that does not read the local tree, and the ratchet applies to it once it exists.

## Processes

| Process | Title | Automation class |
|---|---|---|
| 35.1 | Persistence seam and the typed record | a |
| 35.2 | Documents and artifacts: the object store, the PDF writer, stored-byte integrity, legal holds, e-sign envelopes, the borrower viewer and print/mail manifests | a |
| 35.3 | Cycles, jobs and receipts: the planner, the jobs table, `cycles.run_unit` on the bus and the registry of every scheduled cycle | a |
| 35.4 | Month-end and year-end close: close periods, the dependency-ordered chain, the balance attestation, reopen, and the tax-year close that drives 1098 and 1099 | b |
| 35.5 | The installment schedule and the daily cashiering cycle: `loan_installments`, the whole-book sweep, lockbox, ACH and NACHA returns as cycles, per-loan servicing configuration | a |
| 35.6 | Closing, funding and delivery orchestration: clear-to-close through the CD, consummation, funding, delivery, purchase-advice reconciliation and the warehouse paydown | b |
| 35.7 | Operating roles, identity and the FAKE handover: a person for every kernel role, credentials on `/v1`, reviewer-role disjointness, the role queues and the handover board | c |
| 35.8 | Operator work screens: the per-loan and per-application work the console lacks, each screen a bus tool with server-derived inputs, the queue and the action log | c |
| 35.9 | Default operations over time: cases progressed by the cycles and the screens — referral, milestones, docket reactions, executed breach actions, claims filed | b |
| 35.10 | The refinance close of the loop: the prior loan's payoff, settlement and ledger zeroing, lien release, escrow disposition and retirement, the partner notified and the new loan linked | a |
| 35.11 | Operations stewardship and hosted measurement: the ops steward over cycles, exceptions and the outbox, the daily ops report, and the audit's hosted and persisted columns | a |
| 35.12 | Production posture: a production environment apart from nonprod, a person behind every credential, `INTEGRATIONS` per vendor, backups and the restore drill, the go-live checklist and the parallel run | c |

## Gap assessment rows and their owners

Each of the 22 rows of the gap assessment (tasks/w11c426h6.output, `.result.gaps`, in its order) is closed by exactly one process; a second process that touches the same area is a contributor, never an owner, and cites the owner rather than the gap.

| # | Gap (severity) | Owner | Contributor |
|---|---|---|---|
| 1 | Closing → funding → delivery → purchase orchestration (blocking) | 35.6 | 35.8 (the Closing board acts through 35.6's tools) |
| 2 | Fund hand-off boards from a demo fixture (blocking) | 35.6 | — |
| 3 | Process-local state in stateful origination services (blocking) | 35.1 | — |
| 4 | Amortization / installment schedule (blocking) | 35.5 | 35.9 (the delinquency counter selects on `loan_installments`) |
| 5 | Cashiering sweep scope excludes the subserviced book (blocking) | 35.5 | — |
| 6 | Batch / cycle architecture — statements, 1098, escrow analysis, investor reporting, custodial reconciliation, Metro 2, ARM/MI, month-end (blocking) | 35.3 | 35.4 (the close chain and the attestation are the month-end half; 35.3 owns the planner, the registry and every daily cycle) |
| 7 | Payment intake and money movement — lockbox, ACH/autodraft, NACHA returns (blocking) | 35.5 | — |
| 8 | People and roles — the spec's humans cannot sign in (blocking) | 35.7 | — |
| 9 | Documents, PDF, e-sign and RON artifact layer (blocking) | 35.2 | — |
| 10 | Refinance payoff of the prior loan (blocking) | 35.10 | — |
| 11 | Operator surface — no per-loan servicing/origination work screens (blocking) | 35.8 | — |
| 12 | Persistence seam — JSONB `entity_records` vs typed tables, unbounded hydration (major) | 35.1 | — |
| 13 | Investor delivery, purchase and post-purchase on the runtime (major) | 35.6 | — |
| 14 | Default / loss-mit / foreclosure / bankruptcy / REO as operated work (major) | 35.9 | — |
| 15 | Hosted 501s: 1.1 boarding tools, 30.2 hand-off tools, 21.5 tolerance engine (major) | 35.1 | — |
| 16 | Integration outbox never dispatched (major) | 35.1 | 35.11 (the steward watches the dead letters) |
| 17 | Concurrency, idempotency and scale of the sweep and command bus (major) | 35.1 | 35.3 (the paged breach pass and the planner lock only) |
| 18 | API authorization for people and partners on /v1 (major) | 35.7 | — |
| 19 | Production posture / real borrower data (major) | 35.12 | — |
| 20 | Hosted measurement and the missing §35 plan (major) | 35.11 | — |
| 21 | Purchase-journey residue (minor) | 35.6 | — |
| 22 | Real-loan configuration — jurisdiction, servicer identity (minor) | 35.5 | — |

## Closing

Build order, from the files' own prerequisites: 35.1 (the seam) → 35.3 (the planner and the registry, on the seam) → 35.2, 35.5 and 35.7 in parallel (documents need only the seam and a cycle; the installment schedule and the daily cashiering cycle need 35.3's registry and 35.2's `documents.store`; roles need the seam) → 35.4 and 35.8 in parallel (the close needs 35.7's `reviewer_roles` and 35.2's stored statement bytes; the work screens need 35.1, 35.2 and 35.5) → 35.6 and 35.9 in parallel (orchestration needs 35.2, 35.7 and 35.8's queue; the case engine needs 35.8's screens) → 35.10 (the refinance close needs 35.6, 35.7 and 35.8) → 35.11 and 35.12 last (the steward measures what the others run; production posture is attested over a platform that already runs). The one loop in the prerequisites — 35.6 lists 35.8's board, 35.8 lists 35.6's orchestration — is broken by sequencing, not by a cut: 35.6's `orchestration.board` and `orchestration.release` tools land before 35.8's `funding_release` screen, so 35.8 depends on 35.6 and not the reverse; 35.8 ships the queue and its other screens on the seam alone in its wave and adds `funding_release` once 35.6 exists. Shared fixtures: the synthetic book (one funded origination from the 23.x/26.x fixtures, one transfer-boarded servicing loan, one partner-book loan), a synthetic borrower and one holder per kernel role in `staff_users`. Every database-backed T-id skips without Postgres locally and runs under `REQUIRE_DB=1` in CI (35.11). Section-level acceptance: the hosted runtime restarts between a command and its next sweep and loses nothing; a calendar month passes on the synthetic book with every daily cycle receipted, the month closed and attested, a lockbox file posted, an ACH file built and a return actioned; one application runs from clear-to-close to delivery and purchase-advice reconciliation without a hand-written step; one refinance retires its prior loan through a real payoff; one default case moves through referral and a milestone from the calendar alone; a person holds every role the run needed and every action of theirs is on the action log; and `npm run audit` reports the section's hosted column from the probe, not from the tree.
