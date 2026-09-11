# 10 — Exits

Owner specs: 7.6 (payoff request), 16.1 (payoff engine), 16.2 (funds, paid in full, remittance), 16.3 (lien release), 16.4 (MERS), 3.5 (escrow on payoff), 7.x (final 1098), 17.x (servicing transfer out), 1.3 (hello/goodbye — mirrored), 4.4 (successors), 12.9/13/15 (liquidation), O12.3/19.x (records access after closure).

## 1. Payoff (sale, refinance elsewhere, lump sum)

### 1.1 Quote
08b §5.3 governs the request. Quote engine states (16.1): `computing → gated → computed → rendered → active → superseded | expired | relied_upon | void`. The `NoticeCard{NTC_REGZ_36C3_PAYOFF_STMT}` shows: total payoff, good-through date, per-diem, components (principal, interest to the date, escrow handling, fees, any late charge/NSF, recording fee for the release where charged), wire instructions **with the positive-confirmation rule**: "call the number on your statement to confirm these instructions before sending; we never change wire instructions by e-mail." A refinancing lender or title company requesting on the borrower's behalf needs the borrower's authorization (`NTC_PAYOFF_AUTHORIZATION_REQUEST` → `ConsentCard`). Updates → `NTC_PAYOFF_UPDATED_STMT`. New Jersey: `NTC_NJ_CANCELLATION_RIGHT` where applicable.

### 1.2 Funds and paid in full (16.2)
`funds_received → held | cleared → matched | unmatched → applied_full → paid_in_full → remitted → housekeeping_complete → closed`; branches `applied_short → shortage_demand → cured | absorbed | uncured_30d`, `applied_over → overage_refund_pending → refunded`, `reversed_pre_close`.

| Event | Thread | Record |
|---|---|---|
| `funds_received` | `StatusCard` "Payoff funds received {{date}} — {{money}}" | badge "Paying off" |
| `applied_short` | `NoticeCard{NTC_PAYOFF_SHORTAGE_DEMAND}`: the difference, the reason (per-diem past good-through; a fee), how to send it; `uncured_30d` → the funds are applied per the note and the loan stays open (the card says so at day 20) | Needed-from-you: shortage |
| `applied_over` | `NoticeCard{NTC_PAYOFF_OVERAGE_REFUND_ADVICE}`; refund posted | — |
| `paid_in_full` | `NoticeCard{NTC_PAYOFF_PAID_IN_FULL}`; autopay `terminated`; `FNMA_NIB_BALANCE_NOTICE` if a deferred non-interest-bearing balance was included | badge "Paid off"; Numbers: balance 0 |
| escrow refund (3.5) | `StatusCard` "Your escrow balance of {{money}} is being refunded — check mailed / deposited by {{REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD.due_at}}" (same-servicer refinance: credited instead — 09) | Dates |
| lien release (16.3) | `opened → (awaiting_custody_docs) → prepared → awaiting_execution → executed → notarized → submitted → recorded → borrower_notified → mers_deactivation_pending → closed`; `NoticeCard{NTC_LIEN_RELEASE_RECORDED}` with the recording reference; trustee/public-trustee paths (CA/WA/CO) explained in the notice; state deadline shown in Dates | Documents: recorded release |
| eNote | `NTC_ENOTE_PAPER_COPY` where a state requires a paper copy of the eNote marked paid; paper note → `NTC_NOTE_RETURNED` | Documents |
| final 1098 | January; `NTC_IRS_1098` | Documents |
| `closed` | `StatusCard` "Your loan is closed. Your documents stay here." | badge "Closed"; Record read-only; the Thread remains open for questions (RFI/NoE rights survive per 4.x) |

Rate-watch ends (`refi_opportunities.void`). Records remain accessible to the borrower for the retention period (O12.3 / 19.x); the party's other loans are unaffected.

## 2. Transfer out (17.x)

When the master servicer moves servicing to another subservicer or sells the MSR: `transfer_batches.status` and the goodbye run (`planned → rendered → qc_passed → released_to_vendor → mailed → complete`) are internal; the borrower sees:

