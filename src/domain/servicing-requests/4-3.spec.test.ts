// 4.3 Continuity of contact / assigned personnel
// spec/sections/04-customer-service-borrower-communications/4-3-continuity-of-contact-assigned-personnel.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
void cents;
import type { Episode } from "./continuity.ts";
import { assignmentTrigger, callbackRequest, handleUtterance, accuracyHarness, callMetrics, routeCall, closeForTransferOut } from "./ops.ts";
import { SYSTEM } from "../../kernel/events/index.ts";
import * as C from "./continuity.ts";
import { eiNoticeAssignment, caSpocRequest } from "./ops.ts";
import { ensureContinuityAssignment } from "../../app/tools/section04.ts";
import { harness, COMMS_AGENT, ANALYST, refusedWith } from "./test-harness.ts";
const TEAM = { team_name: "Home Retention Team 4", named_human_first_name: "Dana", title: "Senior Loan Counselor", direct_number: "(800) 555-0199", hours: "8 a.m.–8 p.m. Central, Monday–Friday" };

test("4.3-T1: Given a principal-residence loan with payment due 2026-09-01 unpaid, when day 1 = 2026-09-02, then `assignment_due_at = 2026-10-16`; when the EI notice is requested on 2026-10-09 without an assignment, then the command auto-assigns and the notice shows the team block.", async () => {
  assert.equal(C.assignmentDue(D("2026-09-01"), true), "2026-10-16");
  const h = harness("2026-09-02T14:00:00.000Z");
  h.events.append({ type: "loan.delinquency.started", loanId: "L-1", actor: SYSTEM, payload: { principal_residence: true, day_1: "2026-09-02", due_date_unpaid: "2026-09-01" } });
  assert.equal(h.timer("REGX_1024_40A1_CONTACT_ASSIGN_45")[0]!.dueDate, "2026-10-16");
  const r = eiNoticeAssignment({ episode: null, requested_on: D("2026-10-09"), due_unpaid: D("2026-09-01"), principal_residence: true, default_team: TEAM });
  assert.equal(r.assignment_due_at, "2026-10-16"); assert.equal(r.auto_assigned, true); assert.equal(r.assigned_on, "2026-10-09"); assert.deepEqual(r.episode, { status: "assigned", consecutive_on_time: 0, mode: "ai_first_named_human", team: "default" });
  assert.equal(r.notice_block.team_name, "Home Retention Team 4"); assert.equal(r.notice_block.named_human_first_name, "Dana"); assert.equal(r.notice_block.continuity_block_present, true);
  h.clock.set("2026-10-09T15:00:00.000Z"); h.events.append({ type: "notice.early_intervention_written.requested", loanId: "L-1", actor: SYSTEM, payload: { template: "NTC_REGX_39B_EARLY_INTERVENTION" } });
  assert.equal(h.timer("REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE")[0]!.status, "armed");                                        // the send command blocks until an assignment exists
  // the 11.2 send command calls ensureContinuityAssignment before sending: no assignment → auto-assign the default team and carry the block
  const auto = ensureContinuityAssignment(h.rt, { ...h.ctx, actor: COMMS_AGENT, now: h.clock.now() }, { team: TEAM, due_unpaid: D("2026-09-01"), principal_residence: true });
  assert.deepEqual([auto.auto_assigned, auto.assignment_due_at, auto.notice_block.continuity_block_present, auto.notice_block.named_human_first_name], [true, "2026-10-16", true, "Dana"]);
  const ev = h.events.ofType("continuity.assigned")[0]!; assert.deepEqual([ev.payload.team, ev.payload.mode, ev.payload.assigned_on, ev.payload.auto_assigned, ev.payload.trigger], ["Home Retention Team 4", "ai_first_named_human", "2026-10-09", true, "ei_notice"]);
  assert.equal(h.timer("REGX_1024_40A1_ASSIGN_BEFORE_EI_NOTICE")[0]!.status, "satisfied"); assert.equal(h.timer("REGX_1024_40A1_CONTACT_ASSIGN_45")[0]!.status, "satisfied");
  assert.equal(h.rt.store.get("continuity_episodes", "ep-L-1")!.data.status, "assigned"); assert.equal(h.timer("REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE")[0]!.status, "armed");   // the daily availability check opens with the assignment
  assert.equal(ensureContinuityAssignment(h.rt, { ...h.ctx, actor: COMMS_AGENT, now: h.clock.now() }, { team: TEAM, due_unpaid: D("2026-09-01"), principal_residence: true }).auto_assigned, false);   // an existing assignment is kept
  assert.equal(h.events.ofType("continuity.assigned").length, 1);
  assert.equal(eiNoticeAssignment({ episode: r.episode, requested_on: D("2026-10-09"), due_unpaid: D("2026-09-01"), principal_residence: true, default_team: TEAM }).auto_assigned, false);
  await h.run("4.3", "continuity.availability.check", COMMS_AGENT, { team_active: true, line_reachable: true }, "2026-10-10T15:00:00.000Z");
  assert.equal(h.timer("REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE")[0]!.status, "satisfied"); assert.equal(h.timer("REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE")[1]!.status, "armed");      // recurring: the next daily check re-arms
  // the explicit assignment command needs the named human of record and a reachable line
  const h2 = harness("2026-09-02T14:00:00.000Z");
  await assert.rejects(h2.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", direct_number: "(800) 555-0199" }), refusedWith("NAMED_HUMAN_REQUIRED"));
  await assert.rejects(h2.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", named_human: "Dana" }), refusedWith("DIRECT_NUMBER_REQUIRED"));
  await assert.rejects(h2.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", mode: "ai_only", direct_number: "(800) 555-0199" }), refusedWith("AI_ONLY_OFF"));
  await h2.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", team_name: TEAM.team_name, named_human: "Dana", direct_number: TEAM.direct_number, hours: TEAM.hours });
  assert.equal(h2.events.ofType("continuity.assigned").length, 1);
});
test("4.3-T2: Given no EI notice by day 45 (e.g., §1024.39 exemption), then assignment still occurs by 2026-10-16.", () => {
  assert.deepEqual(assignmentTrigger(D("2026-09-01"), true, null), { assign_by: "2026-10-16", basis: "day_45" });
  assert.deepEqual(assignmentTrigger(D("2026-09-01"), true, D("2026-10-09")), { assign_by: "2026-10-09", basis: "ei_notice" });
});
test("4.3-T3: Given an investment property, then `not_required` and no timer breach.", () => {
  assert.equal(C.assignmentDue(D("2026-09-01"), false), "not_required"); assert.deepEqual(assignmentTrigger(D("2026-09-01"), false, null), { assign_by: "not_required", basis: "not_required" });
  const h = harness("2026-09-02T14:00:00.000Z");
  h.events.append({ type: "loan.delinquency.started", loanId: "L-1", actor: SYSTEM, payload: { principal_residence: false, day_1: "2026-09-02" } });
  assert.equal(h.timer("REGX_1024_40A1_CONTACT_ASSIGN_45").length, 0);
  assert.deepEqual(h.ctx.timers.evaluate("2026-12-31T23:59:00.000Z"), []);
  assert.equal(eiNoticeAssignment({ episode: null, requested_on: D("2026-10-09"), due_unpaid: D("2026-09-01"), principal_residence: false, default_team: TEAM }).assignment_due_at, "not_required");
});
test("4.3-T4: Given a borrower calls the direct line after hours, then a callback request is created and a live contact by the assigned team occurs within 1 servicer BD.", async () => {
  const r = callbackRequest({ called_at_local: "2026-10-09T21:30", staffed_from: "08:00", staffed_to: "20:00" });
  assert.deepEqual(r, { callback: true, live_contact_due: "2026-10-13", same_day_target: false });                  // Fri after hours → Tue (Columbus Day closed)
  assert.equal(callbackRequest({ called_at_local: "2026-10-08T10:00", staffed_from: "08:00", staffed_to: "20:00" }).same_day_target, true);
  const h = harness("2026-10-09T15:00:00.000Z");
  await h.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", team_name: TEAM.team_name, named_human: "Dana", direct_number: TEAM.direct_number, hours: TEAM.hours });
  h.clock.set("2026-10-10T02:30:00.000Z");                                                                              // Fri 2026-10-09 21:30 Central — after the staffed hours
  const cb = (await h.run("4.3", "callback.schedule", COMMS_AGENT, { id: "cb-1", called_at_local: "2026-10-09T21:30", staffed_from: "08:00", staffed_to: "20:00", data: { channel: "voice", ani: "555-0100" } })).output as { callback: boolean; live_contact_due: string; id: string };
  assert.deepEqual([cb.callback, cb.live_contact_due, cb.id], [true, "2026-10-13", "cb-1"]);
  const created = h.events.ofType("callback_requests.created")[0]!; assert.equal(created.payload.id, "cb-1");
  const t = h.timer("REGX_1024_40A3_LIVE_RESPONSE_1BD")[0]!; assert.equal(t.dueDate, "2026-10-13"); assert.equal(t.armedByEventId, created.id);   // 1 servicer BD from the request (Mon 10-12 Columbus Day closed)
  await h.run("4.3", "contact.log", COMMS_AGENT, { id: "contact-1", data: { channel: "voice", live_contact: false, note: "voicemail left" } }, "2026-10-13T14:00:00.000Z");
  assert.equal(t.status, "armed");                                                                                     // a voicemail is not a live response
  await h.run("4.3", "contact.log", ANALYST, { id: "contact-0", data: { channel: "voice", live_contact: true, callback_request_id: "cb-1" } }, "2026-10-13T15:00:00.000Z");
  assert.equal(h.events.ofType("contact.logged").at(-1)!.payload.by_assigned_personnel, false); assert.equal(t.status, "armed");   // a live contact by someone outside the assigned team is not "such personnel" (§1024.40(a)(3))
  const live = (await h.run("4.3", "contact.log", COMMS_AGENT, { id: "contact-2", data: { channel: "voice", live_contact: true, callback_request_id: "cb-1" } }, "2026-10-13T16:00:00.000Z")).output as Record<string, unknown>;
  assert.deepEqual([live.by_assigned_personnel, live.assigned_personnel_id, live.episode_id, live.live_contact], [true, "Home Retention Team 4", "ep-L-1", true]);   // the AI first line of the assigned team
  const ev = h.events.ofType("contact.logged").at(-1)!; assert.deepEqual([ev.payload.live_contact, ev.payload.by_assigned_personnel, ev.payload.callback_request_id], [true, true, "cb-1"]);
  assert.equal(t.status, "satisfied"); assert.equal(t.satisfiedByEventId, ev.id);
  assert.equal(h.rt.store.get("callback_requests", "cb-1")!.data.completed_contact_id, "contact-2");
  await assert.rejects(h.run("4.3", "contact.log", COMMS_AGENT, { id: "contact-3", data: { channel: "voice", stated_deadline_not_in_view: true } }), refusedWith("FACTS_FROM_VIEW"));
  assert.deepEqual(h.ctx.timers.evaluate("2026-10-14T05:00:00.000Z").map((b) => b.def.code), ["REGX_1024_40A2_AVAILABILITY_UNTIL_RELEASE"]);   // the live response was made on 10-13: only the (unrun) daily availability check breaches
});
test('4.3-T5: Given a borrower says "I want a person," then a warm transfer to `human_agent` occurs within the call, logged with `human_transfer_requested=true`.', async () => {
  assert.deepEqual(handleUtterance("I want a person"), { human_transfer_requested: true, action: "warm_transfer_now" });
  assert.deepEqual(handleUtterance("what is my balance"), { human_transfer_requested: false, action: "continue" });
  const h = harness("2026-10-09T15:00:00.000Z");
  await h.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", team_name: TEAM.team_name, named_human: "Dana", direct_number: TEAM.direct_number, hours: TEAM.hours });
  await h.run("4.3", "human.transfer", COMMS_AGENT, { utterance: "I want a person", reason: "borrower asked for a person", payload: { call_id: "call-1", warm_transfer: true } }, "2026-10-09T15:04:00.000Z");
  const esc = h.rt.escalations.opened[0]!; assert.equal(esc.kind, "human_agent"); assert.equal(esc.ownerRole, "human_agent"); assert.equal(esc.loanId, "L-1");
  assert.equal(h.decisions.at(-1)!.ruleCode, "human_transfer_requested=true"); assert.equal(h.decisions.at(-1)!.action, "human.transfer");
  assert.equal(h.events.ofType("escalation.created").length, 1);
  // the call is logged within the call with `human_transfer_requested=true`; the warm transfer to the named human completes it
  const logged = (await h.run("4.3", "contact.log", COMMS_AGENT, { id: "call-1", data: { channel: "voice", live_contact: true, disclosure_given: true, human_transfer_requested: true, human_transfer_completed_at: "2026-10-09T15:05:00.000Z" } }, "2026-10-09T15:05:00.000Z")).output as Record<string, unknown>;
  assert.deepEqual([logged.human_transfer_requested, logged.disclosure_given, logged.by_assigned_personnel, logged.episode_id], [true, true, true, "ep-L-1"]);
  const ev = h.events.ofType("contact.logged")[0]!; assert.equal(ev.payload.human_transfer_requested, true); assert.equal(ev.payload.id, "call-1");
  assert.equal(h.rt.store.get("contacts", "call-1")!.data.human_transfer_completed_at, "2026-10-09T15:05:00.000Z");
  assert.equal(handleUtterance("can I talk to a representative").action, "warm_transfer_now");
});
test("4.3-T6: Given a permanent modification effective 2027-03-01 and on-time payments on 2027-03-12 and 2027-04-10, then release on 2027-04-10; given the second payment is late (late charge posted), then no release and the counter resets.", async () => {
  const e: Episode = { status: "assigned", consecutive_on_time: 0, mode: "ai_first_named_human", team: "default" };
  const p1 = C.onPermanentPayment(e, { due_date: D("2027-03-01"), received_on: D("2027-03-12"), grace_days: 15, permanent_agreement: true });
  assert.equal(p1.on_time, true); assert.equal(e.consecutive_on_time, 1); assert.equal(e.status, "assigned"); assert.equal(p1.release_on, null);
  const p2 = C.onPermanentPayment(e, { due_date: D("2027-04-01"), received_on: D("2027-04-10"), grace_days: 15, permanent_agreement: true });
  assert.equal(e.consecutive_on_time, 2); assert.equal(e.status, "released"); assert.equal(p2.release_on, "2027-04-10");
  const e2: Episode = { status: "assigned", consecutive_on_time: 0, mode: "ai_first_named_human", team: "default" };
  C.onPermanentPayment(e2, { due_date: D("2027-03-01"), received_on: D("2027-03-12"), grace_days: 15, permanent_agreement: true });
  const late = C.onPermanentPayment(e2, { due_date: D("2027-04-01"), received_on: D("2027-04-17"), grace_days: 15, late_charge_posted: true, permanent_agreement: true });
  assert.equal(late.on_time, false); assert.equal(e2.consecutive_on_time, 0); assert.equal(e2.status, "assigned"); assert.equal(late.release_on, null);
  const trial: Episode = { status: "assigned", consecutive_on_time: 0, mode: "ai_first_named_human", team: "default" };
  C.onPermanentPayment(trial, { due_date: D("2027-01-01"), received_on: D("2027-01-05"), permanent_agreement: false }); C.onPermanentPayment(trial, { due_date: D("2027-02-01"), received_on: D("2027-02-05"), permanent_agreement: false });
  assert.deepEqual([trial.status, trial.consecutive_on_time], ["assigned", 0]);                                               // trial-period payments never count
  // on the bus: the release gate opens with the permanent agreement and closes on the second consecutive on-time payment; an early release is refused
  const h = harness("2027-03-01T15:00:00.000Z");
  await h.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", team_name: TEAM.team_name, named_human: "Dana", direct_number: TEAM.direct_number });
  // a trial period plan never opens the gate (rule 3: "the agreement must be *permanent*"); the 12.x permanent agreement taking effect does
  await assert.rejects(h.run("4.3", "continuity.permanent_agreement.record", COMMS_AGENT, { agreement_id: "tpp-1", kind: "trial", effective_on: "2026-12-01" }), refusedWith("PERMANENT_ONLY"));
  assert.equal(h.timer("REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS").length, 0);
  const agr = (await h.run("4.3", "continuity.permanent_agreement.record", COMMS_AGENT, { agreement_id: "mod-1", kind: "permanent", effective_on: "2027-03-01", payment_due_day: 1, grace_days: 15 })).output as Record<string, unknown>;
  assert.deepEqual([agr.agreement_id, agr.effective_on, agr.episode_id], ["mod-1", "2027-03-01", "ep-L-1"]);
  const eff = h.events.ofType("lossmit.permanent_agreement.effective")[0]!; assert.deepEqual([eff.payload.agreement_id, eff.payload.kind, eff.payload.grace_days], ["mod-1", "permanent", 15]);
  assert.equal(h.rt.store.get("continuity_episodes", "ep-L-1")!.data.permanent_agreement_id, "mod-1");
  const gate = h.timer("REGX_1024_40A2_RELEASE_2_PERMANENT_PAYMENTS")[0]!; assert.equal(gate.status, "armed"); assert.equal(gate.armedByEventId, eff.id); assert.equal(gate.dueAt, undefined);   // a gate: no due date, closes on `continuity.released`
  await assert.rejects(h.run("4.3", "continuity.release", COMMS_AGENT, { reason: "two_consecutive_permanent_payments" }), refusedWith("RELEASE_NOT_EARNED"));
  await assert.rejects(h.run("4.3", "continuity.release", COMMS_AGENT, { reason: "borrower_asked" }), refusedWith("RELEASE_REASON"));
  const b1 = (await h.run("4.3", "continuity.permanent_payment.record", COMMS_AGENT, { due_date: "2027-03-01", received_on: "2027-03-12", grace_days: 15, permanent_agreement: true }, "2027-03-12T15:00:00.000Z")).output as { consecutive_on_time: number; release_on: string | null };
  assert.deepEqual([b1.consecutive_on_time, b1.release_on], [1, null]); assert.equal(gate.status, "armed");
  await assert.rejects(h.run("4.3", "continuity.release", COMMS_AGENT, { reason: "two_consecutive_permanent_payments" }), refusedWith("RELEASE_NOT_EARNED"));
  const b2 = (await h.run("4.3", "continuity.permanent_payment.record", COMMS_AGENT, { due_date: "2027-04-01", received_on: "2027-04-10", grace_days: 15, permanent_agreement: true }, "2027-04-10T15:00:00.000Z")).output as { consecutive_on_time: number; release_on: string | null; status: string };
  assert.deepEqual([b2.consecutive_on_time, b2.release_on, b2.status], [2, "2027-04-10", "released"]);
  assert.equal(gate.status, "satisfied"); assert.equal(h.events.ofType("continuity.released")[0]!.payload.reason, "two_consecutive_permanent_payments"); assert.equal(h.rt.store.get("continuity_episodes", "ep-L-1")!.data.release_reason, "two_consecutive_permanent_payments");
});
test('4.3-T7: (CA) Given a §2924.15 loan and a chat message "can I get help with my payments," then a human SPOC is assigned and a direct means of communication is sent within 2 servicer BD; the SPOC persists after the borrower is denied a modification until the appeal is decided.', async () => {
  const r = caSpocRequest({ state: "CA", s2924_15: true, text: "can I get help with my payments", requested_on: D("2026-10-09"), lossmit: { current: false, determination: "pending", appeal_pending: false } });
  assert.deepEqual(r, { spoc_required: true, assistance_requested: true, assign_by: "2026-10-14", assignment_mode: "human_team", direct_means: ["direct_number", "direct_email"], notice: "NTC_CA_2923_7_SPOC", persists: true });
  assert.equal(C.caSpocDue(D("2026-10-09")), "2026-10-14");                                                                    // Fri 10-09 + 2 servicer BD, Columbus Day 10-12 closed
  assert.equal(C.caSpocPersists({ current: false, determination: "denied", appeal_pending: true }), true);                     // denied, appeal pending → the SPOC stays
  assert.equal(C.caSpocPersists({ current: false, determination: "denied", appeal_pending: false }), false);                   // appeal decided → options exhausted
  assert.equal(C.caSpocPersists({ current: true, determination: null, appeal_pending: false }), false);
  assert.equal(caSpocRequest({ state: "TX", s2924_15: false, text: "can I get help with my payments", requested_on: D("2026-10-09"), lossmit: { current: false, determination: null, appeal_pending: false } }).spoc_required, false);
  const h = harness("2026-10-09T15:00:00.000Z");
  // the chat widget ingests the message: the session opens the 5-minute first-response clock (A4-2.1-04) and the request for help opens the CA SPOC clock
  const msg = (await h.run("4.3", "chat.message.receive", COMMS_AGENT, { channel: "chat", session_id: "chat-1", text: "can I get help with my payments", state: "CA", s2924_15: true })).output as Record<string, unknown>;
  assert.deepEqual([msg.session_started, msg.assistance_requested, msg.spoc_required, msg.assign_by, msg.first_response_due_at], [true, true, true, "2026-10-14", "2026-10-09T15:05:00.000Z"]);
  const started = h.events.ofType("chat.session.started")[0]!; assert.equal(started.payload.session_id, "chat-1");
  const chat = h.timer("FNMA_A4_2_1_04_CHAT_5MIN")[0]!; assert.equal(chat.armedByEventId, started.id); assert.equal(chat.dueAt, Date.parse("2026-10-09T15:05:00.000Z"));
  const asked = h.events.ofType("lossmit.assistance.requested")[0]!; assert.deepEqual([asked.payload.state, asked.payload.s2924_15, asked.payload.channel, asked.payload.requested_on, asked.payload.ca_spoc_assign_by], ["CA", true, "chat", "2026-10-09", "2026-10-14"]);
  assert.equal(h.timer("CA_CIV_2923_7_SPOC_ASSIGN_PROMPT")[0]!.dueDate, "2026-10-14"); assert.equal(h.timer("CA_CIV_2923_7_SPOC_ASSIGN_PROMPT")[0]!.armedByEventId, asked.id);
  await assert.rejects(h.run("4.3", "chat.respond", COMMS_AGENT, { session_id: "chat-1", text: "your deadline is next week", stated_deadline_not_in_view: true }), refusedWith("FACTS_FROM_VIEW"));
  const reply = (await h.run("4.3", "chat.respond", COMMS_AGENT, { session_id: "chat-1", text: "Yes — this is an automated assistant; say 'representative' at any time. Let me look at your options." }, "2026-10-09T15:02:00.000Z")).output as Record<string, unknown>;
  assert.deepEqual([reply.first, reply.response_seconds], [true, 120]); assert.equal(chat.status, "satisfied"); assert.equal(chat.satisfiedByEventId, h.events.ofType("chat.first_response.sent")[0]!.id);
  await h.run("4.3", "chat.respond", COMMS_AGENT, { session_id: "chat-1", text: "Here is what we can offer." }, "2026-10-09T15:03:00.000Z");
  assert.equal(h.events.ofType("chat.first_response.sent").length, 1); assert.equal(h.events.ofType("chat.response.sent").length, 1);   // only the first response is the A4-2.1-04 first response
  await h.run("4.3", "chat.message.receive", COMMS_AGENT, { channel: "chat", session_id: "chat-1", text: "thanks", state: "CA", s2924_15: true }, "2026-10-09T15:04:00.000Z");
  assert.equal(h.timer("FNMA_A4_2_1_04_CHAT_5MIN").length, 1); assert.equal(h.timer("CA_CIV_2923_7_SPOC_ASSIGN_PROMPT").length, 1);   // a later message on the same session opens no second session and asks for nothing
  await assert.rejects(h.run("4.3", "chat.message.receive", COMMS_AGENT, { channel: "chat", session_id: "chat-2", text: "", state: "CA", s2924_15: true }), refusedWith("MESSAGE_TEXT"));
  await assert.rejects(h.run("4.3", "chat.message.receive", COMMS_AGENT, { channel: "chat", session_id: "chat-2", text: "help", state: "CA" }), (e: unknown) => e instanceof RangeError && /s2924_15/.test(e.message));   // a CA loan must state its §2924.15 status
  const h2 = harness("2026-10-09T15:00:00.000Z");
  await h2.run("4.3", "chat.message.receive", COMMS_AGENT, { channel: "chat", session_id: "chat-9", text: "can I get help with my payments", state: "CA", s2924_15: false });
  assert.equal(h2.timer("CA_CIV_2923_7_SPOC_ASSIGN_PROMPT").length, 0); assert.equal(h2.events.ofType("lossmit.assistance.requested")[0]!.payload.ca_spoc_required, false);   // not a §2924.15 loan: no SPOC clock (§2923.7(f))
  await assert.rejects(h.run("4.3", "continuity.ca_spoc.assign", COMMS_AGENT, { mode: "ai_first_named_human", spoc_name: "AI assistant", direct_means: ["direct_number"] }, "2026-10-13T15:00:00.000Z"), refusedWith("CA_SPOC_HUMAN"));   // the SPOC of record is human
  await assert.rejects(h.run("4.3", "continuity.ca_spoc.assign", COMMS_AGENT, { mode: "human_team", spoc_name: TEAM.team_name, direct_means: [] }), refusedWith("CA_SPOC_DIRECT_MEANS"));
  await h.run("4.3", "continuity.ca_spoc.assign", COMMS_AGENT, { mode: "human_team", spoc_name: TEAM.team_name, direct_means: ["direct_number", "direct_email"], requested_on: "2026-10-09" });
  assert.equal(h.events.ofType("continuity.ca_spoc_assigned")[0]!.payload.direct_means_sent, true); assert.equal(h.events.ofType("continuity.ca_spoc_assigned")[0]!.payload.notice, "NTC_CA_2923_7_SPOC");
  assert.equal(h.timer("CA_CIV_2923_7_SPOC_ASSIGN_PROMPT")[0]!.status, "satisfied"); assert.equal(h.timer("CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT")[0]!.status, "armed");
  h.events.append({ type: "lossmit.determination.sent", loanId: "L-1", actor: SYSTEM, payload: { outcome: "denied", appeal_available: true } });
  assert.equal(h.timer("CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT")[0]!.status, "armed");                                   // the SPOC gate stays through the appeal
  await assert.rejects(h.run("4.3", "continuity.ca_spoc.release", COMMS_AGENT, { reason: "options_exhausted" }, "2026-11-10T15:00:00.000Z"), refusedWith("CA_SPOC_APPEAL_PENDING"));
  await assert.rejects(h.run("4.3", "continuity.ca_spoc.release", COMMS_AGENT, { reason: "borrower_asked" }), refusedWith("CA_SPOC_RELEASE_REASON"));
  h.events.append({ type: "lossmit.appeal.decided", loanId: "L-1", actor: SYSTEM, payload: { outcome: "upheld", decided_on: "2026-11-20" } });
  await h.run("4.3", "continuity.ca_spoc.release", COMMS_AGENT, { reason: "options_exhausted", appeal_decided_on: "2026-11-20" }, "2026-11-20T15:00:00.000Z");
  assert.equal(h.timer("CA_CIV_2923_7_SPOC_UNTIL_EXHAUSTED_OR_CURRENT")[0]!.status, "satisfied");
});
test("4.3-T8: (accuracy) Given a scripted call asking the five (b)(1) facts, then every statement matches `lossmit_facts` for the loan (evaluation harness, 100% agreement required for release).", () => {
  const facts = { options_available: ["repayment plan", "Flex Modification"], missing_documents: ["pay stubs"], application_status: "incomplete", foreclosure_referral: "not before day 121", deadline: "2026-10-24" };
  const good = accuracyHarness([{ fact: "options_available", value: ["repayment plan", "Flex Modification"] }, { fact: "missing_documents", value: ["pay stubs"] }, { fact: "application_status", value: "incomplete" }, { fact: "foreclosure_referral", value: "not before day 121" }, { fact: "deadline", value: "2026-10-24" }], facts);
  assert.deepEqual(good, { agreement_pct: 100, release: true, mismatches: [] });
  const bad = accuracyHarness([{ fact: "deadline", value: "2026-10-31" }, { fact: "application_status", value: "incomplete" }], facts); assert.equal(bad.release, false); assert.deepEqual(bad.mismatches, ["deadline"]);
});
test("4.3-T9: (bankruptcy) Given a Chapter 13 filing, then reassignment to the bankruptcy-specialist team without a new episode.", async () => {
  const e: Episode = { status: "assigned", consecutive_on_time: 1, mode: "ai_first_named_human", team: "default" };
  const same = C.bankruptcyReassign(e);
  assert.equal(same, e);                                                                                                       // the same episode object — no new episode
  assert.deepEqual(e, { status: "assigned", consecutive_on_time: 1, mode: "ai_first_named_human", team: "bankruptcy_specialist" });
  const h = harness("2026-10-09T15:00:00.000Z");
  await h.run("4.3", "continuity.assign", COMMS_AGENT, { team: "default", team_name: TEAM.team_name, named_human: "Dana", direct_number: TEAM.direct_number });
  const r = (await h.run("4.3", "continuity.bankruptcy.reassign", COMMS_AGENT, { reason: "chapter_13_filed" })).output as { episode_id: string; team: string; new_episode: boolean };
  assert.deepEqual(r, { episode_id: "ep-L-1", team: "bankruptcy_specialist", new_episode: false });
  assert.equal(h.rt.store.get("continuity_episodes", "ep-L-1")!.data.team, "bankruptcy_specialist"); assert.equal(h.events.ofType("continuity.assigned").length, 1); assert.equal(h.events.ofType("continuity.reassigned").length, 1);
});
test("4.3-T10: (metrics) Given a month of CDRs with ASA 75s, then the A4-2.1-04 report flags the miss and an `officer` remediation task opens.", () => {
  const m = callMetrics({ offered: 1000, answered_seconds: Array.from({ length: 900 }, () => 75), abandoned: 30, blocked: 5 });
  assert.equal(m.asa_seconds, 75); assert.deepEqual(m.misses, ["ASA 75s > 60s"]); assert.equal(m.officer_task, "a4_2_1_04_remediation");
  assert.equal(callMetrics({ offered: 1000, answered_seconds: [45, 50], abandoned: 30, blocked: 5 }).officer_task, null);
});
test("4.3-T11: (AI off) Given `continuity.ai_first=off` for state XX, then calls route to the human queue and the assignment record shows `human_team`.", () => {
  assert.deepEqual(routeCall("XX", new Set(["XX"])), { queue: "human", assignment_mode: "human_team" });
  assert.deepEqual(routeCall("TX", new Set(["XX"])), { queue: "ai_first", assignment_mode: "ai_first_named_human" });
});
test("4.3-T12: (transfer-out) Given transfer-out on 2026-11-01, then the episode closes with `transfer_out` and the transfer file includes the assignment and open callbacks.", () => {
  const e: Episode = { status: "assigned", consecutive_on_time: 1, mode: "ai_first_named_human", team: "default" };
  const r = closeForTransferOut(e, [{ id: "cb-1" }, { id: "cb-2" }], D("2026-11-01"));
  assert.equal(r.close_reason, "transfer_out"); assert.equal(e.status, "released"); assert.deepEqual(r.transfer_file.open_callbacks, ["cb-1", "cb-2"]); assert.equal(r.transfer_file.closed_on, "2026-11-01");
});
