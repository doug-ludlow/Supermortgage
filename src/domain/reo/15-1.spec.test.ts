// 15.1 REOgram / conveyance to Fannie Mae
// spec/sections/15-reo-claims-expense-reimbursement/15-1-reogram-conveyance-to-fannie-mae.md
// One node:test per T-id, named exactly as the spec. `todo: true` = not implemented yet (tools/audit.py does not
// count it). Implement by replacing the todo line with a real test; never edit the name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainDate as D } from "../../kernel/calendar/date.ts";
import { zonedEpochMs, wallClock, toIso } from "../../kernel/calendar/zoned.ts";
import { fannieEt } from "../../kernel/calendar/business.ts";
import { MemoryEventStore, FixedClock, SYSTEM, type Actor } from "../../kernel/events/index.ts";
import { MemoryLedger } from "../../kernel/ledger/ledger.ts";
import { TimerEngine, computeDue } from "../../kernel/timers/index.ts";
import type { UowContext } from "../../infra/db/unit-of-work.ts";
import type { DecisionInput } from "../../infra/db/decisions.ts";
import { CommandBus, CommandRefused } from "../../app/commands.ts";
import { AgentRegistry } from "../../app/agents.ts";
import { EscalationService } from "../../app/escalations.ts";
import { EntityStore, toolCommand, type ToolRuntime, type ToolInput } from "../../app/tools.ts";
import { TOOLS_15_1 } from "../../app/tools/section15-1.ts";
import { loadOverriddenRegistry } from "../timer-overrides.ts";
import { ptrInterest, thirdPartySale, larCode, caseKind, confirmDueAt, warningAt, lateDays, exceptionResolutionDue, deedRecordDue, insuranceCancellationDue, failedSaleDepositDue, rescissionClocks, refoFeesReimbursable, resaleRestrictionGate } from "./reogram.ts";
import {
  liquidationRail, liquidationEventType, monthlyPtrInterest, dailyPtrAccrual, ptrInterestComponents, spreadInterest, unrecoveredAdvances, recoveryWaterfall, crsBatchLines, closingStatement, surplusDisposition,
  proposeExceptionCorrection, compFeeExposure, deedRecordDueRolled, handoffTasks, carrierRefusal, reogramConfirmGate, gateFactsFromRecords, confidenceHold, confirmationWarning, tpsProceedsReceipt, tpsProceedsLedgerSets, tenantIdentified, rescissionReactivation, type AdvanceItem,
} from "./ops-15-1.ts";
import { EVALUATORS_15_1 } from "./evaluators-15-1.ts";
import { reogramConfirmation } from "../investor/ops.ts";

const ET = "America/New_York";
const AGENT: Actor = { kind: "agent", id: "claims-reo" };
const OPERATOR: Actor = { kind: "human", id: "u-p360-operator", role: "fnma_portal_operator" };
const ESCALATES_TO = ["attorney", "fnma_portal_operator", "officer"] as const;
const ts = (d: string, hhmm: string): string => toIso(zonedEpochMs(D(d), hhmm, ET));
// Fixture L15 (section README): S/S MBS special servicing, TX, Radian 25% BPMI, UPB $249,088.61, note 6.25% / PTR 6.00%, LPI Nov 1, 2026, sale Tue Oct 5, 2027.
const L15 = { upb_cents: 24908861n, note_rate_pct: "6.25", ptr_pct: "6.00", lpi_due: D("2026-11-01"), sale_on: D("2027-10-05"), fnma_loan_number: "1234567890" } as const;
const ADVANCES: readonly AdvanceItem[] = [
  { kind: "taxes", unit_cents: 482000n, quantity: 1 }, { kind: "hazard", unit_cents: 145000n, quantity: 1 }, { kind: "mi_premium", unit_cents: 12454n, quantity: 11 },
  { kind: "inspection", unit_cents: 3000n, quantity: 9 }, { kind: "preservation", unit_cents: 44500n, quantity: 1 }, { kind: "attorney_fee", unit_cents: 230000n, quantity: 1 }, { kind: "costs", unit_cents: 56500n, quantity: 1 },
];
const TPS_INPUT = { upb_cents: L15.upb_cents, ptr_pct: L15.ptr_pct, lpi_due: L15.lpi_due, liquidation_date: L15.sale_on, settlement_date: L15.sale_on } as const;
const PROPERTY = { address: "15 Fixture Ln", city: "Plano", county: "Collin", state: "TX", zip: "75024", property_type: "sfr" };
const MI = { indicator: true, company: "Radian", certificate: "RAD-000015", coverage_pct: "25" };
const PKG_INPUT = { loan_id: "L15", fnma_loan_number: L15.fnma_loan_number, servicer_loan_number: "SM-000015", borrower_names: ["Fixture Borrower"], property: PROPERTY, mi: MI, attorney: "Fixture Firm LLP", legal_date: "2027-10-05", purchaser: "fnma", successful_bid_cents: 26295226n, occupancy: "vacant (inspection 2027-09-30)", keys_lockbox: "lockbox 4415", preservation_vendor: "Fixture Preservation Co", hoa_utility_notes: "no HOA; utilities off", resale_restriction: "none", resale_notice_evidence: false } as const;
const NOTIFICATION = (queue: "Potential" | "Exception" | "Confirmed") => ({ subject: `Property 360 REOgram Notification — ${queue} queue`, body: `Case ID: P360-15 Servicer Loan Number: 000015 Queue: ${queue}` });

/** The 15.1 tools on the command bus over an in-memory runtime, with the timer engine listening to the same event store (as src/app/tools.test.ts wires it). */
function harness(nowIso: string, loanId = "L15") {
  const clock = new FixedClock(nowIso); const events = new MemoryEventStore(clock); const decisions: DecisionInput[] = [];
  const timers = new TimerEngine(loadOverriddenRegistry(), events, { processes: ["15.1", "5.3"] });
  const ctx: UowContext = { loanId, events, ledger: new MemoryLedger(), timers, clock, decide: (d) => { decisions.push({ loanId, ...d }); } };
  const rt: ToolRuntime = { store: new EntityStore(), escalations: new EscalationService(events, clock), services: {}, ports: {} };
  const agents = new AgentRegistry(); const bus = new CommandBus(agents);
  const cmds = new Map(TOOLS_15_1.map((t) => { const c = toolCommand(t, rt, ESCALATES_TO); agents.registerTool(t.agent, c.name); return [t.name, c] as const; }));
  const run = async (name: string, actor: Actor, input: ToolInput): Promise<any> => (await bus.execute(cmds.get(name)!, actor, input, ctx)).output;
  const at = (d: string, hhmm: string): void => clock.set(ts(d, hhmm));
  const timer = (code: string) => timers.byCode(code);
  return { ctx, rt, events, timers, clock, run, at, timer, decisions };
}
const refused = (code: string, re?: RegExp) => (e: unknown): boolean => e instanceof CommandRefused && e.code === code && (re === undefined || re.test(e.message));
/** Ledger lines of one entry set as [scope:account, cents] pairs. */
const lineSummary = (set: { lines: readonly { account: { scope: string; account: string }; amountCents: bigint }[] }) => set.lines.map((l) => [`${l.account.scope}:${l.account.account}`, l.amountCents] as const);

