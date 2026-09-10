# 4.2 — Request for Information (RFI)

| Attribute | Value |
|---|---|
| Section | 4 — Customer Service & Borrower Communications |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On borrower RFI (any written request for information; continuous) |
| Governing source | Reg X 1024.36 |
| Key deadlines | Acknowledge ≤5 BD; respond ≤30 BD (+15); owner/assignee identity ≤10 BD |
| Timers | `NY_419_6_RFI_DOCS_15BD`, `NY_419_6_RFI_OWNER_10D`, `REGX_1024_36C_RFI_ACK_5`, `REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30`, `REGX_1024_36D_RFI_OWNER_10`, `REGX_1024_36D_RFI_RESPONSE_30`, `REGX_1024_36E_RFI_EARLY_RESPONSE_5`, `REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5`, `REGX_1024_36I_SII_RFI_RESPONSE_30`, `SM_RFI_INTERNAL_TARGET_7`, `SM_RFI_SII_DOCS_TARGET_5` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Customer Service |
| Trigger & frequency | On borrower RFI (any written request for information; continuous) |
| Governing source (blueprint) | Reg X 1024.36 |
| Key deadlines (blueprint) | Acknowledge ≤5 BD; respond ≤30 BD (+15); owner/assignee identity ≤10 BD |
| Data/artifacts | RFI log |
| Systems | Case mgmt |
| Automation class (blueprint) | b |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Source verified:** 12 CFR 1024.36 (eCFR, current as of Sept. 3, 2026; last amended 81 FR 72371, Oct. 19, 2016); Supplement I comments 36(a)-1, 36(a)-2, 36(b)-1 to -4, 36(d)(1)(ii)-1 and -2, 36(f)(1)(i)-1 to 36(f)(1)(iv)-1, 36(i)-1 to -3; 12 U.S.C. 2605(e), (k)(1)(D); Fannie Mae A4-1-03 (12/20/2023).

**Scope (§1024.36(a)).** Any *written* request that includes the borrower's name, information enabling the servicer to identify the account, and "states the information the borrower is requesting with respect to the borrower's mortgage loan." Excluded: requests on a payment coupon/payment medium supplied by the servicer, and a **request for a payoff balance** (governed instead by 12 CFR 1026.36(c)(3) — see 7.6/16.1). A QWR requesting servicing information is an RFI. Comment 36(a)-1: agent's request = borrower's request (documentation of authority may be required). Comment 36(a)-2 (owner/assignee identity): for a loan not held in trust, identify "the person on whose behalf the servicer receives payments"; for a trust with an appointed trustee, give the trust name and the trustee's name, address and contact information; **where Fannie Mae or Freddie Mac is the owner or trustee**, the servicer complies by giving Fannie Mae's/Freddie Mac's name and contact information "without also providing the name of the trust" *unless the borrower expressly requests the trust name*, in which case the trust name and trustee contact must be given.

**Exclusive address (§1024.36(b); comments 36(b)-1 to -4).** Same rules as §1024.35(c) and, by rule, the *same* address; online intake in addition to mail; multiple offices permitted.

**Clocks — "days (excluding legal public holidays, Saturdays, and Sundays)":**
- Acknowledgment (§1024.36(c)): **5** days.
- Response (§1024.36(d)(2)(i)): (A) **10** days for a request for "the identity of, and address or other relevant contact information for, the owner or assignee of the mortgage loan"; (B) **30** days for all other requests.
- Extension (§1024.36(d)(2)(ii)): **+15** days for (B) requests only, with written notice of the extension and reasons before the 30 days end; **no extension** for owner-identity requests.
- Early response (§1024.36(e)): if the information with contact details is provided in writing within **5** days, (c) and (d) do not apply.
- Exception notice (§1024.36(f)(2)): within **5** days of the determination, stating the basis.

**Response content (§1024.36(d)(1)).** Either (i) provide the requested information with contact information including a telephone number, or (ii) after "a reasonable search," notify the borrower in writing that the information "is not available to the servicer," with the basis and contact information. Comment 36(d)(1)(ii)-1: information is not available if it is "not in the servicer's control or possession" or "cannot be retrieved in the ordinary course of business through reasonable efforts"; comment -2 examples: organized and accessible audio recordings are available; electronic back-up media requiring extraordinary efforts are not; offsite storage the servicer can access with reasonable efforts is available.

