# 3.8 — Escrow waiver administration

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | Per loan |
| Governing source | FNMA B-1-01 |
| Key deadlines | On event |
| Timers | `ESC_WAIVER_DECISION_SLA_10BD`, `ESC_WAIVER_REFUND_30`, `FLOOD_12CFR22_5_ESCROW_GATE`, `FNMA_B101_MI_MONTHLY_ESCROW_GATE`, `FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE`, `FNMA_B101_WAIVER_REVOKE_ON_ADVANCE_0`, `REGX_1024_17G_INITIAL_STMT_45`, `REGX_1024_17I4_SHORT_YEAR_RESET_60`, `REGZ_1026_35B3_HPML_ESCROW_5Y_GATE`, `REGZ_1026_35B3_HPML_LTV_GATE`, `STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE`, `STATE_MN_47_20_DISCONTINUE_NOTICE_60` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | Per loan |
| Governing source (blueprint) | FNMA B-1-01 |
| Key deadlines (blueprint) | On event |
| Data/artifacts | Waiver flag |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub decides and administers; SoR liable; basis retained for Fannie Mae |
| Nuances (blueprint) | [cropped in source] — reconstructed: no solicitation; four mandatory denial conditions incl. 80% of original appraised value; monthly MI cannot be waived; revocation on non-payment and before modification trials; HPML 5-year/80% rule; flood escrow mandate; state termination rights (IL 65%, MN 5-year) |

### Verified requirement (as of 2026-09-09)

**Fannie Mae Servicing Guide B-1-01 (09/11/2024; Guide ed. Aug 12, 2026)** — "Waiving Escrow Account Requirements": servicers "must not solicit borrowers to waive escrow requirements but may evaluate borrower requests"; the servicer evaluates "whether waiver is appropriate under the mortgage loan documents and applicable law" and **must deny** the request if: "borrower has received a prior mortgage loan modification, or previously been approved for an escrow waiver and failed to make all payments timely"; "borrower has experienced any delinquency in the 12 months immediately preceding the request"; "borrower has experienced a 60+ day delinquency in the 24 months immediately preceding"; or "principal balance for the mortgage loan is greater than or equal to 80% of the original appraised value." The servicer must "maintain the basis for the waiver decision and any disclosures provided to the borrower" in the file, available to Fannie Mae on request. "The servicer may not waive the individual escrow requirement for MIPs when the premiums are paid monthly." Revocation: when a waiver exists and the borrower fails to pay taxes/insurance/related charges, the servicer must advance (including penalties), "revoke any escrow waiver and establish an escrow account … to collect funds to repay the advances and pay future bills" (reimbursement per F-1-05); for a modification, "Revoke any escrow deposit account waiver and establish an escrow deposit account prior to the beginning of the trial payment period," unless the borrower is current on all T&I items *and* the modification is a Flex Modification per D2-3.2-06 (which adds: if applicable law prohibits establishing the account, ensure T&I are paid to date); for a Payment Deferral the servicer "need not establish an escrow account if the borrower is current" on all T&I items. No fee language exists in B-1-01.

**Reg Z 12 CFR 1026.35(b)** (eCFR current as of Sept. 3, 2026): HPML first liens on a principal dwelling must have an escrow account established before consummation for taxes and creditor-required insurance ((b)(1)); the account "may be cancelled only upon the earlier of" debt termination or a consumer request received "no earlier than five years after consummation," and only if the unpaid principal balance "is less than 80 percent of the original value of the property securing the underlying debt obligation" and the consumer "is not currently delinquent or in default" ((b)(3)).

**Flood** (12 CFR 22.5 and parallels; current as of Sept. 3, 2026): regulated lending institutions must escrow flood premiums for designated loans made/increased/extended/renewed on/after Jan 1, 2016 (exceptions listed in 3.7) — the flood line cannot be waived on such loans; the servicer acts for the lender. 42 U.S.C. 4012a(d) is the statutory basis **[statute text not fetched today; rule text verified]**.

**Reg X**: an account established after settlement triggers the (g)(2) initial statement within 45 days (3.1); a closed account triggers a short-year statement within 60 days ((i)(4)) and disposition of the balance.

