# 1.1 — Loan data intake & validation (note terms, remittance type A/A–S/A–S/S, escrow flags, MERS MIN)

| Attribute | Value |
|---|---|
| Section | 1 — Boarding / Servicing Transfer-In |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On transfer/acquisition; per batch |
| Governing source | FNMA A2-7-03; Reg X 1024.38(b)(4) |
| Key deadlines | Board before first post-transfer payment cycle |
| Timers | `LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1`, `MERS_PROC_REGISTER_UNREGISTERED_7`, `REGX_1024_39A_LIVE_CONTACT_36`, `SM_BOARD_EXCEPTION_SLA_2`, `SM_BOARD_FINAL_TAPE_1`, `SM_BOARD_FIRST_CYCLE`, `SM_BOARD_POST_TRANSFER_MONITOR_180`, `SM_BOARD_PRELIM_TAPE_14` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Boarding |
| Trigger & frequency | On transfer/acquisition; per batch |
| Governing source (blueprint) | FNMA A2-7-03; Reg X 1024.38(b)(4) |
| Key deadlines (blueprint) | Board before first post-transfer payment cycle |
| Data/artifacts | Loan master record; note/mortgage images; retain life-of-loan + 4 yrs (A2-1-01) |
| Systems | [cropped in source] |
| Automation class (blueprint) | [cropped in source] — treated as (a) with (b) for exception disposition |
| SoR / Sub | [cropped in source] — Sub performs; SoR supplies Form 629 loan list and servicer number |
| Nuances (blueprint) | [cropped in source] — reconstructed below (remittance-type branching, MIN validation, default-status flag, fair-lending data) |

### Verified requirement (as of 2026-09-09)

**Reg X §1024.38(b)(4)** (eCFR current as of Sept. 3, 2026) requires policies and procedures reasonably designed to ensure that, "as a transferor servicer," the servicer timely transfers "all information and documents in the possession or control of the servicer relating to a transferred mortgage loan ... in a form and manner that ensures the accuracy of the information and documents transferred and that enables a transferee servicer to comply with" its obligations to the owner and applicable law, and that "as a transferee servicer," it can "identify necessary documents or information that may not have been transferred by a transferor servicer and obtain such documents from the transferor servicer" (§1024.38(b)(4)(i)–(ii)). Comment 38(b)(4)(i)-1 permits electronic transfer if "reasonably designed to ensure the accuracy"; comments 38(b)(4)(i)-2 and (ii)-1 single out loss-mitigation status, agreements and discussions as information that must move. Failure "to transfer accurately and timely information relating to the servicing of a borrower's mortgage loan account to a transferee servicer" is a covered error under §1024.35(b)(8). Records must be retained "until one year after the date a mortgage loan is discharged or servicing ... is transferred" (§1024.38(c)(1)), and the servicing file (transaction schedule incl. escrow/suspense, security instrument, modifications, contact notes, data-field report, borrower-submitted NoE/loss-mit documents) must be compilable within five days (§1024.38(c)(2)).

**Servicing Guide A2-7-03 (05/13/2026; Guide edition Aug. 12, 2026)** — the transferee must "receive a complete copy of the individual mortgage loan files so that it is able to service the transferred mortgage loans without interruption as of the transfer date," must "understand borrower account histories (including the amount and nature of all servicing advances and fees assessed to the borrower) as of the transfer date," must review subsequent collections "to ensure accurate accounting for recovery of advances charged to the borrower," and must "honor any forbearance agreements or other arrangements made with borrowers by the previous servicer." The transferor must "identify ... any mortgage loans that are in foreclosure, bankruptcy, or subject to a workout option."

**F-1-11 (05/13/2026)** enumerates what the transferor delivers: MI approvals/commitments; a list of loans with borrower-paid or lender-purchased MI (premium rates, next premium due date); a list of eMortgages; "transaction and payment histories for the life of the mortgage loans"; "trial balances, as of the close of business on the day immediately preceding the transfer date"; custodial bank reconciliations as of the cutoff; the last three months of investor accounting reports; shortage/surplus reconciliation; escrow analyses; delinquency-management information; all documents incl. custodian-held items; customer correspondence, complaints and escalated cases; foreclosure/bankruptcy/workout lists and records; litigation; state Address Confidentiality Program enrollment; and, for loans originated on or after March 1, 2023, queryable fair-lending data (race, ethnicity, age, gender, preferred language). eMortgages: the transferor must provide eNote copies "via MERS eDelivery or some other mutually agreed-upon means," update the "Servicing Agent" field in the MERS eRegistry, and deliver borrower attribution evidence and the eClosing audit trail.

