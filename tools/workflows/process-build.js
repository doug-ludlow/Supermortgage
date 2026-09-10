export const meta = {
  name: 'spec-process-build',
  description: 'Build spec processes to 100% of their audit units in parallel, adversarially verify each, fix findings, re-verify',
  phases: [
    { title: 'Build', detail: 'one agent per process: timers, evaluators, ops, notices, tools, spec tests, migration' },
    { title: 'Verify', detail: 'independent adversarial reviewer recomputes expectations from the spec' },
    { title: 'Fix', detail: 'builder-class agent fixes block findings' },
    { title: 'Re-verify', detail: 'second adversarial pass' },
  ],
}
const S = args.scratch
const PROCS = args.processes

const OWN = (p) => `FILES YOU OWN (edit only these; 26 other agents are building the other processes in the same working tree right now — never edit anything outside this list):
- src/domain/${p.dir}/ops-${p.n}-${p.k}.ts (new: your pure rule functions), src/domain/${p.dir}/timers-${p.n}-${p.k}.ts (fill applySatisfiedOverrides_${p.n}_${p.k}), src/domain/${p.dir}/evaluators-${p.n}-${p.k}.ts (fill EVALUATORS_${p.n}_${p.k}), src/domain/${p.dir}/${p.n}-${p.k}.spec.test.ts (your T-ids and worked figures)
- src/app/tools/section${p.n}-${p.k}.ts (fill TOOLS_${p.n}_${p.k}), src/notices/authored/section${p.n}-${p.k}.ts (fill VERSIONS_${p.n}_${p.k} and OVERRIDES_${p.n}_${p.k})
- db/migrations/${p.mig}_<topic>.sql — ONLY if gaps.py lists missing tables for ${p.id}; new file, append-only; never edit src/infra/db/db.test.ts (report the CREATE TABLE count instead)
- scratch files only under ${S}/ prefixed p${p.n}_${p.k}_
READ-ONLY (shared with the other processes of your section): every other file under src/domain/${p.dir}/ — the existing calculators (and ops.ts / quote.ts where present), the section's timers.ts / evaluators.ts / index.ts, the combined <section>.test.ts, and the other processes' files. If an existing calculator is wrong or incomplete for your T-id, write the corrected function in your own ops-${p.n}-${p.k}.ts (import and reuse what is right) and report the defect in notes. NEVER edit src/app/evaluators.ts, src/app/evaluator-kit.ts, src/app/tools.ts, src/app/tools/index.ts, src/app/tools/section${p.n}.ts, src/notices/catalog.ts, src/notices/authored/section${p.n}.ts, src/notices/registry.ts, src/notices/checklist.ts, src/domain/timer-overrides.ts, src/kernel/**, docs/**, tools/**, spec/**, package.json. Never run git commit/push/stash/checkout/reset/clean. Never run \`npm test\` (whole suite + ratchet) and never \`python3 tools/audit.py --baseline\`.`

