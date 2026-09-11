# 09 — Rate-watch and the re-refinance loop

Owner specs: O1.1 (portfolio rate monitoring and refinance-opportunity detection), O1.2 (solicitation and consent), O1.3 (lead intake — conversion), O1.4 (pricing), O2–O7 (the compressed origination), 16.1/16.2 (same-servicer payoff), 3.5/3.x (escrow transfer on payoff to a new loan with the same servicer — §1024.34(b)), O11 (boarding the new loan), 2.x (autopay on the new loan), 7.4 (consents).

## 1. Rate-watch — the standing state

Every serviced loan is in rate-watch from `loan.boarded`. `refi_opportunities.status`: `detected → offer_ready → offered → converted | declined | expired | suppressed`; borrower-initiated `requested → offer_ready`.

**Record (Loan section, "Rate-watch" block):** "Your rate {{note_rate}} · best rate available for your loan today {{rate_sheet_rate}} · we'll tell you when a change is worth it." Below it, one line on what "worth it" means from the program parameters: at least 25 bps lower and a positive 84-month net benefit with $0 borrower-paid costs (O1.1 default; configuration, not law). No "watching" message is ever sent proactively — the block is passive until an opportunity exists. Suppressed opportunities are invisible.

**Suppression reasons (never rendered as rejections; the block simply stays passive):** inside 120 days of Fannie Mae purchase (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`), cash-out seasoning (`FNMA_B2_1_3_03_*`), Massachusetts 60-month borrower-interest test (`MA_183_28C_BORROWER_INTEREST_60M`), frequency cap (`SM_REFI_OFFER_FREQUENCY_CAP`), 90-day quiet after a decline (`SM_REFI_RESOLICIT_COOLDOWN_90`), unlicensed state (`SM_LICENSE_STATE_GATE`), the daily run not yet complete (`SM_REFI_TRIGGER_DAILY`).

**Borrower-initiated:** "Can I refinance?" / "What would a refinance look like?" → `refi.request` → `requested → offer_ready` (skips the solicitation gates; pricing still passes eligibility) → §2 with the same `OfferCard` and no consent requirement beyond the conversation itself (a response to a borrower's own inquiry is not a solicitation).

## 2. The offer (O1.2)

`offer_ready → offered` within `SM_REFI_OFFER_SLA_2BD`. Channel per consent: in-app card and e-mail (CAN-SPAM footer: advertisement, opt-out link, `partner` postal address) by default; **AI voice or SMS only with `consents{kind=tcpa_voice|tcpa_sms, purpose=marketing}`** (`TCPA_64_1200_A2_PEWC_GATE`); a human click-to-dial under the established business relationship where allowed; quiet hours 09:00–20:00 borrower local; national and company DNC scrubs (`TCPA_64_1200_C2_DNC_SCRUB_31`) are internal.

`OfferCard` content (all fields from `refi_opportunities` and `pricing_quotes`; structure = the O1.2 creative):
- "Your current rate {{current_rate}} → offered rate {{offered_rate}} ({{apr}} APR)"
- "{{term}} monthly principal-and-interest payments of {{money(new_pi)}}; payments do not include taxes and insurance, so your actual payment will be higher" (the LE-style statement O1.2 uses)
- "Saves about {{money(monthly_savings)}} a month"
- "No lender fees and no third-party closing costs charged to you — Supermortgage pays them and they're reflected in the rate" (`costs_to_borrower_cents = 0` program default; if a program ever charges, the line changes to the amount)
- "This is not a commitment to lend; rates change daily"
- "{{partner.legal_name}}, NMLSR ID {{partner.nmlsr_id}}, is your lender; Supermortgage services your loan for {{partner.legal_name}}"
- personalized-terms attribution: `{{mlo.name}}, NMLSR ID {{mlo.nmlsr_id}}` (the offer's terms passed `SM_MLO_PREAPP_TERMS_REVIEW_1BH` under `assisted`)
- "Offer good through {{SM_REFI_OPPORTUNITY_EXPIRY_30.due_at}}"
- Options: **Yes, let's do it** · **Not now** · **Never** (proactive offers)

Responses:
- **Yes** → `lead.created` linked to the opportunity; `refi_opportunities.converted`; `marketing.response.received`; the established-business-relationship inquiry window opens internally (`TCPA_64_1200_F5_EBR_INQUIRY_3M`) → §3.
- **Not now** → `refi.opportunity.declined` → `SM_REFI_RESOLICIT_COOLDOWN_90` (the card says "we'll stay quiet for 90 days; ask any time"); the block stays passive.
- **Never** → `consents{purpose=marketing}` revoked for proactive offers (the card says exactly what stops — proactive offers — and what doesn't — the borrower can still ask; servicing messages continue).
- **Expired** (30 days) → `expired`; re-detection allowed on the next run; nothing is sent about expiry.

The **marketing consent** itself is offered once, after the first funding, as a `ConsentCard{tcpa_voice|tcpa_sms, purpose=marketing}` with the exact consent text ("Yes, {{partner.legal_name}} and Supermortgage on its behalf may call or text me at {{number}} using an automated system or an artificial or prerecorded voice about refinance offers. I understand consent is not a condition of any purchase or loan.") — O1.2 worked example. Without it, offers arrive by e-mail and in-app only.

## 3. Conversion — the compressed application (O1.3, O2.1, O2.2)

The conversation continues in the same thread; the Record adds a second subject ("Refinance in progress") beside "Your loan". What still must happen, and what doesn't:

| Item | Happy path (serviced loan) | Why |
|---|---|---|
| Automation disclosure | already delivered in this session | O1.3 |
| Identity | L1 fresh code; L3 already on file (`SM_IDENTITY_IAL2_GATE` satisfied at the prior origination; re-run only if the vendor's assurance has expired per O3.6 policy) | O3.6 |
| Property | `ConfirmCard` (source=servicing_record): address, occupancy ("still your primary home?") | TRID item; O2.2 rule 2 |
| Existing loan | prefilled from the servicing ledger — no card; the payoff figure is computed internally (16.1) | same servicer |
| Value | `ConfirmCard` (AVM) — accept or state | TRID item |
| Loan amount | `ConfirmCard` payoff-based | TRID item |
| Income | **must be re-stated** — `ConfirmCard` from the standing payroll connection if the borrower kept it (§5), else `ConnectCard{truv_income}` | O2.2 rule 2: income is never taken from the origination file |
| Credit | `ConsentCard{credit_authorization, hard_pull}` — a new hard tri-merge; the servicing ledger's score is only an estimate for benefit modelling | O1.1 design; FCRA |
| Liabilities | `ConfirmCard` from the new report | O3.5 |
| ProfileCard | citizenship/marital/dependents/military re-confirmed as a `ConfirmCard` (source=prior_application) | URLA |
| Declarations | asked again (13 items; one tap) | URLA per application |
| DemographicsCard | asked again | Reg C per application |
| Consents | E-SIGN already active for the servicing scopes → extended to `origination_disclosures` (one tap on the scope statement; 7.4 class rule); no demonstration test repeat unless `suspect` | 7.4 |
| Assets | none unless DU asks | O3.4 |
| Co-borrower | invited if on the existing loan (`InviteCard`); their own confirmations | O2.1 |

→ six items → `application.trid_received` → LE within 3 business days (04) → proceed → lock (04). Borrower time: about three minutes.

## 4. The compressed pipeline (differences from 03–07)

- **Valuation** — value acceptance is common (`offer_recorded`); the Record says "No appraisal needed" or schedules access (06 §2).
- **Title** — a new title order; the existing lien is the platform's own (`payoff_demands` internal); any second lien → SQ-10.
- **Insurance** — the servicing policy record (9.x `verified`) satisfies `evidence_received`; the mortgagee clause is unchanged (same lender of record); nothing to upload unless the policy is `expiring`.
- **Flood** — the life-of-loan determination is reused (`SM_FLOOD_LOL_SERVICING_LINK_2BD`); a new notice only if the status changed.
- **Escrow** — O11.3 same-servicer refinance netting: the existing escrow balance is credited to the new account (`credited_to_new_loan`, §1024.34(b)(2)); the CD shows the transfer; the Thread says "your escrow balance moves to the new loan — no refund to wait for".
- **MI** — new LTV decides; a serviced loan below 80% drops MI (the offer already priced it).
- **Employment re-verification** — standing connection satisfies the VVOE window (`FNMA_B3_3_1_04_VVOE_10BD` via the DU close-by date).
- **CD, closing, rescission, funding** — as 07. **Rescission**: applies to a refinance of a principal dwelling by a different creditor; where the partner was the original creditor and the new loan adds no new money beyond costs, O6.3 may set `not_applicable` (§1026.23(f)(2)) — the UI renders whatever the rescission state says (00 §7). Funding: `disbursed` pays off the old loan internally (16.2 `funds_received → paid_in_full`); no wire to a third party.

## 5. Standing connections (DELTA-05)

After the first funding the platform offers `ConsentCard{blanket_verification_authorization, standing=true}`: "Keep my payroll and bank connections active so a future refinance takes minutes." Effect: the Truv/Plaid connections stay live under the borrower's authorization; data is refreshed only when an opportunity is `offer_ready` and the borrower has said **Yes** (O1.1: no consumer reports for selection; connections are not consumer reports but the same restraint applies — no pulls for selection). Revocable any time from the Loan section. Without it, conversion asks for the connections again. The backend delta is the `standing` flag on `consents` and a retention/refresh policy in O12.3 terms (14 §Deltas).

## 6. New loan live, old loan closed

- `loan.funded` (new) → `StatusCard` `refi.same_servicer.funded`: "Done. Your new rate {{rate}} is live. Your old loan is paid off; your escrow balance moved over; your new payment is {{money}} starting {{date}}. Autopay: {{carried over / please re-authorize}}."
- Old loan: `paid_in_full → remitted → housekeeping_complete → closed` (16.2); lien release and MERS deactivation (16.3/16.4) run; `NTC_PAYOFF_PAID_IN_FULL` and `NTC_LIEN_RELEASE_RECORDED` render on the old loan's Documents; the old loan's final 1098 issues in January.
- Autopay: the old enrollment is `terminated` at payoff; a new `ConsentCard{autodraft_authorization}` for the new loan (07 §6) — the card prefills the same account and day so it is one signature.
- Record: the header switcher shows both loans; the old one is read-only under *Earlier loans*; the new one becomes "Your loan" and re-enters rate-watch, passive for 120 days (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`).
- Both threads (if a co-borrower) receive the completion message.

