# 1.7 — Loss-mit in-flight transfer handling

| Attribute | Value |
|---|---|
| Section | 1 — Boarding / Servicing Transfer-In |
| Automation class | b |
| Trigger & frequency | Complete app pending at transfer |
| Governing source | Reg X 1024.41(k) |
| Key deadlines | Continue prior deadlines; acknowledge within 10 days of transfer if ack period not expired |
| Timers | `FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M`, `REGX_1024_41B2_ACK_5_DEEMED_T0`, `REGX_1024_41C1_EVAL_30_CARRYOVER`, `REGX_1024_41F1_120_DAY_GATE`, `REGX_1024_41H_APPEAL_WINDOW_14`, `REGX_1024_41K2_NO_FIRST_FILING_GATE`, `REGX_1024_41K2_TRANSFEREE_ACK_10`, `REGX_1024_41K3_COMPLETE_APP_EVAL_30`, `REGX_1024_41K4_APPEAL_DETERMINATION_30`, `REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE`, `SM_LOSSMIT_FILE_VERIFY_T0`, `SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2`, `SM_SMDU_CASE_ACCESS_T0` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Boarding |
| Trigger & frequency | Complete app pending at transfer |
| Governing source (blueprint) | Reg X 1024.41(k) |
| Key deadlines (blueprint) | Continue prior deadlines; acknowledge within 10 days of transfer if ack period not expired |
| Data/artifacts | Loss-mit file |
| Systems | SMDU [cropped in source] |
| Automation class (blueprint) | [cropped in source] — treated as (b): AI evaluates; `lossmit_reviewer` approves adverse determinations |
| SoR / Sub | [cropped in source] — Supermortgage performs under the partner's servicer number in SMDU |
| Nuances (blueprint) | [cropped in source] — reconstructed: (k)(3) resets the evaluation clock to 30 days from the transfer date; appeals; pending offers; foreclosure-filing prohibition; applications not previously subject to §1024.41 |

### Verified requirement (as of 2026-09-09)

**§1024.41(k)** (eCFR current as of Sept. 4, 2026): **(k)(1)(i)** — a transferee that acquires servicing of a loan with a pending loss-mitigation application "must comply with the requirements of this section for that loss mitigation application within the timeframes that were applicable to the transferor servicer based on the date the transferor servicer received the loss mitigation application," and all (c)–(h) protections continue. **(k)(1)(ii)** — "the transfer date is the date on which the transferee servicer will begin accepting payments relating to the mortgage loan, as disclosed on the notice of transfer of loan servicing pursuant to §1024.33(b)(4)(iv)." **(k)(2)(i)** — if the period to provide the §1024.41(b)(2)(i)(B) acknowledgment "has not expired as of the transfer date and the transferor servicer has not provided such notice," the transferee "must provide the notice within 10 days (excluding legal public holidays, Saturdays, and Sundays) of the transfer date." **(k)(2)(ii)(A)** — the transferee "shall not make the first notice or filing required by applicable law for any judicial or non-judicial foreclosure process until a date that is after the reasonable date disclosed to the borrower" under (b)(2)(ii), and a complete application by that date is treated as submitted during the (f)(1) pre-foreclosure review period; **(k)(2)(ii)(B)** — if the borrower submits a complete application by the reasonable date but 37 or fewer days before a sale, the transferee must still comply with (c), (d) and (g). **(k)(3)** — "If a transferee servicer acquires the servicing of a mortgage loan for which a complete loss mitigation application is pending as of the transfer date, the transferee servicer must comply with the applicable requirements of paragraphs (c)(1) and (4) within 30 days of the transfer date." **(k)(4)** — for an appeal unresolved at transfer or timely filed after it, the transferee "must make a determination on the appeal if it is able to do so or, if it is unable to do so, must treat the appeal as a pending complete loss mitigation application"; **(k)(4)(i)** the determination and (h)(4) notice are due "within 30 days of the transfer date or 30 days of the date the borrower made the appeal, whichever is later"; **(k)(4)(ii)** when unable, the application "shall be considered complete as of the date the appeal was received by the transferor servicer or the transferee servicer, whichever occurs first," and the transferee must evaluate "for all loss mitigation options available to the borrower from the transferee servicer." **(k)(5)** — a transfer "does not affect a borrower's ability to accept or reject" an offer; if the (e) or (h) acceptance period has not expired, "the transferee servicer must allow the borrower to accept or reject the offer during the unexpired balance of the applicable time period."

