/**
 * §13.1 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters live in ./ops-13-1.ts (sweepDelinquencyCounters, sendReferral,
 * bankruptcyStayEnded) and src/domain/boarding/service.ts (`loan.boarded`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

const K2_REGISTRY_TRIGGER = "`loan.boarded{lossmit_application_incomplete=true, reasonable_date is not null}`";

export function applySatisfiedOverrides_13_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- REGX_1024_41F1_120_DAY_GATE: arms on the sweep that finds the loan newly delinquent; the evaluator (section override) keeps
  // governing `assertGateOpen`; the armed gate instance is satisfied the day the projection opens.
  o("REGX_1024_41F1_120_DAY_GATE", { trigger: "`delinquency.counters.updated{entered_delinquency=true, non_principal_residence=false}`", satisfied: "`foreclosure.gate.opened{code=REGX_1024_41F1_120_DAY_GATE}`", anchorField: "earliest_unpaid_due_date",
    why: "§13.1 timer table: trigger `delinquency.counters.updated` '(loan enters delinquency)' — the daily sweep (Inputs: 'Daily `delinquency.counters.updated` (00:05 loan timezone) recomputing `regx_days_delinquent`') and 1.7's boarding seed carry `entered_delinquency` on the run that first finds days > 0 (or a delinquent loan newly in scope) and `non_principal_residence`; the gate arms only within 1024.30(c)(2) scope (Scope: 'only apply to a mortgage loan that is secured by a property that is a borrower's principal residence'; state machine: '`not_applicable` (¬`regx_lossmit_scope`) — transitions to `closed`/`open` if occupancy becomes principal residence'; T3: '`REGX_1024_41F1_120_DAY_GATE=not_applicable`'); anchor 'earliest unpaid periodic due date' = `earliest_unpaid_due_date` on the same event; satisfied '`assertGateOpen` by `foreclosure.refer` … and `foreclosure.first_notice.authorize`' is the evaluator `13.1.preForeclosureReviewPeriodElapsed`, which passes from the day the projection emits `foreclosure.gate.opened{code}` (Outputs; rule 1: 'May 2, 2026 is the 121st day → open')." });
  // ---- FNMA_E1202_NONPR_REFER_BY_120: the registry's satisfied column parses to `foreclosure.referral.sent` (first backticked
  // expression); emitted by ops-13-1.ts sendReferral. Restated here so the provenance is on the def; the E-3.2-04 suspension
  // ladder is a suspension state (nonPrDeadlineLadder), not a satisfaction.
  o("FNMA_E1202_NONPR_REFER_BY_120", { satisfied: "`foreclosure.referral.sent`",
    why: "§13.1 timer table: satisfied by '`foreclosure.referral.sent`, **or** suspension under the E-1.2-02 BRP exception / E-3.2-04 ladder (rule 5)' — the referral event (E-1.2-02: foreclosure 'is considered to have begun on the date when the servicer refers the matter to a law firm'); a suspension writes a `foreclosure_deadline_suspensions` row and never satisfies the deadline (T3a/T3b)." });
  // ---- BK_362_STAY_GATE: the registry's satisfied column is the cross-reference '14.x'. The platform (14.1) spells the stay's
  // end as `bankruptcy.stay.terminated{reason ∈ discharge, dismissal, 362c3}` and `bankruptcy.stay.relief_effective{foreclosure_blocked=false}`;
  // 13.1 ingests those (ops-13-1.ts bankruptcyStayEnded — a discharge with lien avoidance is refused) and projects the gate open.
  o("BK_362_STAY_GATE", { satisfied: "`foreclosure.gate.opened{code=BK_362_STAY_GATE}`",
    why: "§13.1 timer table: `bankruptcy.petition.filed` → not-before gate 'until relief/dismissal/discharge without lien avoidance', satisfied by '14.x' — the 14.x stay-end events are validated by the 13.1 projection, which emits `foreclosure.gate.opened{code}` (Outputs: 'Events: `foreclosure.gate.opened{code}` … (each with an evaluation row)'; Edge cases: 'Bankruptcy: the stay gate is independent; days keep counting')." });
  // ---- REGX_1024_41K2_NO_FIRST_FILING_GATE (owned by 1.7; cross-referenced here and in 1.3): 1.3's `loan.boarded` payload
  // (src/domain/boarding/service.ts) carries the transferor's loss-mit state as `lossmit_in_process`, not the registry's
  // `lossmit_application_incomplete`/`reasonable_date`; the acknowledged reasonable date is a 12.x/1.7 fact the evaluator
  // `1.7.noFirstFilingBeforeReasonableDate` reads, so arming on every boarded loan with an in-process application is exact
  // for the gate (an evaluator-backed instance never breaches by itself). Applied only while the trigger is still the
  // registry spelling, so a 1.7 re-spelling of its own trigger is left alone.
  if (reg.get("REGX_1024_41K2_NO_FIRST_FILING_GATE")?.trigger === K2_REGISTRY_TRIGGER)
    o("REGX_1024_41K2_NO_FIRST_FILING_GATE", { trigger: "`loan.boarded{lossmit_in_process=true}`",
      why: "§13.1 timer table: trigger '`loan.boarded{incomplete app with reasonable date}`', anchor 'transferor reasonable date' (`transferor_reasonable_date`), satisfied by 1.3 — the boarded event spells the carried application as `lossmit_in_process` (1.3 tape `lossmit.in_process`); Edge cases: 'Transfer-in mid-delinquency (1.3): … K2 gate applies'." });
}
