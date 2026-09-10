/**
 * §12.1 timer overrides (process-owned; the §12 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 12.1 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every trigger and satisfier named here is appended to the event store by a real code
 * path: the 12.1 `lossmit.application.open/update` paths in src/app/tools/section12-1.ts (through the validating
 * functions in ./ops-12-1.ts) and the Notice Service (src/notices/service.ts), never by a bare literal.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_12_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- Cal. Civ. Code §2924.10: one acknowledgment clock per document received on a §2924.15 loan
  o("CA_CIV_2924_10_ACK_5BD", { trigger: "`lossmit.document.received{state=CA, section_2924_15=true}`", anchorField: "received_on", satisfied: "`notice.sent{template=NTC_CA_2924_10_ACK}`",
    why: "§12.1 timer table: trigger 'any `lossmit.document.received` on a CA §2924.15 loan', anchor 'receipt', satisfied by `notice.sent{NTC_CA_2924_10_ACK}` — the 12.1 `lossmit.application.open/update{op=document}` receipt (ops-12-1 `documentReceipt`) carries `state`, `section_2924_15` (Cal. Civ. Code §2924.15: owner-occupied principal-residence first liens) and `received_on`, so a document on any other loan arms nothing (12.1-T10: 'each of three separate uploads on a CA loan receives an acknowledgment'); the Notice Service spells the template code in `template` (src/notices/service.ts). The row's '5 `business_days` (state calendar `state:CA`)' runs on the servicer calendar — the kernel defines no state calendar (business.ts DAY_UNITS)." });
  // ---- 3 NYCRR 419.7(d): the NY acknowledgment clock arms only for NY loans (the section satisfier's `state=NY` condition sits on `notice.sent`, which the Notice Service never stamps with a state)
  o("NY_419_7D_ACK_5BD", { trigger: "`lossmit.application.received{state=NY}`", anchorField: "received_date", satisfied: "`notice.sent{template∈{NTC_REGX_41B2_ACK_COMPLETE, NTC_REGX_41B2_ACK_INCOMPLETE}}`",
    why: "§12.1 timer table: trigger '`lossmit.application.received` (NY)', anchor 'receipt', 5 `business_days_servicer`, satisfied by 'ack notice with NY content' (3 NYCRR 419.7(d)) — the 12.1 `lossmit.application.open/update` receipt carries `state` and `received_date` (src/app/tools/section12.ts), so a non-NY application never arms (and can never breach) this clock; the NY content is the jurisdiction overlay on the same `NTC_REGX_41B2_ACK_COMPLETE`/`_INCOMPLETE` templates ('NY adds DFS complaint text and counselor list'), and the Notice Service's `notice.sent{template}` carries no state, so the satisfier is the template pair alone." });
  // ---- §1024.41(k)(2)(i): the transferee's 10-day acknowledgment — armed by the 12.1 carry-over intake of the transferor's file
  o("REGX_1024_41K2_TRANSFEREE_ACK_10", { trigger: "`transfer.in.completed{lossmit_pending=true, ack_not_sent=true, lossmit_ack_unexpired=true}`", anchorField: "transfer_date",
    why: "§12.1 timer table: trigger '`transfer.in.completed{lossmit_pending, ack_not_sent}`', anchor 'transfer date', 10 `business_days_federal`, '1.7 owns; listed for completeness'; §12.1 Inputs: '`transfer.in.completed{lossmit_pending}` (1.7) → carry-over intake with transferor dates preserved (§1024.41(k))'; edge case 'Transfer-in mid-application (1.7): transferor dates carry; if the transferor sent no ack, `REGX_1024_41K2_TRANSFEREE_ACK_10`'. §1.7's spelling `loan.boarded{lossmit ack unexpired & not sent}` cannot be emitted by boarding — the tape schema (src/domain/boarding/types.ts `lossmit`) carries no acknowledgment facts — so the 12.1 `lossmit.application.open/update{op=carryover}` intake (ops-12-1 `carryoverIntake`) reads the transferor's lossmit file, decides `ack_not_sent` and `lossmit_ack_unexpired` (§1024.41(k)(2)(i): the transferor's 5-day period had not expired at the transfer date; comment 41(k)(1)(i)-3: a notice the transferor sent is not re-sent) and appends this event with `transfer_date`; a lapsed-unsent period makes the transferee newly subject to (b)(2) (`lossmit.application.received{received_date=transfer_date}`) instead." });
}
