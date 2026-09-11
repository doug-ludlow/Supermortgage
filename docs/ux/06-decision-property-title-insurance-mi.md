# 06 — The decision, the property, title, insurance, MI, and clear to close

Owner specs: O2.6 (application-status decisions), O4.2–O4.4 (findings, conditions, risk assessment, QM/HPML/HOEPA), O5.1–O5.6 (valuation, appraisal review, property/project eligibility, title, hazard/flood, MI), O6.1 (compliance gates), O9.1 (pre-funding QC hold).

## 1. Decisions (O2.6, O4.3)

`applications.disposition`: `open → conditional_approval → approved → originated | approved_not_accepted; counteroffer_pending → counteroffer_accepted | denied; incomplete_noia_sent → open | closed_incomplete; withdrawn`. Decision sub-status: `underwriting_pending → conditionally_approved → ptd_cleared → clear_to_close → ptf_cleared`; branches `suspended`, `counteroffered`, `denied`, `withdrawn`, `reopened`.

### 1.1 Conditional approval
- `decision.issued{conditional_approval}` → `NoticeCard{NTC_REGB_1002_9_APPROVAL}` — the letter is the Reg B approval notification (O4.3 Q3 default). Content the UI surfaces from the template: approved terms as of the letter, the borrower-facing conditions, `valid_until` (= `SM_UW_DECISION_VALIDITY`: the earliest of credit report expiry, lock expiry, valuation expiry, DU close-by date, 90 days), the partner as creditor, MLO of record.
- Record: badge "Approved with conditions"; Dates: "approval valid through {{valid_until}}"; Needed-from-you populated from `conditions`.
- Thread copy: `decision.conditional_approval` — plain, no adjectives; the count of items for the borrower and the count the platform owns.

