# 2.5 — Biweekly third-party payments

| Attribute | Value |
|---|---|
| Section | 2 — Payment Processing & Cashiering |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | If applicable |
| Governing source | FNMA C-1.1-04 |
| Key deadlines | Per contract |
| Timers | `FNMA_C1104_ACCEPT_CONTRACTOR_PAYMENT_GATE`, `NOTE_BIWEEKLY_INTEREST_14D_RULE`, `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD`, `SM_BIWEEKLY_HALF_STALE_45`, `SM_CONTRACTOR_DORMANT_60`, `SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Cashiering |
| Trigger & frequency | If applicable |
| Governing source (blueprint) | FNMA C-1.1-04 |
| Key deadlines (blueprint) | Per contract |
| Data/artifacts | Ledger |
| Systems | Payment contractor |
| Automation class (blueprint) | a |
| SoR / Sub | Sub |
| Nuances (blueprint) | (blank in source) |

### Verified requirement (as of 2026-09-09)

**Fannie Mae C-1.1-04, Accepting Biweekly Payments from Third-Party Payment Contractors (11/12/2014; Guide edition Aug. 12, 2026)** is one sentence: "If a borrower arranges with a third party to make biweekly payments, the servicer must accept payments made on time and in a sufficient amount." No related announcements. URL: https://servicing-guide.fanniemae.com/svc/c-1.1-04/accepting-biweekly-payments-third-party-payment-contractors (verified 2026-09-09). The Guide says nothing about accumulation, curtailment of the "extra" payment, contractor fees, borrower disclosures, or the servicer's own programs — all of that comes from the note, C-1.1-01/C-1.1-02 (payments applied as intended; partials held under the four-condition rule), C-1.2-01 (designated curtailments), Reg Z 1026.36(c) and UDAAP.

**Three different things called "biweekly."** (1) A **third-party biweekly payment program** (the C-1.1-04 case): a contractor debits the borrower every 14 days and remits to the servicer — usually one full monthly payment on or before the due date plus, once or twice a year, an extra amount designated as principal; the loan's note is an ordinary monthly note. (2) A **true biweekly mortgage loan** (note payable every 14 days): F-1-09 says to "calculate 14 days' interest on the UPB as of the LPI date"; Fannie Mae reports A/A biweekly loans as detailed-reporting loans (LAR 96 + LAR 97 per payment — Section 5.1) — expected to be rare in the boarded book and flagged at boarding (`loan_terms.payment_frequency='biweekly'`) **[PARTIALLY VERIFIED — biweekly note form and its late-charge terms not fetched]**. (3) An **in-house split-payment autodraft** (2.3 amount rules `split_1_15`/`every_14_days`): the servicer debits halves and applies them on the due date — no contractor, no fee.

**Reg Z 1026.36(c)(1)(ii)** governs cases (1) and (3) whenever the servicer receives less than a periodic payment: the half is a partial payment (hold, disclose on the statement, apply on accumulation as of the accumulation date — 2.2). Comment 36(c)(1)(i)-2 ties the method of crediting to the legal obligation — a monthly note stays monthly; the extra 13th payment reduces principal only when the borrower (or the contractor on the borrower's instruction) designates it (note §4; C-1.2-01). Contractor fees are the contractor's, disclosed by the contractor; Supermortgage must not represent that a third-party program is its own, must not receive referral compensation (UDAAP/state law; RESPA §8 exposure is remote because the program is not a settlement service **[UNVERIFIED]**), and must tell borrowers that an equivalent free option exists (case 3).

**Discrepancies with the blueprint row.** (a) "Per contract" is not a servicer deadline — the servicer is not party to the contractor agreement; the only clocks are the note's due date/grace and the Reg Z accumulation rule. (b) The row conflates the three "biweekly" cases; the build must distinguish them at boarding and enrollment. (c) "Systems: Payment contractor" — there is no standard contractor interface; funds arrive as ACH credits (CCD/CTX with addenda) or checks with remittance lists **[UNVERIFIED — contractor-specific]**.

### Operational prerequisites
- Boarding flag `payment_frequency` and any biweekly note terms (1.1); the detailed-reporting flag for true biweekly loans (5.1).
- `third_party_payment_arrangements` registry populated from transfer-in data and inbound contractor contacts; contractor identity verification (business name, ACH company ID, remittance format).
- In-house split-payment option built in 2.3 (amount rules) and disclosed on the portal as the free alternative.
- Written policy (officer-approved) that Supermortgage does not endorse, market or receive compensation from third-party biweekly programs.

### Build spec
#### Inputs and triggers
- `third_party.remittance.received` (ACH CCD/CTX credit with addenda, or check + list) identified to a contractor → one `payments` row per loan with `channel=third_party_contractor`, `payer_type=contractor`.
- `borrower.contractor_arrangement.reported` (borrower tells us; contractor letter); `contractor.file.received` (remittance detail file, contractor-specific).
- For true biweekly loans: the biweekly due-date schedule from `loan_terms`; for in-house split autodraft: 2.3 schedule events.
- `suspense.accumulation.sufficient` (2.2) for accumulated halves; due-date sweep for in-house halves.

#### Data model
- `third_party_payment_arrangements` (new): `id`, `loan_id`, `contractor_id` (→ `parties{kind=payment_contractor}`), `cadence` ∈ {biweekly_half, monthly_full_plus_extra, other}, `expected_amount_cents`, `expected_remit_day`, `extra_principal_designation_rule` ∈ {contractor_file, borrower_standing_instruction, none}, `remittance_format` (jsonb), `verified_at`, `status` ∈ {active, dormant, ended}, `notes`.
- `payments` rows as above; `suspense_items.reason_code='biweekly_accumulation'` (no 30-day return clock; see rules).
- `loan_terms.payment_frequency` ∈ {monthly, biweekly}; for biweekly notes: `biweekly_pi_cents`, `interest_days_per_period=14`, `due_dates` generator (every 14 days from the first due date).
Retention `life_of_loan_plus_4y`; contractor bank data encrypted.

#### State machine
Arrangement: `reported` → `verified` (first remittance matched to the contractor's company ID or a documented borrower confirmation) → `active` ⇄ `dormant` (no remittance for 60 days) → `ended` (borrower cancels/payoff/transfer). Half-payment item: `open(biweekly_accumulation)` → `applied` on accumulation (2.2 engine) — the 30-day return clock does **not** start while the arrangement is `active` and the loan is ≤ 30 days delinquent; if a half sits > 45 days without a match (contractor stopped), the item converts to `partial_payment` and 2.2/6.5 rules apply. Actors: `cashiering` agent; `borrower-comms` for arrangement confirmation.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_C1104_ACCEPT_CONTRACTOR_PAYMENT_GATE` | gate | `payment.received{channel=third_party_contractor}` | — | a conforming, sufficient, timely contractor payment must be accepted and posted like any other payment (never refused because the payer is a contractor) | `payment.posted` | validator prevents refusal; sev-3 |
| `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` | (6.5/2.2) | halves accumulate to P | accumulation date | 1 BD | `payment.applied` | `officer` |
| `SM_BIWEEKLY_HALF_STALE_45` | deadline | `suspense.item.created{biweekly_accumulation}` | `received_on` | 45 calendar days without accumulation | matched/applied | reclassify to `partial_payment` (30-day clock from reclassification) + borrower contact |
| `SM_INHOUSE_SPLIT_APPLY_ON_DUE_DATE_0` | rule | in-house split autodraft second half settles | due date (or last settlement) | same day | `payment.applied{credited_as_of ≤ grace end}` | — |
| `NOTE_BIWEEKLY_INTEREST_14D_RULE` | rule | true biweekly note installment | — | interest = UPB × rate × 14 ÷ 365? — see rule 5 (**[UNVERIFIED day-count]**) | — | — |
| `SM_CONTRACTOR_DORMANT_60` | deadline | last remittance | `received_on` | 60 calendar days | new remittance or `ended` | arrangement → `dormant`; borrower informed that autopay through the contractor appears to have stopped |

