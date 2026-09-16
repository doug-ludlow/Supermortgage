# spec/registry

Machine-readable indexes of `spec/`, read by the audit (`tools/audit.py`), the scaffold (`tools/scaffold_spec_tests.py`), the timer engine and the name lint. Every file but one is generated; edit the spec and re-run the tool.

| File | Written by | What it holds |
|---|---|---|
| `sections.json`, `processes.json`, `timers.json` | `tools/extract_spec.py` (the original HTML export), then `tools/spec_register.py` additively for markdown-first sections (`npm run spec:register`) | sections, processes (id, title, path, subsections) and every timer row |
| `notices.json` | `tools/extract_notices.py` | every NTC_/INS_ code with its owning process and citation context |
| `agents.json` | `tools/extract_agents.py` | the agent, tools, guardrails and escalation roles of every process |
| `manifest.json` | `tools/spec_manifest.py` (`npm run spec:manifest`) | per process: T-ids with verbatim text, tables, timer codes, notice codes, tools — the units the audit counts |
| `retired.json` | by hand, append-only | units the owner has retired for now, each with its decision record (below) |

## retired.json

A JSON list of rows; nothing else may appear in the file (a row without its four fields is an audit error, so there is no comment row):

```json
[{"unit_id": "32.17-T12", "decision": "docs/decisions/2026-09-16-apply-product.md", "date": "2026-09-16", "reason": "the video stage"}]
```

- `unit_id` forms: `<pid>-T<n>` (a T-numbered test); `<pid>:table:<name>`; `<pid>:timer:<CODE>`; `<pid>:notice:<CODE>`; `<pid>:tool:<name>`; `<pid>:figure:$1,234.56` (a worked figure under that process's Business rules, written as the spec writes it).
- `decision`: a path under the repository root to the decision record in `docs/decisions/`; `date`: ISO `YYYY-MM-DD`; `reason`: one clause.
- Append rows, never edit or remove one: the spec text stays in the process file and `manifest.json` keeps counting it; `tools/audit.py` subtracts the unit before the process row is built (it is neither spec nor built), lists it in `COVERAGE.md`'s `retired` column and Totals row, and fails `--check` on a row missing a field, a `unit_id` the manifest does not carry, or a non-todo `node:test` still titled with a retired T-id. `--baseline` accepts a fall in a kind's total only up to the number of its retired rows dated after the previous baseline's `as_of` (a baseline without `as_of` lets every retired row count). `tools/scaffold_spec_tests.py` never scaffolds a retired T-id as a todo test.
