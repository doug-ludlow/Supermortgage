/**
 * Registry overrides for Section 10 (mortgage insurance) timers whose spec
 * rows are prose.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyPmiTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("NY_INS_6503D_STOP_PREMIUM_75", { trigger: "`mi.ltv_snapshot{state=NY, ltv_bps<=7500}`", anchorField: "snapshot_date", why: "§10.2 timer table: nightly LTV snapshot with actual UPB ≤ 75% × original appraised value → stop premium (NY Ins. Law §6503(d))." });
  o("SM_MI_MIDPOINT_PREVIEW_90", { trigger: "`mi.schedule.updated`", anchorField: "midpoint_termination_date", offset: "−90 calendar_days", why: "§10.3 timer table: preview 90 days before `midpoint_termination_date` (data completeness check)." });
  o("MN_47_207_ANNUAL_NOTICE_12M", { trigger: "`mi_policy.activated{state=MN}`", why: "§10.4 timer table: 'same as HPA timer' — MN-variant annual notice every 12 months (Minn. Stat. 47.207)." });
  o("SM_MI_DISCLOSURE_COMPOSE_LEAD_30", { trigger: "`mi.disclosure.due_approaching{elapsed_pct>=70}`", anchorField: "disclosure_due_on", offset: "−30 calendar_days", why: "§10.4 timer table: recurring timer at 70% elapsed → compose 30 calendar days before due." });
  o("LL_2026_05_ESCROW_EVENT_3AM", { trigger: "`mi.refund.posted`", offset: "next business_days_fannie_et at 03:00 ET", why: "§10.5 timer table: refund deposit/disbursement posted → escrow event acked next `business_days_fannie_et` 03:00 ET (LL-2026-05)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("HPA_4905C2_LPMI_OPTIONS_NOTICE_30", { trigger: "`mi.lpmi_equivalent_termination_date.reached`", why: "§10.2 timer table: `lpmi_equiv_termination_date` reached → options notice within 30 calendar days (12 U.S.C. §4905(c)(2))." });
  applyPmiSatisfiedOverrides(reg);
}

/** Satisfaction events for the §10 rows whose "Satisfied by" column is prose. */
export function applyPmiSatisfiedOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_F102_VALUATION_FEE_GATE", { satisfied: "`mi.evidence.received{kind=fee}`", why: "§10.1 timer table: the gate holds `smdu.valuation.order` until the borrower-paid fee is posted (F-1-02); the fee receipt opens it." });
  o("MN_47_207_RESPONSE_30", { satisfied: "`notice.sent{code∈{NTC_HPA_4904A_CANCELLED, NTC_MI_INFO_REQUEST, NTC_HPA_4904B_DENIAL}}`", why: "§10.1/10.6 timer tables: 'approve / request-info / deny notice sent' within 30 days of receipt (Minn. Stat. §47.207 subd. 4)." });
  o("SM_MI_INSURER_CANCEL_TARGET_2BD", { satisfied: "`integration_messages.acked{kind=insurer_cancel}`", why: "§10.1 timer table: 'same' as MI_INSURER_CANCEL_NOTICE_45 — the insurer's cancellation ack." });
  o("SM_MI_LAR89_INTERNAL_TARGET_NEXTBD_2000", { satisfied: "`investor_event.queued{legacy_record=89}`", why: "§10.2 timer table: 'LAR 89 queued to fnma-lsdu' (policy buffer, never a Fannie Mae deadline)." });
  o("MN_47_207_ANNUAL_NOTICE_12M", { satisfied: "`notice.sent{code=NTC_HPA_4903A3_ANNUAL_MN}`", why: "§10.4 timer table: 'MN-variant notice sent' (Minn. Stat. §47.207 subd. 3)." });
  o("CA_2954_6_NOTICE_WITH_STATEMENT", { satisfied: "`notice.attached{code=NTC_HPA_4903A3_ANNUAL_CA}`", why: "§10.4 timer table: 'CA-variant PMI notice attached' to the §2954.2 statement (Cal. Civ. Code §2954.6)." });
  o("SM_MI_REFUND_VARIANCE_5BD", { satisfied: "`mi.refund.variance_resolved`", why: "§10.5 timer table: 'variance resolved'." });
  o("LL_2026_05_ESCROW_EVENT_3AM", { satisfied: "`investor_event.acked{family=escrow}`", why: "§10.5 timer table: 'escrow event acked' (LL-2026-05)." });
  o("SM_MI_DENIAL_SEND_5BD", { satisfied: "`notice.sent{code=NTC_HPA_4904B_DENIAL}`", why: "§10.6 timer table: 'notice sent'." });
}
