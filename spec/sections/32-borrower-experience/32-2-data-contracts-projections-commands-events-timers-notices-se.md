# 32.2 — Data contracts: projections, commands, events, timers, notices, security, API

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | a — projections are computed; commands are gated by the owning process; the borrower-app agent decides nothing |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On every event in §3; on every command in §2; SSE per session |
| Governing source | Projection of sections every section whose tables the projections read (1–19, 20–31); the seven UI-owned tables are the only new schema |
| Key deadlines | none owned — §4 is the allow-list of codes whose `due_at` may render |
| Timers | `REGZ_1026_19E1_LE_3BD`, `REGZ_1026_37A13_COSTS_EXPIRE_10BD`, `SM_MLO_PREAPP_TERMS_REVIEW_1BH`, `SM_O21_MLO_REVIEW_SLA_1BD`, `SM_LOCK_MLO_APPROVAL_SLA_30MIN`, `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`, `SM_LOCK_EXPIRY_WARN_7`, `SM_LOCK_EXPIRY_DEADLINE`, `REGB_1002_9_DECISION_30`, `REGB_1002_9_NOIA`, `REGB_1002_9C2_NOIA_RESPONSE`, `REGB_1002_9_COUNTEROFFER_90`, `SM_NEEDS_LIST_BORROWER_RESPONSE_5`, `SM_DOC_EXPIRY_WARN_14`, `FNMA_B1_1_03_CREDIT_DOCS_4M`, `SM_CREDIT_EXPIRY_WARN_21`, `SM_UW_DECISION_VALIDITY`, `REGB_1002_14_APPRAISAL_COPY_3BD_GATE`, `REGB_1002_14_APPRAISAL_COPY_PROMPT_7`, `FNMA_B4_1_3_12_ROV_TURNTIME_5BD`, `FDPA_4104A_FLOOD_NOTICE_GATE`, `SM_FLOOD_NOTICE_DELIVER_1BD`, `SM_O62_CD_TARGET_4SBD`, `REGZ_1026_19F1_CD_3SBD_GATE`, `REGZ_1026_19F1III_CD_MAILBOX_3SBD`, `REGZ_1026_23_RESCISSION_3SBD_GATE`, `SM_O73_POST_RESCISSION_FUNDING_1BD`, `FNMA_B2_1_5_FIRST_PAYMENT_2M`, `SM_O64_FIRST_PAYMENT_LETTER_5BD`, `SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20`, `REGX_1024_17G_INITIAL_STMT_45`, `SM_ORIG_FIRST_STATEMENT_LEAD_15`, `REGZ_1026_39_OWNERSHIP_NOTICE_30`, `SM_REFI_OPPORTUNITY_EXPIRY_30`, `SM_LEAD_INACTIVITY_EXPIRY_90`, `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45`, `REGX_1024_17I_ANNUAL_STMT_30`, `HPA_4902B_AUTO_TERMINATE_0`, `REGZ_1026_36C3_PAYOFF_STMT_7BD`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`, `REGX_1024_41E1_ACCEPT_14`, `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW` |

### Blueprint row
Projection of sections every section whose tables the projections read (1–19, 20–31); the seven UI-owned tables are the only new schema. Everything `borrower-app` reads, writes and listens to. All names below are the build specs' names unless marked **UI-owned**. Claude Code implements the UI-owned tables in the `borrower-app` schema and the projections as read models in `api` over the existing tables; no other schema changes are permitted by this package. (Imported from docs/ux/02-data-contracts.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 02 is 32.2 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections every section whose tables the projections read (1–19, 20–31); the seven UI-owned tables are the only new schema** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: (1) Events the UX spells differently from the platform: `payments.reversed` = `payment.reversed`; `party.identity.verified` = `identity.verified`; `human.transfer.completed` = `human_transferred`; `autodraft.change.requested` = the `autodraft.enrollment.*` family; `signing_sessions.consent_captured` is a column state, not an event. (2) `preapproval.letter.issued` (DELTA-01) is not a platform event yet. (3) Names the UX uses as timers that are not registry codes and a notice code no section owns are listed under Timers and gates. (4) Consent kinds `credit_authorization`, `joint_intent`, `irs_estatement`, `blanket_verification_authorization` and the E-SIGN scope classes were not in the 0001 `consent_kind` enum (db/migrations/0112). All in docs/ux/BACKEND-DELTAS.md.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On every event in §3; on every command in §2; SSE per session. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.
##### 2. Commands the UI issues

All writes are commands (`command → events → projections`). The UI calls the `api` command endpoints with an idempotency key = `card_instance_id`. The gate column names the `assertGateOpen` code the handler checks; the UI never bypasses it and renders the handler's refusal reason from the copy library.

| Command | Args | Gate / precondition | Events emitted | Owner |
|---|---|---|---|---|
| `lead.start` | channel, utm, consumer_state | — | `lead.created`, `lead.interaction.started{channel, ai}` | 20.3 |
| `lead.acknowledgeAiDisclosure` | disclosure_version_id | — | `lead.disclosure.delivered`, `consent.ai_disclosure.acknowledged` | 20.3 |
| `party.authenticate` | method (otp_phone · otp_email · passkey), code | — | `lead.authenticated{level}` | 20.3 / UI |
| `party.startIdentity` / vendor webhook | vendor=stripe_identity | L1 | identity events → `SM_IDENTITY_IAL2_GATE` satisfied | 22.6 |
| `consent.capture` | kind, disclosure_version_id, method, text_hash, scope[] | method per kind (32.1 §3.5) | `consent.granted{kind}` → `consent.esign.pending|verified|active` (7.4) | 7.4, 20.3 |
| `credit.authorize` | kind ∈ {soft_pull, hard_pull}, text_hash, signature | L2 (soft) / L3 (hard); `FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE` | `credit.authorization.captured{kind}`, then `credit.softpull.requested` / `credit.report.received` | 20.3, 22.2 |
| `application.confirmField` | path, value, source | ConfirmCard resolve | field write with `confirmed_at`; six-item detector runs → `application.received`, `application.trid_received` | 21.1, 21.2 |
| `application.setGoal` | transaction_type, occupancy, property (address or tbd), value_estimate?, loan_amount_sought? | — | `application.started` | 21.1 |
| `application.answerDeclarations` | declarations[13] (all false = "none apply") | — | `declarations` row | 21.1 |
| `application.answerDemographics` | per §1002.13 / App. B, may be `declined` | own party only | `applicant_demographics` (restricted) | 21.1 |
| `application.affirmJointIntent` | — | own party; before that party's credit order (`SM_O21_JOINT_INTENT_GATE`) | joint-intent artifact | 21.1 |
| `application.inviteParty` | role, contact | — | party + conversation created | 21.1 / UI |
| `verification.connect` | vendor (truv_income · plaid_assets · irs_ives · carrier_connect) | post-intent or `fee_paid_by=sm` | `verification.received{kind}` on webhook | 22.3, 22.4 |
| `document.upload` | document_class?, file | — | `document.classified` (22.1) | 22.1 |
| `explanation.submit` | subject_ref, text, attestation | — | `documents{class=explanation_letter|inquiry_explanation}` | 22.1, 22.2 |
| `disclosure.acknowledgeReceipt` | disclosure_id | `consents{esign, active}` for the class | `disclosure.le.received` / `disclosure.cd.received` / `disclosure.companion.received` with `receipt_evidence=esign_confirmed` | 21.2, 21.3, 25.2 |
| `intent.record` | — | LE `received|deemed_received` (`intent_records.valid` computed) | `intent.to_proceed.received`; opens `REGZ_1026_19E2_INTENT_FEE_GATE` | 21.4 |
| `lock.request` | quote_id, period_days, float_down_elected? | `SM_O61_COMPLIANCE_PASS_LOCK_GATE`; `SM_QUOTE_VALIDITY_GATE` | `locks.requested → pending_mlo_approval` (`SM_LOCK_MLO_APPROVAL_SLA_30MIN`) → `lock.executed` (`REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` opens) | 21.4 |
| `lock.requestExtension` | days | `locks.status=confirmed` | `lock.extended` | 21.4 |
| `counteroffer.respond` | decision ∈ {accept, decline} | `REGB_1002_9_COUNTEROFFER_90` running | `counteroffer_accepted` / `denied` path | 21.6 |
| `application.withdraw` | reason? | any non-terminal | `application.withdrawn` | 21.6 |
| `mi.selectPlan` | plan ∈ {bpmi_monthly, single, split, lpmi} | `mi_certificates.status=quoted` | `plan_selected` (LE revised) | 24.6 |
| `valuation.scheduleAccess` | slot | `valuation_orders.status=assigned` | `inspection_scheduled` | 24.1 |
| `rov.request` | comparables[], narrative | `appraisals.review_status=accepted`, before `FNMA_B4_1_3_12_ROV_CLOSING_GATE` | `rov.requested` | 24.2 |
| `insurance.submitEvidence` | policy doc / carrier connection | — | `insurance.evidence.received` | 24.5 |
| `closing.selectSlot` | slot, closing_type_preference | decision sub-status `clear_to_close`; `SM_O72_RON_STATE_AUTH_GATE` | `closing.scheduled` | 26.2 |
| `closing.captureEsignConsent` | — | `SM_O72_ESIGN_CONSENT_CLOSING_GATE` | `signing_sessions.consent_captured` | 26.2 |
| `rescission.exercise` | — | rescission `running` | `rescinded` path (H-8/H-9) | 25.3 |
| `autodraft.enroll` / `.change` / `.pause` / `.revoke` | account, amount rule, draft day (1–16), include_fees? | Reg E/Nacha elements displayed (2.x rule 1) | `autodraft.enrollment.requested → authorized → validating → active`; changes emit `autodraft.change.requested`; `SM_AUTODRAFT_COPY_DELIVERY_1BD` | 2.x |
| `payment.makeOneTime` | amount_cents, date, account | fresh L1 within 10 min | `payment.receive{channel=portal}` → `payments.received → identified → posted` | 2.1 |
| `payment.extraPrincipal` | amount_cents | — | curtailment `received → applied` | 2.x |
| `escrow.electShortage` | option ∈ {spread_12, lump_sum} | analysis `statement_sent` | plan `active` / `paid_lump` | 3.2, 3.3 |
| `escrow.requestWaiver` | — | eligibility (3.x) | `escrowed → evaluating` | 3.x |
| `pmi.requestCancellation` | — | `mi_policies` active | `pmi_cancel` case `received` | 10.1 |
| `case.open` | kind ∈ {rfi, noe, complaint, payoff_request, address_change, general_inquiry}, text, attachments | written channel (app counts as written) | `communication.inbound.received` → Intake Router → `cases` | 4.1, 4.2, 4.5, 7.6 |
| `lossmit.requestAssistance` | hardship text?, income?, expenses? | — | `lossmit.assistance.requested` / `lossmit.application.received` | 12.1 |
| `lossmit.respondToOffer` | decision | `REGX_1024_41E1_ACCEPT_14` running | `lossmit.offer.response.received` | 12.2 |
| `lossmit.appeal` | text | within 14 days of the denial notice | `lossmit.appeal.received` | 12.3 |
| `offer.respond` | decision ∈ {yes, not_now, never} | `refi_opportunities.status=offered` | `lead.created`+conversion / `refi.opportunity.declined` / marketing consent revoked | 20.1, 20.2 |
| `refi.request` | — | serviced loan | `refi_opportunities.requested → offer_ready` | 20.1 |
| `human.request` | reason? | always | `human.transfer.requested` | 4.x, 20.3 |
| `party.updateContact` | address/phone/email | fresh L1 | `contacts`/`parties` update; address-change case where required | 4.x |

##### 3. Events the UI subscribes to (SSE `GET /v1/borrower/stream`)

The stream carries `{event_name, at, subject, payload_ref}`; the UI re-fetches the affected projection. Table gives the UI reaction; copy keys are in file 12.

| Event | Reaction |
|---|---|
| `lead.disclosure.delivered`, `lead.authenticated{level}` | session level badge; unlock cards |
| `credit.softpull.received` / `credit.report.received` | prequal / application numbers refresh; inquiry `ExplanationCard`s if 22.2 flags |
| `prequal.letter.issued`, preapproval letter issued | `DocumentCard` (letter); badge "Prequalified"/"Preapproved" |
| `terms.presentation.requested` → `mlo.review.completed{approved}` → `terms.presented` | `StatusCard` "your terms are being reviewed by {{mlo.name}}" → `ComparisonCard`/`StatusCard` with terms; `PersonCard` for the MLO |
| `application.received`, `application.trid_received` | badge "Application received"; `next` = LE by `REGZ_1026_19E1_LE_3BD.due_at` |
| `disclosure.le.delivered` / `.mailed` / `.received` / `.revised` | `DocumentCard` (`NTC_REGZ_1026_37_LE`), Documents section, Numbers → `le_v{n}` |
| `disclosure.companion.delivered{kind}` | `DocumentCard` per companion (hcl, toolkit, regb_appraisal_notice, credit_score_notice, afba, arm_program, charm, privacy, state) |
| `intent.to_proceed.received` | badge "Ready to lock" / lock card offered; connectors become needs-list items |
| `lock.executed`, `lock.extended`, `locks.status=expired` | Numbers lock block; `StatusCard`; `SM_LOCK_EXPIRY_WARN_7` → caution styling |
| `verification.received{kind}` | `ConnectCard` → connected; needs-list update |
| `condition.opened`, `condition.cleared`, `condition.reopened`, `condition.waived` | `ChecklistCard` in place; Needed-from-you |
| `du.findings.received` (not shown), `decision.issued{conditional_approval|counteroffer|denial|noia}` | badge + `NoticeCard` with the 21.6 document |
| `valuation.ordered`, `inspection_scheduled`, `valuation.received`, `copy_delivered` | Property section; `ScheduleCard`; `DocumentCard` (appraisal copy) |
| `flood.determination.received`, `flood.notice.delivered` | Property flood status; `DocumentCard` (`NTC_FDPA_4104A_FLOOD_NOTICE`) |
| `insurance.evidence.received`, hazard `verified|deficient` | Property insurance status; deficiency card |
| `mi.certificate.issued`, `mi.quote.received` | `ComparisonCard` (plans) → Numbers |
| `compliance.test.failed` | nothing borrower-visible (internal); `StatusCard` only if the CD is delayed past `SM_O62_CD_TARGET_4SBD` |
| decision sub-status `ptd_cleared`, `clear_to_close` | badge; `ScheduleCard` (closing slots) |
| `disclosure.cd.delivered` / `.received` / `earliest_consummation_date` set | `DocumentCard` (`NTC_REGZ_1026_38_CD`); Dates "earliest closing" |
| `closing.scheduled`, `closing.documents.released`, `signing_sessions.*`, `closing.consummated` | badge; `HandoffCard` (RON); `PersonCard` (notary, settlement agent) |
| `rescission.period.started`, `rescission.confirmed_not_rescinded`, `rescission.waiver.accepted` | badge "Cancel window"; Dates "cancel window ends"; H-8/H-9 `DocumentCard` |
| `funding.authorized`, `funding.wire.released`, `funding.disbursement.confirmed`, `loan.funded` | badge "Funding" → "Funded"; `StatusCard` with first payment |
| `loan.boarded`, `loans.boarding_status=active` | switch Record to servicing layout; `NTC_SM_FIRST_PAYMENT_LETTER` card; autopay/e-statement cards |
| `loan.purchased` (internal) → ownership notice `expected` | `HandoffCard` "a letter from Fannie Mae is coming" |
| `payment.posted`, `payment.reversed`, `ach.return.received` | Numbers; `StatusCard`; return handling cards (2.x) |
| `autodraft.*` | Loan section autopay block |
| statement cycle `sent|delivered|bounced|fallback_mailed` | `DocumentCard` / Mailed |
| `escrow.analysis.completed`, analysis `statement_sent|effective` | `NoticeCard` (escrow statement) + `ChoiceCard` (shortage election) |
| disbursement `sent|confirmed` | `StatusCard` "we paid {{payee}} {{money}}" |
| hazard `lapsed`, force-placement notices, `cured` | `NoticeCard`s (9.x); `UploadCard` |
| `mi_policies` `terminated`, `pmi_cancel` case states | `StatusCard` / `NoticeCard` |
| ARM notice `notice_sent`, `effective` | `NoticeCard`; Numbers |
| `loan.delinquency.day_reached{n}`, EI notice sent, continuity `assigned` | account badge; `NoticeCard`; `PersonCard` (team) |
| `lossmit.*`, `workout_plans.*`, `lossmit_appeals.*` | 08c cards |
| `case.*` (ack, extension, response) | `NoticeCard`s (`NTC_REGX_35D_ACK`, responses) |
| `refi.opportunity.offered`, `.expired`, `.converted` | `OfferCard`; Offers section |
| payoff `sent`, `paid_in_full`, lien release `recorded`, `borrower_notified` | 10 cards |
| `human.transfer.completed` | `PersonCard` (`human_agent`) |

#### Data model
UI-owned tables (the only new schema this package permits; retention follows the owning record's class — `sm_lead_36m` before an application, `fnma_loan_file_life_plus_4y` once one exists — 31.3):
- **`conversations`** (new): `conversation_id uuid pk`, `party_id` → `parties`, `created_at`, `locale`, `timezone`. One per party (32.1 §6.1); the same conversation continues across origination, servicing and every refinance.
- **`messages`** (new; append-only): `message_id uuid pk`, `conversation_id` → `conversations`, `at`, `sender` enum {borrower, agent, human, notice, system}, `sender_ref`, `channel` enum {app, sms, email, voice, mail}, `body_text` (pii), `card_instance_id?`, `subject_application_id?`, `subject_loan_id?`, `external_ref` (telephony sid / e-mail id).
- **`card_instances`** (new): `card_instance_id uuid pk`, `conversation_id` → `conversations`, `party_id`, `subject_application_id?`, `subject_loan_id?`, `kind` (the CardKind of 32.1 §3), `status` enum {pending, resolved, expired, superseded, cancelled}, `created_by`, `copy_key`, `props jsonb`, `evidence jsonb` (persisted on resolve), `command_ref?`, `expires_at`, `created_at`, `resolved_at`.
- **`card_instance_events`** (new; append-only): `card_instance_id` → `card_instances`, `from_status`, `to_status`, `at`, `actor` (party, agent or `human_agent`), `channel`, `evidence jsonb` — every status transition of a card appends here.
- **`deep_links`** (new): `token pk`, `party_id`, `target jsonb` {card_instance_id | document_id | route}, `expires_at` (7 days), `created_for_message_id` → `messages`, `single_use` false. Tokens never encode loan data (32.1 §6.5).
- **`ui_events`** (new; append-only): `ui_event_id uuid pk`, `party_id`, `session_id` → `sessions`, `conversation_id`, `card_instance_id?`, `kind` enum {card_shown, card_resolved, document_opened, document_scrolled_to_end, consent_affirmed, connector_started, connector_completed, deep_link_opened, voice_started, human_requested}, `at`, `ip`, `user_agent`, `disclosure_version_id?`, `payload jsonb` (32.1 §9).
- **`sessions`** (new): `session_id uuid pk`, `party_id`, `level` enum {L1, L2, L3}, `created_at`, `last_seen_at`, `passkey_id?`, `ip`, `user_agent` (32.1 §5).

- Baseline, read-only projection sources the read models of §1 are built from (owned by the sections cited in the Blueprint row; no table is re-declared here): `applicant_demographics`, `application_borrowers`, `application_properties`, `applications`, `appraisals`, `apr_calculations`, `autodraft_enrollments`, `borrowers`, `cases`, `conditions`, `contacts`, `declarations`, `disclosures`, `documents`, `du_findings_interpretations`, `escrow_accounts`, `escrow_lines`, `fnma_loan_file_life_plus_4y`, `jurisdiction_rules`, `lead_interactions`, `loan_terms`, `loans`, `locks`, `lossmit_appeals`, `lossmit_applications`, `lossmit_evaluations`, `mi_policies`, `notices`, `parties`, `pricing_quotes`, `project_reviews`, `refi_opportunities`, `settlement_agents`, `signing_sessions`, `timers`, `valuation_orders`, `workout_plans`.
- Baseline tables written, only ever through the owning process's command handler (the UI writes no domain row directly): `consents`, `intent_records`, `disclosures` (`receipt_evidence`), `credit_authorizations`, `condition_clearances`, `contacts`, `lead_interactions`, `applicant_demographics` (restricted; write-once).

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGZ_1026_19E1_LE_3BD` | (20.3 owns) |  |  |  |  | Loan Estimate arrives by |
| `REGZ_1026_37A13_COSTS_EXPIRE_10BD` | (21.2 owns) |  |  |  |  | Estimated costs on your LE are good through |
| `SM_MLO_PREAPP_TERMS_REVIEW_1BH` | (20.3 owns) |  |  |  |  | Your loan officer is reviewing — expected by |
| `SM_O21_MLO_REVIEW_SLA_1BD` | (21.1 owns) |  |  |  |  | Your loan officer is reviewing — expected by |
| `SM_LOCK_MLO_APPROVAL_SLA_30MIN` | (21.4 owns) |  |  |  |  | Your loan officer is reviewing — expected by |
| `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` | (20.4 owns) |  |  |  |  | Updated Loan Estimate arrives by |
| `SM_LOCK_EXPIRY_WARN_7` | (21.4 owns) |  |  |  |  | Rate lock expires |
| `SM_LOCK_EXPIRY_DEADLINE` | (21.4 owns) |  |  |  |  | Rate lock expires |
| `REGB_1002_9_DECISION_30` | (20.3 owns) |  |  |  |  | Decision on your application by |
| `REGB_1002_9_NOIA` | (21.6 owns) |  |  |  |  | We need the missing items by |
| `REGB_1002_9C2_NOIA_RESPONSE` | (21.6 owns) |  |  |  |  | We need the missing items by |
| `REGB_1002_9_COUNTEROFFER_90` | (21.6 owns) |  |  |  |  | Counteroffer open until |
| `SM_NEEDS_LIST_BORROWER_RESPONSE_5` | (22.1 owns) |  |  |  |  | Please send by |
| `SM_DOC_EXPIRY_WARN_14` | (22.1 owns) |  |  |  |  | A document is about to go out of date — we may ask again |
| `FNMA_B1_1_03_CREDIT_DOCS_4M` | (22.1 owns) |  |  |  |  | A document is about to go out of date — we may ask again |
| `SM_CREDIT_EXPIRY_WARN_21` | (22.2 owns) |  |  |  |  | A document is about to go out of date — we may ask again |
| `SM_UW_DECISION_VALIDITY` | (23.3 owns) |  |  |  |  | Your approval is valid through |
| `REGB_1002_14_APPRAISAL_COPY_3BD_GATE` | (24.2 owns) |  |  |  |  | Appraisal copy to you by |
| `REGB_1002_14_APPRAISAL_COPY_PROMPT_7` | (24.2 owns) |  |  |  |  | Appraisal copy to you by |
| `FNMA_B4_1_3_12_ROV_TURNTIME_5BD` | (24.2 owns) |  |  |  |  | Appraiser's response to your value review by |
| `FDPA_4104A_FLOOD_NOTICE_GATE` | (24.5 owns) |  |  |  |  | Flood notice to you by |
| `SM_FLOOD_NOTICE_DELIVER_1BD` | (24.5 owns) |  |  |  |  | Flood notice to you by |
| `SM_O62_CD_TARGET_4SBD` | (25.2 owns) |  |  |  |  | Closing Disclosure to you by |
| `REGZ_1026_19F1_CD_3SBD_GATE` | (25.2 owns) |  |  |  |  | Earliest closing date |
| `REGZ_1026_19F1III_CD_MAILBOX_3SBD` | (25.2 owns) |  |  |  |  | Closing Disclosure counts as received on |
| `REGZ_1026_23_RESCISSION_3SBD_GATE` | (25.3 owns) |  |  |  |  | Cancel window ends (midnight) |
| `SM_O73_POST_RESCISSION_FUNDING_1BD` | (26.3 owns) |  |  |  |  | Funding expected |
| `FNMA_B2_1_5_FIRST_PAYMENT_2M` | (26.3 owns) |  |  |  |  | First payment due · First-payment letter |
| `SM_O64_FIRST_PAYMENT_LETTER_5BD` | (25.4 owns) |  |  |  |  | First payment due · First-payment letter |
| `SM_O64_FIRST_PAYMENT_LETTER_PREDUE_20` | (25.4 owns) |  |  |  |  | First payment due · First-payment letter |
| `REGX_1024_17G_INITIAL_STMT_45` | (3.1 owns) |  |  |  |  | Initial escrow statement by |
| `SM_ORIG_FIRST_STATEMENT_LEAD_15` | (30.2 owns) |  |  |  |  | First statement by |
| `REGZ_1026_39_OWNERSHIP_NOTICE_30` | (25.4 owns) |  |  |  |  | Fannie Mae ownership letter expected by |
| `SM_REFI_OPPORTUNITY_EXPIRY_30` | (20.1 owns) |  |  |  |  | Offer good through |
| `SM_LEAD_INACTIVITY_EXPIRY_90` | (20.3 owns) |  |  |  |  | We'll close this conversation on |
| `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45` | (3.2 owns) |  |  |  |  | per 32.8–32.12 (as stated in each) |
| `REGX_1024_17I_ANNUAL_STMT_30` | (3.3 owns) |  |  |  |  | per 32.8–32.12 (as stated in each) |
| `HPA_4902B_AUTO_TERMINATE_0` | (10.2 owns) |  |  |  |  | per 32.8–32.12 (as stated in each) |
| `REGZ_1026_36C3_PAYOFF_STMT_7BD` | (7.6 owns) |  |  |  |  | per 32.8–32.12 (as stated in each) |
| `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` | (3.5 owns) |  |  |  |  | per 32.8–32.12 (as stated in each) |
| `REGX_1024_41E1_ACCEPT_14` | (12.2 owns) |  |  |  |  | per 32.8–32.12 (as stated in each) |
| `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW` | (12.6 owns) |  |  |  |  | per 32.8–32.12 (as stated in each) |