## 7. Rules carried through the loop
No promise of future terms at any point (B2-1.3-04: a "self-improving" contractual promise is a prohibited prearranged refinancing agreement — the block's copy describes monitoring and offers, never a guarantee); each refinance is a new application with its own LE and CD; "best possible rate", never "guaranteed"; cash-out is never solicited (a borrower may ask); the AI never negotiates — it presents approved terms and takes a yes or no; personalized terms always name the MLO of record; no investor-aware logic or copy anywhere (no "because Fannie Mae owns your loan").

## 8. Tests

- **T-09-01** Given `loan.purchased` on Nov 19, 2026, then no `OfferCard` exists before Mar 19, 2027 regardless of rates (`FNMA_C1_1_01_PREMIUM_RECAPTURE_120`); a borrower-initiated `refi.request` in that window produces `offer_ready` with the recapture acknowledgment internal only.
- **T-09-02** Given `offer_ready` and no marketing consent, then delivery is e-mail + in-app only; no `tcpa_voice` call or SMS is attempted; a human click-to-dial is permitted under the EBR (O1.2 worked example 1).
- **T-09-03** Given the `OfferCard`, then it contains every field in §2 and no "guarantee"; the MLO attribution is present; the expiry equals `SM_REFI_OPPORTUNITY_EXPIRY_30.due_at`.
- **T-09-04** Given **Not now**, then `refi.opportunity.declined` and no proactive offer for 90 days; a typed "can I refinance?" on day 10 still yields `offer_ready`.
- **T-09-05** Given **Never**, then `consents{purpose=marketing}` is revoked, servicing informational consent remains, and the Rate-watch block stays passive.
- **T-09-06** Given **Yes**, then the compressed application asks income (fresh statement), hard-pull authorization, declarations and demographics again, and does not re-ask address (ConfirmCard from `servicing_record`) or identity documents; `application.trid_received` fires on the sixth confirmation.
- **T-09-07** Given the same-servicer funding, then the old loan reaches `paid_in_full` without a third-party wire, the escrow balance is `credited_to_new_loan`, and the Thread message says so; `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` is satisfied by the credit.
- **T-09-08** Given the partner was the original creditor and the new loan is rate/term, then the rescission state is whatever O6.3 computes and the UI renders no cancel window when `not_applicable`.
- **T-09-09** Given a standing connection consent revoked from the Loan section, then the next conversion creates `ConnectCard{truv_income}` again.
- **T-09-10** Given any Rate-watch copy, then it contains no reference to the investor and no future-terms promise (string tests on the copy library).
