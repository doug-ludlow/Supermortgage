# 32.13 — Cross-cutting: acceptance harness, copy library rules, side-quest catalogue

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | a — the harness runs against the `api` command handlers with the real Timer Engine and Notice Registry; no UI-only mock of regulatory behaviour |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On every build stage (README §Closing); on every commit of the copy library |
| Governing source | Projection of sections the build-spec tests each UI test depends on (mapping under Audit and evidence); the copy strings themselves live in copy-library.md and are not units |
| Key deadlines | none owned |
| Timers | — |

### Blueprint row
Projection of sections the build-spec tests each UI test depends on (mapping under Audit and evidence); the copy strings themselves live in copy-library.md and are not units. Per-screen tests live in their files (32.3 §7, 32.4 §7, 32.5 §9, 32.6 §8, 32.7 §7, 32.8 §8, 32.9 §7, 32.10 §10, 32.11 §8, 32.12 §5). This file defines the harness, the fixtures, the cross-cutting tests, and the mapping to build-spec test IDs. Every test is Given/When/Then and runs against the `api` command handlers with the real Timer Engine and Notice Registry — no UI-only mocks of regulatory behavior. Every string the borrower reads from the assistant or on a card is keyed here; the UI never hard-codes sentences. Regulatory **notices keep their template text** (Notice Registry) — this library holds the assistant's accompanying lines and card labels only. Tokens per 32.1 §7.4. Grade-8 reading level. Where a channel variant is not given, SMS uses the first sentence plus the deep link; e-mail uses the full text plus the CAN-SPAM footer when marketing. Format: `key` — **card/message** — text — *notes*. A side quest is a self-contained detour: a **trigger** (an event or a borrower answer), an **entry card**, a short **sequence**, the **evidence** it must leave, and a **return point** in the main flow. Side quests never restructure the happy path; they add items to Needed-from-you and messages to the Thread. IDs are stable and referenced from files 03–10. Format: **Trigger** · **Entry** · **Sequence** · **Evidence** · **Return** · **Spec**. (Imported from docs/ux/13-acceptance-tests.md, 12-message-copy-library.md, 11-side-quests-catalogue.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 13, 12, 11 is 32.13 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections the build-spec tests each UI test depends on (mapping under Audit and evidence); the copy strings themselves live in copy-library.md and are not units** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: none — the cross-cutting tests restate binding rules of 32.1 and 32.2.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On every build stage (README §Closing); on every commit of the copy library. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `applicant_demographics`, `application_assets`, `compliance_test_runs`, `consent_disclosure_versions`, `credit_authorizations`, `ctc_checklists`, `debt_payoff_plans`, `declarations`, `document_requests`, `documents`, `du_findings_interpretations`, `gift_records`, `payoff_quotes`, `prequalifications`, `pricing_quotes`, `refi_opportunities`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `SM_AI_INTERACTION_DISCLOSURE_GATE` (20.3), `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` (20.4), `SM_LOCK_EXPIRY_WARN_7` (21.4), `REGZ_1026_19E4_REVISED_LE_4SBD_GATE` (21.5), `REGZ_1026_19F2V_TOLERANCE_REFUND_60` (21.5), `SM_DU_CONDITIONS_SLA_4H` (23.2), `FNMA_B3_3_2_01_PAYSTUB_30D_GATE` (22.1), `FNMA_B1_1_03_CREDIT_DOCS_4M` (22.1), `SM_DOC_EXPIRY_WARN_14` (22.1), `SM_O21_JOINT_INTENT_GATE` (21.1), `REGB_1002_9_COUNTEROFFER_90` (21.6), `REGB_1002_14_APPRAISAL_COPY_3BD_GATE` (24.2), `FDPA_4104A_FLOOD_NOTICE_GATE` (24.5), `SM_UW_CTC_GATE` (23.3), `REGZ_1026_19F1III_CD_MAILBOX_3SBD` (25.2), `REGZ_1026_19F1_CD_3SBD_GATE` (25.2), `REGZ_1026_23_RESCISSION_3SBD_GATE` (25.3), `REGZ_1026_23D2_RESCISSION_REFUND_20` (25.3), `FNMA_B2_1_5_FIRST_PAYMENT_2M` (26.3), `SM_O64_FIRST_PAYMENT_LETTER_5BD` (25.4), `NOTE_6A_LATE_CHARGE_GRACE_GATE` (2.7), `SM_LATE_CHARGE_ASSESS_1CD` (2.7), `NACHA_NSF_REINITIATION_180_MAX2` (2.3), `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` (2.3), `REGX_1024_37C_FPI_FIRST_NOTICE_45` (9.2), `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15` (9.2), `REGX_1024_37G_FPI_CANCEL_REFUND_15` (9.5), `REGZ_1026_36C3_PAYOFF_STMT_7BD` (7.6), `REGX_1024_39A_LIVE_CONTACT_36` (1.1), `REGX_1024_41G_DUAL_TRACK_GATE` (13.2), `REGX_1024_41E1_ACCEPT_14` (12.2), `REGX_1024_41F1_120_DAY_GATE` (1.7), `FNMA_C1_1_01_PREMIUM_RECAPTURE_120` (20.1), `TCPA_64_1200_A2_PEWC_GATE` (20.2), `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` (3.5), `SM_O71_DOC_GEN_GATE` (26.1), `SM_AUTODRAFT_COPY_DELIVERY_1BD` (2.3), `REGZ_1026_35B1_HPML_ESCROW_GATE` (23.4), `REGX_1024_33C1_LATE_FEE_PROTECTION_60` (1.3), `SM_IDENTITY_IAL2_GATE` (22.6), `REGZ_1026_19E2_INTENT_FEE_GATE` (21.4), `SM_QUOTE_VALIDITY_GATE` (20.4), `SM_O61_COMPLIANCE_PASS_LOCK_GATE` (25.1), `FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE` (20.3), `SM_LEAD_INACTIVITY_EXPIRY_90` (20.3), `REGB_1002_2F_NO_PREQUAL_DECLINE_GATE` (20.3), `FNMA_B3_3_1_04_VVOE_10BD` (22.3), `FNMA_B3_3_1_04_VVOE_ALT_15BD` (22.3), `SM_TRUST_POA_REVIEW_GATE` (24.4), `FNMA_B2_1_3_03_TITLE_SEASONING_6M` (20.1), `SM_UW_DECISION_VALIDITY` (23.3), `FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M` (22.2), `FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M` (20.1), `FCRA_605A_H_ALERT_CONTACT_GATE` (22.6), `FNMA_B3_3_1_02_4506C_VALID_120` (22.3), `FNMA_B3_3_1_04_SE_VERIFY_120` (22.3), `SM_O72_RON_STATE_AUTH_GATE` (26.2), `SM_O72_PAPER_FALLBACK_5BD` (26.2), `TX_50A6_RESCISSION_3D_GATE` (26.1).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### Acceptance harness — 1. Harness

