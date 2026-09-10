/**
 * §8.1 timer overrides (process-owned; the §8 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 8.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Conventions (src/kernel/events/match.ts holds ONE dotted pattern per column; conditions are exact string compares
 * on payload fields):
 * - `loan.boarded` is appended by the 1.1 boarding service (src/domain/boarding/service.ts) with the batch loan's
 *   `fdcpa_debt_collector_flag` (= `default_status_at_boarding`); the 8.1/8.3 rows spell it `fdcpa_debt_collector`,
 *   so the trigger is re-spelled to the field the event actually carries;
 * - the annual Reg V review is recorded by `recordPolicyReview` in ./ops-8-1.ts, which appends
 *   `credit.policy.reviewed{reviewed_on, next_review_due, signed_by, signed_by_role}` after the officer gate — the
 *   row's "last review" anchor is that event's `reviewed_on`.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_8_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- FDCPA pre-furnishing gate (Reg F §1006.30(a))
  o("FDCPA_1006_30A_PRE_FURNISH_GATE", {
    trigger: "`loan.boarded{fdcpa_debt_collector_flag=true}`",
    why: "§8.1 timer table: trigger '`loan.boarded` with `fdcpa_debt_collector=true` (11.4)'; 8.3 rule 8: 'For loans boarded in default (`fdcpa_debt_collector=true`, 11.4): `omit_account` until `contact.live` … or a validation notice/letter is mailed … and 14 calendar days pass with no undeliverability notice; the gate opens automatically on the event'. The 1.1 boarding service appends `loan.boarded` with the batch loan's `fdcpa_debt_collector_flag` (= `default_status_at_boarding`, src/domain/boarding/service.ts), so the trigger conditions on the field the event carries; the gate stays 'until `fdcpa.furnishing_gate.opened`' (11.4's fdcpa.ts emits it on a conversation or 14 days after mailing) and `buildCycle` applies `omit_account` while it is closed (ops-8-1.ts `fdcpaGateState` reads the gate from the loan's events).",
  });
  // ---- annual Reg V §1022.42(c) policy review
  o("SM_METRO2_ANNUAL_POLICY_REVIEW_365", {
    anchorField: "reviewed_on",
    why: "§8.1 timer table: trigger `credit.policy.reviewed`, anchor 'last review', offset 12 `months`, satisfied by the next `credit.policy.reviewed`, breach 'escalate `officer` (Reg V §1022.42(c))'; Reg V §1022.42(c): 'review and update periodically'; human touchpoints: '`officer` signs the annual Reg V policy review'. `recordPolicyReview` (ops-8-1.ts) refuses any signer but an `officer` and appends `credit.policy.reviewed{reviewed_on, next_review_due, signed_by, signed_by_role=officer, policy_version, program_document_id}` — the row anchors on `reviewed_on` (the review date, not the event's wall-clock date).",
  });
}
