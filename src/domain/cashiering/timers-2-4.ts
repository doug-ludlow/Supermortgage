/**
 * §2.4 timer overrides (process-owned; the §2 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 2.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_2_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // "`payment.received{designation=curtailment}` on a current loan": the loan is current once the scheduled payment submitted with the
  // curtailment has been applied — F-1-09 "apply the scheduled monthly payment first, then apply the principal curtailment"; worked
  // example F (319,257¢ on 2026-09-03 with the 2026-09-01 installment unpaid at receipt) is the spec's own "fixture L-1 current" case.
  // `current_after_funds` (service.ts receipt facts) is true when the funds cover every installment due on/before receipt, false when
  // rule 3 redirects them to cure (example G) — then FNMA_C1201_DELINQUENT_CURE_FIRST_GATE governs instead and this clock must not arm.
  o("FNMA_C1201_CURTAILMENT_APPLY_IMMEDIATE_0BD", { trigger: "`payment.received{designation=curtailment, current_after_funds=true}`", anchorField: "received_on", offset: "same day", satisfied: "`payment.curtailment.applied`",
    why: "§2.4 timer table: `payment.received{designation=curtailment}` on a current loan → same `business_days_servicer` day (0), anchored on `received_on`, satisfied by `payment.curtailment.applied` (C-1.2-01 'immediately accept and apply'; F-1-09 ordering makes example F a current-loan curtailment)." });
  // The re-amortization's unscheduled TT83: the registry row's offset is the C-4.3-01 prose ("next business day 20:00 America/New_York
  // (`business_days_fannie_et`, 1)") and its satisfier names the LAR record ("`rate_payment.change` (TT83, unscheduled) submitted"); the
  // engine needs the grammar form of the same clock and 5.1's acknowledgement event (ops-5-1 recordSubmissionAck emits
  // `investor_events.submitted{event_type}`). Anchor `processed_at` is the timestamp ops.activateReamortizedTerms stamps on
  // `loan_terms.activated{reason=reamortization}` when the new `loan_terms` version is booked (example H: booked Tue 2026-10-20 → due
  // Wed 2026-10-21 20:00 ET). 2.4 owns this code; 5.1's `FNMA_IRM_LAR83_5BD_2000` (scheduled ARM changes, 5 BD after the scheduled
  // calculation date) is not the re-amortization clock — IRM 3-03 states no deadline for an unscheduled TT83.
  o("FNMA_C4301_LAR83_REAMORT_NEXTBD_2000", { trigger: "`loan_terms.activated{reason=reamortization}`", anchorField: "processed_at", offset: "next `business_days_fannie_et` BD 20:00 ET", satisfied: "`investor_events.submitted{event_type=rate_payment.change}`",
    why: "§2.4 timer table: `loan_terms.activated{reason=reamortization}` (new `loan_terms` version booked at execution) → next business day 20:00 America/New_York (`business_days_fannie_et`, 1) after `processed_at`, satisfied by `rate_payment.change` (TT83, unscheduled) submitted; Servicing Guide C-4.3-01: a transaction that is 'not a removal transaction' is reported 'by 8 p.m. eastern time on the next business day after the servicer processes the transaction in its system'; IRM 3-03 attaches its 5th-business-day clock only to the Scheduled rows." });
}
