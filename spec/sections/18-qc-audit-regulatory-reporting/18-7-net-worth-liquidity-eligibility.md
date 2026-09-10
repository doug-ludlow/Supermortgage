# 18.7 — Net-worth / liquidity eligibility

| Attribute | Value |
|---|---|
| Section | 18 — QC, Audit & Regulatory Reporting |
| Automation class | a |
| Trigger & frequency | Quarterly |
| Governing source | FHFA Seller/Servicer Min. Financial Eligibility (base net worth $2.5M + 25 bps of GSE servicing) |
| Key deadlines | Per FHFA |
| Timers | `CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q`, `FHFA_ELIG_QUARTERLY_TEST`, `FNMA_A4101_LARGE_CAPLIQ_PLAN_90`, `FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD`, `FNMA_A4101_SERVICE_ONE_LOAN_DEC31`, `FNMA_A4102_FORM1002A_M_30`, `FNMA_A4102_FORM1002_Q_30`, `FNMA_A4102_FORM1002_YE_60`, `SM_ELIG_BREACH_NOTIFY_1BD`, `SM_ELIG_WARNING_REMEDIATION_30`, `SM_PARTNER_UPB_REPORT_MONTHLY_BD5` |

### Blueprint row
| Field | Value |
|---|---|
| Area | QC/Audit |
| Trigger & frequency | Quarterly |
| Governing source (blueprint) | FHFA Seller/Servicer Min. Financial Eligibility (base net worth $2.5M + 25 bps of GSE servicing) |
| Key deadlines (blueprint) | Per FHFA |
| Data/artifacts | Financials |
| Systems | FHFA/Fannie Mae reporting |
| Automation class (blueprint) | a |
| SoR / Sub | "SoR o[nly]" [cropped in source] — reconstructed and corrected: the **SoR** carries the UPB-based add-ons for the subserviced book (subserviced UPB counts toward the master's net worth and liquidity), but **Supermortgage, as an approved servicer, must independently meet** the $2.5M base, the 6% tangible-net-worth ratio and liquidity on any UPB for which it is master servicer, and must file its own Form 1002/AFS |
| Nuances (blueprint) | "subse[rviced loans] exclud[ed from] subse[rvicer's] minim[ums]" [cropped in source] — confirmed: Selling Guide A4-1-01 UPB definitions exclude "mortgage loans serviced by a seller/servicer under a subservicing arrangement" and FHFA FAQ #10 states the requirements "only apply to loans for which the servicer serves as Master Servicer" (research/00a §4.4) |

### Verified requirement (as of 2026-09-09)

**Selling Guide A4-1-01, Maintaining Seller/Servicer Eligibility (08/05/2026; SEL-2026-07 only removed the 12-loan minimum sale requirement for sellers — no change to the financial numbers).** *Net worth:* "Adjusted Net Worth of at least $2.5 million" plus "0.25% of the portion … Residential First Lien Mortgage Servicing UPB" serviced for Fannie Mae/Freddie Mac, "0.35% of the portion … serviced for Ginnie Mae," and "0.25% of Other Servicing UPB." *Capital:* non-depositories — "Adjusted Net Worth/total assets ratio of 6%, or equivalent"; depositories — primary regulator's minimums. *Liquidity (non-depositories):* "0.07% of the portion" of Enterprise UPB remitted scheduled/scheduled or scheduled/actual; "0.035% of the portion" remitted actual/actual; "0.10% of the portion" of Ginnie Mae UPB; "0.035% of Other Servicing UPB"; *origination liquidity* "0.5% of the sum of" loans held for sale and interest-rate lock commitments for originators exceeding $1 billion per quarter. *Allowable liquidity:* "unrestricted cash and cash equivalents; unpledged … investment grade securities limited to" Fannie Mae/Freddie Mac/Ginnie Mae MBS, GSE obligations and U.S. Treasuries, and "50% of the unused portion of committed servicing advance lines of credit." *Measurement:* UPB "at the end of each calendar quarter"; UPB definitions exclude loans "serviced by a seller/servicer under a subservicing arrangement." *Large non-depository seller/servicer:* "An entity servicing $50 billion or more in residential first lien mortgage servicing UPB plus other servicing UPB as determined at the end of each calendar quarter" — supplemental liquidity buffer "0.02% of the portion" (Enterprise) and "0.05% of the portion" (Ginnie Mae); a capital and liquidity plan "Within 90 days after the end of each calendar year" (governance, liquidity-risk monitoring, contingency funding plan tested "at least annually," "Annual liquidity stress test" including MSR valuation); notification "Within five business days following any material change" and "within one business day of any material changes during times of stress"; third-party ratings — $50B+ "one primary Servicer Rating or master Servicer Rating," $100B+ plus a long-term senior unsecured/corporate family rating, $150B+ ratings from two agencies. *Material decline triggers* (Fannie Mae may declare a breach): Adjusted Net Worth decline "25% over a quarterly reporting period or by more than 40% over two-consecutive quarterly reporting periods," or "Four or more consecutive quarterly losses accompanied by a decline in Lender Adjusted Net Worth of 30% or more." *Other eligibility:* "A servicer must service at least one loan for Fannie Mae as of December 31 of the prior calendar year"; internal audit "independent of all key functions"; written policies; business-continuity plan per the Supplement; vendor procedures; breach → "loss of access to all technology that is licensed only to approved servicers."

**Selling Guide A4-1-02 (05/01/2024) — reporting:** Form 1002 (Mortgage Bankers' Financial Reporting Form) "at the end of each calendar quarter" — March 31/June 30/September 30 reports "within 30 days," December 31 "within 60 days," containing "only the financial data related to the quarterly reporting period," certified by the "chief executive officer, the chief financial officer, or equivalent"; Form 1002A monthly "within 30 days of the end of each month" for large non-depositories (no report for the third month of a quarter); AFS within 90 days of FYE (18.4). **Form 1002 page:** submitted through **WebMB** (web application shared with Freddie Mac and Ginnie Mae; registration via the WebMB administrator). **FHFA Enterprise Seller/Servicer Minimum Financial Eligibility Requirements (Aug. 17, 2022 final; effective dates Sept. 30, 2023 / Dec. 31, 2023 / Mar. 31, 2024; research/00a §4.4):** the same numbers; FAQ #10 — subserviced loans excluded from the subservicer; "a subservicer must be an Enterprise-approved servicer." **CSBS prudential standards** (00a §5.3): state capital/liquidity keyed to the FHFA numbers for servicers with ≥ 2,000 loans in ≥ 2 states; North Carolina's safe harbor for FHFA-compliant servicers. **State licensing:** NMLS Mortgage Call Report financial-condition components and state net-worth/bond minimums (Section 19; jurisdiction-keyed).

**Discrepancies with the blueprint row.** (1) "SoR only" is wrong: both entities are tested; the subserviced UPB simply moves from Supermortgage's denominator to the partner's. (2) "Per FHFA" → Form 1002 30/60-day deadlines, AFS 90 days, capital/liquidity plan 90 days (large), monthly 1002A (large). (3) "Quarterly" is right for compliance testing; Supermortgage additionally reports subserviced UPB to the partner monthly so the partner can compute its own position. (4) Class "a" is right for computation; WebMB submission is portal-only with CEO/CFO certification.

### Operational prerequisites
- **GL feed** from the accounting system for each entity (Supermortgage's own; the partner supplies its figures or computes itself) — `gl` adapter (chart-of-accounts mapping to Adjusted Net Worth components; monthly close) **[open decision 18.7-Q1 — accounting system]**.
- **WebMB registration** (administrator contact per the Form 1002 page) and certifying CEO/CFO designation for each entity.
- **Definitions loaded** (`eligibility_config` v2026.1): Adjusted Net Worth components per Fannie Mae/FHFA (total equity less goodwill and other intangibles, less receivables from/investments in affiliates, less pledged assets net of associated liabilities, plus permitted subordinated debt to the extent allowed **[PARTIALLY VERIFIED — component list to be confirmed against the Form 1002 instructions/FHFA definitions]**), allowable-liquidity haircuts, UPB classes by investor/remittance type.
- **UPB position source:** Section 5 month-end position (LSDU/Servicing Platform reconciliation) by investor and remittance type; partner's non-Supermortgage UPB supplied by the partner.
- **Committed servicing-advance line documentation** (facility agreements) for the 50% unused-commitment credit; MBS/Treasury holdings custodial statements.

### Build spec
#### Inputs and triggers
- Schedules: `eligibility.compute.monthly` (BD5 after month-end; quarterly compliance test at quarter-end), `filing.form1002.cycle` (quarter-end), `filing.form1002a.cycle` (month-end, large only), `capliq.plan.cycle` (year-end, large only).
- Events: `gl.close.completed{entity, period}`, `upb.position.finalized{period}`, `facility.commitment.changed`, `afs.received`, `eligibility.threshold.warning`, `eligibility.breach.detected`, `material_change.detected{decline_trigger}`, `partner.upb_report.requested`.

#### Data model
- `eligibility_config` (versioned): bps rates by UPB class, base net worth cents (`250_000_000`), ratio bps (600), large-servicer threshold cents (`5_000_000_000_000`), buffer bps, decline-trigger parameters, allowable-liquidity haircuts.
- `gl_snapshots`: `entity`, `period_end`, `total_equity_cents`, `goodwill_intangibles_cents`, `affiliate_receivables_cents`, `pledged_assets_net_cents`, `total_assets_cents`, `net_income_qtd_cents`, `cash_unrestricted_cents`, `eligible_securities_cents`, `advance_line_committed_cents`, `advance_line_drawn_cents`, `source_document_ids`, `certified_by`.
- `upb_positions`: `entity`, `period_end`, `class` ∈ {ent_ss_sa, ent_aa, gnma, other, subserviced_for_others, hfs_and_irlc}, `upb_cents`, `loan_count`, `source`.
- `eligibility_results`: `entity`, `period_end`, `config_version`, `anw_cents`, `required_nw_cents`, `nw_surplus_cents`, `ratio_bps`, `allowable_liquidity_cents`, `required_liquidity_cents`, `liquidity_surplus_cents`, `large_servicer` bool, `buffer_required_cents`, `decline_flags` (jsonb), `status` ∈ {compliant, warning, breach}, `computed_at`, `certified_by_officer_id`.
- `regulatory_filings` rows for `form_1002`, `form_1002a`, `capliq_plan` (18.4 table).
- Retention `corporate_7y`.

#### State machine
Quarterly: `gl_received → upb_finalized → computed → officer_certified → form1002_prepared → submitted (WebMB) → acknowledged`; monthly (non-quarter months): `computed → reported_to_partner`; status ladder `compliant → warning (surplus < 25% of requirement or decline trigger approaching) → breach (surplus < 0 or trigger hit) → remediation_plan → compliant`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FHFA_ELIG_QUARTERLY_TEST` | recurring | calendar quarter-end | quarter-end | compute by BD10 of the following month | `eligibility.computed{quarter}` certified | sev-2 |
| `FNMA_A4102_FORM1002_Q_30` | deadline | quarter-end (Mar/Jun/Sep) | quarter-end | 30 calendar days; warning day 20 | WebMB submission evidence with CEO/CFO certification | sev-1 → `officer` |
| `FNMA_A4102_FORM1002_YE_60` | deadline | Dec 31 | Dec 31 | 60 calendar days; warning day 40 | WebMB submission evidence | sev-1 |
| `FNMA_A4102_FORM1002A_M_30` | deadline (large non-depositories only) | month-end (months 1–2 of each quarter) | month-end | 30 calendar days | submission evidence | sev-1 |
| `FNMA_A4101_LARGE_CAPLIQ_PLAN_90` | deadline (large only) | calendar year-end | Dec 31 | 90 calendar days | plan submitted | sev-1 |
| `FNMA_A4101_LARGE_MATERIAL_CHANGE_5BD` / `_STRESS_1BD` | deadline (large only) | material change to plan inputs / during stress | occurrence | 5 BD / 1 BD | notice evidenced | sev-1 |
| `SM_ELIG_WARNING_REMEDIATION_30` | deadline | `eligibility.threshold.warning` | detection | 30 calendar days | board-approved remediation plan | sev-2 |
| `SM_ELIG_BREACH_NOTIFY_1BD` | deadline | `eligibility.breach.detected` | detection | 1 business day | partner + `officer` notified; Fannie Mae notice per A4-1-02 "material adverse change" (5 BD, 18.4) | sev-1 |
| `SM_PARTNER_UPB_REPORT_MONTHLY_BD5` | deadline | month-end | month-end | BD5 | subserviced UPB/remittance-type report delivered | sev-2 (contract) |
| `FNMA_A4101_SERVICE_ONE_LOAN_DEC31` | recurring | calendar year | Dec 31 | must service ≥ 1 Fannie Mae loan as of Dec 31 | position ≥ 1 | sev-1 (approval at risk) |
| `CSBS_PRUDENTIAL_APPLICABILITY_CHECK_Q` | recurring | quarter-end | quarter-end | quarterly | loan-count/state test recorded | informs Section 19 licensing program |

#### Business rules and calculations
All amounts `bigint` cents; bps math `amount_cents × bps / 10_000` with round-half-up to the cent at each component, then summed.

1. **Adjusted Net Worth:** `anw = total_equity − goodwill_intangibles − affiliate_receivables − pledged_assets_net (+ permitted adjustments per config)`.
2. **Required net worth:** `req_nw = 250_000_000 + ent_upb × 25/10_000 + gnma_upb × 35/10_000 + other_upb × 25/10_000` (UPB excludes `subserviced_for_others` for the subservicer; includes it for the master).
3. **Capital ratio:** `ratio_bps = round(anw × 10_000 / total_assets)`; compliant if `≥ 600`.
4. **Allowable liquidity:** `cash_unrestricted + eligible_securities (unpledged, investment grade: agency MBS, GSE obligations, Treasuries) + 50% × (advance_line_committed − advance_line_drawn)`.
5. **Required liquidity:** `ent_ss_sa_upb × 7/10_000 + ent_aa_upb × 3.5/10_000 + gnma_upb × 10/10_000 + other_upb × 3.5/10_000 (+ 50 bps of hfs_and_irlc if originations > $1B in the quarter) (+ buffer 2 bps Enterprise / 5 bps Ginnie Mae if large)`; 3.5 bps implemented as `× 35 / 100_000`.
6. **Decline triggers:** compare `anw` to the prior quarter (−25%) and two quarters back (−40%); count consecutive quarterly losses (≥ 4 with ANW −30% vs. four quarters back).
7. **Warning bands:** `warning` when `nw_surplus < 25% × req_nw` or `liquidity_surplus < 25% × req_liq` or projected next-quarter position (UPB growth per boarding pipeline) would breach.

**Worked example 1 — Partner (master; non-depository), quarter-end 2026-12-31:** Enterprise S/A UPB serviced through Supermortgage `$5,000,000,000` (`500_000_000_000¢`), Enterprise A/A UPB `$1,000,000,000`, no Ginnie Mae, other `$0`; total equity `$40,000,000`, goodwill `$2,000,000`, affiliate receivables `$500,000`, total assets `$300,000,000`; cash `$6,000,000`, agency MBS `$2,000,000`, committed advance line `$10,000,000` drawn `$4,000,000`. ANW = `40,000,000 − 2,000,000 − 500,000 = $37,500,000`. Required NW = `2,500,000 + 6,000,000,000 × 0.0025 (= 15,000,000) = $17,500,000` → surplus `$20,000,000`. Ratio = `37.5M / 300M = 12.50%` ≥ 6% ✔. Allowable liquidity = `6,000,000 + 2,000,000 + 0.5 × 6,000,000 = $11,000,000`. Required liquidity = `5,000,000,000 × 0.0007 (= 3,500,000) + 1,000,000,000 × 0.00035 (= 350,000) = $3,850,000` → surplus `$7,150,000` ✔ (not large: total UPB $6B < $50B, no buffer).

**Worked example 2 — Supermortgage (pure subservicer):** subserviced UPB `$6,000,000,000` is excluded; own master-serviced UPB `$0`; total equity `$4,200,000`, intangibles (capitalized software) `$900,000`, total assets `$12,000,000`, cash `$2,500,000`. ANW = `$3,300,000`; required NW = `$2,500,000` → surplus `$800,000` (24.2% of requirement → **warning band** at 25%; board plan required). Ratio = `3.3M / 12M = 27.5%` ✔. Required liquidity = `$0` (no master-serviced UPB) — allowable `$2,500,000` ✔; but the subservicing agreement's advance-funding obligations (Section 5.4) drive an internal liquidity floor set by the board **[open decision 18.7-Q2]**. Note the capitalized-software deduction: if the software were expensed, ANW would be `$4,200,000` — the config must follow the actual ANW definition once confirmed.

**Worked example 3 — decline trigger:** ANW Q2 `$37,500,000` → Q3 `$27,000,000` (−28.0%) → `decline_flags.q_over_q_25 = true` → `breach` status irrespective of surplus; notify partner/officer within 1 BD and Fannie Mae within 5 BD as a material adverse change (18.4).

**Form 1002 assembly:** map `gl_snapshots`/`upb_positions` to the MBFRF schedules (balance sheet, income statement, servicing portfolio by investor/remittance type, liquidity/net-worth computations, subservicing data) **[UNVERIFIED — schedule layout from the Form 1002 instructions to be loaded]**; produce the answer file and the certification page for the CEO/CFO; the WebMB entry is a `human_portal_task`.

#### Integrations
- **GL system** (`gl` adapter; CSV/API export of trial balance and mapped accounts; monthly): failure → compute with the prior close flagged `stale`; quarterly certification blocked until a fresh close.
- **Section 5 position feed** (UPB by investor/remittance type; LSDU/Servicing Platform reconciled) and the **partner's UPB report** (their own book).
- **WebMB** (portal-only; shared GSE/Ginnie Mae application): `human_portal_task` with the schedules and the certification record; capture submission confirmation. Failure: submit by the alternate method WebMB support directs; document.
- **Bank/custodian statements** (BAI2/camt.053 via the `custodial-bank` and treasury adapters) for cash and securities evidence; **facility agent** confirmations for line availability.
- **Partner:** monthly subserviced-UPB report (by remittance type; loan counts) and quarterly eligibility summary; partner's decline-trigger events flow the other way when they affect Supermortgage (e.g., the partner's approval at risk → Section 17 contingency).

#### Outputs and artifacts
- Quarterly **Eligibility Certification** (`ELIG-CERT-Q-v1`: computations, sources, surplus/deficit, decline flags, officer signature), monthly partner UPB report (`ELIG-UPB-PARTNER-M-v1`), Form 1002/1002A packages, capital and liquidity plan (large), remediation plans; `eligibility_results`, `regulatory_filings`. No borrower notices, no ledger postings (GL-side entries live in the accounting system).

#### AI agent design (AI-first)
- **Agent:** `qc-audit` (financial-eligibility module) with `investor-reporting` (UPB) and `custodial-recon` (cash evidence). End-to-end: ingest GL and UPB → compute → compare to prior periods → produce the certification draft and variance commentary → assemble Form 1002 → escalate for CEO/CFO certification → portal task → track; monthly partner report; projections from the boarding pipeline.
- **Tools:** GL/UPB queries, calculator (config-driven), document renderer, `escalations.create`, `human_portal_task.create`.
- **Decision record:** `{entity, period_end, config_version, inputs_hash, results, variance_commentary, warnings, confidence}`.
- **Guardrails:** the agent never adjusts GL balances; every input is a hashed source document; classification of an asset as "eligible security" or "unrestricted cash" requires a source (custodial statement, facility agreement) or it is excluded; certifications are CEO/CFO acts (`officer`).
- **Escalations:** `officer` (certify; breach/warning notices; Form 1002 certification), `fnma_portal_operator` (WebMB), partner officer (partner filings), board (remediation plans).
- **AI-off path:** computation is deterministic; finance staff use the console.

#### Edge cases and failure modes
- **Quarter-end UPB not final** (late investor-reporting close): compute with the reconciled position and re-run on finalization; certification waits for the final figure if the difference exceeds 0.5% of UPB.
- **Depository partner:** capital per primary regulator; liquidity rules per A4-1-01 depository treatment; config branch.
- **Large-servicer threshold crossing** ($50B): buffer, plan, monthly 1002A, ratings timers activate from the quarter of crossing; ratings lead time 6–12 months → warning at $40B.
- **Servicing transfers in/out at quarter-end:** UPB as of the transfer effective date (first business day of the month; A2-7-03) — class assignment follows the reported position.
- **Advance line covenant breach:** committed-but-unavailable lines are excluded from allowable liquidity.
- **Fiscal year ≠ calendar year:** Form 1002 follows calendar quarters; AFS follows fiscal year.
- **Supermortgage acquires MSRs** (becomes a master servicer): UPB classes activate; liquidity requirements start that quarter.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 18.7-T1 | Given worked example 1 inputs, then `anw = 3_750_000_000¢`, `req_nw = 1_750_000_000¢`, `ratio_bps = 1250`, `allowable_liquidity = 1_100_000_000¢`, `required_liquidity = 385_000_000¢`, status `compliant`. |
| 18.7-T2 | Given worked example 2 inputs, then `nw_surplus = 80_000_000¢` (24.24% of requirement) and status `warning` with a 30-day remediation-plan timer. |
| 18.7-T3 | Given ANW falling 28% quarter-over-quarter with positive surplus, then status `breach` via `decline_flags.q_over_q_25` and partner/officer notices within 1 BD. |
| 18.7-T4 | Given Enterprise A/A UPB `123_456_789_00¢`, then required liquidity component = `round(12_345_678_900 × 35 / 100_000) = 4_320_988¢` (i.e., $43,209.88; exact value 4,320,987.615 rounds half-up to 4,320,988). |
| 18.7-T5 | Given quarter-end 2026-09-30, then Form 1002 is due 2026-10-30 (warning 2026-10-20); given Dec 31, due 2027-03-01. |
| 18.7-T6 | Given total UPB crossing $50B at 2027-06-30, then the buffer applies to the 2027-06-30 test, `FNMA_A4102_FORM1002A_M_30` starts for July, and the capital/liquidity plan timer targets 2028-03-30 (Dec 31, 2027 + 90 days = March 30, 2028). |
| 18.7-T7 | Given a GL close missing at BD5, then the monthly result is flagged `stale` and the quarterly certification cannot proceed. |
| 18.7-T8 | Given the agent attempts to mark the Form 1002 filing `submitted` without a WebMB confirmation and CEO/CFO certification record, then the transition is refused. |
| 18.7-T9 | Given Supermortgage holds zero Fannie Mae loans as of Dec 31, then `FNMA_A4101_SERVICE_ONE_LOAN_DEC31` breaches to `officer` (approval at risk). |

#### Audit and evidence
GL snapshots with source hashes, UPB positions reconciled to Section 5, computation records with config versions, officer certifications, WebMB/AFS submission confirmations, partner UPB reports and receipts, warning/breach notices, remediation plans — `corporate_7y`. Evidence for Fannie Mae eligibility reviews, state prudential-standards exams and partner counterparty due diligence.

### Open questions / decisions
1. **Accounting system and GL adapter** — default: CSV trial-balance export mapped by a versioned chart-of-accounts map; API later.
2. **Internal liquidity floor for a pure subservicer** — default: 30 days of projected advances (Section 5.4) plus operating cash, board-approved.
3. **ANW component definitions** — load from the Form 1002 instructions/FHFA definitions; treat capitalized software as intangible until confirmed.
4. **Partner data sharing** — default: partner computes its own eligibility from Supermortgage's monthly UPB report; Supermortgage offers the computation as a service.

### Sources
- Selling Guide A4-1-01 (08/05/2026): https://guide-selling.fanniemae.com/sel/a4-1-01/maintaining-sellerservicer-eligibility — verified 2026-09-09
- SEL-2026-07 (Aug. 5, 2026): https://singlefamily.fanniemae.com/media/document/pdf/announcement-sel-2026-07-selling-guide-updates — verified 2026-09-09
- Selling Guide A4-1-02 (05/01/2024) — as in 18.4
- Form 1002 page (WebMB): https://singlefamily.fanniemae.com/form-1002-mortgage-bankers-financial-reporting-form — verified 2026-09-09
- FHFA eligibility requirements and FAQs — research/00a §4.4 (verified 2026-09-09); CSBS prudential standards — research/00a §5.3
