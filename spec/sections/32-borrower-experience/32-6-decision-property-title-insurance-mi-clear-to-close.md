# 32.6 — Decision, property, title, insurance, MI, clear to close

| Attribute | Value |
|---|---|
| Section | 32 — Borrower experience |
| Automation class | c — the borrower responds to counteroffers, schedules access, selects MI and supplies insurance by card; `underwriting_reviewer` approves denials |
| Capacity | Lender (partner; projections of 20–31) · Servicer · Sub (projections of 1–19) — Supermortgage renders the borrower experience; the system of record stays with the owning process |
| Trigger & frequency | On `decision.issued{kind}`; on every valuation, project, title, hazard/flood, MI and CTC state change |
| Governing source | Projection of sections 21.6 (application-status decisions), 23.2–23.4 (findings, conditions, risk assessment, QM/HPML/HOEPA), 24.1–24.6 (valuation, appraisal review, property/project eligibility, title, hazard/flood, MI), 25.1 (compliance gates), 28.1 (pre-funding QC hold). |
| Key deadlines | renders `REGB_1002_9_COUNTEROFFER_90`, `REGB_1002_9_NOIA`, `REGB_1002_14_APPRAISAL_COPY_3BD_GATE`, `FNMA_B4_1_3_12_ROV_TURNTIME_5BD`, `FDPA_4104A_FLOOD_NOTICE_GATE`, `SM_UW_DECISION_VALIDITY` (owned by 21.6 / 23.x / 24.x) |
| Timers | — |

### Blueprint row
Projection of sections 21.6 (application-status decisions), 23.2–23.4 (findings, conditions, risk assessment, QM/HPML/HOEPA), 24.1–24.6 (valuation, appraisal review, property/project eligibility, title, hazard/flood, MI), 25.1 (compliance gates), 28.1 (pre-funding QC hold).. Owner specs: 21.6 (application-status decisions), 23.2–23.4 (findings, conditions, risk assessment, QM/HPML/HOEPA), 24.1–24.6 (valuation, appraisal review, property/project eligibility, title, hazard/flood, MI), 25.1 (compliance gates), 28.1 (pre-funding QC hold). (Imported from docs/ux/06-decision-property-title-insurance-mi.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10); UX file 06 is 32.6 here.)

### Verified requirement (as of 2026-09-11)
**Projection of sections 21.6 (application-status decisions), 23.2–23.4 (findings, conditions, risk assessment, QM/HPML/HOEPA), 24.1–24.6 (valuation, appraisal review, property/project eligibility, title, hazard/flood, MI), 25.1 (compliance gates), 28.1 (pre-funding QC hold).** — the UX layer verifies nothing new: every rule this process renders (a clock, a notice, a gate, a consent manner, a money figure) is verified in the owning process file cited, and the UI renders the owning process's state, `timers.due_at` and rendered documents without recomputing any of them. The screens, cards and copy below are the borrower-facing form of those verified rules; where a rule is marked [UNVERIFIED] in the owning file it stays so here. Statutory and Guide citations in the text are the owning process's.

**Discrepancies vs blueprint**: (1) SM_QC_PREFUNDING_HOLD is named as a timer but is not a registry code (28.1 owns the pre-funding QC hold as a state; the UX renders it as "a final review is in progress").

### Operational prerequisites
- Vendor fakes: Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console (README, "Vendor fakes"). No live vendor credential is a prerequisite of any build stage.
- The partner's legal name and NMLSR ID (`partner.legal_name`, `partner.nmlsr_id`) and the `mlo_of_record` roster (31.1) — rendered wherever a disclosure or the SAFE Act requires them.
- Feature flags consumed (32.2 §8): `origination.ai_mlo_intake` (default `assisted`), `origination.preapproval_program` (default on), `closing.enote_default`, `case.ai_path`, `theme` (dark default), `voice.in_app`, connector vendor toggles, `jurisdiction_rules`.

### Build spec
#### Inputs and triggers
- On `decision.issued{kind}`; on every valuation, project, title, hazard/flood, MI and CTC state change. Events that move this process's screens are the ones its screens name (Business rules) and 32.2 §3 subscribes to; every borrower command is one of 32.2 §2, started from a card; every card is started by the owning agent (32.1 §3). A human may start nothing on the borrower's behalf except sending a card (`human_agent`) — 32.5 §8.