Every row above is a bare reference (empty trigger, anchor, offset and satisfied cells): the code is owned by the process in the Kind column, the UI renders its `due_at` under the label in the Breach column and never computes a date. The allow-list itself (labels and calendar notes) is §4 under Business rules.

Jurisdiction overrides: none — `jurisdiction_rules` drives copy only (Business rules §8).

Names the UX uses as timers that are not registry codes (backend delta; listed without backticks so nothing registers them): SM_QC_PREFUNDING_HOLD (32.6), FNMA_NIB_BALANCE_NOTICE (32.12).

Notice codes the UX renders that no earlier section names (not in spec/registry/notices.json; listed without backticks so 32.x never becomes an owner):

| Code | Named by | Nearest registry family |
|---|---|---|
| NTC_STATE_ANNUAL_ESCROW_STMT_UT | 32.8 | docs/ux/BACKEND-DELTAS.md |

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. Read models (projections)

###### 1.1 `borrower_record` (per party × subject)
Built by `api` from the tables named; refreshed on the events in §3; served as one JSON document and streamed as patches.

| Field group | Fields | Source |
|---|---|---|
| `subject` | `application_id?`, `loan_id?`, `label`, `transaction_type` (purchase · limited_cash_out · cash_out), `occupancy` | `applications`, `loans` |
| `status` | `badge` (32.1 §4 catalogue), `state_source` (the underlying state name and table), `one_liner` (copy key) | `applications.status`, `applications.disposition`, decision sub-status (23.3), `locks.status`, `closings.status`, rescission state (25.3), `fundings.status`, `loans.boarding_status`, servicing account states (32.8) |
| `next` | `label`, `due_at`, `timer_code`, `calendar_note` | earliest non-satisfied allow-listed timer (§4) |
| `needed_from_you[]` | `{item_id, kind ∈ {condition, consent, confirmation, connector, document_request, acknowledgment, schedule, signature}, label, due_at?, card_instance_id}` | `conditions{status=waiting_borrower}`, `document_requests{open}`, `consents{status ∉ active}` required for the stage, unresolved `ConfirmCard`s, `ConnectCard`s `not_started|failed`, `disclosures{requires_ack, received_at null}`, `closings{scheduled=false}` when CTC, `signing_sessions{consent_captured=false}` |
| `numbers` (pre-funding) | `note_rate`, `apr`, `pi_payment_cents`, `escrow_payment_cents?`, `loan_amount_cents`, `cash_to_close_cents?` (purchase), `monthly_savings_cents?` (refi), `lock: {status, expires_at, period_days}`, `figures_source ∈ {quote, le_v{n}, cd_v{n}}` | `pricing_quotes`, `locks`, `disclosures{le|cd}` figure snapshots, `apr_calculations` |
| `numbers` (post-funding) | `upb_cents`, `next_payment: {due_on, amount_cents, pi_cents, escrow_cents}`, `escrow_balance_cents`, `note_rate`, `days_past_due` (`regx_days_delinquent`) | `loans`, `loan_terms`, `escrow_accounts`, ledger projections (2.x) |
| `dates[]` | `{timer_code, label, due_at, calendar}` for every allow-listed timer with a future `due_at` | `timers` |
| `documents[]` | `{document_id, disclosure_id?, notice_code?, title, kind, status ∈ {pending, delivered, received, deemed_received, mailed, superseded}, delivered_at, received_at, mailed_at, requires_ack, channel}` | `disclosures`, `notices`, `documents` (borrower-visible classes only, §5) |
| `people[]` | `{party_id, role, display_name, progress: {consents_ok, confirmations_ok, signed}, nmlsr_id?, direct_number?, commission_state?}` | `application_borrowers`, `parties`, `mlo_of_record`, `mlo_reviews`, `signing_sessions`, `closings.notary`, `settlement_agents`, continuity-of-contact assignment (4.3) |
| `property` | `address`, `tbd: boolean`, `property_type`, `units`, `occupancy`, `valuation: {method, status, appointment_at?, value_used_cents?}`, `flood: {status}`, `hazard: {status}`, `project_review: {status}`, `hoa_dues_cents?` | `application_properties`, `valuation_orders`, `appraisals`, flood/hazard states (24.5), `project_reviews` |
| `loan` (servicing) | `autodraft: {status, next_draft_on, amount_cents, account_last4}`, `escrow_lines[]{type, payee, next_disbursement_on, annual_cents}`, `mi: {status, projected_end_on, cancellation_eligible_on}`, `arm: {next_change_on, notice_status}?`, `year_end: {form_1098_status}`, `continuity_team?` | `autodraft_enrollments`, `escrow_lines`, `mi_policies`, ARM notice states (7.2), 1098 status (7.x), 4.3 assignment |
| `offers[]` (servicing) | `{refi_opportunity_id, status, offered_at, expires_at, terms}` | `refi_opportunities`, `pricing_quotes` |