**CFPB Bulletin 2020-02** (April 2020; not among the 67 documents withdrawn May 12, 2025 — verified against the withdrawal list) supplies the supervisory field list (Appendix A: foundational loan data incl. MIN, interest calculation method, ARM index/margin/next change date, occupancy, fees owed, prior bankruptcy; investor remittance type "scheduled/scheduled, scheduled/actual, actual/actual"; escrow; PMI; hazard/flood; loss mitigation; foreclosure; bankruptcy; successor-in-interest status) and the expectation of a written transfer plan with testing, data mapping validation, post-transfer QC and 4–6 months of post-transfer monitoring.

**LL-2026-05 (June 24, 2026)** requires an "Escrow Setup event for each applicable escrow item category type" for existing and newly acquired loans (mandatory Dec. 1, 2026) and event reporting "no later than 3:00 a.m. eastern time on the next business day"; the FAQ treats a subservicer as the "acting servicer" that must meet all reporting requirements (research/00a §3.1).

**FDCPA** 15 U.S.C. §1692a(6)(F)(iii) excludes from "debt collector" a person collecting a debt "which was not in default at the time it was obtained by such person." A loan boarded in default therefore makes Supermortgage a debt collector for that loan (Reg F validation notice, communication limits — Section 11.4). The default-status-at-boarding flag must be captured from the transferor tape and the platform's own delinquency computation as of the transfer date.

**MERS** Procedures Manual (Release 24.2, eff. Nov. 17, 2024): "The purchaser of an unregistered MERS Loan must take the necessary steps to ensure that it is registered on MERS® System no later than seven (7) calendar days after the date upon which the purchaser begins servicing the loan"; a Subservicer named on a MIN "must be a Member"; the Member performing a MIN update "must validate that the data being updated on MERS® System matches the corresponding data on its System of Record."

**Retention**: the blueprint cites A2-1-01; the operative text is Selling Guide A2-4.1-02 (12/19/2017), incorporated by Servicing Guide A2-5-01 (02/14/2024): all loan records "are Fannie Mae's property"; mortgage account records are kept for the life of the loan; "after a loan is liquidated, the servicer must keep the individual loan records for at least four years." "Life-of-loan + 4 yrs" is therefore correct; the citation is A2-4.1-02/A2-5-01, not A2-1-01.

**Discrepancies vs blueprint**: (1) retention citation should be Selling Guide A2-4.1-02 via A2-5-01; (2) "board before first post-transfer payment cycle" is not a regulatory deadline — the binding constraints are A2-7-03 "without interruption as of the transfer date," the §1024.33(c) 60-day payment treatment, LL-2026-05 next-business-day event reporting and the transferee's obligation to report the month after transfer (F-1-11); (3) the blueprint omits the fair-lending data elements (F-1-11) and the FDCPA default-at-boarding flag; (4) A2-7-03 still references an "eTransfer file" although the eTransfers application was retired Oct. 31, 2025 and all transfers now go through Form 629 in Quick Exchange (research/00b F11) **[PARTIALLY VERIFIED — Guide text vs retirement notice]**.

