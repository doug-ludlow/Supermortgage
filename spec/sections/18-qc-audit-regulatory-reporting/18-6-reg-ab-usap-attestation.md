# 18.6 — Reg AB / USAP attestation

| Attribute | Value |
|---|---|
| Section | 18 — QC, Audit & Regulatory Reporting |
| Automation class | c |
| SoR / Sub | SoR |
| Trigger & frequency | Annual (if applicable) |
| Governing source | Reg AB; USAP |
| Key deadlines | Annual |
| Timers | `REGAB_1122_2VII_RECON_ITEMS_90`, `REGAB_1122_ASSESSMENT_PSA_DUE`, `REGAB_1123_STATEMENT_PSA_DUE`, `SM_ATTEST_EVIDENCE_COMPILE_FYE_15`, `SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45`, `SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD`, `SM_SOC1_TYPE2_ANNUAL` |

### Blueprint row
| Field | Value |
|---|---|
| Area | QC/Audit |
| Trigger & frequency | Annual (if applicable) |
| Governing source (blueprint) | Reg AB; USAP |
| Key deadlines (blueprint) | Annual |
| Data/artifacts | Attestation |
| Systems | External auditor |
| Automation class (blueprint) | c |
| SoR / Sub | SoR |
| Nuances (blueprint) | (none in source) — reconstructed: **not applicable to the Fannie Mae book** (Fannie Mae MBS are exempt securities); applicable only where the partner (or a client) services registered asset-backed securities — then each "party participating in the servicing function" (which would include Supermortgage) must furnish its own Item 1122 assessment with a registered public accounting firm's attestation and the partner an Item 1123 officer statement; USAP is the legacy MBA program still requested by some private investors/rating agencies; the practical annual deliverable for a subservicer is a **SOC 1 Type II** plus a 1122(d) control matrix |

### Verified requirement (as of 2026-09-09)

**Applicability.** Regulation AB (17 CFR 229.1100–1125) governs disclosure and reporting for asset-backed securities registered under the Securities Act and reported under the Exchange Act. Fannie Mae's MBS and debt are "exempt securities": 12 U.S.C. 1719(d) — "Securities issued by the corporation under this subsection shall, to the same extent as securities which are direct obligations of or obligations guaranteed as to principal and interest by the United States, be deemed to be exempt securities within the meaning of laws administered by the Securities and Exchange Commission" (and (e) for obligations). Fannie Mae does not require Reg AB or USAP reports from servicers; its annual counterparts are the AFS, Form 582 and Form 1002 (18.4/18.7), the Supplement's officer attestation (Section 19) and, on request, QC results (18.1). **Therefore 18.6 runs only when the partner services registered ABS or a private investor contractually demands it.**

