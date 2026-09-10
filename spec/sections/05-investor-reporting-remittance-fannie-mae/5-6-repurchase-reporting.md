# 5.6 — Repurchase reporting

| Attribute | Value |
|---|---|
| Section | 5 — Investor Reporting & Remittance (Fannie Mae) |
| Automation class | b |
| Trigger & frequency | On Fannie Mae-approved repurchase |
| Governing source | FNMA A1-3-01/02/04; F-1-20 |
| Key deadlines | Per remittance type action date |
| Timers | `FNMA_A1302_APPEAL1_60`, `FNMA_A1302_APPEAL2_15`, `FNMA_A1302_DOCS_30`, `FNMA_A1302_IMPASSE_30`, `FNMA_A1302_REPURCHASE_PAY_60`, `FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE`, `FNMA_IRM_REMOVAL_CORRECTION_BD2_1700`, `FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000`, `SM_REPURCHASE_OWNERSHIP_UPDATE_10BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Investor Reporting |
| Trigger & frequency | On Fannie Mae-approved repurchase |
| Governing source (blueprint) | FNMA A1-3-01/02/04; F-1-20 |
| Key deadlines (blueprint) | Per remittance type action date |
| Data/artifacts | Repurchase LAR |
| Systems | CRS |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: the partner (responsible party/master servicer) decides, offers and funds the repurchase and signs the correspondence; Supermortgage prices it, reports action code 65/67 and reconciles the remittance |
| Nuances (blueprint) | [cropped in source] — reconstructed: voluntary vs Fannie Mae-initiated (demand/appeal clocks); price differs by remittance type and by portfolio vs MBS; removal clock; action date change after close needs written justification; make-whole/DPO variants |

### Verified requirement (as of 2026-09-09)

**A1-3-01, Requirements for Voluntary Repurchase (11/12/2025):** portfolio loans — written offer to the Non-Standard Repurchase Team stating loan identification (coupon rate and participation certificate yield), reason, terms and proposed price; Fannie Mae accepts or counters; repurchase "in connection with a conditional tender of payment that is used as an alternative to refinancing" is not approved. MBS loans may be repurchased (i) when a regular servicing option loan "has four consecutive payments past due," (ii) as an alternative to enforcing due-on-sale (special servicing option loans need prior approval), (iii) for MBS issued on/after June 1, 2007 after court confirmation of a plan modifying loan terms (E-2.1-11). After repurchase, losses "are the responsibility and legal obligation of the responsible party."

**A1-3-02, Fannie Mae-Initiated Repurchases, Indemnifications, Make Whole Payment Requests and DPOs (05/13/2026):** documentation within 30 days of file selection; payment "within 60 days after receipt of the request" unless appealed — for active loans "with its next scheduled remittance following the completion of the 60-day period"; first appeal within 60 days of the demand (Fannie Mae responds within 60 days), second appeal within 15 days of the first denial, impasse 30 days, management escalation 30 days, IDR retainer within 15 days, 15 days to initiate each next stage; silence = no contest; alternative-remedy demand within 60 days after a servicing correction period expires. **Repurchase price — portfolio loans:** original purchase price × UPB at repurchase, plus interest "through the effective repurchase date (Actual/Actual) or through month-end (Scheduled/Actual or Scheduled/Scheduled)," plus attorney fees, legal expenses, court costs and other expenses, adjusted for Fannie Mae's percentage ownership. **MBS loans:** "the sum of Fannie Mae's share of the outstanding security balance for the mortgage loan as of the repurchase month and one month's interest on that balance" at the pool PTR (fixed) or the loan/pool accrual rate (ARM). **Acquired property:** price includes accrued interest, property maintenance and marketing expenses through the purchase date. **Make-whole** applies when a demand would have issued but the loan was liquidated. **DPO:** remit the full price without reduction for an unpaid MI claim portion; credit only MI actually paid; Fannie Mae conveys DPO rights to the responsible party.

**A1-3-04, Reporting the Repurchase (10/11/2023):** report per the Investor Reporting Manual; for acquired properties Fannie Mae executes a quit-claim deed "as soon as Fannie Mae receives the full amount of the repurchase proceeds"; second-lien repurchases go through the Servicing Representative.

**IRM (Apr. 8, 2026) §2-04 pp. 22–23; §4-08:** action code **65** (repurchase) or **67** (ARM with modification feature exercised) "in the next Transaction Type 96 it transmits," action date within the current activity period; principal = prior month's actual UPB (A/A, S/A) or scheduled UPB (S/S cash-purchased portfolio) × original purchase price × Fannie Mae's percentage; A/A biweekly uses the UPB as of the last reported activity; S/S SWAP MBS = prior scheduled UPB × percentage (no purchase-price factor); A/A reclassified-from-SWAP = prior actual UPB × percentage; add principal forbearance before multiplying; interest A/A from LPI through the day before the repurchase date (÷12 per full month, ÷365 per day), S/A = prior actual UPB × PTR ÷ 12 × percentage, S/S = prior scheduled UPB × PTR ÷ 12 × percentage. Removal clock: 8 p.m. ET the first BD after processing / 5 p.m. ET if BD2; corrections by 5 p.m. ET BD2; after close, an action-date change requires "written notice + justification to Investor Reporting Representative."

**F-1-20 (03/11/2026) / CRS codes (Oct. 15, 2025):** repurchase proceeds for active loans move on the remittance schedule of the loan's type — MBS Express unscheduled principal (payoffs, curtailments, **repurchases**, removals) drafted BD4 of the following month; S/S standard the 18th; S/A the 20th; A/A immediately via CRS code 001 when > $2,500 **[PARTIALLY VERIFIED — F-1-20 lists repurchases with "unscheduled principal" for MBS Express; the A/A remittance code for repurchase proceeds is inferred from the payoff rule]**; make-whole/settlement proceeds CRS **309**; REO property repurchase proceeds **315**; payoff/repurchase advance recoverable proceeds **352**.

**Discrepancies with the blueprint row:** the system is LSDU (LAR 65/67) plus the P&I draft or CRS for cash; the trigger includes Fannie Mae-initiated demands with a 60-day payment clock and appeal ladder, not only "approved" voluntary repurchases; the price formula is type-specific (purchase-price factor for cash-purchased portfolio loans; security balance + one month's PTR interest for MBS); A1-3-02 was updated May 13, 2026.

### Operational prerequisites
- Partner's designation of who may sign repurchase offers/acceptances and fund the price (`officer` role at the partner); repurchase funding account (corporate) and, for MBS, the unscheduled-principal custodial flow.
- Boarded acquisition data: original purchase price (cash loans), Fannie Mae percentage interest, security balance basis, pool accrual structure (fixed/stated/weighted-average ARM).
- Fannie Mae Servicing Representative and Non-Standard Repurchase Team contacts (F-4-02); Loan Quality Connect/servicing-remedies access for demands **[UNVERIFIED — demand channel]**.
- MERS TOB/TOS and custodian release procedures for post-repurchase ownership change (Sections 1.5, 16.4, 1.4).

### Build spec
#### Inputs and triggers
- `repurchase.demand.received` (Fannie Mae-initiated; documents), `repurchase.offer.approved` (voluntary; partner officer decision + Fannie Mae acceptance), `bk.plan.confirmed_with_modification` (E-2.1-11), `due_on_sale.violation.detected`, `mbs.regular_option.four_payments_past_due`.
- `repurchase.funds.remitted`/drafted; LAR 65/67 acceptance; quit-claim deed receipt (acquired property).

#### Data model
- `repurchases`: `loan_id`, `type` ∈ {voluntary_portfolio, voluntary_mbs_regular_4mo, due_on_sale, bk_plan_mod, fnma_demand, make_whole, dpo_indemnification}, `demand_received_at`, `documents_due_at`, `appeal_stage` ∈ {none, appeal1, appeal2, impasse, escalation, idr}, `appeal_deadline_at`, `approval_document_id`, `repurchase_effective_date`, `price_components` (jsonb: basis_upb_cents, purchase_price_pct, participation_pct, interest_cents, expenses_cents, forbearance_cents, total_cents), `action_code` (65/67), `reported_event_id`, `remittance_id`, `responsible_party` (partner | originator | supermortgage), `status`.
- Reuse `investor_events` (family removal), `remittances`, `crs_batches`, `cases` (`case_type = qc_finding` for demands), `documents`.

#### State machine
`repurchases.status`: `demanded`/`proposed` → `under_appeal` (stages) → `approved` (voluntary accepted or demand uncontested/upheld) → `priced` → `reported` (LAR 65/67 submitted) → `accepted` → `funded` (proceeds remitted/drafted and matched) → `closed` (loan re-owned; MERS/custody updated; quit-claim received if REO). Side: `withdrawn` (Fannie Mae rescinds demand), `make_whole` (loan already liquidated → payment only, no LAR).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `FNMA_A1302_DOCS_30` | deadline | file selected for review | notification | 30 calendar days | documents submitted | sev-2 (`officer`) |
| `FNMA_A1302_REPURCHASE_PAY_60` | deadline | demand received | receipt | 60 calendar days (active loans: next scheduled remittance after day 60) | `funded` | sev-1 (`officer`) |
| `FNMA_A1302_APPEAL1_60` | deadline | demand received | receipt | 60 calendar days | appeal filed or decision not to appeal recorded | sev-1 |
| `FNMA_A1302_APPEAL2_15` | deadline | first-appeal denial | receipt | 15 calendar days | second appeal filed / waived | sev-1 |
| `FNMA_A1302_IMPASSE_30` / `FNMA_A1302_ESCALATION_30` / `FNMA_A1302_IDR_RETAINER_15` / `FNMA_A1302_NEXT_STAGE_15` | deadline | stage entered | stage date | 30 / 30 / 15 / 15 calendar days | next-stage action recorded | sev-1 |
| `FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000` | deadline | repurchase processed | processed_at | next `fannie_et` BD 20:00 ET (17:00 if BD2) | LAR 65/67 submitted | sev-1 |
| `FNMA_IRM_REMOVAL_CORRECTION_BD2_1700` | deadline | exception | period end | BD2 17:00 ET | superseded | sev-1 (written justification thereafter) |
| `FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE` | deadline | LAR accepted | period | S/S CD18 / MBS Express BD4 / S/A CD20 / A/A immediate (CRS 001 by 16:00 ET) | `remittances.funded`/`instructed` | sev-1 |
| `SM_REPURCHASE_OWNERSHIP_UPDATE_10BD` | deadline (internal) | proceeds matched | match | 10 BD | MERS TOB/TOS + custodian release + loan `investor` field updated | sev-2 |

#### Business rules and calculations
1. **Type routing:** Fannie Mae demand → `qc_finding` case with the appeal ladder; voluntary → partner `officer` decision package (reason, economics, alternatives such as reclass); MBS regular-option four-payments-past-due → eligibility check on `fnma_delinquency_status`; due-on-sale → transfer-of-ownership/assumption review (Section 4.4 successor-in-interest rules and the assumption process); bankruptcy plan modification → Section 14 trigger.
2. **Pricing:** *Portfolio cash loan (A/A):* basis = prior actual UPB (+ forbearance) × original purchase price % × participation; interest = basis-rate interest from LPI through the day before the effective repurchase date (full months ÷12 at PTR, days ÷365) × participation; plus reimbursable expenses. *Portfolio S/A or S/S:* interest through month-end = one full month at PTR on prior actual (S/A) or scheduled (S/S) UPB. *MBS S/S:* Fannie Mae's share of the security balance (prior scheduled UPB) + one month's interest at the pool PTR (fixed) or accrual rate (ARM). Rounding half-up to cents per component. **Worked example (MBS S/S):** scheduled UPB $199,500.00, PTR 6.000% → price = 199,500.00 + 997.50 = **$200,497.50**; LAR 96 action code 65, principal $199,500.00, interest $997.50, action date within the current period. **Portfolio A/A example:** UPB $199,500.00, purchase price 101.500%, participation 100%, LPI Sept 1, repurchase effective Oct 16 → principal = 199,500 × 1.015 = $202,492.50; interest = one month $997.50 + 15 days × $32.7945 = $1,489.42; price $203,981.92 plus expenses.
3. **Reporting:** LAR 65 (67 if ARM modification feature exercised) in the next LAR 96 after the repurchase is processed, on the removal clock; the loan is thereafter inactive for Fannie Mae reporting; delinquency status file drops the loan next cycle (5.7).
4. **Cash:** S/S/MBS Express/S/A proceeds are drafted with the type's cycle from the reported LAR (funding gate applies; the funds come from the responsible party, not from custodial collections); A/A proceeds via CRS 001 immediately (> $2,500); make-whole via CRS 309; REO repurchase via 315; recoverable advances via 352.
5. **Post-close corrections:** action-date changes after BD2 require a written justification letter to the Investor Reporting Representative — agent drafts, `officer` signs/sends.
6. **DPO/indemnification arithmetic** per A1-3-02 example: DPO insurer pays 60% of allowed claims, $30,000 claim denied → indemnification $18,000; if payout rises to 70%, additional $3,000 billed — implemented as a parametric calculator in the `qc_finding` case.

#### Integrations
- `fnma-lsdu` (LAR 65/67), `fnma-crs` (001/309/315/352 batches — portal task), draft notifications (`fnma-connect`), `mers` (TOB/TOS after repurchase), `custodian` (release/Form 2009 per Section 1.4/16), email correspondence with the Non-Standard Repurchase Team / Servicing Representative (agent-drafted, `officer`-sent). Fannie Mae's demand channel (Loan Quality Connect or letter) **[UNVERIFIED]** — inbound documents are ingested into the case.

#### Outputs and artifacts
- `repurchases` record, pricing worksheet (document), offer/acceptance letters, LAR 65/67 event and ack, remittance and bank match, MERS/custodian confirmations, quit-claim deed (REO), case file for demands/appeals.
- Ledger: repurchase price funded by the responsible party (corporate) → Dr `fnma_remittance_payable` Cr corporate cash on draft; loan re-booked under the new owner; advances recovered (352) reverse `servicer_advance_receivable`.
- Investor events: `removal.repurchase`; delinquency status drop-off.
- No borrower notices are required by Fannie Mae for a repurchase; if the owner changes, the Reg Z §1026.39 ownership-transfer notice is owed by the new owner within 30 days (Section 1.3/17 transfer notices — out of scope here).

#### AI agent design (AI-first)
`investor-reporting` agent prices and reports; `qc-audit` agent runs demand/appeal cases. Tools: `priceRepurchase(type)`, `projectEvent`, `buildCrsBatch`, `draftLetter`, `openPortalTask`, `recordDecision`. Decision record: `{repurchase_id, type, price_components, interest_basis, deadline_at, recommendation (pay | appeal | counter), rationale, confidence}`. Guardrails: the agent never commits the partner to a repurchase — every offer, acceptance, appeal and payment authorization is an `officer` escalation with the complete package (pricing worksheet, loan history, eligibility, alternative analysis); LAR 65/67 is projected only after the approval document is attached; no removal correction after BD2 17:00 ET. Toggle-off: same pricing engine; humans draft letters.

#### Edge cases and failure modes
- **Loan already liquidated when demand arrives:** make-whole (no LAR), CRS 309.
- **Demand rescinded after LAR 65 accepted but before close:** correcting event by BD2 17:00 ET; after close, re-add process via Investor Reporting Representative with written justification.
- **ARM with modification feature:** code 67; interest at accrual rate.
- **Reclass vs repurchase during trial modification (F-1-25):** prefer reclass (Fannie Mae-initiated) unless the partner elects voluntary repurchase; both remove the loan from the MBS — do not report both.
- **Repurchase of an SDA/g-fee-relief loan:** price includes Fannie Mae's outstanding P&I receivable draft (5.4); servicer advances recovered from the responsible party.
- **Transfer-in with an open demand:** appeal clocks continue (calendar days from Fannie Mae's original notice) — board `repurchases` with original dates.
- **Bankruptcy stay:** repurchase itself is not stayed; post-repurchase servicing must respect the plan.

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 5.6-T1 | Given a Fannie Mae demand received Sept 15, 2026, then pay-by and first-appeal deadlines are Nov 14, 2026; second appeal 15 days after a denial received Dec 1 → Dec 16; the case shows the ladder. |
| 5.6-T2 | Given an MBS S/S loan with scheduled UPB $199,500 and PTR 6%, then the price is $200,497.50 and LAR 65 reports principal $199,500.00 / interest $997.50. |
| 5.6-T3 | Given a portfolio A/A loan (purchase price 101.5%, LPI Sept 1, repurchase Oct 16), then principal $202,492.50 and interest $1,489.42 are reported and the CRS 001 batch is prepared the same day. |
| 5.6-T4 | Given the repurchase processed Mon Nov 2, 2026 (BD1), then LAR 65 is due Tue Nov 3 17:00 ET. |
| 5.6-T5 | Given an approval document is missing, then the LAR 65 projection is blocked and an `officer` escalation exists; once attached, the event is created with the original processed timestamp. |
| 5.6-T6 | Given a DPO insurer paying 60% and a denied $30,000 claim, then indemnification = $18,000; a later 70% payout adds $3,000. |
| 5.6-T7 | Given an MBS Express pool repurchase reported in October, then unscheduled principal is funded for the BD4 November draft (Thu Nov 5, 2026). |

#### Audit and evidence
Demand/appeal correspondence with dates, pricing worksheets, officer approvals, LAR and remittance evidence, ownership-change confirmations — retained `life_of_loan_plus_4y`; the appeal ladder history is the evidence for IDR.

### Open questions / decisions
1. **A/A repurchase proceeds remittance code** (001 vs a special code) — default: 001 immediately; confirm with the Investor Reporting Representative.
2. **Demand intake channel** — default: email/letter ingestion into `cases`; add Loan Quality Connect adapter if the partner receives servicing-remedy demands there.
3. **Responsible-party allocation** between partner and Supermortgage for servicing-defect demands — contract clause; default: fault-based.

### Sources
- A1-3-01 (11/12/2025): https://servicing-guide.fanniemae.com/svc/a1-3-01/requirements-voluntary-repurchase (verified 2026-09-09)
- A1-3-02 (05/13/2026): https://servicing-guide.fanniemae.com/svc/a1-3-02/fannie-mae-initiated-repurchases-indemnifications-make-whole-payment-requests-and-deferred-payment (verified 2026-09-09)
- A1-3-04 (10/11/2023): https://servicing-guide.fanniemae.com/svc/a1-3-04/reporting-repurchase (verified 2026-09-09)
- Investor Reporting Manual (Apr. 8, 2026) §2-04 pp. 22–23; §4-08: https://singlefamily.fanniemae.com/media/7816/display (verified 2026-09-09)
- F-1-20 (03/11/2026); CRS Remittance Codes (Oct. 15, 2025); F-1-25 (12/20/2023) (URLs above) (verified 2026-09-09)
