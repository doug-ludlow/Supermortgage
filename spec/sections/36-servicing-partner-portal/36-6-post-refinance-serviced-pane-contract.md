# 36.6 — The post-refinance serviced pane contract: dark in V1, one refusal everywhere

| Attribute | Value |
|---|---|
| Section | 36 — The servicing partner portal: partner identity, the tape drop, the eligibility board, the refinance pipeline, home and reports, and the serviced pane contract |
| Automation class | c — nothing runs; the contract is stated and every call answers the one refusal |
| Capacity | Supermortgage as platform operator and, after board, as subservicer. Partner as master servicer / MSR owner / Fannie seller / program lender (pre-refi: nothing to serve — the partner's incumbent subservicer services a monitored loan and the pane never lights for one; post-refi: Fannie subservicer of the new loan under Selling Guide A2-1-07 — V2, and V1 claims none of it) |
| Trigger & frequency | On every `GET /v1/partner/loans/:id/serviced` (and any path beneath it) by a partner role (36.1); nothing else, nothing scheduled, nothing unprompted |
| Governing source | 36.5 (the loan page whose Serviced tab this darkens; its `serviced` field), 30.2 (the boarded new loan: `loans.status = active`, `origination_application_id`; the ledger, clocks and statements sections 2–19 already run on it), 35.10 (the closeout that retires the prior loan), 36.1 (the tenant rule and the log); Selling Guide A2-1-07 (subservicing arrangements: both parties Fannie Mae-approved, Form 101, separate 1013/1014 custodial accounts, the master servicer fully liable), A2-7-03 (post-delivery transfers of servicing, if Supermortgage is later appointed on already-delivered loans); GLBA §1016.13 (no Supermortgage product marketed from the partner's data on the pane); the sections V2 will read — 2, 3, 5, 6, 7, 9, 10, 11, 12, 16 and 18 |
| Key deadlines | None; V1 arms nothing, and V2's clocks are the owning sections' (2–19) on the active loan, seeded by 30.2's boarding, never by the pane |
| Timers | none |

### Blueprint row
After the refinance closes and 30.2 boards the new loan, Supermortgage is its subservicer and the partner will want to see it serviced: payments and the next due, escrow, insurance, delinquency, loss mitigation, remittance, custodial balances, notices, QC exceptions, payoff. None of that is built for the partner in V1, and the team must not invent a second servicing product later to fill the gap. This process is the contract that keeps V2 attachable without a rewrite: the modules the pane will hold, the section each one will read and never write, the Guide topics behind each, one HTTP answer every one of them gives until it is built — `409 SERVICED_PANE_NOT_BUILT` — and one disabled Serviced tab on the loan page carrying that copy. No empty chart, no placeholder figure, no claim that servicing is shown.

### Verified requirement (as of 2026-09-16)
**Subservicing of the new loan is a Fannie Mae arrangement, not a portal feature (Selling Guide A2-1-07; A2-7-03).** A subservicing arrangement needs both parties approved, the master servicer remaining fully responsible, the arrangement reported on Form 101 and the custodial accounts kept apart (Forms 1013 and 1014); a later appointment onto already-delivered loans is a post-delivery transfer under A2-7-03 with its own forms and notices. V1 implements none of it and claims none of it; the pane's copy and its refusal say so. **[PARTIALLY VERIFIED — the topic names and their subjects are the brief's §12 and the 36 README's; the Guide text was not fetched in this session and is confirmed before any V2 module ships.]**

**The active loan is already serviced by sections 2–19 (30.2).** `loan.boarded` posts the opening ledger, seeds the clocks, indexes the consents and documents and opens the first statement cycle; `loan.active` follows the vendor activations; from then the cashiering, escrow, insurance, delinquency, remittance, custodial, notice, QC and payoff processes run on the loan as on any loan Supermortgage services. The pane, when built, reads their rows through their own reads; V1 refuses to show them. **[VERIFIED against 30.2's state machine, outputs and worked example 1.]**

**One code, and it is 409 (brief §5.6; docs/partner-portal/BACKEND-DELTAS.md "Already named").** The brief allows `409` or `404` for the unbuilt pane if one code is used everywhere and documented here: the code is `409 SERVICED_PANE_NOT_BUILT`, because the loan exists in the tenant and a `404` would say it does not (36.1 rule 4 reserves `404 NOT_FOUND` for what is not the tenant's); the pane's absence is a conflict between the request and the state of the build, not a missing resource. 36.5's `serviced` field carries the same code. **[VERIFIED — the deltas file's row and 36.5 rule 8 name 409.]**

**Monitored is never serviced here (33.1 `LOAN_MONITORED`; brief §3 rules 8 and 9).** A monitored loan refuses every command of sections 2–19, arms none of their clocks and has no ledger; the pane can never light for one, in any version, and the pre-refi book is a GLBA service-provider feed, not a servicing transfer (no Form 629, no Form 101, no RESPA notices, no custodial account). **[VERIFIED — 33.1's verified requirement and 33.1-T9.]**

**Discrepancies vs blueprint**: (1) The brief offers 409 or 404: 409, everywhere, with the same body 36.5's `serviced` field carries. (2) The brief says "every module endpoint returns 409": V1 declares one route, `GET /v1/partner/loans/:id/serviced`, and every path beneath it answers the same code, so V2's module paths are covered before they are named (open question 1); no module path is minted here. (3) The deltas file's "409 until `loans.status = active` and `origination_application_id IS NOT NULL`" states V2's attach condition, not a V1 branch: in V1 an `active` boarded loan answers 409 too (36.6-T2), and only a V2 build with that condition true lights a module.

### Operational prerequisites
- 36.5 built (the loan page and its Serviced tab), 36.1 (the session, the tenant rule, the log).
- Nothing else for V1. Fannie Mae approval of the subservicing arrangement, Form 101, the 1013/1014 custodial accounts and the partner's servicing agreement are V2's prerequisites, owned by 30.1 and the sections the pane will read, and are not claimed by this process.

### Build spec
#### Inputs and triggers
- `GET /v1/partner/loans/:id/serviced` (all three roles) and any `GET` beneath `/v1/partner/loans/:id/serviced/` → the tenant rule first (another tenant's loan or an unknown id: `404 NOT_FOUND`, 36.1 rule 4), then `409 SERVICED_PANE_NOT_BUILT` with the body `{ available: false, code: "SERVICED_PANE_NOT_BUILT" }` for every loan of the tenant whatever its `loans.status` (monitored, active, paid off, transferred out) — 36.6-T1, 36.6-T2. No other method is routed.
- Events: none of its own; 36.1's `partner_actions` row per request with `partner_portal.viewed`, `view = serviced`, `subject_id` = the loan id, `result = refused`, `refusal_code = SERVICED_PANE_NOT_BUILT` (or `NOT_FOUND`), no homeowner field.
- Nothing starts here, in V1 or V2: the pane never arms a clock, never posts, never sends.

#### Data model
New tables: none — this process creates nothing and reads two columns to answer; the rows a V2 module will read belong to the sections in the table under Business rules and are read there through their own reads.
- Baseline tables read: `loans` (`partner_party_id` for the tenant rule; `status` and `origination_application_id` for V2's attach condition, read and not branched on in V1), `partner_sessions` and `partner_users` (36.1).
- Baseline tables written: `partner_actions` (36.1; one row per request, `result = refused`, the refusal code, no PII). Nothing else.

#### State machine
None in V1. The contract per module: `dark —(the module is built; loans.status = active and origination_application_id set on the row)→ lit`; a `monitored`, `paid_off` or `transferred_out` row never lights, in any version. No transition exists in V1; every row answers `dark`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|

Jurisdiction overrides: none.

#### Business rules and calculations
1. **One code, everywhere.** The unbuilt pane answers `409 SERVICED_PANE_NOT_BUILT`, body `{ available: false, code: "SERVICED_PANE_NOT_BUILT" }`, on the one route and every path beneath it, for every loan of the tenant, under every partner role, in every build stage of V1; 36.5's loan page carries the same object in its `serviced` field for a monitored and for an `active` row. No other code, no per-module variant, no `501`, no `404` for a loan that is the tenant's, no empty `200`.
2. **The modules and what each will read.** When V2 is built, the pane holds these modules and no others without a new row in this table; each reads the named section's rows through that section's own reads and never writes:

| Module | Reads (never writes) | Guide / spec |
|---|---|---|
| Payment history / next due | §2 cashiering — the ledger, the installment schedule, the next due date | Servicing Guide Part C |
| Escrow | §3 — the escrow account, the analysis, the shortage or surplus | Part B-1 |
| Insurance / flood / lender-placed | §9, §10 — policies, flood determinations, lender-placed status, MI | Part B-2, B-3, B-6 |
| Delinquency / early intervention | §11 — days delinquent, the live-contact and written-notice record | D2-2 |
| Loss mitigation | §12 — the application, the evaluation, the plan | D2-3 |
| Investor remittance / LAR | §5 — the remittance and the loan activity report | C-3, C-4 |
| Custodial P&I and T&I | §6 — the custodial balances by account | A4-1-02; Forms 1013 / 1014 |
| Notices | §7 / the notice registry — the notices sent on the loan, by code and date | — |
| QC exceptions | §18 — the exceptions by category | A1-1-03 STAR categories |
| Payoff | §16 — the payoff quote and the release | — |

3. **Read, never write, and only after board.** A module lights only when `loans.status = active` and `origination_application_id IS NOT NULL` — the new loan 30.2 boarded from the refinance application — and reads that loan's rows; it lights for no monitored, paid-off or transferred-out row. No module calls a command that writes: the partner never pays, drafts, waives, modifies, requests a payoff, files a claim, sends a notice or resolves an exception from the portal; a money act stays where its owner puts it (`officer`), and the partner's own acts on the serviced loan — as master servicer — happen outside this portal under the servicing agreement. `LOAN_MONITORED` stands unchanged.
4. **No empty chart, one disabled tab.** The loan page (36.5) shows one Serviced tab, visible and disabled on every loan page (monitored, in refinance, active, retired), whose copy is: "Serviced pane not built (V1). When Supermortgage subservices the refinanced loan, its payment, escrow, insurance, delinquency, remittance, custodial, notice, QC and payoff detail will appear here." The tab renders no chart, no table, no zero, no placeholder figure and no partial module; a click answers the same copy and nothing else. GLBA fixes the copy's limit: no Supermortgage product, offer or funnel appears on the tab or the pane, in V1 or V2.
5. **Introduces nothing.** This process adds no money field, no timer, no notice, no table, no command, no role, no event and no worked figure (36.6-T3); the audit's units for it are its three tests. What it fixes is a code, a table of modules and a piece of copy, so that V2 attaches to 36.5's page and to this route without renaming, re-routing or a second product.
6. **Tenant first.** `404 NOT_FOUND` for a loan that is not the tenant's precedes `409` for one that is (36.1 rule 4: existence is not a signal); both are logged with their code and no field of the row.

No money figure is computed here.

#### Integrations
- None. No vendor, no adapter, no Fannie Mae form or feed; V2's modules read the owning sections' rows, whose integrations are theirs.

#### Outputs and artifacts
- Rows: none of its own; `partner_actions` (36.1) with the refusal code.
- Events: none.
- No notice, no document, no report, no export.
- The 409 body on the route and every path beneath it; the disabled Serviced tab on the loan page with rule 4's copy; this table of modules as the V2 contract.

#### AI agent design (AI-first)
`portfolio` agent owns the contract and declares nothing of its own on the bus. End-to-end: on every read the runtime applies 36.1's tenant rule, answers the one refusal (rule 1) and logs it (36.1); no projection is computed, no row of sections 2–19 is read in V1, nothing runs unprompted, nothing is proposed for a human, nothing is written but the log row; when V2 lights a module it reads through the owning section's own reads (rule 2) and still writes nothing. Decision record: none. Guardrails: `READ_ONLY` (34.3 — the pane never writes, in any version), `LOAN_MONITORED` (33.1 — never lit for a monitored row), `NO_COMPUTED_FIGURE` (34.3 — no placeholder, no zero, no chart), `NO_PII_IN_LOG` (34.1, reused by 36.1). Escalations: none.

#### Edge cases and failure modes
- A monitored loan → `409 SERVICED_PANE_NOT_BUILT` (36.6-T1); the page's banner stays Monitored.
- An `active` boarded loan of the tenant → `409 SERVICED_PANE_NOT_BUILT` in V1 (36.6-T2) while its banner already reads Active (36.5 rule 4) and sections 2–19 already run on it.
- A `paid_off` or `transferred_out` row → `409`; the page's `serviced` field is null (36.5 rule 8) and the tab is disabled like every other.
- Another tenant's loan or an unknown id → `404 NOT_FOUND` before any 409 (rule 6).
- A `POST`, `PUT` or `DELETE` on the route or beneath it → not routed; the wrapper's ordinary answer for a route that does not exist.
- A path beneath `/serviced/` that V2 has not named → `409 SERVICED_PANE_NOT_BUILT`, the same as the route.
- V2 half built (one module lit, the rest dark) → each dark module still answers `409` for its path; a lit module answers only when rule 3's condition holds on the row, else `409`.
- A staff cookie or the machine token on the route → 401 (36.1 rule 7); the pane has no staff fallback.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 36.6-T1 | Given a monitored loan, `GET /v1/partner/loans/:id/serviced` is `409 SERVICED_PANE_NOT_BUILT`. |
| 36.6-T2 | Given an `active` boarded loan for this partner, the same endpoint is still `409 SERVICED_PANE_NOT_BUILT` in V1, and the loan page banner is already `Active`. |
| 36.6-T3 | 36.6 introduces **no** new money field, timer, or notice. |

#### Audit and evidence
What an examiner is shown: this table of modules with the section and Guide topic behind each; 36.1's action-log rows for every call with `refusal_code = SERVICED_PANE_NOT_BUILT` and no PII; the registry's rows for section 36 showing no timer, no notice and no worked figure owned by this process (`npm run audit` — the process's units are its three tests); and, for the active loan, the owning sections' own evidence (30.2's boarding validations and opening ledger, the clocks 30.4 seeded), which the pane will read in V2 and does not show in V1. Exported through 34.4's evidence pack (staff).

### Open questions / decisions
1. What are V2's module paths? **Default: beneath the one route, one path per module of rule 2's table, named when the first module is specified — as an extension of this process by a delta row in docs/partner-portal/BACKEND-DELTAS.md, never a second product or a second prefix.**
2. 409 or 404 for the unbuilt pane? **Default: 409, decided — 404 is the tenant rule's answer and would make a tenant's own loan look like another's.**
3. Should the Serviced tab be hidden on a monitored row? **Default: no — visible and disabled on every loan page (the brief §7), so V2 attaches without a layout change and the partner learns where serviced detail will live.**
4. Does the pane light for a loan Supermortgage boards by transfer (1.1) rather than by refinance? **Default: not in this contract — rule 3's condition names the refinanced loan (`origination_application_id` set); a transferred-in loan is A2-7-03's case and a later extension.**

### Sources
- spec/sections/36-servicing-partner-portal/36-5 (the loan page, its `serviced` field, the banner), 36-1 (the tenant rule, the log, the surfaces); spec/sections/30-*/30-2 (the boarded loan, `loan.boarded`, `loan.active`, the opening ledger and the clocks seeded), 30-1 (Fannie Mae post-purchase set-up); spec/sections/35-operations-runtime/35-10 (the retired prior loan); spec/sections/33-partner-book/33-1 (`LOAN_MONITORED`, T9); the sections the modules will read: spec/sections/02-*, 03-*, 05-*, 06-*, 07-*, 09-*, 10-*, 11-*, 12-*, 16-*, 18-*.
- docs/partner-portal/00-CLAUDE-BUILD-INSTRUCTIONS.md §0 (the dark stub), §3 rules 8, 9 and 10, §5.6 (the module table, the one code), §7 (the Serviced tab), §12 (A2-1-07, A2-7-03); docs/partner-portal/BACKEND-DELTAS.md ("Already named": `SERVICED_PANE_NOT_BUILT`).
- Fannie Mae Selling Guide A2-1-07 (Subservicing), A2-7-03 (Post-Delivery Servicing Transfers), Forms 101, 1013, 1014 **[PARTIALLY VERIFIED — topic names and subjects only; text to be fetched before V2]**; Fannie Mae Servicing Guide Parts A4-1-02, B-1, B-2, B-3, B-6, C, C-3, C-4, D2-2, D2-3, A1-1-03 (the modules' Guide topics, as the brief names them); 12 CFR §1016.13 (GLBA service-provider exception).
