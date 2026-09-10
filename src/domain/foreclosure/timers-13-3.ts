/**
 * §13.3 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.3 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. Every event named here is appended by src/domain/foreclosure/ops-13-3.ts
 * (`ReferralLifecycle`), reached from the §13 tools through src/app/tools/section13-3.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_3(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // ---- state pre-foreclosure notices: the registry writes `notice.sent{NTC_…}` (the template as a bare condition); the
  //      platform's notice event carries the template code in `template` (src/notices/service.ts, 11.x, 16.x) and the
  //      13.3 mailing carries `mailed_on` — the statutory anchor ("mailing date").
  o("STATE_NY_RPAPL1306_DFS_FILING_3BD", { trigger: "`notice.sent{template=NTC_STATE_PREFC_NY_1304}`", anchorField: "mailed_on", satisfied: "`state.filing.completed{kind=ny_dfs_1306}`", why: "§13.3 timer table: `notice.sent{NTC_STATE_PREFC_NY_1304}` (mailing date) → §1306 DFS filing +3 business_days_servicer, satisfied by `state.filing.completed{ny_dfs_1306}` — the platform's notice event carries the template in `template` and the 13.3 mailing its `mailed_on`; the filing receipt (decision 13.3-5 `human_portal_task{kind=ny_dfs_1306}`) is recorded as `state.filing.completed{kind}` (RPAPL §1306 'within three business days of the mailing' — condition precedent)." });
  o("STATE_NJ_FFA_NOI_STALE_180", { trigger: "`notice.sent{template=NTC_STATE_PREFC_NJ_NOI}`", anchorField: "mailed_on", why: "§13.3 timer table: `notice.sent{NTC_STATE_PREFC_NJ_NOI}` (mailing date) +180 calendar_days → a new NOI is required and the gate re-closes unless `foreclosure.first_notice.filed` (the complaint) lands first — N.J.S.A. 2A:50-56 'at least 30 days, but not more than 180 days' before filing; the notice event carries `template` and `mailed_on`." });
  // ---- E-3.5-02 insurance cancellation: "later of sale.completed / sale.confirmed" — 13.3 Outputs name the sale event
  //      `foreclosure.sale.completed`; ops-13-3 `recordSaleCompleted` emits it once the later of completion and
  //      confirmation is known and puts that date in `insurance_cancel_anchor_on`.
  o("FNMA_E3502_INSURANCE_CANCEL_14", { trigger: "`foreclosure.sale.completed`", anchorField: "insurance_cancel_anchor_on", why: "§13.3 timer table: 'later of `sale.completed` / `sale.confirmed`' (anchor 'event') +14 calendar_days → `insurance.cancellation.requested` (9.x) — the canonical 13.3 Outputs event is `foreclosure.sale.completed`; in a confirmation state it is recorded at confirmation and `insurance_cancel_anchor_on` is the later of the two dates (E-3.5-02 'within 14 days of the later of sale completion or confirmation'; inspections continue until then)." });
}
