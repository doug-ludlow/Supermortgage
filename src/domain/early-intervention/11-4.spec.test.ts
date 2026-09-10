// 11.4 FDCPA compliance
// spec/sections/11-early-intervention-collections/11-4-fdcpa-compliance.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, daysBetween } from "../../kernel/calendar/date.ts";
import { addBusinessDays, federal } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { CommandBus } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { SECTION_11_TOOLS } from "../../app/tools/section11.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { itemizationChecks, determineDebtCollector, fdcpaStatusAtBoarding, recordInitialCommunication, recordValidationSent, validationNoticeDue, validationPeriod, overlayOf } from "./fdcpa.ts";
import { openWindow, noticeCycle } from "./windows.ts";
import { newPlan, openPlanIfDue, recordAttempt } from "./plan.ts";
import { disputeLifecycle, dcLoanEiNotice, writtenCease, oralCease, attorneyGate, furnishingGate, smsRndGate, dcEmailCheck, voicemailCheck, deceasedReport, assumedNameCheck, stateOverlay, contactEngineChecks, counterRun, type CallAttempt } from "./ops.ts";
import { applyEarlyInterventionTimerOverrides } from "./timers.ts";
import { eiEngine, atEt, noonEt } from "./spec-harness.ts";
import { zonedEpochMs } from "../../kernel/calendar/zoned.ts";
import { CommandRefused } from "../../app/commands.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
import { render } from "../../notices/render.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { loadOverriddenRegistry } from "../../domain/timer-overrides.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { evaluateOutboundCommunication } from "./ops-11-4.ts";

const DC = { regx_days_delinquent_at_transfer: 61, bk_active: false, fc_active: false, accelerated: false };
function uow(loanId = "L-DC", now = "2026-09-30T14:00:00.000Z"): UowContext & { events: MemoryEventStore } { const clock = new FixedClock(now); const events = new MemoryEventStore(clock); return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadRegistry(), events, { processes: [] }), clock, decide: () => {} }; }
/** A unit of work whose TimerEngine runs the overridden registry for 11.1/11.4 — the bus tools' `gates.evaluate` events arm the real gate rows. */
function uowGated(loanId = "L-DC", now = "2026-10-20T15:00:00.000Z"): UowContext & { events: MemoryEventStore; timers: TimerEngine } { const clock = new FixedClock(now); const events = new MemoryEventStore(clock); return { loanId, events, ledger: new MemoryLedger(), timers: new TimerEngine(loadOverriddenRegistry(), events, { processes: ["11.1", "11.4"] }), clock, decide: () => {} }; }
const DC_AGENT: Actor = { kind: "agent", id: "default-collections" };
const edeliveryPort = { send: async (m: { messageId: string }) => ({ messageId: m.messageId, status: "queued" }) } as unknown as NonNullable<ToolRuntime["ports"]["edelivery"]>;
/** The bus tool `name` of process `proc` bound to `rt` and allowlisted to its agent. */
const bind = (rt: ToolRuntime, agents: AgentRegistry, proc: string, name: string) => { const d = SECTION_11_TOOLS.find((x) => x.name === name && x.process === proc)!; const c = toolCommand(d, rt, ["human_agent", "officer"]); agents.registerTool(d.agent, c.name); return c; };
const printPort = { submit: async (job: { jobId: string }) => ({ jobId: job.jobId, status: "received" }) } as unknown as NonNullable<ToolRuntime["ports"]["printMail"]>;

