# 7.6 — Payoff statement

| Attribute | Value |
|---|---|
| Section | 7 — Compliance Notices & Disclosures |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On written request |
| Governing source | Reg Z 1026.36(c)(3) |
| Key deadlines | Within 7 business days (reasonable time if disaster) |
| Timers | `REGZ_1026_36C3_PAYOFF_REASONABLE_10BD`, `REGZ_1026_36C3_PAYOFF_STMT_7BD`, `SM_PAYOFF_DELAY_ACK_2BD`, `SM_PAYOFF_REQUESTER_VERIFY_1BD`, `SM_PAYOFF_STMT_ACCURACY_GATE`, `STATE_CA_CC2943_PAYOFF_21`, `STATE_FL_701_04_ESTOPPEL_10` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Compliance |
| Trigger & frequency | On written request |
| Governing source (blueprint) | Reg Z 1026.36(c)(3) |
| Key deadlines (blueprint) | Within 7 business days (reasonable time if disaster) |
| Data/artifacts | Payoff statement |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | Sub |
| Nuances (blueprint) | (none) — reconstructed: "reasonable time" also covers bankruptcy, foreclosure, reverse/shared-appreciation loans; requests from "any person acting on behalf of the consumer"; servicer may set reasonable request requirements; accuracy when issued; Reg X §1024.35(b)(6) makes a late/inaccurate payoff a notice-of-error category; Fannie Mae A2-3-05 fee limits; state deadlines/fees (CA 21 days/$30/$300; FL 10 days, no disclaimers). **Scope split:** the payoff computation, funds handling, remittance and release are built in 16.1–16.3; this process is the compliance-notice layer (request intake, requester authorization, the 7-business-day timer, required content checklist, delivery and evidence). |

### Verified requirement (as of 2026-09-09)

**Reg Z 12 CFR 1026.36(c)(3) (verified today):** "In connection with a consumer credit transaction secured by a consumer's dwelling, a creditor, assignee or servicer, as applicable, must provide an accurate statement of the total outstanding balance that would be required to pay the consumer's obligation in full as of a specified date. The statement shall be sent within a reasonable time, but in no case more than seven business days, after receiving a written request from the consumer or any person acting on behalf of the consumer. When a creditor, assignee, or servicer, as applicable, is not able to provide the statement within seven business days of such a request because a loan is in bankruptcy or foreclosure, because the loan is a reverse mortgage or shared appreciation mortgage, or because of natural disasters or other similar circumstances, the payoff statement must be provided within a reasonable time. A creditor or assignee that does not currently own the mortgage loan or the mortgage servicing rights is not subject to the requirement in this paragraph (c)(3) to provide a payoff statement." Comment 36(c)(3)-1: a person acting on behalf of the consumer "may include the consumer's representative, such as an attorney representing the individual, a non-profit consumer counseling or similar organization, or a creditor with which the consumer is refinancing and which requires the payoff statement to complete the refinancing." Comment 36(c)(3)-2: the servicer "may specify reasonable requirements for making payoff requests, such as requiring requests to be directed to a mailing address, email address, or fax number specified by the creditor, assignee or servicer or any other reasonable requirement or method." Comment 36(c)(3)-3: "Payoff statements must be accurate when issued." **Business day** for §1026.36 is the general definition in §1026.2(a)(6) — "a day on which the creditor's offices are open to the public for carrying on substantially all of its business functions" (the "specific" all-days-but-Sundays/holidays definition applies only to the enumerated rescission/§1026.19/§1026.20(e)/§1026.31/§1026.46 provisions) → Timer Engine calendar `servicer`. Statutory source: TILA §129G, 15 U.S.C. 1639g (Dodd-Frank §1464) **[citation from general knowledge; text not re-fetched]**.

**Reg X overlay.** §1024.35(b)(6): failure "to provide an accurate payoff balance amount upon a borrower's request in violation of section 12 CFR 1026.36(c)(3)" is a covered error → NoE process and clocks in 4.1 (verified there). §1024.36 RFI rules apply to information requests that are not payoff requests. Reg Z §1026.2(a)(11): a confirmed successor in interest is a "consumer" for §1026.36(c)(3) purposes (4.4).

