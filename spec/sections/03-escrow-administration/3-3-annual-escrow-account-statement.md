# 3.3 — Annual escrow account statement

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | Post-analysis |
| Governing source | Reg X 1024.17(i) |
| Key deadlines | Within 30 days of end of computation year |
| Timers | `REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL`, `REGX_1024_17I2_POST_EXEMPTION_HISTORY_90`, `REGX_1024_17I4_SHORT_YEAR_PAYOFF_60`, `REGX_1024_17I4_SHORT_YEAR_RESET_60`, `REGX_1024_17I4_SHORT_YEAR_TRANSFER_60`, `REGX_1024_17I_ANNUAL_STMT_30`, `STATE_UT_7_17_5_ANNUAL_STMT_60` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | Post-analysis |
| Governing source (blueprint) | Reg X 1024.17(i) |
| Key deadlines (blueprint) | Within 30 days of end of computation year |
| Data/artifacts | Annual escrow statement |
| Systems | Print/mail |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub performs; SoR liable |
| Nuances (blueprint) | [cropped in source] — reconstructed: eight content items; (i)(2) delinquency/foreclosure/bankruptcy exemption and 90-day catch-up; short-year statements (transfer 60 days, payoff 60 days, reset 60 days); (f)(5) shortage notice; lump-sum wording restriction |

### Verified requirement (as of 2026-09-09)

**12 CFR 1024.17(i)** (eCFR current as of Sept. 4, 2026): "a servicer shall submit an annual escrow account statement to the borrower within 30 days of the completion of the escrow account computation year. The servicer shall also submit to the borrower the previous year's projection or initial escrow account statement. The servicer shall conduct an escrow account analysis before submitting an annual escrow account statement."
- (i)(1) contents — an account history for the past computation year and a projection for the next; the servicer "may assume scheduled payments and disbursements will be made for the final 2 months"; at a minimum (items (i)–(iv) "clearly itemized"): (i) current monthly mortgage payment and escrow portion; (ii) past year's monthly payment and escrow portion; (iii) total paid into escrow during the past computation year; (iv) total paid out for taxes, insurance premiums and other charges "as separately identified"; (v) balance at the end of the period; (vi) explanation of how any surplus is being handled; (vii) explanation of how any shortage or deficiency is to be paid; (viii) if applicable, the reason(s) the estimated low monthly balance was not reached, "as indicated by noting differences between the most recent account history and last year's projection." Format per the PGDs "Annual Escrow Account Disclosure Statement—Format/—Example" ((j)).
- (i)(2) exemption: if at the time of the analysis the borrower is "more than 30 days overdue," or the servicer has brought a foreclosure action, or the borrower is in bankruptcy, the servicer is exempt from submitting the annual statement; if the exemption applied but the loan becomes current within the computation year and the borrower requests the statement, the servicer shall provide it; when the servicer stops applying the exemption (loan current/reinstated) it must provide "a history of the account since the last annual statement (which may be longer than 1 year) within 90 days" of that date.
- (i)(3): may be delivered with other material, including the Substitute 1098. (i)(4): short-year statements — a servicer may issue one to change the computation year (to adjust its production schedule or alter the computation year); (i)(4)(i) effect: it "shall end the 'escrow account computation year'" and establish the beginning date of the new one, delivered "within 60 days from the end of the short year"; (i)(4)(ii) transfer: "the transferor (old) servicer shall submit a short year statement to the borrower within 60 days of the effective date of transfer"; (i)(4)(iii) payoff: "within 60 days after receiving the payoff funds."
- (f)(5): "The servicer shall notify the borrower at least once during the escrow account computation year if there is a shortage or deficiency in the escrow account. The notice may be part of the annual escrow account statement or it may be a separate document."
- (b) "Delivery"/"Submission": first-class mail or hand delivery to the last known address (electronic with E-SIGN consent).
- CFPB FAQ (June 2, 2021): where the shortage/deficiency is ≥ one month's payment, the annual statement "may only indicate" the allow/≥12-month options; a voluntary lump-sum invitation may be sent "in the same envelope … or in an entirely separate communication" but not in the statement itself and not worded as a requirement.
- 12 U.S.C. 2609(c)(2) (annual statement "within 30 days after the conclusion of each such 1-year period"; content mirrors (i)(1)) and 2609(d) penalties ($50/failure, $100,000/12-month cap; $100 uncapped for intentional disregard).

