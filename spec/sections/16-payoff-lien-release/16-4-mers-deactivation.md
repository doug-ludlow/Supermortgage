# 16.4 — MERS deactivation

| Attribute | Value |
|---|---|
| Section | 16 — Payoff & Lien Release |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On payoff |
| Governing source | MERS Rules |
| Key deadlines | Per MERS |
| Timers | `MERS_ANNUAL_REPORT_1231`, `MERS_PROC_PAID_IN_FULL_DEACTIVATE_60`, `MERS_QA_MRE_RECON_MONTHLY`, `MERS_RULE7_LOCKOUT_WARNING_30`, `MERS_RULE7_VIOLATION_RESPONSE_30`, `SM_ENOTE_PAIDOFF_STATUS_2BD`, `SM_ENOTE_PAPER_COPY_10BD`, `SM_MERS_DEACTIVATE_TARGET_5BD`, `SM_MERS_DEACTIVATION_VERIFY_3BD`, `SM_MERS_DEACT_REVERSAL_5BD`, `SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Release |
| Trigger & frequency | On payoff |
| Governing source (blueprint) | MERS Rules |
| Key deadlines (blueprint) | Per MERS |
| Data/artifacts | MIN update |
| Systems | MERS |
| Automation class (blueprint) | a |
| SoR / Sub | S[cropped in source] — reconstructed: Sub (Supermortgage, a MERS Member named as Subservicer on the MIN, submits the deactivation under its Org ID on the partner's behalf; the partner remains the Servicer responsible to MERS) |
| Nuances (blueprint) | M[ERS] m[embership…] [cropped in source] — reconstructed: the subservicer must be an active Member named on the MIN to transact; "Paid in Full" deactivation follows the *recording* of the lien release (60 calendar days); reversals; eNote eRegistry status and paper-copy rule; monthly MRE reconciliation and the Annual Report's transaction-timeliness audit area |

### Verified requirement (as of 2026-09-09)

**MERS System Procedures Manual (Release 24.2, eff. Nov. 17, 2024), "MIN Record Deactivation":** subsections cover Paid in Full Deactivation, Transfer to Non-MERS Status Deactivation, Deactivate-Assigned from MERS for Default or Bankruptcy, and Deactivation Reversals; "When MERS no longer holds an interest in a Mortgage, the MIN Record is deactivated on MERS® System"; Paid in Full requirement: the Servicer must deactivate within "60 calendar days after the Lien Release ... is recorded" in the public land records, by submitting a Paid in Full Deactivation transaction, which updates the MIN Record status to inactive **[PARTIALLY VERIFIED — extracted from the PDF by summarizer; confirm the full sentence and the reversal window in the member-only Integration Handbook]**. Subservicers "must be active Members if named on loans"; only the Servicer or Subservicer can update a MIN (1.5). **Rules of Membership (eff. June 30, 2025):** Rule 2 §3 (deactivation on transfer to a non-Member), Rule 2 §4 ("promptly correct" discrepancies with the land records), Rule 2 §7 (Lien Release executed by a MERS Signing Officer — 16.3), Rule 7 (violation remediation 30 + 30 days — 1.5). **MERS pricing (00b N1):** Lien Release via Simplifile $1.00; Transfer to Non-MERS $2.00; no separate price located for a Paid-in-Full deactivation **[UNVERIFIED]**. **QA/Annual Report (00b N1):** monthly Member Reconciliation Extract at ≥ 1,000 active MINs, Annual Report due Dec. 31 with independent review at ≥ 1,000 MINs and audit areas including "transaction accuracy & timeliness" and "document execution."

**Fannie Mae.** *F-1-09 (10/19/2016):* "If the mortgage loan is an eMortgage, update the MERS eRegistry with information of the payoff, charge-off, or assumption"; "Advise MERS to deactivate the MERS registration for the mortgage loan, if applicable"; where the state "requires the return of a paper Note upon loan payoff," provide the borrower "a paper copy of the eNote marked 'Copy' and 'Paid-In-Full'" with a letter explaining the eNote was registered on the eRegistry and has been deactivated due to payment in full, plus other documents required by law. *Selling Guide B8-7-01 (1.5):* MERS notifies Fannie Mae of deactivations — no separate Fannie Mae reporting. *00b N1/F-custodian notes:* Fannie Mae is custodian (own eVault) of every eNote it purchases; servicers of eNotes need eRegistry participation and eVault access "for payoffs/charge-offs/assumptions" — the exact eRegistry transaction (Change Status "Paid Off" by the Controller or a delegated Servicing Agent) is **[UNVERIFIED]**.

**Discrepancies with the blueprint row.** (1) "Per MERS" is a concrete clock: 60 calendar days **after the lien release is recorded**, not after payoff — so 16.4 depends on 16.3's recording confirmation, and a paper-recording county can consume most of a state's release window before the MERS clock even starts. (2) "MERS Rules" contain the duty; the timing lives in the Procedures Manual/Integration Handbook (member-only). (3) The row omits eNote handling (eRegistry status, paper copy) and reversals. (4) Automation (a) confirmed — no human touchpoint; MERS reversals and violation responses go to the partner `officer` (1.5).

### Operational prerequisites
- Supermortgage MERS membership with Subservicer role and Org ID named on every partner MIN it services (1.5 decision 3 — default yes), batch interface (flat-file or XML) certified for Deactivation and Deactivation Reversal transaction types **[layouts member-only; UNVERIFIED]** — Supermortgage; 2–4 weeks.
- Partner authorization for Supermortgage to submit deactivations under its Org ID (or partner submission of Supermortgage-built batches — 1.5 decision 1) — partner.
- eRegistry: Supermortgage eRegistry participation, eVault access or an agreed request channel with Fannie Mae's eVault for status changes; the "Servicing Agent"/delegation set-up on each eNote at boarding (1.4) — partner/Supermortgage; 8–12 weeks.
- `jurisdiction_rules.release.paper_note_return_required` (states requiring return of the paper note at payoff) — compliance **[state list UNVERIFIED]**.
- MRE feed and QA plan covering deactivation timeliness (1.5).

### Build spec
#### Inputs and triggers
- `lien_release.recorded{release_task_id, recorded_at, recording_reference}` (16.3) → deactivation eligibility (one per MIN; a loan with one MIN and several county releases deactivates after the *last* recording).
- `lien_release.third_party_recorded` (title-company/settlement-agent release verified, 16.3) → eligibility.
- `chargeoff.release.recorded` (Section 15/13 charge-off release) → same transaction with reason per Procedures.
- `loan.paid_in_full{enote=true}` → eRegistry status request; `enote.status.paid_off` acked → registration deactivation after recording.
- `payoff.reversed` after deactivation → reversal path; MERS acknowledgments/rejects; MRE monthly file; MERS violation notices (1.5).

#### Data model
- `mers_transactions` (1.5) — extend `txn_type` with `deactivation_paid_in_full`, `deactivation_reversal`; add `reason_code`, `release_task_id`, `release_recorded_at`, `recording_reference`, `verified_snapshot_id`.
- **`mers_eregistry_transactions`** (new): `id`, `loan_id`, `min`, `enote_id`, `txn_type` ∈ {change_status_paid_off, registration_deactivation, change_status_reversal}, `requested_at`, `requested_via` ∈ {evault_api, fnma_request, ui}, `controller_org_id`, `status` ∈ {requested, accepted, rejected, confirmed}, `ack_reference`, `evidence_document_id`.
- `mers_min_snapshots` (1.5): post-deactivation snapshot (`status = inactive`, reason Paid in Full).
- `payoff_housekeeping_tasks{task=enote_paper_copy}` (16.2).
- Retention `life_of_loan_plus_4y`; no new PII.

#### State machine
Per MIN: `awaiting_release` → `eligible` (all county releases recorded, or third-party/charge-off release verified) → `prepared` → `submitted` → `accepted` | `rejected` (→ fix → `prepared`) → `verified` (snapshot inactive) → `closed`. eNote overlay: `status_requested` → `status_paid_off` (before or in parallel with the release) → `registration_deactivated` → `paper_copy_sent` (where required) → `closed`. Reversal: `reversal_needed` → `reversal_submitted` → `reactivated` → back to the 16.2/16.3 states of the reopened loan. Gate `SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE`: no Paid-in-Full deactivation before the release executed in MERS' name is recorded (the Signing Officer acts for MERS as mortgagee of record; deactivating first breaks the record chain).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `MERS_PROC_PAID_IN_FULL_DEACTIVATE_60` | deadline | `lien_release.recorded` (last county) | recorded_at | +60 `calendar_days` **[PARTIALLY VERIFIED]** | `mers.txn.accepted{deactivation_paid_in_full}` | sev-1; QA finding; `officer` (partner) notified (Rule 7 exposure) |
| `SM_MERS_DEACTIVATE_TARGET_5BD` | deadline (policy) | `lien_release.recorded` | recorded_at | +5 `business_days_servicer` | same | sev-3 |
| `SM_MERS_DEACTIVATION_VERIFY_3BD` | deadline (policy) | `mers.txn.accepted{deactivation}` | accepted_at | +3 BD | `mers.snapshot.verified{status=inactive}` | sev-3; resubmit/inquiry |
| `SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE` | not_before_gate | deactivation submit | — | `release_tasks.status ∈ {recorded, third_party_recorded}` for all counties | submit | block |
| `SM_ENOTE_PAIDOFF_STATUS_2BD` | deadline (policy; F-1-09 "update the MERS eRegistry") | `loan.paid_in_full{enote}` | payoff date | +2 BD | `enote.status.paid_off` requested/confirmed **[mechanics UNVERIFIED]** | sev-2 |
| `SM_ENOTE_PAPER_COPY_10BD` | deadline (policy; F-1-09) | `mers.txn.accepted{deactivation}` on an eNote in a paper-return state | accepted_at | +10 BD | `NTC_ENOTE_PAPER_COPY` mailed with the marked copy | sev-2 |
| `SM_MERS_DEACT_REVERSAL_5BD` | deadline (policy) | `payoff.reversed` after deactivation | reversal | +5 BD | `mers.txn.accepted{deactivation_reversal}` | sev-2; `officer` |
| `MERS_QA_MRE_RECON_MONTHLY` (defined in 1.5; reused here) | recurring | `mers.mre.received` | receipt | monthly (quarterly below 1,000 MINs) **[PARTIALLY VERIFIED]** | `mers.recon.completed` | sev 3; QA log |
| `MERS_ANNUAL_REPORT_1231` (1.5) | recurring | calendar | Dec. 31 each year | 0 | `mers.annual_report.submitted` (both Org IDs) | sev 1 → `officer` **[PARTIALLY VERIFIED]** |
| `MERS_RULE7_VIOLATION_RESPONSE_30` (1.5) | deadline | `mers.violation_notice.received` | notice date | +30 calendar_days | `mers.violation.remediated` | sev 1 → `officer`; lockout risk |
| `MERS_RULE7_LOCKOUT_WARNING_30` (1.5) | deadline | `mers.lockout_warning.received` | notice date | +30 calendar_days | remediation + penalties paid | sev 1 |
Jurisdiction overrides: `paper_note_return_required` by state (eNote paper copy).

#### Business rules and calculations
1. **Eligibility.** Deactivate only after the release is recorded (evidence: recorded image/reference from 16.3) — for third-party releases, after the recorded third-party instrument is verified against the land records (recorder search or vendor return). Charge-off releases follow the same rule.
2. **Transaction content.** MIN; deactivation reason "Paid in Full"; the effective/recording date of the release; submitting Org ID = Supermortgage (as named Subservicer) unless the partner submits (1.5 decision 1); the data-integrity check of 1.5 (borrower names, property, note date, original amount) runs before submission and any mismatch is corrected first (Rule 2 §4).
3. **Batching.** Deactivations ride the nightly MERS batch (T+1 after recording confirmation; same-day if the 60-day deadline is within 5 days); ack files are ingested the next morning; rejects are mapped and resubmitted within 1 BD.
4. **Verification.** A post-acceptance snapshot (batch response or MERS Link for exceptions) must show `status = inactive` with the paid-in-full reason; the monthly MRE reconciliation flags (a) active MINs on paid-off loans older than 60 days from recording, (b) inactive MINs on active loans (erroneous deactivation → reversal), and (c) MINs where Supermortgage is not the named Subservicer.
5. **eNotes.** At payoff, request the eRegistry status change to "Paid Off" through the Controller/delegation path (Fannie Mae's eVault) within 2 BD; after the release records, deactivate the eRegistry registration and the MERS System MIN; in states listed in `paper_note_return_required`, print the eNote from the eVault authoritative copy marked "Copy" and "Paid-In-Full" and send it with the F-1-09 letter; retain the eVault audit trail.
6. **Reversals.** Only for a documented cause (payoff reversed pre-close; deactivation of the wrong MIN); submitted within 5 BD with the reason; if MERS' reversal window has passed **[UNVERIFIED]**, re-register per the Procedures (registration fee $24.95 to the partner's invoice, never the borrower) and open a QA finding.
7. **Fees.** No borrower charge; MERS transaction fees (if any) accrue to the partner's MERS invoice per the subservicing agreement (1.5).
8. **Reporting.** Deactivation timeliness (days from recording to acceptance; % within 60 days) is a Compliance Sentinel KPI and an Annual Report exhibit.

**Worked example.** Ohio loan (16.3 example 1): release recorded Mon 10/26/2026 → `MERS_PROC_PAID_IN_FULL_DEACTIVATE_60` due **Fri 12/25/2026**; policy target Mon 11/02. Deactivation batch built Mon 10/26 evening (T+0, since the recorded image arrived at 14:05), submitted 10/26 21:00 ET; ack ingested Tue 10/27 06:30 ET: accepted; snapshot Wed 10/28 shows MIN 1000123-0000456789-0 inactive (Paid in Full) → `SM_MERS_DEACTIVATION_VERIFY_3BD` satisfied 10/28; November MRE shows no exception. *eNote variant:* payoff Fri 10/16 → eRegistry "Paid Off" status requested Mon 10/19 (2 BD) and confirmed 10/20; release recorded 10/26 → eRegistry registration deactivation and MERS System deactivation 10/26–10/27; property in a paper-return state → eNote copy marked "Copy"/"Paid-In-Full" and letter mailed Fri 10/30 (within 10 BD).

#### Integrations
- **`mers`** adapter (1.5): batch flat-file/XML deactivation and reversal transactions, acknowledgments/rejects, MRE ingestion; idempotency `(min, txn_type, effective_date)`; MERS Link lookups for exceptions only; outage → resubmit next window, timers unaffected (60-day cushion), escalate at deadline − 5 days.
- **`erecording`** (16.3): recording confirmations feed eligibility; where the vendor offers a MERS lien-release integration ($1.00 MERS Lien Release via Simplifile), the recorded release can be transmitted to MERS through the vendor **[whether this also performs the deactivation is UNVERIFIED]** — the platform still submits/validates the deactivation itself.
- **eRegistry / eVault:** XML/SOAP via the eVault vendor or a request channel to Fannie Mae's eVault operations **[UNVERIFIED]**; no Fannie Mae UI automation — if a Fannie Mae UI step is required it becomes a `human_portal_task` for the `fnma_portal_operator` with the eNote package (MIN, payoff evidence, requested status, date).
- No Fannie Mae investor reporting (MERS notifies Fannie Mae; the loan is already removed via LAR 60).

#### Outputs and artifacts
- `mers_transactions` rows (deactivation, reversal) with batch files and acks as `documents`; `mers_min_snapshots`; `mers_eregistry_transactions`; QA findings; Annual Report exhibit data. Notices: `NTC_ENOTE_PAPER_COPY` (F-1-09 content: paper copy of the eNote marked "Copy" and "Paid-In-Full", explanation of eRegistry registration and deactivation, other documents required by law). Ledger: none for the borrower; MERS fees to the partner invoice ledger. Investor events: none. `loan_events`: `mers.min.deactivated{paid_in_full}`, `mers.deactivation.reversed`, `enote.status.paid_off`, `enote.registration.deactivated`, `enote.paper_copy.sent`.

#### AI agent design (AI-first)
`payoff-release` agent using the 1.5 MERS toolset: `checkDeactivationEligibility`, `validateMinIntegrity`, `buildMersBatch{deactivation_paid_in_full}`, `submitMersBatch`, `ingestMersAck`, `snapshotMins`, `requestENoteStatus`, `printENoteCopy`, `reconcileMre`, `recordDecision`. Decision record: `{min, loan_id, release_task_ids[], recorded_at, eligibility_evidence, txn_id, submitted_at, ack, snapshot_id, enote{status_txn, paper_copy}, rationale}`. Guardrails: never deactivate before recording evidence; never deactivate a MIN whose loan is not `paid_in_full`/charged-off; no reversal without a documented cause; the LLM only classifies rejects and drafts QA notes. Escalations: `officer` (partner) for reversals outside the window, violation notices and Annual Report sign-off; `fnma_portal_operator` only if an eNote status change requires a Fannie Mae UI; `attorney` if a deactivation must be undone after a contested payoff reversal. No borrower contact except the eNote paper-copy letter. AI-off path: ops-console MERS workbench producing the same batch for manual upload via MERS OnLine.

#### Edge cases and failure modes
- **Release recorded by a third party** (TX/AZ/VA/MD mechanisms): verify, then deactivate; note the source in the transaction.
- **Multi-county loans:** deactivate after the last recording; the 60-day clock runs from the last recording (conservative: from the first, with a warning).
- **Paper-recording county with slow return:** the MERS clock has not started; the state release clock has (16.3) — no MERS exposure, but the recording monitor escalates.
- **Payoff reversed before the release records:** cancel eligibility; nothing to reverse. **After deactivation:** reversal within 5 BD; if outside MERS' window, re-register.
- **MIN already inactive** (prior servicer deactivated at transfer, foreclosure assignment out of MERS): nothing to do; document.
- **Loan transferred out before recording:** the transferee cannot deactivate a MIN naming the partner as Servicer until the TOS completes; Supermortgage completes the deactivation (it received the payoff) and informs the transferee (17.x).
- **eNote where the Controller is not Fannie Mae** (rare; warehouse/pre-purchase artifacts): escalate.
- **MERS outage / batch rejected in full:** resubmit next day; 60-day cushion; deadline − 5 days escalation.
- **Bankruptcy/SCRA/disaster:** no effect once paid in full.
- **Data-integrity mismatch** (borrower name differs from MERS record): correct via MIN update first (Rule 2 §4), then deactivate.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 16.4-T1 | Given the Ohio release recorded 10/26/2026, then the deactivation is submitted in the 10/26 batch, `MERS_PROC_PAID_IN_FULL_DEACTIVATE_60.due_at` = 12/25/2026, the ack is accepted 10/27 and the snapshot shows inactive/Paid in Full by 10/29. |
| 16.4-T2 | Given a deactivation command before `lien_release.recorded`, then the gate blocks it and logs the attempt. |
| 16.4-T3 | Given a two-county release with the second recording on 11/10, then the deactivation is submitted after 11/10 and the 60-day timer anchors on 11/10 (warning from 10/26). |
| 16.4-T4 | Given a MERS reject (MIN not found under Supermortgage's Org ID), then the exception is opened, the Subservicer designation is checked (1.5) and the transaction is resubmitted within 1 BD. |
| 16.4-T5 | Given an eNote payoff 10/16, then the eRegistry Paid Off status is requested by 10/20 and, after recording on 10/26, the registration is deactivated and (paper-return state) the marked copy and letter are mailed by 11/09. |
| 16.4-T6 | Given a payoff reversed 10/28 after a 10/27 deactivation, then a reversal is submitted by 11/04 and the MIN snapshot shows active again. |
| 16.4-T7 | Given the November MRE lists an active MIN for a loan paid off and released in August, then a QA finding opens with sev-1 and the deactivation is submitted the same day. |
| 16.4-T8 | Given the MERS batch channel is down on 12/22 with a 12/25 deadline, then the escalation fires at deadline − 5 days and a manual MERS OnLine task is created for the `officer`-authorized operator. |

#### Audit and evidence
Batch files/acks (hashed), per-MIN before/after snapshots, recording-evidence links, eRegistry transaction confirmations, paper-copy mailing evidence, MRE reconciliations, QA findings, timers and `agent_decisions` — the MERS Annual Report's transaction-timeliness and data-reconciliation audit areas.

### Open questions / decisions
1. Confirm the Paid-in-Full deactivation clock and reversal window in the member-only Integration Handbook **[PARTIALLY VERIFIED]** — default: 60 CD after recording; reversal within 5 BD.
2. Submitting Org ID: Supermortgage as Subservisor vs partner (1.5 decision 1) — default: Supermortgage under written authorization.
3. eNote status-change mechanics with Fannie Mae's eVault — default: request via the eVault vendor channel; `human_portal_task` fallback.
4. States requiring return of a paper note at payoff (eNote paper-copy list) — default: apply the F-1-09 paper-copy step in every state until counsel confirms the list.
5. Use the vendor's MERS lien-release integration ($1.00) in addition to the platform's own deactivation? Default: no duplicate transactions; vendor integration only if it does not itself deactivate.

### Sources
- MERS System Procedures Manual Release 24.2 (Nov. 17, 2024): https://www.mersinc.org/publicdocs/mers/00MERS00System_Proc.pdf — verified 2026-09-09 (partial extraction)
- MERS System Rules of Membership (eff. June 30, 2025): https://www.mersinc.org/publicdocs/MERS_System_Rules_of_Membership.pdf — verified 2026-09-09
- Servicing Guide F-1-09 (10/19/2016) — URL in 16.1 — verified 2026-09-09
- Fannie Mae Selling Guide B8-7-01 (05/01/2024): https://selling-guide.fanniemae.com/sel/b8-7-01/mortgage-electronic-registration-systems-mers-inc — as verified in 1.5
- research/00b N1 (MERS pricing, QA/Annual Report, eRegistry/eVault) — verified 2026-09-09