const BRIEF = (p) => `You are building spec process ${p.id} (${p.title}) of the Supermortgage repository at /home/user/Supermortgage (branch claude/mortgage-subservicer-builder-y9nr7e) to 100% of its spec units. ${p.notes || ''}

GOAL: the row for ${p.id} in docs/audit/COVERAGE.md (regenerate with \`python3 tools/audit.py >/dev/null\`) reads 100.0. Units are what the spec names: T-ids (tests), tables (migrations), timers (armable AND satisfiable), notices (authored templates), tools (on the bus), figures (worked-example dollar amounts asserted in your process's test file).

START HERE: run \`python3 ${S}/gaps.py ${p.n}\` and read the block for ${p.id} (it prints every missing unit: the exact T-id text, timer codes, notice codes, tool strings and figures). Read your process's spec markdown end to end: \`ls spec/sections/${p.n}-*/${p.n}-${p.k}-*.md\` (rules, worked examples, timer table, notice list, Agents paragraph, acceptance tests) — and skim the sibling process files only where your T-ids reference them. Read spec/registry/agents.json for ${p.id} (tool strings verbatim, guardrails, escalates_to), spec/registry/timers.json rows for ${p.id} (trigger/offset/satisfied), spec/registry/notices.json codes owned by ${p.id}, and the existing code under src/domain/${p.dir}/ (the calculators are already built; the combined ${p.dir}.test.ts shows fixture inputs and which T-ids are already covered — reuse those inputs).

${OWN(p)}

EXEMPLARS (mimic their shape): src/domain/foreclosure/ops.ts (one small pure function per rule/T-id), src/domain/foreclosure/timers.ts → applyForeclosureSatisfiedOverrides (satisfied-event / evaluator overrides with the spec text in \`why\`), src/domain/lossmit/12-8.spec.test.ts and src/domain/foreclosure/13-3.spec.test.ts (implemented T-id tests plus a worked-figures test), src/notices/authored/section13.ts (templates + checklists + samples), src/app/tools/section13.ts (defineTools + guardrails), and ${S}/sec13_tests.py (how test bodies replace the todo lines without touching titles; regex \`^(test\\("<tid>(?:: .*?)?"), \\{ todo: true \\}\\);$\`).

HOW EACH UNIT IS COUNTED (tools/audit.py):
- T-ids: src/domain/${p.dir}/${p.n}-${p.k}.spec.test.ts holds one \`test("${p.id}-Tj: …", { todo: true });\` per T-id. Replace \`{ todo: true }\` with \`() => { …assertions… }\`; the title must stay byte-identical (some titles are bare, e.g. \`test("12.3-T4", …)\`). A todo or retitled test is not counted.
- timers: \`npx tsx tools/lint-registry.ts --json\` rows for ${p.id} must be armable:true AND satisfiable:true. Put \`reg.override(code, { trigger?, satisfied?, offset?, anchorField?, evaluator?, why })\` calls in applySatisfiedOverrides_${p.n}_${p.k} (it runs after the section-level overrides and wins the merge). Satisfied grammar: a backticked dotted event pattern such as \`\\\`lossmit.offer.responded{response∈{accepted, rejected}}\\\`\` (no ':' inside values), or \`evaluator: "${p.id}.name"\` for gate-shaped rows. EVERY evaluator ref must exist in EVALUATORS_${p.n}_${p.k} and EVERY key of that map must be referenced by an override (src/app/app.test.ts checks both directions; \`npx tsx ${S}/evref.ts\` prints unreferenced/missing across the whole registry — only your own keys/refs are your concern).
- notices: every code owned by ${p.id} in spec/registry/notices.json needs \`V(code, source, rules, sample, ruleSet, formBasis)\` in VERSIONS_${p.n}_${p.k} (\`import { V } from "./section01.ts"\`). Template syntax: \`{{#block "id" page=1 y=0.1 pt=11 bold}}…{{/block}}\`, \`{{money x}}\`, \`{{date x}}\`, \`{{#if x}}…{{/if}}\`, \`{{#each list}}{{this}} / {{field}}{{/each}}\`. Rule kinds: presence/absence (regex over the rendered text); data_equality and conditional (predicate JSON-logic: var / present / matches / == / != / < / <= / > / >= / and / or / ! / in; conditional also takes \`when\`); data_range (uses \`range: { min, max }\` on a NUMERIC selector — a predicate on a data_range rule is ignored); layout (\`layout: { minPt, page, bold, maxYFraction }\` on a block id). Every sample payload must pass its own checklist (src/notices/notices.test.ts publishes every version). Versions are effective 2026-09-01, so tests use \`reg.activeVersion(code, D("2026-09-01"))\` or later. Channel/combination policy per code goes in OVERRIDES_${p.n}_${p.k} (e.g. \`{ channelPolicy: "mail_only", citation: "…" }\`).
- tools: every string in agents.json \`tools\` for ${p.id} must appear verbatim as \`name\` inside \`defineTools("${p.id}", "<agent>", [...])\` in your tools file — including compound names like "a.read/write" and "timer.*" (one tool whose handler switches on \`op\`); no duplicate names within the process; the agent id must exist in agents.json (AgentRegistry.allows returns false for unknown agents — if ${p.id} lists \`agent: null\`, use the agent of a neighbouring process in the same section). src/app/tools.test.ts executes every tool with an empty input {}: handlers must throw RangeError (never TypeError) on missing input (a \`need(i, ...keys)\` helper) or return a harmless read. Encode the spec's guardrail sentences ("cannot", "never", "only <role>", "must not") as \`never(code, citation, when, why)\` / \`needsRole(code, citation, when, roles, why)\`. Helpers in src/app/tools.ts: defineTools, compute, read, write, readWrite, history, log, escalate(kind), decision, emit, ledgerPost, timerOps, noticeOps("render"|"send"|"render_send"), port, service, never, needsRole, humanWhen, gate, cents, str, num, flag, data. Escalation kinds: human_portal_task | officer | attorney | signing_officer | lossmit_reviewer | fraud_officer | human_agent | sev1–4.
- figures: a spec worked-example amount counts as built when the section's test files contain it as a bigint cents literal (\`$1,528.30\` → \`152830n\` or \`152_830n\`) or the exact string "$1,528.30". Put your process's figures in a \`test("${p.id} worked figures: …", () => { … })\` appended to your spec test file, asserting the calculators reproduce the spec's arithmetic from the spec's inputs — real assertions on real outputs, never \`assert.equal(152830n, 152830n)\`.
- tables: each missing table name (from gaps.py) needs \`CREATE TABLE <name>\` (or CREATE VIEW for a projection the spec describes as a view) in db/migrations/${p.mig}_<topic>.sql — BEGIN/COMMIT, COMMENT ON TABLE, columns from the spec's data-model bullets, FKs to existing tables (grep db/migrations); follow db/migrations/0029_lossmit_dil_cases.sql. Prove it applies: \`service postgresql start; DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh\` (other agents' migrations may apply in the same run — that is fine).

CONVENTIONS (CLAUDE.md, docs/ARCHITECTURE.md): bigint cents; PlainDate strings with the calendars in src/kernel/calendar (addBusinessDays(date, n, servicer | federal | fannieEt), addDays, addMonths, addYears, daysBetween, endOfMonth, parts, ymd; zonedEpochMs(date, "HH:MM", tz)); erasable TypeScript only (no enum, no namespaces, no parameter properties); exactOptionalPropertyTypes is on (pass \`x ?? null\` into optional-or-null parameters, never \`undefined\`); node:test + node:assert/strict; append-only tables; registry-driven timers; officer-only waivers on money fields; borrower-facing text only from templates. Federal holidays that bite hand-counted business days: 2026-10-12 Columbus Day, 2026-11-11 Veterans Day, 2026-11-26 Thanksgiving, 2026-12-25, 2027-01-01, 2027-01-18, 2027-02-15.

WHEN THE SPEC'S OWN ARITHMETIC IS WRONG (typically a business-day count that ignored a holiday): assert the calendar-correct value the engine computes, add a one-line comment on the assertion, and report it in \`discrepancies\` — do not edit docs/AUDIT-NOTES.md.

VERIFY LOOP — repeat until clean; do not stop while the ${p.id} row is below 100.0. The box has 4 CPUs shared by 27 agents: run tsc only at these checkpoints (not after every edit), and run only your own test files.
1. \`npx tsc --noEmit\` — clean for your files (errors in other processes' files are transient while their agents work; ignore those and re-check later).
2. \`node --experimental-strip-types --test src/domain/${p.dir}/${p.n}-${p.k}.spec.test.ts\` — all pass, todo 0.
3. \`node --experimental-strip-types --test src/app/tools.test.ts src/app/app.test.ts src/notices/notices.test.ts\` — pass (a failure inside another process's file: wait a minute and retry; yours: fix it).
4. \`npx tsx tools/lint-registry.ts --json | python3 -c "import json,sys; r=json.load(sys.stdin); print([x for x in r if x['process']=='${p.id}' and not (x['armable'] and x['satisfiable'])])"\` → [].
5. \`npx tsx ${S}/evref.ts\` → none of YOUR keys/refs listed as unreferenced/missing.
6. \`python3 tools/audit.py >/dev/null; grep -E '^\\| ${p.id.replace('.', '\\\\.')} ' docs/audit/COVERAGE.md\` → 100.0; otherwise \`python3 ${S}/gaps.py ${p.n}\` names what is still missing — build it.

QUALITY BAR: each T-id test exercises the rule the T-id describes with inputs from the spec's Given and assertions on the spec's Then (dates, cents, statuses, refusal codes, escalation kinds), never restating constants. Notices carry the statutory content the spec names, quoting statutory phrases where the spec quotes them. Timer satisfaction names an event the described process actually emits. Report status only as audit fractions; never write "done" or "complete" — quote the COVERAGE.md row.

RETURN (StructuredOutput): row = the final COVERAGE.md row for ${p.id} verbatim; new_migration = filename or null; new_base_tables = CREATE TABLE count (0 if none); discrepancies = [{tid, spec_figure, engine_figure, why}]; files_touched; notes = anything still below 100% and exactly why, plus any defect you found in a shared calculator and worked around.`

