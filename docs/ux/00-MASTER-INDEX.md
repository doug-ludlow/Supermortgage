# Supermortgage Borrower Experience — UX Build Specification

**Package v0.1 · September 10, 2026 · for Claude Code · builds on the Subservicing Build Spec v1.0 (sections 1–19) and the Origination Build Spec v1.0 (sections O1–O12)**

## 0. What this package is

This is the borrower-facing user-experience specification for the Supermortgage platform. It specifies the `borrower-app` package (Next.js, per the architecture baseline and the origination addendum §2) as **one shell** that carries a borrower from first contact through qualification, disclosure, verification, closing, funding, thirty years of servicing, and every refinance in between.

It does not describe a new system. Every screen, card, message and number in this package is a **projection of state the two build specs already define**, every borrower action is a **command the build specs already gate**, and every clock the borrower sees is a **timer the Timer Engine already runs**. Where the UI needs a read model the backend does not have, this package declares it as a projection over existing tables (02-data-contracts) and names the owning spec.

The ops-console, partner-facing surfaces, and the portfolio-onboarding path (transfer-in of an existing servicer's book) are out of scope for this package.

## 1. Files

| File | Contents |
|---|---|
| `00-MASTER-INDEX.md` | This file — scope, principles, binding rules, vocabulary map |
| `01-foundations.md` | Shell and layout, dark theme tokens, component library (cards), Record pane, identity levels, channels and continuity, copy rules, accessibility, telemetry and evidence, degraded modes |
| `02-data-contracts.md` | Read models the UI consumes, commands it issues, events it subscribes to, timers and notices it surfaces, consent model, security, API surface, feature flags |
| `03-entry-and-qualification.md` | The 5-minute happy path — common entry, refinance, preapproval (TBD property), purchase with contract |
| `04-disclosures-intent-lock.md` | Loan Estimate and companion disclosures, intent to proceed, lock, revised LE |
| `05-verification-conditions-coborrowers.md` | Connectors, needs list, letters of explanation, conditions, the second borrower |
| `06-decision-property-title-insurance-mi.md` | Conditional approval, counteroffer, denial, NOIA; valuation, project eligibility, title, hazard and flood, MI |
| `07-cd-closing-rescission-funding-boarding.md` | Closing Disclosure, closing package, RON session, rescission, funding, boarding and the first 90 days |
| `08a-servicing-payments-statements-escrow.md` | Loan home, payments, autopay, statements, escrow |
| `08b-servicing-insurance-pmi-arm-life-events-requests.md` | Insurance, PMI, ARM, life events, successors, RFI/NoE/payoff/complaints |
| `08c-servicing-hardship-delinquency.md` | Missed payments, early intervention, loss mitigation, plans, bankruptcy and foreclosure states |
| `09-rate-watch-and-re-refinance.md` | Rate-watch, the offer, the compressed refinance of a serviced loan |
| `10-exits.md` | Payoff and lien release, transfer out, successor, liquidation |
| `11-side-quests-catalogue.md` | Every deviation from the happy path — trigger, cards, evidence, exit |
| `12-message-copy-library.md` | Every system message keyed to the event that emits it |
| `13-acceptance-tests.md` | Given/When/Then tests per screen, mapped to build-spec test IDs |
| `14-claude-code-build-plan.md` | Build order, package layout, prompts, definition of done |

## 2. Principles (fixed)

1. **Happy path first.** Design the case that happens most: one borrower, primary residence, W-2 income, connectable payroll and bank, a property with public records, a DU Approve/Eligible. Everything else is a *side quest* — a self-contained detour with a trigger, its own cards, its own evidence and a return point. Side quests never restructure the main flow.
2. **Verify from the source, never from the borrower.** Identity from the document (Stripe Identity), income and employment from payroll (a DU validation-service supplier), assets from the bank (Plaid asset report), liabilities from the credit report, property from public records and the flood vendor, the existing loan from the credit report and the recorded instrument. The borrower *confirms*; typing is the fallback.
3. **Ask once, confirm many.** A fact the platform already holds is presented as a `ConfirmCard`, never re-typed. Because O2.1 rule 1 makes a prefilled item count as *submitted* only at the borrower's explicit confirmation, every confirmation is a first-class evidence event.
4. **The assistant proposes and explains; the component commits.** Nothing legally consequential — a consent, a disclosure receipt, a lock, an intent to proceed, a signature, an authorization — exists only as chat text. Each has a typed card that produces the evidence row the build spec requires.
5. **The Record is a projection, not a page.** The right pane renders `borrower_record` (02-data-contracts §1) — state, next event and date, needed-from-you, numbers, documents, people, property, loan. It is never hand-authored per screen.
6. **Initiative belongs to the platform.** In servicing, system-initiated messages (payment posted, escrow result, PMI ending, rate-watch, "nothing needed this month") must outnumber borrower-initiated ones. Every proactive message carries its action inline.
7. **Nothing invented.** No state, timer, notice, command, table or role appears in this package that does not exist in the build specs — except the UI-layer objects declared in 02-data-contracts (`ui_events`, `card_instances`, `conversations`, `deep_links`), which are explicitly new and owned by `borrower-app`.

## 3. Binding rules for Claude Code

- Every screen spec in files 03–10 lists **Reads** (projections and their source tables), **Commands** (with the gate that must be open), **Events** (that move the screen), **Timers** (borrower-visible, with the label to render), **Notices/Documents** (codes and viewer behavior), **Evidence** (what the UI must persist), **Roles** (humans who may appear), **Copy** (keys into 12-message-copy-library), **Tests** (IDs into 13-acceptance-tests).
- The UI never computes a regulatory date. It renders `timers.due_at` for allow-listed codes (02 §4) with the label given. If a date is not in `timers`, it is not shown.
- The UI never renders DU findings text, Fannie Mae messages, or internal risk assessments. It renders `conditions` (O4.2/O4.3) in plain language and the decision notices (O2.6) as documents.
- The UI never states or implies a credit decision outside `decision.issued{...}`. The decline classifier of O1.3 rule 3 governs assistant copy: the assistant never says "you don't qualify", "you would be denied", or "you cannot get this loan".
- Electronic delivery of any disclosure requires `consents(kind=esign, status=active)` scoped to that disclosure class (7.4; O2.2 guard). If absent, the UI shows the paper path ("mailed on [date]") and never a "view" affordance that would imply electronic delivery.
- The automation disclosure precedes every AI exchange on every channel (baseline §8; O1.3; state chatbot rules). "Talk to a person" is one action away on every screen and emits `human.transfer.requested`.
- Co-borrowers have separate authenticated threads; the Record is shared per application/loan. Per-party artifacts (joint intent, credit authorization, demographics, E-SIGN, signatures) are never captured across parties.
- Money is rendered from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; dates in the borrower's time zone with the calendar named where a business-day definition matters ("3 business days — Sundays and federal holidays don't count").
- Dark theme is the default (01 §2). If the theme is switched to light, only tokens change.

## 4. Vocabulary map — UX term → build-spec object

| UX term (borrower-facing) | Spec object | Owner |
|---|---|---|
| Application | `applications` (`status`, `disposition`, decision sub-status) | O2.1, O2.6, O4.3 |
| Your loan (after funding) | `loans` (`boarding_status`, `investor_setup_status`, servicing states) | O11, 1–19 |
| Status badge | `applications.status` / decision sub-status / `loans` state (catalogue in each file) | — |
| Needed from you | `conditions.status = waiting_borrower` ∪ pending consents ∪ pending confirmations ∪ pending connectors | O4.2/O4.3, 7.4, O2.1, O3.1 |
| Loan Estimate | `disclosures{kind=le}` → `NTC_REGZ_1026_37_LE` | O2.2, O2.5 |
| Closing Disclosure | `disclosures{kind=cd}` → `NTC_REGZ_1026_38_CD` (+ `_CORRECTED`) | O6.2 |
| Proceed | `intent_records` → `intent.to_proceed.received`; opens `REGZ_1026_19E2_INTENT_FEE_GATE` | O2.4 |
| Lock | `locks` (`requested → pending_mlo_approval → executed → confirmed …`) | O2.4 |
| Your loan officer | `mlo_of_record` (name, NMLSR ID) | O2.1 |
| Connect payroll / bank | `verifications{kind}` via DU validation-service suppliers; `application_income`, `application_assets` | O3.3, O3.4 |
| Verify your identity | `SM_IDENTITY_IAL2_GATE`, identity assurance level L3 | O3.6 |
| Approved with conditions | `decision.issued{conditional_approval}`, `NTC_REGB_1002_9_APPROVAL` | O4.3, O2.6 |
| Counteroffer / decision letter / what's missing | `NTC_REGB_1002_9_COUNTEROFFER` / `NTC_REGB_1002_9_ADVERSE_ACTION` / `NTC_REGB_1002_9_NOIA` | O2.6 |
| Appraisal | `valuation_orders`, `appraisals` (copy sub-state `copy_pending → copy_delivered → copy_received`) | O5.1, O5.2 |
| No appraisal needed | `valuation_orders` value-acceptance path (`offer_recorded → offer_exercised`) | O5.1 |
| Homeowners insurance | hazard `requirement_computed → evidence_requested → evidence_received → verified` | O5.5 |
| Flood insurance | flood `ordered → received → notice_due → notice_delivered → coverage_pending → coverage_verified` | O5.5 |
| Mortgage insurance | `mi_certificates` (`quoted → plan_selected → ordered → committed → docs_ready → active`) | O5.6 |
| Clear to close | `ctc_checklists.passed = true`, decision sub-status `clear_to_close` | O4.3 |
| Closing appointment | `closings` (`scheduled → package_released → pre_session_checks_passed → session_in_progress → signed → …`), `signing_sessions` | O7.2 |
| Cancel window (refinance) | rescission `running → expired_not_rescinded → funding_released`; `REGZ_1026_23_RESCISSION_3SBD_GATE` | O6.3 |
| Funded | `fundings.status = disbursed`, `loan.funded` | O7.3 |
| First payment | `NTC_SM_FIRST_PAYMENT_LETTER`; `FNMA_B2_1_5_FIRST_PAYMENT_2M` | O7.3, O11.2 |
| Autopay | `autodraft_enrollments` (`requested → authorized → validating → active ⇄ paused → revoked / terminated / suspended_returns`) | 2.x |
| Statement | statement cycle (`scheduled → … → sent → delivered`) | 7.1 |
| Escrow | `escrow_accounts`, `escrow_analyses` (`scheduled → computing → computed → approved → statement_sent → effective`) | 3.x, O11.3 |
| E-delivery | `consents{kind=esign}` (`invited → disclosed → consented_pending_verification → active / expired / suspect / withdrawn / superseded`) | 7.4 |
| Texts and calls | `consents{kind=tcpa_voice|tcpa_sms}` (`purpose=informational|marketing`) | 7.4, 11.1, O1.2 |
| PMI | `mi_policies`, `pmi_cancel` case | 10.x |
| Help with payments | `lossmit_applications` (`rfa_only → received → incomplete/complete → …`), `lossmit_evaluations`, `workout_plans` | 12.x |
| Your team (when behind) | continuity of contact (`pending_assignment → assigned → released`) | 4.3 |
| Question / dispute | `cases{case_type=rfi|noe|complaint}` | 4.1, 4.2, 4.5 |
| Payoff quote | payoff request states (7.6) and quote states (16.1) | 7.6, 16.1 |
| Rate-watch | `refi_opportunities` (`detected → offer_ready → offered → converted / declined / expired / suppressed`; `requested`) | O1.1 |
| Person to talk to | `human_agent` (warm transfer), `human.transfer.requested` | 4.x, O1.3 |

## 5. The three happy paths (summary — full specs in 03)

- **Refinance (rate/term, primary residence, one borrower).** ID capture → SSN → credit authorization → payroll connection → eight confirmations → DU → terms (after loan-officer review under `origination.ai_mlo_intake=assisted`) → LE → proceed → lock. Assets only if DU asks. Five to seven minutes to a DU result; one typed field.
- **Preapproval (purchase, property to be determined).** Same as refinance plus Plaid (down payment, reserves, earnest money), target price and down payment → DU on a TBD property → preapproval letter. House-hunting is a hold state with per-listing numbers.
- **Purchase with a contract.** Preapproval (or the same five minutes) plus the contract → address and price complete the TRID application → LE → proceed → lock → appraisal → insurance → CD → RON.

After funding all three converge on `loan.boarded` and the servicing home (08a). Every serviced loan enters rate-watch (09).

## 6. Side quests (summary — catalogue in 11)

First-class parallel flows (common): second borrower · gift funds · letter of explanation (inquiry, large deposit) · insurance selection (purchase) · appraisal access scheduling. Occasional: self-employment · HELOC subordination · condo project review · appraisal required and low · non-connectable payroll or bank · credit freeze or dispute. Rare: trust vesting · POA · non-permanent resident documents · no-score borrower · Texas and New York variants · manufactured housing · wet-ink closing.

## 7. Open items carried into the package (each has a default)

| Item | Default in this package | Owner |
|---|---|---|
| `origination.ai_mlo_intake` | `assisted` — the UI renders `terms_review` and `pending_mlo` states; `autonomous` removes them without other change | O1.3 Q3 |
| Reg C preapproval program | **Adopted** — DU on TBD property, letter issued; denied preapproval requests reported (O9.3) and noticed (O2.6) | O1.3 Q2 (overridden) |
| Same-creditor rescission exemption | UI renders rescission from `rescission` state only; when `not_applicable`, no cancel window is shown | O6.3 |
| Hello-notice / lender branding | Experience is Supermortgage; `partner.legal_name` rendered wherever a disclosure or the SAFE Act requires it | 1.3 Q1, O2.2 |
| Theme | Dark (01 §2); light theme via tokens only | — |
| Vendors | Stripe Identity · Plaid (assets) · Truv (income/employment) · IRS IVES (transcripts) · carrier connection optional | O3.6, O3.4, O3.3 |
