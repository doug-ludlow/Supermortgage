# 18.4 — Form 582 Lender Record Information

| Attribute | Value |
|---|---|
| Section | 18 — QC, Audit & Regulatory Reporting |
| Automation class | a |
| SoR / Sub | SoR |
| Trigger & frequency | Annual |
| Governing source | FNMA A2-1-01 |
| Key deadlines | Annual |
| Timers | `FNMA_A2101_TECH_PROVIDER_BREACH_5BD`, `FNMA_A2101_TECH_PROVIDER_CHANGE_180`, `FNMA_A3501_INSURANCE_EXPIRY_30`, `FNMA_A4102_AFS_FYE_90`, `FNMA_A4102_FORM582_FYE_90`, `FNMA_A4102_ORG_CHANGE_5BD`, `FNMA_A4103_MAJOR_CHANGE_ADVANCE_60`, `FNMA_A4103_REGULATORY_ACTION_IMMEDIATE`, `FNMA_A42106_FORM183_ON_CHANGE`, `FNMA_ISBR_ANNUAL_ATTESTATION`, `SM_AFS_AUDITOR_DELIVERY_FYE_75`, `SM_FORM582_PARTNER_PACKAGE_FYE_60`, `SM_PARTNER_NOTIFY_SUB_EVENT_1BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | QC/Audit |
| Trigger & frequency | Annual |
| Governing source (blueprint) | FNMA A2-1-01 |
| Key deadlines (blueprint) | Annual |
| Data/artifacts | Form 582 |
| Systems | Fannie Mae |
| Automation class (blueprint) | a |
| SoR / Sub | SoR |
| Nuances (blueprint) | (none in source) — reconstructed: due **no later than 90 days after fiscal year-end together with the audited financial statements**; submitted electronically in the Enterprise Customer Relationship Management (ECRM) application (Technology Manager role `FORM582_BUSINESS_ROLE`); the master servicer confirms its subservicing arrangements on it annually (A2-1-07); **Pending Actions** updates plus an email to the Changes in Lender Organization mailbox **within five business days** of specified events; separately, 60 days' advance notice (and prior approval for some) of major organizational changes (A4-1-03); **Supermortgage files its own Form 582** as an approved servicer |

### Verified requirement (as of 2026-09-09)

**Selling Guide A4-1-02, Submission of Financial Statements and Reports (05/01/2024; SEL-2024-03).** *Audited financial statements:* due "within 90 days after the end of the seller/servicer's fiscal year"; must "be prepared under Generally Accepted Accounting Principles (GAAP)," "include the opinion of an independent public accountant," "be comparative with the previous year's reports," and include the balance sheet, income statement, statement of retained earnings, statement of additional paid-in capital, statement of changes in financial position and related notes; consolidated statements "must contain sufficient detail to enable Fannie Mae to review the seller/servicer's financial data separately"; submitted electronically to the Lender Eligibility and Compliance Unit. Depositories may substitute published statements with certification; HUD-approved mortgagees may submit the HUD audit report. Fannie Mae "may, at any time, require a seller/servicer to submit unaudited financial statements, audited financial statements other than the annual statements … or any other financial information." *Form 582:* update "no later than 90 days after the end of the seller/servicer's fiscal year"; and "within five business days of the occurrence" of material changes — actions that "could reasonably be expected to have a material adverse effect," breaches of agreements, material adverse changes in circumstances, changes affecting origination, servicing or financial condition, and "changes in principal officers or owners/partners with 5%+ interest" — reported "via an update to the Pending Actions section in Form 582 and an email to the Changes in Lender Organization mailbox" (Form 582 FAQ, July 2026). *Form 1002* quarterly and *Form 1002A* monthly (large non-depositories) — 18.7.

**Selling Guide A4-1-03, Report of Changes in the Seller/Servicer's Organization (05/01/2024).** Prior approval and "60 days' advance written notice" for mergers/consolidations/reorganizations, asset sales/purchases, ownership changes of 5%+ (direct or indirect) and legal-structure/charter changes; advance written notice (60 days) for other major changes — senior-management changes, financial-position changes, legal-name and principal-address changes; "immediate written notice" of regulatory actions and of a regulator assuming a management role; "A seller/servicer's failure to provide adequate written notice of or obtain prior written approval … is a breach of the Lender Contract."

**Form 582 mechanics (Fannie Mae Form 582 page; FAQ July 2026; sample-form guide).** "The Lender Record Information (Form 582) app allows you to prepare your annual certification and submit it electronically to Fannie Mae"; access via ECRM single sign-on after the Corporate Administrator assigns `FORM582_BUSINESS_ROLE`; the seller/servicer must "designate at least one individual as the person responsible for the submission of the annual Form 582 certification." Screens (sample guide): Account Overview (MWDOB designation), Roles in Your Organization (mandatory roles marked; Head of Pre-Funding/Post-Closing QC), Contacts with Ownership Interest (individuals/firms), Business Operations/Property Type, Warehouse Banks, Quality Control (vendor picklists; up to three QC vendors; "Third-Party QC Vendor Oversight contact"), Third-Party Vendor Operations (contractors/third parties — "recently split into two separate questions"), Servicer Information, **Subservicing** ("Do you subservice for others?" / "Do you use a subservicer?" with follow-ups), Regulatory Compliance (TCPA, FDCPA questions with follow-ups on "NO"), Insurance & Risk Management, Insurance Policies ("Expired insurance policies must be deleted before Verify this response can be selected"), and per-section "Verify this response" checkboxes; a Pending Actions section for organizational-change notifications. The certification/signature screen wording was not visible in the public sample **[UNVERIFIED — certification text]**. **A2-1-07:** the master servicer confirms subservicing arrangements annually on Form 582. **Form 1001** (credit/business references) is required at initial approval and on ownership change (00a §4.3).

**Companion annual certifications tracked here.** (a) Information Security and Business Resiliency Supplement — annual "written attestation executed by a duly authorized corporate officer" (Section 19 produces; 18.4 calendars). (b) Fidelity bond/E&O (Selling Guide A3-5-01/02/03, 07/25/2017): fidelity bond = the greater of annual originations UPB or highest monthly servicing UPB "including loans owned and serviced by others," tiered: $300,000 minimum up to $100M; plus 0.150% of the next $400M; plus 0.125% of the next $500M; plus 0.100% above $1B; cap $150M; deductible ≤ the higher of 10%/$100,000 (≤ $100M) or 15% (> $100M); E&O equal to the fidelity amount capped at $10M (single-family only) / $30M (SF + multifamily), deductible ≤ greater of $100,000 or 10% (< $1B) / 15% (≥ $1B) for aggregate policies; Fannie Mae as loss payee; insurer must give Fannie Mae 30 days' notice of cancellation/reduction/non-renewal and 10 days' notice of a servicer's cancellation request; "The master servicer must maintain fidelity bond coverage at all times for the servicing of mortgage loans that it owns but that the subservicer services" (and likewise E&O) — subservicers need coverage for loans they own. A3-5-04 event-reporting timeframes **[UNVERIFIED — topic content not retrieved]**. (c) Form 183 adverse-action certification (A4-2.1-06) — re-file when the notice text changes. (d) A2-1-01 technology-provider notices (≥ 20,000 loans): 180 days before changing a critical technology provider; 5 business days after any termination/breach/impairment — Supermortgage *is* the partner's technology provider, so the partner's contract with Supermortgage must carry the three A2-1-01 clauses (00b Part B(b)).

**Discrepancies with the blueprint row.** (1) Source is Selling Guide A4-1-02/A4-1-03 (via Servicing Guide A3-1-01), not A2-1-01. (2) "Annual" omits the 5-business-day and 60-day change notices. (3) Automation class "a" is wrong for the submission: ECRM is portal-only and requires a designated submitter/officer — class "c" for the submission, "a" for assembly. (4) "SoR" is incomplete — Supermortgage files its own Form 582/AFS/1002 as an approved servicer; the partner's Form 582 names Supermortgage as subservicer and technology provider.

### Operational prerequisites
- **Both entities:** Technology Manager Corporate Administrator; ECRM access with `FORM582_BUSINESS_ROLE` for the designated submitter (`fnma_portal_operator` at Supermortgage; the partner's own submitter); designated certifying `officer`. Lead time 1–2 weeks after TM registration.
- **Fiscal-year registry** for both entities (FYE dates; auditor engagement dates; AFS delivery date commitment from the auditor ≥ 15 days before the Fannie Mae deadline).
- **Registries populated** (Supermortgage-maintained, partner-verified): `org_registry` (officers, directors, owners ≥ 5% with contact data), `vendor_registry` (QC vendors, document custodians, technology providers, subservicers, outsourcers, law-firm networks), `insurance_policies` (fidelity/E&O carriers, amounts, deductibles, expirations, loss-payee endorsements), `licenses` (NMLS), `custodial_accounts` (6.1/6.2), `warehouse_banks` (partner), `subservicing_arrangements` (1.2: partner, loan counts, Form 101/629 references), `pending_actions`.
- **Changes in Lender Organization mailbox** address on file (from the Form 582 app/FAQ; not published on the public page **[UNVERIFIED address]**).
- **Subservicing agreement** clause obliging Supermortgage to deliver the partner's Form 582 data package ≥ 30 days before the partner's deadline and to notify the partner within 1 business day of any Supermortgage event that the partner must report within 5 business days.

### Build spec
#### Inputs and triggers
- Schedules: `filing.form582.cycle` opens FYE + 1 day for each entity; `filing.afs.cycle` same; monthly `registry.consistency.check`.
- Events: `org.change.recorded{kind}` (officer/owner/address/name/management/financial-position/regulatory-action/merger/asset-sale), `insurance.policy.changed|expiring`, `vendor.engaged|terminated`, `subservicing_arrangement.created|terminated` (1.2/17.x), `license.status.changed`, `regulatory.action.received`, `afs.received`, `fnma.request.received{financial_info}`.

#### Data model
- `regulatory_filings`: `id`, `entity` ∈ {partner, supermortgage}, `filing_type` ∈ {form_582, afs, form_1002, form_1002a, form_1001, isbr_attestation, form_183, capliq_plan, org_change_notice, tech_provider_notice, regab_1122, regab_1123, soc1}, `period_end`, `due_at`, `package_document_id`, `data_snapshot` (jsonb), `prepared_by_agent_run_id`, `approved_by_officer_id`, `submitted_at`, `submission_evidence`, `status`.
- `org_registry`: `entity`, `person_or_firm`, `role` (officer title / director / owner), `ownership_pct_bps`, `effective_from/to`, `contact` (PII-encrypted).
- `vendor_registry`: `entity`, `vendor_name`, `vendor_type` ∈ {qc_vendor, document_custodian, technology_provider, subservicer, outsourcer, law_firm_network, ai_vendor, print_mail, other}, `critical_function` bool (A2-1-01), `contract_document_id`, `fnma_clauses_present` bool, `start/end`.
- `insurance_policies`: `entity`, `kind` ∈ {fidelity, eo, cyber, other}, `carrier`, `coverage_cents`, `deductible_cents`, `effective/expires`, `fnma_loss_payee` bool, `document_id`.
- `subservicing_arrangements` (from 1.2): `master_entity`, `sub_entity`, `fnma_servicer_numbers`, `loan_count`, `upb_cents`, `form_101_document_id`, `form_629_ref`, `status`.
- `pending_actions`: `entity`, `event_kind`, `occurred_at`, `fnma_due_at`, `form582_updated_at`, `email_sent_at`, `document_id`.
- `fiscal_years`: `entity`, `fye_date`, `auditor`, `afs_expected_at`.
- Retention `corporate_7y`; PII encryption for `org_registry`.

#### State machine
`regulatory_filings.status` (Form 582): `open → data_assembled → registry_verified (Supermortgage QC) → partner_delivered (for partner filings) → officer_review → submitted (ECRM) → accepted | corrected`; `late` flag when past `due_at`. Org-change notices: `detected → classified → drafted → officer_approved → filed (Pending Actions + email) → acknowledged`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_A4102_FORM582_FYE_90` | deadline | fiscal year-end (per entity) | FYE | 90 calendar days; warnings at day 30 and day 60 | `filing.submitted{form_582}` with ECRM confirmation | sev-1 → `officer` + partner (Lender Contract breach) |
| `FNMA_A4102_AFS_FYE_90` | deadline | FYE | FYE | 90 calendar days | `filing.submitted{afs}` | sev-1 |
| `SM_FORM582_PARTNER_PACKAGE_FYE_60` | deadline | partner FYE | FYE | 60 calendar days | partner data package delivered | sev-2 (contract) |
| `SM_AFS_AUDITOR_DELIVERY_FYE_75` | deadline | FYE | FYE | 75 calendar days | `afs.received` | sev-2; escalate to CFO/officer |
| `FNMA_A4102_ORG_CHANGE_5BD` | deadline | `org.change.recorded{material}` | occurred_at | 5 `business_days_fannie_et` (Fannie Mae holiday calendar **[assumption — the Guide does not define the calendar]**); internal target day 4 | Pending Actions updated + email sent (both evidenced) | sev-1 |
| `FNMA_A4103_MAJOR_CHANGE_ADVANCE_60` | not_before_gate | planned major change (merger, 5%+ ownership, structure, name, address, senior management, financial position) | planned effective date | notice ≥ 60 calendar days before; prior approval where required | Fannie Mae approval/acknowledgment recorded | change blocked in the platform's own records until satisfied or `officer` waiver with rationale |
| `FNMA_A4103_REGULATORY_ACTION_IMMEDIATE` | deadline | `regulatory.action.received` | receipt | 1 business day (internal proxy for "immediate") | written notice sent to the customer account team | sev-1 |
| `SM_PARTNER_NOTIFY_SUB_EVENT_1BD` | deadline | any Supermortgage event reportable by the partner | occurrence | 1 business day | partner notified | sev-1 |
| `FNMA_A2101_TECH_PROVIDER_CHANGE_180` | not_before_gate | partner plans to replace Supermortgage or Supermortgage plans to replace a critical sub-provider (≥ 20,000 loans) | planned change | 180 calendar days | notice evidenced | change blocked |
| `FNMA_A2101_TECH_PROVIDER_BREACH_5BD` | deadline | termination/breach/impairment notice under a technology contract | occurrence | 5 business days | notice to Fannie Mae evidenced | sev-1 |
| `FNMA_A3501_INSURANCE_EXPIRY_30` | deadline | policy expiry | expires − 30 days | 30 calendar days before | renewal recorded (no lapse) | sev-1; Form 582 cannot verify with an expired policy |
| `FNMA_ISBR_ANNUAL_ATTESTATION` (18.1) | recurring | — | — | annual; aligned to the Form 582 window | signed attestation | sev-1 |
| `FNMA_A42106_FORM183_ON_CHANGE` | deadline | adverse-action notice template version change | template published | before first use (gate) | Form 183 submitted | notice template blocked |

