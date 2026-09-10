# 10.6 — Denial notice

| Attribute | Value |
|---|---|
| Section | 10 — PMI Administration |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On denial |
| Governing source | HPA 12 USC 4904(b) |
| Key deadlines | Within 30 days of scheduled termination date |
| Timers | `FNMA_B8104_DENIAL_NOTICE_30`, `FNMA_SMDU_VALUATION_APPEAL_60`, `HPA_4904B2B_AUTO_NOT_CURRENT_NOTICE_30`, `HPA_4904B_DENIAL_NOTICE_30`, `MN_47_207_RESPONSE_30`, `REGX_1024_35D_NOE_ACK_5`, `SM_MI_DENIAL_SEND_5BD`, `SM_MI_HUMAN_REVIEW_10BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | PMI |
| Trigger & frequency | On denial |
| Governing source (blueprint) | HPA 12 USC 4904(b) |
| Key deadlines (blueprint) | Within 30 days of scheduled termination date |
| Artifacts | Notice |
| Systems | Core |
| Automation class (blueprint) | b |
| SoR / Sub | S[cropped in source] — reconstructed: "Sub issues in the servicer's name; partner is servicer of record" |
| Nuances (blueprint) | [cropped in source] — reconstructed: "two clocks — for borrower requests, 30 days after the later of receipt or satisfaction of evidence/certification; for automatic termination, 30 days after the scheduled termination date; must state the grounds including the results of any appraisal/AVM/BPO; Fannie Mae adds the same 30-day rule for current-value denials and the AVM disclaimer; Minnesota requires a written reason or information request within 30 days of receipt" |

### Verified requirement (as of 2026-09-09)

**12 U.S.C. 4904(b) (verified 2026-09-09).** (1) "If a servicer determines that a mortgage did not meet the requirements for termination or cancellation of private mortgage insurance under subsection (a) or (b) of section 4902 of this title, the servicer shall provide written notice to the mortgagor of the grounds relied on to make the determination (including the results of any appraisal used to make the determination)." (2) Timing: for a cancellation request, "not later than 30 days after the later of—(i) the date on which a request is received… or (ii) the date on which the mortgagor satisfies any evidence and certification requirements"; for automatic termination, "not later than 30 days after the scheduled termination date." Note the statute ties the denial notice to 4902(a)/(b) only — a midpoint (4902(c)) non-termination for non-currency has no express notice clause, but Fannie Mae's rule (below) and this design treat it identically. 4907: statutory damages up to $2,000 per violation.

**Fannie Mae B-8.1-04 (05/15/2019).** Original-value requests: "notify the borrower and provide the grounds for denial, including the results of the AVM value, BPO, or appraisal used to make the determination" within 30 days of receiving the valuation "if applicable and in accordance with applicable law"; current-value requests: "notify the borrower if the request for termination is denied and provide the reasons for denial, including the results of the BPO or appraisal. This notice must be sent within 30 days after the later of" the request date or the valuation receipt date; automatic termination/midpoint: "notify the borrower within 30 days after the termination date the MI was not automatically terminated because the payments were not current." SMDU FAQ Q6: any AVM value shared with the borrower must carry the disclaimer that the estimate "was developed by an automated valuation model" and is not an appraisal; Q19: AVM values "may not" be appealed but the borrower "may choose to pay for a BPO or appraisal"; Q20/Q21: valuation appeals are possible only when the valuation does not support termination, encouraged within 60 days, and do not extend the 120-day validity.

**Minn. Stat. §47.207 subd. 4.** "Within 30 days of receipt" of a written cancellation request the servicer must approve and notify, "request additional information," or "deny with written reasons."

**Regulation X.** A borrower's written assertion that the denial was wrong (e.g., miscomputed LTV, misapplied payment history) is a notice of error under 12 CFR 1024.35(b)(11) (any other servicing error) and, where a payment was misapplied, (b)(1)–(3); it flows to Section 4.1 with the 5-day acknowledgment/30-day response clocks. Requests for the valuation copy are information requests (Section 4.2). Reg B/ECOA: a PMI cancellation denial is not an adverse action on an application for credit **[UNVERIFIED legal position — obtain counsel opinion; default: no Reg B adverse-action notice, but the HPA notice itself states the specific grounds]**. Colorado AI Act (eff. June 30, 2026): the eligibility decision is a deterministic rule evaluation plus Fannie Mae's SMDU decision, not a high-risk AI system; the platform nonetheless gives the borrower a plain-language explanation and a human review on request (baseline §8).

**Discrepancies with the blueprint row:** (1) the blueprint's "within 30 days of scheduled termination date" is only the automatic-termination prong; the request prong runs from the later of receipt or evidence satisfaction; (2) the notice must include appraisal/AVM/BPO results; (3) Fannie Mae's valuation-receipt anchor is folded into the HPA anchor (evidence satisfaction) — the platform applies the earlier due date; (4) Minnesota's 30-day response is broader (includes "request additional information"); (5) automation class "b" is appropriate only for the narrative; the decision and deadline are fully automated.

### Operational prerequisites
- Template family `NTC_HPA_4904B_DENIAL` with reason-code paragraphs approved by compliance (plain language, HPA and Fannie Mae citations in the footer, AVM disclaimer, MN/CA variants), including the Section 4 error-resolution/information-request address block.
- `mi_denial_reasons` reference table with codes, required data fields, and cure guidance text (below).
- Human-review workflow (`human_agent` queue) for borrower-requested reviews; QC sampling job (`qc-audit`, 10% of denials monthly).
- Valuation report delivery capability (copy of BPO/appraisal to the borrower on request; the borrower paid for it) via secure e-delivery or mail.

### Build spec
#### Inputs and triggers
- `mi.evaluation.completed` with `result='ineligible'` (10.1 paths) → denial notice; `mi.auto.deferred_not_current` (10.2/10.3) → not-current notice; `mi.case.expired` (fee not received within 60 days; valuation expired without decision) → closing letter (`NTC_MI_CASE_CLOSED`, policy); MN "request additional information" branch → `NTC_MI_INFO_REQUEST` (policy/MN) within 30 days of receipt.
- `mi.denial.disputed` (borrower response) → NoE case (Section 4.1) or valuation appeal (`mi.valuation.appeal_requested`, within 60 days of evaluation); `mi.human_review.requested`.

#### Data model
`mi_denials` (append-only): `id`, `case_id` (nullable for automatic non-terminations), `loan_id`, `kind` ∈ {request_denial, auto_not_current, midpoint_not_current, case_expired, info_request}, `determined_at`, `reason_codes[]`, `reason_data` (jsonb: UPB, original value, LTV bps, threshold, projected dates, late installments list, valuation type/value/date, seasoning months, property type rule), `valuation_id`, `notice_id`, `due_on`, `sent_at`, `human_review_requested_at`, `human_review_outcome`, `qc_sampled` (bool), `superseded_by_grant_id`. `mi_denial_reasons` (reference): `code`, `hpa_ground` (text), `fnma_ground`, `required_fields[]`, `cure_text_template`.

Reason codes: `LTV_ABOVE_THRESHOLD_ORIGINAL`, `LTV_ABOVE_THRESHOLD_CURRENT`, `NOT_CURRENT`, `PAYMENT_HISTORY_30_12M`, `PAYMENT_HISTORY_60_24M`, `VALUE_DECLINED_BELOW_ORIGINAL`, `SEASONING_LT_24M`, `SEASONING_LT_60M_LTV_GT_75`, `IMPROVEMENTS_NOT_SUBSTANTIATED`, `PROPERTY_TYPE_70_RULE`, `ASSUMPTION_HISTORY_LT_24M`, `EVIDENCE_NOT_RECEIVED` (fee/certification not received — case expired), `SUBORDINATE_LIEN_CERT_MISSING` (only when configured), `MI_NOT_BORROWER_PAID` (LPMI — informational, not an HPA denial), `MI_NOT_ACTIVE` (already cancelled/rescinded), `REQUEST_NOT_FROM_AUTHORIZED_PARTY`.

#### State machine
`determined` → `notice_composed` (checklist passed) → `sent` → {`closed` | `disputed` → (`noe_opened` | `valuation_appealed` | `human_review`) → (`upheld` → `closed` | `reversed` → grant via 10.1 finalization, `superseded_by_grant_id`)}. `info_request` (MN) → `awaiting_info` → re-evaluation → `determined` or `expired`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `HPA_4904B_DENIAL_NOTICE_30` (10.1) | deadline | `mi.cancel.requested` (re-anchored by evidence events) | later of received_at / evidence satisfied | 30 `calendar_days` | `notice.sent` (`NTC_HPA_4904B_DENIAL`) or grant notice | `officer` sev-1; Sentinel; self-identified exception |
| `HPA_4904B2B_AUTO_NOT_CURRENT_NOTICE_30` (10.2/10.3) | deadline | `mi.auto.deferred_not_current` | scheduled termination / midpoint termination date | 30 `calendar_days` | `notice.sent` (`NTC_HPA_4904B_AUTO_NOT_CURRENT`) | `officer` sev-1 |
| `FNMA_B8104_DENIAL_NOTICE_30` (10.1) | deadline | `mi.valuation.delivered` | later of received_at / delivered_at | 30 `calendar_days` | denial notice sent | `officer` sev-2 |
| `MN_47_207_RESPONSE_30` (10.1) | jurisdiction override (MN) | `mi.cancel.requested` | received_at | 30 `calendar_days` | approve / info request / denial sent | `officer` sev-1 |
| `SM_MI_DENIAL_SEND_5BD` | deadline (policy) | `mi.evaluation.completed` (ineligible) | determined_at | 5 `business_days_servicer` | notice sent | queue priority |
| `SM_MI_HUMAN_REVIEW_10BD` | deadline (policy) | `mi.human_review.requested` | request date | 10 `business_days_servicer` | `mi.human_review.completed` + response letter | `officer` sev-3 |
| `REGX_1024_35D_NOE_ACK_5` / `REGX_1024_35E_NOE_RESPONSE_30` (Section 4.1) | deadline | `case.noe.opened` from a denial dispute | receipt | 5 / 30 `business_days_federal` | as Section 4.1 | as Section 4.1 |
| `FNMA_SMDU_VALUATION_APPEAL_60` (10.1) | policy | `mi.valuation.delivered` | delivered_at | 60 `calendar_days` | appeal submitted | informational |

#### Business rules and calculations
- **R1 — Due date.** `due_on = min(HPA prong, Fannie Mae prong, state prong)` applicable to the loan: request prong = `max(received_at, evidence_satisfied_at) + 30 days`; automatic prong = `scheduled_termination_date + 30 days`; MN prong = `received_at + 30 days`. `evidence_satisfied_at` = the date the borrower's fee/certification/valuation is complete; an SMDU AVM obtained by the servicer does not re-anchor the clock (the borrower supplied nothing).
- **R2 — Content.** Every reason code renders the grounds with the numbers used: for LTV — evaluation UPB, original value (or current valuation), LTV to two decimals (truncated from basis points), threshold, path evaluated; for payment history — the installment(s) and days past due; for value — valuation type, value, date, and the AVM disclaimer (or BPO/appraisal result and the appeal/120-day rules); for seasoning/property type — the Fannie Mae rule applied. Always add: what would make the loan eligible (projected scheduled 80% date; actual-payment alternative; current-value path and fees; when payment history clears); that the borrower may renew the request at any time; the Section 4 error-resolution address; contact block. Never include credit-score language or third-party underwriting rationale.
- **R3 — Automatic non-termination notice.** Grounds = the specific installment unpaid at the preceding month-end; statement that termination occurs on the first day of the month after the borrower becomes current; no fee; contact.
- **R4 — Dispute routing.** A written dispute asserting an error → NoE (Section 4.1) with the PMI case attached; a valuation disagreement → SMDU appeal (only if the valuation did not support termination); a request for a human → `human_agent` review within 10 BD, whose outcome letter either upholds (restating grounds) or reverses (grant, effective as of the date the borrower originally qualified, with refund of premiums collected since — 10.5).
- **R5 — Supersession.** A later grant on the same case supersedes the denial; the denial record remains (append-only) with `superseded_by_grant_id`.
- **Worked example (LTV denial).** From 10.1: request received 2027-07-10; evaluation UPB $335,548.68; original value $400,000.00; `ltv_bps = 8388` → "83.88%"; HPA/Fannie Mae threshold 80.00%; scheduled 80% date 2034-08-01 (payment 124); actual-payment alternative: "your balance must be $320,000.00 or less"; current-value path available after 2026-05-01 (24 months) at 75% until 2029-05-01, then 80% — BPO $190; `due_on = 2027-07-10 + 30 = 2027-08-09`; notice composed 2027-07-13, sent 2027-07-14 (mail; no e-consent).
- **Worked example (payment-history denial).** Request 2029-07-10 with the 2028-10-01 installment received 2028-11-05 (35 days past due) inside window B → `PAYMENT_HISTORY_30_12M`; the notice names the installment and states that a renewed request on or after 2029-11-06 (when the 12-month window no longer contains that installment, assuming no other lates) would satisfy the payment-history condition; due by 2029-08-09.
- **Worked example (valuation denial).** Current-value request 2026-08-20; BPO delivered 2026-09-03 at $490,000; UPB $370,522.40 → 75.62% > 75% (seasoning 29 months) → `LTV_ABOVE_THRESHOLD_CURRENT`; `due_on = min(2026-08-20, 2026-09-03) + 30 = 2026-10-03`; the notice includes the BPO value and date, the appeal option (within 60 days, only because the valuation did not support termination), the 120-day validity (2027-01-01) and that a balance of $367,500.00 or less would meet 75%.

#### Integrations
`print-mail`/`e-delivery` (channel per consent class `pmi`), Section 4 case engine (NoE/RFI), `fnma-smdu` valuation appeal call, borrower portal (secure document delivery of the valuation copy). No investor or insurer message is generated by a denial.

#### Outputs and artifacts
- `NTC_HPA_4904B_DENIAL` (12 U.S.C. 4904(b)(1); B-8.1-04; MN §47.207 subd. 4): checklist — grounds with numbers; valuation results and disclaimer; cure/renewal guidance; error-resolution address; contact; date; loan identifiers; MN 12-point variant; Spanish translation available on request (Section 4 language-access policy).
- `NTC_HPA_4904B_AUTO_NOT_CURRENT` (4904(b)(2), B-8.1-04): as R3.
- `NTC_MI_INFO_REQUEST` (MN §47.207 subd. 4; also used nationally when the request lacks essentials): what is missing, how to provide it, that the case will be closed after 60 days without response.
- `NTC_MI_CASE_CLOSED` (policy): case expired; how to reopen.
- Records: `mi_denials`, `notices`, `documents`, `agent_decisions`, `cases` (NoE link).

#### AI agent design (AI-first)
The `pmi` agent composes the denial from the decision record: it selects reason codes only from `mi_evaluations.reasons` (no free-form grounds), fills the numeric fields from the evaluation snapshot, drafts the cure paragraph, runs the required-content checklist, and sends. It handles the borrower's response: classifies a dispute into NoE/appeal/human-review, opens the right case, and drafts the human reviewer's package (evaluation inputs, payment-history table with dates, valuation report, rule citations). Tools: `notices.*`, `pmi.evaluation.get`, `case.noe.open`, `smdu.valuation.appeal`, `documents.deliver`. Guardrails: the notice cannot issue without a linked `mi_evaluations` row; the due date is computed by the Timer Engine, not the agent; any change to numbers after composition forces re-composition; the agent cannot "soften" a denial into a partial grant. Escalations: human-review requests → `human_agent` (10 BD); systemic denial patterns (e.g., >5% of denials reversed in a month) → `officer` and `qc-audit`; suspected template defect → `officer`. Disclosures: AI disclosure on calls/chats; Colorado-style explanation and appeal path stated in the notice. AI-off path: denials compose from the same decision record with a human sender.

#### Edge cases and failure modes
- Multiple requests in flight (e.g., verbal then written): one case; the earliest receipt date anchors the HPA clock.
- Request received while the loan is in a forbearance plan: not current → deny with the plan reference and the disaster exception explanation where applicable; do not use the denial as a collection communication.
- Borrower submits their own appraisal: the notice explains that only SMDU-ordered valuations are accepted (10.1-Q3) and offers the fee path; the clock is not re-anchored by an unaccepted document.
- Evidence arrives on day 29: the clock re-anchors to the evidence date; decide within the new 30 days but target 5 BD.
- Fee received but the valuation cannot be completed (no access): after 30 days the order is cancelled and the case expires with `EVIDENCE_NOT_RECEIVED`; the fee is refunded/credited per Fannie Mae invoicing **[UNVERIFIED]**.
- SMDU decision contradicts the local rule engine (e.g., SMDU eligible, local ineligible on payment history from platform data): reconcile before any notice; data mismatch → correct the platform or SMDU data; if SMDU is more favorable and Fannie Mae is the holder, grant (4910(b)); if less favorable and the HPA path is met, grant under the HPA and record the divergence for `officer`.
- Transfer-in with an open denial dispute: the NoE clocks continue from the transferor's receipt (Section 1.7-style handling).
- Bankruptcy: denials are informational, include the bankruptcy disclaimer; no payment demand.
- Successor in interest denied for lack of confirmation: not an HPA denial; send the Section 4.4 confirmation request instead.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 10.6-T1 | Given the LTV denial example, then the rendered notice contains "$335,548.68", "$400,000.00", "83.88%", "80.00%", the scheduled date 2034-08-01, the current-value option with the $190 fee, and the error-resolution address; sent by 2027-08-09. |
| 10.6-T2 | Given the payment-history denial, then the notice names the 2028-10-01 installment and "35 days past due" and the renewal date 2029-11-06. |
| 10.6-T3 | Given the valuation denial, then the notice includes the BPO value $490,000 (2026-09-03), the appeal window to 2026-11-02 and validity to 2027-01-01; `due_on=2026-10-03`. |
| 10.6-T4 | Given evidence received 2026-09-25 on a case received 2026-08-27, then `due_on` re-anchors to 2026-10-25 and the timer history shows both anchors. |
| 10.6-T5 | Given an automatic non-termination on 2035-07-01, then `NTC_HPA_4904B_AUTO_NOT_CURRENT` is sent by 2035-07-31 naming the June 2035 installment. |
| 10.6-T6 | Given an MN loan and a request missing the property-occupancy confirmation, then `NTC_MI_INFO_REQUEST` is sent within 30 days of receipt and the MN timer is satisfied. |
| 10.6-T7 | Given a borrower letter "you miscounted my late payment" received 2027-07-20, then a NoE case opens with acknowledgment within 5 business days and the PMI case is linked. |
| 10.6-T8 | Given a human-review request, then a `human_agent` task with the package is created and closed within 10 BD with an outcome letter; a reversal triggers a grant effective 2027-07-10 and a refund of premiums collected since. |
| 10.6-T9 | Given an attempt to send a denial without a linked evaluation row, then the send command is rejected. |
| 10.6-T10 | Given 10% monthly QC sampling, then sampled denials are marked and the QC findings feed `qc_finding` cases. |

#### Audit and evidence
`mi_denials` with reason codes and the numeric snapshot, evaluation IDs (SMDU and local), rendered notice hash and delivery evidence, timer anchors/re-anchors, dispute/NoE/appeal linkages and outcomes, human-review packages and decisions, QC sample results, and monthly statistics (denials by reason, reversal rate, timeliness) for the Compliance Sentinel, MORA and HPA 4907 defense.

### Open questions / decisions
1. **Reg B adverse-action treatment (10.6-Q1):** default — not an adverse action; HPA notice only; counsel opinion to confirm.
2. **Human review of denials (10.6-Q2):** default — on request and 10% QC sampling, not mandatory pre-send review (deterministic decision).
3. **Language access (10.6-Q3):** default — English notice with Spanish translation on request, aligned with Section 4 policy.

### Sources
- 12 U.S.C. 4904(b), 4907: https://www.law.cornell.edu/uscode/text/12/4904 ; https://www.law.cornell.edu/uscode/text/12/4907 (verified 2026-09-09)
- Servicing Guide B-8.1-04 (05/15/2019): https://servicing-guide.fanniemae.com/svc/b-8.1-04/termination-conventional-mortgage-insurance
- Fannie Mae SMDU MI termination FAQ (Apr. 17, 2025): https://singlefamily.fanniemae.com/media/document/pdf/borrower-initiated-mi-termination-requests-using-smdu-faqs
- Minn. Stat. §47.207: https://www.revisor.mn.gov/statutes/cite/47.207
- Federal Reserve Consumer Compliance Handbook, HPA (Nov. 2007): https://www.federalreserve.gov/boarddocs/supmanual/cch/hpa.pdf
- research/00a §5.6 (Colorado AI Act); Section 4.1/4.2 of this specification.
