# 18.2 — Fannie Mae MORA reviews

| Attribute | Value |
|---|---|
| Section | 18 — QC, Audit & Regulatory Reporting |
| Automation class | c |
| SoR / Sub | SoR |
| Trigger & frequency | Fannie Mae-initiated |
| Governing source | FNMA A2-1-01 |
| Key deadlines | On Fannie Mae schedule |
| Timers | `EXAM_REQUEST_DUE_AS_STATED`, `FNMA_A2401_REVIEW_FILE_30`, `FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD`, `FNMA_SCR_FINDING_RESPONSE_AS_STATED`, `SM_EXAM_INTERNAL_NOTIFY_2BD`, `SM_EXAM_LITIGATION_HOLD`, `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD`, `SM_EXAM_REMEDIATION_PLAN_15BD`, `SM_EXAM_SCOPE_5BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | QC/Audit |
| Trigger & frequency | Fannie Mae-initiated |
| Governing source (blueprint) | FNMA A2-1-01 |
| Key deadlines (blueprint) | On Fannie Mae schedule |
| Data/artifacts | Review response |
| Systems | Fannie Mae |
| Automation class (blueprint) | c (exam) |
| SoR / Sub | SoR/Sub |
| Nuances (blueprint) | [cropped in source] — reconstructed: Fannie Mae may review the master servicer and/or Supermortgage directly (A2-1-07); review files are due within **30 days** of notification through Loan Quality Connect (A2-4-01); a Servicing Compliance Review (formerly STAR Operational Assessment) is risk-based, roughly every two years; the partner's officer signs the response for the subserviced book, Supermortgage prepares it; failure to deliver files lets Fannie Mae impose compensatory fees "without first reviewing the individual mortgage loan file" |

### Verified requirement (as of 2026-09-09)

**What "MORA" is — discrepancy.** MORA (Mortgage Origination Risk Assessment) is Fannie Mae's counterparty operational review of *sellers'* origination and QC operations; no Fannie Mae page or Guide topic ties the name to servicing reviews, and the Servicing Guide does not use it **[PARTIALLY VERIFIED — the term appears only in secondary sources; no primary page retrieved]**. The Fannie Mae-initiated reviews a servicer/subservicer actually faces are:

1. **Servicing Guide A2-4-01, Quality Control Reviews (08/17/2016).** "Fannie Mae uses a statistically valid approach in selecting a random sample of new mortgage loan deliveries for review," augmented "with targeted, discretionary sampling." Servicing reviews evaluate whether the servicer took appropriate steps to cure the delinquency, avoid foreclosure through relief provisions, or complete legal actions within required time frames. "The seller/servicer must send the requested documentation for an underwriting or servicing review so that Fannie Mae receives the review file within 30 days after Fannie Mae notifies the seller/servicer"; "Fannie Mae, in its sole discretion, may request the documentation in a shorter or longer period of time." Required servicing-review file contents: collection history (default reason, delinquency notices, payment histories); summary of workout attempts and communications with Fannie Mae; bankruptcy tracking log (filing dates, stay-relief attempts); foreclosure tracking log (referral and sale dates, delay communications); expense-reimbursement support (vendor/third-party invoices); property inspection reports, repayment plans, ARM disclosures, insurance settlements; foreclosure records and evidence of timeline compliance; "any other information requested." Each file must identify the servicing file type, remittance type (A/A, S/A, S/S), servicing option (special/shared risk), Fannie Mae loan number, servicer loan number, borrower name and property address; when both origination and servicing reviews are requested, submit a single PDF. Consequences: for servicing reviews, if the servicer fails to submit documentation "Fannie Mae may exercise available remedies, including compensatory fees, without first reviewing the individual mortgage loan file"; "a pattern of extensive delays or unresponsiveness" may be treated as a breach "up to and including termination"; the servicer "will be given an opportunity to explain any mitigating circumstances or factors that justify the servicing actions it took or did not take within the time frame specified by Fannie Mae"; demands may be "rescinded or withdrawn because the seller/servicer provides documentation within the time period specified." Notifications and submissions run through **Loan Quality Connect** (portal; Technology Manager provisioning; no API). Appeals of servicing remedies follow **A1-3-02** (05/13/2026) — 60-day first appeal, 15-day second appeal, impasse/escalation/IDR stages — already implemented as `FNMA_A1302_*` timers in Section 5.x.
2. **Servicing Compliance Review** — per the STAR FAQ (Apr. 6, 2026): "The Servicing Compliance Review, formerly known as a STAR Operational Assessment, is an evaluation of a servicer's results in accordance with the Fannie Mae Servicing Guide requirements"; "Compliance review inclusion is conducted separately from STAR servicer selection. Its risk-based inclusion criteria may result in less frequent and limited scope reviews" (about every two years, considering prior results and remediation status; non-STAR servicers may be selected); process categories "General Servicing, Solution Delivery and Timeline Management"; a "Servicing Final Report" is issued and "is shareable with certain business entities upon signing a disclosure by both parties." The review's document-request lists, interview schedule and response deadlines are set by the notification letter **[UNVERIFIED — no published procedure]**.
3. **A1-1-03, Evaluating a Servicer's Performance (11/25/2015):** Fannie Mae measures compliance through "various performance metrics, which may include servicer reviews and the STAR™ Program," considering "trends in performance, adequacy of staffing, compliance reviews and audits, STAR Program results, mortgage loan file reviews, timeliness of its payment obligations, and overall compliance with the requirements of the Lender Contract" across customer service, escrow administration, property/flood/MI, collections, loss mitigation, investor reporting, payment processing, bankruptcy/foreclosure/REO, data integrity, delinquency and annual financial/management reporting, document custody and record retention, remitting, accounting and reporting. Unacceptable performance → "performance improvement plan"; breach → termination "in whole or in part."
4. **Records access:** Selling Guide A2-4.1-02 — "Fannie Mae may examine and audit, at any reasonable time, all loan records"; records requested in writing must be delivered "within the time frame specified by Fannie Mae." A4-1-01 — QC results, policies and "examples of the application" on request. A2-1-07 — subservicing agreement and the master's audits/QC reviews on request. Supplement — the Information Security Program "with supporting documentation" on request; cooperation and meetings after a Cybersecurity Incident.
5. **Other examiners:** CFPB Mortgage Servicing Examination Procedures Modules 1–10 (Jan. 18, 2023) and CMR (Aug. 30, 2017); state examinations under each servicer license (multistate exams coordinated through CSBS/NMLS; 00a §5.4) with information-request deadlines set by the exam letter; partner audits under A2-1-01/A2-1-07; rating-agency and investor reviews (18.6). A RESPA §6(f) suit (12 U.S.C. 2605(f)) is defended with the same evidence set.

**Discrepancies with the blueprint row.** Source A2-1-01 → A2-4-01 (file reviews; 30 days), STAR FAQ (Servicing Compliance Review), A1-1-03, Selling Guide A2-4.1-02; "On Fannie Mae schedule" hides a hard 30-day file deadline; "SoR/Sub" is right but the mechanics differ by review type (file reviews go to whichever entity Fannie Mae notifies; the Compliance Review is of the acting servicer's operations with the master present). Class "c" is right for the exam itself; the response assembly is class "a/b".

### Operational prerequisites
- **Loan Quality Connect access** for both entities (Technology Manager; role per LQC job aid) — partner CA and Supermortgage CA; 1–2 weeks. **[UNVERIFIED whether a subservicer can be granted LQC access under the master's servicer number — default: partner's LQC users submit; Supermortgage prepares; Supermortgage's own LQC for its own number.]**
- **Fannie Mae contacts** (F-4-02: SF CPM division for servicing review files; Servicing Representative; Legal for law-firm escalations) in the contact registry.
- **Evidence taxonomy v1** (`evidence_taxonomy`) loaded: CFPB Modules 1–10 sub-items, A1-1-03 categories, Servicing Compliance Review categories, Reg AB 1122(d) criteria, CSBS standards, state exam checklists (per license).
- **Exam response protocol** in the subservicing agreement: who receives notices, who signs, privilege handling, 2-business-day internal notification of any Fannie Mae/regulator contact, cost allocation.
- **Counsel retained** for privilege review of productions; **officer signers** designated at both entities.
- **Reading room** capability: examiner read-only accounts in `ops-console` (role `examiner`, time-boxed, logged) — Fannie Mae/CFPB/state examiners increasingly request system access **[design choice]**.

### Build spec
#### Inputs and triggers
- `exam.notice.received` (source ∈ {fnma_lqc, fnma_letter, fnma_scr, cfpb, state, multistate, partner, investor, rating_agency, litigation_discovery}; document; stated deadlines) — created from LQC email notifications, mail intake (`security-records` mailroom), partner forwards.
- `exam.request.received` (each document/information request item with due date), `exam.finding.received`, `exam.report.received`, `exam.remedy_demand.received` (→ Section 5.x repurchase/appeal ladder), `exam.closed`.
- Internal: `qc.finding.opened` with `reported_to_fnma_at` (self-reports), `fraud.report.filed` (18.5), `incident.reported` (Section 19).

#### Data model
- `exams`: `id`, `exam_type`, `examiner`, `subject_entity` ∈ {partner, supermortgage, both}, `notice_document_id`, `received_at`, `scope` (jsonb: loan lists, periods, taxonomy nodes), `lead_officer_id`, `counsel_id`, `status`, `closed_at`, `final_report_document_id`.
- `exam_requests`: `exam_id`, `request_no`, `text`, `taxonomy_nodes`, `loan_ids` (bigint[]), `due_at`, `extension_requested_at`, `extension_granted_until`, `package_document_id`, `submitted_at`, `submission_evidence` (LQC confirmation/tracking), `status`.
- `evidence_taxonomy`: `node` (e.g., `cfpb.m8.loss_mitigation.41c_evaluation`), `parent`, `description`, `sources` (jsonb: tables/event types/document classes/timer codes that evidence it).
- `evidence_index` (materialized): `loan_id`, `node`, `ref_type`, `ref_id`, `occurred_at`, `document_hash` — rebuilt nightly from `loan_events`, `notices`, `documents`, `timers`, `agent_decisions`, `contacts`, `cases`.
- `exam_findings`: `exam_id`, `finding_ref`, `text`, `severity`, `taxonomy_nodes`, `response_document_id`, `qc_finding_case_id` (mirror into `cases`), `remediation_due_at`, `status`.
- `exam_productions`: `exam_request_id`, `manifest` (jsonb: files, hashes, page counts, loan headers), `privilege_log_document_id`, `pii_redaction_applied` bool, `approved_by_officer_id`, `approved_at`.
- Reuse `cases` (`qc_finding`), `documents`, `escalations`, `timers`.

#### State machine
`exams.status`: `received → scoped → producing → submitted → fieldwork (interviews/testing) → findings_received → responding → remediating → closed`; side states `extension_pending`, `disputed` (A1-3-02 ladder for remedies), `litigation_hold`. `exam_requests.status`: `open → assembling → officer_review → submitted → accepted | supplemented`. Transitions: `qc-audit` (scope, assemble, draft), `officer` (approve/submit), `fnma_portal_operator` (LQC upload), external acks (LQC "received", examiner acknowledgment).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_A2401_REVIEW_FILE_30` | deadline | `exam.notice.received{fnma_lqc, servicing_review}` | notification date | 30 calendar days (or the shorter/longer period stated; `due_at` override) ; warning at 50% and 80% | `exam.request.submitted` with LQC confirmation | sev-1 → `officer` + partner; compensatory-fee exposure logged |
| `SM_EXAM_INTERNAL_NOTIFY_2BD` | deadline | any examiner contact | receipt | 2 business days | partner + officer notified (`exam.notice.acknowledged`) | sev-2 (contract) |
| `SM_EXAM_SCOPE_5BD` | deadline | `exam.notice.received` | receipt | 5 business days | `exams.status=scoped` | sev-3 |
| `EXAM_REQUEST_DUE_AS_STATED` | deadline | `exam.request.received` | stated due date | 0 (per letter); warning 50%/80% | submission evidence | sev-1 |
| `SM_EXAM_PACKAGE_OFFICER_REVIEW_3BD` | not_before_gate + deadline | package assembled | assembled_at | package must sit ≥1 BD for review and be approved ≥1 BD before due; officer has 3 BD | `officer` approval | sev-2; auto-extension request drafted |
| `FNMA_SCR_FINDING_RESPONSE_AS_STATED` | deadline | `exam.finding.received` | stated | per Fannie Mae letter (default 30 calendar days **[UNVERIFIED]**) | response submitted | sev-1 |
| `SM_EXAM_REMEDIATION_PLAN_15BD` | deadline | `exam.finding.received` | receipt | 15 business days | remediation plan approved (CAPA set in 18.1) | sev-2 |
| `FNMA_A1302_*` (Section 5.x) | — | remedy demands | — | 60/60/15/30/30/15 days | — | — |
| `FNMA_A4101_FNMA_QC_RESULTS_REQUEST_10BD` (18.1) | deadline | QC results request | receipt | 10 BD default | delivered | sev-1 |
| `SM_EXAM_LITIGATION_HOLD` | not_before_gate | `exam.notice.received{litigation_discovery}` or subpoena | — | until released by counsel | — | retention purge jobs blocked for scoped records |

