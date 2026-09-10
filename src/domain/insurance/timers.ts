/**
 * Registry overrides for Section 9 (hazard, flood, force-placed insurance,
 * loss drafts, inspections, preservation) timers whose spec rows are prose.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applyInsuranceTimerOverrides(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- 9.1 hazard tracking -------------------------------------------------
  o("INS_EXPIRATION_LAPSE_1", { trigger: "`insurance.policy.expired{evidence_received=false}`", anchorField: "expiration_date", why: "§9.1 timer table: expiration_date passes without evidence → lapse +1 calendar day." });
  // ---- 9.2 force-placed notices -------------------------------------------
  o("FNMA_B601_LPI_AFTER_ATTEMPTS", { evaluator: "9.2.firstNoticeAndReminderSent", why: "§9.2 timer table: LPI purchase opens only after `first_notice.sent` and `reminder.sent` events exist (B-6-01)." });
  o("REGX_1024_17K5_LPI_PURCHASE_GATE", { trigger: "`fpi.case.opened{escrowed=true}`", evaluator: "9.2.escrowedAdvanceBeforeForcePlacement", why: "§9.2 timer table: 'as in 9.1' — escrowed loans: advance to continue the borrower's policy rather than force-place (§1024.17(k)(5))." });
  o("REGX_1024_37D5_NOTICE_PRODUCTION_5BD", { trigger: "`notice.production`", anchor: "`production_at`", why: "§9.2 timer table: notice put into production → mailed within 5 `business_days_federal` (comment 37(d)(5)-1)." });
  // ---- 9.3 reminder --------------------------------------------------------
  o("INS_FPI_REMINDER_TARGET_30_35", { trigger: "`fpi.first_notice.sent`", anchor: "`first_notice_mailed_at`", why: "§9.3 timer table: 'gate open' is t0 + 30 of the first notice's proof-of-mailing date — the same `fpi.first_notice.sent` event that arms the 30-day gate; the window closes at t0 + 35." });
  // ---- 9.4 renewal ---------------------------------------------------------
  o("INS_FPI_RENEWAL_COVERAGE_REVIEW_60", { trigger: "`fpi.anniversary.approaching{days_before=60}`", anchorField: "anniversary_on", why: "§9.4 timer table: A − 60 → coverage reviewed by anniversary − 60 calendar days." });
  o("REGX_1024_37E1III_GAP_PROMPT_CHARGE", { trigger: "`fpi.gap.evidenced`", evaluator: "9.4.promptChargeAllowed", why: "§9.4 timer table: evidence of a post-expiration gap → immediate charge where `lpi_prompt_charge_prohibited=false` (§1024.37(e)(1)(iii))." });
  o("REGX_1024_37E5_FPI_RENEWAL_NOTICE_ANNUAL", { anchorField: "anniversary_on", offset: "−45 calendar_days", why: "§9.4 timer table: mail renewal notice by A − 45 calendar days (target A − 60) (§1024.37(e)(5))." });
  // ---- 9.5 cancellation / refund ------------------------------------------
  o("FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30", { trigger: "`insurance.evidence.received{kind=flood, fpi_active=true}`", why: "§9.5 timer table: evidence received → cancel flood LPI and refund within 30 calendar days (42 U.S.C. §4012a(e)(3))." });
  o("REGX_1024_37G_FPI_CANCEL_REFUND_15", { trigger: "`insurance.evidence.received{fpi_active=true, kind!=flood}`", satisfied: "`fpi.lpi.cancelled_and_refunded{track=regx_hazard}`", why: "§9.5 timer table: '`fpi.lpi.cancelled` AND `fpi.refund.paid` (or credited)' — the registry grammar holds one pattern, so 9.5 payRefund emits `fpi.lpi.cancelled_and_refunded` only once the LPI cancellation is on the books for the loan and the borrower refund is paid/credited (§1024.37(g)(1)–(2)); the hazard track arms on non-flood evidence for an active FPI case." });
  // ---- 9.6 flood -----------------------------------------------------------
  o("FDPA_4012A_E_FLOOD_FPI_NOTICE_45", { trigger: "`notice.mailed{template=INS_FLOOD_FPI_NOTICE_45}`", anchor: "`mailed_at`", why: "§9.6 timer table: `flood.fpi.notice.sent` anchored on the mailed date — the Notice Registry's proof-of-mailing event for the 45-day flood notice (42 U.S.C. §4012a(e)(1))." });
  o("FDPA_4012A_E2_FLOOD_PLACE_AFTER_45", { trigger: "`notice.mailed{template=INS_FLOOD_FPI_NOTICE_45}`", anchor: "`mailed_at`", offset: "+45 calendar_days", why: "§9.6 timer table: 'gate opens' = t0 + 45 of the flood notice's proof-of-mailing date → place on the first day allowed; Fannie 'no lapses' (42 U.S.C. §4012a(e)(2)). Anchored on the same mailing event as the gate, +45 days." });
  o("FNMA_B301_FLOOD_REMAP_COVERAGE_120", { anchor: "`effective_date`", why: "§9.6 timer table: 'remap effective date' — the map change's effective date carried on `flood.map_change.received` (B-3-01 120 days)." });
  o("FLOOD_EVIDENCE_EVAL_2BD", { trigger: "`insurance.evidence.received{kind=flood}`", why: "§9.6 timer table: evidence received → confirmed/rejected within 2 `business_days_servicer`." });
  o("FLOOD_LOL_HEARTBEAT_35", { trigger: "`flood.lol.message.received`", why: "§9.6 timer table: vendor life-of-loan feed heartbeat — any vendor message within 35 calendar days." });
  // ---- 9.7 loss drafts -----------------------------------------------------
  o("FNMA_B501_FORM176_ABANDONED_5BD", { trigger: "`insurance.claim.reported{property_status∈{abandoned, fc_scheduled}}`", why: "§9.7 timer table: learning of damage (abandoned/FC-scheduled, intends to repair) or decision not to repair → Form 176 within 5 `business_days_servicer` (B-5-01)." });
  o("FNMA_B501_PROOF_OF_LOSS_POLICY", { anchorField: "loss_date", offset: "+60 calendar_days", why: "§9.7 timer table: proof of loss per policy (default 60 calendar days; NFIP 60 from loss) (B-5-01)." });
  o("FNMA_B501_WIRE_POSTREOGRAM_PROCEEDS_10BD", { trigger: "`claim.proceeds.deposited{reogram_confirmed=true}`", why: "§9.7 timer table: proceeds received after REOgram confirmation → wire within 10 `business_days_fannie_et` (B-5-01)." });
  o("FNMA_D1301_DISASTER_FC_APPROVAL_5", { trigger: "`disaster.impact.determined{foreclosure_prereferral=true}`", offset: "+5 calendar_days", why: "§9.7 timer table: D1-3-01 'within five days' — default calendar days." });
  o("FNMA_F105_INSURED_LOSS_INSPECT_CLAIM_365", { trigger: "`property.inspection.cost_incurred{delinquent=false}`", why: "§9.7 timer table: inspection cost incurred (current loan) → 15.2 claim within 365 calendar days (F-1-05)." });
  o("INS_CLAIM_INITIAL_RELEASE_5BD", { trigger: "`claim.proceeds.deposited{repair_intent_known=true}`", why: "§9.7 timer table: deposit + repair intent known → initial release within 5 `business_days_servicer`." });
  o("INS_CLAIM_INSPECTION_ORDER_3BD", { trigger: "`claim.draw.requested`", why: "§9.7 timer table: draw request (or 30 days since last progress check, `claim.progress_check.due`) → inspection ordered within 3 `business_days_servicer`." });
  o("INS_CLAIM_STALE_90", { trigger: "`claim.activity.recorded`", why: "§9.7 timer table: last claim activity +90 calendar days without activity → stale." });
  // ---- 9.8 inspections -----------------------------------------------------
  o("FNMA_F105_INSPECTION_CLAIM_60", { trigger: "`claim.milestone.reached{kind∈{reinstatement, workout, liquidation}}`", why: "§9.8 timer table: milestone (reinstatement/workout/liquidation) → inspection claim within 60 calendar days (F-1-05)." });
  o("FNMA_P360_PFPIP_STATUS_SYNC_2BD", { trigger: "`loan.status.reported_to_fnma{pfpip_enrolled=true}`", why: "§9.8 timer table: delinquency/foreclosure/BK/loss-mit/occupancy/claim/HOA change reported elsewhere → program record updated within 2 `business_days_servicer`." });
  o("FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45", { trigger: "`property.vacancy_confirmed{pfpip=true}`", anchor: "`pfpip_exception_submit_on`", offset: "0", why: "§9.8 rule 1: day 45 is a delinquency day count from the earliest unpaid due date (PFPIP 'as early as 45 days for exceptions such as vacancy'); 9.8 updateOccupancy carries `pfpip_exception_submit_on` = max(earliest_unpaid_due + 45, vacancy confirmation) so a vacancy confirmed after day 45 is due at once, never 45 days later." });
  // ---- 9.9 preservation ----------------------------------------------------
  o("FNMA_PPM_AUDIT_RESPONSE_7", { trigger: "`fnma.request.received{kind=preservation_audit}`", why: "§9.9 timer table: Fannie Mae audit request → documents within 7 calendar days (PPM)." });
  o("FNMA_PPM_BID_RECONSIDER_7", { trigger: "`preservation.bid.decided{outcome∈{denied, modified}}`", why: "§9.9 timer table: bid denied/modified → reconsideration within 7 calendar days (PPM)." });
  o("FNMA_PPM_OVER_ALLOWABLE_BID_15", { trigger: "`preservation.condition.discovered{over_allowable=true}`", why: "§9.9 timer table: over-allowable condition discovered → bid within 15 calendar days (PPM)." });
  o("FNMA_PPM_ROOF_TARP_60", { trigger: "`preservation.work.completed{item=roof_tarp}`", why: "§9.9 timer table: tarp installed → permanent repair within 60 calendar days (PPM)." });
  o("FNMA_PPM_WINDOW_DOOR_REPAIR_3", { trigger: "`preservation.condition.discovered{item=unsecured_opening}`", why: "§9.9 timer table: unsecured window/door after initial securing → repair/clear-board within 3 calendar days (PPM)." });
  o("FNMA_PPM_YARD_REBID_15", { trigger: "`preservation.condition.discovered{item=grass_over_12in}`", why: "§9.9 timer table: grass > 12″ after initial service → bid within 15 calendar days (or BATF for 12–36″) (PPM)." });
  // ---- pseudo-trigger rows -----------------------------------------------------
  o("FNMA_F105_PRESERVATION_CLAIM_60", { trigger: "`claim.milestone.reached`", why: "§9.9 timer table: milestone → preservation expense claim within 60 calendar days (F-1-05)." });
  // ---- satisfaction events (spec "Satisfied by" prose → event patterns) ----
  o("FNMA_B203_MASTER_POLICY_ANNUAL_VERIFY_365", { satisfied: "`insurance.master_policy.verified`", why: "§9.1 timer table: 'same' — the next annual master-policy verification (B-2-03)." });
  o("INS_EXPIRATION_WATCH_60", { satisfied: "`insurance.evidence.confirmed{kind=renewal}`", why: "§9.1 timer table: 'renewal evidence'." });
  o("FNMA_B301_FLOOD_EVIDENCE_TO_FNMA_10BD", { satisfied: "`fnma.request.responded{kind=flood_evidence}`", why: "§9.1 timer table: 'response sent' (B-3-01)." });
  o("REGX_1024_37D_FPI_REMINDER_BEFORE_CHARGE_15", { satisfied: "`fpi.charge.assessed`", why: "§9.2 timer table: 'gate opens' 15 days after the reminder (§1024.37(d)(1)) — a not-before gate closes on the action it governs, the charge assessment (`fpi.charge.assessed`, as the registry's 45-day row states); the engine refuses the charge before its opens date." });
  o("REGX_1024_37C1III_FPI_EVIDENCE_WINDOW_15", { satisfied: "`fpi.evidence_window.evaluated`", why: "§9.2 timer table: 'evidence evaluation recorded at window end' (§1024.37(c)(1)(iii))." });
  o("REGX_1024_37D5_NOTICE_PRODUCTION_5BD", { satisfied: "`notice.mailed`", why: "§9.2 timer table: 'mailing' within 5 federal business days of production (comment 37(d)(5)-1) — the Notice Registry emits `notice.production` and `notice.mailed` on the same notice aggregate." });
  o("REGX_1024_37E_FPI_RENEWAL_NOTICE_45", { satisfied: "`fpi.renewal.charged`", why: "§9.4 timer table: the 45-day renewal-notice period ends (§1024.37(e)(1)(i)) — the gate closes on the renewal charge it governs (`fpi.renewal.charged`, 9.4 events)." });
  o("INS_FPI_EVIDENCE_EVAL_2BD", { satisfied: "`insurance.evidence.evaluated{outcome∈{confirmed, rejected}}`", why: "§9.5 timer table: `insurance.evidence.confirmed/rejected`." });
  o("FDPA_4012A_E3_FLOOD_LPI_TERMINATE_REFUND_30", { satisfied: "`fpi.lpi.cancelled_and_refunded{track=fdpa_flood}`", why: "§9.5/9.6 timer tables: 'cancellation + refund' within 30 days (42 U.S.C. §4012a(e)(3)) — emitted by 9.5 payRefund on the flood track once the termination is on the books and the refund is paid." });
  o("INS_FPI_CARRIER_REFUND_RECON_45", { satisfied: "`fpi.carrier_refund.reconciled`", why: "§9.5 timer table: '`refund_advice` reconciled'." });
  o("FDPA_4012A_E_FLOOD_FPI_NOTICE_45", { satisfied: "`flood.lpi.bound`", why: "§9.6 timer table: the 45-day notice period ends and placement is allowed (42 U.S.C. §4012a(e)(2)) — the gate closes on the placement it governs (`flood.lpi.bound`, 9.6 events)." });
  o("FLOOD_LOL_HEARTBEAT_35", { satisfied: "`flood.lol.message.received`", why: "§9.6 timer table: 'any vendor message'." });
  o("NFIP_44CFR6111_MAP_REVISION_1DAY_13M", { satisfied: "`flood.coverage.verified`", why: "§9.6 timer table: informational 13-month window after a map revision (44 CFR 61.11) — its guidance ends once the borrower's flood coverage is verified; otherwise it elapses at 13 months with no breach severity." });
  o("FLOOD_EVIDENCE_EVAL_2BD", { satisfied: "`insurance.evidence.evaluated{kind=flood, outcome∈{confirmed, rejected}}`", why: "§9.6 timer table: 'confirmed/rejected'." });
  o("INS_CLAIM_INITIAL_RELEASE_5BD", { satisfied: "`claim.funds.released{kind=initial}`", why: "§9.7 timer table: 'initial release'." });
  o("FNMA_B501_REMIT_PROCEEDS_REOGRAM_30", { satisfied: "`remittances.instructed{crs_code=332}`", why: "§9.7 timer table: 'code-332 remittance' (B-5-01)." });
  o("FNMA_B501_WIRE_POSTREOGRAM_PROCEEDS_10BD", { satisfied: "`claim.proceeds.wired`", why: "§9.7 timer table: 'wire sent' (B-5-01)." });
  o("INS_CLAIM_INSPECTION_ORDER_3BD", { satisfied: "`property.inspection.ordered{kind=repair}`", why: "§9.7 timer table: 'inspection ordered'." });
  o("INS_CLAIM_STALE_90", { satisfied: "`claim.activity.recorded`", why: "§9.7 timer table: 'any activity'." });
  o("FNMA_F105_INSURED_LOSS_INSPECT_CLAIM_365", { satisfied: "`expense_claim.filed{kind=inspection}`", why: "§9.7 timer table: '15.2 claim filed' (F-1-05)." });
  o("FNMA_D1301_DISASTER_FC_APPROVAL_5", { satisfied: "`fnma.disaster_fc_approval.submitted`", why: "§9.7 timer table: 'Fannie Mae submission incl. claim date/status/disbursements' (D1-3-01)." });
  o("FNMA_D2210_INSPECT_ORDER_DAY90", { satisfied: "`property.inspection.ordered`", why: "§9.8 timer table: 'order allowed' — the day-90 order (D2-2-10)." });
  o("FNMA_D2210_INSPECT_RECUR_20_35", { satisfied: "`property.inspection.completed`", why: "§9.8 timer table: 'next completion' (20–35 days after the last)." });
  o("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35", { satisfied: "`property.inspection.completed{type=interior}`", why: "§9.8 timer table: 'interior inspection' (vacant, ≤ 35 days)." });
  o("FNMA_D2210_VACANCY_INSPECT_ASAP_3BD", { satisfied: "`property.inspection.completed{purpose=vacancy_confirmation}`", why: "§9.8 timer table: 'vacancy-confirmation inspection completed'." });
  o("FNMA_P360_PFPIP_SUBMIT_EXCEPTION_DAY45", { satisfied: "`p360.pfpip.submitted`", why: "§9.8 timer table: 'submitted' — the same `p360.pfpip.submitted` event 9.8 submitPfpip emits for the day-90 row." });
  o("FNMA_P360_PFPIP_STATUS_SYNC_2BD", { satisfied: "`p360.pfpip.updated`", why: "§9.8 timer table: 'program record updated' (`p360.pfpip.updated`, 9.8 events; emitted by updatePfpip)." });
  o("FNMA_F105_INSPECTION_CLAIM_60", { satisfied: "`expense_claim.filed{kind=inspection}`", why: "§9.8 timer table: 'claim filed' (F-1-05)." });
  o("FNMA_PPM_POST_NOTICE_SECURE_7", { satisfied: "`preservation.work.completed{kind=initial_services}`", why: "§9.9 timer table: 'initial completed' (PPM)." });
  o("FNMA_PPM_WINDOW_DOOR_REPAIR_3", { satisfied: "`preservation.work.completed{item=unsecured_opening}`", why: "§9.9 timer table: 'repair/clear-board completed'." });
  o("FNMA_PPM_BID_RECONSIDER_7", { satisfied: "`preservation.bid.reconsideration_submitted`", why: "§9.9 timer table: 'reconsideration submitted or accepted'." });
  o("FNMA_PPM_AUDIT_RESPONSE_7", { satisfied: "`fnma.request.responded{kind=preservation_audit}`", why: "§9.9 timer table: 'documents provided'." });
  o("FNMA_PPM_ROOF_TARP_60", { satisfied: "`preservation.work.completed{item=roof_repair}`", why: "§9.9 timer table: 'permanent repair completed/approved'." });
  o("FNMA_PPM_YARD_REBID_15", { satisfied: "`preservation.bid.submitted{item=yard}`", why: "§9.9 timer table: 'bid submitted (or BATF filed for 12–36″)'." });
  o("FNMA_F105_PRESERVATION_CLAIM_60", { satisfied: "`expense_claim.filed{kind=preservation}`", why: "§9.9 timer table: 'claim filed' (F-1-05)." });
}
