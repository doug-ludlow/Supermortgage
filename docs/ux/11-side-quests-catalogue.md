# 11 — Side-quest catalogue

A side quest is a self-contained detour: a **trigger** (an event or a borrower answer), an **entry card**, a short **sequence**, the **evidence** it must leave, and a **return point** in the main flow. Side quests never restructure the happy path; they add items to Needed-from-you and messages to the Thread. IDs are stable and referenced from files 03–10.

Format: **Trigger** · **Entry** · **Sequence** · **Evidence** · **Return** · **Spec**.

## Origination

**SQ-00 Browse (just curious)** · Trigger: the borrower declines to apply / asks only about rates · Entry: published ranges (`StatusCard`) + `ChoiceCard` "Want a personalized estimate? That takes a soft credit check" · Sequence: L2 → `ConsentCard{credit_authorization, soft_pull}` (`FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE`) → `credit.softpull.received` → prequalification numbers (after `terms_review` under `assisted`) → optional prequal letter (purchase) · Evidence: `credit_authorizations{soft_pull}`, `prequalifications` · Return: E3 goal → the full path; or `SM_LEAD_INACTIVITY_EXPIRY_90` (soft-pull data deleted; consents kept) · Spec: O1.3 (`exploring → prequal_requested → prequalified → terms_review → terms_presented`), `REGB_1002_2F_NO_PREQUAL_DECLINE_GATE` (never a decline at this stage).

**SQ-01 Assets requested by DU** · Trigger: DU "Funds Required to Close" / "Reserves Required to be Verified" (O4.2 conditions) · Entry: `ConnectCard{plaid_assets}` in Needed-from-you · Sequence: connect → `ConfirmCard{accounts}` → large deposits → SQ-02 · Evidence: `verifications{kind=assets}`, `application_assets` confirmed · Return: condition `cleared` · Spec: O3.4, O4.2.

**SQ-02 Letters of explanation** · Trigger: inquiries ≤ 90 days (O3.2); deposits > 50% of monthly qualifying income (O3.4); employment gaps (O3.3); address discrepancies (O3.6) · Entry: `ExplanationCard` per item · Sequence: text/dictation → attestation · Evidence: `documents{class=inquiry_explanation|explanation_letter}` with hash · Return: condition `satisfied_pending_review → cleared` · Spec: O3.1, O3.2, O3.4.