| Timing | Thread | Record |
|---|---|---|
| ≥ 15 days before the transfer date | `NoticeCard{NTC_REGX_1024_33B_GOODBYE_MS2}` (or the combined notice `NTC_REGX_1024_33B_COMBINED_MS2` when the transferee joins in one letter): transfer date, the new servicer's name, address and toll-free number, the date Supermortgage stops accepting payments, the 60-day protection, that terms don't change | badge "Servicing moving to {{new servicer}} on {{date}}"; Dates: last Supermortgage payment date · new servicer's first date · protected window ends |
| autopay | `StatusCard`: enrollments `terminated` at cutover; the last debit is no later than the last pre-cutover due date; "set up autopay with {{new servicer}} after {{date}}" | Loan: autopay ends {{date}} |
| escrow | short-year statement `NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR` | Documents |
| during the 60 days after | payments sent to Supermortgage are forwarded (`NTC_REGX_1024_33C_MISDIRECTED_PAYMENT_RETURN` when returned instead) and count as on time (`REGX_1024_33C1_LATE_FEE_PROTECTION_60`) — the Thread says "you're protected; but update your payments to {{new servicer}}" | badge "Transferred out"; Record read-only after cutover |
| corrective notice | `NTC_REGX_1024_33B_CORRECTIVE` if a date or address changes | — |

Open requests (RFI/NoE), loss-mitigation applications with their received dates, bankruptcy and SCRA statuses carry to the transferee in the transfer file (17.3); the Thread tells the borrower which items moved and that the new servicer owns them. The conversation stays available read-only; a party with another Supermortgage loan keeps the full thread for that loan.

## 3. Successor (death of the last borrower) — 4.4
08b §4.2 governs confirmation. After `confirmed`: the successor may continue paying (full Record; autopay re-enrollment), assume the loan where offered (`NTC_FNMA_D1_4_1_02_ASSUMPTION_OFFER` → assumption flow), or pay off (§1). Communications choice from `NTC_REGX_32C_SII_ACK` is respected (a successor who declines borrower notices still gets §1024.36/.35 responses to their own requests).

## 4. Liquidation (12.9, 13, 15)
Short sale → `closed → liquidated`: `NoticeCard` with the settlement outcome and relocation assistance where applicable; mortgage release → `deed_recorded → released → reo_conveyed`: the release of personal liability and any relocation payment (≤ 30 days) as `NoticeCard`s; foreclosure sale → the post-sale notices required by state law; in all cases the Record shows "Closed" and the documents stay accessible; credit reporting per 8.x is stated once. Eviction, REO and claims are invisible.

## 5. Tests

- **T-10-01** Given a typed payoff request, then `NTC_REGZ_36C3_PAYOFF_STMT` renders within 7 servicer business days with the components, good-through date and the positive-confirmation text; a rate change before funds → `NTC_PAYOFF_UPDATED_STMT`.
- **T-10-02** Given funds $300 short of the good-through figure, then `NTC_PAYOFF_SHORTAGE_DEMAND` renders; cured → `paid_in_full`; uncured at day 30 → funds applied per the note and the loan stays open with a `StatusCard` explaining.
- **T-10-03** Given `paid_in_full` on Mar 3, then the escrow refund is scheduled by Mar 23 (`REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD`), autopay is `terminated`, and rate-watch is `void`.
- **T-10-04** Given a California trustee-path release, then the `NTC_LIEN_RELEASE_RECORDED` copy explains the reconveyance path and Dates shows the state deadline.
- **T-10-05** Given a goodbye notice mailed Sep 16 for an Oct 1 transfer, then `REGX_1024_33B3_COMBINED_15` is satisfied, the badge and Dates update, and autopay shows its end date (1.3 T1).
- **T-10-06** Given a payment received by Supermortgage on Oct 14 after an Oct 1 transfer, then the Thread states the payment is forwarded and protected; on day 61+ the protection text is absent.
- **T-10-07** Given a confirmed successor who declined borrower notices, then no statements are sent to them, but an RFI they submit is acknowledged and answered on the 4.2 clocks.
- **T-10-08** Given `closed`, then the Record is read-only, documents remain downloadable, and a new typed question still creates a case.
