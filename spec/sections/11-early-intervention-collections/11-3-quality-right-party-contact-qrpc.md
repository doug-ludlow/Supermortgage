# 11.3 — Quality Right Party Contact (QRPC)

| Attribute | Value |
|---|---|
| Section | 11 — Early Intervention & Collections |
| Automation class | c |
| SoR / Sub | Sub |
| Trigger & frequency | On delinquency |
| Governing source | FNMA D2-2-01 |
| Key deadlines | Per Fannie Mae timeline |
| Timers | `FNMA_D2202_CESSATION_ON_QRPC`, `FNMA_D2202_PTP_FOLLOWUP_30`, `FNMA_D2202_PTP_MAX_30`, `FNMA_D2204_BSP_AFTER_QRPC_3BD`, `FNMA_D2210_INSPECTION_SUSPEND_30`, `FNMA_F121_AW_ONE_MONTH`, `FNMA_LL202605_QRPC_REASON_REQUIRED`, `SM_LICENSED_NEGOTIATION_GATE`, `SM_QRPC_HUMAN_VERIFY_1BD`, `SM_QRPC_STALE_30`, `SM_THIRD_PARTY_AUTH_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Collections |
| Trigger & frequency | On delinquency |
| Governing source (blueprint) | FNMA D2-2-01 |
| Key deadlines (blueprint) | Per Fannie Mae timeline |
| Data/artifacts | QRPC record |
| Systems | SMDU |
| Automation class (blueprint) | c |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Source verified:** Fannie Mae Servicing Guide (Aug. 12, 2026 edition) D2-2-01 (11/14/2018), D2-2-02 (11/14/2018), A4-2.1-04 (12/16/2015), D2-2-04 (09/13/2017), D2-2-10 (05/10/2023), D2-1-01 (12/12/2018), F-1-21 delinquency status/reason codes (via Section 5.7, verified 2026-09-09), LL-2026-05 delinquency-event servicer action types (via 5.7/00b F4); Reg X comments 39(a)-2, -4, -5 (11.1); 12 CFR 1006.6(d)(1) third-party disclosure (11.4); GLBA/Reg P (12 CFR 1016) sharing with authorized third parties **[general knowledge — not re-fetched]**.

**D2-2-01 — the standard.** QRPC "is a uniform standard for communicating with the borrower, co-borrower, or a trusted advisor (collectively referred to as 'borrower') about resolution of the mortgage loan delinquency." The servicer "must make every attempt to achieve QRPC," and through QRPC must: (1) "determine the reason for the delinquency and whether it is temporary or permanent in nature"; (2) "determine the occupancy status of the property"; (3) "determine whether or not the borrower has the ability to repay the mortgage loan debt"; (4) "educate the borrower on the availability of workout options, as appropriate"; (5) "obtain a commitment from the borrower to resolve the delinquency." The topic contains no documentation format, no "SPOC" language and no explicit "intent to occupy/sell/vacate" element (the blueprint/task list's "intent" item is an industry enrichment — captured here as a sub-field of occupancy).

**D2-2-02 — how QRPC ends the cadence.** Outbound attempts stop when "QRPC is achieved and/or the borrower is adhering to a workout agreement," the delinquency is resolved, a complete BRP is received, the borrower "promises to pay the delinquent amount by a specified date" (≤30 days), or QRPC is achieved and the borrower "indicates no interest in a workout option"; every conversation must "emphasize the importance of making payments on or prior to their due dates."

**A4-2.1-04 — evidence.** "All contact attempts must be documented in the mortgage loan servicing file," and the servicer must "provide evidence to Fannie Mae that it satisfied the QRPC standard upon request"; foreclosure-prevention staff must be available during collection activity "unless collections staff are also well-versed in workout options" (the AI agent is, by construction, "well-versed": it reads `lossmit_facts`).

**Downstream Fannie Mae uses of the QRPC record (verified in the cited topics).** D2-2-04: QRPC without resolution → BSP (11.2). D2-2-10: monthly inspections may be suspended if "QRPC has been established within the last 30 days" (and the property is occupied). D2-3.2-01 forbearance and D2-3.2-02 repayment plans are QRPC-based (BRP not required; 12.4/12.5). D2-1-01: imminent-default evaluation starts from the borrower's reported hardship (11.5). LL-2026-01: the disaster foreclosure pre-referral approval request must state "borrower engagement/QRPC" (00a §3.2; 13.x). F-1-21 (legacy, until Mar. 15, 2027): status code **AW** "quality right party contact" (Level 5; "must only be reported for one month"; effective date = QRPC date) and the 3-digit **reason for delinquency code** (001 death of borrower … 006 curtailment of income … 016 unemployment … 019 casualty loss … 031 unable to contact borrower; INC incarceration) — 5.7 rule 3 requires the reason "captured in QRPC/loss-mit intake (Section 11/12)." LL-2026-05 event rail: servicer action type **"Quality Right Party Contact"** requires an existing **Delinquency Reason Type** (names such as "Borrower Declined to Provide a Reason," "Disaster Impact – FEMA-declared IA area," "Casualty Loss," "Property Problem" — mutually exclusive groups per 5.7) — informational flag if QRPC/outbound contact is missing at 2 periods delinquent (CD23 logic in 5.7).

**Reg X interplay.** A QRPC conversation is "live contact" (comment 39(a)-2) and the "if appropriate" loss-mitigation information (comment 39(a)-4) is element (4); contact through an authorized agent counts (comment 39(a)-5) with reasonable verification. Comment 39(a)-6: once a loss-mitigation application is in progress, ongoing §1024.41 contact substitutes for further live-contact efforts.

**Privacy/third parties.** Discussion of account details with a "trusted advisor" requires borrower authorization (GLBA/Reg P; FDCPA §805(b)/Reg F §1006.6(d)(1) for DC loans — no communication "in connection with the collection of any debt" with third parties other than the consumer, the consumer's attorney, a CRA, the creditor or their attorneys); Fannie Mae's "trusted advisor" language does not override these — an authorization (written, e-signed, or recorded oral consent during a three-way call where the borrower is verified) is required before NPI is shared.

**Discrepancies vs. blueprint row.** (1) "Systems: SMDU" is inexact — QRPC is not submitted to SMDU; it is reported to Fannie Mae through delinquency reporting (AMN AW code today; Servicing Platform "Quality Right Party Contact" action from 2027) and its data seeds SMDU workout cases (12.x). (2) "Per Fannie Mae timeline" = the D2-2-02 cadence (11.1) — there is no separate QRPC deadline; the operative dates are day 36 (start attempts), day 45 (BSP if no QRPC), 30-day recency for inspection suspension, and the pre-referral review (13.4). (3) Element (2) is occupancy *status*, not intent; intent is captured as an enrichment. (4) Class "c" is re-rated AI-first with the `live_contact.ai_voice_counts` flag and human verification (11.1).

### Operational prerequisites
- 11.1 Contact Engine and telephony stack live; `borrower-comms` collections-mode prompt and evaluation suite (QRPC element capture accuracy ≥95 % vs human-labeled transcripts; prohibited-statement rate 0) approved under the LL-2026-04 program.
- `lossmit_facts` view (4.3) and `rule_sets.fnma.workout_hierarchy` (Exhibit F-2-10 order) populated; Form 710 hardship taxonomy and the F-1-21 reason-code map loaded as `rule_sets.fnma.qrpc.reason_map.v1` (LL-2026-05 reason-type names added when the CIT schema is received — **[PARTIALLY VERIFIED names]**).
- Third-party authorization form (`FRM_SM_THIRD_PARTY_AUTH`, e-signable) and the recorded-consent script; housing-counselor authorization handling.
- Human collections/loss-mitigation queue (`human_agent`) and `licensed_specialist` roster by state (baseline §8 item 7).
- 5.7 event/AMN mapping consuming `contact.qrpc.established`; 12.x consuming `lossmit.assistance.requested` and `qrpc_records`.
- Partner sign-off on the QRPC script, the promise-to-pay policy and the reason-code mapping.

### Build spec
#### Inputs and triggers
- Any verified conversation: `contacts{outcome ∈ conversation}` from outbound AI/human calls, inbound calls, chat, portal "I need help" flow, or a housing counselor/attorney call with authorization.
- `contact.qrpc.established` (emitted when the record is complete — the trigger for D2-2-02 cessation, 11.2 BSP, 5.7 reporting, 12.x intake, D2-2-10 suspension).
- `borrower.promise_to_pay.recorded/kept/broken`; `lossmit.brp.received/complete` (12.1); `lossmit.plan.active/failed`; `payment.applied` (resolution).
- `party.authorization.received/verified/expired`.
- Schedules: nightly `qrpc.staleness` (policy: QRPC older than 30 days with no resolution → re-establish), pre-referral review request (13.4) reading the latest QRPC.

#### Data model
- `qrpc_records` (new): `id`, `loan_id`, `contact_id`, `party_id`, `party_role` ∈ {borrower, co_borrower, trusted_advisor, authorized_third_party, confirmed_successor, bk_counsel}, `authorization_id` (required unless borrower/co-borrower/successor), `achieved_at timestamptz`, `channel` (`contacts.mode`), `conducted_by` ∈ {ai_agent, human_agent, ai_with_human_join}, `live_contact_counted bool` (per flag), `human_verified_by`, `human_verified_at`, `reason_primary` (Form 710 taxonomy: unemployment, reduction_in_income, increase_in_expenses, disaster, disability_or_illness, divorce_or_separation, separation_unmarried, death_of_borrower_or_wage_earner, distant_employment_transfer, business_failure, excessive_obligations, property_problem, inability_to_sell_or_rent, military_service, incarceration, payment_dispute, servicing_problem, other, declined), `reason_secondary text[]`, `reason_narrative text` (borrower's words, ≤500 chars), `fnma_reason_code char(3)`, `fnma_reason_type text` (event rail), `hardship_nature` ∈ {temporary, permanent, unknown}, `hardship_started_on date`, `hardship_expected_end_on date`, `occupancy_status` ∈ {borrower_occupied_principal, second_home, tenant_occupied, vacant, unknown}, `occupancy_intent` ∈ {retain, sell, vacate_or_surrender, undecided}, `ability_to_pay` ∈ {can_pay_now, can_pay_by_date, can_pay_partial, cannot_pay, unknown}, `stated_monthly_income_cents bigint?`, `stated_monthly_expenses_cents bigint?`, `stated_surplus_cents bigint?`, `can_resume_full_payment_on date?`, `options_explained jsonb` ({option, one_line_text, lossmit_facts_version}), `payment_importance_emphasized bool` (D2-2-02), `commitment_kind` ∈ {promise_to_pay_full, promise_to_pay_partial, brp_submission, forbearance_request, repayment_plan_request, deferral_request, modification_request, liquidation_request, no_interest, refused, callback_only}, `promise_id`, `next_action`, `next_action_due_on`, `resolution_status` ∈ {none, ptp_pending, workout_in_progress, resolved}, `transcript_document_id`, `decision_id`, `fnma_reported_event_id`, `superseded_by`. Append-only; corrections are new rows with `superseded_by` back-links.
- `promises` (new): `id`, `loan_id`, `party_id`, `qrpc_id`, `amount_cents bigint`, `covers` ∈ {full_delinquent_amount, partial}, `due_on date` (≤ recorded date + 30), `method` ∈ {ach_scheduled, portal, phone_pay, mail, other}, `status` ∈ {open, kept, partial, broken, cancelled}, `payment_ids uuid[]`.
- `parties` (baseline) additions: `authorization_document_id`, `authorization_scope` ∈ {discuss_only, receive_documents, negotiate}, `authorization_verified_at`, `authorization_expires_at`, `counselor_agency_id` (HUD agency id where applicable).
- `contacts.qrpc` (baseline boolean) is set only when a `qrpc_records` row exists for the contact.
- PII: income/expense statements encrypted; retention `life_of_loan_plus_4y`.

#### State machine
Per conversation: `verified_conversation → elements_capturing → qrpc_complete | conversation_only (missing elements) → (if flag off) pending_human_verification → qrpc_verified | qrpc_rejected (human call task)`. Per loan QRPC status: `none → achieved{achieved_at} → stale (30 days, policy) → re_established | resolved (payment/plan) | superseded (new QRPC)`. Guards: `qrpc_complete` requires all five element groups non-null (reason may be `declined`; commitment may be `no_interest`/`refused`), `payment_importance_emphasized=true`, and a verified party with authority; `contact.qrpc.established` fires on `qrpc_complete` (flag on) or `qrpc_verified` (flag off).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_D2202_CESSATION_ON_QRPC` | rule | `contact.qrpc.established` | — | plan → `ceased{qrpc_workout | qrpc_no_interest | ptp_pending}` or stays `active` if commitment is partial/callback-only | — | — |
| `FNMA_D2202_PTP_MAX_30` | validation | `promise.recorded` | recorded date | `due_on ≤ +30 calendar_days` for a cadence-ceasing promise | — | promise accepted but cadence continues (partial/late promises) |
| `FNMA_D2202_PTP_FOLLOWUP_30` | (11.1) | | | | | |
| `FNMA_D2204_BSP_AFTER_QRPC_3BD` | (11.2) | | | | | |
| `SM_QRPC_HUMAN_VERIFY_1BD` | deadline | `qrpc_complete` while `live_contact.ai_voice_counts=false` for the loan, or sampled (≥10 %) | achieved_at | 1 `business_days_servicer` | `qrpc_verified` or `qrpc_rejected` (with human call task) | sev-3; supervisor queue |
| `SM_QRPC_STALE_30` | recurring (policy) | `contact.qrpc.established` with `resolution_status ∈ {none, ptp_pending→broken}` | achieved_at | +30 `calendar_days` | new QRPC, plan active, or resolution | plan re-activated; informational |
| `FNMA_D2210_INSPECTION_SUSPEND_30` | informational gate (owned by 9.x/13.x) | `contact.qrpc.established` with occupied property | achieved_at | +30 `calendar_days` | — | inspection scheduler reads it |
| `FNMA_F121_AW_ONE_MONTH` | (5.7) | | | | | |
| `FNMA_LL202605_QRPC_REASON_REQUIRED` | validation | QRPC action event build (5.7) | — | reason type present | — | event refused at build; `default-collections` supplies `declined` or `unable_to_contact` |
| `SM_THIRD_PARTY_AUTH_GATE` | gate | conversation with `party_role ∈ {trusted_advisor, authorized_third_party}` | — | valid unexpired authorization or in-call recorded consent | — | NPI withheld; general information only |
| `SM_LICENSED_NEGOTIATION_GATE` | gate | any discussion of modification terms | — | `jurisdiction_rules.mlo_licensing_for_lossmit=false` or `licensed_specialist` on the call | — | AI declines to negotiate; warm transfer |