**17 CFR 229.1122 (eCFR current Sept. 2, 2026), Item 1122 — Compliance with applicable servicing criteria.** (a) "A party participating in the servicing function means any entity (e.g., master servicer, primary servicers, trustees) that is performing activities that address the criteria" (a party whose activities relate to 5% or less of the pool assets may be excluded); each such party must provide a report containing "A statement of the party's responsibility for assessing compliance with the servicing criteria applicable to it," "A statement that the party used the criteria in paragraph (d) of this section to assess compliance," the assessment for the fiscal year "including … disclosure of any material instance of noncompliance," and "A statement that a registered public accounting firm has issued an attestation report on the party's assessment"; (b) the accountant's attestation report is filed as an exhibit; (c) material noncompliance must be disclosed on Form 10-K, including whether it involved "the servicing of the assets backing the asset-backed securities"; Instruction 3: "If multiple parties are participating in the servicing function, a separate assessment report and attestation report must be included for each party." (d) Servicing criteria — (1) general servicing considerations: (i) policies/procedures to monitor triggers and events of default; (ii) if outsourced, "policies and procedures are instituted to monitor the third party's performance"; (iii) back-up servicer requirements maintained; (iv) "A fidelity bond and errors and omissions policy is in effect"; (2) cash collection and administration: (i) payments deposited to custodial accounts "no more than two business days" after receipt; (ii) wire disbursements "made only by authorized personnel"; (iii) advances "made, reviewed and approved as specified"; (iv) accounts "separately maintained"; (v) custodial accounts at a federally insured depository; (vi) unissued checks safeguarded; (vii) monthly reconciliations of all ABS bank accounts, mathematically accurate, reviewed by another party, with reconciling items resolved "within 90 calendar days"; (3) investor remittances and reporting: (i) reports per the transaction agreements (timeframes, calculation methods, agreement with trustee records); (ii) amounts allocated and remitted per timeframes and priority; (iii) investor disbursements "posted within two business days"; (iv) remittances agree to cancelled checks/wires or custodial bank statements; (4) pool asset administration: (i) collateral maintained; (ii) documents safeguarded; (iii) additions/removals/substitutions reviewed and approved; (iv) obligor payments posted "no more than two business days after receipt"; (v) servicer records agree on unpaid principal balances; (vi) changes in terms/status reviewed and approved by authorized personnel; (vii) loss mitigation/recovery actions "initiated, conducted and concluded in accordance with the timeframes"; (viii) collection-effort records maintained "on at least a monthly basis"; (ix) variable-rate adjustments computed per the pool asset documents; (x) escrow analyses "on at least an annual basis," escrow interest paid where required, escrow returned "within 30 calendar days of full repayment"; (xi) payments on behalf of obligors made before penalty/expiration dates; (xii) late-payment penalties paid from the servicer's funds "and not charged to the obligor"; (xiii) obligor disbursements posted within two business days; (xiv) delinquencies/charge-offs recognized per the agreements; (xv) external enhancements maintained.

**17 CFR 229.1123 (eCFR current Sept. 8, 2026), Item 1123 — Servicer compliance statement:** "A separate servicer compliance statement is required from each servicer" described in Item 1108(a)(2)(i)–(iii), signed by "an authorized officer of such servicer," stating that "A review of the servicer's activities during the reporting period and of its performance" was conducted under the officer's supervision and that the servicer has fulfilled its obligations "in all material respects throughout the reporting period" or specifying each known failure, its nature and status. **Timing:** with the issuer's Form 10-K for the fiscal year (90 days after fiscal year-end for the issuer; the pooling and servicing agreement typically requires servicer deliverables earlier, commonly by March 1–15 **[UNVERIFIED — per PSA]**).

**USAP.** The MBA's Uniform Single Attestation Program for Mortgage Bankers (1995; revised after Reg AB) is a set of minimum servicing standards attested under AICPA attestation standards; it is no longer required for registered deals but is still requested by some private-label investors, warehouse/MSR lenders and rating agencies **[PARTIALLY VERIFIED — from general knowledge; no primary MBA page retrieved]**. **Rating-agency servicer evaluations** (S&P/Moody's/Fitch/KBRA/DBRS) become mandatory for large non-depositories under FHFA/Selling Guide A4-1-01 at $50B+ UPB (18.7).

**Discrepancies with the blueprint row.** (1) "If applicable" should be resolved: not applicable to Fannie Mae loans; applies only to registered ABS the partner services — at launch, likely none. (2) When applicable, "SoR" is incomplete: Supermortgage would be a "party participating in the servicing function" and must furnish its own 1122 assessment and attestation. (3) The practical annual artifact is a SOC 1 Type II (AICPA AT-C 320) over the platform's servicing controls, which the partner's auditors and the CSBS prudential standards (external audit) will ask for regardless of Reg AB.

### Operational prerequisites
- **Applicability determination** recorded per investor/pool: registry `investor_programs` with `regab_applicable` flag, PSA deliverable dates, criteria applicability list (Instruction 2 — inapplicable criteria disclosed).
- **Registered public accounting firm** engaged (PCAOB-registered for 1122 attestations; AICPA for SOC 1) — partner engages for its own report; Supermortgage engages for its report; lead time 3–4 months before fiscal year-end for walkthroughs.
- **Control matrix v1** mapping each 1122(d) criterion to platform controls (table below) with owners and evidence queries; SOC 1 control objectives aligned to the same matrix.
- **Subservicing agreement:** obligation to furnish the 1122 assessment/attestation (or SOC 1) by a date ≥ 15 days before the partner's PSA deadline; cooperation with the partner's auditors; sharing of material noncompliance immediately.