**State borrower rights (verified today)**: Illinois 765 ILCS 910/5 — the borrower may terminate escrow "when the mortgage is reduced to 65% of its original amount by payments of the borrower, timely made" and is "not in default"; not for loans "insured, guaranteed, supplemented, or assisted by the State of Illinois or the federal government"; HPMLs follow 12 CFR 1026; §6 allows a pledged interest-bearing time deposit alternative. Minnesota §47.20 subd. 9 — after the fifth anniversary (effective 1998) the mortgagor may elect in writing to discontinue escrow "unless the mortgagor has been more than 30 days delinquent in the previous 12 months"; the mortgagee "shall notify the mortgagor within 60 days after the … anniversary" of the right; conventional loans > 80% LTV are exempt from the interest rule (not from the discontinuance right — **[UNVERIFIED whether the 80% exemption also limits the discontinuance right]**). Utah 7-17-4 — borrower election of a non-interest-bearing account/self-payment with written notice at closing (origination-side). Wisconsin 138.052(5m) — borrower-directed tax payment options (3.7). Other states **[UNVERIFIED — 50-state survey]**.

**Discrepancies with the blueprint row**: the row reduces the process to a "waiver flag"; the verified rules require a decision engine with four Fannie Mae denial tests, an HPML gate, a flood gate, an MI-line carve-out, revocation triggers, state termination rights that can override Fannie Mae's denial conditions (open question 1), and statement/refund consequences.

### Operational prerequisites
- Boarding data: `hpml_flag`, `consummation_date`, `original_property_value_cents` (Reg Z "original value"), `original_appraised_value_cents` (Fannie Mae test), `original_loan_amount_cents` (IL 65% test), `flood_escrow_mandatory`, `mi_premium_frequency`, prior modification/waiver history, government-insured flag — Section 1.1.
- Payment-history projection supporting 12/24-month delinquency look-backs (`regx_days_delinquent` daily history retained ≥ 24 months).
- Templates `NTC_SM_ESCROW_WAIVER_DECISION` (approve/deny with reasons), `NTC_SM_ESCROW_WAIVER_REVOCATION`, `NTC_MN_47_20_9_DISCONTINUE_RIGHT`; counsel review.
- `jurisdiction_rules.escrow_waiver` populated for IL, MN, UT, WI; survey for the rest — licensing program.

### Build spec
#### Inputs and triggers
- Borrower request (`contacts` any mode; portal form) → `case_type='escrow_waiver'` (new case type; add to the baseline enum) — the agent must not solicit.
- `escrow.advance.posted` on a waived loan (3.7) → revocation.
- `lossmit.trial_plan.offer_prepared` (Flex Mod) / `lossmit.deferral.approved` → establishment evaluation.
- Anniversary jobs: MN 5th-anniversary notice; IL/MN eligibility flags recomputed monthly.
- `loan.boarded` with `escrow_waived=true` → validate waiver evidence and mandatory-escrow gates (HPML/flood/MI).

#### Data model
- `escrow_waivers` (new): `id`, `loan_id`, `scope` ∈ {full, partial}, `waived_line_types text[]`, `origin` ∈ {origination, borrower_request, state_right, transfer_in}, `requested_at`, `decided_at`, `decision` ∈ {approved, denied, not_applicable}, `denial_reasons text[]` (codes: PRIOR_MOD_OR_WAIVER_MISSED, DELINQ_12M, DELINQ_60D_24M, LTV_GE_80_ORIG_APPRAISED, HPML_LT_5Y, HPML_LTV_GE_80_ORIG_VALUE, HPML_DELINQUENT, FLOOD_MANDATORY, MI_MONTHLY, INSTRUMENT_PROHIBITS, OTHER), `state_right_applied text null`, `effective_date`, `revoked_at`, `revocation_reason` ∈ {tax_or_insurance_unpaid, modification_trial, deferral, borrower_request, transfer}, `basis_document_id` (decision worksheet), `notice_ids`.
- `escrow_accounts.status` gains `waived`; `loan_terms.escrow_payment_cents = 0` while waived; `escrow_lines` retained with `active=false` for monitoring.
- `cases.case_type` adds `escrow_waiver`.
- Retention `life_of_loan_plus_4y` (Fannie Mae "basis for the waiver decision"); PII minimal.