test("15.1-T1: Given `foreclosure.sale.held` Tue Oct 5, 2027 (Fannie Mae credit bid, MI-insured), when LAR 72 is accepted Wed Oct 6 and the P360 notification arrives Oct 6 09:10 ET, then `confirm_due_at` = Thu Oct 7, 2027 (end of `fannie_et` BD) and the portal task carries the full package.", async () => {
  const h = harness(ts("2027-10-06", "09:10"));
  // Rule 1: Fannie Mae credit bid on an MI-insured loan → reo_cases + LAR 72 (5.3); the row carries the 0017 columns.
  assert.equal(larCode("fnma", true), "72"); assert.equal(caseKind("fnma"), "reo_cases");
  const opened = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "fnma", insured: true, legal_date: "2027-10-05", foreclosed_in_name_of: "fnma", mi_policy_id: "mip-15", confidence: 0.97 });
  assert.deepEqual([opened.action_code, opened.acquisition_type, opened.legal_date, opened.title_vests_at, opened.grantee_name, opened.status], ["72", "fcl_sale", "2027-10-05", "2027-10-05", "Federal National Mortgage Association", "sale_reported"]);
  // Rule 6: reo_cases creation (`reo.case.opened{acquirer=fannie_mae}`) closes the E-4.3-01 preservation gate and starts the 14-day insurance clocks — Section 13 emits no sale event; the case carries the sale.
  assert.deepEqual([h.timer("FNMA_E4301_PRESERVATION_STOP")[0]!.status, h.timer("FNMA_E4301_PRESERVATION_STOP")[0]!.note, h.timer("FNMA_E4401_HAZARD_CANCEL_14")[0]!.dueDate], ["armed", "evaluator:15.1.postSalePreservationAllowed", "2027-10-19"]);
  // Agents paragraph: confidence < 0.9 on purchaser type → held, human_agent review requested at deadline − 4 h.
  const held = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "fnma", insured: true, legal_date: "2027-10-05", confidence: 0.8, deadline_at: ts("2027-10-07", "17:00") });
  assert.equal(held.held, true); assert.equal(held.review.request_at, ts("2027-10-07", "13:00")); assert.equal(h.rt.escalations.opened.find((e) => e.id === held.escalation_id)!.kind, "human_agent");
  assert.equal(confidenceHold({ confidence: 0.95, deadline_ms: 0, fields: ["purchaser"] }).held, false);
  // LAR 72 accepted Wed Oct 6 → a P360 case is expected within 1 BD (SM_REOGRAM_CASE_EXPECTED_1BD due Thu Oct 7).
  // The acceptance is 5.1's `acceptEvent` (ops-5-1) event in its real shape: LAR 72 = `event_type=removal.liquidation.insured`, anchored on `accepted_at`.
  h.events.append({ type: "investor_events.accepted", loanId: "L15", actor: SYSTEM, payload: { event_id: "ie-L15-72", event_type: "removal.liquidation.insured", family: "removal", activity_period: "2027-10", status: "accepted", accepted_at: ts("2027-10-06", "10:00") } });
  const expected = h.timer("SM_REOGRAM_CASE_EXPECTED_1BD")[0]!; assert.deepEqual([expected.dueDate, expected.status], ["2027-10-07", "armed"]);
  // The notification arrives Oct 6 09:10 ET → confirm_due_at = Thu Oct 7 17:00 ET (rule 2: end of the next fannie_et BD).
  const parsed = await h.run("parseP360Notification", AGENT, { loan_id: "L15", ...NOTIFICATION("Potential"), received_at: ts("2027-10-06", "09:10") });
  assert.deepEqual([parsed.kind, parsed.cases[0].p360_case_id, parsed.cases[0].queue, parsed.cases[0].portal_task_type], ["reogram", "P360-15", "potential", "p360.reogram.confirm"]);
  const due = wallClock(Date.parse(parsed.cases[0].confirm_due_at.at), ET); assert.deepEqual([due.date, due.hour, due.minute], ["2027-10-07", 17, 0]);
  const calc = confirmDueAt(zonedEpochMs(D("2027-10-06"), "09:10", ET)); assert.equal(calc.date, D("2027-10-07")); assert.deepEqual([wallClock(calc.ms, ET).hour, wallClock(calc.ms, ET).minute], [17, 0]);
  assert.equal(expected.status, "satisfied");                                                            // p360.case.observed{kind=reogram}
  assert.equal(h.timer("FNMA_E4101_REOGRAM_CONFIRM_1BD")[0]!.dueDate, "2027-10-07");                     // armed by reogram.created{receipt} on the notification
  // The portal task carries the full package (rule 3).
  const pkg = await h.run("buildReogramPackage", AGENT, { ...PKG_INPUT, notification_received_at: ts("2027-10-06", "09:10") });
  assert.deepEqual([pkg.blocked, pkg.escalation, pkg.confirm_due_at.date, pkg.gates_checked], [false, null, "2027-10-07", ["SM_RESALE_RESTRICTION_NOTICES", "MI_DATA_CHECK"]]);
  for (const k of ["fnma_loan_number", "servicer_loan_number", "borrower_names", "property_address", "unit", "city", "county", "zip", "property_type", "mi_indicator", "mi_company", "mi_certificate", "mi_coverage_pct", "attorney", "legal_date", "purchaser", "successful_bid_cents", "occupancy", "keys_lockbox", "preservation_vendor", "hoa_utility_notes", "resale_restriction_attestation", "known_exceptions"]) assert.ok(k in pkg.fields, `package carries ${k}`);
  assert.deepEqual([pkg.fields.mi_company, pkg.fields.mi_certificate, pkg.fields.mi_coverage_pct, pkg.fields.successful_bid_cents, pkg.fields.attorney, pkg.fields.county, pkg.fields.keys_lockbox], ["Radian", "RAD-000015", "25", 26295226n, "Fixture Firm LLP", "Collin", "lockbox 4415"]);
  const task = await h.run("openPortalTask", AGENT, { loan_id: "L15", task_type: "p360.reogram.confirm", due_at: pkg.confirm_due_at.at, package: pkg.fields, p360_case_id: "P360-15" });
  const esc = h.rt.escalations.opened.find((e) => e.id === task.portal_task_id)!;
  assert.deepEqual([esc.kind, esc.ownerRole, esc.payload.task_type, esc.payload.due_at, esc.payload.p360_case_id], ["human_portal_task", "fnma_portal_operator", "p360.reogram.confirm", ts("2027-10-07", "17:00"), "P360-15"]);
  assert.deepEqual(esc.payload.package, pkg.fields);
});
test("15.1-T2: Given the notification arrives Wed Nov 24, 2027 17:30 ET, then the due date is Fri Nov 26, 2027 (Thanksgiving skipped), warning at 70% elapsed.", () => {
  const received = zonedEpochMs(D("2027-11-24"), "17:30", ET);
  const due = confirmDueAt(received);
  assert.equal(due.date, D("2027-11-26")); assert.equal(fannieEt.isBusinessDay(D("2027-11-25")), false);                   // Thu Nov 25, 2027 Thanksgiving skipped
  assert.deepEqual([wallClock(due.ms, ET).hour, wallClock(due.ms, ET).minute], [17, 0]);
  const warn = confirmationWarning(received, due.ms);                                                                     // 70% of the 47.5 h window = 33.25 h after receipt
  assert.equal(warn.window_ms, 47.5 * 3_600_000);
  assert.deepEqual([wallClock(warn.warning_at_ms, ET).date, wallClock(warn.warning_at_ms, ET).hour, wallClock(warn.warning_at_ms, ET).minute], ["2027-11-26", 2, 45]);
  assert.ok(warn.warning_at_ms > received && warn.warning_at_ms < due.ms);
  const shared = reogramConfirmation(received);                                                                           // 5.3's calculator agrees on the due date and the 70% instant
  assert.deepEqual([shared.due_on, shared.due_ms, shared.warning_at_ms], [D("2027-11-26"), due.ms, warn.warning_at_ms]);
  assert.ok(Math.abs(warningAt(received, due.ms) - warn.warning_at_ms) <= 1);                                             // reogram.ts floors the float product (1 ms short) — see notes
  // The engine arms the same deadline off the notification receipt.
  const h = harness(ts("2027-11-24", "17:30"));
  return h.run("parseP360Notification", AGENT, { loan_id: "L15", ...NOTIFICATION("Potential"), received_at: ts("2027-11-24", "17:30") }).then(() => { assert.equal(h.timer("FNMA_E4101_REOGRAM_CONFIRM_1BD")[0]!.dueDate, "2027-11-26"); });
});
test("15.1-T3: Given the operator confirms Oct 8 (one BD late), then `late_days = 1`, a sev-1 escalation and a compensatory-fee exposure record exist, and any code-313 draft is matched to it.", async () => {
  const h = harness(ts("2027-10-06", "09:10"));
  await h.run("parseP360Notification", AGENT, { loan_id: "L15", ...NOTIFICATION("Potential"), received_at: ts("2027-10-06", "09:10") });
  const pkg = await h.run("buildReogramPackage", AGENT, { ...PKG_INPUT, notification_received_at: ts("2027-10-06", "09:10") });
  // The task carries no due_at of its own: rule 11's clock is the `confirm_due_at` parseP360Notification stored, never a figure the caller passes.
  const task = await h.run("openPortalTask", AGENT, { loan_id: "L15", task_type: "p360.reogram.confirm", package: pkg.fields, p360_case_id: "P360-15", fnma_loan_number: L15.fnma_loan_number });
  assert.equal(task.due_at, pkg.confirm_due_at.at);
  const clock = h.timer("FNMA_E4101_REOGRAM_CONFIRM_1BD")[0]!;
  h.at("2027-10-08", "10:00"); h.timers.evaluate(h.clock.now()); assert.equal(clock.status, "breached");
  // The operator confirms Fri Oct 8 — one fannie_et BD after the Thu Oct 7 deadline.
  const done = await h.run("openPortalTask", OPERATOR, { op: "complete", portal_task_id: task.portal_task_id, evidence_document_id: "doc-p360-export-15", explanation: "P360 outage Oct 7 14:00–18:00 ET (timestamped attempts)" });
  assert.equal(done.late_days, 1); assert.equal(lateDays(D("2027-10-07"), D("2027-10-08")), 1);
  const exposure = h.rt.store.get("comp_fee_exposures", done.comp_fee_exposure_id)!.data;
  assert.deepEqual([exposure.kind, exposure.rule, exposure.late_days, exposure.crs_code, exposure.status, exposure.rebuttal_evidence, exposure.fnma_loan_number, exposure.confirm_due_at], ["comp_fee_exposure", "A1-4.2-02", 1, "313", "open", "P360 outage Oct 7 14:00–18:00 ET (timestamped attempts)", L15.fnma_loan_number, ts("2027-10-07", "17:00")]);
  const evidence = h.rt.store.get("documents", "doc-p360-export-15")!.data;                                                     // the P360 case export is hashed into `documents`
  assert.deepEqual([evidence.kind, evidence.retention_class, String(evidence.sha256).length, done.evidence_sha256], ["p360_evidence_capture", "life_of_loan_plus_4y", 64, evidence.sha256]);
  const sev1 = h.rt.escalations.opened.find((e) => e.id === done.sev1_escalation_id)!;
  assert.deepEqual([sev1.kind, sev1.ownerRole, sev1.payload.comp_fee_exposure_id, sev1.payload.crs_code], ["sev1", "officer", done.comp_fee_exposure_id, "313"]);
  assert.equal(clock.status, "satisfied_late");                                                                                    // reogram.confirmed after the breach
  assert.equal(h.events.ofType("reogram.confirmed")[0]!.payload.late_days, 1); assert.equal(h.events.ofType("human_portal_task.completed")[0]!.payload.task, "p360.reogram.confirm");
  assert.equal(h.rt.escalations.opened.find((e) => e.id === task.portal_task_id)!.status, "completed");
  // Any inbound code-313 draft ("Delayed REOgram Notification Fees") is matched to the exposure record.
  const m = await h.run("buildCrsBatch", AGENT, { op: "match_313", loan_id: "L15", draft_id: "CRS-313-2027-11", fnma_loan_number: L15.fnma_loan_number, amount_cents: 12500n, draft_date: "2027-11-15" });
  assert.deepEqual([m.matched, m.exposure_id, m.disposition, m.rebuttal_route], [true, done.comp_fee_exposure_id, "matched_reconcile", "officer"]);
  assert.deepEqual([h.rt.store.get("comp_fee_exposures", done.comp_fee_exposure_id)!.data.matched_draft_id, h.rt.store.get("comp_fee_exposures", done.comp_fee_exposure_id)!.data.status], ["CRS-313-2027-11", "matched"]);
  // A confirmation on the due date books nothing.
  assert.deepEqual(compFeeExposure({ due_on: D("2027-10-07"), confirmed_on: D("2027-10-07") }), { late_days: 0, exposure: false, crs_code: null, escalation: null, rebuttal_evidence: null, record: null });
});
test('15.1-T4: Given an exception "MI company mismatch" raised Oct 7, then resolution is due Oct 12, 2027 (3 BD; Oct 11 holiday) and the agent proposes the correction from `mi_policies` with evidence.', async () => {
  // 3 fannie_et BD after Thu Oct 7 are Fri Oct 8, Tue Oct 12, Wed Oct 13 (Mon Oct 11, 2027 Columbus Day) — the spec's "Oct 12" counts only two; the calendar-correct engine value is asserted (reported as a discrepancy).
  assert.equal(exceptionResolutionDue(D("2027-10-07")), D("2027-10-13"));
  const MI_POLICY = { id: "mip-15", company: "Radian", certificate: "RAD-000015", coverage_pct: "25" };
  const fix = proposeExceptionCorrection({ exception: { code: "REO-MI-01", text: "MI company mismatch", overridable: false }, raised_on: D("2027-10-07"), p360_value: "MGIC", mi_policy: MI_POLICY, confirmed_on: D("2027-10-06") });
  assert.deepEqual([fix.field, fix.p360_value, fix.proposed_value, fix.action, fix.resolution_due, fix.escalation], ["mi_company", "MGIC", "Radian", "edit_in_p360", D("2027-10-13"), null]);
  assert.deepEqual(fix.evidence, { source: "mi_policies", mi_policy_id: "mip-15", company: "Radian", certificate: "RAD-000015", coverage_pct: "25" });
  assert.equal(proposeExceptionCorrection({ exception: { code: "REO-MI-01", text: "MI company mismatch", overridable: true, attempts: 1 }, raised_on: D("2027-10-14"), p360_value: "MGIC", mi_policy: MI_POLICY, confirmed_on: D("2027-10-06") }).action, "edit_in_p360");             // Oct 14 is the last day of the 5-BD edit window (Oct 7, 8, 12, 13, 14)
  assert.equal(proposeExceptionCorrection({ exception: { code: "REO-MI-01", text: "MI company mismatch", overridable: true, attempts: 1 }, raised_on: D("2027-10-15"), p360_value: "MGIC", mi_policy: MI_POLICY, confirmed_on: D("2027-10-06") }).action, "override_with_evidence");   // past the window: second (last) override attempt with evidence
  assert.equal(proposeExceptionCorrection({ exception: { code: "REO-MI-01", text: "MI company mismatch", overridable: true, attempts: 2 }, raised_on: D("2027-10-15"), p360_value: "MGIC", mi_policy: MI_POLICY, confirmed_on: D("2027-10-06") }).action, "source_system_correction");   // two attempts used → correct in the source system
  assert.equal(proposeExceptionCorrection({ exception: { code: "REO-MI-01", text: "MI company mismatch" }, raised_on: D("2027-10-07"), p360_value: "MGIC", mi_policy: null }).escalation!.kind, "fnma_portal_operator");
  // Bus: the Exception-queue notification arms the 3-BD clock; the operator's task carries the proposed correction; its resolution satisfies the clock.
  const h = harness(ts("2027-10-07", "07:00"));
  await h.run("parseP360Notification", AGENT, { loan_id: "L15", ...NOTIFICATION("Exception"), received_at: ts("2027-10-07", "07:00"), exception_code: "REO-MI-01", exception_text: "MI company mismatch" });
  const t3 = h.timer("FNMA_E4101_REOGRAM_EXCEPTION_3BD")[0]!; assert.equal(t3.dueDate, "2027-10-13");
  const task = await h.run("openPortalTask", AGENT, { loan_id: "L15", task_type: "p360.reogram.exception", due_at: ts("2027-10-13", "17:00"), p360_case_id: "P360-15", exception_code: "REO-MI-01", proposed_correction: fix });
  assert.deepEqual(h.rt.escalations.opened.find((e) => e.id === task.portal_task_id)!.payload.proposed_correction, fix);
  h.at("2027-10-08", "11:00");
  await h.run("openPortalTask", OPERATOR, { op: "complete", portal_task_id: task.portal_task_id, evidence_document_id: "doc-p360-exception-15" });
  assert.equal(t3.status, "satisfied"); assert.equal(h.events.ofType("reogram.exception.resolved")[0]!.payload.code, "REO-MI-01");
});
test("15.1-T5: Given the TPS example (bid $270,000 paid Oct 5), then 311 = $262,952.26 settles by Oct 13, 2027, `servicer_recovery` = $7,047.74, surplus $0, closing statement sent on the remittance date, and the 571 claim balance is $4,172.20.", async () => {
  const adv = unrecoveredAdvances(ADVANCES);
  const tps = thirdPartySale({ ...TPS_INPUT, gross_proceeds_cents: 27000000n, unrecovered_advances_cents: adv.total_cents });
  assert.deepEqual([tps.crs_code, tps.amount_due_fnma_cents, tps.settle_by, tps.instruct_by], ["311", 26295226n, D("2027-10-13"), D("2027-10-12")]);   // Oct 6, 7, 8, 12, 13 (Oct 11 Columbus Day)
  assert.deepEqual([tps.servicer_recovery_cents, tps.surplus_cents, tps.claim_571_advances_cents], [704774n, 0n, 417220n]);
  // Bus: the case records the bidder's final payment (`tps.proceeds.received`, Oct 5) → 5-BD remittance clock; computeTpsSplit persists the F-1-20 figures and books the proceeds; the 311 is capped at the persisted amount; its settlement arms the same-day closing-statement clock; the statement is sent on the remittance date.
  const h = harness(ts("2027-10-05", "15:00"));
  const opened = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "third_party", legal_date: "2027-10-05", successful_bid_cents: 27000000n, bid_type: "third_party" });
  assert.equal(h.timer("FNMA_E3502_TPS_PROCEEDS_5BD").length, 0);
  h.at("2027-10-05", "16:00");
  const paid = await h.run("openReoCase", AGENT, { op: "proceeds_received", tps_case_id: opened.id, kind: "final_payment", received_on: "2027-10-05", gross_proceeds_cents: 27000000n, evidence_document_id: "doc-wire-15" });
  assert.deepEqual([paid.status, paid.remit_due_at, paid.completion_date, paid.receipt.timer], ["proceeds_received", "2027-10-13", "2027-10-05", "FNMA_E3502_TPS_PROCEEDS_5BD"]);
  assert.deepEqual(tpsProceedsReceipt({ kind: "final_payment", received_on: D("2027-10-05"), amount_cents: 27000000n }).remit_due, D("2027-10-13"));
  const five = h.timer("FNMA_E3502_TPS_PROCEEDS_5BD")[0]!; assert.equal(five.dueDate, "2027-10-13");                              // tps.proceeds.received{kind=final_payment} anchored on the receipt
  assert.equal(h.timer("FNMA_E3502_TPS_INSURANCE_CANCEL_14")[0]!.dueDate, "2027-10-19");                                          // TPS completed → insurance cancellation within 14 days
  const split = await h.run("computeTpsSplit", AGENT, { tps_case_id: opened.id, ...TPS_INPUT, note_rate_pct: L15.note_rate_pct, gross_proceeds_cents: 27000000n, advances: ADVANCES });
  assert.deepEqual([split.amount_due_fnma_cents, split.servicer_recovery_cents, split.claim_571_advances_cents, split.waterfall.claim_571_advances_cents], [26295226n, 704774n, 417220n, 417220n]);
  const row = h.rt.store.get("tps_cases", opened.id)!.data;
  assert.deepEqual([row.fnma_total_indebtedness_cents, row.amount_due_fnma_cents, row.servicer_recovery_cents, row.surplus_cents, row.remit_due_at], [26295226n, 26295226n, 704774n, 0n, "2027-10-13"]);
  // Ledger (spec Outputs): Dr custodial_pi_cash Cr fnma_remittance_payable for the amount due; Dr corporate cash Cr escrow_advances for the recovery (taxes, hazard, MI premiums — all escrow-type in the FIFO); no surplus set.
  const sets = h.ctx.ledger.sets(); assert.equal(sets.length, 2); assert.deepEqual(split.ledger_set_ids, sets.map((x) => x.id));
  for (const x of sets) { assert.equal(x.lines.reduce((a, l) => a + l.amountCents, 0n), 0n); assert.ok(x.lines.every((l) => /^15\.1\.F-1-20\./.test(l.ruleRef))); }
  assert.deepEqual(lineSummary(sets[0]!), [["custodial:custodial_pi_cash", 26295226n], ["corporate:fnma_payable", -26295226n]]);
  assert.deepEqual(lineSummary(sets[1]!), [["corporate:corporate_cash", 704774n], ["loan:escrow_advance", -704774n]]);
  assert.equal(h.ctx.ledger.balance({ scope: "corporate", account: "fnma_payable" }), -26295226n);
  const batch = await h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: opened.id });                                  // the cap is the persisted figure
  assert.deepEqual([batch.lines, batch.cap_source, batch.settle_by, batch.status], [[{ code: "311", cents: 26295226n }], "tps_cases.amount_due_fnma_cents", "2027-10-13", "drafted"]);
  assert.equal(five.status, "armed");
  h.at("2027-10-13", "09:00");
  const settled = await h.run("buildCrsBatch", AGENT, { op: "settled", batch_id: batch.id, settled_on: "2027-10-13", bank_reference: "CRS-311-2027-10-13" });
  assert.deepEqual([settled.status, settled.settled_codes, five.status], ["settled", ["311"], "satisfied"]);
  assert.deepEqual(h.events.ofType("remittance.special.settled").map((e) => [e.payload.code, e.payload.kind, e.payload.settled_on]), [["311", "tps_proceeds", "2027-10-13"]]);
  assert.deepEqual([h.rt.store.get("tps_cases", opened.id)!.data.status, h.rt.store.get("tps_cases", opened.id)!.data.crs_batch_id], ["remitted", batch.id]);
  const same = h.timer("FNMA_F108_TPS_CLOSING_STMT_SAME_DAY")[0]!; assert.equal(same.dueDate, "2027-10-13");                       // armed by the 311 settlement on its remittance date
  const stmt = await h.run("draftClosingStatement", AGENT, { op: "send", loan_id: "L15", tps_case_id: opened.id, ...TPS_INPUT, gross_proceeds_cents: 27000000n, unrecovered_advances_cents: adv.total_cents, remitted_on: settled.settled_on });
  assert.deepEqual([stmt.recipient, stmt.send_by, stmt.on_time, stmt.sent, stmt.timer], ["sf_cpm", "2027-10-13", true, true, "FNMA_F108_TPS_CLOSING_STMT_SAME_DAY"]); assert.equal(stmt.send_by, tps.settle_by);
  assert.deepEqual([stmt.breakdown.principal_cents, stmt.breakdown.interest_cents, stmt.breakdown.advances_cents, stmt.breakdown.amount_due_fnma_cents, stmt.breakdown.servicer_recovery_cents, stmt.breakdown.surplus_cents], [24908861n, 1386365n, 1121994n, 26295226n, 704774n, 0n]);
  assert.equal(same.status, "satisfied"); assert.equal(h.events.ofType("closing_statement.sent")[0]!.payload.recipient, "sf_cpm");
  assert.equal(h.rt.store.get("documents", stmt.document_id)!.data.kind, "closing_statement"); assert.equal(h.rt.store.get("tps_cases", opened.id)!.data.closing_statement_sent_at, h.clock.now());
  const pure = await h.run("computeTpsSplit", AGENT, { ...TPS_INPUT, note_rate_pct: L15.note_rate_pct, gross_proceeds_cents: 27000000n, advances: ADVANCES });   // without a case: the calculation alone, nothing booked
  assert.deepEqual([pure.amount_due_fnma_cents, pure.servicer_recovery_cents, pure.claim_571_advances_cents, pure.tps_case_id, h.ctx.ledger.sets().length], [26295226n, 704774n, 417220n, undefined, 2]);
});
test("15.1-T6: Given a bid of $280,000, then surplus = $5,827.80 is routed per `jurisdiction_rules` and never remitted to Fannie Mae.", async () => {
  const adv = unrecoveredAdvances(ADVANCES);
  const big = thirdPartySale({ ...TPS_INPUT, gross_proceeds_cents: 28000000n, unrecovered_advances_cents: adv.total_cents });
  assert.deepEqual([big.amount_due_fnma_cents, big.servicer_recovery_cents, big.surplus_cents, big.claim_571_advances_cents], [26295226n, 1121994n, 582780n, 0n]);
  const route = surplusDisposition({ surplus_cents: big.surplus_cents, jurisdiction_rules: { state: "TX", surplus_order: ["junior_lien", "borrower"] }, junior_liens_present: true });
  assert.deepEqual([route.disposition, route.cents, route.remitted_to_fnma_cents], ["junior_lien", 582780n, 0n]);
  assert.equal(surplusDisposition({ surplus_cents: big.surplus_cents, jurisdiction_rules: { state: "TX", surplus_order: ["junior_lien", "borrower"] }, junior_liens_present: false }).disposition, "borrower");
  assert.equal(surplusDisposition({ surplus_cents: big.surplus_cents, jurisdiction_rules: { state: "OH", court_registry_required: true }, junior_liens_present: true }).disposition, "court_registry");
  // Never remitted to Fannie Mae: the 311 is capped at the amount_due_fnma persisted on tps_cases — not at a figure the caller supplies — and in the line builder; the surplus is booked to surplus payable, never to fnma_payable.
  const h = harness(ts("2027-10-06", "09:00"));
  const opened = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "third_party", legal_date: "2027-10-05", successful_bid_cents: 28000000n, final_payment_received_at: "2027-10-05", bid_type: "third_party" });
  assert.deepEqual([opened.status, opened.gross_proceeds_cents, h.timer("FNMA_E3502_TPS_PROCEEDS_5BD")[0]!.dueDate], ["proceeds_received", 28000000n, "2027-10-13"]);
  await assert.rejects(h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: opened.id, amount_due_fnma_cents: 26295226n }), refused("REMIT_CAP_AMOUNT_DUE", /run computeTpsSplit/));   // no persisted figure yet: the caller's number is not a cap
  const split = await h.run("computeTpsSplit", AGENT, { tps_case_id: opened.id, ...TPS_INPUT, gross_proceeds_cents: 28000000n, advances: ADVANCES, jurisdiction_rules: { state: "TX", surplus_order: ["junior_lien", "borrower"] }, junior_liens_present: true });
  assert.deepEqual([split.surplus_cents, split.surplus_disposition.disposition, split.surplus_disposition.remitted_to_fnma_cents], [582780n, "junior_lien", 0n]);
  assert.deepEqual([h.rt.store.get("tps_cases", opened.id)!.data.amount_due_fnma_cents, h.rt.store.get("tps_cases", opened.id)!.data.surplus_cents, h.rt.store.get("tps_cases", opened.id)!.data.surplus_disposition], [26295226n, 582780n, "junior_lien"]);
  const sets = h.ctx.ledger.sets(); assert.equal(sets.length, 3);
  assert.deepEqual(lineSummary(sets[0]!), [["custodial:custodial_pi_cash", 26295226n], ["corporate:fnma_payable", -26295226n]]);
  assert.deepEqual(lineSummary(sets[1]!), [["corporate:corporate_cash", 1121994n], ["loan:escrow_advance", -763994n], ["loan:corporate_advance", -358000n]]);   // taxes + hazard + MI = $7,639.94 escrow; inspections + preservation + attorney + costs = $3,580.00 corporate
  assert.deepEqual(lineSummary(sets[2]!), [["custodial:custodial_pi_cash", 582780n], ["loan:suspense_unapplied", -582780n]]);                              // surplus payable (per applicable law)
  assert.equal(h.ctx.ledger.balance({ scope: "corporate", account: "fnma_payable" }), -26295226n);                                                        // Fannie Mae is owed exactly amount_due_fnma
  assert.deepEqual(tpsProceedsLedgerSets({ loan_id: "L15", custodial_account_id: "custodial-pi", effective_date: D("2027-10-05"), amount_due_fnma_cents: 26295226n, servicer_recovery_cents: 0n, surplus_cents: 0n }).length, 1);
  await assert.rejects(h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: opened.id, remit_cents: 28000000n }), refused("REMIT_CAP_AMOUNT_DUE", /REMIT_EXCEEDS_AMOUNT_DUE/));
  await assert.rejects(h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: opened.id, amount_due_fnma_cents: 28000000n }), refused("REMIT_CAP_AMOUNT_DUE", /≠ tps_cases amount_due_fnma_cents 26295226/));   // an inflated caller figure never becomes the cap
  await assert.rejects(h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: opened.id, amount_due_fnma_cents: 28000000n, remit_cents: 28000000n }), refused("REMIT_CAP_AMOUNT_DUE"));
  assert.match(crsBatchLines({ amount_due_fnma_cents: big.amount_due_fnma_cents, remit_cents: big.amount_due_fnma_cents + big.surplus_cents }).refusal!, /REMIT_EXCEEDS_AMOUNT_DUE/);
  const ok = await h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: opened.id });
  assert.deepEqual([ok.lines, ok.cap_cents], [[{ code: "311", cents: 26295226n }], "26295226"]);
});
test("15.1-T7: Given the bidder defaults and the failure is discovered Oct 20, then the $27,000 deposit is remitted (311) by Oct 27, 2027 and the foreclosure case reopens.", async () => {
  const h = harness(ts("2027-10-05", "16:00"));
  const tps = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "third_party", legal_date: "2027-10-05", successful_bid_cents: 27000000n, deposit_cents: 2700000n, deposit_received_at: "2027-10-05", bid_type: "third_party" });
  assert.equal(larCode("third_party", true), "71"); assert.deepEqual([tps.action_code, tps.sale_date, tps.successful_bid_cents, tps.deposit_cents, tps.status], ["71", "2027-10-05", 27000000n, 2700000n, "sale_reported"]);
  h.at("2027-10-20", "10:00");
  const failed = await h.run("openReoCase", AGENT, { op: "sale_failed", loan_id: "L15", tps_case_id: tps.id, discovered_on: "2027-10-20", deposit_cents: 2700000n });
  assert.equal(failed.deposit_remit_due, "2027-10-27"); assert.equal(failedSaleDepositDue(D("2027-10-20")), D("2027-10-27"));       // Oct 21, 22, 25, 26, 27
  assert.deepEqual(failed.crs, { code: "311", cents: 2700000n, kind: "tps_deposit" }); assert.deepEqual([failed.tps_status, failed.foreclosure_case.status], ["sale_failed", "reopened"]);
  assert.equal(h.rt.store.get("tps_cases", tps.id)!.data.status, "sale_failed");
  assert.equal(h.events.ofType("foreclosure.case.reopened")[0]!.payload.reason, "tps_sale_failed");
  const dep = h.timer("FNMA_E3502_TPS_FAILED_DEPOSIT_5BD")[0]!; assert.equal(dep.dueDate, "2027-10-27");
  const batch = await h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: tps.id, kind: "tps_deposit" });                 // capped at the deposit on the record
  assert.deepEqual([batch.lines, batch.cap_source, batch.settle_by], [[{ code: "311", cents: 2700000n }], "tps_cases.deposit_cents", "2027-10-27"]);
  await assert.rejects(h.run("buildCrsBatch", AGENT, { loan_id: "L15", tps_case_id: tps.id, kind: "tps_deposit", remit_cents: 2700001n }), refused("REMIT_CAP_AMOUNT_DUE"));
  h.at("2027-10-26", "10:00");
  await h.run("buildCrsBatch", AGENT, { op: "settled", batch_id: batch.id, settled_on: "2027-10-26" });
  assert.equal(dep.status, "satisfied");                                                                                             // remittance.special.settled{code=311, kind=tps_deposit} from the batch's own kind
  assert.deepEqual(h.events.ofType("remittance.special.settled").map((e) => [e.payload.code, e.payload.kind]), [["311", "tps_deposit"]]);
  assert.deepEqual([h.rt.store.get("tps_cases", tps.id)!.data.status, h.rt.store.get("tps_cases", tps.id)!.data.deposit_remitted_at], ["sale_failed", h.clock.now()]);
});
test("15.1-T8: Given a sale in the servicer's name on Oct 5, then `deed_record_due` = Oct 6 and the firm's e-recording confirmation satisfies `FNMA_E4201_DEED_RECORD_NEXT_DAY`.", async () => {
  assert.deepEqual(deedRecordDueRolled(D("2027-10-05"), "servicer"), { due: D("2027-10-06"), task: "record_deed", rolled: false });
  assert.deepEqual(deedRecordDue(D("2027-10-05"), "servicer"), { due: D("2027-10-06"), task: "record_deed" });
  // Recorder closed: a Friday Oct 8 sale rolls past the weekend and Columbus Day to Tue Oct 12 — calculator and timer row agree.
  assert.deepEqual(deedRecordDueRolled(D("2027-10-08"), "servicer"), { due: D("2027-10-12"), task: "record_deed", rolled: true });
  assert.equal(computeDue(loadOverriddenRegistry().get("FNMA_E4201_DEED_RECORD_NEXT_DAY")!.offsetParsed, D("2027-10-08"), zonedEpochMs(D("2027-10-08"), "12:00", ET)).dueDate, "2027-10-12");
  const h = harness(ts("2027-10-05", "15:00"));
  // The sale in the servicer's name opens the REO case (`reo.case.opened{foreclosed_in_name_of=servicer}`) — that is what arms the next-day deed clock and the 30-day marketable-title clock.
  const opened = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "fnma", insured: false, legal_date: "2027-10-05", foreclosed_in_name_of: "servicer" });
  assert.deepEqual([opened.deed_record_due, opened.foreclosed_in_name_of, h.events.ofType("reo.case.opened")[0]!.payload.foreclosed_in_name_of], ["2027-10-06", "servicer", "servicer"]);
  const deed = h.timer("FNMA_E4201_DEED_RECORD_NEXT_DAY")[0]!; assert.equal(deed.dueDate, "2027-10-06");
  const title = h.timer("SM_TITLE_MARKETABLE_30")[0]!; assert.equal(title.dueDate, "2027-11-04");
  const tasks = await h.run("scheduleHandoffTasks", AGENT, { loan_id: "L15", reo_case_id: opened.id, legal_date: "2027-10-05", acquisition: "fnma", foreclosed_in_name_of: "servicer" });
  const byKind = Object.fromEntries(tasks.map((t: { kind: string }) => [t.kind, t]));
  assert.deepEqual([byKind.deed_record.due_at, byKind.deed_record.owner, byKind.deed_record.timer], ["2027-10-06", "attorney", "FNMA_E4201_DEED_RECORD_NEXT_DAY"]);
  assert.deepEqual([byKind.title_curative.due_at, byKind.title_curative.timer], ["2027-11-04", "SM_TITLE_MARKETABLE_30"]);
  assert.equal(h.events.ofType("preservation.stop_work")[0]!.payload.gate, "FNMA_E4301_PRESERVATION_STOP");
  // The firm's e-recording confirmation satisfies the deed clock.
  h.at("2027-10-06", "11:30");
  const done = await h.run("scheduleHandoffTasks", AGENT, { op: "complete", loan_id: "L15", reo_case_id: opened.id, kind: "deed_record", evidence_document_id: "doc-erecording-EREC-778", confirmation_id: "EREC-778", submitted_on: "2027-10-06" });
  assert.equal(done.event, "deed.submitted_for_recording"); assert.equal(deed.status, "satisfied"); assert.equal(h.events.ofType("deed.submitted_for_recording")[0]!.payload.confirmation_id, "EREC-778");
  assert.equal(h.rt.store.get("reo_cases", opened.id)!.data.deed_submitted_at, "2027-10-06");
  assert.equal(title.status, "armed");
  h.at("2027-10-20", "11:30");
  await h.run("scheduleHandoffTasks", AGENT, { op: "complete", loan_id: "L15", reo_case_id: opened.id, kind: "title_curative", evidence_document_id: "doc-recorded-deed-15", recorded_on: "2027-10-19" });
  assert.equal(title.status, "satisfied");                                                                                    // deed.recorded{title_curative_clear=true}
  // Foreclosed in Fannie Mae's name: no deed clock is armed by the case, the title clock still is.
  const h2 = harness(ts("2027-10-05", "15:00"));
  const fnmaName = await h2.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "fnma", insured: false, legal_date: "2027-10-05", foreclosed_in_name_of: "fnma" });
  assert.deepEqual([fnmaName.deed_record_due, h2.timer("FNMA_E4201_DEED_RECORD_NEXT_DAY").length, h2.timer("SM_TITLE_MARKETABLE_30")[0]!.dueDate], [null, 0, "2027-11-04"]);
  // Foreclosed in Fannie Mae's name (e.g. Texas trustee's deed): no next-day deed, but the 30-day marketable-title task still runs.
  const fn = handoffTasks({ legal_date: D("2027-10-05"), acquisition: "fnma", foreclosed_in_name_of: "fnma", flood_policy: false, lpi_policy: false });
  assert.ok(fn.some((t) => t.kind === "title_curative" && t.timer === "SM_TITLE_MARKETABLE_30" && t.due_at === "2027-11-04")); assert.ok(!fn.some((t) => t.kind === "deed_record"));
});
test("15.1-T9: Given the sale, then hazard and flood cancellation requests exist by Oct 19, 2027; a carrier refusal produces the mortgagee-removal request and a flagged comment for the final claim.", async () => {
  const tasks = handoffTasks({ legal_date: D("2027-10-05"), acquisition: "fnma", foreclosed_in_name_of: "fnma", flood_policy: true, lpi_policy: false });
  assert.deepEqual(tasks.filter((t) => t.kind === "hazard_cancel" || t.kind === "flood_cancel").map((t) => [t.kind, t.due_at, t.timer]), [["hazard_cancel", "2027-10-19", "FNMA_E4401_HAZARD_CANCEL_14"], ["flood_cancel", "2027-10-19", "FNMA_E4403_FLOOD_CANCEL_14"]]);
  assert.equal(insuranceCancellationDue(D("2027-10-05")), D("2027-10-19"));
  const h = harness(ts("2027-10-05", "15:00"));
  // "Given the sale": opening the REO case on it (`reo.case.opened{acquirer=fannie_mae}`, anchored on legal_date) arms both 14-day clocks.
  const opened = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "fnma", insured: true, legal_date: "2027-10-05", foreclosed_in_name_of: "fnma" });
  const hz = h.timer("FNMA_E4401_HAZARD_CANCEL_14")[0]!, fl = h.timer("FNMA_E4403_FLOOD_CANCEL_14")[0]!; assert.deepEqual([hz.dueDate, fl.dueDate, hz.anchorDate], ["2027-10-19", "2027-10-19", "2027-10-05"]);
  h.at("2027-10-12", "10:00");
  const hazard = await h.run("requestInsuranceCancellation", AGENT, { loan_id: "L15", reo_case_id: opened.id, policy_kind: "hazard", policy_id: "HZ-15", legal_date: "2027-10-05" });
  const flood = await h.run("requestInsuranceCancellation", AGENT, { loan_id: "L15", reo_case_id: opened.id, policy_kind: "flood", policy_id: "FL-15", legal_date: "2027-10-05" });
  assert.deepEqual([hazard.kind, hazard.refund_requested, hazard.cancel_as_of, flood.kind, flood.cancel_as_of], ["hazard_cancel", true, "2027-10-05", "flood_cancel", "2027-10-05"]);
  assert.deepEqual([hz.status, fl.status], ["satisfied", "satisfied"]); assert.ok(wallClock(Date.parse(hz.satisfiedAt!), ET).date <= "2027-10-19");
  assert.deepEqual(h.events.ofType("flood.cancellation.requested").map((e) => e.payload.policy_id), ["FL-15"]);
  // A carrier refusal (Fannie Mae not the named insured) → mortgagee-interest removal request and a flagged comment for the final claim (E-4.4-01/02).
  h.at("2027-10-14", "10:00");
  const denied = await h.run("requestInsuranceCancellation", AGENT, { op: "carrier_refused", loan_id: "L15", reo_case_id: opened.id, policy_kind: "hazard", policy_id: "HZ-15", refused_on: "2027-10-14" });
  assert.deepEqual([denied.mortgagee_removal_task.kind, denied.mortgagee_removal_task.due_at, denied.claim_flag.kind, denied.claim_flag.rule, denied.claim_flag.applies_to], ["mortgagee_interest_removal", "2027-10-28", "carrier_refused_refund", "E-4.4-02", "final_expense_claim"]);
  assert.match(denied.claim_flag.comment, /mortgagee-interest removal requested \(E-4\.4-01\)/); assert.match(denied.claim_flag.comment, /state so on the final expense request \(E-4\.4-02\)/);
  assert.equal(h.events.ofType("insurance.mortgagee_removal.requested")[0]!.payload.policy_kind, "hazard"); assert.equal(h.events.ofType("claim.comment.flagged").length, 1);
  assert.equal(carrierRefusal(D("2027-10-14")).task.kind, "mortgagee_interest_removal");
});
test("15.1-T10: Given a bankruptcy stay violation identified Oct 12, then the Elimination/Rescission template task is due Oct 17; on approval Oct 20 10:00 ET the loan is reactivated by Oct 21 10:00 ET and counsel instructed by Oct 22.", async () => {
  const h = harness(ts("2027-10-12", "09:00"));
  const req = await h.run("draftEliminationTemplate", AGENT, { loan_id: "L15", fnma_loan_number: L15.fnma_loan_number, property_address: "15 Fixture Ln, Plano TX 75024", kind: "rescission", reason_code: "bk_stay_violation", reason_text: "petition filed 2027-10-04; sale held 2027-10-05 in violation of the stay (11 U.S.C. §362)", identified_on: "2027-10-12", supporting_document_ids: ["doc-pacer-15"], servicer_caused: true });
  assert.deepEqual([req.submit_due_at, req.template.portal_task_type, req.template.channel, req.owner_role, req.status], ["2027-10-17", "elimination_rescission.submit", "email_excel_template", "fnma_portal_operator", "drafted"]);
  assert.equal(req.fees_nonreimbursable_reason, "e4102_rescission"); assert.equal(refoFeesReimbursable("servicer"), false);
  const five = h.timer("FNMA_E4102_ELIM_RESCISSION_REQUEST_5")[0]!; assert.equal(five.dueDate, "2027-10-17");
  h.at("2027-10-15", "14:00");
  await h.run("openPortalTask", OPERATOR, { op: "complete", portal_task_id: req.portal_task_id, evidence_document_id: "doc-err-template-15" });
  assert.equal(five.status, "satisfied"); assert.equal(h.rt.store.get("elimination_rescission_requests", req.id)!.data.status, "submitted");
  // Approval Wed Oct 20 10:00 ET → reactivate by Thu Oct 21 10:00 ET; counsel instructed by Fri Oct 22.
  h.at("2027-10-20", "10:00");
  const approved = await h.run("draftEliminationTemplate", AGENT, { op: "approved", loan_id: "L15", request_id: req.id, approved_at: ts("2027-10-20", "10:00") });
  assert.deepEqual([approved.reintegrate_due_at, approved.title_steps_due_at, approved.status], [ts("2027-10-21", "10:00"), "2027-10-22", "approved"]);
  const c = rescissionClocks(D("2027-10-12"), zonedEpochMs(D("2027-10-20"), "10:00", ET)); assert.equal(c.template_due, D("2027-10-17")); assert.deepEqual([wallClock(c.reactivate_by_ms!, ET).date, wallClock(c.reactivate_by_ms!, ET).hour], ["2027-10-21", 10]); assert.equal(c.counsel_by, D("2027-10-22"));
  const re = h.timer("FNMA_E4102_REINTEGRATE_24H")[0]!, ti = h.timer("FNMA_E4102_TITLE_RESTORE_2")[0]!;
  assert.equal(toIso(re.dueAt!), ts("2027-10-21", "10:00")); assert.equal(ti.dueDate, "2027-10-22");
  const att = h.rt.escalations.opened.find((e) => e.id === approved.attorney_escalation_id)!;
  assert.deepEqual([att.kind, att.ownerRole, att.payload.instruction, att.payload.due], ["attorney", "attorney", "TITLE_RESTORATION", "2027-10-22"]);
  assert.deepEqual([re.status, ti.status], ["armed", "armed"]);                                                               // the approval arms both clocks; nothing is satisfied in the same command
  h.at("2027-10-21", "09:00");
  const re_ = await h.run("draftEliminationTemplate", AGENT, { op: "reactivated", request_id: req.id, lar_removal_accepted: true, action_code: "72" });
  assert.equal(re.status, "satisfied");                                                                                       // loan.reactivated within 24 h
  const back = h.events.ofType("loan.reactivated")[0]!.payload;
  assert.deepEqual([back.sda_status, back.escrow, back.statements, back.cases_reopened, back.reo_case_status, back.readd_request], ["resumed", "resumed", "resumed", ["delinquency", "foreclosure"], "rescinded", "readd_requests@fanniemae.com"]);
  assert.deepEqual([h.events.ofType("sda_status.resumed").length, h.events.ofType("delinquency.case.reopened")[0]!.payload.reason, h.events.ofType("foreclosure.case.reopened")[0]!.payload.refo_fees_reimbursable], [1, "e4102_rescission", false]);
  const readd = h.rt.escalations.opened.find((e) => e.id === re_.readd_portal_task_id)!;                                     // 5.x re-add via readd_requests@fanniemae.com — the LAR 72 removal was accepted
  assert.deepEqual([readd.kind, readd.ownerRole, readd.payload.task_type, readd.payload.mailbox, h.rt.store.get("portal_tasks", readd.id)!.data.status], ["human_portal_task", "fnma_portal_operator", "fnma.readd_request.email", "readd_requests@fanniemae.com", "open"]);
  assert.deepEqual(rescissionReactivation({ lar_removal_accepted: false }).readd_request.required, false);
  assert.equal(ti.status, "armed");
  h.at("2027-10-21", "16:00");
  await h.run("draftEliminationTemplate", AGENT, { op: "instruct_counsel", request_id: req.id, instruction_document_id: "doc-title-restoration-instruction-15" });
  assert.equal(ti.status, "satisfied");                                                                                       // attorney.instruction.sent{kind=TITLE_RESTORATION} by Oct 22
  assert.deepEqual([h.events.ofType("attorney.instruction.sent")[0]!.payload.kind, h.rt.store.get("elimination_rescission_requests", req.id)!.data.status], ["TITLE_RESTORATION", "reactivated"]);
  // Counsel not instructed by Oct 22 → the 2-day clock breaches to the attorney, and a late instruction closes it late.
  const h2 = harness(ts("2027-10-12", "09:00"));
  const req2 = await h2.run("draftEliminationTemplate", AGENT, { loan_id: "L15", fnma_loan_number: L15.fnma_loan_number, property_address: "15 Fixture Ln, Plano TX 75024", kind: "rescission", reason_code: "bk_stay_violation", reason_text: "stay violation", identified_on: "2027-10-12", servicer_caused: true });
  h2.at("2027-10-20", "10:00"); await h2.run("draftEliminationTemplate", AGENT, { op: "approved", request_id: req2.id, approved_at: ts("2027-10-20", "10:00") });
  const ti2 = h2.timer("FNMA_E4102_TITLE_RESTORE_2")[0]!; h2.at("2027-10-23", "09:00"); h2.timers.evaluate(h2.clock.now()); assert.equal(ti2.status, "breached");
  await h2.run("draftEliminationTemplate", AGENT, { op: "instruct_counsel", request_id: req2.id, instruction_document_id: "doc-late-instruction-15" }); assert.equal(ti2.status, "satisfied_late");
});
test("15.1-T11: Given `properties.resale_restriction = 'clt'` with no notice evidence, then the confirmation task is blocked and an `attorney` escalation opens before the 1-BD deadline.", async () => {
  const h = harness(ts("2027-10-06", "09:10"));
  // `properties.resale_restriction = 'clt'` is on the property record — the package and the gate read it there, whatever the caller says.
  h.rt.store.put("properties", "prop-15", { loan_id: "L15", resale_restriction: "clt", address: PROPERTY.address }, SYSTEM, h.clock.now());
  const pkg = await h.run("buildReogramPackage", AGENT, { ...PKG_INPUT, resale_restriction: "none", resale_notice_evidence: false, notification_received_at: ts("2027-10-06", "09:10") });
  assert.equal(pkg.blocked, true); assert.deepEqual(pkg.attestation.missing, ["notices_provided", "compliance_with_restriction_agreement", "termination_actions_completed"]);
  assert.deepEqual([pkg.fields.resale_restriction, pkg.fact_sources], ["clt", ["properties"]]);
  const esc = h.rt.escalations.opened.find((e) => e.id === pkg.escalation.id)!;
  assert.deepEqual([esc.kind, esc.ownerRole, esc.payload.gate], ["attorney", "attorney", "SM_RESALE_RESTRICTION_NOTICES"]);
  // … opened before the 1-BD deadline (Thu Oct 7 17:00 ET): review requested at deadline − 4 h.
  assert.deepEqual([pkg.escalation.confirm_due_at, pkg.escalation.request_at, pkg.escalation.before_deadline], [ts("2027-10-07", "17:00"), ts("2027-10-07", "13:00"), true]);
  assert.equal(h.events.ofType("reogram.confirmation.blocked")[0]!.payload.gate, "SM_RESALE_RESTRICTION_NOTICES");
  // The confirmation task is blocked — the guardrail evaluates the gate from the package's facts …
  await assert.rejects(h.run("openPortalTask", AGENT, { loan_id: "L15", task_type: "p360.reogram.confirm", package: pkg.fields }), (e: unknown) => e instanceof CommandRefused && e.code === "REOGRAM_CONFIRM_GATES" && /SM_RESALE_RESTRICTION_NOTICES/.test(e.message));
  // … and by omission: a task with no facts at all is not an open gate.
  await assert.rejects(h.run("openPortalTask", AGENT, { loan_id: "L15", task_type: "p360.reogram.confirm" }), (e: unknown) => e instanceof CommandRefused && e.code === "REOGRAM_CONFIRM_GATES");
  // … and the records decide, not the caller: facts that contradict `properties.resale_restriction` are refused, with the same code, before any task opens.
  await assert.rejects(h.run("openPortalTask", AGENT, { loan_id: "L15", task_type: "p360.reogram.confirm", facts: { resale_restriction: "none", mi_indicator: false } }), refused("REOGRAM_CONFIRM_GATES", /contradict the records \(resale_restriction: supplied none ≠ properties clt\)/));
  assert.deepEqual(gateFactsFromRecords({ supplied: { resale_restriction: "none" }, property: { resale_restriction: "clt" }, mi_policy: null, package: null }).conflicts, ["resale_restriction: supplied none ≠ properties clt"]);
  assert.equal(h.rt.escalations.opened.filter((e) => e.kind === "human_portal_task").length, 0);
  // Notices alone are not the E-4.1-01 representation; all three evidences plus the MI data open the gate.
  assert.equal(reogramConfirmGate({ resale_restriction: "clt", resale_notice_evidence: true, mi_indicator: false }).open, false);
  assert.match(reogramConfirmGate({ resale_restriction: "none", mi_indicator: true }).reason!, /MI_DATA_CHECK/);
  assert.equal(reogramConfirmGate({ resale_restriction: "clt", resale_notice_evidence: true, restriction_agreement_complied: true, termination_actions_completed: true, mi_indicator: true, mi_company: "Radian", mi_certificate: "RAD-000015", mi_coverage_pct: "25" }).open, true);
  assert.deepEqual(resaleRestrictionGate("clt", false), { blocked: true, escalate: "attorney" });
  const cleared = await h.run("buildReogramPackage", AGENT, { ...PKG_INPUT, resale_restriction: "clt", resale_notice_evidence: true, restriction_agreement_complied: true, termination_actions_completed: true, notification_received_at: ts("2027-10-06", "09:10") });
  assert.deepEqual([cleared.blocked, cleared.escalation, cleared.fields.resale_restriction_attestation], [false, null, { restriction: "clt", notices_provided: true, compliance_with_restriction_agreement: true, termination_actions_completed: true }]);
  const task = await h.run("openPortalTask", AGENT, { loan_id: "L15", task_type: "p360.reogram.confirm", package: cleared.fields, due_at: cleared.confirm_due_at.at });
  assert.deepEqual([h.rt.escalations.opened.find((e) => e.id === task.portal_task_id)!.kind, task.fact_sources], ["human_portal_task", ["properties"]]);
  // Completion re-gates on the records: an MI policy that no longer matches the package (certificate blank in mi_policies) stops the operator's click.
  h.rt.store.put("mi_policies", "L15", { loan_id: "L15", status: "active", company: "Radian", certificate: "", coverage_pct: "25" }, SYSTEM, h.clock.now());
  await assert.rejects(h.run("openPortalTask", OPERATOR, { op: "complete", portal_task_id: task.portal_task_id, evidence_document_id: "doc-p360-export-15" }), refused("REOGRAM_CONFIRM_GATES", /mi_certificate/));
  assert.equal(h.rt.escalations.opened.find((e) => e.id === task.portal_task_id)!.status, "open");
});
test("15.1-T12: Given `investor_reporting.liquidation.mode = event` in CIT, then the REO liquidation event JSON is produced in `api-clve` and the REOgram task is still created until the flag `p360.reogram.subsumed` is on.", async () => {
  // L15 credit-bid acquisition (MI-insured → LAR 72), liquidation processed Wed Oct 6, 2027 10:00 ET after LAR acceptance.
  const interest = ptrInterest(L15.upb_cents, L15.ptr_pct, L15.lpi_due, L15.sale_on).cents;
  const facts = { kind: "foreclosure_fnma_acquires", insured: "mi", principal_cents: L15.upb_cents, interest_cents: interest, legal_date: L15.sale_on, fnma_loan_number: L15.fnma_loan_number, processed_at_ms: zonedEpochMs(D("2027-10-06"), "10:00", ET) } as const;

  const cit = liquidationRail({ ...facts, mode: "event", cit: true, reogram_subsumed: false });
  assert.equal(cit.rail, "event"); assert.equal(cit.env, "api-clve"); assert.equal(cit.lar_sent, false); assert.equal(cit.lar, null);
  assert.ok(cit.p360_event); assert.equal(cit.p360_event["Liquidation Event Type"], "REO"); assert.equal(cit.p360_event["Liquidation Action Code"], "72");
  assert.equal(cit.p360_event["Liquidation Effective Date"], "2027-10-05"); assert.equal(cit.p360_event["Principal Amount"], "249088.61"); assert.equal(cit.p360_event["Loan Identifier"], "1234567890");
  // 5.3's code-only projection sends code 72 as "Government Conveyance"; an MI-insured conventional acquisition is Fannie Mae REO — the disagreement is surfaced in the diff, never rewritten silently.
  assert.deepEqual(cit.diff, ["event_type"]); assert.equal(cit.event_type_5_3, "Government Conveyance");
  const uninsured = liquidationRail({ ...facts, insured: "none", mode: "event", cit: true, reogram_subsumed: false });
  assert.deepEqual([uninsured.p360_event?.["Liquidation Action Code"], uninsured.p360_event?.["Liquidation Event Type"], uninsured.diff], ["70", "REO", []]);
  // FNMA_LL202605_LIQ_EVENT_NEXTBD: next fannie_et BD at 03:00 ET → Thu Oct 7, 2027 03:00 ET.
  const due = wallClock(cit.event_due_ms!, ET); assert.deepEqual([due.date, due.hour, due.minute], ["2027-10-07", 3, 0]);
  // The REOgram confirmation task is still created under the event rail …
  assert.equal(cit.reogram_task, true);
  // … until Fannie Mae confirms the round-trip is subsumed (`p360.reogram.subsumed`).
  assert.equal(liquidationRail({ ...facts, mode: "event", cit: true, reogram_subsumed: true }).reogram_task, false);
  // Legacy rail: LAR 72 only, no event JSON, REOgram task as today; dual: both projections diffed field by field.
  const legacy = liquidationRail({ ...facts, mode: "legacy", cit: false, reogram_subsumed: false });
  assert.deepEqual([legacy.rail, legacy.lar_sent, legacy.lar?.action_code, legacy.p360_event, legacy.env, legacy.reogram_task, legacy.event_due_ms, legacy.diff], ["lar", true, "72", null, null, true, null, []]);
  const dual = liquidationRail({ ...facts, mode: "dual", cit: true, reogram_subsumed: false });
  assert.deepEqual([dual.rail, dual.lar_sent, dual.lar?.action_code, dual.p360_event?.["Liquidation Event Type"], dual.env, dual.diff], ["dual", true, "72", "REO", "api-clve", ["event_type"]]);
  // Event-type mapping: conventional (uninsured or MI) acquisitions are REO; only FHA/VA conveyances are Government Conveyance; bidders are Third-Party Sale.
  assert.equal(liquidationEventType("foreclosure_fnma_acquires", "none"), "REO"); assert.equal(liquidationEventType("foreclosure_fnma_acquires", "fha"), "Government Conveyance"); assert.equal(liquidationEventType("third_party_sale", "none"), "Third-Party Sale");
  assert.deepEqual(liquidationRail({ ...facts, insured: "fha", mode: "event", cit: true, reogram_subsumed: false }).diff, []);
  assert.equal(liquidationRail({ ...facts, kind: "third_party_sale", insured: "none", mode: "event", cit: true, reogram_subsumed: false }).reogram_task, false);
  // Bus: 5.3's `liquidation_facts.processed` (Wed Oct 6 10:00 ET) arms FNMA_LL202605_LIQ_EVENT_NEXTBD for Thu Oct 7 03:00 ET; the rail projects the event to api-clve and Property 360's acceptance (fnma-servicing-events acknowledgment) satisfies it.
  const h = harness(ts("2027-10-06", "10:00"));
  h.events.append({ type: "liquidation_facts.processed", loanId: "L15", actor: SYSTEM, payload: { processed_at: ts("2027-10-06", "10:00"), kind: "foreclosure_fnma_acquires", action_code: "72" } });
  const ev = h.timer("FNMA_LL202605_LIQ_EVENT_NEXTBD")[0]!; assert.equal(toIso(ev.dueAt!), ts("2027-10-07", "03:00"));
  const rail = await h.run("openReoCase", AGENT, { op: "liquidation_rail", loan_id: "L15", mode: "event", cit: true, reogram_subsumed: false, kind: "foreclosure_fnma_acquires", insured: "mi", principal_cents: L15.upb_cents, interest_cents: interest, legal_date: "2027-10-05", fnma_loan_number: L15.fnma_loan_number, processed_at: ts("2027-10-06", "10:00") });
  assert.deepEqual([rail.rail, rail.env, rail.p360_event["Liquidation Event Type"], rail.reogram_task, rail.event_due_at, rail.lar], ["event", "api-clve", "REO", true, ts("2027-10-07", "03:00"), null]);
  assert.deepEqual(h.events.ofType("fnma.liquidation_event.projected").map((e) => [e.payload.env, e.payload.event_type, e.payload.action_code]), [["api-clve", "REO", "72"]]);
  h.at("2027-10-06", "23:30");
  await h.run("openReoCase", AGENT, { op: "liquidation_event_accepted", loan_id: "L15", fnma_loan_number: L15.fnma_loan_number, accepted_at: ts("2027-10-06", "23:30"), event_type: "REO", acknowledgment_id: "SE-ACK-15" });
  assert.equal(ev.status, "satisfied"); assert.equal(h.events.ofType("fnma.liquidation_event.accepted")[0]!.payload.env, "api-clve");
});