**SQ-03 Non-connectable income** · Trigger: Truv `failed`, employer not covered, cash income · Entry: `ConfirmCard{monthly income, typed}` + `UploadCard{paystub (≤30 days at application), w2 ×2}` · Sequence: uploads → classification → `income_verified`; VVOE by the platform inside `FNMA_B3_3_1_04_VVOE_10BD` (a phone verification the borrower doesn't see; `FNMA_B3_3_1_04_VVOE_ALT_15BD` alternative) · Evidence: `document_requests` satisfied · Return: 4.7 · Spec: O3.1, O3.3.

**SQ-04 Gift funds** · Trigger: "gift funds coming?" = yes (P7/C) · Entry: `UploadCard{gift_letter}` (donor, relationship — family, fiancé, domestic partner; amount; no repayment) + `UploadCard{gift_transfer_evidence}` · Evidence: `gift_records` · Return: assets verified · Spec: O3.4 (B3-4.3).

**SQ-04-INS Insurance selection (purchase)** · Trigger: purchase, hazard `requirement_computed` · Entry: `ChoiceCard` have a quote / help me get quotes · Sequence: `UploadCard{binder}` or `ConnectCard{carrier_connect}`; the requirement facts (06 §5) · Evidence: `insurance.evidence.received → verified` · Return: PTD condition cleared · Spec: O5.5.

**SQ-05 Declarations detail** · Trigger: "Something here applies" · Entry: 13-item checklist (`ChecklistCard` variant with yes/no per item) · Sequence: each yes opens its follow-up — bankruptcy/foreclosure/short sale/DIL dates (waiting periods B3-5.3-07 explained as criteria, never a decline); judgments/lawsuits → documents; undisclosed borrowed funds → source; alimony/child support → order upload (O3.5); co-signed debt → 12-month payment evidence · Evidence: `declarations` values with dates · Return: R6 · Spec: O2.1, O3.2, O3.5.

**SQ-06 Residence history** · Trigger: credit report shows < 2 years at the current address · Entry: `ConfirmCard{prior address, dates, own/rent}` · Return: R4 · Spec: O2.1 (URLA 1a).

**SQ-07 Vesting / owner mismatch** · Trigger: owner of record ≠ borrower; trust; spouse on title; recent transfer · Entry: `ChoiceCard` (it's in a trust / my spouse is on title / I recently bought it / other) · Sequence: `UploadCard{trust_agreement|trust_certification}` (`SM_TRUST_POA_REVIEW_GATE`); `InviteCard{non_borrowing_spouse}`; `ExplanationCard` for a recent transfer (title seasoning `FNMA_B2_1_3_03_TITLE_SEASONING_6M`) · Return: R1 / title cleared (06 §4) · Spec: O5.4, O2.1.

**SQ-08 HOA / condo documents** · Trigger: `project_reviews.status = pending_docs` · Entry: `UploadCard{hoa_questionnaire, hoa_budget, hoa_dues_statement}` or `HandoffCard{HOA management}` (owner *third party*) · Return: `certified` · Spec: O5.3.

**SQ-09 Preapproval refresh** · Trigger: `SM_UW_DECISION_VALIDITY − 14 days`; credit report > 4 months at the projected note date; income documents aging · Entry: `StatusCard` + `ConsentCard{credit_authorization}` (re-pull) + connector refresh · Sequence: DU re-run → refreshed letter · Return: P9 · Spec: O4.3 (`SM_UW_DECISION_VALIDITY`), O3.2 (`FNMA_B1_1_03_CREDIT_REPORT_EXPIRY_4M`).

**SQ-10 HELOC subordination or payoff** · Trigger: second lien on the credit report or title commitment · Entry: `ChoiceCard` keep it (subordinate) / pay it off at closing · Sequence: `HandoffCard{HELOC lender}` for the subordination agreement (executed before closing — O5.4 gate) or `debt_payoff_plans` row · Evidence: subordination agreement in `documents`; payoff on the settlement statement · Return: title cleared · Spec: O5.4, O3.5.

**SQ-11 Cash-out seasoning** · Trigger: `FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M` / `_TITLE_SEASONING_6M` closed · Entry: `StatusCard` with the earliest eligible date + `ChoiceCard` rate/term now / wait · Return: E3 with the chosen type · Spec: O1.1, O4.2.

**SQ-12 Student-loan payment documentation** · Trigger: $0 reported payment · Entry: optional `UploadCard{student_loan_statement}` (a documented plan payment can replace the 1% rule) · Return: liabilities set · Spec: O3.5.

**SQ-13 Frozen credit** · Trigger: bureau freeze on the pull · Entry: `StatusCard` with per-bureau lift instructions + `ChoiceCard` "lifted — try again" · Rule: frozen at two or more bureaus → ineligible (explained as criteria) · Return: R2 · Spec: O3.2.

**SQ-14 Fraud alert on file** · Trigger: initial/extended alert on the report · Entry: the platform contacts the number on the alert (`FCRA_605A_H_ALERT_CONTACT_GATE`); `ConfirmCard` "Did you apply?" via that channel · Return: R2 · Spec: O3.2, O3.6.

**SQ-15 Disputed tradeline** · Trigger: dispute blocks DU · Entry: `ExplanationCard` + `ChoiceCard` (account is mine / not mine) · Sequence: resolution steps with the bureau; re-pull · Return: R2 · Spec: O3.2.

**SQ-16 Other income** · Trigger: any selection in R3's other-income field · Entry: source-specific `UploadCard`s — award letter (SSA/pension/disability), court order + receipt evidence (alimony/child support; ≥ 3 years continuance), leases/Schedule E (rental; 75% rule), LES (military) · Return: income verified · Spec: O3.3.

**SQ-17 Non-permanent resident** · Trigger: citizenship = non-permanent resident · Entry: `UploadCard{ead|visa|i-94}` per B2-2-02 · Return: R4 · Spec: O2.1.

**SQ-18 Self-employed** · Trigger: income type self-employed · Entry: `ConnectCard{irs_ives}` (Form 4506-C transcripts; `FNMA_B3_3_1_02_4506C_VALID_120`) + `UploadCard{form_1040 ×2 (or 1 when DU allows), schedule_c|k1|1065|1120s, ytd P&L}`; business existence verified by the platform ≤ 120 days before the note date (`FNMA_B3_3_1_04_SE_VERIFY_120`) · Return: income verified · Spec: O3.3 (Income Calculator; Form 1084).

**SQ-19 Second borrower** · Trigger: any point before `intake_complete` · Entry: `InviteCard{co_borrower}` · Sequence: 05 §7 (their disclosure, L1, L3, consents, joint intent first, then their R2–R6) · Evidence: per-party rows; `SM_O21_JOINT_INTENT_GATE` · Return: DU when all borrowers' items are present · Spec: O2.1, O3.2.

**SQ-19b Non-borrowing spouse / POA / trust signer** · Trigger: SQ-07 or vesting review · Entry: `InviteCard{party_role}` / `UploadCard{poa}` · Sequence: signing session participation (07) · Spec: O2.1, O5.4, O7.2.

**SQ-19c Wet-ink / paper closing** · Trigger: `SM_O72_RON_STATE_AUTH_GATE` closed; borrower declines electronic records; session failure → `converted_to_paper_path`; TX 50(a)(6) · Entry: `ChoiceCard` / `HandoffCard{notary_wet | settlement_agent}` · Rule: `SM_O72_PAPER_FALLBACK_5BD` · Spec: O7.2.

**SQ-19d Texas 50(a)(6)** · Trigger: TX homestead cash-out · Entry: `NTC_TX_50A6_12DAY` (ack), itemization with the CD, FMV acknowledgment at closing, 3-day post-closing rescission (`TX_50A6_RESCISSION_3D_GATE`), wet-only · Spec: O7.1, O6.4.

**SQ-19e New York CEMA** · Trigger: NY refinance electing CEMA · Entry: `StatusCard` explaining the consolidation and the paper path; documents at closing · Spec: O7.1.

**SQ-19f Manufactured housing / MH Advantage** · Trigger: property type · Entry: title-as-real-property confirmation; appraisal always required · Spec: O5.3, O5.1.

## Servicing

**SQ-20 Returned payment** · Trigger: `ach.return.received` · Entry: `NoticeCard{AUTODRAFT-RETURN-v1}` · Sequence: 08a §3.4 · Spec: 2.x.

**SQ-21 Insurance lapse** · Trigger: `cancelled | nonrenewed | expired` · Entry: first notice (`REGX_1024_37C_FPI_FIRST_NOTICE_45`) · Sequence: 08b §1 · Spec: 9.2–9.5.

**SQ-22 Escrow shortage lump sum** · Trigger: `NTC_REGX_1024_17F_SHORTAGE` · Entry: `ChoiceCard` · Spec: 3.2/3.3.

**SQ-23 Contact / address change** · Trigger: typed ask · Entry: `ConfirmCard` (fresh L1) → `cases{address_change}` · Spec: 4.x, 7.x.

**SQ-24 Disaster** · Trigger: declaration covering the property · Entry: check-in `StatusCard`; disaster options (08c §7); loss draft (08b §1) · Spec: 9.x, 12.7, D1-3-01.

**SQ-25 Military service (SCRA)** · Trigger: borrower report or DMDC match · Entry: `UploadCard{orders|LES}` → `NTC_FNMA_D23401_SCRA_RIGHTS`, `NTC_SCRA_3937_RATE_CONFIRMATION` · Spec: 13.x SCRA processes.

**SQ-26 Death / successor** · Trigger: report of death · Entry: 4.4 case (08b §4.2) · Spec: 4.4.

**SQ-27 Bankruptcy filing** · Trigger: borrower/counsel notice or PACER · Entry: 08c §9 · Spec: 14.x.

**SQ-28 Cease communication / attorney representation** · Trigger: typed or spoken request · Entry: `NTC_REGF_1006_6C_CEASE_ACK` / representation confirmation · Spec: 11.4, 4.x.

**SQ-29 Payoff shortage / overage** · Trigger: `applied_short | applied_over` · Entry: 10 §1.2 notices · Spec: 16.2.

**SQ-30 Human transfer** · Trigger: "human" anywhere; distress keywords; classifier `needs_human`; CA supervisor request · Entry: `PersonCard{human_agent}` after `human.transfer.completed`; the delinquent borrower's named team (4.3) when assigned · Spec: 4.1, 4.3, 11.1, O1.3.

**SQ-31 E-delivery suspect / withdrawal** · Trigger: hard bounce, complaint, borrower request · Entry: `ConsentCard{esign}` re-verification or `NTC_ESIGN_WITHDRAWAL_CONFIRMATION` · Spec: 7.4 rules 7–8.

**SQ-32 PMI cancellation with valuation** · Trigger: `value_check_needed` · Entry: fee `ChoiceCard` → `valuation_ordered` · Spec: 10.1.

**SQ-33 Assumption / release of liability** · Trigger: typed ask; SII confirmation · Entry: `NTC_FNMA_D1_4_1_02_ASSUMPTION_OFFER` + documents · Spec: 4.4, D1-4.

**SQ-34 Escrow waiver** · Trigger: typed ask · Entry: eligibility explanation → decision notice · Spec: 3.x (08a §6.3).

**SQ-35 Re-amortization after a large curtailment** · Trigger: borrower asks / platform offers after a qualifying curtailment · Entry: `NoticeCard` + `ChoiceCard` (Form 181) · Spec: 2.x.

## Global rules for side quests
1. Entering a side quest never removes a happy-path card; it adds items.
2. A side quest's items appear in Needed-from-you only when the borrower is the owner.
3. Every side quest ends with a one-line receipt in the Thread and a return to the badge state it left.
4. Copy for criteria-based outcomes (seasoning, waiting periods, eligibility) states the rule and the date — never a decline (O1.3 rule 3) — unless a decision notice (O2.6 / 12.2) is the artifact.
5. No side quest asks a question §1002.5 prohibits or collects demographic information outside R6 / its per-party equivalent.