**Official interpretations** (Supplement I): 41(k)(1)(i)-1 — an application "is pending if it was subject to §1024.41 and had not been fully resolved before the transfer date" (a denial with an expired appeal period is not pending); "if an application was not subject to §1024.41 prior to a transfer, then for purposes of §1024.41(b) and (c), a transferee servicer is considered to have received the loss mitigation application on the transfer date"; the transferee must exercise reasonable diligence through the transfer, "including informing borrowers of process changes and required documentation"; documents the borrower submits to the transferor after transfer must be timely transferred and obtained. 41(k)(1)(i)-2 — "a transferee servicer must consider documents and information that constitute a complete loss mitigation application for the transferee servicer to have been received as of the date such documents and information were received by the transferor servicer"; facially complete stays facially complete; complete under the transferor's criteria but incomplete under the transferee's = facially complete as of the original date. 41(k)(1)(i)-3 — "a transferee servicer is not required to provide notices under §1024.41 ... that the transferor servicer provided prior to the transfer." 41(k)(2)(ii)-1 — example: application received at 101 days delinquent, transfer five business days later → no first filing until after the disclosed reasonable date. 41(k)(2)(ii)-3 — reasonable dates below 30 days but not below seven days when no milestones remain. 41(k)(3)-1/-2 — additional documents needed under the transferee's criteria do not defeat facial completeness; an application first complete upon transfer is pending complete as of the transfer date (30 days from transfer date). 41(k)(4)-1/-2 and 41(k)(5)-1 — appeals, acceptances and rejections given to the transferor after transfer must be transferred and honored; "the transferee servicer must permit the borrower to accept or reject any loss mitigation options offered by the transferor servicer, even if it does not offer" them.

**§1024.38(b)(4)** and comments 38(b)(4)(i)-2/(ii)-1: transfer must include "any information reflecting the current status of discussions with a borrower regarding loss mitigation options, any agreements entered into with a borrower on a loss mitigation option," and the transferee must retrieve missing loss-mit documents from the transferor (Bulletin 2020-02: "before asking the borrower for such information"; Appendix A §VII fields).

**Fannie Mae**: A2-7-03 — the transferee must "honor any forbearance agreements or other arrangements made with borrowers by the previous servicer"; the transferor must "identify ... any mortgage loans that are in foreclosure, bankruptcy, or subject to a workout option"; F-1-11 — "all pertinent information related to the status of any mortgage loan for which a workout option is being pursued." Workouts are decisioned and reported in SMDU (HSSN retired Dec. 1, 2025; research/00b F1); LL-2026-01 (eff. May 1, 2026): forbearance in ≤3-month increments with a 12-month cumulative cap from the initial start — the transferor's forbearance history must carry over (research/00a §3.2); Flex Mod trial periods and Form 3179 per D2-3.2-06/F-1-27 (12.8). SMDU case continuity across a change of servicer number is **[UNVERIFIED — no public procedure found; for master-to-sub/sub-to-sub moves the case stays under the partner's servicer number]**.

**Rule-set status**: the 2024 NPRM would replace the complete-application framework (research/00a §1.2); (k) logic here is bound to `regx.lossmit.2013`; the `regx.lossmit.2024nprm` variant would carry review-cycle status instead of completeness.

**Discrepancies vs blueprint**: (1) "Continue prior deadlines" is only the general rule — for a complete application pending at transfer, (k)(3) sets a fresh 30-day clock from the transfer date; (2) the 10-day acknowledgment is business days (excluding legal public holidays, Saturdays and Sundays), not calendar days; (3) the trigger is broader than "complete app pending" — incomplete applications, appeals, pending offers and trial plans are all in scope; (4) SMDU is the system for workouts, but the blueprint omits SMDU case access under the partner's servicer number and the LL-2026-01 forbearance carry-over.

