/**
 * §3.8 timer overrides (process-owned; the §3 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 3.8 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * The facts named here are the ones ops-3-8.ts appends: `escrow.waiver.requested` (the case opened — the intake
 * recordWaiverRequest), `escrow.waiver.evaluating` (recordWaiverEvaluation, carrying the gate inputs `hpml_flag`,
 * `flood_escrow_mandatory`, `flood_line`, `borrower_paid_mi_monthly`), `escrow.waiver.decided` (approveWaiver /
 * recordWaiverDenial), `loan.anniversary` (minnesotaAnniversaryJob) and `escrow.waiver.trial_gate.cleared`
 * (trialOfferEscrowGate).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_3_8(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // 3.8 timer table: "`escrow_waiver` case opened" → anchor "request date" + 10 business_days_servicer; satisfied by `escrow.waiver.decided`.
  // The case-opened fact is `escrow.waiver.requested` (3.8 outputs: `loan_events`: `escrow.waiver.requested/decided/…`); its `requested_on` is the request date the SLA runs from even when the intake is recorded later.
  o("ESC_WAIVER_DECISION_SLA_10BD", { trigger: "`escrow.waiver.requested{case_type=escrow_waiver}`", anchorField: "requested_on", satisfied: "`escrow.waiver.decided`",
    why: "§3.8 timer table: `escrow_waiver` case opened (`escrow.waiver.requested`, request date `requested_on`) → decision within 10 business_days_servicer; satisfied by `escrow.waiver.decided`." });
  // 3.8 timer table: "waiver evaluation on `hpml_flag=true`" (5-year gate; the LTV gate's trigger is "same") — the evaluation fact carries `hpml_flag`.
  // State machine: `evaluating` → `approved` | `denied` — the gates close on the decision (`escrow.waiver.decided`).
  o("REGZ_1026_35B3_HPML_ESCROW_5Y_GATE", { trigger: "`escrow.waiver.evaluating{hpml_flag=true}`", satisfied: "`escrow.waiver.decided`",
    why: "§3.8 timer table: waiver evaluation on `hpml_flag=true` → not before `consummation_date` + 5 years (§1026.35(b)(3)); the evaluator 3.8.hpmlFiveYears is asserted by approveWaiver; the gate closes on the decision (state machine `evaluating` → `approved` | `denied`)." });
  o("REGZ_1026_35B3_HPML_LTV_GATE", { satisfied: "`escrow.waiver.decided`",
    why: "§3.8 timer table: trigger 'same' as the 5-year gate (`escrow.waiver.evaluating{hpml_flag=true}`); UPB < 80% of original value and not delinquent (§1026.35(b)(3)(ii)); closes on `escrow.waiver.decided`." });
  o("FLOOD_12CFR22_5_ESCROW_GATE", { satisfied: "`escrow.waiver.decided`",
    why: "§3.8 timer table: waiver evaluation with `flood_escrow_mandatory=true` and a flood line (`escrow.waiver.evaluating{flood_escrow_mandatory=true, flood_line=true}`) — flood line cannot be waived (12 CFR 22.5); closes on the (partial) decision." });
  o("FNMA_B101_MI_MONTHLY_ESCROW_GATE", { satisfied: "`escrow.waiver.decided`",
    why: "§3.8 timer table: waiver evaluation with monthly borrower-paid MI (`escrow.waiver.evaluating{borrower_paid_mi_monthly=true}`) — MI line cannot be waived (B-1-01); closes on the (partial) decision." });
  // 3.8 timer table: "borrower termination election" → "approval" — the election is the IL request (`escrow.waiver.requested{state=IL}`) and the approval is the platform's `escrow.waiver.decided`.
  o("STATE_IL_765ILCS910_5_TERMINATION_RIGHT_GATE", { satisfied: "`escrow.waiver.decided`",
    why: "§3.8 timer table: borrower termination election (`escrow.waiver.requested{state=IL}`) → balance ≤ 65% of original amount by timely payments, not in default, not gov-insured, HPML rules satisfied; satisfied by 'approval' — the decision fact `escrow.waiver.decided` (must approve when open, open question 1)." });
  // 3.8 timer table: satisfied by "`escrow.account.established` or `escrow.waiver.exception_documented`" — one satisfying pattern per code, so the
  // trial-offer gate records which of the two facts cleared it as `escrow.waiver.trial_gate.cleared{basis}` (trialOfferEscrowGate appends it right after the fact it cites).
  o("FNMA_B101_WAIVER_REVOKE_BEFORE_TRIAL_GATE", { satisfied: "`escrow.waiver.trial_gate.cleared{basis∈{escrow_established, exception_documented}}`",
    why: "§3.8 timer table: `lossmit.trial_plan.offer_prepared` → escrow established (or exception documented: current on T&I + Flex Mod); satisfied by `escrow.account.established` or `escrow.waiver.exception_documented` — recorded as `escrow.waiver.trial_gate.cleared{basis}` naming which fact cleared the gate (B-1-01; D2-3.2-06)." });
  // 3.8 timer table: "5th anniversary of the mortgage date" → anchor "anniversary" + 60 calendar_days; the anniversary job appends `loan.anniversary{years=5, anniversary}`.
  o("STATE_MN_47_20_DISCONTINUE_NOTICE_60", { trigger: "`loan.anniversary{years=5, of=mortgage_date}`", anchorField: "anniversary", satisfied: "`notice.sent{template=NTC_MN_47_20_9_DISCONTINUE_RIGHT}`",
    why: "§3.8 timer table: 5th anniversary of the mortgage date (`loan.anniversary{years=5, of=mortgage_date}`, anchor `anniversary`) + 60 calendar_days; satisfied by `NTC_MN_47_20_9_DISCONTINUE_RIGHT` sent — the notice service's `notice.sent{template}` (Minn. Stat. 47.20 subd. 9)." });
}
