# 13.5 — Allowable timeframes / compensatory fees

| Attribute | Value |
|---|---|
| Section | 13 — Foreclosure |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | During foreclosure |
| Governing source | FNMA E-3.2-15; A1-4.2-02 |
| Key deadlines | Per state allowable timeline; no compensatory fee for delays beyond servicer control if status codes timely/accurate |
| Timers | `FNMA_A14202_RESCISSION_FEE_EXPOSURE`, `FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE`, `FNMA_E3215_TIMEFRAME_WARNING_70`, `FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE`, `FNMA_F121_STATUS_CODE_TIMELY_BD2`, `SM_COMP_FEE_BILL_REBUTTAL_30`, `SM_EXHIBIT_WATCH_MONTHLY` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Foreclosure |
| Trigger & frequency | During foreclosure |
| Governing source (blueprint) | FNMA E-3.2-15; A1-4.2-02 |
| Key deadlines (blueprint) | Per state allowable timeline; no compensatory fee for delays beyond servicer control if status codes timely/accurate |
| Data/artifacts | Timeline tracking |
| Systems | Core |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — read as Sub tracks/prevents; Partner pays any fee billed by Fannie Mae and recovers contractually |
| Nuances (blueprint) | "STATE-DEPENDENT (judicial vs non-judicial)" [partially cropped in source] — reconstructed: the allowable days are a per-jurisdiction table (judicial vs non-judicial method, NYC separate) measured from the LPI due date to the sale; allowable-delay credits by status code (bankruptcy by chapter, probate, military indulgence, contested, TPP, forbearance, COVID); fee = UPB × PTR/365 × excess days; since 2019 billed only after a chronic issue and a failed performance improvement plan; $1,000 rescission fee; the exhibit is effective for sales on/after July 1, 2025 (LL-2025-01) |

### Verified requirement (as of 2026-09-09)

**E-3.2-15, Allowable Time Frames for Completing Foreclosure (07/09/2025, SVC-2025-04 — verified today).** "The maximum number of allowable days denotes the maximum allowable time lapse between the due date of the LPI and the completion of the foreclosure sale"; it "represents the time typically required for routine, uncontested foreclosure proceedings" and "reflects the legal requirements of the applicable jurisdiction." The table lives in the **Foreclosure Time Frames and Compensatory Fee Allowable Delays** exhibit. "Fannie Mae will not impose compensatory fees for delays beyond the control of the servicer, provided that the delinquency status codes and any other information reported by the servicer on the loan are timely and accurate." "If the number of actual days to complete the foreclosure proceedings exceeds the maximum number of allowable days, and no reasonable explanation for the delay is provided to Fannie Mae through monthly delinquency status reporting or other information exchange protocols, Fannie Mae will require the servicer to pay a compensatory fee." Allowable delays named: "Bankruptcy; probate; military indulgence; contested foreclosure; the mortgage loan is currently in review for modification; active workout option; legislative/judicial changes to foreclosure laws (if servicer diligently works toward resolution); forbearance; or COVID-19 Foreclosure Moratorium participation."

**Exhibit (dated 06.18.25; "Effective for mortgage loans with a foreclosure sale date on or after July 1, 2025" — verified today).** Maximum allowable days (preferred method): CA 600 (non-judicial); TX 480 (NJ); FL 720 (J); NY 1,740 (J), NYC 2,190 (J); NJ 810 (J); IL 720 (J); PA 780 (J); MA 810 (J); GA 480 (NJ); AZ 450 (NJ); CO 540 (NJ); OH 690 (J); WA 630 (NJ); MI 390 (NJ); NV 750 (NJ); MD 780 (NJ); CT 780 (J); NC 690 (NJ); VA 450 (NJ); MN 420 (NJ). Allowable delays (credit for actual days up to the cap): Chapter 7 **80** per filing (codes 3L/65); Chapters 11/12/13 **125** per filing (66; 59; 67/69); probate **120** first occurrence (31); military indulgence **455** first occurrence (32); contested/litigated **90** first occurrence (33); workout in review **60** per workout only for LPI before 06/01/12 (H5) — "No credit will be given" otherwise; Trial Period Plan **120** per workout (BF); New Jersey 2010–2012 delays 180 (43); COVID moratorium **670** (3/1/2020 or LPI, whichever later, to 12/31/2021); forbearance **360** (09); COVID forbearance **540** (09 + reason 22; plans starting 3/1/2020–2/28/2021). Method: the table gives "the preferred method of foreclosure for each jurisdiction"; "Fannie Mae's Regional Counsel must approve the use of a different methodology prior to foreclosure initiation" via Form 20 (Oregon judicial exception). No redemption/confirmation text in the exhibit. **[Note: title-issue (BE) and mediation (BG) status codes exist in F-1-21 but carry no listed day credit in the exhibit — "legislative/judicial changes" and "reasonable explanation" are the avenue.]**

