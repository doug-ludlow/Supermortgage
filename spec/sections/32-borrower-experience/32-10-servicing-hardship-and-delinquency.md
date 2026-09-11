# 32.10 — Servicing: hardship and delinquency

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower asks for help, responds to offers and appeals by card; the `default-collections` and `lossmit-underwriter` agents run the owning processes; `lossmit_reviewer` approves denials |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On `loan.delinquency.day_reached{n}`; on a hardship message; on every `lossmit.*`, `workout_plans.*`, foreclosure and bankruptcy event |
| Governing source | Projection of sections 11.1–11.5 (early intervention, QRPC, Reg F, imminent default), 12.1–12.9 (loss mitigation), 13 (foreclosure), 14 (bankruptcy), 4.3 (continuity of contact), 8.x, 7.1 |
| Key deadlines | renders `REGX_1024_39A_LIVE_CONTACT_36`, `REGX_1024_41E1_ACCEPT_14`, `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW`, `REGX_1024_41F1_120_DAY_GATE` (owned by 11.x / 12.x / 13.x) |
| Timers | — |

### Blueprint row
Projection of sections 11.1–11.5 (early intervention, QRPC, Reg F, imminent default), 12.1–12.9 (loss mitigation), 13 (foreclosure), 14 (bankruptcy), 4.3 (continuity of contact), 8.x, 7.1. Owner specs: 11.1 (live contact), 11.2 (written early intervention, Borrower Solicitation Package), 11.3 (QRPC), 11.4 (FDCPA/Reg F), 11.5 (imminent default), 12.1 (intake and completeness), 12.2 (evaluation and notices), 12.3 (appeals), 12.4 (forbearance), 12.5 (repayment plans), 12.6/12.7 (payment deferral, disaster), 12.8 (Flex Modification), 12.9 (short sale, mortgage release), 13 (foreclosure), 14 (bankruptcy), 4.3 (continuity of contact), 8.x (credit reporting during hardship), 7.1 (statement variants). (Imported from docs/ux/08c-servicing-hardship-delinquency.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 08c is 32.10 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 11.1–11.5 (early intervention, QRPC, Reg F, imminent default), 12.1–12.9 (loss mitigation), 13 (foreclosure), 14 (bankruptcy), 4.3 (continuity of contact), 8.x, 7.1** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: none beyond 32.2's list.

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On `loan.delinquency.day_reached{n}`; on a hardship message; on every `lossmit.*`, `workout_plans.*`, foreclosure and bankruptcy event. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `loan_terms`, `lossmit_applications`, `lossmit_facts`, `workout_plans`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `REGX_1024_39A_LIVE_CONTACT_36` (1.1), `TCPA_64_1200_A1_CELL_CONSENT_GATE` (11.1), `REGX_1024_41F1_120_DAY_GATE` (1.7), `REGX_1024_41G_DUAL_TRACK_GATE` (13.2), `REGX_1024_41E1_ACCEPT_14` (12.2), `SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW` (12.6), `FNMA_B101_ESCROW_ANALYSIS_BEFORE_OFFER` (12.6).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 0. Two doors, one flow

Hardship enters either **proactively** (a missed payment starts the 11.x cadence) or **on request** ("I lost my job", any channel). Both land in the same intake (12.1) and the same set of cards. The design intent — hardship in a few messages — is legal because the specs already make the intake conversational: the QRPC dialog (11.3) captures the reason, whether it's temporary or permanent, the borrower's intent, and ability to pay; that record plus any evaluative information **is** a loss-mitigation application (12.1). The written notices then follow as cards; the borrower never fills a form to be heard.

##### 1. Missed payment — the cadence (11.1, 11.2, 7.1)

| Day (from due date; `regx_days_delinquent` where the rule is Reg X) | Platform | Thread |
|---|---|---|
| grace end | late charge assessed (32.8 §3.6) | `StatusCard` "Past due. If something's changed, tell me — there are options." |
| Fannie Mae reminder day | `NTC_FNMA_D2_2_03_PAYMENT_REMINDER` | `NoticeCard` |
| ≤ 36 | good-faith **live contact** attempts (`REGX_1024_39A_LIVE_CONTACT_36`): AI voice only with `tcpa_voice` informational consent (`TCPA_64_1200_A1_CELL_CONSENT_GATE`), else human dialer or SMS/e-mail with the deep link; `live_contact.ai_voice_counts` flag decides whether the AI call satisfies the duty | call/text: "This is Supermortgage's automated assistant for your loan at {{address}}… (disclosure). Your payment due {{date}} hasn't arrived. Can we talk about what's going on?" → the QRPC dialog (§2) |
| ≤ 45 | **written early-intervention notice** `NTC_REGX_39B_EARLY_INTERVENTION` (variants `_BK`, `_FDCPA`, `_BK_FDCPA`) and **continuity of contact** assigned (`NTC_REGX_40_CONTACT_ASSIGNED`; `pending_assignment → assigned`) | `NoticeCard` + `PersonCard{continuity_of_contact_team}` with the direct number ("your team: {{team}} — reach them at {{number}}") |
| QRPC achieved without resolution, or no QRPC by the D2-2-04 day | **Borrower Solicitation Package** `NTC_FNMA_D2204_SOLICITATION_PACKAGE` (Form 745 letter `NTC_FNMA_D2204_SOLICITATION_LETTER_745`, Form 710 or its data equivalent) | `NoticeCard` + `ChoiceCard` "Start a request for help" (opens §3 without re-asking what QRPC already captured) |
| 60 · 90 | statement variant `NTC_REGZ_41_STMT_DELQ` with the delinquency block; monthly inspections may be suspended while QRPC is < 30 days old and the home is occupied (9.x) | statement `DocumentCard`; badge "Behind {{n}} days" |
| 120 | `REGX_1024_41F1_120_DAY_GATE`: no first foreclosure notice/filing before day 120 and never while a complete application is pending (`REGX_1024_41G_DUAL_TRACK_GATE`) | see §8 |

Contact rules the UI enforces: quiet hours 08:00–21:00 borrower local for calls/texts (Reg F where applicable; 11.1); frequency caps; STOP/cease honored; a `cease_communication` request keeps inbound open and stops outbound collection (`NTC_REGF_1006_6C_CEASE_ACK`). Reg F validation notice (`NTC_REGF_1006_34_VALIDATION_B1`) only for loans in default when acquired (11.4).

##### 2. The hardship conversation (QRPC — 11.3, 11.5)

The assistant collects, in conversation and in any order: the reason and whether it's temporary or permanent; occupancy; whether the borrower wants to keep the home; what they can pay and when; contact preferences. The record is `contact.qrpc.achieved{reason, temporary|permanent, intent, ability}` plus a `NTC_SM_QRPC_SUMMARY` receipt (what we understood) as a `ConfirmCard` the borrower can correct. When the borrower is current or < 60 days and reports a hardship, 11.5 imminent-default evaluation runs (`NTC_SM_ID_ELIGIBILITY_RESULT`) — the assistant says whether early help is available.

Guardrails from 11.3/4.3: the AI never guesses a §1024.40(b) fact — if a fact isn't in `lossmit_facts` it says it will confirm and schedules a callback (`NTC_SM_CALLBACK_CONFIRMATION`); distress or abuse keywords → human; "human" → warm transfer to the assigned team, not a random agent.

##### 3. Request for help → application (12.1)

`lossmit_applications.status`: `rfa_only → received → incomplete | complete | duplicative | pending_sii_confirmation`.

- Any request for help with no evaluative information is `rfa_only` (`NTC_REGX_41_NPRM_RFA_RECEIVED` only under the NPRM rule set — the UI reads `rule_set`); the first hardship reason, income figure or expense turns it into `received`.
- **Acknowledgment ≤ 5 days** (excluding weekends/holidays): `NoticeCard{NTC_REGX_41B2_ACK_INCOMPLETE}` with the missing list and the reasonable date (Dates: "send these by {{reasonable_date}}") or `NTC_REGX_41B2_ACK_COMPLETE`. California `NTC_CA_2924_10_ACK` where applicable.
- The **needs list** reuses 32.5 §1: income (`ConnectCard{truv_income}` or `UploadCard{paystub}`), hardship documents by reason (`UploadCard`s: termination letter, medical bills, divorce decree, death certificate, disaster evidence), Form 710 data captured as `ConfirmCard`s (the platform prefills from the servicing record — address, loan, escrow — and from any connected sources; Form 710's borrower attestation is a `ConsentCard{blanket_verification_authorization}` + signature). Supplemental requests `NTC_REGX_41B2_SUPPLEMENTAL_REQUEST`; closed for incompleteness `NTC_REGX_41B2_INCOMPLETE_CLOSED` (with the date the borrower was told).
- `complete` → `NTC_REGX_41C3_COMPLETE` (unless exception) and Dates "decision by {{+30 days}}" (`assertWithin30Days`).
- **Protections shown:** `protection_tier ∈ {ge_90, gt_37, le_37}` renders as one plain sentence when a foreclosure sale date exists ("because your complete application arrived more than 37 days before the sale, the sale can't proceed while we review it"); `foreclosure_holds{kind=lm_*}` are invisible except as that sentence.
- Duplicative applications (`NTC_REGX_41I_DUPLICATIVE`) get the Fannie Mae evaluation anyway (12.1); the card says so.

##### 4. Evaluation and offer (12.2)

`lossmit_evaluations.status`: `queued → gathering_third_party → evaluating → decision_drafted → (reviewer_pending) → decided → notice_provided → awaiting_response → accepted | rejected | deemed_rejected | appealed | withdrawn`; side `fnma_referral_pending`, `third_party_delay_notice_sent` (`NTC_REGX_41C4IIB_THIRD_PARTY_DELAY`).

- Every denial or removal of rights passes `lossmit_reviewer` (independent; NY supervisory) before the notice — invisible except in timing.
- **Offer** — `NoticeCard{NTC_REGX_41C1_OFFER}` (the Fannie Mae Evaluation Notice: `NTC_FNMA_EVAL_NOTICE_STREAMLINED` for streamlined offers) + a `ComparisonCard` of the options offered, each with: what it does, the new payment or the paused period, what happens at the end, credit-reporting effect (8.x coding), and the acceptance deadline (`REGX_1024_41E1_ACCEPT_14`: 14 days, or 7 for late-stage). `lossmit.respondToOffer` → `accepted` / `rejected`; silence → `deemed_rejected` (the card says that plainly). Short-term options carry `NTC_REGX_41C2III_SHORTTERM_TERMS`.
- **Denial** — `NoticeCard{NTC_REGX_41C1_DENIAL}` with the specific reasons, the appeal right and window (`NTC_REGX_41H_APPEAL_ACK` on receipt; 14 days), and — where a credit decision is involved — `NTC_REGB_1002_9_LM_ADVERSE_ACTION`; Colorado `NTC_CO_AI_ACT_PRE_DECISION` where the AI act applies (reasons, correction, human review). Fannie Mae's own decline (F-1-24) → `NTC_FNMA_D2330x_FNMA_DECLINED` as 12.9 names it.
- **Appeal (12.3)** — `lossmit.appeal` from the denial card within 14 days → `received → eligibility_checked → under_review (human reviewer) → decided_granted | decided_denied → notice_provided` (`NTC_REGX_41H4_APPEAL_GRANTED` / `_DENIED`; 30-day decision); `NTC_REGX_41H_APPEAL_INELIGIBLE` when out of window or a second appeal on the same determination. Foreclosure holds during appeal are invisible except as the protection sentence.

##### 5. The options as the borrower experiences them

| Option (spec) | Card set | States and notices |
|---|---|---|
| **Forbearance** (12.4; `workout_plans`) | `ChoiceCard` accept (verbal/written/first payment counts) → plan `offered → active`; Loan section "Payments paused through {{date}} · plan payment {{money}}" | `NTC_FNMA_D23201_FORB_PLAN`; increments ≤ 3 months, cumulative ≤ 12 (LL-2026-01) — the card states the limits; extension `NTC_FNMA_D23201_FORB_EXTENSION`; at expiry `NTC_FNMA_D23201_FORB_EXPIRY_OPTIONS` → `disposition_pending` with a `ComparisonCard` of exits (reinstate · repayment plan · deferral · Flex Mod · payoff); termination `NTC_FNMA_D23201_FORB_TERMINATION`; post-forbearance solicitations `NTC_FNMA_D23204_SOLICIT_POST_FORB` |
| **Repayment plan** (12.5) | `ComparisonCard` of schedules (≤ 150% of the payment; ≤ 12 months or Fannie Mae approval) → `offered → active → completed | failed` | `NTC_FNMA_D23202_REPAY_PLAN`, `_COMPLETED`, `_FAILED`; solicitations `NTC_FNMA_D23204_SOLICIT_POST_REPAY`, `NTC_FNMA_D23205_SOLICIT_POST_REPAY` |
| **Payment deferral** (12.6) | one-tap acceptance; the missed payments move to the end as a non-interest-bearing balance | `NTC_FNMA_D23204_DEFERRAL_OFFER` (`SM_DEFERRAL_SOLICIT_ACCEPT_WINDOW` through month-end, ≥ 14 days); `screened_eligible → offered → accepted → (awaiting_contractual_payment) → pending_smdu_entry → completed → agreement_sent → documented → closed`; `NTC_FNMA_D23204_DEFERRAL_COMPLETED`; the agreement is a `DocumentCard`; `FNMA_B101_ESCROW_ANALYSIS_BEFORE_OFFER` runs first (an escrow statement may precede the offer) |
| **Disaster forbearance / deferral** (12.7) | proactive after a declaration; `ChoiceCard` | `NTC_FNMA_D23205_DISASTER_DEFERRAL_OFFER`, `NTC_FNMA_D23205_SOLICIT_POST_DISASTER_FORB`; `fnma_prior_approval_pending` shows as "waiting on Fannie Mae's approval" |
| **Flex Modification** (12.8) | `NoticeCard{NTC_FNMA_D23206_TPP_OFFER}` + `ChoiceCard`; the **first trial payment by its due date is the acceptance**; Loan section "Trial payment {{n}} of 3 — {{money}} due {{date}}"; statement variant `NTC_REGZ_41_STMT_TPP`; after the third: `docs_out` → Form 3179 as a `DocumentCard` (signature; notarization where required) → `borrower_executed → servicer_executed → effective` (new `loan_terms`; capitalization shown once) | `eligible → tpp_offered → tpp_active → tpp_completed → docs_out → borrower_executed → servicer_executed → effective → recorded → closed`; `tpp_failed` on a month-end miss (12-month bar on a new Flex Mod trial stated plainly); streamlined solicitation `NTC_FNMA_D23206_SOLICIT_STREAMLINED` |
| **Short sale / mortgage release** (12.9) | offered when retention isn't possible or the borrower asks; `ChoiceCard` + `HandoffCard{listing agent}`; relocation assistance and the exit option (immediate · 3-month transition · 12-month lease) as a `ComparisonCard` | short sale `eligible → listing → offer_received → offer_acknowledged (NTC_FNMA_D23301_SS_OFFER_ACK) → under_review → approved | countered | declined → closing_scheduled → closed → liquidated`; mortgage release `eligible → offered (NTC_FNMA_D23302_DIL_OFFER) → accepted → documenting → deed_received → deed_recorded → released → reo_conveyed` |
| **Late BRP plan** (D2-2-05) | as forbearance/repayment | `NTC_FNMA_D2205_LATE_BRP_PLAN` |

Trial and plan cashiering (2.6): the `PaymentCard` default becomes the plan amount; late charges `accrued_suspended` are shown as "on hold while you're on the plan" and waived on completion; autopay is re-authorized for the plan amount (variable-amount notice or a fresh `ConsentCard`).

##### 6. Credit reporting during hardship (8.x)

The offer and plan cards state the reporting effect in one line each (forbearance/deferral coded per Metro 2 and CARES-style rules as 8.x specifies; a completed plan; a modification). Suppression during an NoE investigation (32.9 §5.2) also applies here.

##### 7. Disaster (9.x, 12.7, D1-3-01)

A declaration covering the property triggers: a proactive check-in `StatusCard`; inspection where required (9.x) with a `ScheduleCard` if access is needed; the disaster forbearance offer without a full application where the Guide allows; insurance loss-draft flow (32.9 §1). Foreclosure referral in a disaster area requires Fannie Mae's prior written approval (LL-2026-01) — the borrower only sees "on hold".

##### 8. Foreclosure — what the borrower sees (13.x)

Only after day 120, no complete application pending, and every state pre-foreclosure notice sent (`NTC_STATE_PREFC_*` — e.g., `NTC_STATE_PREFC_CA_2923_5_LETTER`, `NTC_STATE_PREFC_NY_1304`, `NTC_STATE_PREFC_TX_51002D`, `NTC_STATE_PREFC_MD_NOI`, `NTC_STATE_PREFC_NJ_NOI`, `NTC_STATE_PREFC_GA_162_2`, `NTC_STATE_PREFC_MA_35A`, `NTC_STATE_PREFC_NV_107_5XX`, `NTC_STATE_PREFC_WA_61_24_031_LETTER`) and the breach letter per the security instrument, `NTC_SM_FC_REFERRAL_ADVICE` renders as a `NoticeCard`: what has happened, that help remains available (a loss-mitigation application can still be submitted and, if complete ≥ 37 days before a sale, stops it — `REGX_1024_41G_DUAL_TRACK_GATE`), the reinstatement path (`NTC_SM_FC_REINSTATEMENT_QUOTE` on request — a `ChoiceCard` "How much to bring the loan current?"), and the continuity team. Badge "In foreclosure". Attorney-of-record correspondence appears in Documents. SCRA protections (`NTC_FNMA_D23401_SCRA_RIGHTS`, `NTC_SCRA_3953_STAY_CONFIRMATION`, `NTC_SCRA_3937_RATE_CONFIRMATION`/`_RATE_END`/`_OVERPAYMENT_ELECTION`) render when the borrower's status triggers them. Sale, REO, eviction and expense processes are invisible; a sale date is shown in Dates once set.

##### 9. Bankruptcy — what the borrower sees (14.x)

On `bankruptcy_notice` (from the borrower, counsel or PACER): badge "Bankruptcy — protections in effect"; all collection outreach stops; statements switch to `NTC_REGZ_41_STMT_BK7_11` / `_BK12_13` or are suppressed per the debtor's election (the assistant offers the election as a `ChoiceCard` where the rule allows); `NTC_BK_PAYMENT_INSTRUCTIONS` (where to pay post-petition installments; trustee vs direct), `NTC_BK_STATUS_INFO`, `NTC_BK_BREACH_INFORMATIONAL` render as informational `NoticeCard`s with no collection language; the early-intervention BK variant applies; autopay `paused` unless the plan or counsel authorizes; escrow changes wait for the Chapter 13 gate (32.8 §6.2). Payoff requests run on the reasonable-time path (`NTC_PAYOFF_REQUEST_ACK_DELAY`). Counsel is copied where required; the borrower's own thread stays open for questions.

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

#### AI agent design (AI-first)
`borrower-comms` agent owns the post-funding thread for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.10-T1 | Given a payment due Sep 1, 2026 unpaid, then live-contact attempts are logged by Oct 7 (day 36) using only channels with consent, the EI notice and continuity assignment exist by Oct 16 (day 45), and the `PersonCard` shows a reachable direct number (4.3 T1). |
| 32.10-T2 | Given the borrower types "I lost my job and can't pay next month" while current, then a QRPC record and an 11.5 imminent-default evaluation exist, and a `lossmit_applications` row is `received` (evaluative information present) with the 5-day ack. |
| 32.10-T3 | Given an incomplete application, then `NTC_REGX_41B2_ACK_INCOMPLETE` lists the missing items and the reasonable date, and the same items appear in Needed-from-you. |
| 32.10-T4 | Given a complete application received 40 days before a scheduled sale, then the Thread shows the protection sentence and `REGX_1024_41G_DUAL_TRACK_GATE` blocks the sale internally. |
| 32.10-T5 | Given an offer notice on Nov 2, then Dates shows the 14-day acceptance deadline; silence → `deemed_rejected` on Nov 17 with the copy that said so on Nov 2. |
| 32.10-T6 | Given a Flex Mod TPP offer, then the first trial payment received by its due date moves the case to `tpp_active` without any other tap, and the `PaymentCard` default equals the trial amount. |
| 32.10-T7 | Given a forbearance plan, then the Loan section shows the paused period; a request beyond 12 cumulative months is refused with the LL-2026-01 copy; expiry renders the exit `ComparisonCard`. |
| 32.10-T8 | Given a denial, then `NTC_REGX_41C1_DENIAL` renders with specific reasons and the appeal link; an appeal on day 15 → `NTC_REGX_41H_APPEAL_INELIGIBLE`. |
| 32.10-T9 | Given a bankruptcy notice, then the badge changes, outbound collection stops, the statement variant switches, and `NTC_BK_PAYMENT_INSTRUCTIONS` renders without collection language. |
| 32.10-T10 | Given day 121 with no pending application and all state notices sent, then `NTC_SM_FC_REFERRAL_ADVICE` renders with the help-still-available paragraph and the reinstatement `ChoiceCard`. |
| 32.10-T11 | Given a `cease_communication` request on an FDCPA-covered loan, then outbound collection messages stop within the 11.4 window and the Thread confirms with `NTC_REGF_1006_6C_CEASE_ACK`; inbound remains open. |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/08c-servicing-hardship-delinquency.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 11.1–11.5 (early intervention, QRPC, Reg F, imminent default), 12.1–12.9 (loss mitigation), 13 (foreclosure), 14 (bankruptcy), 4.3 (continuity of contact), 8.x, 7.1 (spec/sections/)
