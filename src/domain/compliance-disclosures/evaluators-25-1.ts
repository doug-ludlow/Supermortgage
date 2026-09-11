/**
 * §25.1 gate evaluators, keyed "25.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-25-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   25.1.gateOpen — the six SM_O61_COMPLIANCE_PASS_*_GATE rows: "gate_open(checkpoint) = ∀ t ∈ tests(checkpoint):
 *                   t.result ∈ {pass, warn, not_applicable} ∨ (t.blocking = false) ∨ (t.waiver_id ≠ null ∧ definition.waivable)";
 *                   an `error` result (missing APOR, NMLS unreachable) blocks like a failure. Facts: `tests[]` (the run's
 *                   compliance_tests rows: test_code, result, blocking, waiver_id, waivable), optional `waivers[]`
 *                   (compliance_waivers rows — attach only to waivable policy tests), optional `run` {status, completed_at,
 *                   checkpoint} + `gate` + `now` for the freshness window (24 h LE/lock; 4 h CD onward).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { deriveGate, gateFresh, type ComplianceTestRow, type ComplianceWaiver, type GateCode, GATES } from "./ops-25-1.ts";

export const EVALUATORS_25_1: Record<string, Evaluator> = {
  "25.1.gateOpen": (f) => {
    const tests = arr<ComplianceTestRow>(f, "tests");
    if (!tests.length) return no("SM_O61_COMPLIANCE_PASS_*_GATE: no compliance_test_runs row for the checkpoint — run the suite first");
    const waivers = arr<ComplianceWaiver>(f, "waivers");
    const run = f.run as { status?: string; completed_at?: string; checkpoint?: string } | undefined;
    const gate = s(f, "gate"), now = s(f, "now");
    if (run && gate && now && gate in GATES && run.completed_at && run.status && !gateFresh({ status: run.status as never, completed_at: run.completed_at, checkpoint: (run.checkpoint ?? GATES[gate as GateCode].checkpoint) as never }, gate as GateCode, now)) return no(`${gate}: latest run ${run.status} at ${run.completed_at} is outside the ${GATES[gate as GateCode].freshness_hours} h freshness window (or superseded) — re-run`);
    const d = deriveGate(tests, waivers);
    return d.open ? ok : no(`${gate || "SM_O61_COMPLIANCE_PASS_GATE"} blocked — ${d.reason} (an error result blocks like a failure; only officer waivers on policy tests re-derive the gate)`);
  },
};
export const kit_25_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
