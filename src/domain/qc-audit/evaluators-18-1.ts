/**
 * §18.1 gate evaluators, keyed "18.1.<name>". Every key must be named by an
 * `evaluator:` override in timers-18-1.ts and vice versa (src/app/app.test.ts checks both).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { aiEvalGateFacts } from "./ops-18-1.ts";

export const EVALUATORS_18_1: Record<string, Evaluator> = {
  /** `SM_AI_EVAL_GATE` (rule D.3): open only when every mandatory evaluation suite passed and a T1/T2 version carries the `officer:ai_governance_owner` approval. Facts: `tier`, `suites[{suite_code, mandatory, pass}]`, `approved_by`. */
  "18.1.aiEvalGatePassed": (f) => {
    const r = aiEvalGateFacts({ tier: (s(f, "tier") || "T1_consequential") as Parameters<typeof aiEvalGateFacts>[0]["tier"], suites: arr<{ suite_code: string; mandatory: boolean; pass: boolean }>(f, "suites"), approved_by: f.approved_by ? s(f, "approved_by") : null });
    return r.open ? ok : no(`SM_AI_EVAL_GATE: ${r.reason} — deploy refused, version stays evaluated`);
  },
};
export const kit_18_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