### Operational prerequisites
- SMDU access under the partner's servicer number (Technology Manager roles; B2B System ID; Form 101 scope) — Partner + Supermortgage; before first transfer.
- Loss-mitigation rule set `regx.lossmit.2013` and Fannie Mae workout parameters (`fnma.flexmod.2024-12`, Modification Interest Rate exhibit, LL-2026-01 forbearance caps) versioned and loaded (12.x) — Supermortgage.
- `lossmit_reviewer` roster (separate evaluators and appeal reviewers per §1024.41(h)(3)); Colorado AI Act impact assessment for AI-assisted loss-mit decisions (research/00a §5.6) — Supermortgage.
- Retained default counsel network able to receive foreclosure-hold instructions before the transfer date (13.6) — Partner/Supermortgage.
- Transferor deliverable: loss-mitigation file per Bulletin 2020-02 Appendix A §VII (applications, documents, acknowledgments, denials, offers, agreements, trial plans, analysis) with received dates — Partner (contract).
- State licensing check for personnel who negotiate modification terms (`licensed_specialist`, keyed by `jurisdiction_rules`) — Supermortgage.

### Build spec
#### Inputs and triggers
- `transfer.tape.received{kind=lossmit}` and `fc_bk` (1.1) → in-flight case inventory.
- `loan.boarded{lossmit_in_process=true}` → `lossmit` case creation with `origin='transferor'`.
- Borrower submissions after the transfer date (to Supermortgage or forwarded from the transferor): `lossmit.document.received`, `lossmit.appeal.received`, `lossmit.offer.accepted/rejected`.
- Transferor post-transfer forwarding file of loss-mit correspondence (daily during the 60-day window).
- SMDU inbound: case status, trial-period plan status, decision outputs.
- Timer sweeps for the (k) timers.

#### Data model
- `cases{case_type='lossmit'}` with new columns: `origin` enum {`borrower`,`transferor`}, `transferor_received_at date`, `subject_to_1024_41_at_transferor boolean`, `completeness_status` enum {`incomplete`,`facially_complete`,`complete`}, `facially_complete_at`, `complete_at`, `transferor_ack_sent_at null`, `transferor_reasonable_date date null`, `transferor_determination jsonb null` (option(s), decision, sent_at, denial reasons), `appeal_received_at null`, `appeal_received_by` enum {transferor, transferee}, `offer jsonb null` ({option, offered_at, acceptance_deadline, terms}), `borrower_response` enum {none, accepted, rejected}, `trial_plan jsonb null` ({start_date, payment_cents, months, payments_received}), `forbearance_history jsonb` ({initial_start_date, cumulative_months, increments}), `deemed_received_at date` (computed: transferor receipt date, or transfer date if not previously subject to §1024.41), `evaluated_options jsonb`, `carryover_verified_at`.
- `lossmit_documents`: `case_id`, `document_id`, `received_by` enum {transferor, transferee}, `received_at`, `kind`.
- `lossmit_carryover_checks` (append-only): `case_id`, `check_code` (e.g., `CO-01 application present`, `CO-02 received dates present`, `CO-03 ack copy present`, `CO-04 reasonable date present`, `CO-05 determination notice present`, `CO-06 appeal record`, `CO-07 offer terms`, `CO-08 trial plan schedule`, `CO-09 forbearance cumulative months`, `CO-10 SMDU case id`), `result`, `requested_from_transferor_at`, `resolved_at`.
- Timers link via `timers.case_id`. Retention `life_of_loan_plus_4y`; borrower financial documents PII-encrypted.

