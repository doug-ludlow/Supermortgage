// 3.3 Annual escrow account statement
// spec/sections/03-escrow-administration/3-3-annual-escrow-account-statement.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D, addMonths, addDays } from "../../kernel/calendar/date.ts";
import { cents } from "../../kernel/money/cents.ts";
import { project, decide, newPayment, cushion, effectiveDate, anomalies } from "./analysis.ts";
const E = [{ line_type: "school_tax", amount_cents: cents("360"), disburse_on: D("2026-09-15") }, { line_type: "county_tax", amount_cents: cents("500"), disburse_on: D("2026-07-15") }, { line_type: "county_tax", amount_cents: cents("700"), disburse_on: D("2026-12-15") }];
const A = [{ line_type: "county_tax", amount_cents: cents("520"), disburse_on: D("2027-07-15") }, { line_type: "county_tax", amount_cents: cents("760"), disburse_on: D("2027-12-15") }, { line_type: "school_tax", amount_cents: cents("380"), disburse_on: D("2027-09-15") }];
void E; void A; void addMonths; void addDays; void project; void decide; void newPayment; void cushion; void effectiveDate; void anomalies;
import { exemption as stmtExemption, annualDeadline, postExemptionDeadline, lowPointExplanation, lumpSumWordingAllowed } from "./statement.ts";
import { assembleAnnualStatement, buildHistory, exemptHold, recordExemptHold, recordStatementSent, transferOutStatements, payoffStatement, utahSupplement, bankruptcyStatement, sendWithFallback, planText, decisionText, disbursementsByLine } from "./ops.ts";
import { endExemption, endExemptionFromEvent, exemptionReactors_3_3, openExemptHold, settleExemption, applyExemptionPolicy, exemptionFactsFromLog, recordBorrowerRequest, POST_EXEMPTION_NOTICE } from "./ops-3-3.ts";
import { MemoryEventStore, FixedClock, SYSTEM, eventMatches, type Actor, type DomainEvent } from "../../kernel/events/index.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { addBusinessDays, servicer } from "../../kernel/calendar/business.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import { NoticeService, type Notice } from "../../notices/service.ts";
import type { Recipient } from "../../notices/channel.ts";
import { FakePrintMail, FakeEdelivery } from "../../infra/integrations/delivery.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { EscalationService } from "../../app/escalations.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { CommandBus } from "../../app/commands.ts";
import { SECTION_03_TOOLS } from "../../app/tools/section03.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { buildRegistry, publishAuthored } from "../../notices/catalog.ts";
const noticeReg = (() => { const reg = buildRegistry(); publishAuthored(reg); return reg; })();
const ESCROW: Actor = { kind: "agent", id: "escrow" };
const BORROWER: Recipient = { partyId: "borrower", name: "Bea Borrower", mailingAddress: "1 Test St, Testville TX 75001" };
/** The 3.3 tools (renderStatement / validateChecklist / sendNotice) on the bus for one loan, with the overridden registry's 3.3 rows listening and the Notice Registry rendering for real. */
function harness(now: string, loanId = "L-1") {
  const clock = new FixedClock(now); const events = new MemoryEventStore(clock); const engine = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["3.3"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers: engine, clock, decide: () => {} };
  const notices = new NoticeService({ registry: noticeReg, events, clock, printMail: new FakePrintMail(), edelivery: new FakeEdelivery() });
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, notices, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const cmds = new Map(SECTION_03_TOOLS.filter((t) => t.process === "3.3").map((t) => { const c = toolCommand(t, rt, ["human_agent", "officer"]); agents.registerTool(t.agent, c.name); return [t.name, c] as const; }));
  const run = (name: string, input: Record<string, unknown>, actor: Actor = ESCROW) => bus.execute(cmds.get(name)!, actor, input, ctx);
  return { clock, events, engine, ctx, rt, notices, run, timer: (code: string) => engine.byCode(code).filter((t) => t.loanId === loanId) };
}
/** A loan whose annual analysis was approved: the registry timers of 3.3 (with the §3 overrides) armed from the approval fact. */
const approvedLoan = (now: string, approval: Record<string, unknown>) => {
  const h = harness(now);
  h.events.append({ type: "escrow.analysis.approved", loanId: "L-1", actor: SYSTEM, payload: { analysis_id: "EA-1", analysis_type: "annual", as_of: "2027-05-16", decision: "shortage", computation_year_end: "2027-06-30", next_computation_year_end: "2028-06-30", starts_computation_year: true, reset: false, ...approval } });
  return h;
};
const lastOf = (events: MemoryEventStore, type: string): DomainEvent => { const l = events.ofType(type); assert.ok(l.length > 0, `no ${type} event`); return l[l.length - 1]!; };
import { buildPlan, type Plan } from "./shortage.ts";
import { SHORT_YEAR_PAYOFF_VERSION } from "../../notices/authored/section03.ts";
import { sourceHash, type TemplateVersion } from "../../notices/registry.ts";
import { evaluateChecklist } from "../../notices/checklist.ts";
import { render } from "../../notices/render.ts";
/** The example loan's ledger year: start $1,040.00; 12 × $130.00; bills Jul $520 (proj. $500), Sep $360, Dec $760 (proj. $700), Mar $260 supplemental (not projected). Balances are computed, not supplied. */
const HISTORY = buildHistory(104_000n, Array.from({ length: 12 }, (_, i) => ({ month: addMonths(D("2026-07-01"), i), deposits_cents: 13_000n, disbursements: i === 0 ? [{ line: "County tax", amount_cents: 52_000n, projected_cents: 50_000n }] : i === 2 ? [{ line: "School tax", amount_cents: 36_000n, projected_cents: 36_000n }] : i === 5 ? [{ line: "County tax", amount_cents: 76_000n, projected_cents: 70_000n }] : i === 8 ? [{ line: "supplemental tax", amount_cents: 26_000n, projected_cents: null }] : [] })));
const PROJ = project(A, D("2027-07-01")); const DECISION = decide({ projection: PROJ, projected_actual_cents: cents("700"), as_of: D("2027-05-16"), regx_days_delinquent: 0 }); const PLAN = buildPlan("shortage", 40_668n, D("2027-07-01"), {}) as Plan;
const BASE = { year_start: D("2026-07-01"), year_end: D("2027-06-30"), new_payment_cents: 17_222n, prior_escrow_portion_cents: 13_000n, history: HISTORY, decision: DECISION, plan: PLAN, one_month_cents: PROJ.base_payment_cents, prior_projection: project(E, D("2026-07-01")), low_point_explanation: ["low balance $180.00 vs $260.00 projected"] };
const annualVersion = () => buildRegistry().versionsOf("NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT")[0]!;
/** The 3.3 renderStatement tool input for the example loan (the exemption facts are never in it: the tool reads them off the engine's analysis record and the log). */
const RENDER_INPUT: Record<string, unknown> = { year_start: "2026-07-01", year_end: "2027-06-30", approved_on: "2027-05-18", new_payment_cents: 17_222n, prior_escrow_portion_cents: 13_000n, history: HISTORY, decision: DECISION, plan: PLAN, prior_projection: project(E, D("2026-07-01")), low_point_explanation: ["low balance $180.00 vs $260.00 projected"] };

