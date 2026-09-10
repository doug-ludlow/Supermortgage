# 4.5 — Complaint handling / UDAAP

| Attribute | Value |
|---|---|
| Section | 4 — Customer Service & Borrower Communications |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | Ongoing (every expression of dissatisfaction, any channel; regulator/investor referrals) |
| Governing source | Dodd-Frank UDAAP |
| Key deadlines | Per policy |
| Timers | `CFPB_CONSUMER_FEEDBACK_60`, `CFPB_PORTAL_FINAL_60`, `CFPB_PORTAL_RESPONSE_15`, `FNMA_A4_2_1_04_EMAIL_48H`, `FNMA_REFERRAL_RESPONSE_5BD`, `NY_419_6_COMPLAINT_ACK_5BD`, `NY_419_6_COMPLAINT_RESPONSE_30BD`, `SM_COMPLAINT_ACK_1BD`, `SM_COMPLAINT_RESOLVE_15`, `SM_POPULATION_REMEDIATION_60`, `SM_UDAAP_REVIEW_10BD`, `TX_50A6_CURE_60` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Customer Service |
| Trigger & frequency | Ongoing (every expression of dissatisfaction, any channel; regulator/investor referrals) |
| Governing source (blueprint) | Dodd-Frank UDAAP |
| Key deadlines (blueprint) | Per policy |
| Data/artifacts | Complaint log |
| Systems | Case mgmt |
| Automation class (blueprint) | b |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Sources verified:** 12 U.S.C. 5531 (Dodd-Frank §1031) and 5536(a)(1)(B) (§1036); 12 CFR 1024.38(b)(1)(ii), (b)(5) and comments 38(b)(5)-1 to -3; CFPB complaint process page (company response "generally … in 15 days," "in progress" with "a final response in 60 days," consumer feedback window 60 days); CFPB guidance-withdrawal notice (May 12, 2025); 3 NYCRR 419.6; Cal. Civ. Code §2923.7(d) (supervisor referral); Fannie Mae A2-1-01 (12/17/2025), A4-1-03 (12/20/2023), A4-2.1-04 (12/16/2015), LL-2026-04 (00a §3.5); CFPB chatbot spotlight (June 6, 2023).

**UDAAP standards.** §1031(a): the Bureau may act against "covered persons or service providers" for "unfair, deceptive, or abusive" acts or practices; §1036(a)(1)(B) makes it unlawful for a covered person *or service provider* to engage in them — Supermortgage is both a covered person and the partner's service provider. **Unfair** (§1031(c)(1)): the act or practice "causes or is likely to cause substantial injury to consumers which is not reasonably avoidable by consumers" and the injury "is not outweighed by countervailing benefits to consumers or to competition"; public policy may be evidence but "may not serve as a primary basis." **Abusive** (§1031(d)): (1) "materially interferes with the ability of a consumer to understand a term or condition," or (2) "takes unreasonable advantage of" (A) the consumer's "lack of understanding … of the material risks, costs, or conditions," (B) the consumer's "inability … to protect the interests of the consumer in selecting or using" the product, or (C) "reasonable reliance by the consumer on a covered person to act in the interests of the consumer." **Deceptive** is undefined in the statute; the FTC deception standard (a representation, omission or practice likely to mislead a consumer acting reasonably under the circumstances, that is material) is applied. The CFPB's 2023 Policy Statement on Abusive Acts or Practices (88 FR 21883) was **withdrawn May 12, 2025**; the statutory text governs. State UDAP statutes and state AG enforcement apply in every state and are currently the more active supervisors (00a §5.4).

**Reg X hooks.** §1024.38(b)(1)(ii): policies and procedures reasonably designed to "investigate, respond to, and, as appropriate, make corrections in response to complaints asserted by a borrower." §1024.38(b)(5) and comment 38(b)(5)-2: borrowers "who are not satisfied with the resolution of a complaint or request for information submitted orally" must be told about the written §§1024.35/.36 procedures; comment 38(b)(5)-1: the procedures may be explained by notice or website, e.g., a statement on the periodic statement pointing to the website; comment 38(b)(5)-3: misdirected written notices must be redirected. Comment 35(a)-2: substance, not labels, decides whether a "complaint" is also an NoE/RFI.