#### State machine
`inherited_pending` → `file_verified` (all `CO-*` pass) or `file_deficient` (transferor request; borrower not asked until the transferor has failed to produce) → branch by status:
- `ack_required` (ack period unexpired, no transferor ack) → `ack_sent` (within 10 business_days_federal) → `incomplete`.
- `incomplete` → `complete` (documents received by either servicer, deemed dates) → `under_evaluation` → `determined` (offer or denial; denial requires `lossmit_reviewer`) → `offer_pending_acceptance` → `accepted` → `plan_active` / `trial_in_progress` → handoff to 12.4–12.9; or `rejected`/`expired` → `closed`.
- `complete_at_transfer` → `under_evaluation` (30 days from transfer date) → as above.
- `appeal_pending` → `appeal_determined` (30 days from later of transfer/appeal; different personnel) or `appeal_as_pending_complete` → `under_evaluation`.
- `offer_pending_acceptance` (transferor offer) → `accepted` → `plan_active` (honor the transferor's option even if not in Supermortgage's menu) / `rejected` / `expired`.
- `not_pending` (fully resolved pre-transfer) → `closed` (history retained).
Foreclosure gates: `REGX_1024_41K2_NO_FIRST_FILING_GATE` and 13.1/13.2 gates evaluated on every `foreclosure.referral` command.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_LOSSMIT_FILE_VERIFY_T0` | deadline | `transfer.tape.received{kind=lossmit}` | `transfer_date` | 0 (complete at or before T-0) | `lossmit.carryover.verified` per case | sev 1 → `lossmit_reviewer`; transferor escalation via `officer` |
| `SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2` | deadline | `lossmit.carryover.deficient` | raised_at | +2 business_days_servicer | `lossmit.transferor_request.sent` | sev 2 |
| `REGX_1024_41K2_TRANSFEREE_ACK_10` | deadline | `loan.boarded{lossmit ack unexpired & not sent}` | `transfer_date` | +10 business_days_federal | `notice.sent{NTC_REGX_41B2_ACK_INCOMPLETE or NTC_REGX_41B2_ACK_COMPLETE}` | sev 1 → Compliance Sentinel; `lossmit_reviewer` |
| `REGX_1024_41B2_ACK_5_DEEMED_T0` | deadline | `loan.boarded{application not previously subject to §1024.41}` | `transfer_date` (deemed receipt) | +5 business_days_federal | acknowledgment sent (12.1) | sev 1 |
| `REGX_1024_41K3_COMPLETE_APP_EVAL_30` | deadline | `loan.boarded{completeness_status=complete}` or `lossmit.application.complete_at_transfer` | `transfer_date` | +30 calendar_days | `notice.sent{NTC_REGX_41C1_OFFER or NTC_REGX_41C1_DENIAL}` (12.2 canonical §1024.41(c)(1) determination pair; (c)(4) third-party information handling) | sev 1 |
| `REGX_1024_41C1_EVAL_30_CARRYOVER` | deadline | `lossmit.application.completed` after transfer | `complete_at` (earliest receipt by either servicer) | +30 calendar_days | `notice.sent{NTC_REGX_41C1_OFFER or NTC_REGX_41C1_DENIAL}` | sev 1 |
| `REGX_1024_41K4_APPEAL_DETERMINATION_30` | deadline | `lossmit.appeal.pending_at_transfer` or `lossmit.appeal.received` (timely, post-transfer) | later of `transfer_date`, `appeal_received_at` | +30 calendar_days | `notice.sent{NTC_REGX_41H4_APPEAL_GRANTED or NTC_REGX_41H4_APPEAL_DENIED}` | sev 1; reviewer ≠ evaluator |
| `REGX_1024_41K5_OFFER_ACCEPTANCE_BALANCE` | deadline (borrower's window; not_before for closure) | `loan.boarded{offer pending}` | original `acceptance_deadline` | 0 (unexpired balance) | `lossmit.offer.accepted/rejected` or expiry | no breach; case may not be closed as expired before this date |
| `REGX_1024_41K2_NO_FIRST_FILING_GATE` | not_before_gate | `loan.boarded{incomplete app with reasonable date}` | `transferor_reasonable_date` (or Supermortgage's, if it sends the ack) | +1 calendar_day | `assertGateOpen` in `foreclosure.referral`/first-filing commands | command refused |
| `REGX_1024_41F1_120_DAY_GATE` / `REGX_1024_41G_DUAL_TRACK_GATE` | not_before_gate (13.1/13.2) | `loan.boarded` | original delinquency date / application dates carried over | per 13.1/13.2 | | seeded from transferor dates |
| `REGX_1024_41H_APPEAL_WINDOW_14` | deadline (borrower's) | `loan.boarded{denial with unexpired appeal window}` | transferor denial sent date | +14 calendar_days | appeal received or expiry | no breach; case not closed before expiry |
| `FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M` | not_before_gate (12.4) | `loan.boarded{forbearance_history}` | `initial_start_date` | 12 months cumulative | `assertGateOpen` on forbearance extension | exception request template (12.4) |
| `SM_SMDU_CASE_ACCESS_T0` | deadline | `loan.boarded{lossmit_in_process or trial_in_progress}` | `transfer_date` | 0 | `smdu.case.accessible` | sev 1 → `fnma_portal_operator`/Fannie Mae servicing rep **[UNVERIFIED mechanics]** |

Jurisdiction overrides: Colorado (AI Act) — pre-decision notice and human-review/appeal disclosures on determinations (`jurisdiction_rules.ai_disclosure`); states treating modification negotiation as MLO activity route offers through `licensed_specialist`.

#### Business rules and calculations
- `deemed_received_at` = `transferor_received_at` if the application was subject to §1024.41 at the transferor; otherwise `transfer_date` (comment 41(k)(1)(i)-1).
- Completeness carry-over: documents received by the transferor count as received on the transferor's receipt date (comment 41(k)(1)(i)-2); completeness under Supermortgage's criteria is assessed at boarding — if complete under the transferor but not under Supermortgage, `facially_complete_at = transferor's completion date`; if complete under Supermortgage but incomplete under the transferor, the application is complete as of the transfer date and (k)(3) applies.
- Duplicate notices: any (b)(2)(i)(B), (c)(1), (h)(4) notice the transferor already sent is not re-sent (comment 41(k)(1)(i)-3); the transferor's copy is stored in `lossmit_documents`.
- Foreclosure: no first notice/filing until after the reasonable date on any incomplete-application acknowledgment (transferor's or Supermortgage's); a complete application by that date is treated as within the pre-foreclosure review period even if fewer than 120 days delinquent; if a sale is ≤37 days away, evaluate anyway ((k)(2)(ii)(B)).
- Worked dates (transfer date Thu Oct. 1, 2026; Columbus Day Mon Oct. 12 excluded from federal business days):
  - Ack: application received by transferor Tue Sept. 29 (no ack sent) → Supermortgage ack due **Fri Oct. 16, 2026** (10 federal business days: Oct. 2, 5, 6, 7, 8, 9, 13, 14, 15, 16).
  - (k)(3): complete application received by transferor Sept. 20, undecided → determination due **Sat Oct. 31, 2026** (calendar days; mailed no later than Oct. 30 in practice).
  - Appeal: transferor denied a Flex Mod on Sept. 24 (appeal window to Oct. 8); borrower appeals Oct. 5 → determination due later of Oct. 31 and **Nov. 4, 2026** → Nov. 4.
  - Pending offer: trial offer Sept. 25 with 14-day acceptance to Oct. 9 → borrower may accept through Oct. 9; acceptance to the transferor Oct. 7 must be honored; first trial payment per the offer (12.8).
  - Not previously subject (transferor exempt small servicer): deemed received Oct. 1 → ack due **Thu Oct. 8, 2026** (5 federal business days).
  - Foreclosure prohibition: application received at 101 days delinquent on Sept. 24; transfer Oct. 1; transferor's ack gave reasonable date Oct. 24 → no first filing before **Oct. 25, 2026**, even though day 120 falls on Oct. 13.
