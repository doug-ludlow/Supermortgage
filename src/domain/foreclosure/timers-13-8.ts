/**
 * §13.8 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.8 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Every trigger and satisfier the 13.8 rows name is appended by a tool handler (src/app/tools/section13-8.ts through
 * src/domain/foreclosure/ops-13-8.ts, called from the 13.8 block of src/app/tools/section13.ts) — never a bare literal:
 *   scra.case.opened / scra.period.started / scra.stay.granted / scra.relief.started   scra.case.get/open/close{op=open}
 *   scra.period.ended                                                                   op=close
 *   scra.case.closed{reason=tail_expired} + foreclosure.gate.opened{code, reason}        the tail sweep (op=get / any gated command)
 *   scra.relief.ended{plus_one_cycle=true}                                              the relief-cycle sweep (op=get)
 *   contact.scra.status_check (+ scra.contact.completed{kind=status_check})             op=contact
 *   scra.affidavit.filed                                                                op=affidavit_filed
 *   judgment.reopen.decided                                                             op=judgment_reopen (attorney)
 *   foreclosure.first_notice.authorize.requested / firm.dispositive_motion.proposed{judicial} / eviction.referral.requested{eviction_referral_on}
 *                                                                                       dmdc.batch.prepare{records} (inbound attorney-network / eviction records)
 *   dmdc.verification.completed{purpose} + scra.status.verified{purpose, result, post_judgment_on_duty, service_end_date}
 *                                                                                       dmdc.results.import
 * `foreclosure.referral.sent` (SM_DMDC_PERIODIC_ACTIVE_FC_90) and `prereferral.review.started` (SM_DMDC_VERIFY_PRE_REFERRAL_30)
 * are 13.3's and 13.4's own outputs — armed by those processes' tools, satisfied here by `dmdc.results.import{purpose=periodic}`
 * and by `scra.status.verified`.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_8(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("SCRA_3931_AFFIDAVIT_GATE", { satisfied: "`scra.affidavit.filed`", why: "§13.8 timer table: satisfied by '`scra_affidavits.filed`' — the data-model row's `filed_at`; the platform's event is the spec's own Outputs spelling `scra.affidavit.executed/filed`: `scra.affidavit.filed{affidavit_id, filed_at, filed_by_firm_id, document_id, motion_instruction_released=true}` from `scra.case.get/open/close{op=affidavit_filed}` (the firm's filing evidence; 13.8-T5 'motion instruction released only after filing evidence'). The trigger stays `firm.dispositive_motion.proposed{judicial=true}` from the section override — a §3931 affidavit is a judicial requirement ('in any civil action or proceeding … in which the defendant does not make an appearance')." });
}
