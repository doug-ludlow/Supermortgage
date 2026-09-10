export const meta = {
  name: 'spec-strict-close',
  description: 'Close a spec process to 100% of the strict audit (verbatim T-id tests, really-emitted timer events), adversarially verify, fix, re-verify',
  phases: [{ title: 'Close' }, { title: 'Verify' }, { title: 'Fix' }],
}
const S = args.scratch
const ITEMS = args.items          // [{ id, dir, n, k, mig, title, legacy, findings_file? }]
const MAX = args.max_rounds || 3
const pad = (n) => String(n).padStart(2, '0')

const OWN = (p) => `FILES YOU OWN: src/domain/${p.dir}/ops-${p.n}-${p.k}.ts (create if missing), timers-${p.n}-${p.k}.ts, evaluators-${p.n}-${p.k}.ts, ${p.n}-${p.k}.spec.test.ts; src/app/tools/section${p.n}-${p.k}.ts; src/notices/authored/section${p.n}-${p.k}.ts; db/migrations/${p.mig}_*.sql (append-only; never edit src/infra/db/db.test.ts).` + (p.legacy
  ? ` SHARED §${p.n} FILES you may touch with SMALL TARGETED Edits only (re-read the file right before each Edit, never rewrite a file, never touch another process's blocks — another agent may be editing the same file for a sibling process): the §${p.n} calculators/service/ops files under src/domain/${p.dir}/, src/domain/${p.dir}/timers.ts, src/app/tools/section${pad(p.n)}.ts, src/notices/authored/section${pad(p.n)}.ts, and the "${p.id}." rows of src/app/evaluators.ts (single-line Edits). Prefer putting new code in your own process files (ops-${p.n}-${p.k}.ts, section${p.n}-${p.k}.ts, timers-${p.n}-${p.k}.ts — they are wired: process overrides run after the section's and win; EVALUATORS_${p.n}_${p.k} is spread last; TOOLS_${p.n}_${p.k} and VERSIONS_${p.n}_${p.k} are on the bus/catalog).`
  : ` Everything else under src/domain/${p.dir}/ (shared calculators, the section's timers.ts/evaluators.ts/index.ts, the combined test, other processes' files) is READ-ONLY — a wrong shared calculator gets a corrected function in your own ops file plus a note.`) +
  ` NEVER edit src/app/evaluator-kit.ts, src/app/tools.ts, src/app/tools/index.ts, src/notices/catalog.ts, src/notices/registry.ts, src/notices/checklist.ts, src/domain/timer-overrides.ts, src/kernel/**, src/infra/**, docs/**, tools/**, spec/**, package.json.`

const RULES = `Other agents are editing other processes in the same working tree right now: never run git commit/push/stash/checkout/reset/clean, never \`npm test\` (whole suite + ratchet), never \`python3 tools/audit.py --baseline\`. Run \`npx tsc --noEmit\` only at checkpoints and ignore errors in files you do not own. Conventions: bigint cents; PlainDate + calendars (addBusinessDays(date, n, servicer|federal|fannieEt), addDays, addMonths, daysBetween, endOfMonth); erasable TypeScript; exactOptionalPropertyTypes on; node:test + node:assert/strict; satisfied/trigger grammar \`\\\`event.type{f=v, f∈{a, b}}\\\`\` or \`evaluator: "<id>.name"\` with every evaluator key referenced (npx tsx ${S}/evref.ts); data_range rules use range:{min,max}; tools throw RangeError on empty input; tool names must be in spec/registry/agents.json for the process (src/app/tools.test.ts refuses the rest). Federal holidays: 2026-10-12, 2026-11-11, 2026-11-26, 2026-12-25, 2027-01-01, 2027-01-18, 2027-02-15, 2027-05-31, 2027-06-18 obs, 2027-07-05 obs, 2027-09-06, 2027-10-11, 2027-11-11, 2027-11-25, 2027-12-24 obs. When the spec's own arithmetic is wrong, keep the calendar-correct value with a one-line comment and report it as a discrepancy.`

const MEASURE = (p) => `THE MEASURE is \`python3 tools/audit.py --strict\` (prints per-process gaps; \`--strict --json\` for detail) — your row "${p.id}" must reach 100% of its units. Strict units: (a) a T-id counts only when a non-todo node:test in ${p.n}-${p.k}.spec.test.ts is titled EXACTLY "${p.id}-T<n>: <spec text>" (the text from spec/registry/manifest.json; replace the \`todo: true\` line, never retitle; a combined "T1/T2" test elsewhere does not count and a comment does not count); (b) a timer counts only when it is armable+satisfiable AND \`node --experimental-strip-types tools/lint-emission.ts ${p.id}\` shows an emitter for its satisfied event (with every conditioned field) and for its trigger event (with every conditioned field) in non-test source outside the timer override files. A mention is only the lint's proxy: the event must be appended to the event store by a real code path (a tool handler in your tools file, an ops function the tools/service call, or an ingestion handler for an inbound integration event that validates the inbound record and appends the event with the conditioned fields) — never satisfy the lint with a bare string literal or a dead function. Where the registry's pattern spells an event or field the platform genuinely spells differently (e.g. notice.sent carries \`template\`, not \`code\`), override the pattern in timers-${p.n}-${p.k}.ts citing the spec, so that the pattern matches what is actually emitted (src/kernel/events/match.ts: conditions are exact string compares on payload fields).`

