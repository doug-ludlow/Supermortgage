/**
 * §1.7 timer overrides (process-owned; the §1 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 1.7 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Rows the section file (./timers.ts) already spells for 1.7 and the emitters honour verbatim: the `loan.boarded{…}`
 * triggers (fields written by src/domain/transfers/ops-1-7.ts inflightBoardingFacts through BoardingService.board),
 * the `notice.sent{template∈…}` satisfiers (12.1–12.3 notice pairs), `lossmit.offer.closed{outcome∈…}`
 * (section1-7.ts honorTransferorOffer / ops-1-7.ts expireTransferorOffer), `lossmit.appeal_window.closed{outcome∈…}`
 * (ops-1-7.ts closeAppealWindow), `smdu.case.accessible` (ops-1-7.ts smduCaseAccessChecked) and the two evaluator gates.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_1_7(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- first-filing gate: armed only on an incomplete application that carries the transferor's reasonable date — the field the
  // timer anchors on (`transferor_reasonable_date`), written onto `loan.boarded` by ops-1-7.ts inflightBoardingFacts through
  // BoardingService.board. Spelled here by the owning process so the 13.1 cross-reference's stand-in (timers-13-1.ts, which arms on
  // every `lossmit_in_process` loan while the trigger is still the registry spelling) does not widen it.
  o("REGX_1024_41K2_NO_FIRST_FILING_GATE", { trigger: "`loan.boarded{lossmit_application_incomplete=true, transferor_reasonable_date is not null}`", anchorField: "transferor_reasonable_date",
    why: "§1.7 timer table: trigger `loan.boarded{incomplete app with reasonable date}`, anchor '`transferor_reasonable_date` (or Supermortgage's, if it sends the ack)', +1 calendar day; 1.7-T5: 'Given an incomplete application with a transferor reasonable date of Oct. 24, then a `foreclosure.referral` command on Oct. 20 is refused … and allowed on Oct. 25' — a complete application (1.7-T2) or one with no acknowledged reasonable date has no gate to arm; Supermortgage's own acknowledgment is read by ops-1-7.ts foreclosureReferralGate from `notice.sent{template=NTC_REGX_41B2_ACK_INCOMPLETE}`." });
  // ---- file verification: the T-0 clock is armed on the batch-scoped lossmit tape, so its closer is the batch roll-up of the per-case checks.
  o("SM_LOSSMIT_FILE_VERIFY_T0", { satisfied: "`lossmit.carryover.verified{all_cases=true}`",
    why: "§1.7 timer table: trigger `transfer.tape.received{kind=lossmit}` (subject = the transfer batch), satisfied by '`lossmit.carryover.verified` per case' — every inherited case of the tape must pass CO-01…CO-10 (state machine: `inherited_pending` → `file_verified` (all `CO-*` pass)); ops-1-7.ts verifyBatchCarryover emits the per-case events and, once no case is `file_deficient`, the batch-level `lossmit.carryover.verified{all_cases=true}` on the same subject the timer was armed on." });
}
