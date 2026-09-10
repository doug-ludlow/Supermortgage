/**
 * §12.9 timer overrides (process-owned; the §12 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 12.9 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts.
 *
 * The six rows below keep the patterns ./timers.ts already set; each override records which 12.9 code path
 * (src/domain/lossmit/ops-12-9.ts, reached through the `liquidation.case.*` inbound ops in
 * src/app/tools/section12-9.ts) appends the event, so the registry's `overrideWhy` names the emitter.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_12_9(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  o("FNMA_F114_SS_VALUATION_10", { satisfied: "`valuation.received`", why: "§12.9 timer table: `valuation.ordered` → `valuation.received` within 10 calendar days (F-1-14: results typically within 10 calendar days). Emitted by ops-12-9 `recordValuationReceived` (op=valuation_received) after matching the SMDU/BPO result to its `valuation.ordered{valuation_id}`." });
  o("FNMA_D23301_SS_CLOSE_60", { satisfied: "`closing.funds.received`", why: "§12.9 timer table: `shortsale_offers.decision=approved` → `closing.funds.received` within 60 calendar days; breach 'expire approval unless Fannie Mae extension' (D2-3.3-01). Emitted by ops-12-9 `recordClosingFundsReceived` (op=funds_received), which also moves a late, unextended case to `expired{next=re_evaluate}` (12.9-T5)." });
  o("FNMA_D23302_DIL_INSPECTION_60", { satisfied: "`inspection.report.received`", why: "§12.9 timer table: `dil.accepted` (no interior BPO ≤90 days) → `inspection.report.received` within 60 calendar days (D2-3.3-02). Emitted by ops-12-9 `recordInspectionReport` (op=inspection_received) with vacancy/security, broom-swept and hazard findings (12.9-T7)." });
  o("FNMA_D23302_DIL_DEED_BEFORE_SALE_30", { trigger: "`foreclosure.sale_scheduled{dil_case_open=true}`", why: "§12.9 timer table: scheduled sale/docket date → executed deed received ≥30 calendar days before, else Fannie Mae prior approval (D2-3.3-02; 12.9-T8). The 12.9 event is re-stated from the platform's `foreclosure.sale.scheduled` (13.x/15.x) by ops-12-9 `recordForeclosureSaleScheduled` (op=sale_scheduled / `attachSaleScheduleListener`) with `dil_case_open` and the deed cut-off." });
  o("FNMA_D23302_DIL_RELOCATION_30", { satisfied: "`relocation.disbursed`", why: "§12.9 timer table: executed deed accepted (non-transition) → `relocation.disbursed` within 30 calendar days (D2-3.3-02). Emitted by ops-12-9 `disburseRelocation` (op=relocation_disbursed) under the no-relocation-with-contribution guardrail (12.9 rule 3)." });
  o("CA_CIV_2924_11C_RESCIND_NOD", { satisfied: "`foreclosure.nod.rescinded`", why: "§12.9 timer table: CA short sale approved with proof of funds → rescission recorded / sale cancelled promptly (policy 5 BD) (Cal. Civ. Code §2924.11(c); 12.9-T10). Emitted by ops-12-9 `recordNodRescinded` (op=nod_rescinded) from counsel's/e-recording's confirmation." });
}