### Operational prerequisites
- Fannie Mae approval of the transfer (1.2) — Partner SoR; consent notice with D-Code (Document Transfers Job Aid v5) before any final tape is accepted.
- Form 101 Data Access Authorization executed by partner and Supermortgage (A2-1-07) so Supermortgage may read the partner's LSDU portfolio / Master Servicing Loan Position API — Partner + Supermortgage; days–weeks after servicer approval; scope must list LSDU, Servicing Platform events, SMDU.
- Supermortgage Technology Manager org, System IDs, `fnma-lsdu` and `fnma-servicing-events` credentials in the CLVE integration environment; Implementation Readiness Tracker completed as acting servicer — Supermortgage; TSP onboarding 2–6 months (research/00b F14).
- MERS membership with Subservicer role, Org ID, QA plan; batch (flat-file/XML) interface tested — Supermortgage; 2–4 weeks (1.5).
- Data-exchange agreement with the transferor covering the MISMO Servicing Transfer Catalog / ITSD deliverables, preliminary and final tape dates, image transfer schedule, SFTP/PGP keys — Partner (contractual) / Supermortgage (technical).
- Life-of-loan tax service, flood determination, insurance tracking and MI trading-partner setups able to accept a boarding file — Supermortgage; 4–12 weeks each.
- State servicer licenses for every property state in the batch (research/00a §5) — Supermortgage; the DQ gate hard-fails loans in unlicensed states.
- LL-2026-04 AI governance inventory entry for the `boarding` and `transfer` agents; evaluation suite run on the boarding fixture set — Supermortgage.

### Build spec
#### Inputs and triggers
- `transfer.batch.approved` (1.2; carries `fnma_consent_document_id`, `d_code`, `transfer_date`, `sale_date`, servicer numbers).
- Inbound files on the `transferor` SFTP adapter: `boarding_tape.preliminary` (T-30 to T-14), `boarding_tape.final` (close of business T-1, per F-1-11 trial-balance cutoff), `payment_history`, `escrow_history`, `escrow_analysis`, `lossmit_file`, `fc_bk_file`, `images_manifest`, `consents_file`, `correspondence_file`; each lands as `integration_messages` (direction `in`, idempotency key = SHA-256 of file) and emits `transfer.tape.received`.
- `fnma-lsdu` Master Servicing Loan Position pull (or LSDU CSV download via Form 101 access) for the transferor's servicer number, emitting `transfer.fnma_position.received`.
- Schedules: nightly `boarding.stage.validate` job until batch closes; `timer-sweep` for the timers below.
- Borrower actions do not start this process; borrower contact received before boarding completes is routed to the `case` agent with `loan.boarding_status`.

#### Data model
New tables (all with `created_at timestamptz`, append-only where noted; retention class `life_of_loan_plus_4y` unless stated; PII columns encrypted per baseline):
- `transfer_batches`: `id uuid pk`, `case_id` (→ `cases`, `case_type='transfer_in'`), `transfer_type` enum {`master_to_sub`,`sub_to_sub`,`servicing_sale_with_sub`,`custodian_only`}, `transferor_party_id` → `parties`, `transferor_servicer_number char(9)`, `partner_servicer_number char(9)`, `sale_date date null`, `transfer_date date not null` (must be first `fannie_et` business day of month), `respa_effective_date date not null` (first payment due to Supermortgage; 12 U.S.C. 2605(i)(1)), `d_code text null`, `fnma_consent_document_id`, `notice_mode` enum {`separate`,`combined`}, `status` (state machine below), `loan_count int`, `upb_total_cents bigint`, `escrow_total_cents bigint`, `rule_set_version text`.
- `transfer_batch_loans`: `id`, `batch_id`, `transferor_loan_number text`, `fnma_loan_number char(10)`, `min char(18) null`, `loan_id uuid null` (set on `loan.boarded`), `boarding_status` enum {`staged`,`validated`,`exception`,`boarded`,`reconciled`,`active`,`rejected_to_transferor`,`withdrawn`}, `default_status_at_boarding boolean`, `regx_days_delinquent_at_boarding int`, `fnma_delinquency_status_at_boarding text`, `fdcpa_debt_collector_flag boolean` (= default_status_at_boarding), `lossmit_in_process boolean`, `fc_active boolean`, `bk_active boolean`, `scra_active boolean`, `sii_present boolean`, `emortgage boolean`, `acp_enrolled boolean`.
- `boarding_tapes`: `id`, `batch_id`, `kind` enum {preliminary, final, payment_history, escrow_history, escrow_analysis, lossmit, fc_bk, images_manifest, consents, correspondence, trial_balance, custodial_recon, investor_reports}, `document_id` → `documents` (hash), `codec`, `row_count`, `received_at`, `as_of date`.
- `boarding_staging` (append-only): `batch_loan_id`, `tape_id`, `canonical_path text` (MISMO v3.6 path, e.g. `LOAN/TERMS_OF_LOAN/NoteRatePercent`), `raw_value text`, `canonical_value jsonb`, `mapping_rule_id`, `source_column text`.
- `boarding_validations` (append-only): `batch_loan_id`, `rule_code text`, `severity` enum {`hard`,`warning`,`info`}, `result` enum {`pass`,`fail`,`waived`}, `expected jsonb`, `actual jsonb`, `resolved_by` (agent run id or user id), `resolution` enum {`transferor_corrected`,`agent_corrected`,`waived_with_reason`,`rejected`}, `evidence_document_id`.
- `boarding_exceptions`: queue projection of open `hard`/`warning` failures with `owner` (agent/human role), `sla_timer_id`.
- Baseline tables written: `loans` (+ new columns `boarded_at`, `boarding_batch_id`, `default_status_at_boarding`, `fdcpa_debt_collector_flag`, `transferor_loan_number`, `prior_servicer_party_id`), `loan_terms` (effective-dated: note rate, P&I, maturity, ARM index/margin/caps/next change, late charge %/grace days, interest calc method, remittance type, deferred/forborne balances), `borrowers`/`loan_borrowers` (incl. preferred language, fair-lending elements stored in a restricted `borrower_fair_lending` table, retention `life_of_loan_plus_4y`, access-logged), `parties` (successors in interest, attorneys, ACP), `properties`, `escrow_accounts`/`escrow_lines`, `consents` (with `provenance='transferor'`, `verified=false`), `documents` (note/mortgage/allonge/assignment images, `retention_class='life_of_loan_plus_4y'`), `loan_events` (`loan.staged`, `loan.validated`, `loan.boarded`, `loan.boarding_exception.raised/resolved`).
- Unit definition used in this section: `business_days_federal` = days excluding Saturdays, Sundays and legal public holidays (Reg X "days (excluding legal public holidays, Saturdays, and Sundays)"); calendar `federal`. Distinct from `business_days_servicer` (§1024.31) and `business_days_fannie_et`.

