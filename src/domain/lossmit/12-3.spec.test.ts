// 12.3 Appeal handling
// spec/sections/12-loss-mitigation/12-3-appeal-handling.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
// The bus flows run the appeal lifecycle through the 12.2 `lossmit.evaluation.*` tool (src/app/tools/section12.ts →
// section12-3.ts op=appeal_* over ops-12-3.ts; 12.3 registers no tool of its own) against the TimerEngine with the
// overridden registry (timers-12-3.ts), so every timer a T-id names is armed by the trigger the handlers emit and
// satisfied by the event they append. The denial that opens the window is 12.2's `notice.render_send` on the
// NTC_REGX_41C1_DENIAL template (→ `lossmit.denial.provided`); counsel's ACK is 13.2's `attorney.instruction.status`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import { TOOLS_12_2 } from "../../app/tools/section12-2.ts";
import { TOOLS_12_3 } from "../../app/tools/section12-3.ts";
import { SECTION_13_TOOLS } from "../../app/tools/section13.ts";
import { evaluateGate } from "../../app/evaluators.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakeFnmaSmdu } from "../../infra/integrations/fnma.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { assignAppealReviewer, lateAppeal, appealExtendsAcceptance, appealAvailabilityBeforeFiling, appealDecisionBreach, caDenialHolds } from "./ops.ts";
import { receiveAppeal, assignReviewer, decideAppeal, releaseAppealHold, denialPostmarked, caPostAppealNod, appealBreach, excludedIds } from "./ops-12-3.ts";
import { appealWindow, appealDeadlines, tppFirstDue, caHolds, independent, appealEligible } from "./evaluation.ts";

const registry = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };
const NOTICE_REG = registry();
const sample = (code: string, on = "2026-12-08", extra: Record<string, unknown> = {}) => ({ ...NOTICE_REG.activeVersion(code, D(on))!.samplePayload, ...extra });
const criterion3 = "loan has been modified three times previously";
const denialPayload = (extra: Record<string, unknown> = {}) => sample("NTC_REGX_41C1_DENIAL", "2026-11-02", { denied: [{ name: "Flex Modification", reason: criterion3, investor_name: "Fannie Mae", investor_requirement: criterion3 }], investor_name: "Fannie Mae", not_evaluated_other_criteria: true, ...extra });

