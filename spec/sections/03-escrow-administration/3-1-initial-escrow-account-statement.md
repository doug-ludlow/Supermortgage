# 3.1 — Initial escrow account statement

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | At/after settlement or new escrow |
| Governing source | Reg X 1024.17(g)(1)-(2) |
| Key deadlines | Within 45 calendar days of settlement/establishment |
| Timers | `ESC_BOARDING_EVIDENCE_CHECK_5BD`, `REGX_1024_17E_TRANSFER_INITIAL_STMT_60`, `REGX_1024_17G_INITIAL_STMT_45` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | At/after settlement or new escrow |
| Governing source (blueprint) | Reg X 1024.17(g)(1)-(2) |
| Key deadlines (blueprint) | Within 45 calendar days of settlement/establishment |
| Data/artifacts | Initial escrow statement; retain 5 yrs |
| Systems | Print/mail |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub performs; SoR liable |
| Nuances (blueprint) | [cropped in source] — reconstructed below (transfer-in 60-day variant; post-settlement establishment; format/payee rules) |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.17(g)–(h)** (eCFR current as of Sept. 4, 2026):
- (g)(1): after the pre-establishment analysis required by (c)(2), "the servicer shall submit an initial escrow account statement to the borrower at settlement or within 45 calendar days of settlement for escrow accounts that are established as a condition of the loan."
- (g)(1)(i) content: the amount of the borrower's monthly mortgage payment and the portion going to escrow; an itemization of "the estimated taxes, insurance premiums, and other charges that the servicer reasonably anticipates to be paid from the escrow account during the escrow account computation year and the anticipated disbursement dates of those charges"; "the amount that the servicer selects as a cushion"; and a trial running balance.
- (g)(1)(ii)/(h)(2): the statement may be incorporated into the HUD-1/HUD-1A or delivered as a separate document. For TRID loans the Closing Disclosure is not a HUD-1; the initial statement is a separate document (the CD's "Initial Escrow Payment at Closing" line does not satisfy (g)). **[Interpretation — no CFPB FAQ located; treat CD as non-substitute.]**
- (g)(2): "For escrow accounts established after settlement (and which are not a condition of the loan), a servicer shall submit an initial escrow account statement to a borrower within 45 calendar days of the date of establishment of the escrow account."
- (h)(1)/(h)(3): format per the Public Guidance Documents "Initial Escrow Account Disclosure Statement—Format/—Example" (CFPB maintains HUD's June-2021 compilation; the model layout itself was not retrievable today — **[PARTIALLY VERIFIED: format content taken from the regulation's content list, not the PGD page images]**); the statement need not identify the payee by name if it identifies the use ("county taxes," "hazard insurance," "condominium dues"), must show each payment and date for payees paid more than once a year, and must separately identify each taxing authority/insurer ("City Taxes," "School Taxes," "Hazard Insurance," "Flood Insurance").
- (e)(1) transfer variant: "If the new servicer changes either the monthly payment amount or the accounting method used by the transferor (old) servicer, then the new servicer shall provide the borrower with an initial escrow account statement within 60 days of the date of servicing transfer," and (e)(1)(i) the new servicer "shall use the effective date of the transfer of servicing to establish the new escrow account computation year." If payment and method are retained, the transferee may keep the old computation year or reset it with a short-year statement ((e)(1)(ii)); shortages/surpluses/deficiencies in the transferred account are handled under (f) ((e)(2)).
- (c)(1)(i) deposit limit at settlement: charges "attributable to the period from the date such payment(s) were last paid until the initial payment date" computed so that "the lowest month end target balance projected for the escrow account computation year is zero," plus a cushion "no greater than one-sixth (1/6) of the estimated total annual payments." (c)(2): analysis must be conducted before the account is established and must use disbursement dates on or before the penalty-avoidance deadline in (k).
- (a): "If an escrow account involves biweekly or any other payment period, the requirements in this section shall be modified accordingly."
- Statute: 12 U.S.C. 2609(c)(1) (initial statement within the 45-day period beginning on the establishment date) and 2609(d) (penalties: $50 per failure, $100,000 cap per 12 months, $100 per failure with no cap for intentional disregard) — verified at law.cornell.edu 2026-09-09.