#### State machine
Loan-level (`transfer_batch_loans.boarding_status`):
- `staged` —(all mapping rules applied, `boarding.stage.validate`)→ `validated` if zero open `hard` failures; else → `exception`.
- `exception` —(transferor correction file or agent auto-correction with evidence; re-validate)→ `validated`; —(hard failure unresolvable before `SM_BOARD_FIRST_CYCLE`)→ `rejected_to_transferor` (loan stays with transferor, batch amended via 1.2) or `boarded` with `boarding_hold=true` only if the loan is on the Fannie Mae-approved list and the failure is in a non-money field (decision below).
- `validated` —(transfer date reached and final tape reconciled per 1.6 at batch level)→ `boarded` (writes `loans`, `loan_terms`, ledger opening entries; emits `loan.boarded`).
- `boarded` —(1.6 loan-level reconciliation passes)→ `reconciled` —(MERS subservicer update confirmed 1.5, escrow lines active, hello notice sent 1.3, Escrow Setup events acked)→ `active`.
- Terminal: `active`, `rejected_to_transferor`, `withdrawn` (removed from Form 629 list).
Transitions are performed by the `boarding` agent; `waived_with_reason` on a hard rule requires `officer` approval; `rejected_to_transferor` requires the `transfer` agent to file the Form 629 amendment package (1.2).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `SM_BOARD_PRELIM_TAPE_14` | deadline | `transfer.batch.approved` | `transfer_date` | −14 calendar_days | `transfer.tape.received{kind=preliminary}` | escalate `transfer` agent → partner relationship owner (`officer`, sev 2) |
| `SM_BOARD_FINAL_TAPE_1` | deadline | `transfer.batch.approved` | `transfer_date` | +1 business_days_servicer (close of business T-1 per F-1-11, received by T+1) | `transfer.tape.received{kind=final}` | sev 1; hold cutover; `officer` |
| `SM_BOARD_FIRST_CYCLE` | deadline | `loan.staged` | earliest of (`transfer_date` + 3 business_days_servicer) and (first `next_due_date` ≥ `transfer_date`) | 0 | `loan.boarded` | sev 1 escalation; loan enters manual boarding; payment intake for the loan falls back to suspense (2.2) |
| `LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1` | deadline | `loan.boarded` (escrowed loans; `investor_reporting.escrow_events` flag on) | `boarded_at` | next business_days_fannie_et at 03:00 America/New_York | `investor_events.acked{type=EscrowSetup}` for every escrow category | sev 2 → `investor-reporting`; batch resubmit **[PARTIALLY VERIFIED — LL requires setup events for acquired loans; the deadline relative to boarding is inferred from the general 3:00 a.m. rule]** |
| `MERS_PROC_REGISTER_UNREGISTERED_7` | deadline | `loan.boarded{min is null, mers_eligible=true}` | `transfer_date` | +7 calendar_days | `mers.registration.confirmed` | sev 2 → `transfer` agent; QA log |
| `REGX_1024_39A_LIVE_CONTACT_36` / `REGX_1024_39B_WRITTEN_NOTICE_45` | deadline (owned by 11.1/11.2) | `loan.boarded{regx_days_delinquent>0}` | original earliest unpaid due date | per 11.1/11.2 | per 11.1/11.2 | seeded at boarding; if already past due at boarding, due immediately (day = boarding day) |
| `SM_BOARD_EXCEPTION_SLA_2` | deadline | `loan.boarding_exception.raised{severity=hard}` | raised_at | +2 business_days_servicer | `loan.boarding_exception.resolved` | sev 2 → `officer` if money field |
| `SM_BOARD_POST_TRANSFER_MONITOR_180` | recurring (monthly) | `transfer.batch.cutover_completed` | `transfer_date` | 6 × months | `transfer.batch.closed` | Bulletin 2020-02 4–6-month monitoring report to `officer` |

