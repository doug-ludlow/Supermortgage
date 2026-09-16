# Owner decisions — the Apply product (2026-09-16)

Recorded verbatim from the owner's reply to the six decisions in /root/gate-logs/apply/PLAN.md §7. Each item quotes the question as put and the owner's answer.

1. Review screen words, no submit button. The brief has "Submit to DU". The backend has no submit command, DU runs itself at the last prerequisite, and "DU" may not appear on a borrower screen. Recommend: Review reads "Almost there." with one action, confirming the last number cards; Result reads "We're checking your application."
   Owner: Sure

2. Does Chat keep writing facts? The brief says Chat never commits facts. The spec's rule 21 says a complete proposal spoken in words commits. Recommend: keep rule 21 on the server and make the page itself never post a command from Chat. A per-session switch would be an API change.
   Owner: Sure

3. Demographics in v1. Brief: a decline checkbox, else collect. Recommend: the full screen, by mounting the existing demographics card inside the Apply chrome. Decline-only leaves willing borrowers' 1003 section 7 incomplete for no saving.
   Owner: Sure

4. Welcome and "What is Supermortgage?" before the account. The spec says the account is the first screen. Recommend: keep the two screens as the brief decided and amend the spec to "two informational screens precede the account form, nothing personal asked before it."
   Owner: yes

5. The doors 32.14 built. Recommend: keep deep links, return pages, Google callback, sign-in and sign-up, disclosures and document pages, all landing on Apply. The talk and video pages redirect to Apply. SMS and voice stay server-side only, unless you want the channels themselves retired too.
   Owner: yes

6. Partner-book borrowers' My Loan on day one. The brief says My Loan starts empty. The partner book already gives those borrowers a loan. Recommend: My Loan shows the loan on day one with the Monitored badge, and Apply shows no step for them.
   Owner: yes - if you are already someone with a loan, it should show up

Two items the owner did not name; the plan's defaults apply until the owner says otherwise:

7. The video page (`/app/video`) stays mounted but unlinked, so 32.17-T21 stays live; the video door and stage rules are retired for now (the 27-unit list in PLAN.md §3.3).

8. Sessions 0–3 push with the deploy's `walk` job red (the old outcomes against the Apply page, as since run 166) until Session 4 rewrites the walk; `build-borrower` green and `npm test` green are those sessions' gates.

Earlier owner statements this decision record rests on (2026-09-16): "my goal is to introduce a new front end interface, both that works, and looks good"; "'Michelle, the video door and the SMS and voice doors' - that isn't working well, we'll retire them for now"; the brief becoming a docs/ux chapter imported as a section 32 process: "if thats important, sure".

---

## What retires

27 units, listed in `spec/registry/retired.json` (each row cites this file, is dated 2026-09-16 and carries one clause of the reason below). The spec text of each unit stays in its process file as the record of what was built; the audit subtracts the unit before the process row is built, so it is neither spec nor built (PLAN.md §3.3, spec-and-audit-impact §1 class (c)).

| Process | Retired units | Count | Why |
|---|---|---|---|
| 32.9 | T9 | 1 | spoken payoff request (voice) |
| 32.14 | T1, T2, T3, T4, T5, T6, T19 | 7 | the anonymous minute — already "retired" in 32.16 §0.4 prose, inert until now |
| 32.16 | T11, T12, T17, T18, T20 | 5 | the rail at ≥ 1024 px and reference chips (T11, T12); in-app voice turns (T17, T18, T20) |
| 32.17 | T3, T4, T6, T10, T11, T12, T14, T15, T16, T19, T20, T22, T23, T26 | 14 | the video stage (T3, T12, T19, T20, T22, T23), the video door (T10, T14, T15, T16), the rail beside the call (T4, T6), Michelle (T11, T26) |
| **Total** | | **27** | |

The 27 `unit_id`s, in file order: 32.9-T9; 32.14-T1, 32.14-T2, 32.14-T3, 32.14-T4, 32.14-T5, 32.14-T6, 32.14-T19; 32.16-T11, 32.16-T12, 32.16-T17, 32.16-T18, 32.16-T20; 32.17-T3, 32.17-T4, 32.17-T6, 32.17-T10, 32.17-T11, 32.17-T12, 32.17-T14, 32.17-T15, 32.17-T16, 32.17-T19, 32.17-T20, 32.17-T22, 32.17-T23, 32.17-T26.

