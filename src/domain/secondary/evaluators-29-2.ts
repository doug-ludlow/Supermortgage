/**
 * §29.2 gate evaluators, keyed "29.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-29-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   29.2.coverageBand   SM_HEDGE_COVERAGE_BAND_GATE — facts: `coverage_ratio` (or `hedge_face_cents`, `duration_factor`,
 *                       `expected_deliverable_cents`), `coverage_band_low`, `coverage_band_high` (defaults 0.85 / 1.10).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { coverageBandGate } from "./ops-29-2.ts";

const wrap = (g: (f: Record<string, unknown>) => { open: boolean; reason?: string }): Evaluator => (f) => { const r = g(f); return r.open ? ok : no(r.reason ?? "closed"); };
export const EVALUATORS_29_2: Record<string, Evaluator> = {
  "29.2.coverageBand": wrap(coverageBandGate),
};
export const kit_29_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
