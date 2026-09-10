// 12.1 Acknowledge loss-mit application
// spec/sections/12-loss-mitigation/12-1-acknowledge-loss-mit-application.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addDays } from "../../kernel/calendar/date.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, eventMatches, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/index.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { CommandBus, CommandRefused, type CommandSpec } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput, type ToolDef } from "../../app/tools.ts";
import { SECTION_12_TOOLS } from "../../app/tools/section12.ts";
import { TOOLS_12_1 } from "../../app/tools/section12-1.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { NoticeService } from "../../notices/service.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { facialCompletion, rfaFlow, aiOutageFallback, caPerDocumentAcks, nprmRfa, ackBreach, duplicativeDetermination, ACK_TIMER_CODES } from "./ops.ts";
import { ackDue, classify, completeness, reasonableDate, fortyFiveDayTest, duplicative } from "./application.ts";
import { documentReceipt, carryoverIntake, reasonableDateDecision, ackBreachResponse, facialHold } from "./ops-12-1.ts";

const registry = () => { const reg = buildRegistry(); publishAuthored(reg); return reg; };

// ---- the 12.1 tools on the command bus with a TimerEngine over the overridden registry. The 12.1 rows the manifest lists
// are owned by four processes in the registry (11.5's REGX_1024_41B2_LM_ACK_5, 1.7's REGX_1024_41K2_TRANSFEREE_ACK_10,
// 4.4's REGX_1024_38B1VI_SII_LOSSMIT_INTERFERENCE, 11.2's FNMA_D2204_SOLICITATION_45), so the engine arms those too.
const AGENT: Actor = { kind: "agent", id: "lossmit-underwriter" };
const LOAN = "L-121";
const NY = "America/New_York";
const PROCESSES = ["12.1", "11.5", "1.7", "4.4", "11.2"];
const RECIPIENTS = [{ partyId: "b1", name: "Borrower", mailingAddress: "1 Test St, Testville TX 75001" }];
const DEFS: readonly ToolDef[] = [...SECTION_12_TOOLS.filter((d) => d.process === "12.1"), ...TOOLS_12_1];
const OPEN = "lossmit.application.open/update";
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: PROCESSES });
  const uow: UowContext = { loanId: LOAN, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push(d); } };
  const noticeReg = registry(); const printMail = new FakePrintMail();
  const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store: new EntityStore(), escalations, services: {}, notices: new NoticeService({ registry: noticeReg, events, clock, printMail, edelivery: new FakeEdelivery() }), ports: { printMail, edelivery: new FakeEdelivery() } };
  const escalates = new Map(loadAgentsFile().processes.map((p) => [p.process, p.escalates_to] as const));
  const agents = new AgentRegistry(); const cmds = new Map<string, CommandSpec<ToolInput, unknown>>();
  for (const d of DEFS) { const cmd = toolCommand(d, rt, escalates.get(d.process) ?? []); agents.registerTool(d.agent, cmd.name); cmds.set(d.name, cmd); }
  const bus = new CommandBus(agents);
  const run = async (name: string, input: ToolInput): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, AGENT, { loan_id: LOAN, ...input }, uow)).output as Record<string, unknown>;
  const refused = (name: string, input: ToolInput, code: string) => assert.rejects(bus.execute(cmds.get(name)!, AGENT, { loan_id: LOAN, ...input }, uow), (e: unknown) => e instanceof CommandRefused && e.code === code);
  /** Render + send a 12.1 template through the 12.1 `notice.render_send` tool (sample payload + overrides) — the Notice Service's `notice.sent{template}` is what satisfies the acknowledgment clocks. */
  const send = (code: string, payload: Record<string, unknown>, extra: ToolInput = {}) => run("notice.render_send", { template_code: code, recipients: RECIPIENTS, payload: { ...noticeReg.activeVersion(code, D(clock.now().slice(0, 10)))!.samplePayload, ...payload }, ...extra });
  const timer = (code: string) => timers.byCode(code);
  const emitted = (type: string) => events.all().filter((e) => e.type === type);
  return { uow, rt, events, timers, clock, printMail, escalations, run, refused, send, timer, emitted, noticeReg, decisions };
}