**CFPB complaint portal.** Companies "generally respond in 15 days"; a company may indicate the response is "in progress" and "provide a final response in 60 days"; the consumer then "will have 60 days to provide feedback"; complaints (and, with consent, narratives) are published in the Consumer Complaint Database. Company response categories used in the database include "Closed with explanation," "Closed with monetary relief," "Closed with non-monetary relief," "In progress," and "Untimely response" **[PARTIALLY VERIFIED — the public field page confirms the first as an example and the timely yes/no flag; the full enumeration is from the database files]**. The company portal is registered per legal entity; whether the subservicer or the master servicer is the responding company is a registration/contract choice (4.5-Q1).

**Fannie Mae.** A2-1-01: "effective processes to promptly address borrower inquiries (relating to both current and delinquent mortgage loans)"; A4-1-03: "promptly respond to all inquiries, especially in the event of a borrower dispute," an "effective communication channel for dispute resolution," no unnecessary fees during resolution, and a thorough review plus "reasonable efforts to resolve the dispute" before commencing foreclosure during an ongoing dispute; **Texas §50(a)(6) loans**: procedures to receive and timely respond to inquiries/defect claims/complaints, immediate escalation to Fannie Mae Legal via Form 20 (Non-Routine Litigation) when a failure is alleged, and a 60-day cure (Tex. Const. art. XVI, §50(a)(6)(Q)(x)); A4-2.1-04: email within 48 hours, chat ≤5 minutes; LL-2026-04: monitoring and risk measurement of AI systems — complaints about AI interactions are the primary field signal. A Fannie Mae borrower-escalation referral process (1-800-2FANNIE cases referred to servicers with a response SLA) exists operationally but no Guide topic with a day count was located **[UNVERIFIED]**.

**State.** NY 419.6 applies its acknowledgment/response clocks (5/7/15/30 business days; 7-day extension) to borrower "complaints" generally, not only Reg X notices, and mandates the DFS Consumer Assistance Unit disclosure (1-800-342-3736) — whether oral complaints are included is **[UNVERIFIED]** (design: apply the clocks to every NY complaint regardless of channel). CA §2923.7(d): supervisor referral on request. Other state complaint-handling and regulator-response rules **[UNVERIFIED — load per state]**.

**AI-specific.** Colorado AI Act (eff. June 30, 2026) — complaints alleging an AI-driven adverse loss-mitigation decision trigger the explanation/human-review/appeal duties (12.3, baseline §8 item 5); state chatbot-disclosure laws (00a §5.6); the CFPB chatbot spotlight's concerns (failure to recognize disputes, doom loops, inaccurate information, inability to reach a human, chat-log security) define the complaint taxonomy's AI categories.

**Discrepancies vs. blueprint row.** "Per policy" understates the hard clocks: CFPB 15/60 days, NY 419.6 5/7/15/30 business days, Texas 60-day cure, Fannie Mae 48-hour email; and the complaint process is legally tied to §§1024.35/.36 through comment 35(a)-2 and §1024.38(b)(5). Automation class "b" → AI-first with `officer` oversight of regulator responses and UDAAP findings.

### Operational prerequisites
- **Complaint policy and CMS documentation** (Supermortgage; partner co-approval): definition of complaint (any expression of dissatisfaction about a product, service, practice or person, in any channel, from a borrower, successor, agent, regulator or third party), taxonomy, SLAs, escalation, root-cause and remediation standards, board/officer reporting cadence, retention. Artifact: `complaint_policy_v1` in `documents`.
- **CFPB Company Portal registration** (owner per 4.5-Q1; lead time weeks): portal users, secure delivery, response templates. **State regulator portals/emails** (NY DFS CAU, CA DFPI, etc.) with per-state SLAs loaded in `jurisdiction_rules.complaint_response`. **BBB/social listening** optional.
- **Partner escalation channel**: partner-received complaints (they are the servicer of record on statements in some states) forwarded same day via a shared queue.
- **UDAAP monitoring rules** (`udaap_monitors`) reviewed by counsel; **fair-lending complaint routing** (19.4) and **servicemember complaint routing** (13.8/13.9).
- **Texas §50(a)(6) loan flag** at boarding (1.1) with Form 20 escalation runbook.
- **AI governance**: complaint categories mapped to LL-2026-04 monitoring dashboards; evaluation suites include "dispute recognition" and "human hand-off" scenarios.

