// 5.1 Loan Activity Report (LAR) submission
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-1-loan-activity-report-lar-submission.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { fannieBusinessDay } from "./period.ts";
import { scheduledMonth } from "./remittance.ts";
import { ET, triageHardReject, headOfLine, postCloseRemovalError, escrowDepositRouting, bulkAckWatch, workException, LAR_DECISION_FIELDS, softRejectInterest, closeSoftRejectAtPeriodClose } from "./ops.ts";

// 5.1-T1 — implemented in src/domain/investor/investor.test.ts
// 5.1-T2 — implemented in src/domain/investor/investor.test.ts
// 5.1-T3 — implemented in src/domain/investor/investor.test.ts
test("5.1-T4: Given a hard reject \"LPI mismatch\" received 2026-10-14 09:40 ET, when triage finds a ledger posting error, then a Section 2 correction, a superseding event with a new sequence and the same period are accepted before BD1 of the next month; head-of-line blocking prevents later events for that loan from being sent first.", () => {
  const received = zonedEpochMs(D("2026-10-14"), "09:40", ET);
  const t = triageHardReject({ received_at_ms: received, root_cause: "ledger_error", confidence: 0.95, event: { id: "ev-1", sequence: 7, activity_period: "2026-10" } });
  assert.equal(t.route, "section2_correction"); assert.equal(t.correction_command, "cashiering.correction.post");
  assert.deepEqual(t.superseding_event, { sequence: 8, supersedes_event_id: "ev-1", activity_period: "2026-10" });
  assert.equal(toIso(t.triage_due_ms), toIso(zonedEpochMs(D("2026-10-14"), "13:40", ET)));
  assert.equal(fannieBusinessDay(D("2026-11-01"), 1), "2026-11-02");
  assert.equal(toIso(t.resubmit_by_ms), toIso(zonedEpochMs(D("2026-11-02"), "20:00", ET)));            // BD1 20:00 ET of the next month
  // head-of-line: the superseding event goes first; later events for the loan wait behind it
  const q = headOfLine([{ id: "ev-1", loan_id: "L", sequence: 7, status: "superseded" }, { id: "ev-2", loan_id: "L", sequence: 8, status: "projected", supersedes_event_id: "ev-1" }, { id: "ev-3", loan_id: "L", sequence: 9, status: "queued" }, { id: "ev-9", loan_id: "M", sequence: 1, status: "queued" }]);
  assert.deepEqual(q.sendable.map((e) => e.id), ["ev-2", "ev-9"]); assert.deepEqual(q.blocked.map((e) => e.id), ["ev-3"]);
});
test("5.1-T5: Given a payoff LAR accepted in October 2026 and the error discovered 2026-11-05, then no correction is projected, a `qc_finding` case opens, and the remit/advance amount is computed.", () => {
  const r = postCloseRemovalError({ accepted_period: "2026-10", discovered_at_ms: zonedEpochMs(D("2026-11-05"), "10:00", ET), reported_principal_cents: 24908861n, reported_interest_cents: 124544n });
  assert.equal(toIso(r.close_ms), toIso(zonedEpochMs(D("2026-11-03"), "17:00", ET)));                  // BD2 17:00 ET closed the October period
  assert.equal(r.after_close, true); assert.equal(r.correction_projected, false); assert.equal(r.case, "qc_finding");
  assert.equal(r.fnma_liquidated_in_error, true); assert.equal(r.amount_due_cents, 24908861n + 124544n); assert.equal(r.escalation, "officer");
});
test("5.1-T6: Given `investor_reporting.escrow.deposit.mode=dual`, when an escrow deposit posts, then JSON goes to `api-clve` and no LAR is created (escrow has no LAR); when `mode=event` on 2026-12-01, the JSON goes to production and must be submitted by 03:00 ET next BD.", () => {
  const dual = escrowDepositRouting("dual", zonedEpochMs(D("2026-10-20"), "10:00", ET));
  assert.equal(dual.json_env, "api-clve"); assert.equal(dual.lar, null); assert.equal(dual.submit_by_ms, null);
  const ev = escrowDepositRouting("event", zonedEpochMs(D("2026-12-01"), "10:00", ET));
  assert.equal(ev.json_env, "production"); assert.equal(ev.lar, null);
  assert.equal(toIso(ev.submit_by_ms!), toIso(zonedEpochMs(D("2026-12-02"), "03:00", ET)));
});
test("5.1-T7: Given a bulk file still unacknowledged at BD2 14:00 ET, then the adapter re-sends once and, failing an ack by 14:30, opens a `human_portal_task` with the file, due 15:00 ET.", () => {
  const bd2 = fannieBusinessDay(D("2026-11-01"), 2); assert.equal(bd2, "2026-11-03");
  const at = (hhmm: string) => zonedEpochMs(bd2, hhmm, ET);
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: false, resent: false, now_ms: at("13:59"), bd2 }).action, "wait");
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: false, resent: false, now_ms: at("14:00"), bd2 }).action, "resend");
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: false, resent: true, now_ms: at("14:15"), bd2 }).action, "wait");
  const esc = bulkAckWatch({ file_id: "F-1", acked: false, resent: true, now_ms: at("14:30"), bd2 });
  assert.equal(esc.action, "portal_task"); assert.equal(esc.task!.kind, "human_portal_task"); assert.equal(esc.task!.file_id, "F-1");
  assert.equal(toIso(esc.task!.due_ms), toIso(at("15:00")));
  assert.equal(bulkAckWatch({ file_id: "F-1", acked: true, resent: true, now_ms: at("14:40"), bd2 }).action, "done");
});
// 5.1-T8 — implemented in src/domain/investor/investor.test.ts
// 5.1-T9 — implemented in src/domain/investor/investor.test.ts
// 5.1-T10 — implemented in src/domain/investor/investor.test.ts
test("5.1-T11: Given the agent is disabled, then the exception queue is worked by a human with identical decision-record fields and all timers still fire.", () => {
  const base = { event_id: "ev-1", exception_code: "LPI_MISMATCH", root_cause: "ledger_error" as const, evidence: ["doc-1"], action: "section2_correction", deadline_at: "2026-11-02T20:00:00-05:00", confidence: 1, rule_set_version: "irm-2026-09" };
  const human = workException({ agent_enabled: false, actor: { kind: "human", id: "ops-7" }, ...base });
  assert.deepEqual(Object.keys(human.record), [...LAR_DECISION_FIELDS]); assert.equal(human.worked_by, "human"); assert.equal(human.timers_fire, true);
  const agent = workException({ agent_enabled: true, actor: { kind: "agent", id: "investor-reporting" }, ...base, model_version: "m-1" });
  assert.deepEqual(Object.keys(agent.record), Object.keys(human.record));                                // identical decision-record fields
  assert.throws(() => workException({ agent_enabled: false, actor: { kind: "agent", id: "investor-reporting" }, ...base }), /worked by a human/);
});
test("5.1-T12: Given a soft reject on interest where Fannie Mae's expected interest ignores a mid-month curtailment, then the agent produces a Master Servicing package with pay history and the event closes `accepted_as_is` at period close with the decision record attached.", () => {
  const s = softRejectInterest({ our_interest_cents: 118750n, fnma_expected_cents: 125000n, curtailment_in_period: true, pay_history: [{ date: D("2026-10-05"), amount_cents: 158017n, kind: "contractual" }, { date: D("2026-10-15"), amount_cents: 1250000n, kind: "curtailment" }] });
  assert.equal(s.route, "master_servicing@fanniemae.com"); assert.equal(s.status, "rejected_soft"); assert.equal(s.package!.pay_history.length, 2); assert.equal(s.variance_cents, -6250n);
  const closed = closeSoftRejectAtPeriodClose({ fnma_adjusted: false, decision_id: "dec-1" });
  assert.equal(closed.status, "accepted"); assert.equal(closed.resolution, "accepted_as_is"); assert.equal(closed.decision_id, "dec-1");
  assert.equal(softRejectInterest({ our_interest_cents: 118750n, fnma_expected_cents: 125000n, curtailment_in_period: false, pay_history: [] }).route, "correct");
});

test("5.1 worked example: S/S MBS $250,000.00 at 6.500%/PTR 6.000%, P&I $1,580.17 → LAR 96 interest $1,250.00, principal $226.00, UPB $249,774.00", () => {
  const m = scheduledMonth(25000000n, "6.500", "6.000", 158017n);
  assert.equal(m.gross_interest_cents, 135417n); assert.equal(m.scheduled_principal_cents, 22600n); assert.equal(m.ending_scheduled_upb_cents, 24977400n); assert.equal(m.fnma_interest_cents, 125000n);
});