const closePrompt = (p) => `You are closing spec process ${p.id} (${p.title}) in /home/user/Supermortgage, branch claude/mortgage-subservicer-builder-y9nr7e, to 100% of the STRICT audit. Read spec/sections/${p.n}-*/${p.n}-${p.k}-*.md end to end and the registry rows for ${p.id} (spec/registry/timers.json, agents.json, notices.json) first.

${MEASURE(p)}

${OWN(p)}

${RULES}

DO, in order:
1. Run \`python3 tools/audit.py --strict\` and \`node --experimental-strip-types tools/lint-emission.ts ${p.id}\` and list every missing T-id and every timer with a missing emitter.
2. For each missing T-id: write the verbatim-titled test so that it exercises the Given/When/Then through this process's functions/tools with spec-derived expectations (dates recomputed on the right calendar, cents as bigint, refusals/escalations/notice codes/timer codes asserted where the T-id names them). Where the T-id names a timer, arm and satisfy it through the TimerEngine (src/kernel/timers/engine.ts) with the events your code emits. No assertion of a constant against itself, no function output asserted against itself.
3. For each timer with a missing emitter: make the process emit it for real (see THE MEASURE), and add or extend a test that proves the timer arms on the trigger and is satisfied by the emitted event (eventMatches from src/kernel/events/match.ts, or the TimerEngine).
${p.findings_file ? `4. An adversarial reviewer also left findings in ${p.findings_file} (JSON array of {file, line, severity, claim, evidence}); fix every 'block' finding that concerns ${p.id} (verify each against the spec first; reject with a spec quote if a finding is wrong) and the 'warn' ones that are local and clearly right.\n` : ''}Then run your test files, the bus/notice tests (\`node --experimental-strip-types --test src/app/tools.test.ts src/app/app.test.ts src/notices/notices.test.ts src/kernel/timers/timers.test.ts\`), \`npx tsc --noEmit\` (own files), evref, and \`python3 tools/audit.py --strict\` until your row is 100%.

RETURN (StructuredOutput): row_strict (your process line from \`python3 tools/audit.py --strict\`, or "100%" if it no longer prints); tests_added [titles]; emitters [{timer, event, code_path}]; overrides_changed [{timer, what, why}]; fixed [findings addressed]; rejected [{claim, reason}]; discrepancies [{tid, spec_figure, engine_figure, why}]; shared_file_changes_needed; notes.`

