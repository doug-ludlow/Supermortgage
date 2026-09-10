// 1.5 MERS transfer of servicing/beneficial rights
// spec/sections/01-boarding-servicing-transfer-in/1-5-mers-transfer-of-servicing-beneficial-rights.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { cents } from "../../kernel/money/cents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_01_TOOLS } from "../../app/tools/section01.ts";
import { FakeMers } from "../../infra/integrations/mers.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { BoardingService } from "../boarding/service.ts";
import { stagedLoan, batchContext, FakePositions, PARTNER_ORG } from "../boarding/fixtures.ts";
import { makeMin } from "../boarding/min.ts";
import { mersTransaction, mersIntegrity, mersClocks, violationResponseDue } from "./custody-mers.ts";
import { tosExpectations, ingestMersAcknowledgement, registrationFeeAccrual, planMersTransactions, recordMersAcknowledgement, mreMismatchFinding, verifyPostTransferSnapshots, violationNoticeReceived, approvedPayload, cutoverPayload, SUPERMORTGAGE_ORG_ID, FANNIE_MAE_MERS_ORG_ID } from "./inbound.ts";
import { recordTosPendingNotices, recordTosConfirmations, tosConfirmBy, noticeDateOf, mreReceived, reconcileExtract, lockoutWarningReceived, violationRemediated, lockoutRemediated, submitAnnualReport, annualReportChecks, mersBatchFees, submitAuthorization, type PendingTransferNotice } from "./ops-1-5.ts";
const AGENT: Actor = { kind: "agent", id: "transfer" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const SELLER_ORG = "1002345";
const MINS = ["1", "2", "3"].map((s) => makeMin(PARTNER_ORG, s));
const APPROVAL = { d_code: "D12", fnma_consent_document_id: "doc-c", consent_document_hash: "sha" };
/** The registry every service loads (section + process overrides), the engine filtered to 1.5 unless a test needs a sibling's owning row. */
function harness(nowIso: string, processes: string[] = ["1.5"]) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const registry = loadOverriddenRegistry();
  return { clock, events, registry, timers: new TimerEngine(registry, events, { processes }), esc: new EscalationService(events, clock) };
}
const tosNotice = (min: string, noticedAt = "2026-09-29", fromOrgId = SELLER_ORG, type: "tos" | "tob" = "tos"): PendingTransferNotice => ({ min, fromOrgId, type, noticedAt });

