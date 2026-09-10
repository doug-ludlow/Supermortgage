# 1.5 — MERS transfer of servicing/beneficial rights

| Attribute | Value |
|---|---|
| Section | 1 — Boarding / Servicing Transfer-In |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On transfer |
| Governing source | MERS Rules of Membership |
| Key deadlines | Per MERS timelines |
| Timers | `MERS_ANNUAL_REPORT_1231`, `MERS_PROC_REGISTER_UNREGISTERED_7`, `MERS_PROC_SUBSERVICER_MIN_UPDATE_T0`, `MERS_PROC_TOS_CONFIRM_7`, `MERS_PROC_TOS_INITIATE_T0`, `MERS_QA_MRE_RECON_MONTHLY`, `MERS_RULE7_LOCKOUT_WARNING_30`, `MERS_RULE7_VIOLATION_RESPONSE_30`, `SM_MERS_INVESTOR_FNMA_CHECK`, `SM_MERS_POST_TRANSFER_VERIFY_3` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Boarding |
| Trigger & frequency | On transfer |
| Governing source (blueprint) | MERS Rules of Membership |
| Key deadlines (blueprint) | Per MERS timelines |
| Data/artifacts | MIN update |
| Systems | MERS [cropped in source] |
| Automation class (blueprint) | [cropped in source] — treated as (a) |
| SoR / Sub | [cropped in source] — Partner is Servicer on MIN; Supermortgage is named Subservicer |
| Nuances (blueprint) | [cropped in source] — reconstructed: subservicer designation vs TOS, investor (Fannie Mae) check, 7-day registration, QA/Annual Report, Rule 7 remediation |

### Verified requirement (as of 2026-09-09)

**MERS System Rules of Membership (effective June 30, 2025)**: Rule 2 §2 — each Member "shall register or cause to be registered each of its MERS Loans on the MERS® System"; Rule 2 §3 — "for a MERS Loan to remain active in the MERS® System, the designated Servicer and Note Owner must be Members," and transfer of servicing or beneficial rights to a non-Member "shall require the Deactivation"; Rule 2 §4 — Members "shall maintain an adequate quality assurance program" and "promptly correct" discrepancies; Rule 7 §1(b) — on a Violation notice MERSCORP allows "30 days to provide a response and to remediate the Violation," then a 30-day Lockout Warning Period (§1(e)); Rule 8 §1(d) — the Note Owner or its Servicer "shall cause the Signing Officer to execute the assignment ... before initiating foreclosure proceedings"; Rule 2 §7 — releases per the Procedures. The Rules contain no day count for reflecting a transfer.

**MERS System Procedures Manual (Release 24.2, effective Nov. 17, 2024)**: "A MOM loan must be registered no later than seven (7) calendar days after the Note Date"; "the purchaser of an unregistered MERS Loan must take the necessary steps to ensure that it is registered ... no later than seven (7) calendar days after the date upon which the purchaser begins servicing the loan"; "a Servicer is not required to name a Subservicer on its registered loans"; "if a Servicer needs its Subservicer to process transactions and/or receive mail service on its behalf, the Subservicer must be a Member and be named on the relevant MIN Records"; "the Servicer of a MERS Loan is responsible for complying with the requirements set forth in the Governing Documents. These responsibilities remain with the Servicer even if a Subservicer or Vendor is named"; only the Servicer or Subservicer can update a MIN from the seventh day after registration; "the Member performing the MIN Update must validate that the data being updated on MERS® System matches the corresponding data on its System of Record"; TOS is initiated by the (transferor) Servicer; TOB has Option 1/Option 2 variants; a resigning Member must remove its Org ID from the Subservicer field. The manual's TOS confirmation window could not be retrieved in full; one extraction reads "the transfer will be automatically confirmed if no rejection is received within seven (7) calendar days" **[UNVERIFIED — confirm in the MERS System Integration Handbook / Procedures Manual TOS section before build]**.

**Fannie Mae**: Selling Guide B8-7-01 (05/01/2024) — a loan registered after Fannie Mae purchase must name "Fannie Mae as the investor during registration"; "for each MERS-registered loan delivered to a document custodian, the seller/servicer must indicate the MIN on the security instrument"; MERS notifies Fannie Mae of deactivations. Servicing Guide F-1-11 — MERS loans moving to a non-MERS servicer need an assignment from MERS and MIN deactivation (not applicable to Supermortgage, a Member). Research/00b N1: Subservicers "must be active Members if named on loans"; MERS Annual Report due Dec. 31 with an independent third-party review at ≥1,000 active MINs; monthly reconciliation via the Member Reconciliation Extract for larger servicers **[PARTIALLY VERIFIED — thresholds from 00b, not re-fetched]**.