### Build spec
#### Inputs and triggers
- Schedule `attestation.cycle` opens FYE − 120 days (planning), with fieldwork windows; events `investor_program.created{regab_applicable}`, `auditor.request.received`, `control.exception.recorded` (from 18.1 findings tagged with 1122 criteria), `attestation.report.received`, `material_noncompliance.determined`.

#### Data model
- `investor_programs`: `id`, `investor`, `program_kind` ∈ {fnma_mbs, fnma_portfolio, private_abs_registered, private_whole_loan, other}, `regab_applicable` bool, `usap_requested` bool, `psa_deliverable_due` (rule), `criteria_applicable` (text[] of 1122(d) codes), `partner_entity`.
- `control_matrix`: `criterion` (e.g., `1122.d.2.vii`), `control_code`, `description`, `owner_agent`, `evidence_query`, `qc_rule_codes` (18.1 rules that test it), `frequency`, `key` bool.
- `control_evidence` (append-only): `control_code`, `period`, `evidence_document_ids`, `qc_results_summary`, `exceptions_count`, `generated_at`.
- `attestation_packages`: `entity`, `fiscal_year`, `kind` ∈ {regab_1122_assessment, regab_1123_statement, soc1_type2, usap}, `criteria_scope`, `material_noncompliance` (jsonb list), `management_assertion_document_id`, `signed_by_officer_id`, `auditor_report_document_id`, `delivered_to` (partner/investor), `delivered_at`, `status`.
- Retention `corporate_7y`.

#### State machine
`attestation_packages.status`: `planned → evidence_compiled → walkthroughs → testing (auditor) → exceptions_evaluated → assertion_signed → attestation_received → delivered → closed`; `material_noncompliance_disclosed` branch feeds 18.1 CAPA and the partner's 10-K disclosure workflow.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGAB_1122_ASSESSMENT_PSA_DUE` | deadline | fiscal year-end (when `regab_applicable`) | FYE | per PSA (default FYE + 60 days **[UNVERIFIED]**); warning at FYE + 30 | assessment + attestation delivered | sev-1 → `officer` + partner |
| `REGAB_1123_STATEMENT_PSA_DUE` | deadline | FYE (partner as servicer) | FYE | per PSA (default FYE + 60) | officer statement delivered | sev-1 |
| `SM_SOC1_TYPE2_ANNUAL` | recurring | fiscal year | FYE | report issued by FYE + 75 days | `attestation.report.received{soc1}` | sev-2 (contract/CSBS) |
| `SM_ATTEST_EVIDENCE_COMPILE_FYE_15` | deadline | FYE | FYE | 15 calendar days | `control_evidence` complete for all matrix rows | sev-2 |
| `SM_ATTEST_MANAGEMENT_ASSERTION_FYE_45` | deadline | FYE | FYE | 45 calendar days | assertion signed by `officer` | sev-1 |
| `SM_MATERIAL_NONCOMPLIANCE_PARTNER_1BD` | deadline | `material_noncompliance.determined` | determination | 1 business day | partner notified | sev-1 |
| `REGAB_1122_2VII_RECON_ITEMS_90` | deadline | custodial reconciling item aged | item date | 90 calendar days | item resolved (Section 6.3) | sev-2 → control exception |

#### Business rules and calculations
1. **Applicability check:** run at each investor onboarding; Fannie Mae programs → `regab_applicable=false` (12 U.S.C. 1719(d)); registered ABS → true; private whole-loan investors → contractual (USAP/SOC 1) only.
2. **Control matrix (excerpt — the build must complete all 1122(d) rows):**