test("15.1 handoff requests, PTFA and the preservation guardrail: eviction documents and recovery-firm information within 3 BD of the request; a bona fide tenant's 90-day notice on the servicer-counsel path; no post-sale preservation on Fannie Mae-acquired property except an SF CPM-directed emergency order (non-reimbursable)", async () => {
  const h = harness(ts("2027-10-13", "09:00"));
  const opened = await h.run("openReoCase", AGENT, { loan_id: "L15", purchaser: "fnma", insured: true, legal_date: "2027-10-05", foreclosed_in_name_of: "fnma" });
  // E-4.3-04 / E-4.4-01: requests received Wed Oct 13 → documents by Mon Oct 18 (3 BD).
  const [ev] = await h.run("scheduleHandoffTasks", AGENT, { op: "request", loan_id: "L15", reo_case_id: opened.id, requested_kind: "eviction_docs", requested_on: "2027-10-13", requested_by: "fnma_eviction_counsel" });
  const [rf] = await h.run("scheduleHandoffTasks", AGENT, { op: "request", loan_id: "L15", reo_case_id: opened.id, requested_kind: "recovery_firm_info", requested_on: "2027-10-13", requested_by: "property_recovery_firm" });
  assert.deepEqual([ev.due_at, ev.owner, ev.timer, rf.due_at, rf.owner, rf.timer], ["2027-10-18", "attorney", "FNMA_E4304_EVICTION_DOCS_3BD", "2027-10-18", "agent", "FNMA_E4401_RECOVERY_FIRM_INFO_3BD"]);
  const evT = h.timer("FNMA_E4304_EVICTION_DOCS_3BD")[0]!, rfT = h.timer("FNMA_E4401_RECOVERY_FIRM_INFO_3BD")[0]!; assert.deepEqual([evT.dueDate, rfT.dueDate], ["2027-10-18", "2027-10-18"]);
  h.at("2027-10-14", "15:00");
  const docs = await h.run("scheduleHandoffTasks", AGENT, { op: "complete", loan_id: "L15", reo_case_id: opened.id, kind: "eviction_docs", evidence_document_id: "doc-notice-to-vacate-pack-15" });
  const info = await h.run("scheduleHandoffTasks", AGENT, { op: "complete", loan_id: "L15", reo_case_id: opened.id, kind: "recovery_firm_info", evidence_document_id: "doc-policy-inspection-pack-15" });
  assert.deepEqual([docs.event, info.event, evT.status, rfT.status], ["fnma.request.fulfilled", "fnma.request.fulfilled", "satisfied", "satisfied"]);
  assert.deepEqual(h.events.ofType("fnma.request.fulfilled").map((e) => e.payload.kind), ["eviction_documents", "property_recovery"]);
  // PTFA: a bona fide tenant identified Oct 14 on the servicer-counsel path, vacate date Feb 1, 2028 → notice served by Nov 3, 2027 (90 calendar days before).
  const tenant = await h.run("scheduleHandoffTasks", AGENT, { op: "tenant_identified", loan_id: "L15", reo_case_id: opened.id, identified_on: "2027-10-14", bona_fide: true, servicer_counsel_path: true, vacate_date: "2028-02-01", lease_end: "2028-01-31" });
  assert.deepEqual([tenant.event, tenant.timer, tenant.notice_serve_by, tenant.occupancy_status, tenant.payload.path], ["property.tenant.identified", "PTFA_TENANT_NOTICE_90", "2027-11-03", "tenant_bona_fide", "servicer_counsel"]);
  assert.deepEqual(tenantIdentified({ bona_fide: true, vacate_date: D("2028-02-01"), servicer_counsel_path: true }).notice_serve_by, D("2027-11-03"));
  const ptfa = h.timer("PTFA_TENANT_NOTICE_90")[0]!; assert.deepEqual([ptfa.dueDate, ptfa.anchorDate, h.rt.store.get("reo_cases", opened.id)!.data.occupancy_status], ["2027-11-03", "2028-02-01", "tenant_bona_fide"]);
  h.at("2027-10-20", "10:00");
  await h.run("scheduleHandoffTasks", AGENT, { op: "complete", loan_id: "L15", reo_case_id: opened.id, kind: "eviction_docs", evidence_document_id: "doc-ptfa-notice-15", ptfa_notice_served_on: "2027-10-20", vacate_date: "2028-02-01" });
  assert.equal(ptfa.status, "satisfied"); assert.deepEqual([h.events.ofType("tenant.notice.served")[0]!.payload.kind, h.events.ofType("tenant.notice.served")[0]!.payload.lease_honored], ["ptfa_90_day", true]);
  // On Fannie Mae-managed property the tenant information goes to Fannie Mae's eviction counsel — no servicer clock, no lock-out by the servicer.
  const vendor = await h.run("scheduleHandoffTasks", AGENT, { op: "tenant_identified", loan_id: "L15", reo_case_id: opened.id, identified_on: "2027-10-14", bona_fide: true, servicer_counsel_path: false, vacate_date: "2028-02-01" });
  assert.deepEqual([vendor.timer, vendor.payload.path, h.timer("PTFA_TENANT_NOTICE_90").length], [null, "fnma_vendor", 1]);
  // Rule 6 / guardrail: never order preservation after the sale for Fannie Mae-acquired property …
  await assert.rejects(h.run("scheduleHandoffTasks", AGENT, { op: "order_preservation", loan_id: "L15", reo_case_id: opened.id, ordered_on: "2027-10-20", scope: "winterization" }), refused("NO_POST_SALE_PRESERVATION", /ceased at the sale/));
  await assert.rejects(h.run("scheduleHandoffTasks", AGENT, { op: "order_preservation", loan_id: "L15", reo_case_id: opened.id, ordered_on: "2027-10-20", scope: "roof tarp", acquirer: "third_party", tps_completed: true }), refused("NO_POST_SALE_PRESERVATION"));
  // … except an emergency order on SF CPM direction (flagged non-reimbursable) or Matrix preservation on a third-party sale still short of completion.
  const emergency = await h.run("scheduleHandoffTasks", AGENT, { op: "order_preservation", loan_id: "L15", reo_case_id: opened.id, ordered_on: "2027-10-20", scope: "burst pipe — emergency dry-out", sf_cpm_directed: true, sf_cpm_direction_ref: "CPM-2027-1020-15" });
  assert.deepEqual([emergency.allowed, emergency.nonreimbursable, emergency.cpm_issue_report.kind, emergency.cpm_issue_report.nonreimbursable, h.events.ofType("preservation.order.requested")[0]!.payload.sf_cpm_direction_ref], [true, true, "cpm_issue_report", true, "CPM-2027-1020-15"]);
  const matrix = await h.run("scheduleHandoffTasks", AGENT, { op: "order_preservation", loan_id: "L15", reo_case_id: opened.id, ordered_on: "2027-10-20", scope: "lawn", acquirer: "third_party", tps_completed: false });
  assert.deepEqual([matrix.allowed, matrix.nonreimbursable, matrix.cpm_issue_report], [true, false, null]);
  // The gate evaluator refuses by omission: an empty fact bag is not an open gate.
  const gate = EVALUATORS_15_1["15.1.postSalePreservationAllowed"]!;
  assert.deepEqual([gate({}).open, gate({ sale_completed: true }).open, gate({ sale_completed: true, acquirer: "fannie_mae" }).open, gate({ sale_completed: true, acquirer: "fannie_mae", sf_cpm_directed: true }).open, gate({ sale_completed: false }).open, gate({ sale_completed: true, acquirer: "third_party", tps_completed: false }).open], [false, false, false, true, true, true]);
});