Every test that carried one of these titles is removed or retitled in the same commit (a regression test may stay under a title that no longer begins with the T-id — "nothing retired keeps counting").

## What stays live

From PLAN.md §3.3: 32.17's `video_sessions` table and five tools (the endpoints remain; 34.5 fixtures use the `video` door value), 32.17-T1/T2/T5/T7/T8/T9/T13/T17/T18/T21/T24/T25 (turn and contract rules); 32.14-T20 and 32.16-T19 (server-side channel tests — the door is not offered, the unit stands); 32.13-T7. Of the live 32.17 units, T21 drives `/app/video` in Chromium (`32-17.spec.test.ts:900-905` waits for `[data-testid="video-call"][data-phase="live"]`; `pageFor` defaults to `/app/video`, `:217`) — so `app/video/page.tsx` stays mounted (PLAN.md §5). Every (b) unit (50) stays live and is re-expressed by PLAN.md §3.2.

Item 7 above is the plan's default this rests on: `/app/video` stays mounted but unlinked so 32.17-T21 stays live; retiring T21 would be a 28th unit and an owner call. Items 5's SMS and voice channels stay server-side with their API-level units live (32.14-T20, 32.16-T19); those units retire only if the owner retires the channels, not just their doors.

## How the audit reads this

The mechanism of PLAN.md §3.4, as built in `tools/audit.py` and `tools/scaffold_spec_tests.py`:

- `spec/registry/retired.json` is a hand-written, append-only JSON list of rows `{"unit_id", "decision", "date", "reason"}`. `unit_id` forms: `<pid>-T<n>`; `<pid>:table:<name>`; `<pid>:timer:<CODE>`; `<pid>:notice:<CODE>`; `<pid>:tool:<name>`; `<pid>:figure:$1,234.56`. `decision` is a path under the repository root to the decision record (this file); `date` is ISO `YYYY-MM-DD`.
- `tools/spec_manifest.py` is unchanged: the manifest keeps counting the rows and the spec text stays the record. `tools/audit.py` loads `retired.json` and, per process, drops the retired ids from the T-id set, the tables, the timers, the notices, the tools and the worked figures before the row is built, so a retired unit is neither spec nor built and a process stays at 100% of its live units. Each row of `coverage.json` carries `retired: [unit_id, …]`; `COVERAGE.md` gains a `retired` column after `units` (`n (decision path)`, blank when none) and a `retired` row in its Totals table; the brief line ends `; retired N`.
- `check()` (run by `npm test`, `python3 tools/audit.py --check`, CI and the Claude Code hooks): (a) a row without `decision`, `date` or `reason`, with a non-ISO date, a decision file that does not exist, a duplicate `unit_id`, or an unparseable `unit_id` is an error and the row is not subtracted; (b) a `unit_id` whose process or unit is not in the manifest (for a figure: not a worked figure under that process's Business rules) is an error; (c) a non-todo `node:test` whose title still begins with a retired T-id (the `<pid>-T<n>`, `<pid>-T<n> / T<m>` and range forms) is an error naming the file — nothing retired keeps counting; a `skip` test counts as titled, a `todo: true` line does not; (d) the per-kind floor stays the baseline's `built` totals: no live total may fall below `docs/audit/baseline.json`, and a process listed there as done stays at 100% of its live units.
- `--baseline` writes an `as_of` (ISO date, UTC) into `baseline.json`, prints the per-kind delta against the previous baseline, and refuses to write (exit 1, nothing written) when a kind's `built` would fall by more than the number of retired rows of that kind dated after the previous baseline's `as_of` (a baseline without `as_of` — every baseline before this mechanism — lets every retired row count as after it; a row dated the same day as the previous `as_of` does not, so a retirement made on the day of a re-base is re-based the next day), or while any retired-unit error of (a)–(c) stands. `--check` prints the retired count (in the brief on success; as a trailing line on failure). `--lenient` subtracts the same rows.
- `tools/scaffold_spec_tests.py` never scaffolds a retired id as a `todo: true` test; it indexes the id as a comment naming the decision.
- Session 0's one commit: `retired.json` (27 rows) + this record + the 27 tests removed or retitled + `npm run audit:baseline`. Expected from PLAN.md §3.4: tids 2276 → 2249, processes at 100% unchanged (every 32.x row stays at 100% over live units), `32.19 0/18` appears (not in `done`); the `--baseline` delta printed = 27 tids.
