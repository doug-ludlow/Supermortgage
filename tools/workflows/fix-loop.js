export const meta = {
  name: 'spec-fix-loop',
  description: 'Fix outstanding adversarial-review findings on a spec process or section, re-verify, repeat until no blocking finding remains (max rounds)',
  phases: [{ title: 'Fix' }, { title: 'Verify' }],
}
const S = args.scratch
const ITEMS = args.items          // [{ id, kind: 'process'|'section', dir, n, k?, pad?, mig?, title, findings_file }]
const MAX = args.max_rounds || 3

const OWN = (p) => p.kind === 'process'
  ? `FILES YOU OWN: src/domain/${p.dir}/ops-${p.n}-${p.k}.ts, timers-${p.n}-${p.k}.ts, evaluators-${p.n}-${p.k}.ts, ${p.n}-${p.k}.spec.test.ts; src/app/tools/section${p.n}-${p.k}.ts; src/notices/authored/section${p.n}-${p.k}.ts; db/migrations/${p.mig}_*.sql (append-only; never edit src/infra/db/db.test.ts). Everything else under src/domain/${p.dir}/ (shared calculators, the section's timers.ts/evaluators.ts/index.ts, the combined test, other processes' files) is READ-ONLY — a wrong shared calculator gets a corrected function in your own ops file plus a note. NEVER edit src/app/evaluators.ts, src/app/evaluator-kit.ts, src/app/tools.ts, src/app/tools/index.ts, src/app/tools/section${p.n}.ts, src/notices/catalog.ts, src/notices/authored/section${p.n}.ts, src/notices/registry.ts, src/notices/checklist.ts, src/domain/timer-overrides.ts, src/kernel/**, docs/**, tools/**, spec/**, package.json.`
  : `FILES YOU OWN: the §${p.n} files only — ${p.dirs.map((d) => `src/domain/${d}/ (the ${p.n}-*.spec.test.ts files, the calculators and ops/timers files of §${p.n})`).join(', ')}, src/app/tools/section${p.pad}.ts, src/notices/authored/section${p.pad}.ts, and the §${p.n} rows of src/app/evaluators.ts (single-line Edits only, never a rewrite). NEVER touch §14–§19 directories or their section/process files, src/app/tools/index.ts, src/notices/catalog.ts, src/domain/timer-overrides.ts, src/kernel/**, docs/**, tools/**, spec/**, package.json.`

const RULES = `Other agents are editing other processes/sections in the same working tree right now: never run git commit/push/stash/checkout/reset/clean, never \`npm test\` (whole suite + ratchet), never \`python3 tools/audit.py --baseline\`. Run \`npx tsc --noEmit\` only at checkpoints and ignore errors in files you do not own. Keep every test title byte-identical, keep every audit unit registered (\`python3 tools/audit.py >/dev/null; grep\` your row(s) in docs/audit/COVERAGE.md must stay 100.0). Conventions: bigint cents; PlainDate + calendars (addBusinessDays(date, n, servicer|federal|fannieEt), addDays, addMonths, daysBetween, endOfMonth); erasable TypeScript; exactOptionalPropertyTypes on; node:test + node:assert/strict; satisfied grammar \`\\\`event.type{f=v, f∈{a, b}}\\\`\` or \`evaluator: "<id>.name"\` with every evaluator key referenced (npx tsx ${S}/evref.ts); data_range rules use range:{min,max}; tools throw RangeError on empty input; spec test files hold one node:test per T-id named exactly as the spec — a combined "T1/T2/T3" test in the section's combined test file does NOT satisfy CLAUDE.md: when a finding says a T-id lacks its own verbatim test, add the verbatim-titled test to the process's spec test file (leaving the combined test in place is fine). When the spec's own arithmetic is wrong, keep the calendar-correct value with a one-line comment and report it as a discrepancy.`

const fixPrompt = (p, round, findingsRef) => `You are fixing ${p.kind === 'process' ? 'spec process ' + p.id : 'spec section §' + p.n} (${p.title}) in /home/user/Supermortgage, branch claude/mortgage-subservicer-builder-y9nr7e — fix round ${round}. An adversarial reviewer left these findings; read them from ${findingsRef} (JSON array of {file, line, severity, claim, evidence}).

${OWN(p)}

${RULES}

For every 'block' finding: verify it against the spec (spec/sections/${p.kind === 'process' ? p.n + '-*/' + p.n + '-' + p.k + '-*.md' : (p.pad || String(p.n).padStart(2, '0')) + '-*/'}, spec/registry/{agents,timers,notices}.json) yourself, then fix it so the reviewer's evidence no longer holds. For 'warn' findings: fix when local and clearly right; otherwise reject with a one-line reason quoting the spec. If a finding is itself wrong, reject it with the spec quote. After the changes run your own test files, the bus/notice tests (\`node --experimental-strip-types --test src/app/tools.test.ts src/app/app.test.ts src/notices/notices.test.ts\`), \`npx tsx tools/lint-registry.ts --json\` for your rows, evref, and the audit grep.

RETURN (StructuredOutput): row(s) from COVERAGE.md; fixed (one line per finding, file + what changed); rejected [{claim, reason}]; discrepancies [{tid, spec_figure, engine_figure, why}]; shared_file_changes_needed (things you could not change because the file is not yours); notes.`