#### Business rules and calculations
1. **Deadline arithmetic:** `due_at = FYE + 90 calendar days` (no business-day roll — file earlier if it lands on a weekend). Worked example: FYE 2026-12-31 → due **2027-03-31**; partner package due 2027-03-01 (day 60); AFS auditor delivery target 2027-03-16 (day 75). FYE 2026-06-30 → due 2026-09-28.
2. **Data assembly** produces a `data_snapshot` per screen from the registries, diffed against the prior year's snapshot; every changed answer carries an evidence pointer (contract, license, policy). The subservicing screen for the partner lists Supermortgage with its Fannie Mae servicer number, loan count and UPB as of FYE (from `subservicing_arrangements` and the LSDU/Servicing Platform reconciliation, Section 5); Supermortgage's own screen answers "subservice for others = YES" with the partner(s) listed; "use a subservicer = NO" unless Supermortgage itself subcontracts.
3. **Insurance adequacy check** (A3-5-02/03): compute required fidelity coverage from the greater of annual originations UPB (zero for a pure servicer) and highest monthly servicing UPB including loans serviced for others. Worked example — partner with highest monthly total servicing UPB $5,000,000,000: `300,000 + 0.0015 × 400,000,000 (= 600,000) + 0.00125 × 500,000,000 (= 625,000) + 0.0010 × 4,000,000,000 (= 4,000,000) = $5,525,000` fidelity; E&O = $5,525,000 (below the $10M single-family cap); maximum deductible 15% = $828,750. Supermortgage as subservicer with $0 owned servicing: Guide minimum applies only to owned loans, but the subservicing agreement and state licensing typically require coverage — default: Supermortgage carries fidelity/E&O sized on subserviced UPB by contract **[open decision 18.4-Q2]**. Amounts in cents: `5_525_000_00`.
4. **Materiality classification** of org changes uses the A4-1-02 list (5 BD) vs. the A4-1-03 list (60-day advance/prior approval) vs. "immediate" (regulatory actions); an event can be in two lists (e.g., a new 5%+ owner needs prior approval and a 5-BD Pending Actions update after occurrence).
5. **Consistency checks** before officer review: officers in `org_registry` = signatories in MERS/partner resolutions (1.5); vendors in `vendor_registry` = active integration adapters; custodial accounts = CBAM records (6.1); licenses = NMLS renewal status; insurance not expired; QC vendor oversight contact present when a QC vendor is listed.
6. **Certification:** the officer certifies from the console after reviewing the diff; the ECRM submission is a `human_portal_task` executed by the designated submitter with the officer's approval record attached.