**Fannie Mae (Aug. 12, 2026 Guide).** A2-3-05 (11/08/2017): a servicer may charge the borrower for "providing more than one payoff statement in a short period of time (or even a single payoff statement if applicable law expressly permits a borrower fee)" and for "providing expedited service via fax"; every fee "must be permitted by applicable law and the mortgage loan documents," be "reasonable," and never "charged to Fannie Mae"; prohibited: fees for disputes, routine collections, workout arrangements, breach letters, reinstatement record updates. C-1.2-03 (payoff processing), C-3-02 (remitting payoff proceeds), A4-2.1-07 (non-interest-bearing balances must be collected at payoff) — owned by 16.1/16.2. Fannie Mae has no payoff-statement timing rule beyond law.

**State overlays (verified today unless noted).** **California Civ. Code §2943 (2025):** on written demand by an "entitled person" (trustor/mortgagor or successor, beneficiaries, junior lienholders, licensed escrow holders) or their authorized agent, the beneficiary must "within 21 days of the receipt of a written demand ... prepare and deliver" the payoff demand statement; fee "not to exceed thirty dollars ($30)"; a willful failure makes the beneficiary "liable to the entitled person for all damages" and it "shall forfeit to the entitled person the sum of three hundred dollars ($300)"; the statement may be relied on through the earlier of close of escrow, transfer of title or recordation of a lien; fax transmission expressly allowed. **Florida Stat. §701.04 (2025):** "Within 10 days after receipt of the written request of a mortgagor" (or record title owner, fiduciary, trustee or authorized person) "the mortgagee or mortgage servicer shall send or cause to be sent an estoppel letter" stating the unpaid balance as of the specified date "including an itemization of the principal, interest, and any other charges" and "interest accruing on a per-day basis"; the mortgagee may not "qualify, reserve the right to change, or condition or disclaim the reliance of others on the information provided" and, absent timely correction, "may not deny the accuracy of such information as against any person who relied on it"; release within 60 days after payoff. Other states have deadlines and fee limits (e.g., New York RPL §274-a; Texas 7 TAC ch. 155/Fin. Code) **[UNVERIFIED — to be compiled into `jurisdiction_rules.payoff` by 16.1 with counsel]**.

**Discrepancies with the blueprint row:** (1) "reasonable time" applies to bankruptcy, foreclosure, reverse/shared-appreciation loans and disasters — not only disasters; (2) the 7-day count uses the *servicer-open* business-day definition, not the Reg X §1024.31 or Reg Z "specific" definitions; (3) requests may come from agents (attorneys, counselors, refinancing lenders) and successors — requester authorization is part of the process; (4) state deadlines can be shorter (FL 10 calendar days) or carry statutory damages (CA $300) — the earlier of federal/state governs; (5) the row omits the §1024.35(b)(6) error linkage and Fannie Mae's fee limits.

