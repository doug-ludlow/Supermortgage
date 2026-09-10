# 18.5 — Mortgage fraud reporting

| Attribute | Value |
|---|---|
| Section | 18 — QC, Audit & Regulatory Reporting |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On discovery |
| Governing source | FNMA A2-1-01 |
| Key deadlines | Prompt |
| Timers | `FNMA_A3201_BREACH_SELF_REPORT_60`, `FNMA_A3201_OFAC_MATCH_24H`, `FNMA_A3403_FRAUD_REPORT_30`, `FNMA_A4222_LAWFIRM_FRAUD_2BD`, `FNMA_ISBR_CYBER_INCIDENT_36H`, `SM_FRAUD_CARRIER_NOTICE_IMMEDIATE`, `SM_FRAUD_DUE_DILIGENCE_15`, `SM_FRAUD_LE_REFERRAL_DECISION_10BD`, `SM_FRAUD_PARTNER_NOTIFY_1BD`, `SM_FRAUD_TRIAGE_2BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | QC/Audit |
| Trigger & frequency | On discovery |
| Governing source (blueprint) | FNMA A2-1-01 |
| Key deadlines (blueprint) | Prompt |
| Data/artifacts | Report |
| Systems | Fannie Mae |
| Automation class (blueprint) | b |
| SoR / Sub | "Sub re[ports…]" [cropped in source] — reconstructed: **Sub** detects, investigates and reports — to the partner immediately and to Fannie Mae through the Loan Quality Connect self-report (under the servicer number of the entity servicing the loan for Fannie Mae, i.e., the partner's, with the partner's officer signing, or Supermortgage's own where Fannie Mae has notified/authorized it) — and to law enforcement where warranted; the partner remains liable to Fannie Mae |
| Nuances (blueprint) | [cropped in source] — reconstructed: the reporting trigger is a **"reasonable basis"** after "appropriate due diligence," and the deadline is **30 days** (Selling Guide A3-4-03); OFAC matches are reported to Fannie Mae's Ethics division **within 24 hours** (A3-2-01); law-firm fraud within **2 business days** to Fannie Mae Legal (A4-2.2-02); no FinCEN SAR mandate for a servicing-only nonbank; records of internal audit/management-control activity must be kept and produced on request |

### Verified requirement (as of 2026-09-09)

**Servicing Guide A2-1-09, Compliance with Requirements and Laws (12/17/2025; SVC-2025-07 "fraud clarifications")** points servicers to Selling Guide A3-2-01 (compliance with laws, reporting requirements, cybersecurity incidents) and A3-4-01 (confidentiality). **Selling Guide A3-4-03, Preventing, Detecting, and Reporting Mortgage Fraud (12/10/2025; SEL-2025-10):** "A seller/servicer must notify Fannie Mae if a reasonable basis exists to conclude any misrepresentation or fraud occurred in connection with the origination, sale, or servicing of the loan"; before notifying, the seller/servicer "should conduct appropriate due diligence to determine whether a reasonable basis exists to conclude misrepresentation or fraud may have occurred"; "If such reasonable basis exists, a seller/servicer must notify Fannie Mae within 30 days using the self-report functionality in Loan Quality Connect"; "A record of activity under the internal audit and management control systems must be maintained and made available to Fannie Mae upon request." Required written policies: hiring practices with screening of "all employees, including management, involved in the origination or servicing of mortgage loans" against the GSA Excluded Parties List, HUD Limited Denial of Participation list and FHFA Suspended Counterparty Program list; the same screening of contractors/vendors before engagement; procedures to "report suspected fraud to the proper authorities and to Fannie Mae"; (sellers) aggressive QC sampling of high-fraud-risk loans, appraiser selection and anti-flip closing instructions. Fraud types listed include identity theft, undisclosed liabilities, "Mishandling of escrow or custodial accounts," "Diversion of sales proceeds" and "Fraudulent payoff schemes." **Selling Guide A3-2-01 (12/10/2025):** OFAC — "within 24 hours" of identifying a valid sanctions-list match, notify Fannie Mae's Ethics division by email with borrower name, Fannie Mae loan number and servicer contact; suspicious activity/AML matters reported via the LQC self-report or to the Mortgage Fraud Reporting division; self-reports of breaches affecting "more than 500 loans or 1% of prior year deliveries" in a quarter "within 60 days" of quarter-end or discovery (whichever is later) and of repurchase-risk breaches not remediable within 60 days "within 60 days" of determination — both via LQC self-report; cybersecurity incidents per the Supplement (36 hours; Section 19). **Fannie Mae Mortgage Fraud Prevention page:** third-party/anonymous reporting by phone "1-800-2FANNIE (1-800-232-6643)" or the online Suspected Mortgage Fraud Report (Salesforce form); servicing-relevant schemes: short-sale fraud, non-arm's-length short sales, short-sale flips, foreclosure rescue, unauthorized fees/payouts. **A4-2.2-02:** "Actual or alleged fraud" by a law firm → Fannie Mae Legal within two business days (Section 13 owns; 18.5 co-files). **Fidelity bond events:** Selling Guide A3-5-04 governs reporting of fidelity/E&O events **[UNVERIFIED — content not retrieved; default: notify Fannie Mae and the carrier immediately on discovery of employee dishonesty affecting Fannie Mae funds]**.

**Federal AML/SAR.** 31 CFR 1010.100(lll) (eCFR current Sept. 4, 2026) defines a "loan or finance company" through "residential mortgage lender" ("the person to whom the debt … is initially payable") and "residential mortgage originator" ("a person who accepts a residential mortgage loan application or offers or negotiates terms"); a servicing-only nonbank that neither originates nor is the initial payee is outside 31 CFR part 1029, so no BSA AML program or SAR filing duty attaches to Supermortgage's servicing **[PARTIALLY VERIFIED — FinCEN's 2012 RMLO rule deferred servicers; confirm no 2025–2026 FinCEN expansion]**. Voluntary SARs by non-covered institutions remain permitted with safe harbor under 31 U.S.C. 5318(g)(3) **[PARTIALLY VERIFIED]**. If the partner is a bank or an RMLO, the partner's SAR obligations may be triggered by Supermortgage's findings — the subservicing agreement must route findings to the partner's BSA officer. OFAC screening (31 CFR ch. V) applies to every U.S. person; Fannie Mae's 24-hour notice is contractual on top. **Other overlays:** FCRA identity-theft blocks (8.3); GLBA/Reg P — disclosures to Fannie Mae, law enforcement and insurers for fraud prevention fall within 12 CFR 1016.15(a)(2)(ii)/(a)(4) exceptions **[PARTIALLY VERIFIED cite]**; state mortgage-fraud statutes may require or permit reporting to state regulators/AGs (jurisdiction-keyed, `jurisdiction_rules.fraud_reporting`) **[UNVERIFIED per state]**; the Supplement's 36-hour cyber-incident notice where fraud involves a compromise (business-email compromise is reportable "regardless of impact").

**Discrepancies with the blueprint row.** (1) Source → Selling Guide A3-4-03/A3-2-01 via Servicing Guide A2-1-09. (2) "Prompt" → 30 days after a reasonable basis exists (plus 24-hour OFAC, 2-BD law firm, 60-day breach self-reports). (3) Channel is the LQC self-report, not a form number. (4) "Sub reports" must be qualified by servicer-number/officer mechanics.

### Operational prerequisites
- **Anti-fraud policy** (`FRAUD-POL-v1`) meeting A3-4-03 elements (hiring/vendor screening, reporting procedures, red-flag catalog, investigation standards, training) approved by the board and the partner; annual training records.
- **Screening feeds** (GSA SAM exclusions, HUD LDP, FHFA SCP, OFAC SDN/consolidated lists) with monthly full re-screen and event-driven checks — `security-records` (Section 19); OFAC screening of borrowers at boarding and monthly, and of payees before any disbursement (Sections 1, 3, 16).
- **Loan Quality Connect self-report access** (partner submitter; Supermortgage's own) and the Ethics division / Mortgage Fraud Reporting mailbox addresses in the contact registry **[UNVERIFIED — addresses not on public pages; obtain from LQC/Guide contacts F-4-02]**.
- **Subservicing agreement:** 1-business-day notification to the partner; partner BSA officer routing; who files the LQC self-report; cost/loss allocation; cooperation with Fannie Mae's Financial Crimes team.
- **Law-enforcement liaison** (counsel-designated), FBI/USPIS/state AG contact protocol; fidelity carrier claim protocol.
- **Fraud investigator capability:** `qc-audit` fraud module with document-forensics tools (metadata, image analysis), and an `officer:fraud_officer` designation (may be the QC officer) for determinations.

### Build spec
#### Inputs and triggers
- Red-flag events from any section: `payoff.wire_instructions.changed` (16.x), `payoff.request.suspicious`, `shortsale.offer.nonarms_length_suspected`, `lossmit.document.forgery_suspected` (12.x), `insurance.claim.suspicious` (9.7), `sii.claim.identity_conflict` (4.4), `contact.impersonation_suspected` (4.x), `custodial.recon.unexplained_variance` (6.x), `employee.screening.hit`, `vendor.screening.hit`, `ofac.match.confirmed`, `credit.identity_theft.reported` (8.3), `lawfirm.fraud.alleged` (13.x), external tips (`tip.received{source}`), Fannie Mae fraud alerts (`fnma.fraud_alert.published` → screening of the book).
- Investigation events: `fraud.case.opened`, `fraud.determination.recorded{reasonable_basis|unfounded|inconclusive}`, `fraud.report.filed{channel}`, `fraud.referral.sent{law_enforcement|regulator|carrier}`, `fraud.case.closed`.

#### Data model
- `fraud_red_flags` (append-only): `id`, `loan_id?`, `party_id?`, `vendor_id?`, `employee_ref?`, `flag_code` (catalog: `PAYOFF_WIRE_CHANGE`, `NONARMS_SHORT_SALE`, `DOC_METADATA_ANOMALY`, `INCOME_DOC_INCONSISTENT`, `OCCUPANCY_MISREP`, `IDENTITY_MISMATCH`, `INSURANCE_CLAIM_ANOMALY`, `CUSTODIAL_VARIANCE`, `SCREENING_HIT`, `OFAC_MATCH`, `LAWFIRM_FRAUD`, `TIP`, …), `source_event_id`, `score` (0–100), `detected_at`, `detector` (rule id / model version).
- `cases` (`case_type = fraud`) + `fraud_cases`: `case_id`, `subject_kind` ∈ {borrower, third_party, employee, vendor, law_firm, unknown}, `scheme_code`, `loans` (bigint[]), `exposure_cents`, `partner_notified_at`, `determination` ∈ {reasonable_basis, unfounded, inconclusive}, `determination_at`, `determined_by_officer_id`, `fnma_report_due_at`, `fnma_report_filed_at`, `fnma_report_ref` (LQC id), `ofac_reported_at`, `law_enforcement_referral_at`, `carrier_claim_at`, `regulator_report_at`, `status`.
- `fraud_reports`: `case_id`, `channel` ∈ {lqc_self_report, ethics_email_ofac, fraud_tip_form, fraud_hotline, fnma_legal_email, law_enforcement, state_regulator, carrier}, `package_document_id`, `signed_by_officer_id`, `sent_at`, `evidence`.
- `screening_results` (Section 19): subject, list, match score, disposition.
- Retention `life_of_loan_plus_4y` (loan-linked) / `corporate_7y`; PII encryption; access restricted to the fraud module and officers.

#### State machine
`fraud_cases.status`: `flagged → triaged (score/priority) → investigating → determined → reported (Fannie Mae and others as applicable) → remediating → closed`; alternates `unfounded_closed` (with rationale), `merged` (duplicate), `on_hold_law_enforcement` (at agency request; Fannie Mae report still filed unless counsel directs otherwise **[open decision 18.5-Q3]**). OFAC sub-path: `ofac_match_confirmed → ethics_notified (24h) → funds_blocked/handled per OFAC → closed`. Transitions: `qc-audit` (flag, triage, investigate, draft), `officer:fraud_officer` (determination), `officer` (sign reports), `attorney` (law-enforcement/regulator referrals), `fnma_portal_operator`/partner submitter (LQC), `security-records` (screening/incident overlap).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_FRAUD_TRIAGE_2BD` | deadline | `fraud.case.opened` | opened_at | 2 business days | `triaged` | sev-3 |
| `SM_FRAUD_DUE_DILIGENCE_15` | deadline | `fraud.case.opened` | opened_at | 15 calendar days | `fraud.determination.recorded` | sev-2 → `officer:fraud_officer` (protects the 30-day window) |
| `FNMA_A3403_FRAUD_REPORT_30` | deadline | `fraud.determination.recorded{reasonable_basis}` | determination_at | 30 calendar days; internal target day 20 | `fraud.report.filed{lqc_self_report}` with LQC reference | sev-1 → `officer` + partner |
| `SM_FRAUD_PARTNER_NOTIFY_1BD` | deadline | `fraud.case.opened` with score ≥ 60, and again at determination | event | 1 business day | partner notified (evidence) | sev-1 (contract) |
| `FNMA_A3201_OFAC_MATCH_24H` | deadline | `ofac.match.confirmed` | confirmation timestamp | 24 hours (clock hours) | `fraud.report.filed{ethics_email_ofac}` | sev-1 → `officer`; also OFAC blocking/reporting per 31 CFR 501 (Section 19) |
| `FNMA_A4222_LAWFIRM_FRAUD_2BD` | deadline | `lawfirm.fraud.alleged` | discovery | 2 business days | Fannie Mae Legal email evidenced | sev-1 (Section 13 co-owner) |
| `FNMA_A3201_BREACH_SELF_REPORT_60` | deadline | `qc.finding.validated{population ≥ 500 loans or ≥ 1% of prior-year deliveries}` or `repurchase_risk_breach.determined` | later of quarter-end/discovery; determination | 60 calendar days | LQC self-report filed | sev-1 |
| `SM_FRAUD_LE_REFERRAL_DECISION_10BD` | deadline | `reasonable_basis` determination with loss/exposure > $25,000 or identity theft/employee dishonesty | determination_at | 10 business days | `attorney` decision recorded (refer / not refer with reason) | sev-2 |
| `SM_FRAUD_CARRIER_NOTICE_IMMEDIATE` | deadline | employee dishonesty / covered loss discovered | discovery | 1 business day (policy "immediate"/"as soon as practicable" terms **[UNVERIFIED per policy]**) | carrier notice evidenced | sev-1 |
| `FNMA_ISBR_CYBER_INCIDENT_36H` (Section 19) | deadline | incident identified (incl. BEC behind a payoff-diversion) | identification | 36 hours | notice to privacy_office@fanniemae.com | sev-1 |

