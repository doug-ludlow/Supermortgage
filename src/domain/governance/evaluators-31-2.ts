/**
 * §31.2 gate evaluators, keyed "31.2.<name>". Every key must be named by an `evaluator:` override in
 * timers-31-2.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 *
 * Three condition-shaped gates: the origination deploy gate (SM_O122_ORIGINATION_AI_DEPLOY_GATE), the Colorado developer
 * documentation gate (CO_SB26_189_1702_DEVELOPER_DOCS_GATE) and the California ADMT readiness gate
 * (CA_CPPA_7200_ADMT_READINESS_20270101). Facts are the `ai_systems` row fields the spec names plus the application's
 * state and date; the tools in src/app/tools/section31-2.ts assert them at the command boundary.
 */
import { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears, type PlainDate, type Evaluator } from "../../app/evaluator-kit.ts";
import { plainDate } from "../../kernel/calendar/date.ts";
import { originationDeployGate, coDeveloperDocsGate, caAdmtReadinessGate } from "./ops-31-2.ts";

const optStr = (f: Record<string, unknown>, k: string): string | null => (f[k] === undefined || f[k] === null || f[k] === "" ? null : String(f[k]));

export const EVALUATORS_31_2: Record<string, Evaluator> = {
  /**
   * SM_O122_ORIGINATION_AI_DEPLOY_GATE — `ai_impact_assessments{pre_deployment or material_modification}.approved` ∧ eval
   * pass (19.3 SM_AI_SYSTEM_EVAL_BEFORE_DEPLOY) ∧ bias tests pass for high-risk (19.4 SM_AI_BIAS_TEST_PRE_DEPLOY) ∧
   * `partner_notified_at` set ∧ (CO covered: `co_docs_delivered_to_deployer_at` set). Facts: the ai_systems row fields.
   */
  "31.2.originationDeployGate": (f) => {
    const g = originationDeployGate({ assessment_kind: (optStr(f, "assessment_kind") as "pre_deployment" | "material_modification" | "annual" | null), assessment_approved: b(f, "assessment_approved"), eval_pass: b(f, "eval_pass"), bias_tests_pass: f.bias_tests_pass === undefined ? null : b(f, "bias_tests_pass"), risk_tier: s(f, "risk_tier"), partner_notified_at: optStr(f, "partner_notified_at"), co_covered: b(f, "co_covered"), co_docs_delivered_to_deployer_at: optStr(f, "co_docs_delivered_to_deployer_at"), ...(f.partner_officer_approved === undefined ? {} : { partner_officer_approved: b(f, "partner_officer_approved") }) });
    return g.open ? ok : no(`deploy blocked: ${g.reasons.join("; ")}`);
  },
  /**
   * CO_SB26_189_1702_DEVELOPER_DOCS_GATE — a covered ADMT (materially_influences_consequential_decision, co_admt_role ∈
   * developer/both) used for a Colorado consumer on/after 2027-01-01 needs the technical documentation delivered to the
   * deployer and acknowledged; otherwise the application is routed to the human path (T6). Facts: consumer_state, on,
   * materially_influences_consequential_decision, co_admt_role, co_docs_delivered_to_deployer_at, co_docs_acknowledged_at.
   */
  "31.2.coDeveloperDocsGate": (f) => {
    const on = optStr(f, "on") ?? optStr(f, "today"); if (!on) return no("date unknown (on)");
    const g = coDeveloperDocsGate({ consumer_state: s(f, "consumer_state") || s(f, "property_state"), on: plainDate(on), materially_influences_consequential_decision: b(f, "materially_influences_consequential_decision"), co_admt_role: s(f, "co_admt_role") || "n_a", co_docs_delivered_to_deployer_at: optStr(f, "co_docs_delivered_to_deployer_at"), co_docs_acknowledged_at: optStr(f, "co_docs_acknowledged_at") });
    return g.open ? ok : no(`Colorado application routed to the human path: ${g.reasons.join("; ")}`);
  },
  /**
   * CA_CPPA_7200_ADMT_READINESS_20270101 — while `jurisdiction_rules.ai_governance.ca_admt.applicability_position = applies`,
   * from 2027-01-01 the CA pre-use notice variant, the opt-out/human-appeal route and the access-request procedure must be
   * live; otherwise California applications go to the human path (T9). Facts: applicability_position, on, consumer_state,
   * preuse_notice_live, optout_route_live, access_procedure_live.
   */
  "31.2.caAdmtReadinessGate": (f) => {
    const on = optStr(f, "on") ?? optStr(f, "today"); if (!on) return no("date unknown (on)");
    const g = caAdmtReadinessGate({ applicability_position: s(f, "applicability_position") || "unresolved", on: plainDate(on), ...(optStr(f, "consumer_state") ? { consumer_state: s(f, "consumer_state") } : {}), preuse_notice_live: b(f, "preuse_notice_live"), optout_route_live: b(f, "optout_route_live"), access_procedure_live: b(f, "access_procedure_live") });
    return g.open ? ok : no(`California application routed to the human path: ${g.reasons.join("; ")}`);
  },
};
export const kit_31_2 = { ok, no, b, n, c, s, arr, every, atMost, atLeast, within, daysBetween, addDays, addYears } as const;
export type { PlainDate };