#### Integrations
- **ECRM / Form 582 app** (portal-only; SSO): `human_portal_task` to the entity's designated submitter with the screen-by-screen answer sheet, evidence pointers and the officer approval id; the operator captures the submission confirmation to `documents`. AFS uploaded in the same application ("Getting started with AFS"). Failure: portal outage → retry; deadline proximity → officer informs the customer account team in writing (evidence).
- **Changes in Lender Organization mailbox** (email): officer-signed notice; sent-mail evidence. **Customer account team** (regulatory actions, prior approvals): email/letter.
- **Partner:** data package delivery (SFTP/portal) and receipt acknowledgment; partner's ECRM submission evidence returned to Supermortgage for the audit trail.
- **Auditor:** AFS receipt (secure upload); engagement calendar.
- **Registries:** NMLS (license status feed, Section 19), insurance broker certificates, MERS resolutions (1.5), CBAM (6.1).

#### Outputs and artifacts
- Form 582 answer sheet + evidence index (template `F582-PKG-v1`), AFS package, Pending Actions notices (template `F582-PENDING-v1`), A4-1-03 advance-notice letters (`ORG-CHG-NOTICE-v1`), technology-provider notices (`TECH-PROV-NOTICE-v1`), insurance adequacy worksheet, Form 183 package when triggered; `regulatory_filings` rows with submission evidence. No borrower notices, no ledger postings.

