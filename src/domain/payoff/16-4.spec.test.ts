// 16.4 MERS deactivation
// spec/sections/16-payoff-lien-release/16-4-mers-deactivation.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { deactivationEligibility, minIntegrity, prepareDeactivation, batchSchedule, mersReject, mersAck, mersResubmission, classifyReject, verificationSnapshot, reactivationSnapshot, mreReconcile, enoteOverlay, eregistryTransaction, enotePaperCopy, deactivationReversal, batchOutage, releaseRecordedGate, mersTxnKey, type MinRecordFields } from "./ops-16-4.ts";
import { deactivationClocks, reversalDue } from "./release.ts";
import { EVALUATORS_16_4 } from "./evaluators-16-4.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import { TOOLS_16_4, opOf } from "../../app/tools/section16-4.ts";
import { CommandBus, CommandRefused, type CommandContext } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeLockbox, FakeOdfi, FakeCustodialBank } from "../../infra/integrations/banking.ts";
import { FakeMers } from "../../infra/integrations/mers.ts";
import { FakeFnmaLsdu, FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakeCustodian } from "../../infra/integrations/custody.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { buildRegistry } from "../../notices/catalog.ts";
import { publishCheck } from "../../notices/checklist.ts";
import { NoticeService } from "../../notices/service.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";

const MIN = "1000123-0000456789-0"; const ORG = "1000123";
const FIELDS: MinRecordFields = { borrower_names: ["Jordan A. Rivera", "Casey Rivera"], property_address: "412 Maple St, Columbus, OH 43215", note_date: D("2019-06-14"), original_amount_cents: 26_500_000n };
const INTEGRITY_OK = () => minIntegrity({ min: MIN, platform: FIELDS, mers: FIELDS, our_org_id: ORG, min_subservicer_org_id: ORG });
const AGENT: Actor = { kind: "agent", id: "payoff-release" };
const OPS_ANALYST: Actor = { kind: "human", id: "ops-1", role: "ops_analyst" };
const NOCTX = undefined as unknown as CommandContext;   // `never` guardrails read the input only
const tool = (name: string) => TOOLS_16_4.find((t) => t.name === name)!;
const guard = (name: string, code: string) => tool(name).guardrails!.find((g) => g.code === code)!;
const FRANKLIN = { county: "Franklin", status: "recorded" as const, recorded_on: "2026-10-26", release_task_id: "rt-oh-1", recording_reference: "Instrument No. 202610260041" };
const OH = { loan_id: "L-OH", min: MIN, loan_status: "paid_in_full", min_status: "active", release_tasks: [FRANKLIN], our_org_id: ORG, platform: FIELDS, mers: FIELDS, min_subservicer_org_id: ORG };
const RECIPIENTS = [{ partyId: "B1", name: "Jordan A. Rivera", mailingAddress: "412 Maple St, Columbus, OH 43215" }];
// Only the F-1-09 letter this process mails is published here (its own checklist), never the whole authored catalog — another section's draft can not fail this T-id.
const noticeReg = buildRegistry(); noticeReg.publish("NTC_ENOTE_PAPER_COPY", noticeReg.versionsOf("NTC_ENOTE_PAPER_COPY")[0]!.version, "counsel", "2026-09-01T00:00:00.000Z", publishCheck);
const LETTER = () => ({ ...noticeReg.activeVersion("NTC_ENOTE_PAPER_COPY", D("2026-10-30"))!.samplePayload, notice_date: "2026-10-30", eregistry_updated_date: "2026-10-20", property_address: "412 Maple St, Columbus, OH 43215", state_name: "Ohio", release_recording_reference: "Instrument No. 202610260041" });

function uow(loanId: string, at: string, processes: readonly string[]): UowContext & { decisions: DecisionInput[]; clock: FixedClock } {
  const clock = new FixedClock(at); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes }), clock, decide: (d) => { decisions.push({ loanId, ...d }); }, decisions };
}
/** The 16.4 tools on the bus over the overridden registry's engine (process 16.4 only, plus 1.5's MRE row where a test asks for it). */
function harness(loanId = "L-OH", nowIso = "2026-10-20T14:00:00.000Z", processes: readonly string[] = ["16.4"]) {
  const ctx = uow(loanId, nowIso, processes);
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, notices: new NoticeService({ registry: noticeReg, events: ctx.events, clock: ctx.clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() }),
    ports: { lockbox: new FakeLockbox(), nacha: new FakeOdfi(), custodialBank: new FakeCustodialBank(), mers: new FakeMers(), lsdu: new FakeFnmaLsdu(), smdu: new FakeFnmaSmdu(), custodian: new FakeCustodian(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery() } };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const escalates = loadAgentsFile().processes.find((p) => p.process === "16.4")!.escalates_to;
  const cmds = new Map(TOOLS_16_4.map((t) => [t.name, toolCommand(t, rt, escalates)] as const)); for (const c of cmds.values()) agents.registerTool("payoff-release", c.name);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output as Record<string, unknown>;
  const deact = (input: Record<string, unknown>, actor?: Actor) => run("checkDeactivationEligibility", input, actor);
  const at = (iso: string) => ctx.clock.set(iso);
  const events = (type: string): DomainEvent[] => ctx.events.all().filter((e) => e.type === type);
  const payload = (type: string, n = -1): Record<string, unknown> => events(type).at(n)!.payload as Record<string, unknown>;
  const timers = (code: string) => ctx.timers.byCode(code);
  /** An upstream event exactly as its emitter appends it (16.3 submitRecording op=recorded, 16.2 postPayoff). */
  const emit = (type: string, p: Record<string, unknown>, actor: Actor = SYSTEM) => ctx.events.append({ type, loanId, actor, payload: p });
  return { ctx, rt, bus, run, deact, at, events, payload, timers, emit };
}

