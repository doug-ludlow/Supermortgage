// 11.3 Quality Right Party Contact (QRPC)
// spec/sections/11-early-intervention-collections/11-3-quality-right-party-contact-qrpc.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { CommandBus } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_11_TOOLS } from "../../app/tools/section11.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { thirdPartyCall, threeWayAuthorization, qrpcRecordStatus, humanVerify, awReporting, licensedNegotiationGate, disasterReasonType, validateExtraction, representedDebtorCall } from "./ops.ts";
import { promiseToPay, qrpcCompleteness, nextAttemptTargets, extractHardship, optionsDetermination, cessationOnQrpc, qrpcStaleness, isStale } from "./qrpc.ts";
import { newPlan, openPlanIfDue, applyQrpc, planState, resume } from "./plan.ts";
import { lateChargeAmount } from "../cashiering/latecharges.ts";
import { CommandRefused } from "../../app/commands.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { thirdPartyConversation, modificationTermsDiscussed, buildQrpcInvestorEvent, qrpcReasonType } from "./ops-11-3.ts";

function uow(loanId = "L-11"): UowContext & { events: MemoryEventStore } { const clock = new FixedClock("2026-12-11T18:05:00.000Z"); const events = new MemoryEventStore(clock); return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} }; }
function harness() { const ctx = uow(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const agents = new AgentRegistry(); const def = SECTION_11_TOOLS.find((t) => t.process === "11.3" && t.name === "qrpc.capture")!; const cmd = toolCommand(def, rt, ["human_agent", "lossmit_reviewer"]); agents.registerTool("borrower-comms", cmd.name); return { ctx, rt, bus: new CommandBus(agents), cmd, comms: { kind: "agent", id: "borrower-comms" } as Actor }; }
/** A loan-scoped engine on the overridden registry (section + 11.3 process overrides), restricted to 11.3, so the tools' events arm the 11.3 gates. */
function gatedUow(loanId = "L-11", now = "2026-12-11T18:05:00.000Z"): UowContext & { events: MemoryEventStore; timers: TimerEngine } { const clock = new FixedClock(now); const events = new MemoryEventStore(clock); return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes: ["11.3"] }), clock, decide: () => {} }; }
function gatedHarness(...names: string[]) { const ctx = gatedUow(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const agents = new AgentRegistry(); const cmds = new Map(names.map((n) => { const def = SECTION_11_TOOLS.find((t) => t.process === "11.3" && t.name === n)!; const cmd = toolCommand(def, rt, ["human_agent", "lossmit_reviewer"]); agents.registerTool("borrower-comms", cmd.name); return [n, cmd] as const; }));
  const comms = { kind: "agent", id: "borrower-comms" } as Actor; const bus = new CommandBus(agents);
  return { ctx, rt, bus, comms, run: async (name: string, input: Record<string, unknown>) => (await bus.execute(cmds.get(name)!, comms, input, ctx)).output as Record<string, unknown>, cmd: (name: string) => cmds.get(name)!, ev: (type: string) => ctx.events.all().filter((e) => e.type === type), registry: loadOverriddenRegistry() }; }
const FULL = { verified_party: "borrower" as const, reason_primary: "unemployment", hardship_nature: "temporary", occupancy_status: "borrower_occupied_principal", ability_to_pay: { commitment_kind: "promise_to_pay_full" }, options_explained: ["repayment plan", "forbearance"], commitment_kind: "promise_to_pay_full" as const, payment_importance_emphasized: true };
const ELEMENTS = { reason: { value: "unemployment", evidence_span: "00:41-00:52" }, occupancy: { value: "borrower_occupied_principal", evidence_span: "01:10-01:15" }, ability_to_pay: { value: "can_pay_by_date", evidence_span: "02:02-02:20" }, options: { value: ["repayment plan", "forbearance"], evidence_span: "02:30-03:05" }, commitment: { value: "promise_to_pay_full", evidence_span: "03:10-03:25" } };

test("11.3-T1: Given a verified AI conversation capturing all five elements with transcript evidence, when the flag is on, then `qrpc_records` is created, `contacts.qrpc=true`, `contact.qrpc.established` fires, the 11.1 plan ceases (per commitment), and 5.7 receives AW/QRPC with reason code.", async () => {
  const h = harness();
  const r = await h.bus.execute(h.cmd, h.comms, { loan_id: "L-11", contact_id: "ct-1", ai_voice_counts: true, conversation: FULL, elements: ELEMENTS, reason_type: "Unemployment" }, h.ctx);
  const out = r.output as { id: string; status: string; contacts_qrpc: boolean; plan_status: string | null };
  assert.equal(out.status, "qrpc_complete"); assert.equal(out.contacts_qrpc, true); assert.equal(out.plan_status, "ptp_pending");
  assert.equal(h.rt.store.require("qrpc_records", out.id).data.fnma_reason_code, "016"); assert.equal(h.rt.store.require("qrpc_records", out.id).data.status, "qrpc_complete");
  assert.equal(h.rt.store.require("contacts", "ct-1").data.qrpc, true);
  const types = h.ctx.events.all().map((e) => e.type);
  assert.ok(types.includes("contact.qrpc.captured")); assert.ok(types.includes("contact.qrpc.established"));
  const est = h.ctx.events.all().find((e) => e.type === "contact.qrpc.established")!; assert.equal(est.payload.reason_code, "016"); assert.equal(est.payload.commitment_kind, "promise_to_pay_full");
  const fnma = h.ctx.events.all().find((e) => e.type === "delinquency.servicer_action")!; assert.equal(fnma.payload.action, "Quality Right Party Contact"); assert.equal(fnma.payload.legacy_status_code, "AW"); assert.equal(fnma.payload.reason_code, "016");
  // the 11.1 plan ceases per the commitment (D2-2-02: promise to pay by a specified date)
  const plan = newPlan("L-11"); openPlanIfDue(plan, 40, D("2026-12-11"));
  const c = applyQrpc(plan, { on: D("2026-12-11"), commitment: "promise_to_pay_full", promise_valid: true });
  assert.equal(c.ceased, true); assert.equal(c.plan_status, "ceased{ptp_pending}"); assert.ok(c.events.some((e) => e.type === "contact.plan.ceased" && e.payload.reason === "ptp_pending"));
  assert.deepEqual(c.events.find((e) => e.type === "contact.plan.ceased")!.payload.cancel_timers, ["FNMA_D2202_OUTBOUND_EVERY_7", "FNMA_D2202_OUTBOUND_START_36", "FNMA_D2202_CONTINUE_AFTER_210"]);
  // the bus did the same at the command boundary: `contact.plan.ceased{ptp_pending, cancel_timers}` was appended and the loan's armed
  // FNMA_D2202_OUTBOUND_EVERY_7 instance (restored into the unit of work) was cancelled, so no cadence breach follows the QRPC
  const ceased = h.ctx.events.all().find((e) => e.type === "contact.plan.ceased")!; assert.equal(ceased.payload.reason, "ptp_pending"); assert.ok((ceased.payload.cancel_timers as string[]).includes("FNMA_D2202_OUTBOUND_EVERY_7"));
  const h2 = harness(); const inst = { id: "t-every7", code: "FNMA_D2202_OUTBOUND_EVERY_7", subject: { kind: "loan", id: "L-11" }, loanId: "L-11", armedAt: "2026-12-07T15:00:00.000Z", armedByEventId: "e-1", anchorDate: D("2026-12-07"), dueDate: D("2026-12-14"), dueAt: Date.parse("2026-12-15T04:59:00.000Z"), status: "armed" as const };
  h2.ctx.timers.restore([inst]);
  await h2.bus.execute(h2.cmd, h2.comms, { loan_id: "L-11", contact_id: "ct-1b", ai_voice_counts: true, conversation: FULL, elements: ELEMENTS, reason_type: "Unemployment" }, h2.ctx);
  assert.equal(h2.ctx.timers.byCode("FNMA_D2202_OUTBOUND_EVERY_7")[0]!.status, "cancelled"); assert.match(h2.ctx.timers.byCode("FNMA_D2202_OUTBOUND_EVERY_7")[0]!.cancelledReason ?? "", /ptp_pending/);
  assert.ok(h2.ctx.events.all().some((e) => e.type === "timer.cancelled" && e.payload.code === "FNMA_D2202_OUTBOUND_EVERY_7"));
});
test("11.3-T2: Given the borrower hangs up after giving the reason and occupancy only, then the record is `conversation_only`, no QRPC event fires, and the next attempt targets ability/commitment.", async () => {
  const h = harness();
  const r = await h.bus.execute(h.cmd, h.comms, { loan_id: "L-11", contact_id: "ct-2", ai_voice_counts: true, conversation: { verified_party: "borrower", reason_primary: "unemployment", occupancy_status: "borrower_occupied_principal" }, elements: { reason: ELEMENTS.reason, occupancy: ELEMENTS.occupancy } }, h.ctx);
  const out = r.output as { status: string; missing: string[]; next_attempt_targets: string[]; contacts_qrpc: boolean };
  assert.equal(out.status, "conversation_only"); assert.equal(out.contacts_qrpc, false);
  assert.deepEqual(out.missing, ["ability_to_pay", "options", "commitment", "payment_importance"]); assert.deepEqual(out.next_attempt_targets, ["ability_to_pay", "options", "commitment"]);
  assert.ok(!h.ctx.events.all().some((e) => e.type === "contact.qrpc.established")); assert.ok(!h.ctx.events.all().some((e) => e.type === "delinquency.servicer_action"));
  assert.equal(h.ctx.events.all().find((e) => e.type === "contact.qrpc.captured")!.payload.status, "conversation_only");
  assert.deepEqual([...nextAttemptTargets(qrpcCompleteness({ verified_party: "borrower", reason_primary: "unemployment", occupancy_status: "principal" }).missing)], ["ability_to_pay", "options", "commitment"]);
});
test("11.3-T3: Given the reason \"lost my job in October,\" then `reason_primary=unemployment`, `fnma_reason_code=016`, `hardship_started_on=2026-10-xx`, nature per borrower's statement.", () => {
  const r = extractHardship("I lost my job in October and I'm still looking.", D("2026-12-11"), { evidence_span: "00:41-00:52" });
  assert.equal(r.reason_primary, "unemployment"); assert.equal(r.fnma_reason_code, "016"); assert.match(r.hardship_started_on!, /^2026-10-/); assert.equal(r.hardship_nature, "unknown"); assert.equal(r.evidence_span, "00:41-00:52");
  assert.equal(extractHardship("I lost my job in October, but I start a new job in January so it's temporary.", D("2026-12-11")).hardship_nature, "temporary");
  assert.equal(extractHardship("I lost my job in October and I'm retired now, this is permanent.", D("2026-12-11")).hardship_nature, "permanent");
  assert.equal(extractHardship("My hours were cut in October.", D("2026-12-11")).fnma_reason_code, "006");
  assert.equal(extractHardship("I'd rather not say.", D("2026-12-11")).reason_primary, "declined");
});
test("11.3-T4: Given a promise of $4,165.00 by 2026-12-28 recorded 2026-12-11, then `FNMA_D2202_PTP_MAX_30` passes and the plan is `ceased{ptp_pending}`; given a promise of $2,000.00, then `covers=partial` and the plan schedules the next attempt for 2026-12-29.", async () => {
  // the ledger's figure: 2 × $2,000.00 + 2 × $82.50 (5 % of $1,650.00 P&I, 2.x) = $4,165.00 (both late charges assessed — see the 11.1 worked figures)
  const total = 2n * 200000n + 2n * lateChargeAmount(165000n, "5", null); assert.equal(total, 416500n);
  const full = promiseToPay(416500n, D("2026-12-28"), D("2026-12-11"), total);
  assert.deepEqual(full, { valid: true, covers: "full", within_30: true, plan: "ceased{ptp_pending}" });
  assert.equal(evaluateGate("11.3.promiseWithin30Days", { recorded_on: "2026-12-11", due_on: "2026-12-28" }).open, true);
  const plan = newPlan("L-11"); openPlanIfDue(plan, 40, D("2026-12-11"));
  assert.equal(applyQrpc(plan, { on: D("2026-12-11"), commitment: "promise_to_pay_full", promise_valid: full.valid }).plan_status, "ceased{ptp_pending}");
  const partial = promiseToPay(200000n, D("2026-12-28"), D("2026-12-11"), total);
  assert.equal(partial.covers, "partial"); assert.equal(partial.valid, false); assert.equal(partial.plan, "active"); assert.equal(partial.next_attempt_on, D("2026-12-29"));
  const plan2 = newPlan("L-11"); openPlanIfDue(plan2, 40, D("2026-12-11"));
  const stays = applyQrpc(plan2, { on: D("2026-12-11"), commitment: "promise_to_pay_partial" }); assert.equal(stays.ceased, false); assert.equal(planState(plan2), "active");
  assert.deepEqual(cessationOnQrpc("promise_to_pay_partial"), { plan_status: "active", commitment_kind: "promise_to_pay_partial" });
  assert.equal(evaluateGate("11.3.cessationOnQrpc", { plan_status: "active", commitment_kind: "promise_to_pay_partial" }).open, true);
  assert.equal(evaluateGate("11.3.cessationOnQrpc", { plan_status: "active", commitment_kind: "promise_to_pay_full" }).open, false);
  // through the bus: `promise.record` emits `borrower.promise_to_pay.recorded{recorded_on, due_on}` — FNMA_D2202_PTP_MAX_30 arms as the evaluator gate
  // 11.3.promiseWithin30Days (17 days: open) and FNMA_D2202_PTP_FOLLOWUP_30 anchors on the promise date 2026-12-28 (11.1: checked 00:05 the next day)
  const h = gatedHarness("promise.record");
  const p = await h.run("promise.record", { loan_id: "L-11", amount_cents: "416500", due_on: "2026-12-28", recorded_on: "2026-12-11", total_delinquent_cents: "416500" });
  assert.equal(p.valid, true); assert.equal(p.covers, "full"); assert.equal(p.plan, "ceased{ptp_pending}"); assert.equal(h.rt.store.require("promises", p.id as string).data.amount_cents, 416500n);
  const rec = h.ev("borrower.promise_to_pay.recorded")[0]!; assert.equal(rec.payload.due_on, "2026-12-28"); assert.equal(rec.payload.recorded_on, "2026-12-11"); assert.equal(rec.payload.amount_cents, 416500n);
  assert.ok(eventMatches(h.registry.get("FNMA_D2202_PTP_MAX_30")!.triggerPattern!, rec));
  const max = h.ctx.timers.byCode("FNMA_D2202_PTP_MAX_30"); assert.equal(max.length, 1); assert.equal(max[0]!.status, "armed"); assert.equal(max[0]!.note, "evaluator:11.3.promiseWithin30Days"); assert.equal(max[0]!.dueAt, undefined);
  assert.equal(evaluateGate("11.3.promiseWithin30Days", { recorded_on: rec.payload.recorded_on, due_on: rec.payload.due_on }).open, true);
  // the same event arms 11.1's FNMA_D2202_PTP_FOLLOWUP_30 on the promise date (11.1-T17 drives that clock; the 11.3-scoped engine here does not arm 11.1 rows): the trigger matches and the anchor field is `due_on`
  assert.ok(eventMatches(h.registry.get("FNMA_D2202_PTP_FOLLOWUP_30")!.triggerPattern!, rec)); assert.equal(h.registry.get("FNMA_D2202_PTP_FOLLOWUP_30")!.anchorField, "due_on"); assert.equal(h.ctx.timers.byCode("FNMA_D2202_PTP_FOLLOWUP_30").length, 0);
  assert.deepEqual(h.ctx.timers.evaluate("2026-12-28T04:59:00.000Z").map((b) => b.instance.code), []);
  // the partial promise is recorded too (`covers=partial`), but the cadence continues: the plan stays active and the next attempt is 2026-12-29
  const part = await h.run("promise.record", { loan_id: "L-11", amount_cents: "200000", due_on: "2026-12-28", recorded_on: "2026-12-11", total_delinquent_cents: "416500" });
  assert.equal(part.covers, "partial"); assert.equal(part.valid, false); assert.equal(part.plan, "active"); assert.equal(part.next_attempt_on, D("2026-12-29")); assert.equal(h.ev("borrower.promise_to_pay.recorded")[1]!.payload.covers, "partial");
  const late = await h.run("promise.record", { loan_id: "L-11", amount_cents: "416500", due_on: "2027-01-15", recorded_on: "2026-12-11", total_delinquent_cents: "416500" });
  assert.equal(late.within_30, false); assert.equal(late.valid, false); assert.equal(evaluateGate("11.3.promiseWithin30Days", { recorded_on: "2026-12-11", due_on: "2027-01-15" }).open, false);
});
test("11.3-T5: Given a caller claiming to be the borrower's sister with no authorization, then no account details are disclosed, the authorization form is offered, and no QRPC is recorded.", async () => {
  const r = thirdPartyCall({ claimed_relation: "sister", authorization_valid: false });
  assert.equal(r.disclose_account_details, false); assert.equal(r.offer, "FRM_SM_THIRD_PARTY_AUTH"); assert.equal(r.qrpc_recorded_allowed, false); assert.equal(r.outcome, "answered_unverified_third_party");
  // through the bus: `identity.verify` starts the third-party conversation — `contact.started{party_role=trusted_advisor}` arms SM_THIRD_PARTY_AUTH_GATE
  // (evaluator 11.3.thirdPartyAuthorized) and the gate is closed: NPI withheld, general information and the authorization form only
  const h = gatedHarness("identity.verify", "qrpc.capture");
  const out = await h.run("identity.verify", { loan_id: "L-11", contact_id: "ct-5", factors: { name: "Jane Doe", last4: "1234" }, expected: { name: "Jane Doe", last4: "1234" }, claimed_relation: "sister", on: "2026-12-11" });
  const tp = out.third_party as Record<string, unknown>;
  assert.equal(out.account_details_allowed, false); assert.equal(tp.disclose_account_details, false); assert.equal(tp.npi_withheld, true); assert.equal(tp.general_information_only, true); assert.equal(tp.offer, "FRM_SM_THIRD_PARTY_AUTH"); assert.equal(tp.qrpc_recorded_allowed, false); assert.equal(tp.outcome, "answered_unverified_third_party"); assert.equal(tp.open, false);
  const started = h.ev("contact.started")[0]!; assert.equal(started.payload.party_role, "trusted_advisor"); assert.equal(started.payload.claimed_relation, "sister"); assert.equal(started.payload.authorization_valid_unexpired, false); assert.equal(started.payload.in_call_consent_recorded, false); assert.equal(started.payload.open, false);
  assert.ok(eventMatches(h.registry.get("SM_THIRD_PARTY_AUTH_GATE")!.triggerPattern!, started));
  const gate = h.ctx.timers.byCode("SM_THIRD_PARTY_AUTH_GATE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.note, "evaluator:11.3.thirdPartyAuthorized"); assert.equal(gate[0]!.dueAt, undefined);
  assert.equal(evaluateGate("11.3.thirdPartyAuthorized", { authorization_valid_unexpired: false, in_call_consent_recorded: false }).open, false);
  // no QRPC is recorded from an unverified/unauthorized party
  await assert.rejects(h.bus.execute(h.cmd("qrpc.capture"), h.comms, { loan_id: "L-11", contact_id: "ct-5", ai_voice_counts: true, conversation: { ...FULL, verified_party: "unverified" }, elements: ELEMENTS }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_UNVERIFIED_THIRD_PARTY");
  assert.equal(h.ev("contact.qrpc.established").length, 0); assert.equal(h.rt.store.list("qrpc_records").length, 0);
  // the same caller with an unexpired authorization on file opens the gate (rule 4); an expired one does not
  const ok = await h.run("identity.verify", { loan_id: "L-11", contact_id: "ct-5b", factors: { name: "Jane Doe", last4: "1234" }, expected: { name: "Jane Doe", last4: "1234" }, claimed_relation: "sister", party_role: "authorized_third_party", authorization: { id: "auth-1", scope: "discuss_only", expires_on: "2027-03-11" }, on: "2026-12-11" });
  assert.equal((ok.third_party as Record<string, unknown>).open, true); assert.equal((ok.third_party as Record<string, unknown>).disclose_account_details, true); assert.equal(h.ev("contact.started")[1]!.payload.party_role, "authorized_third_party"); assert.equal(h.ev("contact.started")[1]!.payload.authorization_valid_unexpired, true);
  const expired = await h.run("identity.verify", { loan_id: "L-11", contact_id: "ct-5c", factors: { name: "Jane Doe", last4: "1234" }, expected: { name: "Jane Doe", last4: "1234" }, claimed_relation: "sister", authorization: { id: "auth-0", scope: "discuss_only", expires_on: "2026-12-10" }, on: "2026-12-11" });
  assert.equal((expired.third_party as Record<string, unknown>).open, false); assert.equal((expired.third_party as Record<string, unknown>).offer, "FRM_SM_THIRD_PARTY_AUTH");
});
test("11.3-T6: Given a three-way call where the verified borrower authorizes a HUD counselor, then a 90-day `discuss_only` authorization is recorded and the counselor may complete QRPC.", async () => {
  const r = threeWayAuthorization({ borrower_verified: true, on: D("2026-12-11"), party: "hud_counselor" })!;
  assert.equal(r.scope, "discuss_only"); assert.equal(r.expires_on, D("2027-03-11")); assert.equal(r.may_complete_qrpc, true); assert.equal(r.party_role, "trusted_advisor");
  assert.equal(threeWayAuthorization({ borrower_verified: false, on: D("2026-12-11"), party: "hud_counselor" }), null);
  // through the bus: `authorization.record{oral_three_way}` records the 90-day discuss_only authorization and opens the advisor's conversation —
  // `contact.started{party_role=trusted_advisor, in_call_consent_recorded=true}` arms SM_THIRD_PARTY_AUTH_GATE and the gate is open, so the counselor completes QRPC
  const h = gatedHarness("authorization.record", "qrpc.capture");
  await assert.rejects(h.bus.execute(h.cmd("authorization.record"), h.comms, { loan_id: "L-11", party_id: "p-counselor", kind: "oral_three_way", on: "2026-12-11", party: "hud_counselor" }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "ORAL_NEEDS_VERIFIED_BORROWER");
  const a = await h.run("authorization.record", { loan_id: "L-11", contact_id: "ct-6", party_id: "p-counselor", kind: "oral_three_way", on: "2026-12-11", party: "hud_counselor", borrower_verified: true, recorded_document_id: "rec-6" });
  assert.equal(a.scope, "discuss_only"); assert.equal(a.expires_on, D("2027-03-11")); assert.equal(a.recorded_document_id, "rec-6");
  const conv = a.conversation as Record<string, unknown>; assert.equal(conv.gate, "SM_THIRD_PARTY_AUTH_GATE"); assert.equal(conv.open, true); assert.equal(conv.in_call_consent_recorded, true); assert.equal(conv.may_complete_qrpc, true); assert.equal(conv.disclose_account_details, true); assert.equal(conv.outcome, "authorized_third_party");
  const started = h.ev("contact.started")[0]!; assert.equal(started.payload.party_role, "trusted_advisor"); assert.equal(started.payload.in_call_consent_recorded, true); assert.equal(started.payload.authorization_valid_unexpired, true); assert.equal(started.payload.authorization_id, a.id); assert.equal(started.payload.open, true);
  assert.ok(eventMatches(h.registry.get("SM_THIRD_PARTY_AUTH_GATE")!.triggerPattern!, started)); assert.equal(h.ctx.timers.byCode("SM_THIRD_PARTY_AUTH_GATE")[0]!.status, "armed");
  assert.equal(evaluateGate("11.3.thirdPartyAuthorized", { authorization_valid_unexpired: false, in_call_consent_recorded: true }).open, true);
  const q = await h.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-6", ai_voice_counts: true, conversation: { ...FULL, verified_party: "authorized_third_party" }, elements: ELEMENTS, party_role: "trusted_advisor", authorization_id: a.id });
  assert.equal(q.status, "qrpc_complete"); assert.equal(q.contacts_qrpc, true); assert.equal(h.ev("contact.qrpc.established").length, 1);
});
test("11.3-T7: Given the flag is off for the state, then the AI record is `pending_human_verification`, `SM_QRPC_HUMAN_VERIFY_1BD` runs, and only `qrpc_verified` emits `contact.qrpc.established`.", async () => {
  const r = qrpcRecordStatus({ complete: true, ai_voice_counts: false, achieved_on: D("2026-12-11") });
  assert.equal(r.status, "pending_human_verification"); assert.deepEqual(r.timer, { code: "SM_QRPC_HUMAN_VERIFY_1BD", due: D("2026-12-14") }); assert.deepEqual([...r.events], ["contact.qrpc.captured{human_verification_required=true}"]);
  assert.deepEqual(humanVerify("qrpc_verified"), { status: "qrpc_verified", events: ["contact.qrpc.reviewed", "contact.qrpc.established"], task: null });
  assert.deepEqual(humanVerify("qrpc_rejected"), { status: "qrpc_rejected", events: ["contact.qrpc.reviewed"], task: "human_call" });
  assert.deepEqual([...qrpcRecordStatus({ complete: true, ai_voice_counts: true, achieved_on: D("2026-12-11") }).events], ["contact.qrpc.established"]);
  // through the bus: the capture arms the 1-BD verification; a human_agent's verification emits the QRPC event
  const h = harness();
  const cap = await h.bus.execute(h.cmd, h.comms, { loan_id: "L-11", contact_id: "ct-7", ai_voice_counts: false, conversation: FULL, elements: ELEMENTS }, h.ctx);
  const id = (cap.output as { id: string; status: string }).id; assert.equal((cap.output as { status: string }).status, "pending_human_verification");
  assert.equal(h.ctx.events.all().find((e) => e.type === "contact.qrpc.captured")!.payload.human_verification_required, true); assert.ok(!h.ctx.events.all().some((e) => e.type === "contact.qrpc.established"));
  const human: Actor = { kind: "human", id: "u-agent", role: "human_agent" };
  await h.bus.execute(h.cmd, human, { op: "human_verify", loan_id: "L-11", contact_id: "ct-7", id, outcome: "qrpc_verified", reviewer_id: "u-agent" }, h.ctx);
  assert.equal(h.ctx.events.all().find((e) => e.type === "contact.qrpc.reviewed")!.payload.outcome, "qrpc_verified"); assert.ok(h.ctx.events.all().some((e) => e.type === "contact.qrpc.established"));
  // the registry: `contact.qrpc.captured{human_verification_required=true}` arms SM_QRPC_HUMAN_VERIFY_1BD anchored on achieved_at (Fri 2026-12-11) due 1 servicer
  // business day later (Mon 2026-12-14, 23:59 ET); `contact.qrpc.reviewed{outcome=qrpc_verified}` satisfies it — a rejection satisfies it too (with the human call task)
  const g = gatedHarness("qrpc.capture");
  const cap2 = await g.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-7b", ai_voice_counts: false, conversation: FULL, elements: ELEMENTS });
  assert.ok(eventMatches(g.registry.get("SM_QRPC_HUMAN_VERIFY_1BD")!.triggerPattern!, g.ev("contact.qrpc.captured")[0]!));
  const t = g.ctx.timers.byCode("SM_QRPC_HUMAN_VERIFY_1BD"); assert.equal(t.length, 1); assert.equal(t[0]!.status, "armed"); assert.equal(t[0]!.anchorDate, D("2026-12-11")); assert.equal(t[0]!.dueDate, D("2026-12-14"));
  assert.deepEqual(g.ctx.timers.evaluate("2026-12-14T04:59:00.000Z").map((b) => b.instance.code), []); assert.equal(g.ev("contact.qrpc.established").length, 0); assert.equal(g.ev("delinquency.servicer_action").length, 0);
  await g.bus.execute(g.cmd("qrpc.capture"), human, { op: "human_verify", loan_id: "L-11", contact_id: "ct-7b", id: cap2.id, outcome: "qrpc_verified", reviewer_id: "u-agent" }, g.ctx);
  assert.equal(g.ctx.timers.byCode("SM_QRPC_HUMAN_VERIFY_1BD")[0]!.status, "satisfied"); assert.equal(g.ev("contact.qrpc.established").length, 1); assert.equal(g.ev("contact.qrpc.established")[0]!.payload.verified_by, "u-agent"); assert.equal(g.rt.store.require("contacts", "ct-7b").data.qrpc, true);
  const rej = gatedHarness("qrpc.capture"); const cap3 = await rej.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-7c", ai_voice_counts: false, conversation: FULL, elements: ELEMENTS });
  const r3 = await rej.bus.execute(rej.cmd("qrpc.capture"), human, { op: "human_verify", loan_id: "L-11", contact_id: "ct-7c", id: cap3.id, outcome: "qrpc_rejected", reviewer_id: "u-agent", rejected_elements: ["ability_to_pay"] }, rej.ctx);
  assert.equal((r3.output as { task: string | null }).task, "human_call"); assert.equal(rej.ctx.timers.byCode("SM_QRPC_HUMAN_VERIFY_1BD")[0]!.status, "satisfied"); assert.equal(rej.ev("contact.qrpc.established").length, 0); assert.ok(rej.ev("escalation.created").some((e) => e.payload.kind === "human_agent" && e.payload.task === "human_call"));
});
test("11.3-T8: Given QRPC on 2026-10-20 with no resolution, then the November delinquency file shows AW effective 20261020 with reason 016 (5.7 example) and AW is not repeated in December.", () => {
  const rows = awReporting({ qrpc_on: D("2026-10-20"), reason: "unemployment", report_months: ["2026-11", "2026-12"] });
  assert.deepEqual(rows[0], { month: "2026-11", status: "AW", effective: "20261020", reason_code: "016" });
  assert.deepEqual(rows[1], { month: "2026-12", status: null, effective: null, reason_code: null });
});
test("11.3-T9: Given a borrower who says \"I'll pay it all Friday,\" then no options pitch is required (comment 39(a)-4 logic recorded), the promise is captured, and the options-explained determination is `not_appropriate:full_payment_promised`.", () => {
  const d = optionsDetermination({ commitment: "promise_to_pay_full", promised_full_by: D("2026-12-18") });
  assert.equal(d.required, false); assert.equal(d.determination, "not_appropriate:full_payment_promised"); assert.deepEqual([...d.options_explained], []);
  const promise = promiseToPay(416500n, D("2026-12-18"), D("2026-12-11"), 416500n); assert.equal(promise.valid, true); assert.equal(promise.plan, "ceased{ptp_pending}");
  const c = qrpcCompleteness({ verified_party: "borrower", reason_primary: "reduction_in_income", hardship_nature: "temporary", occupancy_status: "borrower_occupied_principal", ability_to_pay: { can_resume_full_payment_on: D("2026-12-18") }, options_explained: null, options_not_appropriate_reason: d.determination, commitment_kind: "promise_to_pay_full", payment_importance_emphasized: true });
  assert.equal(c.complete, true);
  assert.equal(optionsDetermination({ commitment: "promise_to_pay_partial", promised_full_by: null }).required, true);
});
test('11.3-T10: Given the borrower asks "what rate would a modification give me?" in a state with `mlo_licensing_for_lossmit=true`, then the AI declines to quote terms and warm-transfers to `licensed_specialist`; the transcript shows no terms.', async () => {
  const r = licensedNegotiationGate({ question: "what rate would a modification give me?", mlo_licensing_for_lossmit: true });
  assert.equal(r.asks_terms, true); assert.equal(r.decline_quote, true); assert.equal(r.warm_transfer, "licensed_specialist"); assert.doesNotMatch(r.response, /\d|%/);
  assert.equal(licensedNegotiationGate({ question: "what rate would a modification give me?", mlo_licensing_for_lossmit: false }).decline_quote, false);
  // through the bus: the AI answers term questions from `lossmit_facts.get` — the question appends `contact.modification_terms.discussed{mlo_licensing_for_lossmit=true,
  // licensed_specialist_on_call=false}` (arms SM_LICENSED_NEGOTIATION_GATE, evaluator 11.3.licensedNegotiator), the gate is closed, the facts are withheld and the warm transfer starts
  const h = gatedHarness("lossmit_facts.get", "decision.record");
  h.rt.store.put("lossmit_facts", "lf-L-11", { loan_id: "L-11", options: ["repayment plan", "forbearance", "loan modification (Flex Modification)"], version: "v7" }, h.comms, h.ctx.clock.now());
  const out = await h.run("lossmit_facts.get", { loan_id: "L-11", contact_id: "ct-10", where: { loan_id: "L-11" }, borrower_question: "what rate would a modification give me?", mlo_licensing_for_lossmit: true, state: "XX" });
  assert.equal(out.gate, "SM_LICENSED_NEGOTIATION_GATE"); assert.equal(out.open, false); assert.equal(out.asks_terms, true); assert.equal(out.decline_quote, true); assert.equal(out.warm_transfer, "licensed_specialist"); assert.equal(out.terms_withheld, true); assert.equal(out.facts, null); assert.equal(out.terms_quoted, false); assert.doesNotMatch(String(out.response), /\d|%/);
  const discussed = h.ev("contact.modification_terms.discussed")[0]!; assert.equal(discussed.payload.mlo_licensing_for_lossmit, true); assert.equal(discussed.payload.licensed_specialist_on_call, false); assert.equal(discussed.payload.open, false); assert.equal(discussed.payload.terms_quoted, false);
  assert.ok(eventMatches(h.registry.get("SM_LICENSED_NEGOTIATION_GATE")!.triggerPattern!, discussed));
  const gate = h.ctx.timers.byCode("SM_LICENSED_NEGOTIATION_GATE"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.note, "evaluator:11.3.licensedNegotiator");
  const transfer = h.ev("contact.human_transfer.started")[0]!; assert.equal(transfer.payload.target, "licensed_specialist"); assert.equal(transfer.payload.reason, "SM_LICENSED_NEGOTIATION_GATE"); assert.equal(transfer.payload.start_within_s, 10);
  assert.equal(evaluateGate("11.3.licensedNegotiator", { mlo_licensing_for_lossmit: true, licensed_specialist_on_call: false }).open, false);
  // the transcript shows no terms: a decision record that quoted terms in the licensed state is refused
  await assert.rejects(h.bus.execute(h.cmd("decision.record"), h.comms, { loan_id: "L-11", action: "qrpc.conversation", rationale: "terms", borrower_question: "what rate would a modification give me?", mlo_licensing_for_lossmit: true, terms_quoted: true }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_NEGOTIATION_WHERE_LICENSED");
  // the gate is open where lossmit is not licensed activity, or with a licensed specialist on the call: the facts are returned and no transfer starts
  const open = await h.run("lossmit_facts.get", { loan_id: "L-11", contact_id: "ct-10b", where: { loan_id: "L-11" }, borrower_question: "what rate would a modification give me?", mlo_licensing_for_lossmit: false });
  assert.equal(open.open, true); assert.equal(open.decline_quote, false); assert.equal(open.warm_transfer, null); assert.deepEqual((open.facts as { version: string }[]).map((f) => f.version), ["v7"]);
  const specialist = await h.run("lossmit_facts.get", { loan_id: "L-11", contact_id: "ct-10c", where: { loan_id: "L-11" }, borrower_question: "what rate would a modification give me?", mlo_licensing_for_lossmit: true, licensed_specialist_on_call: true });
  assert.equal(specialist.open, true); assert.equal(specialist.decline_quote, false);
  assert.equal(h.ev("contact.modification_terms.discussed").length, 3); assert.equal(h.ev("contact.human_transfer.started").length, 1); assert.equal(h.ctx.timers.byCode("SM_LICENSED_NEGOTIATION_GATE").length, 3);
  // a question that does not raise terms is not a discussion of terms — nothing is appended
  const plain = await h.run("lossmit_facts.get", { loan_id: "L-11", where: { loan_id: "L-11" }, borrower_question: "what help is there?", mlo_licensing_for_lossmit: true });
  assert.equal(plain.asks_terms, false); assert.equal(plain.decline_quote, false); assert.equal(h.ev("contact.modification_terms.discussed").length, 3);
});
test('11.3-T11: Given a disaster hardship in a FEMA IA county, then the event-rail reason type is "Disaster Impact – FEMA-declared IA area" and "Property Problem" is not also set.', async () => {
  const r = disasterReasonType({ fema_ia_county: true });
  assert.equal(r.reason_type, "Disaster Impact – FEMA-declared IA area"); assert.equal(r.property_problem_set, false); assert.equal(r.fnma_reason_code, "019");
  assert.equal(disasterReasonType({ fema_ia_county: false }).reason_type, "Casualty Loss");
  assert.equal(qrpcReasonType("disaster", { fema_ia_county: true }), "Disaster Impact – FEMA-declared IA area"); assert.equal(qrpcReasonType("disaster", { fema_ia_county: false }), "Casualty Loss"); assert.equal(qrpcReasonType("property_problem"), "Property Problem"); assert.equal(qrpcReasonType("declined"), "Borrower Declined to Provide a Reason");
  // through the bus: the QRPC's 5.7 action event is built with the disaster reason type — `investor_events.building{family=qrpc, reason_type}` arms
  // FNMA_LL202605_QRPC_REASON_REQUIRED (evaluator 11.3.qrpcReasonPresent), the gate is open, and the event rail carries the one reason type (Property Problem not also set)
  const h = gatedHarness("qrpc.capture");
  const out = await h.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-11", ai_voice_counts: true, conversation: { ...FULL, reason_primary: "disaster" }, elements: { ...ELEMENTS, reason: { value: "disaster", evidence_span: "00:41-00:52" } }, fema_ia_county: true });
  assert.equal(out.status, "qrpc_complete"); assert.equal(out.fnma_reported, true); assert.equal(out.fnma_refused_by, null); assert.equal(out.fnma_reason_type, "Disaster Impact – FEMA-declared IA area");
  assert.equal(h.rt.store.require("qrpc_records", out.id as string).data.fnma_reason_type, "Disaster Impact – FEMA-declared IA area"); assert.equal(h.rt.store.require("qrpc_records", out.id as string).data.fnma_reason_code, "019");
  const building = h.ev("investor_events.building")[0]!; assert.equal(building.payload.family, "qrpc"); assert.equal(building.payload.action, "Quality Right Party Contact"); assert.equal(building.payload.reason_type, "Disaster Impact – FEMA-declared IA area");
  assert.ok(eventMatches(h.registry.get("FNMA_LL202605_QRPC_REASON_REQUIRED")!.triggerPattern!, building));
  const gate = h.ctx.timers.byCode("FNMA_LL202605_QRPC_REASON_REQUIRED"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.note, "evaluator:11.3.qrpcReasonPresent");
  const rail = h.ev("delinquency.servicer_action")[0]!; assert.equal(rail.payload.action, "Quality Right Party Contact"); assert.equal(rail.payload.reason_type, "Disaster Impact – FEMA-declared IA area"); assert.deepEqual(rail.payload.reason_types, ["Disaster Impact – FEMA-declared IA area"]); assert.ok(!(rail.payload.reason_types as string[]).includes("Property Problem")); assert.deepEqual(rail.payload.exclusive_with, ["Property Problem"]); assert.equal(rail.payload.reason_code, "019"); assert.equal(rail.payload.legacy_status_code, "AW"); assert.equal(rail.payload.effective_on, "2026-12-11");
  assert.equal(evaluateGate("11.3.qrpcReasonPresent", { reason_type: "Disaster Impact – FEMA-declared IA area" }).open, true); assert.equal(evaluateGate("11.3.qrpcReasonPresent", { reason_type: "" }).open, false);
  // outside a declared IA county the disaster is "Casualty Loss" — still never paired with "Property Problem"
  const cl = await h.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-11b", ai_voice_counts: true, conversation: { ...FULL, reason_primary: "disaster" }, elements: { ...ELEMENTS, reason: { value: "disaster", evidence_span: "00:41-00:52" } }, fema_ia_county: false });
  assert.equal(cl.fnma_reason_type, "Casualty Loss"); assert.deepEqual(h.ev("delinquency.servicer_action")[1]!.payload.reason_types, ["Casualty Loss"]);
  // a reason outside the taxonomy has no reason type: the build is refused (breach action — `default-collections` supplies declined / unable_to_contact) and no action event goes to 5.7
  const refused = await h.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-11c", ai_voice_counts: true, conversation: { ...FULL, reason_primary: "not_in_taxonomy" }, elements: { ...ELEMENTS, reason: { value: "not_in_taxonomy", evidence_span: "00:41-00:52" } } });
  assert.equal(refused.status, "qrpc_complete"); assert.equal(refused.fnma_reported, false); assert.equal(refused.fnma_refused_by, "FNMA_LL202605_QRPC_REASON_REQUIRED"); assert.equal(refused.fnma_reason_type, null);
  const rf = h.ev("investor_events.refused")[0]!; assert.equal(rf.payload.code, "FNMA_LL202605_QRPC_REASON_REQUIRED"); assert.equal(rf.payload.supplied_by, "default-collections"); assert.deepEqual(rf.payload.fallback, { declined: "Borrower Declined to Provide a Reason", unable_to_contact: "Unable to Contact Borrower" });
  assert.equal(h.ev("delinquency.servicer_action").length, 2); assert.equal(h.ev("investor_events.building").length, 3); assert.equal(h.ctx.timers.byCode("FNMA_LL202605_QRPC_REASON_REQUIRED").length, 3);
});
test("11.3-T12: Given QRPC achieved 2026-12-11 and no resolution by 2027-01-10, then `SM_QRPC_STALE_30` re-activates the plan and 13.4's pre-referral review shows QRPC age 30+ days.", async () => {
  const s = qrpcStaleness({ achieved_on: D("2026-12-11"), today: D("2027-01-10"), resolution_status: "none" });
  assert.equal(s.timer, "SM_QRPC_STALE_30"); assert.equal(s.stale_on, D("2027-01-10")); assert.equal(s.stale, true); assert.equal(s.qrpc_age_days, 30); assert.equal(s.plan_action, "re_activated"); assert.equal(s.resume_trigger, "qrpc_stale");
  assert.deepEqual(s.pre_referral_review, { latest_qrpc_on: D("2026-12-11"), qrpc_age_days: 30, shows: "QRPC age 30+ days" });
  assert.equal(isStale(D("2026-12-11"), D("2027-01-10"), false), true); assert.equal(isStale(D("2026-12-11"), D("2027-01-09"), false), false); assert.equal(isStale(D("2026-12-11"), D("2027-01-10"), true), false);
  assert.equal(qrpcStaleness({ achieved_on: D("2026-12-11"), today: D("2027-01-09"), resolution_status: "none" }).stale, false);
  assert.equal(qrpcStaleness({ achieved_on: D("2026-12-11"), today: D("2027-01-10"), resolution_status: "workout_in_progress" }).plan_action, "none");
  const plan = newPlan("L-11"); openPlanIfDue(plan, 40, D("2026-12-11")); applyQrpc(plan, { on: D("2026-12-11"), commitment: "no_interest" }); assert.equal(planState(plan), "ceased{qrpc_no_interest}");
  const ev = resume(plan, s.resume_trigger!, s.stale_on); assert.equal(planState(plan), "active"); assert.equal(ev[0]!.payload.trigger, "qrpc_stale");
  // the registry: `contact.qrpc.established` (qrpc.capture, commitment no_interest → resolution_status none) arms SM_QRPC_STALE_30 anchored on
  // achieved_at 2026-12-11, due +30 calendar days = 2027-01-10 (23:59 ET); nothing breaches on 2027-01-10, the 2027-01-11 00:05 run finds it stale
  const h = gatedHarness("qrpc.capture");
  const q = await h.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-12", ai_voice_counts: true, conversation: { ...FULL, commitment_kind: "no_interest", ability_to_pay: { commitment_kind: "no_interest" } }, elements: { ...ELEMENTS, commitment: { value: "no_interest", evidence_span: "03:10-03:25" } } });
  assert.equal(q.status, "qrpc_complete"); assert.equal(q.plan_status, "qrpc_no_interest");
  const est = h.ev("contact.qrpc.established")[0]!; assert.equal(est.payload.resolution_status, "none"); assert.equal(est.payload.achieved_at, "2026-12-11T18:05:00.000Z"); assert.ok(eventMatches(h.registry.get("SM_QRPC_STALE_30")!.triggerPattern!, est));
  const stale = h.ctx.timers.byCode("SM_QRPC_STALE_30"); assert.equal(stale.length, 1); assert.equal(stale[0]!.status, "armed"); assert.equal(stale[0]!.anchorDate, D("2026-12-11")); assert.equal(stale[0]!.dueDate, D("2027-01-10"));
  assert.ok(!h.ctx.timers.evaluate("2027-01-10T15:00:00.000Z").some((b) => b.instance.code === "SM_QRPC_STALE_30"));
  const breach = h.ctx.timers.evaluate("2027-01-11T05:05:00.000Z").find((b) => b.instance.code === "SM_QRPC_STALE_30")!; assert.ok(breach); assert.equal(breach.instance.status, "breached");
  assert.equal(qrpcStaleness({ achieved_on: stale[0]!.anchorDate, today: D("2027-01-11"), resolution_status: "none" }).plan_action, "re_activated");
});
test("11.3-T13: Given the extractor proposes `ability_to_pay=can_pay_by_date` with no transcript evidence span, then validation fails and the record is `conversation_only`.", () => {
  const r = validateExtraction({ reason: { value: "unemployment", evidence_span: "00:41-00:52" }, ability_to_pay: { value: "can_pay_by_date", evidence_span: null } });
  assert.equal(r.valid, false); assert.deepEqual([...r.missing_evidence], ["ability_to_pay"]); assert.equal(r.record_status, "conversation_only");
  assert.equal(validateExtraction({ reason: { value: "unemployment", evidence_span: "00:41-00:52" } }).record_status, "qrpc_candidate");
});
test("11.3-T14: Given a Chapter 13 debtor represented by counsel calls in, then the AI verifies, confines the discussion to information counsel permits per 14.x rules, and no QRPC is recorded without counsel's involvement.", () => {
  const r = representedDebtorCall({ chapter: 13, represented_by_counsel: true, counsel_involved: false });
  assert.equal(r.verify, true); assert.equal(r.discussion_scope, "counsel_permitted_information"); assert.equal(r.qrpc_recorded, false); assert.equal(r.route, "counsel");
  assert.equal(representedDebtorCall({ chapter: 13, represented_by_counsel: true, counsel_involved: true }).qrpc_recorded, true);
});

test("11.3 worked figures: promise $4,165.00 covers 2 × $2,000.00 + 2 × $82.50; $2,000.00 is partial", () => {
  const total = 2n * 200000n + 2n * lateChargeAmount(165000n, "5", null); assert.equal(total, 416500n); assert.equal(lateChargeAmount(165000n, "5", null), 8250n);
  assert.equal(promiseToPay(416500n, D("2026-12-28"), D("2026-12-11"), total).covers, "full"); assert.equal(promiseToPay(200000n, D("2026-12-28"), D("2026-12-11"), total).covers, "partial");
});

test("11.3 timers: SM_THIRD_PARTY_AUTH_GATE, SM_LICENSED_NEGOTIATION_GATE and FNMA_LL202605_QRPC_REASON_REQUIRED arm on the events ops-11-3.ts appends, with the facts their evaluators read", async () => {
  const ctx = gatedUow("L-11"); const gctx = { events: ctx.events, actor: { kind: "agent", id: "borrower-comms" } as Actor, now: ctx.clock.now(), loanId: "L-11" }; const registry = loadOverriddenRegistry();
  for (const code of ["SM_THIRD_PARTY_AUTH_GATE", "SM_LICENSED_NEGOTIATION_GATE", "FNMA_LL202605_QRPC_REASON_REQUIRED"]) { const def = registry.get(code)!; assert.equal(def.process, "11.3"); assert.equal(def.offsetParsed.kind, "evaluator"); }
  // third party: the trigger conditions on party_role; a borrower is not a third party (RangeError), and the evaluator's two facts ride on the event
  assert.throws(() => thirdPartyConversation(gctx, { loan_id: "L-11", party_role: "borrower" as never, on: D("2026-12-11") }), RangeError);
  const closed = thirdPartyConversation(gctx, { loan_id: "L-11", contact_id: "ct-t1", party_role: "trusted_advisor", claimed_relation: "sister", on: D("2026-12-11") });
  assert.equal(closed.open, false); assert.equal(closed.npi_withheld, true); assert.ok(eventMatches(registry.get("SM_THIRD_PARTY_AUTH_GATE")!.triggerPattern!, closed.event)); assert.equal(closed.event.payload.authorization_valid_unexpired, false); assert.equal(closed.event.payload.in_call_consent_recorded, false);
  const open = thirdPartyConversation(gctx, { loan_id: "L-11", contact_id: "ct-t2", party_role: "authorized_third_party", authorization: { id: "auth-9", scope: "negotiate", expires_on: null }, on: D("2026-12-11") });
  assert.equal(open.open, true); assert.equal(open.disclose_account_details, true); assert.equal(open.qrpc_recorded_allowed, true); assert.equal(open.event.payload.authorization_valid_unexpired, true);
  assert.equal(ctx.timers.byCode("SM_THIRD_PARTY_AUTH_GATE").length, 2); assert.ok(ctx.timers.byCode("SM_THIRD_PARTY_AUTH_GATE").every((t) => t.status === "armed" && t.note === "evaluator:11.3.thirdPartyAuthorized" && t.loanId === "L-11"));
  assert.equal(ctx.events.all().filter((e) => e.type === "timer.armed" && e.payload.code === "SM_THIRD_PARTY_AUTH_GATE").length, 2);
  // licensed negotiation: only a question that raises terms is a discussion of terms
  const none = modificationTermsDiscussed(gctx, { loan_id: "L-11", question: "how do I apply?", mlo_licensing_for_lossmit: true }); assert.equal(none.asks_terms, false); assert.deepEqual([...none.events], []);
  const neg = modificationTermsDiscussed(gctx, { loan_id: "L-11", contact_id: "ct-t3", question: "what would my payment be after a modification?", mlo_licensing_for_lossmit: true, state: "XX" });
  assert.equal(neg.open, false); assert.equal(neg.decline_quote, true); assert.equal(neg.warm_transfer, "licensed_specialist"); assert.doesNotMatch(neg.response, /\d|%/); assert.deepEqual(neg.events.map((e) => e.type), ["contact.modification_terms.discussed", "contact.human_transfer.started"]);
  assert.ok(eventMatches(registry.get("SM_LICENSED_NEGOTIATION_GATE")!.triggerPattern!, neg.events[0]!)); assert.equal(ctx.timers.byCode("SM_LICENSED_NEGOTIATION_GATE")[0]!.note, "evaluator:11.3.licensedNegotiator");
  const withSpecialist = modificationTermsDiscussed(gctx, { loan_id: "L-11", question: "what would my payment be after a modification?", mlo_licensing_for_lossmit: true, licensed_specialist_on_call: true }); assert.equal(withSpecialist.open, true); assert.equal(withSpecialist.warm_transfer, null); assert.equal(withSpecialist.events.length, 1);
  assert.equal(ctx.timers.byCode("SM_LICENSED_NEGOTIATION_GATE").length, 2);
  // QRPC reason required: the build appends the trigger with the reason type, then the 5.7 action event (or a refusal)
  assert.throws(() => buildQrpcInvestorEvent(gctx, { loan_id: "", qrpc_id: "q", reason_primary: "unemployment", achieved_on: "2026-12-11" }), RangeError);
  const built = buildQrpcInvestorEvent(gctx, { loan_id: "L-11", qrpc_id: "qrpc-t", reason_primary: "unemployment", achieved_on: "2026-12-11" });
  assert.equal(built.built, true); assert.equal(built.reason_code, "016"); assert.equal(built.reason_type, "Unemployment"); assert.deepEqual(built.events.map((e) => e.type), ["investor_events.building", "delinquency.servicer_action"]);
  assert.ok(eventMatches(registry.get("FNMA_LL202605_QRPC_REASON_REQUIRED")!.triggerPattern!, built.events[0]!)); assert.equal(built.events[0]!.payload.reason_type, "Unemployment"); assert.equal(built.events[1]!.payload.effective_on, "2026-12-11"); assert.equal(built.events[1]!.payload.legacy_status_code, "AW");
  const declined = buildQrpcInvestorEvent(gctx, { loan_id: "L-11", qrpc_id: "qrpc-d", reason_primary: "declined", achieved_on: "2026-12-11" }); assert.equal(declined.reason_type, "Borrower Declined to Provide a Reason"); assert.equal(declined.reason_code, "015");
  const explicit = buildQrpcInvestorEvent(gctx, { loan_id: "L-11", qrpc_id: "qrpc-e", reason_primary: "unemployment", reason_type: "Unemployment", achieved_on: "2026-12-11" }); assert.equal(explicit.built, true);
  const refused = buildQrpcInvestorEvent(gctx, { loan_id: "L-11", qrpc_id: "qrpc-r", reason_primary: null, achieved_on: "2026-12-11" });
  assert.equal(refused.built, false); assert.equal(refused.refused_by, "FNMA_LL202605_QRPC_REASON_REQUIRED"); assert.deepEqual(refused.events.map((e) => e.type), ["investor_events.building", "investor_events.refused"]); assert.equal(refused.fallback!.declined, "Borrower Declined to Provide a Reason");
  assert.equal(ctx.timers.byCode("FNMA_LL202605_QRPC_REASON_REQUIRED").length, 4); assert.ok(ctx.timers.byCode("FNMA_LL202605_QRPC_REASON_REQUIRED").every((t) => t.status === "armed" && t.note === "evaluator:11.3.qrpcReasonPresent"));
  // gates have no due date: nothing breaches at any later instant
  assert.deepEqual(ctx.timers.evaluate("2027-12-31T23:59:00.000Z").map((b) => b.instance.code), []);
  // the flag-off path (T7): human verification also reports the record to 5.7 through the same build
  const h = gatedHarness("qrpc.capture");
  const cap = await h.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-t7", ai_voice_counts: false, conversation: FULL, elements: ELEMENTS });
  assert.equal(cap.status, "pending_human_verification"); assert.equal(h.ev("investor_events.building").length, 0);
  await h.bus.execute(h.cmd("qrpc.capture"), { kind: "human", id: "u-agent", role: "human_agent" } as Actor, { op: "human_verify", loan_id: "L-11", contact_id: "ct-t7", id: cap.id, outcome: "qrpc_verified", reviewer_id: "u-agent" }, h.ctx);
  assert.equal(h.ev("contact.qrpc.established").length, 1); assert.equal(h.ev("investor_events.building").length, 1); assert.equal(h.ev("delinquency.servicer_action")[0]!.payload.reason_type, "Unemployment"); assert.equal(h.ev("delinquency.servicer_action")[0]!.payload.reason_code, "016");
  assert.equal(h.ctx.timers.byCode("SM_QRPC_HUMAN_VERIFY_1BD")[0]!.status, "satisfied"); assert.equal(h.ctx.timers.byCode("FNMA_LL202605_QRPC_REASON_REQUIRED")[0]!.status, "armed");
});

test("11.3 guardrails: no financial-detail demands — qrpc.capture and decision.record refuse a statement that requires income/expense figures (11.3-Q5: figures are volunteered; the BRP is the documented path)", async () => {
  const h = gatedHarness("qrpc.capture", "decision.record");
  const demand = "Before we can help you must provide your pay stubs and bank statements.";
  await assert.rejects(h.bus.execute(h.cmd("qrpc.capture"), h.comms, { loan_id: "L-11", contact_id: "ct-g1", ai_voice_counts: true, conversation: FULL, elements: ELEMENTS, statements_made: [demand] }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_FINANCIAL_DETAIL_DEMANDS");
  await assert.rejects(h.bus.execute(h.cmd("decision.record"), h.comms, { loan_id: "L-11", action: "qrpc.conversation", rationale: "call", transcript: demand }, h.ctx), (e: unknown) => e instanceof CommandRefused && e.code === "NO_FINANCIAL_DETAIL_DEMANDS");
  assert.equal(h.ev("command.refused").length, 2); assert.equal(h.rt.store.list("qrpc_records").length, 0); assert.equal(h.ev("contact.qrpc.captured").length, 0);
  // volunteered figures are accepted: the borrower offers an estimate and the AI records it without a demand
  const ok = await h.run("qrpc.capture", { loan_id: "L-11", contact_id: "ct-g2", ai_voice_counts: true, conversation: { ...FULL, ability_to_pay: { stated_surplus_cents: 45000n, commitment_kind: "promise_to_pay_full" } }, elements: ELEMENTS, statements_made: ["If it helps, I have about four hundred fifty dollars left over each month.", "Thank you — you never have to give us figures for this call; the application is the documented path."] });
  assert.equal(ok.status, "qrpc_complete");
});
