/**
 * §5.2 timer overrides (process-owned; the §5 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 5.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * What 5.2 actually emits (src/domain/investor/ops-5-2.ts, through src/app/tools/section5-2.ts):
 * - one `investor_reporting_periods.opened{remittance_type, cycle}` per remittance cycle the servicer number carries
 *   (`openRemittancePeriod`), `remittance_type` ∈ {aa, sa, ss} as the data model's `remittance_calculations.remittance_type`
 *   and `cycle` ∈ {standard, rpm, mbs_express, sixth_day, mrs} as its `cycle` — so "period open (S/S standard/portfolio)",
 *   "(RPM pools)" and "(6th-day pools)" are `remittance_type=ss` with the cycle, never a made-up remittance type;
 * - `remittances.funded{remittance_type, cycle}` from the T−1 16:00 ET funding check (`fundDraft`, rule 7);
 * - `remittance_calculations.computed{basis, cycle, remittance_type, reporting, phase, accepted_at}` for every accepted
 *   5.1 event (Inputs: "each accepted payment/curtailment/reversal/removal event creates or adjusts
 *   `remittance_calculations` rows") — the 5.2-native fact for "detailed-reporting LAR accepted", "payment event accepted
 *   (auto-draft phase)" and "unscheduled principal collected (MBS Express)", which 5.2 learns of from the acceptance.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_5_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- Fannie Mae-initiated drafts: period open per cycle → funded at the T−1 16:00 ET funding check (rule 7)
  o("FNMA_F120_SS_DRAFT_CD18", { trigger: "`investor_reporting_periods.opened{remittance_type=ss, cycle=standard}`", anchorField: "ss_draft_on", satisfied: "`remittances.funded{remittance_type=ss, cycle=standard}`",
    why: "§5.2 timer table: 'period open (S/S standard/portfolio)' → CD18 (preceding `fannie_et` BD) with the funding check at −1 BD 16:00 ET, satisfied by '`remittances.funded` for all S/S codes' — the standard 18th cycle is `remittance_type=ss, cycle=standard` (data model `remittance_calculations.cycle`); 5.2-T1 Nov 18 draft → Tue Nov 17 16:00 ET." });
  o("FNMA_F120_SA_DRAFT_CD20", { trigger: "`investor_reporting_periods.opened{remittance_type=sa, cycle=standard}`", anchorField: "sa_draft_on", satisfied: "`remittances.funded{remittance_type=sa, cycle=standard}`",
    why: "§5.2 timer table: 'period open (S/A)' → CD20 (preceding BD), −1 BD 16:00 ET funding check, satisfied by `funded`; 5.2-T2 Dec 20, 2026 is Sunday → draft Fri Dec 18." });
  o("FNMA_F120_RPM_DRAFT_DESIGNATED", { trigger: "`investor_reporting_periods.opened{remittance_type=ss, cycle=rpm}`", anchorField: "designated_draft_date", satisfied: "`remittances.funded{remittance_type=ss, cycle=rpm}`",
    why: "§5.2 timer table: 'period open (RPM pools)' → designated date (preceding BD), −1 BD 16:00 funding check, satisfied by `funded`; RPM pools are S/S loans on cycle `rpm_<dd>` (data model), carried as `cycle=rpm` + `rpm_day`." });
  o("FNMA_F120_SS_6TH_POOL_CD5", { trigger: "`investor_reporting_periods.opened{remittance_type=ss, cycle=sixth_day}`", anchorField: "pool_draft_on", satisfied: "`remittances.funded{remittance_type=ss, cycle=sixth_day}`",
    why: "§5.2 timer table: 'period open (6th-day pools)' → CD5 = the funding check the BD before the CD6 draft (`periodAnchors.pool_draft_on` −1 BD 16:00 ET), satisfied by `funded`." });
  o("FNMA_F120_MBSX_UNSCHED_BD4", { trigger: "`remittance_calculations.computed{basis=curtailment, cycle=mbs_express}`", anchorField: "mbsx_bd4_on", offset: "−1 business_days_fannie_et, 16:00 ET", satisfied: "`remittances.funded{remittance_type=ss, cycle=mbs_express}`",
    why: "§5.2 timer table: 'unscheduled principal collected (MBS Express)' → BD4 of the month after collection, satisfied by `funded`. 5.2 learns of the collection from the accepted curtailment (Inputs: accepted events create `remittance_calculations` rows → `remittance_calculations.computed{basis=curtailment}`); the anchor is the BD4 draft date itself (`periodAnchors.mbsx_bd4_on` = 4th `fannie_et` BD, not 1st + 4 BD) and the deadline the funding check §Inputs schedules for every draft date: 'CD18/CD20/BD4/RPM/CD7 draft-date funding checks (T−1 16:00 ET)'." });
  // ---- A/A under LL-2026-05 and detailed reporting: the acceptance 5.2 sees is its own calculation row
  o("FNMA_F120_AA_DETAILED_48H", { trigger: "`remittance_calculations.computed{remittance_type=aa, reporting=detailed}`", anchorField: "accepted_at",
    why: "§5.2 timer table: 'detailed-reporting LAR accepted' (anchor accepted_at, 48 hours) → `drafted` observed; the accepted LAR reaches 5.2 as the `remittance_calculations` row it creates (Inputs), which carries `accepted_at` and the loan's summary/detailed flag (Operational prerequisites: boarded attribute 'summary/detailed flag')." });
  o("FNMA_LL202605_AA_AUTODRAFT_2BD", { trigger: "`remittance_calculations.computed{remittance_type=aa, phase=autodraft}`", anchorField: "accepted_at", offset: "+1 business_days_fannie_et, 16:00 ET",
    why: "§5.2 timer table (future): 'payment event accepted (auto-draft phase)' → '2 BD; funding check at +1 BD 16:00 ET', satisfied by `funded` — the deadline of the `funded` transition is the funding check (5.2-T5: processed Mon Nov 23 → draft Nov 25, funding gate Tue Nov 24 16:00 ET); the acceptance reaches 5.2 as its `remittance_calculations.computed{phase=autodraft}` row (`aaAutoDraftSchedule`)." });
}
