/**
 * §9.8 timer overrides (process-owned; the §9 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 9.8 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters are src/domain/insurance/ops-9-8.ts (called by the 9.8 tools in
 * src/app/tools/section09.ts and by the inbound vendor / Fannie Mae feeds this process consumes); the trigger events
 * other sections own are 13.x/15.x `foreclosure.sale.scheduled{sale_at}` and 15.2 `claim.milestone.reached{kind,
 * milestone_date}`. src/kernel/events/match.ts compares conditions as exact strings on payload fields, so every
 * conditioned field below is one those emitters carry; the anchor fields are ISO dates in the same payloads (the
 * registry's prose anchors — "earliest unpaid due date", "sale date", "suspicion", "milestone" — parse to nothing and
 * would otherwise anchor on the event's own date, which is 90/120 days late for the day-count rows).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_9_8(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- rule 1: "fnma_days_delinquent = today − earliest_unpaid_due_date … due date 2026-11-01 unpaid → day 90 = 2027-01-30 (order allowed), day 120 = 2027-03-01 (complete by)"
  o("FNMA_D2210_INSPECT_ORDER_DAY90", { anchorField: "earliest_unpaid_due", why: "§9.8 timer table: anchor 'earliest unpaid due date', +90 calendar_days — inspectionSweep's `delinquency.day90.reached` carries `earliest_unpaid_due`, so the gate opens on day 90 (T1: 2027-01-30), not 90 days after the day-90 event." });
  o("FNMA_D2210_INSPECT_COMPLETE_DAY120", { anchorField: "earliest_unpaid_due", why: "§9.8 timer table: anchor 'earliest unpaid due date', +120 calendar_days — 'complete the initial inspection no later than the 120th day of delinquency' (T1: 2027-03-01); satisfied by the first `property.inspection.completed` recordInspectionResult appends from the vendor's Form 30 result." });
  // ---- D2-2-10: inspections "must occur between 20 and 35 days apart" — the initial completion starts the cadence; every later completion satisfies the window and re-arms it from its own completed_at
  o("FNMA_D2210_INSPECT_RECUR_20_35", { trigger: "`property.inspection.completed{initial=true}`", why: "§9.8 timer table: trigger `property.inspection.completed`, anchor completed_at, next between +20 and +35 calendar_days, satisfied by 'next completion' — the row is recurring, so only the initial completion (recordInspectionResult marks the loan's first result `initial=true`) arms it; each later completion satisfies and re-arms the window from its completed_at instead of arming a duplicate." });
  // ---- vacant/abandoned: "monthly interior inspections regardless of QRPC" — anchored on the certified vacancy inspection, re-armed from each interior inspection's date
  o("FNMA_D2210_VACANT_INTERIOR_MONTHLY_35", { anchorField: "inspected_on", why: "§9.8 timer table: anchor 'last interior', +35 calendar_days max — updateOccupancy's `property.vacancy_confirmed` carries `inspected_on` (the certified vacancy inspection) and every `property.inspection.completed` carries `inspected_on` too, so the re-armed row counts from the last interior inspection (T3: vacancy 2027-02-10 → interior by 2027-03-17)." });
  // ---- "inspect as soon as possible after learning of possible vacancy" — policy: 3 servicer business days from the suspicion
  o("FNMA_D2210_VACANCY_INSPECT_ASAP_3BD", { anchorField: "suspected_on", why: "§9.8 timer table: anchor 'suspicion', 3 business_days_servicer — suspectVacancy's `property.vacancy_suspected` carries `suspected_on` (returned mail, utility shut-off notice, neighbor call, code notice, inspection result)." });
  // ---- E-3.3-03: "a final inspection within 35 days prior to the foreclosure sale date" — window −35 … −1 from the sale date carried by 13.x/15.x `foreclosure.sale.scheduled{sale_at}`
  o("FNMA_E3303_PRESALE_INSPECT_35", { anchorField: "sale_at", satisfied: "`property.inspection.completed{purpose=pre_sale_35}`", why: "§9.8 timer table: anchor 'sale date' (the platform's `foreclosure.sale.scheduled` carries `sale_at`, ops-15-4 saleScheduled / section15-3), window between −35 and −1 calendar_days, satisfied by '`property.inspection.completed` kind pre_sale_35' — recordInspectionResult spells the kind as `purpose` (T4: sale 2027-06-15 → window 2027-05-11 … 2027-06-14)." });
  // ---- PFPIP: "servicers submit loans at 90 days delinquent" — SLA 2 servicer business days after day 90 (T5: day 90 on Saturday 2027-01-30 → task due Tuesday 2027-02-02)
  o("FNMA_P360_PFPIP_SUBMIT_DAY90", { trigger: "`delinquency.day90.reached{pfpip_eligible=true}`", anchorField: "day90_on", offset: "2 business_days_servicer", why: "§9.8 timer table: trigger '`delinquency.day90.reached` (eligible loan)' — inspectionSweep carries `pfpip_eligible` (rule 2: conventional first lien, enrolled, not Lender-Risk/recourse, not rejected; T6 recourse loans arm nothing here); anchor 'earliest unpaid due date', '+90 calendar_days (SLA: within 2 business_days_servicer after)' — the event carries `day90_on` = earliest_unpaid_due + 90, so the deadline is the SLA the row states (T5: 'reaching day 90 on a Saturday → PFPIP submission task due within 2 business days' = 2027-02-02); satisfied by submitPfpip's `p360.pfpip.submitted`." });
  // ---- "Any changes made in Investor Reporting also need to be updated in the Pre-Foreclosure Program via Property 360" — 2 BD from the change date
  o("FNMA_P360_PFPIP_STATUS_SYNC_2BD", { anchorField: "changed_on", why: "§9.8 timer table: anchor 'change date', 2 business_days_servicer — pfpipChangeReported's `loan.status.reported_to_fnma` carries `changed_on` and `pfpip_enrolled` (T3: vacancy 2027-02-10 → PFPIP occupancy updated by 2027-02-12); satisfied by updatePfpip's `p360.pfpip.updated`." });
  // ---- rule 7: "servicer-ordered inspections on delinquent loans claimed at ≤ $30/$45/$60 caps via 15.2 within 60 days of the milestone" — the 15.2 pipeline files the claim
  o("FNMA_F105_INSPECTION_CLAIM_60", { anchorField: "milestone_date", satisfied: "`expense_claim.status_changed{status=submitted}`", why: "§9.8 timer table: anchor 'milestone', 60 calendar_days, satisfied by 'claim filed' — 15.2's `claim.milestone.reached` carries `milestone_date` and the platform spells the filing as `expense_claim.status_changed{status=submitted}` (section15-2 submitClaim: the milestone claim carries the inspection lines inspectionClaimLines sizes at the F-1-05 caps; T9: reinstatement 2027-04-01 → file by 2027-05-31)." });
}
