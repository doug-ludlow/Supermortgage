# 34.4 — Evidence and controls: clocks, escalations, the outbox, AI systems, the evidence pack

| Attribute | Value |
|---|---|
| Section | 34 — The operator portal: staff sign-in, the account directory, partner book operations and evidence |
| Automation class | c — a staff member reads, completes, requeues, trips or exports; the platform records |
| Capacity | Platform operator |
| Trigger & frequency | On demand by a signed-in staff member; the evidence pack on request and for the examiner's periodic review |
| Governing source | 18.1 (AI governance: systems, versions, evaluations, the kill switch, the human override), 18.2 (audit and evidence), 19.1 (records and retention), 31.x (AI governance and fair lending on the origination side); the sections' own timers (breach actions and escalation roles) |
| Key deadlines | Escalations carry the owning timer's severity and due date; the evidence pack for a request within 5 business days (18.2) |
| Timers | none of its own |

### Blueprint row
The console today lists the queue, escalations and the outbox for a header-asserted actor and can complete an escalation or requeue a message. Examiners and the compliance officer need more: every clock due or breached across the platform with its owner, every escalation with who completed it and why, the outbox with retries, the AI systems in use with their versions and evaluations and a kill switch that a named person trips and resets, and an evidence pack that assembles the records for a loan, an application, a person or a period. This process is that control room, with every action attributable (34.1).

### Verified requirement (as of 2026-09-14)
**Human override and the kill switch (18.1).** Each AI system (`ai_systems`, `ai_system_versions`, `ai_evaluations`) can be bypassed by a named person; the bypass and its reset are events with the actor and a reason, and while tripped every turn of that system returns the placeholder (32.16 T-17-10). The portal is where that person acts; the role is `compliance` with `admin`.

**Evidence on request (18.2; 19.1).** The pack for a subject assembles the events, decisions, notices with rendered text and checklists, timers and their histories, the ledger sets where a loan has them, the agent turns (model and prompt versions, guard results), and the staff actions on that subject — each as the stored row, with a manifest and a hash; produced by `compliance`, retained with the records.

**Discrepancies vs blueprint**: (1) Completing an escalation or requeueing a message is the same command the console dispatches today, now with the session's actor. (2) The pack reuses 18.2's evidence export where it exists (`src/domain/qc-audit`) and adds the borrower-surface and partner-book rows that came after it.

### Operational prerequisites
- 34.1 (roles: `ops_analyst` completes escalations and requeues; `compliance` trips/resets the kill switch with `admin`, produces packs).

### Build spec
#### Inputs and triggers
- `GET /ops/api/controls/timers?status=&code=&subject=&due_before=` (armed, due, breached; with owner role and the breach action) → `controls.timers`.
- `GET /ops/api/controls/escalations?status=&role=` and `POST /ops/api/controls/escalations/{id}/complete` `{disposition, reason}` → `controls.escalation.complete`.
- `GET /ops/api/controls/outbox?adapter=&status=` and `POST /ops/api/controls/outbox/{id}/requeue` → `controls.outbox.requeue`.
- `GET /ops/api/controls/ai` (systems, versions, latest evaluations, kill-switch state), `POST /ops/api/controls/ai/{code}/kill` `{reason}` and `POST …/reset` `{reason}` (compliance + admin) → `controls.ai.kill`.
- `POST /ops/api/controls/evidence` `{subject: {loan_id | application_id | party_id | period: {from, to}}, sections?}` → `controls.evidence.pack`; `GET /ops/api/controls/evidence/{id}`.
- Events: `escalation.completed{escalation_id, disposition, by}` (the owning section's own event where it has one), `outbox.requeued{message_id, by}`, `ai.kill_switch.tripped{code, by, reason}` / `ai.kill_switch.reset{code, by, reason}` (18.1's events), `evidence.pack.produced{pack_id, subject, sha256, by}`.

