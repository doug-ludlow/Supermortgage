# 1.4 — Document custody verification

| Attribute | Value |
|---|---|
| Section | 1 — Boarding / Servicing Transfer-In |
| Automation class | a |
| Trigger & frequency | On boarding |
| Governing source | FNMA A2-1-01; Chapter A2-5 |
| Key deadlines | At boarding |
| Timers | `FNMA_A2_7_03_TRANSFEROR_CUSTODIAN_NOTICE_30`, `FNMA_DTJA_DOCS_SHIPPED_30`, `FNMA_DTJA_MISSING_DOCS_NOTICE_30`, `FNMA_DTJA_RECERT_COMPLETE_6M`, `FNMA_DTJA_RECERT_COMPLETE_FILE_10`, `FNMA_DTJA_RECERT_EXTENSION_15`, `FNMA_DTJA_RECERT_ISALE_30`, `FNMA_DTJA_RECERT_START_FILE_10`, `FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30`, `FNMA_F1_11_ENOTE_SERVICING_AGENT_T0`, `FNMA_F1_11_PARTICIPATION_NOTES_30`, `FNMA_RDC_FORM2009_90`, `SM_CUSTODY_EXCEPTION_REVIEW_20`, `SM_CUSTODY_RECORD_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Boarding |
| Trigger & frequency | On boarding |
| Governing source (blueprint) | FNMA A2-1-01; Chapter A2-5 |
| Key deadlines (blueprint) | At boarding |
| Data/artifacts | Custodial certification |
| Systems | Document custodian [cropped in source] |
| Automation class (blueprint) | [cropped in source] — treated as (a) for tracking/verification, (c) for custodian and signing steps |
| SoR / Sub | [cropped in source] — Partner holds Form 2017; Supermortgage operates |
| Nuances (blueprint) | [cropped in source] — reconstructed: recertification even if documents do not move; 6-month recert; D/I/C codes; eNotes (Fannie Mae is custodian; MERS eRegistry Servicing Agent) |

### Verified requirement (as of 2026-09-09)

**A2-7-03 (05/13/2026)**: the transferee "must have a valid Master Custodial Agreement (Form 2017) in place with the document custodian"; must "advise the transferee document custodian of the pending transfer of servicing"; "is authorized to elect to keep the custodial documents ... at any Fannie Mae document custodian with which the transferee servicer has a custodial agreement"; and "the document custodian designated by the transferee servicer is required to recertify the custodial documents related to the transfer of servicing regardless of whether the documents themselves are moved." The transferor must "advise the transferor document custodian ... within 30 days of the transfer effective date, and make arrangements for the prompt and safe transfer of the custodial documents" and "prepare and record an assignment, if required, to ensure the chain of assignment is complete."

**F-1-11 (05/13/2026)**: the transferor provides "the transferee document custodian Fannie Mae's consent notice along with Form 629," "the transferee servicer the Request for Release/Return of Documents (Form 2009)," and "the transferee document custodian the trial balances and all data required for recertification in a format agreed upon"; "custodial documents must be recertified, even if the documents remain with the transferor's document custodian"; if there is no change in custodian "it must execute the Master Custodial Agreement (Form 2017)" for the transferee; assignment transmittals to the custodian must include transferor and transferee names, number of loans, transfer date and a trial balance; "a new mortgage loan assignment does not need to be prepared if the assignment to Fannie Mae has been recorded"; for a non-MERS loan without a recorded assignment to Fannie Mae, "an assignment from the transferor servicer to the transferee servicer must be prepared and recorded ... the transferor servicer is responsible for recording"; for a MERS loan going to a non-MERS servicer, assignment from MERS and MIN deactivation "Transfer to Non-MERS Status" (not applicable — Supermortgage is a MERS Member); participation-pool original notes to the transferee custodian "no later than 30 days after the transfer date." eMortgages: transferor provides eNote copies "via MERS eDelivery or some other mutually agreed-upon means," updates the eRegistry "Servicing Agent" field, and delivers "all associated borrower attribution evidence and audit trail information detailing the eClosing event."

**Document Transfers Job Aid for Document Custodians v5 (Jan. 23, 2026)**: Fannie Mae issues a **D-Code** on approval; the transferor custodian ships within 30 days of the transfer-effective-date (TED) notification; the transferee custodian receives the trial balance from the transferee servicer "within 30 days of TED"; the transferee custodian "must notify the Transferor Document Custodian and Transferee Servicer within 30 days of receipt of documents of any missing documents or Form 2009. Otherwise, the Transferee Document Custodian will be responsible for any missing files"; **Recert Start File** within 10 days of first documents and **Recert Complete File** within 10 days of completion (to custodian_oversight@fanniemae.com; one file per D-Code for post-10/1/2015 transfers); "recertification must be completed within six months after the effective date of the document transfer"; extensions requested "at least 15 days before deadline" with loan-level constraints and monthly status updates; concurrent sale of servicing uses an **I-Code** with a **30-day** deadline; custodian-only changes use a **C-Code** (6 months); same-custodian transfers still require Start and Complete files; corporate assignments are not required for transfers on/after June 1, 2022 (18-digit MIN or recorded assignment suffices before that); Special Feature Code 508 loans are excluded from the recert list; Form 2009 non-liquidation releases are tracked on the 90-Day Non-Liquidation Report.

**Requirements for Document Custodians** (v14.0 Apr. 2023 fetched; v15.0 Aug. 2025 per research/00b N8): custodians retain "the original mortgage note (and any related addenda), the original recorded mortgage; the original of any assignments for a MERS-registered mortgage; and originals of any documents that change the mortgage terms"; custodians certify via the Document Certification Application; Fannie Mae is custodian of its eNotes (own eVault); Form 2009 cannot be modified once submitted.

**MERS Rule 8** (Rules of Membership, eff. June 30, 2025): assignment out of MERS executed by a Signing Officer "before initiating foreclosure proceedings" — 13.3 consumes the custody record built here. **MERS eRegistry**: eNote Controller/Location = Fannie Mae; Servicing Agent = acting servicer (research/00b N1).

**Discrepancies vs blueprint**: (1) governing sources are A2-7-03/F-1-11 and the Document Transfers Job Aid, not A2-1-01/Chapter A2-5 (A2-5-01 only points to Selling Guide A2-4); (2) the deadline is not "at boarding" — Fannie Mae allows six months for recertification (30 days for I-Code); boarding needs a custody *record* and *verification of the certification status*, not a completed recertification; (3) the blueprint omits eNotes, D/I/C codes, Form 2009, and the 30-day missing-document notice that shifts liability to the transferee custodian.

### Operational prerequisites
- Form 2017 between the partner (transferee servicer for Fannie Mae) and the designated custodian; Form 2008 if a new custodian is being activated (research/00b N8) — Partner; weeks.
- Custodian data-exchange setup (SFTP/CSV release requests, holdings/status extracts, exception reports; vendor-specific) — Supermortgage; 4–8 weeks.
- MERS eRegistry participation with eVault access for eNotes (own or third-party eVault); eRegistry addendum — Supermortgage/Partner; 8–12 weeks (research/00b N1).
- Custodian Matrix agreed for Form 629 (1.2); D-Code received.
- `signing_officer` roster under partner/MERS corporate resolutions for any assignments that fall to the transferee side (rare) — Partner.
- Decision on recert applicability for `master_to_sub`/`sub_to_sub` with no custodian change (open question 1) confirmed in writing with Fannie Mae custodian oversight.

### Build spec
#### Inputs and triggers
- `transfer.batch.approved` (D-Code, Custodian Matrix, consent notice) → custody plan.
- `transfer.tape.received{kind=trial_balance}` (F-1-11 trial balance as of T-1) → custodian trial-balance file.
- Custodian inbound: holdings confirmation, Recert Start/Complete acknowledgments, exception lists, shipment manifests → `custody.*` events.
- Transferor inbound: Form 2009 list for released documents; assignment transmittals; eNote copies via MERS eDelivery; attribution/audit-trail packages.
- `loan.boarded` → custody record verification gate.
- 13.3/16.3 requests for original documents (Form 2009) later in life.

#### Data model
- `custody_records`: `loan_id`, `custodian_party_id`, `custodian_fin text`, `form_2017_document_id`, `certification_status` enum {`certified_transferor`,`recert_pending`,`recert_complete`,`exception`,`released`}, `note_location` enum {`custodian`,`released_form_2009`,`fnma_evault`}, `d_code text`, `code_type` enum {D,I,C,none}, `released_at`, `release_reason`, `expected_return_at`, `sfc_508 boolean`.
- `custody_recerts`: `batch_id`, `custodian_party_id`, `code_type`, `ted date`, `trial_balance_sent_at`, `first_docs_received_at`, `start_file_ack_at`, `complete_file_ack_at`, `exception_count int`, `extension_requested_at`, `extension_until date`, `status`.
- `custody_exceptions` (append-only): `loan_id`, `kind` enum {`missing_note`,`missing_mortgage`,`endorsement_break`,`allonge_missing`,`poa_missing`,`assignment_missing`,`data_mismatch`,`form_2009_missing`}, `raised_by` enum {custodian, agent}, `raised_at`, `notified_transferor_at`, `resolved_at`, `resolution`, `evidence_document_id`.
- `enotes`: `loan_id`, `min`, `controller='FNMA'`, `location='FNMA'`, `servicing_agent_org_id char(7)`, `delegatee_org_id null`, `evault_reference`, `enote_copy_document_id`, `attribution_evidence_document_id`, `audit_trail_document_id`, `eregistry_verified_at`.
- `documents`: note/mortgage/allonge/assignment images (`retention_class='life_of_loan_plus_4y'`); custodian correspondence.
- Add boarding rule `HF-018`: custody record absent (no custodian, no eVault reference) → hard fail (1.1 gate).

#### State machine
Batch custody (`custody_recerts.status`): `planned` → `trial_balance_sent` → `docs_in_transit` (transferor custodian shipping) → `docs_received` → `exceptions_open` ⇄ `exceptions_cleared` → `recert_started` (Start file acked) → `recert_complete` (Complete file acked) → `closed`; `extension_requested` → `extension_granted` side-state. Same-custodian path skips `docs_in_transit`. Loan-level `custody_records.certification_status`: `certified_transferor` → `recert_pending` (at `loan.boarded`) → `recert_complete` or `exception` → `recert_complete`; `released` when a Form 2009 release is open. Transitions come from custodian acknowledgments (external ack) or the `security-records` agent; `exception` resolution involving an assignment requires `signing_officer`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_A2_7_03_TRANSFEROR_CUSTODIAN_NOTICE_30` | deadline (transferor duty, monitored) | `transfer.batch.cutover_completed` | `transfer_date` | +30 calendar_days | `custody.transferor_notice.confirmed` | sev 2 → `transfer` agent chases transferor; `officer` (partner) |
| `FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30` | deadline | `transfer.batch.cutover_completed` | `transfer_date` | +30 calendar_days | `custody.trial_balance.sent` (custodian ack) | sev 1 → `officer` |
| `FNMA_DTJA_DOCS_SHIPPED_30` | deadline (transferor custodian duty, monitored) | `custody.transferor_notice.confirmed` | notice date | +30 calendar_days | `custody.shipment.received` | sev 2 |
| `FNMA_DTJA_MISSING_DOCS_NOTICE_30` | deadline | `custody.shipment.received` | received_at | +30 calendar_days | `custody.exceptions.notified` (custodian notice to transferor custodian and Supermortgage) | sev 1 — liability shifts to transferee custodian |
| `SM_CUSTODY_EXCEPTION_REVIEW_20` | deadline | `custody.shipment.received` | received_at | +20 calendar_days | `custody.exception_review.completed` | sev 2 → `security-records` |
| `FNMA_DTJA_RECERT_START_FILE_10` | deadline (custodian duty, monitored) | `custody.shipment.received{first}` | first_docs_received_at | +10 calendar_days | `custody.recert_start.acked` | sev 2 |
| `FNMA_DTJA_RECERT_COMPLETE_6M` | deadline | `transfer.batch.cutover_completed{code_type∈D,C}` | `ted` | +6 months | `custody.recert_complete.acked` | sev 1 → `officer`; Fannie Mae exposure |
| `FNMA_DTJA_RECERT_ISALE_30` | deadline | `transfer.batch.cutover_completed{code_type=I}` | `ted` | +30 calendar_days | same | sev 1 |
| `FNMA_DTJA_RECERT_EXTENSION_15` | deadline | `custody.recert.at_risk` (agent forecast) | recert deadline | −15 calendar_days | `custody.extension.requested` | sev 1 |
| `FNMA_DTJA_RECERT_COMPLETE_FILE_10` | deadline (custodian, monitored) | `custody.recert.completed` | completion date | +10 calendar_days | `custody.recert_complete.acked` | sev 3 |
| `FNMA_F1_11_PARTICIPATION_NOTES_30` | deadline | `loan.boarded{participation_pool=true, note_held_by_transferor=true}` | `transfer_date` | +30 calendar_days | `custody.shipment.received` for the note | sev 2 |
| `FNMA_F1_11_ENOTE_SERVICING_AGENT_T0` | deadline | `transfer.batch.approved{emortgage_count>0}` | `transfer_date` | 0 | `enote.eregistry.verified{servicing_agent=Supermortgage Org ID}` | sev 1; payoffs/assumptions on eNotes blocked until fixed |
| `SM_CUSTODY_RECORD_GATE` | not_before_gate | `loan.staged` | — | custody record present | `HF-018` pass | loan cannot board |
| `FNMA_RDC_FORM2009_90` | recurring | `custody.release.opened{reason=non_liquidation}` | released_at | +90 calendar_days | `custody.release.returned` | sev 3; 90-Day Non-Liquidation Report |