// ───── bus harness (the 12.2 tools carrying the 12.3 ops, plus 13.2's counsel ACK, over the overridden registry) ─────
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const LOAN = "L-123";
const RECIPIENTS = [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
const toolKey = (process: string, name: string): string => `${process} ${name}`;
function bind(rt: ToolRuntime, agents: AgentRegistry, defs: readonly ToolDef[]): Map<string, CommandSpec<ToolInput, unknown>> {
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const out = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of defs) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); out.set(toolKey(d.process, d.name), cmd); }
  return out;
}
function harness(nowIso: string, state = "TX") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["12.2", "12.3"] });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const notices = new NoticeService({ registry: NOTICE_REG, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices, ports: { smdu: new FakeFnmaSmdu(), printMail: new FakePrintMail(), edelivery: new FakeEdelivery() } };
  const defs = [...SECTION_12_TOOLS.filter((d) => d.process === "12.2"), ...TOOLS_12_2, ...TOOLS_12_3, ...SECTION_13_TOOLS.filter((d) => d.process === "13.2" && d.name === "attorney.instruction.status")];
  const agents = new AgentRegistry(); const cmds = bind(rt, agents, defs); const bus = new CommandBus(agents);
  const actorOf = (process: string, name: string): Actor => { const d = defs.find((x) => x.process === process && x.name === name)!; return { kind: "agent", id: d.agent }; };
  const run = async (name: string, input: ToolInput, process = "12.2"): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(toolKey(process, name))!, actorOf(process, name), { loan_id: LOAN, ...input }, uow)).output as Record<string, unknown>;
  const appeal = (input: ToolInput) => run("lossmit.evaluation.*", input);
  const refused = (name: string, input: ToolInput, code: string) => assert.rejects(bus.execute(cmds.get(toolKey("12.2", name))!, AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof CommandRefused && e.code === code);
  const rejects = (input: ToolInput, re: RegExp) => assert.rejects(bus.execute(cmds.get(toolKey("12.2", "lossmit.evaluation.*"))!, AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof RangeError && re.test(e.message));
  const timer = (code: string) => timers.byCode(code);
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  const at = (iso: string) => clock.set(iso);
  // The 12.2 evaluation the appeal is of: complete 2026-10-07, Flex Mod denied, no sale scheduled (tier ge_90).
  rt.store.put("lossmit_evaluations", "eval-1", { loan_id: LOAN, application_id: "app-1", tier: "ge_90", state, complete_at: "2026-10-07", option: "flex_mod", outcome: "denied", reviewer_approval_id: "rev-eval-1-rev-1" }, AGENT, nowIso);
  /** 12.2 provides the (c)(1)(ii) denial through the template (→ `notice.sent{template=NTC_REGX_41C1_DENIAL}` + `lossmit.denial.provided{kind=denial, state, provided_at}`). */
  const denial = async (iso: string) => { at(iso); return run("notice.render_send", { template_code: "NTC_REGX_41C1_DENIAL", option: "Flex Modification", criterion: criterion3, investor: "Fannie Mae", reviewer_approval_id: "rev-eval-1-rev-1", recipients: RECIPIENTS, payload: denialPayload(), state }) as Promise<{ id: string; status: string }>; };
  const receive = (iso: string, input: ToolInput = {}) => { at(iso); return appeal({ op: "appeal_receive", application_id: "app-1", evaluation_id: "eval-1", channel: "written", complete_on: "2026-10-07", first_filing_made: false, recipients: RECIPIENTS, payload: sample("NTC_REGX_41H_APPEAL_ACK"), ...input }); };
  const assign = (iso: string, input: ToolInput = {}) => { at(iso); return appeal({ op: "appeal_assign_reviewer", candidate_id: "u-independent", candidate_role: "lossmit_reviewer", evaluator_id: "u-eval", approver_id: "u-approver", evaluator_run_id: "run-eval-1", ...input }); };
  const decide = (iso: string, input: ToolInput = {}) => { at(iso); const decision = String(input.decision ?? "granted_new_offer"); return appeal({ op: "appeal_decide", reviewer_id: "u-independent", decision, recipients: RECIPIENTS, payload: sample(decision === "denied" ? "NTC_REGX_41H4_APPEAL_DENIED" : "NTC_REGX_41H4_APPEAL_GRANTED", iso.slice(0, 10), { state }), ...input }); };
  return { rt, events, timers, run, appeal, refused, rejects, timer, emitted, at, denial, receive, assign, decide };
}
const one = <T>(xs: readonly T[]): T => { assert.equal(xs.length, 1); return xs[0]!; };

test("12.3-T1: Given a denial provided 2026-11-02 (tier ge_90) and an appeal received 2026-11-12, when processed, then a reviewer with no involvement is assigned by 2026-11-13, the decision notice is provided by 2026-12-12, and `accept_by = provided_at + 14`.", async () => {
  assert.equal(appealEligible("ge_90", true, true), true); assert.equal(appealWindow(D("2026-11-02")), "2026-11-16");
  assert.equal(addBusinessDays(D("2026-11-12"), 1, servicer), "2026-11-13");   // SM_APPEAL_REVIEWER_ASSIGN_1BD: Thu → Fri
  const d = appealDeadlines(D("2026-11-12"), D("2026-12-08")); assert.equal(d.decision_due, "2026-12-12"); assert.equal(d.accept_by, "2026-12-22"); assert.equal(appealDeadlines(D("2026-11-12")).accept_by, null);
  const h = harness("2026-11-02T15:00:00Z");
  // Mon 2026-11-02: the denial is provided → the 14-day appeal window runs to 2026-11-16 (§1024.41(h)(2)).
  const n = await h.denial("2026-11-02T15:00:00Z"); assert.equal(n.status, "sent");
  const provided = one(h.emitted("lossmit.denial.provided")); assert.equal(provided.payload.provided_at, "2026-11-02"); assert.equal(provided.payload.appeal_by, "2026-11-16");
  const win = one(h.timer("REGX_1024_41H2_APPEAL_WINDOW_14")); assert.equal(win.status, "armed"); assert.equal(win.anchorDate, "2026-11-02"); assert.equal(win.dueDate, "2026-11-16");
  // Thu 2026-11-12: the appeal is received in the window → hold opened, acknowledgment sent, the 30-day and 1-BD clocks arm.
  const r = await h.receive("2026-11-12T14:00:00Z");
  assert.equal(r.eligible, true); assert.equal(r.tier, "ge_90"); assert.equal(r.status, "under_review"); assert.equal(r.decision_due, "2026-12-12"); assert.equal(r.assign_reviewer_by, "2026-11-13"); assert.equal(r.notice, "NTC_REGX_41H_APPEAL_ACK"); assert.equal(r.notice_status, "sent");
  const received = one(h.emitted("lossmit.appeal.received")); assert.equal(received.payload.eligible, true); assert.equal(received.payload.received_date, "2026-11-12"); assert.equal(received.payload.decision_anchor_date, "2026-11-12");
  assert.equal(win.status, "satisfied"); assert.equal(win.satisfiedByEventId, received.id);
  assert.equal(one(h.emitted("foreclosure_holds.opened")).payload.kind, "lm_appeal_pending"); assert.equal(one(h.timer("REGX_1024_41G1_APPEAL_HOLD")).status, "armed");
  const sla = one(h.timer("SM_APPEAL_REVIEWER_ASSIGN_1BD")); assert.equal(sla.dueDate, "2026-11-13");
  const decide30 = one(h.timer("REGX_1024_41H4_APPEAL_DECIDE_30")); assert.equal(decide30.anchorDate, "2026-11-12"); assert.equal(decide30.dueDate, "2026-12-12");
  const fnma30 = one(h.timer("FNMA_D2207_APPEAL_DECIDE_30")); assert.equal(fnma30.dueDate, "2026-12-12");
  assert.equal(h.timer("FNMA_E3401_APPEAL_COURT_DELAY_REQUEST_1BD").length, 0);   // not in foreclosure
  // Fri 2026-11-13: a reviewer with no involvement is assigned → SLA satisfied, independence gate open.
  const a = await h.assign("2026-11-13T15:00:00Z"); assert.equal(a.accepted, true); assert.equal(a.reviewer_id, "u-independent"); assert.deepEqual(a.excluded_ids, ["u-eval", "u-approver"]);
  const assigned = one(h.emitted("lossmit.appeal.reviewer_assigned")); assert.equal(sla.status, "satisfied"); assert.equal(sla.satisfiedByEventId, assigned.id);
  assert.equal(one(h.timer("SM_APPEAL_INDEPENDENCE_GATE")).status, "armed"); assert.equal(evaluateGate("12.3.reviewerIndependent", assigned.payload).open, true);
  // Tue 2026-12-08 (≤ day 30): the independent reviewer signs; the (h)(4) notice is provided → the 30-day clocks are satisfied and accept_by = provided_at + 14 = 2026-12-22.
  await h.rejects({ op: "appeal_decide", reviewer_id: "u-eval", decision: "granted_new_offer", recipients: RECIPIENTS, payload: sample("NTC_REGX_41H4_APPEAL_GRANTED") }, /not the assigned independent reviewer/);
  assert.equal(h.emitted("notice.sent").filter((e) => e.payload.template === "NTC_REGX_41H4_APPEAL_GRANTED").length, 0);   // no notice before the human decision
  const dec = await h.decide("2026-12-08T16:00:00Z", { tpp: true });
  assert.equal(dec.outcome, "granted"); assert.equal(dec.provided_at, "2026-12-08"); assert.equal(dec.accept_by, "2026-12-22"); assert.equal(dec.tpp_first_due, "2027-01-01"); assert.equal(dec.no_further_appeal, true);
  const sent = one(h.emitted("notice.sent").filter((e) => e.payload.template === "NTC_REGX_41H4_APPEAL_GRANTED"));
  assert.equal(decide30.status, "satisfied"); assert.equal(decide30.satisfiedByEventId, sent.id); assert.equal(fnma30.status, "satisfied");
  const decided = one(h.emitted("lossmit.appeal.decided")); assert.equal(decided.payload.accept_by, "2026-12-22"); assert.equal(decided.payload.accept_by, addDays(D(String(decided.payload.provided_at)), 14));
  const accept = one(h.timer("REGX_1024_41H4_ACCEPT_14")); assert.equal(accept.anchorDate, "2026-12-08"); assert.equal(accept.dueDate, "2026-12-22");
  assert.equal(h.rt.store.get("lossmit_appeals", String(r.appeal_id))!.data.status, "awaiting_response"); assert.equal(h.rt.store.get("lossmit_offers", `offer-${String(r.appeal_id)}`)!.data.origin, "appeal");
});

test("12.3-T2: (independence) assignment of the original approving reviewer is refused with a logged reason; assignment of an uninvolved supervisor is accepted.", async () => {
  const refused = assignAppealReviewer({ candidate_id: "u-approver", evaluator_id: "u-eval", approver_id: "u-approver", candidate_role: "reviewer" });
  assert.equal(refused.accepted, false); assert.match(refused.reason, /original approving reviewer/);
  const ok = assignAppealReviewer({ candidate_id: "u-supervisor", evaluator_id: "u-eval", approver_id: "u-approver", candidate_role: "supervisor" });
  assert.equal(ok.accepted, true); assert.match(ok.reason, /took no part/);
  assert.equal(independent("u-editor", ["u-eval", "u-approver", "u-editor"]), false);   // anyone who edited reason codes is in the excluded set (12.3 rule 4)
  assert.deepEqual(excludedIds({ evaluator_id: "u-eval", approver_id: "u-approver", reason_code_editor_ids: ["u-editor"], directly_involved_supervisor_ids: ["u-boss"] }), ["u-eval", "u-approver", "u-editor", "u-boss"]);
  const h = harness("2026-11-02T15:00:00Z"); await h.denial("2026-11-02T15:00:00Z"); await h.receive("2026-11-12T14:00:00Z");
  // The original approving reviewer: refused before any assignment event, the reason logged on `lossmit.appeal.assignment_refused` and on the appeal record.
  await h.rejects({ op: "appeal_assign_reviewer", candidate_id: "u-approver", candidate_role: "lossmit_reviewer", evaluator_id: "u-eval", approver_id: "u-approver" }, /SM_APPEAL_INDEPENDENCE_GATE: u-approver is the original approving reviewer/);
  const logged = one(h.emitted("lossmit.appeal.assignment_refused")); assert.match(String(logged.payload.reason), /original approving reviewer/); assert.deepEqual(logged.payload.excluded_ids, ["u-eval", "u-approver"]);
  assert.equal(evaluateGate("12.3.reviewerIndependent", logged.payload).open, false);
  assert.equal(h.emitted("lossmit.appeal.reviewer_assigned").length, 0); assert.equal(one(h.timer("SM_APPEAL_REVIEWER_ASSIGN_1BD")).status, "armed");
  const check = h.rt.store.get("lossmit_appeals", "appeal-eval-1-2026-11-12")!.data.reviewer_independence_check as { result: string; candidate_id: string }; assert.equal(check.result, "failed"); assert.equal(check.candidate_id, "u-approver");
  // Someone who edited the reason codes is excluded too (rule 4); a directly involved supervisor likewise (comment 41(h)(3)-1).
  await h.rejects({ op: "appeal_assign_reviewer", candidate_id: "u-editor", evaluator_id: "u-eval", approver_id: "u-approver", reason_code_editor_ids: ["u-editor"] }, /edited the reason codes/);
  await h.rejects({ op: "appeal_assign_reviewer", candidate_id: "u-boss", candidate_role: "supervisor", evaluator_id: "u-eval", directly_involved_supervisor_ids: ["u-boss"] }, /directly involved/);
  // An uninvolved supervisor is accepted: the assignment event satisfies the 1-BD SLA and the independence gate evaluates open on its facts.
  const a = await h.assign("2026-11-13T15:00:00Z", { candidate_id: "u-supervisor", candidate_role: "supervisor" });
  assert.equal(a.accepted, true); assert.match(String(a.reason), /took no part/);
  const assigned = one(h.emitted("lossmit.appeal.reviewer_assigned")); assert.equal(assigned.payload.reviewer_id, "u-supervisor"); assert.equal(assigned.payload.reviewer_role, "supervisor");
  assert.equal(one(h.timer("SM_APPEAL_REVIEWER_ASSIGN_1BD")).status, "satisfied"); assert.equal(one(h.timer("SM_APPEAL_INDEPENDENCE_GATE")).status, "armed");
  assert.equal(evaluateGate("12.3.reviewerIndependent", assigned.payload).open, true); assert.notEqual(assigned.payload.reviewer_run_id, assigned.payload.evaluator_run_id);   // fresh `appeal` run, not the evaluator's
  assert.equal(assignReviewer({ appeal_id: "x", candidate_id: "u-supervisor", candidate_role: "supervisor", evaluator_id: "u-eval", approver_id: "u-approver", assigned_on: D("2026-11-13") }).events[0]!.type, "lossmit.appeal.reviewer_assigned");
});

test("12.3-T3: (late appeal) appeal received 2026-11-20 → ineligible notice; new pay stubs reviewed as new information; foreclosure holds released only after reviewer confirmation.", async () => {
  const r0 = lateAppeal({ denial_provided_on: D("2026-10-20"), appeal_received_on: D("2026-11-20"), new_information: ["pay stubs 2026-11"], reviewer_confirmed_release: false });
  assert.equal(r0.window_ends, "2026-11-03"); assert.equal(r0.eligible, false); assert.equal(r0.notice, "NTC_REGX_41H_APPEAL_INELIGIBLE"); assert.deepEqual(r0.new_information_review, { items: ["pay stubs 2026-11"], as: "new_information" }); assert.equal(r0.holds_released, false);
  assert.equal(lateAppeal({ denial_provided_on: D("2026-10-20"), appeal_received_on: D("2026-11-20"), new_information: [], reviewer_confirmed_release: true }).holds_released, true);
  const h = harness("2026-11-02T15:00:00Z"); await h.denial("2026-11-02T15:00:00Z");
  const win = one(h.timer("REGX_1024_41H2_APPEAL_WINDOW_14")); assert.equal(win.dueDate, "2026-11-16");
  h.at("2026-11-17T09:00:00Z"); assert.equal(h.timers.evaluate("2026-11-17T09:00:00Z").some((b) => b.instance.code === "REGX_1024_41H2_APPEAL_WINDOW_14"), true);   // the window lapsed on 2026-11-16
  // 2026-11-20 (day 18): late → ineligible{late}, the ineligibility notice goes out; the hold still opens on receipt (rule 8) and no 30-day clock arms.
  const r = await h.receive("2026-11-20T14:00:00Z", { payload: sample("NTC_REGX_41H_APPEAL_INELIGIBLE"), new_information_doc_ids: ["doc-paystub-1"] });
  assert.equal(r.eligible, false); assert.equal(r.late, true); assert.equal(r.ineligibility_reason, "late"); assert.equal(r.status, "ineligible"); assert.equal(r.appeal_window_ends, "2026-11-16"); assert.equal(r.notice, "NTC_REGX_41H_APPEAL_INELIGIBLE"); assert.equal(r.notice_status, "sent");
  assert.equal(one(h.emitted("notice.sent").filter((e) => e.payload.template === "NTC_REGX_41H_APPEAL_INELIGIBLE")).payload.template, "NTC_REGX_41H_APPEAL_INELIGIBLE");
  const received = one(h.emitted("lossmit.appeal.received")); assert.equal(received.payload.eligible, false); assert.equal(received.payload.ineligibility_reason, "late"); assert.equal(win.status, "satisfied_late");
  assert.equal(h.timer("REGX_1024_41H4_APPEAL_DECIDE_30").length, 0); assert.equal(h.timer("FNMA_D2207_APPEAL_DECIDE_30").length, 0);
  const hold = one(h.timer("REGX_1024_41G1_APPEAL_HOLD")); assert.equal(hold.status, "armed"); assert.equal(h.rt.store.get("foreclosure_holds", String(r.hold_id))!.data.status, "active");
  // New pay stubs: reviewed as new information — a late appeal's information routes to an NoE / new-BRP / discretionary review (rule 3; D2-2-07 option 3).
  const ni = await h.appeal({ op: "appeal_new_information", doc_ids: ["doc-paystub-2", "doc-paystub-3"], asserts_error: true });
  assert.equal(ni.reviewed_as, "new_information"); assert.equal(ni.route, "noe_candidate"); assert.deepEqual(ni.items, ["doc-paystub-2", "doc-paystub-3"]);
  const reviewed = one(h.emitted("lossmit.appeal.new_information.reviewed")); assert.equal(reviewed.payload.as, "new_information"); assert.equal(reviewed.payload.within_appeal_window, false); assert.equal(reviewed.payload.fnma_option, 3);
  // Holds release only after the reviewer confirms ineligibility: without a reviewer the release is refused and the hold stays; with one it closes the gate.
  await h.rejects({ op: "appeal_release_holds", reason: "ineligible" }, /release only after the reviewer confirms/);
  assert.equal(hold.status, "armed"); assert.equal(h.emitted("foreclosure_holds.closed").length, 0);
  const a = await h.assign("2026-11-23T15:00:00Z"); assert.equal(a.accepted, true);
  const rel = await h.appeal({ op: "appeal_release_holds", reason: "ineligible", reviewer_id: "u-independent" });
  assert.equal(rel.released, true); assert.equal(rel.reviewer_id, "u-independent");
  const closed = one(h.emitted("foreclosure_holds.closed")); assert.equal(closed.payload.kind, "lm_appeal_pending"); assert.equal(closed.payload.reviewer_id, "u-independent");
  assert.equal(hold.status, "satisfied"); assert.equal(hold.satisfiedByEventId, closed.id); assert.equal(h.rt.store.get("foreclosure_holds", String(r.hold_id))!.data.status, "released");
  assert.equal(h.rt.store.get("lossmit_appeals", String(r.appeal_id))!.data.ineligibility_confirmed_by, "u-independent");
  assert.throws(() => releaseAppealHold({ appeal_id: "x", hold_id: "h", reason: "ineligible", eligible: false }), /reviewer confirms/);
});

// 12.3-T4 (e)(2)(iii): a pending deferral offer with `accept_by` 2026-11-16 is extended to appeal notice + 14. (The manifest carries no text for this T-id, so the verbatim title is the bare id.)
test("12.3-T4: ", async () => {
  const r0 = appealExtendsAcceptance({ original_accept_by: D("2026-11-16"), appeal_filed_on: D("2026-11-10"), appeal_notice_provided_on: D("2026-12-05") });
  assert.equal(r0.accept_by, "2026-12-19"); assert.equal(r0.extended, true); assert.equal(r0.timer, "REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED");
  assert.equal(appealExtendsAcceptance({ original_accept_by: D("2026-12-25"), appeal_filed_on: D("2026-11-10"), appeal_notice_provided_on: D("2026-12-05") }).extended, false);   // a later original date stands
  const h = harness("2026-11-02T15:00:00Z"); await h.denial("2026-11-02T15:00:00Z");
  // The Payment Deferral offered with the denial is pending with accept_by 2026-11-16 (§1024.41(e)(1) 14 days from 2026-11-02).
  h.rt.store.put("lossmit_offers", "offer-deferral", { loan_id: LOAN, evaluation_id: "eval-1", option: "payment_deferral", status: "offered", accept_by: "2026-11-16", accept_by_basis: "e1_14" }, AGENT, "2026-11-02T15:00:00Z");
  // The appeal on 2026-11-12 suspends the offer's own deadline: accept_by is recomputed on the (e)(2)(iii) basis and waits for the (h)(4) notice.
  const r = await h.receive("2026-11-12T14:00:00Z"); assert.equal(r.original_offer_pending, true);
  assert.equal(one(h.emitted("lossmit.appeal.received")).payload.original_offer_pending, true);
  const ext = one(h.emitted("lossmit.offer.accept_by.extended")); assert.equal(ext.payload.offer_id, "offer-deferral"); assert.equal(ext.payload.previous_accept_by, "2026-11-16"); assert.equal(ext.payload.accept_by, null); assert.equal(ext.payload.accept_by_basis, "e2iii_extension");
  assert.equal(h.rt.store.get("lossmit_offers", "offer-deferral")!.data.accept_by, null); assert.equal(h.rt.store.get("lossmit_offers", "offer-deferral")!.data.accept_by_basis, "e2iii_extension");
  assert.equal(h.timer("REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED").length, 0);   // the anchor (the appeal notice) does not exist yet
  await h.assign("2026-11-13T15:00:00Z");
  // The appeal notice provided 2026-12-08 reinstates the original offer with accept_by = 2026-12-08 + 14 = 2026-12-22 — the same date as the appeal offer.
  const dec = await h.decide("2026-12-08T16:00:00Z", { decision: "granted_original_offer_reinstated" });
  assert.equal(dec.original_offer_accept_by, "2026-12-22"); assert.equal(dec.accept_by, "2026-12-22");
  const decided = one(h.emitted("lossmit.appeal.decided")); assert.equal(decided.payload.original_offer_pending, true); assert.equal(decided.payload.original_offer_accept_by, addDays(D(String(decided.payload.provided_at)), 14));
  const ext2 = h.emitted("lossmit.offer.accept_by.extended").at(-1)!; assert.equal(ext2.payload.accept_by, "2026-12-22"); assert.equal(ext2.payload.extended, true); assert.equal(ext2.payload.timer, "REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED");
  const offer = h.rt.store.get("lossmit_offers", "offer-deferral")!.data; assert.equal(offer.accept_by, "2026-12-22"); assert.equal(offer.accept_by_basis, "e2iii_extension");
  const e2 = one(h.timer("REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED")); assert.equal(e2.status, "armed"); assert.equal(e2.anchorDate, "2026-12-08"); assert.equal(e2.dueDate, "2026-12-22");
  const acc = one(h.timer("REGX_1024_41H4_ACCEPT_14")); assert.equal(acc.dueDate, "2026-12-22");
  // The borrower accepts the reinstated deferral on 2026-12-18 (12.2 op=offer_response → `lossmit.offer.responded{response=accepted}`) → the extended clock is satisfied in time.
  h.at("2026-12-18T15:00:00Z");
  await h.run("lossmit.evaluation.*", { op: "offer_response", offer_id: "offer-deferral", option: "payment_deferral", response: "accepted", accepted_via: "written" });
  const accepted = one(h.emitted("lossmit.offer.responded")); assert.equal(accepted.payload.response, "accepted");
  assert.equal(e2.status, "satisfied"); assert.equal(e2.satisfiedByEventId, accepted.id); assert.equal(acc.status, "satisfied");
});

test("12.3-T5: (TPP timing) appeal granted, notice sent 2026-12-16 → first trial payment due 2027-02-01; sent 2026-12-15 → 2027-01-01.", async () => {
  assert.equal(tppFirstDue(D("2026-12-16")), "2027-02-01"); assert.equal(tppFirstDue(D("2026-12-15")), "2027-01-01"); assert.equal(tppFirstDue(D("2026-12-08")), "2027-01-01");
  for (const [sentIso, firstDue] of [["2026-12-16T16:00:00Z", "2027-02-01"], ["2026-12-15T16:00:00Z", "2027-01-01"]] as const) {
    const h = harness("2026-11-02T15:00:00Z"); await h.denial("2026-11-02T15:00:00Z"); const r = await h.receive("2026-11-12T14:00:00Z"); await h.assign("2026-11-13T15:00:00Z");
    const dec = await h.decide(sentIso, { tpp: true }); assert.equal(dec.outcome, "granted"); assert.equal(dec.tpp_first_due, firstDue);
    const decided = one(h.emitted("lossmit.appeal.decided")); assert.equal(decided.payload.tpp, true); assert.equal(decided.payload.tpp_first_due_date, firstDue); assert.equal(decided.payload.provided_at, sentIso.slice(0, 10));
    assert.equal(one(h.emitted("notice.sent").filter((e) => e.payload.template === "NTC_REGX_41H4_APPEAL_GRANTED")).occurredAt.slice(0, 10), sentIso.slice(0, 10));
    const t = one(h.timer("FNMA_D2207_TPP_FIRST_DUE_15TH_RULE")); assert.equal(t.status, "armed"); assert.equal(t.anchorDate, firstDue); assert.equal(t.dueDate, firstDue);
    assert.equal(h.rt.store.get("lossmit_appeals", String(r.appeal_id))!.data.tpp_first_due, firstDue); assert.equal(h.rt.store.get("lossmit_offers", `offer-${String(r.appeal_id)}`)!.data.tpp_first_due, firstDue);
    // 12.8 builds the trial schedule on that first due date (ops-12-8.ts `lossmit.trial.schedule_created{first_due_date}`) — the event that satisfies the computed clock.
    const sched = h.events.append({ type: "lossmit.trial.schedule_created", loanId: LOAN, actor: AGENT, payload: { modification_id: `mod-${String(r.appeal_id)}`, first_due_date: firstDue, due_dates: [firstDue], months: 3 } });
    assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, sched.id);
  }
  // A denial or a non-TPP grant arms no TPP clock.
  const h = harness("2026-11-02T15:00:00Z"); await h.denial("2026-11-02T15:00:00Z"); await h.receive("2026-11-12T14:00:00Z"); await h.assign("2026-11-13T15:00:00Z");
  await h.decide("2026-12-16T16:00:00Z", { decision: "denied" }); assert.equal(h.timer("FNMA_D2207_TPP_FIRST_DUE_15TH_RULE").length, 0); assert.equal(one(h.emitted("lossmit.appeal.decided")).payload.tpp, false);
});

