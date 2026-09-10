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
}
