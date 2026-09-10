/**
 * Registry overrides for Section 14 (bankruptcy) timers whose spec rows are
 * prose.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyBankruptcyTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 14.1 case management -----------------------------------------------
  o("FNMA_E2_2_04_CH13_COMPLETION_5M2W", { trigger: "`bankruptcy.referral.sent{chapter∈{12, 13}}`", anchorField: "petition_date", why: "§14.1 timer table: ch. 12/13 — plan confirmed / stay terminated / dismissed / closed within 5 months + 14 calendar days of petition (E-2.2-04)." });
  o("FNMA_E5_01_BK_EXPENSE_CLAIM_60", { trigger: "`claim.milestone.reached{kind∈{relief_granted, dismissal, discharge_abandonment, reinstatement, payoff, workout}}`", why: "§14.1 timer table: case completion milestone → P360 claim within 60 calendar days (E-5-01)." });
  o("FRBP_4001D_AGREED_ORDER_OBJ_14", { trigger: "`bankruptcy.agreed_order.noticed`", anchorField: "mailed_at", why: "§14.1 timer table: agreed order noticed → objection window 14 calendar days (+3 if mailed under 9006(f)) (FRBP 4001(d))." });
  o("SM_BK_DOCKET_SYNC_1BD", { trigger: "`bankruptcy.case.opened`", why: "§14.1 timer table: open case → docket lookup every 1 `business_days_servicer`." });
  o("USC_1301D_CODEBTOR_RELIEF_20", { trigger: "`bankruptcy.codebtor_relief.requested`", anchorField: "filed_at", why: "§14.1 timer table: counsel files §1301(c)(2) request → objection docketed or auto-termination within 20 calendar days (11 U.S.C. §1301(d))." });
  // ---- 14.2 Rule 3002.1 ----------------------------------------------------
  o("FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45", { trigger: "`bankruptcy.form_410c13nr.served`", anchorField: "served_at", why: "§14.2 timer table: Form 410C13-NR served → debtor motion window 45 calendar days (FRBP 3002.1(g)(4))." });
  o("SM_BK_3002_1C_BATCH_90", { trigger: "`fee.incurred_postpetition{first_unnoticed=true}`", anchorField: "incurred_on", why: "§14.2 timer table: first un-noticed fee item → 410S-2 within 90 calendar days of the oldest item (or immediately when aggregate ≥ $200, `bankruptcy.fee_batch.threshold_reached`)." });
  // ---- 14.3 communications -------------------------------------------------
  o("REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE", { anchorField: "discharge_notice_due", offset: "0", why: "§14.3 timer table: first `payment.received` after discharge (no reaffirmation) on a delinquent loan → per 11.2 (45 days of delinquency measured from the next due date) — computed by `11.2.fdcpaNoticeDue`." });
  o("REGZ_1026_41E5II_RESUME_NEXT_CYCLE", { anchorField: "next_statement_cycle_on", offset: "0", why: "§14.3 timer table: resume request / reaffirmation → statement in the next cycle (single-statement exemption available) (§1026.41(e)(5)(ii))." });
  o("SM_BK_COUNSEL_ROUTE_CONFIRM_5BD", { trigger: "`bankruptcy.docket.event.received{kind=attorney_appearance}`", why: "§14.3 timer table: debtor's attorney appears on the docket → `addressing` decided within 5 `business_days_servicer`." });
  // ---- 14.4 credit reporting -----------------------------------------------
  o("SM_BK_CR_DISCHARGE_FINAL_RECORD", { offset: "first day of next month, 00:05 ET", why: "§14.4 timer table: discharge with `debt_discharged=true` → CII E/H record with zero balances and Date Closed in the next snapshot; then `final_reported`." });
  o("SM_BK_CR_DISMISSAL_RELEASE_NEXT_CYCLE", { trigger: "`bankruptcy.status.changed{to∈{dismissed, withdrawn}}`", offset: "first day of next month, 00:05 ET", why: "§14.4 timer table: `bankruptcy.case.dismissed/withdrawn` → CII I–P for one cycle then Q; freeze released at the next snapshot." });
  o("SM_BK_CR_STATE_SYNC_1BD", { trigger: "`bankruptcy.status.changed`", why: "§14.4 timer table: any 14.1 phase event → `bankruptcy_reporting_state` row within 1 `business_days_servicer`." });
  o("SM_CR_SUPPRESSION_REVIEW_30", { trigger: "`credit.suppression.created`", anchorField: "created_at", why: "§14.4 timer table: suppression created → review every 30 calendar days with docket check." });
  // ---- pseudo-trigger rows (docket events) --------------------------------------
  o("FNMA_E2_1_06_ADEQUATE_PROTECTION_45", { trigger: "`bankruptcy.docket.event.received{kind=meeting_341_held, conduit_district=true, plan_confirmed=false}`", anchorField: "meeting_341_at", why: "§14.1 timer table: `meeting_341_held` in a conduit district with no confirmation → adequate protection motion within 45 calendar days (E-2.1-06)." });
  o("USC_521A2_SOI_PERFORM_30", { trigger: "`bankruptcy.docket.event.received{kind=meeting_341_scheduled, chapter=7}`", anchorField: "meeting_341_first_set_at", why: "§14.1 timer table: docket `meeting_341_scheduled` (ch. 7) → statement of intention performed within 30 calendar days of first date set (11 U.S.C. §521(a)(2))." });
  o("USC_362E1_MFR_PRELIM_30", { trigger: "`bankruptcy.docket.event.received{kind=mfr_filed}`", anchorField: "filed_at", why: "§14.1 timer table: docket `mfr_filed` → preliminary hearing within 30 calendar days (11 U.S.C. §362(e)(1))." });
  o("USC_362E2_MFR_FINAL_60", { trigger: "`bankruptcy.docket.event.received{kind=mfr_filed, individual=true}`", anchorField: "filed_at", why: "§14.1 timer table: docket `mfr_filed` (individual ch. 7/11/13) → final decision within 60 calendar days (11 U.S.C. §362(e)(2))." });
  o("FRBP_4001A3_ORDER_STAY_14", { trigger: "`bankruptcy.docket.event.received{kind=relief_order_entered}`", anchorField: "entered_at", why: "§14.1 timer table: `relief_order_entered` → 14-day stay of order (9006 forward) unless waived (FRBP 4001(a)(3))." });
  o("SM_BK_3002_1_TARGET_LEAD_35", { trigger: "`payment.change.scheduled{chapter=13, in_scope=true}`", anchorField: "effective_due_date", why: "§14.2 timer table: 'same' as BK_3002_1_PAYMENT_CHANGE_21 → `payment.change.scheduled` on an in-scope Ch. 13 loan; target −35 calendar days." });
  o("FRBP_3002_1B4_OBJECTION_WINDOW", { trigger: "`bankruptcy.form_410s1.filed_served`", anchorField: "effective_due_date", offset: "−1 calendar_days", why: "§14.2 timer table: `filed_served` → objection window through `effective_due_date` − 1 day (FRBP 3002.1(b)(4))." });
  o("FRBP_3002_1F_STATUS_RESPONSE_28", { trigger: "`bankruptcy.docket.event.received{kind=motion_410c13_m1}`", anchorField: "served_at", offset: "+28 calendar_days", why: "§14.2 timer table: docket `motion_410c13_m1` → response 28 calendar days (+3 if served by mail, `served_by_mail=true` variant), 9006 forward (FRBP 3002.1(f))." });
  o("FRBP_3002_1G3_FINAL_CURE_RESPONSE_28", { trigger: "`bankruptcy.docket.event.received{kind=trustee_notice_410c13_n}`", anchorField: "served_at", offset: "+28 calendar_days", why: "§14.2 timer table: docket `trustee_notice_410c13_n` → response 28 (+3 if mail) calendar days, 9006 forward (FRBP 3002.1(g)(3))." });
  o("FRBP_3002_1G4_MOTION_RESPONSE_28", { trigger: "`bankruptcy.docket.event.received{kind=motion_410c13_m2}`", anchorField: "served_at", offset: "+28 calendar_days", why: "§14.2 timer table: docket `motion_410c13_m2` → response 28 (+3) calendar days (FRBP 3002.1(g)(4))." });
  o("SM_BK_3002_1_RELIEF_CEASE_CHECK", { trigger: "`bankruptcy.docket.event.received{kind=relief_order_entered}`", evaluator: "14.2.rule3002_1NoticesCeaseAfterRelief", why: "§14.2 timer table: `relief_order_entered` → Rule 3002.1 notices cease check." });
  applyBankruptcySatisfiedOverrides(reg);
}

/** Satisfaction events / evaluators for the §14 rows whose "Satisfied by" column is prose or empty. */
export function applyBankruptcySatisfiedOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 14.1 monitoring and proof of claim
  o("FNMA_E2_1_03_SUSPEND_COLLECTION_0", { trigger: "`bankruptcy.notice.received`", offset: "0 calendar_days", satisfied: "`bankruptcy.gates.applied`", why: "§14.1 timer table: '`stay_gates` recomputed (event `bankruptcy.gates.applied`)' — collection stops on notification (E-2.1-03)." });
  o("FNMA_E2_1_05_NOA_FILED_10BD", { satisfied: "`bankruptcy.docket.event.received{kind=noa_filed}`", why: "§14.1 timer table: 'docket `noa_filed`' (E-2.1-05)." });
  o("USC_521A2_SOI_30", { trigger: "`bankruptcy.petition.filed{chapter=7}`", satisfied: "`bankruptcy.docket.event.received{kind=soi_filed}`", why: "§14.1 timer table: 'docket `soi_filed`' (11 U.S.C. 521(a)(2)(A))." });
  o("USC_521A2_SOI_PERFORM_30", { satisfied: "`bankruptcy.soi.performed{action∈{reaffirmation_filed, surrender_relief, ride_through}}`", why: "§14.1 timer table: 'reaffirmation filed / surrender relief / ride-through recorded' (11 U.S.C. 521(a)(2)(B))." });
  o("USC_362E1_MFR_PRELIM_30", { satisfied: "`bankruptcy.docket.event.received{kind∈{mfr_hearing_held, mfr_continued_order}}`", why: "§14.1 timer table: 'hearing held/continued order' (11 U.S.C. 362(e)(1))." });
  o("USC_362E2_MFR_FINAL_60", { satisfied: "`bankruptcy.docket.event.received{kind∈{relief_order_entered, mfr_extension_order}}`", why: "§14.1 timer table: '`relief_order_entered` or extension order' (11 U.S.C. 362(e)(2))." });
  o("FRBP_4001A3_ORDER_STAY_14", { satisfied: "`timer.lapsed{code=FRBP_4001A3_ORDER_STAY_14}`", why: "§14.1 timer table: 'expiry → `foreclosure_blocked=false`' — the 14-day stay of the relief order ends by lapse (Fed. R. Bankr. P. 4001(a)(3))." });
  o("FRBP_4001D_AGREED_ORDER_OBJ_14", { satisfied: "`bankruptcy.docket.event.received{kind=agreed_order_entered}`", why: "§14.1 timer table: 'order entered' (Fed. R. Bankr. P. 4001(d))." });
  o("USC_1301D_CODEBTOR_RELIEF_20", { trigger: "`bankruptcy.codebtor_relief.requested`", satisfied: "`bankruptcy.codebtor_relief.resolved{result∈{objection_docketed, auto_terminated}}`", why: "§14.1 timer table: 'objection docketed or auto-termination recorded' (11 U.S.C. 1301(d))." });
  o("USC_524C4_REAFFIRM_RESCISSION", { trigger: "`bankruptcy.reaffirmation.filed`", anchorField: "reaffirmation_final_on", offset: "0 calendar_days", satisfied: "`bankruptcy.reaffirmation.final`", why: "§14.1 timer table: 'expiry → reaffirmation final' — the later of 60 days after filing or discharge, computed by `14.4.reaffirmationFinal` (11 U.S.C. 524(c)(4))." });
  o("FNMA_E2_2_01_CH7_COMPLETION_2M2W", { trigger: "`bankruptcy.petition.filed{chapter=7, referral=full}`", offset: "75 calendar_days", satisfied: "`bankruptcy.case.status_changed{status∈{relief_granted, dismissed, discharged, closed}}`", why: "§14.1 timer table: 'case completion event' at 2 months + 2 weeks (E-2.2-01)." });
  o("FNMA_E2_2_04_CH13_COMPLETION_5M2W", { satisfied: "`bankruptcy.case.status_changed{status∈{plan_confirmed, relief_granted, dismissed, closed}}`", why: "§14.1 timer table: 'plan confirmed / stay terminated / dismissed / closed' (E-2.2-04)." });
  o("FNMA_E2_2_04_POSTCONF_COMPLETION_2M2W", { offset: "75 calendar_days", satisfied: "`bankruptcy.case.status_changed{status∈{relief_granted, dismissed}}`", why: "§14.1 timer table: 'relief/dismissal' at 2 months + 14 days after post-confirmation 60-day delinquency (E-2.2-04)." });
  o("FNMA_E2_3_06_POST_SALE_NOTIFY_2BD", { satisfied: "`fnma.notified{kind=bankruptcy_notification_template}`", why: "§14.1 timer table: 'Bankruptcy Notification Template sent (evidence)' (E-2.3-06)." });
  o("SM_BK_DOCKET_SYNC_1BD", { satisfied: "`bankruptcy.docket.sync.completed`", why: "§14.1 timer table: 'docket lookup completed' daily for open cases." });
  o("SM_BK_ORPHAN_TRUSTEE_PAYMENT_2BD", { satisfied: "`bankruptcy.orphan_payment.resolved{result∈{case_opened, resolved}}`", why: "§14.1 timer table: 'case opened or payment resolved' for a trustee payment with no open case." });
  // ---- 14.2 Rule 3002.1
  o("SM_BK_3002_1_TARGET_LEAD_35", { satisfied: "`bankruptcy.filing.package_handed{filing_type=s1_payment_change}`", why: "§14.2 timer table: 'filing package handed to counsel' at effective due − 35." });
  o("SM_BK_PAYMENT_CHANGE_DETECT_1BD", { satisfied: "`bankruptcy.payment_change_notice.created`", why: "§14.2 timer table: 'notice row created' within 1 BD of `payment.change.scheduled`." });
  o("FRBP_3002_1B4_OBJECTION_WINDOW", { evaluator: "14.2.noB4MotionBeforeDueDate", why: "§14.2 timer table: no (b)(4) motion by the day before the due date → the notice is `effective`; a motion holds the old amount until the court's order (Fed. R. Bankr. P. 3002.1(b)(4))." });
  o("SM_BK_3002_1C_BATCH_90", { satisfied: "`bankruptcy.filing.filed{filing_type=s2_fee_notice}`", why: "§14.2 timer table: '410S-2 filed' — batch at ≥$200 aggregate or day 90 (Fed. R. Bankr. P. 3002.1(c))." });
  o("FRBP_3002_1E_FEE_CHALLENGE_365", { satisfied: "`bankruptcy.fee_notice.resolved{result∈{allowed_by_lapse, challenged}}`", why: "§14.2 timer table: 'lapse → allowed_by_lapse; motion → challenged' (Fed. R. Bankr. P. 3002.1(e))." });
  o("FRBP_3002_1F_STATUS_RESPONSE_28", { satisfied: "`bankruptcy.filing.filed_served{filing_type=m1r_status_response}`", why: "§14.2 timer table: 'Form 410C13-M1R filed + served' (Fed. R. Bankr. P. 3002.1(f))." });
  o("FRBP_3002_1G3_FINAL_CURE_RESPONSE_28", { satisfied: "`bankruptcy.filing.filed_served{filing_type=nr_final_cure_response}`", why: "§14.2 timer table: 'Form 410C13-NR filed as a POC supplement + served' (Fed. R. Bankr. P. 3002.1(g)(3))." });
  o("FRBP_3002_1G4_MOTION_RESPONSE_28", { satisfied: "`bankruptcy.filing.filed_served{filing_type=m2r_motion_response}`", why: "§14.2 timer table: 'Form 410C13-M2R filed + served' (Fed. R. Bankr. P. 3002.1(g)(4))." });
  o("SM_BK_3002_1G1_TRUSTEE_NOTICE_WATCH_45", { satisfied: "`bankruptcy.docket.event.received{kind=trustee_notice_410c13_n}`", why: "§14.2 timer table: '`trustee_notice_410c13_n` docketed' within 45 days of plan completion (Fed. R. Bankr. P. 3002.1(g)(1))." });
  o("FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45", { satisfied: "`timer.lapsed{code=FRBP_3002_1G4_DEBTOR_MOTION_WINDOW_45}`", why: "§14.2 timer table: 'lapse → case closes on the response's facts' (Fed. R. Bankr. P. 3002.1(g)(4))." });
  // ---- 14.3 statements and early intervention in bankruptcy
  o("REGZ_1026_41E5_CEASE_EFFECTIVE_0", { satisfied: "`bankruptcy.statement_mode.set{mode=exempt_cease_request}`", why: "§14.3 timer table: '`mode=exempt_cease_request` recorded same day' (comment 41(e)(5)-3)." });
  o("REGZ_1026_41E5II_RESUME_NEXT_CYCLE", { satisfied: "`notice.sent{code∈{NTC_REGZ_41_STMT_BK7_11, NTC_REGZ_41_STMT_BK12_13, NTC_REGZ_41_STMT}}`", why: "§14.3 timer table: 'statement sent' at the next cycle (§1026.41(e)(5)(ii))." });
  o("REGX_1024_39C1_BK_WRITTEN_NOTICE_45", { satisfied: "`notice.sent{code=NTC_REGX_39B_EARLY_INTERVENTION_BK}`", why: "§14.3 timer table: '`NTC_REGX_39B_EARLY_INTERVENTION_BK` sent (borrower or counsel)' (§1024.39(c)(1)(ii))." });
  o("REGX_1024_39B_BK_LATER_DELINQUENCY_45", { trigger: "`delinquency.day45.reached{during_bankruptcy=true}`", offset: "0 calendar_days", satisfied: "`notice.sent{code=NTC_REGX_39B_EARLY_INTERVENTION_BK}`", why: "§14.3 timer table: 'notice sent (once per case)' (comment 39(c)(1)-1)." });
  o("REGX_1024_39C2_RESUME_GATE", { satisfied: "`loan.delinquency.window_opened{after_bk_resume=true}`", why: "§14.3 timer table: '11.1/11.2 clocks re-armed from that due date' (§1024.39(c)(2))." });
  o("REGX_1024_39C2_DISCHARGE_WRITTEN_NOTICE", { satisfied: "`notice.sent{code=NTC_REGX_39B_EARLY_INTERVENTION_BK, payment_request=false}`", why: "§14.3 timer table: 'written notice (no payment request)' after the first post-discharge payment (§1024.39(c)(2)(ii))." });
  o("SM_BK_STATEMENT_MODE_SYNC_1BD", { satisfied: "`bankruptcy.statement_mode.set`", why: "§14.3 timer table: '`bk_statement_status` updated' within 1 BD of a status change." });
  o("SM_BK_COUNSEL_ROUTE_CONFIRM_5BD", { satisfied: "`bankruptcy.addressing.decided`", why: "§14.3 timer table: '`addressing` decided with basis' within 5 BD of counsel's appearance." });
  // ---- 14.4 credit reporting feed
  o("SM_BK_CR_STATE_SYNC_1BD", { satisfied: "`bankruptcy.reporting_state.changed`", why: "§14.4 timer table: '`bankruptcy_reporting_state` row written' within 1 BD of a phase event." });
  o("SM_BK_CR_DISMISSAL_RELEASE_NEXT_CYCLE", { satisfied: "`metro2.snapshot.taken{cii∈{I, J, K, L, M, N, O, P}}`", why: "§14.4 timer table: 'CII I–P for one cycle then Q; freeze released' at the next snapshot." });
  o("SM_BK_CR_DISCHARGE_FINAL_RECORD", { satisfied: "`metro2.snapshot.taken{cii∈{E, F, G, H}, final=true}`", why: "§14.4 timer table: 'CII E/H record with zero balances and Date Closed; then `final_reported`'." });
  o("SM_BK_CR_REAFFIRM_HOLD", { evaluator: "14.4.reaffirmationFinal", why: "§14.4 timer table: hold until the §524(c)(4) rescission window lapses → `reaffirmation_final=true` → CII R." });
}
