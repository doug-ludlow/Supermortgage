/**
 * §16.3 gate evaluators, keyed "16.3.<name>". Every key must be named by an `evaluator:` override in this
 * section's timers (src/app/app.test.ts checks both directions over the aggregate map).
 *
 * The two 16.3 gate rows are evaluator-backed by the section-level timers.ts: `SM_LPOA_RECORDED_GATE` →
 * "16.3.lpoaRecordedForState" (facts `{ lpoa_status }`, derived from the `lpoas` rows for the state by
 * ops-16-3.ts lpoaGate and asserted by routeForExecution before execution under LPOA — the aggregate map's
 * own entry is kept) and `SM_RELEASE_PENALTY_NONPASS_GATE` → "16.3.penaltyNeverPassedThrough" (facts
 * `{ penalty_charge_target }`, asserted by computePenaltyExposure op=post before any penalty posting).
 *
 * "16.3.penaltyNeverPassedThrough" is defined *here* so the section map — spread after the aggregate's inline
 * entries in src/app/evaluators.ts — is the registered implementation: the gate closes on every target the
 * spec forbids (F-1-09: "must not pass on to the borrower or to Fannie Mae any penalty fee"; registry row:
 * "penalty accounts never map to borrower or Fannie Mae claims"), i.e. ops-16-3.ts PENALTY_FORBIDDEN_TARGETS
 * (borrower, loan, fnma, fannie_mae, fnma_claim, f105_claim), not only `borrower` and `fnma_claim`; and only
 * `corporate_expense` opens it — an unknown target is closed, not open by default.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { PENALTY_FORBIDDEN_TARGETS } from "./ops-16-3.ts";

export const EVALUATORS_16_3: Record<string, Evaluator> = {
  "16.3.penaltyNeverPassedThrough": (f) => {
    const target = s(f, "penalty_charge_target");
    if ((PENALTY_FORBIDDEN_TARGETS as readonly string[]).includes(target)) return no(`release penalties never map to borrower or Fannie Mae claims (F-1-09): charge_target=${target}`);
    return target === "corporate_expense" ? ok : no(`release penalties post only as corporate expense (Dr release_penalty_expense); charge_target=${target || "(none)"}`);
  },
};
export const kit_16_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
