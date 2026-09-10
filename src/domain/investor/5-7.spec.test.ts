// 5.7 Delinquent loan status reporting
// spec/sections/05-investor-reporting-remittance-fannie-mae/5-7-delinquent-loan-status-reporting.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, toIso } from "../../kernel/calendar/zoned.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { eventMatches } from "../../kernel/events/match.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, loadRegistry } from "../../kernel/timers/index.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry, loadAgentsFile } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime } from "../../app/tools.ts";
import { TOOLS_5_7 } from "../../app/tools/section5-7.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { statusLine, deriveStatusCode, consistencyErrors, trialCompletionDate, inPopulation, renderF121Record, parseF121Record, validateF121Layout, validateF121Record, reasonCode, F121_POSITIONS, type LoanStatusFacts } from "./delinquency-status.ts";
import { applyInvestorTimerOverrides } from "./timers.ts";
import { applySatisfiedOverrides_5_7 } from "./timers-5-7.ts";
import { ET, dqExceptionCycle, reconcileFinalReport, dqEventForAction, amnTransmission, consistencyBlock, lineReviewFlag } from "./ops.ts";
import { validateDelinquencyEvent, deriveEventStatusTypes, lineConsistencyErrors, correctionsDueMs, PERIODS_DELINQUENT, SERVICER_ACTION_TYPES } from "./ops-5-7.ts";

const at = (d: string, hhmm: string) => zonedEpochMs(D(d), hhmm, ET);
const iso = (d: string, hhmm: string) => toIso(at(d, hhmm));
const pos = (rec: string, [a, b]: readonly [number, number]) => rec.slice(a - 1, b);
/** The registry as src/domain/timer-overrides.ts composes it for 5.7: the §5 section overrides, then the process overrides (which win). */
const REG = (() => { const r = loadRegistry(); applyInvestorTimerOverrides(r); applySatisfiedOverrides_5_7(r); return r; })();
const ESCALATES_TO = loadAgentsFile().processes.find((p) => p.process === "5.7")!.escalates_to;
const AGENT: Actor = { kind: "agent", id: "investor-reporting" };
/** The 5.7 tools on the bus over a real timer engine (5.7 rows, plus the 5.4 reclass row the 5.7 table cross-references), the entity store and the escalation service. */
function harness(nowIso: string) {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const ledger = new MemoryLedger();
  const timers = new TimerEngine(REG, events, { processes: ["5.7", "5.4"] });
  const decisions: DecisionInput[] = [];
  const ctx: UowContext = { loanId: "L-1", events, ledger, timers, clock, decide: (d) => { decisions.push(d); } };
  const store = new EntityStore(); const escalations = new EscalationService(events, clock);
  const rt: ToolRuntime = { store, ports: {}, escalations, services: {} };
  const agents = new AgentRegistry(); const cmds = new Map(TOOLS_5_7.map((d) => { const cmd = toolCommand(d, rt, ESCALATES_TO); agents.registerTool(d.agent, cmd.name); return [d.name, cmd] as const; })); const bus = new CommandBus(agents);
  const run = async (name: string, input: Record<string, unknown>, actor: Actor = AGENT): Promise<Record<string, unknown>> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output as Record<string, unknown>;
  const timer = (code: string, subjectId?: string) => { const all = timers.byCode(code).filter((t) => subjectId === undefined || t.subject.id === subjectId); assert.ok(all.length, `${code} armed${subjectId ? ` for ${subjectId}` : ""}`); return all[all.length - 1]!; };
  /** The month-end event the period timers arm on (5.1/5.2 emit it with the period aggregate; the 5.7 report events carry the same subject). */
  const monthEnd = (period: string, periodEnd: string) => events.append({ type: "period.month_end", actor: SYSTEM, aggregate: { kind: "period", id: period }, occurredAt: iso(periodEnd, "23:59"), payload: { period, period_end: periodEnd } });
  return { clock, events, timers, escalations, decisions, run, timer, monthEnd, def: (code: string) => REG.get(code)! };
}
const WORKED: LoanStatusFacts = { fnma_delinquency_status: "60", lpi: D("2026-08-01"), actions: [{ kind: "qrpc_no_solution", at: "2026-10-20T15:00:00Z", evidence_event_id: "qrpc-1" }], hardship: "unemployment", contact_achieved: true };

