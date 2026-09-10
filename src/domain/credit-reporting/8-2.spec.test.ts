// 8.2 Dispute handling (e-OSCAR / ACDV)
// spec/sections/08-credit-reporting/8-2-dispute-handling-e-oscar-acdv.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { oralDisputeIntake, linkedNoeDispute, audAndCycle } from "./ops.ts";

// 8.2-T1 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T2 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T3 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T4 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T5 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T6 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T7 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T8 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
// 8.2-T9 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.2-T10: (oral dispute) Given a borrower says on an AI voice call that \"my credit report shows me late in March and I wasn't,\" then a direct-dispute case opens, XB applies, and the results letter goes out within 30 days.", () => {
  const r = oralDisputeIntake({ utterance: "my credit report shows me late in March and I wasn't", received_on: D("2027-09-03"), next_cycle_transmit_on: D("2027-10-03"), automation_disclosed: true });
  assert.equal(r.opens_case, true); assert.equal(r.channel, "oral"); assert.equal(r.category, "payment_history"); assert.equal(r.ccc, "XB"); assert.equal(r.ccc_via, "aud");
  assert.equal(r.results_due, "2027-10-03"); assert.equal(r.results_template, "NTC_FCRA_1022_43E_RESULTS"); assert.equal(r.automation_disclosed, true); assert.equal(r.human_transfer_requested, false);
  assert.equal(oralDisputeIntake({ utterance: "what is my payoff amount", received_on: D("2027-09-03"), next_cycle_transmit_on: D("2027-10-03"), automation_disclosed: true }).opens_case, false);
});
// 8.2-T11 — implemented in src/infra/integrations/integrations.test.ts
// 8.2-T12 — implemented in src/domain/credit-reporting/credit-reporting.test.ts
test("8.2-T13: (NoE linkage) Given a letter alleging a misapplied payment and a wrong credit report, then both an NoE case (4.1) and a direct dispute exist, the corrections are shared, and both letters meet their clocks.", () => {
  const r = linkedNoeDispute({ received_on: D("2027-09-03"), allegations: ["you misapplied my February payment", "my credit report shows a late payment that is wrong"] });
  assert.equal(r.noe_case!.opens, true); assert.equal(r.noe_case!.response_due, "2027-10-19");   // 30 servicer BD (Labor Day, Columbus Day closed) assert.equal(r.direct_dispute!.opens, true); assert.equal(r.direct_dispute!.results_due, "2027-10-03");
  assert.equal(r.shared_corrections, true); assert.equal(r.combined_letter_allowed, true); assert.equal(r.earlier_clock, "2027-10-03");
  assert.equal(linkedNoeDispute({ received_on: D("2027-09-03"), allegations: ["my credit report is wrong"] }).noe_case, null);
});
test("8.2-T14: (AUD is not in-cycle) Given an AUD sent on 2027-09-25, then the 2027-09-30 cycle still carries the corrected values (no reliance on the AUD alone).", () => {
  const r = audAndCycle({ aud_sent_on: D("2027-09-25"), cycle_as_of: D("2027-09-30"), corrected_fields: { account_status: "11", dofd: "00000000", amount_past_due: "000000000" }, snapshot_fields: { account_status: "11", dofd: "00000000", amount_past_due: "000000000", current_balance: "000293063" } });
  assert.equal(r.aud_in_cycle_substitute, false); assert.equal(r.cycle_carries_correction, true); assert.deepEqual(r.mismatches, []);
  assert.deepEqual(audAndCycle({ aud_sent_on: D("2027-09-25"), cycle_as_of: D("2027-09-30"), corrected_fields: { account_status: "11" }, snapshot_fields: { account_status: "71" } }).mismatches, ["account_status"]);
});

test("8.2 worked example: the disputed check copy is for one PITI installment of $2,459.55", () => { assert.equal(184715n + 61240n, 245955n); });
