# Section 32 — Borrower experience

<!-- imported from docs/ux/ (Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)) by tools/import_ux.py; UX file NN is process 32.k per the map below. Re-run `npm run spec:import:ux` after editing docs/ux; never edit the process files by hand. -->

## Overview

**Package v0.1 · September 10, 2026 · for Claude Code · builds on the Subservicing Build Spec v1.0 (sections 1–19) and the Origination Build Spec v1.0 (sections §20–§31)**

This is the borrower-facing user-experience specification for the Supermortgage platform. It specifies the `borrower-app` package (Next.js, per the architecture baseline and the origination addendum §2) as **one shell** that carries a borrower from first contact through qualification, disclosure, verification, closing, funding, thirty years of servicing, and every refinance in between.

It does not describe a new system. Every screen, card, message and number in this package is a **projection of state the two build specs already define**, every borrower action is a **command the build specs already gate**, and every clock the borrower sees is a **timer the Timer Engine already runs**. Where the UI needs a read model the backend does not have, this package declares it as a projection over existing tables (32.2) and names the owning spec.

The ops-console, partner-facing surfaces, and the portfolio-onboarding path (transfer-in of an existing servicer's book) are out of scope for this package.

**One id grammar.** The UX package cites the Origination build specification as O1–O12; here those are sections 20–31 (O2.3 → 21.3, `tools/import_origination.py`), and the servicing sections 1–19 keep their numbers. Every UX cross-reference was rewritten the same way, so a name means one thing on both sides.

### Vendor fakes

Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. A build stage never waits on a vendor credential; the fake honours the vendor's contract (webhooks, session ids, failure modes) so the cards resolve on the same events in every stage, and a swap to the live adapter changes no card, command or test. The word `FAKE` in a class name, a log line, a doc heading or a console label is the only signal that a counterparty is simulated — no fake is ever unnamed.

### Process map (UX file → process; UX test id → T-id)

| UX file | Process | UX tests | T-ids here |
|---|---|---|---|
| 00-MASTER-INDEX.md, 14-claude-code-build-plan.md | this README | — | — |
| 01-foundations.md | 32.1 | — | — |
| 02-data-contracts.md | 32.2 | — | — |
| 03-entry-and-qualification.md | 32.3 | T-03-01 … T-03-30 | 32.3-T1 … 32.3-T30 |
| 04-disclosures-intent-lock.md | 32.4 | T-04-01 … T-04-10 | 32.4-T1 … 32.4-T10 |
| 05-verification-conditions-coborrowers.md | 32.5 | T-05-01 … T-05-11 | 32.5-T1 … 32.5-T11 |
| 06-decision-property-title-insurance-mi.md | 32.6 | T-06-01 … T-06-12 | 32.6-T1 … 32.6-T12 |
| 07-cd-closing-rescission-funding-boarding.md | 32.7 | T-07-01 … T-07-13 | 32.7-T1 … 32.7-T13 |
| 08a-servicing-payments-statements-escrow.md | 32.8 | T-08a-01 … T-08a-11 | 32.8-T1 … 32.8-T11 |
| 08b-servicing-insurance-pmi-arm-life-events-requests.md | 32.9 | T-08b-01 … T-08b-11 | 32.9-T1 … 32.9-T11 |
| 08c-servicing-hardship-delinquency.md | 32.10 | T-08c-01 … T-08c-11 | 32.10-T1 … 32.10-T11 |
| 09-rate-watch-and-re-refinance.md | 32.11 | T-09-01 … T-09-10 | 32.11-T1 … 32.11-T10 |
| 10-exits.md | 32.12 | T-10-01 … T-10-08 | 32.12-T1 … 32.12-T8 |
| 15-entry-sign-up-and-sign-in.md | 32.14 | T-15-01 … T-15-20 | 32.14-T1 … 32.14-T20 |
| 13-acceptance-tests.md, 12-message-copy-library.md (rules), 11-side-quests-catalogue.md | 32.13 | T-X-01 … T-X-16 | 32.13-T1 … 32.13-T16 |
| 12-message-copy-library.md (the strings) | copy-library.md (referenced; not units) | — | — |

The mapping rule: T-NN-kk → 32.k-Tkk with the leading zero dropped (T-03-01 = 32.3-T1, T-08c-11 = 32.10-T11, T-X-16 = 32.13-T16); the Given/When/Then text is the UX text verbatim apart from the renumbered cross-references.

### Principles (fixed)

1. **Happy path first.** Design the case that happens most: one borrower, primary residence, W-2 income, connectable payroll and bank, a property with public records, a DU Approve/Eligible. Everything else is a *side quest* — a self-contained detour with a trigger, its own cards, its own evidence and a return point. Side quests never restructure the main flow.
2. **Verify from the source, never from the borrower.** Identity from the document (Stripe Identity), income and employment from payroll (a DU validation-service supplier), assets from the bank (Plaid asset report), liabilities from the credit report, property from public records and the flood vendor, the existing loan from the credit report and the recorded instrument. The borrower *confirms*; typing is the fallback.
3. **Ask once, confirm many.** A fact the platform already holds is presented as a `ConfirmCard`, never re-typed. Because 21.1 rule 1 makes a prefilled item count as *submitted* only at the borrower's explicit confirmation, every confirmation is a first-class evidence event.
4. **The assistant proposes and explains; the component commits.** Nothing legally consequential — a consent, a disclosure receipt, a lock, an intent to proceed, a signature, an authorization — exists only as chat text. Each has a typed card that produces the evidence row the build spec requires.
5. **The Record is a projection, not a page.** The right pane renders `borrower_record` (32.2 §1) — state, next event and date, needed-from-you, numbers, documents, people, property, loan. It is never hand-authored per screen.
6. **Initiative belongs to the platform.** In servicing, system-initiated messages (payment posted, escrow result, PMI ending, rate-watch, "nothing needed this month") must outnumber borrower-initiated ones. Every proactive message carries its action inline.
7. **Nothing invented.** No state, timer, notice, command, table or role appears in this package that does not exist in the build specs — except the UI-layer objects declared in 32.2 (`ui_events`, `card_instances`, `conversations`, `deep_links`), which are explicitly new and owned by `borrower-app`.

### Binding rules

- Every screen spec in files 03–10 lists **Reads** (projections and their source tables), **Commands** (with the gate that must be open), **Events** (that move the screen), **Timers** (borrower-visible, with the label to render), **Notices/Documents** (codes and viewer behavior), **Evidence** (what the UI must persist), **Roles** (humans who may appear), **Copy** (keys into copy-library.md), **Tests** (IDs into 32.13).
- The UI never computes a regulatory date. It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given. If a date is not in `timers`, it is not shown.
- The UI never renders DU findings text, Fannie Mae messages, or internal risk assessments. It renders `conditions` (23.2/23.3) in plain language and the decision notices (21.6) as documents.
- The UI never states or implies a credit decision outside `decision.issued{...}`. The decline classifier of 20.3 rule 3 governs assistant copy: the assistant never says "you don't qualify", "you would be denied", or "you cannot get this loan".
- Electronic delivery of any disclosure requires `consents(kind=esign, status=active)` scoped to that disclosure class (7.4; 21.2 guard). If absent, the UI shows the paper path ("mailed on [date]") and never a "view" affordance that would imply electronic delivery.
- The automation disclosure precedes every AI exchange on every channel (baseline §8; 20.3; state chatbot rules). "Talk to a person" is one action away on every screen and emits `human.transfer.requested`.
- Co-borrowers have separate authenticated threads; the Record is shared per application/loan. Per-party artifacts (joint intent, credit authorization, demographics, E-SIGN, signatures) are never captured across parties.
- Money is rendered from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; dates in the borrower's time zone with the calendar named where a business-day definition matters ("3 business days — Sundays and federal holidays don't count").
- Dark theme is the default (32.1 §2). If the theme is switched to light, only tokens change.

### Vocabulary map — UX term → build-spec object

| UX term (borrower-facing) | Spec object | Owner |
|---|---|---|
| Application | `applications` (`status`, `disposition`, decision sub-status) | 21.1, 21.6, 23.3 |
| Your loan (after funding) | `loans` (`boarding_status`, `investor_setup_status`, servicing states) | §30, 1–19 |
| Status badge | `applications.status` / decision sub-status / `loans` state (catalogue in each file) | — |
| Needed from you | `conditions.status = waiting_borrower` ∪ pending consents ∪ pending confirmations ∪ pending connectors | 23.2/23.3, 7.4, 21.1, 22.1 |
| Loan Estimate | `disclosures{kind=le}` → `NTC_REGZ_1026_37_LE` | 21.2, 21.5 |
| Closing Disclosure | `disclosures{kind=cd}` → `NTC_REGZ_1026_38_CD` (+ `_CORRECTED`) | 25.2 |
| Proceed | `intent_records` → `intent.to_proceed.received`; opens `REGZ_1026_19E2_INTENT_FEE_GATE` | 21.4 |
| Lock | `locks` (`requested → pending_mlo_approval → executed → confirmed …`) | 21.4 |
| Your loan officer | `mlo_of_record` (name, NMLSR ID) | 21.1 |
| Connect payroll / bank | `verifications{kind}` via DU validation-service suppliers; `application_income`, `application_assets` | 22.3, 22.4 |
| Verify your identity | `SM_IDENTITY_IAL2_GATE`, identity assurance level L3 | 22.6 |
| Approved with conditions | `decision.issued{conditional_approval}`, `NTC_REGB_1002_9_APPROVAL` | 23.3, 21.6 |
| Counteroffer / decision letter / what's missing | `NTC_REGB_1002_9_COUNTEROFFER` / `NTC_REGB_1002_9_ADVERSE_ACTION` / `NTC_REGB_1002_9_NOIA` | 21.6 |
| Appraisal | `valuation_orders`, `appraisals` (copy sub-state `copy_pending → copy_delivered → copy_received`) | 24.1, 24.2 |
| No appraisal needed | `valuation_orders` value-acceptance path (`offer_recorded → offer_exercised`) | 24.1 |
| Homeowners insurance | hazard `requirement_computed → evidence_requested → evidence_received → verified` | 24.5 |
| Flood insurance | flood `ordered → received → notice_due → notice_delivered → coverage_pending → coverage_verified` | 24.5 |
| Mortgage insurance | `mi_certificates` (`quoted → plan_selected → ordered → committed → docs_ready → active`) | 24.6 |
| Clear to close | `ctc_checklists.passed = true`, decision sub-status `clear_to_close` | 23.3 |
| Closing appointment | `closings` (`scheduled → package_released → pre_session_checks_passed → session_in_progress → signed → …`), `signing_sessions` | 26.2 |
| Cancel window (refinance) | rescission `running → expired_not_rescinded → funding_released`; `REGZ_1026_23_RESCISSION_3SBD_GATE` | 25.3 |
| Funded | `fundings.status = disbursed`, `loan.funded` | 26.3 |
| First payment | `NTC_SM_FIRST_PAYMENT_LETTER`; `FNMA_B2_1_5_FIRST_PAYMENT_2M` | 26.3, 30.2 |
| Autopay | `autodraft_enrollments` (`requested → authorized → validating → active ⇄ paused → revoked / terminated / suspended_returns`) | 2.x |
| Statement | statement cycle (`scheduled → … → sent → delivered`) | 7.1 |
| Escrow | `escrow_accounts`, `escrow_analyses` (`scheduled → computing → computed → approved → statement_sent → effective`) | 3.x, 30.3 |
| E-delivery | `consents{kind=esign}` (`invited → disclosed → consented_pending_verification → active / expired / suspect / withdrawn / superseded`) | 7.4 |
| Texts and calls | `consents{kind=tcpa_voice|tcpa_sms}` (`purpose=informational|marketing`) | 7.4, 11.1, 20.2 |
| PMI | `mi_policies`, `pmi_cancel` case | 10.x |
| Help with payments | `lossmit_applications` (`rfa_only → received → incomplete/complete → …`), `lossmit_evaluations`, `workout_plans` | 12.x |
| Your team (when behind) | continuity of contact (`pending_assignment → assigned → released`) | 4.3 |
| Question / dispute | `cases{case_type=rfi|noe|complaint}` | 4.1, 4.2, 4.5 |
| Payoff quote | payoff request states (7.6) and quote states (16.1) | 7.6, 16.1 |
| Rate-watch | `refi_opportunities` (`detected → offer_ready → offered → converted / declined / expired / suppressed`; `requested`) | 20.1 |
| Person to talk to | `human_agent` (warm transfer), `human.transfer.requested` | 4.x, 20.3 |

### The three happy paths

- **Refinance (rate/term, primary residence, one borrower).** ID capture → SSN → credit authorization → payroll connection → eight confirmations → DU → terms (after loan-officer review under `origination.ai_mlo_intake=assisted`) → LE → proceed → lock. Assets only if DU asks. Five to seven minutes to a DU result; one typed field.
- **Preapproval (purchase, property to be determined).** Same as refinance plus Plaid (down payment, reserves, earnest money), target price and down payment → DU on a TBD property → preapproval letter. House-hunting is a hold state with per-listing numbers.
- **Purchase with a contract.** Preapproval (or the same five minutes) plus the contract → address and price complete the TRID application → LE → proceed → lock → appraisal → insurance → CD → RON.

After funding all three converge on `loan.boarded` and the servicing home (32.8). Every serviced loan enters rate-watch (32.11).

### Side quests

First-class parallel flows (common): second borrower · gift funds · letter of explanation (inquiry, large deposit) · insurance selection (purchase) · appraisal access scheduling. Occasional: self-employment · HELOC subordination · condo project review · appraisal required and low · non-connectable payroll or bank · credit freeze or dispute. Rare: trust vesting · POA · non-permanent resident documents · no-score borrower · Texas and New York variants · manufactured housing · wet-ink closing.

### Open items carried into the package

| Item | Default in this package | Owner |
|---|---|---|
| `origination.ai_mlo_intake` | `assisted` — the UI renders `terms_review` and `pending_mlo` states; `autonomous` removes them without other change | 20.3 Q3 |
| Reg C preapproval program | **Adopted** — DU on TBD property, letter issued; denied preapproval requests reported (28.3) and noticed (21.6) | 20.3 Q2 (overridden) |
| Same-creditor rescission exemption | UI renders rescission from `rescission` state only; when `not_applicable`, no cancel window is shown | 25.3 |
| Hello-notice / lender branding | Experience is Supermortgage; `partner.legal_name` rendered wherever a disclosure or the SAFE Act requires it | 1.3 Q1, 21.2 |
| Theme | Dark (32.1 §2); light theme via tokens only | — |
| Vendors | Stripe Identity · Plaid (assets) · Truv (income/employment) · IRS IVES (transcripts) · carrier connection optional | 22.6, 22.4, 22.3 |

### Backend deltas the UX requires (DELTA-01…10)

Claude Code creates these only as listed; anything else missing is reported back, not improvised.

| ID | Delta | Owner spec touched | Notes |
|---|---|---|---|
| DELTA-01 | Reg C **preapproval program**: `prequalifications{kind=preapproval, du_casefile_id, approved_amount_cents, valid_until}`; event `preapproval.letter.issued`; 21.6 adverse-action and 28.3 HMDA paths for denied preapproval requests | 20.3 (Q2 overridden), 21.6, 23.1 (TBD casefiles), 28.3 | 32.3 §3 |
| DELTA-02 | **UI-owned tables**: `conversations`, `messages`, `card_instances` (+events), `deep_links`, `ui_events`, `sessions` | none (new schema in borrower-app) | 32.2 §1.6 |
| DELTA-03 | **Property-data adapter** (`integrations/property-data`): public records (type, units, year built, APN, tax amount, HOA presence, owner of record, recorded liens), AVM; used by R1/P9/C1 | 20.3 (the "platform's estimate"), 24.4 (recorded instrument), 30.3 (tax lines) | 32.3 §2 R1 |
| DELTA-04 | **Carrier connection** (`integrations/carrier-connect`) — optional path for insurance evidence | 24.5, 9.1 | 32.6 §5, 32.9 §1 |
| DELTA-05 | **Standing verification connections**: `consents{kind=blanket_verification_authorization, standing=true}` with refresh/retention policy; Truv/Plaid connections kept live under authorization | 22.3, 22.4, 31.3 | 32.11 §5 |
| DELTA-06 | **Record projection** `borrower_record` and the servicing history views as read models in `api`; SSE stream | api | 32.2 §1, §3 |
| DELTA-07 | **Agent tools** `send_card`, `resolve_card_by_evidence` (voice intent, human-agent sends) and `create_deep_link` on `borrower-comms` and `intake` | baseline §8 tool allowlists | 32.1 §3, §6 |
| DELTA-08 | **Card-delivered notices**: Notice Registry channel `esign_portal` records `card_instance_id` as delivery evidence alongside `notices.rendered_document_id` | baseline §6 | 32.1 §3.6, 3.16 |
| DELTA-09 | **DemographicsCard collection_method** value `internet` recorded per §1002.13 / App. B for app sessions; `video` treated as not in person | 21.1 rule 3 | 03 R6 |
| DELTA-10 | **Per-listing estimate** for preapproved borrowers (P9): a `pricing_quotes` re-presentation under an approved quote id without a new MLO review while `SM_QUOTE_VALIDITY_GATE` is open | 20.4, 20.3 | 32.3 §3 P9 |

Open legal positions the UX carries as flags (not deltas): `origination.ai_mlo_intake` (20.3 Q3), `live_contact.ai_voice_counts` (11.1), same-creditor rescission exemption (25.3), Reg C preapproval adoption (DELTA-01 decision).

The reconciliation this import found (event spellings, consent kinds, the `esign_portal` channel, non-registry timer names, an unregistered notice code, the `prequalifications` columns) is kept in docs/ux/BACKEND-DELTAS.md.

## Processes

| Process | Title | Automation class |
|---|---|---|
| 32.1 | Shell, theme, component library and Record pane | a |
| 32.2 | Data contracts: projections, commands, events, timers, notices, security, API | a |
| 32.3 | Entry and the five-minute qualification | c |
| 32.4 | Disclosures, intent to proceed, lock, revised LEs | c |
| 32.5 | Verification, needs list, conditions, second borrower | c |
| 32.6 | Decision, property, title, insurance, MI, clear to close | c |
| 32.7 | CD, closing, rescission, funding, boarding | c |
| 32.8 | Servicing: loan home, payments, autopay, statements, escrow | c |
| 32.9 | Servicing: insurance, PMI, ARM, life events, requests | c |
| 32.10 | Servicing: hardship and delinquency | c |
| 32.11 | Rate-watch and the re-refinance loop | c |
| 32.12 | Exits | c |
| 32.13 | Cross-cutting: acceptance harness, copy library rules, side-quest catalogue | a |
| 32.14 | Entry, sign-up and sign-in | c |
| 32.16 | The conversational product: an account, then a conversation, with cards only when the rules need one | b |

## Closing

### Where things live

```
docs/ux/                          ← this package (00–14)
docs/servicing/                   ← Subservicing Build Spec v1.0 (baseline, sections 1–19, verification report)
docs/origination/                 ← Origination Build Spec v1.0 (addendum, inventory, sections §20–§31, timer registry)
packages/borrower-app/            ← Next.js App Router (this package's target; absorbs borrower-portal)
  app/                            ← routes: /, /return/[vendor]/[card], /d/[token], /doc/[id]
  components/shell/               ← Thread, Record, ActionBar, StatusStrip, Drawer
  components/cards/               ← one component per CardKind (01 §3), typed from schemas
  components/record/              ← the ten Record sections
  lib/copy/                       ← 12-message-copy-library as typed keys
  lib/theme/                      ← tokens (01 §2), light set
  lib/api/                        ← generated client from api OpenAPI; SSE client
  tests/                          ← component, e2e (Playwright), copy tests
packages/api/                     ← add: borrower projections (02 §1), command endpoints (02 §2, §7), SSE (02 §3), UI-owned tables (02 §1.6)
packages/agents/borrower-comms/   ← add: card-sending tools (send_card, resolve_card_by_evidence), deep-link tool
packages/agents/intake/           ← add: the same tools; six-item confirmation events surfaced via cards
packages/integrations/            ← add: stripe-identity, plaid, truv, irs-ives, carrier-connect (optional), property-data (DELTA-03), ron-platform (exists under 26.2's eClosing adapter)
```

In this repository the borrower app is `apps/borrower` and the API seam is `src/runtime/borrower` (db/migrations/0111 onward); the per-process build files are `src/domain/borrower/<n>-<m>.spec.test.ts`, `timers-32-k.ts`, `evaluators-32-k.ts`, `src/app/tools/section32-k.ts` and `src/notices/authored/section32-k.ts`. Tests are API-level `node:test` cases plus Playwright driven from `node:test`, titled exactly as the T-id rows.

### Build stages

Each stage ends with its tests green (32.13) and a demo script.

**UX-0 · Foundations (Stage O-1 / servicing Stage 1 parallel).** Shell + breakpoints + dark tokens; card library with schemas and evidence persistence; UI-owned tables; `borrower_record` projection and SSE; command endpoints with gate errors by `copy_key`; auth L1–L3 (OTP, passkeys, Stripe Identity webhook); deep links; copy library loader; telemetry. Tests: component suite, 32.13-T2…05, 32.13-T9…11.

**UX-1 · Entry and the 5-minute qualification (32.3).** E1–E6, R1–R12, P1–P9, C1–C7 against sandbox DU/credit/Truv/Plaid/Stripe; the MLO review queue as a state (`assisted`); preapproval object (DELTA-01). Tests: 32.3-T1…30.

**UX-2 · Disclosures through clear to close (04, 05, 06).** LE/companion `DocumentCard`s and receipt evidence; intent; lock lifecycle; revised LE diff; needs list from `conditions` + `document_requests`; uploads and classification; explanations; co-borrower threads; decision notices; valuation, project, title, insurance, MI cards. Tests: T-04, T-05, T-06.

**UX-3 · CD to boarding (32.7).** CD receipt and earliest-consummation dates; closing scheduling with the RON adapter; session states; rescission cards and exercise; funding status; boarding cards (first-payment letter, autopay, e-delivery, initial escrow statement, Fannie Mae letter). Tests: T-07.

**UX-4 · Servicing (08a, 08b, 08c).** Loan home and account states; payments/autopay; statements and 1098; escrow analysis and elections; insurance and FPI; PMI; ARM; life events and successors; requests (Intake Router wiring); hardship cadence and loss-mitigation cards; bankruptcy and foreclosure states. Tests: T-08a/b/c.

**UX-5 · Rate-watch, re-refinance, exits (09, 10).** Rate-watch block; `OfferCard` and consent-gated channels; conversion with `servicing_record` prefill; same-servicer payoff and escrow credit; standing connections (DELTA-05); payoff, lien release, transfer-out, successor, liquidation. Tests: T-09, T-10.

**UX-6 · Hardening.** Accessibility audit; copy tests; reading level; degraded modes; performance budgets (first card ≤ 1.5 s on 4G; SSE reconnect); security review (CSP, signed URLs, PII masking); light theme tokens.

### Prompts

### 4.1 Session start (UX-0)
> Read docs/ux/00-MASTER-INDEX.md, 01-foundations.md and 02-data-contracts.md in full; then docs/servicing/01-architecture-baseline.md and docs/origination/01-architecture-baseline-addendum.md. Build `packages/borrower-app` as the single borrower surface: the Thread/Record/ActionBar shell with the breakpoints and dark tokens in 01 §1–2; every card kind in 01 §3 as a typed component whose props are validated against the schema and whose resolution posts to `/v1/borrower/cards/{id}/resolve`; the Record sections in 01 §4 rendered from `borrower_record`. In `packages/api`, add the UI-owned tables (02 §1.6), the `borrower_record` projection and SSE (02 §1, §3), and the command endpoints in 02 §2/§7 returning `{code, gate, copy_key}` on refusal. Never invent a state, timer, notice, command or table: if a name you need is not in the build specs or in 02, stop and append it to `docs/ux/BACKEND-DELTAS.md` with the reason. Load copy only from `lib/copy` generated from 12-message-copy-library.md. Write the component tests and T-X-02…05, T-X-09…11 from 13-acceptance-tests.md. Report the delta list before writing any schema outside 02 §1.6.

### 4.2 Per-stage (UX-1 … UX-5)
> Read docs/ux/{file}.md in full and the build-spec sections it names in its header. For each screen/state: implement the cards and Record behavior exactly as specified (Reads · Commands · Events · Timers · Documents · Evidence · Roles · Copy); wire the events in 02 §3; render only allow-listed timers (02 §4) with their labels; enforce the E-SIGN channel rule and the party-scoping rule. Then implement the file's tests from 13 as Playwright and contract tests on the fixture calendar (13 §2). If a spec state is reachable but has no UI treatment in the file, add a `StatusCard` with a neutral copy key and list it under "Open UX items" in your report — do not design a new flow. Do not proceed to the next file until the stage's tests are green.

### 4.3 Review prompt (end of each stage)
> Diff the implemented card kinds, commands, events, timer codes, notice codes and roles against 01 §3, 02 §2–5 and the stage file. List anything implemented that is not named in the specs, anything named in the specs that is not implemented, and any copy string not present in 12. Fix or report.

### Definition of done (package)

1. The three happy paths run end-to-end on the fixture calendar with sandbox counterparties, producing the evidence rows each spec requires (consents, `intent_records`, `disclosures.receipt_evidence`, `credit_authorizations`, `condition_clearances`, `signing_sessions`, `autodraft_enrollments`).
2. All 143 tests in 13 pass; serializer contract tests prove no internal fields leak.
3. Every string rendered is a key in 12; copy tests pass.
4. axe: no WCAG 2.2 AA violations on dark; light tokens switch without layout change.
5. `BACKEND-DELTAS.md` contains only DELTA-01…10 (or documented additions accepted by Doug).
6. The ops-console is untouched except where the specs already route human actions (`escalations`, `human_portal_task`); no borrower action can be performed by a human on the borrower's behalf.

In audit terms: a 32.x process is done only when its row in docs/audit/COVERAGE.md is at 100% of its units; the only statement of progress is that fraction.

### Sequencing against the backend build

UX-0 and UX-1 can start against the origination Stage O-1 outputs (ULAD model, Timer Engine origination units, LE engine) with sandbox adapters. UX-2 needs Stage O-2 rails (DU, credit, verification, AMC, MI, flood, title, eClosing); UX-3 needs O-2 eClosing/eVault and 26.3 funding; UX-4 needs servicing Stage 1–2 (cashiering, escrow, notices, cases) and Stage 3 (default, loss mitigation); UX-5 needs §20 (rate-watch) and 16.x. Where a backend stage lags, the UI stage builds against recorded fixtures and the projection contracts in 02, so the screens exist when the first real event arrives.