test("12.1-T1: (happy path) Given a borrower's portal submission Thu 2026-09-10 with Form 710 and two paystubs, when classified, then `NTC_REGX_41B2_ACK_INCOMPLETE` (missing bank statements, co-borrower signature) is sent by 2026-09-17 with reasonable date 2026-10-15 and the basis recorded.", async () => {
  assert.equal(classify({ has_evaluative_info: true, confidence: 0.9 }), "application");
  const c = completeness([{ item: "form_710", source: "borrower", status: "received" }, { item: "paystubs", source: "borrower", status: "received" }, { item: "bank statements", source: "borrower", status: "missing" }, { item: "co-borrower signature", source: "borrower", status: "missing" }, { item: "valuation", source: "third_party", status: "missing" }]);
  assert.equal(c.complete, false); assert.deepEqual(c.missing, ["bank statements", "co-borrower signature"]);
  assert.equal(ackDue(D("2026-09-10")).due_on, "2026-09-17");
  // Given: the portal submission on Thu 2026-09-10 — the receipt arms the Reg X federal-business-day clock and Fannie Mae's servicer-day twin, both due Thu 2026-09-17.
  const h = harness("2026-09-10T14:00:00.000Z");
  const app = await h.run(OPEN, { id: "lma-1", has_evaluative_info: true, received_on: "2026-09-10", receipt_channel: "portal", state: "TX", sale_on: "2027-01-15" });
  assert.equal(app.status, "incomplete"); assert.equal(app.ack_due, "2026-09-17"); assert.equal(app.protection_tier, "ge_90");
  assert.equal(h.emitted("lossmit.application.received").length, 1);
  for (const code of ACK_TIMER_CODES) { const t = h.timer(code); assert.equal(t.length, 1, code); assert.equal(t[0]!.dueDate, "2026-09-17", code); assert.equal(t[0]!.status, "armed"); }
  // When: the ack goes out Tue 2026-09-15 — the reasonable-date decision (rule 5 worked example) is recorded on the application with every milestone it evaluated.
  h.clock.set("2026-09-15T15:00:00.000Z");
  const upd = await h.run(OPEN, { id: "lma-1", op: "update", status: "incomplete", has_evaluative_info: true, received_on: "2026-09-10", ack_sent_on: "2026-09-15", earliest_unpaid_due: "2026-08-01", oldest_doc_date: "2026-08-20" });
  assert.equal(upd.reasonable_date, "2026-10-15"); assert.equal(upd.milestone_conflict, false);
  const basis = upd.reasonable_date_basis as Record<string, unknown>;
  assert.equal(basis.chosen, "ack+30"); assert.equal(basis.default_ack_plus_30, "2026-10-15"); assert.equal(basis.day_120_of_delinquency, "2026-11-28"); assert.equal(basis.sale_minus_90, "2026-10-17"); assert.equal(basis.sale_minus_38, "2026-12-08"); assert.equal(basis.doc_staleness_90, "2026-11-18"); assert.equal(basis.floor_ack_plus_7, "2026-09-22");
  const rd = reasonableDate({ ack_sent_on: D("2026-09-15"), earliest_unpaid_due: D("2026-08-01"), sale_on: D("2027-01-15"), oldest_doc_date: D("2026-08-20") });
  assert.equal(rd.date, "2026-10-15"); assert.equal(rd.basis, "ack+30"); assert.equal(rd.milestone_conflict, false);
  // Then: the canonical (b)(2) acknowledgment carries the missing items, the reasonable date, the D2-2-05 Incomplete Information Notice content and the other-lien statement …
  const v = h.noticeReg.activeVersion("NTC_REGX_41B2_ACK_INCOMPLETE", D("2026-09-15"))!; assert.equal(v.version, "1.1.0");
  const payload = { ...v.samplePayload, received_date: "2026-09-10", missing_documents: c.missing, reasonable_date: rd.date, days_to_reasonable_date: 30, business_days_after_receipt: 3 };
  const out = render(v.source, payload); const check = evaluateChecklist(v, payload, out);
  assert.equal(check.passed, true, JSON.stringify(check.blocking));
  assert.match(out.text, /bank statements; co-borrower signature; by October 15, 2026/); assert.match(out.text, /consider contacting the servicers of those loans/); assert.match(out.text, /does not by itself guarantee/); assert.match(out.text, /toll-free at \(800\) 555-0177/); assert.match(out.text, /HUD \(800\) 569-4287/);
  assert.equal(evaluateChecklist(v, { ...payload, days_to_reasonable_date: 5 }, out).blocking.some((b) => b.rule_id === "reasonable-date"), true);
  // … and its `notice.sent{template}` on 2026-09-15 (≤ 2026-09-17) satisfies both acknowledgment clocks in time and arms the 30-day reasonable-date clock (due 2026-10-15).
  const sent = await h.send("NTC_REGX_41B2_ACK_INCOMPLETE", payload, { application_id: "lma-1" });
  assert.equal(sent.status, "sent"); assert.equal(h.emitted("notice.sent").at(-1)!.payload.template, "NTC_REGX_41B2_ACK_INCOMPLETE");
  for (const code of ACK_TIMER_CODES) { const t = h.timer(code)[0]!; assert.equal(t.status, "satisfied", code); assert.ok(t.satisfiedAt!.slice(0, 10) <= t.dueDate!); }
  const rdTimer = h.timer("REGX_1024_41B2II_REASONABLE_DATE"); assert.equal(rdTimer.length, 1); assert.equal(rdTimer[0]!.dueDate, "2026-10-15");
});
test("12.1-T2: (holiday arithmetic) received Fri 2026-11-20 → ack due Mon 2026-11-30 (Thanksgiving excluded); timer due_at equals 2026-11-30 23:59 servicer-local.", async () => {
  const due = ackDue(D("2026-11-20"));
  assert.equal(due.due_on, "2026-11-30"); assert.equal(due.due_at_ms, zonedEpochMs(D("2026-11-30"), "23:59", NY));
  assert.equal(ackDue(D("2026-09-10")).due_on, "2026-09-17");
  // The registry row armed from the receipt: 5 `business_days_federal` from `received_date` — Nov 23, 24, 25, 27, 30 (Nov 26 Thanksgiving excluded) — due_at 23:59 servicer-local.
  const h = harness("2026-11-20T15:00:00.000Z");
  const app = await h.run(OPEN, { id: "lma-2", has_evaluative_info: true, received_on: "2026-11-20" });
  assert.equal(app.ack_due, "2026-11-30");
  const t = h.timer("REGX_1024_41B2_LM_ACK_5"); assert.equal(t.length, 1);
  assert.equal(t[0]!.anchorDate, "2026-11-20"); assert.equal(t[0]!.dueDate, "2026-11-30"); assert.equal(t[0]!.dueAt, zonedEpochMs(D("2026-11-30"), "23:59", NY));
  assert.equal(new Date(t[0]!.dueAt!).toISOString(), "2026-12-01T04:59:00.000Z");
  assert.equal(h.timer("FNMA_D2205_BRP_ACK_5BD")[0]!.dueDate, "2026-11-30");   // the servicer calendar observes Thanksgiving too
  // An acknowledgment sent Mon 2026-11-30 is in time; nothing breaches at the end of that day.
  h.clock.set("2026-11-30T20:00:00.000Z");
  await h.send("NTC_REGX_41B2_ACK_INCOMPLETE", { notice_date: "2026-11-30", received_date: "2026-11-20", reasonable_date: "2026-12-30", days_to_reasonable_date: 30, business_days_after_receipt: 5 }, { application_id: "lma-2" });
  assert.equal(t[0]!.status, "satisfied"); assert.equal(h.timers.evaluate("2026-12-01T04:58:00.000Z").length, 0);
});
test("12.1-T3: (milestone cap and floor) (a) sale 2026-11-20, ack sent 2026-09-15 → reasonable date = min(2026-10-15, sale−38 = 2026-10-13) = **2026-10-13**; (b) same sale, ack sent 2026-10-08 → cap 2026-10-13 is earlier than the 7-day floor 2026-10-15 → the floor wins (comment 41(b)(2)(ii)-3; comment 41(k)(2)-1 logic) → **2026-10-15**, and `milestone_conflict=true` routes the file to `lossmit_reviewer` for expedited handling.", async () => {
  const a = reasonableDate({ ack_sent_on: D("2026-09-15"), earliest_unpaid_due: D("2026-08-01"), sale_on: D("2026-11-20"), oldest_doc_date: null });
  assert.equal(a.date, "2026-10-13"); assert.equal(a.basis, "sale-38"); assert.equal(a.milestone_conflict, false);
  const da = reasonableDateDecision({ ack_sent_on: D("2026-09-15"), earliest_unpaid_due: D("2026-08-01"), sale_on: D("2026-11-20"), oldest_doc_date: null });
  assert.equal(da.reasonable_date, "2026-10-13"); assert.equal(da.escalation, null); assert.equal(da.reasonable_date_basis.sale_minus_38, "2026-10-13"); assert.equal(da.reasonable_date_basis.default_ack_plus_30, "2026-10-15");
  const b = reasonableDate({ ack_sent_on: D("2026-10-08"), earliest_unpaid_due: D("2026-08-01"), sale_on: D("2026-11-20"), oldest_doc_date: null });
  assert.equal(b.date, "2026-10-15"); assert.equal(b.milestone_conflict, true); assert.match(b.basis, /floor ack\+7/);
  // (b) on the bus: the decision recorded on the application carries the conflict and the file is routed to lossmit_reviewer.
  const h = harness("2026-10-08T14:00:00.000Z");
  await h.run(OPEN, { id: "lma-3", has_evaluative_info: true, received_on: "2026-10-01", sale_on: "2026-11-20" });
  const r = await h.run(OPEN, { id: "lma-3", op: "update", status: "incomplete", has_evaluative_info: true, received_on: "2026-10-01", ack_sent_on: "2026-10-08", earliest_unpaid_due: "2026-08-01" });
  assert.equal(r.reasonable_date, "2026-10-15"); assert.equal(r.milestone_conflict, true);
  const basis = r.reasonable_date_basis as Record<string, unknown>; assert.equal(basis.sale_minus_38, "2026-10-13"); assert.equal(basis.floor_ack_plus_7, "2026-10-15"); assert.match(String(basis.chosen), /floor ack\+7 \(cap sale-38 earlier\)/);
  const esc = h.escalations.opened; assert.equal(esc.length, 1); assert.equal(esc[0]!.kind, "lossmit_reviewer"); assert.equal(esc[0]!.ownerRole, "lossmit_reviewer"); assert.match(String(esc[0]!.payload.reason), /milestone_conflict.*expedited/);
  assert.equal(h.emitted("escalation.created").length, 1);
});
test("12.1-T4: (facially complete) all listed items received 2026-10-01 → `facially_complete_at=2026-10-01`; verification finds a stale paystub → supplemental request 2026-10-02 with date ≥2026-10-09; `foreclosure_holds{kind=regx_f2_prefiling}` active throughout; borrower complies 2026-10-07 → `deemed_complete_date=2026-10-01`, `complete_at=2026-10-07`; (c)(3) notice by 2026-10-14.", async () => {
  const items = ["form_710", "paystubs", "bank_statement", "hardship_letter"];
  const r = facialCompletion({ required_items: items, received: items.map((item) => ({ item, on: D("2026-10-01") })), verification: { stale_item: "paystubs", found_on: D("2026-10-02") }, borrower_complied_on: D("2026-10-07") });
  assert.equal(r.facially_complete_at, "2026-10-01"); assert.equal(r.supplemental_request!.on, "2026-10-02"); assert.ok(r.supplemental_request!.respond_by >= "2026-10-09");
  assert.deepEqual(r.holds.map((h) => [h.kind, h.active]), [["regx_f2_prefiling", true]]);
  assert.equal(r.deemed_complete_date, "2026-10-01"); assert.equal(r.complete_at, "2026-10-07");
  // 5 federal business days from 2026-10-07 skip Columbus Day (2026-10-12): the (c)(3) notice is due 2026-10-15 (the spec's 10-14 counts the holiday; see docs/AUDIT-NOTES.md).
  assert.equal(r.c3_notice_by, "2026-10-15");
  assert.equal(facialCompletion({ required_items: items, received: items.slice(1).map((item) => ({ item, on: D("2026-10-01") })) }).facially_complete_at, null);
  assert.equal(facialHold({ facially_complete_on: D("2026-10-01"), first_filing_made: false }).kind, "regx_f2_prefiling"); assert.equal(facialHold({ facially_complete_on: D("2026-10-01"), first_filing_made: true }).kind, "regx_g_dual_track");
  // On the bus: the last listed item arrives 2026-10-01 → `lossmit.application.facially_complete` arms the (c)(2)(iv) gate and the pre-filing hold is written.
  const h = harness("2026-09-10T14:00:00.000Z");
  await h.run(OPEN, { id: "lma-4", has_evaluative_info: true, received_on: "2026-09-10" });
  h.clock.set("2026-10-01T14:00:00.000Z");
  await h.run(OPEN, { id: "lma-4", op: "update", status: "facially_complete", has_evaluative_info: true, received_on: "2026-09-10", facially_complete_on: "2026-10-01" });
  const facial = h.emitted("lossmit.application.facially_complete"); assert.equal(facial.length, 1); assert.equal(facial[0]!.payload.facially_complete_at, "2026-10-01");
  const gate = h.timer("REGX_1024_41C2IV_FACIALLY_COMPLETE_HOLD"); assert.equal(gate.length, 1); assert.equal(gate[0]!.status, "armed"); assert.equal(gate[0]!.dueAt, undefined);
  const hold = () => h.rt.store.get("foreclosure_holds", `hold-${LOAN}-regx_f2_prefiling`)!.data;
  assert.equal(hold().status, "active"); assert.equal(hold().from, "2026-10-01"); assert.deepEqual(hold().scope, ["refer", "first_notice"]);
  assert.equal(h.emitted("foreclosure_holds.opened")[0]!.payload.kind, "regx_f2_prefiling");
  // Verification finds the stale paystub → the supplemental request goes out 2026-10-02 with a date ≥ 2026-10-09; the hold stays active.
  h.clock.set("2026-10-02T14:00:00.000Z");
  const supp = await h.send("NTC_REGX_41B2_SUPPLEMENTAL_REQUEST", { facial_on: "2026-10-01", respond_by: r.supplemental_request!.respond_by });
  assert.equal(supp.status, "sent"); assert.equal(hold().status, "active");
  // The borrower complies 2026-10-07 → deemed complete 2026-10-01 for (d)–(h), complete_at 2026-10-07 for (c); the gate is satisfied, the (c)(3) clock arms.
  h.clock.set("2026-10-07T14:00:00.000Z");
  await h.run(OPEN, { id: "lma-4", op: "update", status: "complete", has_evaluative_info: true, received_on: "2026-09-10", complete_on: "2026-10-07", facially_complete_on: "2026-10-01" });
  const done = h.emitted("lossmit.application.completed"); assert.equal(done.length, 1);
  assert.equal(done[0]!.payload.deemed_complete_date, "2026-10-01"); assert.equal(done[0]!.payload.complete_at, "2026-10-07");
  const app = h.rt.store.get("lossmit_applications", "lma-4")!.data; assert.equal(app.facially_complete_at, "2026-10-01"); assert.equal(app.deemed_complete_date, "2026-10-01"); assert.equal(app.complete_at, "2026-10-07");
  assert.equal(gate[0]!.status, "satisfied"); assert.equal(hold().status, "active");
  const c3 = h.timer("REGX_1024_41C3_COMPLETE_NOTICE_5"); assert.equal(c3.length, 1); assert.equal(c3[0]!.anchorDate, "2026-10-07"); assert.equal(c3[0]!.dueDate, r.c3_notice_by);
  h.clock.set("2026-10-08T14:00:00.000Z");
  await h.send("NTC_REGX_41C3_COMPLETE", { notice_date: "2026-10-08", complete_on: "2026-10-07", decision_by: "2026-11-06" });
  assert.equal(c3[0]!.status, "satisfied");
});
test("12.1-T5: (≤45 days) sale 2026-10-20, received 2026-09-10 → (b)(2) not applicable; `NTC_FNMA_D2205_LATE_BRP_PLAN` within 5 servicer BD; expedited review queued.", async () => {
  const r = fortyFiveDayTest(D("2026-09-10"), D("2026-10-20"));
  assert.deepEqual(r, { b2_applies: false, d2205_notice_due: "2026-09-17" });
  assert.equal(fortyFiveDayTest(D("2026-09-10"), D("2027-01-15")).b2_applies, true); assert.equal(fortyFiveDayTest(D("2026-09-10"), null).b2_applies, true);
  // On the bus: the receipt takes the D2-2-05 plan path — no `lossmit.application.received`, so neither (b)(2) clock arms; the plan notice is due within 5 servicer BD and the expedited review is queued.
  const h = harness("2026-09-10T14:00:00.000Z");
  const app = await h.run(OPEN, { id: "lma-5", has_evaluative_info: true, received_on: "2026-09-10", sale_on: "2026-10-20" });
  assert.equal(app.b2_applies, false); assert.equal(app.days_before_sale, 40); assert.equal(app.protection_tier, "gt_37"); assert.equal(app.d2205_notice, "NTC_FNMA_D2205_LATE_BRP_PLAN");   // 40 days before the sale: (b)(2) does not apply (≤45), yet §1024.41(b)(3) still fixes the >37 tier at receipt assert.equal(app.d2205_notice_due, "2026-09-17"); assert.equal(app.expedited_review, true); assert.deepEqual(app.timers_started, []);
  assert.equal(h.emitted("lossmit.application.received").length, 0); assert.equal(h.emitted("lossmit.application.received_within_45_days").length, 1);
  for (const code of ACK_TIMER_CODES) assert.equal(h.timer(code).length, 0, code);
  // The D2-2-05 "explanation of plan" acknowledgment names the sale, the expedited-review plan, the suspension statement and the no-guarantee statement.
  const v = h.noticeReg.activeVersion("NTC_FNMA_D2205_LATE_BRP_PLAN", D("2026-09-11"))!;
  const payload = { ...v.samplePayload, received_on: "2026-09-10", sale_date: "2026-10-20", days_before_sale: 40 };
  const out = render(v.source, payload); assert.equal(evaluateChecklist(v, payload, out).passed, true);
  assert.match(out.text, /scheduled for October 20, 2026/); assert.match(out.text, /expedited basis/); assert.match(out.text, /sale be suspended if appropriate/);
  assert.equal(evaluateChecklist(v, { ...payload, days_before_sale: 60 }, out).blocking.some((b) => b.rule_id === "within-45"), true);
  h.clock.set("2026-09-11T14:00:00.000Z");
  const sent = await h.send("NTC_FNMA_D2205_LATE_BRP_PLAN", payload);
  assert.equal(sent.status, "sent"); assert.ok(String(sent.sentAt).slice(0, 10) <= "2026-09-17");
});
test("12.1-T6: (duplicative) prior complete application evaluated 2026-03-15, borrower delinquent continuously → new application 2026-09-10 flagged duplicative; `lossmit_reviewer` approves; Fannie Mae evaluation still performed; no (b)(2)/(c)(3) timers started; courtesy notice sent.", async () => {
  assert.equal(duplicative({ prior_complete_by_us: true, prior_fully_processed: true, current_since_prior: false }), true);
  const pending = duplicativeDetermination({ received_on: D("2026-09-10"), prior_complete_on: D("2026-03-15"), prior_fully_processed_by_us: true, current_since_prior: false });
  assert.equal(pending.duplicative, true); assert.equal(pending.reviewer_required, true); assert.match(pending.refusal!, /lossmit_reviewer/); assert.equal(pending.courtesy_notice, null);
  const r = duplicativeDetermination({ received_on: D("2026-09-10"), prior_complete_on: D("2026-03-15"), prior_fully_processed_by_us: true, current_since_prior: false, reviewer_approval_id: "rev-1" });
  assert.equal(r.refusal, null); assert.equal(r.fnma_evaluation_required, true); assert.deepEqual(r.timers_started, []); assert.equal(r.courtesy_notice, "NTC_REGX_41I_DUPLICATIVE");
  const v = registry().activeVersion("NTC_REGX_41I_DUPLICATIVE", D("2026-09-11"))!; assert.equal(evaluateChecklist(v, { ...v.samplePayload, reviewer_approval_id: undefined }, render(v.source, v.samplePayload)).passed, false);
  // On the bus: without the reviewer's approval the intake is refused; with it the application is recorded `duplicative` — no `lossmit.application.received`, so no (b)(2)/(c)(3) clock arms — and the courtesy notice goes out under the reviewer gate.
  const h = harness("2026-09-10T14:00:00.000Z");
  const facts = { has_evaluative_info: true, received_on: "2026-09-10", prior_application_id: "lma-prior", prior_complete_on: "2026-03-15", prior_fully_processed_by_us: true, current_since_prior: false };
  await assert.rejects(h.run(OPEN, { id: "lma-6", ...facts }), /DUPLICATIVE_NEEDS_REVIEWER.*lossmit_reviewer/);
  const app = await h.run(OPEN, { id: "lma-6", ...facts, reviewer_approval_id: "rev-1" });
  assert.equal(app.status, "duplicative"); assert.equal(app.duplicative_of_application_id, "lma-prior"); assert.equal(app.fnma_evaluation_required, true); assert.deepEqual(app.timers_started, []); assert.equal(app.courtesy_notice, "NTC_REGX_41I_DUPLICATIVE");
  assert.equal((app.duplicative_determination as Record<string, unknown>).reviewer_approval_id, "rev-1");
  assert.equal(h.emitted("lossmit.application.received").length, 0); assert.equal(h.emitted("lossmit.application.duplicative").length, 1);
  for (const code of [...ACK_TIMER_CODES, "REGX_1024_41C3_COMPLETE_NOTICE_5", "REGX_1024_41B2II_REASONABLE_DATE"]) assert.equal(h.timer(code).length, 0, code);
  await h.refused("notice.render_send", { template_code: "NTC_REGX_41I_DUPLICATIVE", recipients: RECIPIENTS, payload: { ...v.samplePayload, received_on: "2026-09-10", prior_complete_on: "2026-03-15", reviewer_approval_id: "rev-1" } }, "DENIAL_NEEDS_REVIEWER");
  const sent = await h.send("NTC_REGX_41I_DUPLICATIVE", { received_on: "2026-09-10", prior_complete_on: "2026-03-15", reviewer_approval_id: "rev-1" }, { reviewer_approval_id: "rev-1" });
  assert.equal(sent.status, "sent"); assert.equal(h.emitted("notice.sent").at(-1)!.payload.template, "NTC_REGX_41I_DUPLICATIVE");
  for (const code of ACK_TIMER_CODES) assert.equal(h.timer(code).length, 0, code);
});
test("12.1-T7: (current in between) same but loan brought current 2026-06-01 → full process.", async () => {
  assert.equal(duplicative({ prior_complete_by_us: true, prior_fully_processed: true, current_since_prior: true }), false);
  const r = duplicativeDetermination({ received_on: D("2026-09-10"), prior_complete_on: D("2026-03-15"), prior_fully_processed_by_us: true, current_since_prior: true });
  assert.equal(r.duplicative, false); assert.equal(r.reviewer_required, false); assert.deepEqual(r.timers_started, [...ACK_TIMER_CODES, "REGX_1024_41C3_COMPLETE_NOTICE_5"]); assert.equal(r.courtesy_notice, null);
  // On the bus: the same facts with the loan current 2026-06-01 → the ordinary receipt path, no reviewer needed, both acknowledgment clocks armed for 2026-09-17.
  const h = harness("2026-09-10T14:00:00.000Z");
  const app = await h.run(OPEN, { id: "lma-7", has_evaluative_info: true, received_on: "2026-09-10", prior_application_id: "lma-prior", prior_complete_on: "2026-03-15", prior_fully_processed_by_us: true, current_since_prior: true, current_on: "2026-06-01" });
  assert.equal(app.status, "incomplete"); assert.equal(app.ack_due, "2026-09-17"); assert.equal((app.duplicative_determination as Record<string, unknown>).duplicative, false);
  assert.equal(h.emitted("lossmit.application.received").length, 1); assert.equal(h.emitted("lossmit.application.duplicative").length, 0); assert.equal(h.escalations.opened.length, 0);
  for (const code of ACK_TIMER_CODES) { const t = h.timer(code); assert.equal(t.length, 1, code); assert.equal(t[0]!.dueDate, "2026-09-17"); }
});
test('12.1-T8: (RFA only) call "what programs do you have?" with no financial info → `rfa_only`, no ack timer, CA SPOC assignment (4.3) and solicitation package sent; when the borrower later says "my income dropped by half," application opens with that date.', async () => {
  const r = rfaFlow({ utterance: "what programs do you have?", has_evaluative_info: false, confidence: 0.95, state: "CA", later: { utterance: "my income dropped by half", has_evaluative_info: true, on: D("2026-10-20") } });
  assert.equal(r.kind, "rfa_only"); assert.equal(r.ack_timer, null); assert.equal(r.spoc_assignment, true); assert.equal(r.solicitation_package_sent, true); assert.equal(r.application_opened_on, "2026-10-20");
  const app = rfaFlow({ utterance: "what programs do you have?", has_evaluative_info: false, confidence: 0.6, state: "TX" });
  assert.equal(app.kind, "application"); assert.equal(app.ack_timer, "REGX_1024_41B2_LM_ACK_5");   // the registry code (12.1 timer table), never an invented one
  // On the bus: the call is an RFA — `lossmit.rfa.received`, never `lossmit.application.received`, so no acknowledgment clock arms; the CA SPOC is assigned and the D2-2-04 package (Form 745 + 710 + 4506-C) goes out.
  const h = harness("2026-09-10T14:00:00.000Z");
  const rfa = await h.run(OPEN, { id: "lma-8", utterance: "what programs do you have?", has_evaluative_info: false, confidence: 0.95, state: "CA" });
  assert.equal(rfa.kind, "rfa_only"); assert.equal(rfa.classification, "rfa_only"); assert.equal(rfa.ack_timer, null); assert.equal(rfa.spoc_assignment, true); assert.equal(rfa.solicitation_package_sent, true);
  assert.equal(h.emitted("lossmit.rfa.received").length, 1); assert.equal(h.emitted("lossmit.application.received").length, 0);
  for (const code of ACK_TIMER_CODES) assert.equal(h.timer(code).length, 0, code);
  const pkg = await h.send("NTC_FNMA_D2204_SOLICITATION", {}); assert.equal(pkg.status, "sent"); assert.equal(h.emitted("notice.sent").at(-1)!.payload.template, "NTC_FNMA_D2204_SOLICITATION");
  assert.equal(h.timer("REGX_1024_41B2_LM_ACK_5").length, 0);
  // "my income dropped by half" on 2026-10-20 is evaluative information: the application opens with that date and the 5-day clock runs from it (due Tue 2026-10-27).
  h.clock.set("2026-10-20T16:00:00.000Z");
  const opened = await h.run(OPEN, { id: "lma-8b", utterance: "my income dropped by half", has_evaluative_info: true, confidence: 0.95, received_on: "2026-10-20", state: "CA" });
  assert.equal(opened.received_on, "2026-10-20"); assert.equal(opened.ack_due, "2026-10-27");
  const t = h.timer("REGX_1024_41B2_LM_ACK_5"); assert.equal(t.length, 1); assert.equal(t[0]!.anchorDate, "2026-10-20"); assert.equal(t[0]!.dueDate, "2026-10-27");
  assert.equal(h.emitted("lossmit.application.received")[0]!.payload.received_date, "2026-10-20");
});
test("12.1-T9: (AI outage) document AI unavailable for 3 days → human checklist task completes the determination on day 4; ack on time; incident logged.", async () => {
  const r = aiOutageFallback({ received_on: D("2026-10-01"), outage_started_on: D("2026-10-01"), outage_days: 3 });
  assert.equal(r.human_checklist_task, true); assert.equal(r.determination_on, "2026-10-04"); assert.equal(r.ack_due_on, ackDue(D("2026-10-01")).due_on); assert.equal(r.ack_on_time, true); assert.deepEqual(r.incident, { kind: "ai_outage", days: 3, logged: true });
  // On the bus: the classification tool with document AI down opens the human checklist task (the incident); the clock never moves for a tooling outage and the ack sent after the day-4 determination is still in time (due 2026-10-08).
  const h = harness("2026-10-01T14:00:00.000Z");
  await h.run(OPEN, { id: "lma-9", has_evaluative_info: true, received_on: "2026-10-01", state: "TX" });
  assert.equal(h.timer("NY_419_7D_ACK_5BD").length, 0, "the NY clock arms for NY loans only");
  const task = await h.run("documents.classify_extract", { document_id: "doc-9", ai_unavailable: true });
  assert.equal(task.kind, "human_portal_task"); assert.equal((task.payload as Record<string, unknown>).checklist, "12.1 completeness determination"); assert.equal((task.payload as Record<string, unknown>).reason, "document AI unavailable");
  const incident = h.emitted("escalation.created"); assert.equal(incident.length, 1); assert.equal(incident[0]!.payload.kind, "human_portal_task"); assert.equal(incident[0]!.payload.reason, "document AI unavailable");
  const t = h.timer("REGX_1024_41B2_LM_ACK_5")[0]!; assert.equal(t.dueDate, "2026-10-08");
  h.clock.set("2026-10-05T14:00:00.000Z");   // the human determination lands day 4 (Sun 2026-10-04); the ack mails the next business day
  await h.send("NTC_REGX_41B2_ACK_INCOMPLETE", { notice_date: "2026-10-05", received_date: "2026-10-01", reasonable_date: "2026-11-04", days_to_reasonable_date: 30, business_days_after_receipt: 2 }, { application_id: "lma-9" });
  assert.equal(t.status, "satisfied"); assert.ok(t.satisfiedAt!.slice(0, 10) <= t.dueDate!); assert.equal(h.timers.evaluate("2026-10-09T04:05:00.000Z").length, 0);
});
test("12.1-T10: (CA per-document ack) each of three separate uploads on a CA loan receives an acknowledgment within 5 business days.", async () => {
  const acks = caPerDocumentAcks("CA", [D("2026-10-01"), D("2026-10-05"), D("2026-10-08")]);
  assert.equal(acks.length, 3); assert.ok(acks.every((a) => a.code === "NTC_CA_2924_10_ACK"));
  // 5 business days on the servicer calendar, which observes 2026-10-12 (Columbus Day). The registry row names a `state:CA` calendar (Cal. Civ. Code §§7, 9; Gov. Code §6700) the kernel does not define (business.ts DAY_UNITS), so the count runs on the servicer calendar and says so; whether California observes the second Monday in October is left to that calendar when it exists.
  assert.deepEqual(acks.map((a) => a.ack_by), ["2026-10-08", "2026-10-13", "2026-10-16"]); assert.ok(acks.every((a) => a.calendar === "business_days_servicer"));
  assert.equal(caPerDocumentAcks("TX", [D("2026-10-01")]).length, 0);
  assert.throws(() => documentReceipt({ document_id: "d0", loan_id: LOAN, doc_class: "selfie", received_on: D("2026-10-01"), state: "CA" }), RangeError);
  assert.equal(documentReceipt({ document_id: "d0", loan_id: LOAN, doc_class: "paystub", received_on: D("2026-10-01"), state: "CA", section_2924_15: false }).ca_ack, null);   // not a §2924.15 loan → no CA clock
  // On the bus: each upload is one `lossmit.document.received{state=CA, section_2924_15=true}` → one CA_CIV_2924_10_ACK_5BD instance from that receipt; each acknowledgment's `notice.sent{template=NTC_CA_2924_10_ACK}` satisfies the open one in time.
  const h = harness("2026-10-01T14:00:00.000Z");
  const uploads: [string, string, string][] = [["d1", "paystub", "2026-10-01"], ["d2", "bank_statement", "2026-10-05"], ["d3", "form_710", "2026-10-08"]];
  for (const [k, [id, docClass, on]] of uploads.entries()) {
    h.clock.set(`${on}T14:00:00.000Z`);
    const doc = await h.run(OPEN, { op: "document", document_id: id, doc_class: docClass, received_on: on, state: "CA", section_2924_15: true, application_id: "lma-10" });
    assert.equal((doc.ca_ack as Record<string, unknown>).ack_by, acks[k]!.ack_by); assert.equal(doc.section_2924_15, true);
    const ev = h.emitted("lossmit.document.received"); assert.equal(ev.length, k + 1); assert.equal(ev[k]!.payload.state, "CA"); assert.equal(ev[k]!.payload.section_2924_15, true); assert.equal(ev[k]!.payload.received_on, on);
    assert.equal(eventMatches(loadOverriddenRegistry().get("CA_CIV_2924_10_ACK_5BD")!.triggerPattern!, ev[k]!), true);
    const t = h.timer("CA_CIV_2924_10_ACK_5BD"); assert.equal(t.length, k + 1); assert.equal(t[k]!.anchorDate, on); assert.equal(t[k]!.dueDate, acks[k]!.ack_by); assert.equal(t[k]!.status, "armed");
    h.clock.set(`${addDays(D(on), 1)}T14:00:00.000Z`);   // acknowledged the next day
    const sent = await h.send("NTC_CA_2924_10_ACK", { received_on: on, documents: [docClass], missing: ["most recent bank statement"], respond_by: "2026-10-31", complete: false });
    assert.equal(sent.status, "sent"); assert.equal(t[k]!.status, "satisfied"); assert.ok(t[k]!.satisfiedAt!.slice(0, 10) <= t[k]!.dueDate!);
  }
  assert.deepEqual(h.timer("CA_CIV_2924_10_ACK_5BD").map((t) => t.status), ["satisfied", "satisfied", "satisfied"]);
  // A document on a Texas loan arms nothing.
  const tx = await h.run(OPEN, { op: "document", document_id: "d4", doc_class: "w2", received_on: "2026-10-09", state: "TX" });
  assert.equal(tx.ca_ack, null); assert.equal(h.timer("CA_CIV_2924_10_ACK_5BD").length, 3);
});
test("12.1-T11: (NPRM flag) with `2024nprm`, an oral RFA received 40 days before a sale opens a review cycle and sets a `foreclosure_holds{kind=lm_review_cycle}` hold; with `2013`, it does not.", async () => {
  const on = nprmRfa({ regime: "2024nprm", rfa_on: D("2026-10-01"), sale_on: D("2026-11-10"), oral: true });
  assert.equal(on.review_cycle_opened, true); assert.equal(on.hold!.kind, "lm_review_cycle"); assert.equal(on.notice, "NTC_REGX_41_NPRM_RFA_RECEIVED"); assert.equal(on.days_before_sale, 40);
  const off = nprmRfa({ regime: "2013", rfa_on: D("2026-10-01"), sale_on: D("2026-11-10"), oral: true });
  assert.equal(off.review_cycle_opened, false); assert.equal(off.hold, null); assert.equal(off.notice, null);
  // 12.1 rule 10: the hold attaches only when the RFA arrives more than 37 days before a sale — 30 days out the review cycle opens without it.
  const late = nprmRfa({ regime: "2024nprm", rfa_on: D("2026-10-11"), sale_on: D("2026-11-10"), oral: true });
  assert.equal(late.review_cycle_opened, true); assert.equal(late.days_before_sale, 30); assert.equal(late.hold, null);
  assert.equal(nprmRfa({ regime: "2024nprm", rfa_on: D("2026-10-01"), sale_on: null, oral: false }).hold!.kind, "lm_review_cycle");
  // On the bus under 2024nprm: the oral RFA opens `review_cycle_open`, writes the `lm_review_cycle` hold (13.x gates read it) and the NPRM receipt notice renders; no (b)(2) clock — it is not an application.
  const h = harness("2026-10-01T14:00:00.000Z");
  const r = await h.run(OPEN, { id: "lma-11", utterance: "can you help me with my mortgage?", has_evaluative_info: false, confidence: 0.95, oral: true, regime: "2024nprm", received_on: "2026-10-01", sale_on: "2026-11-10", state: "TX" });
  assert.equal(r.status, "review_cycle_open"); assert.equal((r.nprm as Record<string, unknown>).days_before_sale, 40); assert.equal((r.nprm as Record<string, unknown>).notice, "NTC_REGX_41_NPRM_RFA_RECEIVED"); assert.equal((r.hold_record as Record<string, unknown>).kind, "lm_review_cycle");
  const hold = h.rt.store.get("foreclosure_holds", `hold-${LOAN}-lm_review_cycle`)!.data; assert.equal(hold.status, "active"); assert.equal(hold.from, "2026-10-01");
  assert.equal(h.emitted("foreclosure_holds.opened")[0]!.payload.kind, "lm_review_cycle"); assert.equal(h.rt.store.get("lossmit_applications", "lma-11")!.data.rule_set, "regx.lossmit.2024nprm");
  for (const code of ACK_TIMER_CODES) assert.equal(h.timer(code).length, 0, code);
  assert.equal((await h.send("NTC_REGX_41_NPRM_RFA_RECEIVED", { received_on: "2026-10-01", regime: "2024nprm" })).status, "sent");
  // Under 2013 the same call is an RFA only: no review cycle, no hold row, no hold event.
  const g = harness("2026-10-01T14:00:00.000Z");
  const r13 = await g.run(OPEN, { id: "lma-11b", utterance: "can you help me with my mortgage?", has_evaluative_info: false, confidence: 0.95, oral: true, regime: "2013", received_on: "2026-10-01", sale_on: "2026-11-10", state: "TX" });
  assert.equal(r13.kind, "rfa_only"); assert.equal(r13.nprm, undefined); assert.equal(g.rt.store.get("foreclosure_holds", `hold-${LOAN}-lm_review_cycle`), undefined); assert.equal(g.emitted("foreclosure_holds.opened").length, 0);
});
test("12.1-T12: (breach) ack not produced by day 5 (simulated print failure) → escalation `officer` sev-1 created at 00:05 day 6, ack re-sent, NoE-risk flag set on the loan.", async () => {
  const r = ackBreach({ received_on: D("2026-10-01"), produced: false });
  assert.equal(r.breached, true); assert.equal(r.escalation!.kind, "officer"); assert.equal(r.escalation!.severity, "sev1"); assert.equal(r.day6, "2026-10-09");
  assert.equal(r.escalation!.at_ms, zonedEpochMs(D("2026-10-09"), "00:05", NY)); assert.equal(r.ack_resent, true); assert.equal(r.noe_risk_flag, true);
  assert.equal(ackBreach({ received_on: D("2026-10-01"), produced: true }).breached, false);
  assert.throws(() => ackBreachResponse({ code: "REGX_1024_41C3_COMPLETE_NOTICE_5", received_on: D("2026-10-01"), timer_id: "t" }), RangeError);
  // On the bus: received Thu 2026-10-01 → due Thu 2026-10-08; the print vendor is down on 10-07 so no ack mails and the clock stays armed.
  const h = harness("2026-10-01T14:00:00.000Z");
  await h.run(OPEN, { id: "lma-12", has_evaluative_info: true, received_on: "2026-10-01" });
  const t = h.timer("REGX_1024_41B2_LM_ACK_5")[0]!; assert.equal(t.dueDate, "2026-10-08");
  const ackPayload = { notice_date: "2026-10-07", received_date: "2026-10-01", reasonable_date: "2026-11-06", days_to_reasonable_date: 30, business_days_after_receipt: 4 };
  h.clock.set("2026-10-07T14:00:00.000Z"); h.printMail.outage = true;
  await assert.rejects(h.send("NTC_REGX_41B2_ACK_INCOMPLETE", ackPayload, { application_id: "lma-12" }), /print-mail/);
  assert.equal(h.emitted("notice.sent").length, 0); assert.equal(t.status, "armed");
  // 00:05 day 6 (Fri 2026-10-09 servicer-local): the sweep breaches the clock, opens the officer sev-1 escalation and flags the loan as an NoE risk.
  const at = zonedEpochMs(D("2026-10-09"), "00:05", NY); h.clock.set(new Date(at).toISOString());
  const sweep = await h.run(OPEN, { op: "breach_sweep" });
  assert.equal(t.status, "breached");
  const breaches = sweep.breaches as Record<string, unknown>[]; const regx = breaches.find((b) => b.code === "REGX_1024_41B2_LM_ACK_5")!;
  assert.equal(regx.kind, "officer"); assert.equal(regx.severity, "sev1"); assert.equal(regx.day6, "2026-10-09"); assert.equal(regx.noe_risk_flag, true); assert.equal(sweep.ack_resend_required, true);
  assert.equal(breaches.find((b) => b.code === "FNMA_D2205_BRP_ACK_5BD")!.severity, "sev2");   // Fannie Mae's twin clock breaches at sev-2 (timer table)
  const esc = h.emitted("escalation.created").find((e) => e.payload.severity === "sev1")!; assert.equal(esc.payload.kind, "officer"); assert.equal(esc.payload.owner_role, "officer"); assert.equal(esc.occurredAt, new Date(at).toISOString()); assert.equal(esc.occurredAt, "2026-10-09T04:05:00.000Z");
  assert.equal(h.rt.store.get("loans", LOAN)!.data.noe_risk_flag, true); assert.equal(h.rt.store.get("lossmit_applications", "lma-12")!.data.noe_risk_flag, true);
  assert.equal(h.emitted("lossmit.ack.breached")[0]!.payload.code, "REGX_1024_41B2_LM_ACK_5");
  // The ack is re-sent under the escalation (never after the clock without an escalations row) and the clock closes late.
  h.printMail.outage = false; h.clock.set("2026-10-09T13:00:00.000Z");
  await assert.rejects(h.send("NTC_REGX_41B2_ACK_INCOMPLETE", { ...ackPayload, notice_date: "2026-10-09" }, { application_id: "lma-12" }), /NO_LATE_ACK_WITHOUT_ESCALATION/);
  const resent = await h.send("NTC_REGX_41B2_ACK_INCOMPLETE", { ...ackPayload, notice_date: "2026-10-09" }, { application_id: "lma-12", escalation_id: regx.escalation_id });
  assert.equal(resent.status, "sent"); assert.equal(t.status, "satisfied_late"); assert.equal(h.timer("FNMA_D2205_BRP_ACK_5BD")[0]!.status, "satisfied_late");
});