#### Business rules and calculations
1. **Scoping:** parse the notice (LLM extraction with human confirmation) into `exam_requests` with taxonomy nodes and loan lists; loans are resolved by Fannie Mae loan number → `loans.fnma_loan_number`; unknown numbers → immediate query to the examiner drafted for officer signature.
2. **Assembly of an A2-4-01 servicing review file:** for each loan, generate the single-PDF package in this order — cover header (servicing file type; remittance type from `loans.remittance_type`; servicing option; Fannie Mae loan number; servicer loan number; borrower name; property address), collection history (all `contacts` with mode/result/QRPC flags; delinquency notices from `notices`; payment history from `ledger_entries`), workout summary (`cases{lossmit,…}` timeline, decisions, Fannie Mae communications/SMDU ids), bankruptcy log (`cases{bankruptcy}` events, PACER docket refs), foreclosure log (referral, milestones vs. E-3.2-15 allowable time frames, delay communications), expense support (`advances` with vendor invoices), inspections, repayment plans, ARM disclosures, insurance settlements, and a timer-compliance appendix (every `timers` row for the loan with satisfying event and evidence hash). Page-count and hash manifest stored in `exam_productions.manifest`.
3. **Privilege/PII:** counsel work product and attorney communications are excluded by document class and listed on a privilege log; PII of non-borrowers is redacted; nothing is redacted from what Fannie Mae owns (Selling Guide A2-4.1-02 — records are Fannie Mae's property).
4. **Deadline arithmetic:** `due_at = notification_date + 30 calendar days` (A2-4-01) unless the notice states otherwise; if the day falls on a weekend/Fannie Mae holiday the platform targets the prior business day (Fannie Mae's rule is "receives … within 30 days" — no roll-forward assumed). Worked example: notification 2026-10-16 (Fri) → day 30 = 2026-11-15 (Sun) → internal target 2026-11-13 (Fri); officer-review gate requires the package assembled by 2026-11-10.
5. **Extension requests** are drafted automatically when the 80% warning fires without an assembled package, citing the extenuating circumstances (A2-4-01 "Fannie Mae will make every effort to work with the seller/servicer").
6. **Findings → 18.1:** every examiner finding becomes a `qc_finding` case with CAPA; the response letter cites the finding, the root cause, the remediation, the affected population (with counts) and the evidence of correction; disputes of fact attach the evidence index excerpt.
7. **Performance improvement plan** (A1-1-03): if Fannie Mae imposes one, its milestones become timers with partner co-ownership.

#### Integrations
- **Loan Quality Connect** (portal-only; no API): `human_portal_task` to `fnma_portal_operator` with the package: file list with hashes, LQC case/loan identifiers, upload instructions, expected confirmation; operator records the LQC confirmation (screenshot/id) → `exam.request.submitted`. Failure (upload rejected/size limits **[UNVERIFIED limits]**): split package; re-task.
- **Email/letter channels** (SF CPM division, Servicing Representative, Fannie Mae Legal, privacy_office@fanniemae.com): officer-signed PDF via the partner's or Supermortgage's corporate mailbox, with sent-mail evidence captured to `documents`.
- **CFPB/state examiners:** secure file transfer as specified by the exam letter (CFPB uses its own portal; states via NMLS/secure email) — `human_portal_task` with the same manifest; examiner read-only console accounts provisioned by `security-records` with expiry.
- **Partner:** every exam artifact mirrored to the partner's audit folder; partner officer e-signature via the e-signature vendor.
- **Internal:** `evidence_index` rebuild job (nightly); `documents` export in MISMO v3.6 projections for large productions (baseline §10).

#### Outputs and artifacts
- Production packages (per-loan PDFs; manifests; privilege logs), response letters (template `EXAM-RESP-v1`: header, request reference, response, evidence citations, officer signature block), remediation plans, PIP trackers, examiner read-room access logs; `exams`, `exam_requests`, `exam_productions`, `exam_findings`, linked `qc_finding` cases; no borrower notices; no ledger postings (remedies flow through Section 5.x).

#### AI agent design (AI-first)
- **Agent:** `qc-audit` (exam module). End-to-end: intake and classification of the notice → scope extraction → loan resolution → evidence retrieval via the taxonomy → package assembly and QA (checklist: A2-4-01 required contents present; header fields; hash manifest; privilege screen) → response drafting (facts only from the evidence index; every sentence cites a record id) → escalation for signature → submission task → tracking → findings ingestion → CAPA drafting.
- **Tools:** `evidence.query(taxonomy_node, loan_ids, period)`, `documents.compile_pdf`, `privilege.screen`, `pii.redact`, `letters.render`, `escalations.create`, `human_portal_task.create`, `cases.create{qc_finding}`.
- **Decision record:** `{exam_id, request_no, scope_interpretation, evidence_refs[], omissions_with_reason[], draft_hash, confidence, model_version, prompt_version}`.
- **Guardrails:** the agent never characterizes legal compliance in a response without counsel review when a finding alleges a violation; no communication leaves without `officer` signature (baseline §8 item 3 — "MORA/exam responses" are officer certifications); the partner's officer signs anything submitted under the partner's servicer number.
- **Escalations:** `officer` (sign/submit; extension requests), `attorney` (privilege, legal characterizations, litigation discovery), `fnma_portal_operator` (LQC/portal uploads), partner officer (SoR signature). Package: manifest, draft response, evidence excerpts, open-issues list, deadline status.
- **AI-off path:** the taxonomy queries and PDF compilation are deterministic; a human analyst drafts responses in the console from the same evidence bundle.

#### Edge cases and failure modes
- **Loan transferred out before the review:** produce what the platform holds (Reg X 1024.38(c) one-year post-transfer retention; Fannie Mae life-of-loan + 4 years) and identify the transferee; coordinate with Section 17 records.
- **Loan boarded mid-period:** prior servicer's records are in the boarding archive (1.6); gaps are disclosed explicitly, never filled with assumptions.
- **Bankruptcy/SCRA:** include stay/relief evidence; do not produce sealed court materials without counsel.
- **Successor in interest:** confirm which party's PII is producible.
- **Examiner requests system access or live demos:** time-boxed `examiner` accounts, screen-recorded sessions, no production write access.
- **LQC outage/rejection:** file by the alternate channel Fannie Mae designates and document the attempt before the deadline.
- **Conflicting deadlines** (multiple examiners): priority by legal exposure (Fannie Mae compensatory-fee/timeline items first), officer decides; extensions requested early.
- **Post-close reporting finality:** if a review reveals a reporting error that is final after BD2 close (SVC-2026-03), follow 5.x remit/advance logic and disclose in the response.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 18.2-T1 | Given an LQC servicing-review notice dated 2026-10-16 for 25 loans, then 25 `exam_requests` exist with `due_at = 2026-11-15`, internal target 2026-11-13, warnings at 2026-10-31 and 2026-11-09. |
| 18.2-T2 | Given a loan with a bankruptcy and a foreclosure referral, when the package compiles, then the PDF contains the header fields, collection history, workout summary, BK log, FC log with E-3.2-15 comparison, expense support and the timer appendix, and the manifest hash matches the stored document. |
| 18.2-T3 | Given the package is not assembled by the 80% warning, then an extension request letter is drafted and escalated to `officer`. |
| 18.2-T4 | Given an attorney-client memo in the loan's documents, then it is excluded and appears on the privilege log; no other Fannie Mae-owned record is withheld. |
| 18.2-T5 | Given a Fannie Mae finding alleging a missed D2-2-02 outreach cadence, then a `qc_finding` case opens, CAPA is due in 15 BD, and the draft response cites `contacts` rows and timer history. |
| 18.2-T6 | Given a remedy demand received with the report, then Section 5.x `FNMA_A1302_APPEAL1_60` starts and the exam record links the repurchase case. |
| 18.2-T7 | Given a CFPB information request with a stated 10-business-day deadline over a federal holiday, then `EXAM_REQUEST_DUE_AS_STATED` uses the stated date and the officer gate lands ≥1 BD before it. |
| 18.2-T8 | Given a subpoena, then `SM_EXAM_LITIGATION_HOLD` blocks retention purges for the scoped loans (verified by attempting a purge job). |
| 18.2-T9 | Given a response draft containing a legal conclusion ("we complied with §1024.41"), then the guardrail routes it to `attorney` before `officer`. |

#### Audit and evidence
`exams`/`exam_requests`/`exam_productions` with manifests and hashes, LQC confirmations, officer approvals, extension correspondence, findings and responses, CAPA links, examiner access logs, and timer histories — retained `corporate_7y` and cross-linked to each loan (`life_of_loan_plus_4y`). This record is also the RESPA-litigation production set (the same evidence index answers discovery on §1024.35–.41 compliance).

### Open questions / decisions
1. **Who submits in LQC for the subserviced book** — default: partner's LQC users submit; Supermortgage prepares; Supermortgage submits under its own number for its own reviews.
2. **Examiner read-room access** — default: offered with time-boxed accounts; partner approval required.
3. **Default response window for Servicing Compliance Review findings** (unpublished) — default 30 days, overridden by the letter.
4. **Extension policy** — default: request at the 80% warning if the package is not assembled; never rely on an extension not confirmed in writing.

### Sources
- Servicing Guide A2-4-01 (08/17/2016): https://servicing-guide.fanniemae.com/svc/a2-4-01/quality-control-reviews — verified 2026-09-09
- Servicing Guide A1-1-03 (11/25/2015): https://servicing-guide.fanniemae.com/svc/a1-1-03/evaluating-servicers-performance — verified 2026-09-09
- Servicing Guide A1-3-02 (05/13/2026) via Section 5.x; A2-1-07 (05/13/2026) — verified 2026-09-09
- STAR FAQs (Apr. 6, 2026; "Servicing Compliance Review"): https://singlefamily.fanniemae.com/servicing/faqs-servicer-total-achievement-and-rewards — verified 2026-09-09
- Loan Quality Connect: https://singlefamily.fanniemae.com/applications-technology/loan-quality-connect ; FAQs: https://singlefamily.fanniemae.com/media/document/pdf/loan-quality-connect-faqs — verified 2026-09-09
- Selling Guide A2-4.1-02 (12/19/2017); Selling Guide A4-1-01 (08/05/2026) — as in 18.1
- CFPB exam procedures and CMR — as in 18.1; research/00a §5.4, §6.6