**Omissions (§1024.36(d)(3)).** The servicer may omit location and contact information and personal financial information (other than loan terms, status and payment history) about (i) a potential or confirmed successor in interest who is not the requester, or (ii) any borrower other than the requester when the requester is a confirmed successor in interest.

**Exceptions (§1024.36(f)(1)).** (i) **duplicative** (substantially the same information previously requested and answered; comment 36(f)(1)(i)-1: requests for the same information for different periods are not duplicative); (ii) **confidential, proprietary or privileged** (comment 36(f)(1)(ii)-1 examples: management/profitability data, compensation/personnel information, exam/audit records, attorney-client privileged material); (iii) **irrelevant** — "not directly related to the borrower's mortgage loan account" (comment 36(f)(1)(iii)-1 examples: other borrowers' loans, aggregate collection data, training programs, servicing guides, "investor instructions or requirements for servicers regarding criteria for negotiating or approving any program"); (iv) **overbroad or unduly burdensome** (unreasonable volume; or cannot be answered within the time limits without unreasonable cost/resources — comment 36(f)(1)(iv)-1 examples: everything-about-the-loan requests, discovery-style requests, requests in a format the servicer does not ordinarily keep (transcript, spreadsheet), requests unlikely to assist the borrower); the servicer must still answer any identifiable, non-burdensome portion; (v) **untimely** — more than **1 year** after transfer to a transferee or discharge.

**Fees (§1024.36(g)).** No fee or payment may be a condition of responding, except a fee for a beneficiary notice under applicable state law where not otherwise prohibited. **Remedies (§1024.36(h)):** an open RFI does not bar adverse credit reporting or foreclosure.

**Potential successors (§1024.36(i)).** A written request from a person indicating they "may be a successor in interest," naming the transferor borrower and identifying the loan, must be answered with a written description of the documents the servicer "reasonably requires" to confirm identity and ownership interest, plus contact information; the potential successor is treated as a borrower for (c)–(g). If the request lacks enough detail to identify the required documents, the response may give examples of typically accepted documents, say a more individualized list is available with more information, specify what is needed, and give contact information; a later oral or written supply of that information restarts a new, non-duplicative request as of the date received. The servicer need not provide other information before confirmation and must say the person may resubmit once confirmed; if an exclusive address exists, (i)(1) applies only to requests received there. Comment 36(i)-1 examples of indicators: statements about a transfer of ownership, divorce/legal separation, death of the borrower, or a loss-mitigation application from a non-borrower; comment 36(i)-2: the §1024.36(d)(2) time limits apply and policies must "promptly determine" the documents; comment 36(i)-3: a representative's authority may be documented. (Workflow in 4.4.)

**Statute:** 12 U.S.C. 2605(k)(1)(D) — failure to respond "within 10 business days" to an owner/assignee identity request is a per-se violation with §6(f) damages. **Fannie Mae A4-1-03:** owner identification wording — portfolio loans: "Fannie Mae," Midtown Center, 1100 15th Street NW, Washington, DC 20005, 1-800-2FANNIE (1-800-232-6643); MBS loans: "Fannie Mae in its capacity as Trustee," same address/phone, with the six-digit pool number as the trust identifier on request; the response must state that ownership status is "based upon the servicer's review of its records as of a date certain" and may change. **NY 419.6:** owner/note-holder contact within 10 days of a written request; documents within 15 business days.

**Discrepancies vs. blueprint row.** Day counting (federal-holiday exclusion, not business days); payoff-balance requests are *not* RFIs (7-business-day Reg Z clock instead); the row omits the 5-day exception notice, the early-response alternative, the (d)(3) omission rules, the (f) exception taxonomy and the successor-in-interest RFI path.

### Operational prerequisites
- Same exclusive address, mail-scanning, print/mail, e-delivery, holiday calendar and NY disclosure items as 4.1.
- **Owner/assignee master data**: `loans.investor_ownership` ∈ {fnma_portfolio, fnma_mbs_trust} with pool number, sourced from boarding (1.1) and LSDU/Servicing Platform data (5.x); Fannie Mae contact block from A4-1-03 stored as a versioned reference record (`reference_contacts.fnma_owner_block`, reviewed at each Guide edition).
- **Records inventory** (`security-records`): index of where each record type lives (ledger, notices, recordings, imaged documents, prior-servicer transfer file, offsite/back-up), with an `availability_class` ∈ {online, offsite_reasonable, backup_extraordinary, not_possessed} driving the "reasonable search" logic and the (d)(1)(ii) basis text.
- **Beneficiary-notice fee schedule** by state (e.g., statutory payoff/beneficiary statement fees) in `jurisdiction_rules.beneficiary_notice_fee` **[UNVERIFIED per state]** — only such a fee may ever be charged in connection with an RFI.

### Build spec
#### Inputs and triggers
- `communication.classified` with kind `rfi` (and/or `noe` — both cases open, comment 35(a)-2) → `case.rfi.opened`.
- `case.rfi.request_items.identified` (one row per requested item).
- `case.rfi.supplement.received` (borrower/potential successor supplies information; for §1024.36(i)(2) this restarts the clock as a new request).
- `records.search.completed` (from `security-records` tools).
- Schedules: `timer.warning` at 70% elapsed; daily sweep.

#### Data model
Reuses 4.1 tables. Additions:
- `cases` (`case_type='rfi'`): `deadline_profile` ∈ {owner_10, std_30, early_5, sii_docs_30}, `is_potential_successor_request bool`, `requester_role` ∈ {borrower, agent, confirmed_successor, potential_successor}, `omissions_applied jsonb` (which (d)(3) omissions were made and why).
- `case_request_items` — `id`, `case_id`, `seq`, `item_kind` ∈ {owner_identity, payment_history, escrow_statement_copies, note_copy, security_instrument_copy, assignment_chain, servicing_notes, call_recordings, fee_itemization, lossmit_file, foreclosure_file, insurance_info, tax_info, transfer_records, other}, `description`, `period_start`, `period_end`, `determination` ∈ {provided, not_available, exception_duplicative, exception_confidential, exception_irrelevant, exception_overbroad, exception_untimely, deferred_until_confirmation}, `not_available_basis`, `documents_provided uuid[]`, `search_log jsonb`.
- `records_inventory` — `record_type`, `system`, `availability_class`, `retrieval_sla_days`, `owner_agent`.
- Retention: `regx_1y_post_transfer` minimum; elevated to `life_of_loan_plus_4y`. PII: responses to a confirmed successor or agent must pass the (d)(3)/GLBA redaction step (redaction log stored on the case).

#### State machine
`received → triaged → (exception_pending | searching | early_response | awaiting_confirmation_sii) → (extended)? → responded → closed`. Guards: `searching → responded` requires each `case_request_items.determination` set and, for `not_available`, a `search_log` covering every `records_inventory` system where the record type could exist; `extended` only for `std_30`; `awaiting_confirmation_sii` is the §1024.36(i)(3) deferral (respond with the document description and the resubmit-after-confirmation statement, then close); redaction step mandatory before send when `requester_role ≠ borrower` or co-borrower data is involved.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_36C_RFI_ACK_5` | deadline | `case.rfi.opened` | receipt_date | 5 `business_days_federal` | `notice.sent` (`NTC_REGX_36C_ACK`) or early response or exception notice | `officer` sev-2; auto-send |
| `REGX_1024_36D_RFI_OWNER_10` | deadline | `case.rfi.opened` with an `owner_identity` item | receipt_date | 10 `business_days_federal` | `case.rfi.responded` (owner item) | `officer` sev-1 (RESPA §6(k)(1)(D)) |
| `REGX_1024_36D_RFI_RESPONSE_30` | deadline | `case.rfi.opened` (`std_30`) | receipt_date | 30 `business_days_federal` (+15 on `case.rfi.extended`) | `case.rfi.responded` | `officer` sev-1 |
| `REGX_1024_36D_RFI_EXT_NOTICE_BEFORE_30` | must-act-before gate | `case.rfi.opened` (`std_30`) | receipt_date | 30 `business_days_federal` | `notice.sent` (`NTC_REGX_36D_EXTENSION`) | extension refused after due |
| `REGX_1024_36E_RFI_EARLY_RESPONSE_5` | deadline (optional path) | `case.rfi.early_response.started` | receipt_date | 5 `business_days_federal` | `notice.sent` (`NTC_REGX_36E_EARLY`) | revert to std path |
| `REGX_1024_36F2_RFI_EXCEPTION_NOTICE_5` | deadline | `case.rfi.exception_determined` | determination date | 5 `business_days_federal` | `notice.sent` (`NTC_REGX_36F2_EXCEPTION`) | `officer` sev-2 |
| `REGX_1024_36I_SII_RFI_RESPONSE_30` | deadline | `case.rfi.opened` with `is_potential_successor_request` | receipt_date (or supplement date per (i)(2)) | 30 `business_days_federal` (10 if the request also asks owner identity) | `notice.sent` (`NTC_REGX_36I_SII_DOCS`) | `officer` sev-1 |
| `SM_RFI_SII_DOCS_TARGET_5` | deadline (policy; §1024.38(b)(1)(vi)(B) "promptly") | same | receipt_date | 5 `business_days_federal` | same | warning |
| `NY_419_6_RFI_OWNER_10D` | jurisdiction override (NY) | as owner timer | receipt_date | 10 `calendar_days` (419.6 says "10 days") | same | as owner timer |
| `NY_419_6_RFI_DOCS_15BD` | jurisdiction override (NY) | document requests | request date | 15 `business_days_servicer` | documents sent | `officer` sev-2 |
| `SM_RFI_INTERNAL_TARGET_7` | policy | `case.rfi.opened` | receipt_date | 7 `business_days_federal` | responded | queue priority |

#### Business rules and calculations
1. **Item decomposition.** Each distinct information ask becomes a `case_request_items` row with its own profile; an owner-identity item inside a broad letter is answered within 10 days even if the rest takes 30 (+15). Worked example: letter received Fri **2026-09-04** asking (a) who owns the loan and (b) a complete payment history since origination in 2019: ack due 2026-09-14; item (a) due **2026-09-21** (10 federal BD, Labor Day excluded); item (b) due **2026-10-20**, extendable to **2026-11-10** with notice on or before 2026-10-20.
2. **Owner-identity answer** (comment 36(a)-2; A4-1-03): `fnma_portfolio` → "Fannie Mae" + address/phone; `fnma_mbs_trust` → "Fannie Mae in its capacity as Trustee" + address/phone; add the trust/pool identifier only if the borrower expressly asked for the trust name; always add the "as of a date certain … may change" sentence and the servicer's own contact block. MERS is never named as owner; if the borrower asks for the *note holder/assignee of record*, answer with Fannie Mae plus the MERS MIN status as recorded (16.4/1.5 data).
3. **Reasonable search.** For each item, enumerate `records_inventory` rows for the record type; `online` and `offsite_reasonable` must be searched; `backup_extraordinary` and `not_possessed` support a (d)(1)(ii) "not available" answer whose basis names the class. Audio recordings are provided if indexed by loan (they are); transcripts are provided instead of audio only if the borrower asked for "records of calls" rather than recordings (design choice; comment 36(f)(1)(iv)-1 allows declining formats not ordinarily kept — we keep both).
4. **Exceptions.** Irrelevant: Fannie Mae Servicing Guide excerpts and SMDU decision criteria are "investor instructions … criteria for negotiating or approving any program" and are excepted — but the *borrower's own* loss-mit evaluation inputs and result are relevant and provided (they are also required under 12.x/§1024.41). Overbroad/unduly burdensome: >5,000 pages or >40 staff-hours estimated → `exception_overbroad` for the residue, with the identifiable portion answered; confidential/privileged: legal opinions, exam findings, vendor pricing; duplicative: same item + same period answered within the last 12 months.
5. **Omissions/redaction.** Requester = confirmed successor → omit other borrowers' location/contact and personal financial information except loan terms, status and payment history; requester = borrower → omit potential/confirmed successor personal data; requester = agent → provide as to the borrower only. GLBA (19.2) applies to everything else.
6. **Fees.** None, except a state-authorized beneficiary-notice fee from `jurisdiction_rules` (currently none loaded — **[UNVERIFIED]**).
7. **Cost/volume metric:** page counts and retrieval times are recorded per item for the overbroad test and for STAR/complaint analytics.

#### Integrations
Same channels as 4.1 (mail scanning, print/mail, e-delivery, telephony). Internal read tools add `recordings.search`, `documents.export` (bundling with Bates-style numbering), `custodian.request_copy` (note/security instrument copies via the custodian adapter, 00b N8, when only the custodian holds the original — an `offsite_reasonable` class with a 10-BD SLA, which is why the 15-day extension exists), `mers.min_status`. Fannie Mae: no submission; A4-1-03 contact block is reference data. Prior/transferor servicer: records request through the transfer agreement (1.x) for pre-transfer periods; if not received in time, respond with what is held, state that pre-transfer records were requested from the prior servicer and will be forwarded when received, and keep the item open (documented as reasonable search).

#### Outputs and artifacts
Notices: `NTC_REGX_36C_ACK`; `NTC_REGX_36D_RESPONSE` (with attachments index), `NTC_REGX_36D_NOT_AVAILABLE` (basis text), `NTC_REGX_36D_EXTENSION`, `NTC_REGX_36E_EARLY`, `NTC_REGX_36F2_EXCEPTION` (basis per item; includes what *was* provided), `NTC_REGX_36A2_OWNER_IDENTITY` (Fannie Mae block per A4-1-03; NY variant adds 419.6 text), `NTC_REGX_36I_SII_DOCS` (document description; examples path; resubmit-after-confirmation statement). Channel rule: e-delivery only with `esign` consent for `regx_correspondence`; document bundles > 50 pages default to the secure message center when consented, else mail. Records: `case_request_items`, search logs, redaction log, `v_rfi_log` (receipt, items, deadlines, dates met, determinations, exception bases, page counts).

#### AI agent design (AI-first)
- `case` agent performs intake decomposition, search orchestration (calling `security-records` tools), exception analysis, redaction, drafting and sending. Decision record per item: `{item_id, rule_set_version, model_version, records_inventory_rows_searched[], found, exception_basis?, omission_rules_applied[], confidence}`.
- Guardrails: cannot mark `not_available` without a search log covering the mandatory classes; cannot apply `irrelevant` to the borrower's own account records; cannot send an owner-identity answer that deviates from the versioned Fannie Mae block; must redact per (d)(3) before send (automated PII detector + rule table; a failed redaction check blocks the send).
- Human touchpoints: none legally required. Policy: `officer` review when the request comes from an attorney/litigation, a regulator, or asks for exam/audit/privileged material (privilege calls are made by counsel — `attorney` role, retained counsel — before anything is withheld as privileged); `human_agent` when the borrower asks for a person. `case.ai_path=off` exposes the same tools to `human_agent`.
- Oral requests for information are answered live by `borrower-comms` (AI voice/chat) from the same tools, logged as `contacts`, with the §1024.38(b)(5) reminder that the written procedure exists if the borrower is not satisfied.

#### Edge cases and failure modes
- **Transfer-in/out:** open RFIs board with receipt dates; pre-transfer records requested from the transferor; untimeliness clock uses the transferor's transfer-out date only for transferor-period information.
- **Bankruptcy:** respond to the debtor and counsel; no collection language.
- **Deceased borrower / estate:** an executor with letters is the borrower's representative (comment 36(a)-1); a person without letters is a potential successor (4.4).
- **Co-borrower requests:** each borrower is a "borrower"; no (d)(3) omission between co-borrowers who are both obligors (design: provide, since both are borrowers), except location information when a domestic-violence/confidentiality flag is set (policy flag `party.address_confidential`) **[design choice, not rule-derived]**.
- **Requests for the "original wet-ink note"/"proof of standing":** provide the note copy from imaging/custodian and the assignment chain; the demand to "produce the original" is answered by explaining what is held and where (custodian) — not an exception, and not a promise to ship originals.
- **Recording retention gaps:** if a requested call predates retention, answer "not available" with the retention basis.
- **Vendor outages/bounces:** as 4.1.
- **NPRM switch-on:** no §1024.36 changes proposed; language-access rules would apply to "specified" communications only.

#### Test cases and acceptance criteria
- **4.2-T1:** Given a letter received 2026-09-04 asking for the owner, then `NTC_REGX_36A2_OWNER_IDENTITY` is sent by 2026-09-21 with the exact A4-1-03 block for the loan's ownership type and the "as of" sentence.
- **4.2-T2:** Given the same letter also asks for a payment history since 2019, then the history item is due 2026-10-20 and the extension command before that date moves it to 2026-11-10 with an extension notice stating reasons.
- **4.2-T3:** Given an extension attempted on an owner-identity item, then rejected `EXTENSION_NOT_PERMITTED`.
- **4.2-T4:** Given a request for "all Fannie Mae guidelines you used," then `exception_irrelevant` for the guidelines and the borrower's own evaluation results are provided; (f)(2) notice within 5 federal BD.
- **4.2-T5:** Given a request for call recordings from 14 months ago within retention, then audio files are provided (secure message if consented, else mailed media/transcript per policy) within 30 days.
- **4.2-T6:** Given a confirmed successor requests the payment history, then the response omits the deceased borrower's SSN/contact/financial data but includes terms, status and history; redaction log present.
- **4.2-T7:** Given a potential successor's letter naming the deceased borrower, then `NTC_REGX_36I_SII_DOCS` is sent within 5 federal BD (policy) and no later than 30; an `sii` case opens (4.4); no account information is disclosed.
- **4.2-T8:** Given a request identical to one answered 3 months ago for the same period, then duplicative exception; for a new period, answered.
- **4.2-T9:** Given a discharge 13 months before receipt, then untimely notice within 5 federal BD.
- **4.2-T10:** Given the custodian copy request takes 12 BD, then the case uses the extension and responds within 45 total days; the extension notice cites the custodian retrieval.
- **4.2-T11 (early response):** Given a simple escrow-statement copy request answered on day 3, then the ack timer cancels with reason `early_response`.
- **4.2-T12 (NY):** Given a NY loan, then owner identity is due in 10 calendar days if earlier than the federal 10-BD date, and the response carries the 419.6 disclosure block.
- **4.2-T13 (privilege):** Given a request for "your legal analysis of my foreclosure," then the item routes to `attorney` for a privilege determination and the withholding notice issues within the clock.

#### Audit and evidence
Per item: search log with `records_inventory` rows and timestamps, documents provided (hashes, page counts), redaction log, exception basis and reviewer (if any), notices with delivery evidence, timer history. Portfolio: `v_rfi_log`, timeliness by profile, exception rates, custodian retrieval SLA performance, owner-identity response accuracy checks (monthly sample against LSDU/Servicing Platform ownership).

### Open questions / decisions
1. **4.2-Q1 Recordings format.** Default: provide audio files (secure message) or a transcript by mail when no e-consent; both are "ordinarily kept."
2. **4.2-Q2 Overbroad thresholds** (5,000 pages / 40 staff-hours). Default as stated; review after 6 months of data.
3. **4.2-Q3 Co-borrower omission policy** (see edge cases). Default: no omission between obligors absent a confidentiality flag.
4. **4.2-Q4 Beneficiary-notice fees by state** — load only with counsel sign-off; default none.

### Sources
- 12 CFR 1024.36 (eCFR, current as of Sept. 3, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.36 (verified 2026-09-09)
- Supplement I, §1024.36 comments: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024 (verified 2026-09-09)
- 12 U.S.C. 2605(k)(1)(D): https://www.law.cornell.edu/uscode/text/12/2605 (verified 2026-09-09)
- Fannie Mae Servicing Guide A4-1-03 (12/20/2023): https://servicing-guide.fanniemae.com/svc/a4-1-03/addressing-borrower-inquiries-and-disputes (verified 2026-09-09)
- 3 NYCRR 419.6: https://regulations.justia.com/states/new-york/title-3/chapter-iii/subchapter-b/part-419/section-419-6/ (verified 2026-09-09)
- research/00b-integration-landscape.md N8 (custodian), N9 (print/mail).
