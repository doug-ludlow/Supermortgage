# 13.7 — Environmental hazard / non-routine litigation

| Attribute | Value |
|---|---|
| Section | 13 — Foreclosure |
| Automation class | c |
| SoR / Sub | Sub |
| Trigger & frequency | On awareness |
| Governing source | FNMA F-1-08; Form 20 |
| Key deadlines | Do not begin foreclosure; notify Fannie Mae Legal immediately |
| Timers | `FNMA_E1301_PLEADING_REVIEW_GATE`, `FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE`, `FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE`, `FNMA_E1302_FORM20_2BD`, `FNMA_E1302_FORM20_EXCEPTION_TRIGGER`, `FNMA_F108_ENV_LITIGATION_FORM20_0`, `FNMA_F108_ENV_NO_FORECLOSURE_GATE`, `FNMA_F108_LEAD_PAINT_NOTIFY_30`, `FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE`, `LITIGATION_HOLD`, `SM_ENV_SERVICING_REP_REPORT_2BD`, `SM_FORM20_RESPONSE_FOLLOWUP_10BD`, `SM_LITIGATION_STATUS_UPDATE_MONTHLY` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Foreclosure |
| Trigger & frequency | On awareness |
| Governing source (blueprint) | FNMA F-1-08; Form 20 |
| Key deadlines (blueprint) | Do not begin foreclosure; notify Fannie Mae Legal immediately |
| Data/artifacts | Form 20 |
| Systems | Fannie Mae Legal |
| Automation class (blueprint) | c |
| SoR / Sub | S[cropped in source] — read as Sub prepares; Partner `officer`/counsel positions; Fannie Mae Legal directs |
| Nuances (blueprint) | "es…" [cropped in source] — reconstructed as **escalate**: Form 20 (Non-Routine Litigation Form) to Fannie Mae's Legal department "within two business days of the servicer receiving notice of the litigation" (E-1.3-02); Fannie Mae "reserves the right to direct and control all litigation" (E-1.3-01); prior written approval before removal to federal court or appeal; environmental hazards — "must not begin foreclosure proceedings" and report to the Servicing Representative (F-1-08), 30-day lead-paint notification, Massachusetts citation search, Form 20 "immediately" for environmental litigation |

### Verified requirement (as of 2026-09-09)

**E-1.3-01, General Servicer Responsibilities for Non-Routine Matters (10/11/2023 — verified today).** Non-routine litigation is any action, regardless of whether Fannie Mae is a party, that (1) "seeks monetary damages against Fannie Mae, its officers, directors, or employees"; (2) "challenges the validity, priority, or enforceability of a Fannie Mae mortgage loan or seeks to impair Fannie Mae's interest in an acquired property"; or (3) "presents an issue that may pose a significant legal or reputational risk to Fannie Mae." Examples: counterclaims/cross-claims/third-party claims for damages; code-violation demolition actions; lien-avoidance actions; priority disputes by other lienholders; quiet-title actions; cramdowns; conservatorship/FHFA matters; "federal agency" claims; due-process/constitutional challenges; challenges to Fannie Mae's business methods; putative class actions; standing challenges "with precedential impact"; MERS business-method/nominee challenges; show-cause orders or sanctions motions; foreclosures on Native American tribal lands; environmental litigation; judicial foreclosures where non-judicial predominates; HAMP-based challenges; Chapter 15 cross-border insolvency; predatory-lending or discrimination claims; Uniform Instrument interpretation claims. Routine (not reportable): "a contested foreclosure action in which the borrower alleges a case-specific procedural or technical defect" or "a case specific payment application claim" — unless the argument has "broader application to other Fannie Mae mortgage loans." Duties: "Notify Fannie Mae's Legal department of any non-routine litigation by submitting a Non-Routine Litigation Form (Form 20)"; "Fannie Mae reserves the right to direct and control all litigation involving a Fannie Mae mortgage loan, and the servicer and any law firm handling the litigation must cooperate fully"; "Obtain Fannie Mae's prior written approval before either removing a case to federal court based on Fannie Mae's Charter, or appealing or otherwise challenging judgment" in foreclosure/bankruptcy; "Periodically update Fannie Mae on the progress"; "Provide Fannie Mae with sufficient opportunity in advance of any deadline or due date to review and comment upon proposed substantive pleadings" (motions, responses, replies, briefs); "Notify retained counsel of its proposal to offer any payment deferral or mortgage loan modification and provide counsel with sufficient opportunity in advance."

