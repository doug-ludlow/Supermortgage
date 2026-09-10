# 5.3 — Reporting liquidations (payoff/foreclosure/short sale)

| Attribute | Value |
|---|---|
| Section | 5 — Investor Reporting & Remittance (Fannie Mae) |
| Automation class | b |
| Trigger & frequency | On event |
| Governing source | FNMA IRM 2-04 |
| Key deadlines | Action codes 60/65/70 per event |
| Timers | `FNMA_E4101_REOGRAM_CONFIRM_1BD`, `FNMA_F120_SHORTSALE_PROCEEDS_2BD`, `FNMA_IRM_LIQ_AC70_72_NEXTBD_2000`, `FNMA_IRM_PAYOFF_AC60_NEXTBD_2000`, `FNMA_IRM_REMOVAL_CORRECTION_BD2_1700`, `FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD`, `FNMA_P360_REOGRAM_EXCEPTION_3BD`, `SM_DRA_RECONCILE_7CD`, `SM_LIQ_CODE_CHANGE_CPM_2BD`, `SM_PAYOFF_GOODFUNDS_GATE` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Investor Reporting |
| Trigger & frequency | On event |
| Governing source (blueprint) | FNMA IRM 2-04 |
| Key deadlines (blueprint) | Action codes 60/65/70 per event |
| Data/artifacts | LAR |
| Systems | CRS, DRA |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Supermortgage reports and remits under the partner's servicer number; the retained law firm (not the servicer) enters foreclosure milestones in DRA; REOgram confirmation in Property 360 is a Supermortgage portal task |
| Nuances (blueprint) | [cropped in source] — reconstructed: removal clock (next BD 8 p.m. / BD2 5 p.m.); action code set is 60/65/67/70/71/72; proceeds routing by CRS code; no payoff reactivation after close; liquidation events move to Property 360 under LL-2026-05 |

### Verified requirement (as of 2026-09-09)

**Action codes and content (IRM Apr. 8, 2026, Ch. 2 §2-04, pp. 19–26).** *Payoff — code 60:* "the servicer must submit a LAR with an Action Code 60 on the first business day after the servicer processes the transaction on its system"; interest by remittance type (A/A from LPI up to but not including the payoff date, months ÷12 and days ÷365; S/A one-half month ÷24; S/S one full month ÷12 — no full month if processed BD1 and reported by BD2, F-1-20). *Liquidations:* **70** "Charge-off/Liquidated Held for Sale for Uninsured Properties" — foreclosure sale held with Fannie Mae acquiring, redemption, Mortgage Release acquisition, VA no-upset; **71** "Liquidated Third-Party Sale / Condemnation / Short Sale" — third-party purchaser at foreclosure, condemnation, short sale completion, Fannie Mae-authorized second-lien charge-off; **72** "Charge-off/Liquidated – Foreclosure Sale Held for Insured Properties" — foreclosure/redemption/Mortgage Release where conveyance to FHA/VA/MI is pending. Action date "within current activity period." Principal reported = prior month's actual UPB (A/A except biweekly, S/A) or prior month's scheduled UPB (S/S) × Fannie Mae's percentage interest, **adding any principal forbearance before multiplying** (omitting it hard-rejects). Interest reported: A/A — $0.00 with no LPI movement, Σ(prior UPB × PTR ÷ 12) × % for each payment with forward movement, negative of that with backward movement (biweekly uses ÷24); S/A advancing — prior scheduled UPB × % × PTR ÷ 12; S/A recovering — total advanced interest × (−1) (with forward LPI, × periods; with backward LPI, (total advanced + monthly) × (−1)); S/A not advancing — prior actual UPB × PTR ÷ 12 × (−1); S/S — prior scheduled UPB × % × PTR ÷ 12. "Upon completion of a foreclosure and acceptance of the foreclosure LAR, Fannie Mae will reimburse the servicer for advanced P&I for scheduled/scheduled remittance type mortgage loans for which Fannie Mae bears the foreclosure loss risk" (p. 24). Code 70 removals also report proceeds as a special remittance.