#### Business rules and calculations
1. **Detection layer** (rules + model, both inventoried in `ai_systems` as T1 "fraud determinations" support): deterministic red-flag rules (e.g., payoff wire instructions changed within 10 days of a payoff request and not confirmed by call-back to a number on file → `PAYOFF_WIRE_CHANGE` score 90; short-sale buyer shares surname/address/phone with borrower or agent → `NONARMS_SHORT_SALE` 70; document metadata (creation date after signature date, editing software fingerprints) → `DOC_METADATA_ANOMALY` 60; hardship income in Form 710 inconsistent with prior statements/tax transcripts → `INCOME_DOC_INCONSISTENT` 50). Score aggregation per case = max(flag scores) + 10 × (count of distinct flags − 1), capped at 100. Priority: ≥ 80 = P1 (same-day investigation, immediate protective actions), 60–79 = P2, < 60 = P3 (review in the monthly QC cycle).
2. **Protective actions (automatic, reversible):** hold suspicious payoff disbursements pending verified call-back (16.x), require in-person/ID-verified authentication for high-risk account changes, suspend credit reporting of disputed identity-theft accounts (8.3), route short-sale approvals to human review, freeze vendor payments on screening hits.
3. **Investigation standard:** independent verification (call-backs to numbers of record, public-record checks, employer/insurer verification with consent limits), preserved originals (hashes), interview notes, and a written analysis applying the "reasonable basis" test — more than suspicion, less than proof; a determination is by the `officer:fraud_officer`, never the agent.
4. **Clock rule (conservative):** the 30-day Fannie Mae clock formally starts at the determination, but the platform starts an internal 15-day due-diligence timer at the red flag so that the LQC report is filed no later than ~45 days after detection and, where diligence completes early, within 30 days of the flag. Worked example: flag 2026-10-05 → diligence due 2026-10-20 → determination 2026-10-14 → Fannie Mae report due 2026-11-13, internal target 2026-11-03; partner notified 2026-10-06 and 2026-10-15.
5. **Report content (LQC self-report; A3-4-03 does not enumerate; platform standard):** loan identifiers (Fannie Mae/servicer numbers), parties, scheme description, timeline, evidence list with hashes, loss/exposure (cents), actions taken, law-enforcement status, contact person; OFAC email: borrower name, Fannie Mae loan number, servicer contact (verified content).
6. **Exposure computation:** `exposure_cents` = amounts diverted/at risk (e.g., payoff funds misdirected) + unrecoverable advances; carrier claim value per policy terms; Fannie Mae loss allocation per the Lender Contract (partner liable; partner recovers from Supermortgage per the subservicing agreement).
7. **Employee/vendor cases:** dual control — the QC officer cannot investigate a case in which they are a subject; the board/partner is notified of any employee-dishonesty determination; screening lists re-run.

