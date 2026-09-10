/**
 * Registry overrides for Section 3 (escrow) timers whose spec rows are prose.
 * Each override cites the row it encodes. Conditions the columns state in
 * prose ("with surplus ≥ $50 and borrower current", "(kind surplus_refund)",
 * "with method lead honored") are carried as payload qualifiers on the events
 * the §3 tools emit, so a bare event of the right type never arms or
 * satisfies a row it does not belong to.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyEscrowTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 3.2 analysis --------------------------------------------------------
  // The approval of an analysis that starts a computation year (initial, annual, transfer_in, reinstatement, or an interim with reset) is the fact that fixes the next year end; the 3.2 timer-sweep's `escrow.analysis.due` is this instance's −45 lead.
  o("REGX_1024_17C3_ANNUAL_ANALYSIS_0", { trigger: "`escrow.analysis.approved{starts_computation_year=true}`", anchorField: "next_computation_year_end",
    why: "§3.2 timer table: computation year end (`computation_year_end`) → annual analysis (§1024.17(c)(3)); armed by the approval that starts the year, anchored on `next_computation_year_end` in its payload." });
  // Armed once at establishment (`escrow.account.established{next_computation_year_end}`, the row's first trigger); recurring — each satisfying annual `escrow.analysis.completed` re-arms it for the year it projects (the row's "prior `escrow.analysis.effective`"), so the completed payload carries `next_computation_year_end` too.
  o("REGX_1024_17C3_ANNUAL_ANALYSIS_LEAD_45", { anchorField: "next_computation_year_end", satisfied: "`escrow.analysis.completed{analysis_type=annual}`",
    why: "§3.2 timer table: `escrow.account.established` / prior analysis → `computation_year_end` − 45 calendar days; satisfied by `escrow.analysis.completed` (type annual)." });
  o("REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE", { trigger: "`escrow.advance.posted{cause!=default}`", offset: "until escrow.analysis.completed",
    why: "§3.2 timer table: advance posted (non-default cause) → deficiency recovery gated until interim `escrow.analysis.completed` (§1024.17(f)(1))." });
  // ---- 3.3 statements ------------------------------------------------------
  // The grammar allows one satisfying pattern per code; the (i)(2) hold is carried on the same prefix with the same qualifiers, so `escrow.statement.rendered/due` never satisfy it.
  o("REGX_1024_17I_ANNUAL_STMT_30", { trigger: "`escrow.analysis.approved{analysis_type=annual}`", anchorField: "computation_year_end", satisfied: "`escrow.statement.*{statement_type=annual, disposition∈{sent, exempt_hold}}`",
    why: "§3.3 timer table: `escrow.analysis.approved` (annual) → `computation_year_end` + 30 calendar days; satisfied by `escrow.statement.sent` (annual) or `escrow.statement.exempt_hold` with a valid (i)(2) reason (recordExemptHold emits only delinquent_30 / foreclosure_action). The row's second trigger, computation year end without an approval, is REGX_1024_17C3_ANNUAL_ANALYSIS_0's breach (\"statement timer (3.3) will also run\")." });
  o("REGX_1024_17I4_SHORT_YEAR_RESET_60", { trigger: "`escrow.analysis.approved{reset=true}`", anchorField: "short_year_end", satisfied: "`escrow.statement.sent{statement_type=short_year_reset}`",
    why: "§3.3 timer table: `escrow.analysis.approved` with reset → end of the short year + 60 calendar days; satisfied by `escrow.statement.sent` (short_year_reset). The 3.8 branch (`escrow.account.closed`, waiver approved) is armed explicitly by the escrow-event tool on that event with `short_year_end` = closure date — one code, two triggers." });
  o("REGX_1024_17I4_SHORT_YEAR_TRANSFER_60", { anchorField: "respa_effective_date", satisfied: "`escrow.statement.sent{statement_type=short_year_transfer}`",
    why: "§3.3 timer table: `transfer.batch.cutover_completed` → transfer effective date (`respa_effective_date` on the §1/§17 event) + 60 calendar days; satisfied by `escrow.statement.sent` (short_year_transfer)." });
  o("REGX_1024_17I4_SHORT_YEAR_PAYOFF_60", { satisfied: "`escrow.statement.sent{statement_type=short_year_payoff}`", why: "§3.3 timer table: `payoff.funds_received` + 60 calendar days; satisfied by `escrow.statement.sent` (short_year_payoff)." });
  o("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90", { satisfied: "`escrow.statement.sent{statement_type=post_exemption_history}`", why: "§3.3 timer table: exemption end + 90 calendar days; satisfied by `escrow.statement.sent` (post_exemption_history)." });
  o("REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL", { anchorField: "computation_year_start", satisfied: "`escrow.statement.sent{shortage_explained=true}`",
    why: "§3.3 timer table: computation year start + 12 months, recurring; satisfied by any `escrow.statement.sent` whose payload includes a shortage/deficiency explanation, or `NTC_REGX_1024_17F_SHORTAGE` sent — recordStatementSent sets `shortage_explained` for both (the (f)(5) notice is sent through the same statement path with statement_type shortage_notice)." });
  o("STATE_UT_7_17_5_ANNUAL_STMT_60", { trigger: "`period.year_end`", satisfied: "`escrow.statement.sent{statement_type∈{annual, state_supplement}}`", why: "§3.3 timer table: calendar year end (Dec 31) + 60 calendar days (Utah 7-17-5); satisfied by the annual statement or the state supplement." });
  // ---- 3.5 refunds ---------------------------------------------------------
  // `decision=refund` is exactly the 3.2 R8 branch "surplus ≥ $50 and borrower current" (decide(): current && surplus ≥ 5,000 cents); the approval payload also carries surplus_cents and borrower_current for the audit.
  o("REGX_1024_17F2_SURPLUS_REFUND_30", { trigger: "`escrow.analysis.approved{decision=refund, borrower_current=true}`", anchorField: "as_of", satisfied: "`disbursement.issued{kind=surplus_refund}`",
    why: "§3.5 timer table: `escrow.analysis.approved` with surplus ≥ $50 and borrower current → `escrow_analyses.as_of_date` (the approval payload's `as_of`) + 30 calendar days; satisfied by `disbursement.issued` (kind surplus_refund)." });
  o("REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD", { satisfied: "`disbursement.issued{kind=payoff_refund}`",
    why: "§3.5 timer table: `loan.paid_in_full` + 20 business_days_federal; satisfied by `disbursement.issued` (kind payoff_refund) — a credit to a new loan is the same disbursement with method credit_to_new_loan (3.5 data model), emitted alongside `escrow.credit_to_new_loan.posted`." });
  // ---- 3.6 shortage / deficiency ------------------------------------------
  o("FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE", { trigger: "`escrow.analysis.computing{reason=workout}`", evaluator: "3.6.workoutSpread60",
    why: "§3.6 timer table: workout analysis plan.months = 60 unless borrower election (≥ 12) evidenced (B-1-01)." });
  o("REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE", { evaluator: "3.6.shortageMinSpread", why: "§3.6 timer table: plan.months ≥ 12 when shortage ≥ one month (§1024.17(f)(3))." });
  o("REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE", { evaluator: "3.6.deficiencyMinInstallments", why: "§3.6 timer table: plan.months ≥ 2 for deficiencies (§1024.17(f)(4))." });
  // ---- 3.7 disbursements ---------------------------------------------------
  o("ESC_PAYEE_REJECT_REPLAN_2BD", { trigger: "`disbursement.rejected`", why: "§3.7 timer table: `disbursement.rejected/returned` → re-plan within 2 servicer BD (`disbursement.returned` arms the same code)." });
  o("FNMA_B101_DISCOUNT_CAPTURE_WARN", { anchorField: "discount_date", offset: "−10 business_days_servicer",
    why: "§3.7 timer table: bill with discount → warn at discount_date − lead; the lead is per method (ESC_RELEASE_LEAD_<METHOD>: −10 tax_service_bulk, −7 check, −3 ach, −2 vendor_epay, −1 wire), so the warning is armed at the longest lead — the tax_service_bulk default for taxes (open question 1) — and is never late for a faster rail (B-1-01)." });
  o("FNMA_LL2026_05_ESCROW_PERIOD_CLOSE_BD2_1700ET", { trigger: "`period.month_end`", offset: "BD2 17:00 ET",
    why: "§3.7 timer table: month end → all period escrow events accepted by BD2 of next month 17:00 ET (`fannie_et`; LL-2026-05)." });
  // ---- 3.8 waivers ---------------------------------------------------------
  o("FLOOD_12CFR22_5_ESCROW_GATE", { trigger: "`escrow.waiver.evaluating{flood_escrow_mandatory=true, flood_line=true}`", evaluator: "3.8.floodEscrowMandatory",
    why: "§3.8 timer table: waiver evaluation with `flood_escrow_mandatory=true` and a flood line — waiver barred (12 CFR 22.5)." });
  o("FNMA_B101_MI_MONTHLY_ESCROW_GATE", { trigger: "`escrow.waiver.evaluating{borrower_paid_mi_monthly=true}`", evaluator: "3.8.miMonthlyEscrowRequired",
    why: "§3.8 timer table: waiver evaluation with monthly borrower-paid MI — escrow required (B-1-01)." });
  o("FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE", { evaluator: "3.8.escrowEstablishedOrExceptionDocumented",
    why: "§3.8 timer table: escrow established (or exception documented: current on T&I + Flex Mod) before trial plan offer (B-1-01)." });
  // Same-day revocation is rule-driven (3.8 rule 5): postAdvance on a waived loan emits the advance with waived=true and then the revocation and establishment facts itself, so the deadline is satisfied by the establishment it caused.
  o("FNMA_B101_WAIVER_REVOKE_ON_ADVANCE_0", { trigger: "`escrow.advance.posted{waived=true}`", anchorField: "advanced_on", satisfied: "`escrow.account.established{reason=waiver_revoked}`",
    why: "§3.8 timer table: `escrow.advance.posted` on a waived loan → same day; satisfied by `escrow.waiver.revoked` + `escrow.account.established` (the establishment follows the revocation in the same command, so the later fact closes the row)." });
  o("REGZ_1026_35B3_HPML_ESCROW_5Y_GATE", { trigger: "`escrow.waiver.evaluating{hpml_flag=true}`", anchorField: "consummation_date", offset: "+60 months",
    why: "§3.8 timer table: HPML escrow required 5 years (60 months) from `consummation_date` (§1026.35(b)(3))." });
  o("REGZ_1026_35B3_HPML_LTV_GATE", { trigger: "`escrow.waiver.evaluating{hpml_flag=true}`", evaluator: "3.8.hpmlLtvAndCurrent",
    why: "§3.8 timer table: UPB < 80% of original value and not delinquent (§1026.35(b)(3)(ii))." });
  o("STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE", { trigger: "`escrow.waiver.requested{state=IL}`", evaluator: "3.8.illinoisTerminationRight",
    why: "§3.8 timer table: balance ≤ 65% of original amount by timely payments, not in default, not gov-insured, HPML rules satisfied (765 ILCS 910/5)." });
  o("STATE_MN_47_20_DISCONTINUE_NOTICE_60", { trigger: "`loan.anniversary{n=5, of=mortgage_date}`", why: "§3.8 timer table: 5th anniversary of the mortgage date + 60 calendar days (Minn. Stat. 47.20 subd. 9)." });
  // ---- 3.9 escrow interest -------------------------------------------------
  o("IRS_1099INT_EFILE_0331", { trigger: "`tax_year.closed`", offset: "Mar 31", why: "§3.9 timer table: tax year end → e-file by Mar 31 (10+ returns mandate)." });
  o("IRS_1099INT_FURNISH_0131", { trigger: "`tax_year.closed`", offset: "Jan 31 (rolled to the next federal business day)", satisfied: "`tax.1099int.furnished`",
    why: "§3.9 timer table: tax year end → furnish by Jan 31 (next business day if weekend/holiday per IRS rules); satisfied by `escrow_interest_1099.furnished_at` — the 3.9 output event `tax.1099int.furnished`." });
  o("STATE_IOE_PAYOFF_PRORATE_0", { anchorField: "event_on", satisfied: "`escrow.interest.credited{prorated=true}`",
    why: "§3.9 timer table: `loan.paid_in_full` / cutover / closure → same day, before the refund; satisfied by `escrow.interest.credited` (prorated) — prorateInterest posts it with prorated=true and issueRefund refuses a payoff/waiver refund on an interest-on-escrow loan until it exists." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("FNMA_LL2026_05_ESCROW_EVENT_0300ET", { trigger: "`ledger.entries.posted{account=escrow}`", why: "§3.7 timer table: `ledger_entries` posted to `escrow` (processed date D) → event next `fannie_et` BD 03:00 ET (LL-2026-05)." });
  o("ESC_WAIVER_DECISION_SLA_10BD", { trigger: "`escrow.waiver.requested`", why: "§3.8 timer table: `escrow_waiver` case opened → decision within 10 `business_days_servicer`." });
  o("STATE_IOE_ACCRUAL_DAILY", { trigger: "`schedule.tick{cadence=daily}`", offset: "daily", why: "§3.9 timer table: interest-on-escrow accrual each calendar day while eligible." });

  // ---- satisfaction: rows whose `satisfied` column is prose get the event the domain emits, gates get evaluators ----------
  o("REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE", { evaluator: "3.6.interimAnalysisBeforeDemand", why: "§3.2/3.6 timer table: gate opens on the interim `escrow.analysis.completed` — condition-shaped." });
  o("ESC_NEW_PAYMENT_NOTICE_MIN_30", { evaluator: "3.2.newPaymentAtLeast30DaysAfterStatement", why: "§3.2 timer table: policy not-before gate — the new payment is effective ≥ 30 days after the statement." });
  o("REGX_1024_17C5_CUSHION_CAP_GATE", { evaluator: "3.4.cushionCap", why: "§3.4 timer table: `cap_check_passed=true` — an analysis invariant, so an evaluator (approveAnalysis reads it from the engine's `escrow.analysis.completed`)." });
  o("REGX_1024_17C6_PREACCRUAL_GATE", { evaluator: "3.4.preaccrual", why: "§3.4 timer table: `preaccrual_check_passed=true` (read from the engine's `escrow.analysis.completed`)." });
  o("ESC_REFUND_FINAL_DISBURSEMENT_HOLD_5BD", { satisfied: "`escrow.final_disbursements.settled`", why: "§3.5 timer table: release or cancellation of in-flight disbursements after payoff." });
  o("REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0", { satisfied: "`disbursement.sent{lead_honored=true}`", why: "§3.7 timer table: `disbursement.sent` with the method lead honored (then `confirmed` from the rail); releaseDisbursement emits it with `lead_honored` computed from release_on, must_pay_by and the method lead — a release with the lead missed (false) or no must-pay date (null) never satisfies it." });
  o("FNMA_B101_DISBURSE_BEFORE_PENALTY_0", { satisfied: "`disbursement.sent{lead_honored=true}`", why: "§3.7 timer table: 'same' as REGX_1024_17K_DISBURSE_BEFORE_PENALTY_0 — `disbursement.sent` with the method lead honored (then `confirmed`); releaseDisbursement emits it with `lead_honored`." });
  o("FNMA_LL2026_05_ESCROW_EVENT_0300ET", { satisfied: "`escrow.event.accepted`", why: "§3.7 timer table: `investor_events.status ∈ {accepted, accepted_warning}` — the escrow event ack." });
  o("FNMA_LL2026_05_ESCROW_PERIOD_CLOSE_BD2_1700ET", { trigger: "`period.month_end`", satisfied: "`escrow.period.closed{all_accepted=true}`", why: "§3.7 timer table: month end → all period events accepted by BD2 17:00 ET." });
  o("FNMA_LL2026_05_ESCROW_SETUP_CUTOVER", { trigger: "`feature_flag.enabled{flag=investor_reporting.escrow_events}`", satisfied: "`escrow.setup_events.accepted{pct=100}`", why: "§3.7 timer table: Setup events accepted for 100% of escrowed loans at cutover." });
  o("STATE_IL_765ILCS910_15_TAX_PAID_NOTICE_45BD", { satisfied: "`notice.sent{template=NTC_IL_765_910_15_TAX_PAID}`", why: "§3.7 timer table: 765 ILCS 910/15 tax-paid notice within 45 business days." });
  o("ESC_NONESCROW_TAX_DELINQ_FOLLOWUP_30", { satisfied: "`escrow.nonescrow.tax_delinquency.resolved{outcome∈{proof_of_payment, advance_and_revocation}}`", why: "§3.7 timer table: borrower proof of payment, or advance + waiver revocation (3.8)." });
  o("REGZ_1026_35B3_HPML_ESCROW_5Y_GATE", { trigger: "`escrow.waiver.requested{hpml=true}`", evaluator: "3.8.hpmlFiveYears", why: "§3.8 timer table: HPML escrow cancellation not before consummation + 5 years (§1026.35(b)(3))." });
  o("ESC_WAIVER_REFUND_30", { anchorField: "closed_on", satisfied: "`disbursement.issued{kind=waiver_refund}`", why: "§3.8 timer table: `escrow.account.closed` (closure date `closed_on`) + 30 calendar days; 'refund issued / credited' — the 3.5 issueRefund tool's `disbursement.issued` with kind waiver_refund." });
  o("STATE_MN_47_20_DISCONTINUE_NOTICE_60", { trigger: "`loan.anniversary{years=5}`", satisfied: "`notice.sent{template=NTC_MN_47_20_9_DISCONTINUE_RIGHT}`", why: "§3.8 timer table: 5th anniversary of the mortgage date → Minn. Stat. 47.20 subd. 9 notice within 60 days." });
  o("STATE_IOE_ACCRUAL_DAILY", { satisfied: "`escrow.interest.accrued`", why: "§3.9 timer table: 'accrual row for the day' — the daily accrual summary event postInterestCredit emits from the balance series it accrues." });
  o("IRS_1099INT_EFILE_0331", { trigger: "`period.year_end`", satisfied: "`tax.1099int.filed`", why: "§3.9 timer table: tax year end → e-file by March 31; satisfied by `filed_at`." });
}
