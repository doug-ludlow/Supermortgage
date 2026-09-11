/**
 * §24.6 timer overrides (process-owned; applied after every section's so they win the merge — see
 * src/domain/bankruptcy/timers-14-1.ts for the pattern). One `reg.override(code, { trigger?, satisfied | evaluator,
 * anchorField?, offset?, why })` per 24.6 registry row whose trigger/satisfied column names an event the platform
 * spells differently or a condition the column grammar drops; `why` quotes the spec. A code the servicing spec
 * (sections 1–19) owns is never overridden here — reference it (`FNMA_B101_MI_MONTHLY_ESCROW_GATE` is 3.8's; 30.3
 * satisfies it through `escrow.waiver.decided`).
 *
 * Emitters live in src/domain/property/ops-24-6.ts (the `title-closing` agent's rules): `mi.quote.received`
 * (receiveQuotes), `mi.plan.selected{premium_plan}` (selectPlan), `mi.ordered` (submitOrder), `mi.commitment.received`
 * (receiveCommitment), `hpa.initial_disclosure.rendered` / `.delivered{delivered_at, consummation_at}`
 * (renderHpaDisclosure / deliverHpaDisclosure), `hpa.lpmi_disclosure.delivered` (renderLpmiDisclosure),
 * `mi.activation.requested{note_date}` (requestActivation), `mi.activated` (confirmActivation), `mi.premium.remitted`
 * (remitPremium). Consumed, never redefined: `du.findings.received` (23.1), `decision.issued` (21.6),
 * `closing.scheduled` / `closing.consummated` (26.1), `loan.funded` (30.2). SM_MI_QUOTE_1BD, SM_MI_ORDER_2BD and
 * SM_MI_UPFRONT_REMIT_10 need no override — their columns already parse.
 */
import type { TimerRegistry } from "../../kernel/timers/registry.ts";