### Build spec
#### Inputs and triggers
- `communication.classified` with kind `complaint` (any channel, including voice transcripts — oral complaints are complaints) → `case.complaint.opened`; if also `noe`/`rfi`, those cases open in parallel and are linked.
- `regulator.complaint.received` (CFPB portal, state regulator, AG, HUD/FHEO for discrimination) with `external_ref`, `received_at`, `regulator_due_at`.
- `investor.referral.received` (Fannie Mae escalation), `partner.complaint.forwarded`, `attorney.demand.received`, `bbb.complaint.received`.
- `contact.sentiment.flagged` (AI detects dissatisfaction in a call/chat without an explicit complaint → soft complaint for analytics; borrower asked whether they wish to file).
- Recurring: nightly `complaint_analytics.refresh`; monthly `udaap_monitors.evaluate`; quarterly complaint committee report.

#### Data model
- `cases` (`case_type='complaint'`) — `source` ∈ {borrower_direct, successor, agent, cfpb_portal, state_regulator, state_ag, hud_fheo, fannie_mae_referral, partner, bbb, social, attorney_demand, internal_detected}, `external_ref`, `regulator_code`, `regulator_due_at`, `regulator_final_due_at`, `channel`, `is_oral bool`, `primary_issue` (taxonomy code), `sub_issue`, `secondary_issues text[]`, `severity` ∈ {low, medium, high, critical}, `flags jsonb` {udaap_candidate, fair_lending, servicemember, disaster, ai_related, foreclosure_imminent, litigation, media, repeat}, `linked_case_ids uuid[]` (NoE/RFI/loss-mit/foreclosure), `root_cause_code`, `root_cause_owner_process` (e.g., `2.1`, `3.2`), `remediation jsonb` {kind ∈ {none, explanation, non_monetary, monetary}, amount_cents bigint, ledger_entry_ids[], population_remediation_id?}, `response_type` ∈ {written, oral, portal}, `closed_with` ∈ {explanation, monetary_relief, non_monetary_relief, withdrawn, referred}, `regulator_response_document_id`, `officer_approved_by`, `closed_at`, `consumer_feedback jsonb`.
- `complaint_taxonomy` — versioned codes aligned to the CFPB mortgage issue/sub-issue set (e.g., "Trouble during payment process," "Struggling to pay mortgage," "Incorrect information on your report" … **[PARTIALLY VERIFIED list]**) plus Supermortgage sub-codes (payment application, escrow analysis, fees/late charges, force-placed insurance, payoff, loss-mit decision, foreclosure timing, communication/contact, AI interaction: not recognized, loop, inaccurate answer, could not reach human, disclosure not given; privacy/security; successor handling; language access).
- `udaap_monitors` — `code`, `description`, `metric_sql`, `threshold`, `window`, `owner_role`, e.g., `FEE_COMPLAINTS_PER_1000 > 2.0/month`, `PAYMENT_APPLICATION_ERRORS_CONFIRMED_RATE > 0.5%`, `AI_HUMAN_REQUEST_UNMET > 0`, `NOE_TIMELINESS < 99.5%`, `REPEAT_COMPLAINTS_SAME_LOAN_90D ≥ 3`, `COMPLAINTS_BY_LANGUAGE_PREF disparity`, `LOSSMIT_DENIAL_COMPLAINTS_UPHELD_RATE`.
- `population_remediations` — `id`, `issue`, `lookback_start`, `criteria_sql`, `loans_affected int`, `total_cents bigint`, `approved_by` (`officer`), `executed_at`, `investor_notification_ref` (if Fannie Mae must be told, e.g., fee refunds affecting reimbursed expenses).
- `complaint_analytics` (materialized) — counts/rates by taxonomy, source, state, product feature, agent version, resolution time, uphold rate, monetary relief.
- Retention: `life_of_loan_plus_4y` for loan-level complaints; regulator correspondence permanent-class (`regulatory_correspondence_7y`, new class); analytics 7 years.

