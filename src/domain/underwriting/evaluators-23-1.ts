/**
 * §23.1 gate evaluators, keyed "23.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-23-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   23.1.finalMatchGate      FNMA_B3_2_10_DU_FINAL_MATCH_GATE — facts: `is_final`, `closed_loan_snapshot_hash` (the final
 *                            findings hash), `recommendation`, `current_closing_hash` (ops-23-1.ts finalMatchFacts builds them
 *                            from the last du_submissions row and the CD-final / ULDD closing snapshot).
 *   23.1.returnFileTypeGate  FNMA_DU_RETURN_FILE_16_17_RETIRE — facts: `built_on` (request build date), `return_file_types[]`;
 *                            closed for types 16/17 from Dec 1, 2026.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { finalMatchGate, returnFileTypeGate } from "./ops-23-1.ts";

export const EVALUATORS_23_1: Record<string, Evaluator> = {
  "23.1.finalMatchGate": (f) => { const r = finalMatchGate(f); return r.open ? ok : no(r.reason ?? "closed"); },
  "23.1.returnFileTypeGate": (f) => { const r = returnFileTypeGate(f); return r.open ? ok : no(r.reason ?? "closed"); },
};
export const kit_23_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
