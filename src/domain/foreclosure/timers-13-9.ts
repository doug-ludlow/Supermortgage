/**
 * §13.9 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.9 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Every trigger and satisfier the 13.9 rows name is appended by the 13.9 ops of `scra.case.get/open/close`
 * (src/app/tools/section13-9.ts through src/domain/foreclosure/ops-13-9.ts, delegated from the 13.8 block of
 * src/app/tools/section13.ts — 13.9 names no tools of its own in agents.json) — never a bare literal:
 *   scra.request.received{sufficient_evidence, received_on}                                   op=rate_request
 *   scra.rate_reduction.applied{mbs, activated_on, reduction_month_start, form_1022_bd_anchor_on}
 *     + scra.subsidy.activated{activated_on} + notice.sent{template=NTC_SCRA_3937_RATE_CONFIRMATION}
 *     + notice.sent{template=NTC_SCRA_3937_OVERPAYMENT_ELECTION}                              op=rate_activate
 *   form_1022.sent{channel}                                                                   op=form_1022_sent
 *   fnma.upload.accepted{kind=form_1022} · investor.event.accepted{kind=lar_83}               op=fnma_ack (inbound acknowledgement)
 *   arm.adjustment.scheduled{scra_cap_active=true, scheduled_on}                              op=arm_adjustment
 *   scra.subsidy.recalculated                                                                 op=subsidy_recalc
 *   custodial.receipt.matched{kind=scra_subsidy}                                              op=custodial_receipt (designated custodial account feed)
 *   scra.overpayment.election_recorded                                                        op=election / op=election_lapse
 *   scra.rate_reduction.ended                                                                 op=restore
 * `scra.period.started` / `scra.period.ended{ended_on}` are 13.8's own outputs (op=open / op=close of the same tool).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_9(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("SM_SCRA_RATE_ACTIVATE_5BD", { trigger: "`scra.request.received{sufficient_evidence=true}`", anchorField: "received_on", why: "§13.9 timer table: trigger '`scra.request.received` with sufficient evidence', anchor 'receipt' — rule 1: evidence = written notice + orders or a DMDC certificate / Form 180; `rateRequest` carries `sufficient_evidence` and `received_on`; a written assertion without evidence requests orders (T9) and arms no activation clock." });
  o("SCRA_3937B1_NOTICE_WINDOW_180", { satisfied: "`scra.request.received`", anchorField: "ended_on", why: "§13.9 timer table: 'request received' within 180 days after release (50 U.S.C. 3937(b)(1)); the row is informational — 'requests after the window still evaluated (policy: honour if service verified)' (T10), so a late request satisfies it late rather than being refused." });
  o("FNMA_F119_FORM1022_BD9", { trigger: "`scra.rate_reduction.applied{mbs=false}`", anchorField: "form_1022_bd_anchor_on", satisfied: "`form_1022.sent`", why: "§13.9 timer table: trigger 'rate reduction / payment change / restoration (portfolio, PFP)' — an MBS loan reports by upload (FNMA_F119_MBS_UPLOAD_CD15, `mbs=true`), so the BD9 email clock arms on `scra.rate_reduction.applied{mbs=false}` only; satisfied by '`form_1022_submissions.sent`' (the data-model row's `sent_at`) — the platform's event is the spec's own Outputs spelling `form_1022.sent/acknowledged`: `form_1022.sent{channel, due_by, message_id}` from op=form_1022_sent. Anchor: F-1-19 'no later than the ninth business day of the month' following the reduction — BD9 counts the month's first business day as day 1, so the engine's exclusive business-day step starts from the last calendar day of the reduction month (`form_1022_bd_anchor_on`; 13.9-T5: October 2026 BD9 = 2026-10-14, Columbus Day excluded)." });
  o("FNMA_F119_MBS_UPLOAD_CD15", { anchorField: "reduction_month_start", why: "§13.9 timer table: anchor 'month', offset CD15 — 'no later than the 15th calendar day of the month' following the reduction (F-1-19); `scra.rate_reduction.applied{mbs=true}` carries `reduction_month_start` (the first day of the activation month) so CD15 of the following month is the due date (13.9-T5: 2026-10-15). Satisfied by `fnma.upload.accepted{kind=form_1022}` — the investor-reporting system's acknowledgement ingested by op=fnma_ack." });
  o("FNMA_F119_ARM_TXN83", { anchorField: "scheduled_on", why: "§13.9 timer table: anchor 'adjustment' — `arm.adjustment.scheduled{scra_cap_active=true, scheduled_on}` from op=arm_adjustment (rule 3: each scheduled adjustment during the cap reports the applicable rate via Transaction 83); satisfied by `investor.event.accepted{kind=lar_83}` from op=fnma_ack (5.1 acknowledgement)." });
  o("FNMA_F119_SUBSIDY_ADJUST_12M", { anchorField: "activated_on", why: "§13.9 timer table: anchor 'activation' — `scra.subsidy.activated{activated_on}` from op=rate_activate under the Interest Subsidy method (decision 13.9-1); satisfied by `scra.subsidy.recalculated` from op=subsidy_recalc ('adjusted at least annually', F-1-19), which re-arms the recurring row." });
  o("FNMA_D23401_RATE_CONFIRMATION_LETTER_5BD", { anchorField: "activated_on", satisfied: "`notice.sent{template=NTC_SCRA_3937_RATE_CONFIRMATION}`", why: "§13.9 timer table: satisfied by '`notice.sent{NTC_SCRA_3937_RATE_CONFIRMATION}`' — the platform's `notice.sent` carries the template code as `template` (src/notices/service.ts); op=rate_activate sends the D2-3.4-01 written correspondence ('the new payment amount, the date it becomes effective, and the date it will be discontinued') at activation. Anchor 'activation' = `activated_on` on `scra.rate_reduction.applied`." });
  o("SM_SCRA_OVERPAYMENT_ELECTION_30", { trigger: "`notice.sent{template=NTC_SCRA_3937_OVERPAYMENT_ELECTION}`", anchorField: "sent", why: "§13.9 timer table: trigger '`scra_overpayment_elections.pending`', anchor 'letter sent' — the pending election is opened by the election letter (NTC_SCRA_3937_OVERPAYMENT_ELECTION, sent at activation when the recalculation shows an overpayment); the platform's `notice.sent` carries `template` and `sent`. Satisfied by `scra.overpayment.election_recorded` (op=election); at lapse op=election_lapse applies the default election (decision 13.9-3) and records it." });
}
