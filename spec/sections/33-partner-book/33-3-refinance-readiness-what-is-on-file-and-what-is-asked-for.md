# 33.3 — Refinance readiness: what a refinance needs, what is on file, what is asked for

| Attribute | Value |
|---|---|
| Section | 33 — The partner book: monitored loans, real accounts and refinance readiness |
| Automation class | a — the readiness agent checks daily and asks through the assistant; no human starts it |
| Capacity | Lender (the partner's refinance; Supermortgage assembles the file through the owning processes' tools) |
| Trigger & frequency | Daily at 07:15 America/New_York for every candidate and every open refinance application from a monitored loan; on the homeowner's Yes (the refinance application is opened); on every verification event afterwards |
| Governing source | 22.2 (credit report validity: four months on the note date), 22.3 (income: DU validation, VVOE window), 22.4 (assets: the 45-day statement rule; the 365-day report), 22.6 (identity IAL2, `valid_until`), 20.3 rule 10 and 32.2 (consents), 21.1 (the application opened with `prior_loan_id`), 32.11 §3–§5 (the compressed refinance application; data refreshed only after a Yes), 32.18 (the DU moment) |
| Key deadlines | A readiness row per candidate by 07:30 ET; the DU moment as soon as the last item lands (32.18) |
| Timers | `SM_PARTNER_BOOK_READINESS_DAILY` |

