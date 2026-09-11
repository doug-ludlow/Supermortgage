# 08b — Servicing: insurance, PMI, ARM, life events, successors, and requests

Owner specs: 9.1–9.x (insurance tracking, force-placement, flood, loss drafts, inspections), 10.1–10.x (PMI), 7.2 (ARM notices), 4.4 (successors in interest), 4.1/4.2 (notices of error, requests for information), 4.5 (complaints), 7.6/16.1 (payoff requests), 8.x (credit reporting disputes), 7.x (privacy, contact changes).

## 1. Insurance (9.x)

Policy states: `pending_verification → verified | deficient → verified; verified → expiring (−60 days) → verified | expired → 9.2; cancelled | nonrenewed → 9.2; replaced; superseded`. Force-placement (hazard track): `opened → first_notice_pending → first_notice_sent (t0) → reminder_eligible (t0+30) → reminder_sent (t1) → evidence_window → chargeable (≥ max(t0+45, t1+15)) → lpi_bound → charged → renewal_notice_due → …`; evidence at any point → `closed_evidence`; cure → cancellation and refund within 15 days (`REGX_1024_37G_FPI_CANCEL_REFUND_15`).

| Event | Thread | Loan section |
|---|---|---|
| `expiring` (−60) | `StatusCard` "Your homeowners policy renews {{date}} — if it renews automatically, nothing to do; if you switch carriers, send the new policy" + `ConnectCard{carrier_connect}` / `UploadCard{homeowners_policy}` (`INS_ANNUAL_REMINDER` where required) | Insurance: renews {{date}} |
| `deficient` | `NoticeCard{INS_DEFICIENCY_NOTICE}` naming the single failing element and the fix | Insurance: needs attention |
| `cancelled | nonrenewed | expired` → `first_notice_sent` | `NoticeCard` (Reg X §1024.37(c) first notice — `REGX_1024_37C_FPI_FIRST_NOTICE_45`): what we have, what we need, the 45-day rule, the cost of lender-placed coverage | badge caution |
| `reminder_sent` | `NoticeCard` (§1024.37(d) reminder — `REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15`; variants `INS_FPI_REMINDER_NOINFO_MS3B` / `_INSUFF_MS3C`) | — |
| `lpi_bound → charged` | `NoticeCard` (`INS_FLOOD_FPI_PLACED_NOTICE` for flood; hazard placement notice) with the charge and how to cancel it by sending evidence | Insurance: lender-placed {{money}}/yr |
| evidence received → `closed_evidence` / refund | `StatusCard` "Coverage confirmed — the lender-placed policy is cancelled and {{money}} refunded to escrow" (`INS_FPI_CANCEL_REFUND_CONFIRM`) | Insurance: verified |
| renewal of an LPI (`REGX_1024_37E_FPI_RENEWAL_NOTICE_45`) | `NoticeCard` | — |

Flood: `in_sfha → coverage_required → covered | deficient → FPI flood track (notice t0 → placement_eligible t0+45 → lpi_placed → terminate_refund ≤ 30 days)`; map change (`INS_FLOOD_MAP_CHANGE_NOTICE`): "your property is now in a flood zone — coverage is required" with the coverage rule; out of SFHA (`INS_FLOOD_REMOVED_NOTICE`): "no longer required; you may keep it".

Loss draft (insured loss): `claim_reported → check endorsement → inspection(s) → staged disbursement → repairs_complete`. Borrower flow: `ChoiceCard` "Report damage" → the assistant collects the claim facts; `HandoffCard{signing_officer}` for endorsing the insurer's check (mail-in instructions); inspections scheduled with `ScheduleCard`; each disbursement posts a `StatusCard`; `INS_LOSS_DRAFT_UPB_APPLICATION_NOTICE` when funds are applied to the balance instead. Disaster in the area: proactive check-in and the 08c disaster options.

## 2. PMI (10.x)

`mi_policies.auto_status`: `pending → terminated (78% scheduled date, loan current — HPA_4902B_AUTO_TERMINATE_0) | deferred_not_current → terminated on cure; midpoint termination`. `pmi_cancel` case: `received → (awaiting_written_confirmation) → evaluating_original_value → eligible → cancellation_issued → closed | value_check_needed → awaiting_fee → valuation_ordered → valuation_received → evaluating | ineligible → denial_issued → closed`.

