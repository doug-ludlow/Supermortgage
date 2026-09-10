// 5.2 Remittance of P&I
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-2-remittance-of-p-i.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine } from "../../kernel/timers/engine.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { loadAgentsFile } from "../../app/agents.ts";
import { TOOLS_5_2 } from "../../app/tools/section5-2.ts";
import { loadRegistry } from "../../kernel/timers/registry.ts";
import { applyInvestorTimerOverrides } from "./timers.ts";
import { applySatisfiedOverrides_5_2 } from "./timers-5-2.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { scheduleForward, saInterest, aaRemittance, payoffInterest, crsAaRequest, specialRemittanceDeadline, classifyVariance, compensatoryFee, fundingDecision } from "./remittance.ts";
import { calendarDraftDate, fundingGateMs, bd1CatchUpMs, surplusResolveDueOn, periodAnchors } from "./period.ts";
import { ET, advanceTransfer, saReinstatementInterest, aaPaymentSplit, perDiemInterest, aaSweepBatch, aaAutoDraftSchedule, ssPayoffShortfallEntries, reconcileDraftDebit, form472Schedule3, compensatoryFeeInstance } from "./ops.ts";
import { crsLineText, crsSettlementDate, draftDateFor, nextRemittanceDate, proceedsPlan, computeRemittanceCalculation, validateDraftNotification, cycleSubject } from "./ops-5-2.ts";

