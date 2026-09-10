# 12.3 — Appeal handling

| Attribute | Value |
|---|---|
| Section | 12 — Loss Mitigation |
| Automation class | b |
| SoR / Sub | Sub |
| Trigger & frequency | On borrower appeal (event-driven) |
| Governing source | Reg X 1024.41(h) |
| Key deadlines | Decision within 30 days; ≥14 days for borrower to accept |
| Timers | `CA_CIV_2923_6D_APPEAL_WINDOW_30`, `CA_CIV_2923_6E_POST_APPEAL_HOLD_15`, `FNMA_D2207_APPEAL_DECIDE_30`, `FNMA_D2207_TPP_FIRST_DUE_15TH_RULE`, `FNMA_E3401_APPEAL_COURT_DELAY_REQUEST_1BD`, `NY_419_7H_APPEAL_WINDOW_14_POSTMARK`, `REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED`, `REGX_1024_41G1_APPEAL_HOLD`, `REGX_1024_41H2_APPEAL_WINDOW_14`, `REGX_1024_41H4_ACCEPT_14`, `REGX_1024_41H4_APPEAL_DECIDE_30`, `SM_APPEAL_INDEPENDENCE_GATE`, `SM_APPEAL_REVIEWER_ASSIGN_1BD` |

### Blueprint row
| Field | Value |
|---|---|
| Area | Loss Mit |
| Trigger & frequency | On borrower appeal (event-driven) |
| Governing source (blueprint) | Reg X 1024.41(h) |
| Key deadlines (blueprint) | Decision within 30 days; ≥14 days for borrower to accept |
| Data/artifacts | Appeal record |
| Systems | SMDU |
| Automation class (blueprint) | b |
| SoR / Sub | [cropped in source] — reconstructed: Sub (Supermortgage performs; independent human reviewer is a Supermortgage `lossmit_reviewer` not involved in the original evaluation) |
| Nuances (blueprint) | "Available when complete app [received ≥90] days [before] sale" [cropped in source]; reconstructed: appeal right exists only if the complete application was received 90 or more days before a scheduled foreclosure sale, or during the §1024.41(f) pre-foreclosure period (no first notice/filing yet), or no sale is scheduled; it covers denials of trial or permanent loan modification options only; the borrower has 14 days to appeal; different personnel decide within 30 days; the borrower gets ≥14 days after the appeal decision to accept; no further appeal |

### Verified requirement (as of 2026-09-09)

**Sources verified:** 12 CFR 1024.41(h)(1)–(4), (e)(2)(iii), (g)(1), (k)(4) and comments 41(h)(3)-1, 41(k)(4)-1/-2 (eCFR 9/08/2026); Fannie Mae D2-2-07 (05/10/2017), E-3.4-01 (07/14/2021); Cal. Civ. Code §2923.6(d)–(e); 3 NYCRR 419.7(h); Servicing Platform Delinquency Reporting action types (00b F4); Colorado SB 24-205 human-review element.

**Availability (§1024.41(h)(1)).** The servicer must permit an appeal of a determination denying **any trial or permanent loan modification program available to the borrower** if the complete application was received **90 days or more before a foreclosure sale** or **during the period set forth in paragraph (f)** (before the first notice/filing, including the 120-day window). No sale scheduled = treated as ≥90 days (comment 41(b)(3)-1). Non-modification denials (forbearance, deferral, short sale) carry no Reg X appeal right — but the platform offers a courtesy reconsideration (and the NPRM would extend appeals to all options).

**Window (§1024.41(h)(2)).** The borrower may appeal **within 14 days after the servicer provides the (c)(1)(ii) notice**. Late appeals need not be honored (policy: treat as new information — see Fannie Mae option below).

**Independent review (§1024.41(h)(3); comment 41(h)(3)-1).** "An appeal shall be reviewed by different personnel than those responsible for evaluating the borrower's complete loss mitigation application." Supervisory personnel who oversee the evaluators may review, provided they were not directly involved in the original evaluation.

