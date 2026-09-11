/**
 * §23.3 gate evaluators, keyed "23.3.<name>". Every key must be named by an `evaluator:` override in
 * timers-23-3.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   23.3.ptdClearedGate   SM_UW_PTD_CLEARED_GATE — facts: `ptd_cleared`, `blocking_codes[]` (ops-23-3.ts ptdStatus), `final_match_gate_open`
 *                         (23.1's FNMA_B3_2_10_DU_FINAL_MATCH_GATE), `command` (issueCD | generateClosingDocs).
 *   23.3.ctcGate          SM_UW_CTC_GATE — facts: `ctc_issued`, `checklist_passed` (ctc_checklists.passed), `decision_status`, `command`.
 *   23.3.ptfClearedGate   SM_UW_PTF_CLEARED_GATE — facts: `ptf_cleared`, `blocking_codes[]` (ptfStatus), `command` (authorizeFunding).
 *   23.3.prefundingQcGate FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE (28.1's rule, asserted by 23.3 before clear_to_close and surfaced as the
 *                         checklist item SM_QC_PREFUNDING_HOLD) — facts: `review_status` ∈ {open, defect_open, closed_no_defect, closed_defect_corrected,
 *                         unable_to_complete} | null (ops-23-3.ts prefundingReviewStatus over the 28.1 events).
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { ptdClearedGate, ctcGate, ptfClearedGate, prefundingQcGate, type PrefundingReviewStatus } from "./ops-23-3.ts";

const REVIEW_STATUSES: readonly PrefundingReviewStatus[] = ["open", "defect_open", "closed_no_defect", "closed_defect_corrected", "unable_to_complete"];
const opt = (f: Record<string, unknown>, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);

export const EVALUATORS_23_3: Record<string, Evaluator> = {
  "23.3.ptdClearedGate": (f) => {
    if (f.ptd_cleared === undefined) return no("SM_UW_PTD_CLEARED_GATE: ptd_cleared is unknown — run ptdStatus over the conditions, investigations and QC holds");
    const r = ptdClearedGate({ ptd_cleared: b(f, "ptd_cleared"), blocking_codes: arr<string>(f, "blocking_codes"), final_match_gate_open: f.final_match_gate_open === undefined ? true : b(f, "final_match_gate_open"), ...(opt(f, "command") ? { command: opt(f, "command")! } : {}) });
    return r.open ? ok : no(r.reason!);
  },
  "23.3.ctcGate": (f) => {
    const r = ctcGate({ ctc_issued: b(f, "ctc_issued"), checklist_passed: b(f, "checklist_passed"), decision_status: s(f, "decision_status") || "active", ...(opt(f, "command") ? { command: opt(f, "command")! } : {}) });
    return r.open ? ok : no(r.reason!);
  },
  "23.3.ptfClearedGate": (f) => {
    const r = ptfClearedGate({ ptf_cleared: b(f, "ptf_cleared"), blocking_codes: arr<string>(f, "blocking_codes"), ...(opt(f, "command") ? { command: opt(f, "command")! } : {}) });
    return r.open ? ok : no(r.reason!);
  },
  "23.3.prefundingQcGate": (f) => {
    const v = f.review_status === null || f.review_status === undefined ? null : s(f, "review_status");
    if (v !== null && !(REVIEW_STATUSES as readonly string[]).includes(v)) return no(`FNMA_D1_2_01_PREFUNDING_PRIOR_TO_CLOSING_GATE: review_status ${v} is not one of ${REVIEW_STATUSES.join(", ")}`);
    const r = prefundingQcGate({ review_status: v as PrefundingReviewStatus | null, ...(opt(f, "command") ? { command: opt(f, "command")! } : {}) });
    return r.open ? ok : no(r.reason!);
  },
};
export const kit_23_3 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