- Loan section: "Mortgage insurance {{money}}/month · ends automatically {{scheduled date}} · you can ask to cancel from {{cancellation_eligible_on}}" (80% LTV on the original value and a good payment history).
- Annual disclosure `NTC_HPA_4903A3_ANNUAL` (+ CA/MN variants, legacy `_B_ANNUAL_LEGACY`, `NTC_FNMA_MI_ANNUAL_INFO`) as a `NoticeCard`.
- **Ask to cancel** — `ChoiceCard` "Cancel my PMI" → `pmi.requestCancellation` → `pmi_cancel` case; the assistant states the path: eligible on the original value → `NTC_HPA_4904A_CANCELLED` and the refund advice `NTC_MI_REFUND_ADVICE`; a current-value check needed → `ChoiceCard` to pay the valuation fee (`awaiting_fee`; refund if no order placed on withdrawal) → `valuation_ordered` → decision; ineligible → `NTC_HPA_4904B_DENIAL` with the reason and the next eligible date; not current → `NTC_HPA_4904B_AUTO_NOT_CURRENT`. Info requests `NTC_MI_INFO_REQUEST`; case closed `NTC_MI_CASE_CLOSED`.
- Proactive: 60 days before the scheduled termination, `StatusCard` "your PMI ends {{date}} — we'll remove it automatically"; on termination, `StatusCard` with the new payment and any escrow line change (10.5 refund leg `NTC_MI_REFUND_ADVICE`).
- LPMI loans: `NTC_HPA_4905C2_LPMI_OPTIONS` at the applicable date.

## 3. ARM notices (7.2)

`scheduled → index_pending (T−45) → calculated → verified → notice_rendered → notice_sent → effective → reported → closed`; initial notice track `window_open (T−240) → estimated → rendered → sent (by T−210) → awaiting_actual`.

- `NTC_REGZ_20D_ARM_INITIAL` (210–240 days before the first payment at the new rate): `NoticeCard` + Numbers "rate changes {{date}} · estimated new payment {{money}}".
- `NTC_REGZ_20C_ARM_ADJ` (60–120 days before each later change; Fannie Mae `NTC_FNMA_C2_1_02_RATE_CHANGE`): `NoticeCard`; autopay amount change notice follows or is satisfied by the ARM notice (2.x rule 5).
- `NTC_ARM_INQUIRY_INTERIM_20` on a borrower question inside a cycle; corrections `NTC_FNMA_C2_2_01_ARM_CORRECTION`; temporary buydown step notices `NTC_FNMA_C2_1_02_BUYDOWN_STEP_90`.
- Loan section ARM block: index, margin, caps in plain words; next change date; the estimate once `calculated`.

## 4. Life events

### 4.1 Contact and address changes
`party.updateContact` (fresh L1). Address change on a mailing address is also a written request the platform records (`cases{case_type=address_change}` via the Intake Router). Confidential-address program flags (ACP) suppress the property address in notices (1.3 T9 pattern).

### 4.2 Death of a borrower — successors in interest (4.4)
`opened → identifying_successor → documents_described → awaiting_documents → evaluating → (additional_documents_required)* → confirmed | not_successor | withdrawn`; post-confirmation `confirmed → ack_sent → (ack_returned | ack_declined) → (assumption_in_progress → assumed)?`.

- Anyone reporting a death opens the case; the reporter becomes a `potential_successor` party with a limited Record (correspondence only). The assistant describes the documents for the situation (`NTC_REGX_36I_SII_DOCS` / `NTC_REGX_38B1VI_SII_DOCS` — the matrix row for the state and transfer type; a generic list plus the §1024.36(i)(2) statement where no row exists) → `UploadCard`s → `evaluating` → `confirmed` (`NTC_REGX_38B1VI_SII_CONFIRMED` + `NTC_REGX_32C_SII_ACK`: the acknowledgment lets the successor choose whether to receive notices as a borrower) or `not_successor` (`NTC_REGX_38B1VI_SII_NOT_SUCCESSOR` with the reason). Additional documents → `NTC_REGX_38B1VI_SII_ADDL_DOCS`.
- A confirmed successor's Record becomes the full loan home; autopay of the deceased is `terminated` (2.x) and re-enrollment is offered; the assumption offer where applicable (`NTC_FNMA_D1_4_1_02_ASSUMPTION_OFFER`) renders as a `NoticeCard` + `ChoiceCard`.
- Copy is careful and short; no collection language to a potential successor.