const verifyPrompt = (p, round, report) => `You are an adversarial reviewer (round ${round}) of spec process ${p.id} (${p.title}) in /home/user/Supermortgage. A builder just reported:
${report}
DO NOT edit files; no state-changing git commands. Files in scope: src/domain/${p.dir}/{ops,timers,evaluators}-${p.n}-${p.k}.ts, ${p.n}-${p.k}.spec.test.ts, src/app/tools/section${p.n}-${p.k}.ts, src/notices/authored/section${p.n}-${p.k}.ts${p.legacy ? `, and the §${p.n} shared files the builder touched (src/domain/${p.dir}/*, src/app/tools/section${pad(p.n)}.ts, src/notices/authored/section${pad(p.n)}.ts, the "${p.id}." rows of src/app/evaluators.ts)` : ''} plus the shared calculators they call. Check, with independent recomputation of dates and cents against spec/sections/${p.n}-*/${p.n}-${p.k}-*.md and spec/registry/*.json (federal holidays: 2026-10-12, 2026-11-11, 2026-11-26, 2026-12-25, 2027-01-01, 2027-01-18, 2027-02-15, 2027-05-31, 2027-06-18 obs, 2027-07-05 obs, 2027-09-06, 2027-10-11, 2027-11-11, 2027-11-25, 2027-12-24 obs):
- \`python3 tools/audit.py --strict\` shows ${p.id} at 100% (or absent from the gap list) and \`node --experimental-strip-types tools/lint-emission.ts ${p.id}\` prints no row;
- every ${p.id} T-id has a non-todo test titled byte-identically "${p.id}-T<n>: <manifest text>" whose body exercises the Given/When/Then with spec-derived expectations (no constant asserted against itself, no output asserted against itself, refusals/escalations/notice codes/timer codes asserted where named);
- every timer's satisfied and trigger events are appended by a real code path with the conditioned fields and values (read the emitter: does the payload carry the field with a value the pattern's exact-compare accepts? is the code path reachable from a tool/service/ingestion handler, and exercised by a test?) — a string literal in a dead helper is a block finding;
- overrides in timers-${p.n}-${p.k}.ts cite the spec and do not weaken a row (an override that drops a spec condition to make the pattern match is a block finding);
- shared-file edits (if any) touch only ${p.id}'s blocks and break nothing (run the section's test files).
Run the item's test files, the bus/notice tests, \`npx tsc --noEmit\` (report only errors in files in scope).
RETURN (StructuredOutput): findings [{file, line, severity 'block'|'warn', claim, evidence}] — evidence-backed only, no style nits; tests_pass; row_strict; summary.`

const fixPrompt = (p, round, findings) => `You are fixing spec process ${p.id} (${p.title}) in /home/user/Supermortgage — strict-close fix round ${round}. An adversarial reviewer left these findings (JSON): ${JSON.stringify(findings)}

${MEASURE(p)}

${OWN(p)}

${RULES}

For every 'block' finding: verify it against the spec yourself, then fix it so the evidence no longer holds. For 'warn': fix when local and clearly right, else reject with a spec quote. Keep the strict row at 100%. Run your tests, the bus/notice tests, tsc (own files), evref, \`python3 tools/audit.py --strict\`.
RETURN (StructuredOutput): row_strict; fixed [one line per finding]; rejected [{claim, reason}]; discrepancies [{tid, spec_figure, engine_figure, why}]; shared_file_changes_needed; notes.`

const CLOSE_SCHEMA = { type: 'object', properties: { row_strict: { type: 'string' }, tests_added: { type: 'array', items: { type: 'string' } }, emitters: { type: 'array', items: { type: 'object', properties: { timer: { type: 'string' }, event: { type: 'string' }, code_path: { type: 'string' } }, required: ['timer', 'event', 'code_path'] } }, overrides_changed: { type: 'array', items: { type: 'object', properties: { timer: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' } }, required: ['timer', 'what', 'why'] } }, fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, reason: { type: 'string' } }, required: ['claim', 'reason'] } }, discrepancies: { type: 'array', items: { type: 'object', properties: { tid: { type: 'string' }, spec_figure: { type: 'string' }, engine_figure: { type: 'string' }, why: { type: 'string' } }, required: ['tid', 'spec_figure', 'engine_figure', 'why'] } }, shared_file_changes_needed: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['row_strict', 'tests_added', 'emitters', 'overrides_changed', 'fixed', 'rejected', 'discrepancies', 'shared_file_changes_needed', 'notes'] }
const FIX_SCHEMA = { type: 'object', properties: { row_strict: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, rejected: { type: 'array', items: { type: 'object', properties: { claim: { type: 'string' }, reason: { type: 'string' } }, required: ['claim', 'reason'] } }, discrepancies: { type: 'array', items: { type: 'object', properties: { tid: { type: 'string' }, spec_figure: { type: 'string' }, engine_figure: { type: 'string' }, why: { type: 'string' } }, required: ['tid', 'spec_figure', 'engine_figure', 'why'] } }, shared_file_changes_needed: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['row_strict', 'fixed', 'rejected', 'discrepancies', 'shared_file_changes_needed', 'notes'] }
const VERIFY_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, severity: { type: 'string', enum: ['block', 'warn'] }, claim: { type: 'string' }, evidence: { type: 'string' } }, required: ['file', 'line', 'severity', 'claim', 'evidence'] } }, tests_pass: { type: 'boolean' }, row_strict: { type: 'string' }, summary: { type: 'string' } }, required: ['findings', 'tests_pass', 'row_strict', 'summary'] }

const results = await pipeline(ITEMS, async (p) => {
  const close = await agent(closePrompt(p), { label: `close:${p.id}`, phase: 'Close', schema: CLOSE_SCHEMA })
  if (!close) return { id: p.id, failed: 'close' }
  const rounds = []
  let report = `tests_added: ${close.tests_added.join(' | ')}\nemitters: ${close.emitters.map((e) => `${e.timer} ← ${e.event} via ${e.code_path}`).join(' | ')}\noverrides_changed: ${close.overrides_changed.map((o) => `${o.timer}: ${o.what}`).join(' | ')}\nfixed: ${close.fixed.join(' | ')}\nrow_strict: ${close.row_strict}`
  for (let round = 1; round <= MAX; round++) {
    const verify = await agent(verifyPrompt(p, round, report), { label: `verify${round}:${p.id}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    if (!verify) { rounds.push({ round, failed: 'verify' }); break }
    const blocks = verify.findings.filter((f) => f.severity === 'block')
    log(`${p.id}: round ${round} → ${blocks.length} block, ${verify.findings.length - blocks.length} warn; ${verify.row_strict}`)
    if (!blocks.length || round === MAX) { rounds.push({ round, verify }); break }
    const fix = await agent(fixPrompt(p, round, verify.findings), { label: `fix${round}:${p.id}`, phase: 'Fix', schema: FIX_SCHEMA })
    rounds.push({ round, verify, fix })
    if (!fix) break
    report = `fix round ${round}: ${fix.fixed.join(' | ')}\nrow_strict: ${fix.row_strict}`
  }
  return { id: p.id, close, rounds }
})
return results
