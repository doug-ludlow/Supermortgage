# 17.2 — RESPA goodbye notice

| Attribute | Value |
|---|---|
| Section | 17 — Servicing Transfer-Out |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On transfer |
| Governing source | Reg X 1024.33(b) |
| Key deadlines | ≥15 days before effective date |
| Timers | `FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5`, `REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60`, `REGX_1024_33B3_COMBINED_15`, `REGX_1024_33B3_EXCEPTION_30`, `REGX_1024_33B3_GOODBYE_15`, `REGX_1024_33C1_LATE_FEE_PROTECTION_60`, `SM_1024_33C2_FORWARD_PROMPT_1`, `SM_TOLLFREE_LIVE_GATE`, `SM_XFER_OUT_AUTODRAFT_STOP_T0`, `SM_XFER_OUT_BORROWER_ROUTING_90`, `SM_XFER_OUT_CORRECTIVE_NOTICE_5`, `SM_XFER_OUT_FINAL_STATEMENT_GATE`, `SM_XFER_OUT_FORWARD_FILE_DAILY`, `SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Transfer-Out |
| Trigger & frequency | On transfer |
| Governing source (blueprint) | Reg X 1024.33(b) |
| Key deadlines (blueprint) | ≥15 days before effective date |
| Data/artifacts | Notice |
| Systems | Print/mail |
| Automation class (blueprint) | a |
| SoR / Sub | Sub |
| Nuances (blueprint) | (none in source) — reconstructed: combined notice, (b)(2) exclusions, 30-day exception, "effective date of transfer" definition, 60-day payment window with the transferor's "promptly forward or return" duty, skip trace, short-year escrow statement, final statement, autodraft stop |

### Verified requirement (as of 2026-09-09)

**§1024.33(b)** (eCFR current as of Sept 3, 2026; operative text quoted in 1.3): each transferor and transferee "shall provide to the borrower a notice of transfer" for "any assignment, sale, or transfer of the servicing of the mortgage loan." **(b)(2)** — no notice is required for transfers between affiliates, transfers resulting from mergers/acquisitions of servicers or subservicers, and "transfers between master servicers without changing the subservicer," in each case only "if there is no change in the payee, address to which payment must be delivered, account number, or amount of payment due"; a subservicer change that moves the payee or payment address is never excluded. **(b)(3)(i)** — "the transferor servicer shall provide the notice of transfer to the borrower not less than 15 days before the effective date of the transfer"; a single combined notice satisfies both servicers if given "not less than 15 days before the effective date." **(b)(3)(ii)** — notice "not more than 30 days after the effective date" is permitted when the transfer is preceded by termination of the servicing contract for cause, commencement of the servicer's bankruptcy, or FDIC/NCUA receivership/conservatorship — the only Section 17 case where this can apply is a `fnma_directed` for-cause termination of the partner or of Supermortgage's contract. **(b)(4)** content: effective date; transferee name, address and collect-call/toll-free number; the same for the transferor; "the date on which the transferor servicer will cease accepting payments … and the date on which the transferee servicer will begin to accept payments" (same or consecutive days); optional-insurance effect and any borrower action; the statement that the transfer does not affect any term other than servicing terms. Appendix MS-2 is the optional model and carries the 60-day sentence. Comment 33(b)(3)-1: mail to the address in the loan documents unless the borrower gave a new address per the servicer's requirements. **"Effective date of transfer"** = "the date on which the mortgage payment of a borrower is first due to the transferee servicer" (12 U.S.C. 2605(i)(1), incorporated by §1024.2(b)).

**§1024.33(c)** — (c)(1): "during the 60-day period beginning on the effective date of transfer," a payment received by the transferor "on or before the applicable due date (including any grace period)" may not be treated as late "for any purpose" and no late fee may be imposed (comment 33(c)(1)-1); (c)(2): a transferor that receives such a payment "shall promptly either: (i) transfer the payment to the transferee servicer for application to a borrower's mortgage loan account, or (ii) return the payment to the person that made the payment and notify such person of the proper recipient of the payment." **§1024.33(d)**: compliance satisfies state borrower-notice laws; state requirements that are not borrower disclosures (e.g., notices to insurers) are not preempted.

**§1024.17(i)(4)(ii)** (eCFR current as of Sept 8, 2026): "the transferor (old) servicer shall submit a short year statement to the borrower within 60 days of the effective date of transfer"; the statement is an annual statement (§1024.17(i)(1) content) covering the period from the last annual statement through the transfer, and the new servicer may keep or reset the computation year (§1024.17(e)). Reg Z §1026.41 periodic statements: no statement is owed for a billing cycle in which Supermortgage is not the servicer (7.1); the last statement Supermortgage issues covers the cycle ending before T (7.1 test T15). **Reg Z §1026.39** (eCFR current as of Sept 8, 2026): the ownership-transfer notice attaches to a "covered person" that acquires legal title; "a transfer of servicing rights without transferring legal title does not trigger" it — Fannie Mae remains owner, so no §1026.39 notice is generated by Section 17 (note only).

**Fannie Mae A2-7-03**: "All notices provided to borrowers must be made in accordance with applicable law, including the provisions of the RESPA"; "if the servicer determines that the RESPA notification of transfer letter is returned, the servicer must initiate skip trace activities to obtain an alternate mailing address." F-1-11: the transferor delivers a "list of loans subject to automatic monthly payment drafting," so the transferee can re-establish drafting; whether an existing ACH authorization may be assigned to the transferee or a new authorization is needed is a Nacha/contract question **[UNVERIFIED — default: authorizations are delivered as evidence; the transferee obtains its own]**.

**RESPA "servicer" for a subservicer change**: 12 U.S.C. 2605(i)(2)–(3) define the servicer as the person responsible for receiving scheduled periodic payments; Supermortgage, not the partner, is therefore the transferor servicer that owes the goodbye notice in a `sub_to_sub`/`sub_to_master`/`servicing_sale` transfer, and it owes the notice in its own name.

**Discrepancies vs blueprint**: (1) the blueprint's single deadline hides the combined-notice option, the (b)(2) exclusions and the 30-day exception; (2) the transferor's obligations do not end at mailing — the 60-day "promptly forward or return and notify" duty and the 60-day short-year escrow statement are transferor duties; (3) "Sub" is correct and legally required (Supermortgage is the RESPA servicer), not merely an operational allocation.

### Operational prerequisites
- Print-mail vendor with proof of mailing and return-mail imaging (1.3) — Supermortgage.
- Transferee's notice data (name, remittance address, toll-free number, payment start date, optional-insurance statement) received and verified by T-20; combined-notice agreement and signatory authority where used — Supermortgage + transferee.
- Supermortgage toll-free number and IVR/AI scripts for the transfer period, staffed through the support window (17.3) — Supermortgage; live by T-15.
- Address file with confirmed successors, ACP substitute addresses and bankruptcy counsel of record (4.4, 14.x) — from the system of record.
- Escrow short-year statement template (3.3) and the final-statement variant (7.1) versioned in the Notice Registry.

### Build spec
#### Inputs and triggers
- `transfer.batch.approved{direction=out}` and `transfer.loan_list.attested` (17.1) → goodbye run planning on the frozen list.
- `transferee.notice_data.received` (SFTP/e-mail; parsed into `transfer_batches.transferee_notice_block`).
- `transfer.batch.cutover_completed` → payment-hold and forwarding mode (2.2 `payment_holds{transfer_out_cutover}`).
- `payment.received{loan.status='transferred_out'}` (lockbox, ACH, card, mail) → misdirected-payment handling.
- `mail.returned{template∈RESPA}` → skip trace.
- `escrow.short_year.due` (scheduler at T) → short-year statement run.
- Borrower inbound contact after T → `borrower-comms` routing with the transferee's details.

#### Data model
- **Notice-code convention:** `NTC_` + citation + subject (7.1 owns the registry; `notice_templates.code` is a primary key, so one artifact has exactly one code across all sections). The codes below were previously spelled `NT_RESPA_*` / `NT_ESCROW_*`; Section 1 (1.3) has been renamed to the same `NTC_REGX_1024_33B_*` codes, so the transfer-in and transfer-out sides of one mailing now point at the same registry rows. `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR` is the same artifact 3.3 renders and satisfies 3.3's `REGX_1024_17I4_SHORT_YEAR_TRANSFER_60`; Section 3's notice templates have been converted to the same `NTC_` convention (its `ESC_*` **timer** codes are unchanged and remain valid).
- `notice_templates`: `NTC_REGX_1024_33B_GOODBYE_MS2`, `NTC_REGX_1024_33B_COMBINED_MS2` (1.3, now issued by Supermortgage as transferor), `NTC_REGX_1024_33B_CORRECTIVE` (cancellation/date change), `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR` (§1024.17(i)(4)(ii); checklist = §1024.17(i)(1) annual-statement items + transfer date + transferee escrow contact), `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` (§1024.33(c)(2)(ii) "proper recipient" notice when a payment is returned rather than forwarded).
- `transfer_notice_runs` (1.3) with `kind` extended {`goodbye`,`combined`,`corrective`,`short_year_escrow`,`final_statement`}.
- `misdirected_payments` (1.3) with `direction='out'`: `received_by='supermortgage'`, `received_at`, `amount_cents bigint`, `instrument` enum {check, ach, card, wire, cash}, `protected boolean` (computed), `disposition` enum {`forwarded`,`returned_to_payor`}, `forwarded_at`, `forward_reference`, `transferee_ack_at`, `return_notice_id`.
- `loans` new columns: `status='transferred_out'`, `transfer_out_at date` (= `transfer_date`), `respa_effective_date`, `transfer_window_end_date` (= effective date + 59 days), `transferee_party_id`, `transferee_loan_number`, `transferee_contact jsonb` (name, address, toll-free, hours), `transferee_remittance_address`.
- `contact_scripts` version `transfer_out.v1` for the `borrower-comms` agent.
- Retention: notices and proofs `respa_5y`; `misdirected_payments` `life_of_loan_plus_4y`.

#### State machine
Goodbye run (1.3): `planned` → `rendered` → `qc_passed` → `released_to_vendor` → `mailed` → `complete`; per-notice `returned` → `skip_trace` → `remailed`/`undeliverable_documented`. Release requires (a) the transferee's notice block verified, (b) `SM_TOLLFREE_LIVE_GATE`, (c) the frozen list, (d) `officer` (Supermortgage) authorization — no partner signature is needed because Supermortgage is the transferor of record, but the partner is copied. Short-year run: `planned` (at T) → `rendered` (escrow history through T-1 incl. interest on escrow credited) → `qc_passed` → `mailed` → `complete`. Misdirected payment: `received` → `classified` (protected / not) → `forwarded` (wire + detail file, transferee ack) or `returned` (instrument returned + `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN`) → `closed`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_33B3_GOODBYE_15` (1.3; Supermortgage's own duty) | deadline | `transfer.batch.approved{direction=out}` | `respa_effective_date` | −15 calendar_days | `notice.mailed{NTC_REGX_1024_33B_GOODBYE_MS2 or NTC_REGX_1024_33B_COMBINED_MS2}` for every loan on the frozen list | sev 1 → `officer`; transfer date slips one month unless (b)(3)(ii) applies |
| `REGX_1024_33B3_COMBINED_15` (1.3) | deadline | `transfer.batch.approved{direction=out, notice_mode=combined}` | `respa_effective_date` | −15 calendar_days | `notice.mailed{NTC_REGX_1024_33B_COMBINED_MS2}` | sev 1; fallback: separate goodbye immediately |
| `REGX_1024_33B3_EXCEPTION_30` (1.3) | deadline | `transfer.batch.approved{exception_basis∈termination_for_cause,bankruptcy,fdic,ncua}` | `respa_effective_date` | +30 calendar_days | goodbye mailed | sev 1 |
| `SM_XFER_OUT_TRANSFEREE_NOTICE_DATA_T20` | deadline | `transfer.batch.approved{direction=out}` | `respa_effective_date` | −20 calendar_days | `transferee.notice_data.verified` | sev 2 → `transfer` agent chases transferee; `officer` |
| `SM_TOLLFREE_LIVE_GATE` (1.3) | not_before_gate | `transfer_notice_run.planned` | — | toll-free/IVR scripts verified | `contact_center.ready` | run cannot be released |
| `REGX_1024_33C1_LATE_FEE_PROTECTION_60` (1.3; transferor side) | not_before_gate (window) | `transfer.batch.cutover_completed` | `respa_effective_date` | days 1–60 calendar | expires day 61 | payments received in-window are classified `protected` and the forwarding file carries the receipt date |
| `SM_1024_33C2_FORWARD_PROMPT_1` (1.3) | deadline | `payment.received{loan.status='transferred_out'}` | `received_at` | +1 business_days_servicer ("promptly") | `misdirected_payment.forwarded` or `.returned` with notice | sev 2 → `cashiering`; Compliance Sentinel |
| `SM_XFER_OUT_FORWARD_FILE_DAILY` | recurring | `transfer.batch.cutover_completed` | each servicer business day, 17:00 local | daily through day 90 (support window) | `transferee.forward_file.acked` | sev 3 |
| `REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60` (1.6; now owned) | deadline | `transfer.batch.cutover_completed` (escrowed loans) | `respa_effective_date` | +60 calendar_days | `notice.mailed{NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR}` | sev 1 → Compliance Sentinel |
| `SM_XFER_OUT_FINAL_STATEMENT_GATE` | not_before_gate | `statement.cycle.opened` | cycle due date | no statement for cycles with due dates ≥ `transfer_date` (7.1) | — | statement generator refuses |
| `SM_XFER_OUT_AUTODRAFT_STOP_T0` | deadline | `transfer.batch.approved{direction=out}` | `transfer_date` | 0 (no ACH debit with settlement date ≥ T) | `autodraft.schedule.terminated` for every drafted loan | sev 1; any debit after T is refunded within 1 BD |
| `FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5` (1.3) | deadline | `mail.returned{template∈RESPA}` | returned_at | +5 business_days_servicer | `skiptrace.completed` + remail/documented | sev 3 |
| `SM_XFER_OUT_CORRECTIVE_NOTICE_5` | deadline | `transfer.batch.cancelled/date_changed` after goodbye mailed | event date | +5 business_days_servicer (policy) | `notice.mailed{NTC_REGX_1024_33B_CORRECTIVE}`; a new goodbye ≥15 days before any new date | sev 1 |
| `SM_XFER_OUT_BORROWER_ROUTING_90` | recurring (window) | `transfer.batch.cutover_completed` | `transfer_date` | days 1–90 | `borrower-comms` scripts active; after day 90 calls are referred with the transferee's number only | — |

Jurisdiction overrides: none on timing (§1024.33(d)); correspondence footers and license numbers via `jurisdiction_rules.correspondence_footer`; interest-on-escrow states require accrued interest through T-1 on the short-year statement (3.9).

#### Business rules and calculations
- `respa_effective_date`: default = `transfer_date`; **conservative override** (decision 1): when the first calendar day of the transfer month is not a Fannie Mae business day and the loan's installment is due on the 1st, set `respa_effective_date` = the 1st (the payment is "first due to the transferee" on that date), so the goodbye deadline is computed from the earlier date; the notice shows Supermortgage ceasing to accept payments on the last day of the prior month and the transferee beginning on the 1st (consecutive days, (b)(4)(iv)). Worked examples: T = Tue Dec 1, 2026 → goodbye by **Mon Nov 16, 2026**; window Dec 1, 2026 – **Jan 29, 2027**; short-year statement by Sat Jan 30, 2027 → mailed by **Fri Jan 29, 2027**. T = Mon Nov 2, 2026 with payments due on the 1st → `respa_effective_date` = Sun Nov 1 → goodbye by **Sat Oct 17** → run released **Fri Oct 16, 2026**; window Nov 1 – Dec 30, 2026.
- Notice content (machine-checked before release): (i) effective date; (ii) transferee block; (iii) Supermortgage block (name, address, toll-free number staffed through the support window); (iv) "Supermortgage will stop accepting payments on <T−1>; <transferee> will begin accepting payments on <T>"; (v) optional-insurance paragraph ("no change" wording when none exists — 1.3 decision 4); (vi) servicing-terms-only statement; the MS-2 60-day sentence; autodraft instructions (drafts stop after the last draft before T; the transferee's enrollment instructions if supplied); the partner identified as master servicer where the partner brand was used on statements (1.3 decision 1). Combined notices carry both signatures.
- Recipients: each borrower at their own address of record; confirmed successors in interest; ACP substitute addresses; for borrowers in bankruptcy a copy to counsel of record (informational; 14.x); deceased borrowers' estates per 4.4.
- Protected-payment rule (transferor view): `protected = received_at ≤ due_date + grace_days AND received_at ∈ [respa_effective_date, window_end]`. Every misdirected payment is forwarded with its Supermortgage receipt date so the transferee can credit as of that date; forwarding is the default disposition; return-to-payor is used only when the instrument cannot be negotiated or forwarded (e.g., stale check, closed transferee lockbox) and always with `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN`. Worked example: installment due Dec 1, 2026, grace 15 days; check received by Supermortgage Dec 14 → `protected=true`; wired with the Dec 15 forwarding file; the transferee must post as of Dec 14 without a late charge. Check received Dec 20 → `protected=false`; still forwarded within 1 business day (Dec 21) — protection is the transferee's determination, but the receipt date travels with the funds. A payment received Jan 30, 2027 (day 61) → forwarded; not protected.
- Money handling: misdirected funds are deposited to a Supermortgage `transfer_out_clearing` custodial sub-account (never to the partner's P&I remittance flow after the final period), wired daily to the transferee's custodial account with a detail file (loan, borrower, receipt date, amount, instrument, image reference); ledger: Dr `custodial_pi_cash(clearing)` / Cr `due_to_transferee`; on wire Dr `due_to_transferee` / Cr `custodial_pi_cash(clearing)`; nothing is posted to the transferred loan's ledger.
- Short-year statement: covers `last_annual_statement_date + 1` through T-1; includes escrow interest credited through T-1 in interest-on-escrow states (3.9), the closing balance transferred, and the transferee's name; the statement is Supermortgage's regardless of the transferee's later initial statement (§1024.17(e)).
- Autodraft: the last Supermortgage-originated debit is the one whose settlement date < T; scheduled debits with settlement ≥ T are cancelled at T-3 BD; any debit that settles on/after T is refunded within 1 business day and reported in the forwarding file.

#### Integrations
- **`print-mail`** (1.3): goodbye/combined, corrective, short-year statement, return-payment notices; proof of mailing and return-mail feeds; fallback in-house print with PS Form 3665.
- **Transferee** (SFTP/PGP): notice data block inbound; daily `misdirected_payments.csv` + wire outbound; acknowledgment inbound; mismatches → `transferee_requests` (17.3).
- **`nacha`** (2.3): cancellation of scheduled debits; refund entries for post-T settlements.
- **`lockbox`/`custodial-bank`** (2.x, 6.x): post-T receipts routed to `transfer_out_clearing`; lockbox instructed to forward mail-in payments/coupons received after day 90 to the transferee's lockbox (bank-specific **[UNVERIFIED]**).
- **`telephony/voice`**, borrower portal, e-delivery: transfer banner from T-15; payments disabled from T; documents downloadable through day 90; the AI assistant discloses automation and reads the transferee's details.
- No Fannie Mae interface.

#### Outputs and artifacts
- Notices `NTC_REGX_1024_33B_GOODBYE_MS2` / `NTC_REGX_1024_33B_COMBINED_MS2` (§1024.33(b)(4); Appendix MS-2), `NTC_REGX_1024_33B_CORRECTIVE`, `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR` (§1024.17(i)(4)(ii)), `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` (§1024.33(c)(2)(ii)); channel: mail always; an additional electronic copy to borrowers with verified `esign` consent (7.4).
- `notices` with proof of mailing; `loan_events` `notice.transfer.goodbye.sent`, `notice.escrow.short_year.sent`, `payment.misdirected.received/forwarded/returned`, `autodraft.schedule.terminated`; `misdirected_payments`; ledger clearing postings; no investor events (5.x reporting stops at the final period, 17.3).

#### AI agent design (AI-first)
`transfer` agent (tools: `planNoticeRun`, `renderNotice`, `runContentChecklist`, `validateAddress`, `verifyTransfereeBlock`, `releaseToVendor`, `ingestMailReturns`, `orderSkipTrace`, `writeDecision`) plans and releases the goodbye and short-year runs end-to-end; `cashiering` agent classifies and forwards misdirected payments and cancels drafts; `escrow` agent renders the short-year statement; `borrower-comms` agent handles "who do I pay," "where is my payment," and "why did my draft stop" contacts with the disclosure script, identity verification, and a warm transfer to `human_agent` on request. Decision record: `{run_id or payment_id, loans, checklist_results, disposition, protected, rationale}`. Escalations: `officer` (Supermortgage) for run release, corrective notices and any decision to return rather than forward; `human_agent` on request; no `attorney`/`signing_officer`. TCPA: no outbound calls/texts are generated; inbound only. Human path: ops-console notice workbench and payment-forwarding queue with the same records.

#### Edge cases and failure modes
- Transfer cancelled or date moved after mailing: corrective notice within 5 business days; new goodbye ≥15 days before any new date; timers cancelled with reason and re-issued.
- Transferee's data block arrives late (< T-20): release with Supermortgage's block complete and the transferee's block as provided; missing transferee toll-free number blocks release (required content) → escalate to the partner.
- `master_change_sub_retained`: no notice (17.1); a sale with a payee change → notice.
- For-cause Fannie Mae termination with immediate effect: (b)(3)(ii)(A) 30-day post-effective notice; the platform requires `officer` confirmation that the basis is met before relying on it.
- Borrower in bankruptcy: notice to borrower and counsel; trustee payment-address change is 17.3.
- Returned notice: skip trace within 5 business days; remail; original proof of mailing preserved.
- Borrower keeps paying Supermortgage after day 60: forward with receipt dates; after day 90 (support window end) forward on receipt and refer the borrower to the transferee; the lockbox is closed to the loan's coupons.
- ACH debit settles on T because the cancellation missed the Nacha window: refund within 1 business day; report in the forwarding file; QA finding.
- Deceased borrower/potential successor: notice to the estate/known successor; SII case (4.4) handed off in 17.4.
- Loans hard-failed at the transferee (not boarded on time): borrower calls Supermortgage — script directs to the transferee; Supermortgage may not accept payments after T other than as misdirected payments.

#### Test cases and acceptance criteria
- 17.2-T1 Given T = Dec 1, 2026 and separate notices, when the goodbye run is mailed Nov 16, 2026, then `REGX_1024_33B3_GOODBYE_15` is satisfied; mailed Nov 17 → breached with `officer` escalation.
- 17.2-T2 Given T = Nov 2, 2026 with installments due on the 1st, then `respa_effective_date` = Nov 1 and the goodbye deadline is Oct 17 (run scheduled Oct 16).
- 17.2-T3 Given a rendered notice missing the transferee's toll-free number, then release is refused.
- 17.2-T4 Given a check received Dec 14, 2026 on a loan due Dec 1 (grace 15), then `protected=true`, the forwarding file of Dec 15 carries receipt date Dec 14, and `SM_1024_33C2_FORWARD_PROMPT_1` is satisfied.
- 17.2-T5 Given a check received Dec 20, then `protected=false` and it is still forwarded by Dec 21.
- 17.2-T6 Given a payment returned to the payor, then `NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` exists naming the transferee.
- 17.2-T7 Given an escrowed loan transferred Dec 1, 2026, when the short-year statement is mailed Jan 29, 2027, then `REGX_1024_17I4_TRANSFEROR_SHORT_YEAR_60` is satisfied; Feb 1 → breached.
- 17.2-T8 Given a scheduled ACH debit with settlement date Dec 1, then it is cancelled by Nov 25 (T-3 BD) and no debit settles on/after T.
- 17.2-T9 Given a `master_change_sub_retained` batch, then no goodbye run exists and the exclusion record is present.
- 17.2-T10 Given the transfer is cancelled Nov 20 after mailing, then a corrective notice is mailed by Nov 27 and the goodbye timer is cancelled with reason `transfer_cancelled`.

#### Audit and evidence
Rendered notices (hashes), checklist results, transferee data-block verification, proofs of mailing, return-mail/skip-trace records, `officer` release approvals, `misdirected_payments` with receipt dates, forwarding files and transferee acknowledgments, autodraft cancellation logs, short-year statements, timer histories and `agent_decisions` — the RESPA §6(f) defense file for the transferor period.

### Open questions / decisions
1. `respa_effective_date` conservative override when the 1st is not a business day (default: on) — harmonize with 1.3 (which uses `transfer_date`).
2. Forward vs return as the default disposition for misdirected payments — default forward; return only when forwarding is impossible.
3. Support-window length for the toll-free number and forwarding — default 90 days (contract), then referral only.
4. Whether to e-deliver a courtesy copy of the goodbye notice to consented borrowers — default yes, mail remains the compliance copy.

### Sources
- Reg X §1024.33 (eCFR current as of Sept 3, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.33 ; official interpretations 33(b)(3)-1, 33(c)(1)-1/-2: https://www.consumerfinance.gov/rules-policy/regulations/1024/interp-33/ (verified 2026-09-09)
- Reg X §1024.17(i)(4)(ii), (e) (eCFR current as of Sept 8, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-B/section-1024.17 (verified 2026-09-09)
- Reg Z §1026.39 (eCFR current as of Sept 8, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-E/section-1026.39 (verified 2026-09-09)
- 12 U.S.C. 2605(b)–(d), (i): https://www.law.cornell.edu/uscode/text/12/2605
- Appendix MS-2: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Appendix%20MS-2%20to%20Part%201024
- Servicing Guide A2-7-03 (05/13/2026) and F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/a2-7-03/post-delivery-servicing-transfers ; https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers (verified 2026-09-09)
- sections/01 §1.3 (templates, misdirected-payment rules); sections/07 §7.1 (final statement); sections/02 (`payment_holds`).