#### Integrations
- **Loan Quality Connect self-report** (portal-only): `human_portal_task` to the partner's submitter (or Supermortgage's for its own number) with the officer-signed report package; capture the LQC reference.
- **Fannie Mae Ethics division email (OFAC), Mortgage Fraud Reporting division, Fannie Mae Legal email (law firms), Financial Crimes team follow-ups:** officer-signed email with sent evidence; **1-800-2FANNIE / Suspected Mortgage Fraud Report form** for non-loan-specific tips at counsel's direction.
- **Partner:** 1-BD notification channel; partner BSA officer routing (SAR decisions are the partner's).
- **Screening providers, OFAC lists** (Section 19 adapters), **carrier** (claim portal/email), **law enforcement** (counsel), **credit bureaus** (8.3 identity-theft blocks), **telephony** (call-back verification records).

#### Outputs and artifacts
- Investigation file (`FRAUD-FILE-v1`: red flags, evidence with hashes, analysis, determination memo), Fannie Mae self-report package (`FRAUD-FNMA-SR-v1`), OFAC notice (`FRAUD-OFAC-24H-v1`), law-firm escalation (`FRAUD-LAWFIRM-2BD-v1`), law-enforcement referral memo, carrier claim package, partner notices; `fraud_red_flags`, `fraud_cases`, `fraud_reports`; loan-level protective flags (`loans.fraud_hold` with reason and expiry). Borrower notices only where another section requires them (e.g., identity-theft block confirmations, 8.3). Ledger: recoveries/losses posted by the owning section with case links.

#### AI agent design (AI-first)
- **Agent:** `qc-audit` (fraud module) with `security-records` for screening/incident overlap. End-to-end: monitor red-flag events → open/merge cases → triage and apply protective actions → run investigation steps (document forensics, cross-checks, drafting call-back scripts executed by `borrower-comms` humans where identity verification is required) → draft the determination memo for the fraud officer → draft reports → escalate for signatures → create portal/email tasks → track filings → drive remediation.
- **Tools:** read access to loan/case/document data; forensic utilities; screening APIs; `cases.create/merge`, `loans.set_hold`, `escalations.create`, `human_portal_task.create`, report renderer. No borrower-facing communications from this module; no ledger writes.
- **Decision record:** `{case_id, flags[], score, hypotheses[], evidence_refs[], recommended_determination, confidence, model_version, prompt_version}`.
- **Guardrails:** determinations, external reports and referrals are human acts (`officer:fraud_officer`, `officer`, `attorney`); the agent never contacts suspected perpetrators; protective actions are time-boxed (auto-expire in 30 days unless renewed by the officer) to avoid harming innocent borrowers; fairness monitoring of red-flag rates by protected class (18.1 fairness suite) because fraud flags can delay relief.
- **Escalations and packages:** `officer:fraud_officer` (determination — investigation file); `officer` (sign Fannie Mae/OFAC/carrier reports — report package); `attorney` (law enforcement/regulator/privilege — memo with exposure and evidence); `fnma_portal_operator`/partner submitter (LQC); `human_agent` (identity-verification calls).
- **AI-off path:** rules-only detection continues; investigators use the console workbench; the same timers apply.

#### Edge cases and failure modes
- **Transfer-out during investigation:** notify the transferee and the partner; file the Fannie Mae report regardless of transfer; preserve records (litigation hold).
- **Bankruptcy/SCRA overlays:** protective holds must not violate the automatic stay or SCRA protections; coordinate with 14.x/11.x.
- **Successor in interest identity conflicts:** two claimants — treat as identity dispute first (4.4), fraud case only on evidence.
- **Borrower as victim** (foreclosure-rescue scam, payoff diversion by a third party): borrower gets assistance (human agent), not adverse treatment; credit reporting suppressed pending resolution; report to Fannie Mae still required.
- **Law enforcement asks for silence:** counsel decides how to satisfy the Fannie Mae 30-day duty (Fannie Mae's Financial Crimes team routinely coordinates) — record the direction.
- **False positives:** case closed `unfounded` with rationale; protective actions reversed within 1 business day; no adverse note on the borrower's account beyond the case record.
- **Screening hit on an existing vendor/employee:** access suspended pending review; Fannie Mae work reassigned (A3-4-03/A4-1-01 SCP requirement).
- **LQC unavailable near the deadline:** email the Mortgage Fraud Reporting division with the package and document; file in LQC when restored.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 18.5-T1 | Given a payoff request and a wire-instruction change 3 days earlier without verified call-back, then a P1 case opens with score 90, the payoff disbursement is held, the partner is notified within 1 BD, and a call-back task is created for a human agent. |
| 18.5-T2 | Given a red flag on 2026-10-05 and a `reasonable_basis` determination on 2026-10-14, then `FNMA_A3403_FRAUD_REPORT_30` is due 2026-11-13 with internal target 2026-11-03; a filing on 2026-11-14 is recorded as breached. |
| 18.5-T3 | Given no determination by 2026-10-20, then `SM_FRAUD_DUE_DILIGENCE_15` breaches to the fraud officer. |
| 18.5-T4 | Given a confirmed OFAC match at 2026-11-02 15:10 ET, then the Ethics email must be sent by 2026-11-03 15:10 ET; the timer counts clock hours across the weekend when applicable. |
| 18.5-T5 | Given an allegation of fraud by a retained law firm discovered Thursday, then the Fannie Mae Legal email is due by the following Monday (2 BD). |
| 18.5-T6 | Given the agent proposes a determination with confidence 0.95, then the case still requires the fraud officer's recorded determination before any report is drafted for signature. |
| 18.5-T7 | Given a validated QC finding affecting 620 loans, then `FNMA_A3201_BREACH_SELF_REPORT_60` starts from the later of quarter-end or discovery. |
| 18.5-T8 | Given a protective hold placed 2026-10-05 with no officer renewal, then it expires 2026-11-04 and the payoff proceeds. |
| 18.5-T9 | Given the fraud officer is a subject of an employee case, then the assignment is refused and routed to the deputy/board designee. |
| 18.5-T10 | Given quarterly fairness stats showing flag rates 4.1% vs 2.0% by protected class, then a finding opens for rule review (routed via counsel). |

#### Audit and evidence
Red-flag events with detector versions, case timelines, evidence hashes, determination memos, signed reports with LQC/email evidence, partner notifications, protective-action history with expiries, referral memos, timer histories — the A3-4-03 "record of activity under the internal audit and management control systems," retained `life_of_loan_plus_4y`/`corporate_7y` and restricted-access.

### Open questions / decisions
1. **Who files the LQC self-report for subserviced loans** — default: partner's submitter with Supermortgage's package; Supermortgage files for loans where Fannie Mae communicates with it directly.
2. **Voluntary SAR policy** — default: none (not covered); route to the partner's BSA officer where the partner is covered.
3. **Law-enforcement silence vs. the 30-day Fannie Mae duty** — default: file with Fannie Mae with a confidentiality note unless counsel documents a contrary legal direction.
4. **State regulator fraud-reporting matrix** — build `jurisdiction_rules.fraud_reporting` from counsel's survey (open).

### Sources
- Selling Guide A3-4-03 (12/10/2025): https://selling-guide.fanniemae.com/sel/a3-4-03/preventing-detecting-and-reporting-mortgage-fraud — verified 2026-09-09
- Selling Guide A3-2-01 (12/10/2025): https://selling-guide.fanniemae.com/sel/a3-2-01/compliance-laws — verified 2026-09-09
- Servicing Guide A2-1-09 (12/17/2025): https://servicing-guide.fanniemae.com/svc/a2-1-09/compliance-requirements-and-laws ; SVC-2025-07: https://singlefamily.fanniemae.com/media/document/pdf/announcement-svc-2025-07-servicing-guide-update — verified 2026-09-09
- Fannie Mae Mortgage Fraud Prevention: https://singlefamily.fanniemae.com/mortgage-fraud-prevention — verified 2026-09-09
- Servicing Guide A4-2.2-02 (11/12/2014) — as in 18.1
- 31 CFR 1010.100 (eCFR current Sept. 4, 2026): https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-A/section-1010.100 — verified 2026-09-09
- Information Security and Business Resiliency Supplement (Sept. 2, 2025) — as in 18.1; research/00b N10 (Nacha fraud-monitoring rules)