**A1-4.2-02, Compensatory Fees for Delays in the Liquidation Process (02/13/2019, SVC-2019-01 — verified today).** "Compensatory fees will be applied based on the UPB of the mortgage loan, the applicable PTR, the length of the delay, and any additional costs that are directly attributable to the delay." Step 1: days from the LPI date through the foreclosure sale date versus the allowable time frame; Step 2: "The compensatory fee for each mortgage loan will be calculated using the UPB of the mortgage loan, the applicable PTR, and the number of days the mortgage loan exceeded the allowable time frame." "Delays due to urgent or unforeseeable circumstances or for situations in which applicable law necessitates additional time may also be considered; however, such circumstances should be rare." Since Jan. 1, 2019 sale dates: "compensatory fees will be assessed if, after identification of a chronic issue with a servicer's compliance with foreclosure time frames, the servicer does not meet the terms of a performance improvement plan" (A1-1-03); "A compensatory fee bill will be issued only for those servicers identified as having a chronic issue ... and only after the completion of a performance improvement plan." Exemptions "based upon the number of mortgage loans serviced as well as the number of mortgage loans in excess of Fannie Mae's allowable foreclosure time frame" (STAR inclusion criteria; numbers not stated). Rescission: "a compensatory fee of $1,000 for internal administrative costs plus any third-party costs if the servicer must rescind a foreclosure sale due to the servicer's failure to follow Fannie Mae guidelines or other servicer error or alleged error." "Fannie Mae has the right to rely on the delinquent mortgage loan status data submitted by the servicer as definitively and conclusively reflecting the status of a mortgage loan" and "may choose to reject any information provided by the servicer to support a status code that is different from the one reported." No appeal deadline appears in the topic **[UNVERIFIED — rebuttal mechanics live in the STAR/performance-management process]**.

**F-2-03, Compensatory Fee Calculation Examples (07/09/2025 — verified today).** Formula "UPB x (Daily PTR/365) x Number of Days Delayed". Example 1 (Florida): UPB $100,000, PTR 4.75%, LPI Feb. 1, 2023, sale Oct. 14, 2025 → 986 days vs 720 allowable, 0 delays → 266 excess days → $100,000 × (0.0475/365) × 266 = **$3,461.64** (reproduced exactly by the calculator below). Example 2 (Colorado): UPB $200,000, PTR 5.25%, LPI Oct. 1, 2024, sale Dec. 2, 2025 → 427 days vs 540 + 30 allowable delay → 143 days ahead → no fee.

**Related.** E-3.3-02: cancellation-driven delays (uncertified sale) "will subject the servicer to compensatory fees." E-3.2-05: late bidding instructions ⇒ no reimbursement of continuance costs. E-3.2-13: title-insurer delays do not excuse compensatory fees. E-1.1-02: missing referral documents ⇒ remedies incl. compensatory fees. LL-2025-01 (Apr. 9, 2025) revised 22 jurisdictions' time frames and the delay caps; the 06.18.25 exhibit is the current source (research/00a §3.6). Fannie Mae relies on the **delinquency status codes** (F-1-21, 10/11/2023): 43 referred, 71 sale scheduled, 94 judgment, 95 sale delayed, 33 contested, 31 probate, 32 military indulgence, BE title, BG mediation, 65/66/67/69/59/3L bankruptcy, BF TPP, 09 forbearance, 12 repayment, H5 complete BRP (5.4).