**E-1.3-02, Reporting Non-Routine Litigation to Fannie Mae (05/10/2023 — verified today).** "Non-routine litigation must be reported to Fannie Mae's Legal department using the Non-Routine Litigation Form (Form 20) within two business days of the servicer receiving notice of the litigation." Exception for three categories — servicer standing challenges, MERS business-method/nominee challenges, HAMP-based challenges — which are reported only when "the borrower seeks summary judgment on such a challenge," "briefing is required in response to such a challenge," or "the issue is expected to be raised at a scheduled trial." Form 20 is submitted at **quatro.fanniemae.com** (E-1.3-01/-02 and F-4-02: "Notify Fannie Mae of non-routine litigation and certain matters requiring escalation" — Form 20 submission via quatro.fanniemae.com). Form contents are not enumerated in the Guide **[UNVERIFIED — field list to be captured from the quatro form at onboarding]**. E-1.3-03 covers reporting "legal filings" to MERS (MERS Rules: notice of litigation naming MERS — research/00b N1) **[PARTIALLY VERIFIED — topic title only]**.

**F-1-08, Managing Foreclosure Proceedings — "Reporting Environmental Hazards to Fannie Mae" (05/10/2023 — verified today).** "The servicer must not begin foreclosure proceedings for any mortgage loan if it becomes aware of environmental hazards"; report hazard information to the Fannie Mae Servicing Representative (F-4-02); for lead-based-paint citations or violations on 1–4 unit properties, submit the notification "within 30 days after referral" including the current property value, the outstanding debt, whether children under 8 reside at the property, and documentation of the violations; **Massachusetts**: "Conduct actual citation search before foreclosure referral" and contact the Servicing Representative regarding reimbursement; for environmental litigation "immediately" submit Form 20 to Legal. E-1.2-02 repeats the Servicing Representative contact duty. E-3.2-13 (title defects) and E-3.3-05 (significant uninsured hazard damage ⇒ contact the Servicing Representative before bidding) are adjacent escalations.

**A4-2.2-02 / F-4-02 (05/13/2026).** Firm-related escalations go by email to loanservicing@fanniemae.com ("To report escalated matters to Fannie Mae"); litigation goes on Form 20 via quatro; due-on-sale unenforceability notices use loanservicing@ with subject "ACTION REQUIRED: TRANSFER OF OWNERSHIP REVIEW"; SF CPM excess fees at sfcpm_excess_fees@fanniemae.com; disaster approvals at hazard_loss@fanniemae.com; military indulgence/Form 1022 at militaryindulgence@fanniemae.com.

**Fees for non-routine matters.** E-5-04: litigation arising from borrower defenses "related to origination or servicing (including payment disputes)" is at the servicer's expense; unexpected-event services (court continuances, probate, HOA/taxing-authority intervention) may be reimbursed; excess fees via SF CPM. Fannie Mae-directed litigation costs follow Fannie Mae's direction (E-1.3-01) **[PARTIALLY VERIFIED — cost allocation for Fannie Mae-directed defense not stated in the topics retrieved]**.

**Other law.** FDCPA/Reg F (Section 11.4) for counterclaims alleging collection violations; RESPA §6(f) private actions (research/00a §6.6) — the platform's 13.1/13.2 evidence is the defense; TILA/Reg Z claims (7.x); state UDAP; MERS Rules (litigation notice to MERS); CERCLA/state environmental statutes — foreclosure and post-sale ownership create lender-liability exposure that Fannie Mae wants to assess before title vests (the reason for the "do not begin" rule).

**Discrepancies with the blueprint row.** (1) "Notify Fannie Mae Legal immediately" is right only for environmental *litigation*; the general Form 20 deadline is **2 business days** from notice, with the three-category exception. (2) Environmental *hazards* (not litigation) go to the **Servicing Representative**, with the 30-day lead-paint notification and the Massachusetts pre-referral citation search — none in the row. (3) The row lists "Form 20" as the artifact but omits the prior-approval requirements (removal, appeal) and the pleading-review duty. (4) Automation "c" is correct for legal strategy (attorney/Fannie Mae), but detection, classification, Form 20 preparation, holds and tracking are AI-performed; Form 20 filing on the quatro portal is a `fnma_portal_operator` task.