- Forbearance carry-over: `cumulative_months` = Σ transferor increments; a new increment may not push cumulative > 12 months from `initial_start_date` without Fannie Mae's exception approval (LL-2026-01).
- Trial period plans: continue the transferor's schedule; a trial payment not received by the last day of the month in which it is due fails the trial (F-1-27; 12.8); payments received by the transferor during the 60-day window count as of the transferor's receipt date (1.3).
- Money: offers carry their original terms (P&I cents, rate, term); Supermortgage does not re-underwrite a transferor offer the borrower timely accepts (comment 41(k)(4)-2/(k)(5)-1); it may need Fannie Mae/SMDU re-entry for reporting.

#### Integrations
- **Transferor SFTP** — loss-mit file at T-14 and T-1; daily post-transfer forwarding of borrower submissions, appeals, acceptances (with transferor receipt timestamps); acked; missing items → `SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2`.
- **SMDU** (`fnma-smdu`, B2B XML name/value pairs; UI via SSO) — read existing case/trial status under the partner's servicer number; submit evaluations for new determinations; report trial payments. Servicer-number change cases: `human_portal_task` to the `fnma_portal_operator` with a Fannie Mae servicing-representative request package (loan list, SMDU case IDs, transfer date, D-Code) **[UNVERIFIED mechanics]**.
- **`print-mail` / e-delivery** — acknowledgment, determination and appeal notices (12.1–12.3 templates); E-SIGN only with Supermortgage-verified consent.
- **`attorney-network`** — hold/proceed instructions keyed to `REGX_1024_41K2_NO_FIRST_FILING_GATE` and 13.1/13.2 gates; acknowledged within the 13.6 SLA.
- **`telephony/voice`** — borrower contact for missing documents (only after the transferor has failed to produce), with automation disclosure and TCPA consent gating.

