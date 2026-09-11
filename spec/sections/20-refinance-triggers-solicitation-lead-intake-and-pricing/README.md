# Section 20 — Refinance triggers, solicitation, lead intake, and pricing

<!-- imported from the Origination build specification v1.0 (2026-09-11), section O1; process O1.M is 20.M here. tools/import_origination.py -->

## Overview

**Scope.** §20 is the front door of the origination platform: it decides *whom* to approach (20.1), *how* to approach them lawfully (20.2), *what* may be said and collected before an application exists (20.3), and *at what price* (20.4). Its output is a Reg B application and a TRID application with a dated anchor (`application.received`, `application.trid_received`), a priced and MLO-reviewed quote, a lead file with consents and identity evidence, and the fee items 21.2 needs to issue a Loan Estimate within three general business days. Everything in §20 happens before the creditor has an application, which is precisely why its rules are unusual: the Reg B line is crossed by the creditor's *response*, the TRID line by the *sixth item*, the SAFE Act line by the *presentation of particular terms*, and the TCPA line by the *artificial voice*.

**Processes.** 20.1 runs the "self-improving mortgage" trigger over the whole subserviced book daily — investor-blind, using transaction/experience data only — computes the borrower benefit (rate, payment, lifetime interest, same-term alternative, 84-month NPV, 7-year total cost) under the partner's economics (SM bears third-party costs, gain-on-sale recovers only those costs, the remainder lowers the borrower's rate; residual as a capped lender credit), and applies the Fannie Mae and state gates (cash-out seasoning, premium-recapture window, Massachusetts borrower's-interest test). 20.2 turns an opportunity into lawful touches: campaign/creative approval with Reg Z §1026.24, MAP Rule, CAN-SPAM, state and Fannie Mae B2-1.3-04 checklists; per-touch TCPA/TSR gating (prior express written consent for AI-voice/SMS marketing to cell phones and AI voice to landlines; national DNC with EBR or written permission; company DNC for five years; 31-day registry versions; quiet hours); a consent-evidence model layered on the servicing `consents` table. 20.3 runs the AI conversation under a disclosure-first rule (with Utah, California and Colorado overlays), authenticates, captures E-SIGN/TCPA/credit authorizations, gives information without ever communicating a prequalification decline, routes personalized terms through the MLO of record, and detects the six TRID items. 20.4 is the deterministic pricing engine: PE–Whole Loan best-efforts prices by note rate and lock period, the 09.09.2026 LLPA Matrix (Classic FICO and VantageScore 4.0 grid families, attribute rows, waivers, HomeReady credit), a fixed 25 bps retained servicing fee, the pass-through solve that converts price into the lowest cost-covering note rate, payment/MI/escrow/APR estimates, quote validity, the pre-LE written-estimate disclaimer, fee-schedule sourcing for LE accuracy, and no-discretion pricing with an exception log.

**Agents.** `intake` (20.1 trigger, 20.2 campaign orchestration, 20.3 conversation and conversion), `borrower-comms` (shared voice/SMS/chat execution and warm transfer), `pricing` (20.4), with `compliance-sentinel` (timers, fair-lending extracts, rule-version watch) and `security-records` (retention classes) shared. The deterministic parts (benefit math, gates, LLPA/price solve, TRID detector, consent gates) are code; the language model drafts explanations inside approved templates, classifies free text, and is barred from choosing rates, amounts, fire decisions, or decline language.

**Partner/SM boundary.** The partner is the creditor and Fannie Mae seller, the servicer of record and MSR owner, the "seller" for TCPA/TSR consents, the "sender" for CAN-SPAM, the advertiser whose NMLSR ID appears on every creative, the end user of every consumer report, the employer/sponsor of the MLO of record whose name and NMLSR ID appear on personalized terms and later on the 1003/LE/CD/note/security instrument, and the party whose PE–Whole Loan prices and commitments carry its seller number. SM operates everything as the partner's service provider (GLBA §1016.13 contract limits SM's use of servicing data to the partner's own program), Fannie Mae TSP (partner-scoped System IDs), telemarketer/caller on the partner's behalf, bearer of third-party costs and recipient of the 12.5 bps platform fee, and the subservicer whose data feeds the trigger. SM never markets its own products from the partner's servicing data.

**Dependencies.** Servicing spec: `loans`/`loan_terms`/`escrow_accounts`/`payments`/PMI data (2.x, 3.x, 10.x) as the trigger universe; `consents`, `consent_disclosure_versions`, `ESIGN_7001C_CONSENT_GATE` (7.4); `contacts`, `phone_numbers`, telephony adapter, `TCPA_64_1200_A1_CELL_CONSENT_GATE`, `TCPA_64_1200_A10_REVOCATION_HONOR_10BD` (11.1); authentication (4.x); annual privacy notice (7.x). Origination: 21.1 (1003 interview, demographic request, `NTC_SM_ESIGN_CONSENT`), 21.2 (`REGZ_1026_19E1_LE_3BD` anchored on `trid_application_date`; `fee_items`), 21.3 (companion notices incl. `NTC_GLBA_1016_4_PRIVACY_INITIAL`), 21.4 (locks from `pricing_quotes`), 21.5 (re-pricing), 21.6 (Reg B decisions; `NTC_CO_SB26_189_ADMT_NOTICE` and Colorado gates), 22.2 (tri-merge under one score model), 22.6 (identity L3/L4), 23.2 (DU HomeReady/ownership checks), 25.1 (APR engine), 27.2 (gain-on-sale reconciliation of forecast LLPAs and cost recovery), 29.1 (commitments from quote IDs), 29.3 (SFCs), 31.1 (licensing matrix), 31.2 (AI governance, fair-lending monitoring of triggers, touches, quotes and exceptions), 31.3 (retention classes `regn_1014_5_24m`, `sm_lead_36m`).

**Changes in flight that shape the build.** VantageScore 4.0 broad availability (LL-2026-06, Sept 9, 2026) with its own LLPA grids and SFC 067; the 09.09.2026 LLPA Matrix (no DTI or escrow-waiver LLPAs; HomeReady credit through Feb 28, 2027; bottom row "≤639"); SEL-2025-08's LCOR cash-back cap (greater of 1% or $2,000); DU 12.1's tightened credit-risk standards (fewer Approve/Eligible outcomes affect how the trigger's benefit is presented); Colorado SB 26-189 (pre-use notice for consequential decisions on/after Jan 1, 2027; ECOA-notice deemed compliance) replacing the 2024 AI Act; the Reg B April 2026 rule removing the effects test (federal), while state fair-lending and Fannie Mae expectations stand; the FCC revocation rule in force since April 11, 2025 and the vacated one-to-one consent rule; the pending FinCEN AML program rule (no CIP for RMLOs either way); the SFHDF form renewal (no effect on §20); and the unresolved partner term-sheet parameters (cost definitions, residual treatment, marketing rights) that 20.1/20.4 carry as configuration defaults marked [UNVERIFIED].

**What §20 does not do.** No consumer reports for selection (no prescreen by default), no preapproval program, no demographic collection, no document requests before the LE, no cash-out solicitation, no negotiation by the AI, no investor-aware logic anywhere in selection or creatives, and no promise of future refinance terms (B2-1.3-04).

## Processes

| Process | Title | Automation class |
|---|---|---|
| 20.1 | Portfolio rate monitoring and refinance-opportunity detection on the subserviced book (self-improving-mortgage trigger) | a |
| 20.2 | Solicitation, marketing, and consent compliance for outbound refinance offers and organic acquisition | a |
| 20.3 | Lead intake, identity, E-SIGN/TCPA consents, and the pre-qualification interview (pre-application boundary) | a |
| 20.4 | Rate quote and pricing engine (base pricing, LLPAs, servicing value, cost pass-through, fee schedule) | a |

## Closing

### Section-level test plan and sequencing

**Build order (inside Stage O-1/O-2 of the addendum).**
1. **20.4 tables and engine first** — `llpa_tables` (09.09.2026) with the two-reviewer verification log (second-home row and VantageScore 4.0 bands flagged until read page-by-page), loan-limit table, `sm_cost_schedules`, `fee_schedules`, the pass-through solver and payment/APR estimate (using 25.1's Appendix J engine or a stub with identical rounding), rate-sheet ingestion with the Browse Prices export before the Loan Pricing API is certified (TSP window 2–6 months). Property-based reproducibility tests and the fixture cases 20.4-T1/T2/T12 are the acceptance gate.
2. **20.1 trigger** — investor-blind view `v_refi_universe` with the column-allowlist static check, benefit metrics, gates (`FNMA_B2_1_3_03_*`, `FNMA_C1_1_01_PREMIUM_RECAPTURE_120`, `MA_183_28C_BORROWER_INTEREST_60M`), fair-lending extract to 31.2. Depends on servicing read replicas and the 20.4 engine.
3. **20.3 intake** — disclosure gate and state overlays, authentication levels, consent capture on the 7.4 mechanism with the new `origination_disclosures` scope, credit authorizations and the soft-pull adapter, the Reg B decline classifier, MLO review queue, and the TRID six-item detector emitting `application.received`/`application.trid_received` for 21.1/21.2.
4. **20.2 solicitation** — campaign/creative checklists, consent columns on `consents`, DNC scrub job and registry subscription, per-touch gates on the 11.1 telephony/SMS adapters, suppression handling and the MAP archive. Voice/SMS marketing ships last and only for states whose mini-TCPA/call-recording rules are loaded in `jurisdiction_rules`.

**Cross-process integration tests on the fixture calendar.**
- **O1-IT1 (refinance end-to-end).** Rate sheet published Thu Oct 1, 2026 06:35 ET → 20.1 run detects the $565,000/7.000% loan → candidate $560,000 at 6.125% (LLPA $700, costs $3,485, credit $700) → 20.2 email + portal card Fri Oct 2 (AI voice refused for lack of PEWC; human dial permitted under EBR) → PEWC captured Sat Oct 3 → borrower replies Mon Oct 5 08:40 MST → 20.3 disclosure, L2 login, soft pull (768), MLO review done 09:10, terms presented 09:11, income stated 09:31 → `application.trid_received` and `application.received` at 2026-10-05 09:31 MST → 21.2 LE due Thu Oct 8; 21.6 decision due Wed Nov 4; E-SIGN origination consent active 09:38 → intent to proceed Tue Oct 6, lock Wed Oct 7 at 6.125%/45 days from `pricing_quotes` → consummation Fri Nov 6, disbursement Thu Nov 12 (prepaid interest 19 days = $1,785.43; cash to borrower $3,941.28 ≤ $5,600 cap) → Purchase Ready Thu Nov 19 with the 09.09.2026 matrix; 27.2 reconciles the $700 LLPA and $3,485 cost recovery against the Purchase Advice.
- **O1-IT2 (purchase with HomeReady).** Organic lead Thu Oct 15 (no property) → prequal letter (not a preapproval; no HMDA record) → property Mon Oct 19 09:30 ET → six items → LE due Thu Oct 22 → quote 6.375% with the HomeReady waiver (P&I $2,570.34; BPMI $199.13) vs 6.750% without → closing Wed Nov 18, funding Wed Nov 18 (OH wet) → Purchase Ready Mon Dec 7 (very-low-income credit not applicable).
- **O1-IT3 (revocation and DNC propagation).** STOP text Tue Oct 6 13:02 MST → revocation committed < 60 s, one confirmation text, no further SMS; company DNC email the same day → `honor_until` 2031-10-06; the 20.1 request path still works for a borrower-initiated call; the 20.2 human dial is refused (EBR terminated).
- **O1-IT4 (cash-out seasoning).** Existing note date Thu Nov 20, 2025; request Mon Oct 5, 2026 → cash-out blocked for a Nov 6 consummation; LCOR offered; cash-out eligible for consummation ≥ Nov 20, 2026 with rescission ending midnight Tue Nov 24 and disbursement Wed Nov 25 (Thanksgiving Nov 26 not in the period).
- **O1-IT5 (Colorado cutover).** Same flows on Tue Jan 5, 2027 for a Denver property: pre-use notice line before any pricing output; 21.6 gate satisfied; records retained 3 years.
- **O1-IT6 (rate-sheet supersession).** Sheet republished at 11:00 ET after a 25 bps move: presented quotes `superseded`, the 20.3 conversation re-quotes with the change explained, 20.2 rate-bearing creatives expire, 20.1 ad-hoc run executes.
- **O1-IT7 (investor blindness).** A test build injecting `investor_id` into the trigger rule set or `investor_name` into a creative template fails CI; regex scans of rendered creatives for "Fannie", "MBS", pool numbers pass.
- **O1-IT8 (GLBA use test).** A job attempting to read servicing NPI for a program whose product owner is not the partner fails at `loadUniverse` with `glba_use_violation`.

**Data fixtures needed.** Servicing loans: the $565,000/7.000%/Sept 18, 2024 loan (UPB $553,106.41 after Oct 1, 2026; escrowed; no MI; Phoenix AZ; investor field populated but hidden), a Fannie Mae-purchased loan with `fnma_purchase_date` 2026-08-20, a Massachusetts loan consummated 2023-02-06, a loan with note date 2025-11-20; parties with `esign` (servicing scope) and informational `tcpa_voice` consents, one with marketing PEWC, one on the national DNC with EBR, one company-DNC; rate sheets for Oct 1, Oct 5, Oct 7 and Oct 19, 2026 (illustrative prices in 20.4 examples A/B); `llpa_tables` 09.09.2026 with verification flags; `sm_cost_schedules` AZ/LCOR/hybrid ($3,485) and OH/purchase/traditional ($2,774); AMI data for Maricopa and Franklin counties; holiday calendar 2026–2027 (Columbus Day Oct 12, Veterans Day Nov 11, Thanksgiving Nov 26, Christmas Dec 25, New Year's Day observed Jan 1, 2027); time zones America/Phoenix and America/New_York; Colorado/Utah/California consumer records; a VantageScore 4.0 tri-merge (771) and a Classic FICO tri-merge (758) for band-change tests.

### Section open questions

1. (20.1-1) Is the "self-improving mortgage" a promise? Default: a standing program, never a contractual right or special terms (B2-1.3-04 prearranged-agreement risk); counsel and the partner's Fannie Mae account team to confirm the marketing language.
2. (20.1-2) Benefit floor. Default: 25 bps, positive 84-month NPV and positive 7-year total cost; same-term option always presented.
3. (20.1-3 / 20.2-4) SM marketing its own products from servicing data. Default: prohibited (GLBA §1016.11(d)/§1016.13 contract); requires a partner notice change and a §1016.10 opt-out program to revisit.
4. (20.1-4 / 20.4-1) Residual premium above third-party costs. Default: lender credit capped at 12.5 bps, remainder retained by SM — term sheet [UNVERIFIED].
5. (20.1-5) Value source for benefit modelling. Default: indexed origination value; AVM optional; never for underwriting.
6. (20.1-6) Delinquent ≤ 30 days. Default: excluded from proactive solicitation; request path allowed.
7. (20.2-1) Voice-recorded PEWC. Default: interim only, written confirmation within 24 hours.
8. (20.2-2) Human click-to-dial marketing. Default: yes, EBR customers only, gate-passing numbers, MLO-team staff.
9. (20.2-3) FCRA prescreening. Default: off.
10. (20.2-4) State mini-TCPA/call-recording matrix. Default: no SMS/AI-voice marketing in FL/OK/WA and two-party-consent states until verified.
11. (20.2-5) Sunday/holiday voice and SMS. Default: none.
12. (20.3-1) Does the soft-pull SSN authorization count toward the TRID six items? Default: yes (conservative; earlier LE clock).
13. (20.3-2) Reg C preapproval program for purchases. Default: no; prequalification letters only.
14. (20.3-3) MLO review of personalized pre-application quotes. Default: required (`origination.ai_mlo_intake=assisted`, 1-business-hour SLA).
15. (20.3-4) Colorado pre-use notice start. Default: Dec 1, 2026 for all Colorado consumers.
16. (20.3-5) Video intake and HMDA "in person." Default: treated as telephone/internet.
17. (20.3-6) Lead retention. Default: 90-day inactivity expiry; consents kept; soft-pull data deleted absent an application.
18. (20.4-2) LE/CD treatment of SM-paid third-party costs. Default: "Paid by Others" on the CD, not imposed on the consumer on the LE — 21.2/25.2 to confirm; alternative: fees plus an offsetting general lender credit.
19. (20.4-3) Servicing fee and buy-up/buy-down for whole loans. Default: 25 bps retained, no buy-up/buy-down until verified with Fannie Mae Capital Markets.
20. (20.4-4) Prepaid-interest day count. Default: 365; confirm partner closing policy.
21. (20.4-5) LLPA matrix change between lock and Purchase Ready. Default: borrower's locked price honored; delta absorbed per term sheet.
22. (20.4-6) Escrow-waiver rate-sheet adjustment. Default: none; any addition needs fair-lending review.
23. (Section) Partner term-sheet parameters (cost definitions, platform-fee payer, marketing rights, exclusivity) are configuration defaults until the executed document is filed in the project.

### Section sources

- Fannie Mae Selling Guide B2-1.3-04, Prohibited Refinancing Practices (08/04/2021): https://selling-guide.fanniemae.com/sel/b2-1.3-04/prohibited-refinancing-practices — verified 2026-09-10.
- Fannie Mae Selling Guide B2-1.3-02, Limited Cash-Out Refinance Transactions (10/08/2025): https://selling-guide.fanniemae.com/sel/b2-1.3-02/limited-cash-out-refinance-transactions — verified 2026-09-10.
- Fannie Mae Announcement SEL-2025-08 (10/08/2025): https://singlefamily.fanniemae.com/media/document/pdf/announcement-sel-2025-08-selling-guide-updates — verified 2026-09-10.
- Fannie Mae Selling Guide B2-1.3-03, Cash-Out Refinance Transactions (12/10/2025): https://selling-guide.fanniemae.com/sel/b2-1.3-03/cash-out-refinance-transactions — via 00a-fnma §4.3, 2026-09-10.
- Fannie Mae Selling Guide A3-2-02, Responsible Lending Practices (09/01/2021): https://selling-guide.fanniemae.com/sel/a3-2-02/responsible-lending-practices — verified 2026-09-10.
- Fannie Mae Selling Guide B5-7-01 (08/06/2025): https://selling-guide.fanniemae.com/sel/b5-7-01/high-ltv-refinance-loan-and-borrower-eligibility — verified 2026-09-10.
- Fannie Mae Servicing Guide A2-2-01, Refinance and Lending Practices (02/14/2018): https://servicing-guide.fanniemae.com/svc/a2-2-01/refinance-and-lending-practices — verified 2026-09-10 (cross-reference only).
- Fannie Mae Servicing Guide A2-3-02, Servicing Fees for Portfolio and MBS Mortgage Loans (07/13/2022): https://servicing-guide.fanniemae.com/svc/a2-3-02/servicing-fees-portfolio-and-mbs-mortgage-loans — verified 2026-09-10.
- Fannie Mae Selling Guide C1-1-01, Execution Options (02/05/2025): https://selling-guide.fanniemae.com/sel/c1-1-01/execution-options — verified 2026-09-10.
- Fannie Mae Selling Guide C2-1.1-02 (06/07/2023): https://selling-guide.fanniemae.com/sel/c2-1.1-02/general-information-about-mandatory-commitment-pricing-and-fees — verified 2026-09-10.
- Fannie Mae Selling Guide C2-1.1-03 (07/05/2023): https://selling-guide.fanniemae.com/sel/c2-1.1-03/mandatory-commitment-terms-amounts-periods-and-other-requirements — verified 2026-09-10.
- Fannie Mae Selling Guide C2-1.2-02 (03/03/2021) — 00a-fnma §5.3, 2026-09-10.
- Fannie Mae LLPA Matrix (09.09.2026): https://singlefamily.fanniemae.com/media/9391/display — verified 2026-09-10.
- Fannie Mae Special Feature Codes (09.09.2026): https://singlefamily.fanniemae.com/media/8131/display — 00a-fnma §5.2, 2026-09-10.
- Fannie Mae LL-2026-06, VantageScore 4.0 Broad Lender Availability (09/09/2026): https://singlefamily.fanniemae.com/media/48071/display — 00a-fnma §1, 2026-09-10.
- Fannie Mae Eligibility Matrix (DU 12.1, eff. 08/05/2026): https://singlefamily.fanniemae.com/media/20786/display — 00a-fnma §4.1 (partial).
- Fannie Mae Loan Limits 2026 (LL-2025-04): https://singlefamily.fanniemae.com/originating-underwriting/loan-limits — 00a-fnma §4.2.
- Fannie Mae Selling Guide B3-5.1-02 (04/22/2026), B5-6-01 (06/04/2025), B7-1-02 (08/07/2019) — 00a-fnma §2.2, §4.11, §4.16.
- Fannie Mae PE–Whole Loan FAQs: https://singlefamily.fanniemae.com/learning-center/pricing-execution/faqs-pricing-execution-whole-loan — verified 2026-09-10.
- Fannie Mae Loan Pricing and Committing API: https://singlefamily.fanniemae.com/applications-technology/application-programming-interfaces-apis/loan-pricing-committing-api — 00b-orig F7; Loan Lookup API and AMI Lookup/HomeReady Evaluation API — 00b-orig F11, 2026-09-10.
- 12 CFR 1016 Subpart C (eCFR up to date as of 9/02/2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1016/subpart-C ; §1016.11 (CFPB eRegs): https://www.consumerfinance.gov/rules-policy/regulations/1016/11/ — verified 2026-09-10; §1016.4 — 00a-fed §14.
- 12 CFR 1022.21 (CFPB eRegs): https://www.consumerfinance.gov/rules-policy/regulations/1022/21/ — verified 2026-09-10.
- 15 U.S.C. 1681a (current through Sept 9, 2026): https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section1681a&num=0&edition=prelim — verified 2026-09-10; 1681b, 1681c-1, 1681g, 1681m — 00a-fed §7.
- 16 CFR 642 (eCFR up to date as of 8/20/2026): https://www.ecfr.gov/current/title-16/chapter-I/subchapter-F/part-642 — verified 2026-09-10.
- 12 U.S.C. 5531 (current through Sept 9, 2026): https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title12-section5531&num=0&edition=prelim — verified 2026-09-10.
- M.G.L. c.183 §28C: https://malegislature.gov/Laws/GeneralLaws/PartII/TitleI/Chapter183/Section28C — verified 2026-09-10 (currency not shown).
- 47 CFR 64.1200 (eCFR up to date as of 9/08/2026): https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200 — verified 2026-09-10.
- FCC 24-17 (Feb 8, 2024): https://docs.fcc.gov/public/attachments/FCC-24-17A1.txt ; 89 FR 15756 (Mar 5, 2024): https://www.federalregister.gov/documents/2024/03/05/2024-04587/strengthening-the-ability-of-consumers-to-stop-robocalls ; Insurance Marketing Coalition v. FCC (11th Cir. Jan 24, 2025): https://law.justia.com/cases/federal/appellate-courts/ca11/24-10277/24-10277-2025-01-24.html — 00a-fed §13.7, 2026-09-10.
- 16 CFR 310.2 and 310.4 (eCFR up to date as of 9/08/2026): https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.2 ; https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.4 — verified 2026-09-10.
- 15 U.S.C. 7704 (current through Sept 8, 2026): https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section7704&num=0&edition=prelim — verified 2026-09-10.
- 12 CFR 1014 (eCFR up to date as of 9/08/2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1014 — verified 2026-09-10.
- 12 CFR 1026.24 (eCFR up to date as of 9/08/2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-C/section-1026.24 — verified 2026-09-10.
- 12 CFR 1026.2 and Official Interpretations 2(a)(2), 2(a)(3) (CFPB eRegs): https://www.consumerfinance.gov/rules-policy/regulations/1026/2/ — verified 2026-09-10.
- 12 CFR 1026.19(e)(2)(ii)–(iii) (eCFR up to date as of 9/08/2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-C/section-1026.19 — verified 2026-09-10.
- 12 CFR 1026.17 (eCFR up to date as of 9/04/2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-C/section-1026.17 — verified 2026-09-10.
- 12 CFR 1026.36(d)/(g), 12 CFR 1008.103 and Appendix A to Part 1008 (eCFR 9/08/2026) — 00a-fed §12.
- Reg B §1002.2, .4, .5, .9, .12, .13 (CFPB eRegs): https://www.consumerfinance.gov/rules-policy/regulations/1002/2/ — verified 2026-09-10; Reg B final rule 91 FR 21620 (Apr 22, 2026) — 00a-fed §3.8.
- 12 CFR 1003.2 (eCFR up to date as of 9/08/2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1003/section-1003.2 — verified 2026-09-10; Appendix B — 00a-fed §4.5.
- 15 U.S.C. 7001 (current through Sept 8, 2026): https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section7001&num=0&edition=prelim — verified 2026-09-10.
- 31 CFR 1029 (CIP reserved) and 16 CFR 681 (Red Flags) — 00a-fed §9, §7.
- Colorado SB 26-189 signed act (05/14/2026): https://leg.colorado.gov/bill_files/116489/download ; bill page: https://leg.colorado.gov/bills/sb26-189 — verified 2026-09-10.
- Utah AI Policy Act as amended by S.B. 226 (2025) — Davis Polk client update (Apr 4, 2025): https://www.davispolk.com/insights/client-update/utah-scales-back-reach-generative-ai-consumer-protection-law — PARTIALLY VERIFIED 2026-09-10.
- California CPPA ADMT regulations (approved text): https://cppa.ca.gov/regulations/pdf/ccpa_updates_cyber_risk_admt_appr_text.pdf — PARTIALLY VERIFIED 2026-09-10.
- COMAR 09.03.06.06 (Justia mirror): https://regulations.justia.com/states/maryland/title-09/subtitle-03/chapter-09-03-06/section-09-03-06-06/ — PARTIALLY VERIFIED 2026-09-10.
- N.J.A.C. 3:15-8.3 (Justia mirror): https://regulations.justia.com/states/new-jersey/title-3/chapter-15/subchapter-8/section-3-15-8-3/ — PARTIALLY VERIFIED 2026-09-10.
- Servicing spec 7.4 (E-SIGN/consents), 11.1 (TCPA gates, telephony, RND), 4.x (authentication), 7.x (privacy notices), 3.1 (initial escrow) — project docs, verified 2026-09-09.
- Architecture baseline (v0.1, 2026-09-09) and origination addendum (v0.1, 2026-09-10); research digests 00a-fed, 00a-fnma, 00b-orig (2026-09-10).