**Determination (§1024.41(h)(4)).** **Within 30 days of the borrower making an appeal**, written notice of the determination whether the servicer will offer the borrower a modification option, and, if so, the borrower may be required to accept **no earlier than 14 days after** the notice; the appeal determination is **not subject to further appeal**. §1024.41(e)(2)(iii): an appeal extends the original offer's acceptance deadline to 14 days after the (h)(4) notice. §1024.41(g)(1)/(f)(2)(i): the foreclosure holds continue until the appeal period expires without an appeal or the appeal is denied. §1024.41(k)(4): a pending appeal at transfer must be decided by the transferee within 30 days of the transfer date or of the appeal, whichever is later, or treated as a pending complete application (1.7/17.4).

**Fannie Mae D2-2-07 (05/10/2017).** Applies to **principal residences** when a complete BRP was submitted **90 days or more before a scheduled foreclosure sale date, or the sale date is unknown**; not available where the borrower previously submitted a complete BRP and remained continuously delinquent. The borrower has a **14-day appeal period**; the written appeal must identify the borrower, property address and loan number; the servicer conducts an **independent appeal review** and provides written notice of the decision **within 30 days of receipt**; if approved, the borrower has **14 days from the appeal decision notice** to accept the new trial plan or the initial offer (if still eligible); the appeal decision is final. New information: (1) appeal + new information within the 14 days → evaluate the appeal with the new information; (2) appeal within 14 days, information after → complete the review with it, or treat the request plus the information as a **new complete BRP**; (3) appeal after 14 days → no explicit guidance (policy below). **Trial Period Plan timing after an approved appeal:** decision sent **on or before the 15th** of the month → TPP effective the first day of the next month; **after the 15th** → the first day of the month after next; if arrearages accrued during the appeal, adjust the trial payment using the same approach consistently across all loans. The servicer must make appeal information available to Fannie Mae on request. E-3.4-01: while an appeal is pending, request the court to delay the next legal action unless the borrower is ineligible, rejects all options or breaches an agreement.

**State overlays.** CA §2923.6(d): **at least 30 days** from the written denial to appeal and to provide evidence that the determination was in error; (e) no NOD/NOS until the later of 31 days after the denial or, if appealed, 15 days after the appeal denial, or 14 days after a post-appeal offer is declined/breached. NY 419.7(h): appeal required if the complete application was received ≥90 days before sale; **14 days from the denial notice's postmark**; independent personnel; decision within 30 days; acceptance no earlier than 14 days after the determination; no further appeal; supervisory review of initial denials (12.2). Colorado AI Act: an opportunity to appeal an adverse consequential decision to **human review** — satisfied by this process for all borrowers (policy nationwide).

**Fannie Mae reporting.** Servicing Platform Delinquency Reporting action type **"Modification Denial Under Appeal"** (00b F4; go-live Feb–Mar 2027); until then the appeal is noted in the F-1-21 file comments/status history **[PARTIALLY VERIFIED — no dedicated legacy status code identified]**.

**Discrepancies vs. blueprint row.** (1) The row omits the "(f) period" trigger (appeal also available before the first filing regardless of sale timing) and the "no sale scheduled" case. (2) It omits the 14-day appeal window, the different-personnel rule, the (e)(2)(iii) extension, the TPP-timing rule after an approved appeal, and the CA 30-day/NY postmark variants. (3) "Systems: SMDU" — SMDU is re-queried only when new information changes the decision inputs; the appeal itself is a platform workflow.

### Operational prerequisites
- **Reviewer pool policy** (Supermortgage; partner approval): named `lossmit_reviewer` roster; independence matrix (appeal reviewer ≠ evaluator-run owner ≠ original approving reviewer; supervisors allowed if not directly involved); NY supervisory designations.
- **Templates:** `NTC_REGX_41H4_APPEAL_GRANTED`, `NTC_REGX_41H4_APPEAL_DENIED`, `NTC_REGX_41H_APPEAL_ACK` (policy), `NTC_REGX_41H_APPEAL_INELIGIBLE` (late/non-modification), CA/NY addenda.
- **SMDU re-submission rights** for re-decisioning with corrected inputs (12.2 credentials).
- **Counsel instruction templates** for "appeal pending — do not move for judgment/sale" (13.x).

### Build spec
#### Inputs and triggers
- `lossmit.appeal.received` (Intake Router; any channel — a written appeal is required by Fannie Mae; an oral request to "reconsider" is captured, acknowledged and converted by asking the borrower to confirm in writing or via portal e-sign, while the platform treats the oral date as the appeal date for timer safety — policy).
- `notice.provided{NTC_REGX_41C1_DENIAL|OFFER with denied modification}` → opens the appeal window timer.
- `lossmit.document.received{during_appeal}` → new information handling.
- `transfer.in.completed{appeal_pending}` (1.7); `transfer.out` (17.4).