### Operational prerequisites
- Designated payoff-request channels published on statements, portal and IVR (comment 36(c)(3)-2): portal form, email address, fax number, mailing address (Supermortgage; with 4.1's exclusive-address decision).
- 16.1 payoff engine (per-diem convention, escrow/NIB/fee handling, good-through logic) and 16.2 remittance rules — Stage 1 build; `jurisdiction_rules.payoff` (deadline days, fee cap, content/disclaimer rules, reliance rules) — compliance/counsel; **[state table UNVERIFIED beyond CA/FL]**.
- Notice Registry templates `NTC_REGZ_36C3_PAYOFF_STMT` (+ CA and FL variants), `NTC_PAYOFF_REQUEST_ACK_DELAY` (reasonable-time path), `NTC_PAYOFF_UPDATED_STMT`; counsel approved.
- Requester-authorization rules and identity checks (4.x `parties`; GLBA §1016.14 basis for third-party escrow/title requests acting for the consumer); fraud controls for wire instructions (positive confirmation, no last-minute changes by email — 16.1/19.2).
- Foreclosure firm interface for attorney fees/costs (13.6) and bankruptcy-ops for post-petition payoff components (14.x) to keep the reasonable-time path short.

### Build spec
#### Inputs and triggers
- `payoff.request.received` from any channel with `written=true` (portal form, email, fax, mail — including a request embedded in other correspondence; the 4.x Intake Router classifies free text and over-recognizes) → case `payoff` (baseline `cases.case_type = payoff`).
- Oral requests (phone/AI voice/chat): honored operationally (quote given per 16.1) but the §1026.36(c)(3) clock starts only on a written request; the agent offers to convert the request to written (portal click/email) and records both.
- `payoff.request.requester_verified`, `payoff.calculation.completed` (16.1), `payoff.statement.sent`, `payoff.statement.updated`, `payoff.funds_received` (16.2), `case.noe.opened` (§1024.35(b)(6)).

#### Data model
- `payoff_requests`: `case_id`, `loan_id`, `received_at timestamptz`, `received_channel`, `written bool`, `requester_party_id`, `requester_type` ∈ {borrower, coborrower, successor_confirmed, attorney, counselor, refinancing_lender, title_escrow, other_agent}, `authorization_evidence_document_id`, `requested_good_through date`, `delivery_channel_requested`, `delivery_address`, `state`, `deadline_federal date`, `deadline_state date?`, `reasonable_time_reason` ∈ {none, bankruptcy, foreclosure, disaster, other}, `reason_evidence`, `status`, `statement_notice_id`, `fee_cents` (0 unless permitted), `superseded_by`.
- `payoff_statements` (16.1 owns the figures): `good_through`, `upb_cents`, `interest_cents`, `per_diem_cents`, `nib_balance_cents`, `escrow_treatment`, `fees jsonb`, `late_charges_cents`, `advances_cents`, `suspense_credit_cents`, `total_cents`, `calc_version`, `hash`.
- Retention `life_of_loan_plus_4y`; requester PII per 4.x.

#### State machine
`received` → `written_confirmed` (clock started) | `oral_only` (quote path; no clock) → `requester_verified` | `authorization_pending` (request info; clock keeps running — the servicer must still meet 7 BD or document the reason) → `calculating` (16.1) → `rendered` → `checked` → `sent` (channel per request; timer satisfied) → `superseded` (updated statement on rate change/new good-through/error) | `closed` (paid off / expired). Side path: `reasonable_time` (documented reason; ack notice sent; target ≤ 10 BD). Actors: `payoff-release` agent (16.1 math, funds), `disclosures` (notice layer), `case` (NoE), `attorney` (foreclosure fee schedules), `bankruptcy-ops`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGZ_1026_36C3_PAYOFF_STMT_7BD` | deadline | `payoff.request.received` (written) | receipt date (email/fax/portal: same day; mail: vendor receipt date) | +7 business_days_servicer, end of day | `payoff.statement.sent` (`NTC_REGZ_36C3_PAYOFF_STMT`) | sev-1; auto-escalate to ops at 70%; RESPA §1024.35(b)(6) exposure log; complaint-risk flag |
| `REGZ_1026_36C3_PAYOFF_REASONABLE_10BD` | deadline (policy operationalization) | `payoff.request.reasonable_time_applied` (bankruptcy/foreclosure/disaster with evidence) | receipt date | +10 business_days_servicer | `payoff.statement.sent` | sev-1 |
| `SM_PAYOFF_DELAY_ACK_2BD` | deadline (policy) | `payoff.request.reasonable_time_applied` | receipt date | +2 business_days_servicer | `NTC_PAYOFF_REQUEST_ACK_DELAY` sent | sev-3 |
| `STATE_CA_CC2943_PAYOFF_21` | deadline (CA property) | `payoff.request.received` (written demand by entitled person) | receipt date | +21 calendar_days | `payoff.statement.sent` | sev-1 ($300 forfeiture exposure) |
| `STATE_FL_701_04_ESTOPPEL_10` | deadline (FL property) | `payoff.request.received` (written) | receipt date | +10 calendar_days | `payoff.statement.sent` | sev-1 |
| `SM_PAYOFF_REQUESTER_VERIFY_1BD` | deadline (policy) | `payoff.request.received` | receipt | +1 business_days_servicer | `payoff.request.requester_verified` or info request sent | sev-3 |
| `SM_PAYOFF_STMT_ACCURACY_GATE` | not_before_gate | render | — | 16.1 calc version current; no pending unposted payments/reversals older than the cut-off; ARM adjustment (7.2) effective before good-through reflected | render allowed | hold + ops |
| Jurisdiction overrides | | `jurisdiction_rules.payoff.deadline_days`, `.fee_cap_cents`, `.disclaimer_prohibited` (FL), `.reliance_rule`, `.entitled_persons` — earliest of federal/state deadlines governs | | | | |

#### Business rules and calculations
1. **Clock start:** `received_at` for electronic channels is the timestamp of receipt converted to the servicer's local business date; mail = vendor receipt date; a request received after the day's cut-off (policy 5 p.m. local) still counts that day (conservative). Day 1 is the first servicer business day after receipt; due = day 7 (e.g., received Tue Oct 13, 2026 → due Thu Oct 22, 2026 if the servicer is open Oct 14–16 and 19–22).
2. **Who may request:** the borrower(s); a confirmed successor in interest (consumer); "any person acting on behalf of the consumer" with authorization evidence proportional to risk — attorneys (letter of representation), HUD counselors (borrower authorization form), refinancing lenders and title/escrow companies (borrower-signed authorization or the loan application/escrow instructions naming them); GLBA basis §1016.14 (transaction the consumer requests). Unverifiable requesters get a request-for-authorization the same day; the federal clock is not tolled — if authorization cannot be obtained by day 7, the statement is sent to the borrower of record (which satisfies the rule for a consumer request) and the requester is told to obtain it from the borrower.
3. **Reasonable-time path:** only for bankruptcy (post-petition fees/trustee components need reconciliation), foreclosure (attorney fees/costs must be obtained from the firm, 13.6 SLA), disaster (declared event affecting operations) or "similar circumstances" (documented, `officer`-approved category); the reason and evidence are recorded and an acknowledgment is sent within 2 BD; target ≤ 10 BD.
4. **Content (checklist for `NTC_REGZ_36C3_PAYOFF_STMT`):** requester and borrower names; loan number (truncated on copies to third parties); property address; **good-through date**; total payoff; itemization — UPB, interest from paid-through date through good-through date, per-diem amount and basis, non-interest-bearing deferred/forborne balance (A4-2.1-07), unpaid late charges, borrower-payable fees and advances (recoverable corporate/escrow advances), recording/release fees where permitted by state law, prepayment penalty (none for conforming loans), credits (suspense/unapplied funds), escrow treatment statement (escrow balance refunded within 20 business days after payoff per §1024.34(b), not netted — 16.1 decision), MI premium proration if borrower-paid (10.5); per-diem instruction for funds received after the good-through date; where and how to remit (wire instructions with fraud warning; no email changes); contact channels; statement that a written updated statement will be provided on request; in FL no disclaimers/reservations (§701.04); in CA the §2943 statement elements and fee line ($0 by default).
5. **Accuracy when issued (comment 36(c)(3)-3):** the figure is computed from committed ledger state at render; the gate blocks rendering while a posting is pending; any change affecting the figure before the good-through date (ARM adjustment, escrow disbursement advance, fee) triggers an **updated statement** to the same recipients (`superseded_by`), and the original is retained.
6. **Fees:** default $0 for any payoff statement; a fee only where `jurisdiction_rules.payoff.fee_cap_cents > 0` *and* the request is a repeat within 30 days or an expedite is requested (A2-3-05); never charged to Fannie Mae.
7. **Delivery:** the requester's requested channel (fax/email/portal) plus a copy to the borrower of record's portal or by mail when the requester is a third party (policy; GLBA-consistent); to a consumer requester by email only where the written request itself specifies email (treated as the consumer's agreement for this document — decision 2) or an E-SIGN `payoff_statements` consent exists; otherwise mail plus portal.
8. **Foreclosure/bankruptcy figures:** attorney fees/costs from the firm's invoice feed (13.6) with a 3-BD SLA; bankruptcy post-petition components from 14.x; statements state whether reinstatement (13.x) is separately available.

**Worked example.** Written request emailed Tue Oct 13, 2026 09:40 local by the borrower's refinancing lender with a signed borrower authorization, good-through Nov 20, 2026; servicer open Oct 14–16 and 19–22 (Columbus Day Oct 12 irrelevant; Veterans Day Nov 11 outside the window) → federal due date **Thu Oct 22, 2026**; property in Texas (no shorter state deadline in `jurisdiction_rules` **[UNVERIFIED]**). Figures from 16.1 (illustrative, 365-day per diem as the 16.1 default): the Nov 1, 2026 payment is assumed received (paid-through Oct 31; October interest at 5.750% is covered by that payment), leaving UPB **$371,048.86**; from the Nov 1 change date interest accrues at the noticed new rate 6.375% (7.2); interest Nov 1–20 = 20 × $64.81 = **$1,296.13** (per diem $64.81 = 371,048.86 × 0.06375 ÷ 365, rounded half-up); NIB deferred balance $0.00; late charges $0.00; recording fee $0.00 (TX release fee handling per 16.3); escrow $1,830.00 to be refunded separately; suspense $0.00 → **total payoff $372,344.99** good through Nov 20, 2026, per diem thereafter $64.81; an alternative figure is printed for funds arriving before the Nov 1 payment is received (UPB $371,602.55 with interest at 5.750% from Oct 1 through Oct 31, then 6.375% from Nov 1). Statement rendered and emailed to the lender and posted to the borrower's portal on Oct 15 (day 2); timer satisfied. On Nov 1 the ARM adjustment becomes effective exactly as noticed, so no updated statement is needed; had the rate differed, an updated statement would have issued the same day.

#### Integrations
| Counterparty | Direction | Interface | Notes |
|---|---|---|---|
| Intake channels (portal, email, fax-to-email, mail scanning — 4.x) | in | classification to `payoff` case | receipt timestamps evidenced by channel logs/vendor manifest |
| 16.1 payoff engine / 16.2 remittance | internal | `payoff.calculation.*` events; `payoff_statements` | figures never recomputed in this layer |
| Foreclosure firms (13.6) | in | fee/cost schedule feed or portal export **[vendor-specific]** | 3-BD SLA; reasonable-time evidence |
| Fannie Mae | none for the statement | payoff reporting/remittance in 5.3/16.2 | — |
| Print/mail, e-delivery, fax gateway | out | as 7.1; fax via provider API **[vendor-specific]** | delivery evidence stored per channel |

#### Outputs and artifacts
- Notices: `NTC_REGZ_36C3_PAYOFF_STMT` (checklist items in rule 4; state variants `_CA_2943`, `_FL_701_04`), `NTC_PAYOFF_REQUEST_ACK_DELAY` (reason, expected date), `NTC_PAYOFF_UPDATED_STMT`, `NTC_PAYOFF_AUTHORIZATION_REQUEST`. Channel per rule 7.
- Records: `payoff_requests`, `cases(payoff)`, `notices`/`notice_deliveries`, `documents`, `loan_events` `payoff.request.received/written_confirmed/requester_verified/reasonable_time_applied`, `payoff.statement.sent/updated`. Ledger: none here (fees, if any, post in 2.7-style fee handling); investor events: none.

#### AI agent design (AI-first)
- **Agents:** `payoff-release` computes (16.1); `disclosures` runs intake classification (with the 4.x Intake Router), requester verification, timer management, rendering, checklist and delivery; `borrower-comms` handles oral requests and converts them to written on request. Decision record: `{case_id, received_at, channel, written, requester_type, authorization_evidence_id, deadlines{federal,state}, reasonable_time_reason?, calc_version, statement_hash, sent_at, channel}`.
- **Guardrails:** figures come only from the 16.1 engine; wire instructions are static, vault-controlled and never edited by an agent; third-party delivery requires authorization evidence or a borrower-of-record copy; the LLM may classify requests and draft the authorization request, not the statement.
- **Escalations:** `attorney`/firm for foreclosure fee schedules; `bankruptcy-ops` (+ `attorney` if a court order governs) for post-petition components; `officer` to approve a "similar circumstances" reasonable-time category; `human_agent` on request; `licensed_specialist` not applicable.
- **Disclosure/consent:** AI voice/chat disclose automation; emailing a consumer's statement per decision 2; no TCPA implications (inbound-driven).
- **AI-off path:** ops queue with the same timers and checklist.

#### Edge cases and failure modes
- **Transfer-in/out:** requests received by the transferor before the transfer date are the transferor's (1.7 checklist item `PAYOFF_REQUESTS_OPEN` carries them over with received dates; Supermortgage honors the original clock as policy); after transfer-out, requests are forwarded within 1 BD and the requester is told the new servicer (1024.33 goodbye period rules in 17.2).
- **Bankruptcy:** payoff may include post-petition amounts and must respect the automatic stay/plan; reasonable-time path with `bankruptcy-ops`; statements to counsel where required (14.3).
- **Foreclosure:** include firm fees/costs; reinstatement quote separately (13.x); reasonable-time path if the firm's figures are delayed; sale-date proximity flagged.
- **SCRA:** interest at the capped rate during protection (13.9); refund of any excess.
- **Disaster:** declared event affecting operations → reasonable-time with `officer` declaration; still target ≤ 10 BD.
- **Successor in interest:** a confirmed successor's request is a consumer request; a potential successor (not yet confirmed) is treated as an agent request requiring authorization or confirmation (4.4 expedited path).
- **Duplicate/repeat requests:** each written request restarts a clock; repeat within 30 days may carry a fee only where permitted; updated statements are free when triggered by a change.
- **Partial data:** unposted payments at render → gate holds; if the hold would breach, issue the statement with the best-evidence figure and an updated statement upon posting, recording the reason.
- **Vendor outage (fax/email):** portal post + mail; call the requester to confirm.
- **Errors:** an inaccurate statement is corrected by an updated statement; borrower dispute → NoE §1024.35(b)(6) (4.1); short payoff received in reliance on our figure → 16.2 shortage handling (servicer absorbs where the statement was relied upon in a state with a reliance rule such as FL/CA).
- **Charged-off / deferred balances:** NIB balances always included (A4-2.1-07); charged-off loans (7.1 (e)(6)) still get payoff statements on request.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 7.6-T1 | Given a written request emailed Tue 2026-10-13 09:40 and the servicer open on standard weekdays, then the federal deadline is Thu 2026-10-22 and a send on 2026-10-23 breaches with sev-1. |
| 7.6-T2 | Given the same request by mail received by the scanning vendor 2026-10-13, then the clock starts 2026-10-13 (vendor receipt date, not postmark). |
| 7.6-T3 | Given a Florida property, then the deadline is the earlier of 2026-10-22 and 2026-10-23 (10 calendar days) and the statement contains no disclaimer language. |
| 7.6-T4 | Given a California property and a request from a licensed escrow holder, then the 21-day state timer runs alongside the federal 7-BD timer and the fee line is $0 (cap $30 unused). |
| 7.6-T5 | Given an oral request by AI voice, then a quote is given per 16.1, no §1026.36(c)(3) timer starts, and the borrower is offered a one-click written request; given the click, then the timer starts at the click time. |
| 7.6-T6 | Given a request from a title company without authorization, then an authorization request goes out the same day and, absent authorization by day 7, the statement is sent to the borrower of record and the timer is satisfied. |
| 7.6-T7 | Given a loan in active foreclosure and firm fees pending, then `reasonable_time_reason = foreclosure` with the firm request as evidence, an acknowledgment is sent within 2 BD, and the statement goes out by day 10. |
| 7.6-T8 | Given UPB $371,048.86, rate 6.375% from Nov 1, paid-through Oct 31 and good-through Nov 20, 2026, then per diem $64.81, interest $1,296.13 and total $372,344.99 with escrow shown as refunded separately. |
| 7.6-T9 | Given an escrow tax disbursement advance posted after the statement but before the good-through date, then an updated statement is issued the same day and the original is marked superseded. |
| 7.6-T10 | Given a confirmed successor requests a payoff, then it is a consumer request (no authorization needed) and the statement is delivered to the successor. |
| 7.6-T11 | Given a NoE alleging an inaccurate payoff, then the 4.1 NoE case links to the `payoff_requests` row and the statement hash under investigation. |

#### Audit and evidence
`payoff_requests` (receipt evidence: email headers, fax log, portal event, vendor manifest), authorization documents, `payoff_statements` hash and calc version, `notices`/`notice_deliveries` per channel, reasonable-time evidence, timer history, `agent_decisions`; 16.2 reconciliation ties funds received to the statement relied upon.

### Open questions / decisions
1. Post-payoff-statement good-through window policy (max days ahead)? **Default: up to 30 days; beyond that, quote with a per-diem note** (16.1).
2. Email a consumer's payoff statement without a standing E-SIGN consent when the written request asks for email? **Default: yes for the requested channel + portal copy**; mail if the request specifies no channel. Counsel to confirm that §1026.36(c)(3) imposes no writing/E-SIGN requirement.
3. Honor the transferor's original 7-BD clock for open requests at transfer-in? **Default: yes** (borrower-protective; 1.7).
4. Charge repeat/expedite fees where state law allows? **Default: no fees** (simplicity; complaint avoidance).

### Sources
- 12 CFR 1026.36(c)(3) and comments 36(c)(3)-1..3: https://www.consumerfinance.gov/rules-policy/regulations/1026/36/ ; https://www.consumerfinance.gov/rules-policy/regulations/1026/interp-36/ — verified 2026-09-09
- 12 CFR 1026.2(a)(6) (business day): https://www.consumerfinance.gov/rules-policy/regulations/1026/2/ — verified 2026-09-09
- Fannie Mae Servicing Guide A2-3-05 (11/08/2017): https://servicing-guide.fanniemae.com/svc/a2-3-05/fees-certain-servicing-activities — verified 2026-09-09 (Guide edition Aug. 12, 2026)
- Cal. Civ. Code §2943 (2025, Justia): https://law.justia.com/codes/california/code-civ/division-3/part-4/title-14/chapter-2/article-1/section-2943/ — verified 2026-09-09
- Fla. Stat. §701.04 (2025, Justia): https://law.justia.com/codes/florida/title-xl/chapter-701/section-701-04/ — verified 2026-09-09
- Reg X §1024.35(b)(6) — as verified in Section 4.1