Jurisdiction overrides: none.

#### Business rules and calculations
1. **Identification.** Contractor remittances are matched by ACH company ID/addenda or remittance list to loans; each loan's amount becomes a `payments` row with the contractor's settlement date as `received_on`; the borrower is the beneficiary, the contractor the payer.
2. **Allocation.** Standard Allocation Engine: a full monthly amount is a periodic payment; a half is a partial held as `biweekly_accumulation`; on accumulation ≥ P, apply with `credited_as_of` = the completing receipt's date; an amount designated in the contractor file (or by a borrower standing instruction on file) as extra principal is a curtailment (2.4) after all due installments are satisfied.
3. **Late charges.** Determined solely by whether a full periodic payment was credited by the grace end (2.7): if the contractor's monthly remittance settles on the 20th, a late charge applies under the note — the contractor's timing is the borrower's risk and the borrower is told so in `THIRDPARTY-BIWEEKLY-INFO-v1`.
4. **In-house split autodraft (case 3).** Halves debited on the 1st and 15th (or every 14 days) sit in `suspense_unapplied` and are applied when Σ ≥ P, which for a 1st/15th split is on the 15th (before the 16th grace end) — the authorization text states this and that interest is not reduced by early halves; the annual extra from a 14-day cadence (26 halves = 13 payments) is applied as a curtailment only if the borrower designates it in the authorization (default: designated).
5. **True biweekly loans (case 2).** Installment interest = "14 days' interest on the UPB as of the LPI date" (F-1-09): the platform computes `round_half_up(UPB × rate × 14 ÷ 365)` **[UNVERIFIED — day-count basis for Fannie Mae biweekly notes; confirm against the biweekly note form and IRM detailed-reporting formulas before enabling]**; due dates every 14 days; LAR 96 + LAR 97 per payment with the payment effective date (5.1); the late-charge grace and basis from the note.
6. **No endorsement / no compensation.** No referral fees, no co-branding; borrower questions about a contractor's fees are answered factually with the free in-house alternative offered; the servicer never debits the borrower on a contractor's behalf.
7. **Worked example I.** Fixture L-1 borrower uses a contractor that debits 109,629¢ ($1,096.29) every 14 days and remits to Supermortgage 219,257¢ on the 28th of the prior month for the installment due the 1st, plus once a year an extra 219,257¢ designated "principal." Remittance 2026-09-28 (for 2026-10-01): A = 219,257 = P → prepaid installment 2026-10-01 applied `credited_as_of` 2026-09-28 (LPI → 2026-10-01; note: "applied as of its scheduled due date" for interest purposes — interest for October is unchanged). 2027-03-28 remittance 438,514¢ with addenda "PRIN 219257": installment 2027-04-01 applied, then curtailment 219,257¢ → `payment.curtailment.applied`. Alternative cadence: contractor sends halves on 2026-09-14 and 2026-09-28 (109,629 each) for 2026-10-01: first half held (`biweekly_accumulation`), second half → Σ 219,258 ≥ 219,257 → periodic payment applied `credited_as_of` 2026-09-28, residual 1¢ stays unapplied (`remainder_under_p`).