test("12.3-T6: (CA) appeal received on day 25 after the denial is timely (30-day window); NOD refused until 15 days after the appeal denial.", async () => {
  assert.equal(appealWindow(D("2026-11-02"), "CA"), "2026-12-02");
  const timely = lateAppeal({ denial_provided_on: D("2026-11-02"), appeal_received_on: D("2026-11-27"), new_information: [], reviewer_confirmed_release: false, state: "CA" });
  assert.equal(timely.eligible, true); assert.equal(timely.notice, "NTC_REGX_41H_APPEAL_ACK");
  assert.deepEqual(caHolds(D("2026-11-02"), D("2026-12-08")), { no_nod_before: "2026-12-03", after_appeal_denial_before: "2026-12-23" });
  assert.equal(caDenialHolds({ denial_provided_on: D("2026-11-02"), nod_requested_on: D("2026-12-15") }).nod_allowed, true);   // 31-day denial hold lapsed; the post-appeal 15-day tail is the 12.3 gate below
  const h = harness("2026-11-02T15:00:00Z", "CA"); await h.denial("2026-11-02T15:00:00Z");
  assert.equal(one(h.emitted("lossmit.denial.provided")).payload.state, "CA");
  const ca = one(h.timer("CA_CIV_2923_6D_APPEAL_WINDOW_30")); assert.equal(ca.anchorDate, "2026-11-02"); assert.equal(ca.dueDate, "2026-12-02");   // overrides the 14-day federal window for CA
  const fed = one(h.timer("REGX_1024_41H2_APPEAL_WINDOW_14")); assert.equal(fed.dueDate, "2026-11-16");
  // Day 25 (2026-11-27): timely under Cal. Civ. Code §2923.6(d) even though the 14-day federal window passed (it breached on 2026-11-16; CA's row overrides it).
  h.at("2026-11-27T13:00:00Z"); assert.equal(h.timers.evaluate("2026-11-27T13:00:00Z").some((b) => b.instance.code === "REGX_1024_41H2_APPEAL_WINDOW_14"), true); assert.equal(fed.status, "breached"); assert.equal(ca.status, "armed");
  const r = await h.receive("2026-11-27T14:00:00Z");
  assert.equal(r.eligible, true); assert.equal(r.late, false); assert.equal(r.appeal_window_ends, "2026-12-02"); assert.equal(r.notice, "NTC_REGX_41H_APPEAL_ACK"); assert.equal(r.decision_due, "2026-12-27");
  const received = one(h.emitted("lossmit.appeal.received")); assert.equal(ca.status, "satisfied"); assert.equal(ca.satisfiedByEventId, received.id); assert.equal(fed.status, "satisfied_late");
  await h.assign("2026-11-30T15:00:00Z");
  // The appeal is denied with notice provided 2026-12-08 → no NOD/NOS before 2026-12-23 (15 days; §2923.6(e)).
  const dec = await h.decide("2026-12-08T16:00:00Z", { decision: "denied" }); assert.equal(dec.outcome, "denied"); assert.equal(dec.ca_no_nod_nos_before, "2026-12-23");
  const decided = one(h.emitted("lossmit.appeal.decided")); assert.equal(decided.payload.state, "CA"); assert.equal(decided.payload.outcome, "denied");
  const tail = one(h.timer("CA_CIV_2923_6E_POST_APPEAL_HOLD_15")); assert.equal(tail.status, "armed"); assert.equal(tail.anchorDate, "2026-12-08"); assert.equal(tail.dueDate, "2026-12-23");
  const early = caPostAppealNod({ appeal_denial_provided_on: D("2026-12-08"), nod_requested_on: D("2026-12-15") }); assert.equal(early.nod_allowed, false); assert.match(early.refusal!, /CA_CIV_2923_6E_POST_APPEAL_HOLD_15 holds until 2026-12-23/);
  assert.equal(caPostAppealNod({ appeal_denial_provided_on: D("2026-12-08"), nod_requested_on: D("2026-12-23") }).nod_allowed, true);
  await h.rejects({ op: "appeal_release_holds", reason: "denied" }, /CA post-appeal tail has not lapsed/); assert.equal(one(h.timer("REGX_1024_41G1_APPEAL_HOLD")).status, "armed");
  // 2026-12-24: the 12.2 gate sweep records the lapse (`timer.lapsed{code}`) → the tail is satisfied; the appeal hold may then close.
  h.at("2026-12-24T14:00:00Z"); const lap = await h.run("timers.*", { op: "lapse", code: "CA_CIV_2923_6E_POST_APPEAL_HOLD_15" }) as { lapsed: { timer_id: string }[] };
  assert.equal(lap.lapsed.length, 1); assert.equal(lap.lapsed[0]!.timer_id, tail.id);
  const lapsed = one(h.emitted("timer.lapsed")); assert.equal(lapsed.payload.code, "CA_CIV_2923_6E_POST_APPEAL_HOLD_15"); assert.equal(tail.status, "satisfied"); assert.equal(tail.satisfiedByEventId, lapsed.id);
  const rel = await h.appeal({ op: "appeal_release_holds", reason: "denied", tail_lapsed: true }); assert.equal(rel.released, true); assert.equal(one(h.timer("REGX_1024_41G1_APPEAL_HOLD")).status, "satisfied");
});

