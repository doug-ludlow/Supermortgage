/**
 * §15.1 gate evaluators, keyed "15.1.<name>". Every key must be named by an
 * `evaluator:` override in timers-15-1.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, s, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { postSalePreservationAllowed, reogramEditWindow } from "./ops-15-1.ts";

export const EVALUATORS_15_1: Record<string, Evaluator> = {
  /**
   * FNMA_E4301_PRESERVATION_STOP — facts: acquirer, sale_completed, tps_completed, sf_cpm_directed. Open = a preservation work
   * order may be placed. A closing gate refuses by omission: missing `sale_completed`/`acquirer` facts (or an unknown acquirer on
   * a completed sale) are not an open gate — the gate closes on `reo_cases` creation (rule 6, E-4.3-01).
   */
  "15.1.postSalePreservationAllowed": (f) => {
    if (f.sale_completed === undefined || f.sale_completed === null) return no("sale_completed fact is required — the preservation gate closes on reo_cases creation (E-4.3-01)");
    const acquirer = s(f, "acquirer");
    if (b(f, "sale_completed") && acquirer !== "fannie_mae" && acquirer !== "third_party") return no(`acquirer fact is required on a completed sale (got "${acquirer}") — preservation ceased at the sale (E-4.3-01)`);
    const r = postSalePreservationAllowed({ acquirer: acquirer === "fannie_mae" || acquirer === "third_party" ? acquirer : null, sale_completed: b(f, "sale_completed"), tps_completed: b(f, "tps_completed"), sf_cpm_directed: b(f, "sf_cpm_directed") });
    return r.allowed ? ok : no(r.reason ?? "preservation stopped at the sale (E-4.3-01)");
  },
  /** FNMA_P360_REOGRAM_EDIT_WINDOW_5BD — facts: confirmed_on, today. Open = the confirmed case's fields are still editable in Property 360. */
  "15.1.reogramEditWindowOpen": (f) => {
    const confirmedOn = s(f, "confirmed_on"), today = s(f, "today");
    if (!confirmedOn || !today) return no("confirmed_on and today are required");
    const w = reogramEditWindow(confirmedOn as PlainDate, today as PlainDate);
    return w.open ? ok : no(`P360 edit window closed ${w.ends_on} (5 BD after confirmation) — route edits to SF CPM through a human`);
  },
};
