# 9.7 — Loss draft / insurance claim handling

| Attribute | Value |
|---|---|
| Section | 9 — Insurance & Property Protection |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On casualty |
| Governing source | FNMA B-5 |
| Key deadlines | Per policy |
| Timers | `FNMA_B501_FORM176_ABANDONED_5BD`, `FNMA_B501_PROOF_OF_LOSS_POLICY`, `FNMA_B501_REMIT_PROCEEDS_REOGRAM_30`, `FNMA_B501_REMIT_SHORTSALE_332_0`, `FNMA_B501_WIRE_POSTREOGRAM_PROCEEDS_10BD`, `FNMA_D1301_DISASTER_FC_APPROVAL_5`, `FNMA_F105_INSURED_LOSS_INSPECT_CLAIM_365`, `INS_CLAIM_CONTENTS_RELEASE_2BD`, `INS_CLAIM_INITIAL_RELEASE_5BD`, `INS_CLAIM_INSPECTION_ORDER_3BD`, `INS_CLAIM_STALE_90` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Property |
| Trigger & frequency | On casualty |
| Governing source (blueprint) | FNMA B-5 |
| Key deadlines (blueprint) | Per policy |
| Data/artifacts | Claim file |
| Systems | Insurer |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Sub administers; partner (mortgagee) endorses via LPOA to Supermortgage; Fannie Mae approvals via Form 176 |
| Nuances (blueprint) | [cropped in source] — reconstructed: B-5-01 release thresholds by delinquency; interest-bearing T&I custody; contents/living-expense immediate release; Form 176 for public-adjuster fees and abandoned/foreclosure cases; remittance codes; remote inspections; uninsured losses (B-5-02); disaster interplay (D1-3-01) |

### Verified requirement (as of 2026-09-09)