test("12.3-T7: (NY postmark) denial postmarked 2026-11-03 though printed 2026-11-02 → NY window ends 2026-11-17.", async () => {
  assert.equal(appealWindow(D("2026-11-02"), "NY", D("2026-11-03")), "2026-11-17"); assert.equal(appealWindow(D("2026-11-02"), "NY"), "2026-11-16");
  const p = denialPostmarked({ notice_id: "n-1", state: "NY", printed_on: D("2026-11-02"), postmark_on: D("2026-11-03") }); assert.equal(p.appeal_window_ends, "2026-11-17"); assert.equal(p.events[0]!.payload.postmark_on, "2026-11-03");
  assert.throws(() => denialPostmarked({ notice_id: "n-1", state: "NY", printed_on: D("2026-11-02"), postmark_on: D("2026-11-01") }), /precedes the print date/);
  const h = harness("2026-11-02T15:00:00Z", "NY"); const n = await h.denial("2026-11-02T15:00:00Z");
  assert.equal(h.timer("NY_419_7H_APPEAL_WINDOW_14_POSTMARK").length, 0);   // NY anchors on the postmark, which the mailing proof supplies
  assert.equal(one(h.timer("REGX_1024_41H2_APPEAL_WINDOW_14")).dueDate, "2026-11-16");
  h.at("2026-11-03T18:00:00Z"); const pm = await h.appeal({ op: "appeal_denial_postmarked", notice_id: n.id, postmark_on: "2026-11-03", mailing_proof_document_id: "doc-proof-1" });
  assert.equal(pm.appeal_window_ends, "2026-11-17");
  const ev = one(h.emitted("lossmit.denial.postmarked")); assert.equal(ev.payload.state, "NY"); assert.equal(ev.payload.printed_on, "2026-11-02"); assert.equal(ev.payload.postmark_on, "2026-11-03");
  const ny = one(h.timer("NY_419_7H_APPEAL_WINDOW_14_POSTMARK")); assert.equal(ny.status, "armed"); assert.equal(ny.anchorDate, "2026-11-03"); assert.equal(ny.dueDate, "2026-11-17");
  assert.equal(h.rt.store.get("lossmit_evaluations", "eval-1")!.data.appeal_by, "2026-11-17");
  // An appeal on 2026-11-17 is timely for NY (day 14 from the postmark) although the print-date window closed 2026-11-16.
  const r = await h.receive("2026-11-17T14:00:00Z", { postmark_on: "2026-11-03" });
  assert.equal(r.eligible, true); assert.equal(r.late, false); assert.equal(r.appeal_window_ends, "2026-11-17");
  const received = one(h.emitted("lossmit.appeal.received")); assert.equal(ny.status, "satisfied"); assert.equal(ny.satisfiedByEventId, received.id);
});