**Discrepancies vs blueprint**: (1) "MERS Rules of Membership" carry no transfer timeline — the operative timing lives in the Procedures Manual/Integration Handbook (member-only), and the exact TOS confirmation window is unverified; (2) for master-to-sub and sub-to-sub moves there is **no TOS/TOB at all** — the MIN's Servicer stays the partner and only the Subservicer field changes; TOS applies only to `servicing_sale_with_sub`; TOB never applies (investor remains Fannie Mae); (3) the blueprint omits the 7-day registration duty for unregistered loans and the Rule 7 30/30-day remediation clock.

### Operational prerequisites
- Supermortgage MERS membership (General or Patron tier appropriate to volume) with Subservicer role, 7-digit Org ID, Phase II onboarding (procedures call, QA plan, test transactions) — Supermortgage; 2–4 weeks (research/00b N1).
- Batch interface (flat-file FTP/VPN or XML system-to-system) certified with MERS; layouts from the MERS System Integration Handbook **[member-only; UNVERIFIED]** — Supermortgage.
- Partner authorization letter allowing Supermortgage to submit MIN Updates/TOS confirmations on the partner's behalf, or the partner's own batch submission capability (decision 1) — Partner.
- Corporate Resolution Management System entries for Supermortgage signing officers under the partner's MERS resolutions (for 13.3/16.3) — Partner; before first foreclosure/lien release.
- MERS QA plan and Annual Report calendar for both Org IDs — Partner and Supermortgage.

### Build spec
#### Inputs and triggers
- `transfer.batch.approved` → MERS plan by transfer type.
- `transfer.tape.received{kind=preliminary/final}` with MINs → pre-validation (`HF-008`).
- MERS inbound: batch acknowledgments, reject reports, pending-transfer notices (for TOS confirmation), Member Reconciliation Extract, mail-service notices.
- `loan.boarded{min is null, mers_eligible}` → registration duty (7 days).
- Violation notices from MERSCORP → Rule 7 timers.

#### Data model
- `mers_transactions` (append-only): `id`, `batch_id`, `loan_id`, `min char(18)`, `txn_type` enum {`min_update_subservicer`,`tos_initiate`,`tos_confirm`,`tob_confirm`,`registration`,`deactivation`,`min_update_other`}, `effective_date date`, `submitted_at`, `submitted_by_org_id char(7)`, `channel` enum {flat_file, xml, ui}, `status` enum {prepared, submitted, accepted, rejected, confirmed, cancelled}, `mers_reject_code text`, `file_document_id`.
- `mers_min_snapshots`: `min`, `as_of`, `status`, `servicer_org_id`, `subservicer_org_id`, `investor_org_id`, `note_owner_org_id`, `registration_date`, `mom boolean`, `source` enum {mers_batch, mers_link, mre}.
- `mers_qa_findings`: `kind` enum {`mre_mismatch`,`violation_notice`,`annual_report_exception`}, `raised_at`, `due_at`, `resolved_at`.
- `loans.min`, `loans.mers_registered boolean`, `loans.mers_servicer_org_id`, `loans.mers_subservicer_org_id`.
- Retention `life_of_loan_plus_4y` (MERS transaction evidence supports foreclosure/lien-release chain).

#### State machine
Per loan (`mers` sub-state on `transfer_batch_loans`): `pending_plan` → `validated` (`HF-008`) → `prepared` (transaction rows built) → `submitted` → `accepted`/`rejected` → (`confirmed` for TOS) → `verified` (post-effective snapshot shows Servicer = partner, Subservicer = Supermortgage, Investor = Fannie Mae) → `done`. `rejected` → `exception` (1.1 queue) → `prepared`. Non-MERS loans → `not_applicable`. Transitions: `transfer` agent; TOS confirmation on the buyer side requires the partner's MERS credentials or Supermortgage under authorization (decision 1).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `MERS_PROC_SUBSERVICER_MIN_UPDATE_T0` | deadline | `transfer.batch.approved{type∈master_to_sub,sub_to_sub}` | `transfer_date` | 0 (submit in the T-1 batch) | `mers.txn.accepted{min_update_subservicer}` for all MINs | sev 2 → `transfer` agent; partner notified; mail-service risk |
| `MERS_PROC_TOS_INITIATE_T0` | deadline (transferor duty, monitored) | `transfer.batch.approved{type=servicing_sale_with_sub}` | `transfer_date` | 0 | `mers.tos.pending_received` | sev 2 → chase transferor |
| `MERS_PROC_TOS_CONFIRM_7` | deadline | `mers.tos.pending_received` | pending notice date | +7 calendar_days **[UNVERIFIED]** | `mers.txn.confirmed{tos_confirm}` | sev 2 → `officer` (partner) |
| `MERS_PROC_REGISTER_UNREGISTERED_7` | deadline | `loan.boarded{min is null, mers_eligible=true}` | `transfer_date` | +7 calendar_days | `mers.txn.accepted{registration}` | sev 2; QA finding |
| `SM_MERS_POST_TRANSFER_VERIFY_3` | deadline | `transfer.batch.cutover_completed` | `transfer_date` | +3 business_days_servicer | `mers.snapshot.verified` for 100% of MINs | sev 2 |
| `SM_MERS_INVESTOR_FNMA_CHECK` | not_before_gate (warning) | `loan.staged{min present}` | — | investor/note owner = Fannie Mae Org ID | `W-016` pass | warning; seller/partner query (B8-7-01) |
| `MERS_RULE7_VIOLATION_RESPONSE_30` | deadline | `mers.violation_notice.received` | notice date | +30 calendar_days | `mers.violation.remediated` | sev 1 → `officer`; lockout risk |
| `MERS_RULE7_LOCKOUT_WARNING_30` | deadline | `mers.lockout_warning.received` | notice date | +30 calendar_days | remediation + penalties paid | sev 1 |
| `MERS_QA_MRE_RECON_MONTHLY` | recurring | `mers.mre.received` | receipt | monthly (quarterly below 1,000 MINs) **[PARTIALLY VERIFIED]** | `mers.recon.completed` | sev 3; QA log |
| `MERS_ANNUAL_REPORT_1231` | recurring | calendar | Dec. 31 each year | 0 | `mers.annual_report.submitted` (both Org IDs) | sev 1 → `officer` **[PARTIALLY VERIFIED]** |

