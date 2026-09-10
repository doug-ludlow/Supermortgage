/**
 * §17.2 gate evaluators, keyed "17.2.<name>". Every key must be named by an
 * `evaluator:` override in timers-17-2.ts and vice versa (src/app/app.test.ts checks both).
 *
 * The only condition-shaped 17.2 row, `SM_XFER_OUT_FINAL_STATEMENT_GATE`, is named by the
 * section-level override in ./timers.ts and its evaluator
 * (`17.2.noStatementForCyclesOnOrAfterTransfer`: no statement for cycles with due dates ≥
 * `transfer_date`, 7.1) is registered in src/app/evaluators.ts; it is not duplicated here. It is
 * consulted by ops-17-2 finalStatementGate / statementCycleGate — the check the 7.1 statement
 * generator runs before rendering a statement for a loan on a transfer-out batch ("statement
 * generator refuses").
 * The other 17.2 rows are event-satisfied (see timers-17-2.ts), so this map stays empty.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";

export const EVALUATORS_17_2: Record<string, Evaluator> = {
};
export const kit_17_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
