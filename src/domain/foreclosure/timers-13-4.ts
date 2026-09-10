/**
 * §13.4 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.4 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters live in ./ops-13-4.ts (called by the 13.4 tools in
 * src/app/tools/section13.ts) and in the §12 tools for the E-3.2-04 ladder's 12.x triggers.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // The registry column says "delinquency reaches `referral_required_on − 15`"; the 11.1 counter's `loan.delinquency.day_reached`
  // milestones are fixed days (16 … 120) and never carry the window, so the platform spells the trigger as the 13.4 scheduler event.
  o("FNMA_E3201_PREREFERRAL_REVIEW_15", { trigger: "`prereferral.review.due`", anchorField: "referral_required_on", why: "§13.4 Inputs and triggers: \"Scheduler: `prereferral.review.due` fired at `referral_required_on − 15 calendar days` … also re-fired whenever an input changes inside the window\" (ops-13-4 reviewDue); window [−15, 0] anchored on `referral_required_on` (E-3.2-01: \"within 15 days prior to the date the servicer is required to refer\")." });
  // `lossmit.offer.sent{retention}` — the 12.x offer event carries `kind`, `option` (F-2-10 retention path) and `principal_residence`, not a `retention` flag.
  o("FNMA_E3204_NONPR_OFFER_14", { trigger: "`lossmit.offer.sent{kind=offer, option∈{forbearance, repayment_plan, payment_deferral, flex_mod}, principal_residence=false}`", anchorField: "provided_at", why: "§13.4 timer table: `lossmit.offer.sent{retention}` on a non-principal residence — E-3.2-04: a retention offer (incl. a Trial Period Plan) → \"must delay the foreclosure referral up to 14 days to allow the borrower to respond\"; the 12.x event spells the retention options as `option` (src/domain/lossmit/evaluation.ts RETENTION_PATH) and the residence as `principal_residence`; anchored on the offer date `provided_at`." });
  // "completion / determination" anchor: the completed event carries the completion date (ops-13-4 completeReview).
  o("FNMA_D1301_DISASTER_FC_REQUEST_5", { anchorField: "completed_on", why: "§13.4 timer table: anchor \"completion / determination\" — `prereferral.review.completed{disaster_impacted=true, completed_on}` (rule 2: \"the review is 'complete' for the 5-day clock even though referral is held\"; D1-3-01: \"within five days after completing the prereferral review\"), satisfied by `disaster_fc_approval_requests.submitted` (ops-13-4 submitDisasterFcRequest)." });
}
