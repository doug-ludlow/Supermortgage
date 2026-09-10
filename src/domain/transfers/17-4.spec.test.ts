// 17.4 Loss-mit in-flight transfer
// spec/sections/17-servicing-transfer-out/17-4-loss-mit-in-flight-transfer.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { postTransferForwarding, postTransferReceipt, foreclosureHoldHandoff, retainedRequest, trialPaymentHandoff, preTransferDetermination, bankruptcyHandoff, handoffChecks, deadlineTable, workdownWindow, workdownEvidence, cancelTimerRequest, smduHandoff, inventoryScope, inventoryFlags, packageEvidence, counselAcknowledgment, payoffRequestHandoff, batchHandoffRollup, preliminaryHandoffAck, type CaseSnapshot } from "./ops-17-4.ts";
import { transferorClocks, transfereeAckDue, transfereeEvaluationDue, transfereeAppealDue, forbearanceCarryover } from "./lossmit-inflight.ts";
import { EVALUATORS } from "../../app/evaluators.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches, MemoryEventStore, FixedClock, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_17_4 } from "../../app/tools/section17-4.ts";
import { lintEmission } from "../../../tools/lint-emission.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";

const T = D("2026-12-01");   // worked dates: T = Tue Dec 1, 2026; federal holidays Nov 26, Dec 25
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const REVIEWER: Actor = { kind: "human", id: "u-reviewer-2", role: "lossmit_reviewer" };
const FIRM: Actor = { kind: "human", id: "u-firm-1-paralegal", role: "attorney" };
const L = "L-174";
const B = "B-1";
const BATCH = { kind: "batch", id: B };   // the aggregate 17.3's transfer.cutover.frozen lands on (section17-3.ts batchAgg) — the 17.4 batch-subject rows live here
type Out = Record<string, unknown>;

/** A one-process bus over TOOLS_17_4 with the overridden registry, so the 17.4 events this process emits arm and satisfy its own timers. */
function bus17_4(nowIso = "2026-11-29T15:00:00.000Z", processes: readonly string[] = ["17.4"]): { bus: CommandBus; run: (name: string, input: Record<string, unknown>, actor?: Actor) => Promise<Out>; ctx: UowContext & { decisions: DecisionInput[] }; rt: ToolRuntime; events: () => DomainEvent[]; timers: TimerEngine } {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes });
  const ctx = { loanId: L, events, ledger: new MemoryLedger(), timers, clock, decide: (d: Omit<DecisionInput, "loanId">) => { decisions.push({ loanId: L, ...d }); }, decisions } as UowContext & { decisions: DecisionInput[] };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const escalates = loadAgentsFile().processes.find((p) => p.process === "17.4")!.escalates_to;
  const cmds = new Map(TOOLS_17_4.map((d) => { const c = toolCommand(d, rt, escalates); agents.registerTool(d.agent, c.name); return [d.name, c] as const; }));
  return { bus, ctx, rt, timers, events: () => [...ctx.events.all()], run: (name, input, actor = AGENT) => bus.execute(cmds.get(name)!, actor, input, ctx).then((r) => r.output as Out) };
}
const refused = (code: string) => (e: unknown): boolean => e instanceof CommandRefused && e.code === code;
const rangeError = (re: RegExp) => (e: unknown): boolean => e instanceof RangeError && re.test(e.message);
const check = (checks: readonly { check_code: string; result: string; note: string }[], code: string) => checks.find((c) => c.check_code === code)!;
const armed = (b: ReturnType<typeof bus17_4>, code: string) => b.timers.byCode(code);
/** The attestation's inventory on the bus: per-case rows on the loans and the batch-level event that arms the T−14 / T−1 BD rows on the batch. */
const inventory = (b: ReturnType<typeof bus17_4>, cases: Record<string, unknown>[], extra: Record<string, unknown> = {}) => b.run("inventoryOpenCases", { batch_id: B, transfer_date: "2026-12-01", attested_on: "2026-11-17", listed_loan_ids: [L], cases, ...extra });
const ACK = { ack_reference: "ACK-1", acked_by: "transferee:lossmit-desk" };