### 4.3 Other events
- **Add or remove a borrower / assumption**: typed ask → the `case` agent explains the assumption and release-of-liability path (Fannie Mae D1-4); documents via `UploadCard`s; a release is a `NoticeCard` on completion.
- **Divorce / quitclaim**: title change recorded → occupancy and vesting `ConfirmCard`; a refinance is offered only if the borrower asks (no solicitation from this signal — O1.1 fair-lending posture).
- **Occupancy change (renting the home)**: `ConfirmCard`; insurance requirement changes (landlord policy) flow from 9.x.
- **Disaster declaration** for the property area: proactive `StatusCard` check-in ("Are you and the home OK?") + the disaster options (08c §7); inspections per 9.x.
- **Military service (SCRA)**: `ChoiceCard` "I've been called to active duty" → `UploadCard{military_les|orders}` → SCRA relief applied (rate cap, protections) with a `NoticeCard`; badge "Protected".
- **Representation**: attorney, housing counselor, authorized third party → `InviteCard{party_role}` with the scope explained; `power of attorney` → `UploadCard{poa}`.

## 5. Requests — questions, disputes, payoff, complaints (4.1, 4.2, 4.5, 7.6, 8.x)

Every typed message goes through the Intake Router (4.1): `{noe, rfi, complaint, lossmit_request, sii_inquiry, payoff_request, cease_communication, attorney_representation, bankruptcy_notice, address_change, general_inquiry, other}`; recall-tuned; confidence < 0.6 → `needs_human` (1 BD SLA, ack timer still runs). A message in the app is a **written** request. The assistant answers oral/general questions live from the same read tools and, when the question is about the account, adds the §1024.38(b)(5) line once per session ("if you'd like a formal written answer, I've logged this as a request — here's how that works": `NTC_REGX_38B5_PROCEDURES` link).

### 5.1 Request for information (RFI) — 4.2
`received → triaged → (exception_pending | searching | early_response | awaiting_confirmation_sii) → (extended)? → responded → closed`. Thread: `NoticeCard{NTC_REGX_36C_ACK}` within 5 federal business days (weekends and holidays excluded) with the response date; owner/assignee identity questions answered in 10 (`NTC_REGX_36A2_OWNER_IDENTITY` with the Fannie Mae block); response `NTC_REGX_36D_RESPONSE` / `NTC_REGX_36D_NOT_AVAILABLE` within 30 (+15 with `NTC_REGX_36D_EXTENSION`); exceptions `NTC_REGX_36F2_EXCEPTION` state the basis. Dates: ack by · answer by. The exclusive address (`NTC_REGX_35C_ADDRESS`) is shown once in the Record's Documents and on statements — the app itself is a designated written channel.

### 5.2 Notice of error (NoE) — 4.1
Any assertion that something was done wrong is an NoE even without the word "error". `received → triaged → (exception_pending | investigating | early_correction) → (extended)? → responded → (docs_requested → docs_provided)? → closed`. Thread: `NTC_REGX_35D_ACK` ≤ 5 federal BD (identifies the assertions as understood and the response date; optional helpful documents phrased as optional); response `NTC_REGX_35E_CORRECTION` / `NTC_REGX_35E_NO_ERROR` (with the statement of reasons and the right to request the documents relied on — `NTC_REGX_35E4_DOCS` within 15) / `NTC_REGX_35E_ADDITIONAL_ERRORS`; extension `NTC_REGX_35E_EXTENSION` with reasons; early correction `NTC_REGX_35F1_EARLY_CORRECTION`; exceptions `NTC_REGX_35G2_EXCEPTION`. No fee is ever mentioned as a condition. Credit reporting of the disputed item is suppressed for 60 days (8.x) — the Thread says so. Payoff-statement errors and foreclosure-related errors run on their shorter profiles; the Dates row shows the applicable response date.