### Operational prerequisites
- Access to quatro.fanniemae.com (Form 20) provisioned to named Supermortgage employees under the partner's authorization (`fnma_portal_operator`); capture the form's field list and attachment limits at onboarding.
- Legal intake channels: registered-agent service-of-process feed (partner and Supermortgage), firm litigation notices via the attorney network (`NARRATIVE{kind=litigation}`), court docket alerts, complaint intake (4.3) with litigation-threat classification, regulator/AG inquiries (Section 19).
- Environmental data: inspection vendor findings (11.x/PFPIP), code-violation feeds where available, Massachusetts lead-paint citation search vendor/process, disaster/hazard overlays (9.x).
- Partner: designation of the officer/in-house counsel who receives Legal's directions and grants settlement/position authority; engagement of litigation counsel (special counsel or the retained firm) per A4-2.2-01.
- Notice Registry: no borrower notices; internal templates for the Servicing Representative environmental report and the Form 20 narrative.

### Build spec
#### Inputs and triggers
- `litigation.notice.received{source ∈ {service_of_process, firm, docket, complaint, regulator}, documents[]}`; `firm.narrative{kind=contested}` (13.6); `bankruptcy.adversary.filed` (14.x); `complaint.received{alleges ∈ {servicing_violation, discrimination, ...}}` (4.3).
- `environmental.hazard.suspected{source ∈ {inspection, code_violation, borrower, firm, disaster}, kind ∈ {lead_paint, asbestos, contamination, meth_lab, underground_tank, flood_mold, other}}`; `inspection.completed{findings}`; `environmental.ma_citation_search.completed`.
- Method deviation proposals (13.5) and other Regional Counsel approval requests routed on Form 20.
- Fannie Mae responses (quatro status, Legal emails, Servicing Representative emails).

#### Data model
- `litigation_matters` (new): `matter_id`, `loan_id`, `case_id?`, `court`, `docket_no`, `caption`, `role` ∈ {defendant, plaintiff, third_party}, `served_at`, `notice_received_at`, `classification` ∈ {routine, non_routine}, `categories text[]` (E-1.3-01 list), `exception_category` ∈ {standing, mers, hamp, none}, `exception_trigger` ∈ {summary_judgment, briefing, trial, none}, `form20_required bool`, `form20_due_at`, `form20_submission_id?`, `fnma_direction jsonb`, `counsel_firm_id`, `special_counsel bool`, `pleading_deadlines[]`, `status` ∈ {open, stayed, settled, judgment, dismissed, appeal, closed}, `fc_hold_id?`, `decision_id`.
- `form20_submissions` (new): `id`, `matter_id?`, `kind` ∈ {non_routine_litigation, environmental_litigation, method_deviation, other_escalation}, `prepared_at`, `package_document_id`, `submitted_at?`, `submitted_by` (portal operator), `quatro_reference?`, `fnma_response?`, `responded_at?`.
- `environmental_hazards` (new): `id`, `loan_id`, `property_id`, `kind`, `source`, `detected_at`, `severity` ∈ {suspected, confirmed}, `citation_document_id?`, `children_under_8 bool?`, `property_value_cents?`, `outstanding_debt_cents?`, `servicing_rep_reported_at?`, `lead_paint_notification_due_at?`, `fnma_direction?`, `fc_hold_id`, `status` ∈ {open, cleared, fnma_directed_proceed, fnma_directed_hold, charged_off}.
- `foreclosure_holds{kind ∈ {litigation, environmental}}` (13.2).
- Retention `life_of_loan_plus_4y` + litigation hold flag; privileged documents tagged `privileged=true` with restricted access.