**Fannie Mae**: B-1-01 (09/11/2024) imposes no initial-statement rule beyond "applicable law"; F-1-11 (05/13/2026) requires the transferor to deliver "Escrow analyses" and "A list of tax bills, assessments, property insurance premiums, MIPs, etc. that are due to be paid by the servicer, but that are still unpaid as of the transfer date," and to notify insurers, taxing authorities, HOAs and the "tax or flood service provider." Escrow established for a Flex Modification or Payment Deferral (B-1-01) is an "account established after settlement" → (g)(2) 45-day statement.

**Discrepancies with the blueprint row**: (1) "retain 5 yrs" — the HUD-era 3500.17(l) five-year recordkeeping paragraph does not exist in 1024.17 (verified: paragraphs run (a)–(l), (l) = Discretionary payments); current retention is 1024.38(c)(1) (one year after discharge/transfer) plus Fannie Mae life-of-loan + 4 years (architecture baseline §10) — keep the baseline's `respa_5y` class as a conservative policy, not a legal citation. (2) The row omits the 60-day transfer-in variant in (e)(1) and the (g)(2) post-settlement path. (3) "Print/mail" understates channel: electronic delivery is permitted with valid E-SIGN consent (Section 7.4); (b) "Delivery" means first-class mail or hand delivery, so mail is the default.

### Operational prerequisites
- Boarding file spec (Section 1.1) must carry `settlement_date`, `first_payment_date`, `escrow_established_at`, `initial_escrow_statement_evidence` (document + delivery date), the originator's trial running balance, cushion selected, and per-line disbursement schedule — owner: Supermortgage (spec) / Partner SoR (contractual delivery obligation on originators); lead time: before first boarding.
- Notice Registry template `NTC_REGX_1024_17G_INITIAL_ESCROW_STMT` v1 with the (g)(1)(i) checklist and PGD-conformant layout, reviewed by counsel — owner: Supermortgage; 4 weeks.
- Print/mail vendor and e-delivery adapter live (00b N9); E-SIGN consent capture (Section 7.4) — Supermortgage; 4–12 weeks.
- Tax service and insurance-tracking contracts delivering line data at boarding (00b N16/N6) — Supermortgage; 4–12 weeks.
- T&I custodial account (Form 1014 in CBAM) so deposits can be held — Partner SoR authorizes, Supermortgage establishes (Section 6.2).

### Build spec
#### Inputs and triggers
- `loan.boarded` (Section 1.1) with `escrow_accounts.status='active'` → verify evidence of an origination-delivered initial statement; if absent, trigger `escrow.initial_statement.required` with `reason='settlement'` and anchor = `settlement_date`.
- `escrow.account.established` (post-settlement: waiver revocation 3.8, borrower-requested escrow, workout-established account per B-1-01, transfer-in with changed payment/method) → statement required; anchor = establishment date (or transfer effective date for the 60-day variant).
- `transfer.in.completed` (Section 1) with `payment_changed=true` or `accounting_method_changed=true` → `reason='transfer_in'`, 60-day timer.
- Schedule: none (event-driven). Borrower actions: request for a copy → `case_type='rfi'` (Section 4.2) returns the stored document.

#### Data model
- `escrow_accounts` (baseline; fields fixed here): `id`, `loan_id`, `status` ∈ {active, waived, closed, suspended}, `established_at date`, `establishment_reason` ∈ {origination, waiver_revocation, borrower_request, workout, transfer_in, hpml_required, flood_required}, `computation_year_start date`, `computation_year_end date`, `payment_frequency` ∈ {monthly, biweekly}, `cushion_months numeric(4,2)` (≤ 2.00), `cushion_cap_source` ∈ {regx, instrument, state}, `monthly_escrow_payment_cents bigint`, `shortage_installment_cents bigint`, `shortage_installments_remaining int`, `deficiency_installment_cents bigint`, `deficiency_installments_remaining int`, `custodial_account_id`, `interest_rule_code text null`, `analysis_lead_days int default 45`.
- `escrow_statements` (new): `id`, `loan_id`, `escrow_account_id`, `statement_type` ∈ {initial, annual, short_year_transfer, short_year_payoff, short_year_reset, post_exemption_history}, `analysis_id → escrow_analyses.id`, `notice_id → notices.id`, `required_reason`, `anchor_date date`, `due_at timestamptz`, `timer_id`, `sent_at`, `delivery_channel`, `status`. Retention class `respa_5y` (policy) and `life_of_loan_plus_4y`.
- `escrow_analyses`, `escrow_analysis_lines` — defined in 3.2 (the initial statement is rendered from an `analysis_type='initial'` row).
- `documents`: rendered PDF with SHA-256; `notices`: template version, channel, `esign_consent_id`, `mailed_at`, proof-of-mailing evidence. PII: borrower name/address/loan number only; no SSN on the statement.