test("12.3-T8: (before first filing) loan 100 days delinquent, no filing, denial → appeal available even though a hypothetical sale date is unknown.", async () => {
  const r0 = appealAvailabilityBeforeFiling({ days_delinquent: 100, first_filing_made: false, sale_on: null, complete_on: D("2026-10-01"), denied_modification: true });
  assert.equal(r0.appeal_available, true); assert.equal(r0.tier, "ge_90"); assert.match(r0.basis, /no first filing/);
  const h = harness("2026-11-02T15:00:00Z"); await h.denial("2026-11-02T15:00:00Z");
  const r = await h.receive("2026-11-12T14:00:00Z", { days_delinquent: 100, first_filing_made: false, sale_on: null });
  assert.equal(r.eligible, true); assert.equal(r.tier, "ge_90"); assert.equal(r.ineligibility_reason, null);
  const received = one(h.emitted("lossmit.appeal.received")); assert.equal(received.payload.first_filing_made, false); assert.equal(received.payload.sale_on, null); assert.equal(received.payload.eligible, true);
  assert.equal(one(h.timer("REGX_1024_41H4_APPEAL_DECIDE_30")).dueDate, "2026-12-12");
  // Contrast: with the first filing made and a sale 60 days after completion the appeal right is gone (tier lt_90 after filing); a non-modification denial carries no Reg X appeal.
  const late = receiveAppeal({ appeal_id: "a2", application_id: "app-1", evaluation_id: "eval-1", denial_provided_on: D("2026-11-02"), received_on: D("2026-11-12"), channel: "written", complete_on: D("2026-10-07"), sale_on: D("2026-12-06"), first_filing_made: true, denied_modification: true, in_foreclosure: true });
  assert.equal(late.eligible, false); assert.equal(late.ineligibility_reason, "tier_lt_90_after_filing"); assert.equal(late.tier, "lt_90");
  assert.equal(receiveAppeal({ appeal_id: "a3", application_id: "app-1", evaluation_id: "eval-1", denial_provided_on: D("2026-11-02"), received_on: D("2026-11-12"), channel: "portal", complete_on: D("2026-10-07"), sale_on: null, first_filing_made: false, denied_modification: false, in_foreclosure: false }).ineligibility_reason, "non_modification_option");
  // A loan in foreclosure: the E-3.4-01 counsel instruction goes out with the receipt and the 1-BD clock is satisfied by the firm's ACK (13.2 op=acknowledge).
  const h2 = harness("2026-11-02T15:00:00Z"); await h2.denial("2026-11-02T15:00:00Z");
  const r2 = await h2.receive("2026-11-12T14:00:00Z", { in_foreclosure: true, first_filing_made: true, sale_on: null, firm_id: "firm-1" });
  assert.equal(r2.eligible, true); assert.equal(r2.court_delay_request_by, "2026-11-13");
  const instr = one(h2.emitted("attorney.instruction.sent")); assert.match(String(instr.payload.instruction), /do not move for judgment\/sale/);
  const court = one(h2.timer("FNMA_E3401_APPEAL_COURT_DELAY_REQUEST_1BD")); assert.equal(court.status, "armed"); assert.equal(court.anchorDate, "2026-11-12"); assert.equal(court.dueDate, "2026-11-13");
  h2.at("2026-11-13T13:00:00Z"); await h2.run("attorney.instruction.status", { op: "acknowledge", id: String(instr.payload.instruction_id), ack_by: "firm-1" }, "13.2");
  const ack = one(h2.emitted("attorney.instruction.acknowledged")); assert.equal(court.status, "satisfied"); assert.equal(court.satisfiedByEventId, ack.id);
});

