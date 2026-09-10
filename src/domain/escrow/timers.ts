/**
 * Registry overrides for Section 3 (escrow) timers whose spec rows are prose.
 * Each override cites the row it encodes.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyEscrowTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 3.2 analysis --------------------------------------------------------
  o("REGX_1024_17C3_ANNUAL_ANALYSIS_0", { trigger: "`escrow.computation_year.ended`", why: "§3.2 timer table: computation year end (`computation_year_end`) → annual analysis (§1024.17(c)(3))." });
  o("REGX_1024_17F1_ADVANCE_DEFICIENCY_ANALYSIS_GATE", { trigger: "`escrow.advance.posted{cause!=default}`", offset: "until escrow.analysis.completed",
    why: "§3.2 timer table: advance posted (non-default cause) → deficiency recovery gated until interim `escrow.analysis.completed` (§1024.17(f)(1))." });
  // ---- 3.3 statements ------------------------------------------------------
  o("STATE_UT_7_17_5_ANNUAL_STMT_60", { trigger: "`period.year_end`", why: "§3.3 timer table: calendar year end (Dec 31) + 60 calendar days (Utah 7-17-5)." });
  // ---- 3.6 shortage / deficiency ------------------------------------------
  o("FNMA_B101_WORKOUT_SHORTAGE_SPREAD_60_GATE", { trigger: "`escrow.analysis.computing{reason=workout}`", evaluator: "3.6.workoutSpread60",
    why: "§3.6 timer table: workout analysis plan.months = 60 unless borrower election (≥ 12) evidenced (B-1-01)." });
  o("REGX_1024_17F3_SHORTAGE_MIN_SPREAD_GATE", { evaluator: "3.6.shortageMinSpread", why: "§3.6 timer table: plan.months ≥ 12 when shortage ≥ one month (§1024.17(f)(3))." });
  o("REGX_1024_17F4_DEFICIENCY_MIN_INSTALLMENTS_GATE", { evaluator: "3.6.deficiencyMinInstallments", why: "§3.6 timer table: plan.months ≥ 2 for deficiencies (§1024.17(f)(4))." });
  // ---- 3.7 disbursements ---------------------------------------------------
  o("ESC_PAYEE_REJECT_REPLAN_2BD", { trigger: "`disbursement.rejected`", why: "§3.7 timer table: `disbursement.rejected/returned` → re-plan within 2 servicer BD (`disbursement.returned` arms the same code)." });
  o("FNMA_B101_DISCOUNT_CAPTURE_WARN", { anchorField: "discount_date", offset: "−5 business_days_servicer",
    why: "§3.7 timer table: bill with discount → release by discount date less disbursement lead (policy lead 5 servicer BD; B-1-01)." });
  o("FNMA_LL2026_05_ESCROW_PERIOD_CLOSE_BD2_1700ET", { trigger: "`period.month_end`", offset: "BD2 17:00 ET",
    why: "§3.7 timer table: month end → all period escrow events accepted by BD2 of next month 17:00 ET (`fannie_et`; LL-2026-05)." });
  // ---- 3.8 waivers ---------------------------------------------------------
  o("FLOOD_12CFR22_5_ESCROW_GATE", { trigger: "`escrow.waiver.evaluating{flood_escrow_mandatory=true, flood_line=true}`", evaluator: "3.8.floodEscrowMandatory",
    why: "§3.8 timer table: waiver evaluation with `flood_escrow_mandatory=true` and a flood line — waiver barred (12 CFR 22.5)." });
  o("FNMA_B101_MI_MONTHLY_ESCROW_GATE", { trigger: "`escrow.waiver.evaluating{borrower_paid_mi_monthly=true}`", evaluator: "3.8.miMonthlyEscrowRequired",
    why: "§3.8 timer table: waiver evaluation with monthly borrower-paid MI — escrow required (B-1-01)." });
  o("FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE", { evaluator: "3.8.escrowEstablishedOrExceptionDocumented",
    why: "§3.8 timer table: escrow established (or exception documented: current on T&I + Flex Mod) before trial plan offer (B-1-01)." });
  o("REGZ_1026_35B3_HPML_ESCROW_5Y_GATE", { trigger: "`escrow.waiver.evaluating{hpml_flag=true}`", anchorField: "consummation_date", offset: "+60 months",
    why: "§3.8 timer table: HPML escrow required 5 years (60 months) from `consummation_date` (§1026.35(b)(3))." });
  o("REGZ_1026_35B3_HPML_LTV_GATE", { trigger: "`escrow.waiver.evaluating{hpml_flag=true}`", evaluator: "3.8.hpmlLtvAndCurrent",
    why: "§3.8 timer table: UPB < 80% of original value and not delinquent (§1026.35(b)(3)(ii))." });
  o("STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE", { trigger: "`escrow.waiver.requested{state=IL}`", evaluator: "3.8.illinoisTerminationRight",
    why: "§3.8 timer table: balance ≤ 65% of original amount by timely payments, not in default, not gov-insured, HPML rules satisfied (765 ILCS 910/5)." });
  o("STATE_MN_47_20_DISCONTINUE_NOTICE_60", { trigger: "`loan.anniversary{n=5, of=mortgage_date}`", why: "§3.8 timer table: 5th anniversary of the mortgage date + 60 calendar days (Minn. Stat. 47.20 subd. 9)." });
  // ---- 3.9 escrow interest -------------------------------------------------
  o("IRS_1099INT_EFILE_0331", { trigger: "`tax_year.closed`", offset: "Mar 31", why: "§3.9 timer table: tax year end → e-file by Mar 31 (10+ returns mandate)." });
  o("IRS_1099INT_FURNISH_0131", { trigger: "`tax_year.closed`", offset: "Jan 31 (rolled to the next federal business day)", why: "§3.9 timer table: tax year end → furnish by Jan 31 (next business day if weekend/holiday per IRS rules)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("FNMA_LL2026_05_ESCROW_EVENT_0300ET", { trigger: "`ledger.entries.posted{account=escrow}`", why: "§3.7 timer table: `ledger_entries` posted to `escrow` (processed date D) → event next `fannie_et` BD 03:00 ET (LL-2026-05)." });
  o("ESC_WAIVER_DECISION_SLA_10BD", { trigger: "`escrow.waiver.requested`", why: "§3.8 timer table: `escrow_waiver` case opened → decision within 10 `business_days_servicer`." });
  o("STATE_IOE_ACCRUAL_DAILY", { trigger: "`schedule.tick{cadence=daily}`", offset: "daily", why: "§3.9 timer table: interest-on-escrow accrual each calendar day while eligible." });
}