Jurisdiction overrides: none.

#### Business rules and calculations
- Recert deadline: `ted + 6 months` (same day-of-month; end-of-month clamp). Worked example: TED Oct. 1, 2026 → recert complete by **Apr. 1, 2027**; extension request by **Mar. 17, 2027**; trial balance to custodian by **Oct. 31, 2026**; first documents received Oct. 15 → Recert Start file due Oct. 25; missing-document notice due Nov. 14, 2026; Supermortgage's own exception review due Nov. 4.
- Trial balance content: Fannie Mae loan number, servicer loan number, borrower name, property address, note date, original amount, UPB, MIN, custodian, SFC 508 flag (excluded from the recert list), eNote flag.
- Recert scope per code type: D (servicer change, docs may move), C (custodian change only), I (concurrent sale, 30 days). Subservicing-only changes with no custodian change: `code_type='none'` pending Fannie Mae confirmation (decision 1); internal verification still runs.
- Custody verification at boarding (`HF-018`): every loan must have (a) a custodian and certification status from the transferor's data, or (b) an eNote with `controller='FNMA'`; loans with an open Form 2009 release are boarded with `note_location='released_form_2009'` and a return timer.
- Assignment logic: if MERS-registered → no assignment (MIN update only, 1.5); if non-MERS and assignment to Fannie Mae recorded → none; if non-MERS and no recorded assignment to Fannie Mae → transferor records assignment to transferee (partner) — tracked as `custody_exceptions{kind=assignment_missing}` until the recorded instrument image is received.
- eNotes: verify on the eRegistry that Controller = Fannie Mae, Location = Fannie Mae's eVault, Servicing Agent = Supermortgage Org ID (or partner Org ID with Supermortgage as Delegatee — decision 2); store the eNote copy hash and match `LOAN/…/NoteAmount`, rate, borrower names to the boarded terms.

