# Orchestration scripts

Workflow scripts (Claude Code `Workflow` tool, plain JavaScript) that build the remaining spec processes and
adversarially review the built ones. `args.json` carries the per-process and per-section arguments; each
script reads `args.processes` / `args.sections` and `args.scratch` (a writable scratch directory that holds
copies of `gaps.py`, `evref.ts` and `sec13_tests.py`).

- `process-build.js` — per process: build → adversarial verify → fix → re-verify. Ownership is per process:
  `src/domain/<dir>/{ops,timers,evaluators}-<n>-<k>.ts`, `src/app/tools/section<n>-<k>.ts`,
  `src/notices/authored/section<n>-<k>.ts`, the process's spec test file, one migration number.
- `section-review.js` — per already-built section: review → fix → re-review against the spec.
- `gaps.py <section>` — prints the audit's missing units per process; `evref.ts` — evaluator refs vs.
  registered map; `sec13_tests.py` — the test-body generator pattern.

Integration after a run: update the migration/table counts in `src/infra/db/db.test.ts`, append reported
discrepancies to `docs/AUDIT-NOTES.md`, `npm test`, `npm run typecheck`, `python3 tools/audit.py --baseline`, commit.