test("11.4-T1: Given transfer date 2026-10-01 and earliest unpaid due 2026-08-01, then `debt_collector=true`, basis `default_at_obtain`, days 61 (1.1-T5 aligned); given earliest unpaid 2026-10-01 (due on the transfer date, unpaid), then with threshold 0 → true; with counsel threshold 30 → false.", () => {
  const days = daysBetween(D("2026-08-01"), D("2026-10-01")); assert.equal(days, 61);
  const b = fdcpaStatusAtBoarding("L-DC", D("2026-10-01"), { ...DC, regx_days_delinquent_at_transfer: days, unpaid_installment_at_transfer: true });
  assert.equal(b.status.debt_collector, true); assert.equal(b.status.determination_basis, "default_at_obtain"); assert.equal(b.status.state, "awaiting_initial_communication");
  assert.equal(b.events[0]!.type, "fdcpa.status.determined"); assert.equal(b.events[0]!.payload.regx_days_delinquent_at_boarding, 61);
  // due on the transfer date and unpaid: delinquent from the due date (§1024.31), day count 0
  const dueOnTransfer = { ...DC, regx_days_delinquent_at_transfer: 0, unpaid_installment_at_transfer: true };
  assert.deepEqual(determineDebtCollector(dueOnTransfer), { debt_collector: true, basis: "default_at_obtain", threshold_days: 0 });
  assert.equal(determineDebtCollector({ ...dueOnTransfer, threshold_days: 30 }).debt_collector, false); assert.equal(determineDebtCollector({ ...dueOnTransfer, threshold_days: 30 }).basis, "not_in_default");
  assert.equal(determineDebtCollector({ ...DC, regx_days_delinquent_at_transfer: 0 }).debt_collector, false);   // boarded current
  assert.equal(determineDebtCollector({ ...DC, regx_days_delinquent_at_transfer: 0, originated_by_partner: true }).basis, "not_in_default");
  assert.equal(determineDebtCollector({ ...DC, regx_days_delinquent_at_transfer: 0, bk_active: true }).basis, "bankruptcy_at_obtain");
  assert.equal(determineDebtCollector({ ...DC, regx_days_delinquent_at_transfer: 0, counsel_override: { debt_collector: true, rationale: "counsel memo 2026-09-01" } }).basis, "counsel_override");
});
test("11.4-T2: Given a DC loan whose hello letter mails 2026-10-02 with the B-1 enclosed, then `initial_communication_at`=2026-10-02, no 5-day timer is opened, `assumed_receipt_on`=2026-10-09, `validation_period_end_on`=2026-11-08 and the notice prints that date.", () => {
  const { status } = fdcpaStatusAtBoarding("L-DC", D("2026-10-01"), DC);
  const r = recordInitialCommunication(status, { on: D("2026-10-02"), channel: "hello_letter", validation_enclosed: true });
  assert.equal(status.initial_communication_at, D("2026-10-02")); assert.equal(r.validation_notice_due, null);   // §1006.34(a)(1)(i)(A): no five-day clock
  assert.equal(status.validation_sent_at, D("2026-10-02")); assert.equal(status.assumed_receipt_on, D("2026-10-09")); assert.equal(status.validation_period_end_on, D("2026-11-08")); assert.equal(status.state, "validation_notice_sent");
  assert.deepEqual(r.events.map((e) => e.type), ["fdcpa.initial_communication.recorded", "collection.activity.last", "fdcpa.validation_notice.sent", "fdcpa.validation_notice.assumed_received"]);
  assert.deepEqual(validationPeriod(D("2026-10-02")), { assumed_receipt_on: D("2026-10-09"), validation_period_end_on: D("2026-11-08") });
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGF_1006_34_VALIDATION_B1", D("2026-10-02"))!;
  const payload = { ...v.samplePayload, validation_period_end_on: status.validation_period_end_on };
  const rendered = render(v.source, payload); assert.ok(rendered.text.includes("November 8, 2026")); assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
});
test("11.4-T3: Given an inbound borrower call on 2026-09-30 before any letter, then the oral disclosure is given after verification and `REGF_1006_34_VALIDATION_NOTICE_5D` is due 2026-10-05.", async () => {
  const { status } = fdcpaStatusAtBoarding("L-DC", D("2026-09-30"), DC);
  const r = recordInitialCommunication(status, { on: D("2026-09-30"), channel: "call_inbound", validation_enclosed: false, oral_disclosure_given: true });
  assert.equal(r.validation_notice_due, D("2026-10-05")); assert.equal(validationNoticeDue(D("2026-09-30")), D("2026-10-05"));
  assert.equal(r.events[0]!.type, "fdcpa.initial_communication.recorded"); assert.equal(r.events[0]!.payload.on, D("2026-09-30")); assert.equal(r.events[0]!.payload.validation_enclosed, false);
  const registry = loadRegistry(); applyEarlyInterventionTimerOverrides(registry); const t = registry.get("REGF_1006_34_VALIDATION_NOTICE_5D")!;
  assert.equal(t.triggerPattern!.type, "fdcpa.initial_communication.recorded"); assert.equal(t.anchorField, "on"); assert.notEqual(t.offsetParsed.kind, "prose");
  assert.equal(t.satisfiedPattern!.type, "notice.sent"); assert.deepEqual(t.satisfiedPattern!.conditions, [{ field: "template", op: "=", value: "NTC_REGF_1006_34_VALIDATION_B1" }]);
  // the oral disclosure: the §1006.18(e) initial statement only after verification; before, limited-content wording
  const ctx = uow(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const agents = new AgentRegistry();
  const cmd = toolCommand(SECTION_11_TOOLS.find((x) => x.process === "11.3" && x.name === "disclosure.play")!, rt, ["human_agent"]); agents.registerTool("borrower-comms", cmd.name); const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  const before = await bus.execute(cmd, comms, { fdcpa_debt_collector: true, initial_communication: true, identity_verified: false }, ctx);
  assert.equal((before.output as { limited_content_only: boolean }).limited_content_only, true); assert.ok(!(before.output as { script: string[] }).script.some((s) => /debt/.test(s)));
  const after = await bus.execute(cmd, comms, { fdcpa_debt_collector: true, initial_communication: true, identity_verified: true }, ctx);
  assert.ok((after.output as { script: string[] }).script.some((s) => /attempting to collect a debt and any information obtained will be used for that purpose/.test(s))); assert.equal((after.output as { fdcpa_disclosure_at: string | null }).fdcpa_disclosure_at, ctx.clock.now());
});
test("11.4-T3a: **(Wednesday initial communication — calendar-day regression guard.)** Given a DC loan whose initial communication is an inbound call on **Wed 2026-10-14** with no validation information given in that communication, then `REGF_1006_34_VALIDATION_NOTICE_5D` anchors on 2026-10-14 and is due **Mon 2026-10-19** (five *calendar* days: Oct 15, 16, 17, 18, 19 — Sat 10-17 and Sun 10-18 **count**). A due date of Wed 2026-10-21 (five federal business days) is a **failure**: §1006.34(a)(1)(i)(B) carries no weekend/holiday exclusion. Then a notice mailed Mon 2026-10-19 satisfies the timer, and only then does §1006.34(b)(5) apply its own weekend/holiday exclusion: `assumed_receipt_on` = **Mon 2026-10-26** (Oct 20, 21, 22, 23, 26 — five days excluding Sat 10-24/Sun 10-25) → `validation_period_end_on` = **Wed 2026-11-25**.", () => {
  const { status } = fdcpaStatusAtBoarding("L-DC", D("2026-10-01"), DC);
  const r = recordInitialCommunication(status, { on: D("2026-10-14"), channel: "call_inbound", validation_enclosed: false });
  assert.equal(r.validation_notice_due, D("2026-10-19")); assert.notEqual(r.validation_notice_due, D("2026-10-21"));   // five calendar days, not five federal business days
  assert.equal(addBusinessDays(D("2026-10-14"), 5, federal), D("2026-10-21"));                    // the wrong answer the guard exists to catch
  const sent = recordValidationSent(status, { sent_on: D("2026-10-19"), channel: "mail" });
  assert.equal(status.assumed_receipt_on, D("2026-10-26")); assert.equal(status.validation_period_end_on, D("2026-11-25"));
  assert.equal(sent[0]!.type, "fdcpa.validation_notice.sent"); assert.equal(sent[1]!.payload.assumed_receipt_on, D("2026-10-26"));
});
test("11.4-T4: Given the B-1 mortgage variant, then the itemization lines sum: 31,254,022 + 123,811 + 16,500 − 0 − 0 = 31,394,333 cents = $313,943.33 and the checklist passes; given the (c)(5) substitute, then the latest statement is attached and referenced.", () => {
  const it = itemizationChecks({ itemization_date: D("2026-08-17"), amount_on_itemization_cents: 31254022n, interest_since_cents: 123811n, fees_since_cents: 16500n, payments_since_cents: 0n, credits_since_cents: 0n, current_amount_cents: 31394333n });
  assert.equal(it.sum_cents, 31394333n); assert.equal(it.consistent, true);
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGF_1006_34_VALIDATION_B1", D("2026-10-02"))!;
  const rendered = render(v.source, v.samplePayload); assert.ok(rendered.text.includes("$313,943.33")); assert.equal(evaluateChecklist(v, v.samplePayload, rendered).passed, true);
  const sub = { ...v.samplePayload, statement_substitute: true, statement_date: "2026-09-17" };
  const r2 = render(v.source, sub); assert.ok(r2.text.includes("See the enclosed periodic statement dated September 17, 2026")); assert.equal(evaluateChecklist(v, sub, r2).passed, true);
});
test("11.4-T5: Given a written dispute received 2026-10-20, then `collection_ceased_at` is set, an outbound collection call on 10-21 is refused, statements still generate, and after verification mails 2026-11-05 collection resumes.", async () => {
  // the loan's fdcpa_status machine: hello letter with the B-1 on 10-02 → validation period through 11-08; a written dispute on
  // 10-20 is inside it and ceases collection (§1006.38(c)); the overlay refuses an outbound collection call on 10-21 while
  // statements (permitted) continue; the verification mailed 11-05 resolves the dispute and collection resumes
  const { status } = fdcpaStatusAtBoarding("L-DC", D("2026-10-01"), DC); recordInitialCommunication(status, { on: D("2026-10-02"), channel: "hello_letter", validation_enclosed: true }); assert.equal(status.validation_period_end_on, D("2026-11-08"));
  const r = disputeLifecycle({ status, received_on: D("2026-10-20"), verification_mailed_on: D("2026-11-05"), basis: "amount_wrong" });
  assert.equal(r.within_validation_period, true); assert.equal(r.collection_ceased_at, D("2026-10-20")); assert.equal(r.callAllowed(D("2026-10-21")).allowed, false); assert.match(r.callAllowed(D("2026-10-21")).reason!, /1006\.38/); assert.equal(r.statements_allowed, true); assert.equal(r.statementAllowed(D("2026-10-21")), true);
  assert.equal(r.collection_resumed_at, D("2026-11-05")); assert.equal(r.callAllowed(D("2026-11-05")).allowed, true);
  assert.deepEqual(r.events.map((e) => e.type), ["fdcpa.dispute.received", "fdcpa.dispute.verification_sent"]); assert.equal(r.events[0]!.payload.collection_ceased, true); assert.equal(r.events[0]!.payload.within_validation_period, true);
  assert.equal(status.disputes[0]!.status, "verification_sent"); assert.equal(status.disputes[0]!.resolved_on, D("2026-11-05")); assert.equal(overlayOf(status).dispute_open, false);
  // an oral dispute, or a written one after the period, is no Reg F cease (an NoE/RFI and FCRA direct dispute instead — rule 5)
  const oral = fdcpaStatusAtBoarding("L-DC", D("2026-10-01"), DC).status; recordInitialCommunication(oral, { on: D("2026-10-02"), channel: "hello_letter", validation_enclosed: true });
  assert.equal(disputeLifecycle({ status: oral, received_on: D("2026-10-20"), verification_mailed_on: null, written: false }).collection_ceased_at, null); assert.equal(disputeLifecycle({ status: oral, received_on: D("2026-11-20"), verification_mailed_on: null }).within_validation_period, false); assert.equal(disputeLifecycle({ status: oral, received_on: D("2026-11-20"), verification_mailed_on: null }).callAllowed(D("2026-11-21")).allowed, true);
  // the registry: the dispute event arms REGF_1006_38_DISPUTE_CEASE_GATE (a gate, no due date); the verification `notice.sent` lifts it
  const h = eiEngine({ loanId: "L-DC" }); for (const e of r.events.slice(0, 1)) h.emit(e.type, e.payload, noonEt("2026-10-20"));
  assert.equal(h.armed("REGF_1006_38_DISPUTE_CEASE_GATE").length, 1); assert.equal(h.armed("REGF_1006_38_DISPUTE_CEASE_GATE")[0]!.dueAt, undefined); assert.equal(h.armed("SM_REGF_VERIFICATION_RESPONSE_30")[0]!.dueDate, D("2026-11-19"));
  h.emit("notice.sent", { notice_id: "n-ver", template: "NTC_REGF_1006_38_VERIFICATION", sent_at: noonEt("2026-11-05") }, noonEt("2026-11-05")); assert.equal(h.byCode("REGF_1006_38_DISPUTE_CEASE_GATE")[0]!.status, "satisfied"); assert.equal(h.byCode("SM_REGF_VERIFICATION_RESPONSE_30")[0]!.status, "satisfied");
  // through the bus: dispute.intake records the cease; contact.log refuses the outbound collection call on 10-21 from the store's open
  // dispute (a command refusal, not a caller flag); print.request of the verification on 11-05 resumes collection; the 11-06 call logs
  const ctx = uow("L-DC", "2026-10-20T15:00:00.000Z"); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: { printMail: printPort } }; const agents = new AgentRegistry();
  const t = (name: string) => { const d = SECTION_11_TOOLS.find((x) => x.name === name && (x.process === "11.3" || x.process === "11.2"))!; const c = toolCommand(d, rt, ["human_agent", "officer"]); agents.registerTool(d.agent, c.name); return c; };
  const intake = t("dispute.intake"), log = t("contact.log"), print = t("print.request"); const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" }; const dcAgent: Actor = { kind: "agent", id: "default-collections" };
  const opened = await bus.execute(intake, comms, { loan_id: "L-DC", received_on: "2026-10-20", written: true, fdcpa_debt_collector: true, validation_period_end_on: "2026-11-08" }, ctx);
  assert.deepEqual((opened.output as { regf: unknown }).regf, { written: true, within_validation_period: true, collection_ceased: true }); assert.equal(rt.store.list("fdcpa_disputes")[0]!.data.collection_ceased_at, "2026-10-20");
  const attempt = { loan_id: "L-DC", mode: "ai_voice", direction: "outbound", outcome: "no_answer", on: "2026-10-21", pre_dial_checks: { consent: true, quiet_hours: true, regf_count: true, post_conversation: true, pre_sale: true, cease_flags: true, bk_flag: true, attorney_flag: true, workplace: true } };
  await assert.rejects(bus.execute(log, comms, attempt, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REGF_1006_38_DISPUTE_CEASE_GATE");
  assert.ok(ctx.events.all().some((e) => e.type === "command.refused" && e.payload.code === "REGF_1006_38_DISPUTE_CEASE_GATE")); assert.ok(!ctx.events.all().some((e) => e.type === "contact.attempted"));
  const ctxNov = uow("L-DC", "2026-11-05T15:00:00.000Z"); await bus.execute(print, dcAgent, { notice_id: "n-ver", template: "NTC_REGF_1006_38_VERIFICATION", recipient: "borrower" }, ctxNov);
  assert.ok(ctxNov.events.all().some((e) => e.type === "notice.sent" && e.payload.template === "NTC_REGF_1006_38_VERIFICATION")); assert.equal(rt.store.list("fdcpa_disputes")[0]!.data.status, "verification_sent"); assert.equal(rt.store.list("fdcpa_disputes")[0]!.data.collection_resumed_at, "2026-11-05");
  const ctxAfter = uow("L-DC", "2026-11-06T15:00:00.000Z"); await bus.execute(log, comms, { ...attempt, on: "2026-11-06" }, ctxAfter); assert.ok(ctxAfter.events.all().some((e) => e.type === "contact.attempted"));
});
test(`11.4-T6: Given an EI notice due during the validation period, then the template check refuses a version demanding payment "within 10 days" and accepts the standard MS-4 version with the §1006.18(e) fragment.`, () => {
  const bad = dcLoanEiNotice({ text: "This communication is from a debt collector. You must pay within 10 days. You may dispute this debt.", validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(bad.accepted, false); assert.ok(bad.overshadow_issues.some((s) => /within 10 days/.test(s)));
  const reg = buildRegistry(); publishAuthored(reg);
  const v = reg.activeVersion("NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", D("2026-12-14"))!;
  const ok = dcLoanEiNotice({ text: render(v.source, v.samplePayload).text, validation_end: D("2026-11-08"), ref_date: D("2026-10-20"), in_validation_period: true });
  assert.equal(ok.accepted, true); assert.equal(ok.fragment_present, true);
  // `gates.evaluate` (ops-11-4.ts): the letter request on 10-20 is inside the validation period (through 11-08) — `communication.outbound.requested{fdcpa_debt_collector=true, within_validation_period=true}`
  // arms REGF_1006_38_OVERSHADOW_GATE (evaluator 11.4.noOvershadowing) and the "within 10 days" demand is refused on that code; the MS-4 fdcpa variant passes; on 11-09 the period is over and no gate arms
  const clock = new FixedClock("2026-10-20T15:00:00.000Z"); const events = new MemoryEventStore(clock); const registry = loadOverriddenRegistry(); const engine = new TimerEngine(registry, events, { processes: ["11.4"] }); const gctx = { events, actor: DC_AGENT, now: clock.now(), loanId: "L-DC" };
  const badText = "This communication is from a debt collector. You must pay within 10 days. You may dispute this debt.";
  const g = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "letter", fdcpa_debt_collector: true, text: badText, template: "NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", ref_date: D("2026-10-20"), validation_period_end_on: D("2026-11-08") });
  assert.equal(g.within_validation_period, true); assert.equal(g.allowed, false); assert.deepEqual([...g.refused_by], ["REGF_1006_38_OVERSHADOW_GATE"]); assert.match(g.gates.find((x) => x.code === "REGF_1006_38_OVERSHADOW_GATE")!.reason!, /1006\.38\(b\)/);
  assert.equal(g.events[0]!.type, "communication.outbound.requested"); assert.equal(g.events[0]!.payload.pay_within_shorter_than_period, true); assert.equal(g.events[0]!.payload.disclosure_fragment_present, true);
  assert.ok(eventMatches(registry.get("REGF_1006_38_OVERSHADOW_GATE")!.triggerPattern!, g.events[0]!)); assert.ok(eventMatches(registry.get("REGF_1006_18E_DISCLOSURE_GATE")!.triggerPattern!, g.events[0]!));
  const armed = engine.byCode("REGF_1006_38_OVERSHADOW_GATE"); assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.note, "evaluator:11.4.noOvershadowing"); assert.equal(armed[0]!.armedByEventId, g.events[0]!.id); assert.equal(armed[0]!.loanId, "L-DC");
  const fine = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "letter", fdcpa_debt_collector: true, text: render(v.source, v.samplePayload).text, template: "NTC_REGX_39D_EARLY_INTERVENTION_FDCPA", ref_date: D("2026-10-20"), validation_period_end_on: D("2026-11-08") });
  assert.equal(fine.allowed, true); assert.deepEqual(fine.gates.map((x) => [x.code, x.open]), [["REGF_1006_18E_DISCLOSURE_GATE", true], ["REGF_1006_38_OVERSHADOW_GATE", true]]); assert.equal(engine.byCode("REGF_1006_38_OVERSHADOW_GATE").length, 2);
  const after = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "letter", fdcpa_debt_collector: true, text: badText, ref_date: D("2026-11-09"), validation_period_end_on: D("2026-11-08") });
  assert.equal(after.within_validation_period, false); assert.equal(after.allowed, true); assert.ok(!after.gates.some((x) => x.code === "REGF_1006_38_OVERSHADOW_GATE")); assert.equal(engine.byCode("REGF_1006_38_OVERSHADOW_GATE").length, 2); assert.equal(engine.byCode("REGF_1006_18E_DISCLOSURE_GATE").length, 3);
  assert.deepEqual(evaluateOutboundCommunication(gctx, { loan_id: "L-CA", channel: "letter", fdcpa_debt_collector: false, text: badText, ref_date: D("2026-10-20"), validation_period_end_on: D("2026-11-08") }).events, []);   // not a DC loan: Reg F does not apply
});
test("11.4-T7: Given a written cease from the borrower on a DC loan, then 11.1's plan is `suspended{cease_request}`, the 11.2 variant switches to `fdcpa` (190-day cycle), the cease acknowledgement is sent once, and a borrower-initiated call about a modification is answered fully.", () => {
  const { status } = fdcpaStatusAtBoarding("L-DC", D("2026-10-01"), DC);
  const plan = newPlan("L-DC"); openPlanIfDue(plan, 40, D("2026-11-09")); recordAttempt(plan, { contact_id: "c1", on: D("2026-11-09"), mode: "ai_voice", outcome: "no_answer", live_contact: false });
  const windows = [openWindow(D("2026-10-01"), { principal_residence: true })];
  const r = writtenCease({ received_on: D("2026-11-10"), ack_sent_before: false, plan, fdcpa: status, windows, debt_collector: true });
  assert.equal(r.plan, "suspended{cease_request}"); assert.equal(plan.status, "suspended"); assert.ok(r.plan_events.some((e) => e.type === "contact.plan.suspended" && e.payload.reason === "cease_request"));
  assert.equal(r.ei_variant, "fdcpa"); assert.equal(r.cycle_days, 190); assert.equal(noticeCycle(D("2026-12-14"), "fdcpa", "c").cycle_end_at, D("2027-06-22")); assert.equal(r.next_cycle_end_from(D("2026-12-14")), D("2027-06-22"));
  assert.equal(r.send_ack, true); assert.equal(r.ack_template, "NTC_REGF_1006_6C_CEASE_ACK"); assert.equal(r.gate, "REGF_1006_6C_CEASE_GATE");
  assert.equal(r.borrower_initiated_lossmit_call, "answered_fully"); assert.equal(r.outbound_collection_call, "refused");
  assert.equal(status.cease_scope, "written_full"); assert.equal(overlayOf(status).cease_active, true); assert.ok(r.fdcpa_events.some((e) => e.type === "fdcpa.cease.received" && e.payload.written === true));
  assert.deepEqual([...r.windows_live], ["exempt_fdcpa_cease"]); assert.equal(windows[0]!.live, "exempt_fdcpa_cease"); assert.equal(windows[0]!.notice, "open");   // (a) exempt; (b) survives as the fdcpa variant
  assert.equal(writtenCease({ received_on: D("2026-11-12"), ack_sent_before: true, plan, fdcpa: status, debt_collector: true }).send_ack, false);   // the acknowledgement goes once
  // the registry: `fdcpa.cease.received{written=true}` arms the permanent cease gate, cancels the live-contact clock (`exempt_fdcpa_cease`,
  // §1024.39(d)(1)) and leaves the day-45 notice clock armed for the fdcpa variant; the plan's suspension cancels the cadence clocks
  const h = eiEngine({ loanId: "L-DC" }); for (const e of counterRun(D("2026-10-01"), D("2026-10-02")).events) h.emit(e.type, e.payload, atEt("2026-10-02", "00:05"));
  h.emit("contact.attempted", { contact_id: "c1", direction: "outbound", mode: "ai_voice", outcome: "no_answer", on: "2026-11-09" }, noonEt("2026-11-09")); assert.equal(h.armed("FNMA_D2202_OUTBOUND_EVERY_7").length, 1);
  for (const e of [...r.fdcpa_events, ...r.plan_events]) h.emit(e.type, e.payload, noonEt("2026-11-10"));
  assert.equal(h.armed("REGF_1006_6C_CEASE_GATE").length, 1); assert.equal(h.byCode("REGX_1024_39A_LIVE_CONTACT_36")[0]!.cancelledReason, "exempt_fdcpa_cease"); assert.equal(h.byCode("REGX_1024_39B_WRITTEN_NOTICE_45")[0]!.status, "armed");
  assert.ok(h.byCode("FNMA_D2202_OUTBOUND_EVERY_7").every((t) => t.status === "cancelled" && /cease_request/.test(t.cancelledReason ?? ""))); assert.deepEqual(h.breachCodes(atEt("2026-11-17", "00:05")).filter((c) => /^FNMA_D2202|^REGX_1024_39A/.test(c)), []);
});
test(`11.4-T8: Given an oral "stop calling me," then voice/SMS/email stop within 1 minute, mail continues, the EI variant stays standard, and the transcript shows the written-request explanation.`, () => {
  const { status } = fdcpaStatusAtBoarding("L-DC", D("2026-10-01"), DC);
  const r = oralCease({ at_ms: 1_700_000_000_000, consented_channels: ["voice", "sms", "email"], fdcpa: status, debt_collector: true, received_on: D("2026-11-10") });
  assert.deepEqual([...r.stopped], ["voice", "sms", "email"]); assert.equal(r.stopped_by_ms, 1_700_000_060_000); assert.equal(r.mail_continues, true); assert.equal(r.mail_allowed, true);
  assert.equal(r.ei_variant, "standard"); assert.equal(r.cease_scope, "oral_calls_only"); assert.equal(status.cease_scope, "oral_calls_only"); assert.equal(overlayOf(status).cease_active, false);
  assert.deepEqual(r.fdcpa_events.map((e) => e.type), ["consent.revoked", "consent.revocation.honored"]);
  assert.equal(r.channels.ai_voice, false); assert.equal(r.channels.sms, false); assert.equal(r.channels.route, "human_manual_dial");
  assert.match(r.transcript_explanation, /in writing/);
  assert.deepEqual([...oralCease({ at_ms: 0, consented_channels: ["voice"] }).stopped], ["voice"]);
});
test("11.4-T9: Given an attorney letter of representation, then direct communications are refused, counsel receives the communications, and after 30 days of documented non-response direct contact re-opens with a decision record.", () => {
  const early = attorneyGate({ designated_on: D("2026-10-05"), counsel_contacted_on: D("2026-10-06"), counsel_responded: false, today: D("2026-10-20") });
  assert.equal(early.direct_allowed, false); assert.equal(early.route, "counsel"); assert.equal(early.reopen_on, D("2026-11-05")); assert.equal(early.decision_record, null);
  const late = attorneyGate({ designated_on: D("2026-10-05"), counsel_contacted_on: D("2026-10-06"), counsel_responded: false, today: D("2026-11-05") });
  assert.equal(late.direct_allowed, true); assert.equal(late.decision_record!.action, "direct_contact_reopened");
  assert.equal(attorneyGate({ designated_on: D("2026-10-05"), counsel_contacted_on: D("2026-10-06"), counsel_responded: true, today: D("2026-12-05") }).direct_allowed, false);
});
test("11.4-T10: Given the validation notice mailed 2026-10-02 with no undeliverability notice by 2026-10-16, then `furnishing_gate_open_at`=2026-10-16 and 8.x may furnish; given a conversation on 2026-10-05, then the gate opens 2026-10-05.", () => {
  assert.deepEqual(furnishingGate({ mailed_on: D("2026-10-02") }), { furnishing_gate_open_at: D("2026-10-16"), basis: "14 days after mailing with no undeliverability notice" });
  assert.equal(furnishingGate({ mailed_on: D("2026-10-02"), conversation_on: D("2026-10-05") }).furnishing_gate_open_at, D("2026-10-05"));
  assert.equal(furnishingGate({ mailed_on: D("2026-10-02"), undeliverable_on: D("2026-10-10") }).furnishing_gate_open_at, null);
});
test("11.4-T11: Given an SMS to a consented number last RND-checked 70 days ago and no inbound text in 60 days, then the send is refused until a fresh RND check.", async () => {
  assert.deepEqual(smsRndGate({ days_since_rnd_check: 70, days_since_consumer_texted: 61 }), { allowed: false, refused_by: "REGF_1006_6D5_SMS_RND_60" });
  assert.equal(smsRndGate({ days_since_rnd_check: 10, days_since_consumer_texted: null }).allowed, true);
  assert.equal(smsRndGate({ days_since_rnd_check: null, days_since_consumer_texted: 30 }).allowed, true);
  // through the bus: `edeliver.send{channel=sms}` on a DC loan runs `gates.evaluate` — `contact.attempt.requested{mode=sms, fdcpa_debt_collector=true}` arms REGF_1006_6D5_SMS_RND_60
  // (evaluator 11.4.reassignedNumberCheckFresh) and the 70-day-old check with no inbound text in 60 days is refused on that code; a fresh RND check (10 days) sends
  const ctx = uowGated(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: { edelivery: edeliveryPort } }; const agents = new AgentRegistry(); const send = bind(rt, agents, "11.2", "edeliver.send"); const bus = new CommandBus(agents);
  const sms = { loan_id: "L-DC", notice_id: "n-sms-1", address: "+15555550123", channel: "sms", esign_consent_regx_ei: true, fdcpa_debt_collector: true, subject: "A message from Supermortgage", body: "This communication is from a debt collector. Reply STOP to opt out at no charge.", days_since_rnd_check: 70, days_since_consumer_texted_from_number: 61 };
  await assert.rejects(bus.execute(send, DC_AGENT, sms, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REGF_1006_6D5_SMS_RND_60");
  const req = ctx.events.all().find((e) => e.type === "contact.attempt.requested")!; assert.equal(req.payload.mode, "sms"); assert.equal(req.payload.fdcpa_debt_collector, true); assert.equal(req.payload.days_since_rnd_check, 70); assert.equal(req.payload.days_since_consumer_texted_from_number, 61);
  assert.ok(eventMatches(loadOverriddenRegistry().get("REGF_1006_6D5_SMS_RND_60")!.triggerPattern!, req));
  const armed = ctx.timers.byCode("REGF_1006_6D5_SMS_RND_60"); assert.equal(armed.length, 1); assert.equal(armed[0]!.status, "armed"); assert.equal(armed[0]!.note, "evaluator:11.4.reassignedNumberCheckFresh"); assert.equal(armed[0]!.armedByEventId, req.id);
  assert.ok(ctx.events.all().some((e) => e.type === "command.refused" && e.payload.code === "REGF_1006_6D5_SMS_RND_60")); assert.ok(!ctx.events.all().some((e) => e.type === "notice.edelivery.sent"));
  const fresh = await bus.execute(send, DC_AGENT, { ...sms, notice_id: "n-sms-2", days_since_rnd_check: 10 }, ctx); assert.equal((fresh.output as { status: string }).status, "queued"); assert.ok(ctx.events.all().some((e) => e.type === "notice.edelivery.sent" && e.payload.notice_id === "n-sms-2")); assert.equal(ctx.timers.byCode("REGF_1006_6D5_SMS_RND_60").length, 2);
});
test("11.4-T12: Given any DC-loan email, then the opt-out statement is present and the subject line contains no debt reference (automated check, 100 %).", async () => {
  const ok = dcEmailCheck({ subject: "A message from Supermortgage", body: "... This communication is from a debt collector. To opt out of email, reply with the word unsubscribe." });
  assert.equal(ok.compliant, true);
  assert.equal(dcEmailCheck({ subject: "Your past due mortgage payment", body: "opt out" }).subject_clean, false);
  assert.equal(dcEmailCheck({ subject: "Hello", body: "no way out" }).opt_out_present, false);
  // through the bus: `edeliver.send` on a DC loan — the opt-out guardrail refuses before the handler; the handler's `gates.evaluate` refuses a body without the §1006.18(e) fragment on
  // REGF_1006_18E_DISCLOSURE_GATE; a compliant email sends and `communication.outbound.requested{fdcpa_debt_collector=true, channel=email}` has armed REGF_1006_6E_OPTOUT_PRESENT (evaluator 11.4.optOutPresent) and the 18E gate
  const ctx = uowGated(); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: { edelivery: edeliveryPort } }; const agents = new AgentRegistry(); const send = bind(rt, agents, "11.2", "edeliver.send"); const bus = new CommandBus(agents);
  const base = { loan_id: "L-DC", notice_id: "n-em-1", address: "b@example.com", channel: "email", esign_consent_regx_ei: true, fdcpa_debt_collector: true, subject: "A message from Supermortgage" };
  await assert.rejects(bus.execute(send, DC_AGENT, { ...base, body: "This communication is from a debt collector. Please call us." }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "OPT_OUT_LINE_REQUIRED");
  await assert.rejects(bus.execute(send, DC_AGENT, { ...base, subject: "Your past due mortgage payment", body: "This communication is from a debt collector. To opt out of email, reply unsubscribe." }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "OPT_OUT_LINE_REQUIRED");
  assert.equal(ctx.events.all().filter((e) => e.type === "communication.outbound.requested").length, 0);   // guardrails run before the handler: nothing was requested
  await assert.rejects(bus.execute(send, DC_AGENT, { ...base, body: "Please call us about your account. To opt out of email, reply unsubscribe." }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REGF_1006_18E_DISCLOSURE_GATE");
  const r = await bus.execute(send, DC_AGENT, { ...base, body: "This communication is from a debt collector. To opt out of email, reply with the word unsubscribe (no fee)." }, ctx); assert.equal((r.output as { status: string }).status, "queued");
  const reqs = ctx.events.all().filter((e) => e.type === "communication.outbound.requested"); assert.equal(reqs.length, 2); assert.equal(reqs[0]!.payload.disclosure_fragment_present, false); assert.equal(reqs[1]!.payload.disclosure_fragment_present, true); assert.equal(reqs[1]!.payload.opt_out_statement_present, true); assert.equal(reqs[1]!.payload.subject_clean, true); assert.equal(reqs[1]!.payload.channel, "email");
  const reg = loadOverriddenRegistry(); assert.ok(eventMatches(reg.get("REGF_1006_6E_OPTOUT_PRESENT")!.triggerPattern!, reqs[1]!)); assert.ok(eventMatches(reg.get("REGF_1006_18E_DISCLOSURE_GATE")!.triggerPattern!, reqs[1]!)); assert.ok(!eventMatches(reg.get("REGF_1006_2_LCM_ONLY_VOICEMAIL")!.triggerPattern!, reqs[1]!));
  const optOut = ctx.timers.byCode("REGF_1006_6E_OPTOUT_PRESENT"); assert.equal(optOut.length, 2); assert.ok(optOut.every((t) => t.status === "armed" && t.note === "evaluator:11.4.optOutPresent")); assert.equal(optOut[1]!.armedByEventId, reqs[1]!.id); assert.equal(ctx.timers.byCode("REGF_1006_18E_DISCLOSURE_GATE").length, 2);
  // §1006.6(e): a fee for the opt-out fails the same gate
  const fee = evaluateOutboundCommunication({ events: ctx.events, actor: DC_AGENT, now: ctx.clock.now(), loanId: "L-DC" }, { loan_id: "L-DC", channel: "email", fdcpa_debt_collector: true, text: "This communication is from a debt collector. To opt out, reply unsubscribe.", subject: "Hello", ref_date: D("2026-10-20"), opt_out_fee: true });
  assert.deepEqual([...fee.refused_by], ["REGF_1006_6E_OPTOUT_PRESENT"]);
});
test(`11.4-T13: Given a voicemail on a DC loan, then only the LCM template is used (business name, request to reply, agent name, number); a message mentioning "your mortgage payment" is refused.`, async () => {
  const base = { business_name: "Supermortgage", agent_name: "Ava", phone: "(800) 555-0199" };
  const ok = voicemailCheck({ ...base, text: "This is Ava from Supermortgage. Please call me back at (800) 555-0199. You may speak with any representative." });
  assert.equal(ok.allowed, true); assert.equal(ok.template, "limited_content");
  const bad = voicemailCheck({ ...base, text: "This is Ava from Supermortgage about your mortgage payment. Please call me back at (800) 555-0199." });
  assert.equal(bad.allowed, false); assert.ok(bad.violations.includes("mentions the debt"));
  // through the bus: `contact.log{outcome=voicemail_left}` on a DC loan runs `gates.evaluate` — `communication.outbound.requested{fdcpa_debt_collector=true, channel=voicemail}` arms
  // REGF_1006_2_LCM_ONLY_VOICEMAIL (evaluator 11.4.limitedContentMessageOnly); the message mentioning "your mortgage payment" is refused on that code and no contact is logged; the LCM logs
  const ctx = uowGated("L-DC", "2026-10-21T16:00:00.000Z"); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const agents = new AgentRegistry(); const log = bind(rt, agents, "11.3", "contact.log"); const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  const attempt = { loan_id: "L-DC", mode: "ai_voice", direction: "outbound", outcome: "voicemail_left", on: "2026-10-21", fdcpa_debt_collector: true, pre_dial_checks: { consent: true, quiet_hours: true, regf_count: true, post_conversation: true, pre_sale: true, cease_flags: true, bk_flag: true, attorney_flag: true, workplace: true } };
  await assert.rejects(bus.execute(log, comms, { ...attempt, voicemail: { ...base, text: "This is Ava from Supermortgage about your mortgage payment. Please call me back at (800) 555-0199." } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REGF_1006_2_LCM_ONLY_VOICEMAIL");
  assert.ok(ctx.events.all().some((e) => e.type === "command.refused" && e.payload.code === "REGF_1006_2_LCM_ONLY_VOICEMAIL" && /mentions the debt/.test(String(e.payload.reason)))); assert.ok(!ctx.events.all().some((e) => e.type === "contact.attempted")); assert.equal(rt.store.list("contacts").length, 0);
  const reqs = ctx.events.all().filter((e) => e.type === "communication.outbound.requested"); assert.equal(reqs.length, 1); assert.equal(reqs[0]!.payload.channel, "voicemail"); assert.equal(reqs[0]!.payload.voicemail_template, "non_limited_content");
  assert.ok(eventMatches(loadOverriddenRegistry().get("REGF_1006_2_LCM_ONLY_VOICEMAIL")!.triggerPattern!, reqs[0]!)); const lcm = ctx.timers.byCode("REGF_1006_2_LCM_ONLY_VOICEMAIL"); assert.equal(lcm.length, 1); assert.equal(lcm[0]!.status, "armed"); assert.equal(lcm[0]!.note, "evaluator:11.4.limitedContentMessageOnly"); assert.equal(lcm[0]!.armedByEventId, reqs[0]!.id);
  await bus.execute(log, comms, { ...attempt, voicemail: { ...base, text: "This is Ava from Supermortgage. Please call me back at (800) 555-0199. You may speak with any representative." } }, ctx);
  assert.ok(ctx.events.all().some((e) => e.type === "contact.attempted" && e.payload.outcome === "voicemail_left")); assert.equal(ctx.events.all().filter((e) => e.type === "communication.outbound.requested")[1]!.payload.voicemail_template, "limited_content"); assert.equal(ctx.timers.byCode("REGF_1006_2_LCM_ONLY_VOICEMAIL").length, 2);
});
test("11.4-T14: Given a deceased borrower reported by a neighbor, then no debt information is disclosed, location information for the estate may be requested, and communications wait for an executor/successor (4.4).", () => {
  const r = deceasedReport({ reporter_relation: "neighbor" });
  assert.equal(r.disclose_debt, false); assert.equal(r.may_request_location_info, true); assert.equal(r.wait_for, "executor_or_successor"); assert.equal(r.route, "4.4"); assert.equal(r.reporter_is_consumer, false);
  assert.equal(deceasedReport({ reporter_relation: "executor" }).reporter_is_consumer, true);
});
test(`11.4-T15: Given the AI persona "Ava," then the assumed name is in the registry and every DC-loan call transcript shows "Ava with Supermortgage… this communication is from a debt collector."`, async () => {
  const r = assumedNameCheck({ persona: "Ava", registry: ["Ava", "Sam"], transcript: "Hi, this is Ava with Supermortgage. This communication is from a debt collector." });
  assert.equal(r.compliant, true); assert.equal(r.registered, true);
  assert.equal(assumedNameCheck({ persona: "Zed", registry: ["Ava"], transcript: "Zed with Supermortgage. This communication is from a debt collector." }).compliant, false);
  assert.equal(assumedNameCheck({ persona: "Ava", registry: ["Ava"], transcript: "Ava with Supermortgage. How are you?" }).disclosure_present, false);
  // through the bus: a DC-loan conversation logged with its transcript runs `gates.evaluate` — `communication.outbound.requested{fdcpa_debt_collector=true}` arms REGF_1006_18E_DISCLOSURE_GATE
  // (evaluator 11.4.disclosureFragmentPresent); the transcript without "this communication is from a debt collector" is refused on that code, Ava's is logged
  const ctx = uowGated("L-DC", "2026-10-21T16:00:00.000Z"); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const agents = new AgentRegistry(); const log = bind(rt, agents, "11.3", "contact.log"); const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  const call = { loan_id: "L-DC", mode: "ai_voice", direction: "outbound", outcome: "conversation", on: "2026-10-21", fdcpa_debt_collector: true, party_id: "B", pre_dial_checks: { consent: true, quiet_hours: true, regf_count: true, post_conversation: true, pre_sale: true, cease_flags: true, bk_flag: true, attorney_flag: true, workplace: true } };
  await assert.rejects(bus.execute(log, comms, { ...call, transcript: "Hi, this is Ava with Supermortgage. How are you?" }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "REGF_1006_18E_DISCLOSURE_GATE");
  assert.ok(!ctx.events.all().some((e) => e.type === "contact.completed"));
  await bus.execute(log, comms, { ...call, transcript: "Hi, this is Ava with Supermortgage. This communication is from a debt collector." }, ctx);
  assert.ok(ctx.events.all().some((e) => e.type === "contact.completed" && e.payload.fdcpa_debt_collector === true));
  const reqs = ctx.events.all().filter((e) => e.type === "communication.outbound.requested"); assert.deepEqual(reqs.map((e) => e.payload.disclosure_fragment_present), [false, true]); assert.deepEqual(reqs.map((e) => e.payload.disclosure_variant), ["subsequent", "subsequent"]);
  const reg = loadOverriddenRegistry(); assert.ok(reqs.every((e) => eventMatches(reg.get("REGF_1006_18E_DISCLOSURE_GATE")!.triggerPattern!, e))); const gate = ctx.timers.byCode("REGF_1006_18E_DISCLOSURE_GATE"); assert.equal(gate.length, 2); assert.ok(gate.every((t) => t.status === "armed" && t.note === "evaluator:11.4.disclosureFragmentPresent")); assert.equal(gate[1]!.armedByEventId, reqs[1]!.id);
  // the initial communication needs the full §1006.18(e)(1) statement; the subsequent wording alone does not carry it (rule 11)
  const gctx = { events: ctx.events, actor: DC_AGENT, now: ctx.clock.now(), loanId: "L-DC" };
  assert.deepEqual([...evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, initial_communication: true, text: "Ava with Supermortgage. This communication is from a debt collector.", ref_date: D("2026-10-21"), dial: { mode: "ai_voice", on: D("2026-10-21") } }).refused_by], ["REGF_1006_18E_DISCLOSURE_GATE"]);
  assert.equal(evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, initial_communication: true, text: "Supermortgage is a debt collector. We are attempting to collect a debt and any information obtained will be used for that purpose.", ref_date: D("2026-10-21"), dial: { mode: "ai_voice", on: D("2026-10-21") } }).allowed, true);
});
test("11.4-T16: Given a CA loan boarded current, then Reg F is not applicable but the Rosenthal overlay enforces quiet hours and harassment rules in the Contact Engine.", async () => {
  const r = stateOverlay({ state: "CA", debt_collector: false });
  assert.equal(r.regf_applicable, false); assert.deepEqual([...r.overlays], ["rosenthal_ca"]); assert.equal(r.contact_engine.quiet_hours, true); assert.equal(r.contact_engine.harassment_rules, true);
  assert.equal(stateOverlay({ state: "TX", debt_collector: false }).contact_engine.harassment_rules, false);
  assert.equal(stateOverlay({ state: "MA", debt_collector: false }).contact_engine.call_cap_7d, 2);
  // the Contact Engine consumes the overlay: a CA non-DC loan is refused at 21:30 PT (quiet hours) and on the 6th counted call in 7 days
  // (Rosenthal harassment rules through the policy cap of 5), an MA loan on the 3rd (940 CMR 7.04), a TX loan on the 6th (policy)
  const PT = "America/Los_Angeles"; const at = (d: string, t: string) => zonedEpochMs(D(d), t, PT);
  const late = contactEngineChecks({ state: "CA", debt_collector: false, dial_at_ms: at("2026-12-08", "21:30"), time_zones: [PT], mode: "voice", attempts: [], person: "B" });
  assert.equal(late.allowed, false); assert.deepEqual([...late.refused_by], ["REGF_1006_6B1_QUIET_HOURS"]); assert.deepEqual([...late.overlay.overlays], ["rosenthal_ca"]);
  const five: CallAttempt[] = Array.from({ length: 5 }, (_, k) => ({ at_ms: at("2026-12-02", "10:00") + k * 86_400_000, person: "B", outcome: "no_answer" }));
  const sixth = contactEngineChecks({ state: "CA", debt_collector: false, dial_at_ms: at("2026-12-08", "10:00"), time_zones: [PT], mode: "voice", attempts: five, person: "B" });
  assert.equal(sixth.allowed, false); assert.deepEqual([...sixth.refused_by], ["STATE_ROSENTHAL_CA_HARASSMENT"]); assert.equal(sixth.frequency!.cap, 5);
  assert.equal(contactEngineChecks({ state: "CA", debt_collector: false, dial_at_ms: at("2026-12-08", "10:00"), time_zones: [PT], mode: "voice", attempts: five.slice(0, 4), person: "B" }).allowed, true);
  const ma = contactEngineChecks({ state: "MA", debt_collector: false, dial_at_ms: at("2026-12-08", "13:00"), time_zones: ["America/New_York"], mode: "voice", attempts: five.slice(0, 2), person: "B" }); assert.deepEqual([...ma.refused_by], ["STATE_MA_940_CMR_7_CALL_CAP"]);
  assert.deepEqual([...contactEngineChecks({ state: "TX", debt_collector: false, dial_at_ms: at("2026-12-08", "10:00"), time_zones: ["America/Chicago"], mode: "voice", attempts: five, person: "B" }).refused_by], ["SM_POLICY_CALL_CAP_5IN7"]);
  // through the bus: contact.log computes the pre-dial checks from `pre_dial_facts` through the evaluators — 21:30 PT is refused, 10:00 PT logs with computed checks
  const ctx = uow("L-CA", "2026-12-09T05:30:00.000Z"); const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(ctx.events, ctx.clock), services: {}, ports: {} }; const agents = new AgentRegistry();
  const cmd = toolCommand(SECTION_11_TOOLS.find((x) => x.process === "11.3" && x.name === "contact.log")!, rt, ["human_agent"]); agents.registerTool("borrower-comms", cmd.name); const bus = new CommandBus(agents); const comms: Actor = { kind: "agent", id: "borrower-comms" };
  const facts = { state: "CA", fdcpa_debt_collector: false, line_type: "mobile", tcpa_voice_consent_active: true, time_zones: [PT], counted_call_attempts_at: [], days_since_conversation: 30 };
  await assert.rejects(bus.execute(cmd, comms, { loan_id: "L-CA", mode: "ai_voice", direction: "outbound", outcome: "no_answer", pre_dial_facts: { ...facts, dial_at: new Date(at("2026-12-08", "21:30")).toISOString() } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "PRE_DIAL_CHECKS_REQUIRED");
  const ok = await bus.execute(cmd, comms, { loan_id: "L-CA", mode: "ai_voice", direction: "outbound", outcome: "no_answer", pre_dial_facts: { ...facts, dial_at: new Date(at("2026-12-08", "10:00")).toISOString() } }, ctx);
  assert.equal((ok.output as { pre_dial_checks_computed: boolean }).pre_dial_checks_computed, true); assert.deepEqual((ok.output as { pre_dial_checks: Record<string, boolean> }).pre_dial_checks, { consent: true, quiet_hours: true, regf_count: true, post_conversation: true, pre_sale: true, cease_flags: true, bk_flag: true, attorney_flag: true, workplace: true });
  await assert.rejects(bus.execute(cmd, comms, { loan_id: "L-CA", mode: "ai_voice", direction: "outbound", outcome: "no_answer", pre_dial_facts: { ...facts, tcpa_voice_consent_active: false, dial_at: new Date(at("2026-12-08", "10:00")).toISOString() } }, ctx), (e: unknown) => e instanceof CommandRefused && e.code === "PRE_DIAL_CHECKS_REQUIRED");   // no TCPA consent on a mobile
});

test("11.4 gates.evaluate: a DC-loan pre-dial request arms the workplace and 7-in-7 gates, the overlays close the door, and a bad request appends nothing", () => {
  const clock = new FixedClock("2026-10-21T16:00:00.000Z"); const events = new MemoryEventStore(clock); const registry = loadOverriddenRegistry(); const engine = new TimerEngine(registry, events, { processes: ["11.1", "11.4"] }); const gctx = { events, actor: DC_AGENT, now: clock.now(), loanId: "L-DC" };
  const script = "Hi, this is Ava with Supermortgage. This communication is from a debt collector.";
  // §1006.6(b)(3): a workplace number the employer prohibits — `contact.attempt.requested{workplace_flag=true, employer_prohibits=true}` arms REGF_1006_6B3_WORKPLACE_GATE (evaluator 11.4.workplaceProhibited) and the call is refused on it
  const work = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21"), dial: { mode: "human_voice", on: D("2026-10-21"), person: "B", number_id: "n-work", workplace_flag: true, employer_prohibits: true } });
  assert.deepEqual([...work.refused_by], ["REGF_1006_6B3_WORKPLACE_GATE"]); const req = work.events[1]!; assert.equal(req.type, "contact.attempt.requested"); assert.equal(req.payload.mode, "voice"); assert.equal(req.payload.dial_mode, "human_voice"); assert.equal(req.payload.direction, "outbound"); assert.equal(req.payload.fdcpa_debt_collector_flag, true);
  assert.ok(eventMatches(registry.get("REGF_1006_6B3_WORKPLACE_GATE")!.triggerPattern!, req)); const wp = engine.byCode("REGF_1006_6B3_WORKPLACE_GATE"); assert.equal(wp.length, 1); assert.equal(wp[0]!.status, "armed"); assert.equal(wp[0]!.note, "evaluator:11.4.workplaceProhibited"); assert.equal(wp[0]!.armedByEventId, req.id);
  // the same request arms 11.1's REGF_1006_14_CALL_CAP_7IN7 (`mode=voice, direction=outbound, fdcpa_debt_collector_flag=true`; evaluator 11.1.callCap7in7): seven counted calls in the trailing 7 days refuse the eighth, six allow the seventh
  assert.ok(eventMatches(registry.get("REGF_1006_14_CALL_CAP_7IN7")!.triggerPattern!, req)); assert.equal(engine.byCode("REGF_1006_14_CALL_CAP_7IN7").length, 1); assert.equal(engine.byCode("REGF_1006_14_CALL_CAP_7IN7")[0]!.note, "evaluator:11.1.callCap7in7");
  const seven = Array.from({ length: 7 }, (_, k) => new Date(Date.parse("2026-10-15T14:00:00.000Z") + k * 86_400_000).toISOString());
  const capped = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21"), dial: { mode: "ai_voice", on: D("2026-10-21"), now: "2026-10-21T16:00:00.000Z", counted_call_attempts_at: seven } });
  assert.deepEqual([...capped.refused_by], ["REGF_1006_14_CALL_CAP_7IN7"]); assert.equal(capped.gates.find((x) => x.code === "REGF_1006_6B3_WORKPLACE_GATE")!.open, true);
  assert.equal(evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21"), dial: { mode: "ai_voice", on: D("2026-10-21"), now: "2026-10-21T16:00:00.000Z", counted_call_attempts_at: seven.slice(1) } }).allowed, true);
  // an unanswered attempt conveys nothing (§1006.2(b)): the content gates do not attach, the pre-dial gates do
  const noAnswer = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, text: "", attempt_only: true, ref_date: D("2026-10-21"), dial: { mode: "ai_voice", on: D("2026-10-21") } });
  assert.equal(noAnswer.allowed, true); assert.deepEqual(noAnswer.gates.map((x) => x.code), ["REGF_1006_6B3_WORKPLACE_GATE", "REGF_1006_14_CALL_CAP_7IN7"]);
  // the overlays (11.4 rules 5–7): a written cease refuses an outbound collection call but answers a borrower-initiated loss-mitigation call; an open dispute refuses; counsel routes
  const cease = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, text: script, ref_date: D("2026-11-11"), dial: { mode: "ai_voice", on: D("2026-11-11") }, overlay: { cease_active: true } });
  assert.deepEqual([...cease.refused_by], ["REGF_1006_6C_CEASE_GATE"]); assert.match(cease.gates[0]!.reason!, /1006\.6\(c\)/);
  assert.equal(evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, text: script, ref_date: D("2026-11-11"), dial: { mode: "ai_voice", on: D("2026-11-11") }, overlay: { cease_active: true }, borrower_initiated: true, kind: "lossmit_response" }).allowed, true);
  assert.equal(evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "statement", fdcpa_debt_collector: true, text: "Statement. This communication is from a debt collector.", ref_date: D("2026-11-11"), overlay: { cease_active: true, dispute_open: true } }).allowed, true);   // periodic statements continue
  assert.deepEqual([...evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "letter", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21"), overlay: { dispute_open: true } }).refused_by], ["REGF_1006_38_DISPUTE_CEASE_GATE"]);
  assert.deepEqual([...evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "letter", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21"), overlay: { attorney_represented: true } }).refused_by], ["REGF_1006_6B2_ATTORNEY_GATE"]);
  // §1006.42: the B-1 by email without an E-SIGN consent for class regf_validation falls back to mail (not a refusal)
  const b1 = evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "email", fdcpa_debt_collector: true, template: "NTC_REGF_1006_34_VALIDATION_B1", text: "Supermortgage is a debt collector. We are attempting to collect a debt and any information obtained will be used for that purpose. You may dispute the debt. To opt out of email, reply unsubscribe.", subject: "Important information from Supermortgage", initial_communication: true, ref_date: D("2026-10-02") });
  assert.equal(b1.allowed, true); assert.equal(b1.fallback, "mail"); assert.equal(engine.byCode("REGF_1006_42_ESIGN_GATE").length, 0);   // that gate keys on notice.rendered (timers.ts), not on the request
  assert.equal(evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "email", fdcpa_debt_collector: true, template: "NTC_REGF_1006_34_VALIDATION_B1", text: "We are attempting to collect a debt and any information obtained will be used for that purpose. To opt out, reply unsubscribe.", subject: "From Supermortgage", initial_communication: true, ref_date: D("2026-10-02"), esign_consent_regf_validation: true }).fallback, null);
  // input validation: nothing is appended on a bad request
  const before = events.all().length;
  assert.throws(() => evaluateOutboundCommunication(gctx, { loan_id: "", channel: "voice", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21"), dial: { mode: "ai_voice", on: D("2026-10-21") } }), RangeError);
  assert.throws(() => evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voice", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21") }), /dial/);
  assert.throws(() => evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "voicemail", fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21"), dial: { mode: "ai_voice", on: D("2026-10-21") } }), /voicemail/);
  assert.throws(() => evaluateOutboundCommunication(gctx, { loan_id: "L-DC", channel: "fax" as never, fdcpa_debt_collector: true, text: script, ref_date: D("2026-10-21") }), RangeError);
  assert.equal(events.all().length, before);
});