test("1.5-T1: Given a `master_to_sub` batch, then no TOS/TOB transactions are generated and every MIN has a `min_update_subservicer` row with effective date = transfer date.", () => {
  assert.equal(mersTransaction("master_to_sub"), "min_update_subservicer"); assert.equal(mersTransaction("servicing_sale_with_sub"), "tos_seller_initiated"); assert.equal(mersTransaction("custodian_only"), "none");
  const plan = planMersTransactions({ type: "master_to_sub", transfer_date: D("2026-10-01"), mins: MINS.map((min, i) => ({ min, loan_id: `L-${i + 1}` })), partner_org_id: PARTNER_ORG });
  assert.equal(plan.tos, false); assert.equal(plan.tob, false); assert.equal(plan.submit_in_batch_of, "2026-09-30");                       // the T-1 evening batch
  assert.equal(plan.transactions.length, 3);
  assert.ok(plan.transactions.every((t) => t.txn_type === "min_update_subservicer" && t.effective_date === "2026-10-01" && t.submitted_by_org_id === SUPERMORTGAGE_ORG_ID));
  assert.ok(!plan.transactions.some((t) => t.txn_type === "tos_initiate" || t.txn_type === "tos_confirm" || t.txn_type === "tob_confirm"));
  assert.deepEqual(plan.transactions.map((t) => t.min), MINS);
  assert.equal(planMersTransactions({ type: "custodian_only", transfer_date: D("2026-10-01"), mins: [{ min: MINS[0]! }], partner_org_id: PARTNER_ORG }).transactions.length, 0);
  // MERS_PROC_SUBSERVICER_MIN_UPDATE_T0 (armed by the approval, due T-0) is satisfied only when the acknowledgment accepts every MIN.
  const h = harness("2026-09-05T14:00:00.000Z");
  h.events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: approvedPayload({ batch_id: "B1", type: "master_to_sub", transfer_date: D("2026-10-01") }, APPROVAL) });
  const t = h.timers.byCode("MERS_PROC_SUBSERVICER_MIN_UPDATE_T0"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-01");
  assert.equal(h.timers.byCode("MERS_PROC_TOS_INITIATE_T0").length, 0, "no TOS for a master_to_sub batch");
  h.clock.set("2026-10-01T12:00:00.000Z");
  const partial = recordMersAcknowledgement(h.events, "B1", plan.transactions, [{ min: MINS[0]!, accepted: true }, { min: MINS[1]!, accepted: true }, { min: MINS[2]!, accepted: false, reason: "MIN inactive" }], D("2026-10-01"));
  assert.deepEqual([partial.accepted, partial.rejected, partial.all_mins, t[0]!.status], [2, 1, false, "armed"]);
  const rest = recordMersAcknowledgement(h.events, "B1", plan.transactions, [{ min: MINS[0]!, accepted: true }, { min: MINS[1]!, accepted: true }, { min: MINS[2]!, accepted: true }], D("2026-10-01"));
  assert.equal(rest.all_mins, true); assert.equal(t[0]!.status, "satisfied"); assert.equal(rest.batch_event!.payload.txn_type, "min_update_subservicer");
  assert.equal(h.events.ofType("mers.txn.accepted").filter((e) => e.loanId === "L-1").length, 2);
  // the MIN Update file is free; only registrations are priced, to the partner's MERS invoice
  assert.deepEqual([mersBatchFees(plan.transactions, "partner-1").total_cents, mersBatchFees(plan.transactions, "partner-1").transfers], [0n, 3]);
});
test("1.5-T2: Given a `servicing_sale_with_sub` batch, then TOS pending notices are expected from the seller and confirmation timers (7 days [UNVERIFIED]) are created per MIN.", () => {
  const t = tosExpectations({ type: "servicing_sale_with_sub", mins: ["100012300000000015", "100012300000000023"], pending_received_on: D("2026-09-29") });
  assert.equal(t.tos_expected, true); assert.deepEqual(t.confirmations.map((c) => c.confirm_by), ["2026-10-06", "2026-10-06"]);   // MERS_PROC_TOS_CONFIRM_7 per MIN
  assert.equal(tosExpectations({ type: "master_to_sub", mins: ["x"] }).tos_expected, false);
  assert.equal(tosConfirmBy(D("2026-09-29")), "2026-10-06");                                                                           // worked example 2
  // The plan: buyer-side confirmations under the partner's Org ID, one per MIN; no MIN Update, no TOB.
  const plan = planMersTransactions({ type: "servicing_sale_with_sub", transfer_date: D("2026-10-01"), mins: MINS.map((min, i) => ({ min, loan_id: `L-${i + 1}` })), partner_org_id: PARTNER_ORG });
  assert.equal(plan.tos, true); assert.ok(plan.transactions.every((r) => r.txn_type === "tos_confirm" && r.submitted_by_org_id === PARTNER_ORG && r.effective_date === "2026-10-01"));
  // Approval arms the transferor's T0 duty (MERS_PROC_TOS_INITIATE_T0, due the transfer date), not the Subservicer MIN Update clock.
  const h = harness("2026-09-05T14:00:00.000Z");
  h.events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: approvedPayload({ batch_id: "B1", type: "servicing_sale_with_sub", transfer_date: D("2026-10-01") }, APPROVAL) });
  const t0 = h.timers.byCode("MERS_PROC_TOS_INITIATE_T0"); assert.equal(t0.length, 1); assert.equal(t0[0]!.dueDate, "2026-10-01");
  assert.equal(h.timers.byCode("MERS_PROC_SUBSERVICER_MIN_UPDATE_T0").length, 0, "a servicing sale has no Subservicer MIN Update");
  // Sept. 29: the seller initiates the TOS and MERS notices the buyer. A TOB notice and a notice from a stranger Org ID are ignored; each valid notice arms the 7-day confirmation clock on its MIN.
  h.clock.set("2026-09-29T21:00:00.000Z");
  const partial = recordTosPendingNotices(h.events, "B1", plan.transactions, [tosNotice(MINS[0]!, "2026-09-29T17:30:00.000Z"), tosNotice(MINS[1]!), tosNotice(MINS[2]!, "2026-09-29", SELLER_ORG, "tob"), tosNotice(MINS[2]!, "2026-09-29", "1009876")], { seller_org_id: SELLER_ORG });
  assert.deepEqual([partial.expected, partial.received, partial.missing, partial.all_mins, partial.batch_event], [3, 2, [MINS[2]!], false, null]);
  assert.deepEqual(partial.ignored.map((x) => x.min), [MINS[2]!, MINS[2]!]); assert.match(partial.ignored[0]!.reason, /tob_not_applicable/); assert.match(partial.ignored[1]!.reason, /not the transferor 1002345/);
  assert.equal(t0[0]!.status, "armed", "the transferor duty is met only once every planned MIN is noticed");
  const perMin = h.timers.byCode("MERS_PROC_TOS_CONFIRM_7");
  assert.deepEqual(perMin.map((x) => [x.subject.id, x.dueDate, x.anchorDate]), [["L-1", "2026-10-06", "2026-09-29"], ["L-2", "2026-10-06", "2026-09-29"]]);   // +7 CD from the notice date (ET) [UNVERIFIED]
  assert.equal(noticeDateOf("2026-09-30T02:30:00.000Z"), "2026-09-29", "a 10:30 pm ET notice is still Sept. 29");
  const rest = recordTosPendingNotices(h.events, "B1", plan.transactions, [tosNotice(MINS[2]!)], { seller_org_id: SELLER_ORG, previously_received: [MINS[0]!, MINS[1]!] });
  assert.deepEqual([rest.received, rest.all_mins, rest.confirm_by, rest.batch_event!.payload.all_mins, rest.batch_event!.payload.initiated_by], [3, true, "2026-10-06", true, "transferor"]);
  assert.equal(t0[0]!.status, "satisfied");
  const all7 = h.timers.byCode("MERS_PROC_TOS_CONFIRM_7"); assert.equal(all7.length, 4, "three per-MIN clocks and the batch-level one"); assert.ok(all7.every((x) => x.dueDate === "2026-10-06" && x.status === "armed"));
  // Oct. 2–5: the buyer confirms; MERS acknowledges. A rejected confirmation is a 1.1 exception and leaves that MIN's clock armed; 100% confirmed closes the batch-level clock too.
  h.clock.set("2026-10-02T14:00:00.000Z");
  const p2 = recordTosConfirmations(h.events, "B1", plan.transactions, [{ min: MINS[0]!, accepted: true }, { min: MINS[1]!, accepted: false, reason: "NO_PENDING_TOS" }], D("2026-10-02"));
  assert.deepEqual([p2.confirmed, p2.rejected, p2.all_mins, p2.exceptions[0]!.kind], [1, 1, false, "mers_rejected"]);
  assert.deepEqual(all7.map((x) => x.status), ["satisfied", "armed", "armed", "armed"]);
  assert.equal(h.events.ofType("mers.txn.rejected").length, 1);
  h.clock.set("2026-10-05T14:00:00.000Z");
  const full = recordTosConfirmations(h.events, "B1", plan.transactions, MINS.map((min) => ({ min, accepted: true })), D("2026-10-05"));
  assert.deepEqual([full.all_mins, full.batch_event!.payload.txn_type, full.batch_event!.payload.confirmed], [true, "tos_confirm", 3]);
  assert.ok(all7.every((x) => x.status === "satisfied")); assert.equal(h.timers.evaluate("2026-10-07T04:00:00.000Z").length, 0, "nothing breaches after the window");
  assert.ok(eventMatches(h.registry.get("MERS_PROC_TOS_CONFIRM_7")!.satisfiedPattern!, full.batch_event!)); assert.ok(eventMatches(h.registry.get("MERS_PROC_TOS_INITIATE_T0")!.satisfiedPattern!, rest.batch_event!));
  // A master_to_sub plan carries no TOS: pending notices for it are refused, not recorded.
  const sub = planMersTransactions({ type: "master_to_sub", transfer_date: D("2026-10-01"), mins: [{ min: MINS[0]! }], partner_org_id: PARTNER_ORG });
  assert.throws(() => recordTosPendingNotices(h.events, "B2", sub.transactions, [tosNotice(MINS[0]!)]), RangeError);
  assert.throws(() => recordTosConfirmations(h.events, "B2", sub.transactions, [{ min: MINS[0]!, accepted: true }], D("2026-10-05")), RangeError);
});
test("1.5-T3: Given a MIN whose MERS snapshot shows a different property address than the tape, then the update is blocked and a `mre_mismatch` finding exists.", () => {
  assert.deepEqual(mersIntegrity({ borrower: "A", property: "1 Main", subservicer: "X" }, { borrower: "A", property: "2 Main", subservicer: "Y" }, ["subservicer"]), ["property"]);
  const r = mreMismatchFinding({ borrower: "A", property: "1 Main", subservicer: "X" }, { borrower: "A", property: "2 Main", subservicer: "Y" }, ["subservicer"], MINS[0]!, D("2026-09-30"));
  assert.equal(r.blocked, true); assert.deepEqual(r.discrepancies, ["property"]);
  assert.deepEqual(r.finding, { kind: "mre_mismatch", min: MINS[0]!, fields: ["property"], raised_at: "2026-09-30", due_at: "2026-10-07", resolved_at: null });
  const clean = mreMismatchFinding({ borrower: "A", property: "1 Main", subservicer: "X" }, { borrower: "A", property: "1 Main", subservicer: "Y" }, ["subservicer"], MINS[0]!, D("2026-09-30"));
  assert.equal(clean.blocked, false); assert.equal(clean.finding, null);   // the field being changed is not a discrepancy
  // The same rule over an extract: only the mismatched MIN is blocked; the run is the Org ID's `mers.recon.completed`.
  const h = harness("2026-09-30T14:00:00.000Z");
  const run = reconcileExtract(h.events, { org_id: SUPERMORTGAGE_ORG_ID, received_on: D("2026-09-30"), rows: [
    { min: MINS[0]!, system_of_record: { borrower: "A", property: "1 Main", subservicer: "X" }, snapshot: { borrower: "A", property: "2 Main", subservicer: "Y" }, changing: ["subservicer"] },
    { min: MINS[1]!, system_of_record: { borrower: "B", property: "9 Elm", subservicer: "X" }, snapshot: { borrower: "B", property: "9 Elm", subservicer: "Y" }, changing: ["subservicer"] }] });
  assert.deepEqual([run.mins, run.clean, run.blocked, run.findings[0]!.kind, run.findings[0]!.fields], [2, 1, [MINS[0]!], "mre_mismatch", ["property"]]);
  assert.deepEqual([run.event.type, run.event.aggregate, run.event.payload.blocked_mins], ["mers.recon.completed", { kind: "mers_org", id: SUPERMORTGAGE_ORG_ID }, [MINS[0]!]]);
});
test("1.5-T4: Given 10 rejected MINs in the acknowledgment file, then 10 boarding exceptions are open and the batch report shows 99.8% accepted.", () => {
  const results = Array.from({ length: 5000 }, (_, i) => (i < 10 ? { min: `MIN-${i}`, accepted: false, reason: "MIN inactive" } : { min: `MIN-${i}`, accepted: true }));
  const r = ingestMersAcknowledgement(results);
  assert.deepEqual([r.accepted, r.rejected, r.accepted_pct, r.exceptions.length], [4990, 10, 99.8, 10]);
  assert.deepEqual(r.exceptions[0], { min: "MIN-0", kind: "mers_rejected", reason: "MIN inactive" });
});
test("1.5-T5: Given transfer date Oct. 1, 2026, then `SM_MERS_POST_TRANSFER_VERIFY_3` is due Oct. 6, 2026; verification of 100% by Oct. 5 satisfies it.", () => {
  assert.equal(mersClocks(D("2026-10-01")).verify_by, "2026-10-06");
  const h = harness("2026-10-01T14:00:00.000Z");
  h.events.append({ type: "transfer.batch.cutover_completed", aggregate: { kind: "transfer_batch", id: "B1" }, actor: SYSTEM, payload: cutoverPayload({ batch_id: "B1", type: "master_to_sub", transfer_date: D("2026-10-01") }) });
  const t = h.timers.byCode("SM_MERS_POST_TRANSFER_VERIFY_3"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-06");
  const snap = (min: string, sub: string | null = SUPERMORTGAGE_ORG_ID) => ({ min, status: "active", servicer_org_id: PARTNER_ORG, subservicer_org_id: sub, investor_org_id: FANNIE_MAE_MERS_ORG_ID });
  h.clock.set("2026-10-05T14:00:00.000Z");
  const partial = verifyPostTransferSnapshots(h.events, "B1", [snap(MINS[0]!), snap(MINS[1]!), snap(MINS[2]!, null)], { partner_org_id: PARTNER_ORG, mins: MINS }, D("2026-10-05"));
  assert.deepEqual([partial.verified, partial.total, partial.all_mins, t[0]!.status], [2, 3, false, "armed"]); assert.match(partial.issues[0]!.problems[0]!, /subservicer none/);
  const full = verifyPostTransferSnapshots(h.events, "B1", MINS.map((m) => snap(m)), { partner_org_id: PARTNER_ORG, mins: MINS }, D("2026-10-05"));
  assert.deepEqual([full.verified_pct, full.all_mins, t[0]!.status], [100, true, "satisfied"]);
});
test("1.5-T6: Given a MERS-eligible loan boarded Oct. 1 with no MIN, then registration is due Oct. 8, 2026.", () => {
  assert.equal(mersClocks(D("2026-10-01")).registration_due_for_unregistered, "2026-10-08");
  const h = harness("2026-10-01T14:00:00.000Z", ["1.1", "1.5"]);   // the registry's owning row for the code is the 1.1 one
  h.events.append({ type: "loan.boarded", loanId: "L-nomin", actor: SYSTEM, payload: { min: null, mers_eligible: true, transfer_date: "2026-10-01", escrowed: false } });
  const t = h.timers.byCode("MERS_PROC_REGISTER_UNREGISTERED_7"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-10-08");
  h.events.append({ type: "loan.boarded", loanId: "L-min", actor: SYSTEM, payload: { min: MINS[0], mers_eligible: true, transfer_date: "2026-10-01", escrowed: false } });
  assert.equal(h.timers.byCode("MERS_PROC_REGISTER_UNREGISTERED_7").length, 1, "a loan with a MIN needs no registration");
  const newMin = makeMin(SUPERMORTGAGE_ORG_ID, "77");
  h.clock.set("2026-10-06T14:00:00.000Z");
  recordMersAcknowledgement(h.events, "B1", [{ min: newMin, loan_id: "L-nomin", txn_type: "registration", effective_date: D("2026-10-06"), submitted_by_org_id: SUPERMORTGAGE_ORG_ID, status: "prepared" }], [{ min: newMin, accepted: true }], D("2026-10-06"));
  assert.equal(t[0]!.status, "satisfied");
  assert.equal(registrationFeeAccrual(newMin, "partner-1").borrower_charge, false);
});
test("1.5-T7: Given a Violation notice dated Nov. 10, 2026, then the response/remediation timer is due Dec. 10, 2026 and an `officer` task is open.", () => {
  assert.equal(violationResponseDue(D("2026-11-10")), "2026-12-10");
  const h = harness("2026-11-10T15:00:00.000Z");
  const r = violationNoticeReceived(h.events, h.esc, { notice_on: D("2026-11-10"), org_id: SUPERMORTGAGE_ORG_ID, description: "Rule 2 §4: MIN data discrepancies not corrected" });
  assert.equal(r.response_due, "2026-12-10"); assert.equal(r.finding.kind, "violation_notice");
  const t = h.timers.byCode("MERS_RULE7_VIOLATION_RESPONSE_30"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-12-10"); assert.equal(t[0]!.anchorDate, "2026-11-10");
  const task = h.esc.opened.find((e) => e.id === r.officer_task_id)!; assert.equal(task.ownerRole, "officer"); assert.equal(task.status, "open"); assert.equal(task.payload.task, "mers_rule7_violation_response");
  // The officer files the response and remediates on Dec. 1: `mers.violation.remediated` on the Org ID closes the clock, on time.
  h.clock.set("2026-12-01T15:00:00.000Z");
  assert.throws(() => violationRemediated(h.events, { org_id: SUPERMORTGAGE_ORG_ID, notice_date: D("2026-11-10"), remediated_on: D("2026-12-01"), response_document_id: "" }, OFFICER), /response_document_id/);
  assert.equal(t[0]!.status, "armed");
  const done = violationRemediated(h.events, { org_id: SUPERMORTGAGE_ORG_ID, notice_date: D("2026-11-10"), remediated_on: D("2026-12-01"), response_document_id: "doc-rule7-response" }, OFFICER);
  assert.deepEqual([done.response_due, done.on_time, done.finding_resolution.resolved_at, t[0]!.status], ["2026-12-10", true, "2026-12-01", "satisfied"]);
  assert.ok(eventMatches(h.registry.get("MERS_RULE7_VIOLATION_RESPONSE_30")!.satisfiedPattern!, done.event));
});
test("1.5-T8: Given a MIN with investor ≠ Fannie Mae, then boarding proceeds with `W-016` and a partner query.", () => {
  const clock = new FixedClock("2026-09-17T02:00:00.000Z"); const events = new MemoryEventStore(clock); const ext = new FakePositions();
  const svc = new BoardingService({ events, ledger: new MemoryLedger(), ext, clock, clearingAccountId: "CUST-CLEARING" }); svc.openBatch(batchContext({ transfer_date: D("2026-10-01") }));
  const loan = stagedLoan({ mers_investor_is_fnma: false }); ext.agree(loan);
  const [bl] = svc.stage("B1", [loan]); svc.validate("B1");
  assert.equal(bl!.status, "validated");                                       // boarding proceeds
  assert.equal(bl!.validations.find((v) => v.code === "W-016")!.result, "fail");
  assert.ok(svc.openWarnings(bl!).some((v) => v.code === "W-016"));
  const q = svc.partnerQuery(bl!.id);                                          // partner query carries the warning (seller/partner corrects, B8-7-01)
  assert.ok(q.items.some((i) => i.rule_code === "W-016"));
  clock.set("2026-10-01T14:00:00.000Z");
  assert.equal(svc.board("B1", { finalTapeReconciled: true }).boarded.length, 1);
});

// ---- the remaining 1.5 timers, armed by the trigger the row names and satisfied by the event the process emits ----
test("1.5 Rule 7: a Lockout Warning dated Dec. 15, 2026 arms MERS_RULE7_LOCKOUT_WARNING_30 due Jan. 14, 2027 with an officer task; remediation lifts it only with the penalties paid", () => {
  const h = harness("2026-12-15T15:00:00.000Z");
  const w = lockoutWarningReceived(h.events, h.esc, { notice_on: D("2026-12-15"), org_id: SUPERMORTGAGE_ORG_ID, description: "Rule 7 §1(e): Violation of Nov. 10 not remediated", penalties_cents: cents("2500.00"), violation_notice_date: D("2026-11-10") });
  assert.deepEqual([w.remediate_by, w.finding.stage, w.finding.due_at], ["2027-01-14", "lockout_warning", "2027-01-14"]);
  const t = h.timers.byCode("MERS_RULE7_LOCKOUT_WARNING_30"); assert.equal(t.length, 1); assert.deepEqual([t[0]!.dueDate, t[0]!.anchorDate, t[0]!.subject], ["2027-01-14", "2026-12-15", { kind: "mers_org", id: SUPERMORTGAGE_ORG_ID }]);
  const task = h.esc.opened.find((e) => e.id === w.officer_task_id)!; assert.deepEqual([task.ownerRole, task.severity, task.payload.task, task.payload.penalties_cents], ["officer", "sev-1", "mers_rule7_lockout_remediation", 250_000n]);
  h.clock.set("2027-01-08T15:00:00.000Z");
  assert.throws(() => lockoutRemediated(h.events, { org_id: SUPERMORTGAGE_ORG_ID, notice_date: D("2026-12-15"), remediated_on: D("2027-01-08"), penalties_paid: false, evidence_document_id: "doc-mers-confirm" }, OFFICER), /penalties/);
  assert.equal(t[0]!.status, "armed");
  const done = lockoutRemediated(h.events, { org_id: SUPERMORTGAGE_ORG_ID, notice_date: D("2026-12-15"), remediated_on: D("2027-01-08"), penalties_paid: true, penalties_paid_cents: cents("2500.00"), evidence_document_id: "doc-mers-confirm" }, OFFICER);
  assert.deepEqual([done.on_time, done.event.payload.penalties_paid, t[0]!.status], [true, true, "satisfied"]);
  assert.ok(eventMatches(h.registry.get("MERS_RULE7_LOCKOUT_WARNING_30")!.satisfiedPattern!, done.event));
  // a stranger Org ID or an empty description is not a notice
  assert.throws(() => lockoutWarningReceived(h.events, h.esc, { notice_on: D("2026-12-15"), org_id: "12", description: "x" }), RangeError);
  assert.throws(() => lockoutWarningReceived(h.events, h.esc, { notice_on: D("2026-12-15"), org_id: SUPERMORTGAGE_ORG_ID, description: " " }), RangeError);
});
test("1.5 QA: the Member Reconciliation Extract received Nov. 5, 2026 arms MERS_QA_MRE_RECON_MONTHLY due Dec. 5; the reconciliation run satisfies it and re-arms the next month from the receipt", () => {
  const h = harness("2026-11-05T13:00:00.000Z");
  const rows = Array.from({ length: 1200 }, (_, i) => ({ min: makeMin(PARTNER_ORG, String(i + 1)) }));
  assert.throws(() => mreReceived(h.events, { org_id: SUPERMORTGAGE_ORG_ID, as_of: D("2026-11-04"), received_on: D("2026-11-05"), rows: [] }), /empty/);
  assert.throws(() => mreReceived(h.events, { org_id: "supermortgage", as_of: D("2026-11-04"), received_on: D("2026-11-05"), rows }), /Org ID/);
  const got = mreReceived(h.events, { org_id: SUPERMORTGAGE_ORG_ID, as_of: D("2026-11-04"), received_on: D("2026-11-05"), rows, document_id: "doc-mre-2026-11" });
  assert.deepEqual([got.mins, got.cadence, got.recon_due], [1200, "monthly", "2026-12-05"]);
  assert.equal(mreReceived(h.events, { org_id: PARTNER_ORG, as_of: D("2026-11-04"), received_on: D("2026-11-05"), rows: rows.slice(0, 400) }).cadence, "quarterly");   // below 1,000 MINs [PARTIALLY VERIFIED]
  const t = h.timers.byCode("MERS_QA_MRE_RECON_MONTHLY").filter((x) => x.subject.id === SUPERMORTGAGE_ORG_ID);
  assert.equal(t.length, 1); assert.deepEqual([t[0]!.dueDate, t[0]!.anchorDate, t[0]!.subject.kind], ["2026-12-05", "2026-11-05", "mers_org"]);
  h.clock.set("2026-11-06T13:00:00.000Z");
  const run = reconcileExtract(h.events, { org_id: SUPERMORTGAGE_ORG_ID, received_on: D("2026-11-05"), rows: rows.slice(0, 3).map((r, i) => ({ min: r.min, system_of_record: { property: `${i} Main`, borrower: "A" }, snapshot: { property: i === 1 ? "other" : `${i} Main`, borrower: "A" } })) });
  assert.deepEqual([run.clean, run.blocked, run.findings.length, run.findings[0]!.raised_at], [2, [rows[1]!.min], 1, "2026-11-05"]);
  const after = h.timers.byCode("MERS_QA_MRE_RECON_MONTHLY").filter((x) => x.subject.id === SUPERMORTGAGE_ORG_ID);
  assert.deepEqual(after.map((x) => [x.status, x.dueDate]), [["satisfied", "2026-12-05"], ["armed", "2026-12-05"]], "recurring: satisfied, and re-armed a month from the extract's receipt");
  assert.ok(eventMatches(h.registry.get("MERS_QA_MRE_RECON_MONTHLY")!.satisfiedPattern!, run.event));
  assert.equal(h.timers.byCode("MERS_QA_MRE_RECON_MONTHLY").filter((x) => x.subject.id === PARTNER_ORG)[0]!.status, "armed", "the partner Org ID's extract is its own clock");
});
test("1.5 Annual Report: the year-end close arms MERS_ANNUAL_REPORT_1231 for the following Dec. 31; the officer-signed submission for both Org IDs satisfies it and re-arms the next year", () => {
  const h = harness("2027-01-05T15:00:00.000Z");   // the December close is processed in January; the anchor is the period end, not the close
  h.events.append({ type: "period.year_end", actor: { kind: "system", id: "scheduler" }, payload: { period_end: "2026-12-31", year: 2026, large_servicer: true } });
  const t = h.timers.byCode("MERS_ANNUAL_REPORT_1231"); assert.equal(t.length, 1); assert.deepEqual([t[0]!.dueDate, t[0]!.anchorDate, t[0]!.status], ["2027-12-31", "2026-12-31", "armed"]);
  const base = { year: 2027, org_ids: [PARTNER_ORG, SUPERMORTGAGE_ORG_ID], submitted_on: D("2027-12-10"), package_document_id: "doc-ar-2027", officer_signature_document_id: "doc-ar-2027-signed", active_mins: 5_000, third_party_review_document_id: "doc-ar-2027-review" };
  assert.deepEqual(annualReportChecks(base), []);
  assert.match(annualReportChecks({ ...base, officer_signature_document_id: null }).join("; "), /officer/);
  assert.match(annualReportChecks({ ...base, third_party_review_document_id: null }).join("; "), /third-party review is required at ≥ 1000/);
  assert.deepEqual(annualReportChecks({ ...base, active_mins: 999, third_party_review_document_id: null }), []);
  assert.match(annualReportChecks({ ...base, org_ids: [SUPERMORTGAGE_ORG_ID] }).join("; "), /both Org IDs/);
  assert.match(annualReportChecks({ ...base, org_ids: [PARTNER_ORG, "1000124"] }).join("; "), /1009999/);
  h.clock.set("2027-12-10T15:00:00.000Z");
  assert.throws(() => submitAnnualReport(h.events, { ...base, officer_signature_document_id: null }, AGENT), RangeError);
  assert.equal(t[0]!.status, "armed");
  const r = submitAnnualReport(h.events, base, AGENT);
  assert.deepEqual([r.due_on, r.on_time, r.third_party_review_required, r.event.payload.both_org_ids, r.event.payload.period_end], ["2027-12-31", true, true, true, "2027-12-31"]);
  const after = h.timers.byCode("MERS_ANNUAL_REPORT_1231");
  assert.deepEqual(after.map((x) => [x.status, x.dueDate]), [["satisfied", "2027-12-31"], ["armed", "2028-12-31"]], "recurring: re-armed on the period end of the year reported");
  assert.ok(eventMatches(h.registry.get("MERS_ANNUAL_REPORT_1231")!.satisfiedPattern!, r.event));
});

// ---- the transfer agent's tools on the bus: the same emitters, the spec's guardrails ----
function bus15(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const registry = loadOverriddenRegistry();
  const timers = new TimerEngine(registry, events, { processes: ["1.5"] });
  const ctx: UowContext = { loanId: "L-1", events, ledger: new MemoryLedger(), timers, clock, decide: () => {} };
  const mers = new FakeMers(); const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, ports: { mers } };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const cmds = new Map(SECTION_01_TOOLS.filter((d) => d.process === "1.5").map((d) => { const cmd = toolCommand(d, rt, ["officer", "signing_officer"]); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; }));
  const run = async (name: string, actor: Actor, input: Record<string, unknown>): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output as Record<string, unknown>;
  return { clock, events, registry, timers, rt, mers, escalations, run };
}
test("1.5 tools: submitMersBatch keeps decision 1 (partner-Org-ID rows need the partner's authorization or a partner task) and prices the batch; ingestMersAck/draftViolationResponse carry the Rule 7 clock end to end with the remediation officer-only", async () => {
  const b = bus15("2026-09-30T20:00:00.000Z");
  for (const min of MINS) b.mers.register({ min, status: "active", servicerOrgId: PARTNER_ORG, subservicerOrgId: null, investorOrgId: FANNIE_MAE_MERS_ORG_ID, noteOwnerOrgId: FANNIE_MAE_MERS_ORG_ID, registrationDate: "2020-01-01", mom: true });
  const newMin = makeMin(SUPERMORTGAGE_ORG_ID, "77");
  const txns = [{ txnId: "t1", min: MINS[0]!, type: "min_update_subservicer", effectiveDate: "2026-10-01", orgId: SUPERMORTGAGE_ORG_ID }, { txnId: "t2", min: MINS[1]!, type: "tos_confirm", effectiveDate: "2026-10-01", orgId: PARTNER_ORG }, { txnId: "t3", min: newMin, type: "registration", effectiveDate: "2026-10-01", orgId: SUPERMORTGAGE_ORG_ID }];
  assert.deepEqual(submitAuthorization(txns).needs_partner_task.map((t) => t.min), [MINS[1]!]);
  await assert.rejects(b.run("submitMersBatch", AGENT, { transactions: txns }), (e: unknown) => e instanceof CommandRefused && e.code === "PARTNER_ORG_ID_NEEDS_AUTHORIZATION");
  const own = await b.run("submitMersBatch", AGENT, { transactions: txns.filter((t) => t.orgId === SUPERMORTGAGE_ORG_ID), partner_id: "partner-1" });
  assert.deepEqual([own.submitted_count, own.needs_partner_task, (own.fees as { total_cents: bigint; registrations: number }).total_cents, (own.fees as { registrations: number }).registrations], [2, [], 2_495n, 1]);
  const all = await b.run("submitMersBatch", AGENT, { transactions: txns, partner_authorization_document_id: "doc-partner-auth", partner_id: "partner-1" });
  assert.deepEqual([all.submitted_count, (all.results as unknown[]).length, (all.fees as { borrower_charge: boolean }).borrower_charge], [3, 3, false]);
  // Rule 7 through the tools: the notice arms the clock and opens the officer task; the agent may draft but not record the remediation.
  b.clock.set("2026-11-10T15:00:00.000Z");
  const v = await b.run("ingestMersAck", AGENT, { op: "violation_notice", org_id: SUPERMORTGAGE_ORG_ID, notice_on: "2026-11-10", description: "Rule 2 §4: MIN data discrepancies not corrected" });
  assert.equal(v.response_due, "2026-12-10");
  const t = b.timers.byCode("MERS_RULE7_VIOLATION_RESPONSE_30"); assert.equal(t.length, 1); assert.equal(t[0]!.dueDate, "2026-12-10");
  assert.equal(b.escalations.opened.find((e) => e.id === v.officer_task_id)!.ownerRole, "officer");
  assert.equal(b.rt.store.get("mers_qa_findings", `violation:${SUPERMORTGAGE_ORG_ID}:2026-11-10`)!.data.kind, "violation_notice");
  assert.equal((await b.run("draftViolationResponse", AGENT, { notice_on: "2026-11-10", data: { summary: "corrected 12 MINs" } })).response_due, "2026-12-10");
  await assert.rejects(b.run("draftViolationResponse", AGENT, { op: "remediated", notice_on: "2026-11-10", response_document_id: "doc-r" }), (e: unknown) => e instanceof CommandRefused && e.code === "RULE7_REMEDIATION_IS_OFFICER");
  assert.equal(t[0]!.status, "armed");
  b.clock.set("2026-12-01T15:00:00.000Z");
  const done = await b.run("draftViolationResponse", OFFICER, { op: "remediated", notice_on: "2026-11-10", response_document_id: "doc-rule7-response" });
  assert.deepEqual([done.on_time, t[0]!.status, b.rt.store.get("mers_qa_findings", `violation:${SUPERMORTGAGE_ORG_ID}:2026-11-10`)!.data.resolved_at], [true, "satisfied", "2026-12-01"]);
  // the lockout warning and its remediation ride the same tools
  b.clock.set("2026-12-15T15:00:00.000Z");
  const w = await b.run("ingestMersAck", AGENT, { op: "lockout_warning", org_id: SUPERMORTGAGE_ORG_ID, notice_on: "2026-12-15", description: "Rule 7 §1(e)", penalties_cents: 250_000n });
  const lt = b.timers.byCode("MERS_RULE7_LOCKOUT_WARNING_30"); assert.equal(w.remediate_by, "2027-01-14"); assert.equal(lt[0]!.dueDate, "2027-01-14");
  await assert.rejects(b.run("draftViolationResponse", OFFICER, { op: "lockout_remediated", notice_on: "2026-12-15", penalties_paid: false, evidence_document_id: "doc-e" }), RangeError);
  assert.equal((await b.run("draftViolationResponse", OFFICER, { op: "lockout_remediated", notice_on: "2026-12-15", remediated_on: "2027-01-08", penalties_paid: true, penalties_paid_cents: 250_000n, evidence_document_id: "doc-e" })).on_time, true);
  assert.equal(lt[0]!.status, "satisfied");
  await assert.rejects(b.run("ingestMersAck", AGENT, { op: "mail_service" }), RangeError);
});
test("1.5 tools: ingestMersAck op=tos_pending reads the port's pending transfers for the partner and arms the per-MIN confirmation clocks; op=tos_confirm closes them; op=mre + reconcileMre run the monthly QA cycle; op=annual_report needs the officer's signature", async () => {
  const b = bus15("2026-09-29T21:00:00.000Z");
  const plan = planMersTransactions({ type: "servicing_sale_with_sub", transfer_date: D("2026-10-01"), mins: MINS.map((min, i) => ({ min, loan_id: `L-${i + 1}` })), partner_org_id: PARTNER_ORG });
  b.events.append({ type: "transfer.batch.approved", aggregate: { kind: "transfer_batch", id: "B2" }, actor: SYSTEM, payload: approvedPayload({ batch_id: "B2", type: "servicing_sale_with_sub", transfer_date: D("2026-10-01") }, APPROVAL) });
  const t0 = b.timers.byCode("MERS_PROC_TOS_INITIATE_T0")[0]!; assert.equal(t0.status, "armed");
  for (const min of MINS) b.mers.pending.push({ min, fromOrgId: SELLER_ORG, type: "tos", noticedAt: "2026-09-29T17:00:00.000Z", toOrgId: PARTNER_ORG });
  b.mers.pending.push({ min: MINS[0]!, fromOrgId: SELLER_ORG, type: "tos", noticedAt: "2026-09-29T17:00:00.000Z", toOrgId: "1004444" });   // someone else's notice
  const p = await b.run("ingestMersAck", AGENT, { op: "tos_pending", batch_id: "B2", transactions: plan.transactions, partner_org_id: PARTNER_ORG, seller_org_id: SELLER_ORG });
  assert.deepEqual([p.expected, p.received, p.all_mins, p.confirm_by, t0.status], [3, 3, true, "2026-10-06", "satisfied"]);
  const c7 = b.timers.byCode("MERS_PROC_TOS_CONFIRM_7"); assert.equal(c7.length, 4); assert.ok(c7.every((x) => x.dueDate === "2026-10-06"));
  b.clock.set("2026-10-05T14:00:00.000Z");
  const c = await b.run("ingestMersAck", AGENT, { op: "tos_confirm", batch_id: "B2", transactions: plan.transactions, results: MINS.map((min) => ({ min, accepted: true })), confirmed_on: "2026-10-05" });
  assert.deepEqual([c.confirmed, c.all_mins], [3, true]); assert.ok(c7.every((x) => x.status === "satisfied"));
  assert.equal(b.rt.store.list("mers_acks").length, 1);
  // the monthly QA cycle
  b.clock.set("2026-11-05T13:00:00.000Z");
  const rows = MINS.map((min) => ({ min }));
  const m = await b.run("ingestMersAck", AGENT, { op: "mre", org_id: SUPERMORTGAGE_ORG_ID, as_of: "2026-11-04", received_on: "2026-11-05", rows });
  assert.deepEqual([m.mins, m.cadence], [3, "quarterly"]);
  const q = b.timers.byCode("MERS_QA_MRE_RECON_MONTHLY"); assert.equal(q.length, 1); assert.equal(q[0]!.dueDate, "2026-12-05");
  await assert.rejects(b.run("reconcileMre", AGENT, {}), RangeError);
  const one = await b.run("reconcileMre", AGENT, { org_id: SUPERMORTGAGE_ORG_ID, received_on: "2026-11-05", min: MINS[0]!, system_of_record: { property: "1 Main" }, snapshot: { property: "2 Main" } });
  assert.deepEqual([one.discrepancies, one.blocked, (one.finding as { kind: string }).kind, q[0]!.status], [["property"], [MINS[0]!], "mre_mismatch", "satisfied"]);
  assert.equal(b.rt.store.list("mers_qa_findings").length, 1);
  assert.equal(b.timers.byCode("MERS_QA_MRE_RECON_MONTHLY").length, 2, "recurring: re-armed for the next extract");
  // the Annual Report
  b.clock.set("2027-12-10T15:00:00.000Z");
  await assert.rejects(b.run("submitMersBatch", AGENT, { op: "annual_report", year: 2027, org_ids: [PARTNER_ORG, SUPERMORTGAGE_ORG_ID], package_document_id: "doc-ar", active_mins: 5000, third_party_review_document_id: "doc-rev" }), /officer/);
  const ar = await b.run("submitMersBatch", AGENT, { op: "annual_report", year: 2027, org_ids: [PARTNER_ORG, SUPERMORTGAGE_ORG_ID], package_document_id: "doc-ar", officer_signature_document_id: "doc-ar-signed", active_mins: 5000, third_party_review_document_id: "doc-rev" });
  assert.deepEqual([ar.due_on, ar.on_time], ["2027-12-31", true]);
  const ev = b.events.ofType("mers.annual_report.submitted"); assert.equal(ev.length, 1); assert.ok(eventMatches(b.registry.get("MERS_ANNUAL_REPORT_1231")!.satisfiedPattern!, ev[0]!));
  assert.equal(b.rt.store.get("mers_annual_reports", "2027")!.data.on_time, true);
});

// 1.5 rule 5: MERS transfers are free; registrations are $24.95 accrued to the partner's MERS invoice, never to the borrower.
test("1.5 worked example: a 3-MIN Subservicer MIN Update with 2 registrations prices at $49.90 to the partner's MERS invoice, never to the borrower", () => {
  const rows = [...planMersTransactions({ type: "master_to_sub", transfer_date: D("2026-10-01"), mins: MINS.map((min) => ({ min })), partner_org_id: PARTNER_ORG }).transactions,
    { min: makeMin(SUPERMORTGAGE_ORG_ID, "77"), txn_type: "registration" }, { min: makeMin(SUPERMORTGAGE_ORG_ID, "78"), txn_type: "registration" }];
  const fees = mersBatchFees(rows, "partner-1");
  assert.deepEqual([fees.registrations, fees.transfers, fees.total_cents, fees.bill_to, fees.borrower_charge], [2, 3, cents("49.90"), "partner:partner-1:mers_invoice", false]);
  assert.deepEqual(fees.lines.map((l) => l.amount_cents), [0n, 0n, 0n, cents("24.95"), cents("24.95")]);
  assert.deepEqual(registrationFeeAccrual("100012300000000015", "partner-1"), { min: "100012300000000015", amount_cents: cents("24.95"), bill_to: "partner:partner-1:mers_invoice", borrower_charge: false });
  assert.throws(() => mersBatchFees([], "partner-1"), RangeError);
});