test("16.4-T1: Given the Ohio release recorded 10/26/2026, then the deactivation is submitted in the 10/26 batch, `MERS_PROC_PAID_IN_FULL_DEACTIVATE_60.due_at` = 12/25/2026, the ack is accepted 10/27 and the snapshot shows inactive/Paid in Full by 10/29.", async () => {
  const recorded_on = D("2026-10-26");
  const e = deactivationEligibility({ min: MIN, loan_id: "L-OH", loan_status: "paid_in_full", min_status: "active", release_tasks: [{ county: "Franklin", status: "recorded", recorded_on, release_task_id: "rt-oh-1", recording_reference: "Instrument No. 202610260041" }], attempted_on: recorded_on, actor: "payoff-release" });
  assert.equal(e.eligible, true); assert.equal(e.state, "eligible"); assert.deepEqual(e.gate, { code: "SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE", ok: true }); assert.equal(e.last_recorded_on, "2026-10-26"); assert.equal(e.warning, null); assert.equal(e.warning_event, null);
  assert.equal(e.clocks!.due_on, "2026-12-25");   // MERS_PROC_PAID_IN_FULL_DEACTIVATE_60.due_at = recorded_at + 60 calendar days
  assert.equal(e.clocks!.policy_target, "2026-11-02"); assert.equal(e.clocks!.escalate_on, "2026-12-20");
  assert.deepEqual(e.eligible_event, { type: "mers.deactivation.eligible", min: MIN, loan_id: "L-OH", last_recorded_at: "2026-10-26", first_recorded_at: "2026-10-26", source: "recorded", release_task_ids: ["rt-oh-1"], due_on: "2026-12-25", policy_target: "2026-11-02", counties: 1 });
  const p = prepareDeactivation({ loan_id: "L-OH", eligibility: e, integrity: INTEGRITY_OK() });
  assert.equal(p.prepared, true); assert.equal(p.next_state, "prepared");
  assert.deepEqual(p.transaction, { txn_type: "deactivation_paid_in_full", min: MIN, loan_id: "L-OH", reason_code: "Paid in Full", effective_date: "2026-10-26", submitting_org_id: ORG, release_task_ids: ["rt-oh-1"], release_recorded_at: "2026-10-26", recording_reference: "Instrument No. 202610260041", source: "recorded", status: "prepared" });
  assert.deepEqual(p.requested_event, { type: "mers.deactivation.requested", min: MIN, loan_id: "L-OH", release_task_ids: ["rt-oh-1"], last_recorded_at: "2026-10-26" });
  // submitted in the 10/26 batch: the recorded image arrived 14:05, before the 18:00 cutoff → T+0; ack ingested the next morning
  const b = batchSchedule({ eligible_on: recorded_on, due_on: e.clocks!.due_on, evidence_time_local: "14:05" });
  assert.equal(b.batch_on, "2026-10-26"); assert.equal(b.window, "T+0"); assert.equal(b.same_day_required, false); assert.equal(b.ack_ingested_on, "2026-10-27");
  // the ack is accepted 10/27 → mers.txn.accepted{txn_type=deactivation_paid_in_full} satisfies the 60-day and 5-BD rows, inside both, and arms the 3-BD verification
  const ack = mersAck({ min: MIN, txn_type: "deactivation_paid_in_full", submitted_on: b.batch_on, ack_ingested_on: b.ack_ingested_on, ack: { status: "accepted" }, our_org_id: ORG, min_subservicer_org_id: ORG, due_on: e.clocks!.due_on, policy_target: e.clocks!.policy_target, effective_date: recorded_on, batch_id: "MERS-B1026" });
  assert.equal(ack.state, "accepted"); assert.equal(ack.accepted_on, "2026-10-27"); assert.deepEqual(ack.event, { type: "mers.txn.accepted", txn_type: "deactivation_paid_in_full", min: MIN, accepted_at: "2026-10-27", acked_at: "2026-10-27", effective_date: "2026-10-26", batch_id: "MERS-B1026", enote: false, paper_note_return_required: false, all_mins: false });
  assert.deepEqual(ack.satisfies, ["MERS_PROC_PAID_IN_FULL_DEACTIVATE_60", "SM_MERS_DEACTIVATE_TARGET_5BD"]); assert.deepEqual(ack.arms, ["SM_MERS_DEACTIVATION_VERIFY_3BD"]); assert.deepEqual(ack.on_time, { deadline: true, policy_target: true }); assert.equal(ack.reject, null);
  // the snapshot 10/28 shows inactive / Paid in Full — by 10/29
  const v = verificationSnapshot({ min: MIN, accepted_on: ack.accepted_on!, snapshot: { taken_on: D("2026-10-28"), status: "inactive", reason: "Paid in Full" } });
  assert.equal(v.verified, true); assert.equal(v.state, "verified"); assert.equal(v.satisfied_on, "2026-10-28"); assert.ok(v.satisfied_on! <= "2026-10-29"); assert.deepEqual(v.event, { type: "mers.snapshot.verified", min: MIN, status: "inactive", reason: "Paid in Full", taken_on: "2026-10-28", verified_at: "2026-10-28", all_mins: false }); assert.equal(v.breach, null); assert.equal(v.escalation, null);
  assert.equal(deactivationClocks(recorded_on).verify_by, "2026-10-29");   // T1's "by 10/29" is 3 BD from the 10/26 recording (release.ts)
  assert.equal(v.verify_by, "2026-10-30");   // spec discrepancy: the SM_MERS_DEACTIVATION_VERIFY_3BD row anchors accepted_at (10/27) + 3 BD = 10/30; the 10/28 snapshot satisfies both
  assert.equal(verificationSnapshot({ min: MIN, accepted_on: ack.accepted_on!, snapshot: { taken_on: D("2026-10-28"), status: "inactive", reason: null } }).verified, false);   // rule 4: the paid-in-full reason is required
  // ---- the same run through the bus and the timer engine (overridden registry, process 16.4)
  const h = harness("L-OH", "2026-10-26T18:05:00.000Z");
  h.emit("lien_release.recorded", { state: "OH", recorded_at: "2026-10-26", recording_reference: "Instrument No. 202610260041", release_task_id: "rt-oh-1", via: "erecord" }, AGENT);   // 16.3 submitRecording op=recorded
  assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60").length, 0, "the 60-day row arms on the eligibility transition, not on a county's recording event");
  const chk = await h.deact({ ...OH, today: "2026-10-26" }); assert.equal(chk.eligible, true); assert.equal(chk.state, "eligible");
  assert.equal(h.events("mers.deactivation.eligible").length, 1); assert.equal(h.payload("mers.deactivation.eligible").last_recorded_at, "2026-10-26");
  const t60 = h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60"); assert.equal(t60.length, 1); assert.equal(t60[0]!.status, "armed"); assert.equal(t60[0]!.anchorDate, "2026-10-26"); assert.equal(t60[0]!.dueDate, "2026-12-25");   // MERS_PROC_PAID_IN_FULL_DEACTIVATE_60.due_at = 12/25/2026
  const t5 = h.timers("SM_MERS_DEACTIVATE_TARGET_5BD"); assert.equal(t5.length, 1); assert.equal(t5[0]!.dueDate, "2026-11-02");
  await h.deact({ ...OH, today: "2026-10-26" }); assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60").length, 1, "re-running the check never re-arms the row (idempotent on (min, txn_type, effective_date))");
  const prep = await h.deact({ ...OH, today: "2026-10-26", prepare_transaction: true });
  assert.equal(prep.prepared, true); assert.equal(prep.transaction_id, mersTxnKey(MIN, "deactivation_paid_in_full", D("2026-10-26"))); assert.equal((prep.row as { status: string }).status, "prepared"); assert.equal((prep.row as { due_on: string }).due_on, "2026-12-25");
  assert.equal(h.events("mers.deactivation.submit_requested").length, 1); assert.equal(h.events("mers.deactivation.requested").length, 1);
  const gate = h.timers("SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "satisfied"); assert.equal(gate[0]!.note, "evaluator:16.4.allCountiesRecorded");
  const sched = await h.deact({ loan_id: "L-OH", min: MIN, op: "schedule", eligible_on: "2026-10-26", evidence_time_local: "14:05" });
  assert.equal(sched.batch_on, "2026-10-26"); assert.equal(sched.window, "T+0"); assert.equal(sched.ack_ingested_on, "2026-10-27"); assert.equal(sched.due_on, "2026-12-25");
  assert.equal(h.rt.store.get("mers_transactions", prep.transaction_id as string)!.data.batch_on, "2026-10-26");
  h.at("2026-10-27T10:30:00.000Z");
  const acked = await h.deact({ loan_id: "L-OH", min: MIN, op: "ingestMersAck", ack: { status: "accepted" }, ack_ingested_on: "2026-10-27", our_org_id: ORG, batch_id: "MERS-B1026" });
  assert.equal(acked.state, "accepted"); assert.deepEqual(acked.on_time, { deadline: true, policy_target: true }); assert.equal(acked.verify_by, "2026-10-30");
  assert.equal(h.payload("mers.txn.accepted").txn_type, "deactivation_paid_in_full"); assert.equal(h.payload("mers.txn.accepted").accepted_at, "2026-10-27");
  assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.status, "satisfied"); assert.equal(h.timers("SM_MERS_DEACTIVATE_TARGET_5BD")[0]!.status, "satisfied");
  const verify = h.timers("SM_MERS_DEACTIVATION_VERIFY_3BD"); assert.equal(verify.length, 1); assert.equal(verify[0]!.status, "armed"); assert.equal(verify[0]!.anchorDate, "2026-10-27"); assert.equal(verify[0]!.dueDate, "2026-10-30");
  assert.equal(h.timers("SM_ENOTE_PAPER_COPY_10BD").length, 0, "no paper-copy row on a paper note");
  assert.equal(h.rt.store.get("mers_transactions", prep.transaction_id as string)!.data.status, "accepted");
  h.at("2026-10-28T12:00:00.000Z");
  const snap = await h.deact({ loan_id: "L-OH", min: MIN, op: "snapshotMins", snapshot: { taken_on: "2026-10-28", status: "inactive", reason: "Paid in Full" } });
  assert.equal(snap.verified, true); assert.equal(snap.satisfied_on, "2026-10-28"); assert.equal(snap.escalation_id, null);
  assert.equal(h.timers("SM_MERS_DEACTIVATION_VERIFY_3BD")[0]!.status, "satisfied"); assert.equal(h.payload("mers.snapshot.verified").status, "inactive");
  assert.deepEqual({ ...h.rt.store.get("mers_min_snapshots", `${MIN}:2026-10-28`)!.data }, { min: MIN, taken_on: "2026-10-28", status: "inactive", reason: "Paid in Full", verified: true, loan_id: "L-OH", verified_transaction_id: prep.transaction_id });
  assert.equal(h.rt.store.get("mers_transactions", prep.transaction_id as string)!.data.status, "confirmed");
  assert.deepEqual(h.ctx.timers.evaluate("2026-12-26T00:00:00.000Z"), [], "nothing breaches: every 16.4 instance was satisfied");
  assert.ok(h.ctx.decisions.every((d) => d.action.startsWith("checkDeactivationEligibility:")), "every act records its decision row");
});
test("16.4-T2: Given a deactivation command before `lien_release.recorded`, then the gate blocks it and logs the attempt.", async () => {
  const submitted = [{ county: "Franklin", status: "submitted" as const, release_task_id: "rt-oh-1" }];
  const cmd = deactivationEligibility({ min: MIN, loan_id: "L-OH", loan_status: "paid_in_full", min_status: "active", release_tasks: submitted, attempted_on: D("2026-10-20"), actor: "payoff-release" });
  assert.equal(cmd.eligible, false); assert.equal(cmd.state, "awaiting_release"); assert.deepEqual(cmd.gate, { code: "SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE", ok: false }); assert.deepEqual(cmd.blocked_counties, ["Franklin"]); assert.equal(cmd.clocks, null); assert.equal(cmd.eligible_event, null);
  assert.match(cmd.refusal!, /release not recorded in Franklin/);
  assert.deepEqual(cmd.attempt_log, { type: "mers.deactivation.refused", min: MIN, loan_id: "L-OH", attempted_on: "2026-10-20", actor: "payoff-release", gate: "SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE", reason: cmd.refusal });
  assert.equal(prepareDeactivation({ loan_id: "L-OH", eligibility: cmd, integrity: INTEGRITY_OK() }).prepared, false);
  // the registry gate (SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE → 16.4.allCountiesRecorded) closes on the same facts, on no evidence at all, and on an unverified third-party recording
  const gate = EVALUATORS_16_4["16.4.allCountiesRecorded"]!;
  assert.equal(gate({ release_tasks: submitted }).open, false); assert.match(gate({ release_tasks: submitted }).reason!, /not recorded in Franklin/);
  assert.equal(gate({}).open, false); assert.match(gate({}).reason!, /no recording evidence/);
  assert.equal(evaluateGate("16.4.allCountiesRecorded", {}).open, false);   // the aggregate map carries this (strict) evaluator
  assert.equal(evaluateGate("16.4.allCountiesRecorded", { release_tasks: [] }).open, false);
  assert.equal(gate({ release_tasks: [{ county: "Harris", status: "third_party_recorded" }] }).open, false); assert.match(gate({ release_tasks: [{ county: "Harris", status: "third_party_recorded" }] }).reason!, /verified against the land records/);
  assert.equal(gate({ release_tasks: [{ county: "Harris", status: "third_party_recorded", third_party_verified: true }] }).open, true);
  assert.equal(gate({ release_tasks: [{ county: "Franklin", status: "recorded", recorded_on: "2026-10-26" }] }).open, true);
  assert.equal(gate({ chargeoff_release_recorded_on: "2026-10-26" }).open, true);
  assert.equal(releaseRecordedGate({ release_tasks: [] }).open, false);
  assert.match(guard("checkDeactivationEligibility", "LOAN_NOT_PAID_IN_FULL").refuse({ prepare_transaction: true, loan_status: "active", release_tasks: [{ county: "Franklin", status: "recorded", recorded_on: "2026-10-26" }] }, NOCTX)!, /paid-in-full or charged-off/);
  assert.equal(deactivationEligibility({ min: MIN, loan_id: "L-A", loan_status: "active", min_status: "active", release_tasks: [{ county: "Franklin", status: "recorded", recorded_on: D("2026-10-26") }], attempted_on: D("2026-10-26"), actor: "payoff-release" }).state, "not_payoff");
  // through the bus: a plain check answers eligible:false and logs `mers.deactivation.refused`; the deactivation command (prepare) is refused by the gate — the attempt (`mers.deactivation.submit_requested`) arms the registry gate instance with the evaluator closed, `mers.deactivation.refused` and `command.refused` are logged, nothing is written
  const h = harness();
  const input = { loan_id: "L-OH", min: MIN, loan_status: "paid_in_full", min_status: "active", release_tasks: submitted, today: "2026-10-20" };
  const r = await h.deact(input);
  assert.equal(r.eligible, false); assert.equal((r.gate as { ok: boolean }).ok, false);
  const logged = h.events("mers.deactivation.refused"); assert.equal(logged.length, 1); assert.equal((logged[0]!.payload as { attempted_on: string }).attempted_on, "2026-10-20"); assert.equal((logged[0]!.payload as { gate: string }).gate, "SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE");
  assert.equal(h.timers("SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE").length, 0, "a read is not a submit");
  await assert.rejects(h.deact({ ...input, prepare_transaction: true, our_org_id: ORG, platform: FIELDS, mers: FIELDS, min_subservicer_org_id: ORG }), (err: unknown) => err instanceof CommandRefused && err.code === "NO_DEACTIVATE_BEFORE_RECORDING" && /not recorded in Franklin/.test(err.message));
  assert.deepEqual(h.ctx.events.all().slice(-4).map((ev) => ev.type), ["mers.deactivation.submit_requested", "timer.armed", "mers.deactivation.refused", "command.refused"]);   // the attempt arms the gate row before the refusal
  assert.equal((h.payload("command.refused") as { code: string }).code, "NO_DEACTIVATE_BEFORE_RECORDING"); assert.deepEqual(h.payload("mers.deactivation.submit_requested").blocked_counties, ["Franklin"]); assert.equal(h.payload("mers.deactivation.submit_requested").gate_open, false);
  const inst = h.timers("SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE"); assert.equal(inst.length, 1); assert.equal(inst[0]!.status, "armed"); assert.equal(inst[0]!.note, "evaluator:16.4.allCountiesRecorded"); assert.equal(inst[0]!.dueAt, undefined);
  assert.equal(h.events("mers.deactivation.requested").length, 0); assert.equal(h.events("mers.deactivation.eligible").length, 0); assert.equal(h.rt.store.list("mers_transactions").length, 0); assert.equal(h.ctx.decisions.length, 0);
  await assert.rejects(h.deact({ ...input, prepare_transaction: true, our_org_id: ORG, platform: FIELDS, mers: FIELDS, min_subservicer_org_id: ORG, release_tasks: [] }), (err: unknown) => err instanceof CommandRefused && err.code === "NO_DEACTIVATE_BEFORE_RECORDING" && /no recording evidence/.test(err.message));
  await assert.rejects(h.deact({ ...input, prepare_transaction: true, our_org_id: ORG, platform: FIELDS, mers: FIELDS, min_subservicer_org_id: ORG, release_tasks: [{ county: "Harris", status: "third_party_recorded" }] }), (err: unknown) => err instanceof CommandRefused && err.code === "NO_DEACTIVATE_BEFORE_RECORDING" && /verified against the land records/.test(err.message));
  await assert.rejects(h.deact({ ...input, prepare_transaction: true, loan_status: "active", our_org_id: ORG, platform: FIELDS, mers: FIELDS, min_subservicer_org_id: ORG, release_tasks: [FRANKLIN] }), (err: unknown) => err instanceof CommandRefused && err.code === "LOAN_NOT_PAID_IN_FULL");
  assert.equal(h.ctx.events.all().filter((ev) => ev.type === "command.refused").length, 4);
  // once recorded the same command goes through: the eligibility transition arms the 60-day row and the prepared transaction's `mers.deactivation.requested` satisfies every open gate instance
  h.at("2026-10-26T15:00:00.000Z");
  const ok = await h.deact({ ...input, release_tasks: [FRANKLIN], today: "2026-10-26", prepare_transaction: true, our_org_id: ORG, platform: FIELDS, mers: FIELDS, min_subservicer_org_id: ORG });
  assert.equal(ok.prepared, true); assert.equal((ok.transaction as { effective_date: string }).effective_date, "2026-10-26");
  assert.equal(h.events("mers.deactivation.requested").length, 1); assert.equal(h.events("mers.deactivation.submit_requested").length, 4);   // three gate-refused attempts + the one that went through (the LOAN_NOT_PAID_IN_FULL refusal is a bus guardrail, before any handler)
  assert.deepEqual(h.timers("SM_MERS_NO_DEACTIVATE_BEFORE_RELEASE_GATE").map((t) => t.status), ["satisfied", "satisfied", "satisfied", "satisfied"]);
  assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.dueDate, "2026-12-25"); assert.equal(h.ctx.decisions.length, 1); assert.equal(h.ctx.decisions[0]!.action, "checkDeactivationEligibility:prepare");
  await h.deact({ ...input, release_tasks: [FRANKLIN], today: "2026-10-26", prepare_transaction: true, our_org_id: ORG, platform: FIELDS, mers: FIELDS, min_subservicer_org_id: ORG });
  assert.equal(h.events("mers.deactivation.requested").length, 1, "a second prepare of the same (min, txn_type, effective_date) is idempotent"); assert.equal(h.rt.store.list("mers_transactions").length, 1);
  // an integrity mismatch is not a gate refusal: the deactivation waits for the MIN update (Rule 2 §4)
  const fix = await h.deact({ ...input, min: "1000123-0000456790-8", release_tasks: [FRANKLIN], today: "2026-10-26", prepare_transaction: true, our_org_id: ORG, platform: FIELDS, mers: { ...FIELDS, borrower_names: ["Jordan A. Rivera"] }, min_subservicer_org_id: ORG });
  assert.equal(fix.prepared, false); assert.equal(fix.next_state, "integrity_fix_first"); assert.match(String(fix.refusal), /Rule 2 §4/);
});
test("16.4-T3: Given a two-county release with the second recording on 11/10, then the deactivation is submitted after 11/10 and the 60-day timer anchors on 11/10 (warning from 10/26).", async () => {
  const franklin = { county: "Franklin", status: "recorded" as const, recorded_on: D("2026-10-26"), release_task_id: "rt-1", recording_reference: "Franklin 202610260041" };
  // Franklin recorded 10/26, Delaware still at the recorder on 10/27 → blocked; the conservative clock and its warning run from 10/26
  const before = deactivationEligibility({ min: MIN, loan_id: "L-2C", loan_status: "paid_in_full", min_status: "active", release_tasks: [franklin, { county: "Delaware", status: "submitted", release_task_id: "rt-2" }], attempted_on: D("2026-10-27"), actor: "payoff-release" });
  assert.equal(before.eligible, false); assert.equal(before.state, "awaiting_release"); assert.deepEqual(before.blocked_counties, ["Delaware"]); assert.equal(before.attempt_log!.attempted_on, "2026-10-27"); assert.equal(before.clocks, null); assert.equal(before.eligible_event, null);
  assert.equal(before.first_recorded_on, "2026-10-26");
  assert.deepEqual(before.warning, { kind: "multi_county_conservative_clock", first_recorded_on: "2026-10-26", conservative_due_on: "2026-12-25", counties_recorded: 1, counties_total: 2, message: before.warning!.message }); assert.match(before.warning!.message, /warning active from 2026-10-26/);
  assert.deepEqual(before.warning_event, { type: "mers.deactivation.multi_county_warning", min: MIN, loan_id: "L-2C", first_recorded_on: "2026-10-26", conservative_due_on: "2026-12-25", counties_recorded: 1, counties_total: 2, pending_counties: ["Delaware"], message: before.warning!.message });
  assert.equal(prepareDeactivation({ loan_id: "L-2C", eligibility: before, integrity: INTEGRITY_OK() }).prepared, false);
  // the second recording on 11/10 → eligible; the 60-day timer anchors on 11/10
  const after = deactivationEligibility({ min: MIN, loan_id: "L-2C", loan_status: "paid_in_full", min_status: "active", release_tasks: [franklin, { county: "Delaware", status: "recorded", recorded_on: D("2026-11-10"), release_task_id: "rt-2", recording_reference: "Delaware 2026-0011893" }], attempted_on: D("2026-11-10"), actor: "payoff-release" });
  assert.equal(after.eligible, true); assert.equal(after.last_recorded_on, "2026-11-10"); assert.equal(after.first_recorded_on, "2026-10-26"); assert.deepEqual(after.blocked_counties, []);
  assert.equal(after.clocks!.due_on, "2027-01-09"); assert.equal(after.clocks!.due_on, deactivationClocks(D("2026-11-10")).due_on);
  assert.equal(after.clocks!.policy_target, "2026-11-18");   // 11/10 + 5 BD (11/11 Veterans Day is a servicer holiday)
  assert.equal(after.clocks!.escalate_on, "2027-01-04");
  assert.equal(after.warning!.first_recorded_on, "2026-10-26"); assert.equal(after.warning!.conservative_due_on, "2026-12-25"); assert.equal(after.warning!.counties_recorded, 2);
  assert.equal(after.eligible_event!.last_recorded_at, "2026-11-10"); assert.equal(after.eligible_event!.first_recorded_at, "2026-10-26"); assert.equal(after.eligible_event!.counties, 2); assert.equal(after.warning_event, null);
  // submitted after 11/10: the evening batch of 11/10 at the earliest (T+0), otherwise 11/11
  const b = batchSchedule({ eligible_on: D("2026-11-10"), due_on: after.clocks!.due_on, evidence_time_local: "16:40" }); assert.equal(b.batch_on, "2026-11-10"); assert.equal(b.window, "T+0"); assert.ok(b.batch_on >= "2026-11-10");
  assert.equal(batchSchedule({ eligible_on: D("2026-11-10"), due_on: after.clocks!.due_on, evidence_time_local: "19:15" }).batch_on, "2026-11-11");
  const p = prepareDeactivation({ loan_id: "L-2C", eligibility: after, integrity: INTEGRITY_OK() });
  assert.equal(p.prepared, true); assert.equal(p.transaction!.effective_date, "2026-11-10"); assert.equal(p.transaction!.release_recorded_at, "2026-11-10"); assert.deepEqual(p.transaction!.release_task_ids, ["rt-1", "rt-2"]); assert.equal(p.transaction!.recording_reference, "Delaware 2026-0011893"); assert.equal(p.requested_event!.last_recorded_at, "2026-11-10");
  // a single-county release carries no multi-county warning
  assert.equal(deactivationEligibility({ min: MIN, loan_id: "L-OH", loan_status: "paid_in_full", min_status: "active", release_tasks: [franklin], attempted_on: D("2026-10-26"), actor: "payoff-release" }).warning, null);
  // ---- the engine: Franklin's 10/26 recording arms nothing but raises the warning; Delaware's 11/10 recording makes the loan eligible and the 60-day / 5-BD rows anchor on 11/10
  const h = harness("L-2C", "2026-10-27T15:00:00.000Z");
  h.emit("lien_release.recorded", { state: "OH", recorded_at: "2026-10-26", recording_reference: "Franklin 202610260041", release_task_id: "rt-1", via: "erecord" }, AGENT);
  const pending = [franklin, { county: "Delaware", status: "submitted", release_task_id: "rt-2" }];
  const first = await h.deact({ ...OH, loan_id: "L-2C", release_tasks: pending, today: "2026-10-27" });
  assert.equal(first.eligible, false); assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60").length, 0); assert.equal(h.timers("SM_MERS_DEACTIVATE_TARGET_5BD").length, 0);
  assert.equal(h.events("mers.deactivation.multi_county_warning").length, 1); assert.deepEqual(h.payload("mers.deactivation.multi_county_warning").pending_counties, ["Delaware"]); assert.equal(h.payload("mers.deactivation.multi_county_warning").first_recorded_on, "2026-10-26"); assert.equal(h.payload("mers.deactivation.multi_county_warning").conservative_due_on, "2026-12-25");
  await h.deact({ ...OH, loan_id: "L-2C", release_tasks: pending, today: "2026-10-28" }); assert.equal(h.events("mers.deactivation.multi_county_warning").length, 1, "the warning is raised once per first recording");
  await assert.rejects(h.deact({ ...OH, loan_id: "L-2C", release_tasks: pending, today: "2026-10-28", prepare_transaction: true }), (err: unknown) => err instanceof CommandRefused && err.code === "NO_DEACTIVATE_BEFORE_RECORDING" && /Delaware/.test(err.message));
  assert.deepEqual(h.ctx.timers.evaluate("2026-11-09T23:59:59.000Z"), [], "no premature breach from the 10/26 recording");
  h.at("2026-11-10T21:00:00.000Z");
  h.emit("lien_release.recorded", { state: "OH", recorded_at: "2026-11-10", recording_reference: "Delaware 2026-0011893", release_task_id: "rt-2", via: "paper" }, AGENT);
  const both = [franklin, { county: "Delaware", status: "recorded", recorded_on: "2026-11-10", release_task_id: "rt-2", recording_reference: "Delaware 2026-0011893" }];
  const done = await h.deact({ ...OH, loan_id: "L-2C", release_tasks: both, today: "2026-11-10", prepare_transaction: true });
  assert.equal(done.prepared, true); assert.equal((done.transaction as { effective_date: string }).effective_date, "2026-11-10");
  assert.equal(h.events("mers.deactivation.eligible").length, 1); assert.equal(h.payload("mers.deactivation.eligible").last_recorded_at, "2026-11-10"); assert.equal(h.payload("mers.deactivation.eligible").first_recorded_at, "2026-10-26");
  const t60 = h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60"); assert.equal(t60.length, 1); assert.equal(t60[0]!.anchorDate, "2026-11-10"); assert.equal(t60[0]!.dueDate, "2027-01-09");   // the 60-day timer anchors on 11/10
  const t5 = h.timers("SM_MERS_DEACTIVATE_TARGET_5BD"); assert.equal(t5.length, 1); assert.equal(t5[0]!.anchorDate, "2026-11-10"); assert.equal(t5[0]!.dueDate, "2026-11-18");
  const sched = await h.deact({ loan_id: "L-2C", min: MIN, op: "schedule", eligible_on: "2026-11-10", evidence_time_local: "16:40" }); assert.equal(sched.batch_on, "2026-11-10"); assert.ok((sched.batch_on as string) >= "2026-11-10"); assert.equal(sched.due_on, "2027-01-09");
});
test("16.4-T4: Given a MERS reject (MIN not found under Supermortgage's Org ID), then the exception is opened, the Subservicer designation is checked (1.5) and the transaction is resubmitted within 1 BD.", async () => {
  const reject = { min: MIN, txn_type: "deactivation_paid_in_full" as const, rejected_on: D("2026-10-27"), reject_code: "E1042", reject_reason: "MIN not found under Org ID 1000123", our_org_id: ORG, min_subservicer_org_id: null };
  const r = mersReject(reject);
  assert.equal(r.reject_class, "min_not_found_under_org_id");
  assert.deepEqual(r.exception, { kind: "mers_reject", min: MIN, txn_type: "deactivation_paid_in_full", reject_code: "E1042", reject_reason: "MIN not found under Org ID 1000123", opened_on: "2026-10-27", status: "open", qa_note_draft: null });
  assert.equal(r.subservicer_check.checked_per, "1.5"); assert.equal(r.subservicer_check.designation_ok, false); assert.equal(r.subservicer_check.action, "request_subservicer_designation_then_resubmit");
  assert.equal(r.resubmit_by, "2026-10-28"); assert.equal(r.next_state, "prepared"); assert.equal(r.llm_scope, "classify_reject_and_draft_qa_note_only");
  assert.deepEqual(r.event, { type: "mers.txn.rejected", txn_type: "deactivation_paid_in_full", min: MIN, reject_code: "E1042", reject_reason: "MIN not found under Org ID 1000123", reject_class: "min_not_found_under_org_id", rejected_at: "2026-10-27", resubmit_by: "2026-10-28", action: "request_subservicer_designation_then_resubmit" });
  const named = mersReject({ ...reject, min_subservicer_org_id: ORG }); assert.equal(named.subservicer_check.designation_ok, true); assert.equal(named.subservicer_check.action, "resubmit_as_is"); assert.equal(named.resubmit_by, "2026-10-28");
  assert.equal(mersReject({ ...reject, rejected_on: D("2026-10-30") }).resubmit_by, "2026-11-02"); // Friday reject → Monday (1 BD)
  // the LLM's drafts sit beside the platform's classification, never in place of it
  const drafted = mersReject({ ...reject, llm: { reject_class: "data_mismatch", qa_note: "MERS shows a different Org ID on the MIN" } }); assert.equal(drafted.reject_class, "min_not_found_under_org_id"); assert.deepEqual(drafted.llm_drafts, { reject_class: "data_mismatch", agrees: false, qa_note: "MERS shows a different Org ID on the MIN" }); assert.equal(drafted.exception.qa_note_draft, "MERS shows a different Org ID on the MIN");
  // a data mismatch that mentions the Org ID is a mismatch (corrected first, Rule 2 §4), not a designation problem
  assert.equal(classifyReject("E2201", "Borrower name does not match record for Org ID 1000123"), "data_mismatch"); assert.equal(mersReject({ ...reject, reject_reason: "Borrower name does not match record for Org ID 1000123", min_subservicer_org_id: ORG }).subservicer_check.action, "correct_via_min_update_first");
  assert.equal(classifyReject("E1042", "MIN not found under Org ID 1000123"), "min_not_found_under_org_id"); assert.equal(classifyReject("E3001", "Org ID 1000123 not authorized for MIN"), "min_not_found_under_org_id"); assert.equal(classifyReject("E0900", "MIN already deactivated"), "min_already_inactive"); assert.equal(classifyReject("E0001", "record layout error"), "format");
  // the same reject arriving through the ack file
  const ack = mersAck({ min: MIN, txn_type: "deactivation_paid_in_full", submitted_on: D("2026-10-26"), ack_ingested_on: D("2026-10-27"), ack: { status: "rejected", reject_code: "E1042", reject_reason: "MIN not found under Org ID 1000123" }, our_org_id: ORG, min_subservicer_org_id: null });
  assert.equal(ack.state, "rejected"); assert.equal(ack.event, null); assert.deepEqual(ack.satisfies, []); assert.equal(ack.reject!.reject_class, "min_not_found_under_org_id"); assert.equal(ack.reject!.resubmit_by, "2026-10-28"); assert.equal(ack.next_state, "prepared");
  const integ = minIntegrity({ min: MIN, platform: FIELDS, mers: FIELDS, our_org_id: ORG, min_subservicer_org_id: "1000999" }); assert.equal(integ.subservicer_named, false); assert.equal(integ.action, "request_subservicer_designation"); assert.equal(integ.transaction, null);
  const ok = INTEGRITY_OK(); assert.equal(ok.ok, true); assert.deepEqual(ok.transaction, { min: MIN, reason: "Paid in Full", submitting_org_id: ORG });
  const mm = minIntegrity({ min: MIN, platform: FIELDS, mers: { ...FIELDS, borrower_names: ["Jordan A. Rivera"] }, our_org_id: ORG, min_subservicer_org_id: ORG }); assert.equal(mm.action, "correct_via_min_update_first"); assert.equal(mm.mismatches[0]!.field, "borrower_names"); assert.match(mm.citation, /Rule 2 §4/);
  // resubmission within 1 BD: as-is once the designation is in place; a mismatch waits for the MIN update
  const rs = mersResubmission({ min: MIN, txn_type: "deactivation_paid_in_full", reject_action: "request_subservicer_designation_then_resubmit", resubmit_by: D("2026-10-28"), resubmitted_on: D("2026-10-28"), attempt: 0, min_subservicer_org_id: ORG, our_org_id: ORG });
  assert.equal(rs.allowed, true); assert.equal(rs.on_time, true); assert.equal(rs.attempt, 1); assert.deepEqual(rs.event, { type: "mers.txn.resubmitted", txn_type: "deactivation_paid_in_full", min: MIN, attempt: 1, resubmitted_at: "2026-10-28", resubmit_by: "2026-10-28", on_time: true });
  assert.equal(mersResubmission({ ...rs, min: MIN, txn_type: "deactivation_paid_in_full", reject_action: "request_subservicer_designation_then_resubmit", resubmit_by: D("2026-10-28"), resubmitted_on: D("2026-10-28"), attempt: 0, min_subservicer_org_id: null, our_org_id: ORG }).refusal!.code, "SUBSERVICER_NOT_NAMED");
  assert.equal(mersResubmission({ min: MIN, txn_type: "deactivation_paid_in_full", reject_action: "correct_via_min_update_first", resubmit_by: D("2026-10-28"), resubmitted_on: D("2026-10-28"), attempt: 0, min_subservicer_org_id: ORG, our_org_id: ORG }).refusal!.code, "MIN_UPDATE_FIRST");
  assert.equal(mersResubmission({ min: MIN, txn_type: "deactivation_paid_in_full", reject_action: "correct_via_min_update_first", resubmit_by: D("2026-10-28"), resubmitted_on: D("2026-10-29"), attempt: 0, min_update_accepted_on: D("2026-10-28"), min_subservicer_org_id: ORG, our_org_id: ORG }).on_time, false);
  // ---- through the bus: the reject opens the exception, checks the designation, and the resubmission rides the next day's batch
  const h = harness("L-OH", "2026-10-26T15:00:00.000Z");
  const prep = await h.deact({ ...OH, today: "2026-10-26", prepare_transaction: true });   // the platform's record names Supermortgage as Subservicer …
  assert.equal(prep.prepared, true);
  h.at("2026-10-27T06:30:00.000Z");   // … MERS' does not: the reject arrives and the 1.5 designation check (MERS Link) finds no Subservicer on the MIN
  const rj = await h.deact({ loan_id: "L-OH", min: MIN, op: "ingestMersAck", ack: { status: "rejected", reject_code: "E1042", reject_reason: "MIN not found under Org ID 1000123" }, ack_ingested_on: "2026-10-27", our_org_id: ORG, min_subservicer_org_id: null, llm_reject_class: "min_not_found_under_org_id", llm_qa_note: "Reject E1042: designation check per 1.5 before resubmission" });
  assert.equal(rj.state, "rejected"); assert.equal((rj.reject as { reject_class: string }).reject_class, "min_not_found_under_org_id"); assert.equal((rj.reject as { llm_drafts: { agrees: boolean } }).llm_drafts.agrees, true);
  const exc = h.rt.store.get("mers_exceptions", rj.exception_id as string)!.data; assert.equal(exc.kind, "mers_reject"); assert.equal(exc.status, "open"); assert.equal(exc.reject_code, "E1042"); assert.equal(exc.action, "request_subservicer_designation_then_resubmit"); assert.equal((exc.subservicer_check as { checked_per: string }).checked_per, "1.5"); assert.equal(exc.resubmit_by, "2026-10-28"); assert.equal(exc.qa_note_draft, "Reject E1042: designation check per 1.5 before resubmission");
  const row = h.rt.store.get("mers_transactions", prep.transaction_id as string)!.data; assert.equal(row.status, "rejected"); assert.equal(row.mers_reject_code, "E1042"); assert.equal(row.resubmit_by, "2026-10-28");
  assert.equal(h.payload("mers.txn.rejected").reject_class, "min_not_found_under_org_id"); assert.equal(h.events("mers.txn.accepted").length, 0); assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.status, "armed", "a reject satisfies nothing");
  await assert.rejects(h.deact({ loan_id: "L-OH", min: MIN, op: "resubmit", today: "2026-10-28", our_org_id: ORG }), (err: unknown) => err instanceof CommandRefused && err.code === "SUBSERVICER_NOT_NAMED");
  // the LLM only classifies rejects and drafts QA notes: a hand-keyed transaction on the resubmission is refused for the agent, allowed for the ops console (AI-off path)
  await assert.rejects(h.deact({ loan_id: "L-OH", min: MIN, op: "resubmit", today: "2026-10-28", our_org_id: ORG, min_subservicer_org_id: ORG, transaction: { min: MIN, reason: "Paid in Full" } }), (err: unknown) => err instanceof CommandRefused && err.code === "LLM_CLASSIFIES_ONLY");
  assert.equal(guard("checkDeactivationEligibility", "LLM_CLASSIFIES_ONLY").refuse({ op: "resubmit", transaction: {} }, { actor: AGENT } as CommandContext) !== undefined, true); assert.equal(guard("checkDeactivationEligibility", "LLM_CLASSIFIES_ONLY").refuse({ op: "resubmit", transaction: {} }, { actor: OPS_ANALYST } as CommandContext), undefined); assert.equal(guard("checkDeactivationEligibility", "LLM_CLASSIFIES_ONLY").refuse({ op: "resubmit", llm_reject_class: "format", llm_qa_note: "x" }, { actor: AGENT } as CommandContext), undefined);
  h.at("2026-10-28T09:00:00.000Z");
  const rs2 = await h.deact({ loan_id: "L-OH", min: MIN, op: "resubmit", today: "2026-10-28", our_org_id: ORG, min_subservicer_org_id: ORG });   // the designation confirmed on the MIN (1.5) → resubmitted within 1 BD
  assert.equal(rs2.allowed, true); assert.equal(rs2.on_time, true); assert.equal(rs2.attempt, 1); assert.equal(h.payload("mers.txn.resubmitted").on_time, true);
  assert.equal(h.rt.store.get("mers_transactions", prep.transaction_id as string)!.data.status, "prepared"); assert.equal(h.rt.store.get("mers_exceptions", rj.exception_id as string)!.data.status, "resubmitted");
  h.at("2026-10-29T06:30:00.000Z");
  const acc = await h.deact({ loan_id: "L-OH", min: MIN, op: "ingestMersAck", ack: { status: "accepted" }, ack_ingested_on: "2026-10-29", our_org_id: ORG }); assert.equal(acc.state, "accepted"); assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.status, "satisfied");
  // a data-mismatch reject: the MIN update comes first (Rule 2 §4), then the resubmission
  const h2 = harness("L-MM", "2026-10-26T15:00:00.000Z"); const p2 = await h2.deact({ ...OH, loan_id: "L-MM", today: "2026-10-26", prepare_transaction: true });
  h2.at("2026-10-27T06:30:00.000Z"); const mm2 = await h2.deact({ loan_id: "L-MM", min: MIN, op: "ingestMersAck", ack: { status: "rejected", reject_code: "E2201", reject_reason: "Borrower name does not match record for Org ID 1000123" }, ack_ingested_on: "2026-10-27", our_org_id: ORG });
  assert.equal((mm2.reject as { reject_class: string }).reject_class, "data_mismatch"); assert.equal((mm2.reject as { subservicer_check: { action: string } }).subservicer_check.action, "correct_via_min_update_first");
  await assert.rejects(h2.deact({ loan_id: "L-MM", min: MIN, op: "resubmit", today: "2026-10-28", our_org_id: ORG }), (err: unknown) => err instanceof CommandRefused && err.code === "MIN_UPDATE_FIRST" && /Rule 2 §4/.test(err.message));
  const rs3 = await h2.deact({ loan_id: "L-MM", min: MIN, op: "resubmit", today: "2026-10-28", our_org_id: ORG, min_update_accepted_on: "2026-10-28" }); assert.equal(rs3.allowed, true); assert.equal(h2.rt.store.get("mers_transactions", p2.transaction_id as string)!.data.min_update_accepted_on, "2026-10-28");
});
test("16.4-T5: Given an eNote payoff 10/16, then the eRegistry Paid Off status is requested by 10/20 and, after recording on 10/26, the registration is deactivated and (paper-return state) the marked copy and letter are mailed by 11/09.", async () => {
  const en = enoteOverlay({ payoff_on: D("2026-10-16"), release_recorded_on: D("2026-10-26"), deactivation_accepted_on: D("2026-10-27"), paper_note_return_required: true, controller: "fnma" });
  assert.deepEqual(en.status_request, { txn_type: "change_status_paid_off", requested_via: "evault_api", due_by: "2026-10-20", event: "enote.status.paid_off" });   // payoff Fri 10/16 + 2 BD = Tue 10/20
  assert.deepEqual(en.registration_deactivation, { txn_type: "registration_deactivation", after: "2026-10-26", event: "enote.registration.deactivated" });
  assert.equal(en.paper_copy!.mail_by, "2026-11-09"); assert.deepEqual(en.paper_copy!.markings, ["Copy", "Paid-In-Full"]); assert.equal(en.paper_copy!.notice, "NTC_ENOTE_PAPER_COPY"); assert.equal(en.paper_copy!.event, "enote.paper_copy.sent");
  assert.equal(en.paper_copy!.timer_due_on, "2026-11-10");   // spec discrepancy: SM_ENOTE_PAPER_COPY_10BD anchors accepted_at (10/27) + 10 BD = 11/10; T5's 11/09 is 10 BD from the 10/26 recording — the policy date, never later than the timer
  assert.ok((en.paper_copy!.mail_by as string) <= (en.paper_copy!.timer_due_on as string));
  assert.equal(en.escalation, null); assert.equal(en.portal_task, null);
  // before the release records: the status request runs, nothing is deactivated and no copy is printed
  const pre = enoteOverlay({ payoff_on: D("2026-10-16"), release_recorded_on: null, paper_note_return_required: true, controller: "fnma" }); assert.equal(pre.status_request.due_by, "2026-10-20"); assert.equal(pre.registration_deactivation, null); assert.equal(pre.paper_copy, null);
  assert.equal(enoteOverlay({ payoff_on: D("2026-10-16"), release_recorded_on: D("2026-10-26"), paper_note_return_required: false, controller: "fnma" }).paper_copy, null);
  assert.equal(enoteOverlay({ payoff_on: D("2026-10-16"), release_recorded_on: null, paper_note_return_required: false, controller: "fnma", requires_fnma_ui: true }).portal_task!.owner, "fnma_portal_operator");
  assert.equal(enoteOverlay({ payoff_on: D("2026-10-16"), release_recorded_on: null, paper_note_return_required: false, controller: "other" }).escalation!.kind, "officer");
  // the eRegistry rows: requested 10/19 → confirmed 10/20; the registration deactivation waits for the recording
  const req = eregistryTransaction({ loan_id: "L-EN", min: MIN, enote_id: "eN-77", txn_type: "change_status_paid_off", requested_on: D("2026-10-19"), requested_via: "evault_api", controller_org_id: "1000010", payoff_on: D("2026-10-16") });
  assert.equal(req.refusal, null); assert.deepEqual(req.row, { id: `${MIN}:change_status_paid_off:2026-10-19`, loan_id: "L-EN", min: MIN, enote_id: "eN-77", txn_type: "change_status_paid_off", requested_at: "2026-10-19", requested_via: "evault_api", controller_org_id: "1000010", status: "requested", ack_reference: null, evidence_document_id: null });
  assert.deepEqual(req.event, { type: "enote.status.paid_off", min: MIN, txn_type: "change_status_paid_off", status: "requested", requested_at: "2026-10-19", requested_via: "evault_api", due_by: "2026-10-20", ack_reference: null });
  assert.equal(eregistryTransaction({ ...req.row!, requested_on: D("2026-10-19"), ack: { status: "confirmed", reference: "EV-2026-1020-01" } }).event!.status, "confirmed");
  assert.match(eregistryTransaction({ loan_id: "L-EN", min: MIN, txn_type: "registration_deactivation", requested_on: D("2026-10-20"), requested_via: "evault_api" }).refusal!, /before the release records/);
  assert.equal(eregistryTransaction({ loan_id: "L-EN", min: MIN, txn_type: "registration_deactivation", requested_on: D("2026-10-26"), requested_via: "evault_api", release_recorded_on: D("2026-10-26") }).event!.type, "enote.registration.deactivated");
  const pc = enotePaperCopy({ loan_id: "L-EN", min: MIN, payoff_on: D("2026-10-16"), release_recorded_on: D("2026-10-26"), deactivation_accepted_on: D("2026-10-27"), paper_note_return_required: true, mailed_on: D("2026-10-30"), notice_id: "n-1" });
  assert.deepEqual(pc.event, { type: "enote.paper_copy.sent", min: MIN, notice: "NTC_ENOTE_PAPER_COPY", notice_id: "n-1", markings: ["Copy", "Paid-In-Full"], mailed_at: "2026-10-30", mail_by: "2026-11-09", timer_due_on: "2026-11-10", on_time: true, evault_document_id: null }); assert.deepEqual(pc.housekeeping, { task: "enote_paper_copy", status: "done", completed_on: "2026-10-30" });
  assert.equal(enotePaperCopy({ loan_id: "L-EN", min: MIN, payoff_on: D("2026-10-16"), release_recorded_on: D("2026-10-26"), paper_note_return_required: false, mailed_on: D("2026-10-30"), notice_id: null }).required, false);
  // ---- through the bus and the engine: payoff Fri 10/16 → status requested Mon 10/19 (by 10/20), confirmed 10/20; recording 10/26 → registration + MIN deactivated 10/26–10/27; the marked copy and letter mailed Fri 10/30 (by 11/09)
  const h = harness("L-EN", "2026-10-16T20:00:00.000Z");
  h.emit("loan.paid_in_full", { settlement_id: "S-EN", payoff_date: "2026-10-16", funds_received_on: "2026-10-16", remittance_type: "sa", escrowed: false, enote: true }, AGENT);   // 16.2 postPayoff (its payload carries `enote` for an eMortgage)
  const t2 = h.timers("SM_ENOTE_PAIDOFF_STATUS_2BD"); assert.equal(t2.length, 1); assert.equal(t2[0]!.anchorDate, "2026-10-16"); assert.equal(t2[0]!.dueDate, "2026-10-20");
  h.at("2026-10-19T14:00:00.000Z");
  const req1 = await h.deact({ loan_id: "L-EN", min: MIN, op: "requestENoteStatus", enote_id: "eN-77", payoff_on: "2026-10-16", controller: "fnma", controller_org_id: "1000010", requested_on: "2026-10-19", payoff_evidence_document_id: "doc-payoff-1016" });
  assert.equal((req1.row as { status: string }).status, "requested"); assert.equal(req1.eregistry_transaction_id, `${MIN}:change_status_paid_off:2026-10-19`); assert.equal((req1.status_request as { due_by: string }).due_by, "2026-10-20"); assert.equal(req1.portal_task_id, null); assert.equal(req1.escalation_id, null);
  assert.equal(h.payload("enote.status.paid_off").status, "requested"); assert.equal(h.timers("SM_ENOTE_PAIDOFF_STATUS_2BD")[0]!.status, "satisfied");
  h.at("2026-10-20T14:00:00.000Z");
  const conf = await h.deact({ loan_id: "L-EN", min: MIN, op: "requestENoteStatus", enote_id: "eN-77", payoff_on: "2026-10-16", requested_on: "2026-10-19", ack: { status: "confirmed", reference: "EV-2026-1020-01" } });
  assert.equal((conf.row as { status: string }).status, "confirmed"); assert.equal((conf.row as { ack_reference: string }).ack_reference, "EV-2026-1020-01"); assert.equal(h.events("enote.status.paid_off").length, 2); assert.equal(h.payload("enote.status.paid_off").status, "confirmed");
  assert.equal(h.rt.store.history("mers_eregistry_transactions", req1.eregistry_transaction_id as string).map((v) => v.data.status).join(">"), "requested>confirmed");
  await assert.rejects(h.deact({ loan_id: "L-EN", min: MIN, op: "requestENoteStatus", txn_type: "registration_deactivation", requested_on: "2026-10-20" }), (err: unknown) => err instanceof CommandRefused && err.code === "NO_DEACTIVATE_BEFORE_RECORDING");
  h.at("2026-10-26T18:05:00.000Z");
  const dereg = await h.deact({ loan_id: "L-EN", min: MIN, op: "requestENoteStatus", txn_type: "registration_deactivation", requested_on: "2026-10-26", release_recorded_on: "2026-10-26", enote_id: "eN-77" });
  assert.equal((dereg.row as { txn_type: string }).txn_type, "registration_deactivation"); assert.equal(h.events("enote.registration.deactivated").length, 1);
  const prep = await h.deact({ ...OH, loan_id: "L-EN", today: "2026-10-26", prepare_transaction: true, enote: true, paper_note_return_required: true }); assert.equal(prep.prepared, true);
  h.at("2026-10-27T06:30:00.000Z");
  const ack = await h.deact({ loan_id: "L-EN", min: MIN, op: "ingestMersAck", ack: { status: "accepted" }, ack_ingested_on: "2026-10-27", our_org_id: ORG });
  assert.deepEqual(ack.arms, ["SM_MERS_DEACTIVATION_VERIFY_3BD", "SM_ENOTE_PAPER_COPY_10BD"]); assert.equal(h.payload("mers.txn.accepted").enote, true); assert.equal(h.payload("mers.txn.accepted").paper_note_return_required, true);
  const t10 = h.timers("SM_ENOTE_PAPER_COPY_10BD"); assert.equal(t10.length, 1); assert.equal(t10[0]!.anchorDate, "2026-10-27"); assert.equal(t10[0]!.dueDate, "2026-11-10");
  await assert.rejects(h.deact({ loan_id: "L-EN", min: MIN, op: "printENoteCopy", payoff_on: "2026-10-16", release_recorded_on: "2026-10-26", recipients: RECIPIENTS, payload: LETTER(), template_code: "NTC_LIEN_RELEASE_RECORDED" }), (err: unknown) => err instanceof CommandRefused && err.code === "NO_BORROWER_CONTACT_EXCEPT_PAPER_COPY");
  h.at("2026-10-30T16:00:00.000Z");
  const mailed = await h.deact({ loan_id: "L-EN", min: MIN, op: "printENoteCopy", payoff_on: "2026-10-16", release_recorded_on: "2026-10-26", mailed_on: "2026-10-30", recipients: RECIPIENTS, payload: LETTER(), evault_document_id: "doc-evault-eN-77" });
  assert.equal(mailed.required, true); assert.equal(mailed.notice_status, "sent"); assert.equal((mailed.event as { mail_by: string }).mail_by, "2026-11-09"); assert.equal((mailed.event as { timer_due_on: string }).timer_due_on, "2026-11-10"); assert.equal((mailed.event as { on_time: boolean }).on_time, true);
  assert.equal(h.payload("notice.sent").template, "NTC_ENOTE_PAPER_COPY"); assert.equal(h.timers("SM_ENOTE_PAPER_COPY_10BD")[0]!.status, "satisfied");   // the mailing event closes the timer
  assert.deepEqual(h.payload("enote.paper_copy.sent").markings, ["Copy", "Paid-In-Full"]); assert.equal(h.payload("enote.paper_copy.sent").notice_id, mailed.notice_id); assert.equal(h.payload("enote.paper_copy.sent").evault_document_id, "doc-evault-eN-77");
  assert.equal(h.rt.store.get("payoff_housekeeping_tasks", "L-EN:enote_paper_copy")!.data.status, "done");
  const n = h.rt.notices!.get(mailed.notice_id as string); assert.equal(n.templateCode, "NTC_ENOTE_PAPER_COPY"); assert.equal(n.checklist.passed, true); assert.equal(h.rt.notices!.template("NTC_ENOTE_PAPER_COPY").channelPolicy, "mail_only");
  assert.match(n.rendered.text, /marked "Copy" and "Paid-In-Full"/); assert.match(n.rendered.text, /F-1-09/); assert.match(n.rendered.text, /eRegistry status .+ paid off/); assert.match(n.rendered.text, /MERS registration \(MIN 1000123-0000456789-0\) (is being|has been) deactivated/); assert.match(n.rendered.text, /Instrument No\. 202610260041/);
  assert.equal(h.rt.ports.printMail!.constructor.name, "FakePrintMail");
  const nopaper = await h.deact({ loan_id: "L-EN", min: MIN, op: "printENoteCopy", payoff_on: "2026-10-16", release_recorded_on: "2026-10-26", paper_note_return_required: false }); assert.equal(nopaper.required, false); assert.equal(nopaper.notice_id, null);
  // the letter's own version publishes on its own checklist (no other section's draft in the way)
  const v = noticeReg.activeVersion("NTC_ENOTE_PAPER_COPY", D("2026-11-09"))!; const out = render(v.source, LETTER()); assert.equal(evaluateChecklist(v, LETTER(), out).passed, true);
  // a Fannie Mae UI step is a human_portal_task for the fnma_portal_operator with the eNote package; a Controller other than Fannie Mae goes to the officer
  const h2 = harness("L-UI", "2026-10-19T14:00:00.000Z");
  const ui = await h2.deact({ loan_id: "L-UI", min: MIN, op: "requestENoteStatus", payoff_on: "2026-10-16", requires_fnma_ui: true, payoff_evidence_document_id: "doc-payoff-1016" });
  assert.equal((ui.row as { requested_via: string }).requested_via, "ui"); assert.ok(ui.portal_task_id); const task = h2.rt.escalations.opened.find((e) => e.id === ui.portal_task_id)!; assert.equal(task.kind, "human_portal_task"); assert.equal(task.ownerRole, "fnma_portal_operator"); assert.deepEqual(task.payload.package, { min: MIN, enote_id: null, payoff_evidence_document_id: "doc-payoff-1016", requested_status: "Paid Off", requested_on: "2026-10-19", due_by: "2026-10-20" });
  const other = await h2.deact({ loan_id: "L-UI", min: "1000123-0000456790-8", op: "requestENoteStatus", payoff_on: "2026-10-16", controller: "other" }); const esc = h2.rt.escalations.opened.find((e) => e.id === other.escalation_id)!; assert.equal(esc.kind, "officer"); assert.match(String(esc.payload.reason), /Controller is not Fannie Mae/);
  assert.equal(h2.events("escalation.created").length, 2);
});
test("16.4-T6: Given a payoff reversed 10/28 after a 10/27 deactivation, then a reversal is submitted by 11/04 and the MIN snapshot shows active again.", async () => {
  const rv = deactivationReversal({ min: MIN, cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: D("2026-10-28"), deactivated_on: D("2026-10-27"), mers_window_open: true });
  assert.equal(rv.path, "reversal"); assert.equal(rv.txn_type, "deactivation_reversal"); assert.equal(rv.submit_by, "2026-11-04"); assert.equal(rv.submit_by, reversalDue(D("2026-10-28")));   // 10/28 + 5 BD
  assert.equal(rv.fee_cents, 0n); assert.equal(rv.borrower_charge_cents, 0n); assert.equal(rv.qa_finding, false); assert.equal(rv.escalation, null); assert.equal(rv.snapshot_expected, "active"); assert.equal(rv.satisfied_by, "mers.txn.accepted{deactivation_reversal}");
  assert.deepEqual(rv.reversal_needed_event, { type: "mers.deactivation.reversal_needed", min: MIN, reversal_needed_on: "2026-10-28", cause: "payoff_reversed", cause_document_id: "doc-rev-1028", deactivated_on: "2026-10-27", path: "reversal", submit_by: "2026-11-04", contested: false });
  assert.deepEqual(rv.transaction, { txn_type: "deactivation_reversal", min: MIN, effective_date: "2026-10-28", reason_code: "payoff_reversed", status: "prepared", fee_cents: 0n }); assert.equal(rv.cancel_eligibility, null);
  // the reversal rides the 10/28 batch and is accepted 10/29 (within 11/04) → SM_MERS_DEACT_REVERSAL_5BD satisfied
  const ack = mersAck({ min: MIN, txn_type: "deactivation_reversal", submitted_on: D("2026-10-28"), ack_ingested_on: D("2026-10-29"), ack: { status: "accepted" }, our_org_id: ORG, min_subservicer_org_id: ORG, due_on: rv.submit_by });
  assert.equal(ack.state, "accepted"); assert.equal(ack.accepted_on, "2026-10-29"); assert.deepEqual(ack.satisfies, ["SM_MERS_DEACT_REVERSAL_5BD"]); assert.deepEqual(ack.arms, []); assert.equal(ack.event!.txn_type, "deactivation_reversal"); assert.equal(ack.on_time.deadline, true); assert.equal(ack.verify_by, null);
  // the MIN snapshot shows active again → reactivated, mers.deactivation.reversed, back to the 16.2/16.3 states
  const snap = reactivationSnapshot({ min: MIN, reversal_accepted_on: ack.accepted_on!, snapshot: { taken_on: D("2026-10-30"), status: "active", reason: null } });
  assert.equal(snap.reactivated, true); assert.equal(snap.state, "reactivated"); assert.equal(snap.satisfied_on, "2026-10-30"); assert.deepEqual(snap.event, { type: "mers.deactivation.reversed", min: MIN, status: "active", taken_on: "2026-10-30" }); assert.equal(snap.loan_returns_to, "16.2/16.3 states of the reopened loan"); assert.equal(snap.escalation, null);
  const still = reactivationSnapshot({ min: MIN, reversal_accepted_on: D("2026-10-29"), snapshot: { taken_on: D("2026-11-04"), status: "inactive", reason: "Paid in Full" } });
  assert.equal(still.reactivated, false); assert.equal(still.state, "reversal_submitted"); assert.equal(still.event, null); assert.equal(still.escalation!.kind, "officer");   // still inactive after 10/29 + 3 BD (11/03)
  assert.equal(reactivationSnapshot({ min: MIN, reversal_accepted_on: D("2026-10-29"), snapshot: null }).escalation, null);
  // rule 6 guardrail on the tool: no reversal without a documented cause — the same fields the handler plans the reversal from
  const g = guard("checkDeactivationEligibility", "NO_REVERSAL_WITHOUT_CAUSE");
  assert.match(g.refuse({ txn_type: "deactivation_reversal", reversal_needed_on: "2026-10-28" }, NOCTX)!, /record the cause/);
  assert.match(g.refuse({ op: "reverse", cause: "payoff_reversed" }, NOCTX)!, /evidence document/);
  assert.match(g.refuse({ txn_type: "deactivation_reversal", cause: "changed_my_mind", cause_document_id: "doc-1" }, NOCTX)!, /payoff_reversed \/ wrong_min/);
  assert.equal(g.refuse({ txn_type: "deactivation_reversal", cause: "payoff_reversed", cause_document_id: "doc-rev-1028" }, NOCTX), undefined);
  assert.equal(g.refuse({ prepare_transaction: true, loan_status: "paid_in_full" }, NOCTX), undefined);   // not a reversal
  assert.equal(opOf({ txn_type: "deactivation_reversal" }), "reverse"); assert.equal(opOf({ prepare_transaction: true }), "prepare"); assert.equal(opOf({}), "check");
  assert.equal(deactivationReversal({ min: MIN, cause: null, reversal_needed_on: D("2026-10-28"), deactivated_on: D("2026-10-27"), mers_window_open: true }).path, "refused");
  assert.equal(deactivationReversal({ min: MIN, cause: "payoff_reversed", cause_document_id: null, reversal_needed_on: D("2026-10-28"), deactivated_on: D("2026-10-27"), mers_window_open: true }).path, "refused");
  // reversed before the release records: eligibility is cancelled, nothing to reverse
  const none = deactivationReversal({ min: MIN, cause: "payoff_reversed", cause_document_id: "doc-rev", reversal_needed_on: D("2026-10-22"), deactivated_on: null, mers_window_open: true });
  assert.equal(none.path, "nothing_to_reverse"); assert.equal(none.reversal_needed_event, null); assert.deepEqual(none.cancel_eligibility!.timers, ["MERS_PROC_PAID_IN_FULL_DEACTIVATE_60", "SM_MERS_DEACTIVATE_TARGET_5BD"]); assert.equal(none.cancel_eligibility!.event.type, "mers.deactivation.eligibility_cancelled");
  // ---- through the bus and the engine: deactivation accepted 10/27; payoff reversed 10/28 → reversal_needed arms the 5-BD row (due 11/04); accepted 10/29; snapshot active 10/30
  const h = harness("L-OH", "2026-10-26T15:00:00.000Z");
  const prep = await h.deact({ ...OH, today: "2026-10-26", prepare_transaction: true }); h.at("2026-10-27T06:30:00.000Z");
  await h.deact({ loan_id: "L-OH", min: MIN, op: "ingestMersAck", ack: { status: "accepted" }, ack_ingested_on: "2026-10-27", our_org_id: ORG });
  h.at("2026-10-28T15:00:00.000Z");
  h.emit("payoff.reversed", { settlement_id: "S-OH", branch: "returned_item", cause: "returned_item", returned_on: "2026-10-28" }, AGENT);   // 16.2 — carries no deactivation qualifier
  assert.equal(h.timers("SM_MERS_DEACT_REVERSAL_5BD").length, 0, "the reversal row arms on the reversal_needed transition, not on every payoff.reversed");
  await assert.rejects(h.deact({ loan_id: "L-OH", min: MIN, txn_type: "deactivation_reversal", reversal_needed_on: "2026-10-28" }), (err: unknown) => err instanceof CommandRefused && err.code === "NO_REVERSAL_WITHOUT_CAUSE");
  const plan = await h.deact({ loan_id: "L-OH", min: MIN, txn_type: "deactivation_reversal", cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: "2026-10-28" });   // deactivated_on comes from the accepted row (10/27)
  assert.equal(plan.path, "reversal"); assert.equal(plan.submit_by, "2026-11-04"); assert.equal(plan.transaction_id, mersTxnKey(MIN, "deactivation_reversal", D("2026-10-28"))); assert.equal(plan.escalation_id, null);
  const rrow = h.rt.store.get("mers_transactions", plan.transaction_id as string)!.data; assert.equal(rrow.status, "prepared"); assert.equal(rrow.deactivated_on, "2026-10-27"); assert.equal(rrow.reverses_transaction_id, prep.transaction_id); assert.equal(rrow.cause_document_id, "doc-rev-1028");
  const t5 = h.timers("SM_MERS_DEACT_REVERSAL_5BD"); assert.equal(t5.length, 1); assert.equal(t5[0]!.anchorDate, "2026-10-28"); assert.equal(t5[0]!.dueDate, "2026-11-04");   // a reversal is submitted by 11/04
  await h.deact({ loan_id: "L-OH", min: MIN, txn_type: "deactivation_reversal", cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: "2026-10-28" }); assert.equal(h.timers("SM_MERS_DEACT_REVERSAL_5BD").length, 1, "idempotent on (min, txn_type, effective_date)");
  h.at("2026-10-29T06:30:00.000Z");
  const rack = await h.deact({ loan_id: "L-OH", min: MIN, op: "ingestMersAck", txn_type: "deactivation_reversal", ack: { status: "accepted" }, ack_ingested_on: "2026-10-29", our_org_id: ORG });
  assert.equal(rack.state, "accepted"); assert.equal((rack.on_time as { deadline: boolean }).deadline, true); assert.equal(h.timers("SM_MERS_DEACT_REVERSAL_5BD")[0]!.status, "satisfied"); assert.equal(h.payload("mers.txn.accepted").txn_type, "deactivation_reversal");
  h.at("2026-10-30T12:00:00.000Z");
  const re = await h.deact({ loan_id: "L-OH", min: MIN, op: "snapshotMins", txn_type: "deactivation_reversal", snapshot: { taken_on: "2026-10-30", status: "active", reason: null } });
  assert.equal(re.reactivated, true); assert.equal(re.loan_returns_to, "16.2/16.3 states of the reopened loan"); assert.equal(h.payload("mers.deactivation.reversed").status, "active"); assert.equal(h.rt.store.get("mers_min_snapshots", `${MIN}:2026-10-30`)!.data.status, "active"); assert.equal(h.rt.store.get("mers_transactions", plan.transaction_id as string)!.data.status, "confirmed");
  // outside MERS' window: re-register ($24.95 to the partner's invoice, never the borrower), QA finding, officer; contested: attorney
  const h2 = harness("L-RR", "2026-10-28T15:00:00.000Z");
  const rr = await h2.deact({ loan_id: "L-RR", min: MIN, txn_type: "deactivation_reversal", cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: "2026-10-28", deactivated_on: "2026-10-27", mers_window_open: false });
  assert.equal(rr.path, "re_register"); assert.equal(rr.fee_cents, 2_495n); assert.equal(rr.bill_to, "partner_mers_invoice"); assert.equal(rr.borrower_charge_cents, 0n); assert.ok(rr.qa_finding_id); assert.equal(h2.rt.store.get("mers_qa_findings", rr.qa_finding_id as string)!.data.kind, "reversal_window_passed");
  const oe = h2.rt.escalations.opened.find((e) => e.id === rr.escalation_id)!; assert.equal(oe.kind, "officer"); assert.equal(oe.severity, "sev2"); assert.equal(oe.payload.fee_cents, 2_495n); assert.match(String(oe.payload.reason), /re-register/);
  const ct = await h2.deact({ loan_id: "L-RR", min: "1000123-0000456790-8", txn_type: "deactivation_reversal", cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: "2026-10-28", deactivated_on: "2026-10-27", contested: true });
  const ae = h2.rt.escalations.opened.find((e) => e.id === ct.escalation_id)!; assert.equal(ae.kind, "attorney"); assert.match(String(ae.payload.reason), /contested payoff reversal/);
  // reversed before any deactivation: the eligibility (armed 60-day / 5-BD instances, the prepared row) is cancelled — nothing to reverse
  const h3 = harness("L-PRE", "2026-10-26T15:00:00.000Z"); const p3 = await h3.deact({ ...OH, loan_id: "L-PRE", today: "2026-10-26", prepare_transaction: true });
  assert.equal(h3.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.status, "armed");
  const nr = await h3.deact({ loan_id: "L-PRE", min: MIN, txn_type: "deactivation_reversal", cause: "payoff_reversed", cause_document_id: "doc-rev", reversal_needed_on: "2026-10-27", deactivated_on: null });
  assert.equal(nr.path, "nothing_to_reverse"); assert.equal((nr.timers_cancelled as string[]).length, 2); assert.equal(h3.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.status, "cancelled"); assert.equal(h3.timers("SM_MERS_DEACTIVATE_TARGET_5BD")[0]!.status, "cancelled"); assert.equal(h3.timers("SM_MERS_DEACT_REVERSAL_5BD").length, 0);
  assert.equal(h3.rt.store.get("mers_transactions", p3.transaction_id as string)!.data.status, "cancelled"); assert.equal(h3.events("mers.deactivation.eligibility_cancelled").length, 1); assert.equal(h3.events("timer.cancelled").length, 2);
});
test("16.4-T7: Given the November MRE lists an active MIN for a loan paid off and released in August, then a QA finding opens with sev-1 and the deactivation is submitted the same day.", async () => {
  const r = mreReconcile({ mre_received_on: D("2026-11-05"), our_org_id: ORG, rows: [
    { min: MIN, loan_id: "L-1", min_active: true, loan_status: "paid_in_full", release_recorded_on: D("2026-08-14"), subservicer_org_id: ORG },
    { min: "1000123-0000456790-8", loan_id: "L-2", min_active: false, loan_status: "paid_in_full", release_recorded_on: D("2026-10-26"), subservicer_org_id: ORG },
  ] });
  assert.equal(r.clean, 1); assert.equal(r.findings.length, 1); const f = r.findings[0]!;
  assert.equal(f.exception, "active_min_on_paid_loan"); assert.equal(f.days_since_recording, 83); assert.deepEqual(f.qa_finding, { severity: "sev1", opened_on: "2026-11-05" });
  assert.equal(f.action, "submit_deactivation"); assert.equal(f.submit_on, "2026-11-05"); assert.equal(f.batch, "same_day"); assert.equal(f.escalation!.kind, "officer"); assert.equal(f.escalation!.severity, "sev1"); assert.match(f.escalation!.reason, /Rule 7/);
  assert.deepEqual(r.received_event, { type: "mers.mre.received", received_on: "2026-11-05", org_id: ORG, rows: 2 });
  assert.deepEqual(r.completed_event, { type: "mers.recon.completed", received_on: "2026-11-05", org_id: ORG, exceptions: 1, findings: [{ min: MIN, exception: "active_min_on_paid_loan", severity: "sev1" }] });
  assert.deepEqual(r.eligible_events, [{ type: "mers.deactivation.eligible", min: MIN, loan_id: "L-1", last_recorded_at: "2026-08-14", first_recorded_at: "2026-08-14", source: "recorded", release_task_ids: [], due_on: "2026-10-13", policy_target: "2026-08-21", counties: 1 }]);
  const b = batchSchedule({ eligible_on: D("2026-11-05"), due_on: deactivationClocks(D("2026-08-14")).due_on }); assert.equal(deactivationClocks(D("2026-08-14")).due_on, "2026-10-13"); assert.equal(b.window, "same_day"); assert.equal(b.batch_on, "2026-11-05");
  const other = mreReconcile({ mre_received_on: D("2026-11-05"), our_org_id: ORG, rows: [{ min: "A", loan_id: "L-3", min_active: false, loan_status: "active", release_recorded_on: null, subservicer_org_id: ORG }, { min: "B", loan_id: "L-4", min_active: true, loan_status: "active", release_recorded_on: null, subservicer_org_id: "1000999" }] });
  assert.deepEqual(other.findings.map((x) => [x.exception, x.action, x.qa_finding.severity]), [["inactive_min_on_active_loan", "submit_reversal", "sev2"], ["wrong_subservicer", "request_subservicer_designation", "sev3"]]); assert.deepEqual(other.eligible_events, []);
  // ---- through the bus and the engine (1.5's MRE row reused here): the QA finding row opens sev-1 to the officer, the stale MIN is eligible on its August recording date — the 60-day instance is already past due and breaches sev-1 on evaluation — and the deactivation rides the same-day batch
  const h = harness("L-1", "2026-11-05T09:00:00.000Z", ["16.4", "1.5"]);
  const out = await h.deact({ op: "reconcileMre", mre_received_on: "2026-11-05", our_org_id: ORG, rows: [{ min: MIN, loan_id: "L-1", min_active: true, loan_status: "paid_in_full", release_recorded_on: "2026-08-14", subservicer_org_id: ORG }, { min: "1000123-0000456790-8", loan_id: "L-2", min_active: false, loan_status: "paid_in_full", release_recorded_on: "2026-10-26", subservicer_org_id: ORG }] });
  assert.equal(out.clean, 1); const fd = (out.findings as { qa_finding_id: string; escalation_id: string; exception: string }[])[0]!;
  const qa = h.rt.store.get("mers_qa_findings", fd.qa_finding_id)!.data; assert.equal(qa.severity, "sev1"); assert.equal(qa.kind, "active_min_on_paid_loan"); assert.equal(qa.raised_at, "2026-11-05"); assert.equal(qa.action, "submit_deactivation"); assert.equal(qa.submit_on, "2026-11-05"); assert.equal(qa.resolved_at, null);
  const esc = h.rt.escalations.opened.find((e) => e.id === fd.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev1"); assert.equal(esc.loanId, "L-1"); assert.match(String(esc.payload.reason), /83 days after the release recorded on 2026-08-14/);
  const mre = h.timers("MERS_QA_MRE_RECON_MONTHLY"); assert.ok(mre.length >= 1); assert.equal(mre[0]!.status, "satisfied");   // `mers.mre.received` arms the 1.5 recurring row; `mers.recon.completed` satisfies it
  assert.equal(h.events("mers.deactivation.eligible").length, 1); assert.equal(h.payload("mers.deactivation.eligible").source_of_eligibility, "mre_reconciliation");
  const t60 = h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60"); assert.equal(t60.length, 1); assert.equal(t60[0]!.anchorDate, "2026-08-14"); assert.equal(t60[0]!.dueDate, "2026-10-13"); assert.equal(t60[0]!.loanId, "L-1");
  const breaches = h.ctx.timers.evaluate("2026-11-05T09:00:00.000Z"); assert.equal(breaches.filter((x) => x.instance.code === "MERS_PROC_PAID_IN_FULL_DEACTIVATE_60").length, 1); const br = breaches.find((x) => x.instance.code === "MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")!; assert.equal(br.severity, 1); assert.deepEqual([...br.escalateTo], ["officer"]);
  const sched = await h.deact({ loan_id: "L-1", min: MIN, op: "schedule", eligible_on: "2026-11-05", effective_date: "2026-08-14" }); assert.equal(sched.window, "same_day"); assert.equal(sched.batch_on, "2026-11-05"); assert.equal(sched.due_on, "2026-10-13");
  h.at("2026-11-06T06:30:00.000Z");
  await h.deact({ loan_id: "L-1", min: MIN, op: "ingestMersAck", ack: { status: "accepted" }, ack_ingested_on: "2026-11-06", our_org_id: ORG, effective_date: "2026-08-14" });
  assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.status, "satisfied_late");
});
test("16.4-T8: Given the MERS batch channel is down on 12/22 with a 12/25 deadline, then the escalation fires at deadline − 5 days and a manual MERS OnLine task is created for the `officer`-authorized operator.", async () => {
  const r = batchOutage({ min: MIN, outage_on: D("2026-12-22"), due_on: D("2026-12-25"), batch_document_id: "doc-batch-1222" });
  assert.equal(r.escalate_on, "2026-12-20"); assert.equal(r.escalation_fired, true); assert.equal(r.days_to_deadline, 3);
  assert.equal(r.escalation!.kind, "officer"); assert.match(r.escalation!.reason, /MERS OnLine/);
  assert.deepEqual(r.manual_task, { kind: "mers_online_manual_upload", authorized_role: "officer", min: MIN, due_on: "2026-12-25", batch_document_id: "doc-batch-1222" });
  assert.equal(r.resubmit_next_window, "2026-12-23"); assert.equal(r.timers_unaffected, true);
  assert.deepEqual(r.event, { type: "mers.batch.outage", min: MIN, outage_on: "2026-12-22", due_on: "2026-12-25", escalate_on: "2026-12-20", escalation_fired: true, resubmit_next_window: "2026-12-23", days_to_deadline: 3 });
  assert.equal(deactivationClocks(D("2026-10-26")).due_on, "2026-12-25"); assert.equal(deactivationClocks(D("2026-10-26")).escalate_on, r.escalate_on); // the 12/25 deadline is the Ohio 60-day clock; deadline − 5 = 12/20
  const early = batchOutage({ min: MIN, outage_on: D("2026-10-28"), due_on: D("2026-12-25") }); assert.equal(early.escalation_fired, false); assert.equal(early.escalation, null); assert.equal(early.manual_task, null); assert.equal(early.resubmit_next_window, "2026-10-29"); assert.equal(early.timers_unaffected, true);
  // ---- through the bus: the prepared Ohio deactivation (due 12/25) meets the outage on 12/22 → the officer's MERS OnLine upload task opens with the batch; the 60-day instance is untouched; an early outage opens nothing
  const h = harness("L-OH", "2026-10-26T15:00:00.000Z"); const prep = await h.deact({ ...OH, today: "2026-10-26", prepare_transaction: true });
  h.at("2026-10-28T09:00:00.000Z");
  const ok = await h.deact({ loan_id: "L-OH", min: MIN, op: "batchOutage", outage_on: "2026-10-28" }); assert.equal(ok.escalation_fired, false); assert.equal(ok.escalation_id, null); assert.equal(ok.due_on ?? (ok.event as { due_on: string }).due_on, "2026-12-25");
  h.at("2026-12-22T09:00:00.000Z");
  const out = await h.deact({ loan_id: "L-OH", min: MIN, op: "batchOutage", outage_on: "2026-12-22", batch_document_id: "doc-batch-1222" });
  assert.equal(out.escalation_fired, true); assert.equal(out.escalate_on, "2026-12-20"); assert.equal(out.resubmit_next_window, "2026-12-23"); assert.equal(out.timers_unaffected, true);
  const task = h.rt.escalations.opened.find((e) => e.id === out.escalation_id)!; assert.equal(task.kind, "officer"); assert.equal(task.ownerRole, "officer"); assert.equal(task.severity, "sev2"); assert.equal(task.loanId, "L-OH");
  assert.equal(task.payload.task, "mers_online_manual_upload"); assert.equal(task.payload.authorized_role, "officer"); assert.equal(task.payload.due_on, "2026-12-25"); assert.equal(task.payload.batch_document_id, "doc-batch-1222"); assert.equal(task.payload.transaction_id, prep.transaction_id); assert.match(String(task.payload.reason), /manual MERS OnLine submission/);
  assert.equal(h.events("mers.batch.outage").length, 2); assert.equal(h.events("escalation.created").length, 1); assert.equal(h.rt.store.get("mers_transactions", prep.transaction_id as string)!.data.manual_upload_task_id, task.id);
  const t60 = h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!; assert.equal(t60.status, "armed"); assert.equal(t60.dueDate, "2026-12-25");   // timers unaffected (60-day cushion)
  const breaches = h.ctx.timers.evaluate("2026-12-22T09:00:00.000Z"); assert.deepEqual(breaches.map((x) => [x.instance.code, x.severity]), [["SM_MERS_DEACTIVATE_TARGET_5BD", 3]]);   // only the 11/02 policy target has passed (sev-3); the MERS deadline has not
  assert.equal(h.timers("MERS_PROC_PAID_IN_FULL_DEACTIVATE_60")[0]!.status, "armed");
});

