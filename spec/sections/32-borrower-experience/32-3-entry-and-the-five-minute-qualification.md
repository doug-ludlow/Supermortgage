# 32.3 — Entry and the five-minute qualification

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower confirms and commits by card; the agent proposes and explains; `mlo_of_record` approves terms and locks under `origination.ai_mlo_intake=assisted` |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On `lead.created`; per party; three happy paths (refinance, preapproval, purchase with contract) |
| Governing source | Projection of sections 20.3 (lead intake), 20.4 (pricing), 21.1 (application), 21.2 (LE), 21.3 (companions), 21.4 (intent, lock), 22.1–22.6 (documents, credit, income, assets, liabilities, identity), 23.1–23.3 (DU, conditions, decision), 24.1 (valuation), 31.1 (licensing) |
| Key deadlines | renders `REGZ_1026_19E1_LE_3BD`, `REGB_1002_9_DECISION_30`, `SM_O21_MLO_REVIEW_SLA_1BD`, `SM_LOCK_MLO_APPROVAL_SLA_30MIN`, `SM_UW_DECISION_VALIDITY` (owned by 21.x / 23.x) |
| Timers | — |

### Blueprint row
Projection of sections 20.3 (lead intake), 20.4 (pricing), 21.1 (application), 21.2 (LE), 21.3 (companions), 21.4 (intent, lock), 22.1–22.6 (documents, credit, income, assets, liabilities, identity), 23.1–23.3 (DU, conditions, decision), 24.1 (valuation), 31.1 (licensing). Covers first contact through the Loan Estimate, intent to proceed and rate lock for the three happy paths. Every screen lists Reads · Commands · Events · Timers · Documents · Evidence · Roles · Copy · Tests (32.1 §0 binding rules). Side quests are referenced by ID (file 11). (Imported from docs/ux/03-entry-and-qualification.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 03 is 32.3 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 20.3 (lead intake), 20.4 (pricing), 21.1 (application), 21.2 (LE), 21.3 (companions), 21.4 (intent, lock), 22.1–22.6 (documents, credit, income, assets, liabilities, identity), 23.1–23.3 (DU, conditions, decision), 24.1 (valuation), 31.1 (licensing)** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: (1) `party.identity.verified` is the platform's `identity.verified` (22.6). (2) `preapproval.letter.issued` and the `prequalifications` preapproval columns are DELTA-01 (0077 created `prequalifications` for the soft-pull prequalification only).

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On `lead.created`; per party; three happy paths (refinance, preapproval, purchase with contract). Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `applicant_demographics`, `application_borrowers`, `application_income`, `application_liabilities`, `application_properties`, `credit_authorizations`, `declarations`, `du_casefiles`, `jurisdiction_rules`, `purchase_contracts`, `verifications`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `REGZ_1026_19E1_LE_3BD` (20.3), `SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE` (20.3), `FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M` (20.1), `FNMA_B2_1_3_03_TITLE_SEASONING_6M` (20.1), `SM_IDENTITY_IAL2_GATE` (22.6), `FNMA_B2_2_01_SSN_VALIDATION_GATE` (22.6), `SM_FLOOD_DETERMINATION_ORDER_1BD` (24.5), `OFAC_SDN_SCREEN_GATE` (22.6), `FCRA_605A_H_ALERT_CONTACT_GATE` (22.6), `FCRA_609G_SCORE_NOTICE_1BD` (21.3), `FNMA_B3_3_1_04_VVOE_10BD` (22.3), `FNMA_B3_2_02_DU_CLOSE_BY_GATE` (22.3), `REGB_1002_9_DECISION_30` (20.3), `REGX_1024_20_HCL_3BD` (21.3), `REGB_1002_14_APPRAISAL_NOTICE_3BD` (21.3), `REGB_1002_9_COUNTEROFFER_90` (21.6), `SM_DU_CONDITIONS_SLA_4H` (23.2), `REGZ_1026_37A13_COSTS_EXPIRE_10BD` (21.2), `REGZ_1026_19E1III_LE_7SBD_GATE` (21.2), `REGZ_1026_19E2_INTENT_FEE_GATE` (21.4), `SM_TITLE_ORDER_2BD` (24.4), `REGZ_1026_36C3_PAYOFF_STMT_7BD` (7.6), `SM_NEEDS_LIST_BORROWER_RESPONSE_5` (22.1), `REGB_1002_9_NOIA` (21.6), `SM_LOCK_MLO_APPROVAL_SLA_30MIN` (21.4), `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` (20.4), `SM_LOCK_EXPIRY_DEADLINE` (21.4), `SM_LOCK_EXPIRY_WARN_7` (21.4), `SM_UW_DECISION_VALIDITY` (23.3), `SM_MLO_PREAPP_TERMS_REVIEW_1BH` (20.3), `SM_QUOTE_VALIDITY_GATE` (20.4), `SM_LEAD_INACTIVITY_EXPIRY_90` (20.3), `SM_O62_CD_TARGET_4SBD` (25.2), `FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE` (20.3).

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 0. Design targets

| Target | Refinance | Preapproval | Purchase with contract |
|---|---|---|---|
| Borrower time to DU result | 5–7 min | 6–8 min | +2 min over preapproval (contract) |
| Typed fields | 1 (SSN) | 3 (SSN, target price, down payment) | 1 + contract upload |
| Taps (cards resolved) | ~14 | ~17 | ~8 more |
| Connectors | Stripe Identity · Truv | + Plaid | as preapproval |
| Human latency | loan-officer review of terms (`assisted`: ≤1 business hour) | same | same |

The 5-minute qualification **is** the application: under 21.2 rule 5's default, once income, the SSN authorization, address, value estimate and loan amount are confirmed, `application.trid_received` fires and `REGZ_1026_19E1_LE_3BD` starts. Screens are designed knowing this.

Order of operations is fixed so that nothing is asked before it is allowed: no income or loan amount before the borrower elects to proceed (20.3 rule 6); no documents *required* before the LE (21.2 rule; connectors are offered as optional and free); no personalized terms before `mlo.review.completed{approved}` (20.3 rule 7); no demographic questions until the application stage (20.3 T12).

##### 1. Common entry (E1–E6)

###### E1 · Arrive — `leads.status = new`
- **Trigger:** landing CTA ("Get my rate" / "Lower my payment" / "Get preapproved"), a text or call to the published number, a referral link, or an `OfferCard` **Yes** from servicing (32.11).
- **Thread:** first assistant message = automation disclosure (E2). Nothing else renders before it.
- **Record:** hidden (no subject yet); on mobile the status strip reads "Getting started".
- **Commands:** `lead.start{channel, utm, consumer_state}` → `lead.created`, `lead.interaction.started{channel, ai=true}`.
- **Copy:** `entry.landing.cta_*`.

###### E2 · Automation disclosure — `disclosed`
- **Card:** none; a system message with the automation marker: "I'm Supermortgage's automated assistant, working for {{partner.legal_name}}, your lender. You can reach a person at any time — just say *human*." Utah/California/Colorado lines per `jurisdiction_rules` (20.3; CO pre-use notice from Dec 1, 2026 before any pricing output).
- **Commands:** `lead.acknowledgeAiDisclosure` fires on the message render (no tap) → `lead.disclosure.delivered`, `consent.ai_disclosure.acknowledged`. Gate `SM_LEAD_AUTH_BEFORE_DISCLOSURE_GATE` is 20.3's ordering guard — the disclosure precedes any AI exchange.
- **Tests:** 32.3-T1 (disclosure precedes first assistant content on every channel); 32.3-T2 ("are you a real person?" → 20.3 T11 answer, disclosure re-logged).

###### E3 · Goal — `exploring`
- **Card:** `ChoiceCard` — **Buy a home** · **Lower my rate or payment** · **Take cash out**. Then for Buy: `ChoiceCard` — **I have a signed contract** · **Still looking**. For cash out: the 12-month note seasoning and 6-month title seasoning gates (`FNMA_B2_1_3_03_CASHOUT_NOTE_SEASONING_12M`, `FNMA_B2_1_3_03_TITLE_SEASONING_6M`) are checked once the existing loan is known (R1); if not met, the assistant offers rate/term and explains the date (SQ-11).
- **Commands:** `application.setGoal{transaction_type, occupancy? , property: address|tbd}` → `application.started` (`applications.status = started`). Occupancy is asked here as a `ChoiceCard` (Primary home · Second home · Investment) with Primary preselected only visually — the tap is required.
- **Record:** appears with Header (purpose) and Status "Getting started".
- **Branch:** "Just curious about rates" (typed) → SQ-00 *Browse* (published ranges; soft-pull prequalification per 20.3; no six-item collection).

###### E4 · Identify — L1
- **Card:** `ConfirmCard{fields: mobile, email}` with OTP sub-steps (`party.authenticate{otp_phone}`, then email code; email is needed for the E-SIGN demonstration test and deep links).
- **Events:** `lead.authenticated{level=L1}`.
- **Copy:** `entry.identify.why` ("Your code keeps this conversation yours. We'll never text you marketing without asking first.").
- **Tests:** 32.3-T3 (no loan data or personal terms rendered below L1).

###### E5 · Verify identity — L3
- **Card:** `ConnectCard{vendor=stripe_identity, purpose_text, what_we_get: [name, date of birth, address on your ID, document validity], fallback: UploadCard(drivers_license|passport|state_id) + human review}`.
- **On webhook:** identity events satisfy `SM_IDENTITY_IAL2_GATE` (22.6). Extracted name/DOB/address written to `application_borrowers` with `source=stripe_identity`, then `ConfirmCard{fields: legal name, date of birth, current address}` — **Confirm** or **Edit** (a different mailing address is an edit; residence history is asked only if the credit report later shows < 2 years at this address — SQ-06).
- **Then:** `ConfirmCard{field: SSN}` — the one typed field. Masked input; stored once; never echoed. Copy explains it's needed for the credit report and validated with the Social Security Administration (`FNMA_B2_2_01_SSN_VALIDATION_GATE`).
- **Events:** `lead.authenticated{level=L3}`; `party.identity.verified` (22.6 naming) → Record People shows the borrower with a verified mark.
- **Failure:** `failed` → fallback upload + `underwriting_reviewer`-style human review is 22.6's `fraud-risk` path; borrower copy is neutral ("we'll take a closer look — nothing for you to do").
- **Tests:** 32.3-T4 (hard pull refused below L3 — `credit.authorize{hard_pull}` returns gate error); 32.3-T5 (extracted fields count as submitted only on Confirm — 21.1 rule 1).

###### E6 · Consents
Three `ConsentCard`s in one message, resolved independently:
1. **E-delivery** (`kind=esign`, scope: `origination_disclosures`, `origination_esign_signatures`, servicing classes for after funding) — `checkbox_with_text` + typed name → `consented_pending_verification`; the verification email (`NTC_ESIGN_VERIFICATION_EMAIL`, link + PDF token) goes out immediately; the card shows "Check your email — open the link and enter the code from the attached PDF" until `consent.esign.verified` → `active`. The rest of the flow continues in parallel; if E-SIGN is still not active when the LE is ready, the LE is **mailed** and the Record shows *Mailed* (21.2 guard; 7.4 rule 2). Copy states plainly that a spoken or typed "yes" in chat doesn't count.
2. **Calls and texts** (`kind=tcpa_sms`, `kind=tcpa_voice`, `purpose=informational`) — optional; STOP language; SMS double opt-in (`NTC_TCPA_CONSENT_CONFIRMATION`). Marketing consent (`purpose=marketing`) is **not** asked here; it is offered after funding (32.11).
3. **Credit report authorization** (`kind=credit_authorization`, `hard_pull`) — `checkbox_with_text` + typed name; text hash logged (`credit_authorizations`). This is the SSN-to-obtain-a-credit-report TRID item once the other five exist (21.2 rule 5 default).
- **Privacy notice:** `NTC_GLBA_1016_4_PRIVACY_INITIAL` delivered as a `DocumentCard{requires_ack=false}` (posted with acknowledgment when E-SIGN active, else mailed — 7.4 rule 10).
- **Tests:** 32.3-T6 (voice "yes" never produces `consents{esign}` active — 20.3 T8); 32.3-T7 (E-SIGN pending → LE path is mail; Documents shows *Mailed*).

##### 2. Refinance happy path (R1–R12)

Preconditions: E1–E6 complete; `transaction_type ∈ {limited_cash_out, cash_out}`; occupancy primary.

###### R1 · Your home and your current loan
- **Reads:** address from Stripe (E5) as the candidate property; **property pull** (public records: type, units, year built, APN, tax amount, HOA presence, current owner of record; AVM; flood determination order per `SM_FLOOD_DETERMINATION_ORDER_1BD` after title order — the *borrower-facing* flood status waits until then); existing lien from the credit report (mortgage tradeline: creditor, balance, payment, open date) reconciled to the recorded deed of trust (original amount, date, lender).
- **Cards:**
  - `ConfirmCard{fields: property address (source=stripe_identity → application_properties), property type & units (public_records), "this is my primary home" (occupancy — from E3)}`.
  - `ConfirmCard{fields: current lender, approximate balance, monthly payment, rate if on file, loan date (source=credit_report, recorded_instrument), escrow (taxes and insurance included in payment? — borrower answers), second lien or HELOC? (credit_report; borrower confirms none)}`.
- **Commands:** `application.confirmField` ×2 (writes `application_properties`, `application_reo{subject}` / existing-lien fields, `application_liabilities{mortgage}`).
- **Branches:** owner of record ≠ borrower → SQ-07 (title/vesting: trust, spouse, recent transfer); HELOC present → SQ-10 (subordination or payoff); cash-out seasoning unmet → SQ-11.
- **Copy:** `refi.home.confirm`, `refi.current_loan.confirm`.
- **Tests:** 32.3-T8 (address confirmed sets `trid_items.property_address.present=true`; no `application.trid_received` yet).

###### R2 · Credit — `credit.report.received`
- **Trigger:** E6 authorization resolved and L3 present → `credit.report.received` (hard tri-merge, one score model for all borrowers — 22.2; `FNMA_B2_2_01_SSN_VALIDATION_GATE` and `OFAC_SDN_SCREEN_GATE` run first).
- **Cards:** `ConfirmCard{fields: liabilities[] (creditor, type, balance, payment — source=credit_report)}` with an **Anything missing?** edit path (adds `application_liabilities` rows). Student loans with $0 reported payment show the qualifying-payment rule in plain language (22.5 rule: 1% of balance or a documented plan payment) — no borrower action unless they have a plan statement (SQ-12).
- **Side quests raised automatically:** recent inquiries (≤ 90 days) → `ExplanationCard` per inquiry (SQ-02); frozen bureau → SQ-13; fraud alert on file → SQ-14 (contact requirement — `FCRA_605A_H_ALERT_CONTACT_GATE`); disputed tradeline blocking DU → SQ-15.
- **Documents:** `NTC_FCRA_609G_CREDIT_SCORE` (`FCRA_609G_SCORE_NOTICE_1BD`) and, if applicable, `NTC_REGV_1022_74_RBP_EXCEPTION` as `DocumentCard{requires_ack=false}`.
- **Never shown:** the report itself, scores in the thread beyond the notice, DU text.
- **Tests:** 32.3-T9 (two borrowers on different score models → 23.1 T11 re-order; borrower sees "we're re-running your credit report, nothing needed"); 32.3-T10 (score notice delivered within 1 BD of report receipt).

###### R3 · Income and employment
- **Card:** `ConnectCard{vendor=truv_income, purpose_text: "Connect your payroll so we can verify income without paystubs", what_we_get: [employer, start date, pay frequency, base and variable pay, year-to-date], fallback: "type your monthly income now; we'll ask for paystubs later" (SQ-03)}`. Free to the borrower and optional pre-LE (21.2 rule); post-intent it becomes a needs-list item.
- **On `verification.received{kind=income}`:** `ConfirmCard{fields: employer (payroll_connection), position, start date, monthly income by type (base, overtime, bonus, commission), pay frequency}`. **Confirm** = the borrower's *stated* income for this transaction (21.2 rule 2: income counts when stated; a prefilled item counts at confirmation). The card copy says exactly that: "This becomes the income you're stating on your application."
- **Also asked (one field, optional):** other income (Social Security, pension, child support, rental) → **None** default tap; any selection → SQ-16.
- **Commands:** `verification.connect{truv_income}`; `application.confirmField{application_income}`.
- **Reads later:** the standing connection satisfies the verbal verification of employment inside DU's close-by window (`FNMA_B3_3_1_04_VVOE_10BD` via `FNMA_B3_2_02_DU_CLOSE_BY_GATE`) — no re-ask (32.5).
- **Tests:** 32.3-T11 (income stated only on Confirm; typed fallback records `source=borrower`); 32.3-T12 (DU validation report `close_by_date` shown internally only).

###### R4 · About you — `ProfileCard`
One card, four required taps, no defaults (Reg B §1002.5 rules; URLA 1a):
- **Citizenship** — U.S. citizen · Permanent resident · Non-permanent resident (→ SQ-17 documents).
- **Marital status** — Married · Unmarried · Separated (no further marital questions — 21.1 rule 5).
- **Dependents** — number (0 preselected visually; tap required), ages if > 0.
- **Military service** — URLA Section 7 as written.
Plus the **language preference** question (Form 1103 SCIF, with the form's own statement; blank allowed → `not_answered`).
- **Commands:** `application.confirmField` per field → `application_borrowers.citizenship_status`, marital status, dependents, military; `NTC_FNMA_1103_SCIF` recorded.
- **Tests:** 32.3-T13 (no field is submitted without a tap).

###### R5 · Declarations — `application.answerDeclarations`
- **Card:** `ChoiceCard` — **None of these apply to me** · **Something here applies** — above a collapsed, readable list of the 13 URLA Section 5 declarations in plain language (outstanding judgments; delinquent federal debt; party to a lawsuit; conveyed title in lieu of foreclosure in the past 7 years; pre-foreclosure or short sale in the past 7 years; foreclosure in the past 7 years; bankruptcy in the past 7 years; borrowing money for the down payment or closing costs not disclosed; other new credit applied for; the property has another mortgage or lien not disclosed; a co-signer or guarantor on any debt; alimony/child support/separate maintenance obligations; relationship with the seller — purchase only).
- **"None"** writes all thirteen as `false` in `declarations` with the list version hash as evidence. **"Something applies"** → SQ-05 (item-by-item checklist; a "yes" on bankruptcy/foreclosure/short sale opens the waiting-period explanation from B3-5.3-07 in the assistant, never as a decline).
- **Tests:** 32.3-T14 (thirteen explicit values written; list version hash logged).

###### R6 · Demographic information — `DemographicsCard`
- **Card:** the Reg C Appendix B / Reg B §1002.13 request as written: the collection statement; ethnicity and race as multi-select with disaggregated sub-categories; sex; each with **I do not wish to provide**. Collection method recorded as `internet` (or `telephone` for voice; `video` treated as not-in-person — 21.1 rule 3). Never populated from name, voice, image or any other signal.
- **Commands:** `application.answerDemographics` → `applicant_demographics` (restricted; write-once from this card; never read back).
- **Tests:** 32.3-T15 (the card is unavailable before `application.started`; an injected pre-application request is refused — 20.3 T12); 32.3-T16 (decline option writes `declined`, not blanks).

###### R7 · Value, loan amount, product — the six-item moment
- **Cards:**
  - `ConfirmCard{field: estimated value (source=avm)}` — **Confirm** counts as the borrower's estimate (21.2 rule 2: an AVM shown counts only when accepted); **Edit** to state their own number.
  - `ConfirmCard{field: loan amount (payoff-based: current balance + estimated payoff interest + $0 borrower costs; source=credit_report/recorded_instrument)}` — accepting counts as the loan amount sought (21.2 rule 2). Cash-out: amount field editable within the 80% LTV cap shown as a plain limit.
  - `ChoiceCard{product}` — **30-year fixed** (preselected visually) · **15-year fixed** · **Adjustable (ARM)** → ARM adds `NTC_REGZ_1026_19B_ARM_PROGRAM` + `NTC_REGZ_1026_19B_CHARM` companions.
- **Events:** the six-item detector fires → `application.received` (Reg B; if not already) and `application.trid_received` → `applications.status = trid_received`; `REGZ_1026_19E1_LE_3BD` and `REGB_1002_9_DECISION_30` start; `REGX_1024_20_HCL_3BD` and `REGB_1002_14_APPRAISAL_NOTICE_3BD` start from the Reg B date.
- **Record:** Status "Application received"; Next "Loan Estimate arrives by {{date}}"; Numbers show *estimated* rate as a range only (no personal quote yet).
- **Thread:** `StatusCard{state_label: "Application received {{date}}", next_event_label: "Your Loan Estimate arrives by", next_event_at: REGZ_1026_19E1_LE_3BD.due_at}`.
- **Tests:** 32.3-T17 (six-item timestamp = max of the six confirmations; application dates recorded per 21.1 rule 1); 32.3-T18 (an unaccepted AVM does not set `property_value_estimate.present`).

###### R8 · Underwriting runs — `du.submitted → du.findings.received`
- **Internal:** `du_casefiles.status: draft → credit_associated → submitted → findings_received`; `du_findings_interpretations.policy_outcome`.
- **Thread:** `StatusCard` "Checking your application with the automated underwriting system — usually a couple of minutes. Nothing needed from you." No spinner longer than 20 s; after that, the card says the result will arrive as a message and the borrower may leave.
- **Outcomes (`decision.issued{kind}` per 23.3/21.6):**
  - `approve_eligible` → `decision.issued{conditional_approval}` → `NoticeCard{NTC_REGB_1002_9_APPROVAL}` ("Approved with conditions") + `ChecklistCard` of conditions with owners. Typical LCOR conditions: insurance evidence (`owner=you`), title (`owner=us`), payoff statement (`owner=third_party`), valuation (`owner=us` — value acceptance decided at DU), final DU match (`owner=us`). **Assets appear only if DU asks** ("Funds Required to Close" / "Reserves Required" messages → `ConnectCard{plaid_assets}` as a `waiting_borrower` condition — SQ-01).
  - `restructure_required` (Approve/Ineligible or Refer with a changeable driver) → the assistant explains the lever in criteria language (lower loan amount; pay down a balance; different product) via `ChoiceCard`; a lender-initiated change of terms is a **counteroffer** (`NTC_REGB_1002_9_COUNTEROFFER`, `REGB_1002_9_COUNTEROFFER_90`) — 06.
  - `decline_candidate` → `underwriting_reviewer` approves the specific reasons → `NTC_REGB_1002_9_ADVERSE_ACTION` as a `NoticeCard` — 06. The assistant's message is the template's plain-language block only.
- **Roles:** `underwriting_reviewer` (denials/counteroffers only); never visible otherwise.
- **Tests:** 32.3-T19 (no DU text in any client payload); 32.3-T20 (`SM_DU_CONDITIONS_SLA_4H` — conditions materialize as `ChecklistCard` within 4 hours; borrower sees the list, not the messages).

###### R9 · Terms and the Loan Estimate
- **`assisted`:** `disclosures{kind=le}` moves `assembling → rendered → pending_mlo`; the Thread shows `StatusCard` "Your terms and Loan Estimate are being reviewed by {{mlo.name}}, NMLSR ID {{mlo.nmlsr_id}} — expected by {{SM_O21_MLO_REVIEW_SLA_1BD or SM_MLO_PREAPP_TERMS_REVIEW_1BH due_at}}" + `PersonCard{mlo_of_record}`. `autonomous`: skipped.
- **On `approved → delivered`:** `DocumentCard{NTC_REGZ_1026_37_LE, requires_ack=true, why: "This is the estimate of your loan terms and costs. Confirming receipt starts the timeline for your closing."}` + companion `DocumentCard`s: `NTC_REGX_1024_20_HCL` (counseling list), `NTC_REGB_1002_14_APPRAISAL_NOTICE` (or `satisfied_by_le`), `NTC_REGX_1024_15_AFBA` (if a referral), privacy (if not yet), state notices, ARM pair if ARM. All e-delivered only with active E-SIGN for `origination_disclosures`; otherwise mailed and the Thread shows `StatusCard` "Mailed today to {{address}}".
- **Numbers:** flip to `le_v1` figures: rate, APR, P&I, estimated escrow, loan amount, **monthly savings** vs the confirmed current payment; footer "not a commitment to lend; rates change daily; {{partner.legal_name}}, NMLSR ID {{partner.nmlsr_id}}".
- **Events:** `disclosure.le.delivered` → `disclosure.le.received{esign_confirmed}` on **Confirm receipt**; `deemed_received` otherwise (mailbox rule).
- **Timers shown:** `REGZ_1026_37A13_COSTS_EXPIRE_10BD` ("estimated costs good through"), `REGZ_1026_19E1III_LE_7SBD_GATE` drives "earliest closing" later (32.4).
- **Tests:** 32.3-T21 (personal rate never rendered before `mlo.review.completed{approved}` under `assisted` — 20.3 T7); 32.3-T22 (LE `DocumentCard` refused without active E-SIGN; mail path recorded).

###### R10 · Proceed
- **Card:** `ChoiceCard` — **Proceed** · **Not yet** — copy: "Until you say proceed, we can't charge anything except the credit report, or require documents. Saying proceed lets us order title and start verification."
- **Commands:** `intent.record` → `intent_records{valid}` (received on/after the LE's effective receipt date — 21.4) → `intent.to_proceed.received`; `REGZ_1026_19E2_INTENT_FEE_GATE` opens.
- **System follow-ons (borrower sees `StatusCard`s):** title ordered (`SM_TITLE_ORDER_2BD`, `title_orders.ordered`), flood determination (`SM_FLOOD_DETERMINATION_ORDER_1BD`), payoff demand to the current servicer (`payoff_demands.requested`; `REGZ_1026_36C3_PAYOFF_STMT_7BD` is theirs), valuation method (`valuation_orders.method_pending → selectMethod`; value acceptance → `offer_recorded`, shown as "No appraisal needed"; otherwise `ready_to_order → ordered` and a `ScheduleCard` in 06).
- **Needs list becomes binding:** connectors not yet connected become `conditions{waiting_borrower}` with `SM_NEEDS_LIST_BORROWER_RESPONSE_5`.
- **"Not yet":** nothing is ordered; a reminder cadence (32.1 §6.4) runs; after `REGB_1002_9_NOIA` policy window without intent → `NTC_REGB_1002_9_NOIA` (32.6).
- **Tests:** 32.3-T23 (intent recorded before LE receipt is stored `valid=false` and the fee gate stays closed — 21.4).

###### R11 · Lock
- **Card:** `ComparisonCard{columns: lock periods from pricing_quotes (e.g., 30 · 45 · 60 days) with rate, APR, P&I, points/credits, expiry date; recommended = the shortest period covering the projected closing date + 7 days; footnote: extension and relock rules in one sentence}` + **Keep floating** option.
- **Commands:** `lock.request{quote_id, period_days}` → `locks.requested → pending_mlo_approval` (`SM_LOCK_MLO_APPROVAL_SLA_30MIN`; shown as "your loan officer is confirming your lock — usually within 30 minutes") → `lock.executed` (`locked_at`) → `confirmed` (confirmation document). `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD` opens → revised LE `DocumentCard` (32.4).
- **Record:** Numbers lock block: "Locked {{rate}} through {{expires_at}}"; Dates: `SM_LOCK_EXPIRY_DEADLINE`; caution styling from `SM_LOCK_EXPIRY_WARN_7`.
- **Tests:** 32.3-T24 (lock card not offered before intent — 21.4); 32.3-T25 (lock executed → revised LE delivered within 3 BD, Numbers flip to `le_v2`).

###### R12 · Hand-off
- **Thread:** `StatusCard` "That's everything for now. Next: your insurance details (1 minute), then your Closing Disclosure in about {{n}} days." Needed-from-you typically: insurance evidence (`ConnectCard{carrier_connect}` or `UploadCard{homeowners_policy}` — mortgagee clause update explained), E-SIGN verification if still pending, any `ExplanationCard`s.
- **Next files:** 04 (revised LE), 05 (conditions), 06 (property/title/insurance/MI/decision), 07 (CD → close).

###### Refinance time budget (median)
| Step | Borrower time |
|---|---|
| E1–E3 | 0:30 |
| E4 L1 | 0:30 |
| E5 Stripe + confirm + SSN | 1:30 |
| E6 consents | 0:45 |
| R1 confirms | 0:30 |
| R2 liabilities confirm | 0:20 |
| R3 Truv + confirm | 1:00 |
| R4–R6 | 0:45 |
| R7 | 0:20 |
| **To DU submitted** | **≈ 6:10** |
| R8 DU result | 1–3 min system |
| R9 terms | `assisted`: ≤ 1 business hour; `autonomous`: immediate |
| R10–R11 | 0:40 |

##### 3. Preapproval — purchase, property to be determined (P1–P9)

Preconditions: E3 = Buy · Still looking. The program is a Reg C preapproval program (README §7): a request is an application under Reg B (`application.received`, `REGB_1002_9_DECISION_30`), denied requests are reportable (28.3) and noticed (21.6). It is **not** a TRID application until an address exists (20.3 T5).

###### P1 · Where and how much
- **Cards:** `ConfirmCard{fields: state you're buying in (source=null; drives SM_LICENSE_STATE_GATE), price range (min/max), down payment (amount or %), first-time buyer? (drives education rules)}`.
- **Copy:** "We'll get you a preapproval you can hand to a seller — based on verified income, assets and credit, run through the same underwriting system we use for the loan."

###### P2–P6 · Identity, consents, credit, income, about you, declarations, demographics
Same cards as E5–E6 and R2–R6 with `purchase` variants of copy. Differences: the address confirmed in E5 is the **current residence**, not the subject; residence history question if < 2 years (SQ-06); declarations include "relationship with the seller" (asked again at contract).

###### P7 · Assets
- **Card:** `ConnectCard{vendor=plaid_assets, purpose_text: "Connect the accounts your down payment and reserves will come from", what_we_get: [balances, two months of transactions], fallback: UploadCard(bank_statement ×2 per account)}`.
- **On `verification.received{kind=assets}`:** `ConfirmCard{fields: accounts[] (institution, type, last4, balance — source=asset_report), "any gift funds coming?" (→ SQ-04 gift letter + transfer evidence), "earnest money paid yet?" (→ EMD evidence when a contract exists)}`. Large deposits (> 50% of monthly qualifying income — 22.4) generate `ExplanationCard`s (SQ-02).
- **Commands:** `verification.connect{plaid_assets}`; `application.confirmField{application_assets}`.

###### P8 · Target price, loan amount, DU on a TBD property
- **Card:** `ConfirmCard{fields: target price, down payment, loan amount (computed), product (30-year fixed default)}` — a `ChoiceCard` for HomeReady eligibility appears when income ≤ 80% AMI for the target area (23.2 AMI lookup): "You may qualify for a lower-cost program (HomeReady). Want us to check?" — never a default.
- **Events:** `application.received` (Reg B) if not already; DU submitted with `property=TBD` (`du_casefiles` as 23.1 allows for TBD casefiles) → `du.findings.received`.
- **Outcome `approve_eligible`:** preapproval decision → **preapproval letter** rendered (`DocumentCard`, `requires_ack=false`): approved amount, product, general conditions (property must appraise and be eligible; no material change), validity (`SM_UW_DECISION_VALIDITY` — 90 days or the earliest expiring component), the partner as lender, MLO of record. Under `assisted` the letter's terms pass `SM_MLO_PREAPP_TERMS_REVIEW_1BH` first; `StatusCard` shows the review. Record badge "Preapproved"; Numbers show the approved amount and the payment at the target price (estimated taxes from the target area, insurance estimate, HOA unknown).
- **Outcome `restructure_required`:** the assistant offers the lever (lower price; larger down payment) as a `ChoiceCard`; the letter issues on the accepted structure (this is not a counteroffer because the borrower chooses the structure — 23.2 Q3 default).
- **Outcome `decline_candidate`:** adverse action per 21.6 (`NTC_REGB_1002_9_ADVERSE_ACTION`), HMDA action taken recorded (28.3).
- **Backend delta:** `prequalifications{kind=preapproval, du_casefile_id, approved_amount_cents, valid_until}` and `preapproval.letter.issued` (README §Deltas, DELTA-01).
- **Tests:** 32.3-T26 (no `application.trid_received` without an address — 20.3 T5); 32.3-T27 (letter contains validity, conditions, lender and MLO, and no "guaranteed" wording).

###### P9 · House hunting — hold state
- **Record:** badge "Preapproved · house hunting"; Dates: "preapproval valid through {{SM_UW_DECISION_VALIDITY}}"; Needed-from-you empty; Documents: the letter.
- **Thread behaviors:**
  - "Send me the listing" (URL or address) → property pull → `StatusCard` with taxes, HOA, flood zone, estimated payment at the approved rate parameters and the buyer's down payment; refreshed letter on request (same approved amount; the letter never exceeds it). Estimates use the approved quote; if `SM_QUOTE_VALIDITY_GATE` has closed, the assistant refreshes pricing and (`assisted`) routes through MLO review before showing a new rate.
  - Weekly check-in message, opt-out available; `SM_LEAD_INACTIVITY_EXPIRY_90` applies only to leads without an application — a preapproval is an application, so instead the platform warns at `SM_UW_DECISION_VALIDITY − 14 days` and offers a refresh (SQ-09: re-pull credit if > 4 months at the projected note date; re-verify income; re-run DU).
  - **Offer accepted** → the borrower uploads the contract → C1.
- **Tests:** 32.3-T28 (a per-listing payment never renders a rate different from the approved quote without a new `mlo.review.completed` under `assisted`).

##### 4. Purchase with a signed contract (C1–C7)

Preconditions: E3 = Buy · I have a signed contract; either preapproved (P) or starting cold (then E4–E6, R2–R6, P7 run here with the address known).

###### C1 · The contract
- **Card:** `UploadCard{document_class=purchase_contract, accepted_examples: [signed purchase agreement, all addenda], why}` (camera or file). On `document.classified{purchase_contract}` → extraction → `ConfirmCard{fields: property address, purchase price, closing date, earnest money amount and holder, financing and appraisal contingency dates, seller concessions, seller name(s)}` → `purchase_contracts` row.
- **Declarations addendum:** "Do you have a relationship with the seller?" (URLA Section 5) → `declarations` update; a yes → non-arm's-length screening (22.6) with neutral copy.
- **Tests:** 32.3-T29 (contract fields count as submitted only on Confirm).

###### C2 · Address completes the application
- **Events:** address + price + loan amount confirmed → `application.trid_received` (20.3 T5: the LE is due 3 general business days after the address arrives). The TRID calendar is built back from the contract closing date: `SM_O62_CD_TARGET_4SBD`, `REGZ_1026_19E1III_LE_7SBD_GATE`, lock period recommendation.
- **Record:** badge "Application received"; Dates: LE by · closing (contract) · earliest closing (after CD).
- **DU:** resubmission with the property (`du_casefiles` update; 23.1 tolerances) → conditions refreshed.

###### C3 · Loan Estimate and companions
As R9 plus `NTC_REGX_1024_6_TOOLKIT` (Your Home Loan Toolkit) and the counseling list. Numbers show **cash to close** = down payment + costs − seller credits (LE section), not savings.

###### C4 · Proceed
As R10; system follow-ons add: appraisal (`selectMethod` — value acceptance is available on purchases; when an appraisal is required, `valuation_orders.ordered → assigned`; the appraiser coordinates access with the listing side — `HandoffCard{destination=appraiser}` and, where the buyer must be present, `ScheduleCard` — 06), HOA / condo project documents request (SQ-08 when `project_reviews.status = pending_docs`), title order with the seller's title company, flood.

###### C5 · Lock
As R11; the recommended period covers the contract closing date + 7 days; the card names the contract date.

###### C6 · Insurance selection — SQ-04-INS (first-class side quest)
- **Card:** `ChoiceCard` — **I have a quote/policy** (→ `UploadCard{homeowners_policy|binder}` or `ConnectCard{carrier_connect}`) · **Help me get quotes** (→ `HandoffCard` to the borrower's chosen agent/carrier; the platform never recommends a carrier for compensation — RESPA §8). The requirement is explained in plain language from 24.5: replacement-cost basis, deductible ≤ 5%, the mortgagee clause text ("{{partner.legal_name}}, its successors and/or assigns, c/o Supermortgage"), effective on or before closing. `conditions{owner=you}` until `hazard verified`.

###### C7 · Hand-off
`StatusCard` "Your loan is moving. You'll hear from us about the appraisal, then your Closing Disclosure at least three business days before {{contract closing date}}." → 04–07.

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

##### 6. Copy keys introduced

`entry.*`, `identity.*`, `consent.esign.*`, `consent.tcpa.*`, `consent.credit.*`, `refi.home.*`, `refi.current_loan.*`, `credit.liabilities.*`, `income.connect.*`, `income.confirm.*`, `profile.*`, `declarations.*`, `demographics.*`, `terms.pending_mlo`, `application.received`, `le.delivered`, `le.mailed`, `intent.*`, `lock.*`, `preapproval.*`, `contract.*`, `insurance.select.*` — text in 12.

#### AI agent design (AI-first)
`intake` agent owns the pre-funding thread for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

##### 5. Side quests raised in this file (definitions in 11)

| ID | Trigger | Card set |
|---|---|---|
| SQ-00 Browse | "just curious" | published ranges; soft pull (`credit.authorize{soft_pull}`, `FCRA_1681B_A3_SOFT_PULL_PURPOSE_GATE`); prequalification letter; no six-item collection |
| SQ-01 Assets requested by DU | DU funds/reserves message | `ConnectCard{plaid_assets}` → `ConfirmCard` |
| SQ-02 Explanations | inquiries ≤ 90 days; large deposits; address gaps | `ExplanationCard` per item → `inquiry_explanation` / `explanation_letter` |
| SQ-03 Non-connectable income | Truv fails / employer not covered / self-employed | typed income; `UploadCard{paystub, w2}`; self-employed → SQ-18 |
| SQ-04 Gift funds · SQ-04-INS Insurance selection | gift answered yes · purchase | `UploadCard{gift_letter, gift_transfer_evidence}` · C6 |
| SQ-05 Declarations detail | "Something applies" | 13-item checklist; waiting-period explanations |
| SQ-06 Residence history | < 2 years at current address | prior address fields |
| SQ-07 Vesting / owner mismatch | owner of record ≠ borrower | trust docs; spouse on title; recent transfer explanation |
| SQ-08 HOA / condo documents | `project_reviews.pending_docs` | `UploadCard{hoa_questionnaire, hoa_budget, hoa_dues_statement}` or HandoffCard to the HOA |
| SQ-09 Preapproval refresh | validity or document age | re-pull consent; re-verify; re-run DU |
| SQ-10 HELOC subordination | second lien present | `ChoiceCard` subordinate/pay off; HandoffCard to the HELOC lender |
| SQ-11 Cash-out seasoning | < 12 months on the note / < 6 months on title | explanation + date; rate/term alternative |
| SQ-12 Student-loan payment | $0 reported payment | `UploadCard{student_loan_statement}` optional |
| SQ-13 Frozen credit | bureau freeze | instructions per bureau; re-pull |
| SQ-14 Fraud alert | initial/extended alert | contact-method confirmation (`FCRA_605A_H_ALERT_CONTACT_GATE`) |
| SQ-15 Disputed tradeline | dispute blocks DU | explanation; dispute resolution steps |
| SQ-16 Other income | any selection | source-specific documents (award letter, court order, leases) |
| SQ-17 Non-permanent resident | citizenship answer | `UploadCard{ead|visa}` per B2-2-02 |
| SQ-18 Self-employed | income type | `ConnectCard{irs_ives}` (4506-C) + returns/P&L upload |
| SQ-19 Second borrower | any point | `InviteCard{co_borrower}`; per-party E4–E6, R2–R6; `joint_intent` before their credit |

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.3-T1 | Given a new web session, when the first assistant message renders, then it contains the automation disclosure and `lead.disclosure.delivered` is logged before any other assistant content; same for voice (spoken) and SMS (first outbound). |
| 32.3-T2 | Given the borrower types "are you a real person?", then the reply is the 20.3 T11 script and a second `lead.disclosure.delivered` row exists. |
| 32.3-T3 | Given `sessions.level = L1`, when the client requests `borrower_record` for an application with personal terms, then `numbers` is omitted and cards requiring L2+ are not created. |
| 32.3-T4 | Given L1 only, when `credit.authorize{hard_pull}` is called, then the API returns `{gate: SM_IDENTITY_IAL2_GATE}` and no `credit_authorizations` row is written. |
| 32.3-T5 | Given Stripe extracted "Jane Q. Public, 1990-04-01, 14 Elm St", when the borrower taps Edit on the address and confirms "22 Elm St", then `application_borrowers.current_address = "22 Elm St"` with `source = borrower`, and name/DOB carry `source = stripe_identity`, all with `confirmed_at`. |
| 32.3-T6 | Given an in-app voice call, when the borrower says "yes, e-delivery is fine", then no `consents{kind=esign}` row becomes `active`; the assistant sends the E-SIGN invitation link (20.3 T8). |
| 32.3-T7 | Given `consents{esign}` is `consented_pending_verification` when the LE is approved, then `disclosure.le.mailed` fires, the Record shows *Mailed*, and no `DocumentCard` for the LE is created until `active` and a re-delivery is made. |
| 32.3-T8 | Given the borrower confirms the property address, then `trid_items.property_address.present = true` and `application.trid_received` has not fired. |
| 32.3-T9 | Given two borrowers with different score models, then the UI shows the neutral re-run message and no scores; DU association is refused until re-ordered (23.1 T11). |
| 32.3-T10 | Given `credit.report.received` at 09:00 Tuesday, then `NTC_FCRA_609G_CREDIT_SCORE` is delivered by end of Wednesday (`FCRA_609G_SCORE_NOTICE_1BD`). |
| 32.3-T11 | Given Truv returns $8,200 monthly base, when the borrower confirms, then `application_income` has `amount_cents = 820000, source = payroll_connection, confirmed_at set` and `trid_items.income.present = true`; given the borrower instead types $8,000, then `source = borrower`. |
| 32.3-T12 | Given a DU validation report with `close_by_date`, then the date exists in `verifications` and nowhere in any client payload. |
| 32.3-T13 | Given the Profile card, when the borrower taps Confirm without choosing citizenship, then the card refuses and the field is not written. |
| 32.3-T14 | Given "None of these apply", then thirteen `declarations` values are `false` and `evidence.list_version_hash` is set. |
| 32.3-T15 | Given `applications.status = started` is not yet reached, when a client posts `application.answerDemographics`, then the API refuses (20.3 T12). |
| 32.3-T16 | Given the borrower selects "I do not wish to provide" for ethnicity, then `applicant_demographics.ethnicity = declined` and `collection_method = internet`. |
| 32.3-T17 | Given income confirmed at 10:02, SSN authorization at 10:03, address at 10:04, value at 10:05 and loan amount at 10:06 (ET), then `trid_application_date = 10:06` and `REGZ_1026_19E1_LE_3BD.due_at` is end of the third creditor business day after. |
| 32.3-T18 | Given the AVM card is shown and the borrower edits to $600,000, then `property_value_estimate.present = true` with `source = borrower`; given no action, then `present = false`. |
| 32.3-T19 | Given any `du.findings.received`, then no field of the findings appears in `/v1/borrower/*` responses (contract test on serializers). |
| 32.3-T20 | Given findings at 14:00, then a `ChecklistCard` with materialized conditions exists by 18:00 the same creditor business day (`SM_DU_CONDITIONS_SLA_4H`). |
| 32.3-T21 | Given `origination.ai_mlo_intake = assisted` and `terms.presentation.requested` at 08:50, then no personal rate renders before `mlo.review.completed{approved}`; the `StatusCard` shows `due_at = 09:50` (20.3 T7). |
| 32.3-T22 | Given active E-SIGN scoped to `origination_disclosures`, when the LE is approved, then the `DocumentCard` renders and `disclosure.le.delivered{channel=esign_portal}` is logged; **Confirm receipt** writes `received_at` and `receipt_evidence = esign_confirmed`. |
| 32.3-T23 | Given the borrower taps Proceed before the LE's effective receipt date, then `intent_records.valid = false`, the fee gate stays closed, and the assistant explains the order. |
| 32.3-T24 | Given no valid intent, then no lock `ComparisonCard` is created; `lock.request` returns the gate error. |
| 32.3-T25 | Given `lock.executed` on Monday, then a revised LE `DocumentCard` exists by Thursday (`REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`) and Numbers show `le_v2`. |
| 32.3-T26 | Given a preapproval request with `property = TBD`, then `application.received` fires, `application.trid_received` does not, and `REGB_1002_9_DECISION_30` runs. |
| 32.3-T27 | Given a preapproval letter is issued, then it names `partner.legal_name`, `mlo.name`/NMLSR ID, `valid_until`, the general conditions, and contains no occurrence of "guarantee". |
| 32.3-T28 | Given a preapproved borrower sends a listing at a different price, then the payment estimate uses the approved quote id; if `SM_QUOTE_VALIDITY_GATE` is closed, the new rate renders only after `mlo.review.completed{approved}` (`assisted`). |
| 32.3-T29 | Given a contract is uploaded, then extracted fields are written with `source = document_extraction` and `confirmed_at null` until Confirm; `application.trid_received` fires only after the address confirmation. |
| 32.3-T30 | Given SMS reply "yes that's my income" to a pending income `ConfirmCard`, then the card stays pending and the assistant replies with the deep link (32.1 §6.4). |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/03-entry-and-qualification.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 20.3 (lead intake), 20.4 (pricing), 21.1 (application), 21.2 (LE), 21.3 (companions), 21.4 (intent, lock), 22.1–22.6 (documents, credit, income, assets, liabilities, identity), 23.1–23.3 (DU, conditions, decision), 24.1 (valuation), 31.1 (licensing) (spec/sections/)