export function applySatisfiedOverrides_24_6(reg: TimerRegistry): void {
  const o = reg.override.bind(reg);
  // Timer table / T9: the note date is the anchor (`closing.consummated{note_date}`; `loan.funded` in dry states), +1 business_days_creditor → Wed Nov 18 → Thu Nov 19, 2026.
  o("SM_MI_ACTIVATE_1BD", { anchorField: "note_date",
    why: "§24.6 timer table: deadline (policy), trigger '`closing.consummated` (`loan.funded` in dry states)', anchor 'note date', '+1 `business_days_creditor`', satisfied by '`mi.activated`', breach 'sev-2; escalate to insurer' — requestActivation emits `mi.activation.requested{note_date}` and confirmActivation `mi.activated{activation_effective_date}` (T9: consummation Wed Nov 18, 2026 → confirm by Thu Nov 19; effective date = note date)." });
  // State-machine guard committed → docs_ready: status ∈ {committed, docs_ready}, coverage ≥ B7-1-02 for the final LTV, insurer on the approved list.
  o("FNMA_B7_1_01_MI_COMMITMENT_BEFORE_DOCS_GATE", { evaluator: "24.6.miCommitmentBeforeDocsGate", satisfied: "`mi.commitment.received`",
    why: "§24.6 timer table: not_before_gate on `closing.scheduled`, '`status ∈ {committed, docs_ready}` with `coverage_pct` ≥ B7-1-02 requirement for the final LTV and insurer on the approved list', satisfied by '`mi.commitment.received`', breach 'doc generation (26.1) refused' — B7-1-01 (04/02/2025): 'the lender must obtain a primary mortgage insurance policy for a conventional first mortgage loan that has an LTV ratio greater than 80%' (evaluators-24-6.ts miCommitmentBeforeDocsGate; receiveCommitment emits the satisfier)." });
  // Insurer terms: consummation ≤ commitment expiry; consummation inside the window closes it (26.1's `closing.consummated`).
  o("SM_MI_COMMITMENT_EXPIRY_GATE", { evaluator: "24.6.miCommitmentExpiryGate", satisfied: "`closing.consummated`",
    why: "§24.6 timer table: not_before_gate on `closing.scheduled`, anchor `commitment_expires_at`, 'consummation ≤ expiry (insurer terms; typically 90–120 days)', satisfied by 'valid commitment', breach 're-order; `consummate` refused' — edge case 'Commitment expires before a delayed closing → re-order with the same insurer; new certificate number recorded' (evaluators-24-6.ts miCommitmentExpiryGate; requestActivation refuses on an expired commitment)." });
  // §4903(a)(1) / T6: the initial disclosure (fixed: immutable initial schedule + notice; ARM: notice) rendered into the closing package and delivered at consummation.
  o("HPA_4903_INITIAL_DISCLOSURE_GATE", { evaluator: "24.6.hpaInitialDisclosureGate", satisfied: "`hpa.initial_disclosure.delivered`",
    why: "§24.6 timer table: not_before_gate on '`closing.scheduled` (BPMI, `hpa_covered=true`)', '`hpa_disclosures.kind ∈ {initial_fixed, initial_arm}` rendered with the immutable initial amortization schedule (fixed) and included in the consummation package', satisfied by '`hpa.initial_disclosure.rendered` + delivery at consummation (`disclosures.delivered_at = consummation_at`)', breach '`consummate` refused' — 12 U.S.C. 4903(a)(1): 'at the time at which the transaction is consummated, the mortgagee shall provide' the schedule and notice; renderHpaDisclosure emits `hpa.initial_disclosure.rendered`, deliverHpaDisclosure `hpa.initial_disclosure.delivered{delivered_at = consummation_at}` (T6)." });
  // §4905(c) / T8: LPMI elected → the disclosure precedes the approval/commitment letter (24.6-Q3: the conditional-approval letter is the first written commitment).
  o("HPA_4905C_LPMI_DISCLOSURE_GATE", { trigger: "`mi.plan.selected{premium_plan∈{lpmi_monthly, lpmi_single}}`", evaluator: "24.6.lpmiDisclosureGate", satisfied: "`hpa.lpmi_disclosure.delivered`",
    why: "§24.6 timer table: not_before_gate, trigger '`decision.issued{conditional_approval}` / `lock.executed` with `premium_plan ∈ {lpmi_*}`', '`NTC_HPA_4905_LPMI` delivered \"not later than the date on which a loan commitment is made\" — platform anchor: before the commitment/approval letter is issued', satisfied by '`hpa.lpmi_disclosure.delivered`', breach 'approval/commitment letter refused' — the gate arms the moment an lpmi_* plan is elected (selectPlan emits `mi.plan.selected{premium_plan}`), so a plan change after the LE is caught before 21.6's letter (edge case: 'treat the plan change as a new commitment with the disclosure delivered first'); renderLpmiDisclosure emits the satisfier (T8: delivered Mon Oct 26, 2026 with the conditional approval)." });
  // B7-1-01 / T9: 29.4 asserts the gate at submitDelivery; it arms when activation is requested at the note date (no source emits `delivery.submitted` yet — 29.4 in flight) and closes on the insurer's confirmation.
  o("FNMA_B7_1_01_MI_ACTIVE_BEFORE_DELIVERY_GATE", { trigger: "`mi.activation.requested`", evaluator: "24.6.miActiveBeforeDeliveryGate", satisfied: "`mi.activated`",
    why: "§24.6 timer table: not_before_gate, trigger '`delivery.submitted` request (29.4 asserts)', '`status='active'` and MI data (company code, certificate, coverage %, premium plan) in the ULDD', satisfied by '`mi.activated`', breach '`submitDelivery` refused' — B7-1-01: the lender must ensure MI is 'in place' at purchase/securitization; guardrail 'never … deliver without `active`' — requestActivation emits `mi.activation.requested{note_date}` (the gate is armed from the note date until the insurer confirms); 29.4's submitDelivery evaluates 24.6.miActiveBeforeDeliveryGate (T9: activation confirmed Nov 19 with effective date Nov 18 → `active` → the delivery gate passes)." });
}
