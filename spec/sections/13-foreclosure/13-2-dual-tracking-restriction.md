# 13.2 — Dual-tracking restriction

| Attribute | Value |
|---|---|
| Section | 13 — Foreclosure |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | During loss-mit |
| Governing source | Reg X 1024.41(g) |
| Key deadlines | No foreclosure sale while complete app pending |
| Timers | `FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD`, `FNMA_E3207_MAF_NOTICE_7`, `FNMA_E3302_SALE_CERT_WINDOW_7_15`, `FNMA_E3401_EXPEDITED_REVIEW_CERT`, `FNMA_E3401_SHORTSALE_MARKETING_45`, `REGX_1024_41C1_EVAL_30`, `REGX_1024_41E1_ACCEPT_14`, `REGX_1024_41G_DUAL_TRACK_GATE`, `REGX_1024_41G_INSTRUCT_COUNSEL_1BD`, `REGX_1024_41G_TRIAL_PERFORMING_FC_GATE`, `REGX_1024_41H_APPEAL_WINDOW_14`, `STATE_CA_2924_18_DUAL_TRACK_GATE`, `STATE_MN_582_043_DUAL_TRACK_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Foreclosure |
| Trigger & frequency | During loss-mit |
| Governing source (blueprint) | Reg X 1024.41(g) |
| Key deadlines (blueprint) | No foreclosure sale while complete app pending |
| Data/artifacts | Gate |
| Systems | SMDU |
| Automation class (blueprint) | b |
| SoR / Sub | S[cropped in source] — read as Sub |
| Nuances (blueprint) | [cropped in source] — reconstructed below: trigger is a complete application received after the first filing and more than 37 days before a sale; prohibits moving for judgment/order of sale and conducting the sale (not all foreclosure steps); three exits; instruct-counsel duty and no relief for counsel's failures; sale conducted by a trustee/sheriff still counts; Fannie Mae E-3.4-01 adds 14-day/short-sale/appeal delays and Minnesota/Nevada/California statutory dual-tracking rules add state gates |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.41(g) (eCFR current as of Sept. 8, 2026).** "If a borrower submits a complete loss mitigation application after a servicer has made the first notice or filing required by applicable law for any judicial or non-judicial foreclosure process but more than 37 days before a foreclosure sale, a servicer shall not move for foreclosure judgment or order of sale, or conduct a foreclosure sale, unless: (1) The servicer has sent the borrower a notice pursuant to paragraph (c)(1)(ii) of this section that the borrower is not eligible for any loss mitigation option and the appeal process in paragraph (h) of this section is not applicable, the borrower has not requested an appeal within the applicable time period for requesting an appeal, or the borrower's appeal has been denied; (2) The borrower rejects all loss mitigation options offered by the servicer; or (3) The borrower fails to perform under an agreement on a loss mitigation option."

**Official Interpretations (verified today):**
- **41(g)-1 Dispositive motion.** The prohibition "on a servicer moving for judgment or order of sale includes making a dispositive motion for foreclosure judgment, such as a motion for default judgment, judgment on the pleadings, or summary judgment, which may directly result in a judgment of foreclosure or order of sale." A servicer that has made such a motion before receiving a complete application "has not moved for a foreclosure judgment or order of sale if the servicer takes reasonable steps to avoid a ruling on such motion or issuance of such order prior to completing the procedures required by § 1024.41, notwithstanding whether any such action successfully avoids a ruling on a dispositive motion or issuance of an order of sale."
- **41(g)-2 Proceeding with the foreclosure process.** Nothing in (g) prevents a servicer "from proceeding with the foreclosure process, including any publication, arbitration, or mediation requirements established by applicable law, when the first notice or filing ... occurred before a servicer receives a complete loss mitigation application so long as any such steps in the foreclosure process do not cause or directly result in the issuance of a foreclosure judgment or order of sale, or the conduct of a foreclosure sale, in violation of § 1024.41."
- **41(g)-3 Interaction with foreclosure counsel.** Where a complete application is received, "the servicer must instruct counsel promptly not to make a dispositive motion for foreclosure judgment or order of sale; where such a dispositive motion is pending, to avoid a ruling on the motion or issuance of an order of sale; and, where a sale is scheduled, to prevent conduct of a foreclosure sale, unless one of the conditions in § 1024.41(g)(1) through (3) is met. A servicer is not relieved of its obligations because foreclosure counsel's actions or inaction caused a violation."
- **41(g)-4 Applications submitted 37 days or less before sale.** No (g) protection, but 1024.38(b)(2)(v) still requires the servicer to "properly evaluate a borrower who submits an application for a loss mitigation option for all loss mitigation options available" — and Fannie Mae E-3.4-01 requires an expedited review (below).
- **41(g)-5 Conducting a sale prohibited.** "Section 1024.41(g) prohibits a servicer from conducting a foreclosure sale, even if a person other than the servicer administers or conducts the foreclosure sale proceedings" — "conduct of the sale violates § 1024.41(g)" where none of (g)(1)–(3) applies.
- **41(b)(3)-1/-2:** protections are fixed "as of the date a complete loss mitigation application is received"; with no sale scheduled, treated as >90 days before sale; later scheduling/rescheduling does not remove them.

**Related paragraphs.** (c)(1): evaluation within 30 days of a complete application received "more than 37 days before a foreclosure sale"; (e)(1): acceptance period ≥14 days (≥7 days if the application was received less than 90 but more than 37 days before sale); (h): appeal only if the complete application was received "90 days or more before a foreclosure sale", 14 days to appeal, 30 days to decide, different personnel; (i) duplicative requests; (j) small servicers (n/a). **(f)(2)** is the pre-filing twin (13.1). The May 2025 rescission removed the COVID (c)(2)(vi) streamlined-modification exception; nothing else changed.

**Fannie Mae E-3.4-01, Suspending Foreclosure Proceedings for Workout Negotiations (07/14/2021, verified today).** "The BRP must be complete before any legal action may be postponed" (with short-sale and Flex-Mod-offer exceptions). Principal residence, complete BRP >37 days before sale: "delay filing the Motion for Foreclosure Judgment or Order of Sale"; if already filed, "request the court to delay a hearing or ruling as permitted under state or local law"; Evaluation Notice within 30 days; borrower response within 14 days; delay through the evaluation, the 14-day response period, any appeal, the 45-day short-sale marketing period, the 15-day offer review and 60 days after a short-sale approval to close. Non-principal residence, >37 days: no automatic delay; delay the sale only if a retention offer's 14-day window reaches the sale. Complete BRP 15–37 days before sale (all loans): "No delay in legal action is required"; expedited review before the certification date; delay only for a retention offer whose 14-day window reaches the sale; "must not offer a Mortgage Release option during this time period." Complete BRP <15 days before sale: no delay required; expedited review encouraged; retention offer ⇒ delay up to 14 days; Fannie Mae short-sale approval ⇒ suspend; borrower must be told the result or that review could not be completed before the sale. Mortgage assistance fund approval notified ≥7 days before sale ⇒ may postpone (E-3.2-07/D2-3.1-05). Acceptance of a retention offer (verbal or written) postpones the next legal action until first-payment default; first payment under a trial/repayment/forbearance plan postpones until breach. **E-3.4-02** (cancelling the sale for a completed workout) — title verified in the Part E TOC; text not retrieved **[PARTIALLY VERIFIED]**. **E-3.3-02** (11/12/2014): written certification to the law firm "between 7 and 15 days prior to the scheduled foreclosure sale" that all delinquency-management requirements are met and "there is no workout offer either pending or accepted"; if a workout is active the servicer "must not issue a certification ... and must make every effort to stop a scheduled foreclosure sale"; cancellation-driven delays "will subject the servicer to compensatory fees". **E-3.2-06** (12/16/2015): notify the firm "within two business days after either a workout arrangement has been agreed to, or the mortgage loan is fully reinstated."

**State dual-tracking statutes (verified today unless noted).** MN §582.043 subd. 6: the servicer "shall not refer the subject mortgage loan to an attorney for foreclosure while the mortgagor's application is pending" and, for an application received "before midnight of the seventh business day prior to the foreclosure sale date," "must halt the foreclosure sale and evaluate the application"; remedies subd. 7 (injunction/set-aside, fees); small-servicer carve-out (≤125 foreclosure sales in 12 months). CA Civ. Code §2923.5(a)(1)(B)/§2924.18 (2025): no NOD while a complete first-lien application is pending (owner-occupied, 1–4 units; §2924.15) **[PARTIALLY VERIFIED — §2924.11/2924.18 text not retrieved]**. NV NRS 107.500–107.560: no notice of default "while a complete application is pending". These are `jurisdiction_rules` gates evaluated alongside (g).

**Discrepancies with the blueprint row.** (1) The row's "no foreclosure sale while complete app pending" understates (g): it also bars the *motion for judgment/order of sale*, and it only attaches to applications received >37 days before a sale (with the (b)(3) fixing rule). (2) The row lists "SMDU" as the system — SMDU is the decisioning rail for the *evaluation* (12.x); the gate lives in Core and is enforced through the attorney-network instruction channel. (3) Fannie Mae's E-3.4-01 overlay (14-day windows, short-sale periods, 15–37-day expedited review, no Mortgage Release <37 days) and the 7–15-day certification are absent. (4) State statutes (MN 7-business-day rule) are stricter than Reg X.

### Operational prerequisites
- 12.x loss-mitigation engine emitting authoritative `lossmit.application.completed{received_at}`, `lossmit.determination.sent`, `lossmit.offer.*`, `lossmit.appeal.*`, `lossmit.agreement.*` events; SMDU integration for evaluations.
- Attorney-network instruction channel (13.6) with acknowledged message types `HOLD_DISPOSITIVE`, `POSTPONE_SALE`, `WITHDRAW_MOTION`, `CERTIFY_SALE`, `CANCEL_SALE` and 1-BD acknowledgment SLA in the retention agreement addendum (partner-signed).
- Sale-date feed: firm milestone `sale_scheduled{date}` (DRA event and network message) — sale dates are the anchor for the 37/90/15/7-day computations.
- `jurisdiction_rules.foreclosure.dual_tracking` seeded (MN, CA, NV) with counsel review.

### Build spec
#### Inputs and triggers
- `lossmit.application.completed{received_at, channel}` (12.x) → evaluate (f)(2) or (g) depending on `foreclosure.first_notice.filed`.
- `foreclosure.sale.scheduled{sale_at}`, `foreclosure.sale.rescheduled{sale_at}`, `foreclosure.judgment_motion.filed`, `foreclosure.judgment.entered` (13.6 milestones) → recompute windows.
- Exit events: `lossmit.determination.sent{eligible=false}`, `lossmit.appeal.window_expired`, `lossmit.appeal.denied`, `lossmit.offer.rejected{all=true}`, `lossmit.offer.expired{all=true}`, `lossmit.agreement.defaulted`, `lossmit.trial.failed`.
- Hold-extending events (Fannie Mae): `lossmit.offer.sent{kind=retention, respond_by}`, `lossmit.offer.accepted`, `lossmit.trial.first_payment.received`, `shortsale.marketing.started` (45 days), `shortsale.offer.received` (15-day review), `shortsale.approved` (60 days to close), `maf.approval.received{notified_at}` (E-3.2-07).
- `foreclosure.sale.certification.due` (timer, 15 days before sale) → 13.5/13.6 certification routine.

#### Data model
- `foreclosure_holds` — **declared in 12.1 (Section 12 owns the table and is its principal writer); consumed here.** Not created by 13.2. Canonical shape (this is the authoritative column list; 12.1 restates it): `id`, `loan_id`, `case_id?` (foreclosure case, when one is open), `source_case_id?` (the originating 12.x loss-mit/liquidation case), `kind`, `scope text[]` ⊂ {refer, first_notice, judgment_motion, sale_schedule, sale_conduct, eviction}, `opened_at`, `opened_by_event_id`, `expires_at?`, `closed_at?`, `closed_by_event_id?`, `close_reason?`, `rule_citation`, `attorney_instruction_id?`, `decision_id`. Append-only close (no delete, no `released_at`/`hold_code` — those were an earlier 12.x spelling; see the mapping note in 12.1).
- `foreclosure_holds.kind` — the **full vocabulary**, with the section that writes each. 13.2 reads all of them; a `kind` no section writes is a dead gate, and a `kind` written but not listed here is rejected by the check constraint.

| `kind` | Written by | Opened when | Typical `scope` |
|---|---|---|---|
| `regx_f2_prefiling` | **12.1** | complete (or facially complete) application received before the first notice or filing — §1024.41(f)(2) | refer, first_notice |
| `regx_g_dual_track` | **12.1 / 12.2** | complete application received after the first filing and >37 days before the sale — §1024.41(g); **this is the value `REGX_1024_41G_INSTRUCT_COUNSEL_1BD` below triggers on** | judgment_motion, sale_schedule, sale_conduct |
| `lm_review_cycle` | **12.1** | NPRM rule set only: `lossmit.assistance.requested` >37 days before a sale opens a review cycle | judgment_motion, sale_schedule, sale_conduct |
| `lm_offer_pending` | **12.2** | an offer is provided and the borrower's acceptance window is open | judgment_motion, sale_schedule, sale_conduct |
| `lm_appeal_pending` | **12.3** | appeal received (set on receipt, before eligibility is confirmed) — §1024.41(g)(1) | judgment_motion, sale_schedule, sale_conduct |
| `lm_third_party_pending` | **12.2** | third-party (MI/investor/SMDU) decision outstanding on an otherwise complete evaluation | judgment_motion, sale_schedule |
| `fnma_e3401_evaluation` | **12.2** | E-3.4-01 evaluation window on a complete BRP | judgment_motion, sale_schedule, sale_conduct |
| `fnma_e3401_offer_window` | **12.2** | E-3.4-01 14-day borrower response window | judgment_motion, sale_schedule, sale_conduct |
| `fnma_e3401_appeal` | **12.3** | E-3.4-01 appeal window | judgment_motion, sale_schedule, sale_conduct |
| `fnma_trial_performing` | **12.8** | borrower performing under a Trial Period Plan | refer, judgment_motion, sale_schedule, sale_conduct |
| `fnma_plan_performing` | **12.6 / 12.7** | borrower performing under a forbearance or repayment plan | refer, judgment_motion, sale_schedule, sale_conduct |
| `fnma_shortsale_marketing_45` | **12.9** | short-sale listing/marketing period (borrower is "performing", comment 41(g)(3)-1) | judgment_motion, sale_schedule, sale_conduct |
| `fnma_shortsale_review_15` | **12.9** | 15-day short-sale offer review | judgment_motion, sale_schedule, sale_conduct |
| `fnma_shortsale_close_60` | **12.9** | 60 days after short-sale approval to close | judgment_motion, sale_schedule, sale_conduct |
| `fnma_dil_accepted_60` | **12.9** | 60 days after a Mortgage Release (DIL) acceptance to close | judgment_motion, sale_schedule, sale_conduct |
| `fnma_maf_7` | **12.9** | mortgage-assistance-fund approval notified ≥7 days before sale (E-3.2-07) | sale_schedule, sale_conduct |
| `state_dual_track:<XX>` | **12.1–12.3, 12.9** | a state dual-tracking bar; the arming statute goes in `rule_citation` (e.g. `Cal. Civ. Code §2923.6`, `§2924.11` after short-sale approval, `N.Y. RPAPL §1304`/DFS §419.7) | per statute |
| `bk_stay` | **14.x** | §362 automatic stay | all |
| `scra_3953` | **13.8** | SCRA §3953(c) protection period | all |
| `disaster_approval` | **13.4** | D1-3-01 prior-written-approval pending | refer, first_notice, judgment_motion, sale_schedule, sale_conduct |
| `litigation` / `environmental` / `title` | **13.7** | non-routine litigation, environmental hazard, uncured title defect | judgment_motion, sale_schedule, sale_conduct |
| `transfer_k2` | **1.3** | §1024.41(k)(2) transferee bar on a first filing | first_notice |
- `attorney_instructions` (new): `id`, `case_id`, `firm_id`, `kind`, `payload jsonb`, `sent_at`, `acknowledged_at?`, `ack_by`, `evidence_document_id?`, `sla_timer_id`.
- `sale_events` (new, 13.6): `case_id`, `sale_at`, `status` ∈ {scheduled, postponed, cancelled, held, rescinded}, `source` ∈ {firm_message, dra, court_docket}, `postponed_reason`.
- `lossmit_protection_snapshots` (new): `application_id`, `received_at`, `first_notice_filed_at?`, `sale_at_receipt?`, `days_before_sale` (∞ if none), `protection_tier` ∈ {pre_filing_f2, g_full_90, g_37_to_89, fnma_15_to_37, fnma_lt_15, none}, `rule_set_version` — written once at receipt (1024.41(b)(3)), never recomputed.

#### State machine
Per foreclosure case, `dual_track_state`: `clear` → `hold_evaluation` (complete application; tier ≥ g_37_to_89 or Fannie Mae tier) → `hold_offer_window` (offer sent; until respond_by) → `hold_appeal` (appeal requested; until decision + 14-day acceptance) → `hold_performing` (accepted/first trial payment; until breach) | `hold_shortsale` (45/15/60-day chain) → `clear` on an exit event. `hold_*` states close `judgment_motion`, `sale_schedule` (policy) and `sale_conduct`; `hold_performing` also closes `first_notice` if not yet filed. Transitions are commands from `foreclosure-ops` consuming 12.x events; humans cannot force `clear` (an `officer` may only record a legal determination that an exit event occurred, e.g., a court-verified rejection).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_41G_DUAL_TRACK_GATE` | not_before_gate | `lossmit.application.completed` after `foreclosure.first_notice.filed` with `days_before_sale > 37` (or no sale) | receipt | 0 until exit event (g)(1)–(3) | `assertGateOpen` by `foreclosure.judgment_motion.authorize`, `foreclosure.sale.certify`, `foreclosure.sale.conduct.authorize` | refused; sev 1 |
| `REGX_1024_41G_INSTRUCT_COUNSEL_1BD` | deadline | `foreclosure_holds.opened{kind=regx_g_dual_track}` | opened_at | +1 business_days_servicer (policy for "promptly") | `attorney_instructions.acknowledged{kind ∈ HOLD_DISPOSITIVE/POSTPONE_SALE}` | sev 1 → `attorney` escalation; `officer` informed |
| `REGX_1024_41G_TRIAL_PERFORMING_FC_GATE` | not_before_gate (2.6 name) | `lossmit.trial.started` / `lossmit.offer.accepted` | — | until `lossmit.agreement.defaulted` | exit | refused |
| `REGX_1024_41C1_EVAL_30` | deadline (12.x) | `lossmit.application.completed{days_before_sale>37}` | receipt | +30 calendar_days | `lossmit.determination.sent` | 12.x sev 1 |
| `REGX_1024_41E1_ACCEPT_14` / `_7` | deadline (borrower's window; 12.x) | `lossmit.offer.sent` | offer date | +14 (≥90 days tier) / +7 (37–89 tier) calendar_days | acceptance/rejection/expiry | hold persists until expiry |
| `REGX_1024_41H_APPEAL_WINDOW_14` / `REGX_1024_41H_APPEAL_DECISION_30` | deadline (12.x) | denial sent / appeal received | — | +14 / +30 calendar_days | expiry / decision | hold persists |
| `FNMA_E3401_EXPEDITED_REVIEW_CERT` | deadline | `lossmit.application.completed{tier=fnma_15_to_37}` | receipt | complete before `foreclosure.sale.certification_window.opened` (sale − 15 days) | determination sent | sev 2; certification withheld until done |
| `FNMA_E3401_SHORTSALE_MARKETING_45` / `_REVIEW_15` / `_CLOSE_60` | deadline (hold windows) | `shortsale.marketing.started` / `shortsale.offer.received` / `shortsale.approved` | event date | +45 / +15 / +60 calendar_days | 12.x events | hold expires |
| `FNMA_E3207_MAF_NOTICE_7` | not_before_gate (policy) | `maf.approval.received` | notified_at | sale must be ≥7 days after notice to permit postponement | — | informational |
| `FNMA_E3302_SALE_CERT_WINDOW_7_15` | deadline window | `foreclosure.sale.scheduled` | sale_at | opens −15 calendar_days, closes −7 calendar_days | `foreclosure.sale.certified` or `foreclosure.sale.postpone_instructed` | sev 1; postpone instruction auto-issued at −7 if uncertified |
| `FNMA_E3206_WORKOUT_NOTIFY_FIRM_2BD` | deadline | `lossmit.agreement.executed` / `loan.reinstated` | event | +2 business_days_servicer | `attorney_instructions.acknowledged{kind=WORKOUT_AGREED/REINSTATED}` | sev 2 |
| `STATE_MN_582_043_DUAL_TRACK_GATE` | not_before_gate | `lossmit.application.received` (MN; complete or not while pending) | receipt | refer blocked while pending; sale halted if received before midnight of the 7th business day before sale | 12.x determination + exits | refused |
| `STATE_CA_2924_18_DUAL_TRACK_GATE` / `STATE_NV_107_5XX_DUAL_TRACK_GATE` | not_before_gate | complete first-lien application (owner-occupied) | receipt | NOD/NOS blocked while pending | exits | refused **[PARTIALLY VERIFIED]** |

`jurisdiction_overrides`: MN uses `business_days_servicer` for the 7-business-day rule; all Reg X windows are calendar days; sale-date comparisons use the sale's local date.

#### Business rules and calculations
1. **Tier at receipt** (1024.41(b)(3)): `days_before_sale = sale_date − received_date` using the sale scheduled *at receipt*; none scheduled ⇒ ∞ ⇒ tier `g_full_90` (appeal rights, 14-day acceptance). Example: sale Nov. 3, 2026; complete application received Sept. 25, 2026 → 39 days → tier `g_37_to_89` (30-day evaluation, 7-day acceptance, no appeal); received Sept. 28 → 36 days → Reg X tier `none`, Fannie Mae tier `fnma_15_to_37` (expedited review before the certification date Oct. 19). Postponing the sale to Dec. 15 after the Sept. 28 receipt does **not** upgrade the tier (comment 41(b)(3)-2 protects existing protections; it does not create new ones) — but a *new* complete application after postponement is evaluated against the new date.
2. **What the hold blocks**: `judgment_motion` (any dispositive motion: default judgment, judgment on the pleadings, summary judgment), `sale_conduct`; and by policy `sale_schedule` (do not set a sale while on hold, to avoid 41(g)-5 exposure). Not blocked: service of process, publication, mediation/arbitration steps, title work, answers to defenses — the firm continues them (comment 41(g)-2).
3. **Pending motion at receipt**: instruction `WITHDRAW_MOTION` or `REQUEST_CONTINUANCE` within 1 BD; if the court rules anyway despite reasonable steps, the servicer is compliant (41(g)-1) — evidence of the request is mandatory.
4. **Exits**: (g)(1) ineligible notice + appeal not applicable/expired/denied; (g)(2) borrower rejects *all* options offered (an unaccepted offer expires into rejection at the (e)(1) deadline); (g)(3) failure to perform (trial payment not received by the last day of the month due, 12.x). Fannie Mae adds: end of the short-sale windows; Fannie Mae rejection of the short-sale offer.
5. **Duplicative requests** (1024.41(i)): a second complete application while continuously delinquent since a fully processed prior one earns no Reg X hold; Fannie Mae E-3.4-01 still requires evaluation (D2-3) — hold `fnma_e3401_evaluation` opens unless the case is inside 37 days.
6. **Certification arithmetic** (E-3.3-02): window = [sale − 15, sale − 7] calendar days; sale Nov. 3 ⇒ Oct. 19–Oct. 27. Certification requires: all holds clear, delinquency-management checklist (11.x) satisfied, no pending/accepted offer, DMDC re-check (13.8), disaster gate open, bankruptcy scrub clear, pre-sale inspection done (E-3.3-03, within 35 days), bid instructions ready (≥5 BD before sale).

#### Integrations
- **Attorney network (13.6)** — outbound instructions (`HOLD_DISPOSITIVE`, `WITHDRAW_MOTION`, `POSTPONE_SALE{until}`, `RESUME`, `CERTIFY_SALE`, `CANCEL_SALE`) as `integration_messages` with idempotency keys; firm acknowledgment required within 1 BD (`attorney_instructions.acknowledged`); non-ack ⇒ phone/email by `foreclosure-ops` voice/email tools, then `attorney` escalation. Inbound: sale scheduled/postponed/held milestones; motion filed/ruled.
- **DRA (read-only portal)** — daily reconciliation (13.6) verifies that a `POSTPONE_SALE` instruction is reflected by a "sale postponed" event within 2 BD; mismatch ⇒ `human_portal_task` to view DRA and firm call.
- **SMDU (fnma-smdu)** — evaluations/decisions (12.x); the hold reads decision outcomes from 12.x events, never from SMDU directly.
- **Court dockets** (PACER for bankruptcy only; state court e-filing feeds are firm-provided) — optional docket-alert ingestion to detect rulings.

#### Outputs and artifacts
- Events: `foreclosure.hold.opened/closed{kind, scope}`, `foreclosure.judgment_motion.refused`, `foreclosure.sale.postpone_instructed`, `foreclosure.sale.certified`, `foreclosure.sale.certification_withheld{reason}`, `foreclosure.workout.firm_notified`.
- Documents: sale certification letter to the firm (`DOC_FC_SALE_CERT_E3302`, content checklist: no pending/accepted offer; delinquency-management requirements met; DMDC certificate IDs; date range), hold instruction records, borrower notice for <15-day applications (E-3.4-01 "notify the borrower of review results or inability to complete review before sale") — template `NTC_FNMA_E3401_EXPEDITED_RESULT` (12.x), mail + electronic per E-SIGN consent.
- Investor events: status code changes (5.4): H5 (complete BRP received, month of receipt), BF (trial), 09/12 (plans), 71→95 (sale postponed) with reason.
- Ledger: none (fees continue to accrue under the 2013 rule set; suppressed under `regx.lossmit.2024nprm`).

#### AI agent design (AI-first)
`foreclosure-ops` opens/closes holds deterministically from 12.x events and drafts the counsel instruction; it uses the model to summarize the reason and to reconcile ambiguous firm milestones (e.g., a "hearing continued" docket entry) into structured states. Tools: `lossmit.case.get`, `foreclosure.case.get`, `attorney.instruction.send`, `attorney.instruction.status`, `dra.snapshot.get` (read-only extract), `timer.create`, `escalation.create`. Decision record: `{case_id, application_id, tier, days_before_sale, sale_at_receipt, hold_kind, instructions_sent[], exit_event?, rationale}`. Guardrails: no `RESUME`/`CERTIFY_SALE` instruction may be sent while any hold is open; the agent cannot mark an application "complete" or "rejected" — only 12.x can. Escalations: `attorney` when the firm has not acknowledged in 1 BD or a court ruling is imminent; `lossmit_reviewer` when an exit depends on a denial (12.x owns the denial approval); `officer` for a request to proceed under a claimed exit not evidenced by 12.x events. Disclosure: any borrower conversation about foreclosure status through `borrower-comms` discloses automation and offers a human (baseline §8.6). Human path: same holds; instructions drafted by AI, released by a `human_agent` from the queue.

#### Edge cases and failure modes
- Sale held despite a `POSTPONE_SALE` instruction (trustee/sheriff error): 41(g)-5 violation exposure → immediate `attorney` escalation to rescind; Fannie Mae E-4.1-02 rescission process (15.1); $1,000 rescission compensatory fee risk (A1-4.2-02).
- Application completed on the day of the certification window: withhold certification; instruct postponement; log.
- Application received 37 days or less before sale by mail dated earlier: receipt date is the servicer's receipt (1024.41(b)(3) "received"); log the postmark.
- Borrower rejects the offer verbally: record `contacts.qrpc` transcript; an oral rejection of *all* options exits (g)(2) but a documented written confirmation is requested (policy) — hold closes on the oral rejection.
- Non-principal residence in MN: state gate applies regardless of Reg X.
- Bankruptcy filed during hold: both holds coexist; stay controls.
- Transfer-out during hold (17.x): hold state, instructions and protection snapshots go in the transfer file (1024.41(k)).
- Rule-set swap: `regx.lossmit.2024nprm` replaces the tier logic with the review-cycle model; snapshots keep the version.

#### Test cases and acceptance criteria
- 13.2-T1 Given first filing Aug. 1 and sale Nov. 3, When a complete application is received Sept. 25, Then hold `regx_g_dual_track` opens, tier `g_37_to_89`, instruction `HOLD_DISPOSITIVE` sent within 1 BD and acknowledged.
- 13.2-T2 Given T1 and a determination "ineligible" sent Oct. 10 with no appeal right (tier <90), Then hold closes Oct. 10; certification permitted inside Oct. 19–27.
- 13.2-T3 Given a complete application received Sept. 28 (36 days), Then no Reg X hold; Fannie Mae `fnma_15_to_37` expedited review due before Oct. 19; certification withheld until the determination is sent.
- 13.2-T4 Given a pending summary-judgment motion when the application arrives, Then `WITHDRAW_MOTION`/`REQUEST_CONTINUANCE` instruction issued; court rules anyway → compliance evidence = instruction + firm's filed request; no breach.
- 13.2-T5 Given an offer accepted and first trial payment received, Then `hold_performing` blocks sale until `lossmit.trial.failed`; failure on the last day of the month due reopens sale scheduling the next day.
- 13.2-T6 Given MN property, application (incomplete) received before referral, Then `foreclosure.refer` refused while pending.
- 13.2-T7 Given a `POSTPONE_SALE` instruction not acknowledged in 1 BD, Then `attorney` escalation and phone task created; DRA reconciliation flags absence of a postponement event after 2 BD.
- 13.2-T8 Given no sale scheduled at receipt and a sale later set 40 days out, Then tier remains `g_full_90` with appeal rights and 14-day acceptance.
- 13.2-T9 Given the certification window opens and the DMDC re-check shows active duty, Then certification withheld (13.8), postponement instructed.
- 13.2-T10 Given rescission after a sale held in violation, Then 15.1 rescission flow and A1-4.2-02 fee exposure recorded.

#### Audit and evidence
Foreclosure file (13.3) captures: protection snapshot at receipt (with sale date evidence), hold open/close events, each counsel instruction with acknowledgment evidence (message hash, timestamp, firm user), docket entries, the sale certification letter or the postponement instruction, and 12.x notices — the exact record needed to prove comment 41(g)-1/-3 "reasonable steps" in a §6(f) suit and to earn Fannie Mae's allowable-delay credit (status codes reported accurately, 13.5).

### Open questions / decisions
1. Policy: block `sale_schedule` (not just `sale_conduct`) while on hold — **default: yes**.
2. Treat an oral rejection of all options as exit (g)(2) — **default: yes, with written confirmation requested**.
3. "Promptly" instruction SLA — **default: 1 servicer business day** (same-day when the sale/hearing is within 5 days).
4. Whether to apply Fannie Mae's E-3.4-01 principal-residence delays to non-principal residences as well — **default: no (Guide differentiates); state gates apply regardless**.

### Sources
- 12 CFR 1024.41(g), (b)(3), (c)(1), (e)(1), (h), (i) and Official Interpretations 41(g)-1..5, 41(b)(3)-1/-2 (eCFR Sept. 8, 2026; CFPB interactive regulation) — verified 2026-09-09: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.41 ; https://www.consumerfinance.gov/rules-policy/regulations/1024/41/
- Fannie Mae E-3.4-01 (07/14/2021): https://servicing-guide.fanniemae.com/svc/e-3.4-01/suspending-foreclosure-proceedings-workout-negotiations — verified 2026-09-09.
- E-3.3-02 (11/12/2014): https://servicing-guide.fanniemae.com/svc/e-3.3-02/certifying-status-workout-negotiations-prior-foreclosure-sale — verified 2026-09-09.
- E-3.2-06 (12/16/2015): https://servicing-guide.fanniemae.com/svc/e-3.2-06/conducting-borrower-outreach-during-foreclosure — verified 2026-09-09.
- Minn. Stat. §582.043 (2025): https://www.revisor.mn.gov/statutes/cite/582.043 — verified 2026-09-09.
- Cal. Civ. Code §2923.5 (2025, Stats. 2024 ch. 311): https://law.justia.com/codes/california/code-civ/division-3/part-4/title-14/chapter-2/article-1/section-2923-5/ — verified 2026-09-09; NRS ch. 107 (rev. 4/15/2026): https://www.leg.state.nv.us/nrs/nrs-107.html — verified 2026-09-09.