const verifyPrompt = (p, round, fixed) => `You are an adversarial reviewer (fix-loop round ${round}) of ${p.kind === 'process' ? 'spec process ' + p.id : 'spec section §' + p.n} (${p.title}) in /home/user/Supermortgage. A fixer just reported these changes:
${fixed.map((x) => '- ' + x).join('\n')}
DO NOT edit files; no state-changing git commands. Confine yourself to the item's files (${p.kind === 'process' ? `src/domain/${p.dir}/{ops,timers,evaluators}-${p.n}-${p.k}.ts, ${p.n}-${p.k}.spec.test.ts, src/app/tools/section${p.n}-${p.k}.ts, src/notices/authored/section${p.n}-${p.k}.ts, db/migrations/${p.mig}*` : `the §${p.n} files under ${p.dirs.map((d) => 'src/domain/' + d).join(', ')}, src/app/tools/section${p.pad}.ts, src/notices/authored/section${p.pad}.ts`}) and the shared calculators they call. Re-check each reported fix against the spec (spec/sections/, spec/registry/*.json) with independent recomputation of dates and cents (federal holidays: 2026-10-12, 2026-11-11, 2026-11-26, 2026-12-25, 2027-01-01, 2027-01-18, 2027-02-15, 2027-05-31, 2027-06-18 obs, 2027-07-05 obs, 2027-09-06, 2027-10-11, 2027-11-11, 2027-11-25, 2027-12-24 obs), then look for anything still wrong or hollow: test titles byte-identical to the spec T-id lines and one verbatim test per T-id in the spec test file; test bodies exercising Given/When/Then with spec-derived expectations (no constants asserted against themselves, no function output asserted against itself, refusals/escalations/notice codes asserted where the T-id names them); timer satisfaction events the described process actually emits and evaluators that can fail; every agents.json guardrail sentence as a never/needsRole guardrail; templates carrying the spec's statutory content with checklist rules that can fail; migrations matching the data-model bullets. Run the item's test files, \`npx tsc --noEmit\` (report only errors in the item's files), and \`python3 tools/audit.py >/dev/null; grep\` its row(s).
RETURN (StructuredOutput): findings [{file, line, severity 'block'|'warn', claim, evidence}] — evidence-backed only, no style nits; tests_pass; row; summary.`

const FIX_SCHEMA = { type: 'object', properties: { row: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, reason: { type: 'string' } }, required: ['claim', 'reason'] } }, discrepancies: { type: 'array', items: { type: 'object', properties: { tid: { type: 'string' }, spec_figure: { type: 'string' }, engine_figure: { type: 'string' }, why: { type: 'string' } }, required: ['tid', 'spec_figure', 'engine_figure', 'why'] } }, shared_file_changes_needed: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['row', 'fixed', 'rejected', 'discrepancies', 'shared_file_changes_needed', 'notes'] }
const VERIFY_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['block', 'warn'] }, claim: { type: 'string' }, evidence: { type: 'string' } }, required: ['file', 'line', 'severity', 'claim', 'evidence'] } }, tests_pass: { type: 'boolean' }, row: { type: 'string' }, summary: { type: 'string' } }, required: ['findings', 'tests_pass', 'row', 'summary'] }

const results = await pipeline(ITEMS, async (p) => {
  let findingsRef = p.findings_file
  const rounds = []
  for (let round = 1; round <= MAX; round++) {
    const fix = await agent(fixPrompt(p, round, findingsRef), { label: `fix${round}:${p.id}`, phase: 'Fix', schema: FIX_SCHEMA })
    if (!fix) { rounds.push({ round, failed: 'fix' }); break }
    const verify = await agent(verifyPrompt(p, round, fix.fixed), { label: `verify${round}:${p.id}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    rounds.push({ round, fix, verify })
    if (!verify) break
    const blocks = verify.findings.filter((f) => f.severity === 'block')
    log(`${p.id}: fix round ${round} → ${blocks.length} block, ${verify.findings.length - blocks.length} warn remain`)
    if (!blocks.length) break
    findingsRef = `this JSON (inline): ${JSON.stringify(verify.findings)}`
  }
  return { id: p.id, rounds }
})
return results