**Clock (IRM p. 11; C-4.3-01):** removal transactions ("payoffs, repurchases, foreclosures, short sales, deeds-in-lieu, and third party sales") by 8 p.m. ET the first business day after processing, or **5 p.m. ET when that day is BD2**; corrections by 5 p.m. ET BD2; bulk cut-off 3 p.m. ET BD2. **Finality (IRM 4-08, 04/08/2026; SVC-2026-03 eff. July 1, 2026):** no update to action code 60 after the period closes — the loan is not reactivated and the servicer must remit/advance to liquidate; liquidation code changes go to the SF CPM division (70→71: CPM cancels the REOgram; 71→70/72: submit a REOgram to CPM); repurchase action-date changes require written justification.

**Cash side (F-1-20, 03/11/2026; CRS codes Oct. 15, 2025):** payoff proceeds per 5.2 (A/A > $2,500 immediately; S/A by the 20th of the following month; S/S on the 18th/RPM/BD4); short-sale proceeds CRS **357** (+ **324** borrower contribution) within 2 BD of receipt and ≤3 BD after the sale; third-party foreclosure sale proceeds **311** (curtailment 351) up to the total indebtedness (UPB + PTR interest from the LPI due date to the later of liquidation or settlement), never surplus; REO sales proceeds **310**, redemption **314**, escrow balances of liquidated loans **317**, hazard refunds **318**, MI refunds **336**; settlements **309** on the next remittance date.

**Property 360 / REOgram / DRA (research/00b F5, F7; REOgram User Guide June 24, 2026; DRA User Guide July 25, 2023):** REOgram cases are auto-created from SIR action codes 70/72 and from DRA foreclosure-sale events entered by the law firm; the servicer must "review and confirm the REOgram notification in Property 360 within one (1) business day" (E-4.1-01) and resolve exceptions within 3 BD; confirmed cases move to Accepted at 7 p.m. ET and fields stay editable for 5 BD. Third-Party Sale cases are auto-created for liquidation reconciliation and the servicer uploads TPS documentation. "Only firms can enter data in DRA"; servicers view only. **LL-2026-05:** liquidation events (Government Conveyance, REO, Third-Party Sale) will be reported directly to Property 360 (eliminating REOgram duplication); foreclosure reporting events "no later than the next business day after the event is processed"; CIT window for Enhance & Expand Liquidation Reporting 10/08/2026–03/12/2027 and go-live 02/20–03/15/2027 **[PARTIALLY VERIFIED — see 5.1]**.

**Delinquency-status linkage (F-1-21):** codes 17 (short sale approved/offer received), 15 (short sale approved/marketing), 44 (Mortgage Release), 30 (third-party sale), 71 (foreclosure sale scheduled), 43 (foreclosure), 29 (charge-off) — reported in 5.7 in the cycle of the action; 20 (reinstatement) when partial reinstatement funds are accepted in foreclosure.

**Discrepancies with the blueprint row:** action codes are 60/65/67/70/71/72 (not 60/65/70; 65/67 belong to 5.6); the systems are LSDU (LAR), CRS (proceeds), Property 360 (REOgram/TPS reconciliation/future liquidation events) and DRA (attorney-entered milestones, read-only for us); the removal clock and SVC-2026-03 finality are missing; automation is (a) for our reporting and (b) only because REOgram confirmation and DRA are portal-bound.

### Operational prerequisites
- Property 360 roles for Supermortgage employees (`PROP360-PROD-REOGRAM-DECISION`, read-only, claims) under the partner's servicer number; DRA read access ("Default Reporting Application Access Request"); Form 101 scoped to P360/DRA — Owner: partner CA; 2–4 weeks.
- Law-firm retention agreements (A4-2.2; Form 200 no-objection ≤15 BD) that oblige the firm to (i) enter DRA events within Fannie Mae's timelines and (ii) transmit every DRA event and its data points to Supermortgage's `attorney-network` adapter within 1 BD — Owner: partner (retains counsel) with Supermortgage managing; artifact: retention agreement addendum.
- CRS drafting instructions for 3xx special-remittance codes linked to the correct custodial account — Owner: `fnma_portal_operator`.
- Good-funds policy for payoffs (Section 16.1/16.2): wire vs. check clearing rules that gate the action-code-60 projection.
- MI/FHA/VA insurance flags on `loans` (drives 70 vs 72) and Fannie Mae loss-risk indicator (regular vs special servicing option) on boarding.