`jurisdiction_overrides`: `mlo_licensing_for_lossmit` (state-keyed, from 00a §5.1 — load per counsel matrix); `ai_disclosure_script`; `call_recording_two_party`.

#### Business rules and calculations
1. **Completeness test.** QRPC is achieved only when the five D2-2-01 elements are captured from a verified borrower/co-borrower/authorized party in one or more conversations within the same 7-day cycle: (1) `reason_primary` + `hardship_nature`; (2) `occupancy_status` (+ `occupancy_intent` enrichment); (3) `ability_to_pay` (with at least one of `can_resume_full_payment_on`, `stated_surplus_cents` or `commitment_kind`); (4) `options_explained` non-empty **or** a recorded determination that options were not appropriate (comment 39(a)-4: e.g., full payment promised by a date) — the D2-2-01 phrase is "as appropriate"; (5) `commitment_kind ≠ callback_only`. Missing any → `conversation_only`; the next attempt targets the missing elements.
2. **Reason mapping.** `rule_sets.fnma.qrpc.reason_map.v1`: unemployment → 016; reduction_in_income → 006 (curtailment of income); increase_in_expenses/excessive_obligations → 007; death_of_borrower_or_wage_earner → 001 (borrower) / 004 (family member); disability_or_illness → 002 (borrower) / 003 (family member); divorce_or_separation, separation_unmarried → 005; distant_employment_transfer → 009; business_failure → 017; disaster → 019 (casualty loss) or 011 (property problem) per the facts (event rail: "Disaster Impact – FEMA-declared IA area" when the property is in a declared IA county, else "Casualty Loss"; mutually exclusive with "Property Problem"); property_problem → 011; inability_to_sell → 012; inability_to_rent → 013; military_service → 014; incarceration → INC; payment_dispute → 027; servicing_problem → 023; other → 015; declined → 015 with reason type "Borrower Declined to Provide a Reason" on the event rail; no QRPC at all → 031 (unable to contact) — set by 5.7, not by this process. The reason code is frozen after first report and changes only with a new borrower statement (5.7 rule 3).
3. **Promise-to-pay.** A cadence-ceasing promise must cover the full delinquent amount as of the promise date (past-due installments + late charges + fees as read from the ledger; the AI reads and states the figure) and be due within 30 days; partial or later promises are recorded (`covers=partial`) and the plan schedules the next attempt for `due_on + 1`. Worked example: on 2026-12-11 the loan owes 2 × $2,000.00 + late charges 2 × $82.50 = **$4,165.00**; the borrower promises $4,165.00 by 2026-12-28 → `FNMA_D2202_PTP_MAX_30` valid (17 days), plan `ceased{ptp_pending}`; `payment.applied` totals of ≥ $4,165.00 by 2026-12-28 → `kept`; $2,000.00 → `partial`, plan resumes 12-29; the borrower's ACH is scheduled in-call through 2.x with Reg E authorization.
4. **Trusted advisor / third party.** With a valid authorization (`authorization_scope ≥ discuss_only`) the party may complete QRPC on the borrower's behalf; the record's `party_role` and `authorization_id` are set; a three-way call in which the verified borrower orally authorizes the advisor (recorded) creates a `discuss_only` authorization for 90 days. Bankruptcy counsel is presumed authorized (Reg X comment 39(c)-1 logic) for information exchange, and communications with a represented debtor route through counsel (14.x).
5. **Staleness.** A QRPC with no resolution after 30 days is "stale" for cadence purposes (the plan re-activates unless a workout is in progress) and for the 13.4 pre-referral review, which reads the latest QRPC (or its absence) and the reason.
6. **Human verification.** When `live_contact.ai_voice_counts=false` for the loan (or on the sampling schedule), a `human_agent` reviews the transcript and schema within 1 BD: `qrpc_verified` (record stands, `human_verified_by` set) or `qrpc_rejected` (specific element(s) flagged; a human call task is created and the contact is not reported as QRPC). Verification never alters the AI's captured statements; corrections are new rows.
7. **Reporting.** `contact.qrpc.established` → 5.7: legacy AW status (effective = `achieved_at` date, once, Level 5 unless a higher-level code applies) + reason code; event rail: `Quality Right Party Contact` with the reason type (and `Outbound Contact Attempted` events for each attempt from 11.1). One QRPC per loan per month is reported even if several conversations occur.

