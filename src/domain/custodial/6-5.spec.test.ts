// 6.5 Unidentified/unapplied funds management
// spec/sections/06-custodial-account-management/6-5-unidentified-unapplied-funds-management.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { partialAccumulation, partialReturnSweep, fiftyDollarRule, applyOnAccumulation, suspenseAging, aiOutreachContact } from "./ops.ts";

test("6.5-T1: Given P = $1,842.17, receipts $1,500.00 (10/03) and $342.17 (10/20) with conditions met, then one payment is applied `credited_as_of` 2026-10-20, suspense = $0.00, both notices/statement lines produced; timer `FNMA_C1102_PARTIAL_BALANCE_30` satisfied.", () => {
  const r = partialAccumulation({ periodic_payment_cents: 184217n, receipts: [{ on: D("2026-10-03"), amount_cents: 150000n, rail: "ach_credit", originating_account_last4: "8831" }, { on: D("2026-10-20"), amount_cents: 34217n, rail: "ach_credit", originating_account_last4: "8831" }], conditions_met: true });
  assert.equal(r.applied, true); assert.equal(r.credited_as_of, "2026-10-20"); assert.equal(r.suspense_cents, 0n); assert.equal(r.partial_commitment_due_on, "2026-11-02");
  assert.deepEqual(r.statement_lines, [{ on: "2026-10-03", held_cents: 150000n }, { on: "2026-10-20", held_cents: 0n }]);
  assert.equal(r.notices.length, 2); assert.equal(r.timer_satisfied, "FNMA_C1102_PARTIAL_BALANCE_30"); assert.equal(r.satisfied_by, "suspense.accumulation.sufficient");
});
test("6.5-T2: Given the same first receipt and nothing by 2026-11-02, then on 2026-11-03 the $1,500.00 is returned by ACH to the originating account, `SUSP-PARTIAL-RETURN-v1` sent, status `returned`.", () => {
  const base = { received_on: D("2026-10-03"), amount_cents: 150000n, rail: "ach_credit" as const, originating_account_last4: "8831", held_cents: 150000n, periodic_payment_cents: 184217n, active_lossmit_case: false };
  assert.equal(partialReturnSweep({ ...base, today: D("2026-11-02") }).status, "open");
  const r = partialReturnSweep({ ...base, today: D("2026-11-03") });
  assert.equal(r.due_on, "2026-11-02"); assert.equal(r.returned, true); assert.equal(r.returned_on, "2026-11-03"); assert.equal(r.rail, "ach_credit"); assert.match(r.destination!, /8831/); assert.equal(r.notice, "SUSP-PARTIAL-RETURN-v1"); assert.equal(r.status, "returned");
  assert.equal(partialReturnSweep({ ...base, today: D("2026-11-03"), active_lossmit_case: true }).status, "lossmit_hold");
});
test("6.5-T3: Given a payment $1,800.00 vs P $1,842.17 (deficiency $42.17), instrument dated 2005, `partial_count_12m = 2`, then the $50 rule applies (escrow reduced by $42.17, payment applied as of receipt) and the count becomes 3; a fourth such payment within 12 months is treated as an ordinary partial.", () => {
  const r = fiftyDollarRule({ amount_cents: 180000n, periodic_payment_cents: 184217n, instrument_date: D("2005-06-01"), partial_count_12m: 2, received_on: D("2026-10-05") });
  assert.equal(r.applies, true); assert.equal(r.deficiency_cents, 4217n); assert.equal(r.escrow_reduction_cents, 4217n); assert.equal(r.credited_as_of, "2026-10-05"); assert.equal(r.partial_count_12m_after, 3); assert.equal(r.treatment, "fifty_dollar_rule");
  const fourth = fiftyDollarRule({ amount_cents: 180000n, periodic_payment_cents: 184217n, instrument_date: D("2005-06-01"), partial_count_12m: 3, received_on: D("2026-11-05") });
  assert.equal(fourth.applies, false); assert.equal(fourth.treatment, "ordinary_partial"); assert.equal(fourth.escrow_reduction_cents, 0n);
  assert.equal(fiftyDollarRule({ amount_cents: 180000n, periodic_payment_cents: 184217n, instrument_date: D("1998-06-01"), partial_count_12m: 0, received_on: D("2026-10-05") }).applies, false);
});
// 6.5-T4 — implemented in src/domain/custodial/custodial.test.ts
// 6.5-T5 — implemented in src/domain/custodial/custodial.test.ts
test("6.5-T6: Given \u03a3 unapplied on a loan reaches P on a Friday, then the application is posted with `credited_as_of` Friday even if the job runs Monday (Reg Z), and the `REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD` timer is satisfied.", () => {
  const r = applyOnAccumulation({ accumulated_on: D("2026-10-16"), job_run_on: D("2026-10-19"), periodic_payment_cents: 184217n, held_cents: 184217n });
  assert.equal(r.apply, true); assert.equal(r.credited_as_of, "2026-10-16"); assert.equal(r.due_on, "2026-10-19"); assert.equal(r.on_time, true);
  assert.equal(r.timer, "REGZ_1026_36C_APPLY_ON_ACCUMULATION_1BD"); assert.equal(r.satisfied_by, "payment.applied{credited_as_of=2026-10-16}");
  assert.equal(applyOnAccumulation({ accumulated_on: D("2026-10-16"), job_run_on: D("2026-10-19"), periodic_payment_cents: 184217n, held_cents: 150000n }).apply, false);
});
// 6.5-T7 — implemented in src/domain/custodial/custodial.test.ts
test("6.5-T8: Given an item aged 90 days in `researching`, then `officer` high escalation and the partner aging report line.", () => {
  const r = suspenseAging({ item_id: "S-77", loan_id: null, amount_cents: 125000n, status: "researching", received_on: D("2026-07-10"), today: D("2026-10-08") });
  assert.equal(r.aging_days, 90); assert.equal(r.terminal, false); assert.deepEqual(r.escalation, { role: "officer", severity: "high" }); assert.match(r.partner_report_line!, /S-77 .* researching .* 90 days/);
  assert.equal(suspenseAging({ item_id: "S-78", loan_id: "L-1", amount_cents: 1n, status: "applied", received_on: D("2026-07-10"), today: D("2026-10-08") }).escalation, null);
  assert.equal(suspenseAging({ item_id: "S-79", loan_id: null, amount_cents: 1n, status: "researching", received_on: D("2026-07-11"), today: D("2026-10-08") }).escalation, null);
});
test("6.5-T9: Given a borrower on an AI outreach call asks for a person, then warm transfer to `human_agent` and the contact record shows `mode = ai_voice`, disclosure given, transfer time.", () => {
  const c = aiOutreachContact({ utterance: "I want to talk to a real person about this", at: "2026-10-08T14:05:00-04:00", disclosure_given: true });
  assert.equal(c.mode, "ai_voice"); assert.equal(c.disclosure_given, true); assert.equal(c.human_transfer_requested, true); assert.equal(c.transfer_to, "human_agent"); assert.equal(c.transfer_time, "2026-10-08T14:05:00-04:00");
  assert.equal(aiOutreachContact({ utterance: "yes I sent the second half on Friday", at: "2026-10-08T14:06:00-04:00", disclosure_given: true }).transfer_to, null);
});
// 6.5-T10 — implemented in src/domain/custodial/custodial.test.ts