Jurisdiction overrides: none on the timers; `jurisdiction_rules.licensing_flags` drives hard rule `HF-020`.

#### Business rules and calculations
Canonical mapping: every transferor column maps to a MISMO v3.6 path (ITSD/LBDS Candidate Recommendation, Oct. 2, 2025) via a versioned `mapping_rules` set per transferor; unmapped columns are stored raw and flagged `info`.

Data-quality gate (evaluated per loan; hard = cannot board; warning = boards with an open exception):
- Hard: `HF-001` `fnma_loan_number` not 10 digits or not on the Fannie Mae-approved loan list / not in the transferor's LSDU position; `HF-002` remittance type ∉ {A/A, S/A, S/S} or ≠ Fannie Mae position; `HF-003` UPB on tape ≠ trial-balance UPB (cents) or ≠ Fannie Mae position UPB (for S/S, scheduled UPB); `HF-004` next due date missing or < transfer_date − 12 months; `HF-005` note rate, P&I, maturity, original term or interest-calc method missing, or fixed-rate P&I recomputation off by > $0.01; `HF-006` ARM loan missing index, margin, caps, look-back or next change date; `HF-007` escrow flag true with no lines, or escrow balance sign contradicts history; `HF-008` MIN present but fails Mod-10 check digit (18 digits = 7-digit Org ID + 10-digit sequence + check digit **[PARTIALLY VERIFIED — MERS check-digit algorithm from Member Guide practice]**), MIN not `Active`, or Servicer Org ID ≠ partner/transferor; `HF-009` bankruptcy flag with no chapter/case number/filing date; `HF-010` foreclosure flag with no referral date/attorney; `HF-011` loss-mit-in-process flag with no application status/received date (1.7); `HF-012` SCRA flag with rate > 6% and no cap reason; `HF-013` borrower legal name or TIN missing; `HF-014` property address/state missing; `HF-015` late-charge percentage/grace days missing; `HF-016` deferred/forborne balances present but not separated from interest-bearing UPB; `HF-017` duplicate `fnma_loan_number`/`min` in batch or platform; `HF-018` no custody record (custodian/certification status or eNote eVault reference) — defined in 1.4; `HF-020` property state not covered by a Supermortgage servicer license (`jurisdiction_rules.licensing_flags`).
- Warning: `W-001` phone/email missing; `W-002` E-SIGN consent evidence missing; `W-003` TCPA consent evidence missing; `W-004` tax parcel unverified; `W-005` hazard policy expires < 30 days after transfer; `W-006` MI flag without certificate number; `W-007` flood determination older than life-of-loan contract evidence; `W-008` successor-in-interest data incomplete; `W-009` last escrow analysis > 12 months old; `W-010` unapplied funds ≥ 1 full payment; `W-011` fair-lending data missing for originations ≥ 2023-03-01; `W-012` preferred language missing; `W-013` ACP enrollment; `W-014` payment history gaps > 1 month; `W-015` fees/advances without itemization ("understand ... the amount and nature of all servicing advances and fees," A2-7-03); `W-016` MERS investor/note-owner field ≠ Fannie Mae — defined in 1.5.

