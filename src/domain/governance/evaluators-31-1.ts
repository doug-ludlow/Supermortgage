/**
 * §31.1 gate evaluators, keyed "31.1.<name>". Every key must be named by an `evaluator:` override in
 * timers-31-1.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 *   31.1.stateReadinessGate  — SM_LICENSE_STATE_GATE: rule 1 `open(S) = partner_company_ok ∧ branch_ok ∧ mlo_available ∧
 *                              sm_processing_ok ∧ matrix_ok ∧ ai_position_ok`. Facts: either a computed `readiness` (ops-31-1.ts
 *                              stateReadiness) or the ReadinessFacts themselves (`state`, `as_of`, `licenses[]`, `jurisdiction`,
 *                              `roster[]`, optional `officer_risk_acceptance`). Never opens on inference or for an `unverified`
 *                              processor rule (the facts carry rows, not guesses).
 *   31.1.emortgageApprovalGate — FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE: partner eMortgage special approval granted/active, MERS
 *                              eRegistry addendum for partner and SM, SM's eNote warehouse agreement — all as of `as_of`. Facts:
 *                              `approvals[]` (fnma_approvals rows), `as_of`.
 *   31.1.tspProductionCertGate — FNMA_TSP_PRODUCTION_CERT_GATE(product): SM `tsp_certification{product}` granted, partner
 *                              `tm_tsp_product_assignment{product}` active, 19.3 Form 101 gate open. Facts: `product`,
 *                              `approvals[]`, `form101` {status}, `as_of`.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { stateReadiness, emortgageGate, tspProductionGate, TSP_PRODUCTS, type Readiness, type ReadinessFacts, type FnmaApproval, type Form101Fact, type TspProduct } from "./ops-31-1.ts";

const asOf = (f: Record<string, unknown>): PlainDate => D(s(f, "as_of") || "1970-01-01");

export const EVALUATORS_31_1: Record<string, Evaluator> = {
  "31.1.stateReadinessGate": (f) => {
    const pre = f.readiness as Readiness | undefined;
    let r: Readiness;
    if (pre && typeof pre === "object" && "predicates" in pre) r = pre;
    else {
      const state = s(f, "state");
      if (!state || !f.jurisdiction || !Array.isArray(f.licenses)) return no("SM_LICENSE_STATE_GATE: no readiness facts (state, jurisdiction row, licenses, roster) — the gate never opens on inference");
      r = stateReadiness({ state, as_of: asOf(f), licenses: arr(f, "licenses"), jurisdiction: f.jurisdiction as ReadinessFacts["jurisdiction"], roster: arr(f, "roster"), officer_risk_acceptance: (f.officer_risk_acceptance as ReadinessFacts["officer_risk_acceptance"]) ?? null });
    }
    if (r.open) return ok;
    const failed = Object.entries(r.predicates).filter(([, v]) => !v).map(([k]) => k);
    return no(`SM_LICENSE_STATE_GATE ${r.state} closed — ${r.reason} (${failed.join(", ")} false); escalate sev 1 to the ${r.escalated_party} officer`);
  },
  "31.1.emortgageApprovalGate": (f) => {
    const approvals = arr<FnmaApproval>(f, "approvals");
    if (!approvals.length) return no("FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE: no fnma_approvals rows — the partner's eMortgage special approval is not on record");
    const g = emortgageGate(approvals, asOf(f));
    return g.open ? ok : no(`FNMA_A2_1_01_EMORTGAGE_APPROVAL_GATE closed — ${g.missing.join("; ")} (closing falls back to hybrid; closing.enote_default overridden emortgage_gate_closed)`);
  },
  "31.1.tspProductionCertGate": (f) => {
    const product = s(f, "product") as TspProduct;
    if (!TSP_PRODUCTS.includes(product)) return no(`FNMA_TSP_PRODUCTION_CERT_GATE: product ${JSON.stringify(product)} is not a TSP product (${TSP_PRODUCTS.join("/")})`);
    const form101 = (f.form101 as Form101Fact | undefined) ?? { status: "none" };
    const g = tspProductionGate(product, arr<FnmaApproval>(f, "approvals"), form101, asOf(f));
    return g.open ? ok : no(`FNMA_TSP_PRODUCTION_CERT_GATE(${product}) closed — ${g.missing.join("; ")} (adapter refuses tsp_gate_closed; fnma_portal_operator UI fallback)`);
  },
};
export const kit_31_1 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
