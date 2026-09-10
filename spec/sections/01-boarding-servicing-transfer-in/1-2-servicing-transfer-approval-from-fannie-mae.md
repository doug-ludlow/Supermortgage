# 1.2 — Servicing transfer approval from Fannie Mae

| Attribute | Value |
|---|---|
| Section | 1 — Boarding / Servicing Transfer-In |
| Automation class | c |
| SoR / Sub | SoR |
| Trigger & frequency | Before any post-delivery transfer |
| Governing source | FNMA A2-7-03; A2-1-07 |
| Key deadlines | Per Fannie Mae approval |
| Timers | `FNMA_A2_1_07_FORM101_INCEPTION`, `FNMA_A2_1_07_FORMS_1013_1014_GATE`, `FNMA_A2_7_03_FORM2017_GATE`, `FNMA_A2_7_03_FORM629_SERVICING_60`, `FNMA_A2_7_03_FORM629_SUBSERVICING_30`, `FNMA_A2_7_03_TRANSFER_DATE_GATE`, `FNMA_IRM_TT32_TRANSFER_RECORD_15`, `FNMA_QX_LOAN_LIST_FREEZE_CD25`, `SM_FORM629_INTERNAL_BUFFER_7`, `SM_PORTAL_TASK_FORM629_SLA_2` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Boarding |
| Trigger & frequency | Before any post-delivery transfer |
| Governing source (blueprint) | FNMA A2-7-03; A2-1-07 |
| Key deadlines (blueprint) | Per Fannie Mae approval |
| Data/artifacts | Servicing Transfer Approvals submission |
| Systems | Servicing Transfer Approvals [cropped in source] — verified: Quick Exchange (Form 629) |
| Automation class (blueprint) | [cropped in source] — treated as (c) for the portal submission, (a) for package preparation |
| SoR / Sub | SoR (partner submits) [inferred from scope note] |
| Nuances (blueprint) | [cropped in source] — reconstructed: 60 vs 30 days, first-business-day transfer date, subservicer indicated on Form 629, Form 101, Forms 1013/1014 via CBAM, D-Code |

### Verified requirement (as of 2026-09-09)

**A2-7-03 (05/13/2026)**: Fannie Mae's prior written consent is required for any transfer of servicing responsibility, expressly including subservicer changes. "The transferor or transferee servicer must submit a fully completed Form 629 ... at least 60 days prior to the earlier of proposed sale or transfer date" for servicing transfers and "at least 30 days prior" for subservicing transfers; "Fannie Mae may require a longer approval timeframe based on size and portfolio characteristics." "The proposed transfer date must be the first business day of the month for which the transferee servicer will be responsible for reporting." Form 629 "must contain an applicable mortgage loan-level list containing all items mentioned in Form 629"; separate forms are needed for acquired properties, REMIC and reverse loans. The transferee must "be an approved servicer that is in good standing with Fannie Mae," "have in place appropriate controls and adequate procedures relating to transfers of servicing," and "must have a valid Master Custodial Agreement (Form 2017) in place with the document custodian." "As of the earlier of the sale date or the transfer date ... the transferor servicer and the transferee servicer acknowledge their joint and several liability with respect to all duties, selling representations and warranties, recourse and repurchase obligations"; the transferee's assumption "will in no way release the transferor servicer." "Any unauthorized transfer of servicing or subservicing will not be recognized by Fannie Mae," and Fannie Mae may "impose sanctions; impose compensatory fees; hold any transferor or transferee servicer or subservicer ... jointly and severally liable for any losses."

**A2-1-07 (05/13/2026)**: "The transferor servicer must indicate on the Request for Approval of Servicing Transfer (Form 629) if the transferee servicer will use a subservicer"; consent is required for subservicer-to-subservicer, master-to-subservicer and subservicer-to-master moves; "Fannie Mae will also evaluate the performance and capacity of any subservicer"; "the master servicer and the subservicer must execute and submit the Data Access Authorization Form (Form 101) at the inception of the subservicing arrangement" (and again at termination); "each mortgage loan that is subject to a subservicing arrangement must be identified in Fannie Mae's records"; the subservicer submits Forms 1013/1014 electronically evidencing its custodial accounts; the master confirms arrangements annually on Form 582; the subservicing agreement must acknowledge Fannie Mae's right to rescind recognition.