#### Integrations
- **`custodian`** adapter (per custodian; CSV/PDF over SFTP or portal-only **[UNVERIFIED specs]**): outbound trial balance, exception responses, Form 2009 requests; inbound holdings confirmation, exceptions, Start/Complete acknowledgments, shipment manifests. Idempotency by `batch_id + file hash`; unacknowledged trial balance re-sent after 2 business days.
- **Fannie Mae Document Certification Application** — used by custodians, not by Supermortgage; status is learned through the custodian feed.
- **custodian_oversight@fanniemae.com** (email-out) — extension requests are prepared by the agent and sent by the custodian or by the partner `officer` (decision 3).
- **MERS eRegistry** via eVault vendor (XML/SOAP; member-only spec **[UNVERIFIED]**): read Controller/Location/Servicing Agent; receive eDelivery copies.
- **`erecording`** (Simplifile/CSC; PRIA XML) for any assignment the partner must record on the transferee side.
- Failure: custodian feed outage → manual status request; Fannie Mae exposure timers keep running.

#### Outputs and artifacts
- `custody_records` for every loan; `custody_recerts` batch record; exception correspondence; recorded assignment images; eNote verification records; no borrower notices; no ledger postings; no investor events (custodian files go to Fannie Mae from the custodian).
- Documents: trial balance (hash), Form 2009s, consent notice/D-Code letter, extension request/approval.