Access rule: a party sees only subjects where they are a borrower, a confirmed successor (4.4), or a `party_role` with scope (§6). Co-borrowers see the shared Record; per-party progress of the *other* borrower is limited to `progress` booleans and first name.

###### 1.2 `thread_messages` (per conversation)
`{message_id, conversation_id, at, sender ∈ {borrower, agent, human, notice, system}, sender_label, channel ∈ {app, sms, email, voice, mail}, body_text?, card_instance_id?, subject, voice_turn: boolean, delivery: {sent, delivered, read}}`. Sources: **UI-owned** `conversations`/`messages` plus `lead_interactions` (20.3) and `contacts` (4.x/11.x) written through the `borrower-comms` API. Notices appear as messages when `notices.sent_at` fires for a borrower-visible code.

###### 1.3 `needed_from_you` — derivation
Ordered by `due_at asc, created_at asc`. An item leaves the list on: `condition.cleared`/`condition.waived`/`condition.superseded`; `consent.*.active|withdrawn`; the `ConfirmCard` resolve; `verification.received{kind}` for the connector; `document.classified` for the request; `disclosure.*.received`; `closing.scheduled`; `signing_sessions.consent_captured`. Items never disappear silently: each exit writes a collapsed receipt line in the Thread.

###### 1.4 `documents_view` — borrower-visible classes
Disclosures (all `disclosures.kind`), notices with codes in §5, and `documents` whose `document_classes.family ∈ {identity (own only), income_employment (own only), assets (own only), letters (own only), valuation (appraisal copy only after `copy_delivered`), closing (executed copies after `closing.consummated`), insurance, hoa_project (borrower-supplied only)}`. Never: `credit_report` (the report itself is not delivered; the score notice is), DU findings, title commitment internals, fraud/QC artifacts, `applicant_demographics`.