**F-1-11 (05/13/2026)**: "The transfer date refers to the date on which the physical transfer of the servicing ... occurs. It may not necessarily be the same date as the sale date." The transferor gives the transferee custodian "Fannie Mae's consent notice along with Form 629"; the Document Transfers Job Aid v5 (Jan. 23, 2026) says the "Fannie Mae Servicing Team issues D-Code (unique transaction identifier)" on approval and the transferor gives the transferee "Electronic Form 629 with D-Code."

**Mechanics (research/00b F11, verified there 2026-09-09)**: eTransfers retired Oct. 31, 2025; "all servicing and internal transfers must be submitted via a 629 form in Quick Exchange" (quatro.fanniemae.com); Form 629 is an Excel template plus a Custodian Matrix; no API; monthly cadence example "loan additions by CD10, deletions/attestation by CD25, processing BD3" **[PARTIALLY VERIFIED — from Fannie Mae user materials summarized in 00b; not re-fetched]**. The Investor Reporting Manual (Apr. 8, 2026) still describes a "Servicing Transfer Record (Transaction Type 32)" to be received "no later than 15 days before the effective date" and finalized "by the 25th calendar day of the month prior to the transfer effective date" **[PARTIALLY VERIFIED — legacy transaction-type mechanism; confirm whether Quick Exchange supersedes it]**.

**Discrepancies vs blueprint**: (1) "Per Fannie Mae approval" is now concrete: 30 days (subservicing) / 60 days (servicing), first business day of month; (2) system is Quick Exchange, not "Servicing Transfer Approvals" as a product name; (3) blueprint omits Form 101 at inception, Forms 1013/1014 via CBAM (mandatory Aug. 1, 2026), the Form 2017 prerequisite, the D-Code and the joint-and-several liability start date.

### Operational prerequisites
- Supermortgage approved as a Fannie Mae servicer in good standing (A2-1-07) — Supermortgage; months (research/00a §4.3).
- Partner in good standing; partner Corporate Administrator with Quick Exchange access; Supermortgage users provisioned in the partner's Technology Manager org as Related Party (or Form 101 scope covering Quick Exchange) — Partner; days.
- Executed subservicing agreement containing the A2-1-07 rescission acknowledgment and the A2-1-01 technology-provider clauses — Partner + Supermortgage; before Form 629.
- Supermortgage-established, Supermortgage-owned Fannie Mae-only custodial accounts opened at an eligible depository (A4-1-02) and Forms 1013/1014 executed in CBAM (6.1/6.2) — Supermortgage establishes and owns them per A2-1-07 ("each subservicer must establish custodial accounts for all Fannie Mae mortgage loans that it subservices for a master servicer"), executed under the partner's 9-digit servicer numbers with Form 101 access and with the partner signing wherever the form requires the servicer of record; the partner remains liable to Fannie Mae throughout; before Form 629 for a new arrangement.
- Form 2017 Master Custodial Agreement between the transferee servicer (partner) — and Supermortgage's designated custodian if custody moves — and the custodian (1.4).
- Form 101 executed by partner and Supermortgage; submitted to Technology_Registration@fanniemae.com (research/00b F14) — both; at inception.
- For a servicing sale (type `servicing_sale_with_sub`): purchase price within ±5 bps for Quick Exchange (research/00b F11) — Partner.