### Blueprint row
Every verification fact on the platform is keyed by an application: identity, SSN, the credit report, income, assets. A homeowner from the partner book has none of those until a refinance application exists, and today no path opens one from a monitored loan (32.11's conversion needs the origination application the loan never had). This process is the checklist and the hand-off: what a refinance needs, what is on file for this homeowner and how fresh it is, the refinance application opened from the monitored loan the moment the homeowner says Yes, and the asks — through the same cards and the same assistant every applicant gets — until the DU moment fires.

### Verified requirement (as of 2026-09-14)
**Facts live on the application; consents on the party (0081, 0079, 0112).** `verifications` and `credit_reports` require an application; `consents` may stand on a party with `standing = true` for the blanket verification authorization. A readiness row therefore reads party-level facts always (contact, activation, consents, any earlier application's identity and reports) and application-level facts once the refinance application exists. **[VERIFIED in db/migrations and src/domain/verification.]**

**Freshness rules are the owning processes' (22.2 R3; 22.3; 22.4; 22.6 R1).** Credit: usable and unexpired (`expires_at` = report date + 4 months) with room to close; identity: `verifications{kind=identity, outcome=verified}` with `valid_until` at or after the projected note date; income: a payroll report dated within 120 days (this process's default where 22.3 sets no fixed age) or a DU validation with a close-by date ahead; assets: a 365-day report dated within 120 days; consents active; value dated within 12 months. **[PARTIALLY VERIFIED — the 120-day ages for payroll and asset reports are this process's defaults; 22.3/22.4 set none.]**

**No data is pulled before the homeowner's Yes (32.11 §5; FCRA §604).** The daily check reads; it orders nothing. After the Yes the refinance application exists and the platform's own flows ask: the identity scan, the SSN card, the payroll and assets connectors, the hard-pull authorization on the goal — 32.3 E5/R3 and 32.18 rule 1, unchanged. **[VERIFIED against flows/3-entry.ts.]**

**Discrepancies vs blueprint**: (1) 32.11 convert() rebuilds the refinance application from the origination application; a monitored loan has none, so `refi.open` builds it from `borrowers`, `parties`, `properties` and the partner's facts (the value as the AVM stand-in, the payoff estimate from the UPB). (2) 32.11 §3 says identity is re-run only if expired "per 22.6 policy"; no such policy exists — this process treats an identity verification as present when `valid_until` is at or after the projected note date and missing otherwise.

### Operational prerequisites
- The partner's DU identifiers and credit reseller codes (32.18's operational prerequisites) so the DU moment can fire on the refinance application.
- The FAKE vendors (Stripe Identity, Truv, Plaid, DU) in every build stage.

### Build spec
#### Inputs and triggers
- The sweep at or after 07:15 America/New_York once per calendar day (`readiness.run`): every loan whose latest review verdict is `candidate` and every open refinance application with `prior_loan_id` on a monitored loan.
- `refi.opportunity.engaged` on a monitored loan (the homeowner's Yes on the OfferCard, or `refi.request` in words) → `refi.open`.
- `identity.verified`, `credit.report.received`, `verification.received{kind∈{income,assets}}`, `consent.captured`, `application.six_item.captured{item=ssn}` on a refinance application from a monitored loan → `readiness.check` for that loan in the same settlement.
- `partner_book.readiness.run_completed{as_of_date, checked, ready, not_ready, origination}` (global); `partner_book.readiness.checked{loan_id, party_id, application_id, as_of_date, ready, missing, origination}` (loan-scoped); `partner_book.refinance.opened{loan_id, application_id, party_id, opportunity_id, origination}`.

#### Data model
- **`readiness_checks`** (new; append-only): `id uuid pk`, `loan_id` → `loans`, `party_id` → `parties`, `application_id` → `applications` (null before the Yes), `as_of_date date`, `items jsonb` (one entry per item: `{item, status ∈ present|stale|missing|not_applicable, source_table, source_id, as_of, valid_until, rule_ref, refresh_via}`), `ready boolean`, `missing jsonb` (the items that are `missing` or `stale`, in the order they are asked), `decision_id uuid`, `created_at`. One row per loan per day and one on every triggering event.
- Baseline tables written: `applications` (+ the refinance application: `channel = refi_trigger`, `prior_loan_id` = the monitored loan, `transaction_type`, `occupancy`), `application_borrowers` (`party_id` linked), `application_properties` (the property with `estimated_value_cents` from the facts), `leads` (20.3's), `agent_decisions` (`readiness.check`, `refi.open`), `loan_events`, `timers`. Everything else is the owning processes': `verifications`, `credit_reports`, `consents`, `card_instances`, `du_casefiles`.

#### State machine
Per loan (`readiness_checks.ready`): `not_ready —(every required item present)→ ready`; an item moves `missing → present` on its event, `present → stale` when its `valid_until` passes, `stale → present` on a refresh. Per refinance: `candidate —(Yes)→ engaged —(refi.open)→ application open —(the last item lands; 32.18)→ du_ran`. The homeowner performs the taps; the platform performs every write.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_PARTNER_BOOK_READINESS_DAILY` | recurring | `partner_book.readiness.run_completed` | `as_of_date` | +1 calendar_days | `partner_book.readiness.run_completed` | sev 3 → `compliance-sentinel` (readiness was not checked today) |

Jurisdiction overrides: none.

#### Business rules and calculations
1. **The items.** `contact` (an e-mail and a phone on `parties.contact`), `account` (`partner_book.account.activated`), `esign` (`consents{kind=esign, status=active}` whose scope carries the origination disclosure classes), `credit_authorization` (a `hard_application` authorization on the refinance application's lead — 32.17 rule 20 writes it on the goal), `verification_authorization` (`consents{kind=blanket_verification_authorization, standing=true, status=active}`), `identity` (`verifications{kind=identity, outcome=verified}` on any of the party's applications with `valid_until` at or after the projected note date, else stale), `ssn` (`application_borrowers.tin_last4` on the refinance application, or `borrowers.tin_last4`), `credit` (a `credit_reports` row on the refinance application with `report_type` tri-merge, `state = usable`, `expires_at` at least 45 days after the as-of date, else stale), `income` (`verifications{kind=income}` with `vendor_data_as_of` within 120 days, or `income.validated` with a close-by date ahead), `assets` (`verifications{kind=assets, report_days=365}` within 120 days), `value` (the facts' newest value within 12 months, else stale), `insurance` (`insurance_policies{status=verified}` on the loan or the application, else missing), `payoff` (the facts' UPB as of the latest upload; `not_applicable` until the application exists). Required for `ready`: contact, account, esign, credit_authorization, identity, ssn, credit, income, assets, value. `insurance` and `payoff` are conditions after DU (23.2), not readiness.
2. **The daily check reads; it never orders.** Before the Yes the row shows what the party already has (from any earlier application on the platform and its consents) and what the partner's facts cover; nothing is requested, no vendor is called, no card is sent.
3. **The Yes opens the refinance application (`refi.open`).** On `refi.opportunity.engaged` for a monitored loan: `Runtime.createApplication` with `channel = refi_trigger`, the opportunity's transaction type and occupancy, `prior_loan_id` = the loan, the borrowers from `borrowers` and `parties` (name, contact, `tin_last4` and DOB when known), the property from `properties` with `estimated_value_cents` = the facts' value; `application_borrowers.party_id` linked; 20.3 `explainProgram{op=convert}`, 20.1 `emitOfferReady{op=converted}`, 21.1 `startInterview` and `captureField{credit_request}`; `confirmPrefill{op=offer}` for the name, the address, the value and the loan amount from the candidate terms; `partner_book.refinance.opened`. The application then receives what every application receives on `application.received` — the identity, payroll and assets connector cards (32.3 E5/R3, 32.18 rule 1) and the six-item cards — and the DU moment fires when the last prerequisite lands (32.18 rule 3). 32.11's `convert` defers to this tool for a monitored loan.
4. **The asks.** With the application open the readiness row is recomputed on every triggering event; the journey the turn reads carries `readiness {ready, missing[]}` and the current ask is the first missing item's card (identity → SSN → payroll → assets → the six items), so the assistant asks for exactly what is missing and nothing that is present (an identity verified on an earlier application within its validity is not asked again; a standing payroll connection is refreshed by 22.3's order, not re-asked — 32.11 §3).
5. **Freshness at closing is the owners'.** Once ready, 22.2's credit expiry clocks, 22.6's IAL2 gate and 22.3's close-by gate run on the application as they do for any file; this process stops writing rows for a loan whose application funded (30.x) or was withdrawn.

No money figure is computed here; every amount on the refinance application is the candidate's from 20.1 or the borrower's own.

#### Integrations
- None new. The owning processes' FAKEs answer their own cards; this process reads their rows.

#### Outputs and artifacts
- Rows: `readiness_checks`, the refinance `applications` row and its borrowers and property, `agent_decisions`.
- Events: `partner_book.readiness.run_completed`, `partner_book.readiness.checked`, `partner_book.refinance.opened`.
- The examiner's readiness report per partner: candidates ready, not ready by missing item, applications opened, DU runs reached.

#### AI agent design (AI-first)
`refi-readiness` agent (tools: `readiness.run`, `readiness.check`, `readiness.read`, `refi.open`). End-to-end: `readiness.run` is the daily pass over candidates and open refinance applications, one `readiness.check` per loan; `readiness.check` computes and writes the row and its decision; `readiness.read` serves the row to the console and the turn's situation; `refi.open` opens the refinance application on the homeowner's Yes and hands the file to 21.1 and the 32.x flows. Decision record schema `{loan_id, party_id, application_id, as_of_date, ready, missing, rule_set_version: partner_book.readiness.v1, model_version: deterministic, prompt_version: 33.3-v1, confidence: 1, rationale}`. Guardrails: never a vendor order, a consumer report or a card before the homeowner's Yes (`NO_PULL_BEFORE_YES`); never an application without the borrower's own engagement (`YES_REQUIRED`: the actor is the borrower's command or the resolved OfferCard); never a second open application on the same loan; never a figure the agent computed on the application (the candidate's and the borrower's only). Escalations: `compliance-sentinel` on a missed day; `ops_analyst` when an application cannot be opened (no party, no property).

#### Edge cases and failure modes
- A homeowner says Yes with no e-mail on file → the application opens; the cards are on the rail; the assistant asks for an e-mail on the contact card first.
- An identity verified on an earlier application has expired → `identity: stale`; the scan card is asked once more.
- The partner's next upload lowers the value → the check reads it the next morning; the application's value stays the candidate's until the borrower confirms a new one on its card.
- The homeowner withdraws → the application closes under 21.x; readiness rows stop; the loan returns to the daily review under the cooldown.
- Two Yes taps → one application (`refi.open` finds the open one and returns it).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 33.3-T1 | Given loan 1 a `candidate` on the day's review and no application, when the sweep passes at 07:15 ET, then one `readiness_checks` row exists for the loan with `ready = false`, `contact`, `account` (after the homeowner's first sign-in) and `value` present, `identity`, `ssn`, `credit`, `income`, `assets`, `esign` and `credit_authorization` missing, no vendor order, no card and no consumer report, `partner_book.readiness.checked` logged and `SM_PARTNER_BOOK_READINESS_DAILY` satisfied and re-armed. |
| 33.3-T2 | Given the homeowner of loan 1 taps Yes on the OfferCard, then `refi.open` creates one application with `channel = refi_trigger`, `prior_loan_id` = the loan, the party linked on `application_borrowers`, the property with the facts' value, 20.3's conversion, `refi.opportunity.converted` and `partner_book.refinance.opened` logged, the identity, payroll and assets connector cards and the six-item cards on the rail, and a second Yes creates nothing more. |
| 33.3-T3 | Given the open refinance application, when the homeowner completes the FAKE identity scan, types the SSN, connects Truv and Plaid on the FAKE and confirms the six items, then the readiness row is recomputed on each event, the missing list shrinks in order, `ready = true` once credit, income, assets, identity, ssn, esign and the hard-pull authorization are present, and 32.18's DU moment has run (`du.findings.received` on the application). |
| 33.3-T4 | Given an identity verified on an earlier application with `valid_until` before the projected note date, then `identity` reads `stale` and the scan card is asked again; given a standing payroll connection, then `income` is refreshed by 22.3's order and no payroll card is asked. |
| 33.3-T5 | Given the homeowner asks what is still needed, then the turn's situation carries `readiness{ready, missing}` and the reply names only the missing items in the copy library's words and points at the current card; given `ready = true`, then the reply says underwriting has what it needs and points at the checklist. |
| 33.3-T6 | Given a loan not a candidate, then no readiness row is written for it; given a funded refinance, then no further rows are written for that loan and the monitored loan reads `paid_off`. |

#### Audit and evidence
What an examiner is shown: per loan the readiness rows by date with each item's source row, as-of and validity; the application's creation event and decision; the verification rows the items point at; the timer history of the daily clock; the DU moment's own records (32.18). Exported through the console's partner-book view and the evidence pack.

### Open questions / decisions
1. Should the 120-day ages for payroll and asset reports be shorter for a close within 30 days? **Default: 120 days for readiness; the owners' closing gates decide at closing.**
2. Should a candidate be asked to connect Plaid and Truv before a Yes? **Default: no — nothing is asked before the Yes.**

### Sources
- spec/sections/22-*/22-2, 22-3, 22-4, 22-6; spec/sections/32-borrower-experience/32-11 §3–§5, 32-18 rule 3; db/migrations/0079, 0081, 0112; src/runtime/borrower/flows/11-rate-watch.ts convert; src/runtime/app.ts createApplication.