- **Contract tests** (`api`): serializer allow-lists (no DU/credit/fraud/QC fields in any `/v1/borrower/*` response), gate errors (`{code, gate, copy_key}`), idempotency (`card_instance_id`), party scoping.
- **Component tests** (`borrower-app`): every card kind renders from its schema; state transitions update in place; keyboard operability; `aria-live` announcements; dark-token contrast checks (axe).
- **End-to-end** (Playwright): the three happy paths on the fixture calendar; the servicing scenarios; both breakpoints (1280 and 390 px); voice simulated through the telephony adapter's sandbox; SMS/e-mail through the adapters' sandboxes with deep-link resolution.
- **Copy tests**: string assertions over copy-library.md (forbidden words: "guarantee", "pre-approved" outside `preapproval.*`, "you don't qualify", "denied" outside decision notices, "skip a payment", "Fannie Mae" outside `boarding.fannie_letter` and notice templates); reading-level check ≤ grade 8 on every non-template string.
- **Timer tests**: assert `timers.due_at` values from the fixture calendar; the UI renders exactly the allow-listed codes (32.2 §4) with their labels.

##### Acceptance harness — 2. Fixtures (from the build specs)

- **Refinance fixture** — Phoenix, AZ (America/Phoenix, no DST); $560,000 limited cash-out; 30-year fixed 6.125%; 1-unit primary; escrowed; no MI; eNote-eligible; application Mon Oct 19–Tue Oct 20, 2026 window; CD delivered Mon Nov 2; consummation Fri Nov 6; disbursement Thu Nov 12 (§21–§26 worked examples).
- **Purchase fixture** — Franklin County; $457,800 price; $412,000 HomeReady 30-year fixed 6.375%; two borrowers; application Mon Oct 19, 2026; note date Wed Nov 18, 2026 (22.5 R7).
- **Offer fixture** — 20.2 worked example: portal enrollment Oct 2025; e-mail offer Fri Oct 2, 2026 09:05 MST; PEWC captured Sat Oct 3 08:12; response Mon Oct 5 08:40 → `lead.created`.
- **Holidays** — Columbus Day Oct 12, Veterans Day Nov 11, Thanksgiving Nov 26, Christmas Dec 25, 2026; New Year's Day Jan 1, 2027 (observed) — creditor and servicer calendars; Reg Z specific calendar = all days except Sundays and federal holidays.
- **Servicing fixture** — payment due Sep 1, 2026; grace 15 days; delinquency day 1 = Sep 2 (4.3-T1); statement cycle 7.1 fixture (Oct 17 posting; Nov 1 due).

