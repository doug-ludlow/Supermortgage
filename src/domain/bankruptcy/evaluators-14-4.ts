/**
 * §14.4 gate evaluators, keyed "14.4.<name>". Every key must be named by an
 * `evaluator:` override in timers-14-4.ts and vice versa (src/app/app.test.ts checks both).
 *
 * `14.4.reaffirmationFinal` is also declared inline in src/app/evaluators.ts with the wrong
 * anchor (60 days after the discharge); this section map is spread after that literal, so the
 * definition below is the one the registry resolves for `SM_BK_CR_REAFFIRM_HOLD` and
 * `USC_524C4_REAFFIRM_RESCISSION`.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { rescissionWindowEnds } from "./ops-14-4.ts";

export const EVALUATORS_14_4: Record<string, Evaluator> = {
  /**
   * SM_BK_CR_REAFFIRM_HOLD (not_before_gate): "until `USC_524C4_REAFFIRM_RESCISSION` expiry" — the
   * later of the discharge and 60 days after the agreement was filed (11 U.S.C. §524(c)(4); 14.1
   * anchor "later of discharge_at or filed_at + 60 calendar_days"). CII stays A through the window's
   * last day (T5: filed 2026-11-20, discharge 2026-12-15 → 2027-01-19) and the row may become
   * `reaffirmed` (CII R) from the next day; a rescission inside the window yields V, never R.
   */
  "14.4.reaffirmationFinal": (f) => {
    const filed = s(f, "reaffirmation_filed_on"), disc = s(f, "discharge_on"), today = s(f, "today");
    if (!filed) return no("no reaffirmation filed — nothing to hold (11 U.S.C. §524(c)(4))");
    if (b(f, "rescinded")) return no("reaffirmation rescinded inside the §524(c)(4) window: CII V, never R");
    const ends = rescissionWindowEnds(filed as PlainDate, disc ? (disc as PlainDate) : null);
    return today > ends ? ok : no(`reaffirmation not final until the §524(c)(4) rescission window lapses on ${ends} (later of discharge${disc ? ` ${disc}` : ""} and 60 days after filing ${filed}); CII stays A`);
  },
};
export const kit_14_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