// ---- the carry-over intake (§1024.41(k); 1.7's REGX_1024_41K2_TRANSFEREE_ACK_10 is on 12.1's timer list) — armed by the event 12.1 emits, satisfied by the ack it sends.
test("12.1 transfer-in mid-application: the carry-over intake of a transferor file with no ack and an unexpired period emits `transfer.in.completed{lossmit_pending, ack_not_sent, lossmit_ack_unexpired, transfer_date}`, which arms REGX_1024_41K2_TRANSFEREE_ACK_10 for 10 federal BD from the transfer date; the (b)(2) ack satisfies it; a sent or lapsed ack arms it not", async () => {
  const pure = carryoverIntake({ loan_id: LOAN, transfer_date: D("2026-10-01"), file: { received_at: D("2026-09-29"), ack_sent_at: null, status: "incomplete" } });
  assert.equal(pure.timer, "REGX_1024_41K2_TRANSFEREE_ACK_10"); assert.equal(pure.deemed_received_at, "2026-09-29"); assert.equal(pure.transferee_ack_due, "2026-10-16"); assert.equal(pure.lossmit_ack_unexpired, true);
  assert.equal(carryoverIntake({ loan_id: LOAN, transfer_date: D("2026-10-01"), file: { received_at: D("2026-09-29"), ack_sent_at: D("2026-09-30"), status: "incomplete" } }).timer, null);
  const lapsed = carryoverIntake({ loan_id: LOAN, transfer_date: D("2026-10-01"), file: { received_at: D("2026-09-01"), ack_sent_at: null, status: "incomplete" } });
  assert.equal(lapsed.timer, "REGX_1024_41B2_LM_ACK_5"); assert.equal(lapsed.lossmit_ack_unexpired, false); assert.equal(lapsed.received_event!.payload.received_date, "2026-10-01");
  assert.equal(carryoverIntake({ loan_id: LOAN, transfer_date: D("2026-10-01"), file: null }).lossmit_pending, false);
  const h = harness("2026-10-01T14:00:00.000Z");
  h.rt.store.put("transfer_lossmit_files", "tlf-1", { loan_id: LOAN, received_at: "2026-09-29", ack_sent_at: null, status: "incomplete", documents: ["form_710"] }, AGENT, h.clock.now());
  const r = await h.run(OPEN, { op: "carryover", transfer_date: "2026-10-01" });
  assert.equal(r.lossmit_pending, true); assert.equal(r.ack_not_sent, true); assert.equal(r.lossmit_ack_unexpired, true); assert.equal(r.deemed_received_at, "2026-09-29"); assert.equal(r.transferor_received_date, "2026-09-29"); assert.equal(r.timer, "REGX_1024_41K2_TRANSFEREE_ACK_10");
  const ev = h.emitted("transfer.in.completed"); assert.equal(ev.length, 1); assert.equal(ev[0]!.payload.transfer_date, "2026-10-01");
  assert.equal(eventMatches(loadOverriddenRegistry().get("REGX_1024_41K2_TRANSFEREE_ACK_10")!.triggerPattern!, ev[0]!), true);
  const t = h.timer("REGX_1024_41K2_TRANSFEREE_ACK_10"); assert.equal(t.length, 1); assert.equal(t[0]!.anchorDate, "2026-10-01"); assert.equal(t[0]!.dueDate, "2026-10-16");   // Oct 2, 5–9, 13–16 (Columbus Day excluded)
  assert.equal(h.timer("REGX_1024_41B2_LM_ACK_5").length, 0, "the transferee owes the (k)(2)(i) 10-day clock, not a fresh 5-day clock");
  h.clock.set("2026-10-14T14:00:00.000Z");
  await h.send("NTC_REGX_41B2_ACK_INCOMPLETE", { notice_date: "2026-10-14", received_date: "2026-09-29", reasonable_date: "2026-11-13", days_to_reasonable_date: 30, business_days_after_receipt: 5 }, { application_id: r.application_id as string });
  assert.equal(t[0]!.status, "satisfied");
  // The transferor already acknowledged → nothing re-sent, no clock (comment 41(k)(1)(i)-3).
  const g = harness("2026-10-01T14:00:00.000Z");
  const sentBefore = await g.run(OPEN, { op: "carryover", transfer_date: "2026-10-01", transferor_file: { received_at: "2026-09-29", ack_sent_at: "2026-09-30", status: "incomplete" } });
  assert.equal(sentBefore.ack_not_sent, false); assert.equal(sentBefore.timer, null); assert.equal(g.timer("REGX_1024_41K2_TRANSFEREE_ACK_10").length, 0); assert.equal(g.emitted("transfer.in.completed").length, 1);
});