Jurisdiction overrides: none.

#### Business rules and calculations
- Transaction selection by transfer type: `master_to_sub` → MIN Update (Subservicer = Supermortgage Org ID; Servicer unchanged); `sub_to_sub` → MIN Update replacing the prior subservicer's Org ID; `servicing_sale_with_sub` → TOS (seller → partner) with Subservicer = Supermortgage, initiated by the seller and confirmed by the buyer; TOB never (investor remains Fannie Mae); non-MERS → none.
- MIN validation (`HF-008`): 18 digits; positions 1–7 = Org ID of the registering Member; positions 8–17 sequence; position 18 = Mod-10 check digit **[PARTIALLY VERIFIED algorithm]**; MIN status must be `Active`; `servicer_org_id` must equal the transferor's (for sales) or the partner's (for sub changes); `investor_org_id` should be Fannie Mae's (`W-016` otherwise).
- Data-integrity rule (Procedures Manual): before any MIN Update the platform compares its system-of-record values (borrower names, property address, note date, original amount, servicer/subservicer) to the MERS snapshot; any mismatch other than the field being changed opens `mers_qa_findings{mre_mismatch}` and blocks the update until reconciled.
- Worked example: 5,000-loan `master_to_sub` batch, transfer date Thu Oct. 1, 2026 → MIN Update file submitted in the Wed Sept. 30, 2026 evening batch with effective date Oct. 1; MERS acknowledgment file ingested Oct. 1; 4,990 accepted, 10 rejected (e.g., MIN inactive) → 10 exceptions to 1.1; snapshot verification for 100% by Tue Oct. 6, 2026 (`SM_MERS_POST_TRANSFER_VERIFY_3`). Example 2: `servicing_sale_with_sub`, seller initiates TOS Sept. 29 with Transfer Date Oct. 1; pending notice received Sept. 29 → partner confirmation due Oct. 6 [UNVERIFIED window]; a loan first serviced Oct. 1 without a MIN → registration by Oct. 8, 2026.
- Fees: MERS transfers are free; registrations $24.95 MOM/Non-MOM (research/00b N1) — accrued to the partner's MERS invoice, never to the borrower.

#### Integrations
- **`mers`** adapter: outbound batch (flat-file over FTP/VPN or XML system-to-system per the Integration Handbook **[UNVERIFIED layouts]**), inbound acknowledgment/reject files, pending-transfer notices, MRE; idempotency by `(min, txn_type, effective_date)`; rejects mapped to reason codes; replay of a rejected batch only for corrected MINs. MERS Link (lookup) for low-volume verification. Outage: retry per batch window; timers continue; escalate at T-0 if the T-1 batch failed.
- No Fannie Mae interface (MERS notifies Fannie Mae of deactivations itself).
- eRegistry (eNotes): Servicing Agent verification lives in 1.4.

#### Outputs and artifacts
- `mers_transactions` and `mers_min_snapshots` records; batch files and acknowledgments as `documents`; QA findings; Annual Report package draft (18.x). No borrower notices, ledger postings or investor events.