#### Data model
- `lossmit_appeals`: `id`, `application_id`, `evaluation_id`, `loan_id`, `denial_notice_id`, `appeal_window_ends date`, `received_at`, `received_date`, `channel`, `written_confirmation_document_id?`, `eligible bool`, `ineligibility_reason` ∈ {tier_lt_90_after_filing, non_modification_option, late, duplicative_prior_complete, not_principal_residence_fnma}, `new_information bool`, `new_information_doc_ids[]`, `reviewer_id` (human), `reviewer_independence_check jsonb` (excluded ids, result), `ai_reeval_run_id`, `decision` ∈ {granted_new_offer, granted_original_offer_reinstated, denied}, `decided_at`, `notice_id`, `provided_at`, `accept_by date`, `tpp_first_due date?`, `status`.
- `lossmit_offers` rows created by an appeal carry `origin='appeal'`; original offers get `accept_by` recomputed with `accept_by_basis='e2iii_extension'`.
- `foreclosure_holds{kind=lm_appeal_pending}` (and, in CA, `{kind=state_dual_track:CA, rule_citation='Cal. Civ. Code §2923.6(e)'}`); CA `CA_2923_6E_POST_APPEAL_15`.

#### State machine
`lossmit_appeals.status`: `received` → `eligibility_checked` → `ineligible` (notice; window/holds per original decision) | `under_review` (human reviewer assigned; AI re-evaluation attached) → `decided_granted` | `decided_denied` → `notice_provided` → `awaiting_response` (granted) → `accepted` | `deemed_rejected` | closed. Guards: `assertIndependence` (blocks assignment); `assertWithin30Days` (warn day 20); `assertHoldsActive` (`foreclosure_holds{kind=lm_appeal_pending}` opened on receipt); `assertNoFurtherAppeal` (second appeal on the same determination → `ineligible{final}` unless a *new complete application* is opened per Fannie Mae option 2 and §1024.41(i) allows).

#### Timers and gates
| Timer code | Kind | Trigger event | Anchor | Offset & unit | Satisfied by | Breach action |
|---|---|---|---|---|---|---|
| `REGX_1024_41H2_APPEAL_WINDOW_14` | deadline (borrower) | `notice.provided{denial of modification}` with tier ge_90 or (f) period | `provided_at` | 14 `calendar_days` | `lossmit.appeal.received` | lapse → `lossmit.appeal.window.expired` → holds may release if (g)(1)/(f)(2)(i) satisfied |
| `CA_CIV_2923_6D_APPEAL_WINDOW_30` | deadline (borrower) | same, CA §2924.15 loan | denial date | 30 `calendar_days` | same | overrides 14 for CA |
| `NY_419_7H_APPEAL_WINDOW_14_POSTMARK` | deadline (borrower) | same, NY | postmark date (mailing proof) | 14 `calendar_days` | same | — |
| `REGX_1024_41H4_APPEAL_DECIDE_30` | deadline | `lossmit.appeal.received` (eligible) | `received_date` | 30 `calendar_days` | `notice.provided{NTC_REGX_41H4_*}` | warn day 20; `officer` sev-1 on breach |
| `FNMA_D2207_APPEAL_DECIDE_30` | deadline | same | same | 30 `calendar_days` | same | sev-2 (dual-cited) |
| `SM_APPEAL_REVIEWER_ASSIGN_1BD` | deadline (SLA) | `lossmit.appeal.received` | receipt | 1 `business_days_servicer` | `lossmit.appeal.reviewer_assigned` | supervisor escalation |
| `SM_APPEAL_INDEPENDENCE_GATE` | not_before_gate | reviewer assignment | — | — | independence check passed | assignment refused |
| `REGX_1024_41H4_ACCEPT_14` | deadline (borrower) | `notice.provided{appeal granted}` | `provided_at` | 14 `calendar_days` (+ policy grace 5) | `lossmit.offer.accepted` | deemed rejection after grace |
| `REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED` | deadline (borrower) | `lossmit.appeal.received` while an original offer is pending | appeal notice `provided_at` | 14 `calendar_days` after the (h)(4) notice | acceptance | deemed rejection |
| `REGX_1024_41G1_APPEAL_HOLD` | not_before_gate | `lossmit.appeal.received` | — | until appeal denied or window lapses | `foreclosure_holds.closed{kind=lm_appeal_pending}` | 13.x refuses motion/sale |
| `CA_CIV_2923_6E_POST_APPEAL_HOLD_15` | not_before_gate | CA appeal denied | denial `provided_at` | 15 `calendar_days` (or 14 days after post-appeal offer declined) | lapse | 13.x refuses NOD/NOS |
| `FNMA_D2207_TPP_FIRST_DUE_15TH_RULE` | deadline (computed) | appeal granted with TPP | decision notice sent date | first of next month if sent ≤15th; first of month after next if sent >15th | trial schedule created | — |
| `FNMA_E3401_APPEAL_COURT_DELAY_REQUEST_1BD` | deadline (policy) | appeal received on a loan in foreclosure | receipt | 1 `business_days_servicer` | `attorney.instruction.acknowledged` | `attorney` sev-1 |