##### Acceptance harness — 4. Index of per-file tests

| File | Tests | Count |
|---|---|---|
| 03 Entry and qualification | 32.3-T1 … 32.3-T30 | 30 |
| 04 Disclosures, intent, lock | 32.4-T1 … 32.4-T10 | 10 |
| 05 Verification, conditions, co-borrowers | 32.5-T1 … 32.5-T11 | 11 |
| 06 Decision, property, title, insurance, MI | 32.6-T1 … 32.6-T12 | 12 |
| 07 CD, closing, rescission, funding, boarding | 32.7-T1 … 32.7-T13 | 13 |
| 08a Payments, statements, escrow | 32.8-T1 … 32.8-T11 | 11 |
| 08b Insurance, PMI, ARM, life events, requests | 32.9-T1 … 32.9-T11 | 11 |
| 08c Hardship and delinquency | 32.10-T1 … 32.10-T11 | 11 |
| 09 Rate-watch and re-refinance | 32.11-T1 … 32.11-T10 | 10 |
| 10 Exits | 32.12-T1 … 32.12-T8 | 8 |
| 13 Cross-cutting | 32.13-T1 … 32.13-T16 | 16 |
| **Total** | | **143** |

##### Acceptance harness — 6. Definition of "passing"

A file's screens are accepted when: all its tests pass; 32.13-T1…16 pass on the same build; no serializer leaks; axe reports no AA violations on the dark theme; and the copy tests pass on the committed copy-library.md.

##### Copy library — Channel variants (rules)

- **SMS**: first sentence + deep link; never a number the borrower hasn't seen in-app first (no rates, balances or payoff figures by SMS); STOP footer on the first message of a thread.
- **E-mail**: full text; subject = the card title; marketing e-mails carry the CAN-SPAM footer and the `partner` postal address.
- **Voice**: the same text spoken; cards described and sent as links; consents never taken by voice (`consent.esign.title` footer is read aloud).
- **Mail**: templates only.

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

#### AI agent design (AI-first)
`borrower-app` agent owns the harness and the copy library for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

##### Side-quest catalogue — Origination

**SQ-00 Browse (just curious)** · Trigger: the borrower declines to apply / asks only about rates · Entry: published ranges (`StatusCard`) + `ChoiceCard` "Want a personalized estimate? That takes a soft credit check" · Sequence: L2 → `ConsentCard{credit_authorization, soft_pull}` (`FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE`) → `credit.softpull.received` → prequalification numbers (after `terms_review` under `assisted`) → optional prequal letter (purchase) · Evidence: `credit_authorizations{soft_pull}`, `prequalifications` · Return: E3 goal → the full path; or `SM_LEAD_INACTIVITY_EXPIRY_90` (soft-pull data deleted; consents kept) · Spec: 20.3 (`exploring → prequal_requested → prequalified → terms_review → terms_presented`), `REGB_1002_2F_NO_PREQUAL_DECLINE_GATE` (never a decline at this stage).

**SQ-01 Assets requested by DU** · Trigger: DU "Funds Required to Close" / "Reserves Required to be Verified" (23.2 conditions) · Entry: `ConnectCard{plaid_assets}` in Needed-from-you · Sequence: connect → `ConfirmCard{accounts}` → large deposits → SQ-02 · Evidence: `verifications{kind=assets}`, `application_assets` confirmed · Return: condition `cleared` · Spec: 22.4, 23.2.

