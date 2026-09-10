# N.M — Process title (what the process does, in the spec's words)

<!--
  HOW THIS FILE IS MEASURED — read before writing.

  Save it as spec/sections/NN-section-slug/N-M-process-slug.md (NN two digits, N.M the process id, e.g.
  spec/sections/20-application-disclosures/20-1-application-intake-and-mlo-assignment.md), then run

      npm run spec:register && npm run spec:manifest && npm run audit

  `spec:register` adds the section, the process and its timer rows to spec/registry/*.json from this file;
  `spec:manifest` counts the units; `npm run audit` measures the tree against them. The audit counts SIX
  kinds of unit, each with an exact textual form. Anything not in these forms is prose and is not counted:

    1. T-ids     `| N.M-Tk | Given …, when …, then … |` rows in the test table (or `- N.M-Tk Given …` bullets).
                 A T-id is built only when a non-todo node:test is titled exactly "N.M-Tk: <the row text>".
    2. tables    `- **`table_name`** (new | baseline | extended; append-only?): columns …` bullets under
                 "#### Data model". Backticked, at the start of a bullet. Column-like names (…_id, …_at, …_on,
                 …_cents, …_pct, …_date, …_flag), enums (`x` ∈ {…}) and retention classes are not tables.
    3. timers    rows of the "#### Timers and gates" table; the code is backticked; the offset uses the grammar
                 the engine parses: `+7 calendar_days`, `−14 calendar_days`, `+3 business_days_servicer`,
                 `+2 business_days_federal`, `BD1 business_days_fannie_et`, `next business_days_fannie_et at 03:00
                 America/New_York`, `monthly`, `0` (anchored). A row the grammar cannot parse must get a cited
                 override in the section's timers.ts, never a hard-coded deadline in service code.
    4. notices   `NTC_…` codes in backticks anywhere in the file; the first process that names a code owns it.
    5. tools     the backticked tool names in the "#### AI agent design" paragraph, after the word "tools".
                 A new agent name must be added to KNOWN in tools/extract_agents.py.
    6. figures   every bold money figure `**$1,304.93**` under "#### Business rules and calculations"; each must be
                 asserted, to the cent, by a test in the section.

  Delete these comments in the real file. Keep every heading below verbatim: the extractors key on them.
-->

| Attribute | Value |
|---|---|
| Section | NN — Section title |
| Automation class | a (fully automated) · b (agent proposes, human approves) · c (human performs, agent assists) |
| Capacity | Lender · Servicer · Sub (which hat Supermortgage wears; who is the system of record) |
| Trigger & frequency | e.g. On application; per loan · Nightly · On event |
| Governing source | the primary rule(s), e.g. Reg Z §1026.19(e); Selling Guide B3-…; state statute |
| Key deadlines | the one or two clocks a reader must know, e.g. LE within 3 business days of application |
| Timers | `CODE_ONE`, `CODE_TWO` (every code in the timers table below) |

### Blueprint row
One paragraph: the process as the product blueprint states it — purpose, inputs, outputs, who does it today.

### Verified requirement (as of YYYY-MM-DD)
**Rule name (citation, edition date)** — quote or closely paraphrase the operative text, with pin cites. One paragraph per governing rule. Mark anything not confirmed against a primary source **[UNVERIFIED]** or **[PARTIALLY VERIFIED — why]**; the build treats those as hard inputs to confirm before go-live, not as facts.

**Discrepancies vs blueprint**: (1) … (2) … — every place the blueprint row and the verified rule disagree, and which one the build follows.

### Operational prerequisites
- Licenses, approvals, memberships, vendor contracts, system IDs — who owns each, how long it takes.

### Build spec
#### Inputs and triggers
- Events that start the process (`domain.event.name{field=value}`), inbound files and adapters, schedules, and what a human may start.

#### Data model
New tables (append-only where noted; retention class; PII columns encrypted):
- **`table_name`** (new; append-only): `id uuid pk`, `loan_id` → `loans`, `field type`, … , `status` enum {…}, `created_at`.
- **`another_table`** (new): …
- Baseline tables written: `loans` (+ new columns …), `loan_events` (`domain.event.a`, `domain.event.b`), `agent_decisions`.

#### State machine
Object-level (`table.status`): `state_a` —(event or command; guard)→ `state_b`; … Terminal: `x`, `y`. Who performs each transition (agent, role); which transitions need a human.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `PREFIX_RULE_DESCRIPTOR_N` | deadline | `domain.event.started` | `event date field` | +3 business_days_servicer | `domain.event.done` | sev 2 → `officer` |
| `PREFIX_RULE_GATE` | not_before_gate | `domain.event.a` | `field` | +7 calendar_days | `domain.event.b` | hold; escalate |

Jurisdiction overrides: none | `jurisdiction_rules.<key>` drives …

#### Business rules and calculations
1. **Rule name.** The rule, with its citation, in operational terms.
2. **Calculation.** The formula, its precision and rounding ("decimal, precision 20, half-up to the cent once per component").

**Worked example A.** Real inputs → every intermediate → the result, with money in bold: $248,310.55 × 6.500% ÷ 12 = 1,345.0155 → **$1,345.02**. Every bold figure becomes an assertion.

#### Integrations
- **`adapter-name`** (direction; protocol; idempotency key; retry; what happens on outage; **[UNVERIFIED endpoint/fields]** where applicable).

#### Outputs and artifacts
- Rows written, events emitted, documents produced (with retention class), reports, notices (`NTC_…`) with their content checklist items.

#### AI agent design (AI-first)
`agent-name` agent (tools: `readThing`, `computeThing`, `proposeAction`, `applyAction`, `raiseException`, `writeDecision`). End-to-end: what the agent does unprompted, what it proposes for a human, what it never does. Decision record schema: `{…, rule_set_version, model_version, prompt_version, confidence, rationale}`. Guardrails: the money fields and legal acts the agent can never perform; who approves what. Escalations: `officer` for …, `attorney` for …, `human_agent` for ….

#### Edge cases and failure modes
- Case → required behavior, one per bullet.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| N.M-T1 | Given …, when …, then … (the worked example A figures appear here, to the cent). |
| N.M-T2 | Given …, when …, then … |
| N.M-T3 | Given a money-field change proposed by the agent, when no `officer` approval record exists, then the command is refused. |

#### Audit and evidence
What an examiner is shown: the events, the decision records, the documents and hashes, the timer history, the reports — and how each is exported.

### Open questions / decisions
1. Question? **Default: the choice the build takes until decided.**

### Sources
- Citation (edition or date; URL or document id) — one per line, primary sources first.