### Build spec
#### Inputs and triggers
- `transfer.batch.proposed` (created by the `transfer` agent from the partner's instruction: transfer type, candidate transfer date, loan list source).
- Partner-provided loan list (Fannie Mae loan numbers, servicer loan numbers, UPB, remittance type, custodian, special features) → `boarding_tapes{kind=preliminary}` or a dedicated `form629_loan_list` document.
- Fannie Mae consent notice (PDF/email) → `transfer.fnma_consent.received`; D-Code.
- Fannie Mae requests for more information → `transfer.fnma_query.received`.
- Fannie Mae Connect "Servicing Transfers Origination and Modification Data Report" pulls after approval.

#### Data model
- `transfer_batches` (1.1) plus: `form629_document_id`, `custodian_matrix_document_id`, `form629_submitted_at timestamptz`, `form629_submitted_by` (portal operator user id), `fnma_status` enum {`draft`,`submitted`,`info_requested`,`approved`,`denied`,`withdrawn`}, `fnma_conditions jsonb`, `subservicer_indicated boolean` (true), `purchase_price_bps numeric(8,4) null`, `form101_document_id`, `form1013_document_id`, `form1014_document_id`, `form2017_document_id`.
- `transfer_batch_loan_list_versions` (append-only): `batch_id`, `version int`, `document_id`, `adds int`, `deletes int`, `submitted_at`, `reason`.
- `escalations` rows of kind `human_portal_task` with `package_document_id`, `sla_timer_id`, `completed_evidence_document_id` (screenshot/confirmation number).
- Retention: `life_of_loan_plus_4y` for the Form 629 package and consent (Fannie Mae records); `respa_5y` for the transfer plan.

#### State machine
`transfer_batches.status` (batch-level `transfer_in` case): `proposed` → `package_ready` (Form 629, loan list, Custodian Matrix, Forms 101/1013/1014/2017 evidence attached; DQ pre-check on the loan list passed) → `submitted` (portal task completed; `form629_submitted_at`) → `info_requested` ⇄ `submitted` → `approved` (consent notice + D-Code) → `loan_list_frozen` (final adds/deletes attested) → `pre_boarding` (1.1/1.6 begin) → `notice_window` (1.3) → `cutover` (transfer date) → `post_transfer` (60-day window, recert, MERS) → `closed`. Exceptions: `denied` (terminal; partner decides), `withdrawn`, `on_hold` (Fannie Mae requires longer timeframe). Transitions to `submitted` require a `fnma_portal_operator` completion record; `approved` requires the consent document hash; `loan_list_frozen` requires `officer` (partner) attestation evidence.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_A2_7_03_FORM629_SUBSERVICING_30` | deadline | `transfer.batch.proposed{type∈master_to_sub,sub_to_sub}` | `transfer_date` | −30 calendar_days | `transfer.form629.submitted` | sev 1 → `officer`; transfer date must slip to the next first business day |
| `FNMA_A2_7_03_FORM629_SERVICING_60` | deadline | `transfer.batch.proposed{type=servicing_sale_with_sub}` | earlier of `sale_date`,`transfer_date` | −60 calendar_days | `transfer.form629.submitted` | same |
| `SM_FORM629_INTERNAL_BUFFER_7` | deadline | `transfer.batch.proposed` | Form 629 deadline | −7 calendar_days | `transfer.form629.submitted` | sev 2 → `transfer` agent; portal task re-prioritized |
| `SM_PORTAL_TASK_FORM629_SLA_2` | deadline | `escalation.created{kind=human_portal_task, task=form629}` | created_at | +2 business_days_servicer | `escalation.completed` | sev 2 → `officer` |
| `FNMA_IRM_TT32_TRANSFER_RECORD_15` | deadline | `transfer.batch.approved` | `transfer_date` | −15 calendar_days | `transfer.loan_list.finalized` (Fannie Mae ack) | sev 1 **[PARTIALLY VERIFIED]** |
| `FNMA_QX_LOAN_LIST_FREEZE_CD25` | deadline | `transfer.batch.approved` | 25th calendar day of month before `transfer_date` | 0 | `transfer.loan_list.attested` | sev 1 → `officer` **[PARTIALLY VERIFIED — cadence from 00b]** |
| `FNMA_A2_7_03_TRANSFER_DATE_GATE` | not_before_gate | `transfer.batch.approved` | `transfer_date` | must equal first `business_days_fannie_et` of month | assert in `proposeBatch` command | command rejected |
| `FNMA_A2_1_07_FORM101_INCEPTION` | not_before_gate | `transfer.batch.proposed{first batch for this partner}` | — | `form101_document_id` present | `transfer.form101.executed` | package cannot reach `package_ready` |
| `FNMA_A2_1_07_FORMS_1013_1014_GATE` | not_before_gate | same | — | CBAM-executed Forms 1013/1014 evidence present | `custodial.account.authorized` (6.1/6.2) | package cannot reach `package_ready` |
| `FNMA_A2_7_03_FORM2017_GATE` | not_before_gate | same | — | valid Form 2017 for transferee custodian | `custody.agreement.verified` (1.4) | package cannot reach `package_ready` |

Jurisdiction overrides: none.

#### Business rules and calculations
- Transfer-date rule: `transfer_date = firstBusinessDay(month, calendar='fannie_et')`. Worked example: October 2026 → Thursday Oct. 1, 2026. Subservicing Form 629 deadline = Oct. 1 − 30 days = **Tue Sept. 1, 2026**; internal buffer Aug. 25, 2026. For a servicing sale with sale date Sept. 15, 2026 and transfer date Oct. 1, 2026, the 60-day clock runs from the earlier date: Sept. 15 − 60 = **July 17, 2026**.
- Joint-and-several liability start = `min(sale_date, transfer_date)`; the platform records `liability_start_date` on the batch and the partner's risk register.
- Loan-list integrity: the Form 629 list is the universe; every later tape must be a subset; adds after approval require a new list version; deletes (payoffs, repurchases, foreclosures) are attested by CD25 [PARTIALLY VERIFIED cadence].
- Approval conditions (`fnma_conditions`) become gates: e.g., "custodial documents to custodian X" → 1.4 configuration; "longer timeframe" → `on_hold` with a recomputed transfer date.

#### Integrations
- **Quick Exchange (portal-only)** — `human_portal_task` package: completed Form 629 Excel (template version recorded), Custodian Matrix Excel, loan-level list, transfer type, servicer numbers, subservicer indicator = Supermortgage, sale/transfer dates, custodian details, purchase price (sales), contact e-mails, checklist of attachments, expected confirmation artifacts (submission ID/screenshot). Operator: partner user by default (open question 1). Evidence stored as `documents`.
- **E-mail intake** (`servicing_transfers@fanniemae.com` correspondence, consent notice) — `email-in` transport into `integration_messages`; the consent PDF is hashed and parsed for D-Code and conditions by the `transfer` agent, then confirmed by an `officer` before `approved`.
- **Fannie Mae Connect** report pull (API where available; else UI download by `fnma_portal_operator`) to confirm loan-level approval status.
- **CBAM (portal-only)** for Forms 1013/1014 — owned by 6.1/6.2; 1.2 only checks evidence.
- Failure handling: portal unavailability → retry within SLA; a Fannie Mae denial → `denied` and a partner decision record; no automatic resubmission.

#### Outputs and artifacts
- Form 629 package (`documents`), consent notice, D-Code, approved loan list versions, Form 101/1013/1014/2017 evidence, transfer plan (Bulletin 2020-02) — all `documents` with hashes.
- `case_events`: `transfer.form629.prepared/submitted/approved/denied`, `transfer.loan_list.finalized`.
- No borrower notices; no ledger postings; no investor events (Fannie Mae updates its servicer records on the transfer date).

#### AI agent design (AI-first)
`transfer` agent (tools: `buildForm629`, `buildCustodianMatrix`, `validateLoanList`, `createPortalTask`, `parseConsentNotice`, `computeDeadlines`, `writeDecision`, `notifyPartner`). It prepares the complete package from the partner's loan list, validates it against the preliminary tape and the Fannie Mae position (1.1 rules `HF-001`–`HF-003` in "pre-check" mode), computes every deadline, files the `human_portal_task`, tracks Fannie Mae correspondence, and drafts responses to information requests for `officer` sign-off. Escalations: `fnma_portal_operator` (submission, Connect downloads); `officer` (partner) for attestation of the loan list, acceptance of conditions, and any response to Fannie Mae; `signing_officer` is not involved. Decision record: `{batch_id, package_version, checks_run, deadline_table, portal_task_id, rationale}`. Human-path fallback: the ops-console exposes the same package builder with manual field entry.

#### Edge cases and failure modes
- Fannie Mae requires a longer timeframe: batch → `on_hold`; transfer date recomputed to a later first business day; all dependent timers recomputed (new definition instances, old ones cancelled with reason).
- Loans on the list that are in foreclosure/bankruptcy/workout: allowed, but flagged on Form 629 and pre-assigned to 1.7/13/14 case creation at boarding.
- Special products (A2-1-07): Supermortgage must be approved for them unless eMortgage/HomeStyle Renovation with limited responsibilities; unapproved special-feature loans are removed from the list.
- Custodian change and servicer change in the same transfer (D-Code) vs concurrent sale (I-Code, 30-day recert): the batch stores `recert_code_type`.
- Denial or non-recognition: nothing boards; any pre-transfer notices already sent (1.3) require a corrective notice to borrowers (rare; `officer` decision).
- Partner-initiated cancellation after goodbye notices: same corrective-notice path.

#### Test cases and acceptance criteria
- 1.2-T1 Given a master-to-sub batch with transfer date Oct. 1, 2026, when proposed on Aug. 20, 2026, then `FNMA_A2_7_03_FORM629_SUBSERVICING_30` due = Sept. 1, 2026 and `SM_FORM629_INTERNAL_BUFFER_7` = Aug. 25, 2026.
- 1.2-T2 Given a proposed transfer date of Oct. 2, 2026, then the `proposeBatch` command is rejected by `FNMA_A2_7_03_TRANSFER_DATE_GATE`.
- 1.2-T3 Given a servicing sale with sale date Sept. 15, 2026, then the 60-day deadline anchors on Sept. 15 (July 17, 2026), not on the transfer date.
- 1.2-T4 Given no Form 101 evidence for a first batch, then the batch cannot reach `package_ready`.
- 1.2-T5 Given the portal task is not completed within 2 servicer business days, then an `officer` escalation is created and the batch report shows the breach.
- 1.2-T6 Given a consent notice with conditions, when parsed, then `approved` is blocked until an `officer` confirms the parsed D-Code and conditions.
- 1.2-T7 Given a loan on the approved list that pays off Sept. 20, 2026, then it is `withdrawn`, a new loan-list version is created, and the CD25 attestation timer is satisfied only by an attested version.

#### Audit and evidence
Package versions and hashes, portal-task completion evidence (submission ID, timestamp, operator), consent notice, D-Code, loan-list attestations, all deadline timers with satisfying events, `agent_decisions` for the package build and correspondence drafts, and the partner's approval records (Form 582 annual confirmation cross-reference, 18.4).

### Open questions / decisions
1. Who clicks in Quick Exchange — partner employee (default; Consolidated Technology Guide credential rules) or Supermortgage `fnma_portal_operator` under Related-Party authorization (requires Form 101 scope to include Quick Exchange).
2. ~~Whether Supermortgage's own custodial accounts or the partner's accounts are named on Forms 1013/1014 for the batch.~~ **Resolved (6.1): Supermortgage's.** A2-1-07 requires each subservicer to establish custodial accounts for the Fannie Mae loans it subservices, so Supermortgage's accounts are named on Forms 1013/1014 and are the 1.6 funds-transfer destination; the partner executes where the form requires the servicer of record and stays liable to Fannie Mae. No batch-level variation.
3. Confirm whether the IRM Transaction Type 32 / CD25 cadence still applies post-eTransfer retirement (default: treat CD25 as the internal freeze date).

### Sources
- Servicing Guide A2-7-03 (05/13/2026): https://servicing-guide.fanniemae.com/svc/a2-7-03/post-delivery-servicing-transfers
- Servicing Guide A2-1-07 (05/13/2026): https://servicing-guide.fanniemae.com/svc/a2-1-07/subservicing
- Servicing Guide F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
- Fannie Mae Servicing Transfer Approval page (Quick Exchange, Form 629 template, Custodian Matrix): https://singlefamily.fanniemae.com/applications-technology/servicing-transfer-approval
- Document Transfers Job Aid v5 (Jan. 23, 2026): https://singlefamily.fanniemae.com/media/6966/display
- Investor Reporting Manual (Apr. 8, 2026): https://singlefamily.fanniemae.com/media/7816/display
- research/00b F10, F11, F14; research/00a §4.1–4.2.