#### AI agent design (AI-first)
`security-records` agent (tools: `buildTrialBalance`, `sendToCustodian`, `ingestCustodianFeed`, `matchHoldings`, `openException`, `draftTransferorQuery`, `verifyERegistry`, `forecastRecertRisk`, `draftExtensionRequest`, `writeDecision`) runs the custody plan end-to-end: builds and sends the trial balance, reconciles custodian holdings against boarded loans, opens and chases exceptions with the transferor, verifies eNotes on the eRegistry, forecasts recert completion (loans certified per week vs remaining) and drafts extension requests 30 days ahead of the 15-day cutoff. Escalations: `signing_officer` for any assignment or allonge execution; `officer` (partner) for extension requests and for accepting an exception as unresolvable (Fannie Mae approval exceptions); `attorney` only when a lost-note affidavit is needed (rare; 13.3). Decision record: `{batch_id, holdings_matched, exceptions_opened, recert_forecast, actions, rationale}`. No borrower-facing contact; no TCPA/state-AI disclosure issues. Human path: ops-console custody workbench with the same states.

#### Edge cases and failure modes
- Documents released to the transferor's counsel for foreclosure/bankruptcy at transfer: Form 2009 open; note must be tracked to the new attorney (13.6) and returned after; `note_location='released_form_2009'`.
- Same custodian, master-to-sub only: no physical movement; confirm Start/Complete file applicability (decision 1); verify custodian's system shows the correct servicer/subservicer names.
- Lost note discovered at recert: lost-note affidavit (`attorney`/`signing_officer`), Fannie Mae exception approval; loan flagged for 13.3.
- Endorsement chain break/allonge missing: transferor obligation; exception timer; partner escalation.
- eNote with Servicing Agent still the transferor after T-0: payoffs and modifications on eNotes blocked (`FNMA_F1_11_ENOTE_SERVICING_AGENT_T0` breach) until corrected by the transferor/Controller.
- Transferor custodian ships late (>30 days): Fannie Mae timers continue; document Supermortgage's chase evidence to defend the transferee custodian's 30-day notice window.
- SFC 508 loans: excluded from recert lists but still need a custody record.
- Mid-process transfer-out (17.x): open recert exceptions carry to the next transferee's list.
- Bankruptcy/foreclosure needing the original note during recert: expedited Form 2009 with the custodian; timers unaffected.

