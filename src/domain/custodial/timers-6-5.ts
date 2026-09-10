/**
 * §6.5 timer overrides (process-owned; the §6 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 6.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters are src/domain/custodial/ops-6-5.ts (unclaimed-property track and the
 * weekly register) and `suspense.read/write` / the return rails in src/app/tools/section06.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_6_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Anchor column: "cycle end (June 30 default)"; offset: "file before Nov 1"; satisfied: "`unclaimed_property.reported` + remitted".
  // presumeAbandoned carries `cycle_end_on` (June 30 of the cycle whose Jul 1–Jun 30 window contains presumed_abandoned_on, rule 7),
  // so the Nov 1 computed from it is the cycle's filing date (2029-06-30 → 2029-11-01, worked example C); reportUnclaimedProperty
  // emits `unclaimed_property.reported{remitted=true}` only with the remittance — a report filed without remitting does not satisfy.
  o("STATE_UUPA_REPORT_NOV1", { anchorField: "cycle_end_on", satisfied: "`unclaimed_property.reported{remitted=true}`", why: "§6.5 timer table: anchor 'cycle end (June 30 default)', 'file before Nov 1', satisfied by '`unclaimed_property.reported` + remitted' — rule 7: report_cycle = the cycle whose window (July 1–June 30) contains presumed_abandoned_on; report_due_on = Nov 1 of that cycle year." });
  // STATE_UUPA_DORMANCY_3Y: trigger `unclaimed_property.item_opened{dormancy_start_on}` (openUnclaimedPropertyItem), anchor
  // `dormancy_start_on`, satisfied by `unclaimed_property.reported` (reportUnclaimedProperty) — the registry row parses as is.
  // STATE_UUPA_DUE_DILIGENCE_NOTICE_60_180: the section's override (anchor `filing_date`, `notice.sent{template=UP-DUE-DILIGENCE-v1}`)
  // matches what sendDueDiligenceNotice emits on the item; presumeAbandoned carries `filing_date` (= report_due_on).
  // SM_SUSPENSE_REGISTER_WEEKLY: weeklyRegisterTick emits the section's `schedule.tick{cadence=weekly, weekday=monday, at=06:00}`;
  // reviewSuspenseRegister emits `suspense.register.reviewed`, which satisfies and re-arms the recurring row.
}