const BUILD_SCHEMA = { type: 'object', properties: {
  row: { type: 'string' }, new_migration: { anyOf: [{ type: 'string' }, { type: 'null' }] }, new_base_tables: { type: 'integer' },
  discrepancies: { type: 'array', items: { type: 'object', properties: { tid: { type: 'string' }, spec_figure: { type: 'string' }, engine_figure: { type: 'string' }, why: { type: 'string' } }, required: ['tid', 'spec_figure', 'engine_figure', 'why'] } },
  files_touched: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
  required: ['row', 'new_migration', 'new_base_tables', 'discrepancies', 'files_touched', 'notes'] }
const VERIFY_SCHEMA = { type: 'object', properties: {
  findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['block', 'warn'] }, claim: { type: 'string' }, evidence: { type: 'string' } }, required: ['file', 'line', 'severity', 'claim', 'evidence'] } },
  row: { type: 'string' }, tests_pass: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['findings', 'row', 'tests_pass', 'summary'] }
const FIX_SCHEMA = { type: 'object', properties: {
  row: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, reason: { type: 'string' } }, required: ['claim', 'reason'] } },
  new_migration: { anyOf: [{ type: 'string' }, { type: 'null' }] }, new_base_tables: { type: 'integer' },
  discrepancies: { type: 'array', items: { type: 'object', properties: { tid: { type: 'string' }, spec_figure: { type: 'string' }, engine_figure: { type: 'string' }, why: { type: 'string' } }, required: ['tid', 'spec_figure', 'engine_figure', 'why'] } },
  notes: { type: 'string' } },
  required: ['row', 'fixed', 'rejected', 'new_migration', 'new_base_tables', 'discrepancies', 'notes'] }