#### Test cases and acceptance criteria
- 1.4-T1 Given TED Oct. 1, 2026 (D-Code), then recert deadline = Apr. 1, 2027 and extension cutoff = Mar. 17, 2027.
- 1.4-T2 Given an I-Code transfer with TED Oct. 1, 2026, then recert deadline = Oct. 31, 2026.
- 1.4-T3 Given the trial balance is acked by the custodian Oct. 30, 2026, then `FNMA_DTJA_TRIAL_BALANCE_TO_CUSTODIAN_30` is satisfied; acked Nov. 1 → breached.
- 1.4-T4 Given documents received Oct. 15 and a custodian exception list dated Nov. 15, then `FNMA_DTJA_MISSING_DOCS_NOTICE_30` is breached (liability warning logged).
- 1.4-T5 Given a loan with no custodian and no eVault reference, then `HF-018` blocks boarding.
- 1.4-T6 Given an eNote whose eRegistry Servicing Agent ≠ Supermortgage Org ID on Oct. 1, then the timer breaches and the payoff command for that loan is blocked with reason `enote_servicing_agent_mismatch`.
- 1.4-T7 Given the agent's forecast shows 400 of 5,000 loans unrecertified at Feb. 15, 2027, then an extension request draft exists by Mar. 1, 2027 and an `officer` task is open.
- 1.4-T8 Given a non-MERS loan with no recorded assignment to Fannie Mae, then a `custody_exceptions{assignment_missing}` row exists until the recorded image is received.
- 1.4-T9 Given a Form 2009 release open 91 days for a non-liquidation reason, then `FNMA_RDC_FORM2009_90` fires and the release appears on the 90-day report.

#### Audit and evidence
Trial balance files and custodian acknowledgments, D-Code letter, holdings reconciliations, exception logs with transferor correspondence, Recert Start/Complete acknowledgments, extension requests/approvals, eRegistry verification snapshots, recorded assignment images, timer histories and `agent_decisions` — the MORA custody evidence set.

### Open questions / decisions
1. Whether a subservicer-only change with no custodian change triggers a D-Code recert. Default: ask Fannie Mae custodian oversight in writing per batch; run internal verification regardless.
2. eRegistry Servicing Agent = Supermortgage Org ID (default) vs partner Org ID with Supermortgage as Delegatee — align with the MERS Subservicer designation in 1.5.
3. Who sends extension requests to custodian_oversight@fanniemae.com — custodian (default per Job Aid) with Supermortgage-prepared content, or partner `officer`.
4. Custodian choice for Supermortgage-serviced partner loans: keep the partner's custodian (default; avoids physical movement) vs consolidate to a Supermortgage-preferred custodian (C-Code later).

### Sources
- Servicing Guide A2-7-03 (05/13/2026): https://servicing-guide.fanniemae.com/svc/a2-7-03/post-delivery-servicing-transfers
- Servicing Guide F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
- Document Transfers Job Aid for Document Custodians v5 (Jan. 23, 2026): https://singlefamily.fanniemae.com/media/6966/display
- Requirements for Document Custodians (v14.0 fetched; v15.0 Aug. 2025 per 00b): https://singlefamily.fanniemae.com/media/document/pdf/requirements-document-custodians
- MERS Rules of Membership (eff. June 30, 2025), Rule 8: https://www.mersinc.org/publicdocs/MERS_System_Rules_of_Membership.pdf
- Servicing Guide A2-5-01 / Selling Guide A2-4.1-02 (retention): see 1.1 sources.
- research/00b N1, N8, N15.
