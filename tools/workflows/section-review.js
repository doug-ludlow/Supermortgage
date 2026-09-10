export const meta = {
  name: 'spec-section-review',
  description: 'Adversarially review already-built spec sections against the spec, fix confirmed findings, re-verify',
  phases: [
    { title: 'Review', detail: 'independent adversarial reviewer recomputes expectations from the spec' },
    { title: 'Fix', detail: 'fixer verifies each finding against the spec and repairs it' },
    { title: 'Re-review', detail: 'second adversarial pass on the fixed section' },
  ],
}
const S = args.scratch
const SECTIONS = args.sections

const FINDINGS_SCHEMA = { type: 'object', properties: {
  findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['block', 'warn'] }, process: { type: 'string' }, claim: { type: 'string' }, evidence: { type: 'string' } }, required: ['file', 'line', 'severity', 'process', 'claim', 'evidence'] } },
  checked: { type: 'object', properties: { tids_read: { type: 'integer' }, expectations_recomputed: { type: 'integer' }, notices_read: { type: 'integer' }, tools_read: { type: 'integer' }, timers_read: { type: 'integer' } }, required: ['tids_read', 'expectations_recomputed', 'notices_read', 'tools_read', 'timers_read'] },
  tests_pass: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['findings', 'checked', 'tests_pass', 'summary'] }
const FIX_SCHEMA = { type: 'object', properties: {
  rows: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, reason: { type: 'string' } }, required: ['claim', 'reason'] } },
  discrepancies: { type: 'array', items: { type: 'object', properties: { tid: { type: 'string' }, spec_figure: { type: 'string' }, engine_figure: { type: 'string' }, why: { type: 'string' } }, required: ['tid', 'spec_figure', 'engine_figure', 'why'] } },
  shared_file_changes_needed: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
  required: ['rows', 'fixed', 'rejected', 'discrepancies', 'shared_file_changes_needed', 'notes'] }

const scope = (s) => `This section's files: ${s.dirs.map((d) => `src/domain/${d}/ (only the ${s.n}-*.spec.test.ts files, the calculators and ops/timers files of §${s.n})`).join(', ')}, src/app/tools/section${s.pad}.ts, src/notices/authored/section${s.pad}.ts, and the §${s.n} rows of src/app/evaluators.ts. The spec is spec/sections/${s.pad}-*/ (one markdown file per process ${s.n}.x); registries: spec/registry/agents.json (tools, guardrails), spec/registry/timers.json (timer rows), spec/registry/notices.json (notice codes).`

const reviewPrompt = (s, round, prior) => `You are an adversarial reviewer (round ${round}) of the already-built spec section §${s.n} (${s.title}) in /home/user/Supermortgage, branch claude/mortgage-subservicer-builder-y9nr7e. The audit already counts every unit of §${s.n} as built (docs/audit/COVERAGE.md rows for ${s.n}.x read 100.0). Your job is to find where the build is WRONG or HOLLOW against the spec — not to praise, not to re-count units. DO NOT edit any file; do not run state-changing git commands. Other agents are editing §14–§19 files right now; ignore any transient errors in those directories.
${prior ? `\nA previous round found and fixed these items (do not re-report them unless they are still wrong):\n${prior}\n` : ''}
${scope(s)}

CHECK, with evidence, process by process:
1. T-id tests (src/domain/<dir>/${s.n}-k.spec.test.ts): for EVERY implemented test, confirm the title is byte-identical to the spec's T-id line, and judge whether the body actually exercises the Given/When/Then — inputs drawn from the spec, expected values derived from the spec — or is hollow (constants asserted against themselves, a function's output asserted against that same output, \`assert.ok(true)\`, asserting only a shape/key exists where the spec states a value, testing only the happy path when the T-id names a refusal, an escalation kind, a notice code or a date). Independently recompute at least 15 numeric or date expectations across the section from the spec's stated rules and calendars (federal holidays: 2026-01-01, 01-19, 02-16, 05-25, 06-19, 07-03 obs, 09-07, 10-12, 11-11, 11-26, 12-25; 2027-01-01, 01-18, 02-15, 05-31, 06-18 obs, 07-05 obs, 09-06, 10-11, 11-11, 11-25, 12-24 obs; the servicer and Fannie Mae ET calendars follow the federal list, and docs/AUDIT-NOTES.md lists the hand-count discrepancies already accepted) and flag mismatches. An expected value that contradicts the spec without an annotating comment is a block finding.
2. Worked figures: the "worked figures" tests must assert calculator outputs from the spec's inputs, not tautologies like \`assert.equal(152830n, 152830n)\` or arithmetic on literals alone; flag any figure test that never calls a calculator.
3. Timers: the satisfied overrides in the section's timers.ts against spec/registry/timers.json and the spec's timer tables — flag satisfaction events the described process could never emit, evaluators that trivially return open, offsets/anchors/triggers contradicting the spec row.
4. Tools: every guardrail sentence in agents.json for ${s.n}.x ("cannot", "never", "only <role>", "must not") should be a never/needsRole guardrail; flag omissions, guardrails whose predicate can never fire, and handlers that mutate money fields without the officer role where the spec requires it.
5. Notices: each template against the spec's content requirements (statutory phrases, required elements, mail-only where the statute demands mail, no payment demand where forbidden, separate-document rules); flag missing required content and checklist rules that cannot fail.
6. Run: \`node --experimental-strip-types --test <the section's test files>\` and \`npx tsc --noEmit\` (report only errors inside this section's files).

RETURN (StructuredOutput): findings — each with file, line, severity ('block' = wrong / spec-contradicting / hollow / failing; 'warn' = weaker but real), process (e.g. "${s.n}.2"), claim, evidence (the quoted spec line or your recomputation). No style nits; every finding backed by evidence; prefer fewer, well-evidenced findings over many vague ones. checked = counts of what you read/recomputed; tests_pass; summary (two sentences).`