// ---- NY overlay (3 NYCRR 419.7(d)): the NY acknowledgment clock arms on an NY receipt, runs 5 servicer business days, and the (b)(2) acknowledgment satisfies it.
test("12.1 NY overlay: `lossmit.application.received{state=NY}` arms NY_419_7D_ACK_5BD for 5 servicer BD from the receipt and the (b)(2) acknowledgment satisfies it; a Texas receipt never arms it", async () => {
  const h = harness("2026-11-20T15:00:00.000Z");
  await h.run(OPEN, { id: "lma-ny", has_evaluative_info: true, received_on: "2026-11-20", state: "NY" });
  const ny = h.timer("NY_419_7D_ACK_5BD"); assert.equal(ny.length, 1); assert.equal(ny[0]!.anchorDate, "2026-11-20"); assert.equal(ny[0]!.dueDate, "2026-11-30");
  assert.equal(h.emitted("lossmit.application.received")[0]!.payload.state, "NY");
  h.clock.set("2026-11-25T15:00:00.000Z");
  await h.send("NTC_REGX_41B2_ACK_INCOMPLETE", { notice_date: "2026-11-25", received_date: "2026-11-20", reasonable_date: "2026-12-28", days_to_reasonable_date: 33, business_days_after_receipt: 3 }, { application_id: "lma-ny" });
  assert.equal(ny[0]!.status, "satisfied"); assert.equal(h.timer("REGX_1024_41B2_LM_ACK_5")[0]!.status, "satisfied");
  assert.equal(h.timers.evaluate("2026-12-01T05:00:00.000Z").length, 0);
});
