/**
 * §22.3 gate evaluators, keyed "22.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-22-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { continuance3y, type ContinuanceBasis } from "./ops-22-3.ts";

/**
 * FNMA_B3_3_1_01_CONTINUANCE_3Y (B3-3.1-01): `continuance_end_date ≥ scheduled_note_date + 3 years` where a defined end exists; sources with no
 * expiration and a documented history, and Social Security on the borrower's own record, are likely to continue. Facts: scheduled_note_date (PlainDate),
 * continuance_end_date (PlainDate | null), continuance_basis (no_expiration | documented_3y | retirement_own_record | n_a). The reason names the dates
 * so the written exclusion (22.5) can quote them; it never cites the nature of the income (Reg B §1002.6(b)).
 */
export const EVALUATORS_22_3: Record<string, Evaluator> = {
  "22.3.continuance3y": (f) => {
    const note = s(f, "scheduled_note_date"); if (!note) return no("continuance: scheduled_note_date is required to test three years from the note date");
    const endRaw = f.continuance_end_date; const end = typeof endRaw === "string" && endRaw ? D(endRaw) : null;
    const basis = (s(f, "continuance_basis") || (end ? "documented_3y" : "no_expiration")) as ContinuanceBasis;
    if (basis === "n_a") return no("continuance: not documented (B3-3.1-01: the lender must document that the income is expected to continue for at least three years from the note date)");
    const r = continuance3y(end, D(note), basis);
    return r.pass ? ok : no(r.reason ?? "continuance: ends before note date + 3 years");
  },
};
export const kit_22_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