#### Outputs and artifacts
- Notices: `NTC_REGX_41B2_ACK_INCOMPLETE`/`NTC_REGX_41B2_ACK_COMPLETE` (§1024.41(b)(2)(i)(B); checklist: receipt statement, missing documents, reasonable date ≥ 7 days and generally 30 days, foreclosure-protection language), `NTC_REGX_41C1_OFFER`/`NTC_REGX_41C1_DENIAL` (§1024.41(c)(1) determination pair, 12.2; options offered/denied, specific reasons for modification denials, appeal rights and 14-day window, acceptance period), `NTC_REGX_41H4_APPEAL_GRANTED`/`NTC_REGX_41H4_APPEAL_DENIED` (§1024.41(h)(4), 12.3). All six codes are Section 12's registry rows — 1.7 references them, never redefines them (`notice_templates.code` is a primary key, so one artifact has exactly one code across sections). Channel: mail; electronic only with verified `esign` consent.
- Documents: verified loss-mit file with receipt dates; `lossmit_carryover_checks`; SMDU case records; Form 3179 (12.8) where a trial converts; ledger: trial payments post per 2.6.
- Investor events: workout status via SMDU (12.x) and delinquency status (5.7); no LAR change from 1.7 itself.

#### AI agent design (AI-first)
`lossmit-underwriter` agent (tools: `loadTransferorFile`, `runCarryoverChecks`, `computeDeemedDates`, `classifyCompleteness`, `requestFromTransferor`, `evaluateOptions` (Fannie Mae hierarchy Exhibit F-2-10, SMDU decision), `draftNotice`, `setForeclosureHold`, `honorTransferorOffer`, `writeDecision`) with `case` agent for acknowledgments and `borrower-comms` for document collection. End-to-end: verifies each inherited file, computes every carry-over date, sends acknowledgments, evaluates complete applications through SMDU, prepares determinations, and honors transferor offers. Decision record: `{case_id, deemed_received_at, completeness, timers_seeded, options_evaluated, smdu_case_id, outcome, reasons, reviewer}`. Escalations: `lossmit_reviewer` approves every denial/ineligibility and every appeal determination (personnel different from the evaluator; Colorado AI Act and LL-2026-04); `attorney` receives hold instructions where a foreclosure is already referred; `licensed_specialist` where `jurisdiction_rules.mlo_negotiation=true`; `fnma_portal_operator` for SMDU UI-only case actions; `human_agent` on borrower request. Disclosure: AI-assisted decision notices carry the state-required explanation and human-review statement; outbound AI voice only with verified `tcpa_voice` consent. If the AI path is off, the same queue is worked by underwriters in the ops-console with the same decision schema.

#### Edge cases and failure modes
- Transferor received the application but never acknowledged and its ack period expired before transfer: Supermortgage is not required to send the (k)(2) ack (period expired) but must still evaluate; the transferor's violation is logged for the partner.
- Application received by the transferor with a foreclosure sale ≤37 days away: (k)(2)(ii)(B) and (g) apply; hold instructions to counsel immediately at boarding.
- Borrower sends documents/appeal/acceptance to the transferor after the transfer date: dates = transferor receipt; obtain via forwarding; never treat as untimely because of the transfer.
- Transferor offered an option Supermortgage does not offer (e.g., a proprietary plan): must be honored on acceptance; Fannie Mae approval/SMDU re-entry may be required.
- Facially complete application where Supermortgage needs additional documents: request them; completeness date unchanged.
- Trial plan in progress: continue schedule; a payment made to the transferor within the 60-day window counts as of its receipt date; missed trial payment at the transferor before transfer → failed trial recorded from transferor data.
- Bankruptcy overlay: automatic stay respected; loss-mit communications through counsel where represented (14.x); (k) timers still run unless the borrower's counsel instructs otherwise.
- SCRA overlay: rate cap applied before evaluation (13.9).
- Disaster: disaster forbearance/deferral eligibility per LL-2026-01 with the transferor's history.
- Successor in interest with a pending application: continue for the confirmed successor; potential successor → 4.4.
- Transfer-out mid-case (17.4): mirror obligations; package the same `CO-*` checklist.
- SMDU inaccessible at T-0: escalation; determinations may still be made under the Guide with later SMDU entry (rep-and-warrant relief risk noted to the partner).
- NPRM switch-on: a pending "review cycle" replaces completeness; (k) timers re-mapped by the rule-set version — cases keep `deemed_received_at`.