#### State machine
`escrowed` → (`request received`) `evaluating` → `approved` → `waived` (account closed: final short-year statement, balance refunded/credited, event balance 0) | `denied` (notice with reasons) → `escrowed`. `waived` → (`revocation trigger`) `revoking` → `escrowed` (account established: initial statement within 45 days; lines re-activated; analysis run; Setup event). `waived` → `partial` when only some lines are waived (MI monthly/flood mandatory lines remain escrowed). Transfer-in of a waived loan: `validate` → `waived` or `escrowed` (if a mandatory gate fails, establish and notify). Actors: `escrow` agent; state jobs; loss-mit events.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `ESC_WAIVER_DECISION_SLA_10BD` | deadline (policy) | `escrow_waiver` case opened | request date | 10 business_days_servicer | `escrow.waiver.decided` | sev-3 |
| `REGZ_1026_35B3_HPML_ESCROW_5Y_GATE` | not_before_gate | waiver evaluation on `hpml_flag=true` | `consummation_date` | 5 years (months=60) | — | approval refused with reason HPML_LT_5Y |
| `REGZ_1026_35B3_HPML_LTV_GATE` | not_before_gate | same | — | UPB < 80% of original value and not delinquent | — | refused |
| `FLOOD_12CFR22_5_ESCROW_GATE` | not_before_gate | waiver evaluation with `flood_escrow_mandatory=true` and a flood line | — | — | — | flood line cannot be waived (partial waiver only) |
| `FNMA_B101_MI_MONTHLY_ESCROW_GATE` | not_before_gate | waiver evaluation with monthly borrower-paid MI | — | — | — | MI line cannot be waived |
| `FNMA_B101_WAIVER_REVOKE_ON_ADVANCE_0` | deadline | `escrow.advance.posted` on a waived loan | advance date | 0 calendar_days (same day) | `escrow.waiver.revoked` + `escrow.account.established` | sev-2 |
| `FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE` | not_before_gate | `lossmit.trial_plan.offer_prepared` | — | escrow established (or exception documented: current on T&I + Flex Mod) | `escrow.account.established` or `escrow.waiver.exception_documented` | trial offer command refused |
| `REGX_1024_17G_INITIAL_STMT_45` | (3.1 owns; §1024.17(g)(2) branch of the same timer — one code for the rule, not a separate `..._17G2_...` code) | `escrow.account.established` | establishment date | 45 calendar_days | initial statement sent | sev-2 |
| `REGX_1024_17I4_SHORT_YEAR_RESET_60` | (3.3) | `escrow.account.closed` (waiver approved) | closure date | 60 calendar_days | short-year statement sent | sev-2 |
| `ESC_WAIVER_REFUND_30` | deadline (policy, mirrors (f)(2)) | `escrow.account.closed` | closure date | 30 calendar_days | refund issued / credited | sev-3 |
| `STATE_MN_47_20_DISCONTINUE_NOTICE_60` | deadline (jurisdiction MN) | 5th anniversary of the mortgage date | anniversary | 60 calendar_days | `NTC_MN_47_20_9_DISCONTINUE_RIGHT` sent | sev-3 |
| `STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE` | not_before_gate (jurisdiction IL) | borrower termination election | — | balance ≤ 65% of original amount by timely payments, not in default, not gov-insured, HPML rules satisfied | approval | must approve when open (see open question 1) |