**Fannie Mae**: no annual-statement rule beyond applicable law; F-1-11 requires escrow analyses to accompany transferred files (transfer-out short-year statement is the transferor's RESPA duty, see Section 17).

**State overlays (verified today)**: Utah 7-17-5 — annual itemized statement of deposits/disbursements "within 60 days of year-end" (whether "year" means calendar or account year is **[UNVERIFIED]**); Maryland Com. Law 12-109(b)(3) — annual statement of escrow balance (bank-lender scope, see 3.9); Vermont 8 V.S.A. 10404 — annual statement "consistent with" RESPA; Maine 9-B §429 — annual written statement showing interest credited; Illinois 765 ILCS 910/15 — paid-tax notice within 45 business days after each tax payment (handled in 3.7). Where the RESPA annual statement contains the state-required content and meets the state timing, one document satisfies both; otherwise a supplemental state statement is generated.

**Discrepancies with the blueprint row**: the row omits the short-year family (transfer/payoff/reset, 60 days), the (i)(2) exemption and its 90-day catch-up, the "previous year's projection must accompany the statement" rule, and the (f)(5) once-per-year shortage notice.

### Operational prerequisites
- Notice Registry templates: `NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT`, `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR` / `_PAYOFF` / `_RESET` (three registry rows, one per trigger; `_TRANSFEROR` is Section 17's row for the transfer-out short-year statement — same artifact, same code, do not duplicate it), `NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY`, `NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT` (separate insert), state supplements `NTC_STATE_ANNUAL_ESCROW_STMT_UT/MD/VT/ME` — counsel review; 4 weeks; Supermortgage.
- Print/mail + e-delivery adapters (00b N9); E-SIGN consent class `escrow_statements` (7.4).
- 1098 production calendar (Section 7) if statements are to be combined with the Substitute 1098 ((i)(3)).
- Section 14 bankruptcy handling rules (statement legends, counsel/trustee addressing) — before first BK loan boards.

### Build spec
#### Inputs and triggers
- `escrow.analysis.approved` (type annual) → render the annual statement; anchor for the deadline = `computation_year_end`.
- `escrow.analysis.approved` (type interim with `reset_computation_year=true`) → short-year reset statement; anchor = end of the short year.
- `transfer.batch.cutover_completed` (Sections 1 and 17 both declare this spelling; `transfer_out.effective` is a retired alias and `transfer.out.effective` was a local drift — do not emit either) → transferor short-year statement; anchor = transfer effective date.
- `payoff.funds_received` (Section 16.2) → payoff short-year statement; anchor = date funds received.
- `loan.reinstated` / `bankruptcy.case.closed` / `foreclosure.case.cancelled` where an (i)(2) exemption was applied → post-exemption account history; anchor = the date the servicer stops applying the exemption (system: the reinstatement/closure event date).
- Borrower request while exempt but current → `rfi` case (4.2) → provide statement.
- Feature flag `escrow.statements.combine_with_1098` (default off).

#### Data model
- `escrow_statements` (3.1) with `statement_type` ∈ {annual, short_year_transfer, short_year_payoff, short_year_reset, post_exemption_history}, `history_from date`, `history_to date`, `projection_analysis_id`, `prior_projection_document_id` (the previous year's projection attached per (i)), `exemption_applied bool`, `exemption_reason` ∈ {delinquent_30, foreclosure_action, bankruptcy}, `exemption_started_at`, `exemption_ended_at`.
- `escrow_statement_history_lines` (new, rendered from `ledger_entries`): `statement_id`, `period_date`, `projected_deposit_cents`, `actual_deposit_cents`, `projected_disbursement_cents`, `actual_disbursement_cents`, `description`, `projected_balance_cents`, `actual_balance_cents`, `variance_flag`.
- `notices` row per statement; `documents` PDF with hash; retention `respa_5y` (policy) + `life_of_loan_plus_4y`.

#### State machine
`due` (created at analysis approval or at the short-year trigger) → `exempt_hold` (if (i)(2) applies; records reason) | `rendered` → `sent` → `delivered` | `returned_undeliverable` → `re_addressed` → `sent`. From `exempt_hold`: `borrower_requested_while_current` → `rendered`; `exemption_ended` → `history_due` (90-day timer) → `rendered`. Terminal: `delivered`, `cancelled` (loan transferred/paid before due with the short-year variant issued instead). Actors: `escrow` agent; Notice Registry; print/mail return feed.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_17I_ANNUAL_STMT_30` | deadline | `escrow.analysis.approved` (annual) or computation year end (whichever first) | `computation_year_end` | 30 calendar_days | `escrow.statement.sent` (annual) or `escrow.statement.exempt_hold` with a valid (i)(2) reason | sev-2; auto-send cure; RESPA §10(d) exposure log |
| `REGX_1024_17I4_SHORT_YEAR_RESET_60` | deadline | `escrow.analysis.approved` with reset | end of short year | 60 calendar_days | `escrow.statement.sent` (short_year_reset) | sev-2 |
| `REGX_1024_17I4_SHORT_YEAR_TRANSFER_60` | deadline | `transfer.batch.cutover_completed` | transfer effective date | 60 calendar_days | `escrow.statement.sent` (short_year_transfer) | sev-1 (transfer-out obligations are scrutinized in exams) |
| `REGX_1024_17I4_SHORT_YEAR_PAYOFF_60` | deadline | `payoff.funds_received` | funds received date | 60 calendar_days | `escrow.statement.sent` (short_year_payoff) | sev-2 |
| `REGX_1024_17I2_POST_EXEMPTION_HISTORY_90` | deadline | `escrow.statement.exemption_ended` | exemption end date | 90 calendar_days | `escrow.statement.sent` (post_exemption_history) | sev-2 |
| `REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL` | recurring | `escrow.account.established` / prior satisfaction | computation year start | 12 months | any `escrow.statement.sent` whose payload includes a shortage/deficiency explanation, or `NTC_REGX_1024_17F_SHORTAGE` sent | sev-2 |
| `STATE_UT_7_17_5_ANNUAL_STMT_60` | deadline (jurisdiction UT) | year end (config: calendar year) | Dec 31 | 60 calendar_days | `escrow.statement.sent` (annual or state supplement) | sev-3 |
| Jurisdiction overrides | | MD/VT/ME annual statement content flags on the template; IL paid-tax notice in 3.7 | | | | |

#### Business rules and calculations
1. **History assembly**: from `ledger_entries` on the loan's `escrow` account for `[computation_year_start, computation_year_end]`; deposits = escrow portions of applied payments + interest credits + refunds from payees; disbursements grouped by line ("County Taxes," "Hazard Insurance," etc.); actual month-end balances; the previous projection (from the prior analysis's `escrow_analysis_lines`) printed side by side.
2. **Two-month assumption** ((i)(1)): for months after the run date within the computation year, projected = actual for history purposes with an "assumed" legend; if an assumed disbursement later fails to occur, no corrected statement is required unless the difference triggers an interim analysis (3.2 R10).
3. **Low-point explanation** ((i)(1)(viii)): computed automatically — compare `actual_min_balance` with `projected_min_balance`; if the actual low is above the projected low by more than $0.00 (or a disbursement moved/changed), list the causal differences (bill amount changes, timing changes, missed/extra payments) generated from the variance flags.
4. **Surplus/shortage/deficiency language** ((i)(1)(vi)–(vii)): rendered from `escrow_analyses.decision`; when shortage or deficiency ≥ one month, the statement text contains only the allow/spread options; the `NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT` may be included as a separate page/insert in the same envelope, worded as optional (CFPB FAQ).
5. **Exemption test** at `as_of_date` of the analysis: `regx_days_delinquent > 30` OR `cases` has an open `foreclosure` case with `first_legal_filed=true` ("brought an action for foreclosure") OR an open `bankruptcy` case. Policy: apply the exemption only for `delinquent_30` and `foreclosure_action`; for `bankruptcy` still produce the statement and route it per Section 14 (informational legend, counsel/trustee copies) because Chapter 13 payment changes require the analysis anyway (feature flag `escrow.statements.bk_suppress`, default off).
6. **Post-exemption history**: covers `[last statement end, exemption end]`, may exceed 12 months; delivered within 90 days; a fresh annual analysis (3.2 `reinstatement`) accompanies it and resets the computation year with a short-year statement if the year has drifted.
7. **Short-year statements**: transfer — history from computation year start to transfer effective date, no projection (the transferee projects); payoff — history to payoff date, closing balance, refund/credit disposition (3.5 / Section 16), no projection; reset — history to the short-year end plus the new projection (functions as the annual statement for the short year).
8. **Attachments**: the previous year's projection/initial statement is attached (page 2) — required by (i).
9. **Channel**: E-SIGN electronic if consented; else first-class mail; Chapter 7/13 addressing per Section 14; successor-in-interest addressing per 4.4.
10. **Dates**: "days" are calendar days; if the due date falls on a weekend/holiday the statement must still be *sent* by that date (no business-day roll) — the scheduler targets sending ≥ 5 business days early.

Worked example: computation year 2026-07-01…2027-06-30; starting balance $1,040.00; analysis approved 2027-05-18; statement sent 2027-05-22 (timer due 2027-07-30, satisfied early). History: deposits 12 × $130.00 = $1,560.00 (June assumed); disbursements $520.00 (Jul, county — projected $500.00), $360.00 (Sep, school), $760.00 (Dec, county — projected $700.00), $260.00 (Mar, supplemental tax — not projected) = $1,900.00; ending balance $700.00. Actual low balance $180.00 in December vs projected $260.00, so item (viii) prints: "County tax paid 07/2026 was $520.00 vs $500.00 projected; county tax paid 12/2026 was $760.00 vs $700.00 projected; a supplemental tax bill of $260.00 was paid 03/2027 (not projected); low balance $180.00 vs $260.00 projected." Shortage $406.68 explained as "$33.89 per month for 12 months beginning 07/01/2027"; new payment $172.22 (item (i)) vs past year $130.00 escrow portion (item (ii)).

#### Integrations
- Print/mail and e-delivery (as 3.1); optional 1098 co-mailing (Section 7) with a single envelope ID.
- Section 16/17 event feeds for payoff/transfer triggers; Section 14 for bankruptcy addressing.
- Fannie Mae: none (statements are not reported); the escrow contractual payment change flows through escrow events (3.7).

#### Outputs and artifacts
- Notices: `NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT` (1024.17(i); checklist items (i)(1)(i)–(viii) + prior projection attachment + computation-year dates + interest credited (3.9) + state supplements), `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR`/`_PAYOFF`/`_RESET` (1024.17(i)(4); `_TRANSFEROR` is shared with 17.2), `NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY` (1024.17(i)(2)), `NTC_REGX_1024_17F_SHORTAGE` (1024.17(f)(5); used only when the annual statement is exempt/suppressed but a shortage exists), `NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT`.
- `loan_events`: `escrow.statement.due/rendered/sent/exempt_hold/exemption_ended/returned`; `documents`; `escrow_statements`; timer records.

#### AI agent design (AI-first)
- Agent: `escrow`. Renders from approved analysis; runs the checklist validator; chooses channel; applies exemption policy; drafts the (viii) explanation from variance flags (structured, not free text — the LLM may only select from templated causes with the computed numbers); sends. Tools: `renderStatement`, `validateChecklist`, `sendNotice`, `applyExemption(reason, evidence)`, `openCase`, `escalate`.
- Decision record: {statement_id, type, exemption test inputs/outcome, variance causes[], channel, consent id, rationale, versions}.
- Escalations: none legally required; `human_agent` on request; `bankruptcy-ops` (attorney where required) for Chapter 13 payment-change notices derived from the statement; complaints about statements → `case` agent (4.5).
- AI-off path: ops-console batch "Render & send statements" with the same validator.

#### Edge cases and failure modes
- Analysis approved late (after year end): statement still due 30 days after year end; the engine uses actuals instead of the two-month assumption.
- Transfer-out effective mid-year: cancel the annual timer; issue the transfer short-year statement within 60 days; forward the analysis and unpaid-bill list (F-1-11).
- Payoff: payoff short-year statement within 60 days of funds; refund per 1024.34(b) within 20 days (excluding legal public holidays, Saturdays, and Sundays — the rule's own wording, not a "business day" count) (3.5).
- Exemption applied, then borrower becomes current and requests statement → provide (no new timer; log request date and send within 5 business days as policy).
- Foreclosure action dismissed / loan reinstated → exemption ends → 90-day history timer.
- Bankruptcy: statement produced with legend; do not include lump-sum language; Chapter 13 escrow payment change requires 3002.1 notice (14.2); Chapter 7 discharged-not-reaffirmed → informational-only legend.
- Successor in interest / deceased borrower: address to confirmed successor; otherwise the estate per Section 4.4.
- Returned mail: skip-trace; re-send; timer satisfied by first mailing.
- Vendor outage: in-house fallback ≥ 5 business days before due.
- Corrections: a statement with an error is superseded by a corrected statement (new `escrow_statements` row referencing the original); both retained; NoE handling per 4.1 (1024.35(b)(3)/(11)).

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.3-T1 | Given computation year ending 2027-06-30 and analysis approved 2027-05-18, when rendered, then the statement includes items (i)–(viii), the prior projection attachment, and is sent by 2027-07-30. |
| 3.3-T2 | Given the analysis is approved 2027-07-25, when rendered, then history uses actuals for May/June and the timer is still satisfied if sent by 2027-07-30. |
| 3.3-T3 | Given `regx_days_delinquent = 45` at analysis, then status = `exempt_hold` with reason `delinquent_30`, no statement is mailed, `NTC_REGX_1024_17F_SHORTAGE` is sent if a shortage exists, and the (f)(5) timer is satisfied. |
| 3.3-T4 | Given exemption ended 2027-09-10 by reinstatement, then `REGX_1024_17I2_POST_EXEMPTION_HISTORY_90` due 2027-12-09 and the history covers from the last statement. |
| 3.3-T5 | Given shortage ≥ one month, then the statement body contains no lump-sum wording; the insert (if enabled) is a separate document flagged optional. |
| 3.3-T6 | Given transfer-out effective 2027-03-01, then the annual timer is cancelled and `REGX_1024_17I4_SHORT_YEAR_TRANSFER_60` is due 2027-04-30. |
| 3.3-T7 | Given payoff funds received 2027-02-10, then short-year payoff statement due 2027-04-11 and it shows the refund disposition. |
| 3.3-T8 | Given a due date 2027-07-30 (Friday) vs 2027-08-01 (Sunday) scenarios, then no business-day roll is applied; the send target is ≥ 5 BD earlier. |
| 3.3-T9 | Given actual December tax $760 vs projected $700, then item (viii) lists the county-tax variance and the low-balance difference. |
| 3.3-T10 | Given a Utah property, then the calendar-year supplemental statement is sent by March 1 unless the annual statement already covers Jan–Dec. |
| 3.3-T11 | Given an open Chapter 13 case and flag `bk_suppress=off`, then the statement is produced with the BK legend and a 3002.1 package is created when the payment changes. |
| 3.3-T12 | Given the print vendor is down on the send date, then the in-house fallback mails and evidence is stored. |

#### Audit and evidence
`escrow_statements` and `notices` (template version, checklist result, channel, consent id, mail-piece id/e-delivery receipt), `documents` hash, `escrow_statement_history_lines` (reconciling to `ledger_entries`), exemption test inputs, timer history, `agent_decisions`.

### Open questions / decisions
1. Apply the (i)(2) bankruptcy exemption? **Default: do not suppress; send with legend** (supports 3002.1 and reduces complaint risk).
2. Combine with the Substitute 1098? **Default: off** (different production calendars).
3. Include the voluntary lump-sum insert? **Default: on**, as a separate insert, wording reviewed by counsel.

### Sources
- 12 CFR 1024.17(i), (f)(5), (b) (see 3.1); 12 U.S.C. 2609(c)–(d) (see 3.1)
- CFPB Mortgage Servicing FAQs (Escrow — statements, lump-sum communications): https://www.consumerfinance.gov/compliance/compliance-resources/mortgage-resources/mortserv/mortgage-servicing-faqs/
- Fannie Mae F-1-11 (05/13/2026): https://servicing-guide.fanniemae.com/svc/f-1-11/post-delivery-servicing-transfers
- Utah Code 7-17-5 (via Justia 2025): https://law.justia.com/codes/utah/title-7/chapter-17/section-3/ ; Md. Com. Law 12-109: https://law.justia.com/codes/maryland/commercial-law/title-12/subtitle-1/section-12-109/ ; 8 V.S.A. 10404: https://law.justia.com/codes/vermont/title-8/chapter-200/section-10404/ ; 9-B M.R.S. 429: https://legislature.maine.gov/statutes/9-B/title9-Bsec429.html
