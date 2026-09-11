/**
 * §21.5 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 21.5 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 * The events named here are appended by src/domain/application/ops-21-5.ts (`ToleranceService`).
 *
 * Grammar conventions (src/kernel/events/match.ts holds ONE dotted pattern per column):
 * - the 3-day clock's satisfier is "a revised LE delivered or mailed … or the CD / corrected CD carrying the revised
 *   estimate when a revised LE is barred": both routes end in the state transition `changed_circumstance.reflected
 *   {reflected_on∈{le, cd, corrected_cd}}`, appended by deliverRevisedLE (route le) and by the 25.2 CD events the
 *   service consumes (routes cd / corrected_cd), so that one event is the satisfier; `disclosure.le.revised` itself is
 *   still emitted (it arms the 4-SBD gate and satisfies 21.4's lock clock with `reason=rate_lock`);
 * - the 4-SBD row is condition-shaped (receipt + 4 specific business days; the CD bar) → an evaluator, satisfied by the
 *   spec's own `gate.revised_le_4sbd.opened`;
 * - the 60-day row's "refund **and** corrected CD" conjunction is one `tolerance.refund.completed` appended only when
 *   both duties are recorded (or trivially, when the window closes with no excess);
 * - the cure-review SLA's "`compliance-sentinel` review recorded" is `tolerance.cure.reviewed{reviewer_role}`.
 * `REGZ_1026_37A13_COSTS_EXPIRE_10BD` is 21.2's (the 21.5 row is a reference); no override here.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_21_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("REGZ_1026_19E4_REVISED_LE_3BD", { trigger: "`changed_circumstance.recorded{valid=true, basis∈{A1, A2, A3, B, C, E, F}}`", anchorField: "information_received_on", offset: "+3 business_days_creditor", satisfied: "`changed_circumstance.reflected{reflected_on∈{le, cd, corrected_cd}}`",
    why: "§21.5 timer table: trigger '`changed_circumstance.recorded{valid=true}` for basis A, B, C, E, F (basis D uses 21.4's `REGZ_1026_19E3IVD_LOCK_REVISED_LE_3BD`)', anchor '`information_received_at` date, creditor time zone' (the payload carries `information_received_on`, the creditor's civil date, next to the instant), offset '+3 `business_days_creditor`, end of day' — §1026.19(e)(4)(i) 'within three business days of receiving information sufficient to establish that one of the reasons for revision … applies' (general business days; `revisedLeDueAt` states 23:59 in the creditor's own zone); satisfied by '`disclosure.le.revised` delivered or mailed with `revision_reason_cc_ids ∋ cc_id`; or `disclosure.cd.delivered`/`disclosure.cd.corrected` (25.2) carrying the revised estimate when a revised LE is barred' — `deliverRevisedLE` appends `changed_circumstance.reflected{reflected_on=le}` per carried row and the consumed CD events append it with `reflected_on=cd|corrected_cd`; breach: `onRevisedLeBreached` withdraws the reset (the original baseline governs), sev 1 to compliance-sentinel + officer, incident record; the revised disclosure still issues." });
  o("REGZ_1026_19E4_REVISED_LE_4SBD_GATE", { trigger: "`disclosure.le.revised`", anchorField: "deemed_receipt_date", evaluator: "21.5.revisedLeFourDayGate", satisfied: "`gate.revised_le_4sbd.opened`",
    why: "§21.5 timer table: 'not_before_gate (on `consummate`) and bar (on `issueRevisedLE`)', trigger 'every `disclosure.le.revised` (gate) / `disclosure.cd.delivered` (bar)', anchor 'revised LE `effective_receipt_date` (actual evidence or delivery + 3 `business_days_regz_specific`)' — the presumptive date rides on the trigger event as `deemed_receipt_date`; receipt evidence (`recordReceipt`) moves the evaluator's facts earlier — 'earliest consummation = receipt date + 4 `business_days_regz_specific`; bar: no revised LE on or after the CD delivery date' (§1026.19(e)(4)(ii) both sentences); condition-shaped: `assertGateOpen` (26.x) through `revisedLeFourDayGate`, the bar through `fourDayRule` in renderRevisedLE / deliverRevisedLE (refused and logged as `disclosure.le.revised.refused`, routed to 25.2); `setReceipt` / `openGateIfDue` append the spec's `gate.revised_le_4sbd.opened{effective_receipt_date, earliest_consummation_date}` when the gate opens." });
  o("REGZ_1026_19F2V_TOLERANCE_REFUND_60", { anchorField: "consummation_on", offset: "+60 calendar_days", satisfied: "`tolerance.refund.completed`",
    why: "§21.5 timer table: trigger '`closing.consummated` when a post-consummation `tolerance_tests.status='refund_required'` exists (created at consummation, satisfied trivially if no excess)', anchor '`consummation_at` date' (the consumed event carries `consummation_on`; the service derives it from the instant in the creditor zone otherwise), offset '+60 `calendar_days`' — §1026.19(f)(2)(v) refund 'no later than 60 days after consummation' and corrected disclosures 'no later than 60 days after consummation'; satisfied by '`tolerance.refund.issued` (funds sent) **and** 25.2's corrected CD delivered/mailed (`disclosure.cd.corrected{reason='tolerance_refund'}`)' — two duties, one satisfier: `ToleranceService` appends `tolerance.refund.completed{refund_sent=true, corrected_cd_delivered=true}` only once `issueRefund` has run and the consumed `disclosure.cd.corrected{reason=tolerance_refund}` is recorded, or `{no_excess_found=true}` from `closeRefundWindow` when no refund_required test exists; breach: sev 1 to the partner officer, refund still issued, incident + QC self-identification (28.2)." });
  o("SM_TOLERANCE_CURE_REVIEW_SLA_1BD", { trigger: "`tolerance.test.completed{status=escalated}`", anchorField: "run_on", offset: "+1 business_days_creditor", satisfied: "`tolerance.cure.reviewed{reviewer_role=compliance-sentinel}`",
    why: "§21.5 timer table: trigger '`tolerance.test.completed{status='escalated'}`' (a cure above `rule_sets.cure_review_threshold_cents`, default $500 — the cure still posts; the review is root-cause), anchor `run_at` (the payload carries `run_on`, its creditor civil date), '+1 `business_days_creditor`', satisfied by '`compliance-sentinel` review recorded' — `recordCureReview` appends `tolerance.cure.reviewed{reviewer_role=compliance-sentinel, outcome}`; breach: closing is not blocked; review overdue is a governance metric." });
}