#### Integrations
- **Contractor remittances**: inbound ACH CCD/CTX credits with addenda (`nacha` adapter parses addenda records), or checks + remittance lists via lockbox (`lockbox` adapter with list OCR) **[contractor-specific — UNVERIFIED]**; no outbound interface; returns of contractor credits are rare (RDFI-side).
- **Borrower channels**: arrangement confirmation; standing instruction capture for extra-principal designation.
- **Fannie Mae**: normal payment/curtailment events (5.1); detailed reporting (LAR 96/97) for true biweekly loans.
- **Statements (7.1)**: partial/unapplied disclosure for halves; **credit reporting (8.1)** unaffected unless late.

#### Outputs and artifacts
- Notices: `THIRDPARTY-BIWEEKLY-INFO-v1` (acknowledges the arrangement; states that Supermortgage is not party to it, that halves are held until a full payment accumulates, that late charges follow the note, that the extra payment is applied to principal only when designated, and that a free in-house split option exists — plain language, UDAAP-reviewed), `SUSP-PARTIAL-HOLD-v1` variant for halves (statement-only by default).
- Records: `third_party_payment_arrangements`; `payments`/`suspense_items`; events `payment.received`, `suspense.item.created{biweekly_accumulation}`, `payment.applied`, `payment.prepaid.applied`, `payment.curtailment.applied`, `contractor.arrangement.*`.

