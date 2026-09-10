/**
 * Registry overrides for Section 8 (credit reporting) timers whose spec rows
 * are prose. Each override cites the row it encodes.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyCreditReportingTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 8.1 monthly furnishing ---------------------------------------------
  o("FCRA_1681S2A5_DOFD_90", { trigger: "`metro2.file.transmitted{first_delinquent_status=true, dofd is null}`", anchorField: "transmitted_at", why: "§8.1 timer table: first furnishing of status 93 or 97 without DOFD → DOFD within 90 calendar days (15 U.S.C. §1681s-2(a)(5))." });
  o("FDCPA_1006_30A_PRE_FURNISH_GATE", { trigger: "`loan.boarded{fdcpa_debt_collector=true}`", offset: "until fdcpa.furnishing_gate.opened", why: "§8.1 timer table: opens on `contact.live` or letter mailed + 14 calendar days without undeliverability notice (Reg F §1006.30(a); 11.4 owns the gate event)." });
  o("FNMA_C41_01_METRO2_SNAPSHOT_EOM", { trigger: "`schedule.tick{cadence=monthly, day=1, at=00:05}`", anchorField: "as_of_date", why: "§8.1 timer table: schedule (00:05 ET on the 1st) → snapshot as of last calendar day of prior month (C-4.1-01)." });
  o("SM_METRO2_ACK_EXPECTED_BD", { offset: "+5 business_days_servicer", why: "§8.1 timer table: `furnisher_config.ack_expected_within_bd` (default 5 `business_days_servicer`; per-bureau UNVERIFIED)." });
  // ---- 8.3 overlays --------------------------------------------------------
  o("BK_CII_APPLY_NEXT_CYCLE", { offset: "first day of next month, 00:05 ET", why: "§8.3 timer table: petition filed (and each phase change) → CII carried by next `FNMA_C41_01_METRO2_SNAPSHOT_EOM` (1st of next month 00:05 ET)." });
  o("SM_CR_DECEASED_ECOA_X_NEXT_CYCLE", { offset: "first day of next month, 00:05 ET", why: "§8.3 timer table: deceased confirmed → ECOA X in the next cycle's snapshot." });
  o("SM_CR_OVERLAY_URGENT_AUD_BD2", { trigger: "`credit.overlay.urgent{kind∈{identity_theft_block, scra_adverse_correction, deceased_in_error}}`", why: "§8.3 timer table: identity-theft block, SCRA adverse correction, deceased-in-error → AUD within 2 `business_days_servicer`." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("SM_ACDV_INTERNAL_TARGET_CD7", { trigger: "`credit.dispute.acdv.received`", why: "§8.2 timer table: 'same' as FCRA_1681S2B_ACDV_RESPONSE_DUE → `credit.dispute.acdv.received`; internal target 7 calendar days." });
  o("FCRA_1681I_A1_CRA_OUTER_30_45", { trigger: "`credit.dispute.acdv.received`", anchorField: "cra_received_at", why: "§8.2 timer table: 'same' trigger; 30 calendar days (45 if consumer-supplied information) from `cra_received_at` (15 U.S.C. §1681i(a)(1))." });
  o("SM_ACDV_POLL_15M", { trigger: "`schedule.tick{cadence=every_15_minutes}`", why: "§8.2 timer table: schedule → e-OSCAR poll every 15 minutes." });
}