test("12.3-T9: (transfer-in) appeal filed with transferor 2026-10-28, transfer date 2026-11-01 → decision due 2026-12-01 (later of 30 days from transfer/appeal).", async () => {
  assert.equal(appealDeadlines(D("2026-10-28"), undefined, D("2026-11-01")).decision_due, "2026-12-01");
  assert.equal(appealDeadlines(D("2026-11-05"), undefined, D("2026-11-01")).decision_due, "2026-12-05");   // the appeal date is the later one
  const h = harness("2026-10-20T15:00:00Z"); await h.denial("2026-10-20T15:00:00Z");
  // Boarded 2026-11-01 with the transferor's appeal of 2026-10-28 in the file (1.7): the 30-day clock anchors on the later date (§1024.41(k)(4)).
  const r = await h.receive("2026-11-01T14:00:00Z", { received_on: "2026-10-28", channel: "mail", transfer_date: "2026-11-01" });
  assert.equal(r.eligible, true); assert.equal(r.decision_due, "2026-12-01"); assert.equal(r.decision_anchor_date, "2026-11-01");
  const received = one(h.emitted("lossmit.appeal.received")); assert.equal(received.payload.received_date, "2026-10-28"); assert.equal(received.payload.transfer_date, "2026-11-01"); assert.equal(received.payload.k4_anchor_date, "2026-11-01"); assert.equal(received.payload.decision_due, "2026-12-01");
  const t = one(h.timer("REGX_1024_41H4_APPEAL_DECIDE_30")); assert.equal(t.anchorDate, "2026-11-01"); assert.equal(t.dueDate, "2026-12-01");
  assert.equal(one(h.timer("FNMA_D2207_APPEAL_DECIDE_30")).dueDate, "2026-12-01");
  assert.equal(one(h.timer("SM_APPEAL_REVIEWER_ASSIGN_1BD")).dueDate, "2026-10-29");   // the SLA still runs from the appeal date the transferor received it
  // An appeal received after the transfer anchors on its own date.
  const h2 = harness("2026-10-25T15:00:00Z"); await h2.denial("2026-10-25T15:00:00Z");
  const r2 = await h2.receive("2026-11-05T14:00:00Z", { transfer_date: "2026-11-01" }); assert.equal(r2.decision_due, "2026-12-05"); assert.equal(one(h2.timer("REGX_1024_41H4_APPEAL_DECIDE_30")).dueDate, "2026-12-05");
});