#### State machine
`pending_evidence_check` → (`evidence_found`) `satisfied_by_originator` [terminal] | (`no_evidence`) `required` → `analysis_ready` (3.2 engine returns approved `initial` analysis) → `rendered` (template checklist passed) → `sent` (notices row with mailed_at / e-delivery receipt) → `delivered` [terminal] | `returned_undeliverable` → `re_addressed` → `sent`. `cancelled` (loan paid off / escrow waived before rendering, reason logged). Transitions are executed by the `escrow` agent; `returned_undeliverable` is set by the print/mail return feed; no human role is required.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_17G_INITIAL_STMT_45` | deadline | `escrow.initial_statement.required` (reason settlement or post-settlement) | `settlement_date` or `escrow_accounts.established_at` | 45 calendar_days, 23:59 loan-property TZ | `escrow.statement.sent` (statement_type=initial) | compliance-sentinel escalation sev-2 to `escrow` agent lead; auto-send cure; logged as RESPA §10(d) exposure |
| `REGX_1024_17E_TRANSFER_INITIAL_STMT_60` | deadline | `transfer.in.completed` with payment/method change | transfer effective date | 60 calendar_days | `escrow.statement.sent` (initial) | same as above, sev-2 |
| `ESC_BOARDING_EVIDENCE_CHECK_5BD` | deadline (internal) | `loan.boarded` | boarded_at | 5 business_days_servicer | `escrow.initial_statement.evidence_verified` or `.required` | sev-3 to `boarding` agent |
| Jurisdiction overrides | — | none found for the initial statement; Utah 7-17-4 requires written notice at closing of the borrower's election right (origination-side) — captured in `jurisdiction_rules.escrow_waiver.ut_election_notice` for 3.8 | | | | |

#### Business rules and calculations
1. **Evidence rule**: an origination-delivered statement satisfies (g)(1) only if the boarding file contains the document and a delivery date ≤ settlement_date + 45 days. Otherwise Supermortgage delivers its own statement; if the 45-day window has already lapsed at boarding, deliver immediately, mark the timer `breached` with `waiver_reason='inherited_from_originator'`, and open a `qc_finding` case against the originator (partner recourse).
2. **Computation year**: `computation_year_start = first_payment_date` (1024.17(b): the computation year begins with the initial payment date); for post-settlement establishment, the first escrow payment due date; for a transfer-in with changed payment/method, the transfer effective date ((e)(1)(i)).
3. **Settlement deposit ceiling** (used to validate the originator's collection and for post-settlement establishment): `S_max = amount that brings the lowest projected month-end balance to zero + cushion`, cushion = `floor_cents(annual_disbursements × cushion_months / 12)` with `cushion_months ≤ 2` (1/6 of annual) and further capped by the security instrument or state law (3.4). Worked example (Appendix E numbers): school tax $360 (Sep), county tax $500 (Jul) + $700 (Dec); annual $1,560; monthly 1/12 = $130.00; lowest running balance with a $0 start = −$780 (Dec); starting balance required = $780; cushion 1/6 = $260; settlement deposit ceiling = **$1,040.00** (settlement May 15, first payment July 1). Single-item analysis would have allowed $800 + $330 = $1,130 — aggregate analysis is mandatory ((c)(4)), so $1,040 is the ceiling.
4. **Content assembly** (checklist tied to (g)(1)(i)): total monthly payment (P&I + escrow + any shortage installment), escrow portion, itemized lines with anticipated disbursement dates and amounts (each taxing authority/insurer separately), cushion selected, trial running balance table (month, payments to escrow, payments from escrow, description, balance), computation-year dates, and the servicer contact block. Biweekly loans: the trial balance is computed per payment period (26 periods) and "modified accordingly" ((a)); the statement shows per-period escrow amounts.
5. **Rounding**: base escrow payment = `round_half_up_cents(annual_disbursements / 12)`; cushion = `floor_cents(annual × 1/6)` so it can never exceed the statutory limit; running balances are exact cent sums.
6. **Channel**: electronic only if `consents` has an unrevoked `esign` consent covering class `escrow_statements`; else first-class mail to the last known address (1024.17(b) "Delivery").

#### Integrations
- **Print/mail vendor** (00b N9): document event {template `NTC_REGX_1024_17G_INITIAL_ESCROW_STMT`, payload JSON, channel, return-mail handling}; SFTP/API per contract [vendor-specific]; vendor mail-piece ID and mailing date stored on `notices`; failure → retry 3× then `escalations` sev-3; the timer is only satisfied on vendor acceptance evidence.
- **E-delivery adapter**: sends notification + portal link; delivery evidence = portal view receipt or email acceptance; bounce → fall back to mail within 2 business days.
- **Boarding intake** (Section 1.1): reads `initial_escrow_statement_evidence`.
- **Fannie Mae**: no submission for statements; the account balance at establishment is reported as an **Escrow Setup** event (see 3.7 Integrations) before any deposit/disbursement event.

#### Outputs and artifacts
- Notice `NTC_REGX_1024_17G_INITIAL_ESCROW_STMT` (12 CFR 1024.17(g)–(h)); required-content checklist: monthly payment; escrow portion; itemized estimated charges with anticipated disbursement dates; cushion amount; trial running balance; computation year; payee-use identification; "keep this statement" language from the PGD. Channel rule: E-SIGN electronic or first-class mail.
- `documents` row (PDF + SHA-256); `escrow_statements` row; `loan_events`: `escrow.initial_statement.required`, `escrow.statement.rendered`, `escrow.statement.sent`, `escrow.statement.returned`.
- Ledger: none (no money moves); `investor_events`: Escrow Setup event when the account is established (3.7).

#### AI agent design (AI-first)
- Agent: `escrow`. End-to-end: verify evidence → call `runEscrowAnalysis(type='initial')` → review anomalies (missing line data, projected payment > 150% of originator's escrow payment, negative starting balance) → `renderStatement` → `sendNotice`. Tools: `readBoardingFile`, `runEscrowAnalysis`, `approveAnalysis`, `renderStatement`, `sendNotice`, `openCase`, `escalate`, `emitEscrowEvent`.
- Decision record (`agent_decisions`): {loan_id, analysis_id, evidence_found, computation_year_start, lines_used[], anomalies[], action, rule_set='regx.escrow.2013', model_version, rationale, confidence}.
- Guardrails: the agent cannot edit engine outputs; overrides only via `escrow_line` corrections with a documented source (bill, policy declarations). Escalations: none legally required; `human_agent` warm transfer on borrower request; `qc_finding` case to `qc-audit` when the originator failed (g)(1). Disclosure/consent: statements are not solicitations; no TCPA implication; e-delivery requires E-SIGN consent (7.4).
- Human path when AI is off: the same commands are exposed in `ops-console` with the checklist enforced.

#### Edge cases and failure modes
- Boarded > 45 days after settlement with no evidence: send immediately; inherited breach logged.
- Escrow established at modification trial start (B-1-01) while the borrower is > 30 days delinquent: (g)(2) still applies (no delinquency exemption for the initial statement — the (i)(2) exemption is for annual statements only).
- Transfer-in mid-computation-year with unchanged payment and method: no initial statement; continue the transferor's computation year (`escrow_accounts.computation_year_*` carried over) or reset via short-year (3.3).
- Biweekly loans: compute on 26 periods; the cushion limit is still 1/6 of annual disbursements.
- Borrower in bankruptcy at establishment: still send (no (g) exemption); route through bankruptcy counsel/trustee rules in Section 14.3 if the automatic stay restricts direct contact (send "informational" legend).
- Successor in interest confirmed (Section 4.4): send to the confirmed successor at the property address.
- Vendor outage: queue and retry; if the 45th day is within 2 business days, switch channel (in-house print + first-class mail).
- Returned mail: skip-trace per Section 4 procedures; re-send; timer already satisfied by the original mailing (delivery = mailing).
- Retro-correction: a material error in the projection → new `interim` analysis and a corrected initial statement (superseding), both retained.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.1-T1 | Given a loan boarded 10 days after settlement with originator statement evidence dated at settlement, when boarding completes, then status = `satisfied_by_originator` and no timer instance is created. |
| 3.1-T2 | Given no evidence and settlement 2026-09-01, when boarded 2026-09-15, then timer due 2026-10-16 23:59 (property TZ) and a statement is sent by then; `loan_events` has `escrow.statement.sent`. |
| 3.1-T3 | Given the Appendix E lines (Sep $360; Jul $500; Dec $700; first payment Jul 1), when the initial analysis runs with cushion 2 months, then base payment = $130.00, cushion = $260.00, starting balance ceiling = $1,040.00, December projected balance = $260.00. |
| 3.1-T4 | Given settlement 2026-08-10 and boarding 2026-10-01 with no evidence, when boarded, then the statement is sent within 1 business day and the timer is recorded `breached` with `waiver_reason='inherited_from_originator'` and a `qc_finding` case exists. |
| 3.1-T5 | Given a transfer-in effective 2026-11-01 where the new escrow payment differs by $0.01, when transfer completes, then `REGX_1024_17E_TRANSFER_INITIAL_STMT_60` is due 2026-12-31 and `computation_year_start` = 2026-11-01. |
| 3.1-T6 | Given a waiver revocation on 2026-10-05 (3.8), when the account is established, then `REGX_1024_17G_INITIAL_STMT_45` due 2026-11-19 and an Escrow Setup investor event is queued before any deposit event. |
| 3.1-T7 | Given valid E-SIGN consent for class `escrow_statements`, when sent, then channel = electronic with receipt evidence; given consent revoked the day before, then channel = mail. |
| 3.1-T8 | Given a biweekly loan, when analyzed, then the trial balance has 26 rows and the per-period escrow amount × 26 = annual disbursements ± $0.26. |
| 3.1-T9 | Given the print vendor rejects the file, when retried 3× and still failing 2 days before due, then an in-house mail fallback is used and an escalation sev-3 is logged. |

#### Audit and evidence
`loan_events` chain (required → rendered → sent), `notices` with template version + checklist result + mail-piece ID/e-delivery receipt, `documents` hash, `timers` history (started/due/satisfied/breached with evidence document id), `agent_decisions` record, boarding evidence document, and the `escrow_analyses` snapshot used. Exportable for MORA, state exams and RESPA §10(d)/§6(f) defense.

### Open questions / decisions
1. Should Supermortgage always issue its own initial statement at boarding even when originator evidence exists (belt-and-braces)? **Default: no** — rely on evidence; issue only when absent or when the projection differs materially (> $5/month) from the originator's, in which case issue a short-year reset (3.3) rather than a second "initial."
2. Treat the TRID Closing Disclosure as a substitute for the initial statement? **Default: no.**
3. Retention class for statements: **Default: `respa_5y` policy + `life_of_loan_plus_4y`** (legal minimum is 1024.38(c)(1)).

### Sources
- 12 CFR 1024.17 (eCFR, current as of 2026-09-04): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-B/section-1024.17
- 12 CFR 1024.38 (eCFR, current as of 2026-09-08): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.38
- Appendix E to Part 1024: https://www.ecfr.gov/current/title-12/chapter-X/part-1024/appendix-Appendix%20E%20to%20Part%201024
- 12 U.S.C. 2609: https://www.law.cornell.edu/uscode/text/12/2609
- CFPB Escrow Disclosure Public Guidance Documents (June 2021): https://files.consumerfinance.gov/f/documents/cfpb_escrow-disclosure_public-guidance-documents_2021-06.pdf
- CFPB Mortgage Servicing FAQs (escrow, updated 2021–2023): https://www.consumerfinance.gov/compliance/compliance-resources/mortgage-resources/mortserv/mortgage-servicing-faqs/
- Fannie Mae Servicing Guide B-1-01 (09/11/2024; Guide ed. Aug 12, 2026): https://servicing-guide.fanniemae.com/svc/b-1-01/administering-escrow-account-and-paying-expenses
- Fannie Mae Servicing Guide F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