const verifyPrompt = (p, row, round) => `You are an adversarial reviewer (round ${round}) of the ${p.id} (${p.title}) build in /home/user/Supermortgage, branch claude/mortgage-subservicer-builder-y9nr7e. Another agent claims this audit row:
${row}
Find what is wrong, spec-contradicting or hollow — do not praise. DO NOT edit any file or run state-changing git commands. Other agents are still editing other processes; confine yourself to this process's files: src/domain/${p.dir}/ops-${p.n}-${p.k}.ts, timers-${p.n}-${p.k}.ts, evaluators-${p.n}-${p.k}.ts, ${p.n}-${p.k}.spec.test.ts, src/app/tools/section${p.n}-${p.k}.ts, src/notices/authored/section${p.n}-${p.k}.ts, db/migrations/${p.mig}* (plus any shared calculator they call).

CHECK, with evidence:
1. \`git status --porcelain\` and \`git diff HEAD --stat -- <those paths>\`; read the new/changed files in full.
2. T-id tests: for EVERY \`test("${p.id}-Tj…"\` in the spec test file, confirm the title is byte-identical to the T-id line in spec/sections/${p.n}-*/${p.n}-${p.k}-*.md, and judge whether the body exercises the Given/When/Then — inputs drawn from the spec, expected values derived from the spec — or is hollow (constants asserted against themselves, a function's output asserted against that same output, \`assert.ok(true)\`, only the happy path when the T-id names a refusal). Independently recompute at least 8 numeric or date expectations from the spec's stated rules and the calendars (federal holidays: 2026-10-12, 2026-11-11, 2026-11-26, 2026-12-25, 2027-01-01, 2027-01-18, 2027-02-15, 2027-05-31, 2027-06-18 obs, 2027-07-05 obs, 2027-09-06, 2027-10-11, 2027-11-11, 2027-11-25, 2027-12-24 obs; the servicer and Fannie Mae ET calendars follow the federal list) and flag mismatches. An expected value that contradicts the spec without an annotating comment is a block finding; one that contradicts the spec's hand count but matches the calendar and is annotated is fine.
3. Worked figures: every \`$x\` in the spec's worked examples for ${p.id} should be a real assertion on a calculator's output; flag tautologies.
4. Timers: read the satisfied overrides in timers-${p.n}-${p.k}.ts against spec/registry/timers.json rows and the spec's timer table for ${p.id}; flag satisfaction events the described process could never emit, evaluators that trivially return open, offsets/anchors contradicting the spec row.
5. Tools: every guardrail sentence in spec/registry/agents.json for ${p.id} should be a never/needsRole guardrail in the tools file; flag omissions and handlers that would throw TypeError on {}.
6. Notices: compare each template with the spec's content requirements (statutory phrases, required elements, mail-only policy where the statute demands mail, no payment demand where the spec forbids it); flag missing required content and checklist rules that cannot fail.
7. Migration (if any): columns match the spec's data-model bullets; FKs reference existing tables; \`service postgresql start; DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh\` applies cleanly.
8. Run: \`npx tsc --noEmit\` (report only errors inside this process's files), \`node --experimental-strip-types --test src/domain/${p.dir}/${p.n}-${p.k}.spec.test.ts\`, \`node --experimental-strip-types --test src/app/tools.test.ts src/app/app.test.ts src/notices/notices.test.ts\`, and \`python3 tools/audit.py >/dev/null; grep -E '^\\| ${p.id.replace('.', '\\\\.')} ' docs/audit/COVERAGE.md\`.

RETURN (StructuredOutput): findings — each with file, line, severity ('block' = wrong / spec-contradicting / hollow / failing; 'warn' = weaker but real), claim, evidence (the quoted spec line or your recomputation). No style nits; every finding backed by evidence. row = the COVERAGE.md row you observed; tests_pass = whether step 8 passed; summary = two sentences.`