| 1122(d) criterion | Platform control | Evidence / QC rule |
|---|---|---|
| (1)(ii) monitor outsourced third parties | Vendor management program; annual vendor QC tests | `QC_VENDOR_ANNUAL_TEST_*`; 18.1 reports |
| (1)(iv) fidelity bond and E&O in effect | `insurance_policies` with expiry timers | `FNMA_A3501_INSURANCE_EXPIRY_30` history |
| (2)(i) deposits within 2 business days | Lockbox/ACH same-day posting; deposit timers (2.x/6.x) | `QC_PAY_DEPOSIT_TIMELINESS` census |
| (2)(ii) wires by authorized personnel | Dual-approval wire workflow; bank user roles | wire approval logs |
| (2)(iv)/(v) separate accounts at insured depositories | `custodial_accounts` (Forms 1013/1014), eligibility checks (6.1) | CBAM records, depository ratings |
| (2)(vii) monthly reconciliations, reviewed, items resolved ≤ 90 days | Forms 496/496A within 45 days (6.3); independent review by `qc-audit`; aging | `QC_CUSTODIAL_496_TIEOUT`; `REGAB_1122_2VII_RECON_ITEMS_90` |
| (3)(i)–(iv) investor reports/remittances | Section 5 event/LAR reporting, remittance reconciliation, draft matching | `QC_INVESTOR_EVENT_TIMELINESS`, `QC_REMITTANCE_RECON` |
| (4)(iv) obligor payments posted ≤ 2 business days | Cashiering posting timers (2.1) | `QC_PAY_POSTING_TIMELINESS` |
| (4)(vi) term/status changes approved | Command authorization; `loan_terms` versioning; officer approvals for modifications (12.x) | `agent_decisions`, approval records |
| (4)(vii) loss mitigation within timeframes | Reg X/Guide timers (12.x) | timer histories; `QC_LOSSMIT_*` |
| (4)(viii) monthly collection records | `contacts` logging | `QC_QRPC_DOCUMENTATION` |
| (4)(ix) ARM adjustments per documents | Dual-engine ARM (7.2) | `QC_ARM_ADJ_RECOMPUTE` |
| (4)(x) annual escrow analysis; interest; refund ≤ 30 days | Section 3 engine; state interest; payoff refund (3.5/16.x) | `QC_ESCROW_*`, refund timers |
| (4)(xi)/(xii) timely tax/insurance payments; penalties borne by servicer | Disbursement timers (3.x); penalty ledger to `corporate_advances` never to borrower | `QC_ESCROW_DISB_TIMELINESS`; ledger tests |
| (4)(xiii) obligor disbursements posted ≤ 2 business days | Disbursement posting timers | census |
| (4)(xiv) delinquencies/charge-offs recognized | `fnma_delinquency_status` daily; Section 5 reporting | `QC_DELQ_STATUS_ACCURACY` |

3. **Material instance of noncompliance:** determined by the `officer` on counsel's advice using the auditor's materiality framework; any 18.1 sev-1 finding tagged to a criterion is presumptively evaluated; disclosed in the assessment and to the partner within 1 BD.
4. **Assessment period alignment:** the assessment covers the fiscal year of the *issuer's* reporting period (PSA) — may differ from Supermortgage's fiscal year; `control_evidence` is generated for any period window.
5. **1123 support:** Supermortgage furnishes the partner's officer a sub-certification listing the servicing obligations under the PSA and any known failures, so the partner's Item 1123 statement rests on documented review.

#### Integrations
- **Auditor:** secure evidence room (read-only console role `auditor`, exports with hashes), sample requests fulfilled from `control_evidence`; report receipt to `documents`.
- **Partner/investors/trustees:** delivery of assessments, attestations, SOC 1 and sub-certifications by secure transfer; receipt acknowledgments.
- **Rating agencies** (when 18.7 thresholds are crossed): operational review packages assembled by the 18.2 engine.

#### Outputs and artifacts
- Management assertion (`ATTEST-1122-ASSERT-v1`), 1122 assessment report, accountant's attestation (external), Item 1123 sub-certification (`ATTEST-1123-SUBCERT-v1`), SOC 1 Type II report (external), USAP report (if requested), control matrix and evidence binder; `attestation_packages`, `control_evidence`. No borrower notices, no ledger postings.