#### Business rules and calculations
1. **Evaluation order** (all must pass unless a state right overrides per open question 1): (a) instrument permits waiver (uniform instrument: lender may waive in writing); (b) no `flood_escrow_mandatory` flood line (else partial only); (c) no monthly MI line (else partial only); (d) HPML: `today ≥ consummation_date + 5 years` AND `upb < 0.80 × original_property_value` AND `regx_days_delinquent = 0` and no default; (e) Fannie Mae tests: no prior modification and no prior waiver with missed payments; no delinquency (any `regx_days_delinquent > 0` at a due date — policy interpretation: any payment received after its due date's grace? **Default: any payment 30+ days late counts as "delinquency"; any late payment beyond the contractual grace period is flagged for the agent to apply the stricter reading** — open question 2) in the prior 12 months; no 60+ day delinquency in the prior 24 months; `upb < 0.80 × original_appraised_value` (≥ 80% → deny); (f) state right check (IL/MN) may compel approval.
2. **Effective date** = the next payment due date ≥ 15 days after approval; the escrow account closes; the balance (after paying bills due within 30 days, which are paid before closure) is refunded within 30 days or, at the borrower's request, applied to principal (curtailment per Section 2.4); short-year statement within 60 days; escrow event: disbursement to balance 0.
3. **Denial**: decision notice with all failed reasons (plain language), the earliest date the borrower may re-request (e.g., HPML 5-year date; 12/24-month delinquency windows), and the Fannie Mae basis retained.
4. **Partial waivers**: allowed for taxes/hazard when MI (monthly) or flood (mandatory) must stay escrowed; the analysis engine runs on the remaining lines.
5. **Revocation**: on any advance for an unpaid tax/insurance/HOA on a waived loan → same-day revocation, account established with the advance as the opening deficiency, interim analysis, initial statement within 45 days, deficiency spread per 3.6 (12 months default; NH ≥ 12 at 0%), Setup event; before a modification trial → establish unless the Flex Mod exception is documented (current on T&I); deferral → establish unless current on T&I.
6. **Monitoring while waived**: tax/insurance/MI/HOA monitoring continues (3.7 rule 10; Sections 9–10); the tax service contract covers non-escrowed parcels.
7. **Fees**: none charged for waivers or revocations (policy; CA 2954.8(b) and RI 19-9-2 fee limits; B-1-01 silent).
8. **Transfer-in**: a waived loan boards as `waived` only with evidence of a written waiver and passing mandatory gates; otherwise establish and notify.

Worked example: request 2027-03-02 on a loan with UPB $240,000, original appraised value $310,000 (77.4% < 80% ✓), HPML with consummation 2021-06-15 (5 years elapsed ✓; original property value $300,000 → 80.0% ✗ because $240,000 is not < $240,000) → **denied** (HPML_LTV_GE_80_ORIG_VALUE); re-request possible after the UPB falls below $240,000.00 — at $239,900 (77.4% Fannie test ✓, HPML 79.97% ✓), no late payments in 24 months ✓, no prior mod ✓, MI is annual-paid (waivable), no flood → approved; effective 2027-05-01; balance $1,206.68 less the April county installment paid before closure → refund within 30 days; short-year statement by 2027-06-30. Revocation example: waived loan, county tax $2,400 unpaid at the penalty date 2027-12-10 → advance $2,400 + $120 penalty (reimbursable under F-1-05 as the first set of penalties on a non-escrowed loan if the loan later becomes delinquent; otherwise the borrower repays) → account established 2027-12-11 with balance −$2,520; interim analysis; deficiency 12 × $210.00; initial statement by 2028-01-25.

#### Integrations
- Tax service (non-escrowed delinquency monitoring); insurance tracker; MI adapters; Sections 12 (trial offers, deferral), 2.4 (principal application of refunded balances), 16 (payoffs); Fannie Mae escrow events (Setup on establishment; disbursement to 0 on closure); SMDU escrow indicators for workouts (Section 12).

#### Outputs and artifacts
- Notices: `NTC_SM_ESCROW_WAIVER_DECISION` (approve/deny; reasons; re-request date; basis B-1-01/1026.35(b)/22.5), `NTC_SM_ESCROW_WAIVER_REVOCATION` (reason, new escrow payment, initial statement to follow), `NTC_MN_47_20_9_DISCONTINUE_RIGHT` (Minn. Stat. 47.20 subd. 9), `NTC_REGX_1024_17G_INITIAL_ESCROW_STMT` / `NTC_REGX_1024_17I4_SHORT_YEAR_RESET` (3.1/3.3 — the waiver-reset variant). Channel: E-SIGN or mail.
- `escrow_waivers` row with basis worksheet document; `loan_events`: `escrow.waiver.requested/decided/effective/revoked`, `escrow.account.established/closed`; ledger refund entries; investor events.

#### AI agent design (AI-first)
- Agent: `escrow` (decision) with `borrower-comms` (intake; must not solicit — scripts include no waiver prompts). Tools: `evaluateWaiver` (deterministic rule engine), `approveWaiver`, `denyWaiver(reasons)`, `revokeWaiver(reason)`, `establishEscrowAccount`, `issueRefund`, `sendNotice`, `escalate`.
- Decision record: {case id, all rule inputs (UPB, values, dates, delinquency history summary), gate results, state-right evaluation, decision, notice ids, rationale}.
- Guardrails: rule outcomes are binding; the agent cannot approve when a gate fails; adverse decisions are not ECOA adverse actions (policy view — open question 3) but a written decision with reasons is always sent; Colorado AI Act: an escrow waiver denial is arguably a "consequential decision" in lending — provide the notice, explanation, and human-review path (`human_agent` review on request) — LL-2026-04 governance applies. Escalations: `human_agent` on request; `licensed_specialist` not required; counsel review when a state right conflicts with Fannie Mae denial tests (open question 1).
- AI-off path: ops-console waiver queue with the same engine.

#### Edge cases and failure modes
- Government-insured loans: out of scope (conventional only), but IL/MN rules exclude them.
- Loan modified previously → permanent Fannie Mae denial reason (prior modification) even if current.
- Borrower requests partial waiver of hazard only → allowed if all tests pass; taxes remain.
- Waiver approved then payoff/transfer within 30 days → refund at payoff (1024.34(b)); transfer carries waiver evidence.
- Revocation while the borrower is in bankruptcy → post-petition escrow establishment is permitted for lien protection; payment change via 3002.1 (Section 14.2).
- Flood map change makes flood insurance newly required on a waived loan subject to 22.5 → escrow the flood line (partial establishment) and 45-day initial statement.
- Successor in interest requesting waiver → evaluate as borrower (4.4).
- Disaster forbearance with waiver: T&I unpaid during forbearance → advance/revoke rules still apply; consider hardship in outreach, not in the rule.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.8-T1 | Given the worked-example loan at UPB $240,000 (HPML), then decision = denied with reason HPML_LTV_GE_80_ORIG_VALUE and a re-request date. |
| 3.8-T2 | Given UPB $239,900, no lates in 24 months, no prior mod, annual MI, no flood, then approved; effective next due date ≥ 15 days; refund within 30 days; short-year statement within 60 days; escrow event to balance 0. |
| 3.8-T3 | Given one 30-day delinquency 8 months ago, then denied DELINQ_12M; given a 60-day delinquency 20 months ago, then denied DELINQ_60D_24M. |
| 3.8-T4 | Given monthly borrower-paid MI, then the MI line is excluded from the waiver and the decision is partial. |
| 3.8-T5 | Given `flood_escrow_mandatory=true`, then the flood line cannot be waived. |
| 3.8-T6 | Given an advance for unpaid taxes on a waived loan on 2027-12-11, then the waiver is revoked the same day, the account is established with the deficiency, and the initial statement timer is due 2028-01-25. |
| 3.8-T7 | Given a Flex Mod trial offer being prepared for a waived loan current on T&I, then the exception is documented and the offer proceeds; given T&I delinquent, then the offer is blocked until escrow is established. |
| 3.8-T8 | Given a Minnesota loan reaching its 5th anniversary, then the right-to-discontinue notice is sent within 60 days; a written election with no >30-day delinquency in 12 months is approved even if the Fannie Mae 80% test fails (per open question 1 default). |
| 3.8-T9 | Given an Illinois loan at 64% of original amount by timely payments and not in default, then the termination election is approved. |
| 3.8-T10 | Given any outbound script, then a content test confirms no waiver solicitation language. |

#### Audit and evidence
Decision worksheets with rule inputs and versions, notices, borrower election documents, revocation evidence (advance record), analysis and statements, `agent_decisions`, and the Fannie Mae-required "basis for the waiver decision."

### Open questions / decisions
1. State termination rights (IL/MN) vs. Fannie Mae mandatory denial tests. **Default: honor the state right, document the conflict, and notify the partner** (B-1-01 conditions evaluation "under … applicable law"); obtain counsel confirmation before go-live in IL/MN.
2. Definition of "any delinquency" for the 12-month test. **Default: any payment received 30+ days after its due date; late-but-within-grace payments flagged for agent judgment.**
3. Treat waiver denials as ECOA adverse actions? **Default: no**, but always send a reasoned decision notice.
4. Allow refunded escrow balances to be applied to principal on request? **Default: yes.**

### Sources
- Fannie Mae B-1-01: https://servicing-guide.fanniemae.com/svc/b-1-01/administering-escrow-account-and-paying-expenses ; D2-3.2-06: https://servicing-guide.fanniemae.com/svc/d2-3.2-06/fannie-mae-flex-modification
- 12 CFR 1026.35(b): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-E/section-1026.35
- 12 CFR 22.5: https://www.ecfr.gov/current/title-12/chapter-I/part-22/section-22.5
- 765 ILCS 910 (Justia): https://law.justia.com/codes/illinois/chapter-765/act-765-ilcs-910/
- Minn. Stat. 47.20: https://www.revisor.mn.gov/statutes/cite/47.20
- Utah Code 7-17-4 (chapter PDF): https://le.utah.gov/xcode/Title7/Chapter17/C7-17_1800010118000101.pdf
- Wis. Stat. 138.052(5m) (Justia): https://law.justia.com/codes/wisconsin/chapter-138/section-138-052/