#### Business rules and calculations
1. **Eligibility:** `eligible = tier ∈ {ge_90} OR first_filing_made_at_receipt=false` (Reg X) AND the appealed determination denied a trial/permanent modification (Flex Mod, including "not evaluated/ineligible by loan data" outcomes). Fannie Mae additionally requires principal residence — for non-principal-residence loans, Reg X still governs (Reg X §1024.30(c)(2) exempts only reverse mortgages/qualified lenders; §1024.41 applies to any federally related mortgage loan) so the platform grants the appeal whenever Reg X requires it and reports the D2-2-07 variance in the decision record.
2. **Appeal date** = date received by any Supermortgage channel (oral reconsideration requests are logged with the same date and confirmed in writing; policy).
3. **Late appeals:** received after the window → `ineligible{late}` with `NTC_REGX_41H_APPEAL_INELIGIBLE`; any new information is (a) treated as an NoE if it asserts an error (4.1), (b) evaluated under Fannie Mae option 2 as a new BRP if it changes eligibility and §1024.41(i) allows (borrower became current since) — otherwise a discretionary re-evaluation without Reg X rights, disclosed as such.
4. **Independence:** `excluded_ids = {evaluator agent run's accountable human (if AI-off), original lossmit_reviewer, anyone who edited reason codes, direct supervisor if directly involved}`; the appeal reviewer is drawn from the remaining pool; the AI re-evaluation runs as a fresh `agent_run` with a *different prompt version tag* (`appeal`) and no access to the original rationale text — only inputs and new information — and its output is advisory to the human reviewer, who signs the determination (the human is the "personnel").
5. **Re-evaluation scope:** re-run the full hierarchy (12.2) with corrected/new inputs; re-decision in SMDU when inputs changed; if the original denial rested on an error, grant; the notice explains the outcome for each denied modification option.
6. **Post-appeal offer mechanics:** granted → new offer with `accept_by = provided_at + 14` (NY 14; CA 14 — CA's 30 days applies to the *appeal* window, not acceptance); the original offer (if any) is reinstated with the same `accept_by` ((e)(2)(iii)). TPP first due date per the 15th rule; arrears accrued during the appeal added to capitalization (12.8) consistently.
7. **Worked dates:** denial provided Mon 2026-11-02 → appeal window ends 2026-11-16 (CA: 2026-12-02; NY: 14 days from postmark 2026-11-02 → 2026-11-16). Appeal received Thu 2026-11-12 → decision due 2026-12-12; notice provided Tue 2026-12-08 (≤15th) → TPP first payment due **2027-01-01**; accept by **2026-12-22**; the original Payment Deferral offer (if pending) also runs to 2026-12-22. CA: no NOD/NOS before 2026-12-03 (31 days after denial) and, after an appeal denial provided 2026-12-08, not before 2026-12-23.
8. **Holds:** `foreclosure_holds{kind=lm_appeal_pending}` opened on receipt (even before eligibility is confirmed) and closed on ineligibility (after reviewer confirmation), denial notice provision + CA/NY tail, or acceptance/deemed rejection of the post-appeal offer (then 12.8 trial holds take over).

#### Integrations
- **SMDU:** re-submission of the affected case type with corrected inputs (idempotency key includes `appeal_id`); rep-and-warrant relief on the new decision; portal fallback as in 12.2.
- **Counsel:** hold/delay instruction and acknowledgment (`attorney-network`).
- **Investor reporting:** "Modification Denial Under Appeal" action type when the Delinquency Reporting event goes live; legacy: comment field **[PARTIALLY VERIFIED]**.
- **Print/mail & e-delivery:** appeal notices; postmark evidence retained for NY.

#### Outputs and artifacts
- `NTC_REGX_41H_APPEAL_ACK` (policy; within 5 business days): confirms receipt date, the 30-day decision date, that different personnel will review, how to send additional information, foreclosure-hold statement.
- `NTC_REGX_41H4_APPEAL_GRANTED` (§1024.41(h)(4); D2-2-07): determination per option, new offer terms, `accept_by` (≥14 days), original-offer reinstatement statement, TPP first due date, "no further appeal" statement.
- `NTC_REGX_41H4_APPEAL_DENIED` (§1024.41(h)(4), (d)): specific reasons per option (investor requirement named), no further appeal, other options still available, foreclosure consequences (CA 15-day statement; NY DFS complaint statement), Colorado explanation block (human reviewer decided; AI contribution described), counselor/HOPE hotline.
- `NTC_REGX_41H_APPEAL_INELIGIBLE` (late/non-modification/tier): reason, what the borrower can do (NoE, new application after becoming current, courtesy reconsideration).
- Records: `lossmit_appeals`, `agent_decisions{kind=lossmit.appeal_reeval}`, human determination record (`escalations` closed with decision), independence-check evidence, `foreclosure_holds`, counsel acknowledgments, notices with proof; investor action type.

#### AI agent design (AI-first)
- **Agent:** `lossmit-underwriter` sub-role `appeal` (fresh run; prompt version `appeal`; tool allowlist excludes reading the original rationale text; may read inputs, new documents and SMDU outputs). It (1) confirms eligibility, (2) sends the acknowledgment, (3) sets holds and instructs counsel, (4) re-runs the hierarchy with new information, (5) drafts both possible notices, and (6) files the package to the human appeal reviewer. The **human `lossmit_reviewer` (independent) signs the determination** — this is the legally required touchpoint (§1024.41(h)(3) "personnel"; Colorado human review; LL-2026-04 accountability).
- **Decision record:** `{appeal_id, eligibility{tier, first_filing, option_types, fnma_principal_residence}, excluded_ids, reviewer_id, new_information_summary, reeval_trace (12.2 schema), recommended_outcome, human_decision, human_edits, notices}`.
- **Guardrails:** the appeal agent cannot be the same run/prompt as the evaluator; cannot see or copy the original denial rationale; cannot issue a notice before the human decision; must treat any borrower statement of error as an NoE candidate.
- **Escalations:** `attorney` (holds), `fnma_portal_operator` (SMDU UI fallback), `human_agent` on request, `officer` if a breach is imminent.
- **AI-off path:** human reviewer performs the re-evaluation with the rules engine; independence still enforced by the assignment gate.

#### Edge cases and failure modes
- **Appeal + new application in one letter:** open the appeal and, if the borrower has been current since the prior complete application, a new application; else the information feeds the appeal only.
- **Appeal of a non-modification denial (e.g., short sale):** courtesy reconsideration by a different reviewer within 30 days; no Reg X hold — but Fannie Mae E-3.4-01 and CA §2924.11 (foreclosure prevention alternatives) may still require delays; `lossmit_reviewer` decides holds.
- **Transfer-in with pending appeal (1.7):** decide within 30 days of transfer or of the appeal (later); if unable (records missing), treat as a pending complete application ((k)(4)(ii)) and let the borrower accept the transferor's offers.
- **Transfer-out (17.4):** ship the appeal file with timers; goodbye package flags `appeal_pending`.
- **Bankruptcy filed during appeal:** continue; notices via counsel; holds already in place.
- **Sale scheduled during appeal:** counsel instructed to postpone; if the sale is conducted, sev-1 incident and §1024.35(b)(10) exposure.
- **Borrower dies / successor appeals:** confirmed successor steps into the borrower's rights (4.4).
- **Reviewer pool exhausted (small team):** supervisor not directly involved may review (comment 41(h)(3)-1); if none, partner-designated reviewer under the subservicing agreement (open question 2).
- **New information arrives after the decision:** treated as a new application if §1024.41(i) allows; otherwise NoE/courtesy review; the (h)(4) determination stands.

#### Test cases and acceptance criteria
- **12.3-T1:** Given a denial provided 2026-11-02 (tier ge_90) and an appeal received 2026-11-12, when processed, then a reviewer with no involvement is assigned by 2026-11-13, the decision notice is provided by 2026-12-12, and `accept_by = provided_at + 14`.
- **12.3-T2 (independence):** assignment of the original approving reviewer is refused with a logged reason; assignment of an uninvolved supervisor is accepted.
- **12.3-T3 (late appeal):** appeal received 2026-11-20 → ineligible notice; new pay stubs reviewed as new information; foreclosure holds released only after reviewer confirmation.
- **12.3-T4 (e)(2)(iii):** a pending deferral offer with `accept_by` 2026-11-16 is extended to appeal notice + 14.
- **12.3-T5 (TPP timing):** appeal granted, notice sent 2026-12-16 → first trial payment due 2027-02-01; sent 2026-12-15 → 2027-01-01.
- **12.3-T6 (CA):** appeal received on day 25 after the denial is timely (30-day window); NOD refused until 15 days after the appeal denial.
- **12.3-T7 (NY postmark):** denial postmarked 2026-11-03 though printed 2026-11-02 → NY window ends 2026-11-17.
- **12.3-T8 (before first filing):** loan 100 days delinquent, no filing, denial → appeal available even though a hypothetical sale date is unknown.
- **12.3-T9 (transfer-in):** appeal filed with transferor 2026-10-28, transfer date 2026-11-01 → decision due 2026-12-01 (later of 30 days from transfer/appeal).
- **12.3-T10 (breach):** decision not provided by day 30 → `officer` sev-1, borrower notified of status, holds maintained.

#### Audit and evidence
Appeal receipt evidence (document/transcript with timestamp), eligibility record, independence check (excluded ids and pool), the fresh AI re-evaluation record, the human determination with signature/timestamp, notices with provision proofs, counsel instructions/acknowledgments, hold history and timer history — the §1024.41(h)/(g)(1) litigation file and the Colorado human-review evidence.

### Open questions / decisions
1. **Oral appeals.** Default: accept the oral request date as the appeal date and obtain written confirmation (Fannie Mae requires a written appeal; Reg X is silent). 
2. **Reviewer pool fallback** when Supermortgage cannot field an uninvolved reviewer. Default: partner-designated reviewer under the subservicing agreement; document in the AI-governance program.
3. **Courtesy reconsideration for non-modification denials.** Default: offer it (30 days, different reviewer, no Reg X hold), disclosed as discretionary.
4. **Nationwide human review for every appeal** (not just Colorado). Default: yes.

### Sources
- 12 CFR 1024.41(e)(2)(iii), (g)(1), (h), (k)(4): https://www.ecfr.gov/current/title-12/chapter-X/part-1024/subpart-C/section-1024.41 (verified 2026-09-09)
- CFPB interpretations (41(h)(3)-1, 41(k)(4)): https://www.consumerfinance.gov/rules-policy/regulations/1024/interp-41/ (verified 2026-09-09)
- Fannie Mae D2-2-07: https://servicing-guide.fanniemae.com/svc/d2-2-07/resolving-appeal-mortgage-loan-modification-trial-period-plan-denial-principal-residence (05/10/2017; verified 2026-09-09)
- Fannie Mae E-3.4-01: https://servicing-guide.fanniemae.com/svc/e-3.4-01/suspending-foreclosure-proceedings-workout-negotiations (verified 2026-09-09)
- Cal. Civ. Code §2923.6(d)–(e): https://law.justia.com/codes/california/code-civ/division-3/part-4/title-14/chapter-2/article-1/section-2923-6/ (verified 2026-09-09)
- 3 NYCRR 419.7(h): https://regulations.justia.com/states/new-york/title-3/chapter-iii/subchapter-b/part-419/section-419-7/ (verified 2026-09-09)
- research/00b §F4 (Delinquency Reporting action types)