### 1.2 Counteroffer
- Trigger: any lender-initiated change of terms (O4.2 Q3 default) — a lower loan amount, added MI coverage, a different product, a debt to be paid at closing. `decision.issued{counteroffer}` → `NoticeCard{NTC_REGB_1002_9_COUNTEROFFER}` + `ChoiceCard` **Accept these terms** · **Decline** · **Talk to a person**, with a `ComparisonCard` (requested vs offered: loan amount, rate, payment, cash to close / savings). Window: `REGB_1002_9_COUNTEROFFER_90` (the notice's own expiry if shorter) rendered in Dates ("counteroffer open until {{date}}").
- Accept → `counteroffer_accepted` → sub-status returns to `underwriting_pending` on the new terms → revised LE (04 §5). Decline or silence → `denied` with the adverse action notice (unless the combined notice was used).
- Copy never says "you were declined for the original" while the counteroffer is open; it says what is offered and why in the template's specific-reason language.

### 1.3 Denial (adverse action)
- `decision.issued{denial}` after `underwriting_reviewer` approval → `NoticeCard{NTC_REGB_1002_9_ADVERSE_ACTION}`: specific reasons from the underlying facts (O4.3 rule 6 examples), credit score disclosure (FCRA §615(a)), the ECOA notice, Colorado content where `jurisdiction_rules` require (`NTC_CO_SB26_189_ADMT_NOTICE` companion: reasons, correction and human-appeal information).
- Record: badge "Decision letter sent"; the application becomes read-only; Documents keep everything; Needed-from-you empties.
- Thread: the assistant sends the template's plain-language block and one sentence on next steps drawn from the template (how to request a copy of the appraisal if one was obtained — `REGB_1002_14_COPY_NOT_CONSUMMATED_30`; how to reach a person). Nothing else. `SM_LEAD_INACTIVITY_EXPIRY_90` does not apply; retention per O12.3.
- Never rendered: DU recommendation text, `risk_assessment`, layering notes.

### 1.4 Notice of incompleteness
- `incomplete_noia_sent`: `NoticeCard{NTC_REGB_1002_9_NOIA}` listing the missing items (mirrors Needed-from-you) and the deadline (`REGB_1002_9_NOIA` / `REGB_1002_9C2_NOIA_RESPONSE` in Dates: "we need these by {{date}} or the application closes"). Response → `open`; no response → `closed_incomplete` with a closing message and read-only Record.

### 1.5 Withdrawal
`application.withdraw` from a `ChoiceCard` the borrower asks for ("I want to stop") → confirmation card ("This ends your application; your documents stay available to you") → `withdrawn`; locks `cancelled`; the Record goes read-only with badge "Withdrawn". A withdrawal is never suggested by the assistant.

### 1.6 Reopened
`reopened` (contradictory information, worse DU recommendation, expired validity, failed compliance test) returns to `underwriting_pending`; the borrower sees badge "Verifying" again and, if anything is needed, the items; the reason is stated only as the neutral category ("a document expired", "new information about a debt").

## 2. Valuation (O5.1, O5.2)

`valuation_orders.status`: `method_pending → fee_gate_wait → ready_to_order → ordered → assigned → inspection_scheduled → inspected → report_received`; value acceptance: `offer_recorded → offer_exercised | offer_lost`; VA+PD: `offer_recorded → pdc_ordered → pdc_collected → pdc_submitted → pdc_accepted → offer_exercised`.

| State | Property section | Thread |
|---|---|---|
| `offer_recorded` (value acceptance) | "No appraisal needed" | `StatusCard` `valuation.value_acceptance` ("The automated underwriting system accepted your home's value — no appraisal, no fee") |
| `pdc_ordered → pdc_collected` (VA+PD) | "Property data visit scheduled {{date}}" | `ScheduleCard{pdc_access}` — a trained data collector visits, ~30 minutes, no appraisal report |
| `fee_gate_wait` | "Appraisal — waiting for your go-ahead" | resolves when intent is given (`REGZ_1026_19E2_INTENT_FEE_GATE`) or when `fee_paid_by=sm` |
| `ordered → assigned` | "Appraisal ordered — appraiser assigned" | `HandoffCard{appraiser}` (purchase: the appraiser coordinates with the listing side) or `ScheduleCard{appraisal_access}` (refinance: the borrower grants access) |
| `inspection_scheduled` | "Appraisal visit {{date}} {{window}}" | reminder the day before |
| `inspected → report_received` | "Appraisal received — under review" | nothing yet |
| `appraisals.review_status = accepted` + copy sub-state `copy_delivered` | "Appraised value on file" (the value itself appears once the copy is delivered) | `DocumentCard{appraisal copy, requires_ack=true}` — Reg B copy promptly / ≥ 3 business days before consummation (`REGB_1002_14_APPRAISAL_COPY_PROMPT_7`, `REGB_1002_14_APPRAISAL_COPY_3BD_GATE`); waiver only ≥ 3 BD before consummation (`copy_waived`) |
| `update_required` (4-month rule) / `expired` (12 months) | "Appraisal update needed" | `StatusCard` — no borrower action unless access is needed |

**Value review (ROV):** after `copy_delivered`, the `DocumentCard` footer offers **Ask for a value review**; `rov.request{comparables[], narrative}` → `rov_requests.received → screened → sme_review → forwarded → awaiting_appraiser → response_received → closed`; Dates: `FNMA_B4_1_3_12_ROV_TURNTIME_5BD`; a second review of the same appraisal is not offered (O5.2 guard); closing waits for `FNMA_B4_1_3_12_ROV_CLOSING_GATE`.

**Low value:** the assistant states the fact and the levers as a `ChoiceCard` — purchase: renegotiate (HandoffCard to the agent), bring the difference in cash (`ConfirmCard` new down payment → DU resubmission), cancel under the contingency (`application.withdraw`); refinance: lower loan amount, add MI, stop. A lender-initiated lever is a counteroffer (§1.2).

**Condition/repairs:** C5/C6 or safety items → `StatusCard` explaining that repairs or an escrow holdback (`escrow_holdbacks`, completion 180 days) are required before or after closing per O5.3; purchase: the seller side is the actor (HandoffCard).

## 3. Property and project eligibility (O5.3)

`project_reviews.status`: `not_required | pending_docs → in_review → cpm_entry_pending → certified | waived | ineligible | expired`. Borrower-visible only when `pending_docs` (SQ-08: `UploadCard{hoa_questionnaire, hoa_budget, hoa_dues_statement}` or `HandoffCard{destination: HOA management}`) or `ineligible` (the assistant states the category — "this condo project doesn't meet the program's requirements" — and, on a purchase, the contingency lever; on a refinance, the stop). `property_eligibility_reviews.result` and condition ratings are internal.

## 4. Title, vesting, payoffs, subordinations (O5.4)

`title_orders.status`: `ordered → commitment_received → reviewed → (curative_open ⇄ reviewed) → cleared → dated_down → closed → policy_received`. Borrower-visible touchpoints only:
- **Vesting confirmation** — `ConfirmCard` "Title will be held by {{names}} as {{vesting}}" (from the commitment; edits route to SQ-07); trust → `UploadCard{trust_agreement|trust_certification}` (`SM_TRUST_POA_REVIEW_GATE`); POA signer → `UploadCard{poa}`.
- **Curative items that need the borrower** — a judgment or lien to pay or release (`ChoiceCard` pay at closing / provide release), a name variance (`UploadCard`), a divorce decree or death certificate for a prior owner.
- **Payoff demand** (refinance) — `payoff_demands.status: requested → received → (stale → refreshed) → funded`; Property/Loan section shows "payoff statement from {{current servicer}} received, good through {{date}}"; the figure appears on the CD.
- **Subordination** (SQ-10) — `ChoiceCard` subordinate or pay off the HELOC; `HandoffCard{prior lienholder}`; the agreement must be executed before closing.
- **Wire-fraud rule** — the borrower is never asked to wire funds by e-mail; cash-to-close instructions come only through the settlement agent with positive confirmation (`SM_WIRE_VERIFICATION_GATE`); the assistant repeats the warning on the CD card.

## 5. Hazard and flood insurance (O5.5)

Hazard: `requirement_computed → evidence_requested → evidence_received → verified | deficient → verified`. Flood: `ordered → received → not_required | notice_due → notice_delivered → coverage_pending → coverage_verified | ineligible`.

- **Requirement card** (`StatusCard` + `ConnectCard{carrier_connect}` / `UploadCard{homeowners_policy|binder}`): the four facts in plain language — replacement-cost basis; deductible no more than 5% of the coverage amount; a carrier rated AM Best B or better (or the Demotech/S&P/Kroll equivalents); the mortgagee clause exactly as it must read: "{{partner.legal_name}}, its successors and/or assigns, c/o Supermortgage, {{mortgagee address}}"; policy in force on or before the disbursement date.
- **Condo:** master policy evidence plus an HO-6 unit policy when the master has a per-unit deductible or excludes interiors (LL-2026-03; B7-3-04).
- **Deficiency:** `deficient` → `NoticeCard{deficiency}` with the single failing element (deductible, coverage form, carrier rating, mortgagee clause, effective date) and the fix; the item stays in Needed-from-you.
- **Flood:** `notice_due → notice_delivered` renders `DocumentCard{NTC_FDPA_4104A_FLOOD_NOTICE, requires_ack=true}` ≥ 10 days before closing (`FDPA_4104A_FLOOD_NOTICE_GATE`, `SM_FLOOD_NOTICE_DELIVER_1BD`); then `ConnectCard/UploadCard` for the flood policy with the coverage rule (lesser of the loan amount, the NFIP maximum, or replacement cost; premiums escrowed). `not_required` shows "Not in a flood zone" in Property; a later remap is a servicing event (08b).

## 6. Mortgage insurance (O5.6)

`mi_certificates.status`: `quoted → plan_selected → ordered → committed → docs_ready → activation_requested → active`. Borrower-visible when LTV > 80%:
- `ComparisonCard{plans}` — borrower-paid monthly (BPMI), single premium, split premium, lender-paid (LPMI, higher rate, no separate MI line); columns: monthly cost, upfront cost, rate, when it can be cancelled (HPA rules, in one line each). `mi.selectPlan` → `plan_selected` → revised LE (04 §5). Minimum-coverage option appears only when the all-in cost is lower (O4.2 Q2).
- `committed`: Property/Numbers show the MI monthly amount; `docs_ready`: the HPA initial disclosure (`NTC_HPA_4903_INITIAL_FIXED` / `_ARM` / `NTC_HPA_4905_LPMI`) is delivered in the closing package (07); Record Loan section later carries cancellation eligibility (08b).
- `expired` commitment → re-ordered silently; `declined` (non-delegated) → counteroffer/denial path.

## 7. Compliance tests and clear to close (O4.4, O6.1, O4.3)

Compliance runs (`compliance_test_runs`), QM/HPML/HOEPA determinations and state high-cost tests are invisible except through their consequences: a restructure `ChoiceCard` ("to keep this loan eligible we need to change {{fees|points}} — here's the effect") or a delay `StatusCard` when the CD passes `SM_O62_CD_TARGET_4SBD`. HPML consequence surfaces once: "your loan will have an escrow account for at least five years" on the CD card (`REGZ_1026_35B1_HPML_ESCROW_GATE`).

**Clear to close.** When `ctc_checklists.passed = true` (every code `pass|n/a|waived`), sub-status → `clear_to_close`: badge "Clear to close"; Thread `StatusCard` `ctc.reached` ("Everything is verified. Next: your Closing Disclosure, then a signing appointment.") followed by the closing `ScheduleCard` once the CD's `earliest_consummation_date` exists (07 §2). A pre-funding QC hold (`SM_QC_PREFUNDING_HOLD`, `FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE`) renders as "a final review is in progress — nothing needed from you"; never as "QC".

## 8. Tests

- **T-06-01** Given `decision.issued{conditional_approval}`, then `NTC_REGB_1002_9_APPROVAL` renders, Dates shows `valid_until`, and Needed-from-you equals the `waiting_borrower` conditions.
- **T-06-02** Given a lender-initiated loan-amount reduction, then a counteroffer notice and `ComparisonCard` exist, `REGB_1002_9_COUNTEROFFER_90` appears in Dates, and no adverse-action notice exists while the window is open.
- **T-06-03** Given `decision.issued{denial}`, then the payload contains the specific reasons from the template and no DU recommendation string; the Record is read-only.
- **T-06-04** Given value acceptance offered at the final DU submission, then Property shows "No appraisal needed" and no `ScheduleCard{appraisal_access}` exists.
- **T-06-05** Given an appraisal accepted Wed Nov 4, 2026 with consummation Fri Nov 6, then the copy `DocumentCard` was delivered ≥ 3 business days earlier or a `copy_waived` record ≥ 3 BD before consummation exists; otherwise `consummate` is refused.
- **T-06-06** Given a purchase appraisal below price, then the `ChoiceCard` offers renegotiate / cash / cancel and a chosen "cash" writes the new down payment as `source=borrower` and triggers DU resubmission.
- **T-06-07** Given `project_reviews.status = pending_docs`, then SQ-08 cards exist and the item is owner *you* only for documents the HOA sends to the borrower; otherwise owner *third party*.
- **T-06-08** Given a hazard policy with a 7% deductible, then `deficient` renders a deficiency card naming the deductible only.
- **T-06-09** Given `in_sfha = true`, then `NTC_FDPA_4104A_FLOOD_NOTICE` is delivered with `requires_ack` ≥ 10 days before the scheduled closing, and no closing slot renders before `flood.notice.delivered`.
- **T-06-10** Given LTV 92%, then the MI `ComparisonCard` shows four plans with cancellation rules; `mi.selectPlan{lpmi}` produces a revised LE with a higher rate and no MI line.
- **T-06-11** Given `ctc_checklists.passed = true`, then the badge is "Clear to close" and the closing `ScheduleCard` waits for `earliest_consummation_date`.
- **T-06-12** Given `SM_QC_PREFUNDING_HOLD`, then the Thread copy is `ctc.final_review` and contains no "QC".