#### AI agent design (AI-first)
`cashiering` agent identifies contractor remittances, resolves addenda ambiguities (which loan, which amount is extra principal), maintains arrangements, and drafts borrower communications; `borrower-comms` handles borrower questions with the required disclosures. Tools: `payments.read`, `nacha.parse_addenda`, `lockbox.image_ocr`, `arrangements.read/write`, `ledger.apply_via_cashiering`, `notice.send`, `borrower_comms.request_contact`. Decision record: `{remittance_id, loan_matches[{loan_id, amount, designation, evidence}], arrangement_action, rationale, confidence}`. Guardrails: never refuse a conforming contractor payment; never treat an undesignated extra as principal; never market or recommend a contractor; always mention the free in-house option when discussing programs. Escalations: `human_agent` on request; `officer` for suspected contractor fraud (funds diverted, mismatched remittances). Human path when AI off: Posting Queue.

#### Edge cases and failure modes
- **Contractor fails/absconds**: borrower's installment unpaid → late charge per note; the platform helps the borrower re-establish direct payment (in-house split autodraft) and documents the contact; no waiver obligation, but a one-time courtesy waiver is available under 2.7 policy.
- **Transfer-in**: existing arrangements inherited from the transferor's records; contractor must be told the new remittance address (hello notice 1.3 covers the borrower; the contractor is notified on first contact).
- **Transfer-out**: arrangement `ended`; contractor payments received after cutover forwarded (17.x).
- **Bankruptcy/forbearance/trial**: contractor payments follow the case overlays like any third-party payment.
- **True biweekly loan with a contractor**: halves match the biweekly schedule — apply each on receipt (each is a full biweekly periodic payment).
- **Addenda missing**: unidentified credit → 6.5 identification engine (contractor company ID narrows candidates).
- **Contractor remits after the grace end habitually**: borrower notified each time; the agent may suggest switching to the in-house option (no steering to paid products).

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 2.5-T1 | Given an active arrangement, when 219,257¢ arrives 2026-09-28 by CTX with the loan number in addenda, then the 2026-10-01 installment is applied as prepaid with `credited_as_of` 2026-09-28. |
| 2.5-T2 | Given halves of 109,629¢ on 09-14 and 09-28, when the second arrives, then a periodic payment is applied `credited_as_of` 2026-09-28 and 1¢ remains unapplied; the statement shows the hold and application. |
| 2.5-T3 | Given a remittance of 438,514¢ with "PRIN 219257" addenda, when posted, then one installment and one curtailment are applied in that order with two investor events. |
| 2.5-T4 | Given a contractor remittance settling 2026-10-20 for the 2026-10-01 installment, when 2.7 runs 2026-10-17, then a late charge is assessed and `THIRDPARTY-BIWEEKLY-INFO-v1` context is referenced in any borrower explanation. |
| 2.5-T5 | Given a half held 46 days with no second half, when the sweep runs, then the item is reclassified `partial_payment`, the 30-day clock starts, and the borrower is contacted. |
| 2.5-T6 | Given a true biweekly loan, when a biweekly payment posts, then interest uses the 14-day formula and LAR 96 + 97 (or the event equivalent) are emitted. |
| 2.5-T7 | Given a borrower asks the voice agent about a contractor's program, when answered, then the transcript shows the non-endorsement statement and the free in-house option. |

#### Audit and evidence
Arrangement records with verification evidence, addenda/remittance lists and images, allocation plans, accumulation computations, notices, decision records, and — for true biweekly loans — the interest day-count rule version and detailed-reporting events.

### Open questions / decisions
1. **Offer an in-house split-payment autodraft** — default: yes (free; halves on the 1st/15th applied on the 15th; optional 14-day cadence with the 13th payment designated as principal).
2. **Hold halves without the 30-day return clock** — default: yes while the arrangement is active and the loan ≤ 30 days delinquent (reclassify at 45 days).
3. **Biweekly-note interest day count** — default: 365-day basis for 14-day interest pending verification of the note form and IRM formula.

### Sources
- C-1.1-04 (11/12/2014): https://servicing-guide.fanniemae.com/svc/c-1.1-04/accepting-biweekly-payments-third-party-payment-contractors (verified 2026-09-09)
- F-1-09 (14 days' interest for biweekly loans): https://servicing-guide.fanniemae.com/svc/f-1-09/processing-mortgage-loan-payments-and-payoffs (verified 2026-09-09)
- 12 CFR 1026.36(c)(1)(ii) and comment 36(c)(1)(i)-2 (2.1 Sources); Section 5.1 (detailed reporting LAR 96/97 for A/A biweekly)
