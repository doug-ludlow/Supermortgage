/**
 * §27.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 27.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. Referenced codes are never
 * redefined here: `SM_UW_CTC_GATE` (23.3), `SM_O61_COMPLIANCE_PASS_DISBURSE_GATE` (25.1), `REGZ_1026_23_RESCISSION_3SBD_GATE`
 * (25.3), `MERS_PROC_MOM_REGISTER_7` (26.4), `MERS_PROC_ENOTE_REGISTER_1BD` (26.2), `FNMA_C2_2_DELIVERY_LPI_45` (29.4),
 * `FNMA_B2_1_5_FIRST_PAYMENT_2M` (26.3) and 27.2's `SM_WH_INTERIM_FUNDER_RELEASE_2BD` (its `warehouse.interim_funder.removed`
 * is emitted by 30.1's ops-30-1.ts). Every event named here is appended by src/domain/warehouse/ops-27-1.ts.
 * Wired by src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_27_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Facility set-up: the UCC-1 gate is a condition asserted by domain code (filed, acknowledged, lien search clean), armed by the activation request and closed by activation.
  o("SM_WH_UCC1_FILING_GATE", { trigger: "`warehouse.facility.activation_requested`", evaluator: "27.1.ucc1Filed", satisfied: "`warehouse.facility.activated`",
    why: "§27.1 timer table: not_before_gate on 'facility activation request'; 'UCC-1 filed and acknowledged; lien search clean'; satisfied by `warehouse.facility.activated`; breach: no advances (activateFacility refuses without the acknowledgment and a clean search)." });
  // 9-515: five-year effectiveness, continuation in the last six months — the continuation is due at +4 y 6 m (fixture: filed Sept 15, 2026 → window from Mar 15, 2031, lapse Sept 15, 2031).
  o("SM_WH_UCC_CONTINUATION_5Y", { offset: "+54 months", anchorField: "ucc1_filed_on", satisfied: "`warehouse.facility.ucc_continuation_filed`",
    why: "§27.1 timer table: 'lapse at +5 years; continuation due in the last 6 months (file at +4 y 6 m) — calendar_days [PARTIALLY VERIFIED 9-515]'; satisfied by 'continuation filed' (fileUccContinuation); breach: sev 1 → officer{sm}; facility suspended at lapse." });
  // The 2-business-hour SLA: hours from `requested_at`, on a servicer business day; the decision event carries `decision` so one pattern covers approved and rejected.
  o("SM_WH_ADVANCE_APPROVAL_2BH", { offset: "+2 hours (rolled to the next servicer business day)", anchorField: "requested_at", satisfied: "`warehouse.advance.*{decision∈{approved, rejected}}`",
    why: "§27.1 timer table: '+2 business hours (business_days_servicer, 08:00–18:00 ET)' from requested_at; satisfied by '`warehouse.advance.approved/rejected`' — recordAdvanceDecision appends `warehouse.advance.approved{decision=approved}` or `warehouse.advance.rejected{decision=rejected}`; breach: sev 2 → funding_approver." });
  // Fedwire cut-off: approved by 13:00 ET funds same day (a non-Fedwire day rolls); the wire release satisfies; past the cut-off the value date rolls (wireValueDate).
  o("SM_WH_ADVANCE_CUTOFF_GATE", { offset: "0 (rolled to the next federal business day), 13:00 ET", anchorField: "approved_at", satisfied: "`warehouse.advance.funded`",
    why: "§27.1 timer table: not_before_gate (daily window) on `warehouse.advance.approved`: 'requests approved by 13:00 ET fund same day; later → next business_days_federal (Fedwire)'; satisfied by 'wire released' (fundAdvance → `warehouse.advance.funded`); breach: value date rolls; 26.3 notified." });
  // eNote Secured Party: arms only for an advance funded before the Controller added SM ('until then the advance is unsecured_wet'); anchor max(advance_date, enotes.registered_at) is computed on the funded event.
  o("SM_WH_ENOTE_SECURED_PARTY_1BD", { trigger: "`warehouse.advance.funded{note_form=enote, collateral_status=unsecured_wet}`", anchorField: "secured_party_anchor_date",
    why: "§27.1 timer table: trigger `warehouse.advance.funded{note_form=enote}`, anchor 'max(advance_date, enotes.registered_at)' (fundAdvance writes secured_party_anchor_date); rule 4: 'until then the advance is unsecured_wet' — an eNote already under SM's Secured Party control at funding (fixture A, Nov 9) has no clock; satisfied by `warehouse.secured_party.added`." });
  // Interim Funder: anchored on the note date (funding date for refinances / escrow states — the MERS rule 26.4 applies); 27.1 verifies 26.4's registration and emits the designation.
  o("SM_WH_INTERIM_FUNDER_DESIGNATION_7", { anchorField: "interim_funder_anchor_date", satisfied: "`warehouse.interim_funder.designated`",
    why: "§27.1 timer table: anchor 'note date (refinance/escrow states: funding date — MERS rule; 26.4)' (fundAdvance writes interim_funder_anchor_date); satisfied by '`mers.min.registered{interim_funder_org_id=SM}`' — recordInterimFunderCheck verifies 26.4's registration against SM's Org ID and appends `warehouse.interim_funder.designated`; breach: ineligible for the borrowing base; escalation to post-closing and signing_officer{partner}." });
  // Bailee-letter gate on a paper-note shipment: condition asserted by domain code; the shipment release closes it.
  o("SM_WH_BAILEE_LETTER_GATE", { trigger: "`warehouse.note.shipment_requested`", evaluator: "27.1.baileeLetterCovers", satisfied: "`warehouse.note.shipment_released`",
    why: "§27.1 timer table: not_before_gate on 'shipment of a paper note to the custodian (26.4)'; 'bailee_letters.status ∈ {issued, acknowledged} covering the loan and Loan Delivery Letter Name active'; satisfied by 'shipment released'; breach: shipment blocked; sev 2." });
  // Recurring clocks: each open advance accrues daily at 00:30 ET from its advance date; capitalization on the 1st at 06:00 ET; the borrowing base on every servicer business day at 07:00 ET from facility activation.
  o("SM_WH_DAILY_ACCRUAL", { trigger: "`warehouse.advance.funded`", offset: "+1 calendar_days, 00:30 ET",
    why: "§27.1 timer table: recurring, '00:30 ET daily', 1 calendar_days; satisfied by '`warehouse.interest.accrued` for every open advance' — one instance per funded advance, re-armed by the engine on each accrual (recordAccrual)." });
  o("SM_WH_INTEREST_CAPITALIZE_MONTHLY", { trigger: "`warehouse.advance.funded`", offset: "first day of next month, 06:00 ET",
    why: "§27.1 timer table: recurring, '1st calendar day, 06:00 ET', monthly; satisfied by '`warehouse.interest.capitalized` (or invoice per election)' (recordCapitalization); re-armed for the following 1st." });
  o("SM_WH_BORROWING_BASE_DAILY", { trigger: "`warehouse.facility.activated`", offset: "next business_days_servicer at 07:00 ET", anchorField: null,
    why: "§27.1 timer table: recurring, '07:00 ET each business_days_servicer', daily; satisfied by `warehouse.borrowing_base.computed` (recordBorrowingBase); breach: sev 2; no new advances until computed." });
  o("SM_WH_DAILY_REPORT_0900ET", { offset: "0, 09:00 ET",
    why: "§27.1 timer table: deadline on `warehouse.borrowing_base.computed`, 'by 09:00 ET'; satisfied by `warehouse.daily_report.issued` (issueDailyReport); breach: sev 3." });
  // Aging: day 45 rolls to the next servicer business day for payment (fixture: Sun Dec 27 → Mon Dec 28, 2026); satisfied by the aging curtailment's payment.
  o("SM_WH_AGING_45_CURTAIL", { offset: "+45 calendar_days (rolled to the next servicer business day)", anchorField: "advance_date", satisfied: "`warehouse.curtailment.paid{kind=aging_45}`",
    why: "§27.1 timer table: '+45 calendar_days; if non-business, payment due next business_days_servicer' from advance_date (day 0); satisfied by `warehouse.curtailment.paid` (payCurtailment, kind aging_45); breach: day 46 dwell_stepup_active (+50 bps); unpaid curtailment = covenant event; escalation officer{partner}." });
  o("SM_WH_AGING_90_KICKOUT", { satisfied: "`warehouse.advance.repaid`",
    why: "§27.1 timer table: '+90 calendar_days' from advance_date; satisfied by 'repaid' — `warehouse.advance.repaid` (27.2 purchase proceeds, completeRepurchase, unwindOnRescission); breach: `warehouse.kickout.issued` (issueKickout with officer{sm} acknowledgment)." });
  // Covenants: the period-end schedule is an event the facility calendar appends; the last covenant test of the package carries period_complete.
  o("SM_WH_COVENANT_QUARTERLY_45", { trigger: "`warehouse.covenant.period_ended{frequency=quarterly}`", anchorField: "period_end", satisfied: "`warehouse.covenant.tested{period_complete=true}`",
    why: "§27.1 timer table: trigger 'quarter end' (endCovenantPeriod), anchor period_end, '+45 calendar_days (unaudited quarterly package)'; satisfied by '`warehouse.covenant.tested` for every covenant' (recordCovenantTests marks the last row period_complete); breach: `warehouse.covenant.breached{reporting}`; escalation officer{partner}." });
  o("SM_WH_COVENANT_ANNUAL_90", { trigger: "`warehouse.covenant.period_ended{frequency=annual}`", anchorField: "period_end", satisfied: "`warehouse.covenant.tested{period_complete=true}`",
    why: "§27.1 timer table: trigger 'fiscal year end', anchor period_end, '+90 calendar_days (audited financials)'; satisfied 'as above'; breach 'as above'." });
  // Haircut reserve gate: condition asserted by domain code on the approved advance; the wire release closes it.
  o("SM_WH_HAIRCUT_RESERVE_GATE", { evaluator: "27.1.haircutReserveCovers", satisfied: "`warehouse.advance.funded`",
    why: "§27.1 timer table: not_before_gate on `warehouse.advance.approved`: 'partner_haircut_reserve ≥ partner_contribution_cents'; satisfied by 'wire released' (`warehouse.advance.funded`); breach: advance held; partner asked to fund; 26.3 informed." });
}