#### AI agent design (AI-first)
- **Agent:** `qc-audit` (attestation module). End-to-end: applicability determination → matrix maintenance (proposes mappings when rules/controls change) → evidence compilation per period → exception analysis (links 18.1 findings and timer breaches to criteria; drafts materiality memos) → drafts the assertion and sub-certification → auditor request fulfilment → delivery tracking.
- **Tools:** `control_evidence.generate(period)`, QC results queries, timer histories, document export, letter renderer, `escalations.create`.
- **Decision record:** `{package_id, criterion, evidence_refs[], exceptions[], materiality_assessment, confidence}`.
- **Guardrails:** the agent never signs or asserts; management assertions and 1123 statements are officer acts (baseline §8 item 3: "Reg AB/USAP attestation"); exception omissions are impossible by construction (every 18.1 finding tagged to a criterion appears in the exception list until dispositioned by the officer).
- **Escalations:** `officer` (assertion, materiality, delivery), `attorney` (materiality/disclosure), partner officer (1123).
- **AI-off path:** evidence generation is deterministic; a compliance analyst drafts memos.

#### Edge cases and failure modes
- **Auditor scope disputes** (criteria inapplicable): disclose inapplicability (Instruction 2) with rationale.
- **Mid-year platform changes** (new agent version): control descriptions versioned; auditor tests both periods.
- **Transfers of pools** (in/out): assessment covers periods serviced; Instruction 1 (all transactions of the same asset type).
- **Findings after delivery:** supplemental disclosure to the partner; amended assessment if material.
- **Fannie Mae-only book:** the module produces SOC 1 evidence and the matrix but no Reg AB filings; timers not started.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 18.6-T1 | Given an investor program `fnma_mbs`, then `regab_applicable=false` and no `REGAB_*` timers start. |
| 18.6-T2 | Given a registered private-label pool with PSA deliverable FYE + 60 and FYE 2026-12-31, then the assessment/attestation deadline is 2027-03-01 with a warning 2027-01-30 and the assertion due 2027-02-14. |
| 18.6-T3 | Given a sev-1 QC finding tagged `1122.d.4.x` (escrow refund late on 40 loans), then it appears in the exceptions list and cannot be removed without an officer disposition. |
| 18.6-T4 | Given a custodial reconciling item aged 91 days, then a control exception is recorded for (2)(vii). |
| 18.6-T5 | Given `control_evidence.generate('2026-07-01','2027-06-30')` for a June issuer year, then evidence spans the window regardless of Supermortgage's December fiscal year. |
| 18.6-T6 | Given a material-noncompliance determination, then the partner is notified within 1 BD and the item is in the assessment text. |
| 18.6-T7 | Given the agent attempts to mark a package `assertion_signed` without an officer signature record, then the transition is refused. |

#### Audit and evidence
Control matrix versions, evidence binders with hashes, exception dispositions, signed assertions and sub-certifications, auditor reports, delivery receipts, timer histories — `corporate_7y`; reusable for CSBS external-audit requirements, partner audits and rating-agency reviews.

### Open questions / decisions
1. **SOC 1 Type II from year one** — default yes (partner and state prudential standards will require an external audit/control report regardless).
2. **PSA deliverable defaults** — default FYE + 60 days until each PSA is loaded.
3. **USAP** — default: not produced unless an investor contract requires it; SOC 1 + 1122(d) matrix offered instead.

### Sources
- 17 CFR 229.1122 (eCFR current Sept. 2, 2026): https://www.ecfr.gov/current/title-17/chapter-II/part-229/subpart-229.1100/section-229.1122 — verified 2026-09-09
- 17 CFR 229.1123 (eCFR current Sept. 8, 2026): https://www.ecfr.gov/current/title-17/chapter-II/part-229/subpart-229.1100/section-229.1123 — verified 2026-09-09
- 12 U.S.C. 1719(d)–(e): https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title12-section1719&num=0&edition=prelim — verified 2026-09-09
- Selling Guide A4-1-01 (08/05/2026) (servicer ratings at $50B+) — as in 18.1; research/00a §4.4, §5.3
