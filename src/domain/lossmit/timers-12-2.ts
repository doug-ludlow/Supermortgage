/**
 * §12.2 timer overrides (process-owned; the §12 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 12.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The events named here are appended by the 12.2 `lossmit.evaluation.*` ops,
 * `timers.*` op=lapse and the denial branch of `notice.render_send` (src/app/tools/section12-2.ts over
 * src/domain/lossmit/ops-12-2.ts); src/kernel/events/match.ts compares payload fields as exact strings.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_12_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("REGX_1024_41C4_THIRD_PARTY_REQUEST_PROMPT", { trigger: "`lossmit.evaluation.started{third_party_items=true}`", anchorField: "started_on", satisfied: "`integration_messages.sent{kind=third_party_request, items_remaining=0}`",
    why: "§12.2 timer table: `lossmit.evaluation.started` with third-party items → 2 `business_days_servicer` to place requests, satisfied by `integration_messages.sent` *for each item* — op=third_party_request emits one outbox message per outstanding item and refuses a partial batch, so the last one (`items_remaining=0`) is the satisfier (§1024.41(c)(4)(i); comment 41(c)(4)(i)-1 'request promptly')." });
  o("SM_LM_REVIEWER_DENIAL_APPROVAL_2BD", { anchorField: "drafted_on",
    why: "§12.2 timer table: `lossmit.evaluation.decision_drafted{has_denial}` anchored at 'draft time' → `lossmit.evaluation.reviewed` (rule 6 reviewer gate). op=draft emits the trigger with `drafted_on` and the policy-tightened `review_due` (1 BD if <10 days remain on the 30-day clock; never past the 30-day date); op=review emits the satisfier." });
  o("REGX_1024_41E2II_TRIAL_OTHER_REQS_REASONABLE", { trigger: "`lossmit.trial.first_payment_received{other_acceptance_items_missing=true}`", anchorField: "payment_date", satisfied: "`lossmit.offer.acceptance_items.received{items_remaining=0}`",
    why: "§12.2 timer table: first trial payment received but other acceptance items missing → 14 `calendar_days` from the payment date, satisfied by 'items received' — op=acceptance_items_received emits per batch with the count still outstanding; only the batch that clears the list is appended as `.received` (a partial batch is `.partial`), so the row is satisfied only once every item is in (§1024.41(e)(2)(ii); rule 8 acceptance by payment). The trigger payload carries both `other_acceptance_items_missing` and `acceptance_items_missing` (the ./timers.ts and timers-12-8.ts spellings)." });
  o("FNMA_D2101_FORM182_ADVERSE_ACTION_30", { anchorField: "decided_on", satisfied: "`notice.sent{template=NTC_REGB_1002_9_LM_ADVERSE_ACTION}`",
    why: "§12.2 timer table: `smdu.case.decisioned{declined, borrower_current}` (op=smdu_decision ingests the adapter callback with both flags) anchored on the decision date → `notice.sent{NTC_REGB_1002_9_LM_ADVERSE_ACTION}` — the Notice Registry spells the template as `template`; the 'or accepted counteroffer' leg cancels the clock with a reason (D2-1-01 Form 182 within 30 days; 12.2-T6)." });
  o("CA_CIV_2923_6E_NOD_NOS_HOLD_31", { trigger: "`lossmit.denial.provided{state=CA}`", anchorField: "provided_at",
    why: "§12.2 timer table: 'CA denial provided' anchored on the denial date → 31 `calendar_days` NOD/NOS gate (Cal. Civ. Code §2923.6(e)). The Notice Registry's `notice.sent` carries only {notice_id, template, channels, sent_at}, so the 12.2 denial send emits `lossmit.denial.provided{state, provided_at, template}`; 'timer lapse' is recorded by `timers.*` op=lapse as `timer.lapsed{code=CA_CIV_2923_6E_NOD_NOS_HOLD_31}` (13.x refuses NOD/NOS until then; 12.2-T10)." });
}