test("16.4 worked figures: Ohio release recorded 2026-10-26 → MERS_PROC_PAID_IN_FULL_DEACTIVATE_60 due 2026-12-25, policy target 2026-11-02, T+0 batch (image 14:05), ack 10/27, snapshot inactive 10/28; two-county second recording 11/10 → due 2027-01-09; eNote payoff 10/16 → Paid Off status by 10/20, marked copy + letter by 11/09; reversal 10/28 → 11/04; outside the window re-register at $24.95 to the partner's MERS invoice, $0.00 to the borrower", () => {
  const e = deactivationEligibility({ min: MIN, loan_id: "L-OH", loan_status: "paid_in_full", min_status: "active", release_tasks: [{ county: "Franklin", status: "recorded", recorded_on: D("2026-10-26") }], attempted_on: D("2026-10-26"), actor: "payoff-release" });
  assert.equal(e.eligible, true); assert.equal(e.reason, "paid_in_full"); assert.equal(e.last_recorded_on, "2026-10-26"); assert.deepEqual(e.clocks, { due_on: "2026-12-25", policy_target: "2026-11-02", escalate_on: "2026-12-20" });
  const blocked = deactivationEligibility({ min: MIN, loan_id: "L-OH", loan_status: "paid_in_full", min_status: "active", release_tasks: [{ county: "Franklin", status: "submitted" }], attempted_on: D("2026-10-20"), actor: "payoff-release" });
  assert.equal(blocked.eligible, false); assert.equal(blocked.gate.ok, false); assert.deepEqual(blocked.blocked_counties, ["Franklin"]); assert.equal(blocked.attempt_log!.type, "mers.deactivation.refused"); assert.equal(blocked.attempt_log!.attempted_on, "2026-10-20");
  const two = deactivationEligibility({ min: MIN, loan_id: "L-2C", loan_status: "paid_in_full", min_status: "active", release_tasks: [{ county: "Franklin", status: "recorded", recorded_on: D("2026-10-26") }, { county: "Delaware", status: "recorded", recorded_on: D("2026-11-10") }], attempted_on: D("2026-11-10"), actor: "payoff-release" });
  assert.equal(two.last_recorded_on, "2026-11-10"); assert.equal(two.clocks!.due_on, "2027-01-09"); assert.equal(two.warning!.conservative_due_on, "2026-12-25"); assert.equal(two.eligible_event!.last_recorded_at, "2026-11-10");
  assert.equal(deactivationEligibility({ min: MIN, loan_id: "L-A", loan_status: "active", min_status: "active", release_tasks: [], attempted_on: D("2026-10-26"), actor: "payoff-release" }).state, "not_payoff");
  assert.equal(deactivationEligibility({ min: MIN, loan_id: "L-I", loan_status: "paid_in_full", min_status: "inactive", release_tasks: [], attempted_on: D("2026-10-26"), actor: "payoff-release" }).state, "already_inactive");
  const b = batchSchedule({ eligible_on: D("2026-10-26"), due_on: D("2026-12-25"), evidence_time_local: "14:05" }); assert.equal(b.window, "T+0"); assert.equal(b.batch_on, "2026-10-26"); assert.equal(b.ack_ingested_on, "2026-10-27"); assert.equal(b.same_day_required, false);
  assert.equal(batchSchedule({ eligible_on: D("2026-10-26"), due_on: D("2026-12-25"), evidence_time_local: "19:30" }).batch_on, "2026-10-27");
  const v = verificationSnapshot({ min: MIN, accepted_on: D("2026-10-27"), snapshot: { taken_on: D("2026-10-28"), status: "inactive", reason: "Paid in Full" } });
  assert.equal(v.verified, true); assert.equal(v.satisfied_on, "2026-10-28"); assert.equal(v.event!.type, "mers.snapshot.verified"); assert.equal(v.verify_by, "2026-10-30"); // timer row anchors accepted_at (10/27) + 3 BD = 10/30; spec T1's "by 10/29" is 3 BD from the 10/26 recording
  assert.equal(verificationSnapshot({ min: MIN, accepted_on: D("2026-10-27"), snapshot: { taken_on: D("2026-11-02"), status: "active", reason: null } }).breach, "sev3_resubmit_or_inquiry");
  const en = enoteOverlay({ payoff_on: D("2026-10-16"), release_recorded_on: D("2026-10-26"), paper_note_return_required: true, controller: "fnma" });
  assert.equal(en.status_request.due_by, "2026-10-20"); assert.equal(en.status_request.requested_via, "evault_api"); assert.equal(en.registration_deactivation!.after, "2026-10-26"); assert.equal(en.paper_copy!.mail_by, "2026-11-09"); assert.equal(en.paper_copy!.timer_due_on, null); assert.deepEqual(en.paper_copy!.markings, ["Copy", "Paid-In-Full"]); assert.equal(en.paper_copy!.notice, "NTC_ENOTE_PAPER_COPY"); assert.equal(en.escalation, null); assert.equal(en.portal_task, null);
  const rv = deactivationReversal({ min: MIN, cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: D("2026-10-28"), deactivated_on: D("2026-10-27"), mers_window_open: true });
  assert.equal(rv.path, "reversal"); assert.equal(rv.txn_type, "deactivation_reversal"); assert.equal(rv.submit_by, "2026-11-04"); assert.equal(rv.fee_cents, 0n); assert.equal(rv.snapshot_expected, "active"); assert.equal(rv.escalation, null);
  const rr = deactivationReversal({ min: MIN, cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: D("2026-10-28"), deactivated_on: D("2026-10-27"), mers_window_open: false });
  assert.equal(rr.path, "re_register"); assert.equal(rr.txn_type, "registration"); assert.equal(rr.fee_cents, 2_495n); assert.equal(rr.bill_to, "partner_mers_invoice"); assert.equal(rr.borrower_charge_cents, 0n); assert.equal(rr.qa_finding, true); assert.equal(rr.escalation!.kind, "officer");
  assert.equal(deactivationReversal({ min: MIN, cause: "payoff_reversed", cause_document_id: "doc-rev-1028", reversal_needed_on: D("2026-10-28"), deactivated_on: D("2026-10-27"), mers_window_open: true, contested: true }).escalation!.kind, "attorney");
});