test("12.3-T10: (breach) decision not provided by day 30 → `officer` sev-1, borrower notified of status, holds maintained.", async () => {
  const r0 = appealDecisionBreach({ appeal_received_on: D("2026-10-30"), decided_on: null, today: D("2026-11-30") });
  assert.equal(r0.decision_due, "2026-11-29"); assert.equal(r0.breached, true); assert.equal(r0.escalation!.kind, "officer"); assert.equal(r0.escalation!.severity, "sev1"); assert.equal(r0.borrower_status_notice, true); assert.equal(r0.holds_maintained, true);
  assert.equal(appealDecisionBreach({ appeal_received_on: D("2026-10-30"), decided_on: D("2026-11-20"), today: D("2026-11-30") }).breached, false);
  assert.equal(appealBreach({ appeal_id: "a", appeal_received_on: D("2026-10-30"), decided_on: null, today: D("2026-11-29") }).breached, false);   // day 30 itself is not a breach
  const h = harness("2026-10-20T15:00:00Z"); await h.denial("2026-10-20T15:00:00Z");
  const r = await h.receive("2026-10-30T14:00:00Z"); assert.equal(r.decision_due, "2026-11-29"); await h.assign("2026-11-02T15:00:00Z");
  const t = one(h.timer("REGX_1024_41H4_APPEAL_DECIDE_30")); assert.equal(t.dueDate, "2026-11-29");
  // Day 30 (2026-11-29): still armed, nothing to escalate.
  h.at("2026-11-29T20:00:00Z"); assert.deepEqual((await h.appeal({ op: "appeal_breach_sweep" })).breached, []); assert.equal(t.status, "armed");
  // Day 31: the clock breaches → officer sev-1 escalation, the borrower status notice is due, the appeal hold stays in place.
  h.at("2026-11-30T14:00:00Z"); const sweep = await h.appeal({ op: "appeal_breach_sweep" }) as { breached: Record<string, unknown>[] };
  assert.equal(t.status, "breached"); assert.equal(one(h.emitted("timer.breached").filter((e) => e.payload.code === "REGX_1024_41H4_APPEAL_DECIDE_30")).payload.severity, 1);
  const b = sweep.breached.find((x) => x.code === "REGX_1024_41H4_APPEAL_DECIDE_30")!; assert.equal(b.escalation, "officer"); assert.equal(b.severity, "sev1"); assert.equal(b.decision_due, "2026-11-29"); assert.equal(b.borrower_status_notice, true); assert.equal(b.holds_maintained, true);
  const esc = h.rt.escalations.opened.find((e) => e.id === b.escalation_id)!; assert.equal(esc.kind, "officer"); assert.equal(esc.severity, "sev1"); assert.equal(esc.ownerRole, "officer"); assert.equal(esc.loanId, LOAN); assert.match(String(esc.payload.reason), /not provided by 2026-11-29/);
  const handled = one(h.emitted("lossmit.appeal.breach.handled")); assert.equal(handled.payload.borrower_status_notice, true); assert.equal(handled.payload.holds_maintained, true); assert.equal(handled.payload.escalation_id, esc.id);
  const dual = sweep.breached.find((x) => x.code === "FNMA_D2207_APPEAL_DECIDE_30")!; assert.equal(dual.severity, "sev2");   // dual-cited D2-2-07 clock: sev-2, no second status notice
  assert.equal(one(h.timer("REGX_1024_41G1_APPEAL_HOLD")).status, "armed"); assert.equal(h.emitted("foreclosure_holds.closed").length, 0); assert.equal(h.rt.store.get("foreclosure_holds", String(r.hold_id))!.data.status, "active");
  assert.equal(h.rt.store.get("lossmit_appeals", String(r.appeal_id))!.data.breach_escalation_id, esc.id);
  // The late determination still satisfies the clock (satisfied_late) and the notice goes out; no further appeal.
  const dec = await h.decide("2026-12-02T16:00:00Z", { decision: "denied" }); assert.equal(dec.outcome, "denied"); assert.equal(t.status, "satisfied_late");
});

