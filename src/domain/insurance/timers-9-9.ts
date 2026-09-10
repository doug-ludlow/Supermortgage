/**
 * §9.9 timer overrides (process-owned; the §9 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 9.9 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters are src/domain/insurance/ops-9-9.ts (called by the 9.9 tools in
 * src/app/tools/section09.ts: `reviewCompletion` ingests the vendor's posting / completion reports, `orderWork` and
 * `prepareBid` record the discovered conditions), 9.8's updateOccupancy (`property.vacancy_confirmed{ftv_date}`) and
 * 15.2's HomeTracker / milestone / claim pipeline (`preservation.bid.*`, `claim.milestone.reached{milestone_date}`,
 * `expense_claim.status_changed{status=submitted}`). src/kernel/events/match.ts compares conditions as exact strings on
 * payload fields, so every conditioned field below is one those emitters carry; the registry's prose anchors
 * ("posting expiry", "discovery", "install date", "milestone") parse to nothing and would otherwise anchor on the
 * event's own date.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_9_9(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- "with a posted vacancy notice, within 7 calendar days of the notice's expiration and still within 14 days of FTV" — satisfied by 'initial completed', the same `preservation.initial.completed` the INITIAL_SECURE_14 row names
  o("FNMA_PPM_POST_NOTICE_SECURE_7", { anchorField: "expires_on", satisfied: "`preservation.initial.completed`", why: "§9.9 timer table: trigger `preservation.posting.placed`, anchor 'posting expiry', 7 calendar_days '(and ≤ FTV + 14)', satisfied by 'initial completed' — ops-9-9 postingPlaced carries `expires_on` and refuses a posting expiring after FTV + 7 (state machine: '`posted` (optional vacancy posting; expiry ≤ FTV + 7)'), so expiry + 7 never passes FTV + 14; the completion is workCompleted's `preservation.initial.completed` (securing + initial services), the event the FNMA_PPM_INITIAL_SECURE_14 row names for the same milestone." });
  // ---- PPM §4: broken windows / exterior doors "within the 14 days, then within 3 days of discovery" — only an opening found after initial securing runs the 3-day clock
  o("FNMA_PPM_WINDOW_DOOR_REPAIR_3", { trigger: "`preservation.condition.discovered{item=unsecured_opening, after_initial_securing=true}`", anchorField: "discovered_on", why: "§9.9 timer table: trigger 'unsecured window/door discovered after initial securing', anchor 'discovery', 3 calendar_days — ops-9-9 conditionDiscovered carries `item`, `after_initial_securing` and `discovered_on` (an opening found before securing is part of the 14-day initial scope); satisfied by 'repair/clear-board completed' = workCompleted's `preservation.work.completed{item=unsecured_opening}`." });
  // ---- "grass > 12″ discovered after the initial service → bids within 15 calendar days of discovery" (12–36″ complete and BATF on the same clock)
  o("FNMA_PPM_YARD_REBID_15", { anchorField: "discovered_on", why: "§9.9 timer table: anchor 'discovery', 15 calendar_days — ops-9-9 conditionDiscovered's `preservation.condition.discovered{item=grass_over_12in}` carries `discovered_on` (T5: 40″ → stop and bid; 20″ → complete and BATF); satisfied by 15.2's HomeTracker ingestion `preservation.bid.submitted{item=yard}`." });
  // ---- "tarps not > 60 days" — the tarp installation is a completed work item; the permanent repair is another
  o("FNMA_PPM_ROOF_TARP_60", { anchorField: "completed_on", why: "§9.9 timer table: trigger 'tarp installed', anchor 'install date', 60 calendar_days — workCompleted's `preservation.work.completed{item=roof_tarp}` carries `completed_on` (T8: tarp 2027-04-01 → permanent repair or re-bid by 2027-05-31); satisfied by `preservation.work.completed{item=roof_repair}` ('permanent repair completed/approved')." });
  // ---- F-1-05: "claims within 60 days of milestones (15.2)" — the 15.2 pipeline files the claim
  o("FNMA_F105_PRESERVATION_CLAIM_60", { anchorField: "milestone_date", satisfied: "`expense_claim.status_changed{status=submitted}`", why: "§9.9 timer table: trigger 'milestone', anchor 'milestone', 60 calendar_days, satisfied by 'claim filed' — 15.2's `claim.milestone.reached` (ops-15-2 milestoneReached) carries `milestone_date` and the platform spells the filing as `expense_claim.status_changed{status=submitted}` (section15-2 submitClaim op=record_upload; the milestone claim carries the preservation lines at the F-1-05 caps or the approved HomeTracker bid)." });
}