### 5.3 Payoff quote — 7.6, 16.1
`received → written_confirmed | oral_only → requester_verified | authorization_pending → calculating → rendered → checked → sent → superseded | closed`. A typed request is written (`REGZ_1026_36C3_PAYOFF_STMT_7BD` starts; Dates "payoff statement by"); a spoken request gets the figure live plus an offer to convert it to written (one tap). `NoticeCard{NTC_REGZ_36C3_PAYOFF_STMT}` (+ CA/FL variants): payoff amount, good-through date, per-diem, wire instructions with the positive-confirmation rule (never by e-mail alone), `NTC_PAYOFF_UPDATED_STMT` on changes, `NTC_PAYOFF_REQUEST_ACK_DELAY` on the reasonable-time path (bankruptcy, foreclosure, disaster). Third-party requesters (a title company, another lender) need the borrower's authorization (`NTC_PAYOFF_AUTHORIZATION_REQUEST` → `ConsentCard`). Continues in 10.

### 5.4 Complaints — 4.5
`received → triaged → investigating → (regulator_interim_sent)? → resolved → responded → closed`. `NoticeCard{NTC_COMPLAINT_ACK}` and `NTC_COMPLAINT_RESPONSE`; a complaint that is also an NoE runs both; New York 419.6 disclosure; California SPOC `NTC_CA_2923_7_SPOC` where applicable. Regulator complaints are invisible to the app beyond the response.

### 5.5 Credit reporting disputes — 8.x
Direct disputes: `NTC_FCRA_1022_43_ACK` → `NTC_FCRA_1022_43E_RESULTS` (or `_F_FRIVOLOUS` with the reason) within the FCRA windows; `NTC_FCRA_1681S2A7_B1/B2` (negative-information notices) render as `NoticeCard`s where required; address-discrepancy notice `NTC_FCRA_1681S2A1C_ADDRESS`.

### 5.6 Cease communication, attorney representation, bankruptcy notice
Typed or spoken → routed; a cease request (FDCPA-covered loans, 11.4) suppresses outbound collection contact and the Thread confirms (`NTC_REGF_1006_6C_CEASE_ACK`); attorney representation reroutes correspondence; a bankruptcy notice opens 14.x (08c §9).

## 6. Human handoff and continuity
Any of the above can start with "human" → `human.request`; complaints with `fair_lending` or `servicemember` flags carry reviewer sign-off internally; the borrower sees the same acknowledgment and response cadence.

## 7. Tests

- **T-08b-01** Given a policy `cancelled` on Mar 1, then the §1024.37(c) first notice renders no later than 3 federal BD (`INS_FPI_FIRST_NOTICE_SLA_3BD`), the reminder ≥ 30 days later, and no charge before max(t0+45, t1+15).
- **T-08b-02** Given evidence of continuous coverage uploaded on day 50 after placement, then the LPI is cancelled and the refund posted within 15 days with `INS_FPI_CANCEL_REFUND_CONFIRM`.
- **T-08b-03** Given a flood map change into an SFHA, then `INS_FLOOD_MAP_CHANGE_NOTICE` renders with the coverage rule and a 45-day placement date in Dates.
- **T-08b-04** Given `pmi.requestCancellation` on a loan at 79% LTV by amortization with a clean 12-month history, then the case reaches `cancellation_issued` without a valuation and `NTC_HPA_4904A_CANCELLED` renders.
- **T-08b-05** Given a value check is needed, then the fee `ChoiceCard` appears, `awaiting_fee` expires at 60 days, and withdrawal before an order refunds the fee.
- **T-08b-06** Given an ARM with the first change on Jul 1, 2028, then `NTC_REGZ_20D_ARM_INITIAL` is sent between Nov 3 and Dec 3, 2027 and Numbers show the estimated payment.
- **T-08b-07** Given a message "my mother passed away, I'm her son", then a 4.4 case opens, the sender becomes `potential_successor`, the documents card renders from the matrix, and no collection language appears in any message to them.
- **T-08b-08** Given a typed message "you charged me a late fee I don't owe", then a `noe` case opens, `NTC_REGX_35D_ACK` is sent within 5 federal BD, credit-reporting suppression is set for 60 days, and the Thread shows the response date.
- **T-08b-09** Given a spoken payoff request, then the quote is given live, no 7-BD clock starts, and the one-tap conversion starts it.
- **T-08b-10** Given a typed payoff request Fri Nov 6, 2026, then `NTC_REGZ_36C3_PAYOFF_STMT` is sent by Tue Nov 17 (servicer business days; Veterans Day closed) with wire instructions carrying the positive-confirmation text.
- **T-08b-11** Given a message that is both a complaint and an assertion of error, then both cases exist and the complaint cannot close before the NoE responds.