test("12.3 timer patterns: every override matches the events the handlers append (src/kernel/events/match.ts exact compares)", () => {
  const reg = loadOverriddenRegistry(); const def = (c: string) => reg.get(c)!;
  const ev = (type: string, payload: Record<string, unknown>) => ({ id: "e", type, occurredAt: "2026-11-12T14:00:00Z", loanId: LOAN, actor: AGENT, payload, sequence: 1 });
  const rc = receiveAppeal({ appeal_id: "a1", application_id: "app-1", evaluation_id: "eval-1", denial_provided_on: D("2026-11-02"), received_on: D("2026-11-12"), channel: "written", complete_on: D("2026-10-07"), sale_on: null, first_filing_made: false, denied_modification: true, in_foreclosure: true, original_offer: { offer_id: "o1", accept_by: D("2026-11-16") } });
  const received = ev("lossmit.appeal.received", rc.events[0]!.payload);
  for (const c of ["REGX_1024_41H4_APPEAL_DECIDE_30", "FNMA_D2207_APPEAL_DECIDE_30", "SM_APPEAL_REVIEWER_ASSIGN_1BD", "FNMA_E3401_APPEAL_COURT_DELAY_REQUEST_1BD", "REGX_1024_41G1_APPEAL_HOLD"]) assert.equal(eventMatches(def(c).triggerPattern!, received), true, c);
  for (const c of ["REGX_1024_41H2_APPEAL_WINDOW_14", "CA_CIV_2923_6D_APPEAL_WINDOW_30", "NY_419_7H_APPEAL_WINDOW_14_POSTMARK"]) assert.equal(eventMatches(def(c).satisfiedPattern!, received), true, c);
  const ineligible = ev("lossmit.appeal.received", receiveAppeal({ appeal_id: "a2", application_id: "app-1", evaluation_id: "eval-1", denial_provided_on: D("2026-11-02"), received_on: D("2026-11-20"), channel: "written", complete_on: D("2026-10-07"), sale_on: null, first_filing_made: false, denied_modification: true, in_foreclosure: false }).events[0]!.payload);
  assert.equal(eventMatches(def("REGX_1024_41H4_APPEAL_DECIDE_30").triggerPattern!, ineligible), false); assert.equal(eventMatches(def("FNMA_E3401_APPEAL_COURT_DELAY_REQUEST_1BD").triggerPattern!, ineligible), false); assert.equal(eventMatches(def("SM_APPEAL_REVIEWER_ASSIGN_1BD").triggerPattern!, ineligible), true);
  const dc = decideAppeal({ appeal_id: "a1", evaluation_id: "eval-1", reviewer_id: "u-r", assigned_reviewer_id: "u-r", decision: "granted_new_offer", decided_on: D("2026-12-08"), provided_on: D("2026-12-08"), notice_id: "n", tpp: true, state: "CA", original_offer: { offer_id: "o1", accept_by: D("2026-11-16") } });
  const decided = ev("lossmit.appeal.decided", dc.events[0]!.payload);
  for (const c of ["REGX_1024_41H4_ACCEPT_14", "REGX_1024_41E2III_ORIGINAL_OFFER_EXTENDED", "FNMA_D2207_TPP_FIRST_DUE_15TH_RULE"]) assert.equal(eventMatches(def(c).triggerPattern!, decided), true, c);
  const denied = ev("lossmit.appeal.decided", decideAppeal({ appeal_id: "a1", evaluation_id: "eval-1", reviewer_id: "u-r", assigned_reviewer_id: "u-r", decision: "denied", decided_on: D("2026-12-08"), provided_on: D("2026-12-08"), notice_id: "n", tpp: false, state: "CA" }).events[0]!.payload);
  assert.equal(eventMatches(def("CA_CIV_2923_6E_POST_APPEAL_HOLD_15").triggerPattern!, denied), true); assert.equal(eventMatches(def("REGX_1024_41H4_ACCEPT_14").triggerPattern!, denied), false);
  assert.equal(eventMatches(def("REGX_1024_41G1_APPEAL_HOLD").satisfiedPattern!, ev("foreclosure_holds.closed", releaseAppealHold({ appeal_id: "a1", hold_id: "h", reason: "denied", eligible: true, state: "TX" }).events[0]!.payload)), true);
  assert.equal(eventMatches(def("NY_419_7H_APPEAL_WINDOW_14_POSTMARK").triggerPattern!, ev("lossmit.denial.postmarked", denialPostmarked({ notice_id: "n", state: "NY", printed_on: D("2026-11-02"), postmark_on: D("2026-11-03") }).events[0]!.payload)), true);
  assert.equal(eventMatches(def("SM_APPEAL_INDEPENDENCE_GATE").triggerPattern!, ev("lossmit.appeal.reviewer_assigned", assignReviewer({ appeal_id: "a1", candidate_id: "u-r", candidate_role: "lossmit_reviewer", evaluator_id: "u-e", assigned_on: D("2026-11-13") }).events[0]!.payload)), true);
});