#### Test cases and acceptance criteria
- 1.7-T1 Given an application received by the transferor Sept. 29, 2026 with no ack and transfer date Oct. 1, then `REGX_1024_41K2_TRANSFEREE_ACK_10` is due Oct. 16, 2026; an ack sent Oct. 19 → breach.
- 1.7-T2 Given a complete application pending at transfer (received Sept. 20), then `REGX_1024_41K3_COMPLETE_APP_EVAL_30` is due Oct. 31, 2026 regardless of the transferor's original Oct. 20 deadline.
- 1.7-T3 Given an appeal filed Oct. 5 against a transferor denial, then the appeal determination is due Nov. 4, 2026 and the reviewer differs from any Supermortgage evaluator on the case.
- 1.7-T4 Given a transferor offer expiring Oct. 9 accepted by the borrower to the transferor Oct. 7, then Supermortgage honors it and the case reaches `plan_active` without re-underwriting.
- 1.7-T5 Given an incomplete application with a transferor reasonable date of Oct. 24, then a `foreclosure.referral` command on Oct. 20 is refused by `REGX_1024_41K2_NO_FIRST_FILING_GATE` and allowed on Oct. 25.
- 1.7-T6 Given an application not previously subject to §1024.41, then `deemed_received_at` = Oct. 1 and the ack is due Oct. 8, 2026.
- 1.7-T7 Given a transferor file missing the application's received date, then `CO-02` fails, a transferor request is sent within 2 business days, and no borrower request is made before the transferor fails to respond.
- 1.7-T8 Given a forbearance history of 9 cumulative months starting Feb. 1, 2026, then a 3-month extension is allowed and a further extension is refused by `FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M` without an exception record.
- 1.7-T9 Given the AI proposes a denial, then the determination notice cannot be sent without a `lossmit_reviewer` approval record.
- 1.7-T10 Given `regx.lossmit.2024nprm` is switched on for new cases, then inherited cases keep `deemed_received_at` and their existing timers are cancelled with reason `rule_set_change` and re-issued under the new definitions.

#### Audit and evidence
Transferor file and receipt dates (hashes), carry-over checklist results, deemed-date computations, every notice with template version and proof of mailing, SMDU case IDs and decision outputs, reviewer approvals (identity, separation from evaluator), foreclosure hold instructions and counsel acknowledgments, timer histories and `agent_decisions` — the §1024.41(k)/(f)/(g) litigation and exam file.

### Open questions / decisions
1. SMDU case continuity for servicer-number changes — confirm procedure with Fannie Mae; default: `human_portal_task` request package to the Fannie Mae servicing representative before T-0.
2. Whether to re-send acknowledgment/determination notices the transferor already sent when their content does not meet Supermortgage's checklist — default: do not re-send (comment 41(k)(1)(i)-3) but document the gap and cure any missing borrower information in the next required notice.
3. Treatment of transferor proprietary options not available from Fannie Mae/Supermortgage upon acceptance — default: honor and seek Fannie Mae approval; partner bears any non-reimbursable cost (contract).
4. Reviewer separation rule for inherited appeals — default: any Supermortgage `lossmit_reviewer` not previously involved in the case.

### Sources
- Reg X §1024.41 (eCFR current as of Sept. 4, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.41
- Official Interpretations to §1024.41(k): https://www.consumerfinance.gov/rules-policy/regulations/1024/interp-41/ and https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024
- Reg X §1024.38(b)(4): see 1.1 sources.
- CFPB Bulletin 2020-02 (Appendix A §VII): https://files.consumerfinance.gov/f/documents/cfpb_policy-guidance_mortgage-servicing-transfers_2020-04.pdf
- Servicing Guide A2-7-03 and F-1-11 (05/13/2026): see 1.2 sources.
- research/00a §1.1–1.2 (rule status), §3.2 (LL-2026-01), §3.8 (Flex Mod), §5.6 (Colorado AI Act); research/00b F1 (SMDU).