const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);
const iso = (d: string, hhmm: string) => toIso(at(d, hhmm));
/** The registry as src/domain/timer-overrides.ts composes it for 5.2: the §5 section overrides, then the process overrides (which win). */
const REG = (() => { const r = loadRegistry(); applyInvestorTimerOverrides(r); applySatisfiedOverrides_5_2(r); return r; })();
const ESCALATES_TO = loadAgentsFile().processes.find((p) => p.process === "5.2")!.escalates_to;
const AGENT: Actor = { kind: "agent", id: "custodial-recon" };
const OPERATOR: Actor = { kind: "human", id: "u-op", role: "fnma_portal_operator" };
const OFFICER: Actor = { kind: "human", id: "u-officer", role: "officer" };
const SERVICER = "123456789";
/** The 5.2 tools on the bus over a real timer engine (5.2 rows only), the entity store and the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["5.2"] });
  const decisions: DecisionInput[] = [];
  const ctx: UowContext = { loanId: "L-1", events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const store = new EntityStore(); const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store, ports: {}, escalations, services: {} };
  const agents = new AgentRegistry(); const cmds = new Map(TOOLS_5_2.map((d) => { const cmd = toolCommand(d, rt, ESCALATES_TO); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; })); const bus = new CommandBus(agents);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output as Record<string, unknown>;
  const timer = (code: string, subjectId?: string) => { const all = timers.byCode(code).filter((t) => subjectId === undefined || t.subject.id === subjectId); assert.ok(all.length, `${code} armed${subjectId ? ` for ${subjectId}` : ""}`); return all[all.length - 1]!; };
  const def = (code: string) => REG.get(code)!;
  const ofType = (type: string) => events.ofType(type);
  return { clock, events, ledger, timers, store, escalations, decisions, run, timer, def, ofType };
}
const SS_LOAN = { activity_period: "2026-10", remittance_type: "SS", basis: "none", prior_actual_upb_cents: 25_000_000n, prior_scheduled_upb_cents: 25_000_000n, note_rate: "6.500", ptr: "6.000", pi_cents: 158_017n, principal_collected_cents: 0n, accepted_at: iso("2026-11-02", "10:00"), fnma_loan_number: "1000000001", servicer_number: SERVICER };
const OPEN_SS = { op: "open_period", month_of: "2026-10-01", servicer_number: SERVICER, cycles: [{ remittance_type: "ss", cycle: "standard", custodial_account_id: "C-PI-SS" }] };
const FUND = { op: "fund_draft", period: "2026-10", remittance_type: "ss", cycle: "standard", draft_date: "2026-11-18", custodial_account_id: "C-PI-SS", facility_available_cents: 5_000_000n };

test("5.2-T1: Given the S/S loan example, when the October 2026 activity period closes, then the expected Nov 18, 2026 (Wed) draft for that loan is $1,476.00 and the funding gate fires Tue Nov 17 16:00 ET.", async () => {
  const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 1);
  assert.equal(s[0]!.fnma_interest_cents + s[0]!.fnma_principal_cents, 147600n);
  assert.equal(calendarDraftDate(D("2026-11-01"), 18), "2026-11-18"); assert.equal(toIso(fundingGateMs(D("2026-11-18"))), iso("2026-11-17", "16:00"));
  // the process: the accepted October activity creates the S/S calculation row, the period opens its 18th cycle and closes on BD2
  const h = harness(iso("2026-11-02", "10:00"));
  const calc = await h.run("buildCrsBatch", { op: "compute", loan_id: "L-1", ...SS_LOAN });
  assert.equal(calc.interest_due_cents, 125_000n); assert.equal(calc.principal_due_cents, 22_600n); assert.equal(calc.remittance_cents, 147_600n); assert.equal(calc.advance_cents, 147_600n); assert.equal(calc.draft_on, "2026-11-18");
  const opened = await h.run("buildCrsBatch", OPEN_SS);
  const sched = (opened.schedules as { remittance_type: string; cycle: string; draft_date: string; funding_gate_at: string; expected_cents: bigint }[])[0]!;
  assert.deepEqual([sched.remittance_type, sched.cycle, sched.draft_date, sched.funding_gate_at, sched.expected_cents], ["ss", "standard", "2026-11-18", iso("2026-11-17", "16:00"), 147_600n]);
  const closed = await h.run("buildCrsBatch", { op: "close_period", month_of: "2026-10-01", servicer_number: SERVICER });
  assert.equal(closed.draft_notice_due_at, iso("2026-11-04", "12:00"));
  // the clocks: period open (S/S standard) → CD18 draft with the T−1 16:00 ET funding check; the scheduled draft → the custodial funding gate; period close → BD3 12:00 ET
  const cd18 = h.timer("FNMA_F120_SS_DRAFT_CD18"), gate = h.timer("SM_CUSTODIAL_FUNDING_T1_1600"), bd3 = h.timer("FNMA_F120_DRAFT_NOTICE_BD3");
  assert.equal(cd18.anchorDate, "2026-11-18"); assert.equal(toIso(cd18.dueAt!), iso("2026-11-17", "16:00")); assert.equal(toIso(gate.dueAt!), iso("2026-11-17", "16:00")); assert.equal(toIso(bd3.dueAt!), iso("2026-11-04", "12:00"));
  assert.ok(h.timers.evaluate(iso("2026-11-17", "15:59")).every((b) => b.def.code !== "FNMA_F120_SS_DRAFT_CD18"));
  // T−1 16:00 ET: the custodial balance covers the draft → `remittances.funded{remittance_type=ss, cycle=standard}` from the funding check
  h.clock.set(iso("2026-11-17", "16:00"));
  const f = await h.run("postLedger", { ...FUND, custodial_available_cents: 200_000n });
  assert.equal(f.status, "funded"); assert.equal(f.amount_cents, 0n);
  const funded = h.ofType("remittances.funded")[0]!;
  assert.ok(eventMatches(h.def("FNMA_F120_SS_DRAFT_CD18").satisfiedPattern!, funded)); assert.equal(funded.payload.expected_cents, 147_600n); assert.deepEqual(funded.aggregate, cycleSubject("2026-10", "ss", "standard"));
  assert.equal(cd18.status, "satisfied"); assert.equal(gate.status, "satisfied"); assert.equal(h.store.get("remittances", "rem-2026-10:ss:standard")!.data.status, "funded");
});
test("5.2-T2: Given the S/A loan with LPI three months stale, when month 4 is reported, then the LAR interest is −$2,992.50 and the CD20 draft reflects the reduction (Dec 20, 2026 is Sunday → draft Fri Dec 18).", async () => {
  assert.equal(saInterest(19950000n, "6.000", 1), 99750n); assert.equal(saInterest(19950000n, "6.000", 3), 99750n); assert.equal(saInterest(19950000n, "6.000", 4), -299250n);
  assert.equal(calendarDraftDate(D("2026-12-01"), 20), "2026-12-18"); assert.equal(periodAnchors(D("2026-11-01")).sa_draft_on, "2026-12-18");
  // four current S/A loans advance $997.50 each; the stale loan's month-4 row reports −$2,992.50, so the CD20 draft for the code nets to $997.50 instead of $3,990.00
  const h = harness(iso("2026-12-01", "10:00"));
  const sa = { activity_period: "2026-11", remittance_type: "SA", basis: "contractual", prior_actual_upb_cents: 19_950_000n, note_rate: "6.500", ptr: "6.000", pi_cents: 126_093n, principal_collected_cents: 0n, accepted_at: iso("2026-12-01", "09:00"), servicer_number: SERVICER };
  for (const n of [2, 3, 4, 5]) { const c = await h.run("buildCrsBatch", { op: "compute", loan_id: `L-${n}`, ...sa, fnma_loan_number: `100000000${n}`, months_delinquent: 0 }); assert.equal(c.interest_due_cents, 99_750n); }
  const stale = await h.run("buildCrsBatch", { op: "compute", loan_id: "L-1", ...sa, fnma_loan_number: "1000000001", basis: "none", months_delinquent: 4 });
  assert.equal(stale.interest_due_cents, -299_250n); assert.equal(stale.remittance_cents, -299_250n); assert.equal(stale.advance_cents, 0n); assert.equal(stale.draft_on, "2026-12-18");
  const opened = await h.run("buildCrsBatch", { op: "open_period", month_of: "2026-11-01", servicer_number: SERVICER, cycles: [{ remittance_type: "sa", cycle: "standard" }] });
  const sched = (opened.schedules as { draft_date: string; expected_cents: bigint; funding_gate_at: string }[])[0]!;
  assert.equal(sched.draft_date, "2026-12-18"); assert.equal(sched.expected_cents, 4n * 99_750n - 299_250n); assert.equal(sched.expected_cents, 99_750n); assert.equal(sched.funding_gate_at, iso("2026-12-17", "16:00"));
  const cd20 = h.timer("FNMA_F120_SA_DRAFT_CD20");
  assert.equal(cd20.anchorDate, "2026-12-18"); assert.equal(toIso(cd20.dueAt!), iso("2026-12-17", "16:00"));
  h.clock.set(iso("2026-12-17", "16:00"));
  const f = await h.run("postLedger", { op: "fund_draft", period: "2026-11", remittance_type: "sa", draft_date: "2026-12-18", custodial_account_id: "C-PI-SA", custodial_available_cents: 50_000n, facility_available_cents: 5_000_000n });
  assert.equal(f.status, "funded"); assert.equal(f.amount_cents, 49_750n, "the reduced draft is what the funding check covers");
  assert.equal(cd20.status, "satisfied"); assert.equal(h.ofType("remittances.funded")[0]!.payload.expected_cents, 99_750n);
});
test("5.2-T3: Given A/A collections net of fees of $2,600.00 by 15:00 ET on Tue Nov 10, 2026, then a CRS code-001 batch for $2,600.00 is prepared by 15:10, the portal task is due 16:00 ET, and the settlement date defaults to Thu Nov 12, 2026 because Wed Nov 11 (Veterans Day) is not a Federal Reserve business day.", async () => {
  const b = aaSweepBatch({ sweep_at_ms: at("2026-11-10", "15:00"), net_collected_cents: 260000n, servicer_number: SERVICER, last_work_day_of_month: false });
  assert.equal(b.instruct, true); assert.equal(b.code, "001"); assert.equal(toIso(b.prepare_by_ms), iso("2026-11-10", "15:10")); assert.equal(toIso(b.portal_task_due_ms), iso("2026-11-10", "16:00"));
  assert.equal(b.settlement_date, "2026-11-12"); assert.deepEqual(b.line, { servicer_number: SERVICER, remittance_code: "001", amount_cents: 260000n, settlement_date: "2026-11-12" });
  assert.equal(crsAaRequest(90000n, D("2026-11-10"), false).instruct, false); assert.equal(crsSettlementDate(at("2026-11-10", "15:00")), "2026-11-12"); assert.equal(crsSettlementDate(at("2026-11-10", "16:01")), "2026-11-13");
  // the process: the November A/A period is open (monthly minimum clock), the 15:00 ET sweep prepares the batch and its 16:00 ET upload task
  const h = harness(iso("2026-11-02", "09:00"));
  await h.run("buildCrsBatch", { op: "open_period", month_of: "2026-11-01", servicer_number: SERVICER, cycles: [{ remittance_type: "aa", cycle: "standard", expected_cents: 0n }] });
  const monthly = h.timer("FNMA_F120_AA_MONTHLY_MIN"); assert.equal(toIso(monthly.dueAt!), iso("2026-11-30", "16:00"));
  h.clock.set(iso("2026-11-10", "15:00"));
  const r = await h.run("buildCrsBatch", { op: "sweep", today: "2026-11-10", net_collected_cents: 260_000n, servicer_number: SERVICER });
  assert.equal(r.instruct, true); assert.equal(r.settlement_date, "2026-11-12"); assert.equal(toIso(r.prepare_by_ms as number), iso("2026-11-10", "15:10")); assert.equal(r.portal_task_due_at, iso("2026-11-10", "16:00")); assert.equal(r.total_cents, 260_000n);
  assert.equal(r.text, `${SERVICER}001 ${"2600.00".padStart(15)}${" ".repeat(10)}11/12/2026\r\n`);
  assert.equal(crsLineText({ remittance_id: "x", servicer_number: SERVICER, remittance_code: "357", amount_cents: 2_050_000_000n, settlement_date: D("2026-10-13"), fnma_loan_number: "1000000001", kind: "short_sale" }).length, 48);
  assert.throws(() => crsLineText({ remittance_id: "x", servicer_number: SERVICER, remittance_code: "357", amount_cents: 100n, settlement_date: D("2026-10-13"), kind: "short_sale" }), /requires the Fannie Mae loan number/);
  const sameDay = h.timer("FNMA_F120_AA_REMIT_2500_SAMEDAY"), upload = h.timer("FNMA_CRS_REQUEST_1600");
  assert.ok(eventMatches(h.def("FNMA_F120_AA_REMIT_2500_SAMEDAY").triggerPattern!, h.ofType("custodial.aa_sweep")[0]!));
  assert.equal(toIso(sameDay.dueAt!), iso("2026-11-10", "16:00")); assert.equal(toIso(upload.dueAt!), iso("2026-11-10", "16:00"), "CRS processes requests at 16:00 ET one BD before settlement");
  assert.equal(h.escalations.opened[0]!.ownerRole, "fnma_portal_operator"); assert.equal(h.escalations.opened[0]!.payload.due_at, iso("2026-11-10", "16:00"));
  // a second $2,600 request for the same settlement date is blocked; a $900 sweep is carried to the next sweep
  await assert.rejects(h.run("buildCrsBatch", { op: "sweep", today: "2026-11-10", net_collected_cents: 260_000n, servicer_number: SERVICER }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_DUPLICATE_001");
  const small = await h.run("buildCrsBatch", { op: "sweep", sweep_at: iso("2026-11-13", "15:00"), net_collected_cents: 90_000n, servicer_number: SERVICER });
  assert.equal(small.instruct, false); assert.equal(small.batch_id, null); assert.equal(small.carried_to_next_sweep, true);
  // the operator uploads before 16:00 ET and attaches the CRS confirmation → upload confirmed, the line instructed: same-day, monthly-minimum and upload clocks satisfied
  h.clock.set(iso("2026-11-10", "15:30"));
  const done = await h.run("openPortalTask", { op: "complete", portal_task_id: r.portal_task_id, evidence_document_id: "doc-crs-1", all_accepted: true }, OPERATOR);
  assert.deepEqual(done.accepted, r.remittance_ids);
  const instructed = h.ofType("remittances.instructed")[0]!;
  assert.deepEqual([instructed.payload.crs_code, instructed.payload.remittance_type, instructed.payload.amount_cents, instructed.payload.settlement_date], ["001", "aa", 260_000n, "2026-11-12"]);
  assert.equal(sameDay.status, "satisfied"); assert.equal(upload.status, "satisfied"); assert.equal(monthly.status, "satisfied"); assert.equal(h.store.get("remittances", (r.remittance_ids as string[])[0]!)!.data.status, "instructed");
});
test("5.2-T4: Given A/A collections of $900 on the last work day of the month not yet remitted, then a code-001 request is created on BD1 by 16:00 ET.", async () => {
  const r = crsAaRequest(90000n, D("2026-11-30"), true);
  assert.equal(r.instruct, true); assert.equal(r.code, "001");
  assert.equal(toIso(bd1CatchUpMs(D("2026-11-30"))), iso("2026-12-01", "16:00"));
  // month end with $900 unremitted arms the BD1 clock; the BD1 09:00 ET catch-up prepares the 001 request for November's activity and the operator instructs it before 16:00 ET
  const h = harness(iso("2026-11-30", "23:59"));
  const me = await h.run("buildCrsBatch", { op: "month_end", period_end: "2026-11-30", servicer_number: SERVICER, unremitted_cents: 90_000n });
  assert.equal(me.aa_collections_unremitted, true); assert.equal(me.bd1_catch_up_at, iso("2026-12-01", "16:00"));
  const bd1 = h.timer("FNMA_F120_AA_BD1_PRIOR_MONTH");
  assert.equal(toIso(bd1.dueAt!), iso("2026-12-01", "16:00")); assert.ok(eventMatches(h.def("FNMA_F120_AA_BD1_PRIOR_MONTH").triggerPattern!, h.ofType("period.month_end")[0]!));
  h.clock.set(iso("2026-12-01", "09:00"));
  const c = await h.run("buildCrsBatch", { op: "catch_up", today: "2026-12-01", unremitted_cents: 90_000n, servicer_number: SERVICER });
  assert.equal(c.instruct, true); assert.equal(c.activity_period, "2026-11"); assert.equal(c.settlement_date, "2026-12-02"); assert.equal(c.total_cents, 90_000n);
  h.clock.set(iso("2026-12-01", "10:30"));
  await h.run("openPortalTask", { op: "complete", portal_task_id: c.portal_task_id, evidence_document_id: "doc-crs-2", crs_result: (c.remittance_ids as string[]).map((id) => ({ remittance_id: id, accepted: true })) }, OPERATOR);
  assert.equal(bd1.status, "satisfied"); assert.ok(Date.parse(bd1.satisfiedAt!) < bd1.dueAt!);
  assert.equal(h.ofType("remittances.instructed")[0]!.payload.activity_period, "2026-11");
});
test("5.2-T5: Given the A/A example payment processed Mon Nov 23, 2026 under the future auto-draft flag, then P&I remittance = $2,544.38, pre-draft notice expected Nov 24, draft Nov 25, funding gate Nov 24 16:00 ET.", async () => {
  const aa = aaPaymentSplit(40000000n, "6.875", "6.625", 262772n);
  assert.deepEqual([aa.note_interest_cents, aa.principal_cents, aa.fnma_interest_cents, aa.servicing_fee_cents, aa.remittance_cents], [229167n, 33605n, 220833n, 8334n, 254438n]);
  const s = aaAutoDraftSchedule(at("2026-11-23", "15:00"));
  assert.equal(toIso(s.event_by_ms), iso("2026-11-24", "03:00")); assert.equal(s.predraft_notice_on, "2026-11-24"); assert.equal(s.draft_on, "2026-11-25"); assert.equal(toIso(s.funding_gate_ms), iso("2026-11-24", "16:00"));
  // the process: the accepted payment event (auto-draft phase) → the calculation row schedules Fannie Mae's draft and the funding gate
  const h = harness(iso("2026-11-23", "15:00"));
  const c = await h.run("buildCrsBatch", { op: "compute", loan_id: "L-1", activity_period: "2026-11", remittance_type: "AA", basis: "contractual", prior_actual_upb_cents: 40_000_000n, note_rate: "6.875", ptr: "6.625", pi_cents: 262_772n, principal_collected_cents: 33_605n, phase: "autodraft", accepted_at: iso("2026-11-23", "15:00"), fnma_loan_number: "1000000001", servicer_number: SERVICER });
  assert.deepEqual([c.interest_due_cents, c.principal_due_cents, c.servicing_fee_cents, c.remittance_cents], [220_833n, 33_605n, 8_334n, 254_438n]);
  assert.equal(c.predraft_notice_on, "2026-11-24"); assert.equal(c.draft_on, "2026-11-25"); assert.equal(c.funding_gate_at, iso("2026-11-24", "16:00"));
  const auto = h.timer("FNMA_LL202605_AA_AUTODRAFT_2BD"), gate = h.timer("SM_CUSTODIAL_FUNDING_T1_1600");
  assert.equal(auto.loanId, "L-1"); assert.equal(toIso(auto.dueAt!), iso("2026-11-24", "16:00")); assert.equal(toIso(gate.dueAt!), iso("2026-11-24", "16:00"));
  // the pre-draft notification arrives Tue Nov 24 and is reviewed by 15:00 ET the same BD
  h.clock.set(iso("2026-11-24", "08:30"));
  const pulled = await h.run("pullDraftNotifications", { notifications: [{ notification_id: "dn-1", kind: "predraft", filing_date: "2026-11-24", servicer_number: SERVICER, remittance_code: "001", draft_date: "2026-11-25", amount_cents: 254_438n, period: "2026-11", loan_level: [{ fnma_loan_number: "1000000001", loan_id: "L-1", amount_cents: 254_438n }] }] });
  assert.equal((pulled as unknown as { review_by_at: string }[])[0]!.review_by_at, iso("2026-11-24", "15:00"));
  const review = h.timer("FNMA_LL202605_PREDRAFT_REVIEW_1BD"); assert.equal(toIso(review.dueAt!), iso("2026-11-24", "15:00"));
  const rec = await h.run("pullDraftNotifications", { op: "reconcile", notification_id: "dn-1" });
  assert.equal(rec.variance_cents, 0n); assert.deepEqual((rec.variances as { class: string }[]).map((v) => v.class), ["fnma_projection"]); assert.equal(rec.reviewed, true); assert.equal(review.status, "satisfied");
  // the funding gate Tue Nov 24 16:00 ET → `remittances.funded{remittance_type=aa}` on the loan
  h.clock.set(iso("2026-11-24", "16:00"));
  const f = await h.run("postLedger", { op: "fund_draft", loan_id: "L-1", remittance_id: "rem-L-1-2026-11-autodraft", period: "2026-11", remittance_type: "aa", draft_date: "2026-11-25", custodial_account_id: "C-PI-AA", custodial_available_cents: 300_000n, facility_available_cents: 1_000_000n });
  assert.equal(f.status, "funded"); assert.equal(auto.status, "satisfied"); assert.equal(gate.status, "satisfied");
  assert.equal(h.ofType("remittances.funded")[0]!.payload.expected_cents, 254_438n);
});
test("5.2-T6: Given payoff funds received Oct 16 on the $199,500 loan, then interest to Fannie Mae is $1,489.42 (A/A), $498.75 (S/A), $997.50 (S/S) and for S/S the servicer-funded shortfall is booked to `servicer_advance_receivable` with reason `ss_payoff_interest`.", () => {
  assert.equal(payoffInterest("AA", 19950000n, "6.000", D("2026-09-01"), D("2026-10-16")), 148942n);
  assert.equal(payoffInterest("SA", 19950000n, "6.000", D("2026-09-01"), D("2026-10-16")), 49875n);
  assert.equal(payoffInterest("SS", 19950000n, "6.000", D("2026-09-01"), D("2026-10-16")), 99750n);
  // the borrower paid interest through Oct 15 at the note rate; at PTR that is 15 days of the month — the servicer funds the rest of the full month
  const collectedPtr = perDiemInterest(19950000n, "6.000") * 15n;
  const e = ssPayoffShortfallEntries({ full_month_cents: 99750n, collected_ptr_interest_cents: collectedPtr, loan_id: "L-1", custodial_account_id: "C-PI-SS" });
  assert.equal(e.reason, "ss_payoff_interest"); assert.equal(e.shortfall_cents, 99750n - collectedPtr); assert.ok(e.shortfall_cents > 0n);
  assert.deepEqual(e.lines.map((l) => [l.account, l.amountCents]), [["servicer_advance_receivable", e.shortfall_cents], ["custodial_pi_cash", -e.shortfall_cents]]);
  assert.equal(e.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.ok(e.lines.every((l) => /ss_payoff_interest/.test(l.ruleRef)));
  assert.throws(() => computeRemittanceCalculation({ loan_id: "L-1", activity_period: "2026-10", remittance_type: "SS", basis: "payoff", prior_actual_upb_cents: 19950000n, prior_scheduled_upb_cents: 19950000n, note_rate: "6.500", ptr: "6.000", pi_cents: 126093n, principal_collected_cents: 19950000n, accepted_at: iso("2026-10-16", "12:00") }), /computed by 16.2/);
});
test("5.2-T7: Given a BD3 draft notification showing $1,476.39 expected and a −$1,476.39 Stop Advance credit, then the variance classifier labels `sda_credit`, the draft expectation for the loan is $0, and no advance transfer is made.", async () => {
  const v = classifyVariance(147639n, 0n, { sda_credit_cents: -147639n });
  assert.equal(v.class, "sda_credit"); assert.equal(v.draft_expectation_cents, 0n);
  const a = advanceTransfer({ expected_draft_cents: v.draft_expectation_cents, custodial_available_cents: 0n, facility_available_cents: 5000000n, at_ms: at("2026-04-15", "16:00"), draft_date: D("2026-04-16") });
  assert.equal(a.amount_cents, 0n); assert.deepEqual(a.ledger, []); assert.equal(a.status, "funded");
  // the process: the March-activity S/S draft expects $1,476.39; the BD3 notification nets it to $0 with the Stop Advance credit; the funding check then moves nothing
  const h = harness(iso("2026-04-01", "09:00"));
  const draftOn = draftDateFor(D("2026-03-01"), { remittance_type: "ss", cycle: "standard" })!;
  await h.run("buildCrsBatch", { op: "open_period", month_of: "2026-03-01", servicer_number: SERVICER, cycles: [{ remittance_type: "ss", cycle: "standard", expected_cents: 147_639n, custodial_account_id: "C-PI-SS" }] });
  await h.run("buildCrsBatch", { op: "close_period", month_of: "2026-03-01", servicer_number: SERVICER });
  const bd3 = h.timer("FNMA_F120_DRAFT_NOTICE_BD3"); assert.equal(toIso(bd3.dueAt!), iso("2026-04-03", "12:00"));
  h.clock.set(iso("2026-04-03", "09:00"));
  await h.run("pullDraftNotifications", { notifications: [{ notification_id: "dn-bd3", kind: "bd3", filing_date: "2026-04-03", servicer_number: SERVICER, remittance_code: "003", draft_date: draftOn, amount_cents: 0n, period: "2026-03", loan_level: [{ fnma_loan_number: "1000000001", loan_id: "L-1", amount_cents: 0n, sda_credit_cents: -147_639n }] }] });
  const rec = await h.run("pullDraftNotifications", { op: "reconcile", notification_id: "dn-bd3", expected: [{ fnma_loan_number: "1000000001", loan_id: "L-1", expected_cents: 147_639n }] });
  const lv = (rec.variances as { class: string; draft_expectation_cents: bigint; officer: boolean }[])[0]!;
  assert.equal(lv.class, "sda_credit"); assert.equal(lv.draft_expectation_cents, 0n); assert.equal(lv.officer, false); assert.equal(rec.draft_expectation_cents, 0n); assert.equal(rec.escalation_id, null);
  assert.equal(bd3.status, "satisfied"); assert.equal(h.store.get("remittances", "rem-2026-03:ss:standard")!.data.draft_expectation_cents, 0n);
  const x = await h.run("explainVariance", { expected_cents: 147_639n, notified_cents: 0n, sda_credit_cents: -147_639n });
  assert.equal(x.class, "sda_credit"); assert.equal(x.no_advance_transfer, true); assert.equal(x.escalation_id, null);
  h.clock.set(toIso(fundingGateMs(draftOn)));
  const f = await h.run("postLedger", { op: "fund_draft", period: "2026-03", remittance_type: "ss", draft_date: draftOn, custodial_account_id: "C-PI-SS", custodial_available_cents: 0n, facility_available_cents: 5_000_000n });
  assert.equal(f.amount_cents, 0n); assert.equal(f.entry_set_id, null); assert.equal(f.status, "funded"); assert.equal(h.ledger.sets().length, 0);
  assert.equal(h.ofType("custodial.funding.verified")[0]!.payload.expected_cents, 0n);
});
test("5.2-T8: Given the custodial balance is $3,000 short at T−1 16:00 ET, then an advance transfer command is issued, dual control is not required (< $250,000), and `funded` is reached before 17:00 ET; if the corporate facility is exhausted, `officer` escalation fires.", async () => {
  const t1 = at("2026-11-17", "16:00");                                                                  // T−1 16:00 ET for the Nov 18 draft
  const a = advanceTransfer({ expected_draft_cents: 1000000n, custodial_available_cents: 700000n, facility_available_cents: 5000000n, at_ms: t1, draft_date: D("2026-11-18") });
  assert.equal(a.command, "advance"); assert.equal(a.amount_cents, 300000n); assert.equal(a.dual_control, false); assert.equal(a.status, "funded");
  assert.ok(a.funded_at_ms! < at("2026-11-17", "17:00")); assert.deepEqual(a.ledger.map((l) => `${l.side} ${l.account}`), ["Dr servicer_advance_receivable", "Cr custodial_pi_cash"]);
  const x = advanceTransfer({ expected_draft_cents: 1000000n, custodial_available_cents: 700000n, facility_available_cents: 100000n, at_ms: t1, draft_date: D("2026-11-18") });
  assert.equal(x.status, "escalated"); assert.equal(x.escalation, "officer"); assert.equal(x.funded_at_ms, null);
  assert.equal(advanceTransfer({ expected_draft_cents: 30000000n, custodial_available_cents: 0n, facility_available_cents: 50000000n, at_ms: t1, draft_date: D("2026-11-18") }).dual_control, true);
  // the process: the funding check on the bus posts the advance set and reaches `funded`; an exhausted facility opens the officer escalation and leaves the clock open
  const h = harness(iso("2026-11-17", "16:00"));
  await h.run("buildCrsBatch", { ...OPEN_SS, cycles: [{ remittance_type: "ss", cycle: "standard", expected_cents: 1_000_000n, custodial_account_id: "C-PI-SS" }] });
  const cd18 = h.timer("FNMA_F120_SS_DRAFT_CD18");
  const f = await h.run("postLedger", { ...FUND, custodial_available_cents: 700_000n });
  assert.equal(f.command, "advance"); assert.equal(f.amount_cents, 300_000n); assert.equal(f.dual_control, false); assert.equal(f.status, "funded"); assert.ok(Date.parse(f.funded_at as string) < at("2026-11-17", "17:00"));
  const set = h.ledger.sets()[0]!;
  assert.equal(set.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.deepEqual(set.lines.map((l) => [l.account.scope, l.account.account, l.amountCents]), [["corporate", "advance_receivable", 300_000n], ["corporate", "corporate_cash", -300_000n], ["custodial", "custodial_pi_cash", 300_000n], ["custodial", "clearing_cash", -300_000n]]);
  assert.ok(set.lines.every((l) => l.ruleRef === "5.2 rule 7 advance")); assert.equal(cd18.status, "satisfied");
  const g = harness(iso("2026-11-17", "16:00"));
  await g.run("buildCrsBatch", { ...OPEN_SS, cycles: [{ remittance_type: "ss", cycle: "standard", expected_cents: 1_000_000n, custodial_account_id: "C-PI-SS" }] });
  const e = await g.run("postLedger", { ...FUND, custodial_available_cents: 700_000n, facility_available_cents: 100_000n });
  assert.equal(e.status, "escalated"); assert.equal(e.escalation, "officer"); assert.equal(g.escalations.opened.find((s) => s.kind === "officer")!.severity, "sev1"); assert.equal(g.ofType("remittances.funded").length, 0); assert.equal(g.ofType("custodial.funding.verified")[0]!.payload.covered, false);
  assert.equal(g.timer("FNMA_F120_SS_DRAFT_CD18").status, "armed"); assert.equal(g.ledger.sets().length, 0);
  await assert.rejects(g.run("postLedger", { ...FUND, expected_draft_cents: 30_000_000n, custodial_available_cents: 0n, facility_available_cents: 50_000_000n }), (err: unknown) => err instanceof CommandRefused && err.code === "DUAL_CONTROL_250K");
  assert.equal((await g.run("postLedger", { ...FUND, expected_draft_cents: 30_000_000n, custodial_available_cents: 0n, facility_available_cents: 50_000_000n }, OFFICER)).dual_control, true);
});
test("5.2-T9: Given a bank debit of $52,310.11 with Fannie Mae's originator ID on Nov 18 and expected $52,310.11, then the remittance is `matched` and ledger entries balance; a $0.01 difference yields `variance` with a decision record.", async () => {
  const base = { remittance_id: "R-1", expected_cents: 5231011n, draft_date: D("2026-11-18"), debit_date: D("2026-11-18"), originator: "FANNIE MAE 1234567890", custodial_account_id: "C-PI-SS" };
  const m = reconcileDraftDebit({ ...base, debit_cents: 5231011n });
  assert.equal(m.status, "matched"); assert.equal(m.variance_cents, 0n); assert.equal(m.decision, null);
  assert.equal(m.entry_set!.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.deepEqual(m.entry_set!.lines.map((l) => [l.account.account, l.amountCents]), [["fnma_remittance_payable", 5231011n], ["custodial_pi_cash", -5231011n]]);
  const v = reconcileDraftDebit({ ...base, debit_cents: 5231012n });
  assert.equal(v.status, "variance"); assert.equal(v.variance_cents, 1n); assert.equal(v.decision!.action, "remittance.variance"); assert.equal(v.decision!.variance, "1");
  assert.equal(reconcileDraftDebit({ ...base, debit_cents: 5231011n, originator: "ACME UTILITIES" }).status, "unmatched");
  // the process: the bank feed's debit is matched on the bus — the balanced set posts, `remittances.drafted`/`.matched`; the $0.01 debit leaves a decision record and `remittances.variance`
  const h = harness(iso("2026-11-19", "07:00"));
  const rem = [{ id: "R-1", expected_cents: 5_231_011n, draft_date: "2026-11-18", custodial_account_id: "C-PI-SS" }];
  const ok = await h.run("matchBankDebits", { debits: [{ id: "D-1", amount_cents: 5_231_011n, date: "2026-11-18", originator: "FANNIE MAE 1234567890" }], remittances: rem });
  assert.deepEqual(ok.matched, [{ debit_id: "D-1", remittance_id: "R-1", status: "matched", variance_cents: 0n, days_late: 0, compfee_instance_id: null }]); assert.equal(ok.alert, null);
  assert.equal(h.ledger.sets().length, 1); assert.equal(h.ledger.sets()[0]!.lines.reduce((s, l) => s + l.amountCents, 0n), 0n); assert.equal(h.decisions.filter((d) => d.action === "remittance.variance").length, 0, "a matched draft leaves no variance decision");
  assert.deepEqual(h.ofType("remittances.drafted").map((e) => e.payload.remittance_id), ["R-1"]); assert.equal(h.ofType("remittances.matched").length, 1);
  const g = harness(iso("2026-11-19", "07:00"));
  const bad = await g.run("matchBankDebits", { debits: [{ id: "D-2", amount_cents: 5_231_012n, date: "2026-11-18", originator: "FANNIE MAE 1234567890" }, { id: "D-3", amount_cents: 999n, date: "2026-11-18", originator: "ACME UTILITIES" }], remittances: rem });
  assert.deepEqual((bad.matched as { status: string; variance_cents: bigint }[]).map((x) => [x.status, x.variance_cents]), [["variance", 1n]]); assert.deepEqual(bad.unmatched_debits, ["D-3"]); assert.equal(bad.alert, "sev1");
  const vd = g.decisions.filter((d) => d.action === "remittance.variance"); assert.equal(vd.length, 1); assert.match(vd[0]!.rationale, /variance 1¢/); assert.deepEqual(vd[0]!.subject, { kind: "remittance", id: "R-1" }); assert.equal(g.ofType("remittances.variance").length, 1);
});
test("5.2-T10: Given an unreconciled surplus first seen Sept 3, 2026, then `FNMA_IRM_SURPLUS_RESOLVE_90` is due Dec 2, 2026 and the Form 472 artifact carries the explanation.", async () => {
  assert.equal(surplusResolveDueOn(D("2026-09-03")), "2026-12-02");
  const f = form472Schedule3({ period: "2026-09", opening_cents: 0n, remitted_cents: 1_050_000n, reported_pi_cents: 1_000_000n, explained_items: [], surplus_first_seen: D("2026-09-03") });
  assert.equal(f.kind, "surplus"); assert.equal(f.unexplained_cents, 50000n); assert.equal(f.surplus_resolve_due_on, "2026-12-02");
  assert.match(f.explanation, /surplus first seen 2026-09-03 — resolve by 2026-12-02 \(FNMA_IRM_SURPLUS_RESOLVE_90\)/); assert.equal(f.artifact.form, "472"); assert.equal(f.artifact.schedule, "3"); assert.equal(f.artifact.lines.at(-1)!.amount_cents, 50000n);
  // the process: Schedule 3 prepared Sept 3 identifies the surplus → the 90-day clock; the Form 472 resolution with its explanation satisfies it
  const h = harness(iso("2026-09-03", "14:00"));
  const s = await h.run("explainVariance", { op: "schedule3", servicer_number: SERVICER, period: "2026-08", opening_cents: 0n, remitted_cents: 1_050_000n, reported_pi_cents: 1_000_000n, explained_items: [] });
  assert.equal(s.kind, "surplus"); assert.equal(s.first_seen_on, "2026-09-03"); assert.equal(s.surplus_resolve_due_on, "2026-12-02"); assert.equal((s.artifact as { form: string }).form, "472");
  const inst = h.timer("FNMA_IRM_SURPLUS_RESOLVE_90");
  assert.equal(inst.dueDate, "2026-12-02"); assert.equal(h.ofType("fnma.shortage_surplus.surplus_identified")[0]!.payload.first_seen_on, "2026-09-03");
  assert.equal(h.store.get("shortage_surplus", `${SERVICER}:2026-08`)!.data.status, "open");
  h.clock.set(iso("2026-10-05", "11:00"));
  await h.run("explainVariance", { op: "resolve", servicer_number: SERVICER, kind: "surplus", period: "2026-08", form_472_document_id: "doc-472-2026-08", explanation: "BD1 catch-up remittance for August settled on Sept 1 (timing item)" });
  assert.equal(inst.status, "satisfied"); assert.equal(h.store.get("shortage_surplus", `${SERVICER}:2026-08`)!.data.form_472_document_id, "doc-472-2026-08");
  await assert.rejects(h.run("explainVariance", { op: "resolve", servicer_number: SERVICER, kind: "surplus", period: "2026-08", form_472_document_id: "", explanation: "x" }), /form_472_document_id is required/);
});
test("5.2-T11: Given short-sale proceeds received Thu Oct 8, 2026 (sale closed Wed Oct 7), then CRS code 357 (and 324 for any borrower contribution) is instructed no later than Tue Oct 13, 2026 — two `fannie_et` business days after receipt (Fri Oct 9, Tue Oct 13; Mon Oct 12 is Columbus Day) and also the third business day after the sale — and the timer breaches at 16:00 ET Oct 13 if not instructed.", async () => {
  assert.equal(specialRemittanceDeadline(D("2026-10-08")), "2026-10-13");
  const plan = proceedsPlan({ loan_id: "L-1", kind: "short_sale", amount_cents: 21_000_000n, received_on: D("2026-10-08"), sale_closed_on: D("2026-10-07"), contribution_cents: 500_000n, remittance_type: "ss", servicer_number: SERVICER, fnma_loan_number: "1000000001" });
  assert.equal(plan.instruct_by, "2026-10-13"); assert.equal(plan.instruct_by_at, iso("2026-10-13", "16:00")); assert.deepEqual(plan.lines.map((l) => [l.remittance_code, l.amount_cents]), [["357", 20_500_000n], ["324", 500_000n]]);
  // the process: the custodial credit is recorded as short-sale proceeds → the 2-BD clock; the 357/324 batch instructed after 16:00 ET Oct 13 is late
  const h = harness(iso("2026-10-08", "11:00"));
  const r = await h.run("matchBankDebits", { op: "receipt", loan_id: "L-1", kind: "short_sale", amount_cents: 21_000_000n, received_on: "2026-10-08", sale_closed_on: "2026-10-07", contribution_cents: 500_000n, remittance_type: "SS", servicer_number: SERVICER, fnma_loan_number: "1000000001" });
  assert.equal(r.instruct_by, "2026-10-13");
  const inst = h.timer("FNMA_F120_SHORTSALE_PROCEEDS_2BD");
  assert.equal(inst.loanId, "L-1"); assert.equal(inst.dueDate, "2026-10-13"); assert.equal(toIso(inst.dueAt!), iso("2026-10-13", "16:00"));
  assert.ok(h.timers.evaluate(iso("2026-10-13", "15:59")).every((b) => b.def.code !== "FNMA_F120_SHORTSALE_PROCEEDS_2BD"));
  assert.ok(h.timers.evaluate(iso("2026-10-13", "16:01")).some((b) => b.def.code === "FNMA_F120_SHORTSALE_PROCEEDS_2BD")); assert.equal(inst.status, "breached");
  h.clock.set(iso("2026-10-13", "16:30"));
  const b = await h.run("buildCrsBatch", { op: "special", remittance_id: r.remittance_id, kind: "short_sale", servicer_number: SERVICER });
  assert.deepEqual((b.manifest as { remittance_code: string; amount_cents: bigint; fnma_loan_number: string }[]).map((l) => [l.remittance_code, l.amount_cents, l.fnma_loan_number]), [["357", 20_500_000n, "1000000001"], ["324", 500_000n, "1000000001"]]);
  assert.equal(b.settlement_date, "2026-10-15", "a request after 16:00 ET settles in two Federal Reserve business days");
  await h.run("openPortalTask", { op: "complete", portal_task_id: b.portal_task_id, evidence_document_id: "doc-crs-357", all_accepted: true }, OPERATOR);
  const ev = h.ofType("remittances.instructed"); assert.deepEqual(ev.map((e) => [e.loanId, e.payload.crs_code]), [["L-1", "357"], ["L-1", "324"]]);
  assert.ok(eventMatches(h.def("FNMA_F120_SHORTSALE_PROCEEDS_2BD").satisfiedPattern!, ev[0]!)); assert.equal(inst.status, "satisfied_late");
});
test("5.2-T12: Given a late S/S draft of $50,000 that settles 3 days late with prime 7.50%, then the estimated compensatory fee is max($250, 50,000 × 3 × 0.105 ÷ 365 = $43.15) = $250 and an instance is recorded.", async () => {
  assert.equal(compensatoryFee(5000000n, 3, "7.50"), 25000n);
  const i = compensatoryFeeInstance({ amount_cents: 5000000n, days_late: 3, prime_pct: "7.50", prior_instances_within_year: 0 });
  assert.equal(i.formula_cents, 4315n); assert.equal(i.minimum_cents, 25000n); assert.equal(i.fee_cents, 25000n); assert.equal(i.instance_number, 1);
  assert.deepEqual(i.instance, { kind: "late_remittance", amount_cents: 5000000n, days_late: 3, fee_cents: 25000n });
  assert.equal(compensatoryFeeInstance({ amount_cents: 5000000n, days_late: 3, prime_pct: "7.50", prior_instances_within_year: 1 }).fee_cents, 50000n);
  assert.equal(compensatoryFeeInstance({ amount_cents: 5000000n, days_late: 3, prime_pct: "7.50", prior_instances_within_year: 2 }).fee_cents, 100000n);
  assert.deepEqual(fundingDecision(1000000n, 700000n), { shortfall_cents: 300000n, advance: true, dual_control: false });
  // the process: the Nov 18 draft's debit posts Nov 21 → the bank match records the instance in `compfee_instances` and escalates to the officer (rule 11 / Escalations)
  const h = harness(iso("2026-11-22", "07:00"));
  const m = await h.run("matchBankDebits", { debits: [{ id: "D-9", amount_cents: 5_000_000n, date: "2026-11-21", originator: "FANNIE MAE 1234567890" }], remittances: [{ id: "R-9", expected_cents: 5_000_000n, draft_date: "2026-11-18", custodial_account_id: "C-PI-SS" }], prime_pct: "7.50" });
  const hit = (m.matched as { status: string; days_late: number; compfee_instance_id: string }[])[0]!;
  assert.equal(hit.status, "matched"); assert.equal(hit.days_late, 3);
  const row = h.store.get("compfee_instances", hit.compfee_instance_id)!.data;
  assert.deepEqual([row.kind, row.days_late, row.fee_cents, row.minimum_cents, row.instance_number], ["late_remittance", 3, 25_000n, 25_000n, 1]);
  assert.equal(h.escalations.opened.find((e) => e.kind === "officer")!.payload.fee_cents, 25_000n); assert.equal(h.ofType("remittances.drafted")[0]!.payload.late, true);
});

// ---- the remaining 5.2 timer rows: every trigger and satisfier is an event the process emits ------------------------------------
test("5.2 emitters: RPM designated-date and 6th-day pool drafts arm on the period open for their cycle and are satisfied by that cycle's funding check", async () => {
  const h = harness(iso("2026-11-02", "10:00"));
  const o = await h.run("buildCrsBatch", { op: "open_period", month_of: "2026-10-01", servicer_number: SERVICER, cycles: [{ remittance_type: "ss", cycle: "rpm", rpm_day: 10, expected_cents: 800_000n, custodial_account_id: "C-PI-RPM" }, { remittance_type: "ss", cycle: "sixth_day", expected_cents: 300_000n, custodial_account_id: "C-PI-6" }] });
  const [rpm, sixth] = o.schedules as { draft_date: string; funding_gate_at: string }[];
  assert.equal(rpm!.draft_date, "2026-11-10"); assert.equal(sixth!.draft_date, "2026-11-06"); assert.equal(periodAnchors(D("2026-10-01")).pool_draft_on, "2026-11-06");
  const tRpm = h.timer("FNMA_F120_RPM_DRAFT_DESIGNATED"), t6 = h.timer("FNMA_F120_SS_6TH_POOL_CD5");
  assert.equal(tRpm.anchorDate, "2026-11-10"); assert.equal(toIso(tRpm.dueAt!), iso("2026-11-09", "16:00")); assert.equal(t6.anchorDate, "2026-11-06"); assert.equal(toIso(t6.dueAt!), iso("2026-11-05", "16:00"), "CD5 = the BD before the CD6 draft, 16:00 ET");
  assert.equal(h.timers.byCode("FNMA_F120_SS_DRAFT_CD18").length, 0, "no standard cycle opened → no CD18 clock");
  h.clock.set(iso("2026-11-05", "16:00"));
  await h.run("postLedger", { op: "fund_draft", period: "2026-10", remittance_type: "ss", cycle: "sixth_day", draft_date: "2026-11-06", custodial_account_id: "C-PI-6", custodial_available_cents: 300_000n, facility_available_cents: 0n });
  assert.equal(t6.status, "satisfied"); assert.equal(tRpm.status, "armed", "the 6th-day funding does not satisfy the RPM cycle");
  h.clock.set(iso("2026-11-09", "16:00"));
  const f = await h.run("postLedger", { op: "fund_draft", period: "2026-10", remittance_type: "ss", cycle: "rpm", draft_date: "2026-11-10", custodial_account_id: "C-PI-RPM", custodial_available_cents: 500_000n, facility_available_cents: 1_000_000n });
  assert.equal(f.amount_cents, 300_000n); assert.equal(tRpm.status, "satisfied");
});
test("5.2 emitters: MBS Express unscheduled principal → funded by BD4 of the following month (the curtailment calculation arms the clock on the loan)", async () => {
  const h = harness(iso("2026-11-16", "12:00"));
  const c = await h.run("buildCrsBatch", { op: "compute", loan_id: "L-2", ...SS_LOAN, activity_period: "2026-11", basis: "curtailment", cycle: "mbs_express", principal_collected_cents: 1_000_000n, accepted_at: iso("2026-11-16", "12:00") });
  assert.equal(c.principal_due_cents, 22_600n + 1_000_000n); assert.equal(c.mbsx_bd4_on, "2026-12-04"); assert.equal(c.draft_on, "2026-12-04");
  assert.ok(eventMatches(h.def("FNMA_F120_MBSX_UNSCHED_BD4").triggerPattern!, h.ofType("remittance_calculations.computed")[0]!));
  const t = h.timer("FNMA_F120_MBSX_UNSCHED_BD4");
  assert.equal(t.loanId, "L-2"); assert.equal(t.anchorDate, "2026-12-04"); assert.equal(toIso(t.dueAt!), iso("2026-12-03", "16:00"), "BD4 of December 2026 is Fri Dec 4; the funding check is T−1 16:00 ET");
  h.clock.set(iso("2026-12-03", "16:00"));
  await h.run("postLedger", { op: "fund_draft", loan_id: "L-2", period: "2026-11", remittance_type: "ss", cycle: "mbs_express", draft_date: "2026-12-04", expected_draft_cents: c.remittance_cents as bigint, custodial_account_id: "C-PI-MBSX", custodial_available_cents: 2_000_000n, facility_available_cents: 0n });
  assert.equal(t.status, "satisfied");
});
test("5.2 emitters: detailed-reporting A/A → the draft is observed within 48 hours of acceptance (remittances.drafted{reporting=detailed})", async () => {
  const h = harness(iso("2026-11-10", "10:00"));
  await h.run("buildCrsBatch", { op: "compute", loan_id: "L-1", activity_period: "2026-11", remittance_type: "AA", basis: "contractual", prior_actual_upb_cents: 40_000_000n, note_rate: "6.875", ptr: "6.625", pi_cents: 262_772n, principal_collected_cents: 33_605n, reporting: "detailed", accepted_at: iso("2026-11-10", "10:00"), servicer_number: SERVICER });
  const t = h.timer("FNMA_F120_AA_DETAILED_48H");
  assert.equal(t.loanId, "L-1"); assert.equal(toIso(t.dueAt!), iso("2026-11-12", "10:00"));
  h.clock.set(iso("2026-11-12", "07:00"));
  await h.run("matchBankDebits", { debits: [{ id: "D-5", amount_cents: 254_438n, date: "2026-11-11", originator: "FANNIE MAE 1234567890" }], remittances: [{ id: "R-5", expected_cents: 254_438n, draft_date: "2026-11-11", reporting: "detailed", loan_id: "L-1" }] });
  const drafted = h.ofType("remittances.drafted")[0]!;
  assert.equal(drafted.payload.reporting, "detailed"); assert.ok(eventMatches(h.def("FNMA_F120_AA_DETAILED_48H").satisfiedPattern!, drafted)); assert.equal(t.status, "satisfied");
});
test("5.2 emitters: settlement proceeds → instructed by next month's remittance date (CRS 309, remittances.instructed{kind=settlement})", async () => {
  assert.equal(nextRemittanceDate(D("2026-10-08"), { remittance_type: "ss" }), "2026-11-18"); assert.equal(nextRemittanceDate(D("2026-10-08"), { remittance_type: "sa" }), "2026-11-20"); assert.equal(nextRemittanceDate(D("2026-10-08"), { remittance_type: "aa" }), "2026-11-02");
  const h = harness(iso("2026-10-08", "11:00"));
  const r = await h.run("matchBankDebits", { op: "receipt", loan_id: "L-1", kind: "settlement", amount_cents: 1_250_000n, received_on: "2026-10-08", remittance_type: "SS", servicer_number: SERVICER, fnma_loan_number: "1000000001" });
  assert.equal(r.instruct_by, "2026-11-18"); assert.equal(h.ofType("settlement.received")[0]!.payload.next_remittance_date, "2026-11-18");
  const t = h.timer("FNMA_F120_SETTLEMENT_NEXT_REMIT_DATE"); assert.equal(t.dueDate, "2026-11-18");
  h.clock.set(iso("2026-11-16", "10:00"));
  const b = await h.run("buildCrsBatch", { op: "special", remittance_id: r.remittance_id, kind: "settlement", servicer_number: SERVICER });
  assert.deepEqual((b.manifest as { remittance_code: string; amount_cents: bigint }[]).map((l) => [l.remittance_code, l.amount_cents]), [["309", 1_250_000n]]); assert.equal(b.settlement_date, "2026-11-17");
  await h.run("openPortalTask", { op: "complete", portal_task_id: b.portal_task_id, evidence_document_id: "doc-crs-309", all_accepted: true }, OPERATOR);
  const ev = h.ofType("remittances.instructed")[0]!; assert.equal(ev.payload.kind, "settlement"); assert.equal(ev.payload.crs_code, "309"); assert.equal(t.status, "satisfied");
});
test("5.2 emitters: an unreconciled shortage is remitted immediately (CRS 001 with reason shortage within 1 BD)", async () => {
  const h = harness(iso("2026-09-03", "14:00"));
  const s = await h.run("explainVariance", { op: "schedule3", servicer_number: SERVICER, period: "2026-08", opening_cents: 0n, remitted_cents: 900_000n, reported_pi_cents: 1_000_000n, explained_items: [{ kind: "payoff_in_transit", amount_cents: -20_000n, note: "L-7 payoff wired Sept 1" }] });
  assert.equal(s.kind, "shortage"); assert.equal(s.unexplained_cents, -80_000n); assert.equal(s.shortage_instruct_by_at, iso("2026-09-04", "16:00"));
  const ev = h.ofType("fnma.shortage_surplus.shortage_confirmed")[0]!; assert.equal(ev.payload.reconciled, false); assert.equal(ev.payload.amount_cents, 80_000n);
  const t = h.timer("FNMA_IRM_SHORTAGE_IMMEDIATE"); assert.equal(t.dueDate, "2026-09-04");
  const b = await h.run("buildCrsBatch", { op: "special", kind: "pi_actual", reason: "shortage", period: "2026-08", amount_cents: 80_000n, servicer_number: SERVICER });
  assert.equal((b.manifest as { remittance_code: string }[])[0]!.remittance_code, "001"); assert.equal(b.settlement_date, "2026-09-04");
  await h.run("openPortalTask", { op: "complete", portal_task_id: b.portal_task_id, evidence_document_id: "doc-crs-short", all_accepted: true }, OPERATOR);
  const inst = h.ofType("remittances.instructed")[0]!; assert.equal(inst.payload.reason, "shortage"); assert.ok(eventMatches(h.def("FNMA_IRM_SHORTAGE_IMMEDIATE").satisfiedPattern!, inst)); assert.equal(t.status, "satisfied");
  // a balanced schedule the next month resolves the prior open item; a surplus needs its Form 472 artifact
  h.clock.set(iso("2026-10-05", "14:00"));
  const bal = await h.run("explainVariance", { op: "schedule3", servicer_number: SERVICER, period: "2026-09", opening_cents: -80_000n, remitted_cents: 1_080_000n, reported_pi_cents: 1_000_000n, explained_items: [] });
  assert.equal(bal.kind, "balanced"); assert.equal(bal.resolved_prior, "shortage"); assert.equal(h.ofType("fnma.shortage_surplus.resolved")[0]!.payload.kind, "shortage");
});
test("5.2 emitters: a new drafting instruction is entered in CRS by 20:00 ET the BD before its effective date and confirmed by the operator", async () => {
  const h = harness(iso("2026-11-09", "10:00"));
  const r = await h.run("buildCrsBatch", { op: "instruction", servicer_number: SERVICER, remittance_code: "001", bank_aba: "021000021", bank_account: "9876543210", effective_date: "2026-11-16" });
  assert.equal(r.enter_by_at, iso("2026-11-13", "20:00")); assert.equal(h.ofType("crs.instruction.needed")[0]!.payload.bank_account_last4, "3210");
  const t = h.timer("FNMA_CRS_INSTRUCTION_T1_2000"); assert.equal(t.anchorDate, "2026-11-16"); assert.equal(toIso(t.dueAt!), iso("2026-11-13", "20:00"));
  await assert.rejects(h.run("openPortalTask", { op: "complete", portal_task_id: r.portal_task_id, evidence_document_id: "doc-crs-instr" }, AGENT), /completed by role fnma_portal_operator/);
  h.clock.set(iso("2026-11-12", "15:00"));
  await h.run("openPortalTask", { op: "complete", portal_task_id: r.portal_task_id, evidence_document_id: "doc-crs-instr" }, OPERATOR);
  assert.equal(t.status, "satisfied"); assert.equal(h.store.get("crs_instructions", r.instruction_id as string)!.data.status, "confirmed");
  await assert.rejects(h.run("buildCrsBatch", { op: "instruction", servicer_number: SERVICER, remittance_code: "001", bank_aba: "12345", bank_account: "9876543210", effective_date: "2026-11-16" }), /bank_aba must be 9 digits/);
});
test("5.2 guardrails: custodial↔corporate money only through advance/fee_sweep, never T&I for P&I, unknown variances above the thresholds go to the officer, inbound notifications are validated", async () => {
  const h = harness(iso("2026-11-17", "16:00"));
  const pi = (id: string, account: string, amt: bigint) => ({ account: { scope: "custodial", custodialAccountId: id, account }, amountCents: amt, ruleRef: "5.2 test" });
  await assert.rejects(h.run("postLedger", { entry_set: { effectiveDate: "2026-11-17", description: "sweep", lines: [pi("C-PI", "custodial_pi_cash", -500n), { account: { scope: "corporate", account: "servicing_fee_income" }, amountCents: 500n, ruleRef: "5.2 test" }] } }), (e: unknown) => e instanceof CommandRefused && e.code === "ADVANCE_COMMANDS_ONLY");
  await assert.rejects(h.run("postLedger", { entry_set: { effectiveDate: "2026-11-17", description: "draft", lines: [pi("C-PI", "custodial_pi_cash", 500n), pi("C-TI", "custodial_ti_cash", -500n)] } }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_TI_FOR_PI");
  await assert.rejects(h.run("postLedger", { ...FUND, custodial_account_id: "C-TI-ESCROW", custodial_available_cents: 0n, expected_draft_cents: 1_000n }), (e: unknown) => e instanceof CommandRefused && e.code === "NO_TI_FOR_PI");
  const ok = await h.run("postLedger", { transfer_kind: "fee_sweep", entry_set: { effectiveDate: "2026-11-17", description: "sweep", lines: [pi("C-PI", "custodial_pi_cash", -500n), { account: { scope: "corporate", account: "servicing_fee_income" }, amountCents: 500n, ruleRef: "5.2 rule 10" }] } });
  assert.ok(ok.id);
  const v = await h.run("explainVariance", { expected_cents: 100_000n, notified_cents: 40_000n, loan_id: "L-1" });
  assert.equal(v.class, "unexplained"); assert.equal(v.escalate_officer, true); assert.ok(h.escalations.opened.some((e) => e.kind === "officer" && e.id === v.escalation_id));
  assert.throws(() => validateDraftNotification({ source: "api", kind: "bd3", filing_date: "2026-11-04", servicer_number: SERVICER, remittance_code: "003", draft_date: "2026-11-18", amount_cents: 100n, loan_level: [{ fnma_loan_number: "1000000001", amount_cents: 99n }] }), /do not sum/);
  await assert.rejects(h.run("pullDraftNotifications", { notifications: [{ source: "api", kind: "weekly", filing_date: "2026-11-04", servicer_number: SERVICER, remittance_code: "003", draft_date: "2026-11-18", amount_cents: 100n }] }), /kind must be predraft/);
  await assert.rejects(h.run("buildCrsBatch", { op: "sweep", servicer_number: SERVICER }), RangeError);
});

test("5.2 worked examples 3–6: the S/S advance schedule, S/A reinstatement, the A/A auto-draft split and the per-diem", () => {
  const s = scheduleForward(25000000n, "6.500", "6.000", 158017n, 4);
  assert.deepEqual(s.map((m) => [m.prior_scheduled_upb_cents, m.fnma_interest_cents, m.fnma_principal_cents, m.fnma_interest_cents + m.fnma_principal_cents]), [[25000000n, 125000n, 22600n, 147600n], [24977400n, 124887n, 22723n, 147610n], [24954677n, 124773n, 22846n, 147619n], [24931831n, 124659n, 22970n, 147629n]]);
  assert.equal(s.reduce((a, m) => a + m.fnma_interest_cents + m.fnma_principal_cents, 0n), 590458n);
  assert.equal(saReinstatementInterest(19950000n, "6.000", 6), 598500n);
  const aa = aaPaymentSplit(40000000n, "6.875", "6.625", 262772n);
  assert.deepEqual(aa, { note_interest_cents: 229167n, principal_cents: 33605n, fnma_interest_cents: 220833n, servicing_fee_cents: 8334n, remittance_cents: 254438n, crs_same_day: true });
  assert.equal(perDiemInterest(19950000n, "6.000"), 3279n);
  assert.equal(aaRemittance(40000000n, "6.875", "6.625", 33605n).remittance_cents, 254438n);
});
