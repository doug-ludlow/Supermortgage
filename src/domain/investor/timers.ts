/**
 * Registry overrides for Section 5 (investor reporting) timers whose spec
 * rows are prose. Fannie Mae's calendar drives most of these: `period.opened`
 * / `period.closed` are the reporting-period events, `period.month_end` the
 * calendar month end, and `CDn`/`BDn` resolve against the anchor month.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyInvestorTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 5.1 LAR / events ----------------------------------------------------
  o("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000", { offset: "next business_days_fannie_et at 20:00 ET", why: "§5.1 timer table: next business day 20:00 America/New_York (`business_days_fannie_et`, 1) after `processed_at` (C-4.3-01)." });
  o("FNMA_IRM_BULK_CUTOFF_BD2_1500", { trigger: "`period.closing`", offset: "BD2 15:00 ET", why: "§5.1 timer table: period close job — bulk cutoff BD2 15:00 ET (Investor Reporting Manual)." });
  o("FNMA_IRM_LAR89_PERIOD_END", { trigger: "`mi.cancelled`", anchorField: "period_end_date", offset: "BD2 17:00 ET", why: "§5.1 timer table: `mi.cancelled`/`mi.terminated` → LAR 89 by last reporting day of that period (BD2 17:00 ET next month); `mi.terminated` arms the same code." });
  o("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000", { trigger: "`investor_event_exceptions.detected{family=nonremoval}`", anchorField: "period_end", offset: "BD1 20:00 ET",
    why: "§5.1 timer table: exception on non-removal event → correction by BD1 20:00 ET following month." });
  o("FNMA_LL202605_ESCROW_ATTEST_BD2", { trigger: "`period.closed{escrow_events=true}`", anchorField: "attestation_window_close_on", offset: "0, 17:00 ET",
    why: "§5.1 timer table: period (escrow) — BD3 opens; due BD2 of following month 17:00 ET (LL-2026-05)." });
  // ---- 5.2 remittances -----------------------------------------------------
  o("FNMA_CRS_INSTRUCTION_T1_2000", { trigger: "`crs.instruction.needed`", anchorField: "effective_date", offset: "−1 business_days_fannie_et, 20:00 ET", why: "§5.2 timer table: new/changed bank instruction → CRS instruction −1 BD 20:00 ET before effective date." });
  o("FNMA_CRS_REQUEST_1600", { anchorField: "settlement_date", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: `crs_batches.prepared` → CRS upload by settlement date −1 BD 16:00 ET." });
  o("FNMA_F120_AA_BD1_PRIOR_MONTH", { trigger: "`period.month_end{aa_collections_unremitted=true}`", offset: "BD1 16:00 ET of the following month", why: "§5.2 timer table: A/A collection on last work day not remitted → instruct by BD1 16:00 ET (F-1-20)." });
  o("FNMA_F120_AA_DETAILED_48H", { trigger: "`investor_events.accepted{reporting=detailed, remittance_type=aa}`", anchorField: "accepted_at", why: "§5.2 timer table: detailed-reporting LAR accepted → draft observed within 48 hours (F-1-20)." });
  o("FNMA_F120_AA_MONTHLY_MIN", { trigger: "`period.opened{remittance_type=aa}`", offset: "last business day of month, 16:00 ET (fannie_et)", why: "§5.2 timer table: period open (A/A < $2,500) → instruct by last BD of month 16:00 ET." });
  o("FNMA_F120_AA_REMIT_2500_SAMEDAY", { trigger: "`custodial.aa_sweep{net_collections_cents>250000}`", offset: "same day, 16:00 ET", why: "§5.2 timer table: A/A collections net of servicing fees > $2,500 at the 15:00 ET sweep → same-day CRS request by 16:00 ET (settles next BD)." });
  o("FNMA_F120_DRAFT_NOTICE_BD3", { trigger: "`period.closed`", offset: "BD3 12:00 ET", why: "§5.2 timer table: period close → draft notifications received & reconciled by BD3 12:00 ET." });
  o("FNMA_F120_MBSX_UNSCHED_BD4", { trigger: "`payment.received{unscheduled_principal=true, remittance_type=mbs_express}`", anchorField: "following_month_start", offset: "BD4", why: "§5.2 timer table: unscheduled principal collected (MBS Express) → funded BD4 of the month after collection." });
  o("FNMA_F120_PAYOFF_AA_IMMEDIATE", { trigger: "`payoff.funds.cleared{remittance_type=aa, amount_cents>250000}`", offset: "next business_days_fannie_et at 16:00 ET", why: "§5.2 timer table: A/A payoff funds > $2,500 → same/next BD CRS request (code 001)." });
  o("FNMA_F120_RPM_DRAFT_DESIGNATED", { trigger: "`period.opened{remittance_type=rpm}`", anchorField: "designated_draft_date", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: period open (RPM pools) → funding check −1 BD 16:00 before the designated date (preceding BD)." });
  o("FNMA_F120_SA_DRAFT_CD20", { trigger: "`period.opened{remittance_type=sa}`", offset: "CD20 (preceding fannie_et BD), 16:00 ET", why: "§5.2 timer table: period open (S/A) → draft CD20 (preceding BD); funding check −1 BD 16:00 ET." });
  o("FNMA_F120_SETTLEMENT_NEXT_REMIT_DATE", { anchorField: "next_remittance_date", offset: "0", why: "§5.2 timer table: `settlement.received` → instructed by next month's remittance date (computed anchor)." });
  o("FNMA_F120_SS_6TH_POOL_CD5", { trigger: "`period.opened{remittance_type=ss, pool_draft_day=6}`", offset: "CD5 (preceding fannie_et BD)", why: "§5.2 timer table: period open (6th-day pools) → funded by CD5." });
  o("FNMA_F120_SS_DRAFT_CD18", { trigger: "`period.opened{remittance_type=ss}`", offset: "CD18 (preceding fannie_et BD), 00:00 ET", why: "§5.2 timer table: period open (S/S standard/portfolio) → draft CD18 (preceding `fannie_et` BD) 00:00 ET; funding check −1 BD 16:00 ET." });
  o("FNMA_IRM_SHORTAGE_IMMEDIATE", { trigger: "`fnma.shortage_surplus.shortage_confirmed{reconciled=false}`", why: "§5.2 timer table: unreconciled shortage detected → CRS remittance instructed within 1 BD." });
  o("FNMA_IRM_SURPLUS_RESOLVE_90", { trigger: "`fnma.shortage_surplus.surplus_identified`", why: "§5.2 timer table: surplus first appears → explained/reconciled within 90 calendar days." });
  o("FNMA_LL202605_AA_AUTODRAFT_2BD", { trigger: "`investor_events.accepted{remittance_type=aa, phase=autodraft}`", offset: "+2 business_days_fannie_et", why: "§5.2 timer table: payment event accepted (auto-draft phase) → funded 2 BD; funding check +1 BD 16:00 ET (LL-2026-05)." });
  o("FNMA_LL202605_PREDRAFT_REVIEW_1BD", { trigger: "`fnma.draft_notification.received{kind=predraft}`", offset: "same day, 15:00 ET", why: "§5.2 timer table: pre-draft notification received → reviewed/variance filed same BD 15:00 ET." });
  o("SM_CUSTODIAL_FUNDING_T1_1600", { trigger: "`remittance.draft.scheduled`", anchorField: "draft_date", offset: "−1 business_days_fannie_et, 16:00 ET", why: "§5.2 timer table: any draft date → custodial balance ≥ expected drafts by −1 BD 16:00 ET." });
  // ---- 5.3 liquidations ----------------------------------------------------
  o("FNMA_E4101_REOGRAM_CONFIRM_1BD", { trigger: "`reogram.created`", why: "§5.3 timer table: REOgram case created (P360 notice / AC 70-72 acceptance / DRA sale event) → confirm within 1 `business_days_fannie_et` (E-4.1-01)." });
  o("FNMA_IRM_LIQ_AC70_72_NEXTBD_2000", { trigger: "`liquidation_facts.processed`", offset: "next business_days_fannie_et at 20:00 ET", why: "§5.3 timer table: liquidation fact processed → LAR 70/72 next BD 20:00 ET (17:00 if BD2)." });
  o("FNMA_LL202605_FORECLOSURE_EVENT_NEXTBD", { trigger: "`liquidation_facts.processed`", offset: "next business_days_fannie_et at 03:00 ET", why: "§5.3 timer table: foreclosure/liquidation event processed → P360 event next BD (03:00 ET event standard)." });
  o("FNMA_P360_REOGRAM_EXCEPTION_3BD", { trigger: "`reogram.exception.raised`", why: "§5.3 timer table: REOgram exception raised → resolved within 3 BD." });
  o("SM_LIQ_CODE_CHANGE_CPM_2BD", { trigger: "`liquidation.code_change.needed`", why: "§5.3 timer table: code change needed after close → CPM notification within 2 BD." });
  // ---- 5.4 delinquency advances / SDA --------------------------------------
  o("FNMA_A1306_RECLASS_SELECTION_6M", { trigger: "`period.closed{regular_servicing_option=true, consecutive_months_delinquent>=6}`", why: "§5.4 timer table: regular servicing option loan six consecutive months delinquent at period end → reclass purchase advice expected (A1-3-06)." });
  o("FNMA_C301_SDA_PREDICT_EOM", { trigger: "`period.month_end`", offset: "last day of month, 23:59 ET", why: "§5.4 timer table: period end → `sda_status.predicted` set/cleared by last calendar day 23:59 ET (C-3-01)." });
  o("FNMA_F120_SDA_EXIT_RESUME_DRAFT", { trigger: "`loan.became_current{sda_active=true}`", offset: "18th of the following month (preceding fannie_et BD)", why: "§5.4 timer table: loan becomes current → scheduled P&I funded at next draft date (CD18)." });
  o("FNMA_F120_SDA_STATUS_RECONCILE_BD3", { trigger: "`fnma.connect.report.available{report=sda_status}`", offset: "BD3 12:00 ET", why: "§5.4 timer table: BD3 report available → every predicted/active loan reconciled by BD3 12:00 ET." });
  o("FNMA_F125_RECLASS_DESELECT_CD15", { trigger: "`fnma.connect.report.available{report=eligible_for_deselection}`", offset: "CD15", why: "§5.4 timer table: Eligible for Deselection report (~CD11) → deselection decision by CD15 (F-1-25)." });
  o("FNMA_IRM_SDA_CONTRACTUAL_LAR_NEXTBD_2000", { trigger: "`payment.applied{sda_active=true, contractual=true}`", offset: "next business_days_fannie_et at 20:00 ET", why: "§5.4 timer table: full contractual payment applied on an SDA loan → LAR next BD 20:00 ET (5.1 clock)." });
  o("SM_SDA_RECOVERY_MATCH_2_CYCLES", { trigger: "`investor_events.accepted{sda_active=true, contractual=true}`", offset: "18th of the month after next (preceding fannie_et BD)", why: "§5.4 timer table: contractual payment reported on SDA loan → recovery adjustment matched within 2 draft cycles (CD18 drafts)." });
  o("SM_SDA_REIMBURSEMENT_MATCH_2_CYCLES", { trigger: "`sda_status.exited`", offset: "18th of the month after next (preceding fannie_et BD)", why: "§5.4 timer table: exit by reclass/deferral/liquidation → `advances.status = reimbursed_by_fnma` within 2 draft cycles." });
  // ---- 5.5 guaranty fees ---------------------------------------------------
  o("FNMA_F120_GFEE_BILL_RETRIEVE_CD5", { trigger: "`period.opened`", offset: "CD5 12:00 ET", why: "§5.5 timer table: period open → g-fee bill parsed by CD5 12:00 ET." });
  o("FNMA_F120_GFEE_DRAFT_CD7", { trigger: "`period.opened`", offset: "CD7 (preceding fannie_et BD), 16:00 ET", why: "§5.5 timer table: period open → g-fee draft CD7 (preceding `fannie_et` BD); funding check −1 BD 16:00 ET." });
  o("FNMA_F120_GFEE_RELIEF_RECONCILE_BILL", { trigger: "`gfee.bill.parsed`", offset: "same day", why: "§5.5 timer table: bill parsed → every predicted/active relief loan reconciled the same BD." });
  o("FNMA_F120_GFEE_RESUME_ON_CURRENT", { trigger: "`loan.became_current{gfee_relief_active=true}`", offset: "7th of the following month (preceding fannie_et BD)", why: "§5.5 timer table: loan becomes current → g-fee funded at next CD7." });
  o("SM_GFEE_RECOVERY_MATCH_2_CYCLES", { trigger: "`investor_events.accepted{gfee_relief_active=true, contractual=true}`", offset: "7th of the month after next (preceding fannie_et BD)", why: "§5.5 timer table: contractual payment on a relief loan → recovery/retention matched within 2 bill cycles (CD7)." });
  // ---- 5.6 repurchases -----------------------------------------------------
  o("FNMA_A1302_APPEAL1_60", { trigger: "`repurchase.demand.received`", why: "§5.6 timer table: demand received → first appeal filed or decision not to appeal within 60 calendar days (A1-3-02)." });
  o("FNMA_A1302_APPEAL2_15", { trigger: "`repurchase.appeal.denied{stage=1}`", why: "§5.6 timer table: first-appeal denial → second appeal within 15 calendar days (A1-3-02)." });
  o("FNMA_A1302_DOCS_30", { trigger: "`repurchase.file_review.selected`", why: "§5.6 timer table: file selected for review → documents within 30 calendar days (A1-3-02)." });
  o("FNMA_A1302_IMPASSE_30", { trigger: "`repurchase.stage.entered`", anchorField: "stage_deadline_on", offset: "0", why: "§5.6 timer table: stage entered → 30/30/15/15 calendar days by stage; the stage's own deadline is the computed anchor (`5.6.stageDeadline`)." });
  o("FNMA_A1302_REPURCHASE_PAY_60", { trigger: "`repurchase.demand.received`", why: "§5.6 timer table: demand received → funded within 60 calendar days (active loans: next scheduled remittance after day 60)." });
  o("FNMA_F120_REPURCHASE_PROCEEDS_BY_TYPE", { trigger: "`investor_events.accepted{event=repurchase}`", anchorField: "remittance_due_on", offset: "0", why: "§5.6 timer table: proceeds due by remittance type — S/S CD18 / MBS Express BD4 / S/A CD20 / A/A immediate (CRS 001 by 16:00 ET); computed by `5.6.proceedsDue`." });
  o("FNMA_IRM_REPURCHASE_AC65_NEXTBD_2000", { trigger: "`repurchase.processed`", offset: "next business_days_fannie_et at 20:00 ET", why: "§5.6 timer table: repurchase processed → LAR 65/67 next `fannie_et` BD 20:00 ET (17:00 if BD2)." });
  o("SM_REPURCHASE_OWNERSHIP_UPDATE_10BD", { trigger: "`repurchase.proceeds.matched`", why: "§5.6 timer table: proceeds matched → MERS TOB/TOS + custodian release + `investor` field updated within 10 BD." });
  // ---- 5.7 delinquency reporting -------------------------------------------
  o("FNMA_F121_AW_ONE_MONTH", { trigger: "`delinquency_reports.submitted{action_code=AW}`", offset: "+1 months", why: "§5.7 timer table: AW reported → not repeated in the next period (F-1-21)." });
  o("FNMA_F121_DQ_CORRECT_CD10", { trigger: "`delinquency_reports.exception_parsed`", offset: "CD10 17:00 ET", why: "§5.7 timer table: exception report parsed → corrections transmitted and accepted by CD10 17:00 ET." });
  o("FNMA_F121_DQ_REPORT_BD2", { trigger: "`period.month_end`", offset: "BD2 17:00 ET of the following month", why: "§5.7 timer table: period end → delinquency report by BD2 17:00 ET (`fannie_et`) (F-1-21)." });
  o("FNMA_F121_DQ_SNAPSHOT_EOM", { trigger: "`period.month_end`", offset: "last day of month, 23:59 ET", why: "§5.7 timer table: month end → snapshot built as of last calendar day 23:59 ET." });
  o("FNMA_LL202605_DQ_EVENT_NEXTBD_0300", { trigger: "`delinquency.action.processed`", offset: "next business_days_fannie_et at 03:00 ET", why: "§5.7 timer table: delinquency action processed → event submitted next BD 03:00 ET (LL-2026-05)." });
  o("FNMA_LL202605_DQ_PMT_REMINDER_CD23", { trigger: "`period.month_end{periods_delinquent=1}`", offset: "CD23 of the following month", why: "§5.7 timer table: 1 period delinquent → Payment Reminder Notice event accepted by CD23." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("FNMA_IRM_PERIOD_CLOSE_BD2_1700", { trigger: "`period.month_end`", offset: "BD2 17:00 ET", why: "§5.1 timer table: period → close BD2 17:00 ET (Investor Reporting Manual)." });
  o("FNMA_LL202605_PERIOD_CLOSE_BD2_1700", { trigger: "`period.month_end`", offset: "BD2 17:00 ET", why: "§5.1 timer table: period → close BD2 17:00 ET (LL-2026-05)." });
  o("FNMA_LL202605_NOPAYMENT_CD22", { trigger: "`period.opened`", offset: "CD22 (preceding fannie_et BD), 23:59 ET", why: "§5.1 timer table: period → no-payment events by CD22 (preceding BD) 23:59 ET (LL-2026-05)." });
  o("FNMA_A14201_COMPFEE_WATCH", { trigger: "`period.month_end`", offset: "monthly", why: "§5.1 timer table: monthly compensatory-fee watch (A1-4.2-01)." });
  o("SM_DRA_RECONCILE_7CD", { trigger: "`schedule.tick{cadence=weekly, weekday=monday, at=09:00}`", why: "§5.3 timer table: weekly, Monday 09:00 ET DRA reconciliation." });
  o("FNMA_F121_DQ_EXCEPTIONS_BD4", { trigger: "`period.month_end`", offset: "BD4 12:00 ET", why: "§5.7 timer table: BD4 12:00 ET delinquency exceptions (F-1-21)." });
  o("FNMA_F121_DQ_FINAL_CD11", { trigger: "`period.month_end`", offset: "CD11 of the following month, 12:00 ET", why: "§5.7 timer table: CD11 12:00 ET final delinquency report (F-1-21)." });
  o("FNMA_D2401_DQ_MGMT_ACTION_GATE", { trigger: "`delinquency_reports.snapshot_built`", evaluator: "5.7.managementActionRecorded", why: "§5.7 timer table: snapshot → management action recorded for each delinquency (D2-4-01)." });
  o("SM_DQ_SMDU_DRA_CONSISTENCY_BD1", { trigger: "`period.month_end`", offset: "BD1 12:00 ET", why: "§5.7 timer table: BD1 12:00 ET SMDU/DRA consistency check." });
}