### Build spec
#### Inputs and triggers
- `payoff.funds.cleared` (Section 16.2), `shortsale.closed` (Section 12.9), `dil.deed.recorded`/`mortgage_release.completed`, `foreclosure.sale.held` with purchaser type (attorney feed + Section 13), `condemnation.proceeds.received`, `chargeoff.approved` (Fannie Mae-authorized), `redemption.completed`.
- Inbound: attorney DRA milestone copies (`attorney-network`), Property 360 REOgram/TPS case notifications (email/API where exposed; else portal), CRS confirmations, Fannie Mae Connect REO/liquidation reports.
- Schedules: weekly DRA reconciliation task; daily 07:00 ET P360 case check.

#### Data model
- `liquidation_facts`: `loan_id`, `case_id`, `liquidation_type` ∈ {payoff, short_sale, mortgage_release, fcl_third_party, fcl_fnma_acquired, condemnation, charge_off, redemption}, `legal_date` (sale/closing/deed date), `processed_at`, `purchaser` ∈ {borrower, third_party, fnma, insurer}, `insured_flag` ∈ {none, mi, fha, va}, `fnma_loss_risk` (bool), `proceeds_cents`, `proceeds_received_at`, `action_code` (60/70/71/72), `reported_event_id` (FK `investor_events`), `reo_case_id`, `tps_case_id`, `reported_late` (bool), `notes`.
- `dra_milestones`: `loan_id`, `firm_id`, `dra_event_name`, `event_date`, `data_points` (jsonb), `source` ∈ {attorney_feed, dra_export, p360_signal}, `received_at`, `matched_case_event_id`, `mismatch_reason`.
- Reuse `investor_events` (family `removal`), `remittances`/`crs_batches` (5.2), `cases` (`case_type` ∈ {payoff, shortsale, dil, foreclosure}), `timers`.

