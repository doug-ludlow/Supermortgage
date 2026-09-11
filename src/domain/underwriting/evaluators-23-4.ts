/**
 * §23.4 gate evaluators, keyed "23.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-23-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   23.4.qmDeterminationGate  REGZ_1026_43_QM_DETERMINATION_GATE — facts: the current-stage qm_determinations row's
 *                             `qm_type`, `apr_test_pass`, `pf_pass`, `product_tests_pass`, `consider_verify_complete`,
 *                             `consider_verify_missing[]`, `stage`, `apor_stale`, `blocked_reason`, `computed_from_final_cd`,
 *                             plus `command` (issueCD | consummate | authorizeFunding | submitDelivery).
 *   23.4.hoepaGate            REGZ_1026_32_HOEPA_GATE — facts: `is_hoepa`, `command`.
 *   23.4.stateHighCostGate    STATE_HIGH_COST_GATE — facts: `state_tests[]` (high_cost_determinations.state_tests), `command`,
 *                             optional `officer_accepted_state_risk` (an officer's recorded acceptance of a non-Fannie-Mae state risk).
 *   23.4.hpmlEscrowGate       REGZ_1026_35B1_HPML_ESCROW_GATE — facts: `is_hpml`, `lien`, `principal_dwelling`,
 *                             `escrow_established_before_consummation`, `escrow_waiver_elected`.
 *   23.4.hpmlAppraisalCopy3bd REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD (24.2 owns) — facts: `appraisal_rules_apply`,
 *                             `consummation_date`, `copies[]` {appraisal_id, delivered_on}.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { qmDeterminationGate, hoepaGate, stateHighCostGate, hpmlEscrowGate, hpmlAppraisalCopyGate, type GatedCommand, type StateTest, type QmType, type Lien } from "./ops-23-4.ts";

const COMMANDS: readonly GatedCommand[] = ["issueCD", "consummate", "authorizeFunding", "submitDelivery"];
const command = (f: Record<string, unknown>): GatedCommand => { const v = s(f, "command"); return (COMMANDS as readonly string[]).includes(v) ? (v as GatedCommand) : "issueCD"; };
const optBool = (f: Record<string, unknown>, k: string): boolean | null => (typeof f[k] === "boolean" ? (f[k] as boolean) : null);

export const EVALUATORS_23_4: Record<string, Evaluator> = {
  "23.4.qmDeterminationGate": (f) => {
    const qm_type = f.qm_type as QmType | null | undefined;
    if (qm_type === undefined) return no("REGZ_1026_43_QM_DETERMINATION_GATE: no qm_determinations row for the current stage — run the determinations first");
    const r = qmDeterminationGate({ qm_type: qm_type ?? null, apr_test_pass: optBool(f, "apr_test_pass"), pf_pass: b(f, "pf_pass"), product_tests_pass: b(f, "product_tests_pass"), consider_verify_complete: b(f, "consider_verify_complete"), consider_verify_missing: arr<string>(f, "consider_verify_missing"),
      stage: (s(f, "stage") || "le") as never, apor_stale: b(f, "apor_stale"), blocked_reason: typeof f.blocked_reason === "string" ? f.blocked_reason : null, computed_from_final_cd: b(f, "computed_from_final_cd") }, command(f));
    return r.open ? ok : no(r.reason!);
  },
  "23.4.hoepaGate": (f) => {
    const v = optBool(f, "is_hoepa");
    if (v === null) return no("REGZ_1026_32_HOEPA_GATE: no high_cost_determinations row for the current stage");
    const r = hoepaGate(v, command(f)); return r.open ? ok : no(r.reason!);
  },
  "23.4.stateHighCostGate": (f) => {
    if (!Array.isArray(f.state_tests)) return no("STATE_HIGH_COST_GATE: no high_cost_determinations.state_tests for the current stage");
    const r = stateHighCostGate(arr<StateTest>(f, "state_tests"), command(f), b(f, "officer_accepted_state_risk")); return r.open ? ok : no(r.reason!);
  },
  "23.4.hpmlEscrowGate": (f) => {
    const r = hpmlEscrowGate({ is_hpml: optBool(f, "is_hpml"), lien: (s(f, "lien") || "first") as Lien, principal_dwelling: f.principal_dwelling === undefined ? true : b(f, "principal_dwelling"), escrow_established_before_consummation: optBool(f, "escrow_established_before_consummation"), escrow_waiver_elected: b(f, "escrow_waiver_elected") });
    return r.open ? ok : no(r.reason!);
  },
  "23.4.hpmlAppraisalCopy3bd": (f) => {
    if (!b(f, "appraisal_rules_apply")) return ok;
    const d = s(f, "consummation_date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return no("REGZ_1026_35C_HPML_APPRAISAL_COPY_3BD: consummation_date required");
    const r = hpmlAppraisalCopyGate({ appraisal_rules_apply: true, consummation_date: d as PlainDate, copies: arr<{ appraisal_id: string; delivered_on: PlainDate | null }>(f, "copies") });
    return r.open ? ok : no(r.reason!);
  },
};
export const kit_23_4 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
