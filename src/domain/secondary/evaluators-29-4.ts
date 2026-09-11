/**
 * §29.4 gate evaluators, keyed "29.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-29-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   29.4.warehouseReleaseByAcquisition  FNMA_C2_2_03_WAREHOUSE_RELEASE_BY_ACQUISITION_GATE — facts: `release_effective_on` (27.1/27.2's
 *                                       `warehouse.bailee_letter.released{effective}` / `warehouse.secured_party.released{effective_date}`), `purchase_date`, `proceeds_received`.
 *   29.4.enoteTransferSameDay           FNMA_C1_2_04_ENOTE_TRANSFER_SAME_DAY_GATE — facts: `edelivered`, `effective_date`, `request_date`, `master_servicer_org_id`, `sm_org_id`, `accepted`.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { enoteTransferGate, warehouseReleaseGate } from "./ops-29-4.ts";

const wrap = (g: (f: Record<string, unknown>) => { open: boolean; reason?: string }): Evaluator => (f) => { const r = g(f); return r.open ? ok : no(r.reason ?? "closed"); };
export const EVALUATORS_29_4: Record<string, Evaluator> = {
  "29.4.warehouseReleaseByAcquisition": wrap(warehouseReleaseGate),
  "29.4.enoteTransferSameDay": wrap(enoteTransferGate),
};
export const kit_29_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