**Servicing Guide B-5-01, Insured Loss Events (07/12/2023)** (https://servicing-guide.fanniemae.com/svc/b-5-01/insured-loss-events, verified 2026-09-09): the servicer must ensure the proof-of-loss claim is filed "within the time period specified in the insurance policy" and monitor disbursement; if contact with the borrower is lost, contact the insurer to verify a claim was filed and, if not, file under the mortgagee clause and collect the proceeds for Fannie Mae; if an insurable loss is found on inspection and a claim is not filed, is denied or curtailed "due to servicer negligence," the servicer must make Fannie Mae whole. If the property **cannot legally be rebuilt** → apply all proceeds to the UPB. If it can: document the loss and cause; discuss repair plans (if no contact or the property is abandoned, secure and maintain per D2-2-10 and the Property Preservation Matrix); **immediately** release amounts designated for contents or living expenses; deposit undisbursed proceeds in an **interest-bearing** account (a T&I custodial account with an eligible depository, for the borrower's benefit, yielding what a savings/money-market account would; interest paid to the borrower at repair completion unless earlier requested or applied to UPB where law permits); ensure inspection reports are accurate, dated, identify mortgagors and address; obtain lien releases where applicable; **no public-adjuster or third-party fees from proceeds without Fannie Mae's written approval** (request via **Form 176, Report of Property Insurance Loss**, to the SF CPM Division with loan/property/damage/claim data and a business justification); release proceeds per the Guide regardless of possible supplemental claims.

**Release schedule** — **current or < 31 days delinquent**: initial release of the **greater of $40,000, 33% of the total proceeds, or the amount by which the proceeds exceed UPB + accrued interest + advances**; remaining proceeds on periodic inspections confirming progress; if staged, review/approve the final repair plan (with bids) and monitor/inspect; a final inspection is **not** required; the borrower may be reimbursed for prepaid contractor/materials with paid receipts (receipts waived when proceeds ≤ $40,000). **31 days or more delinquent**: evaluate for a workout (D2-3.1-01); proceeds ≤ **$5,000** → single lump sum; > $5,000 → initial **25%** of total, not exceeding the greater of **$10,000** or the excess over UPB + interest + advances; remaining in increments ≤ **25%** after repair inspections; always review/approve the plan with bids, monitor, and **conduct a final inspection**. **Abandoned property or scheduled foreclosure sale**: if the borrower intends to repair — evaluate for a workout, preserve per D2-2-10/Matrix, and submit **Form 176 within five business days** of learning of the damage; if not — preserve, submit Form 176 within five business days of learning of the decision, and (a) ensure proceeds are assigned to Fannie Mae if a workout requires it, (b) submit non-eligible cases to Fannie Mae for review, (c) if foreclosure proceeds, follow E-3.3-05 for bidding. **Remitting at resolution**: short sale — remit the remaining proceeds at closing via CRS **remittance code 332**; mortgage release or foreclosure sale — remit the balance **within 30 days of confirming the REOgram** via CRS code 332; proceeds received after REOgram confirmation (or from Fannie Mae's property recovery firm claim) wired **within 10 business days** of receipt; the servicer may not pay its own recovery-firm fees or other servicer expenses from proceeds. **Remote inspections** (current/< 31 days): borrower photos/video or servicer video calls acceptable if location and time can be authenticated, images are unaltered, and repairs match the adjuster's itemized estimate without compromising safety/soundness/occupancy eligibility. **Insured-loss repair inspection costs** are reimbursable when required to release additional funds or complete a final inspection (F-1-05: "$60/inspection" per the current table **[as extracted 2026-09-09; confirm against the live Defined Expense Reimbursement Limits table]**; claims for current loans within one year of the cost).

**B-5-02, Uninsured Loss Events (09/09/2020)**: determine the damage; if abandoned, secure per E-3.2-12 and the Matrix; develop repair plans; assist the borrower with disaster relief (D1-3-01); evaluate for a workout (D2-3). **D1-3-01 (04/08/2026)**: for disaster events, determine damage (borrower information or inspection; optional for loans current before and after the event; predictive/aerial tools allowed), "ensure that any applicable property insurance claims are filed and settled promptly, and that the property is repaired fully in accordance with B-5-01," verify adequacy of insurance (B-2/B-3), counsel on workouts and FEMA relief, and obtain Fannie Mae's **prior written approval** before any foreclosure step on a disaster-impacted property (submission within 5 days; contents include insurance-claim date, status and expected/received disbursements — Section 13). Sources verified 2026-09-09 (URLs in Sources).

**Other law**: NFIP SFIP proof of loss within 60 days of the loss (44 CFR 61 App. A(1) **[PARTIALLY VERIFIED — form text not retrieved]**); ISO homeowners forms typically require a sworn proof of loss within 60 days of the insurer's request **[PARTIALLY VERIFIED]**; state prompt-payment and "mortgagee endorsement/hold" statutes (e.g., California and New York rules on timely release of insurance proceeds by lenders) **[UNVERIFIED — jurisdiction_rules task]**; Reg X has no loss-draft-specific error category, but a written complaint about held proceeds is a Notice of Error under the §1024.35(b)(11) catch-all ("any other error relating to the servicing of a borrower's mortgage loan") and is handled by 4.1; LL-2026-05 escrow events include a **loss draft** category (Section 3.7).

**Discrepancies vs blueprint**: "per policy" understates the Fannie Mae clocks (immediate contents release; Form 176 five business days; 30-day/10-business-day remittances; workout evaluation for ≥ 31-day delinquent borrowers); the blueprint's "inspections at 25/50/100%" (in the research targets) is a design choice — the Guide fixes only the initial-release formulas, the ≤ 25% increments for delinquent loans and the final-inspection rule.

### Operational prerequisites
- Limited power of attorney from the partner to endorse insurance drafts and sign proofs of loss; endorsement stamp/e-endorsement procedure at the custodial bank; dedicated loss-draft lockbox address published in the mortgagee clause — Partner legal + Supermortgage + custodial bank (Section 6.2); 4 weeks.
- Interest-bearing T&I custodial sub-account (or eligible depository money-market equivalent) titled for Fannie Mae/borrower benefit, with interest allocation by loan (6.2) — Supermortgage + bank.
- Inspection vendor for repair inspections (A4-2.1-02 cost-effectiveness/no-conflict standard) plus the remote-inspection app (authenticated photo/video) — Supermortgage.
- Form 176 template and SF CPM Division submission channel (e-mail/upload) **[submission address not verified today — take from F-4-02 List of Contacts]** — Supermortgage; `fnma_portal_operator`/agent e-mail.
- CRS remittance code 332 wiring/draft instructions (Section 5.2) and REOgram feed (15.x).
- Borrower-portal claim upload (adjuster estimate, contractor bids, lien waivers, receipts, photos) with E-SIGN consent capture.

### Build spec
#### Inputs and triggers
- `insurance.claim.reported` from any channel (borrower call/chat/portal, carrier notice, adjuster, check received at lockbox, inspection finding of damage, disaster-event sweep `disaster.event.declared` + property in the affected area).
- `cashiering.instrument.received` where payee includes the partner/Supermortgage and the drawer is an insurer → auto-open/link a claim.
- `property_inspections` results with damage flags (9.8) → claim or uninsured-loss case.
- Repair milestones: borrower draw requests, contractor invoices, inspection reports, lien waivers.
- Loan-status changes: delinquency crossing 31 days (release track switch), abandonment, foreclosure sale scheduled, REOgram confirmed, short-sale closing, payoff.

#### Data model
- `insurance_claims` (new; 1:1 with `cases` `case_type='insurance_claim'`): `id`, `loan_id`, `property_id`, `policy_id`, `loss_date`, `loss_cause` ∈ {fire, wind, hail, water, flood, theft, vandalism, earthquake, other}, `disaster_event_id?`, `reported_at`, `carrier_claim_no`, `adjuster_party_id`, `adjuster_estimate_cents`, `rebuildable` ∈ {yes, no, unknown}, `track` ∈ {current_lt31, delinquent_31plus, abandoned_or_fc_sale, not_rebuildable}, `track_determined_at`, `total_proceeds_expected_cents`, `proceeds_received_cents`, `held_cents`, `disbursed_cents`, `contents_ale_cents`, `interest_accrued_cents`, `repair_plan_status` ∈ {none, submitted, approved}, `bids jsonb`, `public_adjuster bool`, `form176_sent_at?`, `form176_reason`, `workout_case_id?`, `status`.
- `claim_instruments` (new): `id`, `claim_id`, `instrument_type` ∈ {check, eft}, `check_no`, `payees text[]`, `amount_cents`, `received_at`, `endorsement_required bool`, `endorsement_status` ∈ {awaiting_borrower, awaiting_servicer, endorsed, deposited, returned}, `deposited_at`, `custodial_account_id`, `ledger_entry_id`, `image_document_id`.
- `claim_disbursements` (new): `id`, `claim_id`, `seq`, `kind` ∈ {contents_ale, initial, progress, final, prepaid_reimbursement, upb_application, remit_fnma_332, interest_payout, refund_to_borrower}, `amount_cents`, `rule_basis` (formula id + inputs), `inspection_id?`, `lien_waivers jsonb`, `payee_party_ids`, `released_at`, `disbursement_id` (3.7 rail), `approved_by_run_id`.
- `repair_inspections` (new): `id`, `claim_id`, `type` ∈ {progress, final, remote_photo, remote_video}, `pct_complete numeric(5,2)`, `inspected_at`, `inspector_party_id`, `report_document_id`, `authenticity jsonb` (GPS/EXIF/time checks), `cost_cents`, `reimbursable bool`, `claimed_in` (15.2 claim id).
- Ledger accounts (new, per loan): `loss_draft_funds` (liability to borrower/Fannie Mae, restricted), `loss_draft_interest_payable`; custodial `custodial_ti_cash` (Section 6). Escrow event category `loss_draft` (3.7).
- Retention `life_of_loan_plus_4y`; images with hashes; PII in payee names encrypted.

#### State machine
`reported` → `intake` (documents, policy check, proof-of-loss deadline set) → `track_determined` → `awaiting_proceeds` → `proceeds_received` (instrument endorsed/deposited) → `contents_released` (immediate) → `initial_released` → `repairs_in_progress` (progress inspections → progress releases) → `final_release` (final inspection where required) → `completed` (interest paid; surplus/UPB election; case closed) ; branches: `not_rebuildable` → `applied_to_upb` → `closed` ; `abandoned_or_fc_sale` → `form176_sent` → (`workout_path` | `fnma_review` | `foreclosure_bid_path`) → `remitted_332` → `closed` ; `stale` (no activity 90 days) → outreach/inspection → resume or `preservation` (9.9). Actors: agent; `signing_officer` for endorsements; `fnma_portal_operator` for Form 176 submissions; borrower actions.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_B501_PROOF_OF_LOSS_POLICY` | deadline | `insurance.claim.reported` | loss_date (or insurer request date per policy) | policy days (default 60 calendar_days; NFIP 60 from loss) | `claim.proof_of_loss.filed` (borrower or servicer) | sev-1 at 70%: servicer files under mortgagee clause |
| `INS_CLAIM_CONTENTS_RELEASE_2BD` | deadline (policy on "immediately") | `claim.proceeds.deposited` with contents/ALE portion | deposit | 2 business_days_servicer | `claim.disbursement.released` kind contents_ale | sev-2 |
| `INS_CLAIM_INITIAL_RELEASE_5BD` | deadline (policy) | deposit + repair intent known | deposit | 5 business_days_servicer | initial release | sev-2 |
| `FNMA_B501_FORM176_ABANDONED_5BD` | deadline | learning of damage (abandoned/FC-scheduled, intends to repair) or of decision not to repair | learning date | 5 business_days_servicer | `claim.form176.sent` | sev-1 |
| `FNMA_B501_REMIT_SHORTSALE_332_0` | deadline | `shortsale.closed` | closing date | 0 (at closing) | `remittance.sent` code 332 | sev-1 |
| `FNMA_B501_REMIT_PROCEEDS_REOGRAM_30` | deadline | `reogram.confirmed` (15.x) | confirmation date | 30 calendar_days | code-332 remittance | sev-1 |
| `FNMA_B501_WIRE_POSTREOGRAM_PROCEEDS_10BD` | deadline | proceeds received after REOgram confirmation | receipt | 10 business_days_fannie_et | wire sent | sev-1 |
| `INS_CLAIM_INSPECTION_ORDER_3BD` | deadline (policy) | draw request / 30 days since last progress check | request | 3 business_days_servicer | inspection ordered | sev-3 |
| `INS_CLAIM_STALE_90` | deadline (policy) | last claim activity | activity date | 90 calendar_days | any activity | outreach + property inspection (9.8) |
| `FNMA_F105_INSURED_LOSS_INSPECT_CLAIM_365` | deadline | inspection cost incurred (current loan) | cost date | 365 calendar_days | 15.2 claim filed | sev-3 (cost forfeited) |
| `FNMA_D1301_DISASTER_FC_APPROVAL_5` | deadline (owned by 13.x) | disaster impact determination / pre-referral review complete | — | 5 days (D1-3-01 says "within five days"; 13.x fixes the calendar — default calendar_days) | Fannie Mae submission incl. claim date/status/disbursements from this process | — (13.x) |
| Jurisdiction overrides | | state prompt-release statutes **[UNVERIFIED]** | | | | |

#### Business rules and calculations
1. **Track**: computed at first proceeds receipt and re-evaluated on each release using `fnma_days_delinquent`: `< 31` → `current_lt31`; `≥ 31` → `delinquent_31plus` (plus 12.x workout evaluation); abandoned or foreclosure sale scheduled → `abandoned_or_fc_sale`; `rebuildable='no'` (permit denial/condemnation evidence) → `not_rebuildable` (all proceeds to UPB — curtailment event via Section 2/5; if proceeds ≥ payoff, payoff via 16.x).
2. **Initial release (current)** = max($40,000, round_half_up(33% × total), max(0, total − (UPB + accrued interest + advances))) capped at total; receipts required for prepaid reimbursements only when total > $40,000. **Initial release (delinquent)**: total ≤ $5,000 → total; else min(25% × total, max($10,000, excess over UPB+interest+advances)). **Progress releases (delinquent)**: each ≤ 25% × total and only after an inspection; **final inspection required**; (current) progress releases sized to inspected completion (policy schedule: cumulative release ≤ initial + (pct_complete × remainder)), no final inspection required but the platform performs a remote final check (policy).
3. **Worked example**: proceeds $60,000.00; UPB $240,000.00; accrued interest $1,000.00; advances $0 → excess = 60,000 − 241,000 < 0 → 0. Current loan: initial = max(40,000; 19,800; 0) = **$40,000.00**; remainder $20,000.00 released after an inspection showing completion consistent with the plan (e.g., 70% complete → up to 40,000 + 0.70 × 20,000 = $54,000 cumulative → $14,000 now; balance at completion). Delinquent (45 days): total > 5,000 → initial = min(15,000, max(10,000, 0)) = **$10,000.00**; then ≤ $15,000.00 per inspected increment (e.g., inspections at 25/50/75/100%: 15,000 / 15,000 / 15,000 / 5,000), final inspection before the last $5,000.
4. **Contents/ALE**: amounts the adjuster's statement designates for contents or additional living expenses are released to the borrower "without delay" (2 business days policy) even when the instrument is one check — deposit, then disburse.
5. **Custody and interest**: all undisbursed proceeds in the interest-bearing T&I custodial account; per-loan interest allocation = daily balance × account rate ÷ 365 (decimal.js; posted monthly to `loss_draft_interest_payable`; paid to the borrower at completion or on request). Example: $20,000.00 held 60 days at 4.00% → 20,000 × 0.04 × 60/365 = 131.5068 → **$131.51**.
6. **Endorsement**: instruments payable to the borrower and the mortgagee: borrower endorses first (or portal e-consent where the bank accepts), Supermortgage endorses under the LPOA (`signing_officer` stamp; dual control ≥ $50,000 policy), deposit via the loss-draft lockbox; images stored; `claim_instruments` state tracked; returned/misrouted checks re-requested from the carrier.
7. **Plan review** (staged claims): adjuster estimate, contractor bids (licensed where required), scope match to the estimate, lien waivers at each release, permits when structural; AI reviews documents and flags scope gaps; approval recorded.
8. **Public adjusters/third parties**: no payment from proceeds without Fannie Mae written approval (Form 176 package prepared by the agent; submitted by `fnma_portal_operator`/e-mail; decision recorded).
9. **Abandoned/foreclosure**: Form 176 within 5 business days; proceeds assigned per workout rules; foreclosure bid adjusted (13.x); at REOgram confirmation remit within 30 days via CRS 332 (5.2 rails); later proceeds wired within 10 business days; never net servicer fees.
10. **Remote inspections** (current/< 31): accept authenticated photo/video (GPS + timestamp + hash; app-captured, not uploaded from gallery) matching the adjuster's line items; video-call inspections recorded; otherwise order a vendor inspection ($60 cap reimbursable when required for a release/final).
11. **Uninsured loss** (B-5-02): open `case_type='insurance_claim'` with `policy_id=null`; damage assessment (inspection), preservation if abandoned (9.9), repair plan discussion, disaster-relief assistance, workout evaluation (12.x); no proceeds workflow.
12. **Escrow events**: every `loss_draft_funds` posting emits an escrow event with `escrow_category='loss_draft'` (3.7 emitter; deadline 03:00 ET next fannie_et business day from Dec. 1, 2026).

#### Integrations
- Carriers/adjusters: claim status via carrier portals/e-mail (no standard API) — document intake by e-mail-in and portal; AI voice calls to adjusters (disclosed) logged.
- `lockbox`/`custodial-bank`: loss-draft lockbox images and deposits; interest statements for allocation (6.x).
- `preservation`/inspection vendors: repair inspections (work orders; report PDFs; photos).
- `fnma-crs` (5.2): code-332 remittances; `fnma-p360` (15.x): REOgram confirmation feed; Form 176 → e-mail/upload (`human_portal_task` package: Form 176 fields, photos, estimate, claim data, justification).
- `fnma-servicing-events` (3.7/5.x): loss-draft escrow events.
- Section 12/13/16: workout evaluation, bid instructions, payoff/curtailment.

#### Outputs and artifacts
- Notices (policy; e-delivery with consent, else mail): `INS_LOSS_DRAFT_PACKAGE` (claim requirements, endorsement instructions, disbursement schedule for the track, inspection expectations, interest, contact), `INS_LOSS_DRAFT_RELEASE_LETTER` (each release: amount, basis, remaining balance), `INS_LOSS_DRAFT_FINAL_LETTER` (completion, interest paid, surplus handling), `INS_LOSS_DRAFT_UPB_APPLICATION_NOTICE` (not-rebuildable application or borrower election), `INS_UNINSURED_LOSS_LETTER`.
- Documents: Form 176 package; inspection reports; lien waivers; endorsement images. Ledger: deposits/disbursements/interest per rule 5; curtailment postings (2.x). Investor events: loss-draft escrow events; curtailment events; code-332 remittances. Events: `insurance.claim.reported/intake_complete/track_determined/proceeds.received/instrument.endorsed/deposited/disbursement.released/inspection.completed/form176.sent/completed/closed`, `insurance.uninsured_loss.opened`.

#### AI agent design (AI-first)
- `insurance-property` agent end-to-end: intake (extract adjuster estimates, bids, receipts, lien waivers with vision extraction), track computation, release calculations (pure functions), inspection scheduling and remote-inspection authentication, borrower communication (with `borrower-comms`), Form 176 package preparation, remittance instructions; `cashiering` deposits; `investor-reporting` events. Tools: `openClaim`, `computeReleaseSchedule`, `requestEndorsement`, `depositInstrument`, `releaseFunds`, `orderRepairInspection`, `verifyRemoteInspection`, `prepareForm176`, `remitProceeds332`, `applyToUpb`, `openWorkoutEvaluation`, `escalate`.
- Decision record: {claim, track inputs (delinquency, abandonment, sale), formula inputs/outputs, document hashes, inspection evidence and authenticity checks, approvals, rationale, versions}.
- Guardrails: releases cannot exceed formula limits; no release without the required inspection; no third-party fee payment without a recorded Fannie Mae approval; no netting of servicer expenses; interest always paid; automation disclosure on calls; **legally required human touchpoints**: `signing_officer` endorses physical instruments under the LPOA; `fnma_portal_operator` sends Form 176/uploads; `attorney` for lien disputes, contractor litigation, bankruptcy (proceeds may be estate property — Section 14) and eminent-domain/condemnation; `human_agent` on request; `lossmit_reviewer` where the delinquent-track workout evaluation ends in a denial (12.x).
- AI-off: ops-console claim queue; calculators and timers remain deterministic.

#### Edge cases and failure modes
- Check payable to a prior servicer or MERS: return to carrier for reissue; claim clock continues; interim preservation if needed.
- Borrower and co-borrower dispute (divorce) or successor in interest: endorsement requires all named payees; agent coordinates; `attorney` if a court order governs.
- Bankruptcy: proceeds and releases per plan/trustee; stay considerations on inspections; counsel review before applying proceeds to UPB.
- Loan transfers out mid-claim: transfer the held funds with the T&I balances and the claim file (17.x); transfer-in: board as restricted funds (1.6).
- Proceeds exceed repair cost: surplus released to the borrower after completion (current) or applied per workout/Guide for delinquent loans (policy: borrower election with agent explanation; Fannie Mae review if abandoned).
- Contractor abandons the job: stop releases; inspection; new bids; possible Form 176 if the property is vacant.
- Disaster with insurer insolvency/guaranty fund delays: preservation; forbearance (12.x); Form 176/Fannie Mae consult.
- Remote-inspection fraud indicators (mismatched GPS, edited EXIF): reject and order a vendor inspection; record.
- Escrow-event rejects for loss-draft category: correction events (3.7).

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 9.7-T1 | Given $60,000 proceeds on a current loan with UPB $240,000 Then initial release $40,000; no final inspection required; remote photos accepted if authenticated. |
| 9.7-T2 | Given the same loan 45 days delinquent Then initial $10,000; increments ≤ $15,000 after inspections; final inspection gate before the last release; workout evaluation case opened. |
| 9.7-T3 | Given $4,500 proceeds on a 60-day delinquent loan Then single lump sum. |
| 9.7-T4 | Given a check with $8,000 contents designation deposited Monday Then contents released by Wednesday. |
| 9.7-T5 | Given an abandoned property with damage learned on 2027-03-08 Then Form 176 package sent by 2027-03-15 (5 servicer business days). |
| 9.7-T6 | Given REOgram confirmed 2027-05-03 with $12,000 held Then code-332 remittance by 2027-06-02; a $3,000 supplemental check received 2027-06-10 → wired within 10 fannie_et business days. |
| 9.7-T7 | Given $20,000 held 60 days at 4.00% Then $131.51 interest paid at completion. |
| 9.7-T8 | Given a public adjuster invoice Then release refused until a recorded Fannie Mae approval exists. |
| 9.7-T9 | Given the property cannot be rebuilt (condemnation letter) Then all proceeds applied to UPB as a curtailment; investor event emitted; payoff path if proceeds ≥ payoff. |
| 9.7-T10 | Given a loss-draft deposit on 2026-12-15 Then an escrow event with category loss_draft is accepted by 03:00 ET 2026-12-16. |

#### Audit and evidence
Claim file (all documents with hashes), release calculations and approvals, inspection reports/authenticity checks, endorsement images and LPOA reference, custodial deposit/withdrawal records and interest allocations, Form 176 packages and Fannie Mae responses, remittance confirmations, borrower notices; retention `life_of_loan_plus_4y`; MORA/STAR evidence for B-5-01 compliance.

### Open questions / decisions
1. Progress-inspection cadence for current-loan staged claims — **default: at each draw request, at least every 30 days while open, remote-first**.
2. Dual-control threshold for releases — **default: `officer` co-approval ≥ $100,000 per release** (policy, not regulatory).
3. Delinquent-loan surplus handling after repairs — **default: borrower election with documented explanation; Fannie Mae consult for abandoned cases**.
4. Whether Supermortgage or the partner signs proofs of loss when the servicer files under the mortgagee clause — **default: Supermortgage under the LPOA**.

### Sources
- Servicing Guide B-5-01 (07/12/2023): https://servicing-guide.fanniemae.com/svc/b-5-01/insured-loss-events — verified 2026-09-09
- Servicing Guide B-5-02 (09/09/2020): https://servicing-guide.fanniemae.com/svc/b-5-02/uninsured-loss-events — verified 2026-09-09
- Servicing Guide D1-3-01 (04/08/2026): https://servicing-guide.fanniemae.com/svc/d1-3-01/evaluating-impact-disaster-event-and-assisting-borrower — verified 2026-09-09
- Servicing Guide F-1-05 (06/11/2025): https://servicing-guide.fanniemae.com/svc/f-1-05/expense-reimbursement — verified 2026-09-09
- Servicing Guide A4-2.1-02 (11/12/2014): https://servicing-guide.fanniemae.com/svc/a4-2.1-02/property-inspection-vendor-management-and-oversight — verified 2026-09-09
- LL-2026-05 escrow events (loss-draft category) — research/00a §3.1 and Section 3.7 — 2026-09-09
