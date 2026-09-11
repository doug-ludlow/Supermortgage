# Supermortgage Borrower UX — delivery notes for Claude Code

This folder is the borrower-facing UX build specification for the Supermortgage platform. It sits on top of two existing specifications that must be in the same repository (or reachable as project docs):

- **Subservicing Build Spec v1.0** — sections 1–19 (`claude/spec-01…19`, `claude/01-architecture-baseline.md`, verification report)
- **Origination Build Spec v1.0** — sections O1–O12 (`supermortgage-origination-spec/sections/spec-O01…O12`, `01-architecture-baseline-addendum.md`, `05-process-inventory.md`, `timer-registry.csv`)

## Where to put it
`docs/ux/` in the monorepo, next to `docs/servicing/` and `docs/origination/`. Read order: `00-MASTER-INDEX.md` → `01-foundations.md` → `02-data-contracts.md` → files 03–10 in order → 11 → 12 → 13 → 14.

## Ground rules for the implementer (from 00 §3)
1. Nothing in the UI invents a state, timer, notice, command or table. Every name used here exists in the two build specs, except the UI-owned tables listed in `02-data-contracts.md` §1.6.
2. The UI never computes a regulatory date; it renders `timers.due_at` for allow-listed codes (02 §4).
3. No DU findings, credit report contents, fraud/QC/compliance internals ever reach the client.
4. Electronic delivery requires an active E-SIGN consent scoped to the class; otherwise the paper path is rendered.
5. Co-borrowers have separate authenticated threads; the Record is shared per application/loan.
6. Dark theme tokens in 01 §2 are the default.

## Status of this package
Complete: files 00–14. `14-claude-code-build-plan.md` carries the package layout, the six build stages, the ten backend deltas the UX requires (DELTA-01…10), the session prompts, and the definition of done. `13-acceptance-tests.md` indexes 143 tests and maps them to the build-spec tests they depend on.

## Starting prompt (UX-0)
> Read docs/ux/00-MASTER-INDEX.md, 01-foundations.md and 02-data-contracts.md in full, then the architecture baseline (docs/servicing/01-architecture-baseline.md) and the origination addendum (docs/origination/01-architecture-baseline-addendum.md). Build the `borrower-app` shell (Thread + Record + action bar; breakpoints; dark tokens), the card component library exactly as typed in 01 §3, the UI-owned tables in 02 §1.6, the `borrower_record` projection and SSE stream in `api` per 02 §1 and §3, and the command endpoints in 02 §2 and §7 with gate errors surfaced by `copy_key`. Do not invent states or names; where a build spec name is needed and missing, stop and list it under "Backend deltas" rather than creating it. Then implement 03-entry-and-qualification.md screen by screen with its tests (T-03-01…T-03-30) as Playwright and contract tests.