**Discrepancies with the blueprint row.** (1) The clock starts at the **LPI due date**, not at referral — pre-referral time (120+ days, prereferral review, state notices) consumes the allowance. (2) Fees are assessed only after a chronic-issue finding and a failed performance improvement plan (2019 policy) — the platform tracks *exposure*, not an accrual. (3) The delay credits are code-driven with per-category caps; "workout in review" earns no credit for post-2012 LPIs. (4) The $1,000 rescission fee and the reliance-on-reported-status rule are absent. (5) Preferred-method deviations need Regional Counsel approval via Form 20.

### Operational prerequisites
- Exhibit loaded into `jurisdiction_rules.foreclosure.allowable_days` (all 50 states + DC + PR/VI/GU as published; NYC counties flagged) with `exhibit_version="2025-06-18"` and `effective_sales_on_or_after=2025-07-01`; prior version retained for sales before that date; a `compliance-sentinel` watch on the exhibit URL and LL announcements.
- Delay-credit table (`comp_fee_delay_rules`) with caps, code mappings and occurrence rules (first occurrence vs per filing/workout).
- 5.4 delinquency status reporting live (AMN/Servicing Platform) with the code hierarchy and effective/completion dates; status-code accuracy QC (8.x/5.4).
- Pass-through rate and UPB available per loan (5.x boarding fields); remittance type.
- Partner agreement: allocation of any compensatory fee/rescission fee (default: Supermortgage bears fees caused by its delays; partner bears those caused by its own acts).

### Build spec
#### Inputs and triggers
- `foreclosure.referral.sent` (starts tracking; LPI from `loans.lpi_due_date`), all milestone events (13.3), `foreclosure.sale.held` (ends the clock), `foreclosure.sale.rescinded` (reopens).
- Delay-credit events: `bankruptcy.petition.filed/dismissed/discharged/relief` (chapter), `probate.opened/closed`, `scra.stay.granted/ended`, `foreclosure.contested.opened/resolved`, `lossmit.trial.started/ended`, `lossmit.forbearance.started/ended`, `foreclosure.mediation.referred/completed`, `title.issue.opened/resolved`, `disaster.*`, `litigation.hold.*`.
- 5.4 reporting acknowledgments (`investor_events{delinquency.status}` accepted/rejected) — a credit is only "earned" if the code was reported timely and accepted.
- Monthly `comp_fee.exposure.snapshot` job (BD3) and on-demand recompute.

#### Data model
- `fc_timeframe_tracking` (new; one row per foreclosure case): `case_id`, `loan_id`, `state`, `nyc bool`, `method_used`, `method_preferred`, `method_deviation_form20_id?`, `lpi_due_date`, `allowable_days`, `exhibit_version`, `referral_sent_at`, `first_notice_filed_at?`, `sale_held_at?`, `actual_days?`, `credited_delay_days`, `excess_days`, `exposure_cents`, `exposure_as_of`, `status` ∈ {tracking, at_risk_70pct, over_allowable, closed_within, closed_over, closed_other}.
- `fc_delay_credits` (new; append-only): `case_id`, `category` ∈ {bk7, bk11, bk12, bk13, probate, military_indulgence, contested, workout_review_pre2012, tpp, nj_2010_2012, covid_moratorium, forbearance, forbearance_covid, legislative_judicial, other_reasonable}, `status_code_reported`, `begin_on`, `end_on?`, `actual_days`, `cap_days`, `credited_days`, `reported_timely bool`, `report_ack_id?`, `evidence_ids[]`.
- `comp_fee_delay_rules` (new; versioned): `category`, `cap_days`, `cap_scope` ∈ {per_filing, first_occurrence, per_workout, total}, `status_codes[]`, `conditions jsonb`, `exhibit_version`.
- `comp_fee_bills` (new): `bill_id`, `period`, `fnma_reference`, `loan_id`, `days_billed`, `upb_cents`, `ptr`, `amount_cents`, `received_at`, `rebuttal_status`, `rebuttal_document_id?`, `allocation` ∈ {supermortgage, partner, shared}, `paid_at?`.
- `jurisdiction_rules.foreclosure.allowable_days` (from 13.3 schema): `{days, method, nyc_days?, exhibit_version, effective_sales_on_or_after}`.
- Retention `life_of_loan_plus_4y`; no PII.