test("5.7-T1: Given the worked example loan at Oct 31, 2026, then the November file line is `AW`/`016`/`20261020` and it is transmitted with B2B ack before Tue Nov 3, 2026 17:00 ET.", async () => {
  const line = statusLine(WORKED)!;
  assert.deepEqual(line, { status: "AW", reason: "016", effective: "20261020", completion: "        " });
  assert.deepEqual(validateF121Layout(line), []);
  const rec = renderF121Record("123456789", "4000000001", line);
  assert.equal(rec.length, 80); assert.equal(pos(rec, F121_POSITIONS.servicer_number), "123456789"); assert.equal(pos(rec, F121_POSITIONS.fnma_loan_number), "4000000001"); assert.equal(pos(rec, F121_POSITIONS.status), "AW"); assert.equal(pos(rec, F121_POSITIONS.reason), "016"); assert.equal(pos(rec, F121_POSITIONS.effective), "20261020"); assert.equal(pos(rec, F121_POSITIONS.completion), "        ");
  assert.deepEqual(validateF121Record(rec), []); assert.equal(parseF121Record(rec).status, "AW");
  const t = amnTransmission({ period_month: D("2026-10-01"), transmitted_at_ms: at("2026-11-03", "09:00"), record_count: 412 });
  assert.equal(toIso(t.due_ms), iso("2026-11-03", "17:00")); assert.equal(t.late, false); assert.equal(t.escalation, null);
  // the engine: month end arms the BD2 deadline (Tue Nov 3, 2026 17:00 ET); the snapshot satisfies the EOM row; the B2B-acknowledged transmission satisfies BD2
  const h = harness(iso("2026-10-31", "23:59")); h.monthEnd("2026-10", "2026-10-31");
  const bd2 = h.timer("FNMA_F121_DQ_REPORT_BD2"); assert.equal(toIso(bd2.dueAt!), iso("2026-11-03", "17:00"));
  const eom = h.timer("FNMA_F121_DQ_SNAPSHOT_EOM"); assert.equal(toIso(eom.dueAt!), iso("2026-10-31", "23:59"));
  const snap = await h.run("buildDqSnapshot", { period: "2026-10", loans: [{ loan_id: "L-1", facts: WORKED, fnma_loan_number: "4000000001" }] });
  assert.deepEqual(snap.population, ["L-1"]); assert.equal(snap.record_count, 1); assert.equal(eom.status, "satisfied");
  assert.equal(h.timer("FNMA_D2401_DQ_MGMT_ACTION_GATE").note, "evaluator:5.7.managementActionRecorded");
  h.clock.set(iso("2026-11-03", "09:00"));
  await assert.rejects(h.run("submitAmnFile", { period_month: "2026-10-01", lines: [{ loan_id: "L-1", ...line }], record_count: 412, transmitted_at: iso("2026-11-03", "09:00") }), /ack is required/);
  assert.equal(bd2.status, "armed");
  const out = await h.run("submitAmnFile", { period_month: "2026-10-01", lines: [{ loan_id: "L-1", ...line }], record_count: 412, transmitted_at: iso("2026-11-03", "09:00"), ack: "B2B-ACK-1" });
  assert.equal(out.late, false); assert.equal(out.escalation, null); assert.equal(out.due_at, iso("2026-11-03", "17:00")); assert.equal(out.lines_submitted, 1);
  assert.equal(bd2.status, "satisfied");
  const submitted = h.events.ofType("delinquency_reports.submitted")[0]!;
  assert.equal(submitted.payload.ack, "B2B-ACK-1"); assert.equal(submitted.payload.record_count, 412); assert.equal(submitted.payload.channel, "amn_b2b");
  assert.ok(eventMatches(h.def("FNMA_F121_DQ_REPORT_BD2").satisfiedPattern!, submitted));
  assert.deepEqual(h.events.ofType("delinquency_report_lines.submitted").map((e) => [e.loanId, e.payload.status_code, e.payload.reason_code]), [["L-1", "AW", "016"]]);
  assert.equal(h.escalations.opened.length, 0);
});
test("5.7-T2: Given the same loan in the December cycle with trial approved, then the line is `BF`/`016`/`20270101`/`20270331` and AW does not recur.", async () => {
  const dec: LoanStatusFacts = { fnma_delinquency_status: "90", lpi: D("2026-08-01"), hardship: "unemployment", contact_achieved: true, actions: [{ kind: "qrpc_no_solution", at: "2026-10-20T15:00:00Z", already_reported: true }, { kind: "brp_complete", at: "2026-11-18T12:00:00Z" }, { kind: "trial_active", at: "2026-12-01T12:00:00Z", effective: D("2027-01-01"), completion: trialCompletionDate(D("2027-01-01"), 3) }] };
  const line = statusLine(dec)!;
  assert.deepEqual(line, { status: "BF", reason: "016", effective: "20270101", completion: "20270331" });
  assert.deepEqual(validateF121Layout(line), []);
  assert.notEqual(deriveStatusCode(dec)!.code, "AW"); assert.equal(deriveStatusCode({ ...dec, actions: dec.actions.filter((a) => a.kind === "qrpc_no_solution") })!.code, "42", "an already-reported QRPC yields 42, never a second AW");
  // the engine: the November AW line arms the one-month rule; a December AW for the same loan is refused at build (AW_ONCE); the BF line satisfies it
  const h = harness(iso("2026-11-03", "09:00"));
  await h.run("submitAmnFile", { period_month: "2026-10-01", lines: [{ loan_id: "L-1", status: "AW", reason: "016", effective: "20261020" }], transmitted_at: iso("2026-11-03", "09:00"), ack: "B2B-ACK-1" });
  const aw = h.timer("FNMA_F121_AW_ONE_MONTH", "L-1"); assert.equal(aw.dueDate, "2026-12-03");
  h.clock.set(iso("2026-12-02", "09:00"));
  await assert.rejects(h.run("submitAmnFile", { period_month: "2026-11-01", lines: [{ loan_id: "L-1", status: "AW", reason: "016", effective: "20261020" }], transmitted_at: iso("2026-12-02", "09:00"), ack: "B2B-ACK-2" }), (e: unknown) => e instanceof CommandRefused && /AW_ONCE/.test(String((e as CommandRefused).message)));
  assert.equal(aw.status, "armed");
  const out = await h.run("submitAmnFile", { period_month: "2026-11-01", lines: [{ loan_id: "L-1", ...line }], transmitted_at: iso("2026-12-02", "09:00"), ack: "B2B-ACK-2" });
  assert.equal(out.due_at, iso("2026-12-02", "17:00")); assert.equal(out.late, false);
  assert.equal(aw.status, "satisfied");
});
test("5.7-T3: Given a loan current at Nov 30, 2026 that was granted a 3-month imminent-default forbearance on Nov 10 suspending the Dec 1, Jan 1 and Feb 1 installments at $0.00, then the December file (due Wed Dec 2) still includes the loan (management action in the month) with status `09`, effective `20261201` (first month of suspension), completion `20270228`, pos 47 `0`, pos 49 `1`, pos 51–61 `00000000.00`, pos 63–70 spaces.", async () => {
  const fb: LoanStatusFacts = { fnma_delinquency_status: "current", lpi: D("2026-11-01"), actions: [{ kind: "forbearance_active", at: "2026-11-10T12:00:00Z", effective: D("2026-12-01"), completion: D("2027-02-28"), evidence_event_id: "fb-1" }], hardship: "other", contact_achieved: true };
  assert.equal(inPopulation(fb), true);
  const l = statusLine(fb, { imminent_default: true, forbearance_payment_cents: 0n, forbearance_payment_received_on: null })!;
  assert.deepEqual([l.status, l.effective, l.completion, l.forbearance!.pos47, l.forbearance!.pos49, l.forbearance!.pos51_61, l.forbearance!.pos63_70], ["09", "20261201", "20270228", "0", "1", "00000000.00", "        "]);
  const rec = renderF121Record("123456789", "4000000001", l);
  assert.equal(rec.length, 80); assert.equal(rec[46], "0"); assert.equal(rec[48], "1"); assert.equal(rec.slice(50, 61), "00000000.00"); assert.equal(rec.slice(62, 70), "        "); assert.equal(rec.slice(71, 75), "    ");
  assert.deepEqual(validateF121Record(rec), []); assert.deepEqual(parseF121Record(rec).forbearance, l.forbearance);
  assert.equal(toIso(amnTransmission({ period_month: D("2026-11-01"), transmitted_at_ms: at("2026-12-02", "09:00"), record_count: 1 }).due_ms), iso("2026-12-02", "17:00"));
  // the required-date rules: 09 without a completion date, or without its forbearance fields, fails local validation
  assert.match(validateF121Layout({ status: "09", reason: "015", effective: "20261201", completion: "        " }).join("; "), /completion date is required for status 09/);
  assert.match(validateF121Layout({ status: "80", reason: "015", effective: "        ", completion: "        " }).join("; "), /effective date is required for status 80/);
  assert.deepEqual(validateF121Layout({ status: "42", reason: "031", effective: "        ", completion: "        " }), []);
  // the snapshot: the current loan is in the December file because of the management action (D2-4-01), and the file is due Wed Dec 2, 2026 17:00 ET
  const h = harness(iso("2026-11-30", "23:59")); h.monthEnd("2026-11", "2026-11-30");
  const eom = h.timer("FNMA_F121_DQ_SNAPSHOT_EOM"); assert.equal(toIso(eom.dueAt!), iso("2026-11-30", "23:59")); assert.equal(eom.status, "armed");
  const current: LoanStatusFacts = { fnma_delinquency_status: "current", lpi: D("2026-11-01"), actions: [], hardship: null, contact_achieved: false };
  const snap = await h.run("buildDqSnapshot", { period: "2026-11", loans: [{ loan_id: "L-FB", facts: fb }, { loan_id: "L-CUR", facts: current }] });
  assert.deepEqual(snap.population, ["L-FB"]); assert.deepEqual(snap.loans_with_management_action, ["L-FB"]);
  const snapLine = h.events.ofType("delinquency_report_lines.snapshot")[0]!; assert.equal(snapLine.loanId, "L-FB"); assert.equal(snapLine.payload.status_code, "09"); assert.equal(snapLine.payload.periods_delinquent, 0); assert.equal(snapLine.payload.management_action, true);
  assert.equal(eom.status, "satisfied"); assert.equal(h.timers.byCode("FNMA_F121_DQ_SNAPSHOT_EOM").length, 2, "the recurring row re-arms for the next month end");
  assert.equal(toIso(h.timer("FNMA_F121_DQ_REPORT_BD2").dueAt!), iso("2026-12-02", "17:00"));
});
test("5.7-T4: Given a Chapter 13 filed Oct 28 on a loan with a sale scheduled Nov 5, then the code is `67` (Level 3), not `71`.", () => {
  const bk: LoanStatusFacts = { fnma_delinquency_status: "120+", lpi: D("2026-05-01"), actions: [{ kind: "sale_scheduled", at: "2026-10-01T12:00:00Z", effective: D("2026-11-05") }, { kind: "bankruptcy", at: "2026-10-28T12:00:00Z", chapter: "13" }], hardship: null, contact_achieved: false };
  assert.equal(deriveStatusCode(bk)!.code, "67"); assert.equal(deriveStatusCode(bk)!.level, 3); assert.equal(statusLine(bk)!.reason, "031");
  // the full hierarchy: Level 5 collections outrank Level 6 refinance/assignment even when the refinance is the later action
  const l6: LoanStatusFacts = { fnma_delinquency_status: "60", lpi: D("2026-08-01"), actions: [{ kind: "breach_letter", at: "2026-10-05T12:00:00Z" }, { kind: "refinance_pending", at: "2026-10-20T12:00:00Z" }], hardship: "divorce", contact_achieved: true };
  assert.equal(deriveStatusCode(l6)!.code, "80"); assert.equal(deriveStatusCode({ ...l6, actions: [l6.actions[1]!] })!.code, "42");
  assert.equal(deriveStatusCode({ ...l6, fnma_delinquency_status: "current", lpi: null, actions: [{ kind: "assignment", at: "2026-10-20T12:00:00Z" }] })!.code, "49");
  assert.equal(reasonCode(l6), "005"); assert.equal(reasonCode({ ...l6, hardship: "disaster" }), "019"); assert.equal(reasonCode({ ...l6, hardship: "death" }), "001");
  // the event rail (rule 6): Chapter 13 Bankruptcy + Contested/Litigated Foreclosure is a foreclosure-vs-bankruptcy conflict → only the bankruptcy status is reported
  assert.deepEqual(deriveEventStatusTypes(["Chapter 13 Bankruptcy", "Contested/Litigated Foreclosure"]), { status_types: ["Chapter 13 Bankruptcy"], dropped: ["Contested/Litigated Foreclosure"] });
  assert.deepEqual(validateDelinquencyEvent({ action: "referred_to_foreclosure", status_types: ["Chapter 13 Bankruptcy", "Contested/Litigated Foreclosure"], reason_types: [] }), ["foreclosure status alongside a bankruptcy status (foreclosure vs bankruptcy conflict)"]);
  assert.deepEqual(validateDelinquencyEvent({ action: "qrpc_achieved", status_types: [], reason_types: ["Property Problem", "Casualty Loss"] }), ["reason types Property Problem + Casualty Loss are mutually exclusive"]);
  assert.deepEqual(validateDelinquencyEvent({ action: "qrpc_achieved", status_types: [], reason_types: [] }), ["Quality Right Party Contact requires an existing Delinquency Reason Type"]);
  assert.deepEqual(validateDelinquencyEvent({ action: "qrpc_achieved", status_types: [], reason_types: [], prior_reason_reported: true }), []);
  assert.deepEqual(validateDelinquencyEvent({ action: "breach_letter_sent", status_types: ["Refinance", "Assignment"], reason_types: ["Borrower Declined to Provide a Reason", "Unemployment"] }), ['"Borrower Declined to Provide a Reason" cannot pair with another reason type', "status types Refinance + Assignment conflict (assumption/refinance/assignment)"]);
});
test("5.7-T5: Given BD4 exception report lists 3 critical exceptions (invalid reason code), then corrections are transmitted by CD10 (the published calendar lists Sat Oct 10, 2026 for the October cycle; the engine targets the preceding business day, Fri Oct 9) and the CD11 final report reconciles to zero critical.", async () => {
  const exceptions = [{ loan_id: "L1", code: "E-REASON", severity: "critical" }, { loan_id: "L2", code: "E-REASON", severity: "critical" }, { loan_id: "L3", code: "E-REASON", severity: "critical" }, { loan_id: "L4", code: "W-DATE", severity: "noncritical" }] as const;
  const c = dqExceptionCycle({ file_month: D("2026-10-01"), exceptions, published_cd10: D("2026-10-10") });
  assert.equal(c.critical.length, 3); assert.equal(c.corrections_due_on, "2026-10-09"); assert.equal(toIso(c.corrections_due_ms), iso("2026-10-09", "17:00"));
  assert.equal(c.final_report_on, "2026-10-11"); assert.equal(c.status, "exceptions_open");
  assert.equal(toIso(correctionsDueMs(D("2026-09-01"), D("2026-10-10"))), iso("2026-10-09", "17:00")); assert.equal(toIso(correctionsDueMs(D("2026-09-01"))), iso("2026-10-09", "17:00"));
  const lines = [{ loan_id: "L1", status_code: "42" }, { loan_id: "L2", status_code: "09" }, { loan_id: "L3", status_code: "43" }];
  const f = reconcileFinalReport({ lines, final: lines.map((l) => ({ ...l, exception: null })) });
  assert.equal(f.critical_remaining, 0); assert.deepEqual(f.mismatched, []); assert.equal(f.status, "final");
  assert.equal(reconcileFinalReport({ lines, final: [{ loan_id: "L1", status_code: "42", exception: "E-REASON" }, ...lines.slice(1).map((l) => ({ ...l, exception: null }))] }).status, "exceptions_open");
  // the engine: the September file's cycle — BD4 (Mon Oct 5) exception report parsed arms the correction clock at Fri Oct 9 17:00 ET (Sat Oct 10 rolled back);
  // the acknowledged correction file satisfies it; the CD11 final report (Sun Oct 11 12:00 ET, an inbound calendar-day row) reconciled to zero critical satisfies FINAL_CD11
  const h = harness(iso("2026-10-05", "12:00")); h.monthEnd("2026-09", "2026-09-30");
  const bd4 = h.timer("FNMA_F121_DQ_EXCEPTIONS_BD4"); assert.equal(toIso(bd4.dueAt!), iso("2026-10-06", "12:00"));
  const cd11 = h.timer("FNMA_F121_DQ_FINAL_CD11"); assert.equal(cd11.dueDate, "2026-10-11"); assert.equal(toIso(cd11.dueAt!), iso("2026-10-11", "12:00"));
  const parsed = await h.run("parseExceptionReport", { file_month: "2026-09-01", exceptions: [...exceptions], published_cd10: "2026-10-10", document_id: "doc-exc-1" });
  assert.equal((parsed.critical as unknown[]).length, 3); assert.equal(bd4.status, "satisfied");
  const cd10 = h.timer("FNMA_F121_DQ_CORRECT_CD10"); assert.equal(cd10.dueDate, "2026-10-09"); assert.equal(toIso(cd10.dueAt!), iso("2026-10-09", "17:00"));
  const corrected = [{ loan_id: "L1", status: "42", reason: "016", exception_code: "E-REASON" }, { loan_id: "L2", status: "09", reason: "006", effective: "20261001", completion: "20261231", forbearance: { pos47: "0", pos49: "0", pos51_61: "00000000.00", pos63_70: "        ", pos72_75: "    " }, exception_code: "E-REASON" }, { loan_id: "L3", status: "43", reason: "031", exception_code: "E-REASON" }];
  await assert.rejects(h.run("submitAmnFile", { op: "corrections", period_month: "2026-09-01", lines: [{ loan_id: "L1", status: "42", reason: "9" }, { loan_id: "L2", status: "09", reason: "006", effective: "20261001" }], transmitted_at: iso("2026-10-08", "10:00"), ack: "B2B-ACK-C1", published_cd10: "2026-10-10" }), /fails F-1-21 validation: reason code must be 3 characters/);
  assert.equal(cd10.status, "armed");
  h.clock.set(iso("2026-10-08", "10:00"));
  const out = await h.run("submitAmnFile", { op: "corrections", period_month: "2026-09-01", lines: corrected, transmitted_at: iso("2026-10-08", "10:00"), ack: "B2B-ACK-C1", published_cd10: "2026-10-10" });
  assert.equal(out.late, false); assert.equal(out.due_at, iso("2026-10-09", "17:00")); assert.deepEqual(out.corrected, ["L1", "L2", "L3"]); assert.equal(out.status, "corrected");
  assert.equal(cd10.status, "satisfied");
  const acc = h.events.ofType("delinquency_reports.corrections_accepted")[0]!; assert.equal(acc.payload.ack, "B2B-ACK-C1"); assert.equal(acc.payload.record_count, 3);
  assert.ok(eventMatches(h.def("FNMA_F121_DQ_CORRECT_CD10").satisfiedPattern!, acc));
  assert.equal(h.events.ofType("delinquency_report_lines.submitted").filter((e) => e.payload.correction === true).length, 3);
  // CD11: a final report still carrying a critical exception does not close the cycle (portal pull opens); the clean one does
  h.clock.set(iso("2026-10-11", "09:00"));
  const open = await h.run("parseExceptionReport", { op: "final", period_month: "2026-09-01", lines, final: [{ loan_id: "L1", status_code: "42", exception: "E-REASON" }, ...lines.slice(1).map((l) => ({ ...l, exception: null }))], document_id: "doc-final-0" });
  assert.equal(open.status, "exceptions_open"); assert.equal(open.critical_remaining, 1); assert.equal(cd11.status, "armed"); assert.equal(h.escalations.opened.at(-1)!.kind, "human_portal_task");
  const fin = await h.run("parseExceptionReport", { op: "final", period_month: "2026-09-01", lines, final: lines.map((l) => ({ ...l, exception: null })), document_id: "doc-final-1" });
  assert.equal(fin.status, "final"); assert.equal(fin.critical_remaining, 0); assert.deepEqual(fin.mismatched, []);
  assert.equal(cd11.status, "satisfied");
  const rec = h.events.ofType("delinquency_reports.final_reconciled").at(-1)!; assert.equal(rec.payload.status, "final"); assert.equal(rec.payload.final_report_document_id, "doc-final-1");
  assert.ok(eventMatches(h.def("FNMA_F121_DQ_FINAL_CD11").satisfiedPattern!, rec)); assert.ok(!eventMatches(h.def("FNMA_F121_DQ_FINAL_CD11").satisfiedPattern!, h.events.ofType("delinquency_reports.final_reconciled")[0]!));
});
test('5.7-T6: Given `mode=dual` in CIT, when a breach letter is sent Wed Oct 21, 2026 14:00 ET, then a delinquency event with action "Breach Letter Sent" is submitted to `api-clve` by Thu Oct 22 03:00 ET and the November AMN line shows `80` with effective `20261021`.', async () => {
  const e = dqEventForAction({ action: "breach_letter_sent", processed_at_ms: at("2026-10-21", "14:00"), mode: "dual" });
  assert.equal(e.servicer_action_type, "Breach Letter Sent"); assert.equal(e.env, "api-clve");
  assert.equal(toIso(e.submit_by_ms), iso("2026-10-22", "03:00"));
  assert.equal(e.amn_line.status, "80"); assert.equal(e.amn_line.effective, "20261021");
  assert.deepEqual(validateF121Layout({ status: e.amn_line.status, reason: "031", effective: e.amn_line.effective, completion: "        " }), []);
  assert.equal(SERVICER_ACTION_TYPES.breach_letter_sent.type, "Breach Letter Sent"); assert.equal(SERVICER_ACTION_TYPES.breach_letter_sent.amn_status, "80");
  // the engine: the §11 breach letter processed at 14:00 ET arms the next-BD 03:00 ET clock; the event submitted to api-clve satisfies it
  const h = harness(iso("2026-10-21", "14:00"));
  await assert.rejects(h.run("submitDqEvent", { op: "record_action", loan_id: "L-1", action: "breach_letter_sent", processed_at: iso("2026-10-21", "14:00"), mode: "dual" }), /source_event_id is required/);
  const rec = await h.run("submitDqEvent", { op: "record_action", loan_id: "L-1", action: "breach_letter_sent", source_event_id: "notice.breach.sent#1", processed_at: iso("2026-10-21", "14:00"), mode: "dual" });
  assert.equal(rec.servicer_action_type, "Breach Letter Sent"); assert.equal(rec.submit_by, iso("2026-10-22", "03:00")); assert.equal(rec.env, "api-clve"); assert.deepEqual(rec.amn_line, { status: "80", effective: "20261021", completion: "        " });
  const clock = h.timer("FNMA_LL202605_DQ_EVENT_NEXTBD_0300", "L-1"); assert.equal(clock.dueDate, "2026-10-22"); assert.equal(toIso(clock.dueAt!), iso("2026-10-22", "03:00")); assert.equal(clock.status, "armed");
  await assert.rejects(h.run("submitDqEvent", { loan_id: "L-1", action: "breach_letter_sent", processed_at: iso("2026-10-21", "14:00"), mode: "legacy" }), /legacy is the AMN file alone/);
  h.clock.set(iso("2026-10-21", "16:00"));
  const sub = await h.run("submitDqEvent", { loan_id: "L-1", action: "breach_letter_sent", processed_at: iso("2026-10-21", "14:00"), submitted_at: iso("2026-10-21", "16:00"), mode: "dual", reason_types: ["Unemployment"], action_event_id: rec.event_id });
  assert.equal(sub.servicer_action_type, "Breach Letter Sent"); assert.equal(sub.env, "api-clve"); assert.equal(sub.submit_by, iso("2026-10-22", "03:00")); assert.equal(sub.on_time, true); assert.deepEqual(sub.amn_line, { status: "80", effective: "20261021", completion: "        " });
  assert.equal(clock.status, "satisfied");
  const ev = h.events.ofType("delinquency_events.submitted")[0]!; assert.equal(ev.loanId, "L-1"); assert.equal(ev.payload.env, "api-clve"); assert.equal(ev.payload.servicer_action_type, "Breach Letter Sent");
  assert.ok(eventMatches(h.def("FNMA_LL202605_DQ_EVENT_NEXTBD_0300").satisfiedPattern!, ev));
  // a Friday action rolls to Monday 03:00 ET; the Nov 11 (Veterans Day) action rolls past the fannie_et holiday
  assert.equal(toIso(dqEventForAction({ action: "breach_letter_sent", processed_at_ms: at("2026-10-23", "14:00"), mode: "dual" }).submit_by_ms), iso("2026-10-26", "03:00"));
  assert.equal(toIso(dqEventForAction({ action: "breach_letter_sent", processed_at_ms: at("2026-11-10", "14:00"), mode: "dual" }).submit_by_ms), iso("2026-11-12", "03:00"));
});
test("5.7-T7: Given a loan reported 43 without a `foreclosure.referral.sent` event, then the consistency check blocks the line and escalates before BD2.", async () => {
  const ref: LoanStatusFacts = { fnma_delinquency_status: "120+", lpi: D("2026-05-01"), actions: [{ kind: "referred", at: "2026-10-05T12:00:00Z", evidence_event_id: "ref-1" }], hardship: null, contact_achieved: false, referral_event_present: false };
  const errors = consistencyErrors(ref, statusLine(ref)!);
  assert.equal(errors.length, 1);
  const b = consistencyBlock({ loan_id: "L-1", period_month: D("2026-10-01"), errors });
  assert.equal(b.blocked, true); assert.equal(b.escalation!.severity, "sev2"); assert.equal(toIso(b.escalation!.before_ms), iso("2026-11-03", "17:00"));
  assert.deepEqual(consistencyBlock({ loan_id: "L-1", period_month: D("2026-10-01"), errors: consistencyErrors({ ...ref, referral_event_present: true }, statusLine(ref)!) }), { blocked: false, escalation: null });
  // rule 7's other checks: SMDU case status for 09/12/BF, the DRA/P360 sale date for 71, the PACER chapter for bankruptcy codes
  const fb: LoanStatusFacts = { fnma_delinquency_status: "30", lpi: D("2026-09-01"), actions: [{ kind: "forbearance_active", at: "2026-10-10T12:00:00Z", effective: D("2026-11-01"), completion: D("2027-01-31") }], hardship: "other", contact_achieved: true };
  assert.deepEqual(lineConsistencyErrors(fb, statusLine(fb)!, { smdu_case_status: "cancelled" }), ["09 but SMDU case status is cancelled"]); assert.deepEqual(lineConsistencyErrors(fb, statusLine(fb)!, { smdu_case_status: "active" }), []);
  const sale: LoanStatusFacts = { fnma_delinquency_status: "120+", lpi: D("2026-05-01"), actions: [{ kind: "sale_scheduled", at: "2026-10-01T12:00:00Z", effective: D("2026-11-05") }], hardship: null, contact_achieved: false };
  assert.deepEqual(lineConsistencyErrors(sale, statusLine(sale)!, { dra_sale_date: D("2026-11-12") }), ["71 effective 20261105 does not match the DRA/P360 scheduled sale date 2026-11-12"]); assert.deepEqual(lineConsistencyErrors(sale, statusLine(sale)!, { dra_sale_date: D("2026-11-05") }), []);
  const bk: LoanStatusFacts = { ...sale, actions: [{ kind: "bankruptcy", at: "2026-10-28T12:00:00Z", chapter: "13" }] };
  assert.deepEqual(lineConsistencyErrors(bk, statusLine(bk)!, { pacer_chapter: "7" }), ["67 reported for chapter 13 but PACER shows chapter 7"]); assert.deepEqual(lineConsistencyErrors(bk, statusLine(bk)!, { pacer_chapter: "13" }), []);
  // the engine: the BD1 consistency row (Mon Nov 2, 2026 12:00 ET) is satisfied only by a clean file; the blocked 43 line escalates sev-2 before the BD2 17:00 ET transmission
  const h = harness(iso("2026-11-02", "09:00")); h.monthEnd("2026-10", "2026-10-31");
  const bd1 = h.timer("SM_DQ_SMDU_DRA_CONSISTENCY_BD1"); assert.equal(toIso(bd1.dueAt!), iso("2026-11-02", "12:00"));
  const one = await h.run("checkConsistency", { loan_id: "L-1", facts: ref, period_month: "2026-10-01" });
  assert.equal(one.blocked, true); assert.deepEqual(one.errors, ["43 without foreclosure.referral.sent (E-1.2-02)"]);
  const esc = h.escalations.opened.at(-1)!; assert.equal(esc.kind, "sev2"); assert.equal(esc.loanId, "L-1"); assert.equal(esc.payload.before, iso("2026-11-03", "17:00"));
  const file = await h.run("checkConsistency", { op: "file", period_month: "2026-10-01", lines: [{ loan_id: "L-1", facts: ref }, { loan_id: "L-2", facts: WORKED }] });
  assert.equal(file.errors, 1); assert.deepEqual(file.blocked_loans, ["L-1"]); assert.equal(bd1.status, "armed", "a file with a blocked line does not satisfy the consistency row");
  assert.equal(h.escalations.opened.filter((e) => e.kind === "sev2").length, 2);
  const clean = await h.run("checkConsistency", { op: "file", period_month: "2026-10-01", lines: [{ loan_id: "L-1", facts: { ...ref, referral_event_present: true } }, { loan_id: "L-2", facts: WORKED }] });
  assert.equal(clean.errors, 0); assert.deepEqual(clean.blocked_loans, []); assert.equal(bd1.status, "satisfied");
  const ev = h.events.ofType("delinquency_reports.consistency_checked").at(-1)!; assert.equal(ev.payload.errors, 0); assert.ok(eventMatches(h.def("SM_DQ_SMDU_DRA_CONSISTENCY_BD1").satisfiedPattern!, ev));
  assert.ok(!eventMatches(h.def("SM_DQ_SMDU_DRA_CONSISTENCY_BD1").satisfiedPattern!, h.events.ofType("delinquency_reports.consistency_checked")[0]!));
  // a low-confidence line is flagged for human_agent review before BD2 but still transmits; the correction window is CD10
  const flag = lineReviewFlag({ confidence: 0.8, period_month: D("2026-10-01"), published_cd10: D("2026-10-10") });
  assert.equal(flag.flagged, true); assert.equal(flag.role, "human_agent"); assert.equal(flag.transmits_on_time, true); assert.equal(toIso(flag.review_before_ms), iso("2026-11-03", "17:00"));
  assert.equal(lineReviewFlag({ confidence: 0.9, period_month: D("2026-10-01") }).flagged, false);
  h.clock.set(iso("2026-11-03", "09:00"));
  const out = await h.run("submitAmnFile", { period_month: "2026-10-01", lines: [{ loan_id: "L-2", status: "AW", reason: "016", effective: "20261020", confidence: 0.8 }], transmitted_at: iso("2026-11-03", "09:00"), ack: "B2B-ACK-1" });
  assert.deepEqual(out.flagged_for_review, ["L-2"]); assert.equal(out.late, false);
  const review = h.escalations.opened.at(-1)!; assert.equal(review.kind, "human_agent"); assert.equal(review.loanId, "L-2"); assert.equal(review.payload.review_before, iso("2026-11-03", "17:00")); assert.equal(review.payload.correction_by, iso("2026-11-10", "17:00"));
});
test("5.7-T8: Given the file is transmitted at BD2 18:30 ET, then the `late` flag is set, an `officer` escalation records a potential compensatory-fee instance and the Compliance Sentinel report lists it.", async () => {
  const t = amnTransmission({ period_month: D("2026-10-01"), transmitted_at_ms: at("2026-11-03", "18:30"), record_count: 412 });
  assert.equal(toIso(t.due_ms), iso("2026-11-03", "17:00")); assert.equal(t.late, true); assert.equal(t.escalation, "officer");
  assert.deepEqual(t.compfee_instance, { kind: "late_delinquency_file", period: "2026-10", minutes_late: 90 }); assert.match(t.sentinel_line!, /compensatory-fee/);
  assert.equal(amnTransmission({ period_month: D("2026-10-01"), transmitted_at_ms: at("2026-11-03", "16:30"), record_count: 412 }).late, false);
  // the engine: BD2 17:00 ET passes → breached; the 18:30 ET acknowledged transmission closes it late, sets `late` on the event and opens the officer's compensatory-fee escalation
  const h = harness(iso("2026-10-31", "23:59")); h.monthEnd("2026-10", "2026-10-31");
  const bd2 = h.timer("FNMA_F121_DQ_REPORT_BD2");
  h.clock.set(iso("2026-11-03", "18:30"));
  const breaches = h.timers.evaluate(iso("2026-11-03", "18:30")); assert.ok(breaches.some((b) => b.instance.code === "FNMA_F121_DQ_REPORT_BD2")); assert.equal(bd2.status, "breached");
  const out = await h.run("submitAmnFile", { period_month: "2026-10-01", lines: [{ loan_id: "L-1", status: "AW", reason: "016", effective: "20261020" }], record_count: 412, transmitted_at: iso("2026-11-03", "18:30"), ack: "B2B-ACK-LATE" });
  assert.equal(out.late, true); assert.equal(out.escalation, "officer"); assert.deepEqual(out.compfee_instance, { kind: "late_delinquency_file", period: "2026-10", minutes_late: 90 }); assert.match(String(out.sentinel_line), /F-1-21 delinquency file for 2026-10 transmitted 90 minutes after BD2 17:00 ET \(412 records\) — potential compensatory-fee instance/);
  assert.equal(bd2.status, "satisfied_late");
  assert.equal(h.events.ofType("delinquency_reports.submitted")[0]!.payload.late, true);
  const esc = h.escalations.opened.find((e) => e.kind === "officer")!; assert.equal(esc.ownerRole, "officer"); assert.equal(esc.severity, "sev1"); assert.deepEqual(esc.payload.compfee_instance, { kind: "late_delinquency_file", period: "2026-10", minutes_late: 90 }); assert.match(String(esc.payload.reason), /compensatory-fee/);
});