#### AI agent design (AI-first)
- **Agent:** `qc-audit` (filings module) with `compliance-sentinel` timers. End-to-end: open the cycle → assemble the snapshot → run consistency checks → produce the diff and evidence index → classify org-change events as they occur → draft notices → escalate for officer certification → create the portal task → track confirmation → file evidence.
- **Tools:** registry queries, document retrieval, insurance calculator, letter renderer, `escalations.create`, `human_portal_task.create`.
- **Decision record:** `{filing_id, snapshot_hash, diffs[], checks[], classification (for org events: list, deadline), drafts[], confidence}`.
- **Guardrails:** the agent cannot certify or submit (baseline §8 item 3 — Form 582 is an officer certification); any unresolved consistency check blocks `officer_review`; org-change classification with confidence < 0.9 → `officer` decides within the 5-BD window.
- **Escalations:** `officer` (certification; notices; waivers), `fnma_portal_operator`/designated submitter (ECRM), partner officer (partner's filing), `attorney` (regulatory actions, mergers).
- **AI-off path:** the snapshot and checks are deterministic; a compliance analyst drafts notices from templates.

#### Edge cases and failure modes
- **AFS late from the auditor:** file Form 582 with the AFS as soon as available; document the communication with Fannie Mae before day 90; Fannie Mae may request unaudited statements meanwhile.
- **Fiscal-year change:** update `fiscal_years`; a short year still carries a 90-day clock.
- **Expired insurance at filing time:** the form cannot be verified — the timer `FNMA_A3501_INSURANCE_EXPIRY_30` exists to prevent this; emergency binder evidence accepted.
- **Ownership change discovered late** (e.g., investor crossing 5% via secondary purchase): both the prior-approval breach and the 5-BD notice apply; officer notifies immediately with explanation.
- **Regulatory action against the partner** (not Supermortgage): partner's duty; Supermortgage supports; Supermortgage's own licenses may require notice to states (Section 19).
- **Subservicing arrangement terminated mid-year:** Form 629 process (17.x) and Form 101 termination; the next Form 582 reflects it; a 5-BD Pending Actions update if material.
- **Multiple partners:** each master lists Supermortgage; Supermortgage lists each master.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 18.4-T1 | Given partner FYE 2026-12-31, then `FNMA_A4102_FORM582_FYE_90` is due 2027-03-31 with warnings 2027-01-30 and 2027-03-01, and the partner package timer is due 2027-03-01. |
| 18.4-T2 | Given a new CFO recorded on Tuesday 2026-11-10, then the Pending Actions update and email are due by 2026-11-18 on the `fannie_et` calendar (Veterans Day 2026-11-11 is a Fannie Mae holiday, so the five business days are 11/12, 11/13, 11/16, 11/17, 11/18) and the partner is notified by 2026-11-12 (next business day); the platform targets 11/17 to keep a day of margin. |
| 18.4-T3 | Given highest monthly servicing UPB $5,000,000,000, then required fidelity = $5,525,000, E&O = $5,525,000, max deductible $828,750; a policy at $5,000,000 fails the adequacy check and blocks `officer_review`. |
| 18.4-T4 | Given a fidelity policy expiring 2027-02-15 with no renewal recorded by 2027-01-16, then the expiry timer breaches and the Form 582 cycle is flagged. |
| 18.4-T5 | Given a planned 10% equity sale with effective date 2027-05-01 recorded 2027-03-20, then the gate `FNMA_A4103_MAJOR_CHANGE_ADVANCE_60` shows the notice deadline already passed (needed by 2027-03-02) and escalates to `officer`/`attorney`. |
| 18.4-T6 | Given a state consent order received, then a written notice is drafted and escalated the same day and the timer is satisfied only by sent evidence. |
| 18.4-T7 | Given the agent attempts to mark a filing `submitted` without an ECRM confirmation document, then the transition is refused. |
| 18.4-T8 | Given Supermortgage's own Form 582 cycle, then the subservicing screen answers "subservice for others = YES" listing the partner's servicer number and FYE loan count/UPB reconciled to Section 5 position data. |

#### Audit and evidence
Snapshots and diffs with evidence pointers, officer approval records, ECRM/email submission confirmations, registries' effective-dated history, insurance certificates, timer histories, partner delivery receipts — `corporate_7y`. Evidence for Fannie Mae eligibility reviews and for state examiners' "management and control" questions.

### Open questions / decisions
1. **Who is the ECRM submitter at Supermortgage** — default: `fnma_portal_operator` with `FORM582_BUSINESS_ROLE`; the certifying `officer` approves in the console first.
2. **Supermortgage's fidelity/E&O sizing** — default: sized on subserviced UPB per the A3-5-02 tiers as if owned, by contract with the partner.
3. **Internal proxy for "immediate"** regulatory-action notice — default 1 business day.
4. **Changes in Lender Organization mailbox** address — capture from the app at first login; store in the contact registry.

### Sources
- Selling Guide A4-1-02 (05/01/2024): https://selling-guide.fanniemae.com/sel/a4-1-02/submission-financial-statements-and-reports — verified 2026-09-09
- Selling Guide A4-1-03 (05/01/2024): https://selling-guide.fanniemae.com/sel/a4-1-03/report-changes-sellerservicers-organization — verified 2026-09-09
- Form 582 page: https://singlefamily.fanniemae.com/form-582-lender-record-information ; FAQ (July 2026): https://singlefamily.fanniemae.com/media/document/pdf/faqs-lender-record-information-form-582 ; sample guide: https://singlefamily.fanniemae.com/media/document/pdf/sample-lender-record-information-form-582 ; QC job aid: https://singlefamily.fanniemae.com/media/document/pdf/quality-control-job-aid — verified 2026-09-09
- Selling Guide A3-5-01/A3-5-02/A3-5-03 (07/25/2017): https://selling-guide.fanniemae.com/sel/a3-5-01/fidelity-bond-and-errors-and-omissions-coverage-provisions ; …/a3-5-02/fidelity-bond-policy-requirements ; …/a3-5-03/errors-and-omissions-policy-requirements — verified 2026-09-09
- Servicing Guide A2-1-07 (05/13/2026), A2-1-01 (12/17/2025), A4-2.1-06 (Form 183) — as above; research/00a §4.3, §6.4; research/00b "Other Fannie Mae touchpoints"