#### State machine
`received → triaged (taxonomy, flags, linked cases) → investigating → (regulator_interim_sent)? → resolved (remediation executed) → responded → closed`; parallel: `udaap_review` (opened by a flag or monitor breach) `→ finding | no_finding`; `population_remediation` sub-process for systemic findings. Guards: regulator complaints cannot be `responded` without `officer` approval; `resolved` requires root-cause code and remediation decision; `closed` requires the borrower response evidence and, for NY, the 419.6 disclosure; a complaint that is also an NoE cannot close before the NoE responds; `fair_lending` and `servicemember` flags require the respective reviewer sign-off (`officer`).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_COMPLAINT_ACK_1BD` | deadline (policy) | `case.complaint.opened` | received_at | 1 `business_days_servicer` | acknowledgment (any channel; written for written complaints) | supervisor alert |
| `SM_COMPLAINT_RESOLVE_15` | deadline (policy, aligned to CFPB 15 days) | `case.complaint.opened` | received_at | 15 `calendar_days` | `case.complaint.responded` | `officer` report |
| `CFPB_PORTAL_RESPONSE_15` | deadline | `regulator.complaint.received` (CFPB) | received_at | 15 `calendar_days` | portal response submitted (closed or "in progress") | `officer` sev-1 (public "untimely response" flag) |
| `CFPB_PORTAL_FINAL_60` | deadline | same, when "in progress" used | received_at | 60 `calendar_days` | final portal response | `officer` sev-1 |
| `STATE_REGULATOR_COMPLAINT_RESPONSE_<XX>` | deadline (jurisdiction) | `regulator.complaint.received` (state) | received_at / regulator-stated due | per `jurisdiction_rules.complaint_response` **[UNVERIFIED per state]** | response submitted | `officer` sev-1 |
| `NY_419_6_COMPLAINT_ACK_5BD` | deadline (NY) | `case.complaint.opened` (NY loan) | received | 5 `business_days_servicer` | written acknowledgment | `officer` sev-2 |
| `NY_419_6_COMPLAINT_RESPONSE_30BD` / `_FC_15BD` / `_PAYOFF_7BD` / `_EXT_7BD` | deadline (NY) | same | received | 30 / 15 (or before sale) / 7 / +7 `business_days_servicer` | written response | `officer` sev-1 |
| `TX_50A6_CURE_60` | deadline | `complaint.tx_50a6_defect.alleged` | notice date | 60 `calendar_days` | cure executed + Form 20 escalation logged | `attorney` + `officer` sev-1 |
| `FNMA_REFERRAL_RESPONSE_5BD` | deadline (policy; Fannie Mae SLA **[UNVERIFIED]**) | `investor.referral.received` | received | 5 `business_days_fannie_et` | response to Fannie Mae | `officer` sev-2 |
| `FNMA_A4_2_1_04_EMAIL_48H` | deadline | inbound email | received_at | 48 hours | reply | ops alert |
| `SM_UDAAP_REVIEW_10BD` | deadline (policy) | `udaap_review.opened` | opened | 10 `business_days_servicer` | finding/no-finding record | `officer` |
| `SM_POPULATION_REMEDIATION_60` | deadline (policy) | `udaap_review.finding` (systemic) | finding date | 60 `calendar_days` | remediation executed | `officer`, partner notice |
| `CFPB_CONSUMER_FEEDBACK_60` | informational | portal response | response date | 60 `calendar_days` | — | none (monitor feedback) |

Complaints that are also NoE/RFI inherit the 4.1/4.2 rule timers; the command layer enforces the earliest applicable date.

#### Business rules and calculations
1. **Worked dates.** CFPB portal complaint received Thu **2026-09-10** → response (closure or "in progress") by **2026-09-25**; final by **2026-11-09**; the consumer feedback window runs 60 days from the response. A direct email complaint received the same day must get a substantive reply within 48 hours (A4-2.1-04) and resolution within the 15-day policy target.
2. **Triage.** The Intake Router assigns taxonomy codes and flags; `severity=critical` for foreclosure-sale-imminent, discrimination, servicemember, disaster, safety/abuse, media/regulator; `repeat` when ≥2 complaints on the loan in 90 days. Every complaint is checked for NoE/RFI substance (comment 35(a)-2) — a written complaint saying "you charged me a late fee I don't owe" opens an NoE (b5) with its own clock; an oral version opens a complaint and triggers the §1024.38(b)(5) script ("if you are not satisfied, you can send a written notice of error to …").
3. **Investigation and resolution** use the 4.1 tool set; corrections post through the same commands. Monetary remediation example: a complaint reveals a $15.00 pay-by-phone convenience fee assessed on 2026-06-15 without the disclosed fee schedule for that channel → reverse 1,500¢ (`other_fees` −1,500 / `borrower_receivable` +1,500, or refund by check if paid), `closed_with=monetary_relief`, root cause `2.1 fee disclosure`. **Population test:** the monitor `FEE_COMPLAINTS_PER_1000` and a query of the same fee code for the same channel over a 24-month lookback find 1,240 loans × 1,500¢ = **1,860,000¢ ($18,600.00)** → `population_remediations` record, `officer` approval, refunds posted with the original assessment dates reversed, borrower letters (`NTC_REMEDIATION_REFUND`), Metro 2 corrections if any delinquency resulted, and a partner notification; if any refunded fee had been claimed from Fannie Mae as a reimbursable expense, the claim is corrected (15.2).
4. **UDAAP screen** (applied to every complaint and to monitor breaches): (a) *Unfair*: injury (money, lost options, credit harm) × avoidability (could the borrower have avoided it given our disclosures/conduct?) × benefits; (b) *Deceptive*: was any statement/omission likely to mislead a reasonable borrower and material — includes AI statements (inaccurate deadline or option information is deceptive per se in effect); (c) *Abusive*: did the interaction take unreasonable advantage of lack of understanding or reliance (e.g., steering a borrower away from a written NoE, discouraging loss-mit applications, exploiting confusion about fees). Output: `udaap_review` finding with the statutory element analysis; findings feed 18.1 QC and the LL-2026-04 program.
5. **Responses** are plain language, state what was found, what was fixed and when, what the borrower can do next (NoE/RFI, appeal, regulator contact where required — NY DFS line), and never require a payment to proceed. Regulator responses attach evidence (statements, ledger, notices, transcripts) with PII minimization and `officer` sign-off.
6. **Analytics thresholds** (defaults): complaints per 1,000 loans per month by category; alert at 2σ above the trailing 6-month mean or above absolute thresholds in `udaap_monitors`; AI-interaction complaints are reported weekly to the AI governance owner; "could not reach a human" is a zero-tolerance monitor (each instance investigated).
7. **Fair lending / language access:** complaint rates by `preferred_language` and by demographic proxies (where lawfully available, 19.4) reviewed quarterly; translation quality complaints route to the language-access owner.

#### Integrations
CFPB Company Portal (web portal; manual submission by `officer`-approved package — no API is documented **[UNVERIFIED]**; an AI-prepared package with the response text, attachments and category); state regulator portals/email (`jurisdiction_rules`); Fannie Mae referrals (email/portal per Fannie Mae's escalation process **[UNVERIFIED channel]**; AI-prepared package, `officer` sends); partner queue (shared API); telephony/chat/email/mail as in 4.1; e-OSCAR/bureaus for credit corrections (8.2); print/mail for response letters. Fannie Mae reporting: none for complaints as such; Form 20 for Texas §50(a)(6) allegations and other non-routine litigation (13.7) goes through the litigation process; fee refunds that affect expense claims flow to 15.2. Outage: portal unavailability is documented with screenshots and the response is sent by the regulator's alternate channel; timers do not pause.

#### Outputs and artifacts
Notices/templates: `NTC_COMPLAINT_ACK` (written complaints; NY variant with 419.6 disclosures), `NTC_COMPLAINT_RESPONSE` (with the §1024.38(b)(5) procedures paragraph and the exclusive address), `NTC_REMEDIATION_REFUND`, regulator response package templates (CFPB, state), `NTC_TX_50A6_CURE` (with attorney review), oral-complaint script (`SCRIPT_38B5_ORAL_COMPLAINT`). Records: the complaint log (`v_complaint_log`: source, receipt, category, flags, linked cases, deadlines, response dates, resolution, remediation, root cause), `udaap_review` records, `population_remediations`, analytics dashboards, quarterly complaint-committee report (partner + officer), LL-2026-04 monitoring extracts. Ledger: fee reversals/refunds as balanced entries linked to the case. Investor events: only where corrections change reportable data.

#### AI agent design (AI-first)
- `borrower-comms` recognizes dissatisfaction in any channel (explicit or sentiment-inferred), acknowledges, resolves what it can immediately (e.g., explains an escrow analysis with the actual figures, reverses a fee within its authority), offers the written NoE/RFI path when the borrower is not satisfied (comment 38(b)(5)-2), and offers a human/supervisor on request (CA §2923.7(d)). `case` agent runs triage, investigation, resolution, response drafting, root-cause coding, and the UDAAP screen; `compliance-sentinel` runs monitors; `qc-audit` samples closures.
- Decision record: `{case_id, taxonomy, flags, linked_cases, investigation_records[], udaap_analysis{unfair, deceptive, abusive: element-by-element}, resolution, remediation_cents, root_cause, response_text_hash, confidence, reviewer?}`.
- Guardrails: never dismiss a complaint for tone or repetition; never condition resolution on payment; never promise outcomes on loss mitigation; monetary authority limits (AI: ≤ 50,000¢ per loan without approval; `officer` above); regulator responses always human-approved; discrimination/servicemember/AI-adverse-decision complaints always route to `officer` (and to 12.3 human review for Colorado AI Act appeals).
- Human touchpoints: **legally/contractually anchored** — `officer` signs regulator/exam responses and Texas §50(a)(6)/Form 20 escalations (baseline §8 item 3), `attorney` for litigation demands and Texas cure instruments, `lossmit_reviewer` for complaints that reopen an adverse loss-mit decision, `human_agent` on request. AI-off path: `human_agent` works the same case UI with AI drafting only.
- Disclosure: AI-drafted regulator responses are reviewed by a human and sent under the officer's name; borrower-facing AI interactions carry the automation disclosure.

#### Edge cases and failure modes
- **Complaint that is really a loss-mit application or appeal:** open 12.1/12.3 with the correct receipt date; the complaint remains for analytics.
- **Anonymous or third-party complaints (neighbor, HOA):** log, investigate internally, no account disclosure without authorization (GLBA).
- **Regulator complaint about a loan not serviced by Supermortgage** (wrong servicer): respond within the clock explaining and pointing to the correct servicer; no data disclosed.
- **Complaints during transfer-in/out:** transferor-period issues investigated with transferor records (1.x); open regulator complaints transfer with the file and the regulator is informed of the new respondent.
- **Bankruptcy/attorney representation:** responses to counsel; no collection content.
- **Servicemember complaint:** SCRA review (13.8/13.9) and DOJ/DMDC evidence.
- **Disaster:** complaint volume spikes are expected; monitors use disaster-adjusted baselines; forbearance-related complaints reviewed against LL-2026-01 limits (12.4).
- **AI failure modes:** misclassification (missed dispute) → detected by QC sampling and by the "borrower repeats the same issue" monitor; hallucinated facts → decision records make every stated fact traceable to a tool result; if not traceable, the response is blocked.
- **Vendor/portal outages:** documented; alternate channel; timers continue.
- **Media/social complaints:** treated as complaints with `media` flag; no public reply with account details.
- **Population remediation reversals:** if a remediation was over-inclusive, corrections are new entries with explanation letters; never claw back without officer/legal review.

#### Test cases and acceptance criteria
- **4.5-T1:** Given a CFPB portal complaint received 2026-09-10, then the AI package is ready ≤5 days, `officer` approval recorded, and the portal response submitted by 2026-09-25; if "in progress," a final response by 2026-11-09.
- **4.5-T2:** Given a phone call "you people keep charging me late fees," then a complaint case opens, the AI checks the late-charge history live, reverses any unsupported charge within authority, and the §1024.38(b)(5) script is read (transcript evidence); no NoE case opens for an oral complaint, but the written-procedure reminder is logged.
- **4.5-T3:** Given a written version of T2, then both a complaint and an NoE (b5) case exist with linked ids and the NoE clocks govern the written response.
- **4.5-T4 (NY):** Given a NY loan and an emailed complaint, then a written acknowledgment ≤5 BD with the DFS CAU disclosure and a response ≤30 BD (or ≤15 BD if foreclosure-related).
- **4.5-T5 (Texas):** Given a §50(a)(6) loan and a letter alleging a constitutional defect, then `attorney`/`officer` escalation, Form 20 package prepared, and the 60-day cure timer started on the notice date.
- **4.5-T6 (population remediation):** Given three complaints in a month about an undisclosed pay-by-phone fee, then the monitor opens a `udaap_review`, the lookback query identifies 1,240 loans, the remediation totals 1,860,000¢, `officer` approves, refunds post with reversal entries, letters mail, and the partner is notified.
- **4.5-T7 (AI complaint):** Given a chat transcript where the borrower asked for a human twice without transfer, then `AI_HUMAN_REQUEST_UNMET` fires, the case is `critical`, and the governance owner is notified the same day.
- **4.5-T8 (fair lending):** Given a complaint alleging discrimination in a loss-mit denial, then `officer` review, 19.4 record, 12.3 appeal handling, no AI-only closure.
- **4.5-T9 (wrong servicer):** Given a state regulator complaint for a loan not on the platform, then a response within the state clock with no borrower data.
- **4.5-T10 (email SLA):** Given an inbound email complaint at 09:00 ET Monday, then a substantive reply by 09:00 ET Wednesday (48h).
- **4.5-T11 (analytics):** Given the monthly refresh, then complaints per 1,000 loans by category and by `preferred_language` are produced and monitor breaches create `officer` tasks.
- **4.5-T12 (monetary authority):** Given an AI-proposed refund of 75,000¢, then the correction is blocked pending `officer` approval and the borrower is told the review timeline.

#### Audit and evidence
Complaint log with source/external references, taxonomy history, linked cases, every response with evidence of delivery/submission (portal receipts, emails, mail proofs), officer approvals, UDAAP element analyses, root-cause codes, remediation ledger entries and population-remediation approvals, monitor evaluations and alerts, quarterly committee minutes, LL-2026-04 monitoring extracts, QC sample results; all exportable for CFPB/state exams, MORA and the partner's vendor oversight (A2-1-01 subservicer oversight duties).

### Open questions / decisions
1. **4.5-Q1 Regulator-facing respondent.** Default: Supermortgage registers its own CFPB Company Portal and state portals (as the licensed servicer performing the activity) and the partner is copied; alternative: partner-registered with Supermortgage as delegated responder.
2. **4.5-Q2 Complaint definition breadth.** Default: any expression of dissatisfaction, including sentiment-inferred, counted for analytics; formal SLAs apply to explicit complaints.
3. **4.5-Q3 Monetary authority for AI** (50,000¢ per loan) and population-remediation approval thresholds.
4. **4.5-Q4 Fannie Mae referral SLA** — confirm the Servicer Escalation process day count **[UNVERIFIED]**; default 5 Fannie ET BD.
5. **4.5-Q5 NY 419.6 scope for oral complaints** — default apply clocks to all NY complaints.

### Sources
- 12 U.S.C. 5531: https://www.law.cornell.edu/uscode/text/12/5531 (verified 2026-09-09); 12 U.S.C. 5536: https://www.law.cornell.edu/uscode/text/12/5536
- CFPB complaint process: https://www.consumerfinance.gov/complaint/process/ (verified 2026-09-09); Consumer Complaint Database fields: https://cfpb.github.io/api/ccdb/fields.html (verified 2026-09-09)
- CFPB guidance withdrawal (May 12, 2025) — 2023 abusiveness policy statement withdrawn: https://www.federalregister.gov/documents/2025/05/12/2025-08286/interpretive-rules-policy-statements-and-advisory-opinions-withdrawal (verified 2026-09-09); summary list: https://www.americascreditunions.org/blogs/compliance/withdrawn-sixty-seven-pieces-guidance-withdrawn-cfpb
- 12 CFR 1024.38(b)(1)(ii), (b)(5) and comments: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.38 ; https://www.consumerfinance.gov/rules-policy/regulations/1024/interp-38/ (verified 2026-09-09)
- 3 NYCRR 419.6: https://regulations.justia.com/states/new-york/title-3/chapter-iii/subchapter-b/part-419/section-419-6/ (verified 2026-09-09)
- Cal. Civ. Code §2923.7: https://law.justia.com/codes/california/code-civ/division-3/part-4/title-14/chapter-2/article-1/section-2923-7/ (verified 2026-09-09)
- Fannie Mae A2-1-01 (12/17/2025), A4-1-03 (12/20/2023), A4-2.1-04 (12/16/2015): links in 4.1 sources (verified 2026-09-09)
- CFPB, Chatbots in consumer finance (June 6, 2023): https://www.consumerfinance.gov/data-research/research-reports/chatbots-in-consumer-finance/chatbots-in-consumer-finance/ (verified 2026-09-09)
- research/00a-regulatory-status.md §§3.5 (LL-2026-04), 5.4 (state enforcement), 5.6 (AI laws), 6.6 (CFPB status).