const fixPrompt = (p, findings) => `${BRIEF(p)}

THIS IS A FIX PASS. The process was built already; an adversarial reviewer reported these findings (JSON):
${JSON.stringify(findings, null, 1)}

For every 'block' finding: verify it against the spec yourself, then fix it (titles stay byte-identical; the row stays at 100.0). For 'warn' findings: fix when local and clearly right, otherwise reject with a one-line reason. If a finding is itself wrong (the reviewer misread the spec), reject it and quote the spec. Re-run the VERIFY LOOP after your changes. Return row, fixed (one line per finding fixed), rejected [{claim, reason}], new_migration / new_base_tables (cumulative for the process), discrepancies (cumulative), notes.`

const results = await pipeline(PROCS,
  (p) => agent(BRIEF(p), { label: `build:${p.id}`, phase: 'Build', schema: BUILD_SCHEMA }),
  (build, p) => build ? agent(verifyPrompt(p, build.row, 1), { label: `verify:${p.id}`, phase: 'Verify', schema: VERIFY_SCHEMA }).then((v) => ({ build, verify1: v })) : null,
  (r, p) => {
    if (!r) return null
    const f = r.verify1 ? r.verify1.findings : []
    log(`${p.id}: verify round 1 → ${f.filter((x) => x.severity === 'block').length} block, ${f.filter((x) => x.severity === 'warn').length} warn`)
    if (!f.length) return { ...r, fix: null }
    return agent(fixPrompt(p, f), { label: `fix:${p.id}`, phase: 'Fix', schema: FIX_SCHEMA }).then((fix) => ({ ...r, fix }))
  },
  (r, p) => {
    if (!r || !r.fix) return r
    return agent(verifyPrompt(p, r.fix.row || (r.build && r.build.row) || '', 2), { label: `re-verify:${p.id}`, phase: 'Re-verify', schema: VERIFY_SCHEMA }).then((v) => ({ ...r, verify2: v }))
  },
)
return results.map((r, i) => ({ process: PROCS[i].id, ...(r || { failed: true }) }))