Default status at boarding: `default_status_at_boarding = (regx_days_delinquent_at_boarding > 0 as of transfer_date) OR bk_active OR fc_active`; `regx_days_delinquent` is computed from the transferor payment history using the §1024.31 FIFO definition, not from the tape's delinquency code; `fnma_delinquency_status_at_boarding` uses the MBA 30/60/90 buckets. Both counters are persisted; 11.4 keys FDCPA treatment off `fdcpa_debt_collector_flag`.

Fixed-rate P&I recomputation (rule `HF-005`): with `decimal.js` precision 20, `r = note_rate/12`, `n = remaining_term_months`, `P&I = UPB × r / (1 − (1+r)^−n)` computed on the original amortization (original UPB, original term) and compared with the tape's P&I; tolerance $0.01. Interest check: `scheduled_interest = round_half_up(UPB_cents × note_rate / 12)`. Worked example: UPB 24,563,412 cents ($245,634.12), rate 6.375% → 245,634.12 × 0.06375 / 12 = 1,304.9313 → **$1,304.93**; tape P&I $1,616.03 → principal portion $311.10 → expected UPB after next payment 24,532,302 cents; if the transferor's history shows $311.11 principal, the loan raises `W-014`-class interest-method review (30/360 vs actual) rather than a hard fail.

Remittance-type branching at boarding: A/A → seed cash-position projections and the LL-2026-05 automatic-draft flag (later phase); S/A → seed scheduled-interest advance logic (C-3-01); S/S → seed scheduled P&I advance and Stop Delinquency Advance counters (5.4) from the transferor's advance history (F-1-11: transferee reimburses transferor for advanced delinquent interest/scheduled P&I after final accounting).

#### Integrations
- **Transferor SFTP/PGP** (inbound files; MISMO Servicing Transfer Catalog templates; fallback CSV with agreed layout). Idempotency by file hash; every file acknowledged by an outbound `receipt.json`; rejects produce a `transfer.tape.rejected` message listing row-level failures. On outage: retry hourly, `SM_BOARD_PRELIM_TAPE_14`/`SM_BOARD_FINAL_TAPE_1` escalate.
- **`fnma-lsdu` / Master Servicing Loan Position API** (read, OAuth ROPC, partner-scoped via Form 101; spec behind login **[UNVERIFIED endpoint/fields]**; fallback LSDU CSV download by `fnma_portal_operator`). Used for `HF-001`–`HF-003`.
- **`fnma-servicing-events`** — Escrow Setup events (JSON API or CSV bulk ≤5 MB/12,000 events) after boarding; ack/reject reconciliation via `investor_events`.
- **`mers`** — MIN status/lookup via batch or MERS Link (read) for `HF-008`; updates in 1.5.
- **`tax-service`, `flood`, `insurance-tracking/lpi`, `mi/*`** — outbound boarding files (vendor layouts contract-gated **[UNVERIFIED]**), each acked; failures raise warnings, not hard fails.
- **`custodian`** — trial balance out (1.4).
- No Fannie Mae portal step in 1.1 except the LSDU CSV fallback (`human_portal_task` package: servicer number, loan list, requested download, due time).