###### 1.5 Servicing history views
`payments_view` (posted payments with allocation P/I/escrow/fees; `payments.status ∈ {posted, reversed, refunded, returned}`), `escrow_history_view` (disbursements `sent|confirmed`, analyses `effective`), `statements_view` (cycle rows `delivered|bounced|fallback_mailed`), `cases_view` (`cases` of type rfi/noe/complaint/payoff/sii with status and due dates), `lossmit_view` (`lossmit_applications`, `lossmit_evaluations`, `workout_plans`, `lossmit_appeals` statuses).

##### 4. Timers — borrower-visible allow-list

Only these codes render; each with its label and the calendar note. Anything else stays internal.

| Code | Label | Calendar note |
|---|---|---|
| `REGZ_1026_19E1_LE_3BD` | Loan Estimate arrives by | business days |
| `REGZ_1026_37A13_COSTS_EXPIRE_10BD` | Estimated costs on your LE are good through | business days |
| `SM_MLO_PREAPP_TERMS_REVIEW_1BH` / `SM_O21_MLO_REVIEW_SLA_1BD` / `SM_LOCK_MLO_APPROVAL_SLA_30MIN` | Your loan officer is reviewing — expected by | clock |
| `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` | Updated Loan Estimate arrives by | business days |
| `SM_LOCK_EXPIRY_WARN_7` / `SM_LOCK_EXPIRY_DEADLINE` | Rate lock expires | calendar |
| `REGB_1002_9_DECISION_30` | Decision on your application by | calendar days |
| `REGB_1002_9_NOIA` / `REGB_1002_9C2_NOIA_RESPONSE` | We need the missing items by | calendar days |
| `REGB_1002_9_COUNTEROFFER_90` | Counteroffer open until | calendar days |
| `SM_NEEDS_LIST_BORROWER_RESPONSE_5` | Please send by | business days |
| `SM_DOC_EXPIRY_WARN_14` / `FNMA_B1_1_03_CREDIT_DOCS_4M` / `SM_CREDIT_EXPIRY_WARN_21` | A document is about to go out of date — we may ask again | calendar |
| `SM_UW_DECISION_VALIDITY` | Your approval is valid through | calendar |
| `REGB_1002_14_APPRAISAL_COPY_3BD_GATE` / `REGB_1002_14_APPRAISAL_COPY_PROMPT_7` | Appraisal copy to you by | business days |
| `FNMA_B4_1_3_12_ROV_TURNTIME_5BD` | Appraiser's response to your value review by | business days |
| `FDPA_4104A_FLOOD_NOTICE_GATE` / `SM_FLOOD_NOTICE_DELIVER_1BD` | Flood notice to you by | — |
| `SM_O62_CD_TARGET_4SBD` | Closing Disclosure to you by | specific business days (Sundays and federal holidays don't count) |
| `REGZ_1026_19F1_CD_3SBD_GATE` (`earliest_consummation_date`) | Earliest closing date | specific business days |
| `REGZ_1026_19F1III_CD_MAILBOX_3SBD` | Closing Disclosure counts as received on | specific business days |
| `closings.scheduled_at` (column) | Closing appointment | local time |
| `REGZ_1026_23_RESCISSION_3SBD_GATE` (`expires_at`) | Cancel window ends (midnight) | specific business days |
| `SM_O73_POST_RESCISSION_FUNDING_1BD` / `fundings.earliest_funding_date` | Funding expected | business days |
| `FNMA_B2_1_5_FIRST_PAYMENT_2M` / `SM_O64_FIRST_PAYMENT_LETTER_5BD` / `_PREDUE_20` | First payment due · First-payment letter | calendar |
| `REGX_1024_17G_INITIAL_STMT_45` | Initial escrow statement by | calendar days |
| `SM_ORIG_FIRST_STATEMENT_LEAD_15` | First statement by | calendar |
| `REGZ_1026_39_OWNERSHIP_NOTICE_30` | Fannie Mae ownership letter expected by | calendar days |
| `SM_REFI_OPPORTUNITY_EXPIRY_30` | Offer good through | calendar days |
| `SM_LEAD_INACTIVITY_EXPIRY_90` | We'll close this conversation on | calendar days |
| Servicing: payment due date, `due_date + grace_days`, autodraft `next_draft_on`, `REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45`/`REGX_1024_17I_ANNUAL_STMT_30`, PMI `HPA_4902B_AUTO_TERMINATE_0` scheduled date, ARM change date, `REGZ_1026_36C3_PAYOFF_STMT_7BD`, `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`, RFI/NoE ack and response dates (4.1/4.2), `REGX_1024_41E1_ACCEPT_14`, `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW`, hello/goodbye and 60-day protected window (17.x) | per 08–10 | as stated in each |

##### 6. Security and privacy

- Party scoping on every read: `party_id` ∈ the subject's `application_borrowers`/`borrowers` or a `parties` row with `party_role ∈ {confirmed_successor, poa, authorized_third_party, executor}` and scope; `potential_successor` sees only 4.4 correspondence.
- `applicant_demographics` is write-once from the borrower's own card and never read back into the UI (restricted table with access logging — 21.1).
- SSN is captured once (L3 flow), transmitted to the `api` over TLS, never echoed except as last four; account numbers likewise.
- DU findings, `du_findings_interpretations`, `risk_assessment`, fraud flags, QC holds, compliance test runs: never serialized to the client. Only derived `conditions` and decision notices are.
- Credit report contents are never displayed; the score notice (`NTC_FCRA_609G_CREDIT_SCORE`) is.
- Documents are served through signed, short-lived URLs bound to the session; downloads are logged to `ui_events{document_opened}`.
- Content Security Policy: vendor SDKs (Stripe, Plaid, Truv, RON provider) loaded only on their `ConnectCard`/`HandoffCard` routes.
- Retention of UI-owned tables follows the owning record's class (`sm_lead_36m` for pre-application conversations; `fnma_loan_file_life_plus_4y` once an application exists — 31.3).

##### 8. Feature flags consumed

`origination.ai_mlo_intake ∈ {assisted, autonomous}` (renders/omits `terms_review`, `pending_mlo`, `pending_mlo_approval` states) · `origination.preapproval_program` (default on) · `closing.enote_default` (26.1) · `case.ai_path` · `theme ∈ {dark, light}` · `voice.in_app` · connector vendor toggles per §22 open questions · `jurisdiction_rules` (state copy: CO pre-use notice, UT/CA chatbot disclosure, TX 50(a)(6), NY CEMA, MA borrower-interest).

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

##### 7. API surface (internal REST, OpenAPI in `api`)

```
GET  /v1/borrower/me                         → party, sessions.level, subjects[]
GET  /v1/borrower/record?subject=…           → borrower_record
GET  /v1/borrower/thread?after=…             → thread_messages (paged)
GET  /v1/borrower/stream                     → SSE (§3)
POST /v1/borrower/messages                   → borrower text → borrower-comms / intake agent
POST /v1/borrower/cards/{id}/resolve         → card resolution → mapped command (§2); idempotency = card_instance_id
POST /v1/borrower/commands/{name}            → direct commands not tied to a card (human.request, refi.request, case.open)
GET  /v1/borrower/documents/{id}             → signed URL
POST /v1/borrower/documents                  → upload (multipart) → 22.1
POST /v1/borrower/auth/otp | /passkey        → L1
POST /v1/borrower/identity/stripe/session    → Stripe Identity session; webhook /v1/webhooks/stripe
POST /v1/borrower/connect/{vendor}/session   → Plaid/Truv/IRS link tokens; webhooks /v1/webhooks/{vendor}
GET  /v1/borrower/deeplink/{token}           → resolves target after L1
POST /v1/borrower/voice/session              → WebRTC token via telephony adapter
```
Errors carry `{code, gate?, copy_key}`; the UI renders `copy_key`. Rate limits and audit per baseline §2 security.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

##### 5. Notices and documents — codes the UI renders

Origination (O-addendum §6): `NTC_REGZ_1026_37_LE`, `NTC_REGZ_1026_38_CD`, `NTC_REGZ_1026_38_CD_CORRECTED`, `NTC_REGX_1024_20_HCL`, `NTC_REGX_1024_6_TOOLKIT`, `NTC_REGX_1024_15_AFBA`, `NTC_REGB_1002_14_APPRAISAL_NOTICE`, `NTC_FCRA_609G_CREDIT_SCORE`, `NTC_REGV_1022_74_RBP_EXCEPTION`, `NTC_REGZ_1026_19B_ARM_PROGRAM`, `NTC_REGZ_1026_19B_CHARM`, `NTC_GLBA_1016_4_PRIVACY_INITIAL`, `NTC_REGB_1002_9_APPROVAL`, `NTC_REGB_1002_9_ADVERSE_ACTION`, `NTC_REGB_1002_9_NOIA`, `NTC_REGB_1002_9_COUNTEROFFER`, `NTC_REGZ_1026_23_H8`, `NTC_REGZ_1026_23_H9`, `NTC_HPA_4903_INITIAL_FIXED`, `NTC_HPA_4903_INITIAL_ARM`, `NTC_HPA_4905_LPMI`, `NTC_FDPA_4104A_FLOOD_NOTICE`, `NTC_REGX_1024_17G_INITIAL_ESCROW_STMT`, `NTC_REGZ_1026_39_OWNERSHIP_TRANSFER` (Fannie Mae-sent; shown as *expected/received*), `NTC_SM_FIRST_PAYMENT_LETTER`, `NTC_SM_ESIGN_CONSENT`, `NTC_FNMA_1103_SCIF`, `NTC_TX_50A6_12DAY`, `NTC_TX_50A6_ITEMIZATION`, `NTC_SM_NEEDS_LIST`, `NTC_SM_NEEDS_LIST_REMINDER`, `NTC_CO_SB26_189_ADMT_NOTICE`, `NTC_REGZ_1026_24_REFI_OFFER`.
Servicing: `NTC_ESIGN_7001C_DISCLOSURE`, `NTC_ESIGN_CONSENT_CONFIRMATION`, `NTC_ESIGN_VERIFICATION_EMAIL`, `NTC_ESIGN_WITHDRAWAL_CONFIRMATION`, `NTC_EDELIVERY_BOUNCE_PAPER_RESUME`, `NTC_IRS_ESTATEMENT_CONSENT_DISCLOSURE`, `NTC_TCPA_CONSENT_CONFIRMATION`, `AUTODRAFT-CONFIRM-v1`, `AUTODRAFT-AMOUNT-CHANGE-v1`, `AUTODRAFT-RETURN-v1`, periodic statement (7.1), annual/short-year escrow statements (3.3), ARM notices (7.2), force-placed insurance notices (9.x), PMI annual disclosure and cancellation/denial notices (10.x), `NTC_REGX_35C_ADDRESS`, `NTC_REGX_35D_ACK`, `NTC_REGX_35E_*`, `NTC_REGX_36A2_OWNER_IDENTITY`, `NTC_REGX_38B5_PROCEDURES`, `NTC_REGZ_36C3_PAYOFF_STMT` (+ CA/FL variants), `NTC_PAYOFF_REQUEST_ACK_DELAY`, `NTC_PAYOFF_UPDATED_STMT`, early-intervention notice (11.2), Borrower Solicitation Package (D2-2-04), loss-mitigation acknowledgments/evaluation notices (12.x), `NTC_FNMA_D23204_DEFERRAL_OFFER`, hello/goodbye notices (1.3/17.2).

Viewer rules: render the PDF from `notices.rendered_document_id` / `disclosures.rendered_document_id`; show template version and delivery evidence in a footer; **Confirm receipt** appears only where the build spec requires receipt (`disclosures.requires_ack`); a notice delivered by mail shows *Mailed {{date}}* and no receipt action; plain-language block = the template's own `plain_language` field, never assistant paraphrase.

#### AI agent design (AI-first)
`borrower-app` agent (tools: `lead.start`, `lead.acknowledgeAiDisclosure`, `party.authenticate`, `party.startIdentity`, `consent.capture`, `credit.authorize`, `application.confirmField`, `application.setGoal`, `application.answerDeclarations`, `application.answerDemographics`, `application.affirmJointIntent`, `application.inviteParty`, `verification.connect`, `document.upload`, `explanation.submit`, `disclosure.acknowledgeReceipt`, `intent.record`, `lock.request`, `lock.requestExtension`, `counteroffer.respond`, `application.withdraw`, `mi.selectPlan`, `valuation.scheduleAccess`, `rov.request`, `insurance.submitEvidence`, `closing.selectSlot`, `closing.captureEsignConsent`, `rescission.exercise`, `autodraft.enroll`, `autodraft.change`, `autodraft.pause`, `autodraft.revoke`, `payment.makeOneTime`, `payment.extraPrincipal`, `escrow.electShortage`, `escrow.requestWaiver`, `pmi.requestCancellation`, `case.open`, `lossmit.requestAssistance`, `lossmit.respondToOffer`, `lossmit.appeal`, `offer.respond`, `refi.request`, `human.request`, `party.updateContact`). End-to-end: the borrower-app is the command surface of the borrower experience — every tool is one UX command of §2, issued by a card resolve or a direct endpoint (§7) with idempotency key = `card_instance_id`, checked by the owning handler against the gate named in the §2 table, and refused with {code, gate, copy_key}; the agent proposes nothing, decides nothing and computes no regulatory date. Decision record schema: {command, card_instance_id, party_id, subject, gate, outcome, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: no command bypasses its gate; money fields (`payment.makeOneTime`, `payment.extraPrincipal`, autodraft amounts, `escrow.electShortage`) require a fresh L1 code within 10 minutes and never an agent-side waiver — `officer` only; `applicant_demographics` is write-once from the borrower's own card and never read back; DU findings, credit-report contents, fraud, QC and compliance internals are never serialized to the client (§6). Escalations: `human_agent` for `human.request`, `mlo_of_record` for `lock.request` approval, `officer` for money-field waivers, `underwriting_reviewer` never from the client.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

#### Test cases and acceptance criteria
No T-numbered tests are assigned to this process by the UX package; its behaviour is asserted by 32.13's cross-cutting tests (32.13-T1…T16) and by the per-screen tests of 32.3–32.12 that exercise it.

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**
2. Names the UX spells differently from the platform (Discrepancies above). **Default: the platform spelling; the UX maps at the SSE boundary and docs/ux/BACKEND-DELTAS.md records each.**

### Sources
- docs/ux/02-data-contracts.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections every section whose tables the projections read (1–19, 20–31); the seven UI-owned tables are the only new schema (spec/sections/)