#### Data model
- **`evidence_packs`** (new; append-only): `id uuid pk`, `subject_kind text` ∈ {loan, application, party, period}, `subject_id text`, `from_date date`, `to_date date`, `sections text[]`, `manifest jsonb` (each included row set with counts and hashes), `document_id uuid`, `sha256 text`, `produced_by uuid`, `created_at`.
- Baseline tables read/written: `timers`, `escalations` (completion), `integration_messages` (requeue), `ai_systems`, `ai_system_versions`, `ai_evaluations`, `ai_kill_switches` (18.1's), `loan_events`, `agent_decisions`, `notices`, `notice_checklist_results`, `ledger_entry_sets`, `agent_turns`, `staff_actions`, `documents`.

#### State machine
Per pack: `requested → produced` (or `failed` with the reason). Per kill switch (18.1's): `armed —(trip)→ tripped —(reset)→ armed`. Escalations and outbox rows keep their sections' states.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|

Jurisdiction overrides: none.

#### Business rules and calculations
1. **Clocks are shown, never edited.** The timers view lists every armed, due and breached clock with its code, subject, due date, the registry's severity and breach role, and the events that armed and will satisfy it; a person cannot satisfy, extend or cancel a clock here — only the owning process's events do (the registry rule).
2. **An escalation is completed by a named person with a disposition.** `controls.escalation.complete` requires a disposition from the escalation's own set and a reason, runs the owning section's completion command with the staff actor, and refuses an escalation whose role the caller lacks (`ROLE_REQUIRED`).
3. **Requeue is bounded.** An outbox message may be requeued at most three times by hand; each requeue is logged with the actor; a fourth attempt opens an `ops_analyst` escalation instead.
4. **The kill switch is two people's decision.** Tripping or resetting a system needs a `compliance` session and an `admin` confirmation within 10 minutes (a second request from an admin session naming the same request id); the events carry both actors and the reason; while tripped, the AI view shows it and the placeholder copy returns on every turn of that system.
5. **The evidence pack.** For the subject and period: events, decisions, notices (rendered text, checklist results, deliveries), timers with histories, escalations, ledger sets (loan subjects), agent turns (model and prompt versions, guard results, tool names), consents, verifications and credit-report metadata (application subjects; never report contents beyond what 22.2 stores as fields), the partner-book rows (monitored loans), and the staff actions on the subject; a manifest with counts and a hash per row set; one document with a hash; produced within the request; `compliance` only; logged. The portal's Evidence view is shown only to `compliance` — the route refuses every other role, and the navigation never shows a link to a refusal (34.5); controls reads stay open to all four roles.
6. **Nothing here changes a money field.** The tools dispatch the sections' own commands or write their own rows; a waiver remains the owning section's officer command.

No money figure is computed here.

#### Integrations
- None new. The document store for packs.

#### Outputs and artifacts
- Rows: `evidence_packs`, `documents`, `staff_actions`; the sections' own rows for completions and requeues; 18.1's kill-switch rows.
- Events: `escalation.completed`, `outbox.requeued`, `ai.kill_switch.tripped`, `ai.kill_switch.reset`, `evidence.pack.produced`.
- The portal's controls: clocks, escalations, the outbox, AI systems, evidence.

#### AI agent design (AI-first)
`compliance-sentinel` agent (tools: `controls.timers`, `controls.escalation.complete`, `controls.outbox.requeue`, `controls.ai.kill`, `controls.evidence.pack`). End-to-end: the read tool projects the clocks; the two action tools dispatch the owning commands with the staff actor and log; `controls.ai.kill` runs 18.1's trip/reset under the two-person rule; `controls.evidence.pack` assembles and hashes the pack. Decision record schema `{subject, action, disposition | reason, by, confirmed_by?, rule_set_version: controls.v1, model_version: deterministic, prompt_version: 34.4-v1, confidence: 1}`. Guardrails: `NO_CLOCK_EDIT`, `ROLE_REQUIRED`, `TWO_PERSON_KILL`, `REQUEUE_CAP_3`, `NO_MONEY_FIELD`, `PACK_IS_STORED_ROWS` (nothing computed or summarized by a model in a pack). Escalations: `ops_analyst` on the fourth requeue; `compliance` when a kill switch stays tripped more than 24 hours.

#### Edge cases and failure modes
- An escalation whose owning section has no completion command → completed on the escalation row with the disposition and reason, logged; the section's rows are untouched.
- A pack for a period with more than 100,000 events → produced in parts with one manifest; the request answers the part count.
- The admin confirmation for a kill switch does not arrive in 10 minutes → the request expires; nothing trips; logged.
- A requeue of a message whose adapter is FAKE → succeeds and delivers on the next sweep, like any other.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 34.4-T1 | Given breached and armed clocks on the fixture book (the invitation reminders, the review clock), when an `ops_analyst` opens the clocks view, then each lists its code, subject, due date, severity and breach role, and no route exists that changes a timer row (contract test: every `/ops/api/controls/timers*` route is `GET`). |
| 34.4-T2 | Given an open `ops_analyst` escalation, when the analyst completes it with a disposition and a reason, then the owning section's completion ran with `actor = {human, <staff_user_id>, ops_analyst}`, `escalation.completed` is logged and the decision record carries the reason; given a `compliance` escalation and an `ops_analyst` session, then `ROLE_REQUIRED{compliance}`. |
| 34.4-T3 | Given a failed outbox message, when it is requeued three times by hand, then each requeue is logged with the actor and the message is `queued`; the fourth attempt is refused `REQUEUE_CAP_3` and an `ops_analyst` escalation exists. |
| 34.4-T4 | Given `compliance` requests the kill switch for `intake` with a reason, then nothing trips until an `admin` confirms the same request id within 10 minutes; once confirmed `ai.kill_switch.tripped{by, confirmed_by, reason}` is logged, the AI view shows it tripped, a borrower turn returns the placeholder (32.16 T-17-10), and the reset needs the same two people; an unconfirmed request expires at 10 minutes with nothing tripped. |
| 34.4-T5 | Given `compliance` requests the evidence pack for loan 1 of the fixture, then one document exists with a hash, `evidence_packs.manifest` lists events, decisions, notices with rendered text and checklists, timers with histories, the partner-book facts, reviews and readiness, agent turns with model and prompt versions, consents and the staff actions on the loan, each with a count and a hash, and no row of another loan or person is in it. |
| 34.4-T6 | Given any controls response, then no money field was written by the portal (the ledger and money columns before and after every controls route are identical in a contract test), and every action route recorded a `staff_actions` row and a decision record naming the person. |

#### Audit and evidence
What an examiner is shown: the packs themselves with manifests and hashes; the kill-switch history with both actors; every escalation completion and requeue with the person and reason; the clocks as the registry sees them. The pack is the evidence.

### Open questions / decisions
1. Should the pack include rendered documents (LE, CD, notes) or only their hashes and ids? **Default: the notices' rendered text and every document's id and hash; the documents themselves attach when the request says so.**
2. Should a kill switch trip need two people in the demo? **Default: yes everywhere; the FAKE admin does not exist — two staff sessions are used in tests.**

### Sources
- spec/sections/18-*/18-1, 18-2; 19-1; 31-*; src/domain/qc-audit (the evidence export reused); src/console/server.ts (queue, escalations, outbox today); 32.16 T-17-10 (the kill switch on a turn).