const fixPrompt = (s, findings) => `You are fixing spec section §${s.n} (${s.title}) in /home/user/Supermortgage, branch claude/mortgage-subservicer-builder-y9nr7e, after an adversarial review. Findings (JSON):
${JSON.stringify(findings, null, 1)}

${scope(s)}

OWNERSHIP: edit only this section's files listed above. Other agents are building §14–§19 concurrently — never touch their directories (src/domain/bankruptcy, reo, payoff, transfers 17-*, qc-audit, data-security), src/app/tools/section14..19*.ts, src/notices/authored/section14..19*.ts, src/app/tools/index.ts, src/notices/catalog.ts, src/domain/timer-overrides.ts, src/kernel/**, docs/**, tools/**, spec/**. src/app/evaluators.ts is shared: change a §${s.n} evaluator only with a single minimal Edit of that one line (never rewrite the file), and list every such change in shared_file_changes_needed. Never run git commit/push/stash/checkout/reset/clean; never run \`npm test\` (whole suite + ratchet) or \`python3 tools/audit.py --baseline\`.

For every 'block' finding: verify it against the spec yourself, then fix it — keep every test title byte-identical, keep every unit the audit counts (a T-id test may change body but never title or todo state; notices/tools/timers stay registered), and keep the §${s.n} rows in docs/audit/COVERAGE.md at 100.0 (\`python3 tools/audit.py >/dev/null; grep -E '^\\| ${s.n}\\.[0-9]+ ' docs/audit/COVERAGE.md\`). For 'warn' findings: fix when local and clearly right, otherwise reject with a one-line reason. If a finding is itself wrong (the reviewer misread the spec), reject it and quote the spec. When the spec's own arithmetic is wrong, keep the calendar-correct value with a one-line comment and report it in discrepancies. Conventions: bigint cents, PlainDate + calendars, erasable TypeScript, exactOptionalPropertyTypes on, node:test. Verify with \`npx tsc --noEmit\` (ignore errors in §14–§19 files), the section's test files, and \`node --experimental-strip-types --test src/app/tools.test.ts src/app/app.test.ts src/notices/notices.test.ts\`.

RETURN (StructuredOutput): rows (the §${s.n} COVERAGE.md rows), fixed (one line per finding fixed, naming file and what changed), rejected [{claim, reason}], discrepancies, shared_file_changes_needed, notes.`

const results = await pipeline(SECTIONS,
  (s) => agent(reviewPrompt(s, 1, null), { label: `review:§${s.n}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  (r1, s) => {
    if (!r1) return null
    const blocks = r1.findings.filter((f) => f.severity === 'block').length
    log(`§${s.n}: review round 1 → ${blocks} block, ${r1.findings.length - blocks} warn`)
    if (!r1.findings.length) return { review1: r1, fix: null }
    return agent(fixPrompt(s, r1.findings), { label: `fix:§${s.n}`, phase: 'Fix', schema: FIX_SCHEMA }).then((fix) => ({ review1: r1, fix }))
  },
  (r, s) => {
    if (!r || !r.fix) return r
    const prior = r.fix.fixed.map((x) => `- ${x}`).join('\n')
    return agent(reviewPrompt(s, 2, prior), { label: `re-review:§${s.n}`, phase: 'Re-review', schema: FINDINGS_SCHEMA }).then((r2) => ({ ...r, review2: r2 }))
  },
)
return results.map((r, i) => ({ section: SECTIONS[i].n, ...(r || { failed: true }) }))
