/**
 * §13.5 timer overrides (process-owned; the §13 section-level overrides in ./timers.ts run first and these win the
 * merge — see src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied |
 * evaluator, anchorField?, offset?, why })` per 13.5 registry row whose trigger/satisfied column names an event the
 * platform spells differently or a condition the column grammar drops; `why` quotes the spec. Wired by
 * src/domain/timer-overrides.ts. The emitters live in ./ops-13-5.ts (TimeframeTracker) and, for the 5.4
 * acknowledgment, in src/domain/investor/ops-5-1.ts.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_13_5(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // "month-end status change" → anchor "period end" → BD2: the tracker's month-end review appends `period.month_end{foreclosure_status_changed=true, period_end}`;
  // the satisfying "accepted status event" is 5.4's acknowledgment, which the platform spells `investor_events.accepted{family=delinquency}` (ops-5-1.ts acceptEvent — spec 13.5 Inputs: "5.4 reporting acknowledgments (`investor_events{delinquency.status}` accepted/rejected) — a credit is only 'earned' if the code was reported timely and accepted").
  o("FNMA_F121_STATUS_CODE_TIMELY_BD2", { anchorField: "period_end", satisfied: "`investor_events.accepted{family=delinquency}`", why: "§13.5 timer table: trigger 'month-end status change', anchor 'period end', satisfied 'accepted status event' (F-1-21) — the 5.4 acknowledgment is `investor_events.accepted{family=delinquency}` (13.5 Inputs: investor_events{delinquency.status} accepted/rejected)." });
  // "comp_fee_bills.received" / anchor "receipt": the Connect bill ingestion appends `comp_fee_bill.received{received_on, receipt}` — the bill's receipt date, not the ingestion instant.
  o("SM_COMP_FEE_BILL_REBUTTAL_30", { anchorField: "received_on", why: "§13.5 timer table: anchor 'receipt' = comp_fee_bills.received_at (the bill's receipt date carried as `received_on` on `comp_fee_bill.received`); +30 calendar days [UNVERIFIED Fannie Mae window]; satisfied by the officer-signed rebuttal (`documents.bundle{submit}` → `comp_fee_bill.resolved{result=rebutted}`) or acceptance (`acceptBill` → `result=accepted`)." });
}
