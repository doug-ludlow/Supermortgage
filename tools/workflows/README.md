# Orchestration scripts

Workflow scripts (Claude Code `Workflow` tool, plain JavaScript) that build the remaining spec processes and
adversarially review the built ones. `args.json` carries the per-process and per-section arguments; each
script reads `args.processes` / `args.sections` and `args.scratch` (a writable scratch directory that holds
copies of `gaps.py`, `evref.ts` and `sec13_tests.py`).

- `process-build.js` — per process: build → adversarial verify → fix → re-verify. Ownership is per process:
  `src/domain/<dir>/{ops,timers,evaluators}-<n>-<k>.ts`, `src/app/tools/section<n>-<k>.ts`,
  `src/notices/authored/section<n>-<k>.ts`, the process's spec test file, one migration number.
- `section-review.js` — per already-built section: review → fix → re-review against the spec.
- `fix-loop.js` — per process or section: fix a findings file → adversarial re-verify, up to `max_rounds`.
- `strict-close.js` — per process: close to 100% of the STRICT audit (`python3 tools/audit.py --strict`:
  a T-id counts only with a non-todo test titled exactly `"<pid>-T<n>: <spec text>"`; a timer only when
  `tools/lint-emission.ts` finds a real emitter for its satisfied and trigger events with the conditioned fields)
  → adversarial verify → fix → re-verify. Items carry `legacy: true` for §1–§13, whose section-level files may be
  touched with small targeted edits; §14–§19 process files are disjoint.
- `wire.py` — scaffolds the §14–§19 per-process layout for §1–§13 (`timers-<n>-<k>.ts`, `evaluators-<n>-<k>.ts`,
  `src/app/tools/section<n>-<k>.ts`, `src/notices/authored/section<n>-<k>.ts`) and wires them into
  `src/domain/timer-overrides.ts` (`PROCESS_OVERRIDES`, applied after every section's), `src/app/evaluators.ts`,
  `src/app/tools/index.ts` and `src/notices/catalog.ts`. Idempotent.
- `extract.py <task output>` — pulls the remaining block findings per item into `findings_*.json`, prints the
  fix-loop / strict-close args and the reported discrepancies.
- `gaps.py <section>` — prints the audit's missing units per process; `evref.ts` — evaluator refs vs.
  registered map; `sec13_tests.py` — the test-body generator pattern.

Integration after a run: update the migration/table counts in `src/infra/db/db.test.ts`, append reported
discrepancies to `docs/AUDIT-NOTES.md`, `npm test`, `npm run typecheck`, `python3 tools/audit.py --baseline`, commit.