#### AI agent design (AI-first)
`transfer` agent (tools: `planMersTransactions`, `validateMin`, `buildMersBatch`, `submitMersBatch` (under Supermortgage's Org ID for transactions it is authorized to perform; otherwise `createPartnerTask`), `ingestMersAck`, `snapshotMins`, `reconcileMre`, `draftViolationResponse`, `writeDecision`). It plans and executes the MERS work end-to-end, verifies post-transfer state, reconciles the MRE monthly and drafts Rule 7 responses. Escalations: `officer` (partner) for TOS confirmations requiring the partner's credentials, violation responses and the Annual Report signature; `signing_officer` is not involved in 1.5 (assignments are 13.3/16.3). Decision record: `{batch_id, txn_plan, min_validation_summary, submissions, verification, rationale}`. No borrower contact. Human path: ops-console MERS workbench generating the same batch files for manual upload via MERS OnLine.

#### Edge cases and failure modes
- MIN inactive/deactivated at the transferor (paid in full, Non-MERS transfer, foreclosure assignment): exception; if the loan is genuinely active, the transferor must reverse the deactivation before transfer.
- Prior subservicer resigned from MERS: partner must remove its Org ID; Supermortgage's update replaces it.
- Investor field ≠ Fannie Mae (seller never completed the post-purchase update): `W-016`; the seller/partner corrects (Selling Guide B8-7-01) — Supermortgage cannot perform TOB.
- Loan in foreclosure at transfer with assignment out of MERS already recorded: MIN deactivated "Assigned from MERS"; MERS work not applicable; custody/assignment chain per 1.4 and 13.3.
- Bankruptcy/SCRA: no MERS impact.
- Mid-process transfer-out: pending Supermortgage Subservicer designation removed by the partner's next MIN Update (17.x).
- Batch rejected in full (file-level): re-submit corrected file within the same day; if MERS is unavailable at T-1, submit T-0 and record the delay for QA.
- Transfer date change after submission: cancel/resubmit with new effective date; keep both transactions in `mers_transactions`.

#### Test cases and acceptance criteria
- 1.5-T1 Given a `master_to_sub` batch, then no TOS/TOB transactions are generated and every MIN has a `min_update_subservicer` row with effective date = transfer date.
- 1.5-T2 Given a `servicing_sale_with_sub` batch, then TOS pending notices are expected from the seller and confirmation timers (7 days [UNVERIFIED]) are created per MIN.
- 1.5-T3 Given a MIN whose MERS snapshot shows a different property address than the tape, then the update is blocked and a `mre_mismatch` finding exists.
- 1.5-T4 Given 10 rejected MINs in the acknowledgment file, then 10 boarding exceptions are open and the batch report shows 99.8% accepted.
- 1.5-T5 Given transfer date Oct. 1, 2026, then `SM_MERS_POST_TRANSFER_VERIFY_3` is due Oct. 6, 2026; verification of 100% by Oct. 5 satisfies it.
- 1.5-T6 Given a MERS-eligible loan boarded Oct. 1 with no MIN, then registration is due Oct. 8, 2026.
- 1.5-T7 Given a Violation notice dated Nov. 10, 2026, then the response/remediation timer is due Dec. 10, 2026 and an `officer` task is open.
- 1.5-T8 Given a MIN with investor ≠ Fannie Mae, then boarding proceeds with `W-016` and a partner query.

#### Audit and evidence
Batch files, acknowledgments and reject files (hashes), per-MIN before/after snapshots, partner authorizations, QA reconciliations, violation correspondence, Annual Report packages, timers and `agent_decisions` — the MERS Annual Report audit-area evidence (transaction accuracy and timeliness, data reconciliation).

### Open questions / decisions
1. Who submits MIN Updates naming Supermortgage as Subservicer on partner-serviced MINs — partner under its Org ID (default) with Supermortgage-prepared batch files, or Supermortgage as a MERS Vendor/Subservicer under written authorization.
2. Confirm the exact TOS confirmation window and any "reflect within N days of the Transfer Date" QA rule from the Integration Handbook; set `MERS_PROC_TOS_CONFIRM_7` accordingly.
3. Whether Supermortgage's Org ID should be named on every partner MIN (mail service, transaction rights — default yes) or only where Supermortgage will transact (foreclosure states).

### Sources
- MERS System Rules of Membership (eff. June 30, 2025): https://www.mersinc.org/publicdocs/MERS_System_Rules_of_Membership.pdf
- MERS System Procedures Manual Release 24.2 (Nov. 17, 2024): https://www.mersinc.org/publicdocs/mers/00MERS00System_Proc.pdf
- MERS General Member Guide: https://www.mersinc.org/publicdocs/MERS_System_General_Member_Guide.pdf
- Fannie Mae Selling Guide B8-7-01 (05/01/2024): https://selling-guide.fanniemae.com/sel/b8-7-01/mortgage-electronic-registration-systems-mers-inc
- Servicing Guide F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
- research/00b N1 (membership tiers, fees, QA/Annual Report).
