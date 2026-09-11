/**
 * §24.6 gate evaluators, keyed "24.6.<name>". Every key must be named by an `evaluator:` override in
 * timers-24-6.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are the plain records the tools in src/app/tools/section24-6.ts assemble from the entity store
 * (`mi_certificates` + `hpa_disclosures` rows → ops-24-6.ts gateFactsOf) — see GateFacts in ops-24-6.ts.
 */
import type { Evaluator } from "../../app/evaluator-kit.ts";
import { miCommitmentBeforeDocsGate, miCommitmentExpiryGate, hpaInitialDisclosureGate, lpmiDisclosureGate, miActiveBeforeDeliveryGate, type GateFacts, type PremiumPlan } from "./ops-24-6.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";

const sn = (v: unknown): string | null => (typeof v === "string" ? v : null);
const nn = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null);
const bn = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const facts = (f: Record<string, unknown>): GateFacts => ({
  status: sn(f.status), coverage_pct: nn(f.coverage_pct), required_coverage_pct: nn(f.required_coverage_pct), mi_company_code: sn(f.mi_company_code), commitment_expires_at: sn(f.commitment_expires_at), consummation_on: sn(f.consummation_on) as PlainDate | null,
  premium_plan: sn(f.premium_plan) as PremiumPlan | null, hpa_covered: bn(f.hpa_covered), hpa_disclosure_kind: sn(f.hpa_disclosure_kind), hpa_rendered: bn(f.hpa_rendered), schedule_hash: sn(f.schedule_hash), delivered_at: sn(f.delivered_at), consummation_at: sn(f.consummation_at),
  lpmi_disclosure_delivered_at: sn(f.lpmi_disclosure_delivered_at), commitment_letter_issued_at: sn(f.commitment_letter_issued_at), certificate_number: sn(f.certificate_number), mi_required: bn(f.mi_required), uldd_mi_data_complete: bn(f.uldd_mi_data_complete) });

export const EVALUATORS_24_6: Record<string, Evaluator> = {
  /** FNMA_B7_1_01_MI_COMMITMENT_BEFORE_DOCS_GATE (B7-1-01/B7-1-02): status ∈ {committed, docs_ready}, coverage ≥ the requirement for the final LTV, insurer approved. */
  "24.6.miCommitmentBeforeDocsGate": (f) => miCommitmentBeforeDocsGate(facts(f)),
  /** SM_MI_COMMITMENT_EXPIRY_GATE (insurer terms): consummation ≤ commitment expiry, else re-order. */
  "24.6.miCommitmentExpiryGate": (f) => miCommitmentExpiryGate(facts(f)),
  /** HPA_4903_INITIAL_DISCLOSURE_GATE (12 U.S.C. 4903(a)(1)): initial_fixed / initial_arm rendered with the immutable schedule and delivered at consummation. */
  "24.6.hpaInitialDisclosureGate": (f) => hpaInitialDisclosureGate(facts(f)),
  /** HPA_4905C_LPMI_DISCLOSURE_GATE (12 U.S.C. 4905(c)): NTC_HPA_4905_LPMI delivered no later than the commitment / approval letter. */
  "24.6.lpmiDisclosureGate": (f) => lpmiDisclosureGate(facts(f)),
  /** FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE (B7-1-01): status = active with the ULDD MI data points. */
  "24.6.miActiveBeforeDeliveryGate": (f) => miActiveBeforeDeliveryGate(facts(f)),
};
