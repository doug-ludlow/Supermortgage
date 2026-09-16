# Supermortgage Borrower UX — delivery notes for Claude Code

This folder is the borrower-facing UX build specification for the Supermortgage platform. It sits on top of two existing specifications that must be in the same repository (or reachable as project docs):

- **Servicing** — sections 1–19, `spec/sections/01-…` to `19-…`
- **Origination** — sections 20–31, `spec/sections/20-…` to `31-…` (imported from the Origination build specification's O1–O12 by `tools/import_origination.py`)

## Where to put it
`docs/ux/` in the monorepo; `tools/import_ux.py` (`npm run spec:import:ux`) generates section 32 of the spec from these chapters. Read order: `00-MASTER-INDEX.md` → `01-foundations.md` → `02-data-contracts.md` → files 03–10 in order → 11 → 12 → 13 → 14 → 15 → 17 → 18.

## Ground rules for the implementer (from 00 §3)
1. Nothing in the UI invents a state, timer, notice, command or table. Every name used here exists in the two build specs, except the UI-owned tables listed in `02-data-contracts.md` §1.6.
2. The UI never computes a regulatory date; it renders `timers.due_at` for allow-listed codes (02 §4).
3. No DU findings, credit report contents, fraud/QC/compliance internals ever reach the client.
4. Electronic delivery requires an active E-SIGN consent scoped to the class; otherwise the paper path is rendered.
5. Co-borrowers have separate authenticated threads; the Record is shared per application/loan.
6. Dark theme tokens in 01 §2 are the default.

## Status of this package
Chapters 00–18 (there is no 16; the DU moment is process 32.18 in `spec/sections/32-borrower-experience/`). `BACKEND-DELTAS.md` is the ledger of what the UI needed the backend to add (DELTA-01…37) and every chapter's build prompt points at it. Since 2026-09-16 the borrower surface is the Apply product of chapter 18 on `/app`; the Thread shell of 01 §1 is not mounted (`docs/decisions/2026-09-16-apply-product.md`). The measured status of section 32 is the `| 32 |` row of `docs/audit/COVERAGE.md`.

Written when the package was delivered: files 00–14. `14-claude-code-build-plan.md` carries the package layout, the six build stages, the ten backend deltas the UX requires (DELTA-01…10), the session prompts, and the definition of done. `13-acceptance-tests.md` indexes 143 tests and maps them to the build-spec tests they depend on. Added since: `15-entry-sign-up-and-sign-in.md` (process 32.14), `17-the-conversational-product.md` (32.16) and `18-the-apply-product.md` (32.19 — the Apply product, the borrower surface on `/app` since 2026-09-16, which replaces the shell of 01 §1 as the surface and changes nothing underneath); each is imported by `tools/import_ux.py` (`npm run spec:import:ux`), and its T-NN-kk tests become `32.k-Tkk`.

## Starting prompt (UX-0, historical — the shell it built was replaced by chapter 18's Apply product on 2026-09-16)
> Read docs/ux/00-MASTER-INDEX.md, 01-foundations.md and 02-data-contracts.md in full, then docs/ARCHITECTURE.md. Build the `borrower-app` shell (Thread + Record + action bar; breakpoints; dark tokens), the card component library exactly as typed in 01 §3, the UI-owned tables in 02 §1.6, the `borrower_record` projection and SSE stream in `api` per 02 §1 and §3, and the command endpoints in 02 §2 and §7 with gate errors surfaced by `copy_key`. Do not invent states or names; where a build spec name is needed and missing, stop and list it under "Backend deltas" rather than creating it. Then implement 03-entry-and-qualification.md screen by screen with its tests (T-03-01…T-03-30) as Playwright and contract tests.
