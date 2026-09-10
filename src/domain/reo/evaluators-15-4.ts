/**
 * §15.4 gate evaluators, keyed "15.4.<name>". Every key must be named by an
 * `evaluator:` override in timers-15-4.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { salePackageReleaseGate, type ServicingOption } from "./ops-15-4.ts";

const SERVICING_OPTIONS: ReadonlySet<string> = new Set(["special", "regular_mbs", "portfolio"]);

export const EVALUATORS_15_4: Record<string, Evaluator> = {
  /**
   * FNMA_E3501_MBS_REMOVAL_BEFORE_FCL (not_before_gate): a regular servicing option MBS loan must be repurchased or
   * reclassified before the foreclosure completes (E-3.5-01; A1-3-06). Facts: `servicing_option`
   * (special | regular_mbs | portfolio), `repurchase_or_reclass_accepted`, `sale_at`. Closed ⇒ the sale-package release is
   * blocked and an `officer` escalation opens (15.4-T7). Fails closed: a missing or unknown `servicing_option` blocks too —
   * the gate never opens on a loan whose servicing option was not boarded (1.1).
   */
  "15.4.mbsRemovedBeforeSale": (f) => {
    const raw = s(f, "servicing_option");
    const option = SERVICING_OPTIONS.has(raw) ? (raw as ServicingOption) : null;
    const saleOn = (s(f, "sale_at") || s(f, "sale_on") || "9999-12-31").slice(0, 10) as PlainDate;
    const g = salePackageReleaseGate({ servicing_option: option, repurchase_or_reclass_accepted: b(f, "repurchase_or_reclass_accepted"), sale_on: saleOn });
    return g.blocked ? no(g.reason ?? "E-3.5-01: sale-package release blocked; officer escalation") : ok;
  },
};
export const kit_15_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
