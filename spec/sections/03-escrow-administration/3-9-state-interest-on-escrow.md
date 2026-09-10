# 3.9 — State interest-on-escrow

| Attribute | Value |
|---|---|
| Section | 3 — Escrow Administration |
| Automation class | a |
| SoR / Sub | Sub |
| Trigger & frequency | Per state |
| Governing source | STATE-DEPENDENT (interest-on-escrow states) |
| Key deadlines | Per state law |
| Timers | `IRS_1099INT_EFILE_0331`, `IRS_1099INT_FURNISH_0131`, `STATE_IOE_ACCRUAL_DAILY`, `STATE_IOE_PAYOFF_PRORATE_0` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Escrow |
| Trigger & frequency | Per state |
| Governing source (blueprint) | STATE-DEPENDENT (interest-on-escrow states) |
| Key deadlines (blueprint) | Per state law |
| Data/artifacts | Interest accrual |
| Systems | Core |
| Automation class (blueprint) | a |
| SoR / Sub | [cropped in source] — reconstructed: Sub accrues, pays from its own funds and reports; SoR liable; Fannie Mae does not reimburse |
| Nuances (blueprint) | [cropped in source] — reconstructed: 13 states with distinct rate/basis/crediting rules; entity-scope and exemption differences; no OCC preemption for a nonbank; 1099-INT reporting; proration at payoff |

### Verified requirement (as of 2026-09-09)

**Fannie Mae B-1-01 (09/11/2024)**: "Fannie Mae will not reimburse the servicer when the servicer pays interest on an escrow account, whether required by law or voluntary." The uniform security instrument obliges the lender to pay interest on the Funds only where "Applicable Law requires interest to be paid" **[PARTIALLY VERIFIED]**. Reg X 1024.17 is silent on interest (interest credits are escrow deposits for analysis purposes). Preemption: the OCC's May 2026 rules and *Cantero* (2d Cir. May 5, 2026) reach national banks/FSAs only; a nonbank subservicer must assume state laws apply (00a §5.5). LL-2026-05 escrow reporting includes an "Interest on Escrow" deposit item type (Reference Guide v1.0).

**State statutes verified today (primary sources unless noted)**:

| State | Statute | Rate rule | Balance basis / crediting | Scope and exemptions |
|---|---|---|---|---|
| NY | Gen. Oblig. Law §5-601 (nysenate.gov) | "not less than two per centum per year" or the DFS-set rate, "whichever is higher" (DFS rate currently 2% **[PARTIALLY VERIFIED]**) | average deposit and time held; credited "for each quarterly period" | 1–6 family owner-occupied or co-op; "mortgage investing institution" (servicers included via 3 NYCRR Part 419 conduct rules **[PARTIALLY VERIFIED]**); no escrow service charges (net rate) |
| CA | Civ. Code §2954.8 (FindLaw text; DFPI enforcement vs CitiMortgage 2014+) | "at least 2 percent simple interest per annum" | credited annually or on termination, whichever earlier | 1–4 family; "financial institution" incl. other lenders/servicers; fees may not reduce the effective rate below 2%; exceptions: pre-effective-date loans; funds a regulator requires a non-bank to hold non-interest-bearing |
| MN | §47.20 subd. 9 (revisor.mn.gov) | "not less than three percent per annum" | average of first-of-month balances over the prior 12 months; credited annually (to principal, paid, or credited to the account at mortgagee's election) | 1–4 family owner-occupied; "mortgagee" incl. assignees; exempt: accounts required by federal law, conventional loans > 80% LTV, government-insured; plus 5-year discontinuance right (3.8) |
| UT | §7-17-3 (Justia 2025; le.utah.gov chapter PDF) | "5-1/2%"; or 11th District COFI average "less 1-1/2 percentage points"; or the depository's statement-savings rate for like-size accounts — listed with "or" and no selection words **[election mechanism ambiguous]** | average daily balance; credited "yearly as of December 31" | real-estate loans ≤ 4 units; exempt: government insurer-required accounts; loans > 80% of lender's appraised value until paid to 80%; federal prohibition; no service charges; 7-17-5 annual statement within 60 days of year-end |
| ME | 9-B M.R.S. §429 (legislature.maine.gov) | "not less than 50% of the 1-year Treasury Bill secondary market rate" as of the first business day of the year | credited at least quarterly; annual written statement | owner-occupied ≤ 4 units in Maine; financial institutions, credit unions and "supervised lenders" (Title 9-A); exception where federal law prohibits |
| CT | §49-2a (Justia 2024; DOB 2026 deposit index) | "not less than the deposit index … rounded to the nearest one-tenth of one percentage point" with a floor of 1.5%; 2026 index 0.49% → **1.5%** for 2026 | credited December 31 annually; on payoff before year-end, "interest to the date of payment shall be paid" | owner-occupied ≤ 4 units and co-ops; "other mortgagee or mortgage servicer" expressly covered; exceptions per §49-2c **[not fetched]** |
| MD | Com. Law §12-109 (Justia 2025) | ≥ weekly average 1-year Treasury constant-maturity yield as of the first business day of the year | average monthly balance; credited annually; annual balance statement | "lending institution" = bank, savings bank or S&L doing business in Maryland; not applicable to loans purchased by an out-of-state lender through Fannie Mae/Ginnie Mae/Freddie Mac unless sold to or "placed with a Maryland lender for servicing" — nonbank applicability is a legal question |
| MA | c.183 §61 (malegislature.gov) | "at a rate and in a manner to be determined by the mortgagee" | "at least once a year" | first mortgage on ≤ 4-household dwelling; **real estate tax deposits only**; commissioner exemption on net loss |
| OR | ORS 86.245 / 86.205 (oregon.public.law) | "not less than the discount rate" = 91-day T-bill auction average "less 100 basis points," from the last auction before May 15 / Nov 15, effective July 1 / Jan 1 | "not less than quarterly … by crediting to the escrow account" | residential property occupied by the borrower; "lender" = makes, extends or holds; exceptions: pre-9/1/1975 loans, federal-law conflicts, State of Oregon loans |
| VT | 8 V.S.A. §10404 (Justia 2024) | same conditions as the lender's regular savings account if offered, "otherwise at a rate not less than the prevailing market rate of interest for regular savings accounts offered by local financial institutions" | average monthly balance; "credited on the first day of each quarter"; annual RESPA-consistent statement | lender includes one who "services or holds"; exception: escrow required because the borrower failed to pay T&I in the past year |
| RI | §19-9-2 (Justia 2025) | the mortgagee's regular savings rate if offered, "otherwise at a rate not less than the prevailing market rate" set annually by the director | accrues on the daily balance; credited annually on December 31 | owner-occupied ≤ 4 units; exempt FHA/VA/FmHA and loans "insured by private mortgage insurers licensed in Rhode Island"; non-waivable; no "tax service fee"; $100/violation |
| NH | RSA 397-A:9, IV (gencourt) for licensees; 384:16-c for banks | FDIC "National Deposit Rate for Savings Accounts" published in January (applies Apr–Sep) and July (applies Oct–Mar) | statutory periods; crediting frequency not stated (policy: quarterly) | single-family homes; nondepository licensees (RSA 397-A) |
| WI | §138.052(5) (Justia 2025; DFI 2026 notice) | loans originated 2/1/1983–12/31/1993: ≥ 5.25%; originated 1/1/1994–4/17/2018: DFI variable rate (**0.17% for 2026**); originated on/after 4/18/2018: **none** | annual (DFI rate set per calendar year) | 1–4 family principal residence first liens; originator types incl. "mortgage banker"; waiver possible where > 75% of the lender's interest is sold to a third party holding the escrow |
| IA | §524.905 | repealed 2022 (00a §5.5) | — | none |

**Discrepancies with the blueprint row**: none (row is a placeholder); the research resolves the 00a "[UNVERIFIED]" flags for NH (verified: RSA 397-A:9 IV) and WI (verified: origination-date bands; no interest for post-4/18/2018 loans) and adds MA's tax-only scope and MD's bank-only scope.

### Operational prerequisites
- `jurisdiction_rules.escrow_interest` seeded for the 13 states above, counsel-reviewed, with rate observations for 2026 (CT 1.5%; WI 0.17%; ME/MD Treasury values as of the first business day of 2026; OR auctions; NH FDIC Jan/Jul rates; UT COFI/statement-savings election; RI director rate; VT/MA policy rates) — compliance; before first loan in each state. **[Rate observations for ME, MD, OR, NH, RI, UT not retrieved today — mark UNVERIFIED until loaded from the publishing source.]**
- Corporate funding for interest credits into the T&I custodial account; GL expense account `escrow_interest_expense`.
- 1099-INT production (in-house or print vendor) with TIN validation/backup-withholding procedures (Section 7/19).
- Property scope data at boarding: occupancy, unit count, co-op flag, origination date, government/PMI insurance flags, LTV at origination, originator type (bank/nonbank/out-of-state) — Section 1.1.

### Build spec
#### Inputs and triggers
- Daily accrual job (`timer-sweep` 00:30 servicer TZ) for loans where `jurisdiction_rules.escrow_interest.applies` and the loan passes scope/exemption tests.
- Crediting schedule events: `escrow.interest.credit_due` (quarterly last day / first day of quarter / Dec 31 / annual per state).
- Rate refresh events: `jurisdiction.rate_observation.due` (per state calendar: MD/ME first business day of the year; CT December announcement; OR May 15/Nov 15 auctions; NH January/July FDIC; WI DFI notice; UT COFI monthly or policy election; RI director annual; NY DFS watch).
- `loan.paid_in_full`, `transfer.batch.cutover_completed`, `escrow.account.closed` → prorate and credit accrued interest before the refund/transfer.
- Year-end: `tax.year_closed` → 1099-INT aggregation.

#### Data model
- `jurisdiction_rules.escrow_interest jsonb`: {`applies`, `statute`, `entity_scope` ∈ {all_servicers, banks_only, licensees}, `property_scope` {`max_units`, `owner_occupied_required`, `coop_included`, `principal_residence_required`}, `item_scope` ∈ {all, taxes_only}, `rate_rule` {`type` ∈ {fixed_min, index_min, lender_rate, band_by_origination, formula_options}, `fixed_bps`, `index_code`, `spread_bps`, `floor_bps`, `rounding`, `bands[]`}, `balance_basis` ∈ {daily, average_daily, average_monthly_first_of_month, average_monthly}, `accrual_day_count` ∈ {actual_365, actual_actual}, `credit_frequency` ∈ {quarterly_end, quarterly_first_day, annual_dec31, annual_computation_year, annual_or_termination}, `credit_mode` ∈ {credit_escrow, pay_borrower, credit_principal}, `exemptions` {`gov_insured`, `pmi_insured`, `ltv_gt_pct`, `federal_prohibition`, `origination_before`, `escrow_imposed_for_default`, `out_of_state_gse_purchase`}, `fee_prohibited`, `payoff_proration`, `negative_balance_accrues` false}.
- `jurisdiction_rate_observations` (new): `state`, `index_code`, `observed_value_bps`, `effective_from`, `effective_to`, `source_url`, `evidence_document_id`, `entered_by` (agent/human), `verified bool`.
- `escrow_interest_accruals` (new): `loan_id`, `period_start`, `period_end`, `basis_balance_cents` (average or daily sum), `rate_bps`, `day_count`, `accrued_exact numeric(20,8)`, `posted_cents bigint null`, `posted_at`, `ledger_entry_id`, `investor_event_id`, `rule_version`, `status` ∈ {accruing, posted, prorated_posted, void}.
- `escrow_interest_1099` (new): `tax_year`, `borrower_id`, `tin_hash`, `total_cents`, `furnished_at`, `filed_at`, `correction_of`.
- Ledger: corporate `escrow_interest_expense` ↔ loan `escrow` (via custodial `custodial_ti_cash` funding). Retention: `life_of_loan_plus_4y` and IRS 4 years for 1099 records; TIN encrypted.

#### State machine
Per loan-state eligibility: `not_applicable` → `eligible` (scope tests pass) → `accruing` → `credited` (per period) → … → `closed` (payoff/transfer/waiver: prorated credit posted) ; `exempt` (with reason) re-evaluated on LTV/PMI/occupancy changes. Rate observation: `due` → `observed` (agent fetch with evidence) → `verified` (second-source or human check) → `effective`. 1099: `aggregated` → `furnished` → `filed` → `corrected`.

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `STATE_IOE_ACCRUAL_DAILY` | recurring | eligibility | each calendar day | 1 day | accrual row for the day | sev-3 (recompute from ledger — accruals are idempotent) |
| `STATE_IOE_CREDIT_QUARTERLY_<NY,ME,OR,NH,VT>` | recurring | eligibility | quarter end (VT: first day of the next quarter) | 0 | `escrow.interest.credited` | sev-2 (statutory) |
| `STATE_IOE_CREDIT_ANNUAL_DEC31_<CT,UT,RI,MN,MD,WI>` | recurring | eligibility | Dec 31 | 0 | `escrow.interest.credited` | sev-2 |
| `STATE_IOE_CREDIT_ANNUAL_<CA,MA>` | recurring | eligibility | computation-year end (CA: annually or at termination; MA: at least once a year) | 0 | `escrow.interest.credited` | sev-2 |
| `STATE_IOE_PAYOFF_PRORATE_0` | deadline | `loan.paid_in_full` / `transfer.batch.cutover_completed` / `escrow.account.closed` | event date | 0 (before the refund/transfer of funds) | `escrow.interest.credited` (prorated) | refund command blocked until posted |
| `STATE_IOE_RATE_REFRESH_<XX>` | recurring | state calendar | publication date | 5 business_days_servicer to load | `jurisdiction.rate_observation.verified` | sev-2; accrue at the last verified rate and true-up |
| `IRS_1099INT_FURNISH_0131` | deadline | tax year end | Jan 31 | 0 (next business day if weekend/holiday per IRS rules) | `escrow_interest_1099.furnished_at` | sev-2 |
| `IRS_1099INT_EFILE_0331` | deadline | tax year end | Mar 31 (electronic; 10+ returns mandate) | 0 | `filed_at` | sev-2 |
| Jurisdiction overrides | | entire process is jurisdiction-keyed; MA `item_scope=taxes_only`; WI bands; MN/UT LTV exemptions; RI PMI exemption; VT default-imposed exemption | | | | |

#### Business rules and calculations
1. **Eligibility**: property state ∈ applicable set; property scope (units, occupancy, co-op); entity scope (Supermortgage is a nonbank licensee → `all_servicers` or `licensees` rules apply; `banks_only` (MD) applies only under open question 1); exemptions evaluated from loan data (government-insured → n/a for this platform; PMI-insured (RI); LTV > 80% at origination (MN) / until paid to 80% (UT, tracked monthly); WI origination-date bands; VT escrow imposed for default; MA taxes-only item scope).
2. **Rate resolution** at each accrual day: `fixed_min` → max(fixed, index if any); `index_min` → max(index ± spread, floor) with stated rounding (CT: nearest 0.1%; floor 1.5%); `band_by_origination` (WI); `lender_rate` (MA/VT/RI: policy rate `escrow_interest.policy_rate_bps` ≥ prevailing local savings rate observation; default 25 bps **[policy; verify prevailing rates]**); `formula_options` (UT: policy election = statement-savings rate of the T&I depository for like-size accounts, evidenced; open question 2).
3. **Accrual**: `daily`/`average_daily` basis: `accrued_exact += max(EOD balance, 0) × rate / 365` (actual/365 fixed; leap day accrues at 1/365 — policy); `average_monthly_first_of_month` (MN): at each crediting date, `avg = mean(balances on the 1st of each of the prior 12 months)`; `interest = avg × rate × (period_days/365)` … for MN annual: `avg × 3%`. Negative balances accrue nothing. Balance is the T&I category balance (loss-draft/renovation funds excluded unless state law says otherwise — **[UNVERIFIED]**; MA: taxes-only requires a tax-line sub-balance: `tax_share = balance × (tax annual / total annual)` policy allocation).
4. **Posting**: at the crediting date, `posted_cents = round_half_up(accrued_exact − already_posted)`; ledger Dr corporate `escrow_interest_expense` / Cr loan `escrow`; cash movement corporate → `custodial_ti_cash` same day; `credit_mode`: default `credit_escrow` for all states (MN election recorded as credit to account); CA "annually or upon termination whichever earlier"; CT/UT/RI Dec 31; VT first day of quarter; NY/ME/OR quarterly.
5. **Proration**: on payoff/transfer/closure, post accrued-to-date interest before computing the refund/transfer amount (CT explicit; policy for all states).
6. **Fees**: none charged for escrow administration (CA, NY net-rate, UT, RI prohibitions) — enforced globally.
7. **Escrow analysis interaction**: projected interest is *not* included as a deposit in the trial running balance (conservative; small amounts); actual credits appear in the history and as surplus at the next analysis.
8. **Escrow event**: each credit emits a deposit event, item type "Interest on Escrow," category T&I, amount = posted cents, balance after.
9. **1099-INT**: aggregate per tax year per primary borrower TIN across all loans; furnish Box 1 when ≥ $10.00; file electronically when 10+ information returns; backup withholding if TIN missing after solicitation (IRS Instructions for Forms 1099-INT/OID, 01/2024 revision) **[PARTIALLY VERIFIED — escrow interest is not named in the instructions; treated as reportable interest per industry practice]**.
10. **Statement disclosure**: the annual escrow statement (3.3) shows interest credited for the year; ME/VT/MD/UT annual-statement requirements satisfied by the same document where timing aligns (3.3).

Worked examples: (a) NY loan, Q3 2027 (92 days), average daily balance $1,234.56, rate 2.00% → 1,234.56 × 0.02 × 92/365 = $6.2237 → **$6.22** credited 2027-09-30; ledger Dr escrow_interest_expense 622 / Cr escrow 622; event "Interest on Escrow" +6.22. (b) CT loan, 2026: index 0.49% → rounded 0.5% → floor applies → 1.5%; average daily balance $900.00 for 365 days → $13.50 credited 2026-12-31; payoff on 2027-04-10 → prorated 100 days × $900 × 1.5%/365 = $3.70 credited before the refund. (c) MN loan (LTV at origination 75%): first-of-month balances average $1,000.00 → 3% → **$30.00** credited annually. (d) WI loan originated 2016-05-01: 2026 rate 0.17% × average $1,500 → $2.55; a WI loan originated 2019-03-01 → $0 (no statutory interest). (e) MA loan: taxes are $3,000 of $4,200 annual disbursements → tax share 71.43% of the balance; policy rate 0.25% on a $1,400 average → $1,400 × 0.7143 × 0.0025 = $2.50 per year. (f) 1099-INT: borrower with NY interest $24.88 for 2027 → furnish by 2028-01-31; borrower with $8.40 → no 1099.

#### Integrations
- Rate sources: FRB H.15 (1-year CMT; T-bill secondary market), Treasury auction results (91-day), FDIC National Rates (savings), CT DOB deposit index page, WI DFI escrow notice, Utah COFI (FHLB 11th District — discontinued in 2022 **[UNVERIFIED — successor index/handling for the UT option]**), NY DFS, RI DBR, VT DFR — fetched by the `compliance-sentinel` agent with evidence documents and a second-source check; manual entry allowed with evidence.
- Ledger/custodial: corporate funding transfers into the T&I custodial account (Section 6.2/6.4 reconciliation: interest credits are servicer deposits).
- Fannie Mae: "Interest on Escrow" deposit events (3.7).
- Print/e-delivery vendor for 1099-INT; IRS FIRE/IRIS e-filing **[UNVERIFIED which channel the vendor uses]**.

#### Outputs and artifacts
- `escrow_interest_accruals`, `ledger_entries`, `investor_events` (Interest on Escrow), `escrow_interest_1099`, annual statement interest line (3.3), notices: `IRS_1099INT` (Form 1099-INT copy B), `NTC_STATE_ESCROW_INTEREST_STATEMENT_<XX>` where a state requires a stand-alone interest statement not satisfied by the annual statement (ME) — policy; `loan_events`: `escrow.interest.accrued` (daily summary), `escrow.interest.credited`, `escrow.interest.prorated`, `jurisdiction.rate_observation.verified`, `tax.1099int.furnished/filed`.

#### AI agent design (AI-first)
- Agents: `escrow` (eligibility exceptions, posting anomalies), `compliance-sentinel` (rate observations, statute watch: e.g., new states, rate announcements), `security-records` (1099 data handling). Tools: `evaluateInterestEligibility`, `observeRate(source)`, `verifyRate`, `postInterestCredit`, `prorateInterest`, `generate1099`, `escalate`.
- Decision record: {loan, state rule version, eligibility inputs, rate observation ids, accrual math hash, posted cents, rationale}.
- Guardrails: rates only from verified observations; the agent cannot lower a statutory minimum; policy rates (MA/VT/RI/UT) set by compliance with evidence; no fees. Escalations: none legally required; `officer` sign-off on the annual policy-rate memo (MA/VT/RI/UT election) as a governance control; `human_agent` on request.
- AI-off path: scheduled jobs run without the agent; rate observations entered by compliance staff.

#### Edge cases and failure modes
- Occupancy change (owner-occupied → investment) removes NY/CT/RI/ME/MN eligibility prospectively; occupancy evidence from insurance/tax data (Section 9) — policy: rely on the last known occupancy; do not claw back.
- LTV crossing 80% (UT: interest starts when paid down to 80%; MN: exemption fixed at origination) — monthly eligibility recompute.
- PMI cancellation (RI: exemption ends when the loan is no longer PMI-insured) — recompute on `pmi.terminated`.
- Loss-draft funds: excluded from the interest base by default (open question 4).
- Negative balances (advances): no accrual; NH deficiency plans carry 0% interest (3.6).
- Payoff on a crediting date: prorate first, then refund; transfer-out: post accrued interest through the transfer date and include it in the transferred balance.
- Rate source unavailable: accrue at the last verified rate; true-up on verification (never below the statutory minimum).
- Borrower disputes interest math → NoE (4.1); recompute from ledger.
- Bankruptcy: interest continues (it is the borrower's money); Chapter 13 trustee-directed refunds per Section 14.
- Partner is a national bank claiming preemption: default is to pay (open question 3).

#### Test cases and acceptance criteria
| ID | Given / When / Then |
|---|---|
| 3.9-T1 | Given a NY owner-occupied 2-family loan with Q3-2027 average daily balance $1,234.56, then $6.22 is credited on 2027-09-30 with ledger and event evidence. |
| 3.9-T2 | Given a CT loan and the 2026 deposit index 0.49%, then the rate is 1.5% and $13.50 is credited on 2026-12-31 for an average $900 balance; payoff 2027-04-10 credits $3.70 before the refund. |
| 3.9-T3 | Given a MN loan with origination LTV 85%, then `exempt` (ltv_gt_80); with 75% and first-of-month average $1,000, then $30.00 credited annually. |
| 3.9-T4 | Given WI loans originated 1990-06-01, 2016-05-01 and 2019-03-01, then rates 5.25%, 0.17% (2026) and none respectively. |
| 3.9-T5 | Given a RI loan with active PMI, then exempt; after PMI termination, accrual starts the next day. |
| 3.9-T6 | Given a MA loan, then only the tax share of the balance accrues at the policy rate and the annual credit is posted at least once a year. |
| 3.9-T7 | Given a VT loan with escrow imposed after the borrower failed to pay taxes last year, then exempt (escrow_imposed_for_default). |
| 3.9-T8 | Given a NH loan, then the rate switches on Apr 1 and Oct 1 to the FDIC January/July savings rate observations. |
| 3.9-T9 | Given a borrower with $24.88 total interest in 2027, then a 1099-INT is furnished by 2028-01-31 and e-filed by 2028-03-31; with $8.40, no form. |
| 3.9-T10 | Given a rate observation missing on Jan 15 for MD, then accrual continues at the prior verified rate and a sev-2 escalation exists; on verification a true-up posts the difference. |
| 3.9-T11 | Given a negative escrow balance for 20 days, then those days accrue $0. |
| 3.9-T12 | Given an OR loan, then the rate changes on Jul 1 and Jan 1 from the May/Nov auction observations minus 100 bps, floored at 0. |

#### Audit and evidence
Rate observations with source evidence and verifier, per-loan accrual ledgers (exact decimal and posted cents), crediting events, statements showing interest, 1099 records and filings, eligibility decision records, jurisdiction rule versions — for state exams (NY DFS, CA DFPI, CT DOB, etc.) and Fannie Mae escrow-event reconciliation.

### Open questions / decisions
1. Maryland §12-109 (bank-only scope) — pay interest on MD loans serviced for a bank partner/originator? **Default: pay when the originator was a Maryland lending institution or the partner SoR is one; otherwise no** (counsel to confirm).
2. Utah rate option election. **Default: T&I depository's statement-savings rate for like-size accounts, documented annually; floor at the COFI-successor formula if counsel requires.**
3. Partner national-bank preemption claims. **Default: pay** (nonbank subservicer; Kivett/Cantero split).
4. Include loss-draft/renovation funds in the interest base? **Default: no** (T&I only), pending counsel.
5. MA/VT/RI policy rate. **Default: 0.25%**, reviewed annually against prevailing local savings rates.

### Sources
- Fannie Mae B-1-01: https://servicing-guide.fanniemae.com/svc/b-1-01/administering-escrow-account-and-paying-expenses
- N.Y. Gen. Oblig. Law §5-601: https://www.nysenate.gov/legislation/laws/GOB/5-601
- Cal. Civ. Code §2954.8 (FindLaw): https://codes.findlaw.com/ca/civil-code/civ-sect-2954-8/ ; DFPI CitiMortgage settlement: https://dfpi.ca.gov/press_release/citimortgage-agrees-to-pay-7-8-million-in-overdue-interest-on-escrow-impound-accounts/
- Minn. Stat. §47.20: https://www.revisor.mn.gov/statutes/cite/47.20
- Utah Code §7-17-3: https://law.justia.com/codes/utah/title-7/chapter-17/section-3/ ; chapter PDF: https://le.utah.gov/xcode/Title7/Chapter17/C7-17_1800010118000101.pdf
- 9-B M.R.S. §429: https://legislature.maine.gov/statutes/9-B/title9-Bsec429.html
- Conn. Gen. Stat. §49-2a: https://law.justia.com/codes/connecticut/title-49/chapter-846/section-49-2a/ ; CT DOB 2026 deposit index (Dec 9, 2025): https://portal.ct.gov/dob/newsroom/2025/banking-commissioner-announces-2026-deposit-index
- Md. Com. Law §12-109: https://law.justia.com/codes/maryland/commercial-law/title-12/subtitle-1/section-12-109/
- M.G.L. c.183 §61: https://malegislature.gov/Laws/GeneralLaws/PartII/TitleI/Chapter183/Section61
- ORS 86.245 / 86.205: https://oregon.public.law/statutes/ors_86.245 ; https://oregon.public.law/statutes/ors_86.205
- 8 V.S.A. §10404: https://law.justia.com/codes/vermont/title-8/chapter-200/section-10404/
- R.I. Gen. Laws §19-9-2: https://law.justia.com/codes/rhode-island/title-19/chapter-19-9/section-19-9-2/
- NH RSA 397-A:9: https://gc.nh.gov/rsa/html/XXXV/397-A/397-A-9.htm ; RSA 384:16-c: https://law.justia.com/codes/new-hampshire/2013/title-xxxv/chapter-384/section-384-16-c/ ; RSA 384:16-e (repealed 2015): https://law.justia.com/codes/new-hampshire/2015/title-xxxv/chapter-384/section-384-16-e
- Wis. Stat. §138.052: https://law.justia.com/codes/wisconsin/chapter-138/section-138-052/ ; WI DFI escrow rate notice (2026: 0.17%): https://dfi.wi.gov/Pages/FinancialInstitutions/BankingSavingsInstitutions/EscrowNotice.aspx ; NCUA 1991 opinion (5.25% history): https://ncua.gov/regulation-supervision/legal-opinions/1991/preemption-wisconsin-statute-requiring-interest-mortgage-escrow-accounts
- IRS Instructions for Forms 1099-INT and 1099-OID (01/2024): https://www.irs.gov/instructions/i1099int
- BPI interest-on-escrow table (Jan 2026) and OCC preemption materials: see research/00a §5.5