#### Integrations
| Counterparty | Direction | Interface | Notes |
|---|---|---|---|
| Telephony/voice (11.1) | in/out | adapter | Conversation, recording, transcript, warm transfer, three-way authorization calls |
| Loss mitigation (12.x) / SMDU | out | internal event `lossmit.assistance.requested{qrpc_id}`; SMDU case fields populated by 12.x from `qrpc_records` (hardship reason, hardship start, occupancy, imminent-default indicator) | No direct SMDU submission from 11.3; SMDU B2B spec is portal-gated (00b F1) **[UNVERIFIED field names]** |
| Fannie Mae delinquency reporting (5.7) | out | events / AMN file | AW code + reason code; event-rail QRPC action with reason type |
| Property inspections (9.x/13.x) | out | internal | `FNMA_D2210_INSPECTION_SUSPEND_30` signal |
| Foreclosure pre-referral (13.4) and LL-2026-01 disaster package (13.x) | out | internal | latest QRPC summary, reason, occupancy, intent |
| Case intake (4.1/4.5) | out | internal | disputes/complaints raised during QRPC open cases |
| Cashiering (2.x) | out | commands | in-call payment scheduling with Reg E authorization |

#### Outputs and artifacts
- `qrpc_records`, `promises`, `parties` authorizations, `contacts.qrpc=true`, `agent_decisions`; the blueprint "QRPC record" = `qrpc_records` + `v_qrpc_evidence` (record + transcript excerpt per element + timestamps) exported on Fannie Mae request.
- Notices: `NTC_SM_QRPC_SUMMARY` (post-call confirmation on a consented channel: what was discussed, next steps, promise details, how to apply — never a demand in bk/fdcpa-cease contexts); `FRM_SM_THIRD_PARTY_AUTH`.
- Investor events: `delinquency.servicer_action{Quality Right Party Contact}` and legacy AW.
- No ledger postings (payments are 2.x).

