/**
 * §24.4 gate evaluators, keyed "24.4.<name>". Every key must be named by an `evaluator:` override in
 * timers-24-4.ts and vice versa (src/app/app.test.ts checks both directions). Spread last by src/app/evaluators.ts.
 * Facts are the plain records the tools in src/app/tools/section24-4.ts assemble from the entity store
 * (`title_orders`, `title_curative_items`, `settlement_agents`, `wire_verifications`, `payoff_demands`, `subordinations`,
 * `trust_reviews`, `poa_reviews` rows) — see the ops functions' parameter types.
 */
import type { Evaluator, GateResult } from "../../app/evaluator-kit.ts";
import type { PlainDate } from "../../kernel/calendar/date.ts";
import { titleEvidenceGate, commitmentDatedownGate, cplBeforeFundingGate, wireVerificationGate, payoffGoodThroughGate, resubordinationGate, settlementAgentVettingGate, trustPoaReviewGate, type GateOutcome } from "./ops-24-4.ts";

const g = (r: GateOutcome): GateResult => (r.open ? { open: true } : { open: false, reason: r.reason ?? "closed" });
const d = (v: unknown): PlainDate | null => (typeof v === "string" && v !== "" ? (v as PlainDate) : null);
const c = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? "0")));
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const strs = (v: unknown): string[] => list<unknown>(v).map(String);

export const EVALUATORS_24_4: Record<string, Evaluator> = {
  /** FNMA_B7_2_01_TITLE_EVIDENCE_GATE (B7-2-03/-04/-06): 2021 form or qualifying AOL; endorsements issued/committed; amount ≥ principal; no MERS; ALTA 8.1. */
  "24.4.titleEvidenceGate": (f) => g(titleEvidenceGate({ policy_form: String(f.policy_form ?? ""), state_promulgated_equivalent: f.state_promulgated_equivalent === true, required_endorsements: strs(f.required_endorsements), issued_endorsements: strs(f.issued_endorsements), committed_endorsements: strs(f.committed_endorsements), policy_amount_cents: c(f.policy_amount_cents), note_amount_cents: c(f.note_amount_cents), proposed_insured_text: String(f.proposed_insured_text ?? ""), creditors_rights_exclusion: f.creditors_rights_exclusion === true, t42_deletions: strs(f.t42_deletions), aol: f.aol === true, aol_ok: f.aol_ok === true, ...(typeof f.order_status === "string" ? { order_status: f.order_status } : {}) })),
  /** SM_TITLE_COMMITMENT_DATEDOWN_GATE (24.4-Q2 policy): commitment / date-down effective ≥ consummation − 30 calendar days. */
  "24.4.commitmentDatedownGate": (f) => g(commitmentDatedownGate({ commitment_effective_date: d(f.commitment_effective_date), datedown_effective_date: d(f.datedown_effective_date), consummation_on: d(f.consummation_on) })),
  /** SM_CPL_BEFORE_FUNDING_GATE: CPL from the underwriter, naming the partner, for the assigned agent, transaction-specific, dated ≤ funding. */
  "24.4.cplBeforeFundingGate": (f) => g(cplBeforeFundingGate({ cpl_underwriter_party_id: (f.cpl_underwriter_party_id as string | null | undefined) ?? null, underwriter_party_id: (f.underwriter_party_id as string | null | undefined) ?? null, cpl_agent_party_id: (f.cpl_agent_party_id as string | null | undefined) ?? null, settlement_agent_party_id: (f.settlement_agent_party_id as string | null | undefined) ?? null, addressees: strs(f.addressees), partner_name: String(f.partner_name ?? ""), sm_addressee_required: f.sm_addressee_required === true, transaction_ref: (f.transaction_ref as string | null | undefined) ?? null, application_ref: String(f.application_ref ?? f.application_id ?? ""), cpl_date: d(f.cpl_date), funding_date: d(f.funding_date), validity_days: typeof f.validity_days === "number" ? f.validity_days : null })),
  /** SM_WIRE_VERIFICATION_GATE (rule 13): verification ≤ 30 days old, no unresolved change, callback on record. */
  "24.4.wireVerificationGate": (f) => g(wireVerificationGate({ verified_at: (f.verified_at as string | null | undefined) ?? null, change_detected_at: (f.change_detected_at as string | null | undefined) ?? null, blocks_disbursement: f.blocks_disbursement === true, callback_number_source: (f.callback_number_source as string | null | undefined) ?? null, as_of: String(f.as_of ?? f.now ?? new Date().toISOString()) })),
  /** SM_PAYOFF_GOOD_THROUGH_GATE (rule 6): every payoff `received`/`refreshed` with good-through ≥ disbursement. */
  "24.4.payoffGoodThroughGate": (f) => g(payoffGoodThroughGate({ payoffs: list<{ liability_id: string; status: string; good_through_date: PlainDate | null }>(f.payoffs), disbursement_date: d(f.disbursement_date) })),
  /** FNMA_B2_1_2_04_RESUBORDINATION_GATE (B2-1.2-04): every retained lien executed (recordable) or waived_statutory. */
  "24.4.resubordinationGate": (f) => g(resubordinationGate({ subordinations: list<{ liability_id: string; status: string; recordable?: boolean; statutory_position_preserved?: boolean }>(f.subordinations) })),
  /** SM_SETTLEMENT_AGENT_VETTING_GATE (rule 14): approved / approved_with_conditions and unexpired. */
  "24.4.settlementAgentVettingGate": (f) => g(settlementAgentVettingGate({ vetting_status: (f.vetting_status as string | null | undefined) ?? null, vetting_expires_on: d(f.vetting_expires_on), as_of: d(f.as_of) ?? (String(f.now ?? new Date().toISOString()).slice(0, 10) as PlainDate) })),
  /** SM_TRUST_POA_REVIEW_GATE (rules 10/11): every trust / POA borrower reviewed eligible. */
  "24.4.trustPoaReviewGate": (f) => g(trustPoaReviewGate({ trust_reviews: list<{ borrower_id: string; result: string }>(f.trust_reviews), poa_reviews: list<{ borrower_id: string; result: string }>(f.poa_reviews) })),
};