#### Data model
No UI-owned table is declared here (32.2 declares the seven UI-owned tables).
- Baseline, read-only projection sources this process renders (owned by the sections in the Blueprint row; no table is re-declared): `compliance_test_runs`, `conditions`, `escrow_holdbacks`, `jurisdiction_rules`.
- Domain evidence rows are written by the owning command handler on a card resolve (32.1 §9); `ui_events` is the corroborating trail.

#### State machine
Object-level, UI-owned (`card_instances.status`): `pending` —(the borrower resolves the card on any channel; its evidence schema is satisfied; the mapped command is accepted)→ `resolved`; `pending` —(`expires_at` reached)→ `expired`; `pending` —(a newer card for the same ask)→ `superseded`; `pending` —(the subject reaches a terminal state or the ask is withdrawn)→ `cancelled`. Terminal: `resolved`, `expired`, `superseded`, `cancelled`. Every transition appends a `card_instance_events` row. Only the borrower (the party the card is for) resolves a card; the agents and a `human_agent` send and cancel cards and never resolve one for the borrower (32.5 §8). Every other state this process renders belongs to the owning process (its state-to-card tables are under Business rules) and is projected, never transitioned, by the UI.

#### Timers and gates
None owned by this process — the UX owns no timer; 32.2 §4 is the allow-list and its table holds the reference rows.