#### State machine
`fc_timeframe_tracking.status`: `tracking` (from referral; days elapsed since LPI) → `at_risk_70pct` (elapsed ≥ 0.7 × (allowable + credited)) → `over_allowable` (elapsed > allowable + credited) → terminal `closed_within` / `closed_over` on `foreclosure.sale.held`, or `closed_other` (reinstated, workout, payoff, charge-off, transfer-out, rescinded→reopens to `tracking`). Delay credits open/close by events and are re-scored nightly for cap application and reporting status. Only the engine transitions; `human_agent`/`officer` may add an `other_reasonable` credit with evidence for rebuttal purposes (never affects Fannie Mae's calculation, only the exposure estimate).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_E3215_ALLOWABLE_TIMEFRAME_STATE` | deadline | `foreclosure.referral.sent` | `lpi_due_date` | + `allowable_days` (jurisdiction_overrides: per state; NYC 2,190; extended by `credited_delay_days` as credits accrue) calendar_days | `foreclosure.sale.held` | `status=over_allowable`; sev 2 → `foreclosure-ops` root cause; Compliance Sentinel report; `officer` monthly |
| `FNMA_E3215_TIMEFRAME_WARNING_70` | warning | same | same | 70% elapsed | — | firm status demand (13.6) |
| `FNMA_F121_STATUS_CODE_TIMELY_BD2` | deadline (5.4) | month-end status change | period end | BD2 (legacy) / 03:00 ET next BD (event mode, 2027) | accepted status event | credit marked `reported_timely=false` |
| `FNMA_A14202_RESCISSION_FEE_EXPOSURE` | informational | `foreclosure.sale.rescinded{cause=servicer_error}` | — | — | — | $1,000 + third-party costs booked as exposure |
| `FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE` | not_before_gate | firm proposes a non-preferred method | — | until `form20.response{approved}` (13.7) | Regional Counsel approval | referral/first notice refused for that method |
| `SM_COMP_FEE_BILL_REBUTTAL_30` | deadline (policy) | `comp_fee_bills.received` | receipt | +30 calendar_days **[UNVERIFIED Fannie Mae window]** | rebuttal submitted or bill accepted | `officer` |
| `SM_EXHIBIT_WATCH_MONTHLY` | recurring | — | — | monthly (second Wednesday + LL feed) | exhibit hash unchanged/changed | new `exhibit_version` loaded, rules re-versioned |

#### Business rules and calculations
1. **Actual days** = `sale_held_at − lpi_due_date` in calendar days (no +1; matches F-2-03: Feb. 1, 2023 → Oct. 14, 2025 = 986). The LPI due date is the due date of the last *paid* installment — i.e., the earliest unpaid due date minus one payment period; the platform stores it directly (`loans.lpi_due_date`) and reconciles to the reported LPI in 5.x.
2. **Credited days** per category = min(actual days in the category window, cap) subject to scope (per filing / first occurrence / per workout / total) and to `reported_timely=true` (the corresponding status code accepted for the months the condition existed; F-1-21 hierarchy governs which code shows when several apply — the engine keeps the underlying condition record even when a higher-priority code was reported, and flags "credit at risk" when the reported code differs from the condition).
3. **Excess days** = max(0, actual − allowable − Σ credited). **Exposure** = round_half_up(UPB × PTR ÷ 365 × excess, cents) using `decimal.js` (UPB as of the exposure date — Fannie Mae's UPB basis date is not stated in A1-4.2-02 **[UNVERIFIED]**; default: UPB at LPI, which is constant through the delinquency).
4. **Worked example (platform).** NJ judicial; allowable 810; LPI due May 1, 2024; sale Jan. 19, 2027 ⇒ actual **993** days. Delays: Chapter 13 filed Sept. 3, 2025, dismissed Jan. 21, 2026 (140 actual days; cap 125 ⇒ 125 credited; code 67 reported Sept.–Jan., accepted); contested foreclosure Mar. 2–Apr. 11, 2026 (40 days; cap 90 ⇒ 40; code 33 reported). Credited = 165; excess = 993 − 810 − 165 = **18**. UPB $310,000; PTR 5.50% ⇒ per-diem = 310,000 × 0.055 / 365 = $46.7123…; exposure = 46.7123 × 18 = **$840.82**. Verification of F-2-03 Example 1 with the same code: 100,000 × 0.0475 / 365 × 266 = **$3,461.64** ✔; Example 2: 427 − 540 − 30 < 0 ⇒ $0 ✔.
5. **Projected exposure** (open cases): use today's date as a provisional sale date plus the firm's forecast sale date; both shown on the dashboard.
6. **Preferred method**: `method_used ≠ method_preferred` requires a Form 20 approval before initiation (except Oregon judicial); otherwise the allowable days of the preferred method still apply (exposure computed on the preferred figure).
7. **Attribution**: each `over_allowable` case gets a root-cause classification (servicer-caused: late referral, late documents, late bids, uncertified sale, missed DMDC; firm-caused; court/legal; borrower/protected) feeding 13.6 scorecards and the partner allocation (`comp_fee_bills.allocation`).
8. **NYC**: `properties.county` ∈ {Bronx, Kings, New York, Queens, Richmond} ⇒ 2,190 days; rest of NY 1,740.

#### Integrations
- **Fannie Mae reporting (5.4)**: consumes the status-code stream and acknowledgments; corrections through the AMN CD10/CD11 window (legacy) or event corrections (2027) — an unaccepted or late code marks the credit at risk.
- **DRA (read-only; 13.6)**: attorney-reported milestones are the second source for "contested", "mediation", "sale postponed" windows; discrepancies produce a reconciliation task before month-end reporting.
- **Fannie Mae Connect / STAR reports** (`fnma-connect`): pull the foreclosure time-frame performance reports and any compensatory-fee bill files (report names to be confirmed at onboarding **[UNVERIFIED]**); bills ingested into `comp_fee_bills`.
- **Attorney network**: monthly status demand on `at_risk_70pct` cases; firm forecast sale dates.
- Failure: missing PTR/UPB ⇒ exposure `null` with a data-quality alert; exhibit fetch failure ⇒ keep current version and alert.

#### Outputs and artifacts
- Events: `fc.timeframe.at_risk`, `fc.timeframe.exceeded{excess_days}`, `fc.delay_credit.opened/closed/at_risk`, `comp_fee.exposure.updated`, `comp_fee.bill.received/rebutted/paid`.
- Documents: monthly exposure report (per state, per firm, per root cause), rebuttal package (timeline, status-code history with acknowledgments, evidence of delays), method-deviation Form 20 (13.7).
- Ledger: no accrual until billed; on bill: `comp_fee_expense` (Supermortgage or partner per allocation) ↔ `fnma_payable`; paid via the Fannie Mae draft/invoice mechanism (5.x/15.2 **[UNVERIFIED channel]**).
- Investor events: none beyond 5.4 status codes; the exposure is internal.

#### AI agent design (AI-first)
`foreclosure-ops` computes exposure deterministically; the model classifies root causes from milestone narratives and firm correspondence, drafts firm status demands and Fannie Mae rebuttals, and reconciles DRA vs internal milestones. Tools: `fc.timeframe.get`, `status.history.get`, `dra.snapshot.get`, `attorney.instruction.send`, `documents.bundle`, `fnma_connect.report.pull`. Decision record: `{case_id, actual_days, allowable, credits[], excess, exposure_cents, root_cause, evidence_ids, rationale, model_version}`. Guardrails: exposure math is code; the model cannot add credits; rebuttals are `officer`-signed (Fannie Mae performance-management correspondence is an officer certification touchpoint). Escalations: `officer` (bill acceptance/rebuttal; allocation disputes), `attorney` (firm-caused delays, method deviations), `fnma_portal_operator` (DRA/Connect pulls where portal-only). AI-off path: dashboard + queue.

#### Edge cases and failure modes
- LPI date changes retroactively (payment reversal/reapplication in 2.x): recompute; keep the history.
- Status code reported late (after CD10 lock) for a bankruptcy month: credit at risk — file a correction the next period and document.
- Multiple bankruptcies: per-filing caps; sequential Ch.7 then Ch.13 both credited.
- Contested foreclosure a second time: no credit (first occurrence only) — exposure grows; document for "reasonable explanation."
- Sale rescinded for servicer error: $1,000 + third-party costs exposure; clock continues to the new sale.
- Transfer-in mid-foreclosure: transferor's LPI and history govern; missing status-code history ⇒ credits at risk — request the transferor's AMN history (1.3).
- Transfer-out: exposure snapshot goes with the file; allocation per the transfer agreement.
- Exhibit version change mid-case: the version in force on the sale date applies (Fannie Mae rule "sale date on or after"); the tracker projects under both until the sale.
- Disaster hold awaiting Fannie Mae approval: no listed credit — record the request/response for rebuttal; Fannie Mae's own approval process should be treated as "beyond the control of the servicer" (decision 13.4-5).

#### Test cases and acceptance criteria
- 13.5-T1 Given F-2-03 Example 1 inputs, Then exposure = $3,461.64; Example 2 ⇒ $0 and status `closed_within`.
- 13.5-T2 Given the NJ worked example, Then credited = 165, excess = 18, exposure = $840.82; if the Ch.13 code 67 was not accepted for two months, credit at risk flagged and exposure shown both ways.
- 13.5-T3 Given a NYC property, Then allowable = 2,190; a Westchester property ⇒ 1,740.
- 13.5-T4 Given a sale on June 30, 2025 in a state whose days changed on July 1, 2025, Then the prior exhibit version applies; July 1 ⇒ new version.
- 13.5-T5 Given elapsed days reach 70% of (allowable + credits), Then `at_risk` event and a firm status demand instruction.
- 13.5-T6 Given a rescinded sale due to a missed DMDC check, Then $1,000 + costs exposure and root cause `servicer:scra`.
- 13.5-T7 Given a second contested period, Then no additional credit and a note for "reasonable explanation."
- 13.5-T8 Given a bill received, Then `SM_COMP_FEE_BILL_REBUTTAL_30` starts, package drafted, `officer` escalation.
- 13.5-T9 Given a non-preferred method proposed without Form 20 approval, Then `FNMA_EXHIBIT_METHOD_DEVIATION_FORM20_GATE` refuses first-notice authorization.

#### Audit and evidence
The tracker's monthly snapshots, status-code acknowledgments, delay-credit evidence and root-cause classifications form the rebuttal file; the STAR/performance-improvement-plan correspondence (officer-signed) and any bills/payments are stored with the case. Fannie Mae's reliance on reported status data (A1-4.2-02) makes the 5.4 acknowledgment archive the primary evidence.

### Open questions / decisions
1. UPB basis for exposure — default: UPB at LPI (constant); revisit if Fannie Mae bills on a different basis.
2. Fee allocation between partner and Supermortgage — default: by root cause; disputes to the contract's escalation clause.
3. Treat "awaiting Fannie Mae disaster approval" as a documented reasonable explanation — default: yes; confirm with the Servicing Representative.
4. Rebuttal window — default: 30 days from bill (policy) pending Fannie Mae's stated process.

### Sources
- E-3.2-15 (07/09/2025): https://servicing-guide.fanniemae.com/svc/e-3.2-15/allowable-time-frames-completing-foreclosure — verified 2026-09-09.
- A1-4.2-02 (02/13/2019): https://servicing-guide.fanniemae.com/svc/a1-4.2-02/compensatory-fees-delays-liquidation-process — verified 2026-09-09.
- F-2-03 (07/09/2025): https://servicing-guide.fanniemae.com/svc/f-2-03/compensatory-fee-calculation-examples — verified 2026-09-09.
- Foreclosure Time Frames and Compensatory Fee Allowable Delays exhibit (06.18.25): https://singlefamily.fanniemae.com/media/6726/display — verified 2026-09-09.
- F-1-21 (10/11/2023) status codes: https://servicing-guide.fanniemae.com/svc/f-1-21/reporting-delinquent-mortgage-loan-fannie-maes-servicing-solutions-system — verified 2026-09-09.
- LL-2025-01 (Apr. 9, 2025): https://singlefamily.fanniemae.com/media/42056/display (research/00a §3.6).