#### AI agent design (AI-first)

**Conversation design (`borrower-comms`, collections mode — outbound or inbound).**
1. *Open & disclose* (0–20 s): identity of Supermortgage (and the master servicer where branding requires), automation disclosure ("I'm an automated assistant; say 'representative' at any time"), recording disclosure, DC-loan §1006.18(e) disclosure after verification (before, only limited-content wording).
2. *Verify* (two factors; on outbound to an unverified answerer for a DC loan: no debt reference; for non-DC loans: no account detail until verified). Unverified → schedule/limited message; end.
3. *Why we're calling / how can we help*: state the delinquency plainly (amount and "as of" date from the ledger), emphasize the importance of paying on or before the due date (D2-2-02), then open-ended hardship discovery ("What's made it hard to keep up with the payment?").
4. *QRPC element capture* with a structured extractor running alongside the dialog: reason (+ start date, temporary/permanent), occupancy (+ intent), ability to pay (income/expense estimates offered voluntarily; the AI never demands financial details for QRPC), and the borrower's own words in `reason_narrative`. Sensitive-topic handling: death, illness, divorce, disaster, military → empathetic scripts, no probing beyond what the elements require, offer the human option.
5. *Educate "as appropriate"*: if the borrower can pay in full by a date → confirm the promise, no options pitch; else read the generic option list from `lossmit_facts` (retention first, then disposition), explain the application path (Form 710/portal), the evaluation timeline and that not everyone qualifies; never state eligibility, terms, or foreclosure timing not in `lossmit_facts`; for streamlined options the rule set delegates (forbearance ≤3-month increments under LL-2026-01; repayment plan ≤12 months), the AI may collect the request and, where 12.4/12.5 returns an in-call decision, present the offer with the required disclosures — adverse outcomes are never announced in-call (they go through `lossmit_reviewer`, 12.x); in states where offering/negotiating terms is licensed activity, the AI stops at intake and warm-transfers to `licensed_specialist`.
6. *Commitment*: promise-to-pay (amount/date/method, ACH scheduling), BRP submission (send/upload; 11.2 BSP), workout request (12.x), or "no interest"/"refused" — all valid QRPC outcomes; capture `next_action`.
7. *Close*: read back the summary (elements + commitments), confirm the preferred channel and time windows, send `NTC_SM_QRPC_SUMMARY`, log.
8. *Triggers to human* (immediate warm transfer): request for a person/supervisor, dispute of the debt/amount ("that's not right" → also opens 4.1 intake), bankruptcy or attorney mention, threats/self-harm/abuse language, language not supported, three comprehension failures, any request the policy marks human-only (e.g., deceased borrower's family, SCRA claims), or the `human_only` preference.

**Tools:** `identity.verify`, `disclosure.play`, `ledger.balances`, `payments.history`, `lossmit_facts.get`, `qrpc.capture` (structured output, validated against the schema), `promise.record`, `payment.schedule` (2.x), `lossmit.request.create` (12.x), `lossmit.streamlined.evaluate` (12.4/12.5, delegated), `authorization.record`, `preference.set`, `dispute.intake` (4.1), `human.transfer`, `contact.log`, `decision.record`.

**Decision record (per conversation):** `{contact_id, qrpc_record_id?, elements{reason:{value, evidence_span}, nature, occupancy, intent, ability, options_explained[], commitment}, options_source_version, statements_made[], prohibited_statement_scan{result, spans}, disclosures{ai_at, recording_at, fdcpa_at}, transfers[], confidence_per_element, model_version, prompt_version, rule_set_versions}`. Evidence spans link each captured element to transcript timestamps (Fannie Mae "evidence upon request").

**Guardrails:** no eligibility or approval statements; no threats (§1006.18(c)); no discussion with unverified/unauthorized third parties; no financial-detail demands; no negotiation where licensed; the extractor must cite transcript evidence for every element (hallucinated elements fail validation and downgrade the call to `conversation_only`); QRPC is never marked from a voicemail, SMS-only exchange or chatbot session without a verified two-way dialog (SMS/chat QRPC allowed only with verified identity and all elements — policy default: allowed for chat/portal, not for SMS).

**Escalation package:** transcript so far, captured elements, ledger snapshot, `lossmit_facts`, reason for transfer; the human continues in the same record. **AI-off path:** human agents use the same schema in the ops console (mandatory fields), with the same extractor QA on their notes.

#### Edge cases and failure modes
- **Co-borrower only**: counts (D2-2-01 "co-borrower"); record `party_role=co_borrower`; the primary borrower's separate promise is not required.
- **Trusted advisor without authorization**: general information and the authorization form only; no QRPC; log `answered_unverified_third_party`.
- **Borrower declines to give a reason**: QRPC achieved if the other elements are captured; `reason_primary=declined`, event-rail "Borrower Declined to Provide a Reason," legacy 015 with a note.
- **Multiple hardships**: primary = the one the borrower identifies as main; secondaries stored; disaster reason exclusivity enforced on the event rail.
- **Temporary vs permanent unknown**: `unknown` allowed; the 12.x evaluation resolves it; not a QRPC blocker (D2-2-01 asks the servicer to "determine" — recorded as undetermined with rationale).
- **Bankruptcy**: no direct QRPC with a represented debtor; QRPC via counsel or per 14.x court/permission rules; reporting uses bankruptcy Level 3 codes, AW suppressed.
- **FDCPA cease (DC loan)**: no outbound QRPC attempts; inbound borrower-initiated conversations may complete QRPC (2016 safe harbor for borrower-initiated loss-mitigation communications).
- **SCRA**: military hardship → reason 014; Form 180/military-indulgence path (D2-3.4-01) offered.
- **Deceased borrower**: no QRPC until a successor/estate representative is identified (4.4); reason 001 recorded from the notification.
- **Dispute raised**: 4.1 intake + 11.4 dispute handling; QRPC may still complete if elements are captured.
- **Disaster**: QRPC captures disaster impact and property condition; 12.4/12.7 forbearance/deferral paths; reason type exclusivity.
- **Transfer-in**: prior-servicer QRPC records boarded with dates (1.7) but a fresh QRPC is sought within the first cycle (policy).
- **Transfer-out**: `qrpc_records`, `promises`, authorizations in the transfer file (17.x).
- **Model failure / low confidence** (<0.8 on any element): the AI re-asks once, then marks `conversation_only` and schedules a human follow-up.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 11.3-T1 | Given a verified AI conversation capturing all five elements with transcript evidence, when the flag is on, then `qrpc_records` is created, `contacts.qrpc=true`, `contact.qrpc.established` fires, the 11.1 plan ceases (per commitment), and 5.7 receives AW/QRPC with reason code. |
| 11.3-T2 | Given the borrower hangs up after giving the reason and occupancy only, then the record is `conversation_only`, no QRPC event fires, and the next attempt targets ability/commitment. |
| 11.3-T3 | Given the reason "lost my job in October," then `reason_primary=unemployment`, `fnma_reason_code=016`, `hardship_started_on=2026-10-xx`, nature per borrower's statement. |
| 11.3-T4 | Given a promise of $4,165.00 by 2026-12-28 recorded 2026-12-11, then `FNMA_D2202_PTP_MAX_30` passes and the plan is `ceased{ptp_pending}`; given a promise of $2,000.00, then `covers=partial` and the plan schedules the next attempt for 2026-12-29. |
| 11.3-T5 | Given a caller claiming to be the borrower's sister with no authorization, then no account details are disclosed, the authorization form is offered, and no QRPC is recorded. |
| 11.3-T6 | Given a three-way call where the verified borrower authorizes a HUD counselor, then a 90-day `discuss_only` authorization is recorded and the counselor may complete QRPC. |
| 11.3-T7 | Given the flag is off for the state, then the AI record is `pending_human_verification`, `SM_QRPC_HUMAN_VERIFY_1BD` runs, and only `qrpc_verified` emits `contact.qrpc.established`. |
| 11.3-T8 | Given QRPC on 2026-10-20 with no resolution, then the November delinquency file shows AW effective 20261020 with reason 016 (5.7 example) and AW is not repeated in December. |
| 11.3-T9 | Given a borrower who says "I'll pay it all Friday," then no options pitch is required (comment 39(a)-4 logic recorded), the promise is captured, and the options-explained determination is `not_appropriate:full_payment_promised`. |
| 11.3-T10 | Given the borrower asks "what rate would a modification give me?" in a state with `mlo_licensing_for_lossmit=true`, then the AI declines to quote terms and warm-transfers to `licensed_specialist`; the transcript shows no terms. |
| 11.3-T11 | Given a disaster hardship in a FEMA IA county, then the event-rail reason type is "Disaster Impact – FEMA-declared IA area" and "Property Problem" is not also set. |
| 11.3-T12 | Given QRPC achieved 2026-12-11 and no resolution by 2027-01-10, then `SM_QRPC_STALE_30` re-activates the plan and 13.4's pre-referral review shows QRPC age 30+ days. |
| 11.3-T13 | Given the extractor proposes `ability_to_pay=can_pay_by_date` with no transcript evidence span, then validation fails and the record is `conversation_only`. |
| 11.3-T14 | Given a Chapter 13 debtor represented by counsel calls in, then the AI verifies, confines the discussion to information counsel permits per 14.x rules, and no QRPC is recorded without counsel's involvement. |

#### Audit and evidence
`qrpc_records` with evidence spans and transcript hashes; `promises` lifecycle; authorizations with documents; decision records per conversation (elements, confidence, prohibited-statement scan); human-verification records; the Fannie Mae evidence pack (per loan: QRPC date/channel/party, elements, options explained, commitment, attempts before QRPC); reporting reconciliation (QRPC records vs AW/QRPC events sent); LL-2026-04 monitoring dashboards (element accuracy audits, transfer rates, complaint rates).

### Open questions / decisions
1. **11.3-Q1 QRPC over chat/portal.** Default: allowed with verified identity and all elements; SMS-only never.
2. **11.3-Q2 In-call streamlined offers.** Default: the AI may present a 12.4 forbearance or 12.5 repayment plan offer returned by `lossmit-underwriter` within delegated authority (LL-2026-01 limits), except in licensed-negotiation states; adverse outcomes never in-call.
3. **11.3-Q3 Staleness horizon.** Default 30 days (aligns with D2-2-10 and pre-referral practice).
4. **11.3-Q4 Third-party oral authorization validity.** Default 90 days, `discuss_only`.
5. **11.3-Q5 Financial statements during QRPC.** Default: accept volunteered figures, never require them (BRP is the documented path).

### Sources
- Fannie Mae D2-2-01 (11/14/2018): https://servicing-guide.fanniemae.com/svc/d2-2-01/achieving-quality-right-party-contact-borrower — verified 2026-09-09
- D2-2-02 (11/14/2018): https://servicing-guide.fanniemae.com/svc/d2-2-02/outbound-contact-attempt-requirements — verified 2026-09-09
- A4-2.1-04 (12/16/2015): https://servicing-guide.fanniemae.com/svc/a4-2.1-04/establishing-contact-borrower — verified 2026-09-09
- D2-2-04 (09/13/2017), D2-2-10 (05/10/2023), D2-1-01 (12/12/2018) — URLs in 11.2/11.5 — verified 2026-09-09
- F-1-21 codes and LL-2026-05 delinquency-event action/reason types: sections/05-investor-reporting-remittance.md §5.7 (verified 2026-09-09); research/00b-integration-landscape.md F1, F4, F8
- Reg X comments 39(a)-2, -4, -5, 39(c)-1: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024 — verified 2026-09-09
- 12 CFR 1006.6(d)(1): https://www.ecfr.gov/current/title-12/chapter-X/part-1006/subpart-B/section-1006.6 — verified 2026-09-09
- GLBA / Reg P (12 CFR 1016) third-party sharing — **[general knowledge, not re-fetched]**