test("15.1 worked figures: UPB $249,088.61 at PTR 6.00% → $1,245.44/month, $40.946/day; 11 months $13,699.87 + stub $163.78 → indebtedness $262,952.26; bid $270,000.00 → 311 $262,952.26 by Oct 13, 2027, recovery $7,047.74 FIFO over advances $11,219.94 (taxes $4,820.00, hazard $1,450.00, MI 11 × $124.54 = $1,369.94, inspections 9 × $30 = $270.00, preservation $445.00, attorney $2,300.00, costs $565.00) → 571 claim $4,172.20; spread interest $577.66 written off; $280,000 bid → surplus $5,827.80", () => {
  // Rule 8 components (fixture L15, TPS variant).
  assert.equal(monthlyPtrInterest(L15.upb_cents, L15.ptr_pct), 124544n);                       // 249,088.61 × 0.06 ÷ 12 = $1,245.44
  assert.equal(dailyPtrAccrual(L15.upb_cents, L15.ptr_pct), "$40.946");                        // 249,088.61 × 0.06 ÷ 365 = $40.946 (printed to three decimals, as the spec does)
  const int = ptrInterest(L15.upb_cents, L15.ptr_pct, L15.lpi_due, L15.sale_on);
  assert.deepEqual([int.months_full, int.stub_days], [11, 4]);                                   // Nov 1, 2026 → Oct 1, 2027 = 11 full months; Oct 1–5 = 4 stub days
  const comp = ptrInterestComponents(L15.upb_cents, L15.ptr_pct, L15.lpi_due, L15.sale_on);
  assert.equal(comp.months_cents, 1369987n);                                                     // 11 × 1,245.443 = $13,699.87 (multiplied before rounding)
  assert.equal(comp.stub_cents, 16378n);                                                         // stub 4 × 40.946 = $163.78 (computed on its own from the daily accrual)
  assert.equal(comp.total_cents, 1386365n); assert.equal(int.cents, comp.total_cents);           // the two-component sum agrees with reogram.ts's single-pass accrual
  assert.equal(L15.upb_cents + int.cents, 26295226n);                                            // fnma_total_indebtedness $262,952.26

  // Servicer's unrecovered items (E-3.3-05 total-debt order).
  const adv = unrecoveredAdvances(ADVANCES);
  assert.deepEqual(adv.lines.map((l) => l.cents), [482000n, 145000n, 136994n, 27000n, 44500n, 230000n, 56500n]);   // $4,820.00, $1,450.00, $1,369.94, $270.00, $445.00, $2,300.00, $565.00
  assert.equal(adv.total_cents, 1121994n);                                                                             // $11,219.94
  const spread = spreadInterest(L15.upb_cents, L15.note_rate_pct, L15.ptr_pct, L15.lpi_due, L15.sale_on);
  assert.equal(spread, 57766n);                                                                                        // note-rate 6.25% accrual $14,441.31 − PTR accrual $13,863.65 = $577.66

  // $270,000.00 bid paid in full Tue Oct 5, 2027.
  const tps = thirdPartySale({ ...TPS_INPUT, gross_proceeds_cents: 27000000n, unrecovered_advances_cents: adv.total_cents });
  assert.equal(tps.fnma_total_indebtedness_cents, 26295226n); assert.equal(tps.amount_due_fnma_cents, 26295226n);     // < $270,000 → 311 = $262,952.26
  assert.equal(tps.crs_code, "311"); assert.equal(tps.settle_by, D("2027-10-13")); assert.equal(tps.instruct_by, D("2027-10-12"));   // Oct 6, 7, 8, 12, 13 (Oct 11 Columbus Day)
  assert.equal(tps.servicer_recovery_cents, 704774n); assert.equal(tps.surplus_cents, 0n);                            // 270,000.00 − 262,952.26 = $7,047.74; surplus $0
  const wf = recoveryWaterfall({ gross_proceeds_cents: 27000000n, amount_due_fnma_cents: tps.amount_due_fnma_cents, advances: ADVANCES, spread_interest_cents: spread });
  assert.equal(wf.servicer_recovery_cents, 704774n);
  assert.deepEqual(wf.applied.map((a) => [a.kind, a.applied_cents]), [["taxes", 482000n], ["hazard", 145000n], ["mi_premium", 77774n], ["inspection", 0n], ["preservation", 0n], ["attorney_fee", 0n], ["costs", 0n]]);   // FIFO to reimbursable advances first
  assert.equal(wf.claim_571_advances_cents, 417220n); assert.equal(tps.claim_571_advances_cents, 417220n);           // remaining advances $4,172.20 → 571 claim (15.2)
  assert.equal(wf.spread_interest_written_off_cents, 57766n); assert.equal(wf.surplus_cents, 0n);                   // spread interest written off (not reimbursable)
  const crs = crsBatchLines({ amount_due_fnma_cents: tps.amount_due_fnma_cents });
  assert.deepEqual(crs.lines, [{ code: "311", cents: 26295226n }]); assert.equal(crs.refusal, null);
  assert.match(crsBatchLines({ amount_due_fnma_cents: tps.amount_due_fnma_cents, remit_cents: 27000000n }).refusal!, /REMIT_EXCEEDS_AMOUNT_DUE/);   // never remit more than amount_due_fnma
  const stmt = closingStatement({ tps, upb_cents: L15.upb_cents, servicing_fees_cents: 0n, advances_cents: adv.total_cents, other_cents: 0n, remitted_on: tps.settle_by });   // remitted on the calculator's settlement date
  assert.deepEqual([stmt.recipient, stmt.send_by, stmt.on_time, stmt.breakdown.principal_cents, stmt.breakdown.interest_cents, stmt.breakdown.amount_due_fnma_cents], ["sf_cpm", D("2027-10-13"), true, 24908861n, 1386365n, 26295226n]);   // closing statement to SF CPM on the remittance date

  // $280,000 bid: 311 unchanged, recovery = all advances, surplus per state law (never to Fannie Mae), 571 for advances $0.
  const big = thirdPartySale({ ...TPS_INPUT, gross_proceeds_cents: 28000000n, unrecovered_advances_cents: adv.total_cents });
  assert.deepEqual([big.amount_due_fnma_cents, big.servicer_recovery_cents, big.surplus_cents, big.claim_571_advances_cents], [26295226n, 1121994n, 582780n, 0n]);
  const bigWf = recoveryWaterfall({ gross_proceeds_cents: 28000000n, amount_due_fnma_cents: big.amount_due_fnma_cents, advances: ADVANCES, spread_interest_cents: spread });
  assert.deepEqual([bigWf.servicer_recovery_cents, bigWf.surplus_cents, bigWf.claim_571_advances_cents, bigWf.spread_interest_written_off_cents], [1121994n, 582780n, 0n, 57766n]);
  assert.equal(surplusDisposition({ surplus_cents: big.surplus_cents, jurisdiction_rules: { state: "TX" }, junior_liens_present: true }).remitted_to_fnma_cents, 0n);
});
