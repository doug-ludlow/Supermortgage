// 12.4 Forbearance plan
// spec/sections/12-loss-mitigation/12-4-forbearance-plan.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { preExpiryOutreach, postForbearanceDisposition, disasterForbearanceOffer, reducedPaymentMiss, referralGate, planCaseRouting } from "./ops.ts";

// 12.4-T1 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.4-T2 — implemented in src/domain/lossmit/lossmit.test.ts
// 12.4-T3 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.4-T4: (pre-expiry) outreach begins by 2026-12-01 for a 2026-12-31 term end and continues at least every 3 days; QRPC on 2026-12-10 \u2192 hierarchy pre-screen executed the same day.", () => {
  const r = preExpiryOutreach({ term_end: D("2026-12-31"), attempts: [D("2026-12-01"), D("2026-12-04"), D("2026-12-07"), D("2026-12-10")], qrpc_on: D("2026-12-10") });
  assert.equal(r.begin_by, "2026-12-01"); assert.equal(r.began_on_time, true); assert.equal(r.cadence_ok, true); assert.equal(r.max_gap_days, 3); assert.equal(r.prescreen_on, "2026-12-10");
  assert.equal(preExpiryOutreach({ term_end: D("2026-12-31"), attempts: [D("2026-12-01"), D("2026-12-06")] }).cadence_ok, false);
});
test("12.4-T5: (no QRPC at expiry) deferral-eligible (4 months delinquent) \u2192 post-forbearance deferral solicitation by 2027-01-15; if deferral-ineligible \u2192 Flex Mod solicitation by 2027-01-15.", () => {
  const a = postForbearanceDisposition({ term_end: D("2026-12-31"), qrpc: false, months_delinquent: 4, deferral_eligible: true });
  assert.deepEqual(a, { solicitation: "payment_deferral", notice: "NTC_FNMA_D23204_SOLICIT_POST_FORB", by: "2027-01-15" });
  const b = postForbearanceDisposition({ term_end: D("2026-12-31"), qrpc: false, months_delinquent: 4, deferral_eligible: false });
  assert.deepEqual(b, { solicitation: "flex_mod", notice: "NTC_FNMA_D23206_SOLICIT_STREAMLINED", by: "2027-01-15" });
});
test("12.4-T6: (disaster) FEMA IA area, current at disaster, 1 month delinquent \u2192 3-month plan without QRPC; QRPC attempts logged every \u22647 days.", () => {
  const r = disasterForbearanceOffer({ fema_ia: true, current_at_disaster: true, months_delinquent: 1, attempts: [D("2026-10-01"), D("2026-10-08"), D("2026-10-15")] });
  assert.equal(r.months, 3); assert.equal(r.qrpc_required, false); assert.equal(r.attempt_cadence_ok, true); assert.equal(r.max_gap_days, 7);
  assert.match(disasterForbearanceOffer({ fema_ia: false, current_at_disaster: true, months_delinquent: 1, attempts: [] }).refusal!, /FEMA/);
});
test("12.4-T7: (reduced payment miss) reduced payment not received by month-end \u2192 mitigating-circumstances check; termination notice; late charges from the default date only.", () => {
  const r = reducedPaymentMiss({ due_on: D("2026-11-01"), received_cents: 0n, reduced_payment_cents: 100_000n, mitigating_circumstances: false, plan_start: D("2026-10-01") });
  assert.equal(r.missed, true); assert.equal(r.mitigating_check, "performed"); assert.equal(r.terminated, true); assert.equal(r.termination_notice, "NTC_FNMA_D23201_FORB_TERMINATION"); assert.equal(r.late_charges_from, "2026-12-01"); assert.equal(r.late_charges_before_default, 0n);
  assert.equal(reducedPaymentMiss({ due_on: D("2026-11-01"), received_cents: 0n, reduced_payment_cents: 100_000n, mitigating_circumstances: true, plan_start: D("2026-10-01") }).terminated, false);
});
// 12.4-T8 — implemented in src/domain/lossmit/lossmit.test.ts
test("12.4-T9: (holds) 13.3 referral command refused while the plan is active; allowed 1 BD after `terminated{failed_terms}` (subject to 13.1).", () => {
  assert.equal(referralGate({ plan_status: "active", today: D("2026-11-15") }).allowed, false);
  const early = referralGate({ plan_status: "terminated", terminated_reason: "failed_terms", terminated_on: D("2026-12-01"), today: D("2026-12-01") }); assert.equal(early.allowed, false); assert.equal(early.allowed_from, "2026-12-02");
  const ok = referralGate({ plan_status: "terminated", terminated_reason: "failed_terms", terminated_on: D("2026-12-01"), today: D("2026-12-02") }); assert.equal(ok.allowed, true);
});
test("12.4-T10: (Q1 2027 flag) with `smdu.plan_cases=on`, the plan creates an SMDU forbearance case and stops emitting code 09 in the legacy file.", () => {
  assert.deepEqual(planCaseRouting({ smdu_plan_cases: "on", plan_kind: "forbearance" }), { smdu_case_created: true, legacy_status_code_emitted: null });
  assert.deepEqual(planCaseRouting({ smdu_plan_cases: "off", plan_kind: "forbearance" }), { smdu_case_created: false, legacy_status_code_emitted: "09" });
});
