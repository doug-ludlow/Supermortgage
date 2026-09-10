/**
 * Registry overrides for Section 8 (credit reporting) timers whose spec rows
 * are prose. Each override cites the row it encodes. The event vocabulary is
 * the one `src/domain/credit-reporting/ops.ts` (CreditCycleRunner) and
 * `src/app/tools/section08.ts` emit:
 *
 *   credit.cycle.opened{cycle_id, as_of_date}          metro2.file.transmitted{bureau, file_id, transmitted_at, all_bureaus}
 *   credit.cycle.snapshot_completed / .validated       metro2.loan.furnished{account_status, dofd, negative_information, b1_on_file, transmitted_at}
 *   metro2.ack.received{reject_count, received_at}     metro2.ack.items.resolved{pending}
 *   credit.correction.created{determined_on}           credit.dofd.furnished{via∈{file, aud}}
 *   eoscar.aud.submitted{bureau, aud_id}               credit.overlay.urgent{kind}   credit.identity_theft.released{by}
 *   accuracy_program.control_run{control_id}           notice.sent{template} (Notice Registry, 7.x)
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyCreditReportingTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 8.1 monthly furnishing ---------------------------------------------
  o("FNMA_C41_01_METRO2_SNAPSHOT_EOM", { trigger: "`schedule.tick{cadence=monthly, day=1, at=00:05}`", anchorField: "as_of_date", why: "§8.1 timer table: schedule (00:05 ET on the 1st) → snapshot as of last calendar day of prior month (C-4.1-01); satisfied by `credit.cycle.snapshot_completed` (CreditCycleRunner.build)." });
  o("SM_METRO2_TRANSMIT_ALL4_BD3", { satisfied: "`metro2.file.transmitted{all_bureaus=true}`", why: "§8.1 timer table: 'Satisfied by `metro2.file.transmitted` for all four bureaus' — the cycle-level event CreditCycleRunner.transmit emits after the fourth file, not the first bureau's file." });
  o("SM_METRO2_TRANSMIT_HARD_CD10", { satisfied: "`metro2.file.transmitted{all_bureaus=true}`", why: "§8.1 timer table: 'same' as the transmit target — files transmitted to all four bureaus." });
  o("SM_METRO2_ACK_EXPECTED_BD", { trigger: "`metro2.file.transmitted{bureau is not null}`", offset: "+5 business_days_servicer", anchorField: "transmitted_at", why: "§8.1 timer table: per-bureau file (the cycle-level all_bureaus event carries no `bureau`); `furnisher_config.ack_expected_within_bd` (default 5 `business_days_servicer`; per-bureau UNVERIFIED); satisfied by `metro2.ack.received` on the same file." });
  o("SM_METRO2_REJECT_RESOLVE_BD5", { trigger: "`metro2.ack.received{reject_count>0}`", anchorField: "received_at", satisfied: "`metro2.ack.items.resolved{pending=0}`", why: "§8.1 timer table: '`metro2.ack.received` with rejects' → 5 `business_days_servicer` from the ack date; 'all `metro2_ack_items.resolution` ≠ pending' is the `metro2.ack.items.resolved{pending=0}` event CreditCycleRunner.ingestAck emits when every item resolves (the registry text names a column, not an event)." });
  o("FCRA_1681S2A2_CORRECTION_PROMPT_BD2", { anchorField: "determined_on", why: "§8.1 timer table: `credit.correction.created` (inaccuracy determined) → 2 `business_days_servicer` from the determination date; satisfied by `eoscar.aud.submitted` (the 8.2/8.3 AUD tool)." });
  o("FCRA_1681S2A7_NEG_INFO_NOTICE_30", { trigger: "`metro2.loan.furnished{negative_information=true, b1_on_file=false}`", anchorField: "transmitted_at", satisfied: "`notice.sent{template=NTC_FCRA_1681S2A7_B2}`", why: "§8.1 timer table: 'first `metro2.file.transmitted` containing negative information for a loan/consumer with no B-1 notice on file' → per-loan `metro2.loan.furnished`; satisfied by `notice.sent` (`NTC_FCRA_1681S2A7_B2`) — pre-existing B-1 evidence keeps the trigger from arming (15 U.S.C. §1681s-2(a)(7))." });
  o("FCRA_1681S2A5_DOFD_90", { trigger: "`metro2.loan.furnished{account_status∈{93,97}, dofd is null}`", anchorField: "transmitted_at", satisfied: "`credit.dofd.furnished{via∈{file, aud}}`", why: "§8.1 timer table: 'first furnishing of status 93 or 97 without DOFD' → 90 calendar days; 'file/AUD carrying DOFD' — CreditCycleRunner.transmit emits via=file, the AUD tool via=aud when the AUD carries a DOFD (15 U.S.C. §1681s-2(a)(5); the generator makes the trigger unreachable: DOFD is a hard requirement for 97)." });
  o("FDCPA_1006_30A_PRE_FURNISH_GATE", { trigger: "`loan.boarded{fdcpa_debt_collector=true}`", offset: "until fdcpa.furnishing_gate.opened", satisfied: "`fdcpa.furnishing_gate.opened`", why: "§8.1/8.3 timer tables: opens on `contact.live` or letter mailed + 14 calendar days without undeliverability notice (Reg F §1006.30(a); 11.4 owns the gate event; 8.3 rule 8)." });
  // ---- 8.2 disputes ----------------------------------------------------------
  o("SM_ACDV_INTERNAL_TARGET_CD7", { trigger: "`credit.dispute.acdv.received`", satisfied: "`credit.dispute.acdv.responded`", why: "§8.2 timer table: 'same' as FCRA_1681S2B_ACDV_RESPONSE_DUE → `credit.dispute.acdv.received`; internal target 7 calendar days; the ACDV response submitted." });
  o("FCRA_1681I_A1_CRA_OUTER_30_45", { trigger: "`credit.dispute.acdv.received`", anchorField: "cra_received_at", satisfied: "`credit.dispute.acdv.responded`", why: "§8.2 timer table: 'same' trigger; 30 calendar days (45 if consumer-supplied information) from `cra_received_at`; the CRA's outer bound is met by the response (15 U.S.C. §1681i(a)(1))." });
  o("FCRA_1022_43E_DIRECT_RESULTS_30", { satisfied: "`notice.sent{template=NTC_FCRA_1022_43E_RESULTS}`", why: "§8.2 timer table: 'Satisfied by `notice.sent` (`NTC_FCRA_1022_43E_RESULTS`)' — the results notice, not any notice (12 CFR 1022.43(e))." });
  o("FCRA_1022_43E_DIRECT_RESULTS_EXT_45", { satisfied: "`notice.sent{template=NTC_FCRA_1022_43E_RESULTS}`", why: "§8.2 timer table: 'same' as FCRA_1022_43E_DIRECT_RESULTS_30 — the results notice (12 CFR 1022.43(e))." });
  o("FCRA_1022_43F_FRIVOLOUS_NOTICE_5BD", { anchorField: "determined_on", satisfied: "`notice.sent{template=NTC_FCRA_1022_43F_FRIVOLOUS}`", why: "§8.2 timer table: 'Satisfied by `notice.sent` (`NTC_FCRA_1022_43F_FRIVOLOUS`)' within 5 `business_days_federal` of the determination date (12 CFR 1022.43(f)(2))." });
  o("FCRA_1681S2A3_XB_FLAG_GATE", { satisfied: "`credit.dispute.closed`", why: "§8.2/8.3 timer tables: XB holds 'until closed' — the dispute close transitions the CCC (rule 6)." });
  o("SM_ACDV_POLL_15M", { trigger: "`schedule.tick{cadence=every_15_minutes}`", satisfied: "`eoscar.poll.succeeded`", why: "§8.2 timer table: schedule → e-OSCAR poll every 15 minutes; 'poll success'." });
  o("SM_DISPUTE_REVIEW_SLA_BD1", { satisfied: "`credit.dispute.reviewed`", why: "§8.2 timer table: 'reviewer action'." });
  // ---- 8.3 overlays --------------------------------------------------------
  o("RESPA_2605E3_QWR_SUPPRESS_60", { satisfied: "`credit.noe_bar.expired`", why: "§8.3 timer table: 'expiry' of the 60-day bar (12 U.S.C. §2605(e)(3); §1024.35(i)(1))." });
  o("FCRA_1681C2_IDTHEFT_BLOCK_GATE", { satisfied: "`credit.identity_theft.released{by=officer}`", why: "§8.3 timer table: 'until officer release with evidence' — the release branch of `credit.suppression.create/release` emits it only for an officer actor (15 U.S.C. §1681c-2)." });
  o("SCRA_3919_NO_ADVERSE_GATE", { satisfied: "`scra.relief.ended{plus_one_cycle=true}`", why: "§8.3 timer table: 'until relief/stay end + 1 cycle' (50 U.S.C. §3919)." });
  o("BK_CII_APPLY_NEXT_CYCLE", { offset: "first day of next month, 00:05 ET", satisfied: "`metro2.snapshot.built{cii_applied=true}`", why: "§8.3 timer table: petition filed (and each phase change) → CII carried by next `FNMA_C41_01_METRO2_SNAPSHOT_EOM` (1st of next month 00:05 ET); 'snapshot carries the phase's CII'." });
  o("SM_CR_DECEASED_ECOA_X_NEXT_CYCLE", { offset: "first day of next month, 00:05 ET", satisfied: "`metro2.snapshot.built{ecoa_x_applied=true}`", why: "§8.3 timer table: deceased confirmed → ECOA X in the next cycle's snapshot." });
  o("SM_CR_OVERLAY_URGENT_AUD_BD2", { trigger: "`credit.overlay.urgent{kind∈{identity_theft_block, scra_adverse_correction, deceased_in_error}}`", why: "§8.3 timer table: identity-theft block, SCRA adverse correction, deceased-in-error → AUD within 2 `business_days_servicer`; `credit.suppression.create/release` emits the trigger, the AUD tool emits `eoscar.aud.submitted`." });
  o("SM_CR_SUPPRESSION_REVIEW_30", { satisfied: "`credit.suppression.reviewed`", why: "§8.3 timer table: 'review recorded' (every 30 days while active)." });
  o("SM_APPX_E_SAMPLE_VERIFY_MONTHLY", { satisfied: "`accuracy_program.control_run{control_id=E-III-d}`", why: "§8.3 timer table: '`accuracy_program.control_runs` for control `E-III-d`' — the row names the table; the `accuracy.control.run` tool emits one `accuracy_program.control_run{control_id}` event per run (Appendix E III(d))." });
}