test("3.3-T1: Given computation year ending 2027-06-30 and analysis approved 2027-05-18, when rendered, then the statement includes items (i)–(viii), the prior projection attachment, and is sent by 2027-07-30.", () => {
  const s = assembleAnnualStatement({ ...BASE, approved_on: D("2027-05-18") });
  assert.deepEqual(Object.keys(s.items), ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii"]); assert.equal(s.prior_projection_attached, true);
  assert.match((s.items.vi as { surplus_shortage_deficiency: string }).surplus_shortage_deficiency, /shortage of \$406\.68/);                     // (vi) from the decision
  assert.equal((s.items.vii as { plan_text: string }).plan_text, "$33.89 per month for 12 months beginning 07/01/2027");                        // (vii) from the plan
  assert.equal((s.items.iii as { deposits_cents: bigint }).deposits_cents, 156_000n); assert.equal(s.ending_balance_cents, 70_000n);
  assert.equal(s.send_by, "2027-07-30"); assert.equal(s.send_target_on, "2027-07-23");
  assert.equal(s.history.filter((r) => r.assumed).length, 1);                     // June assumed (after the run date)
  assert.equal(assembleAnnualStatement({ ...BASE, prior_projection: null, approved_on: D("2027-05-18") }).prior_projection_attached, false);   // (i): the attachment is a fact, not a default
});
test("3.3-T2: Given the analysis is approved 2027-07-25, when rendered, then history uses actuals for May/June and the timer is still satisfied if sent by 2027-07-30.", () => {
  const s = assembleAnnualStatement({ ...BASE, approved_on: D("2027-07-25") });
  assert.equal(s.history.filter((r) => r.assumed).length, 0);                     // actuals for May/June
  assert.equal(s.send_by, "2027-07-30"); assert.ok(D("2027-07-28") <= s.send_by);
});
test("3.3-T3: Given `regx_days_delinquent = 45` at analysis, then status = `exempt_hold` with reason `delinquent_30`, no statement is mailed, `NTC_REGX_1024_17F_SHORTAGE` is sent if a shortage exists, and the (f)(5) timer is satisfied.", async () => {
  assert.equal(stmtExemption({ regx_days_delinquent: 45, foreclosure_first_legal_filed: false, bankruptcy_open: false }), "delinquent_30");
  assert.equal(exemptHold("delinquent_30", 0n).notice, null);                                                                                    // no shortage → no (f)(5) notice
  // Timers on the registry (§3 overrides): the approval arms the annual-statement deadline (2027-06-30 + 30); the (f)(5) row is recurring and armed by the establishment.
  const { events, engine, timer, rt, run, clock } = approvedLoan("2027-05-18T15:00:00.000Z", {});
  assert.equal(timer("REGX_1024_17I_ANNUAL_STMT_30")[0]!.status, "armed"); assert.equal(timer("REGX_1024_17I_ANNUAL_STMT_30")[0]!.dueDate, "2027-07-30");
  // The engine's analysis record (runEscrowAnalysis stores it; the tool reads the day count off it, never off the caller): 45 days delinquent at the 2027-05-16 as_of, a $406.68 shortage.
  rt.store.put("escrow_analyses", "EA-1", { analysis_id: "EA-1", analysis_type: "annual", as_of: "2027-05-16", regx_days_delinquent: 45, decision: DECISION, status: "approved" }, SYSTEM, clock.now());
  // The (i)(2) hold is the 3.3 renderStatement tool's own rule-5 decision on the bus: status exempt_hold / delinquent_30, no statement rendered or mailed, and its `escrow.statement.exempt_hold` fact discharges the annual-statement deadline like a send would.
  const h = (await run("renderStatement", RENDER_INPUT)).output as { status: string; reason: string; statement_mailed: boolean; notice: string | null; event_type: string; rendered: boolean; already_held: boolean; regx_days_delinquent: number; hold_event_id: string };
  assert.deepEqual([h.status, h.reason, h.statement_mailed, h.notice, h.event_type, h.rendered, h.already_held, h.regx_days_delinquent], ["exempt_hold", "delinquent_30", false, "NTC_REGX_1024_17F_SHORTAGE", "escrow.statement.exempt_hold", false, false, 45]);
  assert.equal(events.ofType("escrow.statement.exempt_hold").length, 1); assert.equal(events.ofType("escrow.statement.exempt_hold")[0]!.id, h.hold_event_id); assert.deepEqual(events.ofType("escrow.statement.sent").map((e) => e.payload.statement_type), []);   // nothing mailed
  assert.deepEqual(events.ofType("escrow.statement.exempt_hold")[0]!.payload, { statement_type: "annual", disposition: "exempt_hold", reason: "delinquent_30", valid_i2_reason: true, as_of: "2027-05-16", shortage_cents: "40668", notice: "NTC_REGX_1024_17F_SHORTAGE" });
  assert.equal(timer("REGX_1024_17I_ANNUAL_STMT_30")[0]!.status, "satisfied");
  assert.equal(((await run("renderStatement", RENDER_INPUT)).output as { already_held: boolean }).already_held, true); assert.equal(events.ofType("escrow.statement.exempt_hold").length, 1);   // a held loan is held once
  assert.equal(recordExemptHold(events, { loan_id: "L-2", reason: "delinquent_30", shortage_cents: 40_668n, as_of: D("2027-05-16"), actor: SYSTEM }).notice, "NTC_REGX_1024_17F_SHORTAGE");                    // the domain fact the tool records
  // Rule 5 over the engine's facts: 30 days is not "more than 30 days overdue" → rendered; an open foreclosure action (first legal filed, not closed) holds; an open bankruptcy case does not (policy: legend, bk_suppress off).
  const clean = harness("2027-05-18T15:00:00.000Z", "L-3"); const facts0 = exemptionFactsFromLog(clean.events, "L-3");
  assert.deepEqual(facts0, { foreclosure_first_legal_filed: false, bankruptcy_open: false, bankruptcy_chapter: null });
  assert.equal(applyExemptionPolicy(clean.events, { loan_id: "L-3", analysis_id: "EA-3", as_of: D("2027-05-16"), regx_days_delinquent: 30, facts: facts0, shortage_cents: 0n, actor: SYSTEM }).status, "render");
  clean.events.append({ type: "foreclosure.first_notice.filed", loanId: "L-3", actor: SYSTEM, payload: { filed_on: "2027-04-01" } });
  assert.equal(exemptionFactsFromLog(clean.events, "L-3").foreclosure_first_legal_filed, true);
  const fcHold = applyExemptionPolicy(clean.events, { loan_id: "L-3", analysis_id: "EA-3", as_of: D("2027-05-16"), regx_days_delinquent: 0, facts: exemptionFactsFromLog(clean.events, "L-3"), shortage_cents: 0n, actor: SYSTEM });
  assert.deepEqual([fcHold.status, (fcHold as { reason: string }).reason, (fcHold as { notice: unknown }).notice], ["exempt_hold", "foreclosure_action", null]);
  clean.events.append({ type: "foreclosure.case.closed", loanId: "L-3", actor: SYSTEM, payload: { reason: "dismissed", closed_on: "2027-06-01" } });
  assert.equal(exemptionFactsFromLog(clean.events, "L-3").foreclosure_first_legal_filed, false);
  const bk = harness("2027-05-18T15:00:00.000Z", "L-4"); bk.events.append({ type: "bankruptcy.case.opened", loanId: "L-4", actor: SYSTEM, payload: { chapter: 13, petition_date: "2027-01-10" } });
  const bkPolicy = applyExemptionPolicy(bk.events, { loan_id: "L-4", analysis_id: "EA-4", as_of: D("2027-05-16"), regx_days_delinquent: 0, facts: exemptionFactsFromLog(bk.events, "L-4"), shortage_cents: 0n, actor: SYSTEM });
  assert.deepEqual([bkPolicy.status, (bkPolicy as { bankruptcy: unknown }).bankruptcy, bk.events.ofType("escrow.statement.exempt_hold").length], ["render", { chapter: 13 }, 0]);
  assert.throws(() => applyExemptionPolicy(bk.events, { loan_id: "L-4", analysis_id: "EA-4", as_of: D("2027-05-16"), regx_days_delinquent: -1, facts: facts0, shortage_cents: 0n, actor: SYSTEM }), RangeError);
  await assert.rejects(harness("2027-05-18T15:00:00.000Z", "L-5").run("renderStatement", RENDER_INPUT), /no approved annual analysis/);                                                        // the tool renders from the engine's approval, never without one
  // The shortage exists → NTC_REGX_1024_17F_SHORTAGE is sent through the statement path; its `escrow.statement.sent{shortage_explained=true}` is what the (f)(5) registry row is satisfied by, and the hold is not.
  const f5 = loadOverriddenRegistry().get("REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL")!; assert.equal(f5.kindNorm, "recurring"); assert.equal(f5.satisfiedPattern!.raw, "escrow.statement.sent{shortage_explained=true}");
  assert.equal(eventMatches(f5.satisfiedPattern!, events.ofType("escrow.statement.exempt_hold")[0]!), false);
  const sent = recordStatementSent(events, { loan_id: "L-1", template: h.notice!, statement_type: "shortage_notice", sent_on: D("2027-05-22"), due_on: D("2027-07-01"), actor: SYSTEM });
  assert.equal(sent.shortage_explained, true); assert.equal(eventMatches(f5.satisfiedPattern!, events.ofType("escrow.statement.sent")[0]!), true);
  assert.equal(events.ofType("escrow.statement.sent").filter((e) => e.payload.statement_type === "annual").length, 0);                                                                          // still no annual statement
  assert.equal(engine.byCode("REGX_1024_17F5_SHORTAGE_NOTICE_ANNUAL").length, 0);   // (kernel note: a recurring row satisfied inside TimerEngine.onEvent re-arms and re-satisfies on the same event — proved here against the registry pattern instead)
  // Edge case "Exemption applied, then borrower becomes current and requests statement → provide (no new timer; log request date and send within 5 business days as policy)": exempt_hold → borrower_requested_while_current → rendered.
  await assert.rejects(run("renderStatement", { ...RENDER_INPUT, requested_on: "2027-08-02", regx_days_delinquent_at_request: 45 }), /only once the loan becomes current/);
  const onRequest = (await run("renderStatement", { ...RENDER_INPUT, requested_on: "2027-08-02", regx_days_delinquent_at_request: 0 })).output as { status: string; rendered: boolean; request: { requested_on: string; send_target_on: string; new_timer: null }; items: Record<string, unknown> };
  assert.deepEqual([onRequest.status, onRequest.rendered, onRequest.request, Object.keys(onRequest.items).length], ["rendered_on_request", true, { requested_on: "2027-08-02", send_target_on: "2027-08-09", new_timer: null }, 8]);
  assert.equal(addBusinessDays(D("2027-08-02"), 5, servicer), "2027-08-09");
  const req = lastOf(events, "escrow.statement.requested"); assert.deepEqual([req.payload.disposition, req.payload.requested_on, req.payload.send_target_on, req.causationId], ["borrower_requested_while_current", "2027-08-02", "2027-08-09", h.hold_event_id]);
  assert.throws(() => recordBorrowerRequest(events, { loan_id: "L-1", requested_on: D("2027-05-01"), regx_days_delinquent_at_request: 0, actor: SYSTEM }), /before the exemption was applied/);
  assert.ok(openExemptHold(events, "L-1"));                                                                                                                                                  // still held until the statement goes out
  recordStatementSent(events, { loan_id: "L-1", template: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", statement_type: "annual", sent_on: D("2027-08-05"), due_on: D("2027-08-09"), actor: SYSTEM, history_to: D("2027-06-30") });
  assert.equal(openExemptHold(events, "L-1"), null);                                                                                                                                         // the statement the hold withheld was provided: nothing left to catch up
  events.append({ type: "loan.reinstated", loanId: "L-1", actor: SYSTEM, payload: { reinstated_on: "2027-09-10" } });
  assert.deepEqual([settleExemption(events, "L-1").ended, events.ofType("escrow.statement.exemption_ended").length, timer("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90").length], [null, 0, 0]);   // no new timer
  assert.throws(() => recordBorrowerRequest(events, { loan_id: "L-1", requested_on: D("2027-09-12"), regx_days_delinquent_at_request: 0, actor: SYSTEM }), /no open \(i\)\(2\) exemption/);
});
test("3.3-T4: Given exemption ended 2027-09-10 by reinstatement, then `REGX_1024_17I2_POST_EXEMPTION_HISTORY_90` due 2027-12-09 and the history covers from the last statement.", async () => {
  assert.equal(postExemptionDeadline(D("2027-09-10")), "2027-12-09");             // REGX_1024_17I2_POST_EXEMPTION_HISTORY_90
  // The loan: last year's annual statement (period to 2026-06-30) was sent; this year's analysis was approved 2027-05-16 with the borrower 45 days delinquent → (i)(2) hold (T3). The 3.3 ingestion of §13/§14 events is wired on the store.
  const { events, engine, timer, run, notices, clock } = approvedLoan("2027-05-18T15:00:00.000Z", {}); const off = exemptionReactors_3_3(events);
  recordStatementSent(events, { loan_id: "L-1", template: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", statement_type: "annual", sent_on: D("2026-07-20"), due_on: D("2026-07-30"), actor: SYSTEM, history_to: D("2026-06-30") });
  events.append({ type: "loan.reinstated", loanId: "L-1", actor: SYSTEM, payload: { reinstated_on: "2027-03-02" } });                                                                       // a reinstatement with no hold owes no history
  assert.equal(openExemptHold(events, "L-1"), null); assert.equal(events.ofType("escrow.statement.exemption_ended").length, 0);
  assert.throws(() => endExemption(events, { loan_id: "L-1", ended_by: "loan.reinstated", ended_on: D("2027-09-10"), actor: SYSTEM }), /no open \(i\)\(2\) exemption/);
  const hold = recordExemptHold(events, { loan_id: "L-1", reason: "delinquent_30", shortage_cents: 0n, as_of: D("2027-05-16"), actor: SYSTEM }); assert.equal(hold.status, "exempt_hold");
  assert.equal(timer("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90").length, 0);                                                                                                                  // the hold arms no history clock
  // A bankruptcy case closing does not make a delinquent loan current: the cause is refused on the log and the hold stays open.
  events.append({ type: "bankruptcy.case.closed", loanId: "L-1", actor: SYSTEM, payload: { closed_on: "2027-08-01" } });
  assert.match(String(events.ofType("escrow.statement.exemption_end.refused")[0]!.payload.reason), /does not end a delinquent_30 exemption/); assert.ok(openExemptHold(events, "L-1")); assert.equal(timer("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90").length, 0);
  assert.throws(() => endExemption(events, { loan_id: "L-1", ended_by: "loan.reinstated", ended_on: D("2027-05-01"), actor: SYSTEM }), /before the exemption was applied/);
  // Exemption ended 2027-09-10 by reinstatement (§13's event, ingested): `escrow.statement.exemption_ended{exemption_ended_on=2027-09-10}` arms the 90-day row on that date, not on the day it was recorded.
  const cause = events.append({ type: "loan.reinstated", loanId: "L-1", actor: SYSTEM, payload: { reinstated_on: "2027-09-10", tendered_cents: "512345" } });
  const ended = events.ofType("escrow.statement.exemption_ended"); assert.equal(ended.length, 1); const r = ended[0]!; assert.equal(r.causationId, cause.id); assert.equal(r.actor.id, "escrow");
  assert.deepEqual([r.payload.status, r.payload.exemption_reason, r.payload.exemption_started_at, r.payload.ended_by, r.payload.exemption_ended_on, r.payload.history_due_on, r.payload.notice, r.payload.statement_type], ["history_due", "delinquent_30", "2027-05-16", "loan.reinstated", "2027-09-10", "2027-12-09", "NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY", "post_exemption_history"]);
  assert.deepEqual([r.payload.history_from, r.payload.history_to, r.payload.exceeds_12_months], ["2026-07-01", "2027-09-10", true]);                                                      // from the day after the last statement's period end — longer than 1 year
  const t = timer("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90")[0]!; assert.equal(t.status, "armed"); assert.equal(t.anchorDate, "2027-09-10"); assert.equal(t.dueDate, "2027-12-09");
  assert.equal(openExemptHold(events, "L-1"), null); assert.throws(() => endExemption(events, { loan_id: "L-1", ended_by: "loan.reinstated", ended_on: D("2027-09-11"), actor: SYSTEM }), /no open \(i\)\(2\) exemption/);   // ended once
  // The history statement's send satisfies the row; an annual statement does not.
  recordStatementSent(events, { loan_id: "L-1", template: "NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT", statement_type: "annual", sent_on: D("2027-10-01"), due_on: D("2027-12-09"), actor: SYSTEM }); assert.equal(t.status, "armed");
  // NTC_REGX_1024_17I_POST_EXEMPTION_HISTORY rendered for real (history since the last statement, to the exemption end) and sent through the bus: sendNotice's recordStatementSent appends `escrow.statement.sent{statement_type=post_exemption_history, history_to=period_end}` — the row's satisfier.
  clock.set("2027-10-25T15:00:00.000Z"); const v = noticeReg.activeVersion(POST_EXEMPTION_NOTICE, D("2027-10-25"))!;
  const n = notices.render({ templateCode: POST_EXEMPTION_NOTICE, loanId: "L-1", recipients: [BORROWER], payload: { ...v.samplePayload, year_start: r.payload.history_from, period_end: r.payload.history_to, days_after_exemption_ended: 45 }, asOf: D("2027-10-25") });
  assert.equal(n.status, "rendered", n.heldReason); assert.match(n.rendered.text, /since your last statement/);
  const sent = (await run("sendNotice", { notice_id: n.id, due_on: t.dueDate })).output as Notice; assert.equal(sent.status, "sent");
  const se = lastOf(events, "escrow.statement.sent"); assert.deepEqual([se.payload.template, se.payload.statement_type, se.payload.history_to, se.payload.sent_on, se.payload.due_on, se.actor.id], [POST_EXEMPTION_NOTICE, "post_exemption_history", "2027-09-10", "2027-10-25", "2027-12-09", "escrow"]);
  assert.equal(t.status, "satisfied"); assert.equal(engine.byCode("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90").length, 1);
  // A foreclosure-action hold ends by dismissal of the action (or reinstatement); the next history continues from the history statement's period end.
  const fc = recordExemptHold(events, { loan_id: "L-1", reason: "foreclosure_action", shortage_cents: 0n, as_of: D("2028-05-16"), actor: SYSTEM }); assert.equal(fc.reason, "foreclosure_action");
  assert.throws(() => endExemptionFromEvent(events, events.append({ type: "payment.posted", loanId: "L-1", actor: SYSTEM, payload: {} }), SYSTEM), /not an exemption-ending event/);
  off();                                                                                                                                                                                     // lazy ingestion below, without the reactor
  const dismissal = events.append({ type: "foreclosure.case.cancelled", loanId: "L-1", actor: SYSTEM, payload: { cancelled_on: "2028-09-10" } });
  const r3 = settleExemption(events, "L-1", SYSTEM).ended!; assert.deepEqual([r3.ended_by, r3.exemption_ended_on, r3.history_from, r3.due_on, r3.event.causationId], ["foreclosure.case.cancelled", "2028-09-10", "2027-09-11", "2028-12-09", dismissal.id]);
  assert.equal(timer("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90")[1]!.dueDate, "2028-12-09");
  assert.equal(endExemptionFromEvent(events, events.append({ type: "loan.reinstated", loanId: "L-1", actor: SYSTEM, payload: { reinstated_on: "2028-09-12" } }), SYSTEM), null);
  assert.deepEqual(settleExemption(events, "L-1", SYSTEM), { ended: null, refused: [] });                                                                                                   // nothing open: a later cause owes nothing
  // §13.3's own spelling: reinstatementTendered appends `loan.reinstated{reinstated_on}` and `foreclosure.case.closed{reason, closed_on}` together; the first ends the hold on its date, the second finds nothing open (no refusal). The 3.3 renderStatement tool ingests them lazily before deciding.
  const refusedBefore = events.ofType("escrow.statement.exemption_end.refused").length; const fc2 = recordExemptHold(events, { loan_id: "L-1", reason: "foreclosure_action", shortage_cents: 0n, as_of: D("2029-05-16"), actor: SYSTEM }); assert.equal(fc2.status, "exempt_hold");
  events.append({ type: "loan.reinstated", loanId: "L-1", actor: SYSTEM, payload: { reinstated_on: "2029-09-10", tendered_cents: "512345" } }); events.append({ type: "foreclosure.case.closed", loanId: "L-1", actor: SYSTEM, payload: { reason: "closed_reinstated", closed_on: "2029-09-10" } });
  const viaTool = (await run("renderStatement", RENDER_INPUT)).output as { settled: string | null; status: string };
  const r4 = lastOf(events, "escrow.statement.exemption_ended"); assert.deepEqual([viaTool.settled, viaTool.status, r4.payload.ended_by, r4.payload.exemption_ended_on, r4.payload.history_from, r4.payload.history_due_on, r4.actor.id], ["history_due", "rendered", "loan.reinstated", "2029-09-10", "2027-09-11", "2029-12-09", "escrow"]);   // rule 6: from the day after the last statement actually sent (the 2027 history), not the unsent 2028 one — "may be longer than 1 year"
  assert.equal(events.ofType("escrow.statement.exemption_end.refused").length, refusedBefore); assert.equal(timer("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90")[2]!.dueDate, "2029-12-09");
  // A dismissal closes the case the same way (§13.3 `foreclosure.case.closed`): it ends a foreclosure-action hold on `closed_on`.
  recordExemptHold(events, { loan_id: "L-1", reason: "foreclosure_action", shortage_cents: 0n, as_of: D("2030-05-16"), actor: SYSTEM }); events.append({ type: "foreclosure.case.closed", loanId: "L-1", actor: SYSTEM, payload: { reason: "dismissed", closed_on: "2030-09-10" } });
  assert.deepEqual([settleExemption(events, "L-1").ended!.ended_by, settleExemption(events, "L-1").ended, timer("REGX_1024_17I2_POST_EXEMPTION_HISTORY_90")[3]!.dueDate], ["foreclosure.case.closed", null, "2030-12-09"]);
  // With no prior statement on the log, the history runs from the start of the computation year the held statement was for (the previous year end + 1).
  const fresh = approvedLoan("2027-05-18T15:00:00.000Z", {}); recordExemptHold(fresh.events, { loan_id: "L-1", reason: "delinquent_30", shortage_cents: 0n, as_of: D("2027-05-16"), actor: SYSTEM });
  assert.equal(endExemption(fresh.events, { loan_id: "L-1", ended_by: "loan.reinstated", ended_on: D("2027-09-10"), actor: SYSTEM }).history_from, "2026-07-01");
  // The history itself (rule 6): month by month from the last statement, may exceed 12 months; a gap is detected.
  const s = assembleAnnualStatement({ ...BASE, year_end: D("2027-09-10"), approved_on: D("2027-09-12"), history: buildHistory(104_000n, Array.from({ length: 15 }, (_, i) => ({ month: addMonths(D("2026-07-01"), i), deposits_cents: 13_000n, disbursements: [] }))) });
  assert.equal(s.history_from, "2026-07-01"); assert.equal(s.history_to, "2027-09-01"); assert.equal(s.continuous, true);   // covers from the last statement, month by month (may exceed 12 months)
  const gap = assembleAnnualStatement({ ...BASE, year_end: D("2027-09-10"), approved_on: D("2027-09-12"), history: HISTORY.filter((r) => r.month !== "2026-10-01") });
  assert.equal(gap.continuous, false);                                                                                        // a missing month is detected
});
test("3.3-T5: Given shortage ≥ one month, then the statement body contains no lump-sum wording; the insert (if enabled) is a separate document flagged optional.", () => {
  assert.equal(lumpSumWordingAllowed(40_668n, 13_833n), false);
  assert.doesNotMatch(planText(PLAN, 13_833n), /lump|30 days/i);                                                                // ≥ one month: allow / spread only
  assert.match(planText(buildPlan("shortage", 10_000n, D("2027-07-01"), {}) as Plan, 13_833n), /within 30 days/);             // < one month: the 30-day option may be stated
  const reg = buildRegistry(); const insert = reg.template("NTC_SM_ESCROW_VOLUNTARY_LUMPSUM_INSERT");
  assert.equal(insert.separateDocument, true); assert.ok(insert.mayCombineWith.includes("NTC_REGX_1024_17I_ANNUAL_ESCROW_STMT"));
});
test("3.3-T6: Given transfer-out effective 2027-03-01, then the annual timer is cancelled and `REGX_1024_17I4_SHORT_YEAR_TRANSFER_60` is due 2027-04-30.", () => {
  // The annual analysis for the year ending 2027-06-30 was approved early; its statement timer is armed when the loan transfers out on 2027-03-01.
  const { events, engine, timer } = approvedLoan("2027-02-20T15:00:00.000Z", {});
  const annual = timer("REGX_1024_17I_ANNUAL_STMT_30")[0]!; assert.equal(annual.status, "armed");
  const r = transferOutStatements(D("2027-03-01"), { engine, loan_id: "L-1" });
  assert.deepEqual([r.annual_timer, r.cancel_reason, r.cancelled_timer_ids, r.short_year.code, r.short_year.due_on, r.short_year.notice], ["cancelled", "transfer_out", [annual.id], "REGX_1024_17I4_SHORT_YEAR_TRANSFER_60", "2027-04-30", "NTC_REGX_1024_17I4_SHORT_YEAR_TRANSFEROR"]);
  assert.equal(annual.status, "cancelled"); assert.equal(annual.cancelledReason, "transfer_out"); assert.equal(events.ofType("timer.cancelled").length, 1);                           // the cancellation is an event, not a constant
  // The §1/§17 cutover fact arms the transferor short-year deadline on the RESPA effective date; the transferor statement's send satisfies it.
  events.append({ type: "transfer.batch.cutover_completed", loanId: "L-1", actor: SYSTEM, payload: { batch_id: "B-1", transfer_date: "2027-03-01", respa_effective_date: "2027-03-01" } });
  const sy = timer("REGX_1024_17I4_SHORT_YEAR_TRANSFER_60")[0]!; assert.equal(sy.status, "armed"); assert.equal(sy.dueDate, "2027-04-30");
  recordStatementSent(events, { loan_id: "L-1", template: r.short_year.notice, statement_type: "short_year_transfer", sent_on: D("2027-04-15"), due_on: sy.dueDate!, actor: SYSTEM });
  assert.equal(sy.status, "satisfied");
  assert.equal(transferOutStatements(D("2027-03-01")).annual_timer, "cancelled");                                                                                                          // without an engine the answer is the rule, not a timer state
});
test("3.3-T7: Given payoff funds received 2027-02-10, then short-year payoff statement due 2027-04-11 and it shows the refund disposition.", () => {
  const p = payoffStatement(D("2027-02-10"), 61_240n, "refund");
  assert.equal(p.due_on, "2027-04-11"); assert.match(p.refund_disposition, /refund: 61240 cents/); assert.equal(p.projection, null);
  // The payoff short-year template (§1024.17(i)(4)(iii)): history to the payoff date, closing balance, disposition, no projection.
  const v: TemplateVersion = { ...SHORT_YEAR_PAYOFF_VERSION, sourceHash: sourceHash(SHORT_YEAR_PAYOFF_VERSION.source), plainLanguageStatus: "draft" };
  const payload = { ...v.samplePayload, period_end: "2027-02-10", ending_balance_cents: 61_240n, refund_disposition: "refund of $612.40 by check within 20 days (excluding Saturdays, Sundays and legal public holidays) of the payoff", days_after_event: 8 };
  const r = render(v.source, payload); const c = evaluateChecklist(v, payload, r);
  assert.equal(c.passed, true, c.blocking.map((b) => b.rule_id).join(","));
  assert.match(r.text, /Balance at February 10, 2027: \$612\.40\. Disposition of the closing balance: refund of \$612\.40/); assert.doesNotMatch(r.text, /Coming year projection/);
  assert.equal(evaluateChecklist(v, { ...payload, refund_disposition: "" }, render(v.source, { ...payload, refund_disposition: "" })).blocking.map((b) => b.rule_id).join(","), "refund-disposition");
});
test("3.3-T8: Given a due date 2027-07-30 (Friday) vs 2027-08-01 (Sunday) scenarios, then no business-day roll is applied; the send target is ≥ 5 BD earlier.", () => {
  assert.deepEqual(annualDeadline(D("2027-06-30")), { due_on: "2027-07-30", send_target_on: "2027-07-23" });   // Friday
  const sun = annualDeadline(D("2027-07-02")); assert.equal(sun.due_on, "2027-08-01");                          // Sunday, no roll
  assert.equal(sun.send_target_on, "2027-07-26"); assert.ok(String(sun.send_target_on) < String(sun.due_on));
});
test("3.3-T9: Given actual December tax $760 vs projected $700, then item (viii) lists the county-tax variance and the low-balance difference.", () => {
  const ex = lowPointExplanation([{ month: D("2026-12-01"), line_type: "County tax", projected_cents: 70_000n, actual_cents: 76_000n }], 18_000n, 26_000n);
  assert.deepEqual(ex, ["County tax paid 12/2026 was $760.00 vs $700.00 projected", "low balance $180.00 vs $260.00 projected"]);
});
test("3.3-T10: Given a Utah property, then the calendar-year supplemental statement is sent by March 1 unless the annual statement already covers Jan–Dec.", () => {
  assert.deepEqual(utahSupplement(D("2026-07-01"), 2026), { required: true, due_on: "2027-03-01" });          // Dec 31, 2026 + 60 calendar days (7-17-5)
  assert.deepEqual(utahSupplement(D("2026-01-01"), 2026), { required: false, due_on: null });
  // Spec discrepancy: the statute's "60 days of year-end" lands on Feb 29 when the following year is a leap year, not March 1.
  assert.equal(utahSupplement(D("2027-07-01"), 2027).due_on, "2028-02-29");
});
test("3.3-T11: Given an open Chapter 13 case and flag `bk_suppress=off`, then the statement is produced with the BK legend and a 3002.1 package is created when the payment changes.", () => {
  const r = bankruptcyStatement({ chapter: 13, bk_suppress: false, prior_payment_cents: 13_000n, new_payment_cents: 17_222n });
  assert.equal(r.produced, true); assert.match(r.legend!, /3002\.1/); assert.equal(r.payment_change_cents, 4_222n); assert.equal(r.package_3002_1, true);
  assert.equal(bankruptcyStatement({ chapter: 13, bk_suppress: false, prior_payment_cents: 13_000n, new_payment_cents: 13_000n }).package_3002_1, false);   // no payment change → no 3002.1 package
  assert.equal(bankruptcyStatement({ chapter: 13, bk_suppress: true, prior_payment_cents: 13_000n, new_payment_cents: 17_222n }).produced, false);
  const s = assembleAnnualStatement({ ...BASE, approved_on: D("2027-05-18"), bankruptcy: { chapter: 13 } }); assert.equal(s.legend, r.legend);
  const v = annualVersion(); const payload = { ...v.samplePayload, bankruptcy_open: true, legend: s.legend };
  const rendered = render(v.source, payload); assert.match(rendered.text, /Bankruptcy Rule 3002\.1/); assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  assert.equal(evaluateChecklist(v, { ...payload, legend: null }, render(v.source, { ...payload, legend: null })).blocking.map((b) => b.rule_id).join(","), "bk-legend");   // legend missing on a BK loan blocks
});
test("3.3-T12: Given the print vendor is down on the send date, then the in-house fallback mails and evidence is stored.", () => {
  const r = sendWithFallback(false, D("2027-07-23"), D("2027-07-30"));
  assert.deepEqual(r, { channel: "in_house_mail", evidence: { kind: "proof_of_mailing", mailed_on: "2027-07-23" }, on_time: true });
  assert.equal(sendWithFallback(true, D("2027-07-23"), D("2027-07-30")).channel, "vendor"); assert.equal(sendWithFallback(false, D("2027-07-31"), D("2027-07-30")).on_time, false);
});

// 3.3 worked example figures: deposits 12 × $130.00 = $1,560.00; disbursements $520.00 + $360.00 + $760.00 + $260.00 = $1,900.00; ending balance $700.00.
test("3.3 worked example: deposits $1,560.00, disbursements $1,900.00 (incl. school $360.00), ending balance $700.00", () => {
  const s = assembleAnnualStatement({ ...BASE, approved_on: D("2027-05-18") });
  assert.equal(s.deposits_cents, 156_000n); assert.equal(s.disbursements_cents, 190_000n); assert.equal(s.ending_balance_cents, 70_000n);   // from the ledger history, opening $1,040.00
  assert.equal(s.low_balance_cents, 18_000n); assert.equal(project(E, D("2026-07-01")).targets[5], 26_000n);                                // actual December low $180.00 vs the $260.00 projected low
  assert.ok((s.items.iv as { disbursements: { line: string; amount_cents: bigint }[] }).disbursements.some((d) => d.line === "School tax" && d.amount_cents === 36_000n));
  assert.deepEqual(disbursementsByLine(HISTORY), [{ line: "County tax", amount_cents: 128_000n }, { line: "School tax", amount_cents: 36_000n }, { line: "supplemental tax", amount_cents: 26_000n }]);   // (iv) "as separately identified"
  const v = annualVersion(); const payload = { ...v.samplePayload, disbursements_by_line: disbursementsByLine(HISTORY).map((d) => ({ line: d.line, amount_cents: d.amount_cents })), out_total_cents: s.disbursements_cents };
  const rendered = render(v.source, payload); assert.match(rendered.text, /\(iv\) Total paid out \$1,900\.00, separately identified: County tax \$1,280\.00; School tax \$360\.00; supplemental tax \$260\.00;/);
  assert.equal(evaluateChecklist(v, payload, rendered).passed, true);
  const lumped = { ...payload, disbursements_by_line: [{ line: "County tax", amount_cents: 154_000n }, { line: "other", amount_cents: 36_000n }] };
  assert.deepEqual(evaluateChecklist(v, lumped, render(v.source, lumped)).blocking.map((b) => b.rule_id), ["iv-separately-identified"]);                                                       // an "other" bucket is not separate identification
  const viii = lowPointExplanation(HISTORY.flatMap((r) => r.disbursements.map((d) => ({ month: r.month, line_type: d.line, projected_cents: d.projected_cents, actual_cents: d.amount_cents }))), s.low_balance_cents!, 26_000n);
  assert.deepEqual(viii, ["County tax paid 07/2026 was $520.00 vs $500.00 projected", "County tax paid 12/2026 was $760.00 vs $700.00 projected", "a supplemental tax bill of $260.00 was paid 03/2027 (not projected)", "low balance $180.00 vs $260.00 projected"]);
  assert.equal(decisionText(DECISION), "Your account has a shortage of $406.68."); assert.equal(newPayment(PROJ, DECISION).payment_cents, 17_222n);
});
