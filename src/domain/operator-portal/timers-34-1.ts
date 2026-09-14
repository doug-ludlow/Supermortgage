/**
 * §34.1 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 34.1 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it. Wired by src/domain/timer-overrides.ts.
 *
 * Emitter: src/runtime/staff/auth.ts staffAccessReview (the `staff.access.review` tool, src/app/tools/section34-1.ts) appends
 * `staff.access_review.completed{review_id, reviewed_by, reviewed_at, users, changes, origination: true}` on the global subject
 * (aggregate staff_access_review) — every `staff.*` payload carries `origination: true` so the section-34 clock arms (the kernel
 * arms section ≥ 20 clocks on origination-context events only). The other 34.1 events (`staff.invited`, `staff.enrolled`,
 * `staff.signed_in`, `staff.signed_out`, `staff.role.changed`, `staff.disabled`, `staff.signin.locked`) arm nothing.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_34_1(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table row 1: the quarterly access review is a recurring clock on the platform (global) subject — armed by a completed review, satisfied by the next, re-armed 90 days out (the pattern of 33.2's SM_PARTNER_BOOK_REVIEW_DAILY / 20.1's SM_REFI_TRIGGER_DAILY).
  o("SM_STAFF_ACCESS_REVIEW_90", { anchorField: "reviewed_at", offset: "+90 calendar_days", subject: "global",
    why: "§34.1 timer table: recurring on `staff.access_review.completed`, anchor `reviewed_at`, offset '+90 calendar_days', satisfied by `staff.access_review.completed`, breach 'sev 3 → `compliance` (the quarterly access review is late)' — 'Key deadlines: the access review every 90 calendar days'; Verified requirement: 'Privileges are the roles below, reviewed every 90 days (SM_STAFF_ACCESS_REVIEW_90, 19.2's own cadence) with the review recorded' (16 CFR §314.4(c)(1); 23 NYCRR §500.7). The receipt is one global event per review (staffAccessReview appends `staff.access_review.completed{reviewed_at}` on the staff_access_review aggregate, no loan), so the clock is the PLATFORM's, not a loan's: armed on the global subject (subject: \"global\") by a completed review, satisfied by the next review and re-armed 90 calendar days out; the sweep's breach pass opens one `compliance` escalation when no review completed in time (T8; edge cases: 'sessions keep working (the control is the review, not a lock-out)')." });
}