#### State machine
Litigation: `notice_received` → `classified{routine|non_routine}`; non-routine → `form20_due` → `form20_submitted` → `fnma_directed` (strategy/approvals) → `active` (pleadings under review cadence) → {`settled` | `judgment` → (`appeal_requested` → needs approval) | `dismissed`} → `closed`. Routine → `monitored` (firm handles; re-classify on any broader-application argument or damages claim). Environmental: `suspected` → `confirmed`/`cleared`; confirmed ⇒ `fc_hold(environmental)` → `reported_to_servicing_rep` → `fnma_directed{proceed|hold|charge_off|other}` → hold released or case closed. Actors: agent (detection, classification, packages, holds), `fnma_portal_operator` (Form 20 filing), `attorney` (pleadings), `officer` (positions/settlement authority/approvals), Fannie Mae (direction).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_E1302_FORM20_2BD` | deadline | `litigation.notice.received` classified non-routine (non-exception) | notice_received_at | +2 business_days_servicer | `form20_submissions.submitted` | sev 1 → `officer`; late filing documented |
| `FNMA_E1302_FORM20_EXCEPTION_TRIGGER` | deadline | `litigation.trigger{summary_judgment|briefing|trial}` for standing/MERS/HAMP matters | trigger date | +2 business_days_servicer (policy: same clock) | Form 20 submitted | sev 1 |
| `FNMA_F108_ENV_LITIGATION_FORM20_0` | deadline | `litigation.notice.received{environmental}` | notice | same day ("immediately") | Form 20 submitted | sev 1 |
| `FNMA_F108_ENV_NO_FORECLOSURE_GATE` | not_before_gate | `environmental.hazard.confirmed` (or suspected pending confirmation — policy) | — | until Fannie Mae direction to proceed | `environmental_hazards.fnma_direction=proceed` | refer/first-notice/judgment/sale refused |
| `FNMA_F108_LEAD_PAINT_NOTIFY_30` | deadline | `environmental.hazard.confirmed{lead_paint}` on a referred loan | referral date | +30 calendar_days | Servicing Representative notification with value, debt, children<8, documentation | sev 1 |
| `FNMA_F108_MA_LEAD_PAINT_SEARCH_GATE` | not_before_gate (13.4) | MA prereferral review | — | citation search done | — | referral refused |
| `SM_ENV_SERVICING_REP_REPORT_2BD` | deadline (policy) | `environmental.hazard.confirmed` | confirmation | +2 business_days_servicer | report sent | sev 2 |
| `FNMA_E1301_PLEADING_REVIEW_GATE` | not_before_gate | substantive pleading due | filing deadline | Fannie Mae given the draft ≥5 business_days_servicer before the deadline (policy for "sufficient opportunity") | Fannie Mae comments received or window elapsed | `attorney` files only after the window |
| `FNMA_E1301_REMOVAL_APPEAL_APPROVAL_GATE` | not_before_gate | proposed removal to federal court / appeal | — | Fannie Mae prior written approval | approval document | refused |
| `FNMA_E1301_WORKOUT_NOTIFY_COUNSEL_GATE` | not_before_gate | 12.x deferral/modification offer on a litigated loan | — | counsel notified with sufficient opportunity (policy 5 BD) | counsel ack | offer held |
| `LITIGATION_HOLD` (`foreclosure_holds.kind=litigation`) | hold | non-routine classification with a challenge to enforceability/standing, or Fannie Mae direction | — | until direction/resolution | — | judgment/sale refused |
| `SM_FORM20_RESPONSE_FOLLOWUP_10BD` | deadline (policy) | Form 20 submitted | submission | +10 business_days_fannie_et | Fannie Mae direction recorded | follow-up via Legal email |
| `SM_LITIGATION_STATUS_UPDATE_MONTHLY` | recurring | non-routine matter open | — | monthly | update sent to Fannie Mae (E-1.3-01 "periodically") | sev 3 |

#### Business rules and calculations
1. **Classification** (rules + model): `non_routine` if any category matches; damages sought against Fannie Mae/officers ⇒ category 1; validity/priority/enforceability/impairment ⇒ 2; enumerated risk issues ⇒ 3. Routine: case-specific procedural/technical defect or payment-application claim without broader application. The model extracts claims from the pleading and maps them to categories with citations; confidence < 0.8 or any damages claim ⇒ `attorney` confirmation before "routine" is accepted (conservative default: when in doubt, file Form 20 — over-reporting has no penalty).
2. **Exception categories** (standing, MERS, HAMP): file only on the trigger (summary judgment sought, briefing required, expected at trial) — the trigger is detected from docket/firm narratives; the 2-BD clock runs from the trigger.
3. **Deadline computation**: "receiving notice" = earliest of service on the partner/Supermortgage, firm notice, or docket alert; 2 servicer business days; example: served Thursday Sept. 10, 2026 ⇒ Form 20 by Monday Sept. 14, 2026.
4. **Holds**: any non-routine matter that attacks enforceability/standing/priority or seeks to enjoin the foreclosure opens `LITIGATION_HOLD` on `judgment_motion` and `sale_conduct` until Fannie Mae directs; damages-only counterclaims do not automatically hold the foreclosure (firm continues; status 33 for delay credit).
5. **Environmental**: `suspected` (single inspection note) triggers confirmation (second inspection/expert/citation) within 10 days (policy); `confirmed` ⇒ gate closed, Servicing Representative report (value, debt, occupancy, children < 8, documentation, recommendation), lead-paint 30-day notification if referred; Fannie Mae may direct to proceed, hold, pursue charge-off/deed-in-lieu or other resolution (Section 12/15). Massachusetts: citation search before referral is mandatory (checklist item, 13.4).
6. **Method deviation** (13.5): Form 20 to Regional Counsel with the firm's analysis (time/cost/deficiency benefit) — gate before initiation.
7. **Approvals**: removal to federal court on the Charter and any appeal require Fannie Mae's prior written approval — recorded as documents; the partner `officer` transmits the request (position of the servicer of record).
8. **Costs**: fees for defending origination/servicing-based claims are the servicer's (allocation partner vs Supermortgage per the subservicing agreement by cause); Fannie Mae-directed matters per direction; excess fees via SF CPM.

#### Integrations
- **quatro.fanniemae.com (Form 20)** — portal-only: `human_portal_task{kind=form20}` with the AI package: loan identifiers (Fannie Mae loan number, servicer number), property, case caption/court/docket, parties, claims summary with category mapping, key dates and deadlines, pleadings (PDF), recommendation, counsel contact, prior history; operator enters/uploads, records the quatro reference and response. SLA timer per the 2-BD deadline (task due 1 BD after package ready).
- **Fannie Mae Legal email** (loanservicing@fanniemae.com) — follow-ups, status updates, approval requests where Legal directs email; **Servicing Representative** — environmental reports (F-4-02 contact per assigned rep); **hazard_loss@** for disaster (13.4).
- **Attorney network** — litigation narratives, pleadings, deadlines, Fannie Mae directions relayed; `attorney` escalations.
- **Registered agent / service of process** — inbound documents (email/SFTP) → intake; **docket alerts** — court e-filing feeds where firms provide them; PACER for adversary proceedings (14.x).
- **MERS** — E-1.3-03 legal-filings reporting where MERS is named (adapter message or MERS OnLine task) **[PARTIALLY VERIFIED]**.
- Failure: quatro unavailable ⇒ email Legal with the package and note the portal outage (documented "immediately"), file on the portal when restored.

#### Outputs and artifacts
- Events: `litigation.matter.opened{classification}`, `form20.prepared/submitted/responded`, `litigation.hold.opened/released`, `litigation.approval.requested/granted{removal|appeal}`, `environmental.hazard.confirmed/cleared`, `environmental.report.sent`, `lead_paint.notification.sent`, `litigation.status_update.sent`.
- Documents: Form 20 package and quatro receipt; environmental report to the Servicing Representative; pleading drafts with Fannie Mae comment logs; approval letters; monthly status updates.
- Ledger: litigation costs → `servicing_expense` or `corporate_advances{claimable}` per allocation; environmental testing/remediation advances per Fannie Mae direction (15.2 claim eligibility).
- Investor events: status code 33 (contested) while litigated; BE (title) where applicable; delay credit per 13.5.
- Notices: none to the borrower (communications go through counsel once represented; 4.x/11.x contact rules honour attorney representation).

#### AI agent design (AI-first)
`foreclosure-ops` (litigation intake sub-agent) detects, classifies, computes deadlines, prepares the Form 20 package and environmental reports, opens holds, tracks pleading-review windows and status updates. Tools: `documents.extract` (pleadings), `litigation.classify` (rules + model), `foreclosure.case.get`, `attorney.message.send`, `email.send{fnma_legal|servicing_rep}`, `portal_task.create{form20}`, `escalation.create`. Decision record: `{matter_id, source, extracted_claims[], categories[], exception_category, routine_or_non_routine, confidence, form20_due_at, holds_opened[], rationale, model_version}`. Guardrails: the agent never files pleadings or communicates positions to courts/opposing counsel; it never states Fannie Mae's position; environmental "cleared" requires human-reviewed evidence (`attorney` or licensed inspector report). Escalations: `fnma_portal_operator` (quatro filing), `attorney` (all substantive litigation; classification confirmation; pleading drafts), `officer` (partner) for positions, settlement authority, removal/appeal requests and any Fannie Mae direction requiring the servicer of record's acknowledgment; `human_agent` for borrower contact questions when a borrower is represented. AI-off path: intake queue with the same rule set; deadlines still enforced by timers.

#### Edge cases and failure modes
- Service on the partner (not Supermortgage): the partner's registered-agent feed must reach the platform within 1 BD (contract) — the 2-BD clock runs from the partner's receipt.
- Counterclaim filed by the borrower in the foreclosure (damages against the servicer only): non-routine if damages against Fannie Mae or broader-application arguments; otherwise routine — but RESPA/TILA class allegations ⇒ non-routine (putative class).
- Show-cause/sanctions motion against the firm: Form 20 (non-routine) plus 13.6 escalation (2 BD, loanservicing@).
- Environmental hazard found after the sale (REO): 15.x (E-4.3) with the same Servicing Representative channel.
- Tribal trust land discovered late: Form 20 + hold; referral package must have flagged Native American land (E-1.1-03).
- Judicial foreclosure in a non-judicial-preferred state without approval: stop and file Form 20 for retroactive approval; 13.5 exposure computed on the preferred method.
- Fannie Mae directs charge-off/lien release for contaminated property: Section 12/16 flows; MI notification (10.x).
- Bankruptcy adversary proceeding attacking the lien: 14.x + Form 20 (validity challenge).
- Transfer-out with open litigation: matter file and Fannie Mae directions in the transfer package; Fannie Mae informed of the counsel change (E-1.1-01 transfer rules).

#### Test cases and acceptance criteria
- 13.7-T1 Given a complaint served Thursday Sept. 10, 2026 alleging a quiet-title claim, Then classification non-routine (category 2), Form 20 task due, submission recorded by Monday Sept. 14; `LITIGATION_HOLD` opened on judgment/sale.
- 13.7-T2 Given a standing defense raised in an answer only, Then no Form 20; when the borrower moves for summary judgment on standing, Then Form 20 within 2 BD.
- 13.7-T3 Given an inspection noting "possible meth contamination," Then `suspected` → confirmation task; confirmed ⇒ gate closed, Servicing Representative report within 2 BD, referral refused.
- 13.7-T4 Given a lead-paint citation on a referred 1–4 unit property, Then the notification with value/debt/children-under-8/documentation is sent within 30 days of referral.
- 13.7-T5 Given MA property without a citation search, Then prereferral review fails (13.4-T6).
- 13.7-T6 Given a proposed appeal of an adverse judgment, Then the `attorney` cannot file until Fannie Mae's written approval is stored.
- 13.7-T7 Given a substantive motion due in 12 days, Then the draft must be given to Fannie Mae ≥5 BD before; the gate refuses filing otherwise.
- 13.7-T8 Given quatro is down, Then package emailed to Legal with an outage note and the portal filing completed when restored; both timestamps kept.
- 13.7-T9 Given a payment-deferral offer on a litigated loan, Then counsel is notified before the offer leaves (gate).
- 13.7-T10 Given a model classification "routine" with confidence 0.7 and a damages claim present, Then `attorney` confirmation required before "routine" is accepted.

#### Audit and evidence
Matter files carry intake documents with receipt timestamps, classification decision records, Form 20 packages and quatro references, Fannie Mae directions/approvals, pleading-review logs, status updates, environmental reports and holds — evidence for Fannie Mae Legal, MORA and litigation. Privileged material is access-restricted and tagged; the Compliance Sentinel reports Form 20 timeliness and open holds monthly.

### Open questions / decisions
1. Conservative over-reporting policy (file Form 20 when in doubt) — default: yes.
2. Pleading-review lead time to Fannie Mae — default: 5 servicer business days before the deadline (shorter with `attorney` justification).
3. Environmental "suspected" ⇒ immediate hold vs. hold on confirmation — default: hold immediately; confirm within 10 days.
4. Cost allocation for origination/servicing-defense litigation between partner and Supermortgage — default: by cause per the subservicing agreement; Supermortgage bears its own servicing-conduct claims.
5. Who transmits Fannie Mae approval requests (removal/appeal) — default: partner `officer` on the AI/attorney package.

### Sources
- E-1.3-01 (10/11/2023): https://servicing-guide.fanniemae.com/svc/e-1.3-01/general-servicer-responsibilities-non-routine-matters ; E-1.3-02 (05/10/2023): https://servicing-guide.fanniemae.com/svc/e-1.3-02/reporting-non-routine-litigation-fannie-mae — verified 2026-09-09.
- F-1-08 (05/10/2023): https://servicing-guide.fanniemae.com/svc/f-1-08/managing-foreclosure-proceedings ; E-1.2-02 (05/10/2023) — verified 2026-09-09.
- F-4-02 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-4-02/list-contacts — verified 2026-09-09 (loanservicing@, quatro Form 20, hazard_loss@, sfcpm_excess_fees@, militaryindulgence@).
- A4-2.2-02 (11/12/2014), E-5-04 (02/12/2020), E-3.2-13 (12/16/2015), E-3.3-05 (05/10/2023) — verified 2026-09-09.
- Foreclosure Time Frames exhibit (06.18.25) — method deviation via Form 20 — verified 2026-09-09.
