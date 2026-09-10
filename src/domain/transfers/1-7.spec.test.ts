// 1.7 Loss-mit in-flight transfer handling
// spec/sections/01-boarding-servicing-transfer-in/1-7-loss-mit-in-flight-transfer-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM } from "../../kernel/events/index.ts";
import { loadRegistry, TimerEngine } from "../../kernel/timers/index.ts";
import { applyTransferTimerOverrides } from "./timers.ts";
import { runCarryoverChecks, borrowerRequestAllowed, denialSendGate, reissueTimersForRuleSet } from "./inbound.ts";
const REVIEWER = { kind: "human" as const, id: "u-rev", role: "lossmit_reviewer" };

// 1.7-T1 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T2 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T3 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T4 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T5 — implemented in src/domain/transfers/transfers.test.ts
// 1.7-T6 — implemented in src/domain/transfers/transfers.test.ts
test("1.7-T7: Given a transferor file missing the application's received date, then `CO-02` fails, a transferor request is sent within 2 business days, and no borrower request is made before the transferor fails to respond.", () => {
  const r = runCarryoverChecks({ application_received_on: null, documents: [{ name: "710", received_on: D("2026-09-20") }], ack_sent_on: null }, D("2026-10-01"));
  assert.equal(r.status, "file_deficient"); assert.deepEqual(r.failed, ["CO-02"]);
  assert.equal(r.transferor_request_due, "2026-10-05");                        // +2 servicer business days (SM_LOSSMIT_MISSING_DOCS_TRANSFEROR_2)
  assert.equal(r.borrower_request_allowed, false); assert.equal(r.ask_order, "ask_transferor");
  assert.equal(borrowerRequestAllowed(r.transferor_request_due!, false, D("2026-10-05")), false);
  assert.equal(borrowerRequestAllowed(r.transferor_request_due!, false, D("2026-10-06")), true);
  assert.equal(borrowerRequestAllowed(r.transferor_request_due!, true, D("2026-10-06")), false);
});
// 1.7-T8 — implemented in src/domain/transfers/transfers.test.ts
test("1.7-T9: Given the AI proposes a denial, then the determination notice cannot be sent without a `lossmit_reviewer` approval record.", () => {
  const proposed = { kind: "denial" as const, proposed_by: { kind: "agent" as const, id: "lossmit-underwriter" } };
  assert.equal(denialSendGate(proposed, null).ok, false);
  assert.equal(denialSendGate(proposed, { by: { kind: "human", id: "u-ops", role: "ops_analyst" }, decision_id: "d1" }).ok, false);
  assert.equal(denialSendGate(proposed, { by: REVIEWER, decision_id: "d2" }).ok, true);
  assert.equal(denialSendGate({ kind: "offer", proposed_by: proposed.proposed_by }, null).ok, true);
});
test("1.7-T10: Given `regx.lossmit.2024nprm` is switched on for new cases, then inherited cases keep `deemed_received_at` and their existing timers are cancelled with reason `rule_set_change` and re-issued under the new definitions.", () => {
  const clock = new FixedClock("2026-10-01T14:00:00.000Z"); const events = new MemoryEventStore(clock);
  const registry = loadRegistry(); applyTransferTimerOverrides(registry);
  const timers = new TimerEngine(registry, events, { processes: ["1.7"] });
  const boarded = events.append({ type: "loan.boarded", loanId: "L-17", actor: SYSTEM, payload: { transfer_date: "2026-10-01", lossmit_ack_unexpired: true, lossmit_ack_sent: false, deemed_received_at: "2026-09-29" } });
  const before = timers.byCode("REGX_1024_41K2_TRANSFEREE_ACK_10"); assert.equal(before.length, 1); assert.equal(before[0]!.dueDate, "2026-10-16");
  const r = reissueTimersForRuleSet(timers, registry, events, "L-17", boarded, "regx.lossmit.2024nprm", SYSTEM);
  assert.deepEqual(r.cancelled, ["REGX_1024_41K2_TRANSFEREE_ACK_10"]); assert.deepEqual(r.reissued, ["REGX_1024_41K2_TRANSFEREE_ACK_10"]); assert.equal(r.deemed_received_at, "2026-09-29");
  assert.equal(before[0]!.status, "cancelled"); assert.equal(before[0]!.cancelledReason, "rule_set_change");
  const after = timers.byCode("REGX_1024_41K2_TRANSFEREE_ACK_10"); assert.equal(after.length, 2); assert.equal(after[1]!.status, "armed");
  assert.equal(events.ofType("timer.cancelled")[0]!.payload.reason, "rule_set_change");
});