#### State machine
Per liquidation: `fact_recorded` → `code_selected` (70/71/72/60 chosen and amounts computed) → `reported` (removal event submitted) → `accepted` (Fannie Mae ack; loan flagged inactive for reporting) → `proceeds_remitted` (CRS special remittance instructed and matched) → `reo_confirmed` (for 70/72: REOgram confirmed in P360 within 1 BD) or `tps_reconciled` (for 71 third-party: TPS documentation uploaded) → `closed` (delinquency-advance reimbursement matched; code-change window passed). Side states: `correction_pending` (before BD2 17:00 ET), `code_change_cpm` (after close; SF CPM notification), `payoff_final_error` (post-close payoff error — remit/advance path).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_IRM_PAYOFF_AC60_NEXTBD_2000` | deadline | `payoff.funds.cleared` processed | processed_at | next `fannie_et` BD 20:00 ET (17:00 if BD2) | `removal.payoff` submitted | sev-1 |
| `FNMA_IRM_LIQ_AC70_72_NEXTBD_2000` | deadline | liquidation fact processed | processed_at | next BD 20:00 ET (17:00 if BD2) | `removal.liquidation.*` submitted | sev-1 |
| `FNMA_IRM_REMOVAL_CORRECTION_BD2_1700` | deadline | exception/error on removal | period end | BD2 17:00 ET | superseding event accepted | sev-1; payoff becomes final |
| `SM_PAYOFF_GOODFUNDS_GATE` | not_before_gate | `payoff.funds.received` | receipt | until `payoff.funds.cleared` | — | AC 60 projection blocked |
| `FNMA_E4101_REOGRAM_CONFIRM_1BD` | deadline | REOgram case created (P360 notice / AC 70-72 acceptance / DRA sale event) | receipt | 1 `business_days_fannie_et` | `human_portal_task` completed with P360 confirmation | sev-1 (delayed REOgram fee, CRS code 313) |
| `FNMA_P360_REOGRAM_EXCEPTION_3BD` | deadline | REOgram exception raised | raised_at | 3 BD | exception resolved | sev-2 |
| `FNMA_F120_SHORTSALE_PROCEEDS_2BD` / `FNMA_F120_TPS_PROCEEDS_NEXT_REMIT` | (5.2) | | | | | |
| `FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD` (future) | deadline | foreclosure/liquidation event processed | processed_at | next BD (03:00 ET per event standard) | P360 liquidation event accepted | sev-1 |
| `SM_DRA_RECONCILE_7CD` | recurring | weekly | Monday 09:00 ET | 7 calendar days | reconciliation run recorded | sev-3 |
| `SM_LIQ_CODE_CHANGE_CPM_2BD` | deadline (internal) | code change needed after close | detection | 2 BD | CPM notification sent (human) | sev-2 |

#### Business rules and calculations
1. **Code selection matrix:** payoff in full by borrower/closing agent → **60**; short sale, condemnation, third-party purchaser at foreclosure, Fannie Mae-authorized second-lien charge-off → **71**; foreclosure sale with Fannie Mae acquiring, redemption, Mortgage Release, VA no-upset → **70** if `insured_flag = none` else **72** (MI/FHA/VA conveyance pending). Repurchases → 65/67 (5.6).
2. **Amounts:** principal = (prior actual or scheduled UPB per remittance type + non-interest-bearing forbearance) × participation; interest per the IRM table above; other fees = collected fees. For payoffs the LAR reflects the payoff amounts and LPI advanced to the payoff month.
3. **Action date:** the legal liquidation date when it lies within an open activity period; if the fact arrives after that period closed, report in the current period with the true date recorded in `liquidation_facts.legal_date` and `reported_late=true`, and let the agent confirm the action date convention with the Investor Reporting Representative **[PARTIALLY VERIFIED — IRM only says "within current activity period"]**.
4. **Worked example (S/S MBS, third-party sale):** scheduled UPB after the 5.1 example's fifth missed installment = $249,088.61; foreclosure sale held Wed Oct 14, 2026, third-party bid $210,000.00 received Thu Oct 15. LAR 96 code **71**, action date 10/14/26, principal `0024908861{`, interest = 249,088.61 × 0.06 ÷ 12 = **$1,245.44** (`0000124544{`), UPB zero-filled with the reported principal removing the loan; due Fri Oct 16 20:00 ET (processed Oct 15). Proceeds: CRS code **311** for $210,000.00 instructed by Fri Oct 16 16:00 ET (settles Mon Oct 19); indebtedness = 249,088.61 + PTR interest from the LPI due date to the later of sale/settlement — proceeds are below it, so the entire $210,000 goes to Fannie Mae and a TPS case is reconciled in P360. Outstanding delinquency advances (four drafts, $5,904.58, plus SDA-period receivables) are reimbursed by Fannie Mae after LAR acceptance — expected as a credit on the next draft notification/cash-adjustment report and matched in 5.2.
5. **A/A liquidation with no LPI movement:** interest $0.00, principal = prior actual UPB × participation; proceeds by code.
6. **Payoff finality guard:** `removal.payoff` is projected only from `payoff.funds.cleared`; the `payoff-release` agent must attach the payoff statement, funds evidence and the interest calculation (A/A daily accrual; S/A half month; S/S full month with servicer-funded shortfall); a reversal of cleared funds before BD2 17:00 ET produces a correcting event; after close the loan is marked `fnma_liquidated_in_error`, the amount Fannie Mae is owed is remitted/advanced per 5.2, a `qc_finding` case opens, and the ledger continues to service the borrower (see Open questions).
7. **DRA reconciliation:** weekly, match `dra_milestones` (from the firm's feed and any `human_portal_task` DRA export) to our `case_events` (referral, first legal, sale scheduled, sale held, eviction, etc.); any DRA sale-held event without our `foreclosure.sale.held` within 1 BD → sev-1 (a REOgram will appear); any of our sale events without a DRA entry within 2 BD → task to the firm; discrepancies feed Section 13.5 (compensatory-fee allowable-delay defense requires accurate DRA milestones).
8. **REOgram/TPS package:** for 70/72 the agent prepares the P360 confirmation package (loan, sale date, bid, occupancy, insurance, HOA, keys/vendor contacts, MI claim status) for the `fnma_portal_operator`; for 71 third-party sales it uploads TPS documentation (bid/settlement statement, proceeds remittance confirmation) — Section 15.1/15.2 own the downstream claims.
9. **Future rail:** when `investor_reporting.removal.liquidation.*.mode = event`, the same `liquidation_facts` row projects a Property 360 liquidation event (Government Conveyance / REO / Third-Party Sale) instead of LAR 70/71/72 (JSON schema **[UNVERIFIED — from the technical specifications zip at credentialing]**), and REOgram confirmation is expected to be subsumed.

#### Integrations
- `fnma-lsdu` (LAR 96 removal records; 5.1 channels and clocks); `fnma-crs` (special remittances; 5.2 portal task); `fnma-p360` (REOgram/TPS — portal task for confirmation; APIs only where the Developer Portal exposes them, none for REOgram per the June 24, 2026 user guide); `attorney-network` (firm case-management feed of DRA events; format per firm/vendor **[UNVERIFIED]**); DRA itself — read-only UI; periodic export by `fnma_portal_operator` if the UI offers one **[UNVERIFIED]**, otherwise rely on the firm feed and P360 signals. Failure modes: no firm feed → weekly manual DRA review task; P360 outage → document and confirm on the next BD with outage evidence.

#### Outputs and artifacts
- Removal `investor_events`, `liquidation_facts`, CRS batches (311/351/357/324/310/314/317/318/336), P360 confirmation evidence, TPS documentation, DRA reconciliation reports, `qc_finding` cases for post-close errors.
- Ledger: loan ledger closes (principal/interest/escrow/fees to zero or to `deficiency_receivable`/`corporate_advances` write-off per Section 15); custodial: proceeds Dr `custodial_pi_cash` Cr `fnma_remittance_payable` then draft; delinquency-advance reimbursement Dr `custodial_pi_cash` (or corporate) Cr `servicer_advance_receivable`.
- Investor events: `removal.payoff`, `removal.liquidation.uninsured|third_party|insured`, plus `delinquency.status` codes 17/15/44/30/71/43/29/20 in 5.7.
- No borrower notices (payoff/lien-release notices are Section 16).

#### AI agent design (AI-first)
`investor-reporting` agent (removal reporting and code selection), `payoff-release` agent (payoff facts and interest), `claims-reo` agent (REOgram/TPS packages), `foreclosure-ops` agent (DRA reconciliation with firms). Tools: `selectLiquidationCode`, `computeRemovalAmounts`, `projectEvent`, `buildCrsBatch`, `prepareReogramPackage`, `reconcileDra`, `draftCpmNotice`, `recordDecision`. Decision record: `{loan_id, liquidation_type, insured_flag, code, legal_date, action_date, amounts, proceeds_routing, evidence[], confidence}`. Guardrails: never project AC 60 without cleared funds; never change a removal after BD2 17:00 ET; code-change requests to SF CPM and readd requests are drafted by the agent and sent by `fnma_portal_operator`/`officer`; confidence < 0.9 on 70 vs 71 vs 72 (e.g., unclear purchaser or insurance status) → hold and escalate to `claims-reo` human reviewer (`human_agent` role) before the deadline − 4h. Escalations: `fnma_portal_operator` for REOgram/TPS/DRA/CRS UI steps; `attorney` when DRA data must be corrected by the firm; `officer` for post-close payoff errors (funding decision). Toggle-off path: deterministic code matrix with human confirmation in `ops-console`.

#### Edge cases and failure modes
- **Sale rescinded/set aside** after LAR 71/70 accepted: within the period → correcting event and CPM notice; after close → SF CPM code-change/re-add process (`readd_requests@fanniemae.com`), REOgram cancellation.
- **Third-party sale falls through:** proceeds still remitted "regardless of whether or not the sale is finalized or falls through" (F-1-20); refund via Fannie Mae claim.
- **Bankruptcy filed between sale and reporting:** report the sale as held if legally completed; otherwise hold and escalate to `attorney`.
- **SCRA:** foreclosure sale during protected period is a legal defect — Section 13.8 gates the sale; reporting never precedes the gate.
- **Payoff by closing agent (S/S):** payoff date = settlement date even if funds arrive later — projector uses `settlement_date`; good-funds gate satisfied by the closing agent's wire confirmation.
- **Partial payoff/short payoff without approved short sale:** not a removal; hold in suspense (Section 2) and escalate.
- **Deferral/forbearance balances:** add non-interest-bearing balance to reported principal or the LAR hard-rejects.
- **Transfer-out during foreclosure:** transferee reports the liquidation; TT32 must precede; DRA firm reassignment.
- **MBS Express pools:** unscheduled principal from payoffs/removals drafted BD4 of the following month — funding gate.
- **Disaster areas:** foreclosure referral requires Fannie Mae prior written approval (LL-2026-01) — a sale reported without it is a Section 13 compliance event, flagged by `compliance-sentinel`.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 5.3-T1 | Given payoff funds wired and cleared Thu Oct 15, 2026 on an A/A loan ($199,500, PTR 6%, LPI Sept 1, payoff date Oct 16), then LAR 96 code 60 with interest $1,489.42 is submitted by Fri Oct 16 20:00 ET and CRS 001 for UPB + interest (> $2,500) is instructed the same day. |
| 5.3-T2 | Given a payoff processed Mon Nov 2, 2026 (BD1), then the AC 60 deadline is Tue Nov 3 17:00 ET and, for an S/S loan, no full-month interest is charged if reported by BD2. |
| 5.3-T3 | Given an MI-insured conventional loan foreclosed with Fannie Mae acquiring, then code 72 is selected; uninsured → 70; third-party purchaser → 71 with CRS 311 proceeds. |
| 5.3-T4 | Given the S/S third-party sale example, then principal $249,088.61, interest $1,245.44, proceeds $210,000 (code 311) and a TPS case are produced, and the delinquency-advance reimbursement credit is matched within two draft cycles. |
| 5.3-T5 | Given a deferral loan with $12,000 non-interest-bearing balance and interest-bearing UPB $180,000, when it pays off, then reported principal = $192,000 × participation; omission is caught by local validation before submission. |
| 5.3-T6 | Given the AC 60 was accepted in the October period and the wire is reversed Nov 4, 2026 (after Nov 3 BD2 close), then no correction is projected, `fnma_liquidated_in_error` is set, the amount due is computed for remittance and an `officer` escalation and `qc_finding` case open. |
| 5.3-T7 | Given a DRA "Foreclosure Sale Held" event from the firm feed dated Oct 14 with no matching `foreclosure.sale.held` in our system by Oct 15, then a sev-1 escalation fires and the REOgram confirmation task is pre-created due Oct 16. |
| 5.3-T8 | Given a REOgram notice received Wed Nov 25, 2026 17:30 ET, then the confirmation task is due Mon Nov 30 (next `fannie_et` BD after Fannie Mae holidays Nov 26–27), with a warning at 70%. |
| 5.3-T9 | Given `removal.liquidation.third_party.mode = event` in CIT, then the P360 liquidation event JSON is produced in `api-clve` and diffed against the production LAR 71. |
| 5.3-T10 | Given the agent's confidence on insured status is 0.7, then the removal is held, a `human_agent` review is requested at deadline − 4h, and the timer still breaches if unresolved (evidence retained). |

#### Audit and evidence
`liquidation_facts`, removal event files/acks, CRS confirmations and bank matches, P360 confirmation evidence (screenshots/case IDs), DRA milestone copies and reconciliation reports, agent decisions (code selection rationale, confidence), timer histories — retained `life_of_loan_plus_4y`; used for compensatory-fee (A1-4.2-02) defense, MI claim support (Section 15.3) and MORA liquidation testing.

### Open questions / decisions
1. **Action-date convention for late-notified liquidations** — default: report immediately in the current period with the true legal date; confirm convention with the Investor Reporting Representative.
2. **Servicing a loan Fannie Mae has liquidated in error (post-close payoff error)** — default: partner remits/advances; loan is re-classified in our system as `owner = partner (non-Fannie)` pending Fannie Mae re-add (`readd_requests@fanniemae.com`) or repurchase; borrower servicing continues uninterrupted.
3. **DRA visibility** — default: contractual firm feed within 1 BD + weekly human DRA review; do not scrape.
4. **Liquidation event schema/CIT** — default: begin CIT when the Liquidation CIT plan publishes; keep LAR 70/71/72 until the published go-live.

### Sources
- Investor Reporting Manual (Apr. 8, 2026) §2-04, pp. 19–26; §4-08 pp. 42–46: https://singlefamily.fanniemae.com/media/7816/display (verified 2026-09-09)
- C-4.3-01 (04/08/2026); SVC-2026-03 (URLs in 5.1) (verified 2026-09-09)
- F-1-20 (03/11/2026) — payoff, short sale, third-party sale, settlement remittance subsections: https://servicing-guide.fanniemae.com/svc/f-1-20/remitting-and-accounting-fannie-mae (verified 2026-09-09)
- CRS Remittance Codes (Oct. 15, 2025): https://singlefamily.fanniemae.com/media/document/pdf/crs-remittance-codes (verified 2026-09-09)
- F-1-21 delinquency status codes (10/11/2023): https://servicing-guide.fanniemae.com/svc/f-1-21/reporting-delinquent-mortgage-loan-fannie-maes-servicing-solutions-system (verified 2026-09-09)
- LL-2026-05; Servicing Changes Reference Guide v1.0; Implementation Timeline v3.0 (URLs in 5.1) (verified 2026-09-09)
- research/00b F5 (Property 360/REOgram, E-4.1-01), F7 (DRA User Guide July 25, 2023), N12 (attorney networks) (verified 2026-09-09)
