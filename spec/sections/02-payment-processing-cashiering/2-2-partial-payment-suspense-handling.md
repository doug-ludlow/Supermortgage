# 2.2 — Partial payment / suspense handling

| Attribute | Value |
|---|---|
| Section | 2 — Payment Processing & Cashiering |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | On short payment |
| Governing source | Reg X 1024.34; FNMA C-1.1-02 |
| Key deadlines | Apply when suspense ≥ one full periodic payment |
| Timers | `FNMA_C1102_50_RULE_COUNT_12M`, `FNMA_C1102_PARTIAL_BALANCE_30`, `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD`, `REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE`, `SM_PARTIAL_COMMITMENT_CAPTURE_2BD`, `SM_SUSPENSE_REEVAL_ON_TERMS_CHANGE_0` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Cashiering |
| Trigger & frequency | On short payment |
| Governing source (blueprint) | Reg X 1024.34; FNMA C-1.1-02 |
| Key deadlines (blueprint) | Apply when suspense ≥ one full periodic payment |
| Data/artifacts | Suspense ledger |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Fannie Mae C-1.1-02, Processing Payment Shortages or Funds Received When a Mortgage Loan Modification Is Pending (effective 08/13/2025; Guide edition Aug. 12, 2026).** Operative language (URL: https://servicing-guide.fanniemae.com/svc/c-1.1-02/processing-payment-shortages-or-funds-received-when-mortgage-loan-modification-pending, verified 2026-09-09):
- "The servicer must accept and apply any borrower payment that includes the full amount for principal, interest, taxes, and insurance." "The servicer must accept and apply these funds even though the amount excludes any applicable late charges, if permitted by applicable law and to the extent that acceptance would not jeopardize the servicer's position in legal proceedings, such as foreclosure."
- Military indulgence: "the servicer must waive the collection of late charges during the period for which the reduced interest rate remains in effect" (2.7).
- **$50 rule:** "For an escrowed first lien mortgage loan with an instrument dated March 1999 or later, if the borrower's payment is deficient by $50 or less, the servicer is authorized to apply the payment by reducing the amount credited to the escrow account, apply the partial payment as 'unapplied funds' in a T&I custodial account, or return the partial payment to the borrower." "The servicer must only accept a partial payment that is deficient by $50 or less for up to three monthly mortgage loan payments during a 12-month period."
- **Four-condition rule:** "With the exception of those partial payments applied as noted above, the servicer of a first lien mortgage loan—and second lien mortgage loan, provided the first lien mortgage loan is current—must accept a partial payment and hold it as 'unapplied funds' in a T&I custodial account if all of the requirements in the following table are met": the borrower "has a commitment toward repayment of the mortgage loan obligation," "is not habitually delinquent," "does not have a history of remitting checks that are returned for insufficient funds," and "commits to paying the balance of the payment within the next 30 days." Otherwise "the servicer is authorized to return the partial payment to the borrower." "When the total of the reduced payments held as unapplied funds is equal to a full PITI payment, the servicer must apply all full payments to the mortgage loan." The topic is silent on what happens when the balance is not paid within 30 days (6.5's default: return).
- Trial-period funds: see 2.6.

**Reg Z 12 CFR 1026.36(c)(1)(ii) (eCFR current as of 2026-09-04):** "Any servicer that retains a partial payment, meaning any payment less than a periodic payment, in a suspense or unapplied funds account shall: (A) Disclose to the consumer the total amount of funds held in such suspense or unapplied funds account on the periodic statement as required by § 1026.41(d)(3) …; and (B) On accumulation of sufficient funds to cover a periodic payment in any suspense or unapplied funds account, treat such funds as a periodic payment received in accordance with paragraph (c)(1)(i)." Comment 36(c)(1)(ii)-1: the servicer "may take any of the following actions: i. Credit the partial payment upon receipt. ii. Return the partial payment to the consumer. iii. Hold the payment in a suspense or unapplied funds account." Comment -2: "When sufficient funds accumulate to cover a periodic payment … they must be treated as a periodic payment received in accordance with § 1026.36(c)(1)(i)." Reg Z 1026.41(d)(3) (statement shows "the amount, if any, sent to any suspense or unapplied funds account") and (d)(5): "If a statement reflects a partial payment that was placed in a suspense or unapplied funds account, information explaining what must be done for the funds to be applied" (7.1 renders; this process supplies the data). Reg X 1024.35(b)(2)–(3) errors apply to misapplied or late-credited partials (4.1).

**Fannie Mae custodial layer (A4-1-02, 07/12/2023; A4-1-01, 02/12/2025):** unapplied funds must sit in a T&I custodial account (optionally a dedicated one) and be actively monitored, researched, and returned "in a timely manner" — verified in Section 6.5, which owns aging, return and escheat.

**Discrepancies with the blueprint row.** (a) **Reg X 1024.34 is the wrong citation** — its title is "Timely escrow payments and treatment of escrow account balances" (eCFR verified 2026-09-09) and it contains nothing on partial payments; the federal rules are Reg Z 1026.36(c)(1)(ii) and 1026.41(d)(3)/(d)(5), with Reg X 1024.35(b) supplying the error-resolution hook. (b) "Apply when suspense ≥ one full periodic payment" is the Reg Z trigger but the crediting date matters as much: the accumulated funds are a periodic payment "received" on the accumulation date, and late-charge/credit-reporting logic must use that date. (c) The blueprint omits the Fannie Mae four-condition acceptance test, the 30-day commitment, the $50/three-per-12-months rule, and the requirement that first-lien status be current for second-lien partials (irrelevant here: first liens only). (d) Systems: the T&I custodial `ti_unapplied` account, the borrower-comms channel (commitments) and the statement engine are all involved, not just "Core."

### Operational prerequisites
- `ti_unapplied` custodial account with Form 1014 In Effect (6.2) and the `custodial_ti_unapplied_cash` ledger account.
- Written unapplied-funds policy approved by the `officer` (6.5) including the partial-payment acceptance matrix below and the return rails.
- Statement template (7.1) with the (d)(3)/(d)(5) suspense blocks wired to the `suspense_items` read model; `SUSP-PARTIAL-HOLD-v1`/`SUSP-PARTIAL-RETURN-v1` notices registered (6.5).
- Borrower-comms scripts for capturing a repayment commitment (voice/chat/SMS/email) with AI disclosure and TCPA consent checks; `contacts.commitment_captured` schema.
- Boarding data: instrument date (for the $50 rule), escrow flag, NSF history and delinquency history for the "habitually delinquent" test (inherited pay history from 1.6).

### Build spec
#### Inputs and triggers
- `payment.received` with allocation result `n = 0` (amount < P after adding any open unapplied balance) — the partial-payment path; or `n ≥ 1` with remainder R > 0 and no curtailment designation — the remainder path.
- `suspense.item.created` (6.5's row for every held amount; this process is the creator for partial/remainder/trial holds).
- `contact.completed{intent=partial_commitment}` from `borrower-comms`; coupon-box notes OCR'd from lockbox images.
- `suspense.accumulation.sufficient` (computed in the same transaction as any receipt: Σ open unapplied on the loan ≥ P).
- Timers `FNMA_C1102_PARTIAL_BALANCE_30` expiry (6.5), `payment_holds` releases (case events), `loan_terms` changes that alter P (a payment change can make an existing balance sufficient — re-evaluate on `loan_terms.activated`).

#### Data model
Reuses `suspense_items` exactly as fixed in 6.5 (fields `reason_code`, `partial_commitment_due_on`, `partial_count_12m`, `credited_as_of`, `status`) and `suspense_actions`. Additions owned here:
- `suspense_items.reason_code` values used by cashiering: `partial_payment`, `partial_payment_50_rule` (applied, not held — recorded for the 3-in-12 counter), `remainder_under_p` (overage below one periodic payment on a current loan), `prepaid_pending` (remainder ≥ P awaiting borrower instruction only when the loan is paid ahead by policy limit), `biweekly_accumulation` (2.5), `pending_modification_hold` (2.6), `bankruptcy_hold`, `foreclosure_hold`, `dispute_hold`.
- `partial_payment_evaluations` (new, append-only): `payment_id`, `loan_id`, `shortfall_cents`, `rule_path` ∈ {fifty_rule_escrow, hold_four_conditions, hold_policy_override, return, apply_forbearance_plan, apply_trial}, `condition_commitment`, `condition_not_habitual`, `condition_no_nsf_history`, `condition_30day_commitment`, `evidence_refs[]`, `decision_id`, `decided_at`.
- `loan_terms.instrument_date` (date) and `loan_terms.escrowed` (bool) — from 1.1.
- Counters (materialized): `partial_count_12m` (rolling count of `fifty_rule_escrow` applications), `late_30_count_12m`, `nsf_count_12m` (from `payment_reversals{reason=returned_item}`).
Retention `life_of_loan_plus_4y`; PII limited to payer fields already encrypted in `payments`.

#### State machine
Partial-payment item (`suspense_items` with `reason_code=partial_payment`): `open` → (`suspense.accumulation.sufficient`) `applied` — funds treated as a periodic payment received on the accumulation date; `open` → (30-day commitment lapses without accumulation) `returned` (default) or `applied_to_oldest` only where a workout case owner directs; `open` → `contact_pending` (four-condition test needs the commitment) → `open`/`returned`; `open` → `transferred` (transfer-out); `open` → `refunded` (borrower asks for the funds back — always honored unless a hold applies). `$50-rule` payments never create a held item: the payment is `applied_with_50_rule` and the counter increments. Actors: `cashiering` agent (decisions), `custodial-recon` (aging/return/escheat per 6.5), `borrower-comms` (commitment capture), `human_agent` on request.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` | (defined in 6.5; enforced here) | `suspense.accumulation.sufficient` | accumulation date | 1 `business_days_servicer`; `credited_as_of` = accumulation date | `payment.applied` | `officer`, high |
| `FNMA_C1102_PARTIAL_BALANCE_30` | (6.5) | `suspense.item.created{partial_payment}` | `received_on` | 30 calendar days | `suspense.accumulation.sufficient` | return per policy (6.5) |
| `FNMA_C1102_50_RULE_COUNT_12M` | (6.5) gate | `payment.applied{allocation_outcome=applied_with_50_rule}` | rolling 12 months | max 3 | — | 4th short payment ≤ $50 is treated as an ordinary partial |
| `SM_PARTIAL_COMMITMENT_CAPTURE_2BD` | deadline (internal) | `suspense.item.created{partial_payment, condition_commitment=unknown}` | `received_on` | 2 `business_days_servicer` | `contact.completed{intent=partial_commitment}` or coupon note evidence | agent applies the policy default (hold — see rule 3) and logs |
| `REGZ_1026_41D5_STATEMENT_SUSPENSE_DISCLOSURE` | gate on 7.1 | statement generation | — | statement must include (d)(3) amount and (d)(5) instructions whenever Σ unapplied > 0 | template checklist | 7.1 blocks the statement |
| `SM_SUSPENSE_REEVAL_ON_TERMS_CHANGE_0` | rule | `loan_terms.activated` (P changes) | — | same transaction | accumulation re-evaluated | — |

Jurisdiction overrides: none specific; state escheat rules in 6.5.

#### Business rules and calculations
1. **Definitions.** P = periodic payment (2.1 rule 2). A receipt of amount `a` on a loan with open unapplied balance U is *partial* if `a + U < P` (after overlays). Shortfall `s = P − (a + U)`.
2. **$50 rule (deterministic, first).** If `s ≤ 5,000¢`, `loan_terms.escrowed = true`, `instrument_date ≥ 1999-03-01`, first lien, and `partial_count_12m < 3`: apply the payment as a full periodic payment with the escrow bucket reduced by `s` (interest and principal in full — the note's "Monthly Payment" is fully received, so no late charge under 2.7), record `allocation_outcome=applied_with_50_rule`, increment the counter, and flag the escrow account for the shortfall to surface at the next analysis (3.2). Default policy elects this path automatically (Fannie Mae "is authorized to"); a borrower may opt out in writing (then rule 3).
3. **Four-condition hold (C-1.1-02).** Otherwise evaluate: (i) commitment — any of: coupon/portal note, prior 12-month history of completing partials, active repayment/forbearance/trial case, or `contact.completed{intent=partial_commitment}`; (ii) not habitually delinquent — policy: fewer than three 30-day-late installments in the trailing 12 months (`late_30_count_12m < 3`); (iii) no NSF history — `nsf_count_12m = 0`; (iv) 30-day commitment — captured or presumed when (i) is a written note stating a date ≤ 30 days. If all four hold → hold in `ti_unapplied` with `partial_commitment_due_on = received_on + 30`. If (ii)/(iii) fail → "authorized to return": default policy still **holds** the funds for 30 days when the loan is ≤ 60 days delinquent and no foreclosure referral exists (returning money to a struggling borrower is UDAAP-exposed and rarely helps), records `rule_path=hold_policy_override`, and returns at day 30 if the balance is not completed; if the loan is referred to foreclosure (13.3) or in a state where accepting partials risks the foreclosure position (`jurisdiction_rules.partial_payment_fc_risk=true`), the item is `foreclosure_hold` and the foreclosure case owner decides (accept-and-apply vs return) within 2 BD.
4. **Accumulation.** On every receipt (and on any P change), compute Σ open `suspense_unapplied` on the loan. If Σ ≥ P: apply `floor(Σ / P)` periodic payments oldest-installment-first via the Allocation Engine, with `credited_as_of` = the `received_on` of the receipt that made the balance sufficient (Reg Z (c)(1)(ii)(B) → (c)(1)(i)); residual stays unapplied under `remainder_under_p` (or applies to fees/curtailment per 2.1 rule 5 if the borrower instructed). Late charge for the installment: decided by 2.7 using that `credited_as_of` — if it is after the grace end, the note's late charge stands (the installment was not received in full by the grace date).
5. **Never** deduct a late charge from a payment that otherwise covers PITI (C-1.1-02; Reg Z (c)(2)), never treat a PITI-only payment as partial because a late charge is outstanding, and never hold a full PITI payment because of an unpaid fee.
6. **Returns at day 30.** Return by the original rail (ACH credit to the originating account; check to the borrower's mailing address) with `SUSP-PARTIAL-RETURN-v1`, unless a workout case directs application (12.4/12.5/2.6). Funds returned are not "received" for any purpose; the installment remains unpaid.
7. **Postings.** Hold: Dr `clearing_cash`/`custodial_pi_cash` a / Cr `suspense_unapplied` a; then Dr `custodial_ti_unapplied_cash` a / Cr `clearing_cash` a (cash parked in T&I unapplied). Application: Dr `suspense_unapplied` P / Cr `interest_due`, `principal`, `escrow` (2.1 rule 8) and Dr `custodial_pi_cash` (P&I) & `custodial_ti_cash` (escrow) / Cr `custodial_ti_unapplied_cash` P. Return: Dr `suspense_unapplied` / Cr `custodial_ti_unapplied_cash`.
8. **Worked example C — short payment held, then completed.** Fixture L-1 (P = 219,257¢; installment due 2026-09-01; grace end 2026-09-16). 2026-09-10: lockbox check 200,000¢ ($2,000.00) with coupon note "rest by 9/25". s = 19,257¢ > 5,000¢ → not the $50 rule. Conditions: commitment (note), `late_30_count_12m = 0`, `nsf_count_12m = 0`, 30-day commitment (note date ≤ 30 days) → hold: `suspense_items{partial_payment, 200,000, received_on 2026-09-10, partial_commitment_due_on 2026-10-10}`; `SUSP-PARTIAL-HOLD-v1` sent; statement dated 2026-09-12 shows "$2,000.00 held in unapplied funds; send $192.57 to have the payment applied." 2026-09-17 00:30: 2.7 assesses the late charge for the 2026-09-01 installment: 5% × 158,017 = 7,900.85 → **7,901¢ ($79.01)** (full Monthly Payment not received by 2026-09-16). 2026-09-24: portal one-time ACH 19,257¢ submitted 14:02 ET → Σ = 219,257 ≥ P → apply one periodic payment with `credited_as_of` 2026-09-24: interest 135,294, principal 22,723, escrow 61,240; LPI → 2026-09-01; unapplied → 0; the late charge remains outstanding (the borrower did not include it); `payment.contractual` emitted with effective date 2026-09-24. On 2026-10-01 a 219,257¢ autodraft settles for the October installment on time → no new late charge (Reg Z (c)(2) — the only "delinquency" is the unpaid $79.01), and the October statement shows "late charge due $79.01."
9. **Worked example D — $50 rule.** Same loan, 2026-09-08 check 215,000¢ → s = 4,257¢ ≤ 5,000¢; escrowed; instrument 07/2021; `partial_count_12m = 1` → apply: interest 135,294, principal 22,723, escrow 61,240 − 4,257 = **56,983¢**; total 215,000 ✓; LPI 2026-09-01; counter → 2; no late charge; escrow ledger receives $569.83 (3.x sees the shortfall at analysis). A third occurrence in the same 12 months is still allowed; a fourth falls to rule 3.
10. **Overages below P on a current loan** (`remainder_under_p`): held; applied per instruction; refunded on request; if the loan becomes paid-ahead by ≥ P the funds apply as `payment.prepaid.applied`. Default: hold, and the next statement shows the unapplied amount and instructions (d)(5).

#### Integrations
- **Lockbox** (`lockbox`): coupon/check image OCR for handwritten commitments and instructions; the image is evidence for condition (i)/(iv).
- **ACH** (`nacha`): PPD credit returns of partials (6.5 executes); inbound completion payments identified by trace/originator account.
- **Borrower-comms** (voice/chat/SMS/email vendors via `borrower-comms`): outbound commitment capture within 2 BD, inbound instructions; AI disclosure and TCPA consent gating; `contacts` rows with `intent`.
- **Statements** (7.1): read model `statement_suspense_summary` (Σ unapplied, items since last statement, instruction text).
- **Fannie Mae**: no direct submission; the LL-2026-05 Loan Contractual Payment event carries `Loan Suspense Balance Amount` (Section 5.1 projection), so every hold/application updates the value reported on the next event; escrow events are unaffected (unapplied funds are not escrow deposits).
- **Custodial** (6.4/6.5): `custodial_ti_unapplied_cash` balance reconciles to Form 496A line 4; aging and Section III listing.

#### Outputs and artifacts
- Notices: `SUSP-PARTIAL-HOLD-v1` (amount held, balance needed, commitment date, how to send; citation C-1.1-02 and Reg Z 1026.41(d)(5); channel per E-SIGN consent, else mail), `SUSP-PARTIAL-RETURN-v1` (6.5), `SUSP-50RULE-APPLIED-v1` (short payment applied with escrow reduced by $X; informational; statement may carry it instead — decision 2.2-Q2).
- Ledger postings per rule 7; `loan_events`: `suspense.item.created`, `suspense.applied`, `payment.applied{allocation_outcome=applied_with_50_rule}`, `suspense.item.returned` (6.5), `payment.posted`; `partial_payment_evaluations` rows; `investor_events` only when a periodic payment is applied (suspense balance appears on the next event payload).
- Periodic statement data for (d)(3)/(d)(5).

#### AI agent design (AI-first)
`cashiering` agent decides the rule path per receipt using the deterministic matrix (rules 2–3) and handles the judgment items: interpreting free-text commitments, weighing habitual-delinquency edge cases, deciding hold-vs-return under the policy override, and drafting the borrower message. Tools: `suspense.read/write` (6.5), `payments.history`, `loan_terms.get`, `cases.get_overlays`, `lockbox.image_ocr`, `borrower_comms.request_contact`, `notice.send`, `ledger.apply_via_cashiering` (the Allocation Engine command — the agent never posts directly), `timer.*`, `escalation.create`. Decision record: `{payment_id, shortfall_cents, rule_path, conditions{…}, evidence_refs[], policy_override_reason?, credited_as_of_if_applied, confidence, rationale}`. Guardrails: cannot apply a partial to a single bucket (no "interest only" application) outside the $50 rule; cannot hold a full PITI payment; cannot return funds while a loss-mit case is active without the case owner; cannot bypass the accumulation rule (enforced in the ledger command); must send the hold notice within 1 BD of the hold. Escalations: `human_agent` on request; `officer` for returns > $10,000 to a non-borrower (6.5) and for any pattern flagged as check-kiting; foreclosure-state decisions go to the `foreclosure-ops` agent (not a human) unless counsel input is needed (`attorney` via 13.x). Human path when AI off: Suspense Queue in the ops console with the same matrix and validators.

#### Edge cases and failure modes
- **Transfer-in inherited partials**: keep the transferor's receipt date for aging; the 30-day commitment restarts from boarding (1.6/6.5 `SM_UNAPPLIED_INHERITED_REVIEW_60`).
- **Transfer-out**: open items wire with the loan; statement disclosure continues until cutover.
- **Bankruptcy**: partial post-petition payments are `bankruptcy_hold` and applied per plan (14.x); no return without case-owner rule.
- **Forbearance/repayment plan**: reduced plan payments are not partials — applied to the oldest due installment when ≥ P, otherwise held without the 30-day return clock (plan governs).
- **SCRA**: P is computed with the 6% cap installment (13.9); a payment that is short only because the borrower paid the capped amount is a full payment.
- **Two partials completing in one day**: apply once with `credited_as_of` = that day; residual stays.
- **Escrow-only payments** (designation `escrow_only`, e.g., shortage lump sum): not partials — 3.6 lump-sum path.
- **P changes upward mid-month** (escrow analysis effective date): accumulation test uses P effective for the installment being satisfied, not today's P.
- **Duplicate partial (borrower resends the same check image)**: idempotency by MICR+amount+date; a true second check is a second receipt.
- **Return fails** (closed account/undeliverable): 6.5 escalation/escheat track.
- **Statement suppression (bankruptcy 14.3, charge-off)**: the (d)(3)/(d)(5) disclosure follows the statement rules; the hold notice still goes.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 2.2-T1 | Given L-1 with no unapplied funds, when 200,000¢ arrives 2026-09-10 with a written commitment, then a `partial_payment` item is created with due 2026-10-10, funds land in `custodial_ti_unapplied_cash`, and `SUSP-PARTIAL-HOLD-v1` is sent within 1 BD. |
| 2.2-T2 | Given 2.2-T1, when 19,257¢ arrives 2026-09-24, then one periodic payment is applied with `credited_as_of` 2026-09-24, unapplied = 0, and the late charge assessed on 2026-09-17 remains. |
| 2.2-T3 | Given 215,000¢ on an escrowed 07/2021 instrument with counter 2, when posted, then escrow receives 56,983¢, LPI advances, no late charge, counter = 3; a fourth ≤$50 short payment within 12 months is held as an ordinary partial. |
| 2.2-T4 | Given a non-escrowed loan, when a payment short by 3,000¢ arrives, then the $50 rule is not available and the four-condition path runs. |
| 2.2-T5 | Given `nsf_count_12m = 1` and a loan 45 days delinquent with no referral, when a partial arrives, then `rule_path=hold_policy_override` with a 30-day return, and the decision record cites C-1.1-02's "authorized to return." |
| 2.2-T6 | Given a referred foreclosure and `partial_payment_fc_risk=true`, when a partial arrives, then the item is `foreclosure_hold` and the foreclosure case owner's decision is recorded within 2 BD. |
| 2.2-T7 | Given the 30-day commitment lapses, when the sweep runs on day 31, then the funds return by the original rail and `SUSP-PARTIAL-RETURN-v1` is sent; the installment stays unpaid. |
| 2.2-T8 | Given an open unapplied balance of 100,000¢ and P falling from 219,257¢ to 99,000¢ on `loan_terms.activated`, when re-evaluated, then a periodic payment is applied with `credited_as_of` = activation date. |
| 2.2-T9 | Given a PITI payment arrives while a $79.01 late charge is outstanding, when allocated, then the payment is applied in full, nothing is diverted to the late charge, and no new late charge accrues. |
| 2.2-T10 | Given any period end with Σ unapplied > 0, when 7.1 renders the statement, then the (d)(3) amount and (d)(5) instruction text are present (template checklist passes). |
| 2.2-T11 | Given the same check image resubmitted, when ingested, then the second item is rejected as a duplicate and an exception is logged. |

#### Audit and evidence
`partial_payment_evaluations` (conditions and evidence), `suspense_items`/`suspense_actions` history (6.5), the accumulation computation (Σ, P, `credited_as_of`), notices with delivery proof, statement snapshots showing (d)(3)/(d)(5), timer history for the 30-day and accumulation timers, and `agent_decisions`. This record set is the defense for 1024.35(b)(2)/(b)(3) assertions and for Fannie Mae A4-1-01 unapplied-funds procedures during MORA.

### Open questions / decisions
1. **Automatic $50-rule application** — default: on for escrowed loans (borrower-favorable; avoids late charges); opt-out flag per loan.
2. **Notice vs statement for $50-rule application** — default: statement line item only (no separate letter), because the statement already itemizes escrow applied.
3. **Policy override when conditions (ii)/(iii) fail** — default: hold 30 days for loans ≤ 60 days delinquent and not referred; otherwise route to the foreclosure case owner.
4. **"Habitually delinquent" threshold** — default: ≥ 3 × 30-day late in trailing 12 months; partner may tighten.
5. **Overage handling** — default: hold overages < P as `remainder_under_p`; apply to principal only on instruction (some servicers auto-curtail; UDAAP-safer to ask).

### Sources
- C-1.1-02 (08/13/2025): https://servicing-guide.fanniemae.com/svc/c-1.1-02/processing-payment-shortages-or-funds-received-when-mortgage-loan-modification-pending (verified 2026-09-09)
- 12 CFR 1026.36(c)(1)(ii) and Official Interpretations (see 2.1 Sources); 12 CFR 1026.41(d)(3)/(d)(5): https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-E/section-1026.41 (verified 2026-09-09)
- 12 CFR 1024.34 (title verified — not a partial-payment rule): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.34 ; 1024.35(b): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.35
- A4-1-02 / A4-1-01 / F-1-03 as verified in Section 6.5; Section 6.5 data model and timers
