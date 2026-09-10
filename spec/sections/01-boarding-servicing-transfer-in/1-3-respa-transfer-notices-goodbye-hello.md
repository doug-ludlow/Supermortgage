# 1.3 — RESPA transfer notices (goodbye/hello)

| Attribute | Value |
|---|---|
| Section | 1 — Boarding / Servicing Transfer-In |
| Automation class | a |
| Trigger & frequency | On each servicing transfer |
| Governing source | Reg X 1024.33(b) |
| Key deadlines | Transferor ≥15 days before effective date; transferee ≤15 days after; combined notice ≥15 days before; 60-day late-fee grace (RESPA §6(d)) |
| Timers | `FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5`, `REGX_1024_33B3_COMBINED_15`, `REGX_1024_33B3_EXCEPTION_30`, `REGX_1024_33B3_GOODBYE_15`, `REGX_1024_33B3_HELLO_15`, `REGX_1024_33C1_LATE_FEE_PROTECTION_60`, `SM_1024_33C2_FORWARD_PROMPT_1`, `SM_TOLLFREE_LIVE_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Boarding |
| Trigger & frequency | On each servicing transfer |
| Governing source (blueprint) | Reg X 1024.33(b) |
| Key deadlines (blueprint) | Transferor ≥15 days before effective date; transferee ≤15 days after; combined notice ≥15 days before; 60-day late-fee grace (RESPA §6(d)) |
| Data/artifacts | Notice of Transfer (Appendix MS-2); retain ~5 yrs |
| Systems | Print/mail [cropped in source] |
| Automation class (blueprint) | [cropped in source] — treated as (a) |
| SoR / Sub | [cropped in source] — transferor sends goodbye (partner or prior subservicer); Supermortgage sends hello |
| Nuances (blueprint) | [cropped in source] — reconstructed: exclusions for master-servicer-only changes, 30-day exception, "effective date of transfer" definition, address rule, skip-trace on return, misdirected-payment forwarding |

### Verified requirement (as of 2026-09-09)

**§1024.33(b)(1)** (eCFR current as of Sept. 3, 2026): each transferor and transferee servicer "shall provide to the borrower a notice of transfer" for "any assignment, sale, or transfer of the servicing of the mortgage loan." **(b)(2)** excludes, "if there is no change in the payee, address to which payment must be delivered, account number, or amount of payment due": (A) transfers between affiliates; (B) transfers resulting "from mergers or acquisitions of servicers or subservicers"; (C) transfers "between master servicers without changing the subservicer"; and (ii) FHA assignments. A change of subservicer that changes the payee or payment address is therefore **not** excluded — every Supermortgage transfer-in requires notices unless payee, address, account number and payment amount all stay identical. **(b)(3)(i)**: transferor notice "not less than 15 days before the effective date of the transfer"; transferee notice "not more than 15 days after the effective date"; a single combined notice satisfies both if provided "not less than 15 days before the effective date." **(b)(3)(ii)**: notice may be given "not more than 30 days after the effective date" when the transfer is preceded by (A) termination of the servicing contract for cause, (B) commencement of bankruptcy proceedings of the servicer, (C) FDIC receivership/conservatorship, or (D) NCUA conservatorship/liquidation. **(b)(3)(iii)**: notices provided at settlement satisfy the timing rule. **(b)(4)** content: (i) the effective date of the transfer; (ii) transferee "name, address, and a collect call or toll-free telephone number" for a contact who can answer inquiries; (iii) the same for the transferor; (iv) "the date on which the transferor servicer will cease accepting payments ... and the date on which the transferee servicer will begin to accept payments" — dates "shall either be the same or consecutive days"; (v) "whether the transfer will affect the terms or the continued availability of mortgage life or disability insurance, or any other type of optional insurance, and any action the borrower must take to maintain such coverage"; (vi) "a statement that the transfer of servicing does not affect any term or condition of the mortgage loan other than terms directly related to the servicing of the loan." Appendix MS-2 is the model form (its use is optional); it includes the sentence "Under Federal law, during the 60-day period following the effective date of the transfer of the loan servicing, a loan payment received by your old servicer on or before its due date may not be treated by the new servicer as late, and a late fee may not be imposed on you." Comment 33(b)(3)-1: the notice goes to the borrower's address in the mortgage documents unless the borrower has provided a new address per the servicer's requirements.

**"Effective date of transfer"** is defined by 12 U.S.C. 2605(i)(1) (incorporated by §1024.2(b)): "the date on which the mortgage payment of a borrower is first due to the transferee servicer." Because Fannie Mae requires the transfer date to be the first business day of the month (A2-7-03) and Supermortgage will accept payments from that day, `respa_effective_date` normally equals `transfer_date`; where they differ (mid-month cutover would not be Fannie-approved), the RESPA clock runs from the first payment due to Supermortgage and the §1024.41(k) clock from the day Supermortgage begins accepting payments.

**§1024.33(c)(1)**: "during the 60-day period beginning on the effective date of transfer," a payment received by the transferor "on or before the applicable due date (including any grace period allowed under the mortgage loan instruments)" may not be treated as late "for any purpose" and no late fee may be imposed (comment 33(c)(1)-1). The statute (12 U.S.C. 2605(d)) says "before the due date"; Reg X's "on or before ... including any grace period" is broader and governs the build. Comment 33(c)(1)-2: a transferee's compliance with §1024.39 during the 60 days is not treating a payment as late. **(c)(2)**: a transferor that receives a payment on or before the due date during the 60 days must either "transfer the payment to the transferee servicer for application" or "return the payment to the person that made the payment and notify such person of the proper recipient." **(d)**: compliance preempts state notice laws (state notices to insurers/taxing authorities may still be required).

**A2-7-03**: notices "must be made in accordance with applicable law, including the provisions of the RESPA"; "if the servicer determines that the RESPA notification of transfer letter is returned, the servicer must initiate skip trace activities to obtain an alternate mailing address."

**§1024.30(d)**: a confirmed successor in interest is a "borrower" for Subpart C purposes, so confirmed successors receive the notices.

**Discrepancies vs blueprint**: (1) the "~5 yrs" retention is policy — Reg X §1024.38(c)(1) requires one year post-transfer; the baseline's `respa_5y` class is adopted as conservative; (2) blueprint omits the 30-day exception and the (b)(2) exclusions, which matter for master-servicer-only changes (no notice) versus subservicer changes (notice); (3) the 60-day rule is "on or before the due date including grace," not "60-day late-fee grace" — it protects misdirected payments only.

### Operational prerequisites
- Print/mail vendor contract with proof-of-mailing (USPS IMb tracking or vendor mail-piece IDs) and return-mail imaging — Supermortgage (research/00b N9); 4–8 weeks.
- Toll-free/collect-call number staffed (AI voice with disclosure + human fallback) before the goodbye notice is mailed — Supermortgage; must be live at T-15 at the latest.
- Agreement with the transferor on notice mode (separate vs combined), letterhead, signatory, and the date the transferor stops accepting payments (= T-1) — Partner/transferor + Supermortgage; before T-20.
- Borrower address file including successors in interest and Address Confidentiality Program flags from the preliminary tape (1.1).
- State-law overlays in `jurisdiction_rules` (none override RESPA timing; some states require servicer-license numbers or specific disclosures on correspondence — configurable letter footers).

### Build spec
#### Inputs and triggers
- `transfer.batch.approved` and `transfer.loan_list.finalized` (1.2) → notice run planning.
- `transfer.tape.received{kind=preliminary}` with borrower/mailing data (1.1).
- `transfer.batch.cutover_completed` → hello notice run.
- `mail.returned` from the print-mail adapter → skip-trace.
- Transferor `misdirected_payments` file (daily during the 60-day window) → `payment.received{received_by='transferor'}`.
- Borrower inbound contact during the window → `borrower-comms`.

#### Data model
- `notice_templates` rows: `NTC_REGX_1024_33B_GOODBYE_MS2`, `NTC_REGX_1024_33B_HELLO_MS2`, `NTC_REGX_1024_33B_COMBINED_MS2` (citation §1024.33(b)(4); Appendix MS-2), each with `required_content_checklist` = [(b)(4)(i)…(vi), 60-day statement, transferor stop date, transferee start date and remittance address, both contacts, optional-insurance paragraph flag].
- `notices` (baseline): `loan_id`, `template_version`, `party_id` (each borrower / confirmed successor), `channel='mail'`, `mailed_at`, `proof_of_mailing_document_id`, `returned_at`, `remailed_notice_id`.
- `transfer_notice_runs`: `batch_id`, `kind` enum {goodbye, hello, combined, corrective}, `due_at`, `render_count`, `qc_pass_count`, `mailed_count`, `status`.
- `misdirected_payments`: `loan_id`, `transferor_received_at date`, `amount_cents bigint`, `forwarded_at`, `received_by_transferee_at`, `payment_id` (→ `payments`), `protected boolean` (computed), `disposition` enum {forwarded, returned_to_payor}.
- `loans.respa_effective_date`, `loans.transfer_window_end_date` (= effective date + 59 days).
- Retention: `notices` and proofs `respa_5y`; `misdirected_payments` `life_of_loan_plus_4y`.

#### State machine
Notice run: `planned` → `rendered` (all loans on frozen list) → `qc_passed` (checklist and address validation; ACP addresses substituted) → `released_to_vendor` → `mailed` (proof received) → `complete`; per-notice branches `returned` → `skip_trace` → `remailed` or `undeliverable_documented`. A `corrective` run is created if the transfer is cancelled or the date moves after mailing. Only the `transfer` agent transitions; release to vendor for the goodbye run requires the transferor's written authorization on file (partner or prior subservicer).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_33B3_GOODBYE_15` | deadline | `transfer.batch.approved` (transferor duty; monitored/performed on transferor's behalf) | `respa_effective_date` | −15 calendar_days | `notice.mailed{template=NTC_REGX_1024_33B_GOODBYE_MS2 or COMBINED}` for every loan | sev 1 → `officer` (partner); if missed, transfer date slips or 30-day exception must apply |
| `REGX_1024_33B3_HELLO_15` | deadline | `transfer.batch.cutover_completed` | `respa_effective_date` | +15 calendar_days | `notice.mailed{template=NTC_REGX_1024_33B_HELLO_MS2 or COMBINED}` | sev 1 → `officer`; Compliance Sentinel daily report |
| `REGX_1024_33B3_COMBINED_15` | deadline | `transfer.batch.approved{notice_mode=combined}` | `respa_effective_date` | −15 calendar_days | `notice.mailed{template=NTC_REGX_1024_33B_COMBINED_MS2}` | sev 1; fallback: separate hello run within +15 |
| `REGX_1024_33B3_EXCEPTION_30` | deadline | `transfer.batch.approved{exception_basis∈{termination_for_cause, bankruptcy, fdic, ncua}}` | `respa_effective_date` | +30 calendar_days | notice mailed | sev 1 |
| `REGX_1024_33C1_LATE_FEE_PROTECTION_60` | not_before_gate (window) | `transfer.batch.cutover_completed` | `respa_effective_date` | window days 1–60 (calendar) | expires day 61 | `assessLateCharge` and `reportDelinquency` commands must check `misdirected_payments.protected` |
| `SM_1024_33C2_FORWARD_PROMPT_1` | deadline | `payment.received{received_by='transferor'}` | `transferor_received_at` | +1 business_days_servicer (internal "promptly") | `payment.posted` | sev 2 → `cashiering`; transferor SLA breach logged |
| `FNMA_A2_7_03_RETURNED_NOTICE_SKIP_TRACE_5` | deadline | `mail.returned{template∈RESPA}` | returned_at | +5 business_days_servicer (Guide says "must initiate"; no day count) | `skiptrace.completed` and `notice.remailed` or documented | sev 3 |
| `SM_TOLLFREE_LIVE_GATE` | not_before_gate | `transfer_notice_run.planned` | — | toll-free number and IVR/AI disclosure verified live | `contact_center.ready` | goodbye run cannot be released |

Jurisdiction overrides: none on timing (§1024.33(d) preemption); footer/disclosure variants by state via `jurisdiction_rules.correspondence_footer`.

#### Business rules and calculations
- Date arithmetic is calendar-day: `goodbye_due = respa_effective_date − 15 days` (mail on or before); `hello_due = respa_effective_date + 15 days`; `window_end = respa_effective_date + 59 days` (day 1 = effective date). Worked example: effective date Thu Oct. 1, 2026 → goodbye by Wed Sept. 16, 2026; hello by Fri Oct. 16, 2026; protection window Oct. 1–Nov. 29, 2026. Example 2: effective date Mon Nov. 2, 2026 (Nov. 1 is a Sunday) → goodbye by Sun Oct. 18, 2026 — the run is scheduled for Fri Oct. 16 because the vendor's last collection is Friday; hello by Tue Nov. 17, 2026; window ends Dec. 31, 2026.
- Transferor stop / transferee start dates on the notice: `transfer_date − 1` and `transfer_date` (consecutive, satisfying (b)(4)(iv)).
- Protected-payment rule: `protected = transferor_received_at ≤ due_date + grace_days` (loan_terms; typically 15) AND `transferor_received_at ∈ [respa_effective_date, window_end]`. A protected payment is posted with `effective_date = transferor_received_at`; no late charge; delinquency counters and credit reporting treat it as received on that date; the payment application order is unchanged (2.1). Worked example: due Oct. 1, grace 15 → last protected receipt date Oct. 16; borrower's check received by transferor Oct. 14, forwarded, received by Supermortgage Oct. 20 → posted as of Oct. 14, no late fee; a check received by the transferor Oct. 20 → not protected (late charge per 2.7 unless waived).
- After day 60, misdirected payments are posted as of Supermortgage receipt; a one-time courtesy waiver is allowed by policy (decision 3).
- Notice recipients: each borrower on `loan_borrowers` at their own address; confirmed successors in interest; ACP participants at the ACP substitute address; attorneys of record for borrowers in bankruptcy receive a copy per 14.x policy.
- Required-content check is machine-executed before release: any missing element blocks the run.

#### Integrations
- **`print-mail`** (SFTP data file + API; vendor-specific **[UNVERIFIED specs]**): outbound notice batches with template ID, payload, ACP flags; inbound proof-of-mailing and return-mail feeds; idempotency by `notice_id`; failed batches re-sent; if the vendor is down at T-16, the fallback is in-house print with USPS Certificate of Mailing (PS Form 3665) captured as `documents`.
- **Transferor** (SFTP): daily `misdirected_payments.csv` (loan, received date, amount, check image ref) plus the wire; PGP; acked; mismatch → 6.5 unidentified-funds workflow.
- **`telephony/voice`**: the toll-free number on the notice routes to the `borrower-comms` agent with automation disclosure and warm transfer to `human_agent`.
- No Fannie Mae interface.

#### Outputs and artifacts
- Notices `NTC_REGX_1024_33B_GOODBYE_MS2` (transferor letterhead, signed by transferor's authorized signer), `NTC_REGX_1024_33B_HELLO_MS2` (Supermortgage letterhead; identifies the partner as master servicer where the partner brand is used — decision 1), `NTC_REGX_1024_33B_COMBINED_MS2` (both signatures). Channel: mail always (no reliance on inherited E-SIGN consent); an additional electronic copy may be sent to borrowers who later consent (7.4).
- `notices` records with proof of mailing; `documents` (rendered PDF hash); `loan_events` `notice.transfer.goodbye.sent`, `notice.transfer.hello.sent`, `payment.misdirected.received`; no ledger postings beyond the forwarded payment itself (2.1); no investor events.

#### AI agent design (AI-first)
`transfer` agent (tools: `planNoticeRun`, `renderNotice`, `runContentChecklist`, `validateAddress`, `releaseToVendor`, `ingestMailReturns`, `orderSkipTrace`, `writeDecision`) prepares and releases both runs end-to-end, monitors proofs, and drives skip-trace. `cashiering` agent applies the protected-payment rule to forwarded payments. `borrower-comms` agent handles "who do I pay?" calls with the disclosure script ("This is Supermortgage's automated assistant…"), verifies identity, reads the loan's `transfer_date`, remittance address and protection window, and offers a human on request. Decision record: `{run_id, loans, checklist_results, release_decision, rationale}`. Escalations: `officer` (partner) for goodbye-run authorization and any corrective notice; `human_agent` on request; no `attorney`/`signing_officer` role. TCPA: no outbound calls or texts are generated by 1.3; state AI-disclosure requirements apply to inbound handling. Human path: ops-console shows the same run with manual release.

#### Edge cases and failure modes
- Transfer cancelled after goodbye notices: corrective notice run within 5 business days telling borrowers to continue paying the transferor (policy; no regulatory timer).
- Transfer date moved: new goodbye notice ≥15 days before the new date; hello timer re-anchored.
- Master-servicer-only change with Supermortgage remaining subservicer: (b)(2)(i)(C) exclusion — no notices; verify no payee/address/account/amount change before suppressing (`officer` sign-off).
- Borrower in bankruptcy: notice goes to the borrower and, where counsel is known, counsel; content unchanged (informational, not collection).
- Deceased borrower / potential successor: notice to the estate/known successor; 4.4 case.
- Returned mail: skip trace; if a new address is found, re-mail; the original mailing to the address of record still satisfies §1024.33 (comment 33(b)(3)-1).
- Transferor refuses to forward payments and returns them to payors instead ((c)(2)(B)): borrower confusion handled by `borrower-comms`; protection still applies if the original receipt was timely — the platform accepts the borrower's proof (check image/bank record) as evidence.
- Payment received by transferor on day 61+: no protection; courtesy waiver by policy.
- Loans boarded with W-002/W-003: no electronic notice; mail only (already the rule).

#### Test cases and acceptance criteria
- 1.3-T1 Given effective date Oct. 1, 2026 and combined mode, when the run is mailed Sept. 16, 2026, then `REGX_1024_33B3_COMBINED_15` is satisfied; mailed Sept. 17 → breached.
- 1.3-T2 Given separate mode and cutover Oct. 1, 2026, when hello notices are mailed Oct. 16, 2026, then `REGX_1024_33B3_HELLO_15` is satisfied; Oct. 17 → breached with `officer` escalation.
- 1.3-T3 Given effective date Nov. 2, 2026, then goodbye due Oct. 18 (Sunday) and the run is scheduled Oct. 16.
- 1.3-T4 Given a rendered notice missing the transferor's toll-free number, then the run cannot be released.
- 1.3-T5 Given a payment due Oct. 1 with 15-day grace received by the transferor Oct. 14 and by Supermortgage Oct. 20, then it posts as of Oct. 14 with no late charge and no delinquency day count.
- 1.3-T6 Given the same payment received by the transferor Oct. 20, then `protected=false` and 2.7 late-charge rules apply.
- 1.3-T7 Given a payment received by the transferor Nov. 30, 2026 (day 61), then `protected=false`.
- 1.3-T8 Given a returned hello notice, then a skip-trace order exists within 5 servicer business days and the original proof of mailing remains linked.
- 1.3-T9 Given an ACP-enrolled borrower, then the notice is addressed to the ACP substitute address only.
- 1.3-T10 Given a master-servicer-only change with identical payee/address/account/amount, then no notices are generated and an `officer` approval record documents the exclusion.

#### Audit and evidence
Rendered notice PDFs (hash), template version and checklist results, proof of mailing per notice, return-mail and skip-trace records, transferor authorization for goodbye run, `misdirected_payments` with evidence of transferor receipt dates, timer history (goodbye/hello/window), and `agent_decisions` — the litigation file for §1024.33 and RESPA §6(f) claims.

### Open questions / decisions
1. Hello-notice branding: Supermortgage name as transferee servicer (default; it is the payee) with a line "servicing on behalf of [Partner], master servicer" vs partner-branded "serviced by" — legal/marketing decision.
2. Goodbye notice execution: Supermortgage renders and mails on the transferor's behalf (default for partner-as-transferor; requires written authorization) vs transferor self-serves with Supermortgage monitoring.
3. Courtesy waiver of late charges for misdirected payments after day 60: default yes, one occurrence per loan, logged as `fee.waived{reason=post_transfer_courtesy}`.
4. Whether to include the optional-insurance paragraph by default: default include with "no change" language when no optional products exist — conservative satisfaction of (b)(4)(v).

### Sources
- Reg X §1024.33 (eCFR current as of Sept. 3, 2026): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.33
- Appendix MS-2 model form: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Appendix%20MS-2%20to%20Part%201024
- Supplement I comments 33(b)(3)-1, 33(c)(1)-1/-2: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Supplement%20I%20to%20Part%201024
- Reg X §1024.2(b) definitions: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-A/section-1024.2
- 12 U.S.C. 2605(b)–(d), (f), (i): https://www.law.cornell.edu/uscode/text/12/2605
- Servicing Guide A2-7-03 (05/13/2026): https://servicing-guide.fanniemae.com/svc/a2-7-03/post-delivery-servicing-transfers
- CFPB Bulletin 2020-02: https://files.consumerfinance.gov/f/documents/cfpb_policy-guidance_mortgage-servicing-transfers_2020-04.pdf