Borrower-visible clocks this process renders (each owned by the process in parentheses; the label is the allow-list's): `SM_UW_DECISION_VALIDITY` (23.3), `REGB_1002_9_COUNTEROFFER_90` (21.6), `REGB_1002_14_COPY_NOT_CONSUMMATED_30` (24.2), `SM_LEAD_INACTIVITY_EXPIRY_90` (20.3), `REGB_1002_9_NOIA` (21.6), `REGB_1002_9C2_NOIA_RESPONSE` (21.6), `REGZ_1026_19E2_INTENT_FEE_GATE` (21.4), `REGB_1002_14_APPRAISAL_COPY_PROMPT_7` (24.2), `REGB_1002_14_APPRAISAL_COPY_3BD_GATE` (24.2), `FNMA_B4_1_3_12_ROV_TURNTIME_5BD` (24.2), `FNMA_B4_1_3_12_ROV_CLOSING_GATE` (24.2), `SM_TRUST_POA_REVIEW_GATE` (24.4), `SM_WIRE_VERIFICATION_GATE` (24.4), `FDPA_4104A_FLOOD_NOTICE_GATE` (24.5), `SM_FLOOD_NOTICE_DELIVER_1BD` (24.5), `SM_O62_CD_TARGET_4SBD` (25.2), `REGZ_1026_35B1_HPML_ESCROW_GATE` (23.4), `FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE` (23.3).

Named as timers here but not registry codes (docs/ux/BACKEND-DELTAS.md): SM_QC_PREFUNDING_HOLD.

Jurisdiction overrides: none owned; state copy variants come from `jurisdiction_rules` through the owning process.

#### Business rules and calculations
1. **Nothing invented.** No state, timer, notice, command, table or role appears here that does not exist in the build specs, except the UI-owned objects of 32.2 §1.6; a name means one thing on both sides (README).
2. **The UI never computes a regulatory date.** It renders `timers.due_at` for allow-listed codes (32.2 §4) with the label given; a date not in `timers` is not shown. Money renders from `bigint` cents with `Intl.NumberFormat`; rates from `decimal` strings; there is no client-side arithmetic and no worked money figure to assert here — fixtures quoted from the owning sections stay theirs.
3. **Cards commit, chat does not.** Nothing legally consequential exists only as chat text; each has a typed card that produces the evidence row the owning spec requires (32.1 §3).

##### 1. Decisions (21.6, 23.3)

`applications.disposition`: `open → conditional_approval → approved → originated | approved_not_accepted; counteroffer_pending → counteroffer_accepted | denied; incomplete_noia_sent → open | closed_incomplete; withdrawn`. Decision sub-status: `underwriting_pending → conditionally_approved → ptd_cleared → clear_to_close → ptf_cleared`; branches `suspended`, `counteroffered`, `denied`, `withdrawn`, `reopened`.

###### 1.1 Conditional approval
- `decision.issued{conditional_approval}` → `NoticeCard{NTC_REGB_1002_9_APPROVAL}` — the letter is the Reg B approval notification (23.3 Q3 default). Content the UI surfaces from the template: approved terms as of the letter, the borrower-facing conditions, `valid_until` (= `SM_UW_DECISION_VALIDITY`: the earliest of credit report expiry, lock expiry, valuation expiry, DU close-by date, 90 days), the partner as creditor, MLO of record.
- Record: badge "Approved with conditions"; Dates: "approval valid through {{valid_until}}"; Needed-from-you populated from `conditions`.
- Thread copy: `decision.conditional_approval` — plain, no adjectives; the count of items for the borrower and the count the platform owns.

###### 1.2 Counteroffer
- Trigger: any lender-initiated change of terms (23.2 Q3 default) — a lower loan amount, added MI coverage, a different product, a debt to be paid at closing. `decision.issued{counteroffer}` → `NoticeCard{NTC_REGB_1002_9_COUNTEROFFER}` + `ChoiceCard` **Accept these terms** · **Decline** · **Talk to a person**, with a `ComparisonCard` (requested vs offered: loan amount, rate, payment, cash to close / savings). Window: `REGB_1002_9_COUNTEROFFER_90` (the notice's own expiry if shorter) rendered in Dates ("counteroffer open until {{date}}").
- Accept → `counteroffer_accepted` → sub-status returns to `underwriting_pending` on the new terms → revised LE (32.4 §5). Decline or silence → `denied` with the adverse action notice (unless the combined notice was used).
- Copy never says "you were declined for the original" while the counteroffer is open; it says what is offered and why in the template's specific-reason language.

###### 1.3 Denial (adverse action)
- `decision.issued{denial}` after `underwriting_reviewer` approval → `NoticeCard{NTC_REGB_1002_9_ADVERSE_ACTION}`: specific reasons from the underlying facts (23.3 rule 6 examples), credit score disclosure (FCRA §615(a)), the ECOA notice, Colorado content where `jurisdiction_rules` require (`NTC_CO_SB26_189_ADMT_NOTICE` companion: reasons, correction and human-appeal information).
- Record: badge "Decision letter sent"; the application becomes read-only; Documents keep everything; Needed-from-you empties.
- Thread: the assistant sends the template's plain-language block and one sentence on next steps drawn from the template (how to request a copy of the appraisal if one was obtained — `REGB_1002_14_COPY_NOT_CONSUMMATED_30`; how to reach a person). Nothing else. `SM_LEAD_INACTIVITY_EXPIRY_90` does not apply; retention per 31.3.
- Never rendered: DU recommendation text, `risk_assessment`, layering notes.

###### 1.4 Notice of incompleteness
- `incomplete_noia_sent`: `NoticeCard{NTC_REGB_1002_9_NOIA}` listing the missing items (mirrors Needed-from-you) and the deadline (`REGB_1002_9_NOIA` / `REGB_1002_9C2_NOIA_RESPONSE` in Dates: "we need these by {{date}} or the application closes"). Response → `open`; no response → `closed_incomplete` with a closing message and read-only Record.

###### 1.5 Withdrawal
`application.withdraw` from a `ChoiceCard` the borrower asks for ("I want to stop") → confirmation card ("This ends your application; your documents stay available to you") → `withdrawn`; locks `cancelled`; the Record goes read-only with badge "Withdrawn". A withdrawal is never suggested by the assistant.

###### 1.6 Reopened
`reopened` (contradictory information, worse DU recommendation, expired validity, failed compliance test) returns to `underwriting_pending`; the borrower sees badge "Verifying" again and, if anything is needed, the items; the reason is stated only as the neutral category ("a document expired", "new information about a debt").

##### 2. Valuation (24.1, 24.2)

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

**Value review (ROV):** after `copy_delivered`, the `DocumentCard` footer offers **Ask for a value review**; `rov.request{comparables[], narrative}` → `rov_requests.received → screened → sme_review → forwarded → awaiting_appraiser → response_received → closed`; Dates: `FNMA_B4_1_3_12_ROV_TURNTIME_5BD`; a second review of the same appraisal is not offered (24.2 guard); closing waits for `FNMA_B4_1_3_12_ROV_CLOSING_GATE`.

**Low value:** the assistant states the fact and the levers as a `ChoiceCard` — purchase: renegotiate (HandoffCard to the agent), bring the difference in cash (`ConfirmCard` new down payment → DU resubmission), cancel under the contingency (`application.withdraw`); refinance: lower loan amount, add MI, stop. A lender-initiated lever is a counteroffer (§1.2).

**Condition/repairs:** C5/C6 or safety items → `StatusCard` explaining that repairs or an escrow holdback (`escrow_holdbacks`, completion 180 days) are required before or after closing per 24.3; purchase: the seller side is the actor (HandoffCard).

##### 3. Property and project eligibility (24.3)

`project_reviews.status`: `not_required | pending_docs → in_review → cpm_entry_pending → certified | waived | ineligible | expired`. Borrower-visible only when `pending_docs` (SQ-08: `UploadCard{hoa_questionnaire, hoa_budget, hoa_dues_statement}` or `HandoffCard{destination: HOA management}`) or `ineligible` (the assistant states the category — "this condo project doesn't meet the program's requirements" — and, on a purchase, the contingency lever; on a refinance, the stop). `property_eligibility_reviews.result` and condition ratings are internal.

##### 4. Title, vesting, payoffs, subordinations (24.4)

`title_orders.status`: `ordered → commitment_received → reviewed → (curative_open ⇄ reviewed) → cleared → dated_down → closed → policy_received`. Borrower-visible touchpoints only:
- **Vesting confirmation** — `ConfirmCard` "Title will be held by {{names}} as {{vesting}}" (from the commitment; edits route to SQ-07); trust → `UploadCard{trust_agreement|trust_certification}` (`SM_TRUST_POA_REVIEW_GATE`); POA signer → `UploadCard{poa}`.
- **Curative items that need the borrower** — a judgment or lien to pay or release (`ChoiceCard` pay at closing / provide release), a name variance (`UploadCard`), a divorce decree or death certificate for a prior owner.
- **Payoff demand** (refinance) — `payoff_demands.status: requested → received → (stale → refreshed) → funded`; Property/Loan section shows "payoff statement from {{current servicer}} received, good through {{date}}"; the figure appears on the CD.
- **Subordination** (SQ-10) — `ChoiceCard` subordinate or pay off the HELOC; `HandoffCard{prior lienholder}`; the agreement must be executed before closing.
- **Wire-fraud rule** — the borrower is never asked to wire funds by e-mail; cash-to-close instructions come only through the settlement agent with positive confirmation (`SM_WIRE_VERIFICATION_GATE`); the assistant repeats the warning on the CD card.

##### 5. Hazard and flood insurance (24.5)

Hazard: `requirement_computed → evidence_requested → evidence_received → verified | deficient → verified`. Flood: `ordered → received → not_required | notice_due → notice_delivered → coverage_pending → coverage_verified | ineligible`.

- **Requirement card** (`StatusCard` + `ConnectCard{carrier_connect}` / `UploadCard{homeowners_policy|binder}`): the four facts in plain language — replacement-cost basis; deductible no more than 5% of the coverage amount; a carrier rated AM Best B or better (or the Demotech/S&P/Kroll equivalents); the mortgagee clause exactly as it must read: "{{partner.legal_name}}, its successors and/or assigns, c/o Supermortgage, {{mortgagee address}}"; policy in force on or before the disbursement date.
- **Condo:** master policy evidence plus an HO-6 unit policy when the master has a per-unit deductible or excludes interiors (LL-2026-03; B7-3-04).
- **Deficiency:** `deficient` → `NoticeCard{deficiency}` with the single failing element (deductible, coverage form, carrier rating, mortgagee clause, effective date) and the fix; the item stays in Needed-from-you.
- **Flood:** `notice_due → notice_delivered` renders `DocumentCard{NTC_FDPA_4104A_FLOOD_NOTICE, requires_ack=true}` ≥ 10 days before closing (`FDPA_4104A_FLOOD_NOTICE_GATE`, `SM_FLOOD_NOTICE_DELIVER_1BD`); then `ConnectCard/UploadCard` for the flood policy with the coverage rule (lesser of the loan amount, the NFIP maximum, or replacement cost; premiums escrowed). `not_required` shows "Not in a flood zone" in Property; a later remap is a servicing event (32.9).

##### 6. Mortgage insurance (24.6)

`mi_certificates.status`: `quoted → plan_selected → ordered → committed → docs_ready → activation_requested → active`. Borrower-visible when LTV > 80%:
- `ComparisonCard{plans}` — borrower-paid monthly (BPMI), single premium, split premium, lender-paid (LPMI, higher rate, no separate MI line); columns: monthly cost, upfront cost, rate, when it can be cancelled (HPA rules, in one line each). `mi.selectPlan` → `plan_selected` → revised LE (32.4 §5). Minimum-coverage option appears only when the all-in cost is lower (23.2 Q2).
- `committed`: Property/Numbers show the MI monthly amount; `docs_ready`: the HPA initial disclosure (`NTC_HPA_4903_INITIAL_FIXED` / `_ARM` / `NTC_HPA_4905_LPMI`) is delivered in the closing package (32.7); Record Loan section later carries cancellation eligibility (32.9).
- `expired` commitment → re-ordered silently; `declined` (non-delegated) → counteroffer/denial path.

##### 7. Compliance tests and clear to close (23.4, 25.1, 23.3)

Compliance runs (`compliance_test_runs`), QM/HPML/HOEPA determinations and state high-cost tests are invisible except through their consequences: a restructure `ChoiceCard` ("to keep this loan eligible we need to change {{fees|points}} — here's the effect") or a delay `StatusCard` when the CD passes `SM_O62_CD_TARGET_4SBD`. HPML consequence surfaces once: "your loan will have an escrow account for at least five years" on the CD card (`REGZ_1026_35B1_HPML_ESCROW_GATE`).

**Clear to close.** When `ctc_checklists.passed = true` (every code `pass|n/a|waived`), sub-status → `clear_to_close`: badge "Clear to close"; Thread `StatusCard` `ctc.reached` ("Everything is verified. Next: your Closing Disclosure, then a signing appointment.") followed by the closing `ScheduleCard` once the CD's `earliest_consummation_date` exists (32.7 §2). A pre-funding QC hold (`SM_QC_PREFUNDING_HOLD`, `FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE`) renders as "a final review is in progress — nothing needed from you"; never as "QC".

#### Integrations
- **`FAKE` vendors** — Stripe Identity, Plaid, Truv, IRS IVES, carrier connection, the RON platform, DU, EarlyCheck, telephony/SMS/e-mail and print/mail run against in-repo fakes in every build stage; every fake is named `FAKE` in code, docs and the console. Adapters this process touches: the ones its cards name (ConnectCard vendors, the RON platform, telephony, e-mail/SMS, print/mail); each is direction in/out through the owning process's adapter, idempotent on `card_instance_id` / vendor session id, and on outage the card shows `failed` with the upload or paper fallback (32.1 §10).
- **`api`** — the borrower endpoints of 32.2 §7; errors carry {code, gate, copy_key}; the SSE stream of 32.2 §3.

#### Outputs and artifacts
- Rows written: `card_instances` (+ `card_instance_events`), `messages`, `ui_events`, `deep_links`; domain evidence rows through the owning handler (32.1 §9). Documents produced: none — every disclosure and notice rendered here is the owning process's rendered document (`notices.rendered_document_id`, `disclosures.rendered_document_id`), shown with its template version and delivery evidence; a notice delivered by mail shows *Mailed* and no receipt action.

#### AI agent design (AI-first)
`intake` agent owns the pre-funding thread for this process; it sends and resolves cards through the card-sending capabilities named in 32.1 (send_card, resolve_card_by_evidence, create_deep_link) and issues every borrower command through the 32.2 command surface; it names no tool of its own here. End-to-end: on each event this process subscribes to, the agent puts the typed card in front of the borrower with the copy key named, keeps the Record in step, and reminds on the owning process's cadence; the borrower commits by card; the owning process decides. Decision record schema: {card_instance_id, party_id, subject, event, copy_key, rule_set_version, model_version, prompt_version, confidence, rationale}. Guardrails: never a decline, "you don't qualify", "guaranteed" or an investor reference in copy (32.1 §7.3); never a personal rate before `mlo.review.completed{approved}`; never a consent by voice or chat; never a money-field change without `officer` approval; never a date the Timer Engine did not compute. Escalations: `human_agent` on "human" or distress; the human roles the owning process names (`mlo_of_record`, `underwriting_reviewer`, `officer`) for their acts.

#### Edge cases and failure modes
- Vendor down → `ConnectCard` `failed` with the `UploadCard` fallback; AI path off → `human_agent` turns, cards and Record unchanged; DU / Fannie Mae outage → no borrower-visible error, timers still render; offline → cards queue *unsent* and nothing shows as done until the server acknowledges; E-SIGN suspect → the document flips to *Mailed* and re-verification is offered (32.1 §10).

#### Test cases and acceptance criteria
| ID | Acceptance test |
|---|---|
| 32.6-T1 | Given `decision.issued{conditional_approval}`, then `NTC_REGB_1002_9_APPROVAL` renders, Dates shows `valid_until`, and Needed-from-you equals the `waiting_borrower` conditions. |
| 32.6-T2 | Given a lender-initiated loan-amount reduction, then a counteroffer notice and `ComparisonCard` exist, `REGB_1002_9_COUNTEROFFER_90` appears in Dates, and no adverse-action notice exists while the window is open. |
| 32.6-T3 | Given `decision.issued{denial}`, then the payload contains the specific reasons from the template and no DU recommendation string; the Record is read-only. |
| 32.6-T4 | Given value acceptance offered at the final DU submission, then Property shows "No appraisal needed" and no `ScheduleCard{appraisal_access}` exists. |
| 32.6-T5 | Given an appraisal accepted Wed Nov 4, 2026 with consummation Fri Nov 6, then the copy `DocumentCard` was delivered ≥ 3 business days earlier or a `copy_waived` record ≥ 3 BD before consummation exists; otherwise `consummate` is refused. |
| 32.6-T6 | Given a purchase appraisal below price, then the `ChoiceCard` offers renegotiate / cash / cancel and a chosen "cash" writes the new down payment as `source=borrower` and triggers DU resubmission. |
| 32.6-T7 | Given `project_reviews.status = pending_docs`, then SQ-08 cards exist and the item is owner *you* only for documents the HOA sends to the borrower; otherwise owner *third party*. |
| 32.6-T8 | Given a hazard policy with a 7% deductible, then `deficient` renders a deficiency card naming the deductible only. |
| 32.6-T9 | Given `in_sfha = true`, then `NTC_FDPA_4104A_FLOOD_NOTICE` is delivered with `requires_ack` ≥ 10 days before the scheduled closing, and no closing slot renders before `flood.notice.delivered`. |
| 32.6-T10 | Given LTV 92%, then the MI `ComparisonCard` shows four plans with cancellation rules; `mi.selectPlan{lpmi}` produces a revised LE with a higher rate and no MI line. |
| 32.6-T11 | Given `ctc_checklists.passed = true`, then the badge is "Clear to close" and the closing `ScheduleCard` waits for `earliest_consummation_date`. |
| 32.6-T12 | Given `SM_QC_PREFUNDING_HOLD`, then the Thread copy is `ctc.final_review` and contains no "QC". |

#### Audit and evidence
- What an examiner is shown: the `ui_events` trail (card shown / resolved, document opened and scrolled to end, consent affirmed with `disclosure_version_id`, ip and user agent), each `card_instance_events` transition, the domain evidence rows the owning handler wrote on each resolve, the rendered documents and their hashes, and the timer history — exported per party and subject through the owning sections' evidence packs (19.x, 31.3). No analytics vendor receives PII.

### Open questions / decisions
1. The open items of README §"Open items carried into the package" apply here (`origination.ai_mlo_intake`, the Reg C preapproval program, the same-creditor rescission exemption, hello-notice branding, theme, vendors). **Default: as stated there — `assisted`, adopted, rendered from the rescission state, Supermortgage experience with `partner.legal_name` where required, dark, fakes named `FAKE`.**

### Sources
- docs/ux/06-decision-property-title-insurance-mi.md — Supermortgage Borrower Experience — UX Build Specification, package v0.1 (2026-09-10)
- docs/ux/00-MASTER-INDEX.md, docs/ux/14-claude-code-build-plan.md — scope, binding rules, vocabulary map, build stages, backend deltas (section README)
- The owning build-spec processes: sections 21.6 (application-status decisions), 23.2–23.4 (findings, conditions, risk assessment, QM/HPML/HOEPA), 24.1–24.6 (valuation, appraisal review, property/project eligibility, title, hazard/flood, MI), 25.1 (compliance gates), 28.1 (pre-funding QC hold). (spec/sections/)
