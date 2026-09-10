/**
 * §10.6 timer overrides (process-owned; the §10 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 10.6 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_10_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Emitters: src/domain/pmi/ops-10-6.ts `requestHumanReview` (trigger, `request_date` = the borrower's request date) and
  // `completeHumanReview` (satisfier, carries the outcome letter's document id).
  o("SM_MI_HUMAN_REVIEW_10BD", { anchorField: "request_date", satisfied: "`mi.human_review.completed{outcome_letter_document_id is not null}`",
    why: "§10.6 timer table: trigger '`mi.human_review.requested`' anchored on 'request date' (payload `request_date`), 10 `business_days_servicer`; satisfied by '`mi.human_review.completed` + response letter' — the column grammar drops the letter, so the satisfier requires the outcome letter's document id (R4: 'whose outcome letter either upholds (restating grounds) or reverses'; 10.6-T8 'closed within 10 BD with an outcome letter')." });
}
