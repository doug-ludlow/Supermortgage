/**
 * §24.4 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 24.4 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — `REGZ_1026_36C3_PAYOFF_STMT_7BD` (7.6/16.1) and
 * `REGX_1024_34B_PAYOFF_ESCROW_REFUND_20BD` (3.5) are referenced: 24.4 requests the same-servicer payoff through
 * 16.1's `payoffRequestIntake` (`payoff.request.received` on the existing loan) and consumes 3.5/30.3's
 * `escrow.credit_to_new_loan.posted`. Wired by src/domain/timer-overrides.ts.
 *
 * Emitters live in src/domain/property/ops-24-4.ts (the `title-closing` agent's rules): `title.ordered` +
 * `settlement_agent.assigned` (placeTitleOrder), `title.commitment.received` (recordCommitmentReceived),
 * `title.order.status_changed{status}` (recordOrderStatus), `title.datedown.received{effective_date, in_window}`
 * (recordDatedownReceived), `settlement_agent.vetted{vetting_status}` (recordAgentVetted),
 * `wire.instructions.verified` / `wire.instructions.change_detected` (recordWireVerification), `cpl.received
 * {cpl_addressee_ok}` (recordCplReceived), `payoff.demand.requested{same_servicer}` (requestPayoff),
 * `payoff.statement.received{covers_disbursement}` (recordPayoffStatement), `subordination.requested` /
 * `subordination.executed` (recordSubordinationRequested / recordSubordinationAgreement),
 * `vesting.reviews.completed{all_eligible}` (recordVestingReviewsCompleted). Consumed, never redefined:
 * `intent.to_proceed.received` (21.4), `closing.scheduled` (26.2), `funding.authorized` (26.3), `du.findings.received`
 * (23.2). SM_TITLE_ORDER_2BD needs no override — its columns already parse (`intent.to_proceed.received` +2
 * business_days_creditor, satisfied by `title.ordered`).
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_24_4(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Q2 policy: commitment (or its date-down) effective within 30 calendar days of consummation.
  o("SM_TITLE_COMMITMENT_DATEDOWN_GATE", { evaluator: "24.4.commitmentDatedownGate", satisfied: "`title.datedown.received{in_window=true}`",
    why: "§24.4 timer table: not_before_gate on `consummate`, trigger `closing.scheduled`, anchor `commitment_effective_date`, 'consummation − 30 `calendar_days` (policy; open question 24.4-Q2)', satisfied by '`title.datedown.received` with effective date ≥ consummation − 30', breach '`consummate` refused' — recordDatedownReceived (ops-24-4.ts) emits `title.datedown.received{effective_date, in_window}` where in_window is commitmentDatedownGate's verdict; evaluators-24-4.ts commitmentDatedownGate." });
  // R1–R3 / T1–T3: the title-evidence gate is condition-shaped; `title_orders.status ∈ {cleared, dated_down}` is the status-change event the state machine emits.
  o("FNMA_B7_2_01_TITLE_EVIDENCE_GATE", { evaluator: "24.4.titleEvidenceGate", satisfied: "`title.order.status_changed{status∈{cleared, dated_down}}`",
    why: "§24.4 timer table: not_before_gate on `disburse`, trigger '`funding.authorized` request', 'commitment/pro forma on the 2021 ALTA form (or AOL meeting B7-2-06) with every `required_endorsements` entry issued or committed, `policy_amount_cents ≥ original principal`, no MERS as insured, ALTA 8.1 present', satisfied by '`title_orders.status ∈ {cleared, dated_down}`' — B7-2-03 (07/06/2022): 2021 ALTA Loan Policy for loans originated on/after Jan 1, 2024; 'at least equal the original principal amount'; 'Under no circumstances may MERS be named as the insured'; ALTA 8.1 required — recordOrderStatus (ops-24-4.ts) emits `title.order.status_changed{status}` on every state-machine transition (T1: 'ALTA Loan Policy (6-17-06)' → policy_form_not_2021)." });
  // Warehouse/partner control (discrepancy 7): CPL naming the partner for the assigned agent, dated ≤ funding.
  o("SM_CPL_BEFORE_FUNDING_GATE", { evaluator: "24.4.cplBeforeFundingGate", satisfied: "`cpl.received{cpl_addressee_ok=true}`",
    why: "§24.4 timer table: not_before_gate on `disburse`, trigger `closing.scheduled`, 'CPL from `underwriter_party_id` naming the partner (and SM per facility terms), for `settlement_agent_party_id`, transaction-specific, dated ≤ funding date and ≥ CPL validity per state form', satisfied by '`cpl.received` with `cpl_addressee_ok=true`' — recordCplReceived (ops-24-4.ts) emits `cpl.received{cpl_addressee_ok, cpl_agent_ok}` from cplBeforeFundingGate (T14: a CPL naming a different agent → `cpl_agent_mismatch`, `disburse` refused)." });
  // R13 / T8: vendor match + callback, ≤ 30 days old; a change ≤ 48 h before funding blocks the wire until the funding_approver releases after a second callback.
  o("SM_WIRE_VERIFICATION_GATE", { evaluator: "24.4.wireVerificationGate", satisfied: "`wire.instructions.verified`",
    why: "§24.4 timer table: not_before_gate on `disburse`, trigger '`closing.scheduled`; `wire.instructions.change_detected`', anchor `verified_at`, 'verification ≤ 30 `calendar_days` old; any change → re-verify; no change accepted ≤ 48 hours before funding without `funding_approver`', satisfied by '`wire.instructions.verified` (vendor match + callback)' — recordWireVerification (ops-24-4.ts) emits `wire.instructions.change_detected{hours_to_funding, blocked}` and, once the vendor match and the SM callback to a registry/underwriter number both hold, `wire.instructions.verified{callback_number_source}` (T8: e-mailed change Nov 11 15:00 for a Nov 12 funding → blocked; funding_approver release after a second callback to the ALTA Registry number)." });
  // R6 / T5: statement good through ≥ disbursement date for every lien being paid; a stale statement is refreshed, never extended by per diem.
  o("SM_PAYOFF_GOOD_THROUGH_GATE", { evaluator: "24.4.payoffGoodThroughGate", satisfied: "`payoff.statement.received{covers_disbursement=true}`",
    why: "§24.4 timer table: not_before_gate on `disburse`, trigger '`funding.authorized` request', anchor `good_through_date`, 'must be ≥ `disbursement_date` (+ `per_diem` cover for dry-state slippage)', satisfied by '`payoff_demands.status ∈ {received, refreshed}` with current good-through', breach '`disburse` refused; `payoff.statement.stale` → refresh' — recordPayoffStatement (ops-24-4.ts) emits `payoff.statement.received{status, good_through_date, covers_disbursement}`; recordPayoffStale emits `payoff.statement.stale` and requestPayoff{refresh=true} re-requests (T5: good through Nov 12 covers a Nov 12 disbursement; Nov 13 → stale)." });
  // Rule 6 worked example: the 7-BD follow-up monitors an EXTERNAL servicer's §1026.36(c)(3) duty; the same-servicer case runs on 16.1's REGZ_1026_36C3_PAYOFF_STMT_7BD instead.
  o("SM_PAYOFF_DEMAND_FOLLOWUP_7BD", { trigger: "`payoff.demand.requested{same_servicer=false}`", anchorField: "requested_on",
    why: "§24.4 timer table: 'deadline (policy monitor of the external servicer's §1026.36(c)(3) duty)', trigger '`payoff.demand.requested` (external servicer)', anchor 'request date', '+7 `business_days_creditor` (proxy for the servicer's calendar)', satisfied by `payoff.statement.received`, breach 'sev-3; agent re-requests through the servicer's designated channel; borrower notified' — requestPayoff (ops-24-4.ts) emits `payoff.demand.requested{same_servicer}`; when SM subservices the existing loan the request goes through 16.1's payoffRequestIntake (`payoff.request.received`) and 7.6's clock applies (rule 6: written request Mon Oct 26, 2026 → expected Wed Nov 4)." });
  // R9 / T7: every retained subordinate lien executed (recordable) or statutorily preserved before consummation.
  o("FNMA_B2_1_2_04_RESUBORDINATION_GATE", { evaluator: "24.4.resubordinationGate", satisfied: "`subordination.executed`",
    why: "§24.4 timer table: not_before_gate on `consummate`, trigger `closing.scheduled`, 'every `subordinations` row for a lien staying in place is `executed` (recordable form) or `waived_statutory`', satisfied by `subordination.executed`, breach '`consummate` refused' — B2-1.2-04 (08/06/2025): 'Fannie Mae requires execution and recordation of a resubordination agreement'; not required where state law keeps the lien position — recordSubordinationAgreement (ops-24-4.ts) emits `subordination.executed{recordable, terms_ok}` only when checkSubordinateTerms passes (T7: a balloon 3 years after the note date → terms_ok=false, `subordination.rejected`)." });
  // R14: "agent assigned" is the title order naming the settlement agent; vetting must be current at closing.
  o("SM_SETTLEMENT_AGENT_VETTING_GATE", { trigger: "`settlement_agent.assigned`", evaluator: "24.4.settlementAgentVettingGate", satisfied: "`settlement_agent.vetted{vetting_status∈{approved, approved_with_conditions}}`",
    why: "§24.4 timer table: not_before_gate, trigger 'agent assigned', anchor `vetting_expires_on`, '`vetting_status ∈ {approved, approved_with_conditions}` and not expired', satisfied by `settlement_agent.vetted`, breach 'closing cannot be scheduled with the agent' — placeTitleOrder (ops-24-4.ts) emits `settlement_agent.assigned{settlement_agent_party_id}` with the order; recordAgentVetted emits `settlement_agent.vetted{vetting_status, vetting_expires_on}` (rule 14: license, E&O ≥ $1,000,000, fidelity/CPL, ALTA Registry or underwriter confirmation, Best Practices attestation, letterhead wire instructions, annual re-vetting) or `settlement_agent.rejected`." });
  // R10 / R11: every trust and POA borrower reviewed eligible before 26.1 generates documents.
  o("SM_TRUST_POA_REVIEW_GATE", { evaluator: "24.4.trustPoaReviewGate", satisfied: "`vesting.reviews.completed{all_eligible=true}`",
    why: "§24.4 timer table: not_before_gate on doc generation (26.1), trigger `closing.scheduled`, '`trust_reviews.result='eligible'` / `poa_reviews.result='eligible'` for every trust/POA borrower', satisfied by 'reviews complete' — B2-2-05 / B8-5-05 — reviewTrust / reviewPOA record `trust.reviewed{result, sfc_168}` / `poa.reviewed{result}` and, after each review, recordVestingReviewsCompleted (ops-24-4.ts) emits `vesting.reviews.completed{all_eligible}` from trustPoaReviewGate over the application's reviews (T9/T10)." });
}
