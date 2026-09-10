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
}