test("17.4-T1: Given an application received Nov 25, 2026, then Supermortgage's ack is due Dec 3 and the platform schedules it for Nov 30; if unsent at T, `TO-03` records the unexpired period and the exported transferee deadline is Dec 15.", async () => {
  // Supermortgage's own §1024.41(b)(2) clock: 5 federal BD from Wed Nov 25 skipping Thanksgiving → Thu Dec 3; the platform targets the last federal BD before T, Mon Nov 30
  const clocks = transferorClocks(D("2026-11-25"), T);
  assert.equal(clocks.ack_due, "2026-12-03"); assert.equal(clocks.ack_target, "2026-11-30"); assert.equal(clocks.handoff_if_unsent, true, "the period is unexpired at T, so an unsent ack is handed off, not breached");
  assert.equal(transfereeAckDue(T, true), "2026-12-15", "(k)(2)(i): 10 federal BD from T — Dec 2, 3, 4, 7, 8, 9, 10, 11, 14, 15");
  // unsent at T: TO-03 records the unexpired period and discloses the transferee's deadline; the deadline table exports both clocks
  const unsent: CaseSnapshot = { case_type: "lossmit", received_at: D("2026-11-25"), completeness: "incomplete" };
  const to03 = check(handoffChecks(unsent, T), "TO-03");
  assert.equal(to03.result, "pass"); assert.match(to03.note, /not sent; period unexpired \(due 2026-12-03\)/); assert.match(to03.note, /transferee \(k\)\(2\)\(i\) deadline 2026-12-15/);
  const rows = deadlineTable(unsent, T);
  assert.deepEqual(rows.find((r) => r.code === "REGX_1024_41B2_ACK_5"), { code: "REGX_1024_41B2_ACK_5", anchor: "2026-11-25", due_at: "2026-12-03", status: "open", owner_after_transfer: "transferee" });
  assert.deepEqual(rows.find((r) => r.code === "REGX_1024_41K2_TRANSFEREE_ACK_10"), { code: "REGX_1024_41K2_TRANSFEREE_ACK_10", anchor: "2026-12-01", due_at: "2026-12-15", status: "exported", owner_after_transfer: "transferee" });
  // the ack due Dec 3 sits in the work-down window [T, T+10 federal BD] and counts as documented only because TO-03 recorded it
  const w = workdownEvidence(unsent, T, handoffChecks(unsent, T)); assert.deepEqual(w.in_window, ["REGX_1024_41B2_ACK_5"]); assert.deepEqual(w.undocumented, []); assert.equal(w.ok, true);
  // sent by Nov 30 with its copy and reasonable date → TO-03 carries the copy; sent without the copy fails the check
  const sent: CaseSnapshot = { ...unsent, ack_sent_at: D("2026-11-30"), ack_document_id: "doc-ack-1", reasonable_date: D("2026-12-15") };
  assert.match(check(handoffChecks(sent, T), "TO-03").note, /ack sent 2026-11-30; copy doc-ack-1; reasonable_date=2026-12-15/);
  assert.equal(check(handoffChecks({ ...sent, ack_document_id: null }, T), "TO-03").result, "fail");
  assert.deepEqual(deadlineTable(sent, T), [{ code: "REGX_1024_41K2_NO_FIRST_FILING_GATE", anchor: "2026-12-15", due_at: "2026-12-16", status: "exported", owner_after_transfer: "transferee" }], "a sent ack leaves no open (b)(2) clock — only the (k)(2)(ii) first-filing gate (reasonable date + 1) is exported");
  // on the bus: the Nov 25 receipt (12.1's `lossmit.application.received{received_date}`) arms Supermortgage's own REGX_1024_41B2_ACK_5 due Dec 3 — it keeps running to T; the 12.1 ack notice satisfies it
  const b = bus17_4(); const def = loadOverriddenRegistry().get("REGX_1024_41B2_ACK_5")!;
  b.ctx.events.append({ type: "lossmit.application.received", loanId: L, actor: { kind: "agent", id: "lossmit-underwriter" }, payload: { application_id: "A-1", status: "incomplete", received_date: "2026-11-25" } });
  const ack = armed(b, "REGX_1024_41B2_ACK_5"); assert.equal(ack.length, 1); assert.equal(ack[0]!.dueDate, "2026-12-03"); assert.equal(ack[0]!.anchorDate, "2026-11-25");
  assert.equal(eventMatches(def.satisfiedPattern!, { id: "n", sequence: 1, type: "notice.sent", loanId: L, actor: AGENT, occurredAt: "2026-11-30T15:00:00.000Z", payload: { template: "NTC_REGX_41B2_ACK_INCOMPLETE" } }), true);
  // runHandoffChecks persists only the migration's columns (case_id, check_code, result, evidence_document_id, at); exportDeadlineTable shows the Dec 15 row
  await b.run("runHandoffChecks", { case_id: "C-1", loan_id: L, transfer_date: "2026-12-01", snapshot: unsent });
  const stored = b.rt.store.list("lossmit_handoff_checks").map((r) => r.data); assert.equal(stored.length, 15);
  assert.deepEqual(Object.keys(stored.find((r) => r.check_code === "TO-03")!).sort(), ["at", "case_id", "check_code", "evidence_document_id", "result"]);
  const table = await b.run("exportDeadlineTable", { case_id: "C-1", transfer_date: "2026-12-01", snapshot: unsent }) as { rows: { code: string; due_at: string }[]; workdown: { ok: boolean } };
  assert.equal(table.rows.find((r) => r.code === "REGX_1024_41K2_TRANSFEREE_ACK_10")!.due_at, "2026-12-15"); assert.equal(table.workdown.ok, true);
});
test("17.4-T2: Given a complete application received Nov 10 with no determination by T-1, then the package exports `complete_at=Nov 10` and the transferee's (k)(3) date Dec 31; given a determination mailed Nov 30, then `TO-04` carries the copy and reviewer record.", async () => {
  const pending: CaseSnapshot = { case_type: "lossmit", received_at: D("2026-11-05"), completeness: "complete", complete_at: D("2026-11-10"), ack_sent_at: D("2026-11-06"), ack_document_id: "doc-ack-2", recovery_analysis_document_id: "doc-ra", ei_history_document_id: "doc-ei", rule_set_version: "17.4@2026-09" };
  // Supermortgage's (c)(1) clock: Nov 10 + 30 = Dec 10 (after T, so left to the transferee); (k)(3) gives the transferee T + 30 = Dec 31
  const rows = deadlineTable(pending, T);
  assert.deepEqual(rows.find((r) => r.code === "REGX_1024_41C1_EVAL_30"), { code: "REGX_1024_41C1_EVAL_30", anchor: "2026-11-10", due_at: "2026-12-10", status: "open", owner_after_transfer: "transferee" });
  assert.deepEqual(rows.find((r) => r.code === "REGX_1024_41K3_COMPLETE_APP_EVAL_30"), { code: "REGX_1024_41K3_COMPLETE_APP_EVAL_30", anchor: "2026-12-01", due_at: "2026-12-31", status: "exported", owner_after_transfer: "transferee" });
  assert.equal(transfereeEvaluationDue(T), "2026-12-31");
  const checks = handoffChecks(pending, T);
  assert.match(check(checks, "TO-02").note, /complete; facially_complete_at=—; complete_at=2026-11-10/); assert.equal(check(checks, "TO-04").result, "pass"); assert.match(check(checks, "TO-04").note, /not sent; period unexpired \(due 2026-12-10\); transferee \(k\)\(3\) date 2026-12-31/);
  assert.deepEqual(checks.filter((c) => c.result === "fail"), [], "nothing is deficient: the undetermined application is documented, not failed");
  // on the bus: the attestation's inventory arms SM_LOSSMIT_PRE_T_WORKDOWN_T1 on the batch (T−1 servicer BD = Mon Nov 30); the package exports complete_at=Nov 10 and Dec 31 in its
  // deadline table, its per-case packaged event carries the measured work-down state, and the batch-level packaged event (every loss-mit case documented) satisfies the row
  const b = bus17_4(); await inventory(b, [{ case_id: "C-2", loan_id: L, opened_on: "2026-11-05", snapshot: pending }]);
  const wd = armed(b, "SM_LOSSMIT_PRE_T_WORKDOWN_T1"); assert.equal(wd.length, 1); assert.equal(wd[0]!.dueDate, "2026-11-30"); assert.deepEqual(wd[0]!.subject, BATCH);
  const pkg = await b.run("packageCase", { case_id: "C-2", loan_id: L, transfer_date: "2026-12-01", snapshot: pending, package_document_id: "doc-pkg-2" }) as { status: string; deadline_table: { code: string; anchor: string; due_at: string }[]; batch_rollup: { workdown_documented: boolean } };
  assert.equal(pkg.status, "packaged"); assert.equal(pkg.deadline_table.find((r) => r.code === "REGX_1024_41C1_EVAL_30")!.anchor, "2026-11-10"); assert.equal(pkg.deadline_table.find((r) => r.code === "REGX_1024_41K3_COMPLETE_APP_EVAL_30")!.due_at, "2026-12-31"); assert.equal(pkg.batch_rollup.workdown_documented, true);
  const packaged = b.events().filter((e) => e.type === "case.handoff.packaged"); assert.equal(packaged.length, 2);
  assert.equal(packaged[0]!.payload.scope, "case"); assert.equal(packaged[0]!.payload.lossmit, true); assert.equal(packaged[0]!.payload.pre_transfer_workdown, "documented"); assert.equal(packaged[0]!.loanId, L);
  assert.equal(packaged[1]!.payload.scope, "batch"); assert.deepEqual(packaged[1]!.aggregate, BATCH); assert.equal(packaged[1]!.loanId, undefined);
  assert.equal(eventMatches(loadOverriddenRegistry().get("SM_LOSSMIT_PRE_T_WORKDOWN_T1")!.satisfiedPattern!, packaged[0]!), false, "a per-case event never satisfies the batch row");
  assert.equal(eventMatches(loadOverriddenRegistry().get("SM_LOSSMIT_PRE_T_WORKDOWN_T1")!.satisfiedPattern!, packaged[1]!), true); assert.equal(wd[0]!.status, "satisfied");
  // a determination mailed Nov 30: TO-04 carries the copy and the lossmit_reviewer record (reviewer ≠ evaluator); without the copy or the record it fails
  const denied: CaseSnapshot = { ...pending, determination_sent_at: D("2026-11-30"), determination_outcome: "denial", determination_document_id: "doc-denial-2", determination_options: ["repayment_plan"], determination_reasons: ["NPV negative"], determination_reviewer_id: "u-reviewer-2", evaluator_id: "ai-lossmit-underwriter" };
  const to04 = check(handoffChecks(denied, T), "TO-04"); assert.equal(to04.result, "pass"); assert.match(to04.note, /denial sent 2026-11-30; copy doc-denial-2; options=repayment_plan; reasons=NPV negative; reviewer=u-reviewer-2/);
  assert.match(check(handoffChecks({ ...denied, determination_document_id: null }, T), "TO-04").note, /without the copy/);
  assert.match(check(handoffChecks({ ...denied, determination_reviewer_id: null }, T), "TO-04").note, /without the lossmit_reviewer record/);
  assert.match(check(handoffChecks({ ...denied, determination_reviewer_id: "ai-lossmit-underwriter" }, T), "TO-04").note, /reviewer separation \(§1024.41\(h\)\(3\)/);
  assert.equal(check(handoffChecks({ ...denied, determination_outcome: "offer", determination_reviewer_id: null }, T), "TO-04").result, "pass", "a non-adverse determination needs the copy, not a reviewer record");
  assert.match(check(handoffChecks({ ...denied, colorado: true, ai_assisted: true }, T), "TO-04").note, /without the Colorado impact-assessment reference/);
  assert.match(check(handoffChecks({ ...denied, colorado: true, ai_assisted: true, impact_assessment_ref: "IA-2026-04" }, T), "TO-04").note, /impact_assessment=IA-2026-04; human_review=u-reviewer-2/);
  // a determined application exports no (c)(1)/(k)(3) clock — the transferee honors it — but the Nov 30 denial's §1024.41(h) appeal window (14 days → Dec 14) is still open at T and is exported
  assert.deepEqual(deadlineTable(denied, T), [{ code: "REGX_1024_41H_APPEAL_WINDOW_14", anchor: "2026-11-30", due_at: "2026-12-14", status: "exported", owner_after_transfer: "transferee" }]);
  assert.deepEqual(deadlineTable({ ...denied, determination_sent_at: D("2026-11-12") }, T).map((r) => r.code), [], "a window that expired before T (Nov 12 + 14 = Nov 26) is history, not a clock");
  // the packager cannot assert the TO-* results: a caller-supplied `checks` array is refused before anything runs
  await assert.rejects(b.run("packageCase", { case_id: "C-2b", loan_id: L, transfer_date: "2026-12-01", snapshot: pending, checks: [{ check_code: "TO-04", result: "pass" }] }), refused("CHECKS_NOT_ASSERTED"));
});
test("17.4-T3: Given an appeal received Nov 20 on a Nov 12 denial, then the package shows the transferee's deadline Dec 31 and the reviewer-separation record for any decision Supermortgage made.", () => {
  const appeal: CaseSnapshot = { case_type: "appeal", received_at: D("2026-10-20"), completeness: "complete", complete_at: D("2026-10-25"), ack_sent_at: D("2026-10-21"), ack_document_id: "doc-ack-3", determination_sent_at: D("2026-11-12"), determination_outcome: "denial", determination_document_id: "doc-denial-3", determination_reviewer_id: "u-reviewer-1", evaluator_id: "ai-lossmit-underwriter", appeal_received_at: D("2026-11-20") };
  // Supermortgage's (h)(4) clock Nov 20 + 30 = Dec 20; the transferee's (k)(4) deadline is the later of Dec 31 (T + 30) and Dec 20 → Dec 31
  assert.equal(transfereeAppealDue(T, D("2026-11-20")), "2026-12-31");
  const rows = deadlineTable(appeal, T);
  assert.deepEqual(rows.find((r) => r.code === "REGX_1024_41H_APPEAL_DETERMINATION_30"), { code: "REGX_1024_41H_APPEAL_DETERMINATION_30", anchor: "2026-11-20", due_at: "2026-12-20", status: "open", owner_after_transfer: "transferee" });
  assert.deepEqual(rows.find((r) => r.code === "REGX_1024_41K4_APPEAL_DETERMINATION_30"), { code: "REGX_1024_41K4_APPEAL_DETERMINATION_30", anchor: "2026-11-20", due_at: "2026-12-31", status: "exported", owner_after_transfer: "transferee" });
  const undecided = check(handoffChecks(appeal, T), "TO-05"); assert.equal(undecided.result, "pass"); assert.match(undecided.note, /appeal 2026-11-20 pending; due 2026-12-20; transferee \(k\)\(4\) date 2026-12-31/);
  // a decision Supermortgage made before T shows the reviewer-separation record: reviewer ≠ the evaluator of the application (§1024.41(h)(3))
  const decided = check(handoffChecks({ ...appeal, appeal_decided_at: D("2026-11-28"), appeal_reviewer_id: "u-reviewer-2" }, T), "TO-05");
  assert.equal(decided.result, "pass"); assert.match(decided.note, /appeal 2026-11-20 decided 2026-11-28; reviewer u-reviewer-2 ≠ evaluator ai-lossmit-underwriter/);
  const same = check(handoffChecks({ ...appeal, appeal_decided_at: D("2026-11-28"), appeal_reviewer_id: "ai-lossmit-underwriter" }, T), "TO-05"); assert.equal(same.result, "fail"); assert.match(same.note, /reviewer separation \(§1024.41\(h\)\(3\)\)/);
  assert.deepEqual(deadlineTable({ ...appeal, appeal_decided_at: D("2026-11-28"), appeal_reviewer_id: "u-reviewer-2" }, T).map((r) => r.code), [], "a decided appeal exports no (h)/(k)(4) clock");
  // TO-04 still carries the Nov 12 denial's copy and reviewer record; the appeal decision through preTransferDetermination needs a different reviewer too
  assert.match(check(handoffChecks(appeal, T), "TO-04").note, /copy doc-denial-3; .*reviewer=u-reviewer-1/);
  assert.equal(preTransferDetermination({ outcome: "appeal_denied", proposed_on: D("2026-11-28"), transfer_date: T, complete_at: D("2026-10-25"), evaluator_id: "ai-lossmit-underwriter", reviewer_approval: { reviewer_id: "ai-lossmit-underwriter", approved_on: D("2026-11-28"), record_id: "rev-3" } }).refusal_code, "REVIEWER_SEPARATION");
  assert.equal(preTransferDetermination({ outcome: "appeal_denied", proposed_on: D("2026-11-28"), transfer_date: T, complete_at: D("2026-10-25"), evaluator_id: "ai-lossmit-underwriter", reviewer_approval: { reviewer_id: "u-reviewer-2", approved_on: D("2026-11-28"), record_id: "rev-3" } }).can_issue, true);
  // pending rule (comment 41(k)(1)(i)-1): the appealed denial is pending; a denial with an expired 14-day appeal window is not, but its history still travels
  assert.equal(inventoryScope({ listed: true, case_type: "appeal", opened_on: D("2026-10-20"), attested_on: D("2026-11-17"), denial_sent_on: D("2026-11-12"), appeal_received_on: D("2026-11-20"), today: D("2026-11-30") }).pending, true);
  const expired = inventoryScope({ listed: true, case_type: "lossmit", opened_on: D("2026-10-20"), attested_on: D("2026-11-17"), denial_sent_on: D("2026-11-12"), today: D("2026-11-30") }); assert.equal(expired.pending, false); assert.equal(expired.history_delivered, true);
  // the appeal received Nov 20 (the platform's `lossmit.appeal.received{appeal_received_at}`) arms Supermortgage's own (h) clock due Dec 20 — it continues to T
  const b = bus17_4(); b.ctx.events.append({ type: "lossmit.appeal.received", loanId: L, actor: AGENT, payload: { case_id: "C-3", appeal_received_at: "2026-11-20" } });
  const h = armed(b, "REGX_1024_41H_APPEAL_DETERMINATION_30"); assert.equal(h.length, 1); assert.equal(h[0]!.dueDate, "2026-12-20");
});
test("17.4-T4: Given an acceptance received by Supermortgage Dec 3 for an offer expiring Dec 4, then it is forwarded Dec 3 (same day) and `SM_LOSSMIT_POST_T_FORWARD_1` is satisfied.", async () => {
  const plan = postTransferForwarding({ kind: "acceptance", received_on: D("2026-12-03"), transfer_date: T, loan_status: "transferred_out", acceptance_deadline: D("2026-12-04") });
  assert.equal(plan.forward_by, "2026-12-04"); assert.equal(plan.urgent_same_day, true); assert.equal(plan.forward_on, "2026-12-03"); assert.equal(plan.receipt_date, "2026-12-03");
  assert.equal(plan.honor, "honor_no_reunderwrite"); assert.equal(plan.evaluated_by_supermortgage, false); assert.equal(plan.satisfied, false, "not satisfied until forwarded with the transferee's ack");
  const done = postTransferForwarding({ kind: "acceptance", received_on: D("2026-12-03"), transfer_date: T, loan_status: "transferred_out", acceptance_deadline: D("2026-12-04"), forwarded_on: D("2026-12-03"), transferee_ack_on: D("2026-12-03") });
  assert.equal(done.satisfied, true); assert.equal(done.satisfied_by, "lossmit.forwarded_post_transfer"); assert.equal(done.on_time, true); assert.equal(done.breach, null);
  const late = postTransferForwarding({ kind: "acceptance", received_on: D("2026-12-03"), transfer_date: T, loan_status: "transferred_out", acceptance_deadline: D("2026-12-04"), forwarded_on: D("2026-12-07"), transferee_ack_on: D("2026-12-07") });
  assert.equal(late.on_time, false); assert.equal(late.breach!.severity, "sev1"); assert.equal(late.breach!.kind, "officer"); assert.equal(late.receipt_date, "2026-12-03");
  // the receipt: one `lossmit.document.received{loan_status=transferred_out}` event, never a 12.x intake; a receipt before T is not post-transfer
  const receipt = postTransferReceipt({ kind: "acceptance", received_on: D("2026-12-03"), transfer_date: T, loan_status: "transferred_out", acceptance_deadline: D("2026-12-04") });
  assert.equal(receipt.event, "lossmit.document.received"); assert.equal(receipt.loan_status, "transferred_out"); assert.equal(receipt.received_at, "2026-12-03"); assert.equal(receipt.forward_on, "2026-12-03"); assert.equal(receipt.refusal, null);
  assert.match(postTransferReceipt({ kind: "acceptance", received_on: D("2026-11-30"), transfer_date: T, loan_status: "transferred_out" }).refusal!, /not a post-transfer receipt/);
  // on the bus after T: `forwardPostTransfer{op=receive}` records the acceptance and its receipt event arms the row (anchor received_at Dec 3 → due Dec 4, 1 servicer BD);
  // the same-day forwarding of that receipt records the receipt date; the transferee's later ack satisfies the row
  const b = bus17_4("2026-12-03T14:00:00.000Z"); const def = loadOverriddenRegistry().get("SM_LOSSMIT_POST_T_FORWARD_1")!; assert.equal(def.satisfiedPattern!.type, "lossmit.forwarded_post_transfer");
  const rec = await b.run("forwardPostTransfer", { op: "receive", loan_id: L, kind: "acceptance", received_on: "2026-12-03", transfer_date: "2026-12-01", acceptance_deadline: "2026-12-04" }) as { forwarding_id: string; received_at: string; forwarded_at: string | null; forward_by: string; urgent_same_day: boolean };
  assert.equal(rec.received_at, "2026-12-03"); assert.equal(rec.forwarded_at, null); assert.equal(rec.forward_by, "2026-12-04"); assert.equal(rec.urgent_same_day, true);
  const received = b.events().find((e) => e.type === "lossmit.document.received")!; assert.equal(received.payload.loan_status, "transferred_out"); assert.equal(received.payload.received_at, "2026-12-03"); assert.equal(eventMatches(def.triggerPattern!, received), true);
  const inst = armed(b, "SM_LOSSMIT_POST_T_FORWARD_1"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2026-12-04"); assert.equal(inst[0]!.status, "armed"); assert.equal(inst[0]!.anchorDate, "2026-12-03");
  const out = await b.run("forwardPostTransfer", { forwarding_id: rec.forwarding_id, transfer_date: "2026-12-01", acceptance_deadline: "2026-12-04" }) as { forwarding_id: string; received_at: string; forwarded_at: string; urgent_same_day: boolean; satisfied: boolean; kind: string };
  assert.equal(out.forwarding_id, rec.forwarding_id); assert.equal(out.kind, "acceptance"); assert.equal(out.received_at, "2026-12-03"); assert.equal(out.forwarded_at, "2026-12-03"); assert.equal(out.urgent_same_day, true); assert.equal(out.satisfied, false);
  assert.deepEqual(Object.keys(b.rt.store.get("post_transfer_forwardings", out.forwarding_id)!.data).sort(), ["document_id", "forwarded_at", "kind", "loan_id", "received_at", "transferee_ack_at"], "the row holds the migration's columns only");
  assert.equal(inst[0]!.status, "armed", "the forwarding alone does not satisfy the row — the transferee's ack does");
  await assert.rejects(b.run("forwardPostTransfer", { forwarding_id: rec.forwarding_id, transfer_date: "2026-12-01", received_on: "2026-12-05" }), rangeError(/received_on 2026-12-05 does not match receipt/), "the receipt date is the receipt's, never retyped");
  await b.run("forwardPostTransfer", { op: "ack", forwarding_id: out.forwarding_id, transferee_ack_on: "2026-12-04" });
  assert.equal(inst[0]!.status, "satisfied"); assert.equal(b.rt.store.get("post_transfer_forwardings", out.forwarding_id)!.data.transferee_ack_at, "2026-12-04");
  const acked = b.events().filter((e) => e.type === "lossmit.forwarded_post_transfer"); assert.equal(acked.length, 2); assert.equal(acked[1]!.payload.transferee_ack, true); assert.equal(acked[1]!.payload.receipt_date, "2026-12-03");
  // an appeal received on a transferred loan arms the same row (spec trigger: document / appeal / acceptance / rejection on a transferred loan); a receipt dated before T is refused
  await b.run("forwardPostTransfer", { op: "receive", loan_id: L, kind: "appeal", received_on: "2026-12-03", transfer_date: "2026-12-01", id: "fwd-appeal" }); assert.equal(armed(b, "SM_LOSSMIT_POST_T_FORWARD_1").length, 2);
  await assert.rejects(b.run("forwardPostTransfer", { op: "receive", loan_id: L, kind: "lossmit_document", received_on: "2026-11-30", transfer_date: "2026-12-01" }), rangeError(/not a post-transfer receipt/));
  // Supermortgage never evaluates, acknowledges or decides on a transferred loan: a forwarding that carries a determination or an ack is refused before anything runs
  await assert.rejects(b.run("forwardPostTransfer", { loan_id: L, kind: "appeal", received_on: "2026-12-03", transfer_date: "2026-12-01", evaluate: true }), refused("NEVER_EVALUATE_TRANSFERRED"));
  await assert.rejects(b.run("forwardPostTransfer", { loan_id: L, kind: "lossmit_document", received_on: "2026-12-03", transfer_date: "2026-12-01", outcome: "denial" }), refused("NEVER_EVALUATE_TRANSFERRED"));
  await assert.rejects(b.run("forwardPostTransfer", { op: "receive", loan_id: L, kind: "lossmit_document", received_on: "2026-12-03", transfer_date: "2026-12-01", ack_sent_at: "2026-12-03" }), refused("NEVER_EVALUATE_TRANSFERRED"));
  // the borrower asking for a person opens a human_agent work item alongside the forwarding, never instead of it
  await b.run("forwardPostTransfer", { loan_id: L, kind: "correspondence", received_on: "2026-12-03", transfer_date: "2026-12-01", borrower_requests_human: true });
  assert.ok(b.rt.escalations.opened.some((e) => e.kind === "human_agent"));
});
test("17.4-T5: Given a foreclosure sale Dec 22 and a complete application received Nov 10, then a hold instruction is acknowledged by counsel before Nov 30 and `TO-11` shows the (g) gate closed.", async () => {
  const r = foreclosureHoldHandoff({ transfer_date: T, sale_on: D("2026-12-22"), complete_received_on: D("2026-11-10"), earliest_unpaid_due: D("2026-06-01"), instruction_sent_on: D("2026-11-24"), counsel_acked_on: D("2026-11-27") });
  assert.equal(r.days_before_sale, 42); assert.equal(r.hold_required, true); assert.equal(r.ground, "1024.41(g)");
  assert.equal(r.hold_instruction_due, "2026-11-30"); assert.equal(r.instruction.kind, "HOLD"); assert.equal(r.instruction.to, "attorney_network"); assert.equal(r.instruction.acked, true); assert.equal(r.instruction.acked_on_time, true);
  assert.equal(r.sale_within_45_days, true); assert.equal(r.sale_window_handoff_due, "2026-11-23", "T−5 servicer BD skips Thanksgiving Nov 26");
  assert.equal(r.to_11.check_code, "TO-11"); assert.equal(r.to_11.result, "pass");
  const g = r.to_11.gates.find((x) => x.code === "REGX_1024_41G_DUAL_TRACK_GATE")!; assert.equal(g.state, "closed"); assert.equal(g.anchor, "2026-11-10");
  assert.equal(r.to_11.gates.find((x) => x.code === "REGX_1024_41F1_120_DAY_GATE")!.anchor, "2026-06-01"); assert.equal(r.transferee_inherits_hold, true); assert.equal(r.escalation, null);
  // unacknowledged past the due date → sev-1 to the officer with the sale-risk report; both firms get the hold when the firm changes
  const late = foreclosureHoldHandoff({ transfer_date: T, sale_on: D("2026-12-22"), complete_received_on: D("2026-11-10"), instruction_sent_on: D("2026-11-24"), counsel_acked_on: null, firm_changes: true, today: D("2026-12-01") });
  assert.equal(late.escalation!.severity, "sev1"); assert.equal(late.escalation!.kind, "officer"); assert.equal(late.instruction.both_firms, true); assert.equal(late.to_11.result, "fail");
  // a complete application received Nov 20 (32 days before) does not trigger (g), but (k)(2)(ii)(B) still requires the transferee to evaluate
  const k2 = foreclosureHoldHandoff({ transfer_date: T, sale_on: D("2026-12-22"), complete_received_on: D("2026-11-20"), reasonable_date: D("2026-11-25") });
  assert.equal(k2.days_before_sale, 32); assert.equal(k2.hold_required, false); assert.equal(k2.ground, "1024.41(k)(2)(ii)(B)"); assert.equal(k2.to_11.gates.find((x) => x.code === "REGX_1024_41G_DUAL_TRACK_GATE")!.state, "open");
  // on the bus: the inventory arms SM_LOSSMIT_HOLD_INSTRUCTIONS_T1 (T−1 BD = Nov 30) and SM_FC_SALE_WINDOW_HANDOFF (T−5 BD = Nov 23) from the case facts;
  // the instruction goes out as attorney.instruction.sent and the firm's acknowledgment (attorney.instruction.acked, entered by the attorney role naming the firm) satisfies the hold row
  const fc: CaseSnapshot = { case_type: "foreclosure", complete_at: D("2026-11-10"), foreclosure: { sale_on: D("2026-12-22"), earliest_unpaid_due: D("2026-06-01"), holds_open: [] }, counsel_instruction: { sent_on: D("2026-11-24"), acked_on: D("2026-11-27") }, ei_history_document_id: "doc-ei", rule_set_version: "17.4@2026-09" };
  const flags = inventoryFlags(fc, T); assert.equal(flags.fc_active, true); assert.equal(flags.hold_instruction_required, true); assert.equal(flags.sale_within_45_days, true);
  const b = bus17_4("2026-11-24T15:00:00.000Z");
  await inventory(b, [{ case_id: "C-5", loan_id: L, opened_on: "2026-09-01", snapshot: fc }]);
  const hold = armed(b, "SM_LOSSMIT_HOLD_INSTRUCTIONS_T1"); assert.equal(hold.length, 1); assert.equal(hold[0]!.dueDate, "2026-11-30");
  const sale = armed(b, "SM_FC_SALE_WINDOW_HANDOFF"); assert.equal(sale.length, 1); assert.equal(sale[0]!.dueDate, "2026-11-23");
  const sent = await b.run("completePreTransferAction", { case_id: "C-5", loan_id: L, action: "hold_instruction", transfer_date: "2026-12-01", sale_on: "2026-12-22", complete_received_on: "2026-11-10", earliest_unpaid_due: "2026-06-01", firm_id: "firm-1" }) as { instruction: { kind: string } };
  assert.equal(sent.instruction.kind, "HOLD"); assert.equal(b.events().filter((e) => e.type === "attorney.instruction.sent").length, 1); assert.equal(hold[0]!.status, "armed", "sending is not the firm's acknowledgment");
  const ackInput = { case_id: "C-5", loan_id: L, action: "counsel_ack", transfer_date: "2026-12-01", kind: "HOLD", acked_on: "2026-11-27", instruction_sent_on: "2026-11-24", firm_id: "firm-1", ack_reference: "FIRM1-ACK-77" };
  await assert.rejects(b.run("completePreTransferAction", ackInput), refused("COUNSEL_ACK_BY_FIRM"), "the agent cannot acknowledge its own instruction");
  await assert.rejects(b.run("completePreTransferAction", { ...ackInput, firm_id: undefined }, FIRM), rangeError(/firm_id is required/));
  assert.equal(hold[0]!.status, "armed");
  const ack = await b.run("completePreTransferAction", ackInput, FIRM) as { on_time: boolean; due: string };
  assert.equal(ack.on_time, true); assert.equal(ack.due, "2026-11-30"); assert.equal(hold[0]!.status, "satisfied");
  const ackEv = b.events().find((e) => e.type === "attorney.instruction.acked")!; assert.equal(ackEv.payload.firm_id, "firm-1"); assert.equal(ackEv.payload.acked_by, FIRM.id); assert.equal(ackEv.actor.role, "attorney");
  assert.equal(counselAcknowledgment({ transfer_date: T, kind: "HOLD", acked_on: D("2026-12-01") }).on_time, false);
  // the foreclosure package delivered with the (g) analysis satisfies the sale-window row; a hold instruction on or after T is refused (nothing issues after T)
  await b.run("packageCase", { case_id: "C-5", loan_id: L, transfer_date: "2026-12-01", snapshot: fc, package_document_id: "doc-pkg-5" });
  await b.run("packageCase", { case_id: "C-5", loan_id: L, transfer_date: "2026-12-01", op: "deliver", snapshot: fc }); assert.equal(sale[0]!.status, "satisfied");
  await assert.rejects(b.run("completePreTransferAction", { case_id: "C-5", loan_id: L, action: "hold_instruction", transfer_date: "2026-12-01", sale_on: "2026-12-22", complete_received_on: "2026-11-10", today: "2026-12-01" }), refused("NOTHING_ISSUED_AFTER_T"));
  const afterT = bus17_4("2026-12-02T15:00:00.000Z");
  await assert.rejects(afterT.run("completePreTransferAction", { case_id: "C-5", loan_id: L, action: "hold_instruction", transfer_date: "2026-12-01", sale_on: "2026-12-22", complete_received_on: "2026-11-10" }), refused("NOTHING_ISSUED_AFTER_T"), "omitting `today` falls back to the bus clock, which is after T");
  // a loss-mit case with an open (g) gate and no foreclosure case still arms the hold-instruction row (spec trigger: fc_active OR gates open)
  const lm = bus17_4("2026-11-24T15:00:00.000Z"); await inventory(lm, [{ case_id: "C-5b", loan_id: L, opened_on: "2026-11-05", snapshot: { case_type: "lossmit", received_at: D("2026-11-05"), completeness: "complete", complete_at: D("2026-11-10") } }]);
  assert.equal(armed(lm, "SM_LOSSMIT_HOLD_INSTRUCTIONS_T1").length, 1); assert.equal(armed(lm, "SM_FC_SALE_WINDOW_HANDOFF").length, 0);
});
test("17.4-T6: Given an attempt to cancel a 12.2 timer on a listed loan with reason `transfer_out` on Nov 20, then the command is refused by `REGX_1024_41_TRANSFEROR_CONTINUES_GATE`.", async () => {
  const c = cancelTimerRequest({ listed: true, reason: "transfer_out", today: D("2026-11-20"), transfer_date: T, timer_code: "REGX_1024_41C1_EVAL_30" });
  assert.equal(c.allowed, false); assert.equal(c.gate, "REGX_1024_41_TRANSFEROR_CONTINUES_GATE"); assert.match(c.refusal!, /cancelTimer REGX_1024_41C1_EVAL_30 refused by REGX_1024_41_TRANSFEROR_CONTINUES_GATE: reason transfer_out before 2026-12-01/);
  // on the bus with the 12.2/13.2 row live: the complete application received Nov 10 arms REGX_1024_41C1_EVAL_30 on the listed loan (Nov 10 + 30 = Dec 10)
  const b = bus17_4("2026-11-20T15:00:00.000Z", ["17.4", "13.2"]);
  b.ctx.events.append({ type: "lossmit.application.completed", loanId: L, actor: AGENT, occurredAt: "2026-11-10T15:00:00.000Z", payload: { application_id: "A-6", status: "complete", complete_at: "2026-11-10", days_before_sale: 42 } });
  const inst = armed(b, "REGX_1024_41C1_EVAL_30"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2026-12-10"); assert.equal(inst[0]!.status, "armed");
  // the cancel is refused before anything runs — the only trace is the refusal event; the instance stays armed; no timer.cancelled
  const before = b.events().length;
  await assert.rejects(b.run("completePreTransferAction", { case_id: "C-6", loan_id: L, action: "cancel_timer", timer_code: "REGX_1024_41C1_EVAL_30", reason: "transfer_out", today: "2026-11-20", transfer_date: "2026-12-01" }), refused("REGX_1024_41_TRANSFEROR_CONTINUES_GATE"));
  assert.deepEqual(b.events().slice(before).map((e) => e.type), ["command.refused"]); assert.equal(b.events().slice(before)[0]!.payload.code, "REGX_1024_41_TRANSFEROR_CONTINUES_GATE"); assert.equal(inst[0]!.status, "armed");
  // an officer is bound by the gate too (it is a `never`, not a role gate); omitting `today` measures the bus clock (Nov 20 < T) — still refused; the id form is refused too
  await assert.rejects(b.run("completePreTransferAction", { case_id: "C-6", loan_id: L, action: "cancel_timer", timer_code: "REGX_1024_41C1_EVAL_30", reason: "transfer_out", today: "2026-11-20", transfer_date: "2026-12-01" }, { kind: "human", id: "u-officer", role: "officer" }), refused("REGX_1024_41_TRANSFEROR_CONTINUES_GATE"));
  await assert.rejects(b.run("completePreTransferAction", { case_id: "C-6", loan_id: L, action: "cancel_timer", timer_code: "REGX_1024_41C1_EVAL_30", timer_id: inst[0]!.id, reason: "transfer_out", transfer_date: "2026-12-01" }), refused("REGX_1024_41_TRANSFEROR_CONTINUES_GATE"));
  assert.equal(b.events().filter((e) => e.type === "timer.cancelled").length, 0);
  // the gate is about the reason and the date, not cancellation itself: a withdrawal on Nov 20 cancels the real instance; cancelling nothing is an error, not a silent no-op
  assert.equal(cancelTimerRequest({ listed: true, reason: "application_withdrawn", today: D("2026-11-20"), transfer_date: T, timer_code: "REGX_1024_41C1_EVAL_30" }).allowed, true);
  await assert.rejects(b.run("completePreTransferAction", { case_id: "C-6", loan_id: L, action: "cancel_timer", timer_code: "REGX_1024_41B2_ACK_5", reason: "application_withdrawn", today: "2026-11-20", transfer_date: "2026-12-01" }), rangeError(/no armed REGX_1024_41B2_ACK_5 instance on loan L-174/));
  const ok = await b.run("completePreTransferAction", { case_id: "C-6", loan_id: L, action: "cancel_timer", timer_code: "REGX_1024_41C1_EVAL_30", reason: "application_withdrawn", today: "2026-11-20", transfer_date: "2026-12-01" }) as { allowed: boolean; cancelled_timer_ids: string[] };
  assert.equal(ok.allowed, true); assert.deepEqual(ok.cancelled_timer_ids, [inst[0]!.id]); assert.equal(inst[0]!.status, "cancelled"); assert.equal(inst[0]!.cancelledReason, "application_withdrawn");
  assert.equal(cancelTimerRequest({ listed: true, reason: "transfer_out", today: D("2026-12-01"), transfer_date: T, timer_code: "REGX_1024_41C1_EVAL_30" }).allowed, true, "after T the loan is no longer Supermortgage's to keep clocks on");
  // the registry row is the evaluator-backed gate the section overrides name
  assert.equal(loadOverriddenRegistry().get("REGX_1024_41_TRANSFEROR_CONTINUES_GATE")!.offsetParsed.kind, "evaluator");
  assert.equal(EVALUATORS["17.4.noTransferOutCancellationBeforeTransferDate"]!({ cancel_reason: "transfer_out", today: "2026-11-20", transfer_date: "2026-12-01" }).open, false);
  assert.equal(EVALUATORS["17.4.noTransferOutCancellationBeforeTransferDate"]!({ cancel_reason: "application_withdrawn", today: "2026-11-20", transfer_date: "2026-12-01" }).open, true);
});
test("17.4-T7: Given an NoE received Nov 28 on a listed loan, then Supermortgage answers within the 4.1 clock after T and the transferee receives a copy.", async () => {
  const r = retainedRequest({ kind: "noe", received_on: D("2026-11-28"), transfer_date: T, assertion_type: "b1" });
  assert.equal(r.gate, "SM_NOE_RFI_OPEN_RETAINED"); assert.equal(r.opened_before_transfer, true); assert.equal(r.owner, "supermortgage"); assert.equal(r.handoff_status, "retained");
  assert.equal(r.ack_due, "2026-12-04", "5 federal BD from Sat Nov 28: Nov 30, Dec 1–4"); assert.equal(r.response_due, "2027-01-12", "30 federal BD from Nov 28 skipping Dec 25 and Jan 1");
  assert.equal(r.answered_after_transfer, true); assert.equal(r.clocks_unchanged, true); assert.equal(r.copy_to_transferee, true); assert.equal(r.referred_to_transferee, false); assert.equal(r.forward_instead, false);
  assert.equal(inventoryScope({ listed: true, case_type: "noe", opened_on: D("2026-11-28"), attested_on: D("2026-11-25"), today: D("2026-11-30") }).handoff_status, "retained");
  assert.equal(EVALUATORS["17.4.retainedCaseOwnership"]!({ case_owner: r.owner }).open, true);
  // an item about the transferee's future servicing is referred; an NoE received on or after T is not Supermortgage's — it is forwarded
  assert.equal(retainedRequest({ kind: "noe", received_on: D("2026-11-28"), transfer_date: T, concerns: "transferee_future_servicing" }).referred_to_transferee, true);
  const after = retainedRequest({ kind: "noe", received_on: D("2026-12-02"), transfer_date: T }); assert.equal(after.owner, "transferee"); assert.equal(after.forward_instead, true);
  assert.equal(EVALUATORS["17.4.retainedCaseOwnership"]!({ case_owner: after.owner }).open, false);
  // on the bus: the NoE opened Nov 28 on the listed loan is inventoried as retained (owner Supermortgage) and arms the SM_NOE_RFI_OPEN_RETAINED gate on the loan
  const b = bus17_4("2026-11-30T15:00:00.000Z"); await inventory(b, [{ case_id: "C-7", loan_id: L, opened_on: "2026-11-28", snapshot: { case_type: "noe" } }]);
  const inv = b.events().find((e) => e.type === "case.handoff.inventoried" && e.payload.scope === "case")!; assert.equal(inv.payload.case_kind, "noe"); assert.equal(inv.payload.opened_before_transfer, true); assert.equal(inv.payload.case_owner, "supermortgage"); assert.equal(inv.payload.handoff_status, "retained");
  const gate = armed(b, "SM_NOE_RFI_OPEN_RETAINED"); assert.equal(gate.length, 1); assert.equal(gate[0]!.note, "evaluator:17.4.retainedCaseOwnership"); assert.equal(gate[0]!.status, "armed");
  // after T (Dec 2): answering the retained NoE is a post-T duty, not an issuance on a transferred loan — allowed; the answer with the transferee's copy is recorded and closes the gate
  const plan = await b.run("completePreTransferAction", { case_id: "C-7", loan_id: L, action: "retained_request", kind: "noe", received_on: "2026-11-28", transfer_date: "2026-12-01", assertion_type: "b1", today: "2026-12-02" }) as { owner: string; response_due: string };
  assert.equal(plan.owner, "supermortgage"); assert.equal(plan.response_due, "2027-01-12"); assert.equal(gate[0]!.status, "armed");
  const answered = await b.run("completePreTransferAction", { case_id: "C-7", loan_id: L, action: "retained_request", kind: "noe", received_on: "2026-11-28", transfer_date: "2026-12-01", assertion_type: "b1", today: "2026-12-18", response_sent_on: "2026-12-18", transferee_copy_document_id: "doc-noe-copy" }) as { response_on_time: boolean; transferee_copy_document_id: string };
  assert.equal(answered.response_on_time, true); assert.equal(answered.transferee_copy_document_id, "doc-noe-copy");
  const sent = b.events().find((e) => e.type === "case.response.sent")!; assert.equal(sent.payload.owner, "supermortgage"); assert.equal(sent.payload.copy_to_transferee, true); assert.equal(sent.payload.response_due, "2027-01-12"); assert.equal(gate[0]!.status, "satisfied");
  await assert.rejects(b.run("completePreTransferAction", { case_id: "C-7", loan_id: L, action: "retained_request", kind: "noe", received_on: "2026-11-28", transfer_date: "2026-12-01", response_sent_on: "2026-12-18" }), rangeError(/transferee_copy_document_id/), "no answer without the transferee's copy");
});
test("17.4-T8: Given a trial payment received Dec 3 for the Dec 1 due date, then it is forwarded with receipt date Dec 3 and Supermortgage records no trial failure.", async () => {
  const r = trialPaymentHandoff({ due_on: D("2026-12-01"), received_on: D("2026-12-03"), transfer_date: T, amount_cents: 152_830n, trial_amount_cents: 152_830n, forwarded_on: D("2026-12-04") });
  assert.equal(r.timer, "FNMA_F1_27_TRIAL_PAYMENT_EOM"); assert.equal(r.month_end, "2026-12-31"); assert.equal(r.month_end_servicer, "transferee");
  assert.equal(r.misdirected, true); assert.equal(r.protected, true); assert.equal(r.receipt_date, "2026-12-03"); assert.equal(r.forward_by, "2026-12-04"); assert.equal(r.forwarded_on_time, true);
  assert.equal(r.month_met, true); assert.equal(r.failure_recorded_by_supermortgage, false); assert.equal(r.failure_determination_owner, "transferee"); assert.equal(r.smdu_reported_by_supermortgage, false);
  // the trial fails only if no December payment is received by Dec 31 — the transferee's determination, never Supermortgage's
  const none = trialPaymentHandoff({ due_on: D("2026-12-01"), received_on: null, transfer_date: T }); assert.equal(none.month_met, false); assert.equal(none.failure_recorded_by_supermortgage, false); assert.equal(none.failure_determination_owner, "transferee");
  // a November trial month (ending Nov 30 ≤ T−1) is Supermortgage's to record and report through SMDU
  const nov = trialPaymentHandoff({ due_on: D("2026-11-01"), received_on: null, transfer_date: T }); assert.equal(nov.month_end, "2026-11-30"); assert.equal(nov.month_end_servicer, "supermortgage"); assert.equal(nov.failure_recorded_by_supermortgage, true); assert.equal(nov.smdu_reported_by_supermortgage, true);
  assert.equal(trialPaymentHandoff({ due_on: D("2026-11-01"), received_on: D("2026-11-20"), transfer_date: T }).failure_recorded_by_supermortgage, false);
  const plan: CaseSnapshot = { case_type: "modification", trial_start: D("2026-10-01"), trial_payments: [{ due_on: D("2026-10-01"), received_on: D("2026-10-01") }, { due_on: D("2026-11-01"), received_on: D("2026-11-01") }, { due_on: D("2026-12-01"), received_on: null }] };
  assert.deepEqual(deadlineTable(plan, T).filter((x) => x.code === "FNMA_F1_27_TRIAL_PAYMENT_EOM").map((x) => [x.anchor, x.due_at, x.owner_after_transfer]), [["2026-12-01", "2026-12-31", "transferee"]]);
  // on the bus on Dec 3 (after T): forwarding the misdirected payment is a post-T duty — allowed; the forwarding row carries receipt date Dec 3; a late forwarding still protects the borrower and is logged as a breach
  const b = bus17_4("2026-12-03T15:00:00.000Z");
  const out = await b.run("completePreTransferAction", { case_id: "C-8", loan_id: L, action: "trial_payment", transfer_date: "2026-12-01", due_on: "2026-12-01", received_on: "2026-12-03", forwarded_on: "2026-12-04", amount_cents: 152_830n, trial_amount_cents: 152_830n }) as { receipt_date: string; failure_recorded_by_supermortgage: boolean };
  assert.equal(out.receipt_date, "2026-12-03"); assert.equal(out.failure_recorded_by_supermortgage, false);
  const fwd = b.rt.store.list("post_transfer_forwardings").map((x) => x.data); assert.equal(fwd.length, 1); assert.equal(fwd[0]!.received_at, "2026-12-03"); assert.equal(fwd[0]!.kind, "other");
  assert.equal(b.events().find((e) => e.type === "lossmit.trial_payment.forwarded")!.payload.receipt_date, "2026-12-03"); assert.equal(b.rt.escalations.opened.length, 0);
  await b.run("completePreTransferAction", { case_id: "C-8", loan_id: L, action: "trial_payment", transfer_date: "2026-12-01", due_on: "2026-12-01", received_on: "2026-12-03", forwarded_on: "2026-12-08", today: "2026-12-08" });
  assert.ok(b.rt.escalations.opened.some((e) => e.kind === "officer" && /receipt date still protects the borrower/.test(String(e.payload.reason))));
  // the Nov 1 trial installment still unpaid at attestation arms FNMA_F1_27_TRIAL_PAYMENT_EOM for Supermortgage (due Nov 30, the last day of its month);
  // cashiering's trial application (`payment.applied{source=trial_held_funds}`) satisfies it; the Dec 1 installment (due on T) is the transferee's and is not flagged
  const pre = bus17_4("2026-11-24T15:00:00.000Z"); const open: CaseSnapshot = { ...plan, trial_payments: [{ due_on: D("2026-10-01"), received_on: D("2026-10-01") }, { due_on: D("2026-11-01"), received_on: null }, { due_on: D("2026-12-01"), received_on: null }] };
  assert.deepEqual([inventoryFlags(open, T).trial_payment_due_before_transfer, inventoryFlags(open, T).trial_due_date, inventoryFlags(plan, T).trial_payment_due_before_transfer], [true, "2026-11-01", false]);
  await inventory(pre, [{ case_id: "C-8", loan_id: L, opened_on: "2026-09-15", snapshot: open }]);
  const inst = armed(pre, "FNMA_F1_27_TRIAL_PAYMENT_EOM"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2026-11-30");
  pre.ctx.events.append({ type: "payment.applied", loanId: L, actor: { kind: "agent", id: "cashiering" }, payload: { payment_id: "trial:C-8:2026-11-25", installment_due_date: "2026-11-01", credited_as_of: "2026-11-25", allocation_outcome: "applied", source: "trial_held_funds" } });
  assert.equal(inst[0]!.status, "satisfied");
});
test("17.4-T9: Given a forbearance history of 9 cumulative months from Mar 1, 2026, then `TO-08` exports 9 and the transferee-side gate allows one more 3-month increment.", () => {
  const s: CaseSnapshot = { case_type: "forbearance", forbearance_history: { initial_start: D("2026-03-01"), increments_months: [3, 3, 3] } };
  // TO-08 exports the initial start, the increments and the cumulative months, and says what the transferee may still grant under LL-2026-01 (12-month cap from the initial start)
  const to08 = check(handoffChecks(s, T), "TO-08"); assert.equal(to08.result, "pass");
  assert.match(to08.note, /initial start 2026-03-01; increments 3\+3\+3 = 9 months; transferee may grant 3 more/);
  assert.deepEqual(forbearanceCarryover(9, 3), { allowed_months: 3, exception_required: false }, "one further 3-month increment");
  assert.deepEqual(forbearanceCarryover(9, 6), { allowed_months: 3, exception_required: true }, "a 6-month request exceeds the 3 months of room — Fannie Mae exception");
  assert.deepEqual(forbearanceCarryover(12, 3), { allowed_months: 0, exception_required: true });
  // the cumulative gate is exported, not satisfied: anchor = initial start, 12 months cumulative, the transferee enforces it
  assert.deepEqual(deadlineTable(s, T).find((r) => r.code === "FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M"), { code: "FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M", anchor: "2026-03-01", due_at: "2027-03-01", status: "exported", owner_after_transfer: "transferee" });
  assert.equal(check(handoffChecks({ case_type: "lossmit", received_at: D("2026-11-25") }, T), "TO-08").result, "n_a");
  assert.match(check(handoffChecks({ case_type: "forbearance", forbearance_history: { initial_start: D("2026-03-01"), increments_months: [3, 3, 3, 3] } }, T), "TO-08").note, /= 12 months; transferee may grant 0 more/);
});
test("17.4-T10: Given the AI proposes a denial on Nov 29 to beat T, then the notice cannot issue without a `lossmit_reviewer` approval record, and absent approval the case is handed off undetermined.", async () => {
  const r = preTransferDetermination({ outcome: "denial", proposed_on: D("2026-11-29"), transfer_date: T, complete_at: D("2026-11-10"), evaluator_id: "ai-lossmit-underwriter" });
  assert.equal(r.adverse, true); assert.equal(r.issue_by, "2026-11-30"); assert.equal(r.supermortgage_due, "2026-12-10"); assert.equal(r.due_before_transfer, false);
  assert.equal(r.can_issue, false); assert.equal(r.refusal_code, "DENIAL_NEEDS_REVIEWER"); assert.match(r.refusal!, /lossmit_reviewer approval record/); assert.equal(r.rushed_to_beat_transfer, true);
  assert.equal(r.handoff.status, "handed_off_undetermined"); assert.equal(r.handoff.transferee_deadline, "2026-12-31"); assert.equal(r.handoff.to_04.result, "pass"); assert.match(r.handoff.to_04.note, /not sent; period unexpired \(due 2026-12-10\)/);
  assert.equal(r.escalation!.kind, "lossmit_reviewer");
  // with a different reviewer's record by T−1 it issues; the evaluator cannot be the reviewer; nothing issues on or after T; a determination before its evaluation is done is rushed — refused
  const ok = preTransferDetermination({ outcome: "denial", proposed_on: D("2026-11-29"), transfer_date: T, complete_at: D("2026-11-10"), evaluator_id: "ai-lossmit-underwriter", reviewer_approval: { reviewer_id: "u-reviewer-2", approved_on: D("2026-11-30"), record_id: "rev-1" } });
  assert.equal(ok.can_issue, true); assert.equal(ok.handoff.status, "determined_before_transfer"); assert.match(ok.handoff.to_04.note, /rev-1/); assert.equal(ok.rushed_to_beat_transfer, false);
  assert.equal(preTransferDetermination({ outcome: "denial", proposed_on: D("2026-11-29"), transfer_date: T, complete_at: D("2026-11-10"), evaluator_id: "u-reviewer-2", reviewer_approval: { reviewer_id: "u-reviewer-2", approved_on: D("2026-11-30"), record_id: "rev-1" } }).refusal_code, "REVIEWER_SEPARATION");
  assert.equal(preTransferDetermination({ outcome: "denial", proposed_on: D("2026-12-01"), transfer_date: T, complete_at: D("2026-11-10"), evaluator_id: "x", reviewer_approval: { reviewer_id: "y", approved_on: D("2026-12-01"), record_id: "rev-2" } }).refusal_code, "NOTHING_ISSUED_AFTER_T");
  assert.equal(preTransferDetermination({ outcome: "offer", proposed_on: D("2026-11-29"), transfer_date: T, complete_at: D("2026-11-10"), evaluator_id: "x" }).can_issue, true, "a non-adverse determination needs no reviewer record");
  const rushed = preTransferDetermination({ outcome: "offer", proposed_on: D("2026-11-29"), transfer_date: T, complete_at: D("2026-11-10"), evaluator_id: "x", evaluation_complete: false }); assert.equal(rushed.refusal_code, "NEVER_RUSH_DETERMINATION"); assert.equal(rushed.rushed_to_beat_transfer, true); assert.equal(rushed.handoff.status, "handed_off_undetermined");
  // on the bus: the agent's denial without a reviewer approval is refused (DENIAL_NEEDS_REVIEWER) before anything runs; so is any determination proposed before its evaluation is complete
  const b = bus17_4(); const before = b.events().length; const base = { case_id: "C-1", loan_id: L, outcome: "denial", transfer_date: "2026-12-01", complete_at: "2026-11-10", today: "2026-11-29", evaluator_id: "ai-lossmit-underwriter" };
  await assert.rejects(b.run("draftDetermination", base), refused("DENIAL_NEEDS_REVIEWER"));
  assert.deepEqual(b.events().slice(before).map((e) => e.type), ["command.refused"]);
  await assert.rejects(b.run("draftDetermination", { ...base, outcome: "offer", evaluation_complete: false }), refused("NEVER_RUSH_DETERMINATION"));
  await assert.rejects(b.run("draftDetermination", { ...base, outcome: "offer", evaluation_complete: false }, REVIEWER), refused("NEVER_RUSH_DETERMINATION"), "no role overrides the work-down rule");
  // a bare approval id proves nothing: an id with no record behind it is handed off undetermined and the reviewer work item is opened
  const bogus = await b.run("draftDetermination", { ...base, reviewer_approval_id: "rev-9" }) as { can_issue: boolean; approval_lookup: string; refusal_code: string; handoff: { status: string }; draft_only: boolean };
  assert.equal(bogus.can_issue, false); assert.equal(bogus.approval_lookup, "not_found"); assert.equal(bogus.refusal_code, "DENIAL_NEEDS_REVIEWER"); assert.equal(bogus.handoff.status, "handed_off_undetermined"); assert.equal(bogus.draft_only, true);
  const item = b.rt.escalations.opened.find((e) => e.kind === "lossmit_reviewer")!; assert.ok(item, "the reviewer work item is opened");
  // only a human lossmit_reviewer writes the approval record, and never for their own evaluation
  await assert.rejects(b.run("lossmit_reviewer", { op: "approve", case_id: "C-1", outcome: "denial", evaluator_id: "ai-lossmit-underwriter" }), refused("REVIEWER_APPROVAL_IS_HUMAN"));
  await assert.rejects(b.run("lossmit_reviewer", { op: "approve", case_id: "C-1", outcome: "denial", evaluator_id: REVIEWER.id }, REVIEWER), refused("REVIEWER_SEPARATION"));
  const approval = await b.run("lossmit_reviewer", { op: "approve", case_id: "C-1", loan_id: L, outcome: "denial", evaluator_id: "ai-lossmit-underwriter", approved_on: "2026-11-30", escalation_id: item.id, evidence_document_id: "doc-review-1" }, REVIEWER) as { approval_id: string; reviewer_id: string };
  assert.equal(approval.reviewer_id, REVIEWER.id); assert.equal(item.status, "completed"); assert.ok(b.events().some((e) => e.type === "lossmit.determination.reviewed"));
  // the verified record lets the denial issue before T; the same record does not cover another outcome or another case
  const issued = await b.run("draftDetermination", { ...base, reviewer_approval_id: approval.approval_id }) as { can_issue: boolean; approval_lookup: string; handoff: { status: string } };
  assert.equal(issued.can_issue, true); assert.equal(issued.approval_lookup, "verified"); assert.equal(issued.handoff.status, "determined_before_transfer");
  assert.equal((await b.run("draftDetermination", { ...base, outcome: "appeal_denied", reviewer_approval_id: approval.approval_id }) as { approval_lookup: string }).approval_lookup, "mismatch");
  assert.equal((await b.run("draftDetermination", { ...base, case_id: "C-99", reviewer_approval_id: approval.approval_id }) as { can_issue: boolean }).can_issue, false);
  // nothing issues on or after T even with a record; the reviewer's own call without a record is a hand-off; a negotiated offer is MLO activity for a licensed_specialist
  await assert.rejects(b.run("draftDetermination", { ...base, today: "2026-12-01", reviewer_approval_id: approval.approval_id }), refused("NOTHING_ISSUED_AFTER_T"));
  const own = await b.run("draftDetermination", { ...base, evaluator_id: "ai-lossmit-underwriter" }, REVIEWER) as { can_issue: boolean; handoff: { status: string } }; assert.equal(own.can_issue, false); assert.equal(own.handoff.status, "handed_off_undetermined");
  await assert.rejects(b.run("draftDetermination", { ...base, outcome: "offer", terms_negotiated: true }), refused("MLO_ACTIVITY_NEEDS_LICENSED_SPECIALIST"));
  assert.equal((await b.run("draftDetermination", { ...base, outcome: "offer", terms_negotiated: true }, { kind: "human", id: "u-mlo", role: "licensed_specialist" }) as { can_issue: boolean }).can_issue, true);
  // the decision record names the case, its handoff status, rationale, reviewer and versions (spec decision record) — an empty record is refused
  await assert.rejects(b.run("writeDecision", {}), rangeError(/case_id is required/));
  const dec = await b.run("writeDecision", { case_id: "C-1", loan_id: L, handoff_status: "packaged", rationale: "denial issued Nov 30 with reviewer record", reviewer: REVIEWER.id, model_version: "lm-2026.09", rule_set_version: "17.4@2026-09", actions_before_T: ["determination"], forwarded_items: [] }) as { recorded: boolean; record: { reviewer: string } };
  assert.equal(dec.recorded, true); assert.equal(dec.record.reviewer, REVIEWER.id);
  const stored = b.ctx.decisions.find((d) => d.action === "case.handoff.packaged")!; assert.ok(stored, "the decision row names the handoff transition"); assert.deepEqual(stored.subject, { kind: "case", id: "C-1" }); assert.equal(stored.ruleSetVersion, "17.4@2026-09");
});
test("17.4-T11: Given a bankruptcy case with a 3002.1 payment-change notice due Dec 10, then the package flags it, counsel is instructed by Nov 30, and the trustee notice is sent by Nov 30.", async () => {
  const r = bankruptcyHandoff({ transfer_date: T, pending_items: [{ kind: "3002.1_payment_change", due_on: D("2026-12-10") }], counsel_instructed_on: D("2026-11-27"), trustee_notice_sent_on: D("2026-11-30"), debtor_counsel_notice_sent_on: D("2026-11-30") });
  assert.equal(r.timer, "SM_BK_HANDOFF_T1"); assert.equal(r.due, "2026-11-30"); assert.equal(r.counsel_instruction_due, "2026-11-30"); assert.equal(r.trustee_notice_due, "2026-11-30"); assert.equal(r.debtor_counsel_notice_due, "2026-11-30");
  assert.deepEqual(r.flagged, [{ kind: "3002.1_payment_change", due_on: "2026-12-10", owner_after_transfer: "transferee", due_after_transfer: true }]);
  assert.equal(r.counsel_instructed_on_time, true); assert.equal(r.trustee_notice_on_time, true); assert.equal(r.debtor_counsel_notice_on_time, true); assert.equal(r.satisfied, true); assert.deepEqual(r.missing, []); assert.equal(r.escalation, null); assert.equal(r.unverified_local_practice, true);
  // both servicer-change notices are required (open question 3 default: trustee and debtor-counsel letters before T): the trustee notice alone does not satisfy the row
  const noDebtor = bankruptcyHandoff({ transfer_date: T, pending_items: [{ kind: "3002.1_payment_change", due_on: D("2026-12-10") }], counsel_instructed_on: D("2026-11-27"), trustee_notice_sent_on: D("2026-11-30") });
  assert.equal(noDebtor.satisfied, false); assert.deepEqual(noDebtor.missing, ["debtor_counsel_notice"]);
  // the 14.2 calculator gives the same Dec 10 from a Dec 31 effective payment change (21 days, Rule 9006)
  assert.equal(bankruptcyHandoff({ transfer_date: T, pending_items: [{ kind: "3002.1_payment_change", effective_due: D("2026-12-31") }] }).flagged[0]!.due_on, "2026-12-10");
  // not done by Nov 30 → sev 1 to the attorney; the checklist's TO-12 fails without the acknowledgment
  const late = bankruptcyHandoff({ transfer_date: T, pending_items: [{ kind: "3002.1_payment_change", due_on: D("2026-12-10") }], counsel_instructed_on: D("2026-11-27"), trustee_notice_sent_on: null, debtor_counsel_notice_sent_on: D("2026-11-30"), today: D("2026-12-01") });
  assert.equal(late.satisfied, false); assert.equal(late.escalation!.kind, "attorney"); assert.equal(late.escalation!.severity, "sev1"); assert.match(late.escalation!.reason, /trustee notice not sent/);
  const checks = handoffChecks({ case_type: "bankruptcy", counsel_instruction: { sent_on: D("2026-11-27"), acked_on: null }, ei_history_document_id: "doc-ei", rule_set_version: "17.4@2026-09" }, T);
  assert.equal(check(checks, "TO-12").result, "fail"); assert.equal(check(checks, "TO-15").result, "pass"); assert.equal(checks.length, 15);
  // the package's trustee_notice_sent / debtor_counsel_notice_sent / counsel_instructed are derived from the dated evidence on the snapshot (on or before T−1 BD), never from input booleans
  const bk: CaseSnapshot = { case_type: "bankruptcy", bankruptcy: { pending_items: [{ kind: "3002.1_payment_change", due_on: D("2026-12-10") }], counsel_instructed_on: D("2026-11-27"), trustee_notice_sent_on: D("2026-11-30"), debtor_counsel_notice_sent_on: D("2026-11-30") }, counsel_instruction: { sent_on: D("2026-11-27"), acked_on: D("2026-11-28") }, ei_history_document_id: "doc-ei", rule_set_version: "17.4@2026-09" };
  const evd = packageEvidence(bk, T, handoffChecks(bk, T)); assert.equal(evd.trustee_notice_sent, true); assert.equal(evd.debtor_counsel_notice_sent, true); assert.equal(evd.counsel_instructed, true); assert.deepEqual(evd.bankruptcy!.flagged.map((f) => [f.kind, f.due_on]), [["3002.1_payment_change", "2026-12-10"]]); assert.deepEqual(evd.deficiencies, []);
  const lateNotice = packageEvidence({ ...bk, bankruptcy: { ...bk.bankruptcy!, trustee_notice_sent_on: D("2026-12-01") } }, T, handoffChecks(bk, T)); assert.equal(lateNotice.trustee_notice_sent, false);
  const b = bus17_4("2026-11-24T15:00:00.000Z"); const def = loadOverriddenRegistry().get("SM_BK_HANDOFF_T1")!;
  await inventory(b, [{ case_id: "C-11", loan_id: L, opened_on: "2026-08-01", snapshot: bk }]);
  const inst = armed(b, "SM_BK_HANDOFF_T1"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2026-11-30");
  await b.run("packageCase", { case_id: "C-11", loan_id: L, transfer_date: "2026-12-01", snapshot: bk, package_document_id: "doc-pkg-11", trustee_notice_sent: false, counsel_instructed: false });
  const packaged = b.events().find((e) => e.type === "case.handoff.packaged")!; assert.equal(packaged.payload.trustee_notice_sent, true); assert.equal(packaged.payload.debtor_counsel_notice_sent, true); assert.equal(packaged.payload.counsel_instructed, true); assert.deepEqual(packaged.payload.bk_items_flagged, [{ kind: "3002.1_payment_change", due_on: "2026-12-10", owner_after_transfer: "transferee", due_after_transfer: true }]);
  assert.equal(eventMatches(def.satisfiedPattern!, packaged), true); assert.equal(inst[0]!.status, "satisfied");
  const b2 = bus17_4("2026-11-24T15:00:00.000Z"); await inventory(b2, [{ case_id: "C-11", loan_id: L, opened_on: "2026-08-01", snapshot: bk }]);
  await b2.run("packageCase", { case_id: "C-11", loan_id: L, transfer_date: "2026-12-01", snapshot: { ...bk, bankruptcy: { ...bk.bankruptcy!, debtor_counsel_notice_sent_on: null } }, trustee_notice_sent: true, debtor_counsel_notice_sent: true, counsel_instructed: true });
  const claimed = b2.events().find((e) => e.type === "case.handoff.packaged")!; assert.equal(claimed.payload.debtor_counsel_notice_sent, false, "the input's claim is ignored"); assert.equal(armed(b2, "SM_BK_HANDOFF_T1")[0]!.status, "armed");
});

test("17.4 case-handoff state machine on the bus: inventoried → packaged → delivered → acked → closed_transferred; deficient → resolved; the T+1/2 BD/5 BD rows arm from and are satisfied by the events the tools emit", async () => {
  const b = bus17_4("2026-12-02T14:00:00.000Z"); const reg = loadOverriddenRegistry();
  const s: CaseSnapshot = { case_type: "lossmit", received_at: D("2026-11-05"), completeness: "complete", complete_at: D("2026-11-10"), ack_sent_at: D("2026-11-06"), ack_document_id: "doc-ack", ei_history_document_id: "doc-ei", rule_set_version: "17.4@2026-09" };
  const fc: CaseSnapshot = { case_type: "foreclosure", foreclosure: { sale_on: D("2027-03-02"), earliest_unpaid_due: D("2026-04-01"), holds_open: [] }, counsel_instruction: { sent_on: D("2026-11-24"), acked_on: D("2026-11-27") }, ei_history_document_id: "doc-ei", rule_set_version: "17.4@2026-09" };
  await assert.rejects(inventory(b, [{ case_id: "C-20", loan_id: L, opened_on: "2026-11-05", snapshot: s }], { listed_loan_ids: [] }), rangeError(/listed_loan_ids/), "the inventory is over the attested loan list, never every case");
  const inv = await inventory(b, [{ case_id: "C-20", loan_id: L, opened_on: "2026-11-05", snapshot: s }, { case_id: "C-21", loan_id: "L-other", opened_on: "2026-11-05", snapshot: s }, { case_id: "C-22", loan_id: L, opened_on: "2026-10-01", closed_on: "2026-10-15", snapshot: s }, { case_id: "C-23", loan_id: L, opened_on: "2026-08-01", snapshot: fc }, { case_id: "C-24", loan_id: L, opened_on: "2026-11-20", snapshot: { case_type: "rfi" } }]) as unknown as { case_id: string }[];
  assert.deepEqual(inv.map((c) => c.case_id), ["C-20", "C-23", "C-24"], "unlisted and already-closed cases are out of scope");
  assert.equal(b.rt.store.get("case_handoffs", "C-20")!.data.status, "inventoried"); assert.equal(b.rt.store.get("cases", "C-20")!.data.handoff_status, "inventoried"); assert.equal(b.rt.store.get("cases", "C-24")!.data.handoff_status, "retained");
  const batchInv = b.events().filter((e) => e.type === "case.handoff.inventoried" && e.payload.scope === "batch"); assert.equal(batchInv.length, 1); assert.deepEqual(batchInv[0]!.aggregate, BATCH); assert.equal(batchInv[0]!.payload.cases, 3); assert.equal(batchInv[0]!.payload.lossmit_cases, 1); assert.equal(batchInv[0]!.payload.retained_cases, 1);
  // TO-13 (recovery analysis) is missing: the package op cannot claim `packaged` — the case goes deficient, which arms the 5-BD cure row
  const def = await b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", snapshot: s }) as { status: string; deficiencies: string[]; cure_by: string };
  assert.equal(def.status, "deficient"); assert.deepEqual(def.deficiencies, ["TO-13"]); assert.equal(def.cure_by, "2026-12-09");
  const cure = armed(b, "SM_CASE_HANDOFF_DEFICIENCY_5BD"); assert.equal(cure.length, 1); assert.equal(cure[0]!.dueDate, "2026-12-09"); assert.ok(b.rt.escalations.opened.some((e) => e.kind === "officer" && /cannot be cured before T/.test(String(e.payload.reason))));
  assert.equal(eventMatches(reg.get("SM_CASE_HANDOFF_DEFICIENCY_5BD")!.triggerPattern!, b.events().find((e) => e.type === "case.handoff.deficient")!), true);
  await b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", op: "resolve", cure_document_id: "doc-ra-20" }); assert.equal(cure[0]!.status, "satisfied");
  // a documented deficiency packages; the batch's work-down roll-up holds once its only loss-mit case is packaged documented (the foreclosure case is not a loss-mit case; the retained RFI does not count)
  const wd = armed(b, "SM_LOSSMIT_PRE_T_WORKDOWN_T1"); assert.equal(wd.length, 1); assert.equal(wd[0]!.status, "armed");
  const pkg = await b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", snapshot: s, deficiencies_documented: ["TO-13"], package_document_id: "doc-pkg-20" }) as { status: string; evidence: { pre_transfer_workdown: string }; batch_rollup: { lossmit: number; workdown_documented: boolean } };
  assert.equal(pkg.status, "packaged"); assert.equal(pkg.evidence.pre_transfer_workdown, "documented"); assert.deepEqual(pkg.batch_rollup, { handed_off: 2, acked: 0, all_acked: false, lossmit: 1, lossmit_packaged: 1, workdown_documented: true, workdown_undocumented: [] }); assert.equal(wd[0]!.status, "satisfied");
  await b.run("packageCase", { case_id: "C-23", loan_id: L, transfer_date: "2026-12-01", package_document_id: "doc-pkg-23" });
  // 17.3's cutover freeze (on the batch aggregate, no loan) arms SM_LOSSMIT_HANDOFF_FILE_1 (T+1 servicer BD = Dec 2); the package delivered arms the 2-BD ack row; the transferee's ack satisfies it;
  // the batch row is satisfied only once every handed-off case of the batch is acked — the first ack leaves it armed
  b.ctx.events.append({ type: "transfer.cutover.frozen", aggregate: BATCH, actor: { kind: "agent", id: "transfer" }, payload: { transfer_date: "2026-12-01", batch_id: B, holds: 2, frozen_on: "2026-11-30" } });
  const file1 = armed(b, "SM_LOSSMIT_HANDOFF_FILE_1"); assert.equal(file1.length, 1); assert.equal(file1[0]!.dueDate, "2026-12-02"); assert.deepEqual(file1[0]!.subject, BATCH);
  const delivered = await b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", op: "deliver", recipient: "transferee" }) as { status: string; delivered_at: string };
  assert.equal(delivered.status, "delivered"); const ack2 = armed(b, "SM_CASE_HANDOFF_ACK_2BD"); assert.equal(ack2.length, 1); assert.equal(ack2[0]!.dueDate, "2026-12-04");
  await b.run("packageCase", { case_id: "C-23", loan_id: L, transfer_date: "2026-12-01", op: "deliver" }); assert.equal(armed(b, "SM_CASE_HANDOFF_ACK_2BD").length, 2);
  await assert.rejects(b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", op: "close" }), rangeError(/delivered → closed_transferred is not a transition/));
  await assert.rejects(b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", op: "ack", ack_reference: "ACK-20" }), rangeError(/acked_by is required/), "the acknowledgment names the acknowledging party at the transferee");
  const first = await b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", op: "ack", ack_reference: "ACK-20", acked_by: "transferee:lossmit-desk" }) as { batch_rollup: { all_acked: boolean; acked: number } };
  assert.equal(ack2[0]!.status, "satisfied"); assert.deepEqual([first.batch_rollup.acked, first.batch_rollup.all_acked], [1, false]); assert.equal(file1[0]!.status, "armed", "one of two handed-off cases acked: the batch row waits");
  assert.equal(b.events().filter((e) => e.type === "case.handoff.acked" && e.payload.scope === "batch").length, 0);
  await b.run("packageCase", { case_id: "C-23", loan_id: L, transfer_date: "2026-12-01", op: "ack", ack_reference: "ACK-23", acked_by: "transferee:default-desk" });
  const batchAck = b.events().filter((e) => e.type === "case.handoff.acked" && e.payload.scope === "batch"); assert.equal(batchAck.length, 1); assert.deepEqual(batchAck[0]!.aggregate, BATCH); assert.equal(batchAck[0]!.payload.all_cases, true); assert.equal(batchAck[0]!.payload.stage, "final");
  assert.equal(eventMatches(reg.get("SM_LOSSMIT_HANDOFF_FILE_1")!.satisfiedPattern!, batchAck[0]!), true); assert.equal(file1[0]!.status, "satisfied");
  assert.deepEqual(batchHandoffRollup([{ case_id: "a", case_type: "lossmit", status: "acked" }, { case_id: "b", case_type: "noe", status: "retained" }]), { handed_off: 1, acked: 1, all_acked: true, lossmit: 1, lossmit_packaged: 1, workdown_documented: false, workdown_undocumented: ["a"] }, "retained cases never count; a packaged case without its work-down state is undocumented");
  // close ends Supermortgage's processing
  const closed = await b.run("packageCase", { case_id: "C-20", loan_id: L, transfer_date: "2026-12-01", op: "close" }) as { handoff_status: string };
  assert.equal(closed.handoff_status, "closed_transferred"); assert.equal(b.rt.store.get("case_handoffs", "C-20")!.data.status, "acked", "the table keeps its enum; the machine state is on cases.handoff_status"); assert.equal(b.rt.store.get("cases", "C-20")!.data.handoff_status, "closed_transferred");
  const closedEv = b.events().find((e) => e.type === "case.closed")!; assert.equal(closedEv.payload.reason, "transferred_out"); assert.equal(closedEv.payload.release_reason, "transfer_out");
  assert.deepEqual(b.events().filter((e) => e.type.startsWith("case.handoff.") && e.payload.case_id === "C-20").map((e) => e.type), ["case.handoff.inventoried", "case.handoff.deficient", "case.handoff.resolved", "case.handoff.packaged", "case.handoff.delivered", "case.handoff.acked"]);
  // claims, SII and FPI cycles arm their T−1 rows from the inventory facts and are satisfied by their package deliveries
  const c = bus17_4("2026-11-24T15:00:00.000Z");
  await inventory(c, [{ case_id: "C-40", loan_id: L, opened_on: "2026-10-01", snapshot: { case_type: "insurance_claim", ei_history_document_id: "doc-ei", rule_set_version: "v" } }, { case_id: "C-41", loan_id: L, opened_on: "2026-10-01", snapshot: { case_type: "sii", ei_history_document_id: "doc-ei", rule_set_version: "v" } }, { case_id: "C-42", loan_id: L, opened_on: "2026-10-01", snapshot: { case_type: "fpi", ei_history_document_id: "doc-ei", rule_set_version: "v" } }, { case_id: "C-43", loan_id: L, opened_on: "2026-10-01", snapshot: { case_type: "modification", smdu_case_id: "SMDU-43", smdu_status: "trial", ei_history_document_id: "doc-ei", rule_set_version: "v", recovery_analysis_document_id: "doc-ra" } }]);
  for (const code of ["SM_CLAIM_HANDOFF_T1", "SM_SII_PENDING_HANDOFF_T1", "SM_FPI_CYCLE_HANDOFF_T1"]) { assert.equal(armed(c, code).length, 1, code); assert.equal(armed(c, code)[0]!.dueDate, "2026-11-30", code); }
  for (const [id, code] of [["C-40", "SM_CLAIM_HANDOFF_T1"], ["C-41", "SM_SII_PENDING_HANDOFF_T1"], ["C-42", "SM_FPI_CYCLE_HANDOFF_T1"]] as const) { await c.run("packageCase", { case_id: id, loan_id: L, transfer_date: "2026-12-01" }); await c.run("packageCase", { case_id: id, loan_id: L, transfer_date: "2026-12-01", op: "deliver" }); assert.equal(armed(c, code)[0]!.status, "satisfied", code); }
  // SM_SMDU_CASE_HANDOFF_T0 is a deadline due on T (Dec 1) for the case with an SMDU id; SMDU status is reported through T−1 only; the report through Nov 30 satisfies it
  const smdu = armed(c, "SM_SMDU_CASE_HANDOFF_T0"); assert.equal(smdu.length, 1); assert.equal(smdu[0]!.dueDate, "2026-12-01"); assert.equal(smdu[0]!.status, "armed"); assert.equal(smdu[0]!.loanId, L);
  await assert.rejects(c.run("completePreTransferAction", { case_id: "C-43", loan_id: L, action: "smdu_status", transfer_date: "2026-12-01", smdu_case_id: "SMDU-43", status_reported_through: "2026-12-01" }), refused("NO_SMDU_REPORTING_AFTER_T"));
  const stale = await c.run("completePreTransferAction", { case_id: "C-43", loan_id: L, action: "smdu_status", transfer_date: "2026-12-01", smdu_case_id: "SMDU-43", status_reported_through: "2026-11-27" }) as { ok: boolean }; assert.equal(stale.ok, false); assert.equal(smdu[0]!.status, "armed", "a status snapshot short of T−1 does not satisfy the row");
  assert.equal((await c.run("completePreTransferAction", { case_id: "C-43", loan_id: L, action: "smdu_status", transfer_date: "2026-12-01", smdu_case_id: "SMDU-43", status_reported_through: "2026-11-30" }) as { ok: boolean }).ok, true);
  const reported = c.events().filter((e) => e.type === "smdu.case.status_reported"); assert.equal(reported.length, 2); assert.equal(reported[0]!.payload.handoff_current, false); assert.equal(reported[1]!.payload.handoff_current, true); assert.equal(reported[1]!.payload.status_reported_through, "2026-11-30"); assert.equal(smdu[0]!.status, "satisfied");
  // a servicer-number change without the Fannie Mae request package: handoff_current stays false, the human_portal_task goes to the fnma_portal_operator, and the row breaches at T (sev 1)
  const sn = bus17_4("2026-11-24T15:00:00.000Z"); await inventory(sn, [{ case_id: "C-44", loan_id: L, opened_on: "2026-10-01", snapshot: { case_type: "modification", smdu_case_id: "SMDU-44", smdu_status: "trial" } }]);
  const out = await sn.run("completePreTransferAction", { case_id: "C-44", loan_id: L, action: "smdu_status", transfer_date: "2026-12-01", smdu_case_id: "SMDU-44", status_reported_through: "2026-11-30", servicer_number_change: true }) as { ok: boolean; portal_task: { owner_role: string } | null };
  assert.equal(out.ok, false); assert.equal(out.portal_task!.owner_role, "fnma_portal_operator"); assert.ok(sn.rt.escalations.opened.some((e) => e.kind === "human_portal_task" && e.ownerRole === "fnma_portal_operator"));
  assert.equal(armed(sn, "SM_SMDU_CASE_HANDOFF_T0")[0]!.status, "armed");
  const breach = sn.timers.evaluate("2026-12-02T05:00:00.000Z").find((x) => x.def.code === "SM_SMDU_CASE_HANDOFF_T0")!; assert.ok(breach, "due on T, unsatisfied → breached"); assert.equal(breach.severity, 1); assert.ok(breach.escalateTo.includes("fnma_portal_operator"));
  assert.equal((await sn.run("completePreTransferAction", { case_id: "C-44", loan_id: L, action: "smdu_status", transfer_date: "2026-12-01", smdu_case_id: "SMDU-44", status_reported_through: "2026-11-30", servicer_number_change: true, fnma_request_package_filed: true }) as { ok: boolean }).ok, true);
  assert.equal(armed(sn, "SM_SMDU_CASE_HANDOFF_T0")[0]!.status, "satisfied_late");
});

test("17.4 timers and gates: every 17.4 row is armable and satisfiable after the overrides, and each satisfaction names an event a process actually emits; the payoff-request, D21/D34 and work-down rows", async () => {
  const reg = loadOverriddenRegistry();
  const mine = ["SM_LOSSMIT_HANDOFF_FILE_14", "SM_LOSSMIT_HANDOFF_FILE_1", "SM_LOSSMIT_PRE_T_WORKDOWN_T1", "REGX_1024_41B2_ACK_5", "REGX_1024_41H_APPEAL_DETERMINATION_30", "SM_LOSSMIT_POST_T_FORWARD_1", "SM_LOSSMIT_HOLD_INSTRUCTIONS_T1", "FNMA_F1_27_TRIAL_PAYMENT_EOM", "SM_SMDU_CASE_HANDOFF_T0", "SM_CASE_HANDOFF_ACK_2BD", "SM_CASE_HANDOFF_DEFICIENCY_5BD", "SM_NOE_RFI_OPEN_RETAINED", "SM_PAYOFF_REQUEST_OPEN_7BD", "SM_BK_HANDOFF_T1", "SM_FC_SALE_WINDOW_HANDOFF", "SM_CLAIM_HANDOFF_T1", "SM_SII_PENDING_HANDOFF_T1", "SM_FPI_CYCLE_HANDOFF_T1"];
  for (const code of mine) { const t = reg.get(code)!; assert.ok(t.offsetParsed.kind !== "prose" && t.triggerPattern?.type.includes("."), `${code} armable`); assert.ok(t.offsetParsed.kind === "evaluator" || t.satisfiedPattern?.type.includes("."), `${code} satisfiable`); }
  // the emission lint (tools/lint-emission.ts): every 17.4 row's trigger and satisfaction event — with every conditioned field — is emitted by non-test source outside the override files
  const lint = lintEmission(reg.unique()).filter((r) => r.process === "17.4"); assert.equal(lint.length, 19, "23 codes less the four rows other processes own and 17.4 only exports (REGX_1024_41C1_EVAL_30 → 13.2; REGX_1024_41G_DUAL_TRACK_GATE, REGX_1024_41K2_NO_FIRST_FILING_GATE, FNMA_LL_2026_01_FORBEARANCE_CUMULATIVE_12M → 1.7/13.x)");
  assert.deepEqual(lint.filter((r) => !r.emitted || !r.triggered).map((r) => r.code), [], "no 17.4 row without an emitter for its trigger and its satisfaction");
  // SM_LOSSMIT_HANDOFF_FILE_14 on the bus: the attestation's inventory (Nov 10) arms it on the batch, due T−14 = Nov 17; the transferee's acknowledgment of the preliminary D21 (as of Nov 9) satisfies it; other kinds, or a file as of T, are refused
  const b = bus17_4("2026-11-10T15:00:00.000Z"); await inventory(b, [{ case_id: "C-60", loan_id: L, opened_on: "2026-10-01", snapshot: { case_type: "lossmit", received_at: D("2026-10-01"), completeness: "incomplete" } }]);
  const f14 = armed(b, "SM_LOSSMIT_HANDOFF_FILE_14"); assert.equal(f14.length, 1); assert.equal(f14[0]!.dueDate, "2026-11-17"); assert.equal(f14[0]!.anchorDate, "2026-12-01"); assert.deepEqual(f14[0]!.subject, BATCH);
  assert.deepEqual(preliminaryHandoffAck({ transfer_date: T, deliverable_kind: "D34", acked_on: D("2026-11-16") }), { timer: "SM_LOSSMIT_HANDOFF_FILE_14", due: "2026-11-17", deliverable_kind: "D34", on_time: true, refusal: null });
  assert.equal(preliminaryHandoffAck({ transfer_date: T, deliverable_kind: "D21", acked_on: D("2026-11-18") }).on_time, false);
  await assert.rejects(b.run("packageCase", { op: "ack", stage: "preliminary", batch_id: B, transfer_date: "2026-12-01", deliverable_kind: "D02", acked_on: "2026-11-16", as_of: "2026-11-09", ...ACK }), rangeError(/D02 is not the preliminary case inventory/));
  await assert.rejects(b.run("packageCase", { op: "ack", stage: "preliminary", batch_id: B, transfer_date: "2026-12-01", deliverable_kind: "D21", acked_on: "2026-11-16", as_of: "2026-12-01", ...ACK }), rangeError(/as of a date before T/));
  assert.equal(f14[0]!.status, "armed");
  const pre = await b.run("packageCase", { op: "ack", stage: "preliminary", batch_id: B, transfer_date: "2026-12-01", deliverable_kind: "D21", acked_on: "2026-11-16", as_of: "2026-11-09", ...ACK }) as { on_time: boolean; due: string };
  assert.equal(pre.on_time, true); assert.equal(pre.due, "2026-11-17");
  const ackEv = b.events().find((e) => e.type === "case.handoff.acked")!; assert.deepEqual(ackEv.aggregate, BATCH); assert.equal(ackEv.payload.deliverable_kind, "D21"); assert.equal(ackEv.payload.stage, "preliminary"); assert.equal(eventMatches(reg.get("SM_LOSSMIT_HANDOFF_FILE_14")!.satisfiedPattern!, ackEv), true); assert.equal(f14[0]!.status, "satisfied");
  assert.equal(eventMatches(reg.get("SM_LOSSMIT_HANDOFF_FILE_1")!.satisfiedPattern!, ackEv), false, "the preliminary ack is not the final one");
  // FNMA_F1_27 keys on cashiering's trial application; SM_PAYOFF_REQUEST_OPEN_7BD on 16.1's payoff.statement.sent (the 7.6 row's event)
  const ev = (type: string, payload: Record<string, unknown>): DomainEvent => ({ id: `e-${type}`, sequence: 1, type, loanId: L, actor: AGENT, occurredAt: "2026-11-25T15:00:00.000Z", payload });
  assert.equal(eventMatches(reg.get("FNMA_F1_27_TRIAL_PAYMENT_EOM")!.satisfiedPattern!, ev("payment.applied", { payment_id: "trial:C:2026-11-25", source: "trial_held_funds" })), true);
  assert.equal(eventMatches(reg.get("FNMA_F1_27_TRIAL_PAYMENT_EOM")!.satisfiedPattern!, ev("payment.applied", { payment_id: "p-1", source: "lockbox" })), false);
  assert.equal(eventMatches(reg.get("SM_PAYOFF_REQUEST_OPEN_7BD")!.satisfiedPattern!, ev("payoff.statement.sent", { template: "NTC_REGZ_36C3_PAYOFF_STMT", statement_id: "s-1", recipients: [] })), true);
  assert.equal(reg.get("SM_LOSSMIT_HOLD_INSTRUCTIONS_T1")!.offsetParsed.kind, "step"); assert.equal(reg.get("SM_LOSSMIT_HOLD_INSTRUCTIONS_T1")!.triggerPattern!.type, "case.handoff.inventoried");
  // the payoff request received before T: a statement before T satisfies the 7-BD row; a request forwarded within 1 BD with the receipt date exports the clock to the transferee and closes Supermortgage's instance
  const p = payoffRequestHandoff({ received_on: D("2026-11-27"), transfer_date: T, statement_sent_on: D("2026-11-30") }); assert.equal(p.due, "2026-12-08"); assert.equal(p.outcome, "statement_sent"); assert.equal(p.satisfied_by, "payoff.statement.sent"); assert.equal(p.on_time, true);
  const f = payoffRequestHandoff({ received_on: D("2026-11-27"), transfer_date: T, forwarded_on: D("2026-11-30"), requester_told_on: D("2026-11-30") }); assert.equal(f.forward_by, "2026-11-30"); assert.equal(f.outcome, "forwarded_to_transferee"); assert.equal(f.exported_to_transferee, true); assert.equal(f.owner_after_transfer, "transferee"); assert.equal(f.on_time, true);
  assert.equal(payoffRequestHandoff({ received_on: D("2026-11-27"), transfer_date: T, forwarded_on: D("2026-11-30") }).breach!.reason.includes("without telling the requester"), true);
  assert.match(payoffRequestHandoff({ received_on: D("2026-11-27"), transfer_date: T, statement_sent_on: D("2026-12-01") }).refusal!, /nothing issues on or after 2026-12-01/);
  // on the bus: the open payoff request (opened Nov 27, before T) of a listed loan is inventoried and arms the row on its receipt date (7 servicer BD → Dec 8); the forwarding closes it with reason forwarded_to_transferee (not transfer_out — the gate allows it)
  const pb = bus17_4("2026-11-30T15:00:00.000Z"); await inventory(pb, [{ case_id: "C-50", loan_id: L, opened_on: "2026-11-27", snapshot: { case_type: "payoff" } }]);
  const inst = armed(pb, "SM_PAYOFF_REQUEST_OPEN_7BD"); assert.equal(inst.length, 1); assert.equal(inst[0]!.dueDate, "2026-12-08"); assert.equal(inst[0]!.anchorDate, "2026-11-27");
  await pb.run("completePreTransferAction", { case_id: "C-50", loan_id: L, action: "payoff_request", transfer_date: "2026-12-01", received_on: "2026-11-27", forwarded_on: "2026-11-30", requester_told_on: "2026-11-30" });
  assert.equal(inst[0]!.status, "cancelled"); assert.equal(inst[0]!.cancelledReason, "forwarded_to_transferee"); assert.equal(pb.events().find((e) => e.type === "payoff.request.forwarded")!.payload.receipt_date, "2026-11-27");
  // work-down window [T, T+10 federal BD] = [Dec 1, Dec 15]: an ack due Dec 3 left for the transferee must be documented in TO-03
  const w = workdownWindow({ transfer_date: T, actions: [{ code: "REGX_1024_41B2_ACK_5", due: D("2026-12-03") }, { code: "REGX_1024_41C1_EVAL_30", due: D("2026-12-10"), documented_check: "TO-04" }, { code: "REGX_1024_41H_APPEAL_DETERMINATION_30", due: D("2026-12-20") }] });
  assert.equal(w.due, "2026-11-30"); assert.equal(w.window_end, "2026-12-15"); assert.deepEqual(w.in_window, ["REGX_1024_41B2_ACK_5", "REGX_1024_41C1_EVAL_30"]); assert.deepEqual(w.undocumented, ["REGX_1024_41B2_ACK_5"]); assert.equal(w.escalation!.severity, "sev2");
  // the batch work-down row waits while a loss-mit case of the batch is packaged with an undocumented action (the Nov 25 application: its ack is documented by TO-03, its determination is not due — documented); an undetermined complete application whose (c)(1) clock ran out before T is a breach, not a documented hand-off
  const wb = bus17_4("2026-11-29T15:00:00.000Z"); const overdue: CaseSnapshot = { case_type: "lossmit", received_at: D("2026-10-01"), completeness: "complete", complete_at: D("2026-10-05"), ack_sent_at: D("2026-10-02"), ack_document_id: "doc", recovery_analysis_document_id: "ra", ei_history_document_id: "ei", rule_set_version: "v" };
  await inventory(wb, [{ case_id: "C-70", loan_id: L, opened_on: "2026-10-01", snapshot: overdue }]);
  assert.equal(check(handoffChecks(overdue, T), "TO-04").result, "fail"); const res = await wb.run("packageCase", { case_id: "C-70", loan_id: L, transfer_date: "2026-12-01", snapshot: overdue }) as { status: string; deficiencies: string[] };
  assert.equal(res.status, "deficient"); assert.deepEqual(res.deficiencies, ["TO-04"]); assert.equal(armed(wb, "SM_LOSSMIT_PRE_T_WORKDOWN_T1")[0]!.status, "armed");
  const wdBreach = wb.timers.evaluate("2026-12-01T05:00:00.000Z").find((x) => x.def.code === "SM_LOSSMIT_PRE_T_WORKDOWN_T1")!; assert.ok(wdBreach, "T−1 BD passes with the work-down undocumented → breach"); assert.equal(wdBreach.severity, 2);
  // SMDU: status through T−1 and, on a servicer-number change, the request package → human_portal_task for the fnma_portal_operator
  const s = smduHandoff({ smdu_case_id: "SMDU-1", status_reported_through: D("2026-11-30"), transfer_date: T, servicer_number_change: true }); assert.equal(s.ok, false); assert.equal(s.portal_task!.owner_role, "fnma_portal_operator"); assert.equal(s.due, "2026-12-01");
  assert.equal(smduHandoff({ smdu_case_id: "SMDU-1", status_reported_through: D("2026-11-30"), transfer_date: T, servicer_number_change: false }).ok, true);
  assert.equal(smduHandoff({ smdu_case_id: "SMDU-1", status_reported_through: D("2026-11-27"), transfer_date: T, servicer_number_change: false }).ok, false);
});
