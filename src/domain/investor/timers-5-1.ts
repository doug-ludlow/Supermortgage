/**
 * §5.1 timer overrides (process-owned; the §5 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 5.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Emitters (src/domain/investor/ops-5-1.ts, all appended to the event store by the named code path):
 *   `investor_events.created{event_type, family, mode, processed_at, activity_period, per_loan_sequence}` — createInvestorEvent
 *     (rule 1; the 5.1 projectEvent tool creates the canonical row when the source command did not);
 *   `investor_events.submitted{event_type, family}` — recordSubmissionAck / submitLarFile (the adapter acknowledgement);
 *   `investor_events.accepted{event_type, family, deferral_pending}` and `investor_event_exceptions.detected{family, period_end}`
 *     — ingestLarFeedback / ingestServicingEventResponses (parsed Fannie Mae responses only);
 *   `investor_events.resolved{status, family}` — resolveInvestorEvent (superseding acceptance, period-close soft-reject closure);
 *   `investor_event_exceptions.triaged` — recordTriage; `investor_reporting_periods.opened` / `.loan_enrolled` — openReportingPeriod;
 *   `investor_batches.bulk_channel.closed` — bulkCutoffSweep; `investor_reporting_periods.closed{checklist_complete, escrow_events,
 *   attestation_window_close_on}` — closeReportingPeriod; `human_portal_task.completed{task=escrow_attestation}` — completeEscrowAttestation;
 *   `period.month_end` — monthEnd; `report.produced{report=compfee_watch}` — compensatoryFeeWatch;
 *   `lossmit.deferral.approved{processing_month_end}` — ingestSmduDeferralAcceptance (the `fnma-smdu` read integration).
 * Triggers owned elsewhere: `loan_terms.*` (§2.4), `mi.*{lar89_action_code}` (§10), `transfer.batch.approved{direction=out}` (§17.1).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_5_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_C4301_LAR_NONREMOVAL_NEXTBD_2000", { trigger: "`investor_events.created{family!=removal, family!=escrow, family!=mi, family!=transfer, family!=loan_data_change, family!=delinquency, family!=scra}`",
    why: "§5.1 timer table: `investor_events.created` (family payment/nonpayment) → next business day 20:00 America/New_York (`business_days_fannie_et`, 1) after `processed_at`; satisfied by `investor_events.submitted` (same event) — recordSubmissionAck. The families with their own rows (removal → FNMA_IRM_REMOVAL_NEXTBD_2000; mi → LAR 89; transfer → TT 32; loan_data_change → LAR 83; delinquency → 5.7; scra → F-1-19) and the escrow rail (5.1-T6: 'no LAR is created (escrow has no LAR)') never arm this clock; §2's `investor_events.created` rows carry no `family` field and keep arming it as payment events (C-4.3-01)." });
  o("FNMA_IRM_LAR_IRED_CD22_2000", { trigger: "`investor_reporting_periods.loan_enrolled`", anchorField: "period_start",
    why: "§5.1 timer table: kind 'deadline (recurring monthly, per loan)' triggered by `investor_reporting_periods.opened` — the period opens once per servicer number and openReportingPeriod enrols every active loan in it (`investor_reporting_periods.loan_enrolled{loan_id, period_start, ired_on}`, the per-loan instance the row asks for; the period-level `.opened` event carries no loan and arms the period clocks only). Calendar day 22 of the period month (preceding BD if not BD) 20:00 ET — the IRED floor 'regardless of whether a payment was received' (IRM p. 11). Satisfied by 'any accepted `payment.*` event in period or `payment.none` submitted' → `investor_events.accepted{family∈{payment, nonpayment}}` from ingestLarFeedback (rule 4: the sweep's `payment.none` is `nonpayment`)." });
  o("FNMA_LL202605_NOPAYMENT_CD22", { trigger: "`investor_reporting_periods.loan_enrolled`", anchorField: "period_start",
    why: "§5.1 timer table: period → a 'no payment' event by the 22nd calendar day (preceding business day if weekend/holiday) 23:59 ET per loan (LL-2026-05) — armed by the loan's enrolment in the opened period (openReportingPeriod), the same per-loan fact as the IRED row; satisfied by `investor_events.accepted{event_type=payment.none}` (ingestLarFeedback / ingestServicingEventResponses)." });
  o("FNMA_IRM_TT32_15CD", { trigger: "`transfer.batch.approved{direction=out}`", anchorField: "transfer_date",
    why: "§5.1 timer table: `transfer_out.approved` (Section 17.1) → TT 32 due 15 calendar days before the transfer effective date (`tt32DueOn`). §17.1 spells the approval `transfer.batch.approved{direction=out, transfer_date, …}` (src/domain/transfers/ops-17-1.ts TRANSFER_OUT_EVENT / inbound.ts approvedPayload; the Form 629 approval ingested from Fannie Mae); the anchor is its `transfer_date`. Satisfied by `investor_events.accepted{event_type=transfer.servicing}` (ingestLarFeedback)." });
  o("FNMA_IRM_NONREMOVAL_CORRECTION_BD1_2000", { satisfied: "`investor_events.resolved{status∈{superseded, accepted}, family!=removal}`",
    why: "§5.1 timer table: exception on a non-removal event → `superseded`/`accepted` by BD1 20:00 ET of the following month — resolveInvestorEvent appends `investor_events.resolved{status, family}` when the correcting event is accepted (ingestLarFeedback) or the soft reject closes at period close (closeSoftRejectsAtPeriodClose); a removal's resolution (its own BD2 17:00 ET row) never closes a non-removal clock on the same loan." });
  o("FNMA_IRM_DEFERRAL_LAR_BEFORE_EOM_1BD", { why: "§5.1 timer table: `lossmit.deferral.approved` → the contractual-payment LAR accepted at least 1 `business_days_fannie_et` before the last day of the processing month (IRM 4-01, `deferralLarDeadlineOn`); no §12 command emits the approval, so the 5.1 `fnma-smdu` read integration does — ingestSmduDeferralAcceptance appends `lossmit.deferral.approved{processing_month_end, contractual_lar_due_on}` from the accepted SMDU case (Integrations: 'modification/deferral acceptance → triggers the single post-workout LAR'). Satisfied by `investor_events.accepted{event_type=payment.contractual, deferral_pending=true}` — ingestLarFeedback carries `deferral_pending` off the tracked row (createInvestorEvent)." });
  o("FNMA_LL202605_ESCROW_ATTEST_BD2", { why: "§5.1 timer table: period (escrow) — 'BD3 opens; due BD2 of following month 17:00 ET' (LL-2026-05): closeReportingPeriod stamps `escrow_events` and `attestation_window_close_on` (= BD2 of the month after the closing month) on `investor_reporting_periods.closed`; satisfied by `human_portal_task.completed{task=escrow_attestation}` — completeEscrowAttestation, a human act of the `fnma_portal_operator` with the attestation evidence attached (guardrail: every UI-only submission)." });
  o("FNMA_IRM_BULK_CUTOFF_BD2_1500", { why: "§5.1 timer table: period close job — bulk B2B/LSDU upload cutoff BD2 15:00 ET of the following month (IRM: 'cannot be performed … after 3 p.m. eastern time on the second business day'), armed when the period opens; after the cutoff bulkCutoffSweep emits `investor_batches.bulk_channel.closed` and turns the remaining files into `lsdu_single` portal tasks due at the 17:00 ET close." });
  o("FNMA_IRM_REJECT_TRIAGE_4H", { why: "§5.1 timer table: `investor_event_exceptions.detected` (ingestLarFeedback / ingestServicingEventResponses) → 'triage decision recorded' within 4 hours (any day) — recordTriage appends `investor_event_exceptions.triaged` with the `agent_decisions` record (rule 9); confidence < 0.8 records a hold-and-escalate decision." });
  o("FNMA_A14201_COMPFEE_WATCH", { why: "§5.1 timer table: monthly, informational — monthEnd emits `period.month_end` and compensatoryFeeWatch the `report.produced{report=compfee_watch}` counting late/inaccurate instances toward the $250/$500/$1,000 ladder (A1-4.2-01)." });
}