#### Outputs and artifacts
- `loans`, `loan_terms`, `escrow_accounts`, `escrow_lines`, `parties`, `consents` records; `documents` for every image with SHA-256 and `retention_class='life_of_loan_plus_4y'`.
- Ledger: opening balanced entries per loan at `loan.boarded` (1.6 defines the postings).
- Investor events: `EscrowSetup` per escrow category (post Dec. 1, 2026); first-cycle LAR/events per 5.1.
- Reports: batch DQ scorecard (hard/warning counts by rule), Bulletin 2020-02 transfer plan and post-transfer de-brief (documents, retention `respa_5y`).
- No borrower notices are emitted by 1.1 (1.3 and 3.1 emit them).

#### AI agent design (AI-first)
`boarding` agent (tools: `readTape`, `mapField`, `runValidation`, `queryFnmaPosition`, `queryMers`, `proposeCorrection`, `applyCorrection` (non-money fields only), `raiseException`, `boardLoan`, `sendTransferorQuery`, `writeDecision`). End-to-end: ingests each tape, applies the mapping set, runs the gate, drafts transferor correction requests with row-level evidence, auto-corrects deterministic defects (formatting, enumerations, derived fields) with a decision record, and boards loans that pass. Decision record schema: `{batch_loan_id, rule_code, action, evidence_document_ids, confidence, rule_set_version, model_version, prompt_version, rationale}`. Guardrails: money fields (UPB, escrow, suspense, advances, fees, P&I, rate) are never agent-corrected — only transferor-corrected or `officer`-waived; the agent may not board a loan with an open hard failure; every waiver needs a human. Escalations: `officer` for money-field waivers and for batches with > 2% hard-fail rate at T-7; `fnma_portal_operator` for the LSDU fallback; `human_agent` if a borrower calls about a loan still in `staged`. Disclosure/consent: consents on the tape are stored as `provenance='transferor', verified=false`; the AI voice channel may not be used for outbound calls on a loan until `tcpa_voice` consent is verified (11.1). If the AI path is off, the same queue is worked by human boarding analysts using the ops-console with identical rule codes.

#### Edge cases and failure modes
- Transfer date falls in a month where a payment is already due on the transfer date: `SM_BOARD_FIRST_CYCLE` = transfer_date; boarding must complete from the preliminary tape and be re-based on the final tape (delta boarding).
- Loan paid off, foreclosed or repurchased between preliminary and final tape: `withdrawn`; Form 629 loan list amended (1.2).
- Loss-mit in process without documents: hard fail `HF-011`; comment 41(k)(1)(i)-1 makes the transferee responsible for obtaining them before asking the borrower.
- Bankruptcy/SCRA/disaster overlays: flags drive `bankruptcy`/`scra` cases opened at `loan.boarded` (14.1, 13.8/13.9); disaster-area loans inherit forbearance under A2-7-03 "honor any forbearance agreements."
- Successor in interest confirmed by transferor: `parties` record with `sii_confirmed_at` carried over; unconfirmed potential successors reopen 4.4 with the transferor's request date.
- Partial data: board with warnings; W-002/W-003 block electronic delivery and AI voice until verified.
- Vendor outage (tax/flood/insurance): warnings; no boarding block.
- Fannie Mae position mismatch caused by transferor's late LAR: hold in `exception` until the transferor's final LAR posts (F-1-11 transferor reports the transfer month).
- Retro-corrections: a post-boarding transferor correction is a new `loan_terms` version or ledger reversal entries, never an edit; §1024.35(b)(8) NoEs against the transferor are logged for the partner.