// ---- timer rows not named by a T-id: the event-rail Payment Reminder notification (CD23) and the 5.4 reclass deselection window the 5.7 table cross-references ----
test("5.7 FNMA_LL202605_DQ_PMT_REMINDER_CD23: a loan 1 period delinquent at month-end expects the Payment Reminder Notice event accepted by CD23 of the following month; the platform's accepted response satisfies it (notification only)", async () => {
  assert.deepEqual(PERIODS_DELINQUENT, { current: 0, "30": 1, "60": 2, "90": 3, "120+": 4 });
  const h = harness(iso("2026-10-31", "23:59"));
  const one: LoanStatusFacts = { fnma_delinquency_status: "30", lpi: D("2026-09-01"), actions: [], hardship: null, contact_achieved: false };
  const two: LoanStatusFacts = { fnma_delinquency_status: "60", lpi: D("2026-08-01"), actions: [], hardship: null, contact_achieved: false };
  await h.run("buildDqSnapshot", { period: "2026-10", loans: [{ loan_id: "L-30", facts: one }, { loan_id: "L-60", facts: two }], servicer_number: "123456789" });
  assert.deepEqual(h.events.ofType("delinquency_report_lines.snapshot").map((e) => [e.loanId, e.payload.periods_delinquent, e.payload.status_code]), [["L-30", 1, "42"], ["L-60", 2, "42"]]);
  assert.deepEqual(h.events.ofType("delinquency_reports.snapshot_built")[0]!.aggregate, { kind: "period", id: "123456789:2026-10" });
  const cd23 = h.timer("FNMA_LL202605_DQ_PMT_REMINDER_CD23", "L-30"); assert.equal(cd23.dueDate, "2026-11-23"); assert.equal(cd23.status, "armed");
  assert.equal(h.timers.byCode("FNMA_LL202605_DQ_PMT_REMINDER_CD23").filter((t) => t.subject.id === "L-60").length, 0, "2 periods delinquent is not the CD23 expectation");
  h.clock.set(iso("2026-11-16", "10:00"));
  await h.run("submitDqEvent", { loan_id: "L-30", action: "payment_reminder_notice", processed_at: iso("2026-11-16", "09:00"), mode: "dual", submission_id: "sub-prn-1" });
  await assert.rejects(h.run("submitDqEvent", { op: "response", loan_id: "L-30", submission_id: "sub-prn-1", servicer_action_type: "Payment Reminder Notice", status: "rejected" }), /at least one exception/);
  await assert.rejects(h.run("submitDqEvent", { op: "response", loan_id: "L-30", submission_id: "sub-prn-1", servicer_action_type: "Late Charge Assessed", status: "accepted" }), /not a Servicer Action Type/);
  assert.equal(cd23.status, "armed");
  const r = await h.run("submitDqEvent", { op: "response", loan_id: "L-30", submission_id: "sub-prn-1", servicer_action_type: "Payment Reminder Notice", status: "accepted_with_warnings", warnings: ["Outbound Contact expected by CD53"], received_at: iso("2026-11-16", "10:00") });
  assert.equal(r.status, "accepted_with_warnings"); assert.equal(cd23.status, "satisfied");
  const ev = h.events.ofType("delinquency_events.accepted")[0]!; assert.equal(ev.loanId, "L-30"); assert.equal(ev.payload.servicer_action_type, "Payment Reminder Notice");
  assert.ok(eventMatches(h.def("FNMA_LL202605_DQ_PMT_REMINDER_CD23").satisfiedPattern!, ev));
  assert.ok(!eventMatches(h.def("FNMA_LL202605_DQ_PMT_REMINDER_CD23").satisfiedPattern!, { ...ev, payload: { ...ev.payload, servicer_action_type: "Breach Letter Sent" } }));
});
test("5.7 FNMA_F125_RECLASS_DESELECT_CD15: the Eligible for Deselection report available on Fannie Mae Connect (~CD11) opens the deselection window to CD15; the recorded deselection decision satisfies it", async () => {
  const h = harness(iso("2026-11-11", "14:00"));
  await assert.rejects(h.run("parseExceptionReport", { op: "connect_report", report: "sda_rollforward", period: "2026-10", document_id: "doc-1" }), /not one of/);
  const rep = await h.run("parseExceptionReport", { op: "connect_report", report: "eligible_for_deselection", period: "2026-10", document_id: "doc-desel-1", available_at: iso("2026-11-11", "14:00"), loan_count: 2 });
  assert.equal(rep.report, "eligible_for_deselection");
  const cd15 = h.timer("FNMA_F125_RECLASS_DESELECT_CD15", "2026-10"); assert.equal(cd15.dueDate, "2026-11-15"); assert.equal(cd15.status, "armed");
  await assert.rejects(h.run("recordDecision", { op: "reclass_deselection", loan_id: "L-1", period: "2026-10", decision: "maybe", rationale: "x" }), /must be deselect or retain/);
  const d = await h.run("recordDecision", { op: "reclass_deselection", loan_id: "L-1", period: "2026-10", decision: "retain", rationale: "trial payment plan active; keep in the reclass population (F-1-25)" });
  assert.equal(d.decision, "retain"); assert.equal(cd15.status, "satisfied");
  const ev = h.events.ofType("reclass.deselection.decided")[0]!; assert.equal(ev.loanId, "L-1"); assert.deepEqual(ev.aggregate, { kind: "period", id: "2026-10" });
  assert.ok(eventMatches(h.def("FNMA_F125_RECLASS_DESELECT_CD15").satisfiedPattern!, ev));
  assert.ok(h.decisions.some((x) => x.action === "recordDecision:reclass_deselection"));
});
