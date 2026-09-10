/**
 * §10.2 timer overrides (process-owned; the §10 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 10.2 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * Emitters (src/domain/pmi/ops-10-2.ts, dispatched from the §10 tools in src/app/tools/section10.ts):
 *   `loan.became_current{became_current_on, mi_auto_status=deferred_not_current}` — the subsequent review of a deferred policy;
 *   `mi.ltv_snapshot{state, ltv_bps, snapshot_date}` — the nightly LTV snapshot (section override in ./timers.ts already
 *     narrows NY_INS_6503D_STOP_PREMIUM_75 to `state=NY, ltv_bps<=7500`; the emitter carries both fields);
 *   `mi.original_value.missing{boarded_at}` — the boarding check for a policy without an evidenced original value;
 *   `investor_events.accepted{event_type=mi.discontinuance}` — LSDU feedback for the queued LAR 89 (5.1's
 *     FNMA_IRM_LAR89_PERIOD_END is 5.1-owned and not redefined here; `mi.terminated`/`mi.cancelled` carry its
 *     `lar89_action_code` trigger field and `period_end_date` anchor).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_10_2(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("HPA_4902B2_CURE_TERMINATE_1ST", { trigger: "`loan.became_current{mi_auto_status=deferred_not_current}`", anchorField: "became_current_on",
    why: "§10.2 timer table: trigger '`loan.became_current` while `deferred_not_current`' — only the subsequent review of a policy the sweep deferred emits `loan.became_current{became_current_on, mi_auto_status}` (R3: 'became_current_on = first date on which no installment is past due'; B-8.1-04 'terminate the MI immediately if the borrower's payments are current at the time of a subsequent review'); anchor 'cure date'; offset 'first day of the next month' (12 U.S.C. 4902(b)(2)); satisfied by `mi.terminated` (Scenario B: cure 2035-07-20 → effective 2035-08-01)." });
  o("SM_MI_ORIGINAL_VALUE_MISSING_60", { trigger: "`mi.original_value.missing`", anchorField: "boarded_at",
    why: "§10.2 timer table: trigger '`loan.boarded` with MI and null original value' — §1.1's `loan.boarded` carries neither the MI record nor `original_value_cents`, so the pmi agent's boarding check (`pmi.schedule.rebuild` op `board`) emits `mi.original_value.missing{boarded_at}` for exactly those policies (prerequisites: '`original_value_cents` populated with evidence … missing values create escalation `MI_ORIGINAL_VALUE_MISSING` with a 60-day SLA'); anchor `boarded_at`; 60 calendar days; satisfied by `mi.original_value.set` (the evidence-backed `pmi.*` set_original_value)." });
}