**SQ-02 Letters of explanation** · Trigger: inquiries ≤ 90 days (22.2); deposits > 50% of monthly qualifying income (22.4); employment gaps (22.3); address discrepancies (22.6) · Entry: `ExplanationCard` per item · Sequence: text/dictation → attestation · Evidence: `documents{class=inquiry_explanation|explanation_letter}` with hash · Return: condition `satisfied_pending_review → cleared` · Spec: 22.1, 22.2, 22.4.

**SQ-03 Non-connectable income** · Trigger: Truv `failed`, employer not covered, cash income · Entry: `ConfirmCard{monthly income, typed}` + `UploadCard{paystub (≤30 days at application), w2 ×2}` · Sequence: uploads → classification → `income_verified`; VVOE by the platform inside `FNMA_B3_3_1_04_VVOE_10BD` (a phone verification the borrower doesn't see; `FNMA_B3_3_1_04_VVOE_ALT_15BD` alternative) · Evidence: `document_requests` satisfied · Return: 4.7 · Spec: 22.1, 22.3.

**SQ-04 Gift funds** · Trigger: "gift funds coming?" = yes (P7/C) · Entry: `UploadCard{gift_letter}` (donor, relationship — family, fiancé, domestic partner; amount; no repayment) + `UploadCard{gift_transfer_evidence}` · Evidence: `gift_records` · Return: assets verified · Spec: 22.4 (B3-4.3).

**SQ-04-INS Insurance selection (purchase)** · Trigger: purchase, hazard `requirement_computed` · Entry: `ChoiceCard` have a quote / help me get quotes · Sequence: `UploadCard{binder}` or `ConnectCard{carrier_connect}`; the requirement facts (32.6 §5) · Evidence: `insurance.evidence.received → verified` · Return: PTD condition cleared · Spec: 24.5.

**SQ-05 Declarations detail** · Trigger: "Something here applies" · Entry: 13-item checklist (`ChecklistCard` variant with yes/no per item) · Sequence: each yes opens its follow-up — bankruptcy/foreclosure/short sale/DIL dates (waiting periods B3-5.3-07 explained as criteria, never a decline); judgments/lawsuits → documents; undisclosed borrowed funds → source; alimony/child support → order upload (22.5); co-signed debt → 12-month payment evidence · Evidence: `declarations` values with dates · Return: R6 · Spec: 21.1, 22.2, 22.5.

**SQ-06 Residence history** · Trigger: credit report shows < 2 years at the current address · Entry: `ConfirmCard{prior address, dates, own/rent}` · Return: R4 · Spec: 21.1 (URLA 1a).

**SQ-07 Vesting / owner mismatch** · Trigger: owner of record ≠ borrower; trust; spouse on title; recent transfer · Entry: `ChoiceCard` (it's in a trust / my spouse is on title / I recently bought it / other) · Sequence: `UploadCard{trust_agreement|trust_certification}` (`SM_TRUST_POA_REVIEW_GATE`); `InviteCard{non_borrowing_spouse}`; `ExplanationCard` for a recent transfer (title seasoning `FNMA_B2_1_3_03_TITLE_SEASONING_6M`) · Return: R1 / title cleared (32.6 §4) · Spec: 24.4, 21.1.

**SQ-08 HOA / condo documents** · Trigger: `project_reviews.status = pending_docs` · Entry: `UploadCard{hoa_questionnaire, hoa_budget, hoa_dues_statement}` or `HandoffCard{HOA management}` (owner *third party*) · Return: `certified` · Spec: 24.3.

**SQ-09 Preapproval refresh** · Trigger: `SM_UW_DECISION_VALIDITY − 14 days`; credit report > 4 months at the projected note date; income documents aging · Entry: `StatusCard` + `ConsentCard{credit_authorization}` (re-pull) + connector refresh · Sequence: DU re-run → refreshed letter · Return: P9 · Spec: 23.3 (`SM_UW_DECISION_VALIDITY`), 22.2 (`FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M`).

**SQ-10 HELOC subordination or payoff** · Trigger: second lien on the credit report or title commitment · Entry: `ChoiceCard` keep it (subordinate) / pay it off at closing · Sequence: `HandoffCard{HELOC lender}` for the subordination agreement (executed before closing — 24.4 gate) or `debt_payoff_plans` row · Evidence: subordination agreement in `documents`; payoff on the settlement statement · Return: title cleared · Spec: 24.4, 22.5.

**SQ-11 Cash-out seasoning** · Trigger: `FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M` / `_TITLE_SEASONING_6M` closed · Entry: `StatusCard` with the earliest eligible date + `ChoiceCard` rate/term now / wait · Return: E3 with the chosen type · Spec: 20.1, 23.2.

**SQ-12 Student-loan payment documentation** · Trigger: $0 reported payment · Entry: optional `UploadCard{student_loan_statement}` (a documented plan payment can replace the 1% rule) · Return: liabilities set · Spec: 22.5.

**SQ-13 Frozen credit** · Trigger: bureau freeze on the pull · Entry: `StatusCard` with per-bureau lift instructions + `ChoiceCard` "lifted — try again" · Rule: frozen at two or more bureaus → ineligible (explained as criteria) · Return: R2 · Spec: 22.2.

**SQ-14 Fraud alert on file** · Trigger: initial/extended alert on the report · Entry: the platform contacts the number on the alert (`FCRA_605A_H_ALERT_CONTACT_GATE`); `ConfirmCard` "Did you apply?" via that channel · Return: R2 · Spec: 22.2, 22.6.

**SQ-15 Disputed tradeline** · Trigger: dispute blocks DU · Entry: `ExplanationCard` + `ChoiceCard` (account is mine / not mine) · Sequence: resolution steps with the bureau; re-pull · Return: R2 · Spec: 22.2.

**SQ-16 Other income** · Trigger: any selection in R3's other-income field · Entry: source-specific `UploadCard`s — award letter (SSA/pension/disability), court order + receipt evidence (alimony/child support; ≥ 3 years continuance), leases/Schedule E (rental; 75% rule), LES (military) · Return: income verified · Spec: 22.3.

**SQ-17 Non-permanent resident** · Trigger: citizenship = non-permanent resident · Entry: `UploadCard{ead|visa|i-94}` per B2-2-02 · Return: R4 · Spec: 21.1.

**SQ-18 Self-employed** · Trigger: income type self-employed · Entry: `ConnectCard{irs_ives}` (Form 4506-C transcripts; `FNMA_B3_3_1_02_4506C_VALID_120`) + `UploadCard{form_1040 ×2 (or 1 when DU allows), schedule_c|k1|1065|1120s, ytd P&L}`; business existence verified by the platform ≤ 120 days before the note date (`FNMA_B3_3_1_04_SE_VERIFY_120`) · Return: income verified · Spec: 22.3 (Income Calculator; Form 1084).

**SQ-19 Second borrower** · Trigger: any point before `intake_complete` · Entry: `InviteCard{co_borrower}` · Sequence: 32.5 §7 (their disclosure, L1, L3, consents, joint intent first, then their R2–R6) · Evidence: per-party rows; `SM_O21_JOINT_INTENT_GATE` · Return: DU when all borrowers' items are present · Spec: 21.1, 22.2.

**SQ-19b Non-borrowing spouse / POA / trust signer** · Trigger: SQ-07 or vesting review · Entry: `InviteCard{party_role}` / `UploadCard{poa}` · Sequence: signing session participation (32.7) · Spec: 21.1, 24.4, 26.2.

**SQ-19c Wet-ink / paper closing** · Trigger: `SM_O72_RON_STATE_AUTH_GATE` closed; borrower declines electronic records; session failure → `converted_to_paper_path`; TX 50(a)(6) · Entry: `ChoiceCard` / `HandoffCard{notary_wet | settlement_agent}` · Rule: `SM_O72_PAPER_FALLBACK_5BD` · Spec: 26.2.

**SQ-19d Texas 50(a)(6)** · Trigger: TX homestead cash-out · Entry: `NTC_TX_50A6_12DAY` (ack), itemization with the CD, FMV acknowledgment at closing, 3-day post-closing rescission (`TX_50A6_RESCISSION_3D_GATE`), wet-only · Spec: 26.1, 25.4.

**SQ-19e New York CEMA** · Trigger: NY refinance electing CEMA · Entry: `StatusCard` explaining the consolidation and the paper path; documents at closing · Spec: 26.1.

**SQ-19f Manufactured housing / MH Advantage** · Trigger: property type · Entry: title-as-real-property confirmation; appraisal always required · Spec: 24.3, 24.1.

##### Side-quest catalogue — Servicing

**SQ-20 Returned payment** · Trigger: `ach.return.received` · Entry: `NoticeCard{AUTODRAFT-RETURN-v1}` · Sequence: 32.8 §3.4 · Spec: 2.x.

**SQ-21 Insurance lapse** · Trigger: `cancelled | nonrenewed | expired` · Entry: first notice (`REGX_1024_37C_FPI_FIRST_NOTICE_45`) · Sequence: 32.9 §1 · Spec: 9.2–9.5.

**SQ-22 Escrow shortage lump sum** · Trigger: `NTC_REGX_1024_17F_SHORTAGE` · Entry: `ChoiceCard` · Spec: 3.2/3.3.

**SQ-23 Contact / address change** · Trigger: typed ask · Entry: `ConfirmCard` (fresh L1) → `cases{address_change}` · Spec: 4.x, 7.x.

**SQ-24 Disaster** · Trigger: declaration covering the property · Entry: check-in `StatusCard`; disaster options (32.10 §7); loss draft (32.9 §1) · Spec: 9.x, 12.7, D1-3-01.

**SQ-25 Military service (SCRA)** · Trigger: borrower report or DMDC match · Entry: `UploadCard{orders|LES}` → `NTC_FNMA_D23401_SCRA_RIGHTS`, `NTC_SCRA_3937_RATE_CONFIRMATION` · Spec: 13.x SCRA processes.

**SQ-26 Death / successor** · Trigger: report of death · Entry: 4.4 case (32.9 §4.2) · Spec: 4.4.

**SQ-27 Bankruptcy filing** · Trigger: borrower/counsel notice or PACER · Entry: 32.10 §9 · Spec: 14.x.

**SQ-28 Cease communication / attorney representation** · Trigger: typed or spoken request · Entry: `NTC_REGF_1006_6C_CEASE_ACK` / representation confirmation · Spec: 11.4, 4.x.

**SQ-29 Payoff shortage / overage** · Trigger: `applied_short | applied_over` · Entry: 32.12 §1.2 notices · Spec: 16.2.

**SQ-30 Human transfer** · Trigger: "human" anywhere; distress keywords; classifier `needs_human`; CA supervisor request · Entry: `PersonCard{human_agent}` after `human.transfer.completed`; the delinquent borrower's named team (4.3) when assigned · Spec: 4.1, 4.3, 11.1, 20.3.

**SQ-31 E-delivery suspect / withdrawal** · Trigger: hard bounce, complaint, borrower request · Entry: `ConsentCard{esign}` re-verification or `NTC_ESIGN_WITHDRAWAL_CONFIRMATION` · Spec: 7.4 rules 7–8.

**SQ-32 PMI cancellation with valuation** · Trigger: `value_check_needed` · Entry: fee `ChoiceCard` → `valuation_ordered` · Spec: 10.1.

**SQ-33 Assumption / release of liability** · Trigger: typed ask; SII confirmation · Entry: `NTC_FNMA_D1_4_1_02_ASSUMPTION_OFFER` + documents · Spec: 4.4, D1-4.

**SQ-34 Escrow waiver** · Trigger: typed ask · Entry: eligibility explanation → decision notice · Spec: 3.x (32.8 §6.3).

**SQ-35 Re-amortization after a large curtailment** · Trigger: borrower asks / platform offers after a qualifying curtailment · Entry: `NoticeCard` + `ChoiceCard` (Form 181) · Spec: 2.x.

##### Side-quest catalogue — Global rules for side quests

1. Entering a side quest never removes a happy-path card; it adds items.
2. A side quest's items appear in Needed-from-you only when the borrower is the owner.
3. Every side quest ends with a one-line receipt in the Thread and a return to the badge state it left.
4. Copy for criteria-based outcomes (seasoning, waiting periods, eligibility) states the rule and the date — never a decline (20.3 rule 3) — unless a decision notice (21.6 / 12.2) is the artifact.
5. No side quest asks a question §1002.5 prohibits or collects demographic information outside R6 / its per-party equivalent.

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.13-T1 | Disclosure first — Given any new session on app, voice or SMS, then `lead.disclosure.delivered` precedes any other assistant content (32.3-T1 generalized to servicing sessions: `consent.ai_disclosure.acknowledged` per session). |
| 32.13-T2 | No invented dates — Given any Dates row rendered, then its `timer_code` is in the 32.2 §4 allow-list and `due_at` equals `timers.due_at`. |
| 32.13-T3 | Serializer allow-list — Given every `/v1/borrower/*` response schema, then no field name from `du_findings_interpretations`, `risk_assessment`, `credit_reports.*` (except score-notice fields), `compliance_test_runs`, `qc_*`, `fraud_*`, `applicant_demographics` appears. |
| 32.13-T4 | Consent precedes e-delivery — Given any `DocumentCard` with `disclosure_id`, then a `consents{kind=esign, status=active}` row scoped to the disclosure class exists for that party at `delivered_at`. |
| 32.13-T5 | Cards commit, chat doesn't — Given a borrower message whose text matches a pending card's affirmative (e.g., "yes proceed", "lock it", "I agree"), then no command executes and the reply contains the deep link. |
| 32.13-T6 | Party scoping — Given a co-borrower session, then the Record shows the other party's first name and `progress` booleans only; `applicant_demographics`, income and liabilities of the other party never appear. |
| 32.13-T7 | Voice never consents — Given any `ConsentCard`, when a voice session affirms, then the card stays `pending` and the invitation link is sent. |
| 32.13-T8 | Talk to a person — Given any screen, then a control emitting `human.request` is visible without scrolling; after `human.transfer.completed`, a `PersonCard{human_agent}` exists. |
| 32.13-T9 | Money and rates — Given any rendered amount, then it is produced from cents via `Intl.NumberFormat` and any rate from a decimal string; no float arithmetic in the client. |
| 32.13-T10 | Mobile parity — Given every card kind at 390 px, then it is operable and the status strip shows badge, next event and the needed-from-you count. |
| 32.13-T11 | Deep links — Given an SMS deep link opened without a session, then L1 is required before any loan data renders; the token resolves to the card and expires at 7 days. |
| 32.13-T12 | Degraded vendor — Given Truv returns an error, then the `ConnectCard` shows `failed` with the upload fallback and no error code is shown to the borrower. |
| 32.13-T13 | Reading level — Given every string in 12 outside notice templates, then its Flesch-Kincaid grade ≤ 8. |
| 32.13-T14 | Forbidden words — Given every string in 12, then none of the forbidden words appears outside its allowed keys. |
| 32.13-T15 | Nothing-needed — Given zero `owner=you` items, then the nothing-needed state renders and no reminder is sent. |
| 32.13-T16 | Read-only after terminal — Given `denied | withdrawn | closed_incomplete | rescinded | paid_in_full → closed | transferred_out`, then no command except `case.open`, `human.request`, document download and contact update succeeds. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

##### Acceptance harness — 5. Mapping to build-spec tests (the UI test must pass whenever the spec test passes)

| UI test | Build-spec test / rule |
|---|---|
| 32.3-T2, 32.13-T1 | 20.3-T11 (real-person answer), 20.3 `SM_AI_INTERACTION_DISCLOSURE_GATE` |
| 32.3-T5, 32.3-T11, 32.3-T17, 32.3-T18, 32.3-T29 | 21.1 rule 1 (prefilled counts at confirmation), 21.2 rule 2/5 (six-item detection) |
| 32.3-T6, 32.13-T7 | 20.3-T8 (voice yes ≠ E-SIGN), 7.4 rule 3 |
| 32.3-T7, 32.4-T1, 32.13-T4 | 21.2 guard (esign_consent_id), 7.4 channel rule |
| 32.3-T9 | 23.1-T11 (mixed score models) |
| 32.3-T15 | 20.3-T12 (no demographics pre-application) |
| 32.3-T21, 32.3-T28 | 20.3-T7 (MLO review before personalized terms) |
| 32.3-T23, 32.4-T5 | 21.4 `intent_records.valid` |
| 32.3-T25, 32.4-T6 | 21.4 lock → `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`, `SM_LOCK_EXPIRY_WARN_7` |
| 32.3-T26 | 20.3-T5 (TBD address; LE clock on address) |
| 32.4-T8 | 21.5 `REGZ_1026_19E4_REVISED_LE_4SBD_GATE` |
| 32.4-T10 | 21.5 `REGZ_1026_19F2V_TOLERANCE_REFUND_60` |
| 32.5-T1 | 23.2 `SM_DU_CONDITIONS_SLA_4H` |
| 32.5-T3, 32.5-T4 | 22.1 freshness engines (`FNMA_B3_3_2_01_PAYSTUB_30D_GATE`, `FNMA_B1_1_03_CREDIT_DOCS_4M`, `SM_DOC_EXPIRY_WARN_14`) |
| 32.5-T5 | 22.2 undisclosed-debt monitoring; 23.1 tolerances |
| 32.5-T7 | 21.1 `SM_O21_JOINT_INTENT_GATE` |
| 32.6-T2 | 21.6 `REGB_1002_9_COUNTEROFFER_90`; 23.2-Q3 |
| 32.6-T5 | 24.2 `REGB_1002_14_APPRAISAL_COPY_3BD_GATE` |
| 32.6-T9 | 24.5 `FDPA_4104A_FLOOD_NOTICE_GATE` |
| 32.6-T11 | 23.3 `SM_UW_CTC_GATE` / `ctc_checklists` |
| 32.7-T1 | 25.2 fixture (`REGZ_1026_19F1III_CD_MAILBOX_3SBD`, `REGZ_1026_19F1_CD_3SBD_GATE`) |
| 32.7-T6, 32.7-T8 | 25.3 `REGZ_1026_23_RESCISSION_3SBD_GATE`, `REGZ_1026_23D2_RESCISSION_REFUND_20` |
| 32.7-T10 | 26.3 `FNMA_B2_1_5_FIRST_PAYMENT_2M` |
| 32.7-T11 | 30.2 `SM_O64_FIRST_PAYMENT_LETTER_5BD`; 2.x rule 1 |
| 32.8-T1 | 2.7 `NOTE_6A_LATE_CHARGE_GRACE_GATE`, `SM_LATE_CHARGE_ASSESS_1CD` |
| 32.8-T4 | 2.x `NACHA_NSF_REINITIATION_180_MAX2` |
| 32.8-T6 | 2.x `REGE_1005_10D_VARIABLE_AMOUNT_NOTICE_10` |
| 32.8-T7 | 7.4 rule 8; 7.1 `bounced → fallback_mailed` |
| 32.8-T10 | 23.4-T5 (HPML escrow 5 years) |
| 32.9-T1, 32.9-T2 | 9.2 `REGX_1024_37C_FPI_FIRST_NOTICE_45`, `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`, 9.5 `REGX_1024_37G_FPI_CANCEL_REFUND_15` |
| 32.9-T6 | 7.2 ARM initial notice window |
| 32.9-T8 | 4.1 NoE ack and 60-day suppression; 8.x |
| 32.9-T10 | 7.6 `REGZ_1026_36C3_PAYOFF_STMT_7BD` (16.1 mirror) |
| 32.10-T1 | 11.1 `REGX_1024_39A_LIVE_CONTACT_36`, 4.3-T1 |
| 32.10-T4 | 12.1 protection tiers; 13 `REGX_1024_41G_DUAL_TRACK_GATE` |
| 32.10-T5 | 12.2 `REGX_1024_41E1_ACCEPT_14` |
| 32.10-T6 | 12.8 TPP acceptance by first payment |
| 32.10-T7 | 12.4 LL-2026-01 increments/cap |
| 32.10-T10 | 13 `REGX_1024_41F1_120_DAY_GATE`; `NTC_SM_FC_REFERRAL_ADVICE` |
| 32.11-T1 | 20.1 `FNMA_C1_1_01_PREMIUM_RECAPTURE_120` |
| 32.11-T2, 32.11-T3 | 20.2 worked example 1; `TCPA_64_1200_A2_PEWC_GATE` |
| 32.11-T7 | 30.3 same-servicer netting; 3.5 `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` |
| 32.12-T5, 32.12-T6 | 1.3-T1/-T5/-T7 mirrored for transfer out (17.x) |

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/13-acceptance-tests.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/12-message-copy-library.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/11-side-quests-catalogue.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections the build-spec tests each UI test depends on (mapping under Audit and evidence); the copy strings themselves live in copy-library.md and are not units (spec/sections/)