#### Test cases and acceptance criteria
- 1.1-T1 Given a 5,000-loan preliminary tape with all hard rules satisfied, when validated, then 100% `validated` within the nightly job and a DQ scorecard is produced.
- 1.1-T2 Given a loan whose tape UPB is $245,634.12 and Fannie Mae position shows $245,634.13, when validated, then `HF-003` fails, the loan is `exception`, and the transferor query lists both values in cents.
- 1.1-T3 Given a fixed-rate loan (6.375%, UPB $245,634.12) with tape P&I $1,616.03, when `HF-005` runs, then recomputed P&I is within $0.01 and monthly interest equals $1,304.93.
- 1.1-T4 Given a MIN with a wrong check digit, then `HF-008` fails and the loan cannot board.
- 1.1-T5 Given a loan with earliest unpaid due date Aug. 1, 2026 and transfer date Oct. 1, 2026, then `regx_days_delinquent_at_boarding` = 61, `fdcpa_debt_collector_flag` = true, and 11.1/11.2 timers are seeded as already breached (immediate action).
- 1.1-T6 Given transfer date Oct. 1, 2026 (Thursday) and a loan whose next due date is Oct. 1, then `SM_BOARD_FIRST_CYCLE` due = Oct. 1, 2026; boarded Oct. 2 → breach recorded and escalated.
- 1.1-T7 Given an escrowed loan boarded Dec. 2, 2026 (Wednesday) at 16:00 ET, then `EscrowSetup` events are due 03:00 ET Dec. 3, 2026; a rejected event re-queues and breaches if not acked by then.
- 1.1-T8 Given a money-field hard failure, when the agent proposes a waiver, then the command is refused without an `officer` approval record.
- 1.1-T9 Given a property in a state without a Supermortgage servicer license, then `HF-020` fails and the batch report shows it at T-14.
- 1.1-T10 Given a duplicate file upload (same hash), then the second is ignored with an idempotent receipt.

#### Audit and evidence
`loan_events` (`loan.staged/validated/boarded`), `boarding_validations` history, `agent_decisions` per correction/waiver, `documents` hashes for every tape and image, transferor correction correspondence, the Bulletin 2020-02 transfer plan/de-brief, timer history for `SM_BOARD_FIRST_CYCLE` and `LL_2026_05_ESCROW_SETUP_ACQUIRED_BD1`, and the DQ scorecard — all exportable for MORA, state exams and §1024.35(b)(8) disputes.

### Open questions / decisions
1. Board loans with open non-money hard failures at T-0 to preserve payment continuity? Default: no — hard means hard; `SM_BOARD_FIRST_CYCLE` breach routes payments to suspense (2.2) with manual boarding.
2. Fair-lending elements storage: restricted table with access logging (default) vs. separate service.
3. Whether the LSDU/Loan Position read is done under Supermortgage's TSP identity or partner Related-Party credentials — default: partner-scoped Form 101 credentials.
4. Tolerance for interest-method discrepancies (30/360 vs actual/360) — default: warning + escrow-style review, not hard.

### Sources
- Reg X §1024.38 (eCFR, current as of Sept. 3, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.38
- Reg X §1024.35 (verified 2026-09-09): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.35
- Supplement I comments 38(b)(4): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024
- Servicing Guide A2-7-03 (05/13/2026): https://servicing-guide.fanniemae.com/svc/a2-7-03/post-delivery-servicing-transfers
- Servicing Guide F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
- Servicing Guide A2-5-01 (02/14/2024): https://servicing-guide.fanniemae.com/svc/a2-5-01/ownership-and-retention-individual-mortgage-loan-files-and-records ; Selling Guide A2-4.1-02 (12/19/2017): https://selling-guide.fanniemae.com/sel/a2-4.1-02/ownership-and-retention-loan-files-and-records
- LL-2026-05 (June 24, 2026): https://singlefamily.fanniemae.com/media/document/pdf/lender-letter-ll-2026-05-advance-notice-changes-servicing-processes-and-systems
- CFPB Bulletin 2020-02: https://files.consumerfinance.gov/f/documents/cfpb_policy-guidance_mortgage-servicing-transfers_2020-04.pdf ; May 12, 2025 withdrawal list (does not include 2014-01/2020-02): https://www.federalregister.gov/documents/2025/05/12/2025-08286/interpretive-rules-policy-statements-and-advisory-opinions-withdrawal
- MERS System Procedures Manual Release 24.2: https://www.mersinc.org/publicdocs/mers/00MERS00System_Proc.pdf
- MISMO LBDS/ITSD (Candidate Recommendation Oct. 2, 2025): https://www.mismo.org/standards-resources/mismo-product/loan-boarding-data-segment-of-the-industry-transfer-of-servicing-dataset-(itsd) ; MSTC: https://www.mismo.org/standards-resources/mismo-product/servicing-transfer-catalog
- 15 U.S.C. §1692a(6)(F): https://www.law.cornell.edu/uscode/text/15/1692a
- research/00a §3.1 (LL-2026-05 FAQ "acting servicer"), research/00b F2/F11/N1.
